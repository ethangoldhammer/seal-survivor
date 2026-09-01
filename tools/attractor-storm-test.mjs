#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:attractor
//
// THE SIX STAGED BULLET-HELL STUDIES — systems/attractorStorm.js.
//
// These are candidate boss attacks, put in the water by hand from the U panel
// so they can be played against before one is committed. What that means for a
// test is that "does it look right" is explicitly NOT the question — the seal
// answers that — and everything here is one of the four ways a storm can be
// wrong in a manner nobody would ever see:
//
//   THE PATTERN IS NOT WHERE THE ARENA IS. Every one of these is a shape in the
//   attractor's own units multiplied by a scale, and the arena is 80 units
//   wide. A scale an order of magnitude out is a storm whose cubes are all
//   culled by the arena bounds on their first frame, or one whose entire
//   pattern is a knot two units across. Both are live storms that fire, spawn
//   and file damage — they just do it somewhere the fight isn't.
//
//   THE INTEGRATOR LOST THE ATTRACTOR. Lorenz and Aizawa both have a cubic
//   term. A step too big does not wobble, it diverges, and a diverged cube is
//   at 1e30 — where it fails every distance comparison, so nothing that culls
//   by proximity will ever remove it. The clamp is what makes the step safe and
//   the clamp is the thing most likely to be quietly broken by a retune.
//
//   THE SPEED CAP DID NOT CAP. It shortens the integration STEP rather than the
//   move, which is the only version that preserves the path — and it is also
//   the version that silently does nothing if the arithmetic is wrong, because
//   the cubes still fly and still follow the shape. They just do it at two
//   hundred units a second.
//
//   THE FLOW HOOK DID NOT REACH THE PROJECTILE. A cube whose `flow` never fires
//   is an ordinary bullet flying in a straight line, which in a screen full of
//   swirling ones is invisible.
//
// The LOOK is not testable here and is not attempted: the scaffold is a line
// mesh and the cubes are a primitive, and whether the channels read is a
// question for the water.
//
//   node --import ./tools/vite-loader.mjs tools/attractor-storm-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { bounds } from '../path/src/arena.js';
import { CONFIG } from '../path/src/config.js';
import { projectiles, updateProjectiles, resetProjectiles } from '../path/src/entities/projectiles.js';
import {
  attractorStormList, startAttractorStorm, stopAttractorStorm,
  updateAttractorStorm, activeAttractorStorm, resetAttractorStorm,
} from '../path/src/systems/attractorStorm.js';
import { parseAttractorStormCsv, STORM_IDS } from '../path/src/attractorStormTable.js';
import { attractorDeriv, stepAttractor, ATTRACTOR_SHAPES } from '../path/src/systems/attractors.js';
import { attractorFlow, STRANGE_SHAPES } from '../path/src/systems/baitBall.js';
import { ASSETS } from '../path/src/assets.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const DT = 1 / 60;
const scene = new THREE.Scene();
const PLAYER = new THREE.Vector3(0, -16, 0);

function run(seconds, playerPos = PLAYER) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    updateProjectiles(DT, scene, []);
    updateAttractorStorm(DT, scene, playerPos);
  }
}

function mine(id) {
  return projectiles.filter((p) => p.source === `attractor:${id}`);
}

function clear() {
  resetAttractorStorm(scene);
  resetProjectiles(scene);
}

// ---------------------------------------------------------------------------
section('THE TABLE');
// ---------------------------------------------------------------------------

const STORMS = attractorStormList();
check('all six studies parse', STORMS.length === STORM_IDS.length,
  `${STORMS.length} of ${STORM_IDS.length}`);
check('...and every one names a shape systems/attractors.js implements',
  STORMS.every((s) => ATTRACTOR_SHAPES.includes(s.shape)),
  STORMS.map((s) => s.shape).join(', '));
check('...and every one carries a brief for the panel',
  STORMS.every((s) => (s.notes ?? '').length > 40));

