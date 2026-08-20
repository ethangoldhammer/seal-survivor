#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:meter
//
// The boost meter — the pips under the seal, and the chain economy behind
// them. Every claim here is about a COUNT that has to come out whole: how many
// mouthfuls fill the bar, how many pips a chain link adds, what a blue orb is
// worth. A meter that is a tenth of a pip out looks perfect and pays wrong.
//
// The pip count is not a constant anywhere — it is derived from the refill per
// mouthful, so changing what a mouthful is worth silently changes how many
// segments the bar draws. That is the thing this file pins down: the derived
// count, the boundaries where a pip is booked, the floor it drains on, and the
// two ways a part-pip could round itself up into a whole one.
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CONFIG } from '../path/src/config.js';
import {
  installModel, createVisual, getAssetSizeMultiplier, setAssetSizeMultiplier,
} from '../path/src/assets.js';
import {
  strikeState, resetStrike, feedChum, updateStrike, restoreCharge,
  pipCount, pipValue, chumRefillMul, pendingPips, chainStrike, liveChain,
  chainLevel, chainDamageMul, comboSpeedMul, tryStrike, consumeStrikeLink, linkPips, cancelDash,
  updateCharge, perfectCrossed, strikeLoaded, inSweetSpot, sweetOffset, sweetHalfWidth,
  consumeChainLink,
  strikeBurst, riderDamage,
} from '../path/src/systems/strike.js';
import { magnetRadius, magnetSpeed, magnetDistance, magnetState, chumSweep, foodReach, foodPull } from '../path/src/systems/chumMagnet.js';
import { createStrikeRing, updateStrikeRing, resetStrikeRing } from '../path/src/systems/strikeRing.js';
import { updatePickups, resetPickups, spawnXpOrb } from '../path/src/entities/pickups.js';

// ============================================================================
// THE BOOST METER — the pip economy and the tick that reports it.
//
// What this pins is the property the whole rework exists for: ONE CHUM IS
// ALWAYS EXACTLY ONE PIP. The bar it replaced paid a compounding discount
// (0.20, then 0.164, then 0.134...) that nothing on screen explained, and the
// failure mode of a regression here is not a crash — it is a bar that fills at
// a rate the player cannot predict, which is invisible to every other test in
// the suite.
//
// Deliberately does NOT test the shader. A GLSL error renders nothing and
// throws nothing a Node harness can see (see tools/glow-audit.mjs and the
// note in systems/strikeRing.js); what is checkable here is the model.
// ============================================================================

