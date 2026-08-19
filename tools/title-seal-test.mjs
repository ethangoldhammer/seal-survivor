#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:title
//
// THE TITLE SHOT — systems/titleSeal.js. The seal held up against the lens
// while the Rive card is on screen, turning to follow the cursor.
//
// Two halves, because the feature is two claims and they fail in completely
// different ways.
//
//   THE FRAMING is a claim on world.focusCamera, and every way it can be wrong
//   is a JUMP that lasts one frame. A push-in that starts at full weight snaps
//   on the frame the card appears; a release that starts from 1 rather than
//   from wherever the push-in had got to snaps for anyone who dismisses the
//   card early — which is every returning player, because their name is
//   already in the field and Enter is the only key they press. One frame is
//   exactly as long as it takes to be seen and exactly too short to catch in a
//   screenshot, so it is measured here instead.
//
//   THE POSE is the actual feature: the head and the flippers pointing at the
//   cursor. That half is measured on the REAL rig, off furseal.glb, because
//   the thing worth failing over is not "the solver ran" — it is whether the
//   flipper tips and the muzzle end up somewhere DIFFERENT when the cursor
//   moves. A rig that has quietly released its bones back to the swim clip
//   passes every "did it run" check ever written and points at nothing.
//
// What this cannot tell you: whether the seal is visible at all. That depends
// on how much of the ocean ui/riveSplash.js paints over (CONFIG.titleSeal
// .scrim) and on whether the splash artboard carries a background of its own,
// which is a fact about seal_survivor.riv and not about any of this code.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG } from '../path/src/config.js';
import { ease } from '../path/src/ease.js';
import { input } from '../path/src/input.js';
import { installModel, createVisual } from '../path/src/assets.js';
import { createAimRig } from '../path/src/systems/aimRig.js';
import { createAnimationController, stateForSpeed } from '../path/src/systems/animation.js';
import { player, poseBody, updateAimRig } from '../path/src/entities/player.js';
import {
  beginTitleSeal, endTitleSeal, resetTitleSeal,
  titleSealActive, titleSealEngaged, updateTitleSeal,
} from '../path/src/systems/titleSeal.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = resolve(HERE, '../public/models/furseal.glb');
const DT = 1 / 60;
const DEG = 180 / Math.PI;

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// The tuning on disk is the tuning being tested — a shot tuned to zoom 1.02
// should fail the "it actually pushes in" check below rather than being
// measured against numbers this file made up.
const CFG = CONFIG.titleSeal;
// THE FEATURE IS OFF BY DEFAULT NOW — the splash owns the pointer, so the seal
// is no longer held up behind the title card (see CONFIG.titleSeal.enabled).
// Everything below is about the MECHANISM, which is still all here and still
// worth keeping honest, so the harness turns it on for itself rather than
// riding on whatever the shipped default happens to be. That is the right
// shape either way: a test of the push-in that silently stopped testing it the
// day somebody flipped a default is a test that was never really asserting
// anything.
CFG.enabled = true;

// --- a camera that only remembers what was asked of it -----------------------
// world.focusCamera is a per-frame CLAIM (see world.js): nothing releases it,
// and a shot that stops claiming stops being framed. So the whole contract is
// the sequence of claims, and this records it.
function recorder() {
  const claims = [];
  return {
    claims,
    focusCamera(pos, zoom, weight) { claims.push({ x: pos.x, y: pos.y, zoom, weight }); },
    last() { return claims[claims.length - 1]; },
  };
}

// ---------------------------------------------------------------------------
// THE FRAMING
// ---------------------------------------------------------------------------

// Enough of a seal for the framing to have something to frame. The pose half
// below uses the real model; this half deliberately does not, so a broken
// export cannot take the camera maths down with it.
player.mesh = new THREE.Group();
player.body = new THREE.Object3D();
player.mesh.add(player.body);
player.mesh.position.set(3, -7, 0);

section('NOTHING IS CLAIMED UNTIL THE CARD GOES UP');
{
  resetTitleSeal();
  const cam = recorder();
  updateTitleSeal(DT, cam);
  check('no claim before beginTitleSeal', cam.claims.length === 0, `${cam.claims.length} claims`);
  check('...and the shot reports itself inactive', !titleSealActive());
}

