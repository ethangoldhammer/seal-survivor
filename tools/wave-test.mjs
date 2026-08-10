#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:waves
//
// The wave pacing: the spawner alternates between a SURGE and a CALM instead
// of running as a flat tap, and the calm sends only small fish carrying a
// fraction of the usual chum. Six things are checked, each one a bug with a
// plausible way of happening:
//
//   1. CYCLE      The clock alternates, phases have the lengths the config
//                 asks for, and they drift the right way as the run goes on.
//   2. CURVE      Pressure is a swell, not a step — it climbs, holds and falls
//                 within a surge. A curve that were secretly binary would pass
//                 every "waves exist" test and feel like a light switch.
//   3. ROSTER     Driving the REAL updateSpawning: no predators spawn during a
//                 calm, and they come back during a surge. This is the one
//                 that proves the gate is consulted rather than being a helper
//                 nobody calls.
//   4. RESPITE    A calm actually is quieter — measured in creatures per
//                 second against the surge either side of it, not asserted.
//   5. CHUM       Fish spawned in a lull carry the reduced xp, on the instance
//                 (not the shared def, which would retroactively devalue every
//                 fish already in the water) — and their SCORE is untouched.
//   6. THROUGHPUT What the whole thing costs. Waves redistribute pressure;
//                 they are not meant to quietly multiply it. The measured
//                 cycle-average rate is printed at four points in a run so the
//                 trade is visible rather than assumed, and asserted to stay
//                 inside a band.
//
// No renderer, on purpose: the browser preview suspends requestAnimationFrame,
// so a screenshot proves nothing about a loop. Every number below comes from
// ticking the same functions main.js ticks.
//
//   node --import ./tools/vite-loader.mjs tools/wave-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enemies, resetEnemies, removeEnemy, updateSpawning } from '../path/src/entities/enemies.js';
import { waveState, updateWaves, resetWaves, waveSpawn, lullEligible } from '../path/src/systems/waves.js';
import { computeKillPoints } from '../path/src/systems/scoring.js';

const scene = new THREE.Scene();
const dt = 1 / 60;
let failures = 0;

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

// The MERGED value, not the literal in config.js. Saved tuning deep-merges over
// the defaults, so the difficulty rate a run actually uses is whatever is in
// imported-tuning.json — every duration below is quoted in seconds off THIS
// number rather than off the one in the source.
const DPS = CONFIG.spawn.difficultyPerSecond;
const W = CONFIG.spawn.waves;
const secs = (d) => (d / DPS).toFixed(0);

console.log(`  difficulty ${DPS}/s (a point every ${(1 / DPS).toFixed(1)}s)`);
console.log(`  surge ${W.surge.seconds}s ${W.surge.perDifficulty >= 0 ? '+' : ''}${W.surge.perDifficulty}/pt, max ${W.surge.max}s`);
console.log(`  calm  ${W.calm.seconds}s ${W.calm.perDifficulty}/pt, min ${W.calm.min}s`);

// ---------------------------------------------------------------------------
section('CYCLE — the run alternates, and the two phases drift apart');

// Walk the clock at a fixed difficulty and record every phase it completes.
// Only phases that both START and END inside the walk are recorded, so a
// half-finished one at either edge can't be reported as a short phase.
function walkPhases(difficulty, seconds) {
  resetWaves(difficulty);
  const done = [];
  let phase = waveState.phase;
  let t = 0;
  let started = false;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    updateWaves(dt, difficulty);
    t += dt;
    if (waveState.phase !== phase) {
      if (started) done.push({ phase, length: t });
      started = true;
      phase = waveState.phase;
      t = 0;
    }
  }
  return done;
}

const early = walkPhases(0, 200);
const surgesEarly = early.filter((p) => p.phase === 'surge');
const calmsEarly = early.filter((p) => p.phase === 'calm');

