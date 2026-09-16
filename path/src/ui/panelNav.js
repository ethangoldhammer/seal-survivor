// ---------------------------------------------------------------------------
// A CURSOR FOR THE PLAIN DOM PANELS — the ones that are a box of buttons over
// the screen and nothing more: the Seal sports list, the leaderboard, and the
// tip jar's tier sheet.
//
// WHY THEY NEEDED ONE. Every screen in this game with a cursor of its own grew
// it because it had a shape worth walking — the level-up hand is a lattice
// (ui.js), the pause menu is rows with sliders in them (pauseMenu.js), the main
// menu is hexagons in world space (systems/mainMenu.js), the team select is one
// chip per controller (teamSelect.js). The three panels here have none of that.
// They are a column of <button>s, which is exactly why each of them shipped with
// a mouse and nothing else — and two of them are reachable FROM a pad cursor,
// off the main menu's hexagons, so a pad player could open a panel they then had
// no way to press a button on or leave. That is worse than a panel a pad cannot
// open at all.
//
// ONE MODULE AND NOT THREE COPIES, for the reason gameOverStops has its note:
// the fiddly parts of a list cursor are not the stepping, they are what counts
// as a stop (a disabled button is not one, nor is one inside a hidden block),
// what happens when the list is rebuilt underneath the cursor, and the rule that
// nothing is highlighted until the player asks for it. Written three times those
// three would drift.
//
// A REGISTRY RATHER THAN A CALL PER PANEL. main.js already carries a line per
// cursor in its frame loop and each one is a place to forget the next screen;
// panels register themselves when they are built and `updatePanelNav` is the one
// line that drives whichever is up. When two are open at once the TOP one takes
// the frame — the tip sheet is a modal over whatever opened it — which is
// decided by `priority` and, among equals, by which opened last.
//
// NOTHING IS HIGHLIGHTED UNTIL THE PLAYER ASKS. The same rule the score card and
// the cards follow: a panel that opens with a button already lit is lying to a
// mouse player about what a click will do, and the first direction or confirm
// off a pad is the asking.
//
// THE CURSOR IS A CLASS (.sv-nav-sel), not focus — see the note in pauseMenu.js.
// Focus is moved with it so a screen reader and the keyboard agree, but the
// highlight never depends on the browser's guess about whether to draw a ring.
//
// KEYBOARD TOO, AND ON PURPOSE. These panels are real buttons, so Tab and Enter
// already worked; the arrow keys did not, and a player who has just used them on
// the pause menu has no way to know this panel is different. Escape is left
// alone unless a panel asks for it: the tip sheet already has its own (in
// tipJar.js, in capture, so it lands before anything under it), and two handlers
// for one key is the thing that closes two panels on one press.
//
// EVERY CONTROLLER IN THE ROOM, and this is a correctness rule rather than a
// generosity. `menuInput` is ONE pad — the one getGamepad() elects — and that
// election has a versus branch: with a match flagged on and no captain written
// yet, a SINGLE connected controller resolves to null rather than be shared
// between two seals (input.js). Every screen driven by menuInput is then dead to
// the pad, with nothing on screen admitting it. That is what a report of "the
// gamepad can't select from the Seal sports menu" turned out to be, and no
// amount of care inside this file would have survived it.
//
// So these panels poll navigator.getGamepads themselves, through the same
// ui/padPoll.js the team select and the match-over prompt use. It is also the
// right model on its own terms: a list of sports has no player one, and any
// controller somebody picks up should be able to answer it. Edge-triggered with
// no repeat clock, which a four-item list does not need.
// ---------------------------------------------------------------------------

// EVERY PAD, NOT THE ONE input.js ELECTED — see the note above updatePanelNav.
import { pollPads } from './padPoll.js';
import { feedback } from '../systems/feedback.js';
import { isTextEntry } from './typing.js';

/**
 * @typedef {object} PanelNavSpec
 * @property {string}   id        for the registry, and for a test to name one.
 * @property {() => boolean} isOpen    is this panel up right now?
 * @property {() => Element[]} controls  its stops, in reading order. Re-asked
 *   every frame: a panel that rebuilds its list (the leaderboard's global rows
 *   landing) would otherwise be walked with handles to elements that have left
 *   the document.
 * @property {() => void} [onBack]  B on a pad, and Escape if `keyBack`.
 * @property {boolean} [keyBack]    take Escape as well. Off by default — see
 *   the header on why the tip sheet does not want it.
 * @property {number} [priority]    higher is nearer the player. A modal over
 *   another panel is higher than the one it covers.
 */

/** Every panel that has registered, in registration order. */
const panels = [];
/** Which panel the cursor is in, and where — cleared when that panel closes. */
let activeId = null;
let cursor = -1;
/** Bumped on each open, so two panels of equal priority are ordered by it. */
let opened = 0;
const openedAt = new Map();
let keyHandler = null;
/** What each pad was holding last frame — pollPads owns the shape, we own the Map. */
const padPrev = new Map();

