#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:physics
//
// THE TWO THINGS THAT GET KNOCKED AROUND INSTEAD OF KILLED — the sea turtle,
// which cannot die, and a boat, which cannot chase. Both are now simulated
// bodies sharing one class (path/src/systems/rigidBody.js), and every claim
// this makes is a claim about MOTION OVER TIME: where a punted turtle ends up,
// whether it comes back upright, whether a hull that was shoved gets back on
// course. A screenshot answers none of that, and the browser preview cannot
// even run it — it suspends requestAnimationFrame, so the loop is frozen there.
//
// What is worth failing over:
//
//   BODY      that the turtle actually gets one and nothing else does, and
//             that the body is torn down with its owner. A body left in the
//             world after its creature is gone is an invisible obstacle other
//             bodies keep bouncing off, and nothing on screen would say why.
//
//   LAUNCH    that a strike gives it real velocity that CARRIES — the whole
//             point of the rewrite. The old path was a position offset that
//             decayed in a fraction of a second; if applyKnockback ever falls
//             back to it for a body, the turtle stops being ammunition and
//             nothing throws.
//
//   UPRIGHT   that it really tumbles and really comes back level, the short
//             way round. This is the one property both bodies must share and
//             the easiest to lose: a spring that reads an unwrapped angle
//             rewinds three full visible turns, and a spring with no drag on
//             the spin never settles at all.
//
//   HULL      that a boat still sails at its sailing speed and sits on the
//             water line now that it is under thrust and buoyancy rather than
//             on a rail — and that it still cannot capsize while afloat.
//
//   IMPACT    that a turtle arriving at a hull moves it, hurts it, and bounces
//             off it, and that a wreck's blast throws what floats near it.
//             This is the chain reaction; it is also the one place damage can
//             now come from a collision, so its floor matters.
//
// What it cannot tell you: whether a punt feels good. That is a controller.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { bounds } from '../path/src/arena.js';
import {
  enemies, spawnNamed, updateEnemies, resetEnemies, removeEnemy, applyKnockback,
} from '../path/src/entities/enemies.js';
import {
  boats, updateBoats, resetBoats, damageBoat, jostleBoat, impactBoat,
} from '../path/src/systems/boats.js';
import {
  bodies, stepBodies, blastBodies, resetBodies, wrapAngle,
} from '../path/src/systems/rigidBody.js';

const scene = new THREE.Scene();
const dt = 1 / 60;
const playerPos = new THREE.Vector3(0, -20, 0);

// The animation controller warns once per state per creature for clips a
// procedural stand-in does not have, which in Node is all of them.
const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[animation]') || msg.startsWith('[assets]'))) return;
  realWarn(msg, ...rest);
};

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
const section = (s) => console.log(`\n${s}`);

function clearAll() {
  resetEnemies(scene);
  resetBoats(scene);
  // Belt and braces: the two resets above unregister what they own, and a body
  // surviving BOTH of them is exactly the leak this harness is checking for —
  // so the leak test reads `bodies` before this runs, never after.
  resetBodies();
}

function spawnAt(type, x, y) {
  const e = spawnNamed(scene, type, 0, { x, y }, { ignoreCaps: true });
  if (!e) throw new Error(`could not spawn ${type}`);
  e.entering = false;
  return e;
}

// One game frame for everything with a body in it: the creatures move
// themselves, then the physics resolves what that left. Same order as the game
// loop in main.js — running the step first would resolve against stale
// positions and quietly pass tests the game fails.
function frame(hooks = {}) {
  updateEnemies(dt, scene, playerPos, () => {}, () => {});
  stepBodies(dt, hooks);
}

// Boats arrive on a timer of their own, which is the last thing a test wants:
// every spawn here is asked for explicitly. The interval is pinned to zero so
// the timer is always already up, and the spawner itself is held off except
// for the one frame that is meant to produce a hull.
CONFIG.boats.spawnMin = 0;
CONFIG.boats.spawnMax = 0;
CONFIG.boats.enabled = false;
// Which kind of hull arrives is a coin flip in the game and must not be one
// here: a trawler is 2.4x the mass, so a test that happened to draw one would
// measure a different shove every run. Rowboats by default; the trawler gets
// its own case, built explicitly.
CONFIG.boats.trawlerChance = 0;

// A boat through the REAL spawner rather than hand-built, so the mass, the hull
// box and the body wiring under test are the ones the game makes.
function spawnBoatNow(difficulty = 0) {
  const before = boats.length;
  CONFIG.boats.enabled = true;
  // A dt small enough that nothing has sailed anywhere measurable by the time
  // the boat comes back.
  updateBoats(1e-4, scene, difficulty, playerPos, {});
  CONFIG.boats.enabled = false;
  if (boats.length <= before) throw new Error('no boat spawned');
  return boats[boats.length - 1];
}

// --------------------------------------------------------------------- bodies

section('BODY — who gets one, and what happens to it when they go');

