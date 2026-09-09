import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { ease } from '../ease.js';
import { createVisual, addOutlineShells, setOutlineThicknessOn } from '../assets.js';
import { createAnimationController, stateForSpeed } from './animation.js';
import { createAimRig } from './aimRig.js';
import { createBustPin, measureBust, bustPlumb, bustAim } from './splashBust.js';
import { createEyePair, createEyeLights, updateEyeLights } from './eyeLights.js';
import { accessoryTurn, dressBody } from './accessories.js';
import { CARD_FOCUS_EVENT } from '../ui/cardFocus.js';
import { feedback } from './feedback.js';
import { createMotionBlender, setFor as motionSetFor } from './levelUpSealMotion.js';
import { createLevelUpBubbles } from './levelUpBubbles.js';
import { createJawDriver } from './jaw.js';
import { ASSETS } from '../assets.js';

// ---------------------------------------------------------------------------
// THE SEAL UNDER THE HAND.
//
// While the upgrade cards are up, the main menu's bust swims up from below
// them, plants itself under the row, and watches whichever card the player is
// pointing at. The moment one is taken it shoots off the top of the screen.
//
// IT IS A SECOND SEAL, ON A CANVAS OF ITS OWN. The obvious animal — the run's
// (entities/player.js), which the main menu reuses so well — is mid-arena,
// saluting its level (systems/celebrate.js), and the cards sit on a honeycomb
// that is a near-opaque scrim over the whole fight (CONFIG.upgradeComb:
// restAlpha 0.9 at a layer opacity of 0.75). Anything drawn into the game's
// canvas is behind that scrim, and the game's canvas is behind the cards too.
// So this is a throwaway seal — the same model, rig, pin, rim and eyes the
// menu poses, built once and kept — in a scene of its own, drawn by a second
// renderer into a transparent canvas that sits between the comb and the cards
// (ui/ui.js, `.sv-levelup-seal`). A second GL context is the honest price of
// being on top of a DOM layer; the canvas is a column and not the viewport,
// so the fill it costs is the animal's.
//
// WHAT IT REUSES, which is nearly everything and on purpose:
//
//   the pose        systems/splashBust.js — the waist pin, the plumb, the aim
//                   remapped through the bust's spread. The pin is applied
//                   with a WEIGHT here (the one thing added to that file), so
//                   the animal can arrive swimming and plant over a few frames
//                   rather than its tail going straight on one.
//   the look        systems/aimRig.js — the run's own head and flipper IK. A
//                   card's centre is handed to bustAim exactly as the menu
//                   hands it the cursor, and the rig's new `finGate` picks
//                   which ONE flipper joins the head in pointing at it.
//   the swim        the run's, on the way in and out: heading up, the swim or
//                   boost clip picked from the actual speed (stateForSpeed),
//                   fins at the rig's idle weight, the waist free — and the
//                   strike's barrel roll on the exit (CONFIG.strike.roll's
//                   shape, this file's turns).
//   the hat         systems/accessories.js dressBody — the slot's accessory,
//                   placed on this body at the same angle as the player's,
//                   without touching the one-slot record that belongs to the
//                   player's.
//   the eyes        systems/eyeLights.js, as a pair of its own.
//
// EVERYTHING IS IN SCREEN PIXELS. The puppet's world is the viewport: x is the
// CSS pixel from the left, y is MINUS the CSS pixel from the top (three's y is
// up), and the camera is an orthographic window onto that. A card's
// getBoundingClientRect is therefore a world position with a sign flip and
// nothing else, which is what makes "look at that card" a one-liner. The bust
// is measured once at unit scale and scaled to a fraction of the viewport
// height every frame, so a resize re-composes it for free.
//
// TWO HALVES, and the split is what makes it testable: createLevelUpPuppet is
// the animal and its motion — no DOM, no renderer, driven by a frame it is
// handed — and the module-level functions below are the canvas, the rects and
// the wiring. tools/level-up-seal-test.mjs drives the first half on the real
// furseal.glb.
// ---------------------------------------------------------------------------

