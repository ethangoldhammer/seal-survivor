#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:chumpull
//
// CHUM DOES NOT VANISH NEAR A MOUTH — IT GOES INTO ONE.
//
// Three things, all of which used to be true of a straight line and a timer:
//
//   1. THE CURL. An orb being drawn in corkscrews rather than sliding along a
//      ruler at a constant rate. The whole risk of that is arrival: the curl
//      is an OFFSET off the caller's own pull and not a fourth force fighting
//      it, so an orb that would have arrived still arrives, in about the same
//      time. If that ever stops being true this is where it shows up — food
//      orbiting a mouth forever is the exact bug the magnet latch exists to
//      prevent, and it would arrive here disguised as a nice effect.
//
//   2. THE STREAK. A ribbon while it is being pulled, through the same mover
//      contract the clubs use. It has to be the SAME mover object every frame
//      — a rebuilt one is a ribbon whose history restarts every frame, which
//      draws nothing at all and looks exactly like the feature being off — and
//      it has to be gone the moment the orb is, because the mesh goes back to
//      the instance pool and is handed to the next orb that spawns.
//
//   3. THE KILL ZONE. `bitePickup` used to delete the orb when a chew TIMER
//      ran out, wherever it had drifted to; the whale deleted it on crossing
//      `mouthRadius`, a sphere with half its volume in open water in front of
//      the animal. Both are "an orb vanished near something big". Now the orb
//      has to be inside the eater's body, and the gate drags it there itself
//      so it can never stall.
//
//   node --import ./tools/vite-loader.mjs tools/chum-pull-test.mjs
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { updateBounds } from '../path/src/arena.js';
import { enemies, resetEnemies } from '../path/src/entities/enemies.js';
import {
  updatePickups, resetPickups, bitePickup, pickups,
} from '../path/src/entities/pickups.js';
import { pullTrailMovers, resetChumPull } from '../path/src/systems/chumPull.js';
import {
  resetWhales, spawnWhale, updateWhales, bodyDistance, bodyPush, intakeRadius, mouthAheadOf,
} from '../path/src/systems/whale.js';

const DT = 1 / 60;
const scene = new THREE.Scene();
updateBounds(16 / 9);

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// Seeded, so a curl rolled per orb (phase, spin) cannot make an assertion flake
// one run in fifty and get "fixed" by loosening the threshold.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function withSeed(seed, fn) {
  const real = Math.random;
  Math.random = mulberry32(seed);
  try { return fn(); } finally { Math.random = real; }
}

// The REAL stat names — `pickupRadius` is what foodReach() reads, and a stub
// that invents a field gets `undefined`, which turns the magnet off and
// measures a game with no magnet in it. (Same trap chum-latch-test names.)
function makePlayer(x, y, reach = 6) {
  const mesh = new THREE.Object3D();
  mesh.position.set(x, y, 0);
  return {
    mesh,
    velocity: new THREE.Vector3(0, 0, 0),
    stats: { pickupRadius: reach, chumGulpRadius: 0, maxOxygen: 100, maxHp: 100 },
    oxygen: 50,
    hp: 100,
    chumSealed: false,
  };
}

function orbAt(x, y) {
  const mesh = new THREE.Object3D();
  mesh.position.set(x, y, 0);
  const p = { mesh, value: 1, healMul: 1, vx: 0, vy: 0 };
  pickups.push(p);
  return p;
}

/** Run the seal's magnet until the orb is collected. Returns the flight. */
function flyIn(player, orb, limit = 6) {
  const path = [];
  let took = 0;
  let t = 0;
  for (; t < limit; t += DT) {
    path.push(orb.mesh.position.clone());
    updatePickups(DT, scene, player, () => { took++; });
    if (took) break;
  }
  return { seconds: t, took, path };
}

// How far the flight strayed from the straight line between where it started
// and where it ended — the curl, measured rather than described.
function maxSwing(path, to) {
  if (path.length < 2) return 0;
  const from = path[0];
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1e-6;
  let worst = 0;
  for (const p of path) {
    const off = Math.abs((p.x - from.x) * dy - (p.y - from.y) * dx) / len;
    if (off > worst) worst = off;
  }
  return worst;
}

// ===========================================================================
section('THE CURL — it swings, and it still arrives');

const curled = withSeed(3, () => {
  resetPickups(scene);
  const player = makePlayer(0, 0);
  const orb = orbAt(5.5, 0);
  const flight = flyIn(player, orb);
  return { ...flight, swing: maxSwing(flight.path, player.mesh.position) };
});

