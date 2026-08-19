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
import * as THREE from 'three';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { execFileSync } from 'node:child_process';

import { CONFIG } from '../path/src/config.js';
import { installModel, createVisual, ASSETS } from '../path/src/assets.js';
import { createAnimationController } from '../path/src/systems/animation.js';
import { attachEmissiveCues, cueLevel, cueDuration } from '../path/src/systems/emissivePulse.js';
import {
  attachAngler, releaseAngler, updateBossAngler, anglerStage, anglerState, isAnglerBoss,
} from '../path/src/systems/bossAngler.js';

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
function makeBoss(scene) {
  const visual = createVisual(KEY);
  scene.add(visual);
  const def = CONFIG.enemies.bossAnglerfish;
  const e = {
    def, mesh: visual, vx: 0, vy: 0, dead: false,
    hp: def.hp, maxHp: def.hp,
    contactDamage: def.contactDamage, animState: null, perkDrive: false,
    anim: createAnimationController(visual),
  };
  return e;
}
// Step the body the way the integrator does, so a test that moves the boss
// moves the thing the fight actually reads.
const step = (e, dt) => { e.mesh.position.x += e.vx * dt; e.mesh.position.y += e.vy * dt; };
const at = (e, x, y) => { e.mesh.position.set(x, y, 0); };

const scene = new THREE.Scene();
const boss = makeBoss(scene);
const player = { x: 0, y: 0 };

// ---------------------------------------------------------------------------
section('THE STATES THIS FIGHT ASKS FOR EXIST ON THIS MODEL');
// ---------------------------------------------------------------------------
{
  const clips = boss.mesh.userData.clips ?? [];
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
  // In range from the first frame, so the lurk exits as soon as it has settled.
  player.x = 6; player.y = 0;
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
  at(boss, 0, 0); boss.vx = 0; boss.vy = 0;
  attachAngler(scene, boss);
  player.x = 6; player.y = 0;
  // Run to the moment it commits.
  let committed = null;
  for (let i = 0; i < 60 * 6 && !committed; i++) {
    updateBossAngler(DT, scene, player, {});
    if (anglerState.stage === 'lunge') committed = { x: anglerState.dirX, y: anglerState.dirY };
  }
  check('it committed to a direction', !!committed,
    committed ? `(${committed.x.toFixed(2)}, ${committed.y.toFixed(2)})` : 'never lunged');
  // Now TELEPORT the player square across the body and keep stepping.
  player.x = 0; player.y = 9;
  const vel = [];
  for (let i = 0; i < 20; i++) {
    updateBossAngler(DT, scene, player, {});
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
  at(boss, 0, 0);
  attachAngler(scene, boss);
  player.x = 6; player.y = 0;
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
  at(boss, 0, 0);
  boss.contactDamage = CONFIG.enemies.bossAnglerfish.contactDamage;
  const base = boss.contactDamage;
  attachAngler(scene, boss);
  player.x = 6; player.y = 0;
  // Kill it mid-lunge, the worst moment: contact damage is multiplied and the
  // locomotion state is pinned.
  for (let i = 0; i < 60 * 6; i++) {
    updateBossAngler(DT, scene, player, {});
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
  at(boss, 0, 0); boss.vx = 0; boss.vy = 0;
  boss.contactDamage = CONFIG.enemies.bossAnglerfish.contactDamage;
  attachAngler(scene, boss);
  player.x = 6; player.y = 0;
  for (let i = 0; i < 60 * 6; i++) {
    updateBossAngler(DT, scene, player, {});
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
  at(boss, 0, 0);
  boss.hp = 1000; boss.maxHp = 1000;
  attachAngler(scene, boss);
  // Out of range, so the fight stays in the lurk and the only thing that can
  // move the light is the damage.
  player.x = CONFIG.boss.angler.triggerRange * 3; player.y = 0;
  for (let i = 0; i < 120; i++) updateBossAngler(DT, scene, player, {});
  const calm = anglerStage().emissive;
  boss.hp -= 1000 * (CONFIG.boss.angler.hurtDamage * 3);
  updateBossAngler(DT, scene, player, {});
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
  at(boss, 0, 0); boss.vx = 0; boss.vy = 0;
  boss.hp = boss.maxHp;
  attachAngler(scene, boss);
  // Well outside triggerRange, so it lurks indefinitely and the only thing
  // being measured is what it does while waiting.
  player.x = CONFIG.boss.angler.triggerRange * 2.5; player.y = 0;
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
  const facingErr = () => {
    const want = Math.atan2(player.y - boss.mesh.position.y, player.x - boss.mesh.position.x) - Math.PI / 2;
    let d = want - boss.mesh.rotation.z;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d);
  };
  player.x = -CONFIG.boss.angler.triggerRange * 2.5; player.y = CONFIG.boss.angler.triggerRange;
  const before = facingErr();
  for (let i = 0; i < 60 * 6; i++) { updateBossAngler(DT, scene, player, {}); step(boss, DT); }
  const after = facingErr();
  check('it turns to face a player who moved behind it',
    after < 0.12, `${(before * 180 / Math.PI).toFixed(0)}° off -> ${(after * 180 / Math.PI).toFixed(1)}°`);
  check('...without translating to do it',
    start.distanceTo(boss.mesh.position) < 0.5, `${start.distanceTo(boss.mesh.position).toFixed(3)} units`);
  // And the turn is RATE-limited, not a snap — that is what makes circling work.
  at(boss, 0, 0);
  boss.mesh.rotation.z = 0;
  player.x = 0; player.y = -CONFIG.boss.angler.triggerRange * 2.5;
  const e0 = facingErr();
  updateBossAngler(DT, scene, player, {});
  const stepped = Math.abs(e0 - facingErr());
  check('the aim is rate-limited rather than snapping',
    stepped <= CONFIG.boss.angler.lurkTurnRate * DT * 1.05 + 1e-6,
    `${(stepped / DT).toFixed(2)} rad/s against a ${CONFIG.boss.angler.lurkTurnRate} cap`);
  releaseAngler();
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
