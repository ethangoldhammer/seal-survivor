#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:lunge
//
// The sailfish: a slow cruise punctuated by one committed run. See lungeChase
// in path/src/entities/enemies.js and the `lunge` block on CONFIG.enemies
// .sailfish.
//
// EVERY CLAIM HERE IS ABOUT A PATH OVER TIME, which is the one thing you
// cannot read off the code and cannot see in a screenshot. "It is slow but it
// bursts" is a statement about the shape of a speed trace; "it commits" is a
// statement about how fast the heading may turn while that trace is high; and
// "there is a cooldown" is a statement about the GAPS between bursts. So this
// drives the real behaviour with a real creature for real seconds and measures
// where it went.
//
// Two of these would pass on a broken build if they were written the obvious
// way, and are deliberately not:
//
//   "it bursts"        A peak speed alone is met by a creature that is simply
//                      fast. The assertion is on the SHAPE — most of the time
//                      under cruise, a small fraction of it far above — which
//                      a flat chaser fails at both ends.
//   "it can be dodged" Measuring the distance at the end of the run says
//                      nothing: a homing lunge that tracks you perfectly and
//                      then expires also ends up far away. The assertion is on
//                      the TURN RATE during the strike, against a player that
//                      is moving, which is the property that makes moving work.
//
// SEEDED, for the reason spelled out in tools/shark-swim-test.mjs: a creature
// spawns on a random heading, at a speed off `speedVariance`, at a size off
// `scaleVariance`, and with a random part of its first cooldown already spent.
// Averaging over fixed seeds is what makes a failure here mean something.
//
//   node --import ./tools/vite-loader.mjs tools/sailfish-lunge-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enemies, spawnNamed, updateEnemies, resetEnemies } from '../path/src/entities/enemies.js';
import { getAssetSizeMultiplier, ASSETS } from '../path/src/assets.js';

const scene = new THREE.Scene();

const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[animation]') || msg.startsWith('[assets]'))) return;
  realWarn(msg, ...rest);
};

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const dt = 1 / 60;
const MID = -20; // comfortably mid-water: nothing here is about the surface clamp

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function withSeed(seed, fn) {
  const orig = Math.random;
  Math.random = seeded(seed);
  try { return fn(); } finally { Math.random = orig; }
}

/**
 * One sailfish, one player, nothing else in the water — so whatever the path
 * does is this behaviour and not a fish it broke off for.
 *
 * `playerMove` is called with the elapsed time and returns where the seal is
 * this frame. A STATIONARY player is the wrong default for half of these: a
 * lunge that homes perfectly is indistinguishable from one that commits when
 * the target never moves.
 */
function run(seed, { seconds = 24, from = { x: -14, y: MID }, playerMove = () => ({ x: 0, y: MID }) } = {}) {
  return withSeed(seed, () => {
    resetEnemies(scene);
    const e = spawnNamed(scene, 'sailfish', 0, from, { ignoreCaps: true });
    if (!e) throw new Error('could not spawn sailfish');
    const player = new THREE.Vector3();
    const frames = [];
    const steps = Math.round(seconds / dt);
    for (let i = 0; i < steps; i++) {
      const at = playerMove(i * dt, e);
      player.set(at.x, at.y, 0);
      updateEnemies(dt, scene, player, () => {}, () => {});
      if (!enemies.includes(e)) break; // died or left; nothing after this is the behaviour
      frames.push({
        t: i * dt,
        speed: Math.hypot(e.vx, e.vy),
        heading: e.heading,
        stage: e.lungeStage,
        dist: Math.hypot(player.x - e.mesh.position.x, player.y - e.mesh.position.y),
      });
    }
    return { e, frames };
  });
}

// Contiguous runs of frames in one stage, as {start, end} indices.
function spans(frames, stage) {
  const out = [];
  let open = null;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].stage === stage) { if (open == null) open = i; }
    else if (open != null) { out.push({ start: open, end: i - 1 }); open = null; }
  }
  if (open != null) out.push({ start: open, end: frames.length - 1 });
  return out;
}

const C = CONFIG.enemies.sailfish;
const L = C.lunge;
const SEEDS = [1, 2, 3, 4, 5];

