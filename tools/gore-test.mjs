#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:gore
//
// WHAT IS LEFT WHEN A MAN IS EATEN IN THE WATER. See systems/gore.js.
//
// The effect is two halves that fail in completely different ways, and every
// failure below is one that looks like nothing at all on screen — which is the
// whole reason this file exists. A gore burst that quietly stopped throwing
// solids is indistinguishable from one that was always only particles, and
// nobody would notice for weeks.
//
//   THE POOL IS NEVER EMPTY   the shapes come from models that may not have
//                             loaded, may never have been listed, or may be an
//                             upload the player never makes. Every one of those
//                             paths has to land on the procedural stand-in
//                             instead of on zero shapes, because zero shapes is
//                             a silent no-op with no error anywhere.
//
//   EVERY SHAPE IS UNIT-SIZED a bone exported in centimetres is a piece a
//                             hundred times the man; one exported in metres is
//                             invisible. Both are plausible exports and neither
//                             throws. The pool normalises on the way in, and
//                             this is the assertion that says it did — measured
//                             off the real geometry, not off the code path.
//
//   SIZE IS A MULTIPLE OF HIM piece size must scale with the man's height and
//                             with nothing else, so the effect survives the
//                             crew height being retuned. A hand-typed world
//                             size passes every visual check on the day it is
//                             written and drifts silently afterwards. See
//                             [[assets-carry-a-size-multiplier]].
//
//   THE BUFFER NEVER OVERRUNS instance buffers cannot grow, and a write past
//                             the end of one is SILENT — no exception, no
//                             warning, just instances that draw somewhere else
//                             or not at all. So: more pieces than the cap, more
//                             pieces than any one shape's starting capacity,
//                             and both counts checked against what was actually
//                             allocated.
//
//   THE RED IS INDEPENDENT    the particles are the effect; the solids are the
//                             garnish. Switching the solids off, or having no
//                             scene to put them in, must leave the red firing.
//
//   ONE BODY, ONE BURST       two hunters reach the same man on the same frame
//                             and only one of them gets him. The second must
//                             pay for nothing — no second burst, no second
//                             handful of bones.
//
// Everything expected is derived from CONFIG rather than typed in: saved tuning
// is merged over the defaults at import, so a hardcoded 16 here would be
// testing imported-tuning.json rather than the code.
//
// What it cannot tell you: whether it reads as a man coming apart. That is a
// run.
//
//   node --import ./tools/vite-loader.mjs tools/gore-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CONFIG } from '../path/src/config.js';
import { bounds } from '../path/src/arena.js';
import { installModel, hasModel } from '../path/src/assets.js';
import { initParticles, resetParticles, particleCount } from '../path/src/entities/particles.js';
import {
  initGore, spawnGore, updateGore, resetGore, gorePieceCount, goreShapeCount,
} from '../path/src/systems/gore.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const scene = new THREE.Scene();
initParticles(scene);
initGore(scene);

const P = () => CONFIG.gore.pieces;
// The instanced meshes the system put in the scene, which is the only place
// the drawn instance count can honestly be read from.
const goreMeshes = () => scene.children.filter((o) => o.name === 'gorePieces');
const drawn = () => goreMeshes().reduce((n, m) => n + m.count, 0);

// A body, eaten. `height` is the man's, which is the only scale anything here
// is measured against.
const eat = (opts = {}) => spawnGore(opts.x ?? 0, opts.y ?? -3, {
  height: opts.height ?? CONFIG.boats.crew.height,
  vx: opts.vx ?? 0,
  vy: opts.vy ?? 0,
});

const fresh = () => {
  resetGore();
  resetParticles();
};

// ---------------------------------------------------------------------------
section('The pool always has shapes in it');
// ---------------------------------------------------------------------------
{
  const shapes = goreShapeCount();
  check('nothing listed still yields a pool', shapes > 0, `${shapes} shapes`);
  check('more than one shape, so a burst is not one lump repeated',
    shapes >= 4, `${shapes} shapes`);
}