// A row naming a study with no code behind it stages successfully and then puts
// nothing in the water — the exact failure the id check exists to stop, and the
// one that looks like a broken button rather than a bad row.
{
  const warned = [];
  const rows = parseAttractorStormCsv(
    'id,enabled,shape,plane,scale,rate,speedCap,count,mode\n'
    + 'nonsense,,thomas,xz,1,1,10,4,field\n',
    (m) => warned.push(m),
  );
  check('a study the game does not implement is refused, loudly',
    rows.length === 0 && warned.some((m) => m.includes('nonsense')));
}
{
  const warned = [];
  const rows = parseAttractorStormCsv(
    'id,enabled,shape,plane,scale,rate,speedCap,count,mode\n'
    + 'lattice,,rossler,xz,1,1,10,4,field\n',
    (m) => warned.push(m),
  );
  check('...and so is a shape it does not implement',
    rows.length === 0 && warned.some((m) => m.includes('rossler')));
}
{
  const warned = [];
  const rows = parseAttractorStormCsv(
    'id,enabled,shape,plane,scale,rate,speedCap,count,mode\n'
    + 'lattice,,thomas,yz,1,1,10,4,field\n',
    (m) => warned.push(m),
  );
  // A plane the projection does not know would fall through to a default and
  // put the pattern on axes nobody chose — which still draws a shape, just not
  // the one the row describes.
  check('...and so is a projection plane it does not know',
    rows.length === 0 && warned.some((m) => m.includes('yz')));
}

// ---------------------------------------------------------------------------
section('WHAT THE SHOTS ARE MADE OF');
// ---------------------------------------------------------------------------
// `body` in attractorStorms.csv. Two studies have graduated off the stand-in
// cube — `ring` fires the yacht's rolls of cash, `echo` a shoal of glowing
// fish — and every failure mode in here is silent.
{
  const bodied = STORMS.filter((s) => s.body?.length);
  check('at least one study names its own body', bodied.length > 0,
    bodied.map((s) => `${s.id}:${s.body.length}`).join(', ') || 'none');

  // A KEY THAT IS NOT AN ASSET spawns the primitive fallback, or nothing —
  // either way the study still fires and looks wrong, which is a bug you go
  // hunting for in the flow rather than in a spreadsheet.
  const bad = [];
  for (const s of STORMS) for (const k of s.body ?? []) if (!ASSETS[k]) bad.push(`${s.id}: ${k}`);
  check('every body names a real asset', bad.length === 0, bad.join(', '));

  // THE SIZE PROMISE, and the reason this section exists at all.
  //
  // The cube is a unit cube, so the old code passed the hit radius doubled
  // straight in as `scale`. A model carries its own `fit` and the drawn long
  // axis is `fit * scale` — so a fish with fit 1.25 handed the cube's number is
  // a quarter bigger than its own hitbox. Nothing throws; the shot is simply
  // drawn bigger than it hits, and a bullet hell that does that reads as unfair
  // rather than as hard. Asserted per body, not per study.
  // COUNTED, and the count is asserted. The first version of this reported
  // "no model bodies" on a clean pass — it only recorded a `worstAt` when an
  // error EXCEEDED the running worst, and a run where every error is exactly
  // zero never does. A green check whose message reads the same whether it
  // measured nine bodies or none is a check that certifies nothing.
  let worst = 0; let worstAt = 'none'; let measured = 0; let scaled = 0;
  for (const s of STORMS) {
    const dia = (s.radius ?? 0.5) * 2;
    for (const k of s.body ?? []) {
      const fit = ASSETS[k]?.fit;
      const scale = dia / (fit > 0 ? fit : 1);
      const err = (fit > 0 ? fit * scale : scale) - dia;
      measured++;
      // How many actually needed a correction — a table where every fit
      // happened to be 1 would pass this section without exercising it.
      if (fit > 0 && Math.abs(fit - 1) > 1e-9) scaled++;
      if (Math.abs(err) >= Math.abs(worst)) { worst = err; worstAt = `${s.id}/${k}`; }
    }
  }
  check('every body is drawn exactly as wide as it hits',
    measured > 0 && Math.abs(worst) < 1e-9,
    `${measured} bodies measured, ${scaled} needing a fit correction; worst ${worst.toExponential(2)} at ${worstAt}`);

  // A SHOAL OF ONE FISH IS A TEXTURE. The list has to be a list where the whole
  // point of the row is variety.
  const echo = STORMS.find((s) => s.id === 'echo');
  check('the echo fires more than one kind of fish', (echo?.body?.length ?? 0) > 2,
    `${echo?.body?.length ?? 0} bodies`);

  // A FISH MUST NOT BE CANTED. The cube's 0.55 is what makes a square read as a
  // cube; applied to a creature it foreshortens the shoal into slivers, and the
  // default is the trap because it applies to any row that leaves the cell
  // blank.
  check('the echo does not cant its fish', (echo?.tilt ?? 0.55) < 0.2,
    `tilt ${echo?.tilt ?? '(default 0.55)'}`);
  // ...and a cylinder MUST be. A roll of cash in a side view is a rectangle at
  // every angle in the screen plane; only the cant brings its end into view.
  const ring = STORMS.find((s) => s.id === 'ring');
  check('the ring cants its rolls', (ring?.tilt ?? 0) > 0.2,
    `tilt ${ring?.tilt ?? '(default)'}`);
}