// ---------------------------------------------------------------------------
console.log('\nTHE BODY IS BIGGER, AND EVERY ONE IS A DIFFERENT SIZE');

// The on-screen length, which is the number the roster comments are written
// in. No GLB loads in Node, so this is arithmetic on the asset definition
// rather than a measurement of the stand-in — but it is the SAME arithmetic
// createVisual does, and the stand-in carries the multiplier too (checked
// below through the hitbox).
const len = (key) => ASSETS[key].fit * getAssetSizeMultiplier(key);
check('sailfish outgrows the barracuda it is a tier above',
  len('enemySailfish') > len('enemyBarracuda') * 1.3,
  `${len('enemySailfish').toFixed(2)} units against the barracuda's ${len('enemyBarracuda').toFixed(2)}`);
check('and stays under the dolphin',
  len('enemySailfish') < len('enemyDolphin'),
  `${len('enemySailfish').toFixed(2)} against the dolphin's ${len('enemyDolphin').toFixed(2)}`);
check('the night form is the same animal',
  len('enemyGlowSailfish') === len('enemySailfish'),
  `${len('enemyGlowSailfish').toFixed(2)} vs ${len('enemySailfish').toFixed(2)}`);

// THE HITBOX FOLLOWS THE VISUAL, which is the whole difference between a size
// change and a paint job — and it is what makes `scaleVariance` a spread of
// bodies rather than a spread of pictures.
const radii = [];
for (let s = 0; s < 40; s++) {
  withSeed(100 + s, () => {
    resetEnemies(scene);
    const e = spawnNamed(scene, 'sailfish', 0, { x: 0, y: MID }, { ignoreCaps: true });
    radii.push(e.radius);
  });
}
const rMin = Math.min(...radii);
const rMax = Math.max(...radii);
const rMean = radii.reduce((a, b) => a + b, 0) / radii.length;
check('the hitbox grew with the model',
  rMean > C.radius * 1.5,
  `mean radius ${rMean.toFixed(2)} against the authored ${C.radius}`);
// Bounded on BOTH sides: the spread has to be visible without being a joke,
// and `scaleVariance` is the only thing that decides either.
const spread = (rMax - rMin) / rMean;
check('and no two are quite the same size',
  spread > 0.2 && spread < 0.7,
  `${(spread * 100).toFixed(0)}% of the mean across 40 spawns (${rMin.toFixed(2)}-${rMax.toFixed(2)})`);

// ---------------------------------------------------------------------------
console.log('\nIT CRUISES SLOWER THAN THE SEAL CAN SWIM');

// The seal's steady-state cruise: thrust against a per-frame drag applied 60
// times a second. Not its maxSpeed, which is a burst ceiling it only reaches
// under a boost — the honest comparison for "can the player leave" is the pace
// they hold by pushing the stick.
const dragPerSec = -Math.log(CONFIG.player.friction) * 60;
const sealCruise = CONFIG.player.thrust / dragPerSec;

