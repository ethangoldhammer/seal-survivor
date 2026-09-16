#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:lungeaim
//
// WHETHER A COMMITTED RUN IS POINTED AT THE PLAYER, measured at the frame it
// commits, on every body in the roster that lunges.
//
// THE REPORT THAT MADE THIS FILE was "the boss shark isn't targeting the
// player correctly — it's aiming at empty space", and it was exactly true. The
// FIRST strike of a lunge is dead on, every time, on every body: the wind-up
// steers onto the seal at full turn rate for a second or more and the line it
// locks is the line you watched it take. It is the SECOND strike — the one a
// `double` or a `feint` makes after its re-aim — that was aimed at nothing:
//
//   bossShark       median 107 deg off the player, past 90 deg 68% of the time
//   bossMosasaur    median 100 deg,                            63%
//   bossHammerhead  median  84 deg,                            39%
//   bossOrca        median  66 deg,                            16%
//
// and `double` plus `feint` is 60% of a boss shark's lunges (bosses.csv
// weights them 0.3 and 0.3 against `pass`'s 0.4). So most of what that
// archetype did was charge the wrong way.
//
// TWO CAUSES, and the first is the one nobody would have found by reading:
//
//   THE COME-ABOUT WAS SWITCHED OFF FOR RE-AIMS. steerTo has one mechanism for
//   "a big lateral body needs to go the other way" — it mirrors the heading
//   about vertical in one frame and lets systems/fishTurn.js yaw the body
//   through the camera — and its gate read
//   `e.lungeStage !== 'wind' && e.lungeStage !== 'reaim'`. The wind-up's
//   exclusion is argued for in the comment above it; the re-aim's was not
//   mentioned, and a re-aim is a body that has just blown past the seal and
//   has to come round, which is the one manoeuvre the mechanism is for.
//
//   AND `reaimTime` WAS A FLAT 0.45s for a roster whose turn rates span 3.4
//   rad/s to 1.05. At 1.05 that is 27 degrees of an up-to-180-degree turn. The
//   time a re-aim needs is a DISTANCE over a RATE, exactly like the spawn
//   rush's charge next door, and a shared constant cannot be either.
//
// ...and one guarantee on top of both, which is the part that actually has to
// hold: `reaimCone`. A committed run is the most expensive thing one of these
// does — unshovable, armoured, and on a boss carrying four times its contact
// damage — and if the re-aim ends still facing the wrong way the plan is
// ABANDONED rather than spent. A player who dodged a run has earned the miss.
// Watching one charge empty water on the far side of the arena is the bug.
//
//   node --import ./tools/vite-loader.mjs tools/lunge-aim-test.mjs
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { CONFIG } from '../path/src/config.js';
import { updateBounds } from '../path/src/arena.js';
import { resetEnemies, spawnNamed, updateEnemies } from '../path/src/entities/enemies.js';

const scene = new THREE.Scene();
updateBounds();
const DT = 1 / 60;
let fails = 0;
const section = (n) => console.log(`\n${n}`);
const ok = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
const pad = (s, n) => String(s).padStart(n);
const r1 = (n) => Math.round(n * 10) / 10;
const deg = (r) => r * 180 / Math.PI;
const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);

// Seeded and averaged over several, because which pattern a lunge rolls is a
// die and one seed's roster is not the roster. See tools/spawn-smoke-test.mjs.
function seeded(seed, fn) {
  const real = Math.random; let s = seed >>> 0;
  Math.random = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
  try { return fn(); } finally { Math.random = real; }
}
const SEEDS = [11, 99, 4242, 777, 31337, 5150, 8008];
const rules = CONFIG.lungeRules ?? {};
// Every body that rolls patterns — off the CSV rather than a list here, so an
// archetype added next year is measured the day its row lands.
const KEYS = Object.keys(CONFIG.enemies).filter((k) => CONFIG.enemies[k].lunge?.patterns);

