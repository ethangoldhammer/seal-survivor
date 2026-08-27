#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:nightlife
//
// Sunset swaps the cast. Creatures tagged `bioluminescent` in enemies.csv fade
// into the spawn pool as it gets dark and everything else fades out, so the
// night is mostly glowing bodies rather than the daylight ocean with a few
// lights in it. Each section is a bug with a plausible way of happening:
//
//   1. CLOCK    The run opens at the player's own time of day and then runs
//               on at its own rate. Pinning it to the wall clock would stop
//               the sky; seeding it from startHour would ignore the request.
//   2. TAG      The CSV column reaches CONFIG.enemies as a boolean, and only
//               the rows that carry it. A flag column parsed like a number
//               would arrive as NaN, which is falsy — the feature would do
//               nothing at all and say nothing about it.
//   3. READY    Every tagged creature can actually be drawn: asset key, model
//               file on disk, glow preset, passable gates. Node can't render,
//               so this is the substitute — and it catches the one failure
//               that is invisible here and obvious in the browser, a missing
//               model quietly falling back to a coloured ball.
//   4. RAMP     Both curves, crossing. One at a time would still pass a
//               "spawns at night" test while looking like nothing changed.
//   5. SPAWNER  The REAL updateSpawning across a real clock: no lanternfish in
//               an afternoon, plenty in a night. Proves the weights are
//               consulted rather than computed by a helper nobody calls.
//   6. REAL RUN Cold boot, difficulty from zero, population churned — the
//               numbers a player would describe, including the share of
//               bodies on screen that glow.
//   7. NO CLOCK With the day/night cycle switched off there is no sunset to
//               wait for, so BOTH curves have to stand down — the suppression
//               one especially, or most of the roster vanishes from every run.
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
import { skyLight, dayState, updateDayCycle, resetDayCycle, setNightLock, nightLockedAt } from '../path/src/systems/daylight.js';
import { pickCrab } from '../path/src/systems/crabSpawner.js';

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

