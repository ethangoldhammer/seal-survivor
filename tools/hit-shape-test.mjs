#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:hitshape
//
// The measured hitbox, on every body a boss can actually arrive in — the three
// files the game loads (megalodon.glb, orca_male.glb, orca_female.glb), not a
// stand-in and not one of them standing in for the others.
//
// THE CONTROL RUN IS THE POINT, the same as tools/boss-rig-test.mjs. "The nose
// is inside the hitbox" means nothing on its own; what means something is that
// the nose is inside the NEW one and was outside the OLD one, measured on the
// same body at the same instant. Every claim below is a pair.
//
// What the circle was and what the shape is, measured here rather than quoted
// — these are the numbers this file prints:
//
//   bossShark        circle r 5.06, covering 95% of the flesh and 80 sq units
//                    of the arena. The shape covers 90% and claims 27 — a
//                    third of the water for almost the same animal.
//   bossOrca (both)  circle r 5.04, covering 80% and claiming 80 sq units.
//                    The shape covers 88% and claims 30: MORE of the animal
//                    and less of the sea.
//
// The shark is the clearer case of the two. Its circle is twice the width of
// the animal and two thirds of its length, which is not a rounding difference:
// it is contact damage from a body-width of open water, and pellets that pass
// through the nose and the tail without touching either.
//
//   node --import ./tools/vite-loader.mjs tools/hit-shape-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
// Both boss models embed their textures and GLTFLoader decodes those through
// createImageBitmap. Without a stub the parse promise never settles and the
// script exits with "unsettled top-level await" and no error at all.
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

import * as THREE from 'three';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { CONFIG } from '../path/src/config.js';
import { installModel } from '../path/src/assets.js';
import { enemies, resetEnemies, spawnNamed } from '../path/src/entities/enemies.js';
import { stateForSpeed } from '../path/src/systems/animation.js';
import {
  hitCreature, hitCreatureSegment, hitShapeSpheres, refreshHitShape,
  worldToShapeLocal, shapeLocalToWorld, tickHitShapes, clearHitShapeCache,
} from '../path/src/systems/hitShape.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

// `pick` forces which body a multi-asset def spawns as — bossOrca carries a
// list and rolls one per arrival, so without this the whole file measures a
// coin flip and reports whichever animal it happened to get. Both are tested
// because they are different meshes: the same hitbox code on two different
// triangulations is two different fits.
const BODIES = [
  { label: 'bossShark', enemy: 'bossShark' },
  { label: 'bossOrca bull', enemy: 'bossOrca', pick: 0 },
  { label: 'bossOrca cow', enemy: 'bossOrca', pick: 1 },
];

// Every model a boss can arrive in. The orca has TWO — its def carries a list
// and spawnOne rolls one per arrival — and both have to be loaded or the roll
// lands on an empty Object3D and every measurement below quietly describes
// nothing. Keyed off the asset entries themselves rather than a second list
// here, so adding a third body is one edit in assets.js.
const MODELS = [
  ['enemyMegalodon', 'megalodon.glb'],
  ['enemyOrcaBull', 'orca_male.glb'],
  ['enemyOrcaCow', 'orca_female.glb'],
];

const loader = new GLTFLoader();
for (const [asset, model] of MODELS) {
  const path = resolve(HERE, '../public/models', model);
  if (!existsSync(path)) {
    console.error(`\nmissing ${path} — a hitbox cannot be measured off a model that isn't there.\n`);
    process.exit(1);
  }
  const buf = readFileSync(path);
  const gltf = await loader.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  installModel(asset, gltf.scene, gltf.animations);
}

const scene = new THREE.Scene();
const contact = { x: 0, y: 0, nx: 0, ny: 0, depth: 0, sphere: null, index: -1 };