clearAll();
{
  const turtle = spawnAt('seaTurtle', 0, -14);
  const shark = spawnAt('shark', 6, -14);
  check('the turtle is a simulated body', !!turtle.body);
  check('...registered in the physics world', bodies.includes(turtle.body));
  check('...as a circle', turtle.body.shape === 'circle');
  check('...with the mass from its profile, scaled by the size it rolled',
    Math.abs(turtle.body.mass
      - CONFIG.physics.turtle.mass * Math.pow(turtle.sizeMul, CONFIG.physics.turtle.massExp)) < 1e-9,
    `${turtle.body.mass.toFixed(2)} at ${turtle.sizeMul.toFixed(2)}x size`);
  check('a shark is not', !shark.body,
    'only creatures with `rigidBody` on their def get one');

  const boat = spawnBoatNow();
  check('a hull is a simulated body', !!boat.body && boat.body.shape === 'box');
  check('...heavier than the turtle', boat.body.mass > turtle.body.mass,
    `${boat.body.mass} vs ${turtle.body.mass}`);
  check('...and a trawler is heavier still',
    (CONFIG.physics.boat.trawlerMass ?? 0) > 1,
    `x${CONFIG.physics.boat.trawlerMass}`);

  const registered = bodies.length;
  removeEnemy(scene, enemies.indexOf(turtle));
  check('killing the creature takes its body out of the world',
    bodies.length === registered - 1 && !bodies.includes(turtle.body));

  damageBoat(scene, boats.indexOf(boat), 1e9, {});
  check('...and so does sinking the boat', !bodies.includes(boat.body),
    `${bodies.length} left`);
}

// ---------------------------------------------------------------------- sizes

section('SIZES — a spread of shells, which is a spread of weights');

clearAll();
{
  const spread = [];
  for (let i = 0; i < 200; i++) {
    const t = spawnAt('seaTurtle', 0, -14);
    spread.push({ size: t.sizeMul, radius: t.radius, mass: t.body.mass });
    removeEnemy(scene, enemies.indexOf(t));
  }
  const sizes = spread.map((s) => s.size);
  const min = Math.min(...sizes);
  const max = Math.max(...sizes);
  const variance = CONFIG.enemies.seaTurtle.scaleVariance;

  check('the size roll comes from the CSV column, not from code',
    variance > 0, `scaleVariance ${variance}`);
  check('...and it is a WIDE spread, not a wobble', max / min > 2.5,
    `${min.toFixed(2)}x to ${max.toFixed(2)}x`);
  check('...inside the range the column asks for',
    min >= Math.max(0.2, 1 - variance) - 1e-9 && max <= 1 + variance + 1e-9,
    `[${(1 - variance).toFixed(2)}, ${(1 + variance).toFixed(2)}]`);
  // The hitbox is derived from the visual (spawnOne), so radius/size has to be
  // the same constant for every individual — that constant being the asset's
  // own scale. If it drifts, some turtles are being hit where they are not.
  const perSize = spread.map((s) => s.radius / s.size);
  check('the hitbox follows the shell',
    Math.max(...perSize) - Math.min(...perSize) < 1e-9,
    `${Math.min(...spread.map((s) => s.radius)).toFixed(2)} to ${Math.max(...spread.map((s) => s.radius)).toFixed(2)} world units`);
  check('...and so does the mass, by the square of it',
    spread.every((s) => Math.abs(s.mass - CONFIG.physics.turtle.mass * s.size ** 2) < 1e-9),
    `${Math.min(...spread.map((s) => s.mass)).toFixed(2)} to ${Math.max(...spread.map((s) => s.mass)).toFixed(2)}`);

  // The point of all that: the same punt does visibly different things.
  clearAll();
  const runt = spawnAt('seaTurtle', -20, -14);
  const boulder = spawnAt('seaTurtle', 20, -14);
  runt.body.setMass(CONFIG.physics.turtle.mass * 0.4 ** 2);
  boulder.body.setMass(CONFIG.physics.turtle.mass * 1.6 ** 2);
  applyKnockback(runt, 1, 0, 1);
  applyKnockback(boulder, 1, 0, 1);
  check('a runt is fired off faster than a boulder by the same strike',
    runt.body.vx > boulder.body.vx * 2,
    `${runt.body.vx.toFixed(1)} vs ${boulder.body.vx.toFixed(1)} u/s`);
  check('...and the boulder still moves, rather than shrugging it off',
    boulder.body.vx > 3, `${boulder.body.vx.toFixed(1)} u/s`);
}

// --------------------------------------------------------------------- launch

section('LAUNCH — a strike fires the turtle instead of nudging it');