let failures = 0;
let checks = 0;
function check(label, cond) {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL  ${label}`); }
  else console.log(`  ok    ${label}`);
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// A stat block shaped like recomputeStats' output. `strikeDashDuration` is not
// optional: tryStrike multiplies by it, and leaving it out makes the dash NaN
// seconds long — which never ends, so `active` sticks true and isFeeding()
// silently returns true for the rest of the file. A missing field here is a
// harness that props up the thing it is testing.
const stats = (refill = CONFIG.strike.charge.chumRefill) => ({
  strikeChumRefill: refill,
  strikeChargeTime: CONFIG.strike.charge.time,
  strikeDashDuration: CONFIG.strike.dashDuration,
  strikeDashSpeed: CONFIG.strike.dashSpeed,
  strikeChainMul: CONFIG.strike.chainDamageMul,
  // The release burst reads this, and the sweet spot section below asks it for
  // a damage number. Left out, an on-beat burst and an off-beat one both come
  // back as zero and the gate passes on nothing.
  strikeDamage: CONFIG.strike.damage,
});

// updateStrike wants a scene, a position and an enemy list; none are touched
// while no dash is active, which is every case below.
function tick(dt, hooks = {}) {
  updateStrike(dt, null, { x: 0, y: 0 }, stats(), [], hooks);
}

// A RUN OPENS ON A DEAD METER — CONFIG.strike.charge.startPips is 0, so the
// first thing a run has to do is eat. Almost every claim below is about what
// the bar does once there IS fuel in it, so they reset and then fill, and the
// fill is written out rather than assumed. See the opening-balance section at
// the bottom of the pip block for the claim about the 0 itself.
function fuelled() {
  resetStrike();
  strikeState.charge = 1;
}

console.log('\nPIP COUNT IS DERIVED FROM THE REFILL');
fuelled();
check('the default 0.2 refill is a five-pip bar', pipCount(stats(0.2)) === 5);
check('one pip is exactly one fifth', near(pipValue(stats(0.2)), 1 / 5));
// Coiled Spring: +0.04 per stack, four stacks. The card's own text promises
// "from 5 to 3", so this is the card being honest rather than an arbitrary
// ladder — if the rounding ever stops landing on 3 the card's copy is a lie.
check('one stack of Coiled Spring -> 4 pips', pipCount(stats(0.24)) === 4);
check('four stacks -> 3 pips, exactly as the card says', pipCount(stats(0.36)) === 3);

console.log('\nTHE BAR IS A FIXED LENGTH — nothing in a run can move it');
// IT USED TO GROW A PIP PER LINK, as the escalation that made each link dearer
// than the last. Both the job and the field are gone: a link is one mouthful
// now and is not bought with the bar at all — and the escalation could not
// have survived per-pip links anyway, because the count would have been a
// function of how much had been eaten while eating was the thing filling it.
// A six-pip bar took seven chum, which is exactly the unpredictability the
// pips were introduced to remove, arriving by a third route.
//
// So this sweeps every state that used to move it and insists none of them do.
fuelled();
const BAR = 5;   // a 0.2 refill is a five-pip bar
check('no chain -> base pips', pipCount(stats(0.2)) === BAR);
strikeState.chainTimer = CONFIG.strike.chainWindow;
for (const [links, pips] of [[1, BAR], [2, BAR * 2], [30, BAR * 30], [200, 1]]) {
  strikeState.chainCount = links;
  strikeState.chainPips = pips;
  check(`  x${links} off ${pips} mouthfuls is still ${BAR} pips`,
    pipCount(stats(0.2)) === BAR, `${pipCount(stats(0.2))} pips`);
}
fuelled();
check('and the ceiling still binds a derived count',
  pipCount(stats(0.001)) === CONFIG.strike.charge.maxPips);
check('chumRefillMul reports 1 with no chain', near(chumRefillMul(stats(0.2)), 1));

console.log('\nEXACTLY N MOUTHFULS FILL THE BAR — the whole point');
// Swept across EVERY pip count the game can produce, not just the default.
//
// This sweep is the test that matters, and the narrow version of it (three
// refills at chain depth 0) shipped a bug: a pip is 1/n, and n additions of
// 1/n do not reach 1 in floating point for most n. Six sixths land on
// 0.9999999999999999, so a six-pip bar silently took SEVEN chum. Only 5, 4 and
// 3 pips — exactly the three the narrow test happened to cover — summed
// cleanly. See snapToPip in systems/strike.js.
function orbsToFill(depth, refill = 0.2) {
  fuelled();
  strikeState.charge = 0;
  // Written directly rather than earned through chainStrike: the sources are
  // individually rate-limited, so building six real links here would be
  // testing the throttles instead of the fill. `depth` no longer changes the
  // pip count at all — it is swept anyway, because "the chain cannot move the
  // bar" is the property, and a sweep that only ever ran at depth 0 could not
  // see it break.
  strikeState.chainPips = depth * 5;
  strikeState.chainCount = depth;
  strikeState.chainTimer = depth > 0 ? CONFIG.strike.chainWindow : 0;
  let eaten = 0;
  while (strikeState.charge < 1 && eaten < 200) { feedChum(stats(refill)); eaten++; }
  return eaten;
}
let sweepBad = [];
for (let depth = 0; depth <= 14; depth++) {
  fuelled();
  strikeState.chainPips = depth * 5;
  strikeState.chainCount = depth;
  strikeState.chainTimer = depth > 0 ? CONFIG.strike.chainWindow : 0;
  const n = pipCount(stats(0.2));
  const eaten = orbsToFill(depth);
  if (eaten !== n) sweepBad.push(`depth ${depth}: ${n} pips but ${eaten} chum`);
}
check('every chain depth 0-14 fills in exactly its pip count',
  sweepBad.length === 0);
if (sweepBad.length) sweepBad.forEach((s) => console.log(`          ${s}`));

for (const refill of [0.2, 0.24, 0.36]) {
  fuelled();
  const n = pipCount(stats(refill));
  strikeState.charge = 0;
  let eaten = 0;
  while (strikeState.charge < 1 && eaten < 50) { feedChum(stats(refill)); eaten++; }
  check(`${n}-pip bar fills in exactly ${n} chum (refill ${refill})`, eaten === n);
  check(`  ...and lands exactly on full, not over`, near(strikeState.charge, 1, 1e-9));
}

console.log('\nA PART-PIP IS NEVER ROUNDED UP TO A WHOLE ONE');
// The snap must only ever repair a rounding error, never award free fuel. A
// bar burnt to an arbitrary level and then fed one chum has to land one pip
// higher than it was, not on the boundary above.
fuelled();
strikeState.charge = 0.5;   // deliberately off a 5-pip boundary
feedChum(stats(0.2));
check('half a bar plus one pip is exactly 0.7', near(strikeState.charge, 0.7, 1e-9));
fuelled();
strikeState.charge = 0.79;  // a hair under full at 5 pips (0.8 is pip 4)
feedChum(stats(0.2));
check('0.79 + one pip does not snap to full', strikeState.charge < 1);

console.log('\nEVERY PIP BOUNDARY IS BOOKED, AND DRAINS ON A FLOOR');
fuelled();
strikeState.charge = 0;
const n = pipCount(stats());
for (let i = 0; i < n; i++) feedChum(stats());
check(`${n} orbs queue ${n} ticks`, pendingPips() === n);

// The magnet-sweep case this queue exists for: six orbs inside ONE frame must
// not become six ticks on one frame.
const heard = [];
tick(1 / 60, { onPip: (index, total) => heard.push({ index, total }) });
check('only one tick is heard on the frame the burst lands', heard.length === 1);
check('  ...and it is the FIRST pip, so the run climbs', heard[0].index === 1);
check('  ...carrying the total, so the caller can pitch it', heard[0].total === n);

// Drain the rest and confirm the floor is actually being respected.
const gap = CONFIG.strike.charge.pipGap;
let frames = 0;
while (pendingPips() > 0 && frames < 10000) {
  tick(1 / 60, { onPip: (index, total) => heard.push({ index, total }) });
  frames++;
}
check(`all ${n} ticks are eventually heard — none dropped`, heard.length === n);
check('  ...in ascending pip order', heard.every((p, i) => p.index === i + 1));
// n-1 gaps between n ticks, and the first went out on frame one.
const expected = Math.floor((n - 1) * gap * 60);
check(`  ...spread over ~${expected} frames at a ${gap}s floor`,
  frames >= expected - 2 && frames <= expected + 3);

console.log('\nA BLUE ORB IS A WHOLE BAR OF PIPS');
fuelled();
strikeState.charge = 0;
restoreCharge(stats());
check('fills the bar outright', near(strikeState.charge, 1));
check('and books every pip it crossed', pendingPips() === pipCount(stats()));

console.log('\nTOPPING UP A FULL BAR BOOKS NOTHING');
fuelled();
strikeState.charge = 1;
feedChum(stats());
check('no pips queued against a bar already full', pendingPips() === 0);

console.log('\nTHE QUEUE IS BOUNDED');
fuelled();
strikeState.charge = 0;
// Far more crossings than a bar can hold, as a stand-in for a pathological
// frame. The backlog is trimmed from the FRONT so the run always ENDS on the
// pip that actually closed the ring.
for (let i = 0; i < 200; i++) { strikeState.charge = 0; feedChum(stats()); }
check('backlog never exceeds maxPips',
  pendingPips() <= (CONFIG.strike.charge.maxPips ?? 12));

console.log('\nRESET CLEARS THE TICK QUEUE, AND OPENS ON THE STARTING BALANCE');
resetStrike();
check('a new run starts silent', pendingPips() === 0);
// THE OPENING BALANCE, in pips, and it is 0 — the run begins with a dead meter
// and the food chain is the only thing that can fuel it. Read through
// pipCount so the claim is "N pips" and not "a fraction", which is the same
// reason resetStrike divides rather than storing a fraction: a card that
// changes what a mouthful is worth changes the bar's length, and the promise
// has to survive that.
const startPips = CONFIG.strike.charge.startPips ?? 0;
check(`a run opens with ${startPips} of its ${pipCount(stats())} pips`,
  near(strikeState.charge, startPips / pipCount(stats())));
check('  ...so nothing can be fired until something is eaten',
  startPips > 0 || strikeState.charge < (CONFIG.strike.charge.minFire ?? 0.35));
// And the meter has NO passive regeneration, which is what makes the 0 bite:
// a run left alone for ten seconds is still on empty.
for (let i = 0; i < 600; i++) tick(1 / 60);
check('  ...and ten seconds of doing nothing adds none',
  near(strikeState.charge, startPips / pipCount(stats())));

// ============================================================================
// THE TWO-COUNTER CHAIN — pips drive the MULTIPLIER, bars drive the PRICE.
// ============================================================================

console.log('\nEVERY MOUTHFUL FEEDS THE MULTIPLIER, NOT JUST A FULL BAR');
fuelled();
strikeState.charge = 0;
strikeState.active = true;          // a live combo, which is what opens the window
const per = pipCount(stats());      // 5 pips = one link's worth of multiplier
feedChum(stats());
check('one orb moves the multiplier depth off zero', chainLevel(stats()) > 0);
check(`  ...by exactly one pip's worth (1/${per})`,
  near(chainLevel(stats()), 1 / per, 1e-9));
for (let i = 1; i < per; i++) feedChum(stats());
check(`${per} orbs = exactly one link of multiplier`,
  near(chainLevel(stats()), 1, 1e-9));

console.log('\nTHE OLD CONSTANTS STILL MEAN WHAT THEY MEANT');
// The whole reason the level is FRACTIONAL: a bar's worth of food has to land
// on exactly the multiplier the per-link constants were tuned against, or every
// one of them would have needed rescaling by hand.
fuelled();
strikeState.active = true;
strikeState.charge = 0;
for (let i = 0; i < per * 2; i++) feedChum(stats());   // two links' worth
const lvl = chainLevel(stats());
const offset = CONFIG.strike.chainLevelOffset ?? 1;
check('two bars of food = level 2', near(lvl, 2, 1e-9));
check('  ...so the damage exponent is 1, exactly as link 2 always was',
  near(chainDamageMul({ strikeChainMul: 2 }), 2 ** (2 - offset), 1e-9));
