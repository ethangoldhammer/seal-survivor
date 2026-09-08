#!/usr/bin/env node
// Does the man o' war actually sit ON the water?
//
//   npm run test:float
//
// The animal's whole identity is that it is a sail on the surface with its
// fishing gear hanging underneath, and every part of that is a position rather
// than a picture — so it can be measured, and it needs to be, because three
// separate clamps in entities/enemies.js are each entitled to hold a creature
// under the waterline and two of them do it during the entrance only. A body
// that settles correctly after ten seconds and swam in submerged is a bug you
// would only ever catch by watching the first four seconds of a spawn.
//
// WHAT IS BEING PROVEN:
//
//   IT RISES TO THE LINE and stays there, from a spawn that starts below it.
//   THE FLOAT IS OUT AND THE FILAMENTS ARE IN — measured off the model's own
//        geometry rather than asserted, because "head out of the water" is a
//        claim about where the mesh ends up and the pivot arithmetic that puts
//        it there (see CONFIG.enemies.manowar.surface) is exactly the kind of
//        thing that is plausible and off by a factor.
//   IT RIDES THE WAVES rather than the flat still-line, which is the whole
//        reason the pin reads `surfaceHeightAt` and not `bounds.surfaceY`.
//   IT IS NOT HELD UNDER DURING THE ENTRANCE, the failure `enterClampY` exists
//        for.
import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { ASSET_ROWS } from '../path/src/assetTable.js';
import { enemies, resetEnemies, updateEnemies, spawnNamed } from '../path/src/entities/enemies.js';
import { bounds, surfaceHeightAt } from '../path/src/arena.js';

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
Math.random = seeded(0x3A17);

const scene = new THREE.Scene();
const DT = 1 / 60;
let fail = 0;
const check = (n, ok, d = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? ` — ${d}` : ''}`);
  if (!ok) fail++;
};

resetEnemies(scene);
const pp = { x: 0, y: bounds.bottom + 8, z: 0 };

// THE GEOMETRY OF THE ANIMAL, worked out the way assets.js works it out, so
// this file and the config are reading the same model rather than agreeing by
// coincidence. No GLB loads in Node — createVisual falls back to the primitive
// shape — so the numbers come from the same arithmetic assets.js applies, and
// the model's own long axis is the one measurement taken from the file.
const MODEL_SPAN = 5.735;           // manowar.glb's y extent, its longest axis
const def = CONFIG.enemies.manowar;
// READ FROM THE TABLE, not typed. This was a literal 1.9 and went stale the
// moment the animal was made bigger — the arithmetic below is the whole point
// of the file, so a hardcoded copy of one of its inputs is the one number that
// must not be here.
const size = Number(ASSET_ROWS.get('enemyManOWar').size);
const fit = 2;                      // enemyManOWar's `fit` in assets.js
const scale = (fit / MODEL_SPAN) * size;
const pivot = 0.25;                 // enemyManOWar's `pivot` in assets.js
// Distances from the ORIGIN, which is where mesh.position sits.
const toFloatTop = pivot * MODEL_SPAN * scale;
const toTip = (1 - pivot) * MODEL_SPAN * scale;
// The crown is where the filaments leave the float: model y 0.512 against a
// top of 2.81 (tools/rig-manowar.mjs prints both). Expressed like the two
// above as a distance DOWN from the origin, which is what makes all three
// signs read the same way — the first version of this measured the crown from
// the float's top instead and reported it on the wrong side of the water.
const toCrown = toFloatTop - (2.81 - 0.512) * scale;

console.log('\nTHE BODY, as assets.js will build it');
console.log(`  long axis ${(MODEL_SPAN * scale).toFixed(2)} world units (fit ${fit} x size ${size})`);
console.log(`  origin sits ${toFloatTop.toFixed(2)} below the float's top and ${toTip.toFixed(2)} above the tips`);
console.log(`  the crown is ${(-toCrown).toFixed(2)} below the origin`);
console.log('  (all three measured DOWN from the origin, so a positive figure is below it)');

console.log('\nTHE PIN');
// NO `at`, deliberately. Passing a spawn point is what a debug button does;
// the wave spawner does not, and the point edgeSpawnPoint picks for a surface
// body is half of what is being tested here. An earlier version of this file
// forced the body to the seabed and then measured the twelve-second climb it
// had itself created.
const e = spawnNamed(scene, 'manowar', 0, undefined, { ignoreCaps: true });
check('a man o\' war spawns', !!e, e?.type);
if (!e) process.exit(1);
check('...and its def carries a surface block', !!def.surface, JSON.stringify(def.surface));
check('...and canBreach, or the ceiling clamp caps it at the waterline',
  def.canBreach === true);
check('...and it opts out of the entrance ceiling clamp', e.enterClampY === false, String(e.enterClampY));

