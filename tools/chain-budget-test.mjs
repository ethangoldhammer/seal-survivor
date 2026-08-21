#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:budget
//
// A CHAIN GROWS BY AT MOST ONE BARFUL PER STRIKE.
//
// The rule: a link is a PIP OF FUEL going into the meter, not a mouthful going
// down. So eating the bar up from empty pays a link per pip, filling it pauses
// the chain however much food is left in the water, and the pause lifts when
// another charged release spends the bar and buys the next barful.
//
// What this is for: the chain used to be a function of how much chum happened
// to be nearby — a magnet sweep over a pile was thirty links in one frame, and
// the run logs have a 313-deep chain in them. The cap is the loop the system is
// named after, made mandatory.
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import { CONFIG } from '../path/src/config.js';
import {
  strikeState, resetStrike, updateCharge, tryStrike, updateStrike, feedChum,
  restoreCharge, strikeLoaded, consumeChainLink, liveChain, cancelDash,
  chainStrike, pipCount, pipValue,
} from '../path/src/systems/strike.js';

const stats = {
  strikeChumRefill: CONFIG.strike.charge.chumRefill,
  strikeChargeTime: CONFIG.strike.charge.time,
  strikeDashDuration: CONFIG.strike.dashDuration,
  strikeDashSpeed: CONFIG.strike.dashSpeed,
  strikeDamage: CONFIG.strike.damage,
};
const DT = 1 / 60;
const DIR = { x: 1, y: 0 };
const PIPS = pipCount(stats);

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails++;
};
const eat = (n = 1) => { let got = 0; for (let i = 0; i < n; i++) { feedChum(stats); if (consumeChainLink()) got++; } return got; };
const tick = (s) => { for (let t = 0; t < s; t += DT) updateStrike(DT, null, { x: 0, y: 0 }, stats, [], {}); };

/** A wind-up carried to a full charge and released. `early` lets go short. */
function strike({ early = false } = {}) {
  let guard = 0;
  if (early) {
    const floor = CONFIG.strike.charge.minFire ?? 0.35;
    while (strikeState.charge > 0 && strikeState.pending < floor + 0.02 && guard++ < 5000) {
      updateCharge(DT, true, stats);
    }
  } else {
    while (!strikeLoaded() && guard++ < 5000) updateCharge(DT, true, stats);
  }
  updateCharge(DT, false, stats);
  return tryStrike(DIR, stats);
}
/** Fill the tank WITHOUT feeding, so a test about the bar can move it alone. */
const fillTank = () => { strikeState.charge = 1; };

console.log(`\nTHE BAR IS ${PIPS} PIPS, SO A CYCLE IS WORTH ${PIPS} LINKS\n`);
resetStrike();
fillTank();
strike();
check('a charged release funds a whole bar', strikeState.pipBudget === PIPS, `${strikeState.pipBudget}`);
check(`eating the bar up from empty pays a link per pip`, eat(PIPS) === PIPS);
check(`  ...and the chain is exactly x${PIPS}`, liveChain() === PIPS, `x${liveChain()}`);
check('  ...with the bar now full', strikeState.charge >= 1);

console.log('\nAND A FULL BAR PAUSES IT — however much food is left');
const heldAt = liveChain();
const extra = eat(12);
check('twelve more mouthfuls into a full bar score nothing', extra === 0, `${extra} links`);
check('  ...the chain is held, not broken', liveChain() === heldAt, `x${liveChain()}`);
check('  ...and the multiplier is held with it', strikeState.chainPips === PIPS, `${strikeState.chainPips} pips`);
// THE PAUSE IS NOT A TIMER. Eating during it still holds the window open — a
// player finishing a pile with a maxed bar is doing the right thing.
check('  ...and eating still holds the window open',
  strikeState.chainTimer > 0, `${strikeState.chainTimer.toFixed(2)}s`);

