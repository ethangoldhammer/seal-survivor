#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run jaws
//
// WHAT IS THERE TO ATTACH A SEAL TO — for every boss that can hold one in its
// mouth (`grab: true` on the def).
//
// The question this answers is "if the grab pinned the seal to the jaw instead
// of to a computed offset, would the bite animation actually shake it", and
// that cannot be reasoned about from a bone name. Three things have to be true
// and each is measured here:
//
//   THERE IS A JAW.        Two of the three grabbers ship NO `biteRig` at all —
//                          they play an authored clip instead — so the bone to
//                          pin to has to be found in the clip rather than named
//                          in assets.js.
//   IT ROTATES ENOUGH.     A hinge's ORIGIN is the pivot and stays put however
//                          far the jaw swings, so origin travel is the wrong
//                          measurement and reports tail fins. What a held body
//                          feels is the WORLD ROTATION SWEPT times how far out
//                          it is pinned — so that is what is reported, with the
//                          arc at 2u and 4u spelled out.
//   IT IS AT THE FRONT.    A clip called "Bite" that moves the back half is a
//                          body thrash, and a seal pinned to the mouth would be
//                          shaken by the wrong end of the animal. Every mover is
//                          reported as a percentage from tail to snout.
//
// Read against `current synthetic shake` on each row: that is what
// systems/bossGrab.js swings today (a free-running sine at `thrashRate`), and
// the useful comparison is not amplitude but PHASE — a sine is never in time
// with the jaws.
//
// Loads the real GLBs through GLTFLoader with an image stub; nothing here reads
// a pixel and nothing is written.
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
import * as THREE from 'three';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CONFIG } from '../path/src/config.js';
import { ASSETS, installModel, createVisual } from '../path/src/assets.js';
import { parseBossCsv } from '../path/src/bossTable.js';
import bossesCsv from '../path/src/bosses.csv?raw';
import { createJawDriver } from '../path/src/systems/jaw.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROSTER = parseBossCsv(bossesCsv, CONFIG.enemies, () => {});
const sizeMulOf = (key) => (ROSTER.find((b) => b.enemy === key)?.sizeMul ?? 1);
const loader = new GLTFLoader();

const GRABBERS = Object.entries(CONFIG.enemies).filter(([, d]) => d.grab);

