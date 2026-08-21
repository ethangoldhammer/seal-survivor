import { CONFIG } from '../config.js';
import { strikeState, isFeeding } from './strike.js';
import { airPickupMul } from './airborne.js';

// ============================================================================
// THE MAGNET, PER STATE — how far the seal reaches for food, and how hard.
//
// It used to be one flat radius for every situation, and that quietly made the
// FOOD CHAIN unreachable. Sustaining a chain means refilling the bar inside
// CONFIG.strike.chainWindow, which at the shipped numbers is five to ten orbs
// a second; at a fixed 4-unit reach and top speed the seal sweeps about 350
// square units per window, so the water has to hold an orb every 58 square
// units before the loop can even turn over. The chain was gated on a density
// the ocean rarely has.
//
// TWO THINGS WERE WRONG, and only fixing both does anything.
//
//   1. THE RADIUS didn't know what the seal was doing. Drifting and dashing
//      reached equally far, so the state that crosses the most water collected
//      no better than the one standing still.
//
//   2. THE PULL SPEED COULDN'T KEEP UP, which is the one that actually bites.
//      `magnetSpeed` is 14 and `dashSpeed` is 46: an orb anywhere but directly
//      ahead of a dashing seal falls behind at 32 u/s and can NEVER catch up.
//      Widening the radius while striking without also raising the pull would
//      have changed nothing at all — the extra orbs would simply be picked up
//      by a magnet that then loses the race to the dash.
//
// AND WHILE DASHING IT IS A CORRIDOR, NOT A CIRCLE.
//
// A circle centred on something moving at 46 u/s is the wrong shape for what
// the player did: they flew down a LANE, and the food they expect to have
// taken is the food in that lane — including what is now behind them, because
// it was in front of them a tenth of a second ago. A capsule swept along the
// dash heading collects what the dash actually went past, which is both more
// generous and more intuitive than a disc that leaves a trail of untouched
// orbs down the line the seal just travelled.
//
// The mouth still seals during a WIND-UP — that gate lives in pickups.js and
// is untouched here. This is only about what an open mouth can reach.
//
// AND EVERYTHING ABOVE IS THE FOOD CHAIN'S. See chumSweep().
// ============================================================================

/**
 * IS THE SEAL SWEEPING FOR FOOD — the wide, fast, corridor-shaped magnet?
 *
 * THIS IS NOT A GATE ON EATING, and getting that backwards is a starvation
 * bug. There is always a magnet: chum always drifts to the mouth at the base
 * `magnetSpeed` inside the base `pickupRadius`, chain or no chain, and a seal
 * never has to earn the right to feed. Everything described above this — the
 * per-state radius multipliers, the pull that can outrun a dash, the capsule
 * swept down the lane — is the LOUD version, and that is what a live chain
 * turns on.
 *
 * So a cruising seal picks food up; a seal mid-chain HOOVERS it, out of a
 * region twice as wide, faster than it is travelling, including the pile it
 * has already shot past. Same mechanism at two strengths, which is why this is
 * one boolean and not a second magnet.
 *
 * WHY THE CHAIN OWNS THE LOUD ONE. The sweep is the most powerful collection
 * tool in the game, and left always on it collects the ocean for you — the
 * chain stops being something you keep alive and becomes something that
 * happens while you swim about. On the chain it is a reward that pays for the
 * next link, which is the loop the whole system is named after.
 *
 * READS THE WINDOW (isFeeding), not the link COUNT. `liveChain()` is zero
 * until a link is actually scored, so it would hold the sweep back through the
 * whole first link of every chain — the stretch where the player most needs it.
 * isFeeding() also covers the DASH itself, which is deliberate: the corridor is
 * the reach a dash is FOR, and a dash that flew down a lane should collect that
 * lane whether or not the release was on the beat. A mistimed strike is a
 * speed boost, and this is what a speed boost is for.
 *
 * CHUM AND CHUNKS ONLY. The blue charge orb, the air bubble and the rapid-fire
 * morsel keep the full magnet always: they are not what the chain is made of,
 * and a bubble the player has to nudge with their nose while drowning is a
 * punishment for something that is not this mechanic. See foodReach() below —
 * the split is which function a call site reaches for.
 */
