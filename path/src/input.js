import * as THREE from 'three';
import { CONFIG } from './config.js';
import { actionForKey, stickDeadzone } from './systems/settings.js';
import { defaultDevice, shoulderLabel } from './devices.js';

// There is no `firing` here any more. The seal shoots on its own — see
// CONFIG.weapon.autofire, which is now the only thing that decides whether the
// guns are live. Every input that used to pull the trigger (click, gamepad A, a
// hard push on the touch aim stick) went to the strike meter instead, because a
// button you have to hold down to keep shooting is a button you can't spend on
// anything else.
export const input = {
  move: new THREE.Vector2(0, 0),
  aim: new THREE.Vector2(1, 0),
  strike: false, // edge-triggered — true for exactly one frame per press
  // The strike is a charge-up now: the press starts the meter filling, and it
  // is the RELEASE that launches the dash (see systems/strike.js). So the
  // press edge above is no longer enough on its own — the charge needs to know
  // the button is still down, every frame, and the launch needs the moment it
  // stops being down.
  strikeHeld: false,    // level — true for as long as any strike input is down
  strikeRelease: false, // edge-triggered — true for exactly one frame per let-go
  // Is the player DELIBERATELY pointing the seal this frame — a pushed right
  // stick, or a thumb on the aim half. Not the same question as `aim`, which
  // always holds a direction and is never "off": something has to be true for
  // the guns, and the last direction given is the only sane answer.
  //
  // Only the two devices that aim by gesture can report it. A mouse aims by
  // existing — the pointer is always somewhere and the seal always faces it —
  // so there is no moment to catch and this stays false on a keyboard. The one
  // thing reading it is the first-run coach, which does not teach aiming to a
  // mouse for that exact reason.
  aiming: false,
  // The clap button — edge-triggered, true for exactly one frame per press.
  // Edge and nothing else: there is no held state to keep, because the gesture
  // it starts re-enters itself rather than being sustained (see
  // systems/clap.js). A key held down does not clap continuously, which is
  // deliberate — auto-repeat is not a rhythm.
  clap: false,
};

// Menu navigation, kept separate from `input` on purpose: gameplay wants a
// continuous analog stream, a menu wants discrete steps. x/y are true for
// exactly one frame per step (with auto-repeat while held), in SCREEN space —
// y is +1 for down, matching both the D-pad and axis 1.
export const menuInput = {
  x: 0,
  y: 0,
  confirm: false,
  // Start, edge-triggered. Opens the pause menu from a run and closes it
  // again — it is the button every player already tries. It is also in
  // CONFIRM_BUTTONS, which is not a conflict as long as whoever consumes this
  // re-baselines the menu input when the pause state changes: resetMenuInput
  // adopts the held Start rather than zeroing it, so the same press cannot
  // also confirm whatever the cursor opened onto.
  pause: false,
  // B / Circle, edge-triggered. The universal "back" — it closes the pause
  // menu, and it is what a pad player tries before they try Start a second
  // time. Not bound to anything in gameplay, so it costs nothing to reserve.
  back: false,
  // LB and RB, edge-triggered. Sideways movement THROUGH a menu rather than
  // within it: the pause menu's tab strip. The strip is also reachable as the
  // top row with the stick, but a bumper works from anywhere in the list,
  // which is what the strip is for on a pad.
  tabPrev: false,
  tabNext: false,
  // THE DICE, on a pad. Edge-triggered, and the reason they exist is that a
  // name can no longer be typed anywhere a pad can reach: the splash takes no
  // typing at all and the score card's "Next seal" is a readout with a Roll
  // button beside it. Without these a pad player gets whatever the game rolled
  // for them and has no say in it.
  //
  // Both shoulders on a side, so it does not matter which finger goes first:
  //   RB / RT   a new name
  //   LB / LT   back to the one before it
  //
  // Deliberately the SAME buttons as tabNext/tabPrev, which is not a conflict:
  // the tab strip belongs to the pause menu and these belong to the two name
  // screens, and no pad can reach both at once.
  nameNext: false,
  namePrev: false,
  // ANY face/stick button going down, edge-triggered. For surfaces that ask for
  // "press anything to continue" rather than for a choice — the splash. The
  // keyboard's version of this is a bare keydown listener; the pad has no
  // events at all, so this is that listener's other half.
  //
  // THE FOUR SHOULDERS ARE NOT IN IT, because on the one screen that asks
  // "press anything" they are the dice (see nameNext/namePrev above), and a
  // button that rolls a name must not also start the run with it.
  anyPress: false,
  // Like `anyPress` but with the D-pad excluded — a press that is a DECISION
  // rather than any contact at all. See anyActionButtonDown.
  actionPress: false,
};

const keys = { up: false, down: false, left: false, right: false };
let strikeRequested = false;
let spaceHeld = false;
// Last frame's held state, which is the only way to spot the let-go. Seeded
// from whatever is physically down in clearPendingInput, so a trigger already
// held as a run begins can't read as a release on frame one.
let strikeHeldPrev = false;
// Same job as strikeButtonHeld, for the touch routes: spot the moment a strike
// touch goes down so it can raise the press edge once rather than every frame.
let touchStrikePrev = false;
// LB, RB, LT, RT — Standard Gamepad indices. All four boost.
const STRIKE_BUTTONS = [4, 5, 6, 7];
const strikeButtonHeld = {};
let clapRequested = false;
// X / Square — Standard Gamepad index 2. The one free face button in
// gameplay: 0 is the menu confirm (and so cannot be spent, see the firing note
// in updateInput), 1 is the universal back, and 3 is left unclaimed rather
// than doubled up on this, so there is still a face button to spend on the
// next thing that needs one.
const CLAP_BUTTON = 2;
let clapButtonHeld = false;
let domElement = null;
const mouseNDC = new THREE.Vector2(0, 0);
// The mouse's charge input, joining the same OR as Space and the four shoulder
// buttons. ANY button counts — left is the one to reach for, but with autofire
// there's nothing else a click could mean, so right and middle charge too
// rather than being quietly inert.
let mouseStrikeHeld = false;
let hasMouse = false;
// Which buttons are physically down, by `MouseEvent.button`. Tracked as a set
// rather than a single flag: press left, press right, release right should keep
// charging, and a boolean would drop the meter on the first let-go.
const mouseButtonsDown = new Set();

