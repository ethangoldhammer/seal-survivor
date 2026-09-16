import { CONFIG } from '../config.js';
import { getAudioContext, getSfxBus, unlockAudio, noteSfx } from './audio.js';
import { fetchAudioBytes } from './fetchAudio.js';

// THE TITLE BED: one clip, looping, under the splash and nothing else.
//
// A deliberately smaller machine than systems/ambient.js, and the difference is
// worth stating because the two files look adjacent. The run's bed rotates
// through a set with equal-power crossfades between them, because it plays for
// the length of a run and a single clip would become a tape. This one plays for
// the length of a title card — seconds, once per page load — so it has no
// rotation, no crossfade, no poll and no schedule. It fades a loop up, and when
// the card breaks up it fades it away. Everything ambient.js is careful about is
// about the switch between clips, and there is no switch here.
//
// The graph, for the same reason ambient.js splits its two:
//
//   source -> fade -> volume -> SFX bus -> (filter, reverb, out)
//
// `fade` carries ONLY the 0..1 shape and `volume` ONLY the configured level, so
// the Sound tab's volume slider can be dragged while the fade-in is still
// running. Both on one node means a setTargetAtTime landing in the middle of a
// scheduled value curve, which in a real browser either throws or tears the fade
// in half.
//
// THE SUSPENDED CONTEXT IS THE WHOLE TRICK HERE, and it is why this can be
// started at mount rather than on a press. See ensureChain.

let ctx = null;
let volumeGain = null; // configured level; no fade curve ever touches it
let fadeGain = null;   // 0..1, and the only thing the fades are written onto
let source = null;     // the looping node, or null once a stop is SCHEDULED
let soundsUntil = 0;   // ctx time the bed actually goes quiet — see stopSource
let started = false;
// THE LOAD ITSELF, not a latch saying one happened. A boolean here would make
// preloadSplashBed() resolve instantly for every caller after the first —
// including one that is awaiting it to find out whether there is anything to
// play — so a second `await` would return before the first fetch had landed and
// report an empty bank. Holding the promise means every caller awaits the same
// load, which is what a caller asking for it means.
let loading = null;
let playing = null;    // the src string currently looping, for the tuner
let baseRate = 1;

const buffers = new Map(); // src string -> AudioBuffer

/** Decoded title bed in bytes — see systems/memoryCensus.js. */
export function splashBedBytes() {
  let n = 0;
  for (const b of buffers.values()) n += (b?.length ?? 0) * (b?.numberOfChannels ?? 1) * 4;
  return n;
}

function cfg() {
  return CONFIG.splashBed ?? {};
}

// The filled slots only. An empty slot is skipped rather than played as
// silence, so uploading one clip into slot 3 is a bed with one clip in it.
function srcs() {
  return (cfg().srcs ?? []).filter(Boolean);
}

function ensureChain() {
  // THIS BUILDS ITS OWN CONTEXT rather than waiting to be handed a live one,
  // and that is the difference between a title bed and no title bed.
  //
  // unlockAudio() is idempotent, and on a page with no gesture behind it yet it
  // makes a SUSPENDED context and arms its own resume on the first input. A
  // suspended context's clock does not advance — so the fade-in scheduled below
  // against ctx.currentTime has not "already finished" by the time the player
  // finally taps something; it plays from its first sample at that moment. That
  // is the best a title screen can do: a bed that waits for the gesture would
  // arrive AFTER the press that is usually Start.
  unlockAudio();
  if (!ctx) ctx = getAudioContext();
  if (!ctx) return false;
  const bus = getSfxBus();
  if (!bus) return false;
  if (!volumeGain) {
    volumeGain = ctx.createGain();
    volumeGain.gain.value = cfg().volume ?? 0.3;
    volumeGain.connect(bus);
    fadeGain = ctx.createGain();
    fadeGain.gain.value = 0;
    fadeGain.connect(volumeGain);
  }
  return true;
}

// Fetch every configured clip once. Same load-with-fallback contract as the
// ambient bed and the music loops: a clip that 404s or won't decode is logged
// and dropped, and the splash carries on silent rather than throwing on a file
// somebody moved.
export function preloadSplashBed() {
  if (loading) return loading;
  if (!ensureChain()) return Promise.resolve();
  loading = (async () => {
    await Promise.all(srcs().map(async (src) => {
      if (buffers.has(src)) return;
      try {
        buffers.set(src, await ctx.decodeAudioData(await fetchAudioBytes(src)));
      } catch (err) {
        console.warn(`[splashBed] could not load "${src}" —`, err?.message ?? err);
      }
    }));
    notifyClipsChanged();
    // startSplashBed may have run before any of this landed and found nothing to
    // play. Pick it up now rather than leaving the card silent for its whole
    // life because the decode lost a race with the mount — which, on a cold
    // load, it always does.
    if (started && !source) beginClip();
  })();
  return loading;
}

