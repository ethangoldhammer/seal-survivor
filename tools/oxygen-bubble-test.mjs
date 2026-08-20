#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:bubble
//
// THE OXYGEN BUBBLE as a physical object — see systems/oxygenBubble.js.
//
// The bubble used to be a position write: a ball that appeared in mid-water and
// travelled up at a constant speed until its timer ran out. Every number in it
// was safe because nothing could interfere with it. Now it has velocity, it has
// bodies pushing on it and it has a skin that can fail, and all three of those
// go wrong in ways that look completely fine at 60fps:
//
//   THE ARRIVAL   a bubble is born INSIDE the sand and swells out of it. If the
//                 swell is faster than a frame or two it is a pop-in again; if
//                 the birth point drifts off the seabed it is teleporting into
//                 open water again. Both read as "a bubble appeared".
//   THE RISE      buoyancy is a force now, not a speed. The failure is a bubble
//                 that never reaches its configured rise speed (too little
//                 lift) or that overshoots it and accelerates all the way to
//                 the surface. Neither is visible against a 14-second life.
//   THE KNOCK     one creature barging through must MOVE it and must not kill
//                 it. A toughness that survives nothing means bubbles vanish in
//                 a crowd for no reason the player can see; a toughness that
//                 survives everything means the pinch never happens.
//   THE PINCH     the whole design. Two bodies closing from opposite sides move
//                 the bubble NOWHERE and burst it. That falls out of
//                 `gross - |net|` in applyBodyShoves, which means it is exactly
//                 the kind of arithmetic that can silently become "any two
//                 creatures nearby" or "never".
//   THE TARGET    a half-grown bubble is a smaller thing to swim into, and the
//                 collect test in pickups.js widens by bubbleRadius(). If those
//                 two ever disagree the pickup refuses to be taken from the
//                 place it visibly is.
//
// Everything expected is derived from CONFIG, not typed in — saved tuning is
// merged over the defaults at import, so a hardcoded 2.6 would be asserting on
// imported-tuning.json instead of on the code.
//
// What it cannot tell you: whether the film LOOKS like a bubble. That is
// tools/looks/pickups.html.
//
//   node --import ./tools/vite-loader.mjs tools/oxygen-bubble-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { bounds, seabedTopY } from '../path/src/arena.js';
import {
  initBubble, updateBubblePhysics, bubbleRadius, bubbleBirthPoint, growthOf,
} from '../path/src/systems/oxygenBubble.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const C = CONFIG.oxygen.bubble;
const DT = 1 / 60;

// Seeded, like every other spawn harness here: `initBubble` takes its sway
// phase and rate from a random, and an assertion about where a bubble drifts
// has to be an assertion about the same bubble every run.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEEDS = [1, 7, 13, 42, 99];

// A bubble with no renderer behind it. `assetRadius` is what pickups.js reads
// off the asset table; the harness states it rather than importing assets.js,
// because a change to the ART should not silently retune this file's numbers.
const ASSET_RADIUS = 0.44;
function makeBubble(x, y, rand = Math.random, scale = 2.84) {
  const orb = {
    mesh: new THREE.Object3D(),
    life: CONFIG.oxygen.bubbleLifetime,
    assetRadius: ASSET_RADIUS,
  };
  orb.mesh.position.set(x, y, 0);
  orb.mesh.scale.setScalar(scale);
  initBubble(orb, rand);
  return orb;
}

// A creature, as the physics sees one: a position, a hitbox and a velocity.
function body(x, y, radius, vx = 0, vy = 0) {
  const m = new THREE.Object3D();
  m.position.set(x, y, 0);
  return { mesh: m, radius, vx, vy };
}

console.log('Oxygen bubble — merged config');
console.log(`  growTime ${C.growTime}s · lift ${C.lift} · toughness ${C.toughness} · pinchMul ${C.pinchMul}`);
console.log(`  rise ${CONFIG.oxygen.bubbleRiseSpeed} u/s · seabed top y=${seabedTopY().toFixed(2)}`);

