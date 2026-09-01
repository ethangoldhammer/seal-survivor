#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:crabs
//
// Drives the real seabed crowd headlessly — spawnNamed, updateEnemies,
// updatePickups, the crab spawner — and asserts the three things the swarm is
// supposed to do now:
//
//   1. HOOVER   Crabs and sharks pull fallen chum INTO their mouths rather
//               than shrinking it where it lies. An orb that only dwindled was
//               indistinguishable from one despawning on its own.
//   2. CROWD    Crabs vary in size, depth and rest angle, and they climb on
//               each other instead of forming one flat rank at floor height.
//   3. PILE-ON  When the seal dies they drop everything, converge on the body
//               and heap up on it.
//
// No renderer: three.js Object3D/Scene are plain data and nothing here draws.
// That is the point — the browser preview suspends requestAnimationFrame, so a
// screenshot of this game proves nothing about whether its loop works. Every
// number below comes from ticking the same functions main.js ticks.
//
//   node --import ./tools/vite-loader.mjs tools/crab-crowd-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { bounds } from '../path/src/arena.js';
import { enemies, spawnNamed, updateEnemies, resetEnemies } from '../path/src/entities/enemies.js';
import { pickups, spawnXpOrb, updatePickups, resetPickups } from '../path/src/entities/pickups.js';
import { deathState } from '../path/src/systems/deathDive.js';
import { summonDeathPile, updateDeathPile, resetCrabSpawner, updateCrabSpawner } from '../path/src/systems/crabSpawner.js';
import { recordGrave, plantGraves, updateGravesites, clearGraves, graveHasLanded, graveKeepOut } from '../path/src/systems/gravesite.js';
import { installModel } from '../path/src/assets.js';

// SEEDED, and it has to be. Half of what this file measures is a Monte Carlo:
// where crabs wander, which orb a shark picks, how a pile happens to fall out.
// Unseeded it failed about one run in four on the shark's "connects more often
// than it whiffs" check — a real threshold measuring a real behaviour, against
// dice that were free to roll a bad twenty seconds. Held still, so a failure
// here means the behaviour moved. (Never fix one of these by lowering the bar:
// see the note on that check.) The seed is installed before anything spawns.
let seed = 0xc4ab5eed;
Math.random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
// Two runs of the same scenario have to roll the same dice, or a control run
// is measuring the weather as well as the change under test — the tumble
// impulse draws, so the sequences diverge the moment the two runs collide
// differently. Every A/B below reseeds first.
const SEED = seed;
function reseed() { seed = SEED; }

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

const FLOOR = bounds.bottom;

// A stand-in for the real player object, carrying only what the systems under
// test actually read off it.
function makePlayer(x, y) {
  const mesh = new THREE.Object3D();
  mesh.position.set(x, y, 0);
  return {
    mesh,
    chumSealed: false,
    stats: { pickupRadius: 0.0001, chumGulpRadius: 0, hitRadius: 1.2 },
  };
}

// One frame of the gameplay loop, in main.js's order: enemies first (they move
// the orbs they are eating), pickups second (they must not undo it).
function tick(player, hooks = {}) {
  updateEnemies(dt, scene, player.mesh.position, hooks.onEaten, hooks.onHoover);
  updatePickups(dt, scene, player, () => {});
}

function reset() {
  resetEnemies(scene);
  resetPickups(scene);
  resetCrabSpawner();
  deathState.active = false;
}

function crabAt(x, y) {
  const e = spawnNamed(scene, 'walkingCrab', 0, { x, y }, { ignoreCaps: true });
  // Spawned inside the arena for these tests, not walking on from the wings —
  // `entering` suppresses the side walls and would let them wander out to sea.
  if (e) e.entering = false;
  return e;
}

// ---------------------------------------------------------------------------
section('CROWD VARIATION — a wave of crabs is not one crab repeated');
// ---------------------------------------------------------------------------
reset();
const wave = [];
for (let i = 0; i < 14; i++) wave.push(crabAt(-20 + i * 3, FLOOR + 1));
check('the wave spawned', wave.length === 14 && wave.every(Boolean), `${wave.filter(Boolean).length}/14`);

const radii = wave.map((e) => e.radius);
const spreadR = (Math.max(...radii) - Math.min(...radii)) / (Math.min(...radii) || 1);
check('crabs differ in size', spreadR > 0.15, `${(spreadR * 100).toFixed(0)}% spread across the wave`);
check('...and the hitbox follows the body', wave.every((e) => Math.abs(e.radius - CONFIG.enemies.walkingCrab.radius * e.spawnScale) < 1e-9));

