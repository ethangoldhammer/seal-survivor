import * as THREE from 'three';
import { CONFIG } from './config.js';
import { actionForKey, stickDeadzone } from './systems/settings.js';
import { defaultDevice, shoulderLabel, faceLeftLabel } from './devices.js';
import { versusActive, captainPad } from './systems/versusFlag.js';

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
  // Is the aim vector being WRITTEN this frame by a device that is actually
  // pointing — as opposed to `aim`, which is a heading that is never off and
  // holds the last direction anything gave it forever.
  //
  // The difference matters exactly once, and it is the reason this exists:
  // the dash's mid-flight steering (dashSteer, via updatePlayer) reads both
  // hands, and gating it on `aim` would mean a gamepad with an idle right
  // stick dragging the seal toward whatever heading that stick last held.
  // Gating it on `aiming` instead would lock the mouse out, because a mouse
  // aims by existing and has no gesture to catch — which is precisely the
  // player who was left with no mid-dash steering at all.
  //
  // TRUE FOR A MOUSE EVERY FRAME, on purpose. The heading is recomputed from
  // the cursor's position relative to the SEAL, so it keeps changing as the
  // animal flies past a pointer that never moved. Which is why the dash does
  // NOT read this any more — see `aimMoved` below.
  aimLive: false,
  // Did the aim device GESTURE this frame — the mouse flicked, the aim thumb
  // slid, the right stick is pushed. Not "is the aim being written" (that is
  // `aimLive`, true for a mouse every frame) and not "is a thumb resting on
  // the aim half" (`aiming`): the question is whether the hand DID something.
  //
  // The dash's steering reads this and nothing else about the aim (holdAim in
  // systems/strike.js). A pointer aims at a point, and its heading flips
  // through 180 degrees on its own as the seal flies past the cursor; a dash
  // that steered by the live heading turned round with no hand on anything.
  aimMoved: false,
  // ...AND WHICH WAY THE GESTURE WENT. A unit vector on a frame `aimMoved` is
  // true, zero otherwise. For a pointer this is the direction the mouse or
  // the thumb MOVED — a flick up is up — summed over the last
  // CONFIG.touch.aimFlick.window seconds and only once it has covered
  // aimFlick.px of screen, so a resting hand's tremor is nothing and a flick
  // reads as one direction rather than five jittery ones. Not where the
  // cursor IS: that heading depends on where the seal is, and mid-dash the
  // seal is moving fast. A stick is already a direction and comes through
  // as itself. The one thing that reads this is holdAim in systems/strike.js.
  aimGesture: new THREE.Vector2(0, 0),
  // ...AND WHETHER IT WENT ROUND. +1 for a counter-clockwise loop, -1 for a
  // clockwise one, 0 for neither — edge-triggered, true for exactly one frame
  // per circle, because what reads it starts a move (systems/sealFlip.js) and
  // a level would start one every frame the hand kept turning.
  //
  // Read off the SAME samples `aimGesture` is (readCircle), so the circle
  // costs no new binding and no new deadzone: the hand that steers a dash is
  // the hand that flips the seal, and which it did is a question about the
  // shape of the motion rather than about which control it was made on.
  circleFlick: 0,
  // How far round the hand is at the moment, in signed radians — a level, not
  // an edge, and purely a readout. The coach and the lab draw it; nothing in
  // the game is gated on it.
  circleTurn: 0,
  // THE FOLLOW-THROUGH, 0..1 — how far past the half circle that started a
  // flip the hand has carried on. A level, read every frame while the move is
  // still gathering, and what makes the back half of the gesture worth
  // drawing: it sets how sharp the somersault is and how hard the tail lands.
  // See readCircleCommit, and noteFlipCommit in systems/sealFlip.js.
  circleCommit: 0,
  // ...AND THE HALF BEFORE THAT, 0..1 — how far into the first semicircle the
  // hand is. The WIND-UP, and it is the player's rather than the game's: the
  // seal coils under the hand as the circle is drawn, so by the time the move
  // engages at the halfway point the body is already loaded. See
  // readCircleLoad and noteFlipGather in systems/sealFlip.js.
  circleLoad: 0,
  // Which way that wind-up is going, +1/-1, or 0 for a hand that is not
  // drawing one. The coil leans into it before the flip has a direction.
  circleDir: 0,
  // The clap button — edge-triggered, true for exactly one frame per press.
  // Edge and nothing else: there is no held state to keep, because the gesture
  // it starts re-enters itself rather than being sustained (see
  // systems/clap.js). A key held down does not clap continuously, which is
  // deliberate — auto-repeat is not a rhythm.
  //
  // On a phone there is no button to press, so the ANIMAL is the button: a
  // touch that lands on the seal raises this on the frame it lands. See
  // setSealTapTarget and the note in beginTouch.
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
  // Y / Triangle, edge-triggered. THROW THE HAND BACK on the level-up screen —
  // see CONFIG.upgradeReroll. Index 3, which the note beside CLAP_BUTTON below
  // has been holding open for exactly this: 0 confirms, 1 goes back, 2 claps in
  // gameplay, and 3 was the face button left unspent.
  //
  // A button of its own rather than a nav stop the stick can reach. The hand is
  // laid out as a lattice and stepSelection walks it geometrically, so a
  // fourth thing below the cards would be "down" from two of them and from
  // neither, depending on how the row wrapped — and on a phone, where the cards
  // stack into a column, it would sit in the path of every downward step.
  reroll: false,
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
// in updateInput), 1 is the universal back, and 3 has since gone to the
// level-up screen's reroll (see menuInput.reroll) — in the MENUS only, so it is
// still free in gameplay if something ever needs it there.
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

