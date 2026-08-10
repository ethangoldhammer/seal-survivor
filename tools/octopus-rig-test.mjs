#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:octopus
//
// Exercises the REAL octopus rig, not the procedural stand-in. It loads
// /models/octopus_rig.glb, installs it under the `octoGrabber` asset key so
// createVisual returns the actual 128-bone skeleton, and then drives
// systems/octoGrab.js exactly as the game does.
//
// This is the only way to check the parts that are pure rig: that six arm
// chains resolve from root/tip pairs, that the IK moves a tip toward a target
// it is actually given, that each arm claims a different fish, and that the
// head chain drives the body where it is pointing. `npm run test:abilities`
// runs against the boneless fallback and can say nothing about any of it.
//
//   node --import ./tools/vite-loader.mjs tools/octopus-rig-test.mjs
// ---------------------------------------------------------------------------

import '../tools/dom-stub.mjs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG } from '../path/src/config.js';
import { ASSETS, installModel } from '../path/src/assets.js';
import { enemies } from '../path/src/entities/enemies.js';
import { createOctoGrabber, updateOctoGrab, resetOctoGrab } from '../path/src/systems/octoGrab.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = resolve(HERE, '../public/models/octopus_rig.glb');

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
installModel('octoGrabber', gltf.scene, gltf.animations);

const scene = new THREE.Scene();
const dt = 1 / 60;
const player = { x: 0, y: 0 };

function fakeEnemy(x, y, radius = 0.5, hp = 40) {
  const mesh = new THREE.Object3D();
  mesh.position.set(x, y, 0);
  scene.add(mesh);
  return {
    mesh, radius, hp, vx: 0, vy: 0,
    trapTimer: 0, charmTimer: 0, flash: 0, hitThisFrame: false, biteCooldown: 0,
    def: { asset: 'enemyFish', radius, xp: 3, contactDamage: 5 },
    type: 'fish',
  };
}

// --- the rig resolves ------------------------------------------------------
console.log('\nRIG');
const octo = createOctoGrabber();
scene.add(octo);

const bones = [];
octo.traverse((o) => { if (o.isBone) bones.push(o); });
check('the real skeleton loaded (not the stand-in)', bones.length > 100, `${bones.length} bones`);

const rig = ASSETS.octoGrabber.armRig;
check('six arm chains are declared', rig.arms.length === 6, `${rig.arms.length}`);

let resolved = 0;
for (const spec of rig.arms) {
  if (octo.getObjectByName(spec.root) && octo.getObjectByName(spec.tip)) resolved++;
}
check('every arm root and tip exists in the model', resolved === 6, `${resolved} of 6`);
check('the head chain exists',
  !!octo.getObjectByName(rig.head.root) && !!octo.getObjectByName(rig.head.tip));

// Tip bones must carry no skin weight, or writing targets onto them would
// deform the mesh instead of just marking a point.
const skin = [];
octo.traverse((o) => { if (o.isSkinnedMesh) skin.push(o); });
if (skin.length) {
  const s = skin[0];
  const idx = s.geometry.attributes.skinIndex;
  const w = s.geometry.attributes.skinWeight;
  const tipNames = new Set([...rig.arms.map((a) => a.tip), rig.head.tip]);
  const tipBoneIdx = new Set();
  s.skeleton.bones.forEach((b, i) => { if (tipNames.has(b.name)) tipBoneIdx.add(i); });
  let tipWeight = 0;
  for (let i = 0; i < idx.count; i++) {
    for (let k = 0; k < 4; k++) {
      if (tipBoneIdx.has(idx.getComponent(i, k))) tipWeight += w.getComponent(i, k);
    }
  }
  check('tip bones drive no vertices (usable as pure targets)', tipWeight === 0, `weight ${tipWeight}`);
}

// --- arms reach real fish --------------------------------------------------
console.log('\nARMS');
// Reach is measured from the OCTOPUS, which rides at an offset from the seal —
// so fixtures are placed relative to its station, not to the player origin.
const cfg = CONFIG.octoGrab;
const station = { x: player.x + cfg.bodyOffset[0], y: player.y + cfg.bodyOffset[1] };
const atRange = (d) => fakeEnemy(station.x + d, station.y);

resetOctoGrab(scene, player);
enemies.length = 0;
const prey = atRange(cfg.reach * 0.6);
enemies.push(prey);

