import { CONFIG } from '../config.js';
import { getAudioContext, getSfxBus, isAudioLive, noteSfx } from './audio.js';
import { fetchAudioBytes } from './fetchAudio.js';

// The ambient bed: a handful of clips, one audible at a time, each looping
// until the next one is faded in UNDER it.
//
// Two decks rather than one source restarted. A single source can't overlap
// with itself, and overlap is the entire effect — the outgoing clip has to
// still be sounding while the incoming one arrives or the switch is a cut with
// a ramp painted on it. So the graph is:
//
//   deckA.src -> deckA.gain -\
//                             >-- bedGain -> SFX bus -> (filter, reverb, out)
//   deckB.src -> deckB.gain -/
//
// The deck gains carry ONLY the 0..1 crossfade shape and the bed gain carries
// ONLY the configured volume. Keeping those on separate nodes is what lets the
// tuner's volume slider move mid-crossfade: writing both onto one gain means a
// slider drag lands a setValueAtTime in the middle of a scheduled value curve,
// which either throws or tears the fade in half.
//
// Timing runs off the AUDIO clock, not the frame clock. Everything audible is
// scheduled ahead on ctx.currentTime and the poll below only decides WHEN to
// schedule the next one — so a dropped frame, a background tab or a long GC
// pause can delay the decision to switch but can never make an in-flight
// crossfade stutter.

let ctx = null;
let bedGain = null;
let decks = null; // [{ gain, source }, ...] — exactly two
let live = 0; // index into `decks` of the deck currently in front

const buffers = new Map(); // src string -> AudioBuffer

/** Decoded ambience in bytes — see systems/memoryCensus.js. */
export function ambientBankBytes() {
  let n = 0;
  for (const b of buffers.values()) n += (b?.length ?? 0) * (b?.numberOfChannels ?? 1) * 4;
  return n;
}
let loadRequested = false;
let started = false;
let pollTimer = null;
let switchAt = 0; // ctx time the next crossfade should be scheduled at
let lastIndex = -1; // which entry of srcs() the front deck is playing
let cycleCursor = -1; // round-robin position, used when shuffle is off

// Same transport-wide dilation the music and one-shots ride during the death
// dive. The bed is the slowest-moving thing in the mix, so it's also where a
// tape-drag reads most clearly.
let rateScale = 1;

export function setAmbientRateScale(scale, glide = 0.25) {
  rateScale = Math.max(0.05, Math.min(4, scale || 1));
  if (!ctx || !decks) return;
  for (const deck of decks) {
    if (!deck.source) continue;
    const target = Math.max(0.05, deck.baseRate * rateScale);
    if (glide > 0) deck.source.playbackRate.setTargetAtTime(target, ctx.currentTime, glide);
    else deck.source.playbackRate.setValueAtTime(target, ctx.currentTime);
  }
}

function cfg() {
  return CONFIG.ambient ?? {};
}

// The filled slots only. An empty slot is skipped rather than played as
// silence, so uploading two clips into slots 1 and 4 cycles between two clips
// instead of spending two thirds of the run in a hole.
function srcs() {
  return (cfg().srcs ?? []).filter(Boolean);
}

function ensureChain() {
  if (!ctx) ctx = getAudioContext();
  if (!ctx) return false;
  const bus = getSfxBus();
  if (!bus) return false;
  if (!bedGain) {
    bedGain = ctx.createGain();
    bedGain.gain.value = cfg().volume ?? 0.4;
    bedGain.connect(bus);
    // `node` is what a source connects to; `gain` is the AudioParam the fade
    // curves are written onto. Held as two fields rather than reaching through
    // `deck.node.gain` at every call site, because `x.gain.gain` reads as a
    // typo even when it isn't.
    decks = [0, 1].map(() => {
      const node = ctx.createGain();
      node.gain.value = 0;
      node.connect(bedGain);
      return { node, gain: node.gain, source: null, baseRate: 1 };
    });
  }
  return true;
}

