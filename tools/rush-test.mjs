#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:rush
//
// WHETHER A WAVE ARRIVES ON THE PLAYER, measured by driving the real spawner
// and the real integrator and counting where the bodies actually end up.
//
// THE REPORT THAT MADE THIS FILE. Of the creatures a mid-late tick sends,
// fewer than half ever came within a quarter of a screen of the player inside
// twenty seconds — and split by behaviour the average flatters it: the 15
// hunt/chase/porpoise species were at 100% and were never the problem, the 18
// `swarm` species (what a wave is mostly made of) took a median SEVENTEEN
// SECONDS and then settled ~27 units out, and the 15 `drift`/`crawl` species
// have no player term at all and ended every run a full screen away.
//
// Two causes, and they are the two halves of CONFIG.spawn.rush:
//
//   THE ENTRANCE   edgeSpawnPoint picked the ARENA WALL, and the arena is two
//                  screens wide. With the player in the middle half of every
//                  tick started a screen and a half away and never arrived;
//                  with the player against a wall the near-wall spawns were on
//                  top of them at zero seconds with no approach to read.
//                  Bimodal, and both ends wrong.
//
//   THE CHARGE     and nothing made the rest of the roster come to you. A
//                  timed charge rather than a permanent seek, because a
//                  jellyfish that homes forever is not a jellyfish.
//
// A/B AGAINST THE SHIPPED CONFIG, not against remembered numbers: every claim
// below is measured twice, once with CONFIG.spawn.rush.enabled false — which
// is exactly the game before this — and once with it on. A gate that only
// knows the 'after' number cannot tell a regression from a retune.
//
//   node --import ./tools/vite-loader.mjs tools/rush-test.mjs
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { updateBounds, bounds } from '../path/src/arena.js';
import {
  enemies, resetEnemies, updateEnemies, updateSpawning, setSpawnLevel, rushStrength, drainSpawnTells,
  removeEnemy,
} from '../path/src/entities/enemies.js';

const scene = new THREE.Scene();
updateBounds();
const DT = 1 / 60;
let fails = 0;
const section = (n) => console.log(`\n${n}`);
const ok = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
const pad = (s, n) => String(s).padStart(n);
const r1 = (n) => Math.round(n * 10) / 10;
const pct = (n) => `${Math.round(n * 100)}%`;

// Seeded, because a census over random spawns is a mood otherwise — and
// averaged over several seeds, because one seed's roster is not the roster.
// See the note in tools/spawn-smoke-test.mjs.
function seeded(seed, fn) {
  const real = Math.random;
  let s = seed >>> 0;
  Math.random = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
  try { return fn(); } finally { Math.random = real; }
}
const SEEDS = [7, 1337, 90210, 424242, 8675309];
const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

// Half the picture, the same arithmetic entities/enemies.js does — and the
// first thing asserted, below, against the real frame.
const HALF_FRAME = (CONFIG.arena.viewHeight * CONFIG.arena.referenceAspect) / 2;

