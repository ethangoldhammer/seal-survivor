import { CONFIG } from '../config.js';
import { bounds, depthFraction } from '../arena.js';
import { getAudioContext } from './audio.js';

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

const tracks = new Map(); // name -> AudioBuffer
let currentTrack = null;
let queuedTrack = null;
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

// How long one full pass of the loop that's PLAYING takes, in score seconds.
// The file's own length is the truth here: "the loop has finished" means the
// thing the player can hear has come back round, and that's where the buffer
// wraps, whatever the BPM says. Falls back to the grid before anything has
// loaded.
function loopSeconds() {
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
    musicGain.gain.value = CONFIG.music.volume;

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
  }
  return true;
}

export async function loadTrackFromFile(name, file) {
  if (!ensureChain()) return false;
  try {
    tracks.set(name, await ctx.decodeAudioData(await file.arrayBuffer()));
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
  // Picks up the ramp in flight rather than snapping to the rate it's heading
  // for: a track can change hands mid-dilation now that the music plays on
  // through the death dive.
  rateTarget = targetRate();
  source.playbackRate.value = rateNow;
  if (rateTau > 0) source.playbackRate.setTargetAtTime(rateTarget, ctx.currentTime, rateTau);
  source.connect(filter);
  source.start(when);
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
  depthHeld = false;
  resumeUntil = 0;
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
  started = false;
  queuedTrack = null;
  pendingLevel = null;
  if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
}

// Queue a track to begin at the next loop boundary. Passing the track that's
// already playing is a no-op, so repeated level-ups don't restart the loop.
export function queueTrack(name) {
  if (!started || !tracks.has(name) || name === currentTrack) return;
  queuedTrack = name;
}

function pollQueue() {
  if (!ctx || !started) return;
  // Carry the score clock forward even with nothing queued: it's what the beat
  // grid reads, and 40ms steps keep the integration honest through a rate ramp
  // whether or not anything is asking for the phase this frame.
  advance();
  if (!queuedTrack) return;
  const now = ctx.currentTime;
  const boundary = nextBoundary(now);
  // Schedule slightly ahead of the boundary so the switch is sample-accurate
  // rather than depending on when this poll happens to fire.
  if (boundary - now <= 0.12) {
    const name = queuedTrack;
    queuedTrack = null;
    startSource(name, boundary);
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
  const slot = slotForLevel(level);
  if (slot != null && slot !== currentTrack) queueTrack(slot);
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

export function applyMusicSettings() {
  if (!ensureChain()) return;
  musicGain.gain.value = CONFIG.music.enabled ? CONFIG.music.volume : 0;
  filter.Q.value = CONFIG.music.resonance;
  // Through writeRate rather than assigned: a plain `.value =` is ignored
  // outright while automation is scheduled, so dragging the rate slider during
  // a dilation used to do nothing at all.
  writeRate(0);
}
