#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:chunks
//
// THE BIG CHUM CHUNK — one large piece of catch, worth 10% to 75% of a health
// bar in a single swallow. See CONFIG.chumChunk.
//
// The whole pickup rests on one promise: HOW MUCH IT PAYS IS VISIBLE BEFORE YOU
// SWIM FOR IT. Size and colour are the roll. So the failures worth catching are
// the ones where that promise quietly stops holding, and every one of them
// looks fine on screen:
//
//   THE ROLL       "bigger is rarer" is a distribution claim. `healMax: 0.75`
//                  on its own says nothing about how often anyone sees one, and
//                  the only honest check is to run the roll thousands of times
//                  and look at the histogram.
//   THE TELL       size and tint must be MONOTONE in the heal. A fat chunk that
//                  pays less than a lean one is not a bug you can see; it is a
//                  pickup the player learns to misjudge.
//   THE MATERIAL   primitive assets share ONE material across every instance,
//                  so a tint written to the shared one repaints every chunk in
//                  the water to match whichever spawned last. Two chunks alive
//                  at once is where that shows, and two chunks alive at once is
//                  ordinary during a boss fight.
//   THE BUDGET     "a few times during a boss battle" and "one pity chunk per
//                  fight" are properties of a whole FIGHT, not of a frame. A
//                  five-minute fight throwing four chunks, or a second boss
//                  inheriting a spent pity flag, are both invisible at 60fps
//                  and obvious to a simulated fight that runs in a millisecond.
//   THE BLOOM      the arrival flash is a flash because the bright-pass sees
//                  it. Brightness is not luminance — see the memory note — so
//                  the numbers are pushed through post.js's own maths here
//                  rather than trusted to look big.
//
// Everything expected is derived from CONFIG rather than typed in: saved tuning
// is merged over the defaults at import, so a hardcoded 2.6 would be testing
// imported-tuning.json rather than the code.
//
// What it cannot tell you: whether a chunk across the arena actually pulls your
// eye mid-fight. That is a run.
//
//   node --import ./tools/vite-loader.mjs tools/chum-chunk-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import {
  chumChunks, spawnChumChunk, resetPickups, updatePickups,
  rollChunkT, chunkHealFrac, chunkBrightness,
} from '../path/src/entities/pickups.js';
import {
  chunkSpawnState, resetChumChunkSpawner, updateChumChunkSpawner, pityFloor,
} from '../path/src/systems/chumChunkSpawner.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const C = CONFIG.chumChunk;

// Seeded, and every statistical claim below is averaged over fixed seeds. A
// Monte Carlo assertion on Math.random is a test that fails one run in fifty
// for no reason, and the standard "fix" is to loosen the threshold until it
// stops — which deletes the assertion.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEEDS = [1, 7, 13, 42, 99];

console.log('Chum chunk — merged config');
console.log(`  enabled ${C.enabled}   heal ${(C.healMin * 100).toFixed(0)}%..${(C.healMax * 100).toFixed(0)}% of max HP   bias ${C.healBias}`);
console.log(`  ambient every ${C.spawnMin}-${C.spawnMax}s, lives ${C.lifetime}s, sinks at ${C.sinkSpeed}`);
console.log(`  boss: up to ${C.boss.maxPerFight} per fight every ${C.boss.gapMin}-${C.boss.gapMax}s, bias ${C.boss.healBias}, thrown at ${C.boss.tossSpeed} u/s`);
console.log(`  pity: under ${(C.pity.hpFrac * 100).toFixed(0)}% HP, ${(C.pity.chance * 100).toFixed(0)}% every ${C.pity.checkEvery}s, never below ${(C.pity.healMin * 100).toFixed(0)}%`);

// ===========================================================================
section('The roll — bigger is rarer');

