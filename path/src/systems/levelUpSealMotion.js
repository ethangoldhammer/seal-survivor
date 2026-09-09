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
//                     card     the hovered card; with nothing hovered, the
//                              state's OWN card (card1's is card 1, fading
//                              out or scrubbed), and the hand for the idle
//                     cursor   the pointer, when it is over a card; else the
//                              pointer where it was, else `card`
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
// LANDING POINTS, NOT LOOPS. That is what ships now: a state is ONE pose —
//
//   jaw       0..1, how far the mouth is held open in this state — crossfaded
//             with the rest, driven through the seal's bite rig (the pick
//             snaps it on top: CONFIG.levelUpSeal.jaw)
//   land      where the body's centre goes: an anchor (`card`, `card1..3`,
//             `row` — the middle of the row's crown line — or `free`, the
//             viewport itself) plus an offset in viewport fractions, exactly
//             as a look or fin target is written
//   heading, roll, look, fins   as a keyframe's
//
// and the SWIM RIG takes the body there: the puppet hands the wanted state's
// point to the run's own physics (CONFIG.player thrust, friction, maxSpeed,
// turnLerp — the `pull` in systems/levelUpSeal.js) and the animal swims to
// it, banks, slows over the last `arrive` body lengths and stops. A hover
// change moves the point and the seal sets off again from wherever it is;
// nothing is lerped. The look, fins, heading and roll still crossfade by
// the state weights below, so the head glides between targets while the
// body swims. A state with `keys` is a loop as before, evaluated and
// lerped the old way — kept so a loop can still be written, not what the
// file uses.
//
// TWO SETS, ONE PER SHAPE OF SCREEN. The four states above are the
// LANDSCAPE set (`states` in the file): three cards in a row, the seal under
// them. A phone held upright stacks the cards into one column down the middle
// of the screen (ui/upgradeComb.js fitCards), and under that column is the
// bottom edge — a seal composed "below the row" is a head poking up from
// under the last card, looking up. So a portrait screen has a set of its own
// (`portrait` in the file, the same four states) written to drift up and down
// the SIDE columns the stacked hand leaves empty, and its y is measured
// differently:
//
//   space   'crown'      y in body lengths below the row's crown line — the
//                        landscape set's unit, where the row is the thing
//                        the seal is composed against.
//           'viewport'   y a fraction of the viewport HEIGHT from the top —
//                        the portrait set's, where the seal has the whole
//                        height of the screen and the row's line is the
//                        bottom edge.
//   entryX  the column (fraction of the viewport width) the arrival swim
//           rises in and the exit leaves from. Unset, that is the centre
//           line, as it always was — set, the seal never comes up from under
//           the cards at all.
//   pull    optional overrides on CONFIG.levelUpSeal.pull for this set —
//           `standoff` and `arrive`, in body lengths. The row's standoff is
//           tuned for a screen with room beside a card; on a phone it is
//           wider than the side column, and a pull that holds off the card
//           by more than the column has swims the seal off the edge.
//
// The set is chosen by the FRAME (setFor): `frame.portrait`, which the puppet
// reads off the screen — taller than wide, or a hand laid out as a column.
// The blender switches sets whole: an orientation change mid-screen re-lays
// the cards out with a cut, and the seal cuts to its other set with them.
//
// A pure module: evaluate() is handed a wanted state, a dt, and a resolver
// for anchors in screen pixels, and returns the pose in screen pixels. The
// puppet (systems/levelUpSeal.js) is what turns that into a body; the
// harness (tools/level-up-seal-motion-test.mjs) drives this alone.
// ---------------------------------------------------------------------------

export const STATES = ['idle', 'card1', 'card2', 'card3'];
export const ANCHORS = ['card', 'cursor', 'card1', 'card2', 'card3', 'row', 'self', 'nose', 'free', 'none'];
// What a landing point may be anchored to — its own centre would be circular.
export const LAND_ANCHORS = ['card', 'card1', 'card2', 'card3', 'row', 'free'];

