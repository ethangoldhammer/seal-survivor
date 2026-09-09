// WHERE THE POINTER ALREADY IS.
//
// Three surfaces in this game turn their pointer-events ON after the player is
// already pointing at them, and every one of them lost the first hover:
//
//   the level-up cards   `.sv-menu-locked` is `pointer-events: none` on the
//                        whole menu while the hand slams in (about two thirds
//                        of a second). The cards deal into the middle of the
//                        screen, which on a mouse is exactly where the pointer
//                        already is — it is the aim.
//   the corner hive      hoverable only while the run is stopped, and the hive
//                        sits in a corner the pointer crosses constantly while
//                        shooting. Pausing with the cursor on a hexagon is the
//                        normal way to end up looking at one.
//   the hive sheet       opens under whatever the pointer was on to open it.
//
// A pointer that does not move gets no `pointerenter` and no `pointerover` when
// the thing beneath it becomes hoverable — that is not a bug in any of the
// three, it is what the events mean. So the surface has to ask, and this is
// what it asks: where is the pointer, and what is under it now.
//
// WHY NOT SYNTHESISE AN EVENT. Dispatching a fake `pointerenter` at the tile
// would also drive every other listener on it — `pressable`'s among them, on a
// surface where a hold cancels a pick — for a gesture the player did not make.
// The surfaces call their own show function instead, which is the one thing
// they actually wanted.
//
// THE COST IS TWO NUMBERS. One passive listener, writing two fields, on moves
// the browser is already dispatching to the canvas for aim. Nothing here runs
// per frame and nothing holds an element.

let px = null;
let py = null;

// A TOUCH IS NOT A HOVER. A finger leaves the screen and the last place it
// touched is not somewhere a tip should appear — the phone surfaces have their
// own answer for this and it is `pressable`'s hold, not a hover. Recording a
// touch's coordinates here would put a tip up on the tile a player last tapped
// every time a menu unlocked.
function note(e) {
  if (e.pointerType === 'touch') { px = null; py = null; return; }
  px = e.clientX;
  py = e.clientY;
}

function forget() {
  px = null;
  py = null;
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  // Capture, so a surface that stops propagation on its own subtree — the
  // splash's parallax does — cannot hide the pointer from this.
  window.addEventListener('pointermove', note, { passive: true, capture: true });
  // A press without a preceding move is the first thing a pen or a fresh mouse
  // does, and on a laptop trackpad a click can arrive before any move at all.
  window.addEventListener('pointerdown', note, { passive: true, capture: true });
  // Out of the window entirely: `pointerout` with no relatedTarget. Without
  // this, a menu unlocking while the mouse is off the side of the screen would
  // put a tip up on whatever is at the pointer's last known position.
  window.addEventListener('pointerout', (e) => { if (!e.relatedTarget) forget(); }, true);
  window.addEventListener('blur', forget);
}

/** The last hovering pointer position, or null when there isn't one. */
export function pointerPos() {
  return px == null ? null : { x: px, y: py };
}

/**
 * The nearest element matching `selector` under the pointer right now, or null.
 *
 * Hit-tested live rather than remembered, which is the whole point: the caller
 * is asking BECAUSE what is under the pointer just changed, and a cached answer
 * would be the state this is meant to correct.
 */
export function hoveredElement(selector) {
  if (px == null || typeof document === 'undefined') return null;
  // elementFromPoint flushes style and layout, so the pointer-events the caller
  // just turned on are already in force — no frame of delay needed.
  const at = document.elementFromPoint?.(px, py);
  return at?.closest?.(selector) ?? null;
}

/** For the tests, which have no real pointer. */
export function setPointerPosForTest(x, y) {
  px = x;
  py = y;
}
