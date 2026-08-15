// ============================================================================
// XP SPILL — the arithmetic behind "one mouthful, one card".
//
// XP arrives as one INDIVISIBLE orb per kill. Every multiplier in the economy
// scales that orb against the CREATURE — its toughness, its mass, the food
// chain it was swallowed inside — and nothing scales it against the LADDER it
// lands on. For ordinary wildlife the two never diverge enough to notice; for a
// boss they diverge completely. Measured off the shipped tables, a first boss
// drops 410-543 xp into rungs that cost 44, 64, 91, 150, 245: three levels in
// one swallow, five with a live chain, and playtest/runs.jsonl has the receipts
// — six upgrade cards stamped at one identical timestamp, twice.
//
// The answer is not to pay the boss less. It is to stop paying it all in one
// frame. Everything past the allowance is held in a reserve and fed back into
// the bar linearly, so the levels still arrive — every point of them — spread
// across the swim away from the kill.
//
// Both functions here are PURE, and that is the whole reason this is a module
// rather than two closures in main.js: the lumpiness of the ladder is a claim
// about arithmetic, and tools/xp-economy-test.mjs can only hold the shipped
// code to it if the shipped code is reachable without booting a game. main.js
// owns the two mutable numbers and nothing else.
// ============================================================================

import { xpForNextLevel } from './config.js';

/**
 * The most xp that can be taken right now without crossing more than `levels`
 * thresholds: the gap to the next level, plus each whole rung after it.
 *
 * Walks the ladder with the same xpForNextLevel the level-up loop does rather
 * than approximating the curve — the two disagreeing is a level that arrives an
 * orb early, or a reserve that can never empty.
 *
 * @param {{level: number, xp: number, xpToNext: number}} state  the live bar
 * @param {number} levels  thresholds this swallow is allowed to cross
 * @returns {number} xp, never negative
 */
export function xpAllowance(state, levels) {
  let allowance = state.xpToNext - state.xp;
  let level = state.level;
  let next = state.xpToNext;
  for (let i = 1; i < Math.max(1, Math.round(levels)); i++) {
    level += 1;
    next = xpForNextLevel(level, next);
    allowance += next;
  }
  return Math.max(0, allowance);
}

/**
 * One frame of the reserve paying itself in, linearly across what is left of
 * its window.
 *
 * The whole remainder goes out on the last step rather than a proportional
 * slice, so a rounding crumb cannot keep a reserve alive at a millionth of a
 * point per frame — and the returned reserve is snapped to zero the moment
 * either the xp or the window is spent, so "is there a spill" stays a single
 * comparison at the call site.
 *
 * @param {number} reserve      xp still owed
 * @param {number} secondsLeft  window remaining
 * @param {number} dt           gameplay seconds this frame
 * @returns {{pay: number, reserve: number, secondsLeft: number}}
 */
export function spillStep(reserve, secondsLeft, dt) {
  if (!(reserve > 0)) return { pay: 0, reserve: 0, secondsLeft: 0 };
  const step = Math.min(Math.max(0, dt), secondsLeft);
  const pay = step < secondsLeft ? reserve * (step / secondsLeft) : reserve;
  let left = secondsLeft - step;
  let rest = reserve - pay;
  if (!(rest > 1e-6) || !(left > 0)) {
    rest = 0;
    left = 0;
  }
  return { pay, reserve: rest, secondsLeft: left };
}
