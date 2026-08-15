#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:boss
//
// Two things that are meant to be true about sharks, checked against the real
// spawner rather than against the config that is supposed to drive it:
//
//   1. THE SHIVER      No more than CONFIG.spawn.groupMaxAlive.shark sharks
//                      are ever in the water at once, driven through the real
//                      updateSpawning over a long run at high difficulty —
//                      and the distribution is reported, because "never three"
//                      is the requirement but "usually one" is the feel.
//   2. THE BOSS        It arrives every 8-12 LEVELS, exactly once per
//                      threshold, at the size CONFIG.boss.sizeMul asks for
//                      (visual AND hitbox), and it holds a shark slot while it
//                      lives so a boss fight is never also a shiver.
//
// Plus the name table, which is content in a file the player can edit: a
// broken row must degrade to a working name rather than to a blank health bar.
//
// No renderer, on purpose: the browser preview suspends requestAnimationFrame,
// so a screenshot proves nothing about a spawn loop. Every number below comes
// from ticking the same functions main.js ticks.
//
//   node --import ./tools/vite-loader.mjs tools/boss-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CONFIG } from '../path/src/config.js';
import { bossLockout, clearForBoss, enemies, resetEnemies, removeEnemy, updateEnemies, updateSpawning, spawnNamed } from '../path/src/entities/enemies.js';
import { cycleState, lullEligible, resetWaves, setBossCycle, waveSpawn, waveState } from '../path/src/systems/waves.js';
import { bossKillState, resetBossKill, startBossKill, updateBossKill } from '../path/src/systems/bossKill.js';
import { initBossGibs, spawnBossGibs, updateBossGibs, resetBossGibs, bossGibCount } from '../path/src/systems/bossGibs.js';
import { bounds } from '../path/src/arena.js';
import { inSpawnGroup, spawnGroupsOf } from '../path/src/enemyTable.js';
import { updateBoss, updateBossAbilities, resetBoss, bossState, bossBanner, capBossDamage, resetBossDamageCap } from '../path/src/systems/boss.js';
import { difficultyRamp } from '../path/src/config.js';
import { SENTINEL_HP } from '../path/src/systems/playtest.js';
import { parseBossNameCsv, rollBossName, FALLBACK_BOSS_NAME } from '../path/src/bossNameTable.js';
import { parseBossCsv, newBossBag, nextBoss, eligibleBosses } from '../path/src/bossTable.js';
import { parseBossPerkCsv, rollBossPerk, PERK_IDS } from '../path/src/bossPerkTable.js';
import { attachBossPerk, updateBossPerks, resetBossPerks, activeBossPerk } from '../path/src/systems/bossPerks.js';
import { bossArchetypes, bossPerkList, forceBoss, previewBossNames } from '../path/src/systems/boss.js';
import { ease, EASINGS, isEasing } from '../path/src/ease.js';

const here = dirname(fileURLToPath(import.meta.url));
const NAMES_CSV = resolve(here, '../path/src/bossNames.csv');
const BOSSES_CSV = resolve(here, '../path/src/bosses.csv');
const PERKS_CSV = resolve(here, '../path/src/bossPerks.csv');

// The frame every boss tick in this file is run at. updateBoss needs one now
// that the arrival is timed rather than instantaneous.
const DT = 1 / 60;

// Tick past the arrival ceremony. The boss is untouchable and harmless for
// CONFIG.boss.arrival.seconds, so every test about a FIGHT has to get through
// it first — and a test that forgot to would silently be measuring an
// invulnerable creature, which is the sort of pass that means nothing.
// Returns how many SECONDS it took, so a caller can check the ceremony is the
// length it was asked for rather than merely that it ended.
function finishArrival(gameState, scene) {
  let frames = 0;
  while (bossState.arriving && frames++ < 10000) updateBoss(DT, gameState, scene);
  return bossState.arriving ? Infinity : frames * DT;
}

// Tick through the HELD BREATH — the seconds between the level threshold and
// the creature, during which the water empties and nothing is spawned by
// anything (see CONFIG.boss.hush). Every test that used to say "the boss
// arrives on the frame the level lands" now has to sit through this first, and
// a test that forgot to would read a null boss and fail with the arrival
// looking broken rather than delayed.
//
// Returns the boss, or null if none turned up inside the guard.
function arrive(gameState, scene) {
  const first = updateBoss(DT, gameState, scene);
  if (first) return first;
  let frames = 0;
  while (bossState.hushing && frames++ < 10000) {
    const e = updateBoss(DT, gameState, scene);
    if (e) return e;
  }
  return bossState.enemy;
}


let failures = 0;
const quiet = () => {};
function section(name) { console.log(`\n${name}`); }
function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

const scene = new THREE.Scene();
const isShark = (e) => inSpawnGroup(e.def, 'shark');
const sharkCount = () => enemies.filter(isShark).length;

// A deterministic stand-in for Math.random, so a cadence test measures the
// cadence rather than the dice. Seeded per use — see the note in
// tools/nightlife-test.mjs about why every spawn harness does this.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------
section('THE ROSTER — who is tagged as a shark');
// ---------------------------------------------------------------------------
const sharkKeys = Object.keys(CONFIG.enemies).filter((k) => inSpawnGroup(CONFIG.enemies[k], 'shark'));
const apexKeys = Object.keys(CONFIG.enemies).filter((k) => inSpawnGroup(CONFIG.enemies[k], 'apex'));

check('the shark family is not empty', sharkKeys.length > 0, sharkKeys.join(', '));
check('every shark is also an apex', sharkKeys.every((k) => apexKeys.includes(k)),
  sharkKeys.filter((k) => !apexKeys.includes(k)).join(', ') || 'all of them');
// The two-group parse is the whole mechanism; a cell that stopped splitting
// would leave one group named "apex shark" that caps nothing at all.
check('"apex shark" parses as two groups',
  spawnGroupsOf(CONFIG.enemies.shark).length === 2,
  spawnGroupsOf(CONFIG.enemies.shark).join(' + '));
check('the shark cap exists and is small', (CONFIG.spawn.groupMaxAlive?.shark ?? Infinity) <= 2,
  `groupMaxAlive.shark = ${CONFIG.spawn.groupMaxAlive?.shark}`);
// The dolphin is apex but is NOT a shark; if it ever gets swept into the
// tighter cap, the apex allowance quietly becomes 2 for everything.
check('the dolphin is apex but not a shark',
  inSpawnGroup(CONFIG.enemies.dolphin, 'apex') && !inSpawnGroup(CONFIG.enemies.dolphin, 'shark'));

// THERE IS NO WILD ORCA. It used to be a full apex hunter held out of the pool
// by weight 0, and this check used to verify that weight. Weight 0 is a
// mechanism with a hole in it: it stops the WEIGHTED pool and nothing else, so
// anything spawning by name — a boss minion, a scripted wave, the debug door —
// went straight past it. The row is deleted now, which has no hole.
check('the wild orca no longer exists at all',
  CONFIG.enemies.orca === undefined,
  CONFIG.enemies.orca ? 'it is back in config.js' : 'gone from config.js and enemies.csv');
// ...and no OTHER creature quietly became one. The pod and the boss are the
// only orcas, and the pod is a companion rather than a roster entry.
check('the only orca in the roster is the boss',
  Object.keys(CONFIG.enemies).filter((k) => /orca/i.test(k)).join(', ') === 'bossOrca',
  Object.keys(CONFIG.enemies).filter((k) => /orca/i.test(k)).join(', ') || 'none');

// THE BOSSES ARE NOT WILDLIFE. "weight 0" is the mechanism — pickType drops
// anything that works out to zero. Checked as a PRODUCT rather than field by
// field, because the weight is (weight + weightPerDifficulty × difficulty) ×
// spawnRateMul and a non-zero weightPerDifficulty would quietly put a boss back
// in the pool an hour into a long run, which is the version of this bug nobody
// would find.
for (const key of ['bossShark', 'bossOrca']) {
  const d = CONFIG.enemies[key];
  const atDifficulty = (n) => ((d.weight ?? 0) + (d.weightPerDifficulty ?? 0) * n) * (d.spawnRateMul ?? 1);
  check(`${key} can never roll in an ordinary wave`,
    atDifficulty(0) === 0 && atDifficulty(50) === 0,
    `weight at difficulty 0/50: ${atDifficulty(0)}/${atDifficulty(50)}`);
}

// ---------------------------------------------------------------------------
section('THE SHIVER — the real spawner, 10 minutes at difficulty 20');
// ---------------------------------------------------------------------------
resetEnemies(scene);
{
  const gameState = { difficulty: 20, level: 12, running: true };
  const dt = 1 / 30;
  const histogram = new Map(); // sharks on screen -> frames spent there
  let peak = 0;

  for (let i = 0; i < 30 * 600; i++) {
    updateSpawning(dt, gameState, scene);
    // Churn the population the way a played run does, or the arena pins at
    // maxAlive and the cast freezes on whatever spawned first — which would
    // make the cap look respected because nothing was ever spawning.
    // removeEnemy takes an INDEX, not a creature — passing the object is a
    // silent no-op, and a churn that quietly does nothing lets the arena pin
    // at maxAlive with every cap looking respected because nothing is moving.
    if (enemies.length > 60) {
      for (let k = 0; k < 12 && enemies.length; k++) {
        removeEnemy(scene, Math.floor(Math.random() * enemies.length));
      }
    }
    const n = sharkCount();
    peak = Math.max(peak, n);
    histogram.set(n, (histogram.get(n) ?? 0) + 1);
  }

  const frames = 30 * 600;
  const cap = CONFIG.spawn.groupMaxAlive.shark;
  const at = (n) => ((histogram.get(n) ?? 0) / frames * 100).toFixed(1);
  check(`never more than ${cap} sharks at once`, peak <= cap, `peak was ${peak}`);
  // Not an assertion, a report: "unlikely to have several on screen" is a feel,
  // and this is the number that says whether it is true.
  console.log(`       time with 0 sharks: ${at(0)}%   1: ${at(1)}%   2: ${at(2)}%`);
  check('sharks do still show up', (histogram.get(0) ?? frames) < frames,
    `${(100 - Number(at(0))).toFixed(1)}% of the run has at least one`);
}