clearAll();
{
  const turtle = spawnAt('seaTurtle', 0, -14);
  const shark = spawnAt('shark', 0, -24);
  const startX = turtle.mesh.position.x;

  // A NOMINAL turtle, pinned. Its size is rolled per individual and its mass
  // goes as the square of that (see SIZES above), so an unpinned one is a punt
  // anywhere between a cannonball and a boulder — which is exactly right in
  // the game and useless in a distance threshold. Same move the runt/boulder
  // pair above makes, for the opposite reason.
  turtle.body.setMass(CONFIG.physics.turtle.mass);

  applyKnockback(turtle, 1, 0, 1);
  const sharkPush = applyKnockback(shark, 1, 0, 1);
  // HOW FAR THAT SHOVE IS WORTH, in units: the knock is a velocity decaying
  // exponentially, so it integrates to speed/decay. Measured this way rather
  // than by watching the shark's position, because a shark swims 7 units/sec
  // under its own power in whatever direction it rolled at spawn — its actual
  // travel over a second and a half is mostly steering, and a threshold
  // written against it is a coin flip. See the same argument, at length, in
  // tools/strike-impact-test.mjs.
  const sharkReach = sharkPush / (shark.knockDecay || CONFIG.strike.knockback.decay);

  check('the shove lands as body velocity', turtle.body.vx > 1,
    `${turtle.body.vx.toFixed(1)} u/s`);
  check('...and NOT on the old decaying offset', !turtle.knockX,
    'a body must never take both paths');
  check('...and it spins the shell', Math.abs(turtle.body.angVel) > 0.1,
    `${turtle.body.angVel.toFixed(2)} rad/s`);

  for (let i = 0; i < 90; i++) frame(); // a second and a half
  const turtleTravel = turtle.mesh.position.x - startX;

  check('a punted turtle crosses real distance', turtleTravel > 25,
    `${turtleTravel.toFixed(1)} units in 1.5s, arena is ${bounds.width.toFixed(0)} wide`);
  // Still further than a shark, but the margin is no longer the whole story:
  // a big creature that SURVIVES a ram is genuinely knocked back now (see
  // CONFIG.strike.knockback.heavy), so the shark below is not the "barely
  // moves" control it once was. What still separates them is what happens
  // AFTER the shove — checked immediately below.
  check('...still much further than the same shove is worth to a body without one',
    turtleTravel > sharkReach * 2,
    `turtle ${turtleTravel.toFixed(1)} units vs a shove worth ${sharkReach.toFixed(1)}`);
  // THE ACTUAL DIFFERENCE between ammunition and a shoved animal: the turtle
  // is still travelling a second and a half later because the velocity is
  // ITS OWN, while the shark's shove is an offset that has bled off and left
  // it swimming again. Lose this and the turtle has quietly gone back to
  // being a creature with a knock on it.
  check('...and it is still going, while the shark is swimming again',
    Math.abs(turtle.body.vx) > 5 && Math.abs(shark.knockX ?? 0) < 1,
    `turtle ${turtle.body.vx.toFixed(1)} u/s, shark residual ${(shark.knockX ?? 0).toFixed(2)}`);
  check('...and it is still finite', Number.isFinite(turtle.mesh.position.x));
}

// -------------------------------------------------------------------- upright

section('UPRIGHT — it tumbles, then rights itself, the short way round');

clearAll();
{
  const turtle = spawnAt('seaTurtle', 0, -14);
  // A punt, not a hand-set angle: the spin has to come off the same call the
  // game makes, or this passes on arithmetic the game never runs.
  applyKnockback(turtle, 1, 0, 1);
  turtle.body.angVel = Math.sign(turtle.body.angVel || 1) * 14; // a hard, deliberate spin
  let turned = 0;
  let last = turtle.body.angle;
  let leanWhileFlying = 0;
  let worstAfterSettling = 0;

  for (let i = 0; i < 60 * 14; i++) {
    frame();
    // Total angle travelled, unwrapped — proof it really went round rather
    // than jittering near zero.
    turned += Math.abs(wrapAngle(turtle.body.angle - last));
    last = turtle.body.angle;
    if (i < 60 * 2) leanWhileFlying = Math.max(leanWhileFlying, Math.abs(wrapAngle(turtle.body.angle)));
    if (i > 60 * 12) worstAfterSettling = Math.max(worstAfterSettling, Math.abs(wrapAngle(turtle.body.angle)));
  }

  check('it really cartwheels', turned > Math.PI * 2,
    `${(turned / (Math.PI * 2)).toFixed(1)} full turns`);
  check('...and is nowhere near level while it is still flying', leanWhileFlying > 1,
    `${leanWhileFlying.toFixed(2)} rad over — a spring that fought the tumble from frame one would keep this near zero`);
  check('...but is upright again once it has stopped', worstAfterSettling < 0.1,
    `${worstAfterSettling.toFixed(3)} rad off level after 12s`);
  check('...with the roll laid on top of its heading, not replacing it',
    Math.abs(turtle.mesh.rotation.z - (turtle.body.restAngle + turtle.body.angle)) < 1e-6);

  // The trap: an unwrapped spring sees a body that has spun N times as N*2PI
  // of error and unwinds every one of them. Same test from a wound-up angle.
  turtle.body.angle = Math.PI * 6 + 0.4;
  turtle.body.angVel = 0;
  for (let i = 0; i < 60 * 3; i++) frame();
  check('a body wound up six turns still settles level, not after six rewinds',
    Math.abs(wrapAngle(turtle.body.angle)) < 0.1,
    `${wrapAngle(turtle.body.angle).toFixed(3)} rad`);
}

// ----------------------------------------------------------------------- walls

section('WALLS — the ocean is a box it bounces off, not one it sticks to');

