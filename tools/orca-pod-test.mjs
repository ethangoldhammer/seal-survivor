#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:orca
//
// The orca family is supposed to read as a POD: three animals swimming with the
// seal, one of them peeling off at a time to hit something big, then rejoining.
// For a long time it read as a vortex instead — three orcas circling, never
// quite in formation and never quite landing.
//
// None of that is visible from a screenshot, and the Browser pane suspends
// requestAnimationFrame anyway, so it is not visible from the preview either.
// It is only visible over TIME: how long an orca spends out of the line, how
// many are out at once, whether a charge ever ends. So this ticks the real
// system against a seal on a real course and measures those.
//
// THE THREE FAILURES IT GUARDS, each of which shipped:
//
//   1. THE UNCLOSABLE CIRCLE. A charge is turn-rate limited, so the tightest
//      arc an orca can fly is chargeSpeed / turnRate. When that was wider than
//      hitRadius (22 over a tuned 4.5, against a 2-unit hit), an orca that
//      arrived off-line could not converge — it orbited its target at exactly
//      the radius it was unable to shrink, forever, because landing the hit was
//      the only way out of the state. `charge is bounded` and `a charge that
//      cannot land gives up` are that bug.
//   2. THE POD THAT COULD NOT KEEP UP. Station-keeping capped the orca's speed
//      through the water at `cruiseSpeed`, a third of the seal's top speed, so
//      the pod was permanently being dragged: trail, catch up, swing past.
//      `the pod holds formation` is that one, and it is measured against a seal
//      moving at a real PACE — at a standstill the broken version held station
//      perfectly. It is a forward guard rather than a reproduction: that cap
//      was code, not a number, so no config here can put it back.
//   3. THE CLOUD. Nothing coordinated the three, so they left together.
//      `only one orca leaves at a time` is that.
//
// No renderer is involved — three.js Scene/Object3D are plain data here.
//
//   node --import ./tools/vite-loader.mjs tools/orca-pod-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { boats } from '../path/src/systems/boats.js';
import { player } from '../path/src/entities/player.js';
import { updateOrcaPod, resetOrcaPod, orcaPodDebug, podStats } from '../path/src/systems/orca.js';

const scene = new THREE.Scene();
const dt = 1 / 60;
let failures = 0;

// Same silence the other headless harnesses keep: no models are loaded in Node,
// so the animation controller warns once per state per creature and buries the
// results under identical lines.
const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && msg.startsWith('[animation]')) return;
  realWarn(msg, ...rest);
};

function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

function fakeEnemy(x, y, radius = 1.4, hp = 1e6) {
  const mesh = new THREE.Object3D();
  mesh.position.set(x, y, 0);
  return { mesh, radius, hp, vx: 0, vy: 0, flash: 0, hitThisFrame: false };
}

// Enough of a boat for hitsBoat() and damageBoat() — the same shape
// tools/ability-smoke.mjs builds, which is the contract systems/boats.js reads.
function fakeBoat(x, y, hp = 1e6) {
  const mesh = new THREE.Object3D();
  mesh.position.set(x, y, 0);
  return {
    mesh, hp, maxHp: hp, isTrawler: false, assetKey: 'boat',
    halfLength: 3, halfHeight: 0.8, offsetX: 0, offsetY: 0, radius: 3.2,
    knockX: 0, knockY: 0, rockVel: 0, flash: 0, dir: 1, sailX: x, spawnScale: 1,
  };
}

// THE SEAL, DRIVEN AS THE GAME DRIVES IT. `player.velocity` is what the pod
// station-keeps against, and it is a separate field from the position — a
// harness that teleports a position without writing the velocity is testing
// the spring alone and would pass the exact bug this file exists to catch.
function makeSwimmer() {
  const pos = new THREE.Vector3(0, -6, 0);
  player.velocity.set(0, 0);
  return {
    pos,
    // A wandering course at roughly two-thirds of the seal's top speed, with a
    // long turn in it. Slow enough to be an ordinary swim, fast enough that a
    // pod capped below it can never hold station.
    step(t) {
      const vx = Math.cos(t * 0.55) * 22;
      const vy = Math.sin(t * 0.37) * 10;
      player.velocity.set(vx, vy);
      pos.x += vx * dt;
      pos.y += vy * dt;
    },
  };
}

