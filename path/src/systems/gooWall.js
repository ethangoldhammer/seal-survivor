import { CONFIG } from '../config.js';
import { holdEnemy } from './control.js';
import { emit } from '../entities/particles.js';
import { feedback } from './feedback.js';

// ============================================================================
// THE GOO WALL — what a backflip leaves behind it.
//
// A short bar of the seal's own substance, thrown across the water in front of
// the animal as it rolls backwards away from whatever was chasing it. Anything
// that reaches it stops for a moment; the ball bounces off it; it is gone in
// about half a second.
//
// THE TWO FLIPS DO DIFFERENT JOBS, and this is one half of that. A forward
// flip is a COMMITMENT — it throws the seal down the line it is already
// swimming (flingSeal in entities/player.js, the same call a goal explosion
// uses) and is how you arrive somewhere with momentum. A backflip is the
// opposite gesture in every sense: the body goes backwards, and what it leaves
// in the water is a wall. One is for getting INTO something, the other for
// getting OUT, and the player picks between them with the direction they draw.
//
// ---------------------------------------------------------------------------
// WHAT "BLOCKING" MEANS, AND WHY IT IS NOT A COLLIDER
// ---------------------------------------------------------------------------
// There is no static geometry in this water that a creature collides with —
// the arena is a box, the rocks are decor, and a hunter's velocity is
// re-derived from its heading every frame (see steerTo in entities/enemies.js,
// which is why writing vx/vy at a creature does nothing a frame later). So a
// wall implemented as a collider would be a wall that fish swim through.
//
// It goes through holdEnemy (systems/control.js) instead, which is the game's
// one and only way of saying "this creature is not moving right now" — and
// that file's whole argument is that a hold added tomorrow should inherit its
// rules without knowing they exist. This one does: scenery is skipped, and a
// BOSS is never held, so the wall dazes it instead. A three-tonne animal walks
// through a bar of goo with its heading wobbling, which is exactly right — the
// alternative is a half-second cooldown ability that stops a boss fight.
//
// The hold is DELIBERATELY SHORT. This is a wall, not a trap: it buys the
// distance a body would have covered while it was stopped, and the creature
// then carries on. Anything longer and the backflip is a crowd-control
// ability with a hitbox, which is a different card in a different game.
//
// ---------------------------------------------------------------------------
// ONE BODY, ONE STOP, PER WALL
// ---------------------------------------------------------------------------
// The test runs every frame the wall is up and a held creature does not move
// out of it, so without the ledger the same fish would be re-held on every one
// of those frames and the wall would be a permanent cage for whatever touched
// it first. The same rule the tail slap's own hitbox follows, and for the same
// reason.
//
// ---------------------------------------------------------------------------
// THE TAIL PAINTS IT, ONE NODE A FRAME
// ---------------------------------------------------------------------------
// It is NOT a bar dropped into the water at the launch. The goo comes off the
// FLUKE as the somersault swings it, so the wall is the arc the tail actually
// cut — it grows while the animal turns, it curves the way the animal curved,
// and it starts and stops where the tail did.
//
// That is a different thing from a placed barrier in three ways that matter:
//
//   IT IS ORGANIC. The mass is thrown by an animal doing something, not
//   spawned at an offset. A player watching can see where it came from.
//   IT IS A CURVE. The fluke sweeps a circle around the body, so the wall
//   bows away from the seal — which is the right shape for a thing you are
//   retreating behind.
//   IT IS EARNED OVER TIME. A flip cut short lays a shorter wall, because
//   fewer frames of tail went past.
//
// NOT THE WHOLE CIRCLE, though. Goo laid along all of it is a RING with the
// seal inside, which is a bubble to stand in rather than a wall to retreat
// behind — so `emitFrom`/`emitTo` cut one arc out of the turn (see
// flipTailLaying in systems/sealFlip.js).
//
// ---------------------------------------------------------------------------
// COHESION: WHY THE BLOBS FUSE INTO A WALL
// ---------------------------------------------------------------------------
// Goo is a metaball field — every splat is a lobe that sums with its
// neighbours, and the surface is drawn where the sum crosses the group's
// isoline. Two things decide whether a line of splats reads as one wall or as
// a row of dots, and they are both about SPACING RELATIVE TO A LOBE:
//
//   `step`, here — how far the tail must travel before another blob is laid.
//   Under a lobe's drawn radius, consecutive blobs overlap and the field never
//   dips below the isoline between them. Over it and the wall is beads.
//   `iso`, in the group (CONFIG.fx.goo.groups.gooWall) — the level the sum has
//   to reach. LOW, because the falloff is cubic and the part of a lobe that
//   clears a high isoline is a good deal smaller than the lobe. The same
//   argument the `aura` group's note makes, pointed the other way.
//
// The emitter is slow and heavily dragged for the same reason: a blob thrown
// out of the line is a blob that has left the wall, and a wall that comes
// apart in the half second it exists was never a wall.
//
// ---------------------------------------------------------------------------
// AND IT HAS ENDS
// ---------------------------------------------------------------------------
// A body is stopped when it is within `thick` of the POLYLINE the nodes make —
// not of an infinite plane — so the wall can be swum round, and a flip thrown
// at nothing leaves a short arc rather than a barrier across the arena.
// ============================================================================

