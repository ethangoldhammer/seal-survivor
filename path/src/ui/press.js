// PRESS — tap, hold, and pull off, on one set of rules.
//
// THE BUG THIS EXISTS FOR. On a phone every menu in this game committed on
// touch: you tapped a level-up card and you had taken it. There was no way to
// READ one first, because a tip that opens on hover is a tip a thumb can never
// see — and no way to change your mind, because a press that had begun was
// already a decision. Both halves are the same missing idea: a press is not an
// activation until the finger comes off, in the same place, without having
// asked for something else.
//
// SO A PRESS HAS THREE ENDINGS, and every menu surface in the game now gets all
// three from here rather than from its own listener:
//
//   TAP        down and up inside the slop radius, under holdMs. The thing
//              happens. This is the ordinary case and it is unchanged.
//   HOLD       still down at holdMs, having not moved. `onHold` fires — which
//              is how a tip appears on a device with no pointer to hover — and
//              the ACTIVATION IS CANCELLED. Reading a card is not taking it.
//   SLIP       moved past the slop radius, or out of the element, or the
//              gesture was taken away (a scroll, a system edge swipe, a second
//              finger). Nothing happens at all.
//
// THE HARD PART IS THE THIRD ONE, and it is why this is a module rather than
// four copies of a setTimeout. `click` is not a synonym for "the finger came up
// here":
//
//   * A press that CAPTURED the pointer — which a hold must, or the events stop
//     arriving the moment the finger drifts a pixel — retargets everything to
//     the capturing element, `click` included. So the browser's own "released
//     somewhere else, so no click" rule stops applying at exactly the moment
//     this code starts needing it, and sliding a thumb off a card fires the
//     card. That is the click-through in the bug report.
//   * iOS fires a click after `touchend` from its own timeline, not from the
//     pointer events, so preventDefault on pointerup does not stop it.
//
// The only thing that reliably stops it is a listener in the CAPTURE phase on
// the window that eats the next click outright — installed the moment a press
// stops being a tap, and disarmed by the next press whether or not a click ever
// arrives. See swallowNextClick, and the bug in its comment.
//
// WHAT THIS IS NOT. It does not replace `click` on anything reachable by
// keyboard or by a screen reader: those have no press duration and no
// coordinates, and a synthesised click (detail 0) passes straight through
// untouched. It is a filter on POINTER presses, not a new activation path.
import { CONFIG } from '../config.js';

/** Defaults, overridable per call and tunable in CONFIG.press. */
function cfg() {
  return CONFIG.press ?? {};
}

// HOW LONG A HOLD IS, in milliseconds.
//
// 280 is the pause button's, and matching it is the point: a player who has
// learned the length of one hold in this game has learned all of them. It is
// also short enough that a hold reads as a deliberate press rather than as the
// interface being slow, and long enough to clear an ordinary tap, which lands
// well under 200ms.
//
// Not the platform's own long-press (iOS is ~500ms, Android ~400): those are
// tuned for text selection, which is a rare and destructive gesture. This one
// is the common case — it is how you read anything — and at half a second it
// feels like the game is deciding whether to answer you.
const HOLD_MS = 280;

// HOW FAR A FINGER MAY DRIFT and still be in the same place, in CSS pixels.
//
// A thumb on glass is not still. Measured on a phone, a deliberate "stationary"
// press wanders 4-8px over a quarter of a second, so a zero-slop rule cancels
// nearly every hold and the feature reads as broken. 12 is above that and well
// under the smallest gap between two things you could mean — the hive's
// hexagons interlock at 30px across on the score rail, so a slip has to cross
// most of a tile before it counts.
const SLOP = 12;