function cfg() {
  return CONFIG.levelUpSeal ?? {};
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** The toggle. Read live — the tuner can flip it between two hands. */
export function levelUpSealEnabled() {
  return cfg().enabled !== false;
}

const _z = new THREE.Vector3(0, 0, 1);
const _y = new THREE.Vector3(0, 1, 0);
const _look = new THREE.Vector3();

// Everything on the parent chain, averaged per node — the same measure
// outlines.js uses to turn a world thickness into an object-space one, so a
// rim asked for in pixels is that many pixels whatever the holder's scale is.
function accumulatedScale(o) {
  let s = 1;
  for (let n = o; n; n = n.parent) {
    s *= (Math.abs(n.scale.x) + Math.abs(n.scale.y) + Math.abs(n.scale.z)) / 3;
  }
  return s;
}

/**
 * The animal and its motion. No DOM, no renderer.
 *
 * @param body   a createVisual('ship') — this takes ownership of it.
 * @param eyes   build the eye lights (their halo is a canvas texture, which a
 *               Node harness has no 2D context for).
 * @param outline  add the rim shells.
 * @param dress  put the equipped accessory on it.
 */
export function createLevelUpPuppet(body, { eyes = true, outline = true, dress = true } = {}) {
  const holder = new THREE.Object3D();
  holder.add(body);

  const anim = createAnimationController(body);
  const rig = createAimRig(body);
  const pin = createBustPin(body);
  // THE JAW, through the seal's own bite rig (ASSETS.ship.biteRig) — a held
  // gape per state, crossfaded with the pose, and a snap on the pick. The
  // angle is scaled live by CONFIG.levelUpSeal.jaw.openMul.
  const jawRig = ASSETS.ship?.biteRig ? {
    ...ASSETS.ship.biteRig,
    get openAngle() { return (ASSETS.ship.biteRig.openAngle ?? 0.5) * (cfg().jaw?.openMul ?? 1); },
  } : null;
  const jaw = jawRig ? createJawDriver(body, { rig: jawRig, timing: () => cfg().jaw ?? CONFIG.bite?.jaw }) : null;

  // THE RIM. Two shells, as the player's has (systems/outlines.js
  // attachPlayerOutline) — the lit fringe and the ink line inside it — but NOT
  // through that function, which holds the player's shells in a module-level
  // list and would drop them to take these. Thickness is set by fitRim below,
  // in pixels, once the holder's scale is known.
  const pc = CONFIG.playerOutline ?? {};
  const rimShells = outline ? addOutlineShells(body, { color: pc.color ?? 0xffffff, glow: pc.glow ?? 1 }) : [];
  const inkShells = outline ? addOutlineShells(body, { color: pc.inner?.color ?? 0x000000 }) : [];
  for (const shell of inkShells) shell.renderOrder += 0.5;

  let pair = null;
  let eyeGroup = null;
  if (eyes) {
    pair = createEyePair('eyes');
    eyeGroup = createEyeLights(pair);
  }

  // --- the frame it is composed against, in CSS pixels ----------------------
  const frame = {
    w: 1280, h: 720,
    crownLine: 480,       // the y the crown wants to sit on
    centreX: 640,         // where the bust's centre line is
    idle: { x: 640, y: 300 }, // where to look when nothing is pointed at
    cards: [],            // each card's centre, in hand order — the motion's card1..3 anchors
    cursor: null,         // the pointer, when there is one — the motion's cursor anchor
    // A SCREEN TALLER THAN WIDE, or a hand laid out as a column: the motion's
    // portrait set plays (systems/levelUpSealMotion.js setFor) — loops that
    // drift the side columns a stacked hand leaves empty, with y measured
    // over the whole viewport rather than below the row's line, and an
    // arrival that rises in a side column rather than up from under the
    // cards.
    portrait: false,
  };

  const state = {
    phase: 'none', // none | wait | in | held | out
    t: 0,
    crownY: 0,     // where the crown IS, this frame, in CSS px from the top
    fromY: 0,
    toY: 0,
    // THE PLANT, 0..1 — 0 is the run's swimmer (heading up, waist free, fins
    // at the rig's idle), 1 is the bust (plumb, cant, waist pinned). The pin
    // weight, the body's pose and the fins' engagement all read this one
    // number, so the animal turns from one into the other as a whole.
    plant: 1,
    pinWeight: 1,
    roll: 0,       // the exit's barrel roll, radians about the spine
    bobClock: 0,   // seconds into the idle bob
    bob: 0,        // this frame's bob, px (up is negative — screen y)
    sway: 0,       // ...and its sideways drift, px
    tilt: 0,       // ...and its cant, radians
    speed: 0,      // this frame's vertical speed, in model units per second
    clipSpeed: 0,  // ...low-passed, for picking the clip — see `clipSpeedLerp`
    animState: 'idle',
    finGate: null, // what the rig was handed this frame — [left, right]
    faceOut: 0,    // ...and how far out of the screen the head was asked to look
    reenter: false,
    look: null,    // {x, y, option} in CSS px, or null for the idle look
    scale: 1,      // px per instance unit, this frame
    // THE FOLLOW — the body turning after the cursor, as the run's does after
    // the aim (entities/player.js poseBody): a yaw about the spine and a cant
    // in the screen plane, both eased at `followLerp` and both folded into
    // the bust pose, so the plant blends them out with everything else on
    // the way off. Radians.
    followTurn: 0,
    followLean: 0,
    // THE AUTHORED MOTION (systems/levelUpSealMotion.js), in free mode: how
    // much of it owns the body this frame (eased in once the seal has arrived
    // under the row, out on the pick), which state's loop is wanted, and the
    // last blended pose in screen px — the look page's overlay draws from it.
    motionW: 0,
    motionState: 'idle',
    motionOut: null,
    finAims: null,  // what the rig was handed — one Vector2 per fin, or null
    cx: 0,          // the bust's centre on screen this frame, CSS px
    cy: 0,
    leaveCx: 0,     // where the centre was on the pick — the free exit rises from here
    leaveCy: 0,
    outK: 0,        // the exit's eased fraction this frame
    // THE PULL — the seal swimming toward the hovered card on the run's own
    // physics (CONFIG.player thrust, friction, maxSpeed, turnLerp), as a
    // displacement from the authored loop's point. Screen px and px/s; the
    // heading is the swim's own, in the screen plane, added to the loop's.
    pull: { x: 0, y: 0, vx: 0, vy: 0, heading: 0, speed: 0 },
    // THE LANDING POINT the swim is going to (screen px), when the wanted
    // state is one — the pull's offset is measured from it, and a point
    // that moves (a hover change, the row moving) shifts the offset the
    // other way so the body's place on screen never jumps.
    land: null,
    velX: 0, velY: 0, // the centre's travel last frame, px/s — carried into the swim at arrival
    // THE BODY'S TURN, TIED TO THE SWIM. The authored heading and roll are
    // not reached on the blend's clock but on the LEG's: from where the body
    // was when the point last moved, toward the state's pose, by how much of
    // the swim is done (motion.turnEase over that fraction), settled at
    // motion.turnSettle once there — so the body finishes turning as it
    // arrives, never before. Radians in the screen plane.
    bodyHeading: 0,
    bodyRoll: 0,
    jawOpen: 0,     // the gape handed to the jaw this frame, 0..1
    leg: { fromH: 0, fromR: 0, dist0: 0 },
    // The exit carries the swim's velocity out with it (px/s at the pick).
    leaveVx: 0, leaveVy: 0,
    // Whether a card has been hovered this visit. After one, the idle has
    // no point to return to: a hover-off HOLDS the body where it is and
    // lets the swim settle, rather than sending it back to the entry point.
    visited: false,
    hold: false,
    legState: null, // which state the current leg was started for
  };

  // THE POINT THE SWIM GOES TO, blended: every weighted state's landing
  // point by the crossfade's own weights. A hover change mid-swim moves this
  // smoothly from the old point to the new one, and the swim steers after
  // it. A state whose anchor cannot be placed drops out; with nothing
  // placeable the last point stands.
  function landPoint(mo) {
    const ws = mo.weights ?? {};
    let sx = 0; let sy = 0; let sw = 0;
    for (const name in ws) {
      const w = ws[name];
      if (!(w > 0)) continue;
      const L = mo.lands?.[name];
      if (!L?.on) continue;
      sx += L.x * w; sy += L.y * w; sw += w;
    }
    if (sw > 1e-9) return { x: sx / sw, y: sy / sw, on: true };
    return state.land ? { ...state.land, on: true } : (mo.land ?? { x: state.cx, y: state.cy, on: false });
  }
  const motion = createMotionBlender();
  const _finAimVecs = [new THREE.Vector2(0, 1), new THREE.Vector2(0, 1)];
  const _finLook = new THREE.Vector3();
  const _centreLocal = new THREE.Vector3();
  const _headQ = new THREE.Quaternion();
  const _mouth = new THREE.Vector3();

  const aim = new THREE.Vector2(0, 1);
  const wantAim = new THREE.Vector2(0, 1);
  const _turnQ = new THREE.Quaternion();
  const _plumbQ = new THREE.Quaternion();
  const _leanQ = new THREE.Quaternion();
  const _bustQ = new THREE.Quaternion();
  const _swimQ = new THREE.Quaternion();
  const _rollQ = new THREE.Quaternion();
  const _tiltQ = new THREE.Quaternion();
  let plumb = 0;
  let turn = 0;
  let lastRimScale = -1;

  // `q = Rz(lean) * Ry(turn) * Rz(plumb)`, in that order, for the reason the
  // main menu gives at length: the plumb is a correction measured in profile,
  // about the animal's own lateral axis, and has to turn WITH the animal; the
  // cant is a screen-plane thing and must not.
  function bustPose(out) {
    _leanQ.setFromAxisAngle(_z, (cfg().lean ?? 0.05) + state.followLean);
    _turnQ.setFromAxisAngle(_y, turn + state.followTurn);
    _plumbQ.setFromAxisAngle(_z, plumb);
    return out.copy(_leanQ).multiply(_turnQ).multiply(_plumbQ);
  }

  // THE SWIMMER'S POSE is the run's: a seal swimming straight up is a body on
  // heading +Y, which is exactly the orientation createVisual leaves it in
  // (poseBody in entities/player.js would write rotation.z = 0 for it), plus
  // the accessory's turn. No plumb — that is a correction for STANDING the
  // idle clip's curl up, and a swimmer is not standing.
  function swimPose(out) {
    return out.setFromAxisAngle(_y, turn);
  }

  // --- settle, plumb, measure — once, at build ------------------------------
  // The same sequence mountMainMenu runs, for the same reasons: the rig eases
  // in from zero weight so the first frames are a different animal; the plumb
  // is measured on a settled pose; and standing it up moves the head, which
  // moves the aim, which moves the head, so it settles again. At turn 0, which
  // is the WIDER silhouette, so the box holds every turn a hat can ask for.
  const DT = 1 / 60;
  function settleStep(dt) {
    anim?.update(dt, 'idle', false);
    bustPose(holder.quaternion);
    holder.updateMatrixWorld(true);
    rig?.update(dt, aim, { engaged: true });
    pin?.apply(1);
    holder.updateMatrixWorld(true);
  }
  for (let i = 0; i < 120; i++) settleStep(DT);
  plumb = bustPlumb(pin, rig);
  for (let i = 0; i < 60; i++) settleStep(DT);
  // The box, at unit scale, in the holder's frame (the holder is at the
  // origin, unscaled, for this measurement and only this one). Fins engaged
  // and aimed straight up, so the height sets the scale and the width sets
  // the canvas column with the flippers counted — a flipper raised at a card
  // must never leave the column. Its top is the head (measured: the fin tips
  // sit a hair below the skull at this aim), and that top is what sits on
  // the crown line.
  const bust = measureBust(body, pin);
  if (bust.isEmpty()) bust.setFromObject(body);
  // ...AND THE SWIMMER'S BOX, for free mode: the same animal with the waist
  // let go and the body on its heading (holder identity — nose up), which is
  // a different shape from the bust: longer, and centred somewhere else.
  // Free, the scale is set by the BODY'S LENGTH (`freeHeight` of the
  // viewport) and the turn pivots on this box's centre — the bust's numbers
  // put a horizontal seal half off its spot and twice the size it was meant
  // to be, clipped by a column cut for a standing one.
  pin?.apply(0);
  holder.quaternion.identity();
  holder.updateMatrixWorld(true);
  for (let i = 0; i < 30; i++) { anim?.update(DT, 'idle', false); holder.updateMatrixWorld(true); }
  const swimBox = new THREE.Box3().setFromObject(body);
  const swimLen = Math.max(1e-3, swimBox.max.y - swimBox.min.y);
  const swimCx = (swimBox.min.x + swimBox.max.x) / 2;
  const swimCy = (swimBox.min.y + swimBox.max.y) / 2;
  const swimW = Math.max(1e-3, swimBox.max.x - swimBox.min.x);
  const bustH = Math.max(1e-3, bust.max.y - bust.min.y);
  const bustW = Math.max(1e-3, bust.max.x - bust.min.x);
  const bustCx = (bust.min.x + bust.max.x) / 2;
  const bustCy = (bust.min.y + bust.max.y) / 2;
  const crownTop = bust.max.y;

  /** Free (swimming to the authored loops) or the pinned bust. Read live. */
  function free() {
    return cfg().free !== false;
  }

  // AN ANCHOR IN SCREEN PIXELS, for the authored motion's targets. Null is
  // "cannot be placed this frame", which the evaluator reads as no target.
  function resolveAnchor(name, forState = null) {
    const look = state.look;
    const cards = frame.cards ?? [];
    // With nothing hovered, "the card" is the ASKING state's own slot — the
    // loop being crossfaded out keeps its card, the one being scrubbed in
    // the look page has its own — and the hand's middle for the idle.
    const own = () => {
      const m = /^card([1-3])$/.exec(forState ?? motion.pinned?.state ?? state.motionState);
      return (m && cards[Number(m[1]) - 1]) || frame.idle;
    };
    switch (name) {
      // A CARD STATE'S "card" IS ITS OWN CARD, hovered or not: card1's loop
      // is card 1's, whatever is under the pointer now. Resolved to the
      // hovered card instead, a card hovered mid-blend had the fading
      // state's point leap to the new card too, and the glide between the
      // two points became a jump. The idle's "card" is the hovered one.
      case 'card': {
        const m = /^card([1-3])$/.exec(forState ?? '');
        if (m) return cards[Number(m[1]) - 1] ?? (look ? { x: look.cx ?? look.x, y: look.cy ?? look.y } : null);
        return look ? { x: look.cx ?? look.x, y: look.cy ?? look.y } : own();
      }
      case 'cursor': return look ? { x: look.x, y: look.y } : (frame.cursor ?? own());
      case 'card1': return cards[0] ?? null;
      case 'card2': return cards[1] ?? null;
      case 'card3': return cards[2] ?? null;
      case 'row': return { x: frame.centreX + (cfg().offsetX ?? 0) * frame.w, y: crownTarget() };
      case 'self': return { x: state.cx, y: state.cy };
      case 'nose': {
        const m = rig?.anchors?.mouth;
        return m ? { x: m.x, y: -m.y } : { x: state.cx, y: state.cy };
      }
      default: return null;
    }
  }

  // WHICH FLIPPER IS ON WHICH SIDE OF THE SCREEN, measured on the settled
  // profile rather than assumed from the names: `left`/`right` are the
  // animal's own sides, and which of them faces screen-left depends on how
  // the model was authored and which way the accessory turned it. The one
  // whose shoulder sits further left on screen is the screen-left fin.
  const fins = rig?.fins ?? [];
  const _shoulder = new THREE.Vector3();
  const finScreenX = fins.map((f) => {
    f.bones?.[0]?.getWorldPosition(_shoulder);
    return _shoulder.x;
  });
  const screenLeftFin = finScreenX.length
    ? finScreenX.indexOf(Math.min(...finScreenX))
    : -1;

  // The hat goes on AFTER the settle: its placement reads the bone's world
  // matrix, and the animal has to be standing for that to be the right one.
  const worn = dress ? dressBody(body) : null;
  turn = accessoryTurn();

  // --- the rim, in pixels -----------------------------------------------------
  function fitRim() {
    const c = cfg();
    const rimPx = Math.max(0, c.outlinePx ?? 2);
    const inkPx = Math.max(0, c.inkPx ?? 1);
    for (const shell of rimShells) {
      const s = accumulatedScale(shell);
      shell.visible = rimPx > 0;
      setOutlineThicknessOn(shell.material, s > 1e-6 ? rimPx / s : rimPx);
    }
    for (const shell of inkShells) {
      const s = accumulatedScale(shell);
      shell.visible = inkPx > 0;
      setOutlineThicknessOn(shell.material, s > 1e-6 ? inkPx / s : inkPx);
    }
  }

  /** The bust's height on screen this frame, in px. */
  function heightPx() {
    return Math.max(24, (cfg().height ?? 0.34) * frame.h);
  }

  /** Free: the body's LENGTH on screen, in px — the unit the loops' y is in. */
  function freeLenPx() {
    return Math.max(24, (cfg().freeHeight ?? 0.28) * frame.h);
  }

  // Where the crown line actually is, after the short-screen clamp: the bust
  // may come up BEHIND the cards (it draws under the stage) rather than stay
  // off the bottom when the row runs low.
  function crownTarget() {
    const minVisible = Math.max(0, Math.min(1, cfg().minVisible ?? 0.45));
    return Math.min(frame.crownLine, frame.h - minVisible * heightPx());
  }

  function belowScreen() {
    return frame.h + 0.05 * heightPx();
  }

  function aboveScreen() {
    return -(heightPx() * 1.1);
  }

  /**
   * THE FLIPPER THAT POINTS. A gate per fin for the rig, from CONFIG.fin and
   * where the card is: the pointing fin gets 1, the rest get `finIdle`.
   * Null (no gate at all — both fins at the rig's own weights) for `both`.
   */
  function finGateFor(lookX, option = null) {
    const c = cfg();
    let which = c.fin ?? 'near';
    // BY OPTION: each card has a flipper of its own, whatever side of the
    // screen it happens to sit on — the animal's right for the first, both
    // for the second, its left for the third (CONFIG.levelUpSeal.optionFins).
    // A card past the list, or a look with no card, falls back to `near`.
    if (which === 'option') {
      const byOption = Array.isArray(c.optionFins) ? c.optionFins : ['right', 'both', 'left'];
      which = (option != null && byOption[option]) ? byOption[option] : 'near';
      // `both` here means both POINTING, not the rig's own idle weights.
      if (which === 'both') return fins.map(() => 1);
    }
    if (!fins.length || which === 'both') return null;
    const idle = Math.max(0, Math.min(1, c.finIdle ?? 0));
    const gate = fins.map(() => idle);
    if (which === 'none') return gate;
    let pick = -1;
    if (which === 'left' || which === 'right') {
      pick = fins.findIndex((f) => f.name === which);
    } else if (screenLeftFin >= 0) {
      // The seal's centre line on screen, and which side of it the card is.
      const centre = holder.position.x + bustCx * state.scale;
      const cardLeft = lookX < centre;
      const other = fins.length > 1 ? (screenLeftFin === 0 ? 1 : 0) : screenLeftFin;
      pick = (which === 'far') === cardLeft ? other : screenLeftFin;
    }
    if (pick >= 0) gate[pick] = 1;
    return gate;
  }

  const puppet = {
    holder, body, rig, anim, pin, jaw, eyeGroup, pair, worn,
    bust, bustH, bustW, crownTop, screenLeftFin, swimLen, swimW,
    state, frame, aim,
    get phase() { return state.phase; },
    get active() { return state.phase !== 'none'; },

    /** Tell it the viewport and the row. Every field optional. */
    setFrame(f) {
      Object.assign(frame, f);
      if (f?.idle) frame.idle = { ...f.idle };
      if (f?.cards) frame.cards = f.cards.map((c) => ({ x: c.x, y: c.y }));
      if ('cursor' in (f ?? {})) frame.cursor = f.cursor ? { x: f.cursor.x, y: f.cursor.y } : null;
    },

    /**
     * Point it at a screen position ({x, y} in CSS px), or null for idle.
     * `option` is which card that is (0-based), for the flipper that goes
     * with it — see finGateFor.
     */
    look(at) {
      state.look = at
        ? { x: at.x, y: at.y, cx: at.cx ?? at.x, cy: at.cy ?? at.y, option: at.option ?? null }
        : null;
    },

    /** The authored-motion blender — the look page pins and reads it. */
    motion,
    resolveAnchor,
    /** The row's line, the bust's height and the px-per-unit — for the look page's overlay. */
    metrics() {
      // `unit` is what a loop's y is measured in and `centreOffset` is how far
      // below the crown line y = 0 puts the centre: half a bust for the bust
      // (its crown on the line), nothing for the swimmer (its centre on it).
      // In the portrait set's viewport space the line is the top of the
      // screen and the unit its height, so `crownLine + y * unit` is the
      // same sum for either — the look page's overlay does that sum once.
      const isFree = free();
      const set = motionSetFor(frame);
      const viewport = isFree && set.space === 'viewport';
      return {
        crownLine: viewport ? 0 : crownTarget(),
        unit: viewport ? frame.h : (isFree ? freeLenPx() : heightPx()),
        centreOffset: isFree ? 0 : (bustH * state.scale) / 2,
        heightPx: heightPx(), scale: state.scale, bustH, bustW, swimLen, swimW, free: isFree,
        set: set.key, space: isFree ? set.space : 'crown', entryX: set.entryX,
      };
    },

    /** The cards are up: come up from below. */
    enter() {
      if (!levelUpSealEnabled()) return;
      if (state.phase === 'out') {
        // Mid-exit — a second card in the same batch. Finish leaving, then
        // come back from below; a seal that reversed halfway up the screen
        // would read as a seal that changed its mind.
        state.reenter = true;
        return;
      }
      if (state.phase !== 'none') return;
      state.phase = 'wait';
      state.t = 0;
      state.visited = false;
      state.hold = false;
      state.crownY = belowScreen();
      state.plant = cfg().swimRig === false ? 1 : 0;
      state.pinWeight = state.plant;
      state.roll = 0;
      state.bobClock = 0;
      state.reenter = false;
    },

    /** A card was taken: off the top, fast. */
    leave() {
      state.reenter = false;
      if (state.phase === 'none' || state.phase === 'out') return;
      state.phase = 'out';
      state.t = 0;
      state.fromY = state.crownY;
      state.toY = aboveScreen();
      state.roll = 0;
      // FROM WHERE IT IS, AS IT IS MOVING. The centre (which already holds
      // the swim's offset — zeroed here, or the exit would add it a second
      // time and hop on its first frame) and the velocity it had, which the
      // exit fades out under its own rise so the pick never starts from a
      // dead stop mid-swim.
      state.leaveCx = state.cx;
      state.leaveCy = state.cy;
      state.leaveVx = state.velX;
      state.leaveVy = state.velY;
      // THE SNAP: the pick is a bite.
      if (cfg().jaw?.enabled !== false && cfg().jaw?.biteOnPick) jaw?.bite();
      state.pull.x = 0; state.pull.y = 0; state.pull.vx = 0; state.pull.vy = 0;
      state.outK = 0;
    },

    reset() {
      state.phase = 'none';
      state.t = 0;
      state.reenter = false;
      state.look = null;
      state.land = null;
      state.visited = false; state.hold = false; state.legState = null;
      state.velX = 0; state.velY = 0;
      state.bodyHeading = 0; state.bodyRoll = 0;
      state.leg = { fromH: 0, fromR: 0, dist0: 0 };
      state.jawOpen = 0;
      jaw?.reset();
      state.plant = 1;
      state.pinWeight = 1;
      state.roll = 0;
      state.bob = 0;
      state.sway = 0;
      state.tilt = 0;
      state.finGate = null;
      state.faceOut = 0;
      state.followTurn = 0;
      state.followLean = 0;
      state.motionW = 0;
      state.motionState = 'idle';
      state.motionOut = null;
      state.finAims = null;
      Object.assign(state.pull, { x: 0, y: 0, vx: 0, vy: 0, heading: 0, speed: 0 });
      motion.reset();
      body.quaternion.identity();
    },

    /**
     * One frame, on the WALL clock (this is a screen element, not a body in
     * the dilated water). Returns the phase.
     */
    update(rawDt) {
      if (state.phase === 'none') return state.phase;
      const c = cfg();
      const dt = Math.min(0.05, Math.max(0, rawDt));
      state.t += dt;
      const swimming = c.swimRig !== false;

      // --- where the crown is ---------------------------------------------
      const line = crownTarget();
      const wasY = state.crownY;
      let wantPlant = 1;
      switch (state.phase) {
        case 'wait': {
          state.crownY = belowScreen();
          wantPlant = swimming ? 0 : 1;
          if (state.t >= (c.delay ?? 0.1)) {
            state.phase = 'in';
            state.t = 0;
            state.fromY = state.crownY;
          }
          break;
        }
        case 'in': {
          const T = Math.max(0.05, c.inTime ?? 0.75);
          const k = ease(c.inEase ?? 'outCubic', Math.min(1, state.t / T));
          state.crownY = state.fromY + (line - state.fromY) * k;
          // A swimmer until `plantAt` of the rise, then it starts standing up,
          // so it is the bust by the time it stops rather than stopping and
          // then stiffening.
          wantPlant = !swimming || k >= (c.plantAt ?? 0.6) ? 1 : 0;
          if (state.t >= T) {
            state.phase = 'held';
            state.t = 0;
            state.crownY = line;
          }
          break;
        }
        case 'held': {
          // Follows the row if it moves (a resize, the tooltip pushing the
          // layout) — eased, so a jump in the DOM is a glide here.
          state.crownY += (line - state.crownY) * (1 - Math.exp(-8 * dt));
          break;
        }
        case 'out': {
          const T = Math.max(0.05, c.outTime ?? 0.45);
          const k = ease(c.outEase ?? 'inCubic', Math.min(1, state.t / T));
          state.crownY = state.fromY + (state.toY - state.fromY) * k;
          state.outK = k;
          wantPlant = swimming ? 0 : 1;
          // THE STRIKE'S BARREL ROLL: whole turns about the spine over the
          // first `spinTime` of the exit, on the same smoothstep-shaped curve
          // the strike's roll runs (entities/player.js, `rollAngle`).
          if (c.spin !== false && (c.spinTurns ?? 2) > 0) {
            const spinT = Math.max(0.01, Math.min(1, c.spinTime ?? 1)) * T;
            const st = ease(c.spinEase ?? 'inOutCubic', Math.min(1, state.t / spinT));
            state.roll = (c.spinTurns ?? 2) * Math.PI * 2 * st;
          } else {
            state.roll = 0;
          }
          if (state.t >= T) {
            state.phase = 'none';
            state.t = 0;
            state.roll = 0;
            state.motionW = 0;
            state.motionOut = null;
            state.finAims = null;
            Object.assign(state.pull, { x: 0, y: 0, vx: 0, vy: 0, heading: 0, speed: 0 });
            state.land = null;
            state.legState = null;
            state.bodyHeading = 0; state.bodyRoll = 0;
            motion.reset();
            body.quaternion.identity();
            if (state.reenter) {
              state.reenter = false;
              puppet.enter();
            }
            return state.phase;
          }
          break;
        }
        default: break;
      }
      // FREE: never pinned, never stood up. The plant stays at the swimmer.
      const isFree = free();
      if (isFree) wantPlant = 0;
      const blend = 1 - Math.exp(-(c.pinLerp ?? 6) * dt);
      state.plant += (wantPlant - state.plant) * blend;

      // THE AUTHORED MOTION takes the body once the seal is under the row and
      // lets go on the pick — both at `takeRate`, so the arrival glides into
      // the loop and the loop glides into the exit swim. Which loop: the
      // hovered card's, or the idle's; the blender crossfades between them.
      const wantMotion = isFree && state.phase === 'held' ? 1 : 0;
      state.motionW += (wantMotion - state.motionW) * (1 - Math.exp(-(c.motion?.takeRate ?? 3) * dt));
      if (Math.abs(state.motionW - wantMotion) < 0.002) state.motionW = wantMotion;
      state.motionState = state.look?.option != null && state.look.option < 3 ? `card${state.look.option + 1}` : 'idle';
      let mo = null;
      // FROM THE FIRST FRAME OF THE SWIM UP, not from under the row: the
      // wanted state's point takes the body as it sets off, so a card hovered
      // while it is still rising is swum to directly, and the look and the
      // flippers blend on the way up.
      if (isFree && (state.motionW > 0 || state.phase === 'held' || state.phase === 'in')) {
        mo = motion.evaluate(state.motionState, dt, resolveAnchor, frame, {
          rate: c.motion?.blendRate ?? 4, time: c.motion?.blendTime ?? 0, ease: c.motion?.blendEase ?? 'smoothstep',
        });
      }
      state.motionOut = mo;
      // A LANDING POINT TAKES THE BODY AT ONCE, not over takeRate: the swim
      // is what carries it from the arrival to the point, so the moment the
      // seal is under the row the point owns it and the pull's offset is
      // set to wherever the arrival left the body — the same place on
      // screen, now measured from the point — with the arrival's own
      // velocity carried in, so the rise flows into the swim.
      const landing = !!(mo?.land && (state.phase === 'held' || state.phase === 'in'));
      if (landing && state.motionState !== 'idle') state.visited = true;
      // THE HOLD: idle wanted after a card — no point; the body stays.
      state.hold = landing && state.motionState === 'idle' && state.visited;
      if (landing && state.motionW < 1) {
        state.motionW = 1;
        const P = landPoint(mo);
        // Where the body is now — below the screen, at the entry column,
        // if this is the swim up — measured from the point.
        state.pull.x = state.cx - P.x;
        state.pull.y = state.cy - P.y;
        if (state.phase === 'in') {
          // THE ENTRY IS THE SWIM. It sets off toward the point at the
          // most the thrust can shed over the distance (the brake law in
          // the pull below), capped at the run's top speed — so it arrives
          // without overshooting and without a scripted rise: the same
          // physics that carries it between points carries it in.
          const pc0 = c.pull ?? {};
          const px0 = (pc0.speed ?? 1) * state.scale;
          const thrust0 = ((CONFIG.player?.thrust ?? 19)) * px0;
          const top0 = ((CONFIG.player?.maxSpeed ?? 34)) * px0;
          const d0 = Math.hypot(state.pull.x, state.pull.y);
          const v0 = Math.min(top0, Math.sqrt(2 * thrust0 * d0));
          state.pull.vx = d0 > 1e-6 ? -state.pull.x / d0 * v0 : 0;
          state.pull.vy = d0 > 1e-6 ? -state.pull.y / d0 * v0 : 0;
        } else {
          state.pull.vx = state.velX;
          state.pull.vy = state.velY;
        }
        state.land = { x: P.x, y: P.y };
        state.leg = { fromH: state.bodyHeading, fromR: state.bodyRoll, dist0: Math.hypot(state.pull.x, state.pull.y) };
        state.legState = state.motionState;
      }
      if (Math.abs(state.plant - wantPlant) < 0.002) state.plant = wantPlant;
      state.pinWeight = state.plant;

      // --- the idle bob ----------------------------------------------------
      // THE FLOAT THE PIN TOOK AWAY, given back on purpose. `water_idle` bobs
      // the whole animal on all_ctrl_02 and the bust pin holds that bone
      // still, because at a portrait crop the clip's bob walks the animal out
      // of frame. Here it is the animal treading water under the cards, and a
      // seal that does not move is a statue — so a bob of its own, in
      // fractions of the bust's height, faded in with the plant so it is
      // still while swimming. Two sines at an odd ratio rather than one, so
      // it never quite repeats; the sway and the cant ride the same clock a
      // little behind, which is what a body in water does.
      state.bobClock += dt;
      const bobOn = state.plant * (state.phase === 'held' && !isFree ? 1 : 0);
      const period = Math.max(0.2, c.bobPeriod ?? 2.8);
      const w = (state.bobClock / period) * Math.PI * 2;
      const wave = 0.7 * Math.sin(w) + 0.3 * Math.sin(w * 1.73 + 1.1);
      const lag = 0.7 * Math.sin(w - 0.9) + 0.3 * Math.sin((w - 0.9) * 1.73 + 1.1);
      state.bob = -(c.bobAmp ?? 0.035) * heightPx() * wave * bobOn;
      state.sway = (c.bobSway ?? 0.012) * heightPx() * lag * bobOn;
      state.tilt = (c.bobTilt ?? 0.03) * lag * bobOn;

      // --- scale and place -----------------------------------------------
      const s = isFree ? freeLenPx() / swimLen : heightPx() / bustH;
      state.scale = s;
      holder.scale.setScalar(s);
      // WHERE THE CENTRE IS, in CSS px. The bust's: on its centre line, half
      // a bust below the crown. Free: the authored loop's point, by however
      // much of the body the motion owns — the rest is the same bust place,
      // so the arrival and the exit are the swim they always were.
      // ...OR THE SET'S OWN ENTRY COLUMN. A portrait set that names one
      // rises there — a side column, beside the stacked hand — so the seal
      // never has to come up from under the last card and look up at it.
      const set = isFree ? motionSetFor(frame) : null;
      const baseCx = set?.entryX != null
        ? set.entryX * frame.w
        : frame.centreX + (c.offsetX ?? 0) * frame.w;
      // The swimmer's centre rides half its length below the crown while it
      // arrives and leaves, so the crown-line arithmetic of the rise and the
      // exit still means "the head at the line"; under the row its own loop
      // places the centre against the line directly.
      const baseCy = state.crownY + (isFree ? swimLen / 2 : bustH / 2) * s;
      const wasCx = state.cx;
      const wasCy = state.cy;
      let cx = baseCx + state.sway;
      let cy = baseCy + state.bob;
      let motionHeading = 0;
      let motionRoll = 0;
      if (mo && state.motionW > 0) {
        const w = state.motionW;
        if (mo.land && state.phase === 'out') {
          // LEAVING: the point is no longer followed. The exit rises from
          // where the body was (below), and the point — still gliding with
          // the blend's weights — must not keep shifting the pull's offset,
          // or every exit frame hops by the glide.
        } else if (mo.land) {
          // THE POINT MOVED (a hover change, the row shifting): the pull's
          // offset takes the difference, so the body stays where it is and
          // swims from there. An anchor that cannot be placed this frame
          // holds the last point.
          // Holding, the point is wherever the last one was: the idle's own
          // point is only ever the entry's destination.
          const P = state.hold ? (state.land ?? mo.land) : landPoint(mo);
          if (state.land && (P.x !== state.land.x || P.y !== state.land.y)) {
            state.pull.x -= P.x - state.land.x;
            state.pull.y -= P.y - state.land.y;
          }
          // A NEW LEG when the wanted state changes: the turn starts over
          // from where the body is toward the new pose. Within a leg the
          // point may glide (the crossfade above, the row shifting) — the
          // leg's length grows with it, so the turn waits for the swim
          // rather than restarting on every hair's move.
          const d = Math.hypot(state.pull.x, state.pull.y);
          if (state.motionState !== state.legState) {
            state.leg = { fromH: state.bodyHeading, fromR: state.bodyRoll, dist0: d };
            state.legState = state.motionState;
          } else if (d > state.leg.dist0) {
            state.leg.dist0 = d;
          }
          state.land = { x: P.x, y: P.y };
          cx += (P.x - cx) * w;
          cy += (P.y - cy) * w;
        } else {
          cx += (mo.x + (c.offsetX ?? 0) * frame.w - cx) * w;
          // The loop's y in its set's space: a fraction of the viewport's
          // height for the portrait set, body lengths below the row's line
          // for the row's.
          const loopY = mo.space === 'viewport' ? mo.y * frame.h : crownTarget() + mo.y * freeLenPx();
          cy += (loopY - cy) * w;
        }
        if (mo.land) {
          // How far along the leg the swim is, 0..1, from the offset still
          // to go against the leg's length; a leg of nothing is done.
          const remain = Math.hypot(state.pull.x, state.pull.y);
          const frac = state.leg.dist0 > 1 && !state.hold ? Math.max(0, Math.min(1, 1 - remain / state.leg.dist0)) : 1;
          const prog = ease(c.motion?.turnEase ?? 'inOutCubic', frac);
          const wantH = lerpAngle(state.leg.fromH, mo.heading, prog);
          const wantR = lerpAngle(state.leg.fromR, mo.roll, prog);
          const ks = 1 - Math.exp(-(c.motion?.turnSettle ?? 5) * dt);
          state.bodyHeading = lerpAngle(state.bodyHeading, wantH, ks);
          state.bodyRoll = lerpAngle(state.bodyRoll, wantR, ks);
        } else {
          state.bodyHeading = mo.heading;
          state.bodyRoll = mo.roll;
        }
        motionHeading = state.bodyHeading * w;
        motionRoll = state.bodyRoll * w;
      }
      if (!landing && state.phase !== 'held') state.land = null;
      // THE FREE EXIT RISES FROM WHERE THE ANIMAL WAS, straight off the top:
      // the loop's point is wherever the loop had put it, and the bust's
      // crown-line arithmetic above would first drag it down to the line's
      // own resting place before rising. The heading and the roll still fade
      // with the motion's weight — the swim off is the plain swim.
      if (isFree && state.phase === 'out') {
        // ...with the velocity it had at the pick fading under the rise, so
        // a seal taken mid-swim keeps going the way it was going for a beat
        // and the rise takes over rather than starting from a stop.
        const carry = (1 - state.outK) * state.t;
        cx = state.leaveCx + state.leaveVx * carry;
        cy = state.leaveCy + (-(freeLenPx() * 0.6) - state.leaveCy) * state.outK + state.leaveVy * carry;
      }
      // THE PULL. Hovered, the seal swims from the loop's point toward the
      // card and holds off it by `standoff`; unhovered, it swims back to the
      // loop's point. Both on the run's numbers — the same thrust, the same
      // drag, the same top speed, the same turn — in px through the px-per-
      // world-unit, so the animal under the cards accelerates and banks
      // exactly as the one in the arena does. Additive: the loop's authored
      // path, look and fin targets are untouched; this is an offset on top
      // and a heading beside them, faded with the motion's own weight.
      const pull = state.pull;
      const pc = c.pull ?? {};
      // Landing: the swim IS the mover, whatever `pull.enabled` says of the
      // loops' add-on.
      const pullOn = isFree && ((state.phase === 'held' && (landing || pc.enabled !== false)) || (state.phase === 'in' && landing));
      if (pullOn) {
        const P = CONFIG.player ?? {};
        const px = (pc.speed ?? 1) * s;                 // world units -> px
        const thrust = (P.thrust ?? 19) * px;
        const top = (P.maxSpeed ?? 34) * px;
        const friction = P.friction ?? 0.965;
        // Where it wants to be: off the hovered card's centre by `standoff`
        // bust heights, on the card's side facing the loop's point (so it
        // comes at the card from where it lives), or the loop's point itself.
        let wx = 0; let wy = 0;
        // Holding: it wants to be where it is, so the thrust only brakes and
        // the swim glides to a stop wherever the hover-off caught it.
        if (state.hold) { wx = pull.x; wy = pull.y; }
        if (state.look && !landing) {
          const tx = state.look.cx ?? state.look.x;
          const ty = state.look.cy ?? state.look.y;
          let dx = cx - tx; let dy = cy - ty;
          const d = Math.hypot(dx, dy);
          if (d < 1e-6) { dx = 0; dy = 1; } else { dx /= d; dy /= d; }
          const stand = Math.max(0, set?.pull?.standoff ?? pc.standoff ?? 0.9) * freeLenPx();
          wx = tx + dx * stand - cx;
          wy = ty + dy * stand - cy;
          // ...AND NEVER OFF THE SCREEN. A standoff wider than the room
          // beside the card (a phone's side column) would hold the seal
          // off the edge; the point it wants is kept a half-body inside.
          const edge = (swimW * s) / 2;
          wx = Math.max(edge, Math.min(frame.w - edge, cx + wx)) - cx;
          wy = Math.max(edge, Math.min(frame.h - edge, cy + wy)) - cy;
        }
        // A velocity to want — the top speed, easing to nothing over the
        // last `arrive` bust heights — and the run's thrust pushing the
        // actual velocity toward it. That is what stops the seal on the
        // spot rather than sliding through it on the water's long drag.
        const ex = wx - pull.x; const ey = wy - pull.y;
        const dist = Math.hypot(ex, ey);
        const arrive = Math.max(1, (set?.pull?.arrive ?? pc.arrive ?? 0.45) * freeLenPx());
        // THE SPEED IT MAY STILL BE DOING at this distance and stop on the
        // point: what the thrust alone can shed over what is left (drag
        // sheds more, so this is the conservative side). `arrive` is an
        // ease band on top, not the whole brake — on its own it asked a
        // seal at full speed to lose everything over half a body, which
        // the thrust cannot do, and the animal rang about the point three
        // times before it settled.
        const brake = Math.sqrt(2 * thrust * dist);
        const wantSpeed = Math.min(top, brake, top * (dist / arrive));
        const dvx = (dist > 1e-6 ? ex / dist * wantSpeed : 0) - pull.vx;
        const dvy = (dist > 1e-6 ? ey / dist * wantSpeed : 0) - pull.vy;
        const dv = Math.hypot(dvx, dvy);
        // THE STRAIGHT PUSH: the thrust shoving the velocity toward the
        // wanted one. Alone, a point that moves behind the animal (a card
        // hovered on the other side mid-swim) has it brake to a stop,
        // reverse and set off again.
        let nvx = pull.vx; let nvy = pull.vy;
        if (dv > 1e-6) {
          const push = Math.min(dv, thrust * dt);
          nvx += dvx / dv * push;
          nvy += dvy / dv * push;
        }
        // THE STEER: the same speed kept and its direction turned toward
        // the point at `steer` per second — a banking arc round to the new
        // point rather than a stop. Landing only, and only while the point
        // is further off than the arrive band: a turn-limited chase can
        // orbit a point it cannot turn inside, so the last stretch is the
        // straight push, which converges.
        const sp0 = Math.hypot(pull.vx, pull.vy);
        const steerW = landing && sp0 > 1e-3 && dist > 1e-6 ? Math.min(1, dist / arrive) : 0;
        if (steerW > 0) {
          const cur = Math.atan2(pull.vy, pull.vx);
          const want = Math.atan2(ey, ex);
          let d = want - cur;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          const ang = cur + d * (1 - Math.exp(-(set?.pull?.steer ?? pc.steer ?? 6) * dt));
          const mag = sp0 + Math.max(-thrust * dt, Math.min(thrust * dt, wantSpeed - sp0));
          const svx = Math.cos(ang) * mag; const svy = Math.sin(ang) * mag;
          const w = steerW * steerW * (3 - 2 * steerW);
          nvx = nvx + (svx - nvx) * w;
          nvy = nvy + (svy - nvy) * w;
        }
        pull.vx = nvx; pull.vy = nvy;
        pull.vx *= Math.pow(friction, dt * 60);
        pull.vy *= Math.pow(friction, dt * 60);
        const sp = Math.hypot(pull.vx, pull.vy);
        if (sp > top) { pull.vx *= top / sp; pull.vy *= top / sp; }
        pull.x += pull.vx * dt;
        pull.y += pull.vy * dt;
        pull.speed = sp / px; // world units per second, for the readout
        // The nose follows the swim, as poseBody turns the run's seal: the
        // short way round, at turnLerp, only above the run's move threshold —
        // and only while the swim is toward where it is going. The braking
        // at arrival can put a frame or two of reverse velocity in, and a
        // nose that followed those would flip round on the spot.
        const toward = pull.vx * ex + pull.vy * ey > 0 && dist > arrive * 0.5;
        if (toward && pull.speed > (CONFIG.animation?.moveThreshold ?? 1.5)) {
          const target = Math.atan2(-pull.vy, pull.vx) - Math.PI / 2;
          let delta = target - pull.heading;
          while (delta > Math.PI) delta -= Math.PI * 2;
          while (delta < -Math.PI) delta += Math.PI * 2;
          pull.heading += delta * (1 - Math.exp(-(P.turnLerp ?? 8) * dt));
        } else if (landing) {
          // Landed, or braking: the body settles onto the point's own
          // authored heading, at the same turn rate it swam with.
          pull.heading -= pull.heading * (1 - Math.exp(-(P.turnLerp ?? 8) * dt));
        }
      } else {
        // Not held: the offset and the turn ease away with the pin's rate,
        // so the exit swim starts from the loop's own point and heading.
        const k = 1 - Math.exp(-(c.pinLerp ?? 6) * dt);
        pull.x -= pull.x * k; pull.y -= pull.y * k;
        pull.heading -= pull.heading * k;
        if (Math.abs(pull.x) < 0.05) pull.x = 0;
        if (Math.abs(pull.y) < 0.05) pull.y = 0;
        if (Math.abs(pull.heading) < 0.002) pull.heading = 0;
        pull.vx = 0; pull.vy = 0; pull.speed = 0;
      }
      // A landing's offset is the whole distance still to swim; `weight` is
      // the loops' dial on their add-on and does not apply.
      const pullW = (landing ? 1 : (pc.weight ?? 1)) * state.motionW;
      cx += pull.x * pullW;
      cy += pull.y * pullW;
      // The heading from the swim is OFF by default (turnWeight 0): under the
      // cards the animal floats left and right in the plane, it does not turn
      // and mirror after its velocity the way the run's seal does.
      const pullHeading = pull.heading * (pc.turnWeight ?? 0) * pullW;
      motionHeading += pullHeading;
      state.velX = dt > 0 ? (cx - wasCx) / dt : 0;
      state.velY = dt > 0 ? (cy - wasCy) / dt : 0;
      state.cx = cx;
      state.cy = cy;
      if (Math.abs(s - lastRimScale) > 1e-6) {
        lastRimScale = s;
        fitRim();
      }
      // The speed the clip is picked from, in the model's own units — px per
      // second over px per unit — so the run's thresholds (CONFIG.animation
      // moveThreshold / boostThreshold) mean here what they mean there. Free,
      // it is the centre's whole travel; the bust's is its rise and fall.
      state.speed = dt > 0
        ? (isFree ? Math.hypot(state.cx - wasCx, state.cy - wasCy) : Math.abs(state.crownY - wasY)) / dt / s
        : 0;
      // THE SPEED THE CLIP IS PICKED FROM IS SMOOTHED. Free, the centre's
      // travel is the loops' crossfade as much as any swim, and a crossfade
      // is fastest on its first frame: an unhover spiked it to 15 units a
      // second for one frame, over the boost threshold and back under it the
      // next — swim, boost, swim in two frames, and every clip flip kicks the
      // neck. A run's speed is physics and never does this; here it is eased
      // at `clipSpeedLerp` so a one-frame spike is a bump the thresholds
      // never see. Reset with the phase so the exit still boosts at once.
      const csl = c.clipSpeedLerp ?? 6;
      state.clipSpeed = state.phase === 'held' && csl > 0
        ? state.clipSpeed + (state.speed - state.clipSpeed) * (1 - Math.exp(-csl * dt))
        : state.speed;

      // --- the look ----------------------------------------------------------
      const pointing = !!state.look;
      const at = state.look ?? frame.idle;
      _look.set(at.x, -at.y, 0);

      // THE FOLLOW. While a card is pointed at from the row, the body comes
      // round after it the way the run's does after the aim — a yaw toward
      // the card's side and a cant into it — from how far across the screen
      // the cursor is off the animal's centre line. Eased, never snapped, and
      // eased back to nothing the moment there is no card or the seal is on
      // its way off, so the swim it leaves on is the plain swim.
      const centre = isFree ? state.cx : holder.position.x + bustCx * state.scale;
      const across = pointing && state.phase === 'held'
        ? Math.max(-1, Math.min(1, (at.x - centre) / Math.max(1, frame.w * 0.5)))
        : 0;
      // Letting go is at the PIN'S rate rather than the follow's own: the
      // pose the follow lives in is being blended out by the plant at that
      // rate, and a follow that lingered inside it would be a number nothing
      // reads any more.
      const fRate = across !== 0 ? (c.followLerp ?? 3) : Math.max(c.followLerp ?? 3, c.pinLerp ?? 6);
      const fblend = 1 - Math.exp(-fRate * dt);
      state.followTurn += (across * (c.followTurn ?? 0.25) - state.followTurn) * fblend;
      state.followLean += (across * (c.followLean ?? 0.08) - state.followLean) * fblend;

      // THE HEAD'S TARGET. Free: the authored look, when it has one, else the
      // card or the idle point as ever. The nose points where the body is
      // turned, so the aim is remapped through the body's heading.
      let lookOn = !!(mo && mo.look.on && state.motionW > 0);
      if (lookOn) _look.set(mo.look.x, -mo.look.y, 0);
      // ON THE WAY OFF THE HEAD LOOKS WHERE IT IS GOING. The free exit shoots
      // straight up past the card the seal was watching, and a head still
      // on that card whips round as the mouth passes it — measured at seven
      // degrees a frame on the skull, over the barrel roll. So the target
      // is the way ahead, and the aim's own ease carries the head onto it.
      if (isFree && state.phase === 'out') {
        lookOn = false;
        _look.set(state.cx, -(state.cy - frame.h * 2), 0);
      }
      const forward = Math.PI / 2 + ((c.lean ?? 0.05) + state.followLean) * state.plant + motionHeading;
      bustAim(rig, _look, wantAim, forward, c.aimSpread ?? 0.7);
      aim.lerp(wantAim, 1 - Math.exp(-(c.aimLerp ?? 7) * dt));
      if (aim.lengthSq() > 1e-8) aim.normalize();

      // --- the body, in the order the game does it: clip, rig, pin ---------
      // The clip is the run's choice for this speed while swimming and the
      // idle once planted — a planted animal moving with the row must not
      // start paddling.
      state.animState = state.plant >= 0.999 ? 'idle' : stateForSpeed(state.clipSpeed);
      anim?.update(dt, state.animState, false);
      // The pose: the swimmer's heading blended into the bust by the plant —
      // and, free, the authored heading on top: a turn in the screen plane
      // about the animal's own centre, with the follow's cant beside it.
      holder.quaternion.copy(swimPose(_swimQ)).slerp(bustPose(_bustQ), state.plant);
      const screenTurn = state.tilt + (isFree ? motionHeading + state.followLean * (1 - state.plant) : 0);
      if (screenTurn !== 0) holder.quaternion.premultiply(_tiltQ.setFromAxisAngle(_z, screenTurn));
      if (isFree && state.followTurn !== 0 && state.plant < 0.999) {
        holder.quaternion.multiply(_headQ.setFromAxisAngle(_y, state.followTurn * (1 - state.plant)));
      }
      // ...and the roll on the BODY, about its own long axis, as the run
      // composes it (player.body.quaternion carries the roll, player.mesh the
      // heading).
      body.quaternion.copy(_rollQ.setFromAxisAngle(_y, state.roll + motionRoll));
      // PLACED BY ITS CENTRE. The holder's origin is the model's, not the
      // animal's middle, so a turn about the origin would swing the body off
      // its spot; the centre is put where it was asked for and the origin
      // follows, whatever the turn. The bust's crown-line place falls out of
      // the same arithmetic at heading 0.
      if (isFree) {
        _centreLocal.set(swimCx * s, swimCy * s, 0).applyQuaternion(holder.quaternion);
        holder.position.x = state.cx - _centreLocal.x;
        holder.position.y = -state.cy - _centreLocal.y;
      } else {
        // The bust's, as it always was: the crown on the line, measured along
        // the holder's own up — its cant is authored to leave the head there.
        holder.position.x = baseCx - bustCx * s + state.sway;
        holder.position.y = -state.crownY - crownTop * s - state.bob;
      }
      holder.updateMatrixWorld(true);

      // THE RIG. Planted and pointing: engaged, the head and the chosen fin
      // on the card. Planted and idle: the head on the row, the fins to the
      // clip. Swimming: the run's own idle weights, no gate — the seal you
      // play as, going somewhere.
      const planted = state.plant > 0.5;
      let gate = null;
      let finAims = null;
      if (planted) gate = pointing ? finGateFor(at.x, state.look?.option) : fins.map(() => 0);
      // FREE: each flipper has a target and a strength of its own from the
      // authored loop — the gate is the strength, the aim is that target
      // through the same remap as the head's. A flipper with no target is the
      // clip's, exactly as `none` says.
      if (isFree && mo && state.motionW > 0) {
        gate = fins.map(() => 0);
        finAims = fins.map(() => null);
        fins.forEach((f, i) => {
          const t = mo.fins[f.name === 'left' ? 'left' : 'right'];
          if (!t?.on) return;
          gate[i] = Math.max(0, Math.min(1, t.s)) * state.motionW;
          _finLook.set(t.x, -t.y, 0);
          bustAim(rig, _finLook, _finAimVecs[i] ?? (_finAimVecs[i] = new THREE.Vector2()), forward, c.aimSpread ?? 0.7);
          finAims[i] = _finAimVecs[i];
        });
      }
      state.finGate = gate;
      state.finAims = finAims;
      // THE FACE. Out of the screen at the viewer while a card is pointed at
      // (`pointFaceOut`), faded with the plant so it lets go with the pin on
      // the way off; `faceOut` is the idle's. Never less than the accessory's
      // own turn asks for, which is what it always was.
      const turned = Math.abs(Math.sin(turn + state.followTurn));
      let faceOut = pointing
        ? Math.max(turned, (c.pointFaceOut ?? 1) * state.plant)
        : Math.max(turned, (c.faceOut ?? 0) * state.plant);
      let engaged = planted && pointing;
      if (isFree) {
        // Free: the authored `out`, by the motion's weight; engaged whenever
        // the loop gives the head somewhere to look, or a fin somewhere to
        // point — the rig eases its own weights in and out from there.
        faceOut = Math.max(turned, lookOn ? mo.look.s * state.motionW : 0);
        engaged = state.phase === 'held' && (lookOn || (gate?.some((g) => g > 0) ?? false));
        // EASED, never cut. The pick turns the look from the card to the
        // way ahead in one frame, and the face-out with it — which is the
        // neck's depth target and its bend budget dropping at once. It
        // follows the aim's own ease instead.
        faceOut = state.faceOut + (faceOut - state.faceOut) * (1 - Math.exp(-(c.aimLerp ?? 7) * dt));
        if (Math.abs(faceOut) < 1e-4) faceOut = 0;
      }
      state.faceOut = faceOut;
      rig?.update(dt, aim, { engaged, finGate: gate, faceOut, finAims });
      pin?.apply(state.pinWeight);
      // THE JAW, last: additive over the clip the mixer wrote and under the
      // head the rig just aimed (mouth_08 hangs off head_07). The gape is
      // the states' crossfaded `jaw`, by the motion's weight.
      const jc = c.jaw ?? {};
      state.jawOpen = jc.enabled === false || !isFree ? 0 : Math.max(0, Math.min(1, (mo?.jaw ?? 0) * state.motionW));
      if (jaw) { jaw.setGape(state.jawOpen); jaw.update(dt); }
      holder.updateMatrixWorld(true);

      if (pair) {
        updateEyeLights(dt, rig, { lit: 1, charge: 0, pair });
        // The beads and halos are sized in the run's world units (a radius of
        // 0.08, on an animal 2.6 long) and this world is pixels — so they come
        // out a tenth of a pixel across. Scaled back up by the px-per-unit.
        for (const eye of pair.eyes) {
          eye.bead.scale.multiplyScalar(s);
          eye.halo.scale.multiplyScalar(s);
        }
      }
      return state.phase;
    },
  };

  return puppet;
}

// ---------------------------------------------------------------------------
// THE CANVAS, THE RECTS AND THE WIRING — browser only from here down.
// ---------------------------------------------------------------------------

export const levelUpSealState = {
  built: false,
  phase: 'none',
};

let worldRenderer = null;
let live = null;
let lastPixelRatio = 0;

/** The live canvas, scene and puppet — for a look page's console, nothing else. */
export function levelUpSealLive() {
  return live;
}

/** Once, at boot: which renderer to match. Builds nothing. */
export function installLevelUpSeal({ renderer } = {}) {
  worldRenderer = renderer ?? null;
}

// THE CURSOR, for the follow: the last place the pointer was seen, so a hover
// can be looked at where the mouse actually IS on the card rather than at the
// card's middle. A pad or a keyboard never moves it, so a card selected that
// way is looked at by its centre — which is where lookLevelUpSeal falls back
// to whenever the pointer is not over the focused card.
const pointer = { x: 0, y: 0, seen: false };
function onPointerMove(e) {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.seen = true;
}

// The card being pointed at, held so the look can be re-read every frame —
// the cursor moves across it, and the row moves under it.
let focusedCard = null;

function onCardFocus(e) {
  focusedCard = e?.detail?.card ?? null;
}

// WHAT IS HIGHLIGHTED, read off the screen every frame — not off the enter
// and leave events. Those are gated on the menu's arrival lock (a pointer
// already resting on a card when the lock lifts never re-enters it), can be
// missed across a relayout, and a hold re-announces while a slip retracts;
// the seal was left pointing at a card the player had long left, or never
// turning to the one they were on. The card under the pointer wins, then the
// pad's or the keyboard's selection (`.sv-card-sel`), then whatever was last
// announced. Null when nothing is highlighted, which lets the state go —
// the seal is always free to leave a card for whatever is lit now.
const _rectCards = [];
function highlightedCard() {
  const cards = document.querySelectorAll?.('#svCards .sv-card') ?? [];
  let hov = null;
  let sel = null;
  for (const c of cards) {
    if (!hov) { try { if (c.matches(':hover')) hov = c; } catch { /* no :hover here */ } }
    if (!sel && c.classList.contains('sv-card-sel')) sel = c;
  }
  if (hov) return hov;
  if (pointer.seen) {
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      if (r.width > 0 && pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom) return c;
    }
  }
  return sel ?? (focusedCard?.isConnected ? focusedCard : null);
}
let litCard = null;

