#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run chain:trace
//
// THE FOOD CHAIN, DRIVEN IN main.js's ORDER, PRINTED AS THE GAME WOULD PRINT IT.
//
// Every other harness in this repo calls the strike system directly, which is
// what makes them good at proving the RULES are right and useless at the thing
// being asked here: whether the rules, wired together in the order the frame
// loop actually runs them, produce the chain a player expects. The two are not
// the same question and the gap between them is exactly where this mechanic
// has gone wrong twice.
//
// So this replays the release path as main.js sequences it —
//
//   updateCharge(dt, held)      the wind-up burns fuel into banked power
//   tryStrike(dir, stats)       ...on the frame the button comes UP, with
//                               `held` already false (input.js drops the level
//                               and raises the edge on the same frame)
//   gulp -> collectChum         the swallow the sealed mouth was holding back
//   updateStrike(dt)            the window's clock, the lapse
//
// and prints systems/chainTrace.js's own lines — the SAME text the in-game
// overlay shows on C. A player's screenshot and a run of this can be put side
// by side, which is the only way to tell "the rules are wrong" from "the rules
// are right and I am 40ms early".
//
// Four scenarios, one per way the chain can fail, so the shape of a working
// log and the shape of each broken one are on screen together.
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import { CONFIG } from '../path/src/config.js';
import {
  strikeState, resetStrike, updateCharge, tryStrike, updateStrike, feedChum,
  strikeLoaded, sweetHalfWidth, sweetOffset, consumeChainLink, liveChain, cancelDash,
} from '../path/src/systems/strike.js';
import { setChainTrace, chainTraceText, clearChainTrace } from '../path/src/systems/chainTrace.js';

const stats = {
  strikeChumRefill: CONFIG.strike.charge.chumRefill,
  strikeChargeTime: CONFIG.strike.charge.time,
  strikeDashDuration: CONFIG.strike.dashDuration,
  strikeDashSpeed: CONFIG.strike.dashSpeed,
  strikeChainMul: CONFIG.strike.chainDamageMul,
  strikeDamage: CONFIG.strike.damage,
};

const DT = 1 / 240;          // finer than a frame: the window is 100ms wide
const DIR = { x: 1, y: 0 };
const step = (n = 1) => { for (let i = 0; i < n; i++) updateStrike(DT, null, { x: 0, y: 0 }, stats, [], {}); };

/**
 * A wind-up and a release, sequenced the way the frame loop sequences them.
 *
 * `late` is seconds past the STRIKE NOW! moment to sit on the button before
 * letting go. The release frame runs updateCharge with held FALSE first,
 * exactly as main.js does — that ordering is load-bearing and is the one thing
 * a harness calling tryStrike on its own cannot exercise.
 */
function release(late = 0) {
  fillTank();
  let guard = 0;
  while (!strikeLoaded() && guard++ < 20000) updateCharge(DT, true, stats);
  for (let t = 0; t < late - 1e-9; t += DT) updateCharge(DT, true, stats);
  updateCharge(DT, false, stats);        // the release frame, held already down
  return tryStrike(DIR, stats);
}

/**
 * EAT UNTIL THERE IS FUEL TO WIND UP WITH — and every scenario has to, because
 * the run opens on an EMPTY tank (charge.startPips is 0) and holding burns fuel
 * it does not have.
 *
 * Without this the wind-up above banks nothing, `pending` never reaches
 * minFire, and tryStrike returns false having recorded no release at all. Four
 * of the five scenarios below silently fired NOTHING and printed a log of
 * "no window open" misses — which is what a working strike with no chum looks
 * like, so the harness read as evidence about the chain while testing a strike
 * that never happened.
 */
function fillTank() {
  let guard = 0;
  while (strikeState.charge < 1 - 1e-6 && guard++ < 100) { feedChum(stats); consumeChainLink(); }
}

/** The gulp, or a swum-over orb — both land on feedChum, one mouthful each. */
function eat(n = 1) {
  for (let i = 0; i < n; i++) { feedChum(stats); consumeChainLink(); }
}

function scenario(title, body) {
  clearChainTrace();
  resetStrike();
  setChainTrace(true);
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
  body();
  console.log(chainTraceText());
  console.log(`  => chain ended at x${liveChain()}`);
  setChainTrace(false);
}

const half = sweetHalfWidth(stats);
console.log(`\nsweet spot  +/-${Math.round(half * 1000)}ms around STRIKE NOW!`
  + `   (charge.time ${CONFIG.strike.charge.time}s x sweetFraction ${CONFIG.strike.charge.sweetFraction})`);
console.log(`a link      ${CONFIG.strike.linkMinPips} mouthful for the first,`
  + ` +${CONFIG.strike.linkPipsPerLink} per link already held`);
console.log(`the window  ${CONFIG.strike.chainWindow}s without food`);
console.log(`the banner  from x${CONFIG.strike.foodChain.bannerFrom}`);

scenario('ON THE BEAT, THEN EATING — what it is supposed to look like', () => {
  release();
  eat(1); step(12);
  eat(1); step(12);
  eat(1); step(12);
  cancelDash();
});

scenario('EARLY — let go while the bar still had fuel in it', () => {
  // Wound up to a hair inside the window's leading edge, then released a whole
  // window early. Fires, dashes, arms nothing.
  fillTank();
  let guard = 0;
  while (sweetOffset() < -half * 2.5 && guard++ < 20000) updateCharge(DT, true, stats);
  updateCharge(DT, false, stats);
  tryStrike(DIR, stats);
  eat(2); step(12);
  cancelDash();
});

scenario('LATE — sat on a loaded wind-up', () => {
  release(half * 3);
  eat(2); step(12);
  cancelDash();
});

scenario('ON THE BEAT BUT NO FOOD REACHED THE SEAL', () => {
  release();
  cancelDash();
  step(Math.ceil((CONFIG.strike.chainWindow + 0.1) / DT));
  eat(1);
});

scenario('THE WINDOW LAPSING MID-CHAIN, THEN A FRESH STRIKE', () => {
  release();
  eat(2); step(12);
  cancelDash();
  step(Math.ceil((CONFIG.strike.chainWindow + 0.1) / DT));
  eat(1);                                  // nothing: the arming died with it
  release();                               // eats its own fuel back, see fillTank
  eat(1);
  cancelDash();
});

console.log('');