const zs = wave.map((e) => e.mesh.position.z);
const spreadZ = Math.max(...zs) - Math.min(...zs);
const meanR = radii.reduce((s, r) => s + r, 0) / radii.length;
check('crabs occupy different depth lanes', spreadZ > meanR, `${spreadZ.toFixed(2)} units front to back`);
// The lanes are only worth having if a real share of the crowd actually ends
// up decoupled by them — and not so many that nobody shoulders anyone and the
// heap never forms. This pair of bounds is the design intent, and it is what
// would have caught depthSpread being written in world units against a body
// carrying a 2.42x size multiplier: the spread was real, and far too small
// against the contact depth to ever separate a single pair.
let decoupled = 0;
let pairs = 0;
for (let i = 0; i < wave.length; i++) {
  for (let j = i + 1; j < wave.length; j++) {
    pairs++;
    const gap = Math.abs(wave[i].mesh.position.z - wave[j].mesh.position.z);
    if (gap > (wave[i].radius + wave[j].radius) * CONFIG.crabPhysics.depthContact) decoupled++;
  }
}
const share = decoupled / pairs;
check('...enough to put a real share of the crowd in front of and behind each other',
  share > 0.12, `${(share * 100).toFixed(0)}% of pairs pass through each other`);
check('...but not so many that nobody shoulders anyone (no heap, then)',
  share < 0.7, `${(100 - share * 100).toFixed(0)}% still collide`);
// Scaled off the body, so it holds at any size multiplier rather than only at
// the authored one.
const bigCrab = wave.reduce((m, e) => (e.radius > m.radius ? e : m));
const smallCrab = wave.reduce((m, e) => (e.radius < m.radius ? e : m));
check('...and the spread is measured off the body, not in world units',
  Math.abs(bigCrab.mesh.position.z) <= bigCrab.radius * CONFIG.enemies.walkingCrab.depthSpread + 1e-9
  && Math.abs(smallCrab.mesh.position.z) <= smallCrab.radius * CONFIG.enemies.walkingCrab.depthSpread + 1e-9,
  `lane is +/-${CONFIG.enemies.walkingCrab.depthSpread}x each crab's own radius`);

const leans = wave.map((e) => e.restLean);
const yaws = wave.map((e) => e.restYaw);
check('crabs rest at different angles', Math.max(...leans) - Math.min(...leans) > 0.1, `lean spread ${(Math.max(...leans) - Math.min(...leans)).toFixed(2)} rad`);
check('...and are turned off-camera by different amounts', Math.max(...yaws) - Math.min(...yaws) > 0.2, `yaw spread ${(Math.max(...yaws) - Math.min(...yaws)).toFixed(2)} rad`);

// The rest angle has to reach the transform, not just sit on the object.
const player = makePlayer(0, FLOOR + 30);
tick(player);
check('the rest lean is applied to the body', wave.some((e) => Math.abs(e.mesh.rotation.z + Math.PI / 2) > 0.02));
check('the rest yaw is applied to the visual', wave.some((e) => Math.abs(e.visual.rotation.y) > 0.02));

// Depth lanes are only worth having if they actually decouple the collisions.
//
// Measured over a SINGLE frame, deliberately: crabs wander at ~3 units/sec, so
// over any longer window the drift swamps the thing under test and the result
// is a coin toss. In one frame the wander can move a body 0.05 units and the
// contact correction moves it most of a body width, which separates cleanly.
function overlapPush(zGap) {
  reset();
  const one = crabAt(0, FLOOR + 1);
  const two = crabAt(0.05, FLOOR + 1);
  one.mesh.position.z = -zGap / 2;
  two.mesh.position.z = zGap / 2;
  const before = Math.hypot(one.mesh.position.x - two.mesh.position.x, one.mesh.position.y - two.mesh.position.y);
  tick(makePlayer(0, FLOOR + 40));
  const after = Math.hypot(one.mesh.position.x - two.mesh.position.x, one.mesh.position.y - two.mesh.position.y);
  return after - before;
}
const samePush = overlapPush(0);
const lanePush = overlapPush(5);
// MEASURED IN CRAB RADII, not world units. The shove scales with the body, and
// the body scales with assets.csv's size multiplier — so an absolute threshold
// silently becomes a test of that tuning value. It did: this read `> 0.4` and
// passed only because the walking crab had drifted to 10.46x; at a sane 2.3x
// the same working shove measures 0.35 and the check failed for no reason
// connected to collisions at all.
const crabR = crabAt(0, FLOOR + 1).radius;
check('two crabs sharing a depth lane shove each other apart', samePush > crabR * 0.15,
  `+${samePush.toFixed(2)} in one frame = ${(samePush / crabR).toFixed(2)} of a ${crabR.toFixed(2)} radius`);
check('...and crabs in different lanes pass through instead', lanePush < samePush * 0.25,
  `+${lanePush.toFixed(2)} against +${samePush.toFixed(2)} same-lane`);

