#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:abilities
//
// Ticks the companion/ability systems headlessly and asserts they actually DO
// something. This is the half `npm run test:upgrades` explicitly cannot cover:
// that one proves an upgrade's stat wiring and its table entries, this one
// proves that when the system is handed a scene, a player and some enemies and
// run for a few hundred frames, fish get grabbed, boats get hit and bomblets
// go off.
//
// No renderer is involved — three.js Scene/Object3D/Mesh are plain data, and
// nothing here draws. That is what makes this possible in a terminal, and it
// matters because the browser preview suspends requestAnimationFrame: a
// screenshot of this game proves nothing about whether its loop works.
//
// It found a real bug on its first run. The oyster's bomblets were travelling
// 5.8 world units under drag against a 2.4 blast radius, so a burst detonated
// in a ring around the impact and left the impact point — where the fish the
// pearl just hit is standing — covered by nothing. See CONFIG.oyster.
//
// Run with the Vite loader shim, same as the upgrade harness:
//   node --import ./tools/vite-loader.mjs tools/ability-smoke.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../path/src/config.js';
import { installModel, createVisual, ASSETS } from '../path/src/assets.js';
import { enemies } from '../path/src/entities/enemies.js';
import { boats } from '../path/src/systems/boats.js';
import { createOctoGrabber, updateOctoGrab, resetOctoGrab } from '../path/src/systems/octoGrab.js';
import { updateOrcaPod, resetOrcaPod } from '../path/src/systems/orca.js';
import { burstPearl, updateOyster, resetOyster } from '../path/src/systems/oyster.js';
import { projectiles, spawnProjectile, updateProjectiles, resetProjectiles } from '../path/src/entities/projectiles.js';
import { eelCfg } from '../path/src/systems/eel.js';
import { createBelugaDrone, updateBeluga, resetBeluga, trapSeconds } from '../path/src/systems/beluga.js';
import { weatherState } from '../path/src/systems/weather.js';
import { createBakalarBoat, updateBakalar, resetBakalar, suctionAt, __beamShader } from '../path/src/systems/bakalar.js';
import {
  fireMusselBarrage, updateMusselVolley, resetMusselVolley,
  barrageCount, barrageDamage, barrageShells, chargePips, pendingShells,
} from '../path/src/systems/musselVolley.js';
import { strikeState, pipCount } from '../path/src/systems/strike.js';
import {
  isDazed, dazeReady, canControl, canHold, charmEnemy, holdEnemy, tickDaze, clearDaze, dazeSpeedMul,
} from '../path/src/systems/control.js';
import { createHarpVisual, updateHarp, resetHarp, applyHarpCharm, currentHarpStats, harpNoteCount } from '../path/src/systems/harp.js';
import { installNoteGlyphs } from '../path/src/systems/noteStorm.js';
import { bounds } from '../path/src/arena.js';

const scene = new THREE.Scene();
const dt = 1 / 60;
let failures = 0;

// The animation controller warns for every state a procedural stand-in has no
// clip for, which here is all of them — the models aren't loaded in Node. It's
// correct and it's noise, so it's silenced rather than left to bury the
// results under a hundred identical lines.
const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && msg.startsWith('[animation]')) return;
  realWarn(msg, ...rest);
};

function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

function fakeEnemy(x, y, radius = 0.5, hp = 40) {
  const mesh = new THREE.Object3D();
  mesh.position.set(x, y, 0);
  scene.add(mesh);
  return {
    mesh, radius, hp, vx: 0, vy: 0,
    trapTimer: 0, charmTimer: 0, flash: 0, hitThisFrame: false, biteCooldown: 0,
    def: { asset: 'enemyFish', radius, xp: 3, contactDamage: 5 },
    type: 'fish',
  };
}

function fakeBoat(x, y, hp = 60) {
  const mesh = new THREE.Object3D();
  mesh.position.set(x, y, 0);
  scene.add(mesh);
  return {
    mesh, hp, maxHp: hp, isTrawler: false, assetKey: 'boat',
    halfLength: 3, halfHeight: 0.8, offsetX: 0, offsetY: 0, radius: 3.2,
    knockX: 0, knockY: 0, rockVel: 0, flash: 0, dir: 1, sailX: x, spawnScale: 1,
    // The real boat carries this (systems/boats.js, `scars: []`), and
    // damageBoat pushes to it on every hit. A stub without it throws the
    // moment an orca connects — the standing hazard of building the subject by
    // hand instead of through the constructor under test.
    scars: [],
  };
}

const player = { x: 0, y: 0 };

// --- octopus grabber -------------------------------------------------------
// The octopus is the one ability here whose behaviour lives in a RIG rather
// than in plain arithmetic, so the real model is installed before it is
// created — against the boneless procedural fallback it resolves no arm
// chains and every check below would be measuring nothing.
// tools/octopus-rig-test.mjs goes further and checks the rig itself.
section('OCTOPUS GRABBER');
const RIG = resolve(dirname(fileURLToPath(import.meta.url)), '../public/models/octopus_rig.glb');
if (existsSync(RIG)) {
  const raw = readFileSync(RIG);
  const gltf = await new GLTFLoader().parseAsync(
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), '',
  );
  installModel('octoGrabber', gltf.scene, gltf.animations);
} else {
  console.log('  (rig missing — octopus checks will fail against the stand-in)');
}
createOctoGrabber();
resetOctoGrab(scene, player);
enemies.length = 0;
// Reach is measured from the OCTOPUS, which rides at an offset from the seal.
const oc = CONFIG.octoGrab;
const station = { x: player.x + oc.bodyOffset[0], y: player.y + oc.bodyOffset[1] };
const prey = fakeEnemy(station.x + oc.reach * 0.6, station.y);
enemies.push(prey);

let grabbed = false;
let grabFrame = -1;
let popped = 0;
let popFrame = -1;
let peakTrap = 0;
for (let i = 0; i < 600; i++) {
  updateOctoGrab(dt, scene, player, 3, enemies, {
    onGrab: () => { grabbed = true; if (grabFrame < 0) grabFrame = i; },
    onPop: () => { popped++; if (popFrame < 0) popFrame = i; },
  });
  peakTrap = Math.max(peakTrap, prey.trapTimer);
}
check('an arm reaches and grabs a fish in range', grabbed);
// "It should be grabbing fish right away." The arms start on a randomised
// cooldown of up to grabCooldown, so the ceiling is that plus a frame — this
// is the check that catches a rest interval quietly growing back.
const grabDeadline = Math.ceil((oc.grabCooldown + 0.1) / dt);
check('...and it reaches for it right away', grabFrame >= 0 && grabFrame <= grabDeadline,
  `frame ${grabFrame} of ${grabDeadline} (${(grabFrame * dt).toFixed(2)}s)`);
// Grab to chum, end to end. The fish is parked at 60% of reach, so this is
// the reach-out, the grasp and the whole reel.
check('the fish is chum inside a second', popFrame >= 0 && popFrame * dt < 1.0,
  `${(popFrame * dt).toFixed(2)}s`);
// The protection the card promises. trapTimer is what combat.js checks before
// applying contact damage, so a nonzero peak here IS "held fish deal no damage".
check('a held fish carries trapTimer (the damage nullification)', peakTrap > 0, `peak ${peakTrap.toFixed(2)}`);
check('the fish is reeled in and popped', popped > 0, `${popped} pop(s)`);
check('a popped fish leaves the enemy list', enemies.length === 0, `${enemies.length} left`);

resetOctoGrab(scene, player);
enemies.length = 0;
enemies.push(fakeEnemy(station.x + oc.reach * 0.6, station.y, oc.maxTargetRadius + 1));
let bigGrab = false;
for (let i = 0; i < 300; i++) {
  updateOctoGrab(dt, scene, player, 3, enemies, { onGrab: () => { bigGrab = true; } });
}
check('a fish over maxTargetRadius is never grabbed', !bigGrab);

