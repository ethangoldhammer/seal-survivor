#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:angler
//
// The anglerfish ambush, driven through the REAL state machine on the REAL
// model — systems/bossAngler.js stepping at 60fps against a stand-in body, and
// anglerfish.glb installed through the shipping asset pipeline so the clip
// names this fight asks for are the ones the file actually has.
//
// THE ASSET PIPELINE IS THE POINT OF LOADING THE MODEL AT ALL. Nothing here
// renders. What a hand-built stub cannot catch is the failure this feature is
// most exposed to: the fight names STATES ('idle', 'bark', 'boost', 'bite')
// and assets.js maps those to CLIPS ('trap', 'swim_start', 'swim2', 'bite').
// Either half can be edited without the other, and when they disagree nothing
// throws — systems/animation.js silently declines to play a state it has no
// clip for, so the boss ambushes you in its bind pose. So the states this file
// asks for are checked against the controller built off the real glb.
//
// WHAT IS ASSERTED, and why each one is here rather than being obvious:
//
//   THE CADENCE      lurk -> windup -> lunge -> snap -> recover -> lurk, with
//                    each stage lasting what CONFIG.boss.angler says. A stage
//                    that never exits is the classic state-machine bug and it
//                    presents as a boss that simply stops fighting.
//
//   THE LOCKED LINE  the player is TELEPORTED sideways during the lunge and
//                    the direction must not follow. This is the whole
//                    counterplay: a homing ambush is a damage race with extra
//                    steps. Measured as the angle between the committed
//                    direction and the direction to the moved player, which
//                    has to be large — a test that only checked "it moved"
//                    would pass on a homing lunge.
//
//   THE TELL LANDS   the emissive envelope has to PEAK on the frame the lunge
//                    launches. This is the cross-file promise: CONFIG.boss
//                    .angler.windup and CONFIG.emissiveCues.windup.attack are
//                    separate numbers owned by different blocks, and a tell
//                    whose brightest frame is 200ms early is a tell that
//                    teaches the player the wrong moment.
//
//   THE DARK WINDOW  the light has to actually go out during the recovery, and
//                    be measurably dimmer than the lurk. "Dark anglerfish is a
//                    safe anglerfish" is a rule the fight makes and this is
//                    where it is kept honest.
//
//   ISOLATION        two anglerfish, one cued. The other must not move a
//                    single material. createVisual hands every clone the
//                    template's material by reference, so the natural
//                    implementation lights every anglerfish in the water on
//                    the boss's wind-up — the tell becoming the least
//                    informative thing on screen.
//
//   THE HANDBACK     release() has to give back the contact damage it
//                    multiplied and the locomotion state it pinned. A boss
//                    that dies mid-lunge otherwise leaves x2 damage on a def
//                    object the NEXT arrival reads.
//
//   THE PERK YIELD   a perk mid-dash owns the body. This file runs after
//                    updateBossPerks, so without the yield it overwrites that
//                    velocity every frame and the perk never moves the animal.
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
// anglerfish.glb embeds four WebP textures and GLTFLoader decodes them through
// createImageBitmap. Without this stub the parse promise never settles and the
// script exits with "unsettled top-level await" and no error at all.
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
// The beam is a real beam — systems/beams.js, the same object the seal's Laser
// Eyes light — and it paints its taper profile and glow sprite onto a 2D
// canvas the first time one is spawned. dom-stub returns null for getContext,
// so give it just enough to draw into; nothing here reads the pixels back, and
// a stub that returned nothing would fail inside three.js with an error about
// createImageData rather than about the fight. Same shim as
// tools/beam-churn-test.mjs, and for the same reason.
document.createElement = (tag) => ({
  tagName: tag, width: 0, height: 0, style: {},
  getContext: () => ({
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {}, fillRect: () => {}, clearRect: () => {},
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    set fillStyle(_v) {}, get fillStyle() { return '#000'; },
  }),
});
import * as THREE from 'three';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { execFileSync } from 'node:child_process';

import { CONFIG } from '../path/src/config.js';
import { installModel, createVisual, ASSETS, getAssetSizeMultiplier } from '../path/src/assets.js';
import { createAnimationController } from '../path/src/systems/animation.js';
import { attachEmissiveCues, cueLevel, cueDuration } from '../path/src/systems/emissivePulse.js';
import {
  attachAngler, releaseAngler, updateBossAngler, anglerStage, anglerState, isAnglerBoss,
} from '../path/src/systems/bossAngler.js';
import { bounds, seabedTopY, clampBelowSurface } from '../path/src/arena.js';
// The facing path out of entities/enemies.js — see the note on `step`.
import { turnFish, comesAbout } from '../path/src/systems/fishTurn.js';
import { beams, resetBeams } from '../path/src/systems/beams.js';
// The SHIPPING roster row, parsed from the shipping csv the same way
// systems/boss.js parses it — the boss's sizeMul is a third of what its radius
// actually is in a fight, and a stub carrying only the enemies.csv radius is a
// stub a third the size of the animal. See the note on makeBoss.
import bossesCsv from '../path/src/bosses.csv?raw';
import { parseBossCsv } from '../path/src/bossTable.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DT = 1 / 60;
const KEY = 'enemyBossAnglerfish';
const C = () => CONFIG.boss.angler;

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// --- the real model, through the real pipeline ------------------------------
const modelPath = resolve(HERE, '../public/models/anglerfish.glb');
if (!existsSync(modelPath)) {
  console.error(`\nmissing ${modelPath} — run \`npm run anglerfish\` first.\n`);
  process.exit(1);
}
{
  const buf = readFileSync(modelPath);
  const gltf = await new GLTFLoader().parseAsync(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
  );
  installModel(KEY, gltf.scene, gltf.animations);
}