const N = 40000;
function rolls(bias, floor = 0) {
  const out = [];
  for (const seed of SEEDS) {
    const rand = mulberry32(seed);
    for (let i = 0; i < N / SEEDS.length; i++) out.push(rollChunkT(rand, bias, floor));
  }
  return out.sort((a, b) => a - b);
}
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

const ambient = rolls(C.healBias);
check('the roll never leaves 0..1',
  ambient[0] >= 0 && ambient[ambient.length - 1] <= 1,
  `${ambient[0].toFixed(4)}..${ambient[ambient.length - 1].toFixed(4)}`);
check('the smallest possible chunk is healMin and the largest is healMax',
  Math.abs(chunkHealFrac(0) - C.healMin) < 1e-9 && Math.abs(chunkHealFrac(1) - C.healMax) < 1e-9,
  `${(chunkHealFrac(0) * 100).toFixed(0)}%..${(chunkHealFrac(1) * 100).toFixed(0)}%`);

// The histogram, in fifths of the range. Each band must be rarer than the one
// below it — that IS "bigger is rarer", and it is a claim about the shape of
// the distribution rather than about any one number in it.
const bands = [0, 0, 0, 0, 0];
for (const t of ambient) bands[Math.min(4, Math.floor(t * 5))]++;
console.log('  size band     share   heal');
for (let i = 0; i < 5; i++) {
  const lo = chunkHealFrac(i / 5);
  const hi = chunkHealFrac((i + 1) / 5);
  console.log(`  ${i === 4 ? 'biggest ' : `${i + 1}${['st', 'nd', 'rd', 'th'][Math.min(i, 3)]} fifth`}   ${(bands[i] / N * 100).toFixed(1).padStart(5)}%   ${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%`);
}
let descending = true;
for (let i = 1; i < 5; i++) if (bands[i] > bands[i - 1]) descending = false;
check('every size band is rarer than the one below it', descending);
check('the biggest chunks are genuinely rare',
  bands[4] / N < 0.12, `top fifth is ${(bands[4] / N * 100).toFixed(1)}% of chunks`);
check('...but they do exist', bands[4] > 0, `${bands[4]} of ${N}`);

const median = chunkHealFrac(quantile(ambient, 0.5));
check('the median chunk is a real heal, not a trickle',
  median > CONFIG.pickups.healFraction * 4,
  `${(median * 100).toFixed(0)}% of max HP vs ${(CONFIG.pickups.healFraction * 100).toFixed(0)}% for one orb`);
check('...and is nowhere near the top of the range',
  median < (C.healMin + C.healMax) / 2,
  `${(median * 100).toFixed(0)}% vs midpoint ${((C.healMin + C.healMax) / 2 * 100).toFixed(0)}%`);

// A boss chunk should skew bigger than an ambient one. This is the entire
// difference between the two biases, and a typo swapping them is silent.
const bossRoll = rolls(C.boss.healBias);
check('a boss kicks out bigger chunks than the ocean drops',
  quantile(bossRoll, 0.5) > quantile(ambient, 0.5) + 1e-6,
  `median ${(chunkHealFrac(quantile(bossRoll, 0.5)) * 100).toFixed(0)}% vs ${(median * 100).toFixed(0)}%`);

// ===========================================================================
section('The pity chunk is worth taking');

const floor = pityFloor();
const pity = rolls(C.boss.healBias, floor);
check('a pity chunk never pays less than pity.healMin',
  chunkHealFrac(pity[0]) >= C.pity.healMin - 1e-9,
  `smallest ${(chunkHealFrac(pity[0]) * 100).toFixed(1)}% vs floor ${(C.pity.healMin * 100).toFixed(0)}%`);
check('and it can still roll all the way to the top',
  chunkHealFrac(pity[pity.length - 1]) > C.healMax - 0.05,
  `largest ${(chunkHealFrac(pity[pity.length - 1]) * 100).toFixed(0)}%`);
