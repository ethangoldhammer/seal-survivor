// ---------------------------------------------------------------------------
// HOW TALL A GOAL IS — one answer, for the three readers of it.
//
// A leaf, and it exists because of a cycle. systems/versusGoal.js publishes
// the goal's geometry, but it reads the built shore out of
// systems/wallRocks.js — so wallRocks cannot import it back, and carried its
// own copy of `goal.halfHeight ?? 7` to carve the hole with. A CONSTANT read
// in two places is a duplicate you can see; a FORMULA read in two places is
// the drawn hole and the hole the ball scores through growing at two slightly
// different rates the first time one of them is edited. So the formula lives
// down here, under both of them.
//
// IT SCALES WITH THE ROSTER. A mouth tuned for one seal a side is a different
// proposition with four: three of them can stand across it, and a fourth is
// still spare. The pitch does not grow with the roster (the walls are the
// frame), so the thing that has to make room for more attackers is the
// target. The mouth is the authored half height at one a side and
// `roster.widest` times it at MAX_PER_SIDE, straight-line between — so a
// 4-a-side match is played at the widest goal the wall can hold and a 1v1 is
// exactly the match it always was.
//
// AND IT CANNOT EAT THE WALL. The band is centred on midwater, and the wall
// above it runs out at the surface while the wall below runs out at the
// seabed — which are not the same distance. `roster.lip` is the rock that has
// to survive at whichever of them is nearer. The scale above is a request;
// this clamp is the answer, so a tuned `halfHeight` that is already most of
// the wall stops growing instead of opening the goal into the sky.
// ---------------------------------------------------------------------------

import { CONFIG } from '../config.js';
import { bounds, seabedTopY, midWater } from '../arena.js';
import { MAX_PER_SIDE } from './versusFlag.js';
import { rosterPerSide } from './sealRoster.js';

const cfg = () => CONFIG.versus?.goal ?? {};

/** The authored mouth: the half height a ONE-a-side match is played at. */
export function baseHalfHeight() {
  return Math.max(0.5, cfg().halfHeight ?? 7);
}

/**
 * The tallest band this wall can hold — to the surface above and the seabed
 * below, less the lip of rock that has to survive at the nearer of the two.
 */
export function maxHalfHeight() {
  const gy = midWater();
  const lip = Math.max(0, cfg().roster?.lip ?? 3.5);
  const room = Math.min(bounds.surfaceY - gy, gy - seabedTopY());
  return Math.max(1, room - lip);
}

/**
 * THE MOUTH'S HALF HEIGHT in world units — the band is mouthY() ± this, and
 * every reader of the goal's size goes through here (versusGoal.js re-exports
 * it, wallRocks.js carves with it).
 */
export function mouthHalfHeight() {
  const widest = Math.max(1, cfg().roster?.widest ?? 1.4);
  const span = Math.max(1, MAX_PER_SIDE - 1);
  const t = Math.max(0, Math.min(1, (rosterPerSide() - 1) / span));
  return Math.min(baseHalfHeight() * (1 + (widest - 1) * t), maxHalfHeight());
}
