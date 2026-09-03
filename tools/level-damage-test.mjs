#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:leveldamage            [--sweep]
//
// THE TWO HALVES OF ONE CONVERSATION: how much health a boss brings, and how
// much damage the seal has when it arrives. This file is where they are read
// against each other, because until they were put on the same axis they could
// not be.
//
// WHAT WAS WRONG. A boss arrives BECAUSE of a level — every fifth one, see
// CONFIG.boss.everyLevels — and its health was decided by the run CLOCK.
// spawn.ramp.hp compounds every 20 seconds and a late level takes over a
// minute to earn, so a boss grew about 1.3x per minute while the seal's
// baseline growth arrived per level. A sum against a product: measured on the
// naked gun, the level-20 boss took ten times the pebbles of the level-10 one
// and the level-25 boss twenty. It also punished a slow, careful run twice —
// for the minutes it spent, with a boss that had been growing the whole time.
//
// WHAT CHANGED. Two things, and they are halves of each other:
//
//   CONFIG.spawn.bossHp        a boss's health is measured on an axis derived
//                              from the level that summoned it. Same units,
//                              same ramp, same caps — only the number going in
//                              is different. Wildlife still reads the clock,
//                              which is right: what swims past at minute ten
//                              should be minute ten's water.
//
//   CONFIG.weapon              baseline damage COMPOUNDS per level, on all four
//     .damageMulPerLevel       of DAMAGE_STATS (stats.js) — the gun, the
//                              strike, everything thrown, every escort — the
//                              damage twin of player.hpPerLevel.
//
// THE GUN IS A PROXY. The multiplier lands on all four damage stats at once,
// so the pebble's time-to-kill moves exactly as the strike's does; section 4
// proves it. The pebble is what is measured because it is the one weapon every
// run has with no cards, and because its dps is arithmetic — damage x pellets
// / seconds per volley — rather than a simulation. Cards multiply on top; the
// claim here is only that the FLOOR holds its shape.
//
// The ladder comes from npm run test:xp, spawned rather than transcribed: a
// copied "level 20 lands at 10.5 minutes" would go stale the first time the xp
// economy was retuned and this table would be measuring the wrong minute with
// nothing to say so. It is only used to price the OLD clock-keyed column and
// the wildlife around the fight — the boss itself no longer cares what minute
// it is, which is the entire point.
//
// Look here before moving any of: spawn.bossHp.perLevel, spawn.bossHp.first,
// weapon.damageMulPerLevel, weapon.damagePerLevel, spawn.ramp.hp, or a boss
// row's hp in enemies.csv.
//
// Pure arithmetic against the real config, the real CSVs and the real
// stats.js — no scene, no creatures, no renderer.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { execFileSync } from 'node:child_process';
import {
  CONFIG, difficultyRamp, lateGameMul, enemyPaceMul, bossDifficulty,
} from '../path/src/config.js';
import { baseStats, applyLevelGrowth, applyBossGrowth } from '../path/src/stats.js';
import { enemies, resetEnemies, spawnNamed, setSpawnLevel } from '../path/src/entities/enemies.js';

const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[animation]') || msg.startsWith('[assets]'))) return;
  realWarn(msg, ...rest);
};

const SWEEP = process.argv.includes('--sweep');
let fails = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
const r2 = (n) => Math.round(n * 100) / 100;
const pad = (s, n) => String(s).padStart(n);

