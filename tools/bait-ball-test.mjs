#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:bait
//
// BAIT BALLS — a swirling knot of small fish that everything in the water
// wants at once. See path/src/systems/baitBall.js.
//
// The feature is two claims stitched together, and both of them are the kind
// that look fine on screen while being wrong:
//
//   IT IS A BALL      "swirling" is a claim about a SHAPE that emerges from two
//                     steering terms and a speed limit. Get the ratio wrong and
//                     you still get fish moving in a vaguely circular way — you
//                     just get them at a radius nothing in the config names,
//                     which means `baitBall.radius` is a slider that does
//                     nothing. The only honest check is to run the steering and
//                     measure where they actually settle.
//   IT IS A TUG OF WAR  "predators feed on it and regain health" is a claim
//                     about an EXCHANGE. A boss's flat healPerMeal is 18 against
//                     2,400 health — 0.75% — so the mechanic could be fully
//                     wired, fire on every fish, and be worth nothing. And the
//                     opposite failure is worse and just as invisible: a heal
//                     big enough that contesting the ball is the only line.
//                     Both are answerable only in numbers, off CONFIG.
//
// Plus the pacing, which is where the user-visible rules live — "after level 4"
// and "when the arena is not very full" and "mostly during boss fights" — and
// which is unfalsifiable by playing, because a rule that fires slightly too
// often just reads as luck.
//
// Everything expected is DERIVED from CONFIG rather than typed in: saved tuning
// is merged over the defaults at import, so a hardcoded 2.6 here would be
// testing imported-tuning.json rather than the code.
//
// What it cannot tell you: whether a ball across the arena actually pulls your
// eye mid-fight, or whether losing one to a boss feels like losing something.
// That is a run.
//
//   node --import ./tools/vite-loader.mjs tools/bait-ball-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import {
  enemies, resetEnemies, updateSpawning, updateEnemies,
  spawnBaitBall, devBaitBallSpec, spawnNamed,
} from '../path/src/entities/enemies.js';
import { resolvePredation } from '../path/src/systems/predation.js';
import { resetWaves } from '../path/src/systems/waves.js';
import { player } from '../path/src/entities/player.js';
import {
  baitBalls, resetBaitBalls, updateBaitBallClock, openBaitBall, baitBallFor,
  updateBaitBalls, baitFlock, baitSeed, baitMealHeal, noteBaitLoss,
  baitBallLedger, baitNoise, attractorFlow, rollBaitShape, STRANGE_SHAPES,
} from '../path/src/systems/baitBall.js';
import {
  attachBaitShimmer, updateBaitShimmer, resetBaitShimmer,
  baitShimmerMaterialCount, MAX_SHIMMER_BALLS,
} from '../path/src/systems/baitShimmer.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const C = CONFIG.baitBall;

// The in-game ledger line is a dev readout, and this file ends thirty balls.
// Off here so the output is checks; the ledger has its own section, which
// exercises it directly rather than by watching it scroll past.
CONFIG.baitBall.log = false;

// The wildlife hunter with the longest reach, off the table rather than named.
// A harness that hardcoded 'shark' would go quietly green-and-meaningless the
// day that row is renamed — spawnNamed warns and returns null, the predator
// never exists, and "a shark left alone with a ball feeds from it" becomes a
// statement about nothing. `weight > 0` is what excludes the bosses.
const [HUNTER] = Object.entries(CONFIG.enemies)
  .filter(([, d]) => d.hunt && (d.weight ?? 0) > 0 && (d.hunt.preyRadius ?? 0) > 0)
  .sort((a, b) => (b[1].hunt.preyRadius ?? 0) - (a[1].hunt.preyRadius ?? 0))[0] ?? [];

// Seeded, and every statistical claim below is averaged over fixed seeds. A
// Monte Carlo assertion on Math.random is a test that fails one run in fifty
// for no reason, and the standard "fix" is to loosen the threshold until it
// stops — which deletes the assertion.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A stand-in arena, close enough to the real one's proportions that the
// distances mean something. bounds is real data in arena.js but it is rewritten
// by updateBounds against the camera aspect, and a harness that imported it
// would be measuring whatever the last window size was.
const ARENA = { left: -40, right: 40, bottom: -40, surfaceY: 0 };
const OFFSCREEN = 46;

console.log('BAIT BALLS');
console.log(`  level gate ${C.minLevel}, ${C.size.min}-${C.size.max} fish, `
  + `column ${C.radius * 2} x ${C.height}, ${C.spinRate} rad/s, `
  + `${(C.feed.healFrac * 100).toFixed(1)}% heal a mouthful`);

// ---------------------------------------------------------------------------
section('THE GATES — who may see one, and when');
// ---------------------------------------------------------------------------
// Both are user-visible RULES ("after level 4", "when the arena is not very
// full") and both are one comparison in one place, so both are one line away
// from being off by a level or inverted. An inverted occupancy test is the
// nastiest of the two: balls would form in a crowded arena, which is exactly
// where nobody would notice one more school.

function runClock(opts) {
  const {
    seconds = 600, level = 10, boss = null, alive = 0, dt = 1 / 30,
    seed = 1, maxAlive = CONFIG.spawn.maxAlive, onSpawn = null,
  } = opts;
  const rand = mulberry32(seed);
  resetBaitBalls();
  const spawns = [];
  // Balls expire on their own clock in the game (updateBaitBalls); this stands
  // in for that so `maxBalls` opens again. WITHOUT IT the whole rate half of
  // this file measures nothing: the first ball registers, the cap holds shut
  // for the rest of the run, and every configuration on earth returns exactly
  // one ball — which is a suite that passes while reporting a constant.
  let expires = Infinity;
  for (let t = 0; t < seconds; t += dt) {
    if (t >= expires) { baitBalls.clear(); expires = Infinity; }
    const spec = updateBaitBallClock(dt, {
      level, boss, aliveNonBoss: alive, maxAlive,
      bounds: ARENA, offscreenX: OFFSCREEN,
      player: { x: 0, y: -12 }, rand,
    });
    if (!spec) continue;
    spawns.push({ t, spec });
    // The caller owns registration, exactly as entities/enemies.js does — a
    // clock tested without it would never see maxBalls bind.
    openBaitBall(spawns.length, spec);
    expires = t + C.life;
    onSpawn?.(spawns.length, spec);
  }
  return spawns;
}

// THE GATE BINDS WHEREVER IT IS SET, and the check has to say so at any
// setting. Written as a loop from 1 to minLevel it quietly tested NOTHING the
// moment minLevel came down to 1 — an empty loop, zero assertions, and a green
// section reporting a gate it had not looked at. So the level below the gate is
// asserted explicitly when there is one, and when the gate is fully open that
// fact is asserted instead.
if (C.minLevel > 1) {
  const below = runClock({ level: C.minLevel - 1, seconds: 900 }).length;
  check(`level ${C.minLevel - 1} never sees a ball`, below === 0, `${below} in 15 minutes`);
} else {
  check('the level gate is fully open — the opening gets them too',
    runClock({ level: 1, seconds: 900 }).length > 0);
}
check(`level ${C.minLevel} does`, runClock({ level: C.minLevel, seconds: 900 }).length > 0);
// ...and it is a real gate whatever it is set to. Raised by hand rather than
// read off the config, so this keeps testing the mechanism after the shipped
// value has moved.
{
  const shut = { ...C, minLevel: 9 };
  const was = CONFIG.baitBall.minLevel;
  CONFIG.baitBall.minLevel = 9;
  const under = runClock({ level: 8, seconds: 900 }).length;
  const over = runClock({ level: 9, seconds: 900 }).length;
  CONFIG.baitBall.minLevel = was;
  void shut;
  check('...and the gate still works when it is raised',
    under === 0 && over > 0, `${under} at level 8, ${over} at level 9`);
}

// THE OPENING GETS THEM, AND QUICKLY. The whole point of dropping the level
// gate: the first minutes are the emptiest water in the run, which is exactly
// when the occupancy test is open, and a ball is the thing that is supposed to
// be happening then. Measured against the clock rather than eyeballed, because
// "does the opening feel like it has anything in it" is unanswerable by playing
// once and the gate is one comparison away from shutting it off again.
{
  const spawns = runClock({ level: 1, seconds: 300, alive: 2 });
  check('the first ball arrives inside `firstDelay`',
    spawns.length > 0 && spawns[0].t <= C.firstDelay + 1,
    spawns.length ? `${spawns[0].t.toFixed(0)}s` : 'never');
  // ...and keeps coming. One at ten seconds and then nothing for the rest of
  // the opening is not "part of the regular spawning", and it is what a single
  // arrival check would happily certify.
  const firstTwoMinutes = spawns.filter((sp) => sp.t < 120).length;
  check('...and they keep coming through the opening',
    firstTwoMinutes >= 3, `${firstTwoMinutes} in the first two minutes`);
}