let grabbed = false;
let popped = 0;
let peakTrap = 0;
for (let i = 0; i < 900; i++) {
  updateOctoGrab(dt, scene, player, 3, enemies, {
    onGrab: () => { grabbed = true; },
    onPop: () => { popped++; },
  });
  peakTrap = Math.max(peakTrap, prey.trapTimer);
}
check('an arm grabs a fish in range', grabbed);
check('a held fish carries trapTimer', peakTrap > 0, `peak ${peakTrap.toFixed(2)}`);
check('the fish is reeled in and popped', popped > 0, `${popped} pop(s)`);

// --- one fish per arm ------------------------------------------------------
resetOctoGrab(scene, player);
enemies.length = 0;
const school = [];
for (let i = 0; i < 6; i++) school.push(fakeEnemy(2.2 + i * 0.5, -1 + i * 0.4));
enemies.push(...school);

const claimed = [];
for (let i = 0; i < 240; i++) {
  updateOctoGrab(dt, scene, player, 6, enemies, {
    onGrab: (e) => { claimed.push(e); },
    onPop: () => {},
  });
}
// The defining behaviour of the rig version: separate arms, separate fish.
check('no fish is claimed by two arms at once',
  new Set(claimed).size === claimed.length, `${claimed.length} grab(s), ${new Set(claimed).size} distinct`);
check('several arms engage at once', claimed.length > 1, `${claimed.length} grab(s)`);

// --- grab radius scales with level -----------------------------------------
console.log('\nGRAB RADIUS BY LEVEL');
// HUNTING HAS TO BE OFF FOR THIS SWEEP. `reach` is the radius of an arm
// measured from the BODY, and CONFIG.octoGrab.hunt lets the body go to the
// fish — so with it on, "can it reach 12 units away" is answered by swimming
// there and the stat stops bounding anything. Every check here is about what
// the arm covers from a standing start, so the body is pinned for the
// duration and hunting is asserted separately below.
function reachedAt(level, distance, { hunt = false } = {}) {
  const wasHunting = cfg.hunt.enabled;
  cfg.hunt.enabled = hunt;
  resetOctoGrab(scene, player);
  enemies.length = 0;
  enemies.push(atRange(distance));
  let got = false;
  for (let i = 0; i < 300; i++) {
    updateOctoGrab(dt, scene, player, level, enemies, { onGrab: () => { got = true; }, onPop: () => {} });
    if (got) break;
  }
  cfg.hunt.enabled = wasHunting;
  return got;
}
const near = cfg.reach * 0.5;
check(`level 1 reaches a fish ${near.toFixed(1)} out`, reachedAt(1, near));
// Between level 1's radius and level 8's, which is the whole point of the
// stat: the upgrade has to buy fish it previously could not touch.
const far = cfg.reach + cfg.reachPerLevel * 4;
check(`level 1 does NOT reach a fish ${far.toFixed(1)} out`, !reachedAt(1, far));
check(`level 8 DOES reach a fish ${far.toFixed(1)} out`, reachedAt(8, far));

// ...and the aggression pass, which is the reason the sweep above had to pin
// the body: a hunting octopus catches things its arms could never have
// covered from station, because it goes and gets them.
const outOfReach = cfg.reach * 1.9;
check(`hunting catches a fish ${outOfReach.toFixed(1)} out, well past arm reach`,
  reachedAt(1, outOfReach, { hunt: true }));
check('...which station-keeping alone does not',
  !reachedAt(1, outOfReach, { hunt: false }));

// THE CEILING, and why it is worth a sweep of its own. armReach() clamps the
// configured radius to what the tentacle can physically cover — the measured
// chain length times `reachStretch` — so `reach` and `reachPerLevel` can be
// raised past it and every level above the clamp then buys NOTHING, silently.
// The checks above would keep passing through that: they only ask whether
// level 8 beats level 1, and it still would, just not by what the config says.
//
// So the cap is measured (a bisection on the grab distance with the level
// scaling switched off) and the top of the level range is asserted to sit
// under it. This is also where the 4.38-unit figure quoted in CONFIG.octoGrab
// comes from — nobody should have to guess it again.
const savedReach = cfg.reach;
const savedPerLevel = cfg.reachPerLevel;
cfg.reach = 1000;
cfg.reachPerLevel = 0;
let lo = 1;
let hi = cfg.reach;
for (let i = 0; i < 24; i++) {
  const mid = (lo + hi) / 2;
  if (reachedAt(1, mid)) lo = mid; else hi = mid;
}
cfg.reach = savedReach;
cfg.reachPerLevel = savedPerLevel;