check('the clock alternates surge/calm, never repeating a phase',
  early.every((p, i) => i === 0 || p.phase !== early[i - 1].phase),
  early.map((p) => `${p.phase[0]}${p.length.toFixed(0)}`).join(' '));
check('both phases actually occur', surgesEarly.length > 0 && calmsEarly.length > 0,
  `${surgesEarly.length} surges, ${calmsEarly.length} calms in 200s`);
check('a surge at difficulty 0 runs its configured length',
  surgesEarly.every((p) => Math.abs(p.length - W.surge.seconds) < 0.1),
  `${surgesEarly[0]?.length.toFixed(2)}s, configured ${W.surge.seconds}s`);
check('...and a calm runs its own',
  calmsEarly.every((p) => Math.abs(p.length - W.calm.seconds) < 0.1),
  `${calmsEarly[0]?.length.toFixed(2)}s, configured ${W.calm.seconds}s`);

// A run that opens in a calm would open with nothing in the water.
resetWaves(0);
check('a fresh run opens in a surge', waveState.phase === 'surge', `phase '${waveState.phase}'`);
check('...at the bottom of its ramp, not at full pressure', waveState.pressure < 0.05,
  `pressure ${waveState.pressure.toFixed(3)} on frame one`);

// The drift is the late game closing in, expressed as pacing.
const late = walkPhases(40, 300);
const lateSurge = late.find((p) => p.phase === 'surge')?.length ?? 0;
const lateCalm = late.find((p) => p.phase === 'calm')?.length ?? 0;
check('surges grow as the run goes on', lateSurge > surgesEarly[0].length,
  `${surgesEarly[0].length.toFixed(0)}s at difficulty 0 → ${lateSurge.toFixed(0)}s at 40 (${secs(40)}s in)`);
check('...and calms shrink', lateCalm < calmsEarly[0].length,
  `${calmsEarly[0].length.toFixed(0)}s → ${lateCalm.toFixed(0)}s`);

// Both limits have to bind, or a long run keeps stretching until it is one
// endless surge (or a calm of negative length, which the clamp would turn into
// a one-second stutter).
const veryLate = walkPhases(200, 400);
check('the surge ceiling binds', Math.abs((veryLate.find((p) => p.phase === 'surge')?.length ?? 0) - W.surge.max) < 0.1,
  `${(veryLate.find((p) => p.phase === 'surge')?.length ?? 0).toFixed(1)}s, max ${W.surge.max}s`);
check('the calm floor binds', Math.abs((veryLate.find((p) => p.phase === 'calm')?.length ?? 0) - W.calm.min) < 0.1,
  `${(veryLate.find((p) => p.phase === 'calm')?.length ?? 0).toFixed(1)}s, min ${W.calm.min}s`);

// Respite as a share of the run, which is the thing a player actually feels.
for (const d of [0, 16, 40, 90]) {
  const p = walkPhases(d, 600);
  const s = p.find((x) => x.phase === 'surge')?.length ?? 0;
  const c = p.find((x) => x.phase === 'calm')?.length ?? 0;
  console.log(`        difficulty ${String(d).padStart(3)} (${secs(d).padStart(3)}s in): surge ${s.toFixed(0)}s / calm ${c.toFixed(0)}s — ${(c / (s + c) * 100).toFixed(0)}% respite`);
}

// ---------------------------------------------------------------------------
section('CURVE — a swell, not a switch');

// Sample pressure across one whole surge.
resetWaves(0);
const trace = [];
for (let i = 0; i < Math.round(W.surge.seconds / dt); i++) {
  updateWaves(dt, 0);
  if (waveState.phase !== 'surge') break;
  trace.push({ t: waveState.t, p: waveState.pressure });
}
const peak = Math.max(...trace.map((s) => s.p));
const mid = trace.filter((s) => s.p > 0.01 && s.p < 0.99);