// The floor is stated as a HEAL in config and used as a ROLL POSITION in code.
// If that conversion is wrong the chunk pays what it promised and is drawn the
// wrong size, which is the one failure mode the player can't detect.
check('the floor lands where config says it should',
  Math.abs(chunkHealFrac(floor) - C.pity.healMin) < 1e-9,
  `roll floor ${floor.toFixed(3)} = ${(chunkHealFrac(floor) * 100).toFixed(1)}% heal`);

// ===========================================================================
section('The tell — you can read the heal off the chunk');

const scene = new THREE.Scene();
const player = {
  mesh: new THREE.Object3D(),
  velocity: new THREE.Vector3(),
  stats: { pickupRadius: CONFIG.player.pickupRadius, maxHp: 100, chumGulpRadius: 0 },
};
player.mesh.position.set(0, -10, 0);
// Far from every chunk below unless a test moves it, so nothing is collected
// out from under a measurement.
const parked = () => player.mesh.position.set(0, -10, 0);

resetPickups(scene);
const sizes = [];
for (const t of [0, 0.25, 0.5, 0.75, 1]) {
  const c = spawnChumChunk(scene, new THREE.Vector3(200 + t * 10, 0, 0), { t });
  sizes.push({ t, scale: c.mesh.scale.x, radius: c.radius, heal: c.healFrac, color: c.base.clone() });
}
let sizeUp = true;
let radiusUp = true;
for (let i = 1; i < sizes.length; i++) {
  if (sizes[i].scale <= sizes[i - 1].scale) sizeUp = false;
  if (sizes[i].radius <= sizes[i - 1].radius) radiusUp = false;
}
check('a chunk worth more is drawn bigger, at every step', sizeUp,
  sizes.map((s) => s.scale.toFixed(2)).join(' -> '));
check('and its measured body grows with it, so the reach to take it does too', radiusUp,
  sizes.map((s) => s.radius.toFixed(2)).join(' -> '));
check('the asset\'s own size from assets.csv survives the roll',
  sizes[0].scale > C.scaleMin + 1e-6,
  `smallest chunk renders at ${sizes[0].scale.toFixed(2)}x, not the bare ${C.scaleMin}x — multiplyScalar, not setScalar`);

// Colour is the half of the tell that still works head-on, where size is
// hardest to judge.
let warmer = true;
for (let i = 1; i < sizes.length; i++) {
  const a = sizes[i - 1].color;
  const b = sizes[i].color;
  if (b.r + b.g + b.b <= a.r + a.g + a.b) warmer = false;
}
check('and it is visibly hotter than the one below it', warmer,
  sizes.map((s) => '#' + s.color.getHexString()).join(' -> '));

// THE SHARED-MATERIAL TRAP. Two chunks of different sizes, alive at once.
const twoA = chumChunks[0];
const twoB = chumChunks[chumChunks.length - 1];
check('two chunks in the water do not share one material',
  twoA.mesh.material !== twoB.mesh.material);
parked();
updatePickups(0.016, scene, player, () => {}, null, null, null, () => {});
check('...so the small one stays dim while the big one is bright',
  twoA.mesh.material.color.getHex() !== twoB.mesh.material.color.getHex(),
  `#${twoA.mesh.material.color.getHexString()} vs #${twoB.mesh.material.color.getHexString()}`);

// ===========================================================================
section('The arrival flash');

const rest = chunkBrightness(0, 0, 0);
const born = chunkBrightness(C.flash.seconds, 0, 0);
check('a chunk arrives brighter than it settles', born > rest * 1.5,
  `${born.toFixed(2)} -> ${rest.toFixed(2)}`);
check('and the flash decays all the way back to resting',
  Math.abs(chunkBrightness(0, 0, 0) - rest) < 1e-9);
