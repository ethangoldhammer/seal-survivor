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
import { createClawDriver, pinchReach, clawSetting } from '../path/src/systems/crabClaw.js';
import { spawnNamed, updateEnemies, resetEnemies } from '../path/src/entities/enemies.js';
import { bounds } from '../path/src/arena.js';
import { parseBossCsv } from '../path/src/bossTable.js';
import bossesCsv from '../path/src/bosses.csv?raw';

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
// The king crab is the same binary under its own asset key — see the note on
// enemyBossCrab in assets.js. Installed here as well so the boss section below
// spawns a real 126-bone skeleton rather than the primitive stand-in a Node
// harness would otherwise get, which has no arms to pinch with.
// PARSED A SECOND TIME, not installed twice off the same scene: prepareModel
// prunes and re-materials the object it is handed, so feeding it one scene
// under two keys leaves the first key holding a skeleton the second pass has
// already taken apart (measured: every leg track loses its target node and the
// claw driver resolves nothing at all).
const bossGltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
);
installModel('enemyBossCrab', bossGltf.scene, bossGltf.animations);

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

  // ---------------------------------------------------------------------------
  // IT WANTS IT MORE THE CLOSER YOU ARE — CONFIG.crabClaw.eager.
  //
  // The cooldown is a RANGE now, not a number: the crab's authored gap at the
  // very edge of its reach, and a fraction of it once the seal is in among the
  // legs. That is the whole answer to a crab layer that was, per second, no
  // worse to stand on top of than to stand beside — on the one animal in the
  // game whose entire threat is how far its arms get.
  //
  // Measured as PINCHES IN A FIXED WINDOW at two distances, which is the only
  // reading that can tell you the mechanism is connected. Reading the timer
  // after a strike would pass on a crab whose gate never opened, and reading
  // the config would pass on one where nothing ever multiplied by it.
  //
  // Held at the distance rather than walked in: the crab is parked, so the only
  // variable between the two runs is where the seal is standing.
  function pinchesAt(frac, seconds = 14) {
    resetEnemies(scene);
    const c = spawnNamed(scene, 'walkingCrab', 0, { x: px + 3, y: py }, { ignoreCaps: true });
    if (!c) return { n: 0, gate: 0, at: 0 };
    c.entering = false;
    c.pinchTimer = 0;
    // The gate is measured off THIS individual's arm (scaleVariance rolls a
    // size per crab), so the standing distance has to be too or the two runs
    // are at different fractions of two different gates.
    updateEnemies(dt, scene, seal);
    const gate = pinchReach(c.claw?.reach() ?? 0, pR, pc.commitRange);
    const at = gate * frac;
    let n = 0;
    let was = false;
    for (let i = 0; i < 60 * seconds; i++) {
      // Pinned each frame: a crawler walks, and a crab that closed the gap
      // would be measuring both distances in one run.
      c.mesh.position.x = px + at;
      c.mesh.position.y = py;
      c.vx = 0; c.vy = 0;
      updateEnemies(dt, scene, seal);
      const striking = !!c.claw?.isStriking();
      if (striking && !was) n++;   // count EDGES, not frames
      was = striking;
    }
    return { n, gate, at };
  }

  // THE GESTURE IS A FLOOR ON THE PERIOD, and it is why this is checked against
  // a predicted count rather than against a ratio. `pinchTimer` starts when the
  // gesture does, and the gesture is windup + strike + recover plus the trailing
  // arm's lag — 0.98s as tuned — so once the eager multiplier takes the cooldown
  // under that, the next pinch simply begins as the last one finishes and the
  // multiplier stops buying anything. A ratio test would therefore fail on a
  // perfectly working mechanism the moment somebody tuned the multiplier lower,
  // which is the opposite of what this should do.
  const SECONDS = 14;
  const gesture = pc.windup + pc.strike + pc.recover + (pc.armLag ?? 0);
  const predict = (mul) => Math.floor(SECONDS / Math.max(gesture, pc.cooldown * mul)) + 1;

  const lazy = pinchesAt(0.92, SECONDS);
  const eager = pinchesAt(0.15, SECONDS);
  const wantLazy = predict(1);
  const wantEager = predict(pc.eager?.nearCooldownMul ?? 1);

  check('a crab at arm\'s length pinches on its own lazy clock',
    Math.abs(lazy.n - wantLazy) <= 1,
    `${lazy.n} pinches in ${SECONDS}s from ${lazy.at.toFixed(2)}u (gate ${lazy.gate.toFixed(2)}), predicted ${wantLazy}`);
  check('...and reaches for you far more often once you are in among the legs',
    Math.abs(eager.n - wantEager) <= 1 && eager.n > lazy.n,
    `${eager.n} from ${eager.at.toFixed(2)}u against ${lazy.n} from ${lazy.at.toFixed(2)}u (predicted ${wantEager})`);
  // ...and it did NOT become a blender. The gesture floor is what guarantees
  // every one of those pinches still opens with the full 0.42s rear-up, which
  // is the promise the whole mechanic rests on.
  check('...every one of them still carrying its rear-up',
    eager.n * gesture <= SECONDS + gesture,
    `${eager.n} gestures of ${gesture.toFixed(2)}s in ${SECONDS}s — no pinch starts before the last one ends`);
}

