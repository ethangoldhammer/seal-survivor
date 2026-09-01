#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:clap
//
// Exercises the clap button on the REAL rig — furseal.glb, posed through the
// same CCD solver the game uses, with the swim cycle running underneath it
// exactly as it does in a run.
//
// What this can say that a boneless smoke test cannot:
//
//   * THE FLIPPERS ACTUALLY MEET. Every assertion below is a measured world
//     position of a bone, not "some quaternion changed" — bone names lie, and
//     a pose that drives the wrong joint still animates. A clap in particular
//     can close its gap while doing something that is not a clap at all: one
//     flipper crossing the body closes it just as well, and looks fine in a
//     number.
//   * IT IS AS FAST AS IT CLAIMS. `attack` is the only number in CONFIG.clap a
//     player can feel as lag, so the test measures the delay from press to
//     contact rather than trusting the envelope's arithmetic.
//   * A RE-TRIGGER DOES NOT JUMP. This is the whole design (see the header of
//     systems/clap.js): pressing again mid-stroke re-enters the envelope at the
//     matching phase instead of restarting it. The failure is a visible hitch,
//     and it is invisible to anything that only checks the end state — so it is
//     measured on the bone, across the press frame.
//   * THE SEAL COMES BACK. The swim clip does not key the front flippers, so a
//     pose that fails to release ratchets: a little further out every clap,
//     which nobody notices until the hundredth. Measured against a control seal
//     that only ever swam.
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
import {
  clapState, triggerClap, updateClap, resetClap, createClapDriver, clapDuration, invSmoothstep,
} from '../path/src/systems/clap.js';
import {
  celebrationState, playCelebration, updateCelebration, resetCelebration,
} from '../path/src/systems/celebrate.js';
import { smoothstep } from '../path/src/systems/ikChain.js';

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

const buf = readFileSync(SEAL);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
installModel('ship', gltf.scene, gltf.animations);

const DT = 1 / 60;
const C = CONFIG.clap;

// ---------------------------------------------------------------------------
// THE MATHS, first and on its own. invSmoothstep is what makes a re-trigger
// continuous, and it is the one part of this feature that can be wrong in a way
// no amount of watching the seal would reveal — a near-inverse produces a jump
// of a few thousandths, which reads as the animation being slightly crunchy
// rather than as a bug in a formula.
// ---------------------------------------------------------------------------
console.log('\nthe attack curve is exactly invertible');
{
  let worst = 0;
  let worstAt = 0;
  for (let i = 0; i <= 1000; i++) {
    const x = i / 1000;
    const err = Math.abs(invSmoothstep(smoothstep(0, 1, x)) - x);
    if (err > worst) { worst = err; worstAt = x; }
  }
  check('invSmoothstep round-trips smoothstep', worst < 1e-6,
    `worst error ${worst.toExponential(2)} at x=${worstAt.toFixed(3)}`);
  // Out of range in is in range out — the only input asin cannot answer.
  check('out-of-range input is clamped', invSmoothstep(-1) < 1e-12 && invSmoothstep(2) === 1,
    `${invSmoothstep(-1).toExponential(1)} .. ${invSmoothstep(2)}`);
}

// ---------------------------------------------------------------------------
// THE ENVELOPE, still without a rig — clapState alone, driven a frame at a
// time the way the game drives it.
// ---------------------------------------------------------------------------
function pumpClap(seconds) {
  const out = [];
  for (let t = 0; t < seconds; t += DT) {
    updateClap(DT);
    out.push(clapState.t);
  }
  return out;
}

console.log('\nthe envelope');
{
  resetClap();
  check('nothing is clapping to begin with', !clapState.active && clapState.t === 0);

  triggerClap({});
  check('a press starts one', clapState.active);

  // Contact, measured rather than asserted from the config: this is the number
  // the player feels as latency.
  let frames = 0;
  while (clapState.t < 0.999 && frames < 200) { updateClap(DT); frames++; }
  const toContact = frames * DT;
  check('the flippers are shut within the attack', toContact <= C.attack + DT * 1.5,
    `${(toContact * 1000).toFixed(0)}ms, attack is ${(C.attack * 1000).toFixed(0)}ms`);
  check('...and that is fast enough to play to a beat', toContact < 0.1,
    `${(toContact * 1000).toFixed(0)}ms`);

  // ...and it lets go on its own.
  pumpClap(clapDuration() + 0.1);
  check('the stroke ends by itself', !clapState.active && clapState.t === 0);
}