// ---------------------------------------------------------------------------
section('THE BOSS — cadence');
// ---------------------------------------------------------------------------
resetEnemies(scene);
{
  const cfg = CONFIG.boss;
  const every = cfg.everyLevels;
  const gaps = [];
  const firsts = [];
  const grid = [];

  // Ten runs, each levelling straight through to 60 with the boss killed the
  // instant it appears — so what is measured is the schedule, not a fight.
  for (let run = 0; run < 10; run++) {
    resetEnemies(scene);
    resetBoss();
    const gameState = { difficulty: 5, level: 1, running: true };
    const arrivals = [];
    for (let level = 1; level <= 60; level++) {
      gameState.level = level;
      // Through the hush as well as the spawn: a threshold answers with quiet
      // first now, and a level that only ticks once would never see the boss.
      arrive(gameState, scene);
      if (bossState.enemy) {
        arrivals.push(level);
        removeEnemy(scene, enemies.indexOf(bossState.enemy)); // by INDEX, not by creature
        updateBoss(DT, gameState, scene); // notice the kill
      }
    }
    firsts.push(arrivals[0]);
    grid.push(...arrivals);
    for (let i = 1; i < arrivals.length; i++) gaps.push(arrivals[i] - arrivals[i - 1]);
  }

  const min = Math.min(...gaps);
  const max = Math.max(...gaps);
  check(`every gap is exactly ${every} levels`, min === every && max === every,
    `saw ${min}-${max} over ${gaps.length} bosses`);
  check(`the first boss lands on level ${every}`, firsts.every((f) => f === every),
    `saw ${Math.min(...firsts)}-${Math.max(...firsts)}`);
  // THE GRID. The cadence is measured from the last THRESHOLD, not from the
  // level the boss happened to arrive at, so every arrival in a run lands on a
  // multiple of the gap — which is the whole promise of "every fifth level".
  check('every arrival is on the grid', grid.every((l) => l % every === 0),
    `${[...new Set(grid)].sort((a, b) => a - b).join(', ')}`);

  // ...and it holds when the player outruns it. A level-up inside a fight used
  // to push the entire rest of the run off the grid, one level per fight.
  resetEnemies(scene);
  resetBoss();
  {
    const gameState = { difficulty: 5, level: every, running: true };
    arrive(gameState, scene);
    const jumped = every + 2; // two levels banked while the boss was alive
    gameState.level = jumped;
    removeEnemy(scene, enemies.indexOf(bossState.enemy));
    updateBoss(DT, gameState, scene);
    check('a level gained mid-fight does not move the grid', bossState.nextLevel === every * 2,
      `killed at ${jumped}, next due at ${bossState.nextLevel} (want ${every * 2})`);
  }

  // The other direction: a player who leaps past several thresholds at once
  // fights ONE boss, not one per threshold on consecutive frames.
  resetEnemies(scene);
  resetBoss();
  {
    const gameState = { difficulty: 5, level: every * 3 + 1, running: true };
    arrive(gameState, scene);
    check('a huge jump still sends exactly one boss', enemies.filter((e) => e.isBoss).length === 1,
      `${enemies.filter((e) => e.isBoss).length} in the water`);
    check('...and the next is due at the very next threshold', bossState.nextLevel === every * 3 + 2,
      `due at ${bossState.nextLevel}`);
  }
}

// ---------------------------------------------------------------------------
section('THE HUSH — the water empties before the entrance');
// ---------------------------------------------------------------------------
resetEnemies(scene);
{
  const gameState = { difficulty: 30, level: 1, running: true };
  resetBoss();
  resetWaves(gameState.difficulty);

  // Fill the water the way a real run would: the actual spawner, at a
  // difficulty deep enough to be sending predators.
  for (let i = 0; i < 60 * 40; i++) updateSpawning(DT, gameState, scene);
  const before = enemies.length;
  check('the arena is busy before the threshold', before > 20, `${before} creatures`);

  // Cross it. Nothing should arrive, and everything should turn for the wall.
  gameState.level = bossState.nextLevel;
  updateBoss(DT, gameState, scene);
  check('crossing the threshold does not spawn the boss', bossState.enemy === null);
  check('...it starts a hush instead', bossState.hushing === true);
  check('...which locks the spawner', bossLockout() === true);
  check('...and turns the whole arena for the wall',
    enemies.every((e) => e.leaving || e.def?.bossMinion || !(e.speed > 0.01)),
    `${enemies.filter((e) => !e.leaving).length} of ${enemies.length} staying`);

  // Now run the hush the way main.js does — spawner first, boss second — and
  // count what arrives. The answer has to be nothing at all: not a lull fish,
  // not a crab, not a minion.
  const atHushStart = enemies.length;
  let spawnedDuring = 0;
  let frames = 0;
  while (bossState.hushing && frames++ < 10000) {
    const n = enemies.length;
    updateSpawning(DT, gameState, scene);
    if (enemies.length > n) spawnedDuring += enemies.length - n;
    updateEnemies(DT, scene, { x: 0, y: 0, z: 0 }, quiet, quiet);
    updateBoss(DT, gameState, scene);
  }
  const seconds = frames * DT;
  check('the hush lasts as long as it was asked for',
    Math.abs(seconds - CONFIG.boss.hush.seconds) < 0.1, `${seconds.toFixed(2)}s`);
  check('nothing whatsoever spawns during it', spawnedDuring === 0, `${spawnedDuring} arrived`);
  check('...and the water actually drains', enemies.length < atHushStart * 0.75,
    `${atHushStart} → ${enemies.length}`);
  check('the boss is in the water at the end of it', bossState.enemy != null);
  check('...and the lockout has been handed over to it, unbroken', bossLockout() === true);
}

// ---------------------------------------------------------------------------
section('THE KILL SHOT — slow motion and a close-up');
// ---------------------------------------------------------------------------
// No renderer and no camera here, deliberately: the shot IS its two published
// numbers (the time scale main.js folds into every delta, and the focus claim
// it hands world.focusCamera), so ticking the module on a wall clock and
// reading them is the whole of it. What a screenshot would add is a picture of
// a frame that the browser preview cannot animate anyway.
{
  const K = CONFIG.boss.kill;
  resetBossKill();
  check('nothing is claimed while no boss has died',
    updateBossKill(DT) === 1 && bossKillState.camWeight === 0);

  check('a kill starts a shot', startBossKill() === true);
  check('...and it opens at full speed, not at the bottom',
    bossKillState.timeScale > 0.9, `${bossKillState.timeScale.toFixed(2)}`);

  // Down.
  let t = 0;
  while (t < K.dilateTime) { updateBossKill(DT); t += DT; }
  check('the world is in slow motion within the time it was given',
    Math.abs(bossKillState.timeScale - K.hold) < 0.02, `x${bossKillState.timeScale.toFixed(3)} vs ${K.hold}`);
  check('...and it is genuinely slow, not merely slower',
    bossKillState.timeScale < 0.25, `x${bossKillState.timeScale.toFixed(3)}`);

  // The close-up, at the bottom of the ramp.
  while (t < K.dilateTime + K.cam.pushTime) { updateBossKill(DT); t += DT; }
  check('the frame has pushed in on the seal',
    Math.abs(bossKillState.camZoom - K.cam.zoom) < 0.05, `zoom ${bossKillState.camZoom.toFixed(2)}`);
  check('...and taken most of the framing', bossKillState.camWeight > K.cam.weight - 0.02,
    `weight ${bossKillState.camWeight.toFixed(2)}`);

  // THE BEAT. The middle of the shot is the only part allowed to be long, and
  // it is what the whole moment is for: the boss is coming apart, the score has
  // cut out, and the frame is holding still on the seal. Measured as the
  // stretch the world spends actually held at the bottom rather than off the
  // config, so a punch that overran into it would show up here.
  let held = 0;
  while (bossKillState.phase === 'hold' && held < 10) { updateBossKill(DT); held += DT; }
  check('the beat is long enough to sink in', held > 1.2, `${held.toFixed(2)}s held`);

  // And back. Quicker than the beat, on purpose — the moment has to END rather
  // than sag back into play, and the water is already refilling by the time the
  // frame finishes opening out.
  let frames = 0;
  while (bossKillState.active && frames++ < 10000) updateBossKill(DT);
  const back = frames * DT;
  const total = t + held + back;
  check('it lets go on its own', !bossKillState.active);
  check('...back to a live clock and an unclaimed frame',
    bossKillState.timeScale === 1 && bossKillState.camWeight === 0 && bossKillState.camZoom === 1);
  check('...and does it faster than it held', back < held, `${back.toFixed(2)}s back vs ${held.toFixed(2)}s held`);
  // Still punctuation. A run that reaches level 40 sees eight of these, and the
  // eighth has to be worth watching.
  check('the whole shot is under three seconds', total < 3, `${total.toFixed(2)}s`);
  check('...and is not so short it cannot be read', total > 1.2, `${total.toFixed(2)}s`);

  // The switch.
  resetBossKill();
  CONFIG.boss.kill.enabled = false;
  check('switched off, nothing starts', startBossKill() === false);
  check('...and the clock is left alone', updateBossKill(DT) === 1);
  CONFIG.boss.kill.enabled = true;

  // THE REAL TRIGGER. The shot is fired by boss.js noticing the creature has
  // left the enemy list — the only place in the codebase that knows a boss
  // died — so this is the half that a unit test of the module alone would miss.
  resetEnemies(scene);
  resetBoss();
  resetBossKill();
  {
    const gameState = { difficulty: 5, level: bossState.nextLevel, running: true };
    const boss = arrive(gameState, scene);
    finishArrival(gameState, scene);
    check('no shot while the boss is alive', bossKillState.active === false);
    removeEnemy(scene, enemies.indexOf(boss));
    updateBoss(DT, gameState, scene);
    check('killing it fires the shot', bossKillState.active === true);
    resetBossKill();
  }

  // ...but not over a corpse. A player who dies on the frame their last hit
  // lands would otherwise get a victory lap, and it would be fighting the
  // death dive for the same camera.
  resetEnemies(scene);
  resetBoss();
  resetBossKill();
  {
    const gameState = { difficulty: 5, level: bossState.nextLevel, running: true };
    const boss = arrive(gameState, scene);
    removeEnemy(scene, enemies.indexOf(boss));
    gameState.running = false; // killPlayer() does exactly this, on that frame
    updateBoss(DT, gameState, scene);
    check('a boss that dies with the player does not fire one', bossKillState.active === false);
    check('...but the kill is still counted', bossState.defeated === 1);
  }
  resetBossKill();
}

