// ---------------------------------------------------------------------------
// THE TURN — the score card flips over to show the run's breakdown.
//
// The front is the screen the game has always ended on: the quip, the five
// figures, the roll of kill shots, the board and the way out. The back is what
// the playtest recorder saw — damage by weapon, damage taken, the chain. One
// object, two faces, the way you turn a photograph over to read what somebody
// wrote on the back of it.
//
// THREE THINGS SELL IT, and they are separate systems because they fail
// separately:
//
//   THE EMULSION  a specular sweep across the black slab, positioned from the
//                 flip angle. Two custom properties, written once a frame while
//                 the card is moving. The CSS in ui.js does the rest.
//   THE EDGE      a baked noise mask on each face — ui/wornEdge.js. Static, and
//                 nothing to do with this file except that a resize has to
//                 re-bake it.
//   THE BUBBLES   particles off the edge that is sweeping forward, on a canvas
//                 of this module's own. NOT entities/particles.js: that draws
//                 in the world, behind a DOM card that is covering it, and it
//                 has two writers already.
//
// THE HALFWAY SWAP IS THE PART THAT MATTERS. `backface-visibility` hides the
// off-face from the eye and from nothing else: it is still in the layout, still
// focusable, and still passes the `.sv-hidden` test that ui.js's pad cursor
// filters on. A controller player would walk onto buttons on the far side of a
// card and the highlight would simply vanish — on the one screen that has to
// get them back into a game. So the off-face gets `.sv-hidden` applied for
// real, at the moment the card passes 90 degrees, and the cursor list rebuilds
// itself around that on its next frame because it is rebuilt every frame.
//
// REDUCED MOTION TAKES THE WHOLE THING. No rotation, no sweep, no bubbles —
// the faces just swap. A flip is a rotation and a particle burst, which is
// exactly what the preference is about; there is no reduced version of it worth
// having, and a card that swaps instantly is a perfectly good card.
// ---------------------------------------------------------------------------

import { CONFIG } from '../config.js';
import { prefersReducedMotion } from '../devices.js';

function cfg() {
  return CONFIG.death?.flip ?? {};
}

function bub() {
  return cfg().bubbles ?? {};
}

// One turn at a time — there is one score card. Held at module scope rather
// than returned so a restart can stop it without the caller keeping a handle.
let live = null;

/**
 * Mount the turn on a card.
 *
 * @param card    the rotating element. Owns the transform and the two custom
 *                properties; the caller owns everything else about it.
 * @param front   the face that is up when the card arrives.
 * @param back    the other one.
 * @param water   where the bubble canvas goes — an element the card sits inside
 *                and that is big enough for bubbles to leave the card. The
 *                menu's own centring layer, in practice.
 * @returns { flip, face, reset } — `flip()` turns it over, `face()` says which
 *          way up it is, `reset()` puts it back to the front with no animation.
 */
export function mountCardFlip({ card, front, back, water }) {
  if (!card || !front || !back) return null;
  releaseCardFlip();

  const state = {
    card, front, back, water,
    angle: 0,
    target: 0,
    raf: 0,
    last: 0,
    bubbles: [],
    canvas: null,
    ctx: null,
  };
  live = state;

  // Face visibility set for the starting pose before anything can be measured
  // — the back must not be a pad stop on the frame the card opens.
  applyFaces(state);
  paint(state);
  return {
    flip: () => turn(state, state.target === 0 ? 180 : 0),
    face: () => (state.target === 0 ? 'front' : 'back'),
    reset: () => hardReset(state),
  };
}

/** Stop the turn and drop its canvas. Called when the card goes away. */
export function releaseCardFlip() {
  if (!live) return;
  cancelAnimationFrame(live.raf);
  live.canvas?.remove();
  live = null;
}

/** True while the card is not square to the viewer — the pad uses it. */
export function cardFlipMoving() {
  return !!live && live.angle !== live.target;
}

function hardReset(state) {
  cancelAnimationFrame(state.raf);
  state.raf = 0;
  state.angle = 0;
  state.target = 0;
  state.bubbles.length = 0;
  state.canvas?.remove();
  state.canvas = null;
  state.ctx = null;
  applyFaces(state);
  paint(state);
}

