#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:goosuck
//
// THE BLAST GOO COMING HOME — systems/gooSuck.js. Three acts (burst, hold,
// suck) through a blend of the three strange attractors, drawn through DRIVEN
// particle slots (entities/particles.js). Every claim here is about motion or
// about buffer ownership, neither of which a screenshot can answer.
//
//   RESERVE    the ring stops short of the driven slots — a burst big enough
//              to wrap the ring several times over never touches one. This is
//              the one that would fail silently: a stolen slot is a blob that
//              teleports into somebody's kill spray, once, and never throws.
//   WALL       the burst hits its drag and stops before the pull begins.
//   HOME       every blob reaches the seal, well inside its melt clock, and
//              the distance closes rather than orbits (a turn-limited chase
//              can circle forever — see the memory on turn-limited chases).
//   CYCLE      the formula weights sum to 1 everywhere, each shape owns its
//              stretch of the cycle, and the changeovers genuinely blend.
//   FALLBACK   with the feature off, the event's goo still fires ballistic.
//   RESET      a reset returns every slot.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import {
  initParticles, emit, resetParticles, drivenCapacity, particleCount,
} from '../path/src/entities/particles.js';
import {
  spawnSuckGoo, updateGooSuck, setGooSuckTarget, resetGooSuck, gooSuckBlobs, suckWeights, SUCK_SHAPES,
  flockBalance, gooSuckOverride,
} from '../path/src/systems/gooSuck.js';
import { gooGroupInfo } from '../path/src/entities/particles.js';
import { feedback } from '../path/src/systems/feedback.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
const section = (s) => console.log(`\n${s}`);
const dt = 1 / 60;

const scene = new THREE.Scene();
initParticles(scene);
// The buffer the shader reads, so the reserve can be checked from the outside.
const points = scene.children.find((o) => o.isPoints);
const aStart = points.geometry.attributes.aStart.array;
const c = CONFIG.fx.gooSuck;
c.enabled = true;

const meanDist = (tx, ty) => {
  const bs = gooSuckBlobs();
  if (!bs.length) return 0;
  return bs.reduce((a, b) => a + Math.hypot(b.x - tx, b.y - ty), 0) / bs.length;
};
const meanSpeed = () => {
  const bs = gooSuckBlobs();
  return bs.length ? bs.reduce((a, b) => a + Math.hypot(b.vx, b.vy), 0) / bs.length : 0;
};
const step = (n) => { for (let i = 0; i < n; i++) updateGooSuck(dt); };

// SEEDED, BECAUSE EVERY BLOB LEAVES ON A RANDOM VECTOR.
//
// Nothing here touched Math.random, so the goo drew a different burst every run
// and two checks read the dice rather than the code: the orbit comparison
// landed at 3.9x its own 4x bar about half the time, and the same run that
// failed passed on a re-run with a wildly different magnitude. A differential
// measurement is only differential if both sides see the same draws.
//
// Restored at the end, so a suite importing this file is not left with a
// deterministic Math.random.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const liveRandom = Math.random;
Math.random = seeded(0x600D);

