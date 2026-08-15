#!/usr/bin/env node
// ---------------------------------------------------------------------------
// What a body costs when the pool misses, on the real rigs.
//
// Below POOL_PER_KEY (24) a spawn is a pool pop and costs nothing. Above it the
// spawn is a skeletonClone of the template plus a fresh THREE.Skeleton — and a
// Skeleton is a bone texture, which is a GPU upload on its first draw.
//
// This times that clone on the files the game actually ships, so the hitch has
// a size rather than a mechanism.
//
//   node --import ./tools/vite-loader.mjs tools/clone-cost-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
globalThis.createImageBitmap = async () => ({ width: 4, height: 4, close() {} });
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

async function parse(name) {
  const buf = readFileSync(resolve(HERE, '../public/models', name));
  const gltf = await new GLTFLoader().parseAsync(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
  );
  return gltf.scene;
}

function boneCount(root) {
  let n = 0;
  root.traverse((o) => { if (o.isSkinnedMesh) n = Math.max(n, o.skeleton?.bones?.length ?? 0); });
  return n;
}

function timeClone(template, n) {
  // Warm.
  for (let i = 0; i < 5; i++) skeletonClone(template);
  const t0 = process.hrtime.bigint();
  const kept = [];
  for (let i = 0; i < n; i++) kept.push(skeletonClone(template));
  const t1 = process.hrtime.bigint();
  // Bone textures the clones now own, which is the GPU half of the cost.
  let skeletons = 0;
  for (const k of kept) k.traverse((o) => { if (o.isSkinnedMesh) skeletons++; });
  return { ms: Number(t1 - t0) / 1e6 / n, skeletons: skeletons / n };
}

const FILES = ['fish.glb', 'fish2.glb', 'tang.glb', 'fishpack.glb', 'crabpincer.glb'];
console.log('\nCost of one body when the pool misses');
console.log('  model                bones   ms/clone   new skeletons each   ms per 30s of spawning');
for (const f of FILES) {
  if (!existsSync(resolve(HERE, '../public/models', f))) { console.log(`  ${f} — not on disk, skipped`); continue; }
  const template = await parse(f);
  const bones = boneCount(template);
  const { ms, skeletons } = timeClone(template, 60);
  // The recorded runs spawn 256-388 creatures per 30s bucket at levels 8-10,
  // and above the cap ~84% of those miss the pool (see pool-pressure-test).
  const spawnsPer30s = 300;
  const missRate = 0.84;
  console.log(
    `  ${f.padEnd(20)} ${String(bones).padStart(5)} ${ms.toFixed(2).padStart(10)} ${skeletons.toFixed(0).padStart(20)}`
    + `   ${(ms * spawnsPer30s * missRate).toFixed(0).padStart(10)}ms`,
  );
}
console.log('\n  The last column is CPU spent on cloning alone across one 30s bucket at level 8-10,');
console.log('  on top of a frame budget of 8ms. It is paid in bursts, on the frames creatures arrive.\n');