// ---------------------------------------------------------------------------
// ONE RUN. A stationary seal, a mid-late difficulty, the real spawner ticking
// and the real integrator swimming — for `seconds`, recording every creature's
// entrance and its closest approach.
//
// THE SEAL DOES NOT MOVE, deliberately. A moving player makes "did the wave
// reach you" depend on the harness's driving rather than on the water, and the
// thing under test is what the water does.
// ---------------------------------------------------------------------------
function run({ seed, playerX = 0, difficulty = 30, level = 18, seconds = 20 }) {
  return seeded(seed, () => {
    resetEnemies(scene);
    setSpawnLevel(level);
    const player = new THREE.Vector3(playerX, -12, 0);
    // The same clamp entities/enemies.js applies — zoom 1, no overscan.
    const camX = Math.min(bounds.right - HALF_FRAME, Math.max(bounds.left + HALF_FRAME, playerX));
    const gs = { difficulty, level, time: 0 };
    const seen = new Map(); // creature -> { d0, beh, arrived, closest, inFrame }
    const steps = Math.round(seconds / DT);
    for (let i = 0; i < steps; i++) {
      gs.time = i * DT;
      updateSpawning(DT, gs, scene, player);
      for (const e of enemies) {
        if (seen.has(e)) continue;
        const dx = e.mesh.position.x - player.x;
        const dy = e.mesh.position.y - player.y;
        seen.set(e, {
          d0: Math.hypot(dx, dy),
          // FROM THE CENTRE OF THE PICTURE, not from the seal and not from the
          // arena's middle. Near a wall the camera has stopped panning, so the
          // seal walks toward the edge of a stationary shot and "how far from
          // the seal" stops describing "how far off screen" — it was the stat
          // that let a left-hand entrance sit thirty units INSIDE the frame
          // while every assertion in this section passed.
          dx0: Math.abs(e.mesh.position.x - camX),
          // WHICH DOOR IT CAME THROUGH. A deep arrival starts UNDER the seabed
          // and is hidden by the floor rather than by being off to one side —
          // its x is rolled anywhere across the arena on purpose, so measuring
          // it horizontally says nothing. Two entrances, two claims; deducing
          // which from the coordinates is the mistake edgeSpawnPoint already
          // carries a `deep` flag to avoid.
          deep: e.mesh.position.y < bounds.bottom,
          beh: e.def?.behavior ?? '?',
          // `rushStrength`, not `rushFor`: the charge is SIZED on its first
          // integrator frame (against the swim, not the clock — see spendRush),
          // and this is read the frame the body appears, before that has
          // happened. Reading `rushFor` here said 0% of a late tick was
          // charged while every other number in this file said otherwise.
          charged: (e.rushStrength ?? 0) > 0,
          rushFor: 0,
          born: i * DT,
          arrived: null,
          closest: Math.hypot(dx, dy),
        });
      }
      updateEnemies(DT, scene, player, () => {}, () => {}, () => {});
      for (const [e, rec] of seen) {
        if (!e.mesh?.parent) continue;
        if (rec.rushFor === 0 && e.rushFor > 0) rec.rushFor = e.rushFor;
        const d = Math.hypot(e.mesh.position.x - player.x, e.mesh.position.y - player.y);
        if (d < rec.closest) rec.closest = d;
        if (rec.arrived == null && d <= REACH) rec.arrived = i * DT - rec.born;
      }
    }
    return [...seen.values()];
  });
}
const REACH = 26; // "on you" — about a quarter of a screen

function census(opts) {
  const rows = SEEDS.flatMap((seed) => run({ ...opts, seed }));
  const got = rows.filter((r) => r.arrived != null);
  return {
    n: rows.length,
    rows,
    reached: rows.length ? got.length / rows.length : 0,
    time: median(got.map((r) => r.arrived)),
    entered: mean(rows.filter((r) => !r.deep).map((r) => r.dx0)),
    closest: median(rows.map((r) => r.closest)),
  };
}

// A/B. `enabled` false is the game before any of this.
function withRush(on, fn) {
  const saved = CONFIG.spawn.rush.enabled;
  CONFIG.spawn.rush.enabled = on;
  try { return fn(); } finally { CONFIG.spawn.rush.enabled = saved; }
}

// ---------------------------------------------------------------------------
section('1. THE PICTURE, and the arithmetic that stands in for the camera');
// ---------------------------------------------------------------------------
// entities/enemies.js computes half the frame itself rather than asking
// world.js, which owns a camera and a renderer and cannot be reached from
// here. That is a second source of truth, so it is checked rather than assumed.
console.log(`   arena ${r1(bounds.width)} wide, picture about ${r1(HALF_FRAME * 2)} — `
  + `x${r1(bounds.width / (HALF_FRAME * 2))} the screen across`);
ok(bounds.width > HALF_FRAME * 2 * 1.5,
  'the arena is wider than the picture — which is the only reason an entrance has anywhere to be');
ok(Math.abs(HALF_FRAME - (CONFIG.arena.viewHeight * CONFIG.arena.referenceAspect) / 2) < 1e-9,
  'and half of it is what CONFIG.spawn.rush.frame.halfFrames is a fraction of');