const speedAt2 = comboSpeedMul();
check('  ...and the speed bonus matches one link of comboSpeedPerLevel',
  near(speedAt2, Math.min(CONFIG.strike.comboSpeedMax,
    1 + CONFIG.strike.comboSpeedPerLevel * 2), 1e-9));

console.log('\nONE ORB KEEPS THE CHAIN ALIVE — the reachability fix');
// The old rule was "empty AND refill the whole bar inside the window", i.e. a
// strike plus six mouthfuls in 1.1s. This is the check that it is now a single
// mouthful, which is the difference between a mechanic and a trick.
fuelled();
strikeState.active = true;
strikeState.charge = 0;
feedChum(stats());
strikeState.active = false;         // the dash ends; only the window holds it now
tick(CONFIG.strike.chainWindow * 0.8);
check('the window is still open most of a window later', strikeState.chainTimer > 0);
feedChum(stats());
check('one more orb refreshes it to full',
  near(strikeState.chainTimer, CONFIG.strike.chainWindow, 1e-6));
check('  ...and the multiplier kept climbing', near(chainLevel(stats()), 2 / per, 1e-9));
tick(CONFIG.strike.chainWindow + 0.01);
check('stop eating and it lapses', strikeState.chainTimer <= 0);
check('  ...taking BOTH counters with it',
  chainLevel(stats()) === 0 && strikeState.chainPips === 0 && strikeState.chainCount === 0);

console.log('\nA CHAIN STILL HAS TO BE OPENED BY A DASH');
// The entry condition is deliberately untouched: cruising over a stray orb
// must not silently start a chain, or the multiplier is simply always on.
fuelled();
strikeState.charge = 0;
strikeState.active = false;
feedChum(stats());
check('eating outside a combo starts nothing', strikeState.chainPips === 0);
check('  ...but still refills the bar', strikeState.charge > 0);

console.log('\nA BAR OF FOOD IS A WHOLE LINK OF MULTIPLIER, AND COSTS NOTHING');
fuelled();
strikeState.active = true;
strikeState.charge = 0;
check('base price is the base pip count', pipCount(stats()) === per);
for (let i = 0; i < per; i++) feedChum(stats());   // fills the bar exactly once
check('a full bar is worth a whole link of multiplier',
  near(chainLevel(stats()), 1, 1e-9));
// ...and the bar it was eaten out of is the same length it started. This is
// the pairing that used to be a trade — eat a bar, pay a pip — and is now
// simply a reward, because the price it was paying for no longer exists.
check('  ...and the bar it filled is unchanged', pipCount(stats()) === per);

console.log('\nTHE MULTIPLIER DOES NOT FALL BACKWARDS WHEN A LINK LANDS');
// chainLevel divides by the BASE pip count, never the live one. Dividing by a
// count that grows with each link would make earning a link visibly slow the
// seal down — the exact opposite of what a link is for.
fuelled();
strikeState.active = true;
strikeState.charge = 0;
for (let i = 0; i < per; i++) feedChum(stats());
const before = chainLevel(stats());
for (let i = 0; i < 4; i++) chainStrike('strikeRelease');   // price now way up
check('four links later the multiplier is exactly where it was',
  near(chainLevel(stats()), before, 1e-9));

// ============================================================================
// THE MAGNET, PER STATE
// ============================================================================

console.log('\nTHE MAGNET KNOWS WHAT THE SEAL IS DOING');
fuelled();
const mStats = { pickupRadius: CONFIG.player.pickupRadius };
const A = CONFIG.animation ?? {};
check('drifting is the base reach',
  near(magnetRadius(mStats, 0), mStats.pickupRadius, 1e-9));
check('swimming reaches further than drifting',
  magnetRadius(mStats, (A.boostThreshold ?? 14) - 1) > magnetRadius(mStats, 0));
check('a fast swim reaches further still',
  magnetRadius(mStats, (A.boostThreshold ?? 14) + 5)
    >= magnetRadius(mStats, (A.boostThreshold ?? 14) - 1));
// Measured BEFORE the dash starts. Both calls would otherwise resolve to
// 'striking' — the dash outranks speed — and the check would compare the
// striking radius against itself and pass on nothing.
const boostingReach = magnetRadius(mStats, (A.boostThreshold ?? 14) + 5);
strikeState.active = true;
check('striking is the widest of all', magnetRadius(mStats, 0) > boostingReach);
check('  ...and a dash counts as striking even on a slow frame',
  magnetState(0) === 'striking');
strikeState.active = false;

console.log('\nTHE PULL CAN ACTUALLY CATCH A DASHING SEAL');
// The failure this guards is silent and total: at the base 14 u/s against a
// 46 u/s dash an orb off to the side falls behind at 32 u/s and never arrives,
// so a wider striking radius would collect nothing whatsoever.
fuelled();
strikeState.active = true;
const pull = magnetSpeed(0);
check(`striking pull (${pull.toFixed(1)} u/s) beats dashSpeed (${CONFIG.strike.dashSpeed})`,
  pull > CONFIG.strike.dashSpeed);
strikeState.active = false;

console.log('\nWHILE DASHING THE REACH IS A CORRIDOR, NOT A CIRCLE');
fuelled();
strikeState.active = true;
strikeState.dashDir = { x: 1, y: 0 };
const cfgC = CONFIG.pickups.magnet.striking;
// An orb the dash has already shot past: far behind radially, but dead in lane.
const behind = cfgC.corridorBack * 0.8;
check('an orb in the lane behind reads as close',
  magnetDistance(0, 0, -behind, 0, 0) < 0.001);
check('  ...where a plain circle would have it a full corridor away',
  Math.hypot(-behind, 0) > magnetDistance(0, 0, -behind, 0, 0) + 1);
// ...but the capsule has ends, or an orb across the arena in line would count.
const wayBehind = cfgC.corridorBack + 10;
check('past the end of the corridor it is far again',
  magnetDistance(0, 0, -wayBehind, 0, 0) > 9);
// Off to the side it is still measured properly.
check('perpendicular distance is unaffected by the corridor',
  near(magnetDistance(0, 0, 0, 3, 0), 3, 1e-9));
strikeState.active = false;
check('not dashing, it is a plain circle again',
  near(magnetDistance(0, 0, -behind, 0, 0), behind, 1e-9));

// ============================================================================
// THE LINK IS SCORED ON THE RELEASE — "I refilled the bar and spent it again
// before the window shut", not "the bar happened to reach full".
// ============================================================================

const dir = { x: 1, y: 0 };