const room = C.maxWater;
check('a full arena produces none',
  runClock({ alive: CONFIG.spawn.maxAlive, seconds: 900 }).length === 0);
check('one just over the threshold produces none',
  runClock({ alive: room + 1, seconds: 900 }).length === 0,
  `${room + 1} alive vs room for ${room}`);
check('one just under it does',
  runClock({ alive: room - 1, seconds: 900 }).length > 0);

// AND THE THRESHOLD HAS TO SIT BETWEEN THE TWO CASES IT IS SORTING, which is
// the claim `maxWater` actually makes and the one a number typed by eye gets
// wrong. A fight holds `boss.clearOut.foodMaxAlive` creatures; an ordinary
// mid-run arena is well past that on its way to `spawn.maxAlive`. A threshold
// below the first means bait balls never happen at all; one up near the second
// means they happen constantly, and their fish arrive outside the spawner's
// budget — which is a balance change to the whole roster, not a pacing one.
const fightWater = CONFIG.boss?.clearOut?.foodMaxAlive ?? 9;
check('the threshold is above what a boss fight holds',
  C.maxWater > fightWater, `${C.maxWater} vs ${fightWater} during a fight`);
check('...and far below a full arena',
  C.maxWater < CONFIG.spawn.maxAlive * 0.25,
  `${C.maxWater} vs ${CONFIG.spawn.maxAlive} at the cap`);

// ---------------------------------------------------------------------------
section('MOSTLY DURING A BOSS FIGHT — and never by naming a boss');
// ---------------------------------------------------------------------------
// The design claim is that this falls out of the emptiness rule rather than
// being a special case, with `bossInterval` as a thumb on the scale. Two
// separate things to check, because they fail differently: the RATE has to be
// higher during a fight, and the rate outside one has to still be non-zero
// (a ball that ONLY ever appeared in a fight would be a boss mechanic wearing
// a spawner's clothes, and the ocean would never show you one otherwise).

const FIGHT = { x: 22, y: -14 };
let fightRate = 0;
let calmRate = 0;
for (let seed = 1; seed <= 8; seed++) {
  fightRate += runClock({ boss: FIGHT, seconds: 600, seed }).length;
  calmRate += runClock({ boss: null, seconds: 600, seed }).length;
}
fightRate /= 8;
calmRate /= 8;
// Derived rather than typed, and derived from the WHOLE cycle rather than from
// the two intervals alone: a ball occupies the only slot for `life` seconds
// before the gap even starts counting, so the period is life + interval. An
// assertion written against 26/14 would be claiming a ratio the feature cannot
// produce and would have to be loosened until it stopped meaning anything.
const wantRatio = (C.life + C.interval) / (C.life + C.bossInterval);
const gotRatio = fightRate / Math.max(1e-9, calmRate);
check('a fight gets them more often',
  gotRatio > 1.1, `${gotRatio.toFixed(2)}x, config asks for ${wantRatio.toFixed(2)}x`);
check('...by about the ratio the two intervals buy',
  Math.abs(gotRatio - wantRatio) / wantRatio < 0.2,
  `${gotRatio.toFixed(2)} vs ${wantRatio.toFixed(2)}`);
check('but calm water still gets them', calmRate > 0,
  `${calmRate.toFixed(1)} per 10 minutes`);

// A boss's entrance holds the clock, and holding it means RESETTING it — not
// pausing. The bug this pins is silent by construction: an arriving boss is
// handed to the clock as `boss: null` (its position is not where it will fight
// from), so without the veto the clock reads calm water, fires, and the caller
// discards the spec. One ball per fight that the player never sees, and nothing
// anywhere reports it.
{
  const rand = mulberry32(5);
  resetBaitBalls();
  let fired = 0;
  for (let t = 0; t < 300; t += 1 / 30) {
    const spec = updateBaitBallClock(1 / 30, {
      level: 10, boss: null, hold: true, aliveNonBoss: 0,
      maxAlive: CONFIG.spawn.maxAlive, bounds: ARENA, offscreenX: OFFSCREEN,
      player: { x: 0, y: -12 }, rand,
    });
    if (spec) fired++;
  }
  check('a held clock never fires', fired === 0, `${fired}`);
}

// ---------------------------------------------------------------------------
section('ONE AT A TIME');
// ---------------------------------------------------------------------------
// maxBalls is enforced by the clock reading `baitBalls.size`, which is state
// the CALLER writes. So the failure mode is not "the cap is wrong" — it is
// "the cap is never consulted because nothing registered the ball", and that
// looks like a working feature right up until two arrive.
resetBaitBalls();
let over = 0;
{
  const rand = mulberry32(7);
  const dt = 1 / 30;
  for (let t = 0; t < 900; t += dt) {
    const spec = updateBaitBallClock(dt, {
      level: 10, boss: FIGHT, aliveNonBoss: 0, maxAlive: CONFIG.spawn.maxAlive,
      bounds: ARENA, offscreenX: OFFSCREEN, player: { x: 0, y: -12 }, rand,
    });
    if (spec) openBaitBall(`b${t}`, spec);
    if (baitBalls.size > C.maxBalls) over++;
  }
}
check('never more than maxBalls alive', over === 0, `${over} frames over ${C.maxBalls}`);

// ---------------------------------------------------------------------------
section('WHERE IT FORMS');
// ---------------------------------------------------------------------------
// Away from the fight is the whole reason feeding is a decision rather than a
// handout — the same rule the boss forage runs on. And the entrance must be
// PAST the wall: this is the one spawn the player is most likely to be looking
// at when it happens, so a ball that blinked into existence on screen is the
// pop-in the whole mechanism exists to remove.
{
  let wrongSide = 0;
  let onScreen = 0;
  let outOfBounds = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const spawns = runClock({ boss: FIGHT, seconds: 200, seed });
    for (const { spec } of spawns) {
      if (Math.sign(spec.stationX) === Math.sign(FIGHT.x)) wrongSide++;
      if (Math.abs(spec.x) < Math.abs(ARENA.right)) onScreen++;
      if (spec.stationY > ARENA.surfaceY || spec.stationY < ARENA.bottom) outOfBounds++;
    }
  }
  check('the station is always on the far side from the boss', wrongSide === 0, `${wrongSide} wrong`);
  check('the fish enter from past the wall', onScreen === 0, `${onScreen} spawned on screen`);
  check('the station is always in the water', outOfBounds === 0, `${outOfBounds} out`);
}
{
  // With no boss it is the SEAL it forms away from, which is the version that
  // stops a ball being handed to a player standing still.
  let onTop = 0;
  const rand = mulberry32(3);
  resetBaitBalls();
  for (let i = 0; i < 200; i++) {
    const spec = updateBaitBallClock(1e6, {
      level: 10, boss: null, aliveNonBoss: 0, maxAlive: CONFIG.spawn.maxAlive,
      bounds: ARENA, offscreenX: OFFSCREEN, player: { x: 30, y: -10 }, rand,
    });
    if (!spec) continue;
    if (spec.stationX > 0) onTop++;
    baitBalls.clear();
  }
  check('with no boss it forms away from the seal', onTop === 0, `${onTop} on top of the player`);
}

// ---------------------------------------------------------------------------
section('IT IS A FLOCK — what emerges, and whether they run into each other');
// ---------------------------------------------------------------------------
// THE CENTRAL SECTION, and a flock is the one thing you genuinely cannot check
// by reading the code: nothing about the result is written down in the weights.
// Every claim here is a property of a simulation that has been left to settle.
//
// It replaced a slot system, and the two failures that killed that one are the
// two this exists to catch. Slots OVERLAP — two can be a body apart in space
// and on top of each other in the picture — and rails have nothing that pushes
// anybody off anybody, so the ball read as fish colliding. And they are RIGID.
// Both looked fine in a still frame and neither is expressible as a check on a
// parameter, which is why they shipped.
function flock(n = 14, opts = {}) {
  const {
    seconds = 20, dt = 1 / 60, spin = 1, seed = 11, shell = C.radius,
    over = null, shape = 'vortex',
  } = opts;
  const rand = mulberry32(seed);
  const cfg = over ? { ...C, ...over } : C;
  const ball = { x: 0, y: -15, shell, spin, age: 0, vx: 0, vy: 0, shape };
  const fish = [];
  for (let i = 0; i < n; i++) {
    const at = baitSeed(i, n, ball, rand, cfg);
    fish.push({ x: at.x, y: at.y, z: at.z, vx: 0, vy: 0, vz: 0 });
  }
  // Mirrors the live integration: a heading out of baitFlock, lerped into the
  // velocity at `responsiveness`, at the speed the flock asks for. Getting this
  // wrong would measure a fish that does not exist — see the memory note about
  // a harness measuring the stand-in rather than the model.
  const resp = 4;
  const track = [];
  for (let t = 0; t < seconds; t += dt) {
    ball.age = t;
    for (const f of fish) {
      const h = baitFlock(f, fish, ball, cfg);
      const k = Math.min(1, resp * dt);
      f.vx += (h.x * h.speed - f.vx) * k;
      f.vy += (h.y * h.speed - f.vy) * k;
      f.vz += (h.z * h.speed - f.vz) * k;
      f.scale = h.scale;
    }
    for (const f of fish) { f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt; }
    if (t > seconds * 0.5) track.push(fish.map((f) => ({ ...f })));
  }
  return { ball, fish, track };
}

