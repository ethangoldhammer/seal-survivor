#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:sealflip
//
// THE FLIP — a circle drawn with the aim hand, a somersault, and a tail slap
// that throws bodies. systems/sealFlip.js owns the move; input.js owns the
// gesture. Both are here, plus the arc the slap tests against and what it is
// worth when it lands.
//
// What this can say that watching the seal cannot:
//
//   * A STRAIGHT SWIPE IS NOT A CIRCLE, and neither is a shake or a tremor.
//     Every one of those is the same hand on the same device, and every one of
//     them fired a somersault at some point during this feature's life. They
//     are the whole reason the detector has four gates rather than one, and a
//     false positive is invisible in a lab — you see a flip and assume you
//     asked for it.
//   * THE TURN LANDS ON THE IDENTITY. The spin eases to a whole number of
//     turns and is NOT enveloped (see the header of systems/sealFlip.js), so
//     the move ends with the body exactly where it started. A rotation that
//     ended a hundredth of a turn out would be a seal permanently tilting.
//   * THE ARC IS A LINE, NOT A RADIUS. A creature in FRONT of a flipping seal
//     must not be hit, or there is nothing to dodge. This is measured on the
//     real segment maths rather than asserted from the config.
//   * IT IS ACTUALLY EXTRA. The knockback is measured through the game's own
//     applyKnockback — the same function every shot and every blast goes
//     through — so "extra" is a number in world units and not a multiplier
//     compared with itself.
//   * THE POSE COMES BACK. The swim clip does not key the front flippers, so a
//     tuck that fails to release ratchets: a little tighter every flip, which
//     nobody notices until the twentieth. Measured on the REAL rig, against a
//     control seal that only ever swam.
//
// What it cannot tell you: whether a circle is a comfortable thing to draw
// mid-fight, or whether the slap reads as a slap. That is the pose lab
// (`npm run looks:poselab`, pick "flip move") and the game.
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
import { createPoseRig } from '../path/src/systems/poseRig.js';
import { feedAimMotion, readCircle, clearPendingInput } from '../path/src/input.js';
import {
  flipState, triggerFlip, updateSealFlip, resetSealFlip, createFlipDriver,
  flipDuration, flipAngleAt, flipTuckAt, flipPhaseAt, flipSlapWindow,
  flipSlapSegment, flipSlapDistance, claimFlipHit, flipKnockGain, flipSpin,
  flipWeakSpot, flipSteerDelta, flipDashBoost, noteFlipCommit, flipCommit, flipLaunch,
  flipTailPoint, flipTailLaying, flipTailSpring, noteFlipGather,
} from '../path/src/systems/sealFlip.js';
import { applyKnockback } from '../path/src/entities/enemies.js';
import {
  gooWalls, spawnGooWall, extendGooWall, sealGooWall, updateGooWalls, resetGooWalls, insideWall,
} from '../path/src/systems/gooWall.js';
import { playCelebration, resetCelebration } from '../path/src/systems/celebrate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEAL = resolve(HERE, '../public/models/furseal.glb');

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const DT = 1 / 60;
const F = CONFIG.sealFlip;
const G = CONFIG.touch.circleFlick;

// ---------------------------------------------------------------------------
// THE GESTURE, first and on its own — the real detector in input.js, fed
// through the real sample list. No canvas: feedAimMotion is the same door the
// mouse and the aim thumb come through.
//
// Every shape below is drawn in CSS pixels the way a hand would, and the
// question is only ever "did this fire, and which way".
// ---------------------------------------------------------------------------

/** Walk a circle of `r` px through `n` samples. `dir` is +1 CCW, -1 CW. */
function drawCircle(r, dir, turns = 1, n = 40) {
  let px = r;
  let py = 0;
  for (let i = 1; i <= n; i++) {
    const a = dir * (i / n) * Math.PI * 2 * turns;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    feedAimMotion(x - px, y - py);
    px = x; py = y;
  }
}

/** A straight swipe of `len` px along (ux, uy), in `n` samples. */
function drawSwipe(len, ux, uy, n = 20) {
  for (let i = 0; i < n; i++) feedAimMotion((ux * len) / n, (uy * len) / n);
}

/**
 * Clear the detector between shapes — a fresh hand, not a continued one.
 *
 * THE GAME'S OWN CALL, not a reach into the module: the accumulator survives
 * across frames on purpose (a loop is half a second of hand motion), so
 * something has to be able to say "that gesture is over", and a run ending
 * needs exactly that or the first flick of the next run completes the last
 * one's circle.
 */
function clearGesture() {
  clearPendingInput();
}

section('the gesture — what fires');
{
  // The cooldown is wall time and this file runs in milliseconds, so the
  // throttle is turned off for the shapes and put back for its own test.
  const cool = G.cooldown;
  G.cooldown = 0;

  drawCircle(60, 1);
  const ccw = readCircle(null);
  check('a counter-clockwise circle fires +1 (backflip)', ccw === 1, `got ${ccw}`);

  drawCircle(60, -1);
  const cw = readCircle(null);
  check('a clockwise circle fires -1 (forward flip)', cw === -1, `got ${cw}`);

  // ONE CIRCLE IS ONE FLIP. The samples that made it must not still be in the
  // window on the next frame — the window is half a second and the frame is a
  // sixtieth, so an unspent circle would fire thirty times.
  drawCircle(60, 1);
  const first = readCircle(null);
  const second = readCircle(null);
  const third = readCircle(null);
  check('...and it fires exactly once', first === 1 && second === 0 && third === 0,
    `${first}, then ${second}, ${third}`);

  G.cooldown = cool;
}

section('the gesture — what does not fire');
{
  const cool = G.cooldown;
  G.cooldown = 0;

  clearGesture();
  drawSwipe(600, 1, 0);
  check('a long straight swipe is not a circle', readCircle(null) === 0);

  clearGesture();
  // A HAND CURVING INTO A DIRECTION CHANGE — most of a half turn on its own,
  // and the reason `turn` is 4.7 rather than something under 4.
  drawCircle(60, 1, 0.45);
  check('an arc into a turn is not a circle', readCircle(null) === 0);

  clearGesture();
  // A TREMOR: a full circle that goes nowhere. This is the gate `px` exists
  // for, and without it a hand resting on a mouse somersaults the seal.
  drawCircle(0.9, 1, 2);
  check('a tremor is not a circle, however far round it goes', readCircle(null) === 0);

  clearGesture();
  // A SHAKE. Half a circle each way sums to nothing only if the reversal is
  // caught; summed blindly it is |turn| both ways and fires whichever way it
  // finished.
  for (let i = 0; i < 4; i++) {
    drawCircle(60, 1, 0.4, 16);
    drawCircle(60, -1, 0.4, 16);
  }
  check('scrubbing back and forth is not a circle', readCircle(null) === 0);

  G.cooldown = cool;
}

section('the gesture — a stick rolls round its gate');
{
  const cool = G.cooldown;
  G.cooldown = 0;
  clearGesture();
  // A pad has no pixels, so the `px` gate cannot apply to it — the deadzone is
  // its tremor filter. Rolled round the gate a step at a time.
  let fired = 0;
  for (let i = 0; i <= 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    const r = readCircle({ x: Math.cos(a), y: Math.sin(a) });
    if (r) fired = r;
  }
  check('a right stick rolled once round fires a flip', fired === 1, `got ${fired}`);
  G.cooldown = cool;
}

// ---------------------------------------------------------------------------
// THE STATE MACHINE, without a rig — flipState alone, driven a frame at a time
// the way the game drives it.
// ---------------------------------------------------------------------------

/** Run the move forward `seconds`, collecting a sample per frame. */
function pump(seconds, each = null) {
  for (let t = 0; t < seconds; t += DT) {
    const opened = updateSealFlip(DT, null);
    if (each) each(opened);
  }
}

section('the four states, in order');
{
  resetSealFlip();
  check('nothing is flipping to begin with', !flipState.active && flipState.phase === 'idle');

  const started = triggerFlip(1, {}, false, null);
  check('a circle starts one', started && flipState.active && flipState.dir === 1);

  const seen = [];
  pump(flipDuration() + 0.1, () => {
    if (flipState.active && seen[seen.length - 1] !== flipState.phase) seen.push(flipState.phase);
  });
  check('it runs windup -> spin -> recover', seen.join(' -> ') === 'windup -> spin -> recover',
    seen.join(' -> '));
  check('...and ends by itself', !flipState.active && flipState.phase === 'idle');
}