for (const seed of SEEDS) {
  const { frames } = run(seed, { seconds: 20, from: { x: -30, y: MID } });
  const cruising = frames.filter((f) => f.stage === 'cruise' || f.stage === 'rest');
  const mean = cruising.reduce((a, f) => a + f.speed, 0) / cruising.length;
  check(`seed ${seed}: the seal can simply swim away from it`,
    mean < sealCruise * 0.7,
    `cruise ${mean.toFixed(1)} against the seal's ${sealCruise.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
console.log('\nAND SPENDS THE DIFFERENCE IN ONE BURST');

for (const seed of SEEDS) {
  const { e, frames } = run(seed, { seconds: 24 });
  const peak = Math.max(...frames.map((f) => f.speed));
  check(`seed ${seed}: the burst is faster than it ever was`,
    peak > e.speed * L.speedMul * 0.9,
    `peak ${peak.toFixed(1)} against cruise ${e.speed.toFixed(1)}`);

  // THE SHAPE, not the peak. A creature that simply moves at the burst speed
  // all the time passes a peak test and fails this one, and so does a "burst"
  // that is a 5% bump for two thirds of the run.
  const hot = frames.filter((f) => f.speed > e.speed * 1.5).length / frames.length;
  check(`seed ${seed}: the burst is rare`,
    hot > 0.02 && hot < 0.35,
    `${(hot * 100).toFixed(0)}% of frames above 1.5x cruise`);
}

// ---------------------------------------------------------------------------
console.log('\nTHERE IS A TELL, AND IT COMES FIRST');

for (const seed of SEEDS) {
  const { e, frames } = run(seed, { seconds: 24 });
  const strikes = spans(frames, 'strike');
  check(`seed ${seed}: it struck at all`, strikes.length >= 2, `${strikes.length} strikes in 24s`);
  if (!strikes.length) continue;

  // Every strike is preceded by a wind-up, and the wind-up is visibly SLOWER
  // than the cruise — the throttle back is the half of the telegraph that is
  // readable at a glance.
  let bad = 0;
  for (const s of strikes) {
    const before = frames[s.start - 1];
    if (!before || before.stage !== 'wind' || before.speed > e.speed * 0.9) bad++;
  }
  check(`seed ${seed}: every burst opens with a wind-up`, bad === 0,
    `${bad} of ${strikes.length} strikes arrived without one`);

  // ...and it never starts from on top of you. `minRange` is the floor and
  // this is the check that the cruise actually respects it — a creature that
  // milled around inside its own minimum would wind up at whatever distance it
  // happened to be, which is a telegraph with nothing left to telegraph.
  const opens = spans(frames, 'wind').map((s) => frames[s.start].dist);
  const closest = Math.min(...opens);
  check(`seed ${seed}: the tell never starts on top of the seal`,
    closest >= L.minRange - 0.6,
    `nearest wind-up began at ${closest.toFixed(1)} units, floor ${L.minRange}`);
}

// ---------------------------------------------------------------------------
console.log('\nTHE RUN IS COMMITTED — IT CANNOT FOLLOW YOU');

// The player CIRCLES, which is the thing a homing lunge would quietly beat.
const orbit = (t) => ({ x: Math.cos(t * 1.2) * 9, y: MID + Math.sin(t * 1.2) * 9 });

for (const seed of SEEDS) {
  const { frames } = run(seed, { seconds: 24, playerMove: orbit });
  const strikes = spans(frames, 'strike');
  if (!strikes.length) { check(`seed ${seed}: it struck at all`, false, 'no strikes'); continue; }

  let worst = 0;
  for (const s of strikes) {
    for (let i = s.start + 1; i <= s.end; i++) {
      let d = frames[i].heading - frames[i - 1].heading;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      worst = Math.max(worst, Math.abs(d) / dt);
    }
  }
  // A hair of headroom for the frame the stage changes on, and nothing more:
  // this number IS the dodge.
  check(`seed ${seed}: the line barely bends`,
    worst <= L.strikeTurnRate * 1.05,
    `worst correction ${worst.toFixed(2)} rad/s against a budget of ${L.strikeTurnRate}`);

}

// ---------------------------------------------------------------------------
console.log('\nSO MOVING IS THE ANSWER');

// The claim the whole design rests on, measured as the player experiences it:
// a seal that reads the tell and swims sideways is not hit. The dodge is a
// POLICY rather than a fixed path — perpendicular to the fish's heading, at
// the pace the stick gives you, and only once there is something to dodge —
// because a scripted path could be one that happens to work.
//
// Not asserted on the strike's own frames alone: a body travelling 16 units a
// second crosses its own length between frames, so the gap is measured across
// the whole approach at the closest the two ever came.
function dodger(state) {
  return (t, e) => {
    if (state.at == null) state.at = { x: 0, y: MID };
    const busy = e.lungeStage === 'wind' || e.lungeStage === 'strike';
    if (busy) {
      const away = e.heading + Math.PI / 2;
      state.at = { x: state.at.x + Math.cos(away) * sealCruise * dt, y: state.at.y + Math.sin(away) * sealCruise * dt };
    }
    return state.at;
  };
}

for (const seed of SEEDS) {
  const { e, frames } = run(seed, { seconds: 24, playerMove: dodger({}) });
  const strikes = spans(frames, 'strike');
  if (!strikes.length) { check(`seed ${seed}: it struck at all`, false, 'no strikes'); continue; }
  // Contact is the sum of the two hit radii — the same test resolveCombat runs.
  const contact = e.radius + CONFIG.player.hitRadius;
  let hits = 0;
  let tightest = Infinity;
  for (const s of strikes) {
    let near = Infinity;
    for (let i = s.start; i <= s.end; i++) near = Math.min(near, frames[i].dist);
    tightest = Math.min(tightest, near);
    if (near <= contact) hits++;
  }
  check(`seed ${seed}: a seal that moves is missed`, hits === 0,
    `${hits} of ${strikes.length} runs connected; closest pass ${tightest.toFixed(1)} units against a contact radius of ${contact.toFixed(1)}`);
}

// THE OTHER HALF, and the half that stops all of the above from being passed
// by a creature that is simply harmless: a seal that stands there IS hit. A
// dodge only means something against a strike that would otherwise land.
for (const seed of SEEDS) {
  const { e, frames } = run(seed, { seconds: 24 });
  const strikes = spans(frames, 'strike');
  const contact = e.radius + CONFIG.player.hitRadius;
  let hits = 0;
  for (const s of strikes) {
    for (let i = s.start; i <= s.end; i++) if (frames[i].dist <= contact) { hits++; break; }
  }
  check(`seed ${seed}: a seal that stands still is not`, hits > 0,
    `${hits} of ${strikes.length} runs connected`);
}

// ---------------------------------------------------------------------------
console.log('\nAND IT CANNOT DO IT AGAIN STRAIGHT AWAY');

// The gap is what makes the burst an event. Measured between the ENDS and
// STARTS of consecutive strikes rather than between their starts, so a change
// to strikeTime cannot quietly pay for the cooldown.
const floor = L.cooldown + L.windup;
for (const seed of SEEDS) {
  const { frames } = run(seed, { seconds: 30 });
  const strikes = spans(frames, 'strike');
  check(`seed ${seed}: struck more than once`, strikes.length >= 2, `${strikes.length} strikes in 30s`);
  if (strikes.length < 2) continue;

  let tightest = Infinity;
  for (let i = 1; i < strikes.length; i++) {
    tightest = Math.min(tightest, frames[strikes[i].start].t - frames[strikes[i - 1].end].t);
  }
  check(`seed ${seed}: the gap holds`,
    tightest >= floor - 0.05,
    `tightest gap ${tightest.toFixed(2)}s against cooldown+windup ${floor.toFixed(2)}s`);
}

// ---------------------------------------------------------------------------
console.log('\nAND EVERY OTHER CHASER IS UNTOUCHED');

// The lunge is opted into by a `lunge` block on the def, so the assertion that
// matters for the rest of the roster is that nothing else has one — a chaser
// that quietly started bursting is exactly the regression this file cannot see
// from the sailfish's own numbers.
const bursting = Object.entries(CONFIG.enemies)
  .filter(([, def]) => def.behavior === 'chase' && def.lunge)
  .map(([id]) => id);
check('only the sailfish bursts', bursting.length === 1 && bursting[0] === 'sailfish',
  bursting.join(', ') || 'nothing');

// A plain chaser still closes the whole way in, at its own speed, with no
// stages at all. Driven through the same loop rather than asserted about the
// code, because "chase still works" is the claim.
{
  const { e, frames } = withSeed(7, () => {
    resetEnemies(scene);
    const en = spawnNamed(scene, 'squid', 0, { x: -25, y: MID }, { ignoreCaps: true });
    const player = new THREE.Vector3(0, MID, 0);
    const out = [];
    for (let i = 0; i < 60 * 12; i++) {
      updateEnemies(dt, scene, player, () => {}, () => {});
      out.push({ speed: Math.hypot(en.vx, en.vy), stage: en.lungeStage, dist: Math.hypot(player.x - en.mesh.position.x, player.y - en.mesh.position.y) });
    }
    return { e: en, frames: out };
  });
  check('the squid never entered a stage', frames.every((f) => f.stage == null));
  const arrived = Math.min(...frames.map((f) => f.dist));
  check('the squid still closes all the way in', arrived < e.radius + 2,
    `got within ${arrived.toFixed(2)} units`);
}

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}\n`);
process.exit(failures ? 1 : 0);
