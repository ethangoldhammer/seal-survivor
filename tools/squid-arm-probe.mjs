// DO THE ARMS ACTUALLY TRAIL, or is `roleLooseness.arm` just a number in a file?
//
// A config assertion proves the value was read. It does not prove the springs
// moved, and a chain whose bones are named wrong is dropped silently — the limb
// simply never springs again and nothing anywhere says so. So this drives the
// real animation controller through a hard turn and MEASURES how far each chain's
// tip falls behind where a rigid body would have put it.
//
// scene.updateMatrixWorld(true) after every step, or every pose measures
// identical and nothing throws.
//
//   node --import ./tools/vite-loader.mjs tools/squid-arm-probe.mjs
import './dom-stub.mjs';
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CONFIG } from '../path/src/config.js';
import { ASSETS, installModel, createVisual } from '../path/src/assets.js';
import { createAnimationController } from '../path/src/systems/animation.js';

const KEY = 'enemyGiantSquid';
const buf = readFileSync('public' + ASSETS[KEY].model);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
);
installModel(KEY, gltf.scene, gltf.animations);

// The last bone of one arm, one feeding tentacle and one mantle fin.
const TIPS = {
  'arm (SideTTCL)': 'SideTTCL005_32',
  'tentacle (nondeformL)': 'nondeformL007_78',
  'mantle fin (topflapperL)': 'topflapperL002_69',
};

const num = (v) => (Number.isFinite(v) ? v.toFixed(3) : '-');

// Swing the holder through a hard turn and watch each tip. A LOOSE chain lags,
// so its tip traces a WIDER arc than a stiff one — the measure is how far the
// tip drifts from the position the same bone holds when the body is still.
function run(armLooseness) {
  CONFIG.animation.spring.roleLooseness.arm = armLooseness;

  const visual = createVisual(KEY);
  const holder = new THREE.Object3D();
  holder.add(visual);
  const scene = new THREE.Scene();
  scene.add(holder);
  scene.updateMatrixWorld(true);

  const anim = createAnimationController(visual);
  const rest = {};
  const v = new THREE.Vector3();

  // Settle at rest first, so the baseline is a settled pose rather than the
  // bind pose the springs have not reached yet.
  for (let i = 0; i < 90; i++) {
    anim.update(1 / 60, 'idle', false);
    scene.updateMatrixWorld(true);
  }
  for (const [label, name] of Object.entries(TIPS)) {
    const b = visual.getObjectByName(name);
    if (!b) { console.log(`  MISSING ${name}`); continue; }
    rest[label] = b.getWorldPosition(v).clone();
  }

  // ...then whip the body through 180 degrees over half a second, which is what
  // an orbiting boss reversing at its deadzone does.
  const swing = {};
  for (const k of Object.keys(rest)) swing[k] = 0;
  for (let i = 0; i < 30; i++) {
    holder.rotation.z = Math.PI * (i / 30);
    anim.update(1 / 60, 'swim', false);
    scene.updateMatrixWorld(true);
    for (const [label, name] of Object.entries(TIPS)) {
      const b = visual.getObjectByName(name);
      if (!b || !rest[label]) continue;
      // Where a RIGID tip would be: the rest offset, rotated by the body.
      const rigid = rest[label].clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), holder.rotation.z);
      swing[label] = Math.max(swing[label], b.getWorldPosition(v).distanceTo(rigid));
    }
  }
  scene.remove(holder);
  return swing;
}

const base = CONFIG.animation.spring.roleLooseness.arm;
console.log(`\nhow far each tip falls behind a rigid body through a 180-degree turn`);
console.log(`(world units — bigger means the limb is being towed rather than carried)\n`);

const asFin = run(CONFIG.animation.spring.roleLooseness.fin ?? 0.8);
const asArm = run(base);
CONFIG.animation.spring.roleLooseness.arm = base;

console.log(`  ${'tip'.padEnd(26)}${'at fin looseness'.padEnd(20)}${'at arm looseness'.padEnd(20)}change`);
for (const label of Object.keys(asArm)) {
  const a = asFin[label];
  const b = asArm[label];
  const pct = a > 1e-6 ? `${((b / a - 1) * 100).toFixed(0)}%` : '-';
  console.log(`  ${label.padEnd(26)}${num(a).padEnd(20)}${num(b).padEnd(20)}${pct}`);
}
console.log(`\n  (fin ${CONFIG.animation.spring.roleLooseness.fin}, arm ${base})\n`);
