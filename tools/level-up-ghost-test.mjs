#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:levelupghost
//
// The seal coming back after a pick (systems/levelUpGhost.js), on the real
// furseal.glb, with no renderer and no scene: the puppet half of that file is
// handed a held seal, a view and a trail, and driven by a progress.
//
// WHAT IT GUARDS:
//
//   THE POP           it appears on the seal instead of swimming in from off
//                     the bottom of the screen, or is solid on its first
//                     frame. Both are one wrong sign in the entry.
//   THE STRANGER      it lands NEAR the seal — a hand's width off, the nose a
//                     few degrees out, a flipper a frame behind. The whole
//                     point is that the last frame of the ghost IS the real
//                     seal: position, heading and every bone, exactly.
//   THE SHORTCUT      it swims straight at the seal and ignores the path the
//                     player took. The trail is what ties the return to the
//                     run; a ghost that skips it is a fade-in with travel.
//   THE STATUE        the swim clip never picks up — a seal gliding in with
//                     its tail still.
//   THE KNOT          a seal that was treading water records a hundred
//                     samples on one spot; a spline through them is a knot.
//   THE BORROWED SKIN a model clone shares the template's material by
//                     reference (assets.js createVisual), so an opacity
//                     written onto the ghost's faded the player and the menu
//                     seal too, and left the run's seal see-through after the
//                     merge. The ghost must own copies — carrying the mottle
//                     shader across, which Material.clone() drops.
//   THE RATCHET       the pose is held only once the salute has released,
//                     and never while it is performing.
//   THE TWO CLOCKS    the restore ramp publishes its progress, 0 → 1, over
//                     exactly restoreTime, and `done` fires as it reaches 1.
//   OFF IS OFF        the toggle, read live.
//
// NOTE the load order: dom-stub FIRST, then the game modules — see the
// harness recipe.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG } from '../path/src/config.js';
import { installModel, createVisual } from '../path/src/assets.js';
import { createAnimationController } from '../path/src/systems/animation.js';
import { celebrationState } from '../path/src/systems/celebrate.js';
import {
  levelUpState, startLevelUpTime, updateLevelUpTime, endLevelUpTime, resetLevelUpTime,
} from '../path/src/systems/levelUpTime.js';
import {
  createLevelUpGhost, ghostPathPoints, levelUpGhostEnabled,
  recordPlayerTrail, playerTrail, clearPlayerTrail,
  holdPlayerPose, playerPoseHeld, levelUpGhostState,
} from '../path/src/systems/levelUpGhost.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = resolve(HERE, '../public/models/furseal.glb');
const DT = 1 / 60;

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

if (!existsSync(MODEL)) {
  console.error(`\nmissing ${MODEL} — the seal has to be in public/models for the game to load it too.\n`);
  process.exit(1);
}

const buf = readFileSync(MODEL);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
);
installModel('ship', gltf.scene, gltf.animations);

const CFG = CONFIG.levelUpGhost;
CFG.enabled = true;
// Pinned for the arithmetic below, so a retune of the defaults moves the
// game and not this file's expectations.
CFG.alpha = 0.45;
CFG.fadeIn = 0.15;
CFG.fadeOut = 0.25;
CFG.startBelow = 4;
CFG.entryX = 0.8;
CFG.trailSeconds = 0.6;
CFG.trailPoints = 8;
CFG.minGap = 0.15;
CFG.ease = 'outCubic';
CFG.headingBlendAt = 0.6;
CFG.poseBlendAt = 0.7;
CONFIG.animation.enabled = true;

// What is on screen: a 40 x 22.5 window centred on (10, -5).
const VIEW = { x: 10, y: -5, halfW: 20, halfH: 11.25 };
const BOTTOM = VIEW.y - VIEW.halfH;