function reset() {
  resetOrcaPod(scene, new THREE.Vector3());
  boats.length = 0;
  player.velocity.set(0, 0);
}

const LEVEL = 3;
const c = CONFIG.orca;

// ---------------------------------------------------------------------------
section('THE SHIPPED NUMBERS ARE A POD');

// EVERY BEHAVIOUR CHECK BELOW READS ITS BOUND OUT OF THIS CONFIG, which is the
// only honest way to test a mechanism that is meant to be tunable — but it
// means each of them goes vacuous if the number it reads is set to something
// absurd. Run the harness with maxAttackers at 3 and "only one orca leaves at a
// time" passes with three orcas out; run it with an infinite leash and nothing
// can be dragged past it. So the tunable values are held to a shape HERE, once,
// and the checks below are then free to be about the code.
check('fewer orcas may leave than there are in the pod',
  c.maxAttackers >= 1 && c.maxAttackers < c.count,
  `${c.maxAttackers} of ${c.count}`);
check('a run has a clock on it', c.chargeMaxTime > 0 && c.chargeMaxTime <= 5,
  `${c.chargeMaxTime}s`);
check('an overshoot is small next to the hit it missed',
  c.overshootSlack > 0 && c.overshootSlack <= c.hitRadius * 2,
  `${c.overshootSlack} vs hit ${c.hitRadius}`);
// Above huntRange or the leash fires on chases the acquisition is still happily
// starting; not far above it, or it is not a leash.
check('the leash sits just outside the hunt range',
  c.leash > c.huntRange && c.leash < c.huntRange * 2,
  `leash ${c.leash}, hunt ${c.huntRange}`);

// ---------------------------------------------------------------------------
section('SWIMMING WITH THE SEAL');

reset();
{
  const swimmer = makeSwimmer();
  const enemies = [];
  // Settle first — the pod is built on the frame the card is picked and this
  // is measuring station-keeping, not the swim out to the line.
  for (let i = 0; i < 120; i++) {
    swimmer.step(i * dt);
    updateOrcaPod(dt, scene, swimmer.pos, LEVEL, enemies, {});
  }

  let worst = 0;
  let sum = 0;
  let samples = 0;
  for (let i = 0; i < 1800; i++) {
    swimmer.step((120 + i) * dt);
    updateOrcaPod(dt, scene, swimmer.pos, LEVEL, enemies, {});
    for (const m of orcaPodDebug()) {
      const d = Math.hypot(m.x - swimmer.pos.x, m.y - swimmer.pos.y);
      worst = Math.max(worst, d);
      sum += d;
      samples++;
    }
  }
  const mean = sum / samples;

  // The line sits |formationOffset| back plus up to a lane of spacing out, so
  // a pod genuinely in formation is inside roughly 8 units of the seal. The
  // ceiling is deliberately generous — this is not asserting a shape, it is
  // asserting the pod is NEAR THE SEAL, which is what a pod being dragged
  // along behind a faster animal is not.
  check('the pod holds formation while the seal swims', worst < 12,
    `worst ${worst.toFixed(1)} units, mean ${mean.toFixed(1)}`);

  // With nothing to hunt, nobody should ever leave the line.
  reset();
  const idle = makeSwimmer();
  let left = 0;
  for (let i = 0; i < 600; i++) {
    idle.step(i * dt);
    updateOrcaPod(dt, scene, idle.pos, LEVEL, [], {});
    if (orcaPodDebug().some((m) => m.state !== 'cruise')) left++;
  }
  check('an empty ocean keeps the whole pod in the line', left === 0, `${left} frame(s) out`);
}

// ---------------------------------------------------------------------------
section('BREAKING OFF, ONE AT A TIME');