// Spawn one, parked at the origin and pointed along +X so the body's long axis
// lies on the arena's x. Every probe below is placed in those terms.
//
// SWUM FOR HALF A SECOND FIRST, and that is not a nicety. A creature's rest
// pose is not the animal the player meets: orca.glb ships a rest pose curled
// nearly into a C — its bounding box is 1.07 : 1, practically square — and its
// swim clip straightens it out to 2.27 : 1. Measuring the hitbox against the
// rest pose is measuring a shape that is never on screen, and it was quietly
// making this file's coverage figures describe the wrong animal.
// Deterministic, which a spawn harness has to be: `spawnOne` rolls the body
// from `def.assets` on its FIRST call to Math.random, and everything after that
// (size variance, depth lane, timers) rolls too. Left alone this file reports
// different numbers run to run and a real regression looks like noise.
function spawnAt(name, heading = 0, pick = null) {
  resetEnemies(scene);
  const realRandom = Math.random;
  if (pick !== null) {
    // The asset roll is the first draw in spawnOne, so answering that one call
    // chooses the body; everything after it runs on a fixed sequence rather
    // than on a constant, which would peg every variance roll to its minimum.
    let n = 0;
    let seed = 12345;
    Math.random = () => {
      if (n++ === 0) return (pick + 0.5) / 2; // mid-bucket, so rounding cannot drift
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
  }
  const e = spawnNamed(scene, name, 0, undefined, { ignoreCaps: true, overfill: true });
  Math.random = realRandom;
  e.mesh.position.set(0, 0, 0);
  e.heading = heading;
  // Cruising speed, so this is the `swim` state rather than `idle` — the state
  // a boss is in for essentially the whole of its fight.
  for (let i = 0; i < 30; i++) e.anim?.update(1 / 60, stateForSpeed(e.def.speed ?? 5), false);
  // faceMotion creatures carry their heading as rotation.z - PI/2 (the models
  // are built nose-up). Set directly rather than by ticking the integrator, so
  // the probe geometry below is exact rather than approximately where a frame
  // of steering happened to leave it.
  e.mesh.rotation.z = heading - Math.PI / 2;
  scene.updateMatrixWorld(true);
  tickHitShapes();
  return e;
}

// The old test, kept verbatim: one circle of radius e.radius.
function circleHit(e, x, y, r = 0) {
  const dx = x - e.mesh.position.x;
  const dy = y - e.mesh.position.y;
  const reach = e.radius + r;
  return dx * dx + dy * dy <= reach * reach;
}

// The drawn body in its OWN frame, so "the nose" and "beside it" are measured
// off the mesh rather than typed in.
//
// TWO TRAPS HERE, and the first version of this file fell into both.
//
// Measured with the container turned back to zero, because Box3.setFromObject
// works in world space: a body facing right reports its length as an x-extent
// and its width as a y-extent, and calling the y half "along the body" had
// this file claiming a megalodon was five units long and sixteen wide.
//
// And returned as MIN AND MAX rather than as half-extents, because a model is
// not centred on its own origin and these two are emphatically not. The
// megalodon runs from -13.68 to +2.41 along its axis — the origin sits up by
// its head — so "0.8 of the half-length forward" is four units past the end of
// its nose, in open water, and every probe built that way was testing whether
// the hitbox extends beyond the animal.
function bodyBox(e) {
  const was = e.mesh.rotation.z;
  e.mesh.rotation.z = 0; // local +Y forward — see createVisual
  scene.updateMatrixWorld(true);
  // BUILT FROM POSED VERTICES, not Box3.setFromObject. That reads
  // `geometry.boundingBox`, which is computed once and cached — so on an
  // animated body it hands back the box of whatever pose it happened to be
  // computed at, forever. With the creature now swimming before it is
  // measured, that stale box was the rest pose and three of the orca's eleven
  // spheres correctly sat outside it. The box was wrong, not the hitbox.
  const b = new THREE.Box3().setFromPoints(fleshSamples(e, 1200).map((p) => new THREE.Vector3(p.x, p.y, p.z)));
  e.mesh.rotation.z = was;
  scene.updateMatrixWorld(true);
  return {
    box: b,
    noseAt: b.max.y,
    tailAt: b.min.y,
    length: b.max.y - b.min.y,
    across: Math.max(Math.abs(b.min.x), Math.abs(b.max.x)),
    mid: (b.max.y + b.min.y) / 2,
  };
}

// THE FLESH ITSELF, in world coordinates: every Nth vertex of every mesh on
// the body, posed exactly as the renderer will pose it.
//
// This is the only honest way to ask "how much of the animal can you hit". The
// obvious alternative — sample down the body's centreline from nose to tail —
// is wrong for the one body that most needs checking: orca.glb ships a bind
// pose with its tail curled well off to one side, so a straight line through
// the model is mostly open water and the shape scored 23/60 while being
// perfectly correct. A vertex is on the animal by definition.
//
// getVertexPosition rather than the raw position attribute, for the reason
// assets.js documents at length: for a SkinnedMesh the attribute is the BIND
// pose, which on these rigs sits nowhere near where the model renders.
// A FIXED STRIDE IS NOT SAFE HERE, which the two boss bodies demonstrate on
// their own: megalodon.glb carries 37,604 vertices and orca.glb carries 968.
// One stride gave the shark a thousand samples and the orca twenty-seven, and
// a coverage percentage off twenty-seven points swings four points per vertex.
// Aimed at a comparable sample count instead, so the two bodies are being
// graded on the same scale.
function fleshSamples(e, want = 500) {
  scene.updateMatrixWorld(true);
  let total = 0;
  e.visual.traverse((o) => { total += o.isMesh ? (o.geometry?.attributes?.position?.count ?? 0) : 0; });
  const stride = Math.max(1, Math.floor(total / want));

  const pts = [];
  const v = new THREE.Vector3();
  e.visual.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += stride) {
      if (typeof o.getVertexPosition === 'function') o.getVertexPosition(i, v);
      else v.fromBufferAttribute(pos, i);
      v.applyMatrix4(o.matrixWorld);
      // z carried as well as x and y: the hit tests only ever look at the
      // arena plane, but bodyBox needs the third dimension to bound a sphere.
      pts.push({ x: v.x, y: v.y, z: v.z });
    }
  });
  return pts;
}

