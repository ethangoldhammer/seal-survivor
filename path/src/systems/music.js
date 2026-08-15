import { CONFIG } from '../config.js';
import { musicScale } from './settings.js';
import { bounds, depthFraction } from '../arena.js';
import { getAudioContext, makeImpulse } from './audio.js';

// A loop player that changes tracks ON THE BEAT rather than the instant
// something happens in game. When you level up, the next loop is QUEUED — it
// starts when the loop that's playing has played all the way through, so a
// phrase is never cut off half-finished. Meanwhile a low-pass sweeps the mix
// down (the "you're in a menu" muffle), and sweeps back open when the run
// resumes.
//
// The boundary a switch waits for is the END OF THE PLAYING FILE, not a beat
// count. The BPM grid stays — it's what the animation system marches to — but
// it is no longer what decides when a track changes: the two only agree if
// every file is exactly `beatsPerLoop` long, and a file that's a fraction of a
// second off (mp3s usually are) drifts a little further into the next loop on
// every switch until the change lands in the middle of a bar.

let ctx = null;
let musicGain = null;
let filter = null;
let source = null;
// Parallel band-pass path, used only by the suffocation effect. See
// setBandpass() at the bottom of this file.
let bandpass = null;
let bandDry = null;
let bandWet = null;
// The hush's reverb send. See hushMusic() at the bottom of this file.
let tailSend = null;
let tailVerb = null;
let tailOut = null;
let tailSignature = '';
let hushed = false;

const tracks = new Map(); // name -> AudioBuffer
// name -> { leadIn, loopEnd, bars }, measured once at decode. See measureTrack.
const trackMeta = new Map();
let currentTrack = null;
let queuedTrack = null;
// Which grid the queued switch waits for: 'loop' (the end of the playing file,
// the level-up default) or 'bar' (the next bar line, which is what a boss
// arrival uses — see startBossMusic).
let queuedQuantum = 'loop';
let started = false;
let pollTimer = null;
let defaultsRequested = false;
let pendingLevel = null; // level asked for via play() before any track was ready yet

// --- transport -------------------------------------------------------------
// Everything quantised runs on SCORE time — seconds of the track's own
// timeline — rather than on the wall clock, because the two stop being the
// same thing the moment the game dilates time. A loop played at 0.3x takes
// three and a bit times as long in the room and is still ONE loop, so a
// boundary worked out in wall seconds lands a third of the way into the next
// one.
//
// `transportPos` is that score clock: advanced whenever anyone asks, by the
// wall seconds since the last look times the rate we're actually hearing. The
// beat grid and the loop boundary are both measured against it, and the only
// place the answer turns back into wall time is the moment a switch is
// scheduled — a conversion redone on every poll rather than once, far ahead,
// because while the tape is still slowing down the boundary keeps moving.
let transportPos = 0; // score seconds since play()
let loopAnchor = 0; // transportPos at which the playing file last started over
let lastTick = 0; // ctx time transportPos has been advanced to

// A transport-wide multiplier ON TOP of CONFIG.music.playbackRate, owned by
// the death dive: the tape drags to a halt as time dilates. Separate from the
// configured rate rather than written into it, so the tuner's value is still
// the value and a run that ends mid-drag doesn't leave the slider lying.
let rateScale = 1;
// The rate MODEL, mirroring what the AudioParam is doing: `rateNow` eases
// toward `rateTarget` with time constant `rateTau`, which is exactly the curve
// setTargetAtTime runs on the audio thread. Modelled rather than read back off
// the param so the score clock integrates the rate the loop is really playing
// at halfway through a drag — reading `.value` would work in a browser, but
// this also keeps the whole transport testable without one.
let rateNow = 1;
let rateTarget = 1;
let rateTau = 0;

function targetRate() {
  return Math.max(0.05, (CONFIG.music.playbackRate ?? 1) * rateScale);
}

// Push the rate at the source node and keep the model in step. `glide` of 0 is
// the instant reset startGame wants; anything above it ramps, because
// playbackRate is an AudioParam and stepping it every frame zippers audibly on
// a sustained loop.
function writeRate(glide) {
  advance();
  rateTarget = targetRate();
  if (!source || !ctx) {
    rateNow = rateTarget;
    rateTau = 0;
    return;
  }
  if (glide > 0) {
    source.playbackRate.setTargetAtTime(rateTarget, ctx.currentTime, glide);
    rateTau = glide;
  } else {
    source.playbackRate.cancelScheduledValues(ctx.currentTime);
    source.playbackRate.setValueAtTime(rateTarget, ctx.currentTime);
    rateNow = rateTarget;
    rateTau = 0;
  }
}

// Carry the score clock up to now. Integrates with the average of the rate
// before and after the ease so a long gap between calls (a backgrounded tab,
// where the audio kept playing but nothing asked) doesn't bias the position.
function advance() {
  if (!ctx) return;
  const now = ctx.currentTime;
  const dt = Math.max(0, now - lastTick);
  lastTick = now;
  if (dt === 0) return;
  const before = rateNow;
  if (rateTau > 0) {
    rateNow += (rateTarget - rateNow) * (1 - Math.exp(-dt / rateTau));
    if (Math.abs(rateTarget - rateNow) < 1e-4) { rateNow = rateTarget; rateTau = 0; }
  } else {
    rateNow = rateTarget;
  }
  if (started) transportPos += dt * (before + rateNow) * 0.5;
}

export function setMusicRateScale(scale, glide = 0.2) {
  rateScale = Math.max(0.05, Math.min(4, scale || 1));
  writeRate(glide);
}

// The tempo you actually HEAR. `playbackRate` is applied to the source node
// (see startSource), so a rate of 1.5 makes a 120bpm loop play at 180 — and
// anything trying to move in time with the music has to follow that, not the
// configured number. Mid-drag it follows the ramp rather than its destination,
// so a creature marching to the beat decelerates with the track instead of
// snapping to the rate the tape is still on its way to. Exported so the
// animation system can march creatures to the beat; see
// CONFIG.enemies.<key>.beatSync.
export function currentBpm() {
  advance();
  return Math.max(1, CONFIG.music.bpm) * (started ? rateNow : targetRate());
}

