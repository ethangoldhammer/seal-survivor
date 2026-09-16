// ============================================================================
// THE MATCH'S LEDGER — what each seat did, kept per SEAT and totalled per side.
//
// The match already knew all four of these and threw three of them away. A
// goal calls creditGoal() and gets back the seat that scored and the seat that
// set it up; the save watch names the seat that cleared a shot that was on
// target; and the possession ledger knows who last touched the ball on every
// frame of play. Each of those was read once — for the goal card, for the
// highlight reel, for the ball's tint — and then dropped. This keeps them.
//
// PER SEAT, NOT PER SIDE, and that is the whole shape of it. A side's total is
// the sum of its seats and can always be recovered; a seat's own line cannot be
// recovered from a side's total. Four a side is coming (sealRoster.js), and a
// stats page that could only ever say "the orange team had five goals" would
// have to be rebuilt the day it arrives.
//
// POSSESSION IS TIME, NOT TOUCHES. A seal that taps the ball twelve times
// across the pitch has not had more of the ball than one that carried it the
// same distance in one long push — touches count dribbles, seconds count
// possession. The holder is whoever touched it last, which is exactly how
// versus.js's own ledger already thinks about it (see noteBallMomentum), so
// this asks that question once a frame rather than inventing a second answer.
//
// SECONDS, AND THE SHARE IS DERIVED. Storing a percentage would mean deciding
// the denominator at write time — and a ball nobody has touched yet belongs to
// nobody, so the denominator is not the match clock. `share()` divides by the
// time actually held, which is the only total the percentages can add up to.
//
// NOTHING HERE IS A LOOK, so none of it is tunable and none of it reads CONFIG.
// ============================================================================

import { TEAMS, teamOfSeat, rosterSize } from './sealRoster.js';
import { MAX_PER_SIDE } from './versusFlag.js';

const SEATS = MAX_PER_SIDE * TEAMS;

const zero = () => new Array(SEATS).fill(0);

const tally = {
  goals: zero(),
  assists: zero(),
  saves: zero(),
  // Seconds of play with the ball last touched by this seat.
  held: zero(),
  // Seconds of play in total, held by somebody. NOT the match clock: a ball in
  // flight that nobody has touched since the kickoff belongs to no seat.
  heldTotal: 0,
};

/** Wipe it. Called from startVersus, beside the scores. */
export function resetTally() {
  tally.goals.fill(0);
  tally.assists.fill(0);
  tally.saves.fill(0);
  tally.held.fill(0);
  tally.heldTotal = 0;
}

const valid = (seat) => Number.isInteger(seat) && seat >= 0 && seat < SEATS;

/**
 * A goal, as creditGoal() described it.
 *
 * An OWN GOAL is not a goal for the seat that put it in, and it is not one for
 * the side that got the point either — nobody on that side touched the ball.
 * So it is recorded as neither, and the side's goals will not add up to its
 * score. That is correct, and it is why the scoreline is read off
 * versusState.scores rather than off this.
 */
export function noteTallyGoal(credit) {
  if (!credit || credit.ownGoal) return;
  if (valid(credit.who)) tally.goals[credit.who] += 1;
  // -1 is "nobody assisted", which a one-a-side match can never have.
  if (valid(credit.assist) && credit.assist !== credit.who) tally.assists[credit.assist] += 1;
}

/** A shot cleared off the mouth of a seat's own goal. */
export function noteTallySave(seat) {
  if (valid(seat)) tally.saves[seat] += 1;
}

/**
 * A frame of play. `holder` is the seat that touched the ball last, or -1
 * while nobody has.
 */
export function accrueTallyPossession(dt, holder) {
  if (!(dt > 0) || !valid(holder)) return;
  tally.held[holder] += dt;
  tally.heldTotal += dt;
}

/** One side's total of a column. */
function teamSum(col, team) {
  let n = 0;
  for (let i = 0; i < rosterSize(); i++) if (teamOfSeat(i) === team) n += col[i];
  return n;
}

/**
 * The whole ledger, shaped for a reader.
 *
 * Possession comes back as a PERCENTAGE of the time anybody held the ball, and
 * the two sides' shares therefore sum to 100 — unless nobody ever touched it,
 * which is a 0-0 match that ended on the clock and reads as 0 and 0 rather
 * than as a spurious 50-50.
 */
export function tallySnapshot() {
  const n = rosterSize();
  const total = tally.heldTotal;
  const pct = (s) => (total > 0 ? (s / total) * 100 : 0);

  const seats = [];
  for (let i = 0; i < n; i++) {
    seats.push({
      seat: i,
      team: teamOfSeat(i),
      goals: tally.goals[i],
      assists: tally.assists[i],
      saves: tally.saves[i],
      possession: pct(tally.held[i]),
    });
  }

  const teams = [];
  for (let t = 0; t < TEAMS; t++) {
    teams.push({
      goals: teamSum(tally.goals, t),
      assists: teamSum(tally.assists, t),
      saves: teamSum(tally.saves, t),
      possession: pct(teamSum(tally.held, t)),
    });
  }

  return { seats, teams, held: total };
}