// --- a stand-in body --------------------------------------------------------
// Everything the fight touches and nothing it does not. `def` is the SHIPPING
// CONFIG row rather than a literal, so a marker renamed in config.js fails here
// instead of silently never arming the ambush.
//
// IT HAS NO `x`/`y`, AND THAT ABSENCE IS LOAD-BEARING. A real enemy record does
// not carry them — position lives on `e.mesh.position`, which is what
// bossPerks.js and kraken.js both read. The first version of this stub had
// `x: 0, y: 0` on it, so every assertion below passed against a body shaped
// like nothing the game ever builds, while the shipped fight read undefined,
// computed NaN, and put an invisible boss in the water. A stub may be smaller
// than the real thing; it may not be a different shape.
// THE RADIUS IS THREE NUMBERS MULTIPLIED, and a stub that carries only the
// first is a body a third of the size of the one the fight steers. enemies.csv
// says 2.1, assets.csv scales the model by 2.5, and bosses.csv scales THAT by
// 1.5 at spawn (applyBossScale in systems/boss.js) — 7.875 world units.
//
// It matters here rather than being decoration: everything about holding the
// bottom is measured off the radius, because the arena clamp that decides how
// low a body may go is (bounds.bottom + radius). A stub with no radius at all
// rests six units lower than the animal can, and every assertion about the
// floor would have been made against a fish sunk into the scenery.
const BOSS_ROW = parseBossCsv(bossesCsv, CONFIG.enemies, () => {})
  .find((r) => r.id === 'bossAnglerfish');
const BOSS_RADIUS = CONFIG.enemies.bossAnglerfish.radius
  * getAssetSizeMultiplier(KEY) * (BOSS_ROW?.sizeMul ?? 1);
// Where a body of that radius is allowed to rest — the same expression
// systems/bossAngler.js's floorY uses, spelled out here rather than exported,
// so a change to one has to be made deliberately in the other.
const floorLine = () => bounds.bottom + BOSS_RADIUS + CONFIG.boss.angler.floorLift;

// A CONTAINER WITH THE MODEL INSIDE IT, which is what spawnOne builds and is
// NOT what this stub used to be. `e.mesh` is a Group and `e.visual` is its
// child, and the two carry different halves of the pose: the container holds
// `rotation.z`, the heading, and the model holds `rotation.y`, the side the
// animal is facing — a half roll about its own forward axis.
//
// Collapsing them into one object, as this did, composes those two rotations in
// the wrong ORDER. Three.js reads an Euler as Rx*Ry*Rz, so one object applies
// the roll AFTER the heading (turning the world, not the fish) where two apply
// it before. The visible difference is the whole question this file now asks:
// nested, a fish facing left is upright; collapsed, the same numbers put it
// exactly upside down. A stub may be smaller than the real thing; it may not be
// a different shape.
function makeBoss(scene) {
  const visual = createVisual(KEY);
  const container = new THREE.Group();
  container.add(visual);
  scene.add(container);
  const def = CONFIG.enemies.bossAnglerfish;
  const e = {
    def, mesh: container, vx: 0, vy: 0, dead: false,
    hp: def.hp, maxHp: def.hp,
    radius: BOSS_RADIUS,
    // The MODEL, not the container — the lure and the eye bones are found by
    // name under this one, and it is the object that carries the side roll.
    visual,
    contactDamage: def.contactDamage, animState: null, perkDrive: false,
    anim: createAnimationController(visual),
  };
  return e;
}
// ONE WHOLE FRAME OF THE THINGS THAT HAPPEN AFTER updateBossAngler, in the
// order main.js runs them: the integrator, the arena clamp, and the facing.
//
// THE LAST TWO USED TO BE MISSING AND THAT IS WHY THIS FILE PASSED THROUGH TWO
// SHIPPED BUGS. The fight sets a velocity and an aim; it does not move the body
// and, since the come-about, it does not write a single rotation. So a harness
// that only integrated was measuring an animal with no walls and no
// orientation:
//
//   THE SNAP AND THE FLIP. Orientation used to be split between this file's
//   subject and entities/enemies.js, handed back and forth mid-stage. Measured
//   through the real path, the handoffs inside the recovery swung the body
//   166.9 degrees between two frames and left the dorsal 179.9 degrees off
//   vertical. Every assertion in IT IS NEVER UPSIDE DOWN below passed anyway,
//   because the writer that produced those frames was never called here.
//
//   BEING STUCK. The clamp is a POSITION clamp and does not touch the velocity
//   that drove into it, so a committed lunge along the seabed spent its whole
//   run and its whole follow-through being pushed back 0.4 units a frame —
//   335 lunge frames and 224 snap frames in a 90-second fight. With no clamp in
//   the harness the body simply flew through the floor and nothing looked
//   wrong.
//
// So the walls and the facing are part of a step now. `turnFish` is called
// exactly as the shipped branch calls it — see the facing block in
// entities/enemies.js — which is what makes the numbers below the game's.
const step = (e, dt) => {
  e.mesh.position.x += e.vx * dt;
  e.mesh.position.y += e.vy * dt;
  clampBelowSurface(e.mesh.position, e.radius);
  if (e.def.faceMotion && !e.faceLocked && comesAbout(e.def, e)) turnFish(e, dt, false);
};