// ---------------------------------------------------------------------------
section('THE WRECKAGE — a boss comes apart');
// ---------------------------------------------------------------------------
// The chunks are what the held beat is FOR: a close-up of the spot a boss used
// to be is worth nothing, and that is what the shot framed before this existed.
//
// Everything here fails silently on screen. A burst that spawns at the origin,
// one that is thrown at wall-clock speed and is on the seabed before the camera
// lets go, one that overruns its instance buffer, one that never expires — all
// of them look like "the effect is a bit off" and none of them throws.
{
  const G = CONFIG.boss.gibs;
  initBossGibs(scene);
  const gibMesh = scene.getObjectByName('bossGibs');
  check('the pool is one instanced mesh, not a chunk per draw call',
    !!gibMesh && gibMesh.isInstancedMesh === true);
  check('...and it draws nothing while the arena is clean', gibMesh.count === 0);

  // A stand-in boss rather than a real spawn: this is about the burst, and a
  // creature with no measured hitbox is also the fallback path (one sphere at
  // the body's own radius) that every boss without `hitShape` takes.
  const body = () => ({
    mesh: { position: new THREE.Vector3(4, -3, 0) },
    radius: 3,
    def: { radius: 3 },
    vx: 6, vy: 0,
    assetKey: 'bossShark',
    hitShape: null,
  });

  resetBossGibs();
  const thrown = spawnBossGibs(body());
  check('a kill throws a few hundred chunks, not a handful', thrown >= 150,
    `${thrown} chunks`);
  check('...and the pool agrees', bossGibCount() === thrown);

  // Read straight off the instance buffer — where the chunks ARE is the whole
  // effect, and a burst that spawns correctly and is written to the wrong slots
  // draws at the origin.
  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  function spread() {
    updateBossGibs(0); // no time passes; this only rewrites the buffer
    let far = 0;
    let inside = 0;
    for (let i = 0; i < gibMesh.count; i++) {
      gibMesh.getMatrixAt(i, _m);
      _p.setFromMatrixPosition(_m);
      const d = Math.hypot(_p.x - 4, _p.y + 3);
      far = Math.max(far, d);
      if (d <= 3.01) inside++;
    }
    return { far, inside, drawn: gibMesh.count };
  }

  const born = spread();
  check('they are drawn, all of them', born.drawn === thrown, `${born.drawn} instances`);
  check('...from inside the body rather than at a point', born.inside === thrown && born.far > 1,
    `furthest ${born.far.toFixed(2)} of a 3.0 body`);

  // THE CLOCK THEY RUN ON. The whole beat is a tenth of a second of real
  // travel, which is why the wreckage is still a shape in the water when the
  // frame holds on it. On the wall clock the same 1.5s would have it on the
  // seabed before the camera let go, and the close-up would frame silt.
  let held = 0;
  while (held < 1.5) { updateBossGibs(DT * CONFIG.boss.kill.hold); held += DT; }
  const dilated = spread().far;
  resetBossGibs();
  spawnBossGibs(body());
  let live = 0;
  while (live < 1.5) { updateBossGibs(DT); live += DT; }
  const real = spread().far;
  check('the burst hangs through the held beat', dilated < real * 0.5,
    `${dilated.toFixed(1)} units out dilated against ${real.toFixed(1)} at full speed`);

  // ...and then it falls in the water like everything else does, and is gone.
  // Watched every frame of a whole burst's life rather than sampled at the end:
  // a chunk that punches through the seabed and is dragged back up by the next
  // frame's clamp leaves no trace in a final reading.
  resetBossGibs();
  spawnBossGibs(body());
  let deepest = Infinity;
  let frames = 0;
  let stillThereAt2s = 0;
  while (bossGibCount() > 0 && frames++ < 60 * 60) {
    updateBossGibs(DT);
    for (let i = 0; i < gibMesh.count; i++) {
      gibMesh.getMatrixAt(i, _m);
      _p.setFromMatrixPosition(_m);
      deepest = Math.min(deepest, _p.y);
    }
    if (frames === 120) stillThereAt2s = bossGibCount();
  }
  const cleared = frames / 60;
  check('nothing sinks through the seabed', deepest >= bounds.bottom - 0.01,
    `deepest ${deepest.toFixed(2)} against a floor at ${bounds.bottom.toFixed(2)}`);
  check('the wreckage is still there while the shot is', stillThereAt2s > thrown * 0.5,
    `${stillThereAt2s} of ${thrown} left after 2s`);
  check('...and clears itself soon after', cleared > 2 && cleared < 8, `gone by ${cleared.toFixed(1)}s`);
  check('...and the mesh stops drawing with it', gibMesh.count === 0);

  // THE CAP. An instance buffer cannot grow, so a second boss killed on top of
  // the first has to take its room from the oldest wreckage — writing past the
  // end of the array is the failure this exists for, and it is silent.
  resetBossGibs();
  for (let i = 0; i < 6; i++) spawnBossGibs(body());
  check('a pile of bosses cannot overrun the buffer', bossGibCount() <= G.max,
    `${bossGibCount()} against a pool of ${G.max}`);
  updateBossGibs(DT);
  check('...and the draw stays inside it', gibMesh.count <= G.max, `${gibMesh.count}`);

  resetBossGibs();
  check('a run reset empties the water', bossGibCount() === 0 && gibMesh.count === 0);

  G.enabled = false;
  check('switched off, nothing is thrown', spawnBossGibs(body()) === 0);
  G.enabled = true;

  // WHERE IT IS FIRED FROM, which is the one thing a module test cannot see and
  // the one thing that was hard to get right. systems/boss.js — where every
  // other part of the aftermath lives — finds out a boss died the frame AFTER
  // it happened, by noticing the creature has left the enemy list. By then the
  // body is back in the visual pool and its bones are posing somebody else, so
  // a burst fired from there is sampled off whatever creature inherited the
  // rig. It has to come from the kill hook, while there is still a pose.
  const mainSrc = readFileSync(resolve(here, '../path/src/main.js'), 'utf8');
  const bossSrc = readFileSync(resolve(here, '../path/src/systems/boss.js'), 'utf8');
  check('the burst is fired from the kill hook, on the frame of the blow',
    /isBoss\)\s*spawnBossGibs\(e\)/.test(mainSrc));
  check('...and not from the boss module, a frame after the body has gone',
    !bossSrc.includes('bossGibs'));
}

// ---------------------------------------------------------------------------
section('THE CYCLE — the water builds back between bosses');
// ---------------------------------------------------------------------------
{
  const C = CONFIG.spawn.waves.bossCycle;
  resetEnemies(scene);
  resetBoss();
  resetBossKill();
  const gameState = { difficulty: 20, level: 1, running: true };
  resetWaves(gameState.difficulty);

  updateBoss(DT, gameState, scene);
  check('a run that has never met a boss runs at full strength', cycleState.frac === 1,
    `${cycleState.frac}`);

  // Fight one and kill it.
  gameState.level = bossState.nextLevel;
  const boss = arrive(gameState, scene);
  finishArrival(gameState, scene);
  const due = bossState.nextLevel;
  removeEnemy(scene, enemies.indexOf(boss));
  updateBoss(DT, gameState, scene);

  check('the kill drops the cycle to the bottom', cycleState.frac === 0, `${cycleState.frac}`);
  // NOT into a calm, which is what this used to assert. The breath after a
  // fight is the kill shot now — a held, dilated, silent close-up — and six
  // more seconds of empty ocean behind it read as the run having stopped
  // rather than as a respite. The water restarts on the kill frame, from the
  // BOTTOM of a fresh surge's attack ramp, which is what keeps it from being
  // the surge the fight interrupted.
  check('...and the water starts filling again immediately', waveState.phase === 'surge',
    waveState.phase);
  check('...from the beginning of a surge, not the middle of the last one',
    waveState.t === 0 && waveState.pressure < 0.05,
    `t=${waveState.t.toFixed(2)}s pressure ${waveState.pressure.toFixed(3)}`);
  check('the water is holding almost nothing at first',
    waveSpawn().aliveFrac <= C.aliveStart + 1e-6, `${(waveSpawn().aliveFrac * 100).toFixed(0)}% of maxAlive`);

  // THE POINT OF THE CHANGE, measured through the real spawner: something is
  // in the water within seconds of the kill, and it is small. A player who has
  // just won should be swimming through minnows as the frame opens out, not
  // through an empty arena.
  {
    const scratch = { difficulty: gameState.difficulty, level: gameState.level, running: true };
    resetEnemies(scene);
    let firstAt = Infinity;
    for (let i = 0; i < 30 * 12; i++) {
      updateSpawning(DT, scratch, scene);
      setBossCycle(0); // boss.js re-publishes this every frame; updateSpawning does not
      if (enemies.length && firstAt === Infinity) firstAt = i * DT;
    }
    check('something is back in the water within a few seconds of the kill', firstAt < 6,
      Number.isFinite(firstAt) ? `first spawn at ${firstAt.toFixed(1)}s` : 'nothing came back');
    const big = [...new Set(enemies.map((e) => e.type))].filter((k) => inSpawnGroup(CONFIG.enemies[k], 'apex'));
    check('...and it is small fry, not the next apex', big.length === 0,
      big.length ? `got ${big.join(', ')}` : `${enemies.length} in the water`);
    resetEnemies(scene);
    resetWaves(gameState.difficulty);
    setBossCycle(0);
  }

  // Now walk the levels up to the next boss and watch the restraint come off.
  const walk = [];
  for (let level = gameState.level; level <= due; level++) {
    gameState.level = level;
    updateBoss(DT, gameState, scene);
    walk.push({ level, frac: cycleState.frac, alive: waveSpawn().aliveFrac });
  }
  console.log(`       ${walk.map((w) => `L${w.level} ${(w.frac * 100).toFixed(0)}%`).join('  ')}`);
  check('the cycle climbs level by level',
    walk.every((w, i) => i === 0 || w.frac >= walk[i - 1].frac) && walk[0].frac < walk[walk.length - 1].frac,
    `${walk[0].frac.toFixed(2)} → ${walk[walk.length - 1].frac.toFixed(2)}`);
  check('...and is back to full by the level the next boss is due', cycleState.frac === 1,
    `at level ${due}, due at ${bossState.nextLevel}`);
  check('...as is the arena allowance', Math.abs(waveSpawn().aliveFrac - C.aliveEnd) < 1e-6,
    `${(waveSpawn().aliveFrac * 100).toFixed(0)}%`);

  // THE POINT OF ALL OF IT: the same moment of the same surge sends
  // measurably less water at the bottom of a cycle than at the top. Measured
  // through the real spawner rather than off the curve, because the curve
  // could be perfect and still be multiplied by nothing anywhere.
  function surgeSpawns(frac) {
    resetEnemies(scene);
    resetWaves(20);
    setBossCycle(frac);
    const gs = { difficulty: 20, level: 30, running: true };
    let made = 0;
    for (let i = 0; i < 60 * 45; i++) {
      const n = enemies.length;
      updateSpawning(DT, gs, scene);
      setBossCycle(frac); // updateSpawning does not touch it; boss.js re-publishes every frame
      if (enemies.length > n) made += enemies.length - n;
    }
    return made;
  }
  const quietSide = surgeSpawns(0);
  const loudSide = surgeSpawns(1);
  check('the first 45s of a cycle are quieter than the last',
    quietSide < loudSide * 0.6, `${quietSide} spawned at the bottom vs ${loudSide} at the top`);
  check('...but not empty — a respite, not a dead arena', quietSide > 0, `${quietSide} spawned`);

  // And what arrives first is small. The cycle scales PRESSURE, so a held-back
  // surge stays under the lull threshold and the roster hands over gradually
  // rather than resuming with a megalodon.
  resetEnemies(scene);
  resetWaves(20);
  setBossCycle(0);
  {
    const gs = { difficulty: 20, level: 30, running: true };
    const seen = new Set();
    for (let i = 0; i < 60 * 45; i++) {
      updateSpawning(DT, gs, scene);
      setBossCycle(0);
      for (const e of enemies) seen.add(e.type);
    }
    const big = [...seen].filter((k) => inSpawnGroup(CONFIG.enemies[k], 'apex'));
    check('nothing apex comes back in the first stretch after a kill', big.length === 0,
      big.length ? `got ${big.join(', ')}` : `${seen.size} species, all small`);
  }
  resetWaves(20);
  setBossCycle(1);
}