// Seconds per beat at the audible tempo.
export function beatDuration() {
  return 60 / currentBpm();
}

// One loop of the BPM grid, in score seconds. This is the tuner's number and
// the beat grid's — see loopSeconds() for the length a track switch waits on.
export function loopDuration() {
  const beats = Math.max(1, CONFIG.music.beatsPerLoop);
  return (60 / Math.max(1, CONFIG.music.bpm)) * beats;
}

// --- the bar grid ----------------------------------------------------------
// One bar of the MUSIC, in score seconds, and note that it is measured off the
// files rather than derived from CONFIG.music.bpm. Every file in the library —
// all sixteen run loops and all seven boss loops — is a whole number of 2.265s
// bars, which is 105.96bpm; `bpm` is the ANIMATION grid, is tuned by ear, and
// is currently a fraction under that. The gap is nothing to a creature marching
// to the beat and everything to a track switch, which either lands on the
// downbeat or does not. See CONFIG.music.barSeconds.
function barSeconds() {
  return Math.max(0.05, CONFIG.music.barSeconds ?? 2.265);
}

// Where a decoded file's music actually STARTS.
//
// An mp3 decodes with silence on the front — 20 to 36ms across this library,
// the encoder's own delay — so the first SAMPLE of the buffer is not the
// downbeat. Left in, it costs twice: the loop inserts that much dead air on
// every pass, and a file started at a bar line lands its music a flam late.
// Skipping it is what makes a bar-quantised switch actually land on the bar.
//
// ONLY THE FRONT IS TRIMMED, and that is deliberate. The obvious symmetry —
// find the last audible sample and loop to there — is wrong, because a bar can
// legitimately END in near-silence: a decayed tail, a held note that has fallen
// under the floor, a written rest. Cutting there would shorten the phrase by
// however much of it happened to be quiet, which is a musical edit rather than
// a repair. The back of the file is left exactly as authored.
//
// `bars` is measurement, not correction — it is what the loop SHOULD be, and
// the two disagreeing is a fact about the file that no loop point can fix. A
// file that is short of its bar count cannot be extended: the samples do not
// exist. The rotation still switches on the file's own length, so a short file
// costs one early transition rather than a stutter, and the discrepancy is
// reported by `trackReport()` for whoever has to re-export it.
const SILENCE = 0.0015; // -56 dBFS, below the noise floor of every file here

function measureTrack(name, buffer) {
  const bar = barSeconds();
  const fallback = { leadIn: 0, loopEnd: buffer?.duration ?? 0, bars: 0, drift: 0 };
  if (!(buffer?.duration > 0.05)) { trackMeta.set(name, fallback); return; }

  const rate = buffer.sampleRate;
  const n = buffer.length;
  // A buffer with no readable samples cannot be measured, and that is a real
  // case rather than defensiveness: decodeAudioData is the only thing that
  // produces one of these, and a mocked context is free to hand back a duration
  // and nothing else. Played at its own length, as it was before any of this.
  const chans = [];
  for (let c = 0; c < (buffer.numberOfChannels ?? 0); c++) {
    const d = buffer.getChannelData?.(c);
    if (d?.length) chans.push(d);
  }
  if (chans.length === 0 || !(n > 0)) { trackMeta.set(name, fallback); return; }

  // Only the head is scanned — the padding is tens of milliseconds, and a full
  // sweep of twenty-three files at 48kHz is millions of samples for an answer
  // that lives in the first half-second.
  const window = Math.min(n, Math.floor(rate * 0.5));
  let first = -1;
  for (let i = 0; i < window; i++) {
    let p = 0;
    for (const d of chans) { const v = Math.abs(d[i]); if (v > p) p = v; }
    if (p > SILENCE) { first = i; break; }
  }
  // No audio in the first half-second: either the file opens on a long rest or
  // it is silent. Neither is something to trim.
  if (first < 0) { trackMeta.set(name, fallback); return; }

  const leadIn = first / rate;
  const musical = buffer.duration - leadIn;
  const bars = Math.round(musical / bar);
  trackMeta.set(name, {
    leadIn,
    loopEnd: buffer.duration,
    bars: bars >= 1 ? bars : 0,
    drift: bars >= 1 ? musical - bars * bar : 0,
  });
}

/**
 * Every loaded track against the bar grid: how long it is, how many bars that
 * makes it, and how far off the nearest whole bar it lands.
 *
 * A file more than a frame or two out is an EXPORT problem, not a playback one
 * — see measureTrack — and this is the only place it is visible. Read by
 * tools/music-loop-test.mjs, and worth a look after any new loop is dropped in.
 */
export function trackReport() {
  const bar = barSeconds();
  const out = [];
  for (const [name, buffer] of tracks) {
    const m = metaFor(name);
    out.push({
      name,
      duration: buffer.duration,
      leadIn: m?.leadIn ?? 0,
      bars: m?.bars ?? 0,
      drift: m?.drift ?? 0,
      bar,
    });
  }
  return out;
}

function metaFor(name) {
  const buffer = tracks.get(name);
  if (!buffer) return null;
  if (!trackMeta.has(name)) measureTrack(name, buffer);
  return trackMeta.get(name);
}

// How long one full pass of the loop that's PLAYING takes, in score seconds.
// The file's own length is the truth here: "the loop has finished" means the
// thing the player can hear has come back round, and that's where the buffer
// wraps, whatever the BPM says. The MUSICAL length where one could be measured
// (see measureTrack), so this agrees with the loop points the source node was
// actually given. Falls back to the grid before anything has loaded.
function loopSeconds() {
  const m = metaFor(currentTrack);
  if (m && m.loopEnd > m.leadIn) return Math.max(0.05, m.loopEnd - m.leadIn);
  const buffer = tracks.get(currentTrack);
  if (buffer && buffer.duration > 0.05) return buffer.duration;
  return loopDuration();
}

