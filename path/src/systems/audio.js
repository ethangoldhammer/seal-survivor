import { CONFIG } from '../config.js';
import { depthFraction } from '../arena.js';
import { isTypingTarget } from '../ui/typing.js';

// Sound is synthesised from the specs in CONFIG.sfx, so the game ships with no
// audio files at all. Point an entry at real files and those are used instead;
// if they fail to load we fall back to the synth, the same way a missing model
// falls back to a shape.
//
//   srcs: ['/sfx/a.mp3', '/sfx/b.mp3', …]   variations, one picked per play
//   src:  '/sfx/a.mp3'                      shorthand for a one-entry `srcs`
//
// Variations matter most for the sounds that fire constantly — the basic shot
// goes off several times a second, and one sample repeated at that rate turns
// into a machine-gun rattle. Cycling a handful of takes is what keeps it
// sounding like an instrument rather than a loop.

let ctx = null;
let master = null;
let unlocked = false;
let active = 0;
// name -> AudioBuffer[]  (one entry per successfully decoded variation)
const buffers = new Map();
// name -> index last played, so a random pick never repeats back-to-back.
const lastPick = new Map();

// The Sound tab builds its rows at boot, BEFORE preloadSamples has finished
// fetching — so a row's "synth / N samples" label is provisional and has to
// be refreshed once loading lands, or a sound with samples reads as synth
// forever and uploads look like they didn't stick.
const sampleListeners = new Set();
export function onSamplesChanged(cb) {
  sampleListeners.add(cb);
  return () => sampleListeners.delete(cb);
}
function notifySamplesChanged() {
  for (const cb of sampleListeners) cb();
}
let muted = false;

// A global playback-rate multiplier on every one-shot, used by the death dive
// to slow the sound down with the picture (see systems/deathDive.js). Applied
// as pitch, which for a sampled sound IS the tape speed; the synth path gets
// the same treatment split across its two halves — frequencies scale with the
// rate and envelopes stretch by its inverse, so a slowed blip drops AND
// lengthens rather than just going flat.
//
// New sounds only. A one-shot already in flight keeps the rate it started at,
// which is what you want here: the sounds that were mid-air when the seal died
// are its last frame of normal time, and the dilation should arrive with what
// comes after them.
let rateScale = 1;

export function setSfxRateScale(scale) {
  rateScale = Math.max(0.05, Math.min(4, scale || 1));
}

// --- master SFX bus ---------------------------------------------------------
// Everything synthesised or sampled lands on `master`, which then runs through
// a shared filter, a reverb send and a dynamics stage before the speakers:
//
//   master -> busFilter ->  dryGain ---> sum -> [comp] -> makeup -> ceiling -> out
//                       \-> convolver -> wetGain -/
//
// The reverb is parallel (send/return) rather than in series, so the wet signal
// is mixed ALONGSIDE the dry one — a purely serial reverb would swallow the
// transient that makes a blip read as a hit. Music has its own chain and
// deliberately does not pass through here; this is the SFX bus only.
//
// THE DYNAMICS STAGE exists because the per-sound gains have to be free to go
// loud. Samples arrive at wildly different levels (there is a 20dB spread
// across the bank as authored), so getting the quiet ones audible means driving
// them hard — and a dozen one-shots landing on the same frame then sums well
// past full scale and clips, which is a click, not a loud sound.
//
//   comp     light glue, and the thing that makes a busy frame sit DOWN so the
//            next sound still has somewhere to go.
//   makeup   what the compressor took off, put back. This is the control that
//            actually makes the mix louder; the compressor on its own only
//            makes it smaller.
//   ceiling  a soft-clip curve, and the reason the makeup is safe. Zero
//            latency — it is a waveshaper, not a lookahead limiter — so it can
//            sit on a game bus where 6ms of delay per stage would be felt.
let busFilter = null;
let convolver = null;
let dryGain = null;
let wetGain = null;
let sumGain = null;
let compressor = null;
let makeupGain = null;
let ceilingShaper = null;
let irSignature = ''; // regenerate the impulse only when its shape changes
let ceilingSignature = ''; // same, for the soft-clip curve
let compRouted = null; // whether the compressor is currently IN the chain

