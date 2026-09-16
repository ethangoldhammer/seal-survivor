#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:coil
//
// THE COIL — what the seal does on "STRIKE NOW!" (systems/strikePose.js), on
// the REAL rig: furseal.glb, posed through the same CCD solver the game uses,
// with the swim cycle running underneath it exactly as it does in a run.
//
// What this can say that watching it cannot:
//
//   * IT LANDS ON THE MOMENT AND HOLDS. The pose is read off `loaded && held`
//     every frame, so the two failures are opposite and both look plausible in
//     motion: an accent that re-fires every frame of a long hold (a fluke that
//     buzzes), and one that times out mid-hold while the prompt is still up.
//     Both are counted here rather than looked at.
//   * THE SNAP OVERSHOOTS. The accent is the whole point of the feature and it
//     is two frames long; a render of the held pose cannot show whether the
//     fluke went past it on the way in. Measured on the bone, at the peak.
//   * THE SEAL COMES BACK — EXACTLY. This is the one that has already bitten
//     this project twice (see the headers of systems/poseRig.js and
//     systems/celebrate.js): the swim clip does not key everything a pose
//     writes, so a pose that hands the bones back badly ratchets. The first
//     version of this driver called rig.restore() on the way out, like the
//     clap does, and stamped a seconds-old swim frame onto the animal: the
//     hands sat 0.20 and 0.45 world units off a control seal and were still
//     there ten seconds later. It is measured here against a control seal that
//     only ever swam, over twenty coils.
//   * ONLY THE CHANNELS THAT ARE ON ARE WRITTEN. `finWeight` and `headWeight`
//     ship at 0 for reasons that are about the aim rig and the guns rather
//     than about taste (see CONFIG.strikePose.pose), and a weight of 0 that
//     quietly still writes its chain would undo both.
//
// The envelope half runs first, with no rig at all — it is pure state and the
// cheapest place to catch a phase that never ends.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG } from '../path/src/config.js';
import { installModel, createVisual } from '../path/src/assets.js';
import { createAnimationController } from '../path/src/systems/animation.js';
import { createAimRig } from '../path/src/systems/aimRig.js';
import {
  strikePoseState, updateStrikePose, resetStrikePose, createStrikePoseDriver,
} from '../path/src/systems/strikePose.js';
import { clapState, triggerClap, resetClap } from '../path/src/systems/clap.js';
import { celebrationState, playCelebration, resetCelebration } from '../path/src/systems/celebrate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEAL = resolve(HERE, '../public/models/furseal.glb');

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

if (!existsSync(SEAL)) {
  console.error(`\nmissing ${SEAL} — the rig has to be in public/models for the game to load it too.\n`);
  process.exit(1);
}

const DT = 1 / 60;
const C = CONFIG.strikePose;

// ---------------------------------------------------------------------------
console.log('\nthe envelope — snap, settle, hold, and a hold with no end to it');
// ---------------------------------------------------------------------------
{
  resetStrikePose();
  updateStrikePose(DT, false);
  check('nothing is coiled to begin with', !strikePoseState.active && strikePoseState.t === 0);

  // THE ACCENT. `t` has to go PAST 1 on the way in — that is the overshoot,
  // and it is the difference between a pose that is struck and one that is
  // switched on. Sampled across the snap rather than at its end, since the
  // peak is where the curve turns.
  let peak = 0;
  const snapFrames = Math.ceil(C.snap / DT);
  for (let i = 0; i < snapFrames; i++) { updateStrikePose(DT, true); peak = Math.max(peak, strikePoseState.t); }
  check('the moment starts a coil', strikePoseState.active && strikePoseState.hits === 1);
  check('the snap overshoots the pose', peak > 1.0 && peak <= C.overshoot + 1e-9,
    `peak t=${peak.toFixed(3)}, overshoot is ${C.overshoot}`);

  // ...and settles back onto the pose exactly.
  for (let i = 0; i < Math.ceil(C.settle / DT) + 2; i++) updateStrikePose(DT, true);
  check('it settles onto the pose', strikePoseState.phase === 'hold' && strikePoseState.t === 1,
    `phase ${strikePoseState.phase} t=${strikePoseState.t}`);

  // A HOLD WITH NO CLOCK ON IT. Ten seconds is far past any wind-up a person
  // plays, and the prompt is still up the whole time — a pose that timed out
  // here would leave the words on screen with nothing under them.
  for (let i = 0; i < 600; i++) updateStrikePose(DT, true);
  check('...and holds it for as long as the button is down',
    strikePoseState.phase === 'hold' && strikePoseState.t === 1);
  check('...without re-firing the accent', strikePoseState.hits === 1, `hits=${strikePoseState.hits}`);

  // The let-go.
  let frames = 0;
  while (strikePoseState.active && frames < 200) { updateStrikePose(DT, false); frames++; }
  check('the let-go drops it inside the release', frames * DT <= C.release + DT * 1.5,
    `${(frames * DT * 1000).toFixed(0)}ms, release is ${(C.release * 1000).toFixed(0)}ms`);
  check('...and it is fully gone', strikePoseState.t === 0 && strikePoseState.phase === 'off');
}

