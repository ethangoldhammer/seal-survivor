#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:ragdoll
//
// THE BOSS THAT SHOWS IT WAS HIT — systems/bossRagdoll.js, on every boss
// skeleton in the game, driven through the real kill shot's real clocks.
//
// A dead boss is kept whole for a beat so the kill shot can photograph it (see
// systems/bossCorpse.js). What it used to photograph was an animal still
// swimming: the mixer kept running, the body drifted, and nothing about the
// pose said it had just been killed. The ragdoll cuts the skeleton loose on the
// killing frame and fires the blow into its bone springs.
//
// FOUR CLAIMS, and only the first is about the ragdoll existing.
//
//   EVERY BODY    Six boss archetypes across seven models — the shark, the
//                 orca (bull AND cow, since bossOrca rolls one per arrival),
//                 the mosasaur, the hammerhead, the king crab and the kraken.
//                 Each has to actually go limp, which means its declared
//                 springChains have to resolve on the real file. A chain whose
//                 bone names miss is silent: the controller warns once and the
//                 boss dies stiff forever after.
//
//   BY THE SHUTTER  The measurement this whole feature turns on. The photograph
//                 is taken at snapshotMoment() — about a second of WALL clock
//                 after the kill — and this drives the REAL updateBossKill and
//                 the REAL updateBossCorpses frame by frame, then reads the
//                 skeleton on the exact frame the shutter fires. The control is
//                 the behaviour this replaced: `enabled: false`, which is a
//                 corpse whose mixer keeps swimming at a tenth speed.
//
//   AND ARRIVED   Not merely started. The skeleton is read a second time a
//                 sixth of a second BEFORE the shutter, and the two must be
//                 close: a fall still visibly in progress when the picture is
//                 taken is a different picture every time and never the one
//                 intended. Deliberately not "compare it to the shape it
//                 converges to given forever" — it never gets forever, it
//                 bursts a fifth of a second later, and that comparison quietly
//                 measures the wrong pose.
//
//                 This is what pins CONFIG.boss.ragdoll.clock: the world spends
//                 that whole second at 0.12x, so a corpse living on the water's
//                 own clock gets under a fifth of a second of its own time and
//                 is caught mid-fall. Asserted across the roster rather than
//                 per body, because one of the seven (the hammerhead, whose
//                 chains are the shortest in the game) settles on either clock.
//
//   FROM THE BLOW The same death twice, differing in nothing but which way the
//                 killing hit travelled. If the poses come out the same, what
//                 is being measured is gravity — a body sagging, which would
//                 pass the claim above without the blow existing at all. So the
//                 two are differenced: the common sag cancels and what is left
//                 is the part that came from the direction of the hit.
//
//                 AND THE SPIN, which is the same claim about the body rather
//                 than the skeleton: the same blow landing on the snout and on
//                 the tail must roll the animal opposite ways. That is a torque
//                 and it is the only thing the contact point is carried for.
//
//   NOTHING LEAKS The controller is cached on the VISUAL and handed to whoever
//                 recycles that body. A boss that died limp and was never handed
//                 back would give its successor a skeleton that ignores the
//                 mixer — a fish that spawns dead. Checked on both routes out:
//                 the burst, and a run ending under a held body.
//
//   node --import ./tools/vite-loader.mjs tools/boss-ragdoll-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
// Every boss model embeds its textures, and GLTFLoader decodes those through
// createImageBitmap. Without a stub the parse promise never settles and the
// script exits with "unsettled top-level await" and no error at all — the trap
// tools/boss-rig-test.mjs and tools/crab-claw-test.mjs both document. Nothing
// here reads a pixel; the bones are the whole subject.
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
import * as THREE from 'three';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { CONFIG } from '../path/src/config.js';
import { ASSETS, installModel, createVisual } from '../path/src/assets.js';
import { createAnimationController } from '../path/src/systems/animation.js';
import { holdBossCorpse, updateBossCorpses, resetBossCorpses, bossCorpseCount } from '../path/src/systems/bossCorpse.js';
import { startBossKill, updateBossKill, resetBossKill, snapshotMoment } from '../path/src/systems/bossKill.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DT = 1 / 60;

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// Every boss skeleton in the game. Keyed by the ASSET, because that is what
// carries the rig — bosses.csv names an enemy, the enemy names an asset, and it
// is the asset's springChains this file is exercising.
//
// bossBoat is deliberately absent: trawler.glb is a hull with no rig, so there
// is no skeleton to ragdoll. It still takes the knock and the spin, which is
// the whole of what a boat can do, and that path is covered by the spin check.
const BODIES = [
  { label: 'megalodon (bossShark)', asset: 'enemyMegalodon', model: 'megalodon.glb' },
  { label: 'orca bull (bossOrca)', asset: 'enemyOrcaBull', model: 'orca_male.glb' },
  { label: 'orca cow (bossOrca)', asset: 'enemyOrcaCow', model: 'orca_female.glb' },
  { label: 'mosasaur (bossMosasaur)', asset: 'enemyMosasaur', model: 'mosasaurus.glb' },
  { label: 'hammerhead (bossHammerhead)', asset: 'enemyBossHammerhead', model: 'hammerhead.glb' },
  { label: 'king crab (bossCrab)', asset: 'enemyBossCrab', model: 'crabpincer.glb' },
  { label: 'kraken (bossSquid)', asset: 'enemyGiantSquid', model: 'giantsquid.glb' },
];

