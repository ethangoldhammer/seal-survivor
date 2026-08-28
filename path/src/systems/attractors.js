// ============================================================================
// THE STRANGE ATTRACTORS — the three systems, in their own axes, and nothing else.
//
// Thomas, Lorenz and Aizawa. This file is the equations and an integrator; it
// knows nothing about fish, bullets, world axes or which two coordinates end up
// on screen. Everything that has an opinion about those lives in the caller.
//
// WHY IT IS ITS OWN FILE. Two systems now want the same three equations and
// they want them in opposite ways:
//
//   systems/baitBall.js  SAMPLES the field. A fish reads the flow vector where
//                        it is standing and steers along it, keeps no state of
//                        its own, and throws the magnitude away.
//   systems/attractorStorm.js
//                        INTEGRATES the state. A cube carries its own (x,y,z)
//                        through the system and its world position is that
//                        state projected — so the folding, the lobe switch and
//                        the sensitive dependence are real rather than implied.
//
// Both are legitimate and neither can be written in terms of the other, which
// is exactly the case where the shared part is the equations. Two copies of
// Lorenz is two places for rho to be 28 in one and 28.5 in the other, and the
// resulting bug — a bait ball and a boss whose attractors are subtly different
// systems — is invisible in every screenshot either one appears in.
//
// PARAMS ARE PASSED, NOT READ. Nothing here reaches into CONFIG. The bait ball
// tunes `thomasB` and its two lifts from CONFIG.enemies.baitBall; a storm tunes
// its own from attractorStorms.csv, and the two must be free to disagree — a
// bait ball wants the compact Thomas at b 0.19 and the lattice attack wants the
// wandering one at 0.085. Same equations, different constants, one file.
// ============================================================================

/** Every shape name the functions below answer to. */
export const ATTRACTOR_SHAPES = ['thomas', 'lorenz', 'aizawa'];

// The defaults, in one place so a caller that leaves a field out gets the
// canonical system rather than zero. `lift` is added to z before the equations
// run — a recentring, not a parameter of the system: Lorenz's attractor lives
// around z 25 and Aizawa's around z 0.8, so a caller that wants the shape
// centred on the origin hands in the offset that puts it there.
const DEFAULTS = {
  thomas: { b: 0.19, lift: 0, phase: 0 },
  lorenz: { sigma: 10, rho: 28, beta: 8 / 3, lift: 25 },
  aizawa: { a: 0.95, b: 0.7, c: 0.6, d: 3.5, e: 0.25, f: 0.1, lift: 0.8 },
};

/** The default constants for one shape, as a fresh object the caller may edit. */
export function attractorDefaults(shape) {
  return { ...(DEFAULTS[shape] ?? DEFAULTS.thomas) };
}

/**
 * The system's derivative at (x, y, z), in the attractor's OWN axes.
 *
 * Writes into `out` rather than allocating: this is called several times per
 * cube per frame, and a hundred cubes at six substeps is twelve hundred vectors
 * a frame that would otherwise be garbage.
 *
 * An unknown shape falls through to Thomas deliberately. It is the only one of
 * the three that is bounded whatever you hand it — Lorenz and Aizawa both have
 * a cubic term that runs away from a bad starting point — which is the right
 * property for a default nobody chose.
 */
export function attractorDeriv(shape, x, y, z, params, out) {
  if (shape === 'lorenz') {
    const p = params ?? DEFAULTS.lorenz;
    const sigma = p.sigma ?? 10;
    const rho = p.rho ?? 28;
    const beta = p.beta ?? (8 / 3);
    const zc = z + (p.lift ?? 25);
    out.x = sigma * (y - x);
    out.y = x * (rho - zc) - y;
    out.z = x * y - beta * zc;
    return out;
  }
  if (shape === 'aizawa') {
    const p = params ?? DEFAULTS.aizawa;
    const a = p.a ?? 0.95;
    const b = p.b ?? 0.7;
    const c = p.c ?? 0.6;
    const d = p.d ?? 3.5;
    const e = p.e ?? 0.25;
    const f = p.f ?? 0.1;
    const zc = z + (p.lift ?? 0.8);
    out.x = (zc - b) * x - d * y;
    out.y = d * x + (zc - b) * y;
    out.z = c + a * zc - (zc * zc * zc) / 3 - (x * x + y * y) * (1 + e * zc) + f * zc * x * x * x;
    return out;
  }
  const p = params ?? DEFAULTS.thomas;
  const b = p.b ?? 0.19;
  const zc = z + (p.lift ?? 0);
  // THE PHASE, which only Thomas has and only Thomas could have. Its whole
  // field is three sines of each other's arguments, so one offset added to all
  // three slides the entire lattice of channels sideways at once — every safe
  // lane in the arena moves on one number. Nothing else here has a knob with
  // that property, and it is the reason the lattice study is a Thomas study.
  const ph = p.phase ?? 0;
  out.x = Math.sin(y + ph) - b * x;
  out.y = Math.sin(zc + ph) - b * y;
  out.z = Math.sin(x + ph) - b * zc;
  return out;
}

// Scratch for the integrator. Module-level and reused for the same reason
// `out` is passed in above.
const _k1 = { x: 0, y: 0, z: 0 };
const _k2 = { x: 0, y: 0, z: 0 };
const _mid = { x: 0, y: 0, z: 0 };

/**
 * One RK2 (midpoint) step of `state` through `shape`, in place.
 *
 * RK2 AND NOT EULER, and the difference is visible rather than academic. Euler
 * at any step cheap enough to run on a hundred cubes drifts OFF the attractor —
 * the state spirals outward and the shape the player was shown stops being the
 * shape the bullets are flying. Two derivative evaluations buy a trajectory
 * that stays on the surface for the whole life of a shot, which is the entire
 * premise of drawing the streamline as a telegraph.
 *
 * Returns whether the step produced a finite state. A caller that ignores this
 * gets NaN positions, and a NaN position is worse than a dead bullet: it fails
 * every comparison, so nothing that culls by distance or by bounds will ever
 * remove it and it sits in the list for the rest of the run.
 */
export function stepAttractor(shape, state, h, params) {
  attractorDeriv(shape, state.x, state.y, state.z, params, _k1);
  _mid.x = state.x + _k1.x * h * 0.5;
  _mid.y = state.y + _k1.y * h * 0.5;
  _mid.z = state.z + _k1.z * h * 0.5;
  attractorDeriv(shape, _mid.x, _mid.y, _mid.z, params, _k2);
  const x = state.x + _k2.x * h;
  const y = state.y + _k2.y * h;
  const z = state.z + _k2.z * h;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
  state.x = x;
  state.y = y;
  state.z = z;
  return true;
}
