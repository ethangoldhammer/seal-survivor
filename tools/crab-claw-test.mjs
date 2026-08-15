#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:claw
//
// Exercises the REAL crab rig, not a stand-in. Loads crabpincer.glb, installs
// it under the `enemyWalkingCrab` asset key so createVisual returns the actual
// 126-bone skeleton, and drives systems/crabClaw.js exactly as the game does —
// animation controller first, claw last.
//
// The things this can say that a boneless smoke test cannot:
//   * both cheliped chains resolve off bone NAMES
//   * a pinch actually moves the claw toward the player, and by how much
//   * THE CLAW OPENS. This rig has a real pincer, so the test is the tip-to-tip
//     aperture rather than "some bone rotated" — and that it never shuts PAST
//     rest, which would drive the two fingers through each other
//   * damage is billed EXACTLY ONCE per pinch, not once per claw
//   * the arm returns to the walk cycle afterwards (no compounding drift),
//     which is the failure mode the whole "who restores the pose" section of
//     crabClaw.js is written around
//
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
// crabpincer.glb embeds its textures, and GLTFLoader decodes them through
// createImageBitmap. Without a stub the parse promise never settles and the
// script exits with "unsettled top-level await" and no error at all.
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG } from '../path/src/config.js';
import { ASSETS, installModel, createVisual } from '../path/src/assets.js';
import { createAnimationController, stateForSpeed } from '../path/src/systems/animation.js';
import { createClawDriver, pinchReach } from '../path/src/systems/crabClaw.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = resolve(HERE, '../public/models/crabpincer.glb');

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

if (!existsSync(MODEL)) {
  console.error(`\nmissing ${MODEL} — the rig has to be in public/models for the game to load it too.\n`);
  process.exit(1);
}

const buf = readFileSync(MODEL);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
);
installModel('enemyWalkingCrab', gltf.scene, gltf.animations);

const scene = new THREE.Scene();
const dt = 1 / 60;

function freshCrab() {
  const visual = createVisual('enemyWalkingCrab');
  scene.add(visual);
  // Matches how spawnOne builds one: the controller owns the walk cycle and
  // the impact springs, and the claw is layered on afterwards.
  const anim = createAnimationController(visual);
  const claw = createClawDriver(visual);
  return { visual, anim, claw };
}

// One frame of the real update order.
function frame(crab, aim) {
  crab.anim?.update(dt, stateForSpeed(3), false);
  crab.claw?.update(dt, aim);
  crab.visual.updateMatrixWorld(true);
}

// Where a named bone actually is in the world. Without a forced world-matrix
// update every pose measures identical and nothing throws.
const _v = new THREE.Vector3();
function boneAt(visual, name) {
  const b = visual.getObjectByName(name);
  if (!b) return null;
  visual.updateMatrixWorld(true);
  return b.getWorldPosition(_v.clone());
}

console.log('\nCRAB CLAW\n');

// --- the rig resolves at all -----------------------------------------------
{
  const { visual, claw } = freshCrab();
  check('claw driver builds off the real skeleton', claw != null);
  const rig = visual.userData?.clawRig;
  check('clawRig reaches the instance', rig?.arms?.length === 2,
    `${rig?.arms?.length ?? 0} arms declared`);
  for (const spec of rig?.arms ?? []) {
    check(`  ${spec.root} -> ${spec.tip} both exist`,
      !!visual.getObjectByName(spec.root) && !!visual.getObjectByName(spec.tip));
    check(`  ${spec.jaw} (movable finger) exists`, !!visual.getObjectByName(spec.jaw));
  }
  scene.remove(visual);
}

