#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:jet
//
// The bubble jet, headless. Six things, and most of them are failures that
// render something plausible rather than throwing:
//
//   IT IS STRAIGHT WHEN     The stream is a solid column whose only motion is
//   NOTHING MOVES.          secondary — a consequence of the seal having moved.
//                           This one is the whole design, and it is what the
//                           first version got wrong: a lagging chain carrying a
//                           free-running sine wiggles while the seal stands
//                           still, and a beam that squirms on its own reads as
//                           slack rather than as something that would cut a
//                           hole in you. Exact, not approximate.
//   MOVEMENT IS WHAT        A strafe leans it, a change of course puts a kink
//   BENDS IT.               in it, and it straightens out on its own when you
//                           stop. Asserted from both sides, because a model
//                           that never bends passes the check above perfectly.
//   IT IS A COLUMN,         Full width down the body, rounding off only at the
//   NOT A CONE.             very end. A long taper is what a spray does, and a
//                           sprayed beam reads as weak however bright it is.
//   THE PULSE MOVES THE     The one thing that animates on its own. In the
//   WIDTH, NOT THE SHAPE.   width it reads as energy flowing up a solid bar;
//                           the identical motion applied sideways is the rope
//                           again. Both halves are asserted.
//   DAMAGE FOLLOWS THE      The shortcut is to draw the bent column and resolve
//   BEND.                   against the straight axis. Nobody notices until the
//                           sway is turned up in the F panel and the stream
//                           visibly misses what it kills. Both halves read
//                           jet.path, and this is what holds them together.
//   IT DOES NOT TICK EVERY  A stream touching a body every frame at 60Hz deals
//   FRAME.                  sixty times its listed damage per second. The
//                           per-target cooldown is the whole balance of a
//                           sustained weapon.
//
// Plus the duty cycle, which is what the card actually sells, and the bed's
// one rule: asking a held thing to start again is not starting it again.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';

// The ribbon paints its cross-section profile on a 2D canvas, and beams.js —
// whose glow sprite this shares — paints a radial gradient. dom-stub returns
// null for getContext, so give it just enough to draw into. The pixels are
// never read back; only the geometry around them is measured.
document.createElement = (tag) => ({
  tagName: tag, width: 0, height: 0, style: {},
  getContext: () => ({
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {}, fillRect: () => {}, clearRect: () => {},
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    set fillStyle(_v) {}, get fillStyle() { return '#000'; },
  }),
});

import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import {
  jets, spawnJet, releaseJet, updateJets, resetJets, jetBend,
  updateBubbleJet, resetBubbleJet, setJetStats, bubbleJetState, jetStats,
} from '../path/src/systems/bubbleJet.js';
import { bubbleJetLevelStats } from '../path/src/levelStats.js';
import {
  sear, updateBurnGlow, resetBurnGlow, burnHeat, burnCount, burnClass, releaseBurn,
} from '../path/src/systems/burnGlow.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

const scene = new THREE.Scene();

// A creature the way the game actually shapes one. Enemies have NO x/y of
// their own — position is e.mesh.position — and a stub that invented those
// fields would let a system reading e.x pass here and hit nothing in the water.
function enemy(x, y, hp = 10000) {
  return { hp, invuln: 0, radius: 0.4, mesh: { position: { x, y, z: 0 } } };
}

// Run a jet forward at a fixed step. Returns the damage dealt, so a caller can
// ask about rate rather than about frames.
function run(j, seconds, dt, enemies = []) {
  let dealt = 0;
  const hooks = { onEnemyDamaged: (e, dmg) => { dealt += dmg; } };
  for (let t = 0; t < seconds; t += dt) updateJets(dt, scene, { enemies, hooks });
  return dealt;
}

const pathOf = (j) => Array.from(j.path);

// EVERY JET SEEDS ITS OWN TURBULENCE PHASE FROM Math.random(), so two runs of
// this file describe two different drag profiles along the beam and any
// threshold near the edge flakes. Pinned after spawn rather than by stubbing
// the RNG: the randomness is correct in the game — sixty streams a run should
// not be the same stream — and what a test needs is not "no randomness" but
// "the same draw every time".
function pin(j, seed = 12.5, stir = 3.25) {
  j.seed = seed;
  j.stir = stir;
  return j;
}