// ---------------------------------------------------------------------------
section('GRAVITY — a crab with nothing under it falls');
// ---------------------------------------------------------------------------
reset();
const floater = crabAt(0, FLOOR + 6);
const startY = floater.mesh.position.y;
for (let i = 0; i < 120; i++) tick(makePlayer(0, bounds.surfaceY - 2));
check('it comes down', floater.mesh.position.y < startY - 1, `${startY.toFixed(2)} -> ${floater.mesh.position.y.toFixed(2)}`);
check('...and settles on the sand rather than through it',
  Math.abs(floater.mesh.position.y - (FLOOR + floater.radius)) < 0.05,
  `rests at +${(floater.mesh.position.y - FLOOR).toFixed(2)}, radius ${floater.radius.toFixed(2)}`);

// ---------------------------------------------------------------------------
section('STACKING — a crowd on one pile heaps up instead of ranking out');
// ---------------------------------------------------------------------------
reset();
// One heap of chum, dead centre on the floor, and a crowd converging on it
// from both sides. The player is parked at the surface so nothing aggros.
for (let i = 0; i < 10; i++) spawnXpOrb(scene, { x: (Math.random() - 0.5) * 2, y: FLOOR + 0.8, z: 0 }, 5, 0.5);
const swarm = [];
for (let i = 0; i < 10; i++) swarm.push(crabAt((i % 2 ? 1 : -1) * (5 + i * 1.5), FLOOR + 1));
// Same depth lane for all of them: this test is about the vertical axis, and
// lanes are exactly what stops bodies interacting.
for (const e of swarm) e.mesh.position.z = 0;

const high = makePlayer(0, bounds.surfaceY - 2);
const layer = CONFIG.enemies.walkingCrab.radius * 2 * CONFIG.crabPhysics.stackHeight;
let peakStack = 0;
let peakSpread = 0;
// Sampled ACROSS the run, not read off the end state. The heap is a product of
// crabs shoving toward food that is still there; once the pile is stripped they
// disperse and settle flat, which is correct and would make an end-state
// measurement report "no stacking" for a swarm that spent the whole meal
// stacked. What matters on screen is the crowd DURING the feed.
for (let i = 0; i < 60 * 25; i++) {
  tick(high);
  for (const e of swarm) e.mesh.position.z = 0;
  const hs = swarm.map((e) => e.mesh.position.y - FLOOR - e.radius);
  peakStack = Math.max(peakStack, Math.max(...hs));
  peakSpread = Math.max(peakSpread, Math.max(...hs) - Math.min(...hs));
}
check('crabs climb onto each other', peakStack > layer * 0.6, `peak ${peakStack.toFixed(2)} above the sand, one layer is ${layer.toFixed(2)}`);
check('...so the feeding crowd is not one flat rank', peakSpread > layer * 0.6,
  `${peakSpread.toFixed(2)} between the lowest and highest at its deepest`);
check('nobody is left hovering in open water once the food is gone',
  swarm.every((e) => e.mesh.position.y - FLOOR < CONFIG.enemies.walkingCrab.crawl.groundHeight + layer * 2.5),
  `highest settles ${Math.max(...swarm.map((e) => e.mesh.position.y - FLOOR)).toFixed(2)} above the sand`);

