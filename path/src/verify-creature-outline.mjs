// Exercises the REAL addOutlineShells/makeOutlineMaterial from assets.js on a
// real multi-mesh skinned creature (shark.glb, 5 meshes), through the same
// clone path a spawn takes. Checks the three claims the design rests on:
//   1. one material shared by every shell, so tuner edits reach live instances
//   2. each shell binds the instance's EXISTING skeleton object, so three's
//      per-frame skeleton.update() dedup still collapses to one call
//   3. thickness stays in world units once divided by the accumulated scale
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
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import fs from 'node:fs';

const SRC = '/Users/ethangoldhammer/Projects/seal-survivor/path/src';
const { addOutlineShells, makeOutlineMaterial, setOutlineThicknessOn } = await import(`${SRC}/assets.js`);

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${msg}`); if (!ok) failures++; };

function stripTexturesGLB(buf) {
  let o = 12, json = null, bin = null;
  while (o < buf.length) {
    const len = buf.readUInt32LE(o), t = buf.toString('ascii', o + 4, o + 8);
    if (t === 'JSON') json = JSON.parse(buf.toString('utf8', o + 8, o + 8 + len));
    if (t.startsWith('BIN')) bin = buf.subarray(o + 8, o + 8 + len);
    o += 8 + len;
  }
  for (const m of json.materials || []) {
    for (const k of Object.keys(m)) if (/Texture$/.test(k)) delete m[k];
    if (m.pbrMetallicRoughness) for (const k of Object.keys(m.pbrMetallicRoughness)) if (/Texture$/.test(k)) delete m.pbrMetallicRoughness[k];
    if (m.extensions) for (const e of Object.values(m.extensions)) for (const k of Object.keys(e)) if (/Texture$/.test(k)) delete e[k];
  }
  delete json.textures; delete json.images; delete json.samplers;
  const js = Buffer.from(JSON.stringify(json), 'utf8');
  const jsPad = Buffer.concat([js, Buffer.alloc((4 - js.length % 4) % 4, 0x20)]);
  const head = Buffer.alloc(12); head.write('glTF', 0, 'ascii'); head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + jsPad.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsPad.length, 0); jh.write('JSON', 4, 'ascii');
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.write('BIN\0', 4, 'ascii');
  return Buffer.concat([head, jh, jsPad, bh, bin]);
}

// systems/outlines.js accumulatedScale, verbatim.
function accumulatedScale(obj) {
  let s = 1;
  for (let o = obj; o; o = o.parent) s *= (Math.abs(o.scale.x) + Math.abs(o.scale.y) + Math.abs(o.scale.z)) / 3;
  return s;
}

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

const FIT = 3.8;          // ASSETS.enemyShark.fit
const THICKNESS = 0.12;   // CONFIG.creatureOutline.thickness, world units

const raw = fs.readFileSync('/Users/ethangoldhammer/Projects/seal-survivor/public/models/shark.glb');
const stripped = stripTexturesGLB(raw);
const gltf = await new Promise((res, rej) =>
  new GLTFLoader().parse(stripped.buffer.slice(stripped.byteOffset, stripped.byteOffset + stripped.byteLength), '', res, rej));

// prepareModel's fit scale + the orient/wrapper groups, i.e. the template.
const model = gltf.scene;
model.updateMatrixWorld(true);
const pre = new THREE.Box3().setFromObject(model);
const preSize = new THREE.Vector3(); pre.getSize(preSize);
model.scale.multiplyScalar(FIT / (Math.max(preSize.x, preSize.y, preSize.z) || 1));
const orient = new THREE.Group(); orient.add(model);
const template = new THREE.Group(); template.add(orient);
template.updateMatrixWorld(true);

console.log('\n=== two spawns of enemyShark ===');
const material = makeOutlineMaterial({ color: 0xff7a3d });
const spawns = [];
for (let n = 0; n < 2; n++) {
  // createVisual's clone path for a skinned template.
  const inst = skeletonClone(template);
  const holder = new THREE.Group(); holder.add(inst); // the enemy's scene parent
  holder.updateMatrixWorld(true);
  const shells = addOutlineShells(inst, { material });
  spawns.push({ inst, shells });
  console.log(`  spawn ${n + 1}: ${shells.length} shells`);
}

const [a, b] = spawns;
check(a.shells.length === 5, `shark.glb outlines as 5 shells (got ${a.shells.length})`);
check(a.shells.length === b.shells.length, 'both spawns build the same number');

console.log('\n--- 1. one shared material ---');
const mats = new Set([...a.shells, ...b.shells].map((s) => s.material));
check(mats.size === 1, `all ${a.shells.length + b.shells.length} shells across both spawns share 1 material (got ${mats.size})`);
check([...mats][0] === material, 'and it is the one the caller passed in');

console.log('\n--- 2. shells bind the instance skeleton (no doubled skeleton.update) ---');
for (const { inst, shells } of spawns) {
  const realSkeletons = new Set();
  inst.traverse((o) => { if (o.isSkinnedMesh && !o.userData.__isOutline) realSkeletons.add(o.skeleton); });
  const shellSkeletons = new Set(shells.filter((s) => s.isSkinnedMesh).map((s) => s.skeleton));
  const shared = [...shellSkeletons].every((s) => realSkeletons.has(s));
  check(shared, `every shell skeleton is one of the creature's own (${shellSkeletons.size} shell / ${realSkeletons.size} real)`);
}
// The two spawns must NOT share, or they'd animate in lockstep.
const skelA = new Set(); a.inst.traverse((o) => { if (o.isSkinnedMesh) skelA.add(o.skeleton); });
const skelB = new Set(); b.inst.traverse((o) => { if (o.isSkinnedMesh) skelB.add(o.skeleton); });
check(![...skelB].some((s) => skelA.has(s)), 'separate spawns keep separate skeletons');

console.log('\n--- 3. world-unit thickness ---');
for (const shell of a.shells) {
  const scale = accumulatedScale(shell);
  setOutlineThicknessOn(shell.material, THICKNESS / scale);
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
  const err = Math.abs(mean - THICKNESS) / THICKNESS;
  check(err < 0.15, `${shell.name}: rim ${mean.toFixed(4)} vs target ${THICKNESS} (${(err * 100).toFixed(1)}% off)`);
}

console.log('\n--- 4. the off switch ---');
material.visible = false;
check(a.shells.every((s) => s.material.visible === false), 'one write hides every shell of every instance');
material.visible = true;
check(b.shells.every((s) => s.material.visible === true), 'and brings them all back');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
