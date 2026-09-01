#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:opening
//
// THE OPENING SHOAL — the few harmless fish a run starts with.
//
// A run opens with a DEAD boost meter (strike.charge.startPips is 0) and chum
// is the only thing that fills it, while difficulty 0 is also the slowest the
// spawn tap ever runs. So the opening was a seal that could not dash, in an
// empty ocean, waiting for the first fish it would need in order to earn one.
// CONFIG.spawn.opening is the answer: a handful of fish already in the water,
// scattered around the seal, harmless, on station.
//
// Every one of those words is a separate way for this to be quietly wrong, and
// none of them shows up as an error:
//
//   1. THE SCATTER   The right number of fish, one species, actually AROUND
//                    the seal rather than all on one side, and inside the
//                    arena wherever the seal happens to be standing.
//   2. ON STATION    Not `entering`. Every other spawn in the game is placed
//                    past the edge of the picture and swims in (see
//                    tools/entrance-test.mjs) — which for this shoal would
//                    mean it arrived after the seconds it exists to fill.
//   3. NO AGGRESSION All four ways a creature can act on the seal, zeroed —
//                    against a CONTROL of the same species spawned the
//                    ordinary way, because "0 damage" is only meaningful next
//                    to what that species normally carries.
//   4. THEY STAY PUT Driven through the real updateEnemies, against a control
//                    school that seeks: an ordinary shoal placed in a ring
//                    around the seal converges on it, and this one must not.
//                    That is the difference between food and a handout that
//                    swims into your mouth.
//   5. THE BOOST     The arithmetic the count is chosen for: enough chum to
//                    buy the first strike.
//   6. SWITCHED OFF  `enabled: false` leaves the water exactly as empty as it
//                    was, with no half-spawn on the way out.
//
// No renderer, on purpose: the browser preview suspends requestAnimationFrame,
// so a screenshot proves nothing about a spawn. Every number below comes from
// ticking the same functions main.js ticks.
//
//   node --import ./tools/vite-loader.mjs tools/opening-shoal-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { bounds, updateBounds, midWater } from '../path/src/arena.js';
import {
  enemies, resetEnemies, updateEnemies, spawnOpeningShoal, spawnNamed,
} from '../path/src/entities/enemies.js';

const DT = 1 / 60;
const ASPECT = 16 / 9;

let failures = 0;
const quiet = () => {};
function section(name) { console.log(`\n${name}`); }
function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

// Seeded, like every other spawn harness here: the species, the angles and the
// distances are all rolled, and a harness that let the dice decide would
// report a different shoal every run and pass or fail on the weather.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function withSeed(seed, fn) {
  const real = Math.random;
  Math.random = seeded(seed);
  try { return fn(); } finally { Math.random = real; }
}

updateBounds(ASPECT);
const scene = new THREE.Scene();
const OPENING = CONFIG.spawn.opening;
const dist = (e, at) => Math.hypot(e.mesh.position.x - at.x, e.mesh.position.y - at.y);
const meanDist = (list, at) => list.reduce((a, e) => a + dist(e, at), 0) / Math.max(1, list.length);