// Fetch every configured clip once. Same load-with-fallback contract as
// CONFIG.sfx samples and the music loops: a clip that 404s or won't decode is
// logged and dropped from the rotation, and the bed carries on with whatever
// did load rather than going silent because one file moved.
export async function preloadAmbient() {
  if (loadRequested || !ensureChain()) return;
  loadRequested = true;
  const list = srcs();
  await Promise.all(list.map(async (src) => {
    if (buffers.has(src)) return;
    try {
      buffers.set(src, await ctx.decodeAudioData(await fetchAudioBytes(src)));
    } catch (err) {
      console.warn(`[ambient] could not load "${src}" —`, err?.message ?? err);
    }
  }));
  notifyClipsChanged();
  // start() may have run before any of this landed and found nothing to play.
  // Pick it up now instead of staying silent for the whole run.
  if (started && lastIndex < 0) beginFirstClip();
}

// The Sound tab builds its rows at boot, before any of the above has finished
// fetching — so a slot's "loaded" label is provisional and has to be refreshed
// when loading lands, the same way the SFX and music rows do it.
const clipListeners = new Set();
export function onAmbientClipsChanged(cb) {
  clipListeners.add(cb);
  return () => clipListeners.delete(cb);
}
function notifyClipsChanged() {
  for (const cb of clipListeners) cb();
}

export function hasAmbientClip(src) {
  return !!src && buffers.has(src);
}

// Decode an uploaded file straight into the rotation, so a clip can be
// auditioned before it has been written to disk as an asset.
export async function loadAmbientFromFile(src, file) {
  if (!ensureChain()) return false;
  try {
    buffers.set(src, await ctx.decodeAudioData(await file.arrayBuffer()));
    notifyClipsChanged();
    return true;
  } catch (err) {
    console.warn(`[ambient] could not decode "${file.name}" —`, err?.message ?? err);
    return false;
  }
}

export function clearAmbientClip(src) {
  buffers.delete(src);
  notifyClipsChanged();
}

// Re-fetch after the slot list changed in the tuner. Anything already decoded
// is kept — the point is to pick up what was ADDED, not to re-download the
// whole bed every time a slot moves.
export async function reloadAmbient() {
  loadRequested = false;
  await preloadAmbient();
}

// Which clip comes next. Never the same one twice running, which with two
// clips means strict alternation and with one means the single clip simply
// keeps looping (handled by the caller, which never schedules a switch at all
// in that case).
function pickNext() {
  const list = srcs();
  if (!list.length) return -1;
  if (list.length === 1) return 0;
  if (!cfg().shuffle) {
    cycleCursor = (cycleCursor + 1) % list.length;
    return cycleCursor;
  }
  let i = (Math.random() * list.length) | 0;
  if (i === lastIndex) i = (i + 1) % list.length;
  return i;
}

// A symmetric random multiplier around 1, clamped so an unlucky roll can never
// stop or reverse the tape. Same helper the one-shots use.
function vary(amount) {
  if (!amount) return 1;
  const a = Math.min(0.9, Math.abs(amount));
  return 1 + (Math.random() * 2 - 1) * a;
}

// How long the clip that just came to the front should hold before the next
// one is brought in. Never shorter than the crossfade itself plus a beat —
// a hold inside the fade would start the next switch while this one is still
// running, and the two value curves would collide on the same deck.
export function nextHold() {
  const c = cfg();
  const hold = Math.max(1, c.holdSeconds ?? 34) * vary(c.holdVary);
  return Math.max(hold, (c.crossfade ?? 7) * 2 + 1);
}

// Silence between one clip ending and the next beginning. Above zero the bed
// stops being a bed: each clip is a single APPEARANCE that fades up, plays once
// and fades away, and the water is quiet in between. See the note on
// CONFIG.ambient.gapSeconds for why that is a different system rather than a
// crossfade with a long gap in it.
function sporadic() {
  return (cfg().gapSeconds ?? 0) > 0;
}

