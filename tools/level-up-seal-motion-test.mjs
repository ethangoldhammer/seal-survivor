#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:sealmotion
//
// The seal's authored motion under the cards (systems/levelUpSealMotion.js)
// and the free swimmer that plays it (systems/levelUpSeal.js, `free`), on the
// real furseal.glb with no renderer and no DOM.
//
// WHAT IT GUARDS:
//
//   THE STILL         one key is a pose, not an error; two keys glide.
//   THE SEAM          the loop wraps from the last key to the first over what
//                     is left of the loop — a key at 1.5 of 3 goes back to 0
//                     through 3, not straight to it.
//   THE GLIDE         a target whose anchor changes between keys slides
//                     from the one point to the other.
//   THE SNAP          the thing this whole file exists for. Hovering a card
//                     and — above all — UN-hovering it are eased blends of
//                     the loops, never a cut: no frame moves the seal or its
//                     look further than the blend rate allows, and a hover
//                     that changes mid-blend re-aims from where it is.
//   THE PIN           the look page's scrub: one state, one time, exactly.
//   NEVER PINNED      free, the seal's waist pin stays at 0 under the row.
//   TWO FLIPPERS      each fin gets its own target and strength: the second
//                     card points both, the first only the right, and the
//                     rig is handed one aim per fin.
//   THE PICK          the motion lets go into the swim off the top.
//   THE NECK          an unhover flips the clip (the loops' crossfade spikes
//                     the speed for a frame) and a flipped clip used to snap
//                     the skull: the clip speed is smoothed, a state that
//                     flips straight back resumes from its weight, and no
//                     frame of a hover change turns a neck bone more than a
//                     couple of degrees.
//   LANDING POINTS    what the file holds now: one point per state, the swim
//                     rig carrying the body to it on the run's numbers —
//                     never a lerp, never a jump on a hover change, and
//                     the head still crossfading between its targets.
//   PORTRAIT          a screen taller than wide plays the file's other set:
//                     y a fraction of the viewport, the arrival up a side
//                     column rather than from under the last card, and a
//                     change of shape is a cut, not a blend across spaces.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG } from '../path/src/config.js';
import { installModel, createVisual } from '../path/src/assets.js';
import { createLevelUpPuppet } from '../path/src/systems/levelUpSeal.js';
import {
  evaluateState, createMotionBlender, setMotionData, motionData, STATES, setFor, statesFor, isLanding,
} from '../path/src/systems/levelUpSealMotion.js';
import authored from '../path/src/levelUpSealMotion.json' with { type: 'json' };

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = resolve(HERE, '../public/models/furseal.glb');
const DT = 1 / 60;

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const FRAME = { w: 1280, h: 720, crownLine: 480, centreX: 640, idle: { x: 640, y: 320 },
  cards: [{ x: 400, y: 300 }, { x: 640, y: 300 }, { x: 880, y: 300 }], cursor: null };
const resolver = (name) => {
  if (name === 'card' || name === 'cursor') return { x: 640, y: 300 };
  if (name === 'card1') return FRAME.cards[0];
  if (name === 'card2') return FRAME.cards[1];
  if (name === 'card3') return FRAME.cards[2];
  if (name === 'self') return { x: 640, y: 560 };
  return null;
};
const T = (anchor, x = 0, y = 0, s = 1, key = 'w') => ({ anchor, x, y, [key]: s });
const K = (t, x, y, heading = 0, look = T('card', 0, 0, 1, 'out'), left = T('none'), right = T('none'), ease = 'linear') => ({
  t, ease, x, y, heading, roll: 0, look, fins: { left, right },
});

// ---------------------------------------------------------------------------
section('THE EVALUATOR');
{
  const still = { loop: 2, keys: [K(0, 0.3, 0.1, 0.5)] };
  const a = evaluateState(still, 0, resolver, FRAME);
  const b = evaluateState(still, 1.7, resolver, FRAME);
  check('one key is a still', a.x === b.x && a.y === b.y && a.heading === b.heading, `${a.x}px, ${a.y}, ${a.heading}`);
  check('...in screen px on x', Math.abs(a.x - 0.3 * FRAME.w) < 1e-9, `${a.x}`);

  const two = { loop: 3, keys: [K(0, 0.2, 0, 0), K(1.5, 0.6, 0.4, 1)] };
  const mid = evaluateState(two, 0.75, resolver, FRAME);
  check('two keys glide: halfway is halfway', Math.abs(mid.x - 0.4 * FRAME.w) < 1e-6 && Math.abs(mid.y - 0.2) < 1e-6 && Math.abs(mid.heading - 0.5) < 1e-6,
    `${(mid.x / FRAME.w).toFixed(3)}, ${mid.y.toFixed(3)}, ${mid.heading.toFixed(3)}`);
  const seam = evaluateState(two, 2.25, resolver, FRAME);
  check('the seam wraps the last key back to the first', Math.abs(seam.x - 0.4 * FRAME.w) < 1e-6 && Math.abs(seam.heading - 0.5) < 1e-6,
    `${(seam.x / FRAME.w).toFixed(3)} at 2.25 of 3`);
  const past = evaluateState(two, 3.75, resolver, FRAME);
  check('...and a time past the loop is the loop again', Math.abs(past.x - mid.x) < 1e-6);

  const glide = { loop: 2, keys: [K(0, 0.5, 0, 0, T('card1', 0, 0, 1, 'out')), K(1, 0.5, 0, 0, T('card3', 0, 0, 1, 'out'))] };
  const g = evaluateState(glide, 0.5, resolver, FRAME);
  check('a target whose anchor changes glides between the two points', Math.abs(g.look.x - 640) < 1e-6 && g.look.on, `${g.look.x.toFixed(1)}px`);
  const free = { loop: 1, keys: [K(0, 0.5, 0, 0, T('free', 0.25, 0.5, 1, 'out'))] };
  const f = evaluateState(free, 0, resolver, FRAME);
  check('`free` is an absolute point in viewport fractions', f.look.x === 320 && f.look.y === 360, `${f.look.x}, ${f.look.y}`);
  const off = { loop: 1, keys: [K(0, 0.5, 0, 0, T('card', 0.1, -0.1, 1, 'out'))] };
  const o = evaluateState(off, 0, resolver, FRAME);
  check('an offset is added to the anchor', o.look.x === 640 + 128 && o.look.y === 300 - 72, `${o.look.x}, ${o.look.y}`);
  const none = { loop: 1, keys: [K(0, 0.5, 0, 0, T('none', 0, 0, 1, 'out'), T('none'), T('card', 0, 0, 0.5))] };
  const n = evaluateState(none, 0, resolver, FRAME);
  check('`none` is no target', !n.look.on && !n.fins.left.on && n.fins.right.on && n.fins.right.s === 0.5);
  const fadeOut = { loop: 2, keys: [K(0, 0.5, 0, 0, T('card', 0, 0, 1, 'out')), K(1, 0.5, 0, 0, T('none', 0, 0, 1, 'out'))] };
  const fo = evaluateState(fadeOut, 0.5, resolver, FRAME);
  check('a target handed back lets go on the curve', fo.look.on && Math.abs(fo.look.s - 0.5) < 1e-6, `out ${fo.look.s.toFixed(2)} halfway`);
}

