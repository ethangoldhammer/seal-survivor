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
// AND THE SHARE OVER TIME, not only at the whistle. The stats page replays the
// possession bar across the match, so the ledger keeps a MARK every
// `MARK_STEP` seconds of play — the running totals as they stood — and the
// share at any moment is read off those. A running total rather than a share
// per mark on purpose: a share is a division, and dividing at write time would
// decide a denominator per mark that the next mark disagrees with. The marks
// are sums; the reader divides once.
//
// BOUNDED, whatever the clock is set to. `MARK_CAP` marks is the ceiling and
// the step DOUBLES rather than the list growing, so a fifteen-minute match
// costs exactly what a three-minute one does at half the resolution.
//
// NOTHING HERE IS A LOOK, so none of it is tunable and none of it reads CONFIG.
// ============================================================================

import { TEAMS, teamOfSeat, rosterSize } from './sealRoster.js';
import { MAX_PER_SIDE } from './versusFlag.js';

const SEATS = MAX_PER_SIDE * TEAMS;

const zero = () => new Array(SEATS).fill(0);

/** Seconds of play between marks, and the most marks that are ever kept. */
const MARK_STEP = 0.25;
const MARK_CAP = 900;

const tally = {
  goals: zero(),
  assists: zero(),
  saves: zero(),
  // Seconds of play with the ball last touched by this seat.
  held: zero(),
  // Seconds of play in total, held by somebody. NOT the match clock: a ball in
  // flight that nobody has touched since the kickoff belongs to no seat.
  heldTotal: 0,
  // Seconds of PLAY, held or not — the x-axis the marks below are laid on.
  // Not `heldTotal` and not the match clock: the replay wants the time the
  // players were playing, which is neither the time the ball was owned nor the
  // time the whistle ran.
  play: 0,
  // The running per-SIDE totals, sampled. `t` is play seconds, `a`/`b` the two
  // sides' held seconds as they stood at that moment.
  marks: { step: MARK_STEP, next: MARK_STEP, t: [], a: [], b: [] },
};

/** Wipe it. Called from startVersus, beside the scores. */
export function resetTally() {
  tally.goals.fill(0);
  tally.assists.fill(0);
  tally.saves.fill(0);
  tally.held.fill(0);
  tally.heldTotal = 0;
  tally.play = 0;
  tally.marks = { step: MARK_STEP, next: MARK_STEP, t: [], a: [], b: [] };
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
 *
 * AN UNHELD FRAME STILL COUNTS AS PLAY. It is not possession for anybody — the
 * early return on `holder` is what keeps that true — but it is time the match
 * was being played, and the replay's clock has to include it or a ball loose
 * for ten seconds is ten seconds the bar skips over.
 */
export function accrueTallyPossession(dt, holder) {
  if (!(dt > 0)) return;
  tally.play += dt;
  if (valid(holder)) {
    tally.held[holder] += dt;
    tally.heldTotal += dt;
  }
  mark();
}

/**
 * Write down where the two sides stood, if this frame crossed a mark.
 *
 * A `while` rather than an `if`: one frame of a stalled tab is a dt of several
 * marks, and a mark list with a gap in it is a replay that jumps.
 *
 * The per-side sums are taken here rather than kept as two more running
 * counters because a seat's SIDE is `teamOfSeat`, which the roster owns — and
 * a second copy of that answer, updated per frame, is exactly the kind of
 * thing that stays right until the day the roster changes shape.
 */
function mark() {
  const m = tally.marks;
  if (tally.play < m.next) return;
  const a = teamSum(tally.held, 0);
  const b = teamSum(tally.held, 1);
  while (tally.play >= m.next) {
    m.t.push(m.next);
    m.a.push(a);
    m.b.push(b);
    m.next += m.step;
  }
  // THE LIST NEVER GROWS PAST THE CAP — the step doubles and every other mark
  // is dropped instead. Keeping the EVEN indices keeps a mark at every
  // multiple of the new step, so the list stays evenly spaced rather than
  // becoming a list of two alternating gaps.
  if (m.t.length > MARK_CAP) {
    const keep = (arr) => arr.filter((_, i) => i % 2 === 1);
    m.t = keep(m.t); m.a = keep(m.a); m.b = keep(m.b);
    m.step *= 2;
    m.next = m.t[m.t.length - 1] + m.step;
  }
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

/**
 * The share of the ball over the match, for the stats page's replay.
 *
 * SHARES, not the sums the ledger keeps: the division is done once, here,
 * against the total held AT THAT MOMENT rather than at the whistle — which is
 * what makes the last point equal the final percentage and every point before
 * it the number the page would have shown had the whistle gone then.
 *
 * A MOMENT NOBODY HAD THE BALL IS 50-50. It is the honest reading of a ball
 * that belongs to neither side, it is what the bar looks like before a kickoff,
 * and the alternative — 0 and 0 — is a bar that vanishes rather than one that
 * is evenly split. tallySnapshot() answers 0 and 0 for the same match because
 * it is reporting a FACT about the whole match; this is drawing a bar.
 *
 * `seconds` is the play time the last point sits at, which is the replay's
 * length before it is sped up.
 */
export function tallyTimeline() {
  const m = tally.marks;
  const points = [];
  for (let i = 0; i < m.t.length; i++) {
    const total = m.a[i] + m.b[i];
    const left = total > 0 ? (m.a[i] / total) * 100 : 50;
    points.push({ t: m.t[i], left, right: 100 - left });
  }
  return { step: m.step, seconds: tally.play, points };
}
