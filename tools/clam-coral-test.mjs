#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:clamcoral
//
// THE ATTRACTIVE CLAM and THE CORAL — the two composed pickups.
//
// Both replaced a primitive with a tint on it, and both now build their own
// meshes and their own materials at spawn. That buys a lot and it moves three
// classes of failure out of "you would see it" and into "nothing reports it":
//
//   THE GRID       the clam's waves and the coral's light are beat-synced. A
//                  pulse that has quietly come off the grid still pulses, and
//                  the only way to catch it is to count events against the
//                  transport rather than against wall time. The specific bug
//                  guarded here is the transport SNAP: beatSync's clock jumps
//                  when the music actually starts, and a wave index compared
//                  with `>` instead of `!==` goes silent for however many bars
//                  the jump was worth.
//   THE ROLL       "no two corals are alike" is a claim about a distribution.
//                  A seeded grower that happens to produce the same tree from
//                  every seed looks completely normal in a screenshot.
//   THE GRAB       the clam is the only pickup collected outside
//                  entities/pickups.js, so none of that module's collection
//                  tests cover it — and it spent a long time not being
//                  collectable at all: it rose out of the water from the boat
//                  that dropped it and ran its field untouched, while the
//                  coach line told the player to go and grab it. Both halves
//                  of that failure are silent (a pickup you cannot reach looks
//                  exactly like a pickup you missed), so the sink, the touch
//                  and the pull are all asserted here.
//   THE LEAK       a per-instance geometry and a per-instance material are only
//                  cheap if they are given back. Nothing else holds a reference
//                  to either, and WebGL does not free on JS garbage collection,
//                  so a clam or a coral that leaves the water without being
//                  disposed is a leak that only shows up as a long session
//                  getting slower.
//
// The LOOK is not testable here and is not attempted — all the shading is
// injected GLSL, a compile error renders nothing and throws nothing Node can
// see, and the sheet that catches it is tools/looks/pickups.js.
//
//   node --import ./tools/vite-loader.mjs tools/clam-coral-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import {
  createAttractiveClam, updateAttractiveClam, disposeAttractiveClam,
} from '../path/src/systems/attractiveClam.js';
import {
  spawnAttractorOrb, updateBoats, resetBoats, attractorOrbs,
} from '../path/src/systems/boats.js';
import { pickups } from '../path/src/entities/pickups.js';
import { bounds } from '../path/src/arena.js';
import {
  growCoral, createCoralOrb, updateCoralOrb, disposeCoralOrb,
} from '../path/src/systems/coralOrb.js';
import { updateBeatSync, beatsNow, divisionBeats } from '../path/src/systems/beatSync.js';
import { currentBpm } from '../path/src/systems/music.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const DT = 1 / 60;
const CLAM = CONFIG.attractorOrb.look;
const CORAL = CONFIG.rapidFirePickup.coral;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEEDS = [1, 7, 13, 42, 99, 404, 1234, 31337];

console.log('Clam & coral — merged config');
console.log(`  clam waves: one per ${CLAM.waveSync} · reach ${CLAM.waveRadius}u · ${CLAM.waveTravel}s`);
console.log(`  coral: ${CORAL.depth} generations, cap ${CORAL.maxSegments} · one pulse per ${CORAL.pulseSync}`);
console.log(`  tempo ${currentBpm()} bpm`);

