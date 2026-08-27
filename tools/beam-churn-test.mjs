#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Beam churn: what one minute of laser eyes builds and throws away.
//
// THE NUMBER THAT MATTERS IS NOT HOW MANY ARE BUILT. The beam list reaching
// EMPTY between volleys is fine and always will — a beam that has finished
// burning is gone. What mattered was what happened at that moment: three.js
// refcounts a compiled program by the materials using it, so when the last one
// was DISPOSED the program was deleted, and the next volley linked the
// identical shader again from source.
//
// systems/beams.js pools them now. A retired beam's three materials go on a
// free list instead of being disposed, so the refcount never reaches zero and
// a volley arriving after ten quiet seconds finds its shader already linked.
// The geometry is one shared unit quad, because a beam's length and width are
// mesh.scale and nothing ever writes a vertex.
//
// So this asserts the pool, not the absence of gaps:
//
//   1. materials built stops scaling with volleys — it settles at the most
//      beams alive at once, times three, and stops.
//   2. NOTHING is disposed during a run. One dispose is the whole bug back.
//   3. a second minute builds nothing at all, which is the refcount question
//      stated directly: the pool from minute one still holds the program.
//
//   npm run test:beamchurn
// ---------------------------------------------------------------------------

import './dom-stub.mjs';

// beams.js paints its taper profile and glow sprite on a 2D canvas. dom-stub
// returns null for getContext, so give it just enough to draw into — the pixels
// are never read back here, only the object churn around them is.
document.createElement = (tag) => ({
  tagName: tag, width: 0, height: 0, style: {},
  getContext: () => ({
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {}, fillRect: () => {}, clearRect: () => {},
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    set fillStyle(_v) {}, get fillStyle() { return '#000'; },
  }),
});

import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { beams, updateBeams, resetBeams } from '../path/src/systems/beams.js';
import { updateLaserEyes, setLaserAim, resetLaserEyes } from '../path/src/systems/laserEyes.js';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

// Count what gets built and thrown away. The module namespace is frozen, so
// creations are counted by the UUIDs that actually appear on the beam meshes
// (a fresh UUID is a fresh object) and disposals on the prototypes.
let matsDisposed = 0; let geosDisposed = 0;
const seenMats = new Set();
const seenGeos = new Set();
// SEEN IS NOT BUILT, and conflating them made the second-minute check read its
// own bookkeeping instead of the code: `seenMats` is cleared per run, so a
// POOLED material reused in minute two lands in it again and looks new. These
// two are never cleared, so "how many did this run construct" is the count of
// UUIDs that had never appeared before — which is the only number the pool
// changes.
const everMats = new Set();
const everGeos = new Set();
let freshMats = 0; let freshGeos = 0;
const realMatDispose = THREE.Material.prototype.dispose;
THREE.Material.prototype.dispose = function () { matsDisposed++; return realMatDispose.call(this); };
const realGeoDispose = THREE.BufferGeometry.prototype.dispose;
THREE.BufferGeometry.prototype.dispose = function () { geosDisposed++; return realGeoDispose.call(this); };

function sampleBeams() {
  for (const b of beams) {
    if (!b.mesh) continue;
    b.mesh.traverse((o) => {
      if (o.material) {
        seenMats.add(o.material.uuid);
        if (!everMats.has(o.material.uuid)) { everMats.add(o.material.uuid); freshMats++; }
      }
      if (o.geometry) {
        seenGeos.add(o.geometry.uuid);
        if (!everGeos.has(o.geometry.uuid)) { everGeos.add(o.geometry.uuid); freshGeos++; }
      }
    });
  }
}

const scene = new THREE.Scene();
const dt = 1 / 60;
const playerPos = new THREE.Vector3(0, 0, 0);
const aim = { x: 1, y: 0 };

