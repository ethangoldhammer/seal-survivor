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
  if (e.def.faceMotion && !e.faceLocked && comesAbout(e.def)) turnFish(e, dt, false);
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
const player = { x: 0, y: 0 };

// ---------------------------------------------------------------------------
section('THE STATES THIS FIGHT ASKS FOR EXIST ON THIS MODEL');
// ---------------------------------------------------------------------------
{
  // Off the MODEL, not the container — the clips ride on what createVisual
  // returned, and `e.mesh` is the Group wrapped round it.
  const clips = boss.visual.userData.clips ?? [];
  const map = ASSETS[KEY].animations ?? {};
  check('the model installed with its takes', clips.length === 7, `${clips.length} clips`);
  // Exactly the states systems/bossAngler.js sets or triggers.
  for (const [state, why] of [
    ['idle', 'the lurk hold'], ['bark', 'the wind-up tell'],
    ['boost', 'the lunge'], ['bite', 'the snap'], ['swim', 'the recovery'],
  ]) {
    const clip = map[state];
    check(`"${state}" (${why}) resolves to a clip`,
      !!clip && clips.some((c) => c.name === clip), clip ? `-> ${clip}` : 'NOT MAPPED');
  }
  check('the def carries the marker the system looks for', isAnglerBoss(boss));
}

// ---------------------------------------------------------------------------
section('THE TELL PEAKS ON THE FRAME THE LUNGE LAUNCHES');
// ---------------------------------------------------------------------------
{
  const w = CONFIG.emissiveCues.windup;
  check('CONFIG.boss.angler.windup equals CONFIG.emissiveCues.windup.attack',
    Math.abs(C().windup - w.attack) < 1e-6, `${C().windup}s vs ${w.attack}s`);
  // The envelope's own shape, independent of the fight: the level at the end
  // of the attack is the peak, and it is well above where it started.
  const peak = cueLevel(w, w.attack);
  const start = cueLevel(w, 0);
  check('the envelope rises to its peak over the attack', peak > start * 3,
    `${start.toFixed(2)} -> ${peak.toFixed(2)}`);
  check('...and the peak is the top of the whole cue',
    peak >= cueLevel(w, w.attack * 0.5) && peak >= (cueLevel(w, cueDuration(w) - 0.001) ?? 0),
    `mid ${cueLevel(w, w.attack * 0.5).toFixed(2)}`);
}

// ---------------------------------------------------------------------------
section('THE CADENCE');
// ---------------------------------------------------------------------------
const trace = [];
{
  attachAngler(scene, boss);
  // ON THE FLOOR, BOTH OF THEM, and that is not scene-setting. The arena clamp
  // is part of a step now (see `step`), so a boss placed at the origin is
  // placed at the WATERLINE and spends the settle sinking 24 units to its
  // resting line — by the time the lurk's timer runs out the seal is 10 units
  // above it and outside `triggerRange`, so it charges the lure instead and no
  // cadence assertion below ever sees a lunge. The animal waits on the bottom;
  // a test of its melee has to start there too.
  at(boss, 0, floorLine()); boss.vx = 0; boss.vy = 0;
  // In range from the first frame, so the lurk exits as soon as it has settled.
  player.x = 6; player.y = floorLine();
  let last = null;
  for (let i = 0; i < 60 * 12; i++) {
    updateBossAngler(DT, scene, player, {});
    const s = anglerStage();
    if (s.stage !== last) { trace.push({ stage: s.stage, at: i * DT, glow: s.emissive }); last = s.stage; }
    step(boss, DT);
  }
  const order = trace.map((t) => t.stage);
  const want = ['lurk', 'windup', 'lunge', 'snap', 'recover', 'lurk'];
  check('it runs lurk -> windup -> lunge -> snap -> recover -> lurk',
    want.every((s, i) => order[i] === s), order.slice(0, 8).join(' -> '));
  check('and it keeps cycling rather than parking in a stage',
    anglerStage().cycles >= 1, `${anglerStage().cycles} full cycles in 12s`);

  const dur = (name) => {
    const i = trace.findIndex((t) => t.stage === name);
    return i >= 0 && trace[i + 1] ? trace[i + 1].at - trace[i].at : null;
  };
  for (const [stage, want2] of [['windup', C().windup], ['lunge', C().lungeTime], ['snap', C().snapTime]]) {
    const got = dur(stage);
    check(`${stage} lasts what the config says`, got != null && Math.abs(got - want2) < 0.05,
      `${got?.toFixed(3)}s vs ${want2}s`);
  }
}

// ---------------------------------------------------------------------------
section('THE LINE IS LOCKED AT THE END OF THE WIND-UP');
// ---------------------------------------------------------------------------
{
  releaseAngler();
  at(boss, 0, floorLine()); boss.vx = 0; boss.vy = 0;
  attachAngler(scene, boss);
  player.x = 6; player.y = floorLine();
  // Run to the moment it commits.
  let committed = null;
  for (let i = 0; i < 60 * 6 && !committed; i++) {
    updateBossAngler(DT, scene, player, {});
    step(boss, DT);
    if (anglerState.stage === 'lunge') committed = { x: anglerState.dirX, y: anglerState.dirY };
  }
  check('it committed to a direction', !!committed,
    committed ? `(${committed.x.toFixed(2)}, ${committed.y.toFixed(2)})` : 'never lunged');
  // Now TELEPORT the player square across the body and keep stepping.
  player.x = 0; player.y = 9;
  const vel = [];
  for (let i = 0; i < 20; i++) {
    updateBossAngler(DT, scene, player, {});
    step(boss, DT);
    if (anglerState.stage === 'lunge') vel.push([boss.vx, boss.vy]);
  }
  const [vx, vy] = vel[vel.length - 1] ?? [0, 0];
  const mag = Math.hypot(vx, vy);
  const dot = mag > 0 ? (vx * committed.x + vy * committed.y) / mag : 0;
  check('the lunge holds the committed line after the player jumps',
    dot > 0.999, `cos to committed dir ${dot.toFixed(4)}`);
  // And the direction it is NOT going: toward where the player now is.
  const toNow = Math.hypot(player.x - boss.mesh.position.x, player.y - boss.mesh.position.y);
  const homingDot = mag > 0 && toNow > 0
    ? (vx * (player.x - boss.mesh.position.x) + vy * (player.y - boss.mesh.position.y)) / (mag * toNow) : 1;
  check('...and is emphatically not homing', homingDot < 0.6,
    `cos to the moved player ${homingDot.toFixed(3)} (1.0 would be perfect homing)`);
  check('the lunge is faster than the cruise', mag > (CONFIG.enemies.bossAnglerfish.speed ?? 4) * 3,
    `${mag.toFixed(1)}u/s vs a ${CONFIG.enemies.bossAnglerfish.speed}u/s cruise`);
}

// ---------------------------------------------------------------------------
section('THE LIGHT SAYS WHAT THE BODY IS DOING');
// ---------------------------------------------------------------------------
{
  releaseAngler();
  at(boss, 0, floorLine());
  attachAngler(scene, boss);
  player.x = 6; player.y = floorLine();
  // MEASURED ONCE EACH STAGE HAS SETTLED, and that is not fussiness. A hold
  // RAMPS onto its level, so the first frames of every stage are still showing
  // the previous one: sampled from frame zero, the lurk's floor is the
  // recovery's 0.15 that it is climbing out of, and the same reading would
  // come back whether or not the recovery ever went dark at all. The window
  // skipped is the longest ramp any hold declares, so one number covers every
  // stage rather than each getting a hand-picked offset.
  const settle = Math.max(...['lurk', 'travel', 'recover'].map((n) => CONFIG.emissiveCues[n].attack ?? 0));
  const byStage = new Map();
  let prev = null;
  let inStage = 0;
  for (let i = 0; i < 60 * 14; i++) {
    updateBossAngler(DT, scene, player, {});
    step(boss, DT);
    const s = anglerStage();
    inStage = s.stage === prev ? inStage + DT : 0;
    prev = s.stage;
    // TWO MEASUREMENTS PER STAGE, because two different claims are made about
    // them and they need different frames. `peak` is over every frame — a spike
    // is a transient and skipping the ramp would skip the whole point of it.
    // `settled` ignores the ramp-in, which is the only way to ask what level a
    // stage RESTS at. Asserting one with the other's number is how the lunge
    // came out dimmer than the wind-up: the commit spike lives entirely inside
    // a window the settled measurement throws away.
    const cur = byStage.get(s.stage) ?? { peak: -Infinity, min: Infinity, max: -Infinity };
    cur.peak = Math.max(cur.peak, s.emissive);
    if (inStage >= settle) {
      cur.min = Math.min(cur.min, s.emissive);
      cur.max = Math.max(cur.max, s.emissive);
    }
    byStage.set(s.stage, cur);
    step(boss, DT);
  }
  const g = (s) => byStage.get(s) ?? { peak: 0, min: 0, max: 0 };
  console.log(`    stage      peak    settled (ignoring each stage's first ${settle.toFixed(2)}s of ramp)`);
  for (const s of ['lurk', 'windup', 'lunge', 'snap', 'recover']) {
    const v = g(s);
    const set = Number.isFinite(v.min) ? `${v.min.toFixed(2)} .. ${v.max.toFixed(2)}` : '(shorter than the ramp — never settles)';
    console.log(`    ${s.padEnd(10)} ${v.peak.toFixed(2).padStart(5)}   ${set}`);
  }
  check('the wind-up is brighter than the lurk', g('windup').peak > g('lurk').peak * 2,
    `peaks at ${g('windup').peak.toFixed(2)} against the lurk's ${g('lurk').peak.toFixed(2)}`);
  check('the commit is the brightest frame of the whole fight',
    g('lunge').peak > g('windup').peak,
    `lunge peaks at ${g('lunge').peak.toFixed(2)}, wind-up at ${g('windup').peak.toFixed(2)}`);
  check('the lunge SETTLES dimmer than its own spike — the spike is punctuation',
    Number.isFinite(g('lunge').max) ? g('lunge').max < g('lunge').peak : true,
    `settles ${Number.isFinite(g('lunge').max) ? g('lunge').max.toFixed(2) : 'n/a'} vs a ${g('lunge').peak.toFixed(2)} spike`);
  check('the recovery goes DARKER than the lurk — the punishable window',
    g('recover').max < g('lurk').min,
    `recovery peaks at ${g('recover').max.toFixed(2)}, below the lurk's ${g('lurk').min.toFixed(2)} trough`);
  check('the lurk throbs rather than sitting still',
    g('lurk').max - g('lurk').min > 0.05, `${(g('lurk').max - g('lurk').min).toFixed(3)} of swing`);
}