// ===========================================================================
section('The arrival — it comes out of the floor');
{
  for (const seed of SEEDS.slice(0, 3)) {
    const p = bubbleBirthPoint(mulberry32(seed));
    const insideX = p.x >= bounds.left && p.x <= bounds.right;
    check(`seed ${seed}: born on the seabed, inside the arena`,
      insideX && Math.abs(p.y - seabedTopY()) <= 0.5,
      `x=${p.x.toFixed(1)} y=${p.y.toFixed(2)}`);
  }

  const orb = makeBubble(0, seabedTopY() - C.birthDepth, mulberry32(1));
  check('it starts as a sliver, not at full size',
    growthOf(orb) < 0.12, `${(growthOf(orb) * 100).toFixed(1)}% on frame 0`);

  // The swell has to be long enough to READ. Under about a third of a second
  // and it is a pop-in with extra steps.
  let framesToHalf = 0;
  let framesToFull = 0;
  for (let i = 0; i < 60 * 6; i++) {
    updateBubblePhysics(DT, orb);
    if (!framesToHalf && growthOf(orb) >= 0.5) framesToHalf = i + 1;
    if (!framesToFull && (orb.grow ?? 0) >= 1) framesToFull = i + 1;
  }
  check('the swell takes long enough to be an event',
    framesToHalf >= 12, `half size after ${framesToHalf} frames (${(framesToHalf * DT).toFixed(2)}s)`);
  check('...and finishes on its configured clock',
    Math.abs(framesToFull * DT - C.growTime) < 0.05,
    `full after ${(framesToFull * DT).toFixed(2)}s, growTime ${C.growTime}s`);
  check('a full bubble is a genuinely big target',
    bubbleRadius(orb) > 1, `${bubbleRadius(orb).toFixed(2)} world units of radius`);
}

// ===========================================================================
section('The rise — gently, and to the speed it says');
{
  const rise = CONFIG.oxygen.bubbleRiseSpeed;
  for (const seed of SEEDS.slice(0, 3)) {
    const orb = makeBubble(0, seabedTopY(), mulberry32(seed));
    let maxV = 0;
    for (let i = 0; i < 60 * 4; i++) {
      updateBubblePhysics(DT, orb);
      maxV = Math.max(maxV, orb.vy);
    }
    check(`seed ${seed}: settles at the configured rise speed`,
      Math.abs(orb.vy - rise) < rise * 0.06, `${orb.vy.toFixed(2)} vs ${rise}`);
    check(`seed ${seed}: never accelerates past it`,
      maxV <= rise * 1.02, `peak ${maxV.toFixed(2)}`);
  }

  // The wander has to exist and has to stay small. A bubble that drifts metres
  // sideways is steering; one that drifts nothing is on a rail.
  const drifts = SEEDS.map((seed) => {
    const orb = makeBubble(0, seabedTopY(), mulberry32(seed));
    for (let i = 0; i < 60 * 8; i++) updateBubblePhysics(DT, orb);
    return Math.abs(orb.mesh.position.x);
  });
  const avgDrift = drifts.reduce((a, b) => a + b, 0) / drifts.length;
  check('it wanders sideways as it goes up',
    avgDrift > 0.15, `${avgDrift.toFixed(2)} units over 8s (${drifts.map((d) => d.toFixed(2)).join(', ')})`);
  check('...without steering across the arena',
    avgDrift < 4, `${avgDrift.toFixed(2)} units`);

  // Left alone it must reach the surface and STAY there, not burst on arrival:
  // a breath that destroys itself the moment it is reachable is a pickup with
  // an invisible timer.
  const orb = makeBubble(0, seabedTopY(), mulberry32(7));
  let popped = null;
  for (let i = 0; i < 60 * 60; i++) {
    popped = updateBubblePhysics(DT, orb) || popped;
  }
  check('an undisturbed bubble never bursts on its own', popped === null, popped ?? 'survived a minute');
  check('...and holds station just under the surface',
    orb.mesh.position.y < bounds.surfaceY && orb.mesh.position.y > bounds.surfaceY - 2,
    `y=${orb.mesh.position.y.toFixed(2)}`);
}