// Closest pair in a frame — the collision measure.
function tightest(frame) {
  let best = Infinity;
  for (let i = 0; i < frame.length; i++) {
    for (let j = i + 1; j < frame.length; j++) {
      const d = Math.hypot(frame[i].x - frame[j].x, frame[i].y - frame[j].y, frame[i].z - frame[j].z);
      if (d < best) best = d;
    }
  }
  return best;
}

{
  const { ball, fish, track } = flock(14);

  // THEY DO NOT RUN INTO EACH OTHER. The complaint this section was written
  // for. Measured over the settled half of the run rather than at one instant,
  // because a flock that touches once every four seconds looks exactly like one
  // that never does in any single frame you happen to screenshot.
  const worst = Math.min(...track.map(tightest));
  const body = 1.0; // a small fish's drawn long axis, from assets.js `fit`
  check('no two fish ever occupy the same water',
    worst > body * 0.45, `closest pair over ${track.length} frames: ${worst.toFixed(2)} units`);
  check('...and they are not merely spread thin to achieve it',
    Math.min(...track.map(tightest)) < C.separation * 1.6,
    `${worst.toFixed(2)} against a personal space of ${C.separation}`);

  // ...AND THE SEPARATION WEIGHT IS WHAT DOES IT. Without the mutation this
  // check passes on a build where separation has been deleted, because 14 fish
  // in a shell are fairly well spread by the wall alone.
  const noSep = flock(14, { over: { sepWeight: 0 } });
  const noSepWorst = Math.min(...noSep.track.map(tightest));
  check('...and it is `sepWeight` doing it, not luck',
    worst > noSepWorst * 1.6,
    `${worst.toFixed(2)} with separation vs ${noSepWorst.toFixed(2)} without`);

  // THE AXIS IS VERTICAL. Distance from it is x and z; y runs along it and must
  // not enter the sum. The failure this pins is a wheel facing the camera,
  // which passes every "is it a ring" test ever written and is the wrong ring.
  const all = track.flat();
  const radial = all.map((p) => Math.hypot(p.x - ball.x, p.z));
  const meanR = radial.reduce((a, r) => a + r, 0) / radial.length;
  check('the flock settles into a column about a vertical axis',
    meanR > ball.shell * 0.5 && meanR < ball.shell * 1.35,
    `${meanR.toFixed(2)} from the axis, shell ${ball.shell.toFixed(2)}`);
  check('...that really uses depth, not just the screen plane',
    Math.max(...all.map((p) => Math.abs(p.z))) > ball.shell * 0.6,
    `reaches ${Math.max(...all.map((p) => Math.abs(p.z))).toFixed(2)} in z`);
  const ys = all.map((p) => p.y - ball.y);
  check('...with height to it',
    Math.max(...ys) - Math.min(...ys) > C.height * 0.5,
    `${(Math.max(...ys) - Math.min(...ys)).toFixed(2)} tall against a configured ${C.height}`);
  // SPREAD AROUND THE AXIS, not orbiting it as a clump. The failure this pins
  // is the one a flock falls into most naturally: cohesion gathers everybody
  // into an arc, the vortex carries that arc round, and what you get is a
  // school circling a point rather than a ball. It reads as motion, it passes
  // every rotation check above, and it is not a bait ball.
  //
  // Twelve sectors about the vertical; how many hold a fish at any moment.
  // Never 100% — the flock has height as well as width, so at a given instant
  // some sectors are genuinely empty — but a clump sits near 30%.
  const coverage = track.map((frame) => {
    const bins = new Array(12).fill(0);
    for (const p of frame) {
      const a = Math.atan2(p.z, p.x - ball.x);
      bins[Math.floor(((a + Math.PI) / (Math.PI * 2)) * 12) % 12] += 1;
    }
    return bins.filter((b) => b > 0).length / 12;
  }).reduce((a, v) => a + v, 0) / track.length;
  check('...spread around the axis rather than orbiting it as a clump',
    coverage > 0.5, `${(coverage * 100).toFixed(0)}% of the sectors occupied`);

  check('...and stays put rather than wandering off',
    Math.abs(fish.reduce((a, f) => a + f.x, 0) / fish.length - ball.x) < ball.shell,
    'centroid held');
}

{
  // IT SWIRLS. Angular momentum about the vertical axis, per fish, summed —
  // and it has to be strongly ONE-SIGNED. A flock that merely churns has plenty
  // of individual rotation and a net of about zero, which is exactly what "not
  // swirling" looked like.
  const { ball, track } = flock(14);
  const spinOf = (frame) => {
    let sum = 0;
    let mag = 0;
    for (const p of frame) {
      const rx = p.x - ball.x;
      const rz = p.z;
      const cross = rx * p.vz - rz * p.vx;
      sum += cross;
      mag += Math.abs(cross);
    }
    return mag > 1e-6 ? sum / mag : 0;
  };
  const coherence = track.map(spinOf).reduce((a, v) => a + v, 0) / track.length;
  check('the flock rotates as a body, not just individually',
    coherence > 0.7, `${(coherence * 100).toFixed(0)}% of the angular motion is one way`);

  const other = flock(14, { spin: -1 });
  const otherCoh = other.track.map((frame) => {
    let sum = 0;
    let mag = 0;
    for (const p of frame) {
      const c = (p.x - other.ball.x) * p.vz - p.z * p.vx;
      sum += c; mag += Math.abs(c);
    }
    return mag > 1e-6 ? sum / mag : 0;
  }).reduce((a, v) => a + v, 0) / other.track.length;
  check('...the other way when `spin` says so', otherCoh < -0.7, `${(otherCoh * 100).toFixed(0)}%`);

  // ...and `vortexWeight` is the term responsible.
  const still = flock(14, { over: { vortexWeight: 0 } });
  const stillCoh = still.track.map((frame) => {
    let sum = 0;
    let mag = 0;
    for (const p of frame) {
      const c = (p.x - still.ball.x) * p.vz - p.z * p.vx;
      sum += c; mag += Math.abs(c);
    }
    return mag > 1e-6 ? sum / mag : 0;
  }).reduce((a, v) => a + v, 0) / still.track.length;
  check('...and `vortexWeight` is what makes it turn',
    Math.abs(stillCoh) < 0.5, `${(stillCoh * 100).toFixed(0)}% without it`);
}

{
  // SMOOTH. The other half of the complaint, and it is a claim about the second
  // derivative rather than the shape: a flock can hold a perfect ball and still
  // jitter, if the terms are fighting hard enough to reverse a fish frame to
  // frame. Measured as how often a fish's heading swings more than a right
  // angle in a single frame.
  const { track } = flock(14);
  let jerks = 0;
  let samples = 0;
  for (let i = 1; i < track.length; i++) {
    for (let j = 0; j < track[i].length; j++) {
      const a = track[i - 1][j];
      const b = track[i][j];
      const la = Math.hypot(a.vx, a.vy, a.vz);
      const lb = Math.hypot(b.vx, b.vy, b.vz);
      if (la < 1e-4 || lb < 1e-4) continue;
      samples++;
      const dot = (a.vx * b.vx + a.vy * b.vy + a.vz * b.vz) / (la * lb);
      if (dot < 0) jerks++;
    }
  }
  check('nobody reverses direction inside a frame',
    jerks === 0, `${jerks} of ${samples} steps`);

  // ...and everybody keeps moving. A flock that has locked up — every term
  // cancelling — is a still ball, which is smooth and wrong.
  const speeds = track.flat().map((p) => Math.hypot(p.vx, p.vy, p.vz));
  const meanSpeed = speeds.reduce((a, v) => a + v, 0) / speeds.length;
  const want = C.radius * C.spinRate;
  check('...and they are actually swimming',
    meanSpeed > want * 0.4, `${meanSpeed.toFixed(2)} against an orbital ${want.toFixed(2)}`);
}