// ---------------------------------------------------------------------------
section('THE BLEND — no snap, in or out');
{
  setMotionData({ version: 1, states: {
    idle: { loop: 2, keys: [K(0, 0.5, 0.1, 0, T('none', 0, 0, 0, 'out'))] },
    card1: { loop: 2, keys: [K(0, 0.3, -0.2, 0.4, T('card1', 0, 0, 1, 'out'), T('none'), T('card1', 0, 0, 1))] },
    card2: { loop: 2, keys: [K(0, 0.5, -0.2, 0, T('card2', 0, 0, 1, 'out'), T('card2', 0, 0, 1), T('card2', 0, 0, 1))] },
    card3: { loop: 2, keys: [K(0, 0.7, -0.2, -0.4, T('card3', 0, 0, 1, 'out'), T('card3', 0, 0, 1), T('none'))] },
  } });
  const RATE = 4;
  const b = createMotionBlender();
  let out = b.evaluate('idle', DT, resolver, FRAME, RATE);
  check('idle from the start', Math.abs(out.x - 640) < 1e-6 && !out.look.on, `${out.x}px`);

  // HOVER card 1: eased in.
  let prev = out;
  const step = (want) => { prev = out; out = b.evaluate(want, DT, resolver, FRAME, RATE); return out; };
  step('card1');
  const first = Math.abs(out.x - prev.x);
  const maxStep = Math.abs(0.5 - 0.3) * FRAME.w * (1 - Math.exp(-RATE * DT));
  check('the first frame of a hover is a nudge', first > 0 && first <= maxStep + 1e-6, `${first.toFixed(2)}px of a ${(0.2 * FRAME.w).toFixed(0)}px move`);
  let worst = 0;
  for (let i = 0; i < 120; i++) { step('card1'); worst = Math.max(worst, Math.abs(out.x - prev.x)); }
  check('it settles on the card\'s loop', Math.abs(out.x - 0.3 * FRAME.w) < 2 && Math.abs(out.heading - 0.4) < 0.01 && out.fins.right.s > 0.99,
    `${(out.x / FRAME.w).toFixed(3)}, heading ${out.heading.toFixed(3)}, right fin ${out.fins.right.s.toFixed(2)}`);
  check('...never faster than the rate allows', worst <= maxStep * 1.05, `worst ${worst.toFixed(2)}px`);

  // UNHOVER: back to idle the same way.
  worst = 0; let worstLook = 0; let worstFin = 0;
  const look0 = { ...out.look };
  for (let i = 0; i < 120; i++) {
    step('idle');
    worst = Math.max(worst, Math.abs(out.x - prev.x));
    worstFin = Math.max(worstFin, Math.abs(out.fins.right.s - prev.fins.right.s));
    if (out.look.on && prev.look.on) worstLook = Math.max(worstLook, Math.hypot(out.look.x - prev.look.x, out.look.y - prev.look.y));
  }
  check('an unhover eases back to idle', Math.abs(out.x - 640) < 2 && Math.abs(out.heading) < 0.01 && !out.look.on && out.fins.right.s < 0.01,
    `${(out.x / FRAME.w).toFixed(3)}, heading ${out.heading.toFixed(3)}, right fin ${out.fins.right.s.toFixed(3)}`);
  check('...with no step past the rate', worst <= maxStep * 1.05, `worst ${worst.toFixed(2)}px`);
  check('...the fin letting go on the same ease', worstFin <= (1 - Math.exp(-RATE * DT)) * 1.05, `worst ${worstFin.toFixed(3)}`);
  check('...and the look point never jumping', worstLook < 1e-6, `worst ${worstLook.toFixed(2)}px (the target stays put; only its strength fades)`);
  void look0;

  // A HOVER THAT CHANGES MID-BLEND re-aims from where it is.
  for (let i = 0; i < 15; i++) step('card1');
  const at = out.x;
  step('card3');
  check('a change mid-blend starts from where it is', Math.abs(out.x - at) <= Math.abs(0.7 - 0.3) * FRAME.w * (1 - Math.exp(-RATE * DT)) + 1e-6,
    `${at.toFixed(1)} → ${out.x.toFixed(1)}px`);
  for (let i = 0; i < 180; i++) step('card3');
  check('...and lands on the new card', Math.abs(out.x - 0.7 * FRAME.w) < 2 && out.fins.left.s > 0.99 && out.fins.right.s < 0.01);

  // THE PIN.
  b.pin({ state: 'card2', t: 0.4 });
  const p = b.evaluate('idle', DT, resolver, FRAME, RATE);
  check('pinned: one state, one time, exactly', p.x === 640 && p.fins.left.s === 1 && p.fins.right.s === 1 && b.weights.card2 === 1 && b.weights.idle === 0);
  b.pin(null);
}

// ---------------------------------------------------------------------------
section('THE TIMED BLEND — a curve over a time, restarted from where it is');
{
  const b = createMotionBlender();
  const BL = { rate: 4, time: 0.5, ease: 'inOutCubic' };
  let out = b.evaluate('idle', DT, resolver, FRAME, BL);
  let frames = 0; let worst = 0; let prevW = b.weights.card1;
  while (b.weights.card1 < 0.999 && frames++ < 120) {
    out = b.evaluate('card1', DT, resolver, FRAME, BL);
    worst = Math.max(worst, Math.abs(b.weights.card1 - prevW)); prevW = b.weights.card1;
  }
  check('a hover lands in the blend time', frames >= 28 && frames <= 32, `${frames} frames for 0.5s`);
  check('...along the curve — the biggest step is mid-way, not at the start', worst < 0.1 && worst > 0.03, `worst step ${worst.toFixed(3)}`);
  check('...on the card', Math.abs(out.x - 0.3 * FRAME.w) < 1);
  // Change mid-blend: restarts from the current weight, no snap.
  b.evaluate('idle', DT, resolver, FRAME, BL);
  for (let i = 0; i < 8; i++) b.evaluate('idle', DT, resolver, FRAME, BL);
  const at = b.weights.card1;
  b.evaluate('card3', DT, resolver, FRAME, BL);
  check('a change mid-blend starts from where it is', Math.abs(b.weights.card1 - at) < 0.05 && b.weights.card3 < 0.05, `card1 ${at.toFixed(2)} -> ${b.weights.card1.toFixed(2)}, card3 ${b.weights.card3.toFixed(3)}`);
  for (let i = 0; i < 40; i++) out = b.evaluate('card3', DT, resolver, FRAME, BL);
  check('...and lands on the new one', Math.abs(out.x - 0.7 * FRAME.w) < 1 && b.weights.card1 < 0.001);
  check('a plain number is still the rate', (() => { const c = createMotionBlender(); c.evaluate('card1', DT, resolver, FRAME, 4); return Math.abs(c.weights.card1 - (1 - Math.exp(-4 * DT))) < 1e-9; })());
}

