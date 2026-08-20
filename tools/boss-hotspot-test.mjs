#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:hotspots
//
// The boss weak spots (systems/bossHotSpots.js), on the real megalodon rather
// than on a stand-in: a hand-built sphere set would place perfectly on a shape
// nothing in the game has, and the whole claim being made here is about where
// a spot lands on an ANIMAL.
//
// Six things, and every one of them fails silently in the game:
//
//   1. THEY ARE ON THE OUTLINE. A spot buried inside the silhouette is a spot
//      the player cannot see and cannot aim at, and it looks completely
//      correct in the code that placed it. Checked against the union of the
//      posed hit spheres — the same union the hitbox is — rather than against
//      a bone name.
//
//   2. THEY RIDE THE FLESH. The anchor is a point in a sphere's bone space, so
//      a spot has to still be on the outline after the animal has swum and
//      turned. A world-space spot passes every static check ever written and
//      slides off the body on the first frame of motion.
//
//   3. THE GLOW AND THE CRIT ARE THE SAME CIRCLE. Two files, one number: the
//      shader's `edge` and the crit test's radius. This is the one assertion
//      here that exists because of a bug in a different system — a claw whose
//      commit gate and damage check were retuned apart and stopped agreeing,
//      with nothing in either file that looked wrong.
//
//   4. AIMED DAMAGE CRITS AND AREA DAMAGE DOES NOT. The multiplier is asserted
//      AS A MULTIPLIER against a control hit on the same body, not as "more
//      than before" — a floor that multiplies into a stated multiplier is
//      unbounded and invisible to a `> 1.5x` check.
//
//   5. ONE BURSTS AND ANOTHER OPENS SOMEWHERE ELSE. Including the gap: a
//      replacement that arrived instantly would make the rupture free.
//
//   6. NOTHING HAPPENS TO ANYTHING THAT IS NOT A BOSS. Every damage source in
//      the game now calls hotSpotDamage on every hit it lands.
//
// SEEDED. Placement is a weighted roll over a few hundred candidates, so an
// unseeded run reports a different arrangement every time and a real
// regression reads as noise.
//
//   node --import ./tools/vite-loader.mjs tools/boss-hotspot-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
// megalodon.glb embeds its textures and GLTFLoader decodes those through
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
import { resetEnemies, spawnNamed } from '../path/src/entities/enemies.js';
import { stateForSpeed } from '../path/src/systems/animation.js';
import { hitShapeSpheres, tickHitShapes, hitCreature } from '../path/src/systems/hitShape.js';
import { initParticles, resetParticles } from '../path/src/entities/particles.js';
import { onFeedback } from '../path/src/systems/feedback.js';
import {
  initBossHotSpots, attachHotSpots, updateBossHotSpots, hotSpotDamage,
  hotSpotsOf, resetBossHotSpots, perimeterCandidates, liveHotSpotCount,
  hotSpotShells,
} from '../path/src/systems/bossHotSpots.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DT = 1 / 60;

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

// A fixed stream, installed around anything that rolls. Not a constant: a
// constant pegs every variance roll to the same bucket, which is its own kind
// of unrepresentative.
function seeded(seed, fn) {
  const real = Math.random;
  let s = seed >>> 0;
  Math.random = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  try { return fn(); } finally { Math.random = real; }
}

// --- the body --------------------------------------------------------------

const MODEL = resolve(HERE, '../public/models/megalodon.glb');
if (!existsSync(MODEL)) {
  console.error(`\nmissing ${MODEL} — a weak spot cannot be placed on a model that isn't there.\n`);
  process.exit(1);
}
{
  const buf = readFileSync(MODEL);
  const gltf = await new GLTFLoader().parseAsync(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
  );
  installModel('enemyMegalodon', gltf.scene, gltf.animations);
}

const scene = new THREE.Scene();
initParticles(scene);
initBossHotSpots(scene);