const loader = new GLTFLoader();
for (const body of BODIES) {
  const path = resolve(HERE, '../public/models', body.model);
  if (!existsSync(path)) {
    console.error(`\nmissing ${path} — a boss cannot ragdoll on a model that isn't there.\n`);
    process.exit(1);
  }
  const buf = readFileSync(path);
  const gltf = await loader.parseAsync(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
  );
  installModel(body.asset, gltf.scene, gltf.animations);
}

// The bones the ragdoll actually moves, taken off the asset's own declaration
// rather than out of the controller — which does not expose them, and should
// not have to grow an accessor for a test. The LAST bone of each chain is what
// is measured: it is the end that travels furthest, and a fold that does not
// reach the tips is not a fold.
function chainTips(asset, visual) {
  const chains = ASSETS[asset]?.rig?.springChains ?? [];
  const tips = [];
  for (const entry of chains) {
    const names = Array.isArray(entry) ? entry : (entry?.bones ?? []);
    const bones = names.map((n) => visual.getObjectByName(n)).filter(Boolean);
    if (bones.length >= 2) tips.push(bones[bones.length - 1]);
  }
  return tips;
}

// WHERE THE TIPS ARE, IN THE BODY'S OWN FRAME.
//
// Measured through visual.worldToLocal on purpose. The corpse is also drifting,
// sinking and rolling, and those move every bone in the world without bending
// the skeleton at all — a world-space measurement would report a rigid body
// being carried across the arena as a magnificent ragdoll. Converting into the
// visual's local space divides all of that out and leaves only the pose.
const _p = new THREE.Vector3();
function readTips(visual, tips) {
  const out = [];
  for (const t of tips) {
    t.getWorldPosition(_p);
    visual.worldToLocal(_p);
    out.push(_p.clone());
  }
  return out;
}

// How far the skeleton has travelled from the pose it died in: the summed
// displacement of every chain tip (scalar), and the vector sum of the same
// displacements. The scalar says how much it folded; the vector says which way.
function departure(before, after) {
  let mag = 0;
  const vec = new THREE.Vector3();
  for (let i = 0; i < before.length; i++) {
    _p.subVectors(after[i], before[i]);
    mag += _p.length();
    vec.add(_p);
  }
  return { mag, vec };
}