// --- orca family -----------------------------------------------------------
section('ORCA FAMILY');
resetOrcaPod(scene, player);
enemies.length = 0;
boats.length = 0;
const boat = fakeBoat(10, 12);
boats.push(boat);

let boatHits = 0;
for (let i = 0; i < 900 && boats.length; i++) {
  updateOrcaPod(dt, scene, player, 2, enemies, {
    onBoatHit: () => { boatHits++; },
    onBoatDestroyed: () => {},
    onStrike: () => {},
  });
}
check('the pod hunts and hits a boat', boatHits > 0, `${boatHits} hit(s)`);
check('sustained attack sinks it', boat.hp < 60, `hp ${boat.hp.toFixed(0)}`);

// The defining behaviour of this companion: it looks PAST fish to boats.
resetOrcaPod(scene, player);
boats.length = 0;
enemies.length = 0;
enemies.push(fakeEnemy(4, 0, 1.2, 9999));
boats.push(fakeBoat(9, 12, 9999));
let fishDamage = 0;
for (let i = 0; i < 900; i++) {
  updateOrcaPod(dt, scene, player, 2, enemies, {
    onEnemyDamaged: (e, d) => { fishDamage += d; },
    onBoatHit: () => {}, onBoatDestroyed: () => {}, onStrike: () => {},
  });
}
check('a boat outranks a nearer fish', fishDamage === 0, `fish took ${fishDamage}`);

// NO SNAPPING. The pod used to write both its heading and its left/right
// mirror absolutely from the instantaneous velocity, so a seal swimming
// circles around it — which swings the cruise spring's drift through every
// angle at almost no speed — flipped the models end to end several times a
// second. Both channels are eased now, and this is the regression guard:
// nothing about an orca's orientation may move more than a few degrees in a
// frame, however the seal moves.
resetOrcaPod(scene, player);
boats.length = 0;
enemies.length = 0;
const knownBefore = new Set(scene.children);
const swimmer = { x: 0, y: 0 };
updateOrcaPod(dt, scene, swimmer, 2, enemies, {});
const podRoots = scene.children.filter((o) => !knownBefore.has(o));

// Shortest angular distance, so the wrap the settled mirror angle does (it is
// folded back into 0..2pi once a roll finishes) does not read as a 360 jump.
const angleDelta = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const prev = podRoots.map((r) => ({ z: r.rotation.z, y: r.children[0]?.rotation.y ?? 0 }));
let worstZ = 0;
let worstY = 0;
for (let i = 0; i < 900; i++) {
  // Two circles at different rates, so the seal keeps crossing the pod's
  // vertical instead of settling into one relationship with it.
  const t = i * dt;
  swimmer.x = Math.cos(t * 2.3) * 9;
  swimmer.y = Math.sin(t * 1.7) * 6;
  updateOrcaPod(dt, scene, swimmer, 2, enemies, {});
  podRoots.forEach((r, k) => {
    const y = r.children[0]?.rotation.y ?? 0;
    worstZ = Math.max(worstZ, angleDelta(r.rotation.z, prev[k].z));
    worstY = Math.max(worstY, angleDelta(y, prev[k].y));
    prev[k] = { z: r.rotation.z, y };
  });
}
check('the pod was actually built', podRoots.length === CONFIG.orca.count, `${podRoots.length} orca(s)`);
// A hard mirror swap is a whole pi in one frame; the eased roll is under a
// tenth of that, and the heading ease is capped by faceLerp.
check('no orca snaps its heading', worstZ < 0.35, `worst ${(worstZ * 180 / Math.PI).toFixed(1)} deg/frame`);
check('no orca snaps its mirror', worstY < 0.35, `worst ${(worstY * 180 / Math.PI).toFixed(1)} deg/frame`);

// --- oyster blaster --------------------------------------------------------
section('OYSTER BLASTER');
resetOyster(scene);
enemies.length = 0;
enemies.push(fakeEnemy(0.4, 0), fakeEnemy(-0.5, 0.3), fakeEnemy(0.2, -0.6));

let blasts = 0;
let burstDamage = 0;
burstPearl(scene, 0, 0, { count: 5, damage: 14, blastRadius: CONFIG.oyster.bombletBlastRadius });
for (let i = 0; i < 300; i++) {
  updateOyster(dt, scene, enemies, {
    onBlast: () => { blasts++; },
    onEnemyDamaged: (e, d) => { burstDamage += d; },
    onEnemyKilled: () => {},
  });
}
check('every bomblet detonates', blasts === 5, `${blasts} of 5`);
// The regression guard for the travel-vs-blast bug in the header. Bomblet
// angles are random, so this must hold for EVERY roll, not most of them —
// run it a few times if you change the speed, drag or life numbers.
check('the burst reaches enemies at the impact point', burstDamage > 0, `${burstDamage} damage`);

// --- scallop squirter ------------------------------------------------------
section('SCALLOP SQUIRTER');
resetProjectiles(scene);
const c = CONFIG.scallop;
spawnProjectile(scene, {
  origin: new THREE.Vector3(0, 0, 0),
  dir: new THREE.Vector2(1, 0),
  faction: 'player',
  damage: c.damage, speed: c.speed, life: c.life, radius: c.radius,
  asset: 'scallopShell', source: 'scallop',
  jet: true, jetInterval: c.pulseInterval, jetSpeed: c.pulseSpeed,
  jetTurn: c.turnRange, jetDrag: c.drag,
});

let jets = 0;
const headings = new Set();
for (let i = 0; i < 120; i++) {
  updateProjectiles(dt, scene, [], null, () => { jets++; }, null);
  const p = projectiles[0];
  if (p) headings.add(Math.round(Math.atan2(p.dir.y, p.dir.x) * 100));
}
check('the jet pulses repeatedly', jets > 1, `${jets} pulse(s) in 2s`);
// The whole identity of the weapon. A projectile that kept one heading would
// just be a slow bullet.
check('each pulse picks a new heading', headings.size > 1, `${headings.size} distinct headings`);

// --- eel storm response ----------------------------------------------------
section('ELECTRIC EEL — STORM');
weatherState.intensity = 0;
const calm = eelCfg();
weatherState.intensity = 1;
const storm = eelCfg();
weatherState.intensity = 0;

check('clear weather leaves the eel untouched', calm === CONFIG.eel);
check('a storm brightens the bolt', storm.boltGlow > calm.boltGlow, `${calm.boltGlow} → ${storm.boltGlow.toFixed(2)}`);
check('a storm thickens it', storm.coreWidth > calm.coreWidth, `${calm.coreWidth} → ${storm.coreWidth.toFixed(3)}`);
check('a storm makes it thrash further', storm.noiseAmplitude > calm.noiseAmplitude, `${calm.noiseAmplitude} → ${storm.noiseAmplitude.toFixed(2)}`);
check('a storm adds forks', storm.branchChance > calm.branchChance, `${calm.branchChance} → ${storm.branchChance.toFixed(2)}`);
// branchChance is tested against a 0..1 hash, so anything above 1 would mean
// "every fork, always" — the clamp is load-bearing, not cosmetic.
check('branchChance stays within 0..1', storm.branchChance <= 1, `${storm.branchChance.toFixed(2)}`);
check('damage is unchanged by default', storm.damageInStorm === undefined || CONFIG.eel.storm.damageInStorm === 1);

// --- bakalar's voicemail bomb ----------------------------------------------
section("BAKALAR'S VOICEMAIL BOMB");
createBakalarBoat(scene);
resetBakalar(scene);
enemies.length = 0;
// A school sitting just under the surface, where the net will sweep through it.
for (let i = 0; i < 8; i++) enemies.push(fakeEnemy(-20 + i * 5, bounds.surfaceY - 3, 0.5, 30));