const chain = lo / cfg.reachStretch;
const topLevel = cfg.reach + cfg.reachPerLevel * 7;
check(`one tentacle measures ${chain.toFixed(2)} units, so the cap is ${lo.toFixed(2)}`,
  chain > 1 && chain < 100, `at reachStretch ${cfg.reachStretch}`);
check('the top of the level range still fits under that cap', topLevel <= lo,
  `level 8 asks for ${topLevel.toFixed(2)} of ${lo.toFixed(2)}`);

// --- head drives propulsion ------------------------------------------------
console.log('\nHEAD / PROPULSION');
resetOctoGrab(scene, player);
enemies.length = 0;
// Park the octopus far from its station and let the head pull it back.
const start = { x: 0, y: 0 };
const far2 = { x: 30, y: 12 };
let firstPos = null;
for (let i = 0; i < 600; i++) {
  updateOctoGrab(dt, scene, i < 1 ? start : far2, 3, enemies, {});
  if (i === 0) firstPos = octo.position.clone();
}
const stationX = far2.x + cfg.bodyOffset[0];
const stationY = far2.y + cfg.bodyOffset[1];
const settled = Math.hypot(octo.position.x - stationX, octo.position.y - stationY);
check('the body swims to where the head is pointing', settled < 3.0, `${settled.toFixed(2)} from station`);
check('it actually moved', octo.position.distanceTo(firstPos) > 5, `${octo.position.distanceTo(firstPos).toFixed(1)} units`);

// --- loose tentacles -------------------------------------------------------
// "Loose" has to be measurable or it is just an adjective. Two properties say
// it: an idle arm's target keeps moving when nothing is happening (drift), and
// when the body accelerates the arms are left behind before catching up (drag).
console.log('\nLOOSENESS');
resetOctoGrab(scene, player);
enemies.length = 0;

const tipOf = (i) => octoArmTip(i);
function octoArmTip(i) {
  const b = octo.getObjectByName(rig.arms[i].tip);
  const v = new THREE.Vector3();
  b.getWorldPosition(v);
  return v;
}

// A BECALMED octopus FLAILS — and this check has now been round the houses
// twice, so the reasoning is worth keeping.
//
// The original pass asserted that idle tips wander, driven by a sine on the IK
// target (CONFIG.octoGrab.idleAmp). That was removed, correctly: a sine
// playing under a stationary creature is the decorated-stick look the whole
// rig is trying to escape, so the assertion was inverted to demand stillness
// and idleAmp was left at 0.
//
// It is inverted BACK now, because CONFIG.octoGrab.turbulence supplies the
// motion from a different place: a slow, strong, per-arm force field pushed
// through the same bone spring the body's drag uses. The distinction is the
// whole point — the arms are not being posed by a wave, they are being blown
// around by one, and the spring still owns the shape that comes out. So a body
// that is not moving now produces arms that very much are.
//
// Guarded at both ends: motion has to actually happen, and it has to stay
// physical rather than launching the tips into orbit.
function tipSpreadOver(frames, target) {
  const seen = [];
  for (let i = 0; i < frames; i++) {
    updateOctoGrab(dt, scene, target, 1, enemies, {});
    if (i % 20 === 0 && i > 120) seen.push(tipOf(0).clone());
  }
  let s = 0;
  for (const a of seen) for (const b of seen) s = Math.max(s, a.distanceTo(b));
  return s;
}
const stillSpread = tipSpreadOver(420, player);
check('a stationary octopus still flails (turbulence, not body motion)',
  stillSpread > 0.5, `${stillSpread.toFixed(3)} units of wander`);
check('...and the flailing stays physical rather than flinging the tips',
  stillSpread < 40, `${stillSpread.toFixed(3)} units of wander`);

