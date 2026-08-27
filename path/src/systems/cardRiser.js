import { CONFIG } from '../config.js';
import { getAudioContext, getSfxBus, isAudioLive } from './audio.js';

// ---------------------------------------------------------------------------
// THE CARD RISER — the buildup under one card falling into its cell.
// ---------------------------------------------------------------------------
// A riser is a sound whose whole job is to be interrupted: it climbs under the
// thing you are waiting for and the arrival takes the room off it. This one
// starts as a card is thrown and is cut on the frame it lands, so the pop and
// the tier's sting fall into the hole it leaves rather than onto a tail still
// climbing.
//
// WHY IT IS NOT A CONFIG.sfx VOICE, which is what it was until now. Everything
// in that table is a one-shot — a buffer or an oscillator, an envelope, a
// decay, gone — and a one-shot cannot be told how long the thing it is scoring
// takes. The old `cardRiser` was a `boom` with `decay: 1.1` under a fall of
// 0.26s, with a comment explaining that the length was deliberately wrong
// because being cut early is better than running out. That is true of a fixed
// sound and unnecessary of this one: the fall's length is known at the moment
// the card is thrown, so every sweep is scheduled across exactly it and lands
// on the frame of impact. Retune `upgradeSlam.time` and the riser retunes with
// it, because it is reading the same number the animation is.
//
// NO TONE. There were two saws in here and they are gone rather than turned
// down, because a riser made of pitched material is a NOTE that gets brighter:
// the ear locks onto the fundamental and hears the filter as timbre. Noise has
// nothing to lock onto, so the same sweep is heard as movement — which is the
// only thing this sound has to say. It also stops the riser colliding with the
// tier stings, which ARE pitched and are the payoff it is building to.
//
// SO: A BANK OF SWEPT NOISE BANDS. One looping noise source per band through
// its own resonant bandpass, each climbing its own range across the fall, mixed
// by level. Three of them by default and the code does not care how many:
//
//   a wide low band     the weight the saws used to carry — a wash of air with
//                       no pitch in it
//   a mid band          the body of the movement
//   a narrow top band   the whistle, which is the part that actually reads as
//                       "climbing" and the part a fall this short has time for
//
// The mixer between them IS the sound design. A riser is three of these at
// different levels far more often than it is any one of them.

// ONE SECOND OF WHITE NOISE, generated once and looped by every band.
//
// Cached against the context rather than the module: audio.js can hand back a
// new context after a reset, and a buffer from a dead one throws on connect.
// Generated rather than loaded because a second of noise is a second of noise —
// there is nothing to author, and a sample would be 170KB of it. Shared across
// bands and across voices; a BufferSource is a cheap read head over it, not a
// copy.
let noiseCache = null;
function loopNoise(ctx) {
  if (noiseCache?.ctx === ctx) return noiseCache.buf;
  const frames = Math.max(1, Math.floor(ctx.sampleRate));
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  noiseCache = { ctx, buf };
  return buf;
}

// key -> voice. A Map rather than a list so a landing can silence its OWN
// riser: with three cards in the air, "stop the newest" and "stop the oldest"
// are both wrong on the frame the middle one lands.
const voices = new Map();

// A ceiling on how many can sound at once. Three is the hand, and this is the
// backstop for a hand that grew or a menu that reopened over itself — a stuck
// source is silent until there are forty of them, and then it is a wall.
const MAX_VOICES = 6;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * THE SWEEP, WITH ITS CURVE AND ITS WOBBLE, scheduled up front.
 *
 * All three of these could be nodes — an LFO into the filter's frequency, a
 * second LFO onto its rate — and they are one scheduled curve instead for a
 * reason worth keeping: an accelerating wobble needs its PHASE integrated, and
 * an oscillator whose frequency is being ramped does not do that (it jumps).
 * Written as points, the phase is a running sum and the acceleration is exact.
 * It is also the only shape that can be asserted in a test without a real
 * audio graph, and everything below is scheduled once with no per-frame work.
 *
 * `steps` is resolution, not shape. It has to clear a couple of points per
 * wobble cycle or the wobble aliases into a wrong, slower one.
 */
function scheduleSweep(param, from, to, dur, now, mod) {
  const steps = clamp(Math.round(mod.steps ?? 48), 2, 512);
  // THE SKEW. 1 is the plain exponential — even in octaves, which is even to
  // the ear. Under 1 the sweep opens early and hangs at the top; over 1 it
  // holds low and rushes the last third, which is the one that reads as an
  // approach rather than as a slide.
  const curve = Math.max(0.05, mod.curve ?? 1);
  const depth = Math.max(0, mod.wobbleDepth ?? 0);
  const rFrom = Math.max(0, mod.wobbleFrom ?? 0);
  const rTo = Math.max(0, mod.wobbleTo ?? rFrom);

  param.setValueAtTime(from, now);
  const ratio = to / from;
  let phase = 0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const prev = (i - 1) / steps;
    let f = from * ratio ** (t ** curve);
    if (depth > 0) {
      // Rate at the midpoint of the step, integrated into a running phase, so
      // a wobble that speeds up stays continuous instead of clicking.
      const rate = rFrom + (rTo - rFrom) * ((t + prev) / 2);
      phase += rate * (t - prev) * dur * Math.PI * 2;
      // ...under a sine window, zero at both ends. A wobble still going at the
      // landing leaves the band somewhere other than where it was aimed, and
      // the whole point of this module is arriving exactly on the impact. Most
      // unstable in the middle, clean into the hit.
      f *= 2 ** ((depth * Math.sin(phase) * Math.sin(Math.PI * t)) / 12);
    }
    param.linearRampToValueAtTime(Math.max(20, f), now + t * dur);
  }
}