// The longest axis of the body as it is drawn, so every measurement below can
// be a FRACTION of the animal rather than a raw world figure. These models
// range from a hammerhead to a kraken and a threshold in world units would be
// a different demand on each of them.
function bodyLength(visual) {
  visual.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(visual);
  const size = box.getSize(new THREE.Vector3());
  return Math.max(size.x, size.y, size.z, 0.001);
}

/**
 * ONE BOSS DEATH, END TO END, on the real clocks.
 *
 * Builds the body, swims it until the clip is genuinely mid-stroke, kills it
 * with a blow of the caller's choosing, and then runs the actual kill shot and
 * the actual corpse hold frame by frame until the shutter fires — reading the
 * skeleton on exactly that frame, which is the only frame this feature is
 * judged on.
 *
 * @param blow { dx, dy, hxFrac } — direction of travel, and where along the
 *        body's forward axis it landed as a fraction of half-length (+1 is one
 *        end, -1 the other). Null kills the animal with no recorded blow at all.
 */
// EARLY, in wall seconds after the kill: a quarter of the way into the held
// beat, while the camera is still pushing in. The skeleton is read here as well
// as at the shutter, and the ratio between the two is what "quickly enough"
// means in a number — a fall that is mostly over by this point reads as an
// impact, and one that is a third done reads as the body drifting.
function earlyMoment() {
  const k = CONFIG.boss.kill;
  return (k.dilateTime ?? 0.12) + (k.beatTime ?? 1.5) * 0.25;
}

function die(asset, { blow, settle = 90 } = {}) {
  const scene = new THREE.Scene();
  const visual = createVisual(asset);
  const mesh = new THREE.Group();
  mesh.add(visual);
  scene.add(mesh);

  const anim = createAnimationController(visual);
  const tips = chainTips(asset, visual);
  const len = bodyLength(visual);

  // Alive, and moving. The clip has to be somewhere in the middle of a stroke
  // when the animal dies — a corpse measured from a body that was standing at
  // frame 0 of its bind pose is a corpse with nothing to fall FROM.
  for (let i = 0; i < settle; i++) {
    scene.updateMatrixWorld(true);
    anim.update(DT, 'swim', false);
  }
  scene.updateMatrixWorld(true);

  const e = {
    isBoss: true,
    mesh,
    visual,
    anim,
    hitShape: null,
    def: { radius: 2 },
    radius: 2,
    vx: 4, vy: 0,
    assetKey: asset,
  };
  if (blow) {
    e.lastBlow = {
      dx: blow.dx, dy: blow.dy,
      hx: mesh.position.x + (blow.hxFrac ?? 0) * len * 0.5,
      hy: mesh.position.y,
    };
  }

  const atDeath = readTips(visual, tips);

  resetBossKill();
  resetBossCorpses();
  const held = holdBossCorpse(e, scene);
  // The camera finds out a frame later than the body does — systems/boss.js
  // notices the creature has left the enemy list — and that one frame of
  // undilated time is real, so it is reproduced rather than skipped.
  let t = 0;
  let started = false;
  let shot = null;
  let before = null;
  const shutter = snapshotMoment();
  const early = earlyMoment();
  // A margin past the shutter so the loop cannot miss it to rounding, and so
  // the burst (shutter + corpse.afterShot) still lands inside the run.
  while (t < shutter + (CONFIG.boss.corpse.afterShot ?? 0.18) + 0.05) {
    const scale = started ? updateBossKill(DT) : 1;
    if (!started) started = startBossKill();
    updateBossCorpses(DT, DT * scale);
    scene.updateMatrixWorld(true);
    t += DT;
    // THE FRAME THE PICTURE IS TAKEN ON. Read here rather than at the end of
    // the run: everything after it is the body coming apart, and a ragdoll that
    // only arrives afterwards is exactly the bug this file exists to catch.
    // A SECOND READING, EARLY — see earlyMoment. Taken on the wall clock like
    // the shutter itself, because the question is how much of the fall the
    // PLAYER has seen by then, and the player is watching in real time however
    // slow the water is.
    if (before === null && t >= early) before = readTips(visual, tips);
    if (shot === null && t >= shutter) shot = readTips(visual, tips);
  }

  return {
    held,
    len,
    tips: tips.length,
    hasSpring: anim.hasSpring,
    springCount: anim.springCount,
    limpAfterBurst: anim.isLimp(),
    corpsesLeft: bossCorpseCount(),
    roll: mesh.rotation.z,
    // As a fraction of the animal's own length, so a hammerhead and a kraken
    // are held to the same standard.
    shot: shot ? departure(atDeath, shot) : null,
    // How far the skeleton had already fallen a quarter of the way into the
    // beat, in the same units as `shot` — an ABSOLUTE reading, deliberately not
    // a fraction of the photographed fold. Normalising it against the shutter
    // makes a body that barely falls at all score perfectly, which is exactly
    // how the water's clock passed this the first time it was written.
    early: before ? departure(atDeath, before) : null,
    anim,
    visual,
  };
}