/** A landing-point state (one pose the swim goes to) rather than a loop. */
export function isLanding(state) {
  return !!state?.land && !(state.keys?.length > 0);
}
export const EASES = ['linear', 'smoothstep', 'smootherstep', 'inOutQuad', 'inOutCubic', 'outQuad', 'outCubic', 'inCubic', 'outBack'];
export const SETS = ['landscape', 'portrait'];
export const SPACES = ['crown', 'viewport'];

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

/** Which set a frame wants: 'portrait' or 'landscape'. */
export function setKeyFor(frame) {
  return frame?.portrait ? 'portrait' : 'landscape';
}

/**
 * The set a frame plays — `{ key, states, space, entryX }` — resolved from the
 * data. The landscape set is the file's top-level `states` (space 'crown', no
 * entryX, exactly the file as it was before there were sets); the portrait set
 * is `portrait`, falling back to the landscape one when the file has none, so
 * a phone with no portrait loops written yet gets the row's rather than
 * nothing.
 */
export function setFor(frame, d = data) {
  const key = setKeyFor(frame);
  const p = key === 'portrait' ? d?.portrait : null;
  if (p?.states) {
    return {
      key,
      states: p.states,
      space: SPACES.includes(p.space) ? p.space : 'viewport',
      entryX: Number.isFinite(p.entryX) ? p.entryX : null,
      pull: p.pull && typeof p.pull === 'object' ? p.pull : null,
    };
  }
  return { key: 'landscape', states: d?.states ?? {}, space: 'crown', entryX: null, pull: null };
}

/** The states object the frame's set edits — the look page writes into this. */
export function statesFor(frame, d = data) {
  return setFor(frame, d).states;
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
export function resolveTarget(t, resolve, frame, forState = null) {
  if (!t || t.anchor === 'none') return { x: 0, y: 0, on: false };
  const dx = (t.x ?? 0) * frame.w;
  const dy = (t.y ?? 0) * frame.h;
  if (t.anchor === 'free') return { x: dx, y: dy, on: true };
  // WHICH STATE IS ASKING. `card` and `cursor` mean different points to
  // different loops once nothing is hovered: to the fading `card1` they are
  // still card 1, to the idle they are the hand. Resolved per state, an
  // unhover is a glide between those two points by the crossfade's own
  // weights; resolved once for whatever is wanted, the fading loop's target
  // jumped from its card to the hand's centre on the frame the hover ended
  // — a flipper and a head snapping a quarter of the screen in one frame.
  const a = resolve(t.anchor, forState);
  if (!a) return { x: 0, y: 0, on: false };
  return { x: a.x + dx, y: a.y + dy, on: true };
}

/**
 * One state's loop at time `t`, in screen pixels. Two keys bracket the time,
 * the last wrapping to the first over what is left of the loop; a single key
 * is a still.
 */
export function evaluateState(state, t, resolve, frame, name = null) {
  if (isLanding(state)) return evaluateLanding(state, resolve, frame, name);
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
    jaw: lerp(a.jaw ?? 0, b.jaw ?? 0, e),
    look: blendTarget(targetOf(a, 'look'), targetOf(b, 'look'), 'out', e, resolve, frame, name),
    fins: {
      left: blendTarget(targetOf(a, 'left'), targetOf(b, 'left'), 'w', e, resolve, frame, name),
      right: blendTarget(targetOf(a, 'right'), targetOf(b, 'right'), 'w', e, resolve, frame, name),
    },
  };
  return out;
}

/**
 * A landing state's pose, in screen pixels. `land` is the point the swim
 * goes to (`on` false when its anchor cannot be placed this frame — the
 * puppet then holds where it is); x and y are the same point, so a caller
 * that reads a loop's x/y reads a landing's too.
 */