// --- THE SEAL IS A BUTTON --------------------------------------------------
// Where the animal is on screen, in the same CSS pixels a touch arrives in:
// { x, y, r }, or null for "not right now". Published every frame by main.js
// (setSealTapTarget) because only the run knows where the camera put the seal
// and whether it is a thing to be touched at all — the main menu draws the
// same animal and a press there already cycles what it is wearing.
//
// WHY A CIRCLE AND NOT A RAYCAST, which is the same answer mainMenu.js gives
// for the bust: the body is a SkinnedMesh held in a pose its bind box does not
// cover, so a ray can be rejected before a triangle is tested and the seal
// ignores every other tap. A circle over the animal cannot fail that way.
//
// One frame stale at worst — the target is written before updateInput and read
// by a touch that arrives after it, which at 60fps is a seal that has moved a
// few pixels inside a target tens of pixels across.
let sealTap = null;

/**
 * WHERE THE SEAL IS, FOR A THUMB. `{ x, y, r }` in CSS px, or null while there
 * is nothing to tap. See CONFIG.touch.clap.
 */
export function setSealTapTarget(target) {
  sealTap = target ?? null;
}

/** Did this contact land on the animal? False whenever there is no target. */
function onSeal(clientX, clientY) {
  if (!sealTap || CONFIG.touch.clap?.enabled === false) return false;
  return Math.hypot(clientX - sealTap.x, clientY - sealTap.y) <= sealTap.r;
}

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
  return {
    bumper: shoulderLabel(inputStatus.gamepadName),
    // The clap's button — CLAP_BUTTON is standard-gamepad index 2, the left of
    // the four face buttons, so this and the binding cannot drift apart without
    // somebody moving the clap.
    faceLeft: faceLeftLabel(inputStatus.gamepadName),
  };
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
  // See the note where this is written, in getGamepad.
  pageFocused: true,
  // Whether navigator.getGamepads exists at all — see noGamepadApi.
  gamepadApi: true,
  // How many slots the browser returned, nulls included. See getGamepad.
  padSlots: 0,
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

// --- THE FLICK — a pointer's gesture, read as a direction ---------------------
//
// The mouse and the aim thumb aim at a POINT, and a point is the wrong thing
// to steer a dash by: its heading is cursor-minus-seal, which changes on its
// own as the seal moves and flips outright as the seal flies past it. So for
// steering, a pointer is read the way a stick is — by which way it MOVED.
//
// Screen-pixel deltas (y up) from every mousemove / aim-thumb touchmove land
// here with a timestamp. Each frame, readFlick() sums the ones inside
// CONFIG.touch.aimFlick.window and, once the sum has covered aimFlick.px, the
// sum's direction is the gesture. Summed over a window rather than read per
// event because a flick is five or six events long and its first and last
// are jittery; thresholded because a hand resting on a mouse drifts.
//
// One list for both devices: only one of them is the aim at a time (the
// priority chain in updateInput), and a delta from the other is a stray.
// ...AND THE CIRCLE READS THE SAME LIST. readCircle() below sums the SIGNED
// TURN between consecutive deltas instead of their vector sum, which is the
// whole difference between "the hand went that way" and "the hand went round".
// One list, two questions, no second binding — see CONFIG.touch.circleFlick.
//
// THE CAP AND THE PRUNE BOTH BELONG TO THE LONGER WINDOW. They were sized for
// the flick's 0.08s (64 samples, and anything older dropped on read), and a
// circle is seven times that: pruning on the short window threw away five
// sixths of every loop before it could be measured, and the cap would have
// clipped the rest on a mouse reporting at 125Hz.
const flick = []; // { dx, dy, t } — CSS px, y up, ms
const FLICK_CAP = 256;
let mousePxX = NaN, mousePxY = NaN;
function feedFlick(dx, dy) {
  if (!(dx || dy)) return;
  if (flick.length >= FLICK_CAP) flick.shift();
  flick.push({ dx, dy, t: performance.now() });
}
function feedMouseFlick(clientX, clientY) {
  if (Number.isFinite(mousePxX)) feedFlick(clientX - mousePxX, -(clientY - mousePxY));
  mousePxX = clientX; mousePxY = clientY;
}
/** How far back either reader may look, in ms. See the note on FLICK_CAP. */
function flickHistoryMs() {
  const f = CONFIG.touch?.aimFlick ?? {};
  const c = CONFIG.touch?.circleFlick ?? {};
  return Math.max((f.window ?? 0.08), (c.enabled === false ? 0 : (c.window ?? 0.55))) * 1000;
}

