// ===========================================================================
// GOO SUCK — a splat that bursts, stalls, and is drawn back into the seal
// through a strange attractor.
// ===========================================================================
// The pickup blast leaves the pickup's own goo behind it (feedback 'pickupBlast',
// goo 'pickupGoo'). An ordinary goo burst is a closed form the shader solves:
// out, slow, melt. This one has three acts and only the first is ballistic:
//
//   1. THE BURST. The blobs leave the pickup at the emitter's speed and hit a
//      wall of drag (`burstDrag`) — they get a body-length out and stop dead in
//      the water. Heavy on purpose: the stop is what makes the pull read as a
//      pull rather than as the burst curving.
//   2. THE HOLD. Nothing, for `holdAt` seconds from the burst. A beat where the
//      goo just hangs there, coloured like the thing that went off.
//   3. THE SUCK. Each blob steers along a flow field toward the seal — a blend
//      of the game's three strange attractors (systems/attractors.js), sampled
//      where the blob is standing relative to the seal, with a radial pull that
//      rises as the blob closes. The field is what stops this being a straight
//      line: the blobs spiral, fold and lane their way in. The formulas CYCLE
//      (`cycle` seconds through Thomas, Lorenz, Aizawa) and BLEND across the
//      changeover (`blend`), so no two blasts draw the same path and a single
//      long suck visibly changes character partway.
//
// Reaching the seal, a blob is consumed: its slot goes back and a small tinted
// splat marks the swallow (`captureEmit`). One that never arrives — the seal
// dashed off — melts on its own clock (`life`) like any goo.
//
// HOW IT DRAWS. These are DRIVEN particle slots (entities/particles.js) — the
// same buffer, the same goo pass, the same look — with their positions written
// from here every frame. So the pickup goo group's surface in the F panel
// governs how these fuse and shade too; this file only decides where they are.
//
// Everything the eye can tune is CONFIG.fx.gooSuck, exposed as pills in the `
// tuner under Look & FX. Nothing here is gameplay: no damage, no fuel, no xp.
// ===========================================================================

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { attractorDeriv } from './attractors.js';
import {
  claimDriven, releaseDriven, writeDriven, flushDriven, gooGroupFor, gooGroupIndex, keepGooAlive,
  drivenColor, resolveTint, emit, setGooGroupOverride,
} from '../entities/particles.js';

const cfg = () => CONFIG.fx?.gooSuck ?? {};

// The blobs in flight. Plain objects, reused nowhere — a blast is a dozen of
// these and they live a few seconds.
const blobs = [];
// Where the seal is, written by main.js every frame. `set` guards the first
// frame of a run, before anyone has said.
const target = { x: 0, y: 0, set: false };
let time = 0;
// One id per blast, so the flock knows which blobs are ITS mass.
let nextBurst = 1;
const centroids = new Map();
// Which group carries a live isoline override right now, so it can be cleared
// the frame the last blob is gone (and on reset).
let overriddenGroup = null;

/**
 * THE FLOCK'S BALANCE at time t for a blast with `phase`: -1..1, the slow sine
 * that trades cohesion off against repulsion. Exported for the harness.
 */
export function flockBalance(t, phase, c = cfg()) {
  return Math.sin(2 * Math.PI * ((c.fluctHz ?? 0.7) * t + phase));
}

/** The order the cycle visits them. Fixed, so `blend` means the same thing every run. */
export const SUCK_SHAPES = ['thomas', 'lorenz', 'aizawa'];

// Per-shape span, the same numbers the bait ball uses and for the same reason
// (systems/baitBall.js, ATTRACTOR_SPAN): Lorenz lives at ±20 and Aizawa inside
// ±1, and a field sampled at the wrong scale is one lobe's worth of a constant
// push, not a shape.
const SPAN = { thomas: 1, lorenz: 5.5, aizawa: 0.45 };

const deriv = { x: 0, y: 0, z: 0 };
const centre = { x: 0, y: 0, z: 0 };
const flow = { x: 0, y: 0, z: 0 };
const weights = { thomas: 0, lorenz: 0, aizawa: 0 };
const scratchColor = new THREE.Color();

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function smooth(t) { t = clamp01(t); return t * t * (3 - 2 * t); }
function rand(range, fallback) {
  if (!Array.isArray(range)) return range ?? fallback;
  return range[0] + Math.random() * (range[1] - range[0]);
}

