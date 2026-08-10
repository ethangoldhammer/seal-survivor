#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:nightlife
//
// The nocturnal spawn gate: creatures tagged `bioluminescent` in enemies.csv
// are held out of the spawn pool while the sun is up, fade in across dusk, and
// come back out at dawn. Four things are checked, and each one is a bug that
// has a plausible way of happening:
//
//   1. TAG      The CSV column reaches CONFIG.enemies as a boolean, and only
//               the rows that carry it. A flag column parsed like a number
//               would arrive as NaN, which is falsy — the feature would do
//               nothing at all and say nothing about it.
//   2. RAMP     nightlifeWeight() is 0 in daylight, 1 in the dark, and
//               somewhere between the two at dusk. A threshold that fired all
//               at once would still pass a "spawns at night" test.
//   3. SPAWNER  Driving the REAL updateSpawning across a real clock: no
//               lanternfish in an afternoon, plenty in a night. This is the
//               one that proves the weight is actually consulted, rather than
//               a helper nobody calls.
//   4. NO CLOCK With the day/night cycle switched off there is no sunset to
//               wait for, so the gate has to stand down rather than delete the
//               species from every run.
//
// No renderer, on purpose: the browser preview suspends requestAnimationFrame,
// so a screenshot proves nothing about a loop. Every number below comes from
// ticking the same functions main.js ticks.
//
//   node --import ./tools/vite-loader.mjs tools/nightlife-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { ASSETS } from '../path/src/assets.js';
import { enemies, resetEnemies, removeEnemy, updateSpawning, nightlifeWeight } from '../path/src/entities/enemies.js';
import { skyLight, dayState, updateDayCycle, resetDayCycle } from '../path/src/systems/daylight.js';

const scene = new THREE.Scene();
const dt = 1 / 60;
let failures = 0;

// The animation controller warns once per state per creature for the clips a
// procedural stand-in doesn't have, which in Node is all of them. Correct, and
// pure noise here.
const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[animation]') || msg.startsWith('[assets]'))) return;
  realWarn(msg, ...rest);
};

function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

// Park the clock at an hour and publish the bus, the same way a paused tuning
// session does. `paused` is what makes updateDayCycle read scrubHour instead of
// integrating, so this is the game's own scrubbing path rather than a back
// door that could drift from it.
function setHour(h) {
  CONFIG.dayNight.paused = true;
  CONFIG.dayNight.scrubHour = h;
  updateDayCycle(0);
}

// ---------------------------------------------------------------------------
section('CLOCK START — the run opens at the player\'s own time of day');

// Run first, before anything below parks the clock for scrubbing.
CONFIG.dayNight.paused = false;
CONFIG.dayNight.enabled = true;

CONFIG.dayNight.startFromSystemClock = true;
resetDayCycle(true);
const now = new Date();
const realHour = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
check('a fresh clock reads the system time',
  Math.abs(dayState.hours - realHour) < 1 / 60,
  `game ${dayState.hours.toFixed(3)}h, system ${realHour.toFixed(3)}h`);
// Only a machine that isn't on UTC can tell the two apart, so on a UTC box
// (CI, most containers) this says so rather than claiming a pass it didn't earn.
const tzOffset = -now.getTimezoneOffset() / 60;
const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
if (tzOffset === 0) {
  console.log(`  SKIP  local-vs-UTC — this machine is on UTC, the two are the same hour`);
} else {
  check('...local time, not UTC', Math.abs(dayState.hours - utcHour) > 0.5,
    `local ${dayState.hours.toFixed(2)}h vs UTC ${utcHour.toFixed(2)}h, offset ${tzOffset}h`);
}

// The seed must not turn into a leash: the cycle has to keep running at
// `scale` afterwards, or the sky would sit still all run.
const before = dayState.hours;
const seconds = 30;
for (let i = 0; i < Math.round(seconds / dt); i++) updateDayCycle(dt);
const expected = (seconds * CONFIG.dayNight.scale * (CONFIG.dayNight.rate ?? 1)) / 3600;
const moved = dayState.hours - before;
check('...then runs on at the configured rate, not at real time',
  Math.abs(moved - expected) < 1e-3,
  `${seconds}s of play moved the clock ${moved.toFixed(2)}h, expected ${expected.toFixed(2)}h`);
check('...which is faster than a real clock', expected > seconds / 3600 * 2,
  `${(expected * 3600 / seconds).toFixed(0)}x real time`);

