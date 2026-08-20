#!/usr/bin/env node
// Population-scaling profile: how does one frame of updateEnemies cost grow as
// the water fills? The recorded runs show p95 doubling exactly in the buckets
// where alive climbs past ~150, so this measures cost against alive count.
//
//   node --import ./tools/vite-loader.mjs scratchpad/crowd-profile.mjs

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { visualPoolCaps } from '../path/src/assets.js';
import {
  enemies, updateEnemies, updateSpawning, resetEnemies,
} from '../path/src/entities/enemies.js';

const realWarn = console.warn;
console.warn = (m, ...r) => {
  if (typeof m === 'string' && (m.startsWith('[animation]') || m.startsWith('[assets]') || m.startsWith('[config]'))) return;
  realWarn(m, ...r);
};

const scene = new THREE.Scene();
const dt = 1 / 60;
const playerPos = new THREE.Vector3(0, 0, 0);
const noop = () => {};

// Fill the water to `target` alive using the real spawner at a level-9-ish
// difficulty, then hold it there while we time.
function fill(target, difficulty, level) {
  resetEnemies(scene);
  const gs = { difficulty, level, time: difficulty / CONFIG.spawn.difficultyPerSecond };
  let guard = 0;
  while (enemies.length < target && guard++ < 20000) {
    updateSpawning(dt, gs, scene);
    // Let them move so they aren't all stacked on the spawn ring.
    updateEnemies(dt, scene, playerPos, noop, noop);
  }
  return enemies.length;
}

function timeFrames(n) {
  // Warm, then measure.
  for (let i = 0; i < 30; i++) updateEnemies(dt, scene, playerPos, noop, noop);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) updateEnemies(dt, scene, playerPos, noop, noop);
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6 / n;
}

// How many bodies opt into each of the two O(n^2) passes, which is the number
// that actually drives the quadratic term.
function census() {
  let separates = 0; let collides = 0; let schooling = 0; let hunts = 0;
  for (const e of enemies) {
    if (e.def.separates && !e.def.collides) separates++;
    if (e.def.collides) collides++;
    if (e.schoolId != null) schooling++;
    if (e.def.hunt) hunts++;
  }
  return { separates, collides, schooling, hunts };
}

console.log('\nalive   ms/frame   per-body us   separates  collides  schooling  hunts');
const rows = [];
for (const target of [25, 50, 100, 150, 200, 260]) {
  const alive = fill(target, 12, 9);
  const ms = timeFrames(200);
  const c = census();
  rows.push({ alive, ms });
  console.log(
    String(alive).padStart(5),
    ms.toFixed(3).padStart(10),
    (ms * 1000 / alive).toFixed(1).padStart(13),
    String(c.separates).padStart(10),
    String(c.collides).padStart(9),
    String(c.schooling).padStart(10),
    String(c.hunts).padStart(6),
  );
}

// Quadratic if per-body cost climbs with n; linear if it is flat.
const first = rows[0]; const last = rows[rows.length - 1];
const nRatio = last.alive / first.alive;
const msRatio = last.ms / first.ms;
console.log(`\n  ${first.alive} -> ${last.alive} bodies is ${nRatio.toFixed(1)}x the population`
  + ` and ${msRatio.toFixed(1)}x the frame cost.`);
console.log(`  linear would be ${nRatio.toFixed(1)}x, quadratic ${(nRatio * nRatio).toFixed(1)}x.\n`);

// ---------------------------------------------------------------------------
// ALLOCATION. The recorded runs report 11-20 GB collected against a ~240MB
// peak, which is 30-55 MB/s of garbage. That is what a doubled p95 looks like
// when no single frame is to blame: the collector is running constantly.
// ---------------------------------------------------------------------------
console.log('alive   KB/frame   MB/s at 60fps   allocations that scale with population');
for (const target of [25, 100, 200]) {
  const alive = fill(target, 12, 9);
  for (let i = 0; i < 60; i++) updateEnemies(dt, scene, playerPos, noop, noop);
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  const N = 300;
  for (let i = 0; i < N; i++) updateEnemies(dt, scene, playerPos, noop, noop);
  const after = process.memoryUsage().heapUsed;
  const kb = (after - before) / 1024 / N;
  console.log(
    String(alive).padStart(5),
    kb.toFixed(1).padStart(10),
    (kb * 60 / 1024).toFixed(1).padStart(15),
  );
}
console.log();

// ---------------------------------------------------------------------------
// WHAT IS ACTUALLY IN THE SCENE at a full house. updateEnemies is cheap, so the
// sustained cost at high population is not the behaviour code — it is how many
// separate things the renderer has to draw and skin every frame.
// ---------------------------------------------------------------------------
fill(220, 12, 9);
let skinned = 0; let bones = 0; let meshes = 0; let materials = new Set();
let skinnedBoneMax = 0;
for (const e of enemies) {
  e.mesh.traverse((o) => {
    if (o.isSkinnedMesh) {
      skinned++;
      const n = o.skeleton?.bones?.length ?? 0;
      bones += n;
      skinnedBoneMax = Math.max(skinnedBoneMax, n);
    } else if (o.isMesh) meshes++;
    if (o.material) materials.add(o.material.uuid);
  });
}
console.log(`At ${enemies.length} alive:`);
console.log(`  ${skinned} skinned meshes carrying ${bones} bones total (largest rig ${skinnedBoneMax} bones)`);
console.log(`  ${meshes} unskinned meshes`);
console.log(`  ${materials.size} distinct materials -> that many draw calls at minimum, none of them batched`);
console.log();

// ---------------------------------------------------------------------------
// WHICH KEYS, and what the body pool will hold for each. The cap used to be a
// flat 24 per asset key and this table is where that showed up: anything
// fielding more than 24 at once had the surplus disposed on death and cloned
// fresh next wave. The cap now follows each key's own peak live count, so the
// column to read is whether the pool is sized to the crowd this key actually
// fields — and the ceiling (96) is the only thing that can still clip it.
// ---------------------------------------------------------------------------
fill(220, 12, 9);
const byKey = new Map();
for (const e of enemies) {
  const k = e.visual?.name ?? e.def?.asset ?? e.key ?? 'unknown';
  byKey.set(k, (byKey.get(k) ?? 0) + 1);
}
const caps = visualPoolCaps();
console.log('key                     alive    pool cap   sized for this crowd?');
for (const [k, n] of [...byKey].sort((a, b) => b[1] - a[1])) {
  const cap = caps[k]?.cap ?? 0;
  const verdict = cap >= n ? 'yes' : `NO — ${n - cap} of every wave clones fresh`;
  console.log(`  ${String(k).padEnd(22)} ${String(n).padStart(5)}   ${String(cap).padStart(9)}   ${verdict}`);
}
console.log();