/** Tell the field where the seal is. Called once a frame from main.js. */
export function setGooSuckTarget(x, y) {
  target.x = x;
  target.y = y;
  target.set = true;
}

/**
 * HOW MUCH OF EACH FORMULA at cycle position `u` (0..1). Each enabled shape owns
 * an equal slice of the cycle and its weight is a raised-cosine window around
 * the slice's centre, `blend` cycle-fractions wide. Windows wider than a slice
 * overlap, which is the blend: at the changeover two formulas are both live and
 * the flow is their mix. Normalised to sum to 1, so widening the blend changes
 * the character of the mix and never its strength.
 *
 * Exported for the harness — it is the one piece of this that can be wrong in a
 * way nothing on screen would ever prove.
 */
export function suckWeights(u, c = cfg(), out = weights) {
  const on = SUCK_SHAPES.filter((s) => c.shapes?.[s] !== false);
  for (const s of SUCK_SHAPES) out[s] = 0;
  if (!on.length) return out;
  const n = on.length;
  // `blend` is the window's HALF-width as a share of the cycle. Never narrower
  // than half a slice, or there would be gaps in the cycle where no formula is
  // live and the flow collapses to the bare radial pull; at exactly half a
  // slice the windows meet edge to edge and the cuts are hard.
  const w = Math.max(1 / (2 * n), c.blend ?? 0.3);
  let sum = 0;
  let nearest = on[0];
  let nearestD = Infinity;
  u = ((u % 1) + 1) % 1;
  on.forEach((s, i) => {
    const centreU = (i + 0.5) / n;
    let d = Math.abs(u - centreU);
    if (d > 0.5) d = 1 - d;
    if (d < nearestD) { nearestD = d; nearest = s; }
    const wt = d < w ? 0.5 * (1 + Math.cos(Math.PI * d / w)) : 0;
    out[s] = wt;
    sum += wt;
  });
  // The seam between two hard-cut windows, where both read zero: the nearer
  // formula takes it whole rather than the first in the list.
  if (sum <= 1e-9) { out[nearest] = 1; return out; }
  for (const s of on) out[s] /= sum;
  return out;
}

/**
 * The blended flow at a point, in WORLD axes, unit-ish length. `rx, ry` are the
 * blob's offset from the seal in field units (world / fieldRadius); `rz` is the
 * blob's own hidden coordinate — the attractor's third axis, which is what
 * keeps two blobs at the same spot on screen from taking the same path.
 *
 * Each formula's flow has its value at the field's centre subtracted before it
 * is used, for the reason the bait ball gives: these systems carry a constant
 * push (Lorenz at its centre is a hard shove along one axis) and that push is
 * the same for every blob — a translation, not a shape. What is left is the
 * folding, which is the part worth seeing.
 */
function flowAt(rx, ry, rz, c, wts, out) {
  out.x = 0; out.y = 0; out.z = 0;
  const scale = c.scale ?? 3;
  for (const shape of SUCK_SHAPES) {
    const wt = wts[shape];
    if (wt <= 0) continue;
    const k = scale * (SPAN[shape] ?? 1);
    const params = shape === 'thomas' ? { b: c.thomasB ?? 0.19 }
      : shape === 'lorenz' ? { lift: c.lorenzLift ?? 25 }
        : { lift: c.aizawaLift ?? 0.8 };
    // The attractor's y is the world's depth (our hidden z), and its z is the
    // world's up — the same axis swap the bait ball uses, so a shape seen here
    // is the shape seen there.
    attractorDeriv(shape, rx * k, rz * k, ry * k, params, deriv);
    attractorDeriv(shape, 0, rz * k, 0, params, centre);
    const dx = deriv.x - centre.x;
    const dy = deriv.z - centre.z;
    const dz = deriv.y - centre.y;
    const len = Math.hypot(dx, dy, dz) || 1;
    out.x += (dx / len) * wt;
    out.y += (dy / len) * wt;
    out.z += (dz / len) * wt;
  }
  return out;
}

