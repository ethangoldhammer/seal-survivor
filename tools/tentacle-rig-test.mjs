#!/usr/bin/env node
// The bone driver for the man o' war's filaments.
//
//   npm run test:tentaclerig
//
// NO GLB LOADS IN NODE, so this builds the skeleton by hand — the same shape
// tools/rig-manowar.mjs writes, named the same way, because the NAMES are the
// contract between the three files and a test that invented its own would prove
// nothing about the real one. What is under test is the driver: which chains it
// finds, what it does to them, and what it puts back.
//
// THE ONE THAT MATTERS IS THE RATCHET. These bones carry no animation clip, so
// nothing else in the game ever resets them — a driver that accumulated onto
// the live quaternion instead of rebuilding from a captured rest pose would
// wind the filaments up a little more every frame and the animal would slowly
// tie itself in a knot. It is invisible for the first few seconds, which is
// exactly as long as anyone looks.
import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { createTentacleRig } from '../path/src/systems/tentacleRig.js';

let fail = 0;
const check = (n, ok, d = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? ` — ${d}` : ''}`);
  if (!ok) fail++;
};

// The real rig's shape: 18 strands, 3-6 bones each, plus the float and crest
// that must NOT be picked up.
const STRANDS = 18;
function buildVisual() {
  const bones = [];
  const root = new THREE.Bone(); root.name = 'float';
  const crest = new THREE.Bone(); crest.name = 'crest';
  root.add(crest);
  bones.push(root, crest);
  for (let s = 0; s < STRANDS; s++) {
    const n = s < 4 ? 6 : (s < 16 ? 5 : 3);
    let parent = root;
    for (let k = 0; k < n; k++) {
      const b = new THREE.Bone();
      b.name = `strand${s}_${k}`;
      b.position.set(0, -0.6, 0);
      parent.add(b);
      bones.push(b);
      parent = b;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial());
  mesh.add(root);
  mesh.bind(new THREE.Skeleton(bones));
  const visual = new THREE.Group();
  visual.add(mesh);
  return { visual, bones };
}

const { visual, bones } = buildVisual();
const rig = createTentacleRig(visual);

console.log('\nWHAT IT FINDS');
check('it builds a rig from the skeleton', !!rig);
if (!rig) process.exit(1);
check('...and finds every strand', rig.strands === STRANDS, `${rig.strands}`);
check('...and only the strands — the float and crest are not filaments',
  rig.bones === bones.length - 2, `${rig.bones} of ${bones.length} bones`);
check('it declines a model with no chains', createTentacleRig(new THREE.Group()) === null);

const strandBones = bones.filter((b) => /^strand\d+_/.test(b.name));
const restOf = () => strandBones.map((b) => b.quaternion.clone());
const rest = restOf();
const maxDelta = (a, b) => a.reduce((m, q, i) => Math.max(m, q.angleTo(b[i])), 0);

console.log('\nIT MOVES THEM');
for (let i = 0; i < 30; i++) rig.update(1 / 60, 0.3);
const posed = restOf();
check('the bones actually move', maxDelta(rest, posed) > 0.05,
  `max ${maxDelta(rest, posed).toFixed(3)} rad`);

console.log('\nNO RATCHET');
// The failure this file exists for: run it a long time, then reset, and every
// bone must be EXACTLY where the file had it — not approximately.
for (let i = 0; i < 60 * 60; i++) rig.update(1 / 60, 0.3);
rig.reset();
check('reset puts every bone back exactly', maxDelta(rest, restOf()) < 1e-9,
  `max ${maxDelta(rest, restOf()).toExponential(2)} rad after a minute of driving`);
// ...and the pose at a given wave position does not depend on how long it ran.
rig.reset();
for (let i = 0; i < 30; i++) rig.update(1 / 60, 0.3);
const again = restOf();
// 1e-5 rad, not 1e-9. The wave position is an ACCUMULATOR — `t += dt * rate` —
// so after the minute of driving above it has been through 3,630 additions and
// carries about 5e-8 rad of float error against a freshly reset one. That is
// not the thing this checks for: a driver that accumulated onto the live
// quaternion instead of rebuilding from the rest pose would be off by a
// fraction of `amplitude` PER FRAME, which is 0.28 rad and four orders of
// magnitude the far side of this line.
check('...and the same elapsed time gives the same pose', maxDelta(posed, again) < 1e-5,
  `max ${maxDelta(posed, again).toExponential(2)} rad`);

console.log('\nIT IS A TRAVELLING WAVE, NOT A SWING');
rig.reset();
rig.update(0.4, 0);
const chain0 = strandBones.filter((b) => /^strand0_/.test(b.name));
const angles = chain0.map((b, i) => b.quaternion.angleTo(rest[strandBones.indexOf(b)]));
console.log(`  strand0 bend by bone, crown to tip: ${angles.map((a) => a.toFixed(3)).join('  ')}`);
// THE LAG. Neighbouring bones are at different points of the wave, which is
// what separates a hanging filament from a rotating wire. Compared as a SET —
// a phase test on one pair can pass at a moment when that pair happens to
// straddle a peak.
const distinct = new Set(angles.map((a) => a.toFixed(3))).size;
check('neighbouring bones are at different points of the wave', distinct >= angles.length - 1,
  `${distinct} distinct of ${angles.length}`);
// THE FALLOFF. The crown is anchored and the tip trails, which is `hold`.
check('the tip moves more than the crown', angles[angles.length - 1] > angles[0],
  `crown ${angles[0].toFixed(3)} vs tip ${angles[angles.length - 1].toFixed(3)}`);
check('...but the crown is not welded rigid', angles[0] > 0.001,
  `${angles[0].toFixed(4)} — CONFIG.tentacleRig.hold is ${CONFIG.tentacleRig.hold}`);

console.log('\nEIGHTEEN OF THEM ARE NEVER IN STEP');
const perStrand = [];
for (let s = 0; s < STRANDS; s++) {
  const b = strandBones.find((x) => x.name === `strand${s}_1`);
  perStrand.push(b.quaternion.angleTo(rest[strandBones.indexOf(b)]));
}
const spread = Math.max(...perStrand) - Math.min(...perStrand);
check('the strands are spread across the wave', spread > 0.05, `spread ${spread.toFixed(3)} rad`);
check('...and no two share a pose', new Set(perStrand.map((a) => a.toFixed(4))).size >= STRANDS - 2,
  `${new Set(perStrand.map((a) => a.toFixed(4))).size} distinct of ${STRANDS}`);

console.log('\nIT CAN BE SWITCHED OFF');
rig.reset();
const before = restOf();
CONFIG.tentacleRig.enabled = false;
for (let i = 0; i < 30; i++) rig.update(1 / 60, 0);
check('enabled:false leaves the rest pose alone', maxDelta(before, restOf()) < 1e-9);
CONFIG.tentacleRig.enabled = true;

console.log(`\n${fail ? `${fail} FAILED` : 'all checks passed'}\n`);
process.exit(fail ? 1 : 0);