console.log('\nANOTHER CHARGED RELEASE RE-OPENS IT');
strike();
check('the strike re-funds the bar', strikeState.pipBudget === PIPS, `${strikeState.pipBudget}`);
check(`  ...and the next barful pays another ${PIPS}`, eat(PIPS) === PIPS);
check(`  ...so the chain is x${PIPS * 2}`, liveChain() === PIPS * 2, `x${liveChain()}`);
cancelDash();

console.log('\nA FUMBLED WIND-UP BUYS NOTHING — the bar refills and pays nothing');
// LETTING GO EARLY NEEDS FUEL STILL IN THE TANK, and that is not a detail of
// the test — it is the definition. A wind-up begun on a nearly-empty bar runs
// the tank dry, and a dry tank IS a loaded wind-up (`left` hits zero, see
// updateCharge), so it is a perfect charge however little it banked. The only
// way to fumble is to let go while there was more to bank.
resetStrike();
fillTank();
strike();                      // a good one, to open a chain
eat(PIPS);                     // ...spend the whole allowance, bar now full
const before = liveChain();
strike({ early: true });       // let go with fuel still in the tank
check('an early release banks enough to fire', strikeState.power > 0, `${strikeState.power.toFixed(2)}`);
check('  ...but funds no budget', strikeState.pipBudget === 0, `${strikeState.pipBudget}`);
check('  ...so refilling the bar pays nothing', eat(PIPS) === 0);
check('  ...and the chain sits where it was', liveChain() === before, `x${liveChain()} vs x${before}`);
// ...and a proper strike after the fumble puts it right, so a fumble costs a
// cycle rather than the chain.
strike();
check('  ...until a charged release re-opens it', eat(1) === 1, `x${liveChain()}`);
cancelDash();

console.log('\nA MAGNET SWEEP CANNOT OUTSPEND THE BUDGET');
// The case the cap exists for: a whole pile handed over inside one frame.
resetStrike();
fillTank();
strike();
let swept = 0;
for (let i = 0; i < 40; i++) { feedChum(stats); if (consumeChainLink()) swept++; }
check(`forty orbs in one frame pay ${PIPS}, not forty`, swept === PIPS, `${swept} links`);
cancelDash();

console.log('\nTHE BLUE ORB IS FUEL, NOT A COMBO TOOL');
resetStrike();
fillTank();
strike();
const orbLinks = (restoreCharge(stats), consumeChainLink());
check('a charge orb pays exactly one link, not a barful', orbLinks === 1, `${orbLinks}`);
check('  ...and it filled the bar, so eating after it scores nothing', eat(4) === 0);
cancelDash();
// ...and one caught during the pause cannot re-open it.
resetStrike();
fillTank();
strike();
eat(PIPS);
const during = (restoreCharge(stats), consumeChainLink());
check('an orb caught during the pause scores nothing', during === 0, `${during}`);
cancelDash();

console.log('\nTHE OTHER CHAIN SOURCES ARE OUTSIDE THE BUDGET');
// Porpoising and a wiped school are not food and do not answer to the bar.
resetStrike();
fillTank();
strike();
eat(PIPS);                     // budget spent, bar full
const breached = chainStrike('breach');
check('a breach still links while the bar is maxed', breached > 0, `x${breached}`);
const wiped = chainStrike('schoolWipe');
check('  ...and so does a wiped school', wiped > breached, `x${wiped}`);
cancelDash();

console.log('\nAND THE WINDOW LAPSING CLEARS EVERYTHING');
resetStrike();
fillTank();
strike();
eat(2);
strikeState.active = false;
tick(CONFIG.strike.chainWindow + 0.1);
check('the chain is gone', liveChain() === 0);
check('  ...and the arming with it', strikeState.armed === false);
fillTank();
check('  ...so food alone cannot restart it', eat(PIPS) === 0);

console.log(fails ? `\n${fails} FAILED\n` : '\nall good\n');
process.exit(fails ? 1 : 0);