// EVERY EVENT THE GAME FIRES, recorded. onFeedback is the observer hook the
// hex hive uses, and it is the only way to ask "did this system announce
// itself" without reaching into the sound, the shake and the burst separately.
const fired = [];
onFeedback((event) => fired.push(event));

const contact = { x: 0, y: 0, nx: 0, ny: 0, depth: 0, sphere: null, index: -1 };

// Spawn a boss, parked at the origin, swum for half a second so the shape is
// fitted to the animal the player meets rather than to a rest pose.
function spawnBoss(heading = 0, at = [0, 0]) {
  resetEnemies(scene);
  resetBossHotSpots();
  resetParticles();
  const e = seeded(20260820, () => spawnNamed(scene, 'bossShark', 0, undefined, {
    ignoreCaps: true, overfill: true,
  }));
  e.isBoss = true;
  e.mesh.position.set(at[0], at[1], 0);
  e.heading = heading;
  for (let i = 0; i < 30; i++) e.anim?.update(DT, stateForSpeed(e.def.speed ?? 5), false);
  // faceMotion creatures carry their heading as rotation.z - PI/2 — the models
  // are built nose-up (see createVisual).
  e.mesh.rotation.z = heading - Math.PI / 2;
  scene.updateMatrixWorld(true);
  tickHitShapes();
  return e;
}

// The body's posed vertices, in world space. Every eighth, matching the
// placer's own sampling — this is the cloud both silhouette tests below are
// measured against, and using a different density would make the harness
// disagree with the placer about the shape of the animal rather than about
// where it put things.
//
// FORCED MATRICES FIRST. Without updateMatrixWorld(true) every bone reports its
// last-uploaded pose and the whole cloud comes back identical, which fails
// nothing and proves nothing.
const _sv = new THREE.Vector3();
function skinCloud(e) {
  scene.updateMatrixWorld(true);
  const out = [];
  e.visual.traverse((o) => {
    if (!o.isMesh || o.userData.__isOutline || o.userData.__isHotSpotShell) return;
    const pos = o.geometry?.attributes?.position;
    if (!pos) return;
    for (let i = 0; i < pos.count; i += 8) {
      _sv.fromBufferAttribute(pos, i);
      if (o.isSkinnedMesh) o.applyBoneTransform(i, _sv);
      o.localToWorld(_sv);
      out.push(_sv.x, _sv.y, _sv.z);
    }
  });
  return out;
}

// IS THIS POINT ON THE OUTER EDGE OF THE ANIMAL?
//
// Written out here rather than imported, so the harness is not grading the
// placer against the placer's own idea of "outside" — and rebuilt twice while
// the glow moved onto the skin, because the first two rulers were wrong in
// ways that made correct placements look broken:
//
//   ON A SPHERE'S RIM. The original test, and it stopped being the question
//   the moment placement started resolving onto real vertices: a vertex on the
//   flesh is by construction INSIDE the sphere fitted around it, so the sphere
//   test called every correctly-placed spot buried.
//
//   FURTHEST ALONG THE LINE FROM THE BODY'S MIDDLE. Wrong on anything long and
//   thin, which is every boss in this game. On a shark the line to the middle
//   is nowhere near the surface normal at the flank, so a spot squarely on the
//   dorsal edge measured as two units inboard of the tail tip and the number
//   meant nothing.
//
// What is actually being asked is whether the point is on the BOUNDARY of the
// animal's XY outline, and a point is on the boundary of a cloud when SOME
// direction exists in which nothing nearby reaches further. Forty-eight
// directions, best one wins: that is the local support test, and it needs no
// notion of where the middle of the animal is.
function boundaryDeficit(cloud, x, y, reach) {
  const near = Math.max(1.2, reach * 1.5);
  const rel = [];
  for (let i = 0; i < cloud.length; i += 3) {
    const dx = cloud[i] - x;
    const dy = cloud[i + 1] - y;
    if (dx * dx + dy * dy <= near * near) rel.push(dx, dy);
  }
  if (!rel.length) return Infinity;
  let best = Infinity;
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * Math.PI * 2;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    let support = 0;
    for (let i = 0; i < rel.length; i += 2) {
      const pr = rel[i] * ux + rel[i + 1] * uy;
      if (pr > support) support = pr;
    }
    if (support < best) best = support;
  }
  return best;
}

