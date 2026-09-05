import { ease } from '../ease.js';
import authored from '../levelUpSealMotion.json';

// ---------------------------------------------------------------------------
// THE SEAL'S MOTION UNDER THE CARDS — authored, not posed.
//
// The seal under the upgrade hand used to be a bust: swum up, pinned at the
// waist, stood on the crown line and pointed. Now it swims free, and what it
// does is a set of LOOPS written in the level-up look page (npm run
// looks:levelup, the Seal motion panel) and shipped as levelUpSealMotion.json:
//
//   one loop per state   `idle` with nothing pointed at, `card1` / `card2` /
//                        `card3` while that card in the hand is hovered or
//                        selected. Each is a list of keyframes over its own
//                        loop length, and each keyframe is a whole pose:
//
//     x, y        where the animal's centre is — x a fraction of the viewport
//                 width, y in bust heights below the row's crown line
//     heading     radians in the screen plane, 0 = nose up (the run's swimmer)
//     roll        radians about the spine
//     look        a TARGET for the head, plus `out` (0..1 how far it looks
//                 out of the screen at the viewer — the rig's faceOut)
//     fins        a target per flipper, plus `w` (0..1 how much that flipper
//                 points; 0 hands it to the swim clip)
//
//   a target        an ANCHOR plus an offset in viewport fractions:
//                     card     the hovered card (the state's own card in a
//                              preview with nothing hovered)
//                     cursor   the pointer, when it is over a card; else `card`
//                     card1..3 that slot in the hand, hovered or not
//                     self     the seal's own centre
//                     nose     the seal's mouth
//                     free     nothing — x, y are the absolute point
//                     none     no target: the limb to the clip, the head idle
//
// EVERY STATE IS ALWAYS EVALUATED and the output is their WEIGHTED SUM: the
// state that is wanted eases toward weight 1 and the rest toward 0, at
// CONFIG.levelUpSeal.motion.blendRate. That is the whole of the crossfade,
// and the reason there is nothing to snap: a hover that changes mid-blend
// re-aims the weights from wherever they are, an unhover eases back into
// the idle the same way it came, and every loop keeps its own clock so the
// float never restarts under the blend (unless a state asks to, `restart`).
//
// A pure module: evaluate() is handed a wanted state, a dt, and a resolver
// for anchors in screen pixels, and returns the pose in screen pixels. The
// puppet (systems/levelUpSeal.js) is what turns that into a body; the
// harness (tools/level-up-seal-motion-test.mjs) drives this alone.
// ---------------------------------------------------------------------------

export const STATES = ['idle', 'card1', 'card2', 'card3'];
export const ANCHORS = ['card', 'cursor', 'card1', 'card2', 'card3', 'self', 'nose', 'free', 'none'];
export const EASES = ['linear', 'smoothstep', 'smootherstep', 'inOutQuad', 'inOutCubic', 'outQuad', 'outCubic', 'inCubic', 'outBack'];

// The live data. A module-level object rather than a frozen import so the
// look page can edit it in place and the puppet reads the edit on the next
// frame — the page saves the same object back to the file.
let data = clone(authored);

export function motionData() {
  return data;
}

/** Replace the whole set (the look page's reload / reset). */
export function setMotionData(next) {
  data = clone(next);
  return data;
}

export function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

const NONE_TARGET = { anchor: 'none', x: 0, y: 0 };

function targetOf(k, path) {
  const t = path === 'look' ? k.look : k.fins?.[path];
  return t ?? NONE_TARGET;
}

/**
 * A target in screen pixels: `{ x, y, on }` — `on` false for `none` (and for
 * an anchor the resolver cannot place), which the puppet reads as "hand it
 * back". `resolve(anchor)` returns {x, y} in CSS px or null.
 */