// A REAL WIND-UP, THROUGH updateCharge, ENDING IN A RELEASE.
//
// This file used to poke `strikeState.pending = 1` and call tryStrike, and
// that cannot work any more: a strike only bites if it is released inside the
// sweet spot, and the window is timed off the frames the hold actually took.
// A poked-in bank arrives with no timing behind it at all, so every strike
// reads as mistimed and every link check fails for a reason that has nothing
// to do with what it was testing. See the sweet spot note in systems/strike.js.
//
// `late` is how many seconds past the STRIKE NOW! moment to sit before letting
// go — 0 is dead on it, and anything past sweetHalfWidth() is a miss.
//
// The step is deliberately finer than a frame: the window is a tenth of a
// second wide and a 1/60 step is a sixth of it, which is enough slop to make
// a check about the EDGE of the window pass or fail on rounding.
const STEP = 1 / 480;
function strike({ late = 0, early = false, st = stats() } = {}) {
  let guard = 0;
  if (early) {
    // LET GO WITH FUEL STILL IN THE TANK. Banked past minFire so it fires, but
    // the wind-up never completes — so there is no perfect charge behind it and
    // nothing arms. This is the release that costs you the chain now; a LATE
    // one does not, which is the whole of the change (see tryStrike).
    const floor = CONFIG.strike.charge.minFire ?? 0.35;
    while (strikeState.pending < floor + 0.02 && guard++ < 20000) updateCharge(STEP, true, st);
    updateCharge(STEP, false, st);
    return tryStrike(dir, st);
  }
  while (!strikeLoaded() && guard++ < 20000) updateCharge(STEP, true, st);
  for (let t = 0; t < late - 1e-9; t += STEP) updateCharge(STEP, true, st);
  return tryStrike(dir, st);
}
// Fill the tank without feeding. The bar is FUEL and `pipsSinceStrike` is
// FOOD; a test about one has to be able to move it without moving the other,
// which is exactly what eating five chum would not do.
const fillTank = () => { strikeState.charge = 1; };
const feed = (n) => { for (let i = 0; i < n; i++) feedChum(stats()); };
// ENOUGH FOOD TO BOTH ARM A LINK AND AFFORD A STRIKE, which are two different
// thresholds and the difference is easy to walk into. A link costs
// `linkPips` mouthfuls — one — but a release cannot fire at all until
// `minFire` of the bar is banked, so on an empty tank the real floor is
// whichever is higher: two pips of a five-pip bar. Feeding exactly one and
// wondering why nothing fires is the mistake this exists to name.
const pipsToFire = () => Math.max(linkPips(stats()),
  Math.ceil((CONFIG.strike.charge.minFire ?? 0.35) * pipCount(stats())));

console.log('\nA RELEASE OPENS THE WINDOW AND SCORES NOTHING ITSELF');
fuelled();
check('the opening strike fires', strike() === true);
check('  ...and scores no link — a release arms, it does not link',
  consumeStrikeLink().depth === 0 && liveChain() === 0);
check('  ...but it opens the window, so eating starts counting',
  strikeState.chainTimer > 0 && strikeState.armed === true);
// ...and a second release inside the window still scores nothing on its own,
// however well fed it was. This was the whole mechanic one model ago.
strikeState.charge = 0;
feed(pipsToFire());
check(`${linkPips(stats())} mouthful is the gate (a ${pipCount(stats())}-pip bar)`,
  linkPips(stats()) === 1);
check(`  ...though ${pipsToFire()} are needed before a strike can fire at all`,
  strikeState.charge >= CONFIG.strike.charge.minFire);
const depthBefore = liveChain();
check('the second strike fires', strike() === true);
check('  ...and it too adds nothing — the FOOD did all of it',
  liveChain() === depthBefore, `x${depthBefore} -> x${liveChain()}`);
check('  ...clearing the counter behind it', strikeState.pipsSinceStrike === 0);
cancelDash();

console.log('\nTHE WINDOW STILL HAS TO BE OPEN');
fuelled();
strike(); cancelDash();
strikeState.active = false;
tick(CONFIG.strike.chainWindow + 0.05);          // let it lapse
check('the window lapsed', strikeState.chainTimer <= 0);
feedChum(stats());
check('a mouthful after it shut scores nothing', consumeChainLink() === 0);
fillTank();
strike();
check('  ...but a fresh strike opens a fresh window',
  strikeState.chainTimer > 0 && strikeState.armed === true);
check('  ...and the next mouthful links again', (feedChum(stats()), consumeChainLink()) === 1);
cancelDash();

console.log('\nONE MOUTHFUL IS EXACTLY ONE LINK');
// `chumFull` and `chumEaten` are the same food at two grains — every mouthful,
// and the one that tops the bar off. A tuning snapshot can pin chumFull on, so
// the rule that stops them double-scoring is structural rather than a config
// default; this is the check that it holds.
fuelled();
const wasChumFull = CONFIG.strike.chainOn.chumFull;
CONFIG.strike.chainOn.chumFull = true;           // as a stale snapshot would
strike(); cancelDash();
strikeState.charge = 0;
check('chumFull is suppressed while chumEaten is on',
  chainStrike('chumFull') === 0);
for (let i = 0; i < pipCount(stats()); i++) feedChum(stats());
check('  ...so a whole bar eaten is exactly its pip count in links',
  liveChain() === pipCount(stats()), `x${liveChain()} off ${pipCount(stats())} chum`);
CONFIG.strike.chainOn.chumFull = wasChumFull;
fuelled();

console.log('\nTHE STRIKE ARMS, THE FOOD SCORES');
// THE SHORTEST PATH TO A FOOD CHAIN, which is the thing that kept not
// happening. One release on the beat, one chum — that is the whole entry
// price, and it has to be reachable in that order because that is the order a
// player does it in.
fuelled();
check('a sweet release arms a chain', strike() === true && strikeState.armed === true);
check('  ...and scores nothing on its own', consumeChainLink() === 0);
check('  ...with no chain running yet', liveChain() === 0);
check('ONE mouthful makes it a chain', (feedChum(stats()), consumeChainLink()) === 1);
check('  ...and the chain is live at x1', liveChain() === 1);
// ...and the number climbs per pip from there, which is the other half.
feedChum(stats());
check('  ...the next mouthful ticks it to x2', consumeChainLink() === 2);
feedChum(stats());
feedChum(stats());
check('  ...one per pip, so four mouthfuls is x4', liveChain() === 4, `x${liveChain()}`);
cancelDash();
fuelled();

console.log('\nAND EATING WITHOUT A SWEET STRIKE BEHIND IT SCORES NOTHING');
// The arming is what a link is bought with. Without it a seal parked on a pile
// would chain forever having never struck, which is the whole mechanic gone.
fuelled();
strikeState.chainTimer = CONFIG.strike.chainWindow;   // a window, but unearned
feedChum(stats());
check('an unarmed window scores no link', consumeChainLink() === 0);
check('  ...and leaves the chain at zero', liveChain() === 0);
// A release that never finished its wind-up does not arm one either.
fuelled();
const halfW = sweetHalfWidth(stats());
strike({ early: true });
check('an unfinished wind-up arms nothing', strikeState.armed === false);
feedChum(stats());
check('  ...so eating after it scores nothing', consumeChainLink() === 0);
cancelDash();
fuelled();

console.log('\nAND THE ARMING DIES WITH THE CHAIN');
// Otherwise one good strike licenses every mouthful for the rest of the run.
fuelled();
strike(); cancelDash();
feedChum(stats());
check('the chain is running', liveChain() === 1 && (consumeChainLink(), true));
tick(CONFIG.strike.chainWindow + 0.05);
check('  ...the window lapsed', strikeState.chainTimer <= 0);
check('  ...and the arming went with it', strikeState.armed === false);
strikeState.chainTimer = CONFIG.strike.chainWindow;
feedChum(stats());
check('  ...so eating no longer links', consumeChainLink() === 0);
fuelled();

console.log('\nTHE DASH EATS SMALL PREY, AND ONLY SMALL PREY');
const cull = CONFIG.strike.preyCull;
check('the cull is on', cull.enabled !== false);
check('a schooling fish (r 0.4) is under the line', 0.4 < cull.maxRadius);
check('a shark (r 1.2) is not', !(1.2 < cull.maxRadius));
// The boundary is shared with the mark on purpose — a body is either small
// enough to eat or big enough to paint, never both and never neither.
check('the cull line matches the mark line',
  cull.maxRadius === CONFIG.strike.mark.minRadius);