function lightUp(e, seed = 4242) {
  seeded(seed, () => {
    attachHotSpots(scene, e);
    // One tick places them: attachHotSpots deliberately places nothing, and a
    // harness that asserted straight after the attach would be asserting on
    // the empty intent rather than on the spots.
    updateBossHotSpots(DT, DT);
  });
  return hotSpotsOf(e);
}

// ---------------------------------------------------------------------------
section('1. Placed on the outline of the animal');
// ---------------------------------------------------------------------------
{
  const e = spawnBoss();
  const spheres = hitShapeSpheres(e.hitShape);
  check('the boss has a measured body to sit on', spheres.length > 0,
    `${spheres.length} spheres`);

  const cands = perimeterCandidates(e.hitShape, CONFIG.hotSpots.rays);
  check('the outline has candidates', cands.length > 0, `${cands.length} points`);

  const owner = lightUp(e);
  const cloud = skinCloud(e);
  const n = owner.spots.length;
  check('rolled a count inside the CSV\'s range',
    n >= CONFIG.hotSpots.countMin && n <= CONFIG.hotSpots.countMax,
    `${n} spots, range ${CONFIG.hotSpots.countMin}-${CONFIG.hotSpots.countMax}`);

  // MEASURED AGAINST THE INSET, not against a flat number. A spot's centre is
  // pulled `insetFrac` of a radius inboard on purpose — the glow is painted on
  // skin, so a centre exactly on the outline wastes half its circle over open
  // water and the boundary ring is off the body for most of its length. So the
  // allowance is that inset plus the ruler's own slop (the cloud is sampled
  // every eighth vertex). Past it the spot has stopped reaching the outline,
  // which is the thing the whole placement exists for.
  const allow = (CONFIG.hotSpots.insetFrac ?? 0) + 0.35;
  const deficits = owner.spots.map((s) => boundaryDeficit(cloud, s.wx, s.wy, s.r) / s.r);
  const buried = deficits.filter((d) => d >= allow).length;
  check('every spot sits on the outline of the mesh', buried === 0,
    `worst ${(Math.max(...deficits) * 100).toFixed(0)}% of a radius inside the edge, allowed ${(allow * 100).toFixed(0)}%`);

  // BIG ENOUGH TO AIM AT, on the animal the player actually meets. This is the
  // check that caught the placer sizing spots off a single fitted sphere: a
  // megalodon's biggest is about 1.9 units against a body whose reach is 5, so
  // every spot clamped to minRadius and radiusFrac did nothing. A number
  // pinned at its own clamp is a number that is not being used.
  // NOT "none is at the floor" — a spot that lands on a small part of the
  // animal SHOULD be floored, and that check was written while diagnosing the
  // case where every spot was, which is the real failure: a number pinned at
  // its own clamp for every spot is a number that is not being used.
  const biggest = Math.max(...spheres.map((s) => s.wr));
  const pinned = owner.spots.filter((s) => s.r <= (CONFIG.hotSpots.minRadius ?? 0.8) * 1.001).length;
  check('the size rule does work rather than always clamping', pinned < n || n === 0,
    `${pinned} of ${n} at minRadius ${CONFIG.hotSpots.minRadius}; biggest sphere r ${biggest.toFixed(2)}`);
  const smallest = Math.min(...owner.spots.map((s) => s.r));
  check('and every spot is a real fraction of the animal',
    smallest > e.radius * 0.12,
    `smallest r ${smallest.toFixed(2)} on a body of reach ${e.radius.toFixed(2)}`);

  if (n > 1) {
    let worst = Infinity;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        worst = Math.min(worst, Math.hypot(owner.spots[i].wx - owner.spots[j].wx,
          owner.spots[i].wy - owner.spots[j].wy));
      }
    }
    // Not against minGapFrac, which is a preference the placer is allowed to
    // give up on — against the spots' own size, which is the thing that would
    // make two of them read as one light.
    const need = owner.spots[0].r;
    check('two spots are not drawn on top of each other', worst > need,
      `closest pair ${worst.toFixed(2)} apart, spot radius ${need.toFixed(2)}`);
  } else {
    console.log('  --   only one spot rolled; spacing not exercised this run');
  }
}