/** The gesture inside the window, as a unit vector in `out`. False (and zero) if there is none. */
function readFlick(out) {
  const f = CONFIG.touch?.aimFlick ?? {};
  const now = performance.now();
  // Pruned on the LONGER of the two windows, then summed over this reader's
  // own — the circle needs the history this used to throw away.
  const keep = now - flickHistoryMs();
  while (flick.length && flick[0].t < keep) flick.shift();
  const cutoff = now - (f.window ?? 0.08) * 1000;
  let sx = 0, sy = 0;
  for (const d of flick) { if (d.t >= cutoff) { sx += d.dx; sy += d.dy; } }
  const len = Math.hypot(sx, sy);
  if (len < (f.px ?? 24)) { out.set(0, 0); return false; }
  out.set(sx / len, sy / len);
  return true;
}

// --- the circle ------------------------------------------------------------
//
// A QUICK LOOP DRAWN WITH THE AIM HAND, answered with a somersault
// (systems/sealFlip.js). It is the flick's own samples read as a signed turn:
// walk the deltas in order, take the angle between each pair, and add them up
// keeping the sign. A straight swipe sums to nothing however long it is; a
// loop sums to a turn.
//
// FOUR GATES, AND EACH ONE IS A FALSE POSITIVE THIS COST BEFORE IT EXISTED:
//
//   turn      three quarters of a revolution. Nobody closes a loop with a
//             mouse, and the last quarter is the part the player has already
//             moved on from.
//   px        how far the hand actually went. A two-pixel tremor turns through
//             a full circle without going anywhere, and every one of those was
//             a flip nobody asked for.
//   minStep   sub-pixel deltas are dropped before any angle is measured, for
//             the same reason: the direction of a half-pixel move is noise,
//             and noise summed is a turn.
//   backlash  a reversal drops the sum. A hand that goes one way and then the
//             other is scrubbing, not circling — without this a shake
//             accumulated both ways and fired whichever way it finished.
//
// THE STICK CIRCLES TOO, by rolling the right stick round its gate rather than
// by any of the above: a pad has no pointer and no pixels, so it feeds the
// same accumulator with the heading it is holding and skips the `px` gate. The
// gate itself is the tremor filter there — a stick at rest is inside the
// deadzone and never reaches this.
const circle = {
  turn: 0,      // signed radians accumulated
  path: 0,      // CSS px travelled while accumulating
  last: NaN,    // the previous sample's direction, radians
  at: 0,        // ms of the oldest sample still counted
  stick: false, // fed by a pushed stick, which has no pixels to measure
  // HAS THIS LOOP ALREADY STARTED A FLIP. The gesture does not end when it
  // fires — see the note on the half-circle below — so the accumulator keeps
  // running and this is what stops it firing a second one.
  engaged: 0,   // 0, or the direction it fired in
  // The newest sample already folded in, as a timestamp. A sample counted
  // twice is a circle counted twice, and the window is several frames long.
  seen: 0,
  // When another circle may be read, as a timestamp rather than a countdown:
  // this is polled from a frame loop with no dt in its signature, and every
  // other clock in this file is wall time already.
  until: 0,
};

function resetCircle() {
  circle.turn = 0;
  circle.path = 0;
  circle.last = NaN;
  circle.at = 0;
  circle.stick = false;
  circle.engaged = 0;
}

/**
 * One sample into the accumulator. `ang` is the direction this sample went in
 * (radians), `step` how far the hand moved to make it (CSS px; 0 from a stick,
 * which has no pixels).
 */
function feedCircle(ang, step, now, fromStick = false) {
  const c = CONFIG.touch?.circleFlick ?? {};
  // The loop has to be QUICK. A hand slowly orbiting a cursor for five seconds
  // adds up to a circle and is not one, so the window is measured from the
  // oldest sample still counted and the sum starts again when it lapses.
  if (!Number.isNaN(circle.last) && now - circle.at > (c.window ?? 0.55) * 1000) resetCircle();
  if (Number.isNaN(circle.last)) { circle.at = now; circle.last = ang; return; }
  let d = ang - circle.last;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  circle.last = ang;
  // A REVERSAL DROPS IT — but only a real one. Every hand wobbles a few tenths
  // of a radian inside a loop it is drawing, and a zero-tolerance version
  // reset the sum halfway round every single circle.
  if (circle.turn !== 0 && Math.sign(d) !== Math.sign(circle.turn) && Math.abs(d) > (c.backlash ?? 1.1)) {
    resetCircle();
    circle.at = now;
    circle.last = ang;
    return;
  }
  circle.turn += d;
  circle.path += step;
  circle.stick = circle.stick || fromStick;
}

/**
 * A SAMPLE OF AIM MOTION, from outside. The same list the mouse and the aim
 * thumb feed (feedFlick), exported so tools/seal-flip-test.mjs can draw a
 * circle with no glass and no cursor — the detector is the thing under test
 * there, and a harness that reimplemented the accumulation would be testing
 * its own copy of it.
 *
 * `dx`/`dy` are CSS pixels with y UP, which is the convention the list is in.
 */
export function feedAimMotion(dx, dy) {
  feedFlick(dx, dy);
}