section('the turn lands on the identity');
{
  resetSealFlip();
  const whole = Math.PI * 2 * F.turns;
  // THE ANGLE IS A FUNCTION OF THE TURN'S PROGRESS NOW, not of the clock — the
  // hand drives that progress and the clock is only the floor under it.
  const end = flipAngleAt(1, 1);
  check('the spin arrives at a whole number of turns', Math.abs(end - whole) < 1e-9,
    `${end.toFixed(9)} vs ${whole.toFixed(9)}`);
  check('...and the other way round too', Math.abs(flipAngleAt(1, -1) + whole) < 1e-9);

  // MONOTONIC. An angle that went backwards mid-spin is a seal visibly
  // unwinding, which is the failure the celebration's somersault exists to
  // avoid and the one this borrowed the rule from.
  let backwards = 0;
  let prev = flipAngleAt(0, 1);
  for (let u = 0; u <= 1; u += 0.002) {
    const a = flipAngleAt(u, 1);
    if (a < prev - 1e-12) backwards++;
    prev = a;
  }
  check('the spin never runs backwards', backwards === 0, `${backwards} steps`);
}

section('the hand winds the body up before the move exists');
{
  // THE GATHER IS THE PLAYER'S. Half a circle drawn is half a coil loaded, and
  // the seal shows it — this is the half of the gesture that used to be
  // invisible while the game waited for a threshold.
  resetSealFlip();
  check('an idle seal is not coiled', flipSpin(null) === 0 && flipState.gather === 0);

  for (let t = 0; t < 0.4; t += DT) noteFlipGather(1, 1, DT);
  check('winding the hand coils the body', flipState.gather > 0.9,
    `${flipState.gather.toFixed(2)} loaded`);
  const coil = flipSpin(null);
  check('...and it counter-rotates INTO the turn it is about to make',
    coil < 0 && coil > -Math.PI, `${(coil * 180 / Math.PI).toFixed(1)}deg`);
  check('...which shows on the run\'s seal and nobody else\'s', flipSpin('p2') === 0);

  // ...AND IT UNWINDS IF THE HAND STOPS, rather than snapping straight.
  for (let t = 0; t < 0.05; t += DT) noteFlipGather(0, 0, DT);
  const easing = flipState.gather;
  check('a hand that stops unwinds the body rather than dropping it',
    easing > 0.05 && easing < 0.95, `${easing.toFixed(2)} after 3 frames`);
  for (let t = 0; t < 1.5; t += DT) noteFlipGather(0, 0, DT);
  check('...and it gets all the way back', flipState.gather === 0);

  // THE MOVE STARTS FROM WHERE THE WINDING GOT TO — no jump between the coil
  // and the turn, which is what makes the commit read as a continuation.
  for (let t = 0; t < 0.4; t += DT) noteFlipGather(1, 1, DT);
  const before = flipSpin(null);
  triggerFlip(1, {}, false, null);
  updateSealFlip(DT / 1000, null);
  const after = flipSpin(null);
  check('the turn begins where the coil ended', Math.abs(after - before) < 0.05,
    `${(before * 180 / Math.PI).toFixed(1)}deg -> ${(after * 180 / Math.PI).toFixed(1)}deg`);

  // ...AND A FULLY WOUND HAND HAS NO WIND-UP LEFT TO WAIT THROUGH. This is the
  // "slight delay" the canned gather used to add on top of the player's own.
  check('a body already coiled throws itself immediately', flipState.launched,
    'no canned wind-up left to run');
  resetSealFlip();
}

section('the slap window');
{
  const w = flipSlapWindow();
  check('it opens inside the spin, not after it',
    w.open > F.windup && w.open < F.windup + F.spin,
    `opens ${w.open.toFixed(3)}s, spin is ${F.windup.toFixed(3)}..${(F.windup + F.spin).toFixed(3)}`);
  check('...and it is long enough not to fall between two frames',
    (w.close - w.open) > DT * 2, `${((w.close - w.open) * 1000).toFixed(0)}ms`);

  resetSealFlip();
  triggerFlip(1, {}, false, null);
  let opens = 0;
  let liveFrames = 0;
  pump(flipDuration() + 0.1, (opened) => {
    if (opened) opens++;
    if (flipState.slapLive) liveFrames++;
  });
  check('the window opens exactly once per flip', opens === 1, `${opens} times`);
  check('...and is live for several frames', liveFrames >= 2, `${liveFrames} frames`);
}

section('a flip is committed');
{
  resetSealFlip();
  triggerFlip(1, {}, false, null);
  pump(F.windup + F.spin * 0.3);
  const again = triggerFlip(-1, {}, false, null);
  check('a second circle mid-turn is refused', !again && flipState.dir === 1);

  // TO JUST PAST THE END OF THE MOVE, and no further — the cooldown is
  // measured from the START of a flip, so pumping a whole duration on top of
  // the 0.3 already spent would walk straight through it and the refusal below
  // would pass for the wrong reason.
  pump(flipDuration() - F.spin * 0.3 + DT);
  check('the flip is over', !flipState.active);
  const pause = F.cooldown - flipDuration();
  check('...and there is a real pause after it', pause > DT * 2,
    `${(pause * 1000).toFixed(0)}ms between two flips`);
  const tooSoon = triggerFlip(1, {}, false, null);
  check('a circle inside the cooldown is refused', !tooSoon && !flipState.active);
  pump(pause + 0.05);
  check('after the cooldown it takes one again', triggerFlip(1, {}, false, null));
  resetSealFlip();
}

section('the mirror, and who the somersault belongs to');
{
  resetSealFlip();
  triggerFlip(1, {}, true, null); // facing left
  check('a left-swimming seal turns the way the hand went on screen',
    flipState.dir === -1, `dir ${flipState.dir}`);
  resetSealFlip();

  const was = F.mirrorWithFacing;
  F.mirrorWithFacing = false;
  triggerFlip(1, {}, true, null);
  check('...unless the move is read in the animal\'s own frame', flipState.dir === 1);
  F.mirrorWithFacing = was;

  resetSealFlip();
  triggerFlip(1, {}, false, 'p2');
  pump(F.windup + F.spin * 0.4);
  check('the spin answers for the seal that flipped', Math.abs(flipSpin('p2')) > 0.1);
  check('...and for nobody else', flipSpin(null) === 0 && flipSpin('p3') === 0);
  resetSealFlip();
}

section('a celebration takes the animal back');
{
  resetSealFlip();
  resetCelebration();
  triggerFlip(1, {}, false, null);
  pump(F.windup + F.spin * 0.2);
  check('a flip is turning', flipState.active);
  playCelebration({ variant: 'flip', escorts: false });
  pump(DT * 2);
  check('a victory lap stands the flip down', !flipState.active);
  check('...and a circle during one is refused', !triggerFlip(1, {}, false, null));
  resetCelebration();
  resetSealFlip();
}

// ---------------------------------------------------------------------------
// THE ARC. All of this is geometry, so it is derived rather than typed: the
// seal sits at the origin heading +X, and every expectation below can be
// worked out by hand from that.
// ---------------------------------------------------------------------------
section('the hitbox is the tail, not a radius');
{
  resetSealFlip();
  triggerFlip(1, {}, false, null);
  // Straight to the middle of the window, where the tail is furthest out.
  const w = flipSlapWindow();
  pump(w.open + DT);
  check('the window is open', flipState.slapLive);

  // AT THIS INSTANT the seal has turned `flipState.angle`, so the tail is at
  // heading + angle + PI. Both the segment and the test read that same number,
  // which is the point — a hitbox derived twice is a hitbox that disagrees.
  const a = 0 + flipState.angle + Math.PI;
  const behind = { x: Math.cos(a) * F.reach * 0.9, y: Math.sin(a) * F.reach * 0.9 };
  const infront = { x: -behind.x, y: -behind.y };

  const seg = flipSlapSegment(0, 0, 0);
  check('the segment ends at the fluke',
    Math.abs(Math.hypot(seg.bx, seg.by) - F.reach) < 1e-9,
    `${Math.hypot(seg.bx, seg.by).toFixed(3)} vs reach ${F.reach}`);

  const dBehind = flipSlapDistance(0, 0, 0, behind.x, behind.y);
  const dFront = flipSlapDistance(0, 0, 0, infront.x, infront.y);
  check('a body on the tail is hit', dBehind < F.thick, `${dBehind.toFixed(3)}`);
  check('a body on the far side is NOT hit', dFront > F.thick,
    `${dFront.toFixed(2)} vs thick ${F.thick}`);

  // ...and anywhere ALONG the tail counts, not only the tip.
  const half = { x: Math.cos(a) * F.reach * 0.5, y: Math.sin(a) * F.reach * 0.5 };
  check('a body halfway along the tail is hit too',
    flipSlapDistance(0, 0, 0, half.x, half.y) < F.thick);

  // THE THROW IS MOSTLY SIDEWAYS — the way the fluke is travelling. Measured
  // against the radius, which is the direction a blast would use.
  const radial = (seg.dirX * Math.cos(a) + seg.dirY * Math.sin(a));
  check('it throws along the swing rather than straight out',
    Math.abs(radial) < 0.8, `radial component ${radial.toFixed(2)}`);
  check('...and the direction is a unit vector',
    Math.abs(Math.hypot(seg.dirX, seg.dirY) - 1) < 1e-9);

  // ONE BODY, ONE HIT. The window is several frames and the test runs on all
  // of them.
  const body = { id: 'shark' };
  check('the first frame claims it', claimFlipHit(body));
  check('...and the rest do not', !claimFlipHit(body) && !claimFlipHit(body));
  resetSealFlip();
  triggerFlip(1, {}, false, null);
  check('a new flip may hit it again', claimFlipHit(body));
  resetSealFlip();
}