// ---------------------------------------------------------------------------
section('2. They ride the flesh');
// ---------------------------------------------------------------------------
{
  const e = spawnBoss();
  const owner = lightUp(e);
  const before = owner.spots.map((s) => ({ x: s.wx, y: s.wy }));

  // Swim it: a new position, a new heading, and a pose that has moved. All
  // three, because a spot can survive any one of them by accident — a spot in
  // world space survives a pure pose change, and a spot pinned to the creature
  // origin survives a translation.
  e.mesh.position.set(37, -12, 0);
  e.heading = 1.9;
  e.mesh.rotation.z = e.heading - Math.PI / 2;
  for (let i = 0; i < 45; i++) e.anim?.update(DT, stateForSpeed(e.def.speed ?? 5), false);
  scene.updateMatrixWorld(true);
  tickHitShapes();
  updateBossHotSpots(DT, DT);

  const moved = owner.spots.filter((s, i) => Math.hypot(s.wx - before[i].x, s.wy - before[i].y) > 1);
  check('every spot moved with the body', moved.length === owner.spots.length,
    `${moved.length} of ${owner.spots.length} followed`);

  const cloud2 = skinCloud(e);
  const allow2 = (CONFIG.hotSpots.insetFrac ?? 0) + 0.35;
  const after = owner.spots.map((s) => boundaryDeficit(cloud2, s.wx, s.wy, s.r) / s.r);
  check('and they are still on the outline after a turn and a tail-beat',
    after.every((d) => d < allow2),
    `worst ${(Math.max(...after) * 100).toFixed(0)}% of a radius inside the edge`);

  // The world position must be derived from the anchor, not merely offset by
  // the body's translation — otherwise a spot on the flank ends up on the same
  // side of a shark that has turned around.
  const dx = 37 - 0;
  const dy = -12 - 0;
  const rigid = owner.spots.filter((s, i) =>
    Math.abs((s.wx - before[i].x) - dx) < 1e-3 && Math.abs((s.wy - before[i].y) - dy) < 1e-3);
  check('the anchor is in bone space, not a fixed offset from the origin',
    rigid.length === 0, `${rigid.length} translated rigidly`);
}