/**
 * Build the seal, its scene and its canvas. Called at the top of the level-up
 * ramp so the one-time cost (a settle-and-measure on the CPU, a compile on the
 * GPU) lands in the slow-motion beat and not on the frame the cards arrive.
 * A no-op once built, and when the feature is off.
 */
export function prepareLevelUpSeal() {
  if (live) return live;
  if (!levelUpSealEnabled()) return null;
  if (typeof document === 'undefined') return null;
  const menu = document.getElementById('svLevelUpMenu');
  if (!menu) return null;

  const canvas = document.createElement('canvas');
  canvas.className = 'sv-levelup-seal';
  canvas.style.display = 'none';
  // AFTER the comb and BEFORE the stage — see the CSS note in ui/ui.js.
  const comb = document.getElementById('svComb');
  if (comb && comb.parentNode === menu) menu.insertBefore(canvas, comb.nextSibling);
  else menu.insertBefore(canvas, menu.firstChild);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true });
  } catch (err) {
    console.warn('[levelUpSeal] no second GL context — the seal stays off.', err);
    canvas.remove();
    return null;
  }
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = true;
  // LINEAR OUT, NO TONE MAPPING — and this is the whole difference between the
  // menu's seal and a white one. The game never draws a material to the
  // screen: post.js renders the scene into a half-float target (no output
  // encoding, no tone mapping — three applies both only on the default
  // framebuffer) and its final pass is a raw ShaderMaterial that writes those
  // linear values to the screen as they are. Every look in this game was
  // authored against that. A renderer left at its sRGB default encodes the
  // same seal a stop and a half brighter: measured on the level-up look page,
  // the run's slate-grey animal came out near-white until this was set.
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  lastPixelRatio = pixelRatio();
  renderer.setPixelRatio(lastPixelRatio);

  const scene = new THREE.Scene();
  // The game's own three lights — the seal's surface is a mottle lit by these
  // (CONFIG.sealShader), so a portrait lit any other way is a different animal.
  const L = CONFIG.lighting ?? {};
  scene.add(new THREE.AmbientLight(0xffffff, L.ambient ?? 0.85));
  const key = new THREE.DirectionalLight(0xffffff, L.keyIntensity ?? 1.25);
  key.position.fromArray(L.keyPosition ?? [4, 8, 14]);
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0x9fd8ff, 0x08131c, L.hemiIntensity ?? 0.4));

  const body = createVisual('ship');
  const puppet = createLevelUpPuppet(body);
  scene.add(puppet.holder);
  if (puppet.eyeGroup) scene.add(puppet.eyeGroup);

  // The bubbles, on this canvas — see systems/levelUpBubbles.js.
  const bubbles = createLevelUpBubbles();
  scene.add(bubbles.points);

  const camera = new THREE.OrthographicCamera(0, 1, 0, -1, -5000, 5000);
  camera.position.set(0, 0, 0);

  live = { canvas, renderer, scene, camera, puppet, bubbles, col: { left: 0, w: 0, h: 0 } };
  levelUpSealState.built = true;
  document.addEventListener(CARD_FOCUS_EVENT, onCardFocus);
  document.addEventListener('pointermove', onPointerMove, { passive: true });

  // Warm the programs now, with the scene target bound as it will be when it
  // draws (the default framebuffer — this renderer never uses another).
  renderer.compileAsync?.(scene, camera)?.catch?.(() => {});
  return live;
}