// --- the arms do not bunch up ------------------------------------------------
// The failure this guards is specific and was the visible one: with the IK off
// for idle arms (dangleWeight 0), nothing held the six apart, and the drag and
// droop impulses push every tentacle the same way — so over a few seconds the
// bundle collected into one rope hanging under the mantle and six arms
// rendered as one.
//
// Measured as the two numbers CONFIG.octoGrab.spread actually controls: how
// close the nearest pair of tips gets, and how close a tip gets to the body
// centre. Run with spread off as well, so this fails loudly if the pass is
// ever silently doing nothing rather than quietly passing on the geometry the
// rest pose happened to have.
// AVERAGED OVER TIME, not sampled once. With turbulence this strong the tips
// genuinely do sweep past each other, so an instantaneous nearest-pair reading
// catches those crossings and calls them bunching. What "bunched" actually
// means is that the bundle SITS collapsed, which is a question about the mean.
function bundleGeometry(frames) {
  resetOctoGrab(scene, player);
  enemies.length = 0;
  let pairSum = 0;
  let radiusSum = 0;
  let samples = 0;
  for (let i = 0; i < frames; i++) {
    updateOctoGrab(dt, scene, player, 1, enemies, {});
    if (i < 120 || i % 10) continue; // let it settle, then sample periodically
    const tips = rig.arms.map((_, k) => tipOf(k));
    let minPair = Infinity;
    for (let a = 0; a < tips.length; a++) {
      for (let b = a + 1; b < tips.length; b++) minPair = Math.min(minPair, tips[a].distanceTo(tips[b]));
    }
    let minRadius = Infinity;
    for (const t of tips) {
      minRadius = Math.min(minRadius, Math.hypot(t.x - octo.position.x, t.y - octo.position.y));
    }
    pairSum += minPair;
    radiusSum += minRadius;
    samples++;
  }
  return { minPair: pairSum / samples, minRadius: radiusSum / samples };
}

const spread = bundleGeometry(600);
check('the arm tips stay apart from each other',
  spread.minPair > 0.8, `nearest pair averages ${spread.minPair.toFixed(2)} units`);
check('no arm tip sits in the body centre',
  spread.minRadius > 1.5, `nearest tip averages ${spread.minRadius.toFixed(2)} from the body`);

cfg.spread.enabled = false;
const bunched = bundleGeometry(600);
cfg.spread.enabled = true;
check('the spread pass is what is doing it, not the rest pose',
  spread.minPair > bunched.minPair * 1.15,
  `${bunched.minPair.toFixed(2)} without the pass, ${spread.minPair.toFixed(2)} with it`);

// Drag: yank the station a long way and check the arms LAG the body rather
// than translating rigidly with it.
resetOctoGrab(scene, player);
for (let i = 0; i < 90; i++) updateOctoGrab(dt, scene, player, 1, enemies, {});
const bodyBefore = octo.position.clone();
const tipBefore = tipOf(0);
const yank = { x: player.x + 26, y: player.y };
for (let i = 0; i < 18; i++) updateOctoGrab(dt, scene, yank, 1, enemies, {});
const bodyDelta = octo.position.clone().sub(bodyBefore);
const tipDelta = tipOf(0).clone().sub(tipBefore);
check('the body accelerates away', bodyDelta.length() > 0.5, `body moved ${bodyDelta.length().toFixed(2)}`);

// A RIGID bundle would move exactly with the body — same vector, so the
// residual between the two displacements would be ~0. Loose arms decouple from
// it, and it does not matter which direction they decouple in: lagging behind
// and whipping past are both the tentacle declining to move as one piece with
// the mantle. Measuring the residual rather than a signed comparison is what
// makes this check independent of which of the two happens to dominate.
const residual = tipDelta.clone().sub(bodyDelta).length() / Math.max(1e-4, bodyDelta.length());
check('the tips move independently of the body', residual > 0.25,
  `${(residual * 100).toFixed(0)}% of the body's motion is not shared by the tip`);

// CURVATURE — the direct test of "stick vs flagellum". A rigid arm has all its
// bones in a line, so the turning angle between consecutive segments is ~0
// everywhere. A flowing one bends along its length, and a travelling wave
// means the bend is DISTRIBUTED rather than concentrated in one hinge.
function armCurvature(armIndex) {
  const spec = rig.arms[armIndex];
  const root = octo.getObjectByName(spec.root);
  const tip = octo.getObjectByName(spec.tip);
  const chain = [];
  let cur = tip;
  while (cur && cur !== root) { chain.unshift(cur); cur = cur.parent; }
  chain.unshift(root);

  const pts = chain.map((b) => {
    const v = new THREE.Vector3();
    b.getWorldPosition(v);
    return v;
  });

  let total = 0;
  let worst = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (let i = 1; i < pts.length - 1; i++) {
    a.subVectors(pts[i], pts[i - 1]);
    b.subVectors(pts[i + 1], pts[i]);
    if (a.lengthSq() < 1e-9 || b.lengthSq() < 1e-9) continue;
    const ang = a.normalize().angleTo(b.normalize());
    total += ang;
    worst = Math.max(worst, ang);
  }
  return { total, worst, joints: pts.length - 2 };
}