check('it arrives ON the line, not at a rolled depth',
  Math.abs((e.mesh.position.y - surfaceHeightAt(e.mesh.position.x)) - def.surface.lift) < 0.5,
  `spawned at ${(e.mesh.position.y - surfaceHeightAt(e.mesh.position.x)).toFixed(2)}`);

// DEEPEST POINT DURING THE APPROACH as well as where it ends up. The entrance
// is the half of this that no steady-state check can see: two of the three
// clamps entitled to hold a body under the line only run while it is arriving.
let deepest = Infinity;
for (let n = 0; n < 60 * 6; n++) {
  updateEnemies(DT, scene, pp, () => {}, () => {});
  if (!enemies.includes(e)) break;
  deepest = Math.min(deepest, e.mesh.position.y - surfaceHeightAt(e.mesh.position.x));
}
check('it is still in the water after six seconds', enemies.includes(e), `${enemies.length} alive`);

const line = surfaceHeightAt(e.mesh.position.x);
const rel = e.mesh.position.y - line;
const floatTop = rel + toFloatTop;
const crown = rel + toCrown;
const tip = rel - toTip;
console.log(`  settled at ${rel.toFixed(3)} relative to the local water height (lift asks for ${def.surface.lift})`);
console.log(`  float top  ${floatTop >= 0 ? '+' : ''}${floatTop.toFixed(2)}   crown ${crown.toFixed(2)}   tips ${tip.toFixed(2)}`);

check('it settles where `lift` asks it to', Math.abs(rel - def.surface.lift) < 0.15,
  `${rel.toFixed(3)} vs ${def.surface.lift}`);
check('THE FLOAT IS OUT OF THE WATER', floatTop > 0.3, `top is ${floatTop.toFixed(2)} above the line`);
check('...but the animal is not hovering — the crown is wet', crown < 0, `crown ${crown.toFixed(2)}`);
check('THE FILAMENTS HANG UNDER IT', tip < -1, `tips ${tip.toFixed(2)}`);
// IT IS NEVER DRAGGED UNDER, at any point in the approach. This is the
// `enterClampY` failure, and the number is tight on purpose: that clamp holds
// a body at `surfaceY - radius`, which on this animal's 0.95 radius would show
// up here as roughly -0.95. Anything past half a radius is it.
check('it was never dragged under during the approach', deepest > -0.5,
  `deepest ${deepest.toFixed(2)} below the line`);

console.log('\nIT RIDES THE WAVES, NOT THE STILL LINE');
// Walk it across the arena and compare where it sits against the flat mean. If
// the pin were reading bounds.surfaceY the two would be identical everywhere.
let maxOffLine = 0;
let maxOffMean = 0;
for (let i = 0; i < 60 * 8; i++) {
  updateEnemies(DT, scene, pp, () => {}, () => {});
  if (!enemies.includes(e)) break;
  const local = surfaceHeightAt(e.mesh.position.x);
  maxOffLine = Math.max(maxOffLine, Math.abs((e.mesh.position.y - local) - def.surface.lift));
  maxOffMean = Math.max(maxOffMean, Math.abs((e.mesh.position.y - bounds.surfaceY) - def.surface.lift));
}
console.log(`  worst error against the LOCAL water height ${maxOffLine.toFixed(3)}`);
console.log(`  worst error against the FLAT still line     ${maxOffMean.toFixed(3)}`);
check('it tracks the local water height', maxOffLine < 0.5, maxOffLine.toFixed(3));

console.log('\nIT SAILS, IT DOES NOT SPIN');
check('the constant spin is gone', !def.spin && !def.spinAxis,
  `spin=${def.spin} spinAxis=${def.spinAxis}`);
check('...replaced by a sail', !!def.sail, JSON.stringify(def.sail));
// A COMPARISON, not an absolute. "The yaw changed" proves nothing on its own —
// a constant spin changes it too, which is the exact thing being removed. So
// this holds a heading, checks the yaw is STILL, then reverses the drift and
// checks it moves.
// LONGER THAN THE TURN TAKES, which is the whole reason this is spelled out.
// `sail.time` is 2.4s and the first version of this settled for 1s, then
// measured "is it holding still" while the body was still a third of the way
// through coming about — and it passed for weeks only because the state it
// happened to inherit from the section above left it pointing the right way.
// Settle for twice the turn, so the reading cannot depend on what ran before.
const settleFrames = Math.ceil((def.sail.time * 2) / DT);
e.wanderAngle = 0; e.wanderTimer = 1e9;
for (let i = 0; i < settleFrames; i++) { e.vx = 3; updateEnemies(DT, scene, pp, () => {}, () => {}); }
const held = e.visual.rotation.y;
for (let i = 0; i < 30; i++) { e.vx = 3; updateEnemies(DT, scene, pp, () => {}, () => {}); }
const stillHeld = e.visual.rotation.y;
check('holding a tack, the body does not turn', Math.abs(stillHeld - held) < 0.02,
  `${held.toFixed(3)} -> ${stillHeld.toFixed(3)} over half a second`);