// --- the ladder -------------------------------------------------------------
function readLadder() {
  const out = execFileSync(process.execPath,
    ['--import', './tools/vite-loader.mjs', 'tools/xp-economy-test.mjs'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
  // "        20   10.5m   (+50s)" — the first ladder printed is the shipped
  // player model (hunt 7s, clear 80%); the sensitivity block prints no rungs.
  const rungs = new Map([[1, 0]]);
  for (const line of out.split('\n')) {
    const m = /^\s+(\d+)\s+([\d.]+)m\s+\(\+\d+s\)/.exec(line);
    if (m && !rungs.has(+m[1])) rungs.set(+m[1], +m[2]);
  }
  if (rungs.size < 10) throw new Error(`could not read the ladder out of npm run test:xp — ${rungs.size} rungs parsed`);
  return rungs;
}

// Minute a level lands. Past the last rung the modelled run is over — it is a
// fifteen-minute run — so later levels extrapolate at the last measured gap and
// the table marks them. Only the clock-keyed column depends on this.
function minuteAt(ladder, level) {
  if (ladder.has(level)) return { min: ladder.get(level), extrapolated: false };
  const levels = [...ladder.keys()].sort((a, b) => a - b);
  const last = levels[levels.length - 1];
  const prev = levels[levels.length - 2];
  const gap = ladder.get(last) - ladder.get(prev);
  return { min: ladder.get(last) + gap * (level - last), extrapolated: true };
}

// --- the boss ---------------------------------------------------------------
// The same two assemblies spawnOne resolves, kept side by side so the change
// can be read as a difference rather than taken on trust. Duplicated here the
// way tools/xp-economy-test.mjs duplicates the spawn maths, and for the same
// reason: spawnOne needs a scene.
const BOSS_KEYS = Object.keys(CONFIG.enemies)
  .filter((k) => k.startsWith('boss') && !CONFIG.enemies[k].bossMinion);

/** What a boss's health WAS: the run clock, plus the level surcharge. */
function hpOnClock(key, difficulty, level) {
  const def = CONFIG.enemies[key];
  return (def.hp + (def.hpPerDifficulty ?? 0) * difficulty)
    * difficultyRamp('hp', difficulty) * lateGameMul('hp', level) * enemyPaceMul('hp');
}
/** What it is now: one axis, derived from the level that summoned it. */
function hpOnLevel(key, level) {
  const def = CONFIG.enemies[key];
  const axis = bossDifficulty(level);
  return (def.hp + (def.hpPerDifficulty ?? 0) * axis)
    * difficultyRamp('hp', axis) * enemyPaceMul('hp');
}
const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
const medianOnLevel = (level) => median(BOSS_KEYS.map((k) => hpOnLevel(k, level)));
const medianOnClock = (d, level) => median(BOSS_KEYS.map((k) => hpOnClock(k, d, level)));

// --- the gun ----------------------------------------------------------------
function block(level, bossesDefeated, rate = CONFIG.weapon.damageMulPerLevel) {
  const saved = CONFIG.weapon.damageMulPerLevel;
  CONFIG.weapon.damageMulPerLevel = rate;
  try {
    const s = baseStats();
    applyLevelGrowth(s, level);
    applyBossGrowth(s, bossesDefeated);
    return s;
  } finally {
    CONFIG.weapon.damageMulPerLevel = saved;
  }
}
// Un-carded: every pellet is `damage`, `multishot` of them a volley, a volley
// every `fireRate` seconds. The per-stack multishot damage curve belongs to the
// CARD (multishotLevelStats) and free pellets do not ride it.
const dps = (s) => s.damage * s.multishot / s.fireRate;

const every = CONFIG.boss?.everyLevels ?? 5;
const rate = CONFIG.weapon.damageMulPerLevel ?? 0;
const perSec = CONFIG.spawn.difficultyPerSecond;
const bossCfg = CONFIG.spawn?.bossHp ?? {};

console.log('\nreading the ladder from npm run test:xp...');
const ladder = readLadder();
const FIGHTS = [1, 2, 3, 4, 5, 6].map((k) => k * every);

function fight(level, r = rate) {
  const { min, extrapolated } = minuteAt(ladder, level);
  const difficulty = min * 60 * perSec;
  const s = block(level, level / every - 1, r);
  const hp = medianOnLevel(level);
  const wasHp = medianOnClock(difficulty, level);
  return {
    level, min, extrapolated, difficulty, hp, wasHp, dps: dps(s),
    ttk: hp / dps(s), wasTtk: wasHp / dps(s),
  };
}
const rows = FIGHTS.map((L) => fight(L));
const at = (L) => rows.find((r) => r.level === L);

console.log(`\nTHE FIGHTS — the median boss at each ${every}th level, against the un-carded gun`);
console.log(`        spawn.bossHp  first ${bossCfg.first}  perLevel ${bossCfg.perLevel}`
  + `        weapon.damageMulPerLevel ${rate}  (x${r2((1 + rate) ** 19)} by level 20)`);
console.log('        level    axis    boss hp     gun         ttk  |  ON THE CLOCK: minute   boss hp      ttk');
for (const c of rows) {
  console.log(`        ${pad(c.level, 5)}   ${pad(bossDifficulty(c.level).toFixed(1), 5)}`
    + `  ${pad(Math.round(c.hp), 9)}  ${pad(Math.round(c.dps), 5)} dps  ${pad(Math.round(c.ttk) + 's', 6)}`
    + `  |  ${pad(c.min.toFixed(1) + 'm' + (c.extrapolated ? '*' : ' '), 14)} ${pad(Math.round(c.wasHp), 9)}  ${pad(Math.round(c.wasTtk) + 's', 6)}`);
}
console.log('        *minute extrapolated past the modelled run — the level-keyed column does not use it');

if (SWEEP) {
  console.log('\nSWEEP — naked-gun time-to-kill by spawn.bossHp.perLevel');
  console.log('        perLevel ' + FIGHTS.map((L) => pad(`L${L}`, 7)).join(''));
  const saved = bossCfg.perLevel;
  for (const p of [1.2, 1.5, 1.7, 1.8, 1.9, 2.0, 2.2, 2.5]) {
    CONFIG.spawn.bossHp.perLevel = p;
    const t = FIGHTS.map((L) => medianOnLevel(L) / dps(block(L, L / every - 1)));
    console.log(`        ${p.toFixed(2)}     ` + t.map((v) => pad(Math.round(v) + 's', 7)).join(''));
  }
  CONFIG.spawn.bossHp.perLevel = saved;
  console.log('\nSWEEP — the same, by weapon.damageMulPerLevel');
  console.log('        rate    x@L20 ' + FIGHTS.map((L) => pad(`L${L}`, 7)).join(''));
  for (const r of [0, 0.02, 0.035, 0.05, 0.07]) {
    const t = FIGHTS.map((L) => fight(L, r).ttk);
    console.log(`        ${r.toFixed(3)}   ${pad(r2((1 + r) ** 19), 5)} ` + t.map((v) => pad(Math.round(v) + 's', 7)).join(''));
  }
}

console.log('\n1. TIME DOES NOT DECIDE A BOSS\'S HEALTH');
{
  ok(bossCfg.enabled !== false, 'spawn.bossHp is on');
  ok(bossDifficulty(20) != null, 'bossDifficulty returns an axis rather than deferring to the clock');
  // The claim in one line: the same level at two wildly different minutes is
  // the same fight. hpOnLevel takes no minute at all, so this proves nothing
  // SNEAKS one in — a future edit that reaches for the run clock inside the
  // boss branch fails right here.
  const fast = at(4 * every);
  ok(Math.abs(fast.hp - medianOnLevel(20)) < 1e-9,
    `the level-20 boss is ${Math.round(fast.hp)} hp at any pace — it was ${Math.round(fast.wasHp)} on a 10.5-minute run and still climbing`);
  ok(bossDifficulty(every) === bossCfg.first,
    `the opening fight sits at the authored difficulty — ${bossCfg.first}`);
  ok(bossDifficulty(every - 1) === bossCfg.first && bossDifficulty(1) === bossCfg.first,
    'nothing below the first boss level pays anything — the axis starts at the first fight');
  // Compared with a tolerance rather than for equality: 4.5 + 1.9 - 4.5 is
  // 1.9000000000000004 in binary floating point, and a harness that fails on
  // that is a harness nobody reads.
  ok(Math.abs(bossDifficulty(every + 1) - bossDifficulty(every) - bossCfg.perLevel) < 1e-9,
    `...and each level after it adds exactly perLevel — ${bossCfg.perLevel}`);
}

console.log('\n2. AND THE REAL SPAWNER AGREES — measured off creatures, not off arithmetic');
{
  // Everything above this line is arithmetic that MIRRORS spawnOne. This
  // section spawns real bodies through the real spawnNamed and reads the hp
  // that got baked onto them, the way tools/pace-test.mjs does, because the
  // claim being made is a claim about spawnOne and nothing else can check it.
  //
  // It is also the only thing that can catch the wiring failure this change can
  // actually have: the axis is chosen from an opts flag, and spawnNamed used to
  // DROP its opts on the floor. A flag that never arrives spawns a clock-keyed
  // boss and says nothing.
  const scene = new THREE.Scene();
  const born = (key, difficulty, level, opts) => {
    resetEnemies(scene);
    setSpawnLevel(level);
    const e = spawnNamed(scene, key, difficulty, { x: 0, y: 0 },
      { ignoreCaps: true, overfill: true, ...opts });
    return e?.maxHp ?? null;
  };
  const KEY = 'bossShark';

  // THE HEADLINE, through the shipped code path: the same boss, summoned at the
  // same level, one minute into the run and forty minutes into it.
  const rushed = born(KEY, 0, 20, { boss: true });
  const crawled = born(KEY, 180, 20, { boss: true });
  ok(rushed != null && rushed === crawled,
    `a level-20 boss is ${Math.round(rushed)} hp at difficulty 0 and at difficulty 180 — the clock cannot reach it`);
  ok(Math.abs(rushed - hpOnLevel(KEY, 20)) < 1e-6,
    'and it is the number this file has been printing — the table above is spawnOne, not a story about it');

  // ...and the level does reach it, which is the other half of the claim.
  const early = born(KEY, 0, every, { boss: true });
  ok(rushed > early * 2,
    `the level that summons it is what decides it — ${Math.round(early)} hp at level ${every}, ${Math.round(rushed)} at level 20`);

  // WITHOUT the flag it is wildlife again, and the clock is back. This is the
  // regression guard for spawnNamed dropping opts: if the flag stops arriving,
  // these two stop differing and the line above stops being true.
  const asWildlife = born(KEY, 180, 20, {});
  ok(asWildlife > crawled,
    `the same body spawned without the flag still rides the clock — ${Math.round(asWildlife)} hp at difficulty 180`);

  // ORDINARY CREATURES ARE UNTOUCHED, through the same path.
  const fishEarly = born('fish', 5, 20, {});
  const fishLate = born('fish', 45, 20, {});
  ok(fishLate > fishEarly * 5,
    `a fish still reads the clock — ${Math.round(fishEarly)} hp at difficulty 5, ${Math.round(fishLate)} at 45`);
  resetEnemies(scene);
  void enemies;
}

console.log('\n3. THE FIGHTS TRACK THE SEAL INSTEAD OF RUNNING AWAY');
{
  const ref = at(2 * every);
  const l20 = at(4 * every);
  const l25 = at(5 * every);
  ok(l20.wasTtk / l20.ttk >= 3,
    `the level-${l20.level} boss: ${Math.round(l20.wasTtk)}s on the clock → ${Math.round(l20.ttk)}s on the level axis`);
  ok(l25.wasTtk / l25.ttk >= 3,
    `the level-${l25.level} boss: ${Math.round(l25.wasTtk)}s → ${Math.round(l25.ttk)}s`);
  ok(l20.ttk <= ref.ttk * 2.5,
    `...and level ${l20.level} is within 2.5x level ${ref.level} for the naked gun — ${Math.round(l20.ttk)}s against ${Math.round(ref.ttk)}s`);
  ok(l20.ttk > ref.ttk,
    '...but still longer, so a late boss demands a build rather than being a formality');
  // A boss that gets EASIER as the run goes on is the failure this curve can
  // actually reach: spawn.ramp.hp caps (hpMax), and past that only the row's
  // linear term grows while the gun keeps compounding. Nothing warns; the
  // fights just quietly soften. Assert the shape, not a number.
  const inverted = rows.slice(1).filter((r, i) => r.ttk < rows[i].ttk * 0.95);
  ok(inverted.length === 0,
    inverted.length ? `the curve turns over at level ${inverted.map((r) => r.level).join(', ')} — spawn.ramp.hpMax (${CONFIG.spawn.ramp.hpMax}) is capping the boss before the run ends`
      : `the fight gets longer every time, all the way to level ${FIGHTS[FIGHTS.length - 1]}`);
  ok(rows[0].ttk >= 15 && rows[0].ttk <= 60,
    `the opening boss is a fight and not a wall — ${Math.round(rows[0].ttk)}s naked`);
}

console.log('\n4. THE SEAL\'S HALF — it compounds, on every damage stat and only those');
{
  const one = block(1, 0, 0); const twenty = block(20, 0, 0); const grown = block(20, 0, rate);
  const mul = (1 + rate) ** 19;
  ok(rate > 0, `weapon.damageMulPerLevel is set — ${rate}`);
  ok(mul <= 3, `...and is worth less than a build by level 20 — x${r2(mul)}, under x3`);
  ok(one.damage === baseStats().damage, 'level 1 is untouched — the opening gun is exactly weapons.csv');
  for (const k of ['damage', 'strikeDamage', 'abilityDamageMul', 'companionDamageMul']) {
    ok(Math.abs(grown[k] / twenty[k] - mul) < 1e-9, `${k} at level 20: x${r2(grown[k] / twenty[k])}`);
  }
  for (const k of ['maxHp', 'fireRate', 'speed', 'multishot', 'thrust', 'aoeMul']) {
    ok(grown[k] === twenty[k], `${k} is left alone`);
  }
}

console.log('\n5. a flat damage card keeps the share it bought');
{
  // Card first, growth second — a +damage card taken at level 20 is worth its
  // face value times the multiplier, exactly as a +max-health card is.
  const bare = applyLevelGrowth(baseStats(), 20);
  const carded = baseStats(); carded.damage += 10; applyLevelGrowth(carded, 20);
  const worth = carded.damage - bare.damage;
  ok(Math.abs(worth - 10 * (1 + rate) ** 19) < 1e-9,
    `+10 taken at level 20 is worth ${r2(worth)}, the card times x${r2((1 + rate) ** 19)}`);
}

console.log('\n6. wildlife still reads the clock — this was a boss change');
{
  const fish = CONFIG.enemies.fish;
  const early = (fish.hp + fish.hpPerDifficulty * 5) * difficultyRamp('hp', 5);
  const late = (fish.hp + fish.hpPerDifficulty * 45) * difficultyRamp('hp', 45);
  ok(late / early > 5,
    `a fish at difficulty 45 is x${r2(late / early)} the one at difficulty 5 — the roster ramp is untouched`);
  ok(lateGameMul('hp', 28) > 1,
    `...and the level surcharge still reaches wildlife past ${CONFIG.spawn.lateGame.from} — x${r2(lateGameMul('hp', 28))} at level 28`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall good');
process.exit(fails ? 1 : 0);