// The Sound tab builds its rows at boot, before any of the above has finished
// fetching, so a slot's "loaded" label is provisional and has to be refreshed
// when the decode lands — the same way the SFX, music and ambient rows do it.
const clipListeners = new Set();
export function onSplashBedClipsChanged(cb) {
  clipListeners.add(cb);
  return () => clipListeners.delete(cb);
}
function notifyClipsChanged() {
  for (const cb of clipListeners) cb();
}

export function hasSplashBedClip(src) {
  return !!src && buffers.has(src);
}

// Decode an uploaded file straight into the bed, so a clip can be auditioned
// before it has been written to disk as an asset.
export async function loadSplashBedFromFile(src, file) {
  if (!ensureChain()) return false;
  try {
    buffers.set(src, await ctx.decodeAudioData(await file.arrayBuffer()));
    notifyClipsChanged();
    return true;
  } catch (err) {
    console.warn(`[splashBed] could not decode "${file.name}" —`, err?.message ?? err);
    return false;
  }
}

export function clearSplashBedClip(src) {
  buffers.delete(src);
  notifyClipsChanged();
}

// Re-fetch after the slot list changed in the Sound tab. Anything already
// decoded is kept — the point is to pick up what was ADDED.
export async function reloadSplashBed() {
  loading = null;
  await preloadSplashBed();
}

// A symmetric random multiplier around 1, clamped so an unlucky roll can never
// stop or reverse the tape. Same helper the one-shots and the ambient bed use.
function vary(amount) {
  if (!amount) return 1;
  const a = Math.min(0.9, Math.abs(amount));
  return 1 + (Math.random() * 2 - 1) * a;
}

// THE FADE IN, as a sampled curve on t². Not linear, and not the equal-power
// cos/sin pair ambient.js crossfades with — both of those are answers to a
// different question.
//
// Equal power exists to keep the SUM of two uncorrelated clips flat through a
// crossfade; there is only one clip here, so it is just a curve that is steepest
// at zero, which is the worst possible shape for something that is supposed to
// appear without being noticed. A linear amplitude ramp has the same problem one
// step milder: loudness is roughly logarithmic in amplitude, so half amplitude is
// most of the way to full loudness and a linear fade is audibly most-of-the-way
// within the first third of it.
//
// t² is close to linear in dB over the range that matters, so the bed creeps in
// and the moment it "starts" is nowhere in particular. Sampled rather than
// scheduled as a ramp because setValueCurveAtTime is the one automation that
// cannot be truncated by a later setValueAtTime landing inside it.
function fadeInCurve(steps = 64) {
  const curve = new Float32Array(steps);
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    curve[i] = t * t;
  }
  return curve;
}

// `source` means "the node a restart would replace", and this clears it the
// moment a stop is SCHEDULED — which is not the moment the sound ends.
// `soundsUntil` is the honest one: the ctx time the bed actually goes quiet, and
// what splashBedState reports as `sounding`.
function stopSource(when = 0) {
  soundsUntil = Math.min(soundsUntil, when);
  if (!source) return;
  try { source.stop(when); } catch { /* already stopped */ }
  const dying = source;
  source = null;
  // Disconnected on the far side of the stop rather than immediately: pulling a
  // node out of the graph while it is still sounding is exactly the click the
  // fade exists to avoid.
  dying.onended = () => { try { dying.disconnect(); } catch { /* gone */ } };
}

