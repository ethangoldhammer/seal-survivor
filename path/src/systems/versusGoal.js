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
// and a keeper standing in front of it can shove it back out.
// It used to be the edge of the screen, which was wherever the shore's one
// boulder of cover happened to stop.
// ---------------------------------------------------------------------------

import { CONFIG } from '../config.js';
import { ballMaxRadius } from './ballShape.js';
import { bounds, midWater, arenaHoles } from '../arena.js';
import { versusActive } from './versusFlag.js';
import { shoreOverscan, shore } from './wallRocks.js';
import { mouthHalfHeight } from './goalBand.js';

const cfg = () => CONFIG.versus?.goal ?? {};

// THE MOUTH'S HALF HEIGHT lives in systems/goalBand.js and is re-exported
// here, where every reader already looks for it. It is not a config read any
// more: it grows with the roster and is clamped against the wall, and
// wallRocks.js — which carves the hole and cannot import this module — has to
// get the same number out of the same function. See the note over there.
export { mouthHalfHeight } from './goalBand.js';

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
 *
 * IN THE WALL'S FRAME, cap included: the tunnel is cut `tunnel` deep past
 * the drawn FACE, which is shore.face past the wall, so the back is both of
 * them out. Capped against the tunnel alone it stopped the frame a rock face
 * short of the corridor's end — which is exactly where a seal may now stand.
 */
export function cameraReach() {
  if (!versusActive()) return shoreOverscan();
  const want = Math.max(0, CONFIG.versus?.camera?.reach ?? 12);
  const inset = shore.built ? shore.face : 0;
  return Math.min(want, inset + tunnelDepth() - 0.5);
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
  //
  // THE DRAWN BALL, not `radius`. `radius` is the soft body's rest radius and
  // the thing that actually arrives is the goo surface around it, which is
  // most of twice as wide and wider still at speed — see ballShape.js. Read
  // off `radius` this clamp let a line be authored that the ball could only
  // bounce off the back short of, which is a goal that never gets called.
  const ballR = Math.max(0, ballMaxRadius());
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
 * THE LINE A KEEPER DEFENDS, as a distance past the WALL'S LINE — which is
 * the frame arena.clampToArena works in, and not the one the goal line is
 * published in. The line is `goalLineDepth()` past the DRAWN FACE and the
 * face is `shore.face` past the wall, so this is both of them, less a small
 * gap: a keeper whose centre is here has its body over the line.
 *
 * NOT how deep a seal may swim — that is keeperReachDepth, the whole
 * corridor. This is the depth at which a keeper is fully contesting a shot
 * (the goal light's defend ramp, versus.js stirGoalLights), and the harness
 * asserts against it, so it stays a function rather than a frame conversion
 * redone in two places.
 */
export function keeperLineDepth() {
  const inset = shore.built ? shore.face : 0;
  return Math.max(0, inset + goalLineDepth() - KEEPER_GAP);
}

// The gap keeperLineDepth leaves in front of the line. Small on purpose: the
// seal's own body is wider than this, so it covers the line while its centre
// is still short of it — which is what defending the last stride looks like.
const KEEPER_GAP = 0.5;

/**
 * HOW DEEP A SEAL MAY SWIM into a mouth, past the WALL'S LINE: the whole
 * corridor, to the rock at the tunnel's back. A body of `radius` stops with
 * its edge on that rock, the way it stops on any wall.
 *
 * It used to stop at `keeperReach` (7 past the wall), a rule with no rock
 * behind it: the tunnel is built 16 deep past the face and the seal bumped
 * an invisible wall a third of the way down it, looking at the last half of
 * its own goal and unable to get back there for the close ones. The only
 * wall a seal meets in the goal now is one it can see.
 */
export function keeperReachDepth(radius = 0) {
  const inset = shore.built ? shore.face : 0;
  return Math.max(0, inset + tunnelDepth() - Math.max(0, radius));
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
// A seal is allowed into the mouth and all the way down the corridor to the
// rock at the tunnel's back (keeperReachDepth), and inside it the lips hold
// it the way the walls do. Goalkeeping inside the mouth is the whole point,
// and a save on the line is a seal that got BEHIND the ball — so nothing
// short of the rock may stop it. The camera's reach into the goal covers the
// corridor for the same reason (cameraReach): a keeper that can stand where
// the frame cannot follow is a keeper you cannot play.
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
  // To the rock at the back, and the body's own edge is what meets it —
  // `depth` is spent below on the CENTRE, in the wall's frame. See
  // keeperReachDepth for why there is no shorter stop.
  const depth = keeperReachDepth(radius);
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
