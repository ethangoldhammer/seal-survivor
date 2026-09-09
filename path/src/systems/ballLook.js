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
  // THE LEDGER — see noteBallMomentum. How much of the speed the ball is
  // travelling at right now each team actually put there, in u/s.
  credit: [0, 0],
  newest: -1,       // whose colour is marching in
  share: 0,         // ...and how much of the body it has taken, smoothed
  seed: 0,          // the world angle it came in at
  // Where the body is and how big, for the field — setBallBody.
  bx: 0, by: 0, br: 0, speed: 0, vx: 0, vy: 0,
  // A LAGGED COPY of the ball's velocity. The difference between it and the
  // real one is the slosh: see the drift below.
  lagVx: 0, lagVy: 0,
};

export function resetBallLook() {
  state.owner = -1;
  state.pulse = 0;
  state.speed01 = 0;
  state.charge01 = 0;
  state.mix = 0;
  state.credit[0] = 0;
  state.credit[1] = 0;
  state.newest = -1;
  state.share = 0;
  state.seed = 0;
  state.bx = 0;
  state.by = 0;
  state.br = 0;
  state.speed = 0;
  state.vx = 0;
  state.vy = 0;
  state.lagVx = 0;
  state.lagVy = 0;
}

// ---------------------------------------------------------------------------
// WHOSE BALL IS IT — as a proportion, not a flag.
//
// Possession used to be the last seal to strike, and the ball crossfaded
// wholly to that team's colour. That is a fair description of a ball somebody
// has just hammered upfield and a poor one of every other moment in a match:
// most of the time the thing is carrying a hard shot from one seal that the
// other has half-turned, and it belongs to both of them in the proportion
// each of them put into the momentum it is actually travelling on.
//
// So the ledger is MOMENTUM, in u/s, and it is kept honest two ways:
//
//   A CONTACT credits whoever made it with the speed it ADDED — the length of
//   the velocity change, which is the only part of the new heading that seal
//   is responsible for — and scales what was already on the books by how much
//   of the old momentum survived along the new line. A shot turned back the
//   way it came leaves the seal that turned it owning nearly all of it; a
//   nudge that barely bends the flight leaves the ledger nearly untouched.
//
//   EVERY FRAME the two are renormalised to sum to the ball's CURRENT speed,
//   so what they hold is always a description of where the ball is going now
//   rather than a running total of everything that ever hit it. Drag takes
//   from both in proportion, which is right: the water does not take sides.
//
// What the look does with it is `share`: how far round the body the newest
// colour has spread, out of the contact it came in at. It is lerped, so the
// spread IS the lerp — see the note on the two-colour field in post.js.
// ---------------------------------------------------------------------------

/**
 * A contact by `team` changed the ball's velocity from (v0x, v0y) to
 * (v1x, v1y), at `angle` on the ball's rim (world radians, the side the
 * contact was on). versus.js calls this from every path that moves the ball.
 */
export function noteBallMomentum(team, v0x, v0y, v1x, v1y, angle) {
  if (team !== 0 && team !== 1) return;
  const s0 = Math.hypot(v0x, v0y);
  const s1 = Math.hypot(v1x, v1y);
  const added = Math.hypot(v1x - v0x, v1y - v0y);
  if (!(added > 1e-3)) return;
  // How much of what was already there is still going the way the ball is now
  // going. Projected rather than compared by length: a shot sent back the way
  // it came kept its speed and none of its direction, and the seal that did
  // that owns the new one.
  const keep = s0 > 1e-4 && s1 > 1e-4
    ? Math.max(0, (v0x * v1x + v0y * v1y) / (s0 * s1)) * Math.min(1, s0 / s1)
    : 0;
  state.credit[0] *= keep;
  state.credit[1] *= keep;
  state.credit[team] += added;
  // A NEW TEAM MARCHING IN. The share is described from the newest colour's
  // side, so when possession changes hands the SAME picture is re-read from
  // the other end — 1 - share — and the lerp carries on from there. Setting
  // it to zero instead would blink the ball back to one colour on the frame
  // of every touch.
  if (team !== state.newest) {
    state.share = 1 - state.share;
    state.newest = team;
  }
  state.seed = angle ?? state.seed;
  state.owner = team;
}

/**
 * A GOAL. The ball is dead and off the edge of the screen, so there is no
 * momentum left to describe and nothing will call noteBallMomentum again —
 * but this is the one moment the ball most obviously belongs to somebody. The
 * books are handed wholly to `team` and the share marches to a full takeover
 * from wherever the last touch was, so the thing that goes in fills with the
 * scoring team's colour on its way.
 */
export function claimBall(team, angle = null) {
  if (team !== 0 && team !== 1) return;
  const other = team === 1 ? 0 : 1;
  // A real magnitude rather than 1, so the renormalise below has something to
  // scale and a frame where the speed is still non-zero cannot undo it.
  state.credit[team] = Math.max(1, state.credit[team] + state.credit[other]);
  state.credit[other] = 0;
  if (team !== state.newest) {
    state.share = 1 - state.share;
    state.newest = team;
  }
  if (angle != null) state.seed = angle;
  state.owner = team;
}