// ---------------------------------------------------------------------------
section('3. The glow and the crit are the same circle');
// ---------------------------------------------------------------------------
{
  const e = spawnBoss();
  const owner = lightUp(e);
  const s = owner.spots[0];

  // THE SHADER MEASURES AGAINST `s.w` DIRECTLY — `distance(vHotWorld, s.xyz) /
  // s.w` — so the painted boundary and the crit reach are not two numbers that
  // agree, they are one number. That is a stronger guarantee than the quad
  // version could make (it had a separate `edge` fraction of a quad half-width
  // that had to be kept in step by hand) and it is the reason the `edge`
  // control is gone rather than retuned.
  //
  // What is checkable from here is that nothing has reintroduced a second
  // number: the uniform the shader reads has to BE the spot's radius.
  const shells = hotSpotShells(e);
  check('the boss is wearing shells to paint on', shells.length > 0, `${shells.length}`);
  check('and they are drawn only while something is lit',
    shells.every((sh) => sh.visible === true), 'visible with spots up');
  // Off the MATERIAL, not off the owner record — the whole question is whether
  // what the shader is handed matches what the crit test uses, and reading the
  // owner's copy would be asking the placer to agree with itself.
  const u = shells[0].material.userData.__hotUniforms;
  const painted = u.uHotSpot.value[0];
  check('the painted radius IS the crit radius',
    Math.abs(painted.w - s.r) < 1e-9, `${painted.w.toFixed(4)} vs ${s.r.toFixed(4)}`);
  check('and the painted centre IS the crit centre',
    Math.abs(painted.x - s.wx) < 1e-9 && Math.abs(painted.y - s.wy) < 1e-9,
    `(${painted.x.toFixed(2)}, ${painted.y.toFixed(2)})`);

  // And the reach is what the CSV says it is, off the sphere it sits on.
  // THE SPHERE THE SPOT IS ANCHORED TO, by the index it carries — not the one
  // whose rim happens to pass nearest the spot. A megalodon's spheres overlap
  // heavily, so several rims pass close to any point on the outline and a
  // search-by-distance picked a neighbour, making this check disagree with the
  // placer over a spot that was placed perfectly correctly.
  const pad = CONFIG.hitShape.padding ?? 1;
  const host = hitShapeSpheres(e.hitShape)[s.index];
  if (host) {
    const c = CONFIG.hotSpots;
    // The padded radius, which is the surface the spot was placed on and the
    // surface every contact in the game lands on.
    const want = Math.max(c.minRadius, Math.min(c.maxRadius,
      Math.min(e.radius * c.radiusFrac, host.wr * pad * c.hostCap)));
    check('and the reach is what the CSV says, off the whole animal',
      Math.abs(want - s.r) < 1e-6, `${s.r.toFixed(3)} vs ${want.toFixed(3)}`);
  } else {
    check('the spot has an identifiable host sphere', false);
  }
}

// ---------------------------------------------------------------------------
section('3b. The spot is near actual flesh, not floating off it');
// ---------------------------------------------------------------------------
// THE CHECK THE ON-SKIN RENDERER MADE NECESSARY. When the glow was a quad it
// did not matter whether the spot's centre was on the animal — the quad drew
// wherever it was put. Now the light is only wherever the SKIN is within
// reach, so a centre that floats even a little off the body loses the whole
// bright middle of the patch and the spot renders as a dim smear with the core
// nowhere. Nothing about that failure is visible in the placement code.
//
// The spheres are a statistical fit (mean + 1.6 sigma, then inflated by
// `padding`), so "on the rim of a sphere" is not the same claim as "on the
// mesh". Measured against the real posed vertices — three's own
// applyBoneTransform, which is what the GPU does — rather than argued about.
{
  const e = spawnBoss();
  const owner = lightUp(e);

  // Every skinned vertex of the body, posed and in world space. Forced
  // matrices first: without updateMatrixWorld(true) every bone reports its
  // last-uploaded pose and the whole cloud comes back identical, which fails
  // nothing and proves nothing.
  scene.updateMatrixWorld(true);
  const verts = [];
  const v = new THREE.Vector3();
  e.visual.traverse((o) => {
    if (!o.isMesh || o.userData.__isOutline || o.userData.__isHotSpotShell) return;
    const pos = o.geometry?.attributes?.position;
    if (!pos) return;
    // Every eighth vertex. This is looking for the NEAREST piece of flesh to a
    // point, and at these densities the sample is within a few millimetres of
    // the full answer for an eighth of the work.
    for (let i = 0; i < pos.count; i += 8) {
      v.fromBufferAttribute(pos, i);
      if (o.isSkinnedMesh) o.applyBoneTransform(i, v);
      o.localToWorld(v);
      verts.push(v.x, v.y, v.z);
    }
  });
  check('the body has posed vertices to measure against', verts.length > 0,
    `${verts.length / 3} sampled`);

  let worst = 0;
  let worstFrac = 0;
  for (const sp of owner.spots) {
    let best = Infinity;
    for (let i = 0; i < verts.length; i += 3) {
      const dx = verts[i] - sp.wx;
      const dy = verts[i + 1] - sp.wy;
      const dz = verts[i + 2] - sp.wz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) best = d2;
    }
    const d = Math.sqrt(best);
    if (d > worst) { worst = d; worstFrac = d / sp.r; }
  }
  // AGAINST THE INSET AGAIN. The centre is deliberately inboard of the
  // surface, so the nearest SURFACE vertex is about an inset away and that is
  // correct — what would be wrong is the centre floating in open water, which
  // is what this catches. The allowance is the inset plus the sampling slop.
  const flesh = (CONFIG.hotSpots.insetFrac ?? 0) + 0.2;
  check('no spot centre is floating off the animal',
    worstFrac < flesh,
    `worst ${worst.toFixed(3)} away, ${(worstFrac * 100).toFixed(0)}% of its radius, allowed ${(flesh * 100).toFixed(0)}%`);
}

