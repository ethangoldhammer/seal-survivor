#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:surfacerest
//
// The seal swims up, stops, and relaxes into a breathing idle.
//
// The headline check is REACHABILITY, because that was the whole bug: the old
// rule (strictly above the waterline, total speed under the move threshold)
// put `surfaceIdle` behind a ~100ms window at the apex of a dead-vertical
// jump, and behind NO window at all once the seal had any sideways drift —
// there is no drag above the surface to bleed it off. Both of those are
// asserted below against the real numbers, so nobody has to take it on trust.
//
// Everything else guards the ways this could go wrong quietly:
//   * it must not relax while merely PASSING the surface (the "and then
//     staying there" half of the request)
//   * it must let go promptly once the seal swims off, or the controls feel
//     laggy rather than the animal feeling calm
//   * the breath must actually move the chest, and must not ratchet
//   * PHYSICS MUST BE UNTOUCHED — aboveSurface still gates gravity and the
//     breach, and this was only ever meant to change what plays.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG } from '../path/src/config.js';
import { bounds } from '../path/src/arena.js';
import { installModel, createVisual } from '../path/src/assets.js';
import { createAnimationController, stateForSpeed, trackCoverage } from '../path/src/systems/animation.js';
import { createBreathDriver } from '../path/src/systems/breathe.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = resolve(HERE, '../public/models/furseal.glb');

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