// ---------------------------------------------------------------------------
section('Every shape is centred and normalised to unit size');
// ---------------------------------------------------------------------------
{
  fresh();
  // Throw enough that every shape in the pool is near-certain to appear, then
  // measure the geometry the meshes were actually built with.
  for (let i = 0; i < 30; i++) eat();
  updateGore(1 / 60);

  const meshes = goreMeshes();
  check('a mesh per shape reached the scene', meshes.length > 0, `${meshes.length} meshes`);

  let worstSpan = 0;
  let worstCentre = 0;
  let nan = 0;
  for (const m of meshes) {
    const geo = m.geometry;
    geo.computeBoundingBox();
    const size = new THREE.Vector3();
    const centre = new THREE.Vector3();
    geo.boundingBox.getSize(size);
    geo.boundingBox.getCenter(centre);
    worstSpan = Math.max(worstSpan, Math.abs(Math.max(size.x, size.y, size.z) - 1));
    worstCentre = Math.max(worstCentre, centre.length());
    const pos = geo.attributes.position.array;
    for (let i = 0; i < pos.length; i++) if (!Number.isFinite(pos[i])) nan++;
  }
  check('longest axis of every shape is 1', worstSpan < 1e-4, `worst off by ${worstSpan.toExponential(2)}`);
  check('every shape is centred on its own box', worstCentre < 1e-4, `worst off by ${worstCentre.toExponential(2)}`);
  // lumpify() displaces on DIRECTION rather than on vertex index precisely so
  // duplicated seam vertices stay welded; a NaN here is that maths having gone
  // wrong on a zero-length vertex, which renders as nothing at all.
  check('no NaN anywhere in the geometry', nan === 0, `${nan} bad floats`);
  // Position and normal are the whole draw — a bone model can arrive carrying
  // uvs, tangents and skin weights, all of which would be uploaded per shape
  // and never read.
  const extra = meshes.flatMap((m) => Object.keys(m.geometry.attributes))
    .filter((n) => n !== 'position' && n !== 'normal');
  check('nothing but position and normal is uploaded', extra.length === 0, extra.join(','));
}

