// ===========================================================================
// THE SCORE CORAL — a window where everything you kill is worth several times
// what it was.
// ===========================================================================
// Every other floating pickup changes how the fight GOES: a breath of air, a
// full strike meter, a faster gun, a deeper card. This one changes nothing
// about the fight at all. It is worth exactly as much as what you do with the
// seconds it gives you, which makes it the only pickup in the game that is a
// question rather than a gift — take it and then go and find something big, or
// take it while you are running away and it was worth nothing.
//
// ONE ROLL DECIDES BOTH NUMBERS, AND THEY PULL OPPOSITE WAYS. `t` runs 0..1:
// at 0 it is a small multiplier for a long time, at 1 a huge one for a few
// seconds. So the two ends are roughly worth the same and the choice they
// pose is different — a 2x for twenty-five seconds is a run of ordinary
// fighting quietly paying double, and a 10x for five is a sprint at whatever
// is biggest on screen. Two independent rolls would have made a 10x-for-25s
// that is worth twelve times either end, and it would arrive at random.
//
// THE ROLL IS VISIBLE BEFORE IT IS TAKEN. The size of the coral in the water
// is the multiplier it is carrying (see spawnScoreOrb), the same promise the
// chum chunk's size makes about its heal — so "is that one worth swimming for"
// is a question the player answers by looking, not by taking it and finding
// out.
//
// IT DOES NOT STACK, IT REPLACES — and it replaces only upward. Taking a 3x
// while a 9x is running would be a pickup that punished you for collecting it,
// which is the one thing a pickup may never be; taking a 9x while a 3x is
// running takes the 9x and its own clock. An equal or smaller multiplier
// refreshes the TIME instead, so the second coral is never simply thrown away.
//
// WHERE IT LANDS: main.js multiplies banked points by scoreMul() at every
// place score is added. NOT inside computeKillPoints — that function is about
// what a creature is worth, and this is about when you killed it.
//
// Numbers: CONFIG.scorePickup. The gameplay half of them lives in
// spawning.csv, with the rest of the pacing.
// ===========================================================================

import { CONFIG } from '../config.js';

const cfg = () => CONFIG.scorePickup ?? {};

// The live window. `mult` is 1 whenever `left` is 0, and both are written
// together — a multiplier left behind on an expired window is a run scoring
// triple forever with nothing on screen saying so.
const state = { mult: 1, left: 0, total: 0 };

/**
 * Roll one coral: how big and how long.
 *
 * Pure and exported because the DISTRIBUTION is the balance decision. `bias`
 * shapes where the roll lands the same way the chum chunk's does — above 1 it
 * piles up at the small end, so a 10x is rare and a 3x is common — and the
 * only honest way to check "the big ones are rare" is to run this a few
 * thousand times and look at the histogram, which tools/score-coral-test.mjs
 * does.
 */
export function rollScoreBoost(rand = Math.random, c = cfg()) {
  const t = Math.pow(Math.max(0, Math.min(1, rand())), Math.max(0.01, c.bias ?? 1));
  const mult = (c.multMin ?? 2) + ((c.multMax ?? 10) - (c.multMin ?? 2)) * t;
  // Duration runs the other way — see the header. `1 - t`, not a second roll.
  const seconds = (c.secondsMax ?? 25) + ((c.secondsMin ?? 5) - (c.secondsMax ?? 25)) * t;
  return {
    t,
    // WHOLE NUMBERS. The multiplier is printed on the HUD as `x7`, and a 6.83
    // rounded for display while 6.83 is what the score actually uses is a
    // readout that quietly disagrees with the scoreboard. Rounding it here
    // makes the number on screen the true one.
    mult: Math.max(1, Math.round(mult)),
    seconds: Math.max(0.5, seconds),
  };
}

/**
 * Start (or extend) a window. Returns what is now running, so the caller can
 * announce it.
 *
 * See the header for why a smaller multiplier arriving mid-window refreshes
 * the clock rather than replacing the number.
 */
export function startScoreBoost(mult, seconds) {
  if (!(mult > 1) || !(seconds > 0)) return { mult: state.mult, left: state.left };
  if (state.left > 0 && mult <= state.mult) {
    // The weaker one still buys time, and buys it against ITS OWN duration
    // rather than topping up to the bigger one's — a 2x is not allowed to hand
    // a live 9x another twenty-five seconds.
    state.left = Math.max(state.left, seconds);
    state.total = Math.max(state.total, state.left);
    return { mult: state.mult, left: state.left };
  }
  state.mult = mult;
  state.left = seconds;
  state.total = seconds;
  return { mult: state.mult, left: state.left };
}

/** One frame. `dt` is the water's clock — a window is a window in game time. */
export function updateScoreBoost(dt) {
  if (state.left <= 0) return;
  state.left -= dt;
  if (state.left <= 0) {
    state.left = 0;
    // Written together with the clock, always — see the note on `state`.
    state.mult = 1;
    state.total = 0;
  }
}

/**
 * What to multiply points by right now. 1 when nothing is running, so every
 * call site is `points * scoreMul()` with no branch.
 */
export function scoreMul() {
  return state.left > 0 ? state.mult : 1;
}

/** The readout's view: the number, the seconds left, and how full the clock is. */
export function scoreBoostState() {
  return {
    mult: state.left > 0 ? state.mult : 1,
    left: state.left,
    frac: state.total > 0 ? Math.max(0, Math.min(1, state.left / state.total)) : 0,
  };
}

/** A run starting or ending. */
export function resetScoreBoost() {
  state.mult = 1;
  state.left = 0;
  state.total = 0;
}