clearAll();
{
  const turtle = spawnAt('seaTurtle', bounds.right - 6, -14);
  turtle.body.vx = 40;
  let hitWall = false;
  for (let i = 0; i < 120; i++) {
    frame();
    if (turtle.mesh.position.x > bounds.right) hitWall = true;
  }
  check('it never leaves the arena', !hitWall,
    `x ${turtle.mesh.position.x.toFixed(1)}, wall ${bounds.right.toFixed(1)}`);
  check('...and it comes back off the wall rather than parking against it',
    turtle.mesh.position.x < bounds.right - 1,
    `${(bounds.right - turtle.mesh.position.x).toFixed(1)} units clear`);

  // Straight up: the water line is a lid for anything that doesn't breach.
  turtle.body.vy = 40;
  for (let i = 0; i < 60; i++) frame();
  check('...and it stays under the water', turtle.mesh.position.y < bounds.surfaceY,
    `y ${turtle.mesh.position.y.toFixed(2)}`);
}

// ------------------------------------------------------------------ the crowd

section('PLOW — a flying turtle barges a school without hurting it');

clearAll();
{
  const turtle = spawnAt('seaTurtle', 0, -14);
  const fish = spawnAt('fish', 1.2, -14);
  const hp = fish.hp;
  turtle.body.vx = 30;

  let worstKnock = 0;
  for (let i = 0; i < 30; i++) {
    frame();
    worstKnock = Math.max(worstKnock, Math.hypot(fish.knockX, fish.knockY));
  }
  check('the fish is shoved', worstKnock > 1, `${worstKnock.toFixed(1)} u/s`);
  check('...and takes no damage from it', fish.hp === hp,
    'a punt must never become a damage source');

  // One shove per victim per launch. Thirty frames of contact applying the
  // full impulse each time would stack an order of magnitude past this.
  const k = CONFIG.strike.knockback;
  const power = CONFIG.physics.turtle.plow;
  const single = k.speed * (k.powerMin + (k.powerMax - k.powerMin) * power);
  check('...exactly once, not once per frame of contact', worstKnock <= single * 1.05,
    `${worstKnock.toFixed(1)} vs one shove ${single.toFixed(1)}`);
}

// ------------------------------------------------------------------- the hull

section('HULL — still sails, still floats, still cannot capsize');

clearAll();
{
  const boat = spawnBoatNow();
  const startX = boat.body.x;
  for (let i = 0; i < 120; i++) {
    updateBoats(dt, scene, 0, playerPos, {});
    stepBodies(dt);
  }
  const travelled = (boat.body.x - startX) * boat.dir;
  const expected = boat.speed * 2;
  check('an untouched hull crosses at its sailing speed',
    Math.abs(travelled - expected) < expected * 0.15,
    `${travelled.toFixed(2)} units in 2s, expected ~${expected.toFixed(2)}`);
  check('...and rides the water line', Math.abs(boat.mesh.position.y - bounds.surfaceY) < 0.6,
    `y ${boat.mesh.position.y.toFixed(2)}`);

  // Shoved hard backwards: it must LOSE ground and then get back under way.
  // Moved to mid-arena first — a hull spawns just outside the wall it enters
  // by, and a ram that shoves it back the way it came would sail it straight
  // out of the despawn margin, which is a boat leaving rather than a boat
  // recovering.
  boat.body.place(0, bounds.surfaceY);
  jostleBoat(boat, -boat.dir, 0, 1, { x: boat.body.x, y: boat.body.y });
  const shovedFrom = boat.body.x;
  for (let i = 0; i < 20; i++) {
    updateBoats(dt, scene, 0, playerPos, {});
    stepBodies(dt);
  }
  check('a rammed hull is driven off its course',
    (boat.body.x - shovedFrom) * boat.dir < 0,
    `${((boat.body.x - shovedFrom) * boat.dir).toFixed(2)} units along its heading`);

  for (let i = 0; i < 60 * 8; i++) {
    updateBoats(dt, scene, 0, playerPos, {});
    stepBodies(dt);
    // Keep it in the middle of the arena: this is a test about velocity, and a
    // hull that reaches the despawn margin is removed mid-recovery, which
    // would freeze the numbers below at whatever they happened to be.
    boat.body.x = 0;
  }
  check('...and gets back up to speed by itself',
    Math.abs(boat.body.vx - boat.dir * boat.speed) < boat.speed * 0.2,
    `${boat.body.vx.toFixed(2)} vs cruise ${(boat.dir * boat.speed).toFixed(2)}`);
  check('...back on the water line', Math.abs(boat.mesh.position.y - bounds.surfaceY) < 0.6,
    `y ${boat.mesh.position.y.toFixed(2)}`);
}

// NO CAPSIZE, through the real spring rather than a copy of it in the test.
clearAll();
{
  const boat = spawnBoatNow();
  const limit = CONFIG.boats.hitReaction.maxRoll ?? 0.55;
  let worst = 0;
  for (let hit = 0; hit < 10; hit++) {
    // Full-charge rams on the same corner of the bow, the worst case for
    // winding the roll spring up.
    jostleBoat(boat, 1, 0.4, 1, { x: boat.body.x + boat.halfLength, y: boat.body.y + boat.halfHeight });
    for (let i = 0; i < 12; i++) {
      updateBoats(dt, scene, 0, playerPos, {});
      stepBodies(dt);
      worst = Math.max(worst, Math.abs(boat.body.angle));
    }
  }
  check('a hull rammed ten times never goes past its lean limit', worst <= limit + 1e-6,
    `worst ${worst.toFixed(3)} rad, limit ${limit}`);
  check('...and the limit is well short of capsizing', limit < Math.PI / 4, `${limit} rad`);
}

