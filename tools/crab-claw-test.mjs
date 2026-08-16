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
import { spawnNamed, updateEnemies, resetEnemies } from '../path/src/entities/enemies.js';
import { bounds } from '../path/src/arena.js';

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
// It died a SECOND way after that was fixed, and this section is now mostly
// about the second one. Both halves agreed, but on a multiple of the crab's
// `radius` — 0.2 on the walking crab, because a crawler's radius doubles as
// its resting height off the sand — while the animal draws six world units
// long and its arm measures 2.2. The gate came out 0.22 units outside contact
// range, which is close enough that ordinary contact shoves you back out of it
// first. Nothing failed; the claws just never answered anyone.
//
// So this section tests the ARITHMETIC of the reach against the real arm and
// the roster's real hitboxes, and it is deliberately not a bone test.
{
  console.log('\nTHE COMMIT GATE');
  const pc = CONFIG.crabClaw;
  const pR = CONFIG.player.hitRadius;

  // Measured off the posed skeleton, exactly as the game asks for it.
  const crab = freshCrab();
  for (let i = 0; i < 20; i++) frame(crab, null);
  const arm = crab.claw.reach();
  check('the driver reports the arm it measured', arm > 0, `${arm.toFixed(2)} world units`);

  const commit = pinchReach(arm, pR, pc.commitRange ?? 0.55);
  const reach = pinchReach(arm, pR, pc.range ?? 0.65);
  check('the reach is scaled off the arm, not off a hitbox',
    Math.abs(reach - (arm * pc.range + pR)) < 1e-9,
    `${reach.toFixed(2)} = arm ${arm.toFixed(2)} x ${pc.range} + seal ${pR}`);
  check('...and the claw still lands from where it committed',
    reach >= commit, `reach ${reach.toFixed(2)} vs commit ${commit.toFixed(2)}`);

  for (const key of ['walkingCrab', 'emberCrab']) {
    const def = CONFIG.enemies[key];
    if (!def) continue;
    // What ordinary contact already costs you. A commit gate tighter than this
    // means the crab is inside you before it starts winding up, so the tell has
    // nothing left to telegraph — the hit lands with the touch.
    const contact = def.radius + pR;
    const band = commit - contact;
    console.log(`        ${key.padEnd(13)} radius ${String(def.radius).padStart(4)}`
      + `   contact ${contact.toFixed(2)}   commit ${commit.toFixed(2)}   reach ${reach.toFixed(2)}`
      + `   band ${band.toFixed(2)}`);

    check(`${key}: the pinch commits before the crab is touching you`,
      commit > contact,
      `commits at ${commit.toFixed(2)}, contact starts at ${contact.toFixed(2)}`);
    // THE SECOND DEATH, stated as the thing that must never come back. Bare
    // ">" passed all the way through the version nobody could see: a band of
    // 0.22 is arithmetically outside contact and invisible in play. Half a
    // world unit is about a third of the seal, which is a gap a player can
    // stand in — and it is the ratio, not the constant, that this is really
    // asserting, since contact tracks the hitbox and commit no longer does.
    check(`${key}: ...with room to stand in, not a hair outside contact`,
      band >= 0.5, `${band.toFixed(2)} units of daylight`);
    // The FIRST death: a gate that ignores the seal's own body is unreachable
    // whenever the crab is small.
    check(`${key}: the gate is not measured centre-to-centre`,
      commit > arm * (pc.commitRange ?? 0.55) + 1e-9,
      `${commit.toFixed(2)} against the ${(arm * (pc.commitRange ?? 0.55)).toFixed(2)} a centre-to-centre gate would use`);
  }

  // Retuning the hitbox must not be able to reach the claw at all any more —
  // which is the entire point of scaling off the arm, so it is worth asserting
  // rather than assuming.
  check('a crab with almost no hitbox still reaches exactly as far',
    pinchReach(arm, pR, pc.commitRange) === commit,
    `${commit.toFixed(2)} whatever the CSV says the radius is`);

  // And the damage must not land further than the claw is ever seen to get.
  // `range` is a fraction of the CHAIN, but the solver never straightens the
  // arm fully in the play plane, so the honest ceiling is where the tip
  // actually arrives — see the measured figure in CONFIG.crabClaw.range.
  const tipCrab = freshCrab();
  const far = new THREE.Vector3(20, 0, 0);
  for (let i = 0; i < 20; i++) frame(tipCrab, null);
  tipCrab.claw.strike();
  let maxTip = 0;
  const tip = new THREE.Vector3();
  const root = new THREE.Vector3();
  const tipBone = tipCrab.visual.getObjectByName(tipCrab.visual.userData.clawRig.arms[0].tip);
  for (let i = 0; i < 90; i++) {
    frame(tipCrab, far);
    tipCrab.visual.getWorldPosition(root);
    tipBone.getWorldPosition(tip);
    maxTip = Math.max(maxTip, Math.hypot(tip.x - root.x, tip.y - root.y));
  }
  check('the pinch never bills damage from further than the claw gets',
    reach <= maxTip + pR + 1e-6,
    `bills to ${reach.toFixed(2)}, claw reaches ${(maxTip + pR).toFixed(2)}`);

  // ---------------------------------------------------------------------------
  // AND NOW FOR REAL. Everything above still computes the gate itself, which is
  // one step short of proving anything: the gate that matters is the line in
  // entities/enemies.js, and both times this mechanic died it died THERE while
  // arithmetic like the checks above was perfectly correct somewhere else.
  //
  // So: spawn a crab through the real spawner, walk it in with the real
  // updateEnemies, and record how far away it was on the frame it decided to
  // pinch. That number is the mechanic.
  // ---------------------------------------------------------------------------
  console.log('\n        ...fired through updateEnemies, not computed');
  resetEnemies(scene);
  const px = 0;
  const py = bounds.bottom + 1;
  const seal = new THREE.Vector3(px, py, 0);
  const walker = spawnNamed(scene, 'walkingCrab', 0, { x: px - 12, y: py }, { ignoreCaps: true });
  if (walker) {
    walker.entering = false;
    // A crab spawns with up to a full cooldown already on the clock, so a wave
    // doesn't pinch in unison (see the pinchTimer roll in spawnOne). Cleared
    // here because this is a test of the GATE: left in, the crab covers the
    // twelve units in less time than its own opening cooldown about a third of
    // the time and arrives unable to pinch, which looks exactly like the bug
    // this section exists to catch.
    walker.pinchTimer = 0;
  }

  let firedAt = 0;
  let firedPrev = 0; // where it was the frame before it committed
  let prev = Infinity;
  let closest = Infinity;
  for (let i = 0; i < 60 * 12 && walker; i++) {
    // BEFORE the update, which is the distance the gate itself sees. The crab
    // closes 0.13 units in a frame, so reading it afterwards measures a frame
    // of travel the gate never saw.
    const d = Math.hypot(walker.mesh.position.x - px, walker.mesh.position.y - py);
    updateEnemies(dt, scene, seal);
    closest = Math.min(closest, d);
    if (!firedAt && walker.claw?.isStriking()) { firedAt = d; firedPrev = prev; }
    prev = d;
  }
  check('a crab walking in actually asks for a pinch', firedAt > 0,
    firedAt ? `committed at ${firedAt.toFixed(2)} units` : `never pinched; closed to ${closest.toFixed(2)}`);
  // Against THIS crab's own gate, not the roster's. spawnNamed rolls a size
  // per individual (scaleVariance 0.16), and since the reach is measured off
  // the skeleton that roll moves it — which is the behaviour we want and also
  // a ±16% band that would make a comparison against the unvaried figure a
  // coin flip from run to run. A frame of travel is about 0.05 units.
  const walkerGate = pinchReach(walker.claw.reach(), pR, pc.commitRange);
  check('...on the first frame it is inside its own gate, not on top of the player',
    firedAt > 0 && firedAt <= walkerGate && firedPrev > walkerGate,
    `fired at ${firedAt.toFixed(2)}, from ${firedPrev.toFixed(2)} the frame before,`
    + ` gate ${walkerGate.toFixed(2)} (the roster's unvaried figure is ${commit.toFixed(2)})`);
  // And the regression in one line: the old gate was 1.42 on a crab this size,
  // a fifth of the seal's radius outside contact.
  check('...which is real daylight outside touching distance',
    firedAt - (walker.radius + pR) >= 0.5,
    `${(firedAt - (walker.radius + pR)).toFixed(2)} units before it touches you`);
}

console.log(`\n${failures === 0 ? 'all good' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
