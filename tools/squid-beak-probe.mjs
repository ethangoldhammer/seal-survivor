// WHERE IS THE BEAK, and which way does it point?
//
// The ink used to be emitted at the body origin, offset backwards along the
// direction of travel by a fraction of the radius. That is a guess dressed up as
// a number: it tracks the animal's TRAVEL rather than its POSE, so a squid that
// is turning inks out of its own flank.
//
// This measures the mouth chain through the game's own loader — installModel and
// createVisual, so the entry's fit, orientation and pivot are all applied — and
// reports where it sits in ENTITY space, the frame systems/kraken.js works in.
// Entity +Y is the direction of travel, +X is up the screen, Z is depth.
//
//   node --import ./tools/vite-loader.mjs tools/squid-beak-probe.mjs
import './dom-stub.mjs';
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ASSETS, installModel, createVisual } from '../path/src/assets.js';

const KEY = 'enemyGiantSquid';
const buf = readFileSync('public' + ASSETS[KEY].model);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
);
installModel(KEY, gltf.scene, gltf.animations);
const visual = createVisual(KEY);
const scene = new THREE.Scene();
scene.add(visual);
scene.updateMatrixWorld(true);

const box = new THREE.Box3().setFromObject(visual);
const size = box.getSize(new THREE.Vector3());
const centre = box.getCenter(new THREE.Vector3());
const num = (v) => (v >= 0 ? ' ' : '') + v.toFixed(3);

console.log(`body, in entity space: ${size.x.toFixed(2)} across x ${size.y.toFixed(2)} along travel x ${size.z.toFixed(2)} deep`);
console.log(`centre at ${num(centre.x)}, ${num(centre.y)}, ${num(centre.z)}\n`);

// The mouth chain, in the order the hierarchy runs it.
const MOUTH = [
  'mouthL002_14', 'mouthL001_13', 'mouthL_12', 'mouthR003_11',
  'mouthR002_10', 'mouthR001_9', 'mouthR_8', 'mouthL003_7',
];
// For contrast: the crown's roots and the mantle, so "is the beak between the
// arms" is answered by numbers rather than by the name.
const REFERENCE = {
  'crown FrontTTC root': 'FrontTTC_20',
  'crown SideTTCL root': 'SideTTCL_37',
  'crown SideTTCR root': 'SideTTCR_49',
  'mantle middlebone001': 'middlebone001_75',
  'mantle tip middlebone': 'middlebone_68',
  'eye L': 'EyeballL_57',
  'eye R': 'EyeballR_58',
};

const v = new THREE.Vector3();
const at = (name) => {
  const o = visual.getObjectByName(name);
  if (!o) return null;
  return o.getWorldPosition(v).clone();
};

console.log('the mouth chain (entity space; +Y is the way it swims)');
const mouthPts = [];
for (const name of MOUTH) {
  const p = at(name);
  if (!p) { console.log(`  ${name.padEnd(16)} MISSING`); continue; }
  mouthPts.push(p);
  console.log(`  ${name.padEnd(16)} ${num(p.x)}, ${num(p.y)}, ${num(p.z)}`);
}
const beak = mouthPts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / mouthPts.length);
console.log(`  MEAN (the beak)  ${num(beak.x)}, ${num(beak.y)}, ${num(beak.z)}`);

console.log('\nfor reference');
for (const [label, name] of Object.entries(REFERENCE)) {
  const p = at(name);
  console.log(`  ${label.padEnd(22)} ${p ? `${num(p.x)}, ${num(p.y)}, ${num(p.z)}` : 'MISSING'}`);
}

// The answers kraken.js needs, as FRACTIONS of the body — so they survive
// bosses.csv changing sizeMul and assets.csv changing size.
const mantle = at('middlebone001_75');
console.log('\nwhat systems/kraken.js needs');
console.log(`  the beak sits ${((beak.y - centre.y) / size.y * 100).toFixed(0)}% of the body's length ahead of centre`);
console.log(`  ...and ${((beak.x - centre.x) / size.x * 100).toFixed(0)}% of its width off the centreline`);
const jet = beak.clone().sub(mantle).normalize();
console.log(`  mantle -> beak points ${num(jet.x)}, ${num(jet.y)}, ${num(jet.z)} in entity space`);
console.log(`  (so a jet out of the mouth travels along the animal's own +Y, i.e. ahead of it)`);