function pixelRatio() {
  const pr = worldRenderer?.getPixelRatio?.() ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1);
  return Math.max(0.5, Math.min(2, pr || 1));
}

/** The cards are up — swim up under them. Builds first if it has to. */
export function enterLevelUpSeal() {
  if (!levelUpSealEnabled()) return;
  if (!live) prepareLevelUpSeal();
  // Only when it is actually starting a climb — enter() is a no-op on a puppet
  // that is already up (a second card in the same batch re-enters through the
  // exit instead), and a voice on a call that moved nothing is a voice you
  // cannot place.
  const climbing = live && live.puppet.state.phase === 'none';
  live?.puppet.enter();
  if (climbing) feedback('sealPeek');
}

/** A card was taken — off the top. */
export function leaveLevelUpSeal() {
  const leaving = live && live.puppet.state.phase !== 'none' && live.puppet.state.phase !== 'out';
  live?.puppet.leave();
  if (leaving) feedback('sealBolt');
}

/**
 * Point the seal at a card (a .sv-card element), or at nothing.
 * Also reachable through the CARD_FOCUS_EVENT ui.js announces.
 */
export function lookLevelUpSeal(card) {
  if (!live) return;
  if (!card?.getBoundingClientRect) {
    live.puppet.look(null);
    return;
  }
  const r = card.getBoundingClientRect();
  if (!(r.width > 0)) {
    live.puppet.look(null);
    return;
  }
  // WHICH card — its place in the hand is which flipper points (finGateFor).
  const cards = document.querySelectorAll?.('#svCards .sv-card') ?? [];
  let option = null;
  for (let i = 0; i < cards.length; i++) if (cards[i] === card) { option = i; break; }
  // WHERE on it: the cursor while it is over the card, else the middle.
  const onCard = pointer.seen
    && pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom;
  live.puppet.look({
    x: onCard ? pointer.x : r.left + r.width / 2,
    y: onCard ? pointer.y : r.top + r.height / 2,
    cx: r.left + r.width / 2,
    cy: r.top + r.height / 2,
    option,
  });
}

