#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:celebrate
//
// Exercises the boss-kill victory lap on the REAL rigs — furseal.glb for the
// player's procedural poses and sealhelper.glb for the escorts' authored clap.
//
// What this can say that a boneless smoke test cannot:
//
//   * the poses MOVE THE RIGHT PARTS OF THE ANIMAL. Every assertion below is a
//     measured world position of a bone, not "some quaternion changed" — bone
//     names lie, and a pose that drives the wrong joint still animates.
//   * the peak lands on the trophy frame. This is the whole reason the system
//     runs on the wall clock, and it is invisible in every other kind of test:
//     the kill shot drops the world to 0.12x, so a celebration on the game
//     clock would be caught in its first twitch in every snapshot forever.
//   * the seal comes back. An IK pose that ratchets leaves the flippers a
//     little further out every boss, which nobody notices until the eighth.
//   * the escorts' clip actually contains a clap where the config says it does
//     (2.20s into 3.47s), which is what CONFIG.animation.states.celebrate
//     .startAt is pinned to.
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
  celebrationState, startCelebration, playCelebration, updateCelebration, resetCelebration,
  createCelebrationDriver, snapshotMoment, celebrationSpin, celebrationFacing, CELEBRATION_VARIANTS,
} from '../path/src/systems/celebrate.js';
import { cardsArriveAt } from '../path/src/systems/levelUpTime.js';
// For the salute, which is the one pose measured at the CHAIN TIPS rather than
// at the bones — see that block for why the bones cannot see it.
import { createPoseRig } from '../path/src/systems/poseRig.js';
import { tipWorld } from '../path/src/systems/ikChain.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEAL = resolve(HERE, '../public/models/furseal.glb');
const HELPER = resolve(HERE, '../public/models/sealhelper.glb');

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

for (const p of [SEAL, HELPER]) {
  if (!existsSync(p)) {
    console.error(`\nmissing ${p} — the rig has to be in public/models for the game to load it too.\n`);
    process.exit(1);
  }
}

async function loadGltf(path) {
  const buf = readFileSync(path);
  return new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
}

const sealGltf = await loadGltf(SEAL);
installModel('ship', sealGltf.scene, sealGltf.animations);

const scene = new THREE.Scene();
const body = createVisual('ship');
scene.add(body);
// Without this every measurement below comes out identical — the bones are
// posed in local space and nothing has composed them into the world yet.
scene.updateMatrixWorld(true);

const anim = createAnimationController(body);
const driver = createCelebrationDriver(body);

// How long a whole performance lasts, computed rather than read off
// celebrationState — which is zero whenever nothing is playing, and reading it
// between runs is how the first version of this file "verified" that the pose
// had released after 0.3 seconds.
const fullDuration = () => snapshotMoment() - CONFIG.celebrate.peakLead
  + CONFIG.celebrate.hold + CONFIG.celebrate.release;

console.log('\nrig resolution');
check('the celebration driver built off the aim rig', driver != null);
check('both flippers resolved', driver?.finCount === 2, `finCount=${driver?.finCount}`);
check('the head chain resolved', driver?.hasHead === true);
check('the tail chain resolved', driver?.hasTail === true);

// Where a bone is, in the seal's OWN frame: up is dorsal (-X), forward is the
// nose (+Y), lateral runs through the flippers (Z). Measured, not assumed —
// see the header of systems/celebrate.js.
const _v = new THREE.Vector3();
function bonePoint(name) {
  const b = body.getObjectByName(name);
  b.getWorldPosition(_v);
  return body.worldToLocal(_v.clone());
}
const dorsal = (p) => -p.x; // higher = further up the seal's back
const rest = {
  handL: bonePoint('hand_L_014'),
  handR: bonePoint('hand_R_018'),
  head: bonePoint('head_07'),
  tail: bonePoint('tail02_023'),
};

const DT = 1 / 60;

// THE VIRGIN SKELETON, taken before anything has posed it.
//
// Every block below drives the SAME `body`, and the flippers are among the
// bones the swim clip never keys — so a pose left in them by one block is
// still there for the next one, and each block was measuring the residue of
// the four before it as well as its own pose. (That is a real property of the
// rig rather than a quirk of the harness; the ratchet block further down
// builds two fresh seals for exactly this reason, and says so.)
//
// It shows up as a threshold that drifts a couple of points whenever an
// EARLIER pose changes — the clap's contact moved from 53% of rest to 55%
// when the poses above it started layering, on a clap that is identical to the
// float on a seal that has not been posed before. Restoring this before each
// run makes every block measure its own pose against the same zero the `rest`
// baseline was taken at.
const virginQ = new Map();
body.traverse((o) => { if (o.isBone) virginQ.set(o, o.quaternion.clone()); });
const unpose = () => { for (const [bone, q] of virginQ) bone.quaternion.copy(q); };
// Drive one variant to a given wall-clock moment and hand back the pose. The
// animation controller runs alongside it exactly as it does in the game, so
// these are measurements of the celebration layered OVER the swim cycle rather
// than of a pose sitting on a bind skeleton by itself.
function runTo(variant, seconds, { locomotion = 'swim', peakAt = null, hold = null, release = null } = {}) {
  resetCelebration();
  driver.reset();
  unpose();
  // Force the variant rather than rolling for it: a test at the mercy of a
  // coin flip is a test that fails on somebody else's machine.
  // `hold` and `release` matter for anything sampled after the peak: without
  // them a gesture with its own long hold (the salute) is run on the boss
  // kill's much shorter one, and a sample taken where the shipped pose would
  // still be held lands most of the way through this performance's release.
  if (peakAt) playCelebration({ variant, peakAt, hold, release, escorts: false });
  else startCelebration(fixedRng(variant));
  let t = 0;
  while (t < seconds) {
    anim.update(DT, locomotion, false);
    updateCelebration(DT);
    driver.update(DT);
    scene.updateMatrixWorld(true);
    t += DT;
  }
  return {
    handL: bonePoint('hand_L_014'),
    handR: bonePoint('hand_R_018'),
    head: bonePoint('head_07'),
    tail: bonePoint('tail02_023'),
    // The somersault is not written to the body by the driver — it is an angle
    // entities/player.js folds into its own quaternion composition. Asking for
    // it the same way the game does is the point: a test that read
    // body.quaternion instead would be measuring its own harness.
    spin: celebrationSpin(),
  };
}