section('RESERVE — the ring cannot reach a driven slot');
{
  const cap = drivenCapacity();
  check('the reserve exists and comes out of the buffer', cap.total === CONFIG.fx.drivenParticles && cap.ring + cap.total === CONFIG.fx.maxParticles,
    `${cap.total} driven above a ring of ${cap.ring}`);
  setGooSuckTarget(0, 0);
  const ok = spawnSuckGoo('pickupGoo', 10, 0, { color: 0x44aaff, scale: 2 });
  check('a suck burst claims slots', ok && gooSuckBlobs().length > 0, `${gooSuckBlobs().length} blobs`);
  updateGooSuck(dt);
  const slots = gooSuckBlobs().map((b) => b.slot);
  const before = slots.map((s) => aStart[s]);
  check('...all of them above the ring', slots.every((s) => s >= cap.ring));
  // Wrap the ring several times over. Emit until the count stops climbing —
  // the ring is full — then as much again, so the write head has been round
  // more than once. Density scaling makes a burst's count a tuning value, so
  // the loop measures rather than assumes.
  let bursts = 0; let last = -1;
  while (particleCount() > last && bursts < 2000) { last = particleCount(); emit('bigExplosion', 0, -10, { scale: 6 }); bursts++; }
  for (let i = 0; i < bursts; i++) emit('bigExplosion', 0, -10, { scale: 6 });
  const after = slots.map((s) => aStart[s]);
  check('a ring wrapped more than twice touched none of them', before.every((v, i) => v === after[i]),
    `${bursts * 2} bursts`);
  check('the ring itself filled', particleCount() >= cap.ring, `${particleCount()} alive of a ${cap.ring} ring`);
}

section('WALL — the burst stops before the pull begins');
{
  resetGooSuck();
  setGooSuckTarget(0, 0);
  spawnSuckGoo('pickupGoo', 10, 0, { color: 0x44aaff, scale: 2 });
  const v0 = meanSpeed();
  step(Math.round(c.holdAt / dt) - 1);
  const v1 = meanSpeed();
  // PREDICTED FROM THE WALL, not from a remembered fraction. `v1 < v0 * 0.15`
  // was true of burstDrag 32 over a 0.4s hold and is not a fact about the code:
  // both have since been tuned — the wall to 8 and the hold to 0.2 — so a
  // quarter of the drag gets half the time and the burst keeps 29% instead of
  // 15%. The check went red for a retune it had no business having an opinion
  // about.
  //
  // What does not move is that the hold is a WALL: whatever `burstDrag` is, the
  // speed left when the pull begins is what that drag leaves after that many
  // frames. Asserted against the system's own per-frame decay, so it follows a
  // retune in either direction and still fails if the wall stops being applied.
  const holdFrames = Math.round(c.holdAt / dt) - 1;
  const predicted = Math.pow(1 / (1 + c.burstDrag * dt), holdFrames);
  const ratio = v0 > 0 ? v1 / v0 : 1;
  check('speed collapses across the hold, by as much as the wall can take',
    ratio < predicted * 1.35 && ratio < 0.6,
    `${v0.toFixed(1)} -> ${v1.toFixed(2)} u/s — kept ${(ratio * 100).toFixed(0)}%, `
    + `drag ${c.burstDrag} over ${holdFrames} frames predicts ${(predicted * 100).toFixed(0)}%`);
  const d = meanDist(0, 0);
  check('...and the blobs are still out where they burst', d > 8 && d < 14, `${d.toFixed(2)} from the seal`);
}

section('HOME — every blob reaches the seal');
{
  const d0 = meanDist(0, 0);
  step(60);
  const d1 = meanDist(0, 0);
  check('a second into the pull the goo is closer', d1 < d0 * 0.8, `${d0.toFixed(2)} -> ${d1.toFixed(2)}`);
  const n1 = gooSuckBlobs().length;
  let frames = 0;
  while (gooSuckBlobs().length && frames < 60 * c.life) { updateGooSuck(dt); frames++; }
  check('all swallowed before the melt clock', gooSuckBlobs().length === 0 && frames < 60 * c.life * 0.8,
    `${n1} blobs home in ${(frames * dt).toFixed(2)}s of a ${c.life}s life`);
  check('...and their slots came back', drivenCapacity().free === drivenCapacity().total);
}

section('HOME, MOVING — the target walks away and the goo still lands');
{
  let x = 0;
  spawnSuckGoo('pickupGoo', -6, 3, { color: 0xff8844, scale: 2 });
  let frames = 0;
  while (gooSuckBlobs().length && frames < 60 * c.life) {
    x += 4 * dt; // a cruising seal
    setGooSuckTarget(x, 0);
    updateGooSuck(dt);
    frames++;
  }
  check('a cruising seal is caught', gooSuckBlobs().length === 0, `${(frames * dt).toFixed(2)}s`);
  const finite = gooSuckBlobs().every((b) => Number.isFinite(b.x) && Number.isFinite(b.y));
  check('nothing went non-finite', finite);
}