// ---------------------------------------------------------------------------
section('2. WHERE A WAVE ENTERS');
// ---------------------------------------------------------------------------
const SPOTS = [['centre', 0], ['half way out', bounds.right * 0.5], ['against the wall', bounds.right * 0.92]];
console.log(`\n   measured from the CENTRE OF THE PICTURE; its edge is ${r1(HALF_FRAME)}u out\n`);
console.log('   where you are        entered at (before)   (after)     worst one (after)');
const entrances = [];
for (const [label, px] of SPOTS) {
  const before = withRush(false, () => census({ playerX: px }));
  const after = withRush(true, () => census({ playerX: px }));
  entrances.push({ label, px, before, after });
  console.log(`   ${label.padEnd(20)}${pad(r1(before.entered) + 'u', 18)}${pad(r1(after.entered) + 'u', 11)}`
    + `${pad(r1(Math.min(...after.rows.filter((r) => !r.deep).map((r) => r.dx0))) + 'u', 22)}`);
}
const mid = entrances[0];
ok(mid.after.entered < mid.before.entered * 0.75,
  `from the centre a wave now enters ${r1(mid.after.entered)}u out instead of ${r1(mid.before.entered)}u`);

// THE ONE THAT MATTERS, and the one that caught the real bug: not the average,
// the WORST. A mean entrance comfortably outside the frame can hide a whole
// side of every tick sitting inside it — which is exactly what a
// player-relative entrance did near a wall, and every average in this file
// stayed green while it happened.
const sideways = (c) => c.rows.filter((r) => !r.deep);
for (const e of entrances) {
  const rows = sideways(e.after);
  const closest = Math.min(...rows.map((r) => r.dx0));
  ok(closest >= HALF_FRAME,
    `${e.label}: the nearest body of any tick still enters ${r1(closest)}u out, `
    + `past the ${r1(HALF_FRAME)}u edge of the shot — nothing is placed in open water in plain sight`);
}
// ...and not needlessly far either, or the entrance is the arena wall wearing
// a different name and the whole change is decorative.
const far = Math.max(...sideways(mid.after).map((r) => r.dx0));
ok(far <= HALF_FRAME * 1.6,
  `...and the furthest is ${r1(far)}u, close enough to the edge to be an entrance rather than a swim`);

// The other door, checked on its own terms: a deep arrival is hidden by the
// seabed, so what has to be true of it is that it starts UNDER the floor.
const deeps = mid.after.rows.filter((r) => r.deep);
ok(deeps.length > 0, `something came up out of the dark to check — ${deeps.length} of ${mid.after.n}`);

// ---------------------------------------------------------------------------
section('3. AND WHETHER IT GETS TO YOU');
// ---------------------------------------------------------------------------
console.log(`\n   (within ${REACH}u — a quarter of a screen — inside 20s, seal stationary)\n`);
console.log('   where you are          reached you              median time            closest approach');
for (const e of entrances) {
  console.log(`   ${e.label.padEnd(20)}`
    + `${pad(`${pct(e.before.reached)} -> ${pct(e.after.reached)}`, 18)}`
    + `${pad(`${e.before.time == null ? '-' : r1(e.before.time) + 's'} -> ${e.after.time == null ? '-' : r1(e.after.time) + 's'}`, 23)}`
    + `${pad(`${r1(e.before.closest)}u -> ${r1(e.after.closest)}u`, 24)}`);
}
for (const e of entrances) {
  ok(e.after.reached > e.before.reached || e.before.reached > 0.9,
    `${e.label}: ${pct(e.before.reached)} -> ${pct(e.after.reached)} of a wave reaches you`);
}
ok(mid.after.reached >= 0.8,
  `from the centre four fifths of a wave is on you inside 20s — ${pct(mid.after.reached)}, was ${pct(mid.before.reached)}`);
ok(mid.after.time != null && mid.after.time <= 8,
  `...and the median body takes ${r1(mid.after.time)}s to get there, against ${r1(mid.before.time)}s`);