/**
 * Fire an emitter's goo as a suck burst instead of a ballistic one. Same
 * arguments feedback() would have handed emit(): the emitter's own count,
 * speed, size and palette, with `at.scale` / `sizeMul` / `speedMul` / `color`
 * honoured exactly as emit() honours them.
 *
 * Returns false when it could not — the feature is off, the emitter is unknown,
 * or the driven reserve is empty — so the caller can fall back to emit() and
 * the goo is never simply missing.
 */
export function spawnSuckGoo(emitterName, x, y, at = {}) {
  const c = cfg();
  if (c.enabled === false) return false;
  const def = CONFIG.emitters[emitterName];
  if (!def) return false;
  const count = Math.max(1, Math.round((def.count ?? 8) * (at.scale ?? 1) * (c.countMul ?? 1)));
  const slots = claimDriven(count);
  if (!slots.length) return false;

  // Its OWN goo group when the config names one that exists, so the isoline
  // can be animated without touching the swallow splat's surface; otherwise the
  // emitter's group, and the goo simply does not weld.
  const own = gooGroupIndex(c.group);
  const group = own > 0 ? { index: own, name: c.group } : gooGroupFor(emitterName);
  const tint = resolveTint(at.color);
  const speedMul = Math.max(0, at.speedMul ?? 1) * (c.burstSpeedMul ?? 1);
  const sizeMul = Math.max(0, at.sizeMul ?? 1);
  const cone = def.cone ?? 0;
  const baseAngle = Math.atan2(at.dirY ?? 0, at.dirX ?? 1);
  const life = Math.max(0.5, c.life ?? 4);
  // One phase per BLAST, not per blob: the whole splat rides the same point in
  // the formula cycle, so it reads as one body of goo moving under one law,
  // and the next blast opens somewhere else in the cycle.
  const phase = Math.random();
  const burst = nextBurst++;
  // Which way this blast orbits. Per blast, like the phase: a splat that
  // spiralled both ways at once would be two splats.
  const spin = Math.random() < 0.5 ? -1 : 1;

  for (const slot of slots) {
    const angle = cone > 0 ? baseAngle + (Math.random() - 0.5) * cone * 2 : Math.random() * Math.PI * 2;
    const speed = rand(def.speed, 6) * speedMul;
    blobs.push({
      slot,
      x, y,
      vx: Math.cos(angle) * speed + (at.vx ?? 0) * (def.inherit ?? 0),
      vy: Math.sin(angle) * speed + (at.vy ?? 0) * (def.inherit ?? 0),
      // The hidden axis, spread across the field so the blobs take different
      // lanes through the same formula.
      z: (Math.random() * 2 - 1) * (c.zSpread ?? 1),
      age: 0,
      life,
      size: rand(def.size, 0.15) * sizeMul,
      rgb: drivenColor(def, tint, new THREE.Color()),
      tint: tint ? tint.getHex() : null,
      group: group.index,
      groupName: group.name,
      phase,
      burst,
      spin,
      seed: Math.random(),
    });
  }
  keepGooAlive(group.name, life);
  return true;
}

/**
 * Step every blob. `dt` is the particle clock's dt (real time — the particles
 * do not slow with hit-stop, and these are particles).
 */
