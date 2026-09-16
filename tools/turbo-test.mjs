#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:turbo
//
// TURBO — the faster swim the seal blends into while winding up a strike with
// the stick held. Four things have to be true, and each is invisible to every
// other test in the suite if it breaks:
//
//   1. THE LATCH. Charging alone is not turbo, and neither is moving alone —
//      it takes both. Once it has caught it survives the stick going slack,
//      and it lets go on every way a hold can end: the dash firing, the button
//      coming up on nothing, and the bar burning to empty under the hold.
//   2. THE BLEND. 0..1, eased over rampIn / rampOut rather than stepped, and
//      never outside the range.
//   3. THE SWIM. updatePlayer really spends it: thrust by exactly the stat's
//      multiplier at full blend, the ordinary ceiling likewise, and the dash
//      ceiling untouched.
//   4. THE STUB. The three multipliers live on the stat block so a card can
//      scale them, and a scaled block is what the swim reads — not CONFIG.
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import {
  strikeState, resetStrike, updateCharge, updateTurbo, turboLerp, tryStrike, cancelDash, restoreCharge,
} from '../path/src/systems/strike.js';
import { baseStats } from '../path/src/stats.js';
import { player, updatePlayer, recomputeStats, resetPlayer } from '../path/src/entities/player.js';

