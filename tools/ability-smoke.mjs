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
import { installModel, createVisual, ASSETS, getAssetMaterials } from '../path/src/assets.js';
import { enemies } from '../path/src/entities/enemies.js';
import { boats } from '../path/src/systems/boats.js';
import { createOctoGrabber, updateOctoGrab, resetOctoGrab } from '../path/src/systems/octoGrab.js';
import { updateOrcaPod, resetOrcaPod } from '../path/src/systems/orca.js';
import { burstPearl, updateOyster, resetOyster, currentOysterStats } from '../path/src/systems/oyster.js';
import { projectiles, spawnProjectile, updateProjectiles, resetProjectiles } from '../path/src/entities/projectiles.js';
import { eelCfg } from '../path/src/systems/eel.js';
import { createBelugaDrone, updateBeluga, resetBeluga, trapSeconds } from '../path/src/systems/beluga.js';
import { spawnSeagull, updateSeagulls, resetSeagulls, seagullCount, kickGull } from '../path/src/systems/seagull.js';
import { updateShrimpRing, createShrimpRingVisual, resetShrimpRing } from '../path/src/systems/shrimpRing.js';
import { shrimpRingLevelStats } from '../path/src/levelStats.js';
import { createGarlicVisual, updateGarlic, resetGarlic } from '../path/src/systems/garlic.js';
import { stoke, cool, glowLevel, glowStir, glowHue, rotateHue, damageGlowCfg, attachDamageGlow } from '../path/src/systems/damageGlow.js';
import { weatherState } from '../path/src/systems/weather.js';
import {
  createBakalarBoat, updateBakalar, resetBakalar, suctionAt, netGeometry,
  netAccepts, ensnareSeconds, __beamShader,
} from '../path/src/systems/bakalar.js';
import {
  fireMusselBarrage, updateMusselVolley, resetMusselVolley,
  barrageCount, barrageDamage, barrageShells, chargePips, pendingShells,
} from '../path/src/systems/musselVolley.js';
import { strikeState, pipCount, chainStrike, resetStrike } from '../path/src/systems/strike.js';
import {
  isDazed, dazeReady, canControl, canHold, charmEnemy, holdEnemy, tickDaze, clearDaze, dazeSpeedMul,
} from '../path/src/systems/control.js';
import { createHarpVisual, updateHarp, resetHarp, applyHarpCharm, currentHarpStats, harpNoteCount, harpAuraNotes } from '../path/src/systems/harp.js';
import { installNoteGlyphs } from '../path/src/systems/noteStorm.js';
import { bounds, seabedTopY, updateBounds } from '../path/src/arena.js';
import { SKY_Z } from '../path/src/systems/backdropFit.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

// Straight down, for the sleeping-chain shove below.
const DOWN_TEST = new THREE.Vector3(0, -1, 0);

// THE REAL ARENA, before anything reads it. `bounds` is declared with
// placeholder literals and only becomes the shipped ocean when a window
// resizes, which nothing headless ever does — so left untouched this harness
// runs every ability against a 80-unit arena with a 10-unit ceiling instead of
// the 231-unit one with 31 units of sky that the game is tuned at.
//
// It matters most to the seagull's entrance, which is measured off the top of
// the shot: at the placeholder numbers the jump ceiling and the resting frame
// are the same height, so the case that entrance exists to handle does not
// exist to be tested.
updateBounds(CONFIG.arena.referenceAspect || 16 / 9);

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
// AT THE FULL POD. The card buys one orca per stack now, so a level picked out
// of the air decides how many bodies this check covers — driven at 2 it was
// quietly watching two of the three, and the calf is the one with its own
// scale. The level and the count are the same number by construction (see
// podSize in systems/orca.js), which is what makes this the whole family.
const PODLEVEL = CONFIG.orca.count;
updateOrcaPod(dt, scene, swimmer, PODLEVEL, enemies, {});
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
  updateOrcaPod(dt, scene, swimmer, PODLEVEL, enemies, {});
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

// ...and the same invariant stated as arithmetic rather than left to the dice.
// Under exponential drag a bomblet covers (speed/drag)(1 - e^(-drag*life)), so
// the worst case is the fastest bomblet on the longest fuse. If that ever
// exceeds the blast radius the burst detonates in a RING with a hole where the
// pearl actually landed — and the random-angle check above would still pass
// most of the time, which is the worst way for this to fail.
{
  const o = CONFIG.oyster;
  const travel = (o.bombletSpeed[1] / o.bombletDrag) * (1 - Math.exp(-o.bombletDrag * o.bombletLife[1]));
  check('the blast still covers where the pearl landed', travel < o.bombletBlastRadius,
    `${travel.toFixed(2)} of travel inside a ${o.bombletBlastRadius} blast`);
}

// THE WEAPON'S SHAPE: a bomb, not a shotgun. Long wait, huge payload — and the
// two halves are tuned in different rows of weapons.csv, so nothing but this
// reads them together.
{
  const o = CONFIG.oyster;
  const cap = CONFIG.upgrades.find((u) => u.id === 'oysterBlaster')?.maxStacks ?? 8;
  const at = (lv) => currentOysterStats(lv);
  const burstOf = (v) => v.bomblets * v.bombletDamage;
  const one = at(1);
  const top = at(cap);
  console.log(`     lvl 1: ${one.bomblets} x ${one.bombletDamage} over r${one.blastRadius.toFixed(1)}`
    + ` every ${one.fireRate.toFixed(2)}s  ->  ${((burstOf(one) + one.damage) / one.fireRate).toFixed(0)} dmg/s at the impact point`);
  console.log(`     lvl ${cap}: ${top.bomblets} x ${top.bombletDamage} over r${top.blastRadius.toFixed(1)}`
    + ` every ${top.fireRate.toFixed(2)}s  ->  ${((burstOf(top) + top.damage) / top.fireRate).toFixed(0)} dmg/s at the impact point`);
  check('the wait is long enough to be a wait', one.fireRate > 1.5, `${one.fireRate.toFixed(2)}s`);
  // A bomb you can hold the trigger on is a shotgun with a bigger flash.
  check('...and never becomes a stream', top.fireRate >= 1,
    `${top.fireRate.toFixed(2)}s at the cap, floor ${o.fireRateFloor}`);
  // The payload is the burst. If the pearl's own impact ever gets close to it,
  // the card has quietly turned back into a slow bullet.
  check('the burst is the payload, not the impact', burstOf(one) > one.damage * 5,
    `${burstOf(one)} from the burst against ${one.damage} on impact`);
  check('the blast is wide enough to be an explosion', one.blastRadius > 4,
    `r ${one.blastRadius.toFixed(1)}`);
  check('levelling grows the blast and what it hits for',
    top.blastRadius > one.blastRadius * 1.3 && top.bombletDamage > one.bombletDamage * 1.5,
    `r ${one.blastRadius.toFixed(1)} -> ${top.blastRadius.toFixed(1)}, ${one.bombletDamage} -> ${top.bombletDamage}`);
  // THE PICTURE HAS TO FOLLOW THE REACH. main.js draws the flash at
  // radius / blastFxUnit, capped — so a cap below the base ratio means even an
  // unlevelled blast is drawn smaller than the water it damages, which is the
  // exact bug a hardcoded divisor left behind when the radius moved.
  check('the flash is sized off a named unit', o.blastFxUnit > 0, `${o.blastFxUnit}`);
  check('...and its cap does not clip the base blast',
    (o.blastFxMax ?? 0) >= one.blastRadius / o.blastFxUnit,
    `cap ${o.blastFxMax} against ${(one.blastRadius / o.blastFxUnit).toFixed(2)} wanted at level 1`);
}

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

// WHAT THE BLAST LEAVES IN THE WATER — the same mass every other explosion in
// the game leaves, rather than a look of its own.
//
// Checked by NAME because the failure is silent at both ends. An event whose
// `goo` points at nothing simply fires no second burst; an emitter whose group
// is not in CONFIG.fx.goo.groups falls back to a SPRITE burst (see the warn in
// entities/particles.js), which draws loose dots where a fused mass should be
// and reads as a tuning problem rather than as a typo.
{
  const ev = CONFIG.feedback.bakalarBombBlast;
  const em = CONFIG.emitters[ev?.goo];
  check('the bomb blast leaves goo, not only spray', !!ev?.goo, ev?.goo ?? 'none');
  check('...whose emitter exists', !!em, ev?.goo);
  check('...and it is the shared boom surface, not a private one',
    !!em?.goo && !!CONFIG.fx?.goo?.groups?.[em.goo], `group "${em?.goo}"`);
  // The one that says SHARED rather than "a copy with a shared-sounding name":
  // something else in the game has to be firing the same emitter.
  const alsoUses = Object.entries(CONFIG.feedback)
    .filter(([k, v]) => k !== 'bakalarBombBlast' && v?.goo === ev?.goo).map(([k]) => k);
  check('...and something else fires it too', alsoUses.length > 0, alsoUses.join(', '));
}

// THE ARMING BLINK, and the reason it is checked here rather than looked at.
//
// It used to be written straight onto b.mesh.material.color, which is a field
// that exists only while the bomb is the procedural sphere it shipped as:
// createVisual returns a Mesh for a primitive and a GROUP for an uploaded
// model, and a Group has no `.material`. Guarded as it was, an uploaded toon
// bomb simply stopped blinking — no error, and the one tell that says the
// thing is about to go off gone with it.
//
// Two halves, and the second is the one that bites. The blink writes a SHARED
// material (every clone of an asset shares the template's), so a bomb that
// detonates mid-flash leaves the colour stuck for every bomb after it and for
// anything else wearing that material.
{
  const mats = getAssetMaterials('voicemailBomb').filter((m) => m?.color);
  check('the bomb has a material the blink can reach', mats.length > 0,
    `${mats.length} material(s)`);
  const rest = mats.map((m) => m.color.getHex());

  // Restock: the run above hauled and blew up the whole school, and a boat
  // sailing through empty water never drops a bomb at all (bomb.minCatch), so
  // without this the loop below simply times out and reports "no blink" for a
  // blink that works.
  enemies.length = 0;
  for (let i = 0; i < 8; i++) enemies.push(fakeEnemy(-20 + i * 5, bounds.surfaceY - 3, 0.5, 2000));

  // Run until something is armed, then look.
  let sawBlink = false;
  for (let i = 0; i < 60 * 120 && !sawBlink; i++) {
    updateBakalar(dt, scene, 3, enemies, { onHauled: () => {}, onChum: () => {}, onEnemyDamaged: () => {}, onEnemyKilled: () => {} });
    if (mats.some((m, k) => m.color.getHex() !== rest[k])) sawBlink = true;
  }
  check('an armed bomb actually blinks', sawBlink);

  resetBakalar(scene);
  check('...and the shared material is put back when nothing is armed',
    mats.every((m, k) => m.color.getHex() === rest[k]),
    mats.map((m) => '#' + m.color.getHexString()).join(' '));
}