// THE HEEL — the second axis, and the one a player reads as "the boat rocked".
//
// Everything here is about ROLL ABOUT THE HULL'S OWN LENGTH (mesh.rotation.x),
// which is not the nod the checks above measure (body.angle, mesh.rotation.z).
// The two are easy to confuse in a side-on game and they are different
// gestures: the nod is the bow dipping, the heel is the deck tipping toward
// and away from the camera. A hull that only nodded answered every hit it ever
// took with the same motion at different sizes.
clearAll();
{
  const boat = spawnBoatNow();
  boat.body.place(0, bounds.surfaceY);
  check('a hull banks and a turtle does not', boat.body.banks === true);

  // Up from underneath, which is where the seal comes from. The heel is taken
  // off the VERTICAL part of the impulse (see `banks` in rigidBody.js), so
  // this is the case that should roll it hardest.
  jostleBoat(boat, 0, 1, 1, { x: boat.body.x, y: boat.body.y });
  check('a ram from below heels it', Math.abs(boat.body.bankVel) > 0.5,
    `${boat.body.bankVel.toFixed(2)} rad/s`);
  check('...away from the camera, not into it', boat.body.bankVel < 0,
    'the near side is the one being lifted');

  // ...and then it ROCKS: back through level and out the other side, more than
  // once, before it settles. A spring damped hard enough to kill the overshoot
  // would leave a hull that leans and returns, which is a flinch again.
  // Counted as sign changes of the heel with a deadzone, NOT as "the value is
  // big and has flipped": a crossing happens AT zero, so any threshold read on
  // the crossing frame itself is really asking how fast it was going through —
  // which is true of the first swing and false of every later one, and the
  // count silently stops rising as the rock dies down.
  let crossings = 0;
  let peak = 0;
  let side = 0;
  for (let i = 0; i < 60 * 4; i++) {
    updateBoats(dt, scene, 0, playerPos, {});
    stepBodies(dt);
    boat.body.x = 0; // keep it off the despawn margin — see above
    peak = Math.max(peak, Math.abs(boat.body.bank));
    if (Math.abs(boat.body.bank) > 1e-3) {
      const now = Math.sign(boat.body.bank);
      if (side !== 0 && now !== side) crossings++;
      side = now;
    }
  }
  check('...and it rocks rather than leaning and returning', crossings >= 3,
    `${crossings} passes through level`);
  check('...the rail may go under, the mast may not',
    peak <= (CONFIG.physics.boat.maxBank ?? 0.5) + 1e-6,
    `worst ${peak.toFixed(3)} rad, limit ${CONFIG.physics.boat.maxBank}`);
  check('...and it is level again a few seconds later', Math.abs(boat.body.bank) < 0.02,
    `${boat.body.bank.toFixed(3)} rad after 4s`);
  check('the heel is written onto the hull, not just held in the body',
    Math.abs(boat.mesh.rotation.x - (boat.body.restBank + boat.body.bank)) < 1e-9);
}

// Ten full-charge rams, the worst case for winding the heel spring up.
clearAll();
{
  const boat = spawnBoatNow();
  const limit = CONFIG.physics.boat.maxBank ?? 0.5;
  let worst = 0;
  for (let hit = 0; hit < 10; hit++) {
    jostleBoat(boat, 0, 1, 1, { x: boat.body.x, y: boat.body.y });
    for (let i = 0; i < 12; i++) {
      updateBoats(dt, scene, 0, playerPos, {});
      stepBodies(dt);
      worst = Math.max(worst, Math.abs(boat.body.bank));
    }
  }
  check('a hull rammed ten times never rolls its mast into the water',
    worst <= limit + 1e-6, `worst ${worst.toFixed(3)} rad, limit ${limit}`);
}

// Nothing else in the water has an opinion about that axis, and writing it on
// a body that never asked would put a permanent cant on a shell.
clearAll();
{
  const turtle = spawnAt('seaTurtle', 0, -14);
  applyKnockback(turtle, 0, 1, 1);
  for (let i = 0; i < 60; i++) frame();
  check('a punted turtle is never heeled', turtle.body.banks === false
    && turtle.body.bank === 0 && Math.abs(turtle.mesh.rotation.x) < 1e-9,
    `rotation.x ${turtle.mesh.rotation.x.toFixed(4)}`);
}