// ---------------------------------------------------------------------------
// Determinism.
//
// Everything below that spawns anything is a Monte Carlo simulation: the pool
// is a weighted roll, the school sizes are rolls, and the churn that keeps the
// arena from filling picks its victims at random. Left on the real Math.random
// the shares those runs report move by several points between invocations, and
// two of the checks here compare such a share against 0.5 — so the file failed
// roughly one run in four, on an unchanged tree, which teaches everyone that a
// red run means "run it again".
//
// So the generator is replaced wholesale for the whole file. Every block below
// reseeds before it starts, which is what makes each one hermetic: adding a
// check to an earlier section cannot shift the numbers a later one reports, and
// a failure can be reproduced by running the file again rather than by running
// it until it happens.
//
// mulberry32 — small, fast, and good enough for a spawn table.
function seedRandom(seed) {
  let a = seed >>> 0;
  Math.random = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
seedRandom(1);

const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const pct = (v) => `${(v * 100).toFixed(0)}%`;

// Park the clock at an hour and publish the bus, the same way a paused tuning
// session does. `paused` is what makes updateDayCycle read scrubHour instead of
// integrating, so this is the game's own scrubbing path rather than a back
// door that could drift from it.
function setHour(h) {
  CONFIG.dayNight.paused = true;
  CONFIG.dayNight.scrubHour = h;
  updateDayCycle(0);
}

// Derived from the orbit rather than hardcoded to 0h, for the reason spelled
// out at the night-lock section: midnight silently stops being the darkest
// moment if riseHour moves.
function darkestHour() {
  return (((CONFIG.dayNight.orbit.riseHour + 18) % 24) + 24) % 24;
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
// Taken around the dial rather than as a plain subtraction, because the clock
// this section seeds from is the WALL clock: run the suite between 23:00 and
// midnight and the hour hand crosses 24 during these 30 seconds, wraps to 0,
// and a raw difference reports -23h of travel for an hour of movement. The
// check then failed for one hour in every twenty-four, on an unchanged tree,
// which is the same "run it again" lesson the seeding above exists to stop
// teaching — just on a clock instead of a die. `expected` is an hour, so
// there is no ambiguity about which way round the dial to read it.
const moved = (((dayState.hours - before) % 24) + 24) % 24;
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

// SUMMONED, not drawn. A row with spawnRateMul 0 is deliberately invisible to
// the weighted pool and is put on the seabed by a dedicated system instead —
// today that is both crabs, via systems/crabSpawner.js. Every check below that
// counts POOL spawns has to exclude them, or it is asserting that a creature
// appears through a door it was explicitly locked out of.
//
// They are not simply skipped: SUMMONED CHANGEOVER at the bottom of this file
// exercises their real path, so `spawnRateMul: 0` cannot become a quiet way to
// opt a creature out of the night-gating checks altogether.
const summoned = new Set(Object.entries(CONFIG.enemies)
  .filter(([, def]) => (def.spawnRateMul ?? 1) === 0)
  .map(([key]) => key));
const pooled = tagged.filter((k) => !summoned.has(k));

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
  // game" and never once appear. `spawnRateMul: 0` is that gate slammed shut —
  // unless the creature is summoned rather than drawn, in which case it is the
  // intended state and the pool is simply not its door. See `summoned`.
  const reachable = summoned.has(key)
    ? (def.maxConcurrent ?? Infinity) >= 1
    : (def.weight ?? 0) > 0 && (def.spawnRateMul ?? 1) > 0 && (def.maxConcurrent ?? Infinity) >= 1;
  check(`${key}: its gates are passable`, reachable,
    summoned.has(key)
      ? `summoned by a dedicated system (spawnRateMul 0), cap ${def.maxConcurrent ?? '∞'}, minDiff ${def.minDifficulty ?? 0}`
      : `weight ${def.weight} x${def.spawnRateMul ?? 1}, cap ${def.maxConcurrent ?? '∞'}, minDiff ${def.minDifficulty ?? 0} (${((def.minDifficulty ?? 0) / CONFIG.spawn.difficultyPerSecond).toFixed(0)}s), minLvl ${def.minPlayerLevel ?? 0}`);
}

// ---------------------------------------------------------------------------
section('RAMP — two curves crossing, following the sun');

const NL = CONFIG.spawn.nightlife;

setHour(12);
check('midday holds the glowing roster out entirely', nightlifeWeight(true) === NL.glowing.day,
  `glowing x${nightlifeWeight(true).toFixed(3)}, night ${skyLight.night.toFixed(3)}, phase ${dayState.phase}`);
check('...and lets the daylight roster run at full rate',
  Math.abs(nightlifeWeight(false) - NL.daylight.day) < 1e-6,
  `daylight x${nightlifeWeight(false).toFixed(3)}`);

setHour(0);
check('midnight lets the glowing roster in at full rate',
  Math.abs(nightlifeWeight(true) - NL.glowing.night) < 1e-6,
  `glowing x${nightlifeWeight(true).toFixed(3)}, night ${skyLight.night.toFixed(3)}, phase ${dayState.phase}`);
check('...and pushes the daylight roster down',
  Math.abs(nightlifeWeight(false) - NL.daylight.night) < 1e-6,
  `daylight x${nightlifeWeight(false).toFixed(3)}`);
check('...far enough that the swap is a swap, not a garnish',
  nightlifeWeight(false) < 0.25,
  `daylight species keep ${(nightlifeWeight(false) * 100).toFixed(0)}% of their weight after dark`);

// Walk the evening minute by minute and collect both curves, so "it ramps" is
// measured rather than asserted at one hand-picked hour.
const evening = [];
for (let h = 17; h <= 21.01; h += 1 / 60) {
  setHour(h);
  evening.push({ h, w: nightlifeWeight(true), d: nightlifeWeight(false) });
}
const partial = evening.filter((s) => s.w > 1e-6 && s.w < NL.glowing.night - 1e-6);
check('dusk is a fade, not a switch', partial.length > 0,
  partial.length
    ? `${partial.length} min between first light and full: ${partial[0].h.toFixed(2)}h → ${partial[partial.length - 1].h.toFixed(2)}h`
    : 'weight jumps straight from day to night');
check('...and it only ever climbs as the sun drops',
  evening.every((s, i) => i === 0 || s.w >= evening[i - 1].w - 1e-6));
check('...while the daylight roster only ever falls, over the same window',
  evening.every((s, i) => i === 0 || s.d <= evening[i - 1].d + 1e-6)
    && evening.some((s) => s.d > 1e-6 && s.d < NL.daylight.day - 1e-6),
  'the two curves cross rather than one waiting for the other');

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
  seedRandom(11);
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
// GLOWING IS A PROPERTY OF THE BODY, not of the species. This used to read
// `CONFIG.enemies[type].bioluminescent`, which was the same question while
// every glowing creature was a creature that only existed after dark. It
// stopped being the same question when species grew a `nightAsset`: those keep
// one row, one id and no tag, and change into a luminous body at dusk (see the
// asset pick in entities/enemies.js spawnOne). Counting the tag would have
// reported the night getting dimmer as more of it started to glow.
//
// So it asks the ASSET THE INDIVIDUAL WAS ACTUALLY BUILT FROM — `assetKey` is
// resolved once at spawn and carried on the creature for exactly this reason —
// and whether that asset carries a `biolumSkin`. A fish that spawned in
// daylight and lived into the night still counts as dark, which is correct:
// it really is still wearing its day body.
//
// ...AND WHETHER THAT SKIN IS A LAMP OR A COAT OF PAINT. Carrying a
// `biolumSkin` at all stopped meaning "glows" once the same generator became
// the game's texture replacer: the reef fish, the tuna, the hammerhead and the
// two boats all wear one as PIGMENT and all spawn at noon, so a bare
// `!!biolumSkin` counted 766 daylight arrivals as glowing and reported the
// night gate as broken. The preset's own `luminous` flag is the roster half of
// that split — the same question tools/biolum-skin-test.mjs asks, resolved
// through `base` the same way, so the two files cannot drift apart.
const isLuminousPreset = (name) => {
  const root = CONFIG.biolumSkin ?? {};
  const preset = root.presets?.[name];
  if (!preset) return false;
  return (preset.luminous ?? root.base?.luminous ?? true) !== false;
};
const isGlowBody = (e) => {
  const skin = ASSETS[e?.assetKey]?.biolumSkin;
  return !!skin && isLuminousPreset(skin);
};

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
      if (isGlowBody(enemies[n])) {
        glowing += 1;
        if (firstGlowAt == null) firstGlowAt = gs.time;
      }
    }

    while (enemies.length > TARGET_ALIVE) {
      removeEnemy(scene, Math.floor(Math.random() * enemies.length));
    }

    // Closed at the END of each completed minute, so a `minutes`-long run
    // reports exactly `minutes` buckets of exactly one minute each. Bucketing
    // on `i % framesPerMinute` instead pushes at the START of each minute,
    // which quietly drops the final one on the floor: a three-minute run came
    // back with two buckets, and the "third minute" the check below names was
    // never actually measured — it read minute two, the noisiest one there is.
    if ((i + 1) % Math.round(60 / dt) === 0) {
      perMinute.push({ minute: perMinute.length + 1, spawned, glowing, hour: dayState.hours });
      spawned = 0; glowing = 0;
    }
  }
  // What is actually on screen when the run ends — the number a player would
  // describe. It differs from the spawn share because schools arrive in
  // different sizes and persist for different lengths of time, so neither one
  // stands in for the other.
  const aliveGlowing = enemies.filter(isGlowBody).length;
  return { perMinute, firstGlowAt, bySpecies, aliveGlowing, alive: enemies.length };
}