/**
 * HAS A CIRCLE JUST BEEN DRAWN. Returns +1 counter-clockwise, -1 clockwise, 0
 * for neither — an EDGE, true for exactly one frame, because the thing reading
 * it starts a move and a level would start one every frame the hand kept
 * going.
 *
 * `padAim` is the right stick this frame ({ x, y }) or null. A pushed stick
 * feeds its heading; anything else reads the pointer deltas.
 */
export function readCircle(padAim = null) {
  const c = CONFIG.touch?.circleFlick ?? {};
  if (c.enabled === false) return 0;
  const now = performance.now();

  if (padAim) {
    feedCircle(Math.atan2(padAim.y, padAim.x), 0, now, true);
  } else {
    // PRUNED HERE TOO, not only in readFlick. That reader is skipped entirely
    // while a pad is aiming, so on a controller the list would otherwise fill
    // to its cap with samples from the last time anybody touched the mouse and
    // sit there — which is not wrong (every sample carries its own timestamp
    // and the window below throws them out as it walks) but it is 256 stale
    // entries walked every frame, forever.
    const keep = now - flickHistoryMs();
    while (flick.length && flick[0].t < keep) flick.shift();
    // Every delta since the last read, in order. `seen` is where we got to, so
    // a sample is never counted twice — summing the whole window every frame
    // would multiply one loop by however many frames it stayed in the window.
    const min = c.minStep ?? 1.2;
    for (const d of flick) {
      if (d.t <= circle.seen) continue;
      circle.seen = d.t;
      const len = Math.hypot(d.dx, d.dy);
      if (len < min) continue;
      feedCircle(Math.atan2(d.dy, d.dx), len, d.t);
    }
  }

  // ---------------------------------------------------------------------
  // IT FIRES AT THE HALF CIRCLE, AND THE REST OF THE LOOP IS THE FOLLOW
  // THROUGH.
  // ---------------------------------------------------------------------
  // Waiting for three quarters of a turn is a gesture that arrives late — the
  // player's hand is already round the far side by the time the seal reacts,
  // and every flip felt like it had been buffered. A half turn is the earliest
  // point at which a loop cannot be anything else (an arc into a direction
  // change is under half, which is what `backlash` and the `px` gate already
  // catch), so that is where the move starts.
  //
  // WHAT THE REST OF THE CIRCLE BUYS. The accumulator does NOT stop here: it
  // keeps summing, and `circleCommit` below reports how far past the engage
  // the hand has got, 0 at the half turn and 1 at the full one. The flip reads
  // it while it is still gathering and spends it on how SHARP the somersault
  // is and how hard the tail lands (systems/sealFlip.js). A player who flicks
  // half a loop and stops gets a lazy flip; one who whips the whole circle
  // round gets the fast one.
  //
  // So the gesture has an engage and a follow-through, like a golf swing, and
  // the move is legible in both halves: it STARTS when you commit and it is
  // SHAPED by what you do after committing.
  // A LOOP THAT HAS ALREADY FIRED IS SPENT once its throttle has run out. The
  // accumulator deliberately keeps running after the engage (that is what the
  // follow-through is), so something has to declare the gesture over — and the
  // throttle is exactly that window: the flip has long since locked in what it
  // read, and a hand still circling after it is starting the NEXT flip, not
  // continuing this one.
  //
  // Without this the engage latched forever: one circle, and no further flip
  // until the hand stopped moving for the whole window.
  if (circle.engaged && now >= circle.until) resetCircle();

  if (now >= circle.until && !circle.engaged) {
    const engage = c.engageTurn ?? Math.PI;
    const enough = Math.abs(circle.turn) >= engage;
    const far = circle.stick || circle.path >= (c.px ?? 150);
    if (enough && far) {
      circle.engaged = circle.turn > 0 ? 1 : -1;
      // The throttle is armed HERE, on the engage, so a hand that keeps
      // circling cannot start a second flip inside the first one's
      // follow-through.
      circle.until = now + (c.cooldown ?? 0.35) * 1000;
      return circle.engaged;
    }
  }
  return 0;
}

/**
 * HOW FAR PAST THE ENGAGE THE HAND HAS GOT, 0..1 — the follow-through.
 *
 * 0 at the half circle that started the flip, 1 once the loop is complete.
 * Live: it climbs while the hand keeps going, and the move reads it while it
 * is still gathering (noteFlipCommit in systems/sealFlip.js). Zero when
 * nothing is engaged, which is the honest answer rather than a stale one.
 *
 * A REVERSAL OR A PAUSE DROPS IT TO WHATEVER WAS ALREADY EARNED, because the
 * accumulator resets and this goes to 0 — but the flip has already locked in
 * what it read (see flipCommit), so stopping halfway costs the follow-through
 * and not the flip.
 */
function readCircleCommit() {
  const c = CONFIG.touch?.circleFlick ?? {};
  if (!circle.engaged) return 0;
  const engage = c.engageTurn ?? Math.PI;
  const full = Math.max(engage + 0.1, c.fullTurn ?? Math.PI * 2);
  const past = Math.abs(circle.turn) - engage;
  return Math.max(0, Math.min(1, past / (full - engage)));
}