let drops = 0;
let bombBlasts = 0;
let chumBits = 0;
let bombDamage = 0;
// Long enough for the spawn timer (14–22s) plus a full sail across the arena,
// several times over — the boat only drops a bomb into a net that is actually
// holding something, so this needs a few sailings to be reliable.
for (let i = 0; i < 60 * 180; i++) {
  updateBakalar(dt, scene, 3, enemies, {
    onHauled: () => {},
    onBombDrop: () => { drops++; },
    onBombBlast: () => { bombBlasts++; },
    onEnemyDamaged: (e, d) => { bombDamage += d; },
    onEnemyKilled: () => {},
    onChum: () => { chumBits++; },
  });
}
check('the boat drops bombs into a loaded net', drops > 0, `${drops} drop(s)`);
check('every dropped bomb detonates', bombBlasts === drops, `${bombBlasts} blast(s) of ${drops}`);
check('the blast damages the catch', bombDamage > 0, `${bombDamage} damage`);
// The bomb pays in chum, not XP — the haul already pays XP, and both halves
// of one ability competing for the same fish is what this split avoids.
check('the blast pays out chum', chumBits > 0, `${chumBits} bit(s)`);

// --- the tractor beam -------------------------------------------------------
// Two things worth checking that nothing else can.
//
// The SHADER: nothing in Node compiles GLSL, and the browser preview suspends
// requestAnimationFrame so it never renders a frame to compile one in either.
// That leaves the realistic failure — a uniform renamed on one side of the
// pair and not the other — completely uncovered, and its symptom is a silently
// black beam.
//
// The SUCTION: the pull and the light are meant to be the same two curves, so
// that fish are dragged hardest exactly where the beam is brightest.
section('BAKALAR TRACTOR BEAM');
{
  const { BEAM_FRAG, makeBeamMaterial } = __beamShader;
  const mat = makeBeamMaterial();
  const declared = Object.keys(mat.uniforms);
  const missing = declared.filter((u) => !BEAM_FRAG.includes(u) && !__beamShader.BEAM_VERT.includes(u));
  check('every uniform the material declares is read by the shader',
    missing.length === 0, missing.length ? missing.join(', ') : `${declared.length} uniforms`);

  // ...and the other direction, which is the one that actually goes black: a
  // shader reading something the material never supplies.
  const used = [...BEAM_FRAG.matchAll(/uniform\s+\w+\s+(\w+)/g)].map((m) => m[1]);
  const unsupplied = used.filter((u) => !declared.includes(u));
  check('...and every uniform the shader reads is supplied',
    unsupplied.length === 0, unsupplied.length ? unsupplied.join(', ') : `${used.length} read`);

  check('the beam is additive so the catch inside stays legible',
    mat.blending === THREE.AdditiveBlending && mat.depthWrite === false);

  // FALLOFF, which is the whole point of calling it a beam. Measured on the
  // same function the haul uses.
  const hw = 4;
  const nd = 9;
  const onAxis = suctionAt(0, 1, hw, nd);
  const offAxis = suctionAt(hw * 0.8, 1, hw, nd);
  check('the pull is strongest on the beam axis', onAxis > offAxis,
    `${onAxis.toFixed(2)} on axis vs ${offAxis.toFixed(2)} out at the edge`);

  const nearHull = suctionAt(0, 0.5, hw, nd);
  const deep = suctionAt(0, nd * 0.9, hw, nd);
  check('...and strongest near the hull', nearHull > deep,
    `${nearHull.toFixed(2)} near the hull vs ${deep.toFixed(2)} at the bottom`);

  check('outside the cone there is no pull at all', suctionAt(hw * 3, 1, hw, nd) === 0);
  // The cone taper has to work in the direction the shader draws it: the beam
  // is NARROW at the hull, so a fish far off-axis is outside it up there while
  // still inside it further down.
  const wideDown = suctionAt(hw * 0.8, nd * 0.9, hw, nd);
  const narrowUp = suctionAt(hw * 0.8, 0.3, hw, nd);
  check('the cone is narrower at the hull than at the bottom', wideDown > narrowUp,
    `${wideDown.toFixed(3)} low vs ${narrowUp.toFixed(3)} high, same offset`);

  // The floor, from the direction that matters. A fish caught out past the
  // cone edge has a raw suction of exactly zero — if the floor did not reach
  // the INWARD draw as well as the rise, it would ride up the outside of the
  // beam forever and never converge into it.
  check('a fish outside the cone still gets some pull, or it would never converge',
    CONFIG.bakalar.suction.minPull > 0, `minPull ${CONFIG.bakalar.suction.minPull}`);

  // End to end: everything the net sweeps up still lands, edges included.
  resetBakalar(scene);
  enemies.length = 0;
  const wide = CONFIG.bakalar.netWidth * 0.5;
  // One dead on the axis, one right out at the rim — the two extremes of the
  // falloff, which both have to end up hauled.
  enemies.push(fakeEnemy(0, bounds.surfaceY - 3, 0.5, 500));
  enemies.push(fakeEnemy(wide * 0.95, bounds.surfaceY - 3, 0.5, 500));
  let hauled = 0;
  // Bombs off: they kill the catch, and this is a check about the HAUL.
  const bombWas = CONFIG.bakalar.bomb.enabled;
  CONFIG.bakalar.bomb.enabled = false;
  for (let i = 0; i < 60 * 240 && hauled < 2; i++) {
    updateBakalar(dt, scene, 1, enemies, { onHauled: () => { hauled++; } });
  }
  CONFIG.bakalar.bomb.enabled = bombWas;
  check('both an axis fish and a rim fish are hauled out', hauled === 2, `${hauled} of 2`);
}

// --- baby beluga ------------------------------------------------------------
// The ability is a cluster bomb now, and it is four beats: a fat bubble is
// lobbed and FLOATS, it splits into bomblets that scatter, each bomblet pops on
// its own fuse, and whatever a pop covers is sealed in a shell for the hold.
//
// All of it is invisible to a screenshot — the browser preview suspends rAF —
// and every failure mode here is silent. Bomblets that never pop leak meshes
// into the scene forever; fuses that don't stagger collapse the cluster back
// into one big bubble with extra steps; a shell that misses its creature's
// death rides a recycled body around; and a catch radius that doesn't match the
// drawn one is only ever visible as fish swimming through a bubble.
section('BABY BELUGA');
enemies.length = 0;
const belugaDrone = createBelugaDrone();
scene.add(belugaDrone);
resetBeluga(scene, { x: 0, y: 0 });

// Split angles and both fuses are random, and half of what is asserted below is
// about that randomness — so it runs on a fixed sequence rather than on however
// the run happens to fall. Restored at the end of the section.
const realRandom = Math.random;
let rngState = 20260813;
Math.random = () => {
  rngState = (rngState * 1664525 + 1013904223) >>> 0;
  return rngState / 4294967296;
};

let traps = 0;
let pops = 0;
let splits = 0;
let popAt = null;
const belugaHooks = {
  onTrap: () => { traps++; },
  onPop: (x, y) => { pops++; popAt = { x, y }; },
  onSplit: () => { splits++; },
};
// updateEnemies is what runs the hold down in the real game, and it isn't in
// this harness — so the tick does that part itself. Without it the trap never
// expires and the release half of the test waits forever.
let belugaClock = 0;
const tickBeluga = (frames) => {
  for (let i = 0; i < frames; i++) {
    for (const e of enemies) if (e.trapTimer > 0) e.trapTimer = Math.max(0, e.trapTimer - dt);
    updateBeluga(dt, scene, { x: 0, y: 0 }, 1, enemies, belugaClock, belugaHooks);
    belugaClock += dt;
  }
};
const bubbleMeshes = () => scene.children.filter((o) => o.name === 'trapBubble');