// A body list naming something that is not an asset must not take the study
// down with it — it drops that one key and fires the rest, or the cube.
{
  const rows = parseAttractorStormCsv(
    'id,enabled,shape,plane,scale,rate,speedCap,count,mode,body,tilt\n'
    + 'lattice,,thomas,xz,1,1,10,4,field,notAnAsset moneyRoll1,0.3\n',
    () => {},
  );
  check('an unknown body key still parses the row', rows.length === 1
    && rows[0].body.length === 2 && rows[0].tilt === 0.3,
    'the key check happens where the asset table is, not in the parser');
}

// tilt 0 is a REAL VALUE and must survive the blank-means-undefined rule — a
// parser that treated it as absent would cant every fish in the shoal.
{
  const rows = parseAttractorStormCsv(
    'id,enabled,shape,plane,scale,rate,speedCap,count,mode,tilt\n'
    + 'lattice,,thomas,xz,1,1,10,4,field,0\n',
    () => {},
  );
  check('a tilt of 0 is kept, not read as blank', rows[0]?.tilt === 0,
    `got ${JSON.stringify(rows[0]?.tilt)}`);
}

// ---------------------------------------------------------------------------
section('THE SHARED EQUATIONS — one copy, two callers');
// ---------------------------------------------------------------------------

check('the bait ball and the storms name the same three systems',
  STRANGE_SHAPES.every((s) => ATTRACTOR_SHAPES.includes(s))
  && ATTRACTOR_SHAPES.length === STRANGE_SHAPES.length,
  `${STRANGE_SHAPES.join(', ')} vs ${ATTRACTOR_SHAPES.join(', ')}`);

// The bait ball still steers. It was refactored onto the shared equations, and
// a delegation that dropped a term would leave a ball that still flocks — the
// boids and the wall would carry it — while the attractor quietly stopped being
// the attractor.
{
  const flows = STRANGE_SHAPES.map((s) => {
    const f = attractorFlow(s, 0.4, 0.3, 0.2);
    return `${f.x.toFixed(3)},${f.y.toFixed(3)},${f.z.toFixed(3)}`;
  });
  check('...and the bait ball still gets three different flows out of them',
    new Set(flows).size === 3, flows.join(' | '));
}

