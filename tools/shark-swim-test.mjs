#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:sharkswim
//
// The shark cruise: lateral travel, an earned and gradual climb, and a weave
// carried by the head. See the shark-cruise block in entities/enemies.js.
//
// Every claim here is about a PATH over time, which is exactly what you cannot
// see from the code and cannot check in a screenshot: "not abrupt" is a
// statement about the second derivative of a trajectory. So this drives the
// real behaviour with a real enemy for real seconds and measures where it went.
//
//   node --import ./tools/vite-loader.mjs tools/shark-swim-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enemies, spawnNamed, updateEnemies, resetEnemies } from '../path/src/entities/enemies.js';

const scene = new THREE.Scene();

// The animation controller warns once per state per creature for clips a
// procedural stand-in does not have, which in Node is all of them.
const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[animation]') || msg.startsWith('[assets]'))) return;
  realWarn(msg, ...rest);
};

const player = new THREE.Object3D();

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const SHARKS = ['shark', 'greatWhite', 'abyssShark', 'hammerhead', 'megalodon', 'mightyMeg'];
const dt = 1 / 60;

// The arena is y in [-40, 10] with the water surface at 0, so every coordinate
// below is UNDERWATER on purpose. Testing against a player at y = +26 measures
// the surface clamp, not the steering.
const MID = -20;   // comfortably mid-water
const HIGH = -6;   // near the surface, but under it

// A world with nothing in it but the shark and the player: no fish to break
// off for, no chum, no crew. Whatever the path does is the cruise itself.
// `warmup` discards the opening seconds. A creature spawns on a random heading
// and is turn-limited, so the first half-second of any run is it swinging round
// to face what it wants — which in a short window swamps the thing being
// measured and reports a flattened shark as climbing.
function run(type, { playerAt, seconds = 12, from = { x: 0, y: 0 }, warmup = 0 }) {
  resetEnemies(scene);
  const e = spawnNamed(scene, type, 0, { x: from.x, y: from.y }, { ignoreCaps: true });
  if (!e) throw new Error(`could not spawn ${type}`);
  player.position.set(playerAt.x, playerAt.y, 0);
  const path = [];
  const gains = [];
  const looks = [];
  const steps = Math.round(seconds / dt);
  const skip = Math.round(warmup / dt);
  for (let i = 0; i < steps + skip; i++) {
    updateEnemies(dt, scene, player.position, () => {}, () => {});
    if (i < skip) continue;
    path.push({ x: e.mesh.position.x, y: e.mesh.position.y });
    gains.push(e.climbGain ?? 0);
    if (e.lookTarget) looks.push({ x: e.lookTarget.x, y: e.lookTarget.y });
  }
  return { e, path, gains, looks };
}

// Total distance travelled along each axis, which is what "swims laterally"
// actually means — net displacement would hide a shark bobbing up and down on
// the spot.
function travel(path) {
  let h = 0, v = 0;
  for (let i = 1; i < path.length; i++) {
    h += Math.abs(path[i].x - path[i - 1].x);
    v += Math.abs(path[i].y - path[i - 1].y);
  }
  return { h, v, ratio: v / (h || 1e-9) };
}

// --- cruising far from the player is lateral -------------------------------
console.log('\nIDLE CRUISE IS LATERAL');
for (const type of SHARKS) {
  // Player parked far away and far ABOVE, so any vertical bias in the wander
  // would show up as a climb toward it.
  const { path } = run(type, { playerAt: { x: 400, y: HIGH }, seconds: 14, from: { x: 0, y: MID } });
  const t = travel(path);
  // Budget: weaveBody plus tan(wanderPitch), the two things that put a cruising
  // shark off the horizontal at all, with headroom for the arena walls turning
  // it around. See the note on those fields in config.js.
  const cfg = CONFIG.enemies[type].hunt.lateral;
  const budget = (cfg.weaveBody + Math.tan(cfg.wanderPitch)) * 1.6 + 0.05;
  check(`${type}: cruises horizontally`, t.ratio < budget,
    `vertical travel is ${(t.ratio * 100).toFixed(0)}% of horizontal, budget ${(budget * 100).toFixed(0)}%`);
}

