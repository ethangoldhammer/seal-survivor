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
import { summonDeathPile, updateDeathPile, resetCrabSpawner } from '../path/src/systems/crabSpawner.js';

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
  // A target held right up to the give-up timer was abandoned, not eaten.
  if (shark.chumChase > (sc.maxChase ?? 5) - dt && shark.chumChase < (sc.maxChase ?? 5) + dt) gaveUp++;
}
check('the shark targets fallen chum', sawTarget);
check('...swims into range and gulps', sawGulp);
check('...and swallows it', sharkAte > 0, `${sharkAte} orb(s)`);
check('...visibly, with crumbs', sharkHoover > 0, `${sharkHoover} crumb burst(s)`);
// A hunter that mostly fails to catch stationary food on the seabed is a
// hunter whose eatRange or turning circle is wrong, and it would read on
// screen as a shark circling a pile it never touches.
check('it connects more often than it whiffs', sharkAte > gaveUp,
  `${sharkAte} swallowed against ${gaveUp} abandoned in 20s`);
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

deathState.active = false;
console.log(failures === 0 ? '\nPASS — all checks' : `\nFAIL — ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