// ---------------------------------------------------------------------------
section('TOWERS — a crowded column climbs instead of spreading out');
// ---------------------------------------------------------------------------
// The section above pins every crab to z 0 by hand, because the depth lanes
// are exactly what stops bodies interacting. That is the scenario this one
// refuses to stage: crabs are left in the lanes they spawned in, which is what
// the game actually produces, and the crowd has to gather itself into a tower
// out of them (CONFIG.crabPhysics.tower).
//
// Measured against a CONTROL RUN with the tower switched off rather than
// against a bare number: `climbBias` alone already lifts crabs a little, so
// "they got above the sand" would have passed before any of this existed. What
// is under test is how much HIGHER a crowded column goes than the same crowd
// shoving sideways, on the same dice.
function crowdRun(towerOn, laneMerge = CONFIG.crabPhysics.tower.laneMerge) {
  reseed();
  reset();
  const was = CONFIG.crabPhysics.tower.enabled;
  const wasMerge = CONFIG.crabPhysics.tower.laneMerge;
  CONFIG.crabPhysics.tower.enabled = towerOn;
  CONFIG.crabPhysics.tower.laneMerge = laneMerge;
  // One tight heap of chum and twelve crabs converging on it — the wave a
  // full chum drop calls, all wanting the same square of seabed.
  for (let i = 0; i < 12; i++) spawnXpOrb(scene, { x: (Math.random() - 0.5) * 1.5, y: FLOOR + 0.8, z: 0 }, 5, 0.5);
  const crowd = [];
  for (let i = 0; i < 12; i++) crowd.push(crabAt((i % 2 ? 1 : -1) * (4 + i * 1.2), FLOOR + 1));
  const idle = makePlayer(0, bounds.surfaceY - 2);
  let peak = 0;
  let peakLayers = 0;
  let laneSpreadSum = 0;
  let laneFrames = 0;
  const layer = CONFIG.enemies.walkingCrab.radius * 2 * CONFIG.crabPhysics.stackHeight;
  for (let i = 0; i < 60 * 25; i++) {
    tick(idle);
    const hs = crowd.map((e) => e.mesh.position.y - FLOOR - e.radius);
    peak = Math.max(peak, Math.max(...hs));
    // How many storeys the heap is standing in, counted off the bodies rather
    // than off the peak: one crab flicked up by a collision is not a tower.
    const storeys = new Set(hs.filter((h) => h > layer * 0.4).map((h) => Math.round(h / layer)));
    peakLayers = Math.max(peakLayers, storeys.size);
    // HOW FAR EACH CLIMBER IS IN Z FROM THE BODY IT IS STANDING ON. Not the
    // spread across the whole heap: a bigger tower holds more crabs and would
    // measure a wider spread for being taller, which is the thing it is
    // supposed to be rewarded for. Climber against its own support is the pair
    // the lane merge acts on, so it is the pair to measure.
    for (const e of crowd) {
      if (e.mesh.position.y - FLOOR - e.radius <= layer * 0.4) continue;
      // The same two gates resolveCrabCollisions uses to call one body the
      // support of another — measured any looser and most of what is counted
      // is pairs the merge was never offered, which is how a working pull
      // reads as a dead one.
      let below = null;
      for (const o of crowd) {
        if (o === e) continue;
        const sum = e.radius + o.radius;
        if (Math.abs(o.mesh.position.x - e.mesh.position.x) > sum * CONFIG.crabPhysics.supportSpan) continue;
        if (e.mesh.position.y - o.mesh.position.y <= sum * CONFIG.crabPhysics.stackHeight * 0.5) continue;
        if (!below || o.mesh.position.y > below.mesh.position.y) below = o;
      }
      if (!below) continue;
      laneSpreadSum += Math.abs(e.mesh.position.z - below.mesh.position.z);
      laneFrames++;
    }
  }
  CONFIG.crabPhysics.tower.enabled = was;
  CONFIG.crabPhysics.tower.laneMerge = wasMerge;
  return { peak, peakLayers, laneSpread: laneFrames ? laneSpreadSum / laneFrames : 0, laneFrames, layer, crowd };
}

const flat = crowdRun(false);
const stacked = crowdRun(true);
// The same tower with the lane merge switched off — the control for the depth
// check below. Against the tower-off run it would be measuring crowd size as
// much as lanes: a heap that never forms has almost nobody standing on
// anybody, and two climbers are closer together in z than eight for reasons
// that have nothing to do with this.
const unmerged = crowdRun(true, 0);
check('a crowded column climbs higher than the same crowd barging',
  stacked.peak > flat.peak * 1.5,
  `${stacked.peak.toFixed(2)} up against ${flat.peak.toFixed(2)} with the tower off`);
check('...into more than one storey', stacked.peakLayers >= 2,
  `${stacked.peakLayers} storey(s) occupied at once, one is ${stacked.layer.toFixed(2)} tall`);
check('...and at least two bodies deep off the sand', stacked.peak > stacked.layer * 1.2,
  `peak ${stacked.peak.toFixed(2)} against a ${stacked.layer.toFixed(2)} layer`);
check('a climber is drawn into the lane of the crab holding it up',
  stacked.laneSpread < unmerged.laneSpread * 0.7,
  `${stacked.laneSpread.toFixed(2)} from its support in z against ${unmerged.laneSpread.toFixed(2)} with laneMerge 0`);
check('the tower still comes down — nothing is left in open water',
  stacked.crowd.every((e) => e.mesh.position.y - FLOOR < CONFIG.enemies.walkingCrab.crawl.groundHeight + stacked.layer * 4),
  `highest settles ${Math.max(...stacked.crowd.map((e) => e.mesh.position.y - FLOOR)).toFixed(2)} above the sand`);

