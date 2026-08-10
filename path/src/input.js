import * as THREE from 'three';
import { CONFIG } from './config.js';

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
};

// Menu navigation, kept separate from `input` on purpose: gameplay wants a
// continuous analog stream, a menu wants discrete steps. x/y are true for
// exactly one frame per step (with auto-repeat while held), in SCREEN space —
// y is +1 for down, matching both the D-pad and axis 1.
export const menuInput = {
  x: 0,
  y: 0,
  confirm: false,
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

// --- touch: two floating virtual sticks ------------------------------------
// Fingers are tracked by `identifier`, never by position in the touches list.
// `touches[0]` is only "the first finger" by accident — it's whichever one the
// browser lists first, so lifting the left thumb promotes the right one to
// steering mid-run.
//
// A finger claims a stick by WHERE IT LANDS, not by arrival order. Order sounds
// right ("first touch moves, second aims") right up until the player lifts and
// re-plants their left thumb while still aiming: the re-plant is then the only
// touch looking for a slot and it takes the one that's free, which is aim. The
// ship stops steering and starts pointing instead.
//
// Both sticks FLOAT — the anchor is wherever the thumb went down. Nothing to
// hit, nothing to look at, and no spring-back to fight.
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

const DEADZONE = 0.15;
// A menu step should take a deliberate push, so it asks for more of the stick
// than steering does — otherwise the drift that's harmless in gameplay walks
// the selection across the cards on its own.
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
};

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

  canvas.addEventListener('mousemove', (e) => {
    lastAimDevice = 'mouse';
    hasMouse = true;
    updateMouseNDC(e.clientX, e.clientY);
  });
  canvas.addEventListener('mousedown', (e) => {
    hasMouse = true;
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

  canvas.addEventListener(
    'touchstart',
    (e) => {
      e.preventDefault();
      // Claim the aim channel up front. Otherwise the mouse fallback below —
      // which a touch device can still latch via a synthesised event — keeps
      // overwriting touch aim the moment the aim thumb comes off.
      lastAimDevice = 'touch';
      forEachTouch(e.changedTouches, beginTouch);
    },
    { passive: false }
  );
  canvas.addEventListener(
    'touchmove',
    (e) => {
      e.preventDefault();
      forEachTouch(e.changedTouches, (t) => {
        const stick = stickById(t.identifier);
        if (stick) stick.current.set(t.clientX, t.clientY);
      });
    },
    { passive: false }
  );
  // touchcancel is not optional. iOS drops touches without a matching touchend
  // for an incoming call, a Control Center swipe or palm rejection, and a stick
  // left in the registry then steers at full deflection forever.
  const lift = (cancelled) => (e) => {
    e.preventDefault();
    forEachTouch(e.changedTouches, (t) => endTouch(t, cancelled));
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
}

/** Is a touch winding up a strike right now — either route. */
function touchStrikeDown() {
  return strikeTouchId !== null || !!sticks.move?.charging || !!sticks.aim?.charging;
}

// A stick's deflection: direction into `out`, magnitude returned as 0..1 ramped
// from the deadzone edge, matching how applyDeadzone treats a physical stick.
// Returns 0 for centred, and leaves `out` untouched in that case.
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

const moveVec = new THREE.Vector2();
const aimVec = new THREE.Vector2();

// Drops any half-finished input so a run never inherits it. The keypress that
// dismisses the splash also lands on setKey below, and Space is boost — without
// this, skipping the title card with the spacebar spent a charge on the first
// frame of the run. Same story for a key still held when a run restarts.
export function clearPendingInput() {
  strikeRequested = false;
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
}

function setKey(e, down) {
  const k = e.key.toLowerCase();
  if (k === 'w' || k === 'arrowup') keys.up = down;
  if (k === 's' || k === 'arrowdown') keys.down = down;
  if (k === 'a' || k === 'arrowleft') keys.left = down;
  if (k === 'd' || k === 'arrowright') keys.right = down;
  // Space charges a strike. The keydown edge (guarded against auto-repeat)
  // starts the meter; `spaceHeld` is what keeps it filling, and the keyup is
  // what launches. Held state has to be tracked separately from the edge —
  // key auto-repeat fires keydown over and over, so counting those as "still
  // held" would work, but a key released while the window was unfocused would
  // never arrive and the meter would fill forever.
  if (k === ' ') {
    if (down && !e.repeat) strikeRequested = true;
    spaceHeld = down;
  }
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
  let peak = DEADZONE;

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

  if (pad.index !== activePadIndex) {
    activePadIndex = pad.index;
    inputStatus.gamepadConnected = true;
    inputStatus.gamepadName = pad.id ?? 'gamepad';
    console.info(`[input] reading gamepad ${pad.index}: ${pad.id} (mapping: ${pad.mapping || 'non-standard'})`);
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
}

// Rescale a stick axis so it ramps from 0 at the deadzone edge to 1 at full
// deflection, instead of snapping to the deadzone value.
function applyDeadzone(v) {
  const a = Math.abs(v);
  if (a <= DEADZONE) return 0;
  return Math.sign(v) * ((a - DEADZONE) / (1 - DEADZONE));
}

const worldPoint = new THREE.Vector3();

// Called once per frame. Aim resolves in WORLD space against the ship's actual
// position, so it stays correct wherever the ship sits on screen.
export function updateInput(camera, playerPos) {
  const pad = getGamepad();

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

  // --- aim (priority: right stick > touch drag > mouse) ---
  let aimed = false;

  if (pad) {
    const rx = pad.axes[2] ?? 0;
    const ry = pad.axes[3] ?? 0;
    if (Math.hypot(rx, ry) > DEADZONE) {
      input.aim.set(rx, -ry).normalize();
      aimed = true;
      lastAimDevice = 'gamepad';
    }
  }

  // Aim stick. Direction only — the guns run themselves now, so there's no
  // threshold to cross and any deflection at all just re-points the seal.
  const aimMag = readStick(sticks.aim, aimVec);
  if (!aimed && aimMag) {
    input.aim.copy(aimVec);
    aimed = true;
    lastAimDevice = 'touch';
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

  input.strike = strikeRequested;
  strikeRequested = false;

  // Held/release are OR'd across every strike input rather than tracked per
  // button like the press edge above. A charge is one meter, not one per
  // finger: holding LT and tapping RT should not launch a half-charged dash
  // while LT is still winding one up. The meter empties when the LAST strike
  // input comes up, so the two triggers behave as one button for charging.
  input.strikeHeld = anyStrikeDown;
  input.strikeRelease = strikeHeldPrev && !anyStrikeDown && !suppressStrikeRelease;
  // Clear the suppression on the same frame the release it was guarding would
  // have fired. Leaving it set until the next cancel would let it eat a real
  // let-go later — one where the player did mean to launch.
  if (!anyStrikeDown) suppressStrikeRelease = false;
  strikeHeldPrev = anyStrikeDown;
}