// Where we are on the beat grid right now, in fractional beats since playback
// started. The whole part is which beat; the FRACTION is what anything moving
// in time with the music actually wants — it says where in the bar a cycle
// should currently be, so a loop can be started mid-way and still land its
// next peak on a beat.
//
// Score time, so dilation stretches a beat rather than jumping the phase: with
// wall elapsed divided by the CURRENT beat length, every rate change
// retroactively rewrote how many beats had already gone by, and every creature
// marching to the music twitched on the frame the death dive began.
//
// 0 while nothing is playing, which puts anything asking at the top of the
// bar — the seal idling on the start menu before the audio context has been
// unlocked animates from a clean phase rather than a random one.
export function beatPhase() {
  if (!started || !ctx) return 0;
  advance();
  return transportPos / (60 / Math.max(1, CONFIG.music.bpm));
}

function ensureChain() {
  if (!ctx) ctx = getAudioContext();
  if (!ctx) return false;
  if (!musicGain) {
    musicGain = ctx.createGain();
    filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    // Starts wide open; updateDepth takes it from here once a run begins.
    filter.frequency.value = CONFIG.music.surfaceHz;
    filter.Q.value = CONFIG.music.resonance;
    // The player's scale folded in from the FIRST sample, not just from the
    // next applyMusicSettings — the chain is built when music starts, which is
    // after loadSettings(), so a muted player would otherwise hear the opening
    // bar at full authored volume before anything re-stamped this.
    musicGain.gain.value = CONFIG.music.volume * musicScale();

    // source -> filter (depth lowpass) -> [ dry ------------> ] -> musicGain
    //                                     [ bandpass -> wet -> ]
    //
    // The band-pass hangs off the depth filter in PARALLEL, crossfaded by
    // setBandpass rather than switched in. A single node retyped to
    // 'bandpass' would have meant fighting updateDepth over one frequency
    // AudioParam, and there'd be no way to sit halfway between the two
    // sounds — which is the entire ask, since the effect has to ease in and
    // back out rather than snap.
    bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = CONFIG.oxygen?.fx?.musicCenterHz ?? 900;
    bandpass.Q.value = 0.7;
    bandDry = ctx.createGain();
    bandWet = ctx.createGain();
    bandDry.gain.value = 1;
    bandWet.gain.value = 0; // fully bypassed until oxygen gets low

    filter.connect(bandDry).connect(musicGain);
    filter.connect(bandpass).connect(bandWet).connect(musicGain);
    musicGain.connect(ctx.destination);

    // THE TAIL, and note where it is plugged in: it taps the depth filter and
    // goes STRAIGHT TO THE SPEAKERS, around musicGain rather than through it.
    // That is the whole trick of the hush — musicGain is the thing being
    // muted, so a send routed through it would be silenced by the very cut it
    // exists to survive.
    //
    // Silent until a boss dies. The convolver only ever outputs what it has
    // been fed, so a send sitting at zero costs one multiply per sample and
    // rings out nothing.
    tailSend = ctx.createGain();
    tailSend.gain.value = 0;
    tailVerb = ctx.createConvolver();
    tailOut = ctx.createGain();
    tailOut.gain.value = 0;
    filter.connect(tailSend).connect(tailVerb).connect(tailOut);
    tailOut.connect(ctx.destination);
  }
  return true;
}

// The level the music should be at when nothing is ducking it: the authored
// volume times the player's own (Audio tab), with mute folded into the scale.
function baseMusicGain() {
  return CONFIG.music.enabled ? CONFIG.music.volume * musicScale() : 0;
}

export async function loadTrackFromFile(name, file) {
  if (!ensureChain()) return false;
  try {
    tracks.set(name, await ctx.decodeAudioData(await file.arrayBuffer()));
    // The measurement belongs to the buffer, not to the slot — a re-upload into
    // an occupied slot would otherwise keep the old file's downbeat and bar
    // count and loop the new one at the wrong length.
    trackMeta.delete(name);
    notifyTracksChanged();
    return true;
  } catch (err) {
    console.warn(`[music] could not decode "${file.name}" —`, err?.message ?? err);
    return false;
  }
}

// The Sound tab's rows are built once, well before defaults finish fetching,
// so it can't just read hasTrack() at build time — it subscribes here and
// re-checks itself whenever a slot's contents might have changed.
const trackListeners = new Set();
export function onTracksChanged(cb) {
  trackListeners.add(cb);
  return () => trackListeners.delete(cb);
}
function notifyTracksChanged() {
  for (const cb of trackListeners) cb();
}

export function hasTrack(name) {
  return tracks.has(name);
}

export function clearTrack(name) {
  tracks.delete(name);
  trackMeta.delete(name);
  notifyTracksChanged();
}

// Fetches CONFIG.music.defaultSrc into their slots (1-indexed) so the game
// has music without anyone having to upload anything — same
// load-with-fallback pattern as CONFIG.sfx's `src`. A slot whose file 404s
// or fails to decode is just left empty and skipped, same as an unfilled
// upload slot. Safe to call repeatedly; only does the fetching once.
export async function preloadDefaultTracks() {
  if (defaultsRequested || !ensureChain()) return;
  defaultsRequested = true;
  const sources = CONFIG.music.defaultSrc ?? [];
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    const name = String(i + 1);
    if (!src || tracks.has(name)) continue;
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      tracks.set(name, await ctx.decodeAudioData(await res.arrayBuffer()));
    } catch (err) {
      console.warn(`[music] could not load default loop "${src}" —`, err?.message ?? err);
      continue;
    }
    notifyTracksChanged();
    // play() may have already been called and found nothing loaded yet —
    // pick it up now instead of staying silent for the rest of the run.
    if (pendingLevel != null) play(pendingLevel);
  }

  // The boss bank, after the run's own loops rather than alongside them: the
  // first ordinary loop has to be decoded before the player can hear anything,
  // and the boss music is not needed until a fight — which is minutes away at
  // the very earliest, since the first boss is gated on a level threshold.
  const bossSources = CONFIG.music.bossSrc ?? [];
  for (let i = 0; i < bossSources.length; i++) {
    const src = bossSources[i];
    const name = BOSS_PREFIX + i;
    if (!src || tracks.has(name)) continue;
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      tracks.set(name, await ctx.decodeAudioData(await res.arrayBuffer()));
    } catch (err) {
      console.warn(`[music] could not load boss loop "${src}" —`, err?.message ?? err);
      continue;
    }
    notifyTracksChanged();
  }
}

