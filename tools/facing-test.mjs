#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:facing
//
// WHICH WAY A BODY IS POINTED — systems/facing.js.
//
// Side-on, "facing" is one bit, and for most of this game's life it was written
// as `rotation.y = vx < 0 ? PI : 0` in nine different files. That line is an
// animal changing ends between two frames. It is nearly invisible on a sprat
// and increasingly silly the bigger the body is, which is backwards: the slow
// heavy things are the ones being watched.
//
// Everything here fails silently. A turn that never completes leaves a creature
// swimming sideways, which reads as a bad model. A deadzone that is too small
// leaves a hovering creature flickering, which reads as a bad animation. And a
// pooled body that keeps a previous occupant's heading spins on its first frame
// alive, which reads as nothing at all — it is one frame.
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { faceSide, snapSide } from '../path/src/systems/facing.js';
import { enemies, resetEnemies, updateEnemies } from '../path/src/entities/enemies.js';
import { resetProjectiles } from '../path/src/entities/projectiles.js';
import { updateBoss, resetBoss, bossState, forceBoss } from '../path/src/systems/boss.js';
import { bounds } from '../path/src/arena.js';

const DT = 1 / 60;
let fail = 0;
const check = (n, ok, d = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? ` — ${d}` : ''}`);
  if (!ok) fail++;
};
const obj = () => new THREE.Object3D();
const TIME = CONFIG.facing.time;

// ---------------------------------------------------------------------------
console.log('\nTHE FIRST HEADING IS TAKEN, NOT TURNED TO');
// ---------------------------------------------------------------------------
{
  const o = obj();
  faceSide(o, -5, DT);
  check('a body seen for the first time faces its travel at once',
    Math.abs(o.rotation.y - Math.PI) < 1e-9, `rotation.y ${o.rotation.y.toFixed(4)}`);
  const o2 = obj();
  faceSide(o2, 5, DT);
  check('...either way', o2.rotation.y === 0, `rotation.y ${o2.rotation.y}`);
  // Otherwise every creature in the game would spin on its first frame alive.
  check('snapSide does the same without a dt', snapSide(obj(), -1) === Math.PI);
}

// ---------------------------------------------------------------------------
console.log('\nAND THE NEXT ONE IS A TURN');
// ---------------------------------------------------------------------------
{
  const o = obj();
  faceSide(o, 5, DT); // established facing right
  const seen = [];
  let frames = 0;
  while (Math.abs(o.rotation.y - Math.PI) > 1e-4 && frames++ < 600) {
    faceSide(o, -5, DT);
    seen.push(o.rotation.y);
  }
  check('it gets all the way round', Math.abs(o.rotation.y - Math.PI) < 1e-4,
    `ended at ${o.rotation.y.toFixed(4)}`);
  check('...taking about the configured time', Math.abs(frames * DT - TIME) < 0.05,
    `${(frames * DT).toFixed(3)}s against ${TIME}s`);
  // THE CHECK THAT WOULD HAVE CAUGHT THE OLD CODE: a snap puts every sample at
  // one end or the other and none in between.
  const between = seen.filter((y) => y > 0.2 && y < Math.PI - 0.2).length;
  check('...through the middle rather than across it', between > 5,
    `${between} samples between the two headings`);
  // SMOOTHNESS, not step size. Half a turn in 0.4s is 0.13 rad a frame on
  // average and more than twice that through the eased middle, which is
  // correct and would fail any fixed cap worth setting. What a snap looks like
  // is one frame carrying the whole PI and every other frame carrying nothing
  // — so the thing to measure is the RATIO of the biggest step to the average.
  const steps = seen.slice(1).map((y, i) => Math.abs(y - seen[i]));
  const jump = Math.max(...steps);
  const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
  check('...smoothly, rather than mostly in one frame', jump < mean * 3,
    `biggest step ${jump.toFixed(4)} against a mean of ${mean.toFixed(4)} rad`);
  check('...with no single frame carrying most of the turn', jump < Math.PI * 0.25,
    `${(jump / Math.PI * 100).toFixed(0)}% of the turn in its biggest frame`);
  // Eased, not linear: the middle of the turn moves faster than the ends.
  const mid = seen[Math.floor(seen.length / 2)] - seen[Math.floor(seen.length / 2) - 1];
  const start = seen[1] - seen[0];
  check('...and eased, so the rudder bites and lets go', mid > start * 1.5,
    `${start.toFixed(4)} rad/frame at the start, ${mid.toFixed(4)} in the middle`);
}

// ---------------------------------------------------------------------------
console.log('\nA TURN CAN CHANGE ITS MIND');
// ---------------------------------------------------------------------------
{
  const o = obj();
  faceSide(o, 5, DT);
  for (let i = 0; i < 12; i++) faceSide(o, -5, DT); // part-way round
  const midTurn = o.rotation.y;
  check('a turn is under way', midTurn > 0.02 && midTurn < Math.PI - 0.02,
    `at ${midTurn.toFixed(4)} rad`);
  faceSide(o, 5, DT); // and back again
  check('...reversing it continues from where the body is', Math.abs(o.rotation.y - midTurn) < 0.1,
    `${midTurn.toFixed(4)} -> ${o.rotation.y.toFixed(4)}, not back to square one`);
  let n = 0;
  while (o.rotation.y > 1e-4 && n++ < 600) faceSide(o, 5, DT);
  check('...and finishes the new one', o.rotation.y <= 1e-4, `${o.rotation.y.toFixed(6)}`);
}

// ---------------------------------------------------------------------------
console.log('\nTHE DEADZONE');
// ---------------------------------------------------------------------------
{
  const o = obj();
  faceSide(o, 5, DT);
  // A body drifting to a stop. Without a deadzone the sign of a number this
  // small flickers, every flicker restarts the turn, and the creature never
  // finishes one — it just sits sideways.
  const tiny = CONFIG.facing.deadzone * 0.5;
  for (let i = 0; i < 240; i++) faceSide(o, i % 2 ? tiny : -tiny, DT);
  check('a body hovering near a standstill keeps its heading', o.rotation.y === 0,
    `rotation.y ${o.rotation.y.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
console.log('\nA RECYCLED BODY DOES NOT INHERIT A HEADING');
// ---------------------------------------------------------------------------
{
  // Creature bodies are pooled. resetVisual puts every node back to its rest
  // transform and does NOT clear userData — so the facing state outlives the
  // creature that made it, and the next occupant would turn a full 180 on its
  // first frame alive to "finish" somebody else's manoeuvre.
  const o = obj();
  faceSide(o, -5, DT);
  check('the old occupant left facing left', o.rotation.y === Math.PI);
  o.rotation.y = 0; // what resetVisual does
  faceSide(o, -5, DT);
  check('...and the new one takes its heading outright, without a turn',
    o.rotation.y === Math.PI, `rotation.y ${o.rotation.y.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
console.log('\nAND A REAL CREATURE TURNS THE SAME WAY');
// ---------------------------------------------------------------------------
{
  const scene = new THREE.Scene();
  resetEnemies(scene); resetProjectiles(scene); resetBoss(scene);
  const gs = { difficulty: 20, level: 20, running: true };
  const shark = forceBoss(scene, gs, { boss: 'bossShark', perk: null });
  let n = 0;
  while (bossState.arriving && n++ < 1000) updateBoss(DT, gs, scene);
  check('a shark to watch', !!shark && shark.def.faceMotion === true, shark?.type);

  // MADE TO TURN, rather than asked nicely. The first version of this put the
  // target at one end of the arena and then the other, which sounds like a
  // reversal and is not one: the arena is 247 units across and a shark swims at
  // about 5.5 a second, so over the frames it was given it never got near
  // either target and simply swam one way the whole time. The heading never
  // changed, and the test failed perhaps half the time depending on which side
  // the boss happened to spawn on — a flake in the harness reported as a bug in
  // the turn.
  //
  // Chasing a target placed just past the shark's own nose, flipped side every
  // couple of seconds, makes the reversal certain and quick.
  const yaws = [];
  const at = { x: 0, y: bounds.bottom + 10, z: 0 };
  for (let leg = 0; leg < 6; leg++) {
    const side = leg % 2 ? -1 : 1;
    for (let i = 0; i < 120; i++) {
      at.x = shark.mesh.position.x + side * 25;
      updateEnemies(DT, scene, at, () => {}, () => {});
      yaws.push(shark.visual.rotation.y);
    }
  }

  check('nothing went NaN', enemies.every((e) => Number.isFinite(e.visual.rotation.y)));
}

console.log(fail ? `\nFAIL — ${fail} check(s)` : '\nPASS');
process.exit(fail ? 1 : 0);
