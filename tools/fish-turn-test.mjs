#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:fishturn
//
// THE BARRACUDA AND THE SAILFISH COMING ABOUT, and the shimmy in front of the
// dart. See systems/fishTurn.js for the argument and `comeAbout` on both defs
// in config.js.
//
// EVERY CLAIM HERE IS ABOUT A PATH, not about an end state, which is the whole
// reason the old code was wrong and looked right: the two poses a fish parks
// in were always correct, and the seconds between them were a vertical loop.
// So this drives real creatures through real reversals and reads the composed
// world matrix on every frame.
//
// THE DETECTOR IS TESTED FIRST, against the composition it replaced. "The nose
// passes through the camera" is a claim that a matrix multiply can satisfy by
// accident — a Z component that is positive because the fish happened to be
// pitched, say — so the same measurement is run over the LEGACY pair
// (mesh.rotation.z = heading, visual.rotation.y eased 0 -> PI) and has to FAIL
// there. A check that passes on both builds is measuring nothing.
//
// SEEDED, for the reason spelled out in tools/shark-swim-test.mjs: a creature
// spawns on a random heading, at a speed off `speedVariance`, and with a random
// part of its first cooldown already spent.
//
//   node --import ./tools/vite-loader.mjs tools/fish-turn-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enemies, spawnNamed, updateEnemies, resetEnemies } from '../path/src/entities/enemies.js';

const scene = new THREE.Scene();

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

const dt = 1 / 60;
const MID = -20;

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
function withSeed(seed, fn) {
  const orig = Math.random;
  Math.random = seeded(seed);
  try { return fn(); } finally { Math.random = orig; }
}

// The model's own axes, in the frame createVisual leaves them in. In the side
// view orientationQuaternion sends model FORWARD to entity +Y and model UP to
// entity -X (see assets.js), so these two vectors are what "where is its nose"
// and "which way is its back" mean for every creature in this file.
const FWD = new THREE.Vector3(0, 1, 0);
const DORSAL = new THREE.Vector3(-1, 0, 0);

// Where the nose and the back point in the world, given the two objects the
// orientation is actually spread across. Composed through real matrices rather
// than through arithmetic on the angles, because the whole bug was a wrong
// belief about what those angles compose to.
function axes(mesh, visual) {
  const m = new THREE.Matrix4()
    .makeRotationFromEuler(mesh.rotation)
    .multiply(new THREE.Matrix4().makeRotationFromEuler(visual.rotation));
  return {
    fwd: FWD.clone().applyMatrix4(m),
    dorsal: DORSAL.clone().applyMatrix4(m),
  };
}

// ---------------------------------------------------------------------------
console.log('\nTHE TWO POSES IT PARKS IN ARE THE ONES IT ALWAYS PARKED IN');
// ---------------------------------------------------------------------------
// A different-looking turn is the point; a different-looking FISH is a
// regression. So the finished poses are compared against the legacy
// composition directly, at several pitches and on both sides.
{
  const mesh = new THREE.Object3D();
  const visual = new THREE.Object3D();
  const legacyMesh = new THREE.Object3D();
  const legacyVisual = new THREE.Object3D();
  let worstFwd = 0;
  let worstDorsal = 0;
  for (const pitch of [0, 0.4, -0.7, 1.2, -1.4]) {
    for (const side of ['right', 'left']) {
      mesh.rotation.order = 'YXZ';
      mesh.rotation.set(0, side === 'left' ? -Math.PI : 0, pitch - Math.PI / 2);
      visual.rotation.set(0, 0, 0);
      // What the shared path writes: one in-plane heading, and a roll to put
      // the body back upright.
      const heading = side === 'left' ? Math.PI - pitch : pitch;
      legacyMesh.rotation.set(0, 0, heading - Math.PI / 2);
      legacyVisual.rotation.set(0, side === 'left' ? Math.PI : 0, 0);
      const a = axes(mesh, visual);
      const b = axes(legacyMesh, legacyVisual);
      worstFwd = Math.max(worstFwd, a.fwd.distanceTo(b.fwd));
      worstDorsal = Math.max(worstDorsal, a.dorsal.distanceTo(b.dorsal));
    }
  }
  check('the parked nose is where it was', worstFwd < 1e-4, `worst error ${worstFwd.toExponential(1)} over 10 poses`);
  check('and so is the parked back', worstDorsal < 1e-4, `worst error ${worstDorsal.toExponential(1)}`);
}