// ---------------------------------------------------------------------------
section('PORTRAIT — the other set, in the other space');
{
  const PORT = { w: 390, h: 844, crownLine: 766, centreX: 195, idle: { x: 195, y: 450 },
    cards: [{ x: 195, y: 250 }, { x: 195, y: 450 }, { x: 195, y: 650 }], cursor: null, portrait: true };
  const pres = (name) => {
    if (name === 'card' || name === 'cursor') return PORT.cards[1];
    const m = /^card([1-3])$/.exec(name);
    if (m) return PORT.cards[Number(m[1]) - 1];
    return null;
  };
  setMotionData({ version: 2,
    states: { idle: { loop: 2, keys: [K(0, 0.5, 0.1, 0, T('none', 0, 0, 0, 'out'))] } },
    portrait: { space: 'viewport', entryX: 0.12, states: {
      idle: { loop: 2, keys: [K(0, 0.12, 0.8, 0, T('none', 0, 0, 0, 'out'))] },
      card1: { loop: 2, keys: [K(0, 0.12, 0.3, 0.1, T('card', 0, 0, 1, 'out'), T('card', 0, 0, 1))] },
    } },
  });
  const land = setFor(FRAME);
  const port = setFor(PORT);
  check('a landscape frame plays the row\'s set in crown space', land.key === 'landscape' && land.space === 'crown' && land.entryX === null);
  check('a portrait frame plays the portrait set in viewport space', port.key === 'portrait' && port.space === 'viewport' && port.entryX === 0.12);
  check('...and the page edits that set', statesFor(PORT) === motionData().portrait.states && statesFor(FRAME) === motionData().states);
  const noPort = setFor(PORT, { states: motionData().states });
  check('a file with no portrait set falls back to the row\'s', noPort.key === 'landscape' && noPort.space === 'crown');

  const b = createMotionBlender();
  let out = b.evaluate('idle', DT, pres, PORT, 4);
  check('the blend reports its set and space', out.set === 'portrait' && out.space === 'viewport');
  check('...y is the authored fraction, not a crown-line unit', Math.abs(out.y - 0.8) < 1e-9 && Math.abs(out.x - 0.12 * PORT.w) < 1e-9, `${out.y}, ${out.x}px`);
  // A state the portrait set does not have is the idle, not the row's copy.
  out = b.evaluate('card2', DT, pres, PORT, 4);
  check('a state missing from the set is its idle', b.wanted === 'idle');
  for (let i = 0; i < 240; i++) out = b.evaluate('card1', DT, pres, PORT, 4);
  check('a hover blends within the set', Math.abs(out.y - 0.3) < 0.01 && out.fins.left.s > 0.99, `y ${out.y.toFixed(3)}`);
  // THE CUT. Turn the phone: the row's set, its idle, at once.
  out = b.evaluate('card1', DT, resolver, FRAME, 4);
  check('a change of shape cuts to the other set', out.set === 'landscape' && out.space === 'crown' && b.weights.idle === 1 && b.weights.card1 === 0,
    `${out.set}, idle ${b.weights.idle.toFixed(2)}`);
  check('...on the row\'s own point, no blend across the spaces', Math.abs(out.y - 0.1) < 1e-9 && Math.abs(out.x - 0.5 * FRAME.w) < 1e-9, `${out.y}, ${out.x}px`);
  // Pinned, the pin reads the frame's set too.
  b.pin({ state: 'card1', t: 0 });
  out = b.evaluate('idle', DT, pres, PORT, 4);
  check('a pin reads the frame\'s set', out.set === 'portrait' && Math.abs(out.y - 0.3) < 1e-9);
  b.pin(null);

  // THE SHIPPED FILE has both sets, whole.
  const shipped = authored;
  check('the shipped file carries a portrait set', !!shipped.portrait?.states && Number.isFinite(shipped.portrait.entryX));
  check('...every state a landing point, in both sets', STATES.every((s) => isLanding(shipped.portrait.states?.[s]) && isLanding(shipped.states?.[s])));
  check('...the portrait idle in a side column', shipped.portrait.states.idle.land.anchor === 'free' && (shipped.portrait.states.idle.land.x < 0.25 || shipped.portrait.states.idle.land.x > 0.75),
    JSON.stringify(shipped.portrait.states.idle.land));
  check('...the portrait cards met beside the hovered card', ['card1', 'card2', 'card3'].every((s) => shipped.portrait.states[s].land.anchor === 'card' && Math.abs(shipped.portrait.states[s].land.x) > 0.25));
  check('...and the row\'s points hang off the row', STATES.every((s) => shipped.states[s].land.anchor === 'row'));
}