if (!existsSync(MODEL)) {
  console.error(`\nmissing ${MODEL}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The rest ramp, in isolation. This mirrors the block in updatePlayer rather
// than importing it, because updatePlayer wants a whole world — but it is the
// same arithmetic against the same CONFIG, so a tuning change moves both.
// ---------------------------------------------------------------------------
function makeSeal() {
  return { y: bounds.surfaceY - 6, speed: 0, rest: 0, timer: 0 };
}
function step(s, dt) {
  const c = CONFIG.surfaceRest;
  const atSurface = s.y > bounds.surfaceY - c.band;
  const settled = s.speed < c.speed;
  if (c.enabled !== false && atSurface && settled) s.timer += dt; else s.timer = 0;
  const want = s.timer >= c.settleTime ? 1 : 0;
  const tau = want > s.rest ? c.settleTime : c.releaseTime;
  s.rest += (want - s.rest) * (1 - Math.exp(-dt / Math.max(0.01, tau)));
  if (s.rest < 0.001) s.rest = 0;
  return stateForSpeed(s.speed, false, s.rest);
}

const DT = 1 / 60;

console.log('\nthe old rule: how long surfaceIdle was reachable at all');
{
  // Above the surface the seal is in free fall, so |v| dips under the move
  // threshold only around the apex — and the test is on TOTAL speed.
  const g = CONFIG.arena.gravity;
  const move = CONFIG.animation.moveThreshold;
  const windowFor = (vx) => (vx >= move ? 0 : (2 * Math.sqrt(move * move - vx * vx)) / g);
  check('straight up, it was a fraction of a second', windowFor(0) < 0.2,
    `${(windowFor(0) * 1000).toFixed(0)}ms at the apex`);
  check('with any sideways drift it was unreachable', windowFor(move + 0.1) === 0,
    `0ms once the run exceeds ${move}`);
}

console.log('\nnow: swim up, stop, and it relaxes');
{
  const s = makeSeal();
  s.y = bounds.surfaceY - 0.4; // parked just under the waterline
  s.speed = 0.2;
  let t = 0, gotAt = -1, state = null;
  while (t < 4) {
    state = step(s, DT);
    t += DT;
    if (state === 'surfaceIdle' && gotAt < 0) gotAt = t;
  }
  check('it reaches surfaceIdle', gotAt > 0, `after ${gotAt.toFixed(2)}s of holding still`);
  check('...only after settling, not instantly', gotAt >= CONFIG.surfaceRest.settleTime * 0.9,
    `settleTime is ${CONFIG.surfaceRest.settleTime}s`);
  check('and it STAYS there', state === 'surfaceIdle', `ended in ${state}`);
  check('fully relaxed', s.rest > 0.9, `rest ${s.rest.toFixed(2)}`);
}

console.log('\nit does not relax while merely passing through');
{
  const s = makeSeal();
  let relaxed = false;
  // Rising fast through the surface band and out the other side.
  for (let t = 0; t < 1.5; t += DT) {
    s.y += 12 * DT;
    s.speed = 12;
    if (step(s, DT) === 'surfaceIdle') relaxed = true;
  }
  check('a seal breaching never relaxes', !relaxed);
}

console.log('\nit lets go promptly when the seal swims off');
{
  const s = makeSeal();
  s.y = bounds.surfaceY - 0.4;
  s.speed = 0.2;
  for (let t = 0; t < 3; t += DT) step(s, DT); // settle first
  const settled = s.rest;
  s.speed = 9; // and go
  let releasedAt = -1;
  for (let t = 0; t < 2; t += DT) {
    const st = step(s, DT);
    if (st !== 'surfaceIdle' && releasedAt < 0) releasedAt = t;
  }
  check('it was relaxed first', settled > 0.9, `rest ${settled.toFixed(2)}`);
  check('and drops the pose immediately on moving', releasedAt >= 0 && releasedAt < 0.1,
    `${(releasedAt * 1000).toFixed(0)}ms`);
}

console.log('\nthe swim state is untouched when nowhere near the surface');
{
  const s = makeSeal();
  s.y = bounds.surfaceY - 20;
  s.speed = 8;
  let state = null;
  for (let t = 0; t < 2; t += DT) state = step(s, DT);
  check('deep and moving is still swim', state === 'swim', `got ${state}`);
  s.speed = 0.1;
  for (let t = 0; t < 3; t += DT) state = step(s, DT);
  check('deep and still is still idle, not surfaceIdle', state === 'idle', `got ${state}`);
}

// ---------------------------------------------------------------------------
// THE BREATH, on the real rig.
// ---------------------------------------------------------------------------
const buf = readFileSync(MODEL);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
);
installModel('ship', gltf.scene, gltf.animations);
const scene = new THREE.Scene();
const body = createVisual('ship');
scene.add(body);
scene.updateMatrixWorld(true);
const anim = createAnimationController(body);
const breathe = createBreathDriver(body);

console.log('\nthe breath');
check('the driver built off the asset descriptor', breathe != null);
check('it drives the chest and the neck', breathe?.bones.length === 2, breathe?.bones.join(', '));

{
  // THE BONES IT PICKED MUST BE MIXER-OWNED. This is the whole reason the
  // breath needs no restore of its own, and the reason it uses neck02_06
  // rather than the neck01_05 anyone would reach for first.
  const cov = trackCoverage(body);
  for (const b of breathe.bones) {
    check(`${b} is rewritten by every clip`, cov.get(b)?.owned === true,
      JSON.stringify(cov.get(b)?.keys));
  }
  check('neck01_05 was correctly avoided', cov.get('neck01_05')?.owned === false,
    `swim keys it ${cov.get('neck01_05')?.keys.swim} time(s) — a constant`);
}

const snout = () => body.worldToLocal(
  body.getObjectByName('mouth_08').getWorldPosition(new THREE.Vector3()),
);
// Dorsal is -X in this instance's frame (measured — see systems/celebrate.js).
const up = (p) => -p.x;

{
  // Held on a single animation frame so the clip cannot contribute any motion
  // of its own — what moves here is the breath and nothing else.
  anim.update(DT, 'surfaceIdle', false);
  scene.updateMatrixWorld(true);
  let lo = Infinity, hi = -Infinity;
  const period = CONFIG.surfaceRest.breath.period;
  for (let t = 0; t < period * 1.1; t += DT) {
    anim.update(0, 'surfaceIdle', false); // no clip time advances
    breathe.update(DT, 1);
    scene.updateMatrixWorld(true);
    const y = up(snout());
    lo = Math.min(lo, y); hi = Math.max(hi, y);
  }
  const travel = hi - lo;
  check('the chest actually moves the animal', travel > 0.01, `snout travels ${travel.toFixed(4)}`);
  check('...but subtly — under the idle clip\'s own head motion (0.231)', travel < 0.15,
    `${travel.toFixed(4)}`);
}

{
  // At rest 0 it must write NOTHING, or a swimming seal breathes too.
  anim.update(DT, 'swim', false);
  scene.updateMatrixWorld(true);
  const before = snout().clone();
  for (let i = 0; i < 60; i++) {
    anim.update(0, 'swim', false);
    breathe.update(DT, 0);
  }
  scene.updateMatrixWorld(true);
  check('at rest 0 the breath is silent', before.distanceTo(snout()) < 1e-6);
}

{
  // No ratchet: after breathing and stopping, the pose must be exactly what the
  // clip alone produces. Against a control seal, since the clip is still
  // playing underneath and moves the snout on its own.
  const control = createVisual('ship');
  const cScene = new THREE.Scene();
  cScene.add(control);
  cScene.updateMatrixWorld(true);
  const cAnim = createAnimationController(control);
  for (let i = 0; i < 600; i++) {
    anim.update(DT, 'surfaceIdle', false);
    breathe.update(DT, 1);
    cAnim.update(DT, 'surfaceIdle', false);
  }
  // Stop breathing, let both run on identically.
  for (let i = 0; i < 120; i++) {
    anim.update(DT, 'surfaceIdle', false);
    breathe.update(DT, 0);
    cAnim.update(DT, 'surfaceIdle', false);
  }
  scene.updateMatrixWorld(true);
  cScene.updateMatrixWorld(true);
  const mine = snout();
  const theirs = control.worldToLocal(
    control.getObjectByName('mouth_08').getWorldPosition(new THREE.Vector3()),
  );
  check('it leaves no drift behind', mine.distanceTo(theirs) < 0.002,
    `${mine.distanceTo(theirs).toFixed(5)} from a seal that never breathed`);
}

console.log('\nphysics is untouched');
{
  // The whole change was meant to be animation-only. `aboveSurface` is the
  // physics fact — it gates gravity, air drag, the splash and the air clock —
  // and the new band must not have moved it.
  const src = readFileSync(resolve(HERE, '../path/src/entities/player.js'), 'utf8');
  check('aboveSurface is still the bare waterline test',
    src.includes('player.aboveSurface = pos.y > bounds.surfaceY;'));
  check('gravity still keys off that same line',
    src.includes('const airborne = pos.y > bounds.surfaceY;'));
  check('surfaceRest never feeds the physics',
    !/airborne\s*=.*surfaceRest/.test(src) && !/gravity.*surfaceRest/.test(src));
}

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('all checks passed\n');