// ---------------------------------------------------------------------------
section('THE BOSS — one at a time, and it is giant');
// ---------------------------------------------------------------------------
resetEnemies(scene);
{
  const gameState = { difficulty: 5, level: 1, running: true };
  resetBoss();
  const due = bossState.nextLevel;

  gameState.level = due - 1;
  updateBoss(DT, gameState, scene);
  check('no boss before its level', bossState.enemy === null, `due at ${due}`);
  check('...and no bar to draw', bossBanner() === null);

  gameState.level = due;
  const boss = arrive(gameState, scene);
  check('the boss arrives on its level, once the hush is done',
    boss != null && bossState.enemy === boss);
  check('it has a name', typeof bossState.name === 'string' && bossState.name.length > 2, bossState.name);
  check('it came from an archetype', !!bossState.archetype, bossState.archetype?.id);

  // THE ARRIVAL. The bar starts EMPTY and fills — a bar that read full on the
  // spawn frame would be the ceremony silently not running, and the boss would
  // look exactly the same either way.
  check('the bar starts empty', bossBanner()?.frac === 0, `${bossBanner()?.frac}`);
  check('...and the banner says it is arriving', bossBanner()?.arriving === true);
  check('the boss cannot be hurt while it arrives', boss.invuln > 0, `${boss.invuln.toFixed(2)}s left`);
  // Damage during the ceremony has to be undone. Applied straight to hp the
  // way sixteen other files in the project do, deliberately bypassing the
  // resolveCombat guard — this is the half of the invulnerability that catches
  // everything the guard does not.
  boss.hp = 1;
  updateBoss(DT, gameState, scene);
  check('...and damage dealt during it is restored', boss.hp === boss.maxHp,
    `${boss.hp} / ${boss.maxHp}`);

  const midFrac = bossBanner()?.frac ?? 0;
  check('the bar is filling', midFrac > 0 && midFrac < 1, `${(midFrac * 100).toFixed(0)}%`);
  // Two frames of it were already spent above, so the remainder plus those is
  // what should add up to arrival.seconds.
  const took = finishArrival(gameState, scene) + 2 * DT;
  check('the ceremony runs for about the seconds it is given',
    Math.abs(took - CONFIG.boss.arrival.seconds) < 0.05,
    `${took.toFixed(2)}s vs ${CONFIG.boss.arrival.seconds}s`);
  check('...leaving a full bar and a live boss', bossBanner()?.frac === 1 && boss.invuln === 0);
  check('...and the banner stops claiming it is arriving', bossBanner()?.arriving === false);

  // The size step has to move the model AND the hitbox by the same factor — a
  // boss you can shoot through the nose of is the failure this catches, and it
  // is invisible in a screenshot. Measured against a CONTROL: the same
  // creature spawned through the ordinary door, so the comparison is with the
  // body the CSV describes rather than with a number typed here.
  const wanted = bossState.archetype.sizeMul;
  const bossKey = bossState.archetype.enemy;
  const control = spawnNamed(scene, bossKey, gameState.difficulty, undefined, { ignoreCaps: true });
  check(`the hitbox is ${wanted}x an unscaled ${bossKey}`,
    Math.abs(boss.radius / control.radius - wanted) < 1e-6,
    `boss radius ${boss.radius.toFixed(2)} vs ${control.radius.toFixed(2)}`);
  check('...and the model is scaled by exactly the same factor',
    Math.abs(boss.visual.scale.x / control.visual.scale.x - wanted) < 1e-6,
    `visual ${boss.visual.scale.x.toFixed(2)} vs ${control.visual.scale.x.toFixed(2)}`);
  check('it is the biggest thing in the water',
    boss.radius > control.radius && boss.radius < bounds.width / 4,
    `boss radius ${boss.radius.toFixed(2)}, arena ${bounds.width} wide`);
  removeEnemy(scene, enemies.indexOf(control));

  // Ticking again must not send a second one, however many levels go by.
  gameState.level = due + 40;
  updateBoss(DT, gameState, scene);
  check('a level-up mid-fight does not send a second boss',
    enemies.filter((e) => e.type === bossKey).length === 1,
    `${enemies.filter((e) => e.type === bossKey).length} in the water`);

  // The bar tracks damage.
  bossState.enemy.hp = bossState.enemy.maxHp * 0.25;
  updateBoss(DT, gameState, scene);
  check('the bar follows its health', Math.abs((bossBanner()?.frac ?? 0) - 0.25) < 1e-6,
    `${((bossBanner()?.frac ?? 0) * 100).toFixed(0)}%`);

  // A boss holds a shark slot: the whole point of tagging it `apex shark`.
  check('the boss counts as a shark', isShark(bossState.enemy));

  removeEnemy(scene, enemies.indexOf(bossState.enemy));
  updateBoss(DT, gameState, scene);
  check('killing it clears the bar', bossBanner() === null);
  check('...and is counted', bossState.defeated === 1);
}

// ---------------------------------------------------------------------------
section('THE NAME — parts in, names out');
// ---------------------------------------------------------------------------
{
  const parts = parseBossNameCsv(readFileSync(NAMES_CSV, 'utf8'));
  check('the shipped file has all three slots',
    parts.prefix.length > 1 && parts.root.length > 1 && parts.epithet.length > 1,
    `${parts.prefix.length} prefixes, ${parts.root.length} roots, ${parts.epithet.length} epithets`);

  const rng = seeded(99);
  const rolled = new Set();
  for (let i = 0; i < 400; i++) rolled.add(rollBossName(parts, {}, rng));
  check('names vary', rolled.size > 40, `${rolled.size} distinct names in 400 rolls`);
  check('every name is non-empty and single-line',
    [...rolled].every((n) => n.trim().length > 3 && !n.includes('\n')));
  // The bar is a strip across the top of the screen; a name long enough to
  // wrap it turns a one-line banner into a two-line one and shoves the health
  // bar down. The ceiling is generous because the bar is now sized to the
  // fight (see bossBarWidth) and a late boss's is nearly full-width — but it
  // is still a ceiling, because the FIRST boss's bar is the short one and the
  // name has to fit that too.
  const longest = [...rolled].reduce((a, b) => (a.length > b.length ? a : b));
  check('no name is long enough to wrap the bar', longest.length <= 48, `longest: "${longest}"`);
  // "Grimtide the Tidebreaker" reads as a bug rather than as a name. Tested on
  // a rigged table where the echo is the ONLY epithet available, so the answer
  // is deterministic: drop the epithet rather than print the echo.
  const echoOnly = parseBossNameCsv(
    'id,slot,text\na,prefix,Grim\nb,root,tide\nc,epithet,the Tidebreaker', quiet);
  check('an epithet that echoes the root is dropped, not printed',
    rollBossName(echoOnly, {}, seeded(5)) === 'Grimtide', rollBossName(echoOnly, {}, seeded(5)));
  // ...unless it is the PERK's epithet, in which case the echo is the lesser
  // evil: dropping it leaves a boss whose name no longer says what it does.
  const perkEcho = parseBossNameCsv(
    'id,slot,text,perk\na,prefix,Grim,\nb,root,tide,\nc,epithet,the Tidebreaker,electric', quiet);
  check('...but a perk epithet is kept even when it echoes',
    rollBossName(perkEcho, { perk: 'electric' }, seeded(5)) === 'Grimtide the Tidebreaker',
    rollBossName(perkEcho, { perk: 'electric' }, seeded(5)));

  section('THE NAME — broken files still name the boss');
  const cases = [
    ['empty file', ''],
    ['header only', 'id,slot,text'],
    ['no id column', 'slot,text\nprefix,Gore'],
    ['every row disabled', 'id,slot,text,enabled\na,prefix,Gore,FALSE\nb,root,maw,FALSE'],
    ['no roots at all', 'id,slot,text\na,prefix,Gore\nb,epithet,the Devourer'],
    ['typo’d slots', 'id,slot,text\na,prefixes,Gore\nb,roots,maw'],
    ['garbage', 'not,a,table\n\n,,,'],
  ];
  for (const [label, csv] of cases) {
    const broken = parseBossNameCsv(csv, quiet);
    check(`${label} → fallback`, rollBossName(broken, {}, seeded(3)) === FALLBACK_BOSS_NAME,
      rollBossName(broken, {}, seeded(3)));
  }
  // ...but a file with no EPITHETS is not broken, it is a shorter name.
  const noEpithets = parseBossNameCsv('id,slot,text\na,prefix,Gore\nb,root,maw', quiet);
  check('no epithets → a bare name, not a fallback', rollBossName(noEpithets, {}, seeded(3)) === 'Goremaw',
    rollBossName(noEpithets, {}, seeded(3)));
  // The old two-argument shape must still work, because a caller that passed a
  // function where an options object now goes would silently name every boss
  // with no archetype and no perk — the exact bug this whole file guards.
  check('the old rollBossName(parts, random) shape still works',
    rollBossName(noEpithets, seeded(3)) === 'Goremaw', rollBossName(noEpithets, seeded(3)));
}

// ---------------------------------------------------------------------------
section('THE NAME — narrowed by archetype and by perk');
// ---------------------------------------------------------------------------
// Both new columns fail SILENTLY when they are wrong: a mistagged part is one
// that simply never appears again, and nothing about the game looks broken
// while it happens. So both are tested from the outside — roll a lot of names
// and check what could and could not have come out.
{
  const parts = parseBossNameCsv(readFileSync(NAMES_CSV, 'utf8'), quiet);
  const roster = parseBossCsv(readFileSync(BOSSES_CSV, 'utf8'), null, quiet);
  const perks = parseBossPerkCsv(readFileSync(PERKS_CSV, 'utf8'), quiet);

  // EVERY NAME THIS ARCHETYPE IS ALLOWED TO HAVE, assembled independently from
  // the parsed table. Checking membership of this set rather than searching a
  // name for forbidden substrings, because substrings lie: "Blackfin" is an
  // orca-only PREFIX and also what the universal "Black" + "fin" spells, so a
  // substring test reports the shark leaking a word it never touched. The set
  // is exact, and it is built from the file rather than typed here, so it
  // keeps testing the rule after the vocabulary is rewritten.
  const legalNames = (bossId, perkId = null, exclusive = false) => {
    const pool = (slot) => parts[slot].filter((p) => {
      if ((p.perk ?? null) !== perkId && (p.perk ?? null) !== null) return false;
      if (perkId && (p.perk ?? null) !== null && p.perk !== perkId) return false;
      // An exclusive archetype wears only what NAMES it — except in a slot the
      // perk speaks for, which stays shared on purpose: the perk vocabulary is
      // the telegraph, and a boss whose name stopped saying what it does would
      // be the feature failing to protect a vocabulary.
      if (exclusive && !p.perk) return !!p.bosses?.includes(bossId);
      return !p.bosses || p.bosses.includes(bossId);
    });
    const out = new Set();
    for (const pre of pool('prefix')) {
      for (const root of pool('root')) {
        out.add(`${pre.text}${root.text}`); // the epithet is optional
        for (const ep of pool('epithet')) out.add(`${pre.text}${root.text} ${ep.text}`);
      }
    }
    return out;
  };

  for (const arch of roster) {
    const legal = legalNames(arch.id, null, arch.ownNames);
    const rng = seeded(21);
    const names = [];
    for (let i = 0; i < 600; i++) {
      names.push(rollBossName(parts, { boss: arch.id, exclusive: arch.ownNames }, rng));
    }
    const illegal = [...new Set(names)].filter((n) => !legal.has(n));
    check(`${arch.id} never wears another archetype's parts`, illegal.length === 0,
      illegal.length ? `impossible names: ${illegal.slice(0, 3).join('; ')}` : `${legal.size} legal names`);
    check(`...and still has enough vocabulary of its own`, new Set(names).size > 20,
      `${new Set(names).size} distinct names`);
  }

  // -------------------------------------------------------------------------
  // OWN NAMES — an archetype that shares nothing
  // -------------------------------------------------------------------------
  // The shark and the orca are meant to sound like each other: they are both
  // big animals, they share seventy parts, and the handful of tagged rows is
  // the difference. A BOAT is not a fish, and "Grimtide the Everhungry" on a
  // trawler is the name table saying it is one. `ownNames` in bosses.csv is the
  // flag; this is the check that it actually severs the two vocabularies.
  const exclusives = roster.filter((b) => b.ownNames);
  check('at least one archetype names itself and nothing else', exclusives.length > 0,
    exclusives.map((b) => b.id).join(', ') || 'none — is the ownNames column still there?');

  for (const arch of exclusives) {
    const rng = seeded(31);
    const mine = new Set();
    for (let i = 0; i < 800; i++) mine.add(rollBossName(parts, { boss: arch.id, exclusive: true }, rng));

    // Every part it used has to be one that names it. Checked against the
    // SHARED pool directly rather than against a legal-name set, because the
    // failure being hunted is a shared word leaking in — and the most likely
    // way for that to happen is a new generic row nobody thought about.
    const sharedText = new Set();
    for (const slot of ['prefix', 'root', 'epithet']) {
      for (const p of parts[slot]) if (!p.bosses && !p.perk) sharedText.add(p.text);
    }
    const leaked = [...mine].filter((n) => [...sharedText].some((t) => n.startsWith(t) || n.endsWith(t) || n.endsWith(` ${t}`)));
    check(`${arch.id} never touches the shared vocabulary`, leaked.length === 0,
      leaked.length ? `leaked: ${leaked.slice(0, 3).join('; ')}` : `${mine.size} distinct names, all its own`);
    check('...and has enough of its own to not repeat', mine.size > 60, `${mine.size} distinct names`);

    // ...and the other way round: no other archetype may wear ITS words.
    for (const other of roster) {
      if (other.id === arch.id) continue;
      const rng2 = seeded(41);
      const theirs = new Set();
      for (let i = 0; i < 600; i++) theirs.add(rollBossName(parts, { boss: other.id, exclusive: other.ownNames }, rng2));
      const overlap = [...theirs].filter((n) => mine.has(n));
      check(`...and ${other.id} never wears them either`, overlap.length === 0,
        overlap.length ? `shared: ${overlap.slice(0, 3).join('; ')}` : `0 names in common with ${arch.id}`);
    }

    // THE PERK TELEGRAPH SURVIVES IT. Exclusivity is about the archetype's own
    // words, not about the warning system: a boat carrying `barrels` still has
    // to be able to say so, or the one part of the name that is load-bearing is
    // the part exclusivity broke.
    for (const perk of perks.slice(0, 3)) {
      const rng3 = seeded(51);
      let carried = 0;
      const perkWords = parts.prefix.concat(parts.epithet).filter((p) => p.perk === perk.id).map((p) => p.text);
      if (!perkWords.length) continue;
      for (let i = 0; i < 200; i++) {
        const n = rollBossName(parts, { boss: arch.id, perk: perk.id, exclusive: true }, rng3);
        if (perkWords.some((w) => n.includes(w))) carried += 1;
      }
      check(`${arch.id} + ${perk.id} still says which perk it has`, carried === 200,
        `${carried}/200 carried a ${perk.id} word`);
    }
  }

  // A STUBBED ARCHETYPE IS INERT. Disabled rows are dropped before the roster
  // check, which is what lets vocabulary be written for a boss that does not
  // exist yet without a warning per part on every boot. The risk is the
  // opposite one — that a stub is somehow live — so: nothing tagged for an id
  // that is not in bosses.csv may reach the parsed table at all.
  {
    const known = new Set(roster.map((b) => b.id));
    const ghosts = [];
    for (const slot of ['prefix', 'root', 'epithet']) {
      for (const p of parts[slot]) {
        for (const b of p.bosses ?? []) if (!known.has(b)) ghosts.push(`${p.text} (${b})`);
      }
    }
    check('no name part is live for an archetype that does not exist', ghosts.length === 0,
      ghosts.length ? ghosts.slice(0, 4).join('; ') : 'stubs stay disabled');
  }

  // ...and the flag has to actually NARROW something, or the column is doing
  // nothing and every check above passes vacuously.
  if (roster.length >= 2) {
    const a = legalNames(roster[0].id);
    const b = legalNames(roster[1].id);
    const shared = [...a].filter((n) => b.has(n)).length;
    check('the archetypes really do have different vocabularies',
      a.size !== b.size || shared !== a.size,
      `${roster[0].id}: ${a.size} names, ${roster[1].id}: ${b.size}, ${shared} in common`);
  }

  // THE GUARANTEE. A boss with a perk must ALWAYS be named for it — that is
  // the whole reason perks drive names, and a name that only sometimes carried
  // the perk would be a telegraph the player learns not to trust.
  for (const perk of perks) {
    const words = [];
    for (const slot of ['prefix', 'root', 'epithet']) {
      for (const p of parts[slot]) if (p.perk === perk.id) words.push(p.text);
    }
    if (!words.length) {
      check(`${perk.id} has name parts of its own`, false, 'none tagged in bossNames.csv');
      continue;
    }
    const rng = seeded(33);
    let missing = 0;
    const seen = new Set();
    for (let i = 0; i < 600; i++) {
      const n = rollBossName(parts, { boss: 'bossShark', perk: perk.id }, rng);
      const hit = words.find((w) => n.includes(w));
      if (hit) seen.add(hit); else missing++;
    }
    check(`every ${perk.id} boss is named for it`, missing === 0, `${missing} of 600 were not`);
    check(`...using more than one of its words`, seen.size > 1,
      `${seen.size} of ${words.length} words used`);
  }

  // ...and a boss with NO perk must never wear perk vocabulary, or the first
  // boss of every run would be called something that promises a power it does
  // not have.
  {
    const perkWords = [];
    for (const slot of ['prefix', 'root', 'epithet']) {
      for (const p of parts[slot]) if (p.perk) perkWords.push(p.text);
    }
    const rng = seeded(44);
    const bad = [];
    for (let i = 0; i < 800; i++) {
      const n = rollBossName(parts, { boss: 'bossShark', perk: null }, rng);
      for (const w of perkWords) if (n.includes(w)) bad.push(`${n} (${w})`);
    }
    check('a perk-less boss never wears perk vocabulary', bad.length === 0,
      bad.length ? bad.slice(0, 3).join('; ') : `${perkWords.length} perk words held back`);
  }
}