// Whether this deck is still making sound at `at`. See stopDeck for why
// `deck.source` is the wrong question to ask.
function isSounding(deck, at) {
  return (deck.soundsUntil ?? 0) > at;
}

function nextGap() {
  const c = cfg();
  return Math.max(0, (c.gapSeconds ?? 0) * vary(c.gapVary));
}

function startDeck(deck, buffer, when, loop = true) {
  stopDeck(deck, when);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  // Looping is what fills a long hold with a short clip in continuous mode. In
  // sporadic mode it must NOT loop: a clip is heard once and then the water is
  // quiet, and a distinctive call repeated back-to-back is the one thing that
  // would make the whole effect read as a tape rather than as the sea.
  src.loop = loop;
  deck.baseRate = Math.max(0.05, vary(cfg().pitchVary));
  src.playbackRate.value = Math.max(0.05, deck.baseRate * rateScale);
  src.connect(deck.node);
  src.start(when);
  deck.source = src;
  deck.soundsUntil = Infinity;
}

// `deck.source` means "the source this deck would replace next", and stopDeck
// clears it the moment a stop is SCHEDULED — which is not the moment the sound
// ends. An appearance schedules its own stop up front (see beginAppearance), so
// by that measure every deck looks idle while a clip is still audibly playing.
// `soundsUntil` is the honest one: the ctx time this deck actually goes quiet.
// stopAmbient reads that rather than `source`, or a run ending mid-appearance
// would leave the clip playing over the score screen with nothing to fade it.
function stopDeck(deck, when = 0) {
  deck.soundsUntil = Math.min(deck.soundsUntil ?? 0, when);
  if (!deck.source) return;
  try { deck.source.stop(when); } catch { /* already stopped */ }
  const dying = deck.source;
  deck.source = null;
  // Disconnect on the far side of the stop rather than immediately — pulling
  // the node out of the graph while it is still sounding is exactly the click
  // the crossfade exists to avoid.
  dying.onended = () => { try { dying.disconnect(); } catch { /* gone */ } };
}

// Equal-power, as a sampled curve rather than a ramp. A LINEAR crossfade dips
// through the middle — the two clips are uncorrelated, so their powers add
// while their amplitudes are both at 0.5 — and that dip is audible as a hole
// in the bed every time it switches. cos/sin hold the total power flat.
function fadeCurve(rising, steps = 64) {
  const curve = new Float32Array(steps);
  for (let i = 0; i < steps; i++) {
    const t = (i / (steps - 1)) * (Math.PI / 2);
    curve[i] = rising ? Math.sin(t) : Math.cos(t);
  }
  return curve;
}

// Bring `index` in on the back deck and take the front deck out under it.
function crossfadeTo(index, at) {
  const list = srcs();
  const buffer = buffers.get(list[index]);
  if (!buffer) return false;

  const outgoing = decks[live];
  const incoming = decks[1 - live];
  const seconds = Math.max(0.05, cfg().crossfade ?? 7);

  startDeck(incoming, buffer, at);
  incoming.gain.cancelScheduledValues(at);
  incoming.gain.setValueAtTime(0, at);
  incoming.gain.setValueCurveAtTime(fadeCurve(true), at, seconds);

  if (outgoing.source) {
    outgoing.gain.cancelScheduledValues(at);
    outgoing.gain.setValueCurveAtTime(fadeCurve(false), at, seconds);
    // Held until the fade has fully landed. Stopping it AT the end of the
    // curve rather than a hair after leaves the last sample audible at
    // whatever level the curve's final step had, which ticks.
    stopDeck(outgoing, at + seconds + 0.05);
  }

  live = 1 - live;
  lastIndex = index;
  return true;
}