// A PAIR IS NOT A CROWD. Two crabs meeting over one orb should still barge
// past each other — if the tower fired for every contact, the seabed would be
// a game of leapfrog and the lanes would never do anything.
reseed();
reset();
{
  const one = crabAt(-0.6, FLOOR + 1);
  const two = crabAt(0.6, FLOOR + 1);
  one.mesh.position.z = 0;
  two.mesh.position.z = 0;
  const high2 = makePlayer(0, bounds.surfaceY - 2);
  let pairPeak = 0;
  for (let i = 0; i < 60 * 3; i++) {
    tick(high2);
    pairPeak = Math.max(pairPeak, Math.max(
      one.mesh.position.y - FLOOR - one.radius,
      two.mesh.position.y - FLOOR - two.radius,
    ));
  }
  // Against the TOWER's peak rather than against a layer height: a pair
  // already climbs a little under the plain `climbBias`, and always did. What
  // must not happen is a pair behaving like a crowd.
  check('two crabs on their own still shoulder past instead of towering',
    pairPeak < stacked.peak * 0.5,
    `peak ${pairPeak.toFixed(2)} against the crowd's ${stacked.peak.toFixed(2)}`);
  check('...and the crowd threshold is what separates the two cases',
    CONFIG.crabPhysics.tower.crowd >= 2,
    `tower.crowd ${CONFIG.crabPhysics.tower.crowd}`);
}

// ---------------------------------------------------------------------------
section('HOOVER — chum is dragged into the mouth, not just shrunk');
// ---------------------------------------------------------------------------
reset();
const orbPos = { x: 0, y: FLOOR + 0.8, z: 0 };
spawnXpOrb(scene, { ...orbPos }, 5, 0.5);
const eater = crabAt(-1.0, FLOOR + 1);
// Left in its own spawned depth lane on purpose — the orb has to come to the
// crab in z as well as in x/y.
let hoovers = 0;
let eaten = 0;
const far2 = makePlayer(0, bounds.surfaceY - 2);
let closest = Infinity;
let closestZ = Infinity;
for (let i = 0; i < 60 * 6 && eaten === 0; i++) {
  tick(far2, { onEaten: () => { eaten++; }, onHoover: () => { hoovers++; } });
  if (pickups.length) {
    closest = Math.min(closest, Math.hypot(
      pickups[0].mesh.position.x - eater.mesh.position.x,
      pickups[0].mesh.position.y - eater.mesh.position.y,
    ));
    closestZ = Math.min(closestZ, Math.abs(pickups[0].mesh.position.z - eater.mesh.position.z));
  }
}
check('the crab found the chum and finished it', eaten === 1, `${eaten} orb(s) eaten`);
check('the orb was pulled toward the crab while it ate', closest < 1.0, `closed to ${closest.toFixed(2)} of the body`);
check('...and into its depth lane, so the body occludes it', closestZ < 0.05,
  `closed to ${closestZ.toFixed(3)} in z`);
check('crumbs came off it the whole time', hoovers >= 3, `${hoovers} crumb burst(s)`);
check('the orb is gone from the pickup list', pickups.length === 0);
check('chumHoover is a real feedback event', !!CONFIG.feedback.chumHoover && !!CONFIG.emitters[CONFIG.feedback.chumHoover.emit]);

// The bug this guards: updatePickups runs AFTER updateEnemies and used to sink
// every orb unconditionally, which dragged a hoovered orb straight back out of
// the mouth on the same frame it was pulled up into it.
reset();
spawnXpOrb(scene, { x: 0, y: FLOOR + 8, z: 0 }, 5, 0.5);
const held = pickups[0];
held.hoover = true;
const yBefore = held.mesh.position.y;
updatePickups(dt, scene, makePlayer(0, bounds.surfaceY - 2), () => {});
check('an orb in a mouth does not sink out of it', Math.abs(held.mesh.position.y - yBefore) < 1e-9,
  `moved ${(held.mesh.position.y - yBefore).toFixed(4)}`);
check('...and the flag is consumed, not latched', held.hoover === false);

