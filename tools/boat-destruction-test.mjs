#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:boats
//
// Sinks a boat headlessly and checks that everything the explosion is supposed
// to produce actually exists afterwards: chunks in the water, crew off the
// deck, chum under the surface, and all of it still finite a few seconds later.
//
// This was the one new system with no coverage. The others each have a harness
// because the browser preview suspends requestAnimationFrame — a screenshot of
// this game proves nothing about whether its loop works — and boat destruction
// is the hardest of them to eyeball anyway: it is one frame of chaos followed
// by thirty seconds of sinking, so "did it look right" and "is it correct" are
// genuinely different questions.
//
// No renderer is involved: three.js Scene/Object3D/Mesh are plain data and
// nothing here draws.
//
//   node --import ./tools/vite-loader.mjs tools/boat-destruction-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { bounds } from '../path/src/arena.js';
import { boats, damageBoat, resetBoats } from '../path/src/systems/boats.js';
import {
  boatDebris, primeBoatDebris, updateBoatDebris, damageDebris, resetBoatDebris,
} from '../path/src/systems/boatDebris.js';
import { crew, spawnCrewFor, updateCrew, resetCrew } from '../path/src/systems/crew.js';
import { pickups } from '../path/src/entities/pickups.js';

let fails = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails++; };
const section = (s) => console.log(`\n${s}`);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

const scene = new THREE.Scene();

// A boat is measured into chunks from whatever meshes hang off its root (see
// bakedParts), so the stand-in needs real geometry — an empty Object3D is
// measured as nothing and the wreck comes out empty. Three boxes, roughly a
// hull, a cabin and a mast, is enough shape to be cut up.
function boatMesh(x, y) {
  const root = new THREE.Object3D();
  const mat = new THREE.MeshStandardMaterial({ color: 0x8899aa });
  const add = (w, h, d, ox, oy) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(ox, oy, 0);
    root.add(m);
  };
  add(6, 1.2, 2.2, 0, 0);      // hull
  add(2.2, 1.4, 1.8, -0.6, 1.3); // cabin
  add(0.3, 3.2, 0.3, 1.4, 2.2);  // mast
  root.position.set(x, y, 0);
  root.updateMatrixWorld(true);
  scene.add(root);
  return root;
}

function makeBoat(x, y, hp = 60, isTrawler = false) {
  const mesh = boatMesh(x, y);
  const b = {
    mesh, hp, maxHp: hp, isTrawler, assetKey: isTrawler ? 'testTrawler' : 'testBoat',
    halfLength: 3, halfHeight: 0.8, offsetX: 0, offsetY: 0, radius: 3.2,
    knockX: 0, knockY: 0, rockVel: 0, rock: 0, flash: 0, dir: 1,
    sailX: x, speed: 2, spawnScale: 1,
  };
  primeBoatDebris(mesh, b.assetKey);
  boats.push(b);
  spawnCrewFor(scene, b);
  return b;
}

function clearAll() {
  resetBoats(scene);
  resetBoatDebris(scene);
  resetCrew(scene);
  pickups.length = 0;
}

// ---------------------------------------------------------------------------
section('THE EXPLOSION');
clearAll();
const boat = makeBoat(8, bounds.surfaceY - 0.4);
const crewAboard = crew.length;
check(crewAboard > 0, `someone is sailing it — ${crewAboard} aboard`);

let broke = 0;
const destroyed = damageBoat(scene, 0, 9999, {
  onBoatDestroyed: () => { broke++; },
});

check(destroyed === true, 'damageBoat reports the hull destroyed');
check(broke === 1, 'the onBoatDestroyed hook fired exactly once');
check(boats.length === 0, 'the boat left the list');
check(boatDebris.length > 0, `the wreck threw chunks — ${boatDebris.length}`);
check(crew.length >= crewAboard, `the crew outlived the boat — ${crew.length} still tracked`);
check(pickups.length > 0, `the catch spilled — ${pickups.length} chum orb(s)`);