// --- touch: a floating stick that steers, a pointer that aims --------------
// Fingers are tracked by `identifier`, never by position in the touches list.
// `touches[0]` is only "the first finger" by accident — it's whichever one the
// browser lists first, so lifting the left thumb promotes the right one to
// steering mid-run.
//
// A finger claims a half by WHERE IT LANDS, not by arrival order. Order sounds
// right ("first touch moves, second aims") right up until the player lifts and
// re-plants their left thumb while still aiming: the re-plant is then the only
// touch looking for a slot and it takes the one that's free, which is aim. The
// ship stops steering and starts pointing instead.
//
// THE TWO HALVES ARE NOT THE SAME KIND OF CONTROL, and both entries here being
// the same shape hides that:
//
//   move  a floating stick. The anchor is wherever the thumb went down, and
//         what's read is DEFLECTION from it — direction and how far. See
//         readStick.
//   aim   a pointer. The anchor is ignored entirely and only `current` is read,
//         because the seal aims at the world point under the fingertip the same
//         way it aims at the mouse cursor. See readAimTouchNDC.
//
// The anchor is still recorded for the aim half: the double-tap-and-hold strike
// measures tap drift against it, and it costs nothing to keep.
const sticks = {
  move: null, // { id, start: Vector2, current: Vector2, down, charging }
  aim: null,
};

// Strike, which has no shoulder button on a phone. Two routes in, both live at
// once and OR'd together the way LB/RB/LT/RT already are. See CONFIG.touch.strike.
let strikeTouchId = null; // the third finger, while it's down
// Per-half tap bookkeeping for the double-tap-and-hold: the last quick press
// that half saw, waiting to pair with a re-press. Cleared aggressively — a
// stale tap left armed turns an ordinary thumb re-plant into a strike.
const lastTap = { move: null, aim: null }; // { at, x, y }
// A cancelled contact must not launch. Control Center swipes and incoming
// calls end a touch without the player letting go, and reading that as a
// release spends a full charge on nothing.
let suppressStrikeRelease = false;

// --- multitouch, for the grid ----------------------------------------------
// The sticks above care about ROLES — which half a thumb landed in, and what
// that half does. This cares about FINGERS: every contact on the canvas, sticks
// and strike fingers included, so the backdrop can light up under each one.
//
// A finger takes the LOWEST FREE slot as it lands and holds it until it lifts.
// Not a monotonically increasing counter: with one, lifting and re-planting the
// left thumb would walk it up through the palette, and the grid would change
// colour under a thumb that never moved. Lowest-free means the first finger
// down is slot 0 for as long as it's down, every time.
//
// Position is kept in NDC rather than client px because the only consumer
// unprojects it through the camera — see systems/grid.js. Slots hold their last
// position after the lift so the glow has somewhere to fade out FROM.
export const TOUCH_SLOTS = 5;
export const touchSlots = Array.from({ length: TOUCH_SLOTS }, () => ({
  id: null, // browser touch identifier, or null while the slot is free
  x: 0,
  y: 0,
  // Is THIS finger winding up a strike? Either route counts — the third-touch
  // finger and a double-tap-and-hold thumb both charge the same meter, and the
  // grid grows whichever one is doing it. Derived every frame in updateInput
  // rather than latched at touchdown: it is a view of state that lives in the
  // sticks and in strikeTouchId, and a copy of that could go stale.
  charging: false,
}));

// The gameplay deadzone is a player setting now (Controls tab) — worn sticks
// drift by wildly different amounts, and 0.15 is a guess about a specific pad.
// Read through stickDeadzone() at every use rather than cached here, so
// dragging the slider in the pause menu takes effect on the next frame.
//
// MENU_DEADZONE below stays a constant on purpose: it is not about the
// hardware, it is about a menu step needing a deliberate push — otherwise the
// drift that's harmless in gameplay walks the selection across the cards on
// its own, and tying it to the gameplay setting would let a low deadzone do
// exactly that.
const MENU_DEADZONE = 0.5;
const MENU_REPEAT_DELAY = 0.42; // seconds held before the first repeat
const MENU_REPEAT_RATE = 0.13; // seconds between repeats after that
// D-pad, Standard Gamepad indices.
const DPAD_UP = 12, DPAD_DOWN = 13, DPAD_LEFT = 14, DPAD_RIGHT = 15;
// A confirms; Start does too, since that's the other button a player reaches
// for on a screen that's stopped the game.
const CONFIRM_BUTTONS = [0, 9];
// Which device most recently produced real input. Without this, `hasMouse`
// latched true on the first mouse move (unavoidable — you move the mouse to
// click Start) and the mouse-aim fallback then overwrote gamepad aim the
// instant you released the right stick, which reads as "gamepad doesn't
// work". Now the mouse only reclaims aim when it actually moves again.
let lastAimDevice = 'mouse'; // 'mouse' | 'gamepad' | 'touch'

// --- which device is in the player's hands ---------------------------------
// Related to lastAimDevice above and deliberately NOT the same thing. That one
// arbitrates who gets to point the seal, so it only ever moves on an input that
// AIMS, and it starts life as 'mouse' on every machine including phones. This
// one answers "what should the words on screen tell them to press", which any
// input at all is evidence about — a thumb on the movement stick says touch
// just as loudly as one on the aim stick.
//
// LAST DEVICE TO DO ANYTHING WINS, with no stickiness beyond that. The player
// who puts the keyboard down and picks up a pad mid-run has told us something
// true, and the tips are the one place that has to keep up: a first-run tip
// naming the wrong button is worse than no tip, because it is a wrong answer to
// a question the player is actively asking.
//
// `null` until real input arrives, so defaultDevice() can keep guessing rather
// than being latched in at boot.
let activeDevice = null;
// When the last touch landed. Mouse events are IGNORED for a moment after one:
// a tap on a touchscreen is followed by a synthesised mousemove/mousedown pair
// in every browser, and without this the very first tap of a phone player's
// first run would flip them to 'kbm' and teach them to press Space.
let lastTouchAt = -Infinity;
const SYNTHETIC_MOUSE_MS = 700;

function markDevice(device) {
  activeDevice = device;
}

// A mouse event that a touch just manufactured is not a mouse.
function markMouseDevice() {
  if (performance.now() - lastTouchAt < SYNTHETIC_MOUSE_MS) return;
  markDevice('kbm');
}

/**
 * Which of DEVICES the player is using right now. Read by anything that puts
 * the name of a control on screen — see calloutTable.js, and the `device` that
 * main.js hands to the callouts and the coach every frame.
 */
export function inputDevice() {
  return activeDevice ?? defaultDevice();
}

/**
 * Words for the hardware in front of the player, for the `{token}`s a callout
 * line can carry. Only the shoulder buttons so far, because they are the only
 * control the game asks for by name that the browser will not name for us —
 * see shoulderLabel.
 *
 * Read from the pad we last chose rather than from the connected list: with two
 * pads plugged in, the one being pressed is the one the words are about.
 */
export function inputTokens() {
  return { bumper: shoulderLabel(inputStatus.gamepadName) };
}