// Put a clip up and fade it in. One pick, once, for the life of the card.
function beginClip() {
  const list = srcs();
  if (!list.length) return false;
  // Random among the filled slots. With one filled — the normal case — this is
  // deterministic; with several it makes them an A/B across reloads, which is
  // the only reason there is more than one slot.
  const src = list[(Math.random() * list.length) | 0];
  const buffer = buffers.get(src);
  if (!buffer) return false;

  const now = ctx.currentTime;
  stopSource(now);

  const node = ctx.createBufferSource();
  node.buffer = buffer;
  // The whole design: one clip held under one screen. A bed that stopped at the
  // end of its clip would leave the title card silent for however long the
  // player spends liking their name, which is the part of this screen the bed
  // is there for.
  node.loop = true;
  baseRate = Math.max(0.05, vary(cfg().pitchVary));
  node.playbackRate.value = baseRate;
  node.connect(fadeGain);
  node.start(now + 0.02);
  source = node;
  soundsUntil = Infinity;
  playing = src;

  const seconds = Math.max(0.05, cfg().fadeIn ?? 2.6);
  fadeGain.gain.cancelScheduledValues(now);
  fadeGain.gain.setValueAtTime(0, now);
  fadeGain.gain.setValueCurveAtTime(fadeInCurve(), now + 0.02, seconds);

  // A bed is the hardest thing in the mix to observe — quiet by design, and on
  // a screen where a silent one and a missing one look identical. The 0 overlay
  // gets a line so "is the title bed running" is a question with an answer.
  noteSfx('~title bed', 'note', { text: `${src.split('/').pop()} loop` });
  return true;
}

/**
 * THE CARD IS UP. Safe to call with nothing uploaded (it does nothing), before
 * the clips have decoded (preloadSplashBed picks it up), and on a page that has
 * never seen a gesture (see ensureChain).
 */
export function startSplashBed() {
  if (cfg().enabled === false) return;
  // No clips is the SHIPPED state, so this is the normal path rather than an
  // error one: nothing is built, nothing is unlocked, and the splash is exactly
  // as silent as it was before this file existed.
  if (!srcs().length) return;
  if (!ensureChain()) return;
  started = true;
  applySplashBedSettings();
  preloadSplashBed();
  if (!source) beginClip();
}

/**
 * THE CARD IS BREAKING UP. Fades the bed away and lets the source stop on the
 * far side of the fade.
 *
 * @param seconds override the configured fade — the Sound tab's Stop button
 *                wants an immediate one, the splash wants the tuned one.
 */
export function stopSplashBed(seconds) {
  started = false;
  if (!ctx || !fadeGain) return;
  const now = ctx.currentTime;
  const t = Math.max(0.05, seconds ?? cfg().fadeOut ?? 0.9);
  // cancelScheduledValues only drops events scheduled AT OR AFTER `now` — a
  // value curve already running keeps running to its end, and the ramp below
  // would then start from wherever that curve finished rather than from where
  // the bed actually is. Stopping the splash two seconds into a 2.6s fade-in is
  // the common case, so this is not a corner. cancelAndHoldAtTime is the one
  // that stops an in-flight curve dead and holds its value; Safari only grew it
  // recently, hence the fallback.
  if (fadeGain.gain.cancelAndHoldAtTime) fadeGain.gain.cancelAndHoldAtTime(now);
  else {
    fadeGain.gain.cancelScheduledValues(now);
    fadeGain.gain.setValueAtTime(fadeGain.gain.value, now);
  }
  fadeGain.gain.linearRampToValueAtTime(0, now + t);
  // A hair after the ramp lands. Stopping exactly on its end leaves the final
  // sample audible at whatever level that step held, which ticks.
  stopSource(now + t + 0.05);
}

/**
 * Tear it down for real. Used when the slot list changed under us and what is
 * playing is no longer something the config says should be playing.
 */
export function resetSplashBed() {
  stopSplashBed(0.05);
  stopSource(ctx?.currentTime ?? 0);
  playing = null;
}

/**
 * Push CONFIG.splashBed's level onto the live node. Safe to call while a fade is
 * in flight: volume lives on its own gain, which no fade curve ever touches.
 */
export function applySplashBedSettings() {
  if (!ensureChain()) return;
  const c = cfg();
  volumeGain.gain.setTargetAtTime(
    c.enabled === false ? 0 : Math.max(0, c.volume ?? 0.3),
    ctx.currentTime,
    0.05,
  );
}

// --- introspection, for the Sound tab and the Node harness ------------------

export function splashBedState() {
  return {
    started,
    clips: srcs(),
    loaded: srcs().filter((s) => buffers.has(s)).length,
    playing: source ? playing : null,
    sounding: !!(ctx && soundsUntil > ctx.currentTime),
    // A suspended context is the expected state on the splash before the first
    // press, not a fault — worth being able to see from outside so "I can't
    // hear it" can be told apart from "it isn't running".
    suspended: ctx?.state === 'suspended',
  };
}
