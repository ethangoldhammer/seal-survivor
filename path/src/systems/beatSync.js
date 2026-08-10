import { CONFIG } from '../config.js';
import { BEAT_DIVISIONS, divisionBeatsIn, nearestDivisionIn } from '../beatDivisions.js';
import { beatDuration, beatPhase, currentBpm } from './music.js';

// ============================================================================
// BEAT SYNC — one musical clock that every time-driven shader reads from.
//
// THE PROBLEM. A dozen shaders in this game animate on their own private
// clock, each with a rate in radians or cycles per SECOND: the lanternfish
// breathes at 2.4 rad/s, the grass sways at 1.1, the bakalar beam's bands
// travel at 0.55. Every one of those numbers was picked by eye, and every one
// of them is very slightly out of time with the loop that is playing. Nothing
// looks broken; the whole screen just never quite agrees with itself.
//
// THE FIX is not to hand-tune those numbers until they happen to line up —
// they'd come apart again the moment the BPM moved, and the death dive drags
// the tape down by design. It's to stop expressing rates in seconds at all.
// An FX names a musical DIVISION ('1/8', '1 bar', '2 bars') and this file
// answers "how many cycles of that division have gone by", derived from the
// same transport position the music player and the beat-synced animation
// already share. Change the BPM and everything retimes together, for free.
//
// WHAT COUNTS AS QUANTISABLE. A time term that feeds a sin() is a PHASE: it
// repeats, so "one cycle per bar" means something. A time term that feeds a
// translation — the pattern drift in biolumSkin, the caustics in water.js, the
// aura swirls — is DRIFT: it never comes back round, so there is no cycle to
// put on a grid. Those stay in seconds on purpose. Every call site here is a
// sin().
//
// THE FALLBACK CLOCK. music.beatPhase() returns 0 until the audio context has
// been unlocked, which on this game is "until the player has clicked once" —
// and the start menu has glowing creatures on it. Reading it directly would
// freeze every synced FX on the menu. So this keeps its own beat counter,
// ticked at the configured BPM, and SNAPS it to the transport whenever the
// transport is live. One number, correct in both worlds; the only cost is a
// single phase jump on the frame the music starts, behind the menu.
// ============================================================================

// The table and the arithmetic over it live in ../beatDivisions.js — a leaf
// with no imports, so config.js can build the tuner's picker and its readouts
// from the same list this file interprets, without the two importing each
// other. What is left here is everything that needs the LIVE clock: CONFIG,
// the transport, the tempo as it is actually being heard.
export { BEAT_DIVISIONS };

export function beatsPerBar() {
  return Math.max(1, CONFIG.beatSync?.beatsPerBar ?? 4);
}

function syncEnabled() {
  return CONFIG.beatSync?.enabled !== false;
}

/** Beats per cycle of `division`. 0 means "free" — no grid, run at own rate. */
export function divisionBeats(division) {
  return divisionBeatsIn(division, beatsPerBar());
}

/** One cycle of `division` in seconds, at the tempo currently AUDIBLE. */
export function divisionSeconds(division) {
  const beats = divisionBeats(division);
  return beats > 0 ? beats * beatDuration() : 0;
}

// --- the transport ---------------------------------------------------------

// Beats since playback started — or since boot, while nothing is playing. Read
// once per frame by updateBeatSync and cached, so a hundred materials asking
// the same question get one answer rather than a hundred trips through the
// audio clock.
let transport = 0;

/**
 * Carry the beat clock to now. Call ONCE per frame, before anything that reads
 * it — main.js does this immediately ahead of the FX updates.
 *
 * Raw dt, matching every FX that reads this: a creature's own light, and the
 * current moving the grass, have no business stopping because the game froze
 * for 60ms on a hit.
 */
