#!/usr/bin/env node
// Does the man o' war's skin actually work?
//
//   npm run test:manowar
//
// tools/rig-manowar.mjs builds the rig out of measurements, and every one of
// those measurements can be plausible and wrong. A rig that lost its skin still
// loads, still reports 93 bones and still measures a perfectly reasonable bind
// pose — so this poses it and measures where the vertices GO, which is the only
// question that matters and the only one a rest-pose check cannot answer.
//
// WHAT IS BEING PROVEN, in the order it can fail:
//
//   THE BIND POSE IS THE MESH. Skinning at rest must reproduce the geometry it
//        was built from. An inverse bind matrix that disagrees with where its
//        bone sits deforms the model the instant it loads, with nothing on
//        screen to point at.
//   A STRAND MOVES ITS OWN FLESH. Curl one filament's chain and the vertices
//        that filament dominates have to travel a real fraction of its own
//        span — normalised against the STRAND, never the model bbox, because
//        the shortest strand here is a quarter the length of the longest and a
//        single global threshold would either pass everything or fail the stubs.
//   AND NOBODY ELSE'S. This is the one the part wall exists for. Two filaments
//        on a scan of a drifting animal pass within hundredths of each other,
//        so a nearest-bone skin hands one strand's midriff to the strand beside
//        it — and that reads as intended right up until they swing apart and
//        tear a hole between them. Curling strand N must leave every other
//        strand, and the float, where they were.
//   NOTHING PINS TO THE ORIGIN. A vertex whose four weights came out zero binds
//        to nothing and draws a spike from the model to the world origin. It
//        throws nothing and it is invisible in every static check.
import './dom-stub.mjs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync } from 'node:fs';