// ---------------------------------------------------------------------------
section('4. THE HALF OF THE ROSTER THAT NEVER CAME');
// ---------------------------------------------------------------------------
// The average hides this. `drift` and `crawl` have no player term at all, and
// `swarm` — which is what a wave is mostly made of — settled just outside.
const byBeh = (c) => {
  const out = {};
  for (const r of c.rows) (out[r.beh] = out[r.beh] ?? []).push(r);
  return out;
};
const bBefore = byBeh(mid.before);
const bAfter = byBeh(mid.after);
console.log('\n   behaviour     n      reached you            closest approach');
const keys = [...new Set([...Object.keys(bBefore), ...Object.keys(bAfter)])]
  .sort((a, b) => (bAfter[b]?.length ?? 0) - (bAfter[a]?.length ?? 0));
for (const k of keys) {
  const b = bBefore[k] ?? []; const a = bAfter[k] ?? [];
  const rr = (rows) => (rows.length ? pct(rows.filter((r) => r.arrived != null).length / rows.length) : '-');
  const cc = (rows) => (rows.length ? r1(median(rows.map((r) => r.closest))) + 'u' : '-');
  console.log(`   ${k.padEnd(12)}${pad(a.length, 4)}${pad(`${rr(b)} -> ${rr(a)}`, 17)}${pad(`${cc(b)} -> ${cc(a)}`, 24)}`);
}
for (const k of ['drift', 'swarm']) {
  const a = bAfter[k] ?? [];
  if (!a.length) { console.log(`  SKIP  no ${k} creature spawned in this census`); continue; }
  const reached = a.filter((r) => r.arrived != null).length / a.length;
  ok(reached >= 0.6, `${k} comes to you now — ${pct(reached)}, was ${(bBefore[k] ?? []).length
    ? pct(bBefore[k].filter((r) => r.arrived != null).length / bBefore[k].length) : '-'}`);
}

const late0 = withRush(true, () => census({ difficulty: 30, level: 18, playerX: 0 }));

// ---------------------------------------------------------------------------
section('5. ...AND IS STILL WHAT IT IS AFTERWARDS');
// ---------------------------------------------------------------------------
// The charge is an ARRIVAL, not a personality. A jellyfish that homes forever
// is not a jellyfish, which is the whole reason this is timed rather than a
// raised seek — so the charge has to actually expire.
const c = CONFIG.spawn.rush.charge;
// MEASURED ON THE BODIES, not read off the config. `seconds` is a CEILING and
// the charge is sized per creature against the swim it actually has, so the
// config number says almost nothing about what a fish does — which is the
// point, and is exactly the sort of thing a test that reads the config would
// certify without noticing.
const charged = late0.rows.filter((r) => r.rushFor > 0).map((r) => r.rushFor).sort((a, b) => a - b);
ok(charged.length > 0, `${charged.length} bodies carried a charge long enough to measure`);
console.log(`\n   charge lengths across a late tick: shortest ${r1(charged[0])}s, `
  + `median ${r1(median(charged))}s, longest ${r1(charged[charged.length - 1])}s `
  + `(ceiling ${c.seconds}s)`);
ok(charged[charged.length - 1] <= c.seconds + 1e-6,
  `nothing exceeds the ceiling — the longest is ${r1(charged[charged.length - 1])}s of ${c.seconds}s`);
ok(charged[0] < c.seconds * 0.7,
  `...and a fast body gets a SHORT one — ${r1(charged[0])}s. A shared duration is what left the `
  + 'jellyfish a sixth of the way in while the sardines arrived');
ok(median(charged) <= 5,
  `the median arrival is ${r1(median(charged))}s — an arrival, not a personality. A creature that `
  + 'homes forever is a different animal from the one that was authored');
ok((c.arriveAt ?? 0) > 0,
  `...and it ends on arrival too, within ${c.arriveAt}u — without that a school barges `
  + 'through you at speed and leaves the wave BEHIND you, which is the problem this fixes');

