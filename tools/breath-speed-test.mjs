#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:breathspeed
//
// THE BREATH AS SPEED — a full tank is the tuned ceiling and an empty one is
// `oxygen.speed.emptyMul` of it, across all three caps the player feels. Five
// things have to be true and none of them is visible to another test:
//
//   1. THE CURVE. 1 at full, 1 anywhere above the knee, emptyMul at nothing,
//      monotonic between — and 1 on every degenerate block (no tank, no
//      config, an oxygen argument nobody passed).
//   2. THE STASH. It is spent on the FINISHED block: a run holding speed cards
//      is throttled against its own upgraded ceiling, not the base one, and
//      re-spending it twice with the same bar does not compound.
//   3. THE THREE CAPS. updatePlayer's clamp, the turbo'd clamp and the dash
//      clamp all move by exactly the multiplier — measured through the real
//      updatePlayer rather than by reading the stat back.
//   4. THE FORECAST AGREES. predictDash draws the lens corridor; a throttled
//      dash it did not know about would promise reach the strike cannot make.
//   5. THE TIP DOES NOT FLICKER. strikeReach is the MAXIMUM — the first-run
//      weak-spot tip must not blink in and out with the bar.
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { baseStats, breathSpeedMul, stashBreathSpeed, applyBreathSpeed } from '../path/src/stats.js';
import { strikeReach, predictDash, resetStrike } from '../path/src/systems/strike.js';
import { player, updatePlayer, computeStats, recomputeStats, resetPlayer } from '../path/src/entities/player.js';