// ---------------------------------------------------------------------------
section('1. the spline is finite');
// ---------------------------------------------------------------------------
{
  resetJets(scene);
  const j = spawnJet(scene, { x: 0, y: 0, dirX: 1, dirY: 0, length: 20, spool: 0.2 });
  // ONE frame is the whole test. The seed happens on the first step, and if it
  // laid every node on the muzzle the divide-by-zero is in that same step.
  updateJets(1 / 60, scene, {});
  const p = pathOf(j);
  check('no NaN in the path after one frame', p.every(Number.isFinite),
    `${p.filter((v) => !Number.isFinite(v)).length} of ${p.length} non-finite`);
  const pos = j.core.geometry.attributes.position.array;
  check('no NaN in the vertex buffer', Array.from(pos).every(Number.isFinite));

  // ...and after a hard turn, which is the other way to collapse two nodes onto
  // each other: reversing the heading pulls the whole chain back through itself.
  j.follow = () => ({ x: 0, y: 0, dirX: -1, dirY: 0 });
  run(j, 0.5, 1 / 60);
  check('no NaN after a 180° reversal', pathOf(j).every(Number.isFinite));
  resetJets(scene);
}

// ---------------------------------------------------------------------------
section('2. a still stream is a straight column');
// ---------------------------------------------------------------------------
// THE WHOLE CORRECTION, as one number. The first version of this was a rope —
// a lagging chain carrying a free-running sine — and it wiggled while nothing
// was happening, which is what makes a beam read as slack rather than as
// something that would cut a hole in you. The shape is now read back out of the
// muzzle's own history, so "nothing moved" and "perfectly straight" are the
// same statement and this is exact rather than approximate.
{
  resetJets(scene);
  const LEN = 20;
  const j = spawnJet(scene, { x: 0, y: 0, dirX: 1, dirY: 0, length: LEN, spool: 0.05 });
  run(j, 2, 1 / 60);
  check('a stream on a still emitter is dead straight', jetBend(j) < 1e-5,
    `worst deviation ${jetBend(j).toExponential(2)}`);

  const pos = j.core.geometry.attributes.position.array;
  const halfAt = (i) => Math.hypot(
    pos[i * 6] - pos[i * 6 + 3], pos[i * 6 + 1] - pos[i * 6 + 4]) / 2;

  // ...and it is a COLUMN, not a cone: full width down the body, rounding off
  // only at the very end. A long taper is what a SPRAY does, and a sprayed beam
  // reads as weak however bright it is.
  //
  // MEASURED WITH THE PULSE OFF, which is not tidying up — the first version of
  // this check ran with it on and failed, because a travelling ±12% swell means
  // two points up the column are at different phases and the difference reads
  // as a taper that is not there. The question here is the PROFILE; the pulse
  // is asserted on its own below, and measuring them together can only ever
  // answer about whichever happened to dominate.
  const look = CONFIG.bubbleJet.look;
  const pulseAmount = look.pulseAmount;
  look.pulseAmount = 0;
  run(j, 1 / 60, 1 / 60);
  const mid = halfAt(Math.floor(j.nodes * 0.5));
  const late = halfAt(Math.floor(j.nodes * 0.8));
  check('it is still full width four fifths of the way out', late > mid * 0.95,
    `${late.toFixed(3)} against ${mid.toFixed(3)} at the middle`);
  check('and the very tip is rounded, not pointed',
    halfAt(j.nodes - 1) > mid * 0.35, `tip ${halfAt(j.nodes - 1).toFixed(3)}`);
  look.pulseAmount = pulseAmount;

  // The pulse is the one thing that moves on its own, and it must move the
  // WIDTH and never the position — that distinction is the entire difference
  // between "energy flowing up a bar" and "a rope", and it is the whole reason
  // this file was rewritten.
  const flat = halfAt(Math.floor(j.nodes * 0.5));
  let swung = 0;
  for (let k = 0; k < 40; k++) {
    run(j, 1 / 60, 1 / 60);
    swung = Math.max(swung, Math.abs(halfAt(Math.floor(j.nodes * 0.5)) - flat));
  }
  check('the pulse does not bend it', jetBend(j) < 1e-5,
    'a travelling swell belongs in the width, never in the shape');
  check('...but it does move the width', swung > flat * 0.02 || (pulseAmount ?? 0) === 0,
    `width swings ${(swung / flat * 100).toFixed(1)}% at mid-column`);
  resetJets(scene);
}