// The two ends of the ANIMAL, taken as the furthest points of real flesh along
// its heading rather than as corners of a box — a box corner on a body this
// shape is usually open water, and on the curled orca bind pose it is open
// water every time. Pulled a tenth of the way back toward the middle so a
// probe measures the hitbox reaching the extremities and not the padding
// reaching past them. Assumes heading 0 (nose along +X), which every caller
// spawns at.
function bodyEnds(e) {
  const flesh = fleshSamples(e);
  let nose = flesh[0];
  let tail = flesh[0];
  for (const p of flesh) {
    if (p.x > nose.x) nose = p;
    if (p.x < tail.x) tail = p;
  }
  const mid = (nose.x + tail.x) / 2;
  return {
    nose: { x: nose.x + (mid - nose.x) * 0.1, y: nose.y },
    tail: { x: tail.x + (mid - tail.x) * 0.1, y: tail.y },
    span: nose.x - tail.x,
    flesh,
  };
}

// A point in the body's own frame, in world coordinates. `along` runs nose-
// positive down the animal's axis and `across` runs out to its side.
//
// The models are built nose-up, so the container carries heading - PI/2: local
// +Y ends up along the heading itself and local +X ends up a quarter turn
// clockwise of it.
function probe(e, along, across = 0) {
  const h = e.heading ?? 0;
  return {
    x: e.mesh.position.x + Math.cos(h) * along + Math.cos(h - Math.PI / 2) * across,
    y: e.mesh.position.y + Math.sin(h) * along + Math.sin(h - Math.PI / 2) * across,
  };
}

