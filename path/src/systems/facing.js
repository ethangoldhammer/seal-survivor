import { CONFIG } from '../config.js';
import { ease } from '../ease.js';

// ---------------------------------------------------------------------------
// WHICH WAY A BODY IS POINTED, and how long it takes to change its mind.
//
// This game is side-on, so "facing" is one bit: a body is either pointed at
// world +X or at world -X, and turning round is a 180-degree rotation about Y.
// Every system that had a body which could change direction wrote the same
// line —
//
//     visual.rotation.y = vx < 0 ? Math.PI : 0;
//
// — and that line is a forty-metre boat, or a six-metre shark, changing ends
// between two frames. It is invisible on a small fast fish and increasingly
// silly the bigger and slower the animal is, which is exactly backwards: the
// things it looks worst on are the things the player is watching.
//
// So the heading is EASED, over a duration rather than at a rate, because a
// turn is a manoeuvre with a beginning and an end rather than a constant swing.
//
// THE STATE LIVES ON THE OBJECT (`userData.__face`) rather than in the caller,
// which is what keeps every call site a single line and is the only reason this
// was worth sharing. It also has to survive POOLING: creature bodies are
// recycled (see acquireVisual), and resetVisual puts every node back to its
// rest transform without touching userData — so a reused body would arrive
// facing +X while its old state still claimed PI, and lerp a full turn on its
// first frame alive. That is caught below by comparing the stored angle against
// the rotation actually on the object: if something else has written it, the
// new heading is taken WITHOUT a turn, which is also the right answer for a
// creature's first frame.
// ---------------------------------------------------------------------------

function cfg() {
  return CONFIG.facing ?? {};
}

const LEFT = Math.PI;
const RIGHT = 0;

/**
 * Point `obj` along `dirX` and ease it there.
 *
 * @param dirX  signed travel; anything inside the deadzone keeps the heading
 *              the body already has, so a body drifting to a stop does not
 *              wander between two answers.
 * @param dt    seconds.
 * @param opts  { time, curve, dead } — each falling back to CONFIG.facing.
 * @returns the facing record: { at, from, to, t }. `at` is the angle written;
 *          `from`/`to` say which way the turn is going, which is what a caller
 *          needs to lean or swing a hull into it (see systems/bossBoat.js).
 */
export function faceSide(obj, dirX, dt, opts = {}) {
  const c = cfg();
  const dead = opts.dead ?? c.deadzone ?? 0.05;
  const time = Math.max(0.001, opts.time ?? c.time ?? 0.4);
  const curve = opts.curve ?? c.curve ?? 'inOutCubic';

  let s = obj.userData.__face;
  // Nobody has claimed this rotation yet, or somebody else has written it since
  // the last call — a pooled body handed back at rest, a system that snapped it
  // directly. Either way the stored turn describes a body that no longer
  // exists, so take the heading outright rather than turning to it.
  if (!s || Math.abs(obj.rotation.y - s.at) > 1e-4) {
    const to = dirX < -dead ? LEFT : (dirX > dead ? RIGHT : (s?.to ?? obj.rotation.y));
    s = { at: to, from: to, to, t: 1 };
    obj.userData.__face = s;
    obj.rotation.y = to;
    return s;
  }

  const want = dirX < -dead ? LEFT : (dirX > dead ? RIGHT : s.to);
  if (want !== s.to) {
    // From where the body actually is, not from the heading it was last given:
    // a turn reversed halfway through has to continue from here, or it snaps
    // back to square one to begin the new one.
    s.from = s.at;
    s.to = want;
    s.t = 0;
  }
  if (s.t < 1) {
    s.t = Math.min(1, s.t + dt / time);
    s.at = s.from + (s.to - s.from) * ease(curve, s.t);
    obj.rotation.y = s.at;
  }
  return s;
}

/**
 * Point `obj` along `dirX` with no turn at all — for a body being placed rather
 * than steered: a boat sailing in from off-screen already has a heading, and
 * watching it rotate into one as it arrives would be a boat that spawned
 * backwards.
 */
export function snapSide(obj, dirX) {
  const to = dirX < 0 ? LEFT : RIGHT;
  obj.rotation.y = to;
  obj.userData.__face = { at: to, from: to, to, t: 1 };
  return to;
}