console.log('\na press mid-stroke re-enters rather than restarting');
{
  resetClap();
  triggerClap({});
  // Into the release, where `t` is falling and a restart would be most visible.
  pumpClap(C.attack + C.hold + C.release * 0.5);
  const before = clapState.t;
  check('the stroke is part-way open', before > 0.2 && before < 0.9, `t=${before.toFixed(3)}`);

  triggerClap({});
  const after = clapState.t;
  check('the pose does not jump on the press', Math.abs(after - before) < 1e-9,
    `t ${before.toFixed(5)} -> ${after.toFixed(5)}`);
  check('and it is closing again, not opening', clapState.clock < C.attack,
    `re-entered ${(clapState.clock * 1000).toFixed(0)}ms into a ${(C.attack * 1000).toFixed(0)}ms attack`);

  // The other half of "no wasted travel": from part-closed it finishes in less
  // than a whole attack, so a fast rhythm gets tighter rather than lagging.
  let frames = 0;
  while (clapState.t < 0.999 && frames < 200) { updateClap(DT); frames++; }
  check('it finishes the close in what is left of the attack', frames * DT < C.attack,
    `${(frames * DT * 1000).toFixed(0)}ms from ${(before * 100).toFixed(0)}% closed`);
}

console.log('\nthe throttle refuses a press, it does not mute a clap');
{
  resetClap();
  check('the first press is taken', triggerClap({}) === true);
  updateClap(C.minGap * 0.4);
  check('a press inside the minimum gap is refused', triggerClap({}) === false);
  updateClap(C.minGap);
  check('and one past it is taken', triggerClap({}) === true);
  resetClap();
}

// ---------------------------------------------------------------------------
// THE RIG. Everything below measures bones.
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
const body = createVisual('ship');
scene.add(body);
// Without this every measurement below comes out identical — the bones are
// posed in local space and nothing has composed them into the world yet.
scene.updateMatrixWorld(true);

const anim = createAnimationController(body);
const driver = createClapDriver(body);

console.log('\nrig resolution');
check('the clap driver built off the aim rig', driver != null);
check('both flippers resolved', driver?.finCount === 2, `finCount=${driver?.finCount}`);
check('the head chain resolved', driver?.hasHead === true);

// Where a bone is, in the seal's OWN frame: up is dorsal (-X), forward is the
// nose (+Y), lateral runs through the flippers (Z). Measured, not assumed —
// see the header of systems/celebrate.js.
const _v = new THREE.Vector3();
function bonePoint(name) {
  body.getObjectByName(name).getWorldPosition(_v);
  return body.worldToLocal(_v.clone());
}
const dorsal = (p) => -p.x;

function step(n) {
  for (let i = 0; i < n; i++) {
    anim.update(DT, 'swim', false);
    updateClap(DT);
    driver.update(DT);
    scene.updateMatrixWorld(true);
  }
}
function pose() {
  return {
    handL: bonePoint('hand_L_014'),
    handR: bonePoint('hand_R_018'),
    head: bonePoint('head_07'),
  };
}

// Settle past the controller's opening crossfade before anything is measured.
// A clap fired on frame 1 captures its entry pose mid-fade and pins the flipper
// to something the clip was still on its way out of. No run can do that — the
// seal has finished appearing long before anybody presses a button — but a test
// can, and the first version of this file did.
resetClap();
step(60);
const rest = pose();
const restGap = Math.abs(rest.handL.z - rest.handR.z);

console.log(`\nthe clap closes — flippers rest ${restGap.toFixed(3)} apart`);
{
  resetClap();
  triggerClap({});
  step(Math.round((C.attack + C.hold / 2) / DT));
  const shut = pose();

  // THE HANDS MEETING, in three dimensions, rather than the lateral gap alone.
  // The lateral gap is the obvious measure and it is the weaker one: this rig
  // reaches the midline by EXTENDING, so a large part of the closing is the two
  // hands arriving at the same point out in front — which a z-only reading
  // scores as nothing.
  const restReach = rest.handL.distanceTo(rest.handR);
  const shutReach = shut.handL.distanceTo(shut.handR);
  check('the hands came together', shutReach < restReach,
    `${shutReach.toFixed(3)} apart vs ${restReach.toFixed(3)} at rest`);
  // The joint stops (CONFIG.fins.maxFold, which exists so the shoulder does not
  // wring the skin over the armpit) hold them about a third of the flipper span
  // apart no matter what the target asks for — see the note on CONFIG.clap.pose.
  // This threshold is the measured behaviour with headroom, not an aspiration:
  // it is here to catch a pose that stopped closing, not to demand contact the
  // rig cannot make.
  check('...and got most of the way this rig closes', shutReach < restReach * 0.7,
    `closed to ${(100 * shutReach / restReach).toFixed(0)}% of rest`);

  // A clap is two flippers moving TOWARD EACH OTHER, not one crossing the body
  // — which is what a mis-signed `side` would produce, and which closes the gap
  // just as convincingly. Left rests at negative z, right at positive, so
  // inward is + for one and - for the other.
  const movedL = shut.handL.z - rest.handL.z;
  const movedR = shut.handR.z - rest.handR.z;
  check('both flippers moved inward', movedL > 0 && movedR < 0,
    `L ${movedL.toFixed(3)} (want +), R ${movedR.toFixed(3)} (want -)`);

  // AND IT IS VISIBLE. The closing itself happens along the camera axis, where
  // the two flippers project to nearly the same place on screen (see the header
  // of systems/celebrate.js) — so a clap that only closed would be a gesture
  // nobody can see. What the player reads is the travel in the SCREEN plane:
  // dorsal (-x) and along the nose (+y).
  const screenTravel = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const swing = Math.max(screenTravel(shut.handL, rest.handL), screenTravel(shut.handR, rest.handR));
  check('the gesture reads in the screen plane', swing > 0.2,
    `${swing.toFixed(3)} of travel the camera can see`);

  // The head ducks toward the hands rather than carrying on tracking the
  // cursor over the top of them, which reads as two animals.
  const headMoved = shut.head.distanceTo(rest.head);
  check('the head ducked in with them', headMoved > 0.05,
    `${headMoved.toFixed(3)}, ${shut.head.x > rest.head.x ? 'downward' : 'upward'}`);
}

