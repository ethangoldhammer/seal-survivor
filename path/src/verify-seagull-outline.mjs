// The seagull wears an outline instead of an emissive mask. That swap rests on
// one number that cannot be eyeballed — `outline.thickness` is in the SOURCE
// FILE's units, and seagull.fbx is 73 units across, so the 0.02 every other
// static outline in ASSETS uses would be a rim 1/35th the intended width and
// would simply look like the feature is off.
//
// This drives the real ASSETS.seagull def through the real addOutlineShells and
// measures where the shell's vertices actually land in world space, the same way
// verify-creature-outline.mjs does for the tuned path. Run it after any change
// to the gull's `fit`, its `outline`, or its T-menu size multiplier:
//
//   node --import ./tools/vite-loader.mjs path/src/verify-seagull-outline.mjs
globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.ProgressEvent = class { constructor(t, o = {}) { Object.assign(this, o); this.type = t; } };
globalThis.document = {
  createElementNS: () => ({ style: {}, getContext: () => null, addEventListener() {}, removeEventListener() {} }),
  createElement: () => ({ style: {}, getContext: () => null, addEventListener() {}, removeEventListener() {} }),
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
globalThis.fetch = async () => ({ ok: false, status: 0, json: async () => ({}) });

import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SRC, '../..');
const { ASSETS, addOutlineShells } = await import(`${SRC}/assets.js`);

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${msg}`); if (!ok) failures++; };

// The rim width these numbers are chosen to produce: what CONFIG.creatureOutline
// draws on a shark, so an ally's border and a threat's are the same weight and
// only the colour distinguishes them.
const TARGET_WORLD_RIM = 0.12;
// assetLooks.seagull.sizeMultiplier, applied per instance by createVisual AFTER
// the shell is baked into the template — which is exactly why it belongs in this
// measurement rather than being something the shader compensates for.
const SIZE_MULTIPLIER = JSON.parse(
  fs.readFileSync(`${SRC}/imported-tuning.json`, 'utf8')
).assetLooks?.seagull?.sizeMultiplier ?? 1;

// verify-creature-outline.mjs shellWorld, verbatim: software skinning, because
// the offset happens in the vertex shader before the bones are applied and the
// only honest way to measure the result is to apply them the same way.
function shellWorld(mesh, i, uOutline) {
  const g = mesh.geometry;
  const p = new THREE.Vector3().fromBufferAttribute(g.attributes.position, i);
  if (uOutline) {
    const n = new THREE.Vector3().fromBufferAttribute(g.attributes.normal, i);
    p.addScaledVector(n, uOutline);
  }
  if (!mesh.isSkinnedMesh) return p.applyMatrix4(mesh.matrixWorld);
  const base = p.clone().applyMatrix4(mesh.bindMatrix);
  const si = new THREE.Vector4().fromBufferAttribute(g.attributes.skinIndex, i);
  const sw = new THREE.Vector4().fromBufferAttribute(g.attributes.skinWeight, i);
  const out = new THREE.Vector3();
  for (let k = 0; k < 4; k++) {
    const w = sw.getComponent(k); if (!w) continue;
    const b = si.getComponent(k);
    const m = new THREE.Matrix4().multiplyMatrices(mesh.skeleton.bones[b].matrixWorld, mesh.skeleton.boneInverses[b]);
    out.addScaledVector(base.clone().applyMatrix4(m), w);
  }
  out.applyMatrix4(mesh.bindMatrixInverse);
  return out.applyMatrix4(mesh.matrixWorld);
}

const def = ASSETS.seagull;

console.log('=== ASSETS.seagull ===');
check(def.texture?.emissive == null, 'carries no emissive mask any more');
check(def.outline != null, 'carries a static outline block');
check((def.outline?.glow ?? 1) > 1, `outline glows (glow = ${def.outline?.glow ?? 1})`);

const buf = fs.readFileSync(`${ROOT}/public/models/seagull.fbx`);
const root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');

// prepareModel's fit scale, then its orient/wrapper groups — i.e. the template
// as createVisual would find it in loadedModels.
root.updateMatrixWorld(true);
const size = new THREE.Vector3();
new THREE.Box3().setFromObject(root).getSize(size);
const span = Math.max(size.x, size.y, size.z) || 1;
console.log(`\nsource bbox ${size.toArray().map((n) => n.toFixed(2)).join(' x ')} — fit ${def.fit} over ${span.toFixed(2)}`);
root.scale.multiplyScalar(def.fit / span);
const orient = new THREE.Group(); orient.add(root);
const template = new THREE.Group(); template.add(orient);

// createVisual: clone, then the T-menu size multiplier on the instance root.
const inst = skeletonClone(template);
inst.scale.multiplyScalar(SIZE_MULTIPLIER);
const holder = new THREE.Group(); holder.add(inst);
holder.updateMatrixWorld(true);

console.log(`size multiplier ${SIZE_MULTIPLIER} — bird spans ${(def.fit * SIZE_MULTIPLIER).toFixed(2)} world units\n`);

// prepareModel line: `if (def.outline) addOutlineShells(model, def.outline)`.
// Attached to the instance here only so the measurement can walk a live world
// matrix; the shells are identical either way.
const shells = addOutlineShells(inst, def.outline);
holder.updateMatrixWorld(true);
check(shells.length > 0, `seagull.fbx outlines as ${shells.length} shell(s)`);

console.log('=== rim width, measured in world space ===');
for (const shell of shells) {
  const u = shell.material.userData.__outlineThickness.value;
  const g = shell.geometry;
  const n = g.attributes.position.count;
  const step = Math.max(1, Math.floor(n / 300));
  let sum = 0, samples = 0;
  for (let i = 0; i < n; i += step) {
    sum += shellWorld(shell, i, 0).distanceTo(shellWorld(shell, i, u));
    samples++;
  }
  const mean = sum / samples;
  const err = Math.abs(mean - TARGET_WORLD_RIM) / TARGET_WORLD_RIM;
  check(err < 0.15, `${shell.name}: rim ${mean.toFixed(4)} world vs target ${TARGET_WORLD_RIM} (${(err * 100).toFixed(1)}% off)`);
}

console.log('\n=== glow reaches the material colour ===');
const want = new THREE.Color(def.outline.color).multiplyScalar(def.outline.glow ?? 1);
const got = shells[0].material.color;
check(
  Math.abs(got.r - want.r) < 1e-6 && Math.abs(got.g - want.g) < 1e-6 && Math.abs(got.b - want.b) < 1e-6,
  `colour is 0x${def.outline.color.toString(16)} x ${def.outline.glow} = (${want.r.toFixed(3)}, ${want.g.toFixed(3)}, ${want.b.toFixed(3)})`
);
check(Math.max(got.r, got.g, got.b) > 1, `and lands above 1.0 (max channel ${Math.max(got.r, got.g, got.b).toFixed(3)}), so the bright-pass sees it`);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