// ---------------------------------------------------------------------------
console.log('\nTHE DETECTOR CATCHES THE TURN IT WAS WRITTEN FOR');
// ---------------------------------------------------------------------------
// Sweep a reversal through both compositions and read the nose. The new one
// has to go through the lens; the OLD one has to go over the top, or this
// whole file is measuring a tautology.
{
  const sweep = (build) => {
    let minZ = Infinity;
    let maxZ = -Infinity;
    let maxUp = -Infinity;
    let minDorsalY = Infinity;
    for (let i = 0; i <= 60; i++) {
      const u = i / 60;
      const { mesh, visual } = build(u);
      const a = axes(mesh, visual);
      minZ = Math.min(minZ, a.fwd.z);
      maxZ = Math.max(maxZ, a.fwd.z);
      maxUp = Math.max(maxUp, a.fwd.y);
      minDorsalY = Math.min(minDorsalY, a.dorsal.y);
    }
    return { minZ, maxZ, maxUp, minDorsalY };
  };

  const mesh = new THREE.Object3D();
  const visual = new THREE.Object3D();
  mesh.rotation.order = 'YXZ';
  const now = sweep((u) => {
    mesh.rotation.set(0, -Math.PI * u, -Math.PI / 2);
    visual.rotation.set(0, 0, 0);
    return { mesh, visual };
  });

  const lMesh = new THREE.Object3D();
  const lVisual = new THREE.Object3D();
  const before = sweep((u) => {
    lMesh.rotation.set(0, 0, Math.PI * u - Math.PI / 2);
    lVisual.rotation.set(0, Math.PI * u, 0);
    return { mesh: lMesh, visual: lVisual };
  });

  check('the nose comes round through the camera',
    now.maxZ > 0.95 && now.minZ > -1e-9,
    `nose z peaks at ${now.maxZ.toFixed(3)} and never goes behind (min ${now.minZ.toFixed(3)})`);
  check('and never points at the ceiling',
    now.maxUp < 0.05,
    `nose y peaks at ${now.maxUp.toFixed(3)}`);
  check('the back stays up for every frame of it',
    now.minDorsalY > 0.999,
    `dorsal y bottoms out at ${now.minDorsalY.toFixed(4)}`);
  // The measurement, on the build this replaces. If either of these ever
  // passes, the old path has been changed under this file and the checks above
  // have stopped meaning what they say.
  check('...and the old turn does NOT (this is the detector working)',
    before.maxZ < 0.05,
    `legacy nose z peaks at ${before.maxZ.toFixed(3)}`);
  check('...it went over the top instead',
    before.maxUp > 0.95,
    `legacy nose y peaks at ${before.maxUp.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// A real creature, driven at a player that crosses it, so the reversal is one
// the behaviour asked for rather than one the harness posed.
//
// `playerMove` returns where the seal is this frame. Frames are recorded with
// the composed axes, so every claim below is read off the same matrix the
// renderer would use.
function run(id, seed, { seconds = 14, from = { x: -12, y: MID }, playerMove } = {}) {
  return withSeed(seed, () => {
    resetEnemies(scene);
    const e = spawnNamed(scene, id, 0, from, { ignoreCaps: true });
    if (!e) throw new Error(`could not spawn ${id}`);
    const player = new THREE.Vector3();
    const frames = [];
    const steps = Math.round(seconds / dt);
    for (let i = 0; i < steps; i++) {
      const at = playerMove(i * dt);
      player.set(at.x, at.y, 0);
      updateEnemies(dt, scene, player, () => {}, () => {});
      if (!enemies.includes(e)) break;
      const a = axes(e.mesh, e.visual);
      frames.push({
        t: i * dt,
        vx: e.vx,
        vy: e.vy,
        speed: Math.hypot(e.vx, e.vy),
        stage: e.lungeStage,
        yaw: e.mesh.rotation.y,
        // The shimmy ALONE. `__turnYaw` is the eased come-about the wiggle is
        // added to, so the difference is the shake and nothing else. Reading it
        // off the difference of the written angle was the first attempt and it
        // measured the EASE: an inOutCubic over 0.42s has a second derivative
        // of 213 rad/s^2 through its middle, which is 0.059 rad of frame-to-
        // frame curvature — bigger than the shimmy it was supposed to be
        // finding, and it "detected" one on every turn the barracuda made.
        wiggle: e.mesh.rotation.y - e.__turnYaw,
        bank: e.visual.rotation.y,
        noseZ: a.fwd.z,
        noseY: a.fwd.y,
        dorsalY: a.dorsal.y,
        dist: Math.hypot(player.x - e.mesh.position.x, player.y - e.mesh.position.y),
      });
    }
    return { e, frames };
  });
}

// The seal parked far to one side, then far to the other: the cleanest way to
// make a chaser genuinely come about rather than merely drift across.
const crossing = (period) => (t) => ({ x: Math.floor(t / period) % 2 === 0 ? 26 : -26, y: MID });

console.log('\nA FISH THAT ACTUALLY REVERSES DOES IT THROUGH THE LENS');
for (const id of ['barracuda', 'sailfish']) {
  let turns = 0;
  let deepest = 0;
  let worstDorsal = 1;
  let worstRoll = 0;
  let brokeOut = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    const { frames } = run(id, seed, { seconds: 16, playerMove: crossing(4) });
    // A turn is a contiguous run of frames where the yaw is between the two
    // resting values rather than at one of them. Read off the yaw and not off
    // vx, because vx crosses zero long before the body has finished coming
    // about — which is exactly the gap the old flip fell through.
    let open = null;
    for (let i = 0; i < frames.length; i++) {
      const mid = frames[i].yaw < -1e-3 && frames[i].yaw > -Math.PI + 1e-3;
      if (mid && open == null) open = i;
      if (!mid && open != null) {
        const span = frames.slice(open, i);
        open = null;
        if (span.length < 6) continue; // a frame or two of ease-in is not a turn
        turns++;
        const peak = Math.max(...span.map((f) => f.noseZ));
        deepest = Math.max(deepest, peak);
        if (peak < 0.4) brokeOut++;
        for (const f of span) {
          worstDorsal = Math.min(worstDorsal, f.dorsalY);
          worstRoll = Math.max(worstRoll, Math.abs(f.bank));
        }
      }
    }
  }
  check(`${id}: it turns round, repeatedly`, turns >= 8, `${turns} come-abouts over 5 seeds`);
  check(`${id}: every one of them swings the nose at the camera`,
    turns > 0 && brokeOut === 0,
    `${brokeOut} of ${turns} peaked under 0.4; deepest ${deepest.toFixed(2)}`);
  check(`${id}: it is never once inverted`,
    worstDorsal > 0,
    `dorsal y bottoms out at ${worstDorsal.toFixed(3)} across every frame of every turn`);
  // THE ROLL IS A LEAN NOW, WHICH IS THE OTHER HALF OF THE CHANGE. The old
  // path spent the same rotation on a 180-degree barrel roll about the spine —
  // it HAD to, that roll was the whole mechanism for facing the other way — so
  // a cap on it is a claim that could not have been made before at all. The
  // bound is `bankMax` plus whatever the shimmy is allowed to add on top, and
  // nothing else may write this angle.
  const cfg = CONFIG.fishTurn;
  const own = CONFIG.enemies[id].comeAbout;
  const bound = (own?.bankMax ?? cfg.bankMax) + (own?.wiggleBank ?? cfg.wiggleBank) + 1e-6;
  check(`${id}: the roll is a lean, never a flip`,
    worstRoll <= bound,
    `worst ${worstRoll.toFixed(3)} rad against a ${bound.toFixed(3)} bound (the old flip went to ${Math.PI.toFixed(3)})`);
}

// ---------------------------------------------------------------------------
console.log('\nTHE WIND-UP IS A SHIMMY, AND IT ARRIVES');
// ---------------------------------------------------------------------------
// The tell has to be VISIBLE and it has to be CONFINED. A shake that runs all
// the time is texture, and a shake that switches on at full size is a
// vibration rather than a countdown — so both ends are asserted, and the ramp
// is measured as the second half of the gather against the first.
for (const id of ['barracuda', 'sailfish']) {
  const windup = CONFIG.enemies[id].lunge.windup;
  let early = 0;
  let earlyN = 0;
  let late = 0;
  let lateN = 0;
  let outside = 0;
  let winds = 0;
  for (const seed of [11, 12, 13, 14, 15]) {
    const { frames } = run(id, seed, { seconds: 18, playerMove: () => ({ x: 4, y: MID }) });
    let start = -1;
    for (let i = 0; i < frames.length; i++) {
      const shake = Math.abs(frames[i].wiggle);
      if (frames[i].stage === 'wind') {
        if (start < 0) start = i;
        // How far into the gather this frame is. The clock itself is not on
        // the frame, so it is counted from where the stage opened.
        const into = (i - start) * dt;
        if (into < windup / 2) { early += shake; earlyN++; } else { late += shake; lateN++; }
      } else {
        start = -1;
        outside = Math.max(outside, shake);
      }
    }
    winds += frames.filter((f) => f.stage === 'wind').length;
  }
  check(`${id}: it winds up at all`, winds > 30, `${winds} frames of gather over 5 seeds`);
  const eMean = earlyN ? early / earlyN : 0;
  const lMean = lateN ? late / lateN : 0;
  // A number with a floor under it rather than a bare "> 0": at 0.3 rad of
  // authored swing the mean of |sin| over a ramped second half is around 0.14,
  // and anything an order of magnitude under that is a shimmy nobody can see.
  check(`${id}: the shake is real`, lMean > 0.05, `${lMean.toFixed(3)} rad of swing, mean, late in the gather`);
  check(`${id}: and it arrives rather than switching on`,
    lMean > eMean * 1.6,
    `${eMean.toFixed(3)} early against ${lMean.toFixed(3)} late`);
  check(`${id}: nothing shakes when it is not gathering`,
    outside === 0,
    `worst swing outside the wind-up ${outside.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
console.log('\nTHE BARRACUDA GAINED A MOMENT, NOT A NERF');
// ---------------------------------------------------------------------------
// The sailfish banked its cruise into its burst on purpose. This one must not:
// its whole identity is that you cannot swim away from it, and a tell bought
// with a slower fish would be a different creature wearing the same row.
{
  const B = CONFIG.enemies.barracuda;
  const L = B.lunge;
  check('its bite is its strike', B.contactBite === L.strikeTime,
    `${B.contactBite}s bite against a ${L.strikeTime}s run`);

  // AGAINST A CONTROL RUN, not against the cruise number. Two things make the
  // obvious measurement lie: the arena is 80 units wide, so a fish driven at a
  // seal parked on the far wall spends the back half of the test clamped
  // against it and averages whatever the harness's window happened to include;
  // and `speedVariance` alone is two units wide per spawn. So the same seeds
  // are run twice — once as shipped, once with the `lunge` block removed,
  // which is exactly the creature this replaced — and what is compared is how
  // long each takes to reach the seal.
  const timeToReach = (seed) => {
    const { frames } = run('barracuda', seed, {
      seconds: 20, from: { x: -22, y: MID }, playerMove: () => ({ x: 14, y: MID }),
    });
    const hit = frames.find((f) => f.dist < 4);
    return { t: hit ? hit.t : Infinity, peak: Math.max(...frames.map((f) => f.speed)) };
  };
  const SEEDS = [21, 22, 23, 24, 25, 26];
  const withLunge = SEEDS.map(timeToReach);
  const saved = B.lunge;
  delete B.lunge;
  const control = SEEDS.map(timeToReach);
  B.lunge = saved;

  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const now = mean(withLunge.map((r) => r.t));
  const then = mean(control.map((r) => r.t));
  const peak = Math.max(...withLunge.map((r) => r.peak));
  const controlPeak = Math.max(...control.map((r) => r.peak));

  check('it reaches you as fast as the flat chaser did',
    now < then * 1.15,
    `${now.toFixed(2)}s against the no-lunge control's ${then.toFixed(2)}s`);
  check('and the dart is genuinely faster than the cruise',
    peak > controlPeak * 1.2,
    `peaks at ${peak.toFixed(1)} u/s against the control's ${controlPeak.toFixed(1)}`);
  check('the burst is a small share of its life',
    L.strikeTime / (L.windup + L.strikeTime + L.cooldown) < 0.4,
    `${(100 * L.strikeTime / (L.windup + L.strikeTime + L.cooldown)).toFixed(0)}% of a cycle`);
}

// ---------------------------------------------------------------------------
console.log('\nA PACK GATHERS TOGETHER; TWO OF A SOLITARY ANIMAL DO NOT');
// ---------------------------------------------------------------------------
// `stagger` is the difference, and it is the only thing here that can make
// several bodies read as one decision. Measured as the SPREAD of the first
// wind-up across a group spawned on the same tick.
{
  const firstWinds = (id, seed, n) => withSeed(seed, () => {
    resetEnemies(scene);
    const group = [];
    for (let i = 0; i < n; i++) {
      const e = spawnNamed(scene, id, 0, { x: -6 + i * 0.9, y: MID }, { ignoreCaps: true });
      if (e) group.push(e);
    }
    const player = new THREE.Vector3(2, MID, 0);
    const when = new Map();
    const steps = Math.round(12 / dt);
    for (let i = 0; i < steps; i++) {
      updateEnemies(dt, scene, player, () => {}, () => {});
      for (const e of group) {
        if (e.lungeStage === 'wind' && !when.has(e)) when.set(e, i * dt);
      }
    }
    return [...when.values()];
  });

  const spreadOf = (times) => (times.length < 2 ? null : Math.max(...times) - Math.min(...times));

  const packs = [1, 2, 3, 4, 5].map((s) => spreadOf(firstWinds('barracuda', s, 4))).filter((v) => v != null);
  const pairs = [1, 2, 3, 4, 5].map((s) => spreadOf(firstWinds('sailfish', s, 3))).filter((v) => v != null);
  const packMean = packs.reduce((a, b) => a + b, 0) / packs.length;
  const pairMean = pairs.reduce((a, b) => a + b, 0) / pairs.length;

  const stagger = CONFIG.enemies.barracuda.lunge.stagger;
  check('the barracuda pack winds up close to together',
    packMean < CONFIG.enemies.barracuda.lunge.cooldown,
    `${packMean.toFixed(2)}s between the first and last of four, at stagger ${stagger}`);
  check('the sailfish pair does not',
    pairMean > packMean,
    `${pairMean.toFixed(2)}s across three, at stagger ${CONFIG.enemies.sailfish.lunge.stagger ?? 1}`);
}

console.log(`\n${failures ? `${failures} FAILED` : 'all good'}\n`);
process.exit(failures ? 1 : 0);