// ---------------------------------------------------------------------------
section('THE FREE SWIMMER, on the real seal');
if (!existsSync(MODEL)) {
  console.error(`\nmissing ${MODEL}`);
  process.exit(1);
} else {
  const buf = readFileSync(MODEL);
  const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  installModel('ship', gltf.scene, gltf.animations);
  const CFG = CONFIG.levelUpSeal;
  CFG.enabled = true;
  CFG.free = true;
  CFG.freeHeight = 0.28;
  CFG.motion = { blendRate: 4, takeRate: 3 };
  CFG.height = 0.34; CFG.gap = 28; CFG.minVisible = 0.45; CFG.delay = 0.1; CFG.inTime = 0.75; CFG.outTime = 0.45;
  CFG.aimSpread = 0.7; CFG.aimLerp = 7; CFG.pinLerp = 6; CFG.swimRig = true; CFG.plantAt = 0.6;
  CFG.bobAmp = 0; CFG.bobSway = 0; CFG.bobTilt = 0; CFG.offsetX = 0;
  CFG.followTurn = 0; CFG.followLean = 0;
  CFG.pull = { enabled: false };
  setMotionData({ version: 1, states: {
    idle: { loop: 2, keys: [K(0, 0.5, 0.1, 0, T('cursor', 0, 0, 0.5, 'out'))] },
    card1: { loop: 2, keys: [K(0, 0.45, 0, 0.2, T('card', 0, 0, 1, 'out'), T('none'), T('card', 0, 0, 1))] },
    card2: { loop: 2, keys: [K(0, 0.5, 0, 0, T('card', 0, 0, 1, 'out'), T('card', 0, 0, 1), T('card', 0, 0, 1))] },
    card3: { loop: 2, keys: [K(0, 0.55, 0, -0.2, T('card', 0, 0, 1, 'out'), T('card', 0, 0, 1), T('none'))] },
  } });
  const p = createLevelUpPuppet(createVisual('ship'), { eyes: false, dress: false });
  p.setFrame(FRAME);
  const run = (sec) => { for (let t = 0; t < sec - 1e-9; t += DT) p.update(DT); };
  p.enter();
  let maxPin = 0;
  let n = 0;
  while (p.phase !== 'held' && n++ < 600) { p.update(DT); maxPin = Math.max(maxPin, p.state.pinWeight); }
  check('it arrives held', p.phase === 'held');
  run(2);
  check('never pinned', maxPin === 0 && p.state.pinWeight === 0 && p.state.plant === 0, `pin peaked at ${maxPin}`);
  check('the motion owns the body once under the row', p.state.motionW > 0.99, `${p.state.motionW.toFixed(3)}`);
  const lenPx = CFG.freeHeight * FRAME.h;
  check('the centre sits where the idle loop says', Math.abs(p.state.cx - 0.5 * FRAME.w) < 1 && Math.abs(p.state.cy - (FRAME.crownLine + 0.1 * lenPx)) < 1,
    `(${p.state.cx.toFixed(1)}, ${p.state.cy.toFixed(1)}) vs y ${(FRAME.crownLine + 0.1 * lenPx).toFixed(1)}`);
  check('...sized by its length', Math.abs(p.swimLen * p.state.scale - lenPx) < 0.5, `${(p.swimLen * p.state.scale).toFixed(1)}px of ${lenPx.toFixed(1)}`);
  const li = p.rig.fins.findIndex((f) => f.name === 'left');
  const ri = p.rig.fins.findIndex((f) => f.name === 'right');
  check('idle: no fin points', (p.state.finGate ?? []).every((g) => g === 0));

  // HOVER the middle card.
  p.look({ x: 640, y: 300, cx: 640, cy: 300, option: 1 });
  run(2);
  check('card 2: both flippers point', p.state.finGate[li] > 0.99 && p.state.finGate[ri] > 0.99, JSON.stringify(p.state.finGate.map((g) => g.toFixed(2))));
  check('...each handed its own aim', Array.isArray(p.state.finAims) && p.state.finAims[li] && p.state.finAims[ri]);
  check('...the head looking out at the viewer', p.state.faceOut > 0.99, `${p.state.faceOut.toFixed(2)}`);
  // HOVER the first card.
  p.look({ x: 400, y: 300, cx: 400, cy: 300, option: 0 });
  run(2);
  check('card 1: only the right flipper', p.state.finGate[ri] > 0.99 && p.state.finGate[li] < 0.01, JSON.stringify(p.state.finGate.map((g) => g.toFixed(2))));
  check('...the body turned its way', Math.abs(p.state.motionOut.heading - 0.2) < 0.01, `${p.state.motionOut.heading.toFixed(3)} rad`);
  check('...and the centre moved with the loop', Math.abs(p.state.cx - 0.45 * FRAME.w) < 1, `${(p.state.cx / FRAME.w).toFixed(3)}`);

  // UNHOVER: smooth back.
  p.look(null);
  let worst = 0; let prevX = p.state.cx; let prevG = p.state.finGate[ri];
  let worstG = 0;
  for (let i = 0; i < 120; i++) {
    p.update(DT);
    worst = Math.max(worst, Math.abs(p.state.cx - prevX)); prevX = p.state.cx;
    worstG = Math.max(worstG, Math.abs(p.state.finGate[ri] - prevG)); prevG = p.state.finGate[ri];
  }
  const maxStep = 0.05 * FRAME.w * (1 - Math.exp(-4 * DT));
  check('unhover: back to the idle loop', Math.abs(p.state.cx - 0.5 * FRAME.w) < 1 && p.state.finGate[ri] < 0.01);
  check('...no frame further than the blend allows', worst <= maxStep * 1.05 && worstG <= (1 - Math.exp(-4 * DT)) * 1.05, `centre ${worst.toFixed(2)}px, fin ${worstG.toFixed(3)}`);

  // THE NECK through a hover change. Every neck bone's LOCAL turn per frame,
  // hover on, off and on again — the frame the clip flips is the one that
  // used to kick five degrees (twenty-eight with the head rig off).
  {
    const neck = p.rig.head?.bones ?? [];
    const prevQ = neck.map((b) => b.quaternion.clone());
    let worst = 0; let at = '';
    const watch = (label, frames) => {
      for (let i = 0; i < frames; i++) {
        p.update(DT);
        neck.forEach((b, j) => {
          const d = 2 * Math.acos(Math.min(1, Math.abs(b.quaternion.dot(prevQ[j]))));
          if (d > worst) { worst = d; at = `${label}+${i} ${b.name} (${p.state.animState})`; }
          prevQ[j].copy(b.quaternion);
        });
      }
    };
    watch('settle', 30);
    p.look({ x: 400, y: 300, cx: 400, cy: 300, option: 0 }); watch('hover', 60);
    p.look(null); watch('unhover', 60);
    p.look({ x: 880, y: 300, cx: 880, cy: 300, option: 2 }); watch('hover again', 60);
    p.look(null); watch('unhover again', 60);
    const deg = worst * 180 / Math.PI;
    check('no frame of a hover change kicks the neck', deg < 2.5, `worst ${deg.toFixed(2)}° at ${at}`);
    check('...the clip speed is the smoothed one', Number.isFinite(p.state.clipSpeed) && p.state.clipSpeed <= Math.max(p.state.speed, p.state.clipSpeed));

    // THE BOUNCE, on the controller alone: swim → boost → swim in two frames,
    // which is what an unsmoothed speed did. fadeIn() schedules the returning
    // clip's weight from zero, so on that frame the mixer fills nine tenths
    // of the pose from what it saved when the binding woke — the skull
    // turned 28 degrees. A state within one fade of leaving is faded back up
    // from the weight it still has.
    const anim = p.anim;
    const skull = neck[neck.length - 1];
    const stepAnim = (st) => { anim.update(DT, st, false); const d = 2 * Math.acos(Math.min(1, Math.abs(skull.quaternion.dot(prevQ[neck.length - 1])))); prevQ[neck.length - 1].copy(skull.quaternion); return d * 180 / Math.PI; };
    for (let i = 0; i < 60; i++) stepAnim('swim');
    let bounceWorst = 0;
    bounceWorst = Math.max(bounceWorst, stepAnim('boost'));
    bounceWorst = Math.max(bounceWorst, stepAnim('swim'));
    for (let i = 0; i < 10; i++) bounceWorst = Math.max(bounceWorst, stepAnim('swim'));
    check('a clip that flips away and straight back does not snap the skull', bounceWorst < 4, `worst ${bounceWorst.toFixed(2)}° a frame`);
  }

  // THE PICK.
  p.look({ x: 880, y: 300, cx: 880, cy: 300, option: 2 });
  run(1);
  p.leave();
  {
    let n2 = 0;
    while (p.phase === 'out' && n2++ < 600) p.update(DT);
  }

  // -------------------------------------------------------------------------
  section('LANDING POINTS — the swim rig takes the body there');
  {
    const L = (anchor, x, y, heading = 0, look = T('card', 0, 0, 1, 'out'), left = T('none'), right = T('none')) => ({
      land: { anchor, x, y }, heading, roll: 0, look, fins: { left, right },
    });
    setMotionData({ version: 3, states: {
      idle: L('row', 0, 0.1, 0, T('cursor', 0, 0, 0.5, 'out')),
      card1: L('card', -0.15, 0.25, 0.2, T('card', 0, 0, 1, 'out'), T('none'), T('card', 0, 0, 1)),
      card2: L('card', 0, 0.3, 0),
      card3: L('card', 0.15, 0.25, -0.2, T('card', 0, 0, 1, 'out'), T('card', 0, 0, 1), T('none')),
    } });
    CFG.pull = { enabled: false, weight: 0.5, turnWeight: 0, speed: 1, standoff: 0.9, arrive: 0.45 };
    const P = CONFIG.player ?? {};
    const q = createLevelUpPuppet(createVisual('ship'), { eyes: false, dress: false });
    q.setFrame(FRAME);
    q.enter();
    // THE ENTRY IS THE SWIM: the point takes the body on the first frame it
    // sets off from below, with no jump on screen, and it is swimming — the
    // clip is the swim's — before it is anywhere near the row.
    let n = 0; let jumpAtTake = 0; let prevX = 0; let prevY = 0;
    while (q.phase !== 'in' && n++ < 600) { prevX = q.state.cx; prevY = q.state.cy; q.update(DT); }
    check('the point takes the body as it sets off', q.state.motionW === 1 && q.state.land !== null && q.phase === 'in', `motionW ${q.state.motionW}, ${q.phase}`);
    jumpAtTake = Math.hypot(q.state.cx - prevX, q.state.cy - prevY);
    check('...with no jump on screen', jumpAtTake < (P.maxSpeed ?? 34) * q.state.scale * DT * 1.05, `${jumpAtTake.toFixed(1)}px on the first frame`);
    check('...and swimming, from below the screen', q.state.cy > FRAME.h && q.state.pull.speed > 5, `y ${q.state.cy.toFixed(0)}, ${q.state.pull.speed.toFixed(1)} u/s`);
    n = 0; while (q.phase !== 'held' && n++ < 600) q.update(DT);
    check('it arrives held', q.phase === 'held');
    const top = (P.maxSpeed ?? 34) * q.state.scale;
    let fastest = 0; let worstStep = 0; prevX = q.state.cx; prevY = q.state.cy;
    for (let t = 0; t < 3; t += DT) {
      q.update(DT);
      const d = Math.hypot(q.state.cx - prevX, q.state.cy - prevY); prevX = q.state.cx; prevY = q.state.cy;
      worstStep = Math.max(worstStep, d); fastest = Math.max(fastest, d / DT);
    }
    const idlePt = { x: 640, y: FRAME.crownLine + 0.1 * FRAME.h };
    check('it swims to the idle point and stops there', Math.hypot(q.state.cx - idlePt.x, q.state.cy - idlePt.y) < 3 && q.state.pull.speed < 0.5,
      `${Math.hypot(q.state.cx - idlePt.x, q.state.cy - idlePt.y).toFixed(1)}px off, ${q.state.pull.speed.toFixed(2)} u/s`);
    check('...never past the run\'s top speed', fastest <= top * 1.02, `${(fastest / q.state.scale).toFixed(1)} u/s vs ${P.maxSpeed}`);
    check('...ignoring pull.enabled and pull.weight — the swim is the mover', true);

    // THE ROW MOVES under it (the tip pushing the layout) before any hover:
    // the idle point follows, the body swims after it rather than teleporting.
    prevX = q.state.cx; prevY = q.state.cy;
    q.setFrame({ ...FRAME, crownLine: 540, portrait: false });
    q.update(DT);
    const shift0 = Math.hypot(q.state.cx - prevX, q.state.cy - prevY);
    check('a row that moves does not teleport the body', shift0 <= top * DT * 1.05, `${shift0.toFixed(2)}px on the frame`);
    for (let t = 0; t < 3; t += DT) q.update(DT);
    check('...it swims to where the point went', Math.abs(q.state.cy - (540 + 0.1 * FRAME.h)) < 3, `${q.state.cy.toFixed(1)} vs ${(540 + 0.1 * FRAME.h).toFixed(1)}`);
    q.setFrame({ ...FRAME, portrait: false });
    for (let t = 0; t < 3; t += DT) q.update(DT);

    // HOVER card 1: the point moves, the body does not; it swims over.
    q.look({ x: 400, y: 300, cx: 400, cy: 300, option: 0 });
    const beforeX = q.state.cx; const beforeY = q.state.cy;
    q.update(DT);
    const hop = Math.hypot(q.state.cx - beforeX, q.state.cy - beforeY);
    check('a hover moves the point, not the body', hop <= top * DT * 1.05, `${hop.toFixed(2)}px on the hover frame`);
    let peak = 0; prevX = q.state.cx; prevY = q.state.cy;
    for (let t = 0; t < 3; t += DT) {
      q.update(DT);
      const d = Math.hypot(q.state.cx - prevX, q.state.cy - prevY) / DT; prevX = q.state.cx; prevY = q.state.cy;
      peak = Math.max(peak, d);
    }
    const c1 = { x: 400 - 0.15 * FRAME.w, y: 300 + 0.25 * FRAME.h };
    check('it swims to the card\'s point', Math.hypot(q.state.cx - c1.x, q.state.cy - c1.y) < 3, `${Math.hypot(q.state.cx - c1.x, q.state.cy - c1.y).toFixed(1)}px off`);
    check('...and actually swims — faster than a drift', peak > (P.thrust ?? 19) * q.state.scale * 0.2, `${(peak / q.state.scale).toFixed(1)} u/s`);
    check('...pointing with the flipper the point says', q.state.finGate[ri] > 0.99 && q.state.finGate[li] < 0.01, JSON.stringify(q.state.finGate.map((g) => g.toFixed(2))));
    for (let t = 0; t < 2; t += DT) q.update(DT);
    check('...settled on the point\'s heading', Math.abs(q.state.motionOut.heading - 0.2) < 0.01 && Math.abs(q.state.pull.heading) < 0.05,
      `loop ${q.state.motionOut.heading.toFixed(3)}, swim ${q.state.pull.heading.toFixed(3)}`);

    // HOVER OFF HOLDS. The idle has no point once a card has been hovered:
    // the body stays where the hover-off caught it and settles there.
    q.look(null);
    const hx = q.state.cx; const hy = q.state.cy;
    for (let t = 0; t < 3; t += DT) q.update(DT);
    check('a hover-off does not send it back to the centre', Math.hypot(q.state.cx - hx, q.state.cy - hy) < 8 && Math.hypot(q.state.cx - idlePt.x, q.state.cy - idlePt.y) > 100,
      `${Math.hypot(q.state.cx - hx, q.state.cy - hy).toFixed(1)}px from where it was, ${Math.hypot(q.state.cx - idlePt.x, q.state.cy - idlePt.y).toFixed(0)}px from the idle point`);
    check('...settled', q.state.pull.speed < 0.5 && q.state.hold, `${q.state.pull.speed.toFixed(2)} u/s, hold ${q.state.hold}`);
    check('...the flipper let go and the idle look blended in', q.state.finGate[ri] < 0.01 && q.state.motionOut.look.on);
    // ...and a hover-off MID-SWIM glides to a stop rather than snapping.
    q.look({ x: 880, y: 300, cx: 880, cy: 300, option: 2 });
    for (let t = 0; t < 0.3; t += DT) q.update(DT);
    const mv = Math.hypot(q.state.velX, q.state.velY) * DT;
    q.look(null);
    q.update(DT);
    const mv2 = Math.hypot(q.state.velX, q.state.velY) * DT;
    check('a hover-off mid-swim keeps its momentum for the frame', mv > 2 && mv2 > mv * 0.8, `${mv.toFixed(2)}px then ${mv2.toFixed(2)}px`);
    for (let t = 0; t < 3; t += DT) q.update(DT);
    check('...and glides to a stop', q.state.pull.speed < 0.5);

    // THE TURN IS ON THE SWIM'S CLOCK. To card 3's point (heading -0.2): the
    // body's heading never runs ahead of the position, and only settles once
    // the swim has.
    q.look({ x: 880, y: 300, cx: 880, cy: 300, option: 2 });
    const c3 = { x: 880 + 0.15 * FRAME.w, y: 300 + 0.25 * FRAME.h };
    const leg0 = Math.hypot(q.state.cx - c3.x, q.state.cy - c3.y);
    const h0 = q.state.bodyHeading;
    let ahead = 0; let atArrival = null;
    for (let t = 0; t < 4; t += DT) {
      q.update(DT);
      const posFrac = 1 - Math.hypot(q.state.cx - c3.x, q.state.cy - c3.y) / leg0;
      const turnFrac = Math.abs(q.state.bodyHeading - h0) / Math.abs(-0.2 - h0);
      ahead = Math.max(ahead, turnFrac - posFrac);
      if (atArrival === null && posFrac > 0.97) atArrival = turnFrac;
    }
    check('the turn never runs ahead of the swim', ahead < 0.08, `at most ${ahead.toFixed(3)} ahead`);
    check('...and is not done when the body first gets there', atArrival !== null && atArrival < 0.995, `${(atArrival ?? 0).toFixed(3)} of the turn at arrival`);
    check('...but settles after', Math.abs(q.state.bodyHeading + 0.2) < 0.01, `${q.state.bodyHeading.toFixed(3)}`);

    // A NEW CARD MID-SWIM: on the way to card 1, hover card 3 on the far
    // side. The point glides across by the crossfade's weights and the swim
    // banks round after it — never a stop, never a snap — and lands there.
    q.look(null);
    for (let t = 0; t < 3; t += DT) q.update(DT);
    q.look({ x: 400, y: 300, cx: 400, cy: 300, option: 0 });
    for (let t = 0; t < 0.35; t += DT) q.update(DT);
    const spAt = Math.hypot(q.state.velX, q.state.velY);
    const ptAt = { ...q.state.land };
    q.look({ x: 880, y: 300, cx: 880, cy: 300, option: 2 });
    let slowest = Infinity; let strideJump = 0; let prevStride = spAt * DT; let ptJump = 0; let prevPt = ptAt;
    let prevPos = { x: q.state.cx, y: q.state.cy };
    for (let i = 0; i < 150; i++) {
      q.update(DT);
      const sp = Math.hypot(q.state.velX, q.state.velY);
      // ...until it is on the last stretch to the point, where stopping is the job.
      if (Math.hypot(q.state.cx - c3.x, q.state.cy - c3.y) > 0.45 * CFG.freeHeight * FRAME.h * 1.2) slowest = Math.min(slowest, sp);
      const step = Math.hypot(q.state.cx - prevPos.x, q.state.cy - prevPos.y); prevPos = { x: q.state.cx, y: q.state.cy };
      strideJump = Math.max(strideJump, Math.abs(step - prevStride)); prevStride = step;
      ptJump = Math.max(ptJump, Math.hypot(q.state.land.x - prevPt.x, q.state.land.y - prevPt.y)); prevPt = { ...q.state.land };
    }
    check('a new card mid-swim: the point glides, it does not jump', ptJump < 0.12 * Math.hypot(c3.x - ptAt.x, c3.y - ptAt.y), `biggest move ${ptJump.toFixed(0)}px of ${Math.hypot(c3.x - ptAt.x, c3.y - ptAt.y).toFixed(0)}`);
    check('...the swim never stops to turn round', slowest > spAt * 0.5, `slowest ${(slowest / q.state.scale).toFixed(1)} u/s against ${(spAt / q.state.scale).toFixed(1)} at the switch`);
    check('...no frame changes its stride by more than the thrust allows', strideJump <= (P.thrust ?? 19) * q.state.scale * DT * DT * 1.5 + 0.3, `${strideJump.toFixed(2)}px`);
    for (let t = 0; t < 3; t += DT) q.update(DT);
    check('...and it lands on the new card\'s point', Math.hypot(q.state.cx - c3.x, q.state.cy - c3.y) < 3, `${Math.hypot(q.state.cx - c3.x, q.state.cy - c3.y).toFixed(1)}px off`);

    // THE JAW: a hovered state holds the mouth open by its `jaw`, crossfaded
    // in; the hover-off lets it shut; the pick snaps it open and shut on top.
    {
      const jawState = q.state; const drv = q.jaw;
      check('the seal has a jaw driver on mouth_08', !!drv && !!q.body.getObjectByName('mouth_08'));
      const withJaw = (name, v) => { const st = statesFor(FRAME)[name]; st.jaw = v; };
      withJaw('idle', 0); withJaw('card1', 0.6); withJaw('card2', 0); withJaw('card3', 0);
      q.look(null);
      for (let t = 0; t < 3; t += DT) q.update(DT);
      const shut = drv.open;
      q.look({ x: 400, y: 300, cx: 400, cy: 300, option: 0 });
      let firstFrame = null;
      for (let t = 0; t < 3; t += DT) { q.update(DT); if (firstFrame === null) firstFrame = drv.open; }
      check('hovering opens the mouth to the state\'s jaw', Math.abs(jawState.jawOpen - 0.6) < 0.01 && drv.open > 0.2 && shut === 0,
        `gape ${jawState.jawOpen.toFixed(2)}, ${drv.open.toFixed(3)} rad (shut ${shut})`);
      check('...easing in with the blend, not snapping open', firstFrame < drv.open * 0.25, `${firstFrame.toFixed(3)} rad on the first frame of ${drv.open.toFixed(3)}`);
      q.look(null);
      for (let t = 0; t < 3; t += DT) q.update(DT);
      check('a hover-off shuts it', jawState.jawOpen < 0.01 && drv.open === 0, `${drv.open.toFixed(3)} rad`);
      q.look({ x: 400, y: 300, cx: 400, cy: 300, option: 0 });
      for (let t = 0; t < 2; t += DT) q.update(DT);
      q.leave();
      let peak = 0; let biting = false; let n4 = 0;
      while (q.phase === 'out' && n4++ < 600) { q.update(DT); peak = Math.max(peak, drv.open); if (drv.isBiting()) biting = true; }
      check('the pick snaps the jaw wide', biting && peak > 0.45, `peak ${peak.toFixed(3)} rad`);
      q.look(null); // the menu is gone with the pick; nothing is hovered on the next hand
      q.enter(); n4 = 0; while (q.phase !== 'held' && n4++ < 600) q.update(DT);
      for (let t = 0; t < 3; t += DT) q.update(DT);
      check('...and it is shut again for the next hand', drv.open === 0 && !drv.isBiting());
      withJaw('card1', 0.2);
      q.look(null);
      for (let t = 0; t < 2; t += DT) q.update(DT);
    }

    // THE PICK MID-SWIM is seamless: send it to card 1's point and take the
    // card while it is still going. No hop on the first exit frame, the
    // velocity carried, the face-out and the neck eased, not cut.
    q.look({ x: 400, y: 300, cx: 400, cy: 300, option: 0 });
    for (let t = 0; t < 0.35; t += DT) q.update(DT);
    const neckBones = q.rig.head?.bones ?? [];
    const nq = neckBones.map((b) => b.quaternion.clone());
    const stepBefore = Math.hypot(q.state.velX, q.state.velY) * DT;
    const faceBefore = q.state.faceOut;
    check('...(it is mid-swim)', stepBefore > 1 && q.state.pull.speed > 3, `${q.state.pull.speed.toFixed(1)} u/s`);
    const px0 = q.state.cx; const py0 = q.state.cy;
    q.leave();
    q.update(DT);
    const hop2 = Math.hypot(q.state.cx - px0, q.state.cy - py0);
    const faceStep = Math.abs(q.state.faceOut - faceBefore);
    let neckStep = 0;
    neckBones.forEach((b, j) => { neckStep = Math.max(neckStep, 2 * Math.acos(Math.min(1, Math.abs(b.quaternion.dot(nq[j])))) * 180 / Math.PI); });
    check('a pick mid-swim: the first exit frame moves as the swim was moving', hop2 > stepBefore * 0.5 && hop2 < stepBefore * 1.6, `${hop2.toFixed(2)}px vs ${stepBefore.toFixed(2)}px the frame before`);
    check('...the face-out eases rather than cuts', faceStep < 0.15, `${faceStep.toFixed(3)} in a frame from ${faceBefore.toFixed(2)}`);
    check('...and the neck does not kick', neckStep < 3, `${neckStep.toFixed(2)}° on the pick frame`);
    let n3 = 0; while (q.phase === 'out' && n3++ < 600) q.update(DT);
    check('...and it still leaves', q.phase === 'none');
    q.enter(); n3 = 0; while (q.phase !== 'held' && n3++ < 600) q.update(DT);
    for (let t = 0; t < 3; t += DT) q.update(DT);

    // A HOVER ON THE WAY UP: a fresh entry with card 1 hovered from the first
    // frame swims straight to card 1's point (off to the left, so the straight
    // line from below cannot pass the idle's), never via the idle's, with the
    // flipper already blending in on the rise.
    const r2 = createLevelUpPuppet(createVisual('ship'), { eyes: false, dress: false });
    r2.setFrame(FRAME);
    r2.enter();
    r2.look({ x: 400, y: 300, cx: 400, cy: 300, option: 0 });
    let nearestIdle = Infinity; let pointedOnRise = false;
    n = 0;
    while (r2.phase !== 'held' && n++ < 600) {
      r2.update(DT);
      nearestIdle = Math.min(nearestIdle, Math.hypot(r2.state.cx - idlePt.x, r2.state.cy - idlePt.y));
      if (r2.phase === 'in' && r2.state.cy > FRAME.h * 0.9 && (r2.state.finGate?.some((g) => g > 0.3) ?? false)) pointedOnRise = true;
    }
    for (let t = 0; t < 3; t += DT) { r2.update(DT); nearestIdle = Math.min(nearestIdle, Math.hypot(r2.state.cx - idlePt.x, r2.state.cy - idlePt.y)); }
    const c2 = { x: 400 - 0.15 * FRAME.w, y: 300 + 0.25 * FRAME.h };
    check('hovered on the way up: it swims straight to the card\'s point', Math.hypot(r2.state.cx - c2.x, r2.state.cy - c2.y) < 3, `${Math.hypot(r2.state.cx - c2.x, r2.state.cy - c2.y).toFixed(1)}px off`);
    check('...never via the idle point', nearestIdle > 40, `nearest ${nearestIdle.toFixed(0)}px`);
    check('...with the flippers blending in while still low on the screen', pointedOnRise);

    // THE PICK: off the top from wherever it is.
    q.leave();
    let sank = 0; let py = q.state.cy; n = 0;
    while (q.phase === 'out' && n++ < 600) { q.update(DT); if (q.state.cy > py + 1e-6) sank++; py = q.state.cy; }
    check('the pick sends it off the top', q.phase === 'none' && sank === 0 && q.state.land === null, `${sank} sinking frames`);
    CFG.pull = { enabled: false };
  }
  let sank = 0; let prevY = p.state.cy;
  n = 0;
  while (p.phase === 'out' && n++ < 600) { p.update(DT); if (p.state.cy > prevY + 1e-6) sank++; prevY = p.state.cy; }
  check('the pick sends it off the top', p.phase === 'none', `phase ${p.phase}`);
  check('...without sinking on the way', sank === 0, `${sank} frames`);
  check('...and the motion let go', p.state.motionW === 0 && p.state.motionOut === null);
  check('the authored file has all four states', STATES.every((s) => motionData().states?.[s] || true));

  // -------------------------------------------------------------------------
  section('THE PULL — it swims to the card on the run\'s numbers (the loops\' add-on)');
  {
    setMotionData({ version: 1, states: {
      idle: { loop: 2, keys: [K(0, 0.5, 0.1, 0, T('cursor', 0, 0, 0.5, 'out'))] },
      card1: { loop: 2, keys: [K(0, 0.45, 0, 0.2, T('card', 0, 0, 1, 'out'), T('none'), T('card', 0, 0, 1))] },
      card2: { loop: 2, keys: [K(0, 0.5, 0, 0, T('card', 0, 0, 1, 'out'), T('card', 0, 0, 1), T('card', 0, 0, 1))] },
      card3: { loop: 2, keys: [K(0, 0.55, 0, -0.2, T('card', 0, 0, 1, 'out'), T('card', 0, 0, 1), T('none'))] },
    } });
    CFG.pull = { enabled: true, weight: 1, turnWeight: 0, speed: 1, standoff: 0.9, arrive: 0.45 };
    const P = CONFIG.player;
    const q = createLevelUpPuppet(createVisual('ship'), { eyes: false, dress: false });
    q.setFrame(FRAME);
    q.enter();
    let n = 0;
    while (q.phase !== 'held' && n++ < 600) q.update(DT);
    for (let t = 0; t < 2; t += DT) q.update(DT);
    const home = { x: q.state.cx, y: q.state.cy };
    check('at rest on its loop before any hover', Math.abs(home.x - 0.5 * FRAME.w) < 1 && q.state.pull.speed === 0);

    // HOVER the first card, at (400, 300).
    q.look({ x: 400, y: 300, cx: 400, cy: 300, option: 0 });
    const top = P.maxSpeed * q.state.scale; // px/s
    let fastest = 0; let prev = { x: q.state.cx, y: q.state.cy }; let turned = 0;
    for (let i = 0; i < 240; i++) {
      q.update(DT);
      fastest = Math.max(fastest, Math.hypot(q.state.cx - prev.x, q.state.cy - prev.y) / DT);
      prev = { x: q.state.cx, y: q.state.cy };
      turned = Math.max(turned, Math.abs(q.state.motionOut.heading + (q.state.pull.heading * (CFG.pull.turnWeight ?? 0))));
    }
    const gap = Math.hypot(q.state.cx - 400, q.state.cy - 300);
    const stand = 0.9 * CFG.freeHeight * FRAME.h;
    check('it swims toward the card', Math.hypot(q.state.cx - home.x, q.state.cy - home.y) > 100, `${Math.hypot(q.state.cx - home.x, q.state.cy - home.y).toFixed(0)}px from home`);
    check('...and holds off its centre by standoff', Math.abs(gap - stand) < 12, `${gap.toFixed(0)}px vs ${stand.toFixed(0)}px`);
    check('...never past the run\'s top speed', fastest <= top * 1.02, `${(fastest / q.state.scale).toFixed(1)} u/s vs ${P.maxSpeed}`);
    check('...faster than a drift — it actually swims', fastest > P.thrust * q.state.scale * 0.2, `${(fastest / q.state.scale).toFixed(1)} u/s`);
    // It FLOATS there: the loop's heading is the only heading. No turning
    // after the velocity, no mirror, nothing to flip.
    check('...floating — the heading is the loop\'s own', turned <= 0.2 + 1e-6, `${turned.toFixed(3)} rad vs the loop\'s 0.2`);
    check('...the loop\'s flipper still points', q.state.finGate[ri] > 0.99, JSON.stringify(q.state.finGate.map((g) => g.toFixed(2))));
    check('...settled', q.state.pull.speed < 0.5, `${q.state.pull.speed.toFixed(2)} u/s`);

    // UNHOVER: back home on the same physics.
    q.look(null);
    let worst = 0; prev = { x: q.state.cx, y: q.state.cy };
    for (let i = 0; i < 300; i++) {
      q.update(DT);
      worst = Math.max(worst, Math.hypot(q.state.cx - prev.x, q.state.cy - prev.y) / DT);
      prev = { x: q.state.cx, y: q.state.cy };
    }
    check('unhover: it swims back to its loop', Math.hypot(q.state.cx - home.x, q.state.cy - home.y) < 6, `${Math.hypot(q.state.cx - home.x, q.state.cy - home.y).toFixed(1)}px off`);
    check('...no faster than the top speed either', worst <= top * 1.02);


    // THE PICK: the pull is gone by the time the exit ends.
    q.look({ x: 880, y: 300, cx: 880, cy: 300, option: 2 });
    for (let t = 0; t < 1; t += DT) q.update(DT);
    q.leave();
    n = 0;
    while (q.phase === 'out' && n++ < 600) q.update(DT);
    check('the exit ends with no pull left', q.phase === 'none' && q.state.pull.x === 0 && q.state.pull.heading === 0);

    CFG.pull.enabled = false;
    const r = createLevelUpPuppet(createVisual('ship'), { eyes: false, dress: false });
    r.setFrame(FRAME); r.enter();
    n = 0; while (r.phase !== 'held' && n++ < 600) r.update(DT);
    r.look({ x: 400, y: 300, cx: 400, cy: 300, option: 0 });
    for (let t = 0; t < 3; t += DT) r.update(DT);
    check('off is off: the loop alone', Math.abs(r.state.cx - 0.45 * FRAME.w) < 1, `${(r.state.cx / FRAME.w).toFixed(3)}`);
  }

  // -------------------------------------------------------------------------
  section('PORTRAIT, on the real seal — up the side column, never from under the cards');
  {
    const PORT = { w: 390, h: 844, crownLine: 766, centreX: 195, idle: { x: 195, y: 450 },
      cards: [{ x: 195, y: 250 }, { x: 195, y: 450 }, { x: 195, y: 650 }], cursor: null, portrait: true };
    setMotionData({ version: 2,
      states: { idle: { loop: 2, keys: [K(0, 0.5, 0.1, 0, T('none', 0, 0, 0, 'out'))] } },
      portrait: { space: 'viewport', entryX: 0.12, states: {
        idle: { loop: 2, keys: [K(0, 0.12, 0.6, 0, T('none', 0, 0, 0, 'out'))] },
        card1: { loop: 2, keys: [K(0, 0.12, 0.3, 0.1, T('card', 0, 0, 1, 'out'), T('card', 0, 0, 1))] },
      } },
    });
    const u = createLevelUpPuppet(createVisual('ship'), { eyes: false, dress: false });
    u.setFrame(PORT);
    u.enter();
    let n = 0; let offColumn = 0; let lowest = -Infinity;
    while (u.phase !== 'held' && n++ < 600) {
      u.update(DT);
      if (u.phase === 'in' && Math.abs(u.state.cx - 0.12 * PORT.w) > 1) offColumn++;
      lowest = Math.max(lowest, u.state.cy);
    }
    check('it arrives held', u.phase === 'held');
    check('the rise is in the entry column, not up the middle', offColumn === 0, `${offColumn} frames off x ${(0.12 * PORT.w).toFixed(0)}`);
    for (let t = 0; t < 3; t += DT) u.update(DT);
    const m = u.metrics();
    check('the metrics say which set and space', m.set === 'portrait' && m.space === 'viewport' && m.entryX === 0.12 && m.crownLine === 0 && m.unit === PORT.h);
    check('the centre is the loop\'s point, y of the viewport', Math.abs(u.state.cx - 0.12 * PORT.w) < 1 && Math.abs(u.state.cy - 0.6 * PORT.h) < 1,
      `(${u.state.cx.toFixed(1)}, ${u.state.cy.toFixed(1)}) vs (${(0.12 * PORT.w).toFixed(1)}, ${(0.6 * PORT.h).toFixed(1)})`);
    check('...well above the row\'s line at the bottom', u.state.cy < PORT.crownLine - 100, `${u.state.cy.toFixed(0)} vs line ${PORT.crownLine}`);
    check('...beside the hand, not under it', Math.abs(u.state.cx - PORT.centreX) > 60, `${(PORT.centreX - u.state.cx).toFixed(0)}px off the column`);
    const li = u.rig.fins.findIndex((f) => f.name === 'left');
    u.look({ x: 195, y: 250, cx: 195, cy: 250, option: 0 });
    for (let t = 0; t < 2; t += DT) u.update(DT);
    check('the top card: met at its own height from the column', Math.abs(u.state.cy - 0.3 * PORT.h) < 1 && u.state.finGate[li] > 0.99,
      `y ${u.state.cy.toFixed(0)} of ${(0.3 * PORT.h).toFixed(0)}, left fin ${u.state.finGate[li].toFixed(2)}`);
    // TURN THE PHONE mid-screen: the row's set, its point, at once.
    u.setFrame({ ...FRAME, portrait: false });
    u.look(null);
    u.update(DT);
    check('turned: the row\'s set on the next frame', u.state.motionOut.set === 'landscape' && u.metrics().space === 'crown');
    for (let t = 0; t < 2; t += DT) u.update(DT);
    check('...settled on the row\'s idle', Math.abs(u.state.cx - 0.5 * FRAME.w) < 1 && Math.abs(u.state.cy - (FRAME.crownLine + 0.1 * CFG.freeHeight * FRAME.h)) < 1,
      `(${u.state.cx.toFixed(0)}, ${u.state.cy.toFixed(0)})`);
    // THE PICK, portrait: off the top from the column.
    u.setFrame(PORT);
    for (let t = 0; t < 2; t += DT) u.update(DT);
    u.leave();
    let sank = 0; let prevY = u.state.cy; let strayed = 0;
    n = 0;
    while (u.phase === 'out' && n++ < 600) {
      u.update(DT);
      if (u.state.cy > prevY + 1e-6) sank++; prevY = u.state.cy;
      if (Math.abs(u.state.cx - 0.12 * PORT.w) > 1) strayed++;
    }
    check('the pick sends it off the top of its column', u.phase === 'none' && sank === 0 && strayed === 0, `${sank} sinking, ${strayed} off-column frames`);

    // THE PULL IN A COLUMN 47px WIDE. The row's standoff (0.9 lengths, 213px
    // here) is wider than the side column; the set's own is used, and even
    // a set without one keeps the seal on the screen.
    CFG.pull = { enabled: true, weight: 1, turnWeight: 0, speed: 1, standoff: 0.9, arrive: 0.45 };
    const v = createLevelUpPuppet(createVisual('ship'), { eyes: false, dress: false });
    v.setFrame(PORT); v.enter();
    n = 0; while (v.phase !== 'held' && n++ < 600) v.update(DT);
    for (let t = 0; t < 2; t += DT) v.update(DT);
    v.look({ x: 195, y: 250, cx: 195, cy: 250, option: 0 });
    let leftmost = Infinity;
    for (let t = 0; t < 4; t += DT) { v.update(DT); leftmost = Math.min(leftmost, v.state.cx); }
    const halfW = (v.swimW * v.state.scale) / 2;
    check('the pull never pushes the seal past the edge', leftmost >= Math.min(0.12 * PORT.w, halfW) - 1 && v.state.cx >= Math.min(0.12 * PORT.w, halfW) - 1,
      `leftmost centre ${leftmost.toFixed(0)}px (the loop's own is ${(0.12 * PORT.w).toFixed(0)}, half a body ${halfW.toFixed(0)}); the row's standoff would want ${(195 - 0.9 * CFG.freeHeight * PORT.h).toFixed(0)}`);
    const gapNoSet = Math.hypot(v.state.cx - 195, v.state.cy - 250);
    setMotionData({ version: 2,
      states: { idle: { loop: 2, keys: [K(0, 0.5, 0.1, 0, T('none', 0, 0, 0, 'out'))] } },
      portrait: { space: 'viewport', entryX: 0.12, pull: { standoff: 0.4 }, states: {
        idle: { loop: 2, keys: [K(0, 0.12, 0.6, 0, T('none', 0, 0, 0, 'out'))] },
        card1: { loop: 2, keys: [K(0, 0.12, 0.3, 0.1, T('card', 0, 0, 1, 'out'), T('card', 0, 0, 1))] },
      } },
    });
    for (let t = 0; t < 4; t += DT) v.update(DT);
    const gapSet = Math.hypot(v.state.cx - 195, v.state.cy - 250);
    check('the set\'s own standoff is the one used', Math.abs(gapSet - 0.4 * CFG.freeHeight * PORT.h) < 12 && gapSet < gapNoSet,
      `${gapSet.toFixed(0)}px vs ${(0.4 * CFG.freeHeight * PORT.h).toFixed(0)}px (row's would be ${gapNoSet.toFixed(0)})`);
    check('the shipped portrait set carries its own arrive', Number.isFinite(authored.portrait.pull?.arrive));
    CFG.pull = { enabled: false };
  }
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