// --- what the net will and will not take ------------------------------------
// The net used to take everything that was not a boss. It is a curve now:
// resistance goes as the square of a creature's radius against the net's
// power, with two hard refusals above it (scenery, and anything whale-sized).
//
// Every check here is a RATIO or a REFUSAL rather than "did it catch
// something", because the failure mode this replaced passes that test
// perfectly — a net that takes everything catches the sardine too.
section('BAKALAR — WHAT THE NET TAKES');
{
  const c = CONFIG.bakalar.catch;
  const bombWas = CONFIG.bakalar.bomb.enabled;
  CONFIG.bakalar.bomb.enabled = false; // the blast is a different question

  // How long one sailing takes to haul a creature of this radius out, or null
  // if it never does. Run per creature so nothing competes for the net.
  function secondsToHaul(radius, level, { invincible = false, isBoss = false } = {}, limit = 240) {
    resetBakalar(scene);
    enemies.length = 0;
    const e = fakeEnemy(0, bounds.surfaceY - 3, radius, 1e6);
    e.invincible = invincible;
    e.isBoss = isBoss;
    enemies.push(e);
    let hauled = null;
    for (let i = 0; i < 60 * limit && hauled === null; i++) {
      // Re-seated every frame: a fish that is not caught still gets shoved by
      // nothing here, but a HAULED one is dragged, and the point of the clock
      // is when it was taken rather than how fast it rose.
      updateBakalar(dt, scene, level, enemies, { onHauled: () => { hauled = i * dt; } });
    }
    return hauled;
  }

  // THE TWO REFUSALS. Long runs, because "it did not happen in one pass" is
  // not the claim — the claim is that it never happens.
  check('a turtle is never netted, however long the boat sails',
    secondsToHaul(1, 8, { invincible: true }) === null,
    'invincible scenery, and the haul is the one remover that deals no damage');
  check('nothing whale-sized is netted either',
    secondsToHaul(c.maxPrey + 0.5, 8) === null,
    `radius ${(c.maxPrey + 0.5).toFixed(1)} against a ceiling of ${c.maxPrey}`);
  check('...and a boss still is not', secondsToHaul(1, 8, { isBoss: true }) === null);
  // The ceiling has to sit ABOVE the biggest ordinary body or it is a boss
  // rule wearing a size rule's clothes.
  check('the ceiling still clears the biggest ordinary creature',
    c.maxPrey > 2.2, `maxPrey ${c.maxPrey} vs the megalodon's 2.2`);

  // THE CURVE, read off the mechanic rather than off a stopwatch.
  //
  // The first version of this timed two full hauls and compared them, and it
  // was measuring the wrong thing entirely: a sailing is 14-22 seconds of
  // SPAWN WAIT rolled at random plus a sweep up to the hull, and both dwarf
  // the fraction of a second the grip actually takes. It reported 21s against
  // 17s for fish half a size apart and called the curve inverted.
  const grip = (r, level) => ensnareSeconds({ radius: r }, level);
  const ratio = grip(0.8, 8) / grip(0.4, 8);
  check('resistance goes as the square of the radius, exactly',
    Math.abs(ratio - 2 ** c.massExponent) < 1e-6,
    `doubling the radius is ${ratio.toFixed(2)}x the work, want ${(2 ** c.massExponent).toFixed(2)}x`);
  check('...so a sardine is ensnared on contact and a shark is not',
    grip(0.4, 1) < 0.25 && grip(c.refPrey, 1) > 1,
    `${grip(0.4, 1).toFixed(2)}s at r 0.4 vs ${grip(c.refPrey, 1).toFixed(2)}s at r ${c.refPrey}`);

  // A SHARK HAS TO GET AWAY AT ONE STACK, or the curve is decoration. The
  // number that decides it is not the grip alone: it is the grip against how
  // long the mouth takes to pass over a fish, which is the hull's width over
  // the sailing speed. Asserted against that rather than against a constant,
  // so retuning either one cannot quietly make the boat an apex-catcher.
  const dwell = netGeometry(1).halfWidth * 2 / CONFIG.bakalar.speed;
  check('a shark out-lasts the mouth at one stack', grip(c.refPrey, 1) > dwell,
    `${grip(c.refPrey, 1).toFixed(2)}s of grip against ${dwell.toFixed(2)}s of sweep`);
  check('...and does not at a full stack', grip(c.refPrey, 8) < dwell,
    `${grip(c.refPrey, 8).toFixed(2)}s of grip against ${dwell.toFixed(2)}s of sweep`);

  check('the two refusals are refusals, not very large numbers',
    ensnareSeconds({ radius: 1, invincible: true }, 8) === Infinity
    && ensnareSeconds({ radius: c.maxPrey + 0.5 }, 8) === Infinity);

  // LEVELLING IS POWER, end to end.
  const atOne = secondsToHaul(c.refPrey, 1, {}, 90);
  const atEight = secondsToHaul(c.refPrey, 8, {}, 90);
  check('a full stack takes the calibration fish faster than a fresh one',
    atEight !== null && (atOne === null || atEight < atOne),
    `${atOne === null ? 'never' : atOne.toFixed(1) + 's'} at one stack, ${atEight === null ? 'never' : atEight.toFixed(1) + 's'} at eight`);

  // ...AND A SCHOOL IS STILL SWEPT UP. The whole point of the ability. If the
  // curve made small fish anything other than trivial it has been mistuned
  // into a boss-catcher.
  resetBakalar(scene);
  enemies.length = 0;
  for (let i = 0; i < 10; i++) enemies.push(fakeEnemy(-4 + i * 0.9, bounds.surfaceY - 3, 0.4, 1e6));
  let swept = 0;
  for (let i = 0; i < 60 * 120 && swept < 10; i++) {
    updateBakalar(dt, scene, 1, enemies, { onHauled: () => { swept++; } });
  }
  check('a school is still swept up whole at one stack', swept === 10, `${swept} of 10`);

  CONFIG.bakalar.bomb.enabled = bombWas;
  resetBakalar(scene);
  enemies.length = 0;
}

// --- the net is the boat's width --------------------------------------------
section('BAKALAR — THE NET IS THE BOAT');
{
  // Levelling buys DEPTH and nothing else. It used to buy width too, and by
  // eight stacks the mouth was 16.8 units against a 9-unit hull — a net nearly
  // twice the width of the thing towing it.
  const one = netGeometry(1);
  const eight = netGeometry(8);
  check('the mouth does not widen with the stack',
    Math.abs(one.halfWidth - eight.halfWidth) < 1e-6,
    `${(one.halfWidth * 2).toFixed(2)} wide at both`);
  check('...but it does get deeper', eight.depth > one.depth * 1.4,
    `${one.depth.toFixed(1)} -> ${eight.depth.toFixed(1)}`);
  // ...and stops at the seabed. Depth is the growth axis now and the ocean is
  // finite: without the clamp one retune of netDepthPerLevel drags the twine
  // through the floor, and twine inside the seabed looks like a z-fighting
  // glitch rather than like a number that needs changing.
  const floor = bounds.surfaceY - seabedTopY();
  check('the net never reaches through the seabed', eight.depth <= floor,
    `${eight.depth.toFixed(1)} deep in a ${floor.toFixed(1)}-unit water column`);
  // Against the HULL, measured off the built boat rather than off the asset
  // entry — in this harness that is the procedural fallback, which is the
  // point: the rule holds whatever the boat currently is.
  const hull = new THREE.Box3().setFromObject(createVisual('bakalarBoat'));
  const hullW = hull.getSize(new THREE.Vector3()).x;
  check('the net is never wider than the boat towing it',
    eight.halfWidth * 2 <= hullW + 1e-6,
    `net ${(eight.halfWidth * 2).toFixed(2)} vs hull ${hullW.toFixed(2)}`);
}

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
  // Asked for rather than re-derived: the net's mouth is the hull's MEASURED
  // width now, so a harness that multiplied a config number would be placing
  // its rim fish against a net that no longer exists.
  const wide = netGeometry(1).halfWidth;
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
// UNDERWATER, and mutable. The surface is y=0 and bubbles are clamped under it
// now, so a section run at the water line would be measuring a set of bubbles
// pressed flat against the ceiling — the rise, the wander and the whole flight
// model die there. Every fish below sits at this depth for the same reason.
// It moves, too: the seal breathing a bubble is tested by walking this into
// one, and the breach gate by lifting it out of the water.
const belugaPlayer = { x: 0, y: -12 };
resetBeluga(scene, belugaPlayer);

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
    updateBeluga(dt, scene, belugaPlayer, 1, enemies, belugaClock, belugaHooks);
    belugaClock += dt;
  }
};
const bubbleMeshes = () => scene.children.filter((o) => o.name === 'trapBubble');

// --- the lob ---------------------------------------------------------------
// A target far enough out that nothing is caught: this half is about how the
// shot MOVES, and a catch would end the flight early.
const decoy = fakeEnemy(40, belugaPlayer.y, 0.5, 9999);
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
resetBeluga(scene, belugaPlayer);
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
resetBeluga(scene, belugaPlayer);
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
resetBeluga(scene, belugaPlayer);
traps = 0;
pops = 0;
belugaHooks.onPop = (x, y) => { pops++; popAt = { x, y }; };

// Right on top of the drone's orbit, so a bomblet reaches it.
const caught = fakeEnemy(CONFIG.beluga.orbitRadius, belugaPlayer.y, 0.5, 9999);
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
resetBeluga(scene, belugaPlayer);
traps = 0;
pops = 0;
const doomed = fakeEnemy(CONFIG.beluga.orbitRadius, belugaPlayer.y, 0.5, 9999);
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
resetBeluga(scene, belugaPlayer);
traps = 0;
pops = 0;
const crowd = [];
for (let i = 0; i < 6; i++) crowd.push(fakeEnemy(CONFIG.beluga.orbitRadius, belugaPlayer.y + i * 0.2, 0.2, 9999));
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

// --- A BUBBLE IS AIR --------------------------------------------------------
// The seal can swim into its own drone's bubbles and breathe them. Every part
// of this fails silently: a bubble that arms too early is eaten on the frame it
// is fired (the drone orbits two units off the seal, so that is most of them),
// one that never arms is a pickup that cannot be picked up, and a breath paid
// at the cluster's rate for a bomblet is a number nobody can see is wrong.
enemies.length = 0;
resetBeluga(scene, belugaPlayer);
belugaPlayer.x = 0;
belugaPlayer.y = -12;
let breaths = 0;
let lastAir = 0;
let refuse = false;
belugaHooks.onTrap = () => { traps++; };
belugaHooks.onPop = () => { pops++; };
belugaHooks.onBreath = (x, y, air) => { breaths++; lastAir = air; return !refuse; };
// Far enough out that nothing is caught and the cluster is still in the air.
enemies.push(fakeEnemy(40, belugaPlayer.y, 0.5, 9999));
for (let i = 0; i < fireFrames && bubbleMeshes().length === 0; i++) tickBeluga(1);
const lob = bubbleMeshes()[0];
// ARMING. It leaves from the drone, which starts ON the seal after a reset and
// orbits two units off it in play — so it must NOT be breathed on the way out,
// and the check for that is that it is still in the water after the third of a
// second it spends clearing the seal. Well inside its own split fuse.
tickBeluga(20);
check('a bubble is not swallowed on the frame it is fired', breaths === 0,
  `${breaths} breath(s) before it was clear`);