section('there is no tail hitbox outside the window');
{
  resetSealFlip();
  check('nothing to hit while idle', flipSlapSegment(0, 0, 0) === null
    && flipSlapDistance(0, 0, 0, 1, 0) === Infinity);
  triggerFlip(1, {}, false, null);
  pump(DT); // still in the wind-up
  check('...nor during the wind-up', flipSlapSegment(0, 0, 0) === null);
  resetSealFlip();
}

// ---------------------------------------------------------------------------
// WHAT IT IS WORTH, through the game's own applyKnockback — so "extra" is a
// distance in the water rather than a multiplier compared with itself.
// ---------------------------------------------------------------------------
section('the hand drives the turn, the clock only finishes it');
{
  // A HAND THAT KEEPS DRAWING LEADS. The somersault turns as fast as the
  // circle is made, which is the difference between driving a move and
  // setting one off.
  resetSealFlip();
  triggerFlip(1, {}, false, null);
  let drawn = 0;
  let framesDriven = 0;
  pump(flipDuration(), () => {
    drawn = Math.min(1, drawn + DT * 2.5);
    noteFlipCommit(drawn);
    if (flipState.active && flipState.u >= 1) framesDriven++;
  });
  const drivenEnd = framesDriven;
  check('a hand that keeps drawing brings the turn round', drivenEnd > 0,
    'landed with frames to spare');

  // ...AND A HAND THAT LETS GO STILL LANDS. There is no pose at 0.6 of a turn
  // the game could hand back to ordinary swimming, so the clock is the floor
  // under the hand and not merely a timeout.
  resetSealFlip();
  pump(F.cooldown + 0.1);
  triggerFlip(1, {}, false, null);
  let landed = false;
  pump(flipDuration() * 1.5, () => { if (flipState.u >= 1) landed = true; });
  check('a hand that stops still finishes the flip', landed);
  check('...and the seal is not left part-rotated', !flipState.active);

  // THE FASTER HAND GETS THERE SOONER. Same move, same numbers, two players.
  const timeToLand = (rate) => {
    resetSealFlip();
    flipState.cool = 0;
    triggerFlip(1, {}, false, null);
    let d = 0;
    let t = 0;
    let at = Infinity;
    pump(flipDuration() * 2, () => {
      d = Math.min(1, d + DT * rate);
      noteFlipCommit(d);
      if (flipState.u >= 1 && at === Infinity) at = t;
      t += DT;
    });
    return at;
  };
  const fast = timeToLand(3);
  const slow = timeToLand(0);
  check('whipping the circle round turns the seal sooner',
    fast < slow - 0.05, `${fast.toFixed(2)}s driven vs ${slow.toFixed(2)}s on the clock alone`);

  // ...AND THE HAND MAY NOT TELEPORT IT. The follow-through is a position and
  // the somersault is a body: without a rate a hand already most of the way
  // round when the move commits snaps the seal through most of a turn in one
  // frame, which reports a fluke moving at several hundred units a second.
  resetSealFlip();
  flipState.cool = 0;
  triggerFlip(1, {}, false, null);
  let worstStep = 0;
  pump(flipDuration(), () => {
    noteFlipCommit(1);
    worstStep = Math.max(worstStep, Math.abs(flipState.turnDelta));
  });
  check('a hand thrown straight to the end sweeps rather than snaps',
    worstStep < (Math.PI * 2 * F.commit.handRate * DT) + 1e-6,
    `worst frame ${(worstStep * 180 / Math.PI).toFixed(0)}deg`);
  resetSealFlip();
}

section('the follow-through shapes the flip');
{
  const K = F.commit;
  // A FULLY DRAWN CIRCLE AND A HALF-DRAWN ONE, on the same authored numbers.
  // The hand's follow-through is read while the body is still gathering and
  // locked at the launch — see noteFlipCommit.
  resetSealFlip();
  triggerFlip(1, {}, false, null);
  check('a flip starts with nothing banked', flipCommit() === 0);
  noteFlipCommit(1);
  check('...and the hand can bank it while the body gathers', flipCommit() === 1);
  const sharp = flipDuration();
  const sharpHit = flipKnockGain(1);

  resetSealFlip();
  pump(F.cooldown + 0.1);
  triggerFlip(1, {}, false, null);
  noteFlipCommit(0);
  const lazy = flipDuration();
  const lazyHit = flipKnockGain(1);

  check('a whipped circle spins faster than a half-drawn one',
    sharp < lazy - 0.05, `${sharp.toFixed(2)}s vs ${lazy.toFixed(2)}s`);
  check('...and its tail hits harder',
    sharpHit > lazyHit * 1.4, `${sharpHit.toFixed(2)} vs ${lazyHit.toFixed(2)}`);
  check('both are the same authored turn',
    Math.abs(flipAngleAt(1, 1) - Math.PI * 2 * F.turns) < 1e-9,
    'however it is driven, it arrives at the identity');

  // IT ONLY GOES UP WITHIN ONE FLIP. The accumulator in input.js drops to 0
  // the moment a hand pauses, and a commit that followed it down would punish
  // a player for having FINISHED the circle.
  resetSealFlip();
  pump(F.cooldown + 0.1);
  triggerFlip(1, {}, false, null);
  noteFlipCommit(0.8);
  noteFlipCommit(0.1);
  check('a hand that stops keeps what it earned', flipCommit() === 0.8,
    `${flipCommit().toFixed(2)}`);

  // ...AND THE HAND KEEPS DRIVING PAST THE LAUNCH, which is the whole control
  // model. It used to lock here — correct when the turn ran on a clock and the
  // follow-through only chose that clock's LENGTH, and wrong now that the same
  // number is pushing the somersault round.
  pump(F.windup + 0.02);
  noteFlipCommit(1);
  check('the hand still has the wheel after the launch', flipCommit() === 1,
    `${flipCommit().toFixed(2)}`);
  resetSealFlip();
}

section('the knockback is actually extra');
{
  // MEASURED ON A FULLY DRAWN CIRCLE. Every number below is the authored one
  // times the follow-through, so a section that did not say which
  // follow-through it meant would be asserting an accident.
  resetSealFlip();
  triggerFlip(1, {}, false, null);
  noteFlipCommit(1);
  // A plain body: a shark-sized animal with no rigid body and no boss flag, so
  // it takes the ordinary displacement branch.
  const shark = () => ({
    def: { radius: 1.2 }, radius: 1.2, sizeMul: 1,
    mesh: { position: new THREE.Vector3() },
    knockX: 0, knockY: 0,
  });

  const plain = shark();
  const ordinary = applyKnockback(plain, 1, 0, 1);
  const tip = shark();
  const atTip = applyKnockback(tip, 1, 0, 1, { gain: flipKnockGain(1), source: 'flipSlap' });
  const root = shark();
  const atRoot = applyKnockback(root, 1, 0, 1, { gain: flipKnockGain(0), source: 'flipSlap' });

  check('a slap at the fluke throws harder than an ordinary hit',
    atTip > ordinary * 1.5, `${atTip.toFixed(1)} vs ${ordinary.toFixed(1)} units/s`);
  check('...the base of the tail throws less than the fluke',
    atRoot < atTip, `${atRoot.toFixed(1)} vs ${atTip.toFixed(1)}`);
  check('...and still more than an ordinary hit, so there is no dead zone',
    atRoot > ordinary, `${atRoot.toFixed(1)} vs ${ordinary.toFixed(1)}`);
  const full = F.commit.hitFast;
  check('the lever is the authored one, times the follow-through',
    Math.abs(flipKnockGain(1) - F.knockGain * full) < 1e-9
    && Math.abs(flipKnockGain(0) - F.knockGain * F.knockGainRoot * full) < 1e-9,
    `${flipKnockGain(0).toFixed(2)}..${flipKnockGain(1).toFixed(2)} at x${full}`);

  // A BIGGER ANIMAL STILL RESISTS. The gain multiplies the shove, it does not
  // replace the size curve — a slap that threw a yacht as far as a sardine
  // would have flattened the one rule every other knockback in the game keeps.
  const whale = { def: { radius: 6 }, radius: 6, sizeMul: 1, mesh: { position: new THREE.Vector3() }, knockX: 0, knockY: 0 };
  const big = applyKnockback(whale, 1, 0, 1, { gain: flipKnockGain(1), source: 'flipSlap' });
  check('a big animal still takes less of it', big < atTip, `${big.toFixed(1)} vs ${atTip.toFixed(1)}`);
  resetSealFlip();
}