function startSource(name, when) {
  const buffer = tracks.get(name);
  if (!buffer) return;
  advance();
  // The outgoing loop plays right up to the boundary instead of being cut on
  // the frame the switch was scheduled. The poll runs up to 120ms ahead of the
  // boundary so the start is sample-accurate; stopping the old one there and
  // then punched a hole in the last moment of the very phrase it had waited a
  // whole loop to finish.
  stopSource(when);
  source = ctx.createBufferSource();
  source.buffer = buffer;
  // The whole file loops, however long it is. It used to be clipped to
  // `beatsPerLoop` when it ran longer, which is what turned the one loop
  // written as twelve bars into eight bars and a cut.
  source.loop = true;
  // ...from the downbeat rather than from sample zero, so the encoder's silence
  // is skipped on every pass instead of being played as a gap at the loop
  // point. The back of the file is left alone — see measureTrack.
  const meta = metaFor(name);
  if (meta && meta.leadIn > 0) {
    source.loopStart = meta.leadIn;
    source.loopEnd = meta.loopEnd;
  }
  // Picks up the ramp in flight rather than snapping to the rate it's heading
  // for: a track can change hands mid-dilation now that the music plays on
  // through the death dive.
  rateTarget = targetRate();
  source.playbackRate.value = rateNow;
  if (rateTau > 0) source.playbackRate.setTargetAtTime(rateTarget, ctx.currentTime, rateTau);
  source.connect(filter);
  // Started AT the downbeat, not at sample zero — otherwise a switch quantised
  // to a bar line still puts the music a padding's width late, which across
  // this library is up to 36ms and audible as a flam against everything else
  // landing on that beat.
  source.start(when, meta?.leadIn ?? 0);
  currentTrack = name;
  // `when` is normally a hair in the future — where the score clock will be by
  // the time the first sample of the new file is actually heard.
  loopAnchor = transportPos + Math.max(0, when - ctx.currentTime) * rateNow;
}

// `at` is a ctx time to stop AT — used by a switch, so the old loop runs out
// its last samples under the new one's first. Omitted, it stops now, which is
// what the Stop button and a fresh run want.
function stopSource(at = null) {
  if (!source) return;
  const when = at != null && at > ctx.currentTime ? at : 0;
  try { if (when > 0) source.stop(when); else source.stop(); } catch { /* already stopped */ }
  // Disconnected on its own ended event rather than here: pulling the node out
  // of the graph now would silence the very tail we just scheduled it to play.
  const node = source;
  if (when > 0) node.onended = () => node.disconnect();
  else node.disconnect();
  source = null;
}

// ctx time at which the playing file next comes back round — this is what
// makes a switch land musically instead of wherever the player happened to
// level up.
//
// The remainder is worked out in score seconds and converted to wall seconds
// at the rate being heard RIGHT NOW, so a loop that's dragging returns a
// proportionally later boundary. Under a ramp that answer keeps moving, which
// is why pollQueue asks again every 40ms instead of trusting one far-ahead
// prediction.
export function nextBoundary(now = ctx?.currentTime ?? 0) {
  advance();
  const period = loopSeconds();
  if (!started || period <= 0) return now;
  const into = (transportPos - loopAnchor) % period;
  return now + (period - into) / Math.max(0.05, rateNow);
}

// Start playback at the loop appropriate for `level`. With nothing uploaded
// this is a no-op — the player stays silent rather than erroring.
//
// Starting a run calls this with level 1, which lands on the FIRST filled
// slot: every run opens on the same loop rather than picking up wherever the
// last one happened to end.
export function play(level = 1) {
  if (!CONFIG.music.enabled || !ensureChain()) return;
  currentLevel = level;
  const slot = slotForLevel(level);
  if (!slot) { pendingLevel = level; return; }
  pendingLevel = null;
  // Drop anything the previous run left queued, or it would cut in at the
  // next boundary and override the loop we just started on.
  queuedTrack = null;
  queuedQuantum = 'loop';
  // ...and any fight the last run was in the middle of. A run that ended
  // DURING a boss — the common way to end one — leaves the rotation up, and
  // without this the new run would open on the run's first loop and then be
  // taken back over by the dead fight's next boss loop one bar later.
  resetBossMusic();
  depthHeld = false;
  resumeUntil = 0;
  // A run started while the last one's boss-kill hush was still up would open
  // MUTED — the cut is an automation ramp on the music gain, and starting a
  // fresh source underneath it changes nothing about the gain it plays into.
  // Cleared with no fade: this is frame one of a run, not the end of a beat.
  releaseMusicHush(0);
  const when = ctx.currentTime + 0.02;
  rateNow = rateTarget = targetRate();
  rateTau = 0;
  startSource(slot, when);
  // Beat 0 is where the first loop starts, not where play() was called — and
  // the score clock is parked until then, since `advance` floors its dt at
  // zero. Set after startSource, which does its own anchoring for the mid-run
  // case.
  transportPos = 0;
  loopAnchor = 0;
  lastTick = when;
  started = true;
  // Open at the surface value; the first updateDepth call glides it to
  // wherever the player actually is.
  filter.frequency.cancelScheduledValues(ctx.currentTime);
  filter.frequency.setValueAtTime(Math.max(60, CONFIG.music.surfaceHz), ctx.currentTime);
  if (!pollTimer) pollTimer = window.setInterval(pollQueue, 40);
}

