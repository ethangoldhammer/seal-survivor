#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:eelsparks
//
// THE EEL'S ORBIT — systems/eelSparks.js, and the chain that leaves it.
//
// Whether the sparks LOOK like charge is a question for the water and for
// `npm run looks:bolt`; none of it is attempted here. What is here is the set
// of ways an attractor-driven ornament goes wrong while still rendering
// something plausible every frame:
//
//   THE STATE LEFT THE ATTRACTOR. Aizawa has a cubic term, so a step too long
//   does not wobble — it diverges, and the position is 1e30 or NaN. A NaN in a
//   shared vertex buffer is not one missing spark: it is a geometry whose
//   bounding sphere is NaN, which some drivers cull ENTIRELY, so the whole
//   orbit disappears and nothing anywhere throws. The system reseeds rather
//   than dropping the spark, and that path is tested by forcing it.
//
//   THE ORBIT BECAME A CIRCLE. The whole reason this is an attractor and not a
//   sine is that a sine reads as machinery. A retune that flattens the radius
//   variation has quietly bought the gear back, and it is exactly the sort of
//   thing nobody notices in a screenshot.
//
//   THE TUBE WAS BUILT IN THE WRONG FRAME. The orbit runs the eel's LENGTH, and
//   the body axis is read off the mesh's own rotation. Read in world axes
//   instead it looks perfect on a fish swimming right and puts the charge in
//   open water beside the animal at every other heading — a bug that is correct
//   in exactly the screenshot anyone would take of it.
//
//   THE WAVE STOPPED LOOPING. Its phase is wrapped into 0..1 every frame, which
//   is only safe while every harmonic has an integer frequency. One that does
//   not makes the whole cloud jolt once a second forever, and it gets blamed on
//   the attractor. Nothing on screen can show this; the identity can.
//
//   THE SPEED CAP DID NOT CAP. It shortens the integration STEP rather than the
//   move, which is the only version that preserves the path — and the version
//   that silently does nothing if the arithmetic is wrong, because the sparks
//   still fly and still trace the shape.
//
//   THE TAIL SMEARED. The samples are kept in the EEL'S OWN body frame. Kept in
//   the world they turn into a straight streak behind a swimming eel, which is
//   invisible in a still frame and is the entire look in motion.
//
//   THE CHAIN DID NOT LEAVE THE ORBIT. The point of all of it: the arc's first
//   point is a spark and its neighbours throw arcs into that same spot. One
//   wrong index and the bolt starts inside the animal again, which is what it
//   used to do.
//
//   node --import ./tools/vite-loader.mjs tools/eel-spark-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { player } from '../path/src/entities/player.js';
import {
  updateEel, resetEel, resetEelBolts, createEelCompanion, resetEelCompanion, spawnEelChain,
} from '../path/src/systems/eel.js';
import {
  updateEelSparks, resetEelSparks, eelSparkPoints, eelSparkCount, eelSparkFlare,
  sparkLaunchPoint, sparkFeeders, eelWiggle,
} from '../path/src/systems/eelSparks.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// SEEDED. Every spark is born at a random point in the basin and flown a random
// number of warm-up steps onto the shape, so an unseeded run of this file is a
// different eighteen trajectories every time — and a threshold that passes on
// most of them is a test that fails once a fortnight in someone else's branch.
let _seed = 20260916;
Math.random = () => { _seed = (_seed * 1664525 + 1013904223) >>> 0; return _seed / 4294967296; };

const DT = 1 / 60;
const S = CONFIG.eel.sparks;
const scene = new THREE.Scene();
scene.add(createEelCompanion());

// The storm snapshot the system takes. Clear weather, so this is CONFIG.eel as
// typed — the sparks read their colour and their block off it.
const cfg = CONFIG.eel;

// Lying along +X unless a check says otherwise, so "along the body" is x and
// "off the body" is y — which makes every distance below readable.
function fly(seconds, x = 0, y = 0, level = 1, angle = 0) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) updateEelSparks(DT, scene, x, y, angle, level, cfg);
}

// ---------------------------------------------------------------------------
section('HOW MANY — the level ramp');
// ---------------------------------------------------------------------------
check('level 0 carries no charge', eelSparkCount(S, 0) === 0);
check('level 1 is the tuned count', eelSparkCount(S, 1) === Math.round(S.count),
  `${eelSparkCount(S, 1)}`);
check('a stack adds sparks', eelSparkCount(S, 4) > eelSparkCount(S, 1),
  `L1 ${eelSparkCount(S, 1)} → L4 ${eelSparkCount(S, 4)}`);
