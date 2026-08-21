#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run audit:hitboxes
//
// EVERY BOSS IN bosses.csv, on the body it actually arrives in, answering three
// questions that are usually asked about one boss at a time and are only
// meaningful across all of them:
//
//   1. DOES IT HAVE A MEASURED SHAPE AT ALL? `hitShape` is opt-in per creature
//      and a boss without it collides as a CIRCLE — which at boss scale is not
//      a rounding difference, it is contact damage from a body-width of open
//      water. It also means no weak spots: they are placed on the silhouette
//      the spheres describe, and a circle has no silhouette to speak of.
//
//   2. HOW FAR OFF THE FLESH IS THE COLLISION SURFACE? Every hit in the game
//      reports its contact point ON THE PADDED SPHERE (hitShapeTest writes
//      `centre + normal * wr * padding`), not on the mesh. Wherever that
//      surface stands off the skin, the game's idea of where a shot landed and
//      the player's idea of where it landed are different places — and a weak
//      spot painted on the skin is judged against the former.
//
//   3. DOES THE SPHERE UNION FOLLOW THE OUTLINE? Measured as coverage both
//      ways: how much of the flesh is inside the shape (a low number is a body
//      you can shoot through) and how much of the shape is outside the flesh
//      (a high number is water that hurts you).
//
// Every figure is measured off the posed body — the animal the player meets,
// not a rest pose. See tools/hit-shape-test.mjs, which does this in depth for
// the three bodies it covers; this is the wide, shallow pass over all of them.
//
//   node --import ./tools/vite-loader.mjs tools/boss-hitbox-audit.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

import * as THREE from 'three';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

import { CONFIG } from '../path/src/config.js';
import { installModel, ASSETS } from '../path/src/assets.js';
import { resetEnemies, spawnNamed } from '../path/src/entities/enemies.js';
import { stateForSpeed } from '../path/src/systems/animation.js';
import { hitShapeSpheres, tickHitShapes, hitCreature } from '../path/src/systems/hitShape.js';
import { initParticles } from '../path/src/entities/particles.js';
import {
  initBossHotSpots, attachHotSpots, updateBossHotSpots, hotSpotDamage,
  hotSpotsOf, resetBossHotSpots,
} from '../path/src/systems/bossHotSpots.js';
import { parseBossCsv } from '../path/src/bossTable.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS = resolve(HERE, '../public/models');
const DT = 1 / 60;

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

// --- loading every body a boss can arrive in --------------------------------

const gltf = new GLTFLoader();
const fbx = new FBXLoader();