// ---------------------------------------------------------------------------
section('THE ROSTER — bosses.csv and the shuffle bag');
// ---------------------------------------------------------------------------
{
  const roster = parseBossCsv(readFileSync(BOSSES_CSV, 'utf8'), CONFIG.enemies, quiet);
  check('the shipped roster parses', roster.length >= 2, roster.map((b) => b.id).join(', '));
  check('every archetype points at a real creature',
    roster.every((b) => !!CONFIG.enemies[b.enemy]),
    roster.filter((b) => !CONFIG.enemies[b.enemy]).map((b) => b.enemy).join(', ') || 'all of them');
  // A run has to be able to start. If every archetype were gated behind a
  // level, the first boss would be a fallback rather than a designed fight.
  check('at least one archetype is available from the first boss',
    eligibleBosses(roster, 1).length > 0,
    `${eligibleBosses(roster, 1).map((b) => b.id).join(', ') || 'none'}`);

  // EVERY ARCHETYPE HAS TO BE THE RIGHT SIZE, not just the one that happens to
  // get drawn. sizeMul is a multiplier on a body whose own scale is its
  // enemies.csv radius times the model's fit in assets.csv — three numbers
  // that are set in three different files by three different kinds of edit, so
  // a new archetype copying a sizeMul that "looked right" on another model can
  // land at half the size or twice it with nothing to say so.
  for (const arch of roster) {
    resetEnemies(scene);
    const e = spawnNamed(scene, arch.enemy, 0, undefined, { ignoreCaps: true, overfill: true });
    const hitbox = e.radius * arch.sizeMul;
    scene.updateMatrixWorld(true); // or every bounding box measures identical
    const box = new THREE.Box3().setFromObject(e.visual);
    const drawn = box.getSize(new THREE.Vector3()).multiplyScalar(arch.sizeMul);
    const half = Math.max(drawn.x, drawn.y) / 2;
    check(`${arch.id} is unmistakably the biggest thing in the water`,
      hitbox > 2.5 && hitbox < bounds.width / 4,
      `hitbox radius ${hitbox.toFixed(2)}, arena ${bounds.width} wide`);
    // The drawn body and the thing you can shoot have to agree. A model drawn
    // at twice its hitbox is a boss you shoot through the nose of; one drawn at
    // half is a boss that hits you from off its own body.
    check(`...and what is drawn matches what you can hit`,
      half / hitbox > 0.6 && half / hitbox < 1.9,
      `drawn half-extent ${half.toFixed(2)} vs hitbox ${hitbox.toFixed(2)} (${(half / hitbox).toFixed(2)}x)`);
  }
  resetEnemies(scene);

  // A row naming a creature that does not exist must be refused at parse time,
  // not eight levels into a run.
  const bogus = parseBossCsv('id,enemy,sizeMul\nghost,notACreature,1.5', CONFIG.enemies, quiet);
  check('an archetype with no creature is refused', bogus.length === 1 && bogus[0].id === 'bossShark',
    bogus.map((b) => b.id).join(', '));
  const empty = parseBossCsv('', CONFIG.enemies, quiet);
  check('an empty roster falls back rather than leaving the run boss-less',
    empty.length === 1 && !!CONFIG.enemies[empty[0].enemy], empty[0]?.id);

  // THE BAG. The whole reason it exists is that an independent roll gives runs
  // that fight the same archetype four times, and with a roster this small that
  // is most runs — "unlucky" and "not implemented" look identical from the
  // outside. So: over a long enough run, no archetype is ever drawn twice
  // before every other eligible one has been drawn once.
  {
    const bag = newBossBag();
    const rng = seeded(5);
    const draws = [];
    for (let i = 0; i < 60; i++) draws.push(nextBoss(roster, bag, 99, rng).id);
    const n = roster.length;
    let violations = 0;
    for (let i = 0; i + n <= draws.length; i += n) {
      // Each consecutive block of `n` draws is one bag, and a bag holds each
      // archetype exactly once.
      if (new Set(draws.slice(i, i + n)).size !== n) violations++;
    }
    check('the bag never repeats before it is empty', violations === 0,
      `${violations} bad bags in ${Math.floor(draws.length / n)} — ${draws.slice(0, 8).join(', ')}...`);
    check('...and it does draw every archetype', new Set(draws).size === n,
      `${new Set(draws).size} of ${n}`);
  }

  // minLevel is the difficulty curve. A low-level run must not be able to draw
  // an archetype it has not reached.
  {
    const gated = roster.filter((b) => b.minLevel > 0);
    if (gated.length) {
      const bag = newBossBag();
      const rng = seeded(6);
      const early = [];
      for (let i = 0; i < 40; i++) early.push(nextBoss(roster, bag, 1, rng).id);
      const leaked = early.filter((id) => gated.some((g) => g.id === id));
      check('a level-1 run cannot draw a gated archetype', leaked.length === 0,
        leaked.length ? `drew ${[...new Set(leaked)].join(', ')}` : `gated: ${gated.map((g) => `${g.id}@${g.minLevel}`).join(', ')}`);
    }
    // ...and nothing eligible at all is a real answer, not a crash.
    check('nothing eligible returns null rather than throwing',
      nextBoss(roster.map((b) => ({ ...b, minLevel: 999 })), newBossBag(), 1, seeded(1)) === null);
  }
}

// ---------------------------------------------------------------------------
section('THE PERKS — bossPerks.csv, and who gets one');
// ---------------------------------------------------------------------------
{
  const perks = parseBossPerkCsv(readFileSync(PERKS_CSV, 'utf8'), quiet);
  check('the shipped perks parse', perks.length > 0, perks.map((p) => p.id).join(', '));
  check('every shipped perk is one the game implements',
    perks.every((p) => PERK_IDS.includes(p.id)),
    perks.filter((p) => !PERK_IDS.includes(p.id)).map((p) => p.id).join(', ') || 'all of them');
  // A perk with no code behind it would roll onto a boss that then does nothing
  // special while wearing a name promising that it does.
  const bogus = parseBossPerkCsv('id,enabled,weight\nmindControl,,1', quiet);
  check('a perk the game cannot do is refused', bogus.length === 0, bogus.map((p) => p.id).join(', '));

  // THE FIRST BOSS OF A RUN HAS NONE, and every one after it has exactly one.
  // Off by one here in either direction is the whole feature: reading
  // `defeated` instead of `sent` would leave every boss perk-less until one had
  // been killed, which is a bug with no symptom except that nothing happens.
  check('the first boss of a run gets no perk', rollBossPerk(perks, 0, seeded(1)) === null);
  const laterPerks = new Set();
  for (let i = 1; i <= 200; i++) {
    const p = rollBossPerk(perks, i, seeded(i * 7 + 1));
    if (!p) { laterPerks.add(null); continue; }
    laterPerks.add(p.id);
  }
  check('every later boss gets one', !laterPerks.has(null));
  check('...and which one varies', laterPerks.size > 1, [...laterPerks].join(', '));

  // A file that has been emptied must not crash the boss — it just means no
  // perks, which is the game as it was before they existed.
  check('an empty perk table means no perk, not a throw',
    rollBossPerk(parseBossPerkCsv('', quiet), 5, seeded(1)) === null);

  // Every perk's numbers have to be usable: a cooldown of 0 on a state machine
  // is a perk that re-fires every frame forever.
  for (const p of perks) {
    if (p.cooldown != null) {
      check(`${p.id}'s cooldown is a real gap`, p.cooldown > 0.5, `${p.cooldown}s`);
    }
  }
}