// ---------------------------------------------------------------------------
section('3. movement is what bends it');
// ---------------------------------------------------------------------------
{
  const bendUnder = (move, seconds, dt = 1 / 60) => {
    resetJets(scene);
    const at = { x: 0, y: 0 };
    const j = pin(spawnJet(scene, { x: 0, y: 0, dirX: 1, dirY: 0, length: 20, spool: 0.05 }));
    j.follow = () => ({ x: at.x, y: at.y, dirX: 1, dirY: 0 });
    run(j, 1, dt);                                   // settle straight
    let worst = 0;
    for (let t = 0; t < seconds; t += dt) {
      move(at, t);
      updateJets(dt, scene, {});
      worst = Math.max(worst, jetBend(j));
    }
    const out = { worst, jet: j };
    return out;
  };

  // A HARD SIDEWAYS START is the case the whole model exists for: the muzzle
  // changes velocity, so different points up the column were fired under
  // different conditions and the difference IS the S.
  const strafe = bendUnder((at, t) => { at.y = t * 14; }, 0.5);
  check('a strafe bends it', strafe.worst > 0.5, `worst bend ${strafe.worst.toFixed(2)}`);

  // ...AND IT STRAIGHTENS OUT AGAIN ON ITS OWN once the muzzle stops. Two
  // separate claims, and the second is the one that matters.
  //
  // NOT "it reaches zero by time T". It used to be, back when the column read
  // history directly and the only thing to wait for was the buffer flushing
  // over `travel` seconds. With drag the approach is exponential and the
  // slowest node's time constant is a tuning value — so a fixed deadline would
  // be an assertion about `drag` wearing the costume of an assertion about
  // correctness, and it would fail the moment anyone made the beam heavier.
  //
  // What is actually being claimed is that NOTHING IS DRIVING IT ANY MORE: with
  // the muzzle still, every target offset is exactly zero, so the bend must
  // decay monotonically. A model with any self-motion in it — the rope, or
  // turbulence leaking into the POSITION instead of staying on the drag —
  // fails this at any drag setting, which is the whole point.
  // THE HISTORY HAS TO FLUSH FIRST, and getting this wrong is what made the
  // check flake on three frames in three hundred and sixty. For `travel`
  // seconds after the muzzle stops, the buffer still holds the strafe — so the
  // targets are not yet zero and a point that is still catching up to a large
  // one may legitimately move FURTHER from the axis. That is the model working.
  // The claim being made is about what happens once nothing is driving it at
  // all: neither the muzzle nor the history.
  //
  // Before drag existed this was invisible, because the path WAS the target and
  // the peak had already passed by the time the muzzle stopped.
  run(strafe.jet, (CONFIG.bubbleJet.look.travel ?? 0.22) + 0.05, 1 / 60);

  let prev = jetBend(strafe.jet);
  let rose = 0;
  for (let k = 0; k < 360; k++) {
    run(strafe.jet, 1 / 60, 1 / 60);
    const now = jetBend(strafe.jet);
    // A hair of tolerance for float noise at the bottom of the decay, not for
    // motion: 1e-9 on a bend that starts in the units is nothing.
    if (now > prev + 1e-9) rose++;
    prev = now;
  }
  check('and it only ever straightens out once you stop', rose === 0,
    rose ? `the bend grew on ${rose} of 360 still frames` : 'monotonic over 6s');
  check('...all the way back to straight', prev < strafe.worst * 0.01,
    `${prev.toExponential(2)} from a peak of ${strafe.worst.toFixed(2)}`);

  // TURNING BENDS IT TOO. Same mechanism from the other side — the direction
  // the energy was fired in is part of the history.
  resetJets(scene);
  let ang = 0;
  const turner = spawnJet(scene, { x: 0, y: 0, dirX: 1, dirY: 0, length: 20, spool: 0.05 });
  turner.follow = () => ({ x: 0, y: 0, dirX: Math.cos(ang), dirY: Math.sin(ang) });
  run(turner, 1, 1 / 60);
  let turnWorst = 0;
  for (let t = 0; t < 0.4; t += 1 / 60) { ang += 3 * (1 / 60); updateJets(1 / 60, scene, {}); turnWorst = Math.max(turnWorst, jetBend(turner)); }
  check('a turn bends it', turnWorst > 0.5, `worst bend ${turnWorst.toFixed(2)}`);
  resetJets(scene);
}

// ---------------------------------------------------------------------------
section('3b. the turbulence is on the drag, not the position');
// ---------------------------------------------------------------------------
// The one invariant that lets this beam have as much character as it does.
// Drag decides how FAST a point reaches its target and has no say in WHERE the
// target is — so with the seal still, every point settles to exactly zero
// however hard the turbulence is swinging. Jitter the positions instead and the
// beam is the rope again, which is the mistake this whole file documents.
//
// Turned up past anything the panel would ship, because the failure this
// catches is proportional: at the shipped 0.55 a positional leak might sit
// under a loose threshold and look like float noise.
{
  const look = CONFIG.bubbleJet.look;
  const saved = { t: look.dragTurbulence, r: look.turbulenceRate, s: look.turbulenceScale };
  look.dragTurbulence = 0.95;
  look.turbulenceRate = 6;
  look.turbulenceScale = 2.2;

  resetJets(scene);
  const j = spawnJet(scene, { x: 0, y: 0, dirX: 1, dirY: 0, length: 20, spool: 0.05 });
  let worst = 0;
  for (let k = 0; k < 240; k++) { run(j, 1 / 60, 1 / 60); worst = Math.max(worst, jetBend(j)); }
  check('violent turbulence moves a still column not at all', worst < 1e-6,
    `worst deviation ${worst.toExponential(2)} over 4s at turbulence 0.95`);

  // ...but it IS doing something. A knob that changed nothing would pass the
  // check above perfectly, which is the way this section could quietly become
  // decoration: the drags have to actually differ along the length.
  let lo = Infinity; let hi = 0;
  for (let i = 0; i < j.nodes; i++) { lo = Math.min(lo, j.drag[i]); hi = Math.max(hi, j.drag[i]); }
  check('...while the drag genuinely varies along the length', hi > lo * 1.5,
    `${lo.toFixed(2)} to ${hi.toFixed(2)} per second across ${j.nodes} points`);
  // A NEGATIVE DRAG IS NOT LESS DRAG — it is a follower that runs away from its
  // target and diverges inside a second. The floor is the guard.
  check('...and never goes negative', lo > 0, `lowest ${lo.toFixed(3)}`);

  Object.assign(look, { dragTurbulence: saved.t, turbulenceRate: saved.r, turbulenceScale: saved.s });
  resetJets(scene);
}

