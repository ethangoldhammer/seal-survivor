#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:posebubbles
//
// The bubbles a POSE throws — systems/poseBubbles.js — read out of the
// particle buffer rather than counted at the call site.
//
// WHAT ONLY THIS CAN SEE. Every failure this system has is a counting failure,
// and all of them look like a taste decision from the outside:
//
//   A BURST THAT FIRES TWICE   the phase is walked past a threshold every
//                              frame, so a window test ("is the phase near
//                              0.5") fires for every frame it is near it. That
//                              is how a timer in this project once counted one
//                              event 182 times. It has to be an EDGE.
//   A BURST THAT NEVER FIRES   the second performance of a run starts with the
//                              previous one's phase still in the track, so
//                              every threshold below it is already "passed".
//                              One salute works, the next is silent, and
//                              nothing throws.
//   A RATE THAT IGNORES THE POSE  the stream is supposed to fade up and down
//                              with the pose's weight. A rate that reads 1
//                              instead pours at full strength through a
//                              release that is visibly letting go.
//   AN ANCHOR THAT MISSES      a `from` nobody resolves must emit NOTHING, not
//                              fall back to the middle of the animal. A
//                              silent fallback to the body centre is
//                              indistinguishable from the feature working.
//
// THE RIG IS AN INPUT HERE, not the subject: this file hands the system a
// hand-built set of anchors on purpose, because what is being measured is WHEN
// and HOW MANY, not where a flipper is. Where the anchors themselves come from
// is systems/aimRig.js's business and is measured against the real model in
// npm run test:celebrate and on the pose lab.
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { initParticles, resetParticles, updateParticles } from '../path/src/entities/particles.js';
import {
  playCelebration, updateCelebration, resetCelebration, celebrationState,
} from '../path/src/systems/celebrate.js';
import { updatePoseBubbles, resetPoseBubbles } from '../path/src/systems/poseBubbles.js';
import { updateStrikePose, resetStrikePose, strikePoseState } from '../path/src/systems/strikePose.js';

const scene = new THREE.Scene();
initParticles(scene);
const points = scene.children.find((c) => c.isPoints);
const attrs = points.geometry.attributes;
const CAP = attrs.aStart.count;

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const section = (n) => console.log(`\n${n}`);

// Everything alive in the buffer, as points. Read out of the geometry rather
// than counted from the system's own return value wherever the POSITION
// matters — a count can agree while every bubble is born in the wrong place.
function live() {
  const out = [];
  for (let i = 0; i < CAP; i++) {
    if (attrs.aStart.array[i] < -1e8) continue;
    out.push({ x: attrs.position.array[i * 3], y: attrs.position.array[i * 3 + 1] });
  }
  return out;
}

// Anchors far enough apart that which one a bubble came off is unambiguous.
const RIG = {
  anchors: {
    mouth: { x: 100, y: 0 },
    finL: { x: 200, y: 0 },
    finR: { x: 300, y: 0 },
    tail: { x: 400, y: 0 },
  },
  muzzles: [{ x: 500, y: 0 }, { x: 600, y: 0 }],
};
const CTX = { aboveSurface: false, velocity: { x: 0, y: 0 } };
const DT = 1 / 60;

// The pose under test is a scratch variant, so nothing here depends on the
// shipped numbers and retuning the salute cannot fail this file.
const TEST_POSE = '__test__';
function spec(bubbles) {
  CONFIG.celebrate.poses[TEST_POSE] = { bubbles };
}
function play({ peakAt = 0.5, hold = 0.3, release = 0.2 } = {}) {
  resetCelebration();
  // A variant with no entry in POSES starts nothing (celebrate.js drops
  // unknown names), so the state is driven directly — this file is testing the
  // emitter's reading of the clock, not the poser.
  celebrationState.active = true;
  celebrationState.variant = TEST_POSE;
  celebrationState.seq += 1;
  celebrationState.clock = 0;
  celebrationState.peakAt = peakAt;
  celebrationState.release = release;
  celebrationState.duration = peakAt + hold + release;
}
function run(seconds) {
  let fired = 0;
  for (let t = 0; t < seconds; t += DT) {
    celebrationState.clock += DT;
    if (celebrationState.clock >= celebrationState.duration) celebrationState.active = false;
    fired += updatePoseBubbles(DT, RIG, CTX);
    updateParticles(DT);
    if (!celebrationState.active) break;
  }
  return fired;
}
function clear() {
  resetPoseBubbles();
  resetCelebration();
  // resetParticles and NOT a second initParticles: re-initialising builds a
  // fresh geometry and leaves the attribute arrays this file is reading
  // pointing at the old one — every count then reads a buffer nothing emits
  // into any more, which looks exactly like an emitter that has stopped
  // working.
  resetParticles();
}

console.log('\nPOSE BUBBLES\n');