export function updateGooSuck(dt) {
  if (!blobs.length) return;
  time += dt;
  const c = cfg();
  const cycle = Math.max(0.5, c.cycle ?? 6);
  const hold = Math.max(0, c.holdAt ?? 0.35);
  const ramp = Math.max(0.01, c.rampTime ?? 0.8);
  const capture = Math.max(0.05, c.captureRadius ?? 0.9);
  const nearR = Math.max(0.1, c.nearRadius ?? 4);
  const fieldR = Math.max(0.5, c.fieldRadius ?? 6);
  const maxSpeed = Math.max(0.1, c.maxSpeed ?? 22);
  const burstK = Math.max(0, c.burstDrag ?? 8);
  const captureEmit = c.captureEmit ?? '';
  const groups = new Set();
  let lastPhase = null;

  // THE FLOCK, before the walk: each blast's centre of mass, and the pairwise
  // shove. Both read positions from the END of last frame and write only into
  // velocity, so the order blobs are visited in cannot change the answer.
  centroids.clear();
  for (const b of blobs) {
    let m = centroids.get(b.burst);
    if (!m) { m = { x: 0, y: 0, n: 0 }; centroids.set(b.burst, m); }
    m.x += b.x; m.y += b.y; m.n++;
  }
  for (const m of centroids.values()) { m.x /= m.n; m.y /= m.n; }
  const repel = c.repel ?? 7;
  const repelR = Math.max(0.05, c.repelRadius ?? 1.1);
  const fluct = Math.max(0, Math.min(1, c.fluct ?? 0.8));
  if (repel > 0) {
    const r2 = repelR * repelR;
    for (let i = 0; i < blobs.length; i++) {
      const a = blobs[i];
      const wa = 1 - fluct * flockBalance(time, a.phase, c); // repel weight, this blast
      for (let j = i + 1; j < blobs.length; j++) {
        const b = blobs[j];
        if (b.burst !== a.burst) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= r2 || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        // Linear falloff to the radius, applied as a velocity nudge this frame.
        const push = repel * wa * (1 - d / repelR) * dt;
        const nx = dx / d, ny = dy / d;
        a.vx -= nx * push; a.vy -= ny * push;
        b.vx += nx * push; b.vy += ny * push;
      }
    }
  }
  const cohesion = c.cohesion ?? 4;
  const cohesionR = Math.max(0.1, c.cohesionRadius ?? 5);
  // How far into the suck the whole field is — drives the isoline. The max
  // over the blobs, so one blob still in its hold cannot keep the mass from
  // welding once the rest are moving.
  let suction = 0;

  for (let i = blobs.length - 1; i >= 0; i--) {
    const b = blobs[i];
    b.age += dt;
    if (b.age >= b.life) { releaseDriven(b.slot); blobs[i] = blobs[blobs.length - 1]; blobs.pop(); continue; }

    let near = 0;
    // THE LEAN toward the blast's own mass, in every act. Its weight is the
    // other half of the flock's sine: when the shove is at its peak the lean
    // is at its trough, and the mass loosens; a beat later it clenches.
    if (cohesion > 0) {
      const m = centroids.get(b.burst);
      if (m && m.n > 1) {
        const cx = m.x - b.x, cy = m.y - b.y;
        const cd = Math.hypot(cx, cy);
        if (cd > 1e-4) {
          const wc = 1 + fluct * flockBalance(time, b.phase, c);
          const lean = cohesion * wc * Math.min(1, cd / cohesionR) * dt;
          b.vx += (cx / cd) * lean; b.vy += (cy / cd) * lean;
        }
      }
    }
    if (b.age < hold || !target.set) {
      // ACT ONE: the wall of drag. Closed form per frame so the stop is the
      // same at any frame rate.
      const f = Math.exp(-burstK * dt);
      b.vx *= f; b.vy *= f;
    } else {
      const dx = target.x - b.x;
      const dy = target.y - b.y;
      const d = Math.hypot(dx, dy) || 1e-4;
      if (d < capture) {
        // SWALLOWED. The slot goes back and a tinted fleck marks the arrival.
        releaseDriven(b.slot);
        blobs[i] = blobs[blobs.length - 1]; blobs.pop();
        if (captureEmit && CONFIG.emitters[captureEmit]) {
          // Thrown OUTWARD from the seal — the cone opens away from the body
          // the blob just hit — carrying the blob's own momentum and colour.
          emit(captureEmit, b.x, b.y, {
            dirX: -dx / d, dirY: -dy / d,
            vx: b.vx, vy: b.vy,
            scale: c.captureScale ?? 1, sizeMul: c.captureSize ?? 1,
            color: b.tint ?? undefined,
          });
        }
        continue;
      }
      // ACT THREE: the suck. The pull ramps in over `rampTime` from the end of
      // the hold, so the goo is drawn rather than yanked.
      const s = smooth((b.age - hold) / ramp);
      if (s > suction) suction = s;
      near = clamp01(1 - d / nearR);
      if (b.phase !== lastPhase) {
        suckWeights(time / cycle + b.phase, c, weights);
        lastPhase = b.phase;
      }
      flowAt((b.x - target.x) / fieldR, (b.y - target.y) / fieldR, b.z, c, weights, flow);
      // The swirl is the formula; the pull is the seal. The swirl fades as the
      // blob closes (`swirlFade`) so the last stretch is a clean draw into the
      // body, and the pull climbs the closer it gets (`nearBoost`) — which is
      // what "sucked" looks like as opposed to "walked over".
      const pull = (c.pull ?? 6) * s * (1 + (c.nearBoost ?? 2) * near);
      // The swirl BREATHES: a per-blob phase on the wobble so the mass surges
      // unevenly, which is what makes it read as alive rather than as a fan.
      const breath = 1 + (c.wobble ?? 0) * Math.sin(2 * Math.PI * ((c.wobbleHz ?? 1) * time + b.seed));
      const fade = 1 - near * (c.swirlFade ?? 0.6);
      const swirl = (c.swirl ?? 5) * s * fade * breath;
      // The orbit: perpendicular to the radius, the blast's own way round.
      // (dx, dy) points AT the seal, so the blob sits at (-dx, -dy) from it and
      // its counter-clockwise tangent is (dy, -dx): spin +1 is anticlockwise.
      const orbit = (c.orbit ?? 0) * s * fade * b.spin;
      const wx = flow.x * swirl + (dx / d) * pull + (dy / d) * orbit;
      const wy = flow.y * swirl + (dy / d) * pull + (-dx / d) * orbit;
      const steer = Math.min(1, (c.steer ?? 4) * dt);
      b.vx += (wx - b.vx) * steer;
      b.vy += (wy - b.vy) * steer;
      // The hidden axis drifts along its own component, so a blob's lane
      // changes over a long suck instead of repeating.
      b.z += flow.z * (c.zDrift ?? 0.3) * dt;
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > maxSpeed) { b.vx *= maxSpeed / sp; b.vy *= maxSpeed / sp; }
    }

    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) {
      releaseDriven(b.slot); blobs[i] = blobs[blobs.length - 1]; blobs.pop(); continue;
    }
    // Shrinking into the body as it arrives — the goo is going IN, not landing
    // on the skin.
    const size = b.size * (1 - near * (1 - (c.shrinkNear ?? 0.35)));
    writeDriven(b.slot, b.x, b.y, b.age, b.life, size, b.rgb, b.group);
    if (b.groupName) groups.add(b.groupName);
  }
  // The pass has to keep running while any driven blob is alive — nothing else
  // tells it, because nothing else emitted these.
  for (const g of groups) keepGooAlive(g, 0.25);
  // THE WIDE THRESHOLD. While the field is being drawn in, the group's isoline
  // slides from its rest value toward `isoSuck` and its shoulder toward
  // `softSuck`, so the pieces read as one welded mass on the way home. Only
  // on the group this system owns — a shared group is left exactly as tuned.
  updateIso(c, suction);
  flushDriven();
}

