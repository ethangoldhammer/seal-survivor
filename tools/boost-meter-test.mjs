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
} from '../path/src/systems/strike.js';
import { magnetRadius, magnetSpeed, magnetDistance, magnetState } from '../path/src/systems/chumMagnet.js';
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
});

// updateStrike wants a scene, a position and an enemy list; none are touched
// while no dash is active, which is every case below.
function tick(dt, hooks = {}) {
  updateStrike(dt, null, { x: 0, y: 0 }, stats(), [], hooks);
}

console.log('\nPIP COUNT IS DERIVED FROM THE REFILL');
resetStrike();
check('the default 0.2 refill is a five-pip bar', pipCount(stats(0.2)) === 5);
check('one pip is exactly one fifth', near(pipValue(stats(0.2)), 1 / 5));
// Coiled Spring: +0.04 per stack, four stacks. The card's own text promises
// "from 5 to 3", so this is the card being honest rather than an arbitrary
// ladder — if the rounding ever stops landing on 3 the card's copy is a lie.
check('one stack of Coiled Spring -> 4 pips', pipCount(stats(0.24)) === 4);
check('four stacks -> 3 pips, exactly as the card says', pipCount(stats(0.36)) === 3);

console.log('\nA CHAIN ADDS A PIP PER LINK — the cost escalation, made countable');
resetStrike();
check('no chain -> base pips', pipCount(stats(0.2)) === 5);
chainStrike('strikeRelease');
check('one live link -> 6 pips', liveChain() === 1 && pipCount(stats(0.2)) === 6);
chainStrike('strikeRelease');
check('two live links -> 7 pips', pipCount(stats(0.2)) === 7);
// The ceiling that replaced chainRefillFloor: without one a deep chain reaches
// a bar that cannot practically be filled and dies to arithmetic.
for (let i = 0; i < 30; i++) chainStrike('strikeRelease');
check('capped at maxPips however deep the chain goes',
  pipCount(stats(0.2)) === CONFIG.strike.charge.maxPips);