const cfg = () => CONFIG.sealFlip?.back ?? {};

/**
 * Every wall in the water. At most a couple, and usually none: they last half
 * a second and the flip that throws them has a cooldown longer than that.
 */
export const gooWalls = [];

/** Tallies, for the readouts and the harness. */
export const gooWallState = {
  thrown: 0,
  stopped: 0,
  // The last body stopped, as { x, y } — what the debug draw marks.
  last: null,
};

export function resetGooWalls() {
  gooWalls.length = 0;
  gooWallState.thrown = 0;
  gooWallState.stopped = 0;
  gooWallState.last = null;
}

/**
 * THROW ONE. Centred `stand` in front of (x, y) along `angle`, lying across it.
 *
 * @param angle  which way the seal is facing, world radians. The wall's normal.
 * @param at     optional { x, y } to centre on instead of the offset point —
 *               the harness uses it; nothing in the game does.
 * @returns the wall, or null when the feature is off.
 */
export function spawnGooWall(x, y, angle, at = null) {
  const c = cfg();
  if (c.enabled === false) return null;
  const nx = Math.cos(angle);
  const ny = Math.sin(angle);
  const wall = {
    // WHERE THE ANIMAL WAS WHEN IT THREW IT, and which way it was facing.
    // Neither is the wall's position any more — the nodes are — but both are
    // wanted: the facing is the fallback normal for a body standing exactly on
    // the line, and the origin is what a debug draw measures from.
    x: at ? at.x : x,
    y: at ? at.y : y,
    nx,
    ny,
    // THE ARC, in world points, appended a frame at a time by extendGooWall as
    // the tail sweeps past. Empty at birth: a wall that has not been painted
    // yet stops nothing, which is correct — the goo is not in the water.
    nodes: [],
    // Still open to the tail, or finished. A sealed wall ages and nothing
    // more.
    laying: true,
    thick: Math.max(0.2, c.thick ?? 1.6),
    life: Math.max(0.05, c.life ?? 0.55),
    maxLife: Math.max(0.05, c.life ?? 0.55),
    // Everything this wall has already stopped — see the header.
    hits: new Set(),
  };
  gooWalls.push(wall);
  // A CAP, and the OLDEST goes. Two walls is already more than the flip's
  // cooldown allows; this exists so a tuner run with the cooldown at zero
  // cannot fill the water with them.
  const max = Math.max(1, c.maxWalls ?? 2);
  while (gooWalls.length > max) gooWalls.shift();

  gooWallState.thrown++;
  return wall;
}

