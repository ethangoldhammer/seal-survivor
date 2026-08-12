#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:gravity
//
// WHAT FALLS, AND HOW FAST. Everything above the water line — the seal, a
// shell it fired, a body off a deck, wreckage, a leaping dolphin — is supposed
// to answer to ONE number now, CONFIG.arena.gravity, and to trace the plain
// ballistic curve that number describes. Both halves of that are claims about
// motion over time, which is exactly what a screenshot cannot answer and what
// the browser preview cannot even run: it suspends requestAnimationFrame, so
// the loop is frozen there.
//
// Five things worth failing over:
//
//   ARC       that a breach is BALLISTIC — apex and airtime land on v^2/2g and
//             2v/g rather than somewhere short of them. Air used to carry the
//             seal's WATER friction (0.98 per frame is 70% of your speed gone
//             every second), which flattened every jump; the control run below
//             puts that back and shows the difference, so a regression here
//             reads as "the syrup is back" instead of as a number moving.
//
//   FALL      that a shot fired out of the surface actually falls, on ~gt^2/2,
//             and that the same shot fired UNDER the line still crosses the
//             arena dead flat. The second half is the one that would break
//             quietly: gravity leaking below the surface would put a droop on
//             every bullet in the game and nothing would throw.
//
//   TOGETHER  that the seal and its own bullet fall at the SAME rate. This is
//             the whole point of one shared constant, and it is one edit away
//             from silently drifting apart again.
//
//   POWERED   that a missile under thrust and a scallop clapping across the sky
//             are NOT dragged down. Free fall is for things in free fall.
//
//   NOSE      that a falling shell turns to follow its arc rather than sliding
//             sideways down it — `orient` reads `dir`, so this proves gravity
//             went into the velocity and not into the position behind its back.
//
// What it cannot tell you: whether 29.7 feels good. That is a controller in
// your hands. What it CAN tell you is whether 29.7 is honest — the scale
// readout at the bottom prints what the tuned value works out to in m/s^2 at
// the size this ocean is drawn, and flags a jump that the arena ceiling would
// now catch.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { bounds, updateBounds } from '../path/src/arena.js';
import { player, initPlayer, resetPlayer, updatePlayer } from '../path/src/entities/player.js';
import {
  projectiles, spawnProjectile, updateProjectiles, resetProjectiles,
} from '../path/src/entities/projectiles.js';

const scene = new THREE.Scene();
const dt = 1 / 60;
let failures = 0;

// The animation controller warns for every state the procedural stand-in has
// no clip for, which here is all of them — no models are loaded in Node.
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
function note(text) { console.log(`        ${text}`); }
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

updateBounds(16 / 9);
initPlayer(scene);

const G = CONFIG.arena.gravity;
const noInput = { move: new THREE.Vector2(0, 0), aim: new THREE.Vector2(1, 0) };

// ---------------------------------------------------------------------------
// THE SEAL'S ARC
//
// Launched from the water line at a chosen speed and heading, with the stick
// centred, then flown until it comes back down. `drag` overrides arena.airDrag
// for the run — which is what makes the syrup control possible without editing
// the config a test is meant to be measuring.
// ---------------------------------------------------------------------------
function breach(speed, angleDeg, drag = CONFIG.arena.airDrag, dashFor = 0) {
  const was = CONFIG.arena.airDrag;
  CONFIG.arena.airDrag = drag;
  resetPlayer();
  const a = (angleDeg * Math.PI) / 180;
  player.mesh.position.set(0, bounds.surfaceY + 0.01, 0);
  player.velocity.set(Math.cos(a) * speed, Math.sin(a) * speed);
  // A launch above maxSpeed only KEEPS that speed while the dash is live —
  // the ordinary swim ceiling cuts it back the frame after. So measuring what
  // a strike really reaches means running the dash clock too.
  player.dashTimer = dashFor;

  let apex = 0;
  let air = 0;
  let range = 0;
  // Cap the flight rather than trusting it to end: a bug that leaves the seal
  // rising forever should fail a number, not hang the suite.
  for (let i = 0; i < 60 * 12; i++) {
    updatePlayer(dt, noInput);
    const { x, y } = player.mesh.position;
    if (y <= bounds.surfaceY) break;
    air += dt;
    apex = Math.max(apex, y - bounds.surfaceY);
    range = Math.abs(x);
  }
  CONFIG.arena.airDrag = was;
  return { apex, air, range };
}