{
  // THE DEPTH CUE — the half an orthographic camera makes load-bearing. Without
  // it every check above still passes and the player sees fish sliding
  // sideways. Monotone in ACTUAL z, so a fish near the axis does not swell as
  // though it were out on the rim.
  const run = flock(14);
  const ball0 = run.ball;
  const all = run.track.flat();
  const scales = all.map((p) => p.scale);
  check('a fish is drawn bigger the nearer the camera it is',
    Math.max(...scales) > 1.05 && Math.min(...scales) < 0.95,
    `${Math.min(...scales).toFixed(2)} at the back to ${Math.max(...scales).toFixed(2)} at the front`);
  // MONOTONE IN ACTUAL DEPTH, which is what makes it a cue rather than a
  // shimmer — off an ANGLE instead, a fish near the axis (barely moving in
  // depth) swells as though it were out on the rim and the ball reads as
  // breathing.
  //
  // Ties are not inversions. The cue is clamped at +/-1 shell, deliberately —
  // it bounds how big a fish may ever be drawn, and a soft wall lets one drift
  // well past the shell — so two fish out beyond it share a scale. Counting
  // that as a failure reported 805 inversions in a function that is monotone by
  // construction.
  let wrong = 0;
  let clamped = 0;
  for (let i = 0; i + 1 < all.length; i++) {
    const a = all[i];
    const b = all[i + 1];
    if (Math.abs(a.z) > ball0.shell * 1.25 || Math.abs(b.z) > ball0.shell * 1.25) clamped++;
    if (Math.abs(a.z - b.z) < 0.05) continue;
    if (Math.abs(a.scale - b.scale) < 1e-9) continue;
    if ((b.z > a.z) !== (b.scale > a.scale)) wrong++;
  }
  check('...and that scale is monotone in actual depth', wrong === 0, `${wrong} inversions`);
  check('...without flat-topping, which is the shimmer it replaces',
    clamped / all.length < 0.08,
    `${((clamped / all.length) * 100).toFixed(0)}% of samples pinned at the extremes`);
  const ball = { x: 0, y: 0, shell: C.radius, spin: 1, age: 1, vx: 0, vy: 0 };
  check('...and switching depthCue off leaves the geometry alone',
    baitFlock({ x: 1, y: 0, z: 1, vx: 0, vy: 0, vz: 0 }, [], ball, { ...C, depthCue: 0 }).scale === 1);
}

{
  // A threatened ball squeezes — `shell` is what carries that, and the flock
  // has to actually follow it, or the tell is one that never tells.
  const wide = flock(14, { shell: C.radius });
  const tight = flock(14, { shell: C.radius * C.tighten });
  const rOf = (r) => {
    const all = r.track.flat();
    return all.reduce((a, p) => a + Math.hypot(p.x - r.ball.x, p.z), 0) / all.length;
  };
  check('a threatened ball is visibly tighter',
    rOf(tight) < rOf(wide) * 0.8,
    `${rOf(tight).toFixed(2)} against ${rOf(wide).toFixed(2)} relaxed`);
}