// ...and once it IS clear, swimming into it takes the air out of it.
const lobRadius = 0.35 * lob.scale.x;
refuse = true; // asked but not taken: a full tank leaves the bubble alone
belugaPlayer.x = lob.position.x;
belugaPlayer.y = lob.position.y;
tickBeluga(1);
check('a full seal is offered the breath', breaths === 1, `${breaths} offer(s)`);
check('...and refusing leaves the bubble in the water', lob.parent !== null);
refuse = false;
tickBeluga(1);
check('swimming into it takes the breath', breaths === 2, `${breaths} breath(s)`);
check('...and the bubble is gone with it', lob.parent === null);
check('a whole cluster pays a whole lungful',
  Math.abs(lastAir - CONFIG.beluga.airRefill) < 0.01,
  `${lastAir.toFixed(2)} of ${CONFIG.beluga.airRefill}`);

// A BOMBLET PAYS ITS SHARE, by size. Paid flat instead, a cluster that split
// into five would be five whole breaths in the water.
enemies.length = 0;
resetBeluga(scene, belugaPlayer);
belugaPlayer.x = 0;
belugaPlayer.y = -12;
breaths = 0;
splits = 0;
enemies.push(fakeEnemy(40, belugaPlayer.y, 0.5, 9999));
for (let i = 0; i < fireFrames && bubbleMeshes().length === 0; i++) tickBeluga(1);
for (let i = 0; i < Math.ceil(bg.splitDelay * (1 + bg.splitVary) / dt) + 2 && splits === 0; i++) tickBeluga(1);
const shard = bubbleMeshes()[0];
tickBeluga(4); // let them clear the seal
belugaPlayer.x = shard.position.x;
belugaPlayer.y = shard.position.y;
tickBeluga(1);
check('a bomblet pays its share of one', breaths > 0
  && Math.abs(lastAir - CONFIG.beluga.airRefill * bg.bombletScale) < CONFIG.beluga.airRefill * 0.05,
  `${lastAir.toFixed(2)} of ${(CONFIG.beluga.airRefill * bg.bombletScale).toFixed(2)}`);

// --- THE WATER LINE ---------------------------------------------------------
// Bubbles are buoyant and the sea has a ceiling. Left alone they climb out of
// it and drift up the sky, where nothing can be caught by them and nothing can
// breathe them — and it is the one failure here that a screenshot would have
// caught, if a screenshot of this were possible.
enemies.length = 0;
resetBeluga(scene, belugaPlayer);
belugaPlayer.x = 0;
belugaPlayer.y = bounds.surfaceY - 1;
breaths = 0;
belugaHooks.onBreath = () => false; // the seal is in the way; leave them in the water
enemies.push(fakeEnemy(6, bounds.surfaceY - 1, 0.5, 9999));
let highest = -Infinity;
for (let i = 0; i < Math.ceil((bg.fireRate + bg.life + 1) / dt); i++) {
  tickBeluga(1);
  for (const m of bubbleMeshes()) highest = Math.max(highest, m.position.y);
}
check('no bubble ever leaves the water', highest <= bounds.surfaceY,
  `highest ${highest.toFixed(2)} against a surface at ${bounds.surfaceY}`);

// --- BREACHED ---------------------------------------------------------------
// Firing while the seal is in the air throws a cluster that spawns above the
// line and spends its whole fuse pressed flat against the underside of the
// surface. So the drone holds the shot — and holds it at zero, so the one you
// were owed lands the frame you splash back in rather than starting over.
enemies.length = 0;
resetBeluga(scene, belugaPlayer);
belugaPlayer.x = 0;
belugaPlayer.y = bounds.surfaceY + 3;
enemies.push(fakeEnemy(6, bounds.surfaceY - 1, 0.5, 9999));
tickBeluga(Math.ceil((bg.fireRate * 2 + 0.2) / dt));
check('a breached seal fires nothing', bubbleMeshes().length === 0,
  `${bubbleMeshes().length} bubble(s) thrown from the air`);
belugaPlayer.y = bounds.surfaceY - 4;
tickBeluga(2);
check('...and the held shot lands on the way back in', bubbleMeshes().length === 1,
  `${bubbleMeshes().length} bubble(s)`);
check('...below the water line, on the frame it is born',
  bubbleMeshes().every((m) => m.position.y <= bounds.surfaceY),
  bubbleMeshes().map((m) => m.position.y.toFixed(2)).join(', '));
belugaHooks.onBreath = null;

enemies.length = 0;
resetBeluga(scene, belugaPlayer);
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
const tickHarp = (frames, level = 1, count = 1) => {
  for (let i = 0; i < frames; i++) updateHarp(dt, scene, harpPlayer, level, enemies, harpHooks, count);
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
// A BOSS IS NEVER CHARMED. Charmed would mean a boss fighting for you, and an
// aura would mean a grinder on the one body that should never carry one —
// those two claims are permanent and are the two below.
//
// WHAT THE REFUSAL BECOMES has changed under this check. A hold on a boss used
// to convert into a daze and report true, so the caller could spend its
// charge; `CONFIG.boss.control.holdsDaze` ships false now, because a perfect
// strike into a lit weak spot should be the only thing in the game that stops
// a boss — see the note over that key and npm run test:bossthreat.
//
// So both branches are checked, and the daze one runs with the door held open,
// because the mechanism is still there and still tuned behind it. A harness
// that only tested whichever way the boolean happens to point would go quiet
// about half of what this ability can do.
check('a boss note is refused in the shipped game — a charm does not stop a boss',
  CONFIG.boss.control.holdsDaze === false && applyHarpCharm(bossFish, payload) === false);
const harpHoldsDaze = CONFIG.boss.control.holdsDaze;
CONFIG.boss.control.holdsDaze = true;
check('a boss note lands as a daze with the daze door open', applyHarpCharm(bossFish, payload) === true);
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
// ...and the door is shut again, so nothing below measures a game that ships
// with the daze reachable.
CONFIG.boss.control.holdsDaze = harpHoldsDaze;

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

// --- the ring going hot ----------------------------------------------------
// All three channels of the shared envelope, on the one aura that carries them
// as an ORBIT rather than as a noise field. Read off the instance buffers,
// because that is the only place this ability's picture exists: every note
// shares one material, so a check on a material would be checking the whole
// field at once and would pass whatever the ring was doing.
{
  // The host sits at the origin and never moves, so its centre is a constant
  // rather than something read back per frame from a body the ring might have
  // outlived.
  const hostX = 0;
  const hostY = 0;
  // ITS OWN HOST AND ITS OWN VICTIM, built after the ring above has expired.
  // Sharing them would mean this block's two seconds of grinding came out of
  // the aura duration the checks above are measuring, and one of the two would
  // fail on a number the other spent.
  enemies.length = 0;
  const ringHost = fakeEnemy(hostX, hostY, 2.2, 9999);
  ringHost.def.radius = 2.2;
  const ringVictim = fakeEnemy(30, 0, 0.4, 9999);
  enemies.push(ringHost, ringVictim);
  applyHarpCharm(ringHost, payload);
  // A FRAME FIRST, then take hold of ONE note on this host's ring and follow
  // that one. Not an instance slot: every note in the game shares one pool and
  // the pool swap-removes, so slot 0 is a different note from frame to frame —
  // half the samples would be a burst note drifting away, which reads as the
  // ring having stopped.
  tickHarp(1);
  const tracked = harpAuraNotes(ringHost)[0];
  // Its world position, as the angle it sits at around its host — which is what
  // "the ring turned" actually means. The position is the one the pool draws
  // from (proxy transforms are world), so this is the picture and not a number
  // beside it.
  const angleAt = () => Math.atan2(
    tracked.mesh.position.y - hostY, tracked.mesh.position.x - hostX,
  );
  // ...and the instance colour at ITS slot, for the same reason. MATCHED ON
  // GEOMETRY, because the pool keys its groups by geometry and the note field
  // ships EIGHT glyphs — so there are up to eight `notes:` InstancedMeshes in
  // the scene at once, and taking whichever one the traversal happened to reach
  // last reads a different note's colour while looking exactly like this one's.
  let field = null;
  scene.traverse((o) => {
    if (o.isInstancedMesh && o.geometry === tracked?.mesh.geometry) field = o;
  });
  // Shortest way round, so a note crossing the -pi seam doesn't read as most of
  // a turn backwards — which at this spin rate happens every second or so.
  const step = (a, b) => {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d);
  };
  const rgbAt = () => {
    const c = field.instanceColor.array;
    const i = tracked.mesh.userData.__poolSlot * 3;
    return { r: c[i], g: c[i + 1], b: c[i + 2] };
  };

  check('the note field is on the scene as instances', !!field?.instanceColor);
  check('...with a note of this host\'s ring to follow', !!tracked);

  if (field?.instanceColor && tracked) {
    // COLD FIRST, with the victim well out of reach. The ring has to already be
    // turning before any of this means anything.
    const coldA = angleAt();
    tickHarp(1);
    const coldStep = step(coldA, angleAt());
    const coldRgb = rgbAt();
    check('a cold ring is already turning', coldStep > 1e-5,
      `${coldStep.toFixed(5)} rad/frame`);

    // ...then bring the victim into the ring and let it grind.
    ringVictim.mesh.position.x = ringHost.harpAuraRadius * 0.6;
    tickHarp(Math.ceil((CONFIG.harp.auraTick * 2.2) / dt));
    const hotBefore = angleAt();
    tickHarp(1);
    const hotStep = step(hotBefore, angleAt());
    const hotRgb = rgbAt();

    check('...and a grinding one turns faster', hotStep > coldStep * 1.05,
      `${coldStep.toFixed(5)} -> ${hotStep.toFixed(5)} rad/frame`);
    check('...brighter', hotRgb.r + hotRgb.g + hotRgb.b > (coldRgb.r + coldRgb.g + coldRgb.b) * 1.1,
      `${(coldRgb.r + coldRgb.g + coldRgb.b).toFixed(2)} -> ${(hotRgb.r + hotRgb.g + hotRgb.b).toFixed(2)}`);
    // Warmer, not merely different. Every colour a note can be rolled as sits
    // between amber and cyan (NOTE_HUES), so warming is one direction for all
    // of them and red climbing against green is the reading — whichever hue
    // this particular host happened to draw.
    //
    // MEASURED AS A HUE ROTATION, in degrees, because that is what heat
    // actually does: `CONFIG.abilityHeat.harp.hue` is -22, a luma-preserving
    // turn of the wheel, and a turn of the wheel is the same size wherever on
    // the arc the note was rolled.
    //
    // r/g was the reading here until a ship run failed at 0.081 -> 0.089. The
    // hue is ROLLED per host across NOTE_HUES (amber 0.08 to cyan 0.50) and
    // r/g is not on one scale across that arc: an amber note sits near 1 and a
    // cyan one near 0.08, so an absolute `+ 0.01` asked a cyan note to warm by
    // an eighth and an amber one by a hundredth. Rewriting it as a FACTOR did
    // not fix it either — over 25 rolls the worst cyan note came out at x1.02,
    // because r/g compresses toward the cyan end no matter how it is compared.
    // The degrees do not compress, and the direction is the whole claim.
    const hueDeg = (c) => {
      const max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b);
      const d = max - min;
      if (d < 1e-9) return 0;
      let h;
      if (max === c.r) h = ((c.g - c.b) / d) % 6;
      else if (max === c.g) h = (c.b - c.r) / d + 2;
      else h = (c.r - c.g) / d + 4;
      return ((h * 60) % 360 + 360) % 360;
    };
    const signedTurn = (a, b) => {
      let d = b - a;
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      return d;
    };
    const turn = signedTurn(hueDeg(coldRgb), hueDeg(hotRgb));
    const want = CONFIG.abilityHeat?.harp?.hue ?? -22;
    check('...and warmer, not merely different',
      Math.sign(turn) === Math.sign(want) && Math.abs(turn) > Math.abs(want) * 0.25,
      `${hueDeg(coldRgb).toFixed(1)} -> ${hueDeg(hotRgb).toFixed(1)} deg (${turn.toFixed(1)} of a wanted ${want})`);

    // THE ONE THAT FAILS SILENTLY. The orbit phase is integrated rather than
    // recomputed as spin x elapsed, and the difference only shows the instant
    // the rate MOVES: recomputed, a ring told to spin 2.1x faster four seconds
    // in jumps to where it would have been if it had always been spinning that
    // fast — four seconds of travel, on the one frame the player was meant to
    // look at it. A still frame of either looks perfect.
    let worst = 0;
    let prev = angleAt();
    for (let i = 0; i < 60; i++) {
      tickHarp(1);
      const a = angleAt();
      worst = Math.max(worst, step(prev, a));
      prev = a;
    }
    check('...and it speeds up from where it is rather than jumping',
      worst < hotStep * 3,
      `worst frame ${worst.toFixed(5)} against a hot step of ${hotStep.toFixed(5)}`);

    // And all of it hands back. A ring stuck hot is the same failure as one
    // that never went hot, arriving from the other side.
    enemies.length = 0;
    enemies.push(ringHost);
    tickHarp(Math.ceil((damageGlowCfg('harp').fade + 0.2) / dt));
    check('...with the ring still alive to be read',
      ringHost.harpAura > 0, `${(ringHost.harpAura ?? 0).toFixed(2)}s left`);
    const backRgb = rgbAt();
    check('...then cools all the way back to its own colour',
      Math.abs(backRgb.r - coldRgb.r) < 0.01 && Math.abs(backRgb.g - coldRgb.g) < 0.01,
      `${coldRgb.r.toFixed(3)} vs ${backRgb.r.toFixed(3)} on red`);
  }
  resetHarp();
  enemies.length = 0;
}