function updateIso(c, suction) {
  const name = c.group;
  const own = name && gooGroupIndex(name) > 0 && blobs.some((b) => b.groupName === name);
  if (!own) {
    if (overriddenGroup) { setGooGroupOverride(overriddenGroup, null); overriddenGroup = null; }
    return;
  }
  const rest = CONFIG.fx?.goo?.groups?.[name] ?? {};
  const restIso = rest.iso ?? CONFIG.fx?.goo?.iso ?? 0.3;
  const restSoft = rest.soft ?? CONFIG.fx?.goo?.soft ?? 0.25;
  setGooGroupOverride(name, {
    iso: restIso + ((c.isoSuck ?? restIso) - restIso) * suction,
    soft: restSoft + ((c.softSuck ?? restSoft) - restSoft) * suction,
  });
  overriddenGroup = name;
}

/** The live surface state, for the harness: which group is overridden right now. */
export function gooSuckOverride() {
  return overriddenGroup;
}

/** Everything in flight, gone, and its slots returned. Call BEFORE resetParticles(). */
export function resetGooSuck() {
  for (const b of blobs) releaseDriven(b.slot);
  blobs.length = 0;
  time = 0;
  target.set = false;
  if (overriddenGroup) { setGooGroupOverride(overriddenGroup, null); overriddenGroup = null; }
}

/** Read-only view for the harness. */
export function gooSuckBlobs() {
  return blobs;
}