console.log('\ngrabbing the button again mid-release re-enters rather than restarting');
{
  resetStrikePose();
  for (let i = 0; i < 40; i++) updateStrikePose(DT, true);
  for (let i = 0; i < 4; i++) updateStrikePose(DT, false);
  const before = strikePoseState.t;
  check('the coil is part-way out', before > 0.2 && before < 0.95, `t=${before.toFixed(3)}`);
  updateStrikePose(DT, true);
  check('the pose does not fall back to nothing on the re-press', strikePoseState.t > before,
    `t ${before.toFixed(3)} -> ${strikePoseState.t.toFixed(3)}`);
  check('...and it counts as a second moment', strikePoseState.hits === 2);
}

console.log('\na clap or a victory lap takes the flippers outright');
{
  resetStrikePose(); resetClap(); resetCelebration();
  for (let i = 0; i < 40; i++) updateStrikePose(DT, true);
  check('coiled', strikePoseState.active);
  triggerClap({});
  updateStrikePose(DT, true);
  check('a clap stands the coil down on the frame it starts',
    !strikePoseState.active && strikePoseState.t === 0);
  resetClap();
  // ...and it comes back on its own, because the wind-up is still loaded.
  updateStrikePose(DT, true);
  check('...and it returns once the clap is over', strikePoseState.active && strikePoseState.phase === 'snap');

  playCelebration({ variant: 'clap' });
  updateStrikePose(DT, true);
  check('a celebration does the same', !strikePoseState.active, `celebrating=${celebrationState.active}`);
  resetCelebration();
}

console.log('\nthe switch');
{
  resetStrikePose();
  const was = C.enabled;
  C.enabled = false;
  for (let i = 0; i < 40; i++) updateStrikePose(DT, true);
  check('enabled:false coils nothing', !strikePoseState.active && strikePoseState.hits === 0);
  C.enabled = was;
}

// ---------------------------------------------------------------------------
// THE RIG. Everything below measures bones.
// ---------------------------------------------------------------------------
const buf = readFileSync(SEAL);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
installModel('ship', gltf.scene, gltf.animations);

const scene = new THREE.Scene();
// TWO ANIMALS, and the second one is the whole point: a bone's position means
// nothing on its own, because the swim cycle moves every one of them further
// than this pose does. The control runs the same clip from the same frame and
// never coils, so the difference between them IS the coil.
const body = createVisual('ship');
const control = createVisual('ship');
control.position.x = 10;
scene.add(body, control);
// Without this every measurement below comes out identical — the bones are
// posed in local space and nothing has composed them into the world yet.
scene.updateMatrixWorld(true);

