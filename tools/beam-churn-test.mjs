#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Beam churn: what one minute of laser eyes builds and throws away.
//
// systems/beams.js builds three MeshBasicMaterials and three PlaneGeometries
// per beam (buildMesh) and disposes all six in removeBeam. That is deliberate —
// the comment there is right that beams must not share an opacity — but the
// materials are rebuilt from scratch every volley rather than pooled.
//
// The number that matters is not how many are built, it is whether the beam
// list ever reaches EMPTY between volleys. three.js refcounts a compiled
// program by the materials using it; when the last one is disposed the program
// is deleted, and the next volley has to link it again. A gap of even one
// frame with zero beams turns every volley into a shader link.
//
//   node --import ./tools/vite-loader.mjs tools/beam-churn-test.mjs
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
const realMatDispose = THREE.Material.prototype.dispose;
THREE.Material.prototype.dispose = function () { matsDisposed++; return realMatDispose.call(this); };
const realGeoDispose = THREE.BufferGeometry.prototype.dispose;
THREE.BufferGeometry.prototype.dispose = function () { geosDisposed++; return realGeoDispose.call(this); };

function sampleBeams() {
  for (const b of beams) {
    if (!b.mesh) continue;
    b.mesh.traverse((o) => {
      if (o.material) seenMats.add(o.material.uuid);
      if (o.geometry) seenGeos.add(o.geometry.uuid);
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
    matsBuilt: seenMats.size, geosBuilt: seenGeos.size, matsDisposed, geosDisposed,
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
for (const r of rows) {
  check(
    `level ${r.lvl}: the beam list empties between volleys`,
    r.emptyFrames > 0,
    `${r.emptyFrames} of ${r.frames} frames have no beam alive at all`,
  );
}
const worst = rows[rows.length - 1];
check(
  'every material built is also disposed (no leak — this is churn, not a leak)',
  worst.matsBuilt === worst.matsDisposed && worst.geosBuilt === worst.geosDisposed,
  `${worst.matsBuilt} built / ${worst.matsDisposed} disposed`,
);
console.log(`\n  At level ${worst.lvl} that is ${worst.matsBuilt} materials and ${worst.geosBuilt} geometries`);
console.log(`  built and destroyed per minute, across ${worst.volleys} volleys that each start from an empty list.`);
console.log(`  Every one of those volleys is a fresh shader link, because nothing held the program.\n`);

process.exit(failures ? 1 : 0);