// A synthetic impulse response: noise decaying exponentially. This is the
// standard way to get a plausible reverb tail without shipping an IR file —
// the game has no audio assets by default and this keeps it that way.
function buildImpulse(seconds, decay) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * Math.max(0.05, seconds)));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      // Higher `decay` = faster fall-off = smaller, tighter room.
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, Math.max(0.1, decay));
    }
  }
  return buf;
}

// A soft-clip transfer curve, in two pieces:
//
//   |x| <= knee     y = x                                    (untouched)
//   |x| >  knee     y = knee + (c - knee) * tanh((|x| - knee) / (c - knee))
//
// Piecewise rather than a plain `c * tanh(x / c)`, which is the obvious version
// and is wrong here. That curve starts bending immediately — at half scale it
// is already most of a dB down — so it does not limit the mix so much as
// quietly recompress all of it, and moving the ceiling would change the level
// of every sound in the game rather than just the peaks.
//
// This one is bit-exact below the knee and only then bends, meeting the knee
// with matching value AND slope (tanh has slope 1 at zero), so there is no
// corner where it takes over. It approaches `c` and never reaches it.
//
// A WaveShaper's curve is defined over an input of -1..1 and the spec CLAMPS
// anything beyond that to the end entries, which is what makes this a real
// ceiling rather than a suggestion: however hard the bus is driven, the output
// cannot exceed the last value in this table.
function buildCeilingCurve(ceiling, kneeFraction) {
  const n = 2048;
  const c = Math.max(0.05, Math.min(1, ceiling));
  // Kept strictly below the ceiling, or the curved half has no room to exist
  // and the transfer becomes a hard clip at the knee.
  const knee = Math.max(0, Math.min(0.98, kneeFraction ?? 0.6)) * c;
  const span = Math.max(1e-4, c - knee);
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + span * Math.tanh((a - knee) / span);
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

function buildBus() {
  busFilter = ctx.createBiquadFilter();
  convolver = ctx.createConvolver();
  dryGain = ctx.createGain();
  wetGain = ctx.createGain();
  sumGain = ctx.createGain();
  compressor = ctx.createDynamicsCompressor();
  makeupGain = ctx.createGain();
  ceilingShaper = ctx.createWaveShaper();

  master.connect(busFilter);
  // Both halves of the reverb send meet at `sum` rather than at the speakers,
  // because the dynamics stage below has to see the WHOLE bus. A compressor fed
  // only the dry path would duck the transient while the tail carried on at
  // full level, which is audible as the reverb swelling every time something
  // loud happens.
  busFilter.connect(dryGain).connect(sumGain);
  busFilter.connect(convolver);
  convolver.connect(wetGain).connect(sumGain);

  applyAudioBusSettings();
}

// (Re)wire the tail of the bus. Called whenever the compressor is switched on
// or off: it is unpatched rather than set to a transparent ratio, because a
// DynamicsCompressorNode adds a few milliseconds of lookahead delay whether or
// not it is doing anything, and "off" should mean off on a bus that fires on
// the same frame as the picture.
function routeBusTail(useComp) {
  if (compRouted === useComp) return;
  compRouted = useComp;
  try {
    sumGain.disconnect();
    compressor.disconnect();
    makeupGain.disconnect();
    ceilingShaper.disconnect();
  } catch { /* not connected yet */ }

  if (useComp) sumGain.connect(compressor).connect(makeupGain);
  else sumGain.connect(makeupGain);
  makeupGain.connect(ceilingShaper).connect(ctx.destination);
}

// How much the compressor is pulling down right now, in dB (negative, or 0
// when it is idle). The Sound tab shows it live: a compressor you cannot see
// working is a compressor nobody can tune.
export function busReduction() {
  if (!compressor || !compRouted) return 0;
  return compressor.reduction ?? 0;
}

// Push CONFIG.audio.bus onto the live nodes. Safe to call every time a slider
// moves — the impulse response is only rebuilt when its shape actually
// changed, since regenerating a couple of seconds of noise per frame while
// dragging would be silly.
export function applyAudioBusSettings() {
  if (!ctx || !busFilter) return;
  const b = CONFIG.audio.bus ?? {};

  busFilter.type = b.filterType ?? 'lowpass';
  busFilter.Q.value = Math.max(0.0001, b.filterQ ?? 1);
  // With depth tracking on, updateBusDepth owns the cutoff — stamping the
  // manual value back on here every time another bus slider moved would
  // fight it, and you'd hear the filter jump each time you touched reverb.
  if (!b.depth?.enabled) {
    busFilter.frequency.value = Math.max(20, b.filterHz ?? 20000);
  }

  const mix = Math.max(0, Math.min(1, b.reverbMix ?? 0));
  // Equal-power crossfade: a linear one dips in perceived loudness through
  // the middle of the range, which reads as a volume bug while you're just
  // trying to dial in reverb.
  dryGain.gain.value = Math.cos(mix * Math.PI * 0.5);
  wetGain.gain.value = Math.sin(mix * Math.PI * 0.5);

  const seconds = b.reverbSeconds ?? 1.6;
  const decay = b.reverbDecay ?? 2;
  const sig = `${seconds}|${decay}`;
  if (sig !== irSignature) {
    irSignature = sig;
    convolver.buffer = buildImpulse(seconds, decay);
  }

  // --- dynamics -------------------------------------------------------------
  const c = b.comp ?? {};
  routeBusTail(c.enabled !== false);

  compressor.threshold.value = Math.max(-100, Math.min(0, c.threshold ?? -18));
  compressor.knee.value = Math.max(0, Math.min(40, c.knee ?? 12));
  compressor.ratio.value = Math.max(1, Math.min(20, c.ratio ?? 3));
  compressor.attack.value = Math.max(0, Math.min(1, c.attack ?? 0.005));
  compressor.release.value = Math.max(0, Math.min(1, c.release ?? 0.18));
  makeupGain.gain.value = Math.max(0, c.makeup ?? 1.6);

  // Same reasoning as the impulse above: rebuilding two thousand tanh calls on
  // every frame of a slider drag would be silly, and the curve only depends on
  // the one number.
  const ceiling = Math.max(0.05, Math.min(1, c.ceiling ?? 0.95));
  const kneeFraction = c.ceilingKnee ?? 0.6;
  const csig = `${ceiling}|${kneeFraction}|${c.oversample ?? '2x'}`;
  if (csig !== ceilingSignature) {
    ceilingSignature = csig;
    ceilingShaper.curve = buildCeilingCurve(ceiling, kneeFraction);
    // The curve is a nonlinearity, so it generates harmonics — some of which
    // land above Nyquist and fold back down as aliasing. Oversampling is what
    // keeps a hard-driven bus sounding saturated rather than gritty.
    ceilingShaper.oversample = c.oversample ?? '2x';
  }

  if (master) master.gain.value = CONFIG.audio.masterVolume;
}

// Called every frame with the player's Y, mirroring the music filter — diving
// muffles the whole SFX bus the way it muffles the score. Deliberately its own
// surface/deep pair rather than reusing the music's: sound effects sit in a
// different part of the mix and want a much narrower range, or every hit turns
// to mud the moment you leave the surface.
export function updateBusDepth(y) {
  if (!ctx || !busFilter) return;
  const d = CONFIG.audio.bus?.depth;
  if (!d?.enabled) return;
  const t = depthFraction(y);
  // Log-space, same reasoning as the music filter: cutoff is perceived
  // logarithmically, so a linear ramp wastes most of its travel.
  const target = (d.surfaceHz ?? 20000) * Math.pow((d.deepHz ?? 3000) / (d.surfaceHz ?? 20000), t);
  // setTargetAtTime glides rather than steps, so re-issuing it per frame is
  // smooth; setValueAtTime every frame would zipper.
  busFilter.frequency.setTargetAtTime(
    Math.max(20, target),
    ctx.currentTime,
    Math.max(0.01, d.smoothing ?? 0.15),
  );
}

// Sweep the bus back to its un-muffled cutoff over `smoothing` seconds.
//
// updateBusDepth only runs during a live run, so whatever the last frame of one
// left the filter at is where it stays — and the death dive deliberately drags
// it all the way down as the body sinks. Coming back from that needs the sweep
// to be a sound in its own right rather than a jump on the frame the next run
// starts, and the run's own first updateBusDepth would set the target from the
// player's new position without doing anything about the distance to it.
export function openBusFilter(smoothing = 0.3) {
  if (!ctx || !busFilter) return;
  const b = CONFIG.audio.bus ?? {};
  // Whichever value owns the cutoff when nothing is diving: the surface end of
  // the depth track, or the manual setting when depth tracking is off.
  const open = b.depth?.enabled ? (b.depth.surfaceHz ?? 20000) : (b.filterHz ?? 20000);
  busFilter.frequency.setTargetAtTime(Math.max(20, open), ctx.currentTime, Math.max(0.01, smoothing));
}

// --- the debug tap ----------------------------------------------------------
// One watcher, not a listener set: this is called from inside playSfx, which
// fires several times a second in a quiet moment and dozens in a busy one. A
// null check costs nothing and allocates nothing, so with the overlay off the
// tap is invisible in a profile — which is the only way a debug hook belongs in
// a hot path.
//
// It reports OUTCOMES, not just names, because the interesting question when a
// sound is missing is never "did it fire" but "what happened to it": the
// throttle ate it, the voice limit ate it, it fell back to the synth because a
// file failed to decode, or the name is wrong and nothing was ever going to
// play. See ui/sfxDebug.js.
let sfxWatcher = null;

export function watchSfx(cb) {
  sfxWatcher = cb || null;
}

/**
 * @param name    the CONFIG.sfx key
 * @param outcome 'sample' | 'synth' | 'gap' | 'voices' | 'muted' | 'unknown' | 'off' | 'note'
 * @param detail  optional { take, takes, gain, text }
 */
export function noteSfx(name, outcome, detail) {
  if (sfxWatcher) sfxWatcher(name, outcome, detail);
}

// --- level conversion -------------------------------------------------------
// Gains are STORED linear (that is what an AudioParam wants) and EDITED in dB
// (that is what a level is). These are the only conversion between the two, so
// the tuner's sliders and anything else reading a level agree by construction.
//
// `DB_FLOOR` is silence rather than a very quiet level: the bottom of a level
// control has to be off, or a sound can never be switched out from the panel.
export const DB_FLOOR = -40;

export function gainToDb(gain) {
  if (!(gain > 0)) return DB_FLOOR;
  return Math.max(DB_FLOOR, 20 * Math.log10(gain));
}

export function dbToGain(db) {
  if (db <= DB_FLOOR) return 0;
  return 10 ** (db / 20);
}

// Every file an entry wants, normalised to an array.
function sourcesFor(def) {
  if (Array.isArray(def.srcs) && def.srcs.length) return def.srcs.filter(Boolean);
  return def.src ? [def.src] : [];
}

// Shared so the music player can hang its own chain off the same context —
// browsers limit how many AudioContexts a page can create, and two would
// also mean two separate unlock gestures.
export function getAudioContext() {
  if (!ctx) initAudio();
  return ctx;
}

// The input to the SFX bus. playSfx builds a throwaway graph per shot and
// connects it here; sounds that are NOT one-shots need the same landing point.
// The mussel's flight voice is the first of those — it lives for as long as
// the shell does and has its pitch, filter and pan rewritten every frame, so
// it can't be expressed as a CONFIG.sfx entry at all. Handing out `master`
// rather than ctx.destination is what keeps it inside the shared filter and
// reverb send, so a mussel in flight ducks underwater with everything else
// instead of sitting oddly dry on top of the mix.
export function getSfxBus() {
  return master;
}

// True when there is a live, unlocked context to build nodes on. Deliberately
// does NOT fold in `muted` — a continuous voice reacts to the mute key by
// ducking its gain, not by tearing its graph down and rebuilding it on unmute.
export function isAudioLive() {
  return unlocked && !!ctx && CONFIG.audio.enabled;
}

export function initAudio() {
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'm' && !isTypingTarget(e.target)) muted = !muted;
  });
}