// ---------------------------------------------------------------------------
section('ONE BOSS LIGHTS UP, NOT EVERY ANGLERFISH IN THE WATER');
// ---------------------------------------------------------------------------
{
  const a = createVisual(KEY);
  const b = createVisual(KEY);
  const matsOf = (root) => { const out = []; root.traverse((o) => { if (o.isMesh) out.push(...[].concat(o.material)); }); return out; };
  const beforeB = matsOf(b).map((m) => m.emissiveIntensity);
  const cues = attachEmissiveCues(a);
  check('the handle attached to a model that has an emissive channel', !!cues);
  cues.hold('travel');
  cues.update(0.016);
  const afterA = matsOf(a).map((m) => m.emissiveIntensity);
  const afterB = matsOf(b).map((m) => m.emissiveIntensity);
  check('the cued instance changed', afterA.some((v, i) => v !== beforeB[i]),
    `${afterA[0]?.toFixed(2)} vs a resting ${beforeB[0]?.toFixed(2)}`);
  check('the other instance did not move a single material',
    afterB.every((v, i) => v === beforeB[i]),
    `${afterB.filter((v, i) => v !== beforeB[i]).length} of ${afterB.length} drifted`);
  // And the materials really are separate objects, not the same one twice.
  const shared = matsOf(a).filter((m) => matsOf(b).includes(m));
  check('...because they are not the same material object', shared.length === 0,
    `${shared.length} shared`);
  cues.release();
  check('release puts the borrowed materials back',
    matsOf(a).every((m) => m.emissiveIntensity === (m.userData.__cueBase ?? 1)));
}

// ---------------------------------------------------------------------------
section('THE HANDBACK');
// ---------------------------------------------------------------------------
{
  releaseAngler();
  at(boss, 0, floorLine());
  boss.contactDamage = CONFIG.enemies.bossAnglerfish.contactDamage;
  const base = boss.contactDamage;
  attachAngler(scene, boss);
  player.x = 6; player.y = floorLine();
  // Kill it mid-lunge, the worst moment: contact damage is multiplied and the
  // locomotion state is pinned.
  for (let i = 0; i < 60 * 6; i++) {
    updateBossAngler(DT, scene, player, {});
    step(boss, DT);
    if (anglerState.stage === 'lunge') break;
  }
  check('contact damage is multiplied while committed',
    boss.contactDamage === base * C().lungeDamage, `${boss.contactDamage} vs a base of ${base}`);
  check('the locomotion state is pinned to the lunge', boss.animState === 'boost', boss.animState);
  releaseAngler();
  check('release gives the contact damage back', boss.contactDamage === base, `${boss.contactDamage}`);
  check('release unpins the locomotion state', boss.animState === null, String(boss.animState));
  check('release hands the wheel back', boss.perkDrive === false);
}

// ---------------------------------------------------------------------------
section('A PERK MID-DASH OWNS THE BODY');
// ---------------------------------------------------------------------------
{
  releaseAngler();
  at(boss, 0, floorLine()); boss.vx = 0; boss.vy = 0;
  boss.contactDamage = CONFIG.enemies.bossAnglerfish.contactDamage;
  attachAngler(scene, boss);
  player.x = 6; player.y = floorLine();
  for (let i = 0; i < 60 * 6; i++) {
    updateBossAngler(DT, scene, player, {});
    step(boss, DT);
    if (anglerState.stage === 'lunge') break;
  }
  const wasLunging = anglerState.stage === 'lunge';
  // Stand a perk up in front of it. activeBossPerk() reads the module's own
  // state, so this drives the real one rather than stubbing the import.
  const perks = await import('../path/src/systems/bossPerks.js');
  const live = perks.activeBossPerk();
  check('the harness reached the real perk state', live !== undefined);
  // With no perk running, the ambush must be the thing moving the body.
  boss.vx = 0; boss.vy = 0;
  updateBossAngler(DT, scene, player, {});
  step(boss, DT);
  check('with no perk active the ambush drives the body',
    wasLunging && Math.hypot(boss.vx, boss.vy) > 1,
    `${Math.hypot(boss.vx, boss.vy).toFixed(1)}u/s`);
  releaseAngler();
}

// ---------------------------------------------------------------------------
section('A HIT BITES THE LURE BRIGHT');
// ---------------------------------------------------------------------------
{
  releaseAngler();
  at(boss, 0, floorLine());
  boss.hp = 1000; boss.maxHp = 1000;
  attachAngler(scene, boss);
  // Out of range of BOTH cadences, so the fight stays in the lurk and the only
  // thing that can move the light is the damage. `lureRange` and not
  // triggerRange: inside the lure's reach the animal charges, and a charge is a
  // 16x envelope climbing over the top of exactly the flash being measured —
  // which reads here as the hit having dimmed the lure.
  player.x = CONFIG.boss.angler.lureRange + 10; player.y = floorLine();
  for (let i = 0; i < 120; i++) updateBossAngler(DT, scene, player, {});
  const calm = anglerStage().emissive;
  boss.hp -= 1000 * (CONFIG.boss.angler.hurtDamage * 3);
  updateBossAngler(DT, scene, player, {});
  step(boss, DT);
  const bitten = anglerStage().emissive;
  check('a real hit flashes the lure', bitten > calm * 1.5,
    `x${calm.toFixed(2)} lurking -> x${bitten.toFixed(2)} hit`);
  check('...and it stays in the lurk rather than being provoked into a lunge',
    anglerStage().stage === 'lurk', anglerStage().stage);
  // A scratch must not. Otherwise the lure strobes through a beam weapon and
  // the tell stops meaning anything.
  for (let i = 0; i < 120; i++) updateBossAngler(DT, scene, player, {});
  const settled = anglerStage().emissive;
  boss.hp -= 1000 * (CONFIG.boss.angler.hurtDamage * 0.2);
  updateBossAngler(DT, scene, player, {});
  step(boss, DT);
  check('a scratch does not', anglerStage().emissive <= settled * 1.2,
    `x${settled.toFixed(2)} -> x${anglerStage().emissive.toFixed(2)}`);
  releaseAngler();
}

// ---------------------------------------------------------------------------
section('THE REAL SPAWN — through forceBoss, on a record the game built');
// ---------------------------------------------------------------------------
// Every section above drives a stand-in. This one drives the actual arrival:
// forceBoss runs the size step, the enemy lookup, the clear-out, the perk
// attach and the name roll, so what comes back is the record the arena gets.
//
// IT EXISTS BECAUSE THE STUB LIED. The fight read `e.x`, a field no enemy
// record has, and every assertion above still passed — the stub had been given
// one. In the game that was undefined -> NaN velocity -> a boss with no
// position, invisible, with nothing logged anywhere. The check that matters is
// therefore not "does a stage advance" but "is the body still a finite
// distance from the origin after a few seconds of the real thing".
{
  const { forceBoss, bossState } = await import('../path/src/systems/boss.js');
  const { enemies, updateEnemies } = await import('../path/src/entities/enemies.js');
  const liveScene = new THREE.Scene();
  const spawned = forceBoss(liveScene, { level: 12, running: true, difficulty: 1 },
    { boss: 'bossAnglerfish', perk: null });

  check('forceBoss put an anglerfish in the water',
    !!spawned && spawned.type === 'bossAnglerfish', spawned ? spawned.type : 'nothing');
  check('...and the boss system adopted it', bossState.archetype?.id === 'bossAnglerfish',
    bossState.archetype?.id ?? 'null');
  check('the record has NO x/y of its own — position is the mesh\'s',
    spawned && spawned.x === undefined && spawned.y === undefined,
    `x=${spawned?.x} y=${spawned?.y}`);

  if (spawned) {
    const start = spawned.mesh.position.clone();
    const who = { x: start.x + 4, y: start.y };
    let worstJump = 0;
    let prev = start.clone();
    for (let i = 0; i < 60 * 8; i++) {
      updateBossAngler(DT, liveScene, who, {});
      // The integrator, standing in for updateEnemies' step.
      spawned.mesh.position.x += spawned.vx * DT;
      spawned.mesh.position.y += spawned.vy * DT;
      worstJump = Math.max(worstJump, prev.distanceTo(spawned.mesh.position));
      prev.copy(spawned.mesh.position);
    }
    const p = spawned.mesh.position;
    check('the boss still has a finite position after 8s of the real fight',
      Number.isFinite(p.x) && Number.isFinite(p.y), `(${p.x}, ${p.y})`);
    check('...and a finite velocity',
      Number.isFinite(spawned.vx) && Number.isFinite(spawned.vy),
      `(${spawned.vx}, ${spawned.vy})`);
    check('it has not been flung out of the arena',
      Math.hypot(p.x, p.y) < 400, `${Math.hypot(p.x, p.y).toFixed(1)} units from the origin`);
    check('no single frame teleported it', worstJump < 2,
      `worst step ${worstJump.toFixed(3)} units`);
    check('the ambush actually ran on the real body', anglerStage().cycles >= 1,
      `${anglerStage().cycles} cycles`);
    check('the boss is visible', spawned.mesh.visible !== false);
  }
  releaseAngler();
}