/**
 * ONE MORE BLOB OFF THE TAIL. Called every frame the fluke is laying goo
 * (flipTailLaying in systems/sealFlip.js), with the tail's world position.
 *
 * SPACED, NOT PER FRAME. The tail's speed varies with the follow-through and
 * with the frame rate, and a blob per frame would pile forty of them on top of
 * each other in a slow flip and string them out in a fast one — the mass would
 * read as a different substance depending on how sharply the player drew the
 * circle. A node every `step` world units puts the same wall down either way,
 * and `step` under a lobe's drawn radius is what makes them fuse (see the
 * header).
 *
 * @returns true when a node was laid.
 */
export function extendGooWall(wall, x, y, vx = 0, vy = 0) {
  if (!wall?.laying || wall.life <= 0) return false;
  const c = cfg();
  const step = Math.max(0.05, c.step ?? 1.1);
  const cap = Math.max(2, c.maxNodes ?? 48);
  const last = wall.nodes[wall.nodes.length - 1];

  if (!last) {
    if (wall.nodes.length >= cap) return false;
    wall.nodes.push({ x, y });
    blob(wall, x, y, vx, vy);
    // THE SOUND ON THE FIRST NODE ONLY. The wall is one event however many
    // blobs it take, and a voice per node is twenty identical splashes over a
    // third of a second.
    feedback('sealFlipWall', { x, y, dirX: wall.nx, dirY: wall.ny, scale: 1 });
    return true;
  }

  const gap = Math.hypot(x - last.x, y - last.y);
  if (gap < step) return false;

  // THE FLUKE OUTRUNS THE FRAME, AND THE PATH IS WHAT COUNTS.
  //
  // A blob per frame is a wall whose cohesion depends on the frame rate: the
  // tip sweeps a 33-unit circle in about a fifth of a second, which is 2.3
  // units between frames at 60fps — twice the spacing the mass needs to fuse,
  // and twice that again on a machine running at 30. The wall came out as
  // beads on a string, and would have come out as a rope on a 120Hz display.
  //
  // So the gap is FILLED: nodes are laid every `step` along the line the tail
  // covered since the last one, not merely at the place it happens to be
  // standing when a frame ends. The blobs go where the tail WENT, the spacing
  // is the authored one at any frame rate, and the curve is sampled finely
  // enough that a straight fill between two samples is indistinguishable from
  // the arc.
  const ux = (x - last.x) / gap;
  const uy = (y - last.y) / gap;
  let laid = 0;
  for (let d = step; d <= gap + 1e-6 && wall.nodes.length < cap; d += step) {
    const nx = last.x + ux * d;
    const ny = last.y + uy * d;
    wall.nodes.push({ x: nx, y: ny });
    blob(wall, nx, ny, vx, vy);
    laid++;
  }
  return laid > 0;
}

/**
 * THE TAIL HAS SWUNG PAST. Nothing more is added; the wall ages and stops
 * whatever reaches it until it is gone.
 *
 * Sealed explicitly rather than left to expire on its own, because "the tail
 * stopped laying" and "the goo has dissolved" are two different moments and
 * the wall is live between them — which is most of the time it exists.
 */
export function sealGooWall(wall) {
  if (wall) wall.laying = false;
  return wall;
}

/**
 * ONE LOBE OF THE MASS, thrown off the tail where the tail is.
 *
 * Thrown SLOWLY and dragged hard (the emitter's own ranges) so it stays where
 * it was put: a blob that flies out of the line is a blob that has left the
 * wall, and this mass only has half a second to be one.
 *
 * See [[goo scale is size and speed together]] for why the emitter's `size`
 * and `speed` are the pair that set the mass's scale, and why the group's
 * radius and iso are not — those describe the SURFACE and, here, the
 * cohesion.
 */
