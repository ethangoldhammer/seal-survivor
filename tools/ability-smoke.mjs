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
import { installModel } from '../path/src/assets.js';
import { enemies } from '../path/src/entities/enemies.js';
import { boats } from '../path/src/systems/boats.js';
import { createOctoGrabber, updateOctoGrab, resetOctoGrab } from '../path/src/systems/octoGrab.js';
import { updateOrcaPod, resetOrcaPod } from '../path/src/systems/orca.js';
import { burstPearl, updateOyster, resetOyster } from '../path/src/systems/oyster.js';
import { projectiles, spawnProjectile, updateProjectiles, resetProjectiles } from '../path/src/entities/projectiles.js';
import { eelCfg } from '../path/src/systems/eel.js';
import { weatherState } from '../path/src/systems/weather.js';
import { createBakalarBoat, updateBakalar, resetBakalar } from '../path/src/systems/bakalar.js';
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
let popped = 0;
let peakTrap = 0;
for (let i = 0; i < 600; i++) {
  updateOctoGrab(dt, scene, player, 3, enemies, {
    onGrab: () => { grabbed = true; },
    onPop: () => { popped++; },
  });
  peakTrap = Math.max(peakTrap, prey.trapTimer);
}
check('an arm reaches and grabs a fish in range', grabbed);
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

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