check('pressure reaches the crest', peak > 0.99, `peak ${peak.toFixed(3)}`);
check('...having climbed to it rather than jumped', mid.length > 60,
  `${(mid.length * dt).toFixed(1)}s of the ${W.surge.seconds}s surge is spent partway up or down`);
check('...and it starts low', trace[0].p < 0.05, `${trace[0].p.toFixed(3)} at t=0`);
check('...and falls away before the calm', trace[trace.length - 1].p < 0.35,
  `${trace[trace.length - 1].p.toFixed(3)} at the end of the surge`);
check('the climb is monotonic up to the crest',
  (() => {
    const upTo = trace.slice(0, trace.findIndex((s) => s.p > 0.999));
    return upTo.every((s, i) => i === 0 || s.p >= upTo[i - 1].p - 1e-9);
  })());

// A calm is flat zero — the roster gate and the rate both key off that.
resetWaves(0);
let calmPressures = [];
for (let i = 0; i < Math.round(200 / dt); i++) {
  updateWaves(dt, 0);
  if (waveState.phase === 'calm') calmPressures.push(waveState.pressure);
}
check('a calm sits at zero pressure throughout', calmPressures.every((p) => p === 0),
  `${calmPressures.length} samples, max ${Math.max(...calmPressures).toFixed(3)}`);

// The lull window has to extend past the calm into the surge's ramps, or the
// roster flips on a single frame — a megalodon arriving the instant the calm
// ends is the thing the threshold exists to prevent.
resetWaves(0);
let lullDuringSurge = 0;
for (let i = 0; i < Math.round(W.surge.seconds / dt); i++) {
  updateWaves(dt, 0);
  if (waveState.phase !== 'surge') break;
  if (waveSpawn().lull) lullDuringSurge += dt;
}
check('the small-fish window spills into the surge, so the roster hands over',
  lullDuringSurge > 2 && lullDuringSurge < W.surge.seconds * 0.5,
  `${lullDuringSurge.toFixed(1)}s of the ${W.surge.seconds}s surge still sends fish only`);

// ---------------------------------------------------------------------------
section('ROSTER — who a calm is allowed to send');

const eligible = Object.entries(CONFIG.enemies).filter(([, def]) => lullEligible(def)).map(([k]) => k);
const excluded = Object.entries(CONFIG.enemies).filter(([, def]) => !lullEligible(def)).map(([k]) => k);

check('the lull pool is not empty', eligible.length > 0, eligible.join(', ') || 'none');
check('...and is small fish only', eligible.every((k) => CONFIG.enemies[k].radius <= W.lull.maxRadius && CONFIG.enemies[k].prey),
  `radii ${eligible.map((k) => CONFIG.enemies[k].radius).join(', ')} (max ${W.lull.maxRadius})`);
check('no apex predator is in it', !eligible.some((k) => CONFIG.enemies[k].spawnGroup === 'apex'),
  `excluded: ${excluded.slice(0, 8).join(', ')}${excluded.length > 8 ? ` +${excluded.length - 8}` : ''}`);
check('nothing that hunts is in it', !eligible.some((k) => CONFIG.enemies[k].hunt));

// Now the real spawner. High difficulty and level so nothing else is holding
// the predators back — the only gate left is the wave.
const gameState = { difficulty: 30, level: 12 };