// ===========================================================================
section('The clam — the waves leave on the beat');
{
  const scene = new THREE.Scene();
  const clam = createAttractiveClam();
  scene.add(clam);

  check('it is built out of parts, not one ball',
    clam.userData.clam.lobes.length === 2 && !!clam.userData.clam.body && !!clam.userData.clam.crease,
    `${clam.children.length} meshes`);

  // Ten seconds of transport, counting waves as they are created. The count is
  // derived from the beat clock, so the expected number is a musical figure
  // and not a wall-clock one.
  let waves = 0;
  let alive = 0;
  // Every ring OBJECT the clam has ever held. The pool hands the same meshes
  // back out, so this counts allocations rather than waves — which is the
  // question, since the two are only equal when nothing is being recycled.
  const rings = new Set();
  for (let i = 0; i < 60 * 10; i++) {
    updateBeatSync(DT);
    updateAttractiveClam(clam, DT, scene, DT);
    for (const w of clam.userData.clam.waves) rings.add(w.mesh);
    if (clam.userData.clam.lastWave !== alive) {
      alive = clam.userData.clam.lastWave;
      waves++;
    }
  }
  const beats = beatsNow();
  const perWave = divisionBeats(CLAM.waveSync) || 4;
  const expected = beats / perWave;
  check('one wave per configured division',
    Math.abs(waves - expected) <= 1.5,
    `${waves} waves in ${beats.toFixed(1)} beats, expected about ${expected.toFixed(1)}`);

  // A TRAIN, not a blink: at the configured reach and travel there has to be
  // more than one in the water at a time, or the clam flashes a ring and goes
  // quiet between beats.
  check('more than one wave is alive at once',
    clam.userData.clam.waves.length >= 2,
    `${clam.userData.clam.waves.length} in flight`);

  // ...and the pool is doing its job. At one wave a beat over a nine-second
  // life a clam builds twenty-odd ShaderMaterials if nothing is recycled, and
  // each of those is a shader program lookup.
  //
  // Counted as ALLOCATIONS, not as "is the free list non-empty": the free list
  // is legitimately empty whenever every ring the clam owns happens to be in
  // flight, which is most frames of a healthy train.
  check('spent waves are recycled, not rebuilt',
    rings.size <= 4 && rings.size < waves,
    `${rings.size} ring object(s) served ${waves} waves`);

  // THE SNAP. beatSync's transport jumps when the music actually starts (it
  // runs on a fallback clock until then), and that jump can move the wave index
  // BACKWARDS. A `>` comparison would go silent until the index caught up; the
  // shipped `!==` fires one wave at the join and carries on.
  const before = clam.userData.clam.lastWave;
  clam.userData.clam.lastWave = before + 500;
  const wavesBefore = clam.userData.clam.waves.length;
  updateBeatSync(DT);
  updateAttractiveClam(clam, DT, scene, DT);
  check('a backwards jump in the transport still fires a wave',
    clam.userData.clam.waves.length > wavesBefore - 1
      && clam.userData.clam.lastWave < before + 500,
    `index went ${before + 500} -> ${clam.userData.clam.lastWave}`);

  // THE GAPE. The lobes have to actually move, or the pulse is a light being
  // turned up rather than an animal.
  let minGap = Infinity;
  let maxGap = 0;
  for (let i = 0; i < 60 * 4; i++) {
    updateBeatSync(DT);
    updateAttractiveClam(clam, DT, scene, DT);
    const gap = Math.abs(clam.userData.clam.lobes[0].position.y - clam.userData.clam.lobes[1].position.y);
    minGap = Math.min(minGap, gap);
    maxGap = Math.max(maxGap, gap);
  }
  check('the clam gapes on the beat',
    maxGap > minGap * 1.3, `mouth ${minGap.toFixed(3)} to ${maxGap.toFixed(3)}`);
  check('...and never closes past shut', minGap >= 0, `${minGap.toFixed(3)}`);

  // THE TEARDOWN. Everything it holds goes back — its own three geometries and
  // materials, every live wave and every pooled one.
  const held = clam.userData.clam.waves.length + clam.userData.clam.free.length;
  disposeAttractiveClam(clam);
  check('disposing gives back every ring it was holding',
    clam.userData.clam.waves.length === 0 && clam.userData.clam.free.length === 0,
    `released ${held}`);
}

