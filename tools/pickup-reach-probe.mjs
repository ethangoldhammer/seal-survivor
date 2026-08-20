#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:reach
//
// CAN YOU ACTUALLY TAKE IT BY TOUCHING IT. Walks the seal at one of each pickup
// and compares the distance it is collected at against how big the thing is
// DRAWN.
//
// This exists because of a bug that shipped and was invisible. `collectRadius`
// is one number for every pickup in the game, measured to a POINT, which was
// fine while all of them were the same half-unit ball. Once they were not — a
// bubble two and a half units across, a coral a unit and a half tall — the
// drawn body ran well outside the circle that took it, and the player swam
// through the visible thing with nothing happening.
//
// WHY NOBODY NOTICED, and the reason this harness turns the magnet OFF: the
// magnet drags a pickup the last half-unit in a single frame, so in ordinary
// play it hides the gap completely. With it on, every pickup here reports as
// collected — from INSIDE its own body, which reads as working. The reach is
// only measurable with the magnet out of the way.
//
// The walk TRACKS the pickup rather than following a straight line, because
// chum sinks and bubbles rise: a fixed horizontal approach misses both and
// reports "never taken" for a pickup that works perfectly.
//
//   node --import ./tools/vite-loader.mjs tools/pickup-reach-probe.mjs
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { bounds, seabedTopY } from '../path/src/arena.js';
import {
  updatePickups, resetPickups, spawnXpOrb, spawnStrikeOrb, spawnBubbleOrb,
  spawnRapidFireOrb, spawnChumChunk, bubbleRadius,
  pickups, strikeOrbs, bubbleOrbs, rapidFireOrbs, chumChunks,
} from '../path/src/entities/pickups.js';

const DT = 1 / 60;
const scene = new THREE.Scene();

function makePlayer(x, y) {
  const mesh = new THREE.Object3D();
  mesh.position.set(x, y, 0);
  return {
    mesh,
    velocity: new THREE.Vector3(0, 0, 0),
    // The REAL stat names — `pickupRadius` is what magnetRadius() reads. A stub
    // that invents a field name gets `undefined`, which turns the magnet off
    // and quietly measures a game with no magnet in it.
    stats: {
      // ZERO, on purpose. The magnet drags a pickup the last half-unit in a
      // single frame, so with it on every measurement below reports the gap
      // AFTER that leap rather than the distance at which contact was
      // registered — every pickup looks like it is taken from inside itself.
      // The question here is the reach, so the magnet is off and the seal has
      // to actually touch the thing.
      pickupRadius: 0,
      chumGulpRadius: 0,
      maxOxygen: 100,
      maxHp: 100,
    },
    oxygen: 50,
    hp: 100,
  };
}

// The drawn half-width of whatever is in `list`, straight off the mesh.
function drawnRadius(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const s = new THREE.Vector3();
  box.getSize(s);
  return Math.max(s.x, s.y) / 2;
}

const CASES = [
  ['chum orb', (p) => spawnXpOrb(scene, p, 10, 0.5), () => pickups],
  ['strike orb', (p) => spawnStrikeOrb(scene, p), () => strikeOrbs],
  ['bubble', (p) => spawnBubbleOrb(scene, p), () => bubbleOrbs],
  ['coral', (p) => spawnRapidFireOrb(scene, p), () => rapidFireOrbs],
  ['chunk', (p) => spawnChumChunk(scene, p), () => chumChunks],
];

console.log(`collectRadius ${CONFIG.pickups.collectRadius} · magnet off for the measurement\n`);
console.log('pickup        drawn r   taken at   verdict');

let bad = 0;
for (const [name, spawn, list] of CASES) {
  resetPickups(scene);
  const at = new THREE.Vector3(0, seabedTopY() + 12, 0);
  spawn(at);
  // Let a bubble finish swelling — a half-grown one is legitimately smaller.
  const arr = list();
  const entry = arr[arr.length - 1];
  if (name === 'bubble') {
    for (let i = 0; i < 180; i++) {
      updatePickups(DT, scene, makePlayer(0, -900), () => {}, null, null, null, null);
    }
  }
  const live = list()[0];
  if (!live) { console.log(`${name.padEnd(13)} — vanished before the walk`); bad++; continue; }
  const drawn = drawnRadius(live.mesh);
  const target = live.mesh.position.clone();

  // Walk in from 8 units out, one frame at a time, and record the separation on
  // the frame it is taken. Approaching along +x from the left.
  let took = null;
  const player = makePlayer(target.x - 8, target.y);
  const hits = () => { took = player.mesh.position.distanceTo(live.mesh.position); };
  for (let i = 0; i < 60 * 12 && took === null; i++) {
    // TRACK IT, don't walk a fixed line. Chum sinks and bubbles rise, so a
    // straight horizontal walk misses both and reports "never taken" for a
    // pickup that works perfectly — the probe's own bug, not the game's.
    const to = live.mesh.position.clone().sub(player.mesh.position);
    if (to.length() > 0.001) to.normalize();
    player.mesh.position.addScaledVector(to, 3 * DT);
    player.velocity.set(to.x * 3, to.y * 3, 0);
    updatePickups(
      DT, scene, player,
      () => hits(), () => hits(), () => hits(), () => hits(), () => hits(),
    );
    // Sitting on top of it and still not taken.
    if (player.mesh.position.distanceTo(live.mesh.position) < 0.01) break;
  }

  const ok = took !== null && took >= drawn * 0.75;
  if (!ok) bad++;
  console.log(
    `${name.padEnd(13)} ${drawn.toFixed(2).padStart(6)}   ${(took === null ? 'NEVER' : took.toFixed(2)).padStart(8)}   `
    + (took === null ? 'SWAM STRAIGHT THROUGH IT'
      : took >= drawn * 0.75 ? 'ok'
        : `taken ${(drawn / took).toFixed(1)}x INSIDE its own body`),
  );
  void entry;
  void bubbleRadius;
  void bounds;
}

console.log(`\n${bad === 0 ? 'All reachable.' : `${bad} pickup(s) are not taken on contact.`}`);
process.exit(bad === 0 ? 0 : 1);
