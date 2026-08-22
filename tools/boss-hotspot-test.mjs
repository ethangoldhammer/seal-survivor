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
import { updateBeatSync, divisionSeconds } from '../path/src/systems/beatSync.js';
import {
  initBossHotSpots, attachHotSpots, updateBossHotSpots, hotSpotDamage,
  hotSpotsOf, resetBossHotSpots, perimeterCandidates, liveHotSpotCount,
  hotSpotShells, spotAt, setHotSpotLook, drainHotSpotChum,
} from '../path/src/systems/bossHotSpots.js';
import { pipCount, strikeState, updateStrike, resetStrike } from '../path/src/systems/strike.js';

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
  // water and the boundary ring is off the body for most of its length.
  //
  // THE CONSTANT ON TOP IS THE RULER'S OWN, and it is not sampling slop even
  // though it was first written as if it were. A point ON a curved surface
  // still measures some deficit, because the best of 48 directions will always
  // find flesh a little further out where the body curves away.
  //
  // It was 0.35, then 0.5 to stop a failure — and raising it was the wrong move
  // both times, because the spots it was failing on were genuinely badly
  // placed: they were the ones a too-small host had forced oversized, which
  // measured 70% of a radius inside against 13-25% for a spot on a host that
  // fits. Fixing the placer (see minHostR in pickCandidate) moved the whole
  // distribution down.
  //
  // SO THE THRESHOLD STOPPED BEING A TUNED NUMBER. Chasing the measured spread
  // with a constant is how a check gets hollowed out one failure at a time.
  // What the feature actually requires is that the glow still REACHES the
  // outline, and at a deficit of 1 the spot's own radius is exactly used up
  // getting back to the edge — so 1 is the geometric limit, not a taste call,
  // and this sits a margin under it. The observed spread on the megalodon is
  // 13-60%; the printout carries the worst case so a regression that creeps
  // toward the limit is visible while still passing.
  const allow = 0.85;
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
  const allow2 = 0.85;
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

  // The boundary, from both sides, MEASURED FROM THE HULL ANCHOR — because
  // that is the surface a contact lives on and therefore the one the reach is
  // anchored to (see spotAt). Probing either side of the PAINTED centre tests
  // a circle the crit does not use: the two are deliberately allowed to differ
  // by up to `hullMatch` of a radius, so a point a hair outside the light can
  // be comfortably inside the reach and reporting that as a bug is the ruler
  // being wrong, not the code.
  const cx = s.cwx ?? s.wx;
  const cy = s.cwy ?? s.wy;
  const inside = hotSpotDamage(e, { x: cx + s.r * 0.95, y: cy }, BASE);
  const outside = hotSpotDamage(e, { x: cx + s.r * 1.05, y: cy }, BASE);
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
section('4b. A shot that hits the glow crits, through the real hit test');
// ---------------------------------------------------------------------------
// THE END-TO-END CHECK, and the one that caught the bug the two anchors exist
// for. Every check above feeds hotSpotDamage a point chosen by the harness;
// the game never does that. It calls hitCreature, which writes its contact on
// the PADDED SPHERE — `centre + normal * wr * padding` — and hands THAT to the
// damage path. Measured across the roster those surfaces stand 0.09 to 0.61
// units apart on the median boss and 2.20 at worst, against a spot radius near
// 1.4, so a crit test anchored on the skin was being asked about a point up to
// a whole radius away from it.
//
// A synthetic point cannot see that. A shot has to.
{
  const e = spawnBoss();
  const owner = lightUp(e);
  const spot = owner.spots[0];
  const BASE = 10;

  // Fire from outside the animal, straight at the painted centre of the spot,
  // and step the pellet in until the real hit test says it connected — which
  // is what a bullet does.
  const outward = { x: spot.wnx, y: spot.wny };
  let landed = null;
  for (let t = 6; t > -2; t -= 0.05) {
    const px = spot.wx + outward.x * t;
    const py = spot.wy + outward.y * t;
    if (hitCreature(e, px, py, 0.12, contact)) {
      landed = { x: contact.x, y: contact.y, from: t };
      break;
    }
  }
  check('a shot aimed at the glow connects with the body', !!landed,
    landed ? `contact ${landed.from.toFixed(2)} out along the normal` : 'never connected');

  if (landed) {
    const gap = Math.hypot(landed.x - spot.wx, landed.y - spot.wy);
    console.log(`  --   the contact lands ${gap.toFixed(2)} from the painted centre `
      + `(${(gap / spot.r * 100).toFixed(0)}% of the reach) — this is the standoff the two anchors absorb`);
    const dealt = hotSpotDamage(e, landed, BASE);
    check('and it crits', Math.abs(dealt / BASE - CONFIG.hotSpots.critMul) < 1e-9,
      `${(dealt / BASE).toFixed(2)}x`);
  }

  // ...and a shot aimed at bare flesh well away from every spot does not.
  {
    const far = hitShapeSpheres(e.hitShape)
      .map((sp) => ({ x: sp.wx, y: sp.wy }))
      .find((p) => owner.spots.every((o) => Math.hypot(p.x - (o.cwx ?? o.wx), p.y - (o.cwy ?? o.wy)) > o.r * 2.5));
    if (far && hitCreature(e, far.x, far.y, 0.12, contact)) {
      const dealt = hotSpotDamage(e, contact, BASE);
      check('a shot at bare flesh does not', dealt === BASE, `${dealt}`);
    } else {
      console.log('  --   no sphere centre this roll is clear of every spot');
    }
  }
}