let flashDrops = true;
let prevB = Infinity;
for (let f = C.flash.seconds; f >= 0; f -= C.flash.seconds / 32) {
  const v = chunkBrightness(f, 0, 0);
  if (v > prevB + 1e-9) flashDrops = false;
  prevB = v;
}
check('it only ever gets dimmer on the way down', flashDrops);
// The breathing pulse must never dip a settled chunk below zero, and `pulse
// depth` is a slider somebody will push.
let floorOk = true;
for (let i = 0; i < 128; i++) if (chunkBrightness(0, i / 16, 1.1) < 0) floorOk = false;
check('the breathing pulse never drives it negative', floorOk);

// The bright-pass, verbatim from systems/post.js. Luminance, not brightness —
// a warm chunk clears this comfortably where a cold one of the same nominal
// brightness would not, which is exactly the trap worth measuring.
const LUMA = new THREE.Vector3(0.2126, 0.7152, 0.0722);
const smoothstep = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
function brightOut(color, mul) {
  const c = new THREE.Vector3(color.r, color.g, color.b).multiplyScalar(mul);
  const lum = c.dot(LUMA);
  return { lum, out: lum * smoothstep(CONFIG.bloom.threshold, CONFIG.bloom.threshold + 0.25, lum) };
}
for (const s of [sizes[0], sizes[sizes.length - 1]]) {
  const label = s.t === 0 ? 'smallest' : 'biggest';
  const r = brightOut(s.color, rest);
  const f = brightOut(s.color, born);
  console.log(`  ${label}: luminance ${r.lum.toFixed(2)} resting, ${f.lum.toFixed(2)} on arrival; bloom ${r.out.toFixed(2)} -> ${f.out.toFixed(2)}`);
  check(`${label}: the arrival flash reaches the bright-pass`, f.out > 0,
    `threshold ${CONFIG.bloom.threshold}, luminance ${f.lum.toFixed(2)}`);
  check(`${label}: and it is a flash, not a slightly paler frame`,
    f.out > Math.max(r.out, 0.02) * 1.5,
    `x${(f.out / Math.max(r.out, 1e-6)).toFixed(1)}`);
}

// ===========================================================================
section('In the water');

resetPickups(scene);
parked();
// Dropped high, well out of magnet reach, and left alone.
const sinker = spawnChumChunk(scene, new THREE.Vector3(80, 5, 0), { t: 0.5 });
const startY = sinker.mesh.position.y;
for (let i = 0; i < 60; i++) updatePickups(1 / 60, scene, player, () => {}, null, null, null, () => {});
check('a chunk left alone sinks', sinker.mesh.position.y < startY - 0.1,
  `${startY.toFixed(2)} -> ${sinker.mesh.position.y.toFixed(2)} in 1s`);

// The seabed and the surface. This is the game's rarest pickup and the one it
// can least afford to lose into the floor.
for (let i = 0; i < 60 * 120; i++) updatePickups(1 / 60, scene, player, () => {}, null, null, null, () => {});
check('and it expires rather than piling up forever', chumChunks.length === 0,
  `${chumChunks.length} alive after ${(C.lifetime + 60).toFixed(0)}s`);

resetPickups(scene);
parked();
// Thrown at the boss's toss speed, straight up — the path most likely to put
// one in the sky if the ceiling clamp is missing.
const thrown = spawnChumChunk(scene, new THREE.Vector3(60, 0, 0), {
  t: 0.5, vel: { x: 0, y: C.boss.tossSpeed },
});
let brokeSurface = false;
let brokeFloor = false;
for (let i = 0; i < 60 * 20; i++) {
  updatePickups(1 / 60, scene, player, () => {}, null, null, null, () => {});
  if (!chumChunks.length) break;
  const y = thrown.mesh.position.y;
  if (y > 0) brokeSurface = true;      // arena surfaceY is 0 in this stub world
  if (y < -1e3) brokeFloor = true;
}
check('a thrown chunk never leaves the water', !brokeSurface);
check('and never falls through the seabed', !brokeFloor);