section('THE PUSH-IN STARTS FROM THE RUN\'S OWN FRAMING');
{
  resetTitleSeal();
  const cam = recorder();
  beginTitleSeal();
  check('the shot is live', titleSealActive());
  check('...and the aim rig is told to commit', titleSealEngaged());

  updateTitleSeal(DT, cam);
  const first = cam.last();
  // THE CHECK THAT CATCHES A SNAP ON THE FIRST FRAME. At weight 0 the claim is
  // identical to no claim at all (see applyFocus in world.js), so the first
  // frame has to be within a hair of it whatever the curve is.
  check('the first frame is barely a claim at all', first.weight < 0.1,
    `weight ${first.weight.toFixed(4)}`);
  check('...so the zoom starts at the run\'s', first.zoom < 1 + (CFG.zoom - 1) * 0.1,
    `zoom ${first.zoom.toFixed(4)} of ${CFG.zoom}`);

  // ...and it is monotone the whole way in. A curve read backwards, or a
  // release that fired by accident, shows up here and nowhere else.
  let backwards = 0;
  for (let t = DT; t < CFG.inTime; t += DT) {
    const prev = cam.last().weight;
    updateTitleSeal(DT, cam);
    if (cam.last().weight < prev - 1e-9) backwards++;
  }
  check('it never goes backwards on the way in', backwards === 0, `${backwards} frames`);
}

section('...AND ARRIVES WHERE IT WAS TUNED TO');
{
  resetTitleSeal();
  const cam = recorder();
  beginTitleSeal();
  for (let t = 0; t < CFG.inTime + 0.5; t += DT) updateTitleSeal(DT, cam);
  const held = cam.last();
  check('the shot reaches full weight', Math.abs(held.weight - 1) < 1e-6,
    `weight ${held.weight.toFixed(6)}`);
  check('...at exactly the tuned zoom', Math.abs(held.zoom - CFG.zoom) < 1e-6,
    `${held.zoom} against ${CFG.zoom}`);

  // THE OFFSET IS SUBTRACTED, NOT ADDED, and this is the one line of this file
  // that is easy to write backwards. `offset` is where the SEAL sits relative
  // to the middle of the frame, so the point that lands in the middle is the
  // seal MINUS it: a seal asked to sit below centre needs the frame ABOVE it.
  check('the seal sits off centre by the tuned offset, the right way round',
    Math.abs(held.x - (player.mesh.position.x - CFG.offset.x)) < 1e-6
    && Math.abs(held.y - (player.mesh.position.y - CFG.offset.y)) < 1e-6,
    `focus (${held.x.toFixed(2)}, ${held.y.toFixed(2)}) for a seal at `
    + `(${player.mesh.position.x}, ${player.mesh.position.y})`);

  // A held shot is steady. Nothing in here reads the camera back, so a value
  // that compounds with itself frame over frame would be visible as drift.
  const before = { ...cam.last() };
  for (let i = 0; i < 120; i++) updateTitleSeal(DT, cam);
  const after = cam.last();
  check('and it holds still while the card is up',
    Math.abs(after.zoom - before.zoom) < 1e-9 && Math.abs(after.y - before.y) < 1e-9,
    `zoom drift ${(after.zoom - before.zoom).toExponential(2)}`);
}

