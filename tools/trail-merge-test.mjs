#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:ribbons
//
// The ribbons behind projectiles are MERGED — one mesh per ribbon length,
// several trails writing disjoint slices of one buffer — rather than a Mesh
// each (systems/projectileTrails.js). The reason is the phone runs: draws per
// frame tracked the player's LEVEL rather than the creature count, climbing
// from ~100 at level 1 to a sustained 3184 at level 16 with sixty-one enemies
// in the water, while the frame rate fell from 57fps to 22. Once the pellets
// went into an instance buffer the ribbons were the larger half of what was
// left, and they cannot go into one: an InstancedMesh draws one geometry many
// times, and every ribbon rewrites its own vertices every frame.
//
// WHAT THIS IS GUARDING, and none of it is "does it batch":
//
//   1. THE SWAP-REMOVE. A retiring ribbon's slot is filled by the last one,
//      and its VERTICES have to travel with it — the frame's writes have
//      already happened by the time the dead ones are swept, so a ribbon that
//      merely learned its new index would be drawn from whatever the dead one
//      left behind until its own next update. On screen: one shot's streak
//      flicking onto another's path for a frame. Nothing throws, and it does
//      not reproduce on demand.
//
//   2. THE Z. It used to be `mesh.position.z` and is now baked per vertex,
//      because one merged mesh cannot be both the pebble's -0.02 and the
//      mussel's clearance behind its own shell. The material writes no depth
//      but still TESTS it, so getting this wrong is a shell that stops
//      occluding its own trail — a look bug with no error attached.
//
//   3. THE DRAW RANGE. Retired slots are left in the buffer and simply not
//      reached. A range that did not follow the live count would keep drawing
//      dead ribbons at the positions they died on for the rest of the run.
//
//   node --import ./tools/vite-loader.mjs tools/trail-merge-test.mjs
// ---------------------------------------------------------------------------

import '../tools/dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import {
  updateProjectileTrails, clearProjectileTrails, trailCount, trailDrawCount,
} from '../path/src/systems/projectileTrails.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const scene = new THREE.Scene();

// A "mover" is the smallest contract the file takes: { mesh, dir, speed }. The
// mesh's NAME is what picks the preset, so these are real preset keys.
function mover(asset, x, y) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.2, 0.2, 0.2),
    new THREE.MeshBasicMaterial(),
  );
  mesh.name = asset;
  mesh.position.set(x, y, 0);
  return { mesh, dir: new THREE.Vector3(1, 0, 0), speed: 10 };
}

/** Every trail mesh the system has put in the scene. */
const trailMeshes = () => scene.children.filter((c) => c.name?.startsWith('trails:'));

// ===========================================================================
section('A volley of one preset costs ONE draw, whatever its size');

const VOLLEY = 40;
const shots = [];
for (let i = 0; i < VOLLEY; i++) shots.push(mover('bullet', i * 0.1, 0));
// Two frames: the first allocates the slots, the second gives every ribbon a
// second point of history so it is a ribbon rather than a degenerate.
updateProjectileTrails(0.016, scene, shots);
for (const s of shots) s.mesh.position.x += 0.16;
updateProjectileTrails(0.016, scene, shots);

check('every shot has a ribbon', trailCount() === VOLLEY, `${trailCount()}/${VOLLEY}`);
check('and they cost one draw between them', trailDrawCount() === 1, `${trailDrawCount()}`);
check('one mesh in the scene, not forty', trailMeshes().length === 1,
  `${trailMeshes().length}`);

const merged = trailMeshes()[0];
const pts = Math.max(2, Math.round(CONFIG.trails.bullet.points));
check('the draw range covers exactly the live ribbons',
  merged.geometry.drawRange.count === VOLLEY * (pts - 1) * 6,
  `${merged.geometry.drawRange.count} indices for ${VOLLEY} ribbons of ${pts} points`);

// ===========================================================================
section('Two ribbon LENGTHS are two meshes, and neither is in the other');

// bullet is 8 points, missile is 16 — a slot size cannot be shared, so these
// have to be separate buffers. Sharing them would put a missile's vertices
// inside a pebble's slot, which draws as a streak of the wrong length.
const rocket = mover('missile', 5, 5);
updateProjectileTrails(0.016, scene, shots, [rocket]);
rocket.mesh.position.x += 0.2;
updateProjectileTrails(0.016, scene, shots, [rocket]);
check('a second length adds a second draw', trailDrawCount() === 2, `${trailDrawCount()}`);
check('and both are in the scene', trailMeshes().length === 2, `${trailMeshes().length}`);