/**
 * Register a panel. Idempotent by id: a screen rebuilt in place (the audit
 * mounts these more than once in a page) re-registers rather than stacking a
 * second spec that would take every other frame.
 */
export function registerPanelNav(spec) {
  const at = panels.findIndex((p) => p.id === spec.id);
  const entry = { priority: 0, keyBack: false, ...spec };
  if (at >= 0) panels[at] = entry;
  else panels.push(entry);
  if (!keyHandler) {
    keyHandler = onKey;
    // IN CAPTURE, for the same reason tipJar.js's Escape is. main.js binds
    // Escape to the pause toggle on the WINDOW, in bubble — and among two
    // listeners on the same target in the same phase, order of registration
    // decides, which is a thing nobody should have to reason about. In capture
    // this lands first whatever else has been bound since.
    window.addEventListener('keydown', keyHandler, true);
  }
  return entry;
}

/** For a test, and for a screen that is genuinely gone. */
export function unregisterPanelNav(id) {
  const at = panels.findIndex((p) => p.id === id);
  if (at >= 0) panels.splice(at, 1);
  if (activeId === id) clearCursor();
  if (!panels.length && keyHandler) {
    window.removeEventListener('keydown', keyHandler, true);
    keyHandler = null;
  }
}

/**
 * Every control a panel names, INCLUDING the ones that are not stops.
 *
 * The clearing pass walks this rather than the filtered list, and that is not a
 * nicety: a panel is hidden by putting .sv-hidden on the box AROUND its
 * controls, so the moment it closes every one of them fails the filter below and
 * the cursor's own class can never be taken off. The highlight then reappears,
 * already lit, the next time the panel is opened — which is exactly the thing
 * the "nothing is lit until the player asks" rule exists to prevent.
 */
function allControlsOf(panel) {
  try { return [...(panel.controls?.() ?? [])].filter(Boolean); } catch { return []; }
}

/** The stops a panel actually has this frame. */
function stopsOf(panel) {
  const list = allControlsOf(panel);
  // A DISABLED BUTTON AND A HIDDEN ONE ARE BOTH UNREACHABLE FOR A MOUSE, so
  // neither may be a stop for the pad either — a cursor that lands on something
  // nobody can see is a cursor that has vanished. The "coming soon" sports are
  // exactly this: real buttons, deliberately disabled, sitting in the middle of
  // the list the cursor walks.
  return list.filter((c) => !c.disabled && !c.closest?.('.sv-hidden'));
}

/**
 * WHICH PANEL OWNS THE PAD — the open one nearest the player, or null.
 *
 * Exported because the screens UNDER these have to yield: the main menu's own
 * hexagon cursor is still running while a panel it opened is up, and without
 * this a push on the stick walks both.
 */
export function panelNavTarget() {
  let best = null;
  let bestKey = -Infinity;
  for (const p of panels) {
    let up = false;
    try { up = !!p.isOpen?.(); } catch { up = false; }
    if (!up) { openedAt.delete(p.id); continue; }
    if (!openedAt.has(p.id)) openedAt.set(p.id, ++opened);
    const key = p.priority * 1e6 + openedAt.get(p.id);
    if (key > bestKey) { bestKey = key; best = p; }
  }
  return best;
}

/** Is any registered panel up? The one-liner the screens underneath ask. */
export function panelNavOpen() {
  return !!panelNavTarget();
}

function clearCursor() {
  for (const p of panels) {
    for (const c of allControlsOf(p)) c.classList?.remove('sv-nav-sel');
  }
  activeId = null;
  cursor = -1;
}

/**
 * Put the cursor on stop `i` of `panel`. Clamped rather than wrapped, which is
 * what every other list in this game does: a push at the end of a four-item
 * menu that lands you back at the top is a cursor that has teleported.
 */
function select(panel, i, stops) {
  const was = activeId === panel.id ? cursor : -1;
  cursor = Math.max(0, Math.min(stops.length - 1, i));
  activeId = panel.id;
  if (was !== cursor) feedback('uiHover');
  // Cleared across every registered panel's stops, not just this one's: a list
  // SHRINKS (the leaderboard's rows are repainted when the global board lands),
  // and a highlight cleared only within the new list is a button still lit
  // somewhere nobody is looking.
  for (const p of panels) {
    for (const c of allControlsOf(p)) c.classList?.toggle('sv-nav-sel', p === panel && c === stops[cursor]);
  }
  stops[cursor]?.focus?.({ preventScroll: true });
}

/**
 * EVERY PAD'S PRESSES THIS FRAME, FOLDED INTO ONE — because on these screens
 * there is no player one. Four controllers in a room and any of them may walk
 * the list; two pushing opposite ways in the same frame cancel, which is the
 * correct answer to two people fighting over one cursor and is what the DOM
 * would do with two mice.
 */