// ---------------------------------------------------------------------------
section('4. Aimed damage crits, area damage does not');
// ---------------------------------------------------------------------------
{
  const e = spawnBoss();
  const owner = lightUp(e);
  const s = owner.spots[0];
  const BASE = 10;

  // THE CONTROL. The same call on the same boss on the same frame, at a point
  // on the skin that is not a spot — so what is being asserted is a ratio
  // between two measurements rather than "this number came out big".
  let far = null;
  for (const sp of hitShapeSpheres(e.hitShape)) {
    const p = { x: sp.wx, y: sp.wy };
    if (owner.spots.every((o) => Math.hypot(p.x - o.wx, p.y - o.wy) > o.r * 2)) { far = p; break; }
  }
  const control = far ? hotSpotDamage(e, far, BASE) : null;
  check('a hit away from every spot is worth exactly its own damage',
    control === BASE, `${control} vs ${BASE}`);

  const dead = hotSpotDamage(e, { x: s.wx, y: s.wy }, BASE);
  check('a hit inside a spot is worth critMul times the control',
    Math.abs(dead / control - CONFIG.hotSpots.critMul) < 1e-9,
    `${(dead / control).toFixed(3)}x, CSV says ${CONFIG.hotSpots.critMul}x`);

  // The boundary, from both sides, because it is the number the player is
  // aiming at and a reach that is generous by a hair is a reach that is a lie
  // by a hair.
  const inside = hotSpotDamage(e, { x: s.wx + s.r * 0.95, y: s.wy }, BASE);
  const outside = hotSpotDamage(e, { x: s.wx + s.r * 1.05, y: s.wy }, BASE);
  check('just inside the edge crits', inside > BASE, `${inside}`);
  check('just outside the edge does not', outside === BASE, `${outside}`);

  // An ordinary fish. Every damage source in the game calls this on every hit
  // it lands, so the no-boss path has to be exactly free of side effects.
  {
    const fish = spawnNamed(scene, 'fish', 0, undefined, { ignoreCaps: true, overfill: true });
    const plain = fish ? hotSpotDamage(fish, { x: 0, y: 0 }, BASE) : BASE;
    check('a creature with no spots is untouched', plain === BASE, `${plain}`);
  }
}