// --- ENTOURAGE: a ring of harps, not one -----------------------------------
//
// The harp used to be a module singleton — one mesh, one timer — so this is
// the section that has to prove the ring is real rather than one instrument
// drawn several times.
{
  const harpGroup = createHarpVisual();
  scene.add(harpGroup);
  resetHarp();
  enemies.length = 0;
  projectiles.length = 0;

  const built = (n) => {
    resetHarp();
    for (let i = 0; i < 4; i++) updateHarp(dt, scene, harpPlayer, 1, enemies, {}, n);
    return harpGroup.children.length;
  };
  check('Entourage puts more harps on the ring', built(3) === 3, `${built(3)} instrument(s)`);
  check('...and one is still the default', built(1) === 1, `${built(1)} instrument(s)`);

  // SPREAD, not stacked. A ring of three sitting at one point is the bug this
  // is here for, and it looks exactly like one harp until you measure.
  resetHarp();
  for (let i = 0; i < 4; i++) updateHarp(dt, scene, harpPlayer, 1, enemies, {}, 3);
  const spots = harpGroup.children.map((m) => m.position.clone());
  let closest = Infinity;
  for (let a = 0; a < spots.length; a++) {
    for (let b = a + 1; b < spots.length; b++) closest = Math.min(closest, spots[a].distanceTo(spots[b]));
  }
  check('...spaced around it rather than stacked', closest > 0.5,
    `closest pair ${closest.toFixed(2)}u apart`);

  // THEY PLAY SEPARATELY. Each instrument owns its timer, so three harps pluck
  // three notes in the time one plucks one — the whole point of the card. And
  // the timers are STAGGERED at build: three harps started at zero would fire
  // in unison forever, which is one loud note rather than a run of them.
  const notesIn = (n, seconds) => {
    resetHarp();
    enemies.length = 0;
    projectiles.length = 0;
    const target = fakeEnemy(2.5, 0, 0.6, 999999);
    target.def.radius = 0.6;
    target.sizeMul = 1;
    enemies.push(target);
    let plucked = 0;
    for (let i = 0; i < Math.ceil(seconds / dt); i++) {
      // The aura is cleared each frame so pickTarget keeps finding it — this
      // measures how often the RING plays, not how long a ring lasts.
      target.harpAura = 0;
      target.hp = 999999;
      updateHarp(dt, scene, harpPlayer, 1, enemies, { onPluck: () => { plucked++; } }, n);
    }
    return plucked;
  };
  const one = notesIn(1, 4);
  const three = notesIn(3, 4);
  check('three harps play about three times as often', three > one * 2,
    `${one} note(s) from one, ${three} from three`);

  // ...and the notes leave the instrument that played them. Every note leaving
  // one point is what a ring of decorative harps around one real one looks
  // like, and it is invisible in a still.
  resetHarp();
  enemies.length = 0;
  projectiles.length = 0;
  const mark = fakeEnemy(3, 0, 0.6, 999999);
  mark.def.radius = 0.6;
  mark.sizeMul = 1;
  enemies.push(mark);
  const origins = [];
  for (let i = 0; i < Math.ceil(3 / dt); i++) {
    mark.harpAura = 0;
    mark.hp = 999999;
    updateHarp(dt, scene, harpPlayer, 1, enemies, { onPluck: (x, y) => origins.push({ x, y }) }, 3);
  }
  let spread = 0;
  for (let a = 0; a < origins.length; a++) {
    for (let b = a + 1; b < origins.length; b++) {
      spread = Math.max(spread, Math.hypot(origins[a].x - origins[b].x, origins[a].y - origins[b].y));
    }
  }
  check('...and each note leaves the harp that played it',
    origins.length > 2 && spread > 0.5,
    `${origins.length} note(s), ${spread.toFixed(2)}u apart at the widest`);

  resetHarp();
  scene.remove(harpGroup);
  enemies.length = 0;
  projectiles.length = 0;
}

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

// --- SEAGULL BOMB ----------------------------------------------------------
// A gull used to need crabs. `spawnSeagull` returned null when the seabed was
// clear, so a card you had bought and levelled did nothing at all through an
// open-water fight — and did it silently, because the cooldown quietly retried
// forever and there was never an error or a bird to see.
//
// The three things that have to stay true together: crabs are still the FIRST
// choice, anything else is better than nothing, and the prey rule travels with
// the target — a crab run that detonated on the first fish drifting over the
// pile would be a worse ability than the one this replaced.
section('SEAGULL BOMB');
enemies.length = 0;
resetSeagulls(scene);

const crabAt = (x, y) => {
  const e = fakeEnemy(x, y, 0.5, 9999);
  e.def.behavior = 'crawl';
  e.type = 'crab';
  return e;
};

// NOTHING ON THE SEABED. This is the whole bug: fish in open water, no crabs.
for (let i = 0; i < 4; i++) enemies.push(fakeEnemy(6 + i * 0.8, bounds.surfaceY - 8, 0.5, 9999));
const openWater = spawnSeagull(scene, enemies);
check('a gull launches with no crabs in the water', !!openWater,
  openWater ? 'launched' : 'no run');
check('...aimed at the knot of fish',
  !!openWater && Math.abs(openWater.target.x - 7.2) < 2,
  openWater ? `x ${openWater.target.x.toFixed(1)} of ~7.2` : 'no run');
check('...and allowed to hit what it was aimed at', openWater?.anyPrey === true);

// ...and it actually connects. Dropped on top of the school rather than flown
// in, so this is a check about the impact test and not about the approach.
resetSeagulls(scene);
enemies.length = 0;
const school = [];
for (let i = 0; i < 3; i++) school.push(fakeEnemy(i * 0.6, bounds.surfaceY - 8, 0.5, 40));
enemies.push(...school);
const diver = spawnSeagull(scene, enemies);
diver.phase = 'dive';
diver.container.position.set(school[0].mesh.position.x, school[0].mesh.position.y + 1.2, 0);
diver.vx = 0;
diver.vy = -CONFIG.seagullBomb.diveSpeedMax;
let gullBlast = 0;
for (let i = 0; i < 30 && seagullCount() > 0; i++) {
  updateSeagulls(dt, scene, enemies, { onImpact: () => { gullBlast++; } });
}
check('a fallback run detonates on the fish it dived at', gullBlast === 1,
  `${gullBlast} blast(s)`);

// CRABS STILL WIN. One crab against a whole school: the seabed layer is what
// this card is for and a wall of sardines must not outvote it.
resetSeagulls(scene);
enemies.length = 0;
for (let i = 0; i < 12; i++) enemies.push(fakeEnemy(-20 + i * 0.4, bounds.surfaceY - 8, 0.5, 9999));
const lonelyCrab = crabAt(18, bounds.bottom + 2);
enemies.push(lonelyCrab);
const crabRun = spawnSeagull(scene, enemies);
check('one crab still outranks a whole school',
  !!crabRun && Math.abs(crabRun.target.x - 18) < 1,
  crabRun ? `x ${crabRun.target.x.toFixed(1)} of 18` : 'no run');
check('...and that run ignores everything but the seabed', crabRun?.anyPrey === false);