const anim = createAnimationController(body);
const animC = createAnimationController(control);
// BOTH SEALS GET AN AIM RIG, and it is not scenery. In a run the flippers, the
// neck and the tail are solved every single frame by systems/aimRig.js, and
// the coil is written on top of that — so a harness without one is posing an
// animal this game never draws. It also hides the interesting half of the
// anti-ratchet: the aim rig solves each chain from wherever the bone already
// is, which is exactly what can inherit a pose instead of correcting it.
const rig = createAimRig(body);
const rigC = createAimRig(control);
const AIM = new THREE.Vector2(1, 0);
const driver = createStrikePoseDriver(body);

console.log('\nrig resolution');
check('the coil driver built off the aim rig', driver != null);
check('the tail chain resolved', driver?.hasTail === true);
check('the head chain resolved too', driver?.hasHead === true);

const _v = new THREE.Vector3();
function local(inst, name) {
  const bone = inst.getObjectByName(name);
  bone.getWorldPosition(_v);
  return inst.worldToLocal(_v.clone());
}
// Up is dorsal (-X) in the seal's own frame — see the header of
// systems/celebrate.js.
const dorsal = (p) => -p.x;
// How far a bone sits from where the SAME bone sits on the control, in the
// body's own frame. The pose, as a number.
function apart(name) {
  return local(body, name).distanceTo(local(control, name));
}
function lift(name) {
  return dorsal(local(body, name)) - dorsal(local(control, name));
}

function step(n, armed) {
  for (let i = 0; i < n; i++) {
    anim.update(DT, 'swim', false);
    animC.update(DT, 'swim', false);
    scene.updateMatrixWorld(true);
    // The run's order: clip, then aim, then the hand-posed pose on top. Any
    // other order and the pose is simply overwritten — see the note on
    // driver.update in systems/strikePose.js.
    rig.update(DT, AIM, { engaged: true });
    rigC.update(DT, AIM, { engaged: true });
    updateStrikePose(DT, armed);
    driver.update(DT);
    scene.updateMatrixWorld(true);
  }
}

resetStrikePose();
step(120, false);
check('the two seals are in step before anything coils', apart('tail02_023') < 1e-6,
  `${apart('tail02_023').toExponential(1)} apart`);

// A COIL, FROM A SETTLED ANIMAL — and let go of properly afterwards. Every
// measurement below is a comparison between two moments, so both have to start
// from the same place: a reset taken mid-coil leaves the last pose sitting in
// the bones (resetStrikePose zeroes the state, it does not un-pose the seal)
// and the next entry then measures from a baseline that is already half way
// there. Cost me a failing assertion that was measuring exactly that.
function coil(frames = Math.ceil((C.snap + C.settle) / DT) + 6, onFrame = null) {
  let peak = -Infinity;
  for (let i = 0; i < frames; i++) {
    step(1, true);
    if (onFrame) peak = Math.max(peak, onFrame());
  }
  return peak;
}
function release(frames = 120) {
  step(frames, false);
}

console.log('\nthe fluke cocks');
{
  release(150);
  const peak = coil(Math.ceil((C.snap + C.settle) / DT) + 6, () => lift('tail02_023'));
  step(30, true);
  const held = lift('tail02_023');
  check('the fluke rides higher than the control seal\'s', held > 0.05,
    `${held.toFixed(3)} dorsal on a body ${new THREE.Box3().setFromObject(control).getSize(_v).x.toFixed(2)} tall`);

  // THE ACCENT, ON THE BONE. The overshoot has to survive the solver: the pose
  // is slerped toward every frame (CONFIG.strikePose.ik.smoothing), so a
  // `t` that peaks for one frame can be swallowed whole and leave `overshoot`
  // a number that reads well in the config and does nothing on the animal.
  check('the snap carries it past the held pose', peak > held + 1e-4,
    `peak ${peak.toFixed(4)} vs held ${held.toFixed(4)} — ${((peak / held - 1) * 100).toFixed(0)}% over`);
  release();
}

