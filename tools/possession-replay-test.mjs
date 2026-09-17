#!/usr/bin/env node
// ============================================================================
// npm run test:possession — THE POSSESSION BAR'S REPLAY, end to end without a
// browser: the marks the match lays down (systems/versusTally.js) and the
// clock that reads them back (ui/possessionReplay.js).
//
// The page itself cannot be imported outside a browser — ui/statsCard.js pulls
// in the Rive runtime and a `?url` of a binary — which is the whole reason the
// clock is a file of its own. What is checked here is what would otherwise be
// checked by watching a bar move and guessing:
//
//   1. the marks are the running totals, evenly spaced, and BOUNDED however
//      long the match ran.
//   2. the replay ENDS ON THE LEDGER'S OWN NUMBERS. The bar and the figure
//      printed beside it are the same two properties, so a replay that came to
//      rest a fraction off would print a percentage the match never reported.
//   3. it runs at the speed it says. A match replayed at 5x takes a fifth of
//      the match, plus the beat before it starts.
//   4. it moves BOTH WAYS — the point of the whole thing. A match one side led
//      and then lost is a bar that goes out and comes back, and the check is
//      that the replay's middle is not simply on the way to its end.
// ============================================================================

import { resetTally, accrueTallyPossession, tallySnapshot, tallyTimeline }
  from '../path/src/systems/versusTally.js';
import { setRosterSize } from '../path/src/systems/sealRoster.js';
import { makePossessionReplay } from '../path/src/ui/possessionReplay.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const section = (t) => console.log(`\n${t}`);

/** Play `seconds` of match at 60fps with `holder` on the ball. -1 is nobody. */
function play(seconds, holder) {
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(seconds / dt); i++) accrueTallyPossession(dt, holder);
}

setRosterSize(1);

// ---------------------------------------------------------------- the marks
section('the ledger');
resetTally();
// Seat 0 is the left side, seat 1 the right (teamOfSeat is `i % TEAMS`).
play(20, 0);          // left owns the opening
play(10, -1);         // ...then nobody, which is play but not possession
play(30, 1);          // ...then the right side, for longer

const tl = tallyTimeline();
const snap = tallySnapshot();
check('the replay clock counts unheld play', near(tl.seconds, 60, 0.02), `${tl.seconds.toFixed(2)}s`);
check('the marks are evenly spaced',
  tl.points.every((p, i) => near(p.t, (i + 1) * tl.step, 1e-6)),
  `${tl.points.length} marks, step ${tl.step}`);
check('every mark is a share of 100',
  tl.points.every((p) => near(p.left + p.right, 100, 1e-9)));
check('the first mark is all one side', near(tl.points[0].left, 100, 1e-9),
  `${tl.points[0].left.toFixed(1)}%`);
check("the last mark is the ledger's number",
  Math.abs(tl.points[tl.points.length - 1].left - snap.teams[0].possession) < 1,
  `${tl.points.at(-1).left.toFixed(2)} vs ${snap.teams[0].possession.toFixed(2)}`);

// THE UNHELD STRETCH DOES NOT MOVE THE SHARE, but it does move the clock. A
// mark inside it reads the same share as the mark before it — which is the
// bar standing still while a loose ball is chased, and is correct.
const at = (t) => tl.points.reduce((best, p) => (p.t <= t + 1e-9 ? p : best), tl.points[0]);
check('a loose ball holds the bar still', near(at(22).left, at(28).left, 1e-9),
  `${at(22).left.toFixed(2)} vs ${at(28).left.toFixed(2)}`);

// BOUNDED. Fifteen minutes is the longest match the rules allow
// (MAX_SECONDS in systems/matchRules.js) and it must not cost more marks than
// a short one — the step doubles instead.
resetTally();
play(900, 0);
const long = tallyTimeline();
check('a fifteen-minute match is bounded', long.points.length <= 900,
  `${long.points.length} marks at step ${long.step}`);
check('...by widening the step, not by dropping the end',
  near(long.points[long.points.length - 1].t, 900, long.step),
  `last mark ${long.points.at(-1).t}s of ${long.seconds.toFixed(0)}s`);
check('...and the marks are still evenly spaced',
  long.points.every((p, i) => near(p.t, (i + 1) * long.step, 1e-6)));

// ---------------------------------------------------------------- the clock
section('the replay');
resetTally();
play(30, 0);   // the left side leads the first half outright
play(30, 1);   // ...and the right takes the second, evening it up
const even = tallyTimeline();
const evenSnap = tallySnapshot();
const final = { left: evenSnap.teams[0].possession, right: evenSnap.teams[1].possession };
const replay = makePossessionReplay({
  points: even.points, seconds: even.seconds, final, speed: 5, delay: 0.35,
});

check('the match runs back at 5x, after the beat',
  near(replay.duration, 0.35 + even.seconds / 5, 0.05),
  `${replay.duration.toFixed(2)}s of page for ${even.seconds.toFixed(1)}s of match`);
check('a different speed is a different length',
  near(makePossessionReplay({ points: even.points, seconds: even.seconds, final, speed: 1, delay: 0 })
    .duration, even.seconds, 0.05));

check('it holds the opening frame through the beat',
  replay.at(0).left === replay.at(0.3).left && !replay.at(0.3).done);
const end = replay.at(replay.duration + 1);
check("it comes to rest on the ledger's own pair",
  end.left === final.left && end.right === final.right && end.done,
  `${end.left.toFixed(4)} / ${end.right.toFixed(4)}`);
check('...and stays there', replay.at(replay.duration * 4).left === final.left);

// THE SWING. Halfway through the page's clock is halfway through the match,
// where the left side had owned the ball outright — so the bar is a long way
// out from where it ends, and comes back to it. A bar that only ever
// approached its final number would pass every check above this one.
const mid = replay.at(0.35 + (even.seconds / 2) / 5);
check('the bar swings out and comes back',
  mid.left > final.left + 20 && mid.left > 70,
  `middle ${mid.left.toFixed(1)}%, end ${final.left.toFixed(1)}%`);

// It is a replay, not an ease: a quarter of the way through the match the
// left side has had all of it, so the bar is pinned, not a quarter of the way
// to the answer.
const quarter = replay.at(0.35 + (even.seconds / 4) / 5);
check('...and is the match, not a curve towards the answer',
  quarter.left > 95, `${quarter.left.toFixed(1)}% a quarter in`);

// A REPLAY WITH NOTHING IN IT is the closing number and is done on the first
// frame — a match that ended before a single mark was laid down, which is what
// the page showed before any of this existed.
const empty = makePossessionReplay({ points: [], seconds: 0, final, speed: 5, delay: 0.35 });
check('no marks is the closing number, immediately',
  empty.at(0).done && empty.at(0).left === final.left);

console.log(`\n${failures ? `${failures} FAILED` : 'all good'}`);
process.exit(failures ? 1 : 0);