const straight = withSeed(3, () => {
  const was = CONFIG.pickups.pull.enabled;
  CONFIG.pickups.pull.enabled = false;
  try {
    resetPickups(scene);
    const player = makePlayer(0, 0);
    const orb = orbAt(5.5, 0);
    const flight = flyIn(player, orb);
    return { ...flight, swing: maxSwing(flight.path, player.mesh.position) };
  } finally { CONFIG.pickups.pull.enabled = was; }
});

check('the orb leaves the straight line on the way in', curled.swing > 0.2,
  `${curled.swing.toFixed(2)} units off the line, against ${straight.swing.toFixed(2)} with the curl off`);
check('...and the same pull with no curl is a ruler', straight.swing < 0.01,
  `${straight.swing.toFixed(4)} units`);
check('it is still collected', curled.took === 1, `${curled.took} collected`);
// THE ONE THAT MATTERS. A curl written as a force rather than an offset would
// pass everything above and fail here, by however long the orbit lasted.
check('...and in the time the straight pull took',
  Math.abs(curled.seconds - straight.seconds) < 0.05,
  `${curled.seconds.toFixed(2)}s curled vs ${straight.seconds.toFixed(2)}s straight`);

{
  // ...AND IT DOES NOT POP ON. The offset is up to `swirlMax` wide, so applying
  // it at full size on the frame the orb is claimed teleports it a unit and a
  // half sideways — the phase is rolled per orb, so frame one is as likely to
  // land at the top of the sine as at the bottom. It ramps over `curlIn`
  // instead, and this is the number that says so: no single frame of the flight
  // may move the orb further than the pull itself could.
  let worst = 0;
  for (let i = 1; i < curled.path.length; i++) worst = Math.max(worst, curled.path[i].distanceTo(curled.path[i - 1]));
  const ceiling = (CONFIG.pickups.magnet.outrun.min ?? 24) * DT * 2;
  check('the curl swings out rather than snapping out', worst < ceiling,
    `worst frame ${(worst / DT).toFixed(0)} u/s, ceiling ${(ceiling / DT).toFixed(0)} u/s`);
}

{
  // The swing dies as the orb closes, so the swallow lands where the caller's
  // own arithmetic says it does rather than a unit and a half to one side.
  const to = new THREE.Vector3(0, 0, 0);
  const near = curled.path[curled.path.length - 1].distanceTo(to);
  const far = curled.path[0].distanceTo(to);
  check('the swing tapers to nothing at the mouth', near < 1,
    `last frame ${near.toFixed(2)} units out, from ${far.toFixed(2)}`);
}

{
  // LETTING GO IS NOT A POP. An orb the seal turns away from unwinds its swing
  // over a few frames instead of teleporting back onto its old line.
  const jump = withSeed(11, () => {
    resetPickups(scene);
    const player = makePlayer(0, 0);
    const orb = orbAt(5.5, 0);
    for (let i = 0; i < 20; i++) updatePickups(DT, scene, player, () => {});
    // Out of reach, and the latch cleared with it — an abandoned orb, not a
    // claimed one.
    orb.magnetLatch = false;
    player.mesh.position.set(80, 0, 0);
    let worst = 0;
    let prev = orb.mesh.position.clone();
    for (let i = 0; i < 40; i++) {
      updatePickups(DT, scene, player, () => {});
      // Sideways only: the orb is sinking, and the sink is not a pop.
      worst = Math.max(worst, Math.abs(orb.mesh.position.x - prev.x));
      prev = orb.mesh.position.clone();
    }
    return { worst, offset: Math.hypot(orb.pull?.ox ?? 0, orb.pull?.oy ?? 0) };
  });
  check('an abandoned orb unwinds rather than snapping back', jump.worst < 0.2,
    `worst single-frame sideways move ${jump.worst.toFixed(3)} units`);
  check('...and the offset is fully gone afterwards', jump.offset === 0,
    `${jump.offset.toFixed(4)} left on it`);
}

// ===========================================================================
section('THE STREAK — one mover per orb, and it retires with the orb');

