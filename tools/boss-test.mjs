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
import { bounds } from '../path/src/arena.js';
import { inSpawnGroup, spawnGroupsOf } from '../path/src/enemyTable.js';
import { updateBoss, resetBoss, bossState, bossBanner } from '../path/src/systems/boss.js';
import { parseBossNameCsv, rollBossName, FALLBACK_BOSS_NAME } from '../path/src/bossNameTable.js';

const here = dirname(fileURLToPath(import.meta.url));
const NAMES_CSV = resolve(here, '../path/src/bossNames.csv');

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
// The orca and the dolphin are apex but are NOT sharks; if they ever get swept
// into the tighter cap, the apex allowance quietly becomes 2 for everything.
check('the orca is apex but not a shark',
  inSpawnGroup(CONFIG.enemies.orca, 'apex') && !inSpawnGroup(CONFIG.enemies.orca, 'shark'));

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
  const gaps = [];
  const firsts = [];

  // Fifty runs, each levelling straight through to 60 with the boss killed the
  // instant it appears — so what is measured is the schedule, not a fight.
  for (let run = 0; run < 50; run++) {
    resetEnemies(scene);
    resetBoss(seeded(run + 1));
    const gameState = { difficulty: 5, level: 1, running: true };
    const arrivals = [];
    for (let level = 1; level <= 60; level++) {
      gameState.level = level;
      updateBoss(gameState, scene); // spawn, if this level is the one
      if (bossState.enemy) {
        arrivals.push(level);
        removeEnemy(scene, enemies.indexOf(bossState.enemy)); // by INDEX, not by creature
        updateBoss(gameState, scene); // notice the kill
      }
    }
    firsts.push(arrivals[0]);
    for (let i = 1; i < arrivals.length; i++) gaps.push(arrivals[i] - arrivals[i - 1]);
  }

  const min = Math.min(...gaps);
  const max = Math.max(...gaps);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  check(`every gap is ${cfg.everyLevelsMin}-${cfg.everyLevelsMax} levels`,
    min >= cfg.everyLevelsMin && max <= cfg.everyLevelsMax, `saw ${min}-${max}, mean ${mean.toFixed(1)}`);
  check('the gap actually varies', new Set(gaps).size > 1,
    `${new Set(gaps).size} distinct gaps over ${gaps.length} bosses`);
  check(`the first boss lands in levels ${cfg.everyLevelsMin}-${cfg.everyLevelsMax}`,
    firsts.every((f) => f >= cfg.everyLevelsMin && f <= cfg.everyLevelsMax),
    `saw ${Math.min(...firsts)}-${Math.max(...firsts)}`);
}

