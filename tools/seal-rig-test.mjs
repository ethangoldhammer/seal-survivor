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
import { createAimRig, emitPoint } from '../path/src/systems/aimRig.js';
import { createAnimationController } from '../path/src/systems/animation.js';
import { limitJoint, chainPoint } from '../path/src/systems/ikChain.js';
import { updateBubbles, resetBubbles } from '../path/src/systems/bubbles.js';
import { initParticles, resetParticles, particleCount } from '../path/src/entities/particles.js';

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

// ===========================================================================
// THE WAKE — which bit of the seal the bubbles are born on
//
// Not a look test. The claim is geometric and the model can settle it: the
// wake used to pour out of `anchors.tail`, which measures out at the ankle
// joint BOTH hind flippers hang off — the base of the fins. These checks
// pin it to the tips instead, and pin the tail's share of it to a spread down
// the chain rather than a second point emitter.
// ===========================================================================

section('WAKE — the emitters sit on the ends of the limbs');
{
  // A settled swim pose, then frozen: nothing below advances the clip, so the
  // anchors and the tail's bones stay exactly where these checks read them.
  rig.reset();
  body.quaternion.identity();
  aim.set(1, 0);
  for (let i = 0; i < 90; i++) { anim.update(dt, 'swim', false); rig.update(dt, aim, { engaged: true }); }

  const A = rig.anchors;
  check('both hind flipper tips are published', !!(A.finL && A.finR),
    Object.keys(A).join(', '));

  // --- the front flippers: the muzzle is ON the skin ------------------------
  //
  // The one that can only be settled by skinning: `rig.muzzles` used to BE
  // `chain.point`, the IK effector, which lives past the end of the limb on
  // purpose — so the muzzle flash, the bullet and the club all hung in open
  // water off the flipper. Nothing in the rig can tell you that. The vertices
  // can.
  {
    // The outermost vertex each hand bone drives, and where it ends up in the
    // pose above. `applyBoneTransform` gives mesh space; matrixWorld finishes
    // the job.
    const outermost = (boneName) => {
      const bone = body.getObjectByName(boneName);
      const m = fixtures[0].mesh;
      const p = m.geometry.attributes.position;
      const si = m.geometry.attributes.skinIndex;
      const sw = m.geometry.attributes.skinWeight;
      const v = new THREE.Vector3();
      let best = -Infinity;
      let world = null;
      for (let i = 0; i < p.count; i++) {
        m.applyBoneTransform(i, v.fromBufferAttribute(p, i));
        const w = v.clone().applyMatrix4(m.matrixWorld);
        for (let k = 0; k < 4; k++) {
          if (sw.getComponent(i, k) < 0.4) continue;
          if (m.skeleton.bones[si.getComponent(i, k)] !== bone) continue;
          const y = bone.worldToLocal(w.clone()).y; // down the bone's length
          if (y > best) { best = y; world = w.clone(); }
        }
      }
      return { world, wrist: bone.getWorldPosition(new THREE.Vector3()) };
    };

    const flat = (a, b) => Math.hypot(a.x - b.x, a.y - b.y); // what the camera sees
    for (const [i, boneName] of [[0, 'hand_L_014'], [1, 'hand_R_018']]) {
      const { world, wrist } = outermost(boneName);
      const muzzle = rig.muzzles[i];
      const effector = rig.fins[i].point;
      const toSkin = wrist.distanceTo(world);
      const toMuzzle = wrist.distanceTo(muzzle);
      check(`${boneName}: the muzzle is inside the flipper's own skin`,
        toMuzzle <= toSkin && toMuzzle > toSkin * 0.85,
        `${toMuzzle.toFixed(2)} out of a ${toSkin.toFixed(2)} flipper`);
      check(`${boneName}: ...and the aim effector still reaches past it`,
        wrist.distanceTo(effector) > toMuzzle * 1.15,
        `effector ${wrist.distanceTo(effector).toFixed(2)} vs muzzle ${toMuzzle.toFixed(2)}`);

      // What a shot actually fires from, which is the thing that was visibly
      // wrong: on screen it sat half a world unit off the end of the fin.
      const fired = emitPoint(rig, 'fins', i, new THREE.Vector3(1, 0, 0), body.position, new THREE.Vector3());
      check(`${boneName}: a shot leaves from the edge of the geometry`,
        flat(fired, world) < 0.2, `${flat(fired, world).toFixed(2)} from the outermost vertex, on screen`);
    }
  }

  if (A.finL && A.finR) {
    // Measured against each flipper's OWN joints: how far past the ankle the
    // anchor sits, in the direction the shin points. "Past the ankle" is what
    // makes it a tip rather than a base, and it is the one claim that holds in
    // every pose — deliberately not "further back than the tail", which the
    // swim clip breaks: it poses the two hind flippers asymmetrically enough
    // that the right one sits slightly AHEAD of the tail tip while the left
    // trails it by 0.8. (Which is also why the wake alternates between them
    // rather than picking one.)
    const at = (n) => body.getObjectByName(n).getWorldPosition(new THREE.Vector3());
    const side = (anchor, footN, legN) => {
      const foot = at(footN);
      const shin = foot.clone().sub(at(legN));
      const len = shin.length(); // before normalize() eats it
      return { past: anchor.clone().sub(foot).dot(shin.normalize()), shin: len };
    };
    const L = side(A.finL, 'foot_L_022', 'leg_L_021');
    const R = side(A.finR, 'foot_R_025', 'leg_R_024');
    check('each fin anchor sits out past its own ankle, down the flipper',
      L.past > L.shin * 0.5 && R.past > R.shin * 0.5,
      `${L.past.toFixed(2)} / ${R.past.toFixed(2)} past the joint, on a ${L.shin.toFixed(2)} shin`);
    // ...and it is nowhere near the point the wake used to pour out of.
    check('...well clear of the tail anchor the wake used to come from',
      A.finL.distanceTo(A.tail) > L.past && A.finR.distanceTo(A.tail) > R.past,
      `${A.finL.distanceTo(A.tail).toFixed(2)} / ${A.finR.distanceTo(A.tail).toFixed(2)} away`);
  }

  // The sampler itself, deterministically: `s` has to be a fraction of ARC
  // LENGTH down the chain, or "most at the tip" is measured against the wrong
  // ruler. The seal's tail is 0.63 / 0.14 / 0.23 of its length in three
  // segments, so a per-joint walk would show up here as a staircase.
  if (rig.tail) {
    const nodes = [
      ...rig.tail.bones.map((b) => b.getWorldPosition(new THREE.Vector3())),
      rig.tail.point.clone(),
    ];
    const cum = [0];
    for (let i = 1; i < nodes.length; i++) cum.push(cum[i - 1] + nodes[i - 1].distanceTo(nodes[i]));
    const total = cum[cum.length - 1];
    // Arc position of a point known to lie ON the polyline: the nearest
    // segment, plus how far along it the point falls.
    const arcOf = (p) => {
      let best = Infinity;
      let arc = 0;
      for (let i = 1; i < nodes.length; i++) {
        const seg = nodes[i].clone().sub(nodes[i - 1]);
        const t = Math.min(1, Math.max(0, p.clone().sub(nodes[i - 1]).dot(seg) / seg.lengthSq()));
        const d = p.distanceTo(nodes[i - 1].clone().addScaledVector(seg, t));
        if (d < best) { best = d; arc = cum[i - 1] + t * seg.length(); }
      }
      return arc / total;
    };

    const out = new THREE.Vector3();
    let worst = 0;
    for (let i = 0; i <= 20; i++) {
      const s = i / 20;
      worst = Math.max(worst, Math.abs(arcOf(chainPoint(rig.tail, s, out)) - s));
    }
    check('a chain sample lands at its own fraction of the tail\'s LENGTH',
      worst < 0.01, `worst ${(worst * 100).toFixed(1)}% off over 21 samples`);
    check('...ending exactly on the root and the tip',
      chainPoint(rig.tail, 0, out).distanceTo(nodes[0]) < 1e-6
      && chainPoint(rig.tail, 1, out).distanceTo(rig.tail.point) < 1e-6);
    check('...and no value of s can walk off the end',
      chainPoint(rig.tail, -5, out).distanceTo(nodes[0]) < 1e-6
      && chainPoint(rig.tail, 9, out).distanceTo(rig.tail.point) < 1e-6);
  }
}