console.log('\nAN EXPIRED CHAIN IS BACK TO BASE PRICE');
resetStrike();
chainStrike('strikeRelease');
chainStrike('strikeRelease');
check('the chain is live and the bar is dearer', pipCount(stats(0.2)) === 7);
// chainCount is left standing until the window expires, so this is the case
// that used to have every caller spelling out its own liveChain() check.
tick(CONFIG.strike.chainWindow + 0.01);
check('window expired -> back to 5 pips', pipCount(stats(0.2)) === 5);
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
  resetStrike();
  strikeState.charge = 0;
  // Written directly rather than earned through chainStrike: the sources are
  // individually rate-limited, so building six real links here would be
  // testing the throttles instead of the price.
  strikeState.chainCount = depth;
  strikeState.chainTimer = depth > 0 ? CONFIG.strike.chainWindow : 0;
  let eaten = 0;
  while (strikeState.charge < 1 && eaten < 200) { feedChum(stats(refill)); eaten++; }
  return eaten;
}
let sweepBad = [];
for (let depth = 0; depth <= 14; depth++) {
  resetStrike();
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
  resetStrike();
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
resetStrike();
strikeState.charge = 0.5;   // deliberately off a 5-pip boundary
feedChum(stats(0.2));
check('half a bar plus one pip is exactly 0.7', near(strikeState.charge, 0.7, 1e-9));
resetStrike();
strikeState.charge = 0.79;  // a hair under full at 5 pips (0.8 is pip 4)
feedChum(stats(0.2));
check('0.79 + one pip does not snap to full', strikeState.charge < 1);

console.log('\nEVERY PIP BOUNDARY IS BOOKED, AND DRAINS ON A FLOOR');
resetStrike();
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
resetStrike();
strikeState.charge = 0;
restoreCharge(stats());
check('fills the bar outright', near(strikeState.charge, 1));
check('and books every pip it crossed', pendingPips() === pipCount(stats()));

console.log('\nTOPPING UP A FULL BAR BOOKS NOTHING');
resetStrike();
strikeState.charge = 1;
feedChum(stats());
check('no pips queued against a bar already full', pendingPips() === 0);

console.log('\nTHE QUEUE IS BOUNDED');
resetStrike();
strikeState.charge = 0;
// Far more crossings than a bar can hold, as a stand-in for a pathological
// frame. The backlog is trimmed from the FRONT so the run always ENDS on the
// pip that actually closed the ring.
for (let i = 0; i < 200; i++) { strikeState.charge = 0; feedChum(stats()); }
check('backlog never exceeds maxPips',
  pendingPips() <= (CONFIG.strike.charge.maxPips ?? 12));

console.log('\nRESET CLEARS THE TICK QUEUE');
resetStrike();
check('a new run starts silent', pendingPips() === 0);
check('and with a full bar', near(strikeState.charge, 1));

// ============================================================================
// THE TWO-COUNTER CHAIN — pips drive the MULTIPLIER, bars drive the PRICE.
// ============================================================================

console.log('\nEVERY MOUTHFUL FEEDS THE MULTIPLIER, NOT JUST A FULL BAR');
resetStrike();
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
resetStrike();
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
resetStrike();
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
resetStrike();
strikeState.charge = 0;
strikeState.active = false;
feedChum(stats());
check('eating outside a combo starts nothing', strikeState.chainPips === 0);
check('  ...but still refills the bar', strikeState.charge > 0);

console.log('\nBARS STILL DRIVE THE PRICE, INDEPENDENTLY OF THE MULTIPLIER');
resetStrike();
strikeState.active = true;
strikeState.charge = 0;
check('base price is the base pip count', pipCount(stats()) === per);
for (let i = 0; i < per; i++) feedChum(stats());   // fills the bar exactly once
check('a full bar is worth a whole link of multiplier',
  near(chainLevel(stats()), 1, 1e-9));
// The link itself is scored by the caller (chainFrom -> chainStrike), which is
// what moves the bar counter. The price only moves with THAT.
chainStrike('strikeRelease');
check('and scoring the link is what raises the price', pipCount(stats()) === per + 1);
check('  ...while the multiplier is unchanged by the price rising',
  near(chainLevel(stats()), 1, 1e-9));

console.log('\nTHE MULTIPLIER DOES NOT FALL BACKWARDS WHEN A LINK LANDS');
// chainLevel divides by the BASE pip count, never the live one. Dividing by a
// count that grows with each link would make earning a link visibly slow the
// seal down — the exact opposite of what a link is for.
resetStrike();
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
resetStrike();
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
resetStrike();
strikeState.active = true;
const pull = magnetSpeed(0);
check(`striking pull (${pull.toFixed(1)} u/s) beats dashSpeed (${CONFIG.strike.dashSpeed})`,
  pull > CONFIG.strike.dashSpeed);
strikeState.active = false;

console.log('\nWHILE DASHING THE REACH IS A CORRIDOR, NOT A CIRCLE');
resetStrike();
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

console.log('\nA LINK NEEDS BOTH HALVES: FOOD EATEN, AND A WINDOW STILL OPEN');
resetStrike();
// Strike one. Nothing eaten yet, so it scores nothing — it opens the window.
strikeState.pending = 1;
check('the opening strike fires', tryStrike(dir, stats()) === true);
check('  ...but scores no link — nothing was eaten for it', consumeStrikeLink().chain === 0);
check('  ...and it opens the window so eating starts counting',
  strikeState.chainTimer > 0);

// Eat a bar's worth, then strike again inside the window.
strikeState.charge = 0;
for (let i = 0; i < linkPips(stats()); i++) feedChum(stats());
check(`${linkPips(stats())} mouthfuls arm the next release (a ${pipCount(stats())}-pip bar)`,
  strikeState.pipsSinceStrike >= linkPips(stats()));
strikeState.pending = 1;
check('the second strike fires', tryStrike(dir, stats()) === true);
const link1 = consumeStrikeLink().chain;
check('  ...and THIS one scores the link', link1 === 1);
check('  ...clearing the counter behind it', strikeState.pipsSinceStrike === 0);
check('  ...and the link only reads once', consumeStrikeLink().chain === 0);

console.log('\nSTRIKING WITHOUT EATING SCORES NOTHING');
resetStrike();
strikeState.pending = 1; tryStrike(dir, stats()); consumeStrikeLink();
strikeState.pending = 1;
tryStrike(dir, stats());
check('a second strike on an unfed bar is not a link', consumeStrikeLink().chain === 0);

console.log('\nEATING WITHOUT STRIKING SCORES NOTHING EITHER');
// This is the whole change: the bar reaching full used to BE the link. Now it
// only arms one, and the strike is what cashes it.
resetStrike();
strikeState.pending = 1; tryStrike(dir, stats()); consumeStrikeLink();
strikeState.charge = 0;
for (let i = 0; i < linkPips(stats()); i++) feedChum(stats());
check('eating alone scores no link', strikeState.chainCount === 0);
check('  ...it only arms one', strikeState.pipsSinceStrike >= linkPips(stats()));

console.log('\nTHE WINDOW STILL HAS TO BE OPEN');
resetStrike();
strikeState.pending = 1; tryStrike(dir, stats()); consumeStrikeLink();
strikeState.charge = 0;
for (let i = 0; i < linkPips(stats()); i++) feedChum(stats());
strikeState.active = false;
tick(CONFIG.strike.chainWindow + 0.05);          // let it lapse
check('the window lapsed', strikeState.chainTimer <= 0);
strikeState.pending = 1;
tryStrike(dir, stats());
check('a fed strike after the window shut scores nothing', consumeStrikeLink().chain === 0);
check('  ...but it opens a fresh window', strikeState.chainTimer > 0);

console.log('\nONE TURN OF THE CYCLE IS EXACTLY ONE LINK');
// chumFull and strikeRelease are the same event seen twice. A tuning snapshot
// can pin chumFull on, so the rule that stops them double-scoring is
// structural rather than a config default — this is the check that it holds.
resetStrike();
const wasChumFull = CONFIG.strike.chainOn.chumFull;
CONFIG.strike.chainOn.chumFull = true;           // as a stale snapshot would
strikeState.pending = 1; tryStrike(dir, stats()); consumeStrikeLink();
strikeState.charge = 0;
for (let i = 0; i < linkPips(stats()); i++) feedChum(stats());
check('chumFull is suppressed while strikeRelease is on',
  chainStrike('chumFull') === 0);
strikeState.pending = 1; tryStrike(dir, stats());
check('  ...so one refill-and-spend is one link, not two',
  consumeStrikeLink().chain === 1 && strikeState.chainCount === 1);
CONFIG.strike.chainOn.chumFull = wasChumFull;

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
resetStrike();
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
resetStrike();
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
function collects(orbX, player, maxFrames = 400) {
  resetPickups(scene);
  resetStrike();
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

console.log('\nTHE CORRIDOR ONLY EVER ADDS REACH, NEVER TAKES IT');
// magnetDistance swaps to a capsule while dashing. If that could ever return
// MORE than the radial distance, dashing would collect less than drifting —
// the exact regression this section exists to rule out.
resetStrike();
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
// THE LOOSENING — a link costs a FRACTION of the bar, and the window is time
// the player can actually use.
// ============================================================================

console.log('\nA LINK COSTS LESS THAN A WHOLE BAR');
resetStrike();
const frac = CONFIG.strike.linkBarFraction;
check('the fraction is a real discount', frac < 1);
check(`a ${pipCount(stats())}-pip bar links for ${linkPips(stats())} mouthfuls`,
  linkPips(stats()) < pipCount(stats()));
check('but never for free', linkPips(stats()) >= 1);

// The escalation has to survive the discount — a link still has to cost more
// than the one before it, or the chain has no ceiling at all.
const ladder = [];
resetStrike();
for (let link = 0; link <= 5; link++) {
  strikeState.chainCount = link;
  strikeState.chainTimer = link > 0 ? CONFIG.strike.chainWindow : 0;
  ladder.push(linkPips(stats()));
}
resetStrike();
console.log(`          cost ladder: [${ladder}]  (was [5,6,7,8,9,10])`);
check('the ladder never goes backwards',
  ladder.every((v, i) => i === 0 || v >= ladder[i - 1]));
check('  ...and still climbs overall', ladder[5] > ladder[0]);

console.log('\nTHE WINDOW STARTS WHEN THE DASH ENDS, NOT AT THE RELEASE');
// A dash runs up to 0.48s. Starting the clock at the release spent nearly half
// a 1.1s window on the stretch the seal is committed and cannot act — and
// punished the biggest strikes hardest, since they dash longest.
resetStrike();
strikeState.pending = 1;
tryStrike(dir, stats());
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
// strike". The reset on release is what stops that being a hoarding exploit.
resetStrike();
for (let i = 0; i < 20; i++) feedChum(stats());   // graze with no window open
check('grazing banks progress', strikeState.pipsSinceStrike === 20);
strikeState.pending = 1;
tryStrike(dir, stats());
check('  ...but the release spends it all', strikeState.pipsSinceStrike === 0);
check('  ...so a hoard cannot buy two links', consumeStrikeLink().chain === 0);

console.log('\nBREAKING OUT OF A DASH STILL PAYS THE WINDOW');
// The subtle one. The dash's end is where the combo window starts, so a cancel
// that only cleared `active` would silently cost the player the window their
// strike paid for — invisible until chains quietly stop being reachable after
// any manual break-out. Both endings go through finishDash for that reason.
resetStrike();
strikeState.pending = 1;
tryStrike(dir, stats());
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
resetStrike();
strikeState.pending = 1;
tryStrike(dir, stats());
consumeStrikeLink();
strikeState.chainTimer = 0;
let g = 0;
while (strikeState.active && g < 600) { tick(1 / 60); g++; }
check('letting it run out opens the same window',
  near(strikeState.chainTimer, CONFIG.strike.chainWindow, 0.02));
check('cancelling twice is harmless', (cancelDash(), cancelDash(), !strikeState.active));

console.log(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures ? 1 : 0);