// ---------------------------------------------------------------------------
section('Piece size is a multiple of the man, not a world size');
// ---------------------------------------------------------------------------
{
  // Read the scale straight off the instance matrices, which is what actually
  // decides how big a piece looks. Averaged, because size is jittered per
  // piece — the claim being tested is about the ratio, not any one piece.
  // Averaged over all three axes as well as over the burst: `lengthJitter` and
  // `girthJitter` deliberately make a piece non-uniform, so any single axis is
  // a noisy estimate of "how big is it" while the mean of the three is not.
  const meanScale = (height) => {
    fresh();
    for (let i = 0; i < 200; i++) eat({ height });
    updateGore(1 / 600); // barely a frame: no shrink-out has started yet
    let total = 0;
    let n = 0;
    const m4 = new THREE.Matrix4();
    const s = new THREE.Vector3();
    for (const mesh of goreMeshes()) {
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m4);
        m4.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
        total += (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3;
        n++;
      }
    }
    return n ? total / n : 0;
  };

  const small = meanScale(1);
  const big = meanScale(4);
  check('a piece has a size at all', small > 0, small.toFixed(4));
  // Four times the man, four times the piece. A tolerance rather than an
  // equality because the sizes are jittered and this is an average over a
  // finite sample.
  const ratio = big / (small || 1);
  check('four times the man is four times the piece', Math.abs(ratio - 4) < 0.4, `ratio ${ratio.toFixed(3)}`);
  // ...and the absolute size is the configured multiple of his height.
  const expected = 1 * P().size;
  check('size is height x pieces.size', Math.abs(small - expected) / expected < 0.15,
    `${small.toFixed(4)} vs ${expected.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
section('The instance buffers are never overrun');
// ---------------------------------------------------------------------------
{
  fresh();
  const max = Math.round(P().max);
  // Far more bodies than the cap can hold, all at once.
  const meals = Math.ceil((max * 4) / Math.max(1, Math.round(P().count)));
  for (let i = 0; i < meals; i++) eat();
  check('the live pieces are capped', gorePieceCount() <= max, `${gorePieceCount()} <= ${max}`);

  updateGore(1 / 60);
  let overrun = 0;
  for (const m of goreMeshes()) {
    if (m.count > m.instanceMatrix.count) overrun++;
    if (m.count > m.instanceColor.count) overrun++;
  }
  check('no mesh draws more instances than it allocated', overrun === 0, `${overrun} overruns`);
  check('everything alive is actually drawn', drawn() === gorePieceCount(),
    `${drawn()} drawn vs ${gorePieceCount()} alive`);
  // The buffers START at 16 and grow by rebuild. A cap well above that means
  // the growth path is what just ran — without this the check above passes on
  // a burst that never needed to grow, which is the case that never breaks.
  const grown = goreMeshes().some((m) => m.instanceMatrix.count > 16);
  check('a shape grew past its starting buffer', grown || max <= 16,
    `largest buffer ${Math.max(...goreMeshes().map((m) => m.instanceMatrix.count))}`);
}

// ---------------------------------------------------------------------------
section('The pieces sink, settle, and go');
// ---------------------------------------------------------------------------
{
  fresh();
  eat({ y: bounds.surfaceY - 1 });
  const started = gorePieceCount();
  check('a body throws pieces', started > 0, `${started}`);

  // Half a life in: still there, and every one of them at or above the seabed.
  const life = P().life;
  let below = 0;
  for (let t = 0; t < life * 0.5; t += 1 / 60) {
    updateGore(1 / 60);
    for (const mesh of goreMeshes()) {
      const m4 = new THREE.Matrix4();
      const pos = new THREE.Vector3();
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m4);
        pos.setFromMatrixPosition(m4);
        if (pos.y < bounds.bottom) below++;
      }
    }
  }
  check('still in the water halfway through', gorePieceCount() > 0, `${gorePieceCount()}`);
  check('nothing falls through the seabed', below === 0, `${below} sightings below the floor`);

  // ...and past the longest life any of them rolled, all of it is gone. The
  // jitter is symmetric around `life`, so the ceiling is life * (1 + jitter/2).
  const ceiling = life * (1 + P().lifeJitter * 0.5) + 0.5;
  for (let t = 0; t < ceiling; t += 1 / 60) updateGore(1 / 60);
  check('all of it is gone by the longest life', gorePieceCount() === 0, `${gorePieceCount()} left`);
  check('and nothing is left drawing', drawn() === 0, `${drawn()} instances`);
}

// ---------------------------------------------------------------------------
section('The red is the effect; the solids are the garnish');
// ---------------------------------------------------------------------------
{
  const redFrom = (mutate) => {
    fresh();
    const before = particleCount();
    mutate?.();
    eat();
    const after = particleCount();
    return after - before;
  };

  const full = redFrom();
  // A LOT OF RED, SCALED BY THE THINNING KNOB. `fx.spriteDensity` is a global
  // dial over every sprite emitter in the game — 0.35 as this is written — and
  // it scales two of the three layers below, so a flat `> 100` was really
  // asserting that nobody had ever turned it down. The claim worth holding is
  // that a meal is a burst and not a handful, so the bar moves with the knob:
  // a hundred at full density, thirty-five at a third of it. The exact
  // arithmetic is the check under this one, which reads the knob already.
  const density = Math.min(1, CONFIG.fx.spriteDensity ?? 1);
  check('a meal throws a lot of red', full > 100 * density,
    `${full} particles, against 100 x spriteDensity ${density}`);
  // The three layers are separately tunable and separately switchable, which is
  // the only reason they are three emitters rather than one.
  // What one layer is worth: its authored count, the gore system's own scale
  // for that layer, and — for the two SPRITE layers — the global thinning knob
  // on top. `goreCloud` is the goo layer and is not scaled by it, which is
  // exactly the asymmetry this sum has to carry or the check reads as a gore
  // bug the next time the knob moves.
  const layer = (name, scale) => Math.round(
    CONFIG.emitters[name].count * scale * (CONFIG.emitters[name].goo ? 1 : (CONFIG.fx.spriteDensity ?? 1)),
  );
  const declared = layer('gore', CONFIG.gore.spray)
    + layer('goreMist', CONFIG.gore.mist)
    + layer('goreCloud', CONFIG.gore.cloud);
  check('all three layers fired', full === declared, `${full} vs ${declared} declared`);

  const savedPieces = P().enabled;
  const withoutSolids = redFrom(() => { P().enabled = false; });
  check('the red still fires with the solids off', withoutSolids === full, `${withoutSolids}`);
  check('...and no solids are thrown', gorePieceCount() === 0, `${gorePieceCount()}`);
  P().enabled = savedPieces;

  const savedEnabled = CONFIG.gore.enabled;
  const off = redFrom(() => { CONFIG.gore.enabled = false; });
  check('switched off, nothing fires at all', off === 0, `${off} particles`);
  CONFIG.gore.enabled = savedEnabled;
}

// ---------------------------------------------------------------------------
section('The colours are the one red family, and bone is not one of them');
// ---------------------------------------------------------------------------
{
  // The palette rule: an emitter is one colour family, and a burst's colour
  // says what KIND of event it was. Red here means a person — so every colour
  // in all three layers has to actually BE red, or the rule is decoration.
  const reddest = (hex) => {
    const c = new THREE.Color(hex);
    return c.r > c.g && c.r > c.b;
  };
  for (const name of ['gore', 'goreMist', 'goreCloud']) {
    const cols = CONFIG.emitters[name].colors;
    check(`${name} is all one red family`, cols.every(reddest), cols.map((c) => '#' + c.toString(16)).join(' '));
  }
  // ...and the SOLIDS are the exception that proves it: bone has to read as
  // bone, which means it must not be red. A pool where the ivory drifted red
  // is a burst with no contrast left in it.
  const bone = new THREE.Color(P().boneColor);
  check('bone is not red', Math.abs(bone.r - bone.b) < 0.35,
    `r ${bone.r.toFixed(2)} b ${bone.b.toFixed(2)}`);
  check('bone is pale', (bone.r + bone.g + bone.b) / 3 > 0.5,
    `mean ${((bone.r + bone.g + bone.b) / 3).toFixed(2)}`);
}

// ---------------------------------------------------------------------------
section('One body, one burst');
// ---------------------------------------------------------------------------
{
  // The guard for this lives in eatCrew (`f.eaten`), not here — spawnGore is
  // told about a body, it does not own one. What this checks is the half that
  // IS this system's: a second call is a second body, and the burst it throws
  // has to be the same size as the first. A pool that only filled properly on
  // the first call would look identical until the second man died.
  fresh();
  eat();
  const first = gorePieceCount();
  eat();
  const second = gorePieceCount() - first;
  check('the second body throws as much as the first', second === first, `${first} then ${second}`);
}

// ---------------------------------------------------------------------------
section('The eater drags the burst along');
// ---------------------------------------------------------------------------
{
  // A shark that takes a body at a run and leaves the pieces hanging perfectly
  // still behind it reads as two unrelated things on the same frame. Measured
  // against a CONTROL run rather than against the spawn point: the pieces are
  // thrown in every direction and drift on their own, so only the difference
  // between "eaten at a standstill" and "eaten at speed" means anything.
  // See [[measure-displacement-against-a-control-run]].
  const centroidAfter = (vx) => {
    fresh();
    for (let i = 0; i < 20; i++) eat({ vx });
    for (let t = 0; t < 0.25; t += 1 / 60) updateGore(1 / 60);
    let sum = 0;
    let n = 0;
    const m4 = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    for (const mesh of goreMeshes()) {
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m4);
        pos.setFromMatrixPosition(m4);
        sum += pos.x;
        n++;
      }
    }
    return n ? sum / n : 0;
  };

  const still = centroidAfter(0);
  const running = centroidAfter(14);
  check('a burst taken at speed is carried downstream', running - still > 0.2,
    `${(running - still).toFixed(3)} units of drift`);
}

// ---------------------------------------------------------------------------
section('The real bone.glb, taken through the pool');
// ---------------------------------------------------------------------------
{
  // Everything above ran on the stand-in shapes, because nothing in a Node
  // harness fetches a model. This is the shipped file, parsed off disk and
  // installed under the key CONFIG.gore.pieces.assets actually names — the one
  // check here that would catch a bad export, a renamed key, or a bone that
  // arrives a hundred times the size of the man who lost it.
  const key = CONFIG.gore.pieces.assets[0];
  check('the config names an asset', !!key, key ?? '(none)');

  const file = new URL('../public/models/bone.glb', import.meta.url);
  const buf = readFileSync(file);
  const gltf = await new GLTFLoader().parseAsync(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
  );

  const rawBox = new THREE.Box3().setFromObject(gltf.scene);
  const rawSize = rawBox.getSize(new THREE.Vector3());
  const rawLongest = Math.max(rawSize.x, rawSize.y, rawSize.z);
  // Stated rather than asserted against a number: this is the fact the
  // normalise() step exists for, and printing it is what makes the assertion
  // below mean something.
  console.log(`  note  the file is ${rawLongest.toFixed(2)} units long, ` +
    `against a man of ${CONFIG.boats.crew.height}`);

  const shapesBefore = goreShapeCount();
  check('installs under the configured key', installModel(key, gltf.scene, gltf.animations));
  check('the asset is loaded now', hasModel(key));

  // The pool is stamped on WHICH KEYS HAVE LOADED, so this is also the check
  // that an upload landing mid-session gets into the next burst instead of
  // waiting for a reload.
  fresh();
  const shapesAfter = goreShapeCount();
  check('the pool rebuilt itself around the model', shapesAfter !== shapesBefore,
    `${shapesBefore} stand-in shapes -> ${shapesAfter} real`);
  // One mesh in the file, plus the two flesh lumps mixed in alongside it.
  check('one mesh is one shape, plus the flesh', shapesAfter === 3, `${shapesAfter}`);

  for (let i = 0; i < 20; i++) eat();
  updateGore(1 / 600);
  let worst = 0;
  for (const mesh of goreMeshes()) {
    mesh.geometry.computeBoundingBox();
    const size = mesh.geometry.boundingBox.getSize(new THREE.Vector3());
    worst = Math.max(worst, Math.abs(Math.max(size.x, size.y, size.z) - 1));
  }
  check('the real bone is normalised like everything else', worst < 1e-4,
    `worst off by ${worst.toExponential(2)}`);

  // The thing the normalisation is FOR. A five-unit bone thrown at the size the
  // file was authored at would be four times the length of the man it came out
  // of, and nothing in the pipeline would complain.
  //
  // The bound is DERIVED, not typed: `size` times the two jitters at their
  // ceilings is exactly how big the largest possible piece is, so this passes
  // for any tuning of those three and fails the moment a piece's size stops
  // being a function of the man. A literal here would instead have to be
  // relaxed by hand every time the size was retuned — which is the same as not
  // having the check.
  //
  // Note the ceiling is ABOVE a man's own height at the shipped numbers, on
  // purpose: a piece sized anatomically is a speck in a fifty-unit arena. See
  // the note on `pieces.size`.
  const m4 = new THREE.Matrix4();
  const s = new THREE.Vector3();
  let longest = 0;
  for (const mesh of goreMeshes()) {
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m4);
      m4.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
      longest = Math.max(longest, Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
    }
  }
  const man = CONFIG.boats.crew.height;
  const ceiling = man * P().size
    * (1 + P().sizeJitter * 0.5)
    * (1 + Math.max(P().lengthJitter, P().girthJitter) * 0.5);
  check('no piece is bigger than the size it was asked for', longest <= ceiling + 1e-6,
    `longest ${longest.toFixed(3)} vs ceiling ${ceiling.toFixed(3)}`);
  // ...and the assertion that actually catches a bad export: the raw file is
  // 5 units long, so an un-normalised bone would blow straight past this.
  check('nowhere near the size the file was authored at', longest < rawLongest * 0.5,
    `${longest.toFixed(3)} vs a ${rawLongest.toFixed(2)}-unit file`);
  check('...and none of them is a speck', longest > man * 0.05, longest.toFixed(3));
}

// ---------------------------------------------------------------------------
section('One bone model is not sixteen identical bones');
// ---------------------------------------------------------------------------
{
  // bone.glb is ONE mesh, so the pool it gives is ONE shape — and a burst of
  // sixteen copies of a single geometry at a single scale reads as a crate
  // being dropped. Two things stop that, and both are silent when they break:
  // the flesh lumps mixed in alongside, and the per-axis stretch. Measured off
  // the instance matrices, because that is the only place either one shows up.
  fresh();
  for (let i = 0; i < 60; i++) eat();
  updateGore(1 / 600);

  const m4 = new THREE.Matrix4();
  const s = new THREE.Vector3();
  const ratios = [];
  for (const mesh of goreMeshes()) {
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m4);
      m4.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
      const axes = [Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)];
      ratios.push(Math.max(...axes) / Math.max(1e-6, Math.min(...axes)));
    }
  }
  const spread = Math.max(...ratios) - Math.min(...ratios);
  check('pieces are stretched, not uniformly scaled',
    Math.max(...ratios) > 1.2, `widest aspect ${Math.max(...ratios).toFixed(2)}`);
  check('...and no two are stretched the same',
    spread > 0.3, `aspect spread ${spread.toFixed(2)}`);

  // The flesh mix. Two colours in the burst is the only contrast it has.
  const bone = new THREE.Color(P().boneColor);
  const meat = new THREE.Color(P().meatColor);
  let bones = 0;
  let flesh = 0;
  for (const mesh of goreMeshes()) {
    for (let i = 0; i < mesh.count; i++) {
      const r = mesh.instanceColor.getX(i);
      const b = mesh.instanceColor.getZ(i);
      // Tint scales all three channels together, so the RATIO survives it and
      // the absolute values do not — which is why this compares r/b rather
      // than matching either colour outright.
      const ratio = r / Math.max(1e-6, b);
      if (Math.abs(ratio - bone.r / bone.b) < Math.abs(ratio - meat.r / meat.b)) bones++;
      else flesh++;
    }
  }
  check('the burst has bone in it', bones > 0, `${bones}`);
  check('...and flesh in it', flesh > 0, `${flesh}`);
  const share = bones / (bones + flesh);
  check('the split is roughly boneShare', Math.abs(share - P().boneShare) < 0.12,
    `${share.toFixed(2)} vs ${P().boneShare}`);
}

// ---------------------------------------------------------------------------
section('A reset leaves nothing behind');
// ---------------------------------------------------------------------------
{
  fresh();
  for (let i = 0; i < 5; i++) eat();
  updateGore(1 / 60);
  check('there is something to clear', gorePieceCount() > 0 && drawn() > 0);
  resetGore();
  check('the pieces are gone', gorePieceCount() === 0);
  // Not merely emptied — the meshes have to STOP DRAWING on the same frame, or
  // the last burst of the previous run hangs in the opening seconds of the next
  // one until something else happens to rewrite the buffers.
  check('and nothing is still drawn', drawn() === 0, `${drawn()} instances`);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