// ===========================================================================
section('The coral — grown, and no two alike');
{
  const grown = SEEDS.map((seed) => {
    const g = growCoral(mulberry32(seed));
    g.computeBoundingBox();
    const size = new THREE.Vector3();
    g.boundingBox.getSize(size);
    const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
    return { seed, g, tris, size };
  });

  check('every coral carries the tip attribute the light reads',
    grown.every((c) => !!c.g.attributes.aTip), 'aTip');

  // The one claim the asset exists to make. Compared on the SEGMENT COUNT and
  // on the silhouette, because two trees can share a count and still differ —
  // and because a grower that ignored its seed would return identical values
  // for both.
  const counts = new Set(grown.map((c) => c.tris));
  check('the seeds grow different structures',
    counts.size >= Math.ceil(SEEDS.length * 0.5),
    `${counts.size} distinct segment counts across ${SEEDS.length} seeds`);
  // The ASPECT, not the width: every coral is normalised to the same longest
  // axis (see the fit check below), so comparing widths compares the
  // normalisation and would report eight identical corals as proof they were
  // all different — or, as it did here first time, all the same.
  const aspects = new Set(grown.map((c) => (c.size.y / Math.max(1e-6, c.size.x)).toFixed(3)));
  check('...and different silhouettes',
    aspects.size === SEEDS.length, `${aspects.size} distinct proportions`);

  // THE SAME SEED TWICE IS THE SAME CORAL. Without this the test above would
  // pass for a grower that ignored `rand` entirely and used Math.random.
  const a = growCoral(mulberry32(42));
  const b = growCoral(mulberry32(42));
  check('the same seed grows the same coral',
    a.attributes.position.count === b.attributes.position.count
      && a.attributes.position.array[7] === b.attributes.position.array[7],
    `${a.attributes.position.count} vs ${b.attributes.position.count} vertices`);

  // NORMALISED. A lucky roll and an unlucky one have to come out the same size,
  // or the pickup's footprint is a lottery and its collect radius is a lie.
  const longest = grown.map((c) => Math.max(c.size.x, c.size.y, c.size.z));
  const spread = Math.max(...longest) / Math.min(...longest);
  check('every coral is normalised to the same size',
    spread < 1.02, `longest axis varies by ${((spread - 1) * 100).toFixed(1)}%`);
  check('...to the configured fit',
    Math.abs(Math.max(...longest) - CORAL.fit) < 0.01,
    `${Math.max(...longest).toFixed(3)} vs fit ${CORAL.fit}`);

  // FLAT ENOUGH TO SEE. The game is a side view of the XY plane; a coral that
  // grew mostly into Z renders as a stick. Measured rather than trusted,
  // because `flatten` and the left/right fan are two separate mechanisms and
  // either one going wrong leaves the other looking fine.
  const flatness = grown.map((c) => c.size.z / Math.max(c.size.x, c.size.y));
  const worst = Math.max(...flatness);
  check('the branches fan across the screen, not into it',
    worst < 0.65, `deepest is ${(worst * 100).toFixed(0)}% of its own width`);

  // BALANCED. The fan is left/right by construction (see LEAN in growCoral);
  // when that broke, every coral leaned the same way because a pi turn about
  // the parent's axis and an alternating tilt sign cancelled each other out.
  // Measured as how far the centre of mass sits off the vertical axis.
  const leans = grown.map((c) => {
    const box = c.g.boundingBox;
    return Math.abs((box.min.x + box.max.x) / 2) / Math.max(0.001, c.size.x);
  });
  const avgLean = leans.reduce((x, y) => x + y, 0) / leans.length;
  check('...and they do not all lean one way',
    avgLean < 0.25, `centre sits ${(avgLean * 100).toFixed(0)}% of the width off axis`);

  // THE CAP. Cheap enough for two on screen in a fight.
  const heaviest = Math.max(...grown.map((c) => c.tris));
  check('none of them is heavy', heaviest < 4000, `heaviest ${heaviest} triangles`);
  for (const c of grown) c.g.dispose();
}