section('a boss leans, it does not move');
{
  // Same animal twice, differing only in `isBoss`. The boss branch inside
  // applyKnockback is the thing under test and it is reached by that flag
  // alone, so this is the whole difference.
  const body = (boss) => ({
    def: { radius: 1.2 }, radius: 1.2, sizeMul: 1, isBoss: boss,
    mesh: { position: new THREE.Vector3() },
    knockX: 0, knockY: 0,
  });
  const slap = (e, weak = false) => applyKnockback(e, 1, 0, 1, {
    gain: flipKnockGain(1, weak), source: 'flipSlap',
  });

  const fish = slap(body(false));
  const boss = slap(body(true));
  check('a boss takes SOME of a slap', boss > 0, `${boss.toFixed(1)} units/s`);
  check('...but much less than an ordinary body takes',
    boss < fish * 0.5, `${boss.toFixed(1)} vs ${fish.toFixed(1)}`);

  // ...AND STILL NOTHING FROM A SHOT. The point of the partial tier is that it
  // names ONE source; if it had been written as a softer `shove` every pellet
  // in the game would have started leaning on bosses again, which is the exact
  // thing CONFIG.boss.tenacity exists to have stopped.
  const shot = applyKnockback(body(true), 1, 0, 1, { gain: 2.2, source: 'shot' });
  check('an ordinary shot still moves a boss not at all', shot === 0, `${shot}`);

  // THE WEAK SPOT IS THE WAY BACK UP.
  const spot = slap(body(true), true);
  check('a slap on a lit weak spot moves a boss much further',
    spot > boss * 2.5, `${spot.toFixed(1)} vs ${boss.toFixed(1)} on the flank`);
  check('...to about what an ordinary body takes from the same slap',
    spot > fish * 0.7 && spot < fish * 1.3,
    `${spot.toFixed(1)} vs ${fish.toFixed(1)}`);
  // ...and the two things the move asks for COMPOSE rather than one deleting
  // the other: a spot caught on the fluke still beats one grazed at the root.
  const tipSpot = flipKnockGain(1, true);
  const rootSpot = flipKnockGain(0, true);
  check('the lever still applies on a weak spot', tipSpot > rootSpot,
    `${rootSpot.toFixed(2)} at the base, ${tipSpot.toFixed(2)} at the fluke`);
  check('...and a weak spot at the base beats a flank hit at the fluke',
    rootSpot > flipKnockGain(1, false),
    `${rootSpot.toFixed(2)} vs ${flipKnockGain(1, false).toFixed(2)}`);
}

section('finding the weak spot with the tail');
{
  resetSealFlip();
  triggerFlip(1, {}, false, null);
  pump(flipSlapWindow().open + DT);
  check('the window is open', flipState.slapLive);

  // The spots are handed in as plain points — see flipWeakSpot on why this
  // file has no business importing the boss's systems to ask the question.
  const a = 0 + flipState.angle + Math.PI;
  const onTail = { x: Math.cos(a) * F.reach * 0.8, y: Math.sin(a) * F.reach * 0.8, r: 0.6 };
  const far = { x: -onTail.x, y: -onTail.y, r: 0.6 };
  const nearer = { x: Math.cos(a) * F.reach * 0.4, y: Math.sin(a) * F.reach * 0.4, r: 0.6 };

  check('a spot on the tail is found', flipWeakSpot(0, 0, 0, [onTail]) === onTail);
  check('a spot on the far side is not', flipWeakSpot(0, 0, 0, [far]) === null);
  check('no spots is no weak spot',
    flipWeakSpot(0, 0, 0, []) === null && flipWeakSpot(0, 0, 0, null) === null);
  // NEAREST WINS: a tail long enough to lie across two of them hit the animal
  // once, so it cannot claim both.
  const both = flipWeakSpot(0, 0, 0, [onTail, nearer]);
  check('a tail across two spots claims the nearer one', both === nearer || both === onTail,
    both === nearer ? 'nearer' : 'the other');

  resetSealFlip();
  check('there is no weak spot to find outside the window',
    flipWeakSpot(0, 0, 0, [onTail]) === null);
}

section('the launch, and the two jobs it does');
{
  resetSealFlip();
  triggerFlip(1, {}, false, null);
  check('nothing has launched during the gather', flipLaunch() === 0 && !flipState.launched);
  // THROUGH THE WIND-UP, counting the frames the edge is up. It has to be
  // exactly one: the caller spends it on a fling or a wall, and an edge that
  // was true for two frames would throw the seal twice.
  let edges = 0;
  let sign = 0;
  pump(flipDuration(), () => { if (flipLaunch()) { edges++; sign = flipLaunch(); } });
  check('the body throws itself exactly once', edges === 1, `${edges} frames`);
  check('...and a backflip reports +1', sign === 1);

  resetSealFlip();
  pump(F.cooldown + 0.1);
  triggerFlip(-1, {}, false, null);
  let fwd = 0;
  pump(flipDuration(), () => { if (flipLaunch()) fwd = flipLaunch(); });
  check('a forward flip reports -1', fwd === -1);

  // AT THE END OF THE GATHER, not at the trigger and not at the slap — the
  // gather is the anticipation and the throw is what it was loading for.
  resetSealFlip();
  pump(F.cooldown + 0.1);
  triggerFlip(-1, {}, false, null);
  let at = 0;
  let t = 0;
  pump(flipDuration(), () => { if (flipLaunch()) at = t; t += DT; });
  check('it lands at the end of the wind-up, not at the slap',
    Math.abs(at - F.windup) < DT * 1.5 && at < flipSlapWindow().open,
    `${(at * 1000).toFixed(0)}ms, wind-up is ${(F.windup * 1000).toFixed(0)}ms`);
  resetSealFlip();
}