// ---------------------------------------------------------------------------
section('4c. A strike aimed into a spot is the one bite a ram has');
// ---------------------------------------------------------------------------
// EVERYTHING ABOVE HANDS hotSpotDamage A NUMBER. This section asks whether the
// strike ever produces one, which for most of the mechanic's life it did not:
// `contactShare` is 0, so a ram computed dmg = 0, and the crit sits behind an
// `if (dmg > 0)` — a dash steered dead into a glowing mark on a boss dealt
// literally nothing and could not even reach the code that would have doubled
// it. So the assertion here is not "the crit works", it is that the number
// arriving at the crit is the strike's own damage rather than zero.
//
// Driven through updateStrike rather than by calling the arithmetic, because
// the thing that was broken was the ROUTE, and a harness that re-implements
// the route cannot see a break in it.
{
  const stats = {
    strikeDamage: CONFIG.strike.damage, hitRadius: 0.6,
    strikeDashSpeed: 46, strikeDashDuration: 0.22, strikeChargeTime: 1,
  };

  // Park a dashing seal on top of a chosen point and run one frame of the ram.
  // `power` 1 is a full bank; `perfect`/`sweet` are the two stamps tryStrike
  // takes at release, set here directly because what is under test is what a
  // dash in flight is WORTH, not how it came to be stamped.
  function ram(e, at, { perfect, sweet }) {
    resetStrike();
    strikeState.active = true;
    strikeState.dashTimeLeft = 1;
    strikeState.dashDuration = 1;
    strikeState.dashDir = { x: 1, y: 0 };
    strikeState.power = 1;
    strikeState.sweetStrike = sweet;
    strikeState.perfectStrike = perfect;
    // A perfect charge OR an on-beat release — the same either/or that arms a
    // food chain, and the gate the weak-spot bite is hung on.
    strikeState.armingStrike = perfect || sweet;
    let dealt = 0;
    updateStrike(DT, scene, { x: at.x, y: at.y }, stats, [e], {
      onEnemyDamaged: (_e, d) => { dealt += d; },
    });
    return dealt;
  }

  // A FRESH BOSS PER CASE. A ram fills the spot's rupture pool and shoves the
  // body, so measuring a second case on the same animal would be measuring a
  // spot that is part-spent and a boss that has moved.
  function fresh() {
    const e = spawnBoss();
    const owner = lightUp(e);
    const s = owner.spots[0];
    return { e, at: { x: s.cwx ?? s.wx, y: s.cwy ?? s.wy } };
  }

  // THE CONTROL, and it is the behaviour being preserved rather than the bug:
  // a dash into ordinary flesh must still deal nothing at all. The whole
  // exception is the spot.
  {
    const { e, at } = fresh();
    const owner = hotSpotsOf(e);
    const far = hitShapeSpheres(e.hitShape)
      .map((sp) => ({ x: sp.wx, y: sp.wy }))
      .find((p) => owner.spots.every((o) => Math.hypot(p.x - (o.cwx ?? o.wx), p.y - (o.cwy ?? o.wy)) > o.r * 2.5));
    if (far) {
      check('a perfect ram into bare flesh still deals nothing — the seal is not a weapon',
        ram(e, far, { perfect: true, sweet: true }) === 0, `${ram(e, far, { perfect: true, sweet: true })}`);
    } else {
      console.log('  --   no sphere centre this roll is clear of every spot');
    }
  }

  const onBeat = (() => { const { e, at } = fresh(); return ram(e, at, { perfect: false, sweet: true }); })();
  const perfect = (() => { const { e, at } = fresh(); return ram(e, at, { perfect: true, sweet: true }); })();
  const chargeOnly = (() => { const { e, at } = fresh(); return ram(e, at, { perfect: true, sweet: false }); })();
  const neither = (() => { const { e, at } = fresh(); return ram(e, at, { perfect: false, sweet: false }); })();

  const w = CONFIG.strike.weakSpot;
  // What the route should produce, spelled out from the CSV rather than from a
  // constant here: strike damage x the full-charge curve x the share x the
  // perfect multiplier x critMul.
  const charge = CONFIG.strike.charge.damageMulMax;
  const want = CONFIG.strike.damage * charge * w.share * CONFIG.hotSpots.critMul;

  check('an on-beat ram into a spot lands the strike\'s whole damage, critted',
    Math.abs(onBeat - want) < 1e-6, `${onBeat.toFixed(1)} vs ${want.toFixed(1)}`);
  check('...and it is not zero, which is what a ram was worth before this',
    onBeat > 0, `${onBeat.toFixed(1)}`);
  check('a PERFECT charge multiplies it',
    Math.abs(perfect - want * w.perfectMul) < 1e-6,
    `${perfect.toFixed(1)} vs ${(want * w.perfectMul).toFixed(1)} (x${w.perfectMul})`);
  // The point of the arming gate, and the frustration it removes: a full bar
  // steered into the mark pays whatever the release timing did.
  check('a perfect charge released OFF the beat still bites — the bank is enough',
    Math.abs(chargeOnly - want * w.perfectMul) < 1e-6,
    `${chargeOnly.toFixed(1)}`);
  check('...but a mistimed release with nothing banked is still just a shove',
    neither === 0, `${neither}`);

  // MASSIVE, MEASURED AGAINST THE FIGHT rather than against itself. The number
  // a player is asking for when they aim a strike at a weak spot is one they
  // can see land on the bar, and the two things it has to beat are the whole
  // release burst (what the strike is worth when it is NOT aimed at a spot)
  // and the pool that ruptures one.
  {
    const burst = CONFIG.strike.damage * charge; // strikeBurst at full charge, no chain
    console.log(`  --   a perfect weak-spot ram is ${perfect.toFixed(0)} against a `
      + `${burst.toFixed(0)} release burst and a ${(1500 * CONFIG.hotSpots.ruptureFraction).toFixed(0)}-odd rupture pool`);
    check('a perfect weak-spot ram is worth several unaimed strikes',
      perfect > burst * 3, `x${(perfect / burst).toFixed(1)} the burst`);
  }

  resetStrike();
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

  // A RUPTURED SPOT IS NOT SELECTABLE. Asserted through spotAt rather than by
  // checking the damage came back unmultiplied, and the difference is not
  // pedantry: spots are big enough now that two can overlap, so a hit at a
  // burst spot's centre can legitimately land inside a live one and crit for
  // it. The damage version of this check failed on exactly that and was
  // reporting a bug that was not there.
  const stillPicked = spotAt(owner, where.x, where.y);
  check('a burst spot is no longer selectable', stillPicked !== s,
    stillPicked ? 'another live spot covers the point' : 'nothing covers the point');
  // ...and where nothing else covers it, the hit is worth exactly its own
  // damage. Probed at a point inside the dead spot and outside every live one;
  // skipped rather than faked if the roll left no such point.
  const probe = { x: where.x + s.r * 0.6, y: where.y };
  const covered = owner.spots.some((o) => o.alive && !o.dead
    && Math.hypot(probe.x - o.wx, probe.y - o.wy) <= o.r);
  if (!covered) {
    const after = hotSpotDamage(e, probe, 10);
    check('and pays nothing where no live spot covers it', after === 10, `${after}`);
  } else {
    console.log('  --   every point in the burst spot is covered by a live one this roll');
  }

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
        < 0.85,
      `${(boundaryDeficit(skinCloud(e), fresh.wx, fresh.wy, fresh.r) / fresh.r * 100).toFixed(0)}% of a radius inside`);
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
section('5c. The throb is on the musical grid, and the reach is not');
// ---------------------------------------------------------------------------
{
  const e = spawnBoss();
  const owner = lightUp(e);
  const u = hotSpotShells(e)[0].material.userData.__hotUniforms;
  const spot = owner.spots[0];

  const seconds = divisionSeconds(CONFIG.hotSpots.look.pulseSync);
  check('the shipped division resolves to a real cycle length',
    seconds > 0, `${CONFIG.hotSpots.look.pulseSync} = ${seconds.toFixed(3)}s`);

  // Walk one full cycle, sampling the counter. It has to advance, wrap exactly
  // once, and come back to where it started — a counter that wraps at anything
  // other than a whole number of the shader's periods shows up as a visible
  // jump every time it comes round, which is what the `wrap` argument to
  // advanceCycles is for.
  const steps = Math.round(seconds / DT);
  const seen = [];
  for (let i = 0; i < steps; i++) {
    updateBeatSync(DT);
    updateBossHotSpots(DT, DT);
    seen.push(u.uHotCycle.value);
  }
  check('the cycle advances', Math.max(...seen) > 0.5, `peak ${Math.max(...seen).toFixed(3)}`);
  check('and stays inside [0, 1)', seen.every((v) => v >= 0 && v < 1));
  let wraps = 0;
  for (let i = 1; i < seen.length; i++) if (seen[i] < seen[i - 1]) wraps += 1;
  check('and wraps exactly once across one cycle', wraps === 1, `${wraps} wraps in ${steps} frames`);

  // THE REACH MUST NOT MOVE WITH IT. This is the assertion the whole "pulse
  // brightness, not size" decision rests on: the drawn boundary is the crit
  // boundary, so anything that makes it breathe is the light lying about where
  // the reward is, twice a bar, forever.
  const radii = new Set();
  for (let i = 0; i < steps; i++) {
    updateBeatSync(DT);
    updateBossHotSpots(DT, DT);
    radii.add(u.uHotSpot.value[0].w);
  }
  check('the painted radius never moves across a cycle', radii.size === 1,
    `${radii.size} distinct radii, ${[...radii][0]?.toFixed(4)}`);
  check('…and it is still the crit radius', [...radii][0] === spot.r);

  // Lockstep by default — see the note in CONFIG. Two spots throbbing together
  // read as the boss pulsing with the track; spread apart they read as two
  // independent lights, which is the school-of-fish answer to a different
  // question.
  const phases = [...u.uHotPhase.value].slice(0, owner.spots.length);
  check('spots pulse in lockstep at the shipped spread',
    (CONFIG.hotSpots.look.pulseSpread ?? 0) !== 0 || phases.every((p) => p === 0),
    `spread ${CONFIG.hotSpots.look.pulseSpread}, phases ${phases.join(', ')}`);
}