// ---------------------------------------------------------------------------
// THE KING CRAB — the same claw doing the opposite job.
//
// Two bugs lived here at once, and they looked like one thing in play: "the
// boss reacts to every hit and never attacks."
//
//   THE GATE. `commitRange` is a fraction of the ARM, and contact distance is
//   the HITBOX plus the seal. Those scale differently, so a number tuned to
//   leave the swarm crab half a unit of daylight left the boss 0.22 — it could
//   only commit from inside a band ordinary contact shoves the player out of.
//   The same arithmetic that killed this mechanic twice before, surviving in
//   the one place nothing measured it.
//
//   THE FLINCH. Both chelipeds carry an impact spring, and those are the exact
//   bones the IK aims. Under fire the shove was bigger than the gesture — 9.7
//   world units of tip displacement on a 7.9-unit arm — so the pinch played
//   perfectly and was invisible underneath the flail.
//
// Neither failed anything. Both are asserted below, with the boss driven
// through the real updateEnemies while being shot.
// ---------------------------------------------------------------------------
{
  console.log('\nTHE KING CRAB');
  const ARCH = parseBossCsv(bossesCsv, CONFIG.enemies, () => {}).find((b) => b.id === 'bossCrab');
  const pR = CONFIG.player.hitRadius;
  const FLOOR = bounds.bottom;

  // The archetype's size step, applied the way systems/boss.js applies it —
  // same shortcut tools/crab-boss-test.mjs takes, and for the same reason: this
  // section wants a boss in the water without the arrival ceremony.
  function spawnKing(at) {
    const e = spawnNamed(scene, 'bossCrab', 0, at, { ignoreCaps: true, overfill: true });
    if (!e) return null;
    const mul = ARCH?.sizeMul ?? 1;
    e.visual.scale.multiplyScalar(mul);
    e.spawnScale *= mul;
    e.sizeMul *= mul;
    e.radius *= mul;
    e.isBoss = true;
    e.entering = false;
    e.hp = 1e7; // it is being shot for twenty seconds below
    e.pinchTimer = 0;
    return e;
  }

  // Its own block, so tuning the fight cannot retune the seabed.
  check('the boss carries its own claw settings', !!CONFIG.enemies.bossCrab.claw,
    Object.keys(CONFIG.enemies.bossCrab.claw ?? {}).join(', ') || 'none');
  check('...and a crab without one still reads the shared block',
    clawSetting(CONFIG.enemies.walkingCrab, 'cooldown') === CONFIG.crabClaw.cooldown
    && clawSetting(CONFIG.enemies.bossCrab, 'windup') === CONFIG.crabClaw.windup,
    'overrides are per key, not per block');

  // --- the gate, on the boss's own body --------------------------------------
  resetEnemies(scene);
  const seal = new THREE.Vector3(0, FLOOR + 3, 0);
  const king = spawnKing({ x: -14, y: FLOOR + 1 });
  for (let i = 0; i < 30; i++) updateEnemies(dt, scene, seal, () => {}, () => {});
  const arm = king.claw.reach();
  const commit = pinchReach(arm, pR, clawSetting(king.def, 'commitRange'));
  const damageAt = pinchReach(arm, pR, clawSetting(king.def, 'range'));
  const contact = king.radius + pR;
  console.log(`        arm ${arm.toFixed(2)}   contact ${contact.toFixed(2)}`
    + `   commit ${commit.toFixed(2)}   reach ${damageAt.toFixed(2)}`);
  check('the boss commits with room to stand in, not on top of you',
    commit - contact >= 0.5,
    `${(commit - contact).toFixed(2)} units of daylight (the swarm's number gives it 0.22)`);
  check('...and the claw still lands from where it committed', damageAt >= commit,
    `reach ${damageAt.toFixed(2)} vs commit ${commit.toFixed(2)}`);

  // The honest ceiling: damage may not be billed from further than the claw is
  // ever seen to get. Measured on this body, at this size.
  const far = new THREE.Vector3(60, FLOOR + 1, 0);
  const tipBone = king.visual.getObjectByName('Hand6L_end_0106');
  const tipAt = new THREE.Vector3();
  const bodyAt = new THREE.Vector3();
  let maxTip = 0;
  king.claw.strike();
  for (let i = 0; i < 180; i++) {
    updateEnemies(dt, scene, far, () => {}, () => {});
    king.visual.updateMatrixWorld(true);
    king.visual.getWorldPosition(bodyAt);
    tipBone.getWorldPosition(tipAt);
    maxTip = Math.max(maxTip, Math.hypot(tipAt.x - bodyAt.x, tipAt.y - bodyAt.y));
  }
  check('the boss never bills damage from further than its claw gets',
    damageAt <= maxTip + pR + 1e-6,
    `bills to ${damageAt.toFixed(2)}, claw reaches ${(maxTip + pR).toFixed(2)}`);

  // --- it pinches, and it keeps pinching, and being shot does not stop it ----
  // Two identical twenty-second runs, one of them under a stream of pellets. A
  // trace of the claw tip from each, compared frame for frame: the shape of the
  // gesture is the thing being asserted, not that some bone moved.
  const TIP = 'Hand6L_end_0106';
  const shove = new THREE.Vector3(1, 0, 0);
  function run(underFire) {
    resetEnemies(scene);
    const c = spawnKing({ x: -14, y: FLOOR + 1 });
    const trace = [];
    let pinches = 0;
    let connects = 0;
    let striking = 0;
    let wasStriking = false;
    let firstAt = 0;
    let prev = Infinity;
    for (let i = 0; i < 60 * 20; i++) {
      const d = Math.hypot(c.mesh.position.x - seal.x, c.mesh.position.y - seal.y);
      if (underFire && i % 5 === 0) {
        // Exactly what main.js does on every pellet that lands — see
        // onEnemyDamagedFeedback. Twelve a second is an ordinary rate of fire
        // for a levelled gun, not a stress test.
        c.hitThisFrame = true;
        const sp = CONFIG.animation.spring;
        c.anim?.impulse(shove, Math.min(sp.impulseMax, 30 * sp.impulsePerDamage));
      }
      updateEnemies(dt, scene, seal, () => {}, () => {});
      const s = c.claw?.isStriking() ?? false;
      if (s && !wasStriking) { pinches++; if (!firstAt) firstAt = prev; }
      wasStriking = s;
      if (s) striking++;
      if (c.justPinched) connects++;
      c.visual.updateMatrixWorld(true);
      trace.push({
        p: c.visual.getObjectByName(TIP).getWorldPosition(new THREE.Vector3()),
        striking: s,
      });
      prev = d;
    }
    return { pinches, connects, striking, firstAt, trace };
  }

  const calm = run(false);
  const fire = run(true);

  check('the boss pinches, and keeps pinching', calm.pinches >= 12,
    `${calm.pinches} pinches in 20s (the swarm's cooldown gives it 11)`);
  check('...and is mid-gesture most of the time it is on you',
    calm.striking / (60 * 20) > 0.6,
    `reaching or pinching on ${Math.round(100 * calm.striking / (60 * 20))}% of frames`);
  check('...committing from outside touching distance',
    calm.firstAt - contact >= 0.5,
    `first pinch committed at ${calm.firstAt.toFixed(2)}, contact starts at ${contact.toFixed(2)}`);
  check('being shot does not cost it a single pinch',
    fire.pinches >= calm.pinches && fire.connects >= calm.connects,
    `${fire.pinches}/${fire.connects} under fire against ${calm.pinches}/${calm.connects} in peace`);

  // THE REGRESSION, IN ONE NUMBER. How far the claw tip sits from where the
  // pinch alone would have put it, on the frames the pinch owns the arm. It
  // was 11.1 world units — the flinch was not competing with the gesture, it
  // was replacing it.
  let dev = 0;
  let n = 0;
  for (let i = 0; i < calm.trace.length; i++) {
    if (!calm.trace[i].striking) continue;
    dev += calm.trace[i].p.distanceTo(fire.trace[i].p);
    n++;
  }
  const meanDev = dev / Math.max(1, n);
  check('the swing owns the arm while it swings', meanDev < arm * 0.15,
    `claw tip ${meanDev.toFixed(2)} off its unshot line, on a ${arm.toFixed(2)}-unit arm`
    + ' (it was 11.08 before the claw spring was muted)');

  // ...and the flinch is not simply gone. Muting is for the duration of the
  // gesture; a crab that gets shot between pinches still shudders.
  {
    resetEnemies(scene);
    const c = spawnKing({ x: -14, y: FLOOR + 1 });
    // Out of range and never striking, so nothing mutes anything.
    const away = new THREE.Vector3(bounds.right - 2, bounds.surfaceY - 3, 0);
    for (let i = 0; i < 60; i++) updateEnemies(dt, scene, away, () => {}, () => {});
    c.visual.updateMatrixWorld(true);
    const before = c.visual.getObjectByName(TIP).getWorldPosition(new THREE.Vector3());
    const bodyBefore = c.mesh.position.clone();
    c.anim.impulse(shove, CONFIG.animation.spring.impulseMax);
    updateEnemies(dt, scene, away, () => {}, () => {});
    c.visual.updateMatrixWorld(true);
    const after = c.visual.getObjectByName(TIP).getWorldPosition(new THREE.Vector3());
    // The body walks while this happens, so the arm's own movement is what is
    // left after the body's is taken out.
    const bodyMoved = c.mesh.position.distanceTo(bodyBefore);
    check('a crab that is not mid-pinch still flinches through its arms',
      !c.claw.isStriking() && after.distanceTo(before) > bodyMoved + 0.01,
      `tip moved ${after.distanceTo(before).toFixed(3)} against ${bodyMoved.toFixed(3)} of body travel`);
  }
}

console.log(`\n${failures === 0 ? 'all good' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
