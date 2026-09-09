// ============================================================================
// THE DRAWN EDGE IS THE HITBOX — the two shapes a Blubberball contact is made
// of, and the arithmetic that finds them.
//
// The ball collided as a circle of `radius` and DREW as a goo isosurface, and
// the two were never the same thing: measured on the shipped numbers the goo
// body's edge sits at 4.87 world units and the circle at 2.8, so two units of
// visible ball were not there to be hit. A seal's nose crossed the ball, went
// on crossing it for most of a body length, and only then did anything
// happen. That is a bug no amount of tuning either number could fix, because
// they were tuned in different files against different pictures.
//
// So there is ONE description of the ball's body now, and it is the one the
// renderer uses: `ballSplats` says where the splats go, versus.js's
// `renderBall` writes exactly those into the driven slots, and
// `solveBallSurface` finds where the goo pass's isoline falls through exactly
// those. The hitbox is that isoline. Retune the look and the hitbox follows
// on the next frame; there is no second number to keep in step, because there
// is no second number.
//
// WHY THE FIELD CAN BE SOLVED ON THE CPU AT ALL. The splat is a closed form —
// entities/particles.js's gooFragmentShader is (1 - d)^3 over d = (r/R)^2,
// zero past R — and a driven slot is written at age 0 with life 1, so its
// `vAlpha` is exactly 1 and its point size exactly `size * uGooRadius`. There
// is nothing in the shader's answer that is not in the few lines below, which
// is why this is a mirror rather than an approximation of one.
//
// WHAT IT DOES NOT INCLUDE: the screen-space warp and the outline's boil.
// Both are measured in TEXELS and both displace where a pixel READS the field
// rather than moving the field — see the uniform notes in systems/post.js.
// They wobble the drawn line by a pixel or two around this isoline, which is
// the whole point of them, and a hitbox that chased a per-pixel wobble would
// be a hitbox that changed with the window size.
//
// WHY IT IS NOT IN versus.js. Two callers need these shapes and only one of
// them owns the ball: systems/versusBot.js steers to the distance at which a
// touch happens, and a bot reading a different number from the contact is a
// bot that hovers just outside the ball forever. Same argument as ballLook.js
// — the module takes the ball as an argument and reads CONFIG, so it can be
// driven from a harness with no match running.
// ============================================================================

import { CONFIG } from '../config.js';

const cfg = () => CONFIG.versus ?? {};

// The splat set, in the BALL'S OWN FRAME (renderBall adds ball.x/ball.y).
// Rebuilt in place: this is read once a frame on the hot path and has no
// business allocating.
const _splats = [];

/** The goo group's splat diameter multiplier — the shader's `uGooRadius`. */
export function gooSplatMul() {
  const goo = CONFIG.fx?.goo ?? {};
  return goo.groups?.ball?.radius ?? goo.radius ?? 3.4;
}

/** Where the surface is, in accumulated density — the group's own isoline. */
export function gooIso() {
  const goo = CONFIG.fx?.goo ?? {};
  return goo.groups?.ball?.iso ?? goo.iso ?? 0.9;
}

/**
 * Where the ball's splats go this frame. THE description of the drawn body.
 *
 * `rimRadius(i)` is the soft body's radius at sample i and `rimAngle(i)` its
 * world angle — versus.js owns both, and they are passed rather than imported
 * so this file never has to know a match exists.
 *
 * EVERY NUMBER IS A SHARE OF THE BALL'S OWN RADIUS, which is what makes the
 * arrangement scale-free: change CONFIG.versus.ball.radius and the drawn body
 * and the hitbox both follow, and changing the goo group's `radius` uniform —
 * which is a splat's diameter in units of the particle's `size` — no longer
 * silently resizes the ball. The conversion back into the shader's units is
 * `splatSize` below, and it is the only place the two meet.
 */
export function ballSplats(ball, rimRadius, rimAngle, out = _splats) {
  const sp = cfg().ball?.splats ?? {};
  const n = ball.rim.length;
  const inner = Math.max(4, Math.round(n / 3));
  out.length = 0;
  out.push({ x: 0, y: 0, r: (sp.core ?? 1.5) * ball.r });
  const innerAt = sp.innerAt ?? 0.5;
  for (let i = 0; i < inner; i++) {
    const j = Math.round((i / inner) * n) % n;
    const a = rimAngle(j);
    const rad = (rimRadius(j) - ball.r) * 0.5 + ball.r * innerAt;
    out.push({ x: Math.cos(a) * rad, y: Math.sin(a) * rad, r: (sp.inner ?? 1.1) * ball.r });
  }
  const ring = sp.ring ?? 1.15;
  for (let i = 0; i < n; i++) {
    const a = rimAngle(i);
    const rad = rimRadius(i) * ring;
    out.push({ x: Math.cos(a) * rad, y: Math.sin(a) * rad, r: (sp.rim ?? 0.826) * ball.r });
  }
  return out;
}