withSeed(5, () => {
  resetPickups(scene);
  resetChumPull();
  const player = makePlayer(0, 0);
  const orb = orbAt(5.5, 0);
  updatePickups(DT, scene, player, () => {});
  const first = pullTrailMovers(DT).slice();
  updatePickups(DT, scene, player, () => {});
  const second = pullTrailMovers(DT).slice();
  check('an orb being pulled wants a ribbon', first.length === 1, `${first.length} mover(s)`);
  // A ribbon is keyed on the mover object and keeps its history there. A fresh
  // object per frame is a ribbon that never gets past one point.
  check('...and it is the same mover next frame', first[0] === second[0],
    first[0] === second[0] ? 'identity held' : 'rebuilt — the ribbon would restart every frame');
  check('...pointing at the orb itself', first[0]?.mesh === orb.mesh);

  let took = 0;
  for (let i = 0; i < 360 && !took; i++) updatePickups(DT, scene, player, () => { took++; });
  // Straight after the swallow, not two frames later: the mesh has gone back to
  // the instance pool and the next orb to spawn is handed the same one.
  const after = pullTrailMovers(DT);
  check('the ribbon is dropped the moment the orb is swallowed', took === 1 && after.length === 0,
    `${after.length} mover(s) left after collect`);
});

{
  const max = CONFIG.pickups.pull.maxTrails ?? 48;
  withSeed(9, () => {
    resetPickups(scene);
    resetChumPull();
    const player = makePlayer(0, 0);
    for (let i = 0; i < max + 20; i++) orbAt(4 + (i % 5) * 0.1, -2 + i * 0.05);
    updatePickups(DT, scene, player, () => {});
    const n = pullTrailMovers(DT).length;
    check('the ribbons are capped, and the collecting is not', n <= max,
      `${n} ribbon(s) for ${pickups.length} claimed orbs, cap ${max}`);
  });
}

// ===========================================================================
section('THE KILL ZONE — a chew timer is not permission to disappear');

withSeed(13, () => {
  resetPickups(scene);
  const orb = orbAt(0, 0);
  // A mouth three units away with its kill point INSIDE it, and a suction so
  // gentle it would never get there on its own inside the chew time. This is
  // the crab: `pull` 5.5, and the note in config says it never quite arrives.
  const mouth = { x: 3, y: 0 };
  const kill = { x: 3.4, y: 0, r: 0.3 };
  let gone = false;
  let frames = 0;
  let at = null;
  for (let i = 0; i < 600 && !gone; i++) {
    frames++;
    at = orb.mesh.position.clone();
    // A whole chew's worth of progress on the FIRST frame — the timer is not
    // what this gate answers to.
    gone = bitePickup(scene, orb, i === 0 ? 1 : 0, {
      x: mouth.x, y: mouth.y, z: 0, rate: 0.4, dt: DT, kill,
    });
  }
  check('a finished chew does not delete an orb that is still outside', frames > 1,
    `survived ${frames - 1} frame(s) of being chewed at range`);
  check('...it is dragged the rest of the way in', gone,
    gone ? `swallowed after ${(frames * DT).toFixed(2)}s` : 'never went down — the gate stalled');
  const d = at ? Math.hypot(at.x - kill.x, at.y - kill.y) : Infinity;
  check('...and it goes down inside the kill point, not near it', d <= kill.r + 0.15,
    `${d.toFixed(2)} units from the kill point, radius ${kill.r}`);
});

withSeed(17, () => {
  // ...and with no kill point at all, nothing changed: the chew timer still
  // owns the orb. Every caller that has not been taught the gate keeps working.
  resetPickups(scene);
  const orb = orbAt(0, 0);
  const gone = bitePickup(scene, orb, 1, { x: 9, y: 0, z: 0, rate: 6, dt: DT });
  check('an eater with no kill point still eats on the timer', gone);
});

// ===========================================================================
section('THE WHALE — the orb goes down the throat, and the rest bounces off');

resetEnemies(scene);
enemies.length = 0;