// Ticks the real updateSpawning and reports what spawned during each phase.
// The population is churned so the arena can't pin at maxAlive and freeze the
// cast on whatever spawned first, which would make every later phase report
// the same numbers whether the gate worked or not.
const TARGET_ALIVE = 70;
function runPhases(seconds) {
  resetEnemies(scene);
  const log = [];
  let cur = null;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    const before = enemies.length;
    updateSpawning(dt, gameState, scene);
    // Read the phase AFTER the tick — updateSpawning advances the clock, so
    // this is the phase the spawns were actually made under.
    if (!cur || cur.phase !== waveState.phase) {
      cur = { phase: waveState.phase, seconds: 0, spawned: 0, types: new Map(), schools: new Map(), xp: [] };
      log.push(cur);
    }
    cur.seconds += dt;
    // Whether the spawner considered THIS tick a lull, not merely which phase
    // it was. The two differ on purpose across a surge's ramps, and every
    // assertion about the lull roster and the lull chum has to key off the
    // former or it is really asserting the ramps don't exist.
    const lullNow = waveSpawn().lull;
    for (let n = before; n < enemies.length; n++) {
      const e = enemies[n];
      cur.spawned += 1;
      cur.types.set(e.type, (cur.types.get(e.type) ?? 0) + 1);
      // Per SCHOOL, not per species: a phase accumulates many spawn ticks, so
      // a species tally answers "how many fish arrived over twelve seconds"
      // when the question is "how big was any one shoal".
      if (e.schoolId != null) cur.schools.set(e.schoolId, (cur.schools.get(e.schoolId) ?? 0) + 1);
      cur.xp.push({ type: e.type, xp: e.xp, def: e.def.xp, lull: lullNow });
    }
    while (enemies.length > TARGET_ALIVE) removeEnemy(scene, Math.floor(Math.random() * enemies.length));
  }
  // Drop the first and last entries: both are partial phases and their rates
  // are not comparable with the complete ones between them.
  return log.slice(1, -1);
}

const phases = runPhases(300);
const surges = phases.filter((p) => p.phase === 'surge');
const calms = phases.filter((p) => p.phase === 'calm');

check('the run produced complete phases of both kinds', surges.length > 1 && calms.length > 1,
  `${surges.length} surges, ${calms.length} calms over 300s at difficulty ${gameState.difficulty}`);

const calmTypes = new Set(calms.flatMap((p) => [...p.types.keys()]));
const surgeTypes = new Set(surges.flatMap((p) => [...p.types.keys()]));
const badInCalm = [...calmTypes].filter((k) => !lullEligible(CONFIG.enemies[k]));

check('a calm spawns nothing but small fish', badInCalm.length === 0,
  badInCalm.length ? `found ${badInCalm.join(', ')}` : `${[...calmTypes].join(', ')}`);
check('...and a surge brings the predators back', [...surgeTypes].some((k) => CONFIG.enemies[k]?.spawnGroup === 'apex'),
  `${[...surgeTypes].filter((k) => CONFIG.enemies[k]?.spawnGroup === 'apex').join(', ') || 'none — the roster never opens up'}`);
check('a calm still spawns SOMETHING — respite, not a dead arena',
  calms.every((p) => p.spawned > 0),
  `per calm: ${calms.map((p) => p.spawned).join(', ')}`);

// ---------------------------------------------------------------------------
section('RESPITE — the calm is measurably quieter');

const surgeRate = surges.reduce((a, p) => a + p.spawned, 0) / surges.reduce((a, p) => a + p.seconds, 0);
const calmRate = calms.reduce((a, p) => a + p.spawned, 0) / calms.reduce((a, p) => a + p.seconds, 0);

check('a calm spawns far less than a surge', calmRate < surgeRate * 0.5,
  `${calmRate.toFixed(2)}/s in a calm vs ${surgeRate.toFixed(2)}/s in a surge (${(calmRate / surgeRate * 100).toFixed(0)}%)`);
console.log(`        per phase: ${phases.map((p) => `${p.phase[0]}${(p.spawned / p.seconds).toFixed(1)}`).join(' ')}`);

// Schools have to be thinned too. Without the group multiplier one pick of a
// schooling species drops its whole authored school and undoes the respite in
// a single tick, and the per-second average above can hide that.
const authoredMax = Math.max(...eligible.map((k) => CONFIG.enemies[k].group?.max ?? 1));
const calmSchools = calms.flatMap((p) => [...p.schools.values()]);
const surgeSchools = surges.flatMap((p) => [...p.schools.values()]);
const biggestCalmSchool = Math.max(...calmSchools, 0);
const biggestSurgeSchool = Math.max(...surgeSchools, 0);