section('CYCLE — the formulas blend and take turns');
{
  const w = {};
  let sumOk = true; let peaks = 0; let overlaps = 0;
  const cfg = { ...c, blend: 0.3, shapes: { thomas: true, lorenz: true, aizawa: true } };
  for (let i = 0; i < 300; i++) {
    suckWeights(i / 300, cfg, w);
    const sum = SUCK_SHAPES.reduce((a, s) => a + w[s], 0);
    if (Math.abs(sum - 1) > 1e-6) sumOk = false;
    if (SUCK_SHAPES.filter((s) => w[s] > 0.2).length >= 2) overlaps++;
  }
  check('weights sum to 1 everywhere in the cycle', sumOk);
  check('the changeovers blend two formulas', overlaps > 30, `${overlaps}/300 samples mixed`);
  SUCK_SHAPES.forEach((s, i) => {
    suckWeights((i + 0.5) / 3, cfg, w);
    if (w[s] > 0.6) peaks++;
  });
  check('each formula leads the middle of its stretch', peaks === 3);
  const hard = { ...cfg, blend: 0.17 };
  suckWeights(0.4, hard, w);
  check('a blend at the floor is hard cuts', SUCK_SHAPES.filter((s) => w[s] > 0).length === 1 && w.lorenz === 1);
  suckWeights(1 / 3, hard, w);
  check('...and the seam between two cuts still has one formula live', Math.abs(SUCK_SHAPES.reduce((a, s) => a + w[s], 0) - 1) < 1e-6);
  suckWeights(0.1, { ...cfg, shapes: { thomas: false, lorenz: true, aizawa: true } }, w);
  check('a switched-off formula gets no weight', w.thomas === 0 && Math.abs(w.lorenz + w.aizawa - 1) < 1e-6);
  suckWeights(0.1, { ...cfg, shapes: { thomas: false, lorenz: false, aizawa: false } }, w);
  check('all off is a bare pull, not a crash', SUCK_SHAPES.every((s) => w[s] === 0));
}