// One appearance: a clip fades up, plays through once, fades away, and nothing
// is left sounding. Everything is scheduled here in one go and then left alone
// — the poll below only comes back to decide when the NEXT one starts.
//
// Alternates decks even though only one is ever audible. Nothing forces that
// except a slider: drag `gap` to its minimum and two appearances can nearly
// touch, and on one deck their fade curves would land in the same window,
// which throws.
function beginAppearance(index, at) {
  const list = srcs();
  const buffer = buffers.get(list[index]);
  if (!buffer) return 0;

  const deck = decks[1 - live];
  startDeck(deck, buffer, at, false);
  // The audible length, not the buffer's — pitchVary is playback rate, so a
  // clip rolled slow is genuinely longer and its fade-out has to move with it.
  const playing = buffer.duration / Math.max(0.05, deck.baseRate * rateScale);
  // Both fades have to fit inside the clip with something left between them,
  // or the second value curve is scheduled into the first one's window.
  const fade = Math.max(0.02, Math.min(cfg().fadeSeconds ?? 1.8, playing / 2 - 0.02));

  deck.gain.cancelScheduledValues(at);
  deck.gain.setValueAtTime(0, at);
  deck.gain.setValueCurveAtTime(fadeCurve(true), at, fade);
  deck.gain.setValueCurveAtTime(fadeCurve(false), at + playing - fade, fade);
  // A hair after the fade has landed. Stopping exactly on the curve's end
  // leaves the final step audible at whatever level it held, which ticks.
  stopDeck(deck, at + playing + 0.05);

  live = 1 - live;
  lastIndex = index;
  // Sporadic ambience is the hardest thing in the mix to observe: it is quiet,
  // it is meant to be unnoticed, and it fires once every twenty-odd seconds. If
  // it stops working nobody finds out for a long time. The overlay makes each
  // appearance visible without making it audible.
  noteSfx('~ambient', 'note', {
    text: `${list[index].split('/').pop()} ${playing.toFixed(1)}s`,
  });
  return playing;
}

function beginFirstClip() {
  const index = pickNext();
  if (index < 0) return;
  const list = srcs();
  const buffer = buffers.get(list[index]);
  if (!buffer) return;
  const now = ctx.currentTime;
  const deck = decks[live];
  const seconds = Math.max(0.05, cfg().crossfade ?? 7);
  startDeck(deck, buffer, now + 0.02);
  deck.gain.cancelScheduledValues(now);
  deck.gain.setValueAtTime(0, now);
  // Faded in rather than dropped in at full level: the bed should already be
  // there by the time the player notices the run has started, which means it
  // must not arrive as an event.
  deck.gain.setValueCurveAtTime(fadeCurve(true), now + 0.02, seconds);
  lastIndex = index;
  if (cfg().shuffle === false) cycleCursor = index;
  switchAt = now + nextHold();
}

export function startAmbient() {
  if (cfg().enabled === false || !isAudioLive() || !ensureChain()) return;
  applyAmbientSettings();
  started = true;
  preloadAmbient();
  if (sporadic()) {
    // Nothing is sustained in this mode, so there is no state to resume into —
    // the next appearance IS the state. Scheduled a beat out rather than at
    // exactly `now` so the first poll after this call is the one that fires it.
    switchAt = ctx.currentTime + 0.05;
  } else if (lastIndex < 0) beginFirstClip();
  else {
    // Resuming after a stop faded the bed out: bring the front deck back up
    // rather than restarting on a fresh clip, so a restart doesn't reset the
    // ambience to the top of the rotation every single time.
    const now = ctx.currentTime;
    const deck = decks[live];
    if (!deck.source) beginFirstClip();
    else {
      deck.gain.cancelScheduledValues(now);
      deck.gain.setValueAtTime(deck.gain.value, now);
      deck.gain.setTargetAtTime(1, now, Math.max(0.05, (cfg().crossfade ?? 7) / 6));
      switchAt = now + nextHold();
    }
  }
  if (!pollTimer) pollTimer = window.setInterval(poll, 250);
}