// ---------------------------------------------------------------------------
section('a burst fires once, on the crossing');
{
  clear();
  spec({ enabled: true, from: 'mouth', rate: 0, bursts: [{ at: 0.5, count: 7 }] });
  play({ peakAt: 0.5, hold: 0.6, release: 0.2 });
  // Stepped by hand, and the buffer read on the FRAME THEY ARE BORN. Reading
  // it at the end of the performance is reading it after a bubble's whole life
  // has gone by — which is an empty buffer and a test that passes or fails on
  // the emitter's lifetime rather than on where it emitted.
  let fired = 0;
  let born = [];
  for (let i = 0; i < 180 && !fired; i++) {
    celebrationState.clock += DT;
    fired = updatePoseBubbles(DT, RIG, CTX);
    if (fired) born = live();
    updateParticles(DT);
  }
  // `count` is how many times the EMITTER is fired, not how many sprites land:
  // one emit is a puff of whatever CONFIG.emitters says, so the buffer holds a
  // multiple of the count and the two numbers are not the same assertion.
  check('the emitter fires exactly the count it asked for', fired === 7, `fired ${fired}`);
  check('...and every sprite is born at the named anchor',
    born.length >= 7 && born.every((p) => p.x === 100),
    `${born.length} sprites, x ${[...new Set(born.map((p) => p.x))].join('/')}`);
}

{
  // The trap: a burst at the PEAK, where the phase reaches 1 and then sits
  // there for the whole hold. A window test fires it every frame of that.
  clear();
  spec({ enabled: true, from: 'mouth', rate: 0, bursts: [{ at: 1, count: 3 }] });
  play({ peakAt: 0.3, hold: 1.2, release: 0.2 });
  const fired = run(3);
  check('a burst on the peak fires once, not for every frame of the hold',
    fired === 3, `fired ${fired}`);
}

// ---------------------------------------------------------------------------
section('a second performance re-arms it');
{
  clear();
  spec({ enabled: true, from: 'mouth', rate: 0, bursts: [{ at: 0.5, count: 4 }] });
  play();
  const first = run(2);
  play();
  const second = run(2);
  check('the first one fires', first === 4, `fired ${first}`);
  check('...and so does the second', second === 4, `fired ${second}`);
}

// ---------------------------------------------------------------------------
section('the rate rides the pose weight');
{
  clear();
  // No bursts: everything counted here is the stream.
  spec({ enabled: true, from: 'tail', rate: 30, bursts: [] });
  play({ peakAt: 0.5, hold: 0.5, release: 0.5 });
  // Through the ramp alone, where the weight averages about half.
  let ramp = 0;
  for (let i = 0; i < 30; i++) {
    celebrationState.clock += DT;
    ramp += updatePoseBubbles(DT, RIG, CTX);
    updateParticles(DT);
  }
  const flat = 30 * 0.5;
  check('the ramp emits less than the flat-out rate would', ramp > 0 && ramp < flat,
    `${ramp} against ${flat} at full weight`);
  // ...and the hold, which is full weight.
  let held = 0;
  for (let i = 0; i < 30; i++) {
    celebrationState.clock += DT;
    held += updatePoseBubbles(DT, RIG, CTX);
    updateParticles(DT);
  }
  check('the hold emits at the full rate', Math.abs(held - flat) <= 2, `${held} against ${flat}`);
  check('the hold emits more than the ramp did', held > ramp, `${held} vs ${ramp}`);
  const stream = live();
  check('the stream comes off the named anchor',
    stream.length > 0 && stream.every((p) => p.x === 400), `${stream.length} alive`);
}

// ---------------------------------------------------------------------------
section('the things that must emit nothing');
{
  clear();
  spec({ enabled: true, from: 'nowhere', rate: 40, bursts: [{ at: 0.5, count: 9 }] });
  play();
  const fired = run(2);
  check('an anchor nobody resolves emits nothing at all', fired === 0, `fired ${fired}`);
  check('...and puts nothing in the buffer either', live().length === 0, `${live().length} alive`);
}
{
  clear();
  spec({ enabled: false, from: 'mouth', rate: 40, bursts: [{ at: 0.5, count: 9 }] });
  play();
  check('a block switched off emits nothing', run(2) === 0);
}
{
  clear();
  spec({ enabled: true, from: 'mouth', rate: 40, bursts: [{ at: 0.5, count: 9 }] });
  play();
  let fired = 0;
  for (let i = 0; i < 60; i++) {
    celebrationState.clock += DT;
    fired += updatePoseBubbles(DT, RIG, { aboveSurface: true, velocity: { x: 0, y: 0 } });
  }
  check('a breached seal emits nothing — bubbles in the air read as a bug', fired === 0, `fired ${fired}`);
}
{
  clear();
  spec({ enabled: true, from: 'mouth', rate: 40, bursts: [{ at: 0.5, count: 9 }] });
  play();
  let fired = 0;
  for (let i = 0; i < 60; i++) {
    celebrationState.clock += DT;
    fired += updatePoseBubbles(DT, null, CTX);
  }
  check('a creature with no rig emits nothing rather than throwing', fired === 0, `fired ${fired}`);
}
{
  clear();
  // A pose with no `bubbles` block at all — the default, and the one every
  // pose had before this system existed.
  CONFIG.celebrate.poses[TEST_POSE] = {};
  play();
  check('a pose that asks for none gets none', run(2) === 0);
}