/**
 * HOW FAR INTO THE FIRST HALF OF THE LOOP THE HAND IS, 0..1 — the WIND-UP, and
 * the half of the gesture that used to be invisible.
 *
 * The flip engages at the half circle, and everything before that used to be
 * the player drawing into a game that showed them nothing: the seal did not
 * move until the threshold was crossed, and then it ran a canned gather of its
 * own. Two wind-ups, one of them the player's and ignored.
 *
 * This is that first half, reported live so the animal can coil UNDER THE HAND
 * — the gather is the semicircle, and by the time the move commits the body is
 * already loaded because the player loaded it.
 *
 * ZERO ONCE ENGAGED, because from there the follow-through takes over
 * (readCircleCommit above): the same hand keeps going and the meaning of what
 * it is doing changes at the halfway point. And zero when the accumulator has
 * dropped it — a hand that pauses or doubles back has stopped winding, and the
 * body unwinds with it.
 */
function readCircleLoad() {
  const c = CONFIG.touch?.circleFlick ?? {};
  if (c.enabled === false || circle.engaged) return 0;
  const engage = Math.max(0.1, c.engageTurn ?? Math.PI);
  // The DISTANCE gate as well as the turn, so a tremor does not coil the seal
  // — the same pair the engage itself is held to, or the animal would wind up
  // for every hand resting on a mouse and only refuse at the last moment.
  if (!circle.stick && circle.path < (c.px ?? 150) * (c.loadPath ?? 0.35)) return 0;
  return Math.max(0, Math.min(1, Math.abs(circle.turn) / engage));
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
    // AND IT CLEARS THE BLOCKED LATCH. The event is the one thing the policy
    // check below cannot give us: proof that this page really does get pads.
    // checkGamepadPolicy reads a permission at boot and getGamepads throws at
    // most once, and either answering wrong latched `gamepadBlocked` for the
    // whole session with nothing able to clear it — so the pad connected, was
    // named in the console, and was then never polled again.
    unblockGamepads('a pad connected');
    inputStatus.gamepadConnected = true;
    inputStatus.gamepadName = e.gamepad?.id ?? 'gamepad';
    console.info(`[input] gamepad connected: ${inputStatus.gamepadName}`);
  });
  window.addEventListener('gamepaddisconnected', (e) => {
    // ASKED AGAIN RATHER THAN BLANKET-CLEARED. One physical controller is
    // often several entries — a wireless receiver, or an 8BitDo exposing a
    // DInput node beside its XInput one — and a Bluetooth pad that naps drops
    // one of them and comes back. Clearing the flag on any disconnect at all
    // reported "no controller" with the live one still in the player's hands.
    inputStatus.gamepadConnected = connectedPads().length > 0;
    // ...and the sticky choice lets go of a slot that is gone, so the next pad
    // is chosen on merit rather than compared against a dead index.
    if (e.gamepad?.index === activePadIndex) activePadIndex = -1;
    console.info(`[input] gamepad disconnected: ${e.gamepad?.id ?? 'gamepad'}`
      + (inputStatus.gamepadConnected ? ' (another is still connected)' : ''));
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
        if (stick) {
          // The aim thumb's slide is its flick (readFlick), read off the
          // previous position rather than the anchor: a thumb that lands and
          // then slides is gesturing from where it is, not from where it hit.
          if (stick === sticks.aim) feedFlick(t.clientX - stick.current.x, -(t.clientY - stick.current.y));
          stick.current.set(t.clientX, t.clientY);
        }
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

  // --- A TAP ON THE ANIMAL IS A CLAP ---------------------------------------
  //
  // ON THE PRESS, not on the lift, and that is the whole reason this is here
  // rather than beside the tap bookkeeping in endTouch. The one thing this
  // gesture has to do is land on a beat (see systems/clap.js, which will not
  // even use an anticipation because a wind-up reads as the input being late);
  // a finger is on the glass for 60 to 150ms before it comes off, and waiting
  // for that is a gesture that is uniformly, audibly behind the music.
  //
  // WHAT IT COSTS, honestly: a thumb PLANTED on the seal to steer claps once
  // on the way down. It is the same trade the salute makes — a gesture that
  // costs nothing and changes nothing about the fight, in exchange for being
  // immediate — and the alternative is being late every single time.
  //
  // The press goes on to drive its half's stick as it always did, so a plant
  // that turns into a drag still steers. What it does NOT do is join the
  // double-tap strike, at either end: it cannot pair with an earlier tap here,
  // and it arms nothing on the way out (`onSeal` below, read in endTouch).
  // Otherwise clapping to a beat would charge a dash on every second tap and
  // launch it on the lift — a real shove, from a gesture that has no business
  // moving the animal.
  const seal = onSeal(t.clientX, t.clientY);
  if (seal) clapRequested = true;

  // That half already has a thumb on it, so this is a finger BEYOND the two
  // sticks: the third-touch strike. Only one at a time — a fourth contact is
  // ignored rather than stealing the charge from the third.
  //
  // A finger on the seal is excepted for the reason above: it has already
  // clapped, and a charge it never asked for would launch when it lifts.
  if (sticks[role]) {
    if (s.thirdTouch && !seal && strikeTouchId === null) strikeTouchId = t.identifier;
    return;
  }

  const stick = {
    id: t.identifier,
    start: new THREE.Vector2(t.clientX, t.clientY),
    current: new THREE.Vector2(t.clientX, t.clientY),
    down: now,
    charging: false,
    // Landed on the animal, so it clapped — kept for endTouch, which must not
    // arm a double-tap off it. Latched at touchdown rather than re-tested on
    // the way out: the seal swims out from under a resting thumb, and whether
    // this press was a clap is settled by where it BEGAN.
    onSeal: seal,
  };

  // Double-tap-and-hold. This press is the second half of a tap-then-hold in
  // the same screen half, so it charges a strike while still driving its
  // stick — the thumb keeps steering or aiming through the whole wind-up.
  const tap = lastTap[role];
  if (
    s.doubleTap &&
    !seal &&
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
      !stick.onSeal &&
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
  flick.length = 0;
  mousePxX = mousePxY = NaN;
  clapRequested = false;
  // ...AND THE HALF-DRAWN CIRCLE. The accumulator survives across frames by
  // design (a loop is half a second of hand motion), so without this a gesture
  // that was part way round when a run ended would still be part way round
  // when the next one started, and the first flick of the new run would
  // complete somebody else's circle. Clearing `flick` above is not enough:
  // the turn is already summed.
  resetCircle();
  circle.until = 0;
  circle.seen = 0;
  input.circleFlick = 0;
  input.circleTurn = 0;
  input.circleCommit = 0;
  input.circleLoad = 0;
  input.circleDir = 0;
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
  feedMouseFlick(clientX, clientY);
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
      blockedAt = performance.now();
      blockedWarned = true;
      console.warn(BLOCKED_MESSAGE);
    }
  } catch {
    // Older engines don't know the 'gamepad' feature name; fall through and
    // let the try/catch around getGamepads be the backstop.
  }
}