// A trawler is heavier — the same ram moves it less.
clearAll();
{
  const boat = spawnBoatNow();
  boat.isTrawler = false;
  boat.body.setMass(CONFIG.physics.boat.mass);
  jostleBoat(boat, 0, -1, 1, null);
  const light = Math.abs(boat.body.vy);

  const trawler = spawnBoatNow();
  trawler.isTrawler = true;
  trawler.body.setMass(CONFIG.physics.boat.mass * CONFIG.physics.boat.trawlerMass);
  jostleBoat(trawler, 0, -1, 1, null);
  check('a trawler barely flinches next to a rowboat',
    Math.abs(trawler.body.vy) < light,
    `${Math.abs(trawler.body.vy).toFixed(2)} vs ${light.toFixed(2)} u/s`);
}

// ----------------------------------------------------------------- the impact

section('IMPACT — a turtle at a hull, and the chain that follows');

clearAll();
{
  const boat = spawnBoatNow();
  boat.dir = 1;
  boat.body.vx = 0;
  boat.body.place(0, bounds.surfaceY);
  boat.hp = 1e6; // survives the hit, so the bounce is measurable afterwards

  // A NOMINAL turtle, by taking its size roll away for this one block. Its
  // radius decides how deep its own clamp holds it under the surface, and that
  // is what decides which FACE of the hull it arrives at: a nominal one comes
  // in under the bow and is deflected down, a boulder rides low enough to meet
  // the side and is simply reversed. Both are correct behaviour and only one
  // of them is what the check below is about, so the roll cannot be left in —
  // it failed roughly one run in four before it was pinned. Same argument as
  // CONFIG.boats.trawlerChance at the top of this file.
  const rolled = CONFIG.enemies.seaTurtle.scaleVariance;
  CONFIG.enemies.seaTurtle.scaleVariance = 0;
  const turtle = spawnAt('seaTurtle', -boat.halfLength - 3, bounds.surfaceY - 0.5);
  CONFIG.enemies.seaTurtle.scaleVariance = rolled;
  turtle.body.place(turtle.mesh.position.x, turtle.mesh.position.y);
  turtle.body.vx = 45;

  let impacts = 0;
  let reported = 0;
  const hullBefore = boat.hp;
  const boatVxBefore = boat.body.vx;
  for (let i = 0; i < 60; i++) {
    frame({
      onImpact: (hit) => {
        impacts++;
        reported = Math.max(reported, hit.speed);
        if (hit.a.kind === 'boat') impactBoat(scene, hit.a, hit, {});
        if (hit.b.kind === 'boat') impactBoat(scene, hit.b, hit, {});
      },
    });
    // The boat is not being sailed in this test, so hold its own update out of
    // it: what is being measured is purely what the collision did.
    boat.body.restAngle = 0;
  }

  check('they actually collide', impacts > 0, `${impacts} contacts`);
  check('...at the speed the turtle arrived', reported > 20, `${reported.toFixed(1)} u/s`);
  check('the hull is shoved along the punt', boat.body.vx > boatVxBefore + 0.5,
    `${boat.body.vx.toFixed(2)} u/s`);
  check('...and rolls from it', Math.abs(boat.body.angle) > 1e-3,
    `${boat.body.angle.toFixed(3)} rad`);
  check('...and takes real damage', boat.hp < hullBefore,
    `${(hullBefore - boat.hp).toFixed(1)} damage`);
  // The turtle does NOT simply reverse, and that is the geometry telling the
  // truth rather than a bug: it swims a full body-radius under the water line
  // (clampBelowSurface at spawn), so it always arrives at the hull's underside
  // and is deflected DOWN and off its line rather than straight back. What has
  // to be true is that the collision took its punt away from it.
  check('the turtle is deflected off its line', turtle.body.vy < -1,
    `${turtle.body.vx.toFixed(2)}, ${turtle.body.vy.toFixed(2)} u/s`);
  check('...losing most of its punt to the hull', turtle.body.vx < 45 * 0.5,
    `${turtle.body.vx.toFixed(2)} of 45 u/s left`);
  check('...and survives, as it always does', enemies.includes(turtle));

  // A drift is not a hit. Same geometry, at the speed a turtle swims.
  const hpNow = boat.hp;
  turtle.body.place(-boat.halfLength - 1, bounds.surfaceY - 0.5);
  turtle.body.vx = 1.5;
  for (let i = 0; i < 30; i++) {
    frame({
      onImpact: (hit) => {
        if (hit.a.kind === 'boat') impactBoat(scene, hit.a, hit, {});
        if (hit.b.kind === 'boat') impactBoat(scene, hit.b, hit, {});
      },
    });
  }
  check('a turtle drifting into a hull does not hurt it', boat.hp === hpNow,
    'below CONFIG.physics.impact.minSpeed it is only a bump');
}

// Two hulls: they pass each other in peace, and collide once one is shoved.
clearAll();
{
  const a = spawnBoatNow();
  const b = spawnBoatNow();
  // Head-on and overlapping, which is what two hulls crossing the arena in
  // opposite directions actually do.
  const meet = (disturbed) => {
    a.body.place(-0.5, bounds.surfaceY);
    b.body.place(0.5, bounds.surfaceY);
    a.body.vx = 4;
    b.body.vx = -4;
    a.body.angle = 0; a.body.angVel = 0;
    b.body.angle = 0; b.body.angVel = 0;
    a.body.disturbed = 0;
    b.body.disturbed = disturbed;
    stepBodies(dt);
  };

  meet(0);
  check('two hulls sailing normally do not fight over the same water',
    a.body.vx === 4 && b.body.vx === -4,
    'a solid head-on between two thrusting hulls is a permanent deadlock');

  meet(1); // something just hit it
  check('...but a hull that has just been shoved hits the next one',
    a.body.vx < 4 && b.body.vx > -4,
    `${a.body.vx.toFixed(2)} / ${b.body.vx.toFixed(2)} u/s, from ±4`);
  check('...and rolls it, which is how the chain keeps going',
    Math.abs(a.body.angVel) > 1e-6 || Math.abs(b.body.angVel) > 1e-6);
}