for (const [key, def] of GRABBERS) {
  for (const assetKey of (def.assets ?? [def.asset]).filter(Boolean)) {
    const model = ASSETS[assetKey]?.model;
    const path = model ? resolve(HERE, '..', 'public', model.replace(/^\//, '')) : null;
    if (!path || !existsSync(path)) { console.log(`${key}/${assetKey}: NO MODEL (${model})`); continue; }
    const buf = readFileSync(path);
    const gltf = await loader.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
    installModel(assetKey, gltf.scene, gltf.animations);

    const vis = createVisual(assetKey);
    vis.scale.multiplyScalar(sizeMulOf(key));
    const scene = new THREE.Scene();
    scene.add(vis);
    scene.updateMatrixWorld(true);

    const rig = ASSETS[assetKey]?.biteRig ?? vis.userData?.biteRig ?? null;
    const clips = (vis.userData?.clips ?? []).map((c) => `${c.name}(${c.duration.toFixed(2)}s)`);
    const box = new THREE.Box3().setFromObject(vis);
    console.log(`\n=== ${key} / ${assetKey}  — ${(box.max.y - box.min.y).toFixed(1)}u long, snout at y ${box.max.y.toFixed(1)}`);
    console.log(`    clips: ${clips.length ? clips.join(', ') : 'NONE'}`);
    if (!rig) {
      console.log('    NO biteRig — it plays an authored clip instead. Measuring that:');
      measureClip(vis, vis.userData?.clips ?? gltf.animations, box);
      continue;
    }
    console.log(`    biteRig: bone ${rig.bone} axis ${rig.axis} openAngle ${rig.openAngle}`);

    const bone = vis.getObjectByName(rig.bone);
    if (!bone) { console.log(`    bone ${rig.bone} NOT FOUND on this model`); continue; }

    const jaw = createJawDriver(vis);
    if (!jaw) { console.log('    createJawDriver returned null'); continue; }

    // Where the bone sits, and how far the snout is from it — the lever arm any
    // attached body would swing on.
    const origin = new THREE.Vector3();
    bone.getWorldPosition(origin);
    console.log(`    bone origin (world, rest): ${origin.x.toFixed(2)}, ${origin.y.toFixed(2)}, ${origin.z.toFixed(2)}`);
    console.log(`    ...that is ${(box.max.y - origin.y).toFixed(2)}u behind the snout tip`);

    // Sweep the gape and record where the bone's ORIGIN goes, and where a point
    // one lever-arm out along the bone's own local forward goes. Forced world
    // matrices every step or every pose measures identical.
    const lever = Math.max(0.5, box.max.y - origin.y);
    const probeLocal = new THREE.Vector3(0, 0, 0);
    const qNow = new THREE.Quaternion();
    const qRest = new THREE.Quaternion();
    let gapeSweep = 0;
    const p = new THREE.Vector3();
    let originMin = new THREE.Vector3(1e9, 1e9, 1e9);
    let originMax = new THREE.Vector3(-1e9, -1e9, -1e9);
    let tipMin = new THREE.Vector3(1e9, 1e9, 1e9);
    let tipMax = new THREE.Vector3(-1e9, -1e9, -1e9);
    for (let i = 0; i <= 20; i++) {
      // setGape only STORES — update(dt) is what writes the bone. Without it
      // every pose measures identical and nothing throws.
      jaw.setGape(i / 20);
      jaw.update(1 / 60);
      vis.updateMatrixWorld(true);
      bone.getWorldPosition(p);
      originMin.min(p); originMax.max(p);
      // A point out along the jaw, expressed in the bone's own space, is what
      // actually swings — the origin is the hinge.
      probeLocal.set(0, lever, 0);
      const tip = probeLocal.clone().applyMatrix4(bone.matrixWorld);
      tipMin.min(tip); tipMax.max(tip);
      bone.getWorldQuaternion(qNow);
      if (i === 0) qRest.copy(qNow);
      else {
        const a = 2 * Math.acos(Math.min(1, Math.abs(qRest.dot(qNow))));
        if (a > gapeSweep) gapeSweep = a;
      }
    }
    jaw.setGape(0);
    const span = (a, b) => new THREE.Vector3().subVectors(b, a);
    const so = span(originMin, originMax);
    const st = span(tipMin, tipMax);
    console.log(`    gape 0->1 moves the bone ORIGIN by ${so.length().toFixed(3)}u — it is the hinge, so this is meant to be ~0`);
    console.log(`    ...and SWEEPS ${(gapeSweep * 180 / Math.PI).toFixed(0)} deg of world rotation`
      + ` — a body pinned 2u out swings ${(gapeSweep * 2).toFixed(2)}u, 4u out ${(gapeSweep * 4).toFixed(2)}u`);

    // And what the SHAKE currently is, for comparison.
    const c = CONFIG.bossGrab ?? {};
    const r = (def.radius ?? 2) * sizeMulOf(key);
    console.log(`    current synthetic shake: +/-${(r * (c.thrashAmp ?? 0.4)).toFixed(2)}u at ${(c.thrashRate ?? 11).toFixed(0)} rad/s, mouth offset ${(r * (c.mouthOffset ?? 0.5)).toFixed(2)}u`);
  }
}


// ---------------------------------------------------------------------------
// WHAT AN AUTHORED BITE ACTUALLY MOVES.
//
// The bone is found by MEASUREMENT rather than by name: play the clip and see
// which bones travel furthest in world space. A clip named "Bite" that keys
// thirteen tracks of rest pose is a marker somebody left in the file (see the
// great white's, in systems/jaw.js), and a name cannot tell those apart.
// ---------------------------------------------------------------------------
function measureClip(vis, animations, box) {
  const clip = animations.find((c) => /bite|tear|chomp|attack/i.test(c.name));
  // Asked of userData.clips, not gltf.animations: installModel subclips and
  // renames, so the list the GAME plays from is not the list in the file — the
  // mosasaur's `mosaBite` exists only in the first.
  if (!clip) { console.log('      no bite-shaped clip in this file'); return; }
  const mixer = new THREE.AnimationMixer(vis);
  const action = mixer.clipAction(clip);
  action.play();

  // Every bone in the rig, tracked in world space across the clip.
  const bones = [];
  vis.traverse((o) => { if (o.isBone) bones.push(o); });
  const min = new Map();
  const max = new Map();
  const p = new THREE.Vector3();
  // THE ROTATION IS THE MEASUREMENT, not the origin's travel — a hinge's origin
  // IS the pivot and stays put however far the jaw swings, which is why the
  // first pass of this tool reported tail fins and no jaw at all. What a body
  // held in the mouth feels is the world rotation swept, times how far out it
  // is pinned.
  const q = new THREE.Quaternion();
  const qMin = new Map();
  const sweep = new Map();
  const jump = new Map();
  const prev = new Map();
  const qLocalFirst = new Map();
  const localSweep = new Map();
  const STEPS = 60;
  for (let i = 0; i <= STEPS; i++) {
    mixer.setTime((i / STEPS) * clip.duration);
    vis.updateMatrixWorld(true);
    for (const b of bones) {
      b.getWorldPosition(p);
      if (!min.has(b)) { min.set(b, p.clone()); max.set(b, p.clone()); }
      else { min.get(b).min(p); max.get(b).max(p); }
      // LOCAL rotation, which is what tells a HINGE from a bone being carried.
      // A jaw turns in its parent's frame; a spine bone halfway down a body
      // that is undulating accumulates just as much WORLD rotation while
      // hinging almost nothing. On a rig whose bone names carry no meaning —
      // which this mosasaur's do not, they are all `Bone0NN_NN` — this is the
      // only way to find the jaw at all.
      if (!qLocalFirst.has(b)) { qLocalFirst.set(b, b.quaternion.clone()); localSweep.set(b, 0); }
      else {
        const a = 2 * Math.acos(Math.min(1, Math.abs(qLocalFirst.get(b).dot(b.quaternion))));
        if (a > localSweep.get(b)) localSweep.set(b, a);
      }
      b.getWorldQuaternion(q);
      if (!qMin.has(b)) { qMin.set(b, q.clone()); sweep.set(b, 0); jump.set(b, 0); prev.set(b, q.clone()); }
      else {
        const a = 2 * Math.acos(Math.min(1, Math.abs(qMin.get(b).dot(q))));
        if (a > sweep.get(b)) sweep.set(b, a);
        // FRAME TO FRAME, which is what tells a big smooth rotation apart from
        // a quaternion that is flipping. A real animation moves a few degrees a
        // frame; a decomposition artifact jumps by most of a half-turn, and
        // both report the same total sweep.
        const d = 2 * Math.acos(Math.min(1, Math.abs(prev.get(b).dot(q))));
        if (d > jump.get(b)) jump.set(b, d);
        prev.get(b).copy(q);
      }
    }
  }
  // A DEGENERATE BONE SCALE MAKES getWorldQuaternion LIE. It decomposes
  // matrixWorld, and a negative or wildly non-uniform scale — which FBX
  // conversions routinely carry — decomposes to a quaternion that flips between
  // frames. That reads as 180 degrees of sweep on bones that are barely moving,
  // which is exactly what this tool first reported for the mosasaur.
  mixer.setTime(0);
  vis.updateMatrixWorld(true);
  const sc = new THREE.Vector3();
  const bad = [];
  for (const b of bones) {
    b.getWorldScale(sc);
    const uniform = Math.abs(sc.x - sc.y) < 1e-3 * Math.abs(sc.x) && Math.abs(sc.y - sc.z) < 1e-3 * Math.abs(sc.y);
    if (sc.x < 0 || sc.y < 0 || sc.z < 0 || !uniform) bad.push({ b, sc: sc.clone() });
  }
  if (bad.length) {
    console.log(`      WARNING: ${bad.length} of ${bones.length} bones have negative or non-uniform world scale`);
    console.log(`        e.g. ${bad[0].b.name} scale ${bad[0].sc.x.toFixed(3)}, ${bad[0].sc.y.toFixed(3)}, ${bad[0].sc.z.toFixed(3)}`);
    console.log('        — the rotation figures below are NOT trustworthy on this rig (getWorldQuaternion decomposes)');
  }

  const moved = bones
    .map((b) => ({
      b,
      d: new THREE.Vector3().subVectors(min.get(b), max.get(b)).length(),
      rot: sweep.get(b) ?? 0,
      jump: jump.get(b) ?? 0,
      local: localSweep.get(b) ?? 0,
    }))
    .sort((a, z) => z.local - a.local);
  console.log(`      clip "${clip.name}" ${clip.duration.toFixed(2)}s, ${clip.tracks.length} tracks, ${bones.length} bones`);
  console.log('      by how much each bone HINGES in its parent — a jaw does, a carried spine bone does not:');
  // WHERE ON THE ANIMAL each mover sits, as a fraction from tail (0) to snout
  // (1). This is the question the rotation alone cannot answer: a clip called
  // "Bite" that only moves the back half is a body thrash, and anything pinned
  // to the mouth would be shaken by the wrong end of the fish.
  mixer.setTime(0);
  vis.updateMatrixWorld(true);
  const rest = new Map();
  for (const b of bones) { const v = new THREE.Vector3(); b.getWorldPosition(v); rest.set(b, v); }
  const lo = box.min.y; const hi = box.max.y;
  const where = (b) => (rest.get(b).y - lo) / Math.max(0.001, hi - lo);
  for (const m of moved.slice(0, 6)) {
    console.log(`        ${m.b.name.padEnd(26)} turns ${(m.rot * 180 / Math.PI).toFixed(0).padStart(4)} deg`
      + `  · ${(where(m.b) * 100).toFixed(0).padStart(3)}% toward the snout`
      + `  · hinges ${(m.local * 180 / Math.PI).toFixed(0).padStart(3)} deg in its parent`);
  }
  // THE FRONT QUARTER IN FULL, with travel as well as rotation. Those are two
  // different attachments and they read differently: a bone that ROTATES swings
  // a held body through an arc, and a bone that TRAVELS carries it bodily. On a
  // clip that is really a whole-body lunge, the head's travel is the effect
  // worth having and its jaw's rotation is the small print.
  const front = moved.filter((m) => where(m.b) > 0.75 && (m.rot > 0.05 || m.d > 0.05))
    .sort((a, z) => z.d - a.d);
  if (!front.length) {
    console.log('      NOTHING in the front quarter moves — this clip cannot shake anything held in the mouth');
  } else {
    console.log('      the front quarter, by how far it CARRIES a held body:');
    for (const m of front) {
      console.log(`        ${m.b.name.padEnd(26)} travels ${m.d.toFixed(2).padStart(5)}u`
        + ` · turns ${(m.rot * 180 / Math.PI).toFixed(0).padStart(4)} deg`
        + ` · ${(where(m.b) * 100).toFixed(0)}% toward the snout`);
    }
  }
  const total = moved.reduce((a, m) => a + m.d, 0);
  console.log(`      ${moved.filter((m) => m.d > 0.05).length} of ${bones.length} bones move at all; `
    + `body is ${(box.max.y - box.min.y).toFixed(1)}u long`);
  if (total < 1e-3) console.log('      NOTHING MOVES — this clip is a marker, not an animation');
  mixer.stopAllAction();
}