// ============================================================================
// THE PERFECT CHARGE — the wind-up fully banked.
//
// A LATCH AND AN EDGE, and the difference between them is the whole section.
// `pending` clamps at 1 and then sits there for as long as the button is held,
// so anything that asks "is it full?" fires every frame of a long hold — which
// is a sound and a rumble per frame at the top of every wind-up. The latch is
// what a payoff will read (it describes the strike that is LOADED, not the
// frame it loaded on) and the edge is what the one-shots ride.
//
// Nothing in the dash reads it yet, deliberately: the tell ships first so the
// timing is familiar before it starts paying. What is pinned here is the
// bookkeeping, because that is the part a later mechanic will be built on.
// ============================================================================

console.log('\nTHE PERFECT CHARGE LATCHES ONCE, AND CLEARS WHEN IT IS SPENT');
fuelled();
const perfectAt = CONFIG.strike.charge.perfectAt ?? 1;
check('a fresh run has no perfect charge banked', strikeState.perfect === false);
check('...and no edge waiting to be consumed', perfectCrossed() === false);

// Hold from a full bar. `time` seconds of holding banks exactly one bar.
let crossings = 0;
let held = 0;
while (held < 240 && strikeState.pending < perfectAt - 1e-9) {
  updateCharge(1 / 60, true, stats());
  if (perfectCrossed()) crossings++;
  held++;
}
check('holding a full bar reaches a perfect charge', strikeState.perfect === true);
check(`  ...in about the ${CONFIG.strike.charge.time}s the bar is worth`,
  Math.abs(held / 60 - CONFIG.strike.charge.time * perfectAt) < 0.05,
  `${(held / 60).toFixed(2)}s`);
check('  ...announced exactly once', crossings === 1, `${crossings} crossing(s)`);

const popTime = CONFIG.strike.charge.perfectFlashTime ?? 0.5;
check('  ...and the pop is lit for the ring to draw', strikeState.perfectFlash > 0,
  `${strikeState.perfectFlash.toFixed(2)}s of ${popTime}s`);

// The part a level test would miss entirely.
for (let i = 0; i < 60; i++) {
  updateCharge(1 / 60, true, stats());
  if (perfectCrossed()) crossings++;
}
check('a second of holding past it announces nothing more', crossings === 1, `${crossings} crossing(s)`);
check('  ...and the latch is still set', strikeState.perfect === true);
// The pop is an ANNOUNCEMENT, not a state: it has to be over while the latch
// it announced is still true, or a held wind-up sits there flashing.
check('  ...while the pop it fired has long since rung out',
  strikeState.perfectFlash === 0, `${strikeState.perfectFlash.toFixed(2)}s left`);

// Spending it. The dash keeps what it was bought with; the latch does not.
const fired = tryStrike({ x: 1, y: 0 }, stats());
check('the release fires', fired === true);
check('  ...stamped as a perfect strike, for whatever comes to read it',
  strikeState.perfectStrike === true);
check('  ...and the latch is clear, so the next hold earns its own',
  strikeState.perfect === false);
cancelDash();

// A perfect charge that could not be spent would be a tell for a thing the
// player is not allowed to do. The two thresholds are set independently, in
// two different files — `perfectAt` in weapons.csv, `minFire` in config.js —
// so nothing but this stops them being tuned past each other.
check('a perfect charge is always enough to fire',
  perfectAt >= CONFIG.strike.charge.minFire,
  `perfectAt ${perfectAt} vs minFire ${CONFIG.strike.charge.minFire}`);

fuelled();
check('a reset clears the latch, the stamp and the pop',
  strikeState.perfect === false && strikeState.perfectStrike === false && strikeState.perfectFlash === 0);

// ============================================================================
// THE SWEET SPOT — the strike only bites if it is released on the beat.
//
// EVERYTHING THE STRIKE KILLS OR FEEDS HANGS OFF ONE BOOLEAN, so what matters
// here is not that the boolean exists but that it is anchored to the moment
// the player is actually SHOWN. "STRIKE NOW!" goes up on strikeLoaded() and
// tryStrike times the release against the same function, and if those two ever
// came apart the game would be asking for an input a tenth of a second away
// from the one it rewards — a mechanic that reads as broken and measures as
// working, since every number involved would still be internally consistent.
//
// The other half is the SHAPE of the window: it has a late side. A wind-up
// stops moving the instant it loads (`pending` clamps, `charge` bottoms out),
// so anything derived from the meter alone would let a player hold the button
// down forever and still hit the beat.
// ============================================================================

console.log('\nTHE WINDOW OPENS ON THE MOMENT THE PLAYER IS SHOWN');
fuelled();
const half = sweetHalfWidth(stats());
check(`the window is ${(half * 2 * 1000).toFixed(0)}ms wide`, half > 0);
check('  ...which is sweetFraction of the wind-up, both sides',
  near(half, CONFIG.strike.charge.time * CONFIG.strike.charge.sweetFraction, 1e-9));

// Hold from a full bar, sampling every frame, and record where the window is
// against where the prompt is.
let promptAt = -1;
let firstSweet = -1;
let lastSweet = -1;
let held2 = 0;
for (let i = 0; i < 4000; i++) {
  updateCharge(STEP, true, stats());
  held2 += STEP;
  if (inSweetSpot(stats())) {
    if (firstSweet < 0) firstSweet = held2;
    lastSweet = held2;
  }
  if (promptAt < 0 && strikeLoaded()) promptAt = held2;
}
check('the prompt fires about a bar into the hold', Math.abs(promptAt - CONFIG.strike.charge.time) < 0.02,
  `${promptAt.toFixed(3)}s of ${CONFIG.strike.charge.time}s`);
check('  ...and the window is centred on it, not started by it',
  firstSweet < promptAt && lastSweet > promptAt,
  `${firstSweet.toFixed(3)} .. ${promptAt.toFixed(3)} .. ${lastSweet.toFixed(3)}`);
check('  ...reaching back one half-width before it',
  near(promptAt - firstSweet, half, 0.01), `${(promptAt - firstSweet).toFixed(3)}s vs ${half.toFixed(3)}s`);
check('  ...and running one half-width past it',
  near(lastSweet - promptAt, half, 0.01), `${(lastSweet - promptAt).toFixed(3)}s vs ${half.toFixed(3)}s`);
// THE LATE SIDE EXISTS AT ALL. Sitting on a loaded wind-up has to expire, and
// nothing in the meter changes while it does — which is why this is timed.
check('  ...so holding on past it is a miss', inSweetSpot(stats()) === false);
check('  ...with the wind-up still perfectly fireable', strikeState.pending >= CONFIG.strike.charge.minFire);
// The sign says WHICH mistake it was, which is what a tell would need.
check('being late reads as a positive offset', sweetOffset() > 0, sweetOffset().toFixed(3));
fuelled();
updateCharge(STEP, true, stats());
check('  ...and being early as a negative one', sweetOffset() < 0, sweetOffset().toFixed(3));

console.log('\nON THE BEAT THE STRIKE BITES; OFF IT, IT ONLY MOVES');
fuelled();
check('a release on the beat is stamped sweet', strike() === true && strikeState.sweetStrike === true);
const onBeatBurst = strikeBurst(stats());
check('  ...and the release burst has damage in it', onBeatBurst.damage > 0, onBeatBurst.damage.toFixed(1));
check('  ...and a radius to put it in', onBeatBurst.radius > 0);
const onBeatDash = strikeState.dashDuration;
cancelDash();

