import { CONFIG } from '../config.js';
import { getAudioContext, getSfxBus, isAudioLive } from './audio.js';
import { buildBank, tearDownBank } from './noiseRiser.js';

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

// THE BANK ITSELF is systems/noiseRiser.js — the noise, the sweep and the
// band-building, shared with the chunk's vacuum riser. What stays here is the
// ENVELOPE and the keying, which is the whole difference between the two: this
// one climbs and is CUT by the landing, and that one arrives and settles.

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
 * Silence one card's riser. `key` is whatever was passed to start — the card
 * element, in ui.js. Safe for a key that never had one, which is the common
 * case: igniteStep chokes unconditionally and the reel arrival never starts a
 * riser at all.
 */
export function stopCardRiser(key, fade) {
  const v = voices.get(key);
  if (!v) return false;
  voices.delete(key);
  tearDownBank(v, fade ?? CONFIG.upgradeSlam?.riser?.fadeOut ?? 0.035);
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

  // THE BANK — systems/noiseRiser.js. `spread` is rolled PER END inside it, so
  // a trigger varies how far each band TRAVELS and not just where it sits; it
  // sits on top of the shared transpose above, which is why it wants to be the
  // smaller of the two numbers.
  //
  // The sources are stopped well past the fall rather than on it: every path
  // that starts one also chokes it, but "every path" includes the menu being
  // torn down mid-fall, and a looping source with nothing holding a reference
  // to it plays forever.
  const { sources, filters } = buildBank(ctx, {
    bands, dur, now, out: gain, mod, transpose,
    spread: vary.spread ?? 0,
    reverse,
    stopAt: now + dur + 0.6,
  });

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