// ---------------------------------------------------------------------------
section('THE LURE ACTUALLY BLOOMS');
// ---------------------------------------------------------------------------
// The check that was missing, and the reason the tell shipped invisible.
//
// Every earlier section asserts the envelope's SHAPE — that the wind-up is
// brighter than the lurk, that the recovery is darker. All of that was true of
// a first draft whose entire range sat under CONFIG.bloom.threshold, so the
// lure never crossed into the bright pass and the boss simply had no light on
// it. A relative check cannot catch an absolute failure.
//
// What turns emissiveIntensity into a scene value is the emissive MAP, so its
// peak is measured off the glb here rather than assumed — a re-export that
// darkens the esca fails this instead of quietly un-lighting the boss.
{
  // A SUBPROCESS, because `sharp` is native CJS and will not load under
  // tools/vite-loader.mjs — see the header of tools/emissive-peak.mjs.
  const probe = JSON.parse(execFileSync('node',
    [resolve(HERE, 'emissive-peak.mjs'), modelPath], { encoding: 'utf8' }));
  const mapPeak = probe.peak;
  const thr = CONFIG.bloom.threshold;
  console.log(`    emissive map peak luminance ${mapPeak.toFixed(3)} · bloom threshold ${thr} · full bloom at ${(thr + 0.25).toFixed(2)}`);
  check('the emissive map has a genuinely bright esca to drive',
    mapPeak > 0.8, `peak ${mapPeak.toFixed(3)}`);

  // Scene luminance the lure reaches at each cue = level x map peak.
  const onScreen = (name) => (CONFIG.emissiveCues[name].to ?? 1) * mapPeak;
  for (const [name, why] of [['lurk', 'the state it spends most of the fight in'],
                             ['travel', 'the thing you are dodging']]) {
    check(`${name} clears the bloom threshold — ${why}`,
      onScreen(name) > thr + 0.25,
      `${onScreen(name).toFixed(2)} on screen vs a ${thr} threshold`);
  }
  const commitPeak = (CONFIG.emissiveCues.commit.to ?? 1) * mapPeak;
  check('the commit is as bright as the brightest thing in the game',
    commitPeak >= 18, `${commitPeak.toFixed(2)} against the lantern skin's 18.70 (npm run glow)`);
  // The one that must NOT bloom.
  check('the recovery falls UNDER the threshold — the light is out, not dim',
    onScreen('recover') < thr,
    `${onScreen('recover').toFixed(2)} vs a ${thr} threshold`);
  check('...and the lurk throb never dips under it either',
    ((CONFIG.emissiveCues.lurk.to ?? 1) - (CONFIG.emissiveCues.lurk.throbDepth ?? 0)) * mapPeak > thr + 0.25,
    `trough ${(((CONFIG.emissiveCues.lurk.to ?? 1) - (CONFIG.emissiveCues.lurk.throbDepth ?? 0)) * mapPeak).toFixed(2)}`);
}

// ---------------------------------------------------------------------------
section('IT HOLDS STATION, AND IT LOOKS AT YOU WHILE IT DOES');
// ---------------------------------------------------------------------------
// The other shipped bug. `faceMotion` only writes the heading above 0.05 u/s,
// so the first version crept at the player to stay aimed — and therefore swam
// at you for the whole fight instead of ambushing. An ambusher that closes the
// distance is a chaser with extra steps.
{
  releaseAngler();
  // ON THE FLOOR, which is where this animal waits — see holdFloor. Started at
  // the origin (the waterline) it would spend the whole measurement sinking
  // 31 units to its resting line, and every check below would read that as the
  // ambusher swimming somewhere.
  at(boss, 0, floorLine()); boss.vx = 0; boss.vy = 0;
  boss.hp = boss.maxHp;
  attachAngler(scene, boss);
  // OUTSIDE `lureRange`, not merely outside triggerRange — the fight has two
  // ranges now and only the outer one means "it will not start". Inside the
  // lure's reach it does not lurk indefinitely, it charges, which is the whole
  // point of the two attacks below and would look exactly like this test
  // failing.
  player.x = CONFIG.boss.angler.lureRange + 10; player.y = floorLine();
  const start = boss.mesh.position.clone();
  let drift = 0;
  for (let i = 0; i < 60 * 10; i++) {
    updateBossAngler(DT, scene, player, {});
    step(boss, DT);
    drift = Math.max(drift, start.distanceTo(boss.mesh.position));
  }
  check('it stays in the lurk while you keep your distance',
    anglerStage().stage === 'lurk', anglerStage().stage);
  check('it holds its station rather than swimming at you',
    drift < 0.5, `drifted ${drift.toFixed(3)} units in 10s`);
  check('...and its speed really is under the faceMotion gate, so nothing fights it',
    Math.hypot(boss.vx, boss.vy) < 0.05, `${Math.hypot(boss.vx, boss.vy).toFixed(4)} u/s`);

  // Now put the player somewhere else and watch it turn to look.
  //
  // MEASURED OFF THE COMPOSED NOSE, not off `mesh.rotation.z`. The come-about
  // spreads the pose over a yaw, a pitch and a bank (see systems/fishTurn.js)
  // and rotation.z is only the pitch — against a seal on the left it reads a
  // perfectly aimed fish as PI off, because the side it is aimed from lives on
  // a different axis. The forward vector is the animal either way and cannot go
  // stale when the decomposition next changes.
  const facingErr = () => {
    const f = forwardOf(boss);
    const dx = player.x - boss.mesh.position.x;
    const dy = player.y - boss.mesh.position.y;
    const d = Math.hypot(dx, dy) || 1;
    return Math.acos(Math.min(1, Math.max(-1, (f.x * dx + f.y * dy) / d)));
  };
  player.x = -(CONFIG.boss.angler.lureRange + 10); player.y = floorLine() + 12;
  const before = facingErr();
  for (let i = 0; i < 60 * 6; i++) { updateBossAngler(DT, scene, player, {}); step(boss, DT); }
  const after = facingErr();
  check('it turns to face a player who moved behind it',
    after < 0.12, `${(before * 180 / Math.PI).toFixed(0)}° off -> ${(after * 180 / Math.PI).toFixed(1)}°`);
  check('...without translating to do it',
    start.distanceTo(boss.mesh.position) < 0.5, `${start.distanceTo(boss.mesh.position).toFixed(3)} units`);
  // AND THE TURN IS RATE-LIMITED, not a snap — that is what makes circling work.
  //
  // MEASURED AS A DURATION rather than as one frame's step, and the difference
  // is the mechanism rather than the taste. No single number on the object is
  // the heading any more: the pose is a yaw, a pitch and a bank composed across
  // two objects (systems/fishTurn.js), so writing one of them by hand and
  // stepping once measures the composition re-deriving itself from state the
  // write did not touch — an enormous instantaneous rate on a fish that is
  // turning perfectly smoothly.
  //
  // What the check was always about survives intact: a HALF TURN takes about
  // PI / lurkTurnRate seconds, which is 3.5 at the shipped 0.9 — long enough
  // that a player can swim round behind it, which is the whole counterplay.
  // That number reaches the come-about as `turnAim.time`, so this is also what
  // holds the ambush's two turn rates to meaning something once the aiming and
  // the turning live in different files. Per-frame smoothness is asserted
  // properly, against a derived ceiling, in IT IS NEVER UPSIDE DOWN below.
  releaseAngler();
  at(boss, 0, floorLine());
  boss.mesh.rotation.set(0, 0, 0);
  boss.visual.rotation.set(0, 0, 0);
  delete boss.visual.userData.__face;
  // The come-about's state, so the reversal below is timed from a fish that has
  // just arrived rather than from one holding a heading out of the last run.
  delete boss.__turnYaw;
  attachAngler(scene, boss);
  // Straight out to one side and out of the lure's reach, so what is being
  // timed is a lurk turn rather than a wind-up's — the two have different rates
  // on purpose and timing one against the other would pass on a boss that had
  // stopped lurking entirely.
  const out = CONFIG.boss.angler.lureRange + 10;
  player.x = out; player.y = floorLine();
  for (let i = 0; i < 60 * 8; i++) { updateBossAngler(DT, scene, player, {}); step(boss, DT); }
  check('it has settled looking one way', facingErr() < 0.05,
    `${(facingErr() * 180 / Math.PI).toFixed(1)} degrees off`);
  // ...and now the seal is on the other side. A full reversal.
  player.x = -out;
  let took = null;
  for (let i = 0; i < 60 * 15 && took == null; i++) {
    updateBossAngler(DT, scene, player, {});
    step(boss, DT);
    if (facingErr() < 0.05) took = (i + 1) * DT;
  }
  const half = Math.PI / CONFIG.boss.angler.lurkTurnRate;
  check('a reversal takes about a half turn at the lurk rate',
    took != null && Math.abs(took - half) < half * 0.35,
    `${took == null ? 'never got there' : `${took.toFixed(2)}s`} against ${half.toFixed(2)}s`);
  check('...which is slow enough to swim round behind it', took > 1.5,
    `${took?.toFixed(2)}s`);
  releaseAngler();
}