check('lull shoals arrive thinned, not at full size',
  biggestCalmSchool <= Math.round(authoredMax * W.lull.groupMul) + 1,
  `biggest shoal in a calm: ${biggestCalmSchool} fish (authored max ${authoredMax}, x${W.lull.groupMul} = ${Math.round(authoredMax * W.lull.groupMul)})`);
check('...while a surge still sends them at full size',
  biggestSurgeSchool > Math.round(authoredMax * W.lull.groupMul) + 1,
  `biggest shoal in a surge: ${biggestSurgeSchool} fish`);

// ---------------------------------------------------------------------------
section('CHUM — a lull fish is worth a fraction, and only in xp');

// Split on the LULL FLAG rather than on the phase name. A surge's ramps are
// deliberately still lull water, so "spawned during a surge" and "worth full
// value" are not the same set — asserting they were would be asserting the
// gradual handover doesn't happen.
const allDrops = phases.flatMap((p) => p.xp);
const calmDrops = allDrops.filter((d) => d.lull);
const surgeDrops = allDrops.filter((d) => !d.lull && lullEligible(CONFIG.enemies[d.type]));

check('lull fish carry the reduced value', calmDrops.length > 0 && calmDrops.every((d) => Math.abs(d.xp - d.def * W.lull.xpMul) < 1e-9),
  `${calmDrops.length} fish, e.g. ${calmDrops[0]?.type} at ${calmDrops[0]?.xp} vs ${calmDrops[0]?.def} listed`);
check('...and it is genuinely low', calmDrops.every((d) => d.xp < d.def * 0.5),
  `xpMul ${W.lull.xpMul}`);
check('the same species spawned at pressure is worth full value',
  surgeDrops.length > 0 && surgeDrops.every((d) => Math.abs(d.xp - d.def) < 1e-9),
  surgeDrops.length ? `${surgeDrops.length} fish spawned outside a lull, all at full xp` : 'no small fish spawned outside a lull to compare');
// The handover is the point: fish arrive on a surge's ramp still carrying lull
// value, so there is no frame on which the water's worth changes.
const rampDrops = phases.filter((p) => p.phase === 'surge').flatMap((p) => p.xp).filter((d) => d.lull);
check('...and a surge\'s ramps still pay lull rates, so the value hands over gradually',
  rampDrops.length > 0,
  `${rampDrops.length} fish spawned inside a surge but before it had built`);

// The value is per-instance. If it were written to the shared def instead, one
// lull would retroactively devalue every fish of that species already in the
// water — and never give the value back.
const bySpecies = new Map();
for (const d of [...calmDrops, ...surgeDrops]) {
  if (!bySpecies.has(d.type)) bySpecies.set(d.type, new Set());
  bySpecies.get(d.type).add(d.xp);
}
const splitSpecies = [...bySpecies].filter(([, vals]) => vals.size > 1);
check('one species carries two different values at once, so it is per-instance',
  splitSpecies.length > 0,
  splitSpecies.map(([k, v]) => `${k}: ${[...v].join('/')}`).join(', ') || 'every fish of a species shares one value — is it being written to def?');
check('...and the shared def was never mutated',
  eligible.every((k) => CONFIG.enemies[k].xp === undefined || CONFIG.enemies[k].xp > 0),
  eligible.map((k) => `${k}:${CONFIG.enemies[k].xp}`).join(' '));

// Score is deliberately untouched: a quiet-water kill still banks full points.
const lullFish = { def: CONFIG.enemies[eligible[0]], type: eligible[0], xp: CONFIG.enemies[eligible[0]].xp * W.lull.xpMul, mesh: { position: { x: 0, y: 0 } } };
const surgeFish = { ...lullFish, xp: CONFIG.enemies[eligible[0]].xp };
check('score is NOT scaled with the chum', computeKillPoints(lullFish, [], 1).points === computeKillPoints(surgeFish, [], 1).points,
  `${computeKillPoints(lullFish, [], 1).points} points either way`);