// ---------------------------------------------------------------------------
section('4. the same at any frame rate');
// ---------------------------------------------------------------------------
// The rope needed a fixed-step accumulator for this, because its spacing
// constraint carried a correction one node per call and so its stiffness was
// the display's. Reading history by TIME needs nothing — but the assertion
// stays, because that is a property of the design and not a fact anyone should
// have to re-derive from it.
{
  const tipAfterStrafe = (dt) => {
    resetJets(scene);
    const at = { x: 0, y: 0 };
    const j = pin(spawnJet(scene, { x: 0, y: 0, dirX: 1, dirY: 0, length: 20, spool: 0.05 }));
    j.follow = () => ({ x: at.x, y: at.y, dirX: 1, dirY: 0 });
    run(j, 1, dt);
    for (let t = 0; t < 0.25; t += dt) { at.y += 14 * dt; updateJets(dt, scene, {}); }
    const n = j.nodes - 1;
    const tip = { x: j.path[n * 2], y: j.path[n * 2 + 1] };
    resetJets(scene);
    return tip;
  };
  const slow = tipAfterStrafe(1 / 30);
  const fast = tipAfterStrafe(1 / 144);
  const gap = Math.hypot(slow.x - fast.x, slow.y - fast.y);
  check('a 30fps strafe and a 144fps strafe land in the same place', gap < 0.5,
    `tips ${gap.toFixed(3)} apart on a 20-unit stream`);
}

