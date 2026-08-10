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
import { createBakalarBoat, updateBakalar, resetBakalar, suctionAt, __beamShader } from '../path/src/systems/bakalar.js';
import { fireMusselBarrage, barrageCount, barrageDamage } from '../path/src/systems/musselVolley.js';
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

// --- mussel barrage ---------------------------------------------------------
// The one ability with no update() — it fires once, from the strike release —
// so what matters is the gate and the fan, not what it does over time.
console.log('\nMUSSEL BARRAGE');
resetProjectiles(scene);
enemies.length = 0;

const dash = { x: 1, y: 0 };
const originAt = () => new THREE.Vector3(0, 0, 0);

// THE GATE. This is the whole design — below the threshold a strike is just a
// dash — so it is checked from both sides rather than only the happy path.
const weak = fireMusselBarrage(scene, CONFIG.musselVolley.chargeThreshold - 0.1, 3, dash, originAt);
check('a half-charged strike throws nothing', weak === 0, `${weak} shell(s)`);
const unlearned = fireMusselBarrage(scene, 1, 0, dash, originAt);
check('...and neither does a full charge without the upgrade', unlearned === 0, `${unlearned} shell(s)`);
check('neither put a projectile in the scene', projectiles.length === 0, `${projectiles.length} live`);

const thrown = fireMusselBarrage(scene, 1, 1, dash, originAt);
check('a full charge throws the whole flight at level 1',
  thrown === CONFIG.musselVolley.count, `${thrown} shell(s)`);
check('every shell became a live projectile',
  projectiles.length === thrown, `${projectiles.length} of ${thrown}`);
check('they all seek', projectiles.every((p) => p.homing), `${projectiles.filter((p) => p.homing).length} homing`);

// The fan has to be a FAN. Eight shells that all left on the same heading is
// the failure mode this catches — it looks like one fat missile, and homing
// would hide it within a few frames of launch.
const barrageHeadings = projectiles.map((p) => Math.atan2(p.vy ?? p.dir?.y ?? 0, p.vx ?? p.dir?.x ?? 1));
const barrageSweep = Math.max(...barrageHeadings) - Math.min(...barrageHeadings);
check('the shells leave across a wide arc',
  barrageSweep > CONFIG.musselVolley.arc * 0.6, `${barrageSweep.toFixed(2)} rad of ${CONFIG.musselVolley.arc} configured`);
// Centred on the dash, not offset to one side of it.
const barrageMean = barrageHeadings.reduce((a, b) => a + b, 0) / barrageHeadings.length;
check('the fan is centred on the dash heading', Math.abs(barrageMean) < 0.3, `centre ${barrageMean.toFixed(2)} rad off`);

// Levelling has to buy something visible. Both numbers, because the card
// promises more shells and they are meant to hit harder too.
check('levelling adds shells', barrageCount(3) > barrageCount(1), `${barrageCount(1)} -> ${barrageCount(3)}`);
check('levelling adds damage', barrageDamage(3) > barrageDamage(1), `${barrageDamage(1)} -> ${barrageDamage(3)}`);

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