fuelled();
// Two full half-widths late: comfortably out, and still holding a full bank.
check('a release well past the window fires anyway', strike({ late: half * 3 }) === true);
check('  ...but is stamped as no strike at all', strikeState.sweetStrike === false);
const offBeatBurst = strikeBurst(stats());
check('  ...so the burst is nothing, damage AND radius',
  offBeatBurst.damage === 0 && offBeatBurst.radius === 0);
check('  ...and the riders it would have fed get nothing either',
  riderDamage(999, stats()) === 0);
// THE POINT OF THE WHOLE SPLIT: the movement is untouched. A mistimed strike
// is a full-power dash, which is what keeps repositioning free.
check('  ...while the dash is exactly as long as the one that bit',
  near(strikeState.dashDuration, onBeatDash, 1e-9),
  `${strikeState.dashDuration.toFixed(3)}s vs ${onBeatDash.toFixed(3)}s`);
check('  ...and the i-frames it paid for are still running', strikeState.invulnTimer > 0);
cancelDash();

// OFF THE BEAT COSTS THE DAMAGE, NOT THE CHAIN. The two were one condition
// until a perfect charge started arming on its own — the sweet spot is the
// DAMAGE gate now, and a late release is a real strike with no bite rather
// than a strike that never happened.
console.log('\nBUT OFF THE BEAT IT STILL STARTS A CHAIN — the charge is what arms');
fuelled();
check('a mistimed opening strike fires', strike({ late: half * 3 }) === true);
check('  ...and DOES open a window, because the charge completed',
  strikeState.chainTimer > 0, `${strikeState.chainTimer.toFixed(2)}s`);
check('  ...so the food after it links', (feedChum(stats()), consumeChainLink()) === 1);
cancelDash();

console.log('\nAN UNFINISHED WIND-UP IS WHAT NEITHER STARTS NOR EXTENDS A CHAIN');
fuelled();
check('a release let go of early still fires', strike({ early: true }) === true);
check('  ...and opens NO window, so eating counts for nothing',
  strikeState.chainTimer === 0);
// ...not even at the end of the dash, which is the other place a window opens.
let d = 0;
while (strikeState.active && d < 600) { tick(1 / 60); d++; }
check('  ...and the dash ending does not open one either',
  strikeState.chainTimer === 0);

fuelled();
// AND IT CANNOT RE-ARM A CHAIN THAT HAS LAPSED, which is the case that decides
// whether a mistimed strike costs anything. Let one run down, throw a bad one,
// and the food that follows has nothing to score against.
strike(); cancelDash();
feedChum(stats());
check('a chain is running', liveChain() === 1 && (consumeChainLink(), true));
strikeState.active = false;
tick(CONFIG.strike.chainWindow + 0.05);
check('  ...and then lapses', strikeState.chainTimer <= 0 && strikeState.armed === false);
fillTank();
const missed = (strike({ early: true }), consumeStrikeLink());
check('  ...an unfinished wind-up arms nothing', strikeState.armed === false);
check('  ...booked as arming nothing', missed.arms === false);
feedChum(stats());
check('  ...so the food after it links nothing', consumeChainLink() === 0);
cancelDash();
fuelled();

// ============================================================================
// THE PIPS PLOP UP ONE AT A TIME — even when a whole bar lands on one frame.
//
// This is the property the stagger queue exists for and it is invisible to
// every other check: the model is correct either way, and the failure mode is
// purely that the most rewarding moment in the loop happens in 16ms.
// ============================================================================

console.log('\nA WHOLE BAR ON ONE FRAME STILL ARRIVES ONE PIP AT A TIME');
const ringMesh = createStrikeRing();
const U = ringMesh.material.uniforms;
const pos = { x: 0, y: 0 };
const litPips = () => {
  let n = 0;
  for (let i = 0; i < U.uPips.value; i++) if (U.uPipFill.value[i] > 0.5) n++;
  return n;
};

resetStrikeRing();
fuelled();
strikeState.charge = 0;
updateStrikeRing(1 / 60, pos, strikeState, true, stats());   // settle at empty
const pips = pipCount(stats());

// The gulp: a whole bar swallowed inside a single frame.
strikeState.charge = 1;
updateStrikeRing(1 / 60, pos, strikeState, true, stats());
check('the frame the bar fills, not every pip is up', litPips() < pips);

// Advance one stagger at a time and watch them arrive.
const stag = CONFIG.strike.ring.pipStagger;
const seen = [litPips()];
for (let step = 0; step < pips + 2; step++) {
  let t = 0;
  while (t < stag) { updateStrikeRing(1 / 60, pos, strikeState, true, stats()); t += 1 / 60; }
  seen.push(litPips());
}
check('they climb in sequence rather than jumping',
  seen.every((v, i) => i === 0 || v >= seen[i - 1]));
check(`  ...reaching all ${pips} in the end`, litPips() === pips);
check('  ...and it took more than one frame to get there', seen[0] < pips);

console.log('\nEACH PIP POPS AS IT LANDS, AND THE POPS ARE OFFSET IN TIME');
resetStrikeRing();
strikeState.charge = 0;
updateStrikeRing(1 / 60, pos, strikeState, true, stats());
strikeState.charge = 1;
// Sample every frame and record when each pip's pop peaks.
const peakAt = new Array(pips).fill(-1);
const peakVal = new Array(pips).fill(0);
for (let f = 0; f < 240; f++) {
  updateStrikeRing(1 / 60, pos, strikeState, true, stats());
  for (let i = 0; i < pips; i++) {
    if (U.uPipPop.value[i] > peakVal[i]) { peakVal[i] = U.uPipPop.value[i]; peakAt[i] = f; }
  }
}
check('every pip popped', peakVal.every((v) => v > 0.5));
check('  ...and no two popped on the same frame',
  new Set(peakAt).size === pips, );
check('  ...in ring order, first pip first',
  peakAt.every((f, i) => i === 0 || f > peakAt[i - 1]));
check('  ...and the pops faded out afterwards',
  U.uPipPop.value.every((v) => v < 0.01));

// ============================================================================
// THE INSTRUMENT IS BEHIND THE ANIMAL.
//
// The ring is a flat quad on a plane and the seal is a solid 3.5 units deep,
// so a plane anywhere near z=0 does not sit "just behind" the seal — it goes
// THROUGH it, and the arcs get sliced by the flank they pass into. It shipped
// that way at z=-0.05.
//
// Measured against the model the game actually builds rather than against the
// constant that placed it, which is the only version of this check worth
// having: playerOverlayZ derives its number from the seal's size multiplier,
// and comparing a derivation to itself would pass with the seal at any size.
// ============================================================================
console.log('\nTHE RING SITS BEHIND THE SEAL, AT WHATEVER SIZE IT IS');
{
  const buf = readFileSync(new URL('../public/models/furseal.glb', import.meta.url));
  const gltf = await new GLTFLoader().parseAsync(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
  );
  installModel('ship', gltf.scene, gltf.animations);

  // Two sizes: the one on the slider now, and a seal scaled well past it. The
  // second is what a hand-typed world offset fails.
  const SHIP_SIZE = getAssetSizeMultiplier('ship') || 1;
  for (const size of [SHIP_SIZE, 4]) {
    setAssetSizeMultiplier('ship', size);
    const seal = createVisual('ship');
    const scene = new THREE.Scene();
    scene.add(seal);
    // Without this every world matrix is identity and the box measures the
    // model at scale 1 — silently, and it looks like a pass.
    scene.updateMatrixWorld(true);
    const rear = new THREE.Box3().setFromObject(seal).min.z;

    updateStrikeRing(1 / 60, pos, strikeState, true, stats());
    check(`at size ${size.toFixed(2)} the meter clears the seal's rear (${rear.toFixed(2)})`,
      ringMesh.position.z < rear);
  }
  setAssetSizeMultiplier('ship', SHIP_SIZE);
}