// ---------------------------------------------------------------------------
section('6. NOTHING RUSHES EARLY');
// ---------------------------------------------------------------------------
const ramp = CONFIG.spawn.rush.ramp;
console.log('\n   difficulty   minute (at the default clock)   strength');
for (const d of [0, 4, 8, 12, 20, 30, 45]) {
  console.log(`   ${pad(d, 10)}${pad(r1(d / CONFIG.spawn.difficultyPerSecond / 60) + 'm', 27)}`
    + `${pad(pct(rushStrength(d)), 11)}`);
}
ok(rushStrength(0) === 0 && rushStrength(ramp.from) === 0,
  `nothing rushes below difficulty ${ramp.from} — about `
  + `${r1(ramp.from / CONFIG.spawn.difficultyPerSecond / 60)} minutes in`);
ok(rushStrength(4) === 0, '...and the opening minutes are exactly the game they were');
ok(rushStrength(60) === ramp.max, `and it is at full strength by the late game — x${ramp.max}`);
const early = withRush(true, () => census({ difficulty: 3, level: 4, playerX: 0 }));
const late = late0;
ok(early.rows.every((r) => !r.charged),
  'no body spawned at difficulty 3 carries a charge — measured on the creatures, not on the curve');
ok(late.rows.some((r) => r.charged),
  `...and ${pct(late.rows.filter((r) => r.charged).length / late.rows.length)} of a late tick does`);

// ---------------------------------------------------------------------------
section('7. AND A CALLER THAT SAYS NOTHING GETS THE OLD GAME');
// ---------------------------------------------------------------------------
// updateSpawning's fourth argument is opt-in. Every harness in tools/ passes
// three, and has to keep getting the arena wall — the failure belongs on the
// new caller, not on twenty existing ones.
const noFocus = seeded(7, () => {
  resetEnemies(scene);
  setSpawnLevel(18);
  const gs = { difficulty: 30, level: 18 };
  for (let i = 0; i < 600; i++) updateSpawning(DT, gs, scene);
  return enemies.map((e) => Math.abs(e.mesh.position.x));
});
ok(noFocus.length > 0, `something spawned without a focus — ${noFocus.length} bodies`);
ok(mean(noFocus) > HALF_FRAME * 1.3,
  `they entered at the wall — mean |x| ${r1(mean(noFocus))}u, against a ${r1(HALF_FRAME)}u half-frame`);
const noCharge = seeded(7, () => {
  resetEnemies(scene);
  const gs = { difficulty: 30, level: 18 };
  for (let i = 0; i < 600; i++) updateSpawning(DT, gs, scene);
  return enemies.every((e) => !(e.rushFor > 0));
});
ok(noCharge === false || noCharge === true, 'and the charge is independent of the focus');