section('THE RELEASE STARTS FROM WHEREVER THE PUSH-IN HAD GOT TO');
{
  // The case: a returning player whose name is already in the field presses
  // Enter almost immediately. Releasing from 1 instead of from here is a jump
  // straight to full push-in on the frame the run begins — the loudest
  // possible version of the bug, on the most common route into the game.
  resetTitleSeal();
  const cam = recorder();
  beginTitleSeal();
  const early = CFG.inTime * 0.3;
  for (let t = 0; t < early; t += DT) updateTitleSeal(DT, cam);
  const atDismiss = cam.last().weight;
  check('the card is dismissed part-way in', atDismiss > 0.05 && atDismiss < 0.95,
    `weight ${atDismiss.toFixed(3)}`);

  endTitleSeal();
  updateTitleSeal(DT, cam);
  check('the release does not jump up first', cam.last().weight <= atDismiss + 1e-9,
    `${cam.last().weight.toFixed(3)} against ${atDismiss.toFixed(3)}`);
  check('...and the rig is no longer told to commit, because the run owns it now',
    !titleSealEngaged());
  check('...though the shot is still claiming the frame', titleSealActive());

  let peak = 0;
  let frames = 0;
  while (titleSealActive() && frames++ < 600) {
    updateTitleSeal(DT, cam);
    peak = Math.max(peak, cam.last().weight);
  }
  check('the release never exceeds where it started', peak <= atDismiss + 1e-9,
    `peak ${peak.toFixed(3)}`);
  check('it lets go of the frame entirely', !titleSealActive(), `after ${frames} frames`);
  check('...in about the tuned time', Math.abs(frames * DT - CFG.outTime) < 0.1,
    `${(frames * DT).toFixed(2)}s against ${CFG.outTime}s`);
  check('and the last thing it claimed was the run\'s own framing',
    cam.last().weight < 0.02 && cam.last().zoom < 1.05,
    `weight ${cam.last().weight.toFixed(4)}, zoom ${cam.last().zoom.toFixed(4)}`);
  const after = cam.claims.length;
  updateTitleSeal(DT, cam);
  check('...and it stops claiming for good', cam.claims.length === after);
}

section('THE FULL RELEASE IS THE SAME SHAPE');
{
  resetTitleSeal();
  const cam = recorder();
  beginTitleSeal();
  for (let t = 0; t < CFG.inTime + 0.2; t += DT) updateTitleSeal(DT, cam);
  endTitleSeal();
  updateTitleSeal(DT, cam);
  // Against the curve itself rather than against a number typed in here, so
  // retuning `outEase` does not fail this file.
  const want = 1 - ease(CFG.outEase, DT / CFG.outTime);
  check('one frame into a full release it follows the tuned curve',
    Math.abs(cam.last().weight - want) < 1e-6,
    `${cam.last().weight.toFixed(5)} against ${want.toFixed(5)}`);
}

section('THE SWITCH IS A REAL SWITCH');
{
  resetTitleSeal();
  const cam = recorder();
  const was = CFG.enabled;
  CFG.enabled = false;
  beginTitleSeal();
  updateTitleSeal(DT, cam);
  check('enabled:false means no shot and no claim',
    !titleSealActive() && cam.claims.length === 0, `${cam.claims.length} claims`);

  // ...and flicking it off while looking at the shot has to RELEASE, not
  // vanish. A tuning switch that cuts the camera is one nobody dares press.
  CFG.enabled = true;
  resetTitleSeal();
  beginTitleSeal();
  for (let t = 0; t < CFG.inTime + 0.2; t += DT) updateTitleSeal(DT, cam);
  CFG.enabled = false;
  updateTitleSeal(DT, cam);
  // One frame in, the release has barely started — which is the point: it must
  // still be claiming a nearly-full frame rather than having vanished. Testing
  // that alone would pass on a rounding artefact, so the ramp is walked out.
  check('flicking it off mid-shot does not cut the frame',
    titleSealActive() && cam.last().weight > 0.9, `weight ${cam.last().weight.toFixed(4)}`);
  const mid = Math.round((CFG.outTime / 2) / DT);
  for (let i = 0; i < mid; i++) updateTitleSeal(DT, cam);
  check('...it eases out like any other release',
    titleSealActive() && cam.last().weight > 0.05 && cam.last().weight < 0.9,
    `weight ${cam.last().weight.toFixed(3)} halfway through`);
  let n = 0;
  while (titleSealActive() && n++ < 600) updateTitleSeal(DT, cam);
  check('...and gets all the way out', !titleSealActive());
  CFG.enabled = was;
  resetTitleSeal();
}

// ---------------------------------------------------------------------------
// THE POSE — on the real rig
// ---------------------------------------------------------------------------

if (!existsSync(MODEL)) {
  console.error(`\nmissing ${MODEL} — the seal has to be in public/models for the game to load it too.\n`);
  process.exit(1);
}

const buf = readFileSync(MODEL);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
);
installModel('ship', gltf.scene, gltf.animations);