CONFIG.dayNight.startFromSystemClock = false;
resetDayCycle(true);
check('switching it off goes back to startHour',
  Math.abs(dayState.hours - CONFIG.dayNight.startHour) < 1e-9,
  `${dayState.hours.toFixed(2)}h, startHour ${CONFIG.dayNight.startHour}`);
CONFIG.dayNight.startFromSystemClock = true;

// Which species are tagged, straight off the live config the CSV has been
// applied to.
const tagged = Object.entries(CONFIG.enemies)
  .filter(([, def]) => def.bioluminescent)
  .map(([key]) => key);

// ---------------------------------------------------------------------------
section('TAG — enemies.csv carries the flag through to the live roster');

check('at least one creature is tagged bioluminescent', tagged.length > 0, tagged.join(', ') || 'none');
check('the lanternfish is one of them', tagged.includes('lanternfish'));
check('...and it is a boolean, not a stray NaN',
  CONFIG.enemies.lanternfish.bioluminescent === true,
  `${JSON.stringify(CONFIG.enemies.lanternfish.bioluminescent)}`);
check('the ordinary fish is NOT tagged', !CONFIG.enemies.fish.bioluminescent);

// ---------------------------------------------------------------------------
section('READY TO SPAWN — every variant, front to back');

// Each tagged creature is walked from its row to the file it draws with. Node
// can't render, so this is the substitute: everything the browser needs to put
// the thing on screen, checked where it can be checked.
//
// The model check matters more than it looks. createVisual falls back to a
// procedural icosahedron when a model is missing and only warns — which the
// harnesses suppress, because in Node it is ALWAYS missing. So a creature with
// a typo'd path passes every other test in this file and shows up in the game
// as a coloured ball. Reading the path off the asset and stat'ing the file is
// the only part of "does it look right" that survives having no GL context.
const PUBLIC = new URL('../public/', import.meta.url);
const presets = CONFIG.biolumSkin?.presets ?? {};

for (const key of tagged) {
  const def = CONFIG.enemies[key];
  const asset = ASSETS[def.asset];
  check(`${key}: its asset key resolves`, asset != null, `asset '${def.asset}'`);
  if (!asset) continue;

  if (asset.model) {
    const file = new URL(`.${asset.model}`, PUBLIC);
    check(`${key}: the model file is on disk`, existsSync(file),
      `${asset.model}${asset.meshIndex != null ? ` (mesh ${asset.meshIndex})` : ''}`);
  } else {
    check(`${key}: procedural, no model to miss`, !!asset.shape, `shape '${asset.shape}'`);
  }

  // The glow is the entire reason these exist, so an untagged asset or a
  // preset name with no preset behind it is a creature that spawns looking
  // like an ordinary dark fish — the exact thing that reads as "not working".
  check(`${key}: the asset carries a glow`, !!asset.biolumSkin,
    asset.biolumSkin ? `preset '${asset.biolumSkin}'` : 'no biolumSkin on the asset');
  if (typeof asset.biolumSkin === 'string') {
    check(`${key}: ...and the preset exists`, presets[asset.biolumSkin] != null,
      `'${asset.biolumSkin}' of ${Object.keys(presets).join(', ')}`);
  }

  // A gate nothing can pass is the quietest way for a creature to be "in the
  // game" and never once appear.
  const reachable = (def.weight ?? 0) > 0 && (def.spawnRateMul ?? 1) > 0
    && (def.maxConcurrent ?? Infinity) >= 1;
  check(`${key}: its gates are passable`, reachable,
    `weight ${def.weight} x${def.spawnRateMul ?? 1}, cap ${def.maxConcurrent ?? '∞'}, minDiff ${def.minDifficulty ?? 0} (${((def.minDifficulty ?? 0) / CONFIG.spawn.difficultyPerSecond).toFixed(0)}s), minLvl ${def.minPlayerLevel ?? 0}`);
}

// ---------------------------------------------------------------------------
section('RAMP — the gate follows the sun, and does it gradually');

setHour(12);
const noon = nightlifeWeight();
check('midday holds them out entirely', noon === CONFIG.spawn.nightlife.day,
  `weight ${noon.toFixed(3)}, night ${skyLight.night.toFixed(3)}, phase ${dayState.phase}`);

setHour(0);
const midnight = nightlifeWeight();
check('midnight lets them in at full rate', Math.abs(midnight - CONFIG.spawn.nightlife.night) < 1e-6,
  `weight ${midnight.toFixed(3)}, night ${skyLight.night.toFixed(3)}, phase ${dayState.phase}`);