// A hull that sinks FROM the collision, while the pass that found it is still
// running: the hook removes the boat's body from the same list the solver is
// walking (see pendingImpacts). Two turtles into two one-hp hulls in the same
// frame is the worst version of it — what has to hold afterwards is that
// nothing threw and that every body still in the world belongs to something
// still in the game.
clearAll();
{
  const one = spawnBoatNow();
  const two = spawnBoatNow();
  one.hp = 1;
  two.hp = 1;
  one.body.place(0, bounds.surfaceY);
  two.body.place(3, bounds.surfaceY);
  one.body.vx = 0;
  two.body.vx = 0;

  const a = spawnAt('seaTurtle', -4, bounds.surfaceY - 0.5);
  const b = spawnAt('seaTurtle', 7, bounds.surfaceY - 0.5);
  a.body.place(-4, bounds.surfaceY - 0.5);
  b.body.place(7, bounds.surfaceY - 0.5);
  a.body.vx = 60;
  b.body.vx = -60;

  let threw = null;
  let sunk = 0;
  try {
    for (let i = 0; i < 30; i++) {
      frame({
        onImpact: (hit) => {
          const sank = { onBoatDestroyed: () => { sunk++; } };
          if (hit.a.kind === 'boat') impactBoat(scene, hit.a, hit, sank);
          if (hit.b.kind === 'boat') impactBoat(scene, hit.b, hit, sank);
        },
      });
    }
  } catch (err) {
    threw = err;
  }

  check('two hulls sunk by collisions in one pass does not break the loop',
    !threw, threw ? String(threw.message) : `${sunk} sunk`);
  check('...and the world agrees with itself afterwards',
    bodies.every((body) => (body.kind === 'boat' ? boats.includes(body.owner) : enemies.includes(body.owner))),
    `${bodies.length} bodies, ${boats.length} boats`);
}

// The wreck's blast, reaching what floats near it.
clearAll();
{
  const turtle = spawnAt('seaTurtle', 3, bounds.surfaceY - 1);
  turtle.body.place(3, bounds.surfaceY - 1);
  turtle.body.vx = 0;
  turtle.body.vy = 0;
  blastBodies(0, bounds.surfaceY, 12, 11);
  check('an explosion throws the turtle floating next to it', turtle.body.speed() > 1,
    `${turtle.body.speed().toFixed(1)} u/s`);
  check('...away from the blast, not toward it', turtle.body.vx > 0,
    `${turtle.body.vx.toFixed(2)} u/s`);

  // Out of range is out of range.
  turtle.body.place(60, bounds.surfaceY - 1);
  turtle.body.vx = 0;
  turtle.body.vy = 0;
  blastBodies(0, bounds.surfaceY, 12, 11);
  check('...and nothing outside the radius moves', turtle.body.speed() === 0);
}

// The tuner switch. `enabled: false` has to mean "nothing bumps into
// anything", NOT "no boats" — a hull's position is its body now, so a switch
// that skipped the whole step would park every boat in the ocean.
clearAll();
{
  CONFIG.physics.enabled = false;
  const boat = spawnBoatNow();
  boat.body.place(0, bounds.surfaceY);
  const startX = boat.body.x;
  const turtle = spawnAt('seaTurtle', -4, bounds.surfaceY - 0.5);
  turtle.body.place(-4, bounds.surfaceY - 0.5);
  turtle.body.vx = 45;

  let impacts = 0;
  for (let i = 0; i < 60; i++) {
    updateBoats(dt, scene, 0, playerPos, {});
    updateEnemies(dt, scene, playerPos, () => {}, () => {});
    stepBodies(dt, { onImpact: () => { impacts++; } });
  }
  check('with collisions off, the hull still sails', Math.abs(boat.body.x - startX) > 1,
    `${(boat.body.x - startX).toFixed(2)} units`);
  check('...and the mesh still follows it', Math.abs(boat.mesh.position.x - boat.body.x) < 1e-6);
  check('...but nothing collides', impacts === 0);
  check('...and the turtle passes straight through', turtle.body.vx > 0,
    `${turtle.body.vx.toFixed(1)} u/s, unchanged in direction`);
  CONFIG.physics.enabled = true;
}

// ------------------------------------------------------------------- leaving

section('LEAVING — it visits, it does not move in');