export function stop() {
  stopSource();
  // Not left set behind a stopped transport: the next play() would find the
  // gain still ramped to zero and the send still primed.
  releaseMusicHush(0);
  started = false;
  queuedTrack = null;
  queuedQuantum = 'loop';
  resetBossMusic();
  pendingLevel = null;
  if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
}

// ctx time of the next BAR LINE of the playing file — the same arithmetic as
// nextBoundary against a shorter grid.
//
// Measured from `loopAnchor` rather than from the transport's origin, and that
// is what makes it a real bar line instead of an arbitrary 2.265s tick: the
// anchor is where the playing file's own downbeat is, and every file in the
// library is a whole number of bars long (see measureTrack), so counting bars
// from the anchor stays in phase with the music across any number of wraps.
//
// At most one bar away, which is the whole point of the boss switch: a fight
// cannot wait the up-to-18s a loop boundary can be.
export function nextBar(now = ctx?.currentTime ?? 0) {
  advance();
  const bar = barSeconds();
  if (!started || bar <= 0) return now;
  const into = ((transportPos - loopAnchor) % bar + bar) % bar;
  return now + (bar - into) / Math.max(0.05, rateNow);
}

/**
 * Queue a track to begin at the next boundary. Passing the track that's already
 * playing is a no-op, so repeated level-ups don't restart the loop.
 *
 * @param quantum 'loop' waits for the playing file to finish, so a phrase is
 *                never cut — the level-up default. 'bar' waits only for the
 *                next bar line: still seamless to a listener, but it arrives
 *                inside a couple of seconds instead of up to eighteen.
 */
export function queueTrack(name, quantum = 'loop') {
  if (!started || !tracks.has(name) || name === currentTrack) return;
  queuedTrack = name;
  queuedQuantum = quantum === 'bar' ? 'bar' : 'loop';
}

function pollQueue() {
  if (!ctx || !started) return;
  // Carry the score clock forward even with nothing queued: it's what the beat
  // grid reads, and 40ms steps keep the integration honest through a rate ramp
  // whether or not anything is asking for the phase this frame.
  advance();
  if (!queuedTrack) return;
  const now = ctx.currentTime;
  const boundary = queuedQuantum === 'bar' ? nextBar(now) : nextBoundary(now);
  // Schedule slightly ahead of the boundary so the switch is sample-accurate
  // rather than depending on when this poll happens to fire.
  if (boundary - now <= 0.12) {
    const name = queuedTrack;
    queuedTrack = null;
    startSource(name, boundary);
    // A boss fight chains: the loop that just started queues its own successor
    // for the END of itself, so the rotation carries on with no clock outside
    // the music driving it. See startBossMusic.
    if (bossActive) queueNextBossLoop();
  }
}

// --- filter, driven by depth ---------------------------------------------
// The cutoff follows the player's Y: wide open at or above the surface,
// rolling off toward `deepHz` at the seabed. Water muffling you can hear
// yourself cause by diving reads as part of the world, where the old
// level-driven version was a step you only noticed on level-up.
//
// The upgrade screen ducks BELOW wherever depth currently has it, then hands
// control back — so the duck is relative to where you're swimming, not a
// fixed pair of values.
export function cutoffForDepth(y) {
  const m = CONFIG.music;
  // Above the surface is "fully open" — no extra brightness for jumping
  // higher, since there's no more water to get out of. depthFraction handles
  // that clamp, and the SFX bus rides the same curve with its own range.
  const t = depthFraction(y);
  // Interpolate in log space — filter cutoff is perceived logarithmically,
  // so a linear ramp would spend most of its travel in a range you can
  // barely hear changing.
  return m.surfaceHz * Math.pow(m.deepHz / m.surfaceHz, t);
}

let currentLevel = 1;
// While the upgrade screen has the filter ducked, depth updates stand down
// so the two aren't fighting over the same AudioParam.
let depthHeld = false;
// ctx time until which depth tracking glides at `sweepTime` rather than the
// quicker `depthSmoothing` — the climb back out of an upgrade-screen duck.
let resumeUntil = 0;

function rampTo(hz, seconds) {
  if (!ensureChain()) return;
  const now = ctx.currentTime;
  filter.frequency.cancelScheduledValues(now);
  filter.frequency.setValueAtTime(Math.max(60, filter.frequency.value), now);
  filter.frequency.exponentialRampToValueAtTime(Math.max(60, hz), now + Math.max(0.01, seconds));
}

// Called every frame with the player's Y, and is the ONLY thing writing the
// cutoff during gameplay — duck/sweep hand control here rather than leaving
// a scheduled ramp for this to truncate a frame later.
//
// setTargetAtTime is exponential-approach, so re-issuing it every frame
// glides smoothly; setValueAtTime would step audibly and a fresh ramp per
// frame would cancel the previous one mid-flight.
export function updateDepth(y) {
  if (!CONFIG.music.enabled || !started || depthHeld || !ensureChain()) return;
  const now = ctx.currentTime;
  // Just came back from the upgrade screen: take `sweepTime` to climb out of
  // the duck, then settle into the quicker depth-tracking constant. A time
  // constant reaches ~95% in 3τ, hence the /3.
  const tau = now < resumeUntil
    ? Math.max(0.01, CONFIG.music.sweepTime / 3)
    : Math.max(0.01, CONFIG.music.depthSmoothing);
  filter.frequency.setTargetAtTime(Math.max(60, cutoffForDepth(y)), now, tau);
}