section('ARC — a breach is ballistic, not a wade through syrup');
{
  const v = 24;
  const idealApex = (v * v) / (2 * G);
  const idealAir = (2 * v) / G;
  const up = breach(v, 90);
  check('straight up: apex matches v^2/2g',
    near(up.apex, idealApex, idealApex * 0.12),
    `${up.apex.toFixed(2)} u vs ${idealApex.toFixed(2)} ideal`);
  check('straight up: airtime matches 2v/g',
    near(up.air, idealAir, idealAir * 0.12),
    `${up.air.toFixed(2)} s vs ${idealAir.toFixed(2)} ideal`);

  // The control run, and the reason this test exists: the old code used the
  // seal's WATER friction above the surface too. Same launch, same gravity,
  // only the drag put back.
  const syrup = breach(v, 90, CONFIG.player.friction);
  check('the old water-friction-in-air really was what flattened it',
    syrup.apex < up.apex * 0.75,
    `${syrup.apex.toFixed(2)} u under water drag vs ${up.apex.toFixed(2)} u in air`);

  const idealRange = (v * v) / G; // sin(2*45deg) = 1
  const lob = breach(v, 45);
  check('45 degrees: the jump keeps its horizontal run',
    near(lob.range, idealRange, idealRange * 0.15),
    `${lob.range.toFixed(2)} u vs ${idealRange.toFixed(2)} ideal`);
  const syrupLob = breach(v, 45, CONFIG.player.friction);
  check('...which is what the water drag was eating',
    syrupLob.range < lob.range * 0.7,
    `${syrupLob.range.toFixed(2)} u under water drag`);
}

// ---------------------------------------------------------------------------
// SHOTS
// ---------------------------------------------------------------------------
function fireAt(y, opts = {}) {
  resetProjectiles(scene);
  spawnProjectile(scene, {
    origin: new THREE.Vector3(0, y, 0),
    dir: new THREE.Vector2(1, 0),
    faction: 'player',
    damage: 1, speed: 20, life: 99, radius: 0.2,
    asset: 'bullet',
    ...opts,
  });
  return projectiles[0];
}

function flyFor(seconds) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) updateProjectiles(dt, scene, []);
}

section('FALL — a shot that leaves the water is a thrown stone');
{
  const high = bounds.surfaceY + 12;
  const p = fireAt(high);
  const t = 0.5;
  flyFor(t);
  const drop = high - p.mesh.position.y;
  const ideal = 0.5 * G * t * t;
  check('a shot fired above the surface drops on gt^2/2',
    near(drop, ideal, ideal * 0.1),
    `${drop.toFixed(2)} u in ${t}s vs ${ideal.toFixed(2)} ideal`);
  check('and it is still travelling forward, not just falling',
    p.mesh.position.x > 8, `${p.mesh.position.x.toFixed(1)} u downrange`);

  // The control: the same shot under the line. Water carries a shell, which is
  // why every bullet in this game crosses the arena flat, and always has.
  const deep = bounds.surfaceY - 12;
  const q = fireAt(deep);
  flyFor(t);
  check('the same shot UNDER the line is still dead flat',
    Math.abs(q.mesh.position.y - deep) < 1e-6,
    `${(q.mesh.position.y - deep).toExponential(1)} u of droop`);
}

section('TOGETHER — the seal and its own bullet fall at the same rate');
{
  const t = 0.4;
  const start = bounds.surfaceY + 20;

  resetPlayer();
  player.mesh.position.set(0, start, 0);
  player.velocity.set(0, 0);
  for (let i = 0; i < Math.round(t / dt); i++) updatePlayer(dt, noInput);
  const sealDrop = start - player.mesh.position.y;

  const p = fireAt(start, { speed: 0.0001 });
  flyFor(t);
  const shellDrop = start - p.mesh.position.y;

  check('both drop the same distance from rest',
    near(sealDrop, shellDrop, Math.max(sealDrop, shellDrop) * 0.05),
    `seal ${sealDrop.toFixed(3)} u, shell ${shellDrop.toFixed(3)} u`);
}