export function updateBeatSync(rawDt) {
  const musical = beatPhase();
  // >0 is the liveness test music.js itself documents: beatPhase returns a
  // flat 0 until the context is unlocked and playback has actually begun.
  if (musical > 0) transport = musical;
  else transport += rawDt / Math.max(0.001, beatDuration());
}

/** Beats elapsed on the grid. Fractional; the whole part is which beat. */
export function beatsNow() {
  return transport;
}

/** The tempo everything here is measured against, for readouts. */
export function syncBpm() {
  return currentBpm();
}

/**
 * Advance one FX's cycle counter by a frame.
 *
 * This is the whole API most callers need. It hides the one thing that is easy
 * to get wrong: a SYNCED cycle is derived absolutely from the transport (which
 * is what keeps it locked to the grid however long the run goes, and however
 * much the tempo has moved), while a FREE one is integrated from its own
 * previous value (which is what stops a rate change teleporting it).
 *
 * @param prev     the caller's stored cycle count from last frame
 * @param division a BEAT_DIVISIONS name; 'free' or unknown = unquantised
 * @param freeRate cycles per second to use when free — a rate in rad/s divides
 *                 by 2π to get here
 * @param rawDt    seconds since the last frame
 * @param wrap     the modulus to keep the result inside. MUST be a whole
 *                 number of the consuming shader's periods, or the wrap shows
 *                 up as a visible jump: a shader reading both `c` and `c*0.5`
 *                 needs wrap 2, one reading only `c` can use 1.
 * @returns the new cycle count, in [0, wrap)
 */
export function advanceCycles(prev, division, freeRate, rawDt, wrap = 1) {
  const beats = syncEnabled() ? divisionBeats(division) : 0;
  const next = beats > 0 ? transport / beats : prev + rawDt * freeRate;
  const w = Math.max(1e-6, wrap);
  return next - Math.floor(next / w) * w;
}

/**
 * The per-individual phase offset, in cycles.
 *
 * WHY IT IS QUANTISED TOO. A school of forty fish all breathing in unison
 * reads as one animal with forty bodies, so the offset has to exist. But a
 * CONTINUOUS random offset puts every individual a random fraction of a cycle
 * off the grid — which is exactly the thing the division picker just spent all
 * this machinery removing. Snapping each fish to one of `steps` slots keeps
 * them apart AND keeps every one of them on a beat: at '1 bar' with 4 steps, a
 * school breathes on the four beats of the bar, in whatever order they
 * happened to be born in. That reads as a section, not as mush.
 *
 * `steps` 0 restores the continuous offset, which is the right answer for a
 * drift-like FX and the wrong one for anything that pulses.
 *
 * @param seed01 the individual's stable random number, 0..1
 * @param spread 0 collapses the school into lockstep, 1 uses the whole cycle
 * @param steps  slots per cycle; 0 = continuous
 */
export function phaseOffset(seed01, spread = 1, steps = 0) {
  const seed = ((seed01 % 1) + 1) % 1;
  const n = Math.max(0, Math.round(steps));
  const q = n > 0 ? Math.floor(seed * n) / n : seed;
  return q * (spread ?? 1);
}

/**
 * The musical division closest to a cycle authored in seconds, at the tempo
 * currently audible. The bridge from every hand-tuned rad/sec in the config to
 * a name on the grid — and what the tuner suggests beside a picker still set
 * to 'free'.
 */
export function nearestDivision(seconds) {
  return nearestDivisionIn(seconds, beatDuration(), beatsPerBar());
}

/**
 * A one-line description of what a division currently costs in real time —
 * what the tuner prints under the picker so "1 bar" is a duration you can
 * judge rather than a word you have to convert in your head.
 */
export function describeDivision(division, freeRate = 0) {
  if (!syncEnabled()) return 'sync off — free';
  const secs = divisionSeconds(division);
  if (secs > 0) return `${division} · ${secs.toFixed(2)}s`;
  if (freeRate > 0) return `free · ${(1 / freeRate).toFixed(2)}s`;
  return 'free';
}