// ---------------------------------------------------------------------------
section('5. One bursts, and another opens somewhere else');
// ---------------------------------------------------------------------------
{
  const e = spawnBoss();
  const owner = lightUp(e);
  const s = owner.spots[0];
  const where = { x: s.wx, y: s.wy };
  const started = owner.spots.length;

  // Feed it. In small bites rather than one giant one, because the pool is the
  // thing being tested and a single hit for the whole pool would pass even if
  // nothing accumulated.
  const bite = s.pool / (CONFIG.hotSpots.critMul * 8);
  let hits = 0;
  while (s.alive && hits < 200) {
    hotSpotDamage(e, where, bite);
    hits += 1;
  }
  check('it ruptures once it has swallowed its pool', !s.alive, `after ${hits} hits`);
  check('and it took more than one hit to get there', hits > 1, `${hits}`);
  check('the pool is ruptureFraction of the boss\'s bar',
    Math.abs(s.pool - e.maxHp * CONFIG.hotSpots.ruptureFraction) < 1e-6,
    `${s.pool.toFixed(1)} of ${e.maxHp.toFixed(1)}`);

  // A ruptured spot pays nothing. Without this a burst spot would still be a
  // crit zone for as long as its light took to fade.
  const after = hotSpotDamage(e, where, 10);
  check('a burst spot no longer crits', after === 10, `${after}`);

  // Wind forward. The light has to go out AND the replacement has to wait.
  for (let i = 0; i < 30; i++) updateBossHotSpots(DT, DT);
  check('the light is out', liveHotSpotCount() < started,
    `${liveHotSpotCount()} lit, was ${started}`);
  const early = owner.spots.filter((o) => o.alive).length;
  check('nothing has replaced it yet', early === started - 1,
    `${early} live, ${started - 1} expected`);

  const seconds = CONFIG.hotSpots.relightSeconds;
  seeded(99, () => {
    for (let i = 0; i < Math.ceil((seconds + 0.5) / DT); i++) {
      tickHitShapes();
      updateBossHotSpots(DT, DT);
    }
  });
  const live = owner.spots.filter((o) => o.alive);
  check('a replacement opens after the wait', live.length === started,
    `${live.length} live, ${started} expected`);
  if (live.length === started) {
    const fresh = live[live.length - 1];
    check('the replacement is on the outline too',
      boundaryDeficit(skinCloud(e), fresh.wx, fresh.wy, fresh.r) / fresh.r
        < (CONFIG.hotSpots.insetFrac ?? 0) + 0.35);
    check('and it is not where the old one was',
      Math.hypot(fresh.wx - where.x, fresh.wy - where.y) > fresh.r,
      `${Math.hypot(fresh.wx - where.x, fresh.wy - where.y).toFixed(2)} away`);
  }
}

// ---------------------------------------------------------------------------
section('5b. Both moments announce themselves as events');
// ---------------------------------------------------------------------------
// THE CHECK THAT WOULD HAVE CAUGHT THE ORIGINAL WIRING. Both bursts were fired
// with a bare emit() — which drew the particles correctly and cost the feature
// everything else the shared hook carries: no sound, no shake, no ripple, no
// haptics, and no row in the Feel Workbench for anybody to tune them from. It
// looked completely finished on screen, and a crit was audibly identical to a
// chip on the tail.
//
// So what is asserted is the EVENT, not the emitter: an event carries its
// emitter with it, and nothing else does.
{
  const e = spawnBoss();
  const owner = lightUp(e);
  const spot = owner.spots[0];

  fired.length = 0;
  hotSpotDamage(e, { x: spot.wx, y: spot.wy }, 1);
  check('a crit fires hotSpotHit', fired.includes('hotSpotHit'), fired.join(', ') || 'nothing');

  fired.length = 0;
  hotSpotDamage(e, { x: spot.wx, y: spot.wy }, spot.pool);
  check('a rupture fires hotSpotBurst', fired.includes('hotSpotBurst'), fired.join(', ') || 'nothing');

  fired.length = 0;
  hotSpotDamage(e, { x: spot.wx + spot.r * 3, y: spot.wy }, 10);
  check('a miss fires neither', fired.length === 0, fired.join(', ') || 'nothing');

  // The table's own contract. An event with no emitter draws nothing and an
  // event with no sound is the exact gap this section exists to close, so both
  // are worth naming rather than trusting.
  for (const [ev, emitter] of [['hotSpotHit', 'hotSpotBleed'], ['hotSpotBurst', 'hotSpotRupture']]) {
    const def = CONFIG.feedback[ev];
    check(`${ev} is in the feedback table`, !!def);
    check(`…and carries its burst`, def?.emit === emitter, def?.emit ?? 'none');
    check(`…and has a voice`, !!def?.sfx && !!CONFIG.sfx[def.sfx], def?.sfx ?? 'none');
  }
  // A crit lands on top of the material voice rather than replacing it, so the
  // accent must be SHORTER than the thud it sits over or it stops being an
  // accent and becomes the sound of the hit.
  check('the accent is shorter than the material voice it rides on',
    CONFIG.sfx.hotSpotHit.decay < CONFIG.sfx.bossHitFlesh.decay,
    `${CONFIG.sfx.hotSpotHit.decay} vs ${CONFIG.sfx.bossHitFlesh.decay}`);
  // ...and higher, since that thud is a noise band filtered low and two voices
  // in the same range are one muddier voice.
  check('and brighter than it', CONFIG.sfx.hotSpotHit.freq[0] > CONFIG.sfx.bossHitFlesh.filter,
    `${CONFIG.sfx.hotSpotHit.freq[0]} vs ${CONFIG.sfx.bossHitFlesh.filter}`);
  // The rupture is a PART of the animal going. A voice as low and long as the
  // death would say the fight was over.
  check('the rupture sits above the death voice',
    CONFIG.sfx.hotSpotBurst.freq[0] > CONFIG.sfx.bossDieFlesh.freq[0]
      && CONFIG.sfx.hotSpotBurst.decay < CONFIG.sfx.bossDieFlesh.decay,
    `${CONFIG.sfx.hotSpotBurst.freq[0]}Hz/${CONFIG.sfx.hotSpotBurst.decay}s vs `
      + `${CONFIG.sfx.bossDieFlesh.freq[0]}Hz/${CONFIG.sfx.bossDieFlesh.decay}s`);
}