export function resetLevelUpSeal() {
  focusedCard = null;
  litCard = null;
  if (!live) return;
  live.puppet.reset();
  live.bubbles?.reset();
  live.canvas.style.display = 'none';
  levelUpSealState.phase = 'none';
}

// Where the row is, this frame.
//
// THE DRAWN EDGE, NOT THE BOX. A card is a square element clipped to a
// hexagon whose bottom point sits at 89.6% of its height (see the clip-path
// in ui.js, and showCardEffect, which anchors the tooltip the same way), and
// the container box carries the slots' bloom room under that. Measured off
// the box, "right under the cards" was fifty pixels of nothing; the crown
// wants the lowest hexagon's point. The lowest, because a narrow screen wraps
// the hand onto two rows.
const HEX_BOTTOM = 0.896;
function readFrame(frame) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const c = cfg();
  const cards = document.querySelectorAll('#svCards .sv-card');
  let bottom = -Infinity;
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  for (const card of cards) {
    const r = card.getBoundingClientRect();
    if (!(r.height > 0)) continue;
    bottom = Math.max(bottom, r.top + r.height * HEX_BOTTOM);
    top = Math.min(top, r.top);
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
  }
  const have = Number.isFinite(bottom);
  const centres = [];
  for (const card of cards) {
    const r = card.getBoundingClientRect();
    if (r.height > 0) centres.push({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  }
  return {
    w, h,
    crownLine: have ? bottom + (c.gap ?? 6) : frame.crownLine,
    centreX: w / 2,
    idle: have ? { x: (left + right) / 2, y: (top + bottom) / 2 } : frame.idle,
    cards: centres,
    cursor: pointer.seen ? { x: pointer.x, y: pointer.y } : null,
    portrait: isPortrait(w, h, centres),
  };
}

/**
 * Whether the screen wants the motion's portrait set: taller than wide, or a
 * hand laid out as one column (fitCards stacks it when three across will not
 * fit — measured off the cards' centres rather than re-asked, so the seal and
 * the comb can never disagree about which layout is up).
 */
export function isPortrait(w, h, centres = []) {
  if (h > w) return true;
  if (centres.length < 2) return false;
  let lo = Infinity; let hi = -Infinity;
  for (const p of centres) { lo = Math.min(lo, p.x); hi = Math.max(hi, p.x); }
  return hi - lo < 1;
}

/**
 * One frame, on the wall clock. Sizes and places the canvas, steps the puppet,
 * draws. Nothing at all while the seal is off screen.
 */
export function updateLevelUpSeal(rawDt) {
  if (!live) return;
  const { puppet, canvas, renderer, camera, scene, col } = live;
  if (!levelUpSealEnabled() && puppet.active) puppet.reset();
  levelUpSealState.phase = puppet.phase;
  if (!puppet.active && (live.bubbles?.alive() ?? 0) === 0) {
    if (canvas.style.display !== 'none') canvas.style.display = 'none';
    return;
  }

  const frame = readFrame(puppet.frame);
  puppet.setFrame(frame);
  // The look is re-read every frame from whatever is highlighted: the cursor
  // moves across a card, the row can move under it (a resize, the tip's
  // layout), and the card can change without an event saying so.
  const lit = highlightedCard();
  // THE ANIMAL NOTICING, on top of the card's own `uiHover`: once, on the
  // change onto a card, while the seal is up.
  if (lit && lit !== litCard && puppet.active) feedback('sealNose');
  litCard = lit;
  lookLevelUpSeal(lit);
  puppet.update(rawDt);
  // After the rig has solved, so the anchors are this frame's. Stepped while
  // the seal is off screen too, so bubbles it left behind finish rising.
  live.bubbles?.update(Math.min(0.05, Math.max(0, rawDt)), puppet, pixelRatio());
  if (!puppet.active && (live.bubbles?.alive() ?? 0) === 0) {
    canvas.style.display = 'none';
    return;
  }

  // The column: the bust's width times a margin for the flippers, centred on
  // the animal, the full height of the viewport so the exit has somewhere to
  // go. Resized only when it changes — setSize is not free.
  const c = cfg();
  const s = puppet.state.scale;
  // Free, the column is cut for a body that can lie ACROSS the screen — its
  // length, not the bust's width — and it follows the animal, so a swim to
  // the far card is not a swim into the edge of its own canvas.
  const isFree = c.free !== false;
  const span = isFree ? Math.max(puppet.swimLen, puppet.swimW) : puppet.bustW;
  const colW = Math.max(1, Math.min(frame.w, Math.round(span * s * (c.column ?? 2.4))));
  const centre = isFree ? puppet.state.cx : frame.centreX + (c.offsetX ?? 0) * frame.w;
  const left = Math.round(Math.max(0, Math.min(frame.w - colW, centre - colW / 2)));
  const h = Math.max(1, Math.round(frame.h));
  const pr = pixelRatio();
  if (pr !== lastPixelRatio) {
    lastPixelRatio = pr;
    renderer.setPixelRatio(pr);
    col.w = 0; // force the resize below
  }
  if (colW !== col.w || h !== col.h) {
    col.w = colW;
    col.h = h;
    renderer.setSize(colW, h, true);
  }
  if (left !== col.left) {
    col.left = left;
    canvas.style.left = `${left}px`;
  }
  if (canvas.style.display !== 'block') canvas.style.display = 'block';

  camera.left = left;
  camera.right = left + colW;
  camera.top = 0;
  camera.bottom = -h;
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
}