for (let i = 0; i < settleFrames; i++) { e.vx = -3; updateEnemies(DT, scene, pp, () => {}, () => {}); }
const comeAbout = e.visual.rotation.y;
check('...and reversing brings it about', Math.abs(comeAbout - stillHeld) > 2.5,
  `${stillHeld.toFixed(3)} -> ${comeAbout.toFixed(3)} (a half turn is ${Math.PI.toFixed(3)})`);

console.log('\nTHE FILAMENTS STING');
check('it carries a sting', !!def.sting, JSON.stringify(def.sting));
// The reach, in the same world units everything above is in. combat.js turns
// `offset`/`radius` into a circle at `offset x e.radius` down the body.
const stingY = def.sting.offset * e.radius;
const stingR = def.sting.radius * e.radius;
console.log(`  a circle of radius ${stingR.toFixed(2)} centred ${(-stingY).toFixed(2)} below the origin`);
console.log(`  the filaments run from ${(-toCrown).toFixed(2)} to ${toTip.toFixed(2)} below it`);
// IT HAS TO COVER THE FILAMENTS AND MISS THE FLOAT — those are the two halves
// of "swimming into the top of one is free", and either can be true alone.
check('the sting reaches the filament tips', -stingY + stingR >= toTip - 0.3,
  `reaches ${(-stingY + stingR).toFixed(2)}, tips at ${toTip.toFixed(2)}`);
check('...and does not reach the float', -stingY - stingR > -toFloatTop,
  `top of the sting is ${(-stingY - stingR).toFixed(2)} below the origin, the float starts at ${(-toFloatTop).toFixed(2)}`);
check('the poison is a LOW drain, well under the jellyfish\'s 30/s',
  def.contactDamage > 0 && def.contactDamage <= 12, `${def.contactDamage}/s`);
check('...and it names a feedback event that exists',
  !!CONFIG.feedback[def.sting.feedback], def.sting.feedback);

console.log('\nKNOCKED OUT OF THE WATER, IT COMES BACK');
check('the def says how it falls', surfDef().gravity != null || CONFIG.arena?.gravity > 0,
  `gravity ${surfDef().gravity ?? CONFIG.arena.gravity}, sinkMass ${surfDef().sinkMass}`);
function launch(creature, vy) {
  creature.mesh.position.y = surfaceHeightAt(creature.mesh.position.x) + 0.5;
  creature.vy = vy;
  let peak = -Infinity;
  let backAt = null;
  for (let i = 0; i < 60 * 12; i++) {
    updateEnemies(DT, scene, pp, () => {}, () => {});
    if (!enemies.includes(creature)) break;
    const rel2 = creature.mesh.position.y - surfaceHeightAt(creature.mesh.position.x);
    peak = Math.max(peak, rel2);
    if (backAt == null && peak > 1 && rel2 <= 0) backAt = (i + 1) * DT;
  }
  return { peak, backAt, settled: creature.mesh.position.y - surfaceHeightAt(creature.mesh.position.x) };
}
const shove = launch(e, 26);
console.log(`  launched at 26 u/s: peaked ${shove.peak.toFixed(2)} above the line, back in the water at ${shove.backAt?.toFixed(2)}s`);
check('it actually leaves the water', shove.peak > 2, `peak ${shove.peak.toFixed(2)}`);
check('...and gravity brings it back', shove.backAt != null && shove.backAt < 3,
  `${shove.backAt?.toFixed(2)}s`);
// IT DOES NOT WINCH ITSELF DOWN. Ballistic fall from that peak, not the bob's
// `rise` cap — which on a 3-unit launch would take a full second longer.
check('...on a ballistic clock, not the bob speed',
  shove.backAt != null && shove.backAt < (shove.peak / surfDef().rise),
  `${shove.backAt?.toFixed(2)}s beats winching at ${surfDef().rise}/s (${(shove.peak / surfDef().rise).toFixed(2)}s)`);
check('...and it settles back on the line', Math.abs(shove.settled - surfDef().lift) < 0.4,
  `${shove.settled.toFixed(3)} vs ${surfDef().lift}`);

// MASS: the boss falls harder than the wave animal for the same launch. The
// comparison is the point — an absolute fall time would just re-measure gravity.
function surfDef() { return def.surface; }
const bossSurf = CONFIG.enemies.bossManOWar.surface;
check('the boss is heavier than the wave animal', bossSurf.sinkMass > surfDef().sinkMass,
  `${bossSurf.sinkMass} vs ${surfDef().sinkMass}`);

console.log(`\n${fail ? `${fail} FAILED` : 'all checks passed'}\n`);
process.exit(fail ? 1 : 0);