// ---------------------------------------------------------------------------
section('4b. the tangents cannot break');
// ---------------------------------------------------------------------------
// The ribbon is two vertices per point, thrown either side of the local normal.
// Every way of getting that normal wrong is silent and none of them looks like
// a maths bug — they look like the beam TEARING:
//
//   a degenerate span   two points land on each other, the difference between
//                       them normalises to nothing, and the old code reached
//                       for the seal's AIM — a hard discontinuity dropped into
//                       the middle of a smooth curve, which renders as a pinch.
//   a flipped normal    at a tight fold the neighbour difference points back
//                       the way it came and one point's pair of vertices crosses
//                       its neighbour's. On an additive material that bowtie is
//                       a bright X burnt into the beam.
//   a zero normal       the smoothing pass averages two opposed normals to
//                       nothing, and the ribbon collapses to a line at exactly
//                       the fold the pass exists to tidy up.
//
// Driven with deliberate abuse rather than with a plausible strafe, because all
// three of these need a degenerate case to appear at all and the shipped tuning
// is chosen not to produce one.
{
  const unit = (j, i) => Math.hypot(j.norm[i * 2], j.norm[i * 2 + 1]);
  const audit = (j, label) => {
    let badLen = 0; let flips = 0; let nan = 0;
    for (let i = 0; i < j.nodes; i++) {
      const L = unit(j, i);
      if (!Number.isFinite(L)) nan++;
      else if (Math.abs(L - 1) > 1e-3) badLen++;
      if (i > 0) {
        const d = j.norm[i * 2] * j.norm[(i - 1) * 2]
          + j.norm[i * 2 + 1] * j.norm[(i - 1) * 2 + 1];
        // A neighbour pointing the OTHER WAY is the bowtie. Anything merely
        // turning fast is fine — a beam is allowed to bend hard.
        if (d < 0) flips++;
      }
    }
    return { badLen, flips, nan, label };
  };

  // 1. VIOLENT REVERSALS. The aim snaps end to end every few frames, which
  //    drags the whole column back through itself.
  resetJets(scene);
  let ang = 0;
  const wild = spawnJet(scene, { x: 0, y: 0, dirX: 1, dirY: 0, length: 20, spool: 0.02 });
  wild.follow = () => ({ x: Math.sin(ang * 7) * 3, y: Math.cos(ang * 5) * 3, dirX: Math.cos(ang), dirY: Math.sin(ang) });
  let worst = { badLen: 0, flips: 0, nan: 0 };
  for (let k = 0; k < 600; k++) {
    ang += (k % 7 === 0) ? Math.PI * 0.9 : 0.4;
    run(wild, 1 / 60, 1 / 60);
    const a = audit(wild);
    worst = { badLen: worst.badLen + a.badLen, flips: worst.flips + a.flips, nan: worst.nan + a.nan };
  }
  check('no NaN normals through 600 frames of reversals', worst.nan === 0, `${worst.nan} non-finite`);
  check('every normal stays unit length', worst.badLen === 0, `${worst.badLen} off-length`);
  check('and none of them flips against its neighbour', worst.flips === 0,
    `${worst.flips} sign flips — each one is a bowtie in the ribbon`);

  // 2. A DEGENERATE COLUMN. Zero length puts every point on top of every other,
  //    so EVERY span is degenerate and the inherit path is the only thing
  //    running. This is the case that used to reach for the aim.
  resetJets(scene);
  const flat = spawnJet(scene, { x: 3, y: -2, dirX: 0, dirY: 1, length: 0, spool: 0.02 });
  run(flat, 0.5, 1 / 60);
  const d = audit(flat);
  check('a zero-length column still has finite unit normals',
    d.nan === 0 && d.badLen === 0 && d.flips === 0,
    `${d.nan} NaN, ${d.badLen} off-length, ${d.flips} flips`);
  check('...and no NaN reaches the vertex buffer',
    Array.from(flat.core.geometry.attributes.position.array).every(Number.isFinite));

  // 3. THE SMOOTHING MUST NOT UNWELD THE MUZZLE. Node 0's normal is what holds
  //    the ribbon on the seal's mouth, so the blur deliberately skips both ends
  //    — and a pass that forgot to would detach the beam by a hair every frame,
  //    which is the kind of thing nobody sees and everybody feels.
  const look = CONFIG.bubbleJet.look;
  const savedSmooth = look.normalSmooth;
  resetJets(scene);
  const held = spawnJet(scene, { x: 0, y: 0, dirX: 1, dirY: 0, length: 20, spool: 0.02 });
  run(held, 0.5, 1 / 60);
  const n0 = [held.norm[0], held.norm[1]];
  look.normalSmooth = 6;
  run(held, 0.5, 1 / 60);
  check('smoothing leaves the muzzle normal alone',
    Math.hypot(held.norm[0] - n0[0], held.norm[1] - n0[1]) < 1e-9,
    'the first normal is what welds the ribbon to the mouth');
  look.normalSmooth = savedSmooth;
  resetJets(scene);
}

// ---------------------------------------------------------------------------
section('5. damage follows the bend');
// ---------------------------------------------------------------------------
// The shortcut is to draw the bent column and resolve the damage against the
// straight axis. Nobody notices until the sway is turned up in the F panel and
// the stream visibly misses what it kills. The mesh and the hit test both read
// jet.path, and this is what holds them together.
{
  resetJets(scene);
  const at = { x: 0, y: 0 };
  const j = spawnJet(scene, {
    x: 0, y: 0, dirX: 1, dirY: 0, length: 20, width: 0.6,
    spool: 0.05, damage: 5, tickEvery: 999,   // one hit per body, so this counts bodies
  });
  j.follow = () => ({ x: at.x, y: at.y, dirX: 1, dirY: 0 });
  run(j, 1, 1 / 60);
  // Bend it by MOVING, which is now the only way it bends at all.
  for (let t = 0; t < 0.3; t += 1 / 60) { at.y += 16 * (1 / 60); updateJets(1 / 60, scene, {}); }

  // The node furthest off the straight axis: on the column, and not on the
  // line the column would be if it had not moved.
  let best = 0; let bestOff = 0;
  for (let i = 1; i < j.nodes; i++) {
    const off = Math.hypot(j.path[i * 2] - j.axis[i * 2], j.path[i * 2 + 1] - j.axis[i * 2 + 1]);
    if (off > bestOff) { bestOff = off; best = i; }
  }
  check('the bend is wide enough for this test to mean anything', bestOff > 0.6,
    `furthest node is ${bestOff.toFixed(2)} off the axis`);

  const onColumn = enemy(j.path[best * 2], j.path[best * 2 + 1]);
  const onAxis = enemy(j.axis[best * 2], j.axis[best * 2 + 1]);
  // The muzzle is still moving in these two runs, so the column keeps bending —
  // freeze it, or the body measured against this frame's path is being cut by
  // the next frame's.
  j.follow = null;

  const dealtColumn = run(j, 0.05, 1 / 60, [onColumn]);
  check('a body on the column is cut', dealtColumn > 0, `${dealtColumn} damage`);

  const clears = bestOff > (0.6 * 0.5 + onAxis.radius) * 1.5;
  const dealtAxis = run(j, 0.05, 1 / 60, [onAxis]);
  check('a body on the straight axis, where the column is not, is missed',
    !clears || dealtAxis === 0, clears ? `${dealtAxis} damage` : '(bend too small to assert)');
  resetJets(scene);
}

