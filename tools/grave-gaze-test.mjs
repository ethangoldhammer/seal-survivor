#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:gaze
//
// STOPPING AT A GRAVE — systems/graveGaze.js (the dwell and the camera latch),
// systems/salute.js (the button), and the state cineCamera enters because of
// them.
//
// WHAT THIS CAN SAY THAT LOOKING CANNOT. Every failure here is a threshold
// that is nearly right, and all of them look fine on the happy path:
//
//   A DWELL THAT SURVIVES A SWIM-PAST. The radius is a few units wide and the
//   seal crosses it in under half a second at speed, so a dwell clock that
//   forgets to ask whether the animal has actually STOPPED fires for a player
//   who swam through the yard on the way to a fight. That is the camera taking
//   itself away mid-run, which is the one thing this feature must never do.
//
//   A DWELL THAT CARRIES BETWEEN STONES. Six markers stand nine units apart.
//   A clock that is not reset when the nearest one changes pushes the frame in
//   the instant you arrive at the second grave, having "waited" at the first.
//
//   A LATCH THAT NEVER LETS GO. The subject of this shot is a stone, and
//   stones do not die or get collected — so if swimming away does not drop it,
//   the camera holds a headstone for the rest of the run.
//
//   A SUBJECT CAPTURED RATHER THAN READ. The seal drifts while it stands
//   there. A midpoint computed once, on the frame the push started, leaves the
//   frame behind the animal — and it is invisible in any test that never moves
//   the seal after arming it.
//
//   A SALUTE THAT RE-ENTERS ITSELF. A celebration re-captures its entry
//   snapshot whenever `seq` moves, so a second press over a live one snapshots
//   the SALUTED pose as the thing to return to. That is the ratchet
//   systems/poseRig.js exists to prevent, and it is cumulative — nobody
//   notices until the flippers are visibly wrong.
//
// The stones are stand-in boxes under the real asset keys, exactly as
// tools/gravesite-test.mjs builds them and for the reasons its header gives:
// no GLB loads in Node, and this file is measuring the state machine rather
// than the picture.
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
// The yard persists across sessions (systems/graveyardStore.js) and dom-stub
// has no storage, so without this every save falls into its own catch.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
// dom-stub aliases `window` to globalThis and defines no window size, and the
// in-shot test projects into one. A window with no size makes every stone
// off-screen, which would pass the "out of shot says nothing" checks below for
// entirely the wrong reason.
globalThis.innerWidth = 1280;
globalThis.innerHeight = 720;

import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { installModel } from '../path/src/assets.js';
import {
  markDeathSite, updateGravesites, graveList, clearGraves, nearestGrave,
} from '../path/src/systems/gravesite.js';
import {
  updateGraveGaze, resetGraveGaze, graveAttention, graveAtSeal, graveInReach,
} from '../path/src/systems/graveGaze.js';
import {
  trySalute, updateSalute, resetSalute, saluteReady,
} from '../path/src/systems/salute.js';
import {
  celebrationState, celebrationFacing, resetCelebration, updateCelebration,
} from '../path/src/systems/celebrate.js';
import {
  updateCineCamera, resetCineCamera, cineDebug, cineGazing, cineSubject, cineAspectZoom,
} from '../path/src/systems/cineCamera.js';
import { updateBounds, bounds } from '../path/src/arena.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const section = (n) => console.log(`\n${n}`);

const DT = 1 / 60;

// --- the yard ---------------------------------------------------------------
const scene = new THREE.Scene();
for (const key of CONFIG.gravesite.stones) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 0.3), new THREE.MeshBasicMaterial());
  const root = new THREE.Object3D();
  root.add(mesh);
  installModel(key, root);
}
updateBounds(16 / 9);

function plant(x, name) {
  markDeathSite(scene, { x, z: -3, name, cause: 'a shark' }, () => {});
  for (let t = 0; t < 14; t += DT) {
    updateGravesites(DT);
    if (graveList().every((g) => g.phase === 'done')) return;
  }
}
clearGraves();
CONFIG.gravesite.max = 6;
plant(0, 'FIRST');
plant(24, 'SECOND');
const yard = graveList();
if (yard.length !== 2) {
  console.error(`\nexpected two stones, got ${yard.length} — the rest of this file cannot mean anything.\n`);
  process.exit(1);
}
// The stones as the gaze sees them — nearestGrave's record, which carries the
// planted x and the measured top of the head. graveList() is the yard's own
// bookkeeping and has neither.
const A = nearestGrave(0, 2);
const B = nearestGrave(24, 2);
if (!A || !B) {
  console.error('\nthe planted stones are not where they were planted.\n');
  process.exit(1);
}