function run(level, seconds) {
  resetBeams(scene);
  resetLaserEyes?.();
  matsDisposed = geosDisposed = 0;
  seenMats.clear(); seenGeos.clear();
  freshMats = 0; freshGeos = 0;
  let emptyFrames = 0; let volleys = 0; let wasEmpty = true; let peak = 0;
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) {
    setLaserAim(aim);
    updateLaserEyes(dt, scene, playerPos, level, aim);
    updateBeams(dt, scene, {
      enemies: [], playerPos, playerRadius: 1, hooks: {},
    });
    sampleBeams();
    if (beams.length === 0) { emptyFrames++; wasEmpty = true; }
    else { if (wasEmpty) volleys++; wasEmpty = false; }
    peak = Math.max(peak, beams.length);
  }
  return {
    emptyFrames, frames, volleys, peak,
    matsBuilt: freshMats, geosBuilt: freshGeos,
    matsLive: seenMats.size, geosLive: seenGeos.size,
    matsDisposed, geosDisposed,
  };
}

console.log('\nOne minute of laser eyes, per stack level');
console.log('  lvl  volleys  peak beams  materials built  geometries built  frames with ZERO beams');
const rows = [];
for (const lvl of [1, 3, 6]) {
  const r = run(lvl, 60);
  rows.push({ lvl, ...r });
  console.log(
    String(lvl).padStart(5),
    String(r.volleys).padStart(8),
    String(r.peak).padStart(12),
    String(r.matsBuilt).padStart(17),
    String(r.geosBuilt).padStart(18),
    `${String(r.emptyFrames).padStart(15)} / ${r.frames}`,
  );
}

console.log('\nThe program-refcount question');

// 1. BUILT IS BOUNDED BY WHAT IS ALIVE AT ONCE, not by how often beams fire.
// Three materials per beam, so the ceiling is peak*3 — plus a little slack,
// because a volley whose beams retire in different frames can hand the pool
// back one at a time. What this rules out is the shape that was wrong:
// materials rising with the volley count.
for (const r of rows) {
  const ceiling = r.peak * 3 + 3;
  check(
    `level ${r.lvl}: materials built stay near the peak beam count, not the volley count`,
    r.matsBuilt <= ceiling,
    `${r.matsBuilt} built for ${r.volleys} volleys, peak ${r.peak} beams (ceiling ${ceiling})`,
  );
}

// 2. NOTHING IS DISPOSED. This is the assertion that actually guards the fix:
// a single dispose in removeBeam puts the whole bug back, and it would still
// pass every check above.
for (const r of rows) {
  check(
    `level ${r.lvl}: nothing is disposed mid-run`,
    r.matsDisposed === 0 && r.geosDisposed === 0,
    `${r.matsDisposed} material(s), ${r.geosDisposed} geometr(y/ies)`,
  );
}

// 3. THE REFCOUNT QUESTION, ASKED DIRECTLY. Run a second minute WITHOUT
// resetting the pool. If the program was released in the quiet frames of
// minute one, minute two has to build again; if the pool held it, minute two
// builds nothing. `run()` calls resetBeams, which retires every live beam into
// the pool rather than disposing it — that is the state a real run is in
// between two bursts of fighting.
const second = run(6, 60);
check(
  'a second minute builds nothing — the pool from the first still holds the program',
  second.matsBuilt === 0,
  `${second.matsBuilt} material(s) built across ${second.volleys} volleys`,
);

// The geometry is shared outright, so every beam that ever burns sees one.
check(
  'every beam that ever burns shares one quad',
  everGeos.size === 1,
  `${everGeos.size} geometr(y/ies) across every run`,
);

const worst = rows[rows.length - 1];
console.log(`\n  At level ${worst.lvl}: ${worst.volleys} volleys built ${worst.matsBuilt} materials`);
console.log(`  and disposed ${worst.matsDisposed}. A second minute on the same pool built ${second.matsBuilt}.`);
console.log(`  Nothing relinks, because nothing was ever released.\n`);

process.exit(failures ? 1 : 0);