export function resolveTarget(t, resolve, frame) {
  if (!t || t.anchor === 'none') return { x: 0, y: 0, on: false };
  const dx = (t.x ?? 0) * frame.w;
  const dy = (t.y ?? 0) * frame.h;
  if (t.anchor === 'free') return { x: dx, y: dy, on: true };
  const a = resolve(t.anchor);
  if (!a) return { x: 0, y: 0, on: false };
  return { x: a.x + dx, y: a.y + dy, on: true };
}

/**
 * One state's loop at time `t`, in screen pixels. Two keys bracket the time,
 * the last wrapping to the first over what is left of the loop; a single key
 * is a still.
 */
export function evaluateState(state, t, resolve, frame) {
  const keys = state?.keys ?? [];
  if (!keys.length) return null;
  const loop = Math.max(0.01, state.loop ?? 1);
  const time = ((t % loop) + loop) % loop;
  // The bracketing pair.
  let i = keys.length - 1;
  for (let k = 0; k < keys.length; k++) if (keys[k].t <= time) i = k; else break;
  if (keys[0].t > time) i = keys.length - 1;
  const a = keys[i];
  const b = keys[(i + 1) % keys.length];
  let span; let into;
  if (keys.length === 1) { span = 1; into = 0; } else if ((i + 1) % keys.length === 0 || b.t <= a.t) {
    // wrapping: from the last key round to the first
    span = loop - a.t + b.t;
    into = time >= a.t ? time - a.t : loop - a.t + time;
  } else { span = b.t - a.t; into = time - a.t; }
  const u = span > 1e-6 ? Math.max(0, Math.min(1, into / span)) : 0;
  const e = ease(a.ease ?? 'smoothstep', u);

  const out = {
    x: lerp(a.x ?? 0.5, b.x ?? 0.5, e) * frame.w,
    y: lerp(a.y ?? 0, b.y ?? 0, e),
    heading: lerpAngle(a.heading ?? 0, b.heading ?? 0, e),
    roll: lerpAngle(a.roll ?? 0, b.roll ?? 0, e),
    look: blendTarget(targetOf(a, 'look'), targetOf(b, 'look'), 'out', e, resolve, frame),
    fins: {
      left: blendTarget(targetOf(a, 'left'), targetOf(b, 'left'), 'w', e, resolve, frame),
      right: blendTarget(targetOf(a, 'right'), targetOf(b, 'right'), 'w', e, resolve, frame),
    },
  };
  return out;
}

// Two targets blended: both resolved to pixels first, so a change of anchor
// between keys is a glide from one point to the other rather than a jump.
// The strength (`out` for the head, `w` for a fin) lerps with them; a `none`
// on either side is strength 0 there, so a limb handed back lets go on the
// same curve.
function blendTarget(ta, tb, key, e, resolve, frame) {
  const pa = resolveTarget(ta, resolve, frame);
  const pb = resolveTarget(tb, resolve, frame);
  const sa = pa.on ? (ta[key] ?? 1) : 0;
  const sb = pb.on ? (tb[key] ?? 1) : 0;
  const s = lerp(sa, sb, e);
  let x; let y;
  if (pa.on && pb.on) { x = lerp(pa.x, pb.x, e); y = lerp(pa.y, pb.y, e); } else if (pa.on) { x = pa.x; y = pa.y; } else { x = pb.x; y = pb.y; }
  return { x, y, s, on: (pa.on || pb.on) && s > 1e-4 };
}

/**
 * THE BLENDER — every state's loop, weighted. Create one per puppet.
 */
