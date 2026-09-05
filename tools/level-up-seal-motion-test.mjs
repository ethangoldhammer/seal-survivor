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
  evaluateState, createMotionBlender, setMotionData, motionData, STATES,
} from '../path/src/systems/levelUpSealMotion.js';

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

  // THE PICK.
  p.look({ x: 880, y: 300, cx: 880, cy: 300, option: 2 });
  run(1);
  p.leave();
  let sank = 0; let prevY = p.state.cy;
  n = 0;
  while (p.phase === 'out' && n++ < 600) { p.update(DT); if (p.state.cy > prevY + 1e-6) sank++; prevY = p.state.cy; }
  check('the pick sends it off the top', p.phase === 'none', `phase ${p.phase}`);
  check('...without sinking on the way', sank === 0, `${sank} frames`);
  check('...and the motion let go', p.state.motionW === 0 && p.state.motionOut === null);
  check('the authored file has all four states', STATES.every((s) => motionData().states?.[s] || true));

  // -------------------------------------------------------------------------
  section('THE PULL — it swims to the card on the run\'s numbers');
  {
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
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
