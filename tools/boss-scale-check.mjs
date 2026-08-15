// How big is each boss body, in world units, once the game has finished with it?
//
// Two numbers multiply and neither is readable on its own: `fit` in assets.js
// normalises the longest axis, and the `size` column in assets.csv multiplies
// the whole visual on top of that (see applyAssetSizesFromTable). A new boss
// needs a size row, and picking one by eye off the other rows means guessing at
// a product. This measures the product.
//
// Measured through installModel + createVisual — the path a spawn actually
// takes — so the fit, the orientation and the bind pose are all applied.
//
//   node --import ./tools/vite-loader.mjs tools/boss-scale-check.mjs
import './dom-stub.mjs';
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

import * as THREE from 'three';
import { readFileSync, existsSync } from 'node:fs';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ASSETS, installModel, createVisual, getAssetSizeMultiplier } from '../path/src/assets.js';
import { CONFIG } from '../path/src/config.js';

const KEYS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'enemyMegalodon', 'enemyOrcaBull', 'enemySquid', 'enemyGiantSquid',
];

const loader = new GLTFLoader();
const scene = new THREE.Scene();
const num = (v) => (Number.isFinite(v) ? v.toFixed(2) : '-');

// Which boss row, if any, drives this asset — its sizeMul multiplies again.
const BOSS_OF = {
  enemyMegalodon: 'bossShark',
  enemyOrcaBull: 'bossOrca',
  enemyGiantSquid: 'bossSquid',
};

console.log('asset               fit    csv    on screen (long x wide x deep)   boss sizeMul -> final long');
for (const key of KEYS) {
  const def = ASSETS[key];
  if (!def?.model) { console.log(`${key}: no model`); continue; }
  const path = 'public' + def.model;
  if (!existsSync(path)) { console.log(`${key}: missing ${path}`); continue; }

  const buf = readFileSync(path);
  const gltf = await loader.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  installModel(key, gltf.scene, gltf.animations);
  const visual = createVisual(key);
  const holder = new THREE.Object3D();
  holder.add(visual);
  scene.add(holder);
  scene.updateMatrixWorld(true);

  const size = new THREE.Box3().setFromObject(visual).getSize(new THREE.Vector3());
  // Under the game's side basis, entity +Y is travel and Z is depth into the
  // picture — so "long" is Y, not whichever axis happens to be biggest.
  const csv = getAssetSizeMultiplier(key);
  const bossId = BOSS_OF[key];
  const mul = bossId ? (CONFIG.bosses?.[bossId]?.sizeMul ?? null) : null;
  const long = size.y;

  console.log(
    `${key.padEnd(20)}${String(def.fit ?? '-').padEnd(7)}${num(csv).padEnd(7)}`
    + `${num(long)} x ${num(size.x)} x ${num(size.z)}`.padEnd(33)
    + (mul ? `${num(mul)} -> ${num(long * mul)}` : '(no boss row read here — bosses.csv owns it)'),
  );
  scene.remove(holder);
}
console.log('');