// ---------------------------------------------------------------------------
section('THE PERKS — what they actually do to the water');
// ---------------------------------------------------------------------------
// Every one of these is invisible in a screenshot and impossible to see in the
// browser preview, which suspends requestAnimationFrame. They are driven here
// through the same updateBossPerks + updateEnemies pair main.js ticks.
{
  const perks = parseBossPerkCsv(readFileSync(PERKS_CSV, 'utf8'), quiet);
  const byId = new Map(perks.map((p) => [p.id, p]));
  const dt = 1 / 60;
  const playerPos = { x: 0, y: 0, z: 0 };

  // A boss on its own in the water, past its arrival, with one named perk.
  function plantBoss(perkId) {
    resetEnemies(scene);
    resetBossPerks();
    const e = spawnNamed(scene, 'bossShark', 5, undefined, { ignoreCaps: true, overfill: true });
    e.isBoss = true;
    e.invuln = 0;
    attachBossPerk(scene, e, byId.get(perkId) ?? null);
    return e;
  }

  // --- lunge ---------------------------------------------------------------
  {
    const p = byId.get('lunge');
    const e = plantBoss('lunge');
    // OPEN WATER, AND IT HAS TO BE. Both bosses used to be planted at y=22 —
    // twelve units ABOVE the arena's own ceiling (bounds.top is 10), so the
    // wall clamp was hauling them back into the water for the whole test. A
    // dash that spends its length being clamped is a dash that curves, and the
    // straight-line check below failed on it about one run in ten: a real
    // property of the setup, arriving as if it were a property of the perk.
    //
    // Laid out along a horizontal line deep in the middle of the arena
    // instead, so the lunge has forty units of clear water in the direction it
    // is going and nothing to be clamped by.
    const target = { x: 20, y: -15, z: 0 };
    e.mesh.position.set(-25, -15, 0);
    // MEASURED AGAINST A CONTROL, because the boss swims under its own power
    // and would cover ground with no perk at all — a raw displacement proves
    // nothing about whether the dash happened.
    const control = spawnNamed(scene, 'bossShark', 5, undefined, { ignoreCaps: true, overfill: true });
    control.mesh.position.set(-25, -28, 0);

    let hitWindup = false;
    let hitDash = false;
    let dashStart = null;
    let dashTravel = 0;
    let controlTravel = 0;
    let lastBoss = e.mesh.position.clone();
    let lastControl = control.mesh.position.clone();
    const cycle = (p.cooldown ?? 5.5) + (p.windup ?? 0.7) + (p.duration ?? 0.9) + 1;

    // RUN UNTIL ONE COMPLETE DASH HAS BEEN SEEN, rather than for a fixed
    // window. The perk's first cooldown is not phase-locked, so a fixed window
    // sometimes caught the dash halfway and measured a fraction of it against
    // a full slice of the control — a check that failed about one run in six,
    // on the dice rather than on the code. The window here is only a guard;
    // the break is what decides what is measured.
    for (let i = 0; i < (cycle * 2) / dt; i++) {
      // `target` rather than the block's shared playerPos: the seal sits at the
      // origin for every other perk here, and the lunge is the one that needs
      // its whole path to be inside the water.
      updateBossPerks(dt, scene, target, {});
      const stage = activeBossPerk()?.stage;
      if (stage === 'windup') hitWindup = true;
      if (stage === 'dash') {
        if (!hitDash) dashStart = e.mesh.position.clone();
        hitDash = true;
      }
      updateEnemies(dt, scene, target, () => {}, () => {});
      if (stage === 'dash') {
        dashTravel += e.mesh.position.distanceTo(lastBoss);
        controlTravel += control.mesh.position.distanceTo(lastControl);
      }
      lastBoss = e.mesh.position.clone();
      lastControl = control.mesh.position.clone();
      // The frame after the dash ended. Everything below is about that one
      // dash — the straight-line check in particular compares the finish to
      // `dashStart`, which a second dash would make meaningless.
      if (hitDash && stage !== 'dash') break;
    }

    check('the lunge winds up before it dashes', hitWindup && hitDash);
    check('the dash outruns an unperked boss of the same species',
      dashTravel > controlTravel * 2.5,
      `dashed ${dashTravel.toFixed(1)} vs ${controlTravel.toFixed(1)} in the same frames`);
    // The line is locked at the end of the wind-up. A dash that curved would be
    // a homing lunge, which is unavoidable and so not a fight.
    if (dashStart) {
      const straight = e.mesh.position.distanceTo(dashStart);
      check('...and travels in a straight line, not a homing curve',
        straight > dashTravel * 0.9, `${straight.toFixed(1)} net over ${dashTravel.toFixed(1)} travelled`);
    }
    check('it hands the body back when the dash ends', e.perkDrive === false);
    check('...and puts its contact damage back',
      Math.abs(e.contactDamage - e.def.contactDamage) < e.def.contactDamage,
      `${e.contactDamage.toFixed(0)} vs a base near ${e.def.contactDamage}`);
  }

  // --- electric ------------------------------------------------------------
  {
    const p = byId.get('electric');
    const e = plantBoss('electric');
    const reach = e.radius + (p.radius ?? 9);

    let inside = 0;
    e.mesh.position.set(0, reach * 0.4, 0); // well within the aura
    for (let i = 0; i < 60; i++) {
      updateBossPerks(dt, scene, playerPos, { onPlayerHit: (d) => { inside += d; } });
    }
    check('standing in the aura hurts', inside > 0, `${inside.toFixed(1)} over a second`);
    // Per second, not per frame: the rate is the promise, and a per-frame
    // constant would make the aura framerate-dependent.
    check('...at about the rate the CSV asks for',
      Math.abs(inside - (p.damage ?? 16)) < (p.damage ?? 16) * 0.1,
      `${inside.toFixed(1)}/s vs ${p.damage}/s`);

    let outside = 0;
    e.mesh.position.set(0, reach * 2.5, 0);
    for (let i = 0; i < 60; i++) {
      updateBossPerks(dt, scene, playerPos, { onPlayerHit: (d) => { outside += d; } });
    }
    check('standing outside it does not', outside === 0, `${outside.toFixed(2)} taken`);

    // The aura is off during the entrance, like everything else.
    let duringArrival = 0;
    e.mesh.position.set(0, reach * 0.4, 0);
    e.invuln = 1;
    for (let i = 0; i < 60; i++) {
      updateBossPerks(dt, scene, playerPos, { onPlayerHit: (d) => { duringArrival += d; } });
    }
    check('an arriving boss shocks nobody', duringArrival === 0, `${duringArrival.toFixed(2)} taken`);
    e.invuln = 0;
  }

  // --- teleport ------------------------------------------------------------
  {
    const p = byId.get('teleport');
    const e = plantBoss('teleport');
    e.mesh.position.set(0, 30, 0);
    const from = e.mesh.position.clone();
    let vanished = false;
    const cycle = (p.cooldown ?? 7) + (p.windup ?? 0.45) + (p.duration ?? 0.35) + 1;

    for (let i = 0; i < cycle / dt; i++) {
      updateBossPerks(dt, scene, playerPos, {});
      if (activeBossPerk()?.stage === 'gone') vanished = true;
      updateEnemies(dt, scene, playerPos, () => {}, () => {});
      if (activeBossPerk()?.stage === 'ready' && vanished) break;
    }
    check('the boss goes somewhere while it is gone', vanished);
    const landed = Math.hypot(e.mesh.position.x - playerPos.x, e.mesh.position.y - playerPos.y);
    check('it reappears somewhere else', e.mesh.position.distanceTo(from) > 1,
      `moved ${e.mesh.position.distanceTo(from).toFixed(1)}`);
    // NEAR the player, never on top of them: a blink into contact is a hit with
    // no frame of warning.
    check('...near the player but not inside them',
      landed > e.radius && landed < (p.radius ?? 13) * 2.5,
      `landed ${landed.toFixed(1)} away, asked for ~${p.radius}`);
    check('and it is visible again afterwards', e.visual.visible === true);
  }

  // --- phase ---------------------------------------------------------------
  {
    const p = byId.get('phase');
    const e = plantBoss('phase');
    e.mesh.position.set(0, 25, 0);
    let sawHidden = false;
    let sawGone = false;
    const cycle = (p.cooldown ?? 9) + (p.windup ?? 0.5) * 2 + (p.duration ?? 3.5) + 1;

    for (let i = 0; i < cycle / dt; i++) {
      updateBossPerks(dt, scene, playerPos, {});
      const stage = activeBossPerk()?.stage;
      if (stage === 'gone') { sawGone = true; if (!e.visual.visible) sawHidden = true; }
      updateEnemies(dt, scene, playerPos, () => {}, () => {});
      if (stage === 'ready' && sawGone) break;
    }
    check('the boss actually disappears', sawGone && sawHidden);
    check('...and comes back', e.visual.visible === true);
    // The whole fight depends on it: a boss that stayed invisible would be
    // unkillable in practice, and nothing would throw.
    check('...leaving the perk ready to go again', activeBossPerk()?.stage === 'ready',
      activeBossPerk()?.stage);
  }

  // Tearing it down must put the creature back exactly as it found it. A
  // `perkDrive` left raised is an animal that never steers again; a hidden
  // visual is a boss nobody can see.
  {
    const e = plantBoss('phase');
    e.visual.visible = false;
    e.perkDrive = true;
    resetBossPerks();
    check('a reset hands the body back', e.perkDrive === false && e.visual.visible === true);
    check('...and nothing is left driving', activeBossPerk() === null);
  }

  // A boss that dies mid-perk must not leave the module ticking a corpse.
  {
    const e = plantBoss('lunge');
    e.hp = 0;
    updateBossPerks(dt, scene, playerPos, {});
    check('a dead boss lets go of its perk', activeBossPerk() === null);
  }
  resetEnemies(scene);
  resetBossPerks();
}