check('and it stops at the ceiling', eelSparkCount(S, 99) === S.countMax, `${eelSparkCount(S, 99)}`);
check('a disabled block is no sparks at any level',
  eelSparkCount({ ...S, enabled: false }, 8) === 0);

// ---------------------------------------------------------------------------
section('THE POOL — built, torn down, and in the scene');
// ---------------------------------------------------------------------------
resetEelSparks(scene);
const before = scene.children.length;
fly(2);
check('a level-1 eel puts one group in the water', scene.children.length === before + 1,
  `${scene.children.length - before} added`);
check('...holding the two ribbons (cores and haloes)',
  scene.children[scene.children.length - 1].children.length === 2);
check('every spark is alive', eelSparkPoints().length === eelSparkCount(S, 1));

updateEelSparks(DT, scene, 0, 0, 0, 0, cfg);
check('level 0 tears the pool down', scene.children.length === before);
check('...and empties the list', eelSparkPoints().length === 0);

// A level-up adds sparks. The ones already flying must not move: a pool that
// reseeded wholesale would have the whole orbit jump on the frame the card is
// taken, which reads as the ability restarting rather than growing.
resetEelSparks(scene);
fly(3, 0, 0, 1);
const atOne = eelSparkPoints();
fly(DT, 0, 0, 2);
const atTwo = eelSparkPoints();
check('a level-up adds sparks without moving the ones already flying',
  atTwo.length > atOne.length
  && atOne.every((p, i) => Math.hypot(p.x - atTwo[i].x, p.y - atTwo[i].y) < 0.4),
  `${atOne.length} → ${atTwo.length}`);

// ---------------------------------------------------------------------------
section('THE SHAPE — a lap of the whole body, not a ring about a point');
// ---------------------------------------------------------------------------
// The eel lies along +X throughout, so `along` is the x offset and `off` is the
// y one, and every number below reads directly.
const HALF = S.length / 2;
const OFF = S.radius + (S.wiggle?.amp ?? 0);
// `offset` slides the whole orbit down the body — the companion's origin is at
// its pivot, near the head — so it comes off the along-axis before anything is
// measured, or every extent below reads as lopsided.
const along = (x = 0) => eelSparkPoints().map((p) => p.x - x - S.offset);
const off = (y = 0) => eelSparkPoints().map((p) => p.y - y);

