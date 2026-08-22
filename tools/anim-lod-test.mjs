#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE ANIMATION LOD: does a small body get posed less often, and does anything
// break when it does?
//
//   npm run test:animlod
//
// Every creature in the water used to be posed on every frame. The recorded
// runs say that is what the population slope is made of — frame rate falls
// with alive count at the same rate on a 1.4-megapixel phone as on a
// 6.0-megapixel laptop, which is only possible if the cost is per-creature.
//
// TWO THINGS MAKE THIS HARNESS LIE IF YOU LET THEM:
//
//   1. NO GLB LOADS IN NODE, so `e.anim` is null on every spawn and the whole
//      LOD block is skipped — a test written against the real controller would
//      pass without executing one line of the thing it tests. Every creature
//      gets a counting stub instead, installed after the spawn.
//   2. `e.radius` IS `def.radius * spawnScale`, and spawnScale is 1 here for
//      the same reason: no model, no fit. So the sizes a Node spawn reports
//      are the authored radii, NOT what the game runs at (the turtle's asset
//      alone is 3.08x). The radii are therefore set BY HAND on the stubs so
//      the tiers are exercised at the sizes the real roster has.
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enemies, updateEnemies, updateSpawning, resetEnemies } from '../path/src/entities/enemies.js';

const realWarn = console.warn;
console.warn = (m, ...r) => {
  if (typeof m === 'string' && /^\[(animation|assets|config)\]/.test(m)) return;
  realWarn(m, ...r);
};

let failures = 0;
function check(label, pass, detail = '') {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures++;
}

const scene = new THREE.Scene();
const playerPos = new THREE.Vector3(0, 0, 0);
const dt = 1 / 60;
const noop = () => {};

/** A controller that records every pose it is asked for. */
function stub() {
  const s = {
    poses: 0,
    dtSum: 0,
    frames: [],        // the frame index of each pose
    oneShot: false,
    hits: 0,
    isPlayingOneShot: () => s.oneShot,
    setBeatSync: noop,
    update(d, _state, hit) {
      s.poses++;
      s.dtSum += d;
      s.frames.push(frame);
      if (hit) s.hits++;
    },
  };
  return s;
}

let frame = 0;

/**
 * Fill the water, then give every creature a stub controller and a radius.
 * `sizes` is a list of radii dealt round-robin, so one run covers every tier.
 */
function setup(target, sizes) {
  resetEnemies(scene);
  const gs = { difficulty: 12, level: 9, time: 12 / CONFIG.spawn.difficultyPerSecond };
  let guard = 0;
  while (enemies.length < target && guard++ < 40000) {
    updateSpawning(dt, gs, scene);
    updateEnemies(dt, scene, playerPos, noop, noop);
  }
  enemies.forEach((e, i) => {
    e.anim = stub();
    e.radius = sizes[i % sizes.length];
    e.isBoss = false;
    // A fresh slot each setup, or a creature carried over from a previous
    // phase keeps its stagger and the counts stop being comparable.
    e.animTier = undefined;
    e.animPhase = undefined;
    e.animDt = 0;
  });
  return enemies.slice();
}

function run(frames) {
  for (let i = 0; i < frames; i++) {
    frame++;
    updateEnemies(dt, scene, playerPos, noop, noop);
  }
}

const lod = CONFIG.animation.lod;
const TINY = lod.tinyRadius - 0.1;   // in the tiny tier
const SMALL = lod.smallRadius - 0.1; // in the small tier
const BIG = lod.smallRadius + 1;     // full rate