// --- the lob ---------------------------------------------------------------
// A target far enough out that nothing is caught: this half is about how the
// shot MOVES, and a catch would end the flight early.
const decoy = fakeEnemy(40, 0, 0.5, 9999);
enemies.push(decoy);
const bg = CONFIG.beluga;
const fireFrames = Math.ceil((bg.fireRate + 0.2) / dt);

for (let i = 0; i < fireFrames && bubbleMeshes().length === 0; i++) tickBeluga(1);
check('the drone lobs one cluster', bubbleMeshes().length === 1,
  `${bubbleMeshes().length} bubble(s)`);
const cluster = bubbleMeshes()[0];
const clusterRadius = 0.35 * cluster.scale.x; // 0.35 is the asset's authored radius

// IT SLOWS DOWN. This is the legibility fix in one number — the shot has to
// stop travelling and start floating, or it is the pellet it replaced.
const launchedAt = cluster.position.clone();
const step0 = cluster.position.clone();
tickBeluga(1);
const firstStep = cluster.position.distanceTo(step0);
tickBeluga(Math.ceil(0.45 / dt));
const beforeLate = cluster.position.clone();
tickBeluga(1);
const lateStep = cluster.position.distanceTo(beforeLate);
check('drag turns the lob into a float', lateStep < firstStep * 0.5,
  `${(firstStep / dt).toFixed(1)} -> ${(lateStep / dt).toFixed(1)} units/s after 0.45s`);
// ...and the whole point of that: it can't cross the arena. Terminal distance
// under exponential drag is speed/drag, and a shot that outran it would be the
// pellet this replaced with extra steps.
check('...so the shot stays in the water you can see',
  cluster.position.distanceTo(launchedAt) < CONFIG.beluga.speed / CONFIG.beluga.drag,
  `${cluster.position.distanceTo(launchedAt).toFixed(1)} of ${(CONFIG.beluga.speed / CONFIG.beluga.drag).toFixed(1)} units`);

// IT WANDERS. Measured against a CONTROL run with the turbulence switched off,
// because buoyancy also bends the path and a bare "it isn't a straight line"
// check would pass on the rise alone.
const pathWith = [];
for (let i = 0; i < 12; i++) { pathWith.push(cluster.position.y); tickBeluga(1); }
const turbWas = bg.turbulence;
bg.turbulence = 0;
resetBeluga(scene, { x: 0, y: 0 });
belugaClock = 0;
for (let i = 0; i < fireFrames && bubbleMeshes().length === 0; i++) tickBeluga(1);
const calmLob = bubbleMeshes()[0];
tickBeluga(Math.ceil(0.35 / dt) + 2);
const pathCalm = [];
for (let i = 0; i < 12; i++) { pathCalm.push(calmLob.position.y); tickBeluga(1); }
bg.turbulence = turbWas;
const wanderDelta = pathWith.reduce((a, y, i) => a + Math.abs(y - pathCalm[i]), 0) / pathWith.length;
check('turbulence pushes it off the buoyant path', wanderDelta > 0.02,
  `${wanderDelta.toFixed(3)} units off the calm-water control`);

// --- the split -------------------------------------------------------------
resetBeluga(scene, { x: 0, y: 0 });
splits = 0;
pops = 0;
belugaClock = 0;
for (let i = 0; i < fireFrames && bubbleMeshes().length === 0; i++) tickBeluga(1);
// Long enough for the longest jittered split delay.
for (let i = 0; i < Math.ceil(bg.splitDelay * (1 + bg.splitVary) / dt) + 2 && splits === 0; i++) tickBeluga(1);
check('the cluster splits', splits === 1, `${splits} split(s)`);
check('...into a full set of bomblets', bubbleMeshes().length === bg.splitCount,
  `${bubbleMeshes().length} of ${bg.splitCount}`);
const bomblets = bubbleMeshes();
const bombletRadius = 0.35 * bomblets[0].scale.x;
check('...each smaller than the cluster that carried them',
  Math.abs(bombletRadius - clusterRadius * bg.bombletScale) < 0.05,
  `${bombletRadius.toFixed(2)} vs ${(clusterRadius * bg.bombletScale).toFixed(2)} wanted`);

// They have to go DIFFERENT WAYS. Five bomblets leaving on one heading is a
// bigger bubble, not a cluster.
const spawnAt = bomblets.map((m) => m.position.clone());
tickBeluga(3);
const bombletHeadings = bomblets.map((m, i) => Math.atan2(m.position.y - spawnAt[i].y, m.position.x - spawnAt[i].x));
const bombletSpread = Math.max(...bombletHeadings) - Math.min(...bombletHeadings);
check('the bomblets scatter', bombletSpread > 2, `${bombletSpread.toFixed(2)} rad across the set`);

// ...and pop at DIFFERENT TIMES. Recorded per frame: all five landing on one
// frame is the same failure as all five leaving on one heading.
const popFrames = [];
belugaHooks.onPop = (x, y) => { pops++; popAt = { x, y }; popFrames.push(belugaClock); };
for (let i = 0; i < Math.ceil((bg.fuse * (1 + bg.fuseVary) + 0.3) / dt) && pops < bg.splitCount; i++) tickBeluga(1);
check('every bomblet goes off', pops === bg.splitCount, `${pops} of ${bg.splitCount}`);
check('...on staggered fuses rather than together',
  new Set(popFrames.map((t) => t.toFixed(2))).size >= 3,
  `${new Set(popFrames.map((t) => t.toFixed(2))).size} distinct moments`);
// Counted against THESE bomblets rather than the scene: the drone is on its
// own cadence and the next cluster may already be in the air, which says
// nothing about whether this one cleaned up after itself.
check('a spent cluster leaves nothing in the water',
  bomblets.every((m) => m.parent === null),
  `${bomblets.filter((m) => m.parent !== null).length} orphan(s)`);

// The split's feedback event, same reasoning as the pop's below: a name that
// isn't in the tables is a console warning and a silent beat.
check('the split has a feedback event', !!CONFIG.feedback.belugaSplit);
check('...and a sound of its own', !!CONFIG.sfx[CONFIG.feedback.belugaSplit?.sfx],
  `sfx "${CONFIG.feedback.belugaSplit?.sfx}"`);

// --- the catch -------------------------------------------------------------
enemies.length = 0;
resetBeluga(scene, { x: 0, y: 0 });
traps = 0;
pops = 0;
belugaHooks.onPop = (x, y) => { pops++; popAt = { x, y }; };

// Right on top of the drone's orbit, so a bomblet reaches it.
const caught = fakeEnemy(CONFIG.beluga.orbitRadius, 0, 0.5, 9999);
enemies.push(caught);

// A whole cycle: fire, float, split, fuse.
const belugaFrames = Math.ceil((bg.fireRate + bg.splitDelay * 2 + bg.fuse * 2 + 1) / dt);
for (let i = 0; i < belugaFrames && traps === 0; i++) tickBeluga(1);
check('a bomblet seals a fish', traps === 1, `${traps} trap(s)`);
check('the fish is held for the level-1 duration',
  Math.abs(caught.trapTimer - CONFIG.beluga.trapDuration) < 0.1,
  `trapTimer ${caught.trapTimer.toFixed(2)} of ${CONFIG.beluga.trapDuration}`);
// Levelling has to buy uptime, not just width — the card is taken up to 8
// times and every stack past the first used to hold for exactly as long.
check('levelling holds them longer', trapSeconds(4) > trapSeconds(1),
  `${trapSeconds(1).toFixed(1)}s -> ${trapSeconds(4).toFixed(1)}s at level 4`);

// THE SHELL. A trapped fish is a fish visibly inside a bubble, for the whole
// hold — the only thing on screen that says it is out of the fight. Found by
// position rather than by index: sibling bomblets from the same cluster are
// still drifting and are the same mesh.
const shell = bubbleMeshes().reduce((best, m) =>
  (m.position.distanceTo(caught.mesh.position) < best.position.distanceTo(caught.mesh.position) ? m : best));