// ---------------------------------------------------------------------------
section('5d. The colour and the brightness are exposed, per boss');
// ---------------------------------------------------------------------------
{
  const e = spawnBoss();
  const owner = lightUp(e);
  const u = hotSpotShells(e)[0].material.userData.__hotUniforms;
  const l = CONFIG.hotSpots.look;

  updateBossHotSpots(DT, DT);
  const base = u.uHotLit.value.getHex();
  check('a boss with no override wears the configured base colour',
    base === (l.litColor ?? 0xffffff), `#${base.toString(16)}`);
  // WHITE, and the check is on the DEFAULT rather than on the literal: what
  // matters is that the base is a neutral anything can tint, not that it is
  // this exact value forever.
  const c = new THREE.Color(l.litColor);
  check('...and that base is neutral', c.r === c.g && c.g === c.b,
    `#${l.litColor.toString(16)}`);

  check('an unknown creature cannot be given a look', setHotSpotLook({}, { color: 0xff0000 }) === false);

  setHotSpotLook(e, { color: 0x2288ff, brightness: 0.5 });
  updateBossHotSpots(DT, DT);
  check('an override REPLACES the colour', u.uHotLit.value.getHex() === 0x2288ff,
    `#${u.uHotLit.value.getHex().toString(16)}`);
  // Multiplied, not replaced — so the slider still moves a boss that something
  // else is driving.
  check('and MULTIPLIES the brightness',
    Math.abs(u.uHotGlow.value - (l.glow ?? 2.6) * 0.5) < 1e-6,
    `${u.uHotGlow.value.toFixed(2)} vs ${((l.glow ?? 2.6) * 0.5).toFixed(2)}`);

  // The heat and strike colours are NOT overridable: a tinted spot still has
  // to go hot and then red as it is chewed, or the one warning the player gets
  // disappears the moment anything tints it.
  check('the heat ramp is untouched by an override',
    u.uHotHot.value.getHex() === (l.hotColor ?? 0xffc23a)
      && u.uHotFlash.value.getHex() === (l.flashColor ?? 0xff3a24));

  setHotSpotLook(e, null);
  updateBossHotSpots(DT, DT);
  check('and handing it back restores the config',
    u.uHotLit.value.getHex() === (l.litColor ?? 0xffffff)
      && Math.abs(u.uHotGlow.value - (l.glow ?? 2.6)) < 1e-6);
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
section('6b. Working a spot kicks big chum loose');
// ---------------------------------------------------------------------------
// THE PAYOUT FOR AIM. Hitting a weak spot shakes lumps of the animal loose and
// swallowing one refills BOOST PIPS — see CONFIG.hotSpots.chum. Four ways that
// goes wrong, and every one of them is invisible in a fight:
//
//   PER HIT INSTEAD OF PER DAMAGE. Sources call hotSpotDamage at wildly
//   different rates — an automatic weapon ten times a second, the club once —
//   so a payout counted in hits is a chum fountain on one build and nothing at
//   all on another. Asserted as the SAME total from the same damage delivered
//   in ten bites and in one.
//
//   THE PIECE LANDS INSIDE THE BOSS. Meat born on the spot's centre, or thrown
//   inward, is a reward you have to swim through the one hitbox in the game you
//   cannot enter to collect.
//
//   IT PAYS A FORTUNE. Pips are the strike meter, so what one spot is worth has
//   to be read against the BAR (pipCount) rather than as a number of pieces.
//
//   THE QUEUE OUTLIVES THE FIGHT. It is drained by main.js once a frame; one
//   that survived a reset would spill the last boss's meat into the next run.
{
  const M = CONFIG.hotSpots.chum ?? {};
  const e = spawnBoss();
  const owner = lightUp(e);
  const s = owner.spots[0];
  const where = { x: s.wx, y: s.wy };
  drainHotSpotChum();

  // ONE SHARE of the pool, in ten bites — the config's own share rather than a
  // number typed here, or this would be testing imported-tuning.json. Divided
  // by critMul because the pool takes the CRIT damage, the same arithmetic the
  // rupture threshold uses.
  const share = s.pool * (M.damageShare ?? 0.34);
  const bite = share / (CONFIG.hotSpots.critMul * 10);
  // SEEDED, because the throw is scattered inside `chum.spread` and the checks
  // below are about the geometry rather than about which way one roll went.
  seeded(9001, () => {
    for (let i = 0; i < 10; i++) hotSpotDamage(e, where, bite);
  });
  const drip = drainHotSpotChum();
  check('a share of a spot\'s pool shakes a piece loose', drip.length >= 1,
    `${drip.length} from ${Math.round(share)} damage in 10 bites`);
  check('...worth boost pips', drip.every((q) => q.pips > 0),
    drip.map((q) => `${q.pips}p`).join(' '));

  // THE SAME DAMAGE IN ONE HIT. A fresh spot on the same body, so the pool is
  // the same number.
  const s2 = owner.spots[1] ?? owner.spots[0];
  if (s2 !== s) {
    const before = s2.taken;
    seeded(9002, () => hotSpotDamage(e, { x: s2.wx, y: s2.wy }, share / CONFIG.hotSpots.critMul));
    const lump = drainHotSpotChum();
    check('one big hit pays the same as ten small ones for the same damage',
      lump.length === drip.length,
      `${lump.length} vs ${drip.length} (pool ${Math.round(s2.taken - before)} either way)`);
  }

  // OUT THROUGH THE SKIN. Measured against the SPOT'S OWN NORMAL and not
  // against the boss's centre — the centre is the wrong ruler and it fails on
  // correct behaviour: meat leaving a spot on the belly travels down and away
  // through the belly, which is outward through the surface and "toward the
  // middle" of a body whose centroid is above it.
  //
  // The angle is the assertion, and it is the config's: a throw is allowed to
  // scatter inside `chum.spread` of the normal and nowhere else. At the ceiling
  // (spread >= PI/2) a piece could legally be thrown back into the animal,
  // which is what this would catch.
  const spread = M.spread ?? 0.5;
  const off = drip.map((q) => {
    const speed = Math.hypot(q.vx, q.vy) || 1;
    return Math.acos(Math.max(-1, Math.min(1, (q.vx * s.wnx + q.vy * s.wny) / speed)));
  });
  check('every piece is thrown out through the skin, inside the spread',
    off.every((a) => a <= spread + 1e-6),
    `${off.map((a) => a.toFixed(2)).join(' ')} rad off the normal, spread ${spread}`);
  check('...and none is born on top of the light it came out of',
    drip.every((q) => Math.hypot(q.x - s.wx, q.y - s.wy) > s.r * 0.5),
    `${drip.map((q) => Math.hypot(q.x - s.wx, q.y - s.wy).toFixed(2)).join(' ')} vs r ${s.r.toFixed(2)}`);

  // WHAT ONE WHOLE SPOT IS WORTH. Fed the rest of its pool, so what is counted
  // is the drip plus the burst — the spot's entire life.
  const s3 = owner.spots[2] ?? null;
  if (s3) {
    const per = s3.pool / (CONFIG.hotSpots.critMul * 40);
    seeded(9003, () => {
      for (let i = 0; i < 60 && s3.alive; i++) hotSpotDamage(e, { x: s3.wx, y: s3.wy }, per);
    });
    const all = drainHotSpotChum();
    const pips = all.reduce((a, q) => a + q.pips, 0);
    const bars = pips / pipCount();
    console.log(`  --   one spot, cradle to rupture: ${all.length} pieces, ${pips} pips, `
      + `${bars.toFixed(2)} of a ${pipCount()}-pip bar`);
    check('a spot worked to its burst pays a real amount of the meter', bars >= 0.5,
      `${bars.toFixed(2)} bars`);
    check('...and nowhere near enough to stop the eating mattering', bars <= 3,
      `${bars.toFixed(2)} bars`);
    check('the burst throws its own pieces on top of the drip',
      all.length >= (M.ruptureCount ?? 2), `${all.length} pieces, burst owes ${M.ruptureCount}`);
  }

  // AND IT ARRIVES LIT. The spawn is announced by its own event, and the whole
  // point of that event is emission at the POINT — so what is asserted is the
  // two places the light actually comes from, not that a row exists.
  {
    const ev = CONFIG.feedback.hotSpotChum;
    const em = CONFIG.emitters[ev?.emit];
    check('the arrival has an event and an emitter', !!em, ev?.emit ?? 'missing');
    // SPRITES, NOT GOO, and this is the check worth having: the goo composite
    // writes linear straight to the framebuffer and lands about a stop and a
    // half darker than its hex — which is why the ichor beside it is authored
    // in apricot. A fuel pickup announcing itself in that pass would be the one
    // burst here that cannot throw light.
    check('...and it is a sprite burst, so it can bloom', !em?.goo, em?.goo ?? 'sprites');
    // Past the bright pass by a wide margin. Luminance, not brightness — the
    // pass thresholds luma, so a palette can look bright and never bloom.
    const luma = (hex) => {
      const c = new THREE.Color(hex);
      return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    };
    const dimmest = Math.min(...(em?.colors ?? [0]).map(luma)) * (em?.glow ?? 1);
    const thresh = CONFIG.bloom?.threshold ?? 0.58;
    check('...and its dimmest particle still clears the bloom threshold',
      dimmest > thresh, `${dimmest.toFixed(2)} vs ${thresh}`);
    // The piece itself carries some of that light for the second afterwards.
    check('...and the piece arrives hotter than an ordinary chunk',
      (M.flashMul ?? 1) > 1, `x${M.flashMul}`);
  }

  // AND IT LEAVES THE ANIMAL. Drag under water is exponential, so a throw
  // travels `tossSpeed / waterDrag` and no further — which makes the speed a
  // DISTANCE, and the distance has to be read against the body it is leaving.
  // The failure this catches is a piece that appears at the wound and settles
  // against the flank still inside the silhouette, which is what the shipped
  // 13 u/s did on a thirteen-metre shark and which looks, in the water, like
  // the pickup simply spawning on the boss.
  {
    const drag = CONFIG.pickups.toss?.waterDrag ?? 4.5;
    const travel = (M.tossSpeed ?? 0) / drag;
    console.log(`  --   thrown at ${M.tossSpeed} u/s against drag ${drag}: `
      + `${travel.toFixed(1)} units, off a boss whose own reach is ${e.radius.toFixed(1)}`);
    check('a piece travels clear of the body it came out of', travel > e.radius,
      `${travel.toFixed(1)} vs ${e.radius.toFixed(1)}`);

    // THE TRAIL. Blobs are dropped at the piece's position on a fixed cadence,
    // so what decides whether they read as a LINE is how far apart they land
    // against the size of a splat: the `ichor` group's field is wide and its
    // isoline low precisely so neighbours keep summing over it after they have
    // separated. Spaced further than a splat, the same code renders a row of
    // beads — and beads look deliberate, which is why this is worth an
    // assertion rather than an eye.
    const tr = M.trail ?? {};
    const em = CONFIG.emitters[CONFIG.feedback.hotSpotChumTrail?.emit];
    const goo = CONFIG.fx.goo.groups[em?.goo];
    check('the trail is goo, in the group the wound already bleeds', !!goo,
      em?.goo ?? 'missing');
    // THE RULER IS THE SPLAT, IN WORLD UNITS, and working it out is the point:
    // `group.radius` is a splat DIAMETER as a multiple of the particle's own
    // `size` (see gl_PointSize in entities/particles.js), not a distance. Read
    // as a distance it is 4.2 — comfortably more than any spacing this could
    // ever have — so a check that compared the two directly would pass with the
    // blobs a hundredth of their needed size and the trail rendering as dots.
    const splat = (em?.size?.[0] ?? 0) * (goo?.radius ?? 0) * 0.5;
    const gap = (M.tossSpeed ?? 0) * (tr.every ?? 0);
    check('...and its blobs land close enough together to fuse into a line',
      splat > 0 && gap < splat,
      `${gap.toFixed(2)} apart vs the smallest splat's ${splat.toFixed(2)} radius`);
    // ONE THRESHOLD FOR BOTH JOBS. `settleSpeed` is what stops the trail AND
    // what keeps the food magnet off the piece while it is travelling — see
    // the flight check in tools/chum-chunk-test.mjs, which is where the magnet
    // half is measured. It has to be under the throw or the piece is never in
    // flight at all: no trail, and claimed on the frame it is born.
    check('...and it runs for as long as the piece is in flight',
      (M.settleSpeed ?? 0) > 0 && (M.settleSpeed ?? 0) < (M.tossSpeed ?? 0),
      `settles at ${M.settleSpeed} u/s, thrown at ${M.tossSpeed}`);

    // It fires around twenty times per flight, so every channel that punches
    // has to be off. A sound or a shake on this row is a buzz and a rattle,
    // and neither is visible in the config until you are in a fight.
    const row = CONFIG.feedback.hotSpotChumTrail ?? {};
    check('...and the trail punches in no channel at all',
      !row.sfx && !row.shake && !row.hitstop && !row.glow && !row.ripple && !row.haptic,
      `sfx ${row.sfx} shake ${row.shake} glow ${row.glow}`);
  }

  // Nothing is owed to a creature with no spots, and nothing survives a reset.
  {
    const fish = spawnNamed(scene, 'fish', 0, undefined, { ignoreCaps: true, overfill: true });
    if (fish) hotSpotDamage(fish, { x: 0, y: 0 }, 500);
    check('an ordinary creature sheds nothing', drainHotSpotChum().length === 0);
  }
  hotSpotDamage(e, where, s.pool);
  resetBossHotSpots();
  check('and a reset drops whatever was still owed', drainHotSpotChum().length === 0);
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