/** For the harness and the lab: what the ledger currently holds. */
export function ballCredit() {
  return { credit: [...state.credit], newest: state.newest, share: state.share, seed: state.seed };
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
 * WHERE THE BALL IS AND HOW BIG, for the two-colour field — world units, and
 * the projection is done in the pass that has the camera (see post.js). The
 * ball's own module pushes this every frame; without it the field has no
 * radius and the shader falls back to the single tint it always had.
 */
export function setBallBody({ x = 0, y = 0, r = 0, speed = 0, vx = 0, vy = 0 } = {}) {
  state.bx = x;
  state.by = y;
  state.br = r;
  state.speed = speed;
  state.vx = vx;
  state.vy = vy;
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

  // THE LEDGER, RENORMALISED to the speed the ball is actually travelling at —
  // see the note above noteBallMomentum. Drag has taken from the flight since
  // the last contact and it took from both teams at once, so the two credits
  // are scaled together and their PROPORTION is untouched by it.
  //
  // ...WHILE IT IS MOVING. A ball at rest is not owned by nobody: it is owned
  // by whoever last moved it, and rescaling to a speed of zero would wipe the
  // ledger to two zeroes and blank the body on the frame the thing stopped
  // rolling. What the shares describe is a PROPORTION, and a proportion
  // survives the ball coming to a stop — so at rest the books are simply left
  // where they are. (It is also what keeps this honest in a harness or a lab
  // that never pushes a speed at all.)
  const speed = Math.max(0, state.speed ?? 0);
  const total = state.credit[0] + state.credit[1];
  if (total > 1e-6 && speed > 1e-3) {
    const k = speed / total;
    state.credit[0] *= k;
    state.credit[1] *= k;
  }
  // ...and the share the newest colour is owed. Lerped, and that lerp IS the
  // march: the colour spreads out of the contact over `shareRate` rather than
  // arriving everywhere on the frame of the touch.
  const owed = state.newest >= 0 && total > 1e-6
    ? state.credit[state.newest] / (state.credit[0] + state.credit[1] || 1)
    : 0;
  const shareRate = Math.max(0.01, look.shareRate ?? 3.2);
  state.share += (owed - state.share) * Math.min(1, shareRate * dt);

  // THE SLOSH. A lagged copy of the ball's velocity chases the real one; the
  // difference between them is how far the mass inside is left behind. Struck,
  // the ball is gone and the cells pile against the trailing skin; a moment
  // later the lag has caught up and they are centred again. They inherit the
  // ball's motion and never have one of their own — nothing here is integrated
  // and nothing here can move the ball.
  const lagRate = Math.max(0.01, look.sloshLag ?? 5);
  const lagK = Math.min(1, lagRate * dt);
  state.lagVx += ((state.vx ?? 0) - state.lagVx) * lagK;
  state.lagVy += ((state.vy ?? 0) - state.lagVy) * lagK;
  const maxSpeed = Math.max(1, CONFIG.versus?.ball?.maxSpeed ?? 64);
  const sloshMax = Math.max(0, look.sloshMax ?? 0.55);
  const slosh = look.slosh ?? 1.4;
  let dvx = ((state.lagVx - (state.vx ?? 0)) / maxSpeed) * slosh;
  let dvy = ((state.lagVy - (state.vy ?? 0)) / maxSpeed) * slosh;
  const dl = Math.hypot(dvx, dvy);
  if (dl > sloshMax) { dvx *= sloshMax / dl; dvy *= sloshMax / dl; }

  group.warp = {
    ...(group.warp ?? {}),
    amount: Math.max(0, warp),
  };
  group.tint = state.owner >= 0 ? teamColor(state.owner) : 0xffffff;
  group.tintMix = state.mix;
  // The two-colour field. A radius of zero is the switch that leaves every
  // other group — and this one, before a ball exists — on the single tint.
  const other = state.newest === 1 ? 0 : 1;
  group.teams = {
    a: state.newest >= 0 ? teamColor(other) : 0xffffff,
    b: state.newest >= 0 ? teamColor(state.newest) : 0xffffff,
    share: state.share,
    seed: state.seed,
    lobes: look.lobes ?? 5,
    lobeSize: look.lobeSize ?? 0.62,
    wobble: look.wobble ?? 0.7,
    spin: look.spin ?? 0.5,
    breathe: look.breathe ?? 0.25,
    driftX: dvx,
    driftY: dvy,
    wx: state.bx ?? 0,
    wy: state.by ?? 0,
    wr: state.newest >= 0 ? (state.br ?? 0) : 0,
  };
  return {
    warp, tint: group.tint, tintMix: state.mix, owner: state.owner,
    share: state.share, newest: state.newest, seed: state.seed,
    driftX: dvx, driftY: dvy,
  };
}

/** For the shader lab and the tests — what the state machine currently holds. */
export function ballLookState() {
  return { ...state };
}