/**
 * Let go of the latch above. It is one-way on purpose everywhere else — a page
 * that cannot have pads cannot grow them — but it is set from two guesses (a
 * permission read at boot, and one throw) and a session is a long time to be
 * wrong for. A pad announcing itself is not a guess, so it wins.
 *
 * Silent when nothing was latched, because the common case is every pad on a
 * perfectly ordinary page and this must not put a line in the log for it.
 */
function unblockGamepads(why) {
  if (!gamepadBlocked) return;
  gamepadBlocked = false;
  inputStatus.gamepadBlocked = false;
  console.info(`[input] the Gamepad API works here after all (${why}) — polling pads again.`);
}

/**
 * Every pad the browser is currently willing to admit to, as a plain array.
 *
 * The throw is swallowed rather than latched: this is asked from the connect
 * and disconnect handlers, where a failure means "I don't know" rather than
 * "this page has no pads", and latching out of an event handler would be a way
 * to lose a controller that the very next poll can see.
 */
function connectedPads() {
  if (!navigator.getGamepads) return [];
  try {
    return Array.from(navigator.getGamepads()).filter((p) => p?.connected);
  } catch {
    return [];
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

// While blocked, the API is asked again this often rather than never. The
// latch exists so a throwing call isn't made sixty times a second; making it
// permanent is a different and worse thing, because both of the readings that
// can set it are guesses — and a wrong one used to cost the whole session with
// the controller sitting there lit up. Two seconds costs nothing and is under
// the time it takes to wonder whether the pad is charged.
const BLOCKED_RETRY_MS = 2000;
let blockedAt = 0;
let blockedWarned = false;

/**
 * Forget whatever the last poll saw. Every path that leaves getGamepad without
 * a pad goes through here, including the two that used to return early from
 * the top: the readout is what somebody checks when a controller has stopped
 * working, and a slot number left over from the last frame that DID work is
 * the most misleading thing it could be showing them. `activePad` goes with
 * it — systems/haptics.js rumbles through that reference, and a pad the poll
 * has lost is not one to keep buzzing.
 */
function clearPadStatus() {
  activePad = null;
  inputStatus.padIndex = -1;
  inputStatus.padMapping = '';
  inputStatus.padSlots = 0;
  inputStatus.padCount = 0;
  inputStatus.gamepadConnected = false;
  inputStatus.axes = [];
  inputStatus.buttons = [];
  return null;
}

// THE API IS NOT THERE AT ALL — a third state, and until this it was the one
// that looked most like a flat battery. getGamepads is [SecureContext] in the
// spec and every engine enforces it, so a build opened over plain http on a
// LAN address — a phone or a second machine pointed at the dev server, which
// is the ONLY way this game gets played on http — has no method to call. Not
// blocked, not empty: absent, and the old code returned null for it without a
// word.
let warnedNoApi = false;

function noGamepadApi() {
  if (!warnedNoApi) {
    warnedNoApi = true;
    inputStatus.gamepadApi = false;
    console.warn(
      '[input] this page has no Gamepad API at all'
      + (window.isSecureContext === false
        ? ' — it was opened over plain http on a non-local address, and the API is https/localhost only.'
        : '.')
      + ' No controller can be read here.'
    );
  }
  return clearPadStatus();
}

function getGamepad() {
  if (!navigator.getGamepads) return noGamepadApi();
  if (gamepadBlocked) {
    if (performance.now() - blockedAt < BLOCKED_RETRY_MS) return clearPadStatus();
    blockedAt = performance.now();
  }

  let pads;
  try {
    pads = navigator.getGamepads();
  } catch {
    gamepadBlocked = true;
    inputStatus.gamepadBlocked = true;
    blockedAt = performance.now();
    // Once. The retry above would otherwise write this line every two seconds
    // for as long as the page is open, and the second copy of it has never
    // told anybody anything the first didn't.
    if (!blockedWarned) {
      blockedWarned = true;
      console.warn(BLOCKED_MESSAGE);
    }
    return clearPadStatus();
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
    // A pad in the list is the same proof the connect event is, and it is the
    // proof that arrives when that event does not: it fires once, at a moment
    // this page may not have been listening yet, and Safari holds it until the
    // page has been touched. The poll is every frame and has no such moment.
    unblockGamepads('a pad is in the list');
    if (!firstConnected) firstConnected = p;
    if (p.index === activePadIndex) sticky = p;
    const activity = padActivity(p);
    if (activity > peak) {
      peak = activity;
      mostActive = p;
    }
  }

  let pad = mostActive ?? sticky ?? firstConnected;
  // TWO PLAYERS, TWO PADS. In a versus match the most-active rule above would
  // hand this pad — player 1's — to whichever controller pushed harder, so
  // player 1 is pinned to the lowest index and player 2 (systems/versus.js
  // p2Pad) takes the next. With only ONE pad connected it is player 2's, and
  // player 1 is on the keyboard: the pad is ignored here outright rather than
  // shared, because two seals on one stick is a worse failure than a keyboard.
  //
  // THE TEAM SELECT DECIDES FIRST (versusSetup in systems/versusFlag.js): a
  // pad index for the left captain is that pad, the keyboard or a CPU is no
  // pad at all, and only a match nobody set up falls through to the rule
  // above — the harness route, and the one the old `?versus` flag used.
  if (versusActive()) {
    const want = captainPad(0);
    if (want === undefined) {
      const connected = Array.from(pads).filter((p) => p?.connected).sort((a, b) => a.index - b.index);
      pad = connected.length >= 2 ? connected[0] : null;
    } else {
      pad = want === null ? null : (Array.from(pads).find((p) => p?.connected && p.index === want) ?? null);
    }
  }
  activePad = pad;
  // THE COUNT IS OF THE LIST, NOT OF THE PAD WE CHOSE, and it is set on both
  // paths out of here. `padCount` used to be written only where a pad was
  // being read and zeroed everywhere else, so the two states it exists to tell
  // apart — nothing plugged in, and a pad present that this half of the game
  // is deliberately not reading (see the versus branch above) — both showed a
  // flat zero. That is the readout somebody checks when a controller "isn't
  // connecting", and it was answering the wrong question.
  // THE RAW LENGTH, NULLS AND ALL, beside the count of live ones. They answer
  // two different questions and only together do they say which half of the
  // chain is failing: a browser that has pads to give but has not been handed
  // a button press on THIS document returns a row of nulls (4 in Chrome), so
  // `slots 4 · in list 0` is "press a button in this tab" while `slots 0` is
  // "this browser has nothing at all". One number could not tell them apart.
  inputStatus.padSlots = pads?.length ?? 0;
  inputStatus.padCount = firstConnected ? Array.from(pads).filter((p) => p?.connected).length : 0;
  inputStatus.gamepadConnected = inputStatus.padCount > 0;
  // WHETHER THE PAGE IS EVEN ELIGIBLE. A browser hands gamepad input to the
  // focused document and to nothing else, so a game in a window that has lost
  // focus — behind the devtools, behind the editor, a second tab of the same
  // build — polls an empty list and is indistinguishable from a flat battery.
  // It is not a fault to fix in here, it is the answer to "the controller is
  // connected and the game can't see it", and there was nowhere to read it.
  inputStatus.pageFocused = document.hasFocus?.() ?? true;
  if (!pad) {
    // A pad that has never been touched is invisible to the browser by design,
    // so this is the normal state until the first button press. The count and
    // the connected flag set just above SURVIVE this, unlike clearPadStatus:
    // "there are two pads and this half of the game is reading neither"
    // (the versus branch) is a different state from "there are none", and it
    // is the whole reason the count is on screen.
    activePad = null;
    inputStatus.padIndex = -1;
    inputStatus.padMapping = '';
    inputStatus.axes = [];
    inputStatus.buttons = [];
    return null;
  }

  // The NAME is refreshed whenever it changes, not only when the slot does:
  // unplugging one pad and plugging in another usually reuses index 0, and a
  // stale name there is a tip telling a PlayStation player to press LB. The
  // log line stays on the slot change, which is the event worth reading about.
  if (pad.index !== activePadIndex || inputStatus.gamepadName !== (pad.id ?? 'gamepad')) {
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
// Y / Triangle. The face button the note on CLAP_BUTTON was saving; see
// menuInput.reroll.
const REROLL_BUTTON = 3;
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
let rerollHeld = false;
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

  const rerollDown = !!pad?.buttons[REROLL_BUTTON]?.pressed;
  menuInput.reroll = rerollDown && !rerollHeld;
  rerollHeld = rerollDown;

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
  // Y too, and it matters more here than the others: a level-up screen opens
  // straight out of a fight, and Y held as the cards land would throw the hand
  // back before the player had seen it.
  rerollHeld = !!pad?.buttons[REROLL_BUTTON]?.pressed;
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
  menuInput.reroll = false;
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
/**
 * TAKE THE CONTROLS AWAY, in place, for a frame nobody is playing — the goal
 * replay (systems/versus.js).
 *
 * Done to the live object at the source rather than by handing each consumer a
 * neutral copy, because there is no single consumer. A replay frame still runs
 * the whole gameplay loop in main.js — updatePlayer, updateCharge, the strike
 * release, the bubble emitters, the aim indicator, the cinematic camera — and
 * every one of them reads this object. Substituting at one call site fixes one
 * of them and leaves the rest, which is how the replay ended up with the seal
 * banking a dash that fired the moment it ended, the flippers tracking the live
 * cursor over recorded footage, and the charge sound going off underneath it.
 *
 * `aim` is LEFT ALONE. It is a heading, never "off", and something has to be
 * true for anything that reads a direction; `aimLive`/`aiming` going false is
 * what tells the aim rig nobody is pointing, which is the honest statement.
 *
 * The menu poll is a different object (menuInput) and the replay's own skip
 * runs its own listeners and its own pad poll (anyButtonHeld), so pausing and
 * skipping still work — those are the two things a viewer IS allowed to do.
 */
export function holdInput(io = input) {
  io.move.set(0, 0);
  io.strike = false;
  io.strikeHeld = false;
  io.strikeRelease = false;
  io.aiming = false;
  io.aimLive = false;
  io.clap = false;
  return io;
}

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
  input.aimLive = false;
  input.aimMoved = false;
  input.aimGesture.set(0, 0);
  // The circle is an edge like `strike`, so it is cleared here and raised at
  // most once below.
  input.circleFlick = 0;

  if (pad) {
    const rx = pad.axes[2] ?? 0;
    const ry = pad.axes[3] ?? 0;
    if (Math.hypot(rx, ry) > stickDeadzone()) {
      input.aim.set(rx, -ry).normalize();
      aimed = true;
      input.aiming = true;
      input.aimLive = true;
      // A pushed stick IS the gesture: it is a direction, not a point, so it
      // cannot flip on its own and reading it every frame is safe.
      input.aimMoved = true;
      input.aimGesture.copy(input.aim);
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
      input.aimLive = true;
      // The thumb SLID — not merely that it is down — and the slide is the
      // gesture's direction. A thumb resting on the glass names a point the
      // seal is about to fly past; a thumb that flicks up means up.
      input.aimMoved = readFlick(input.aimGesture);
      lastAimDevice = 'touch';
    }
  }

  // One thumb down and it's the movement one: face where we're swimming. The
  // aim direction would otherwise stay frozen at wherever the aim thumb last
  // pointed, which leaves the seal swimming backwards.
  if (!aimed && moveMag && CONFIG.touch.aimFollowsMove && lastAimDevice === 'touch') {
    input.aim.copy(moveVec);
    aimed = true;
    input.aimLive = true;
    // A direction from the move thumb, like a stick: no point to fly past.
    input.aimMoved = true;
    input.aimGesture.copy(moveVec);
  }

  if (!aimed && hasMouse && lastAimDevice === 'mouse') {
    worldPoint.set(mouseNDC.x, mouseNDC.y, 0).unproject(camera);
    const dx = worldPoint.x - playerPos.x;
    const dy = worldPoint.y - playerPos.y;
    if (Math.hypot(dx, dy) > 0.001) {
      input.aim.set(dx, dy).normalize();
      input.aimLive = true;
      // ...and the gesture is the MOUSE moving, not the heading changing —
      // and it is the direction it moved in, not where it ended up.
      input.aimMoved = readFlick(input.aimGesture);
    }
  }

  // --- the circle (edge: true for exactly one frame per loop drawn) ---
  //
  // AFTER the whole aim priority chain, and fed from whichever device won it:
  // a pad rolls its right stick round the gate, everything else draws with the
  // pointer samples readFlick has already collected. Reading both at once
  // would let a wiggled mouse flip a seal being played on a controller.
  //
  // Read every frame rather than only while the game is running, because the
  // accumulator has to SEE the samples it is meant to reject — a reader that
  // skipped frames would come back to a window full of unconsumed deltas and
  // sum a hand's last half-second into a circle it never drew.
  {
    const padAim = (pad && Math.hypot(pad.axes[2] ?? 0, pad.axes[3] ?? 0) > stickDeadzone())
      ? { x: pad.axes[2] ?? 0, y: -(pad.axes[3] ?? 0) }
      : null;
    input.circleFlick = readCircle(padAim);
    input.circleTurn = circle.turn;
    input.circleCommit = readCircleCommit();
    input.circleLoad = readCircleLoad();
    // WHICH WAY THE HAND IS WINDING, for the coil to lean into before the move
    // has committed to a direction of its own. Zero when nothing is being
    // drawn, so a seal with no gesture under it has no lean.
    input.circleDir = circle.engaged || circle.turn === 0 ? 0 : (circle.turn > 0 ? 1 : -1);
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