reset();
{
  const swimmer = makeSwimmer();
  // Four big fish spread around the seal — enough that a pod inclined to leave
  // as a cloud has somewhere for each of them to go.
  const enemies = [
    fakeEnemy(14, -4), fakeEnemy(-13, -9), fakeEnemy(6, -18), fakeEnemy(-4, 8),
  ];
  let maxOut = 0;
  let anyOut = 0;
  const outFrames = new Map(); // slot -> frames spent out of the line
  for (let i = 0; i < 2400; i++) {
    swimmer.step(i * dt);
    // The fish are pinned to the seal's neighbourhood rather than left at fixed
    // world points, or a wandering seal simply leaves them all behind and the
    // pod has nothing to break off for.
    enemies.forEach((e, k) => {
      e.mesh.position.set(
        swimmer.pos.x + [14, -13, 6, -4][k],
        swimmer.pos.y + [-4, -9, -18, 8][k],
        0,
      );
    });
    updateOrcaPod(dt, scene, swimmer.pos, LEVEL, enemies, {});
    const state = orcaPodDebug();
    const out = state.filter((m) => m.state !== 'cruise').length;
    for (const m of state) {
      if (m.state !== 'cruise') outFrames.set(m.slot, (outFrames.get(m.slot) ?? 0) + 1);
    }
    maxOut = Math.max(maxOut, out);
    if (out > 0) anyOut++;
  }
  check('the pod does break off', anyOut > 0, `${(anyOut * dt).toFixed(1)}s out of the line`);
  check('only one orca leaves at a time', maxOut <= (c.maxAttackers ?? 1),
    `worst ${maxOut} out at once`);
  // ...and the duty cycle is PER ORCA, not per pod. With four big fish parked
  // around the seal for the whole run there is nearly always somebody making a
  // run — that is the pod working, not the swarm. What makes it read as a
  // family is that any GIVEN animal spends most of its time in the line and
  // takes a turn, which is a different measurement and the one worth holding.
  const worstDuty = Math.max(...[...outFrames.values()]) / 2400;
  check('each orca is in the line more than it is out',
    worstDuty < 0.5 && outFrames.size === CONFIG.orca.count,
    `busiest orca out ${(worstDuty * 100).toFixed(0)}% of the time, `
    + `${outFrames.size} of ${CONFIG.orca.count} took a turn`);
}

// ---------------------------------------------------------------------------
section('A CHARGE ENDS');

// THE VORTEX, REPRODUCED. A target that runs — fast enough and turning tighter
// than the orca can — is the exact case the old loop could not resolve: the
// only exits from `charge` were landing the hit and the target dying, so an
// orca that could not converge simply kept turning. Nothing here is allowed to
// leave an orca out of the line for longer than one run's clock.
reset();
{
  const seal = new THREE.Vector3(0, -6, 0);
  player.velocity.set(0, 0);
  // Uncatchable on purpose: it circles at the orca's own charge speed, so no
  // amount of turning closes on it.
  const runner = fakeEnemy(10, -6);
  const enemies = [runner];
  const s = podStats(LEVEL);

  let longestRun = 0;
  const runFor = new Map();
  for (let i = 0; i < 3600; i++) {
    const t = i * dt;
    runner.mesh.position.set(
      seal.x + Math.cos(t * 1.9) * 11,
      seal.y + Math.sin(t * 1.9) * 11,
      0,
    );
    runner.vx = -Math.sin(t * 1.9) * 11 * 1.9;
    runner.vy = Math.cos(t * 1.9) * 11 * 1.9;
    updateOrcaPod(dt, scene, seal, LEVEL, enemies, {});
    for (const m of orcaPodDebug()) {
      if (m.state === 'charge') {
        const run = (runFor.get(m.slot) ?? 0) + dt;
        runFor.set(m.slot, run);
        longestRun = Math.max(longestRun, run);
      } else runFor.set(m.slot, 0);
    }
  }
  // The clock is the hard bound; a healthy run ends on the overshoot test well
  // before it. One frame of slack for the tick that notices.
  check('a charge that cannot land gives up', longestRun <= (c.chargeMaxTime ?? 2.6) + dt * 2,
    `longest ${longestRun.toFixed(2)}s of ${(c.chargeMaxTime ?? 2.6).toFixed(2)}s`);

  // And the geometry that made the orbit possible in the first place. This is
  // an invariant between three config numbers, not a behaviour — but it is the
  // one that decides whether a run can ever converge, and it is invisible in
  // the config file where the three sit twenty lines apart.
  const circle = s.chargeSpeed / c.turnRate;
  check('the charge turning circle is on the order of the hit radius',
    circle < c.hitRadius * 2,
    `circle ${circle.toFixed(2)} vs hit ${c.hitRadius.toFixed(2)}`);
}