console.log('\nonly the channels that are switched on are written');
{
  // Driven here rather than read off the shipped defaults: what is under test
  // is that a weight of 0 means untouched, not which channels happen to be on
  // today.
  const p = C.pose;
  const wasFin = p.finWeight, wasHead = p.headWeight;
  p.finWeight = 0; p.headWeight = 0;
  release(240);
  // MEASURED AS A DELTA, not as an absolute. The shipped pose gives both of
  // these channels a little weight, so by the time this section runs the
  // sections above have already posed them and left the bounded offset below
  // in the bones — an absolute test here would be measuring THAT and calling
  // it this coil's writing. What is under test is whether a weight of 0 adds
  // anything, which is a difference.
  const base = { L: apart('hand_L_014'), R: apart('hand_R_018'), head: apart('head_07') };
  coil(60);
  check('with finWeight 0 the flippers are the aim rig\'s',
    apart('hand_L_014') - base.L < 1e-6 && apart('hand_R_018') - base.R < 1e-6,
    `L ${base.L.toFixed(4)} -> ${apart('hand_L_014').toFixed(4)}  R ${base.R.toFixed(4)} -> ${apart('hand_R_018').toFixed(4)}`);
  check('with headWeight 0 the head is untouched', apart('head_07') - base.head < 1e-6,
    `${base.head.toFixed(4)} -> ${apart('head_07').toFixed(4)}`);
  release(240);

  p.finWeight = 1;
  coil(60);
  check('...and raising finWeight does move them', apart('hand_L_014') > 0.05,
    `${apart('hand_L_014').toFixed(3)}`);
  release(240);
  // AND A SOLVED CHAIN DOES NOT COME ALL THE WAY BACK. This is the cost of
  // posing either of the two channels the aim rig owns, and it is measured
  // rather than left as a remark because it is half the reason both ship at 0
  // (see CONFIG.strikePose.pose, and the note in systems/aimRig.js that threw
  // out an authored neck coil once already): the aim rig solves each chain
  // from wherever the bone already is, so it inherits the pose instead of
  // correcting it. The tail, which is a spring rather than a solve, returns to
  // exactly zero — the section below holds it to that.
  //
  // It is BOUNDED, not a walk; twenty coils add nothing to it. If either of
  // these ever starts coming back clean, these lines failing is how anyone
  // would find out that the channels are free again.
  check('...and keeps a little of it afterwards', apart('hand_L_014') > 1e-3,
    `${apart('hand_L_014').toFixed(4)} left over`);

  p.finWeight = 0; p.headWeight = 0.6;
  release(240);
  coil(60);
  release(300);
  check('the same is true of the neck', apart('head_07') > 1e-3,
    `${apart('head_07').toFixed(4)} left over on a body ${new THREE.Box3().setFromObject(control).getSize(_v).x.toFixed(2)} tall`);
  p.finWeight = wasFin; p.headWeight = wasHead;
  release(240);
}

console.log('\nthe seal comes back');
{
  // The ratchet test. Twenty coils on the shipped pose, then a long settle,
  // measured against a seal that only ever swam. See the header.
  const p = C.pose;
  const wasFin = p.finWeight, wasHead = p.headWeight;
  p.finWeight = 0; p.headWeight = 0;
  release(240);
  // MEASURED AS A DELTA, because an earlier section in this file has already
  // posed the flippers and left the offset above in them. What is under test
  // is whether twenty coils ADD anything — a ratchet is a walk, and a walk is
  // only visible against where it started.
  const before = { tail: apart('tail02_023'), hand: apart('hand_L_014'), head: apart('head_07') };
  for (let i = 0; i < 20; i++) { coil(45); release(60); }
  release(180);
  const after = { tail: apart('tail02_023'), hand: apart('hand_L_014'), head: apart('head_07') };
  check('the fluke is back where a seal that never coiled has it', after.tail < 1e-6,
    `${after.tail.toExponential(2)} after 20 coils`);
  check('...and twenty of them add nothing to anything else',
    after.hand - before.hand < 1e-6 && after.head - before.head < 1e-6,
    `hand ${before.hand.toFixed(4)} -> ${after.hand.toFixed(4)}, head ${before.head.toExponential(1)} -> ${after.head.toExponential(1)}`);
  p.finWeight = wasFin; p.headWeight = wasHead;
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