check('the bubble stays, wrapped around the catch',
  shell.position.distanceTo(caught.mesh.position) < clusterRadius,
  `${shell.position.distanceTo(caught.mesh.position).toFixed(2)} from the fish`);
// Let the sibling bomblets finish before anything below counts pops — they are
// still drifting on their own fuses and each one is a `pops` of its own. The
// drone can't fire again meanwhile: its only target is already held.
tickBeluga(Math.ceil((bg.fuse * (1 + bg.fuseVary) + 0.3) / dt));
pops = 0;
check('the shell outlives the cluster that delivered it', bubbleMeshes().length === 1,
  `${bubbleMeshes().length} bubble(s) left`);

const shellRadius = 0.35 * shell.scale.x; // 0.35 is the asset's authored radius
check('it closes to fit the creature',
  Math.abs(shellRadius - caught.radius * CONFIG.beluga.fitPad) < 0.15,
  `${shellRadius.toFixed(2)} vs ${(caught.radius * CONFIG.beluga.fitPad).toFixed(2)} wanted`);

// It rides the fish. Trapped creatures are frozen, but a rigid body can still
// shove one, and a shell left behind at the point of contact is a bubble
// floating next to a fish rather than around it.
caught.mesh.position.set(caught.mesh.position.x + 3, caught.mesh.position.y - 2, 0);
tickBeluga(1);
check('the shell follows the body it is wrapped around',
  shell.position.distanceTo(caught.mesh.position) < 0.001,
  `${shell.position.distanceTo(caught.mesh.position).toFixed(3)} apart`);

// Held, but not frozen solid: it breathes.
let breathMin = Infinity;
let breathMax = 0;
for (let i = 0; i < Math.ceil(1 / (CONFIG.beluga.wobbleHz * dt)); i++) {
  breathMin = Math.min(breathMin, shell.scale.x);
  breathMax = Math.max(breathMax, shell.scale.x);
  tickBeluga(1);
}
check('it breathes while it holds', breathMax > breathMin * 1.01,
  `${breathMin.toFixed(3)} - ${breathMax.toFixed(3)}`);

// THE WARNING. Run down to the last stretch of the hold and it must strobe —
// this is the player's cue that a fish is about to be back in the fight.
caught.trapTimer = CONFIG.beluga.warnFlicker * 0.5;
let visibleFrames = 0;
let hiddenFrames = 0;
for (let i = 0; i < Math.ceil(CONFIG.beluga.warnFlicker * 0.4 / dt) && pops === 0; i++) {
  tickBeluga(1);
  if (shell.visible) visibleFrames++; else hiddenFrames++;
}
check('it warns before it lets go', visibleFrames > 0 && hiddenFrames > 0,
  `${visibleFrames} on / ${hiddenFrames} off`);

// ...and then bursts, on the fish, taking its mesh with it. Stopped on the
// burst frame rather than run past it: the moment the hold ends the fish is a
// target again, and the next bubble the drone fires is a trapBubble mesh in
// the scene that has nothing to do with whether this shell cleaned up.
for (let i = 0; i < Math.ceil((CONFIG.beluga.warnFlicker + 0.5) / dt) && pops === 0; i++) tickBeluga(1);
check('the shell bursts when the hold ends', pops === 1, `${pops} pop(s)`);
check('the burst lands on the fish it held',
  popAt && Math.hypot(popAt.x - caught.mesh.position.x, popAt.y - caught.mesh.position.y) < 0.01,
  popAt ? `(${popAt.x.toFixed(2)}, ${popAt.y.toFixed(2)})` : 'never fired');
check('nothing is left in the scene', bubbleMeshes().length === 0,
  `${bubbleMeshes().length} orphan(s)`);

// The pop event drives real feedback, so a name that isn't in the tables is a
// console warning at runtime and a silent trap forever.
check('the burst has a feedback event', !!CONFIG.feedback.belugaPop);
check('...whose emitter exists', !!CONFIG.emitters[CONFIG.feedback.belugaPop?.emit],
  `emit "${CONFIG.feedback.belugaPop?.emit}"`);
check('...and whose sound exists', !!CONFIG.sfx[CONFIG.feedback.belugaPop?.sfx],
  `sfx "${CONFIG.feedback.belugaPop?.sfx}"`);

// A CREATURE THAT DIES INSIDE ITS BUBBLE. The shell holds a direct reference to
// an enemy, and a dead one's body goes back to the visual pool and is handed to
// the next spawn — so a shell that doesn't notice would ride a different animal
// around the arena for the rest of the hold.
enemies.length = 0;
resetBeluga(scene, { x: 0, y: 0 });
traps = 0;
pops = 0;
const doomed = fakeEnemy(CONFIG.beluga.orbitRadius, 0, 0.5, 9999);
enemies.push(doomed);
for (let i = 0; i < belugaFrames && traps === 0; i++) tickBeluga(1);
check('a fish is caught to kill', traps === 1, `${traps} trap(s)`);
tickBeluga(Math.ceil((bg.fuse * (1 + bg.fuseVary) + 0.3) / dt)); // let its siblings finish
pops = 0;
enemies.length = 0; // killed: spliced out from under the shell
tickBeluga(2);
check('killing the catch bursts its bubble', pops === 1, `${pops} pop(s)`);
check('...and leaves nothing behind', bubbleMeshes().length === 0,
  `${bubbleMeshes().length} orphan(s)`);

// ONE POP, A SCHOOL. A bomblet is drawn far wider than a small fish, and
// sealing only the first thing it touched read as a miss on everything else
// inside it. Packed tight, so one bomblet covers the lot.
resetBeluga(scene, { x: 0, y: 0 });
traps = 0;
pops = 0;
const crowd = [];
for (let i = 0; i < 6; i++) crowd.push(fakeEnemy(CONFIG.beluga.orbitRadius, i * 0.2, 0.2, 9999));
enemies.push(...crowd);
// Attributed PER DETONATION rather than per frame: detonate() calls onTrap once
// per creature and then onPop once, so the count standing at each pop is what
// that one bomblet sealed. Counting over a frame instead measures however many
// bomblets happened to share it, which is not what the cap governs.
let thisPop = 0;
const perPop = [];
belugaHooks.onTrap = () => { traps++; thisPop++; };
belugaHooks.onPop = () => { pops++; perPop.push(thisPop); thisPop = 0; };
for (let i = 0; i < belugaFrames && traps === 0; i++) tickBeluga(1);
check('one bomblet seals a whole cluster of fish',
  Math.max(...perPop, 0) > 1, `best pop took ${Math.max(...perPop, 0)}`);
check('...but never more than its cap',
  perPop.every((n) => n <= CONFIG.beluga.maxCatch),
  `${perPop.join('/')} against a cap of ${CONFIG.beluga.maxCatch}`);
check('...each in its own shell',
  bubbleMeshes().filter((m) => crowd.some((e) => m.position.distanceTo(e.mesh.position) < 0.001)).length === traps,
  `${bubbleMeshes().length} bubble(s) in the water`);

enemies.length = 0;
resetBeluga(scene, { x: 0, y: 0 });
check('a reset takes every shell and bomblet with it', bubbleMeshes().length === 0,
  `${bubbleMeshes().length} orphan(s)`);
scene.remove(belugaDrone);
Math.random = realRandom;