// ---------------------------------------------------------------------------
section('THROUGHPUT — waves redistribute pressure, they do not add it');

// The honest question: does a full cycle of surge-plus-calm produce roughly
// what the flat tap produced, or has "pacing" quietly become "more"? Measured
// by running the real spawner both ways over the same span at the same
// difficulty, with waves on and then off.
//
// SEEDED, because the ratio below is a Monte Carlo measurement asserted against
// a fixed band. Unseeded it drifts by a few percent per run, which parks the
// opening ratio right on the 0.8 floor and makes this suite fail perhaps one
// run in three — a red test that means nothing, which is worse than no test.
// The threshold is the honest one; it is the sample that has to be repeatable.
// mulberry32, same as nightlife-test.mjs.
function seedRandom(seed) {
  let a = seed >>> 0;
  Math.random = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function totalSpawned(difficulty, seconds) {
  resetEnemies(scene);
  const gs = { difficulty, level: 12 };
  let n = 0;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    const before = enemies.length;
    updateSpawning(dt, gs, scene);
    n += enemies.length - before;
    while (enemies.length > TARGET_ALIVE) removeEnemy(scene, Math.floor(Math.random() * enemies.length));
  }
  return n / seconds;
}

// Long enough to average over many whole cycles, so the sample isn't decided
// by where in a wave it happened to stop.
const SPAN = 900;
// PAIRED: the with-waves and flat runs are handed the same stream, so the
// ratio compares two spawners rather than two dice rolls. Averaged over
// several seeds so one unlucky arrangement cannot decide the verdict.
const THROUGHPUT_SEEDS = [1, 7, 13];
const ratios = [];
for (const d of [0, 16, 40, 90]) {
  const trials = THROUGHPUT_SEEDS.map((s) => {
    W.enabled = true;
    seedRandom(s);
    const on = totalSpawned(d, SPAN);
    W.enabled = false;
    seedRandom(s);
    const off = totalSpawned(d, SPAN);
    W.enabled = true;
    return { on, off };
  });
  const on = trials.reduce((a, t) => a + t.on, 0) / trials.length;
  const off = trials.reduce((a, t) => a + t.off, 0) / trials.length;
  ratios.push({ d, on, off, ratio: on / off });
  console.log(`        difficulty ${String(d).padStart(3)} (${secs(d).padStart(3)}s in): ${on.toFixed(2)}/s with waves vs ${off.toFixed(2)}/s flat — ${(on / off).toFixed(2)}x`);
}

check('the opening is no busier than it was', ratios[0].ratio <= 1.05,
  `${ratios[0].ratio.toFixed(2)}x at difficulty 0`);
check('no point in the run is more than a quarter busier',
  ratios.every((r) => r.ratio < 1.25),
  `max ${Math.max(...ratios.map((r) => r.ratio)).toFixed(2)}x`);
check('...nor is any point starved', ratios.every((r) => r.ratio > 0.8),
  `min ${Math.min(...ratios.map((r) => r.ratio)).toFixed(2)}x`);

// ---------------------------------------------------------------------------
section('OFF — the switch goes back to the flat tap exactly');

W.enabled = false;
resetEnemies(scene);
updateWaves(dt, 10);
const off = waveSpawn();
check('every multiplier reads 1', off.rateMul === 1 && off.groupMul === 1 && off.xpMul === 1 && off.lull === false,
  JSON.stringify(off));
resetEnemies(scene);
updateSpawning(dt, { difficulty: 20, level: 12 }, scene);
check('...and spawns pay full chum', enemies.every((e) => e.xp === e.def.xp),
  `${enemies.length} spawned, all at listed value`);
W.enabled = true;

console.log(failures === 0 ? '\nPASS — all checks' : `\nFAIL — ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