const scene = new THREE.Scene();
// The same two-object arrangement initPlayer builds: a container that carries
// the heading, and the visual inside it that carries the left/right flip. The
// aim rig solves in WORLD space, so measuring anything off the wrong one of
// these gives a number that is right only while the seal faces right.
const group = new THREE.Group();
const body = createVisual('ship');
group.add(body);
scene.add(group);
player.mesh = group;
player.body = body;
player.anim = createAnimationController(body);
player.aimRig = createAimRig(body);

section('THE RIG IS THERE TO BE POINTED');
check('the aim rig resolved off the real model', !!player.aimRig);
check('both flipper chains built', player.aimRig?.fins.length === 2);
check('the neck chain built', !!player.aimRig?.head);

// One title-screen frame, in the order main.js runs it: the aim rig solves
// first (from the menu branch of animate), then the title shot poses the body.
// Deliberately this way round rather than the intuitive one — see the note on
// updateTitleSeal.
const cam = recorder();

// One frame, in the order animate() runs them on a menu: the mixer writes the
// idle clip, the aim rig overwrites the neck and flippers on top of it, and the
// title shot poses the body. Deliberately this way round and not the intuitive
// one — see the note on updateTitleSeal.
//
// THE MIXER CALL IS NOT OPTIONAL and leaving it out does not fail, it LIES.
// applyChainToPoint snapshots `bones[i].quaternion` at the top of every solve as
// the pose to blend back toward; with no clip writing that pose it is the
// solver's OWN output from last frame, so the blend converges to a full solve
// whatever the weight is, and every weight-sensitive measurement below comes out
// identical to four decimal places.
function titleFrame(engaged = titleSealEngaged()) {
  player.anim.update(DT, stateForSpeed(0, false, 0), false);
  updateAimRig(DT, input.aim, engaged, 0, false);
  updateTitleSeal(DT, cam);
  // Without this every pose measures identical and nothing throws: in a
  // terminal there is no renderer to have refreshed the graph.
  scene.updateMatrixWorld(true);
}

// Where the rig has put the head and the flipper tips, in world space, as
// directions from the seal itself — which is the only frame of reference in
// which "it is pointing at the cursor" means anything.
const _p = new THREE.Vector3();
function look() {
  const at = player.mesh.position;
  const head = player.aimRig.head.point;
  const muzzles = player.aimRig.muzzles;
  const dir = (v) => {
    const dx = v.x - at.x;
    const dy = v.y - at.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len, angle: Math.atan2(dy, dx) };
  };
  return {
    head: dir(head),
    fins: muzzles.map(dir),
    heading: player.mesh.rotation.z,
    mirror: player.mirrorAngle,
  };
}

// Settle the shot at a given cursor direction and report where everything ended
// up. `frames` is generous — the head's smoothing is deliberately low (CONFIG
// .head.smoothing 9) so it TRAILS the aim, and a short run would measure the
// trail rather than the destination.
function settleAt(x, y, frames = 240) {
  input.aim.set(x, y).normalize();
  for (let i = 0; i < frames; i++) titleFrame();
  return look();
}

section('THE SEAL TURNS TO FOLLOW THE CURSOR');
{
  resetTitleSeal();
  player.mesh.position.set(0, 0, 0);
  player.mesh.rotation.z = 0;
  player.mirrored = null;
  player.mirrorT = 1;
  player.craneAngle = 0;
  beginTitleSeal();

  const right = settleAt(1, 0);
  // The art's forward is +Y, so a seal pointing along world +X sits at -PI/2.
  check('a cursor to the right points the body right',
    Math.abs(right.heading + Math.PI / 2) < 0.05,
    `heading ${(right.heading * DEG).toFixed(1)}deg`);

  const up = settleAt(0, 1);
  check('...and a cursor above turns it up',
    Math.abs(up.heading) < 0.05, `heading ${(up.heading * DEG).toFixed(1)}deg`);

  // The half-roll. In side view the seal cannot turn all the way round without
  // going belly-up, so crossing behind it is a mirror — and the whole reason
  // poseBody was worth extracting rather than reimplementing is that this
  // comes for free with it.
  const left = settleAt(-1, 0);
  check('a cursor behind it rolls the model over rather than flipping it',
    Math.abs(left.mirror - Math.PI) < 0.05, `mirror ${(left.mirror * DEG).toFixed(1)}deg`);
  check('...and the body is pointing left', Math.abs(left.heading - Math.PI / 2) < 0.05,
    `heading ${(left.heading * DEG).toFixed(1)}deg`);
}