// ===========================================================================
section('The knock — one creature barges through');
{
  // A shark-sized body crossing the bubble left to right, at a shark's cruise.
  // It must MOVE the bubble a visible distance and must NOT burst it: being
  // shoved is the ordinary case and bursting is the exception.
  const results = [];
  for (const seed of SEEDS) {
    // Same control-run discipline as the nudge below — a bubble out-drifts any
    // shove you try to measure from where it started.
    const orb = makeBubble(0, seabedTopY() + 6, mulberry32(seed));
    const control = makeBubble(0, seabedTopY() + 6, mulberry32(seed));
    for (let i = 0; i < 60 * 2; i++) { // grown
      updateBubblePhysics(DT, orb);
      updateBubblePhysics(DT, control);
    }
    let worstSkin = 1;
    let popped = null;
    const b = body(-4, orb.mesh.position.y, 1.2, 7, 0);
    for (let i = 0; i < 60 * 2; i++) {
      b.mesh.position.x += b.vx * DT;
      popped = updateBubblePhysics(DT, orb, [b]) || popped;
      updateBubblePhysics(DT, control);
      worstSkin = Math.min(worstSkin, orb.skin);
      if (popped) break;
    }
    results.push({ moved: orb.mesh.position.x - control.mesh.position.x, worstSkin, popped });
  }
  const moved = results.reduce((a, r) => a + r.moved, 0) / results.length;
  const worst = Math.min(...results.map((r) => r.worstSkin));
  check('a single barge shoves the bubble aside',
    moved > 0.5, `${moved.toFixed(2)} units downrange on average`);
  check('...and it survives',
    results.every((r) => !r.popped), `worst skin left: ${worst.toFixed(2)}`);
  check('...but it is visibly marked by it',
    worst < 0.9, `skin fell to ${worst.toFixed(2)}`);
  // ...and not so marked that a second creature anywhere near it is a death
  // sentence. A bubble that survives one barge on paper and bursts on the next
  // frame of an ordinary fight reads as bubbles randomly disappearing.
  check('...with room left for a second one',
    worst > 0.3, `skin fell to ${worst.toFixed(2)}`);

  // A creature asleep inside the bubble still has to move it, or a bubble
  // rising into a resting crab passes straight through the crab.
  //
  // MEASURED AGAINST A CONTROL RUN, not against where it started. The bubble
  // wanders on its own — that is the point of `sway` — and over three quarters
  // of a second the wander is bigger than the nudge being measured. An
  // identically seeded bubble with nothing near it is the only honest zero.
  const orb = makeBubble(0, seabedTopY() + 6, mulberry32(3));
  const control = makeBubble(0, seabedTopY() + 6, mulberry32(3));
  for (let i = 0; i < 60 * 2; i++) {
    updateBubblePhysics(DT, orb);
    updateBubblePhysics(DT, control);
  }
  const still = body(orb.mesh.position.x + 0.2, orb.mesh.position.y, 1.0, 0, 0);
  for (let i = 0; i < 45; i++) {
    updateBubblePhysics(DT, orb, [still]);
    updateBubblePhysics(DT, control);
  }
  const nudged = control.mesh.position.x - orb.mesh.position.x;
  check('a motionless body still pushes it out of the way',
    nudged > 0.05, `${nudged.toFixed(3)} units clear of an untouched twin, in 0.75s`);
}

// ===========================================================================
section('The pinch — squeezed between two bodies');
{
  // The same creature as above, plus one closing from the other side. The
  // bubble goes NOWHERE and bursts. If this ever passes for a single body, the
  // pinch has become "a creature is nearby".
  const outcomes = [];
  for (const seed of SEEDS) {
    const orb = makeBubble(0, seabedTopY() + 6, mulberry32(seed));
    for (let i = 0; i < 60 * 2; i++) updateBubblePhysics(DT, orb);
    const y = orb.mesh.position.y;
    const left = body(orb.mesh.position.x - 4, y, 1.2, 7, 0);
    const right = body(orb.mesh.position.x + 4, y, 1.2, -7, 0);
    const startX = orb.mesh.position.x;
    let popped = null;
    let frames = 0;
    for (let i = 0; i < 60 * 3; i++) {
      left.mesh.position.x += left.vx * DT;
      right.mesh.position.x += right.vx * DT;
      popped = updateBubblePhysics(DT, orb, [left, right]) || popped;
      frames = i + 1;
      if (popped) break;
    }
    outcomes.push({ popped, frames, slid: Math.abs(orb.mesh.position.x - startX) });
  }
  check('a two-sided squeeze bursts it, every time',
    outcomes.every((o) => o.popped === 'popped'),
    outcomes.map((o) => o.popped ?? 'survived').join(', '));
  const t = outcomes.reduce((a, o) => a + o.frames, 0) / outcomes.length * DT;
  check('...quickly enough to read as a burst, not as attrition',
    t < 1.5, `${t.toFixed(2)}s from contact`);
  const slid = outcomes.reduce((a, o) => a + o.slid, 0) / outcomes.length;
  check('...and the squeeze moves it almost nowhere',
    slid < 1.2, `${slid.toFixed(2)} units of travel before it went`);
}