// ---------------------------------------------------------------------------
section('6. it does not tick every frame');
// ---------------------------------------------------------------------------
{
  resetJets(scene);
  const TICK = 0.1;
  const j = spawnJet(scene, {
    x: 0, y: 0, dirX: 1, dirY: 0, length: 20, width: 3,
    spool: 0.01, damage: 1, tickEvery: TICK,
  });
  run(j, 0.2, 1 / 60);                       // let it arm
  const e = enemy(5, 0);
  const SECONDS = 2;
  const dealt = run(j, SECONDS, 1 / 60, [e]);
  const expected = SECONDS / TICK;
  check('hits land at the cooldown, not the frame rate',
    Math.abs(dealt - expected) <= 2, `${dealt} hits in ${SECONDS}s, expected about ${expected}`);
  check('...which is nowhere near per-frame', dealt < SECONDS * 60 * 0.2,
    `per-frame would be ${SECONDS * 60}`);

  // NOTHING IS CUT DURING THE SPOOL. The one thing a telegraphed weapon must
  // not do is hurt before it is visible.
  resetJets(scene);
  const slow = spawnJet(scene, {
    x: 0, y: 0, dirX: 1, dirY: 0, length: 20, width: 3,
    spool: 1, damage: 1, tickEvery: 0.05,
  });
  const early = run(slow, 0.5, 1 / 60, [enemy(5, 0)]);   // half way up
  check('nothing is cut before the stream is armed', early === 0, `${early} damage during the spool`);
  resetJets(scene);
}