// Opening after dark is the case the whole feature exists for.
//
// Run it twenty-five times from fixed seeds rather than once. One run of a
// weighted spawn table is a sample, and the two "majority" checks below compare
// such a sample against 0.5 — near enough to the real value that a single run
// lands on either side of it depending on the rolls. Averaging is still exactly
// reproducible (the seeds are fixed) and moves the number being asserted on
// from "what one run happened to do" to "what this roster does at night", which
// is the claim the checks are actually making.
//
// Twenty-five and not five because of the spread on the second check: the share
// of BODIES runs a standard deviation of about 7.5 points between seeds, so a
// five-run average still carries ±7 of slack — enough that the first five seeds
// tried here averaged 51% against a true value of 57%, which would have frozen
// a misleading number in place just as effectively as the flake did. At
// twenty-five the standard error is ~1.5 points and both checks clear 0.5 by
// several of them. The cost is ~0.8s; the file still finishes in about one.
const NIGHT_SEEDS = Array.from({ length: 25 }, (_, i) => i + 1);
const nightRuns = NIGHT_SEEDS.map((s) => { seedRandom(s); return playRun(22, 3); });
const nightRun = nightRuns[0];
const nightTotals = nightRun.perMinute.reduce(
  (a, m) => ({ spawned: a.spawned + m.spawned, glowing: a.glowing + m.glowing }),
  { spawned: 0, glowing: 0 });
const nightShare = nightTotals.glowing / Math.max(1, nightTotals.spawned);

check('a run that opens at night puts one on screen quickly',
  nightRun.firstGlowAt != null && nightRun.firstGlowAt < 90,
  nightRun.firstGlowAt == null
    ? 'none in three minutes'
    : `first at ${nightRun.firstGlowAt.toFixed(0)}s (minDifficulty alone costs ${(CONFIG.enemies.lanternfish.minDifficulty / CONFIG.spawn.difficultyPerSecond).toFixed(0)}s)`);