export const inputStatus = {
  gamepadConnected: false,
  gamepadName: '',
  gamepadBlocked: false,
  // Filled in each frame from the pad we actually chose to read, so a "the
  // controller does nothing" report can be checked instead of guessed at.
  // See ui/gamepadDebug.js — hold G to see these live.
  padIndex: -1,
  padMapping: '',
  padCount: 0,
  axes: [],
  buttons: [],
  // What inputDevice() is answering, refreshed each frame. Here rather than
  // only behind the getter because "the tips are showing the wrong buttons" is
  // a bug report about this value, and it should be readable next to the pad
  // state that most often explains it.
  device: defaultDevice(),
};

/**
 * A mouse position from somewhere that ISN'T the canvas.
 *
 * The listener above is on the canvas, which is right for a run and wrong for
 * every moment the game is showing a full-screen overlay: an element with
 * `pointer-events: all` on top of the canvas swallows the move events, and the
 * seal goes on aiming at wherever the pointer last was before the overlay
 * appeared. That is invisible on a menu the seal isn't in — and it is the whole
 * feature on the title screen, where the animal is meant to be watching the
 * cursor while the card is up. See systems/titleSeal.js.
 *
 * Deliberately the exact body of the canvas listener rather than a second path:
 * anything else and the seal would aim by two slightly different rules
 * depending on what was on top of it.
 *
 * MOUSE ONLY at the call site, and that gate matters. Feeding a touch through
 * here would set `hasMouse` and leave `lastAimDevice` at 'mouse' on a phone,
 * and the mouse fallback in updateInput would then aim the seal at a stale
 * fingerprint for the whole run whenever no thumb was down.
 */
export function feedMouse(clientX, clientY) {
  lastAimDevice = 'mouse';
  hasMouse = true;
  markMouseDevice();
  updateMouseNDC(clientX, clientY);
}

export function initInput(canvas) {
  domElement = canvas;

  checkGamepadPolicy();

  window.addEventListener('keydown', (e) => setKey(e, true));
  window.addEventListener('keyup', (e) => setKey(e, false));

  // Connection events, so a controller being detected (or not) is visible
  // rather than silent. Browsers only expose a pad AFTER a button press on
  // it — "connected but doing nothing" is usually just that.
  window.addEventListener('gamepadconnected', (e) => {
    inputStatus.gamepadConnected = true;
    inputStatus.gamepadName = e.gamepad?.id ?? 'gamepad';
    console.info(`[input] gamepad connected: ${inputStatus.gamepadName}`);
  });
  window.addEventListener('gamepaddisconnected', () => {
    inputStatus.gamepadConnected = false;
    console.info('[input] gamepad disconnected');
  });

  canvas.addEventListener('mousemove', (e) => feedMouse(e.clientX, e.clientY));
  canvas.addEventListener('mousedown', (e) => {
    hasMouse = true;
    markMouseDevice();
    // Raise the press edge here rather than in updateInput, the way Space does:
    // the event IS the edge, and a click that opens and closes inside one frame
    // would be invisible to a poll of `mouseStrikeHeld` alone.
    if (!mouseButtonsDown.size) strikeRequested = true;
    mouseButtonsDown.add(e.button);
    mouseStrikeHeld = true;
    updateMouseNDC(e.clientX, e.clientY);
  });
  window.addEventListener('mouseup', (e) => {
    mouseButtonsDown.delete(e.button);
    mouseStrikeHeld = mouseButtonsDown.size > 0;
  });
  // Otherwise a right-button charge opens the browser's context menu on top of
  // the game, which both hides the wind-up and swallows the mouseup that
  // launches.
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('blur', () => {
    keys.up = keys.down = keys.left = keys.right = false;
    // Backgrounding the tab mid-drag never delivers the touchend. If a strike
    // was winding up, drop it rather than launching — losing focus is not a
    // let-go, and the same reasoning as touchcancel applies. A held mouse
    // button is in the same boat: the mouseup lands on whatever took focus.
    const wasCharging = touchStrikeDown() || mouseStrikeHeld;
    mouseButtonsDown.clear();
    mouseStrikeHeld = false;
    clearSticks();
    if (wasCharging) suppressStrikeRelease = true;
  });

  // The rect is read ONCE per event rather than once per finger: it's a layout
  // read, and a five-finger touchmove arrives many times a second.
  canvas.addEventListener(
    'touchstart',
    (e) => {
      e.preventDefault();
      // Claim the aim channel up front. Otherwise the mouse fallback below —
      // which a touch device can still latch via a synthesised event — keeps
      // overwriting touch aim the moment the aim thumb comes off.
      lastAimDevice = 'touch';
      lastTouchAt = performance.now();
      markDevice('touch');
      const rect = canvas.getBoundingClientRect();
      forEachTouch(e.changedTouches, (t) => {
        beginTouch(t);
        claimTouchSlot(t, rect);
      });
    },
    { passive: false }
  );
  canvas.addEventListener(
    'touchmove',
    (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      forEachTouch(e.changedTouches, (t) => {
        const stick = stickById(t.identifier);
        if (stick) stick.current.set(t.clientX, t.clientY);
        moveTouchSlot(t, rect);
      });
    },
    { passive: false }
  );
  // touchcancel is not optional. iOS drops touches without a matching touchend
  // for an incoming call, a Control Center swipe or palm rejection, and a stick
  // left in the registry then steers at full deflection forever.
  const lift = (cancelled) => (e) => {
    e.preventDefault();
    forEachTouch(e.changedTouches, (t) => {
      endTouch(t, cancelled);
      releaseTouchSlot(t);
    });
  };
  canvas.addEventListener('touchend', lift(false), { passive: false });
  canvas.addEventListener('touchcancel', lift(true), { passive: false });
}

// TouchList predates iterables and is still not reliably iterable in Safari, so
// this stays an index loop rather than a for...of.
function forEachTouch(list, fn) {
  for (let i = 0; i < list.length; i++) fn(list[i]);
}

// Which stick a finger landing here belongs to. Measured against the canvas
// rect rather than the window so it stays right if the canvas is ever letter-
// boxed or inset.
function stickRoleAt(clientX) {
  const rect = domElement.getBoundingClientRect();
  const frac = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
  return frac < (CONFIG.touch.splitX ?? 0.5) ? 'move' : 'aim';
}

