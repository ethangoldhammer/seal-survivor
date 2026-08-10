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
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enemies, resetEnemies, updateSpawning, nightlifeWeight } from '../path/src/entities/enemies.js';
import { skyLight, dayState, updateDayCycle } from '../path/src/systems/daylight.js';

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

// Dawn has to undo it — this is the only spawn gate in the game that reopens
// and then closes again, and a one-way latch would look identical for the
// first night of a run.
const morning = runSpawner(9, 60);
check('morning shuts the gate again', (morning.get('lanternfish') ?? 0) === 0,
  `${morning.get('lanternfish') ?? 0} lanternfish`);

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
