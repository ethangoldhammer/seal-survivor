// ============================================================================
// BALL LOOK — what the versus ball is doing to itself, as numbers a shader can
// read.
//
// The ball draws through the goo pass (systems/post.js) as the `ball` group,
// and this decides two of that group's uniforms every frame: how hard the
// density field WARPS, and what colour it is TINTED toward. Nothing here draws
// anything. It is a small state machine whose whole output is
// `{ warp, tint, tintMix }`, which is what makes it testable in Node and
// drivable by the shader lab without a match running.
//
// WHY IT IS NOT IN versus.js. Two callers need it and only one of them is a
// game: tools/looks/shader-lab.js drives this module with invented state so
// the ball can be tuned against the real curve rather than against a still
// frame. A look that lives inside the match loop can only be tuned by playing
// a match, which is how the ball's numbers went untouched for as long as they
// did.
//
// THE THREE INPUTS, and they are deliberately different KINDS:
//
//   POSSESSION   discrete and sticky. The last team to strike the ball owns
//                it until someone else does. This is the colour.
//
//   SPEED/CHARGE continuous. The ball is angrier the faster it is going and
//                the harder the seal winding up on it has charged. This is the
//                floor of the warp, and it has no memory at all.
//
//   EVENTS       impulses. A bounce, a goal, a reset. Each one kicks the warp
//                above whatever the continuous term is asking for, and decays
//                back to it. This is what makes a hit READ as a hit rather
//                than as the ball simply being fast afterwards.
//
// The three compose rather than override: the event pulse is added to the
// continuous floor, so a bounce at speed is bigger than a bounce at rest,
// which is the behaviour a player would predict without being told.
// ============================================================================

import * as THREE from 'three';
import { versusSetup } from './versusFlag.js';
import { CONFIG } from '../config.js';

// A team's colour, by index, falling back to white rather than throwing: a
// mode running with one team configured is a mode being edited, not a crash.
export function teamColor(i) {
  // The colour the captain picked on the team select, if there was one —
  // versusSetup is match state and CONFIG.versus.teams is the default, and
  // the tuner's snapshot is why they are two things (see versusFlag.js).
  const picked = versusSetup.teams[i]?.color;
  if (typeof picked === 'number') return picked;
  const teams = CONFIG.versus?.teams ?? [];
  return teams[i]?.color ?? 0xffffff;
}

/** The two goal colours, which are the team colours unless a look overrides. */
export function goalColors() {
  const override = CONFIG.versus?.goal?.colors;
  if (Array.isArray(override) && override.length >= 2) return override;
  return [teamColor(0), teamColor(1)];
}

const _tint = new THREE.Color();

/**
 * THE BALL'S OWN COLOUR, for anything that is a piece of it: the look's
 * colour at the look's glow, which is exactly what renderBall writes into
 * the driven splats. Read at fire time, never baked into an emitter's
 * palette — the colour is tuned live in the ball lab, and a splash in the
 * ball's OLD colour is a second, wrong ball hanging off the first.
 */
export function ballTint(out = _tint) {
  const look = CONFIG.versus?.ball?.look ?? {};
  return out.set(look.color ?? 0xffd166).multiplyScalar(look.glow ?? 1);
}

const state = {
  owner: -1,        // team index that last struck it; -1 is nobody
  pulse: 0,         // event energy, decaying
  speed01: 0,       // smoothed speed, 0..1
  charge01: 0,      // the winding-up seal's charge, 0..1
  mix: 0,           // smoothed tint mix, so possession fades in
};

export function resetBallLook() {
  state.owner = -1;
  state.pulse = 0;
  state.speed01 = 0;
  state.charge01 = 0;
  state.mix = 0;
}

/**
 * A discrete thing happened to the ball. `kind` is one of the names in
 * CONFIG.versus.ball.look.pulses; an unknown name is ignored rather than
 * defaulted, because a typo that silently produced the average of every other
 * event is worse than one that produces nothing.
 */
export function ballEvent(kind, opts = {}) {
  const look = CONFIG.versus?.ball?.look ?? {};
  const amount = look.pulses?.[kind];
  if (amount == null) return;
  // Scaled by how hard it was, where the caller knows. A wall tap and a full
  // strike are the same EVENT and should not be the same kick.
  const force = Math.max(0, Math.min(1, opts.force ?? 1));
  state.pulse = Math.min(look.pulseMax ?? 3, state.pulse + amount * force);
  if (opts.team != null && opts.team >= 0) state.owner = opts.team;
}

/** Continuous inputs, pushed every frame by whoever is simulating the ball. */
export function setBallDrive({ speed01 = 0, charge01 = 0, owner = null } = {}) {
  state.speed01 = Math.max(0, Math.min(1, speed01));
  state.charge01 = Math.max(0, Math.min(1, charge01));
  if (owner != null && owner >= 0) state.owner = owner;
}

/**
 * Advance and read. Returns the numbers renderGooGroup wants, and writes them
 * onto the group so the shader picks them up with no further plumbing.
 *
 * `dt` is the WALL clock on purpose: the goal shutter dilates the world to a
 * near stop, and a ball whose warp froze with it would look like the effect
 * had broken at the exact moment the camera is closest to it.
 */
export function updateBallLook(dt) {
  const look = CONFIG.versus?.ball?.look ?? {};
  const group = CONFIG.fx?.goo?.groups?.ball;
  if (!group) return null;

  // Events decay toward nothing; the continuous term is what is left.
  const decay = Math.max(0.01, look.pulseDecay ?? 2.4);
  state.pulse = Math.max(0, state.pulse - state.pulse * decay * dt);

  const drive = (look.bySpeed ?? 0.6) * state.speed01
    + (look.byCharge ?? 0.4) * state.charge01;
  const warp = (look.warpBase ?? 0) + (look.warpGain ?? 1) * (drive + state.pulse);

  // Possession fades rather than snaps. A ball that changed colour on the
  // frame of contact reads as a rendering glitch; over a few hundred
  // milliseconds it reads as the ball being taken.
  const want = state.owner >= 0 ? (look.tintMax ?? 0.55) : 0;
  const rate = Math.max(0.01, look.tintRate ?? 6);
  state.mix += (want - state.mix) * Math.min(1, rate * dt);

  group.warp = {
    ...(group.warp ?? {}),
    amount: Math.max(0, warp),
  };
  group.tint = state.owner >= 0 ? teamColor(state.owner) : 0xffffff;
  group.tintMix = state.mix;
  return { warp, tint: group.tint, tintMix: state.mix, owner: state.owner };
}

/** For the shader lab and the tests — what the state machine currently holds. */
export function ballLookState() {
  return { ...state };
}
