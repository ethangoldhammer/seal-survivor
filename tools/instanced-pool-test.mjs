#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:instancing
//
// The chum orbs are drawn from an instance buffer rather than as 140 separate
// meshes (systems/instancedPool.js). That swap is invisible in every way that
// normally shows up in a test — the orb objects are the same Meshes, at the
// same positions, in the same array — and visible only in what reaches the
// GPU. So this checks the buffer.
//
// The failure it exists for is the swap-remove: releasing an orb from the
// middle of a pile moves the last one down into its slot, and if that mesh
// isn't told where it went, the next release corrupts a slot belonging to
// somebody else. On screen that is one orb of a settled pile teleporting to
// another orb's position — rare, silent, and impossible to reproduce on
// demand.
//
//   node --import ./tools/vite-loader.mjs tools/instanced-pool-test.mjs
// ---------------------------------------------------------------------------

import '../tools/dom-stub.mjs';
import * as THREE from 'three';
import { createInstancedPool } from '../path/src/systems/instancedPool.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// Two geometries, because the real pool is fed a random variant per spawn and
// has to split them across separate InstancedMeshes — one draw per shape is
// the entire point, and a pool that quietly put them in one would render every
// orb as the same stone.
const geoA = new THREE.IcosahedronGeometry(0.3, 1);
const geoB = new THREE.IcosahedronGeometry(0.4, 1);
const material = new THREE.MeshBasicMaterial({ vertexColors: true });

const scene = new THREE.Scene();
const pool = createInstancedPool(scene, 'test');

const make = (geo, x, y) => {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, 0);
  return m;
};

// Where the buffer thinks an instance is, as opposed to where the mesh is.
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
function instanceAt(mesh) {
  const inst = scene.children.find((c) => c.isInstancedMesh && c.geometry === mesh.geometry);
  if (!inst) return null;
  for (let i = 0; i < inst.count; i++) {
    inst.getMatrixAt(i, _m);
    _v.setFromMatrixPosition(_m);
    if (_v.distanceTo(mesh.position) < 1e-6) return i;
  }
  return null;
}

// ===========================================================================
section('One draw per shape');

const a = [];
for (let i = 0; i < 5; i++) a.push(pool.acquire(make(geoA, i, 0)));
for (let i = 0; i < 3; i++) a.push(pool.acquire(make(geoB, i, 5)));
pool.flush();

const instanced = scene.children.filter((c) => c.isInstancedMesh);
check('two geometries make two InstancedMeshes', instanced.length === 2, `${instanced.length}`);
check('and eight orbs make eight instances, not eight draws',
  pool.stats().instances === 8 && pool.stats().draws === 2,
  `${pool.stats().instances} instances in ${pool.stats().draws} draws`);
check('nothing loose was added to the scene',
  scene.children.every((c) => c.isInstancedMesh), `${scene.children.length} children`);

// ===========================================================================
section('The buffer follows the meshes');

a[0].position.set(-9, 3, 0);
a[0].scale.setScalar(2.5);
a[0].rotation.z = 1.1;
pool.flush();
const inst = scene.children.find((c) => c.isInstancedMesh && c.geometry === geoA);
inst.getMatrixAt(a[0].userData.__poolSlot, _m);
_v.setFromMatrixPosition(_m);
check('a moved orb moves in the buffer', _v.distanceTo(a[0].position) < 1e-6,
  `buffer ${_v.x.toFixed(2)},${_v.y.toFixed(2)} vs mesh ${a[0].position.x},${a[0].position.y}`);
const scl = new THREE.Vector3().setFromMatrixScale(_m);
check('and so does a chewed one shrinking', Math.abs(scl.x - 2.5) < 1e-5, `scale ${scl.x.toFixed(3)}`);

// ===========================================================================
section('Swap-remove keeps every slot honest');

// Take one from the MIDDLE, which is what a player swimming through a pile
// does. The last instance is moved down into the hole.
const victim = a[1];
const moved = a[4]; // currently last of the geoA group
pool.release(victim);
pool.flush();

check('the released orb is gone from the buffer', instanceAt(victim) === null);
check('the orb that moved into its slot knows it did',
  moved.userData.__poolSlot === instanceAt(moved),
  `thinks ${moved.userData.__poolSlot}, is at ${instanceAt(moved)}`);
check('and the count came down', pool.stats().instances === 7, `${pool.stats().instances}`);

// Now release the moved one THROUGH its recorded slot. With a stale slot this
// releases somebody else and leaves a ghost — the whole reason for this file.
pool.release(moved);
pool.flush();
check('releasing it again takes the right orb', instanceAt(moved) === null);
const survivors = [a[0], a[2], a[3]];
let intact = 0;
for (const m of survivors) if (instanceAt(m) !== null) intact++;
check('and leaves every survivor where it was', intact === survivors.length,
  `${intact}/${survivors.length} still in the buffer`);

// ===========================================================================
section('Growth past the starting capacity');

const many = [];
for (let i = 0; i < 200; i++) many.push(pool.acquire(make(geoA, i * 0.1, -8)));
pool.flush();
const grown = scene.children.find((c) => c.isInstancedMesh && c.geometry === geoA);
check('the group grew to hold them all', grown.count === 203, `count ${grown.count}`);
check('and the buffer is big enough to be read',
  grown.instanceMatrix.array.length >= grown.count * 16,
  `${grown.instanceMatrix.array.length / 16} slots for ${grown.count}`);
let placed = 0;
for (const m of many) if (instanceAt(m) !== null) placed++;
check('every orb survived the regrow', placed === many.length, `${placed}/${many.length}`);

// ===========================================================================
section('A group that empties is dropped');

for (const m of many) pool.release(m);
for (const m of survivors) pool.release(m);
pool.flush();
check('the emptied geometry no longer draws',
  !scene.children.some((c) => c.isInstancedMesh && c.geometry === geoA),
  `${pool.stats().draws} draw(s) left`);
check('the other shape is untouched', pool.stats().instances === 3, `${pool.stats().instances}`);

pool.reset();
check('reset clears the scene', scene.children.length === 0, `${scene.children.length} children`);

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