{
  // HOW FAST IT SWIMS, off the geometry rather than off the fish: at `spinRate`
  // a fish out at the shell travels at radius x spinRate, and one given any
  // other speed cannot hold the rotation. As a fraction of the fish's OWN speed
  // — which is what this used to be — the roster's 4.6-to-7.6 spread meant a
  // ball of tuna turned half again as fast as a ball of clownfish.
  const ball = { x: 0, y: 0, shell: C.radius, spin: 1, age: 0, vx: 0, vy: 0 };
  const held = baitFlock({ x: C.radius, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }, [], ball).speed;
  check('a fish swims at the speed its ball\'s rotation implies',
    Math.abs(held - C.radius * C.spinRate) < 0.01,
    `${held.toFixed(2)} = radius x spinRate`);
  // ...and carries the anchor's own travel on top. Missing, a ball fleeing a
  // shark outruns its own flock and drags it into a comet tail.
  const running = baitFlock({ x: C.radius, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
    [], { ...ball, vx: 3, vy: 0 }).speed;
  check('...plus whatever the ball itself is travelling at',
    Math.abs(running - held - 3) < 0.01, `${running.toFixed(2)} while the ball runs at 3`);
}

// ---------------------------------------------------------------------------
section('THE ANCHOR — arriving, wallowing, and running');
// ---------------------------------------------------------------------------
function driveBall(spec, opts = {}) {
  const { seconds = 30, dt = 1 / 60, predators = [], player = null, alive = 12 } = opts;
  resetBaitBalls();
  const ball = openBaitBall('t', spec);
  const schools = new Map([['t', new Array(alive).fill(0).map(() => ({}))]]);
  const track = [];
  for (let t = 0; t < seconds; t += dt) {
    updateBaitBalls(dt, {
      schools,
      predators: typeof predators === 'function' ? predators(t, ball) : predators,
      player, bounds: ARENA,
    });
    if (!baitBalls.has('t')) break;
    track.push({ t, x: ball.x, y: ball.y, shell: ball.shell, threat: ball.threat, arriving: ball.arriving });
  }
  return { ball, track };
}

const SPEC = { x: -OFFSCREEN, y: -18, stationX: -18, stationY: -18, side: -1, spin: 1, count: 12 };
{
  const { ball, track } = driveBall(SPEC, { seconds: 20 });
  const arrivedAt = track.find((s) => !s.arriving)?.t ?? Infinity;
  check('the ball swims in from past the wall', arrivedAt < 15, `on station at ${arrivedAt.toFixed(1)}s`);
  check('...and holds its station', Math.hypot(ball.x - SPEC.stationX, ball.y - SPEC.stationY) < C.leash + 2,
    `${Math.hypot(ball.x - SPEC.stationX, ball.y - SPEC.stationY).toFixed(1)} units off`);
  const moved = track.slice(-600).reduce((a, s, i, arr) => (i ? a + Math.hypot(s.x - arr[i - 1].x, s.y - arr[i - 1].y) : 0), 0);
  check('...wallowing rather than parked', moved > 1, `${moved.toFixed(1)} units of drift in the last 10s`);
  const outside = track.some((s) => s.x < ARENA.left || s.x > ARENA.right
    || s.y > ARENA.surfaceY || s.y < ARENA.bottom);
  check('...and never leaves the water once it is in', !outside);
}
{
  // A shark parks on it. The ball must RUN — that is what turns "swim to the
  // fish" into "swim to where the fish are going" — and it must tighten.
  const chaser = (t, ball) => [{ x: ball.x - 3, y: ball.y }];
  const { ball, track } = driveBall(SPEC, { seconds: 40, predators: chaser });
  const settled = track.filter((s) => !s.arriving);
  const meanThreat = settled.reduce((a, s) => a + s.threat, 0) / Math.max(1, settled.length);
  check('a predator on the ball reads as threat', meanThreat > 0.5, `${meanThreat.toFixed(2)}`);
  check('...and the shell squeezes toward `tighten`',
    ball.shell < C.radius * (1 - (1 - C.tighten) * 0.5) + 1e-6,
    `${ball.shell.toFixed(2)} of ${C.radius}`);
  const off = Math.hypot(ball.x - SPEC.stationX, ball.y - SPEC.stationY);
  check('...but the leash stops it being driven into a corner',
    ball.x > ARENA.left && ball.x < ARENA.right && off < C.leash * 2.5,
    `${off.toFixed(1)} units off station`);
}
{
  // The seal counts too, at a lower weight — a ball you cannot approach at all
  // is not food.
  //
  // PEAK threat, not the value at the end. A stationary threat is one the ball
  // successfully runs away from, so by the last frame both readings are zero
  // and a final-value comparison passes for the wrong reason — 0 < 0 is not
  // "the seal is less frightening", it is "nothing was measured".
  const nearSeal = { x: SPEC.stationX + 2, y: SPEC.stationY };
  const peak = (r) => r.track.reduce((a, s) => Math.max(a, s.threat), 0);
  const withSeal = peak(driveBall(SPEC, { seconds: 30, player: nearSeal }));
  const withShark = peak(driveBall(SPEC, { seconds: 30, predators: [nearSeal] }));
  check('the seal scares it, but less than a shark does',
    withSeal > 0 && withSeal < withShark,
    `seal ${withSeal.toFixed(2)} vs shark ${withShark.toFixed(2)}`);
  // ...by about `playerWeight`. The looser check above would pass on any
  // difference at all, including one small enough that the two are the same
  // event on screen — and the shape of the bug it is guarding against (the
  // weight applied to the shove and not to the panic) produces exactly no
  // difference, so it is worth pinning the size as well as the sign.
  check('...by roughly playerWeight',
    Math.abs(withSeal / withShark - C.flee.playerWeight) < 0.15,
    `${(withSeal / withShark).toFixed(2)} vs ${C.flee.playerWeight}`);
}

// ---------------------------------------------------------------------------
section('THE CLOCK ON IT');
// ---------------------------------------------------------------------------
// A ball that never ended would be a permanent feeding station, and the whole
// tension is that it is temporary: leave it and it is gone, and whatever fed
// from it kept the difference.
{
  const { track } = driveBall(SPEC, { seconds: C.life + 30 });
  check('a ball left alone eventually disperses',
    track[track.length - 1].t < C.life + 1, `ended at ${track[track.length - 1].t.toFixed(0)}s of ${C.life}`);
}
{
  const { track } = driveBall(SPEC, { seconds: 30, alive: C.disperseAt });
  check('...and so does one eaten down past `disperseAt`',
    track.length <= 1, `${C.disperseAt} fish left`);
}
{
  // The ids of the ended balls come BACK, and that return is the only thing
  // that takes the flag off the survivors. Without it a dispersed ball's fish
  // keep steering at a ball nothing is updating — they would mill on the spot,
  // forever, at a station in open water.
  resetBaitBalls();
  openBaitBall('gone', { ...SPEC, count: 1 });
  const schools = new Map([['gone', [{}]]]);
  const dispersed = updateBaitBalls(1 / 60, { schools, predators: [], player: null, bounds: ARENA });
  check('a dispersed ball reports itself back so the fish can be released',
    dispersed.some((b) => b.id === 'gone') && baitBallFor('gone') === null);
  // ...carrying its LEDGER, which is the only thing that survives it. A ball
  // that returned an id alone deleted its counters on the exact frame they
  // finally meant something.
  check('...with the counters still on it',
    dispersed[0] && typeof dispersed[0].eaten === 'number' && typeof dispersed[0].taken === 'number');
}

// ---------------------------------------------------------------------------
section('THE LEDGER — which side got how much');
// ---------------------------------------------------------------------------
// The one readout the mechanic has, and it exists because the exchange is
// invisible while it is happening: a boss eating four fish while the player
// takes nine looks, in the moment, exactly like the reverse. The trap is a
// summary that reads its two counters the wrong way round — which is a line
// that tells you calmly that you are winning while you lose.
{
  resetBaitBalls();
  const ball = openBaitBall('led', { ...SPEC, count: 12 });
  for (let i = 0; i < 3; i++) noteBaitLoss('led', 'predator');
  for (let i = 0; i < 7; i++) noteBaitLoss('led', 'player');
  check('both sides are counted', ball.eaten === 3 && ball.taken === 7,
    `${ball.taken} yours, ${ball.eaten} theirs`);
  // `count` is the live headcount updateBaitBalls refreshes every frame, and
  // the ledger reads the survivors off it rather than deriving them — see
  // baitBallLedger.
  const line = baitBallLedger({ ...ball, count: 2, timedOut: true });
  // `, 2 swam off` with the comma, not `2 swam off`: the loose version is a
  // substring of `12 swam off` and passed against a ledger reporting twelve
  // survivors out of twelve after ten of them had been eaten.
  check('...and the line says so the right way round',
    line.includes('you took 7') && line.includes('they ate 3') && line.includes(', 2 swam off'),
    line);
  check('...and reports your share of what was actually contested',
    line.includes('70%'), line);
  // A FISH THAT LEFT SOME OTHER WAY IS SAID, not absorbed. Derived survivors
  // were the original version and they made this line lie: every fish taken by
  // a haul, a whale, or an ability that removes without a kill was reported as
  // having swum off, and the ledger quietly overstated how much of the ball
  // nobody got.
  const holed = baitBallLedger({ ...ball, count: 0, timedOut: false });
  check('...and a fish that left by some other route is reported, not absorbed',
    holed.includes(', 0 swam off') && holed.includes('2 left some other way'), holed);
  noteBaitLoss(null, 'player');
  noteBaitLoss('nosuchball', 'player');
  check('a fish that was never in a ball books nothing', ball.taken === 7);
}

// ---------------------------------------------------------------------------
section('THE TUG OF WAR — what a mouthful is actually worth');
// ---------------------------------------------------------------------------
// The failure this exists to catch: the whole mechanic wired, firing on every
// fish, and worth nothing. `hunt.healPerMeal` is a flat number authored against
// the wildlife — 18 on a 75-health shark is a quarter of its bar, and the same
// 18 on a boss with 2,400 is 0.75%. A boss eating a whole ball would gain less
// than the player's dps in a second, and nobody would ever contest one.
const SHARK = CONFIG.enemies.shark;
const BOSS = CONFIG.enemies.bossShark;
{
  const sharkBase = SHARK.hunt.healPerMeal;
  check('a bait meal never pays a shark LESS than an ordinary fish',
    baitMealHeal(SHARK.hp, sharkBase) >= sharkBase,
    `${baitMealHeal(SHARK.hp, sharkBase).toFixed(1)} vs ${sharkBase}`);

  const bossBase = BOSS.hunt.healPerMeal;
  const bossMeal = baitMealHeal(BOSS.hp, bossBase);
  check('...and pays a boss at least its flat heal at base health',
    bossMeal >= bossBase, `${bossMeal.toFixed(0)} vs the flat ${bossBase}`);

  // THE REASON THE HEAL IS A FRACTION AT ALL, and it is not visible at base
  // health — at 1,688 the flat 18 is already about 1%, which is why "is the
  // fraction bigger than the flat number" is the wrong question. A boss's
  // health ramps at `hpPerDifficulty` and nothing ramps `healPerMeal`, so a
  // flat heal is a share that COLLAPSES over a run: by the late game the same
  // 18 is a fifth of a percent and a whole ball is worth nothing. The fraction
  // is a share that holds. That is the property to assert, because it is the
  // one that decides whether this mechanic still exists at minute twelve.
  const lateHp = BOSS.hp + BOSS.hpPerDifficulty * 10;
  const flatShare = bossBase / lateHp;
  const fracShare = baitMealHeal(lateHp, bossBase) / lateHp;
  check('...and the fraction is what keeps it worth anything late in a run',
    fracShare > flatShare * 2,
    `at difficulty 10 a boss has ${lateHp.toFixed(0)}hp: flat is `
    + `${(flatShare * 100).toFixed(2)}%, this is ${(fracShare * 100).toFixed(2)}%`);

  // The whole-ball exchange, which is the number the design is actually about.
  // Both ends matter and they fail in opposite directions: too small and the
  // ball is scenery, too big and "ignore the fish, kill the boss" stops being
  // a line anyone can take.
  const worst = C.size.max * bossMeal / BOSS.hp;
  const best = C.size.min * bossMeal / BOSS.hp;
  check('a whole ball is a real slice of a boss bar',
    best > 0.06, `${(best * 100).toFixed(0)}% at the smallest ball`);
  check('...and never enough that contesting it is compulsory',
    worst < 0.35, `${(worst * 100).toFixed(0)}% at the largest`);
}
{
  // AND IT MAY NOT OVERHEAL. A boss's bar is drawn at the health it arrived
  // with; a heal past that would pin the bar at 100% while the fight quietly
  // got longer, which is the bar lying about the one number it reports.
  // Mirrors the arithmetic in systems/predation.js.
  const eat = (hp, spawnHp, base, bait) => {
    const heal = bait ? baitMealHeal(spawnHp, base) : base;
    const ceiling = bait ? Math.max(hp, spawnHp) : spawnHp * (BOSS.hunt.maxOverheal ?? 2);
    return Math.min(ceiling, hp + heal);
  };
  let hp = BOSS.hp * 0.5;
  for (let i = 0; i < 400; i++) hp = eat(hp, BOSS.hp, BOSS.hunt.healPerMeal, true);
  check('a boss cannot eat its way past full', hp <= BOSS.hp + 1e-6,
    `${hp.toFixed(0)} of ${BOSS.hp}`);

  // ...and a shark that has ALREADY overhealed off ordinary fish must not be
  // cut back down by swimming through a bait ball. A ceiling below the current
  // value is a heal that heals negatively, and it would have looked like the
  // ball damaging sharks.
  const fat = SHARK.hp * 1.4;
  check('...and an already-overhealed shark is never cut back down',
    eat(fat, SHARK.hp, SHARK.hunt?.healPerMeal ?? 0, true) >= fat, `${fat}`);
}
{
  // The switch. `feed.enabled: false` has to leave the ordinary heal exactly
  // where it was — an off switch that also nerfs the wildlife is a switch
  // nobody can use to A/B the feature.
  const off = { ...C, feed: { ...C.feed, enabled: false } };
  check('feed.enabled off leaves the ordinary heal untouched',
    baitMealHeal(BOSS.hp, BOSS.hunt.healPerMeal, off) === BOSS.hunt.healPerMeal);
}

// ---------------------------------------------------------------------------
section('THE SWITCH');
// ---------------------------------------------------------------------------
// Off must mean off, from the first frame, with no state left behind — this is
// the row that makes the whole feature an honest A/B against the build that
// shipped without it.
{
  const was = CONFIG.baitBall.enabled;
  CONFIG.baitBall.enabled = false;
  const n = runClock({ seconds: 900, boss: FIGHT }).length;
  CONFIG.baitBall.enabled = was;
  check('baitBall.enabled off produces none at all', n === 0, `${n}`);
}

// ---------------------------------------------------------------------------
section('THE WIRING — the same thing again, through the real spawner');
// ---------------------------------------------------------------------------
// Everything above tests systems/baitBall.js, which is deliberately a module
// with no scene in it — and that is exactly the shape of test that certifies a
// feature nobody can see. The half that is not in there is one flag
// (`e.baitBall`, set in updateBaitBallSpawn and read in BEHAVIORS.swarm) and
// one call site, and if either is missing every check above still passes while
// the game shows you an ordinary school swimming at the seal.
//
// So this runs the actual loop: updateSpawning puts a ball in the water,
// updateEnemies steers it, and what comes out is measured. It also catches the
// thing the pure model structurally cannot — the OTHER terms in the boids sum.
// Separation is the loud one: at the schools' own value it holds a ball 65%
// wider than `radius` says, which is why `packing` exists.
//
// SEEDED, AND REPEATED, because the species is ROLLED. The small fry in
// enemies.csv run from speed 4.6 to 7.6 and carry different school separation,
// and it is speed that decides how wide a ball settles — so one unseeded run
// measures whatever fish it happened to draw. This check flaked between 2.95
// and 3.44 across two runs on identical code, which is a threshold that will
// eventually be "fixed" by loosening it. `millSpeed` is what makes every ball
// the same size whatever is in it, and repeating over fixed seeds is what
// proves that rather than assuming it.
function wiringRun(seed) {
  const scene = new THREE.Scene();
  const orig = Math.random;
  Math.random = mulberry32(seed);
  resetEnemies(scene);
  resetWaves(0);
  const gs = { difficulty: 6, level: 10 };
  // THE SEAL THE SPAWNER ITSELF READS. updateBaitBallSpawn asks the `player`
  // singleton where the seal is, not whatever position this loop hands
  // updateEnemies — so a harness that put its own vector in here would place
  // the ball relative to one seal and then measure the distance to a different
  // one. It read as the ball forming on top of the player, which is the exact
  // bug this check exists to catch, and it was the test that was wrong.
  const playerPos = player.mesh?.position ?? new THREE.Vector3(0, 0, 0);
  const dt = 1 / 60;
  let formedAt = -1;
  // SAMPLED OVER A WINDOW, not read off the last frame. Every quantity here
  // swings as the ball turns — at one instant the whole flock can be on one
  // side of the axis in depth, and the z span then reads half what it does a
  // second later. A single-frame reading of a rotating thing is a reading of
  // where the rotation happened to be.
  const out = {
    formedAt: -1, balls: 0, fish: 0, shell: NaN, of: 0, species: 0, type: '?',
    fromPlayer: 0, radial: 0, radialN: 0, closest: Infinity, samples: 0,
    zMin: Infinity, zMax: -Infinity, scaleMin: Infinity, scaleMax: -Infinity,
  };
  for (let t = 0; t < 28; t += dt) {
    updateSpawning(dt, gs, scene);
    updateEnemies(dt, scene, playerPos, () => {}, () => {}, () => {});
    if (baitBalls.size && formedAt < 0) formedAt = t;
    // Hold the water sparse so the gate stays open — this is standing in for a
    // boss fight's clear-out, which is where a ball normally lives. Bait fish
    // are never culled: they are the subject.
    //
    // AND ONCE A BALL EXISTS, everything that is not in it goes. Not tidiness:
    // a shark inside `fleeRadius` blows the ball open on purpose (that is the
    // mechanic), so one measured in traffic is measuring the scattering rather
    // than the shape. The scattering has its own checks, on the anchor, above.
    for (let i = enemies.length - 1; i >= 0; i--) {
      if (enemies[i].baitBall) continue;
      if (baitBalls.size || enemies.length > 18) enemies.splice(i, 1);
    }

    if (t > 22 && baitBalls.size) {
      const ball = [...baitBalls.values()][0];
      const mine = enemies.filter((e) => e.baitBall && e.schoolId === ball.id);
      if (!mine.length) continue;
      out.samples += 1;
      out.shell = ball.shell;
      out.of = mine.length;
      out.type = mine[0].type;
      out.species = new Set(mine.map((e) => e.type)).size;
      out.fromPlayer = Math.hypot(ball.x - playerPos.x, ball.y - playerPos.y);
      for (const e of mine) {
        // IN X AND Z, because the axis is vertical. In x and y — which is what
        // a wheel wants — a perfectly good ball reads two thirds of its radius,
        // because that is what the screen-plane projection of a horizontal
        // orbit averages.
        out.radial += Math.hypot(e.mesh.position.x - ball.x, e.mesh.position.z - (e.laneZ ?? 0));
        out.radialN += 1;
        const z = e.mesh.position.z - (e.laneZ ?? 0);
        if (z < out.zMin) out.zMin = z;
        if (z > out.zMax) out.zMax = z;
        const sc = e.visual.scale.x / (e.spawnScale * e.baseScale);
        if (sc < out.scaleMin) out.scaleMin = sc;
        if (sc > out.scaleMax) out.scaleMax = sc;
      }
      // THE COLLISION MEASURE, in the real loop, over the whole window. This is
      // the check the whole rewrite exists for, and every part of it can be
      // right in the pure model and still not reach the game: the heading goes
      // through steerTo, which normalises and lerps, and the depth is
      // integrated in a different function again.
      for (let i = 0; i < mine.length; i++) {
        for (let j = i + 1; j < mine.length; j++) {
          const p = mine[i].mesh.position;
          const q = mine[j].mesh.position;
          const d = Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
          if (d < out.closest) out.closest = d;
        }
      }
    }
  }
  out.formedAt = formedAt;
  out.balls = baitBalls.size;
  out.fish = enemies.filter((e) => e.baitBall).length;
  out.mean = out.radialN ? out.radial / out.radialN : NaN;
  out.zSpan = out.zMax - out.zMin;
  out.scaleSpan = out.scaleMax - out.scaleMin;
  Math.random = orig;
  return out;
}

{
  const runs = [1, 2, 3, 4, 5].map(wiringRun);
  check('the real spawner puts a ball in the water',
    runs.every((r) => r.formedAt >= 0 && r.balls === 1),
    runs.map((r) => (r.formedAt >= 0 ? `${r.formedAt.toFixed(0)}s` : 'never')).join(', '));
  check('...and its fish carry the flag the swarm reads',
    runs.every((r) => r.fish >= C.disperseAt), runs.map((r) => r.fish).join(', '));

  // AGAINST THE BALL'S OWN SHELL, not against `radius`. `radius` is the width
  // at a NOMINAL ball and every real one scales off it by the square root of
  // its headcount — so an assertion against the config constant is an
  // assertion that the packing rule is switched off, and would have to be
  // loosened to about 30% to pass, at which point it stops saying anything.
  //
  // The fraction is below 1 by construction: `shellThickness` puts the average
  // fish inside the outer surface and `sphericity` pulls the ends further in.
  const fill = runs.map((r) => r.mean / r.shell);
  const avgFill = fill.reduce((a, f) => a + f, 0) / fill.length;
  check('...and the fish sit about where the shell their ball has is',
    avgFill > 0.7 && avgFill < 1.25,
    `${(avgFill * 100).toFixed(0)}% of the shell — mean ${runs.map((r) => r.mean.toFixed(2)).join(', ')}`);
  // ...and it is that shape WHATEVER IS IN IT. The claim `spinRate` makes by
  // being a rate rather than a fraction of the fish's own speed: the roster's
  // small fry run 4.6 to 7.6, and as a fraction their widths ranged over 65%.
  check('...whatever species it rolled',
    Math.max(...fill) - Math.min(...fill) < 0.2,
    runs.map((r) => `${r.type} ${(r.mean / r.shell).toFixed(2)}`).join(', '));

  // THE PACKING RULE, which is what makes a small ball a knot rather than a
  // scatter — and what makes a ball visibly shrink as it is eaten. Without it
  // `radius` is a fixed width and the density is decided by a spawn roll.
  check('...and a ball is sized to its headcount',
    runs.every((r) => Math.abs(r.shell - C.radius * Math.sqrt(r.of / ((C.size.min + C.size.max) / 2))) < 0.25),
    runs.map((r) => `${r.of} fish -> ${r.shell.toFixed(2)}`).join(', '));

  // THEY DO NOT COLLIDE — IN THE GAME. The complaint this whole rewrite
  // answers, and the pure model passing it is not the same claim: the flock's
  // heading is fed through steerTo, which normalises and lerps it, and the
  // depth is integrated somewhere else again. Either could drop the separation
  // on the floor and every check in the flock section would stay green.
  check('...and no two of them share the same water',
    runs.every((r) => r.closest > 0.45),
    runs.map((r) => r.closest.toFixed(2)).join(', ') + ' units at the closest');

  // THE TWO WIRES THAT MAKE THE ROTATION VISIBLE, and both fail silently. The z
  // write lives in updateEnemies' entrance block, one `else if` away from a
  // lane-easing branch that would smear the orbit into a lag; the scale write
  // shares a line with the hit-pop, which used to clobber it. Neither throws,
  // and without them the player sees fish sliding sideways.
  check('...their depth driven for real',
    runs.every((r) => r.zSpan > C.radius * 1.5),
    runs.map((r) => r.zSpan.toFixed(1)).join(', ') + ' units of z');
  check('...and the depth cue reaching the bodies',
    runs.every((r) => r.scaleSpan > C.depthCue),
    runs.map((r) => r.scaleSpan.toFixed(2)).join(', ') + ' of scale spread');
  check('...one species per ball, not a mixed bag', runs.every((r) => r.species === 1));
  // THE POINT OF THE WHOLE THING. If the fish still carried the schools' seek
  // they would have delivered themselves to the seal by now — the arena is
  // 80 units wide and each run is 28 seconds.
  check('...and it did NOT come to the player',
    runs.every((r) => r.fromPlayer > 15),
    runs.map((r) => r.fromPlayer.toFixed(0)).join(', ') + ' units away');
}

// ---------------------------------------------------------------------------
section('THE EXCHANGE ACTUALLY HAPPENS — a predator on a real ball');
// ---------------------------------------------------------------------------
// The check that decides whether any of this is a mechanic or just a nice
// swirl. Everything above can pass with predators completely unable to feed:
// the heal arithmetic is right, the ledger counts correctly, the ball forms and
// spins — and a shark still swims past it once and never comes back.
//
// That was the shipped behaviour before `pull`. A hunter spends only a fraction
// of its turn rate on prey (CONFIG.cruiseHunt), so it overshoots on its cruise,
// leaves its own preyRadius, and has nothing to bring it round. Measured: one
// fish in forty seconds, from a shark dropped five units away.
//
// The mutation is the point of the section. Assert only "predators eat some"
// and the check passes on a build where `pull` has been deleted, because "some"
// is one. So this runs the same fight twice, once with the wider draw and once
// without, and asserts the DIFFERENCE.
function feedRun(seed, pull) {
  const scene = new THREE.Scene();
  const orig = Math.random;
  const wasPull = CONFIG.baitBall.pull;
  CONFIG.baitBall.pull = pull;
  Math.random = mulberry32(seed);
  resetEnemies(scene);
  resetWaves(0);
  const pp = player.mesh?.position ?? new THREE.Vector3(0, 0, 0);
  const ball = spawnBaitBall(scene, 6, 10, devBaitBallSpec());
  if (ball) {
    ball.arriving = false;
    for (const e of enemies) if (e.schoolId === ball.id) e.entering = false;
  }
  const pred = spawnNamed(scene, HUNTER, 6,
    { x: (ball?.x ?? 0) + 5, y: ball?.y ?? 0 }, { ignoreCaps: true, overfill: true });
  if (pred) pred.entering = false;
  const dt = 1 / 60;
  for (let t = 0; t < C.life; t += dt) {
    updateEnemies(dt, scene, pp, () => {}, () => {}, () => {});
    resolvePredation(dt, scene, {});
    if (!baitBalls.size) break;
  }
  Math.random = orig;
  CONFIG.baitBall.pull = wasPull;
  return ball?.eaten ?? 0;
}

{
  const seeds = [1, 2, 3, 4, 5, 6];
  const withPull = seeds.map((s) => feedRun(s, CONFIG.baitBall.pull));
  const without = seeds.map((s) => feedRun(s, 1));
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  check(`a ${HUNTER} left alone with a ball actually feeds from it`,
    HUNTER && sum(withPull) / seeds.length >= 2,
    `${(sum(withPull) / seeds.length).toFixed(1)} fish a ball — ${withPull.join(', ')}`);
  check('...and it is `pull` that brings it back round, not luck',
    sum(withPull) > sum(without) * 1.5,
    `${sum(withPull)} fish with the wider draw vs ${sum(without)} without`);
  // The other direction, and it is the one that keeps this from being a
  // mechanic the player cannot win: a hunter must not clear a whole ball on its
  // own before the seal can cross the arena.
  check('...but never strips the whole ball on its own',
    Math.max(...withPull) < C.size.max,
    `worst case ${Math.max(...withPull)} of ${C.size.min}-${C.size.max}`);
}

// ---------------------------------------------------------------------------
section('THE NOISE — and that it is the SAME field the shader samples');
// ---------------------------------------------------------------------------
// baitNoise is a hand port of noiseFbm from systems/noiseGlsl.js, and the whole
// value of the shimmer rests on the two being the same function: the bright
// patch drifting through a ball is supposed to BE the drift pushing those fish
// around. A port that has quietly diverged still produces a perfectly nice
// shimmer — one that has nothing to do with the motion, moving at a different
// speed, and there is nothing on screen that would ever say so.
//
// Node cannot run the GLSL, so this checks the properties that would break if
// the two stopped agreeing: the same lattice period, the same three-octave
// falloff, the same output range, and continuity across cell boundaries (a lerp
// where the quintic should be shows the lattice as creases in one and not the
// other).
{
  check('the field is bounded and signed',
    (() => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < 4000; i++) {
        const v = baitNoise(i * 0.137, i * 0.311 - 12, i * 0.079 + 5);
        lo = Math.min(lo, v); hi = Math.max(hi, v);
      }
      return lo < -0.15 && hi > 0.15 && lo > -1.2 && hi < 1.2;
    })(), 'roughly -1..1 either side of zero');

  // CONTINUOUS ACROSS A LATTICE BOUNDARY. Perlin's whole trick, and the one
  // thing a careless port drops — a plain lerp instead of the smoothstep still
  // looks like noise and shows the grid as faint creases.
  let worst = 0;
  for (let i = 1; i <= 400; i++) {
    const t = 0.98 + i * 0.0001;
    const a = baitNoise(t, 0.4, 0.7);
    const b = baitNoise(t + 0.0001, 0.4, 0.7);
    worst = Math.max(worst, Math.abs(b - a));
  }
  check('...and continuous across a cell boundary', worst < 0.01,
    `largest step over a 1e-4 sample near x=1: ${worst.toFixed(5)}`);

  // ZERO AT THE ORIGIN, which every gradient noise is and value noise is not —
  // the cheapest single test that this is still Perlin and not something that
  // merely looks noisy. Only the ORIGIN: fbm rescales the point by 2.02 per
  // octave, so every other lattice corner is off-lattice for octaves two and
  // three and legitimately non-zero. Asserting those too is how this check
  // first failed, against a port that was correct.
  check('...and zero at the origin, as a gradient noise must be',
    Math.abs(baitNoise(0, 0, 0)) < 1e-12);

  // Three octaves at half amplitude each, so the fine detail is an eighth of
  // the coarse. Measured as the roughness at two sample spacings.
  const rough = (step) => {
    let sum = 0;
    for (let i = 0; i < 600; i++) {
      sum += Math.abs(baitNoise(i * step, 1.3, 2.1) - baitNoise((i + 1) * step, 1.3, 2.1));
    }
    return sum / 600;
  };
  check('...with fine detail well under the coarse, i.e. three octaves',
    rough(0.05) < rough(0.5) * 0.6,
    `${rough(0.05).toFixed(4)} at 0.05 vs ${rough(0.5).toFixed(4)} at 0.5`);
}