// A run that CAN land, against a sitting target, still has to land it — the
// bound above must not have been bought by making every charge time out.
reset();
{
  const seal = new THREE.Vector3(0, -6, 0);
  player.velocity.set(0, 0);
  const sitting = fakeEnemy(12, -6);
  let hits = 0;
  for (let i = 0; i < 1800; i++) {
    updateOrcaPod(dt, scene, seal, LEVEL, [sitting], {
      onEnemyDamaged: () => { hits++; },
    });
  }
  check('a run on a big fish connects', hits > 0, `${hits} hit(s) in 30s`);

  // The cadence the card sells. `attackInterval` is per orca, but only one is
  // ever out — so the pod's rate is the stagger and the travel, and it must
  // still be a rate rather than a trickle.
  check('...repeatedly', hits >= 6, `${hits} in 30s`);
}

// A hull, which is what the pod exists for.
reset();
{
  const seal = new THREE.Vector3(0, -6, 0);
  player.velocity.set(0, 0);
  boats.push(fakeBoat(11, 1));
  let boatHits = 0;
  for (let i = 0; i < 1800; i++) {
    updateOrcaPod(dt, scene, seal, LEVEL, [], {
      onBoatHit: () => { boatHits++; },
      onBoatDestroyed: () => {},
    });
  }
  check('a run on a boat connects', boatHits > 0, `${boatHits} hit(s) in 30s`);
}

// ---------------------------------------------------------------------------
section('THE LEASH');

// An escort that crosses the arena chasing something has stopped being one.
//
// The target starts comfortably inside `huntRange` — so a run really does start
// — and then retreats at just under the orca's own charge speed, which is the
// only shape of chase that can drag one across the arena. A slower target is
// caught and a faster one is never acquired; neither tests the leash.
reset();
{
  const seal = new THREE.Vector3(0, -6, 0);
  player.velocity.set(0, 0);
  const flee = podStats(LEVEL).chargeSpeed * 0.97;
  const fleeing = fakeEnemy(14, -6);
  fleeing.vx = flee;
  let worst = 0;
  let chased = 0;
  for (let i = 0; i < 1800; i++) {
    fleeing.mesh.position.x += flee * dt;
    updateOrcaPod(dt, scene, seal, LEVEL, [fleeing], {});
    for (const m of orcaPodDebug()) {
      if (m.state === 'charge') chased++;
      worst = Math.max(worst, Math.hypot(m.x - seal.x, m.y - seal.y));
    }
  }
  // Without this the check below is vacuous — a pod that never left the line
  // trivially never passes its leash, which is how this test read before the
  // retreat speed was set against the orca's own.
  check('the chase actually starts', chased > 0, `${(chased * dt).toFixed(1)}s charging`);
  // The bound is DERIVED rather than a round number with a margin on it. The
  // leash is tested once a frame while charging, so an orca may cross it by one
  // frame of charge; the follow-through it then carries decays at `overrunDrag`
  // e-folds a second, and the whole integral of that decay is v / overrunDrag.
  // Past this the leash is not firing at all, which is the only failure worth
  // reporting — the exact overshoot inside it is arithmetic, not behaviour.
  const s = podStats(LEVEL);
  const reach = c.leash + s.chargeSpeed * dt + s.chargeSpeed / (c.overrunDrag ?? 2.4);
  check('no orca is dragged past its leash', worst < reach,
    `worst ${worst.toFixed(1)}, leash ${c.leash.toFixed(0)} + ${(reach - c.leash).toFixed(1)} of follow-through`);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