// An rng that passes the chance roll and then lands on the variant we want, by
// picking the weight bucket it lives in.
function fixedRng(variant) {
  const weights = CONFIG.celebrate.weights;
  const names = Object.keys(weights).filter((k) => weights[k] > 0);
  const total = names.reduce((s, k) => s + weights[k], 0);
  let before = 0;
  for (const n of names) {
    if (n === variant) break;
    before += weights[n];
  }
  // Aim at the middle of this variant's slice, so a weight tweak can't slide
  // the test onto its neighbour.
  const pick = (before + weights[variant] / 2) / total;
  const queue = [0, pick];
  let i = 0;
  return () => queue[Math.min(i++, queue.length - 1)];
}

console.log('\nthe variants are all reachable');
// THE ROLLED ROSTER, which is not the same as the pose roster any more: the
// salute is PRESSED at a headstone (systems/salute.js) and has no weight, so a
// loop over every pose in the file would demand a boss kill be able to roll a
// gesture that is only meaningful in front of a grave. Checked from the
// weights themselves, so retiring a variant by zeroing it retires its check
// with it rather than failing here.
const ROLLED = Object.keys(CONFIG.celebrate.weights).filter((k) => CONFIG.celebrate.weights[k] > 0);
for (const v of ROLLED) {
  resetCelebration();
  const got = startCelebration(fixedRng(v));
  check(`"${v}" can be rolled`, got === v, `rolled ${got}`);
}

const SNAP = snapshotMoment();
console.log(`\nthe trophy frame is grabbed ${SNAP.toFixed(3)}s (wall) after the kill`);

console.log('\nfinsUp — both flippers over the head at the shutter');
{
  const p = runTo('finsUp', SNAP);
  const liftL = dorsal(p.handL) - dorsal(rest.handL);
  const liftR = dorsal(p.handR) - dorsal(rest.handR);
  check('the left flipper is up', liftL > 0.35, `+${liftL.toFixed(3)} dorsal`);
  check('the right flipper is up', liftR > 0.35, `+${liftR.toFixed(3)} dorsal`);
  check('both went up together', Math.abs(liftL - liftR) < 0.45, `L ${liftL.toFixed(2)} vs R ${liftR.toFixed(2)}`);
  check('the head followed them up', dorsal(p.head) > dorsal(rest.head), `${dorsal(p.head).toFixed(3)} vs ${dorsal(rest.head).toFixed(3)} at rest`);
}

console.log('\nclap — the flippers are TOGETHER on the shutter, not wide open');
{
  const atPeak = runTo('clap', SNAP);
  const gapAtPeak = Math.abs(atPeak.handL.z - atPeak.handR.z);
  const restGap = Math.abs(rest.handL.z - rest.handR.z);
  check('the flippers closed', gapAtPeak < restGap, `${gapAtPeak.toFixed(3)} vs ${restGap.toFixed(3)} at rest`);
  // The half-integer `beats` is what puts a contact ON the shutter, and this
  // is the assertion that catches somebody rounding it to 2.
  //
  // AGAINST THE CEILING THIS RIG ACTUALLY CLOSES TO, measured, the way the
  // salute block further down does it — not against a hand-typed fraction of
  // rest. The flippers spread along the camera axis and the solver eases
  // toward its target rather than arriving, so a clap is asymptotic and how
  // far it gets depends on the swim phase it started from. The old 0.55 was
  // not measuring that: it was measuring the RESIDUE of the four poses this
  // file runs before this one (the flippers are unkeyed, so each block
  // inherited the last one's pose), and it moved from 53% to 55% of rest when
  // those earlier poses changed — on a clap identical to the float.
  //
  // The honest question is the one the beat count decides: does the contact
  // land on the trophy frame, or a beat either side of it.
  const ceiling = (() => {
    const long = runTo('clap', 4, { peakAt: 4 });
    return Math.abs(long.handL.z - long.handR.z);
  })();
  check('they are near contact on the trophy frame', gapAtPeak < ceiling * 1.12,
    `${gapAtPeak.toFixed(3)} on the shutter against a measured ${ceiling.toFixed(3)} ceiling (${(100 * gapAtPeak / restGap).toFixed(0)}% of rest)`);
  // ...AND THE BEAT COUNT ITSELF, exactly, which is the half of it a measured
  // ceiling cannot say. The ceiling is taken with the same `beats`, so a
  // rounded one moves both numbers together and the comparison above is happy
  // with a clap that is wide open on the shutter. `close` at full phase is
  // (1 - cos(2*pi*beats)) / 2 — 1 on a half-integer, 0 on a whole one.
  // ...OFF THE MERGED CONFIG, which is the value the game will actually use.
  // `celebrate` was a full copy in imported-tuning.json until this was
  // written, and a saved block REPLACES what config.js declares leaf by leaf —
  // so every number in the celebrate block was dead text, and a `beats`
  // retuned here would not have moved the game at all. The snapshot's copy has
  // been dropped and the check below is on the merged value, which is true
  // either way.
  const beats = CONFIG.celebrate.poses.clap.beats;
  check('...because the beat count puts a contact ON the shutter',
    (1 - Math.cos(Math.PI * 2 * beats)) / 2 > 0.98,
    `beats ${beats} closes to ${((1 - Math.cos(Math.PI * 2 * beats)) / 2).toFixed(2)} at the peak`);
  // ...and nothing may shadow the block again. A `celebrate` key in the
  // snapshot is not a tuning, it is config.js's own numbers copied out and
  // frozen: the first edit to any of them after that is a change nobody can
  // see happen. Same failure as the replay camera pool's `shots` array.
  {
    const snap = JSON.parse(readFileSync(resolve(HERE, '../path/src/imported-tuning.json'), 'utf8'));
    check('no tuning snapshot is shadowing the celebration block',
      snap?.celebrate === undefined, 'imported-tuning.json holds a `celebrate` block');
  }
  check('and they came up into frame first', dorsal(atPeak.handL) > dorsal(rest.handL),
    `+${(dorsal(atPeak.handL) - dorsal(rest.handL)).toFixed(3)} dorsal`);

  // A clap is two flippers moving TOWARD EACH OTHER, not one flipper crossing
  // the body — which is what a mis-signed `side` would produce, and it would
  // still close the gap.
  const movedL = atPeak.handL.z - rest.handL.z;
  const movedR = atPeak.handR.z - rest.handR.z;
  check('both flippers moved inward', movedL > 0 && movedR < 0,
    `L ${movedL.toFixed(3)} (want +), R ${movedR.toFixed(3)} (want -)`);
}