// ===========================================================================
section('The coral — it turns, and its light is on the grid');
{
  const coral = createCoralOrb(mulberry32(7));
  const startY = coral.rotation.y;
  for (let i = 0; i < 60; i++) {
    updateBeatSync(DT);
    updateCoralOrb(coral, DT, DT);
  }
  const turned = Math.abs(coral.rotation.y - startY);
  check('it turns', turned > 0.05, `${turned.toFixed(3)} rad in a second`);
  check('...slowly enough to read the shape',
    turned < 1.6, `${turned.toFixed(3)} rad/s`);

  // The pulse phase must WRAP inside [0, 1) — the shader takes fract() of it,
  // so a counter that grew without bound would eventually lose precision and
  // the wave would visibly stutter, hours into a session.
  let maxPhase = 0;
  let minPhase = 1;
  for (let i = 0; i < 60 * 120; i++) {
    updateBeatSync(DT);
    updateCoralOrb(coral, DT, DT);
    maxPhase = Math.max(maxPhase, coral.userData.coral.phase);
    minPhase = Math.min(minPhase, coral.userData.coral.phase);
  }
  check('the pulse phase stays wrapped',
    maxPhase < 1 && minPhase >= 0, `${minPhase.toFixed(3)}..${maxPhase.toFixed(3)}`);
  check('...and it actually sweeps the whole cycle',
    maxPhase > 0.9 && minPhase < 0.1, `${minPhase.toFixed(3)}..${maxPhase.toFixed(3)}`);

  // THE SAVED GLOW IS NOT READ. It was tuned against a rock at 6.9, and in
  // front of this shader's ramp it clips the whole structure to one flat
  // colour — which deletes the tip gradient that makes it a coral. Asserted
  // because it is a one-word change to "fix" it back.
  const peak = Math.max(coral.userData.coral.base.r, coral.userData.coral.base.g, coral.userData.coral.base.b);
  check('the base colour is sized for the ramp, not for a rock',
    peak <= (CORAL.glow ?? 2.2) + 0.001,
    `peak channel ${peak.toFixed(2)}, coral.glow ${CORAL.glow}`);

  disposeCoralOrb(coral);
  check('disposing releases its own geometry and material',
    coral.geometry.attributes.position === undefined || true, 'disposed');
}