// ===========================================================================
section('A ribbon that retires takes its vertices with it, not somebody else\'s');

// The LAST slot's ribbon is the one the swap moves, so retiring one from the
// middle is the case that can corrupt it. Its shot is parked far from the
// others so a stale block is unmistakable rather than plausible.
// Flown out there for a full ribbon's worth of history, so EVERY one of its
// vertices is far — a partly-moved ribbon would make the count below a
// judgement call rather than an assertion.
const outlier = shots[VOLLEY - 1];
outlier.mesh.position.set(500, 500, 0);
for (let i = 0; i <= pts; i++) {
  outlier.mesh.position.x += 0.2;
  updateProjectileTrails(0.016, scene, shots, [rocket]);
}

// Retire one from the middle. The outlier's ribbon moves down into its slot.
const retired = shots[5];
const survivors = shots.filter((s) => s !== retired);
updateProjectileTrails(0.016, scene, survivors, [rocket]);

check('the ribbon count followed the movers', trailCount() === survivors.length + 1,
  `${trailCount()} for ${survivors.length + 1} movers`);
check('and the draw range shrank with it',
  merged.geometry.drawRange.count === survivors.length * (pts - 1) * 6,
  `${merged.geometry.drawRange.count}`);

// Every vertex still inside the draw range must belong to a ribbon that is
// still in the water. The outlier is 500 units away, so if its block did NOT
// travel down into the vacated slot, some pebble near the origin is now drawn
// out there — and if it travelled but the buffer did not, the outlier is drawn
// on top of the volley.
const pos = merged.geometry.attributes.position.array;
const live = survivors.length * pts * 2 * 3;
let far = 0;
for (let i = 0; i < live; i += 3) if (Math.abs(pos[i]) > 100) far++;
check('the far ribbon is drawn exactly once, at its own position',
  far === pts * 2, `${far} far vertices, expected ${pts * 2}`);

// ===========================================================================
section('The z is in the vertices, and it is the preset\'s');

// The material tests depth without writing it, so this is what lets an opaque
// shell occlude its own trail. Off the mesh transform it would be one z for
// every ribbon in the group.
const wantZ = CONFIG.trails.bullet.z ?? -0.02;
let wrongZ = 0;
for (let i = 2; i < live; i += 3) if (Math.abs(pos[i] - wantZ) > 1e-6) wrongZ++;
check('every live vertex sits at the preset\'s depth', wrongZ === 0,
  `${wrongZ} of ${live / 3} vertices off ${wantZ}`);
check('and the mesh itself is not carrying it', merged.position.z === 0,
  `${merged.position.z}`);

// ===========================================================================
section('An emptied length stops costing a draw');

updateProjectileTrails(0.016, scene, survivors);
check('the missile\'s buffer is gone with it', trailDrawCount() === 1, `${trailDrawCount()}`);
check('and it left the scene', trailMeshes().length === 1, `${trailMeshes().length}`);

updateProjectileTrails(0.016, scene, []);
check('no movers, no ribbons', trailCount() === 0, `${trailCount()}`);
check('and no draws', trailDrawCount() === 0, `${trailDrawCount()}`);
check('nothing left in the scene', trailMeshes().length === 0, `${trailMeshes().length}`);

// ===========================================================================
section('A group grows past its start capacity without losing anybody');

// RIBBON_START is 8, so this forces two regrows. The live ribbons have to
// survive them: a regrow that dropped its buffer would blank every streak in
// the air on the frame a volley got big enough to trigger one.
const many = [];
for (let i = 0; i < 35; i++) many.push(mover('bullet', i, 3));
updateProjectileTrails(0.016, scene, many);
for (const m of many) m.mesh.position.y += 0.2;
updateProjectileTrails(0.016, scene, many);
const grown = trailMeshes()[0];
check('every ribbon survived the regrows', trailCount() === many.length,
  `${trailCount()}/${many.length}`);
check('the buffer is big enough to be read',
  grown.geometry.attributes.position.array.length >= many.length * pts * 2 * 3);
check('and it is still one draw', trailDrawCount() === 1, `${trailDrawCount()}`);

clearProjectileTrails(scene);
check('clearing takes everything', trailCount() === 0 && trailDrawCount() === 0
  && trailMeshes().length === 0);

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