// A crab run passing over open water must not go off on it — the reason the
// prey rule is decided with the target rather than looked up at impact.
resetSeagulls(scene);
enemies.length = 0;
enemies.push(crabAt(0, bounds.bottom + 2));
const overflight = spawnSeagull(scene, enemies);
overflight.phase = 'dive';
overflight.container.position.set(0, bounds.surfaceY - 8, 0);
overflight.vx = 0;
overflight.vy = -2;
enemies.push(fakeEnemy(0, bounds.surfaceY - 8, 0.5, 9999));
let earlyBlast = 0;
updateSeagulls(dt, scene, enemies, { onImpact: () => { earlyBlast++; } });
check('a crab run does not go off on a fish it falls through', earlyBlast === 0,
  `${earlyBlast} blast(s)`);

// Empty water is still no run, and that is deliberate: there is nothing to
// bomb, and a cooldown spent on it would be the one case where the card is
// worse for having fired.
resetSeagulls(scene);
enemies.length = 0;
check('empty water still launches nothing', spawnSeagull(scene, enemies) === null);
resetSeagulls(scene);
enemies.length = 0;

// --- THE ENTRANCE ----------------------------------------------------------
// A run's bearing is three rolls now — a side, a length of approach and a
// depth — and every one of them fails INVISIBLY in the game. A spawn a little
// too low is a bird that pops into an empty sky, and you cannot tell that from
// having looked away; a depth left on at the commit is a dive that goes off
// beside the crab it aimed at, and that reads as the ability being unreliable.
//
// Flown rather than inspected. Each run below is ticked from its spawn all the
// way to its commit, because the thing being asserted is the SHAPE of the
// approach — that it comes down, that it never goes back up, and that it is
// level and in-plane at the moment it matters.
{
  const realRandom = Math.random;
  let rngState = 20260917;
  Math.random = () => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 4294967296;
  };

  const gc = CONFIG.seagullBomb;
  const cruiseY = bounds.surfaceY + gc.cruiseAltitude;
  // How far one flap can lift the bird off the line it is holding — the whole
  // of `flapLift` integrated over `flapTime` with the altitude spring ignored,
  // so it is a bound the bob cannot reach rather than one it lives near.
  // Derived, so retuning the undulation moves the allowance with it instead of
  // leaving a stale number here to quietly widen into a pass.
  const bob = 0.5 * gc.flapLift * gc.flapTime * gc.flapTime;
  let belowFrame = 0;      // runs that started inside the shot
  let climbed = 0;         // runs that went back up out of it
  let highCommit = 0;      // runs still descending when they dove
  let offPlane = 0;        // runs that dove off the play plane
  let wrongSize = 0;       // ...or at the wrong size for it
  let neverDove = 0;
  let deepest = 0;
  let nearest = 0;
  let longest = 0;
  let shortest = Infinity;
  let shortestLook = Infinity;  // seconds of gull on screen before the commit
  let leastCruise = Infinity;   // ...and the share of that spent at altitude

  for (let run = 0; run < 60; run++) {
    resetSeagulls(scene);
    enemies.length = 0;
    // The pile walks across the arena run to run, so the bearing is rolled
    // against every part of it rather than against the middle.
    const px = bounds.left + 4 + (bounds.width - 8) * (run / 59);
    enemies.push(crabAt(px, bounds.bottom + 2));
    const g = spawnSeagull(scene, enemies);
    if (!g) { neverDove++; continue; }

    if (g.container.position.y <= bounds.frameTop) belowFrame++;
    const span = Math.abs(g.container.position.x - px);
    longest = Math.max(longest, span);
    shortest = Math.min(shortest, span);
    deepest = Math.min(deepest, g.container.position.z);
    nearest = Math.max(nearest, g.container.position.z);

    let peakY = g.container.position.y;
    let dove = false;
    let look = 0;     // time below the top of the shot and inside its sides
    let cruise = 0;   // ...of which, time with the entrance already flown
    for (let i = 0; i < 1200 && seagullCount() > 0; i++) {
      updateSeagulls(dt, scene, enemies, {});
      if (seagullCount() === 0) break;
      // Below the top of the shot, and that alone. Whether the bird is inside
      // the frame's SIDES is the camera's business — it follows the seal, and
      // the seal is on its way to the same pile the gull is — so testing x
      // against a frame pinned at the origin would only measure how far up the
      // wall this run's pile happens to sit.
      if (g.container.position.y <= bounds.frameTop) {
        look += dt;
        if (g.descend <= 0) cruise += dt;
      }
      if (g.phase === 'dive') {
        dove = true;
        // Measured on the frame the commit fires, which is the frame the
        // entrance has to have finished on.
        if (g.container.position.y > cruiseY + 2) highCommit++;
        if (Math.abs(g.container.position.z) > 1e-6) offPlane++;
        if (Math.abs(g.container.scale.x - 1) > 1e-6) wrongSize++;
        break;
      }
      // Undulation is allowed; climbing back toward the spawn height is not.
      peakY = Math.max(peakY, g.container.position.y);
    }
    if (dove) {
      shortestLook = Math.min(shortestLook, look);
      leastCruise = Math.min(leastCruise, look > 0 ? cruise / look : 0);
    }
    if (!dove) neverDove++;
    // The bob is allowed — flapping lifts, and a gull that never rose at all
    // would be a gull on rails. Going back up toward the height it entered at
    // is the failure, and `bob` is the headroom between the two.
    else if (peakY > g.entryY + bob) climbed++;
  }

  check('every run starts above the top of the frame', belowFrame === 0,
    `${belowFrame} of 60 spawned in shot`);
  check('...and none of them climbs back out of it', climbed === 0,
    `${climbed} of 60 went back up`);
  check('every run finds its pile', neverDove === 0, `${neverDove} of 60 never dove`);
  check('...having come down to cruise altitude first', highCommit === 0,
    `${highCommit} of 60 committed from the entrance height`);
  check('...on the play plane', offPlane === 0, `${offPlane} of 60 dove off-plane`);
  check('...and at its true size', wrongSize === 0, `${wrongSize} of 60 dove scaled`);

  // The rolls have to actually roll. A bearing that collapsed to one value is
  // the bug this replaced, wearing the new code's clothes — and every check
  // above passes just as happily on sixty identical runs.
  // THE APPROACH HAS TO BE WATCHABLE, which is a different thing from being
  // correct and is the one property here that has already regressed once. The
  // descent originally ran the whole length of the approach, which kept the
  // gull above the top of the shot until the last stretch of it — every check
  // above passed, and what a player saw was under half a second of bird before
  // it folded up and fell. `entryDescent` is what holds it, and this is what
  // notices when it stops.
  check('...with a second of visible bird before the stoop, at any bearing',
    shortestLook >= 0.8,
    `shortest look at one is ${shortestLook.toFixed(2)}s`);
  // ...and most of that watched flying LEVEL. A bird still on its way down for
  // all of it is a bird whose flap and glide never show against a steady hold,
  // which is the only thing that makes it read as a seagull rather than as a
  // projectile with a model on it.
  check('...most of it spent cruising rather than still coming down',
    leastCruise >= 0.45,
    `${(leastCruise * 100).toFixed(0)}% level on the flattest run`);

  check('the approach varies from steep to shallow',
    longest - shortest > (gc.approachMax - gc.approachMin) * 0.5,
    `${shortest.toFixed(1)} to ${longest.toFixed(1)} units of run`);
  check('...and runs come from the background and the foreground both',
    deepest < -gc.depthRange * 0.5 && nearest > gc.depthRange * 0.5,
    `z ${deepest.toFixed(1)} to ${nearest.toFixed(1)}`);
  // The sky plane is painted at SKY_Z; anything at or behind it is simply not
  // in the picture, and a run that spent its approach there would be the pop
  // this entrance exists to remove, one coordinate over.
  check('...and never behind the sky plane', deepest > SKY_Z,
    `${deepest.toFixed(1)} vs sky at ${SKY_Z}`);

  // A RETARGET ONTO SOMETHING FURTHER AWAY, which is the one thing that can
  // ask the descent to run backwards. `descend` rides the distance still to
  // close, and a pile that moves further off than the spawn was makes that
  // ratio greater than 1 — a raw reading would put the hold line back at the
  // entrance height and fly the bird up out of the top of the frame to re-make
  // an entrance the player has already watched. It is clamped one-way for
  // exactly this, and nothing else in the run exercises it.
  resetSeagulls(scene);
  enemies.length = 0;
  enemies.push(crabAt(0, bounds.bottom + 2));
  const bolter = spawnSeagull(scene, enemies);
  const startY = bolter.container.position.y;
  for (let i = 0; i < 90; i++) updateSeagulls(dt, scene, enemies, {});
  const midY = bolter.container.position.y;
  // The pile bolts to the far wall, behind the bird.
  enemies[0].mesh.position.x = bolter.container.position.x + bolter.dir * -200;
  let rose = 0;
  for (let i = 0; i < 240 && seagullCount() > 0; i++) {
    updateSeagulls(dt, scene, enemies, {});
    if (seagullCount() === 0) break;
    rose = Math.max(rose, bolter.container.position.y - midY);
  }
  check('a pile that bolts cannot send the gull back up for a second entrance',
    rose <= bob,
    `rose ${rose.toFixed(2)} of an allowed ${bob.toFixed(2)}, from ${startY.toFixed(1)} -> ${midY.toFixed(1)}`);

  // THE CAMERA IS NOT AT REST, and that is what `view` is for. A breach pans
  // the shot up to the arena's ceiling — twenty-one units of sky above
  // bounds.frameTop — and a run that measured its entrance off the resting
  // frame would spawn straight into the middle of it, at full size, out of
  // nothing. It would only ever happen mid-jump, which is the moment least
  // likely to be watched closely and most likely to be blamed on something
  // else.
  //
  // Flown, not just placed, because the second half of this is the descent:
  // three times the drop against the same rolled run is a bird falling faster
  // than the stoop it is about to perform, and `entryAngleMax` is what holds it
  // to a line. Both numbers come from the same sixty runs.
  {
    // The highest the rig can go: focus pinned at the ceiling less half a
    // frame, which is exactly focusLimits' hiY in world.js.
    const halfH = (bounds.frameTop - bounds.frameBottom) / 2;
    const high = { x: 0, y: bounds.top - halfH, halfW: bounds.frameWidth / 2, halfH };
    const top = high.y + high.halfH;
    let inShot = 0;
    let plummet = 0;
    let steepest = 0;
    for (let run = 0; run < 60; run++) {
      resetSeagulls(scene);
      enemies.length = 0;
      enemies.push(crabAt(bounds.left + 6 + (bounds.width - 12) * (run / 59), bounds.bottom + 2));
      const g = spawnSeagull(scene, enemies, high);
      if (!g) continue;
      if (g.container.position.y <= top) inShot++;
      let fastest = 0;
      for (let i = 0; i < 1200 && seagullCount() > 0; i++) {
        updateSeagulls(dt, scene, enemies, {});
        if (seagullCount() === 0 || g.phase === 'dive') break;
        fastest = Math.max(fastest, -(g.vy + g.entryVy));
      }
      steepest = Math.max(steepest, fastest);
      // The stoop is the fastest the bird is ever allowed to be moving.
      if (fastest > gc.diveSpeedMax) plummet++;
    }
    check('a run under a panned-up camera still starts out of shot', inShot === 0,
      `${inShot} of 60 spawned inside a shot topping out at ${top.toFixed(1)}`);
    check('...and comes down slower than the dive it is on the way to',
      plummet === 0,
      `fastest descent ${steepest.toFixed(1)}, held to ${gc.entryDropMax} and capped by the stoop's ${gc.diveSpeedMax}`);
  }

  Math.random = realRandom;
}