// ---------------------------------------------------------------------------
section('THE SCATTER — a ring of fish around the seal');
// ---------------------------------------------------------------------------
{
  const at = { x: 0, y: midWater(), z: 0 };
  resetEnemies(scene);
  const made = withSeed(0x5A01, () => spawnOpeningShoal(scene, at));

  check('the shoal is the configured size',
    made === OPENING.count && enemies.length === OPENING.count,
    `${made} fish, count is ${OPENING.count}`);

  const species = new Set(enemies.map((e) => e.type));
  check('...all of one species', species.size === 1, [...species].join(', '));

  // The pool is the boss forage's — "small enough to be a respite rather than
  // a threat" — so this can never roll a shark, however the roster changes.
  const big = enemies.filter((e) => !e.def.prey
    || e.radius > (CONFIG.spawn.waves?.lull?.maxRadius ?? Infinity));
  check('...and off the small-fry pool', big.length === 0,
    big.map((e) => e.type).join(', ') || [...species].join(''));

  const radii = enemies.map((e) => dist(e, at));
  const lo = Math.min(...radii);
  const hi = Math.max(...radii);
  // THE RING GOES OVAL AT THIS REACH and that is the arena, not the placement:
  // the water is about 18.8 units deep either side of midwater against a ring
  // that runs out to `radiusMax`, so the fish placed near the vertical are
  // pulled in by the margin clamp. So the near edge of the band is only a
  // claim about fish the clamp did not touch — a check that ignored that would
  // fail on a correct shoal, and one that dropped the near edge entirely would
  // stop noticing a shoal placed in the seal's lap.
  const pinned = (e) => e.mesh.position.y >= bounds.surfaceY - OPENING.margin - e.radius - 1e-3
    || e.mesh.position.y <= bounds.bottom + OPENING.margin + e.radius + 1e-3
    || e.mesh.position.x >= bounds.right - OPENING.margin - e.radius - 1e-3
    || e.mesh.position.x <= bounds.left + OPENING.margin + e.radius + 1e-3;
  const short = enemies.filter((e) => dist(e, at) < OPENING.radiusMin - 1e-6 && !pinned(e));
  check('every fish the arena left alone is inside the configured band',
    short.length === 0 && hi <= OPENING.radiusMax + 1e-6,
    `${lo.toFixed(1)}-${hi.toFixed(1)} vs ${OPENING.radiusMin}-${OPENING.radiusMax}`);
  // ...and the reach is worth having. Measured against the two numbers the
  // band is chosen against — see the note in config.js — because "16 to 32" is
  // only a distance if you know how fast the seal swims and how wide the frame
  // is, and both of those move.
  const seconds = OPENING.radiusMax / CONFIG.player.maxSpeed;
  check('...and the far edge is about a second of swimming, well inside the frame',
    seconds > 0.4 && seconds < 1.6 && OPENING.radiusMax < bounds.frameWidth * 0.5,
    `${OPENING.radiusMax} units = ${seconds.toFixed(2)}s at ${CONFIG.player.maxSpeed}/s, `
      + `frame half-width ${(bounds.frameWidth / 2).toFixed(0)}`);

  // AROUND, not merely near. Six rolls of a free angle can legitimately all
  // land on one side, which is a pile rather than a scatter and reads as the
  // spawner having failed; the even slices in spawnOpeningShoal are what stop
  // it. The check is that every quadrant the count can cover is covered.
  const quads = new Set(enemies.map((e) => {
    const a = Math.atan2(e.mesh.position.y - at.y, e.mesh.position.x - at.x);
    return Math.floor(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 2));
  }));
  check('...and they surround the seal rather than piling on one side',
    quads.size >= Math.min(4, OPENING.count), `${quads.size} of 4 quadrants`);

  const outside = enemies.filter((e) => e.mesh.position.x < bounds.left
    || e.mesh.position.x > bounds.right
    || e.mesh.position.y < bounds.bottom
    || e.mesh.position.y > bounds.surfaceY);
  check('nothing is placed outside the arena', outside.length === 0,
    outside.map((e) => `${e.mesh.position.x.toFixed(1)},${e.mesh.position.y.toFixed(1)}`).join('; '));
}

// ---------------------------------------------------------------------------
section('AGAINST THE WALL — a seal that starts in a corner');
// ---------------------------------------------------------------------------
// The scatter is centred on the seal and the seal is not always at midwater
// (`?sandbox`, and anything that moves the start), so the clamp has to hold.
// A fish outside the wall is not merely misplaced: it spawns with `entering`
// false, so nothing walks it back in and it sits in the rock for the run.
{
  const at = { x: bounds.right - 1, y: bounds.bottom + 1, z: 0 };
  resetEnemies(scene);
  withSeed(0xC0B1, () => spawnOpeningShoal(scene, at));

  const stuck = enemies.filter((e) => e.mesh.position.x > bounds.right - e.radius
    || e.mesh.position.x < bounds.left + e.radius
    || e.mesh.position.y < bounds.bottom + e.radius
    || e.mesh.position.y > bounds.surfaceY - e.radius);
  check('a shoal placed in the corner still lands in open water',
    stuck.length === 0 && enemies.length === OPENING.count,
    stuck.map((e) => `${e.mesh.position.x.toFixed(1)},${e.mesh.position.y.toFixed(1)}`).join('; ')
      || `${enemies.length} fish, arena x ${bounds.left.toFixed(0)}..${bounds.right.toFixed(0)}`);
}

