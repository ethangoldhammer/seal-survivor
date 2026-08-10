// seagull.fbx ships ONE 24.77s take with every animation baked end to end and
// no range markers, so which frames the gull plays is entirely a matter of the
// numbers in ASSETS.seagull.subclips being right. They were not: two of the
// three ranges were cut mid-transition and the "dive" was actually the landing,
// so every loop snapped through frames from a neighbouring take.
//
// Nothing about that is visible from reading the file — a wrong range is a
// plausible-looking pair of integers. This measures the poses instead:
//
//   1. every range LOOPS  — first and last frame are the same pose, so a
//      repeat is invisible rather than a snap
//   2. every range is AIRBORNE and in character — no ground frames, glide holds
//      its span, flap completes exactly one wingbeat, dive stays tucked
//   3. the dive's baked nose-down pitch is CANCELLED by the heading maths in
//      systems/seagull.js, so the bird falls the way it is pointing
//
//   node --import ./tools/vite-loader.mjs path/src/verify-seagull-clips.mjs
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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SRC, '../..');
const { ASSETS, orientationQuaternion } = await import(`${SRC}/assets.js`);
const { CONFIG } = await import(`${SRC}/config.js`);

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${msg}`); if (!ok) failures++; };

const def = ASSETS.seagull;
const FPS = def.subclipFps ?? 30;
const buf = fs.readFileSync(`${ROOT}/public/models/seagull.fbx`);
const root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
const clip = root.animations[0];

const bones = [];
root.traverse((o) => { if (o.isBone) bones.push(o); });
const find = (re) => bones.findIndex((b) => re.test(b.name));
const iPelvis = find(/Pelvis/i), iHead = find(/Head/i), iTail = find(/__Tail$/i);
const iWingL = find(/FeatherL_A/), iWingR = find(/FeatherR_A/);

const mixer = new THREE.AnimationMixer(root);
mixer.clipAction(clip).play();

// Seeking backwards on a mixer does not rewind cleanly, hence the reset to 0
// first. And without updateMatrixWorld every frame measures identical: the
// mixer writes local quaternions and nothing recomputes world matrices.
function seek(frame) {
  mixer.setTime(0);
  mixer.setTime(frame / FPS);
  root.updateMatrixWorld(true);
}
function bonePositions(frame) {
  seek(frame);
  return bones.map((b) => new THREE.Vector3().setFromMatrixPosition(b.matrixWorld));
}
function metrics(frame) {
  const p = bonePositions(frame);
  const axis = p[iHead].clone().sub(p[iTail]);
  return {
    y: p[iPelvis].y,
    span: p[iWingL].distanceTo(p[iWingR]),
    pitch: THREE.MathUtils.radToDeg(Math.atan2(axis.y, Math.hypot(axis.x, axis.z))),
  };
}
const seam = (a, b) => {
  const pa = bonePositions(a), pb = bonePositions(b);
  return pa.reduce((s, v, i) => s + v.distanceTo(pb[i]), 0);
};

// Ground level: the pelvis sits at 4.76 for every landed frame in the take.
const GROUND = 6;

console.log('=== 1. every range loops ===');
for (const [name, [from, to]] of Object.entries(def.subclips)) {
  const s = seam(from, to);
  check(s < 0.01, `${name} [${from}..${to}] first pose == last pose (seam ${s.toFixed(3)} bone-units)`);
}

console.log('\n=== 2. airborne, and in character ===');
for (const [name, [from, to]] of Object.entries(def.subclips)) {
  const frames = [];
  for (let f = from; f <= to; f++) frames.push(metrics(f));
  const lowest = Math.min(...frames.map((m) => m.y));
  check(lowest > GROUND, `${name}: never touches the ground (lowest pelvis ${lowest.toFixed(2)}, ground is 4.76)`);
}

const spanAt = (from, to) => {
  const out = [];
  for (let f = from; f <= to; f++) out.push(metrics(f).span);
  return { min: Math.min(...out), max: Math.max(...out) };
};
const glide = spanAt(...def.subclips.seagullGlide);
check(glide.min > 78, `glide holds full span throughout (${glide.min.toFixed(1)}..${glide.max.toFixed(1)}, full is ~80) — no flap leaks in`);

const flap = spanAt(...def.subclips.seagullFlap);
check(flap.min < 35 && flap.max > 78, `flap sweeps a whole wingbeat (${flap.min.toFixed(1)}..${flap.max.toFixed(1)})`);

const dive = spanAt(...def.subclips.seagullDive);
const divePitch = metrics(def.subclips.seagullDive[0]).pitch;
check(dive.max < 32, `dive stays tucked (span ${dive.min.toFixed(1)}..${dive.max.toFixed(1)}, against ~80 spread)`);
check(divePitch < -70, `dive is nose-down in the clip (${divePitch.toFixed(1)}°, level flight is -3.6°)`);

console.log('\n=== 3. the gull falls the way it is pointing ===');
// prepareModel's orient wrapper, then systems/seagull.js's container/visual pair.
const orient = new THREE.Group();
orient.quaternion.copy(orientationQuaternion(def));
orient.add(root);
const visual = new THREE.Group(); visual.add(orient);
const container = new THREE.Group(); container.add(visual);

// updateSeagulls' heading block, verbatim — including `dir` (not vx) driving
// both the flank flip and the correction's sign.
function noseVsTravel(frame, dir, vx, vy, diveBlend) {
  seek(frame);
  const flip = dir < 0 ? -1 : 1;
  const correction = flip * diveBlend * (CONFIG.seagullBomb.divePitch ?? 0) * (Math.PI / 180);
  container.rotation.z = Math.atan2(vy, vx) - Math.PI / 2 + correction;
  visual.rotation.y = dir < 0 ? Math.PI : 0;
  container.updateMatrixWorld(true);
  const h = new THREE.Vector3().setFromMatrixPosition(bones[iHead].matrixWorld);
  const t = new THREE.Vector3().setFromMatrixPosition(bones[iTail].matrixWorld);
  const d = h.sub(t).normalize();
  const nose = THREE.MathUtils.radToDeg(Math.atan2(d.y, d.x));
  const travel = THREE.MathUtils.radToDeg(Math.atan2(vy, vx));
  return Math.abs(((nose - travel + 540) % 360) - 180);
}

// Cruising: no correction (diveBlend 0), and the clips are near-level anyway.
const [gFrom] = def.subclips.seagullGlide;
for (const dir of [1, -1]) {
  const e = noseVsTravel(gFrom, dir, dir * CONFIG.seagullBomb.cruiseSpeed, 0, 0);
  check(e < 6, `cruise ${dir > 0 ? 'right' : 'left'}: nose is ${e.toFixed(1)}° off the flight path`);
}
// Diving: correction fully blended in.
const [dFrom, dTo] = def.subclips.seagullDive;
for (const dir of [1, -1]) {
  for (const frame of [dFrom, Math.round((dFrom + dTo) / 2), dTo]) {
    const e = noseVsTravel(frame, dir, dir * 2, -CONFIG.seagullBomb.diveSpeedMax, 1);
    check(e < 8, `dive ${dir > 0 ? 'right' : 'left'} f${frame}: nose is ${e.toFixed(1)}° off the flight path`);
  }
}
// ...and the uncorrected case, to prove the correction is load-bearing rather
// than a number that happens to be near zero.
const bare = noseVsTravel(dFrom, 1, 2, -CONFIG.seagullBomb.diveSpeedMax, 0);
check(bare > 80, `without it the gull falls ${bare.toFixed(0)}° off its path — the correction is doing real work`);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