// ---------------------------------------------------------------------------
section('THE BOSS — one at a time, and it is giant');
// ---------------------------------------------------------------------------
resetEnemies(scene);
{
  const gameState = { difficulty: 5, level: 1, running: true };
  resetBoss(seeded(7));
  const due = bossState.nextLevel;

  gameState.level = due - 1;
  updateBoss(gameState, scene);
  check('no boss before its level', bossState.enemy === null, `due at ${due}`);
  check('...and no bar to draw', bossBanner() === null);

  gameState.level = due;
  const boss = updateBoss(gameState, scene);
  check('the boss arrives on its level', boss != null && bossState.enemy === boss);
  check('it has a name', typeof bossState.name === 'string' && bossState.name.length > 2, bossState.name);
  check('the bar reads full', bossBanner()?.frac === 1);

  // The size step has to move the model AND the hitbox by the same factor — a
  // boss you can shoot through the nose of is the failure this catches, and it
  // is invisible in a screenshot. Measured against a CONTROL: the same
  // creature spawned through the ordinary door, so the comparison is with the
  // body the CSV describes rather than with a number typed here.
  const wanted = CONFIG.boss.sizeMul;
  const control = spawnNamed(scene, CONFIG.boss.enemy, gameState.difficulty, undefined, { ignoreCaps: true });
  check(`the hitbox is ${wanted}x an unscaled ${CONFIG.boss.enemy}`,
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
  updateBoss(gameState, scene);
  check('a level-up mid-fight does not send a second boss',
    enemies.filter((e) => e.type === CONFIG.boss.enemy).length === 1,
    `${enemies.filter((e) => e.type === CONFIG.boss.enemy).length} in the water`);

  // The bar tracks damage.
  bossState.enemy.hp = bossState.enemy.maxHp * 0.25;
  updateBoss(gameState, scene);
  check('the bar follows its health', Math.abs((bossBanner()?.frac ?? 0) - 0.25) < 1e-6,
    `${((bossBanner()?.frac ?? 0) * 100).toFixed(0)}%`);

  // A boss holds a shark slot: the whole point of tagging it `apex shark`.
  check('the boss counts as a shark', isShark(bossState.enemy));

  removeEnemy(scene, enemies.indexOf(bossState.enemy));
  updateBoss(gameState, scene);
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
  for (let i = 0; i < 400; i++) rolled.add(rollBossName(parts, rng));
  check('names vary', rolled.size > 40, `${rolled.size} distinct names in 400 rolls`);
  check('every name is non-empty and single-line',
    [...rolled].every((n) => n.trim().length > 3 && !n.includes('\n')));
  // The bar is a fixed-width strip; a 60-character name would wrap or clip.
  const longest = [...rolled].reduce((a, b) => (a.length > b.length ? a : b));
  check('no name is long enough to wrap the bar', longest.length <= 34, `longest: "${longest}"`);
  // "Grimtide the Tidebreaker" reads as a bug rather than as a name. Tested on
  // a rigged table where the echo is the ONLY epithet available, so the answer
  // is deterministic: drop the epithet rather than print the echo.
  const echoOnly = parseBossNameCsv(
    'id,slot,text\na,prefix,Grim\nb,root,tide\nc,epithet,the Tidebreaker', quiet);
  check('an epithet that echoes the root is dropped, not printed',
    rollBossName(echoOnly, seeded(5)) === 'Grimtide', rollBossName(echoOnly, seeded(5)));

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
    check(`${label} → fallback`, rollBossName(broken, seeded(3)) === FALLBACK_BOSS_NAME,
      rollBossName(broken, seeded(3)));
  }
  // ...but a file with no EPITHETS is not broken, it is a shorter name.
  const noEpithets = parseBossNameCsv('id,slot,text\na,prefix,Gore\nb,root,maw', quiet);
  check('no epithets → a bare name, not a fallback', rollBossName(noEpithets, seeded(3)) === 'Goremaw',
    rollBossName(noEpithets, seeded(3)));
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
  resetBoss(seeded(7));
  for (let i = 0; i < 30 * 90; i++) updateSpawning(dt, gameState, scene);
  const before = enemies.length;
  check('the arena is populated before the boss arrives', before > 10, `${before} creatures`);
  const turtleBefore = enemies.filter((e) => e.type === 'seaTurtle').length;

  // Straight past the threshold rather than waiting for it — the cadence is
  // the section above's job, and this one is about what happens on arrival.
  gameState.level = bossState.nextLevel;
  const boss = updateBoss(gameState, scene);
  check('a boss arrived', !!boss, boss ? boss.type : 'none');

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

  const player = { x: 0, y: 0 };
  for (let i = 0; i < 30 * 30; i++) {
    updateEnemies(dt, scene, player, () => {}, () => {});
  }
  const stragglers = enemies.filter((e) => e !== boss && !e.def.bossMinion && e.speed > 0.01);
  check('30 seconds later they have all actually left', stragglers.length === 0,
    stragglers.length ? `${stragglers.length} still here: ${[...new Set(stragglers.map((e) => e.type))].join(', ')}` : '');
  check('the boss is still in the water', enemies.includes(boss));

  // The lockout. Whatever enemies.csv says today, the rule is the same: the
  // pool may only offer minions while a boss is alive.
  const roster = new Set();
  for (let i = 0; i < 30 * 120; i++) {
    updateSpawning(dt, gameState, scene);
    for (const e of enemies) if (e !== boss) roster.add(e.type);
  }
  const intruders = [...roster].filter((k) => !CONFIG.enemies[k]?.bossMinion);
  check('nothing but minions spawns during the fight', intruders.length === 0,
    intruders.length ? `got ${intruders.join(', ')}` : `minions: ${minionKeys.join(', ') || 'none tagged — a duel'}`);
  if (!minionKeys.length) {
    check('with no minions tagged, the fight really is a duel',
      enemies.length === 1 && enemies[0] === boss, `${enemies.length} in the water`);
  }

  // ...and it comes back. A lockout that never lifted would empty the ocean
  // for the rest of the run, which is the worst version of this bug because
  // the fight itself would look perfect.
  const idx = enemies.indexOf(boss);
  removeEnemy(scene, idx);
  updateBoss(gameState, scene); // notices the kill
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
  resetBoss(seeded(11));
  gameState.level = bossState.nextLevel;
  const second = updateBoss(gameState, scene);
  check('a second boss arrived', !!second);
  CONFIG.boss.enabled = false;
  updateBoss(gameState, scene);
  CONFIG.boss.enabled = true;
  check('disabling the boss clears the marker', second?.isBoss === false);
  check('...so the lockout lifts with it', bossLockout() === false);
}

console.log(`\n${failures ? `${failures} FAILED` : 'all good'}\n`);
process.exit(failures ? 1 : 0);
