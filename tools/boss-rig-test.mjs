#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:bossrig
//
// The boss's head, on both boss bodies — megalodon.glb and orca.glb, the real
// rigs the game loads, not a stand-in.
//
// Three claims, and every one of them is about a SNAP rather than about the
// head being aimed. Aiming was never broken; what was broken was what happened
// at the edges of the hunter profile, which was written for ten sharks each
// tracking its own fish and is wrong in three separate ways for one animal in
// an emptied arena:
//
//   ALWAYS      A boss tracks the player from anywhere. The hunter profile
//               fades the look out between `fadeRange` and `maxRange` (24 and
//               36 units, in a ~92-unit arena), so a kiting player crossed a
//               line and the head let go — then grabbed back on when they
//               returned. Checked against a NON-boss on the same body at the
//               same distance, so this measures the boss profile rather than
//               measuring that a look-at works.
//
//   NO SNAP     A reversal is swept through, not skipped. The test teleports
//               the target across the body — the worst case, and the one that
//               happens for real every time the boss swims past you — and
//               measures the per-frame angular step of where the head is
//               actually pointing. `turnRate` is the cap it must respect.
//
//   NO POP      The chain never unprimes. applyChain drops its smoothing
//               history whenever the weight falls under 0.001, and the next
//               solve then starts AT the solved pose instead of easing into
//               it: one guaranteed pop per release. `minGate` is what holds
//               the weight off that floor, and this is the check that says so.
//
// THE CONTROL RUN IS THE POINT. Every measurement is taken twice on the same
// body, same frames, same target — because "the head moved 4 degrees this
// frame" means nothing without the number it used to be. Which control depends
// on the claim: the hunter profile for the range one, and for the snap, the
// BOSS profile with `turnRate` switched off, so the only difference between
// the two runs is the thing being tested.
//
// AND IT IS MEASURED ON THE AIM, NOT THE POSE. That is the finding that made
// this file worth writing: maxBend caps these chains at about ten degrees a
// bone, so the snout travels a third of a degree per frame whether the solver
// was handed a smooth sweep or a 180-degree jump. The pose cannot see the bug.
// The direction handed to the solver can, and it is 170 degrees in one frame
// without the slew against 1.7 with it — see the summary table.
//
//   node --import ./tools/vite-loader.mjs tools/boss-rig-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
// Both boss models embed their textures, and GLTFLoader decodes those through
// createImageBitmap. Without a stub the parse promise never settles and the
// script exits with "unsettled top-level await" and no error at all — the same
// trap tools/crab-claw-test.mjs documents. Nothing here reads a pixel; the
// bones are the whole subject.
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
import * as THREE from 'three';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { CONFIG } from '../path/src/config.js';
import { installModel, createVisual } from '../path/src/assets.js';
import { createHeadLook } from '../path/src/systems/headLook.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEG = 180 / Math.PI;
const DT = 1 / 60;

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// The two bodies a boss can arrive in. Keyed by the ASSET, because that is
// what carries the lookRig — bosses.csv names an enemy, the enemy names an
// asset, and it is the asset's bone list this file is exercising.
const BODIES = [
  { label: 'shark (bossShark)', asset: 'enemyMegalodon', model: 'megalodon.glb' },
  // BOTH orca bodies. bossOrca rolls a bull or a cow per arrival (see `assets`
  // on its def), and they are separate models — a head rig that resolved on one
  // and not the other would be a boss that tracks you half the time.
  { label: 'orca bull (bossOrca)', asset: 'enemyOrcaBull', model: 'orca_male.glb' },
  { label: 'orca cow (bossOrca)', asset: 'enemyOrcaCow', model: 'orca_female.glb' },
];

// --- rigs, off the real files ----------------------------------------------
const loader = new GLTFLoader();
for (const body of BODIES) {
  const path = resolve(HERE, '../public/models', body.model);
  if (!existsSync(path)) {
    console.error(`\nmissing ${path} — a boss cannot be rigged from a model that isn't there.\n`);
    process.exit(1);
  }
  const buf = readFileSync(path);
  const gltf = await loader.parseAsync(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
  );
  installModel(body.asset, gltf.scene, gltf.animations);
}