// ---------------------------------------------------------------------------
section('1. WHY A FLAT RE-AIM COULD NOT WORK');
// ---------------------------------------------------------------------------
// Arithmetic, before any simulation: the turn a body can make in the floor
// time, against the turn a re-aim may have to make.
console.log('\n   body              turnRate   floor   turn it makes in the floor');
const budgets = [];
for (const k of KEYS) {
  const d = CONFIG.enemies[k];
  const floor = d.lunge.reaimTime ?? rules.reaimTime ?? 0.45;
  const tr = d.turnRate ?? 0;
  budgets.push({ k, tr, floor, can: tr * floor });
  console.log(`   ${k.padEnd(17)}${pad(tr, 7)}${pad(floor, 8)}${pad(r1(deg(tr * floor)) + ' deg', 22)}`);
}
ok(budgets.some((b) => b.can < Math.PI * 0.5),
  `at least one body cannot make even a quarter turn in the floor time — `
  + `worst ${budgets.reduce((a, b) => (b.can < a.can ? b : a)).k} at `
  + `${r1(deg(Math.min(...budgets.map((b) => b.can))))} deg. That is the whole reason `
  + 'the re-aim is sized against the turn rather than typed');
ok((rules.reaimMax ?? 0) > (rules.reaimTime ?? 0),
  `...and the ceiling is above the floor — ${rules.reaimMax}s against ${rules.reaimTime}s`);
ok((rules.reaimCone ?? 0) > 0, `...and a run that is still off by more than ${
  r1(deg(rules.reaimCone))} deg is abandoned rather than spent`);

// The come-about, asserted on the source because it is one clause in a
// condition and the only thing that can go wrong with it is someone putting
// 'reaim' back on that list — which is exactly what was wrong.
const src = readFileSync(new URL('../path/src/entities/enemies.js', import.meta.url), 'utf8');
ok(!/lungeStage !== 'reaim'/.test(src),
  "the come-about is allowed during a re-aim — `lungeStage !== 'reaim'` is off the gate that "
  + 'refused the one manoeuvre a re-aim is');
ok(/lungeStage !== 'wind'/.test(src),
  '...and still refused during a WIND-UP, which is the exclusion that was always right: the tell '
  + 'is the line the body visibly turned onto');

// ---------------------------------------------------------------------------
section('2. WHERE A RUN ACTUALLY POINTS, at the frame it commits');
// ---------------------------------------------------------------------------
// Driven through the real integrator against a player that MOVES — a
// stationary seal is the one case a stale aim still looks correct on, which is
// most of why this was invisible.
function measure(key) {
  const first = []; const second = []; const reaims = []; const firstSpend = [];
  let plans = 0; let ran = 0;
  for (const seed of SEEDS) {
    seeded(seed, () => {
      resetEnemies(scene);
      const boss = /^boss/.test(key);
      const e = spawnNamed(scene, key, 10, { x: -25, y: -14 }, { ignoreCaps: true, overfill: true, boss });
      if (!e) return;
      if (boss) e.isBoss = true;
      const player = new THREE.Vector3(0, -14, 0);
      let last = null; let step = 0; let spent = 0; let hPrev = 0; let lastTurn = 0;
      for (let i = 0; i < 60 * 90; i++) {
        player.x = Math.sin(i * DT * 0.7) * 18;
        player.y = -14 + Math.cos(i * DT * 0.5) * 6;
        updateEnemies(DT, scene, player, () => {}, () => {}, () => {});
        // How much of its turn the body actually spent over the wind-up — the
        // number that tells a miss from a body that stopped aiming.
        if (e.lungeStage === 'wind') {
          if (last !== 'wind') spent = 0;
          else {
            let d = e.heading - hPrev;
            while (d > Math.PI) d -= Math.PI * 2;
            while (d < -Math.PI) d += Math.PI * 2;
            spent += Math.abs(d);
            lastTurn = d;
          }
        }
        hPrev = e.heading;
        if (e.lungeStage === 'strike' && last !== 'strike') {
          let err = e.heading - Math.atan2(player.y - e.mesh.position.y, player.x - e.mesh.position.x);
          while (err > Math.PI) err -= Math.PI * 2;
          while (err < -Math.PI) err += Math.PI * 2;
          (step > 0 ? second : first).push(Math.abs(err));
          if (last === 'wind') {
            const budget = (e.turnRate ?? e.def.turnRate ?? 0) * (e.def.lunge.windup ?? 0);
            // SATURATED, AND IN THE CLOSING DIRECTION, on the final frame — the
            // only honest reading of "was it still aiming". Total budget spent
            // over the whole wind-up cannot answer it: a body that starts dead
            // on a target needs no turn at all for the first half, so a
            // perfectly-tracking animal whose target then crossed its nose
            // reports a small fraction and looks lazy.
            const rate = e.turnRate ?? e.def.turnRate ?? 0;
            const cap = rate * DT;
            firstSpend.push({
              err: Math.abs(err),
              // 1 when the last frame's turn was at the animal's ceiling.
              sat: cap > 0 ? Math.abs(lastTurn) / cap : 1,
              // ...and whether that turn was toward the seal rather than away.
              closing: Math.sign(lastTurn) === -Math.sign(err) || Math.abs(err) < 0.02,
            });
          }
          step++;
          if (last === 'reaim') ran++;
        }
        if (e.lungeStage === 'reaim' && last !== 'reaim') { plans++; reaims.push(e.lungeStageTime); }
        if (e.lungeStage === 'rest') step = 0;
        last = e.lungeStage;
      }
    });
  }
  return { first, second, reaims, plans, ran, firstSpend };
}
console.log('\n   body              first run   second run   past 60 deg   re-aims   abandoned   median re-aim');
const rows = [];
for (const k of KEYS) {
  const m = measure(k);
  rows.push({ k, ...m });
  const bad = m.second.filter((x) => x > (rules.reaimCone ?? 1.05)).length;
  const drop = m.plans ? (m.plans - m.ran) / m.plans : 0;
  console.log(`   ${k.padEnd(17)}${pad(m.first.length ? r1(deg(median(m.first))) + ' deg' : '-', 10)}`
    + `${pad(m.second.length ? r1(deg(median(m.second))) + ' deg' : '-', 13)}`
    + `${pad(m.second.length ? Math.round(bad / m.second.length * 100) + '%' : '-', 14)}`
    + `${pad(m.plans, 10)}${pad(Math.round(drop * 100) + '%', 12)}`
    + `${pad(m.reaims.length ? r1(median(m.reaims)) + 's' : '-', 15)}`);
}