// --- THE STOOP COMES APART -------------------------------------------------
// Against the REAL seagull.fbx, because every part of this is a claim about
// that file. A rig declared in assets.js is a list of bone NAMES, and
// systems/animation.js resolves it with getObjectByName().filter(Boolean) — a
// name that matches nothing is silently dropped and the chain is quietly built
// one bone shorter, or not at all. That exact mistake cost the orca cow her
// entire dorsal on half of all boss arrivals and nothing anywhere said a word.
{
  const gullModel = resolve(dirname(fileURLToPath(import.meta.url)), '../public/models/seagull.fbx');
  if (!existsSync(gullModel)) {
    console.log('  (seagull.fbx missing — the ragdoll cannot be checked against a model that is not there)');
  } else {
    // FBXLoader complains at length about 3ds Max shader parameters three.js
    // has no use for, none of which is about the bones. Silenced around the
    // parse only, so a real warning later still reaches the log.
    const realWarn = console.warn;
    console.warn = () => {};
    const fbxBuf = readFileSync(gullModel);
    const fbx = new FBXLoader().parse(
      fbxBuf.buffer.slice(fbxBuf.byteOffset, fbxBuf.byteOffset + fbxBuf.byteLength), '',
    );
    console.warn = realWarn;
    installModel('seagull', fbx, fbx.animations);

    // SEEDED, and this block cannot be paired without it. Every check below is
    // two runs compared frame against frame, and `spawnSeagull` rolls a bearing
    // — so an unseeded pair gets two different `dir` values half the time, the
    // visual's flank flip mirrors one bird against the other, and the two poses
    // come out a wingspan apart for reasons that have nothing to do with what
    // is being measured. It passed on the first run and would have failed on
    // the next, which is the worst way for a test to be wrong.
    const realGullRandom = Math.random;
    let gullRng = 20260917;
    const seedGull = () => { gullRng = 20260917; };
    Math.random = () => {
      gullRng = (gullRng * 1664525 + 1013904223) >>> 0;
      return gullRng / 4294967296;
    };

    const bird = createVisual('seagull');
    const chains = ASSETS.seagull.rig.springChains;
    check('the gull model carries a skeleton at all',
      !!bird.getObjectByName(chains[0].bones[0]), 'no bones on the clone');

    // EVERY NAME, on the instance the game actually flies — not on the loader's
    // output. A clone is where a name is resolved and is where one goes missing.
    const missing = [];
    for (const chain of chains) {
      for (const name of chain.bones) if (!bird.getObjectByName(name)) missing.push(name);
    }
    check('every bone the rig names exists on the model', missing.length === 0,
      missing.join(', ') || `${chains.reduce((n, c) => n + c.bones.length, 0)} bones across ${chains.length} chains`);

    // ...and the two chains that end on a LEAF, which is where the bone axis
    // bites. makeSpring falls back to `boneAxis * last.position.length()` for a
    // final bone with no child, and at the +Y default this rig would hand the
    // solver a tip direction square to the limb it belongs to — a chain that
    // springs about an axis the leg does not have. It still runs. It just looks
    // like bad tuning.
    check('the rig declares the +X bone axis this Biped export actually uses',
      ASSETS.seagull.rig.boneAxis === '+X', `${ASSETS.seagull.rig.boneAxis}`);
    for (const leaf of ['SEAGULL__Queue_de_cheval_1', 'SEAGULL__L_Toe02']) {
      const b = bird.getObjectByName(leaf);
      const kids = b?.children.filter((o) => o.isBone).length ?? -1;
      check(`...and ${leaf.replace('SEAGULL__', '')} is the leaf that needs it`,
        kids === 0 && b.position.length() > 0.01,
        `${kids} bone child(ren), own offset ${b?.position.length().toFixed(2)}`);
    }

    // Now fly one. Measured by where the BONES END UP in world space, not by
    // their local quaternions: a chain can split the same bend between its
    // joints more than one way, and what a player sees is where the wingtip is.
    const tips = ['SEAGULL__L_Hand', 'SEAGULL__R_Hand', 'SEAGULL__L_Toe02', 'SEAGULL__R_Toe02', 'SEAGULL__Queue_de_cheval_1'];
    const wp = new THREE.Vector3();
    // In the CONTAINER's frame, so the body's dive rotation and its fall are
    // divided out and what is left is the skeleton moving inside the bird.
    function pose(g) {
      // FORCED. Nothing renders in this harness, so no three.js pass updates a
      // world matrix on its own and every frame would measure identical —
      // silently, with no error anywhere.
      g.container.updateMatrixWorld(true);
      return tips.map((n) => {
        const b = g.visual.getObjectByName(n);
        b.getWorldPosition(wp);
        return g.container.worldToLocal(wp.clone());
      });
    }
    const apart = (a, b) => Math.max(...a.map((v, i) => v.distanceTo(b[i])));

    // The bird's own length in world units, so the numbers below can be read
    // as a share of it rather than as bare units. Measured off the model the
    // game flies, not off the file: `fit` and the size multiplier are both in
    // the clone and a 73-unit FBX arrives here about twelve.
    const BIRD_LEN = new THREE.Box3().setFromObject(bird).getSize(new THREE.Vector3()).length();

    // PAIRED RUNS, frame against frame. Measuring one bird against its own
    // pose at the commit does not work and is worth saying why: the first
    // fifth of a second of a stoop is the mixer crossfading out of the flap,
    // and the wings travel most of their span doing it — measured, 6.4 world
    // units, with the ragdoll switched off. A drift check would have read that
    // as the ragdoll working and passed on a build that never called setLimp.
    //
    // So two identical dives, differing in nothing but `slack.enabled`, and
    // what is measured is how far apart the two birds are at the same instant.
    // The RNG is re-seeded before each so the bearing, the depth and the skin
    // roll come out the same and the only difference left is the one under test.
    function stoop(slackOn) {
      const was = CONFIG.seagullBomb.slack.enabled;
      CONFIG.seagullBomb.slack.enabled = slackOn;
      seedGull();
      resetSeagulls(scene);
      enemies.length = 0;
      enemies.push(crabAt(0, bounds.bottom + 2));
      const g = spawnSeagull(scene, enemies);
      // Dropped straight into the commit rather than flown in: this is a check
      // about the plunge, and the approach has its own sixty runs above.
      g.container.position.set(0, bounds.surfaceY + CONFIG.seagullBomb.cruiseAltitude, 0);
      g.phase = 'dive';
      const frames = [];
      let slackAt = -1;
      let t = 0;
      for (let i = 0; i < 400 && seagullCount() > 0; i++) {
        updateSeagulls(dt, scene, enemies, {});
        if (seagullCount() === 0) break;
        t += dt;
        if (slackAt < 0 && g.slack) slackAt = t;
        frames.push(pose(g));
      }
      CONFIG.seagullBomb.slack.enabled = was;
      return { frames, slackAt, loose: g.loose, fall: t };
    }

    const loose = stoop(true);
    const rigid = stoop(false);

    check('a stooping gull has a skeleton to come apart', loose.loose === true);
    check('...and both dives are the same dive but for the slack',
      loose.frames.length === rigid.frames.length,
      `${loose.frames.length} frames against ${rigid.frames.length}`);

    const n = Math.min(loose.frames.length, rigid.frames.length);
    let split = 0;
    for (let i = 0; i < n; i++) split = Math.max(split, apart(loose.frames[i], rigid.frames[i]));
    check('...and it comes apart', split > 0.5,
      `${split.toFixed(2)} world units between the loose bird and the rigid one, over a ${loose.fall.toFixed(2)}s fall`);

    // THE CONTROL, stated as its own fact rather than left implied: once the
    // crossfade is over the stoop clip is a HELD pose and a rigid bird stops
    // moving entirely. That is what makes the number above attributable — and
    // it is also the reason freezing this particular clip costs no animation.
    const settled = Math.ceil((CONFIG.animation?.states?.boost?.fade ?? 0.2) / dt) + 2;
    let rigidStir = 0;
    for (let i = settled + 1; i < rigid.frames.length; i++) {
      rigidStir = Math.max(rigidStir, apart(rigid.frames[i], rigid.frames[settled]));
    }
    check('...which the held stoop clip on its own barely does', rigidStir < 0.25,
      `rigid bird stirred ${rigidStir.toFixed(3)} after the crossfade, on a ${BIRD_LEN.toFixed(1)}-unit bird`);
    // And the ratio, which is the number that actually attributes the motion.
    // The stoop is a HELD pose but not a frozen one — measured, the clip goes
    // on breathing about a hundredth of a body length after the crossfade — so
    // "the rigid bird does not move" is not a fact that was ever going to hold,
    // and a threshold tight enough to claim it would only ever have been a
    // flake waiting for a re-cut of the range.
    check('...by two orders of magnitude', split > rigidStir * 40,
      `x${(split / Math.max(1e-6, rigidStir)).toFixed(0)} the clip's own residue`);

    // ...and the loose one keeps moving for the whole fall rather than snapping
    // to one folded shape and holding it, which is what an over-large impulse
    // against this spring produces (see CONFIG.boss.ragdoll.blow for the same
    // trap found the hard way).
    let lateStir = 0;
    for (let i = settled + 1; i < loose.frames.length; i++) {
      lateStir = Math.max(lateStir, apart(loose.frames[i], loose.frames[i - 1]));
    }
    check('...and goes on moving, rather than cutting to one folded pose',
      lateStir > 0.004 && lateStir < 1.5,
      `${lateStir.toFixed(3)} units of tip travel in the busiest single frame`);

    // THE TWO WINGS HAVE TO DISAGREE, and this is the check that the whole role
    // split exists for. `impulse` with no role shoves every chain with one
    // world vector, and a body's limbs are laid out symmetrically — so one
    // vector bends a left wing and a right wing through the same angle, for
    // ever, whatever the vector is. Measured before the split: the two wingtips
    // stayed within a tenth of a percent of body length of each other for an
    // entire fall, which reads as a bird folding up tidily rather than as one
    // losing an argument with the air.
    //
    // Nothing else here would notice it coming back. Every other check above
    // passes just as happily on a perfectly symmetrical fold.
    const LW = tips.indexOf('SEAGULL__L_Hand');
    const RW = tips.indexOf('SEAGULL__R_Hand');
    const base = loose.frames[settled];
    let disagree = 0;
    for (let i = settled; i < loose.frames.length; i++) {
      const f = loose.frames[i];
      disagree = Math.max(disagree,
        Math.abs(f[LW].distanceTo(base[LW]) - f[RW].distanceTo(base[RW])));
    }
    check('...with the two wings disagreeing about which way is back',
      disagree > BIRD_LEN * 0.03,
      `${(disagree / BIRD_LEN * 100).toFixed(1)}% of body length between the wingtips' travel`);

    // NOT ON THE COMMIT. setLimp freezes whatever pose the bones hold and makes
    // that the shape everything is measured from, and at the commit the mixer
    // is still crossfading out of the flap — so letting go there welds the bird
    // to a half-flapped pose nobody drew. One crossfade of delay, and this is
    // the only thing that would ever notice it going missing.
    const fadeLen = CONFIG.animation?.states?.boost?.fade ?? CONFIG.animation?.crossfade ?? 0.2;
    check('...only once the tuck has finished fading in',
      loose.slackAt >= fadeLen - dt * 1.5,
      `let go at ${loose.slackAt.toFixed(3)}s against a ${fadeLen}s crossfade`);

    // THE CHAINS SLEEP THROUGH THE APPROACH. `asleep` is what keeps a spring
    // off an authored wingbeat, and it is one flag per chain in a table — easy
    // to lose and impossible to see going missing, because a lagging wing on a
    // flying bird looks like a wing.
    check('every chain sleeps until the skeleton is let go',
      chains.every((c) => c.asleep === true),
      `${chains.filter((c) => !c.asleep).length} awake during the cruise`);

    // Paired again, and for the same reason: a cruising gull's tips move half a
    // body length every wingbeat because that is what the clip does. What is
    // being asked is whether a SHOVE changes any of it — an impulse banked by a
    // sleeping chain would be released the instant the dive wakes it, and the
    // bird would open its stoop with a flinch it took half a second earlier.
    function cruise(shove) {
      seedGull();
      resetSeagulls(scene);
      enemies.length = 0;
      enemies.push(crabAt(0, bounds.bottom + 2));
      const g = spawnSeagull(scene, enemies);
      const frames = [];
      for (let i = 0; i < 40; i++) {
        updateSeagulls(dt, scene, enemies, {});
        if (shove) g.anim.impulse(DOWN_TEST, 12, 0.8);
        frames.push(pose(g));
      }
      return frames;
    }
    const shoved = cruise(true);
    const calm = cruise(false);
    let flinch = 0;
    for (let i = 0; i < calm.length; i++) flinch = Math.max(flinch, apart(shoved[i], calm[i]));
    check('...and forty frames of shoving during the cruise change nothing',
      flinch < 1e-6, `${flinch.toFixed(6)} units apart from an unshoved twin`);

    Math.random = realGullRandom;
  }
}

