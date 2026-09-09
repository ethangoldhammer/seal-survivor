// ---------------------------------------------------------------------------
// THE GOAL MOUTH — a hole in each wall, as geometry every reader agrees on.
//
// A leaf, like versusFlag.js and for the same reason: three readers in three
// corners of the graph need the same rectangle, and none of them may import
// versus.js (which pulls in half the game). wallRocks.js CARVES the hole out
// of the shore; arena.js lets a seal swim into it (through the probe below,
// so arena.js stays a leaf too); versus.js bounces the ball off its lips and
// posts and calls the goal. One function per question, all built off the
// same three numbers, so the drawn hole, the hole a seal can enter and the
// hole the ball scores through cannot be three different holes.
//
// THE SHAPE. The mouth is a band of the wall, goalY ± halfHeight, opened up
// into a tunnel `tunnel` units deep past the wall. Above and below the band
// the wall is solid rock as it always was; the two corners where the band
// meets the wall are the POSTS. The ball collides with the two solid blocks
// (the rock above the mouth and the rock below it) as a circle against two
// axis-aligned quarter-planes — which is what makes a post a post: the same
// test that gives a flat wall its flat normal gives the corner a diagonal
// one, and a ball clipping the post leaves at an angle instead of straight
// back.
//
// THE LINE. A goal is called when the ball's near side is `goal.line` units
// past the drawn face — INSIDE the tunnel and ON SCREEN, because in a match
// the camera may reach `camera.reach` past the wall (cameraReach below,
// spent by clampFocus in world.js), which is wider than the line. So the
// ball is seen to cross it, a ball rattling short of it is still in play,
// and a keeper standing in front of it (keeperReach) can shove it back out.
// It used to be the edge of the screen, which was wherever the shore's one
// boulder of cover happened to stop.
// ---------------------------------------------------------------------------

import { CONFIG } from '../config.js';
import { bounds, midWater, arenaHoles } from '../arena.js';
import { versusActive } from './versusFlag.js';
import { shoreOverscan, shore } from './wallRocks.js';

const cfg = () => CONFIG.versus?.goal ?? {};

/** The mouth's half height in world units — the band is goalY ± this. */
export function mouthHalfHeight() {
  return cfg().halfHeight ?? 7;
}

/** How far past the wall the hole is cut. */
export function tunnelDepth() {
  return Math.max(1, cfg().tunnel ?? 14);
}

/** The band's centre: the goals sit at midwater. */
export function mouthY() {
  return midWater();
}

/**
 * How far past each wall the frame may reach in a match — into the goal, by
 * CONFIG.versus.camera.reach, and never past the tunnel's back. Outside a
 * match it is the shore's own overscan, as it always was. world.js's
 * focusLimits spends it; screenEdgeX below is the same number as an x.
 */
export function cameraReach() {
  if (!versusActive()) return shoreOverscan();
  const want = Math.max(0, CONFIG.versus?.camera?.reach ?? 12);
  return Math.min(want, tunnelDepth() - 0.5);
}

/**
 * The furthest x the frame can reach past the wall on `side` (-1 the left
 * wall, +1 the right). The goal jet is born beyond it and the spawner treats
 * it as "off screen".
 */
export function screenEdgeX(side) {
  const over = cameraReach();
  return side < 0 ? bounds.left - over : bounds.right + over;
}

/** How far past the drawn face the goal line sits — inside the tunnel, on screen. */
export function goalLineDepth() {
  const want = Math.max(0, cfg().line ?? 8);
  // The WHOLE ball has to fit between the line and the tunnel's back, or it
  // bounces off the back with its near side still short of the line and the
  // goal can never be called.
  const ballR = Math.max(0, CONFIG.versus?.ball?.radius ?? 2.8);
  return Math.max(0, Math.min(want, tunnelDepth() - ballR * 2 - 0.25));
}

/**
 * THE LINE, as an x: a goal on `side` is called when the ball's near edge is
 * past it. See THE LINE above — the caller adds the ball's own radius.
 */
export function goalLineX(side) {
  return rockX(side) + side * goalLineDepth();
}

/**
 * Where the ROCK is on `side`: the drawn face, which sits `shore.face` past
 * the wall's line (the seal stops with its nose on the rock, not its hit
 * circle — see wallRocks). The ball bounces off this, so a post is where the
 * post is drawn; the seals keep the wall's line, as they always have. Zero
 * inset with no shore built, so a harness measures against the wall.
 */
export function rockX(side) {
  const inset = shore.built ? shore.face : 0;
  return side < 0 ? bounds.left - inset : bounds.right + inset;
}

/**
 * The two rock blocks a wall is made of once the mouth is cut out of it —
 * the one above and the one below — as the CLOSEST POINT on each to (x, y).
 * A circle of radius r at (x, y) touches a block when that point is inside r.
 * `out` receives { qx, qy } per block, upper then lower. The wall's own x is
 * the block's inner face; the block runs to infinity outward and up/down.
 */
export function nearestOnBlocks(side, x, y, out) {
  const wallX = rockX(side);
  const gy = mouthY();
  const h = mouthHalfHeight();
  // Inside the block's x-range the closest x is the point's own; outside it
  // is the face. Same in y against the lip.
  const qx = side < 0 ? Math.min(x, wallX) : Math.max(x, wallX);
  out[0].qx = qx; out[0].qy = Math.max(y, gy + h);
  out[1].qx = qx; out[1].qy = Math.min(y, gy - h);
  return out;
}

/** Is (x, y) with radius r fully inside the mouth's band? */
export function inMouthBand(y, r) {
  const gy = mouthY();
  return Math.abs(y - gy) <= mouthHalfHeight() - r;
}

// ---------------------------------------------------------------------------
// THE SEALS' HOLE — what arena.clampToArena asks.
//
// A seal is allowed into the mouth, `keeperReach` past the wall and no
// further — always short of the goal line — and inside it the lips hold it
// the way the walls do. Goalkeeping inside the mouth is the whole point.
// ---------------------------------------------------------------------------

const _hole = { xMin: -Infinity, xMax: Infinity, yMin: 0, yMax: 0 };

function probe(x, y, radius) {
  if (!versusActive()) return null;
  const c = cfg();
  if (c.holes === false) return null;
  const gy = mouthY();
  const h = mouthHalfHeight();
  // A body whose CENTRE is past the wall's line is in the tunnel whatever
  // its y — the lips are what hold it, and the flat wall's clamp would
  // otherwise let it out through the rock the moment it nosed above the
  // band. A body still in the water takes the hole only if it fits in the
  // band whole; half over the corner it is against the wall, as it was.
  const inside = x < bounds.left || x > bounds.right;
  if (!inside && !inMouthBand(y, radius)) return null;
  if (inside && Math.abs(y - gy) > h + radius) return null;
  // A keeper may stand in front of the line, never on it.
  const depth = Math.max(0, Math.min(c.keeperReach ?? 7, goalLineDepth() - 0.5));
  if (x < bounds.left + radius) {
    _hole.xMin = bounds.left - depth;
    _hole.xMax = Infinity;
  } else if (x > bounds.right - radius) {
    _hole.xMin = -Infinity;
    _hole.xMax = bounds.right + depth;
  } else return null;
  _hole.yMin = gy - h + radius;
  _hole.yMax = gy + h - radius;
  return _hole;
}

/** Hand the arena the mouths (a match starting) or take them back (one ending). */
export function installGoalHoles(on = true) {
  arenaHoles.probe = on ? probe : null;
}

export function goalHolesInstalled() {
  return arenaHoles.probe === probe;
}