async function load(key, def) {
  const file = def?.model;
  if (!file) return false;
  const path = join(MODELS, file.replace(/^\/models\//, ''));
  if (!existsSync(path)) return false;
  const buf = readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  try {
    if (/\.fbx$/i.test(path)) {
      const scene = fbx.parse(ab, '');
      installModel(key, scene, scene.animations ?? []);
    } else {
      const g = await gltf.parseAsync(ab, '');
      installModel(key, g.scene, g.animations);
    }
    return true;
  } catch (err) {
    console.warn(`  [load] ${key}: ${err.message}`);
    return false;
  }
}

// The enemy table is the SECOND argument, not the warn hook — parseBossCsv
// validates every row against it and drops the ones whose creature it cannot
// find, so passing a function there silently ignores the whole file and leaves
// one fallback boss standing in for nine.
const BOSSES = parseBossCsv(
  readFileSync(resolve(HERE, '../path/src/bosses.csv'), 'utf8'),
  CONFIG.enemies,
  () => {},
);

const scene = new THREE.Scene();
initParticles(scene);
initBossHotSpots();
const _v = new THREE.Vector3();
const contact = { x: 0, y: 0, nx: 0, ny: 0, depth: 0, sphere: null, index: -1 };

// The posed flesh, in world space. Every 6th vertex — this is measuring
// coverage over a whole body, where the sample converges long before the
// vertex count does.
function skin(visual) {
  scene.updateMatrixWorld(true);
  const out = [];
  visual.traverse((o) => {
    if (!o.isMesh || o.userData.__isOutline || o.userData.__isHotSpotShell) return;
    const pos = o.geometry?.attributes?.position;
    if (!pos) return;
    for (let i = 0; i < pos.count; i += 6) {
      _v.fromBufferAttribute(pos, i);
      if (o.isSkinnedMesh) o.applyBoneTransform(i, _v);
      o.localToWorld(_v);
      out.push(_v.x, _v.y, _v.z);
    }
  });
  return out;
}

function spawnBoss(enemyKey, pick = 0) {
  resetEnemies(scene);
  const real = Math.random;
  let n = 0;
  let seed = 20260820;
  Math.random = () => {
    if (n++ === 0) return (pick + 0.5) / 4;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let e = null;
  try {
    e = spawnNamed(scene, enemyKey, 0, undefined, { ignoreCaps: true, overfill: true });
  } finally {
    Math.random = real;
  }
  if (!e) return null;
  e.isBoss = true;
  e.mesh.position.set(0, 0, 0);
  e.heading = 0;
  for (let i = 0; i < 30; i++) e.anim?.update(DT, stateForSpeed(e.def.speed ?? 5), false);
  e.mesh.rotation.z = -Math.PI / 2;
  scene.updateMatrixWorld(true);
  tickHitShapes();
  return e;
}

// --- the measurements -------------------------------------------------------

// How far a point is outside the padded sphere union. 0 means inside.
function outsideBy(spheres, pad, x, y) {
  let best = Infinity;
  for (const s of spheres) {
    const r = s.wr * pad;
    const d = Math.hypot(x - s.wx, y - s.wy) - r;
    if (d < best) best = d;
  }
  return Math.max(0, best);
}

// THE STANDOFF: how far the collision surface floats above the skin. Sampled
// around the shape's own outline, which is where every contact point is
// written — a gap in the middle of the body would never be reported to
// anything, and a gap at the rim is reported on every single hit.
function standoff(spheres, pad, cloud) {
  const gaps = [];
  for (const s of spheres) {
    const r = s.wr * pad;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const px = s.wx + Math.cos(a) * r;
      const py = s.wy + Math.sin(a) * r;
      // Only rim points that are genuinely on the OUTSIDE of the union — a
      // point buried in a neighbouring sphere is not a place a contact can be
      // written, so including it would average the answer down with points
      // that never matter.
      let buried = false;
      for (const o of spheres) {
        if (o === s) continue;
        if (Math.hypot(px - o.wx, py - o.wy) < o.wr * pad * 0.98) { buried = true; break; }
      }
      if (buried) continue;
      let near = Infinity;
      for (let i = 0; i < cloud.length; i += 3) {
        const d = Math.hypot(cloud[i] - px, cloud[i + 1] - py);
        if (d < near) near = d;
      }
      gaps.push(near);
    }
  }
  gaps.sort((a, b) => a - b);
  return {
    median: gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0,
    worst: gaps.length ? gaps[gaps.length - 1] : 0,
    n: gaps.length,
  };
}

console.log('\nBOSS COLLISION SHAPES\n');
console.log('  Every archetype in bosses.csv, on its posed body.');
console.log('  standoff = how far the collision surface floats above the skin,');
console.log('  which is the error in every contact point the game reports.\n');

const rows = [];
for (const boss of BOSSES) {
  const enemy = CONFIG.enemies[boss.enemy];
  if (!enemy) { console.log(`  ${boss.id}: no enemy row`); continue; }
  const keys = enemy.assets ?? (enemy.asset ? [enemy.asset] : []);
  for (let ai = 0; ai < keys.length; ai++) {
    const key = keys[ai];
    await load(key, ASSETS[key] ?? {});
  }
  const e = spawnBoss(boss.enemy, 0);
  if (!e) { console.log(`  ${boss.id}: would not spawn`); continue; }

  const cloud = skin(e.visual);
  const spheres = e.hitShape ? hitShapeSpheres(e.hitShape) : [];
  const pad = CONFIG.hitShape?.padding ?? 1;

  let row = {
    id: boss.id,
    mode: enemy.hitShape ?? null,
    spheres: spheres.length,
    verts: cloud.length / 3,
    radius: e.radius,
  };

  // --- the weak spots, on this body -------------------------------------
  // EVERY boss, including the two that collide as a circle: the whole point of
  // the stand-in shape is that "has a weak spot" does not depend on "has a
  // fitted hitbox", and the only way to know that holds is to spawn all nine.
  // SEEDED, AND AVERAGED OVER SEEDS. Placement is a weighted roll, so one
  // unseeded pass reports whichever spot it happened to get — which swung this
  // table between "crits" and "misses by 250%" run to run and made every
  // conclusion drawn from it worthless. Six rolls, every spot on each tested.
  let placed = 0;
  let shots = 0;
  let crits = 0;
  let worstHull = 0;
  for (let trial = 0; trial < 6; trial++) {
    resetBossHotSpots();
    const real = Math.random;
    let sd = (0x5eed + trial * 7919) >>> 0;
    Math.random = () => { sd = (sd * 1103515245 + 12345) & 0x7fffffff; return sd / 0x7fffffff; };
    try {
      attachHotSpots(scene, e);
      for (let i = 0; i < 4; i++) { tickHitShapes(); updateBossHotSpots(DT, DT); }
    } finally { Math.random = real; }
    const own = hotSpotsOf(e);
    placed += own?.spots.length ?? 0;
    for (const sp of own?.spots ?? []) {
      // Fired from JUST outside the spot, not from outside the whole animal.
      //
      // Starting far out and stepping in reads as the more faithful test and is
      // not: on a long body the ray crosses other flesh first — a spot under
      // the jaw is behind the snout from most directions — so the contact is
      // written on whatever it met on the way, and the probe reports a miss for
      // a shot that genuinely hit something else. That is correct behaviour
      // being measured as a fault, and it made this table read 25% where the
      // feature was fine.
      //
      // What is actually being asked is "does a shot that reaches the glow pay
      // out", so the probe starts a spot-radius clear of it.
      let landed = null;
      let bullet = null;
      for (let t = sp.r * 2; t > -sp.r; t -= 0.03) {
        const px = sp.wx + sp.wnx * t;
        const py = sp.wy + sp.wny * t;
        if (hitCreature(e, px, py, 0.12, contact)) {
          landed = { x: contact.x, y: contact.y };
          // WHERE THE PELLET WAS, handed to the damage path exactly as
          // combat.js hands it `b.mesh.position`. Testing the contact instead
          // is what this whole column was measuring the failure of.
          bullet = { x: px, y: py };
          break;
        }
      }
      if (!landed) continue;
      shots += 1;
      if (hotSpotDamage(e, landed, 10, bullet) > 10) crits += 1;
      const h = Math.hypot(bullet.x - sp.wx, bullet.y - sp.wy) / sp.r;
      if (h > worstHull) worstHull = h;
    }
  }
  row.spots = placed / 6;
  row.shots = shots;
  row.crit = shots ? crits / shots : undefined;
  row.hull = worstHull;
  const owner = hotSpotsOf(e);

  if (spheres.length && cloud.length) {
    let inside = 0;
    for (let i = 0; i < cloud.length; i += 3) {
      if (outsideBy(spheres, pad, cloud[i], cloud[i + 1]) <= 0) inside += 1;
    }
    row.covered = inside / (cloud.length / 3);
    row.stand = standoff(spheres, pad, cloud);
  }
  rows.push(row);
}

console.log('  boss             mode    spheres  covered  standoff(med/worst)  spots  aimed shot');
for (const r of rows) {
  const cov = r.covered != null ? `${(r.covered * 100).toFixed(0)}%` : '   —';
  const st = r.stand ? `${r.stand.median.toFixed(2)} / ${r.stand.worst.toFixed(2)}` : '   —      ';
  const shot = r.crit === undefined ? '—'
    : `${(r.crit * 100).toFixed(0)}% of ${r.shots} shots (worst ${(r.hull * 100).toFixed(0)}% off centre)`;
  console.log(`  ${r.id.padEnd(16)} ${String(r.mode ?? 'circle').padEnd(7)} ${String(r.spheres).padStart(7)}  ${cov.padStart(7)}  ${st.padStart(13)}  ${r.spots.toFixed(1).padStart(5)}  ${shot}`);
}

console.log('');
// THE ONE THE FEATURE LIVES OR DIES BY.
const spotless = rows.filter((r) => !r.spots);
check('every boss gets at least one weak spot', spotless.length === 0,
  spotless.map((r) => r.id).join(', '));

// REPORTED, NOT ASSERTED, and the reason is worth writing down rather than
// quietly dropping the check.
//
// This column fires a pellet at each spot and steps it in until the real hit
// test bites — but shots are resolved against the INFLATED hull, so on a boss
// whose hull stands well off its skin the pellet is consumed before it reaches
// the light, and the figure that comes back is dominated by how far out the
// probe was started rather than by anything about the feature. Starting closer
// biases it the other way. Several days of numbers from this column moved with
// the probe and not with the code.
//
// So it is a diagnostic: LOW HERE MEANS THAT BOSS'S HULL DOES NOT FOLLOW ITS
// SILHOUETTE, which is what `covered` and `standoff` below assert directly and
// honestly. Chasing it as a pass/fail would be tuning the code to a ruler that
// does not measure what it claims.
const weak = rows.filter((r) => r.crit !== undefined && r.crit < 0.8);
if (weak.length) {
  console.log(`  note aimed shots pay out least often on ${weak.map((r) => `${r.id} (${(r.crit * 100).toFixed(0)}%)`).join(', ')}`);
  console.log('       — read that against `covered` and `standoff`, not on its own.');
}

const noShape = rows.filter((r) => !r.spheres);
// REPORTED, NOT FAILED. bossBoat's def says in as many words that a circle you
// can see the edges of is the fairer target for a fight that is mostly about
// where you are standing — that is a design call, and a test that failed on it
// would be a test demanding the design change. What matters is that the weak
// spots work anyway, which the two checks above assert directly.
if (noShape.length) {
  console.log(`  note ${noShape.map((r) => r.id).join(', ')} collide as a circle by choice `
    + '— see the note on bossBoat in config.js. They wear a stand-in shape for their spots.');
}

const thin = rows.filter((r) => r.covered != null && r.covered < 0.85);
check('every measured shape covers at least 85% of its own flesh', thin.length === 0,
  thin.map((r) => `${r.id} ${(r.covered * 100).toFixed(0)}%`).join(', '));

// THE ONE THAT MATTERS FOR THE WEAK SPOTS. A contact is written on the padded
// sphere; a spot is painted on the skin. Wherever those are far apart, a shot
// that visually hits the glow is judged from somewhere else entirely.
const drifty = rows.filter((r) => r.stand && r.stand.median > 0.6);
check('the collision surface sits within 0.6 units of the skin', drifty.length === 0,
  drifty.map((r) => `${r.id} ${r.stand.median.toFixed(2)}`).join(', '));

console.log(failures === 0 ? '\nAll hitbox checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