let failures = 0;
let checks = 0;
function check(label, cond, detail = '') {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`); }
  else console.log(`  ok    ${label}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const SPEED = CONFIG.oxygen.speed;
check('CONFIG.oxygen.speed exists', !!SPEED);
check('  ...and can only take speed away (emptyMul <= 1)', SPEED.emptyMul <= 1,
  `emptyMul=${SPEED.emptyMul}`);
check('  ...with a knee inside the bar (0 <= from <= 1)', SPEED.from >= 0 && SPEED.from <= 1,
  `from=${SPEED.from}`);

const EMPTY = SPEED.emptyMul;
const FROM = SPEED.from;

// ============================================================================
// 1. THE CURVE
// ============================================================================
console.log('\n1. the curve');
const tank = baseStats();
const cap = tank.maxOxygen;
check('a full tank is the tuned ceiling exactly', breathSpeedMul(tank, cap) === 1);
check('an empty tank is emptyMul', near(breathSpeedMul(tank, 0), EMPTY));
check('above the knee nothing is taken', near(breathSpeedMul(tank, cap * Math.min(1, FROM + 0.01)), 1));
check('at the knee nothing is taken (the ramp starts THERE)', near(breathSpeedMul(tank, cap * FROM), 1));
if (FROM > 0) {
  check('halfway down the ramp is halfway to emptyMul',
    near(breathSpeedMul(tank, cap * FROM * 0.5), EMPTY + (1 - EMPTY) / 2));
}
let monotonic = true;
let prev = EMPTY - 1e-9;
for (let i = 0; i <= 100; i++) {
  const m = breathSpeedMul(tank, (cap * i) / 100);
  if (m < prev - 1e-9 || m > 1 + 1e-9 || m < EMPTY - 1e-9) monotonic = false;
  prev = m;
}
check('never rises above 1, never falls below emptyMul, never goes backwards', monotonic);

check('no oxygen argument measures a FULL tank', breathSpeedMul(tank) === 1);
check('an overfilled bar is worth a full breath and no more', breathSpeedMul(tank, cap * 3) === 1);
check('a negative bar is worth an empty one, not a bonus', near(breathSpeedMul(tank, -50), EMPTY));
check('a block with no tank is left alone', breathSpeedMul({ maxOxygen: 0 }, 0) === 1);
check('a null block is left alone', breathSpeedMul(null, 0) === 1);

// emptyMul 1 (and anything above it) is the off switch.
const savedEmpty = SPEED.emptyMul;
SPEED.emptyMul = 1;
check('emptyMul 1 switches the whole thing off', breathSpeedMul(tank, 0) === 1);
SPEED.emptyMul = 1.5;
check('  ...and an emptyMul above 1 is read as off, not as a bonus', breathSpeedMul(tank, 0) === 1);
SPEED.emptyMul = savedEmpty;

// ============================================================================
// 2. THE STASH
// ============================================================================
console.log('\n2. the stash');
const built = computeStats([], 1, 0, 0, undefined);
check('computeStats stashes the full-tank caps', !!built.breathBase
  && near(built.breathBase.maxSpeed, CONFIG.player.maxSpeed)
  && near(built.breathBase.strikeDashSpeed, CONFIG.strike.dashSpeed));
check('  ...and a block built with no run in hand is at full speed',
  near(built.maxSpeed, CONFIG.player.maxSpeed) && near(built.strikeDashSpeed, CONFIG.strike.dashSpeed));

const drowning = computeStats([], 1, 0, 0, 0);
check('a block built on an empty tank is throttled',
  near(drowning.maxSpeed, CONFIG.player.maxSpeed * EMPTY)
  && near(drowning.strikeDashSpeed, CONFIG.strike.dashSpeed * EMPTY));
check('  ...and still remembers what full speed was',
  near(drowning.breathBase.maxSpeed, CONFIG.player.maxSpeed));

// Re-spending is idempotent, and it throttles the UPGRADED ceiling.
const fast = baseStats();
fast.maxSpeed *= 2;
fast.strikeDashSpeed *= 2;
stashBreathSpeed(fast);
applyBreathSpeed(fast, 0);
const once = fast.maxSpeed;
applyBreathSpeed(fast, 0);
check('re-spending the same bar does not compound', near(fast.maxSpeed, once));
check('a speed card is throttled against its OWN ceiling',
  near(fast.maxSpeed, CONFIG.player.maxSpeed * 2 * EMPTY));
applyBreathSpeed(fast, fast.maxOxygen);
check('a breath hands the whole upgraded ceiling back',
  near(fast.maxSpeed, CONFIG.player.maxSpeed * 2)
  && near(fast.strikeDashSpeed, CONFIG.strike.dashSpeed * 2));

const unstashed = baseStats();
const wasSpeed = unstashed.maxSpeed;
applyBreathSpeed(unstashed, 0);
check('a block that was never stashed is a no-op, not a crash', unstashed.maxSpeed === wasSpeed);

// ============================================================================
// 3. THE THREE CAPS — through the real updatePlayer.
// ============================================================================
console.log('\n3. the three caps');
resetStrike();
player.mesh = new THREE.Group();
player.body = new THREE.Group();
recomputeStats();
const DT = 1 / 60;
const still = { move: new THREE.Vector2(0, 0), aim: new THREE.Vector2(1, 0) };

// One frame at a given tank, from a velocity way over every ceiling: what
// comes back is the clamp, with one frame of drag divided back out.
function clampAt(oxygen, { turbo = 0, dash = false } = {}) {
  resetPlayer();
  player.mesh.position.set(0, -8, 0);
  player.oxygen = oxygen;
  // The clamp reads the block as the LAST frame left it, so spend the bar
  // before the frame rather than waiting for updatePlayer's own respend — this
  // is the steady state a dive is in, not the single frame after a refill.
  applyBreathSpeed(player.stats, oxygen);
  const base = player.stats.breathBase;
  player.velocity.set(Math.max(base.maxSpeed, base.strikeDashSpeed) * 4, 0);
  player.turbo = turbo;
  if (dash) player.dashTimer = 1;
  updatePlayer(DT, still);
  player.dashTimer = 0;
  player.turbo = 0;
  return player.velocity.x / Math.pow(player.stats.friction, DT * 60);
}

const fullCap = player.stats.breathBase.maxSpeed;
const dashCap = player.stats.breathBase.strikeDashSpeed;
const turboMul = player.stats.turboSpeedMul;

check('the swim ceiling on a full tank is the tuned one', near(clampAt(cap), fullCap, 1e-4),
  `${clampAt(cap).toFixed(4)} vs ${fullCap.toFixed(4)}`);
check(`  ...and on an empty one it is emptyMul (${EMPTY}) of it`,
  near(clampAt(0), fullCap * EMPTY, 1e-4), `${clampAt(0).toFixed(4)}`);

check('the turbo ceiling on a full tank is turboSpeedMul of it',
  near(clampAt(cap, { turbo: 1 }), fullCap * turboMul, 1e-4));
check('  ...and it is throttled by exactly the same fraction',
  near(clampAt(0, { turbo: 1 }), fullCap * turboMul * EMPTY, 1e-4),
  `${clampAt(0, { turbo: 1 }).toFixed(4)} vs ${(fullCap * turboMul * EMPTY).toFixed(4)}`);

check('the dash ceiling on a full tank is the tuned dash speed',
  near(clampAt(cap, { dash: true }), Math.max(dashCap, fullCap * 1), 1e-4));
check('  ...and it is throttled too',
  near(clampAt(0, { dash: true }), Math.max(dashCap, fullCap) * EMPTY, 1e-4),
  `${clampAt(0, { dash: true }).toFixed(4)}`);

// A dive does it on its own: swim underwater until the bar crosses the knee.
resetPlayer();
player.mesh.position.set(0, -8, 0);
player.oxygen = player.stats.maxOxygen;
const ceilingFull = player.stats.maxSpeed;
let crossed = 0;
for (let i = 0; i < 60 * 60 && player.oxygen > 0; i++) {
  player.mesh.position.set(0, -8, 0); // pinned under: no surfacing, no refill
  updatePlayer(DT, still);
  if (player.stats.maxSpeed < ceilingFull - 1e-9) crossed++;
}
check('a dive really spends it — the ceiling falls as the bar does', crossed > 0);
check('  ...to exactly emptyMul at the bottom', near(player.stats.maxSpeed, ceilingFull * EMPTY, 1e-4),
  `${player.stats.maxSpeed.toFixed(4)} vs ${(ceilingFull * EMPTY).toFixed(4)}`);
check('  ...and the drowned seal still knows its full-tank ceiling',
  near(player.stats.breathBase.maxSpeed, ceilingFull));

// And a breath hands it back.
for (let i = 0; i < 600 && player.oxygen < player.stats.maxOxygen; i++) {
  player.mesh.position.set(0, 100, 0);
  updatePlayer(DT, still);
}
check('surfacing hands the whole ceiling back', near(player.stats.maxSpeed, ceilingFull, 1e-4));

// ============================================================================
// 4. THE FORECAST AGREES
// ============================================================================
console.log('\n4. the forecast');
const forecastStats = computeStats([], 1, 0, 0, undefined);
const move = new THREE.Vector2(0, 0);
const aim = new THREE.Vector2(1, 0);
const reachFull = predictDash(move, aim, 1, forecastStats, 1).reach;
const forecastEmpty = computeStats([], 1, 0, 0, 0);
const reachEmpty = predictDash(move, aim, 1, forecastEmpty, 1).reach;
check('the lens corridor shortens on a low tank', reachEmpty < reachFull,
  `${reachEmpty.toFixed(3)} vs ${reachFull.toFixed(3)}`);
check('  ...by about the multiplier, not by some other amount',
  Math.abs(reachEmpty / reachFull - EMPTY) < 0.02,
  `ratio ${(reachEmpty / reachFull).toFixed(4)} vs ${EMPTY}`);

// ============================================================================
// 5. THE TIP DOES NOT FLICKER
// ============================================================================
console.log('\n5. the tip');
check('strikeReach is the same on a full tank and an empty one',
  near(strikeReach(forecastStats), strikeReach(forecastEmpty)),
  `${strikeReach(forecastStats).toFixed(4)} vs ${strikeReach(forecastEmpty).toFixed(4)}`);
check('  ...and it is the FULL-tank reach, not the throttled one',
  strikeReach(forecastEmpty) > forecastEmpty.strikeDashSpeed * forecastEmpty.strikeDashDuration);
check('a block with no stash still measures a reach', strikeReach(baseStats()) > 0);

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