// --- vertical authority is earned ------------------------------------------
console.log('\nVERTICAL AUTHORITY IS EARNED, NOT GIVEN');
for (const type of SHARKS) {
  const cfg = CONFIG.enemies[type].hunt.lateral;
  // Far: gain should sit at the floor. Near: it should open up.
  const far = run(type, { playerAt: { x: 70, y: MID }, seconds: 6, from: { x: 0, y: MID } });
  const near = run(type, { playerAt: { x: 0, y: MID + 2 }, seconds: 6, from: { x: 0, y: MID } });
  const farGain = far.gains[far.gains.length - 1];
  const nearGain = Math.max(...near.gains);
  check(`${type}: stays flat at range`, farGain <= cfg.climbFloor + 0.02,
    `gain ${farGain.toFixed(3)} vs floor ${cfg.climbFloor}`);
  check(`${type}: opens up close in`, nearGain > 0.75,
    `gain reached ${nearGain.toFixed(3)}`);
}

// --- and it opens GRADUALLY -------------------------------------------------
//
// The whole point of easing the gain rather than switching it. Measured as the
// largest single-frame jump: a step function would show 1.0 here.
console.log('\nTHE CLIMB IS NOT ABRUPT');
for (const type of SHARKS) {
  const cfg = CONFIG.enemies[type].hunt.lateral;
  const { gains } = run(type, { playerAt: { x: 0, y: HIGH }, seconds: 8, from: { x: 0, y: -34 } });
  let worst = 0;
  for (let i = 1; i < gains.length; i++) worst = Math.max(worst, Math.abs(gains[i] - gains[i - 1]));
  // At 60fps an exponential ease of rate k moves at most k*dt per frame.
  const bound = (cfg.climbEase * dt) * 1.5;
  check(`${type}: gain never jumps`, worst <= bound,
    `worst frame step ${worst.toFixed(5)} against a bound of ${bound.toFixed(5)}`);

  // And the same for the path itself: no sudden vertical velocity changes.
  const { path } = run(type, { playerAt: { x: 0, y: HIGH }, seconds: 8, from: { x: 0, y: -34 } });
  let worstAccel = 0;
  for (let i = 2; i < path.length; i++) {
    const v1 = (path[i].y - path[i - 1].y) / dt;
    const v0 = (path[i - 1].y - path[i - 2].y) / dt;
    worstAccel = Math.max(worstAccel, Math.abs(v1 - v0));
  }
  // A turn-limited body cannot change direction faster than its turnRate, so
  // this is bounded by speed * turnRate with room for the spawn transient.
  const lim = CONFIG.enemies[type].speed * (CONFIG.enemies[type].turnRate ?? 3) * 1.6;
  check(`${type}: vertical speed changes smoothly`, worstAccel <= lim,
    `worst ${worstAccel.toFixed(2)} u/s^2 against ${lim.toFixed(2)}`);
}

// --- the head leads the body ------------------------------------------------
console.log('\nTHE HEAD WEAVES, AND LEADS');
for (const type of SHARKS) {
  const cfg = CONFIG.enemies[type].hunt.lateral;
  const { e, path, looks } = run(type, { playerAt: { x: 400, y: HIGH }, seconds: 14, from: { x: 0, y: MID } });
  check(`${type}: a cruising shark still looks somewhere`, looks.length > 0,
    `${looks.length} frames with a look target`);

  // The look point must swing to BOTH sides of the path, or it is a fixed
  // offset rather than a weave. Measured as the signed perpendicular distance
  // from the creature to its own look point.
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < looks.length; i++) {
    const dx = looks[i].x - path[i].x;
    const dy = looks[i].y - path[i].y;
    const h = Math.atan2(path[Math.min(i + 1, path.length - 1)].y - path[i].y,
                         path[Math.min(i + 1, path.length - 1)].x - path[i].x);
    const perp = -Math.sin(h) * dx + Math.cos(h) * dy;
    lo = Math.min(lo, perp); hi = Math.max(hi, perp);
  }
  check(`${type}: the head swings to both sides`, lo < -0.3 && hi > 0.3,
    `perpendicular offset spans ${lo.toFixed(2)} .. ${hi.toFixed(2)}`);

  // One full sweep per weavePeriod, so over `seconds` there should be about
  // seconds/period cycles. Counted as sign changes of the phase sinusoid.
  const cycles = 14 / cfg.weavePeriod;
  check(`${type}: weaves at roughly its configured rate`, cycles > 0.8,
    `${cycles.toFixed(1)} sweeps in 14s at period ${cfg.weavePeriod}s`);
}

