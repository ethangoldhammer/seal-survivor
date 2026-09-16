import { CONFIG } from '../config.js';
import { nearestGrave } from './gravesite.js';
import { worldToScreen } from '../ui/project.js';
import { cineGaze, cineGazeDone } from './cineCamera.js';

// ============================================================================
// STOPPING AT A GRAVE — the one place that answers "the seal is at this stone,
// looking at it", and the slow push-in that answers it back.
//
// THREE THINGS HAVE TO BE TRUE, and they are three different questions:
//
//   NEAR       horizontally within `radius` of the stone, and no more than
//              `reach` above the top of its head. The yard is on the floor of
//              a fifty-unit column, so the horizontal half alone names a grave
//              for a seal cruising the surface with the stone nowhere near it.
//   IN SHOT    the top of the stone projects inside the window. A question
//              about the CAMERA and not about the swim, so it is asked every
//              frame rather than once on arrival — the frame can move out from
//              under an attention that was fair when it started.
//   STILL      the seal is under `stillSpeed`. This is the half that makes it
//              "stopping to look at" rather than "swimming past", and it is
//              what the caption alone could never say: a seal at full speed
//              crosses the whole radius in under half a second, so a dwell
//              clock without it would only ever fire for a player who was
//              already stopped by accident.
//
// ONE COPY OF THE TEST, because there were nearly two. ui/graveLabel.js asked
// the first two of those for itself, and the obvious way to build this was to
// ask them again over here — a second proximity test that agrees with the
// first until one of them is edited.
//
// It is a shared FUNCTION (`graveAtSeal`) rather than a piece of state the
// label reads off this module, and the difference is worth naming: state would
// make the caption depend on this file having run first THIS frame, which is
// an ordering rule nothing in the code can state and every future caller has
// to know. A pure function has no order to get wrong — both callers ask the
// same question and get the same answer, whoever asks first. It costs a second
// scan of six stones and one projection per frame, which is nothing.
//
// WHAT THE DWELL BUYS is the camera, and nothing else: the label comes up on
// arrival as it always did, and the push only starts once you have stayed.
// Half a second is long enough that swimming through a yard mid-fight never
// takes the frame, and short enough that stopping on purpose is answered
// immediately.
//
// ...AND IT BUYS IT ONCE. The stillness is the entry condition and not a thing
// to keep satisfying: once the frame is moving it stays until the seal leaves
// the stone. See `want` below.
//
// THE PUSH IS A LATCH, not a pulse — the same choice cineReveal makes and for
// the same reason. This is a MODE ("the player is standing at a grave"), it
// ends when they leave, and a shot counting down on its own clock would expire
// under a player who is still standing there.
//
// IT FRAMES A POINT BETWEEN THE TWO. The seal is up to `reach` above a stone
// standing on the bed, and a push-in centred on the animal at a zoom worth
// having puts the grave under the bottom edge — a shot of a seal looking at
// nothing. `bias` is how far along that line the frame sits: 0 is the seal, 1
// is the stone's head.
// ============================================================================

function cfg() {
  return CONFIG.gravesite?.gaze ?? {};
}

function labelCfg() {
  return CONFIG.gravesite?.label ?? {};
}

// What the label reads and what the camera is pointed at. `grave` is the
// record nearestGrave returned this frame, or null.
const attention = {
  grave: null,
  // Seconds the three conditions have all held for. Reset — not decayed — the
  // moment any of them stops being true, because a dwell that survived a
  // sprint through the yard would be a push-in triggered by a lap of it.
  dwell: 0,
  // Is the frame currently being pushed in? The latch's own state, so a caller
  // can ask without reaching into the camera.
  pushing: false,
};

// Where the frame is pointed, rebuilt in place every frame the push is live.
// A live object rather than a captured point for the reason cineReveal's
// subject is a function: the seal drifts while it stands there, and a point
// taken on the frame the push started would leave the shot behind it.
const at = { x: 0, y: 0 };

// ...AND THE SEAL, COPIED OUT OF THE CALLER'S ctx EVERY FRAME. The camera's
// subject callback cannot close over `ctx` itself: main.js hands this a fresh
// object literal per frame, so the one captured on the frame the push started
// is a snapshot — the frame would creep toward a midpoint computed from where
// the animal USED TO BE and stay there however far it swam. Same trap as
// capturing the point, one level up.
const seal = { x: 0, y: 0 };

/** The stone the seal is attending, and how long it has been doing it. */
export function graveAttention() {
  return attention;
}

export function resetGraveGaze() {
  attention.grave = null;
  attention.dwell = 0;
  if (attention.pushing) cineGazeDone();
  attention.pushing = false;
}

const SHOT = { x: 0, y: 0 };