function beginTouch(t) {
  const role = stickRoleAt(t.clientX);
  const s = CONFIG.touch.strike ?? {};
  const now = performance.now();

  // That half already has a thumb on it, so this is a finger BEYOND the two
  // sticks: the third-touch strike. Only one at a time — a fourth contact is
  // ignored rather than stealing the charge from the third.
  if (sticks[role]) {
    if (s.thirdTouch && strikeTouchId === null) strikeTouchId = t.identifier;
    return;
  }

  const stick = {
    id: t.identifier,
    start: new THREE.Vector2(t.clientX, t.clientY),
    current: new THREE.Vector2(t.clientX, t.clientY),
    down: now,
    charging: false,
  };

  // Double-tap-and-hold. This press is the second half of a tap-then-hold in
  // the same screen half, so it charges a strike while still driving its
  // stick — the thumb keeps steering or aiming through the whole wind-up.
  const tap = lastTap[role];
  if (
    s.doubleTap &&
    tap &&
    now - tap.at <= (s.doubleTapMs ?? 300) &&
    Math.hypot(t.clientX - tap.x, t.clientY - tap.y) <= (s.tapSlop ?? 16)
  ) {
    stick.charging = true;
    lastTap[role] = null; // consumed, so a third tap starts a fresh pair
  }

  sticks[role] = stick;
}

// --- touch slots -----------------------------------------------------------
// Deliberately outside beginTouch/endTouch: those return early for a finger
// that isn't driving a stick, and the grid wants every contact — including the
// third-finger strike and the fourth one the strike ignores.

function touchSlotById(id) {
  for (const slot of touchSlots) if (slot.id === id) return slot;
  return null;
}

function setTouchSlotPos(slot, t, rect) {
  slot.x = rect.width > 0 ? ((t.clientX - rect.left) / rect.width) * 2 - 1 : 0;
  slot.y = rect.height > 0 ? -(((t.clientY - rect.top) / rect.height) * 2 - 1) : 0;
}

function claimTouchSlot(t, rect) {
  // A sixth finger simply doesn't light anything up. Growing the palette to
  // cover it would cost a uniform slot and a fragment-loop iteration for a case
  // that needs both hands flat on the glass.
  const slot = touchSlots.find((s) => s.id === null);
  if (!slot) return;
  slot.id = t.identifier;
  setTouchSlotPos(slot, t, rect);
}

function moveTouchSlot(t, rect) {
  const slot = touchSlotById(t.identifier);
  if (slot) setTouchSlotPos(slot, t, rect);
}

// The position is left behind on purpose — the glow fades out where the finger
// was, rather than snapping to the origin on the way down.
function releaseTouchSlot(t) {
  const slot = touchSlotById(t.identifier);
  if (!slot) return;
  slot.id = null;
  slot.charging = false;
}

// Which fingers are winding up a strike, recomputed from the sticks and
// strikeTouchId. Note this is per FINGER, unlike touchStrikeDown() below, which
// is the OR the strike meter reads: the grid has to grow the finger that is
// actually doing it, not light all five because one of them is.
function markChargingSlots() {
  for (const slot of touchSlots) {
    slot.charging =
      slot.id !== null &&
      (slot.id === strikeTouchId ||
        (!!sticks.move?.charging && sticks.move.id === slot.id) ||
        (!!sticks.aim?.charging && sticks.aim.id === slot.id));
  }
}

function stickById(id) {
  if (sticks.move?.id === id) return sticks.move;
  if (sticks.aim?.id === id) return sticks.aim;
  return null;
}

// `cancelled` is a touchcancel rather than a genuine let-go — see
// suppressStrikeRelease.
function endTouch(t, cancelled) {
  if (strikeTouchId === t.identifier) {
    strikeTouchId = null;
    if (cancelled) suppressStrikeRelease = true;
    return;
  }

  for (const role of ['move', 'aim']) {
    const stick = sticks[role];
    if (stick?.id !== t.identifier) continue;
    sticks[role] = null;
    if (stick.charging && cancelled) suppressStrikeRelease = true;

    // Arm a double-tap only for a press that was genuinely a TAP: quick, and
    // it barely moved. Without both tests every normal thumb lift would leave
    // one primed, and the next time you grabbed that stick you'd silently
    // start charging. A charging press never arms one either — its release is
    // the launch, not the first half of a new pair.
    const s = CONFIG.touch.strike ?? {};
    const held = performance.now() - stick.down;
    const drift = Math.hypot(
      stick.current.x - stick.start.x,
      stick.current.y - stick.start.y,
    );
    const wasTap =
      !stick.charging &&
      !cancelled &&
      held <= (s.tapMaxMs ?? 250) &&
      drift <= (s.tapSlop ?? 16);
    lastTap[role] = wasTap
      ? { at: performance.now(), x: stick.start.x, y: stick.start.y }
      : null;
  }
}

function clearSticks() {
  sticks.move = null;
  sticks.aim = null;
  strikeTouchId = null;
  touchStrikePrev = false;
  lastTap.move = null;
  lastTap.aim = null;
  suppressStrikeRelease = false;
  // Freed, not repositioned: whatever the grid is showing under these fingers
  // fades out from where they were, exactly as a normal lift does.
  for (const slot of touchSlots) {
    slot.id = null;
    slot.charging = false;
  }
}

/** Is a touch winding up a strike right now — either route. */
function touchStrikeDown() {
  return strikeTouchId !== null || !!sticks.move?.charging || !!sticks.aim?.charging;
}

// The MOVE stick's deflection: direction into `out`, magnitude returned as 0..1
// ramped from the deadzone edge, matching how applyDeadzone treats a physical
// stick. Returns 0 for centred, and leaves `out` untouched in that case.
//
// Only the move half goes through here. The aim half is a pointer, not a stick
// — see readAimTouchNDC.
function readStick(stick, out) {
  if (!stick) return 0;
  const t = CONFIG.touch;
  const dx = stick.current.x - stick.start.x;
  const dy = stick.current.y - stick.start.y;
  const len = Math.hypot(dx, dy);
  const dead = t.deadzone ?? 6;
  if (len <= dead) return 0;
  const radius = Math.max(dead + 1, t.stickRadius ?? 55);
  // Screen y grows downward, world y upward.
  out.set(dx / len, -dy / len);
  return Math.min(1, (len - dead) / (radius - dead));
}

// Where the aim thumb is touching, in NDC — the same coordinates the mouse
// publishes, because the aim thumb points the same way a mouse does: the seal
// aims AT the spot under it.
//
// This is not a stick reading, and that is the fix. Deflection measures from
// the ANCHOR — wherever the thumb happened to land — so the aim line started at
// a point that is invisible, arbitrary, and usually not the seal: plant low,
// drag up-right, and the seal pointed up-right no matter where on the screen
// the thumb had ended up. Absolute aiming has no anchor to be wrong about. The
// line runs from the player to the fingertip, which is a line the player can
// see, so what they are pointing at is exactly what they are touching.
//
// Returns false when there is no aim thumb down, or when the canvas has no size
// yet (a rect of zeros would put every touch at NDC (-1, 1), the top-left
// corner, and quietly aim the seal there).
function readAimTouchNDC(out) {
  const a = sticks.aim;
  if (!a) return false;
  const rect = domElement.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return false;
  out.set(
    ((a.current.x - rect.left) / rect.width) * 2 - 1,
    -(((a.current.y - rect.top) / rect.height) * 2 - 1)
  );
  return true;
}