// Browsers require a user gesture before audio can start.
export function unlockAudio() {
  if (unlocked || !CONFIG.audio.enabled) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    ctx = new Ctx();
    master = ctx.createGain();
    master.gain.value = CONFIG.audio.masterVolume;
    buildBus();
    unlocked = true;
    preloadSamples();
    // A context built outside a real gesture comes up suspended and stays that
    // way — silent for the whole run, with nothing in the console to say why.
    // Now that a run can begin without a gesture (reduced motion skips the
    // splash, and so does a .riv that fails to load), catch that case and
    // resume on the player's first actual input instead.
    if (ctx.state === 'suspended') resumeOnFirstGesture();
  } catch (err) {
    console.warn('[audio] unavailable —', err?.message ?? err);
  }
}

function resumeOnFirstGesture() {
  const events = ['pointerdown', 'keydown', 'touchstart'];
  const resume = () => {
    for (const type of events) window.removeEventListener(type, resume);
    ctx?.resume().catch((err) => console.warn('[audio] resume failed —', err?.message ?? err));
  };
  for (const type of events) window.addEventListener(type, resume, { once: false });
}

export async function preloadSamples() {
  for (const [name, def] of Object.entries(CONFIG.sfx)) {
    const sources = sourcesFor(def);
    if (!sources.length) continue;
    // Fetch this entry's variations together rather than one after another —
    // a dozen short files loaded serially is a dozen round-trips on boot.
    const decoded = await Promise.all(sources.map(async (src) => {
      try {
        const res = await fetch(src);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await ctx.decodeAudioData(await res.arrayBuffer());
      } catch (err) {
        console.warn(`[audio] "${name}" could not load ${src} —`, err?.message ?? err);
        return null;
      }
    }));
    // A partly-failed set still plays: only the variations that decoded are
    // kept, and an entry that lost all of them falls back to the synth.
    const ok = decoded.filter(Boolean);
    if (ok.length) buffers.set(name, ok);
    else console.warn(`[audio] "${name}" has no usable samples — using the synth instead.`);
  }
  notifySamplesChanged();
}