resetSeagulls(scene);
enemies.length = 0;

// KICKING OFF THE BIRD — the mid-air relaunch that goes through a gull.
// Everything here fails silently in the game: a reach measured without the
// seal's own radius is a miss the player cannot tell from bad timing, and a
// bird with no "already paid" flag hands out a bar of fuel and a chain link on
// every single frame the seal spends inside it.
resetSeagulls(scene);
enemies.length = 0;
enemies.push(crabAt(0, bounds.bottom + 2));
const perch = spawnSeagull(scene, enemies);
perch.container.position.set(0, bounds.surfaceY + CONFIG.seagullBomb.cruiseAltitude, 0);
const gx = perch.container.position.x;
const gy = perch.container.position.y;
const sealR = 0.6;
const kickR = CONFIG.seagullBomb.kick.radius;

check('a jump nowhere near a gull kicks nothing',
  kickGull(gx + kickR + sealR + 5, gy, sealR) === null);
// Just outside the summed reach, so this is the check that the seal's OWN
// radius is in the sum rather than the gull's alone.
check('...nor one just outside the summed reach',
  kickGull(gx + kickR + sealR + 0.2, gy, sealR) === null);

const kicked = kickGull(gx + kickR + sealR - 0.2, gy, sealR);
check('a jump through a gull kicks it', !!kicked,
  kicked ? `at ${kicked.x.toFixed(1)}, ${kicked.y.toFixed(1)}` : 'nothing');
check('...and reports where the BIRD was, not where the seal was',
  !!kicked && Math.abs(kicked.x - gx) < 1e-6 && Math.abs(kicked.y - gy) < 1e-6);
check('...and the same bird never pays twice',
  kickGull(gx, gy, sealR) === null);

// Two in the air at once are two opportunities. The flag is per-gull for
// exactly this: a cooldown would eat the second bird.
resetSeagulls(scene);
const a = spawnSeagull(scene, enemies);
const b = spawnSeagull(scene, enemies);
a.container.position.set(30, 20, 0);
b.container.position.set(30.4, 20, 0);
const first = kickGull(30, 20, sealR);
const second = kickGull(30.4, 20, sealR);
check('two gulls in the air are two payouts', !!first && !!second);
check('...and a third jump through both is nothing',
  kickGull(30.2, 20, sealR) === null);

// The master switch, which is a weapons.csv row.
resetSeagulls(scene);
const offBird = spawnSeagull(scene, enemies);
offBird.container.position.set(30, 20, 0);
const wasKickOn = CONFIG.seagullBomb.kick.enabled;
CONFIG.seagullBomb.kick.enabled = false;
check('the kick switches off whole', kickGull(30, 20, sealR) === null);
CONFIG.seagullBomb.kick.enabled = wasKickOn;
check('...and back on again', !!kickGull(30, 20, sealR));

// The link itself. Routed through chainStrike like every other source, so it
// is switchable and it cannot open a chain when the source is off.
resetSeagulls(scene);
enemies.length = 0;
check('the kick is a food chain source', CONFIG.strike.chainOn.gullKick === true);
check('...with no cooldown, because the bird is the rate limit',
  (CONFIG.strike.chainOn.cooldowns.gullKick ?? 0) === 0);
resetStrike();
check('...that starts a chain from nothing', chainStrike('gullKick') === 1);
check('...and extends the one it started', chainStrike('gullKick') === 2);
const wasGullChain = CONFIG.strike.chainOn.gullKick;
CONFIG.strike.chainOn.gullKick = false;
check('...and scores nothing at all when switched off', chainStrike('gullKick') === 0);
CONFIG.strike.chainOn.gullKick = wasGullChain;
resetStrike();
resetSeagulls(scene);
enemies.length = 0;

// --- DAMAGE GLOW -----------------------------------------------------------
// An aura that is hurting something is brighter than one that is not. All of
// this fails silently: heat that never decays leaves a field permanently lit,
// a per-instance material that was never cloned flares the whole ring at once,
// and a glow driven onto a property the material does not have does exactly
// nothing while every other check still passes.
section('DAMAGE GLOW');

// The envelope, which is pure arithmetic — no scene, no model.
check('a hit stokes heat', stoke(0, 'shrimpRing') > 0, `${stoke(0, 'shrimpRing').toFixed(2)}`);
check('...and it saturates rather than running away',
  stoke(stoke(stoke(0, 'garlic', 5), 'garlic', 5), 'garlic', 5) <= 1);
check('a bigger catch runs hotter than a single body',
  stoke(0, 'garlic', 6) > stoke(0, 'garlic', 1),
  `${stoke(0, 'garlic', 1).toFixed(2)} vs ${stoke(0, 'garlic', 6).toFixed(2)} for six`);
{
  const g = damageGlowCfg('garlic');
  // Linear over `fade`, so a field that stopped biting is COLD rather than
  // faintly warm for the rest of the run — the one reading this exists to
  // prevent.
  let h = 1;
  for (let i = 0; i < Math.ceil(g.fade / dt) + 2; i++) h = cool(h, 'garlic', dt);
  check('heat goes all the way out', h === 0, `${h.toFixed(3)} after ${g.fade}s`);
  check('a source row falls back to the shared envelope',
    damageGlowCfg('nothing-by-this-name').fade === (CONFIG.damageGlow.fade),
    `${damageGlowCfg('nothing-by-this-name').fade}`);
}

// The per-instance material. Built by hand, because no model loads in Node —
// what is under test is the cloning, not the shrimp.
{
  const lit = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.3),
    new THREE.MeshStandardMaterial({ color: 0xffb0a0, emissive: 0x000000, emissiveIntensity: 0 }),
  );
  const shared = lit.material;
  const twin = new THREE.Mesh(lit.geometry, shared);
  const handle = attachDamageGlow(lit);
  check('a lit model gets a handle', !!handle);
  handle.set(1, 'shrimpRing');
  check('...and full heat lifts its emissive',
    lit.material.emissiveIntensity > 0 && lit.material.emissive.getHex() !== 0x000000,
    `intensity ${lit.material.emissiveIntensity.toFixed(2)}`);
  check('...brightly enough to cross the bright pass',
    lit.material.emissiveIntensity >= 1,
    `${lit.material.emissiveIntensity.toFixed(2)} against a bloom threshold of ${CONFIG.bloom.threshold}`);
  // THE WHOLE REASON THIS CLONES. A shared material would have taken the twin
  // with it, which is the ring flaring as one object.
  check('...without touching anything else wearing that material',
    twin.material === shared && shared.emissiveIntensity === 0,
    `neighbour at ${shared.emissiveIntensity}`);
  handle.set(0, 'shrimpRing');
  check('cold puts the material back where it was',
    lit.material.emissiveIntensity === 0 && lit.material.emissive.getHex() === 0x000000);

  // The unlit half: a primitive stand-in has no emissive channel at all, so
  // the heat has to arrive as HDR overdrive on its colour or the fallback
  // build simply never glows.
  const flat = new THREE.Mesh(lit.geometry, new THREE.MeshBasicMaterial({ color: 0x808080 }));
  // Read off the material rather than derived from the hex: three converts an
  // sRGB hex into linear on the way in, so 0x808080 is 0.216 in here and a
  // test that assumed 0.5 would be asserting against a colour space.
  const flatCold = flat.material.color.r;
  const flatHandle = attachDamageGlow(flat);
  flatHandle.set(1, 'shrimpRing');
  check('an unlit stand-in glows by colour overdrive',
    flat.material.color.r > flatCold * 1.5,
    `${flatCold.toFixed(2)} -> ${flat.material.color.r.toFixed(2)} on red`);
  flatHandle.release();
  check('...and comes back to its own colour',
    Math.abs(flat.material.color.r - flatCold) < 0.001, `r ${flat.material.color.r.toFixed(3)}`);
}