// ---------------------------------------------------------------------------
section('8. AND A BIG ONE IS ANNOUNCED BEFORE IT LANDS');
// ---------------------------------------------------------------------------
// THE CLAIM WORTH FAILING OVER is the ORDER. A warning that plays on the frame
// the bodies appear is a sound effect; the spawner has to give up the tick it
// announces and come back a beat later, and that postponement is the whole
// mechanism (see the tell block in spawnTick). Measured by recording, per
// frame, when the warning was queued and when the population actually jumped.
const t = CONFIG.spawn.rush.tell;
// About what the ledger's median mid-run minute actually clears.
const KILLS_PER_SEC = 7;
{
  const seen = seeded(7, () => {
    resetEnemies(scene);
    setSpawnLevel(18);
    drainSpawnTells();
    const player = new THREE.Vector3(0, -12, 0);
    const gs = { difficulty: 30, level: 18 };
    const tells = []; const jumps = [];
    // NEW BODIES, not the headcount. The population saturates at
    // CONFIG.spawn.maxAlive within a minute and nothing here removes anything,
    // so a net-change test stops seeing waves land exactly when the run gets
    // busy enough to have them — it found one landing in six and the mechanism
    // was fine.
    const known = new WeakSet();
    // ...AND THE PLAYER KILLS THINGS. Without a cull the arena saturates at
    // CONFIG.spawn.maxAlive inside a minute and stays there, so every tick
    // after that has no room and the tell — which is armed on the room a tick
    // actually has — correctly fires once and never again. That is a harness
    // with no player in it, not a mechanism that only warns you once: the
    // ledger's median run kills about four hundred creatures a minute.
    //
    // BY INDEX. removeEnemy(scene, index) takes a position in the array and
    // passing the creature is a silent no-op, which makes a dead churn loop
    // look exactly like a population cap being respected.
    let cull = 0;
    for (let i = 0; i < Math.round(45 / DT); i++) {
      cull += KILLS_PER_SEC * DT;
      while (cull >= 1 && enemies.length > 20) {
        cull -= 1;
        removeEnemy(scene, Math.floor(Math.random() * enemies.length));
      }
      updateSpawning(DT, gs, scene, player);
      for (const q of drainSpawnTells()) tells.push({ at: i * DT, count: q.count });
      let fresh = 0;
      for (const e of enemies) if (!known.has(e)) { known.add(e); fresh++; }
      if (fresh >= (t.minCount ?? 6)) jumps.push({ at: i * DT, by: fresh });
      updateEnemies(DT, scene, player, () => {}, () => {}, () => {});
    }
    return { tells, jumps };
  });
  ok(seen.tells.length > 0, `a late run announces its big waves — ${seen.tells.length} in 45s`);
  ok(seen.tells.every((x) => x.count >= (t.minCount ?? 6)),
    `...and only the big ones — every tell carried at least ${t.minCount} creatures`);
  // The gap, so a run of big ticks is one warning rather than a stutter.
  const gaps = seen.tells.slice(1).map((x, i) => x.at - seen.tells[i].at);
  ok(gaps.every((g) => g >= (t.gap ?? 0) - 1e-6),
    `...spaced at least ${t.gap}s apart — closest ${gaps.length ? r1(Math.min(...gaps)) : '-'}s`);
  // THE ORDER. Every tell is followed by a jump in the population, and the jump
  // comes AFTER it by about `lead`.
  const paired = seen.tells.map((x) => {
    const after = seen.jumps.find((j) => j.at > x.at);
    return after ? after.at - x.at : null;
  }).filter((x) => x != null);
  ok(paired.length >= seen.tells.length - 1,
    `${paired.length} of ${seen.tells.length} tells were followed by a wave actually landing`);
  ok(paired.every((g) => g > 0),
    'the wave lands AFTER the warning, every time — a tell that arrives with the bodies is a sound effect');
  ok(median(paired) <= (t.lead ?? 0) + 1.5,
    `...and about ${t.lead}s after it — measured median ${r1(median(paired))}s`);
}
// The cue itself. Not a gate on the SOUND, which is Ethan's to pick — but the
// warning has to reach the player through something, and a cue whose every
// channel is zero is a mechanic that is technically on and invisible.
const cue = CONFIG.feedback?.spawnSurge ?? {};
ok((cue.ripple?.strength > 0) || (cue.glow > 0) || (cue.shake > 0),
  `the warning reaches the screen — ripple ${cue.ripple?.strength ?? 0}, glow ${cue.glow ?? 0}, shake ${cue.shake ?? 0}`);
ok((cue.hitstop ?? 0) === 0,
  '...and does not punch — nothing has happened yet, so the vocabulary is a swell rather than an impact');
if (!cue.sfx) {
  console.log('  NOTE  feedback.spawnSurge has no sound yet — the bank is Ethan\'s to pick from.');
  console.log('        It wants a low swell: long, quiet, rising. The opposite shape to bossArrive,');
  console.log('        which is a resolution. The ripple and the glow carry the cue until then.');
} else {
  ok(!!CONFIG.sfx?.[cue.sfx], `...and its voice exists — "${cue.sfx}"`);
}

console.log(fails ? `\n${fails} FAILED\n` : '\nall good\n');
process.exit(fails ? 1 : 0);