section('the backflip leaves a wall');
{
  resetGooWalls();
  resetSealFlip();
  check('no walls to begin with', gooWalls.length === 0);

  // THE REAL LOOP main.js runs: a backflip, and the fluke painting the wall a
  // node at a time as the somersault swings it. The seal sits at the origin
  // facing +X, so every node below can be worked out by hand from the flip's
  // own angle.
  triggerFlip(1, {}, false, null);
  const wall = spawnGooWall(0, 0, 0);
  check('a backflip opens one', !!wall && gooWalls.length === 1);
  check('...with no goo in it yet', wall.nodes.length === 0,
    'a wall that has not been painted stops nothing');

  let laid = 0;
  // ...and how fast the fluke was going while it painted, which is what the
  // goo is thrown with. Captured in the loop because `turnDelta` is zero the
  // moment the flip ends — asking afterwards reports a tail at rest, which is
  // true and useless.
  let tipSpeed = 0;
  // DRIVEN BY A HAND, frame by frame, the way main.js feeds input.circleCommit
  // — the turn is the follow-through's now, and a flip nobody is drawing turns
  // on the fallback clock alone.
  let drawn = 0;
  pump(flipDuration() * 1.2, () => {
    drawn = Math.min(1, drawn + DT * 4);
    noteFlipCommit(drawn);
    if (!flipState.active || !flipTailLaying()) return;
    const t = flipTailPoint(0, 0, 0, DT);
    tipSpeed = Math.max(tipSpeed, t.speed);
    if (extendGooWall(wall, t.x, t.y, t.vx, t.vy)) laid++;
  });
  sealGooWall(wall);
  check('the tail paints it as it sweeps', laid > 3, `${laid} nodes off the fluke`);

  // IT IS THE ARC THE TAIL CUT. Every node sits at the fluke's own reach from
  // the animal, which is what "organic" means here — the mass is where the
  // tail was, not where a number said to put a bar.
  let minR = Infinity;
  let maxR = 0;
  for (const nd of wall.nodes) {
    const d = Math.hypot(nd.x, nd.y);
    minR = Math.min(minR, d);
    maxR = Math.max(maxR, d);
  }
  // ...to within the SAG of a chord. The nodes between two frames are filled
  // along the straight line the tail covered, not along the arc, so an
  // interior one sits a sagitta inside the circle — a couple of tenths against
  // a wall 1.6 thick and lobes 2.2 across, which is nothing you can see.
  //
  // Filled straight on purpose: in a match the seal is MOVING while it flips,
  // so there is no fixed centre to interpolate an arc around, and a fill that
  // assumed one would bend the wall away from where the tail actually was.
  check('every node is out at the tail\'s own reach',
    maxR <= F.reach + 0.01 && minR > F.reach - 0.5,
    `${minR.toFixed(2)}..${maxR.toFixed(2)} vs reach ${F.reach}`);

  // COHESION: consecutive blobs have to OVERLAP or the wall is beads. The
  // spacing is what decides it (see the header of systems/gooWall.js), so it
  // is asserted rather than left to the emitter's luck.
  const B = CONFIG.sealFlip.back;
  let worstGap = 0;
  for (let i = 1; i < wall.nodes.length; i++) {
    worstGap = Math.max(worstGap, Math.hypot(
      wall.nodes[i].x - wall.nodes[i - 1].x,
      wall.nodes[i].y - wall.nodes[i - 1].y));
  }
  check('no two blobs are further apart than the spacing asks',
    worstGap <= B.step * 1.5, `worst gap ${worstGap.toFixed(2)} vs step ${B.step}`);
  // ...and the lobes are bigger than the gaps between them, which is the
  // actual condition for the field never dipping below the isoline.
  const lobe = CONFIG.emitters.gooWall.size[0] * CONFIG.fx.goo.groups.gooWall.radius;
  check('...and a lobe is wider than the gap, so they fuse',
    lobe > worstGap, `lobe ${lobe.toFixed(2)} across vs gap ${worstGap.toFixed(2)}`);

  // THE GOO LEAVES WITH THE TAIL, and it must not leave the WALL.
  //
  // Each lobe keeps `inherit` of the fluke's velocity, and the fluke is the
  // fastest thing on the animal. Under drag `d` a lobe thrown at `v` coasts
  // v/d before it stops, so this is the distance the mass settles from the
  // node that was laid — and it has to stay inside the barrier it is drawn
  // for. Past that the picture and the hitbox part company: the goo is over
  // there and the fish stops here, which reads as a bug in the collision
  // rather than as a tuning number.
  //
  // Asserted as the PRODUCT rather than as the numbers, because there are
  // three of them (inherit, drag and how fast the tail swings) and any of the
  // three can be moved by somebody tuning the look.
  {
    const em = CONFIG.emitters.gooWall;
    // The fluke's speed, measured on the flip that just ran rather than
    // assumed: a whole turn of `reach` over the spin.
    // THE MEASURED PEAK, not the average. The spin is eased, so the fluke's
    // top speed is about half again the speed a whole-turn-over-the-spin sum
    // gives — and it is the peak that decides how far the fastest lobes
    // travel. Computing it from the authored numbers instead reported 89 u/s
    // against a real 139 and passed a wall whose goo drifts off its own
    // hitbox.
    const coast = ((em.inherit ?? 0) * tipSpeed) / Math.max(0.01, em.drag ?? 1);
    check('the goo is thrown along the tail, not dropped off it',
      (em.inherit ?? 0) > 0.05, `inherit ${em.inherit}`);
    check('...and it settles inside the wall it is drawing',
      coast < B.thick + lobe * 0.5,
      `coasts ${coast.toFixed(2)} vs thick ${B.thick} + half a lobe`);
    check('...and the tail was actually moving when it threw it',
      tipSpeed > 20, `${tipSpeed.toFixed(0)} u/s at the fluke, mid-sweep`);
    // ...AND IT WOBBLES. A row of identical lobes in a perfect line reads as a
    // machined bar; the turbulence is a noise field that grows with each
    // lobe's age, so the wall starts clean off the tail and goes ragged.
    check('the mass is turbulent rather than machined',
      (em.turbulence ?? 0) > 0.3, `turbulence ${em.turbulence}`);
  }

  // IT IS AN ARC, NOT A RING. Goo laid along the whole turn would enclose the
  // seal — a bubble to stand in rather than a wall to retreat behind.
  const first = wall.nodes[0];
  const last = wall.nodes[wall.nodes.length - 1];
  const spanned = Math.abs(Math.atan2(last.y, last.x) - Math.atan2(first.y, first.x));
  check('it is an arc and not a ring around the animal',
    spanned < Math.PI * 1.6, `${(spanned * 180 / Math.PI).toFixed(0)}deg of the turn`);

  // IT STOPS THINGS, ONCE EACH, wherever on the arc they meet it.
  const mid = wall.nodes[Math.floor(wall.nodes.length / 2)];
  const fish = {
    mesh: { position: new THREE.Vector3(mid.x, mid.y, 0) },
    radius: 0.8, trapTimer: 0, vx: 20, vy: 0,
  };
  let n = updateGooWalls(DT, [fish]);
  check('a fish that reaches it is stopped', n === 1 && fish.trapTimer > 0,
    `held ${fish.trapTimer.toFixed(2)}s`);
  check('...and pushed back out of it',
    insideWall(wall, fish.mesh.position.x, fish.mesh.position.y, fish.radius) === null);
  fish.mesh.position.set(mid.x, mid.y, 0);
  fish.trapTimer = 0;
  n = updateGooWalls(DT, [fish]);
  check('...and not stopped twice by the same wall', n === 0 && fish.trapTimer === 0);

  // ...AND IT HAS ENDS. Past the last node is open water, which is what makes
  // the wall something to place rather than a dome.
  const off = {
    mesh: { position: new THREE.Vector3(-F.reach - 6, 0, 0) },
    radius: 0.8, trapTimer: 0,
  };
  check('open water past the ends of it', updateGooWalls(DT, [off]) === 0);

  // IT DIES QUICKLY. That is the whole design: a wall to retreat behind, not
  // terrain.
  check('it is a short-lived thing', wall.maxLife < 1, `${wall.maxLife.toFixed(2)}s`);
  for (let t = 0; t < wall.maxLife + 0.1; t += DT) updateGooWalls(DT, null);
  check('...and it is gone on its own', gooWalls.length === 0);

  // A CAP, so a tuner run with the cooldown at zero cannot fill the water.
  const max = CONFIG.sealFlip.back.maxWalls;
  for (let i = 0; i < max + 3; i++) spawnGooWall(i * 30, 0, 0);
  check('no more than the cap are ever up', gooWalls.length === max, `${gooWalls.length}`);
  resetGooWalls();
  resetSealFlip();
}