resetEelSparks(scene);
fly(6, 0, 0, 8);
check('every spark is somewhere finite', eelSparkPoints().every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
const al = along();
const of = off();
check('the charge runs the whole length of the animal',
  Math.max(...al) - Math.min(...al) > S.length * 0.5,
  `${(Math.max(...al) - Math.min(...al)).toFixed(2)} of ${S.length}`);
check('...and none of it hangs off either end',
  Math.max(...al.map(Math.abs)) <= HALF * 1.05,
  `furthest ${Math.max(...al.map(Math.abs)).toFixed(2)} vs half-length ${HALF.toFixed(2)}`);
check('...and it stays close in to the body',
  Math.max(...of.map(Math.abs)) <= OFF * 1.1,
  `furthest ${Math.max(...of.map(Math.abs)).toFixed(2)} vs ${OFF.toFixed(2)}`);

// TURN THE EEL AND THE TUBE TURNS WITH IT. The body axis is read off the mesh's
// own rotation, so the one way this breaks is by being read in the wrong frame —
// which looks fine on a fish swimming right and puts the charge in open water
// beside every other heading.
resetEelSparks(scene);
fly(6, 0, 0, 8, Math.PI / 2);
// Nose now points along +Y, so the two axes swap AND the offset moves with
// them — measuring it in the old frame is exactly the bug this is here for.
const turnedAlong = eelSparkPoints().map((p) => p.y - S.offset);
const turnedOff = eelSparkPoints().map((p) => p.x);
check('an eel lying the other way carries its charge with it',
  Math.max(...turnedAlong.map(Math.abs)) <= HALF * 1.05
  && Math.max(...turnedAlong) - Math.min(...turnedAlong) > S.length * 0.5
  && Math.max(...turnedOff.map(Math.abs)) <= OFF * 1.1,
  `along ${Math.max(...turnedAlong.map(Math.abs)).toFixed(2)}, off ${Math.max(...turnedOff.map(Math.abs)).toFixed(2)}`);

// IT GOES ROUND, and the whole lap is on screen: nose to tail down one side and
// back up the other. Measured with each axis divided by its own reach, so the
// ellipse counts as the circle it is a stretched copy of. The wave is off for
// this one — it displaces `off` and would be counted as part of the rotation.
const waveAmp = S.wiggle.amp;
S.wiggle.amp = 0;
resetEelSparks(scene);
fly(2, 0, 0, 1);
const lap = (p) => Math.atan2(p.y / S.radius, p.x / HALF);
let turns = 0;
let prev = lap(eelSparkPoints()[0]);
for (let i = 0; i < 600; i++) {
  fly(DT, 0, 0, 1);
  const a = lap(eelSparkPoints()[0]);
  let d = a - prev;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  turns += d;
  prev = a;
}
check('a spark laps the whole body several times in ten seconds',
  Math.abs(turns) / (Math.PI * 2) > 2, `${(Math.abs(turns) / (Math.PI * 2)).toFixed(1)} laps`);

// ...and it does not lap at one fixed distance. The whole reason this is an
// attractor and not a sine is that a sine reads as machinery; a retune that
// flattens the variation has quietly bought the gear back.
resetEelSparks(scene);
fly(1, 0, 0, 1);
const track = [];
for (let i = 0; i < 600; i++) {
  fly(DT, 0, 0, 1);
  const p = eelSparkPoints()[0];
  track.push(Math.hypot(p.x / HALF, p.y / S.radius));
}
S.wiggle.amp = waveAmp;
const mean = track.reduce((a, b) => a + b, 0) / track.length;
const spread = Math.sqrt(track.reduce((a, b) => a + (b - mean) ** 2, 0) / track.length);
check('the orbit breathes rather than holding one radius', spread / mean > 0.2,
  `${(100 * spread / mean).toFixed(0)}% of ${mean.toFixed(2)}`);

// ---------------------------------------------------------------------------
section('THE WIGGLE — one wave down the body, and it loops');
// ---------------------------------------------------------------------------
// LOOPING IS THE WHOLE CLAIM and it is the only part of the wave a terminal can
// see. On screen a seam one frame wide is invisible right up until it isn't,
// and the phase driving this is wrapped into 0..1 every single frame — so if
// the series ever picks up a non-integer frequency, the orbit jolts once a
// second forever and it will be blamed on the attractor.
let worst = 0;
for (let i = 0; i < 97; i++) {
  const u = i / 97;
  worst = Math.max(worst, Math.abs(eelWiggle(u) - eelWiggle(u + 1)), Math.abs(eelWiggle(u) - eelWiggle(u + 7)));
}
check('the wave is periodic with period 1, to floating point', worst < 1e-9, `worst ${worst.toExponential(1)}`);
let peak = 0;
for (let i = 0; i < 4000; i++) peak = Math.max(peak, Math.abs(eelWiggle(i / 4000)));
check('...and it stays inside -1..1', peak <= 1, `peak ${peak.toFixed(3)}`);

// IT IS NOT ONE SINE, which is the difference between a swimming body and a
// pendulum. Zero crossings do not show this — the fundamental dominates, so the
// sum still crosses exactly twice — but two things do:
//
//   A pure sine is ANTISYMMETRIC about a half period: w(u + 0.5) === -w(u), for
//   every u. Any EVEN harmonic breaks that identity and no odd one can fake it.
//   It is the sharpest single number available here.
//
//   ...and the odd harmonics show up as extra turning points: six per loop
//   rather than a sine's two.
let anti = 0;
for (let i = 0; i < 1000; i++) {
  const u = i / 1000;
  anti = Math.max(anti, Math.abs(eelWiggle(u + 0.5) + eelWiggle(u)));
}
check('it is not a single sine — even harmonics break the half-period mirror',
  anti > 0.1, `worst mismatch ${anti.toFixed(2)}`);
let extrema = 0;
let slope = eelWiggle(0.0005) - eelWiggle(0);
for (let i = 1; i < 2000; i++) {
  const d = eelWiggle((i + 1) / 2000) - eelWiggle(i / 2000);
  if ((d < 0) !== (slope < 0)) extrema++;
  slope = d;
}
check('...and it has kinks riding on the swing', extrema > 2, `${extrema} turning points per loop`);

// IT TRAVELS ALONG THE BODY rather than the whole cloud swinging as one plank.
// Two points a body-length apart must be at different points in the wave.
const nose = eelWiggle(0.25);
const tail = eelWiggle(0.25 - S.wiggle.waves);
check('the nose and the tail are at different points in the wave',
  Math.abs(nose - tail) > 0.1, `${nose.toFixed(2)} vs ${tail.toFixed(2)}`);

// And it reaches the sparks: the same pool, drawn with the wave off, is not the
// same picture. A wave wired to nothing is the failure this catches.
resetEelSparks(scene);
fly(3, 0, 0, 4);
const withWave = eelSparkPoints().map((p) => p.y);
S.wiggle.amp = 0;
fly(DT, 0, 0, 4);
const without = eelSparkPoints().map((p) => p.y);
S.wiggle.amp = waveAmp;
check('turning the wave off moves every spark',
  withWave.every((v, i) => Math.abs(v - without[i]) > 1e-4),
  `largest shift ${Math.max(...withWave.map((v, i) => Math.abs(v - without[i]))).toFixed(2)}`);

// ---------------------------------------------------------------------------
section('THE SPEED CAP — shortening the step, not the move');
// ---------------------------------------------------------------------------
resetEelSparks(scene);
fly(2, 0, 0, 8);
let fastest = 0;
let last = eelSparkPoints();
for (let i = 0; i < 1200; i++) {
  fly(DT, 0, 0, 8);
  const now = eelSparkPoints();
  for (let j = 0; j < now.length; j++) {
    fastest = Math.max(fastest, Math.hypot(now[j].x - last[j].x, now[j].y - last[j].y) / DT);
  }
  last = now;
}
// THE WAVE IS NOT UNDER THE CAP, and must not be. It is a ripple standing in
// the eel's own body, so a spark crossing the animal TRACES it — the drawn
// position moves faster than the place on the attractor does, and at these
// speeds the sweep the spark's own travel causes is larger than the one the
// clock causes. That is the wiggle doing its job, not the clamp failing, so the
// allowance is derived from the tuning rather than fudged: the wave's steepest
// slope times how fast the phase can be swept, from both causes at once.
let steepest = 0;
for (let i = 0; i < 4000; i++) {
  const u = i / 4000;
  steepest = Math.max(steepest, Math.abs(eelWiggle(u + 1e-5) - eelWiggle(u)) / 1e-5);
}
const sweep = 1 / S.wiggle.period + (S.speedCap / S.length) * S.wiggle.waves;
const allowance = S.speedCap + S.wiggle.amp * steepest * sweep;
check('no spark outruns the cap plus what the wave can add', fastest <= allowance * 1.05,
  `${fastest.toFixed(1)} vs ${S.speedCap} + ${(allowance - S.speedCap).toFixed(1)} of wave`);

// ...and the clamp is genuinely doing something: with the wave off, the
// attractor's own contribution must sit under the cap on its own.
S.wiggle.amp = 0;
resetEelSparks(scene);
fly(2, 0, 0, 8);
let bare = 0;
last = eelSparkPoints();
for (let i = 0; i < 900; i++) {
  fly(DT, 0, 0, 8);
  const now = eelSparkPoints();
  for (let j = 0; j < now.length; j++) {
    bare = Math.max(bare, Math.hypot(now[j].x - last[j].x, now[j].y - last[j].y) / DT);
  }
  last = now;
}
S.wiggle.amp = waveAmp;
check('the attractor alone stays under it', bare <= S.speedCap * 1.05,
  `${bare.toFixed(1)} vs cap ${S.speedCap}`);
check('...and is not simply pinned there either', bare > 1, `${bare.toFixed(1)} u/s`);

// ---------------------------------------------------------------------------
section('DIVERGENCE IS RESEEDED, NOT DROPPED');
// ---------------------------------------------------------------------------
// A rate nothing would ever be tuned to, which is the point: it throws states
// clean off the attractor every few frames. An ornament that thinned out under
// this would leave a run with an eel carrying no charge and no error anywhere.
resetEelSparks(scene);
fly(1, 0, 0, 8);
const wanted = eelSparkCount(S, 8);
const sane = S.rate;
S.rate = 400;
fly(4, 0, 0, 8);
S.rate = sane;
const wild = eelSparkPoints();
check('the pool is still full after a shaking', wild.length === wanted, `${wild.length}/${wanted}`);
check('...and nothing in it is NaN', wild.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
fly(2, 0, 0, 8);
check('...and the tube re-forms around the body',
  Math.max(...along().map(Math.abs)) <= HALF * 1.05
  && Math.max(...off().map(Math.abs)) <= OFF * 1.1,
  `along ${Math.max(...along().map(Math.abs)).toFixed(2)}, off ${Math.max(...off().map(Math.abs)).toFixed(2)}`);

// The buffer itself, which is what the driver reads. One NaN in here can cull
// the whole mesh rather than one spark.
const ribbons = scene.children[scene.children.length - 1].children;
const bad = ribbons.some((m) => {
  const a = m.geometry.attributes.position.array;
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return true;
  return false;
});
check('the vertex buffers are clean', !bad);

// ---------------------------------------------------------------------------
section('THE TAIL FOLLOWS THE EEL RATHER THAN SMEARING');
// ---------------------------------------------------------------------------
resetEelSparks(scene);
fly(3, 0, 0, 4);
// One frame at a position twenty units away — a jump no swim could make, so a
// world-space tail would leave a twenty-unit streak across the arena.
fly(DT, 20, 0, 4);
check('every spark is still on the body', Math.max(...along(20).map(Math.abs)) <= HALF * 1.05,
  `furthest ${Math.max(...along(20).map(Math.abs)).toFixed(2)}`);
const moved = scene.children[scene.children.length - 1].children[0].geometry.attributes.position.array;
let far = 0;
for (let i = 0; i < moved.length; i += 3) far = Math.max(far, Math.abs(moved[i] - 20 - S.offset));
check('...and so is every vertex of its tail', far <= HALF * 1.25, `furthest ${far.toFixed(2)}`);

// ---------------------------------------------------------------------------
section('WHERE THE CHAIN LEAVES FROM');
// ---------------------------------------------------------------------------
resetEelSparks(scene);
fly(3, 0, 0, 8);
const pts = eelSparkPoints();
const launch = sparkLaunchPoint(40, 0);
const nearest = pts.reduce((a, p) => (Math.hypot(p.x - 40, p.y) < Math.hypot(a.x - 40, a.y) ? p : a));
check('the launch spark is the one nearest what is about to be hit',
  Math.abs(launch.x - nearest.x) < 1e-6 && Math.abs(launch.y - nearest.y) < 1e-6);
check('...and it is a point on the body, not the companion\'s centre',
  Math.abs(launch.x - S.offset) <= HALF * 1.05 && Math.abs(launch.y) <= OFF * 1.1,
  `${(launch.x - S.offset).toFixed(2)} along, ${launch.y.toFixed(2)} off`);
const feeders = sparkFeeders(launch.x, launch.y, 2);
check('two neighbours feed it', feeders.length === 2);
check('...and neither one is the launch spark itself',
  feeders.every((f) => Math.hypot(f.x - launch.x, f.y - launch.y) > 1e-4));
check('asking for none gets none', sparkFeeders(launch.x, launch.y, 0).length === 0);
check('an empty orbit has no launch point', (resetEelSparks(scene), sparkLaunchPoint(0, 0)) === null);

// ---------------------------------------------------------------------------
section('THE DISCHARGE');
// ---------------------------------------------------------------------------
resetEelSparks(scene);
resetEelBolts(scene);
resetEel();
fly(3, 0, 0, 3);
const boltsBefore = scene.children.length;
spawnEelChain(scene, [{ x: 0, y: 0 }, { x: 12, y: 3 }], 3);
check('the chain and its feeder arcs are all in the water',
  scene.children.length === boltsBefore + 1 + S.feeders,
  `${scene.children.length - boltsBefore} bolts for ${S.feeders} feeders`);
check('the orbit flares', eelSparkFlare() === 1);
fly(S.flareDecay * 1.2, 0, 0, 3);
check('...and the flare decays away', eelSparkFlare() === 0);
resetEelBolts(scene);

// The whole path, through the ability rather than through the helper: an eel
// with a fish in range fires, and what lands is a chain plus its feeders.
resetEelSparks(scene);
resetEel();
resetEelCompanion({ x: 0, y: 0 });
player.stats.eelLevel = 3;
const fish = {
  mesh: new THREE.Object3D(),
  hp: 1e6,
  def: {},
};
fish.mesh.position.set(6, 0, 0);
const beforeFire = scene.children.length;
let links = 0;
updateEel(DT, scene, { x: 0, y: 0 }, 3, [fish], { onChainLink: () => { links++; } });
check('the eel found the fish', links > 0, `${links} link(s)`);
check('and fired a chain that its orbit fed',
  scene.children.length === beforeFire + 1 + 1 + S.feeders,
  `${scene.children.length - beforeFire} added (1 orbit + 1 chain + ${S.feeders} feeders)`);
check('the fish took the hit', fish.hp < 1e6);

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