// ---------------------------------------------------------------------------
section('IT DOES NOT WAIT INSIDE THE WALL');
// ---------------------------------------------------------------------------
// The one bug the "holds station" section cannot catch, because holding
// station is exactly what it does wrong.
//
// WHERE THE ANIMAL COMES FROM. `deepSpawn` is set on this def, so an
// anglerfish always rises out of the seabed rather than swimming in from a
// wing — and the deep entrance rolls its x flat across the whole arena
// (edgeSpawnPoint in entities/enemies.js), with nothing keeping it off a wall.
// On a body of radius ~7.9 in a 185-unit arena that is better than one arrival
// in ten surfacing with its flank already inside the drawn rock.
//
// WHY IT THEN STAYS THERE. Every other archetype swims at the seal the moment
// it arrives, so a bad start position costs it a second. This one lurks, and
// the lurk is a dead stop — so it held that position for the whole fight, half
// buried in the cliff, unreachable until the player swam into the wall to find
// it. Measured before the fix: 100% of sixty seconds against the wall with the
// seal parked in mid-ocean. The recovery's station is the same bug with a
// different cause — it is a ring around the PLAYER, so with the seal near a
// wall most of it is out past the rock, and the fish drove at a point the
// arena clamp would never let it reach.
//
// Driven through the REAL integrator — updateEnemies and updateBoss — because
// the clamp that pins it lives in entities/enemies.js and a stand-in stepped
// by hand has no walls at all. The body is PUT on the wall rather than the
// dice being wrestled into putting it there: the fix is about what the animal
// does once it is against the rock, and how it got there is the other half of
// the story, asserted separately just below.
// ---------------------------------------------------------------------------
{
  const { bounds, updateBounds } = await import('../path/src/arena.js');
  const { createWallRocks } = await import('../path/src/systems/wallRocks.js');
  const { resetEnemies, updateEnemies } = await import('../path/src/entities/enemies.js');
  const { forceBoss, resetBoss, updateBoss, updateBossAbilities, bossState } =
    await import('../path/src/systems/boss.js');

  updateBounds(16 / 9);
  const liveScene = new THREE.Scene();
  createWallRocks(liveScene).build();
  const quiet = () => {};

  function arrive(playerX) {
    resetEnemies(liveScene);
    resetBoss(liveScene);
    releaseAngler();
    const gameState = { difficulty: 5, level: 12, running: true };
    const who = { x: playerX, y: -12, z: 0 };
    const boss = forceBoss(liveScene, gameState, { boss: 'bossAnglerfish', perk: null });
    // Read BEFORE the approach: `deep` is the entrance and the entrance clears
    // it the moment the body is out of the seabed, so asking afterwards asks a
    // question about the past and gets today's answer.
    const cameFromTheDeep = !!boss?.deep;
    let t = 0;
    while (boss && bossState.approaching && t < 20) {
      updateEnemies(DT, liveScene, who, quiet, quiet);
      updateBoss(DT, gameState, liveScene);
      t += DT;
    }
    return { boss, who, gameState, cameFromTheDeep };
  }

  function fight({ boss, who, gameState }, seconds) {
    const wall = bounds.right - boss.radius;
    let inWall = 0;
    let frames = 0;
    for (let i = 0; i < 60 * seconds; i++) {
      updateEnemies(DT, liveScene, who, quiet, quiet);
      updateBoss(DT, gameState, liveScene);
      updateBossAbilities(DT, liveScene, who, {});
      if (Math.abs(boss.mesh.position.x) > wall - 0.25) inWall++;
      frames++;
    }
    return {
      wall,
      x: boss.mesh.position.x,
      inWall: inWall / frames,
      clear: Math.abs(Math.abs(boss.mesh.position.x) - wall),
    };
  }

  // THE SOURCE, asserted rather than described: the entrance really can put
  // this body inside the wall. If deepSpawn is ever taken off the def, or the
  // deep roll learns to keep clear of a wall, this stops being true and the
  // note above stops being the reason — which is worth being told about.
  {
    const run = arrive(0);
    // WHICH ENTRANCE is reported rather than asserted, because both of them
    // land it here: `deepSpawn` rolls the x flat across the arena with nothing
    // keeping it off a wall, and a wing entrance hands over at exactly
    // bounds.right - radius. Pinning the test to one of them would fail the
    // day the def changes, over a difference that does not matter to the bug.
    console.log(`    entrance: ${run.cameFromTheDeep ? 'up out of the seabed (deepSpawn)' : 'in from a wall'}`);
    const half = bounds.right;
    const r = run.boss?.radius ?? 0;
    check('the entrance can leave this body inside the rock',
      r > 0 && r / half > 0.05,
      `radius ${r.toFixed(1)} against a half-arena of ${half.toFixed(1)} — ${(100 * r / half).toFixed(0)}% of a flat roll lands a flank in the wall`);
  }

  for (const side of [1, -1]) {
    const w = side > 0 ? 'right' : 'left';
    const run = arrive(0);
    if (!run.boss) { check('a boss was put in the water', false); continue; }
    // Exactly where the arena clamp holds a body that has been driven into the
    // wall — the position the bug left it in, reached the way the bug reached
    // it rather than an arbitrary teleport.
    run.boss.mesh.position.x = side * (bounds.right - run.boss.radius);
    const r = fight(run, 60);
    check(`parked in the ${w} wall with the seal in open water, it does not stay there`,
      r.inWall < 0.05, `${(r.inWall * 100).toFixed(0)}% of 60s against the wall`);
    check('...it backs out into water it can be fought in',
      r.clear > run.boss.radius * 0.3,
      `${r.clear.toFixed(1)} units off the wall, on a body of radius ${run.boss.radius.toFixed(1)}`);
    check('...and it is still lurking rather than having wandered off hunting',
      anglerStage().stage === 'lurk' || anglerStage().cycles > 0, anglerStage().stage);
  }

  // AND WITH THE SEAL IN THE CORNER, which is the station half: the recovery
  // picks a point at `stationRange` from the PLAYER, so with the seal at a wall
  // most of that ring is out past the rock and the fish drove at a target the
  // arena clamp would never let it reach.
  //
  // A LOOSE THRESHOLD ON PURPOSE. The fish comes over and fights, and a lunge
  // at a seal in the corner ends with the animal legitimately against the wall
  // for the run, the snap and the follow-through — a tight bound here would be
  // a test of the cadence's timings rather than of the station. What it is
  // catching is the pre-fix reading, which was 100%: the animal never left.
  for (const px of [1, -1]) {
    const run = arrive(px * (bounds.right - 6));
    if (!run.boss) continue;
    const r = fight(run, 45);
    check(`with the seal against the ${px > 0 ? 'right' : 'left'} wall, it still spends the fight in open water`,
      r.inWall < 0.5, `${(r.inWall * 100).toFixed(0)}% of 45s at the wall`);
  }

  releaseAngler();
  resetEnemies(liveScene);
  resetBoss(liveScene);
}

// ---------------------------------------------------------------------------
section('IT COMES UP OUT OF THE DEEP');
// ---------------------------------------------------------------------------
// The entrance is the first thing a player learns about a boss, and for this
// one it is half the character. Rolled, two arrivals in three came in along a
// wing at a random depth — an ambush predator announcing itself from the side
// of the screen, which gives away the only thing it had.
//
// ASSERTED OVER MANY ROLLS, not once. edgeSpawnPoint is random and a single
// call landing on `deep` proves nothing: the un-flagged path already takes that
// branch one time in ten, so a test that rolled once would pass on the bug.
{
  const { __spawnPointForTest } = await import('../path/src/entities/enemies.js');
  if (typeof __spawnPointForTest !== 'function') {
    check('entities/enemies.js exposes its spawn point picker for this test', false,
      'no __spawnPointForTest export');
  } else {
    const def = CONFIG.enemies.bossAnglerfish;
    check('the def asks for the deep entrance', def.deepSpawn === true, String(def.deepSpawn));
    let deep = 0;
    for (let i = 0; i < 400; i++) if (__spawnPointForTest(def).deep) deep++;
    check('every roll comes from the deep', deep === 400, `${deep}/400`);
    // ...and the control: an ordinary swimmer still gets the mixed entrance, so
    // what is being measured is the flag rather than the picker having been
    // hard-wired.
    let otherDeep = 0;
    const other = CONFIG.enemies.bossShark ?? CONFIG.enemies.bossOrca;
    for (let i = 0; i < 400; i++) if (__spawnPointForTest(other).deep) otherDeep++;
    check('...and a boss without the flag still mostly comes in from a wing',
      otherDeep > 0 && otherDeep < 200, `${otherDeep}/400 deep`);
  }
}

// ---------------------------------------------------------------------------
section('IT HOLDS THE BOTTOM');
// ---------------------------------------------------------------------------
// The floor is what makes the arena vertical: the surface is safe, the trap is
// the seabed, and a run is spent deciding how far down to go. Two claims, and
// the second is the one that breaks quietly — an animal that sinks and then
// bounces is one whose hold is fighting the wall-escape latch, and every frame
// of that looks deliberate.
{
  releaseAngler();
  at(boss, 0, bounds.surfaceY - boss.radius);
  boss.vx = 0; boss.vy = 0; boss.hp = boss.maxHp;
  boss.deep = false; boss.entering = false;
  attachAngler(scene, boss);
  // Out of both ranges, so nothing but the hold is moving the body.
  player.x = CONFIG.boss.angler.lureRange + 12; player.y = bounds.surfaceY - 2;
  const want = floorLine();
  let settledAt = null;
  for (let i = 0; i < 60 * 20; i++) {
    updateBossAngler(DT, scene, player, {});
    step(boss, DT);
    if (settledAt == null && Math.abs(boss.mesh.position.y - want) < 0.3) settledAt = i * DT;
  }
  check('a fish dropped at the surface settles onto the floor', settledAt != null,
    settledAt != null ? `${settledAt.toFixed(1)}s to reach ${want.toFixed(1)}` : `stuck at y=${boss.mesh.position.y.toFixed(1)}`);
  check('...and is still there twenty seconds later',
    Math.abs(boss.mesh.position.y - want) < 0.6,
    `y=${boss.mesh.position.y.toFixed(2)} vs a floor line of ${want.toFixed(2)}`);
  // NOT BOBBING. Sampled over the last five seconds, well after the settle, so
  // what is measured is the resting state rather than the approach to it.
  let lo = Infinity; let hi = -Infinity;
  for (let i = 0; i < 60 * 5; i++) {
    updateBossAngler(DT, scene, player, {});
    step(boss, DT);
    lo = Math.min(lo, boss.mesh.position.y);
    hi = Math.max(hi, boss.mesh.position.y);
  }
  check('...and it rests rather than bobbing between the hold and the escape',
    hi - lo < 0.5, `${(hi - lo).toFixed(3)} units of swing over 5s`);
  // The floor line is genuinely low: the body is sitting on the seabed and not
  // hovering in midwater with the number merely agreeing with itself.
  check('the floor line really is on the bottom',
    want < seabedTopY() + boss.radius + 1,
    `y=${want.toFixed(1)}, seabed top ${seabedTopY().toFixed(1)}, radius ${boss.radius.toFixed(1)}`);
  releaseAngler();
}