// A camera that actually frames the yard, so the in-shot half of the test is
// answering a real projection rather than a matrix of zeroes.
const camera = new THREE.OrthographicCamera(-40, 40, 22, -22, 0.1, 200);
function look(x, y) {
  camera.position.set(x, y, 50);
  camera.lookAt(x, y, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
}

const stoneTop = (g) => g.topY;
// Just over the stone's head, well inside the label's own clearance, so "near"
// is unambiguous.
const overGrave = (g) => ({ x: g.x, y: g.topY + 1 });

function gaze(seconds, { x, y, speed = 0, live = true } = {}) {
  for (let t = 0; t < seconds; t += DT) {
    updateGraveGaze(DT, { camera, x, y, speed, live });
  }
  return graveAttention();
}

console.log('\nGRAVE GAZE\n');

// ---------------------------------------------------------------------------
section('the test itself');
{
  resetGraveGaze();
  const at = overGrave(A);
  look(at.x, at.y);
  check('a stone under the seal is found', graveAtSeal(camera, at.x, at.y)?.name === 'FIRST');
  check('...and one across the arena is not',
    graveAtSeal(camera, at.x + 200, at.y) === null);
  check('a seal far above the yard is not at a grave',
    graveAtSeal(camera, at.x, stoneTop(A) + (CONFIG.gravesite.label.reach ?? 6) + 5) === null);
  // The camera moved off it: the stone is still under the seal and still
  // within reach, and the only thing that changed is the picture.
  look(at.x + 300, at.y);
  check('a stone out of shot is not one the seal is at',
    graveAtSeal(camera, at.x, at.y) === null);
  check('no camera at all answers nothing rather than throwing',
    graveAtSeal(null, at.x, at.y) === null);
}

// ---------------------------------------------------------------------------
section('the dwell');
{
  resetGraveGaze();
  resetCineCamera();
  const at = overGrave(A);
  look(at.x, at.y);
  const hold = CONFIG.gravesite.gaze.hold;

  // Most of the way there, but not there.
  const early = gaze(hold * 0.6, { ...at, speed: 0 });
  check('the caption is up long before the frame moves', !!early.grave, early.grave?.name);
  check('...and nothing is pushing yet', early.pushing === false && !cineGazing(),
    `dwell ${early.dwell.toFixed(2)} of ${hold}`);

  const late = gaze(hold, { ...at, speed: 0 });
  check('staying arms the push', late.pushing === true && cineGazing(), `dwell ${late.dwell.toFixed(2)}`);
}

{
  // The one that matters: a seal crossing the yard at speed.
  resetGraveGaze();
  const at = overGrave(A);
  look(at.x, at.y);
  const fast = gaze(4, { ...at, speed: CONFIG.gravesite.gaze.stillSpeed + 8 });
  check('swimming over one never arms it, however long you are there',
    fast.pushing === false && fast.dwell === 0, `dwell ${fast.dwell.toFixed(2)}`);
  // ...and slowing down there does.
  const stopped = gaze(CONFIG.gravesite.gaze.hold + 0.2, { ...at, speed: 0 });
  check('slowing down at the same stone arms it', stopped.pushing === true);
}

{
  // Moving off mid-dwell resets rather than decays.
  resetGraveGaze();
  const at = overGrave(A);
  look(at.x, at.y);
  gaze(CONFIG.gravesite.gaze.hold * 0.9, { ...at, speed: 0 });
  const bumped = gaze(DT * 2, { ...at, speed: CONFIG.gravesite.gaze.stillSpeed + 5 });
  check('one frame of moving puts the clock back to zero', bumped.dwell === 0, `${bumped.dwell}`);
}

{
  // Two stones: the clock does not travel with the seal.
  resetGraveGaze();
  const a = overGrave(A);
  look(a.x, a.y);
  gaze(CONFIG.gravesite.gaze.hold * 0.95, { ...a, speed: 0 });
  const b = overGrave(B);
  look(b.x, b.y);
  const arrived = gaze(DT, { ...b, speed: 0 });
  check('arriving at a second grave starts its own clock',
    arrived.grave?.name === 'SECOND' && arrived.dwell <= DT * 1.5 && !arrived.pushing,
    `dwell ${arrived.dwell.toFixed(3)} at ${arrived.grave?.name}`);
}

// ---------------------------------------------------------------------------
section('the camera');
{
  resetGraveGaze();
  resetCineCamera();
  const wasEnabled = CONFIG.cinecam.enabled;
  CONFIG.cinecam.enabled = true;

  const half = (z) => ({ w: (bounds.frameWidth / 2) / z, h: (CONFIG.arena.viewHeight / 2) / z });
  const limitsOf = (zoom) => {
    const h = half(zoom);
    return { loX: bounds.left + h.w, hiX: bounds.right - h.w, loY: bounds.bottom + h.h, hiY: bounds.top - h.h };
  };
  const at = overGrave(A);
  const ctx = {
    target: { x: at.x, y: at.y },
    velocity: { x: 0, y: 0 },
    aim: { x: 0, y: 0 },
    dashDir: { x: 0, y: 0 }, dashReach: 0, chargePower: 0,
    strikeHeld: false, charging: false, boosting: false,
    deathPhase: 'none', deathElapsed: 0,
    halfExtents: half,
    focusLimits: limitsOf,
    clampFocus: (x, y, zoom) => {
      const l = limitsOf(zoom);
      return {
        x: l.loX > l.hiX ? 0 : Math.min(Math.max(x, l.loX), l.hiX),
        y: l.loY > l.hiY ? (bounds.bottom + bounds.top) / 2 : Math.min(Math.max(y, l.loY), l.hiY),
      };
    },
  };
  look(at.x, at.y);
  // Settle at base first, so the push below is measured against a resting rig
  // rather than against the opening frame.
  for (let i = 0; i < 180; i++) updateCineCamera(DT, ctx);
  const base = cineDebug();
  check('the rig sits in base while the seal is merely swimming', base.state === 'base', base.state);

  // Stop there.
  const dwellFrames = Math.ceil((CONFIG.gravesite.gaze.hold + 0.1) / DT);
  for (let i = 0; i < dwellFrames; i++) {
    updateGraveGaze(DT, { camera, x: at.x, y: at.y, speed: 0, live: true });
    updateCineCamera(DT, ctx);
  }
  check('the rig takes the grave state', cineDebug().state === 'graveGaze', cineDebug().state);

  // ...and creeps in. The blend is over a second, so a couple of frames in it
  // must have MOVED without having ARRIVED — a state that cuts would be at its
  // zoom already.
  const early = cineDebug().zoom;
  for (let i = 0; i < 20; i++) {
    updateGraveGaze(DT, { camera, x: at.x, y: at.y, speed: 0, live: true });
    updateCineCamera(DT, ctx);
  }
  const creeping = cineDebug().zoom;
  const want = CONFIG.cinecam.states.graveGaze.zoom;
  check('the push starts', creeping > early, `${early.toFixed(3)} -> ${creeping.toFixed(3)}`);
  check('...and is nowhere near arrived a third of a second in',
    creeping < base.zoom + (want - base.zoom) * 0.9,
    `${creeping.toFixed(3)} of ${want}`);

  // ...AND IT IS A PUSH SOMEBODY CAN SEE. This is the check that was missing,
  // and its absence shipped a state that did nothing: the zoom was authored at
  // 1.32 against a tuned base of 1.24, so the whole shot was a 6% tighter
  // frame eased in over a second and a half through a deliberately soft
  // spring. Every assertion above passed — the state was entered, the subject
  // was right, the zoom did rise — and the feature was invisible.
  //
  // Measured as a fraction of the LIVE base rather than against a number typed
  // here, so retuning base.zoom cannot quietly turn this back into nothing.
  let arrived = 0;
  for (let i = 0; i < 300; i++) {
    updateGraveGaze(DT, { camera, x: at.x, y: at.y, speed: 0, live: true });
    updateCineCamera(DT, ctx);
    if (!arrived && cineDebug().zoom > base.zoom + (want * cineAspectZoom() - base.zoom) * 0.9) arrived = (i + 1) * DT;
  }
  const gain = cineDebug().zoom / base.zoom;
  console.log(`    (the push: ${(gain * 100 - 100).toFixed(0)}% tighter than base, most of the way in ${arrived.toFixed(2)}s)`);
  check('...and it gets there', gain > 1.25, `${(gain * 100 - 100).toFixed(0)}% tighter than base`);
  check('...within a couple of seconds of the dwell ending',
    arrived > 0 && arrived < 2.5, arrived ? `${arrived.toFixed(2)}s` : 'never');

  // THE FRAME IS OF BOTH. Between the seal and the stone, and neither of them.
  const bias = CONFIG.gravesite.gaze.bias;
  const wantY = at.y + (stoneTop(A) - at.y) * bias;
  check('the shot sits between the seal and the stone',
    cineSubject.active && Math.abs(cineSubject.y - wantY) < 0.01,
    `subject y ${cineSubject.y.toFixed(2)} against ${wantY.toFixed(2)}`);

  // ...AND FOLLOWS THE SEAL. Drift sideways without leaving the radius: a
  // captured midpoint stays where it was.
  const drifted = at.x + 1.5;
  ctx.target.x = drifted;
  look(drifted, at.y);
  for (let i = 0; i < 10; i++) {
    updateGraveGaze(DT, { camera, x: drifted, y: at.y, speed: 0, live: true });
    updateCineCamera(DT, ctx);
  }
  const wantX = drifted + (A.x - drifted) * bias;
  check('...and it follows the seal rather than a captured point',
    Math.abs(cineSubject.x - wantX) < 0.01, `subject x ${cineSubject.x.toFixed(2)} against ${wantX.toFixed(2)}`);

  // IT SURVIVES THE PLAYER MOVING, and this is the half that reads as broken
  // when it is missing: the stillness is what ARMS the shot, not what keeps
  // it. Nudging the stick, drifting on a current or turning to look at the
  // stone all break `still` for a frame, and a push that dropped on each of
  // those flickered in and out under somebody plainly standing there.
  const fast = CONFIG.gravesite.gaze.stillSpeed + 10;
  for (let i = 0; i < 60; i++) {
    updateGraveGaze(DT, { camera, x: drifted, y: at.y, speed: fast, live: true });
    updateCineCamera(DT, ctx);
  }
  check('moving about AT the grave does not drop the shot',
    cineGazing() && cineDebug().state === 'graveGaze',
    `${cineDebug().state}, dwell ${graveAttention().dwell.toFixed(2)}`);

  // ...AND IT GOES ON CLOSING IN. The arrival is the start of the shot rather
  // than the end of it, so a player who stays is still being pushed in on
  // (CONFIG.cinecam.states.graveGaze.zoomHeld). Measured well after the blend
  // has landed, so this cannot be the blend still finishing.
  const settled = cineDebug().zoom;
  for (let i = 0; i < Math.ceil(6 / DT); i++) {
    updateGraveGaze(DT, { camera, x: drifted, y: at.y, speed: 0, live: true });
    updateCineCamera(DT, ctx);
  }
  const crept = cineDebug().zoom;
  const held = CONFIG.cinecam.states.graveGaze.zoomHeld * cineAspectZoom();
  console.log(`    (the creep: ${settled.toFixed(3)} -> ${crept.toFixed(3)} over 6s, heading for ${held.toFixed(2)})`);
  check('standing there goes on closing the frame in', crept > settled + 0.05,
    `${settled.toFixed(3)} -> ${crept.toFixed(3)}`);
  check('...and never past what it was told to hold at', crept <= held + 0.02,
    `${crept.toFixed(3)} against ${held.toFixed(2)}`);

  // Leaving lets go, and the rig goes home.
  const away = { x: at.x + 200, y: at.y };
  ctx.target.x = away.x;
  look(away.x, away.y);
  for (let i = 0; i < 240; i++) {
    updateGraveGaze(DT, { camera, x: away.x, y: away.y, speed: 0, live: true });
    updateCineCamera(DT, ctx);
  }
  check('swimming away drops the latch', !cineGazing());
  check('...and the rig comes home', cineDebug().state === 'base', cineDebug().state);
  check('...and the frame is back on the seal', cineSubject.active === false);

  // A run that ends under a live push must not leave one held.
  for (let i = 0; i < 60; i++) updateGraveGaze(DT, { camera, x: at.x, y: at.y, speed: 0, live: true });
  updateGraveGaze(DT, { camera, x: at.x, y: at.y, speed: 0, live: false });
  check('a frame that is not being played drops it', !cineGazing() && !graveAttention().grave);

  CONFIG.cinecam.enabled = wasEnabled;
  resetCineCamera();
}

// ---------------------------------------------------------------------------
section('the salute');
{
  resetGraveGaze();
  resetCelebration();
  resetSalute();
  const at = overGrave(A);
  look(at.x, at.y);

  // Away from every stone.
  updateGraveGaze(DT, { camera, x: at.x + 200, y: at.y, speed: 0, live: true });
  check('nothing to salute in open water', !saluteReady() && !graveInReach());
  check('...so the button starts nothing', trySalute(null, { x: at.x + 200, y: at.y }) === null);

  // At one, and NOT having waited: the button does not ask for a dwell.
  updateGraveGaze(DT, { camera, x: at.x, y: at.y, speed: 40, live: true });
  check('a stone in reach makes the button a salute', saluteReady());
  check('...without having stood still for it', graveAttention().dwell === 0);
  const got = trySalute(null, { x: at.x, y: at.y });
  check('pressing it starts the salute', got === 'salute', String(got));
  check('...as a celebration of its own', celebrationState.variant === 'salute');
  check('...that the squad stays out of', celebrationState.escorts === false);

  // A second press over a live one is refused, not re-entered.
  const seq = celebrationState.seq;
  const again = trySalute(null, { x: at.x, y: at.y });
  check('a second press during one is refused', again === null && celebrationState.seq === seq,
    `seq ${celebrationState.seq} was ${seq}`);
}

{
  // THE FACING, which is the half of this pose that is not in the flippers.
  resetCelebration();
  resetSalute();
  const at = overGrave(A);
  look(at.x, at.y);
  updateGraveGaze(DT, { camera, x: at.x, y: at.y, speed: 0, live: true });

  check('nothing asks for a facing while nothing is posing', celebrationFacing(null) === null);
  // Standing to the LEFT of the stone: the seal should lean right, toward it.
  trySalute(null, { x: A.x - 3, y: at.y });
  updateCelebration(0.05);
  const right = celebrationFacing(null);
  check('the seal turns toward a stone on its right', right && right.x > 0,
    right ? `x ${right.x.toFixed(2)} y ${right.y.toFixed(2)}` : 'null');
  check('...and stands upright while it does', right && right.y > Math.abs(right.x),
    right ? `y ${right.y.toFixed(2)} vs |x| ${Math.abs(right.x).toFixed(2)}` : 'null');

  resetCelebration();
  resetSalute();
  updateSalute(10); // past the throttle
  trySalute(null, { x: A.x + 3, y: at.y });
  updateCelebration(0.05);
  const left = celebrationFacing(null);
  check('...and the other way for a stone on its left', left && left.x < 0,
    left ? `x ${left.x.toFixed(2)}` : 'null');

  // The weight rides the envelope, which is what makes the turn arrive with
  // the flipper and leave with it.
  const early = celebrationFacing(null)?.weight ?? 0;
  updateCelebration(CONFIG.salute.peakAt);
  const peak = celebrationFacing(null)?.weight ?? 0;
  check('the turn arrives with the pose', peak > early, `${early.toFixed(2)} -> ${peak.toFixed(2)}`);
  updateCelebration(CONFIG.salute.hold + CONFIG.salute.release + 0.1);
  check('...and is gone when the pose is', celebrationFacing(null) === null);
}

{
  // The throttle, and the switch.
  resetCelebration();
  resetSalute();
  const at = overGrave(A);
  look(at.x, at.y);
  updateGraveGaze(DT, { camera, x: at.x, y: at.y, speed: 0, live: true });
  updateSalute(10);
  check('one press lands', trySalute(null, at) === 'salute');
  resetCelebration();
  updateSalute(CONFIG.salute.minGap * 0.4);
  check('a press inside the throttle is refused even with nothing running',
    trySalute(null, at) === null);
  updateSalute(CONFIG.salute.minGap);
  check('...and allowed once it has passed', trySalute(null, at) === 'salute');

  resetCelebration();
  resetSalute();
  CONFIG.salute.enabled = false;
  updateGraveGaze(DT, { camera, x: at.x, y: at.y, speed: 0, live: true });
  check('switched off, the button is a clap again at a grave', !saluteReady() && trySalute(null, at) === null);
  CONFIG.salute.enabled = true;
}

resetGraveGaze();
resetCelebration();
resetSalute();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