function blob(wall, x, y, vx = 0, vy = 0) {
  const c = cfg();
  emit(c.emitter ?? 'gooWall', x, y, {
    scale: c.blobScale ?? 1,
    sizeMul: c.blobSize ?? 1,
    speedMul: c.blobSpeed ?? 1,
    // THE MOTION IT WAS THROWN WITH — the fluke's, plus the animal's own. The
    // emitter's `inherit` decides how much of it each lobe keeps, and the
    // emitter's drag is what brings it back to rest inside the wall it belongs
    // to. See the note on `inherit` in CONFIG.sealFlip.back.
    vx,
    vy,
  });
}

/**
 * HOW FAR A POINT IS INSIDE ONE WALL, or null when it is not.
 *
 * Returns a held `{ depth, nx, ny, side }` — how deep into the slab, the
 * wall's normal, and which side the point is on (+1 along the normal, -1
 * behind). The caller pushes out along `side * n`, which is what keeps a body
 * on the side it arrived from rather than popping it through.
 *
 * @param r  the body's own radius. A wall stops a yacht further out than a
 *           sardine, for the same reason the tail does.
 */
const _in = { depth: 0, nx: 0, ny: 0, side: 1 };
export function insideWall(wall, px, py, r = 0) {
  if (!wall || wall.life <= 0) return null;
  const n = wall.nodes?.length ?? 0;
  if (!n) return null;
  const reach = wall.thick + r;

  // THE NEAREST POINT ON THE ARC, walked segment by segment. A polyline of a
  // few dozen nodes tested per body per frame is nothing next to what the
  // creature list already costs, and the alternative — fitting a chord to the
  // arc and colliding that — is a hitbox that stops agreeing with the goo the
  // moment the wall bends, which is always.
  let bestD = Infinity;
  let bx = 0;
  let by = 0;
  if (n === 1) {
    bx = wall.nodes[0].x;
    by = wall.nodes[0].y;
    bestD = Math.hypot(px - bx, py - by);
  } else {
    for (let i = 0; i < n - 1; i++) {
      const a = wall.nodes[i];
      const b = wall.nodes[i + 1];
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const len2 = ex * ex + ey * ey;
      const t = len2 > 1e-9
        ? Math.max(0, Math.min(1, ((px - a.x) * ex + (py - a.y) * ey) / len2))
        : 0;
      const cx = a.x + ex * t;
      const cy = a.y + ey * t;
      const d = Math.hypot(px - cx, py - cy);
      if (d < bestD) { bestD = d; bx = cx; by = cy; }
    }
  }
  if (bestD > reach) return null;

  _in.depth = reach - bestD;
  // THE NORMAL POINTS AT THE BODY, out of the surface it is touching — which
  // is the honest normal for a curve (a slab's two-sided normal has no meaning
  // on an arc) and is what lets the caller push straight out along it.
  //
  // A body sitting EXACTLY on the line has no direction to be pushed in, so it
  // falls back to the way the animal was facing when it threw the wall. That
  // is a real case and not a theoretical one: a fish swimming dead into the
  // middle of a node is centred on it within a hundredth of a unit.
  if (bestD > 1e-4) {
    _in.nx = (px - bx) / bestD;
    _in.ny = (py - by) / bestD;
  } else {
    // EXACTLY ON THE LINE, which has no direction of its own. Away from the
    // ANIMAL that threw the wall is the answer for the shape this actually is:
    // the arc bows around the seal, so radially outward is out of it. The
    // facing is the last resort, for a body standing on the seal as well as on
    // the wall.
    //
    // It was the facing alone at first, and on a curve that is wrong in a way
    // that looks right: a body pushed along the facing from the middle of a
    // bowed wall travels straight into the far half of the same arc and is
    // still inside it.
    const ox = px - wall.x;
    const oy = py - wall.y;
    const olen = Math.hypot(ox, oy);
    if (olen > 1e-4) { _in.nx = ox / olen; _in.ny = oy / olen; }
    else { _in.nx = wall.nx; _in.ny = wall.ny; }
  }
  // Always 1 now: the normal above already points the way out. Kept in the
  // shape because both callers multiply by it, and a caller that had to know
  // which kind of wall it was holding would be a caller that gets it wrong.
  _in.side = 1;
  return _in;
}