// ---------------------------------------------------------------------------
section('THE LURE PICKS ITS ATTACK BY DISTANCE, AND SAYS SO FIRST');
// ---------------------------------------------------------------------------
// Three ranges, three answers: bite, hold, zap. It is the whole lesson of the
// fight, and the thing that would break it is a random pick — the same position
// meaning two things is the one thing a fight built out of reading the animal
// cannot afford.
{
  const C2 = () => CONFIG.boss.angler;
  check('CONFIG.boss.angler.chargeTime equals CONFIG.emissiveCues.charge.attack',
    Math.abs(C2().chargeTime - CONFIG.emissiveCues.charge.attack) < 1e-6,
    `${C2().chargeTime}s vs ${CONFIG.emissiveCues.charge.attack}s`);
  check('the charge is a longer tell than the lunge wind-up',
    C2().chargeTime > C2().windup, `${C2().chargeTime}s vs ${C2().windup}s`);
  check('the beam has a band of its own to live in',
    C2().pulseRadius * C2().pulsePick < C2().lureRange,
    `radial out to ${(C2().pulseRadius * C2().pulsePick).toFixed(1)}, lure range ${C2().lureRange}`);
  check('the lure gap outlasts the stages it has to cover',
    C2().attackGap > C2().recoverTime + C2().dischargeTime + CONFIG.emissiveCues.lurk.attack,
    `${C2().attackGap}s against ${(C2().recoverTime + C2().dischargeTime + CONFIG.emissiveCues.lurk.attack).toFixed(2)}s of stages`);

  // Drive it for real at three ranges and see what it actually throws.
  const runAt = (dist, seconds = 26) => {
    releaseAngler();
    resetBeams(scene);
    at(boss, 0, floorLine()); boss.vx = 0; boss.vy = 0;
    boss.hp = boss.maxHp; boss.deep = false; boss.entering = false;
    boss.contactDamage = CONFIG.enemies.bossAnglerfish.contactDamage;
    attachAngler(scene, boss);
    const snares = [];
    const hits = [];
    const hooks = {
      onPlayerSnare: (sec, mul, thaw) => snares.push({ sec, mul, thaw }),
      onPlayerHit: (dmg, dir, source) => hits.push({ dmg, source }),
    };
    // The seal is PINNED at the range being tested — it does not swim, so the
    // only thing deciding which attack comes out is the distance.
    for (let i = 0; i < 60 * seconds; i++) {
      player.x = boss.mesh.position.x + dist; player.y = boss.mesh.position.y;
      updateBossAngler(DT, scene, player, hooks);
      step(boss, DT);
    }
    return { fired: { ...anglerState.fired }, snares, hits };
  };

  const close = runAt(CONFIG.boss.angler.triggerRange * 0.7);
  check('inside the bite range it lunges rather than reaching for the lure',
    close.fired.lunge > 0 && close.fired.beam === 0,
    `lunge x${close.fired.lunge}, pulse x${close.fired.pulse}, beam x${close.fired.beam}`);

  // THE MIDDLE OF THE HOLD BAND, derived rather than typed. The band is
  // `triggerRange`..`pulseRadius * pulsePick` and it is only nine units wide —
  // a hand-picked number would be a test that silently starts measuring the
  // lunge the next time either end of it moves.
  const mid = runAt(
    (CONFIG.boss.angler.triggerRange + CONFIG.boss.angler.pulseRadius * CONFIG.boss.angler.pulsePick) / 2,
  );
  check('too far to bite but inside the radial, it holds you',
    mid.fired.pulse > 0 && mid.fired.beam === 0,
    `lunge x${mid.fired.lunge}, pulse x${mid.fired.pulse}, beam x${mid.fired.beam}`);
  check('...and the seal caught in it is actually snared', mid.snares.length > 0,
    `${mid.snares.length} snares`);
  check('...for about as long as the config says',
    mid.snares.every((s) => Math.abs(s.sec - CONFIG.boss.angler.pulseSnare) < 1e-6),
    mid.snares.map((s) => s.sec).join(', '));
  check('...and the hold leaves the seal SOME of its own swimming',
    mid.snares.every((s) => s.mul > 0 && s.mul < 0.5),
    `mul ${mid.snares[0]?.mul}`);
  check('...and the radial deals its damage under its own source name',
    mid.hits.some((h) => h.source === 'boss:anglerPulse'),
    mid.hits.map((h) => h.source).join(', ') || 'no hits');
  check('...which starts with "boss", so the damage ceilings apply to it',
    mid.hits.every((h) => String(h.source).startsWith('boss')),
    mid.hits.map((h) => h.source).join(', ') || 'no hits');

  const far = runAt(CONFIG.boss.angler.lureRange * 0.85);
  check('out past the radial it uses the beam',
    far.fired.beam > 0 && far.fired.pulse === 0,
    `lunge x${far.fired.lunge}, pulse x${far.fired.pulse}, beam x${far.fired.beam}`);

  const gone = runAt(CONFIG.boss.angler.lureRange + 12);
  check('past the lure range it does nothing at all — you can always leave',
    gone.fired.beam === 0 && gone.fired.pulse === 0 && gone.fired.lunge === 0,
    `lunge x${gone.fired.lunge}, pulse x${gone.fired.pulse}, beam x${gone.fired.beam}`);
  releaseAngler();
  resetBeams(scene);
}

// ---------------------------------------------------------------------------
section('THE RADIAL ONLY REACHES AS FAR AS IT SAYS IT DOES');
// ---------------------------------------------------------------------------
// The ring is drawn AT pulseRadius. A hold that reached further than the circle
// would be the boss cheating; one that reached less would be a tell that lies
// in the other direction, which is worse — the player learns the wrong edge and
// then gets caught at it.
{
  // A seal that stands just inside the reach and one that steps just outside
  // it, on runs identical in every other respect.
  const probe = (frac) => {
    releaseAngler();
    at(boss, 0, floorLine()); boss.vx = 0; boss.vy = 0;
    boss.hp = boss.maxHp; boss.deep = false; boss.entering = false;
    attachAngler(scene, boss);
    let snared = 0;
    const hooks = { onPlayerSnare: () => { snared++; }, onPlayerHit: () => {} };
    // Charged from inside the pick band so the RADIAL is what gets loaded, then
    // the seal is moved to the range being probed before it lands. That is the
    // honest test: the attack is chosen from where you were and lands on where
    // you are, and both halves have to be true.
    let fired = false;
    for (let i = 0; i < 60 * 20 && !fired; i++) {
      const d = anglerState.stage === 'charge'
        ? CONFIG.boss.angler.pulseRadius * frac
        : (CONFIG.boss.angler.triggerRange
           + CONFIG.boss.angler.pulseRadius * CONFIG.boss.angler.pulsePick) / 2;
      player.x = boss.mesh.position.x + d; player.y = boss.mesh.position.y;
      updateBossAngler(DT, scene, player, hooks);
      step(boss, DT);
      if (anglerState.fired.pulse > 0) fired = true;
    }
    return { fired, snared };
  };
  const inside = probe(0.7);
  check('a seal inside the circle is caught', inside.fired && inside.snared > 0,
    `fired ${inside.fired}, ${inside.snared} snares`);
  const outside = probe(1.4);
  check('a seal outside it is not', outside.fired && outside.snared === 0,
    `fired ${outside.fired}, ${outside.snared} snares`);
  releaseAngler();
}