// ---------------------------------------------------------------------------
section('6. The ichor is a goo group and the burst is scaled by size AND speed');
// ---------------------------------------------------------------------------
{
  const g = CONFIG.fx.goo.groups.ichor;
  check('the rupture has a group of its own to fuse in', !!g);
  // Below 1 or a lone lobe never crosses the isoline and the burst renders as
  // nothing at all — the failure this project has hit more than once.
  check('its isoline is below 1', g && g.iso < 1, g ? `iso ${g.iso}` : '');
  for (const name of ['hotSpotBleed', 'hotSpotRupture']) {
    const em = CONFIG.emitters[name];
    check(`${name} exists and names the group`, em?.goo === 'ichor', em?.goo ?? 'missing');
  }
  const rup = CONFIG.emitters.hotSpotRupture;
  // FUSION IS BOUNDED BY THE SPREAD, and this is the assertion the look sheet
  // sent back. A five-to-one speed range tore the burst into separate round
  // balls inside eight frames — neighbours were past their own radius and had
  // stopped summing over the isoline — which is the exact failure the density
  // pass exists to prevent, and it looked like a deliberate lava-lamp choice.
  check('the rupture does not throw itself apart',
    rup && rup.speed[1] / rup.speed[0] <= 5.5,
    rup ? `${rup.speed[0]}-${rup.speed[1]} (${(rup.speed[1] / rup.speed[0]).toFixed(1)}x)` : '');
  // Wetness is the other half. A specular highlight lit off the density
  // gradient renders a small fused blob as a glass marble with a blue fringe,
  // and ichor is hot rather than wet.
  check('the ichor carries no specular highlight', g && !g.spec, `spec ${g?.spec}`);
}

// ---------------------------------------------------------------------------
section('7. It cleans up after the animal');
// ---------------------------------------------------------------------------
{
  const e = spawnBoss();
  lightUp(e);
  check('lit', liveHotSpotCount() > 0, `${liveHotSpotCount()}`);
  // The shape going back to the pool is what "the boss is gone" means here —
  // the same signal the impact smears retire on.
  e.hitShape.alive = false;
  for (let i = 0; i < 60; i++) updateBossHotSpots(DT, DT);
  check('every light goes out with the body', liveHotSpotCount() === 0,
    `${liveHotSpotCount()} still lit`);
  check('and the owner record is gone', hotSpotsOf(e) === null);
}

// ---------------------------------------------------------------------------
console.log(failures === 0
  ? '\nAll weak-spot checks passed.\n'
  : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