// The point of the second curve, measured once the roster's OWN gates are out
// of the way. minDifficulty keeps the lanternfish out for the first 22
// seconds and the ray and the shark want player levels 3 and 5, so the
// opening minute of any run is necessarily daylight-cast whatever the sun is
// doing — averaging across it measures the gates, not the swap. The share by
// the third minute is the one that says whether night looks like night.
const settledShares = nightRuns.map((r) => {
  const m = r.perMinute[r.perMinute.length - 1];
  return m.glowing / Math.max(1, m.spawned);
});
const settledShare = mean(settledShares);
check('...and they are the MAJORITY of what spawns once their own gates are past',
  settledShare > 0.5,
  `${pct(settledShare)} of the final minute's spawns, across ${NIGHT_SEEDS.length} seeded runs`
  + ` (${settledShares.map(pct).join(' ')})`
  + ` — seed 1 by minute: ${nightRun.perMinute.map((m) => `${m.minute}: ${pct(m.glowing / Math.max(1, m.spawned))}`).join(', ')}`
  + `, ${pct(nightShare)} averaged over all ${nightTotals.spawned} of its spawns`);

// The share of BODIES, which is the number a player would describe. Its
// ceiling is not the weight curve at all — it is maxConcurrent, since the
// glowing roster can only field 45 + 4 + 2 at once no matter how the pool is
// weighted. Worth stating in the failure text, because the instinct when this
// number disappoints is to reach for the suppression dial, and past a point
// that dial has stopped being what's binding.
//
// Averaged over the same five runs, and for a stronger reason than the spawn
// share above: this one is a single instant rather than a minute's worth of
// arrivals, so it is the noisiest number in the file — across seeds it ranges
// from the low 50s to the high 60s. One sample of it landing under half proves
// nothing about the roster, which is exactly how this check spent its time
// failing on trees nobody had touched.
const aliveShares = nightRuns.map((r) => r.aliveGlowing / Math.max(1, r.alive));
const aliveShare = mean(aliveShares);
// Both halves of the night cast, because both can be on screen glowing: the
// tagged roster that only exists after dark, and the dual species that changed
// into a luminous body at dusk. Counting only the first understated the
// ceiling by most of it and would send whoever read this failure to the
// suppression dial over a cap that was never binding.
const glowCap = pooled
  .concat(Object.keys(CONFIG.enemies).filter((k) => CONFIG.enemies[k].nightAsset))
  .reduce((a, k) => a + (CONFIG.enemies[k].maxConcurrent ?? Infinity), 0);
check('...and the majority of the bodies on screen', aliveShare > 0.5,
  `${pct(aliveShare)} of the bodies alive at lights-out, across ${NIGHT_SEEDS.length} seeded runs`
  + ` (${aliveShares.map(pct).join(' ')})`
  + `; seed 1 ended ${nightRun.aliveGlowing} of ${nightRun.alive}`
  + `. The glowing roster's own maxConcurrent totals ${glowCap}, which caps this at ${pct(Math.min(1, glowCap / nightRun.alive))}`);

seedRandom(21);
const dayRun = playRun(9, 3);
const dayGlow = dayRun.perMinute.reduce((a, m) => a + m.glowing, 0);
check('a run that opens in the morning has none of them', dayGlow === 0,
  `${dayGlow} glowing spawns before the clock reaches dusk`);

// The cycle is short enough that one run crosses it twice, so the cast has to
// visibly turn over rather than being decided once at boot.
seedRandom(31);
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
for (const key of pooled) {
  const n = fullRun.bySpecies.get(key) ?? 0;
  const def = CONFIG.enemies[key];
  check(`${key} gets its turn over two nights`, n > 0,
    `${n} spawned — weight ${def.weight}+${def.weightPerDifficulty ?? 0}/d, cap ${def.maxConcurrent ?? '∞'}, needs difficulty ${def.minDifficulty ?? 0} and level ${def.minPlayerLevel ?? 0}`);
}

// ---------------------------------------------------------------------------
section('NO CLOCK — the gate stands down when there is no day to wait out');

CONFIG.dayNight.enabled = false;
updateDayCycle(0);
check('a world with no night still spawns the glowing roster', nightlifeWeight(true) > 0,
  `glowing x${nightlifeWeight(true).toFixed(3)} with dayNight.enabled = false`);
// The mirror matters more: a suppression curve that stayed on with no clock to
// lift it would quietly delete most of the roster from every run.
check('...and does NOT suppress everything else forever', nightlifeWeight(false) > 0.5,
  `daylight x${nightlifeWeight(false).toFixed(3)}`);
CONFIG.dayNight.enabled = true;

CONFIG.spawn.nightlife.enabled = false;
check('...and so does switching the gate off',
  nightlifeWeight(true) === 1 && nightlifeWeight(false) === 1);