// ---------------------------------------------------------------------------
section('ON STATION — already here, not on their way');
// ---------------------------------------------------------------------------
{
  const at = { x: 0, y: midWater(), z: 0 };
  resetEnemies(scene);
  withSeed(0x0575, () => spawnOpeningShoal(scene, at));

  const arriving = enemies.filter((e) => e.entering || e.deep);
  check('no fish is still swimming in from a wall or the seabed',
    arriving.length === 0, `${arriving.length} of ${enemies.length} arriving`);

  // ...and the control, which is the only thing that makes the line above
  // mean anything: the SAME species through the ordinary spawn is placed past
  // the picture and has to cross. If that ever stops being true, the check
  // above is passing on a mechanism that no longer exists.
  const key = enemies[0].type;
  resetEnemies(scene);
  const ordinary = withSeed(0x0576, () => spawnNamed(scene, key, 0));
  check('...while an ordinary spawn of the same fish does have to swim in',
    !!ordinary && (ordinary.entering || ordinary.deep),
    `${key} at x ${ordinary?.mesh.position.x.toFixed(1)}, arena edge ${bounds.right.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
section('NO AGGRESSION — every way a fish can touch you, zeroed');
// ---------------------------------------------------------------------------
{
  const at = { x: 0, y: midWater(), z: 0 };
  resetEnemies(scene);
  withSeed(0xD0C1, () => spawnOpeningShoal(scene, at));
  const shoal = [...enemies];
  const key = shoal[0].type;

  const armed = shoal.filter((e) => e.contactDamage !== 0 || e.biteDamage !== 0
    || e.shotDamage !== 0 || e.towardPlayer !== 0);
  check('the whole shoal is harmless and none of it seeks the seal',
    armed.length === 0,
    armed.map((e) => `${e.type} dmg ${e.contactDamage} seek ${e.towardPlayer}`).join('; ')
      || `${shoal.length} fish`);
  check('...and says so', shoal.every((e) => e.docile === true));

  // THE CONTROL. Zero is only a claim about this shoal if the same fish
  // normally arrives carrying something — a species retuned to 0 contact
  // damage would pass the check above with the whole mechanism deleted.
  resetEnemies(scene);
  const ordinary = withSeed(0xD0C2, () => spawnNamed(scene, key, 0));
  check('...where the same species spawned the ordinary way is not',
    !!ordinary && ordinary.contactDamage > 0 && ordinary.towardPlayer > 0
      && ordinary.docile === false,
    `${key}: dmg ${ordinary?.contactDamage.toFixed(1)}, seek ${ordinary?.towardPlayer.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
section('THEY STAY PUT — a scatter, not a mouthful delivered');
// ---------------------------------------------------------------------------
// The shoal is placed in a ring AROUND the seal, so the centre of that ring is
// the seal. Any pull toward the middle — the school's cohesion, or the swarm's
// `towardPlayer` — therefore gathers the whole thing into the player's mouth
// on its own, which is not food the player went and got. Measured against a
// control that does exactly that, because "they did not converge" is a claim
// about a force that has to be shown to exist.
{
  const at = { x: 0, y: midWater(), z: 0 };
  const SECONDS = 6;

  resetEnemies(scene);
  withSeed(0x57A7, () => spawnOpeningShoal(scene, at));
  const shoal = [...enemies];
  const shoalStart = meanDist(shoal, at);
  withSeed(0x57A8, () => {
    for (let t = 0; t < SECONDS; t += DT) updateEnemies(DT, scene, at, quiet, quiet);
  });
  // Counted HERE, before the control block empties the water: a survivor count
  // taken after resetEnemies is a count of zero every time, which is a failure
  // report about the harness wearing the costume of a failure about the game.
  const shoalLeft = shoal.filter((e) => enemies.includes(e));
  const shoalEnd = meanDist(shoalLeft, at);

  // The control: the same species, in the same ring, spawned the ordinary way
  // — carrying the `towardPlayer` seek every school in the game has, which is
  // the one thing `docile` takes away.
  const key = shoal[0].type;
  const def = CONFIG.enemies[key];
  resetEnemies(scene);
  withSeed(0x57A9, () => {
    for (let i = 0; i < shoal.length; i++) {
      const a = ((i + 0.5) / shoal.length) * Math.PI * 2;
      const d = (OPENING.radiusMin + OPENING.radiusMax) * 0.5;
      spawnNamed(scene, key, 0, { x: at.x + Math.cos(a) * d, y: at.y + Math.sin(a) * d },
        { ignoreCaps: true });
    }
  });
  const control = [...enemies];
  const controlStart = meanDist(control, at);
  withSeed(0x57AA, () => {
    for (let t = 0; t < SECONDS; t += DT) updateEnemies(DT, scene, at, quiet, quiet);
  });
  const controlEnd = meanDist(control.filter((e) => enemies.includes(e)), at);

  // THE CONTRAST IS THE CLAIM, not either number on its own. `controlEnd <
  // controlStart * 0.6` was a bar calibrated against the school pull of the day
  // — clownfish at `towardPlayer` 1.3 — and it went red the moment that was
  // tuned down to 0.42, which is a change to how hard fish follow and not to
  // whether the opening shoal is exempt from it. A control that closes 38%
  // against a shoal that closes 7% proves the point exactly as well as one that
  // closed 45%, and the tuning is free to move again tomorrow.
  //
  // So: the control has to actually converge, the shoal has to hold station,
  // and the gap between them has to be large. Stated as a ratio, which is the
  // one form of it that does not need recalibrating.
  const closed = (a, b) => (a - b) / a;
  const ctl = closed(controlStart, controlEnd);
  const shl = closed(shoalStart, shoalEnd);
  check('ordinary fish placed in that ring close on the seal',
    ctl > 0.15,
    `${controlStart.toFixed(1)} → ${controlEnd.toFixed(1)} over ${SECONDS}s (${(ctl * 100).toFixed(0)}% closed)`);
  check('...and the opening shoal does not',
    shoalEnd > shoalStart * 0.75,
    `${shoalStart.toFixed(1)} → ${shoalEnd.toFixed(1)} over ${SECONDS}s (${(shl * 100).toFixed(0)}% closed)`);
  check('...and the difference between them is not a rounding error',
    ctl > shl * 3, `control closed ${(ctl * 100).toFixed(0)}% against the shoal's ${(shl * 100).toFixed(0)}%`);
  check('...and it is still there to be eaten',
    shoalLeft.length === shoal.length,
    `${shoalLeft.length} of ${shoal.length} left`);

  if (def.swarm) {
    check('(the control really was seeking)', (def.swarm.towardPlayer ?? 0) > 0,
      `${key} towardPlayer ${def.swarm.towardPlayer}`);
  }
}

// ---------------------------------------------------------------------------
section('THE BOOST — what the count is actually for');
// ---------------------------------------------------------------------------
{
  const refill = CONFIG.strike.charge.chumRefill;
  // One kill is one orb (see the drop in main.js), and one orb is `chumRefill`
  // of the bar — so the shoal is worth `count * chumRefill` links.
  const links = OPENING.count * refill;
  check('the shoal pays for at least one boost link',
    links >= 1, `${OPENING.count} fish x ${refill} = ${links.toFixed(2)} links`);
  check('...and the run really does open with an empty meter',
    (CONFIG.strike.charge.startPips ?? 0) === 0,
    `startPips ${CONFIG.strike.charge.startPips}`);
}

// ---------------------------------------------------------------------------
section('SWITCHED OFF');
// ---------------------------------------------------------------------------
{
  const at = { x: 0, y: midWater(), z: 0 };
  const wasEnabled = OPENING.enabled;
  const wasCount = OPENING.count;

  OPENING.enabled = false;
  resetEnemies(scene);
  check('off spawns nothing', withSeed(0x0FF0, () => spawnOpeningShoal(scene, at)) === 0
    && enemies.length === 0, `${enemies.length} in the water`);

  OPENING.enabled = true;
  OPENING.count = 0;
  resetEnemies(scene);
  check('...and so does a count of zero',
    withSeed(0x0FF1, () => spawnOpeningShoal(scene, at)) === 0 && enemies.length === 0,
    `${enemies.length} in the water`);

  OPENING.enabled = wasEnabled;
  OPENING.count = wasCount;
  resetEnemies(scene);
}

console.log(failures === 0 ? '\nAll good.' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