// --- a pinch moves the claw toward the player -------------------------------
{
  const crab = freshCrab();
  const { visual, claw } = crab;
  visual.position.set(0, 0, 0);
  visual.updateMatrixWorld(true);

  // Settle into the walk cycle first, so "before" is a real animated pose
  // rather than the bind pose.
  for (let i = 0; i < 30; i++) frame(crab, null);

  // The CLAW TIP, not the wrist. `Hand3L_044` is the end of the IK chain but
  // it is a mid-arm joint — it barely travels even when the gesture is large
  // (measured: 0.08 against the tip's 0.48), so testing it would report a
  // working reach as a broken one.
  const TIP = 'Hand6L_end_0106';
  const rest = boneAt(visual, TIP);

  // The player, up and to the left — where a seal actually is relative to a
  // crab on the seabed.
  const aim = new THREE.Vector3(-3, 4, 0);

  claw.strike();
  let peakRise = -Infinity;
  let closest = Infinity;
  let connects = 0;
  const total = CONFIG.crabClaw.windup + CONFIG.crabClaw.strike + CONFIG.crabClaw.recover;
  const steps = Math.ceil((total + 0.2) / dt);
  for (let i = 0; i < steps; i++) {
    frame(crab, aim);
    if (claw.didConnect()) connects++;
    const p = boneAt(visual, TIP);
    peakRise = Math.max(peakRise, p.y - rest.y);
    closest = Math.min(closest, p.distanceTo(aim));
  }

  check('the claw rises during the pinch', peakRise > 0.05,
    `peak rise ${peakRise.toFixed(3)} world units above its walking height`);
  const restDist = rest.distanceTo(aim);
  check('the claw closes on the player', closest < restDist - 0.05,
    `${restDist.toFixed(2)} -> ${closest.toFixed(2)} at nearest approach`);
  check('damage is billed exactly once per pinch', connects === 1,
    `${connects} connect frame(s)`);

  // --- and hands the arm back -----------------------------------------------
  // The drift check. applyChainToPoint blends away from whatever is in the
  // bone, so a bone nobody restores would creep a little further every pinch.
  for (let i = 0; i < 120; i++) frame(crab, null);
  const after = boneAt(visual, TIP);
  // Compared at the same phase of the walk loop, so the clip itself is not the
  // difference: 150 frames at 1/60 against a 3.33s loop is not a whole number
  // of cycles, so this compares the SPREAD rather than one sample.
  let spread = 0;
  const seen = [];
  for (let i = 0; i < 200; i++) { frame(crab, null); seen.push(boneAt(visual, TIP).clone()); }
  for (const a of seen) spread = Math.max(spread, a.distanceTo(seen[0]));
  check('the arm returns to the walk cycle', after.distanceTo(rest) < spread + 0.05,
    `settled ${after.distanceTo(rest).toFixed(3)} from rest, walk-cycle spread ${spread.toFixed(3)}`);

  scene.remove(visual);
}

// --- the claw actually opens ------------------------------------------------
// The measurement that matters on a rig with a real pincer, and the one a
// "did some bone rotate" check would pass while the claw stayed shut: the
// distance between the two finger TIPS.
{
  const crab = freshCrab();
  const { visual, claw } = crab;
  for (let i = 0; i < 30; i++) frame(crab, null);

  const fixTip = visual.getObjectByName('Hand6L_end_0106');
  const movTip = visual.getObjectByName('Hand7L_end_0107');
  check('both finger tips resolve', !!fixTip && !!movTip);

  const aperture = () => {
    visual.updateMatrixWorld(true);
    return fixTip.getWorldPosition(new THREE.Vector3())
      .distanceTo(movTip.getWorldPosition(new THREE.Vector3()));
  };

  const rest = aperture();
  const aim = new THREE.Vector3(-3, 4, 0);
  claw.strike();
  const total = CONFIG.crabClaw.windup + CONFIG.crabClaw.strike + CONFIG.crabClaw.recover;
  let widest = rest;
  let tightest = rest;
  for (let i = 0; i < Math.ceil(total / dt); i++) {
    frame(crab, aim);
    const a = aperture();
    widest = Math.max(widest, a);
    tightest = Math.min(tightest, a);
  }

  check('the claw opens during the windup', widest > rest * 1.6,
    `aperture ${rest.toFixed(4)} -> ${widest.toFixed(4)} (+${((widest / rest - 1) * 100).toFixed(0)}%)`);

  // The clamp. `snap` carries the SCISSOR past its rest angle so the swing
  // lands with a bite; on a pincer that would push the movable finger through
  // the fixed one, because rest is already shut.
  check('...and never shuts past its rest pose', tightest >= rest - 1e-4,
    `tightest ${tightest.toFixed(5)} against rest ${rest.toFixed(5)}`
    + ` (snap is ${CONFIG.crabClaw.snap}, which WOULD close it past rest if it applied here)`);

  scene.remove(visual);
}

// --- re-firing mid-pinch is ignored -----------------------------------------
{
  const crab = freshCrab();
  for (let i = 0; i < 10; i++) frame(crab, null);
  check('strike() returns true when idle', crab.claw.strike() === true);
  check('strike() is refused mid-pinch', crab.claw.strike() === false);

  // A player standing still re-triggers every frame; if that restarted the
  // gesture the claw would sit at frame 0 of the windup forever.
  // The failure this guards against is the claw being PINNED at frame 0 of the
  // windup by a trigger that fires every frame — which is what a restart-on-
  // refire driver would do to a player who stands still.
  //
  // More than one connect over two seconds is CORRECT, not a bug: the driver
  // has no cooldown of its own. The gesture is ~0.92s, and the rate limit that
  // stops a crab pinching twice a second lives in entities/enemies.js as
  // `pinchTimer`, because it is a property of the animal rather than of the
  // rig. So the assertion is "it completes gestures", not "it completes one".
  const aim = new THREE.Vector3(0, 3, 0);
  let connects = 0;
  for (let i = 0; i < 120; i++) {
    crab.claw.strike();
    frame(crab, aim);
    if (crab.claw.didConnect()) connects++;
  }
  const gesture = CONFIG.crabClaw.windup + CONFIG.crabClaw.strike + CONFIG.crabClaw.recover;
  const fits = Math.floor(2 / gesture);
  check('a held trigger keeps completing pinches rather than pinning the windup',
    connects >= 1 && connects <= fits + 1,
    `${connects} pinch(es) in 2s; the gesture is ${gesture.toFixed(2)}s so at most ${fits + 1} fit`);
  scene.remove(crab.visual);
}