/**
 * THE TEST, as a question anyone can ask: which stone is the seal at, or null.
 *
 * All three conditions in the header, in one place. `dwell` is deliberately
 * NOT part of it — how long you have been here is a fact about a clock, and
 * only the thing that moves the camera cares.
 *
 * @param camera  world.camera, for the in-shot half
 * @param x, y    the seal's world position
 */
export function graveAtSeal(camera, x, y) {
  if (!camera) return null;
  const lc = labelCfg();
  // BOTH AXES, and the vertical one is measured against the stone rather than
  // against its centre: `reach` is clearance ABOVE the top of the head, so a
  // seal swimming alongside the stone's own height is at zero. nearestGrave is
  // horizontal by design (it is shared with the crabs, who live on the floor
  // and have no vertical half to the question), so the height test is here —
  // which is fine because every stone stands on the same bed, so it rejects or
  // accepts them all alike and cannot pick the wrong one.
  const found = nearestGrave(x ?? 0, lc.radius ?? 6);
  if (!found) return null;
  if (Math.max(0, (y ?? 0) - found.topY) > (lc.reach ?? 6)) return null;
  // ...and the third test, which is the camera's rather than the seal's. The
  // top of the head is the right point to ask about: it is the stone's
  // highest, so a top below the bottom edge means the whole marker is under
  // the frame, and it is also the point the caption hangs off — which makes
  // this exactly "is there anything to hang it on".
  worldToScreen(camera, found.x, found.topY, SHOT);
  const inShot = SHOT.x >= 0 && SHOT.x <= window.innerWidth
    && SHOT.y >= 0 && SHOT.y <= window.innerHeight;
  return inShot ? found : null;
}

/**
 * @param dt   seconds. The same clock ui/graveLabel.js runs on — this rides a
 *   seal that is being played, so a hit-stop that freezes the seal freezes the
 *   moment with it.
 * @param ctx
 *   camera    world.camera, for the in-shot test
 *   x, y      the seal's world position
 *   speed     how fast it is going, world units/second
 *   live      false while the run is not being played (a menu, a death, the
 *             score card) — the attention drops and the push lets go.
 */
export function updateGraveGaze(dt, ctx = {}) {
  const c = cfg();
  if (c.enabled === false || ctx.live === false || !ctx.camera) {
    resetGraveGaze();
    return attention;
  }

  const step = Math.min(Math.max(dt ?? 0, 0), 0.1);
  seal.x = ctx.x ?? 0;
  seal.y = ctx.y ?? 0;

  // --- near, low enough, and in shot ---------------------------------------
  const near = graveAtSeal(ctx.camera, ctx.x, ctx.y);
  // A DIFFERENT STONE STARTS THE CLOCK AGAIN. Swimming from one grave to the
  // next is two visits, and carrying the dwell across would push the frame in
  // on the second one the instant you arrived.
  if (!near || near.id !== attention.grave?.id) attention.dwell = 0;
  attention.grave = near;

  // --- still ---------------------------------------------------------------
  const still = (ctx.speed ?? 0) <= (c.stillSpeed ?? 3);
  if (near && still) attention.dwell += step;
  else attention.dwell = 0;

  // --- the push ------------------------------------------------------------
  // THE DWELL ARMS IT; ONLY LEAVING ENDS IT. Once the frame is moving, holding
  // station is not a thing the player should have to do perfectly: nudging the
  // stick, drifting on a current, or turning to look at the stone all break
  // `still` for a frame, and a push that let go on each of those flickered in
  // and out while somebody was plainly standing there. So the stillness test
  // is the ENTRY condition and nothing else — what keeps the shot is the same
  // thing that makes it true, which is that the seal is still at the grave.
  const want = !!near && (attention.pushing || attention.dwell >= (c.hold ?? 0.5));
  if (want && !attention.pushing) {
    attention.pushing = true;
    // The midpoint is recomputed per frame inside the callback — see `at`.
    cineGaze(() => {
      const g = attention.grave;
      if (!g) return null;
      const b = Math.min(1, Math.max(0, cfg().bias ?? 0.45));
      at.x = seal.x + (g.x - seal.x) * b;
      at.y = seal.y + (g.topY - seal.y) * b;
      return at;
    });
  } else if (!want && attention.pushing) {
    attention.pushing = false;
    cineGazeDone();
  }

  return attention;
}

/**
 * Is there a stone close enough to salute? The button's question, and NOT the
 * dwell's — pressing it is the player saying they meant to, so it does not ask
 * them to have stood still first. It still asks for the stone to be in shot,
 * because a salute to a grave that is off the bottom of the screen is the seal
 * doing something at nothing.
 */
export function graveInReach() {
  return attention.grave;
}