// ---------------------------------------------------------------------------
section('THE CLEAR-OUT — a boss fight empties the water');
// ---------------------------------------------------------------------------
// Everything here is about a silent failure. A clear-out that half works looks
// like ordinary spawn variance from the outside: the arena is a bit emptier
// than usual, and nobody can tell whether it emptied because the boss arrived
// or because the dice were quiet.
{
  const gameState = { difficulty: 20, level: 1, running: true };
  const dt = 1 / 30;
  const minionKeys = Object.keys(CONFIG.enemies).filter((k) => CONFIG.enemies[k].bossMinion);

  // Fill the water the way a real run does, then send the boss in.
  resetEnemies(scene);
  resetBoss();
  for (let i = 0; i < 30 * 90; i++) updateSpawning(dt, gameState, scene);
  const before = enemies.length;
  check('the arena is populated before the boss arrives', before > 10, `${before} creatures`);
  const turtleBefore = enemies.filter((e) => e.type === 'seaTurtle').length;

  // Straight past the threshold rather than waiting for it — the cadence is
  // the section above's job, and this one is about what happens on arrival.
  gameState.level = bossState.nextLevel;
  // `arrive` sits through the hush by ticking updateBoss and NOTHING else, so
  // no creature moves and none is swept — the population on the arrival frame
  // is still `before`, and the "nothing was deleted" check below is measuring
  // the arrival rather than a hush's worth of exits.
  const boss = arrive(gameState, scene);
  check('a boss arrived', !!boss, boss ? boss.type : 'none');
  check('...and the water was already told to leave, before it did',
    enemies.filter((e) => e !== boss && !e.def.bossMinion && e.speed > 0.01).every((e) => e.leaving));
  // THE CLEAR-OUT MUST NOT WAIT FOR THE CEREMONY. Everything below is asserted
  // on the arrival frame, before finishArrival is called — the water starts
  // emptying the moment the boss is in it, because the two seconds of entrance
  // are exactly when there is a frame's worth of ordinary spawning to catch.


  const escorts = enemies.filter((e) => e !== boss && e.def.bossMinion);
  const others = enemies.filter((e) => e !== boss && !e.def.bossMinion);
  check('the boss is marked', boss?.isBoss === true);
  check('everything that is not an escort is leaving',
    others.every((e) => e.leaving), `${others.filter((e) => !e.leaving).length} did not turn`);
  check('the boss itself is not leaving', boss?.leaving !== true);
  check('escorts already in the water are left alone',
    escorts.every((e) => !e.leaving), `${escorts.filter((e) => e.leaving).length} escorts were sent away`);
  // The turtle cannot be killed, so if it is not sent away it is furniture in
  // the boss fight for as long as the fight lasts.
  check('the sea turtle is sent away too',
    enemies.filter((e) => e.type === 'seaTurtle').every((e) => e.leaving),
    `${turtleBefore} were in the water`);

  // NOBODY DIED. The clear-out must not read as the player having cleared the
  // arena — no xp, no chum, no kill credit, and nothing removed on this frame.
  check('nothing was deleted on the arrival frame', enemies.length === before + 1,
    `${before} -> ${enemies.length}`);

  check('the ceremony finishes', finishArrival(gameState, scene) < Infinity);

  const player = { x: 0, y: 0 };
  for (let i = 0; i < 30 * 30; i++) {
    updateEnemies(dt, scene, player, () => {}, () => {});
  }
  const stragglers = enemies.filter((e) => e !== boss && !e.def.bossMinion && e.speed > 0.01);
  check('30 seconds later they have all actually left', stragglers.length === 0,
    stragglers.length ? `${stragglers.length} still here: ${[...new Set(stragglers.map((e) => e.type))].join(', ')}` : '');
  check('the boss is still in the water', enemies.includes(boss));

  // The lockout, and the one thing that is now allowed through it.
  //
  // THE ORDINARY SPAWNER IS STILL SILENT for the whole fight — that has not
  // changed and is what these two checks are still about. What has changed is
  // that the fight is no longer a sealed room: updateBossForage trickles small
  // schools in on its own cadence so the player has chum to go and get (see
  // CONFIG.boss.schools). So the rule is no longer "nothing arrives", it is
  // "nothing arrives that isn't a minion OR small fry the forage may send",
  // and `lullEligible` is the same rule the forage itself asks.
  const roster = new Set();
  for (let i = 0; i < 30 * 120; i++) {
    updateSpawning(dt, gameState, scene);
    for (const e of enemies) if (e !== boss) roster.add(e.type);
  }
  const allowed = (k) => CONFIG.enemies[k]?.bossMinion || lullEligible(CONFIG.enemies[k]);
  const intruders = [...roster].filter((k) => !allowed(k));
  check('nothing but minions and forage spawns during the fight', intruders.length === 0,
    intruders.length ? `got ${intruders.join(', ')}` : `minions: ${minionKeys.join(', ') || 'none tagged'}`);

  // The forage itself, checked here rather than in its own block because this
  // is the only place in the file with a live boss and two minutes of spawning
  // already ticked past it. Both halves matter: fish DO arrive (a fight with no
  // chum in it is the thing this replaced) and they arrive in small numbers (a
  // boss fight with fifteen fish in it is just a fight).
  const forage = enemies.filter((e) => e !== boss && !e.leaving);
  const cap = CONFIG.boss?.schools?.maxAlive ?? 9;
  check('the forage sends fish into the fight', forage.length > 0,
    `${forage.length} in the water: ${[...new Set(forage.map((e) => e.type))].join(', ') || 'none'}`);
  check('...and never more than the cap', forage.length <= cap,
    `${forage.length} vs cap ${cap}`);
  // Away from the boss, which is the whole point of the feature — a school
  // that spawned on top of the fight would be a free top-up rather than a
  // decision. Measured on the arrival SIDE rather than by distance: the fish
  // swim toward the player after they arrive, so a distance check minutes
  // later would be measuring the boids, not the spawner.
  const bossSide = boss.mesh.position.x >= 0;
  const farSide = forage.filter((e) => (e.mesh.position.x >= 0) !== bossSide);
  check('...and they arrive on the far side of the arena from it',
    forage.length === 0 || farSide.length > 0,
    `${farSide.length}/${forage.length} opposite the boss`);

  // ...and it comes back. A lockout that never lifted would empty the ocean
  // for the rest of the run, which is the worst version of this bug because
  // the fight itself would look perfect.
  const idx = enemies.indexOf(boss);
  removeEnemy(scene, idx);
  updateBoss(DT, gameState, scene); // notices the kill
  for (let i = 0; i < 30 * 60; i++) updateSpawning(dt, gameState, scene);
  const after = new Set(enemies.map((e) => e.type));
  check('ordinary spawning resumes once the boss is dead',
    [...after].some((k) => !CONFIG.enemies[k]?.bossMinion),
    `roster after: ${[...after].join(', ') || 'still empty'}`);

  // EVERY BEHAVIOUR, one of each, with no dice involved. This is the half that
  // was actually broken: the `leaving` steer used to live inside the drift
  // behaviour, so it did nothing for the other nine — a shark marked as
  // leaving just carried on hunting — and the wall clamp pinned every swimmer
  // a radius inside the arena edge, so even a creature that DID turn could
  // never cross the line the removal sweep waits for.
  //
  // Deliberately not measured off a random population: which behaviours happen
  // to be in the water is a roll of the dice, and a coverage check that passes
  // or fails on the seed is a check that will be quietly weakened later.
  resetEnemies(scene);
  {
    const oneOfEach = new Map();
    for (const [key, def] of Object.entries(CONFIG.enemies)) {
      const b = def.behavior ?? 'chase';
      if (!oneOfEach.has(b) && (def.speed ?? 0) > 0.01) oneOfEach.set(b, key);
    }
    for (const key of oneOfEach.values()) {
      spawnNamed(scene, key, 10, undefined, { ignoreCaps: true, overfill: true });
    }
    const planted = enemies.length;
    check('one of every behaviour is in the water', planted === oneOfEach.size,
      `${planted}: ${[...oneOfEach.keys()].join(', ')}`);

    const sent = clearForBoss(null);
    check('the clear-out claims all of them', sent === planted, `${sent} of ${planted}`);
    for (let i = 0; i < 30 * 60; i++) updateEnemies(dt, scene, player, () => {}, () => {});
    const stuck = [...new Set(enemies.map((e) => `${e.type}(${e.def.behavior ?? 'chase'})`))];
    check('every behaviour can actually reach the exit', enemies.length === 0,
      stuck.length ? `stuck: ${stuck.join(', ')}` : '');
  }

  // ...and the ones that cannot swim are deliberately left where they are,
  // rather than being marked and then sitting flagged-but-unremovable forever.
  resetEnemies(scene);
  {
    const still = Object.entries(CONFIG.enemies).find(([, d]) => !((d.speed ?? 0) > 0.01));
    if (still) {
      spawnNamed(scene, still[0], 10, undefined, { ignoreCaps: true, overfill: true });
      clearForBoss(null);
      check(`a creature that cannot swim (${still[0]}) is not asked to leave`,
        enemies.every((e) => !e.leaving));
      for (let i = 0; i < 30 * 20; i++) updateEnemies(dt, scene, player, () => {}, () => {});
      check('...and is still there, rather than flagged and stranded', enemies.length === 1);
    }
  }

  // Switching the boss off mid-fight must let go of the flag as well as the
  // reference. It is the same field the lockout is keyed on, so a boss left
  // carrying it would suppress every spawn in the game for the rest of the run.
  resetEnemies(scene);
  resetBoss();
  gameState.level = bossState.nextLevel;
  const second = arrive(gameState, scene);
  check('a second boss arrived', !!second);
  CONFIG.boss.enabled = false;
  updateBoss(DT, gameState, scene);
  CONFIG.boss.enabled = true;
  check('disabling the boss clears the marker', second?.isBoss === false);
  check('...so the lockout lifts with it', bossLockout() === false);
}

// ---------------------------------------------------------------------------
section('EASING — the shared curves');
// ---------------------------------------------------------------------------
{
  check('every name in the picker resolves to a curve', EASINGS.every(isEasing),
    EASINGS.filter((n) => !isEasing(n)).join(', ') || EASINGS.join(', '));
  // Every curve is a progress curve. One that did not start at 0 or end at 1
  // would leave a health bar short of full at the moment the fight starts.
  for (const name of EASINGS) {
    check(`${name} maps 0→0 and 1→1`,
      Math.abs(ease(name, 0)) < 1e-9 && Math.abs(ease(name, 1) - 1) < 1e-9,
      `${ease(name, 0)} … ${ease(name, 1)}`);
  }
  // Monotonic and inside [0,1] — no overshoot, which is the promise the file
  // makes so that the options are actually swappable.
  for (const name of EASINGS) {
    let ok = true;
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = ease(name, i / 100);
      if (v < -1e-9 || v > 1 + 1e-9 || v < prev - 1e-9) { ok = false; break; }
      prev = v;
    }
    check(`${name} never goes backwards or overshoots`, ok);
  }
  check('out of range is clamped, not extrapolated',
    ease('outCubic', -5) === 0 && ease('outCubic', 5) === 1);
  check('an unknown curve falls back to linear rather than NaN',
    ease('notACurve', 0.4) === 0.4);

  // THE ACTUAL COMPLAINT. The arrival bar was "too slow to start, then jumps",
  // which is an ease-IN shape. The configured curve has to be the other one:
  // ahead of linear the whole way, and most of the distance covered early.
  const curve = CONFIG.boss.arrival.ease;
  check(`the boss bar's curve (${curve}) exists`, isEasing(curve));
  check('...and it is front-loaded, not back-loaded',
    ease(curve, 0.25) > 0.25 && ease(curve, 0.5) > 0.5,
    `at 25% of the time the bar is ${(ease(curve, 0.25) * 100).toFixed(0)}% full, at 50% it is ${(ease(curve, 0.5) * 100).toFixed(0)}%`);
  check('...and half the bar is filled in well under half the time',
    ease(curve, 0.3) > 0.5,
    `${(ease(curve, 0.3) * 100).toFixed(0)}% full at 30% of the way through`);
}

// ---------------------------------------------------------------------------
section('THE ARRIVAL BAR — what it actually draws');
// ---------------------------------------------------------------------------
{
  resetEnemies(scene);
  resetBoss();
  const gameState = { difficulty: 5, level: 1, running: true };
  forceBoss(scene, gameState, { boss: 'bossShark', perk: null });

  // Sampled the way the HUD reads it — through bossBanner, frame by frame.
  const samples = [];
  let guard = 0;
  while (bossState.arriving && guard++ < 10000) {
    samples.push({ t: bossState.arrivalFrac, drawn: bossBanner().frac });
    updateBoss(DT, gameState, scene);
  }
  const at = (t) => samples.reduce((best, s) => (Math.abs(s.t - t) < Math.abs(best.t - t) ? s : best), samples[0]);

  check('the bar never runs backwards',
    samples.every((s, i) => i === 0 || s.drawn >= samples[i - 1].drawn - 1e-9));
  check('it is ahead of the clock the whole way, not behind it',
    samples.every((s) => s.drawn >= s.t - 1e-6),
    `worst lag ${Math.min(...samples.map((s) => s.drawn - s.t)).toFixed(3)}`);
  // The failure mode being fixed, stated as a number: a quarter of the way
  // through the ceremony the bar used to be barely off the left edge.
  check('a quarter of the way in, the bar is already well under way',
    at(0.25).drawn > 0.5,
    `${(at(0.25).drawn * 100).toFixed(0)}% full at 25% of the time`);
  // ...and the other end: no late jump. The last quarter of the TIME should
  // cover only a sliver of the BAR.
  check('the last quarter of the entrance is a settle, not a jump',
    1 - at(0.75).drawn < 0.12,
    `${((1 - at(0.75).drawn) * 100).toFixed(0)}% of the bar left with 25% of the time to go`);
  check('and it lands exactly full', bossBanner().frac === 1);

  // The clock itself stays linear — the riser is scheduled against it and the
  // fight starts off it, so easing the clock would desync both.
  const gaps = samples.slice(1).map((s, i) => s.t - samples[i].t);
  check('the underlying clock is still linear',
    Math.max(...gaps) - Math.min(...gaps) < 1e-9,
    `frame steps ${Math.min(...gaps).toFixed(5)}–${Math.max(...gaps).toFixed(5)}`);
}