function tearDown(v, fade) {
  const { ctx, gain, sources } = v;
  try {
    const now = ctx.currentTime;
    const out = Math.max(0.005, fade);
    gain.gain.cancelScheduledValues(now);
    // setValueAtTime first: without it the ramp starts from whatever value was
    // last *scheduled* rather than from what is actually sounding, so a riser
    // cut mid-swell jumps to its peak for the length of the fade — which on an
    // impact-timed choke is the one frame you would hear it.
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + out);
    // Every band is a LOOPING buffer, so these are the nodes that genuinely
    // never end on their own. Forgetting them is silent rather than loud — the
    // shared gain has already closed — which is how a leak like this survives
    // to forty of them.
    for (const s of sources) s.stop(now + out + 0.02);
  } catch {
    // A context that went away underneath us (tab suspended, audio reset).
    // Nothing to clean up the GC won't take, and throwing here would take the
    // card's landing down with it.
  }
}

/**
 * Silence one card's riser. `key` is whatever was passed to start — the card
 * element, in ui.js. Safe for a key that never had one, which is the common
 * case: igniteStep chokes unconditionally and the reel arrival never starts a
 * riser at all.
 */
export function stopCardRiser(key, fade) {
  const v = voices.get(key);
  if (!v) return false;
  voices.delete(key);
  tearDown(v, fade ?? CONFIG.upgradeSlam?.riser?.fadeOut ?? 0.035);
  return true;
}

/** Every riser down. The menu closing, a second level-up, a run reset. */
export function stopAllCardRisers(fade) {
  const all = [...voices.keys()];
  for (const k of all) stopCardRiser(k, fade);
  return all.length;
}

/**
 * Start the bank under one falling card.
 *
 * `seconds` is HOW LONG THAT CARD IS IN THE AIR — `upgradeSlam.time`, the same
 * number written into `--sv-slam-len` for the CSS. Every band is scheduled
 * across exactly it, so they all arrive at their ceilings on the frame the card
 * arrives in its cell, with no per-frame work.
 *
 * Returns true if a voice is actually sounding — which no caller needs and the
 * harness does.
 */