export function chumSweep() {
  if (CONFIG.pickups.magnet?.chainGated === false) return true;
  return isFeeding();
}

/** Which magnet state the seal is in, by what it is doing. */
export function magnetState(speed) {
  // The dash outranks speed: a dash IS fast, and testing it first means the
  // corridor and the boosted pull can never be missed because the velocity
  // sample happened to land in a slow frame (the first frame of a dash, or a
  // dash into a wall).
  if (strikeState.active) return 'striking';
  const a = CONFIG.animation ?? {};
  // The SAME thresholds that pick the swim/boost animation clip, deliberately:
  // the state the seal looks like it is in and the state its mouth is in must
  // be the same state, or the wider reach reads as random.
  if (speed >= (a.boostThreshold ?? 14)) return 'boosting';
  if (speed >= (a.moveThreshold ?? 1)) return 'swimming';
  return 'idle';
}

function tuning(state) {
  const m = CONFIG.pickups.magnet ?? {};
  return m[state] ?? m.idle ?? { radiusMul: 1, speedMul: 1 };
}

/**
 * The reach, in world units, for the state the seal is currently in.
 *
 * AIR TIME widens it on top of the state's own multiplier, and that rider is
 * the one thing in CONFIG.airborne that is not simply a damage number. It is
 * there because the orbs are IN the water and the seal is not: without it,
 * time spent airborne is time spent not collecting, and a mechanic meant to
 * feed the food chain would instead compete with it. See systems/airborne.js.
 */
export function magnetRadius(stats, speed) {
  const base = stats?.pickupRadius ?? CONFIG.player.pickupRadius ?? 3;
  return base * (tuning(magnetState(speed)).radiusMul ?? 1) * airPickupMul();
}

/**
 * THE FLOOR THAT MAKES A CLAIMED ORB ARRIVE — the pull, against the seal's own
 * speed rather than against nothing.
 *
 * Everything above answers "how hard does it pull" with a fixed speed or a
 * multiple of one, and a fixed speed LOSES A RACE. The base pull is 14 u/s and
 * the seal cruises at 34, so an orb the magnet had already claimed closed at
 * -20 u/s: it never arrived, and because the claim is latched it never gave up
 * either. The player saw food fly at them, fall behind, and then trail them
 * around the arena — the striking multiplier (3.4, chosen precisely to clear
 * the dash) was the only state in the game where the hoover actually hoovered.
 *
 * `gain` is a CLOSING speed, not a pull speed: the gap shrinks by at least that
 * much per second whatever the seal does, so the arrival time depends on the
 * reach and nothing else. `min` is the same promise at a standstill, where
 * there is nothing to outrun and the base pull alone decides how a pile feels.
 *
 * Every pickup goes through this, not just chum. A bubble a drowning seal can
 * outswim is this bug with worse consequences.
 *
 * `mul` IS THE STATE'S OWN PULL MULTIPLIER, and it scales the closing speed as
 * well as the pull. Without it the floor flattens the very tiering it is
 * protecting: at a 19 u/s cruise the floor is 37 u/s, which is above the base
 * pull AND above the chain's boosted one, so a live chain would reach further
 * and pull exactly as hard as no chain at all. Scaling the gain keeps the order
 * the states are in — every state closes faster than the one below it — and
 * still leaves the slowest of them unable to be outswum.
 */
export function outrunPull(base, speed, mul = 1) {
  const o = CONFIG.pickups.magnet?.outrun ?? {};
  if (o.enabled === false) return base;
  return Math.max(base, o.min ?? 0, (speed || 0) + (o.gain ?? 0) * mul);
}

/** How fast an orb is dragged in, for the state the seal is currently in. */
export function magnetSpeed(speed) {
  const base = CONFIG.pickups.magnetSpeed ?? 14;
  const mul = tuning(magnetState(speed)).speedMul ?? 1;
  return outrunPull(base * mul, speed, mul);
}