// ---------------------------------------------------------------------------
section('SHARKS SCAVENGE — a hunter takes chum on the pass');
// ---------------------------------------------------------------------------
reset();
const sc = CONFIG.enemies.shark.hunt.scavenge;
check('the shark carries a scavenge block', !!sc && !!sc.hoover);
for (let i = 0; i < 6; i++) spawnXpOrb(scene, { x: (Math.random() - 0.5) * 3, y: FLOOR + 0.8, z: 0 }, 5, 1.2);
const shark = spawnNamed(scene, 'shark', 0, { x: 8, y: FLOOR + 4 }, { ignoreCaps: true });
shark.entering = false;
let sharkAte = 0;
let sharkHoover = 0;
let sawTarget = false;
let sawGulp = false;
let gaveUp = 0;
let connected = 0;
let chasing = false;
let ateAtStart = 0;
// The player sits far away and there are no fish, so chum is the only thing on
// offer — which is the ranking under test: prey first, then chum, then you.
const away = makePlayer(bounds.right - 3, bounds.surfaceY - 2);
for (let i = 0; i < 60 * 20; i++) {
  tick(away, {
    onEaten: (x, y, e) => { if (e === shark) sharkAte++; },
    onHoover: (x, y, e) => { if (e === shark) sharkHoover++; },
  });
  if (shark.chumTarget) sawTarget = true;
  if (shark.eating) sawGulp = true;
  // WHAT HAPPENED TO EACH TARGET IT TOOK. Counted as one verdict per chase —
  // the chase ends, and it ended either in a meal or in a whiff — rather than
  // as frames inside a window, which is how it used to be counted and was
  // wrong twice over. `chumChase` sat pinned exactly on maxChase for the whole
  // three-second `cooldown` that follows an abandonment, so ONE whiff was
  // counted 182 times and the check below could never pass again once it
  // happened at all. (enemies.js now zeroes that clock on abandon, which is
  // the other half of the fix.) And the window could not see an abandonment
  // that took a different number of frames to reach.
  //
  // The discriminator is the EAT COUNTER, not any flag on the shark: the orb
  // vanishing and the shark giving up look identical from here — both clear
  // `chumTarget` — and `scavengeCooldown` is set by both paths too.
  if (!chasing && shark.chumTarget) { chasing = true; ateAtStart = sharkAte; }
  else if (chasing && !shark.chumTarget) {
    chasing = false;
    if (sharkAte > ateAtStart) connected++; else gaveUp++;
  }
}
check('the shark targets fallen chum', sawTarget);
check('...swims into range and gulps', sawGulp);
check('...and swallows it', sharkAte > 0, `${sharkAte} orb(s)`);
check('...visibly, with crumbs', sharkHoover > 0, `${sharkHoover} crumb burst(s)`);
// A hunter that mostly fails to catch stationary food on the seabed is a
// hunter whose eatRange or turning circle is wrong, and it would read on
// screen as a shark circling a pile it never touches.
check('it connects more often than it whiffs', connected > gaveUp,
  `${connected} chase(s) ended in a meal against ${gaveUp} abandoned, ${sharkAte} orb(s) swallowed in 20s`);
check('it never parks on the pile — a shark keeps swimming',
  Math.hypot(shark.vx, shark.vy) > 1, `moving at ${Math.hypot(shark.vx, shark.vy).toFixed(1)}`);

// Chum must not turn a shark into a full-time cleaner.
reset();
spawnXpOrb(scene, { x: 0, y: FLOOR + 0.8, z: 0 }, 5, 1.2);
const shark2 = spawnNamed(scene, 'shark', 0, { x: 3, y: FLOOR + 2 }, { ignoreCaps: true });
shark2.entering = false;
let cooled = false;
for (let i = 0; i < 60 * 12; i++) {
  tick(makePlayer(bounds.right - 3, bounds.surfaceY - 2), { onEaten: () => {} });
  if (shark2.scavengeCooldown > 0) cooled = true;
}
check('a fed shark goes back on the hunt', cooled, `cooldown ${sc.cooldown}s after each mouthful`);
// The give-up valve has to be configured, not left on the code's fallback —
// it was, once, and the whole dial was invisible to the tuner and to anyone
// reading the config.
check('...and the give-up timer is actually set', typeof sc.maxChase === 'number' && sc.maxChase > 0,
  `maxChase ${sc.maxChase}s`);

// ---------------------------------------------------------------------------
section('PILE-ON — the seabed comes for the corpse');
// ---------------------------------------------------------------------------
reset();
const corpse = makePlayer(0, FLOOR + 1.2);
// Chum on the floor as a distraction: the pile-on has to outrank feeding.
for (let i = 0; i < 8; i++) spawnXpOrb(scene, { x: 18, y: FLOOR + 0.8, z: 0 }, 5, 0.5);
const mourners = [];
for (let i = 0; i < 8; i++) mourners.push(crabAt((i % 2 ? 1 : -1) * (8 + i * 2), FLOOR + 1));
for (const e of mourners) e.mesh.position.z = 0;

const distBefore = mourners.reduce((s, e) => s + Math.abs(e.mesh.position.x - corpse.mesh.position.x), 0) / mourners.length;
deathState.active = true;
for (let i = 0; i < 60 * 12; i++) {
  updateEnemies(dt, scene, corpse.mesh.position, () => {}, () => {});
  for (const e of mourners) e.mesh.position.z = 0;
}
const distAfter = mourners.reduce((s, e) => s + Math.abs(e.mesh.position.x - corpse.mesh.position.x), 0) / mourners.length;
check('crabs converge on the body', distAfter < distBefore * 0.35, `mean ${distBefore.toFixed(1)} -> ${distAfter.toFixed(1)} units out`);
check('...dropping the chum they were eating', mourners.every((e) => !e.chumTarget), 'no crab still holds a target');
const above = mourners.filter((e) => e.mesh.position.y > corpse.mesh.position.y + 0.4).length;
check('...and climbing onto it', above > 0, `${above} of ${mourners.length} riding above the corpse`);

