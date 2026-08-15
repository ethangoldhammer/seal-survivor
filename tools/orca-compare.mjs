#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The shipped orca against the candidates tools/orca-split.mjs cuts out of
// Orca_Family_opt.glb, measured on the things that decide whether a swap is
// worth doing.
//
// EVERY NUMBER IS MEASURED ON THE POSED BODY, through the game's own loader —
// installModel and createVisual, the same path a spawn takes — because that is
// where a model's `fit`, its orientation and its bind pose all get applied, and
// a comparison taken on the raw file is a comparison of three different
// coordinate systems.
//
// The five questions, in the order they matter:
//
//   DENSITY      how faceted the body looks at boss scale.
//   RIG          whether the bones describe a whale or something else. Named
//                bones are not proof, so the flipper bones are found by
//                MEASURING which ones drive vertices out to +/-X — the same
//                method assets.js used on the current rig, and the reason its
//                fin chains are called Thigh and Foot.
//   POSE         whether the bind pose is a straight animal. A curled one is
//                what makes the current orca's bounding box nearly square and
//                what any shape fitted to it has to work around.
//   MOTION       whether the clip actually swims. A 1.93s take that turns out
//                to be a T-pose hold would sink the whole idea.
//   HITBOX       what systems/hitShape.js makes of each body, which is the
//                thing this session just built and the most direct read on
//                whether the geometry is coherent.
//
//   node --import ./tools/vite-loader.mjs tools/orca-compare.mjs [extra.glb ...]
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

import * as THREE from 'three';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { installModel, createVisual } from '../path/src/assets.js';
import { attachHitShape, hitShapeSpheres, tickHitShapes } from '../path/src/systems/hitShape.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const CANDIDATES = [
  { label: 'SHIPPED  orca.glb', path: resolve(HERE, '../public/models/orca.glb') },
  ...process.argv.slice(2).map((p) => ({ label: `CANDIDATE ${basename(p)}`, path: resolve(p) })),
];

const loader = new GLTFLoader();
const scene = new THREE.Scene();
const rows = [];