/**
 * A splat's `size` attribute, from its world radius: the shader draws a point
 * of diameter `size * uGooRadius`, so a splat of world radius R is written as
 * 2R / uGooRadius. renderBall's only arithmetic, and the reason nothing else
 * has to know the goo pass's units.
 */
export function splatSize(worldRadius) {
  return (2 * worldRadius) / Math.max(1e-6, gooSplatMul());
}

/** The accumulated density at a point in the ball's frame — the goo shader's splat, summed. */
export function gooDensity(splats, x, y) {
  let s = 0;
  for (let i = 0; i < splats.length; i++) {
    const p = splats[i];
    const dx = x - p.x;
    const dy = y - p.y;
    const d = (dx * dx + dy * dy) / (p.r * p.r);
    if (d >= 1) continue;
    const f = 1 - d;
    s += f * f * f;
  }
  return s;
}

/**
 * Where the isoline crosses the ray leaving the centre at `angle`, by
 * bisection. `hi` starts outside every splat, so the bracket is always valid:
 * the density out there is zero by construction, not by hope.
 */
export function isolineAlong(splats, angle, iso, hi) {
  const ax = Math.cos(angle);
  const ay = Math.sin(angle);
  let lo = 0;
  for (let i = 0; i < 20; i++) {
    const m = (lo + hi) * 0.5;
    if (gooDensity(splats, ax * m, ay * m) > iso) lo = m;
    else hi = m;
  }
  return lo;
}

/**
 * Re-solve the drawn surface into `ball.surf`, one sample per rim point.
 * Called once a frame, right after the soft body has stepped and before
 * anything collides with it — so what the frame hits is exactly the
 * silhouette the frame draws, not last frame's.
 */
export function solveBallSurface(ball, rimRadius, rimAngle) {
  const n = ball.surf?.length ?? 0;
  if (!n) return ball.surf;
  const splats = ballSplats(ball, rimRadius, rimAngle);
  const iso = gooIso();
  let hi = 0;
  for (const p of splats) hi = Math.max(hi, Math.hypot(p.x, p.y) + p.r);
  hi *= 1.01;
  for (let i = 0; i < n; i++) ball.surf[i] = isolineAlong(splats, rimAngle(i), iso, hi);
  return ball.surf;
}

// A stand-in body for the questions that have to be answered before a match
// exists — how deep the goal line can be, what the bot should leave itself.
// Rim offsets of zero, so it is the ball at rest.
const _restBall = { r: 1, angle: 0, rim: new Float32Array(24), surf: null };

/**
 * THE WIDEST THE BALL EVER COLLIDES, in world units: the rest isoline of a
 * body inflated by the full velocity stretch. Deliberately the OUTER bound —
 * the real stretched body is a prolate shape and this is the sphere around it
 * — because the one caller is a clamp, and a clamp that under-estimates the
 * ball is a goal line the ball can never reach.
 */
export function ballMaxRadius() {
  const c = cfg().ball ?? {};
  const r = c.radius ?? 2.8;
  const swell = r * (1 + (c.soft?.stretch ?? 0.47));
  _restBall.r = r;
  const rimRadius = () => swell;
  const rimAngle = (i) => (i / _restBall.rim.length) * Math.PI * 2;
  const splats = ballSplats(_restBall, rimRadius, rimAngle);
  let hi = 0;
  for (const p of splats) hi = Math.max(hi, Math.hypot(p.x, p.y) + p.r);
  return isolineAlong(splats, 0, gooIso(), hi * 1.01);
}

/** The drawn edge of an undented, unstretched ball — its size at rest, in world units. */
export function ballRestRadius() {
  const c = cfg().ball ?? {};
  const r = c.radius ?? 2.8;
  _restBall.r = r;
  const rimRadius = () => r;
  const rimAngle = (i) => (i / _restBall.rim.length) * Math.PI * 2;
  const splats = ballSplats(_restBall, rimRadius, rimAngle);
  let hi = 0;
  for (const p of splats) hi = Math.max(hi, Math.hypot(p.x, p.y) + p.r);
  return isolineAlong(splats, 0, gooIso(), hi * 1.01);
}