const moveVec = new THREE.Vector2();
const aimNDC = new THREE.Vector2();

// Drops any half-finished input so a run never inherits it. The keypress that
// dismisses the splash also lands on setKey below, and Space is boost — without
// this, skipping the title card with the spacebar spent a charge on the first
// frame of the run. Same story for a key still held when a run restarts.
export function clearPendingInput() {
  strikeRequested = false;
  clapRequested = false;
  // Adopt whatever is physically down RIGHT NOW as the baseline rather than
  // zeroing it. Clearing to false would make a trigger the player happens to be
  // holding as the run begins read as a brand-new press on the next frame, which
  // is the very thing this function exists to prevent.
  const pad = getGamepad();
  let anyStrikeDown = false;
  for (const b of STRIKE_BUTTONS) {
    strikeButtonHeld[b] = !!pad?.buttons[b]?.pressed;
    if (strikeButtonHeld[b]) anyStrikeDown = true;
  }
  // Space is zeroed rather than sampled — there's no way to ask the keyboard
  // what is currently down, and a keyup still to come will simply set it false
  // again. `strikeHeldPrev` adopts the pad's real state for the same reason
  // the loop above does: a trigger held through a restart must not read as a
  // release (and so launch a strike) on the first frame of the new run.
  spaceHeld = false;
  strikeHeldPrev = anyStrikeDown;
  // Zeroed rather than sampled, for the same reason as Space: there's no way to
  // ask which mouse buttons are down, and a mouseup still to come will empty the
  // set anyway. This matters more now that the click IS the strike — the click
  // on "Start run" is still down as the first frame renders.
  mouseButtonsDown.clear();
  mouseStrikeHeld = false;
  // The tap that dismissed the splash or the score card is still down; adopting
  // it as a stick anchor would have the run open with a thumb already deflected
  // from wherever the button happened to be.
  clearSticks();
  keys.up = keys.down = keys.left = keys.right = false;
  input.move.set(0, 0);
  input.strike = false;
  input.strikeHeld = anyStrikeDown;
  input.strikeRelease = false;
  // Adopted rather than zeroed, like the strike buttons above: a face button
  // still down from dismissing the score card must not read as a fresh press
  // on the first frame of the new run.
  clapButtonHeld = !!pad?.buttons[CLAP_BUTTON]?.pressed;
  input.clap = false;
}

// The arrow keys, which are NOT rebindable and always steer. Kept as a fixed
// alternate rather than folded into the bindings so there is always a way to
// move: the pause menu can rebind WASD into a tangle, and a player who has
// done that has to still be able to reach the menu and undo it.
const FIXED_MOVE = { arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right' };

function setKey(e, down) {
  // Any key at all, bound or not, and only on the way down: a keyup arriving
  // from the key that dismissed the splash is not somebody choosing a keyboard.
  if (down) markDevice('kbm');
  const k = e.key.toLowerCase();
  // The player's binding first, then the fixed arrows. Two lookups rather than
  // one merged map because a rebind must be able to move `up` off W without
  // also being able to take the arrow key away from it.
  const action = actionForKey(k) ?? FIXED_MOVE[k] ?? null;

  if (action === 'up' || action === 'down' || action === 'left' || action === 'right') {
    keys[action] = down;
    return;
  }
  // The strike charges. The keydown edge (guarded against auto-repeat) starts
  // the meter; `spaceHeld` is what keeps it filling, and the keyup is what
  // launches. Held state has to be tracked separately from the edge — key
  // auto-repeat fires keydown over and over, so counting those as "still held"
  // would work, but a key released while the window was unfocused would never
  // arrive and the meter would fill forever.
  //
  // Still called `spaceHeld` because Space is still the default and every
  // other reference in this file reads that way; what it means now is "the
  // strike KEY, whatever it is bound to, is down".
  if (action === 'strike') {
    if (down && !e.repeat) strikeRequested = true;
    spaceHeld = down;
  }
  // The clap. `!e.repeat` is doing real work here rather than being copied off
  // the line above: this is a key somebody WILL hold down, and auto-repeat
  // would fire it at whatever rate the OS keyboard is set to — a tempo the
  // player did not choose and cannot hear coming.
  if (action === 'clap' && down && !e.repeat) clapRequested = true;
  // 'pause' is deliberately not handled here. It stops the run and opens a
  // menu, which is main.js's business — this file only turns devices into
  // per-frame state and has no idea a menu exists.
}

function updateMouseNDC(clientX, clientY) {
  const rect = domElement.getBoundingClientRect();
  mouseNDC.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -(((clientY - rect.top) / rect.height) * 2 - 1)
  );
}

// Some embeds block the Gamepad API via permissions policy. Calling it there
// only *sometimes* throws — Chrome more often returns an array of nulls, so a
// try/catch alone reported "no controller connected" and looked identical to
// having no controller plugged in. Ask the policy directly as well.
let gamepadBlocked = false;

const BLOCKED_MESSAGE =
  '[input] the Gamepad API is blocked on this page (permissions policy — normal inside an iframe, ' +
  'including a preview pane). Open the game in its own browser tab for controller support.';

function checkGamepadPolicy() {
  const policy = document.permissionsPolicy ?? document.featurePolicy;
  if (!policy?.allowsFeature) return;
  try {
    if (!policy.allowsFeature('gamepad')) {
      gamepadBlocked = true;
      inputStatus.gamepadBlocked = true;
      console.warn(BLOCKED_MESSAGE);
    }
  } catch {
    // Older engines don't know the 'gamepad' feature name; fall through and
    // let the try/catch around getGamepads be the backstop.
  }
}

// How hard the player is pushing this pad right now, across every axis and
// button. Used only to tell a live controller apart from a dead one.
function padActivity(pad) {
  let peak = 0;
  for (const v of pad.axes) peak = Math.max(peak, Math.abs(v));
  for (const b of pad.buttons) peak = Math.max(peak, b.value ?? (b.pressed ? 1 : 0));
  return peak;
}

// Sticky choice of pad, so releasing the sticks doesn't hand control back to
// some other entry in the list mid-run.
let activePadIndex = -1;
let warnedNonStandard = false;

// The pad chosen this frame. Gamepad objects are per-poll snapshots in Chrome,
// so this is refreshed every updateInput rather than held across frames —
// vibrationActuator, though, is stable enough to drive rumble from. See
// systems/haptics.js.
let activePad = null;