clearAll();
{
  const stay = CONFIG.enemies.seaTurtle.drift.stay;
  const jitter = CONFIG.enemies.seaTurtle.drift.stayJitter ?? 0;
  const turtle = spawnAt('seaTurtle', 0, -14);
  const rolled = turtle.stayTimer;
  check('a turtle arrives on a clock', Number.isFinite(rolled),
    `${rolled.toFixed(1)}s, from ${stay}±${jitter}`);
  check('...rolled per individual, inside the range the config asks for',
    rolled >= stay - jitter - 1e-9 && rolled <= stay + jitter + 1e-9);

  let turnedAt = null;
  let goneAt = null;
  for (let i = 0; i < 60 * 120 && !goneAt; i++) {
    frame();
    if (!turnedAt && turtle.leaving) turnedAt = i / 60;
    if (turnedAt && !enemies.includes(turtle)) goneAt = i / 60;
  }
  check('it turns for open water when its stay is up', turnedAt !== null,
    `at ${turnedAt?.toFixed(1)}s`);
  check('...at the time it rolled at spawn, not at some shared moment',
    Math.abs(turnedAt - rolled) < 0.2,
    `turned at ${turnedAt?.toFixed(1)}s, rolled ${rolled.toFixed(1)}s`);
  check('...and it is actually gone a few seconds later', goneAt !== null,
    `left at ${goneAt?.toFixed(1)}s`);
  check('...without leaving its body behind in the physics world',
    bodies.length === 0, `${bodies.length} bodies`);
  check('...and it swam out rather than bouncing off the wall it aimed at',
    goneAt - turnedAt < 20, `${(goneAt - turnedAt).toFixed(1)}s to cross`);
}

// A turtle in mid-punt is the thing the player is using. Its clock stops.
clearAll();
{
  const turtle = spawnAt('seaTurtle', 0, -14);
  turtle.stayTimer = 1.5;
  for (let i = 0; i < 60 * 3; i++) {
    // Keep it flying, the way a player volleying one off the walls would.
    if (turtle.body.speed() < 20) applyKnockback(turtle, i % 120 < 60 ? 1 : -1, 0, 1);
    frame();
  }
  check('a turtle being played with does not wander off mid-flight',
    !turtle.leaving && turtle.stayTimer > 0,
    `${turtle.stayTimer.toFixed(2)}s left after 3s of being punted around`);
}

// ------------------------------------------------------------------- the soak

section('SOAK — two minutes of boats, turtles and punts, in the loop order');

clearAll();
{
  CONFIG.boats.enabled = true;
  CONFIG.boats.spawnMin = 3;
  CONFIG.boats.spawnMax = 6;
  const seen = { impacts: 0, destroyed: 0 };
  let worstBodies = 0;

  for (let i = 0; i < 60 * 120; i++) {
    // Keep a turtle or two in the water the way the spawner would, then punt
    // whatever is there in a random direction every couple of seconds. This is
    // the part no unit check covers: bodies arriving, colliding, blowing up
    // and being removed while the loop keeps running.
    if (enemies.length < 2 && i % 90 === 0) {
      const t = spawnNamed(scene, 'seaTurtle', 1, undefined, { ignoreCaps: true });
      if (t) t.entering = false;
    }
    if (i % 120 === 0) {
      for (const e of enemies) {
        if (e.body) applyKnockback(e, Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random());
      }
    }

    updateBoats(dt, scene, 2, playerPos, { onBoatDestroyed: () => { seen.destroyed++; } });
    updateEnemies(dt, scene, playerPos, () => {}, () => {});
    stepBodies(dt, {
      onImpact: (hit) => {
        seen.impacts++;
        if (hit.a.kind === 'boat') impactBoat(scene, hit.a, hit, {});
        if (hit.b.kind === 'boat') impactBoat(scene, hit.b, hit, {});
      },
    });

    worstBodies = Math.max(worstBodies, bodies.length);
  }

  const allFinite = bodies.every((b) => Number.isFinite(b.x) && Number.isFinite(b.y)
    && Number.isFinite(b.vx) && Number.isFinite(b.vy)
    && Number.isFinite(b.angle) && Number.isFinite(b.angVel));
  check('nothing in the physics world has gone NaN', allFinite);
  check('turtles really were being thrown at hulls', seen.impacts > 0,
    `${seen.impacts} impacts, ${seen.destroyed} hulls sunk`);
  check('the body count stays bounded over a long run',
    worstBodies <= CONFIG.boats.maxAlive + CONFIG.enemies.seaTurtle.maxConcurrent + 2,
    `peak ${worstBodies} bodies`);
  check('...and every live body still belongs to something on screen',
    bodies.every((b) => (b.kind === 'boat' ? boats.includes(b.owner) : enemies.includes(b.owner))),
    `${bodies.length} bodies, ${boats.length} boats, ${enemies.length} creatures`);
  // Anything still here is either inside the walls or on its way out through
  // them; nothing is parked in the margin or under the seabed.
  check('every turtle is inside the arena or visibly leaving it',
    enemies.every((e) => !e.body
      || ((e.leaving || (e.mesh.position.x > bounds.left - 1 && e.mesh.position.x < bounds.right + 1))
        && e.mesh.position.y > bounds.bottom - 1 && e.mesh.position.y < bounds.surfaceY + 1)));
}

// ---------------------------------------------------------------------------
clearAll();
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