// ---------------------------------------------------------------------------
section('6b. the body lights up while it burns');
// ---------------------------------------------------------------------------
// Damage over time needs a STATE, not a series of events. `jetCut` fires ten
// times a second per body and ten flashes a second is a strobe the player stops
// seeing inside a second — so the read is a level that climbs while contact is
// held and falls off when it stops. systems/burnGlow.js.
{
  // A body with real materials on it, because the whole feature is a material
  // write and a stub with no `material` would let every one of these pass
  // against nothing. Two meshes on ONE shared material, which is how
  // createVisual hands out clones — if attachDamageGlow failed to instance,
  // searing one body would light every body wearing that asset.
  const shared = new THREE.MeshStandardMaterial({ emissive: 0x000000, emissiveIntensity: 0 });
  const bodyWith = (assetKey, isBoss = false) => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shared));
    root.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shared));
    scene.add(root);
    return {
      hp: 1e6, invuln: 0, radius: 0.4, assetKey, isBoss,
      mesh: root, visual: root,
    };
  };

  resetBurnGlow();
  const shark = bodyWith('enemyGreatWhite');
  check('nothing is burning to start with', burnCount() === 0);

  // IT CLIMBS. Not "it is on" — a single tick must not pin it, because the
  // climb IS the telegraph and a level that saturates on contact is a switch.
  sear(shark);
  const after1 = burnHeat(shark);
  sear(shark);
  sear(shark);
  const after3 = burnHeat(shark);
  check('one tick does not pin it', after1 > 0 && after1 < 0.5,
    `${after1.toFixed(2)} after one tick`);
  check('...and it climbs with sustained contact', after3 > after1 * 2,
    `${after1.toFixed(2)} -> ${after3.toFixed(2)} over three ticks`);

  // IT REACHES THE MATERIAL. The arithmetic is damageGlow's and is already
  // covered there; what is new here is the join — a heat nobody writes to a
  // body is a number in a Map.
  updateBurnGlow(1 / 60);
  const lit = [];
  shark.mesh.traverse((o) => { if (o.isMesh) lit.push(o.material); });
  check('the heat reaches the body\u2019s material',
    lit.every((m) => m.emissiveIntensity > 0),
    lit.map((m) => m.emissiveIntensity.toFixed(2)).join(', '));
  // PER INSTANCE. The two meshes were handed ONE material; if the clone did not
  // happen, this write went to the shared template and every body in the game
  // wearing it just lit up.
  check('...without lighting the shared template', shared.emissiveIntensity === 0,
    `template at ${shared.emissiveIntensity}`);

  // IT FALLS OFF. Cooled every frame rather than only when stoked — a level
  // that moved only on a hit would snap to cold the instant the beam left,
  // which reads as a switch rather than as something cooling.
  const hot = burnHeat(shark);
  for (let k = 0; k < 12; k++) updateBurnGlow(1 / 60);
  const cooler = burnHeat(shark);
  check('it cools when the beam leaves', cooler < hot && cooler > 0,
    `${hot.toFixed(3)} -> ${cooler.toFixed(3)} over 12 frames`);
  for (let k = 0; k < 120; k++) updateBurnGlow(1 / 60);
  check('...all the way to cold, and lets the body go',
    burnHeat(shark) === 0 && burnCount() === 0);
  check('...leaving the material where it started',
    lit.every((m) => m.emissiveIntensity === 0),
    lit.map((m) => m.emissiveIntensity.toFixed(3)).join(', '));

  // A BOSS CLIMBS SLOWLY. Heat saturates at 1, so a boss on the sardine's
  // envelope is pinned at full white two ticks into a thirty-second fight and
  // then says nothing for the rest of it — the same failure the feature exists
  // to fix, through a different door.
  resetBurnGlow();
  const ordinary = bodyWith('enemyGreatWhite', false);
  const boss = bodyWith('enemyMegalodon', true);
  for (let k = 0; k < 4; k++) { sear(ordinary); sear(boss); }
  check('a boss heats up slower than an ordinary body',
    burnHeat(boss) < burnHeat(ordinary) * 0.6,
    `boss ${burnHeat(boss).toFixed(2)} against ${burnHeat(ordinary).toFixed(2)} after four ticks`);
  check('...but still gets there under sustained fire', (() => {
    for (let k = 0; k < 40; k++) sear(boss);
    return burnHeat(boss) > 0.9;
  })(), `${burnHeat(boss).toFixed(2)} after forty`);

  // WHAT IT IS MADE OF DECIDES WHAT IT DOES, on the axis the game already uses
  // for the impact sound. A second taxonomy could disagree with the one the
  // player is hearing.
  check('a boat is hull', burnClass({ assetKey: 'bossBoat' }) === 'hull');
  check('a yacht is hull', burnClass({ assetKey: 'bossYacht' }) === 'hull');
  check('an ordinary creature with no row is flesh',
    burnClass({ assetKey: 'enemyGreatWhite' }) === 'flesh',
    'voiceClass lists only bosses, so this fallback is most of the roster');
  check('steel burns brighter than flesh',
    (CONFIG.damageGlow.sources.burnHull.peak ?? 0) > (CONFIG.damageGlow.sources.burnFlesh.peak ?? 0),
    `hull ${CONFIG.damageGlow.sources.burnHull.peak} against flesh ${CONFIG.damageGlow.sources.burnFlesh.peak}`);

  // THE HANDOFF TO THE KILL LIGHT. systems/bossLight.js attaches to the same
  // root and gets the SAME per-instance materials back, so a burn still writing
  // on the frame after death is two systems fighting over one material with
  // last-write-wins deciding — a flicker on the first frame of every boss
  // death, which is the most looked-at frame in the game.
  resetBurnGlow();
  const dying = bodyWith('enemyMegalodon', true);
  for (let k = 0; k < 40; k++) sear(dying);
  updateBurnGlow(1 / 60);
  check('a hot body is burning', burnCount() === 1);
  dying.hp = 0;
  releaseBurn(dying);
  check('death lets go of the body immediately', burnCount() === 0,
    'the kill light takes the same materials over on that frame');
  const dead = [];
  dying.mesh.traverse((o) => { if (o.isMesh) dead.push(o.material); });
  check('...and hands them back cold', dead.every((m) => m.emissiveIntensity === 0));

  // A DEAD BODY MUST NOT BE SEARED at all — a tick landing on the frame
  // something dies would otherwise attach a handle to a corpse the kill light
  // is about to own.
  check('a dead body cannot be seared', sear(dying) === false && burnCount() === 0);

  resetBurnGlow();
  scene.clear();
}