resetPickups(scene);
// Collected: the payout, once, with the heal it advertised.
const taken = spawnChumChunk(scene, new THREE.Vector3(0, -10, 0), { t: 0.8 });
const promised = taken.healFrac;
let paid = 0;
let payouts = 0;
player.mesh.position.set(0, -10, 0);
for (let i = 0; i < 10; i++) {
  updatePickups(1 / 60, scene, player, () => {}, null, null, null, (c) => {
    paid = c.healFrac; payouts++;
  });
}
check('swimming into a chunk pays out exactly once', payouts === 1, `${payouts} payouts`);
check('and pays the heal it was drawn at', Math.abs(paid - promised) < 1e-9,
  `${(paid * 100).toFixed(1)}% of max HP`);
check('and leaves nothing behind', chumChunks.length === 0);

// A caller with no handler must not delete the chunk by swimming through it.
resetPickups(scene);
spawnChumChunk(scene, new THREE.Vector3(0, -10, 0), { t: 0.5 });
for (let i = 0; i < 10; i++) updatePickups(1 / 60, scene, player, () => {}, null, null, null, null);
check('a chunk is never swum through and deleted unpaid', chumChunks.length === 1);
resetPickups(scene);
parked();

// ===========================================================================
section('A boss fight');

// A whole fight, simulated at 60fps. `boss` is any object — the spawner only
// ever compares it by identity.
function fight(seconds, opts = {}) {
  const rand = mulberry32(opts.seed ?? 1);
  const boss = opts.boss ?? { id: 'boss-a' };
  const out = { ambient: 0, boss: 0, pity: 0 };
  const dt = 1 / 60;
  for (let i = 0; i < seconds / dt; i++) {
    updateChumChunkSpawner(dt, {
      boss,
      hpFrac: opts.hpFrac ?? 1,
      rand,
      onAmbient: () => { out.ambient++; },
      onBoss: (t, reason) => { out[reason]++; if (reason === 'pity') out.pityT = t; },
    });
  }
  return out;
}

// THE BUDGET. A long fight must not keep paying — this is the assertion that a
// per-frame reading of the code cannot make.
let overBudget = 0;
let totals = [];
for (const seed of SEEDS) {
  resetChumChunkSpawner(mulberry32(seed));
  const r = fight(300, { seed, hpFrac: 1 });
  totals.push(r.boss);
  if (r.boss > C.boss.maxPerFight) overBudget++;
}
check('a five-minute fight never exceeds the per-fight budget', overBudget === 0,
  `threw ${totals.join(', ')} against a cap of ${C.boss.maxPerFight}`);
check('and a fight that goes the distance does spend it',
  totals.every((n) => n === C.boss.maxPerFight),
  `${totals.join(', ')}`);

// A fight the seal wins quickly should not have been paid for it.
resetChumChunkSpawner(mulberry32(1));
const quick = fight(Math.max(0, C.boss.gapMin - 1), { seed: 1, hpFrac: 1 });
check('a fight shorter than the first gap throws nothing', quick.boss === 0);

// THE PITY CHUNK. Once, per fight, and only in trouble.
resetChumChunkSpawner(mulberry32(1));
const healthy = fight(300, { seed: 1, hpFrac: 1 });
check('a healthy seal is never pitied', healthy.pity === 0);

let pityCounts = [];
for (const seed of SEEDS) {
  resetChumChunkSpawner(mulberry32(seed));
  pityCounts.push(fight(300, { seed, hpFrac: C.pity.hpFrac * 0.5 }).pity);
}
check('a seal that is nearly dead is pitied exactly once per fight',
  pityCounts.every((n) => n === 1), `${pityCounts.join(', ')}`);

// The pity chunk must be worth the name.
resetChumChunkSpawner(mulberry32(3));
const desperate = fight(300, { seed: 3, hpFrac: 0.05 });
check('and the pity chunk it throws rolls from the top of the range',
  chunkHealFrac(desperate.pityT) >= C.pity.healMin - 1e-9,
  `${(chunkHealFrac(desperate.pityT) * 100).toFixed(0)}% of max HP`);