CONFIG.spawn.nightlife.enabled = true;

// ---------------------------------------------------------------------------
section('NIGHT LOCK — the dev-only clock pin');

// The hour setNightLock() picks, derived the same way it derives it: half a
// turn past sunrise, where the sun's elevation is exactly -1. Hardcoding
// midnight would silently stop being the darkest moment if riseHour moved.
{
  const darkest = (((CONFIG.dayNight.orbit.riseHour + 18) % 24) + 24) % 24;
  CONFIG.dayNight.enabled = true;
  CONFIG.dayNight.paused = true;
  CONFIG.dayNight.scrubHour = darkest;
  updateDayCycle(0);
  check('the locked hour is the darkest one there is', skyLight.night >= 0.999,
    `${darkest}h -> sun elevation ${dayState.sun.elevation.toFixed(2)}, night ${skyLight.night.toFixed(2)}`);
  check('...and the glowing roster is at full spawn weight there',
    nightlifeWeight(true) >= 0.999, `glowing x${nightlifeWeight(true).toFixed(3)}`);

  // What the N-key lineup prints. Called bare, nightlifeWeight returns the
  // DAYLIGHT curve, which made the "the sun is up" hint fire at midnight and
  // stay silent at noon — the exact opposite of the advice it exists to give.
  CONFIG.dayNight.scrubHour = (darkest + 12) % 24;
  updateDayCycle(0);
  check('the lineup hint fires in daylight, not in the dark',
    nightlifeWeight(true) < 0.5 && skyLight.night < 0.5,
    `noon: glowing x${nightlifeWeight(true).toFixed(2)}, night ${skyLight.night.toFixed(2)}`);

  CONFIG.dayNight.paused = false;
}

// ---------------------------------------------------------------------------
section('SUMMONED CHANGEOVER — the roster the weighted pool never sees');

// Crabs are drawn by systems/crabSpawner.js, not by the pool, so every
// pool-based check above skips them (see `summoned`). This is the path they DO
// take. Without it, `spawnRateMul: 0` would be a silent way to opt a creature
// out of night-gating entirely — it would pass the whole file by not being
// looked at.
{
  const DRAWS = 2000;
  const LATE = 99; // past every crab's minDifficulty
  const sample = (hour, difficulty) => {
    seedRandom(41);
    setHour(hour);
    const counts = new Map();
    for (let i = 0; i < DRAWS; i++) {
      const k = pickCrab(difficulty);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  };

  // Noon: the glowing curve is 0, so the night crab must be unreachable —
  // not merely rare. This is the check that would catch a changeover wired up
  // backwards, which looks fine at midnight and wrong all day.
  const noonHour = (darkestHour() + 12) % 24;
  const noon = sample(noonHour, LATE);
  check('at noon every crab that walks on is the daytime one',
    (noon.get('emberCrab') ?? 0) === 0,
    [...noon].map(([k, n]) => `${k} ${n}`).join(', '));

  // Full dark: the daylight curve drops to 0.08, so the ember crab should be
  // the clear majority without the day crab vanishing — a straggler rate, the
  // same shape the rest of the roster gets.
  const dark = sample(darkestHour(), LATE);
  const emberShare = (dark.get('emberCrab') ?? 0) / DRAWS;
  check('in the dark the ember crab is the majority of arrivals',
    emberShare > 0.5,
    `${(emberShare * 100).toFixed(0)}% ember — ${[...dark].map(([k, n]) => `${k} ${n}`).join(', ')}`);
  check('...and the daytime crab still turns up occasionally',
    (dark.get('walkingCrab') ?? 0) > 0,
    `${dark.get('walkingCrab') ?? 0} of ${DRAWS} draws`);

  // The CSV's minDifficulty has to bind here too. spawnNamed does not enforce
  // it — only the pool does — so a crab summoner that ignored it would put the
  // late-game variant on the seabed in the opening seconds of a run.
  const early = sample(darkestHour(), 0);
  check('the night crab respects its minDifficulty even at midnight',
    (early.get('emberCrab') ?? 0) === 0,
    `difficulty 0 vs emberCrab's minDifficulty ${CONFIG.enemies.emberCrab.minDifficulty}`);

  CONFIG.dayNight.paused = false;
}

// The production path. import.meta.env.DEV is undefined under the Node loader,
// which is the same falsy it is in a built bundle — so this asserts what a
// player's build does: nothing at all, whatever the URL or the console says.
check('the night lock is inert outside dev', setNightLock(true) === 'night lock is dev-only');
check('...and leaves the clock unlocked', nightLockedAt() === null);

console.log(failures === 0 ? '\nPASS — all checks' : `\nFAIL — ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