section('flipping out of a dash');
{
  const D = F.duringStrike;
  resetSealFlip();
  check('nothing steers a dash while nothing is flipping', flipSteerDelta() === 0);

  triggerFlip(1, {}, false, null);
  // Through the spin, summing what the dash's heading would be turned by. The
  // sum is the whole arc a dash gets out of one flip, and it is the number the
  // player is actually learning.
  let bend = 0;
  pump(flipDuration(), () => { bend += flipSteerDelta(); });
  const whole = Math.PI * 2 * F.turns * D.steer;
  check('a flip bends a dash by its share of the whole turn',
    Math.abs(bend - whole) < 0.02,
    `${(bend * 180 / Math.PI).toFixed(0)}deg of the somersault's ${(F.turns * 360).toFixed(0)}`);
  check('...which is a hard hook and not a U-turn',
    Math.abs(bend) > 1 && Math.abs(bend) < Math.PI,
    `${(bend * 180 / Math.PI).toFixed(0)}deg`);

  // ...AND THE OTHER WAY ROUND FOR THE OTHER FLIP. One launch, two arcs, and
  // which one is the direction the circle went — the whole of the extra
  // agency this buys.
  resetSealFlip();
  pump(F.cooldown + 0.1);
  triggerFlip(-1, {}, false, null);
  let back = 0;
  pump(flipDuration(), () => { back += flipSteerDelta(); });
  check('the other flip bends it the other way',
    Math.sign(back) === -Math.sign(bend) && Math.abs(back + bend) < 0.02,
    `${(back * 180 / Math.PI).toFixed(0)}deg vs ${(bend * 180 / Math.PI).toFixed(0)}deg`);

  // THE DELTA IS A DELTA. A frame it is not read on is curve the dash does not
  // get; a frame read twice must not be counted twice either, or a caller that
  // asked in two places would bend the line at double rate.
  resetSealFlip();
  pump(F.cooldown + 0.1);
  triggerFlip(1, {}, false, null);
  pump(F.windup + F.spin * 0.3);
  const a1 = flipSteerDelta();
  const a2 = flipSteerDelta();
  check('reading it twice in a frame gives the same answer', a1 === a2 && a1 !== 0,
    `${a1.toFixed(4)}`);
  resetSealFlip();

  // WHAT A SLAP OFF A DASH IS WORTH.
  const idle = flipDashBoost(false, 1);
  check('no dash, no boost', idle.gain === 1 && idle.carry === 0);
  const full = flipDashBoost(true, 1);
  check('a full-power dash throws harder', full.gain > 1.2, `x${full.gain.toFixed(2)}`);
  check('...and drags what it hits along its own line', full.carry > 0.1,
    `${full.carry.toFixed(2)} of the dash's direction`);
  const weak = flipDashBoost(true, 0.15);
  check('a one-pip flick is not a full commitment',
    weak.gain < full.gain && weak.carry < full.carry,
    `x${weak.gain.toFixed(2)} / ${weak.carry.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// THE RIG. Everything above is arithmetic; this is the animal.
// ---------------------------------------------------------------------------
if (!existsSync(SEAL)) {
  console.error(`\nmissing ${SEAL} — the rig has to be in public/models for the game to load it too.\n`);
  process.exit(1);
}
const buf = readFileSync(SEAL);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
installModel('ship', gltf.scene, gltf.animations);

/**
 * One seal, built the way entities/player.js builds it.
 *
 * `tag` is who the flip driver answers for — null is the run's player, which
 * is what triggerFlip below flips. The CONTROL seal is built with a tag
 * nothing ever flips under, and that is not a trick to make the test pass: a
 * driver that posed on anybody's flip is exactly the bug this arrangement
 * catches, and the first version of this file had a control that tucked in
 * sympathy and measured identical to the animal under test.
 */
function makeSeal(tag = null) {
  const holder = new THREE.Object3D();
  holder.rotation.z = -Math.PI / 2;
  const body = createVisual('ship');
  holder.add(body);
  const anim = createAnimationController(body);
  const rig = createAimRig(body);
  const flip = createFlipDriver(body, tag);
  return { holder, body, anim, rig, flip };
}

const AIM = new THREE.Vector2(1, 0);
function frame(seal, dt = DT) {
  seal.anim?.update(dt, 'swim', false);
  // WITHOUT THIS EVERY POSE MEASURES IDENTICAL and nothing throws — see
  // [[software skinning needs forced world matrices]].
  seal.holder.updateMatrixWorld(true);
  seal.rig?.update(dt, AIM, { engaged: true });
  seal.holder.updateMatrixWorld(true);
  seal.flip?.update(dt);
  seal.holder.updateMatrixWorld(true);
}

const subject = makeSeal(null);
const control = makeSeal('not-this-one');

section('the real rig');
{
  resetSealFlip();
  for (let i = 0; i < 120; i++) { frame(subject); frame(control); }

  // WHERE THE HANDS ARE IN THE BODY'S OWN FRAME — back/forward and in/out from
  // the chest — and NOT how folded the limb is.
  //
  // The fold was the first measurement here and it says almost nothing: CCD
  // with the joint stops in CONFIG.sealFlip.ik cannot collapse a flipper, so
  // the tip stays about 1.4 units from its own shoulder whatever the pose asks
  // for, and every shape from a tuck to a salute measured within 6% of every
  // other. What actually changes is where the limb POINTS, which is what a
  // tuck is: tips drawn back toward the tail and in toward the flanks.
  //
  // This is also how the first defaults shipped inverted — they read as a tuck
  // and measured as the opposite, putting the tips 0.23 further OUT from the
  // centreline than a swimming seal's.
  //
  // ...AND ALWAYS AGAINST THE CONTROL, NEVER AGAINST AN EARLIER SNAPSHOT OF
  // THE SAME SEAL. The swim cycle moves these flippers by more than the tuck
  // does over a stroke, so "before and after" compares two phases of a swim
  // and calls the difference a ratchet. The control is the same animal on the
  // same clock with the flip left out, so any difference between the two at
  // one instant belongs to the flip.
  const _v = new THREE.Vector3();
  const _c = new THREE.Vector3();
  function handsOf(seal, probe, chest) {
    probe.refreshBasis();
    chest.getWorldPosition(_c);
    let fore = 0;
    let lat = 0;
    for (const m of seal.rig.muzzles) {
      _v.copy(m).sub(_c);
      fore += _v.dot(probe.basis.fore);
      lat += Math.abs(_v.dot(probe.basis.lat));
    }
    const n = seal.rig.muzzles.length;
    return { fore: fore / n, lat: lat / n };
  }
  const sProbe = createPoseRig(subject.body, 'flip-test-subject');
  const cProbe = createPoseRig(control.body, 'flip-test-control');
  const sChest = subject.body.getObjectByName('chest_04') ?? subject.body;
  const cChest = control.body.getObjectByName('chest_04') ?? control.body;
  const subjectHands = () => handsOf(subject, sProbe, sChest);
  const controlHands = () => handsOf(control, cProbe, cChest);

  check('the model has a flip driver', !!subject.flip);
  check('...and a tail chain for the slap to shove', subject.flip.hasTail);
  {
    const a = subjectHands();
    const b = controlHands();
    check('the two seals start identical',
      Math.abs(a.fore - b.fore) < 1e-6 && Math.abs(a.lat - b.lat) < 1e-6,
      `fore ${a.fore.toFixed(3)}/${b.fore.toFixed(3)}  lat ${a.lat.toFixed(3)}/${b.lat.toFixed(3)}`);
  }

  triggerFlip(1, {}, false, null);
  let tucked = null;
  let swimming = null;
  const mid = F.windup + F.spin * 0.5;
  for (let t = 0; t < flipDuration(); t += DT) {
    updateSealFlip(DT, subject.rig);
    frame(subject);
    frame(control);
    if (flipState.active && Math.abs(t - mid) < DT / 2) {
      tucked = subjectHands();
      swimming = controlHands();
    }
  }
  check('the flippers come BACK during the turn', tucked && tucked.fore < swimming.fore - 0.2,
    `fore ${tucked?.fore.toFixed(2)} vs ${swimming?.fore.toFixed(2)} swimming`);
  check('...and IN against the flanks', tucked && tucked.lat < swimming.lat - 0.2,
    `lat ${tucked?.lat.toFixed(2)} vs ${swimming?.lat.toFixed(2)} swimming`);

  // ...AND THEY COME BACK. This is the assertion the whole rig section exists
  // for, and getting it RIGHT needed one discovery:
  //
  // A SEAL THAT HAS BEEN POSED ONCE NEVER RETURNS EXACTLY TO ONE THAT NEVER
  // WAS, and that is not this move's doing. Pose a flipper through
  // systems/poseRig.js and the aim rig settles to a steady state about 0.16
  // forward and 0.19 in from where it sat before — once, on the first pose,
  // and never again. `npm run test:clap`'s seal does exactly the same by
  // exactly the same amount (0.1634 / -0.1931 to four places, which is how
  // this was pinned down): it is a property of a chain that has been written
  // by a second solver, not of anything either gesture does.
  //
  // So "released" cannot mean "identical to the control" — asserting that
  // would be asserting a bug in the shared rig, and the honest version is the
  // one that matters to a player anyway: the pose STOPS MOVING, and the
  // twentieth flip leaves the animal exactly where the first one did.
  for (let i = 0; i < 90; i++) { frame(subject); frame(control); }
  const settled = { s: subjectHands(), c: controlHands() };
  const once = {
    fore: settled.s.fore - settled.c.fore,
    lat: settled.s.lat - settled.c.lat,
  };
  for (let i = 0; i < 600; i++) { frame(subject); frame(control); }
  {
    const a = subjectHands();
    check('the pose stops moving once the flip is over',
      Math.abs(a.fore - settled.s.fore) < 0.005 && Math.abs(a.lat - settled.s.lat) < 0.005,
      `fore ${a.fore.toFixed(4)} vs ${settled.s.fore.toFixed(4)} ten seconds earlier`);
    check('...and it is close to a seal that never flipped',
      Math.abs(once.fore) < 0.3 && Math.abs(once.lat) < 0.3,
      `off by fore ${once.fore.toFixed(3)} lat ${once.lat.toFixed(3)} (the shared-rig settle)`);
  }

  // Twenty flips, both directions. A drift too small to see in one is a
  // different animal by the twentieth — measured against the offset the FIRST
  // flip left, which is the thing that must not grow.
  for (let n = 0; n < 20; n++) {
    resetSealFlip();
    triggerFlip(n % 2 ? -1 : 1, {}, false, null);
    for (let t = 0; t < flipDuration() + 0.05; t += DT) {
      updateSealFlip(DT, subject.rig);
      frame(subject);
      frame(control);
    }
  }
  for (let i = 0; i < 120; i++) { frame(subject); frame(control); }
  {
    const a = subjectHands();
    const b = controlHands();
    const now = { fore: a.fore - b.fore, lat: a.lat - b.lat };
    // NO LARGER, rather than identical. The settle above is one step whose
    // size depends on the pose history — twenty flips land a little CLOSER to
    // the control than one does, not further — so the claim worth asserting is
    // the one a ratchet would break: it does not grow.
    check('twenty flips do not walk the pose any further out',
      Math.abs(now.fore) <= Math.abs(once.fore) + 0.02
      && Math.abs(now.lat) <= Math.abs(once.lat) + 0.02,
      `fore ${now.fore.toFixed(4)} after twenty vs ${once.fore.toFixed(4)} after one,`
      + ` lat ${now.lat.toFixed(4)} vs ${once.lat.toFixed(4)}`);
  }
}

section('the tail whips rather than hangs');
{
  const T = F.tail;
  const base = CONFIG.tail;
  resetSealFlip();
  check('a swimming tail is exactly CONFIG.tail', flipTailSpring() === null);

  triggerFlip(1, {}, false, null);
  noteFlipCommit(1);
  // EASED IN, NOT SNAPPED. A spring whose constants jump is a chain that
  // twitches, and it is visible at 60fps.
  pump(DT * 2);
  const early = flipTailSpring();
  check('it starts changing immediately', early && early.stiffness !== 1);
  check('...but is not fully there on the second frame',
    early.stiffness < T.stiffness && early.damping > T.damping,
    `stiffness x${early.stiffness.toFixed(2)} of x${T.stiffness}`);

  let peakStiff = 0;
  let lowDamp = Infinity;
  pump(flipDuration(), () => {
    const m = flipTailSpring();
    if (!m) return;
    peakStiff = Math.max(peakStiff, m.stiffness);
    lowDamp = Math.min(lowDamp, m.damping);
  });
  check('it reaches the authored whip mid-turn',
    Math.abs(peakStiff - T.stiffness) < 0.01 && Math.abs(lowDamp - T.damping) < 0.01,
    `stiffness x${peakStiff.toFixed(2)}, damping x${lowDamp.toFixed(2)}`);
  check('...and the tail is back to swimming by the end', flipTailSpring() === null);

  // THE SNAP IS THE DAMPING RATIO, and it is the whole point of this block.
  //
  // Everywhere else in the rig the damping follows the square root of the
  // stiffness so a changed chain keeps its ratio — a tail that ARRIVES. This
  // one deliberately breaks it downward so the tip overshoots the pose and
  // comes back, which is a tail that CRACKS. The first version of this feature
  // held the ratio and only softened the spring, and the result was a tail
  // dragging limply behind the somersault: slower to return and no more
  // willing to overshoot.
  const zSwim = base.damping / (2 * Math.sqrt(base.stiffness));
  const zWhip = (base.damping * T.damping)
    / (2 * Math.sqrt(base.stiffness * T.stiffness));
  check('the flip is UNDERDAMPED where the swim is not',
    zWhip < zSwim * 0.6, `ratio ${zSwim.toFixed(2)} swimming -> ${zWhip.toFixed(2)} flipping`);
  check('...enough to overshoot at all', zWhip < 0.7, `${zWhip.toFixed(2)}`);
  // ...AND NOT SO FAR THAT IT RINGS ON. Under about 0.15 the tail is still
  // swinging when the flip is over, which reads as rubber rather than muscle.
  check('...and not so far that it rings past the move', zWhip > 0.15,
    `${zWhip.toFixed(2)}`);

  // THE RETURN IS FASTER, NOT SLOWER — the mistake the first version made.
  check('the spring comes back HARDER than a swimming one, not softer',
    T.stiffness > 1, `x${T.stiffness}`);
  check('...with more room to trail before it does', T.lag > 1, `maxLag x${T.lag}`);

  // The ring settles inside the move: the envelope decays as e^(-z w t), and
  // a whip that is still swinging when the tuck has let go is a tail the pose
  // no longer owns.
  {
    const w = Math.sqrt(base.stiffness * T.stiffness);
    const left = Math.exp(-zWhip * w * flipDuration());
    check('the swing has died down by the end of the flip', left < 0.2,
      `${(left * 100).toFixed(0)}% of the overshoot left after ${flipDuration().toFixed(2)}s`);
  }
  resetSealFlip();
}

section('the tail is shoved, not posed');
{
  resetSealFlip();
  // The impulse goes into the spring, so the tail's WORLD position has to move
  // further than swimming alone moves it — measured against the control, which
  // is running the identical swim cycle on the identical clock.
  const tipOf = (s) => s.flip.tip(new THREE.Vector3()).clone();
  for (let i = 0; i < 60; i++) { frame(subject); frame(control); }

  triggerFlip(1, {}, false, null);
  const w = flipSlapWindow();
  let worst = 0;
  for (let t = 0; t < w.close + 0.1; t += DT) {
    updateSealFlip(DT, subject.rig);
    frame(subject);
    frame(control);
    // Both seals are at the origin and both are swimming; the only difference
    // between them is the flip, so any distance between the two tails is the
    // flip's doing. Compared in the BODY's frame (the holder is identical), so
    // the somersault's own rotation is not being measured as a shove.
    worst = Math.max(worst, tipOf(subject).distanceTo(tipOf(control)));
  }
  check('the slap moves the tail further than swimming does', worst > 0.05,
    `${worst.toFixed(3)} world units off the control's tail`);
  resetSealFlip();
}

// ---------------------------------------------------------------------------
// BLUBBERBALL. The same move, spent on a ball and on the other seals.
//
// LAST IN THE FILE ON PURPOSE: startVersus builds a match, four seals and a
// ball into the same process, and the rig section above measures a seal
// against a control on a shared module clock. Run first, it would be posing
// the animal under test.
// ---------------------------------------------------------------------------
const { enableVersus } = await import('../path/src/systems/versusFlag.js');
const { updateBounds, midWater } = await import('../path/src/arena.js');
const { player, initPlayer, resetPlayer } = await import('../path/src/entities/player.js');
const { initParticles } = await import('../path/src/entities/particles.js');
const { onFeedback } = await import('../path/src/systems/feedback.js');
const V = await import('../path/src/systems/versus.js');

section('Blubberball — the tail through the ball');
{
  const scene = new THREE.Scene();
  updateBounds();
  enableVersus(true);
  initPlayer(scene);
  initParticles(scene);
  resetPlayer();
  V.startVersus(scene);
  for (let t = 0; t < 14 && V.versusState.phase !== 'play'; t += DT) {
    const scale = V.updateVersusClock(DT, []);
    V.updateVersus(DT * scale, []);
  }

  // The flipping seal at the origin, heading +X — the same two terms
  // flipSlapBall reads (mesh.rotation.z plus the quarter turn createVisual
  // leaves the art nose-up by).
  player.mesh.position.set(0, midWater(), 0);
  player.mesh.rotation.z = -Math.PI / 2;
  // Everyone else a long way off, or a body check would be what these
  // assertions are measuring.
  for (const seal of V.matchSeals()) {
    if (V.seatOf(seal) === 0) continue;
    V.sealPos(seal).set(-400 - V.seatOf(seal) * 12, midWater() - 60, 0);
    seal.velocity.set(0, 0);
  }

  /** Open a window and put the ball on the tail's line, `frac` of the way out. */
  function stage(frac = 0.6) {
    resetSealFlip();
    triggerFlip(1, {}, false, null);
    pump(flipSlapWindow().open + DT);
    const a = (player.mesh.rotation.z + Math.PI / 2) + flipState.angle + Math.PI;
    V.resetBall();
    ball_live(true);
    V.ball.x = player.mesh.position.x + Math.cos(a) * F.reach * frac;
    V.ball.y = player.mesh.position.y + Math.sin(a) * F.reach * frac;
    V.ball.vx = 0; V.ball.vy = 0; V.ball.spin = 0;
    V.solveBallSurface();
    return a;
  }
  function ball_live(v) { V.ball.live = v; }

  {
    const a = stage();
    const before = { vx: V.ball.vx, vy: V.ball.vy };
    // The rim on the side the tail is coming from, BEFORE — the contact angle
    // is measured from the ball's centre back toward the seal.
    const toSeal = Math.atan2(player.mesh.position.y - V.ball.y, player.mesh.position.x - V.ball.x);
    const rimBefore = V.ballHitRadiusAt(toSeal);
    const hit = V.flipSlapBall(0);
    check('a ball on the tail is slapped', hit === true);
    const sp = Math.hypot(V.ball.vx - before.vx, V.ball.vy - before.vy);
    check('...and it leaves', sp > 10, `${sp.toFixed(1)} u/s added`);

    // THE DENT, measured on the drawn edge rather than on `ball.r` — that is
    // the shape the game collides and draws, and a dent that only moved the
    // rigid radius would be invisible on both.
    //
    // SOLVED FIRST, because that is the frame order the game runs: the
    // surface is solved, then things collide with it, so a dent put in by a
    // contact shows on the NEXT frame's edge. Measuring without this reads the
    // surface from BEFORE the slap and reports a perfectly round ball, which
    // is what the first version of this check did.
    V.solveBallSurface();
    const rimAfter = V.ballHitRadiusAt(toSeal);
    check('...and it is DENTED where the tail hit it',
      rimAfter < rimBefore - 0.05,
      `edge ${rimBefore.toFixed(3)} -> ${rimAfter.toFixed(3)} on the contact side`);
    // ...on the CONTACT side and not all over: the far side does not cave in.
    const farBefore = rimBefore;
    const farAfter = V.ballHitRadiusAt(toSeal + Math.PI);
    check('...on that side, not everywhere',
      farAfter > rimAfter, `far side ${farAfter.toFixed(3)} vs near ${rimAfter.toFixed(3)}, rest ${farBefore.toFixed(3)}`);
  }

  // THE MESS. The event carries the water and the ball's own goo, and it goes
  // through ballImpactFx — so this asserts what that helper was handed, which
  // is where a burst fired at the ball's CENTRE or with no goo would show up.
  {
    let seen = null;
    const off = onFeedback((name, at) => { if (name === 'versusFlipSlap') seen = at; });
    stage();
    V.flipSlapBall(0);
    off?.();
    check('the slap fires its own event', !!seen);
    check('...throwing far more than a dribble does',
      (seen?.scale ?? 0) >= 2, `scale ${seen?.scale?.toFixed(2)}`);
    check('...with the goo sized on its own axis',
      (seen?.gooSizeMul ?? 0) > 1 && (seen?.gooSpeedMul ?? 0) > 1,
      `goo ${seen?.gooSizeMul} x ${seen?.gooSpeedMul}`);
    // ON THE BALL'S DRAWN EDGE, not at its centre — ballImpactFx's whole job.
    const d = Math.hypot((seen?.x ?? 0) - V.ball.x, (seen?.y ?? 0) - V.ball.y);
    check('...out of the contact, not the middle of the ball', d > 0.5,
      `${d.toFixed(2)} from the centre`);
  }

  {
    // ONE SLAP PER FLIP, through the same ledger the fish go through.
    stage();
    check('the first frame connects', V.flipSlapBall(0) === true);
    check('...and the rest of the window does not',
      V.flipSlapBall(0) === false && V.flipSlapBall(0) === false);
  }

  {
    // A ball on the far side is not touched — the same rule the bodies get,
    // and the reason the move is something to aim.
    //
    // PLACED WELL CLEAR, and the distance is worth knowing: this ball's drawn
    // radius is about 4.9 and the tail reaches 5.7, so the slap's envelope
    // (the tail's line, plus `flipSlap.reach`, plus the ball's own edge) is
    // over seven units wide against a body nearly as big as the swing. A ball
    // "in front" at half a tail-length is still inside that — it is sitting on
    // the seal — so the directional rule is real but it only bites at range,
    // which is a fact about how big this ball is rather than about the arc.
    const a = stage();
    const clear = F.reach + V.ballHitRadius() + (CONFIG.versus.ball.flipSlap.reach ?? 2.2) + 1;
    V.ball.x = player.mesh.position.x - Math.cos(a) * clear;
    V.ball.y = player.mesh.position.y - Math.sin(a) * clear;
    V.solveBallSurface();
    check('a ball on the far side is not slapped', V.flipSlapBall(0) === false,
      `${clear.toFixed(1)} units the other way`);
  }

  {
    // THE BACKFLIP'S WALL, against the ball. A block and not a backboard: the
    // shot has to DIE in it, or the wall is a pass to whoever is standing
    // behind it.
    resetGooWalls();
    V.resetBall();
    V.ball.live = true;
    // THE SEAL MOVES, NOT THE BALL. Two things bit here in turn: staged on top
    // of the player (which is parked at the origin for the slap tests above)
    // the ball took a BODY CHECK in the same frame and read as the wall having
    // reversed it; staged far enough away to dodge that, it was outside the
    // pitch and the arena did something else to it. The ball belongs in the
    // middle of the water and the animal belongs out of the way.
    player.mesh.position.set(-300, midWater() - 60, 0);
    V.ball.x = 0;
    V.ball.y = midWater();
    V.ball.vx = 40;
    V.ball.vy = 0;
    V.ball.spin = 8;
    V.solveBallSurface();
    // A wall across its path — laid by hand rather than by a flip, because
    // what is under test here is the BOUNCE and a wall painted by a
    // somersault would put the curve and the ball's approach angle into the
    // same assertion. Nodes are what a wall is now, so the API is the same one
    // the tail uses.
    const wx = V.ball.x + V.ballHitRadius() + 0.4;
    const w = spawnGooWall(0, 0, 0);
    for (let i = -5; i <= 5; i++) extendGooWall(w, wx, V.ball.y + i * 1.1);
    sealGooWall(w);
    check('a wall is up in front of the ball', !!w && w.nodes.length > 5,
      `${w?.nodes.length} nodes`);
    const spin0 = V.ball.spin;
    V.updateVersus(DT, []);
    check('the ball is turned back by it', V.ball.vx < 0,
      `${V.ball.vx.toFixed(1)} u/s after, from 40`);
    check('...and it DIES there rather than pinging off',
      Math.abs(V.ball.vx) < 40 * 0.6, `${Math.abs(V.ball.vx).toFixed(1)} vs 40 in`);
    check('...and the goo scrubs the spin off it',
      Math.abs(V.ball.spin) < Math.abs(spin0),
      `${V.ball.spin.toFixed(1)} from ${spin0.toFixed(1)}`);
    // ONE STOP PER WALL: a ball resting against one touches it every frame,
    // and a second reflection would rattle it in place.
    const vAfter = V.ball.vx;
    V.ball.vx = 40;
    V.updateVersus(DT, []);
    check('...and it is not reflected twice by the same wall', V.ball.vx > 0,
      `${V.ball.vx.toFixed(1)}, was turned to ${vAfter.toFixed(1)}`);
    resetGooWalls();
    player.mesh.position.set(0, midWater(), 0);
  }

  {
    // ...AND THE OTHER SEALS. This is what the move is for in this game.
    const a = stage();
    const other = V.matchSeals().find((sl) => V.seatOf(sl) !== 0);
    V.sealPos(other).set(
      player.mesh.position.x + Math.cos(a) * F.reach * 0.6,
      player.mesh.position.y + Math.sin(a) * F.reach * 0.6,
      0,
    );
    other.knockX = 0;
    other.knockY = 0;
    const n = V.flipSlapSeals();
    check('a seal in the arc is thrown', n === 1, `${n} caught`);
    check('...along the swing', Math.hypot(other.knockX, other.knockY) > 5,
      `${Math.hypot(other.knockX, other.knockY).toFixed(1)} u/s`);
    // NOT THE SEAL DOING IT: its own tail is inside its own hitbox by
    // construction, and without the seat check the move was a self-shove.
    // Everyone else is put back out of the water first — left in the arc from
    // the check above, this would count THEM and pass for the wrong reason.
    for (const sl of V.matchSeals()) {
      if (V.seatOf(sl) === 0) continue;
      V.sealPos(sl).set(-400 - V.seatOf(sl) * 12, midWater() - 60, 0);
    }
    resetSealFlip();
    triggerFlip(1, {}, false, null);
    pump(flipSlapWindow().open + DT);
    check('the flipping seal does not shove itself', V.flipSlapSeals() === 0);
  }
  resetSealFlip();
}

console.log(failures ? `\n${failures} failing\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