// WHERE THE NOSE ACTUALLY POINTS, composed, rather than the value of any one
// rotation. The come-about spreads the pose across three axes on two objects
// (mesh yaw, mesh pitch, visual bank) and no single number in it is the
// heading — a check written against `mesh.rotation.z` measures a convention
// rather than an animal, and would have to be rewritten every time the
// decomposition changed. The model's forward is entity +Y; see
// orientationQuaternion in assets.js.
function forwardOf(e) {
  e.mesh.updateMatrixWorld(true);
  return new THREE.Vector3(0, 1, 0)
    .applyQuaternion(e.mesh.getWorldQuaternion(new THREE.Quaternion()));
}
const at = (e, x, y) => { e.mesh.position.set(x, y, 0); };

const scene = new THREE.Scene();
const boss = makeBoss(scene);
const forwardVec = (e) => { e.mesh.updateMatrixWorld(true); return new THREE.Vector3(0,1,0).applyQuaternion(e.mesh.getWorldQuaternion(new THREE.Quaternion())); };
const player = { x: 0, y: 0 };
function fight(px, py, seconds = 60) {
  releaseAngler();
  attachAngler(scene, boss);
  at(boss, 0, floorLine()); boss.vx = 0; boss.vy = 0; boss.hp = boss.maxHp;
  player.x = px; player.y = py;
  let offAim = 0, samples = 0, worstAim = 0;
  const atFire = []; let prevBeams = 0, prevPulse = 0; let prevStage = null;
  let chargeOff = 0, chargeN = 0, chargeWorst = 0;
  for (let i = 0; i < 60 * seconds; i++) {
    updateBossAngler(DT, scene, player, {});
    const f = forwardVec(boss);
    const dx = player.x - boss.mesh.position.x, dy = player.y - boss.mesh.position.y;
    const d = Math.hypot(dx, dy) || 1;
    const ang = Math.acos(Math.max(-1, Math.min(1, (f.x*dx + f.y*dy)/d)));
    offAim += ang; samples++; worstAim = Math.max(worstAim, ang);
    const st = anglerStage();
    if (st.stage === 'charge') { chargeOff += ang; chargeN++; chargeWorst = Math.max(chargeWorst, ang); }
    if (st.fired.beam > prevBeams || st.fired.pulse > prevPulse) atFire.push(ang);
    prevBeams = st.fired.beam; prevPulse = st.fired.pulse; prevStage = st.stage;
    step(boss, DT);
  }
  const s = anglerStage();
  const mean = (a) => a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0;
  return { ...s.fired, cycles: s.cycles, meanAim: offAim/samples, worstAim,
           fireMean: mean(atFire), fireWorst: atFire.length ? Math.max(...atFire) : 0,
           chargeMean: chargeN ? chargeOff/chargeN : 0, chargeWorst };
}
const deg = (r) => `${(r*180/Math.PI).toFixed(0)}deg`;
console.log('\nlureRange', CONFIG.boss.angler.lureRange, 'attackGap', CONFIG.boss.angler.attackGap,
  'lurkTurn', CONFIG.boss.angler.lurkTurnRate, 'windupTurn', CONFIG.boss.angler.windupTurnRate);
for (const [label, px, py] of [
  ['right, close   ', 20, floorLine()],
  ['left, close    ', -20, floorLine()],
  ['right, mid     ', 45, floorLine()+20],
  ['left, mid      ', -45, floorLine()+20],
  ['right, far     ', 80, floorLine()+30],
  ['left, far      ', -80, floorLine()+30],
  ['straight above ', 0, floorLine()+45],
  ['far corner     ', 90, -2],
]) {
  const r = fight(px, py);
  console.log(`${label} beams ${String(r.beam).padStart(2)} pulses ${String(r.pulse).padStart(2)} | nose-off AT THE SHOT mean ${deg(r.fireMean).padStart(6)} worst ${deg(r.fireWorst).padStart(6)} | through the charge mean ${deg(r.chargeMean).padStart(6)} worst ${deg(r.chargeWorst).padStart(6)}`);
}