// ---------------------------------------------------------------------------
section('THE BEAM LEAVES THE LURE, AND DOES NOT FOLLOW YOU');
// ---------------------------------------------------------------------------
// The lunge's rule, for the lunge's reason. A homing beam is not a fight, it is
// a tax on having been seen — and a beam born at the animal's middle is one the
// player cannot connect to the light that was charging at them.
{
  releaseAngler();
  resetBeams(scene);
  at(boss, 0, floorLine()); boss.vx = 0; boss.vy = 0;
  boss.hp = boss.maxHp; boss.deep = false; boss.entering = false;
  attachAngler(scene, boss);
  const range = CONFIG.boss.angler.lureRange * 0.8;
  player.x = range; player.y = floorLine();
  let lit = null;
  for (let i = 0; i < 60 * 20 && !lit; i++) {
    updateBossAngler(DT, scene, player, { onPlayerHit: () => {}, onPlayerSnare: () => {} });
    step(boss, DT);
    if (beams.length) lit = beams[beams.length - 1];
  }
  check('a beam was lit', !!lit, lit ? `${beams.length} live` : 'none in 20s');
  if (lit) {
    check('it hits the player and not the wildlife',
      lit.hitsPlayer === true && lit.hitsEnemies === false,
      `hitsPlayer=${lit.hitsPlayer} hitsEnemies=${lit.hitsEnemies}`);
    check('its source is a boss source, so the damage ceilings apply',
      String(lit.source).startsWith('boss'), lit.source);
    check('it is worth a multiple of what this body hits for',
      Math.abs(lit.damage - CONFIG.enemies.bossAnglerfish.contactDamage * CONFIG.boss.angler.beamDamage) < 1e-6,
      `${lit.damage} vs contact ${CONFIG.enemies.bossAnglerfish.contactDamage}`);
    check('it has a per-target cooldown, so it is not sixty hits a second',
      lit.tickEvery >= 0.1, `${lit.tickEvery}s between bites`);
    // WHERE IT CAME OUT OF. The lure hangs off the front of the animal, so this
    // is a real distance rather than a rounding error — and the fallback if the
    // node is missing is the body centre, which is exactly what a zero here
    // would mean.
    const offBody = Math.hypot(lit.x - boss.mesh.position.x, lit.y - boss.mesh.position.y);
    check('it leaves the lure rather than the middle of the fish',
      offBody > 0.5, `${offBody.toFixed(2)} units off the body centre`);
    check('the boss found the lure node named in config',
      !!boss.__lureNode, CONFIG.boss.angler.lureNode);
    // ...and it does not steer. TELEPORT the seal square across the line.
    check('the beam is fired without a follow, so it cannot sweep onto you',
      lit.follow == null, String(lit.follow));
    const d0 = { x: lit.dirX, y: lit.dirY };
    player.x = -range; player.y = floorLine() + 20;
    for (let i = 0; i < 20 && beams.includes(lit); i++) {
      updateBossAngler(DT, scene, player, { onPlayerHit: () => {}, onPlayerSnare: () => {} });
      step(boss, DT);
    }
    check('...and it really did not move after the player jumped',
      Math.abs(lit.dirX - d0.x) < 1e-6 && Math.abs(lit.dirY - d0.y) < 1e-6,
      `(${d0.x.toFixed(3)}, ${d0.y.toFixed(3)}) -> (${lit.dirX.toFixed(3)}, ${lit.dirY.toFixed(3)})`);
  }
  releaseAngler();
  resetBeams(scene);
}

// ---------------------------------------------------------------------------
section('THE TELEGRAPH IS PUT AWAY');
// ---------------------------------------------------------------------------
// The ring is a live scene object with a material of its own. A boss that dies
// mid-charge, or a perk that takes the body off it, would otherwise leave the
// circle burning in the water for the rest of the run — and the material leaked
// with it. Worse than a leak: a ring over an attack that was cancelled is a lie
// the player reads correctly and is punished for believing.
{
  const ringsIn = () => {
    let n = 0;
    scene.traverse((o) => { if (o?.userData?.organicRing) n++; });
    return n;
  };
  releaseAngler();
  const before = ringsIn();
  at(boss, 0, floorLine()); boss.vx = 0; boss.vy = 0;
  boss.hp = boss.maxHp; boss.deep = false; boss.entering = false;
  attachAngler(scene, boss);
  player.x = CONFIG.boss.angler.lureRange * 0.8; player.y = floorLine();
  for (let i = 0; i < 60 * 20 && anglerState.stage !== 'charge'; i++) {
    updateBossAngler(DT, scene, player, { onPlayerHit: () => {}, onPlayerSnare: () => {} });
    step(boss, DT);
  }
  check('a charge puts a telegraph in the water', anglerState.stage === 'charge' && ringsIn() === before + 1,
    `stage ${anglerState.stage}, ${ringsIn()} rings`);
  check('...and anglerStage() reports it, so it is visible from outside a fight',
    anglerStage().tell === true && anglerStage().attack != null,
    `tell=${anglerStage().tell} attack=${anglerStage().attack}`);
  // The worst moment: killed mid-charge, ring still up.
  releaseAngler();
  check('releasing mid-charge takes the telegraph with it', ringsIn() === before,
    `${ringsIn()} rings against ${before} before the fight`);
  check('...and the state that drove it', anglerState.ring === null && anglerState.attack === null,
    `ring=${anglerState.ring} attack=${anglerState.attack}`);
  resetBeams(scene);
}

// ---------------------------------------------------------------------------
section('IT TURNS ITS HEAD, AND IT TURNS ON ITS NOSE');
// ---------------------------------------------------------------------------
// The head-look matters more on this boss than on any of the chasers. A shark's
// body is always swinging through a turn and the head only has to lead it; this
// animal holds station on the seabed, so the head is the only thing that can
// say it has seen you.
//
// EVERY CLAIM HERE IS MEASURED THROUGH THE REAL RIG, because a lookRig is four
// values that are all plausible and all silently wrong if guessed: a bone name
// that does not resolve logs one warning and never looks again, a tipAxis
// pointing down the animal aims the cone gate at its own flank, and a tipLength
// in the wrong units puts the "snout" somewhere inside the skull.
{
  const { createHeadLook } = await import('../path/src/systems/headLook.js');
  const def = ASSETS[KEY];

  check('the boss asset declares a head-look rig', !!def.lookRig?.head,
    def.lookRig ? Object.keys(def.lookRig).join(', ') : 'none');

  const rigDef = def.lookRig.head;
  const probe = createVisual(KEY);
  const holder = new THREE.Group();
  holder.add(probe);
  holder.updateMatrixWorld(true);

  for (const name of rigDef.bones) {
    check(`"${name}" resolves on the model`, !!probe.getObjectByName(name), name);
  }

  // tipAxis: the named local axis has to be the one pointing the way the animal
  // travels. createVisual leaves the body nose-up — forward is world +Y — so
  // the winning axis is the one whose dot with (0, 1, 0) is 1.
  const bone = probe.getObjectByName(rigDef.bones[0]);
  const bq = new THREE.Quaternion();
  bone.getWorldQuaternion(bq);
  const AX = { '+X': [1, 0, 0], '+Y': [0, 1, 0], '+Z': [0, 0, 1] };
  const dotFor = (a) => new THREE.Vector3(...AX[a]).applyQuaternion(bq).dot(new THREE.Vector3(0, 1, 0));
  check('tipAxis is the axis that actually points forward',
    Math.abs(dotFor(rigDef.tipAxis)) > 0.99,
    Object.keys(AX).map((a) => `${a} ${dotFor(a).toFixed(3)}`).join('  '));

  // tipLength is in RAW FILE UNITS — the fit is applied to the wrapper and never
  // reaches the bone transforms — so it has to be checked against the bone's own
  // world scale. Landing it at the snout is what the cone gate measures against.
  const bw = new THREE.Vector3();
  bone.getWorldPosition(bw);
  const bs = new THREE.Vector3();
  bone.getWorldScale(bs);
  const box = new THREE.Box3().setFromObject(probe);
  const reach = rigDef.tipLength * bs.x;
  const toSnout = box.max.y - bw.y;
  check('tipLength reaches the front of the drawn body',
    Math.abs(reach - toSnout) < toSnout * 0.1,
    `${reach.toFixed(2)} world units against ${toSnout.toFixed(2)} to the snout `
    + `(${rigDef.tipLength} raw x a bone scale of ${bs.x.toFixed(4)})`);

  // ...AND IT ACTUALLY TURNS. Everything above could be right and the look
  // still do nothing — the chain builds from `userData.lookRig`, which is set
  // by createVisual, and a def whose rig never reached the instance resolves,
  // measures and warns exactly as a working one does.
  const look = createHeadLook(probe);
  check('a head-look chain builds from it', !!look, look ? 'built' : 'null');
  if (look) {
    // OFF TO ONE SIDE, and inside the front cone. createVisual leaves the body
    // nose-up, so a target at (0, 40) is straight ahead and a head-look that
    // did nothing at all would pass — which is what the first version of this
    // check measured, and it read 0.1 degrees on a working rig. Behind the
    // animal is the opposite mistake: past `backCone` the gate gives up on
    // purpose and the same working rig reads 2.4 degrees.
    const before = bone.quaternion.clone();
    const target = new THREE.Vector3(30, 30, 0);
    for (let i = 0; i < 120; i++) look.update(DT, target, { boss: true });
    const turned = before.angleTo(bone.quaternion);
    check('...and it moves the head off the pose the clip left',
      turned > 0.02, `${(turned * 180 / Math.PI).toFixed(1)} degrees`);
    // A LEAN, NOT A STARE. maxBend is the safety limit that stops the chain
    // being broken by over-rotation, and on this animal the "head" is 70% of
    // the body — so the cap is the only thing between a look and the whole
    // front of the fish folding round.
    check('...but no further than maxBend allows',
      turned <= CONFIG.enemyLook.maxBend * 1.05 + 1e-6,
      `${turned.toFixed(3)} rad against a ${CONFIG.enemyLook.maxBend} cap`);
    // The other way, to prove it is tracking rather than leaning at a constant.
    const atUp = bone.quaternion.clone();
    for (let i = 0; i < 240; i++) look.update(DT, new THREE.Vector3(-30, 30, 0), { boss: true });
    check('...and it follows a target that moves',
      atUp.angleTo(bone.quaternion) > 0.02,
      `${(atUp.angleTo(bone.quaternion) * 180 / Math.PI).toFixed(1)} degrees between the two`);
  }

  // THE PIVOT. It swivels on the spot to keep the seal in front of it, which is
  // the one creature in the game where where-it-rotates-about is visible — at
  // the roster's usual 0.15 the tail swings through most of a body length and
  // the turn reads as the animal sliding sideways.
  //
  // Measured off the built body rather than read off the def, because `pivot`
  // is a request and the thing that matters is where the origin ENDED UP: it is
  // applied before the fit scale and only along the travel axis, and a forward
  // axis declared wrong would move it along the animal's width instead with the
  // number in the def still saying 0.04.
  const length = box.max.y - box.min.y;
  const fromNose = (box.max.y) / length;
  check('the body turns about the front of its head',
    fromNose < 0.08, `origin sits ${(fromNose * 100).toFixed(1)}% back from the nose`);
  check('...without the origin leaving the body altogether',
    box.max.y > 0 && box.min.y < 0,
    `body spans ${box.min.y.toFixed(2)} .. ${box.max.y.toFixed(2)} about the origin`);
}

