#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:shotpool
//
// The pellets are drawn from an instance buffer rather than as one Mesh each
// (entities/projectiles.js). The reason is in the phone runs: draws per frame
// tracked the player's LEVEL rather than the creature count — multishot,
// rapidFire and projectileAmount all multiply the number in the air — climbing
// from ~100 draws at level 1 to a sustained 3184 at level 16 with sixty-one
// enemies alive, while the frame rate fell from 57fps to 22.
//
// WHAT THIS IS ACTUALLY GUARDING, because "does it batch" is the easy half:
//
//   1. A shot that leaves the water must give its slot back. A pellet released
//      from the scene but not from the buffer is drawn at the place it died
//      for the rest of the run — and it is the ONE case where the bug is
//      invisible in every list the game keeps, because `projectiles` is
//      already correct.
//
//   2. A shot that gets DRESSED after it was acquired must go back into the
//      scene. systems/finLaser.js parents a glow Sprite onto its bolt and
//      re-picks the material as the charge builds, both after spawnProjectile
//      has returned. An instanced mesh is not in the scene graph, so that
//      Sprite renders nowhere and the swapped material is never the one drawn:
//      the bolt still flies and still hits, wearing none of it, and nothing
//      throws. That is the failure this file exists for.
//
//   node --import ./tools/vite-loader.mjs tools/shot-instancing-test.mjs
// ---------------------------------------------------------------------------

import '../tools/dom-stub.mjs';
import * as THREE from 'three';
import {
  projectiles, spawnProjectile, despawn, resetProjectiles,
  flushProjectileInstances, projectileInstanceStats,
} from '../path/src/entities/projectiles.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const scene = new THREE.Scene();

/** One pellet, the way the gun fires it. */
function fire(x = 0, y = 0, asset) {
  spawnProjectile(scene, {
    origin: new THREE.Vector3(x, y, 0),
    dir: new THREE.Vector3(1, 0, 0),
    faction: 'player',
    damage: 1,
    speed: 10,
    life: 5,
    radius: 0.2,
    asset,
  });
  return projectiles[projectiles.length - 1];
}

/** Every InstancedMesh the pool has put in the scene. */
const instancedMeshes = () => scene.children.filter((c) => c.isInstancedMesh);
/** Meshes sitting in the scene the old way — one draw each. */
const looseMeshes = () => scene.children.filter((c) => c.isMesh && !c.isInstancedMesh);

// ===========================================================================
section('A volley costs draws per SHAPE, not per shot');

const VOLLEY = 40;
for (let i = 0; i < VOLLEY; i++) fire(i * 0.1, 0);
flushProjectileInstances(scene);

const stats = projectileInstanceStats();
check('every pellet went into the buffer', stats.instances === VOLLEY,
  `${stats.instances}/${VOLLEY}`);
check('and none of them is a scene mesh of its own', looseMeshes().length === 0,
  `${looseMeshes().length} loose`);
// getRockGeometry hands out one of a handful of pre-built variants per spawn,
// so the draw count is bounded by the variant count and NOT by the volley.
// Asserting the exact number would be asserting CONFIG.rocks.variants, which
// is a look setting somebody is free to move; the claim worth making is that
// it does not scale with how many were fired.
check('draws are far below the shot count', stats.draws > 0 && stats.draws <= VOLLEY / 4,
  `${stats.draws} draw(s) for ${VOLLEY} shots`);

const drawn = instancedMeshes().reduce((n, m) => n + m.count, 0);
check('the buffers hold every live shot', drawn === VOLLEY, `${drawn}/${VOLLEY}`);

// ===========================================================================
section('A shot that leaves the water gives its slot back');

// From the MIDDLE, which is the swap-remove the pool does internally and the
// one place a slot can be corrupted — see tools/instanced-pool-test.mjs.
despawn(scene, 10);
despawn(scene, 3);
flushProjectileInstances(scene);
check('the buffer shrank with the list',
  projectileInstanceStats().instances === projectiles.length,
  `${projectileInstanceStats().instances} held, ${projectiles.length} alive`);
check('and nothing was left drawn behind it',
  instancedMeshes().reduce((n, m) => n + m.count, 0) === projectiles.length);

// Every surviving pellet is still drawn where its mesh actually is. A slot
// that went to the wrong shot reads on screen as one pellet of a volley
// teleporting onto another, which no list in the game would show.
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
let misplaced = 0;
for (const p of projectiles) {
  const holder = instancedMeshes().find((im) => im.geometry === p.mesh.geometry);
  if (!holder) { misplaced++; continue; }
  holder.getMatrixAt(p.mesh.userData.__poolSlot, _m);
  _v.setFromMatrixPosition(_m);
  if (_v.distanceTo(p.mesh.position) > 1e-5) misplaced++;
}
check('every survivor is drawn where its mesh is', misplaced === 0, `${misplaced} misplaced`);

// ===========================================================================
section('A shot dressed after it was fired goes back into the scene');

resetProjectiles(scene);
const bolt = fire(0, 0);
flushProjectileInstances(scene);
check('it starts out instanced', !!bolt.mesh.userData.__poolKey);

// What finLaser's dressBolt does to a bolt already in the air.
bolt.mesh.add(new THREE.Object3D());
flushProjectileInstances(scene);
check('growing a child puts it back in the scene',
  !bolt.mesh.userData.__poolKey && bolt.mesh.parent === scene);
check('and it is no longer counted as an instance',
  projectileInstanceStats().instances === 0,
  `${projectileInstanceStats().instances}`);

// The other half of dressBolt: the material it renders with is re-picked as
// the charge builds, and the pool draws a whole group with ONE material.
resetProjectiles(scene);
const swapped = fire(0, 0);
flushProjectileInstances(scene);
swapped.mesh.material = new THREE.MeshBasicMaterial();
flushProjectileInstances(scene);
check('swapping the material puts it back in the scene',
  !swapped.mesh.userData.__poolKey && swapped.mesh.parent === scene);

// ===========================================================================
section('A run ending clears the buffers');

resetProjectiles(scene);
check('no instances are held', projectileInstanceStats().instances === 0);
check('and no InstancedMesh is left in the scene', instancedMeshes().length === 0,
  `${instancedMeshes().length} left`);

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