// ---------------------------------------------------------------------------
section('7. the duty cycle');
// ---------------------------------------------------------------------------
{
  resetBubbleJet(scene);
  const stats = { bubbleJetLevel: 1, abilityDamageMul: 1 };
  setJetStats(stats);
  const s1 = jetStats(1);

  // Open, held, vented, cold — measured as EDGES rather than as frames in a
  // window, because a frame count is a description of the sample rate and an
  // edge is a description of the weapon.
  let opens = 0;
  let wasOpen = false;
  const aim = { x: 1, y: 0 };
  const pos = { x: 0, y: 0 };
  const dt = 1 / 60;
  const WINDOW = 20;
  let openFrames = 0;
  for (let t = 0; t < WINDOW; t += dt) {
    updateBubbleJet(dt, scene, pos, 1, aim, null);
    updateJets(dt, scene, {});
    const open = bubbleJetState().open;
    if (open && !wasOpen) opens++;
    if (open) openFrames++;
    wasOpen = open;
  }
  const cycle = s1.hold + s1.cool;
  check('it cycles rather than burning forever',
    opens >= Math.floor(WINDOW / cycle) - 1 && opens <= Math.ceil(WINDOW / cycle) + 1,
    `${opens} streams in ${WINDOW}s, one every ${cycle.toFixed(2)}s`);
  const duty = openFrames * dt / WINDOW;
  check('and it is off for a real share of the time', duty > 0.15 && duty < 0.75,
    `open ${(duty * 100).toFixed(0)}% of the time at one stack`);

  // LEVELLING BUYS UPTIME, which is what the card sells and the one thing a
  // damage-per-level number cannot show. Asserted as a RATIO rather than as
  // "more", because a floor that multiplies into a stated multiplier is
  // unbounded and invisible — see the cool's clamp.
  const s6 = bubbleJetLevelStats(6, {});
  const duty1 = s1.hold / (s1.hold + s1.cool);
  const duty6 = s6.jetHold / (s6.jetHold + s6.jetCool);
  check('uptime climbs with stacks', duty6 > duty1 * 1.4,
    `${(duty1 * 100).toFixed(0)}% at one stack, ${(duty6 * 100).toFixed(0)}% at six`);
  // ...and never reaches a permanent stream, which would be a damage aura with
  // a shape. The floor under `cool` is what stops it, and a floor removed by a
  // tuning file is exactly the kind of change nothing else here would catch.
  check('and never becomes permanent', duty6 < 0.95 && s6.jetCool > 0,
    `cool floors at ${s6.jetCool.toFixed(2)}s`);

  // The card being lost has to put the stream out. A level that goes to zero
  // with a stream open would leave it burning for the rest of the run.
  updateBubbleJet(dt, scene, pos, 0, aim, null);
  updateJets(dt, scene, {});
  check('level 0 closes an open stream', !bubbleJetState().open);
  resetBubbleJet(scene);
  check('a reset leaves nothing burning', jets.length === 0, `${jets.length} alive`);
}

// ---------------------------------------------------------------------------
section('8. the bed');
// ---------------------------------------------------------------------------
{
  // NO AUDIO CONTEXT HERE, and that is the assertion. isAudioLive() is false in
  // Node, so every one of these returns false — the point is that they return
  // rather than throwing, because a jet fired before the player's first gesture
  // is the normal case and it must still cut things.
  const { startJetBed, releaseJetBed, jetBedCount, jetBedPlaying } = await import('../path/src/systems/jetBed.js');
  const key = {};
  let threw = null;
  try {
    startJetBed(key);
    releaseJetBed(key);
  } catch (err) { threw = err; }
  check('opening a bed with no audio context is silent, not fatal', !threw,
    threw ? String(threw.message) : '');
  check('...and nothing is left sounding', jetBedCount() === 0 && !jetBedPlaying(key));

  // The one rule the caller depends on: the stream asks for its bed every frame
  // it burns, so re-starting an open one must be a no-op. If it restarted, a
  // held stream would be sixty attacks a second and no hold at all. Asserted
  // against the voice map rather than the graph, so it holds without audio.
  resetJets(scene);
  const j = spawnJet(scene, { x: 0, y: 0, dirX: 1, dirY: 0, length: 10, spool: 0.05 });
  const before = jetBedCount();
  run(j, 0.5, 1 / 60);
  check('a burning stream does not re-trigger its bed', jetBedCount() === before,
    `${jetBedCount()} against ${before}`);
  releaseJet(j);
  run(j, 0.5, 1 / 60);
  check('and letting go leaves none', jetBedCount() === 0);
  resetJets(scene);
}

// ---------------------------------------------------------------------------
section('9. the wiring');
// ---------------------------------------------------------------------------
{
  // Every one of these is a silent failure: a missing feedback entry warns once
  // and does nothing, and an emitter name emit() does not know simply returns.
  check('jetSpool is a configured event', !!CONFIG.feedback?.jetSpool);
  check('jetCut is a configured event', !!CONFIG.feedback?.jetCut);
  check('jetCut has a gap between its sounds',
    (CONFIG.feedback?.jetCut?.sfxMinGap ?? 0) > 0,
    'a stream across a shoal lands a dozen in one frame');
  const em = CONFIG.bubbleJet?.look?.bubbleEmitter;
  check('the bubble emitter exists', !!CONFIG.emitters?.[em], `look.bubbleEmitter = ${em}`);
  check('the level curve is registered for the tip', !!bubbleJetLevelStats(1, {}).jetHold);
}

console.log(`\n${failures ? `FAIL — ${failures} problem(s)` : 'all good'}\n`);
process.exit(failures ? 1 : 0);