export function startCardRiser(key, seconds) {
  stopCardRiser(key, 0.005);

  const cfg = CONFIG.upgradeSlam?.riser ?? {};
  if (cfg.enabled === false) return false;
  // Not an error and not worth a warning: audio is locked until the player's
  // first gesture. The hand still lands, silently.
  if (!isAudioLive()) return false;

  const ctx = getAudioContext();
  const master = getSfxBus();
  if (!ctx || !master) return false;

  const bands = (cfg.bands ?? []).filter((b) => b && (b.level ?? 0) > 0);
  // Every fader down is a deliberate silence, not a broken riser.
  if (!bands.length) return false;

  // Oldest first, so the backstop drops the riser that has been climbing
  // longest rather than the one that just started.
  while (voices.size >= MAX_VOICES) stopCardRiser(voices.keys().next().value, 0.02);

  const now = ctx.currentTime;
  const dur = Math.max(0.04, seconds ?? CONFIG.upgradeSlam?.time ?? 0.26);
  const buf = loopNoise(ctx);

  // --- WHAT MAKES THIS TRIGGER DIFFERENT FROM THE LAST ONE ------------------
  // Three cards a level-up and twenty level-ups a run is sixty of these, and
  // sixty identical risers stop being a sound and become a tic. Rolled ONCE per
  // trigger and shared down the bank, so the thing that varies is the riser
  // rather than the bands' relationship to each other — a bank whose members
  // each wandered off independently is a different, worse sound every time
  // instead of the same sound in a different mood.
  //
  // NOTHING HERE VARIES THE TIMING. The length is the fall and is not
  // negotiable; register, spread, weight and the wobble's speed all are.
  const vary = cfg.vary ?? {};
  const jitter = (amt) => 1 + (Math.random() * 2 - 1) * Math.max(0, amt ?? 0);
  // The whole bank transposed together, in semitones. This is the one that does
  // most of the work: same gesture, different register.
  const transpose = 2 ** (((Math.random() * 2 - 1) * Math.max(0, vary.pitch ?? 0)) / 12);
  // ...and one factor for BOTH wobble rates, so a bank that varies its speed
  // keeps its acceleration. Two rolls would sometimes invert it.
  const wobbleMul = jitter(vary.wobble);

  const reverse = cfg.reverse === true;
  const mod = {
    steps: cfg.steps, curve: cfg.curve,
    wobbleDepth: cfg.wobbleDepth,
    wobbleFrom: (cfg.wobbleFrom ?? 0) * wobbleMul,
    wobbleTo: (cfg.wobbleTo ?? 0) * wobbleMul,
  };

  // THE SHARED ENVELOPE, which every band mixes into. Level, swell, attack and
  // the choke all live here rather than per band, so moving a fader changes the
  // BALANCE and never the shape — which is what makes the mixer a mixer.
  const gain = ctx.createGain();
  const peak = Math.max(0, (cfg.gain ?? 0.14) * jitter(vary.level));
  // FADE-IN IS A FRACTION OF THE FALL, not a number of seconds. A fixed attack
  // that is right for a two-second boss arrival never reaches its own level
  // inside a quarter-second card fall; as a share, a fall retuned from 0.26 to
  // 0.6 keeps its shape.
  const attack = clamp(cfg.fadeIn ?? 0.3, 0.005, 0.95) * dur;
  // ...and it keeps climbing after the attack. Bands opening their filters at a
  // flat level is a sweep; the swell is what makes it a build.
  const swell = Math.max(0, cfg.swell ?? 1.6);
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(peak, now + attack);
  gain.gain.linearRampToValueAtTime(peak * swell, now + dur);
  gain.connect(master);

  const sources = [];
  const filters = [];
  for (const b of bands) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    // Each band reads the loop from its own offset, so three bands are three
    // different noises rather than one noise heard through three filters —
    // which correlates them and thins the whole bank out.
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    // Q is per band and has to be: a wide low wash and a narrow top whistle are
    // the same node with two very different numbers in it, and that difference
    // is most of what distinguishes the three.
    band.Q.value = Math.max(0.0001, b.q ?? 4);
    // THE ENDPOINTS, and the two things that move them.
    //
    // `spread` is rolled PER END rather than per band, so a trigger varies how
    // far each band travels and not just where it sits. It is on top of the
    // shared transpose above, which is why it wants to be the smaller number:
    // this one is what stops the three bands moving in lockstep, and past a
    // little of it they stop being the same three bands.
    //
    // NO CLAMP FORCING `to` ABOVE `from`. There was one, and it quietly made a
    // descending band impossible while the panel's own tooltip claimed you
    // could have one. A band that falls under two that climb is a real sound,
    // and `reverse` below is the whole bank doing it at once.
    let from = (b.from ?? 140) * transpose * jitter(vary.spread);
    let to = (b.to ?? 5200) * transpose * jitter(vary.spread);
    if (reverse) { const t = from; from = to; to = t; }
    // Audible range only. A transpose that pushed the top band past Nyquist
    // would not throw — it would silently drop that band out of the mix, which
    // reads as the variation "sometimes not working".
    from = clamp(from, 20, 18000);
    to = clamp(to, 20, 18000);
    scheduleSweep(band.frequency, from, to, dur, now, mod);

    // THE FADER, and its entry. `at` is a fraction of the fall — a band that
    // comes in late is the cheapest way to make a short riser feel like it has
    // stages, and it costs nothing but a scheduled point.
    const lvl = ctx.createGain();
    const at = clamp(b.at ?? 0, 0, 0.95) * dur;
    const level = Math.max(0, b.level ?? 1);
    if (at > 0) {
      lvl.gain.setValueAtTime(0, now);
      lvl.gain.setValueAtTime(0, now + at);
      lvl.gain.linearRampToValueAtTime(level, now + at + Math.min(0.06, (dur - at) * 0.4));
    } else {
      lvl.gain.value = level;
    }

    src.connect(band).connect(lvl).connect(gain);
    // A random read offset into the loop, for the decorrelation above. The
    // buffer is a full second and a fall is a fraction of one, so no band ever
    // reaches the seam.
    src.start(now, Math.random() * 0.5);
    // A hard backstop on the source's life. Every path that starts one also
    // stops it, but "every path" includes the menu being torn down mid-fall,
    // and a looping source with nothing holding a reference to it plays forever.
    src.stop(now + dur + 0.6);
    sources.push(src);
    filters.push(band);
  }

  voices.set(key, { ctx, gain, sources, filters, dur, startedAt: now });
  return true;
}

/** How many risers are sounding. For the harness, and for the F panel's own
 *  readout of whether the thing it is tuning is actually running. */
export function cardRiserCount() {
  return voices.size;
}

/** The scheduled span of a live riser, and how many bands it built. For a test
 *  that wants to assert the sweep was aimed at the landing rather than at a
 *  fixed decay. */
export function cardRiserSpan(key) {
  const v = voices.get(key);
  return v ? { dur: v.dur, startedAt: v.startedAt, bands: v.filters.length } : null;
}