section('POWERED — thrust is not free fall');
{
  const y = bounds.surfaceY + 12;
  // No enemies in the list, so the seeker never acquires and flies straight —
  // which is precisely the case being asserted: it holds its line anyway.
  const missile = fireAt(y, { homing: true, turnRate: 8, acquireRadius: 30 });
  flyFor(0.6);
  check('a missile under thrust holds its line',
    Math.abs(missile.mesh.position.y - y) < 1e-6,
    `${(missile.mesh.position.y - y).toExponential(1)} u of droop`);

  const scallop = fireAt(y, { jet: true, jetInterval: [0.2, 0.4], jetSpeed: [10, 18] });
  flyFor(0.6);
  check('a clapping scallop is not dragged down either',
    scallop.mesh.position.y >= y - 0.001 || scallop.dir.y !== 0,
    'its heading is its own');

  const opted = fireAt(y, { gravityScale: 0 });
  flyFor(0.6);
  check('gravityScale: 0 opts a shot out entirely',
    Math.abs(opted.mesh.position.y - y) < 1e-6);
}

section('NOSE — a falling shell follows its arc instead of sliding down it');
{
  const p = fireAt(bounds.surfaceY + 14, { orient: true });
  flyFor(0.5);
  check('its heading has turned downward', p.dir.y < -0.3, `dir.y ${p.dir.y.toFixed(2)}`);
  check('and the model turned with it',
    p.mesh.rotation.z < -Math.PI / 2,
    `${((p.mesh.rotation.z + Math.PI / 2) * 180 / Math.PI).toFixed(0)} degrees below level`);
  check('a shot gains speed as it falls, like a real one',
    p.speed > 20, `${p.speed.toFixed(1)} u/s from 20`);
}

// ---------------------------------------------------------------------------
// THE SCALE READOUT — not assertions. Gravity is the one tunable in this game
// with a right answer, so this prints what the CURRENT value works out to at
// the size the ocean is actually drawn, and what it costs.
// ---------------------------------------------------------------------------
section('SCALE — what the tuned value means in metres');
{
  const SEAL_METRES = 2.0; // an adult fur seal, nose to tail
  const sealUnits = 2.6 * 2.36; // assets.js `fit` x the assets.csv size row
  const metresPerUnit = SEAL_METRES / sealUnits;
  note(`the seal is ${sealUnits.toFixed(2)} u long for a ~${SEAL_METRES} m animal, so 1 u = ${metresPerUnit.toFixed(3)} m`);
  note(`gravity ${G} u/s^2 = ${(G * metresPerUnit).toFixed(2)} m/s^2 (real is 9.81)`);
  note(`top swim speed ${CONFIG.player.maxSpeed} u/s = ${(CONFIG.player.maxSpeed * metresPerUnit).toFixed(1)} m/s`);

  const dash = CONFIG.strike.dashSpeed;
  const plain = breach(CONFIG.player.maxSpeed, 90).apex;
  const dashApex = breach(dash, 90, CONFIG.arena.airDrag, CONFIG.strike.dashDuration).apex;
  const headroom = bounds.top - bounds.surfaceY;
  note(`a flat-out swim straight up (${CONFIG.player.maxSpeed} u/s) reaches ${plain.toFixed(1)} u`);
  note(`a full strike dash straight up (${dash} u/s) reaches ${dashApex.toFixed(1)} u; the ceiling is at ${headroom.toFixed(1)} u`);
  if (dashApex > headroom) {
    note(`  ^ the ceiling CATCHES it — arena.airScale wants ${Math.ceil((dashApex / bounds.frameTop) * 10) / 10} (it is ${CONFIG.arena.airScale})`);
  } else {
    note(`  ^ clears it with ${(headroom - dashApex).toFixed(1)} u to spare (a combo'd dash still won't; that has always been true)`);
  }
}

console.log(`\n${failures ? `${failures} FAILED` : 'all good'}`);
process.exit(failures ? 1 : 0);