{
  // AND IT REACHES THE FLOCK. `noiseWeight` is a real term or it is a knob that
  // does nothing — and "does nothing" is indistinguishable from "does
  // something subtle" by eye, which is the whole reason to measure it.
  const still = flock(14, { over: { noiseWeight: 0 } });
  const noisy = flock(14, { over: { noiseWeight: C.noiseWeight } });
  // DIVERGENCE OF THE TRAJECTORIES, not the per-frame heading wander. That was
  // the obvious measure and it read 0.00016 either way: at 1/60 of a second and
  // a responsiveness of 4, consecutive velocities are nearly identical whatever
  // is steering, so the metric is saturated before the noise gets a say. Same
  // seed and same start, so any distance between the two at the end is the
  // noise and nothing else.
  const apart = still.fish.reduce((a, f, i) => a
    + Math.hypot(f.x - noisy.fish[i].x, f.y - noisy.fish[i].y, f.z - noisy.fish[i].z), 0)
    / still.fish.length;
  check('the noise actually moves the fish',
    apart > C.radius * 0.3,
    `${apart.toFixed(2)} units apart after 20s from an identical start`);
  // ...without breaking the shape it is meant to be roughening.
  const rOf = (r) => {
    const all = r.track.flat();
    return all.reduce((a, p) => a + Math.hypot(p.x - r.ball.x, p.z), 0) / all.length;
  };
  check('...without shaking the ball apart',
    Math.abs(rOf(noisy) - rOf(still)) / rOf(still) < 0.3,
    `${rOf(noisy).toFixed(2)} against ${rOf(still).toFixed(2)}`);
}

