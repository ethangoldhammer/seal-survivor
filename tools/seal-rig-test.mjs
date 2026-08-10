#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:rig
//
// The player's aim rig, measured on the SKIN rather than on the bones.
//
// The failure this exists to catch is a pinch: the solver folding a joint so
// far that the mesh over it stops being a surface and collapses to a crease.
// Bone angles cannot tell you that on their own — where the skin gives out
// depends on how the model is weighted, and the seal's swim clip already folds
// a shoulder to 93 degrees on its own. So this loads furseal.glb, skins all
// 1374 vertices in software every frame (SkinnedMesh.applyBoneTransform, the
// same maths the GPU runs) and reads the triangle areas.
//
// Every frame is posed TWICE — once with the rig's bones back on the keyframes
// the clip wrote, once as the rig left them — so the animation is never blamed
// for what the animation does. A pinch is defined as skin the CLIP left open
// and the SOLVER closed.
//
// Four things worth failing over:
//
//   INVARIANT  that no bone is ever written past its joint limit. This one is
//              exact and noise-free: it reads the pose that was actually
//              written, every frame, and it is the property the guard claims.
//
//   SKIN       that the guard removes most of the collapsed triangles. The
//              same battery runs twice, limits off and limits on, so the bar
//              is the rig's own unguarded behaviour rather than a number
//              copied out of a previous run of this file.
//
//   AIM        that it does not buy that by refusing to aim. A guard that
//              parks the flippers passes every pinch test ever written.
//
//   LIMITS     the three rules of limitJoint on their own, without a model:
//              leave a legal pose alone, pull an illegal one back, and never
//              pull a bone off a keyframe the artist chose.
//
// What it cannot tell you: whether the flippers look right. That is a seal on
// a screen.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG } from '../path/src/config.js';
import { installModel, createVisual } from '../path/src/assets.js';
import { createAimRig } from '../path/src/systems/aimRig.js';
import { createAnimationController } from '../path/src/systems/animation.js';
import { limitJoint } from '../path/src/systems/ikChain.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = resolve(HERE, '../public/models/furseal.glb');
const DEG = 180 / Math.PI;

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

if (!existsSync(MODEL)) {
  console.error(`\nmissing ${MODEL} — the seal has to be in public/models for the game to load it too.\n`);
  process.exit(1);
}

// --- the rig ---------------------------------------------------------------
const buf = readFileSync(MODEL);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
);
installModel('ship', gltf.scene, gltf.animations);

const scene = new THREE.Scene();
const body = createVisual('ship');
scene.add(body);
const anim = createAnimationController(body);
const rig = createAimRig(body);

section('RIG');
check('the aim rig resolved off the real model', !!rig);
check('both flipper chains built', rig.fins.length === 2, `${rig.fins.length}`);
check('the neck chain built', !!rig.head);
const allChains = [...rig.fins, rig.head].filter(Boolean);
check('every chain captured its authored rest pose',
  allChains.every((c) => c.restQ?.length === c.bones.length));

section('LIMITS ARE CONFIGURED');
// A safeguard nothing switches on is not a safeguard. Both chains, both axes.
for (const [name, cfg] of [['fins', CONFIG.fins], ['head', CONFIG.head]]) {
  check(`${name}.maxFold is set and sane`, cfg.maxFold > 0 && cfg.maxFold < Math.PI, `${cfg.maxFold}`);
  check(`${name}.maxTwist is set and sane`, cfg.maxTwist > 0 && cfg.maxTwist < Math.PI, `${cfg.maxTwist}`);
}

// --- software skinning -----------------------------------------------------
const skins = [];
body.traverse((o) => { if (o.isSkinnedMesh) skins.push(o); });