// ---------------------------------------------------------------------------
section('THE SHAPE EXISTS AND CAME OFF THE MESH');
// ---------------------------------------------------------------------------
for (const b of BODIES) {
  // Heading +Y, which puts the container's rotation at exactly zero (the
  // models are built nose-up), so world coordinates and the model's own
  // coordinates are the same numbers and the containment check below needs no
  // frame conversion to get wrong.
  const e = spawnAt(b.enemy, Math.PI / 2, b.pick ?? null);
  const spheres = hitShapeSpheres(e.hitShape);
  check(`${b.label} has a measured hitbox`, !!e.hitShape && spheres.length > 1,
    `${spheres.length} spheres`);
  check(`${b.label} kept no more than CONFIG.hitShape.maxSpheres`,
    spheres.length <= CONFIG.hitShape.maxSpheres,
    `${spheres.length} of ${CONFIG.hitShape.maxSpheres}`);

  // Every sphere has to be ON the animal — inside the box the model actually
  // draws in, with a little slack for a sphere fitted around a fin tip. A fit
  // that put one somewhere else (a bone-space slip, a bind matrix applied the
  // wrong way round, a prune run before the body was parented) produces a
  // shape that still passes "has spheres" and hits nothing the player sees.
  // That exact failure happened here, and it looked like twelve perfectly
  // reasonable spheres sitting 90 units off the animal.
  const body = bodyBox(e);
  const room = new THREE.Box3().copy(body.box).expandByScalar(body.length * 0.08);
  const strays = spheres.filter((s) => !room.containsPoint(new THREE.Vector3(s.wx, s.wy, s.wz)));
  check(`${b.label}: every sphere sits inside the drawn body`, strays.length === 0,
    `${strays.length} stray of ${spheres.length}`);
}

// ---------------------------------------------------------------------------
section('THE NOSE AND THE TAIL — what the circle was too SHORT for');
// ---------------------------------------------------------------------------
// The failure the player feels as "I shot it and nothing happened". Probed at
// 80% of the way to the drawn tip, along the body, on both ends.
for (const b of BODIES) {
  const e = spawnAt(b.enemy, 0, b.pick ?? null); // nose along +X
  const { nose, tail, flesh } = bodyEnds(e);

  let unreachable = 0;
  for (const [end, p] of [['nose', nose], ['tail', tail]]) {
    const wasHit = circleHit(e, p.x, p.y, 0.2);
    if (!wasHit) unreachable += 1;
    check(`${b.label}: a pellet at the ${end} connects`,
      hitCreature(e, p.x, p.y, 0.2, contact),
      `${Math.hypot(p.x, p.y).toFixed(1)} from the middle, circle r ${e.radius.toFixed(2)}${wasHit ? ' (circle reached it too)' : ' — the circle did NOT'}`);
  }

  // And the control: at least one of those ends has to be somewhere the circle
  // genuinely could not reach, or this whole file is measuring nothing.
  check(`${b.label}: the circle really was too short to reach one of them`,
    unreachable > 0, `${unreachable} of 2 ends were out of the circle's reach`);

  // THE WHOLE ANIMAL, not just its two tips — the check that catches a fit
  // with a hole in it, which every single-point test above would sail past.
  // The first version of this hitbox lost the megalodon's entire tail and
  // looked perfect in a screenshot.
  //
  // Not 100%: a sphere chain will always leave the odd fin tip and tooth
  // outside, and inflating it until it caught them would be a hitbox fitted to
  // the outliers rather than to the animal.
  const covered = flesh.filter((p) => hitCreature(e, p.x, p.y, 0, contact)).length;
  const frac = covered / flesh.length;
  const byCircle = flesh.filter((p) => circleHit(e, p.x, p.y, 0)).length / flesh.length;
  check(`${b.label}: the shape covers the flesh`, frac >= 0.85,
    `${(frac * 100).toFixed(0)}% of ${flesh.length} sampled vertices are hittable — the circle reached ${(byCircle * 100).toFixed(0)}%`);

  // AND HOW MUCH WATER IT CLAIMS, which is the half of this that coverage
  // alone cannot show. The shark's circle covers 95% of the shark — by being
  // enormous. Covering the animal is easy; covering the animal and NOT the
  // three metres of open water above it is the entire point, and the only way
  // to see that is to measure the area each shape actually claims.
  //
  // Monte Carlo over a square around the circle, seeded off nothing random:
  // a fixed lattice, so this number does not wobble between runs.
  const R = e.radius * 1.6;
  const N = 160;
  let inCircle = 0;
  let inShape = 0;
  for (let iy = 0; iy < N; iy++) {
    for (let ix = 0; ix < N; ix++) {
      const x = e.mesh.position.x + (-R + (2 * R * (ix + 0.5)) / N);
      const y = e.mesh.position.y + (-R + (2 * R * (iy + 0.5)) / N);
      if (circleHit(e, x, y, 0)) inCircle += 1;
      if (hitCreature(e, x, y, 0, contact)) inShape += 1;
    }
  }
  const cell = (2 * R / N) ** 2;
  check(`${b.label}: and claims far less open water than the circle did`,
    inShape < inCircle * 0.75,
    `${(inShape * cell).toFixed(0)} square units against the circle's ${(inCircle * cell).toFixed(0)} — ${((1 - inShape / inCircle) * 100).toFixed(0)}% less, at ${(frac * 100).toFixed(0)}% coverage`);
}