/**
 * THE FIRST WALL A BODY IS INSIDE, or null. For the ball, which wants to know
 * it hit something and does its own bounce (systems/versus.js owns what a
 * restitution is on this ball and there must not be a second opinion).
 */
export function wallUnder(px, py, r = 0) {
  for (const wall of gooWalls) {
    const hit = insideWall(wall, px, py, r);
    if (hit) return { wall, ...hit };
  }
  return null;
}

/**
 * One frame. Ages every wall, drops the dead ones, and stops whatever is
 * standing in a live one.
 *
 * @param dt       seconds — the WATER's, not wall time. A wall is part of the
 *                 fight: a hit-stop should hold it exactly as it holds
 *                 everything else it is drawn beside, unlike the gesture that
 *                 threw it (see systems/sealFlip.js on why THAT clock is wall
 *                 time).
 * @param enemies  the live creature list. Each is stopped at most once per
 *                 wall; a boss takes a daze instead (systems/control.js).
 */
export function updateGooWalls(dt, enemies = null) {
  if (!gooWalls.length) return 0;
  const c = cfg();
  let stopped = 0;

  for (let i = gooWalls.length - 1; i >= 0; i--) {
    const wall = gooWalls[i];
    wall.life -= dt;
    if (wall.life <= 0) { gooWalls.splice(i, 1); continue; }
    if (!enemies?.length) continue;

    for (const e of enemies) {
      if (!e?.mesh || wall.hits.has(e)) continue;
      const hit = insideWall(wall, e.mesh.position.x, e.mesh.position.y, e.radius ?? 0);
      if (!hit) continue;
      wall.hits.add(e);
      // OUT THE WAY IT CAME. The push is a position write and not a velocity
      // one on purpose: a hunter re-derives its velocity from its heading
      // every frame, so a shove written into vx/vy is gone before it moves
      // anything (see the header).
      // ...WITH A SKIN ON IT. Pushed out by exactly `depth` the body lands ON
      // the boundary, which the test above still counts as inside — so it sits
      // there re-qualifying every frame and the ledger is the only thing
      // stopping it being re-held. A hundredth of a unit clear is the
      // difference between a body that left the wall and one that is leaning
      // against it.
      const out = hit.depth + (c.skin ?? 0.01);
      e.mesh.position.x += hit.nx * hit.side * out;
      e.mesh.position.y += hit.ny * hit.side * out;
      // ...AND IT STOPS. Through the game's one hold, so the boss rule, the
      // scenery rule and the daze all apply without this file knowing they
      // exist.
      holdEnemy(e, Math.max(0, c.hold ?? 0.35));
      stopped++;
      gooWallState.stopped++;
      gooWallState.last = { x: e.mesh.position.x, y: e.mesh.position.y };
      feedback('sealFlipWallHit', {
        x: e.mesh.position.x, y: e.mesh.position.y,
        dirX: hit.nx * hit.side, dirY: hit.ny * hit.side,
        scale: 1,
      });
    }
  }
  return stopped;
}

/**
 * Has this wall already stopped `key`, and book it if not — for the ball,
 * which is not in the enemy list and so cannot be caught by the loop above.
 */
export function claimWallHit(wall, key) {
  if (!wall || !key || wall.hits.has(key)) return false;
  wall.hits.add(key);
  return true;
}

/** How solid a wall looks right now, 0..1 — for anything drawing it. */
export function wallFade(wall) {
  if (!wall || wall.maxLife <= 0) return 0;
  return Math.max(0, Math.min(1, wall.life / wall.maxLife));
}