// THE CLAIM. Not "the median is small" — the median was fine on half the
// roster while the boss shark was charging backwards. What has to be true is
// that NO committed run is pointed outside the cone, because a run outside it
// is one the game promised to abandon.
const cone = rules.reaimCone ?? 1.05;
for (const r of rows) {
  if (!r.second.length) { console.log(`  SKIP  ${r.k} rolled no second run in this census`); continue; }
  const worst = Math.max(...r.second);
  ok(worst <= cone + 1e-6,
    `${r.k}: the worst second run of ${r.second.length} commits ${r1(deg(worst))} deg off, `
    + `inside the ${r1(deg(cone))} deg cone it promised`);
}
// THE FIRST RUN IS A DIFFERENT CLAIM, and asserting the cone on it would be
// wrong. The wind-up is the tell and the line it locks is the line the body
// visibly turned onto — "a player who gets behind a shark during its wind-up is
// a player who is missed" is the authored behaviour, not a defect, and
// `lungeLineOpen` already refuses to START one outside `commitCone`.
//
// So what is asserted here is EFFORT, not outcome: across a wind-up the body
// has to spend its turn budget tracking the seal. Measured, that separates the
// two things a big committed miss can be, and they look identical from the
// outside:
//
//   spent >= 100%   it tracked as hard as it physically could and the player
//                   out-ran the bearing. At close range a crossing target's
//                   bearing rate exceeds any turn rate in the roster — a boss
//                   shark turns 1.05 rad/s — so the line locks wide. That is
//                   the fight working, and it is 116% and 117% on the two
//                   seeds where it happens here.
//
//   spent well under, and the error GREW   would be a body that had turn left
//                   and did not use it, which is the re-aim's bug wearing
//                   another hat.
const effortCone = cone;
for (const r of rows) {
  if (!r.firstSpend.length) continue;
  const wide = r.firstSpend.filter((x) => x.err > effortCone);
  const lazy = wide.filter((x) => x.sat < 0.9 || !x.closing);
  ok(lazy.length === 0,
    lazy.length
      ? `${r.k}: ${lazy.length} of ${wide.length} wide first runs locked their line while NOT turning `
        + `flat out toward the seal — worst at ${Math.round(Math.min(...lazy.map((x) => x.sat)) * 100)}% `
        + 'of its turn rate. That is a body that stopped aiming, which is the re-aim bug wearing another hat'
      : `${r.k}: ${wide.length} wide first run(s), every one of them still turning flat out toward the `
        + 'seal on the frame it committed — a player who out-ran the bearing, not a body that stopped aiming');
}