// Called on level-up. Advances the loop (quantized) if this level crosses
// into the next slot. The filter is depth-driven now, so level-up no longer
// touches it.
export function setLevel(level) {
  currentLevel = level;
  if (!CONFIG.music.enabled || !started) return;
  // NOT DURING A BOSS FIGHT. Levelling up mid-fight is common — it is the
  // fight's own drops that do it — and without this the run's next ordinary
  // loop would be queued underneath the boss music and cut in at the following
  // boundary, ending the fight's score while the boss was still alive. The
  // level is still recorded above, and endBossMusic reads it on the way out, so
  // the loop that comes back after the kill is the one this level asked for.
  if (bossActive) return;
  const slot = slotForLevel(level);
  if (slot != null && slot !== currentTrack) queueTrack(slot);
}

// ---------------------------------------------------------------------------
// THE BOSS ROTATION
// ---------------------------------------------------------------------------
// A second bank of loops that takes over the transport for the length of a
// fight. THE SAME transport — the same source node, the same filter, the same
// gain — rather than a second player running alongside, and that is the whole
// design:
//
//   - the kill's reverb tail (see hushMusic) taps the depth filter, so what
//     rings out over the held close-up is made of BOSS music. A parallel player
//     would have to grow its own send, and the tail would be built from a loop
//     the fight had nothing to do with.
//   - the death dive's tape drag, the upgrade screen's duck, the depth
//     low-pass and the suffocation band-pass all act on that chain and go on
//     working through a fight without knowing a fight is happening.
//
// The bank lives under its own names ('boss0'…) rather than in the numbered
// upload slots, so slotForLevel — which scans '1'..CONFIG.music.slots — can
// never draw one for an ordinary level.

const BOSS_PREFIX = 'boss';

// How many fights are running. A refcount rather than a flag because two bosses
// in the water at once is reachable (the debug spawner, and a level gap of 8 is
// a handful of seconds to a build that is eating well) — the music has to stay
// up until the LAST one dies, and the first kill must not drag the run's
// ordinary loop back underneath a boss that is still swimming.
let bossFights = 0;
let bossActive = false;
// Index into the rotation, and it belongs to the RUN rather than to the fight:
// it survives a kill and is only cleared by resetBossMusic. -1 means no boss
// has arrived yet this run, which is the one and only state that plays the
// intro. See startBossMusic for why the rotation is continuous across fights.
let bossCursor = -1;

// Which boss loops actually loaded, in file order. Empty slots are skipped the
// same way slotForLevel skips them, so a 404 on one file costs that loop rather
// than the fight's music.
function bossBank() {
  const out = [];
  const n = (CONFIG.music.bossSrc ?? []).length;
  for (let i = 0; i < n; i++) {
    const name = BOSS_PREFIX + i;
    if (tracks.has(name)) out.push(name);
  }
  return out;
}

/** Is the score currently on the boss bank? For the tuner readout and tests. */
export function bossMusicActive() {
  return bossActive;
}

// The next loop in the rotation, queued to start when the playing one finishes.
//
// The FIRST loop of the bank is an intro: four bars where the rest are five to
// eight, played once and then never returned to. The cycle wraps to the second
// entry instead, so a long fight repeats the body of the music without
// re-announcing itself every ninety seconds.
//
// Note the cursor ends up pointing at the loop that is QUEUED, not the one
// sounding — this runs immediately after a switch. That is what the next fight
// resumes from; see startBossMusic.
function queueNextBossLoop() {
  const bank = bossBank();
  if (bank.length === 0) return;
  const hasIntro = bank.length > 1 && CONFIG.music.bossIntro !== false;
  bossCursor += 1;
  if (hasIntro) {
    // 0 is the intro and is only ever reached by the entry below; from here the
    // cursor walks 1..n-1 and wraps back to 1.
    if (bossCursor >= bank.length) bossCursor = 1;
    if (bossCursor < 1) bossCursor = 1;
  } else if (bossCursor >= bank.length) {
    bossCursor = 0;
  }
  // A bank of one is the fight's whole score: queueTrack refuses a name that is
  // already playing, so it simply keeps looping, which is correct.
  queueTrack(bank[bossCursor], 'loop');
}

/**
 * A boss has arrived. Take the transport, on the next bar line.
 *
 * Called from systems/boss.js on the frame the arrival ceremony lands — the
 * same frame the health bar fills and the riser resolves.
 *
 * QUANTISED TO THE BAR, not to the frame and not to the end of the playing
 * loop. The frame is where the boss is; the bar is where the MUSIC is, and the
 * two are up to 2.265s apart. Switching on the frame would cut the run's loop
 * mid-phrase and put the boss music's downbeat wherever the player happened to
 * hit the level threshold; waiting for the loop boundary is musical but can be
 * eighteen seconds, which is a third of a fight. One bar is the only boundary
 * that is both seamless and inside the ceremony.
 *
 * ONE ROTATION PER RUN, NOT PER FIGHT. The second boss picks up on the loop the
 * first one had queued when it died, the third carries on from the second, and
 * so on — the run has a single piece of fight music that the fights are windows
 * onto, rather than each fight replaying the same opening. A player who meets
 * four bosses hears four different stretches of it.
 *
 * The intro is part of that: it belongs to the RUN's first boss, and after that
 * the cursor is never allowed back to it. Claimed the moment it is queued
 * rather than when it finishes, so a boss killed inside its own first bar still
 * spends it — otherwise the shortest fight in the run would hand the intro to
 * the next one and the announcement would land twice.
 *
 * @returns true if the bank is loaded and a switch was queued.
 */
export function startBossMusic() {
  if (!CONFIG.music.enabled || !started) return false;
  bossFights += 1;
  // A second boss arriving mid-fight joins the one already playing rather than
  // restarting the rotation.
  if (bossActive) return true;
  const bank = bossBank();
  if (bank.length === 0) {
    // Nothing loaded — the run's own music plays on. Deliberately not silence:
    // a missing file should cost the fight its score, not the game its sound.
    bossFights = Math.max(0, bossFights - 1);
    return false;
  }
  bossActive = true;
  const floor = bank.length > 1 && CONFIG.music.bossIntro !== false ? 1 : 0;
  if (bossCursor < 0) bossCursor = 0; // the run's first boss, and the only intro
  else if (bossCursor < floor || bossCursor >= bank.length) bossCursor = floor;
  queueTrack(bank[bossCursor], 'bar');
  return true;
}