const _v = new THREE.Vector3();
function skinInto(mesh, out) {
  const pos = mesh.geometry.attributes.position;
  // The WHOLE graph, forced. applyBoneTransform reads bone.matrixWorld, and in
  // a terminal there is no renderer to have refreshed it — update the mesh
  // alone and the bones keep last frame's matrices, which quietly makes every
  // pose measure identical.
  scene.updateMatrixWorld(true);
  for (let i = 0; i < pos.count; i++) {
    mesh.applyBoneTransform(i, _v.fromBufferAttribute(pos, i));
    out[i * 3] = _v.x; out[i * 3 + 1] = _v.y; out[i * 3 + 2] = _v.z;
  }
  return out;
}
function triArea(P, a, b, c) {
  const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
  const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

const fixtures = skins.map((m) => {
  const idx = m.geometry.index;
  const count = idx ? idx.count : m.geometry.attributes.position.count;
  const tris = new Uint32Array(count);
  for (let i = 0; i < count; i++) tris[i] = idx ? idx.getX(i) : i;
  const n = m.geometry.attributes.position.count * 3;
  const rest = skinInto(m, new Float32Array(n));
  const restArea = new Float64Array(count / 3);
  for (let t = 0; t < count; t += 3) restArea[t / 3] = triArea(rest, tris[t], tris[t + 1], tris[t + 2]);
  // Slivers are invisible and their area ratio is mostly noise; measure the
  // triangles a viewer could actually see collapse.
  const median = Float64Array.from(restArea).sort()[restArea.length >> 1];
  return { mesh: m, tris, restArea, median, buf: new Float32Array(n), clipBuf: new Float32Array(n) };
});
check('the skinned mesh loaded', fixtures.length > 0,
  `${fixtures.reduce((n, f) => n + f.restArea.length, 0)} triangles`);

// A triangle holding at least this much of its rest area counts as open skin.
const OPEN = 0.15;

// Triangles the clip left open and the rig closed, this frame.
function closedByRig() {
  const keep = allChains.map((c) => c.bones.map((b) => b.quaternion.clone()));
  allChains.forEach((c) => c.bones.forEach((b, i) => b.quaternion.copy(c.animQ[i])));
  for (const f of fixtures) skinInto(f.mesh, f.clipBuf);
  allChains.forEach((c, k) => c.bones.forEach((b, i) => b.quaternion.copy(keep[k][i])));
  for (const f of fixtures) skinInto(f.mesh, f.buf);

  let closed = 0;
  let worst = 1;
  for (const f of fixtures) {
    for (let t = 0; t < f.tris.length; t += 3) {
      const a = f.tris[t], b = f.tris[t + 1], c = f.tris[t + 2];
      const rest = f.restArea[t / 3];
      if (rest < f.median * 0.25) continue;
      if (triArea(f.clipBuf, a, b, c) / rest < OPEN) continue; // the art's doing, not ours
      const r = triArea(f.buf, a, b, c) / rest;
      if (r < OPEN) closed++;
      if (r < worst) worst = r;
    }
  }
  return { closed, worst };
}

// --- joint angles, read off the pose that was written ----------------------
const _tw = new THREE.Quaternion();
const _sw = new THREE.Quaternion();
const _rel = new THREE.Quaternion();
const _inv = new THREE.Quaternion();
function foldTwist(q, restQ, axis) {
  _rel.copy(_inv.copy(restQ).invert()).multiply(q);
  const d = _rel.x * axis.x + _rel.y * axis.y + _rel.z * axis.z;
  _tw.set(axis.x * d, axis.y * d, axis.z * d, _rel.w);
  const l = Math.hypot(_tw.x, _tw.y, _tw.z, _tw.w);
  if (l < 1e-8) _tw.identity();
  else _tw.set(_tw.x / l, _tw.y / l, _tw.z / l, _tw.w / l);
  _sw.copy(_rel).multiply(_inv.copy(_tw).invert());
  const ang = (q2) => 2 * Math.atan2(Math.hypot(q2.x, q2.y, q2.z), Math.abs(q2.w));
  return { fold: ang(_sw), twist: ang(_tw) };
}

// --- the battery -----------------------------------------------------------
// Held aims all the way round, then the two cases that actually move: a cursor
// swept in a circle, and a cursor thrown from one side to the other. The
// transitions are where the solver travels furthest in one frame.
const dt = 1 / 60;
const aim = new THREE.Vector2();
const _root = new THREE.Vector3();
const _dir = new THREE.Vector3();

function aims() {
  const out = [];
  for (let deg = 0; deg < 360; deg += 30) for (let i = 0; i < 60; i++) out.push((deg * Math.PI) / 180);
  for (let i = 0; i < 240; i++) out.push(i * dt * Math.PI * 2);
  for (let i = 0; i < 240; i++) out.push(((i / 12) | 0) % 2 ? Math.PI : 0);
  return out;
}

function battery({ watchLimits = false } = {}) {
  rig.reset();
  body.quaternion.identity();
  aim.set(1, 0);
  for (let i = 0; i < 90; i++) { anim.update(dt, 'swim', false); rig.update(dt, aim, { engaged: true }); }

  let closedFrames = 0;
  let worst = 1;
  let errSum = 0;
  let errN = 0;
  let overFold = 0;
  let overTwist = 0;
  let peakFold = 0;
  let peakTwist = 0;

  for (const a of aims()) {
    aim.set(Math.cos(a), Math.sin(a));
    anim.update(dt, 'swim', false);
    rig.update(dt, aim, { engaged: true });

    const m = closedByRig();
    closedFrames += m.closed;
    worst = Math.min(worst, m.worst);

    // Where each flipper is pointing, against where the player is pointing.
    for (const c of rig.fins) {
      c.bones[0].getWorldPosition(_root);
      _dir.copy(c.point).sub(_root);
      _dir.z = 0;
      if (_dir.lengthSq() < 1e-8) continue;
      _dir.normalize();
      errSum += Math.acos(Math.min(1, Math.max(-1, _dir.x * aim.x + _dir.y * aim.y))) * DEG;
      errN++;
    }

    if (!watchLimits) continue;
    // The invariant: the written pose is inside the limit, or inside whatever
    // the clip is doing — never past both.
    for (const chain of allChains) {
      const cfg = rig.fins.includes(chain) ? CONFIG.fins : CONFIG.head;
      chain.bones.forEach((b, i) => {
        const got = foldTwist(b.quaternion, chain.restQ[i], chain.tipAxis);
        const clip = foldTwist(chain.animQ[i], chain.restQ[i], chain.tipAxis);
        const foldCap = Math.max(cfg.maxFold, clip.fold) + 1e-3;
        const twistCap = Math.max(cfg.maxTwist, clip.twist) + 1e-3;
        if (got.fold > foldCap) { overFold++; peakFold = Math.max(peakFold, (got.fold - foldCap) * DEG); }
        if (got.twist > twistCap) { overTwist++; peakTwist = Math.max(peakTwist, (got.twist - twistCap) * DEG); }
      });
    }
  }
  return {
    closedFrames, worst, err: errSum / Math.max(1, errN), overFold, overTwist, peakFold, peakTwist,
  };
}

section('INVARIANT — no bone is written past its joint limit');
const guarded = battery({ watchLimits: true });
check('no fold exceeds the limit the clip allows', guarded.overFold === 0,
  guarded.overFold ? `${guarded.overFold} times, worst by ${guarded.peakFold.toFixed(1)}deg` : 'over ~1700 frames');
check('no twist exceeds the limit the clip allows', guarded.overTwist === 0,
  guarded.overTwist ? `${guarded.overTwist} times, worst by ${guarded.peakTwist.toFixed(1)}deg` : 'over ~1700 frames');

section('SKIN — the guard closes far less of the seal than the bare solver');
const saved = {
  finFold: CONFIG.fins.maxFold, finTwist: CONFIG.fins.maxTwist,
  headFold: CONFIG.head.maxFold, headTwist: CONFIG.head.maxTwist,
};
CONFIG.fins.maxFold = null; CONFIG.fins.maxTwist = null;
CONFIG.head.maxFold = null; CONFIG.head.maxTwist = null;
const bare = battery();
Object.assign(CONFIG.fins, { maxFold: saved.finFold, maxTwist: saved.finTwist });
Object.assign(CONFIG.head, { maxFold: saved.headFold, maxTwist: saved.headTwist });

console.log(`    unguarded: ${bare.closedFrames} closed triangle-frames, worst area ${bare.worst.toFixed(3)}, aim error ${bare.err.toFixed(1)}deg`);
console.log(`    guarded:   ${guarded.closedFrames} closed triangle-frames, worst area ${guarded.worst.toFixed(3)}, aim error ${guarded.err.toFixed(1)}deg`);
check('the bare solver really does pinch (or this test proves nothing)',
  bare.closedFrames > 100, `${bare.closedFrames} triangle-frames`);
check('the guard removes at least half of it',
  guarded.closedFrames <= bare.closedFrames * 0.5,
  `${guarded.closedFrames} vs ${bare.closedFrames}`);

section('AIM — the fins still point where the player is pointing');
check('the flippers track the cursor', guarded.err < 30, `${guarded.err.toFixed(1)}deg mean error`);
check('the guard costs little aim', guarded.err < bare.err + 8,
  `${guarded.err.toFixed(1)}deg guarded vs ${bare.err.toFixed(1)}deg bare`);

section('LIMITS — the three rules, on their own');
{
  const axis = new THREE.Vector3(0, 1, 0);
  const perp = new THREE.Vector3(1, 0, 0);
  const cfg = { maxFold: 1.0, maxTwist: 0.3 };
  const rest = new THREE.Quaternion(); // rest at identity keeps the reading direct
  const at = (foldAng, twistAng) => new THREE.Quaternion()
    .setFromAxisAngle(perp, foldAng)
    .multiply(new THREE.Quaternion().setFromAxisAngle(axis, twistAng));
  const foldOf = (q) => foldTwist(q, rest, axis).fold;
  const twistOf = (q) => foldTwist(q, rest, axis).twist;

  const legal = at(0.5, 0.1);
  const kept = limitJoint(legal.clone(), rest.clone(), rest, axis, cfg);
  check('a pose inside the limits is left alone', kept.angleTo(legal) < 1e-6,
    `moved ${(kept.angleTo(legal) * DEG).toFixed(3)}deg`);

  const wild = limitJoint(at(2.4, 1.4), rest.clone(), rest, axis, cfg);
  check('an over-folded pose comes back to the fold limit', foldOf(wild) <= cfg.maxFold + 1e-6,
    `${(foldOf(wild) * DEG).toFixed(1)}deg vs a ${(cfg.maxFold * DEG).toFixed(0)}deg limit`);
  check('an over-twisted pose comes back to the twist limit', twistOf(wild) <= cfg.maxTwist + 1e-6,
    `${(twistOf(wild) * DEG).toFixed(1)}deg vs a ${(cfg.maxTwist * DEG).toFixed(0)}deg limit`);

  // The floor: where the CLIP is already past the limit, the guard holds the
  // pose there rather than dragging the bone off the keyframe.
  const clip = at(1.6, 0.9);
  const held = limitJoint(at(2.4, 1.4), clip, rest, axis, cfg);
  check('a bone is never pulled tighter than the clip has it',
    foldOf(held) >= foldOf(clip) - 1e-3 && twistOf(held) >= twistOf(clip) - 1e-3,
    `fold ${(foldOf(held) * DEG).toFixed(1)}deg vs clip ${(foldOf(clip) * DEG).toFixed(1)}deg`);
  check('...and it does not sail past the clip either',
    foldOf(held) <= foldOf(clip) + 1e-3, `${(foldOf(held) * DEG).toFixed(1)}deg`);

  const unset = limitJoint(at(2.4, 1.4), rest.clone(), rest, axis, {});
  check('a rig with no limits configured is untouched', foldOf(unset) > 2.3,
    `${(foldOf(unset) * DEG).toFixed(0)}deg left alone`);

  const nan = limitJoint(new THREE.Quaternion(NaN, NaN, NaN, NaN), at(0.4, 0), rest, axis, cfg);
  check('a degenerate solve falls back to the clip rather than writing NaN',
    Number.isFinite(nan.x + nan.y + nan.z + nan.w) && Math.abs(foldOf(nan) - 0.4) < 1e-6);
}

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