console.log('\nTHE DRAIN IS NEVER STAGGERED');
// Holding burns fuel and the release spends it. Both are things the player
// DID, and a bar that empties late reads as input lag. Only gains queue.
resetStrikeRing();
strikeState.charge = 1;
for (let f = 0; f < 200; f++) updateStrikeRing(1 / 60, pos, strikeState, true, stats());
check('the bar is full and settled', litPips() === pips);
strikeState.charge = 0;
updateStrikeRing(1 / 60, pos, strikeState, true, stats());
check('spending it empties the ring on the SAME frame', litPips() === 0);

console.log('\nA LINK RE-SEGMENTS THE RING WITHOUT ANIMATING');
// The pip count changed, so the pips on screen are no longer the pips in the
// model; tweening between two different segmentations is a meaningless slide.
resetStrikeRing();
fuelled();
strikeState.charge = 1;
for (let f = 0; f < 200; f++) updateStrikeRing(1 / 60, pos, strikeState, true, stats());
const before6 = litPips();
chainStrike('strikeRelease');                       // a link: 5 pips -> 6
updateStrikeRing(1 / 60, pos, strikeState, true, stats());
check(`the ring re-cut from ${before6} to ${pipCount(stats())} pips`,
  U.uPips.value === pipCount(stats()));
check('  ...and a full bar is still fully lit, with no slide',
  litPips() === pipCount(stats()));

// ============================================================================
// YOU CAN STILL JUST SWIM INTO CHUM.
//
// The corridor rewrote the magnet's RANGE test, which is the one place a
// regression here would hide: get it wrong and pickup quietly becomes
// dash-only, which no other check would notice because every other test in
// this file drives the model directly rather than through updatePickups.
//
// So this runs the real pickup system end to end — spawn an orb, put a seal
// near it, step frames, see whether it goes down.
// ============================================================================

console.log('\nA PLAIN PASS HOOVERS CHUM IN — no dash required');
const scene = new THREE.Scene();
const seal = (x, y, vx, vy, sealed = false) => ({
  mesh: { position: new THREE.Vector3(x, y, 0) },
  velocity: new THREE.Vector2(vx, vy),
  chumSealed: sealed,
  stats: { pickupRadius: CONFIG.player.pickupRadius, chumGulpRadius: 5 },
});
function collects(orbX, player, maxFrames = 400, chaining = false) {
  resetPickups(scene);
  fuelled();
  // The window, set directly rather than struck for: what is under test here
  // is the pickup system, and winding up a real strike would seal the mouth
  // and dash the seal away from the orb it is supposed to be reaching for.
  if (chaining) strikeState.chainTimer = CONFIG.strike.chainWindow;
  spawnXpOrb(scene, new THREE.Vector3(orbX, 0, 0), 2, 0.4);
  let got = 0, f = 0;
  while (got === 0 && f < maxFrames) {
    updatePickups(1 / 60, scene, player, () => { got++; }, () => {}, () => {}, () => {});
    f++;
  }
  return got > 0;
}
const baseR = CONFIG.player.pickupRadius;

check('standing still, an orb inside the radius is drawn in',
  collects(baseR * 0.7, seal(0, 0, 0, 0)));
check('swimming past, an orb inside the radius is drawn in',
  collects(baseR * 0.9, seal(0, 0, 5, 0)));
check('swimming straight over one takes it immediately',
  collects(0.3, seal(0, 0, 10, 0)));
// The radius has to still MEAN something, or "hoover" is just "collect all".
check('an orb well outside the radius is left alone',
  !collects(baseR * 2.5, seal(0, 0, 0, 0)));
// The one deliberate exception, unchanged: a wind-up seals the mouth and the
// release gulps the lot instead (CONFIG.strike.charge.gulp).
check('a wind-up still seals the mouth',
  !collects(baseR * 0.7, seal(0, 0, 0, 0, true)));

// ============================================================================
// THE SWEEP IS THE CHAIN'S. THE MAGNET IS EVERYONE'S.
//
// There is always a magnet — base radius, base pull — so no seal ever has to
// earn the right to eat. What a live chain turns on is the LOUD version: the
// per-state multipliers and the corridor above. Both collect; one hoovers.
//
// The failure this pins is silent in the worst possible way. Gate the magnet
// itself rather than its strength and you have gated EATING, because the pull
// is what carries an orb the last few units into `collectRadius` — the seal's
// real reach collapses to the width of its mouth and nothing on screen says
// so. A tier can only ever be wrong about how fast food arrives.
// ============================================================================

console.log('\nTHE SWEEP IS THE CHAIN\'S; THE MAGNET IS EVERYONE\'S');
fuelled();
check('no chain, no sweep', chumSweep() === false);
strikeState.chainTimer = CONFIG.strike.chainWindow;
check('a live window turns it on', chumSweep() === true);
// The dash counts too — that is the same window seen from inside it, and the
// corridor is the reach a dash is FOR, on the beat or off it.
fuelled();
strikeState.active = true;
check('and so does the dash itself', chumSweep() === true);
strikeState.active = false;

// THE TIER, MEASURED. Both ends are real reaches at real speeds; neither is
// zero, which is the whole safety property.
fuelled();
const cruiseR = foodReach(mStats, (A.boostThreshold ?? 14) + 5);
const cruiseP = foodPull((A.boostThreshold ?? 14) + 5);
strikeState.chainTimer = CONFIG.strike.chainWindow;
const chainR = foodReach(mStats, (A.boostThreshold ?? 14) + 5);
const chainP = foodPull((A.boostThreshold ?? 14) + 5);
fuelled();
check(`a chain reaches further — ${cruiseR.toFixed(1)} -> ${chainR.toFixed(1)} units`,
  chainR > cruiseR);
check(`  ...and pulls harder — ${cruiseP.toFixed(1)} -> ${chainP.toFixed(1)} u/s`,
  chainP > cruiseP);
check('  ...but cruising is the BASE magnet, not nothing',
  cruiseR >= CONFIG.player.pickupRadius && cruiseP >= CONFIG.pickups.magnetSpeed,
  `${cruiseR.toFixed(1)} units at ${cruiseP.toFixed(1)} u/s`);
// The state multipliers really are what moved — a cruising seal ignores them.
check('  ...i.e. the state multipliers are the chain\'s',
  near(cruiseR, magnetRadius(mStats, 0), 1e-9),
  `${cruiseR.toFixed(2)} vs drifting ${magnetRadius(mStats, 0).toFixed(2)}`);

// An orb only the magnet could ever have delivered — outside the mouth, inside
// the base radius. It has to go down BOTH ways, or the tier has become a gate.
const pullOnly = (CONFIG.pickups.collectRadius + baseR) / 2;
check('an orb in reach is eaten inside a chain',
  collects(pullOnly, seal(0, 0, 0, 0), 400, true));
check('  ...and outside one, at the same radius',
  collects(pullOnly, seal(0, 0, 0, 0), 400, false));