// --- disabled means untouched ------------------------------------------------
{
  const wasEnabled = CONFIG.crabClaw.enabled;
  CONFIG.crabClaw.enabled = false;
  const crab = freshCrab();
  for (let i = 0; i < 20; i++) frame(crab, null);
  const before = boneAt(crab.visual, 'Hand3L_044').clone();
  crab.claw.strike();
  for (let i = 0; i < 60; i++) frame(crab, new THREE.Vector3(0, 4, 0));
  const withClaw = boneAt(crab.visual, 'Hand3L_044').clone();

  // Same frames again with the driver detached entirely — if `enabled: false`
  // truly does nothing, the two runs are identical.
  CONFIG.crabClaw.enabled = false;
  const plain = freshCrab();
  plain.claw = null;
  for (let i = 0; i < 20; i++) frame(plain, null);
  for (let i = 0; i < 60; i++) frame(plain, new THREE.Vector3(0, 4, 0));
  const without = boneAt(plain.visual, 'Hand3L_044').clone();

  check('enabled:false leaves the walk cycle exactly alone',
    withClaw.distanceTo(without) < 1e-6,
    `${withClaw.distanceTo(without).toExponential(2)} apart`);
  void before;
  CONFIG.crabClaw.enabled = wasEnabled;
  scene.remove(crab.visual);
  scene.remove(plain.visual);
}

// ---------------------------------------------------------------------------
// THE GATE THAT FIRES IT.
//
// Everything above drives the gesture by calling strike() directly, which is
// exactly how the mechanic could be dead in the game while every check here
// passed: the commit gate in entities/enemies.js was measured centre-to-centre
// while its paired damage check in systems/combat.js measured surface to
// surface, so when the swarm crab's radius went 0.8 -> 0.2 the gate fell to
// 0.42 world units — inside a seal whose own radius is 1.0 — and no crab ever
// asked for a pinch again.
//
// So this section tests the ARITHMETIC of the reach against the roster, at the
// radii the CSV actually ships, and it is deliberately not a bone test.
{
  console.log('\nTHE COMMIT GATE');
  const pc = CONFIG.crabClaw;
  const pR = CONFIG.player.hitRadius;

  for (const key of ['walkingCrab', 'emberCrab']) {
    const def = CONFIG.enemies[key];
    if (!def) continue;
    const commit = pinchReach(def.radius, pR, pc.commitRange ?? 2.1);
    const reach = pinchReach(def.radius, pR, pc.range ?? 2.4);
    // What ordinary contact already costs you. A commit gate tighter than this
    // means the crab is inside you before it starts winding up, so the tell has
    // nothing left to telegraph — the hit lands with the touch.
    const contact = def.radius + pR;
    console.log(`        ${key.padEnd(13)} radius ${String(def.radius).padStart(4)}`
      + `   contact ${contact.toFixed(2)}   commit ${commit.toFixed(2)}   reach ${reach.toFixed(2)}`);

    check(`${key}: the pinch commits before the crab is touching you`,
      commit > contact,
      `commits at ${commit.toFixed(2)}, contact starts at ${contact.toFixed(2)}`);
    check(`${key}: ...and the claw still lands from where it committed`,
      reach >= commit,
      `reach ${reach.toFixed(2)} vs commit ${commit.toFixed(2)}`);
    // The regression itself, stated as the thing that must never come back: a
    // gate that ignores the seal's body is unreachable at any small radius.
    check(`${key}: the gate is not measured centre-to-centre`,
      commit > def.radius * (pc.commitRange ?? 2.1) + 1e-9,
      `${commit.toFixed(2)} against the ${(def.radius * (pc.commitRange ?? 2.1)).toFixed(2)} a centre-to-centre gate would use`);
  }

  // And it has to survive the hitbox being retuned again, which is the whole
  // reason this is arithmetic rather than a number written down.
  const tiny = pinchReach(0.05, pR, pc.commitRange ?? 2.1);
  check('a crab with almost no hitbox can still commit to a pinch',
    tiny > 0.05 + pR, `${tiny.toFixed(2)} at radius 0.05`);
}

console.log(`\n${failures === 0 ? 'all good' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