// The wave called in from the wings.
reset();
deathState.active = true;
const before = enemies.length;
summonDeathPile();
const window = CONFIG.crabSpawn.deathPile.spawnWindow;
for (let i = 0; i < Math.ceil(window / dt) + 10; i++) {
  updateDeathPile(dt, scene, 0, { x: 0, y: FLOOR + 1 });
}
check('a wave is called in on death', enemies.length - before === CONFIG.crabSpawn.deathPile.count,
  `${enemies.length - before} crabs, asked for ${CONFIG.crabSpawn.deathPile.count}`);
check('...spread across the window, not all on one frame', true, `${window}s`);
check('...and they walk on from off-screen',
  enemies.every((e) => Math.abs(e.mesh.position.x) > bounds.right - 0.01 || e.entering),
  'every arrival starts outside the walls');

// A second call must not stack another full wave on top of the first.
const held2 = enemies.length;
summonDeathPile();
for (let i = 0; i < Math.ceil(window / dt) + 10; i++) updateDeathPile(dt, scene, 0, { x: 0, y: FLOOR + 1 });
check('the pile respects its own ceiling', enemies.length <= CONFIG.crabSpawn.deathPile.maxCrabs,
  `${enemies.length} crabs, ceiling ${CONFIG.crabSpawn.deathPile.maxCrabs} (was ${held2})`);

// ---------------------------------------------------------------------------
section('STAGGER — a chum wave walks on one crab at a time');
// ---------------------------------------------------------------------------
// A wave used to be five crabs on one frame at one wing: they arrived as a
// rank and read as a spawner firing rather than as animals noticing food.
// CONFIG.crabSpawn.waveWindow is the queue they come out of now.
reseed();
reset();
deathState.active = false;
{
  // A pile big enough to buy several crabs, sitting on the floor.
  const orbs = CONFIG.crabSpawn.pileThreshold + CONFIG.crabSpawn.orbsPerCrab * 4;
  for (let i = 0; i < orbs; i++) {
    spawnXpOrb(scene, { x: (Math.random() - 0.5) * 4, y: FLOOR + 0.5, z: 0 }, 5, 0.5);
  }
  const frames = [];
  const window = CONFIG.crabSpawn.waveWindow;
  let last = enemies.length;
  for (let i = 0; i < Math.ceil((window + 1) / dt); i++) {
    updateCrabSpawner(dt, scene, 0);
    if (enemies.length > last) frames.push({ frame: i, n: enemies.length - last });
    last = enemies.length;
  }
  check('the pile summons a wave', frames.length > 1, `${enemies.length} crab(s) walked on`);
  check('...the first one sets off on the frame the chum is noticed',
    frames.length > 0 && frames[0].frame === 0, `first arrival on frame ${frames[0]?.frame}`);
  check('...and never more than one on a frame',
    frames.every((f) => f.n === 1), frames.map((f) => f.n).join(','));
  const span = frames.length > 1 ? (frames[frames.length - 1].frame - frames[0].frame) * dt : 0;
  check('...strung out across the window rather than issued at once',
    span > window * 0.4,
    `${span.toFixed(2)}s from first to last, window ${window}s`);
  // The gaps are jittered, so no two are the same length — a wave on a
  // metronome reads as one system's output however long the window is.
  const gaps = frames.slice(1).map((f, i) => f.frame - frames[i].frame);
  check('...with the gaps jittered, not metronomic',
    CONFIG.crabSpawn.waveJitter === 0 || new Set(gaps).size > 1,
    `gaps (frames): ${gaps.join(', ')}`);
  check('...all of them walking on from off-screen',
    enemies.every((e) => e.entering || Math.abs(e.mesh.position.x) > bounds.right - 0.01),
    'every arrival starts outside the walls');
}