// Fade the whole bed out and park it. Deliberately does NOT tear the decks
// down: stop and start bracket a death, and the run that follows should pick
// the ambience up where it left off rather than starting over.
export function stopAmbient() {
  started = false;
  if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
  if (!ctx || !decks) return;
  const now = ctx.currentTime;
  const seconds = Math.max(0.05, cfg().fadeOut ?? 1.6);
  for (const deck of decks) {
    if (!isSounding(deck, now)) continue;
    // cancelScheduledValues only drops events scheduled AT OR AFTER `now` — a
    // value curve that already started keeps running to its end, and the ramp
    // below would then be measured from wherever that curve left off rather
    // than from where the bed actually is. cancelAndHoldAtTime is the one that
    // stops an in-flight curve dead and holds its current value, which is
    // exactly what a fade-out wants to start from. Safari only grew it
    // recently, hence the fallback.
    if (deck.gain.cancelAndHoldAtTime) deck.gain.cancelAndHoldAtTime(now);
    else {
      deck.gain.cancelScheduledValues(now);
      deck.gain.setValueAtTime(deck.gain.value, now);
    }
    deck.gain.linearRampToValueAtTime(0, now + seconds);
  }
}

// Tear it down for real, sources and all. Used when the clip list itself
// changed under us and what's playing is no longer something the config says
// should be playing.
export function resetAmbient() {
  stopAmbient();
  if (!decks) return;
  const now = ctx?.currentTime ?? 0;
  for (const deck of decks) stopDeck(deck, now + (cfg().fadeOut ?? 1.6));
  lastIndex = -1;
  cycleCursor = -1;
}

// The only thing the poll decides is WHETHER to start the next clip; the fades
// themselves are scheduled on the audio clock and run without further help.
// 250ms is plenty — being a quarter second late to a 20-second silence is not
// something anyone can hear, and it keeps this off the frame budget.
function poll() {
  if (!started || !ctx) return;
  const now = ctx.currentTime;
  if (now < switchAt) return;

  if (sporadic()) {
    const index = pickNext();
    // Nothing decoded yet — try again shortly rather than wedging the schedule.
    if (index < 0) { switchAt = now + 2; return; }
    const playing = beginAppearance(index, now + 0.02);
    // A clip that never decoded returns 0; move on to a different one instead
    // of sitting silent for a whole gap on account of one missing file.
    switchAt = playing ? now + playing + nextGap() : now + 1;
    return;
  }

  // Continuous mode. One clip can't cross-fade with itself, and re-triggering
  // it on a timer would put a seam in a loop that doesn't otherwise have one.
  if (srcs().length < 2) return;
  const index = pickNext();
  if (index < 0 || index === lastIndex) { switchAt = now + nextHold(); return; }
  crossfadeTo(index, now);
  switchAt = now + nextHold();
}

// Push CONFIG.ambient onto the live nodes. Safe to call while a crossfade is
// in flight: volume lives on `bedGain`, which no fade curve ever touches.
export function applyAmbientSettings() {
  if (!ensureChain()) return;
  const c = cfg();
  bedGain.gain.setTargetAtTime(
    c.enabled === false ? 0 : Math.max(0, c.volume ?? 0.4),
    ctx.currentTime,
    0.05,
  );
}

// Force the next crossfade now rather than waiting out the hold. Only the
// tuner uses this — auditioning a 7-second crossfade is not worth a 34-second
// wait, and the wait is the reason the fade never got tuned before.
export function skipAmbientClip() {
  if (!started || !ctx) return;
  switchAt = ctx.currentTime;
  poll();
}

// --- introspection, for the tuner and the Node harness ---------------------

export function ambientState() {
  return {
    started,
    mode: sporadic() ? 'sporadic' : 'continuous',
    clips: srcs(),
    loaded: srcs().filter((s) => buffers.has(s)).length,
    playing: lastIndex >= 0 ? srcs()[lastIndex] : null,
    // In sporadic mode nothing is sounding between appearances, which is the
    // difference worth being able to see from outside.
    sounding: !!(ctx && decks?.some((d) => isSounding(d, ctx.currentTime))),
    secondsToNext: ctx && started ? Math.max(0, switchAt - ctx.currentTime) : 0,
  };
}