for (let i = 0; i < CANDIDATES.length; i++) {
  const c = CANDIDATES[i];
  if (!existsSync(c.path)) { console.log(`\n${c.label}: missing (${c.path})`); continue; }
  const buf = readFileSync(c.path);
  const gltf = await loader.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');

  // Installed AS `enemyOrca`, one candidate at a time, and deliberately not
  // under a throwaway key: installModel only knows keys that exist in the
  // ASSETS registry, and more to the point the whole question is what each
  // body looks like through the entry the game actually uses — its `fit` of
  // 5.2, its `forward: +Z`, its pivot and its rig. A candidate measured
  // through a made-up entry is a candidate measured in a different game.
  //
  // Safe because this process measures and exits. It writes nothing.
  const key = 'enemyOrca';
  installModel(key, gltf.scene, gltf.animations);
  const visual = createVisual(key);
  const holder = new THREE.Object3D();
  holder.add(visual);
  scene.add(holder);
  scene.updateMatrixWorld(true);

  const meshes = [];
  const bones = [];
  visual.traverse((o) => { if (o.isMesh) meshes.push(o); if (o.isBone) bones.push(o); });
  const verts = meshes.reduce((n, m) => n + (m.geometry.attributes.position?.count ?? 0), 0);
  const tris = meshes.reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0);

  // --- pose ---------------------------------------------------------------
  // Measured after createVisual, which has already turned the body nose-up, so
  // "long" is Y for every candidate and the numbers are comparable.
  const box = new THREE.Box3().setFromObject(visual);
  const size = box.getSize(new THREE.Vector3());
  const straight = size.y / Math.max(size.x, 1e-6);

  // --- rig ----------------------------------------------------------------
  // WHICH BONES ACTUALLY DRIVE THE FLIPPERS, found by measurement. For every
  // bone, the mean position of the vertices it dominates; the pair reaching
  // furthest to opposite sides, well away from the centreline, is the
  // pectorals. Names are then reported rather than trusted.
  const skinned = meshes.filter((m) => m.isSkinnedMesh && m.skeleton?.bones?.length);
  let flippers = [];
  let driving = 0;
  if (skinned.length) {
    const m = skinned[0];
    const sk = m.skeleton.bones;
    const si = m.geometry.attributes.skinIndex;
    const sw = m.geometry.attributes.skinWeight;
    const pos = m.geometry.attributes.position;
    const n = new Array(sk.length).fill(0);
    const sx = new Array(sk.length).fill(0);
    for (let v = 0; v < pos.count; v++) {
      let best = -1, bw = 0;
      const w = [sw.getX(v), sw.getY(v), sw.getZ(v), sw.getW(v)];
      const b = [si.getX(v), si.getY(v), si.getZ(v), si.getW(v)];
      for (let k = 0; k < 4; k++) if (w[k] > bw) { bw = w[k]; best = b[k]; }
      if (best < 0) continue;
      n[best] += 1;
      sx[best] += pos.getX(v);
    }
    driving = n.filter((c) => c > 0).length;
    const spread = [];
    for (let b = 0; b < sk.length; b++) {
      if (n[b] < 20) continue;
      spread.push({ name: sk[b].name, x: sx[b] / n[b], n: n[b] });
    }
    const left = spread.filter((s) => s.x > 0).sort((a, b) => b.x - a.x)[0];
    const right = spread.filter((s) => s.x < 0).sort((a, b) => a.x - b.x)[0];
    flippers = [left, right].filter(Boolean);
  }

  // --- motion -------------------------------------------------------------
  // Does the clip swim? Play it and watch the LAST bone in the longest chain —
  // the fluke tip — and report how far it travels relative to the body.
  const clips = visual.userData.clips ?? {};
  const clipNames = Object.keys(clips);
  let sweep = 0;
  let clipUsed = '(none)';
  if (skinned.length && gltf.animations.length) {
    const clip = gltf.animations.find((a) => /swim/i.test(a.name)) ?? gltf.animations[0];
    clipUsed = clip.name;
    const mixer = new THREE.AnimationMixer(visual);
    mixer.clipAction(clip).play();
    // Deepest bone in the hierarchy stands in for the fluke tip. Chosen by
    // depth rather than by name, so this works on either rig.
    let tip = null, deepest = -1;
    for (const b of bones) {
      let d = 0;
      for (let p = b; p; p = p.parent) d += 1;
      if (d > deepest) { deepest = d; tip = b; }
    }
    const at = [];
    const v = new THREE.Vector3();
    for (let f = 0; f < 60; f++) {
      mixer.update(clip.duration / 60);
      scene.updateMatrixWorld(true);
      tip.getWorldPosition(v);
      at.push(v.clone());
    }
    const tb = new THREE.Box3().setFromPoints(at);
    // As a fraction of body length, so a big model and a small one compare.
    sweep = tb.getSize(new THREE.Vector3()).length() / Math.max(size.y, 1e-6);
  }

  // --- hitbox -------------------------------------------------------------
  const shape = attachHitShape(visual, key);
  tickHitShapes();
  const spheres = shape ? hitShapeSpheres(shape) : [];

  rows.push({
    label: c.label,
    kb: Math.round(buf.length / 1024),
    verts, tris: Math.round(tris),
    bones: bones.length,
    driving,
    straight,
    len: size.y, wide: size.x, tall: size.z,
    flippers: flippers.map((f) => f.name),
    clips: clipNames.length ? clipNames.join('/') : gltf.animations.map((a) => a.name).join('/'),
    clipCount: gltf.animations.length,
    clipUsed,
    sweep,
    spheres: spheres.length,
  });

  scene.remove(holder);
}

const pad = (s, n) => String(s).padEnd(n);
const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');

console.log('\n=== DENSITY ===');
console.log(pad('', 26) + pad('file', 9) + pad('verts', 9) + pad('tris', 9));
for (const r of rows) console.log(pad(r.label, 26) + pad(`${r.kb}KB`, 9) + pad(r.verts, 9) + pad(r.tris, 9));

console.log('\n=== RIG ===');
console.log(pad('', 26) + pad('bones', 8) + pad('driving', 9) + 'the two bones that actually drive the flippers');
for (const r of rows) {
  console.log(pad(r.label, 26) + pad(r.bones, 8) + pad(r.driving, 9) + (r.flippers.join(' / ') || '-'));
}

console.log('\n=== POSE (after createVisual, so long axis is Y for all) ===');
console.log(pad('', 26) + pad('long', 9) + pad('wide', 9) + pad('tall', 9) + 'long:wide');
for (const r of rows) {
  console.log(pad(r.label, 26) + pad(num(r.len), 9) + pad(num(r.wide), 9) + pad(num(r.tall), 9) + `${num(r.straight)} : 1`);
}

console.log('\n=== MOTION ===');
console.log(pad('', 26) + pad('clips', 7) + pad('played', 26) + 'fluke travel, as a fraction of body length');
for (const r of rows) {
  console.log(pad(r.label, 26) + pad(r.clipCount, 7) + pad(r.clipUsed, 26) + num(r.sweep, 3));
}

console.log('\n=== HITBOX (systems/hitShape.js) ===');
console.log(pad('', 26) + 'spheres kept');
for (const r of rows) console.log(pad(r.label, 26) + r.spheres);

console.log('\n=== CLIPS ON FILE ===');
for (const r of rows) console.log(`${pad(r.label, 26)}${r.clips}`);
console.log('');