section('SWIRL — it spirals, it breathes, it clenches');
{
  resetGooSuck();
  setGooSuckTarget(0, 0);
  spawnSuckGoo('pickupGoo', 9, 0, { color: 0x44aaff, scale: 2 });
  const bs = gooSuckBlobs();
  check('the blobs splat into their own goo group', bs.every((b) => b.groupName === c.group),
    `group '${bs[0]?.groupName}'`);
  check('...and it exists as a surface', !!gooGroupInfo(c.group));
  step(Math.round(c.holdAt / dt) + 2);
  // THE ORBIT, measured differentially: the same suck with the attractor swirl
  // silenced, once with the orbit off and once on. Per-blob angular travel
  // around the seal, signed by the blast's own spin, so the claim is "the
  // orbit term turns the mass its own way round" and not a bet on where the
  // attractor happened to push this run.
  const travel = (orbit) => {
    const saved = { orbit: c.orbit, swirl: c.swirl, wobble: c.wobble };
    Object.assign(c, { orbit, swirl: 0, wobble: 0 });
    resetGooSuck();
    setGooSuckTarget(0, 0);
    spawnSuckGoo('pickupGoo', 9, 0, { color: 0x44aaff, scale: 2 });
    // MEASURED WHILE THEY ARE STILL FLYING. This used to step past holdAt AND
    // the whole ramp before it started watching, by which point the suck has
    // absorbed nearly every blob — the loop below then ran against 0 or 1
    // survivors depending on the run. Zero on both sides reads as "0.00 with
    // the orbit vs 0.00 without" and fails; one survivor reads as 162°/frame
    // off a single sample and passes. Neither is a measurement of the orbit.
    //
    // Past the hold only, so the thirty frames below land inside the ramp with
    // the mass in flight, which is the only stretch where an orbit term has
    // anything to turn.
    step(Math.round(c.holdAt / dt) + 1);
    let sum = 0; let n = 0;
    for (let i = 0; i < 30 && gooSuckBlobs().length; i++) {
      const before = gooSuckBlobs().map((b) => [b, Math.atan2(b.y, b.x)]);
      updateGooSuck(dt);
      for (const [b, a0] of before) {
        if (!gooSuckBlobs().includes(b)) continue;
        let d = Math.atan2(b.y, b.x) - a0;
        if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
        sum += d * b.spin; n++;
      }
    }
    Object.assign(c, saved);
    return n ? sum / n : 0;
  };
  const off = travel(0);
  const on = travel(30);
  check('the orbit turns the mass its own way round', on > 0.01 && on > Math.abs(off) * 4,
    `${(on * 180 / Math.PI).toFixed(2)}°/frame with the orbit vs ${(off * 180 / Math.PI).toFixed(2)}° without`);
  resetGooSuck();
  setGooSuckTarget(0, 0);
  spawnSuckGoo('pickupGoo', 9, 0, { color: 0x44aaff, scale: 2 });
  step(Math.round((c.holdAt + c.rampTime * 0.6) / dt));
  const rest = CONFIG.fx.goo.groups[c.group].iso;
  const live = gooGroupInfo(c.group).def.iso;
  check('the isoline is WIDER while sucking', gooSuckOverride() === c.group && live < rest,
    `${live.toFixed(3)} live vs ${rest} at rest (isoSuck ${c.isoSuck})`);
  check('...without the tuned value being touched', CONFIG.fx.goo.groups[c.group].iso === rest);
  let frames = 0;
  while (gooSuckBlobs().length && frames < 60 * c.life) { updateGooSuck(dt); frames++; }
  check('the stronger pull still lands every blob', gooSuckBlobs().length === 0, `${(frames * dt).toFixed(2)}s`);
  check('...and the isoline is handed back', gooSuckOverride() === null && gooGroupInfo(c.group).def.iso === rest);
  // The flock's balance swings: cohesion and repel trade places over a period.
  const period = 1 / c.fluctHz;
  const hi = flockBalance(period * 0.25, 0, c);
  const lo = flockBalance(period * 0.75, 0, c);
  check('cohesion and repel fluctuate against each other', hi > 0.99 && lo < -0.99,
    `${hi.toFixed(2)} at a quarter period, ${lo.toFixed(2)} at three quarters`);
}

section('FALLBACK — the event still leaves goo with the suck off');
{
  resetGooSuck();
  resetParticles(); // the ring is full from the reserve test; an emit into a full ring adds nothing to count
  check('the pickup blast asks for the suck', CONFIG.feedback.pickupBlast?.gooSuck === true);
  const alive0 = particleCount();
  c.enabled = false;
  feedback('pickupBlast', { x: 0, y: -5, color: 0x44aaff });
  check('off, the goo fires ballistic and no blob is driven', particleCount() > alive0 && gooSuckBlobs().length === 0);
  c.enabled = true;
  feedback('pickupBlast', { x: 0, y: -5, color: 0x44aaff });
  check('on, the event drives its goo', gooSuckBlobs().length > 0, `${gooSuckBlobs().length} blobs`);
}

section('RESET — every slot returns');
{
  resetGooSuck();
  resetParticles();
  const cap = drivenCapacity();
  check('a reset returns the whole reserve', cap.free === cap.total && gooSuckBlobs().length === 0);
}

console.log(failures ? `\n${failures} failing` : '\nall passing');
Math.random = liveRandom;
process.exit(failures ? 1 : 0);
