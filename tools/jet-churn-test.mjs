#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Jet churn: what a run of Bubble Jet builds and throws away.
//
// The same question tools/beam-churn-test.mjs asks, at a different address, and
// it was answered wrongly here for a while. removeJet argued there was "no
// churn to pool against — at most one jet alive, opened a handful of times a
// run". The first half is true. The second is measurable, and it is not a
// handful: hold + cool is 2.8-3.1s at every stack level, so a four-minute run
// opens about 140 jets, each building three mapped MeshBasicMaterials and
// disposing them on the way out.
//
// WHY THAT COSTS ANYTHING. three refcounts a compiled program by the materials
// using it. A jet is usually the only thing alive wearing this particular one,
// so the last dispose deletes the program and the next jet links the identical
// shader again from source. It showed up as the top line of the phone's own
// report — `basic,highp,srgb-linear,false,,uv,...` rebuilt 40 times in a 445s
// run, more than every other key put together — while the jet was on screen
// for well under half the time.
//
// So this asserts the pool:
//
//   1. THE CYCLE IS REAL. The number of jets a long run opens, printed rather
//      than assumed, because the old comment's mistake was an assumption
//      nobody had put a number against.
//   2. MATERIALS STOP SCALING WITH IT. Built settles at three and stays there
//      however many jets open.
//   3. NOTHING IS DISPOSED. One material dispose in removeJet is the whole bug
//      back, and it would still pass every other check here.
//   4. GEOMETRY IS STILL DISPOSED, which is the half that must NOT be pooled:
//      each ribbon owns a Float32Array sized to that jet's node count.
//
//   npm run test:jetchurn
// ---------------------------------------------------------------------------

import './dom-stub.mjs';

// bubbleJet paints its taper profile and glow sprite on a 2D canvas, and
// dom-stub returns null for getContext. Give it just enough to draw into — the
// pixels are never read here, only the object churn around them.
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
import {
  jets, updateJets, resetJets, jetStats,
  updateBubbleJet, resetBubbleJet,
} from '../path/src/systems/bubbleJet.js';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

// SEEN IS NOT BUILT. A pooled material reused on the next jet appears again in
// a per-run census and looks new; only a UUID never recorded before is a
// construction. Same distinction the beam suite had to learn.
let matsDisposed = 0;
let geosDisposed = 0;
const everMats = new Set();
const everGeos = new Set();
let freshMats = 0;
let freshGeos = 0;

const realMatDispose = THREE.Material.prototype.dispose;
THREE.Material.prototype.dispose = function () { matsDisposed++; return realMatDispose.call(this); };
const realGeoDispose = THREE.BufferGeometry.prototype.dispose;
THREE.BufferGeometry.prototype.dispose = function () { geosDisposed++; return realGeoDispose.call(this); };

function sample() {
  for (const j of jets) {
    if (!j.mesh) continue;
    j.mesh.traverse((o) => {
      if (o.material && !everMats.has(o.material.uuid)) { everMats.add(o.material.uuid); freshMats++; }
      if (o.geometry && !everGeos.has(o.geometry.uuid)) { everGeos.add(o.geometry.uuid); freshGeos++; }
    });
  }
}

const scene = new THREE.Scene();
const dt = 1 / 60;
const playerPos = new THREE.Vector3(0, 0, 0);
const aim = { x: 1, y: 0 };

function run(level, seconds) {
  resetJets(scene);
  resetBubbleJet(scene);
  matsDisposed = 0; geosDisposed = 0;
  freshMats = 0; freshGeos = 0;
  let opened = 0;
  let had = false;
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) {
    updateBubbleJet(dt, scene, playerPos, level, aim, null);
    updateJets(dt, scene, { enemies: [], playerPos, hooks: {} });
    sample();
    if (jets.length && !had) opened++;
    had = jets.length > 0;
  }
  return { opened, matsBuilt: freshMats, geosBuilt: freshGeos, matsDisposed, geosDisposed };
}

// ---------------------------------------------------------------------------
console.log('\nFour minutes of Bubble Jet, per stack level');
console.log('  lvl  cycle   jets opened  materials built  geometries built  materials disposed');
const rows = [];
for (const lvl of [1, 3, 6]) {
  const s = jetStats(lvl);
  const r = run(lvl, 240);
  rows.push({ lvl, cycle: (s.hold ?? 0) + (s.cool ?? 0), ...r });
  console.log(
    String(lvl).padStart(5),
    `${((s.hold ?? 0) + (s.cool ?? 0)).toFixed(2)}s`.padStart(7),
    String(r.opened).padStart(12),
    String(r.matsBuilt).padStart(17),
    String(r.geosBuilt).padStart(18),
    String(r.matsDisposed).padStart(19),
  );
}

console.log('\nThe program-refcount question');

// 1. The cycle, stated rather than assumed.
check('a long run really does open jets by the dozen, not a handful',
  rows.every((r) => r.opened >= 20),
  `${rows.map((r) => `lvl${r.lvl}: ${r.opened}`).join(', ')} in 240s`);

// 2. Built stops scaling with how many open. Three materials per jet, so the
// ceiling is three plus a little slack — what this rules out is the shape that
// was wrong, materials rising with the jet count.
for (const r of rows) {
  check(`level ${r.lvl}: materials built stay at the pool size, not the jet count`,
    r.matsBuilt <= 6,
    `${r.matsBuilt} built across ${r.opened} jets`);
}

// 3. The assertion that actually guards the fix.
for (const r of rows) {
  check(`level ${r.lvl}: no material is disposed mid-run`,
    r.matsDisposed === 0, `${r.matsDisposed} disposed`);
}

// 4. ...and the half that must keep being disposed. A ribbon owns a
// Float32Array sized to its own node count; pooling those would hold the
// largest one ever built for the rest of the run.
for (const r of rows) {
  check(`level ${r.lvl}: ribbon geometry is still handed back`,
    r.geosDisposed > 0 && r.geosDisposed >= r.opened,
    `${r.geosDisposed} disposed across ${r.opened} jets`);
}

// 5. THE REFCOUNT QUESTION ASKED DIRECTLY: a second run on the same pool has
// nothing left to build. If the program had been released in the quiet frames
// of the first, this is where it would have to link it again.
const second = run(6, 240);
check('a second run builds no materials at all — the pool still holds the program',
  second.matsBuilt === 0,
  `${second.matsBuilt} built across ${second.opened} jets`);

const worst = rows[rows.length - 1];
console.log(`\n  At level ${worst.lvl}: ${worst.opened} jets opened, ${worst.matsBuilt} materials built,`);
console.log(`  ${worst.matsDisposed} disposed. A second run on the same pool built ${second.matsBuilt}.`);
console.log('  Nothing relinks, because nothing was ever released.\n');

process.exit(failures ? 1 : 0);