// ---------------------------------------------------------------------------
section('the coil — a puff on the moment, and exactly one of it');
// ---------------------------------------------------------------------------
// The wind-up's own source (CONFIG.strikePose.bubbles). It is driven through
// the real envelope rather than by setting `t` by hand, because the two things
// that can go wrong here are both about the envelope's shape: the snap
// overshoots 1, and the hold sits at 1 for as long as the player likes. A
// phase that was not capped would cross a burst written at 1 twice — once on
// the way up and once coming back down through it — and a burst that re-armed
// on the hold would fire every frame of it.
{
  clear();
  resetStrikePose();
  const was = CONFIG.strikePose.bubbles;
  CONFIG.strikePose.bubbles = { enabled: true, emitter: 'wakeBubbles', from: 'tail', rate: 0, bursts: [{ at: 0.7, count: 3 }] };

  const coil = (seconds, armed) => {
    let fired = 0;
    for (let t = 0; t < seconds; t += DT) {
      updateStrikePose(DT, armed);
      fired += updatePoseBubbles(DT, RIG, CTX);
      updateParticles(DT);
    }
    return fired;
  };

  const onEntry = coil(0.4, true);
  check('the moment puffs once', onEntry === 3, `${onEntry} emitted`);
  check('...off the fluke', live().every((p) => p.x === RIG.anchors.tail.x),
    live().map((p) => p.x).join(','));

  // FIVE SECONDS OF HOLD. The pose is still fully up and `t` is pinned at 1
  // the whole time; nothing more may come out of it.
  const held = coil(5, true);
  check('a long hold adds nothing', held === 0, `${held} during the hold`);

  // The let-go, then a second wind-up: a new moment is a new puff.
  coil(0.5, false);
  const second = coil(0.4, true);
  check('the next wind-up puffs again', second === 3, `${second} emitted`);

  // ...AND A RE-GRAB MID-RELEASE IS ALSO A NEW MOMENT, even though the coil
  // never got back to zero — `hits` is the seq for exactly this case.
  updateStrikePose(DT, false);
  updateStrikePose(DT, false);
  const regrab = coil(0.4, true);
  check('grabbing it again mid-release puffs again', regrab === 3, `${regrab} emitted`);

  // Above the surface there is no water to bubble in.
  coil(0.5, false);
  CTX.aboveSurface = true;
  const air = coil(0.4, true);
  CTX.aboveSurface = false;
  check('a coil in the air emits nothing', air === 0, `${air} emitted`);

  CONFIG.strikePose.bubbles = was;
  resetStrikePose();
  clear();
}

// ---------------------------------------------------------------------------
section('the shipped poses are wired to anchors that exist');
{
  // Not a taste check — a `from` that resolves to nothing is silent, and
  // silence is exactly what "this pose does not emit" looks like.
  const KNOWN = new Set(['mouth', 'fins', 'finL', 'finR', 'tail']);
  for (const [name, pose] of Object.entries(CONFIG.celebrate.poses)) {
    if (name === TEST_POSE || !pose?.bubbles) continue;
    const b = pose.bubbles;
    const names = [b.from, ...(b.bursts ?? []).map((x) => x.from)].filter(Boolean);
    check(`${name}: every anchor it names is one poseBubbles can resolve`,
      names.every((n) => KNOWN.has(n)), names.join(','));
    const emitters = [b.emitter, ...(b.bursts ?? []).map((x) => x.emitter)].filter(Boolean);
    check(`${name}: every emitter it names is in CONFIG.emitters`,
      emitters.every((e) => !!CONFIG.emitters[e]), emitters.join(','));
  }
  for (const [label, b] of [['clap', CONFIG.clap?.bubbles], ['coil', CONFIG.strikePose?.bubbles]]) {
    if (!b) continue;
    const names = [b.from, ...(b.bursts ?? []).map((x) => x.from)].filter(Boolean);
    check(`${label}: every anchor it names resolves`, names.every((n) => KNOWN.has(n)), names.join(','));
    const emitters = [b.emitter, ...(b.bursts ?? []).map((x) => x.emitter)].filter(Boolean);
    check(`${label}: every emitter it names exists`,
      emitters.every((e) => !!CONFIG.emitters[e]), emitters.join(','));
    // A burst written past the top of the envelope can never be crossed. The
    // coil's phase is capped at 1 (the snap overshoots and the cap is what
    // stops a double), so `at` above 1 is a puff that silently never happens.
    const ats = (b.bursts ?? []).map((x) => x.at ?? 1);
    check(`${label}: every burst is inside the envelope`, ats.every((a) => a > 0 && a <= 1), ats.join(','));
  }
}

delete CONFIG.celebrate.poses[TEST_POSE];
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