// ---------------------------------------------------------------------------
section('STRANGE ATTRACTORS — the experimental balls');
// ---------------------------------------------------------------------------
// Every one of these is a chaotic system, and the failure that matters is the
// one they share: an orbit that ESCAPES. A ball whose flow field points
// outward everywhere is a school leaving the arena, and the wall would spend
// the whole ball's life fighting it — which reads as a knot of fish grinding
// against an invisible barrier, not as a shape.
{
  for (const shape of STRANGE_SHAPES) {
    // Integrate the raw field as a particle and see where it ends up. Bounded
    // is the property; the actual trajectory is chaotic and unassertable.
    let x = 0.3;
    let y = 0.2;
    let z = -0.1;
    let far = 0;
    let moved = 0;
    let stuck = 0;
    for (let i = 0; i < 40000; i++) {
      const f = attractorFlow(shape, x, y, z);
      const l = Math.hypot(f.x, f.y, f.z);
      if (l < 1e-4) { stuck++; continue; }
      // Unit steps, exactly as a fish takes them: the flock steers ALONG the
      // streamline at its own speed rather than integrating the system, so the
      // reachable set is what matters and not the system's own time.
      x += (f.x / l) * 0.01;
      y += (f.y / l) * 0.01;
      z += (f.z / l) * 0.01;
      moved += 0.01;
      far = Math.max(far, Math.hypot(x, y, z));
    }
    check(`${shape} stays in a bounded region`,
      far < 6 && Number.isFinite(far), `reaches ${far.toFixed(2)} shells in ${moved.toFixed(0)} units of swimming`);
    check(`...and ${shape} never stalls`, stuck < 50, `${stuck} frames with no flow`);
    // ...and it is not a circle. The point of the experiment.
    check(`...and ${shape} does not simply orbit`,
      Math.hypot(x, y, z) > 0.05,
      'ends somewhere the plain vortex would not');
  }
}