// ---------------------------------------------------------------------------
section('THE FLANKS — what the circle was too FAT for');
// ---------------------------------------------------------------------------
// The failure the player feels as "it hit me and it was nowhere near me". The
// shark is the case: its circle is 8.10 against a body 3.98 wide, so there is
// a band of open water either side of it that used to deal contact damage.
{
  const e = spawnAt('bossShark', 0);
  const body = bodyBox(e);
  // Out to the side from a station on the body, past the flesh but well inside
  // the old circle. Taken at `along = 0` — the model origin, which is where the
  // circle is CENTRED, so anything inside e.radius of it was a hit before.
  const across = (body.across + e.radius) / 2;
  const p = probe(e, 0, across);
  const wasHit = circleHit(e, p.x, p.y, 0.5);
  const nowHit = hitCreature(e, p.x, p.y, 0.5, contact);
  check('bossShark: open water beside the body no longer touches you',
    wasHit && !nowHit,
    `probe ${across.toFixed(2)} out to the side — body reaches ${body.across.toFixed(2)}, circle r ${e.radius.toFixed(2)}`);

  // And the animal itself still does, which is the half of this that a hitbox
  // fitted too tightly would break. On the spine, at the middle of the body:
  // whatever else is true, that point is inside the shark.
  const mid = probe(e, body.mid);
  check('bossShark: the body itself still touches you',
    hitCreature(e, mid.x, mid.y, 0.5, contact),
    `on the spine, ${body.mid.toFixed(2)} along`);
}

// ---------------------------------------------------------------------------
section('THE CONTACT POINT — where the impact effects are drawn');
// ---------------------------------------------------------------------------
for (const b of BODIES) {
  const e = spawnAt(b.enemy, 0);
  const body = bodyBox(e);

  // A shot arriving on the body, deep enough inside it that the old "wherever
  // the bullet was" answer would be buried in the animal.
  const at = probe(e, body.mid);
  const hit = hitCreature(e, at.x, at.y, 3, contact);
  check(`${b.label}: a hit reports a contact point`, hit);

  // ON THE SURFACE OF THE SPHERE IT LANDED ON, to floating-point. This is the
  // claim the wound decals depend on — a contact point that drifts inside the
  // body puts every mark under the skin.
  if (hit && contact.sphere) {
    const pad = CONFIG.hitShape.padding ?? 1;
    const d = Math.hypot(contact.x - contact.sphere.wx, contact.y - contact.sphere.wy);
    check(`${b.label}: the contact point is on the skin`,
      Math.abs(d - contact.sphere.wr * pad) < 1e-3,
      `${d.toFixed(4)} from the sphere centre, radius ${(contact.sphere.wr * pad).toFixed(4)}`);
  }

  // The normal is a unit vector pointing OUT. Everything the break throws is
  // thrown along it, so a normal pointing inward fires the whole burst into
  // the animal.
  const len = Math.hypot(contact.nx, contact.ny);
  check(`${b.label}: the surface normal is a unit vector`, Math.abs(len - 1) < 1e-6, len.toFixed(6));

  // DIFFERENT PLACES ON THE BODY GIVE DIFFERENT CONTACT POINTS. The one thing
  // a circle could never do, and the reason the effects are worth having: a
  // hit on the nose has to draw at the nose.
  // Aimed at REAL FLESH at each end, not at the corners of a box — orca.glb's
  // bind pose curls its tail well off the model's axis, so a probe placed by
  // the box misses the animal entirely, both contacts come back stale and
  // identical, and the check fails for a reason that has nothing to do with
  // what it is testing.
  const ends = bodyEnds(e);
  hitCreature(e, ends.nose.x, ends.nose.y, 1, contact);
  const nose = { x: contact.x, y: contact.y };
  hitCreature(e, ends.tail.x, ends.tail.y, 1, contact);
  const tail = { x: contact.x, y: contact.y };
  const apart = Math.hypot(nose.x - tail.x, nose.y - tail.y);
  check(`${b.label}: a nose hit and a tail hit draw in different places`,
    apart > ends.span * 0.5,
    `${apart.toFixed(1)} apart, ends ${ends.span.toFixed(1)} apart`);
}