/**
 * The fight is over. Hand the transport back to the run's own music.
 *
 * Called from systems/bossKill.js as the water ramps back to full speed —
 * BEFORE releaseMusicHush, so the level the score comes back at is the ordinary
 * one rather than the boss trim, and the loop that fades up is already the
 * right one. The switch itself is inaudible: it happens while the hush still
 * has the music gain at zero.
 *
 * Unquantised on purpose. Every other switch in this file waits for a boundary
 * because a listener can hear the seam; there is no seam to hear when nothing
 * is sounding, and the ordinary loop should come back from ITS OWN bar one
 * rather than a bar and a half into a phrase.
 *
 * @param opts.immediate  false lets the boss loop finish its bar first, for the
 *                        callers that end a fight with the music still audible
 *                        (a boss switched off in the tuner, a boss that leaves
 *                        without a kill shot).
 */
export function endBossMusic({ immediate = true } = {}) {
  bossFights = Math.max(0, bossFights - 1);
  if (!bossActive || bossFights > 0) return;
  bossActive = false;
  // `bossCursor` is deliberately LEFT WHERE IT IS — it is the run's place in the
  // rotation, not this fight's, and the next boss resumes from it. Only a run
  // reset clears it.
  //
  // What it points at right now is the loop this fight had queued and never got
  // to play, so nothing in the bank is skipped and nothing is heard twice in a
  // row across the gap between two fights.
  queuedTrack = null;
  if (!started || !ensureChain()) return;
  // Whatever the run is owed NOW: the player has almost certainly levelled
  // during the fight, and setLevel stood down for the duration (see above), so
  // this is where those level-ups are finally answered. From the top of the
  // loop, which is the point of doing it under the hush.
  const slot = slotForLevel(currentLevel);
  if (!slot) return;
  if (immediate) startSource(slot, ctx.currentTime + 0.02);
  else queueTrack(slot, 'bar');
}

/**
 * Drop the rotation with no handover — a run reset, or the fight's owner going
 * away. play() calls this; nothing else should need it.
 */
export function resetBossMusic() {
  bossFights = 0;
  bossActive = false;
  bossCursor = -1;
}

// Which uploaded loop should be playing at this level. Empty slots are
// skipped, so uploading only a few loops still spreads them across a run
// instead of leaving silent gaps.
export function slotForLevel(level) {
  const filled = [];
  for (let i = 1; i <= CONFIG.music.slots; i++) if (tracks.has(String(i))) filled.push(String(i));
  if (filled.length === 0) return null;
  const idx = Math.floor((level - 1) / Math.max(1, CONFIG.music.levelsPerSlot));
  return filled[Math.min(idx, filled.length - 1)];
}

// Upgrade screen: duck below wherever depth currently has the filter, and
// freeze depth tracking so it can't sweep back up underneath the duck.
export function duckForUpgrade() {
  if (!CONFIG.music.enabled || !started) return;
  depthHeld = true;
  rampTo(CONFIG.music.duckedHz, CONFIG.music.duckTime);
}

// Back to gameplay: release the hold and let updateDepth glide out of the
// duck over `sweepTime`. Deliberately schedules nothing itself — a ramp here
// would just be truncated by the next frame's depth update.
export function sweepOpen() {
  if (!CONFIG.music.enabled || !started || !ensureChain()) return;
  depthHeld = false;
  resumeUntil = ctx.currentTime + CONFIG.music.sweepTime;
}

// --- suffocation band-pass -------------------------------------------------
// `amount` is oxygenFx's 0..1 strain. At 0 this is an exact bypass (wet
// silent, dry unity), so a run played well never touches the music path.
//
// Two things move together as it climbs: the crossfade pushes signal into the
// band-pass path, and the band itself narrows from wide-open toward
// `musicQ` — so the score doesn't just get thinner, it closes in.
//
// setTargetAtTime rather than direct assignment for the same reason
// updateDepth uses it: this is called every frame, and stepping the values
// would zipper.
export function setBandpass(amount) {
  if (!ensureChain()) return;
  const cfg = CONFIG.oxygen?.fx ?? {};
  const a = cfg.musicEnabled === false ? 0 : Math.max(0, Math.min(1, amount || 0));
  const now = ctx.currentTime;
  const mix = a * (cfg.musicMix ?? 0.92);
  bandDry.gain.setTargetAtTime(1 - mix, now, 0.06);
  bandWet.gain.setTargetAtTime(mix, now, 0.06);
  bandpass.frequency.setTargetAtTime(Math.max(60, cfg.musicCenterHz ?? 900), now, 0.06);
  bandpass.Q.setTargetAtTime(0.7 + a * Math.max(0, (cfg.musicQ ?? 3.6) - 0.7), now, 0.06);
}

// ---------------------------------------------------------------------------
// THE HUSH — the silence a boss dies into
// ---------------------------------------------------------------------------
// The loop is cut almost dead on the frame the last hit lands, and the last
// moment of it is thrown into a long reverb that rings out over the held
// close-up (systems/bossKill.js). What the player hears is the score stopping
// and the room it was playing in carrying on without it — the biggest silence
// the game has, and it is a silence with the music's own tail still in it.
//
// WHY A SEND AND NOT A FADE. Fading the loop out over four seconds is the
// obvious version and it is not the same thing at all: the music would still
// be PLAYING through the whole beat, quieter, still moving, still counting its
// bars. What this does is stop the performance and keep the room — the send is
// opened wide for a fraction of a second, which is the "last note" the tail is
// built from, and then the transport is muted underneath it. The convolver
// goes on outputting what it was fed for the length of the impulse, and
// nothing else in the mix is playing.
//
// It also survives the tape drag on top of it. The kill shot drops the
// playback rate at the same moment (see the `audio` block in CONFIG.boss.kill),
// so the fraction of a second the send is given is a fraction of a second of
// the loop ALREADY slowing down — the tail is built out of a note bending
// downward, which is most of why it reads as the end of something.