// THE SHRIMP RING, end to end: the shrimp that bit is the one that is hot.
{
  enemies.length = 0;
  const shrimpGroup = createShrimpRingVisual();
  scene.add(shrimpGroup);
  resetShrimpRing();
  const ringPlayer = { x: 0, y: bounds.surfaceY - 10 };
  // Right on the ring, so a shrimp sweeps into it.
  const victim = fakeEnemy(ringPlayer.x + CONFIG.shrimpRing.radius, ringPlayer.y, 0.6, 1e6);
  enemies.push(victim);
  let ringHits = 0;
  let hottest = 0;
  let coldest = Infinity;
  const ringFrames = Math.ceil((Math.PI * 2 / CONFIG.shrimpRing.orbitSpeed) / dt);
  for (let i = 0; i < ringFrames; i++) {
    // 4 shrimp is the SECOND stack — the first pick opens a ring of 3. The
    // level is its own argument now because the count is written by Clone
    // Warz and Entourage too; see shrimpRingLevelStats.
    updateShrimpRing(dt, scene, ringPlayer, 4, 2, {}, enemies, { onContact: () => { ringHits++; } });
    if (ringHits > 0) {
      const scales = shrimpGroup.children.map((m) => m.scale.x);
      hottest = Math.max(hottest, Math.max(...scales));
      coldest = Math.min(coldest, Math.min(...scales));
    }
  }
  check('the ring lands contacts to be hot about', ringHits > 0, `${ringHits} contact(s)`);
  // The punch is the per-instance channel a screenshot can see, and the glow
  // rides the same heat — so a ring where every shrimp is the same size is a
  // ring where the flare went to all of them or to none.
  check('the shrimp that bit is not the same size as the ones that did not',
    hottest > coldest * 1.02,
    `${coldest.toFixed(3)} - ${hottest.toFixed(3)}`);
  // THE RESTING SIZE IS THE LEVEL'S, not CONFIG's. A stack buys a slightly
  // bigger shrimp (shrimpRingLevelStats), so a cap measured off the base scale
  // is a cap on stack one — and this ring is at stack two. Read from the same
  // function the system scales the mesh with, or this assertion drifts the next
  // time sizePerLevel is touched and blames the hit-pop for it.
  const restScale = shrimpRingLevelStats(2, {}).shrimpSize;
  const popCap = restScale * (1 + CONFIG.shrimpRing.hitPop);
  check('...and no shrimp is left inflated',
    hottest <= popCap + 1e-6,
    `${hottest.toFixed(3)} against a cap of ${popCap.toFixed(3)}`);
  resetShrimpRing();
  scene.remove(shrimpGroup);
  enemies.length = 0;
}

// THE GARLIC CLOUD. Additive, so brightness is the COLOUR — pushing the alpha
// instead would only make the cloud thicker.
{
  enemies.length = 0;
  const garlic = createGarlicVisual();
  scene.add(garlic);
  resetGarlic();
  const garlicPlayer = { x: 0, y: bounds.surfaceY - 10 };
  updateGarlic(dt, scene, garlicPlayer, 3, enemies, {});
  const cold = garlic.material.uniforms.uColor.value.clone();
  for (let i = 0; i < 6; i++) enemies.push(fakeEnemy(0, garlicPlayer.y, 0.4, 1e6));
  let ticks = 0;
  for (let i = 0; i < Math.ceil((CONFIG.garlic.tickInterval * 3 + 0.1) / dt) && ticks < 3; i++) {
    updateGarlic(dt, scene, garlicPlayer, 3, enemies, { onTick: () => { ticks++; } });
  }
  const hot = garlic.material.uniforms.uColor.value.clone();
  const hotFlow = garlic.material.uniforms.uFlow.value;
  check('the garlic cloud ticks through a crowd', ticks > 0, `${ticks} tick(s)`);
  check('...and grinding brightens it', hot.r > cold.r,
    `${cold.r.toFixed(2)} -> ${hot.r.toFixed(2)} on red`);
  // THE HUE, SEPARATELY FROM THE BRIGHTNESS. Both land on the same three
  // channels, so "it got brighter" is not evidence that the hue moved at all —
  // a pure brightness lift scales every channel by the SAME factor, and the
  // only thing that can tell the two apart is the ratio between them.
  check('...and swings its hue, not just its level',
    Math.abs((hot.g / Math.max(1e-6, hot.r)) - (cold.g / Math.max(1e-6, cold.r))) > 0.01,
    `g/r ${(cold.g / cold.r).toFixed(3)} -> ${(hot.g / hot.r).toFixed(3)}`);
  // AND TOWARD THE WARM END. The direction is per aura and signed in config —
  // red sits at both ends of the wheel, so the green cloud warms by turning one
  // way and the two pink fields warm by turning the other. This is the check
  // that catches a row whose sign was copied from a neighbour: a hue moving the
  // wrong way is still a hue moving, and every other check here would pass.
  check('...toward the warm end rather than away from it',
    hot.r / Math.max(1e-6, hot.g) > cold.r / Math.max(1e-6, cold.g),
    `r/g ${(cold.r / cold.g).toFixed(3)} -> ${(hot.r / hot.g).toFixed(3)}`);
  // ...and goes back down. A cloud that stayed hot would be the brightest
  // thing on screen for the rest of the run.
  enemies.length = 0;
  for (let i = 0; i < Math.ceil((damageGlowCfg('garlic').fade + 0.1) / dt); i++) {
    updateGarlic(dt, scene, garlicPlayer, 3, enemies, {});
  }
  const cooled = garlic.material.uniforms.uColor.value.clone();
  check('...and cools back to where it started',
    Math.abs(cooled.r - cold.r) < 0.001, `${cooled.r.toFixed(3)} vs ${cold.r.toFixed(3)}`);
  check('...on the hue as well as the level',
    Math.abs((cooled.g / cooled.r) - (cold.g / cold.r)) < 0.001,
    `g/r ${(cooled.g / cooled.r).toFixed(3)} vs ${(cold.g / cold.r).toFixed(3)}`);
  // THE STIR. The scroll phase is integrated on the CPU rather than derived
  // from a clock, and the whole reason is that it must never jump: a hot cloud
  // crawls FASTER from where it already is. Both halves are asserted, because
  // each fails invisibly on its own — a flow that never moves is a frozen
  // cloud, and one that is recomputed as rate x elapsed looks identical in a
  // still frame and teleports in motion.
  const coldFlowStep = garlic.material.uniforms.uFlow.value - hotFlow;
  check('a cold cloud still crawls', coldFlowStep > 0);
  check('...and the scroll phase only ever goes forward',
    garlic.material.uniforms.uFlow.value >= hotFlow,
    `${hotFlow.toFixed(3)} -> ${garlic.material.uniforms.uFlow.value.toFixed(3)}`);
  check('...faster while it is grinding than after it has cooled',
    glowStir(1, 'garlic') > glowStir(0, 'garlic'),
    `x${glowStir(1, 'garlic').toFixed(2)} at full heat`);
  resetGarlic();
  scene.remove(garlic);
  enemies.length = 0;
}

// THE HUE OPERATOR ITSELF. Every field aura goes through it, and it is the one
// piece here that can be wrong while every picture still looks fine: a rotation
// that quietly changed a colour's WEIGHT would swing how hard the aura crosses
// the bright pass, and the brightness channel would stop meaning one thing.
{
  const luma = (c) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
  const c = new THREE.Color(0.2, 0.9, 0.35);
  const before = luma(c);
  const was = c.clone();
  rotateHue(c, 34);
  // On the RATIOS, not on one channel. A green rotated a third of the way to
  // yellow barely moves its green — the movement is in the other two — and a
  // check on `g` alone would read a working rotation as a dead one.
  check('a hue rotation moves the colour',
    Math.abs(c.r / c.b - was.r / was.b) > 0.05,
    `r/b ${(was.r / was.b).toFixed(3)} -> ${(c.r / c.b).toFixed(3)}`);
  check('...without changing what it weighs to the bright pass',
    Math.abs(luma(c) - before) < 1e-6,
    `${before.toFixed(6)} -> ${luma(c).toFixed(6)}`);
  // WHICH WAY IS UP. Signed per source in config, so the operator itself has to
  // have a direction that can be relied on: red turns toward yellow.
  const dir = new THREE.Color(0.9, 0.1, 0.1);
  rotateHue(dir, 40);
  check('...turning up the wheel on a positive angle', dir.g > 0.1);
  check('...and never into negative light',
    c.r >= 0 && c.g >= 0 && c.b >= 0);
  // HDR IN, HDR OUT. Half the colours handed to this are already above 1 — an
  // overdriven aura, a note colour rolled with deliberate headroom — and an
  // HSL round trip would clamp away exactly the headroom that haloes.
  const bright = new THREE.Color(2.4, 1.1, 1.9);
  rotateHue(bright, 22);
  check('...and keeps HDR headroom rather than clamping it',
    Math.max(bright.r, bright.g, bright.b) > 1.5,
    `peak ${Math.max(bright.r, bright.g, bright.b).toFixed(2)}`);
  // A full turn is the identity, which is the cheapest check that the matrix
  // is a rotation at all rather than three plausible rows of numbers.
  const round = new THREE.Color(0.3, 0.55, 0.8);
  rotateHue(round, 360);
  check('...and a full turn comes back to where it started',
    Math.abs(round.r - 0.3) < 1e-4 && Math.abs(round.b - 0.8) < 1e-4);
}

// Every aura reads the same table, which is the point of there being a table.
check('every aura is on the one envelope',
  ['shrimpRing', 'garlic', 'harp'].every((k) => CONFIG.damageGlow.sources[k]),
  Object.keys(CONFIG.damageGlow.sources).join(', '));
// EVERY FIELD DRIVES ALL THREE. The fields are the auras with somewhere to put
// a stir and a hue, and a row that quietly resolves to zero on either is an
// aura back to saying one thing — which is the failure this whole block exists
// to prevent, arriving as a tuning value rather than as missing code.
for (const k of ['garlic', 'harp', 'calamari']) {
  const row = damageGlowCfg(k);
  check(`${k} stirs while it is working`, row.stir > 0 && glowStir(1, k) > 1,
    `x${glowStir(1, k).toFixed(2)}`);
  check(`...and swings its hue`, Math.abs(row.hue) > 0 && Math.abs(glowHue(1, k)) > 0,
    `${glowHue(1, k).toFixed(1)} deg`);
  check(`...and both are back to nothing when it is cold`,
    glowStir(0, k) === 1 && glowHue(0, k) === 0);
}
check('...and heat is off entirely when the block is',
  (() => {
    const was = CONFIG.damageGlow.enabled;
    CONFIG.damageGlow.enabled = false;
    const off = stoke(1, 'garlic') === 0 && glowLevel(1, 'garlic') === 0;
    CONFIG.damageGlow.enabled = was;
    return off;
  })());

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
