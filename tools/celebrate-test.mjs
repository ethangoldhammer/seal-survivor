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
import {
  celebrationState, startCelebration, playCelebration, updateCelebration, resetCelebration,
  createCelebrationDriver, snapshotMoment, celebrationSpin, CELEBRATION_VARIANTS,
} from '../path/src/systems/celebrate.js';
import { cardsArriveAt } from '../path/src/systems/levelUpTime.js';

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
// Drive one variant to a given wall-clock moment and hand back the pose. The
// animation controller runs alongside it exactly as it does in the game, so
// these are measurements of the celebration layered OVER the swim cycle rather
// than of a pose sitting on a bind skeleton by itself.
function runTo(variant, seconds, { locomotion = 'swim' } = {}) {
  resetCelebration();
  driver.reset();
  // Force the variant rather than rolling for it: a test at the mercy of a
  // coin flip is a test that fails on somebody else's machine.
  startCelebration(fixedRng(variant));
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
for (const v of CELEBRATION_VARIANTS) {
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
  // The half-integer `beats` is what puts a contact on the shutter — this is
  // the assertion that catches somebody rounding it to 2.
  check('they are near contact on the trophy frame', gapAtPeak < restGap * 0.55,
    `closed to ${(100 * gapAtPeak / restGap).toFixed(0)}% of rest`);
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

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('all checks passed\n');