// Re-fetch one sound's variations from its current config. Used after a
// variation is removed in the Sound tab: rebuilding from `srcs` keeps the
// in-memory set exactly in step with the list you can see, which splicing the
// buffer array by index would not — a file that failed to decode makes the
// two orders drift apart.
export async function reloadSample(name) {
  const def = CONFIG.sfx[name];
  if (!def || !ctx) return;
  const sources = sourcesFor(def);
  if (!sources.length) {
    buffers.delete(name);
    lastPick.delete(name);
    notifySamplesChanged();
    return;
  }
  const decoded = await Promise.all(sources.map(async (src) => {
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await ctx.decodeAudioData(await res.arrayBuffer());
    } catch (err) {
      console.warn(`[audio] "${name}" could not load ${src} —`, err?.message ?? err);
      return null;
    }
  }));
  const ok = decoded.filter(Boolean);
  if (ok.length) buffers.set(name, ok);
  else buffers.delete(name);
  lastPick.delete(name);
  notifySamplesChanged();
}

// Pick a variation, never the same one twice running. With a single sample
// this is just that sample; with several it stops the ear locking onto a
// repeat, which is the whole reason for having variations.
function pickSample(name) {
  const set = buffers.get(name);
  if (!set || !set.length) return null;
  // Recorded even with a single variation, so `lastPick` is always the take
  // that is actually sounding and the debug overlay can name it without
  // guessing. Costs one Map write on a path that already does several.
  if (set.length === 1) { lastPick.set(name, 0); return set[0]; }
  const prev = lastPick.get(name);
  let i = (Math.random() * set.length) | 0;
  if (i === prev) i = (i + 1) % set.length;
  lastPick.set(name, i);
  return set[i];
}