// ---------------------------------------------------------------------------
section('WHERE THE CHUM STARTS');
// The hull rides the surface on a bob, so a drop measured straight off it can
// start fractionally in the air. boats.js clamps for exactly this.
const airborne = pickups.filter((p) => p.mesh.position.y > bounds.surfaceY);
check(airborne.length === 0, `no chum starts above the water line (${airborne.length} did)`);
const moving = pickups.filter((p) => Math.abs(p.vx ?? 0) > 1e-6);
check(moving.length > 0, `chum bursts outward rather than appearing pre-spread — ${moving.length} with sideways velocity`);
const spread = pickups.map((p) => p.mesh.position.x);
check(Math.max(...spread) - Math.min(...spread) > 0.5, 'the orbs are scattered along the hull, not stacked');

// ---------------------------------------------------------------------------
section('THE WRECK SINKS');
const startY = boatDebris.map((d) => d.group.position.y);
const startCount = boatDebris.length;
let nan = 0;
for (let i = 0; i < 240; i++) { // ~4s at 60fps
  updateBoatDebris(1 / 60, scene);
  updateCrew(1 / 60, scene);
  for (const d of boatDebris) {
    if (!finite(d.group.position.x) || !finite(d.group.position.y)) nan++;
  }
  for (const p of crew) {
    const pos = p.body.group.position;
    if (!finite(pos.x) || !finite(pos.y)) nan++;
  }
}
check(nan === 0, 'no chunk or crewman ever reaches a NaN position');
const nowY = boatDebris.map((d) => d.group.position.y);
const sank = nowY.filter((y, i) => y < (startY[i] ?? Infinity)).length;
check(boatDebris.length === 0 || sank > 0, `wreckage falls — ${sank} of ${startCount} chunk(s) below where they started`);
const aboveSky = boatDebris.filter((d) => d.group.position.y > bounds.surfaceY + 40);
check(aboveSky.length === 0, 'nothing is launched out of the world');

// ---------------------------------------------------------------------------
section('WRECKAGE IS SHOOTABLE');
clearAll();
makeBoat(0, bounds.surfaceY - 0.4);
damageBoat(scene, 0, 9999, {});
check(boatDebris.length > 0, `a fresh wreck to shoot — ${boatDebris.length} chunk(s)`);

const target = boatDebris[0];
const at = target.group.position.clone();
let hits = 0; let breaks = 0;
const hitOnce = damageDebris(scene, at.x, at.y, 0.4, 1, {
  single: true,
  onDebrisHit: () => { hits++; },
  onDebrisBroken: () => { breaks++; },
});
// damageDebris returns how many chunks it struck, not a boolean — combat.js
// reads it truthily (`if (!hit) continue`), so 0 is the "missed" answer and
// any positive count means the bullet was spent on wreckage.
check(hitOnce === 1, `a bullet at a chunk strikes exactly one — returned ${hitOnce}`);
check(hits === 1, `...and fires one onDebrisHit — ${hits}`);

// Keep hitting the same spot until something gives, so the break path runs.
for (let i = 0; i < 400 && breaks === 0; i++) {
  damageDebris(scene, at.x, at.y, 0.6, 25, {
    single: true,
    onDebrisHit: () => {},
    onDebrisBroken: () => { breaks++; },
  });
  updateBoatDebris(1 / 60, scene);
}
check(breaks > 0, 'sustained fire eventually breaks a chunk apart');

const missed = damageDebris(scene, 9999, 9999, 0.4, 10, { single: true });
check(missed === 0, `a shot nowhere near the wreck strikes nothing — returned ${missed}`);
check(damageDebris(scene, at.x, at.y, 0.4, 0, {}) === 0, 'a zero-damage hit is not a hit');

// ---------------------------------------------------------------------------
section('IT ALL GOES AWAY');
clearAll();
makeBoat(-6, bounds.surfaceY - 0.4);
damageBoat(scene, 0, 9999, {});
const peakDebris = boatDebris.length;
const peakCrew = crew.length;
for (let i = 0; i < 60 * 90; i++) { // 90 seconds
  updateBoatDebris(1 / 60, scene);
  updateCrew(1 / 60, scene);
}
check(boatDebris.length < peakDebris, `wreckage is cleaned up — ${peakDebris} → ${boatDebris.length}`);
check(crew.length < peakCrew || peakCrew === 0, `crew is cleaned up — ${peakCrew} → ${crew.length}`);

clearAll();
check(boatDebris.length === 0 && crew.length === 0 && boats.length === 0, 'reset clears every list');

console.log(`\n${fails === 0 ? 'PASS — all checks' : `FAIL — ${fails} check(s)`}`);
process.exit(fails ? 1 : 0);