// ---------------------------------------------------------------------------
section('THE TELL REACHES THE EYES');
// ---------------------------------------------------------------------------
// `e.telegraph` is how a boss with no PERK says it is winding something up.
// Both of this animal's tells are the animal rather than a rolled power, so the
// perk check in systems/bossEyes.js cannot see either of them — and a fight
// built entirely out of reading the creature had eyes that stayed dark through
// every telegraphed moment of it.
{
  const stagesSeen = new Map();
  releaseAngler();
  at(boss, 0, floorLine()); boss.vx = 0; boss.vy = 0;
  boss.hp = boss.maxHp; boss.deep = false; boss.entering = false;
  boss.telegraph = 0;
  attachAngler(scene, boss);
  const hooks = { onPlayerHit: () => {}, onPlayerSnare: () => {} };
  // Close enough to lunge, so the run covers the wind-up as well as the charge.
  for (let i = 0; i < 60 * 40; i++) {
    player.x = boss.mesh.position.x + CONFIG.boss.angler.triggerRange * 0.7;
    player.y = boss.mesh.position.y;
    updateBossAngler(DT, scene, player, hooks);
    step(boss, DT);
    const st = anglerStage().stage;
    const cur = stagesSeen.get(st) ?? { lo: Infinity, hi: -Infinity, n: 0 };
    cur.lo = Math.min(cur.lo, boss.telegraph ?? 0);
    cur.hi = Math.max(cur.hi, boss.telegraph ?? 0);
    cur.n++;
    stagesSeen.set(st, cur);
  }
  const g = (n) => stagesSeen.get(n) ?? { lo: 0, hi: 0, n: 0 };
  check('the wind-up publishes a tell', g('windup').hi > 0.9,
    `peaks at ${g('windup').hi.toFixed(2)} over ${g('windup').n} frames`);
  check('...that BUILDS rather than being a flag', g('windup').lo < 0.2,
    `runs ${g('windup').lo.toFixed(2)} .. ${g('windup').hi.toFixed(2)}`);
  // AND NOTHING ELSE DOES. A tell left set is a boss announcing an attack that
  // is never coming, for the rest of the fight — which is the exact failure the
  // single clear at the top of the stage machine exists to make impossible.
  for (const st of ['lurk', 'lunge', 'snap', 'recover', 'discharge']) {
    if (!g(st).n) continue;
    check(`the ${st} says nothing`, g(st).hi === 0, `peaks at ${g(st).hi.toFixed(2)}`);
  }
  // The other tell, at the other range.
  releaseAngler();
  at(boss, 0, floorLine()); boss.vx = 0; boss.vy = 0;
  boss.hp = boss.maxHp; boss.telegraph = 0;
  attachAngler(scene, boss);
  let chargePeak = 0;
  for (let i = 0; i < 60 * 30; i++) {
    player.x = boss.mesh.position.x + CONFIG.boss.angler.lureRange * 0.8;
    player.y = boss.mesh.position.y;
    updateBossAngler(DT, scene, player, hooks);
    step(boss, DT);
    if (anglerStage().stage === 'charge') chargePeak = Math.max(chargePeak, boss.telegraph ?? 0);
  }
  check('the lure charge publishes one too', chargePeak > 0.9, `peaks at ${chargePeak.toFixed(2)}`);
  releaseAngler();
  check('a boss released mid-tell hands its eyes back dark', (boss.telegraph ?? 0) === 0,
    String(boss.telegraph));
  resetBeams(scene);
}