// ---------------------------------------------------------------------------
section('IT TURNS WITH THE ANIMAL');
// ---------------------------------------------------------------------------
// The whole argument for fitting to bones rather than to a box. A body facing
// up must be hittable above and below itself and NOT out to its sides — the
// exact opposite of the same body facing right.
{
  const e = spawnAt('bossShark', Math.PI / 2); // nose along +Y
  const body = bodyBox(e);
  const reach = body.tailAt + body.length * 0.1; // well down the tail
  const p = probe(e, reach);            // along the heading
  const q = probe(e, 0, Math.abs(reach)); // the same distance out to the side
  const alongHeading = hitCreature(e, p.x, p.y, 0.3, contact);
  const acrossHeading = hitCreature(e, q.x, q.y, 0.3, contact);
  check('bossShark turned upright is long the way it is pointing',
    alongHeading && !acrossHeading,
    `${Math.abs(reach).toFixed(1)} along: ${alongHeading ? 'hit' : 'miss'}, the same out to the side: ${acrossHeading ? 'hit' : 'miss'}`);
}

// ---------------------------------------------------------------------------
section('A SWUNG WEAPON — the club path');
// ---------------------------------------------------------------------------
{
  const e = spawnAt('bossShark', 0);
  const body = bodyBox(e);
  // A swing sweeping past the tail, from well above to well below. A point
  // test at either end of it touches nothing; the swept segment crosses the
  // body, which is the whole reason club.js tests a line.
  const x = body.tailAt + body.length * 0.2;
  const far = body.across * 4;
  const a = probe(e, x, far);
  const c = probe(e, x, -far);
  const ax = a.x, ay = a.y;
  const bx = c.x, by = c.y;
  check('a swing across the tail connects',
    hitCreatureSegment(e, ax, ay, bx, by, 0.4, contact),
    `swept x=${x.toFixed(1)} from y=${ay.toFixed(1)} to ${by.toFixed(1)}`);
  check('...and neither end of it would have on its own',
    !hitCreature(e, ax, ay, 0.4, contact) && !hitCreature(e, bx, by, 0.4, contact));

  // A swing that misses has to keep missing. A segment test that always
  // returns true is a weapon with infinite reach and passes every check above.
  const away = body.length * 4;
  check('a swing nowhere near it misses',
    !hitCreatureSegment(e, away, away, away + 2, away + 2, 0.4, contact));
}