console.log('\nflip — a somersault in the screen plane that lands square');
{
  const mid = runTo('flip', SNAP);
  // How far from upright the seal is, folded into 0..PI — a full turn is
  // square again, which is exactly the property being asserted below.
  const offUpright = (a) => {
    const wrapped = Math.abs(((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2));
    return Math.min(wrapped, Math.PI * 2 - wrapped);
  };
  check('the seal is mid-turn on the trophy frame', offUpright(mid.spin) > 0.6,
    `${(offUpright(mid.spin) * 180 / Math.PI).toFixed(0)} degrees off upright`);
  // The rotation is NOT enveloped, so it has to land on a whole turn by
  // itself — see the note on celebrationSpin about unwinding.
  const done = runTo('flip', fullDuration() + 0.2);
  check('and it finishes square, not part-rotated', offUpright(done.spin) < 0.08,
    `${(offUpright(done.spin) * 180 / Math.PI).toFixed(1)} degrees off upright at the end`);
  check('the flip is the only variant that spins the body', celebrationSpin() === 0 || celebrationState.variant === 'flip');
}

console.log('\ntailWag — the tail sweeps in the plane the camera can see');
{
  let minD = Infinity, maxD = -Infinity;
  for (let t = 0.1; t <= SNAP + 0.3; t += 0.05) {
    const p = runTo('tailWag', t);
    minD = Math.min(minD, dorsal(p.tail));
    maxD = Math.max(maxD, dorsal(p.tail));
  }
  // In the screen plane (dorsal), not through depth — a sweep along Z would
  // be a tail wagging straight at the camera, which reads as nothing at all.
  check('the tail swept through the screen plane', maxD - minD > 0.25,
    `${(maxD - minD).toFixed(3)} of dorsal travel`);
}

console.log('\nheadToss — the head goes back and up');
{
  const p = runTo('headToss', SNAP);
  check('the head is thrown up', dorsal(p.head) - dorsal(rest.head) > 0.2,
    `+${(dorsal(p.head) - dorsal(rest.head)).toFixed(3)} dorsal`);
}

console.log('\nsalute — the right flipper reaches the head, the left one does not');
{
  // A FRESH SEAL, for the same reason the ratchet block below builds two: the
  // shared `body` has been posed by every block above this one, and `unpose()`
  // restores bones the MIXER is driving — which poisons its value-unchanged
  // cache and quietly parks the shoulder at bind instead of on the swim cycle
  // (the trap systems/poseRig.js documents). It is worth naming because it
  // does not look like a harness problem: the salute still plays, the flipper
  // still travels most of the way, and it settles 1.19 from the head against
  // the 0.53 a seal in a run reaches — a miss you would go looking for in the
  // pose.
  const seal = createVisual('ship');
  const salScene = new THREE.Scene();
  salScene.add(seal);
  salScene.updateMatrixWorld(true);
  const salAnim = createAnimationController(seal);
  const salDriver = createCelebrationDriver(seal);
  const probe = createPoseRig(seal, 'salute-probe');

  // AT THE TIPS, and this is not a refinement — it is the difference between
  // measuring the pose and measuring nothing. The bones are not the ends of
  // the limbs: hand_R_018 sits well inside the flipper and head_07 well inside
  // the skull, and both tip lengths point roughly at each other, so a
  // bone-to-bone distance carries about 0.9 of constant that no pose can ever
  // remove. The salute closing from 2.9 to 0.5 at the tips reads there as 1.19
  // to 1.10 — a pose that barely moves.
  const _tip = new THREE.Vector3();
  const _headTip = new THREE.Vector3();
  const tipOf = (chain) => {
    chain.bones[0].updateWorldMatrix(true, true);
    return tipWorld(chain, _tip, 1).clone();
  };
  const headTip = () => {
    probe.head.bones[0].updateWorldMatrix(true, true);
    return tipWorld(probe.head, _headTip, 1).clone();
  };
  const finOf = (side) => probe.fins.find((f) => (side > 0 ? f.side > 0 : f.side < 0)).chain;

  // Settle first — the controller crossfades into its opening state over the
  // first fifth of a second, and a celebration started before that captures an
  // entry pose the clip is still on its way out of.
  resetCelebration();
  for (let i = 0; i < 60; i++) {
    salAnim.update(DT, 'swim', false);
    salDriver.update(DT);
    salScene.updateMatrixWorld(true);
  }
  const restHead = headTip();
  const restR = tipOf(finOf(1)).distanceTo(restHead);
  const restL = tipOf(finOf(-1)).distanceTo(restHead);

  // MID-HOLD, on the salute's OWN clock — not on the peak. The IK chains slerp
  // toward their solution (celebrate.ik.smoothing is 14), so the pose is still
  // arriving for a few frames after the envelope says it got there.
  playCelebration({
    variant: 'salute',
    peakAt: CONFIG.salute.peakAt,
    hold: CONFIG.salute.hold,
    release: CONFIG.salute.release,
    escorts: false,
    facing: { x: CONFIG.salute.lean, y: 1 },
  });
  const frames = Math.ceil((CONFIG.salute.peakAt + CONFIG.salute.hold * 0.5) / DT);
  for (let i = 0; i < frames; i++) {
    salAnim.update(DT, 'swim', false);
    updateCelebration(DT);
    salDriver.update(DT);
    salScene.updateMatrixWorld(true);
  }

  const head = headTip();
  const toHeadR = tipOf(finOf(1)).distanceTo(head);
  const toHeadL = tipOf(finOf(-1)).distanceTo(head);
  check('the saluting flipper closes on the head',
    toHeadR < restR * 0.2, `${toHeadR.toFixed(3)} against ${restR.toFixed(3)} at rest`);
  check('...and the other one does not', toHeadL > toHeadR * 3,
    `L ${toHeadL.toFixed(3)} vs R ${toHeadR.toFixed(3)}`);
  // Both flippers end up nearer the head than they started, because the head
  // itself comes down and back to be reachable — so the check that matters is
  // that the saluting one travels several times as far. A `side` test with the
  // sign the wrong way round passes every distance check above and fails this.
  check('...and the travel is the saluting flipper\'s',
    (restR - toHeadR) > (restL - toHeadL) * 2.5,
    `R closed ${(restR - toHeadR).toFixed(3)}, L ${(restL - toHeadL).toFixed(3)}`);
  // A touch at the brow, not a flipper through the skull: `browOut` holds it
  // out along the camera axis, which is the axis the side view cannot show and
  // the one a designer will not catch by looking.
  check('the touch is held off the head rather than inside it',
    toHeadR > 0.05, `${toHeadR.toFixed(3)} from the head tip`);

  // ...AND THE ANIMAL TURNS. The other half of this pose is not in the
  // flippers at all (celebrationFacing), and it is asked for rather than
  // written — so a driver that quietly stopped publishing it would leave a
  // seal saluting a headstone while swimming past it.
  const face = celebrationFacing();
  check('the body is asked to stand upright', face && face.y > Math.abs(face.x),
    face ? `x ${face.x.toFixed(2)} y ${face.y.toFixed(2)} w ${face.weight.toFixed(2)}` : 'null');
  check('...at full weight while the pose is held', face && face.weight > 0.99,
    face ? face.weight.toFixed(3) : 'null');

  resetCelebration();
  salDriver.update(DT);
}

console.log('\nthe seal comes back — no ratchet across repeated celebrations');
{
  // AGAINST A CONTROL RUN, not against the pose this seal started in. The swim
  // clip is still playing underneath the whole time, so the flipper is
  // somewhere different every frame for reasons that have nothing to do with
  // the celebration — comparing "before" to "after" measures the swim cycle's
  // phase and calls it drift. (The first version of this check did exactly
  // that and reported 0.28 of ratchet that was not there.)
  //
  // So: a second seal, same model, same number of animation frames, no
  // celebrations. Whatever the celebrating one does NOT share with it is the
  // ratchet.
  // BOTH seals are fresh. `body` has been posed by every block above it, and
  // the flippers are among the bones the swim clip never keys — so it is
  // carrying those poses still, and comparing it to a virgin control measures
  // the earlier tests rather than the ratchet. (That is a real property of the
  // rig, not a quirk of the harness: see the entryQ note in celebrate.js.)
  const mine = createVisual('ship');
  const mineScene = new THREE.Scene();
  mineScene.add(mine);
  const control = createVisual('ship');
  const controlScene = new THREE.Scene();
  controlScene.add(control);
  mineScene.updateMatrixWorld(true);
  controlScene.updateMatrixWorld(true);
  const mineAnim = createAnimationController(mine);
  const mineDriver = createCelebrationDriver(mine);
  const controlAnim = createAnimationController(control);

  resetCelebration();

  // Settle both first. The controller crossfades INTO its opening state over
  // the first fifth of a second, so a celebration started on frame 1 captures
  // its entry pose mid-fade and pins the flipper to a pose the clip was still
  // on its way out of. No run can do that — a boss cannot die before the seal
  // has finished appearing — but a test can, and did.
  for (let i = 0; i < 60; i++) {
    mineAnim.update(DT, 'swim', false);
    mineDriver.update(DT);
    controlAnim.update(DT, 'swim', false);
  }

  const FRAMES = Math.ceil((fullDuration() + 0.1) / DT);
  // Eight celebrations, which is what a long run actually produces.
  for (let n = 0; n < 8; n++) {
    resetCelebration();
    startCelebration(fixedRng(CELEBRATION_VARIANTS[n % CELEBRATION_VARIANTS.length]));
    for (let i = 0; i < FRAMES; i++) {
      mineAnim.update(DT, 'swim', false);
      updateCelebration(DT);
      mineDriver.update(DT);
      controlAnim.update(DT, 'swim', false); // same clip, same frames, no pose
    }
  }
  resetCelebration();
  // Long enough after the last release for the IK smoothing to have unwound.
  for (let i = 0; i < 120; i++) {
    mineAnim.update(DT, 'swim', false);
    mineDriver.update(DT);
    controlAnim.update(DT, 'swim', false);
  }
  mineScene.updateMatrixWorld(true);
  controlScene.updateMatrixWorld(true);

  const at = (root, name) => root.worldToLocal(root.getObjectByName(name).getWorldPosition(new THREE.Vector3()));
  // The flipper is the bone at risk (the swim clip never keys it); the head and
  // tail ARE keyed, so they check that the pose released cleanly on bones the
  // mixer is also writing.
  for (const bone of ['hand_L_014', 'hand_R_018', 'head_07', 'tail02_023']) {
    const drift = at(mine, bone).distanceTo(at(control, bone));
    check(`${bone} matches a seal that never celebrated`, drift < 0.02,
      `${drift.toFixed(4)} apart after 8 celebrations`);
  }
}

// ---------------------------------------------------------------------------
// THE LEVEL-UP SALUTE, on the real rig.
//
// The same poses on a MUCH shorter clock: the boss kill peaks at the trophy
// shutter, over a second in, while a level has to be reacted to inside the
// beat the cards are held back for. That difference is not free — the IK
// chains slerp toward their solution at CONFIG.celebrate.ik.smoothing per
// second, so a pose given half the time may simply never arrive, and the
// symptom is a seal that gestures vaguely instead of saluting. Nothing in the
// timing test (npm run test:salute) can see that; it takes bones.
//
// tools/levelup-salute-test.mjs owns the beat, the snap zoom and the roll.
// This owns the one question only the rig can answer: does the animal actually
// get there in time.
// ---------------------------------------------------------------------------
console.log('\nthe level-up salute reaches full height inside its own beat');
{
  const sal = CONFIG.levelUp.salute;
  const cards = cardsArriveAt();
  // main.js's startSalute, derived rather than copied — see the note there.
  const peak = Math.max(0.05, cards - (sal.poseLead ?? 0.12));

  // A FRESH PAIR OF SEALS, one saluting and one only swimming, for the reason
  // the ratchet test above builds its own: every measurement here is the
  // difference between them on the same frame, and the shared `body` at this
  // point in the file is carrying eight celebrations' worth of swim phase.
  // Measured against the `rest` captured at the top instead, the right flipper
  // reads +0.05 where the left reads +0.51 — which is the swim cycle, not the
  // pose, and it looks exactly like a broken chain.
  const mine = createVisual('ship');
  const mineScene = new THREE.Scene();
  mineScene.add(mine);
  const control = createVisual('ship');
  const controlScene = new THREE.Scene();
  controlScene.add(control);
  mineScene.updateMatrixWorld(true);
  controlScene.updateMatrixWorld(true);
  const mineAnim = createAnimationController(mine);
  const mineDriver = createCelebrationDriver(mine);
  const controlAnim = createAnimationController(control);

  // Settle both past the controller's opening crossfade, or the celebration
  // captures its entry pose mid-fade. Same reason as the ratchet test.
  resetCelebration();
  for (let i = 0; i < 60; i++) {
    mineAnim.update(DT, 'swim', false);
    mineDriver.update(DT);
    controlAnim.update(DT, 'swim', false);
  }

  const at = (root, name) => root.worldToLocal(root.getObjectByName(name).getWorldPosition(new THREE.Vector3()));

  // Salute on one seal, plain swim on the other, frame for frame.
  //
  // ALWAYS RUN TO COMPLETION, and take the measurement from inside the run.
  // Abandoning a performance partway — resetCelebration() while the flippers
  // are still up — skips the one frame on which the driver puts the bones back
  // (see entryQ in celebrate.js), so the NEXT celebration snapshots its entry
  // pose out of the last one's raised flipper and every seal after it is half
  // a metre out. That is a property of the harness, not of the game: a level
  // cannot cancel the salute it just started.
  const BONES = ['hand_L_014', 'hand_R_018', 'head_07'];
  const snap = () => {
    mineScene.updateMatrixWorld(true);
    controlScene.updateMatrixWorld(true);
    const out = { active: celebrationState.active };
    for (const b of BONES) out[b] = { mine: at(mine, b), control: at(control, b) };
    return out;
  };

  // @param cues  wall seconds to photograph the pair at. Returns one snapshot
  //              per cue, in order.
  const runSalute = (variant, cues) => {
    resetCelebration();
    mineDriver.reset();
    playCelebration({
      variant, peakAt: peak, hold: sal.poseHold, release: sal.poseRelease, escorts: false,
    });
    const total = celebrationState.duration + 0.2;
    const shots = [];
    let next = 0;
    for (let t = 0; t < total; t += DT) {
      mineAnim.update(DT, 'swim', false);
      updateCelebration(DT);
      mineDriver.update(DT);
      controlAnim.update(DT, 'swim', false);
      if (next < cues.length && t + DT >= cues[next]) { shots.push(snap()); next++; }
    }
    while (shots.length < cues.length) shots.push(snap());
    return shots;
  };

  // Cued on the frame the cards arrive — the last moment the pose has the
  // screen to itself, and the whole question this block exists to answer.
  const [measured] = runSalute('finsUp', [cards]);
  const lift = (b) => dorsal(measured[b].mine) - dorsal(measured[b].control);
  const liftL = lift('hand_L_014');
  const liftR = lift('hand_R_018');
  // The same bar the boss kill's finsUp is held to. Half a flipper of dorsal
  // travel is the difference between saluting and drifting upward.
  check('both flippers are up by the time the cards land', liftL > 0.35 && liftR > 0.35,
    `L +${liftL.toFixed(3)}, R +${liftR.toFixed(3)} dorsal over a seal that only swam`);
  check('the head went with them', lift('head_07') > 0);
  check('and the pose is still up as they land', measured.active === true);

  // THE CLAP, measured as its own TRAVEL rather than against a resting seal.
  // `close` runs on a raised cosine of 1.5 beats, so the flippers are at their
  // widest two thirds of the way to the peak and in contact on it — the two
  // moments to photograph. A gap compared against a swimming control instead
  // says almost nothing: the pose also lifts the flippers, which carries them
  // outward on this rig, and the two effects very nearly cancel.
  const [open, shut] = runSalute('clap', [peak * (2 / 3), cards]);
  const gapOf = (shot) => Math.abs(shot.hand_L_014.mine.z - shot.hand_R_018.mine.z);
  // HOW CLOSED CAN THIS RIG EVER GET, measured rather than assumed. The
  // flippers do not meet: `close: 0.08` of reach from the centreline is past
  // what the CCD solver will give up under CONFIG.celebrate.ik's fold and bend
  // stops, so the contact is asymptotic and the ceiling depends on the swim
  // phase the clap started from. Given four seconds this seal closes to 75% of
  // its open gap and no further — so the question the salute has to answer is
  // not "do they touch" but "does the beat get them as far as they go".
  const ceiling = (() => {
    resetCelebration();
    mineDriver.reset();
    playCelebration({ variant: 'clap', peakAt: 4, hold: sal.poseHold, release: sal.poseRelease, escorts: false });
    let shot = null;
    for (let t = 0; t < celebrationState.duration; t += DT) {
      mineAnim.update(DT, 'swim', false);
      updateCelebration(DT);
      mineDriver.update(DT);
      controlAnim.update(DT, 'swim', false);
      if (!shot && t + DT >= 4) shot = snap();
    }
    return gapOf(shot) / gapOf(open);
  })();
  const closed = gapOf(shut) / gapOf(open);
  check('the clap visibly closes in the salute\'s shorter beat', closed < 0.85,
    `${gapOf(open).toFixed(3)} wide -> ${gapOf(shut).toFixed(3)} on the cards`);
  check('and gets as far as this rig closes at all', closed < ceiling + 0.05,
    `${(100 * closed).toFixed(0)}% of open, against a ${(100 * ceiling).toFixed(0)}% ceiling`);
  // A clap is two flippers moving TOWARD EACH OTHER — the same assertion the
  // boss kill's clap carries, because one flipper swinging across the other
  // measures as a closing gap just as well.
  const inwardL = shut.hand_L_014.mine.z - open.hand_L_014.mine.z;
  const inwardR = shut.hand_R_018.mine.z - open.hand_R_018.mine.z;
  check('both flippers moved inward', inwardL > 0 && inwardR < 0,
    `L ${inwardL.toFixed(3)} (want +), R ${inwardR.toFixed(3)} (want -)`);
  check('and the contact lands while the pose is still up', shut.active === true);

  // And it lets go on its own, well before the player could have read three
  // cards — a salute still running a second later is a seal that levels up and
  // then forgets to put its flippers down.
  check('the salute releases itself once its clock runs out', celebrationState.active === false);
  // Past the release, with the IK smoothing given time to unwind, both seals
  // have to be in the same place again.
  for (let i = 0; i < 120; i++) {
    mineAnim.update(DT, 'swim', false);
    mineDriver.update(DT);
    controlAnim.update(DT, 'swim', false);
  }
  mineScene.updateMatrixWorld(true);
  controlScene.updateMatrixWorld(true);
  for (const bone of ['hand_L_014', 'hand_R_018', 'head_07']) {
    const drift = at(mine, bone).distanceTo(at(control, bone));
    check(`${bone} comes home after a salute`, drift < 0.02, `${drift.toFixed(4)} apart`);
  }
  resetCelebration();
}

console.log('\nthe pose is actually gone once it releases');
{
  // Against a control seal, for the same reason the ratchet check uses one:
  // "where it was" on a rig whose swim clip leaves five bones unwritten is a
  // question only a second seal can answer honestly. This one is about TIMING
  // rather than accumulation — the pose has to be gone by the time the release
  // says it is, not merely gone eventually.
  const mine = createVisual('ship');
  const mineScene = new THREE.Scene();
  mineScene.add(mine);
  const control = createVisual('ship');
  const controlScene = new THREE.Scene();
  controlScene.add(control);
  const mineAnim = createAnimationController(mine);
  const mineDriver = createCelebrationDriver(mine);
  const controlAnim = createAnimationController(control);

  resetCelebration();
  for (let i = 0; i < 60; i++) {
    mineAnim.update(DT, 'swim', false);
    mineDriver.update(DT);
    controlAnim.update(DT, 'swim', false);
  }
  startCelebration(fixedRng('finsUp'));
  for (let t = 0; t < fullDuration() + 0.3; t += DT) {
    mineAnim.update(DT, 'swim', false);
    updateCelebration(DT);
    mineDriver.update(DT);
    controlAnim.update(DT, 'swim', false);
  }
  mineScene.updateMatrixWorld(true);
  controlScene.updateMatrixWorld(true);
  const at = (root, name) => root.worldToLocal(root.getObjectByName(name).getWorldPosition(new THREE.Vector3()));

  check('the celebration deactivated itself', celebrationState.active === false);
  const drift = at(mine, 'hand_L_014').distanceTo(at(control, 'hand_L_014'));
  check('the flipper is back where the celebration found it', drift < 0.02,
    `${drift.toFixed(4)} from a seal that never celebrated`);
}

// ---------------------------------------------------------------------------
// THE ESCORTS. A different model, a different skeleton, and the only authored
// celebration clip in the game.
// ---------------------------------------------------------------------------
console.log('\nthe escorts\' authored clap');
{
  const helperGltf = await loadGltf(HELPER);
  installModel('sealTeam', helperGltf.scene, helperGltf.animations);
  const escort = createVisual('sealTeam');
  const escortScene = new THREE.Scene();
  escortScene.add(escort);
  escortScene.updateMatrixWorld(true);

  const eAnim = createAnimationController(escort);
  check('the escort rig has a `celebrate` clip', eAnim.clipCoverage.celebrate === true);
  check('the player\'s rig does NOT (it is posed instead)', anim.clipCoverage.celebrate === false);

  // WHERE THE CLAP ACTUALLY IS. CONFIG...startAt is pinned to this number, so
  // the test measures it rather than trusting it: sample the clip end to end
  // and find where the two flippers are closest.
  const clip = THREE.AnimationClip.findByName(escort.userData.clips, 'Seal_Rig|Seal_Rig|Seal_Rig|clapping');
  const mixer = new THREE.AnimationMixer(escort);
  mixer.clipAction(clip).play();
  const hL = escort.getObjectByName('hand_L_013');
  const hR = escort.getObjectByName('hand_R_017');
  let contactAt = 0, closest = Infinity;
  for (let t = 0; t <= clip.duration; t += clip.duration / 200) {
    mixer.setTime(t);
    escortScene.updateMatrixWorld(true);
    const d = hL.getWorldPosition(new THREE.Vector3()).distanceTo(hR.getWorldPosition(new THREE.Vector3()));
    if (d < closest) { closest = d; contactAt = t; }
  }
  console.log(`  (contact measured at ${contactAt.toFixed(2)}s of a ${clip.duration.toFixed(2)}s clip)`);
  const startAt = CONFIG.animation.states.celebrate.startAt;
  check('the clip opens just BEFORE the clap, not at frame 0', startAt > 0 && startAt < contactAt,
    `startAt=${startAt} vs contact at ${contactAt.toFixed(2)}s`);
  check('and opens close enough to reach it', contactAt - startAt < 0.25,
    `${(contactAt - startAt).toFixed(2)}s of lead-in`);

  // The one-shot has to survive long enough to PLAY that clap. maxDuration is
  // what killed the first attempt at this: bark's 0.6s cap handed back before
  // the flippers ever met.
  const cap = CONFIG.animation.states.celebrate.maxDuration;
  check('the one-shot is not capped before the contact', cap == null || cap > contactAt - startAt,
    `maxDuration=${cap}`);

  eAnim.trigger('celebrate');
  check('triggering it takes over the pose', eAnim.isPlayingOneShot() === true);
}

// ---------------------------------------------------------------------------
// THE POSE IS ADDITIVE — the animal underneath is still moving, and its own
// momentum reaches the performance.
//
// Both properties fail SILENTLY and both look like taste from the outside: a
// pose that has stopped layering is just a stiffer pose, and a momentum term
// that has stopped reaching is just a rigid one. The numbers are the only way
// to tell either from a decision.
//
// EVERY MEASUREMENT IS AGAINST A CONTROL SEAL, for the same reason the ratchet
// check is: the swim clip is running underneath the whole time, so a bone is
// somewhere different every frame for reasons that have nothing to do with the
// celebration.
console.log('\nthe celebration is additive, not a replacement');
{
  const POSED = ['hand_L_014', 'hand_R_018', 'head_07', 'tail02_023'];
  const at = (root, name) => root.worldToLocal(root.getObjectByName(name).getWorldPosition(new THREE.Vector3()));

  // One seal, driven for `seconds` with the animal moving as told, sampling
  // every posed bone once the pose is at full weight.
  //
  // `speed` and `turnRate` are written onto the BODY, not passed to the
  // driver — which is the contract: the driver measures the animal's motion
  // off its own world transform, so a test that handed it numbers would be
  // testing a path the game never takes.
  function run({ variant = null, seconds = 1.6, speed = 0, turnRate = 0, sampleFrom = 0.6, settle = 60, aim = [1, 0], aimAfter = null } = {}) {
    const seal = createVisual('ship');
    const sc = new THREE.Scene();
    sc.add(seal);
    sc.updateMatrixWorld(true);
    const a = createAnimationController(seal);
    // THE AIM RIG, in the order the game runs it: mixer, aim, then the pose.
    // It is what writes the flippers in a run, and the celebration layering
    // over it (or not) is the whole subject below.
    const r = createAimRig(seal);
    const dir = new THREE.Vector2(aim[0], aim[1]).normalize();
    const after = aimAfter ? new THREE.Vector2(aimAfter[0], aimAfter[1]).normalize() : null;
    // The aim swings only once the performance is under way, so both runs
    // enter it from the same pose — see the note below.
    const tick = () => r?.update(DT, (after && celebrationState.active) ? after : dir,
      { engaged: true, faceOut: 0, limp: false, charge: 0, suppressed: false });
    const d = createCelebrationDriver(seal);
    resetCelebration();
    d.reset();
    // Settle, so nothing below is measuring the controller's opening crossfade.
    // `settle` is also how the swim cycle is put at a different PHASE for the
    // layering check below — same clip, same seal, a different frame of it.
    for (let i = 0; i < settle; i++) { a.update(DT, 'swim', false); tick(); d.update(DT); }
    if (variant) startCelebration(fixedRng(variant));
    const path = POSED.map(() => 0);
    const last = POSED.map(() => null);
    let t = 0;
    while (t < seconds) {
      seal.rotation.z = turnRate * t;
      seal.position.x += Math.cos(seal.rotation.z) * speed * DT;
      seal.position.y += Math.sin(seal.rotation.z) * speed * DT;
      a.update(DT, 'swim', false);
      tick();
      updateCelebration(DT);
      d.update(DT);
      sc.updateMatrixWorld(true);
      if (t >= sampleFrom) {
        POSED.forEach((n, i) => {
          const p = at(seal, n);
          if (last[i]) path[i] += p.distanceTo(last[i]);
          last[i] = p;
        });
      }
      t += DT;
    }
    return { path, end: last, motion: d.motion() };
  }

  // 1. THE CLIP UNDERNEATH REACHES THE POSE.
  //
  //    NOT "the bones are still moving" — a held pose has motion of its own
  //    (finsUp trembles) and would pass that while replacing the clip
  //    entirely. NOR "two celebrations at different swim phases land
  //    differently", which is the check that looks right and is not: an entry
  //    snapshot taken at a different phase IS different, so a frozen reference
  //    passes it too. (It did. That is why this one is written the way it is.)
  //
  //    NOR "the mixer stops being ticked mid-performance", which is the check
  //    that looks decisive and measures nothing on this rig: the swim clip
  //    does not key the flippers at ALL, so with nothing else writing them the
  //    frozen reference and the live one hold the same value by definition and
  //    agree to the float.
  //
  //    THE THING THAT WRITES THOSE BONES IN A RUN IS THE AIM RIG, which is
  //    ticked every frame and runs immediately before this driver. (That is
  //    also why it is in this loop at all: a seal nothing aims is not a state
  //    the game has.)
  //
  //    So: two runs that are IDENTICAL up to the moment the celebration
  //    starts — same clip, same phase, same aim, so the same entry pose — and
  //    then the seal is pointed somewhere else in one of them and not the
  //    other. Anything the pose reads off a frozen snapshot cannot see that;
  //    anything it reads live moves with it. Comparing two runs that were
  //    aimed differently from the START proves nothing, because the snapshot
  //    itself differs then and a frozen reference passes too.
  const HOLD = 1.5;
  resetCelebration();
  const aimHeld = run({ variant: 'finsUp', seconds: HOLD, sampleFrom: HOLD - DT * 2, aim: [1, 0] });
  resetCelebration();
  const aimSwung = run({ variant: 'finsUp', seconds: HOLD, sampleFrom: HOLD - DT * 2, aim: [1, 0], aimAfter: [-1, 0.6] });
  const byAim = POSED.map((n, i) => aimHeld.end[i].distanceTo(aimSwung.end[i]));
  check('the aim underneath still reaches the posed bones, at full extension',
    Math.max(...byAim) > 0.02, POSED.map((n, i) => `${n} ${byAim[i].toFixed(3)}`).join(', '));
  // ...on the FLIPPERS in particular. They are the bones the swim clip never
  // keys, so the aim rig is the only thing writing them and a frozen reference
  // held them hardest — and they are the bones the whole pose is made of.
  check('...including the flippers, which only the aim rig writes',
    Math.min(byAim[0], byAim[1]) > 0.02, `L ${byAim[0].toFixed(3)}, R ${byAim[1].toFixed(3)}`);
  // AND IT IS `follow` THAT BUYS THAT. Toggled here rather than asserted about
  // in prose: at 0 the target is the pose in full from the peak onward and the
  // performance is the same shape whatever the animal is doing under it.
  const savedFollow = CONFIG.celebrate.follow;
  CONFIG.celebrate.follow = 0;
  resetCelebration();
  const rigidHeld = run({ variant: 'finsUp', seconds: HOLD, sampleFrom: HOLD - DT * 2, aim: [1, 0] });
  resetCelebration();
  const rigidSwung = run({ variant: 'finsUp', seconds: HOLD, sampleFrom: HOLD - DT * 2, aim: [1, 0], aimAfter: [-1, 0.6] });
  CONFIG.celebrate.follow = savedFollow;
  const rigidByAim = POSED.map((n, i) => rigidHeld.end[i].distanceTo(rigidSwung.end[i]));
  check('...and `follow` is what buys it at full extension',
    Math.max(...byAim) > Math.max(...rigidByAim) * 1.3,
    `${Math.max(...byAim).toFixed(3)} with follow ${savedFollow}, ${Math.max(...rigidByAim).toFixed(3)} with it off`);

  // THE HEAD IS THE ONE THAT PROVES THE REFERENCE IS LIVE, and it is worth
  // singling out because it is the bone the old frozen snapshot held hardest.
  // The flippers are unkeyed, so the aim rig is the only thing writing them
  // and their chain ROOT still moves with the body either way — a world
  // measurement on them shifts even with a frozen reference. The head chain
  // starts at neck01_05, which the swim clip keys with a SINGLE keyframe: a
  // constant, so the mixer stops writing it and poseRig counted it among the
  // bones to put back. Frozen, the neck could not follow the aim at all.
  check('the head chain follows the aim rather than a snapshot', byAim[2] > 0.15,
    `head_07 ${byAim[2].toFixed(3)} when the seal looks somewhere else mid-performance`);

  // 2. THE ANIMAL'S OWN MOTION REACHES IT. Same variant, same clock, three
  //    different things for the seal to be doing.
  resetCelebration();
  const still = run({ variant: 'finsUp', seconds: 1.4, sampleFrom: 1.3 });
  resetCelebration();
  const sprint = run({ variant: 'finsUp', seconds: 1.4, speed: CONFIG.player.maxSpeed, sampleFrom: 1.3 });
  resetCelebration();
  const carve = run({ variant: 'finsUp', seconds: 1.4, speed: 20, turnRate: 3, sampleFrom: 1.3 });

  check('a still seal reads no momentum at all', Math.abs(still.motion.speed01) < 0.01 && Math.abs(still.motion.turn) < 0.01,
    `speed01 ${still.motion.speed01.toFixed(3)}, turn ${still.motion.turn.toFixed(3)}`);
  check('a sprinting one reads its own top speed as full', sprint.motion.speed01 > 0.9,
    `speed01 ${sprint.motion.speed01.toFixed(3)}`);
  check('a carving one reads a signed turn', Math.abs(carve.motion.turn) > 0.5,
    `turn ${carve.motion.turn.toFixed(3)}`);

  // ...and that reading has to reach the BONES, which is the half a state
  // readout cannot promise.
  const moved = (a, b) => POSED.map((n, i) => a.end[i].distanceTo(b.end[i]));
  const bySprint = moved(still, sprint);
  const byCarve = moved(still, carve);
  check('the pose rides a sprint', Math.max(...bySprint) > 0.05,
    POSED.map((n, i) => `${n} ${bySprint[i].toFixed(3)}`).join(', '));
  check('...and rides a carve', Math.max(...byCarve) > 0.05,
    POSED.map((n, i) => `${n} ${byCarve[i].toFixed(3)}`).join(', '));
  // ...to somewhere DIFFERENT, not merely further. The two terms are separate
  // axes — drag runs along the body and bank across it — and a build where one
  // of them had quietly stopped reaching would still pass both checks above.
  const sprintVsCarve = POSED.map((n, i) => sprint.end[i].distanceTo(carve.end[i]));
  check('...and the two are different displacements, not one term twice',
    Math.max(...sprintVsCarve) > 0.05,
    POSED.map((n, i) => `${n} ${sprintVsCarve[i].toFixed(3)}`).join(', '));
  // The limbs must not be thrown so far by momentum that the pose stops being
  // the pose. A whole reach of displacement is a flipper somewhere else.
  check('...without the momentum swamping the pose', Math.max(...byCarve) < 1.2,
    `${Math.max(...byCarve).toFixed(3)} at a hard carve`);

  // 3. AND IT STILL ARRIVES. The target now starts at the limb's live tip, so
  //    it is scaled on the way in — and the bone blend scales it again. Doing
  //    both on the same curve costs the pose its reach (it cost the level-up
  //    salute 0.04 of a clap it used to close), which is what `blendSpan` is
  //    for: the target is the pose in full by halfway up the envelope.
  check('the target finishes travelling before the peak does', (CONFIG.celebrate.blendSpan ?? 0.5) < 1,
    `blendSpan ${CONFIG.celebrate.blendSpan}`);
  const savedFrom = CONFIG.celebrate.blendFrom;
  CONFIG.celebrate.blendFrom = 0;   // the old behaviour: a fixed destination
  resetCelebration();
  const fixed = run({ variant: 'finsUp', seconds: 1.4, sampleFrom: 1.3 });
  CONFIG.celebrate.blendFrom = savedFrom;
  resetCelebration();
  const blended = run({ variant: 'finsUp', seconds: 1.4, sampleFrom: 1.3 });
  const short = POSED.map((n, i) => fixed.end[i].distanceTo(blended.end[i]));
  check('blending from the live pose costs the peak nothing', Math.max(...short) < 0.06,
    POSED.map((n, i) => `${n} ${short[i].toFixed(3)}`).join(', '));
}

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('all checks passed\n');