// ---------------------------------------------------------------------------
// ...AND THE SAME THREE QUESTIONS FOR FOOD, WHICH IS THE ONLY THING THE CHAIN
// HAS AN OPINION ABOUT.
//
// Three wrappers rather than a flag threaded through the three above, because
// the three above are asked by every pickup in the game and only two callers —
// chum and chunks — are part of the food chain. A flag would put the chain's
// rule in front of the air bubble, where it has no business being, and the
// failure mode of that is a drowning player nosing a bubble around.
//
// Each one falls back to the BASE, not to nothing: base radius, base pull,
// plain radial distance. That is the always-on magnet, and it is what makes
// this safe — the worst a bug here can do is collect at one strength when it
// meant the other, never fail to collect.
// ---------------------------------------------------------------------------

/** How far the seal reaches for CHUM right now. */
export function foodReach(stats, speed) {
  if (chumSweep()) return magnetRadius(stats, speed);
  const base = stats?.pickupRadius ?? CONFIG.player.pickupRadius ?? 3;
  return base * airPickupMul();
}

/**
 * How hard it pulls it.
 *
 * The quiet magnet goes through outrunPull() as well, and that is the half of
 * this the chain does NOT own: a cruising seal collects at the base speed, but
 * it still collects — an orb it has claimed closes on the mouth whether or not
 * a chain is live. The sweep buys reach and a bigger pull, never the difference
 * between food arriving and food chasing you.
 */
export function foodPull(speed) {
  if (chumSweep()) return magnetSpeed(speed);
  return outrunPull(CONFIG.pickups.magnetSpeed ?? 14, speed);
}

/**
 * And how far away it is — the corridor while sweeping mid-dash, the plain
 * radial distance otherwise.
 *
 * magnetDistance() only builds the capsule while `strikeState.active`, and a
 * live dash is always feeding, so the corridor is already the sweep's alone.
 * Routed through chumSweep() anyway so the three wrappers answer to one rule:
 * a future reading of "sweeping" that is not simply isFeeding() must not leave
 * the corridor behind on a technicality nobody remembers.
 */
export function foodDistance(px, py, ox, oy, speed) {
  if (chumSweep()) return magnetDistance(px, py, ox, oy, speed);
  return Math.hypot(ox - px, oy - py);
}

/**
 * DISTANCE TO THE MOUTH, which is not always the distance to the seal.
 *
 * Everywhere but a dash this is the plain radial distance. During a dash it is
 * the distance to the CORRIDOR — the segment the dash is sweeping — so an orb
 * level with the lane counts as close even once the seal has shot past it.
 *
 * Returned as a distance rather than a boolean because the caller needs it for
 * the pull direction and the collect test as well as the range check, and two
 * functions disagreeing about which orb is nearest is exactly the kind of bug
 * that shows up as food occasionally refusing to be eaten.
 *
 * @param px,py  the seal
 * @param ox,oy  the orb
 * @param speed  the seal's current speed, for the state
 * @returns {number} distance from the orb to the reaching mouth
 */
export function magnetDistance(px, py, ox, oy, speed) {
  const dx = ox - px;
  const dy = oy - py;
  if (magnetState(speed) !== 'striking') return Math.hypot(dx, dy);

  const c = CONFIG.pickups.magnet?.striking ?? {};
  const back = c.corridorBack ?? 0;
  const ahead = c.corridorAhead ?? 0;
  if (back <= 0 && ahead <= 0) return Math.hypot(dx, dy);

  // The capsule's spine, from `back` units behind the seal to `ahead` in
  // front, along the dash heading. Projecting onto it and clamping to the
  // segment is what makes the region a stadium rather than an infinite strip —
  // without the clamp an orb a screen away but perfectly in line would read as
  // touching the mouth.
  const hx = strikeState.dashDir.x;
  const hy = strikeState.dashDir.y;
  const t = Math.max(-back, Math.min(ahead, dx * hx + dy * hy));
  return Math.hypot(dx - hx * t, dy - hy * t);
}