// THE HELD SEAL — the run's animal as the ghost sees it: a holder carrying
// the heading, a createVisual body carrying the facing, posed by its own
// controller for a while and then stopped where it stands.
function buildPlayer(x, y, rot) {
  const mesh = new THREE.Object3D();
  const body = createVisual('ship');
  mesh.add(body);
  mesh.position.set(x, y, 0);
  mesh.rotation.z = rot;
  body.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI); // mirrored
  const anim = createAnimationController(body);
  for (let i = 0; i < 45; i++) anim.update(DT, 'swim', false);
  mesh.updateMatrixWorld(true);
  return { mesh, body, anim };
}

// A trail: the seal came in from the left along a shallow arc and stopped.
function arcTrail(to, seconds = 0.6) {
  const n = Math.round(seconds / DT);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const k = i / n;
    out.push({
      x: to.x - 6 * (1 - k),
      y: to.y - 2.5 * Math.sin((1 - k) * Math.PI * 0.5),
      rot: 0,
      t: k * seconds,
    });
  }
  return out;
}

function bones(root) {
  const m = new Map();
  root.traverse((o) => { if (o.isBone) m.set(o.name, o); });
  return m;
}
function maxBoneGap(a, b) {
  let worst = 0;
  for (const [name, ga] of a) {
    const gb = b.get(name);
    if (!gb) continue;
    worst = Math.max(worst, ga.quaternion.angleTo(gb.quaternion), ga.position.distanceTo(gb.position));
  }
  return worst;
}
// Distance from a point to a polyline.
function distToPolyline(p, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]; const b = pts[i + 1];
    const dx = b.x - a.x; const dy = b.y - a.y;
    const L = dx * dx + dy * dy;
    const t = L > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
}

const build = () => createLevelUpGhost(createVisual('ship'), { outline: true, dress: false });

// ---------------------------------------------------------------------------
section('THE PATH');
{
  const from = { x: 14, y: -8, rot: 0.3 };
  const pts = ghostPathPoints(from, VIEW, arcTrail(from));
  check('it starts below the bottom of the screen', pts[0].y < BOTTOM - CFG.startBelow + 1e-9,
    `entry y ${pts[0].y.toFixed(2)} vs screen bottom ${BOTTOM.toFixed(2)}`);
  const wantX = from.x + (VIEW.x - from.x) * (1 - CFG.entryX);
  check('...weighted under the seal, not the screen centre', Math.abs(pts[0].x - wantX) < 1e-9,
    `entry x ${pts[0].x.toFixed(2)}, seal ${from.x}, centre ${VIEW.x}`);
  const last = pts[pts.length - 1];
  check('it ends exactly on the held seal', last.x === from.x && last.y === from.y);
  check('the trail is in it, oldest first', pts.length >= 4 && pts[1].x < pts[2].x, `${pts.length} points`);
  check('...thinned to the tuned count', pts.length <= CFG.trailPoints + 2, `${pts.length} points`);

  // THE KNOT: a seal treading water.
  const still = Array.from({ length: 80 }, (_, i) => ({ x: from.x + 0.001 * i, y: from.y, rot: 0, t: i * DT }));
  const two = ghostPathPoints(from, VIEW, still);
  check('a stationary trail collapses to entry and seal', two.length === 2, `${two.length} points`);
}