// ---------------------------------------------------------------------------
section('A WOUND STAYS ON THE ANIMAL');
// ---------------------------------------------------------------------------
// The claim the sticky decals live or die on. A mark stored in world space is
// off the body one frame later; stored in the bone space of the sphere it
// landed on, it has to travel with the creature — through a move AND through a
// turn, because a mark that survives translation and not rotation looks
// correct right up until the boss banks.
{
  const e = spawnAt('bossShark', 0);
  const body = bodyBox(e);
  const p = probe(e, body.mid);
  hitCreature(e, p.x, p.y, 1, contact);

  const anchor = { x: 0, y: 0, z: 0 };
  const ok = worldToShapeLocal(e.hitShape, contact.index, contact.x, contact.y, 0, anchor);
  check('a contact point converts into bone space', ok);

  const before = { x: contact.x, y: contact.y };
  const beforeOffset = { x: before.x - e.mesh.position.x, y: before.y - e.mesh.position.y };

  // Move it and turn it. The DELTA is what the anchor has to survive, not the
  // absolute angle: the body already sits at heading - PI/2 because the models
  // are built nose-up, so turning it "to 45 degrees" turns it by 135.
  const TURN = Math.PI / 4;
  e.mesh.position.set(14, -9, 0);
  e.mesh.rotation.z += TURN;
  scene.updateMatrixWorld(true);
  tickHitShapes();

  const after = { x: 0, y: 0, z: 0 };
  shapeLocalToWorld(e.hitShape, contact.index, anchor.x, anchor.y, anchor.z, after);

  // It moved with the body: the same offset, rotated by the same amount.
  const c = Math.cos(TURN), s = Math.sin(TURN);
  const wantX = 14 + beforeOffset.x * c - beforeOffset.y * s;
  const wantY = -9 + beforeOffset.x * s + beforeOffset.y * c;
  const err = Math.hypot(after.x - wantX, after.y - wantY);
  check('the mark rode the body through a move and a turn', err < 0.05,
    `${err.toFixed(4)} units off, body moved ${Math.hypot(14, 9).toFixed(1)} and turned 45 degrees`);

  // And the control: a mark stored in WORLD space would now be this far wrong.
  const naive = Math.hypot(before.x - wantX, before.y - wantY);
  check('...where a world-space mark would have been left behind', naive > 5,
    `${naive.toFixed(1)} units adrift`);
}

// ---------------------------------------------------------------------------
section('EVERYTHING ELSE IN THE WATER IS UNCHANGED');
// ---------------------------------------------------------------------------
// The shape is opt-in. A regression here is every creature in the game
// silently changing size, which no amount of boss testing would catch.
{
  const e = spawnAt('shark');
  check('a wild shark has no measured shape', !e.hitShape, e.hitShape ? 'it has one' : 'circle, as before');

  // And its hit test still answers exactly what the circle answers.
  let agree = 0;
  let total = 0;
  for (let i = 0; i < 400; i++) {
    const a = (i / 400) * Math.PI * 2;
    const r = e.radius * (0.4 + (i % 7) * 0.2);
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    total += 1;
    if (hitCreature(e, x, y, 0.15, contact) === circleHit(e, x, y, 0.15)) agree += 1;
  }
  check('...and the shared test answers identically for it', agree === total, `${agree}/${total}`);
}

// ---------------------------------------------------------------------------
section('WHAT IT COSTS');
// ---------------------------------------------------------------------------
// Not a threshold anybody should tune to — machine load moves these by 4x —
// but the shape of the number matters: a per-query cost in the tens of
// microseconds would mean the refresh is running per query instead of per
// frame, which is a real bug with no visible symptom.
{
  const e = spawnAt('bossShark', 0);
  const N = 20000;
  const t0 = process.hrtime.bigint();
  let hits = 0;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    if (hitCreature(e, Math.cos(a) * 9, Math.sin(a) * 6, 0.2, contact)) hits += 1;
  }
  const us = Number(process.hrtime.bigint() - t0) / 1000 / N;
  check('a query is well under a microsecond', us < 5,
    `${us.toFixed(3)} us each over ${N}, ${hits} hits`);

  // The refresh is once per frame, not once per query — the stamp is what
  // makes that true, and it is invisible in a profile if it breaks.
  const spheres = hitShapeSpheres(e.hitShape);
  const before = spheres[0].wx;
  e.mesh.position.x += 100;
  scene.updateMatrixWorld(true);
  refreshHitShape(e.hitShape); // same frame — must be ignored
  check('a second refresh inside one frame is a no-op', spheres[0].wx === before,
    `${spheres[0].wx.toFixed(3)} vs ${before.toFixed(3)}`);
  tickHitShapes();
  refreshHitShape(e.hitShape);
  check('...and the next frame picks the move up',
    Math.abs(spheres[0].wx - before - 100) < 1e-3,
    `moved ${(spheres[0].wx - before).toFixed(3)}`);
}

clearHitShapeCache();
resetEnemies(scene);
console.log(`\n${failures === 0 ? 'all good' : `${failures} failure(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