// Walk the evening minute by minute and collect the weights, so "it ramps" is
// measured rather than asserted at one hand-picked hour.
const evening = [];
for (let h = 17; h <= 21.01; h += 1 / 60) {
  setHour(h);
  evening.push({ h, w: nightlifeWeight() });
}
const partial = evening.filter((s) => s.w > 1e-6 && s.w < CONFIG.spawn.nightlife.night - 1e-6);
check('dusk is a fade, not a switch', partial.length > 0,
  partial.length
    ? `${partial.length} min between first light and full: ${partial[0].h.toFixed(2)}h → ${partial[partial.length - 1].h.toFixed(2)}h`
    : 'weight jumps straight from day to night');
check('...and it only ever climbs as the sun drops',
  evening.every((s, i) => i === 0 || s.w >= evening[i - 1].w - 1e-6));

const firstOn = evening.find((s) => s.w > 1e-6);
check('...starting after the sun is down, not before',
  firstOn != null && dayState.sun.elevation !== undefined && firstOn.h > 18,
  firstOn ? `first spawn weight at ${firstOn.h.toFixed(2)}h (sunset ~18h)` : 'never turns on');

// ---------------------------------------------------------------------------
section('SPAWNER — the real spawn loop, over an afternoon and over a night');

// Enough difficulty that the lanternfish's own minDifficulty gate is long
// past; the only thing that can still be holding it back is the sun.
const gameState = { difficulty: 6, level: 8 };

function runSpawner(hour, seconds) {
  resetEnemies(scene);
  setHour(hour);
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) updateSpawning(dt, gameState, scene);
  const counts = new Map();
  for (const e of enemies) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  return counts;
}

const day = runSpawner(14, 60);
check('an afternoon spawns creatures at all', day.size > 0,
  `${enemies.length} bodies across ${day.size} species`);
check('...and not one lanternfish', (day.get('lanternfish') ?? 0) === 0,
  `${day.get('lanternfish') ?? 0} lanternfish`);

const night = runSpawner(23, 60);
check('a night spawns lanternfish', (night.get('lanternfish') ?? 0) > 0,
  `${night.get('lanternfish') ?? 0} lanternfish out of ${enemies.length} bodies`);
check('...alongside the rest of the roster, not instead of it', night.size > 1,
  `${night.size} species: ${[...night.keys()].join(', ')}`);

// Per-species coverage is checked in A REAL RUN below rather than here. It
// needs churn: this helper lets the arena fill to spawn.maxAlive and stop, so
// the whole sample is the first thirty seconds, and whether a weight-0.07
// species appears in it is a coin toss. Asserting on that is how you get a
// test that fails every fourth run and teaches everyone to re-run it.

// Dawn has to undo it — this is the only spawn gate in the game that reopens
// and then closes again, and a one-way latch would look identical for the
// first night of a run.
const morning = runSpawner(9, 60);
check('morning shuts the gate again', (morning.get('lanternfish') ?? 0) === 0,
  `${morning.get('lanternfish') ?? 0} lanternfish`);

// ---------------------------------------------------------------------------
section('A REAL RUN — cold boot, clock running, nobody scrubbing anything');

// Everything above parks the clock and hands pickType a difficulty. That is
// the right way to test a rule in isolation and the wrong way to answer "why
// am I not seeing these in the game", because it skips the whole boot path:
// the clock seeding itself, difficulty climbing from zero, the species' own
// minDifficulty, and the arena filling up. This section runs the loop main.js
// runs and only reads the result.
//
// The population is churned rather than left to pile up. Without that the
// arena pins at spawn.maxAlive inside 30 seconds and the cast freezes on
// whatever spawned first — every later minute would report the same numbers
// and a gate that had stopped working would look identical to one that hadn't.
const TARGET_ALIVE = 70; // roughly what a player who is keeping up holds
const isGlow = (type) => !!CONFIG.enemies[type]?.bioluminescent;