/**
 * Eat the next click, wherever it lands.
 *
 * CAPTURE PHASE ON THE WINDOW, which is the only place early enough: the click
 * is dispatched at the element, so a listener on the element itself competes
 * with the element's own handler and loses if that one was registered first.
 * From the window's capture phase this runs before any of them.
 *
 * IT MUST ALSO DISARM ITSELF, because the click it is waiting for may never
 * come: a press cancelled by a scroll produces none on any platform. A
 * suppressor left armed swallows the player's NEXT tap — a menu that ignores
 * every other press, which is the worst possible way for this to fail.
 *
 * TWO WAYS OUT, and the first is the one that matters:
 *
 *   THE NEXT POINTERDOWN, anywhere. A new press means the previous press's
 *   click is never arriving, so the suppressor has nothing left to do. This is
 *   the precise rule, and it was a real bug before it existed: a timer alone
 *   left a window in which pulling off one button and immediately tapping the
 *   next one ate the second tap — two controls, one gesture apart, and the
 *   second one dead. Found by npm run test:press, which is exactly the shape of
 *   failure nobody reproduces by hand because it needs two presses inside the
 *   same second.
 *
 *   A TIMER, as the backstop for a press that is never followed by another one
 *   — the player pulls off a button and puts the phone down. Long enough to
 *   cover iOS's delay between touchend and click, which is the whole reason
 *   this cannot simply run on the next tick.
 */
function swallowNextClick() {
  const eat = (e) => {
    // A synthesised click — the keyboard, a screen reader, a test — reports
    // detail 0 and has no press behind it to have slipped. Letting it through
    // is what keeps every one of these controls reachable without a pointer.
    if (e.detail === 0) return;
    e.stopPropagation();
    e.preventDefault();
    done();
  };
  // CAPTURE PHASE, so it is seen before the press that is starting can be
  // affected by it, and before any control's own pointerdown handler runs.
  const rearm = () => done();
  const done = () => {
    window.removeEventListener('click', eat, true);
    window.removeEventListener('pointerdown', rearm, true);
    clearTimeout(timer);
  };
  const timer = setTimeout(done, cfg().swallowMs ?? 700);
  window.addEventListener('click', eat, true);
  window.addEventListener('pointerdown', rearm, true);
}

/**
 * Wire one element for tap / hold / slip.
 *
 * @param el          the element. It keeps whatever `click` handler it already
 *                    has — this filters that handler rather than replacing it,
 *                    which is what makes it safe to add to a control that is
 *                    already wired and already tested.
 * @param onHold      fired once, at holdMs, on a press that has not slipped.
 *                    Omit for a control that only needs slip protection.
 * @param onHoldEnd   fired when a press that reached `onHold` ends, however it
 *                    ends. Where a tip is taken back down.
 * @param onSlip      fired the first time a press leaves the slop radius.
 *                    Called for a press that had already held, too — the tip
 *                    should go the moment you start pulling away from it.
 * @param holdMs      override, for a control that wants a different length.
 * @returns a function that unwires it.
 */