section('WAKE — where the bursts are actually born');
{
  const scene2 = new THREE.Scene();
  initParticles(scene2);
  const pos = scene2.children[0].geometry.attributes.position.array;

  const W = CONFIG.bubbles.wake;
  const wasBreath = CONFIG.bubbles.breath.enabled;
  const wasShare = W.tailShare;
  const wasBias = W.tipBias;
  const random = Math.random;
  try {
    // Breath off: the mouth's puffs land in the same buffer and would show up
    // as a third cluster with nothing to do with the wake.
    CONFIG.bubbles.breath.enabled = false;
    // Seeded, because every check below is a distribution. Averaging a Monte
    // Carlo run against a fixed stream is the difference between a test that
    // fails when the code breaks and one that fails on a Tuesday.
    let s = 0x9e3779b9;
    Math.random = () => {
      s |= 0; s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    // The pose stays frozen (see above), so every burst is comparable against
    // one set of anchor positions.
    const velocity = { x: CONFIG.player.maxSpeed, y: 0 };
    function wakePoints(seconds = 2) {
      resetBubbles();
      resetParticles();
      for (let t = 0; t < seconds; t += dt) updateBubbles(dt, rig, velocity, false, 0);
      const out = [];
      for (let i = 0; i < particleCount(); i++) out.push(new THREE.Vector2(pos[i * 3], pos[i * 3 + 1]));
      return out;
    }

    const A = rig.anchors;
    const near = (p, a, eps = 1e-4) => Math.hypot(p.x - a.x, p.y - a.y) < eps;
    // All four: the two muzzles on the front flippers' skin edge, then the two
    // hind flipper anchors.
    const tips = [...rig.muzzles, A.finL, A.finR];

    W.tailShare = 0;
    {
      const pts = wakePoints();
      const per = tips.map((t) => pts.filter((p) => near(p, t)).length);
      check('with the tail\'s share at 0 every bubble is born on a flipper tip',
        pts.length > 0 && per.reduce((a, b) => a + b, 0) === pts.length,
        `${per.reduce((a, b) => a + b, 0)} of ${pts.length}`);
      check('...spread over all four limbs, not one of them',
        per.every((n) => n > pts.length * 0.15),
        `fore ${per[0]}/${per[1]}, hind ${per[2]}/${per[3]}`);
      // The regression this whole change is about.
      check('...and none of them out of the ankle the fins hang off',
        pts.every((p) => !near(p, A.tail, 0.02)), `${pts.filter((p) => near(p, A.tail, 0.02)).length} at the old anchor`);
    }

    W.tailShare = 1;
    {
      // Where each burst sits along the tail, 0 at the root joint and 1 at the
      // tip. The chain is all but straight in this pose (arc length is within
      // 1% of the root-to-tip line), so the distance from the root reads as the
      // fraction directly — the sampler's own arc-length behaviour is pinned
      // exactly, above.
      const root = rig.tail.bones[0].getWorldPosition(new THREE.Vector3());
      const span = root.distanceTo(rig.tail.point);
      const along = () => wakePoints().map((p) => Math.hypot(p.x - root.x, p.y - root.y) / span);
      // Share of the bursts in each quarter of the tail, root first. Quartiles
      // rather than a min or a max: the extremes of ~46 bursts are noise even
      // on a fixed seed, and the shape is the claim.
      const quarters = (f) => [0, 1, 2, 3].map((q) =>
        f.filter((v) => v >= q / 4 && v < (q + 1) / 4 + (q === 3 ? 1e-6 : 0)).length / f.length);

      const biased = quarters(along());
      check('the tail\'s share is crowded to the tip',
        biased[3] > 0.5 && biased[3] > biased[0] * 4,
        `quarters root->tip: ${biased.map((v) => (v * 100).toFixed(0) + '%').join(' ')}`);

      W.tipBias = 0;
      const even = quarters(along());
      check('...and tipBias 0 spreads them down the whole chain instead',
        even.every((v) => v > 0.12 && v < 0.4),
        `quarters root->tip: ${even.map((v) => (v * 100).toFixed(0) + '%').join(' ')}`);
      check('...which is a real difference, not a re-labelling',
        even[3] < biased[3] * 0.6, `${(even[3] * 100).toFixed(0)}% vs ${(biased[3] * 100).toFixed(0)}% at the tip`);
      W.tipBias = wasBias;
    }

    W.tailShare = wasShare;
    {
      // The shipped split, and the budget: moving the emitters around must not
      // quietly multiply how many bubbles a second of swimming costs.
      const pts = wakePoints();
      const onTips = pts.filter((p) => tips.some((t) => near(p, t))).length / pts.length;
      check('the shipped split lands near tailShare',
        Math.abs((1 - onTips) - W.tailShare) < 0.1,
        `${((1 - onTips) * 100).toFixed(0)}% off the tail, tailShare ${W.tailShare}`);

      const perBurst = Math.max(1, Math.round(CONFIG.emitters.wakeBubbles.count * W.scale));
      const expected = W.perSecond * perBurst * 2; // two seconds at top speed
      check('and one burst is still one burst — the rate is unchanged',
        Math.abs(pts.length - expected) < expected * 0.1, `${pts.length} particles vs ~${expected}`);
    }
  } finally {
    Math.random = random;
    CONFIG.bubbles.breath.enabled = wasBreath;
    W.tailShare = wasShare;
    W.tipBias = wasBias;
  }
}

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