function noiseBuffer(duration) {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function envelope(gain, peak, decay, now) {
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), now + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + decay);
}

// --- repetition attenuation -------------------------------------------------
// The fix for a sound that turns to static when it repeats.
//
// The problem is not loudness, it is SUMMING. Twenty copies of one 0.25s
// transient inside a second do not read as twenty hits — they read as one
// continuous buzz, because each copy overlaps the tail of the last and their
// energies add. Turning the sound down fixes the buzz and loses the single
// hit; throttling harder loses the density that tells you how much you are
// connecting with.
//
// So instead: each rapid repeat of the SAME sound plays quieter than the one
// before, recovering as soon as the sound stops firing. The first hit after a
// pause is at full level and reads as a hit; a sustained wall of them settles
// at the floor and reads as a texture, which is what a wall of hits should be.
// This is the standard game-audio answer and it is why a shooter's hit marker
// can fire constantly without becoming noise.
//
// Keyed by SOUND rather than by event, because that is what sums: `kill` and
// `debrisBreak` are different events playing one sound, and it is the sound's
// copies that pile up.
const heat = new Map(); // name -> { h, at }

function repetitionGain(name, now) {
  const r = CONFIG.audio.repetition ?? {};
  if (r.enabled === false) return 1;
  const recovery = Math.max(0.01, r.recovery ?? 0.5);
  const strength = Math.max(0, r.strength ?? 0.35);
  const floorGain = Math.min(1, Math.max(0, r.floor ?? 0.25));

  const prev = heat.get(name);
  // Heat decays exponentially, so a sound fired once a second barely warms up
  // (at the default recovery it comes back ~87% cooled) and one fired twenty
  // times a second reaches a steady state near the floor. Nothing has to know
  // the rate; the time constant does that on its own.
  const h = prev ? prev.h * Math.exp(-(now - prev.at) / recovery) + 1 : 1;
  heat.set(name, { h, at: now });

  // The first hit of a burst is always untouched — h is 1 for a cold sound and
  // this returns exactly 1. Attenuation only ever applies to the copies behind
  // it, which is the whole point.
  if (h <= 1) return 1;
  return Math.max(floorGain, 1 / (1 + (h - 1) * strength));
}