// The radius still has to MEAN something without the sweep, or "always eats"
// has become "eats everything".
check('  ...but not one well outside it, when nothing is sweeping',
  !collects(baseR * 2.5, seal(0, 0, 0, 0), 400, false));
// And the sealed mouth still outranks both: a wind-up takes nothing at all.
check('  ...and a wind-up still takes nothing, chain or no chain',
  !collects(pullOnly, seal(0, 0, 0, 0, true), 400, true)
  && !collects(pullOnly, seal(0, 0, 0, 0, true), 400, false));

console.log('\nTHE CORRIDOR ONLY EVER ADDS REACH, NEVER TAKES IT');
// magnetDistance swaps to a capsule while dashing. If that could ever return
// MORE than the radial distance, dashing would collect less than drifting —
// the exact regression this section exists to rule out.
fuelled();
let corridorShrank = 0;
for (let ang = 0; ang < 32; ang++) {
  for (const d of [1, 3, 6, 12]) {
    const ox = Math.cos((ang / 32) * Math.PI * 2) * d;
    const oy = Math.sin((ang / 32) * Math.PI * 2) * d;
    strikeState.active = false;
    const plain = magnetDistance(0, 0, ox, oy, 0);
    strikeState.active = true;
    strikeState.dashDir = { x: 1, y: 0 };
    const dashing = magnetDistance(0, 0, ox, oy, 0);
    if (dashing > plain + 1e-9) corridorShrank++;
  }
}
strikeState.active = false;
check('dashing never reads an orb as further away than drifting does',
  corridorShrank === 0);
check('and not dashing is exactly the plain radial distance',
  near(magnetDistance(0, 0, 3, 4, 0), 5, 1e-9));

// ============================================================================
// STAYING ALIVE IS CHEAP; GETTING DEEP IS NOT.
//
// One number used to do both jobs (`linkBarFraction`, three mouthfuls of five,
// climbing with the chain) and they pull in opposite directions: as a GATE it
// decides whether the chain survives and wants to be low, as a PRICE it is the
// only thing stopping a chain being free and wants to be high. Split, the gate
// went to the floor and the escalation moved onto the REWARD — which is what
// this section pins, because a regression would put them back together without
// anything looking wrong.
// ============================================================================

console.log('\nTHE GATE IS ONE MOUTHFUL, AND IT STAYS ONE');
fuelled();
check(`a ${pipCount(stats())}-pip bar links for ${linkPips(stats())} mouthful(s)`,
  linkPips(stats()) < pipCount(stats()));
check('but never for free', linkPips(stats()) >= 1);
check('  ...and it does not climb with the chain',
  [0, 3, 9].every((link) => {
    strikeState.chainCount = link;
    strikeState.chainTimer = link > 0 ? CONFIG.strike.chainWindow : 0;
    return linkPips(stats()) === linkPips(null);
  }));
fuelled();

// ============================================================================
// ONE CHUM IS ONE PIP AT EVERY DEPTH, AND NOW ABSOLUTELY.
//
// A `chainPipsPerLink` used to lengthen the bar as the chain deepened. It is
// gone, and the reason is worth keeping: links tick per PIP now, so the bar's
// length would have been a function of how much had been eaten — while eating
// is the thing filling it. The bar grew as you filled it, and a six-pip bar
// silently took seven chum. Nothing on screen could explain that, because the
// number causing it is the number celebrating.
//
// The sweep above already covers the fill at fourteen depths. This is the
// blunt statement of the same thing: no reachable chain state moves it.
// ============================================================================

console.log('\nNO CHAIN STATE ANYWHERE MOVES THE BAR');
fuelled();
const barPips = Math.round(1 / CONFIG.strike.charge.chumRefill);
const lengths = new Set();
for (const pips of [0, 1, 4, 5, 12, 60, 400]) {
  for (const links of [0, 1, 7, 120]) {
    strikeState.chainPips = pips;
    strikeState.chainCount = links;
    strikeState.chainTimer = (pips || links) ? CONFIG.strike.chainWindow : 0;
    lengths.add(pipCount(stats()));
  }
}
fuelled();
console.log(`          bar lengths seen across 28 chain states: [${[...lengths]}]`);
check('every one of them is the same bar', lengths.size === 1 && lengths.has(barPips),
  `${lengths.size} distinct length(s)`);

console.log('\nTHE WINDOW STARTS WHEN THE DASH ENDS, NOT AT THE RELEASE');
// A dash runs up to 0.48s. Starting the clock at the release spent nearly half
// a 1.1s window on the stretch the seal is committed and cannot act — and
// punished the biggest strikes hardest, since they dash longest.
fuelled();
strike();
consumeStrikeLink();
const dashLen = strikeState.dashDuration;
check('the dash has real length', dashLen > 0.1);
// Run the dash out, eating nothing.
let t = 0;
while (strikeState.active && t < 5) { tick(1 / 60); t += 1 / 60; }
check('the dash ended', !strikeState.active);
check('  ...and a FULL window is left, not the remainder',
  near(strikeState.chainTimer, CONFIG.strike.chainWindow, 0.02));
check(`  ...where the old behaviour would have left ~${(CONFIG.strike.chainWindow - dashLen).toFixed(2)}s`,
  strikeState.chainTimer > CONFIG.strike.chainWindow - dashLen + 0.01);

console.log('\nEATING SINCE THE LAST STRIKE IS WHAT COUNTS — and it resets');
// The counter is ungated so the rule stays "food eaten since your last
// strike". The reset on release is what stops that being a hoarding exploit —
// and with the gate at one mouthful it is a small exploit to close, but the
// rule has to be the same one at every setting of `linkMinPips`.
fuelled();
for (let i = 0; i < 20; i++) feedChum(stats());   // graze with no window open
check('grazing banks progress', strikeState.pipsSinceStrike === 20);
check('  ...but scores nothing, with no strike behind it', liveChain() === 0);
strike();
check('  ...and the release spends the hoard', strikeState.pipsSinceStrike === 0);
check('  ...so the chain still starts from the next mouthful',
  (feedChum(stats()), consumeChainLink()) === 1);
cancelDash();

console.log('\nBREAKING OUT OF A DASH STILL PAYS THE WINDOW');
// The subtle one. The dash's end is where the combo window starts, so a cancel
// that only cleared `active` would silently cost the player the window their
// strike paid for — invisible until chains quietly stop being reachable after
// any manual break-out. Both endings go through finishDash for that reason.
fuelled();
strike();
consumeStrikeLink();
strikeState.chainTimer = 0;               // as if the window had lapsed
check('mid-dash with no window', strikeState.active && strikeState.chainTimer === 0);
cancelDash();
check('breaking out ends the dash', !strikeState.active);
check('  ...and opens a full window, same as running it out',
  near(strikeState.chainTimer, CONFIG.strike.chainWindow, 1e-9));
check('  ...and leaves the i-frames alone — they were paid for',
  strikeState.invulnTimer > 0);

// Running it out has to land in exactly the same place.
fuelled();
strike();
consumeStrikeLink();
strikeState.chainTimer = 0;
let g = 0;
while (strikeState.active && g < 600) { tick(1 / 60); g++; }
check('letting it run out opens the same window',
  near(strikeState.chainTimer, CONFIG.strike.chainWindow, 0.02));
check('cancelling twice is harmless', (cancelDash(), cancelDash(), !strikeState.active));

console.log(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures ? 1 : 0);