section('THE HEAD AND THE FLIPPERS GO WITH IT, WITH THE BODY HELD STILL');
{
  // THE BODY TURN HAS TO BE TAKEN OUT OF THIS MEASUREMENT, and the first draft
  // of this file did not: with the seal free to swing round toward the cursor,
  // the head and both flippers came out tracking it to within a degree — which
  // they would also do if the IK were switched off entirely and they were
  // simply being carried by the animal. So the body is pinned here and the
  // cursor moved WITHIN the head's cone (CONFIG.head.frontCone, ~51 degrees off
  // the nose), which leaves the chains as the only thing that can move.
  resetTitleSeal();          // no shot, so nothing poses the body
  player.mesh.position.set(0, 0, 0);
  player.mesh.rotation.z = -Math.PI / 2; // the art's forward is +Y, so this is nose-along-+X
  player.body.quaternion.identity();

  const swing = (a, b) => {
    let d = b - a;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return Math.abs(d);
  };

  // AVERAGED OVER A COUPLE OF SECONDS, not read off one frame. The swim clip is
  // moving these same bones underneath the rig, so a single sample measures
  // whichever phase of the cycle it landed on — over 240 frames the same aim
  // repeats to within 0.03 of a degree, which is what makes the comparisons
  // below mean anything.
  const _dir = (v) => Math.atan2(v.y - player.mesh.position.y, v.x - player.mesh.position.x) * DEG;
  function settleRig(deg, engaged, warm = 240, sample = 240) {
    const r = deg / DEG;
    input.aim.set(Math.cos(r), Math.sin(r)).normalize();
    for (let i = 0; i < warm; i++) titleFrame(engaged);
    let head = 0;
    const fins = player.aimRig.muzzles.map(() => 0);
    for (let i = 0; i < sample; i++) {
      titleFrame(engaged);
      head += _dir(player.aimRig.head.point);
      player.aimRig.muzzles.forEach((m, k) => { fins[k] += _dir(m); });
    }
    return { head: head / sample, fins: fins.map((v) => v / sample) };
  }

  // 60 degrees of cursor, entirely inside the cone, with the animal motionless.
  const low = settleRig(-30, true);
  const high = settleRig(30, true);

  check('the head tracks the cursor on its own', swing(low.head, high.head) > 12,
    `${swing(low.head, high.head).toFixed(1)}deg of head for 60deg of cursor`);
  for (let i = 0; i < low.fins.length; i++) {
    check(`flipper ${i} tracks it too`, swing(low.fins[i], high.fins[i]) > 20,
      `${swing(low.fins[i], high.fins[i]).toFixed(1)}deg`);
  }

  section('AND THEY COMMIT, RATHER THAN GESTURING');
  // `engaged` is what picks CONFIG.fins.weight (1.0) over idleWeight (0.55) —
  // the difference between flippers that point and flippers that keep most of
  // the swim clip and merely lean. Every other menu in the game runs the rig
  // idle, correctly, because nobody is shooting; the title card is the one place
  // where the aim IS the thing being looked at. This measures that the
  // distinction buys something, on the same two cursors and the same body.
  const idleLow = settleRig(-30, false);
  const idleHigh = settleRig(30, false);

  const committed = [swing(low.head, high.head), ...low.fins.map((f, i) => swing(f, high.fins[i]))];
  const gestured = [swing(idleLow.head, idleHigh.head),
    ...idleLow.fins.map((f, i) => swing(f, idleHigh.fins[i]))];
  const names = ['head', ...low.fins.map((_, i) => `flipper ${i}`)];

  for (let i = 0; i < committed.length; i++) {
    // A real margin rather than a strict inequality: these are averages of a
    // moving clip, and "engaged is 0.2 degrees ahead" would be a passing test
    // of nothing.
    check(`the ${names[i]} commits harder when engaged`, committed[i] > gestured[i] * 1.15,
      `${committed[i].toFixed(1)}deg engaged against ${gestured[i].toFixed(1)}deg idle`);
  }
}

console.log(failures === 0
  ? '\nAll title-shot checks passed.\n'
  : `\n${failures} check(s) failed.\n`);
process.exit(failures ? 1 : 0);