export function getActivePad() {
  return activePad;
}

function getGamepad() {
  if (gamepadBlocked || !navigator.getGamepads) return null;

  let pads;
  try {
    pads = navigator.getGamepads();
  } catch {
    gamepadBlocked = true;
    inputStatus.gamepadBlocked = true;
    console.warn(BLOCKED_MESSAGE);
    return null;
  }

  // Prefer the pad actually being touched. One physical controller can show up
  // as several entries — a wireless receiver, or an 8BitDo exposing both a
  // DInput and an XInput node — and the inert one often sits at the lower
  // index. Taking the first non-null entry therefore read zeros forever while
  // the live pad went ignored one slot over, which is indistinguishable from
  // "gamepad support is broken".
  let firstConnected = null;
  let sticky = null;
  let mostActive = null;
  let peak = stickDeadzone();

  for (const p of pads) {
    if (!p?.connected) continue;
    if (!firstConnected) firstConnected = p;
    if (p.index === activePadIndex) sticky = p;
    const activity = padActivity(p);
    if (activity > peak) {
      peak = activity;
      mostActive = p;
    }
  }

  const pad = mostActive ?? sticky ?? firstConnected;
  activePad = pad;
  if (!pad) {
    // A pad that has never been touched is invisible to the browser by design,
    // so this is the normal state until the first button press.
    inputStatus.padIndex = -1;
    inputStatus.padMapping = '';
    inputStatus.padCount = 0;
    inputStatus.axes = [];
    inputStatus.buttons = [];
    return null;
  }

  // The NAME is refreshed whenever it changes, not only when the slot does:
  // unplugging one pad and plugging in another usually reuses index 0, and a
  // stale name there is a tip telling a PlayStation player to press LB. The
  // log line stays on the slot change, which is the event worth reading about.
  if (pad.index !== activePadIndex || inputStatus.gamepadName !== (pad.id ?? 'gamepad')) {
    inputStatus.gamepadConnected = true;
    inputStatus.gamepadName = pad.id ?? 'gamepad';
    if (pad.index !== activePadIndex) {
      console.info(`[input] reading gamepad ${pad.index}: ${pad.id} (mapping: ${pad.mapping || 'non-standard'})`);
    }
    activePadIndex = pad.index;
  }

  // Button and axis numbers below are the Standard Gamepad layout. A pad
  // reporting anything else may well put fire/strike somewhere unexpected, and
  // silently doing nothing is the worst way to find that out.
  if (!pad.mapping && !warnedNonStandard) {
    warnedNonStandard = true;
    console.warn(
      `[input] "${pad.id}" reports a non-standard mapping, so the sticks and buttons may not line up. ` +
        `It exposes ${pad.axes.length} axes and ${pad.buttons.length} buttons — hold G in game to see which ones move.`
    );
  }

  inputStatus.padIndex = pad.index;
  inputStatus.padMapping = pad.mapping || 'non-standard';
  inputStatus.padCount = Array.from(pads).filter((p) => p?.connected).length;
  inputStatus.axes = Array.from(pad.axes);
  inputStatus.buttons = Array.from(pad.buttons, (b) => b.value ?? (b.pressed ? 1 : 0));

  return pad;
}

// --- menu navigation ------------------------------------------------------
// The level-up screen pauses the game and takes a discrete choice, so it reads
// this rather than `input`. Driven from updateInput so it stays on the same
// single poll of the pad — a second navigator.getGamepads() call would take its
// own snapshot and the two could disagree about what's pressed.

let menuHeldX = 0;
let menuHeldY = 0;
let menuRepeatAt = 0;
let confirmHeld = false;
// Start's own held state, tracked separately from `confirmHeld` even though
// Start is one of the confirm buttons. They have to be able to disagree:
// opening the pause menu re-baselines confirm (so the opening press can't also
// activate a row), and if that same call also cleared this one, the release
// would arm a second pause toggle and the menu would shut again on let-go.
let pauseHeld = false;
const PAUSE_BUTTON = 9; // Start, Standard Gamepad
// B / Circle, and the two bumpers. Standard Gamepad indices, same mapping the
// strike buttons above use — 4 and 5 are the bumpers, the triggers are 6 and 7
// and are left out of the menus on purpose: an analog trigger with a low
// break point steps a tab strip the moment a hand rests on it.
const BACK_BUTTON = 1;
const TAB_PREV_BUTTON = 4;
const TAB_NEXT_BUTTON = 5;
// THE DICE PAIR — see menuInput.nameNext. Both shoulders on a side, so the
// triggers ARE included here even though the tab strip above refuses them: a
// name screen is not a list being stepped past, and rolling one name too many
// costs a press of the other shoulder rather than losing your place.
const NAME_NEXT_BUTTONS = [5, 7]; // RB, RT
const NAME_PREV_BUTTONS = [4, 6]; // LB, LT
// How far an analog trigger has to be pulled before it counts. `pressed` alone
// breaks low enough on some pads that a resting finger rolls a name; a bumper
// reports 1 the moment it is down, so this changes nothing for the digital
// half of each pair.
const NAME_TRIGGER_BREAK = 0.5;
let nameNextHeld = false;
let namePrevHeld = false;
let backHeld = false;
let tabPrevHeld = false;
let tabNextHeld = false;
let anyHeld = false;
let actionHeld = false;

const NAME_BUTTONS = new Set([...NAME_NEXT_BUTTONS, ...NAME_PREV_BUTTONS]);

// Is a shoulder on the given side down far enough to count? See
// NAME_TRIGGER_BREAK for why a trigger is not simply asked whether it is
// `pressed`.
function nameButtonDown(pad, indices) {
  return indices.some((i) => {
    const b = pad?.buttons?.[i];
    if (!b?.pressed) return false;
    // A pad that reports no value at all still gets to press its own button.
    return !Number.isFinite(b.value) || b.value >= NAME_TRIGGER_BREAK;
  });
}

// Is ANY button on the pad down right now? Every button except the four
// shoulders, which are the dice on the only screen that asks this — see
// menuInput.anyPress. Otherwise a list rather than an exclusion, because "press
// anything" is a promise the next controller layout should not be able to
// break.
function anyButtonDown(pad) {
  return !!pad?.buttons?.some((b, i) => b?.pressed && !NAME_BUTTONS.has(i));
}

// ...and the same question with the D-PAD LEFT OUT.
//
// The four dpad indices are buttons like any other to the Gamepad API, so
// "any button" includes pushing a direction — which is right for a press-
// anything-to-start screen and wrong for anything that treats a press as a
// DECISION. Nudging the stick or the dpad to look at a card is not the player
// asking to cut an animation short.
function anyActionButtonDown(pad) {
  return !!pad?.buttons?.some((b, i) => b?.pressed
    && i !== DPAD_UP && i !== DPAD_DOWN && i !== DPAD_LEFT && i !== DPAD_RIGHT);
}

