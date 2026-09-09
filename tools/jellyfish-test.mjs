#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:jelly
//
// THE JELLYFISH — the one creature in the roster that is oriented by gravity
// rather than by where it is going, turns on the spot, and keeps its whole
// damage budget somewhere other than its hitbox. All three of those are
// unusual enough that nothing else in the suite would notice them breaking,
// and all three fail QUIETLY: an upside-down jellyfish still spawns, a
// lockstep group still spins, and a sting measuring the wrong place still
// bills the player for something.
//
//   UPRIGHT       `faceMotion` is off, so nothing re-aims the body. It shipped
//                 ON first, which pointed the bell down the drift — and with
//                 `drift.vertical: 1` the wander is as free up and down as it
//                 is across, so a good part of its life was spent bell-down
//                 with the filaments over its head. Measured against a CONTROL
//                 that does face its motion, because "rotation stayed at zero"
//                 is also what a harness that never ticked anything reports.
//
//   THE MODEL     ...and the axis that decides which way up it is comes off
//                 the mesh, not off a node name. `forward: '-Y'` is only
//                 correct while the bell is the low-Y end of jellyfish.glb: a
//                 re-export that flips it turns the animal over and changes
//                 nothing this suite could otherwise see. So the vertices are
//                 counted here, on the shipped file.
//
//   THE SPIN      about `visual.rotation.y` — a roll around the model's own
//                 forward axis, which after the line above is the vertical.
//                 The default 'z' is the cartwheel in the picture plane, and a
//                 cartwheeling jellyfish has nothing dangling, so the axis is
//                 the whole feature rather than a detail of it. Per individual
//                 too: eight of them on one rate read as one object drawn
//                 eight times.
//
//   THE STING     the filaments hurt and the bell does not. Three claims, and
//                 the third is the one that rots — the reach is written in
//                 MULTIPLES OF `e.radius` so it follows the assets.csv row on
//                 its own, and this file checks the circle it produces still
//                 lands on the part of the mesh that has filaments in it. The
//                 crab's claw died exactly this way (see pinchReach): a radius
//                 was retuned, the two halves stopped agreeing, and the
//                 mechanic silently stopped happening.
//
// Driven, not computed: the real resolveCombat on real spawned creatures, with
// main.js's i-frame gate restated the way tools/contact-bite-test.mjs restates
// it and for the same reason.
//
//   node --import ./tools/vite-loader.mjs tools/jellyfish-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
// jellyfish.glb embeds its texture and GLTFLoader decodes those through
// createImageBitmap. Without a stub the parse promise never settles and the
// script exits with "unsettled top-level await" and no error at all.
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { CONFIG } from '../path/src/config.js';
import { ASSETS, getAssetSizeMultiplier } from '../path/src/assets.js';
import { updateBounds } from '../path/src/arena.js';
import { player, initPlayer, resetPlayer } from '../path/src/entities/player.js';
import { enemies, spawnNamed, updateEnemies, resetEnemies } from '../path/src/entities/enemies.js';
import { resolveCombat } from '../path/src/systems/combat.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[animation]') || msg.startsWith('[assets]')
    || msg.startsWith('[feedback]'))) return;
  realWarn(msg, ...rest);
};

const scene = new THREE.Scene();
const dt = 1 / 60;
let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
const note = (t) => console.log(`        ${t}`);