// Cleared between runs so a busy death doesn't leave the next run's first
// shots ducked.
export function resetRepetition() {
  heat.clear();
}

// A symmetric random multiplier around 1: vary(0.1) -> 0.9 .. 1.1. Clamped
// so an unlucky roll can never invert or silence a sound.
function vary(amount) {
  if (!amount) return 1;
  const a = Math.min(0.9, Math.abs(amount));
  return 1 + (Math.random() * 2 - 1) * a;
}

// opts:
//   pitch     extra pitch multiplier ON TOP of the per-sound random variation
//             (kill sounds use this to drop in pitch for bigger enemies)
//   decayMul  stretches the tail (bigger enemies boom for longer)
// Decode an uploaded audio file (mp3/wav/ogg) and use it for `name` from now
// on. Returns false if it couldn't be decoded, leaving the synth fallback in
// place rather than silently muting that sound.
export async function loadSampleFromFile(name, file, { append = false } = {}) {
  if (!ctx) initAudio();
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    // Appending builds up a variation set one upload at a time, which is how
    // the Sound tab lets you stack takes for a single sound.
    const existing = append ? (buffers.get(name) ?? []) : [];
    buffers.set(name, [...existing, buf]);
    notifySamplesChanged();
    return true;
  } catch (err) {
    console.warn(`[audio] could not decode "${file.name}" for "${name}" — keeping the synthesized sound.`, err?.message ?? err);
    return false;
  }
}

export function clearSample(name) {
  buffers.delete(name);
  lastPick.delete(name);
  notifySamplesChanged();
}

export function hasSample(name) {
  return (buffers.get(name)?.length ?? 0) > 0;
}

// How many variations are loaded for a sound — the Sound tab shows this so
// you can see a set building up as you upload takes.
export function sampleCount(name) {
  return buffers.get(name)?.length ?? 0;
}