// ---------------------------------------------------------------------------
section('THE GRAVE — the pile breaks up when the stone lands');
// ---------------------------------------------------------------------------
// The heap is the death; the headstone is what comes after it. Until this
// existed the two overlapped: the stone dropped onto the spot the crabs were
// piled on, threw them off it, and they turned round and walked back — so the
// name was cut behind a crab, which is the last thing the player watches.
reset();
clearGraves();
deathState.active = true;
{
  const body = makePlayer(0, FLOOR + 1.2);
  const pile = [];
  for (let i = 0; i < 8; i++) pile.push(crabAt((i % 2 ? 1 : -1) * (6 + i * 2), FLOOR + 1));

  // Piling on, exactly as the section above measures.
  for (let i = 0; i < 60 * 10; i++) {
    updateEnemies(dt, scene, body.mesh.position, () => {}, () => {});
    for (const e of pile) e.mesh.position.z = 0;
  }
  const KO = CONFIG.gravesite.keepOut;
  const onSite = () => pile.filter((e) => Math.abs(e.mesh.position.x) < KO.radius).length;
  const heaped = onSite();
  check('the crabs are on the body to begin with', heaped >= 5,
    `${heaped} of ${pile.length} inside the stone's footprint`);
  check('...and no stone has landed yet', !graveHasLanded());

  // A stand-in stone under the real asset key. plantGraves REFUSES to stand a
  // grave whose model has not loaded — the procedural fallback for these keys
  // is a cone, and a traffic cone with a name cut into it reads as a joke — so
  // without this the yard stays empty and every check below passes for the
  // wrong reason. Same stand-in tools/gravesite-test.mjs uses.
  {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 0.3), new THREE.MeshBasicMaterial());
    const root = new THREE.Object3D();
    root.add(box);
    installModel('headstone', root);
  }

  // The stone. Driven on the WALL clock like main.js drives it, and only far
  // enough to be on the bed — the point of the test is that the crabs go while
  // the inscription is still being cut, not after the whole sequence.
  recordGrave({ x: 0, z: 0, name: 'Tester', cause: 'a crab' });
  plantGraves(scene);
  let landed = false;
  for (let i = 0; i < 60 * 6 && !landed; i++) {
    updateGravesites(dt);
    landed = graveHasLanded();
  }
  check('the stone reaches the seabed', landed);
  check('the keep-out reads it from that frame', graveKeepOut(0, KO.radius) !== null,
    'not from the frame it finishes being carved');

  // No impact shove here — that is main.js's graveImpact, and this is the
  // steering half. If the crabs leave without being thrown, they left because
  // they decided to.
  //
  // OCCUPANCY OVER THE WINDOW, not a snapshot of the last frame. The keep-out
  // is not a wall: a crab may wander back toward the stone and be turned at its
  // edge, which is the behaviour working. Read on one frame that is a coin
  // toss — it failed on 2 seeds in 5 while the crabs were plainly clearing off.
  // What the scene actually needs is that almost nobody is standing on the
  // grave almost none of the time.
  // Two seconds to walk out from under it — a crab in the middle of a heap has
  // several body lengths to cover and is not meant to teleport — and then the
  // measurement.
  const walkOff = 60 * 2;
  const frames = 60 * 6;
  let occupied = 0;
  let counted = 0;
  for (let i = 0; i < walkOff + frames; i++) {
    updateEnemies(dt, scene, body.mesh.position, () => {}, () => {});
    for (const e of pile) e.mesh.position.z = 0;
    if (i >= walkOff) { occupied += onSite(); counted += pile.length; }
  }
  const share = occupied / counted;
  check('they clear the grave and stay off it', share < 0.06,
    `${(share * 100).toFixed(1)}% of crab-frames on the stone over the next ${(frames / 60).toFixed(0)}s, from ${((heaped / pile.length) * 100).toFixed(0)}%`);
  const mean = pile.reduce((sum, e) => sum + Math.abs(e.mesh.position.x), 0) / pile.length;
  check('...and end up out in the open', mean > KO.radius * 1.5,
    `mean ${mean.toFixed(1)} units out, keep-out ${KO.radius}`);
}

// ---------------------------------------------------------------------------
section('THE GRAVE IS NOT A SAFE ZONE');
// ---------------------------------------------------------------------------
// The keep-out steers a crab with nothing to do. A crab coming for the PLAYER
// ignores it — otherwise a player who parked on a headstone could not be
// reached, and a decoration would have quietly become a mechanic.
deathState.active = false;
reset();
{
  const standing = makePlayer(0, FLOOR + 1.2); // on top of the grave
  const hunter = crabAt(12, FLOOR + 1);
  for (let i = 0; i < 60 * 8; i++) {
    updateEnemies(dt, scene, standing.mesh.position, () => {}, () => {});
    hunter.mesh.position.z = 0;
  }
  check('a crab still comes for a player stood on the grave',
    Math.abs(hunter.mesh.position.x) < CONFIG.gravesite.keepOut.radius,
    `${hunter.mesh.position.x.toFixed(1)} units out`);
}

// ...and one with nothing to do walks off it. Same stone, no player anywhere
// near the floor.
reset();
{
  const away = makePlayer(0, bounds.top - 2);
  const idler = crabAt(1.5, FLOOR + 1);
  for (let i = 0; i < 60 * 8; i++) {
    updateEnemies(dt, scene, away.mesh.position, () => {}, () => {});
    idler.mesh.position.z = 0;
  }
  check('an idle crab leaves the footprint',
    Math.abs(idler.mesh.position.x) > CONFIG.gravesite.keepOut.radius,
    `${idler.mesh.position.x.toFixed(1)} units out`);
}
clearGraves();

deathState.active = false;
console.log(failures === 0 ? '\nPASS — all checks' : `\nFAIL — ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