// ---------------------------------------------------------------------------
section('IT COMES FROM BELOW');
{
  const from = { x: 14, y: -8, rot: 0.3 };
  const player = buildPlayer(from.x, from.y, from.rot);
  const g = build();
  check('a fresh ghost is inactive and hidden', !g.active && !g.holder.visible);
  check('it starts', g.begin({ from, view: VIEW, trail: arcTrail(from), source: player }) && g.active);
  g.update(DT, 0);
  check('the first frame is off the bottom', g.holder.position.y < BOTTOM, `y ${g.holder.position.y.toFixed(2)} vs ${BOTTOM.toFixed(2)}`);
  check('...and see-through', g.state.alpha === 0, `alpha ${g.state.alpha}`);
  check('...nose up', Math.abs(g.state.heading) < 0.6, `heading ${g.state.heading.toFixed(2)} rad`);

  let peak = 0; let idleFrames = 0; let swimFrames = 0; let lowest = Infinity;
  const N = 33; // a 0.55s ramp at 60Hz
  for (let i = 1; i <= N; i++) {
    const p = i / N;
    g.update(DT, p);
    peak = Math.max(peak, g.state.alpha);
    lowest = Math.min(lowest, g.holder.position.y);
    if (p < 0.5) { if (g.state.animState === 'idle') idleFrames++; else swimFrames++; }
  }
  check('it becomes visible, never past the tuned alpha', peak > 0.4 && peak <= CFG.alpha + 1e-9, `peak ${peak.toFixed(3)}`);
  check('it never sinks back below its entry', lowest >= BOTTOM - CFG.startBelow - 1e-6, `lowest ${lowest.toFixed(2)}`);
  check('the swim clip runs on the way in', swimFrames > 0 && idleFrames === 0, `${swimFrames} swimming, ${idleFrames} idle`);
}