// ---------------------------------------------------------------------------
console.log('\nPose rate by size');
{
  const N = 180;
  const all = setup(N, [TINY, SMALL, BIG]);
  const F = 180;
  run(F);

  const tier = (r) => all.filter((e) => e.radius === r);
  const posesOf = (r) => tier(r).reduce((a, e) => a + e.anim.poses, 0) / tier(r).length;

  const tiny = posesOf(TINY);
  const small = posesOf(SMALL);
  const big = posesOf(BIG);

  check('a full-rate body is posed every frame', Math.abs(big - F) <= 1, `${big.toFixed(1)} of ${F}`);
  check(`a small body is posed every ${lod.smallStride}`,
    Math.abs(small - F / lod.smallStride) <= 1.5, `${small.toFixed(1)}, expected ${(F / lod.smallStride).toFixed(1)}`);
  check(`a tiny body is posed every ${lod.tinyStride}`,
    Math.abs(tiny - F / lod.tinyStride) <= 1.5, `${tiny.toFixed(1)}, expected ${(F / lod.tinyStride).toFixed(1)}`);

  // THE POINT OF THE WHOLE THING, stated as the number it is meant to move.
  const total = all.reduce((a, e) => a + e.anim.poses, 0);
  const flat = all.length * F;
  check('the roster poses far less than once per body per frame',
    total < flat * 0.75, `${(total / flat * 100).toFixed(0)}% of ${flat.toLocaleString()}`);

  // ---- the clip still plays at its authored SPEED -------------------------
  // A skipped frame's delta is carried, not dropped. If it were dropped, a
  // tiny fish would swim at a third speed — which is the failure mode that
  // looks like an art bug and gets blamed on the clip.
  // Time the body has not been posed WITH yet is still sitting in its
  // accumulator, waiting for its slot — that is carried, not lost, so the sum
  // of the two is what has to match. Asserting on `dtSum` alone would fail by
  // however far into its stride the run happened to stop, which is a property
  // of when you looked rather than of the code.
  const worstDrift = Math.max(...all.map((e) => Math.abs((e.anim.dtSum + e.animDt) - F * dt)));
  check('no elapsed time is lost — carried, not dropped', worstDrift < 1e-9,
    `worst drift ${(worstDrift * 1000).toFixed(3)}ms over ${(F * dt).toFixed(2)}s`);

  // ---- and no single frame poses the whole roster -------------------------
  // A stride that is not staggered delivers the same total work as a periodic
  // spike, which is the hitching this exists to remove rather than a fix for
  // it. Counted per frame across the run.
  const perFrame = new Map();
  for (const e of all) for (const f of e.anim.frames) perFrame.set(f, (perFrame.get(f) ?? 0) + 1);
  const busiest = Math.max(...perFrame.values());
  const mean = [...perFrame.values()].reduce((a, c) => a + c, 0) / perFrame.size;
  check('the strides are staggered — no frame poses everything',
    busiest < mean * 1.35, `busiest frame ${busiest}, mean ${mean.toFixed(0)}, roster ${all.length}`);
}

// ---------------------------------------------------------------------------
console.log('\nThe three exemptions');
{
  const all = setup(60, [TINY]);
  // A boss, a performer and a body being shot: each must be posed every frame.
  const boss = all[0]; boss.isBoss = true;
  const performer = all[1]; performer.anim.oneShot = true;
  const struck = all[2];

  const F = 60;
  for (let i = 0; i < F; i++) {
    frame++;
    struck.hitThisFrame = true; // as combat.js sets it, every frame here
    updateEnemies(dt, scene, playerPos, noop, noop);
  }

  check('a boss is posed every frame however small', boss.anim.poses >= F - 1,
    `${boss.anim.poses} of ${F}`);
  check('a one-shot is posed every frame', performer.anim.poses >= F - 1,
    `${performer.anim.poses} of ${F}`);
  check('a body being hit is posed every frame', struck.anim.poses >= F - 1,
    `${struck.anim.poses} of ${F}`);
  check('and the flinch reaches the controller every time', struck.anim.hits >= F - 1,
    `${struck.anim.hits} hits delivered`);

  // A hit landing on what would have been a SKIPPED frame still gets through:
  // that is the whole reason `hitThisFrame` is cleared inside the branch.
  const rest = all[10];
  const before = rest.anim.hits;
  for (let i = 0; i < 6; i++) {
    frame++;
    rest.hitThisFrame = (i === 0);
    updateEnemies(dt, scene, playerPos, noop, noop);
  }
  check('a single hit is never swallowed by a skipped frame',
    rest.anim.hits === before + 1, `${rest.anim.hits - before} delivered`);
}

// ---------------------------------------------------------------------------
console.log('\nTurned off');
{
  const was = lod.enabled;
  lod.enabled = false;
  const all = setup(60, [TINY, SMALL, BIG]);
  const F = 40;
  run(F);
  const worst = Math.min(...all.map((e) => e.anim.poses));
  check('every body is posed every frame again', worst >= F - 1, `worst ${worst} of ${F}`);
  lod.enabled = was;
}

// ---------------------------------------------------------------------------
console.log('\nA long delta cannot reach the springs');
{
  // A tab returning from the background hands the loop a big elapsed time. The
  // loop clamps its own; this clamps what a POSE may advance, because the
  // spring solver is semi-implicit Euler and a large enough step is the one
  // thing that makes it blow up rather than merely look wrong.
  const all = setup(30, [TINY]);
  frame++;
  updateEnemies(2.0, scene, playerPos, noop, noop);
  const worst = Math.max(...all.map((e) => Math.max(...e.anim.frames.map(() => 0), 0)));
  const biggest = Math.max(...all.filter((e) => e.anim.poses > 0).map((e) => e.anim.dtSum));
  check('no pose advances more than the clamp', biggest <= 0.05 + 1e-9,
    `largest step ${biggest.toFixed(3)}s`, worst);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