export function playSfx(name, volumeScale = 1, opts = {}) {
  if (muted) { noteSfx(name, 'muted'); return; }
  if (!unlocked || !ctx || !CONFIG.audio.enabled) { noteSfx(name, 'off'); return; }
  const def = CONFIG.sfx[name];
  // Nothing warns about this at runtime — playSfx has always just returned —
  // so a typo'd name is a sound that silently never plays. The overlay is the
  // only place it becomes visible.
  if (!def) { noteSfx(name, 'unknown'); return; }
  if (active >= CONFIG.audio.maxConcurrent) { noteSfx(name, 'voices'); return; }

  const now = ctx.currentTime;
  const pitchMul = vary(def.pitchVary) * (opts.pitch ?? 1) * rateScale;
  const filterMul = vary(def.filterVary);
  // Stretched by the same factor the pitch drops by, so slowing a sound down
  // makes it longer as well as lower. The throttle counter below reads this,
  // so a dilated tail also holds its voice slot for as long as it really rings.
  const decay = ((def.decay ?? 0.2) * (opts.decayMul ?? 1)) / rateScale;
  // Measured on the audio clock rather than a counter, so the attenuation
  // follows real elapsed time and behaves the same at any frame rate.
  const rep = repetitionGain(name, now);
  const gainValue = (def.gain ?? 0.2) * volumeScale * rep;

  active += 1;
  window.setTimeout(() => { active = Math.max(0, active - 1); }, (decay + 0.1) * 1000);

  // A loaded sample replaces the synth entirely, but still gets the same
  // pitch treatment — playbackRate doubles as pitch for a buffer source. With
  // several variations loaded, each play picks a different one.
  const sample = pickSample(name);
  if (sample) {
    noteSfx(name, 'sample', {
      take: (lastPick.get(name) ?? 0) + 1,
      takes: buffers.get(name)?.length ?? 1,
      gain: gainValue,
      pitch: pitchMul,
      rep,
    });
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = gainValue;
    src.buffer = sample;
    src.playbackRate.value = Math.max(0.05, pitchMul);
    let node = src;
    if (def.filter) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = Math.max(80, def.filter * filterMul);
      src.connect(filter);
      node = filter;
    }
    node.connect(gain).connect(master);
    src.start(now);
    return;
  }

  // Reached only when no sample is loaded — either the entry has none by
  // design, or every file it named failed to decode. The overlay does not try
  // to tell those apart; the boot warning already does, and what matters live
  // is that this sound is NOT the file you think it is.
  noteSfx(name, 'synth', { gain: gainValue, pitch: pitchMul, rep });

  const wantsTone = def.type === 'blip' || def.type === 'boom';
  const wantsNoise = def.type === 'noise' || def.type === 'boom';

  if (wantsTone) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = def.wave ?? 'sine';
    const [from, to] = def.freq ?? [440, 220];
    osc.frequency.setValueAtTime(Math.max(20, from * pitchMul), now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to * pitchMul), now + decay);
    // Slight detune keeps a steady-pitch weapon from sounding sterile
    // without actually moving its pitch around.
    if (def.detune) osc.detune.value = (Math.random() * 2 - 1) * def.detune;
    envelope(gain, gainValue, decay, now);
    osc.connect(gain).connect(master);
    osc.start(now);
    osc.stop(now + decay + 0.05);
  }

  if (wantsNoise) {
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    src.buffer = noiseBuffer(decay + 0.05);
    filter.type = 'lowpass';
    const cutoff = Math.max(80, (def.filter ?? 2000) * filterMul * pitchMul);
    filter.frequency.setValueAtTime(cutoff, now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(80, cutoff * 0.25), now + decay);
    envelope(gain, gainValue * (def.noise ?? 1), decay, now);
    src.connect(filter).connect(gain).connect(master);
    src.start(now);
    src.stop(now + decay + 0.05);
  }
}

// Phone buzz only — this is the Vibration API, which does not exist on desktop
// and cannot reach a gamepad. Controller rumble lives in systems/haptics.js.
export function vibrate(pattern) {
  if (!pattern || !CONFIG.haptics.enabled) return;
  // The Vibration API only understands a number or an array of numbers, and
  // throws a TypeError on anything else. Pulse-object patterns used to be
  // dropped here outright — fine when two events used that form, but every
  // event added since authors its haptic that way, so on a phone the entire
  // companion-ability block would have buzzed for nothing at all.
  //
  // A phone motor has no intensity control, so magnitude can't survive the
  // conversion; duration and spacing can, and that's what carries the shape.
  const ms = toMsPattern(pattern);
  if (!ms) return;
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* permissions policy or unsupported — ignore */
  }
}

// -> a Vibration-API [on, off, on, ...] list, or null if there's nothing to
// buzz. Pulse objects carry ABSOLUTE delays (haptics.js resolves them that
// way), so each gap is the delay minus where the previous pulse ended.
function toMsPattern(pattern) {
  if (typeof pattern === 'number') return [pattern];
  if (!Array.isArray(pattern)) {
    return pattern?.duration > 0 ? [Math.round(pattern.duration)] : null;
  }
  if (pattern.every((v) => typeof v === 'number')) return pattern;

  const out = [];
  let cursor = 0;
  for (const p of pattern) {
    if (!p || typeof p !== 'object') continue;
    const duration = Math.round(p.duration ?? 40);
    if (duration <= 0) continue;
    const start = Math.round(p.delay ?? 0);
    // Overlapping pulses can't be expressed as on/off, so a pulse that starts
    // before the previous one finished is simply appended with no gap.
    if (out.length) out.push(Math.max(0, start - cursor));
    cursor = Math.max(cursor, start) + duration;
    out.push(duration);
  }
  return out.length ? out : null;
}

export function isMuted() {
  return muted;
}