// THE FILM. The bubble's Fresnel shell is injected GLSL, and this cannot
// compile it — no Node harness can, and that is exactly the danger: a GLSL
// error links no program and the mesh renders as NOTHING, which looks like the
// bubble was never spawned. (Compile it for real the way the memory describes:
// esbuild an entry that imports assets.js, serve it, render one frame.)
//
// What IS checkable here is the class of mistake that caused the last silent
// invisibility: a varying written in one stage and declared in the other. Both
// stages are run through the real onBeforeCompile against three's own
// MeshBasicMaterial source, so a chunk name that changes under a three upgrade
// shows up as a replacement that no longer lands.
{
  const film = createVisual('trapBubble');
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.basic.vertexShader,
    fragmentShader: THREE.ShaderLib.basic.fragmentShader,
  };
  check('the bubble asset carries a shell material', typeof film.material?.onBeforeCompile === 'function');
  film.material.onBeforeCompile?.(shader);
  check('the vertex hook landed', shader.vertexShader.includes('vShellN = normalize'));
  check('the fragment hook landed', shader.fragmentShader.includes('shellRim'));
  check('...and it replaced diffuseColor rather than adding a second one',
    (shader.fragmentShader.match(/vec4 diffuseColor = vec4\(/g) ?? []).length === 1);
  check('every shell uniform is bound',
    ['uShellPower', 'uShellCore', 'uShellRim', 'uShellBoost', 'uShellSheen']
      .every((u) => shader.uniforms[u] && typeof shader.uniforms[u].value === 'number'));
  // The generic guard: anything the vertex stage ASSIGNS to must be declared in
  // the vertex stage. three's own varyings live in unresolved #include chunks
  // at this point, so they stay correctly out of scope.
  const injectedVert = shader.vertexShader.match(/^\s*(v[A-Z]\w*) = /gm) ?? [];
  const undeclared = injectedVert
    .map((line) => line.trim().split(' ')[0])
    .filter((name) => name.startsWith('vShell'))
    .filter((name) => !new RegExp(`varying[^;]*\\b${name}\\b`).test(shader.vertexShader));
  check('no varying is written in a stage that never declared it',
    undeclared.length === 0, undeclared.join(', ') || 'all declared');
  // Both faces, and no depth write — a bubble you cannot see the far wall of,
  // or that z-rejects the fish it is wrapped around, is a marble.
  check('the film draws both walls and hides nothing behind it',
    film.material.side === THREE.DoubleSide && film.material.transparent && !film.material.depthWrite);
}

// --- mussel barrage ---------------------------------------------------------
// The gate, the fan, the pip payment and the stagger. The first two are the
// design; the last two are the two ways this ability can quietly stop being
// what it says — a flight that never finishes leaving, and a flight that all
// leaves on one frame anyway.
console.log('\nMUSSEL BARRAGE');
resetProjectiles(scene);
resetMusselVolley();
enemies.length = 0;

const dash = { x: 1, y: 0 };
// Walks with the dash, so the LAUNCH POINTS can be measured. A callback that
// always returned the origin would pass a staggered barrage and a simultaneous
// one identically.
let sealX = 0;
const originAt = () => new THREE.Vector3(sealX, 0, 0);

// THE GATE. This is the whole design — below the threshold a strike is just a
// dash — so it is checked from both sides rather than only the happy path.
const weak = fireMusselBarrage(scene, CONFIG.musselVolley.chargeThreshold - 0.1, 3, dash, originAt);
check('a half-charged strike throws nothing', weak === 0, `${weak} shell(s)`);
const unlearned = fireMusselBarrage(scene, 1, 0, dash, originAt);
check('...and neither does a full charge without the upgrade', unlearned === 0, `${unlearned} shell(s)`);
check('neither put a projectile in the scene', projectiles.length === 0, `${projectiles.length} live`);
check('and neither queued anything for later', pendingShells() === 0, `${pendingShells()} queued`);

// THE CHARGE PAYS IN PIPS. The card's count is the floor; a full bar adds one
// shell per pip on top, which is the buff the whole ability now hangs on.
check('a full bar is worth its whole pip count',
  chargePips(1) === pipCount(), `${chargePips(1)} of ${pipCount()} pips`);
check('...and a part-filled bar is FLOORED, never rounded up',
  chargePips(0.99) < pipCount() && chargePips(0.99) === pipCount() - 1,
  `${chargePips(0.99)} pips at 0.99 of a ${pipCount()}-pip bar`);
check('a full charge throws more than the card alone',
  barrageShells(1, 1) === barrageCount(1) + Math.min(chargePips(1), CONFIG.musselVolley.pipShellsMax),
  `${barrageCount(1)} + ${chargePips(1)} pips -> ${barrageShells(1, 1)}`);

const thrown = fireMusselBarrage(scene, 1, 1, dash, originAt);
check('a full charge buys card + pips at level 1',
  thrown === barrageShells(1, 1), `${thrown} shell(s)`);

// THE STAGGER. One shell on the release frame — the moment the player pressed —
// and the rest still owed.
check('the first shell leaves on the release frame', projectiles.length === 1, `${projectiles.length} live`);
check('...and the rest are queued', pendingShells() === thrown - 1, `${pendingShells()} of ${thrown - 1}`);

// Pump the queue, walking the seal as a dash would. Frames rather than one big
// step, because a gap shorter than a frame has to still fire one per frame in
// order rather than dumping the backlog.
const launchXs = [projectiles[0].mesh.position.x];
for (let f = 0; f < 240 && pendingShells() > 0; f++) {
  sealX += 0.2;
  const before = projectiles.length;
  updateMusselVolley(dt);
  for (let i = before; i < projectiles.length; i++) launchXs.push(projectiles[i].mesh.position.x);
}
check('every shell the release bought eventually leaves',
  projectiles.length === thrown && pendingShells() === 0, `${projectiles.length} of ${thrown}, ${pendingShells()} stuck`);
check('they left from points spread along the dash, not from one spot',
  new Set(launchXs.map((x) => x.toFixed(3))).size === thrown,
  `${new Set(launchXs.map((x) => x.toFixed(3))).size} distinct launch points`);
// Monotonic: shell i always leaves at or behind shell i+1 down the dash. Out of
// order here would mean the fan's edges arriving in the middle of the line.
check('...in launch order, down the line',
  launchXs.every((x, i) => i === 0 || x > launchXs[i - 1]), launchXs.map((x) => x.toFixed(1)).join(' '));

check('they all seek', projectiles.every((p) => p.homing), `${projectiles.filter((p) => p.homing).length} homing`);

// The fan has to be a FAN. Shells that all left on the same heading is the
// failure mode this catches — it looks like one fat missile, and homing would
// hide it within a few frames of launch.
const barrageHeadings = projectiles.map((p) => Math.atan2(p.vy ?? p.dir?.y ?? 0, p.vx ?? p.dir?.x ?? 1));
const barrageSweep = Math.max(...barrageHeadings) - Math.min(...barrageHeadings);
check('the shells leave across a wide arc',
  barrageSweep > CONFIG.musselVolley.arc * 0.6, `${barrageSweep.toFixed(2)} rad of ${CONFIG.musselVolley.arc} configured`);
// Centred on the dash, not offset to one side of it.
const barrageMean = barrageHeadings.reduce((a, b) => a + b, 0) / barrageHeadings.length;
check('the fan is centred on the dash heading', Math.abs(barrageMean) < 0.3, `centre ${barrageMean.toFixed(2)} rad off`);

// TWO BARRAGES OVERLAPPING. The eat-and-strike loop releases again well inside
// a previous dash's flight, so a queue that only ever looked at its front
// entry would hold the new barrage's opening shot behind the old one's tail —
// input lag on the loudest frame in the game, in exactly the case the whole
// mechanic exists to reward.
resetProjectiles(scene);
resetMusselVolley();
fireMusselBarrage(scene, 1, 1, dash, originAt);
updateMusselVolley(dt); // a frame into the first flight, with shells still owed
const owed = pendingShells();
const before = projectiles.length;
fireMusselBarrage(scene, 1, 1, dash, originAt);
check('a second barrage fires its first shell immediately, behind or not',
  projectiles.length > before && owed > 0,
  `${projectiles.length - before} left on the release frame with ${owed} still owed`);