// ---------------------------------------------------------------------------
section('IT IS NEVER UPSIDE DOWN');
// ---------------------------------------------------------------------------
// THE BUG THIS EXISTS TO CATCH SHIPPED, and it was a whole animal swimming on
// its back for most of every fight.
//
// A side-on body needs TWO rotations: `rotation.z` on the container points the
// nose, and `rotation.y` on the model rolls it about its own forward axis so
// the belly stays down. `faceMotion` in entities/enemies.js writes both.
// systems/bossAngler.js took the facing off faceMotion below its 0.05 u/s gate
// — correctly, since the ambush is a dead stop — and reproduced only the first
// of the two. Aiming a nose that points right at something on the LEFT is 180
// degrees in the plane of the screen, and 180 degrees in that plane is exactly
// upside down.
//
// Then it went wrong a second way once the roll was added: the roll is eased
// over CONFIG.facing.time (0.4s) and the heading at `turnRate` (3.5s for the
// same half turn at the lurk), so the body finished rolling three seconds
// before the nose arrived and spent the gap inverted anyway.
//
// EVERYTHING BELOW IS MEASURED OFF THE DORSAL AXIS IN WORLD SPACE, which is the
// only statement of the bug a reader can check against the screen. Asserting on
// rotation.y — or on which branch was taken — passes while the animal is on its
// back, since the wrong pose is precisely the one those cannot see.
{
  // WHICH LOCAL AXIS IS THE DORSAL, measured off the rig rather than typed. The
  // fins are the honest source: the dorsal is the direction from the ventral
  // fin to the dorsal one, and a hardcoded guess here would be a test that
  // agrees with itself and with nothing else.
  const ref = createVisual(KEY);
  const holder = new THREE.Group();
  holder.add(ref);
  holder.updateMatrixWorld(true);
  const upFin = new THREE.Vector3();
  const lowFin = new THREE.Vector3();
  ref.getObjectByName('UpFin_Bone_01').getWorldPosition(upFin);
  ref.getObjectByName('LowFin_Bone_01').getWorldPosition(lowFin);
  // ...AND THEN ORTHOGONALISED AGAINST THE BODY'S LONG AXIS. The two fins sit
  // at different points ALONG the fish as well as on opposite sides of it, so
  // the raw line between them leans 9.3 degrees toward the tail. Used as-is it
  // reads that lean as a permanent tilt: every measurement below came out 9.3
  // degrees off vertical on a body that was provably upright, which looks
  // exactly like a small real bug and is not one. The dorsal is perpendicular
  // to the long axis by definition; the fore/aft part is just where the fins
  // happen to be.
  //
  // Forward is world +Y in the rest pose — createVisual leaves every creature
  // nose-up, and the tipAxis measurement in the section above confirms it
  // independently (the head bone's +X maps to (0, 1, 0), dot 1.000).
  const FWD = new THREE.Vector3(0, 1, 0);
  const raw = upFin.clone().sub(lowFin).normalize();
  const DORSAL = raw.clone().addScaledVector(FWD, -raw.dot(FWD)).normalize();
  check('the dorsal axis is measurable off the fins', DORSAL.lengthSq() > 0.99,
    `(${DORSAL.toArray().map((n) => n.toFixed(3)).join(', ')}), `
    + `${(Math.acos(Math.abs(raw.dot(DORSAL))) * 180 / Math.PI).toFixed(1)} degrees of fore/aft lean removed`);

  const rot = new THREE.Matrix4();
  const dor = new THREE.Vector3();
  // DEGREES OF ROLL — how far the back is from where "up" would put it FOR THE
  // HEADING THE ANIMAL CURRENTLY HAS. 0 is upright; 180 is belly-up.
  //
  // NOT THE ANGLE TO WORLD VERTICAL, which is what this used to measure and
  // which is a different quantity the moment a fish is allowed to point up or
  // down. An anglerfish nosing straight at a seal above it has its dorsal 90
  // degrees off world vertical and is perfectly, obviously upright: the back is
  // exactly where the back belongs on a vertical fish. Measured that way the
  // pitch and the roll are added together and reported as one number, so the
  // check either has to tolerate a full 90 degrees — which is also the reading
  // for a fish lying on its side — or fail on a body doing nothing wrong.
  //
  // So world up is projected into the plane the roll turns in (perpendicular to
  // the nose) and the dorsal is compared against THAT. Pitch cancels out
  // exactly, and what is left is only the thing the section is named after.
  const tilt = () => {
    boss.mesh.updateMatrixWorld(true);
    rot.extractRotation(boss.visual.matrixWorld);
    dor.copy(DORSAL).applyMatrix4(rot);
    const f = forwardOf(boss);
    const want = new THREE.Vector3(0, 1, 0);
    want.addScaledVector(f, -want.dot(f));
    // Nose within a whisker of straight up: there is no roll to speak of and
    // the projection is numerically meaningless. Reported as 0 rather than as
    // noise, which is also the honest answer.
    if (want.lengthSq() < 1e-6) return 0;
    want.normalize();
    return Math.acos(THREE.MathUtils.clamp(want.dot(dor), -1, 1)) * 180 / Math.PI;
  };

  const settle = (px) => {
    releaseAngler();
    boss.mesh.position.set(0, floorLine(), 0);
    boss.mesh.rotation.set(0, 0, 0);
    boss.visual.rotation.set(0, 0, 0);
    // The facing state lives on the VISUAL and visuals are pooled, so a run
    // that did not clear it would measure the last one's turn.
    delete boss.visual.userData.__face;
    // ...and the come-about's, which is where the pose actually lives now.
    delete boss.__turnYaw;
    boss.vx = 0; boss.vy = 0; boss.hp = boss.maxHp;
    boss.deep = false; boss.entering = false;
    attachAngler(scene, boss);
    const p = { x: px, y: floorLine() };
    for (let i = 0; i < 60 * 8; i++) {
      updateBossAngler(DT, scene, p, { onPlayerHit: () => {}, onPlayerSnare: () => {} });
      step(boss, DT);
    }
    return tilt();
  };

  const far = CONFIG.boss.angler.lureRange + 12;
  check('holding station with the seal to its right, it is upright',
    settle(far) < 1, `dorsal ${settle(far).toFixed(1)} degrees off vertical`);
  // THE ONE THAT SHIPPED BROKEN. Same body, same stage, seal on the other side.
  check('...and with the seal to its LEFT, it is still upright',
    settle(-far) < 1, `dorsal ${settle(-far).toFixed(1)} degrees off vertical`);

  // --- AND THROUGH A WHOLE FIGHT -------------------------------------------
  // The settled poses above are the easy half: both are static, and a body that
  // only inverts DURING a turn passes them. So the seal is walked all the way
  // round the animal, through every bearing and every attack range, and the
  // dorsal is sampled on every frame.
  releaseAngler();
  boss.mesh.position.set(0, floorLine(), 0);
  boss.mesh.rotation.set(0, 0, 0);
  boss.visual.rotation.set(0, 0, 0);
  delete boss.visual.userData.__face;
  // The come-about's state, so the reversal below is timed from a fish that has
  // just arrived rather than from one holding a heading out of the last run.
  delete boss.__turnYaw;
  boss.vx = 0; boss.vy = 0; boss.hp = boss.maxHp;
  boss.deep = false; boss.entering = false;
  attachAngler(scene, boss);
  const hooks = { onPlayerHit: () => {}, onPlayerSnare: () => {} };
  const p = { x: 0, y: floorLine() };
  let worst = 0; let worstAt = '';
  let prev = null; let worstJump = 0; let handoff = 0; let lastStage = null;
  const jumps = [];
  for (let i = 0; i < 60 * 90; i++) {
    const t = i / 60;
    // Slow enough that every bearing is actually visited, and wide enough to
    // cross all three attack ranges.
    p.x = Math.cos(t * 0.35) * 26;
    p.y = floorLine() + Math.sin(t * 0.21) * 10;
    updateBossAngler(DT, scene, p, hooks);
    step(boss, DT);
    const now = tilt();
    const st = anglerStage().stage;
    if (now > worst) { worst = now; worstAt = st; }
    if (prev != null) {
      const jump = Math.abs(now - prev);
      jumps.push(jump);
      if (jump > worstJump) worstJump = jump;
      if (lastStage !== st) { handoff = Math.max(handoff, jump); lastStage = st; }
    }
    prev = now;
  }
  // THE CEILING IS THE BANK AND NOTHING ELSE. This animal comes about through
  // the camera now (see systems/fishTurn.js): the turnaround is a YAW about
  // world up, so the back stays up through every frame of it by construction
  // rather than by two clocks agreeing. The only roll left in the body is the
  // lean it takes into its own turn, which `comeAbout.bank` caps outright.
  //
  // This is the check that changed shape when the come-about landed, and the
  // old number is worth keeping written down: the shared heading-plus-roll pair
  // turned a fish by rolling it onto its side and back, so halfway through a
  // reversal the dorsal genuinely pointed at the camera and 90 degrees was the
  // PASS. On a 12-unit body that was the flip the fight was reported for.
  const bankCap = (CONFIG.enemies.bossAnglerfish.comeAbout?.bankMax
    ?? CONFIG.fishTurn?.bankMax ?? 0.5) * 180 / Math.PI;
  check('across a whole fight the back never leaves the top of the animal',
    worst <= bankCap + 1, `worst ${worst.toFixed(1)} degrees, in the ${worstAt}`
    + ` — against a ${bankCap.toFixed(1)} degree bank cap`);
  check('...and it does lean into its turns, rather than tracking like a plank',
    worst > 3, `worst ${worst.toFixed(1)} degrees — under this it is not banking at all`);

  // --- AND IT DOES NOT SNAP -------------------------------------------------
  // A snap is a DISCONTINUITY, not a fast turn, so the two have to be told
  // apart: the wind-up turns at 2.4 rad/s by design and the frames inside it
  // are legitimately quick. What must not happen is one frame moving further
  // than a full turn's worth.
  jumps.sort((a, b) => a - b);
  const p99 = jumps[Math.floor(jumps.length * 0.99)];
  // THE CEILING IS DERIVED, not picked. The dorsal's tilt is a function of two
  // eased angles, so its rate cannot exceed the sum of theirs:
  //
  //   the pitch  is rate-limited outright at `turnRate` — 1x
  //   the roll   covers PI in PI/turnRate seconds, so its AVERAGE rate is
  //              `turnRate`, and CONFIG.facing.curve is an inOutCubic whose
  //              slope peaks at 3x its own average through the middle — 3x
  //
  // 4 x turnRate x dt, at the fastest rate the fight ever asks for. Anything
  // over it is a frame that moved further than a turn could carry it, which is
  // the definition of a snap and the only thing being asked here — the wind-up
  // legitimately turns at 2.4 rad/s and its frames are quick.
  //
  // THE COME-ABOUT'S OWN YAW IS THE OTHER CANDIDATE FOR FASTEST, and it has to
  // be in the ceiling or this measures the ambush's turn rates against a fish
  // that is repositioning under the def's. A half turn over `comeAbout.time`
  // through an inOutCubic peaks at 3x its average, hence the same 3x the roll
  // gets above; whichever of the two is quicker sets the bar.
  const fastest = Math.max(
    CONFIG.boss.angler.windupTurnRate ?? 2.4,
    Math.PI / (CONFIG.enemies.bossAnglerfish.comeAbout?.time ?? CONFIG.fishTurn?.time ?? 0.55),
  );
  const ceiling = 4 * fastest * DT * 180 / Math.PI;
  check('no frame jumps further than the fastest turn could carry it',
    worstJump <= ceiling, `worst ${worstJump.toFixed(2)} degrees against a ${ceiling.toFixed(2)} ceiling`);
  check('...and the typical frame is nothing at all', p99 < ceiling * 0.6,
    `median ${jumps[Math.floor(jumps.length / 2)].toFixed(3)}, p99 ${p99.toFixed(2)} degrees`);
  // THE HANDOFF FRAMES SPECIFICALLY, and what is asked of them is that they are
  // not OUTLIERS. Every stage change is a moment what the body is pointing at
  // changes — into and out of the lunge, where the aim gives way to the
  // velocity — and this is the check the shipped snap walked straight through
  // for as long as the harness left `turnFish` out of a step. Measured with it
  // in, and with the ambush still writing its own pose, the recovery's handoffs
  // moved the body 166.9 degrees in a frame against a ceiling of 9.17.
  check('changing stage does not jolt the body', handoff <= ceiling,
    `worst ${handoff.toFixed(2)} degrees on a handoff frame, against ${ceiling.toFixed(2)}`);

  releaseAngler();
  check('release hands the aim back to entities/enemies.js',
    boss.turnAim == null, String(boss.turnAim));
  resetBeams(scene);
}

// ---------------------------------------------------------------------------
section('THE HEAD-LOOK STILL SOLVES ONCE THE BODY IS ROLLED');
// ---------------------------------------------------------------------------
// The roll that keeps the animal upright is a rotation of the object the look
// chain hangs off. It solves in world space, so it should be untouched — but
// "should be" is how a rig ends up aiming its head at the mirror image of its
// target, and the symptom is a boss that tracks you perfectly on one side of
// the arena and stares away from you on the other.
{
  const { createHeadLook } = await import('../path/src/systems/headLook.js');
  const look = createHeadLook(boss.visual);
  const bone = boss.visual.getObjectByName('Head_Bone_00');
  const tip = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const fwd = new THREE.Vector3();
  const want = new THREE.Vector3();
  // Degrees between where the head points and where the target is, flattened
  // onto the arena plane.
  const aimErr = (target) => {
    boss.mesh.updateMatrixWorld(true);
    bone.getWorldPosition(tip);
    bone.getWorldQuaternion(q);
    fwd.set(1, 0, 0).applyQuaternion(q).setZ(0).normalize(); // tipAxis '+X'
    want.copy(target).sub(tip).setZ(0).normalize();
    return Math.acos(THREE.MathUtils.clamp(fwd.dot(want), -1, 1)) * 180 / Math.PI;
  };

  const results = [];
  for (const [label, roll, side] of [['unrolled', 0, 1], ['rolled', Math.PI, -1]]) {
    look.reset?.();
    bone.quaternion.set(0, 0, 0, 1);
    boss.mesh.position.set(0, floorLine(), 0);
    boss.mesh.rotation.set(0, 0, side > 0 ? -Math.PI / 2 : Math.PI / 2);
    boss.visual.rotation.set(0, roll, 0);
    const target = new THREE.Vector3(side * 30, floorLine() + 14, 0);
    const before = aimErr(target);
    for (let i = 0; i < 180; i++) look.update(DT, target, { boss: true });
    results.push({ label, before, after: aimErr(target) });
  }
  for (const r of results) {
    check(`${r.label}, the head turns toward the target`, r.after < r.before - 1,
      `${r.before.toFixed(1)} -> ${r.after.toFixed(1)} degrees off`);
  }
  // ...AND BY THE SAME AMOUNT. A mirror that broke the solve would still
  // "improve" if it happened to land nearer by luck; what says it is unaffected
  // is that both sides correct identically.
  check('...and the roll changes nothing about how well it does',
    Math.abs((results[0].before - results[0].after) - (results[1].before - results[1].after)) < 0.5,
    `${(results[0].before - results[0].after).toFixed(1)} vs `
    + `${(results[1].before - results[1].after).toFixed(1)} degrees of correction`);
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