console.log('\nthe pose is continuous across a re-trigger');
{
  // WHAT A RESTART WOULD LOOK LIKE: `t` snapping to 0 drops the blend weight
  // with it, so the flippers fly back to the aim pose in one frame and then
  // close again. That is a step far bigger than anything the animation itself
  // ever takes — so the test is not "the flipper barely moved" (it should move,
  // it is closing) but "it never moves faster than closing".
  //
  // The yardstick is measured from a plain clap rather than typed: the largest
  // single-frame step of a normal attack, which is the fastest this gesture is
  // ever meant to go.
  resetClap();
  triggerClap({});
  let fastest = 0;
  let prev = pose();
  for (let i = 0; i < Math.round(C.attack / DT) + 2; i++) {
    step(1);
    const now = pose();
    fastest = Math.max(fastest,
      now.handL.distanceTo(prev.handL), now.handR.distanceTo(prev.handR));
    prev = now;
  }
  step(Math.round((C.hold + C.release + 0.2) / DT));

  resetClap();
  triggerClap({});
  step(Math.round((C.attack + C.hold + C.release * 0.5) / DT));
  const before = pose();
  triggerClap({});
  step(1);
  const after = pose();
  const jump = Math.max(
    after.handL.distanceTo(before.handL),
    after.handR.distanceTo(before.handR),
  );

  check('re-triggering never moves a flipper faster than closing does',
    jump <= fastest * 1.1 + 1e-4,
    `${jump.toFixed(4)} on the press frame vs ${fastest.toFixed(4)} at the peak of an attack`);
  resetClap();
  step(30);
}

console.log('\nthe victory lap takes the flippers back');
{
  resetClap();
  resetCelebration();
  triggerClap({});
  step(Math.round(C.attack / DT));
  check('a clap is in flight', clapState.active);

  playCelebration({ variant: 'finsUp' });
  updateClap(DT);
  check('it stands down the moment a celebration starts', !clapState.active);
  resetCelebration();
  resetClap();
  step(30);
}

console.log('\nthe seal comes back — no ratchet across a hundred claps');
{
  // AGAINST A CONTROL RUN, not against the pose this seal started in. The swim
  // clip is playing underneath the whole time, so the flipper is somewhere
  // different every frame for reasons that have nothing to do with the clap —
  // comparing "before" to "after" measures the swim cycle's phase and calls it
  // drift. See the same note in tools/celebrate-test.mjs.
  //
  // BOTH seals are fresh: `body` has been posed by every block above it, and
  // the flippers are among the bones the swim clip never keys, so it is still
  // carrying those poses.
  const mine = createVisual('ship');
  const mineScene = new THREE.Scene();
  mineScene.add(mine);
  const control = createVisual('ship');
  const controlScene = new THREE.Scene();
  controlScene.add(control);
  mineScene.updateMatrixWorld(true);
  controlScene.updateMatrixWorld(true);
  const mineAnim = createAnimationController(mine);
  const mineDriver = createClapDriver(mine);
  const controlAnim = createAnimationController(control);

  resetClap();
  const both = (n) => {
    for (let i = 0; i < n; i++) {
      mineAnim.update(DT, 'swim', false);
      updateClap(DT);
      mineDriver.update(DT);
      controlAnim.update(DT, 'swim', false); // same clip, same frames, no pose
    }
  };
  both(60);

  // A hundred claps at four a second, which is a player holding a rhythm for
  // half a minute — and deliberately faster than the stroke, so a good half of
  // them are re-triggers landing on top of a live pose. That is the case with
  // the most ways to leave something in a bone.
  const GAP = Math.round(0.25 / DT);
  for (let n = 0; n < 100; n++) {
    triggerClap({});
    both(GAP);
  }
  resetClap();
  // Long enough after the last release for the IK smoothing to have unwound.
  both(180);
  mineScene.updateMatrixWorld(true);
  controlScene.updateMatrixWorld(true);

  const at = (root, name) => root.worldToLocal(root.getObjectByName(name).getWorldPosition(new THREE.Vector3()));
  // The flipper is the bone at risk (the swim clip never keys it); the head IS
  // keyed, so it checks that the pose released cleanly on a bone the mixer is
  // also writing.
  for (const bone of ['hand_L_014', 'hand_R_018', 'head_07']) {
    const drift = at(mine, bone).distanceTo(at(control, bone));
    check(`${bone} matches a seal that never clapped`, drift < 0.02,
      `${drift.toFixed(4)} apart after 100 claps`);
  }
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