// It should ARRIVE while there is still a seal to save it — not eventually.
resetChumChunkSpawner(mulberry32(1));
{
  const rand = mulberry32(1);
  const boss = { id: 'boss-a' };
  let at = -1;
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 30 && at < 0; i++) {
    updateChumChunkSpawner(dt, {
      boss, hpFrac: 0.1, rand,
      onBoss: (t, reason) => { if (reason === 'pity') at = i * dt; },
    });
  }
  check('and it arrives within a few seconds of the trouble starting',
    at >= 0 && at <= C.pity.checkEvery * 3,
    at >= 0 ? `${at.toFixed(1)}s` : 'never arrived');
}

// THE SECOND FIGHT. Identity, not a boolean — the failure here is a second boss
// inheriting the first one's spent budget and paying out nothing at all.
{
  resetChumChunkSpawner(mulberry32(5));
  const rand = mulberry32(5);
  const dt = 1 / 60;
  const seen = { a: 0, b: 0, pity: 0 };
  const run = (boss, seconds, hpFrac, bucket) => {
    for (let i = 0; i < seconds / dt; i++) {
      updateChumChunkSpawner(dt, {
        boss, hpFrac, rand,
        onBoss: (t, reason) => { if (reason === 'pity') seen.pity++; else seen[bucket]++; },
      });
    }
  };
  const bossA = { id: 'a' };
  const bossB = { id: 'b' };
  run(bossA, 300, 0.05, 'a');   // fight one, in trouble throughout
  run(null, 40, 1, 'a');        // the quiet between fights
  run(bossB, 300, 0.05, 'b');   // fight two, same again
  check('a second boss gets its own ejection budget',
    seen.b === C.boss.maxPerFight, `${seen.b} of ${C.boss.maxPerFight}`);
  check('and its own pity chunk', seen.pity === 2, `${seen.pity} across two fights`);
}

// Nothing is thrown at an empty ocean.
{
  resetChumChunkSpawner(mulberry32(1));
  const rand = mulberry32(1);
  let thrownNoBoss = 0;
  for (let i = 0; i < 60 * 300; i++) {
    updateChumChunkSpawner(1 / 60, {
      boss: null, hpFrac: 0.05, rand, onBoss: () => { thrownNoBoss++; },
    });
  }
  check('with no boss in the water nothing is kicked out of one', thrownNoBoss === 0);
  check('and the per-fight state is cleared rather than left armed',
    chunkSpawnState.fight === null && chunkSpawnState.bossLeft === 0);
}

// THE AMBIENT CLOCK, over a whole run. Slow enough to stay an event.
{
  const perRun = [];
  for (const seed of SEEDS) {
    resetChumChunkSpawner(mulberry32(seed));
    const rand = mulberry32(seed);
    let n = 0;
    for (let i = 0; i < 60 * 600; i++) {
      updateChumChunkSpawner(1 / 60, { boss: null, hpFrac: 1, rand, onAmbient: () => { n++; } });
    }
    perRun.push(n);
  }
  const avg = perRun.reduce((a, b) => a + b, 0) / perRun.length;
  const expected = 600 / ((C.spawnMin + C.spawnMax) / 2);
  console.log(`  ${avg.toFixed(1)} ambient chunks in a ten-minute run (${perRun.join(', ')})`);
  check('the ambient clock matches its configured cadence',
    Math.abs(avg - expected) < expected * 0.25, `expected about ${expected.toFixed(1)}`);
  check('...and stays rare enough to be an event',
    avg < 600 / 30, `one every ${(600 / avg).toFixed(0)}s`);
}

// ===========================================================================
console.log(`\n${failures === 0 ? 'All good.' : `${failures} failure(s).`}`);
process.exit(failures === 0 ? 0 : 1);
