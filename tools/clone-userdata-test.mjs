#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:clone
//
// cloneSafe in assets.js — what a spawned body carries away from its template.
//
// THE BUG THIS EXISTS FOR was worth about a gigabyte on the phone and was
// invisible in every other measurement. three.js copies userData on every node
// of a clone with JSON.parse(JSON.stringify(...)), and JSON.stringify does not
// skip an Object3D: it calls toJSON(), which serialises a whole mesh —
// geometry, attributes, materials — into plain arrays. addOutlineShells puts a
// live Mesh on a shell's userData, so every outlined creature was spawning
// with a complete JSON copy of its own geometry attached to it. The phone's
// census named it: 34MB on one node, across eighty-odd bodies.
//
// Nothing about that is visible on screen, in a frame time, or in
// renderer.info — the game looks and plays exactly the same either way. So the
// checks here are about SHAPE: a reference must still be a reference, and it
// must point at the clone's own node rather than the template's.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { cloneSafe } from '../path/src/assets.js';
import { userDataBytes } from '../path/src/systems/memoryCensus.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// A template shaped like a real one: a root carrying the clip array, a mesh
// with a geometry big enough that a JSON copy of it is unmistakable, and a
// shell holding a live reference to that mesh.
function makeTemplate() {
  const root = new THREE.Group();
  root.name = 'root';
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(30_000), 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  mesh.name = 'body';
  mesh.scale.set(2, 2, 2);
  const shell = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  shell.name = 'body__outline';
  shell.userData.__isOutline = true;
  shell.userData.__outlineSource = mesh;
  root.add(mesh);
  root.add(shell);
  root.userData.clips = [{ name: 'swim', tracks: new Array(500).fill(0) }];
  root.userData.rig = { spine: 'spine_01' };
  return { root, mesh, shell, geo };
}

// MEASURED THE WAY systems/memoryCensus.js MEASURES, and with its own meter so
// the two can never drift: a live Object3D is a pointer and costs eight bytes,
// while a JSON CARCASS of one is plain data the node now owns and is counted
// in full. Note that JSON.stringify cannot tell these apart at all — it calls
// toJSON() on the reference before any replacer sees it — which is why this
// takes the census's walker rather than rolling its own.
const udBytes = (o) => userDataBytes(o.userData ?? {});

section('THE REFERENCE STAYS A REFERENCE');
const t = makeTemplate();
const clone = cloneSafe(t.root);
const cloneShell = clone.getObjectByName('body__outline');
const cloneBody = clone.getObjectByName('body');

check('the clone has both nodes', !!cloneShell && !!cloneBody);
check('the shell still knows its source', !!cloneShell.userData.__outlineSource);
check('...and it is an Object3D, not a JSON carcass of one',
  cloneShell.userData.__outlineSource?.isObject3D === true,
  typeof cloneShell.userData.__outlineSource);
check('...pointing at THIS body, not the template it was cloned from',
  cloneShell.userData.__outlineSource === cloneBody);
check('the flag beside it survives too', cloneShell.userData.__isOutline === true);

section('NOTHING WAS SERIALISED');
// The give-away for the old behaviour: a serialised mesh brings its geometry
// with it, so the userData is measured in hundreds of kilobytes rather than in
// bytes. The threshold is generous on purpose — this is separating 34MB from
// nothing, not measuring an overhead.
check('the shell carries no copy of the geometry', udBytes(cloneShell) < 4096, `${udBytes(cloneShell)} bytes owned`);
// The same reading against what three.js would have produced left to itself,
// so the number this test defends is shown rather than asserted.
{
  const carcass = { userData: JSON.parse(JSON.stringify(t.shell.userData)) };
  check('...where three\'s own copy owns a whole serialised mesh', udBytes(carcass) > 100_000,
    `${Math.round(udBytes(carcass) / 1024)}KB on one node`);
}
check('the template is untouched by the clone',
  t.shell.userData.__outlineSource === t.mesh && t.root.userData.clips.length === 1);
check('the clips are shared with the template, not re-parsed',
  clone.userData.clips === t.root.userData.clips);
check('...and so is anything else on the root', clone.userData.rig === t.root.userData.rig);

section('THE GEOMETRY IS STILL SHARED');
check('the clone draws the template geometry rather than a copy',
  cloneBody.geometry === t.geo);

section('A SECOND CLONE IS INDEPENDENT');
const two = cloneSafe(t.root);
check('two clones do not share a shell', two.getObjectByName('body__outline') !== cloneShell);
check('...and each points at its own body',
  two.getObjectByName('body__outline').userData.__outlineSource === two.getObjectByName('body'));
check('a write on one clone does not reach the other',
  (() => { cloneShell.userData.__isOutline = 'changed'; return two.getObjectByName('body__outline').userData.__isOutline === true; })());

// ---------------------------------------------------------------------------
// AND THE SAME THING IN REAL BYTES. Everything above is a measurement of a
// measurement; this is the heap. A hundred bodies is a quiet minute of a run,
// and the phone was holding eighty-odd.
section('WHAT A HUNDRED BODIES COST');
{
  const BODIES = 100;
  const heap = () => { globalThis.gc?.(); return process.memoryUsage().heapUsed; };
  const template = makeTemplate();

  const before = heap();
  const safe = [];
  for (let i = 0; i < BODIES; i++) safe.push(cloneSafe(template.root));
  const safeCost = heap() - before;

  // three.js on its own: the same clone with the userData left in place, which
  // is what every spawn did before cloneSafe walked the children.
  const raw = [];
  const rawBefore = heap();
  for (let i = 0; i < BODIES; i++) raw.push(template.root.clone(true));
  const rawCost = heap() - rawBefore;

  const mb = (n) => (n / 1048576).toFixed(1);
  check(`${BODIES} safe clones cost less than a tenth of what three's own do`,
    safeCost * 10 < rawCost, `${mb(safeCost)}MB vs ${mb(rawCost)}MB`);
  check('...and the saving is worth megabytes, not kilobytes',
    rawCost - safeCost > 20 * 1048576, `${mb(rawCost - safeCost)}MB saved at ${BODIES} bodies`);
  console.log(`  ${mb(rawCost / BODIES * 1024)}KB per body before, ${mb(safeCost / BODIES * 1024)}KB after`);
  if (safe.length !== BODIES || raw.length !== BODIES) failures++;
}

console.log(failures ? `\nFAIL — ${failures} check(s)` : '\nPASS — all checks');
process.exit(failures ? 1 : 0);