let failures = 0;
let checks = 0;
function check(label, cond, detail = '') {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`); }
  else console.log(`  ok    ${label}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const T = CONFIG.strike.turbo;
check('CONFIG.strike.turbo exists and is on', !!T && T.enabled !== false);
CONFIG.strike.enabled = true;
CONFIG.strike.charge.startPips = 5;

// ============================================================================
// 1. THE LATCH
// ============================================================================
console.log('\n1. the latch');
const DT = 1 / 60;
const stats = baseStats();

function fresh() {
  resetStrike();
  strikeState.charge = 1;
}
function frame(held, move) {
  updateCharge(DT, held, stats);
  return updateTurbo(DT, move);
}

fresh();
frame(false, 1);
check('moving without holding is not turbo', !strikeState.turboOn && strikeState.turbo === 0);
frame(true, 0);
check('holding without moving is not turbo', !strikeState.turboOn && strikeState.turbo === 0);
frame(true, (T.moveMin ?? 0.3) * 0.5);
check('a stick resting under moveMin does not light it', !strikeState.turboOn);
frame(true, 1);
check('holding AND moving latches it', strikeState.turboOn && strikeState.turbo > 0);
frame(true, 0);
check('  ...and it survives the stick going slack mid-hold', strikeState.turboOn);

// Ends on release with nothing fired.
frame(false, 0);
check('the button coming up ends it', !strikeState.turboOn);

// Ends on the dash firing.
fresh();
for (let i = 0; i < 20; i++) frame(true, 1);
check('(setup) latched with power banked', strikeState.turboOn && strikeState.pending > 0);
const fired = tryStrike({ x: 1, y: 0 }, stats, 0);
frame(false, 1);
check('the release that fires the dash ends it', fired && !strikeState.turboOn);
cancelDash(strikeState);

// Ends when the bar burns dry under the hold.
fresh();
let ranDry = false;
for (let i = 0; i < 60 * 30 && !ranDry; i++) {
  frame(true, 1);
  if (strikeState.charge <= 0) ranDry = true;
}
check('(setup) the hold burned the bar to empty', ranDry);
frame(true, 1);
check('an empty bar ends it even with the button and stick still held', !strikeState.turboOn);

// Never on a run that never charges.
fresh();
strikeState.charge = 0;
frame(true, 1);
check('no fuel, no turbo', !strikeState.turboOn && strikeState.turbo === 0);

// ============================================================================
// 2. THE BLEND
// ============================================================================
console.log('\n2. the blend');
fresh();
const inFrames = Math.ceil((T.rampIn ?? 0) / DT);
let stepped = false, prev = 0, maxT = 0;
for (let i = 0; i < inFrames + 5; i++) {
  const t = frame(true, 1);
  if (t - prev > DT / Math.max(1e-9, T.rampIn) + 1e-9) stepped = true;
  prev = t; maxT = Math.max(maxT, t);
}
check(`eases in over rampIn (${T.rampIn}s) rather than stepping`, !stepped && near(maxT, 1));
check('  ...and never exceeds 1', maxT <= 1 + 1e-9);
let minT = 1; let below = false;
for (let i = 0; i < Math.ceil((T.rampOut ?? 0) / DT) + 5; i++) {
  const t = frame(false, 1);
  if (t < 0) below = true;
  minT = Math.min(minT, t);
}
check(`eases out over rampOut (${T.rampOut}s) back to 0`, near(minT, 0) && !below);
check('turbo ramping out still counts frames as NOT latched', !strikeState.turboOn);

// Re-latch mid-ramp-out resumes from where the blend is.
fresh();
for (let i = 0; i < inFrames + 2; i++) frame(true, 1);
frame(false, 1); frame(false, 1);
const partial = strikeState.turbo;
const t2 = frame(true, 1);
check('re-latching mid-ease resumes from the current blend, not from 0', partial < 1 && t2 > partial && near(t2, Math.min(1, partial + DT / T.rampIn), 1e-9));

// Off switch.
T.enabled = false;
fresh();
frame(true, 1);
check('turbo.enabled=false is off entirely', !strikeState.turboOn && strikeState.turbo === 0);
T.enabled = true;

// The lerp helper.
check('turboLerp: blend 0 is 1', turboLerp(1.5, 0) === 1);
check('turboLerp: blend 1 is the stat', near(turboLerp(1.5, 1), 1.5));
check('turboLerp: halfway is halfway', near(turboLerp(1.5, 0.5), 1.25));
check('turboLerp: a bad stat is a no-op', turboLerp(NaN, 1) === 1 && turboLerp(0, 1) === 1);

// ============================================================================
// 3. THE SWIM — the real updatePlayer, ratio against a control run.
// ============================================================================
console.log('\n3. the swim');
resetStrike();
player.mesh = new THREE.Group();
player.body = new THREE.Group();
recomputeStats();
const push = { move: new THREE.Vector2(1, 0), aim: new THREE.Vector2(1, 0) };
function sprint(turbo, mutate = null) {
  resetPlayer();
  // AFTER the reset — resetPlayer rebuilds the block, so a hand-scaled stat
  // applied before it is exactly the thing a real card's apply() survives and
  // a bare assignment does not.
  if (mutate) mutate(player.stats);
  player.mesh.position.set(0, -8, 0);
  player.velocity.set(0, 0);
  for (let t = 0; t < 0.15; t += DT) {
    player.turbo = turbo;
    updatePlayer(DT, push);
  }
  return player.velocity.x;
}
const plain = sprint(0);
const full = sprint(1);
const half = sprint(0.5);
const thrustMul = player.stats.turboThrustMul;
check(`thrust scales by exactly turboThrustMul (${thrustMul}) at full blend`, plain > 0 && near(full / plain, thrustMul, 1e-6), `${(full / plain).toFixed(4)}`);
check('  ...and by half of that at half blend', near(half / plain, turboLerp(thrustMul, 0.5), 1e-6));

function clampTo(turbo) {
  resetPlayer();
  player.mesh.position.set(0, -8, 0);
  player.velocity.set(player.stats.maxSpeed * 3, 0);
  player.turbo = turbo;
  updatePlayer(DT, { move: new THREE.Vector2(0, 0), aim: new THREE.Vector2(1, 0) });
  // One frame of drag sits on top of the clamp; divide it back out.
  return player.velocity.x / Math.pow(player.stats.friction, DT * 60);
}
const speedMul = player.stats.turboSpeedMul;
check('the ordinary ceiling is untouched with turbo off', near(clampTo(0), player.stats.maxSpeed, 1e-6));
check(`  ...and rises by exactly turboSpeedMul (${speedMul}) at full`, near(clampTo(1), player.stats.maxSpeed * speedMul, 1e-6), `${clampTo(1).toFixed(3)} vs ${(player.stats.maxSpeed * speedMul).toFixed(3)}`);

// The dash ceiling is not raised: with turbo at full and a dash live, the clamp
// still sits at strikeDashSpeed.
resetPlayer();
player.mesh.position.set(0, -8, 0);
player.velocity.set(player.stats.strikeDashSpeed * 3, 0);
player.turbo = 1;
player.dashTimer = 1;
updatePlayer(DT, { move: new THREE.Vector2(0, 0), aim: new THREE.Vector2(1, 0) });
const dashClamp = player.velocity.x / Math.pow(player.stats.friction, DT * 60);
check('the DASH ceiling is left alone', near(dashClamp, Math.max(player.stats.strikeDashSpeed, player.stats.maxSpeed * speedMul), 1e-6), dashClamp.toFixed(3));
player.dashTimer = 0;

// The swim cycle: setRate is handed the lerped anim multiplier every frame.
const rates = [];
const states = [];
const savedAnim = player.anim;
const wasAnim = CONFIG.animation.enabled;
CONFIG.animation.enabled = true;
player.anim = { setRate(r) { rates.push(r); }, update(_dt, st) { states.push(st); }, reset() {}, trigger() {}, isPlayingOneShot() { return false; } };
resetPlayer();
player.mesh.position.set(0, -8, 0);
player.turbo = 1; updatePlayer(DT, push);
player.turbo = 0; updatePlayer(DT, push);
check(`the swim cycle runs at turboAnimMul (${player.stats.turboAnimMul}) at full blend`, rates.length === 2 && near(rates[0], player.stats.turboAnimMul));
check('  ...and is put back to 1 the frame the blend is gone', near(rates[1], 1));

// NOT THE TAIL-UP CLIP. Over boostThreshold the picker says 'boost' (the
// fur seal's `sliding`); turbo has to read as the same stroke quickened, so
// with any blend live that is pinned back to 'swim'. Off the blend, the
// ordinary rule returns.
const over = CONFIG.animation.boostThreshold * 1.5;
states.length = 0;
resetPlayer();
player.mesh.position.set(0, -8, 0);
player.velocity.set(over, 0); player.turbo = 1; updatePlayer(DT, push);
player.velocity.set(over, 0); player.turbo = 0.01; updatePlayer(DT, push);
player.velocity.set(over, 0); player.turbo = 0; updatePlayer(DT, push);
check('over boostThreshold in turbo the seal plays SWIM, not the tail-up boost clip', states[0] === 'swim', states[0]);
check('  ...for as long as any of the blend is live', states[1] === 'swim', states[1]);
check('  ...and the ordinary boost rule returns once it is gone', states[2] === 'boost', states[2]);
CONFIG.animation.enabled = wasAnim;
player.anim = savedAnim;

// ============================================================================
// 4. THE STUB — stat block, not CONFIG.
// ============================================================================
console.log('\n4. the upgrade stub');
const b = baseStats();
check('turboThrustMul / turboSpeedMul / turboAnimMul are on the stat block',
  typeof b.turboThrustMul === 'number' && typeof b.turboSpeedMul === 'number' && typeof b.turboAnimMul === 'number');
check('  ...seeded from CONFIG.strike.turbo', b.turboThrustMul === T.thrustMul && b.turboSpeedMul === T.speedMul && b.turboAnimMul === T.animMul);
// A hypothetical card: scale the block and the swim follows the BLOCK.
const scaled = sprint(1, (st) => { st.turboThrustMul *= 1.4; });
check('a card that scales turboThrustMul is what the swim reads', near(scaled / plain, thrustMul * 1.4, 1e-6), `${(scaled / plain).toFixed(4)} vs ${(thrustMul * 1.4).toFixed(4)}`);
recomputeStats();
check('  ...and recomputeStats puts the base back', near(player.stats.turboThrustMul, T.thrustMul));

// A stat block with turbo off (mul 1) is exactly the old swim.
check('a block with the multipliers at 1 is the un-turbo\'d swim exactly',
  near(sprint(1, (st) => { st.turboThrustMul = 1; st.turboSpeedMul = 1; }) / plain, 1, 1e-9));
recomputeStats();

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
