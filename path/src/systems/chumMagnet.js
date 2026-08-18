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
// AND THE WHOLE THING IS OFF UNTIL A FOOD CHAIN IS RUNNING. See chumHoming().
// ============================================================================

/**
 * IS THE SEAL REACHING FOR FOOD AT ALL?
 *
 * The magnet is a FOOD CHAIN privilege now, not a permanent sense: outside a
 * live chain, chum has to be swum into, and everything above about corridors
 * and pull speeds describes what happens once one is running.
 *
 * WHY IT IS GATED. A magnet that is always on collects the ocean for you, and
 * once it does the chain stops being something you keep alive and becomes
 * something that happens while you swim about. Turning it off outside the
 * window puts the cost back where the mechanic wants it — the chain is
 * self-sustaining, and getting the first link is work.
 *
 * GATED ON THE WINDOW (isFeeding), not on the link COUNT, and the difference
 * decides whether the loop can start at all. `liveChain()` is zero until a
 * link is actually scored, and a link is paid for in mouthfuls — so gating on
 * it would mean no magnet until you have eaten, and no easy eating until you
 * have the magnet. The window opens on the first strike released in the sweet
 * spot (see tryStrike), which makes the entry condition a thing the player
 * DOES rather than a thing they already have.
 *
 * CHUM AND CHUNKS ONLY. The blue charge orb, the air bubble and the rapid-fire
 * morsel keep their magnet always: those are rewards for reaching a place
 * rather than the resource the chain is made of, and a bubble the player has
 * to nudge with their nose while drowning is a punishment for something that
 * is not this mechanic. See entities/pickups.js for the split.
 */
export function chumHoming() {
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

/** How fast an orb is dragged in, for the state the seal is currently in. */
export function magnetSpeed(speed) {
  const base = CONFIG.pickups.magnetSpeed ?? 14;
  return base * (tuning(magnetState(speed)).speedMul ?? 1);
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
