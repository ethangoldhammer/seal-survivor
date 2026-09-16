// ============================================================================
// HOW A MATCH ENDS — first to a number of goals, or a clock running out.
//
// A LEAF, AND RUNTIME STATE RATHER THAN CONFIG, for the reason systems/
// sealRoster.js is: the tuner snapshots whole CONFIG sections on any slider
// edit, so a setting written there would ship as next week's default the first
// time anybody touched a goal light. What a match is played to is a fact about
// tonight's match. CONFIG holds the DEFAULTS these open on and nothing else.
//
// TWO WAYS TO WIN, AND THE SAME MATCH EITHER WAY. Nothing about the ball, the
// seals, the goals or the kickoff changes — the only difference is which
// question is being asked at the end of a goal:
//
//   GOALS   first side to `toWin`. The match ends on the goal that reaches it,
//           which is why it ends mid-celebration: the goal IS the result.
//   TIMED   the clock runs down and the side ahead at zero wins. A goal at 4-3
//           is a goal; the whistle is what makes it a win.
//
// A DRAW IS A REAL RESULT and only a timed match can produce one, which is the
// whole reason `winnerOf` hands back -1 rather than defaulting to a side. A
// first-to-five cannot end level by construction.
//
// THE CLOCK IS THE MATCH'S, not the wall's. It counts down on versusState.clock
// — the dilated one — so it crawls through a goal's shutter and stops dead
// under a replay, which is what a match clock does and not a thing anybody has
// to write: the stoppage is already in the clock.
// ============================================================================

import { CONFIG } from '../config.js';

const cfg = () => CONFIG.versus ?? {};

// What the team select last set, or null while nothing has. Held apart from the
// defaults rather than seeded from them, for the reason sealRoster's `chosen`
// exists: without it a reset cannot tell "nobody has chosen" from "somebody
// chose the same number the default happens to be", and it would quietly undo
// the screen on the way into the match.
let goals = null;
let timed = null;
let seconds = null;

/** Goals a side needs to win, when the match is played to goals. */
export function goalsToWin() {
  return goals ?? Math.max(1, Math.round(cfg().toWin ?? 5) || 5);
}

/**
 * Set it, and hand back what it actually became. Clamped, and the caller
 * re-reads rather than assuming — a request the clamp refused has to be
 * visibly refused rather than silently ignored.
 */
export function setGoalsToWin(n) {
  goals = Math.max(MIN_GOALS, Math.min(MAX_GOALS, Math.round(n) || 1));
  return goals;
}

// One is a golden goal and is a perfectly good short match; the ceiling is
// where a match stops being a match and becomes an evening.
export const MIN_GOALS = 1;
export const MAX_GOALS = 15;

/** Is this a timed match rather than a first-to? */
export function isTimed() {
  return timed ?? (cfg().timed === true);
}

export function setTimed(on) {
  timed = !!on;
  return timed;
}

/** Seconds on the clock, when the match is timed. */
export function matchSeconds() {
  return seconds ?? Math.max(MIN_SECONDS, Math.round(cfg().matchSeconds ?? 180));
}

export function setMatchSeconds(s) {
  seconds = Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, Math.round(s / STEP_SECONDS) * STEP_SECONDS));
  return seconds;
}

// Stepped in half minutes, because a control that moves a match clock one
// second at a time is a control nobody uses twice.
export const STEP_SECONDS = 30;
export const MIN_SECONDS = 30;
export const MAX_SECONDS = 900;

/**
 * WHO HAS WON, given the scores — or -1 for nobody yet, and -2 for a draw.
 *
 * `over` says whether the match is finished; `winner` says who by. They are two
 * answers because a timed match that has run out LEVEL is over with no winner,
 * and a caller that had to infer "over" from "winner >= 0" would play on
 * forever on a draw.
 *
 * @param scores   [team0, team1]
 * @param left     seconds still on the clock, for a timed match
 */
export function matchResult(scores, left = Infinity) {
  const a = scores[0] ?? 0;
  const b = scores[1] ?? 0;
  if (isTimed()) {
    if (left > 0) return { over: false, winner: -1, draw: false };
    if (a === b) return { over: true, winner: -1, draw: true };
    return { over: true, winner: a > b ? 0 : 1, draw: false };
  }
  const need = goalsToWin();
  if (a >= need) return { over: true, winner: 0, draw: false };
  if (b >= need) return { over: true, winner: 1, draw: false };
  return { over: false, winner: -1, draw: false };
}

/** Everything the screen and the harness want, in one read. */
export function matchRules() {
  return { timed: isTimed(), goals: goalsToWin(), seconds: matchSeconds() };
}

/** Forget the picks — a new session, or a test that wants CONFIG's answer. */
export function forgetMatchRules() {
  goals = null;
  timed = null;
  seconds = null;
}