{
  // A ball rolls its shape ONCE and keeps it. Re-rolling per frame would have
  // the mass change its mind about what shape it is, which is not chaos.
  const rand = mulberry32(4);
  let strange = 0;
  const n = 4000;
  for (let i = 0; i < n; i++) if (rollBaitShape(rand) !== 'vortex') strange += 1;
  check('strange balls turn up at about `strangeChance`',
    Math.abs(strange / n - C.strangeChance) < 0.03,
    `${((strange / n) * 100).toFixed(0)}% against a configured ${(C.strangeChance * 100).toFixed(0)}%`);
  check('...and never at all when the experiment is switched off',
    Array.from({ length: 500 }, () => rollBaitShape(rand, { ...C, strangeChance: 0 }))
      .every((v) => v === 'vortex'));
  // Every name the roll can produce has to be a shape attractorFlow knows. A
  // name it does not know silently falls through to Thomas, so a typo here is
  // three attractors that are all the same one.
  const distinct = new Set(STRANGE_SHAPES.map((sh) => {
    const f = attractorFlow(sh, 0.4, 0.3, 0.2);
    return `${f.x.toFixed(4)},${f.y.toFixed(4)},${f.z.toFixed(4)}`;
  }));
  check('...and the three are genuinely three different systems',
    distinct.size === STRANGE_SHAPES.length, `${distinct.size} distinct flows`);
}

{
  // A strange ball still has to be FOOD: held together, in the water, and
  // reachable. An attractor that scattered its fish across the arena would be
  // a lovely shape and a broken mechanic.
  for (const shape of STRANGE_SHAPES) {
    const r = flock(14, { seconds: 25, shape });
    const all = r.track.flat();
    const spread = all.reduce((a, p) => a
      + Math.hypot(p.x - r.ball.x, p.y - r.ball.y, p.z), 0) / all.length;
    check(`a ${shape} ball still holds together`,
      spread < C.radius * 3.5, `mean ${spread.toFixed(2)} from the anchor`);
    const worst = Math.min(...r.track.map(tightest));
    check(`...and its fish still do not collide`, worst > 0.4,
      `closest pair ${worst.toFixed(2)}`);
  }
}

// ---------------------------------------------------------------------------
section('THE SHIMMER — the shader half');
// ---------------------------------------------------------------------------
// What Node CAN check about a shader: that it is attached, that it is fed, and
// that it switches off. Whether the GLSL compiles is a different question and
// Node cannot answer it — `npm run bait:shader` compiles both stages against a
// real driver, and it has to, because the program is shared across every
// shimmering material and a syntax error renders every bait fish as nothing.
{
  const fakeMat = () => ({ color: {}, userData: {}, needsUpdate: false });
  resetBaitShimmer();
  const before = baitShimmerMaterialCount();
  const m = fakeMat();
  check('a material takes the shimmer once', attachBaitShimmer(m) === true);
  check('...and only once', attachBaitShimmer(m) === false);
  check('...and it needs something to modulate',
    attachBaitShimmer({ userData: {} }) === false, 'no `color`, no shimmer');
  check('...and the injection is registered for the per-frame write',
    baitShimmerMaterialCount() === before + 1);

  const u = m.userData.__baitShimmer;
  check('...with the uniforms the fragment declares',
    u && u.uBaitStrength && u.uBaitBalls.value.length === MAX_SHIMMER_BALLS,
    `${u?.uBaitBalls?.value?.length} ball slots`);

  // OFF WHEN THERE IS NO BALL. The material is shared with every loose fish of
  // that species, so a shimmer left running would light the whole roster.
  updateBaitShimmer([], 1 / 60);
  check('no balls means no shimmer at all',
    u.uBaitStrength.value === 0 && u.uBaitCount.value === 0);

  updateBaitShimmer([{ x: 3, y: -8, z: 0, shell: 2 }], 1 / 60);
  check('a live ball turns it on', u.uBaitStrength.value > 0 && u.uBaitCount.value === 1);
  check('...and hands the shader where that ball is',
    u.uBaitBalls.value[0].x === 3 && u.uBaitBalls.value[0].y === -8);
  check('...with a reach wider than the shell, so the outermost fish are lit too',
    u.uBaitBalls.value[0].w > 2, `${u.uBaitBalls.value[0].w.toFixed(1)} against a shell of 2`);

  // The field's clock is the flock's clock. Different rates would put the
  // shimmer out of phase with the drift it is supposed to BE.
  const t0 = u.uBaitTime.value;
  updateBaitShimmer([{ x: 0, y: 0, z: 0, shell: 2 }], 1);
  check('...and its clock runs at `noiseRate`, the same as the drift',
    Math.abs((u.uBaitTime.value - t0) - C.noiseRate) < 1e-9,
    `advanced ${(u.uBaitTime.value - t0).toFixed(3)} in a second`);

  // MORE BALLS THAN THE SHADER'S ARRAY. The array size is a compile-time
  // constant, so this is a hard ceiling; overrunning it in JS would write past
  // the uniform and three would throw mid-frame.
  const many = Array.from({ length: MAX_SHIMMER_BALLS + 4 },
    (_, i) => ({ x: i, y: 0, z: 0, shell: 2 }));
  updateBaitShimmer(many, 1 / 60);
  check('...and more balls than the array holds is clamped, not overrun',
    u.uBaitCount.value === MAX_SHIMMER_BALLS);
  check('...with the cap left comfortably under it',
    C.maxBalls <= MAX_SHIMMER_BALLS, `${C.maxBalls} balls, ${MAX_SHIMMER_BALLS} slots`);

  const was = CONFIG.baitBall.shimmer.enabled;
  CONFIG.baitBall.shimmer.enabled = false;
  updateBaitShimmer([{ x: 0, y: 0, z: 0, shell: 2 }], 1 / 60);
  CONFIG.baitBall.shimmer.enabled = was;
  check('shimmer.enabled off means off', u.uBaitStrength.value === 0);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