// A blow travelling along +X, and the same blow travelling along -X. The
// landing point is at the body's centre for these, so they differ in direction
// and in nothing else.
const RIGHT = { dx: 1, dy: 0, hxFrac: 0 };
const LEFT = { dx: -1, dy: 0, hxFrac: 0 };

// --- 1. every boss skeleton can actually go limp ----------------------------
section('EVERY BOSS SKELETON — the chains resolve on the real file');
for (const body of BODIES) {
  const r = die(body.asset, { blow: RIGHT });
  check(`${body.label}: springs resolve`, r.hasSpring && r.tips >= 2,
    `${r.springCount} chains, ${r.tips} measurable tips`);
  check(`${body.label}: the body was claimed`, r.held);
}

// --- 2. the fold is there, and finished, when the shutter fires -------------
section('BY THE SHUTTER — the skeleton has fallen before the picture is taken');
const MIN_FOLD = 0.10; // of body length, summed over the chain tips
const MIN_GAIN = 2.5; // against the corpse that keeps swimming
// Of the photographed fold that must already be there a quarter of the way into
// the beat. Not higher: with the streaming force the fall genuinely keeps
// deepening for as long as the shove lasts, which is the point of it — this
// floor is here to catch a fall that STARTS late, not to demand one that is
// over before it begins.
const MIN_EARLY = 0.4;
const earlyWall = [];
const earlyWater = [];
for (const body of BODIES) {
  const live = die(body.asset, { blow: RIGHT });
  const fold = live.shot.mag / live.len;

  // THE CONTROL IS THE BEHAVIOUR THIS REPLACED: a held corpse whose mixer keeps
  // running, drifting through its last swim stroke at a tenth speed. Not zero —
  // the clip is still advancing — which is exactly why the floor is also a
  // RATIO against it and not only an absolute.
  CONFIG.boss.ragdoll.enabled = false;
  const off = die(body.asset, { blow: RIGHT });
  CONFIG.boss.ragdoll.enabled = true;
  const stiff = off.shot.mag / off.len;

  // And the same death on the water's own clock, collected for the aggregate
  // below rather than asserted body by body.
  CONFIG.boss.ragdoll.clock = 0;
  const slow = die(body.asset, { blow: RIGHT });
  CONFIG.boss.ragdoll.clock = 0.85;

  earlyWall.push(live.early.mag / live.len);
  earlyWater.push(slow.early.mag / slow.len);

  check(`${body.label}: folded by the shutter`, fold >= MIN_FOLD,
    `${(fold * 100).toFixed(1)}% of body length`);
  check(`${body.label}: and it is the ragdoll doing it`, fold >= stiff * MIN_GAIN,
    `${(fold * 100).toFixed(1)}% against ${(stiff * 100).toFixed(1)}% for a corpse that keeps swimming`);
  const gotEarly = live.early.mag / live.shot.mag;
  check(`${body.label}: and it started at once`, gotEarly >= MIN_EARLY,
    `${(gotEarly * 100).toFixed(0)}% of the photographed fold was there a quarter into the beat`);
}