// Where the head is actually pointing, in radians, measured on the POSED
// bones: the chain's tip against the chain's root, flattened to the arena
// plane. Deliberately not the bone's local rotation — a two-bone chain can
// split the same turn between its joints in more than one way, and what the
// player sees is where the end of the snout ends up.
const _root = new THREE.Vector3();
function pointing(look) {
  const chain = look.head;
  chain.bones[0].updateWorldMatrix(true, false);
  chain.bones[0].getWorldPosition(_root);
  return Math.atan2(chain.point.y - _root.y, chain.point.x - _root.x);
}

// Signed shortest angle between two headings.
function angleDelta(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// One rig on one body, driven for `frames` at a target that may move.
//
// The scene matrices are forced every frame. There is no renderer here to have
// done it, and the IK reads world transforms — without this every frame poses
// against the last one's matrices and the whole run measures a lag that does
// not exist in the game.
function drive(asset, { boss, frames, targetAt, settle = 60 }) {
  const scene = new THREE.Scene();
  const visual = createVisual(asset);
  scene.add(visual);
  const look = createHeadLook(visual);
  if (!look) return null;

  const target = new THREE.Vector3();
  const opts = { boss };
  // `targetAt` may return null, which is how the RELEASED run is driven — the
  // control every "is it leaning toward the player" measurement is taken
  // against. Without it there is no answer to "leaning compared to what": the
  // head's absolute heading is dominated by the body's own bind pose, and on
  // these models that is nowhere near the target to begin with.
  const at = (i) => {
    const t = targetAt(i);
    if (!t) return null;
    target.copy(t);
    return target;
  };

  // Settle first, at the starting target, so the run being measured is not
  // also the run where the weight is easing up from zero.
  for (let i = 0; i < settle; i++) {
    scene.updateMatrixWorld(true);
    look.update(DT, at(0), opts);
  }

  const steps = [];
  const aimSteps = [];
  const weights = [];
  let unprimed = 0;
  let last = pointing(look);
  const startHeading = last; // where the reversal begins, for the travel check
  let lastAim = Math.atan2(look.aim.y, look.aim.x);

  for (let i = 0; i < frames; i++) {
    scene.updateMatrixWorld(true);
    look.update(DT, at(i), opts);
    const now = pointing(look);
    // TWO measurements, because they answer different questions and only one
    // of them can see a snap. `steps` is where the head ends up — what the
    // player sees, and what maxBend has already flattened. `aimSteps` is the
    // direction the solver was HANDED, which is the thing that jumps.
    const nowAim = Math.atan2(look.aim.y, look.aim.x);
    steps.push(Math.abs(angleDelta(last, now)));
    aimSteps.push(Math.abs(angleDelta(lastAim, nowAim)));
    weights.push(look.weight);
    if (!look.head.primed) unprimed += 1;
    last = now;
    lastAim = nowAim;
  }

  return {
    look,
    steps,
    weights,
    unprimed,
    maxStep: Math.max(...steps),
    maxAimStep: Math.max(...aimSteps),
    minWeight: Math.min(...weights),
    // How far the head is off the true bearing at the end of the run. The
    // slew means it arrives late, not never — a rig that never gets there is
    // as broken as one that snaps.
    finalHeading: last,
    startHeading,
  };
}

// The bearing from the chain root to a point, which is what "pointing at the
// player" has to be measured against.
function bearingTo(look, x, y) {
  const chain = look.head;
  chain.bones[0].updateWorldMatrix(true, false);
  chain.bones[0].getWorldPosition(_root);
  return Math.atan2(y - _root.y, x - _root.x);
}

const boss = CONFIG.enemyLook.boss ?? {};
section('THE PROFILE EXISTS');
check('CONFIG.enemyLook.boss is configured', !!CONFIG.enemyLook.boss);
check('...and switches the range fade off', !Number.isFinite(boss.maxRange),
  `maxRange = ${boss.maxRange}`);
check('...and floors the gate above applyChain\'s 0.001 release',
  boss.minGate > 0.001, `minGate = ${boss.minGate}`);
check('...and caps the aim slew', boss.turnRate > 0 && Number.isFinite(boss.turnRate),
  `turnRate = ${boss.turnRate} rad/s (${(boss.turnRate * DEG).toFixed(0)}°/s)`);

const rows = [];

for (const body of BODIES) {
  section(body.label.toUpperCase());

  // --- ALWAYS: a target well past maxRange ---------------------------------
  // 60 units out, against a hunter profile that has fully faded by 36.
  const FAR = 60;
  const far = () => new THREE.Vector3(FAR, 6, 0);

  const bossFar = drive(body.asset, { boss: true, frames: 120, targetAt: far });
  const huntFar = drive(body.asset, { boss: false, frames: 120, targetAt: far });
  if (!bossFar || !huntFar) {
    check(`${body.label}: the look rig resolved`, false, 'createHeadLook returned null');
    continue;
  }

  check('the hunter profile lets go at 60 units', huntFar.minWeight < 0.01,
    `weight ${huntFar.minWeight.toFixed(4)}`);
  check('...and the boss profile does not', bossFar.minWeight > 0.05,
    `weight ${bossFar.minWeight.toFixed(3)}`);
  check('...so the boss chain stays primed the whole time', bossFar.unprimed === 0,
    `${bossFar.unprimed}/120 frames unprimed`);

  // TRACKING, measured against a released control rather than against the true
  // bearing. maxBend caps the whole chain at about 20 degrees on these rigs, so
  // a head "pointing at" a target 60 units away is a LEAN of a few degrees off
  // whatever the body's own pose already was — and on both these models the
  // bind pose faces nowhere near the arena's +X. Comparing to the bearing would
  // therefore fail on a rig that was working perfectly, which is exactly what
  // it did before this was rewritten.
  //
  // The honest question is whether the lean CHANGES SIDES with the player, so
  // that is what is asked: same body, same frames, target left vs right vs
  // released.
  const released = drive(body.asset, { boss: true, frames: 60, targetAt: () => null });
  const leftRun = drive(body.asset, { boss: true, frames: 180, targetAt: () => new THREE.Vector3(-FAR, 0, 0) });
  const rightRun = drive(body.asset, { boss: true, frames: 180, targetAt: () => new THREE.Vector3(FAR, 0, 0) });
  const leftLean = angleDelta(released.finalHeading, leftRun.finalHeading);
  const rightLean = angleDelta(released.finalHeading, rightRun.finalHeading);

  check('...and it leans to opposite sides for a player on opposite sides',
    Math.sign(leftLean) !== Math.sign(rightLean) && leftLean !== 0,
    `left ${(leftLean * DEG).toFixed(1)}°, right ${(rightLean * DEG).toFixed(1)}° off the released pose`);
  check('...by enough to see', Math.abs(leftLean) + Math.abs(rightLean) > 0.05,
    `${((Math.abs(leftLean) + Math.abs(rightLean)) * DEG).toFixed(1)}° of total travel between the two`);

  // --- NO SNAP: the target teleports across the body ------------------------
  // The worst case there is, and a real one — it is what a boss sees every
  // time the player crosses in front of its nose.
  //
  // At 12 units, deliberately: inside the hunter profile's own range, so the
  // control runs below are tracking too and the comparison is between two
  // rigs that are both trying rather than between one that is and one that
  // has already faded out.
  const flip = (i) => (i < 30
    ? new THREE.Vector3(12, 0, 0)
    : new THREE.Vector3(-12, 0, 0));

  const bossFlip = drive(body.asset, { boss: true, frames: 240, targetAt: flip });

  // THE CONTROL THAT MATTERS: the same boss profile with the slew switched
  // off. Everything else — weight, smoothing, cone, the floor under the gate —
  // is identical, so whatever difference shows up is `turnRate` and nothing
  // else. Restored in a finally, or every check after this one would be
  // measuring a config this file broke.
  const savedRate = CONFIG.enemyLook.boss.turnRate;
  let noSlew;
  try {
    CONFIG.enemyLook.boss.turnRate = null; // absent = no cap, the old behaviour
    noSlew = drive(body.asset, { boss: true, frames: 240, targetAt: flip });
  } finally {
    CONFIG.enemyLook.boss.turnRate = savedRate;
  }

  // THE SNAP ITSELF, on the aim direction. A tenth of a degree of slack for
  // float drift; anything real is orders of magnitude past it.
  const cap = boss.turnRate * DT + 0.002;
  check('the aim direction never jumps more than the slew allows',
    bossFlip.maxAimStep <= cap,
    `worst ${(bossFlip.maxAimStep * DEG).toFixed(2)}° vs cap ${(cap * DEG).toFixed(2)}°/frame`);
  check('...and without the slew it teleports across the body in one frame',
    noSlew.maxAimStep > bossFlip.maxAimStep * 10,
    `no-slew ${(noSlew.maxAimStep * DEG).toFixed(1)}° in a single frame`);

  // The pose that comes out the other side moves smoothly too. Not a
  // comparison — maxBend has already flattened the tip's travel to a fraction
  // of a degree a frame whatever the solver was handed, which is exactly why
  // the check above is the one that can fail.
  check('...and the head itself moves smoothly throughout',
    bossFlip.maxStep <= boss.turnRate * DT * 2.5,
    `worst ${(bossFlip.maxStep * DEG).toFixed(2)}°/frame at the snout`);

  // A sweep takes TIME. Counting the frames that actually moved is what
  // separates "eased" from "snapped and then sat still" — a rig that jumped in
  // one frame would have one busy frame and 239 still ones.
  const moving = bossFlip.steps.filter((s) => s > 0.0005).length;
  check('...and the turn is spread across many frames', moving > 20,
    `${moving} frames of the 240 actually moved`);

  check('the chain never unprimes through the reversal', bossFlip.unprimed === 0,
    `${bossFlip.unprimed} frames unprimed`);

  // ...and it does arrive. A slew that never converges is a head permanently
  // trailing the player, which is its own bug.
  //
  // MEASURED AS TRAVEL, not as a residual angle, and the orca cow is why. This
  // used to be `settled < 90 degrees after 4s` and three bodies do not agree on
  // that number: the shark lands 67 degrees off, the orca bull 85 and the cow
  // 95. None of them ever reaches zero and none of them is meant to — a
  // two-bone chain under maxBend has a few tens of degrees of authority in
  // total, so where each head STOPS is set by its own bind pose. The cow's sits
  // about ten degrees further out than the bull's (her Head bone's forward axis
  // reads dot 0.983 against the body's, where his reads 1.000), so she settles
  // ten degrees wider, having done exactly as much work.
  //
  // A residual threshold therefore measures the bind pose, not the rig. What
  // the check is actually for is "the head turned toward the player rather than
  // sitting where it was", so that is what it asks: how far round did it come,
  // out of the gap it started with. A stalled head travels nothing and fails;
  // a head that closes most of what its bend budget allows passes on any body.
  const wantBack = bearingTo(bossFlip.look, -28, 0);
  const settled = Math.abs(angleDelta(bossFlip.finalHeading, wantBack));
  const began = Math.abs(angleDelta(bossFlip.startHeading, wantBack));
  const closed = began - settled;
  // A FEW DEGREES IS THE WHOLE BUDGET, which is this file's own opening claim
  // seen from the other end: maxBend caps these chains at about ten degrees a
  // bone, so a two-bone head has very little authority and the measured travel
  // is 7.9 / 6.0 / 7.1 degrees on shark / bull / cow. The bar is set under all
  // three and well above zero — a head that has stalled trailing the player,
  // which is the bug, travels nothing at all.
  check('...and the head does come round to the new side',
    closed > 0.05, // ~3 degrees, against a measured 6-8
    `closed ${(closed * DEG).toFixed(1)}° of the ${(began * DEG).toFixed(1)}° it started off by,`
    + ` settling ${(settled * DEG).toFixed(1)}° out`);

  rows.push({
    body: body.label,
    bossStep: bossFlip.maxAimStep * DEG,
    huntStep: noSlew.maxAimStep * DEG,
    bossWeight: bossFar.minWeight,
    huntWeight: huntFar.minWeight,
  });
}

section('WORST SINGLE-FRAME AIM MOVEMENT (the player crossing the body, at 60fps)');
console.log('  body                    slewed          no-slew control  min weight at 60u');
for (const r of rows) {
  console.log(`  ${r.body.padEnd(22)}  ${r.bossStep.toFixed(2).padStart(6)}°/frame  `
    + `${r.huntStep.toFixed(2).padStart(8)}°/frame   `
    + `${r.bossWeight.toFixed(3)} vs ${r.huntWeight.toFixed(3)}`);
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