function padPresses(list) {
  const out = { left: false, right: false, up: false, down: false, a: false, b: false, start: false };
  for (const p of pollPads(padPrev, list)) {
    for (const k of Object.keys(out)) if (p.press[k]) out[k] = true;
  }
  return out;
}

/**
 * Once a frame, from the loop the other cursors are driven in. Returns true
 * while a panel is up — whether or not it did anything with the frame — so the
 * caller can stop before driving whatever is behind it.
 *
 * `list` is for a harness: a stand-in for navigator.getGamepads(), the same
 * parameter updateTeamSelect takes and for the same reason.
 */
export function updatePanelNav(list = null) {
  const panel = panelNavTarget();
  if (!panel) {
    // THE POLL STILL RUNS, and it must. padPrev is what turns a held button into
    // one press: skipped while no panel is up, a button already down when a
    // panel opens reads as a fresh press on its first frame — which is the A
    // that opened the panel pressing the first row of it.
    pollPads(padPrev, list);
    // The highlight goes with the panel, not just the index behind it: a class
    // left on a button is a panel that reopens with something already chosen.
    if (activeId) clearCursor();
    return false;
  }
  if (activeId && activeId !== panel.id) clearCursor();
  const press = padPresses(list);
  const stops = stopsOf(panel);
  // A PANEL WITH NO STOPS STILL OWNS THE FRAME. It is over the screen
  // underneath, and letting the pad fall through to that would drive something
  // the player cannot see.
  if (!stops.length) return true;

  // B is the way out on any console, and it is checked before the cursor so it
  // works from anywhere in the list.
  if (press.b && panel.onBack) { panel.onBack(); return true; }

  const confirm = press.a || press.start;
  const x = press.right ? 1 : press.left ? -1 : 0;
  const y = press.down ? 1 : press.up ? -1 : 0;

  if (activeId !== panel.id || cursor < 0 || cursor >= stops.length) {
    if (x || y || confirm) select(panel, 0, stops);
    return true;
  }
  // ONE FLAT LIST, STEPPED BY EITHER AXIS. These panels are a column (the
  // sports list, the leaderboard) or a wrapped grid of tiers, never a shape
  // where "down" and "right" mean different things — so a player pushing
  // whichever one they thought of is right, the same bargain the score card's
  // cursor makes.
  const step = y || x;
  if (step) select(panel, cursor + (step > 0 ? 1 : -1), stops);
  // Through the control's own click, so a pad can never take a path the mouse
  // does not — the sound bound to it included.
  if (confirm) stops[cursor]?.click?.();
  return true;
}

/** The keyboard's turn. Same cursor, same stops, same activation. */
function onKey(e) {
  const panel = panelNavTarget();
  if (!panel) return;
  // isTextEntry and not isTypingTarget — see the note on both in ui/typing.js.
  if (isTextEntry(e.target)) return;
  const stops = stopsOf(panel);
  if (!stops.length) return;
  let handled = true;
  const at = activeId === panel.id ? cursor : -1;
  switch (e.key) {
    case 'ArrowUp': case 'ArrowLeft':
      select(panel, at < 0 ? 0 : at - 1, stops); break;
    case 'ArrowDown': case 'ArrowRight':
      select(panel, at < 0 ? 0 : at + 1, stops); break;
    case 'Enter': case ' ':
      // ONLY WHAT THIS CURSOR IS ON. With nothing selected the key belongs to
      // whatever the browser has focused — which on a panel opened by a mouse
      // is the button the player tabbed to — and swallowing it here would break
      // the keyboard route that already worked.
      if (at >= 0) stops[at]?.click?.();
      else handled = false;
      break;
    case 'Escape':
      if (panel.keyBack && panel.onBack) panel.onBack();
      else handled = false;
      break;
    default:
      handled = false;
  }
  // Only what was actually used. Escape in particular has to reach the handlers
  // under it on a panel that did not ask for it.
  //
  // stopImmediatePropagation and not stopPropagation: the handler this is
  // beating is on the WINDOW too (main.js's pause key), and stopPropagation
  // only stops an event moving to the next NODE — every other listener on this
  // one still runs. Without it, Escape on the sports list closed the list and
  // toggled the pause behind it, which is one key press doing two things.
  if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
}

/** For tests: what the cursor is on, by panel id and index. */
export function panelNavState() {
  return { id: activeId, index: cursor, panels: panels.map((p) => p.id) };
}

/** For tests and for a teardown that wants a clean sheet. */
export function resetPanelNav() {
  clearCursor();
  openedAt.clear();
  // ...and the pads start from "nothing held", which is what a button still
  // down as a screen closes and reopens has to read as.
  padPrev.clear();
}