/**
 * Cut the music and light the tail.
 *
 * @param opts.cut      seconds to mute the transport over. Short — this is a
 *                      stop, not a fade — but not zero: an instant cut on a
 *                      sustained loop is an audible click.
 * @param opts.feed     seconds of music thrown into the reverb. This is the
 *                      "last note", and it is the one number that changes what
 *                      the tail is MADE of rather than how it sounds.
 * @param opts.seconds  length of the impulse: how long the room rings.
 * @param opts.decay    how fast it falls away. Higher is a smaller room.
 * @param opts.level    tail level, against the music's own.
 * @returns true if anything was lit. False means there was nothing playing, or
 *          the player has the music off — either way the caller has no tail to
 *          wait for and releaseMusicHush is still safe to call.
 */
export function hushMusic(opts = {}) {
  if (!started || !ensureChain()) return false;
  const base = baseMusicGain();
  if (base <= 0) return false;

  const now = ctx.currentTime;
  const seconds = Math.max(0.2, opts.seconds ?? 4.5);
  const decay = Math.max(0.1, opts.decay ?? 2.4);
  // Rebuilt only when its shape changes — an impulse is a few hundred thousand
  // random numbers, and a boss dies often enough that generating one per kill
  // would be a hitch on the exact frame the game is holding still to be looked
  // at.
  const sig = `${seconds}|${decay}`;
  if (sig !== tailSignature || !tailVerb.buffer) {
    const buffer = makeImpulse(seconds, decay);
    if (!buffer) return false;
    tailVerb.buffer = buffer;
    tailSignature = sig;
  }

  tailOut.gain.cancelScheduledValues(now);
  tailOut.gain.setValueAtTime(base * Math.max(0, opts.level ?? 1.35), now);

  // Open wide, then shut. The send taps the depth filter, which is UPSTREAM of
  // the mute below, so what it hears is the loop at full level for exactly as
  // long as this window is open regardless of what the dry path is doing.
  const feed = Math.max(0.02, opts.feed ?? 0.28);
  tailSend.gain.cancelScheduledValues(now);
  tailSend.gain.setValueAtTime(Math.max(0, opts.send ?? 1), now);
  tailSend.gain.linearRampToValueAtTime(0, now + feed);

  const cut = Math.max(0.02, opts.cut ?? 0.22);
  musicGain.gain.cancelScheduledValues(now);
  musicGain.gain.setValueAtTime(base, now);
  musicGain.gain.linearRampToValueAtTime(0, now + cut);

  hushed = true;
  return true;
}

/**
 * Bring the loop back. Quick on purpose: the beat is over, the ocean is
 * accelerating back to full speed, and the music arriving slowly behind it
 * would leave the first seconds of live play sounding like the aftermath
 * rather than like the next fight.
 *
 * The tail is faded out UNDER the returning music rather than left to finish:
 * a room still ringing from a note the score has already moved on from is a
 * smear over the top of it. Safe to call when nothing was hushed.
 *
 * @param fade seconds to bring the loop back over. 0 restores it instantly,
 *             which is what a run reset wants.
 */
export function releaseMusicHush(fade = 0.35) {
  if (!hushed) return;
  hushed = false;
  if (!ensureChain()) return;
  const now = ctx.currentTime;
  const base = baseMusicGain();

  musicGain.gain.cancelScheduledValues(now);
  if (fade > 0) {
    musicGain.gain.setValueAtTime(musicGain.gain.value, now);
    musicGain.gain.linearRampToValueAtTime(base, now + fade);
  } else {
    musicGain.gain.setValueAtTime(base, now);
  }

  tailSend.gain.cancelScheduledValues(now);
  tailSend.gain.setValueAtTime(0, now);
  tailOut.gain.cancelScheduledValues(now);
  if (fade > 0) {
    tailOut.gain.setValueAtTime(tailOut.gain.value, now);
    tailOut.gain.linearRampToValueAtTime(0, now + fade * 2);
  } else {
    tailOut.gain.setValueAtTime(0, now);
  }
}

/** Is the score currently cut? For the tuner readout and the tests. */
export function musicHushed() {
  return hushed;
}

/**
 * Re-apply only the PLAYER's half of the music level — the Audio tab's master,
 * music and mute. Cheap enough for every step of a slider drag: one gain write.
 *
 * Separate from applyMusicSettings for the same reason audio.js splits
 * applyPlayerAudioSettings out of applyAudioBusSettings: that one also restamps
 * the filter Q and re-issues the playback rate, and a volume slider has no
 * business touching either.
 */
export function applyPlayerMusicSettings() {
  if (!musicGain || hushed) return;
  musicGain.gain.value = baseMusicGain();
}

export function applyMusicSettings() {
  if (!ensureChain()) return;
  // The authored level times the player's own (Audio tab), with mute folded
  // into the scale. A separate node would be tidier but the music chain is
  // built once and this is the gain everything else already writes to.
  //
  // NOT while the hush has it. That is an automation ramp on this same param,
  // and a plain `.value =` in the middle of one is either ignored outright or
  // lands for a single frame before the ramp overwrites it — a volume slider
  // dragged during a boss kill would un-mute the score for one frame of the
  // silence the whole moment is built on. The release reads the level fresh,
  // so a change made during the hush still arrives, one beat later.
  if (!hushed) musicGain.gain.value = baseMusicGain();
  filter.Q.value = CONFIG.music.resonance;
  // Through writeRate rather than assigned: a plain `.value =` is ignored
  // outright while automation is scheduled, so dragging the rate slider during
  // a dilation used to do nothing at all.
  writeRate(0);
}