const MODEL = process.argv[2] ?? 'public/models/manowar.glb';
let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `   ${detail}` : ''}`);
};
const section = (name) => console.log(`\n${name}`);

const buf = readFileSync(MODEL);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
);
const scene = new THREE.Scene();
scene.add(gltf.scene);

const skins = [];
scene.traverse((o) => { if (o.isSkinnedMesh) skins.push(o); });

section('THE FILE');
check('one skinned mesh', skins.length === 1, `${skins.length}`);
if (skins.length !== 1) process.exit(1);
const mesh = skins[0];
const bones = mesh.skeleton.bones;
check('the skeleton came through', bones.length > 0, `${bones.length} bones`);
check('the float is the root', bones.some((b) => b.name === 'float'));
check('the crest bone is there', bones.some((b) => b.name === 'crest'));

// Strand membership read back off the bone NAMES, which is itself the check
// that the naming survived the export.
const strandOf = new Map();
for (let i = 0; i < bones.length; i++) {
  const m = /^strand(\d+)_/.exec(bones[i].name);
  if (m) strandOf.set(i, Number(m[1]));
}
const strandIds = [...new Set(strandOf.values())].sort((a, b) => a - b);
check('every strand named itself', strandIds.length > 0, `${strandIds.length} strands`);

// --- weights ---------------------------------------------------------------
const geo = mesh.geometry;
const N = geo.attributes.position.count;
const wAttr = geo.attributes.skinWeight;
const jAttr = geo.attributes.skinIndex;
let worstSum = Infinity;
for (let i = 0; i < N; i++) {
  const s = wAttr.getX(i) + wAttr.getY(i) + wAttr.getZ(i) + wAttr.getW(i);
  if (s < worstSum) worstSum = s;
}
section('WEIGHTS');
check('every vertex is bound', worstSum > 0.999, `worst row sums to ${worstSum.toFixed(5)}`);

// Which strand dominates a vertex — the strand of its heaviest influence.
const dominant = new Int32Array(N).fill(-1); // -1 is the float
for (let i = 0; i < N; i++) {
  const w = [wAttr.getX(i), wAttr.getY(i), wAttr.getZ(i), wAttr.getW(i)];
  const j = [jAttr.getX(i), jAttr.getY(i), jAttr.getZ(i), jAttr.getW(i)];
  let best = 0;
  for (let k = 1; k < 4; k++) if (w[k] > w[best]) best = k;
  dominant[i] = strandOf.has(j[best]) ? strandOf.get(j[best]) : -1;
}
const floatVerts = [];
const byStrand = new Map(strandIds.map((s) => [s, []]));
for (let i = 0; i < N; i++) {
  if (dominant[i] < 0) floatVerts.push(i);
  else byStrand.get(dominant[i]).push(i);
}
check('the float still owns flesh', floatVerts.length > 50, `${floatVerts.length} verts`);
check('every strand owns flesh',
  strandIds.every((s) => byStrand.get(s).length > 20),
  strandIds.map((s) => byStrand.get(s).length).join('/'));

// --- software skinning -----------------------------------------------------
const _v = new THREE.Vector3();
function skinInto(out) {
  // The WHOLE graph, forced. applyBoneTransform reads bone.matrixWorld and in a
  // terminal nothing refreshes it — update the mesh alone and the bones keep
  // last pose's matrices, which makes two different poses measure identical.
  scene.updateMatrixWorld(true);
  const pos = geo.attributes.position;
  for (let i = 0; i < N; i++) {
    mesh.applyBoneTransform(i, _v.fromBufferAttribute(pos, i));
    out[i * 3] = _v.x; out[i * 3 + 1] = _v.y; out[i * 3 + 2] = _v.z;
  }
  return out;
}
const rest = skinInto(new Float64Array(N * 3));

section('THE BIND POSE');
let restErr = 0;
const pos = geo.attributes.position;
for (let i = 0; i < N; i++) {
  restErr = Math.max(restErr, Math.hypot(
    rest[i * 3] - pos.getX(i), rest[i * 3 + 1] - pos.getY(i), rest[i * 3 + 2] - pos.getZ(i),
  ));
}
let lo = Infinity; let hi = -Infinity;
for (let i = 0; i < N; i++) { const y = pos.getY(i); if (y < lo) lo = y; if (y > hi) hi = y; }
const H = hi - lo;
check('skinning at rest reproduces the mesh', restErr < H * 1e-4, `max error ${restErr.toExponential(2)} on a ${H.toFixed(2)} model`);

// The span of a set of vertices, which is what a displacement is measured
// against. A strand, not the model.
function span(verts, P) {
  let a = Infinity; let b = -Infinity;
  for (const i of verts) { const y = P[i * 3 + 1]; if (y < a) a = y; if (y > b) b = y; }
  return b - a;
}
function maxTravel(verts, P) {
  let d = 0;
  for (const i of verts) {
    d = Math.max(d, Math.hypot(P[i * 3] - rest[i * 3], P[i * 3 + 1] - rest[i * 3 + 1], P[i * 3 + 2] - rest[i * 3 + 2]));
  }
  return d;
}

const restQ = bones.map((b) => b.quaternion.clone());
const resetPose = () => bones.forEach((b, i) => b.quaternion.copy(restQ[i]));

// --- one strand at a time --------------------------------------------------
section('EACH STRAND MOVES ITSELF AND NOTHING ELSE');
const CURL = 0.28; // radians per bone; ~1.4 rad over a five-bone filament
const posed = new Float64Array(N * 3);
let worstBleed = 0;
let leastTravel = Infinity;
for (const s of strandIds) {
  resetPose();
  for (const [i, sid] of strandOf) if (sid === s) bones[i].rotateX(CURL);
  skinInto(posed);

  const own = maxTravel(byStrand.get(s), posed) / span(byStrand.get(s), rest);
  // Everything that is NOT this strand: the float and all the other filaments.
  const others = [...floatVerts];
  for (const t of strandIds) if (t !== s) others.push(...byStrand.get(t));
  const bleed = maxTravel(others, posed) / H;

  leastTravel = Math.min(leastTravel, own);
  worstBleed = Math.max(worstBleed, bleed);
  console.log(`    strand${String(s).padEnd(2)} moves its own flesh ${(own * 100).toFixed(0)}% of its span, `
    + `everything else by ${(bleed * 100).toFixed(2)}% of the model`);
}
resetPose();
// A curl this size has to be plainly visible. 15% of a filament's own length is
// about the amplitude of a drifting tentacle and well clear of measurement noise.
check('every strand moves its own flesh', leastTravel > 0.15, `weakest ${(leastTravel * 100).toFixed(0)}%`);
// The crown genuinely blends, so this is not zero and should not be: the top
// ring of a filament is partly held by the float and moves a little with it.
// 3% of the model is a blend; 20% would be a strand dragging its neighbour.
check('a strand does not drag anything else with it', worstBleed < 0.03, `worst ${(worstBleed * 100).toFixed(2)}%`);

// --- the float carries the animal ------------------------------------------
section('THE FLOAT CARRIES THE ANIMAL');
resetPose();
bones[bones.findIndex((b) => b.name === 'float')].rotateX(0.3);
skinInto(posed);
let moved = 0;
for (let i = 0; i < N; i++) if (Math.hypot(posed[i * 3] - rest[i * 3], posed[i * 3 + 1] - rest[i * 3 + 1], posed[i * 3 + 2] - rest[i * 3 + 2]) > H * 0.01) moved++;
check('leaning the float moves the whole animal', moved > N * 0.9, `${((moved / N) * 100).toFixed(0)}% of vertices`);

section('NOTHING PINS TO THE ORIGIN');
// An unweighted vertex maps to EXACTLY 0,0,0 — its position is a sum of four
// terms each scaled by a zero weight, so the test is an epsilon and not a band.
//
// It was a band on the first version of this, at 2% of the model, and it failed:
// the world origin sits INSIDE this animal (y runs -2.93 to 2.81, and a rest
// vertex is already 0.14 from it), so under a hard curl the tip of a short
// filament sweeps through the neighbourhood of the origin on its way past. That
// vertex was fully bound — 0.850/0.150 across two of its own strand's bones —
// and the check was measuring the model's shape rather than its weights.
resetPose();
for (const [i] of strandOf) bones[i].rotateX(0.5);
skinInto(posed);
let pinned = 0;
for (let i = 0; i < N; i++) {
  if (Math.hypot(posed[i * 3], posed[i * 3 + 1], posed[i * 3 + 2]) < 1e-6) pinned++;
}
check('no vertex collapses to the origin under a hard curl', pinned === 0, `${pinned} verts`);

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