// ---------------------------------------------------------------------------
section('IT FOLLOWS THE TRAIL');
{
  const from = { x: 14, y: -8, rot: 0.3 };
  const player = buildPlayer(from.x, from.y, from.rot);
  const trail = arcTrail(from);
  const g = build();
  g.begin({ from, view: VIEW, trail, source: player });
  const poly = trail.map((s) => ({ x: s.x, y: s.y }));
  // Once past the entry (where the path is between the bottom and the trail's
  // start), every frame must sit on the recorded path.
  let off = 0; let on = 0; let worst = 0;
  for (let i = 1; i <= 60; i++) {
    const p = i / 60;
    g.update(DT, p);
    const pos = { x: g.holder.position.x, y: g.holder.position.y };
    if (pos.y < trail[0].y - 0.3) continue; // still on the approach
    const d = distToPolyline(pos, poly);
    worst = Math.max(worst, d);
    if (d < 0.6) on++; else off++;
  }
  check('the trail is retraced', on >= 10 && off === 0, `${on} frames on it, ${off} off, worst ${worst.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
section('IT LANDS IN THE POSE');
{
  const from = { x: 14, y: -8, rot: 0.3 };
  const player = buildPlayer(from.x, from.y, from.rot);
  const g = build();
  g.begin({ from, view: VIEW, trail: arcTrail(from), source: player });
  const pb = bones(player.body);
  const gb = bones(g.body);
  check('the two rigs share their bones', pb.size > 10 && gb.size === pb.size, `${pb.size} / ${gb.size}`);
  g.update(DT, 0.3);
  const midGap = maxBoneGap(gb, pb);
  check('mid-swim it is in its own pose', midGap > 0.05, `worst bone ${midGap.toFixed(3)} rad`);
  for (let i = 1; i <= 60; i++) g.update(DT, 0.3 + 0.6995 * (i / 60));
  check('...and on the last frame it IS the seal', maxBoneGap(gb, pb) < 0.01, `worst bone ${maxBoneGap(gb, pb).toFixed(4)}`);
  check('on the seal', Math.hypot(g.holder.position.x - from.x, g.holder.position.y - from.y) < 0.01,
    `(${g.holder.position.x.toFixed(3)}, ${g.holder.position.y.toFixed(3)})`);
  check('on its heading', Math.abs(g.state.heading - from.rot) < 0.01, `${g.state.heading.toFixed(3)} vs ${from.rot}`);
  check('facing the same way', g.body.quaternion.angleTo(player.body.quaternion) < 1e-6);
  check('...and gone', g.state.alpha < 0.01, `alpha ${g.state.alpha.toFixed(3)}`);
  g.update(DT, 1);
  check('at 1 it merges and stands down', !g.active && !g.holder.visible);
}

// ---------------------------------------------------------------------------
section('IT WEARS ITS OWN SKIN');
{
  // A model clone shares the template's material by reference — the player
  // and the menu seal wear the same one — so a ghost that faded ITS material
  // faded them all, and left the run's seal see-through after the merge.
  const from = { x: 14, y: -8, rot: 0.3 };
  const player = buildPlayer(from.x, from.y, from.rot);
  const theirs = new Set();
  player.body.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) theirs.add(m);
  });
  const g = build();
  const shared = g.materials.filter((m) => theirs.has(m));
  check('the ghost has materials', g.materials.length > 0, `${g.materials.length}`);
  check('...none of them the seal\'s', shared.length === 0, `${shared.length} shared`);
  check('...each carrying the seal\'s shader', g.materials.every((m, i) => !!m.onBeforeCompile === [...theirs].some((t) => !!t.onBeforeCompile)));
  g.begin({ from, view: VIEW, trail: arcTrail(from), source: player });
  for (let i = 1; i <= 20; i++) g.update(DT, i / 40);
  const faded = [...theirs].filter((m) => m.transparent || m.opacity < 1);
  check('mid-swim the real seal is untouched', faded.length === 0, `${faded.length} of the seal's materials touched`);
  g.reset();
}

// ---------------------------------------------------------------------------
section('THE HOLD');
{
  clearPlayerTrail();
  holdPlayerPose(false);
  celebrationState.active = false;
  check('nothing held by default', !playerPoseHeld());
  holdPlayerPose(true);
  check('held once asked', playerPoseHeld());
  celebrationState.active = true;
  check('...but never while the salute is performing', !playerPoseHeld());
  celebrationState.active = false;
  check('...and again once it has released', playerPoseHeld());
  holdPlayerPose(false);
  check('let go', !playerPoseHeld() && !levelUpGhostState.hold);

  // THE RECORD keeps only the tuned window.
  for (let i = 0; i < 200; i++) recordPlayerTrail(i * 0.1, 0, 0, DT);
  const t = playerTrail();
  const span = t[t.length - 1].t - t[0].t;
  check('the trail keeps the last trailSeconds', span <= CFG.trailSeconds + DT && span > CFG.trailSeconds - 2 * DT,
    `${span.toFixed(3)}s over ${t.length} samples`);
  clearPlayerTrail();
  check('...and clears', playerTrail().length === 0);
}

// ---------------------------------------------------------------------------
section('THE TWO CLOCKS');
{
  resetLevelUpTime();
  CONFIG.levelUp.enabled = true;
  CONFIG.levelUp.restoreTime = 0.55;
  let ready = false;
  startLevelUpTime(() => { ready = true; });
  for (let i = 0; i < 300 && !ready; i++) updateLevelUpTime(DT);
  check('the cards arrive', ready && levelUpState.phase === 'hold');
  check('no restore progress while held', levelUpState.restore === 0);
  let done = -1; let frames = 0; let monotone = true; let last = 0;
  endLevelUpTime(() => { done = frames; });
  while (levelUpState.active && frames < 300) {
    frames++;
    updateLevelUpTime(DT);
    if (levelUpState.active) {
      if (levelUpState.restore < last) monotone = false;
      last = levelUpState.restore;
    }
  }
  check('restore climbs 0 → 1', monotone && last > 0.9, `reached ${last.toFixed(3)} before done`);
  check('...over restoreTime', Math.abs(frames * DT - 0.55) <= DT + 1e-9, `${frames} frames = ${(frames * DT).toFixed(3)}s`);
  check('done fires the frame it lands', done === frames);
  check('...and the ramp resets its progress', levelUpState.restore === 0 && !levelUpState.active);
}

// ---------------------------------------------------------------------------
section('OFF IS OFF');
{
  CFG.enabled = false;
  check('the toggle reads live', !levelUpGhostEnabled());
  const from = { x: 14, y: -8, rot: 0.3 };
  const g = build();
  check('it will not start', !g.begin({ from, view: VIEW, trail: [], source: buildPlayer(from.x, from.y, from.rot) }) && !g.active);
  CFG.enabled = true;
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