export function createMotionBlender() {
  const clocks = Object.fromEntries(STATES.map((s) => [s, 0]));
  const weights = Object.fromEntries(STATES.map((s) => [s, s === 'idle' ? 1 : 0]));
  let wanted = 'idle';
  let pinned = null; // { state, t } — the look page scrubbing

  const api = {
    weights,
    clocks,
    get wanted() { return wanted; },
    get pinned() { return pinned; },

    /** Force one state at one time — no blend, no clock. Null to release. */
    pin(p) {
      pinned = p ? { state: p.state, t: p.t ?? 0 } : null;
    },

    /** Put every weight where it wants to be, now. The puppet's reset. */
    reset(state = 'idle') {
      for (const s of STATES) { weights[s] = s === state ? 1 : 0; clocks[s] = 0; }
      wanted = state;
      pinned = null;
    },

    /**
     * @param want   the state asked for this frame
     * @param dt     wall seconds
     * @param resolve  anchor -> {x, y} px or null
     * @param frame  { w, h } the viewport in px
     * @param rate   the weights' ease, per second
     * @returns the blended pose in px, or null with no data.
     */
    evaluate(want, dt, resolve, frame, rate = 4) {
      const states = data?.states ?? {};
      if (pinned) {
        const st = states[pinned.state];
        for (const s of STATES) weights[s] = s === pinned.state ? 1 : 0;
        return st ? evaluateState(st, pinned.t, resolve, frame) : null;
      }
      const next = STATES.includes(want) && states[want] ? want : 'idle';
      if (next !== wanted) {
        wanted = next;
        if (states[next]?.restart) clocks[next] = 0;
      }
      const k = 1 - Math.exp(-Math.max(0, rate) * dt);
      let sum = 0;
      for (const s of STATES) {
        clocks[s] += dt;
        weights[s] += ((s === wanted ? 1 : 0) - weights[s]) * k;
        // A tail under a thousandth is let go outright — otherwise a fading
        // state keeps a target "on" at a strength nothing can see.
        if (weights[s] < 1e-3 && s !== wanted) weights[s] = 0;
        sum += weights[s];
      }
      if (sum <= 1e-9) { weights[wanted] = 1; sum = 1; }

      // The weighted sum. Headings and rolls through vectors so a blend
      // across the seam goes the short way; targets and strengths as points
      // and numbers, which is what makes an unhover a glide back rather than
      // a cut — the head's target slides from the card to wherever the idle
      // is looking, and its strength with it.
      const acc = {
        x: 0, y: 0, hx: 0, hy: 0, rx: 0, ry: 0,
        look: { x: 0, y: 0, s: 0, ws: 0 },
        fins: { left: { x: 0, y: 0, s: 0, ws: 0 }, right: { x: 0, y: 0, s: 0, ws: 0 } },
      };
      let any = false;
      for (const s of STATES) {
        const w = weights[s] / sum;
        if (w <= 0) continue;
        const pose = evaluateState(states[s], clocks[s], resolve, frame);
        if (!pose) continue;
        any = true;
        acc.x += pose.x * w;
        acc.y += pose.y * w;
        acc.hx += Math.cos(pose.heading) * w;
        acc.hy += Math.sin(pose.heading) * w;
        acc.rx += Math.cos(pose.roll) * w;
        acc.ry += Math.sin(pose.roll) * w;
        accTarget(acc.look, pose.look, w);
        accTarget(acc.fins.left, pose.fins.left, w);
        accTarget(acc.fins.right, pose.fins.right, w);
      }
      if (!any) return null;
      return {
        x: acc.x,
        y: acc.y,
        heading: Math.atan2(acc.hy, acc.hx),
        roll: Math.atan2(acc.ry, acc.rx),
        look: finishTarget(acc.look),
        fins: { left: finishTarget(acc.fins.left), right: finishTarget(acc.fins.right) },
      };
    },
  };
  return api;
}

// A target's point is averaged by its STRENGTH-weighted share, so a state
// whose limb is handed back (strength 0) does not drag the pointing one's
// target toward a meaningless point; the strength itself is the plain
// weighted mean, so it eases to 0 with the state.
function accTarget(acc, t, w) {
  acc.s += t.s * w;
  const ws = t.on ? t.s * w : 0;
  acc.x += t.x * ws;
  acc.y += t.y * ws;
  acc.ws += ws;
}

function finishTarget(acc) {
  const on = acc.ws > 1e-6 && acc.s > 1e-3;
  return { x: on ? acc.x / acc.ws : 0, y: on ? acc.y / acc.ws : 0, s: acc.s, on };
}