resetProjectiles(scene);
resetMusselVolley();

// THE FLIGHT FITS THE DASH. A big barrage must compress rather than run on
// after the seal has stopped — that is the one thing the stagger can get wrong
// that still looks like it is working.
resetProjectiles(scene);
resetMusselVolley();
strikeState.dashDuration = 0.4;
const fitted = fireMusselBarrage(scene, 1, 5, dash, originAt);
let fitFrames = 0;
while (pendingShells() > 0 && fitFrames < 600) { updateMusselVolley(dt); fitFrames += 1; }
check(`a ${fitted}-shell flight still finishes inside the dash`,
  fitFrames * dt <= strikeState.dashDuration + dt * 2,
  `${(fitFrames * dt).toFixed(3)}s of a ${strikeState.dashDuration}s dash`);
strikeState.dashDuration = 0;
resetProjectiles(scene);
resetMusselVolley();

// Levelling has to buy something visible. Both numbers, because the card
// promises more shells and they are meant to hit harder too.
check('levelling adds shells', barrageCount(3) > barrageCount(1), `${barrageCount(1)} -> ${barrageCount(3)}`);
check('levelling adds damage', barrageDamage(3) > barrageDamage(1), `${barrageDamage(1)} -> ${barrageDamage(3)}`);

// ===========================================================================
section('HARP SEAL');
// ===========================================================================
// Three separable claims, and the first is the one worth a harness at all:
// the harp targets the BIGGEST thing near you, not the nearest. That is the
// card, it is one comparison deep in a loop, and it is invisible in play —
// a nearest-target bug still looks like a working ability.
resetProjectiles(scene);
enemies.length = 0;

// THE MODEL, INSTALLED FIRST — and this half is not about behaviour at all.
// harp.glb is authored standing up the +Y pillar with its flat face on X-Y, so
// the entry names `forward: '+Y', up: '-X'` to land that face at the camera.
// Get the `up` sign wrong and the harp turns edge-on: a 0.28-unit sliver for
// the whole run, which looks like the model failed to load rather than like a
// rotation, and no amount of staring at the axis NAMES would tell you. So it
// is measured where the vertices actually ended up, after orientation and fit.
// The note glyphs, from the REAL file rather than a stub plane. The field is
// silent without them — no throw, no warning, just nothing drawn — so a harness
// that skipped this would certify a working ring around an empty scene. See
// [[harness-tests-bypass-the-asset-pipeline]]: they go in through
// installNoteGlyphs because preloadAssets fetches by URL and this is a terminal
// script.
const NOTES_MODEL = resolve(dirname(fileURLToPath(import.meta.url)), '../public/models/musicnotes.glb');
if (existsSync(NOTES_MODEL)) {
  const raw = readFileSync(NOTES_MODEL);
  const gltf = await new GLTFLoader().parseAsync(
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), '',
  );
  const geoms = [];
  gltf.scene.traverse((o) => { if (o.isMesh) geoms.push(o.geometry); });
  installNoteGlyphs(geoms);
  check('the note glyphs loaded', geoms.length === 8, `${geoms.length} glyph(s)`);
}

const HARP_MODEL = resolve(dirname(fileURLToPath(import.meta.url)), '../public/models/harp.glb');
if (existsSync(HARP_MODEL)) {
  const raw = readFileSync(HARP_MODEL);
  const gltf = await new GLTFLoader().parseAsync(
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), '',
  );
  installModel('harp', gltf.scene, gltf.animations);

  const probe = createVisual('harp');
  scene.add(probe);
  // Without this every measurement comes back identical and nothing throws —
  // Box3 does not force the world matrices for you.
  scene.updateMatrixWorld(true);
  const hbox = new THREE.Box3().setFromObject(probe);
  const hs = hbox.getSize(new THREE.Vector3());
  check('the harp stands upright', hs.y > hs.x && hs.y > hs.z,
    `${hs.x.toFixed(2)} x ${hs.y.toFixed(2)} y ${hs.z.toFixed(2)} z`);
  check('...and presents its face, not its edge, to the camera', hs.z < hs.x,
    `depth ${hs.z.toFixed(2)} vs width ${hs.x.toFixed(2)}`);
  check('...at the fit it asks for', Math.abs(Math.max(hs.x, hs.y, hs.z) - ASSETS.harp.fit) < 0.01,
    `${Math.max(hs.x, hs.y, hs.z).toFixed(2)} vs fit ${ASSETS.harp.fit}`);
  // A model whose art sits off to one side of its own origin would swing round
  // the ring wobbling, because the orbit drives the origin and not the harp.
  const hc = hbox.getCenter(new THREE.Vector3());
  check('...balanced on its own origin', Math.hypot(hc.x, hc.y, hc.z) < 0.2,
    `${Math.hypot(hc.x, hc.y, hc.z).toFixed(3)} off centre`);
  // The file ships one flat white material with UVs and no image. Untinted it
  // is a white blob, and `tint` silently doing nothing is the failure that
  // looks like an art problem.
  let painted = 0;
  let meshes = 0;
  probe.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    if (o.material.color.getHexString() !== 'ffffff') painted++;
  });
  check('the tint reached the material', meshes > 0 && painted === meshes,
    `${painted}/${meshes} painted`);
  scene.remove(probe);
} else {
  console.log('  (harp.glb missing — the harp falls back to its procedural cone)');
}

const harpGroup = createHarpVisual();
scene.add(harpGroup);
resetHarp();

const harpPlayer = { x: 0, y: 0, z: 0 };
let plucks = 0;
let auraTicks = 0;
let auraCaught = 0;
const harpHooks = {
  onPluck: () => { plucks++; },
  onAuraTick: (x, y, count) => { auraTicks++; auraCaught += count; },
};
const tickHarp = (frames, level = 1) => {
  for (let i = 0; i < frames; i++) updateHarp(dt, scene, harpPlayer, level, enemies, harpHooks);
};

// A big one FAR out and a small one CLOSE in. Nearest-target and largest-target
// disagree by 180 degrees here, which is what makes the heading check below a
// real test rather than a coincidence a tighter layout could fake.
const minnow = fakeEnemy(3, 0, 0.3, 9999);
minnow.def.radius = 0.3;
minnow.sizeMul = 1;
const shark = fakeEnemy(-9, 0, 2.2, 9999);
shark.def.radius = 2.2;
shark.sizeMul = 1;
enemies.push(minnow, shark);

check('an unlearned harp is not in the water', (() => {
  tickHarp(240, 0);
  return projectiles.length === 0 && harpGroup.visible === false;
})(), `${projectiles.length} note(s)`);

const harpCfg = CONFIG.harp;
const pluckFrames = Math.ceil((harpCfg.interval + 0.1) / dt);
for (let i = 0; i < pluckFrames && projectiles.length === 0; i++) tickHarp(1);
check('the harp plucks a note', projectiles.length === 1, `${projectiles.length} note(s)`);
check('...and said so', plucks === 1, `${plucks} pluck event(s)`);

const note = projectiles[0];
check('the note is tagged to the harp', note?.source === 'harp', String(note?.source));
check('it seeks', !!note?.homing);
check('it carries a charm payload', !!note?.charm
  && note.charm.duration > 0 && note.charm.auraRadius > 0 && note.charm.auraDamage > 0);

// THE CLAIM. The note left pointing at the shark nine units to the LEFT, not
// at the minnow three units to the right.
check('it was plucked at the biggest enemy, not the nearest',
  note.dir.x < -0.9, `heading x ${note.dir.x.toFixed(2)} (shark is at -9, minnow at +3)`);