export function evaluateLanding(state, resolve, frame, name = null) {
  const pt = resolveTarget(state.land, resolve, frame, name);
  const a = state;
  return {
    x: pt.x,
    y: pt.y,
    land: { x: pt.x, y: pt.y, on: pt.on },
    heading: a.heading ?? 0,
    roll: a.roll ?? 0,
    jaw: a.jaw ?? 0,
    look: blendTarget(targetOf(a, 'look'), targetOf(a, 'look'), 'out', 0, resolve, frame, name),
    fins: {
      left: blendTarget(targetOf(a, 'left'), targetOf(a, 'left'), 'w', 0, resolve, frame, name),
      right: blendTarget(targetOf(a, 'right'), targetOf(a, 'right'), 'w', 0, resolve, frame, name),
    },
  };
}

// Two targets blended: both resolved to pixels first, so a change of anchor
// between keys is a glide from one point to the other rather than a jump.
// The strength (`out` for the head, `w` for a fin) lerps with them; a `none`
// on either side is strength 0 there, so a limb handed back lets go on the
// same curve.
function blendTarget(ta, tb, key, e, resolve, frame, name) {
  const pa = resolveTarget(ta, resolve, frame, name);
  const pb = resolveTarget(tb, resolve, frame, name);
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
  // THE TIMED BLEND's ramps: where each weight set off from and how far along
  // it is. Restarted from the current weight whenever the wanted state
  // changes, so a change mid-blend is a new ramp from where it is.
  const ramps = Object.fromEntries(STATES.map((s) => [s, { from: weights[s], t: 1e9 }]));
  let wanted = 'idle';
  let pinned = null; // { state, t } — the look page scrubbing
  let setKey = null; // which set the weights belong to — a switch resets them

  const api = {
    weights,
    clocks,
    get wanted() { return wanted; },
    get pinned() { return pinned; },
    get setKey() { return setKey; },

    /** Force one state at one time — no blend, no clock. Null to release. */
    pin(p) {
      pinned = p ? { state: p.state, t: p.t ?? 0 } : null;
    },

    /** Put every weight where it wants to be, now. The puppet's reset. */
    reset(state = 'idle') {
      for (const s of STATES) { weights[s] = s === state ? 1 : 0; clocks[s] = 0; ramps[s].from = weights[s]; ramps[s].t = 1e9; }
      wanted = state;
      pinned = null;
      setKey = null;
    },

    /**
     * @param want   the state asked for this frame
     * @param dt     wall seconds
     * @param resolve  anchor -> {x, y} px or null
     * @param frame  { w, h } the viewport in px
     * @param blend  how the weights move: a number is a per-second rate (an
     *               exponential ease, no end); `{ rate, time, ease }` with a
     *               `time` above 0 is a TIMED blend — each weight ramps to
     *               its target over `time` seconds along the named curve
     *               (path/src/ease.js), restarting from wherever it is when
     *               the wanted state changes, so there is still nothing to
     *               snap. `rate` is the fallback with `time` 0.
     * @returns the blended pose in px (y in the set's own space — see
     *          `space` on the result), or null with no data.
     */
    evaluate(want, dt, resolve, frame, blend = 4) {
      const rate = typeof blend === 'number' ? blend : (blend?.rate ?? 4);
      const time = typeof blend === 'number' ? 0 : Math.max(0, blend?.time ?? 0);
      const curve = typeof blend === 'number' ? 'smoothstep' : (blend?.ease ?? 'smoothstep');
      const set = setFor(frame);
      const states = set.states;
      // A SET SWITCH IS A CUT. The two sets' loops are in different spaces
      // and different places, and the screen that changed shape under the
      // seal cut its cards to the new layout too — so the weights go
      // straight to the wanted state rather than blending a row's loop into
      // a column's across the two spaces.
      const switched = set.key !== setKey;
      const hadSet = setKey !== null;
      setKey = set.key;
      if (pinned) {
        const st = states[pinned.state];
        for (const s of STATES) weights[s] = s === pinned.state ? 1 : 0;
        const pose = st ? evaluateState(st, pinned.t, resolve, frame, pinned.state) : null;
        if (pose) { pose.space = set.space; pose.set = set.key; }
        return pose;
      }
      // Which state, in THIS set: a state the set has no loop for is its idle.
      const next = STATES.includes(want) && states[want] ? want : 'idle';
      if (next !== wanted) {
        wanted = next;
        if (states[next]?.restart) clocks[next] = 0;
        for (const s of STATES) { ramps[s].from = weights[s]; ramps[s].t = 0; }
      }
      if (switched && hadSet) for (const s of STATES) { weights[s] = s === wanted ? 1 : 0; ramps[s].from = weights[s]; ramps[s].t = 1e9; }
      const k = 1 - Math.exp(-Math.max(0, rate) * dt);
      let sum = 0;
      for (const s of STATES) {
        clocks[s] += dt;
        const target = s === wanted ? 1 : 0;
        if (time > 0) {
          const r = ramps[s];
          r.t += dt;
          const u = Math.min(1, r.t / time);
          weights[s] = r.from + (target - r.from) * ease(curve, u);
        } else {
          weights[s] += (target - weights[s]) * k;
        }
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
        x: 0, y: 0, hx: 0, hy: 0, rx: 0, ry: 0, jaw: 0,
        look: { x: 0, y: 0, s: 0, ws: 0 },
        fins: { left: { x: 0, y: 0, s: 0, ws: 0 }, right: { x: 0, y: 0, s: 0, ws: 0 } },
      };
      let any = false;
      for (const s of STATES) {
        const w = weights[s] / sum;
        if (w <= 0) continue;
        const pose = evaluateState(states[s], clocks[s], resolve, frame, s);
        if (!pose) continue;
        any = true;
        acc.x += pose.x * w;
        acc.y += pose.y * w;
        acc.hx += Math.cos(pose.heading) * w;
        acc.hy += Math.sin(pose.heading) * w;
        acc.rx += Math.cos(pose.roll) * w;
        acc.ry += Math.sin(pose.roll) * w;
        acc.jaw += (pose.jaw ?? 0) * w;
        accTarget(acc.look, pose.look, w);
        accTarget(acc.fins.left, pose.fins.left, w);
        accTarget(acc.fins.right, pose.fins.right, w);
      }
      if (!any) return null;
      // THE LANDING POINT IS THE WANTED STATE'S, WHOLE. The body's place is
      // not a thing to crossfade — the swim carries it — so the point handed
      // out is where the wanted state says to go, this frame, and the puppet
      // sets off for it. Only when the wanted state is a landing; a loop's
      // x/y stay the weighted sum above.
      let land = null;
      if (isLanding(states[wanted])) {
        const pose = evaluateLanding(states[wanted], resolve, frame, wanted);
        land = pose.land;
      }
      // ...AND EVERY WEIGHTED STATE'S POINT BESIDES, so the puppet can blend
      // the point it swims to by these same weights: a card hovered in the
      // middle of the swim to another has the point glide from the one to
      // the other and the swim steer after it, rather than a point that
      // jumps and a seal that brakes, reverses and sets off again.
      const lands = {};
      for (const s of STATES) {
        if (weights[s] <= 0 || !isLanding(states[s])) continue;
        lands[s] = evaluateLanding(states[s], resolve, frame, s).land;
      }
      return {
        x: land ? land.x : acc.x,
        y: land ? land.y : acc.y,
        land,
        lands,
        weights: { ...weights },
        heading: Math.atan2(acc.hy, acc.hx),
        roll: Math.atan2(acc.ry, acc.rx),
        jaw: acc.jaw,
        look: finishTarget(acc.look),
        fins: { left: finishTarget(acc.fins.left), right: finishTarget(acc.fins.right) },
        space: set.space,
        set: set.key,
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
