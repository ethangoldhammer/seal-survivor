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
import { resetEnemies, spawnNamed, applyKnockback } from '../path/src/entities/enemies.js';
import { stateForSpeed } from '../path/src/systems/animation.js';
import { hitShapeSpheres, tickHitShapes, hitCreature } from '../path/src/systems/hitShape.js';
import { initParticles, resetParticles } from '../path/src/entities/particles.js';
import { onFeedback } from '../path/src/systems/feedback.js';
import { updateBeatSync, divisionSeconds } from '../path/src/systems/beatSync.js';
import {
  initBossHotSpots, attachHotSpots, updateBossHotSpots, hotSpotDamage,
  hotSpotsOf, resetBossHotSpots, perimeterCandidates, liveHotSpotCount,
  hotSpotShells, spotAt, setHotSpotLook, drainHotSpotChum,
  aimHotSpots, designatedHotSpot,
  drainHotSpotShoves, bossHotSpotRoster, liveHotSpots, anchorOrder,
} from '../path/src/systems/bossHotSpots.js';
import { parseAnchors } from '../path/src/bossHotSpotTable.js';
import { parseBossCsv } from '../path/src/bossTable.js';
import { strikeBoneGain } from '../path/src/systems/strike.js';
import { pipCount, strikeState, updateStrike, resetStrike } from '../path/src/systems/strike.js';
import { spawnProjectile, updateProjectiles, projectiles } from '../path/src/entities/projectiles.js';

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
  // `boss: true`, the way systems/boss.js spawns one — it is what arms the
  // super-armor wrapper on the hp setter (see spawnOne), and a harness that
  // set `isBoss` by hand alone was modelling a body the game never makes.
  const e = seeded(20260820, () => spawnNamed(scene, 'bossShark', 0, undefined, {
    ignoreCaps: true, overfill: true, boss: true,
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

// One hit, taken the way the game takes it: hotSpotDamage decides what to hand
// over and `e.hp -= that` is where the armor is actually spent. Returns the
// three numbers that can disagree — what the setter was HANDED, what it
// actually took off the body, and what the spot's pool was credited.
function spotTake(e, spot, at, base) {
  const pool0 = spot ? spot.taken : 0;
  const hp0 = e.hp;
  const handed = hotSpotDamage(e, at, base);
  e.hp -= handed;
  const out = { handed, hp: hp0 - e.hp, pooled: spot ? spot.taken - pool0 : 0 };
  e.hp = hp0;
  return out;
}

function lightUp(e, seed = 4242, archetype = null) {
  seeded(seed, () => {
    attachHotSpots(scene, e, archetype);
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

  // ------------------------------------------------------------------------
  // SUPER ARMOR, AND WHY THE SPOT IS EXEMPT FROM IT.
  // ------------------------------------------------------------------------
  // CONFIG.boss.armor holds a committed boss's hp setter to a fraction of
  // every decrement (armBossArmor in entities/enemies.js), so a lunge is a
  // thing you move away from rather than a thing you out-damage. The spot is
  // the one door left open — a lunge is when the spots are in front of you and
  // the body is holding a line it cannot correct — and the only way to exempt
  // something from a rule that lives in the SETTER is to hand the setter a
  // number it will scale back to full. That is what hotSpotDamage returns.
  //
  // TWO NUMBERS THAT MUST NOT BE CONFUSED, and the reason this block is here
  // rather than being taken on trust: what the caller hands the setter is
  // `landed / armor`, and what actually lands is `landed`. The rupture pool
  // wants the second. Crediting the first — which the first draft did — has a
  // spot fill nearly seven times faster during a lunge than at any other
  // moment of the fight and rupture on a hit worth a seventh of what its pool
  // says it costs, with nothing on screen to say so.
  {
    const armorMul = CONFIG.boss?.armor?.committed ?? 1;
    const at = { x: s.wx, y: s.wy };
    e.isBoss = true;

    e.lungeStage = null;
    const takenCruising = spotTake(e, s, at, BASE);
    e.lungeStage = 'strike';
    const takenRunning = spotTake(e, s, at, BASE);
    e.lungeStage = null;

    check('a weak spot is worth the same on a committed boss as on a cruising one',
      Math.abs(takenRunning.hp - takenCruising.hp) < Math.max(1e-6, takenCruising.hp * 1e-9),
      `${takenRunning.hp.toFixed(1)} hp during the run, ${takenCruising.hp.toFixed(1)} cruising`);
    check('...which is the armor being divided back out rather than not applying',
      Math.abs(takenRunning.handed / takenCruising.handed - 1 / armorMul) < 1e-6,
      `the setter was handed x${(takenRunning.handed / takenCruising.handed).toFixed(2)} to land the same damage`);
    check('...and the rupture pool took what LANDED, not what was handed over',
      Math.abs(takenRunning.pooled - takenCruising.pooled) < Math.max(1e-6, takenCruising.pooled * 1e-9),
      `${takenRunning.pooled.toFixed(1)} vs ${takenCruising.pooled.toFixed(1)}`);

    // The flank is NOT exempt, which is the other half of the claim — an armor
    // that everything slipped past would pass every check above.
    if (far) {
      e.lungeStage = 'strike';
      const body = spotTake(e, null, far, BASE);
      e.lungeStage = null;
      check('...but the FLANK is not exempt — that is the whole design',
        Math.abs(body.hp / BASE - armorMul) < 1e-6,
        `x${(body.hp / BASE).toFixed(2)} of a hit while it runs`);
    }
    e.isBoss = false;
  }

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
  // ...AND THE FRACTION OF THE BAR, taken the same way updateStrike takes it —
  // a max(), not a sum. The flat line above is the floor and `maxHpFrac` is
  // what keeps the bite worth landing at level 20, where the whole flat number
  // is a third of one percent of a boss (see CONFIG.strike.weakSpot).
  //
  // IT WAS MISSING HERE, and nothing noticed because spawnBoss used to spawn
  // the body WITHOUT `boss: true` — so it carried the wildlife megalodon's hp
  // at difficulty 0 rather than the level ladder's, and at that size the flat
  // term happened to be the larger of the two. A harness that gives a boss the
  // wrong health measures a different branch of the game from the one that
  // ships, and the giveaway is that the numbers agreed exactly.
  const flat = (perfectMul) => CONFIG.strike.damage * charge * w.share * perfectMul * CONFIG.hotSpots.critMul;
  const wantAt = (e, perfectMul = 1) => Math.max(
    flat(perfectMul),
    (w.maxHpFrac ?? 0) > 0 && e.maxHp > 0
      ? e.maxHp * w.maxHpFrac * perfectMul * CONFIG.hotSpots.critMul : 0,
  );
  const probe = fresh().e;
  const want = wantAt(probe);

  check('an on-beat ram into a spot lands the strike\'s whole damage, critted',
    Math.abs(onBeat - want) < 1e-6, `${onBeat.toFixed(1)} vs ${want.toFixed(1)}`);
  check('...and it is not zero, which is what a ram was worth before this',
    onBeat > 0, `${onBeat.toFixed(1)}`);
  const wantPerfect = wantAt(probe, w.perfectMul);
  check('a PERFECT charge multiplies it',
    Math.abs(perfect - wantPerfect) < 1e-6,
    `${perfect.toFixed(1)} vs ${wantPerfect.toFixed(1)} (x${w.perfectMul})`);
  // The point of the arming gate, and the frustration it removes: a full bar
  // steered into the mark pays whatever the release timing did.
  check('a perfect charge released OFF the beat still bites — the bank is enough',
    Math.abs(chargeOnly - wantPerfect) < 1e-6,
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
section('4d. A guided shot aims for the light');
// ---------------------------------------------------------------------------
// The seeker's aim point (aimAt in entities/projectiles.js). Every guided shot
// in this game steered at `mesh.position`, which on ordinary creatures is the
// animal and on a thirteen-metre shark is a point buried deep inside it — so
// the crit these lights exist for was available only to a player aiming by
// hand, and a mussel landed on one by accident or not at all.
//
// TWO CLAIMS, and the second is the one that matters. That the crit rate goes
// up is the feature; that the HIT rate does not go down is what makes it safe.
// A shot that commits to a spot it cannot reach spirals past a boss it would
// otherwise have struck, trading a certain body hit for a crit it was never
// geometrically able to land — which is a net loss even when the crit rate
// looks better. Both are measured against a control run of the same shots with
// the aim switched off, on the same boss with the same spots in the same
// places, so nothing but the aim differs.
{
  // PARKED WELL UNDER THE SURFACE, and the ring of firing positions sized to
  // stay under it with room to spare. The arena's ceiling is y = 10: a ring
  // wide enough to clear a boss at the origin puts a third of its shots in the
  // air, where they fall out of the world and are scored as misses that have
  // nothing to do with the aim under test.
  const e = spawnBoss(0, [0, -18]);
  const owner = lightUp(e);
  const lit = owner.spots.filter((s) => s.alive && !s.dead).length;
  check('the boss is wearing spots to aim at', lit > 0, `${lit} lit`);

  // Fired from a ring around the animal, straight at the middle of it — which
  // is where a shot with no weak-spot aim was always going to end up, and is
  // also the honest version of "the player pointed at the boss".
  const RANGE = 16;
  const SHOTS = 24;
  const c = CONFIG.missile ?? {};

  // One shot, flown until it enters the collision hull or runs out of life.
  //
  // The verdict is read the way systems/combat.js reads it — spotAt() against
  // the BULLET's own position, which is what hotSpotDamage is handed. Asking
  // any other way would grade the aim against a rule the game does not use.
  function fly(angle) {
    projectiles.length = 0;
    const ox = e.mesh.position.x + Math.cos(angle) * RANGE;
    const oy = e.mesh.position.y + Math.sin(angle) * RANGE;
    spawnProjectile(scene, {
      origin: new THREE.Vector3(ox, oy, 0),
      dir: new THREE.Vector2(-Math.cos(angle), -Math.sin(angle)),
      faction: 'player', damage: 1, speed: c.speed ?? 18, life: 6,
      radius: 0.2, asset: 'bullet',
      homing: true, turnRate: c.turnRate ?? 9.5, acquireRadius: 999,
      homingDelay: 0,
    });
    const p = projectiles[0];
    for (let i = 0; i < 240 && projectiles.length; i++) {
      updateProjectiles(DT, scene, [e], null, null);
      updateBossHotSpots(DT, DT);
      if (hitCreature(e, p.mesh.position.x, p.mesh.position.y, p.radius, contact)) {
        return spotAt(owner, p.mesh.position.x, p.mesh.position.y) ? 'crit' : 'body';
      }
    }
    return 'miss';
  }

  function sweep() {
    const tally = { crit: 0, body: 0, miss: 0 };
    for (let i = 0; i < SHOTS; i++) tally[fly((i / SHOTS) * Math.PI * 2)] += 1;
    return tally;
  }

  const on = CONFIG.homing.hotSpots.enabled;
  CONFIG.homing.hotSpots.enabled = false;
  const control = sweep();
  CONFIG.homing.hotSpots.enabled = true;
  const aimed = sweep();
  CONFIG.homing.hotSpots.enabled = on;

  const fmt = (t) => `${t.crit} crit / ${t.body} body / ${t.miss} miss`;
  check('aiming at the light lands more crits than aiming at the middle',
    aimed.crit > control.crit, `${fmt(aimed)} against ${fmt(control)}`);
  check('and it does not cost hits — the shots that gave up a crit still land',
    aimed.miss <= control.miss,
    `${aimed.miss} missed with the aim on, ${control.miss} with it off`);

  // A spot on the far flank is behind two metres of boss: steering at it lands
  // an ordinary hit on the near side, which is strictly worse than the body
  // shot it gave up. So whatever a shot commits to must be pointing back at
  // it — the check is on the spot's own outward normal, which is the number
  // facingHotSpots filters on.
  //
  // MEASURED WHERE THE CHOICE WAS MADE, which is the position at the TOP of
  // the step rather than the one at the bottom of it. updateHoming picks the
  // spot and then the shot is integrated past it in the same call, so reading
  // the choice against the position it left behind asks whether the spot was
  // facing the shot AFTER the shot flew through it — and once a shot is allowed
  // to hold its spot all the way to contact, the last step of every successful
  // approach reports a cosine near -1. That is the shot arriving, not the aim
  // failing. It only ever passed because the shot used to let go on the way in.
  //
  // AND THE FLIGHT STOPS AT THE HULL, the way systems/combat.js ends it. Left
  // running, a pellet carries on through the animal and out the other side,
  // steering the whole way from inside a body it has already hit.
  {
    let worst = 1;
    let checked = 0;
    for (let i = 0; i < SHOTS; i++) {
      const angle = (i / SHOTS) * Math.PI * 2;
      projectiles.length = 0;
      spawnProjectile(scene, {
        origin: new THREE.Vector3(
        e.mesh.position.x + Math.cos(angle) * RANGE,
        e.mesh.position.y + Math.sin(angle) * RANGE, 0,
      ),
        dir: new THREE.Vector2(-Math.cos(angle), -Math.sin(angle)),
        faction: 'player', damage: 1, speed: c.speed ?? 18, life: 6,
        radius: 0.2, asset: 'bullet',
        homing: true, turnRate: c.turnRate ?? 9.5, acquireRadius: 999, homingDelay: 0,
      });
      const p = projectiles[0];
      for (let k = 0; k < 40 && projectiles.length; k++) {
        const fromX = p.mesh.position.x;
        const fromY = p.mesh.position.y;
        if (hitCreature(e, fromX, fromY, p.radius, contact)) break;
        updateProjectiles(DT, scene, [e], null, null);
        updateBossHotSpots(DT, DT);
        const s = p.aimSpot;
        if (!s) continue;
        const dx = fromX - (s.cwx ?? s.wx);
        const dy = fromY - (s.cwy ?? s.wy);
        const d = Math.hypot(dx, dy) || 1;
        worst = Math.min(worst, (dx * s.wnx + dy * s.wny) / d);
        checked += 1;
      }
    }
    check('every spot a shot commits to is facing that shot', checked > 0
      && worst >= (CONFIG.homing.hotSpots.facing ?? 0.15) - 1e-6,
      `${checked} frames, worst cos ${worst.toFixed(3)} against a floor of ${CONFIG.homing.hotSpots.facing}`);
  }

  // -------------------------------------------------------------------------
  // THE SPOT THE PLAYER POINTED AT, and the whole volley on it.
  //
  // ON THE REAL GUNS, which is the point of this block existing separately
  // from everything above it. The numbers used up there are a MUSSEL's — speed
  // 18 at 9.5 rad/s, a 1.9-unit turn circle, a shot that can bend onto
  // anything — and on those the aim looked fine while the two weapons the
  // player actually fires could not use it at all. A pebble carves 6.5 units
  // and a laser bolt 12.3, both wider than this animal, so a harness that does
  // not fire a pebble is not testing the feature the player has.
  //
  // Measured against a control with the designation switched off, on the same
  // boss with the same spots, so the only difference is whether the aim was
  // pointing at one.
  {
    const guns = {
      pebble: {
        speed: CONFIG.weapon.speed, life: CONFIG.weapon.life,
        radius: CONFIG.weapon.radius,
      },
      bolt: {
        speed: CONFIG.weapon.speed * (CONFIG.finLaser?.speedMul ?? 1.9),
        life: CONFIG.weapon.life * (CONFIG.finLaser?.lifeMul ?? 0.34),
        radius: CONFIG.weapon.radius,
      },
    };
    // The seeker a level-1 Sonar Teeth hands the gun — the weakest version of
    // the card, because the strongest one was never the problem.
    const hc = CONFIG.homingShot;
    const seek = {
      homing: true, turnRate: hc.turnRate, acquireRadius: 999,
      homingDelay: 0, sizeBias: hc.sizeBias, sizeRefRadius: hc.refRadius,
    };

    // The spot a player at (ox, oy) would pick: the one most squarely facing
    // them, which is the one they can see.
    function nearestFacing(ox, oy) {
      let best = null;
      let bestCos = -2;
      for (const s of owner.spots) {
        if (!s.alive || s.dead) continue;
        const dx = ox - (s.cwx ?? s.wx);
        const dy = oy - (s.cwy ?? s.wy);
        const d = Math.hypot(dx, dy) || 1;
        const cos = (dx * s.wnx + dy * s.wny) / d;
        if (cos > bestCos) { bestCos = cos; best = s; }
      }
      return best;
    }

    // One shot, from `angle` on the ring, with the seal aiming either at
    // `want` or straight down the middle of the animal.
    function shoot(angle, gun, want) {
      const ox = e.mesh.position.x + Math.cos(angle) * RANGE;
      const oy = e.mesh.position.y + Math.sin(angle) * RANGE;
      let ax = -Math.cos(angle);
      let ay = -Math.sin(angle);
      if (want) {
        ax = (want.cwx ?? want.wx) - ox;
        ay = (want.cwy ?? want.wy) - oy;
        const l = Math.hypot(ax, ay) || 1;
        ax /= l; ay /= l;
      }
      owner.designated = null;
      projectiles.length = 0;
      spawnProjectile(scene, {
        origin: new THREE.Vector3(ox, oy, 0),
        dir: new THREE.Vector2(ax, ay),
        faction: 'player', damage: 1, speed: gun.speed, life: gun.life,
        radius: gun.radius, asset: 'bullet', ...seek,
      });
      const p = projectiles[0];
      for (let k = 0; k < 400 && projectiles.length; k++) {
        // The seal keeps pointing where it was pointing. Re-asked every frame
        // because that is how main.js asks it, and because the STICKINESS is
        // only exercised by asking more than once.
        aimHotSpots(ox, oy, ax, ay);
        updateProjectiles(DT, scene, [e], null, null);
        updateBossHotSpots(DT, DT);
        if (!projectiles.length) break;
        if (hitCreature(e, p.mesh.position.x, p.mesh.position.y, p.radius, contact)) {
          return spotAt(owner, p.mesh.position.x, p.mesh.position.y) ?? 'body';
        }
      }
      return 'miss';
    }

    // THE CLAIM IS ABOUT WHICH SPOT, NOT HOW MANY. Counting spot hits either
    // way is the wrong measurement and it reads as a pass: the per-pellet rule
    // already lands on SOME light most of the time, so a designation that went
    // to the wrong one every time would score the same. What the player asked
    // for is THIS light, so that is what is counted.
    for (const [name, gun] of Object.entries(guns)) {
      let freeOnWanted = 0;
      let aimedOnWanted = 0;
      let freeMiss = 0;
      let aimedMiss = 0;
      for (let i = 0; i < SHOTS; i++) {
        const angle = (i / SHOTS) * Math.PI * 2;
        const ox = e.mesh.position.x + Math.cos(angle) * RANGE;
        const oy = e.mesh.position.y + Math.sin(angle) * RANGE;
        const want = nearestFacing(ox, oy);
        const free = shoot(angle, gun, null);
        const aimed = shoot(angle, gun, want);
        if (free === want) freeOnWanted += 1;
        if (aimed === want) aimedOnWanted += 1;
        if (free === 'miss') freeMiss += 1;
        if (aimed === 'miss') aimedMiss += 1;
      }
      check(`a ${name} goes to the spot the aim picked`,
        aimedOnWanted > freeOnWanted,
        `${aimedOnWanted}/${SHOTS} landed on the chosen spot, against ${freeOnWanted}/${SHOTS} choosing for themselves`);
      check(`...and the ${name} does not pay for it in misses`,
        aimedMiss <= freeMiss,
        `${aimedMiss} missed aimed, ${freeMiss} free`);
    }

    // THE WHOLE VOLLEY, not one pellet. The fault this exists to remove is a
    // fan of pellets splitting itself over three lights by proximity, which
    // from behind the seal reads as the ordnance ignoring the aim.
    {
      const ox = e.mesh.position.x + 13;
      const oy = e.mesh.position.y + 6;
      const want = nearestFacing(ox, oy);
      let ax = (want.cwx ?? want.wx) - ox;
      let ay = (want.cwy ?? want.wy) - oy;
      const l = Math.hypot(ax, ay) || 1;
      ax /= l; ay /= l;
      owner.designated = null;
      aimHotSpots(ox, oy, ax, ay);
      check('the aim claims the spot it is pointed at',
        designatedHotSpot(e) === want, want ? 'claimed' : 'nothing lit');

      projectiles.length = 0;
      // A fan, the way a multishot volley leaves the flippers.
      for (let i = -3; i <= 3; i++) {
        const a = Math.atan2(ay, ax) + i * 0.16;
        spawnProjectile(scene, {
          origin: new THREE.Vector3(ox, oy, 0),
          dir: new THREE.Vector2(Math.cos(a), Math.sin(a)),
          faction: 'player', damage: 1, speed: guns.pebble.speed,
          life: guns.pebble.life, radius: guns.pebble.radius, asset: 'bullet', ...seek,
        });
      }
      const fan = projectiles.slice();
      for (let k = 0; k < 20; k++) {
        aimHotSpots(ox, oy, ax, ay);
        updateProjectiles(DT, scene, [e], null, null);
        updateBossHotSpots(DT, DT);
      }
      const onWant = fan.filter((p) => p.aimSpot === want).length;
      check('every pellet in the volley works the same spot',
        onWant === fan.length, `${onWant}/${fan.length}`);

      // ...AND A HAND THAT WOBBLES DOES NOT DROP IT. The release cone is wider
      // than the grab cone precisely so this holds; with one cone for both, a
      // spot crossed its own boundary twice a second and the volley split
      // between the light and the body centre — the same fault by another road.
      const wob = 0.055;
      const wx = ax * Math.cos(wob) - ay * Math.sin(wob);
      const wy = ax * Math.sin(wob) + ay * Math.cos(wob);
      aimHotSpots(ox, oy, wx, wy);
      check('...and a small wobble does not drop the claim',
        designatedHotSpot(e) === want);

      // A CLAIM IS NOT A MAGNET. Point the aim right away from the animal and
      // the designation has to go, or it is not an aim at all.
      aimHotSpots(ox, oy, 1, 0.9);
      check('...and aiming away from the boss clears it',
        designatedHotSpot(e) === null);
    }

    // THE SEAL'S ORDNANCE ONLY. An enemy missile chases the seal and has no aim
    // of its own to obey — and a player's reticle steering the things being
    // fired AT them is the same bug with the sign flipped.
    {
      const ox = e.mesh.position.x + 13;
      const oy = e.mesh.position.y + 6;
      const want = nearestFacing(ox, oy);
      let ax = (want.cwx ?? want.wx) - ox;
      let ay = (want.cwy ?? want.wy) - oy;
      const l = Math.hypot(ax, ay) || 1;
      ax /= l; ay /= l;
      // AGAINST A CONTROL RUN OF THE SAME SHOT with nothing designated, which
      // is the only honest way to ask this: the per-pellet rule can perfectly
      // well pick the same spot the player did, and a bare "it is not on the
      // designated one" would pass or fail on that coincidence rather than on
      // the faction gate.
      function enemyShotSpot(designate) {
        owner.designated = null;
        if (designate) aimHotSpots(ox, oy, ax, ay);
        projectiles.length = 0;
        spawnProjectile(scene, {
          origin: new THREE.Vector3(ox + 6, oy + 6, 0),
          dir: new THREE.Vector2(-1, -1),
          faction: 'enemy', damage: 1, speed: guns.pebble.speed,
          life: guns.pebble.life, radius: guns.pebble.radius, asset: 'bullet', ...seek,
        });
        const p = projectiles[0];
        for (let k = 0; k < 6; k++) {
          if (designate) aimHotSpots(ox, oy, ax, ay);
          updateProjectiles(DT, scene, [e], null, null);
        }
        return p.aimSpot ?? null;
      }
      const withAim = enemyShotSpot(true);
      const without = enemyShotSpot(false);
      check('an enemy shot does not obey the player\'s aim',
        withAim === without,
        withAim === without ? 'same spot either way' : 'the reticle moved it');
    }
  }

  // AND NOTHING CHANGES FOR ANYTHING THAT IS NOT A BOSS. The aim reaches into
  // a per-creature record that only a boss has, and an ordinary fish is the
  // whole rest of the roster — a shot that started consulting it for them
  // would be a change to every seeker in the game rather than to this one
  // fight.
  {
    const mesh = new THREE.Mesh();
    mesh.position.set(6, -18, 0);
    scene.add(mesh);
    const fish = { type: 'fish', mesh, radius: 0.4, hp: 99 };
    projectiles.length = 0;
    spawnProjectile(scene, {
      origin: new THREE.Vector3(0, -18, 0),
      dir: new THREE.Vector2(1, 0),
      faction: 'player', damage: 1, speed: 18, life: 3, radius: 0.2, asset: 'bullet',
      homing: true, turnRate: 9.5, acquireRadius: 999, homingDelay: 0,
    });
    const p = projectiles[0];
    for (let i = 0; i < 10; i++) updateProjectiles(DT, scene, [fish], null, null);
    check('an ordinary creature is still aimed at in the middle, as always',
      p.target === fish && p.aimSpot === null);
    scene.remove(mesh);
  }
  projectiles.length = 0;
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
  // ROUNDED UP, PLUS A FRAME. A cycle is rarely a whole number of frames — '2
  // bars' at 105bpm is 274.3 of them — and rounding DOWN walks 0.999 of a
  // cycle, which never crosses the wrap and reads as a counter that has
  // stopped. One frame past the cycle is still far short of two, so the wrap
  // count below is exactly one whatever phase the transport happens to be at.
  const steps = Math.ceil(seconds / DT) + 1;
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
  // BRIGHT, and the check is on the DEFAULT rather than on the literal: what
  // matters is that the base is something a player can see on a dark hide, not
  // that it is one particular colour forever.
  //
  // IT USED TO ASK FOR A NEUTRAL, on the reasoning that a per-boss tint would
  // multiply into it and drag the hue somewhere nobody chose. That stopped
  // being true when the override became a REPLACEMENT — `owner.tint ?? litColor`
  // in systems/bossHotSpots.js — so a coloured base cannot contaminate
  // anything downstream of it, and the swatch in the tuner is on a hot orange
  // today. What a bad value here looks like now is a DARK one: the spot is the
  // one part of a boss the player is meant to aim at, and a base with no value
  // in it is a weak point nobody can find.
  const c = new THREE.Color(l.litColor);
  check('...and that base is bright enough to read on a hide',
    Math.max(c.r, c.g, c.b) >= 0.7,
    `#${l.litColor.toString(16)} — peak channel ${Math.max(c.r, c.g, c.b).toFixed(2)}`);

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
section('5g. A rupture shoves the animal, out along the wound');
// ---------------------------------------------------------------------------
// THE HALF THAT IS NOT A LIGHT. Everything else about a burst happened around
// a boss that carried on swimming its line as though nothing had gone off in
// its flank. Queued rather than applied, for the same reason the meat is —
// entities/projectiles.js imports this module and entities/enemies.js imports
// projectiles, so calling applyKnockback from in here would close a cycle
// through the three biggest modules in the game to deliver one impulse.
{
  const e = spawnBoss();
  const owner = lightUp(e);
  const s = owner.spots[0];
  const nx = s.wnx;
  const ny = s.wny;

  drainHotSpotShoves();          // anything an earlier section left owing
  e.knockX = 0;
  e.knockY = 0;

  hotSpotDamage(e, { x: s.wx, y: s.wy }, s.pool * 2);
  const shoves = drainHotSpotShoves();
  check('bursting one owes a shove', shoves.length === 1, `${shoves.length}`);

  const shove = shoves[0] ?? {};
  check('...against the boss that was hit', shove.e === e);
  // OUT ALONG THE SKIN'S NORMAL AT THE SPOT. This is the whole reason the
  // impulse is fired from the rupture rather than from the hit: the direction
  // is the wound pointing outward, so a spot on the near flank pushes the
  // animal away from the player and one on the far side pulls it across.
  check('...out along the skin\'s normal at the wound',
    Math.abs(shove.dirX - nx) < 1e-6 && Math.abs(shove.dirY - ny) < 1e-6,
    `(${shove.dirX?.toFixed(2)}, ${shove.dirY?.toFixed(2)})`);
  check('...from the point it went off, not from the body\'s middle',
    Math.abs(shove.x - s.wx) < 1e-6 && Math.abs(shove.y - s.wy) < 1e-6
      && Math.hypot(shove.x - e.mesh.position.x, shove.y - e.mesh.position.y) > 0.1,
    `${Math.hypot(shove.x - e.mesh.position.x, shove.y - e.mesh.position.y).toFixed(2)} off centre`);
  check('...at the strength the CSV owns',
    shove.strength === CONFIG.hotSpots.burstKnock.strength,
    `x${shove.strength}`);
  check('and draining it twice does not shove twice',
    drainHotSpotShoves().length === 0);

  // AND IT LANDS THROUGH THE ONE SHOVE PATH. Not knockX written from the weak
  // spots: applyKnockback owns the mass curve, the boss branch, the decay and
  // the skeleton flinch, and a second implementation would be a second copy of
  // every one of those rules.
  // `source: 'rupture'`, exactly as main.js spends the queue. A boss refuses a
  // shove it cannot attribute (CONFIG.boss.tenacity.sources), so a stand-in
  // that left the name off would measure the refusal rather than the burst.
  const moved = applyKnockback(e, shove.dirX, shove.dirY, 1,
    { gain: shove.strength, source: 'rupture' });
  check('the impulse reaches the boss', e.knockX !== 0 || e.knockY !== 0,
    `(${e.knockX.toFixed(2)}, ${e.knockY.toFixed(2)}) at ${moved.toFixed(1)} u/s`);
  const along = (e.knockX * nx + e.knockY * ny) / (Math.hypot(e.knockX, e.knockY) || 1);
  check('...along the wound\'s normal and nowhere else', along > 0.999,
    `cos ${along.toFixed(4)}`);

  // THE STRENGTH IS A REAL MULTIPLIER, not a flag. Measured against the same
  // shove at gain 1, because "it moved" was true before this existed too — a
  // full-charge ram already shoves a boss, and what is being asserted is that
  // the burst reaches past what a ram can express.
  e.knockX = 0;
  e.knockY = 0;
  const ram = applyKnockback(e, nx, ny, 1, { source: 'ram' });
  check('...and it is stronger than a full-charge ram',
    Math.abs(moved / ram - CONFIG.hotSpots.burstKnock.strength) < 1e-6,
    `x${(moved / ram).toFixed(2)} of a ram`);
}

// ---------------------------------------------------------------------------
section('5e. A boss can be TOLD where its weak spots go');
// ---------------------------------------------------------------------------
// bossHotSpots.csv, one row per archetype. The roll answers "somewhere good on
// this outline", which is the right question for a body with a lot of outline
// and the wrong one where the answer is a design decision — and on the three
// bosses that collide as a CIRCLE by choice there are no fitted spheres for a
// heuristic to prefer at all, so the roll there was picking points on a disc.
//
// EVERY PLACEMENT CHECK BELOW RUNS ON THE MEGALODON'S BODY while naming
// somebody else's row, and that is deliberate rather than lazy: what is being
// measured is that an anchor puts a spot at the named place on WHATEVER body it
// is handed, which is the property that has to hold on ten different rigs. The
// shark is simply the one body this harness can pose.
{
  const roster = bossHotSpotRoster();
  const ids = parseBossCsv(readFileSync(new URL('../path/src/bosses.csv', import.meta.url), 'utf8'),
    CONFIG.enemies, () => {}).map((b) => b.id);

  check('every row in bossHotSpots.csv is a real archetype',
    Object.keys(roster).every((id) => ids.includes(id)),
    Object.keys(roster).join(', ') || 'no rows');

  // THE MOSASAUR'S PIN SURVIVED THE MOVE. It was a `weakSpot: 'tail'` string on
  // the creature in config.js reached through a hard-coded two-value table; if
  // the migration lost it, nothing on screen would say so — the boss would
  // simply go back to rolling, which is what it did before anybody noticed it
  // was wrong.
  check('the mosasaur is still told: one spot, at its tail',
    roster.bossMosasaur?.anchors?.length === 1 && roster.bossMosasaur.anchors[0].along === -1,
    JSON.stringify(roster.bossMosasaur?.anchors));

  // --- the vocabulary -------------------------------------------------------
  // A malformed anchor is DROPPED rather than defaulted, and this is the check
  // that keeps it that way: 0 is amidships and is a perfectly plausible place,
  // so a typo silently becoming 0 would move a boss's weak spot to its middle
  // and look exactly like a decision somebody made.
  const said = [];
  const warn = (m) => said.push(m);
  check('words for the ends', JSON.stringify(parseAnchors('tail|head|mid', 'x', warn))
    === JSON.stringify([{ along: -1, side: 0, vert: 0 }, { along: 1, side: 0, vert: 0 }, { along: 0, side: 0, vert: 0 }]));
  check('...and numbers, with a side',
    JSON.stringify(parseAnchors('0.5:l|0.5:r', 'x', warn))
      === JSON.stringify([{ along: 0.5, side: 1, vert: 0 }, { along: 0.5, side: -1, vert: 0 }]));
  check('past the ends clamps rather than refusing',
    parseAnchors('-1.4', 'x', warn)[0].along === -1);
  check('blank is no anchors at all', parseAnchors('', 'x', warn) === null);
  const before = said.length;
  check('a position that is neither a number nor a word is dropped and named',
    parseAnchors('snout', 'x', warn) === null && said.length > before,
    said[said.length - 1]?.slice(0, 60));
  const beforeSide = said.length;
  check('...and an unknown side falls back to either flank, loudly',
    parseAnchors('0.5:sideways', 'x', warn)[0].side === 0 && said.length > beforeSide);

  // --- THE WORLD-UP AXIS ---------------------------------------------------
  // `l`/`r` are flanks in the body's frame and follow the animal round when it
  // turns; `u`/`d` are world up and down and do not. A dorsal spot written as
  // a flank is a belly spot on the way home, which is the bug this axis exists
  // to make unwritable.
  check('the back and the belly parse onto their own axis',
    JSON.stringify(parseAnchors('head:u|0:belly', 'x', warn))
      === JSON.stringify([{ along: 1, side: 0, vert: 1 }, { along: 0, side: 0, vert: -1 }]));
  check('...and every spelling of them agrees',
    ['u', 'up', 'top', 'back', 'dorsal'].every((w) => parseAnchors(`0:${w}`, 'x', warn)[0].vert === 1)
    && ['d', 'down', 'belly', 'under', 'ventral'].every((w) => parseAnchors(`0:${w}`, 'x', warn)[0].vert === -1));
  // A spot is on a flank OR on the back, never both -- naming two is not a
  // place, so the vertical key clears `side` rather than stacking with it.
  check('a vertical anchor carries no flank', parseAnchors('0:u', 'x', warn)[0].side === 0);
  check('...and a flank anchor carries no vertical', parseAnchors('0:l', 'x', warn)[0].vert === 0);

  // --- a row's count is its anchors ----------------------------------------
  {
    const e = spawnBoss();
    const spots = lightUp(e, 4242, 'bossMosasaur').spots;
    check('an archetype told ONE place gets one spot', spots.length === 1, `${spots.length}`);
    // The body faces +x at heading 0, so the tail end is -x. Measured against
    // the animal's own reach rather than against a world number, because the
    // whole point of the anchor is that it is in the body's frame.
    const along = (spots[0].wx - e.mesh.position.x) / (e.radius ?? 1);
    check('...and it opens at the tail end of the body', along < -0.4,
      `${along.toFixed(2)} body radii forward of centre`);
  }

  // --- one per flank --------------------------------------------------------
  // MEASURED ON THE ORDERING, not through a placement, and the difference is
  // the whole reason anchorOrder is exported. A placement runs the snap and
  // the hull-match on top of the order, so on a body whose flanks are thin at
  // the named station — a megalodon's snout at 0.55, which is what this
  // harness has to hand — the near-side candidates are refused for having no
  // flesh within reach and the spot correctly lands on the far one. That is
  // the placer being right and it looks identical to the ordering being wrong.
  // The crab's own row is authored against a body that collides as a CIRCLE,
  // where the perimeter is 24 points evenly around it and both flanks are
  // equally available.
  {
    const e = spawnBoss();
    const cands = perimeterCandidates(e.hitShape, CONFIG.hotSpots.rays ?? 24);
    const claws = bossHotSpotRoster().bossCrab.anchors;
    check('the crab is told two places, one per flank',
      claws.length === 2 && claws[0].side === -claws[1].side && claws[0].along === claws[1].along,
      JSON.stringify(claws));

    // `across` is the left-hand normal of the heading; at heading 0 that is y.
    const port = (c) => c.wy - e.mesh.position.y;
    const first = (anchor) => anchorOrder(cands, e, anchor)[0];
    check('a port anchor puts a port candidate first', port(first(claws[0])) > 0,
      port(first(claws[0])).toFixed(2));
    check('...and a starboard one a starboard candidate', port(first(claws[1])) < 0,
      port(first(claws[1])).toFixed(2));

    // THE WORLD-UP AXIS, measured the way the bug would show: the SAME anchor
    // on a boss facing the other way. A flank swaps with the heading and the
    // back does not, so a dorsal spot written `:l` is a belly spot on the way
    // home -- which is exactly what this asserts cannot happen any more.
    const up = (c) => c.wy - e.mesh.position.y;
    const dorsal = parseAnchors('mid:back', 't', () => {})[0];
    const ventral = parseAnchors('mid:belly', 't', () => {})[0];
    check('a dorsal anchor puts a top candidate first', up(first(dorsal)) > 0,
      up(first(dorsal)).toFixed(2));
    check('...and a ventral one a bottom candidate', up(first(ventral)) < 0,
      up(first(ventral)).toFixed(2));

    e.heading = Math.PI; // the same animal, swimming home
    const back = perimeterCandidates(e.hitShape, CONFIG.hotSpots.rays ?? 24);
    const firstBack = (a) => anchorOrder(back, e, a)[0];
    check('...and the back is still the back when the boss turns round',
      up(firstBack(dorsal)) > 0 && up(firstBack(ventral)) < 0,
      `${up(firstBack(dorsal)).toFixed(2)} / ${up(firstBack(ventral)).toFixed(2)}`);
    e.heading = 0;

    // AND THE STATION STILL WINS INSIDE THE NAMED FLANK. A side is a flank,
    // not a direction to walk in: if the lateral distance leaked back into the
    // score the order would run to the widest part of that flank instead of to
    // the place that was asked for.
    const alongOf = (c) => (c.wx - e.mesh.position.x);
    const head = first({ along: 1, side: 1 });
    const tail = first({ along: -1, side: 1 });
    check('a port anchor at the head and one at the tail are different places',
      alongOf(head) > alongOf(tail), `${alongOf(head).toFixed(1)} vs ${alongOf(tail).toFixed(1)}`);

    // AN ANCHOR CAN NEVER FAIL TO PRODUCE AN ORDER. It orders every candidate
    // the perimeter search found rather than selecting among some of them, so
    // the worst case is a spot a little away from where it was asked for
    // instead of a boss with a weak spot fewer than it should have.
    check('...and every candidate is in the order, none filtered out',
      anchorOrder(cands, e, claws[0]).length === cands.length,
      `${cands.length} candidates`);
  }

  // --- a spot relights WHERE IT BURST --------------------------------------
  // The opposite of what an unauthored boss does, and the point of authoring
  // one: if the replacement opened somewhere else, the fight would teach the
  // player the place for four seconds and then contradict it.
  {
    const e = spawnBoss();
    const spots = lightUp(e, 7, 'bossMosasaur').spots;
    const where = spots[0] ? { x: spots[0].wx, y: spots[0].wy } : null;
    // Chew it to its burst.
    for (let i = 0; i < 40 && liveHotSpots(e).length; i++) {
      const s = liveHotSpots(e)[0];
      if (!s) break;
      hotSpotDamage(e, { x: s.wx, y: s.wy }, e.maxHp);
      updateBossHotSpots(DT, DT);
    }
    // Past the relight gap.
    for (let i = 0; i < Math.ceil((CONFIG.hotSpots.relightSeconds + 1) / DT); i++) {
      updateBossHotSpots(DT, DT);
    }
    const now = liveHotSpots(e);
    check('a burst spot relights, and at the place it was told', now.length === 1
      && where != null && Math.hypot(now[0].wx - where.x, now[0].wy - where.y) < (e.radius ?? 1),
      now.length ? `${Math.hypot(now[0].wx - where.x, now[0].wy - where.y).toFixed(2)} units away` : 'nothing relit');
  }

  // --- and the colour -------------------------------------------------------
  // A per-boss colour REPLACES the roster one rather than multiplying it: a
  // multiply cannot brighten, so pure blue over a red default comes out black
  // and the two ways of saying "this boss's spots are blue" disagree.
  {
    const e = spawnBoss();
    lightUp(e, 11, 'bossMosasaur');
    const u = hotSpotShells(e)[0].material.userData.__hotUniforms;
    const want = CONFIG.hotSpots.look.litColor ?? 0xffffff;
    check('a row with no colour leaves the roster colour alone',
      u.uHotLit.value.getHex() === want, `#${u.uHotLit.value.getHex().toString(16)}`);
  }
}

// ---------------------------------------------------------------------------
section('5f. Nothing is painted outside the crit boundary, and the lock is on the spot');
// ---------------------------------------------------------------------------
// TWO DELETIONS AND ONE MOVE, asserted so they cannot come back by accident.
//
// The spill was a haze reaching past r = 1, which meant the brightest region on
// the animal was WIDER than the reach it was describing — a player aiming at
// the middle of what they could see was aiming at the middle of something
// bigger than the crit. And the reticle was a second object saying WHERE, on a
// screen that already had the patch saying it; what it uniquely said — which
// spot the volley is going to — moved onto the patch, where the eye already is.
{
  const l = CONFIG.hotSpots.look;
  check('the look has no spill', l.spill === undefined && l.spillGain === undefined);
  check('...no chewed edge', l.jag === undefined && l.jagRate === undefined);
  check('...no second interior line', l.chargeEdge === undefined);
  check('...and no reticle block at all', l.target === undefined);
  check('the lock is a look number, not a ring', typeof l.lockGlow === 'number'
    && typeof l.lockRing === 'number', `${l.lockGlow} / ${l.lockRing}`);

  // COVERAGE IS WHAT REPLACED THE RETICLE, so it has to be high enough to be
  // paint rather than a plea. Below about half the patch is lighting the hide
  // instead of standing in for it, which is the state the reticle existed to
  // rescue — and the reticle is gone.
  check('the patch mostly replaces the hide rather than lighting it',
    (l.cover ?? 0) >= 0.6 && (l.coverFull ?? 0) >= (l.cover ?? 0) && (l.coverFull ?? 1) <= 1,
    `cover ${l.cover} -> ${l.coverFull}`);

  const e = spawnBoss();
  const spots = lightUp(e).spots;
  const u = hotSpotShells(e)[0].material.userData.__hotUniforms;
  // The lock rides the mood vector's w slot, which used to carry the per-spot
  // seed. Nothing reads a seed in the shader any more (the noise field it fed
  // is gone), which is what freed the slot — so this is also the check that the
  // slot did not quietly go back to carrying a random number.
  check('no spot is locked until an aim claims one',
    u.uHotMood.value.every((m) => m.w === 0),
    u.uHotMood.value.map((m) => m.w.toFixed(2)).join(' '));

  const target = spots[0];
  aimHotSpots(target.wx - 30, target.wy, 1, 0);
  updateBossHotSpots(DT, DT);
  const idx = hotSpotsOf(e).spots.indexOf(designatedHotSpot(e));
  check('an aim lights the lock slot on exactly one spot',
    idx >= 0 && u.uHotMood.value.filter((m) => m.w > 0).length === 1,
    `spot ${idx}`);
  check('...and it is the one the aim picked',
    idx >= 0 && u.uHotMood.value[idx].w === 1);
}

// ---------------------------------------------------------------------------
section('5h. Hitting one shakes the animal\'s skeleton');
// ---------------------------------------------------------------------------
// THE HALF OF A HIT THAT READS ON A BODY TOO BIG TO MOVE. The whole of
// CONFIG.strike.knockback.boss is an argument about how LITTLE a boss may be
// shoved — a boss that flew would read as weightless — so on the one creature
// in the water that matters, the flinch is the only channel a hit has.
//
// MEASURED AGAINST A CONTROL RUN, never off absolute bone positions: the animal
// is swimming, and a swim cycle out-moves any impulse you try to read without
// one. Bone positions are taken RELATIVE TO THE BODY for the same reason, and
// the world matrices are forced first — without that every pose reports its
// last-uploaded transform, every frame measures identical, and nothing throws.
{
  const _bv = new THREE.Vector3();
  const bones = (e) => {
    scene.updateMatrixWorld(true);
    const out = [];
    e.visual.traverse((o) => {
      if (!o.isBone) return;
      o.getWorldPosition(_bv);
      out.push(_bv.x - e.mesh.position.x, _bv.y - e.mesh.position.y, _bv.z - e.mesh.position.z);
    });
    return out;
  };
  const trail = (hit, frames = 60) => {
    const e = spawnBoss();
    lightUp(e);
    const out = [];
    for (let i = 0; i < frames; i++) {
      if (i === 5 && hit) hit(e);
      e.anim?.update(DT, stateForSpeed(e.def.speed ?? 5), false);
      tickHitShapes();
      updateBossHotSpots(DT, DT);
      out.push(bones(e));
    }
    return out;
  };
  // The loudest bone, and how much of the BODY moved. A tail tip whipping alone
  // and a whole animal buckling have the same peak and completely different
  // means, and only one of them reads as a hit.
  const peak = (a, b) => {
    let best = 0;
    for (let f = 0; f < a.length; f++) {
      for (let i = 0; i < a[f].length; i += 3) {
        const d = Math.hypot(a[f][i] - b[f][i], a[f][i + 1] - b[f][i + 1], a[f][i + 2] - b[f][i + 2]);
        if (d > best) best = d;
      }
    }
    return best;
  };

  const control = trail(null);
  const probe = spawnBoss();
  const R = probe.radius || 1;
  const pct = (v) => `${(v / R * 100).toFixed(1)}% of body radius`;

  // --- a ram on the flank ---------------------------------------------------
  const flank = peak(control, trail((e) => applyKnockback(e, 1, 0, 1, { source: 'ram', boneGain: 1 })));
  check('a full-charge ram visibly shakes a boss', flank > R * 0.15, pct(flank));
  const weakCharge = peak(control, trail((e) => applyKnockback(e, 1, 0, 0, { source: 'ram', boneGain: 1 })));
  check('...and a minimum-charge one still reads at all', weakCharge > R * 0.08, pct(weakCharge));
  check('...but less, so the charge is worth holding', weakCharge < flank,
    `${pct(weakCharge)} vs ${pct(flank)}`);

  // --- a hit on a lit spot --------------------------------------------------
  // THE POINT OF THE WHOLE BLOCK. Same animal, same frame, same impulse
  // direction — the only difference is where the hit landed.
  const onSpot = peak(control, trail((e) => {
    const s = liveHotSpots(e)[0];
    hotSpotDamage(e, { x: s.cwx, y: s.cwy },
      Math.max(CONFIG.strike.damage, e.maxHp * (CONFIG.strike.weakSpot.maxHpFrac ?? 0.035) * 2), null, 'ram');
    applyKnockback(e, 1, 0, 1, { source: 'ram', boneGain: 1 });
  }));
  check('a ram into a lit spot shakes it far harder than one on the flank',
    onSpot > flank * 2, `${pct(onSpot)} vs ${pct(flank)} — x${(onSpot / flank).toFixed(1)}`);

  // --- PAID ON DAMAGE, NOT ON HITS -----------------------------------------
  // The chum payout's argument applied to the body language, and the reason it
  // is here: bullets arrive ten a second and the club once, so an impulse per
  // HIT would make an automatic weapon a boss in permanent convulsion and a
  // slow one nearly silent. Ten small hits and one big one carrying the same
  // damage have to reach the same place, because the springs integrate.
  const oneBig = peak(control, trail((e) => {
    const s = liveHotSpots(e)[0];
    hotSpotDamage(e, { x: s.cwx, y: s.cwy }, s.pool * 0.3 / CONFIG.hotSpots.critMul, null, 'club');
  }));
  const tenSmall = peak(control, trail((e) => {
    const s = liveHotSpots(e)[0];
    for (let i = 0; i < 10; i++) hotSpotDamage(e, { x: s.cwx, y: s.cwy }, s.pool * 0.03 / CONFIG.hotSpots.critMul, null, 'club');
  }));
  check('ten small hits shake it about as hard as one big one of the same damage',
    Math.abs(oneBig - tenSmall) < oneBig * 0.35, `${pct(oneBig)} vs ${pct(tenSmall)}`);

  // A PELLET DOES NOT ROCK A BOSS, which is the same rule read from the other
  // end and is what stops the fight being a permanent earthquake.
  const pellet = peak(control, trail((e) => {
    const s = liveHotSpots(e)[0];
    hotSpotDamage(e, { x: s.cwx, y: s.cwy }, s.pool * 0.02 / CONFIG.hotSpots.critMul, null, 'club');
  }));
  check('one pellet barely moves it', pellet < R * 0.05, pct(pellet));

  // --- and it comes back ----------------------------------------------------
  // A spring that never settles is a boss that swims wrong for the rest of the
  // fight, and a NaN in one is a body that vanishes — both silent.
  {
    const long = trail(null, 240);
    const hit = trail((e) => {
      const s = liveHotSpots(e)[0];
      hotSpotDamage(e, { x: s.cwx, y: s.cwy }, s.pool * 2, null, 'ram');
      applyKnockback(e, 1, 0, 1, { source: 'ram', boneGain: 1 });
    }, 240);
    let settled = -1;
    let finite = true;
    for (let f = 6; f < long.length; f++) {
      let mx = 0;
      for (let i = 0; i < long[f].length; i += 3) {
        const d = Math.hypot(long[f][i] - hit[f][i], long[f][i + 1] - hit[f][i + 1], long[f][i + 2] - hit[f][i + 2]);
        if (!Number.isFinite(d)) finite = false;
        if (d > mx) mx = d;
      }
      if (mx < R * 0.02) { settled = f - 5; break; }
    }
    check('no NaN reaches the springs', finite);
    check('the biggest hit in the fight settles back into the swim',
      settled > 0 && settled < 180, settled > 0 ? `${(settled / 60).toFixed(2)}s` : 'still moving after 4s');
  }

  // --- AND NONE OF IT DURING A RUN -----------------------------------------
  // CONFIG.boss.tenacity: a committed boss takes no hit reaction from
  // anything, at any weight. Three channels can deliver one and this was the
  // one that never asked — which put the loudest flinch in the game inside the
  // exact window super armor deliberately leaves the spot open in, so the
  // moment the player is told to shoot the spot was the moment the animal
  // stopped being able to finish its attack. It read as the damage reaction
  // cancelling the lunge, and on the hammerhead — the longest tail chain in
  // the roster, whose whole tell is the head coming round — it read worst.
  //
  // MEASURED ON THE BONES against the same control run as everything above,
  // not off a call count: a gate that returns early and an impulse that lands
  // and is silently damped somewhere else are the same number of calls and
  // completely different animals.
  //
  // EVERY MOVE A BOSS HAS, not only the lunge: `isAttacking` in
  // entities/enemies.js is the one predicate all four flinch channels read,
  // and the list below is its list. A body whose attack is a clip resolves
  // this in trigger() (ATTACK_STATES in systems/animation.js); these are the
  // ones whose attack is a state on the creature instead, and they had no way
  // to say so.
  {
    // `ram` — a named hitter on tenacity's list. jostleGate refuses everything
    // else outright (a stream of pellets crits, bleeds and bursts a spot and
    // does not rock the animal), so an unnamed hit measures zero whether this
    // gate works or not and would prove nothing about it.
    const spotHit = (e) => {
      const s = liveHotSpots(e)[0];
      hotSpotDamage(e, { x: s.cwx, y: s.cwy }, s.pool * 0.3 / CONFIG.hotSpots.critMul, null, 'ram');
    };
    const cruising = peak(control, trail(spotHit));
    check('a ram into a lit spot shakes a boss that is doing nothing', cruising > R * 0.05,
      pct(cruising));

    // THE WIND-UP IS THE ONE THAT COSTS MOST, and it is the one the first pass
    // at this left open: `isCommittedRun` is only the run itself, so a boss
    // was still being whipped through the half-second that is its entire tell.
    // On the hammerhead that half-second is the skull coming round to face
    // you, which is the only warning the shove ever gives.
    const moves = {
      'winding up to a lunge': (e) => { e.lungeStage = 'wind'; },
      'committed to the run': (e) => { e.lungeStage = 'strike'; },
      're-aiming between two of them': (e) => { e.lungeStage = 'reaim'; },
      'ramming — the perk, the kraken, the angler, the crab': (e) => { e.ramming = true; },
      'holding you in its jaws': (e) => { e.grabbing = true; },
      'swinging a claw': (e) => { e.claw = { isStriking: () => true }; },
      'driven by a perk': (e) => { e.perkDrive = true; },
    };
    for (const [what, arm] of Object.entries(moves)) {
      const held = peak(control, trail((e) => { arm(e); spotHit(e); }));
      check(`...and none at all into one ${what}`, held < R * 0.01, pct(held));
    }

    // ...BUT NOT WHILE IT IS MERELY SWIMMING AT YOU. The cruise between two
    // runs is not an attack, and a rule that caught it would be a boss that
    // never flinches at all — which passes every check above and is a
    // different bug wearing this one's passing test.
    const cruise = peak(control, trail((e) => { e.lungeStage = 'cruise'; spotHit(e); }));
    check('...while the cruise between runs still flinches', cruise > R * 0.05, pct(cruise));

    // THE RUPTURE IS NOT AN EXCEPTION. It is the bigger half of the same
    // channel, and its shove through applyKnockback is already refused mid-run
    // — a burst that could not move the animal but could still whip it would
    // be the hole in a different shape.
    const burst = peak(control, trail((e) => {
      const s = liveHotSpots(e)[0];
      e.lungeStage = 'wind';
      hotSpotDamage(e, { x: s.cwx, y: s.cwy }, s.pool * 2, null, 'ram');
    }));
    check('...and neither does a spot rupturing on one', burst < R * 0.01, pct(burst));

    // WHAT STILL LANDS. The whole point of the exemption is that it costs the
    // player nothing but the body language: the crit, the pool and the burst
    // are all untouched mid-run. Asserted here rather than left to section 5,
    // because a gate written one line too early in jostle() would take the
    // damage with it and every check above would still pass.
    {
      const e = spawnBoss();
      lightUp(e);
      const s = liveHotSpots(e)[0];
      e.lungeStage = 'strike';
      const hp0 = e.hp;
      const pool0 = s.taken;
      e.hp -= hotSpotDamage(e, { x: s.cwx, y: s.cwy }, s.pool * 0.3 / CONFIG.hotSpots.critMul, null, 'ram');
      check('...while the crit itself still lands mid-run',
        hp0 - e.hp > 0 && s.taken - pool0 > 0,
        `${(hp0 - e.hp).toFixed(1)} hp, ${(s.taken - pool0).toFixed(1)} into the pool`);
    }

    // THE DIAL, so the flag is doing the work rather than something else in
    // the chain having gone quiet.
    const TEN = CONFIG.boss.tenacity;
    const was = TEN.committed;
    TEN.committed = false;
    const off = peak(control, trail((e) => { e.lungeStage = 'wind'; spotHit(e); }));
    TEN.committed = was;
    check('...and CONFIG.boss.tenacity.committed is the switch', off > R * 0.05, pct(off));
  }

  // --- AND A BOSS DOES NOT ANSWER TO BEING SHOT AT -------------------------
  //
  // The rule is CONFIG.boss.tenacity and it is about the FIGHT, not the
  // picture: a flinching boss is a boss that is not lunging, so a hit reaction
  // per pellet makes the answer to a wind-up "shoot harder" instead of "move".
  //
  // THIS IS THE CHECK THAT WAS MISSING WHEN THE JOSTLE FIRST SHIPPED. It
  // called anim.impulse directly, which is the one path the tenacity gate does
  // not sit on — the exact hole boss-tenacity-test.mjs names in its own header
  // ("added in front of the SHOVE and forgotten in front of the FLINCH"). That
  // harness caught it by counting lunges; this is the same fact asserted where
  // somebody changing the jostle will see it.
  const bullet = peak(control, trail((e) => {
    const s = liveHotSpots(e)[0];
    // No source — a pellet, which is not on tenacity.sources.
    for (let i = 0; i < 12; i++) hotSpotDamage(e, { x: s.cwx, y: s.cwy }, s.pool * 0.08 / CONFIG.hotSpots.critMul);
  }));
  check('a stream of pellets into a lit spot does not rock the boss', bullet < R * 0.05,
    pct(bullet));
  const swung = peak(control, trail((e) => {
    const s = liveHotSpots(e)[0];
    hotSpotDamage(e, { x: s.cwx, y: s.cwy }, s.pool * 0.96 / CONFIG.hotSpots.critMul, null, 'club');
  }));
  check('...but a club swing carrying the same damage does', swung > bullet * 5,
    `${pct(swung)} vs ${pct(bullet)}`);

  // --- what the build buys --------------------------------------------------
  // And what it does NOT: `boneGain` reaches the flinch and nothing else, so a
  // strike build is allowed to look harder without a boss being thrown further.
  check('a strike build makes a boss flinch harder', strikeBoneGain({ strikeDamage: CONFIG.strike.damage * 4 })
    > strikeBoneGain({ strikeDamage: CONFIG.strike.damage }),
    `x${strikeBoneGain({ strikeDamage: CONFIG.strike.damage * 4 }).toFixed(2)} at 4x strike`);
  check('...a base run is exactly 1', strikeBoneGain({ strikeDamage: CONFIG.strike.damage }) === 1);
  check('...and a run with no stats block is too', strikeBoneGain(null) === 1);
  check('...it never goes below 1', strikeBoneGain({ strikeDamage: CONFIG.strike.damage * 0.1 }) === 1);
  check('...and it is capped', strikeBoneGain({ strikeDamage: CONFIG.strike.damage * 1000 })
    <= (CONFIG.strike.knockback.boneUpgradeMax ?? 2.4));
  {
    // THE SHOVE IS NOT UPGRADE-SCALED, and this is the check that keeps it
    // that way. How far a body is thrown decides whether it can reach you next
    // second, which is balance and belongs to the charge.
    const a = spawnBoss();
    applyKnockback(a, 1, 0, 1, { source: 'ram', boneGain: 1 });
    const plain = a.knockX;
    const b = spawnBoss();
    applyKnockback(b, 1, 0, 1, { source: 'ram', boneGain: 4 });
    check('...and it does not move the boss any further', Math.abs(b.knockX - plain) < 1e-6,
      `${plain.toFixed(3)} either way`);
  }
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
  // A HAIR OVER A TENTH, and the epsilon is the whole reason this line has a
  // comment. `share / (critMul * 10)`, added up ten times and multiplied back
  // by critMul, is share in exact arithmetic and share minus a ULP in floats —
  // ejectChum's `taken - paid >= share` then pays nothing and the check below
  // reads as a broken payout. Which side of the line the sum lands on depends
  // on the boss's hp, so every edit to the bossShark row in enemies.csv was a
  // coin toss on this test. The epsilon is far below anything a fight could
  // notice and far above a ULP, so the intent — exactly one share of damage,
  // delivered in ten pieces — is unchanged and no longer knife-edged.
  const bite = share * (1 + 1e-9) / (CONFIG.hotSpots.critMul * 10);
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
    // ...AND THE PIECE IS SLOWING THE WHOLE TIME IT DRAWS THE TRAIL, which is
    // the half this used to leave out. Multiplying the LAUNCH speed by the
    // cadence measures the one gap at the muzzle and calls the whole trail
    // beads: against drag 4.5 the piece is at a quarter of that speed a third
    // of a second later, and the blobs are stacked on top of each other by
    // then. What matters is where the beading is, not that the first pair is
    // apart — and the first pair is thrown from INSIDE the boss.
    //
    // So the gap is walked forward with the piece and the answer is a
    // distance: how far it has travelled by the time consecutive blobs overlap.
    // Under the body's own reach, the whole visible trail is a line.
    const every = tr.every ?? 0;
    let v = M.tossSpeed ?? 0;
    let travelled = 0;
    let beadedUntil = 0;
    for (let i = 0; i < 400 && v > (M.settleSpeed ?? 0); i++) {
      const step = (v / drag) * (1 - Math.exp(-drag * every)); // distance to the next blob
      if (step >= splat) beadedUntil = travelled + step;
      travelled += step;
      v *= Math.exp(-drag * every);
    }
    check('...and its blobs land close enough together to fuse into a line',
      splat > 0 && every > 0 && beadedUntil < e.radius,
      `blobs overlap after ${beadedUntil.toFixed(1)} units, inside the body's own ${e.radius.toFixed(1)}`
      + ` — splat radius ${splat.toFixed(2)}, ${(1 / every).toFixed(0)} blobs/s`);
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