// Thomas's phase is the lattice's whole mechanic: one number that moves every
// channel at once. Nothing else here has a knob with that property, and a phase
// silently ignored would be a slide that telegraphs and then does nothing.
{
  const a = { x: 0, y: 0, z: 0 };
  const b = { x: 0, y: 0, z: 0 };
  attractorDeriv('thomas', 1, 2, 3, { b: 0.085, phase: 0 }, a);
  attractorDeriv('thomas', 1, 2, 3, { b: 0.085, phase: Math.PI / 2 }, b);
  const moved = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  check('a phase offset moves the whole Thomas field', moved > 0.5, `by ${moved.toFixed(2)}`);
}
{
  // ...and the default is no phase, which is what keeps the bait ball's Thomas
  // the same system it was before this file existed.
  const a = { x: 0, y: 0, z: 0 };
  const b = { x: 0, y: 0, z: 0 };
  attractorDeriv('thomas', 1, 2, 3, { b: 0.19 }, a);
  attractorDeriv('thomas', 1, 2, 3, { b: 0.19, phase: 0 }, b);
  check('...and a row with no phase is the unshifted system',
    a.x === b.x && a.y === b.y && a.z === b.z);
}

// The integrator's own guard. A state that has diverged is not a wobble — it is
// Infinity, and an Infinity position fails every comparison a cull is made of.
{
  const st = { x: 1e200, y: 1e200, z: 1e200 };
  check('a diverged step is reported rather than returned',
    stepAttractor('lorenz', st, 0.01, { lift: 0 }) === false);
}

// ---------------------------------------------------------------------------
section('EVERY STUDY PUTS ITS PATTERN WHERE THE ARENA IS');
// ---------------------------------------------------------------------------
// The one failure that is invisible from inside the game: a storm that fires,
// spawns and files damage somewhere the fight is not.