function turn(state, to) {
  if (state.target === to) return;
  state.target = to;

  if (prefersReducedMotion() || cfg().enabled === false) {
    state.angle = to;
    applyFaces(state);
    paint(state);
    return;
  }

  ensureCanvas(state);
  burst(state);
  if (!state.raf) {
    state.last = performance.now();
    state.raf = requestAnimationFrame(() => frame(state));
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------
// THE LOOP CANNOT BE ALLOWED TO THROW. It is driving the only route back into
// the game: a card that stops mid-turn is a player looking at the edge of a
// rectangle with no controls on either side of it and no way to restart. So the
// whole frame is wrapped, and anything that goes wrong ends the turn HONESTLY —
// snapped to the face it was heading for, canvas dropped, one line in the
// console. The bubbles are the part most likely to do it (a lost or stubbed 2D
// context), and they are also the part nothing depends on.
function frame(state) {
  try {
    tick(state);
  } catch (err) {
    warnFlipFailed(err);
    state.angle = state.target;
    applyFaces(state);
    paint(state);
    cancelAnimationFrame(state.raf);
    state.raf = 0;
    state.bubbles.length = 0;
    state.canvas?.remove();
    state.canvas = null;
    state.ctx = null;
  }
}

let warnedFlip = false;
function warnFlipFailed(err) {
  if (warnedFlip) return;
  warnedFlip = true;
  console.warn(`[cardFlip] the turn could not finish and was snapped to its far face — ${err}`);
}

function tick(state) {
  // Off performance.now() rather than the timestamp rAF hands in, for the same
  // reason runReveal is: only one of those is guaranteed to be the clock
  // `last` was read from, and a turn measured across two clocks either
  // finishes instantly or never finishes at all.
  const t = performance.now();
  const dt = Math.min(0.05, (t - state.last) / 1000);
  state.last = t;

  const was = state.angle;
  const rate = cfg().rate ?? 8.5;
  state.angle += (state.target - state.angle) * Math.min(1, dt * rate);
  if (Math.abs(state.target - state.angle) < 0.05) state.angle = state.target;
  const moving = Math.abs(state.angle - was) > 0.02;

  // The face swap happens on the frame the card crosses 90, which is also the
  // frame the eye stops being able to see the old face. Crossing it is checked
  // against the PREVIOUS angle rather than tested every frame, so the classes
  // are written twice per turn instead of sixty times.
  if (crossedHalfway(was, state.angle)) applyFaces(state);

  paint(state);
  if (moving) emit(state, dt);
  step(state, dt);

  if (state.angle !== state.target || state.bubbles.length) {
    state.raf = requestAnimationFrame(() => frame(state));
  } else {
    // Landed, and the last bubble is gone. The canvas is dropped rather than
    // left empty: it is a full-menu compositing layer, and the score screen is
    // then sat on for as long as it takes somebody to type their name.
    state.raf = 0;
    state.canvas?.remove();
    state.canvas = null;
    state.ctx = null;
  }
}

function crossedHalfway(from, to) {
  return (from < 90) !== (to < 90);
}

function applyFaces(state) {
  const showBack = state.angle >= 90;
  state.front.classList.toggle('sv-hidden', showBack);
  state.back.classList.toggle('sv-hidden', !showBack);
}

// The emulsion's two inputs.
//
//   grazing  0 square to the viewer, 1 edge-on. Drives how strong the sheen is:
//            a slab of gloss catches the light hardest when it is tipped.
//   sheen    where the highlight sits across the face, 6%..94%. Walked by the
//            cosine so it travels with the turn instead of sitting still and
//            fading, which is what makes it read as a reflection rather than as
//            an element being animated.
function paint(state) {
  const rad = (state.angle * Math.PI) / 180;
  const gloss = cfg().gloss ?? {};
  state.card.style.setProperty('--sv-flip', `${state.angle}deg`);
  state.card.style.setProperty('--sv-grazing', Math.abs(Math.sin(rad)).toFixed(3));
  state.card.style.setProperty('--sv-sheen', `${(50 + Math.cos(rad) * (gloss.travel ?? 44)).toFixed(1)}%`);
}

// ---------------------------------------------------------------------------
// Bubbles
// ---------------------------------------------------------------------------
function ensureCanvas(state) {
  if (state.canvas || !state.water || bub().enabled === false) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'sv-flip-bubbles';
  canvas.setAttribute('aria-hidden', 'true');
  state.water.appendChild(canvas);
  const r = state.water.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  canvas.style.width = `${r.width}px`;
  canvas.style.height = `${r.height}px`;
  state.canvas = canvas;
  state.ctx = canvas.getContext('2d');
  state.dpr = dpr;
}

// WHERE THE EDGE IS. At angle a the card's visible half-width is its true half
// width times |cos a|, so both edges walk inward to nothing at 90 and back out
// again. Spawning from that moving line rather than from the card's resting
// edge is the whole difference between bubbles that are being pushed off a
// turning object and bubbles being sprayed from a fixed one.
function edges(state) {
  if (!state.canvas) return null;
  const c = state.card.getBoundingClientRect();
  const w = state.water.getBoundingClientRect();
  const half = (c.width / 2) * Math.abs(Math.cos((state.angle * Math.PI) / 180));
  return {
    cx: c.left + c.width / 2 - w.left,
    top: c.top - w.top,
    bottom: c.bottom - w.top,
    half,
  };
}

function spawn(state, x, top, bottom, dir, n) {
  const b = bub();
  for (let i = 0; i < n; i++) {
    state.bubbles.push({
      x: x + (Math.random() - 0.5) * 6,
      y: top + Math.random() * Math.max(1, bottom - top),
      vx: dir * ((b.spread ?? 30) * (0.4 + Math.random())),
      vy: -((b.rise ?? 34) * (0.5 + Math.random())),
      r: (b.size ?? 2.4) * (0.45 + Math.random() * 1.3),
      life: 0,
      max: (b.life ?? 1.1) * (0.6 + Math.random() * 0.8),
      wob: Math.random() * 6.283,
    });
  }
  const cap = b.max ?? 320;
  if (state.bubbles.length > cap) state.bubbles.splice(0, state.bubbles.length - cap);
}

// The continuous release, off the LEADING edge only — the one sweeping toward
// the viewer. It hands over to the other edge at 90, which is also where the
// faces swap, so the whole turn reads as one object passing through water
// rather than as two edges fizzing independently.
function emit(state, dt) {
  if (bub().enabled === false || prefersReducedMotion()) return;
  const e = edges(state);
  if (!e) return;
  // Peaks where the edge is moving fastest through the water and falls off as
  // the card comes square again.
  const speed = Math.abs(Math.sin((state.angle * Math.PI) / 180));
  const n = Math.round(dt * (bub().rate ?? 190) * (0.2 + speed));
  if (n <= 0) return;
  const forward = state.angle < 90 ? 1 : -1;
  const dir = state.target > state.angle ? forward : -forward;
  spawn(state, e.cx + dir * e.half, e.top, e.bottom, dir, n);
}

// One puff off both edges on the frame the turn starts, so the release has an
// attack. Without it the bubbles fade up out of nothing and the turn reads as
// beginning a moment after the card has already moved.
function burst(state) {
  if (bub().enabled === false || prefersReducedMotion()) return;
  const e = edges(state);
  if (!e) return;
  const n = bub().burst ?? 26;
  spawn(state, e.cx - e.half, e.top, e.bottom, -1, n);
  spawn(state, e.cx + e.half, e.top, e.bottom, 1, n);
}

function step(state, dt) {
  const ctx = state.ctx;
  if (!ctx) return;
  const b = bub();
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);

  const alive = [];
  for (const p of state.bubbles) {
    p.life += dt;
    if (p.life >= p.max) continue;
    p.wob += dt * 5;
    p.vy -= dt * (b.buoyancy ?? 26);
    p.vx *= 1 - Math.min(1, dt * (b.drag ?? 2.4));
    p.x += (p.vx + Math.sin(p.wob) * (b.wobble ?? 9)) * dt;
    p.y += p.vy * dt;

    const k = 1 - p.life / p.max;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, 6.2832);
    ctx.strokeStyle = `rgba(190,232,255,${(b.rim ?? 0.5) * k})`;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = `rgba(150,215,250,${(b.fill ?? 0.13) * k})`;
    ctx.fill();
    alive.push(p);
  }
  state.bubbles = alive;
}