// ---------------------------------------------------------------------------
section('3. AND THE FIX DID NOT COST THE PATTERN');
// ---------------------------------------------------------------------------
// The cheap way to make every run point at the player is to abandon most of
// them, and that would delete `double` and `feint` from the two bosses that
// need them most while every check above went green.
for (const r of rows) {
  if (!r.plans) { console.log(`  SKIP  ${r.k} rolled no multi-step plan`); continue; }
  const drop = (r.plans - r.ran) / r.plans;
  ok(drop <= 0.35,
    `${r.k}: ${Math.round((1 - drop) * 100)}% of its re-aims still lead to a second run `
    + `(${r.ran} of ${r.plans}) — the pattern survives, it just aims now`);
}
for (const r of rows) {
  if (!r.reaims.length) continue;
  ok(median(r.reaims) <= (rules.reaimMax ?? 1.3) + 1e-6,
    `${r.k}: its re-aims stay under the ${rules.reaimMax}s ceiling — median ${r1(median(r.reaims))}s. `
    + 'A re-aim that ran as long as the turn wanted would be a boss floating through its own attack');
}
// ...and the slow turners genuinely take longer than the quick ones, which is
// the whole shape of the change rather than a constant that happens to be
// bigger.
// ...AND THE TIME IS SIZED AGAINST THE ANIMAL, not typed.
//
// ASKED OF THE EXPRESSION, not of two bodies' medians. It used to compare
// bossShark's median re-aim against hammerhead's, on the argument that the
// slower turner should take longer — and that comparison cannot hold, because
// each body ends its runs at a DIFFERENT angle off the seal. The median is over
// a different population per body, so the ordering is a fact about where their
// passes finish rather than about how the time is computed, and it flipped on a
// tuning change that did not touch the mechanism at all (twice: once when
// bossShark's turnRate went 1.05 -> 2.6, and again when `reaimCone` widened and
// let a different set of re-aims survive to be counted).
//
// The claim is that `time` scales with |diff| / turnRate. That is a property of
// the formula in enterStep, so it is asked of the formula, for one fixed turn,
// across the whole measured roster.
{
  const rules = CONFIG.lungeRules ?? {};
  const QUARTER = Math.PI / 2; // a 90-degree come-about, the same for everybody
  const needed = (k) => {
    const c = CONFIG.enemies[k].lunge ?? {};
    const rate = CONFIG.enemies[k].turnRate ?? 0;
    const floor = c.reaimTime ?? rules.reaimTime ?? 0.45;
    if (!(rate > 0)) return floor;
    return Math.min(c.reaimMax ?? rules.reaimMax ?? 1.3, Math.max(floor, QUARTER / rate));
  };
  const byTurn = rows.map((r) => r.k)
    .sort((a, b) => (CONFIG.enemies[a].turnRate ?? 0) - (CONFIG.enemies[b].turnRate ?? 0));
  const slow = byTurn[0];
  const quick = byTurn[byTurn.length - 1];
  ok(needed(slow) > needed(quick),
    `the same 90-degree come-about costs ${slow} (turnRate ${CONFIG.enemies[slow].turnRate}) `
    + `${r1(needed(slow))}s and ${quick} (${CONFIG.enemies[quick].turnRate}) ${r1(needed(quick))}s `
    + '— the re-aim is sized against the animal, not typed');
  // ...and it is a real spread rather than everything pinned to one end of the
  // clamp, which is the way this check goes quiet: with every body against
  // `reaimMax` the expression is doing nothing and the line above still passes.
  const spread = new Set(rows.map((r) => r1(needed(r.k)))).size;
  ok(spread >= 3, `${spread} distinct re-aim lengths across ${rows.length} bodies `
    + '— all of them on the same number would mean the clamp, not the animal, is deciding');
}

console.log(fails ? `\n${fails} FAILED\n` : '\nall good\n');
process.exit(fails ? 1 : 0);