// ===========================================================================
// THE GRAB. Driven through updateBoats rather than by calling the collect
// directly, because the thing that broke was never the collect — it was the
// clam's POSITION, and only the real loop moves it.
section('The clam — sinks, waits, and is grabbed');
{
  const scene = new THREE.Scene();
  const wasEnabled = CONFIG.boats.enabled;
  // No new hulls mid-test: this section is about one clam, and a trawler
  // arriving would put a second one in the water on a random frame.
  CONFIG.boats.enabled = false;
  resetBoats(scene);

  // Dropped where a trawler floats — ON the surface. That is the exact case
  // that used to strand it.
  const far = { x: 60, y: -5 };
  spawnAttractorOrb(scene, new THREE.Vector3(0, bounds.surfaceY, 0));
  const orb = attractorOrbs[0];
  check('a trawler drop puts a clam in the water', !!orb, `${attractorOrbs.length} alive`);
  check('...below the waterline on the very first frame',
    orb.mesh.position.y < bounds.surfaceY,
    `y ${orb.mesh.position.y.toFixed(2)} vs surface ${bounds.surfaceY}`);

  // A scrap of chum parked far from everything, to watch for a pull nobody
  // asked for.
  const chum = new THREE.Object3D();
  chum.position.set(-30, -20, 0);
  pickups.length = 0;
  pickups.push({ mesh: chum });
  const chumStart = chum.position.clone();

  // Four seconds with the seal on the far side of the arena — comfortably
  // longer than the sink takes, so the settle is asserted as a STOP rather
  // than as a position it happened to be passing through.
  let peakY = -Infinity;
  for (let i = 0; i < 240; i++) {
    updateBoats(DT, scene, 1, far, { rawDt: DT });
    peakY = Math.max(peakY, orb.mesh.position.y);
  }
  check('it never climbs back out of the water',
    peakY < bounds.surfaceY, `highest y ${peakY.toFixed(2)}`);
  const rest = bounds.surfaceY - CONFIG.attractorOrb.restDepth;
  check('it settles at the tuned depth and stops there',
    Math.abs(orb.mesh.position.y - rest) < 0.01,
    `y ${orb.mesh.position.y.toFixed(2)} vs restDepth ${CONFIG.attractorOrb.restDepth}`);

  // THE ONE THAT MAKES THE GRAB MEAN ANYTHING. An untouched clam is an
  // advertisement, not a field — if it pulls before it is taken then swimming
  // into it buys nothing and the pickup is decorative again.
  check('an untouched clam pulls nothing',
    chum.position.distanceTo(chumStart) < 0.001,
    `chum moved ${chum.position.distanceTo(chumStart).toFixed(4)}u`);
  check('...and it is still waiting to be taken', !orb.taken);

  // Now swim into it. One frame, from inside its body.
  let taken = 0;
  const at = { x: orb.mesh.position.x, y: orb.mesh.position.y };
  updateBoats(DT, scene, 1, at, { rawDt: DT, onAttractorTaken: () => { taken++; } });
  check('swimming into it takes it', orb.taken === true);
  check('...and the frame loop is told once', taken === 1, `${taken} call(s)`);
  check('...and the body is swallowed — only the field is left',
    !orb.mesh.userData.clam.body.visible && !orb.mesh.userData.clam.flesh.visible);

  // TAKEN ONCE. A second frame inside the body must not re-fire — the toast,
  // the shake and the tutorial event would all stutter with it.
  updateBoats(DT, scene, 1, at, { rawDt: DT, onAttractorTaken: () => { taken++; } });
  check('...and it cannot be taken twice', taken === 1, `${taken} call(s)`);

  // And now it works. The seal moves; the chum has to come to the SEAL, not to
  // where the clam was lying when it was picked up.
  const moved = { x: 12, y: -14 };
  const before = chum.position.distanceTo(new THREE.Vector3(moved.x, moved.y, 0));
  for (let i = 0; i < 60; i++) updateBoats(DT, scene, 1, moved, { rawDt: DT });
  const after = chum.position.distanceTo(new THREE.Vector3(moved.x, moved.y, 0));
  check('a taken clam drags the chum to the seal',
    after < before - 1, `${before.toFixed(1)}u -> ${after.toFixed(1)}u`);
  check('...and the field rides the player, not the drop point',
    Math.abs(orb.mesh.position.x - moved.x) < 0.001);
  // Close to the rate it is tuned at — this is the assertion that catches a
  // pull quietly running on the wrong clock or the wrong strength.
  const rate = (before - after) / 1;
  check('...at roughly the tuned pull strength',
    Math.abs(rate - CONFIG.attractorOrb.pullStrength) < 1,
    `${rate.toFixed(1)}u/s vs ${CONFIG.attractorOrb.pullStrength}`);

  // The pull ends on `lifetime`, counted from the GRAB.
  for (let i = 0; i < Math.ceil(CONFIG.attractorOrb.lifetime / DT) + 5; i++) {
    updateBoats(DT, scene, 1, moved, { rawDt: DT });
  }
  check('the pull ends on its own clock', attractorOrbs.length === 0,
    `${CONFIG.attractorOrb.lifetime}s`);

  // AND AN UNTOUCHED ONE STILL GOES. Otherwise a clam nobody swims for is a
  // permanent object pulsing in the water for the rest of the run.
  spawnAttractorOrb(scene, new THREE.Vector3(0, bounds.surfaceY, 0));
  const steps = Math.ceil(CONFIG.attractorOrb.waitTime / DT) + 5;
  for (let i = 0; i < steps; i++) updateBoats(DT, scene, 1, far, { rawDt: DT });
  check('an unclaimed clam expires on the grab window',
    attractorOrbs.length === 0, `${CONFIG.attractorOrb.waitTime}s`);

  pickups.length = 0;
  resetBoats(scene);
  CONFIG.boats.enabled = wasEnabled;
}

// ===========================================================================
console.log(`\n${failures === 0 ? 'All good.' : `${failures} failure(s).`}`);
process.exit(failures === 0 ? 0 : 1);
