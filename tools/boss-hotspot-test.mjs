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
import {
  initBossHotSpots, attachHotSpots, updateBossHotSpots, hotSpotDamage,
  hotSpotsOf, resetBossHotSpots, perimeterCandidates, liveHotSpotCount,
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

// The silhouette test, written out here rather than imported, so the harness
// is not grading the placer against the placer's own idea of "outside".
//
// `pad` is the same inflation every contact lands on (CONFIG.hitShape.padding)
// — a spot placed on the raw flesh while hits report points on the padded
// surface would sit a few percent inside the boundary the player shoots at.
function onOutline(e, x, y) {
  const pad = CONFIG.hitShape.padding ?? 1;
  const spheres = hitShapeSpheres(e.hitShape);
  let onSome = false;
  for (const s of spheres) {
    const r = s.wr * pad;
    const d = Math.hypot(x - s.wx, y - s.wy);
    // Inside another sphere by more than the seam tolerance the placer uses:
    // buried, not on the outline.
    if (d < r * 0.99) return false;
    if (Math.abs(d - r) < r * 0.02) onSome = true;
  }
  return onSome;
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
  const off = cands.filter((c) => !onOutline(e, c.wx, c.wy)).length;
  check('every candidate is on the outline and inside no other sphere', off === 0,
    `${off} of ${cands.length} buried`);

  const owner = lightUp(e);
  const n = owner.spots.length;
  check('rolled a count inside the CSV\'s range',
    n >= CONFIG.hotSpots.countMin && n <= CONFIG.hotSpots.countMax,
    `${n} spots, range ${CONFIG.hotSpots.countMin}-${CONFIG.hotSpots.countMax}`);

  const buried = owner.spots.filter((s) => !onOutline(e, s.wx, s.wy));
  check('every spot sits on the outline', buried.length === 0,
    `${buried.length} of ${n} buried in the body`);

  // BIG ENOUGH TO AIM AT, on the animal the player actually meets. This is the
  // check that caught the placer sizing spots off a single fitted sphere: a
  // megalodon's biggest is about 1.9 units against a body whose reach is 5, so
  // every spot clamped to minRadius and radiusFrac did nothing. A number
  // pinned at its own clamp is a number that is not being used.
  const biggest = Math.max(...spheres.map((s) => s.wr));
  const pinned = owner.spots.filter((s) => s.r <= (CONFIG.hotSpots.minRadius ?? 0.8) * 1.001).length;
  check('none of them is pinned at the size floor', pinned === 0,
    `${pinned} at minRadius ${CONFIG.hotSpots.minRadius}; biggest sphere r ${biggest.toFixed(2)}`);
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

  const stillOut = owner.spots.filter((s) => onOutline(e, s.wx, s.wy));
  check('and they are still on the outline after a turn and a tail-beat',
    stillOut.length === owner.spots.length,
    `${stillOut.length} of ${owner.spots.length} on the edge`);

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

  // The vertex shader sizes the quad at `r * 2.2` across its half-width, and
  // the fragment shader puts the boundary at `uEdge` of that. Multiply the two
  // and the drawn edge has to land on the radius the crit test uses.
  const quadHalf = 2.2;
  const drawn = s.r * quadHalf * (CONFIG.hotSpots.look.edge ?? 0.46);
  const err = Math.abs(drawn - s.r) / s.r;
  check('the drawn edge lands on the crit radius', err < 0.02,
    `drawn ${drawn.toFixed(3)} vs reach ${s.r.toFixed(3)} (${(err * 100).toFixed(1)}% apart)`);

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
    check('the replacement is on the outline too', onOutline(e, fresh.wx, fresh.wy));
    check('and it is not where the old one was',
      Math.hypot(fresh.wx - where.x, fresh.wy - where.y) > fresh.r,
      `${Math.hypot(fresh.wx - where.x, fresh.wy - where.y).toFixed(2)} away`);
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