export function pressable(el, {
  onHold = null,
  onHoldEnd = null,
  onSlip = null,
  holdMs = null,
} = {}) {
  if (!el) return () => {};
  const wait = holdMs ?? cfg().holdMs ?? HOLD_MS;
  const slop = cfg().slop ?? SLOP;

  let timer = null;
  let held = false;      // onHold has fired for this press
  let slipped = false;   // the finger has left the slop radius
  let x0 = 0, y0 = 0;
  let id = null;

  const endHold = () => {
    if (!held) return;
    held = false;
    onHoldEnd?.();
  };

  const slip = () => {
    if (slipped) return;
    slipped = true;
    clearTimeout(timer);
    timer = null;
    // The tip goes as you pull away, not when you let go. Waiting for the
    // release leaves a box describing something the finger has already left,
    // which is the moment it stops being an answer to anything.
    endHold();
    onSlip?.();
  };

  const down = (e) => {
    // The primary button only. A right-click or a middle-click is not a press
    // and must not arm a hold that then eats the context menu's click.
    if (e.button != null && e.button > 0) return;
    id = e.pointerId;
    x0 = e.clientX;
    y0 = e.clientY;
    held = false;
    slipped = false;
    // CAPTURE, so the move and the release keep arriving after the finger has
    // drifted off the element — which is the whole gesture. Without it the
    // browser stops sending events the moment the pointer leaves, and a slip
    // is indistinguishable from a press that is still going.
    //
    // It is also what breaks `click`, which is why swallowNextClick exists.
    try { el.setPointerCapture?.(e.pointerId); } catch { /* not capturable */ }
    if (!onHold) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (slipped) return;
      held = true;
      // A HOLD IS NOT A TAP. The activation is cancelled the instant the hold
      // fires rather than at the release, so the card cannot be taken by a
      // press the player has already turned into a read.
      swallowNextClick();
      onHold(el);
    }, wait);
  };

  const move = (e) => {
    if (id != null && e.pointerId !== id) return;
    if (slipped) return;
    if (Math.hypot(e.clientX - x0, e.clientY - y0) > slop) slip();
  };

  const up = (e) => {
    if (id != null && e.pointerId != null && e.pointerId !== id) return;
    clearTimeout(timer);
    timer = null;
    // THE RELEASE POSITION DECIDES, and it has to be measured rather than
    // inferred from the event's target: the capture above retargets everything
    // to `el`, so `e.target` is this element however far away the finger is.
    // The rectangle is read here, on a release, which is a gesture boundary and
    // not a frame — no menu in this game reads layout per frame and this does
    // not either.
    if (!slipped && e.clientX != null) {
      const r = el.getBoundingClientRect();
      const outside = r.width > 0 && (e.clientX < r.left || e.clientX > r.right
        || e.clientY < r.top || e.clientY > r.bottom);
      if (outside) slipped = true;
    }
    if (slipped || held) swallowNextClick();
    endHold();
    slipped = false;
    id = null;
  };

  const cancel = () => {
    clearTimeout(timer);
    timer = null;
    // A cancelled gesture — a scroll took it, a second finger arrived, the OS
    // claimed it for an edge swipe — produces no click on any platform, so
    // nothing is swallowed here. Arming the suppressor for a click that never
    // comes is what would eat the player's next tap.
    endHold();
    slipped = false;
    id = null;
  };

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  // touchend/touchcancel ALONGSIDE the pointer pair, for the same reason the
  // pause button carries them: a held touch has been observed reporting
  // `pointerdown touchstart touchend` with no pointerup at all, and a hold left
  // armed after the finger is gone is the one failure this must not have.
  // Every handler here is idempotent.
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('touchend', up);
  el.addEventListener('touchcancel', cancel);

  return () => {
    clearTimeout(timer);
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', cancel);
    el.removeEventListener('touchend', up);
    el.removeEventListener('touchcancel', cancel);
  };
}

/**
 * Slip protection alone, for a control that has no tip to show.
 *
 * Every button in every menu: press it, change your mind, slide your thumb off,
 * let go — and nothing happens. It is the half of the gesture people already
 * expect from every native control they have ever used, and the half this game
 * did not have.
 */
export function noClickThrough(el) {
  return pressable(el, {});
}

/**
 * Wire a CONTAINER once for every pressable descendant matching `selector`.
 *
 * For the surfaces that rebuild their children constantly — the hive throws
 * every tile away on each pick, the level-up row is re-dealt per level — where
 * per-element wiring means re-binding after every rebuild and the first missed
 * re-bind is a tile that silently stops answering. The listeners live on the
 * container, which outlives all of it.
 *
 * The gesture is otherwise identical, including the capture: the element under
 * the finger at `pointerdown` is the one the whole press belongs to, so sliding
 * from one hexagon to its neighbour is a slip off the first rather than a tap
 * on the second. That is the right reading — the finger went somewhere the
 * player did not mean it to — and it is the only one that keeps the hold's
 * subject stable for the length of the hold.
 */
export function pressableWithin(host, selector, opts = {}) {
  if (!host) return () => {};
  let live = null;
  let unwire = null;

  const drop = () => {
    unwire?.();
    unwire = null;
    live = null;
  };

  const down = (e) => {
    const el = e.target?.closest?.(selector);
    if (!el || !host.contains(el)) return;
    // A previous press whose release never arrived. Dropped rather than
    // ignored: leaving it wired would leave a stale hold armed on an element
    // the finger left long ago.
    if (live !== el) drop();
    if (!live) {
      live = el;
      unwire = pressable(el, opts);
    }
    // The element's own pointerdown has not run yet — this listener is on the
    // container and the event is still descending — so re-dispatching is not
    // needed and would double the press. The freshly wired listener catches
    // this same event on its way back UP through the bubble phase.
  };

  host.addEventListener('pointerdown', down, true);
  return () => {
    host.removeEventListener('pointerdown', down, true);
    drop();
  };
}