/**
 * THE RADIUS THE BALL COLLIDES AT, toward a WORLD angle: the drawn edge, in
 * that direction. Between samples exactly as versus.js's rimRadiusAt
 * interpolates the rim, and for the same reason — a contact does not land on
 * a sample.
 *
 * The pinch is in here for free and must NOT be applied on top: rimRadius
 * already flattens the body along the pinch's axis, so a squeezed ball
 * collides as the ELLIPSE it is drawn as rather than as a shrinking circle.
 * That is the shape that gets through a gap narrower than the ball, which is
 * what the pinch was for.
 */
export function ballHitRadiusAt(ball, angle) {
  const n = ball.surf?.length ?? 0;
  if (!n) return ball.r;
  const TAU = Math.PI * 2;
  let u = ((angle - ball.angle) / TAU) * n;
  u = ((u % n) + n) % n;
  const i0 = Math.floor(u);
  const i1 = (i0 + 1) % n;
  const f = u - i0;
  return ball.surf[i0] * (1 - f) + ball.surf[i1] * f;
}

/** The widest the drawn body reaches — a broad phase, and the one number anything else wants. */
export function ballHitRadius(ball) {
  const n = ball.surf?.length ?? 0;
  if (!n) return ball.r;
  let max = 0;
  for (let i = 0; i < n; i++) if (ball.surf[i] > max) max = ball.surf[i];
  return max;
}

// ---------------------------------------------------------------------------
// THE SEAL'S BODY — see CONFIG.versus.ball.body for where the numbers came
// from. The animal is a CAPSULE: a segment down its spine from tail to nose
// with its own half-thickness around it, which is what makes a nose-first
// arrival reach further than a flank. It was a circle around the seal's
// middle, and a circle cannot say that in either direction.
// ---------------------------------------------------------------------------

/** Which way a seal's nose points, in world radians. The art's forward is +Y. */
export function sealHeading(seal) {
  const rz = seal?.mesh?.rotation?.z;
  return typeof rz === 'number' ? rz + Math.PI / 2 : null;
}

/**
 * The point on the seal's spine nearest (toX, toY), and the half-thickness
 * around it. Written into `out` rather than returned fresh: this runs twice a
 * frame for the whole of a match.
 */
export function sealSpine(pos, heading, toX, toY, out) {
  const b = cfg().ball?.body ?? {};
  const thick = Math.max(0.01, b.thickness ?? 0.69);
  let hx = 0;
  let hy = 0;
  if (heading != null) { hx = Math.cos(heading); hy = Math.sin(heading); }
  // Shortened by the thickness at each end, so the CAPSULE's extent is the
  // animal's — a segment that already ran to the nose would put half a body
  // thickness of seal out in front of the nose.
  const nose = Math.max(0, (b.nose ?? 3.31) - thick);
  const tail = Math.max(0, (b.tail ?? 2.82) - thick);
  let t = hx * (toX - pos.x) + hy * (toY - pos.y);
  t = Math.max(-tail, Math.min(nose, t));
  out.x = pos.x + hx * t;
  out.y = pos.y + hy * t;
  out.r = thick;
  return out;
}

/**
 * The heading a contact should use for a seal. The mesh's when there is one;
 * a seal with no body — a harness, the ball lab's invented striker — is taken
 * to be pointed the way it is swimming, and a stationary one at the ball. The
 * two fallbacks are what make a bare {x, y} striker behave like a seal
 * arriving rather than like a sphere.
 */
export function contactHeading(ball, pos, vel, heading) {
  if (heading != null) return heading;
  if (vel && (Math.abs(vel.x) > 1e-3 || Math.abs(vel.y) > 1e-3)) return Math.atan2(vel.y, vel.x);
  return Math.atan2(ball.y - pos.y, ball.x - pos.x);
}

/**
 * How far from the ball's CENTRE a seal arriving along `angle` first touches
 * it, nose-on. What the bot steers to and what the labs draw — one answer,
 * from the same two shapes the contact itself uses.
 */
export function ballContactReach(ball, angle = 0) {
  const b = cfg().ball?.body ?? {};
  return ballHitRadiusAt(ball, angle) + Math.max(b.nose ?? 3.31, b.thickness ?? 0.69);
}