// One axis of the pad reduced to -1 / 0 / +1, from either the D-pad or the
// stick. The D-pad wins: if it's pressed the player means exactly that step.
function menuAxis(pad, negButton, posButton, axisValue) {
  if (pad?.buttons[negButton]?.pressed) return -1;
  if (pad?.buttons[posButton]?.pressed) return 1;
  const v = axisValue ?? 0;
  if (v <= -MENU_DEADZONE) return -1;
  if (v >= MENU_DEADZONE) return 1;
  return 0;
}

function readMenuDirection(pad) {
  return {
    x: menuAxis(pad, DPAD_LEFT, DPAD_RIGHT, pad?.axes[0]),
    y: menuAxis(pad, DPAD_UP, DPAD_DOWN, pad?.axes[1]),
  };
}

function updateMenuInput(pad) {
  const { x, y } = readMenuDirection(pad);
  const now = performance.now() / 1000;

  menuInput.x = 0;
  menuInput.y = 0;
  if (x !== menuHeldX || y !== menuHeldY) {
    // A new direction steps immediately — waiting on the repeat clock here
    // would put a delay on every single press.
    menuHeldX = x;
    menuHeldY = y;
    menuRepeatAt = now + MENU_REPEAT_DELAY;
    menuInput.x = x;
    menuInput.y = y;
  } else if ((x || y) && now >= menuRepeatAt) {
    menuRepeatAt = now + MENU_REPEAT_RATE;
    menuInput.x = x;
    menuInput.y = y;
  }

  const down = CONFIRM_BUTTONS.some((b) => !!pad?.buttons[b]?.pressed);
  menuInput.confirm = down && !confirmHeld;
  confirmHeld = down;

  const pauseDown = !!pad?.buttons[PAUSE_BUTTON]?.pressed;
  menuInput.pause = pauseDown && !pauseHeld;
  pauseHeld = pauseDown;

  // All edge-triggered the same way as confirm, and all baselined by
  // resetMenuInput — a bumper held as a menu opens must not step its tabs on
  // the first frame, exactly as a held A must not confirm.
  const backDown = !!pad?.buttons[BACK_BUTTON]?.pressed;
  menuInput.back = backDown && !backHeld;
  backHeld = backDown;

  const prevDown = !!pad?.buttons[TAB_PREV_BUTTON]?.pressed;
  menuInput.tabPrev = prevDown && !tabPrevHeld;
  tabPrevHeld = prevDown;

  const nextDown = !!pad?.buttons[TAB_NEXT_BUTTON]?.pressed;
  menuInput.tabNext = nextDown && !tabNextHeld;
  tabNextHeld = nextDown;

  // THE DICE. One edge per SIDE rather than per button, so a player squeezing
  // RT while RB is already down rolls one name, not two.
  const nameNextDown = nameButtonDown(pad, NAME_NEXT_BUTTONS);
  menuInput.nameNext = nameNextDown && !nameNextHeld;
  nameNextHeld = nameNextDown;

  const namePrevDown = nameButtonDown(pad, NAME_PREV_BUTTONS);
  menuInput.namePrev = namePrevDown && !namePrevHeld;
  namePrevHeld = namePrevDown;

  // True on the frame the pad goes from nothing-down to something-down. A
  // second button pressed while the first is still held is NOT a fresh edge
  // here — which is fine for the one thing this drives: a "press anything"
  // screen is already gone by the time a second button lands on it.
  const anyDown = anyButtonDown(pad);
  menuInput.anyPress = anyDown && !anyHeld;
  anyHeld = anyDown;

  // The same edge, buttons only. `anyPress` drives "press anything to start",
  // where a dpad nudge counting is fine; this drives things that read a press
  // as a decision, where it is not.
  const actionDown = anyActionButtonDown(pad);
  menuInput.actionPress = actionDown && !actionHeld;
  actionHeld = actionDown;
}

// Call when a menu opens. A is also the fire button, so the player is usually
// holding it as the level-up screen appears — without re-baselining, that held
// button reads as a fresh press and picks a card before they've seen one. Two
// levels at once made it worse: the A that confirmed the first card would sail
// straight through the second menu. As in clearPendingInput, this adopts what's
// physically down right now rather than zeroing, so a release is required
// before anything counts as a press.
export function resetMenuInput() {
  const pad = getGamepad();
  confirmHeld = CONFIRM_BUTTONS.some((b) => !!pad?.buttons[b]?.pressed);
  const { x, y } = readMenuDirection(pad);
  menuHeldX = x;
  menuHeldY = y;
  menuRepeatAt = performance.now() / 1000 + MENU_REPEAT_DELAY;
  menuInput.x = 0;
  menuInput.y = 0;
  menuInput.confirm = false;
  // Same adopt-don't-zero rule for the rest of the menu buttons. A bumper or a
  // B held as the screen changes has to be released before it counts — the
  // level-up menu opens under a hand that may be holding any of them.
  backHeld = !!pad?.buttons[BACK_BUTTON]?.pressed;
  tabPrevHeld = !!pad?.buttons[TAB_PREV_BUTTON]?.pressed;
  tabNextHeld = !!pad?.buttons[TAB_NEXT_BUTTON]?.pressed;
  // The dice too — a shoulder held as the score card arrives must be let go of
  // before it rolls, or the boost the player was holding when they died names
  // their next seal.
  nameNextHeld = nameButtonDown(pad, NAME_NEXT_BUTTONS);
  namePrevHeld = nameButtonDown(pad, NAME_PREV_BUTTONS);
  anyHeld = anyButtonDown(pad);
  actionHeld = anyActionButtonDown(pad);
  menuInput.back = false;
  menuInput.tabPrev = false;
  menuInput.tabNext = false;
  menuInput.nameNext = false;
  menuInput.namePrev = false;
  menuInput.anyPress = false;
  menuInput.actionPress = false;
  // NOT re-baselined here. This is called on the frame the pause menu opens,
  // and Start is what opened it — adopting "Start is down" as the baseline
  // would be right, but the edge has ALREADY been consumed by the toggle this
  // frame and `pauseHeld` is already true from that same poll. Touching it
  // here would only be able to break the pairing, never fix it.
}

// Rescale a stick axis so it ramps from 0 at the deadzone edge to 1 at full
// deflection, instead of snapping to the deadzone value.
function applyDeadzone(v) {
  const a = Math.abs(v);
  const dz = stickDeadzone();
  if (a <= dz) return 0;
  return Math.sign(v) * ((a - dz) / (1 - dz));
}

const worldPoint = new THREE.Vector3();