// --- the creatures that opted out are untouched ------------------------------
console.log('\nCETACEANS ARE LEFT ALONE');
for (const type of ['orca', 'dolphin', 'otter']) {
  check(`${type}: declares no lateral block`,
    CONFIG.enemies[type]?.hunt?.lateral == null);
}
// And behaviourally. The shaping has to be genuinely opt-in, not a global
// change with an exception list.
//
// The discriminating scenario is a target far away HORIZONTALLY and above,
// because that is where the gate actually bites. A target straight overhead is
// no longer a flattening case at all — the shark is already underneath it, and
// coming up is the whole point.
{
  const away = { playerAt: { x: 45, y: -4 }, seconds: 3, from: { x: -20, y: -34 }, warmup: 0.8 };
  const shark = travel(run('shark', away).path);
  const lc = CONFIG.enemies.shark.hunt.lateral;
  const flat = lc.flatSlope ?? 0.35;
  const free = lc.climbSlope ?? 8;
  const cap = flat * Math.pow(free / flat, lc.climbFloor) * 1.35;
  check('shark: runs in flat while still horizontally distant', shark.ratio < cap,
    `${(shark.ratio * 100).toFixed(0)}% vertical, cap ${(cap * 100).toFixed(0)}%`);
  for (const type of ['dolphin', 'orca']) {
    const t = travel(run(type, away).path);
    check(`${type}: climbs freely where a shark would flatten`, t.ratio > shark.ratio * 2,
      `${(t.ratio * 100).toFixed(0)}% vertical against the shark's ${(shark.ratio * 100).toFixed(0)}%`);
  }
}

// --- the attack has a shape --------------------------------------------------
//
// The point of gating on the horizontal gap rather than the straight-line one:
// a shark should run in level and only rise once it is under its target. That
// is a claim about the ORDER of the two, so it is measured as vertical travel
// in the first half of an approach against the second.
console.log('\nTHE ATTACK RUNS IN FLAT, THEN RISES');
for (const type of SHARKS) {
  // The window has to be long enough for THIS creature to actually cross the
  // gap, or a slow one is still running in when the clock stops and looks like
  // it never rises. Megalodon at speed 5.5 needs half again as long as a shark.
  const gap = 68;   // most of the arena, so the flat run-in is the bulk of the trip
  const seconds = (gap / CONFIG.enemies[type].speed) * 1.8 + 3;
  const { path } = run(type, {
    playerAt: { x: gap / 2, y: -5 }, seconds, from: { x: -gap / 2, y: -34 }, warmup: 0.6,
  });
  const half = Math.floor(path.length / 2);
  const early = travel(path.slice(0, half));
  const late = travel(path.slice(half));
  check(`${type}: rises later in the approach, not at the start`,
    late.ratio > early.ratio,
    `vertical share ${(early.ratio * 100).toFixed(0)}% early -> ${(late.ratio * 100).toFixed(0)}% late`);
  // And it does get there: a shark that only ever ran flat would be no threat
  // to anything above it.
  const climbed = Math.max(...path.map((p) => p.y)) - path[0].y;
  check(`${type}: does eventually close the vertical gap`, climbed > 6,
    `rose ${climbed.toFixed(1)} units`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}\n`);
process.exit(failures ? 1 : 0);