// A boss is bigger than everything and cannot be charmed, so spending the aura
// on it buys nothing — the pick has to step down to the largest CHARMABLE body
// while one exists.
resetProjectiles(scene);
resetHarp();
const bossFish = fakeEnemy(-6, 0, 5, 9999);
bossFish.def.radius = 5;
bossFish.sizeMul = 2;
bossFish.isBoss = true;
enemies.push(bossFish);
for (let i = 0; i < pluckFrames && projectiles.length === 0; i++) tickHarp(1);
check('a boss does not soak up the pluck while a charmable body is in range',
  projectiles.length === 1 && projectiles[0].dir.x < -0.9 && projectiles[0].dir.x > -0.999,
  `heading x ${projectiles[0]?.dir.x.toFixed(3)}`);

// ...but a boss alone is still worth playing at: the damage is real even when
// the charm is refused.
resetProjectiles(scene);
resetHarp();
enemies.length = 0;
enemies.push(bossFish);
for (let i = 0; i < pluckFrames && projectiles.length === 0; i++) tickHarp(1);
check('a boss alone is still played at', projectiles.length === 1, `${projectiles.length} note(s)`);

// --- the charm and its ring ------------------------------------------------
const payload = projectiles[0].charm;
// A BOSS TAKES THE DAZE, NOT THE CHARM. Three separate claims in one moment,
// and the ability is broken in a different way if any of them slips: charmed
// would mean a boss fighting for you, an aura would mean a grinder on the one
// body that should never carry one, and nothing at all is the bug this change
// exists to fix.
check('a boss note lands as a daze', applyHarpCharm(bossFish, payload) === true);
check('...it is not charmed and grows no ring',
  !(bossFish.charmTimer > 0) && !(bossFish.harpAura > 0),
  `charm ${bossFish.charmTimer}, aura ${bossFish.harpAura}`);
check('...and the daze is measured in a couple of seconds',
  isDazed(bossFish) && bossFish.dazeTimer <= CONFIG.boss.control.daze.max,
  `${bossFish.dazeTimer.toFixed(2)}s of a ${CONFIG.boss.control.daze.max}s ceiling`);
// THE BUDGET. Everything the roster can throw at it while it is already reeling
// is worth nothing extra — this is the whole "don't let it stack" rule, and it
// is checked from the two directions it can fail: a second source landing NOW,
// and a source landing the moment the timer runs out.
{
  const held = bossFish.dazeTimer;
  applyHarpCharm(bossFish, payload);
  charmEnemy(bossFish, 99);
  holdEnemy(bossFish, 99);
  check('a second status cannot extend a live daze',
    bossFish.dazeTimer <= held, `${bossFish.dazeTimer.toFixed(2)}s vs ${held.toFixed(2)}s`);

  // Run it out, then try again inside the recovery window.
  for (let i = 0; i < 600 && isDazed(bossFish); i++) tickDaze(bossFish, dt);
  check('...and the recovery window refuses the next one outright',
    charmEnemy(bossFish, 99) === false && !isDazed(bossFish),
    `${bossFish.dazeCooldown.toFixed(2)}s of recovery left`);

  // ...and it does come back. A one-shot daze would pass every check above.
  for (let i = 0; i < 1200 && bossFish.dazeCooldown > 0; i++) tickDaze(bossFish, dt);
  check('...but once it is over the boss can be dazed again',
    charmEnemy(bossFish, 3) === true && isDazed(bossFish), `${bossFish.dazeTimer.toFixed(2)}s`);
  clearDaze(bossFish);
}

check('an ordinary body takes both halves', (() => {
  applyHarpCharm(shark, payload);
  return shark.charmTimer > 0 && shark.harpAura > 0;
})(), `charm ${shark.charmTimer}s, aura ${shark.harpAura}s`);
// The two timers are deliberately not the same number — the ring outlives the
// daze, which is the whole overlap the card is built around.
check('the ring outlives the charm', shark.harpAura > shark.charmTimer,
  `aura ${shark.harpAura}s vs charm ${shark.charmTimer}s`);

resetProjectiles(scene);
enemies.length = 0;
const host = fakeEnemy(0, 0, 2.2, 9999);
host.def.radius = 2.2;
const victim = fakeEnemy(host.harpAuraRadius ?? 1.5, 0, 0.4, 9999);
const bystander = fakeEnemy(30, 0, 0.4, 9999);
enemies.push(host, victim, bystander);
applyHarpCharm(host, payload);
// Inside the measured ring, by construction — the picture is drawn on this
// same radius, so a victim placed off it would be testing a different number
// than the one the player can see.
victim.mesh.position.x = host.harpAuraRadius * 0.6;

const victimHpBefore = victim.hp;
const hostHpBefore = host.hp;
tickHarp(Math.ceil((CONFIG.harp.auraTick * 2.5) / dt));
check('the ring hurts what is standing in it', victim.hp < victimHpBefore,
  `${(victimHpBefore - victim.hp).toFixed(1)} damage`);
check('...and never its own host', host.hp === hostHpBefore, `host took ${hostHpBefore - host.hp}`);
check('...and nothing outside it', bystander.hp === 9999, `bystander took ${9999 - bystander.hp}`);
check('the ring reported ticking', auraTicks > 0 && auraCaught > 0,
  `${auraTicks} tick(s), ${auraCaught} caught`);
// The notes are NOT in harpGroup any more — they are instances in one field at
// the scene root (systems/noteStorm.js), because an InstancedMesh carries world
// transforms and cannot hang off a group that moves. Counting the group's
// visible children would now pass forever at 1, which is why this asks the
// field. The glyph geometries were installed above; without them the field
// draws nothing and throws nothing, and this is the check that would catch it.
check('the ring is actually drawn', harpNoteCount() >= CONFIG.harp.auraNotes,
  `${harpNoteCount()} live note(s)`);

// Two charmed bodies side by side must not saw each other apart — that loses
// both grinders in about a second and reads as a bug.
applyHarpCharm(victim, payload);
const pairHp = victim.hp;
tickHarp(Math.ceil((CONFIG.harp.auraTick * 2.5) / dt));
check('two charmed bodies leave each other alone', victim.hp === pairHp,
  `${pairHp - victim.hp} damage between them`);

// And it has to END. An aura that never expires is a permanent grinder from
// one pluck, and the timer is the only thing standing between those.
tickHarp(Math.ceil((payload.auraDuration + 0.5) / dt));
check('the ring wears off', !(host.harpAura > 0), `${host.harpAura}s left`);
check('...and its notes go with it', harpNoteCount() === 0, `${harpNoteCount()} live note(s)`);

// Levelling has to buy something on every axis the card promises.
const h1 = currentHarpStats(1);
const h5 = currentHarpStats(5);
check('levelling plays faster', h5.interval < h1.interval, `${h1.interval.toFixed(2)}s -> ${h5.interval.toFixed(2)}s`);
check('levelling hits harder', h5.damage > h1.damage, `${h1.damage} -> ${h5.damage}`);
check('levelling holds the charm longer', h5.charmDuration > h1.charmDuration,
  `${h1.charmDuration.toFixed(1)}s -> ${h5.charmDuration.toFixed(1)}s`);
check('levelling grows the ring', h5.auraRadius > h1.auraRadius && h5.auraDamage > h1.auraDamage,
  `r ${h1.auraRadius.toFixed(1)} -> ${h5.auraRadius.toFixed(1)}, dmg ${h1.auraDamage} -> ${h5.auraDamage}`);
// The cadence floor is what stops a full stack turning into a continuous
// stream, and it is a max() that is easy to write the wrong way round.
check('the cadence floor holds at the cap', currentHarpStats(99).interval >= CONFIG.harp.intervalFloor,
  `${currentHarpStats(99).interval.toFixed(2)}s vs floor ${CONFIG.harp.intervalFloor}`);

resetProjectiles(scene);
enemies.length = 0;
scene.remove(harpGroup);

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