// ===========================================================================
section('The skin heals — a bubble bumped twice, far apart, lives');
{
  const orb = makeBubble(0, seabedTopY() + 4, mulberry32(11));
  for (let i = 0; i < 60 * 2; i++) updateBubblePhysics(DT, orb);
  let popped = null;
  for (let pass = 0; pass < 3; pass++) {
    const b = body(orb.mesh.position.x - 4, orb.mesh.position.y, 1.2, 7, 0);
    for (let i = 0; i < 60; i++) {
      b.mesh.position.x += b.vx * DT;
      popped = updateBubblePhysics(DT, orb, [b]) || popped;
    }
    // Two seconds of nothing between barges.
    for (let i = 0; i < 120; i++) popped = updateBubblePhysics(DT, orb) || popped;
  }
  check('three separate barges do not add up to a burst', popped === null, popped ?? 'survived');
  check('...because the skin recovers between them',
    orb.skin > 0.85, `back to ${orb.skin.toFixed(2)}`);
}

// ===========================================================================
section('The target — a half-grown bubble is a smaller thing to swim into');
{
  const orb = makeBubble(0, seabedTopY(), mulberry32(5));
  const sizes = [];
  for (let i = 0; i < 60 * 2; i++) {
    updateBubblePhysics(DT, orb);
    if (i % 12 === 0) sizes.push(bubbleRadius(orb));
  }
  let monotone = true;
  // Up to the overshoot, which settles back — so the claim is about the first
  // half of the swell, where the player is deciding whether to swim for it.
  for (let i = 1; i < 4; i++) if (sizes[i] <= sizes[i - 1]) monotone = false;
  check('the collectable radius grows with the visible one', monotone,
    sizes.slice(0, 5).map((s) => s.toFixed(2)).join(' → '));

  // And the mesh the player sees agrees with the number the collect test uses.
  // These are computed in two different functions and nothing links them.
  const drawn = (orb.mesh.scale.x + orb.mesh.scale.y) / 2 * ASSET_RADIUS;
  check('the drawn skin and the hit radius are the same object',
    Math.abs(drawn - bubbleRadius(orb)) < bubbleRadius(orb) * 0.15,
    `drawn ${drawn.toFixed(2)} vs hit ${bubbleRadius(orb).toFixed(2)}`);
}

// ===========================================================================
section('The walls — it cannot leave the arena or sink into the sand');
{
  const orb = makeBubble(bounds.right - 1, seabedTopY() + 2, mulberry32(9));
  for (let i = 0; i < 60 * 2; i++) updateBubblePhysics(DT, orb);
  // Driven hard into the right wall by a fast body.
  const b = body(orb.mesh.position.x - 3, orb.mesh.position.y, 1.4, 14, 0);
  let inside = true;
  for (let i = 0; i < 90; i++) {
    b.mesh.position.x += b.vx * DT;
    updateBubblePhysics(DT, orb, [b]);
    if (orb.mesh.position.x > bounds.right + 0.01) inside = false;
  }
  check('it never leaves through the arena wall', inside,
    `stopped at x=${orb.mesh.position.x.toFixed(2)}, wall at ${bounds.right}`);

  const sunk = makeBubble(0, seabedTopY() + 0.2, mulberry32(4));
  sunk.vy = -8;
  let above = true;
  for (let i = 0; i < 60; i++) {
    updateBubblePhysics(DT, sunk);
    if (sunk.mesh.position.y < seabedTopY() - 0.01) above = false;
  }
  check('it never sinks through the seabed', above,
    `held at y=${sunk.mesh.position.y.toFixed(2)}, floor at ${seabedTopY().toFixed(2)}`);
}

// ===========================================================================
console.log(`\n${failures === 0 ? 'All good.' : `${failures} failure(s).`}`);
process.exit(failures === 0 ? 0 : 1);