// Seeded, because every section below spawns and the drift wander is a roll.
// See the note in tools/nightlife-test.mjs: on the real Math.random the spin
// spread and the drift excursion move between invocations, and a file that
// fails one run in four teaches everyone that red means "run it again".
let _s = 20260906 >>> 0;
Math.random = () => {
  _s |= 0; _s = (_s + 0x6D2B79F5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

updateBounds(16 / 9);
initPlayer(scene);

const DEF = CONFIG.enemies.jellyfish;
const ASSET = ASSETS[DEF.asset];

// ---------------------------------------------------------------------------
section('THE MODEL — which end is the bell, counted off the shipped file');

// Node loads no models for a SPAWNED creature (createVisual falls back to a
// procedural stand-in and the harnesses suppress the warning), so this is the
// one place the real geometry is read. It is also the only claim here that a
// re-export can break, which is why it is read rather than quoted.
const glb = readFileSync(resolve(HERE, '..', 'public', ASSET.model.replace(/^\//, '')));
const gltf = await new GLTFLoader().parseAsync(
  glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), '',
);
gltf.scene.updateMatrixWorld(true);

// Every vertex's position along the model's FORWARD axis, measured from the
// forward tip — so 0 is the nose (the bell, if the asset is right) and 1 is
// the far end. Reading `def.forward` rather than assuming '-Y' is what makes
// this a test of the declaration instead of a restatement of it.
const FWD = new THREE.Vector3().fromArray({
  '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0],
  '+Z': [0, 0, 1], '-Z': [0, 0, -1],
}[ASSET.forward ?? '+Z']);

const along = [];
const spread = [];
{
  const v = new THREE.Vector3();
  gltf.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      const d = v.dot(FWD);            // + is toward the nose
      along.push(d);
      spread.push(Math.hypot(...['x', 'y', 'z'].map((k, j) => (FWD.toArray()[j] ? 0 : v[k]))));
    }
  });
}
const noseD = Math.max(...along);
const tailD = Math.min(...along);
const modelLen = noseD - tailD;
// 0 at the nose, 1 at the tail.
const frac = along.map((d) => (noseD - d) / modelLen);

const half = frac.filter((f) => f < 0.5).length;
check('the forward half of the model is the solid half',
  half > frac.length * 0.7,
  `${half} of ${frac.length} vertices (${(half / frac.length * 100).toFixed(0)}%) lie forward of centre`);
note('If this flips, the animal is upside down and nothing else in the suite can tell.');

// Where the body stops being bell and starts being filament: the fraction that
// encloses 90% of the vertices, walking back from the nose.
const sorted = [...frac].sort((a, b) => a - b);
const bellEnd = sorted[Math.floor(sorted.length * 0.9)];
const tipSpread = Math.max(...spread);
note(`bell ends at ${(bellEnd * 100).toFixed(0)}% of the body; filaments spread to ${tipSpread.toFixed(2)} model units`);

// ---------------------------------------------------------------------------
section('UPRIGHT — nothing re-aims the body');

check('`faceMotion` is off', DEF.faceMotion === false, `faceMotion: ${DEF.faceMotion}`);

// A real drift, long enough for the wander to have pointed the animal into
// every quadrant. `drift.vertical` is what made the old bug visible, so the
// run has to be long enough to use it.
function driftRun(type, seconds) {
  resetEnemies(scene);
  const e = spawnNamed(scene, type, 2, { x: 0, y: -6 }, { ignoreCaps: true });
  e.entering = false;
  const rots = new Set();
  const quads = new Set();
  for (let t = 0; t < seconds; t += dt) {
    updateEnemies(dt, scene, player.mesh.position, () => {}, () => {}, () => {});
    if (!enemies.length) break;
    rots.add(enemies[0].mesh.rotation.z.toFixed(3));
    const { vx, vy } = enemies[0];
    if (Math.hypot(vx, vy) > 0.2) quads.add(`${vx > 0 ? '+' : '-'}${vy > 0 ? '+' : '-'}`);
  }
  return { e: enemies[0], rots, quads };
}

const jelly = driftRun('jellyfish', 60);
check('it travelled in every quadrant, so the run is a real test',
  jelly.quads.size === 4, `headings seen: ${[...jelly.quads].sort().join(' ')}`);
check('...and its heading never moved off level',
  jelly.rots.size === 1 && [...jelly.rots][0] === '0.000',
  `${jelly.rots.size} distinct rotation.z value(s): ${[...jelly.rots].slice(0, 4).join(', ')}`);

// THE CONTROL. "rotation.z stayed at 0" is also what a harness that ticked
// nothing would report, and what a jellyfish sitting still would report. The
// squid runs the same 60 seconds through the same loop with faceMotion ON.
const squid = driftRun('squid', 60);
check('a creature that DOES face its motion turns in the same run',
  squid.rots.size > 10, `${squid.rots.size} distinct rotation.z values`);

// ---------------------------------------------------------------------------
section('THE SPIN — about the bell axis, and different for each one');

check('it spins about the model\'s forward axis, not the picture plane',
  DEF.spinAxis === 'y', `spinAxis: ${DEF.spinAxis ?? 'z (the default)'}`);

resetEnemies(scene);
const group = [];
for (let i = 0; i < 8; i++) {
  const e = spawnNamed(scene, 'jellyfish', 2, { x: -12 + i * 3, y: -6 }, { ignoreCaps: true });
  e.entering = false;
  group.push(e);
}
const before = group.map((e) => ({ y: e.visual.rotation.y, z: e.visual.rotation.z }));
for (let t = 0; t < 2; t += dt) {
  updateEnemies(dt, scene, player.mesh.position, () => {}, () => {}, () => {});
}
const turned = group.map((e, i) => e.visual.rotation.y - before[i].y);
const rolled = group.map((e, i) => e.visual.rotation.z - before[i].z);

check('every one of them turned', turned.every((d) => Math.abs(d) > 1e-3),
  `${turned.map((d) => d.toFixed(2)).join(' ')} rad in 2s`);
check('...and none of them cartwheeled', rolled.every((d) => Math.abs(d) < 1e-9),
  'visual.rotation.z untouched');
check('...at eight different rates', new Set(turned.map((d) => d.toFixed(3))).size === 8,
  `${new Set(turned.map((d) => d.toFixed(3))).size} distinct`);
check('...turning both ways',
  turned.some((d) => d > 0) && turned.some((d) => d < 0),
  `${turned.filter((d) => d > 0).length} one way, ${turned.filter((d) => d < 0).length} the other`);

// The spread is bounded by what the def asked for, or `spinVariance` is not
// doing the job it is named for — a rate rolled outside its own range is a
// creature quietly turning at a speed nobody chose.
const rate = DEF.spin;
const varr = DEF.spinVariance ?? 0;
const speeds = turned.map((d) => Math.abs(d) / 2);
check('...inside the variance the def asked for',
  speeds.every((s) => s >= rate * (1 - varr) - 1e-6 && s <= rate * (1 + varr) + 1e-6),
  `${Math.min(...speeds).toFixed(2)}–${Math.max(...speeds).toFixed(2)} rad/s `
  + `against ${rate} ±${(varr * 100).toFixed(0)}%`);

// ---------------------------------------------------------------------------
section('THE STING — the filaments hurt, the bell is free');

// The i-frame gate is main.js's, restated. Nothing here bills on 'strike', but
// the gate is kept honest anyway so a change of channel is visible as a change
// in the numbers rather than as silence.
function billed(place, seconds = 1) {
  resetEnemies(scene);
  resetPlayer();
  player.invuln = 0;
  player.mesh.position.set(0, 0, 0);
  const e = spawnNamed(scene, 'jellyfish', 0, { x: 0, y: 0 }, { ignoreCaps: true });
  e.entering = false;

  const log = { total: 0, channels: new Set(), push: null };
  const hooks = {
    onPlayerHit: (dmg, dir, source = '?', channel = 'attack', iFrames = 0) => {
      if (channel === 'strike') {
        if (player.invuln > 0) return 0;
        player.invuln = Math.max(CONFIG.player.hitIFrames ?? 0, iFrames ?? 0);
      }
      log.total += dmg;
      log.channels.add(channel);
      log.push = dir;
      return dmg;
    },
    onEnemyKilled: () => {},
  };

  for (let t = 0; t < seconds; t += dt) {
    // PINNED, both of them. What is being measured is where on the animal the
    // damage lives, and a body free to drift would spend a different fraction
    // of the run over the seal on every run of this file.
    e.mesh.position.set(0, 0, 0);
    player.mesh.position.set(place.x, place.y, 0);
    player.invuln = 0;
    resolveCombat(dt, scene, hooks);
  }
  log.contactDamage = e.contactDamage ?? e.def.contactDamage;
  return log;
}

const R = 0.5 * getAssetSizeMultiplier(DEF.asset); // e.radius, as spawnOne builds it
const dropWorld = DEF.sting.offset * R;
const reachWorld = DEF.sting.radius * R;

// The animal laid out in entity-local units, from the mesh measured at the top
// of this file. +Y is toward the nose, and the nose sits at pivot * length.
const scale = (ASSET.fit / modelLen) * getAssetSizeMultiplier(DEF.asset);
const bodyLen = modelLen * scale;
const noseY = (ASSET.pivot ?? 0.5) * bodyLen;
const bellBottom = noseY - bellEnd * bodyLen;
const tipY = noseY - bodyLen;
const pR = CONFIG.player.hitRadius;
note(`hit radius ${R.toFixed(2)}; bell ${noseY.toFixed(2)} down to ${bellBottom.toFixed(2)}, `
  + `filaments to ${tipY.toFixed(2)}; sting ${(dropWorld + reachWorld).toFixed(2)} `
  + `to ${(dropWorld - reachWorld).toFixed(2)}, reach ${reachWorld.toFixed(2)} + the seal's ${pR}`);

// RESTING ON THE BELL, not floating at the origin, and the difference is the
// whole reason the animal is the size it is. The seal's own hit radius is 1
// against a body 3.8 long — park it at the origin and its belly is in the
// filaments whatever the sting says, which is what "harmless in name only"
// looked like at the first size. Sat on top of the bell it is genuinely
// touching the animal (the bell reaches down past the seal's underside) and
// genuinely paying nothing.
const bell = billed({ x: 0, y: noseY });
check('resting on the bell costs nothing', bell.total === 0,
  `${bell.total.toFixed(1)} damage over a second with the seal on top of it`);
check('...while actually touching it',
  noseY - pR < noseY && noseY - pR < bellBottom + (noseY - bellBottom),
  `seal's underside at ${(noseY - pR).toFixed(2)}, bell down to ${bellBottom.toFixed(2)}`);

// Off-centre on purpose, and UP as well as across: at the exact centre of the
// circle the contact vector is zero, and a seal level with the centre is
// shoved purely sideways — either would let a push test pass while saying
// nothing about the direction.
const tips = billed({ x: 0.3, y: dropWorld + 0.6 });
// Against the creature's OWN baked number rather than the CSV cell: spawnOne
// multiplies the row by the difficulty and pace ramps (see `damageMul`), so
// comparing to the raw 30 would be a test of the ramps wearing a sting's
// clothes — and would go red the day anyone touches pace.enemy.
const want = tips.contactDamage;
check('sitting in the filaments costs the creature\'s full contact damage',
  Math.abs(tips.total - want) < want * 0.03,
  `${tips.total.toFixed(1)} over a second against its ${want.toFixed(1)} `
  + `(${DEF.contactDamage} on the row in enemies.csv, through the ramps)`);
check('...on the drain channel, not as a burst',
  tips.channels.size === 1 && tips.channels.has('contact'),
  [...tips.channels].join(', '));
// AWAY FROM THE STING and not away from the body, which is the one place in
// resolveCombat that does this. Shoved off the bell you would slide DOWN the
// animal into the filaments, which is being punished for being hit; shoved out
// of the filaments you leave the part that hurts.
check('...and it shoves the player OUT of the filaments, not off the bell',
  tips.push != null && tips.push.y > 0 && tips.push.x > 0,
  `push ${tips.push ? `${tips.push.x.toFixed(2)}, ${tips.push.y.toFixed(2)}` : 'none'} `
  + 'from a seal sitting up and to the right of the sting');

// THE REACH AGAINST THE MESH — the check that rots. Both numbers are written
// in multiples of `e.radius` so they follow assets.csv on their own, and this
// is what notices when they stop landing on the part of the animal that has
// filaments in it.
check('the sting stops clear of the bell', dropWorld + reachWorld <= bellBottom + 1e-6,
  `top of the circle ${(dropWorld + reachWorld).toFixed(2)} vs the bell's ${bellBottom.toFixed(2)}`);
check('...and hangs no further than the filaments do',
  dropWorld - reachWorld <= tipY + 1e-6
    && dropWorld - reachWorld >= tipY - bodyLen * 0.1,
  `bottom of the circle ${(dropWorld - reachWorld).toFixed(2)} vs the tips' ${tipY.toFixed(2)}`);
check('...and is about as wide as the filaments hang',
  Math.abs(reachWorld - tipSpread * scale) < tipSpread * scale * 0.25,
  `reach ${reachWorld.toFixed(2)} vs spread ${(tipSpread * scale).toFixed(2)}`);
check('...and the seal can be beside the bell without paying',
  billed({ x: noseY + pR, y: 0 }).total === 0,
  'alongside the body, level with the origin');

// THE CONTROL. Every claim above is about damage moving OFF the body, so a
// bug that simply stopped billing contact for everything would read as a pass
// on all of them.
{
  resetEnemies(scene);
  resetPlayer();
  player.invuln = 0;
  let total = 0;
  const e = spawnNamed(scene, 'puffer', 0, { x: 0, y: 0 }, { ignoreCaps: true });
  e.entering = false;
  const hooks = { onPlayerHit: (d) => { total += d; return d; }, onEnemyKilled: () => {} };
  for (let t = 0; t < 1; t += dt) {
    e.mesh.position.set(0, 0, 0);
    player.mesh.position.set(0, 0, 0);
    player.invuln = 0;
    resolveCombat(dt, scene, hooks);
  }
  check('a creature with no sting still bills for its body', total > 0,
    `puffer: ${total.toFixed(1)} over a second`);
}

console.log(failures ? `\n${failures} FAILED` : '\nAll good.');
process.exit(failures ? 1 : 0);