// THE CLOCK, ACROSS THE ROSTER. Per body this is not always true — the
// hammerhead's chains are the shortest in the game and settle on either clock —
// but the roster as a whole is still visibly falling when the picture is taken
// if the ragdoll is left on the water's own time, and that is the whole of what
// CONFIG.boss.ragdoll.clock is for.
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
check('the roster has fallen further, early, on the ragdoll clock than on the water\'s',
  mean(earlyWall) >= mean(earlyWater) * 1.3,
  `${(mean(earlyWall) * 100).toFixed(0)}% of body length against ${(mean(earlyWater) * 100).toFixed(0)}%`);

// --- 3. it came from the direction of the blow ------------------------------
section("FROM THE BLOW — mirror the hit and the pose mirrors with it");
// Of body length, after the common sag cancels. The floor is set well under
// the hammerhead's 14% — the smallest body with the fewest chains, and so the
// least of everything measured here.
const MIN_DIRECTIONAL = 0.08;
for (const body of BODIES) {
  const a = die(body.asset, { blow: RIGHT });
  const b = die(body.asset, { blow: LEFT });
  // The two poses differ ONLY in which way the blow travelled, so differencing
  // them cancels gravity — which acts identically on both — and leaves the part
  // of the fall that the hit is responsible for.
  const split = a.shot.vec.clone().sub(b.shot.vec).length() / a.len;
  check(`${body.label}: the fold tracks the blow`, split >= MIN_DIRECTIONAL,
    `${(split * 100).toFixed(1)}% of body length between the two deaths`);
}

// --- 4. the spin is a torque, not a constant --------------------------------
section('THE SPIN — the same blow turns the body opposite ways from the two ends');
for (const body of BODIES) {
  const nose = die(body.asset, { blow: { dx: 0, dy: 1, hxFrac: 0.8 } });
  const tail = die(body.asset, { blow: { dx: 0, dy: 1, hxFrac: -0.8 } });
  check(`${body.label}: rolls away from where it was hit`,
    Math.sign(nose.roll) === -Math.sign(tail.roll) && Math.abs(nose.roll) > 0.01,
    `${nose.roll.toFixed(3)} rad against ${tail.roll.toFixed(3)} rad`);
}

// --- 5. nothing is left limp ------------------------------------------------
section('NOTHING LEAKS — the skeleton is handed back on both routes out');
for (const body of BODIES) {
  // The run above already carried each body past its burst.
  const burst = die(body.asset, { blow: RIGHT });
  check(`${body.label}: not limp after the burst`, !burst.limpAfterBurst);
  check(`${body.label}: the body was let go`, burst.corpsesLeft === 0,
    `${burst.corpsesLeft} still held`);

  // And the other route: a run ending while a body is still held.
  const scene = new THREE.Scene();
  const visual = createVisual(body.asset);
  const mesh = new THREE.Group();
  mesh.add(visual);
  scene.add(mesh);
  const anim = createAnimationController(visual);
  const e = { isBoss: true, mesh, visual, anim, hitShape: null, def: { radius: 2 }, radius: 2, vx: 0, vy: 0 };
  e.lastBlow = { dx: 1, dy: 0, hx: 0, hy: 0 };
  holdBossCorpse(e, scene);
  const wentLimp = anim.isLimp();
  resetBossCorpses();
  check(`${body.label}: not limp after a run ends under it`, wentLimp && !anim.isLimp());

  // And the pooled body's own reset clears it even if nobody asked — the belt
  // to bossRagdoll's braces, since this is the call every recycled body makes.
  anim.setLimp({ stiffness: 20, damping: 4, tipLooseness: 0.8, maxLag: 1, softness: 0.5, snapAngle: 3 });
  anim.reset();
  check(`${body.label}: reset() clears a limp skeleton`, !anim.isLimp());
}

resetBossKill();
resetBossCorpses();

console.log(`\n${failures === 0 ? 'all good' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