// Called once per frame. Aim resolves in WORLD space against the ship's actual
// position, so it stays correct wherever the ship sits on screen.
export function updateInput(camera, playerPos) {
  const pad = getGamepad();

  // A pad claims the prompts by being PUSHED, not by being plugged in. The
  // deadzone is what makes that safe: a controller sitting on the desk with a
  // drifting stick would otherwise re-take the words from the keyboard on every
  // frame, forever, and no amount of typing would win them back.
  if (pad && padActivity(pad) > stickDeadzone()) markDevice('pad');
  inputStatus.device = inputDevice();

  // Menus run while the game is paused, so this is updated from the same poll
  // rather than gated on gameState — whoever has a menu open reads it.
  updateMenuInput(pad);

  // --- movement ---
  input.move.set(0, 0);
  if (keys.right) input.move.x += 1;
  if (keys.left) input.move.x -= 1;
  if (keys.up) input.move.y += 1;
  if (keys.down) input.move.y -= 1;

  if (pad) {
    // Rescale from the deadzone edge rather than passing the raw value: the
    // old version jumped straight to 0.15 of thrust the moment the stick
    // crossed the threshold, so fine control near centre was impossible.
    const lx = applyDeadzone(pad.axes[0] ?? 0);
    const ly = applyDeadzone(pad.axes[1] ?? 0);
    if (lx || ly) {
      input.move.x += lx;
      input.move.y -= ly;
    }
  }

  // The touch stick is analog like the pad's, so it contributes its magnitude
  // rather than a unit vector — a half-pushed thumb is half thrust.
  const moveMag = readStick(sticks.move, moveVec);
  if (moveMag) {
    input.move.x += moveVec.x * moveMag;
    input.move.y += moveVec.y * moveMag;
  }

  if (input.move.lengthSq() > 1) input.move.normalize();

  // --- aim (priority: right stick > aim thumb > mouse) ---
  let aimed = false;
  // Reset per frame, unlike `aim` itself: this is the gesture, not the heading.
  input.aiming = false;

  if (pad) {
    const rx = pad.axes[2] ?? 0;
    const ry = pad.axes[3] ?? 0;
    if (Math.hypot(rx, ry) > stickDeadzone()) {
      input.aim.set(rx, -ry).normalize();
      aimed = true;
      input.aiming = true;
      lastAimDevice = 'gamepad';
    }
  }

  // The aim thumb, pointing AT what it is touching. No deadzone and no
  // threshold to cross: a thumb resting on the glass is already naming a point,
  // and there is no centred state for it to sit in. See readAimTouchNDC.
  if (!aimed && readAimTouchNDC(aimNDC)) {
    worldPoint.set(aimNDC.x, aimNDC.y, 0).unproject(camera);
    const dx = worldPoint.x - playerPos.x;
    const dy = worldPoint.y - playerPos.y;
    // A thumb directly on the seal has no direction in it. Keep the last
    // heading rather than snapping to whichever way the rounding fell.
    if (Math.hypot(dx, dy) > 0.001) {
      input.aim.set(dx, dy).normalize();
      aimed = true;
      input.aiming = true;
      lastAimDevice = 'touch';
    }
  }

  // One thumb down and it's the movement one: face where we're swimming. The
  // aim direction would otherwise stay frozen at wherever the aim thumb last
  // pointed, which leaves the seal swimming backwards.
  if (!aimed && moveMag && CONFIG.touch.aimFollowsMove && lastAimDevice === 'touch') {
    input.aim.copy(moveVec);
    aimed = true;
  }

  if (!aimed && hasMouse && lastAimDevice === 'mouse') {
    worldPoint.set(mouseNDC.x, mouseNDC.y, 0).unproject(camera);
    const dx = worldPoint.x - playerPos.x;
    const dy = worldPoint.y - playerPos.y;
    if (Math.hypot(dx, dy) > 0.001) input.aim.set(dx, dy).normalize();
  }

  // --- firing ---
  // Nothing to read: the guns are on a timer of their own (CONFIG.weapon
  // .autofire). Gamepad A used to fire and is now left alone on purpose rather
  // than reassigned to the strike — it is also the menu confirm, so the press
  // that picks a level-up card would start a charge on the way out.

  // --- strike (edge-triggered: true for exactly one frame per press) ---
  // All four shoulder inputs — LB, RB, LT, RT — boost, so either index finger
  // can do it without thinking about which. Edge-triggered per button rather
  // than per group: holding LT and then tapping RT should give you a second
  // boost, which a single OR'd "any of them is down" flag would swallow.
  let anyStrikeDown = spaceHeld || mouseStrikeHeld;
  for (const b of STRIKE_BUTTONS) {
    const down = !!pad?.buttons[b]?.pressed;
    if (down && !strikeButtonHeld[b]) strikeRequested = true;
    strikeButtonHeld[b] = down;
    if (down) anyStrikeDown = true;
  }

  // Touch joins the same OR as the four shoulder buttons rather than getting a
  // path of its own: a third finger and a double-tap-hold are two more ways to
  // lean on one meter, exactly as LT and RT are.
  const touchStrike = touchStrikeDown();
  if (touchStrike && !touchStrikePrev) strikeRequested = true;
  touchStrikePrev = touchStrike;
  if (touchStrike) anyStrikeDown = true;
  // Right here, off the same read: the grid grows the finger that is charging,
  // and it should be looking at the state this frame's strike meter used.
  markChargingSlots();

  input.strike = strikeRequested;
  strikeRequested = false;

  // Held/release are OR'd across every strike input rather than tracked per
  // button like the press edge above. A charge is one meter, not one per
  // finger: holding LT and tapping RT should not launch a half-charged dash
  // while LT is still winding one up. The meter empties when the LAST strike
  // input comes up, so the two triggers behave as one button for charging.
  input.strikeHeld = anyStrikeDown;
  input.strikeRelease = strikeHeldPrev && !anyStrikeDown && !suppressStrikeRelease;

  // --- clap (edge-triggered, like the strike press above) ---
  // Held state is tracked for the pad only because that is the one device with
  // no events: the keyboard raises its own edge in setKey. Nothing downstream
  // reads a held clap — see the note on `input.clap`.
  const clapDown = !!pad?.buttons[CLAP_BUTTON]?.pressed;
  if (clapDown && !clapButtonHeld) clapRequested = true;
  clapButtonHeld = clapDown;
  input.clap = clapRequested;
  clapRequested = false;
  // Clear the suppression on the same frame the release it was guarding would
  // have fired. Leaving it set until the next cancel would let it eat a real
  // let-go later — one where the player did mean to launch.
  if (!anyStrikeDown) suppressStrikeRelease = false;
  strikeHeldPrev = anyStrikeDown;
}