// ---------------------------------------------------------------------------
section('THE DEBUG DOOR — spawning any combination on demand');
// ---------------------------------------------------------------------------
// The panel exists so every archetype × perk can be looked at without playing
// for an hour, which only helps if what it spawns is what the game spawns.
{
  const gameState = { difficulty: 5, level: 1, running: true };
  const archetypes = bossArchetypes();
  const perks = bossPerkList();
  // Read from the file rather than reaching into boss.js's parsed copy, so
  // this checks the shipped vocabulary and not the module's idea of it.
  const NAME_PARTS_FILE = parseBossNameCsv(readFileSync(NAMES_CSV, 'utf8'), quiet);

  check('the panel can see the roster and the perks',
    archetypes.length >= 2 && perks.length >= 1,
    `${archetypes.length} bodies, ${perks.length} perks`);

  // EVERY COMBINATION, including the gated archetype at level 1 — the whole
  // point is looking at a boss you have not earned yet.
  for (const arch of archetypes) {
    for (const perk of [null, ...perks.map((p) => p.id)]) {
      resetEnemies(scene);
      resetBoss();
      const e = forceBoss(scene, gameState, { boss: arch.id, perk });
      const got = bossState.perk?.id ?? null;
      check(`${arch.id} + ${perk ?? 'no perk'} spawns`,
        !!e && bossState.archetype?.id === arch.id && got === perk,
        `got ${bossState.archetype?.id} + ${got ?? 'no perk'} — "${bossState.name}"`);
      // ...and it is named for what it actually IS. A boss wearing the name of
      // the perk it nearly had is exactly what this panel is for catching, so
      // the panel must not be the thing producing it.
      if (perk) {
        const words = [];
        for (const slot of ['prefix', 'root', 'epithet']) {
          for (const p of NAME_PARTS_FILE[slot]) if (p.perk === perk) words.push(p.text);
        }
        check(`...and its name says "${perk}"`,
          words.some((w) => bossState.name.includes(w)),
          `"${bossState.name}"`);
      }
    }
  }

  // A forced spawn must not disturb the run's own schedule. Getting this wrong
  // would mean opening the panel quietly switched bosses off for the rest of
  // the session, which is the worst kind of debug-tool bug: it breaks the
  // thing it exists to inspect, silently.
  resetEnemies(scene);
  resetBoss();
  const due = bossState.nextLevel;
  forceBoss(scene, gameState, { boss: 'bossOrca', perk: 'teleport' });
  check('a forced spawn leaves the natural schedule alone', bossState.nextLevel === due,
    `next boss still due at ${bossState.nextLevel}, was ${due}`);

  // Clicking twice must not leave the first boss in the water holding the
  // spawn lockout open.
  const first = bossState.enemy;
  forceBoss(scene, gameState, { boss: 'bossShark', perk: 'lunge' });
  check('spawning a second one clears the first', !enemies.includes(first));
  check('...and only one boss is in the water',
    enemies.filter((x) => x.isBoss).length === 1,
    `${enemies.filter((x) => x.isBoss).length} marked`);
  check('...and the lockout is held by the live one', bossLockout() === true);

  // (roll) has to stay distinct from (none) — the bug a default parameter
  // would have introduced, where the panel's two leftmost chips did the same
  // thing and the perk-less boss became unreachable.
  resetEnemies(scene);
  resetBoss();
  bossState.sent = 5; // not the first boss of the run, so a roll should give one
  forceBoss(scene, gameState, { boss: 'bossShark' }); // no `perk` key at all = roll
  check('(roll) rolls a perk rather than meaning (none)', bossState.perk !== null,
    bossState.perk?.id ?? 'got none');
  resetEnemies(scene);
  resetBoss();
  bossState.sent = 5;
  forceBoss(scene, gameState, { boss: 'bossShark', perk: null });
  check('(none) really does force a perk-less boss', bossState.perk === null,
    bossState.perk?.id ?? 'none');

  // The name preview, which is the half of the panel that gets used most.
  const preview = previewBossNames(12, { boss: 'bossOrca', perk: 'electric' });
  check('the name preview returns what it was asked for', preview.length === 12);
  check('...all non-empty and single-line',
    preview.every((n) => n.trim().length > 3 && !n.includes('\n')));
  check('...and it does not spawn anything',
    (() => { resetEnemies(scene); previewBossNames(20, {}); return enemies.length === 0; })());
  resetEnemies(scene);
  resetBoss();
}

// ---------------------------------------------------------------------------
section('A WALL, NOT A COIN FLIP — health, damage, and the ceilings');
// ---------------------------------------------------------------------------
// The two halves of what a boss fight is supposed to feel like, and they pull
// in opposite directions: it has to take a long time to kill, and it must not
// be able to kill you in no time at all. Both are checked against the RUN, not
// against a single authored number, because both are things that scale.
{
  const HP = 100; // the player's authored bar — see CONFIG.player.maxHp

  // --- the sponge --------------------------------------------------------
  // A boss has to be a different ORDER of thing from the wildlife, not a
  // slightly bigger one. Measured against the toughest creature the pool can
  // actually send, FOUND rather than named — the boss orca used to be compared
  // against the wild orca it shared a model with, and that creature no longer
  // exists. A comparison that names its own baseline goes stale the moment the
  // roster does; this one cannot.
  const wildest = Object.entries(CONFIG.enemies)
    .filter(([k, d]) => !k.startsWith('boss') && d.hp < SENTINEL_HP
      && ((d.weight ?? 0) > 0 || (d.weightPerDifficulty ?? 0) > 0))
    .sort((a, b) => b[1].hp - a[1].hp)[0];
  // MEASURED AT A DIFFICULTY A BOSS ACTUALLY SPAWNS AT, not at the authored
  // base. `hp` alone is the creature at difficulty 0, which is a moment no boss
  // has ever existed in — the first one arrives at level 5, minutes into a run,
  // by which point both it and the megalodon have been through the linear
  // per-difficulty term and the global ramp. Comparing the two bases was
  // measuring the one instant the comparison does not describe, and it made the
  // check fight any honest retune of a starting number: the shark is 6.8x at
  // difficulty 0 and 9.0x by the time it is first seen.
  const R = CONFIG.spawn.ramp;
  const FIRST_BOSS_MIN = 3; // roughly when level 5 lands in a run that is going well
  const effHp = (def, minutes) => {
    const d = minutes * 60 * CONFIG.spawn.difficultyPerSecond;
    return (def.hp + (def.hpPerDifficulty ?? 0) * d) * (1 + Math.min(R.hpMax - 1, R.hp * d));
  };
  for (const boss of ['bossShark', 'bossOrca']) {
    const b = CONFIG.enemies[boss];
    const w = wildest[1];
    const ratio = effHp(b, FIRST_BOSS_MIN) / effHp(w, FIRST_BOSS_MIN);
    check(`${boss} is an order above ${wildest[0]}, the toughest thing the pool sends`,
      ratio >= 7.5, `${ratio.toFixed(1)}x at the first fight (${b.hp} base against ${w.hp})`);
    // AND IT HAS TO STAY THAT WAY. A big base with a flat curve is a boss that
    // is a wall at level 5 and a speed bump at level 25, which is the failure
    // this is really guarding: the ramp multiplies both, so what decides
    // whether the gap holds is the per-difficulty term.
    check(`...and pulls further ahead as the run goes on`,
      b.hpPerDifficulty / b.hp > w.hpPerDifficulty / w.hp * 0.9,
      `${b.hpPerDifficulty}/pt against ${w.hpPerDifficulty}/pt`);
  }

  // --- health outruns damage ---------------------------------------------
  // The whole shape of the ask: a boss should get much harder to kill over a
  // run and only somewhat harder to survive. Measured at ten minutes, where
  // difficulty is 30 at the default clock of one point per 20 seconds.
  for (const boss of ['bossShark', 'bossOrca']) {
    const d = CONFIG.enemies[boss];
    const at = (diff) => ({
      hp: (d.hp + d.hpPerDifficulty * diff) * difficultyRamp('hp', diff),
      dmg: (d.contactDamage + (d.contactDamagePerDifficulty ?? 0) * diff) * difficultyRamp('damage', diff),
    });
    const early = at(9);   // ~3 minutes, about where the first boss lands
    const late = at(30);   // ~10 minutes
    const hpGrowth = late.hp / early.hp;
    const dmgGrowth = late.dmg / early.dmg;
    check(`${boss}: health scales harder than damage across a run`,
      hpGrowth > dmgGrowth * 1.5,
      `hp x${hpGrowth.toFixed(1)} against damage x${dmgGrowth.toFixed(1)} from 3min to 10min`);
  }

  // --- the ceilings ------------------------------------------------------
  // A single hit. The number handed in is deliberately absurd — a barrel at
  // the damage cap on top of a lunge on top of everything — because what is
  // being checked is that there IS a ceiling, not where a particular perk
  // happens to sit under it.
  resetBossDamageCap();
  const huge = capBossDamage(9999, 'boss:barrels', HP, 0);
  check('no single boss hit can empty the bar',
    huge < HP, `${huge.toFixed(1)} of ${HP}`);
  check('...and it is capped as a FRACTION of the bar, so it holds at any size',
    (() => { resetBossDamageCap(); return capBossDamage(9999, 'boss:barrels', 400, 0) / 400; })()
      === huge / HP,
    'same fraction of a 400hp bar as of a 100hp one');

  // A whole second of it. This is the one that covers contact damage, which
  // arrives as fifty slices a second and sails under any per-hit ceiling.
  resetBossDamageCap();
  let taken = 0;
  for (let i = 0; i < 60; i++) taken += capBossDamage(50, 'bossShark', HP, i / 60);
  check('a second of everything a boss has cannot empty the bar either',
    taken < HP, `${taken.toFixed(1)} of ${HP} across 60 frames of contact`);

  // ...and the budget REFILLS, or the cap would be a one-second shield that
  // makes a boss harmless for the rest of the fight.
  const second = capBossDamage(50, 'bossShark', HP, 3);
  check('...and the budget refills once that second has passed', second > 0,
    `${second.toFixed(1)} on the next second`);

  // THE CONTROL. Everything that is not a boss goes through the same funnel
  // and must come out untouched — a school of barracuda shredding you is the
  // fight working, and this cap is not a global damage nerf.
  resetBossDamageCap();
  check('ordinary wildlife is not capped',
    capBossDamage(9999, 'shark', HP, 0) === 9999
    && capBossDamage(9999, 'enemy shot', HP, 0) === 9999);

  // And it still kills. A ceiling that made a boss survivable by standing in
  // it would have replaced one bad fight with a worse one.
  resetBossDamageCap();
  let t = 0;
  let hp = HP;
  while (hp > 0 && t < 30) { hp -= capBossDamage(200, 'bossShark', HP, t); t += 1 / 60; }
  check('a boss standing on you still kills you, and quickly', t < 3,
    `dead in ${t.toFixed(2)}s of unbroken contact at full tilt`);
  resetBossDamageCap();
}

console.log(`\n${failures ? `${failures} FAILED` : 'all good'}\n`);
process.exit(failures ? 1 : 0);