{
  resetWhales(scene);
  resetPickups(scene);
  const w = spawnWhale(scene, mulberry32(3));
  const reach = CONFIG.whale.mouthRadius ?? 0;
  const field = intakeRadius(CONFIG.whale);

  // A pile on the whale's own line, well ahead of it, so the crossing sweeps
  // the lot.
  const pileAt = w.container.position.x + w.dir * 60;
  for (let i = 0; i < 10; i++) orbAt(pileAt + w.dir * i * 2, w.baseY);

  // Where the whale's throat was on the frame it swallowed, not where it is
  // now: the animal is moving at 8 u/s and the orb is gone, so a position
  // compared across even one frame is comparing two different whales.
  const throatNow = () => {
    const ahead = mouthAheadOf(w.noseAhead) - (CONFIG.whale.throatBack ?? 0.9) * reach;
    return new THREE.Vector3(
      w.container.position.x + w.dir * ahead * Math.cos(w.bank),
      w.container.position.y + ahead * Math.sin(w.bank) * w.dir,
      0,
    );
  };

  const last = new Map();
  const swallowedAt = [];
  for (let i = 0; i < 60 * 60 && pickups.length; i++) {
    last.clear();
    for (const p of pickups) last.set(p, p.mesh.position.clone());
    updateWhales(DT, scene, enemies, {});
    const alive = new Set(pickups);
    const throat = throatNow();
    for (const [p, at] of last) if (!alive.has(p)) swallowedAt.push({ at, throat });
  }

  check('the sweep still takes the pile', swallowedAt.length > 0,
    `${swallowedAt.length} orb(s) went down`);

  // THE ASSERTION THIS FILE EXISTS FOR. Every orb was inside the animal's
  // silhouette on the last frame it existed — not merely inside `mouthRadius`,
  // half of which is open water in front of the jaw.
  let outside = 0;
  let worstD = 0;
  for (const { at } of swallowedAt) {
    const d = bodyDistance(w, at.x, at.y);
    if (d > 0.001) { outside++; worstD = Math.max(worstD, d); }
  }
  check('...and every one of them was inside the whale when it went', outside === 0,
    outside ? `${outside}/${swallowedAt.length} popped outside the body, worst ${worstD.toFixed(2)} units clear`
      : `${swallowedAt.length}/${swallowedAt.length} inside the mesh`);

  // ...and specifically inside the throat, which is what the body test above
  // cannot tell apart from "somewhere in the tail".
  const throatR = (CONFIG.whale.throatRadius ?? 0.45) * reach;
  let far = 0;
  let worstT = 0;
  for (const { at, throat } of swallowedAt) {
    const d = at.distanceTo(throat);
    worstT = Math.max(worstT, d);
    // One frame of the whale's own travel is allowed for: the orb's last
    // recorded position is from before the update that ate it.
    if (d > throatR + CONFIG.whale.speed * DT) far++;
  }
  check('...in the throat rather than anywhere in the body', far === 0,
    `worst ${worstT.toFixed(2)} units from the throat, radius ${throatR.toFixed(2)}`);
}

{
  // THE BODY IS SOLID TO CHUM IT IS NOT EATING. An orb parked on the flank,
  // behind the head where nothing is being sucked, ends the frame outside the
  // silhouette rather than inside the ribs.
  resetWhales(scene);
  resetPickups(scene);
  const w = spawnWhale(scene, mulberry32(21));
  // ONE FRAME FIRST. A whale straight out of spawnWhale has not been laid along
  // its heading yet — `container.rotation.z` is 0 and `flip` is unset — so both
  // bodyDistance and bodyPush read the body standing on its tail, and a point
  // probed against it is a point on a whale that is not the one being drawn.
  updateWhales(DT, scene, enemies, {});
  // Behind the mouth by a good margin, so nothing is sucking at it and the only
  // thing that can move it is the collision.
  //
  // PROBED RATHER THAN ASSUMED. The whale's axis does not run through its
  // container origin — the barrel sits about seven units off it (see the note
  // above measureBodyProfile) — so "the container's own y" is open water above
  // a bowhead, and a test that assumed otherwise would measure a push that
  // never fired and call it a pass.
  const behind = -w.dir * (w.length * 0.25);
  let inside = null;
  for (let k = -40; k <= 40 && !inside; k++) {
    const y = w.container.position.y + k * 0.25;
    if (bodyDistance(w, w.container.position.x + behind, y) === 0) inside = y;
  }
  const orb = orbAt(w.container.position.x + behind, inside ?? w.container.position.y);
  const insideBefore = inside != null;
  const holdX = w.lineX;
  updateWhales(DT, scene, enemies, {});
  // Freeze the crossing so the measurement is the push, not the whale having
  // swum away from the orb.
  w.lineX = holdX;
  w.container.position.x = holdX + w.nudgeX;
  const after = bodyDistance(w, orb.mesh.position.x, orb.mesh.position.y);
  check('an orb starts inside the body', insideBefore);
  check('...and is pushed out of it rather than swimming through the ribs', after > 0,
    `${after.toFixed(2)} units clear of the silhouette`);
  check('...with some drift left on it, so a pile parts', Math.hypot(orb.vx, orb.vy) > 0,
    `${Math.hypot(orb.vx, orb.vy).toFixed(1)} u/s outward`);

  // And bodyPush answers "not inside" for open water — a push that fires
  // everywhere would shove the whole seabed around.
  const clear = bodyPush(w, w.container.position.x, w.container.position.y + w.length, {});
  check('...and clear water is left alone', clear === false);
}

console.log(failures ? `\n${failures} failure(s).` : '\nAll good.');
process.exit(failures ? 1 : 0);