for (const row of STORMS) {
  clear();
  startAttractorStorm(scene, row.id, { x: 0, y: -16, z: 0 });
  // A release spends its first `period` seconds drawing and has nothing in the
  // water yet on purpose — see the draw-before-fire section below. Sampled just
  // after its volley leaves rather than on a fixed clock, so this measures the
  // attack and not the pause in front of it.
  run(row.mode === 'release' ? row.period + 0.8 : 6);

  const cubes = mine(row.id);
  check(`${row.id} keeps cubes in the water`, cubes.length > 0, `${cubes.length} live`);

  if (cubes.length) {
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    let finite = true;
    for (const p of cubes) {
      const { x, y } = p.mesh.position;
      if (!Number.isFinite(x) || !Number.isFinite(y)) { finite = false; continue; }
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    check(`  ...every one at a real position`, finite);
    const w = maxX - minX;
    const h = maxY - minY;
    // Wide enough to be an attack and not a knot; narrow enough to be inside
    // the arena rather than mostly outside it being culled.
    check(`  ...spread across a fightable width`, w > 6 && w < bounds.width,
      `${w.toFixed(1)}u of ${bounds.width}u`);
    check(`  ...and a fightable height`, h > 3 && h < 60, `${h.toFixed(1)}u`);
  }
}

// ---------------------------------------------------------------------------
section('THE SPEED CAP');
// ---------------------------------------------------------------------------
// It shortens the integration step rather than the move, so the path is exactly
// the one that was drawn and only its timing changes. That is also the version
// that silently does nothing when the arithmetic is wrong: the cubes still fly
// the shape, they just cross the arena in a frame.

for (const row of STORMS) {
  clear();
  startAttractorStorm(scene, row.id, { x: 0, y: -16, z: 0 });
  run(row.mode === 'release' ? row.period + 0.8 : 6);
  const cubes = mine(row.id);
  if (!cubes.length) continue;
  let fastest = 0;
  for (const p of cubes) fastest = Math.max(fastest, p.speed);
  // A little headroom over the row's own number: `speed` is a whole frame's
  // move divided by dt, and the last substep of a frame may be uncapped by up
  // to one substep's worth.
  const ceiling = (row.speedCap ?? 30) * 1.6;
  check(`${row.id} respects its own speed cap`, fastest <= ceiling,
    `fastest ${fastest.toFixed(1)}u/s against a cap of ${row.speedCap}`);
  check(`  ...and is actually moving`, fastest > 2, `${fastest.toFixed(1)}u/s`);
}

// ---------------------------------------------------------------------------
section('THE FLOW HOOK');
// ---------------------------------------------------------------------------
// A cube whose `flow` never fires is an ordinary bullet flying in a straight
// line, which in a screen full of swirling ones is invisible. The property that
// separates the two is CURVATURE: a field-steered cube's heading turns, an
// unsteered one's never does.

clear();
startAttractorStorm(scene, 'saddle', { x: 0, y: -16, z: 0 });
run(2);
{
  const cubes = mine('saddle');
  const before = cubes.map((p) => ({ p, dx: p.dir.x, dy: p.dir.y }));
  run(0.5);
  const turned = before.filter(({ p, dx, dy }) => projectiles.includes(p)
    && Math.hypot(p.dir.x - dx, p.dir.y - dy) > 0.02);
  check('field-steered cubes are turning', turned.length > before.length * 0.5,
    `${turned.length} of ${before.length}`);
  check('...and none of them is in free fall',
    cubes.every((p) => p.gravityScale === 0));
  check('...and they are enemy shots, so combat.js can land them on the seal',
    cubes.every((p) => p.faction === 'enemy'));
}

// ---------------------------------------------------------------------------
section('THE RING CLOSES');
// ---------------------------------------------------------------------------
// The one study that moves. It walks toward the seal at a fixed rate rather
// than chasing, so kiting always works and standing still never does — and a
// `reach` that quietly did nothing would turn it into a fourth static storm.

clear();
{
  const far = new THREE.Vector3(26, -10, 0);
  startAttractorStorm(scene, 'ring', { x: -26, y: -22, z: 0 });
  const cubes0 = () => mine('ring').map((p) => p.mesh.position.x);
  run(1, far);
  const startX = cubes0().reduce((a, b) => a + b, 0) / Math.max(1, cubes0().length);
  run(5, far);
  const endX = cubes0().reduce((a, b) => a + b, 0) / Math.max(1, cubes0().length);
  check('the ring closes on the seal', endX > startX + 6,
    `${startX.toFixed(1)} → ${endX.toFixed(1)} chasing x 26`);
  const row = STORMS.find((s) => s.id === 'ring');
  // ...at its own rate and not faster. A walk that snapped to the player would
  // be a homing attack with no counterplay at all.
  check('...at no more than its own reach', endX - startX <= (row.reach ?? 0) * 5 + 4,
    `moved ${(endX - startX).toFixed(1)}u in 5s at reach ${row.reach}`);
}

// ---------------------------------------------------------------------------
section('THE ECHO ARRIVES IN PAIRS');
// ---------------------------------------------------------------------------
// Sensitive dependence as a rule rather than as a look: two cubes seeded a hair
// apart that end up on opposite wings. The failure is silent in both
// directions — a pairing that never separates is a boring double bullet, and
// one that separates immediately is two unrelated bullets.

clear();
startAttractorStorm(scene, 'echo', { x: 0, y: -16, z: 0 });
run(0.4);
{
  const early = mine('echo');
  let closest = Infinity;
  for (let i = 0; i < early.length; i++) {
    for (let j = i + 1; j < early.length; j++) {
      closest = Math.min(closest, early[i].mesh.position.distanceTo(early[j].mesh.position));
    }
  }
  check('a pair starts together', closest < 0.6, `closest ${closest.toFixed(3)}u apart`);
  run(9);
  const late = mine('echo');
  let widest = 0;
  for (let i = 0; i < late.length; i++) {
    for (let j = i + 1; j < late.length; j++) {
      widest = Math.max(widest, late[i].mesh.position.distanceTo(late[j].mesh.position));
    }
  }
  check('...and the storm has spread across both wings by the end',
    widest > 14, `widest ${widest.toFixed(1)}u apart`);
}

// ---------------------------------------------------------------------------
section('THE BODIES REACH THE WATER');
// ---------------------------------------------------------------------------
// The table is one half; a shot carrying the asset is the other, and the join
// between them is a string. Checked in the water rather than in the row,
// because "the CSV says moneyRoll1" and "a money roll is flying" are two
// different claims and only the second one is the feature.
for (const id of ['ring', 'echo']) {
  clear();
  startAttractorStorm(scene, id);
  run(4);
  const shots = mine(id);
  const row = STORMS.find((s) => s.id === id);
  check(`${id} put shots in the water`, shots.length > 0, `${shots.length} alive`);
  const assets = new Set(shots.map((p) => p.asset));
  const stray = [...assets].filter((a) => !row.body.includes(a));
  check(`...and every one of them is one of ${id}'s bodies`, stray.length === 0,
    stray.length ? `stray: ${stray.join(', ')}` : [...assets].join(', '));
  // ROLLED PER SHOT. One body repeated across forty shots is the bug this
  // column exists to avoid, and with nine bodies and forty-odd shots seeing
  // only one is not luck.
  if (row.body.length > 2 && shots.length > 8) {
    check(`...and ${id} is not firing the same one every time`, assets.size > 1,
      `${assets.size} distinct of ${row.body.length} available across ${shots.length} shots`);
  }
}
clear();

// ---------------------------------------------------------------------------
section('THE RELEASE DRAWS BEFORE IT FIRES');
// ---------------------------------------------------------------------------
// The whole premise of the fastest study: a very fast curved bullet is fair
// when its curve was shown first. A release that spawned during its draw phase
// would be firing into its own telegraph.

clear();
{
  const row = STORMS.find((s) => s.id === 'release');
  startAttractorStorm(scene, 'release', { x: 0, y: -16, z: 0 });
  run(row.period * 0.6);
  check('nothing is in the water during the draw', mine('release').length === 0,
    `${mine('release').length} cubes`);
  check('...but the telegraph is', scene.children.some((o) => o.isLine));
  run(row.period * 0.6);
  check('...and the volley arrives when the draw ends', mine('release').length > 0,
    `${mine('release').length} cubes`);
}

// ---------------------------------------------------------------------------
section('THE RIBBONS');
// ---------------------------------------------------------------------------
// A bare cube shows a POINT on a trajectory, and a strange attractor IS the
// trajectory — the fold, the wing crossing and a pair of echo cubes coming
// apart all happen over the last third of a second and are invisible in any
// single frame. So every cube drags a streak.
//
// Two ways this fails silently and neither is visible from inside the game.
// The preset is looked up by name, so a `trailKey` that does not match a
// CONFIG.trails entry is a storm with no ribbons at all — which looks exactly
// like a storm whose ribbons are simply thin. And a trail is a Mesh per cube:
// one that is not torn down when its cube dies is a ribbon frozen in the water
// AND a draw call held for the rest of the run, which reads as nothing at all
// until a long session is inexplicably slower.
{
  const { updateProjectileTrails, clearProjectileTrails } =
    await import('../path/src/systems/projectileTrails.js');

  // Trails are held in a Map this module does not export, so they are counted
  // as what they cost: meshes added to the scene.
  const ribbons = () => {
    clearProjectileTrails(scene);
    const before = scene.children.length;
    updateProjectileTrails(DT, scene, projectiles);
    return scene.children.length - before;
  };

  clear();
  check('an empty ocean draws no ribbons', ribbons() === 0);

  startAttractorStorm(scene, 'saddle', { x: 0, y: -16, z: 0 });
  run(4);
  const cubes = mine('saddle').length;
  const drawn = ribbons();
  check('every cube in a storm drags one', drawn === cubes, `${drawn} for ${cubes} cubes`);
  check('...which is bounded by the study\'s own count, not by the run\'s length',
    drawn <= STORMS.find((s) => s.id === 'saddle').count,
    `${drawn} against a count of ${STORMS.find((s) => s.id === 'saddle').count}`);

  // The preset is the system's and not the body's. A row rolls its `body` per
  // shot, so keying the ribbon on the asset would give one field several
  // colours — and would break the moment a study is dressed in real art.
  check('...through the storm\'s own preset rather than its body\'s',
    mine('saddle').every((p) => p.trailKey === 'attractorStorm'));
  check('...and that preset exists, which is the whole of whether a ribbon draws',
    !!CONFIG.trails.attractorStorm);
  // Thin is the design and not restraint: sixty of these are on screen at once,
  // and a ribbon only survives that crowding while it stays a line.
  check('...and is the thinnest in the game',
    Object.entries(CONFIG.trails)
      .filter(([, v]) => v && typeof v === 'object' && typeof v.width === 'number')
      .every(([k, v]) => k === 'attractorStorm' || v.width >= CONFIG.trails.attractorStorm.width),
    `width ${CONFIG.trails.attractorStorm.width}`);

  // ...and they are given back. Every cube retired, then one more frame.
  for (const p of projectiles) p.life = 0;
  updateProjectiles(DT, scene, []);
  check('a storm that has run out leaves no ribbons behind', ribbons() === 0,
    `${projectiles.length} projectiles left`);
  clearProjectileTrails(scene);
  clear();
}

// ---------------------------------------------------------------------------
section('STAGING AND UNSTAGING');
// ---------------------------------------------------------------------------

clear();
check('nothing is staged to begin with', activeAttractorStorm() === null);
startAttractorStorm(scene, 'lattice', { x: 0, y: -16, z: 0 });
check('staging one reports it', activeAttractorStorm() === 'lattice');
run(1);
{
  // One at a time, deliberately: these are being judged against each other and
  // two at once is a question about neither.
  const before = scene.children.filter((o) => o.isLine).length;
  startAttractorStorm(scene, 'saddle', { x: 0, y: -16, z: 0 });
  check('staging a second one replaces the first', activeAttractorStorm() === 'saddle');
  check('...and takes the first one\'s telegraph out of the scene with it',
    scene.children.filter((o) => o.isLine).length < before,
    `${before} lines → ${scene.children.filter((o) => o.isLine).length}`);
}
run(1);
{
  const flying = mine('saddle').length;
  stopAttractorStorm(scene);
  check('stopping clears the storm', activeAttractorStorm() === null);
  // Cubes already in the air are NOT deleted. Deleting them would take a hit
  // out of the player's mouth mid-flight, which is the one thing a debug panel
  // must never do while somebody is judging how the attack feels.
  check('...and leaves what was already in the air', mine('saddle').length === flying,
    `${flying} still flying`);
  run(1);
  check('...which then flies on under its own heading rather than freezing',
    mine('saddle').every((p) => p.speed > 0 || p.life <= 0));
  check('...and no line mesh is left behind',
    scene.children.filter((o) => o.isLine).length === 0);
}

// ---------------------------------------------------------------------------
section('A LONG STORM DOES NOT LEAK');
// ---------------------------------------------------------------------------
// The lattice rebuilds its telegraph on every slide and the release rebuilds
// its on every volley. A build that did not dispose the last one is a line mesh
// per event for the rest of the session — invisible, because the new one is
// drawn over the old one in the same place.

for (const id of ['lattice', 'release']) {
  clear();
  startAttractorStorm(scene, id, { x: 0, y: -16, z: 0 });
  run(4);
  const first = scene.children.filter((o) => o.isLine).length;
  run(30);
  const later = scene.children.filter((o) => o.isLine).length;
  check(`${id} holds its line count across many events`, later <= first + 2,
    `${first} → ${later} after 30s`);
  // A release is between volleys as often as it is firing one, so the cap is
  // the only half of this that means anything for it — an over-count is a
  // top-up that has stopped noticing what is already in the water.
  const cubes = mine(id).length;
  const row = STORMS.find((s) => s.id === id);
  check(`  ...and its cube count never runs past ${row.count}`, cubes <= row.count * 1.6,
    `${cubes} live`);
}

clear();

// ---------------------------------------------------------------------------
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