// Measured mid-manoeuvre, while the wave is actually travelling.
for (let i = 0; i < 10; i++) updateOctoGrab(dt, scene, { x: player.x - 20, y: player.y + 8 }, 1, enemies, {});
const curve = armCurvature(0);
check('the arm bends along its length rather than staying straight',
  curve.total > 0.6, `${curve.total.toFixed(2)} rad total over ${curve.joints} joints`);
// The distinction between a flowing tentacle and a stick with one elbow in it.
check('the bend is spread along the arm, not one hinge',
  curve.worst < curve.total * 0.7,
  `worst joint ${curve.worst.toFixed(2)} of ${curve.total.toFixed(2)} rad`);

// --- bioluminescence on the real arms --------------------------------------
console.log('\nARM GLOW');
resetOctoGrab(scene, player);
enemies.length = 0;

// Idle: every channel should sit at the ambient floor, not lit.
for (let i = 0; i < 60; i++) updateOctoGrab(dt, scene, player, 1, enemies, {});
const glow = octoGlowUniform();
function octoGlowUniform() {
  // The handle is private to the system, so the uniform is read off the
  // material the way the GPU would — which also proves it was actually
  // attached to the mesh rather than to a detached copy.
  let found = null;
  octo.traverse((o) => {
    if (found || !o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) if (m?.userData?.__biolum) found = m;
  });
  return found;
}
check('the glow attached to the octopus material', !!glow);

const attrs = [];
octo.traverse((o) => { if (o.isMesh && o.geometry.attributes.aGlowParam) attrs.push(o); });
check('glow attributes were baked onto the mesh', attrs.length > 0, `${attrs.length} mesh(es)`);

if (attrs.length) {
  const pm = attrs[0].geometry.attributes.aGlowParam;
  const chn = attrs[0].geometry.attributes.aGlowChannel;
  let maxCh = -1;
  let lit = 0;
  let maxParam = -Infinity;
  for (let i = 0; i < pm.count; i++) {
    if (pm.getX(i) >= 0) { lit++; maxParam = Math.max(maxParam, pm.getX(i)); maxCh = Math.max(maxCh, chn.getX(i)); }
  }
  check('vertices were assigned to all six arm channels', maxCh === 5, `highest channel ${maxCh}`);
  check('the parameterisation reaches the tip', Math.abs(maxParam - 1) < 1e-5, `max param ${maxParam.toFixed(3)}`);
  check('a good share of the mesh is lit-capable', lit > pm.count * 0.4,
    `${lit} of ${pm.count} vertices on an arm`);
}

// --- camouflage ------------------------------------------------------------
// Each arm takes the colour of whatever it is holding, or of the nearest
// creature to its own tip. What can be checked here is the plumbing and the
// direction of travel: with a creature parked next to the octopus, at least
// one channel must leave the configured glow colour, and it must come back
// when the water empties. Whether the colour is RIGHT is the art's problem —
// in the browser it comes from averaging the creature's own texture, which
// needs a canvas this harness does not have.
console.log('\nCAMOUFLAGE');
const glowU = octoGlowUniform()?.userData?.__biolum;
check('the glow uniforms are reachable', !!glowU?.uGlowChColor);

if (glowU?.uGlowChColor) {
  const cc = glowU.uGlowChColor.value;
  const base = new THREE.Color(cfg.glow.color);
  const offBase = () => {
    let worst = 0;
    for (let i = 0; i < cc.length; i += 3) {
      worst = Math.max(worst, Math.abs(cc[i] - base.r) + Math.abs(cc[i + 1] - base.g) + Math.abs(cc[i + 2] - base.b));
    }
    return worst;
  };

  resetOctoGrab(scene, player);
  enemies.length = 0;
  for (let i = 0; i < 30; i++) updateOctoGrab(dt, scene, player, 1, enemies, {});
  check('an octopus in empty water wears its own glow colour', offBase() < 1e-3,
    `worst channel is ${offBase().toFixed(4)} off the base`);

  // Parked at the station rather than at reach, so it is unambiguously inside
  // the camouflage radius of several arms at once.
  enemies.push(atRange(1.0));
  for (let i = 0; i < 60; i++) updateOctoGrab(dt, scene, player, 1, enemies, {});
  const tinted = offBase();
  check('a creature alongside tints at least one arm', tinted > 0.05,
    `worst channel is ${tinted.toFixed(3)} off the base`);

  enemies.length = 0;
  for (let i = 0; i < 300; i++) updateOctoGrab(dt, scene, player, 1, enemies, {});
  check('and the colour drains back once it is gone', offBase() < tinted * 0.25,
    `${offBase().toFixed(3)} left of ${tinted.toFixed(3)}`);
}

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