function playRun(startHour, minutes) {
  CONFIG.dayNight.paused = false;
  CONFIG.dayNight.startFromSystemClock = false;
  CONFIG.dayNight.startHour = startHour;
  resetEnemies(scene);
  resetDayCycle(true);

  const gs = { time: 0, difficulty: 0, level: 1 };
  const perMinute = [];
  const bySpecies = new Map();
  let spawned = 0; let glowing = 0; let firstGlowAt = null;

  for (let i = 0; i < Math.round(minutes * 60 / dt); i++) {
    gs.time += dt;
    gs.difficulty = gs.time * CONFIG.spawn.difficultyPerSecond;
    // The real curve is xp-driven; any gate that reads level just wants a
    // number that climbs, and this one climbs slower than a real run's.
    gs.level = 1 + Math.floor(gs.time / 45);
    updateDayCycle(dt);

    const before = enemies.length;
    updateSpawning(dt, gs, scene);
    for (let n = before; n < enemies.length; n++) {
      const t = enemies[n].type;
      spawned += 1;
      bySpecies.set(t, (bySpecies.get(t) ?? 0) + 1);
      if (isGlow(t)) {
        glowing += 1;
        if (firstGlowAt == null) firstGlowAt = gs.time;
      }
    }

    while (enemies.length > TARGET_ALIVE) {
      removeEnemy(scene, Math.floor(Math.random() * enemies.length));
    }

    if (i > 0 && i % Math.round(60 / dt) === 0) {
      perMinute.push({ minute: perMinute.length + 1, spawned, glowing, hour: dayState.hours });
      spawned = 0; glowing = 0;
    }
  }
  return { perMinute, firstGlowAt, bySpecies };
}

// Opening after dark is the case the whole feature exists for.
const nightRun = playRun(22, 3);
const nightTotals = nightRun.perMinute.reduce(
  (a, m) => ({ spawned: a.spawned + m.spawned, glowing: a.glowing + m.glowing }),
  { spawned: 0, glowing: 0 });
const nightShare = nightTotals.glowing / Math.max(1, nightTotals.spawned);

check('a run that opens at night puts one on screen quickly',
  nightRun.firstGlowAt != null && nightRun.firstGlowAt < 90,
  nightRun.firstGlowAt == null
    ? 'none in three minutes'
    : `first at ${nightRun.firstGlowAt.toFixed(0)}s (minDifficulty alone costs ${(CONFIG.enemies.lanternfish.minDifficulty / CONFIG.spawn.difficultyPerSecond).toFixed(0)}s)`);

// A floor, not a target. Below this they are technically spawning and you
// would still never notice one, which is indistinguishable from broken.
check('...and enough of them to notice', nightShare > 0.05,
  `${(nightShare * 100).toFixed(0)}% of ${nightTotals.spawned} spawns over 3 minutes`);

const dayRun = playRun(9, 3);
const dayGlow = dayRun.perMinute.reduce((a, m) => a + m.glowing, 0);
check('a run that opens in the morning has none of them', dayGlow === 0,
  `${dayGlow} glowing spawns before the clock reaches dusk`);

// The cycle is short enough that one run crosses it twice, so the cast has to
// visibly turn over rather than being decided once at boot.
const fullRun = playRun(16, 14);
const dark = fullRun.perMinute.filter((m) => m.glowing / Math.max(1, m.spawned) > 0.05);
const light = fullRun.perMinute.filter((m) => m.glowing === 0);
check('across a full cycle the cast turns over both ways',
  dark.length > 0 && light.length > 0,
  `${dark.length} min with glowing spawns, ${light.length} min with none, of ${fullRun.perMinute.length}`);
console.log(`        ${fullRun.perMinute.map((m) => `${m.hour.toFixed(0)}h:${(m.glowing / Math.max(1, m.spawned) * 100).toFixed(0)}%`).join('  ')}`);

// Per species, over that same fourteen minutes — two full nights, with the
// population churning, which is what a rare variant needs to get its turn.
// The aggregate share above can look healthy on the strength of the common one
// while a variant behind a level gate or capped at two never appears at all:
// exactly the failure you'd read as "we have three of these and I've only seen
// one". Two nights is also roughly the longest run anyone plays, so a species
// that misses this window effectively isn't in the game.
for (const key of tagged) {
  const n = fullRun.bySpecies.get(key) ?? 0;
  const def = CONFIG.enemies[key];
  check(`${key} gets its turn over two nights`, n > 0,
    `${n} spawned — weight ${def.weight}+${def.weightPerDifficulty ?? 0}/d, cap ${def.maxConcurrent ?? '∞'}, needs difficulty ${def.minDifficulty ?? 0} and level ${def.minPlayerLevel ?? 0}`);
}

// ---------------------------------------------------------------------------
section('NO CLOCK — the gate stands down when there is no day to wait out');

CONFIG.dayNight.enabled = false;
updateDayCycle(0);
check('a world with no night still spawns them', nightlifeWeight() > 0,
  `weight ${nightlifeWeight().toFixed(3)} with dayNight.enabled = false`);
CONFIG.dayNight.enabled = true;

CONFIG.spawn.nightlife.enabled = false;
check('...and so does switching the gate off', nightlifeWeight() === 1);
CONFIG.spawn.nightlife.enabled = true;

console.log(failures === 0 ? '\nPASS — all checks' : `\nFAIL — ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
