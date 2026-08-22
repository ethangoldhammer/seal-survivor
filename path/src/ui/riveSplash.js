// A one-shot Rive splash: mounts its own canvas, takes the player's name, and
// tears itself down when the artboard says the run has begun. Deliberately
// standalone — it knows nothing about ui.js or the game loop, so it can be
// tested on its own page before it's wired into the start menu.
//
// ---------------------------------------------------------------------------
// HOW THE NAME GETS IN, and why there is a DOM input on top of the artboard.
//
// Rive 2.39 cannot capture typing. It has Focus nodes and it handles Tab, and
// that is the whole of its keyboard support — no characters, no caret, no IME.
// So a real <input> sits over the canvas, owns focus, and its value is mirrored
// into `strPlayerName` on every keystroke; the text run in the artboard is
// purely the display of it.
//
// That is not a workaround for the missing feature, it is the right shape
// anyway: a real input is the ONLY thing that raises the on-screen keyboard on
// a phone. A keydown listener on window — which is what a canvas-only version
// would need — gets nothing on iOS, because nothing is focused and the keyboard
// never comes up. Most of this game is played on a phone.
//
// The input is invisible rather than off-screen. `opacity: 0` over the artboard
// keeps it in the layout, which matters on iOS: the browser scrolls the focused
// field into view, and a field parked at -9999px scrolls the whole page away
// from the splash to reach it.
//
// ---------------------------------------------------------------------------
// HOW THE RUN STARTS, and why it is no longer "any input at all".
//
// This used to dismiss on the first pointerup or keydown anywhere. With a text
// field that is unusable — the first letter of your own name would start the
// game — so the artboard decides now, by firing `tStart`, and the game listens.
//
// Rive -> JS works because Rive.advance() calls handleCallbacks() straight
// after the artboard advances, so a trigger the state machine fires reaches an
// `.on()` callback on that frame. It needs `autoBind: true`, which this file
// did not pass before: without it `rive.viewModelInstance` is null and both the
// name and the trigger silently do nothing.
//
// ---------------------------------------------------------------------------
// HOW THE DICE BUTTON WORKS, which is the same handshake pointed the other way
// round the field.
//
// The artboard fires `tRandomizeName`, the game rolls a name out of
// sealNames.csv (systems/randomName.js), writes it into the hidden <input> and
// mirrors it back through `strPlayerName`. So the artboard owns the button and
// nothing else: it does not need the vocabulary, the length limit or the
// leaderboard's sanitiser, all of which live on this side already because the
// typed path needs them too.
//
// It lands in the FIELD rather than beside it, which is what makes the roll a
// suggestion: the name is now theirs to edit, clear, or roll again, and it is
// banked on the way out exactly like a typed one.
//
// The trigger is OPTIONAL, unlike `tStart`. An export without it is a splash
// with no dice button, which is a splash — so a missing property here is one
// line in the console and nothing else. That is what lets this land before the
// button exists in the editor; see PENDING_BINDINGS in riveContract.js.
//
// ---------------------------------------------------------------------------
// THERE IS STILL A WAY OUT WITHOUT THE TRIGGER, and it is not politeness. If a
// .riv is ever exported without `tStart` — renamed in the editor, or an older
// file dropped in — then a splash that only listens for it is a game nobody can
// start, on every device, with nothing in the console. `startFallback` keeps
// the old behaviour alive for exactly that case and for nothing else.
// ---------------------------------------------------------------------------

import { Rive, Layout, Fit, Alignment } from '@rive-app/canvas';
// Points the runtime at our own copy of its WASM instead of unpkg. Imported for
// the side effect, and it has to happen before any Rive instance exists — see
// riveRuntime.js.
import './riveRuntime.js';
import { SPLASH_ARTBOARD, SPLASH_BINDINGS, SPLASH_INPUTS } from './riveContract.js';
import { loadPlayerName, savePlayerName, sanitizeName, MAX_NAME_LEN } from '../systems/playerName.js';
// What the dice button spends. Parsed once at module load, out of
// sealNames.csv — see the note above and path/src/sealNameTable.js.
import { randomPlayerName } from '../systems/randomName.js';
// Death is permanent — see systems/nameLedger.js.
import { isNameBuried } from '../systems/nameLedger.js';
import { touchPrimary } from '../devices.js';
// The tip jar, on the one screen a player is not busy. Dependency-free by
// design, so importing it here does not cost this module the standalone
// property the header above is built on — see ui/tipJar.js.
import { mountSplashTipJar } from './tipJar.js';
import { parseTipCsv } from '../tipTable.js';
import tipsCsv from '../tips.csv?raw';

// The same tiers the other two jars show. Parsed here rather than passed in
// because this module is written to know nothing about ui.js — see its header.
const TIP_TIERS = parseTipCsv(tipsCsv);
// ?url so Vite emits the .riv as a hashed asset and hands back a path. The
// alternative — base64 in a JS module, the way levelUpImages.js does it —
// would push 644KB of binary through the module graph on every reload.
import splashUrl from './seal_survivor.riv?url';

// ---------------------------------------------------------------------------
// THE DICE BUTTON, HIT-TESTED HERE — a WORKAROUND, and one with a deletion
// condition written into it.
//
// The artboard's own listeners do not fire. Not the dice's and not the Start
// button's: driving `pointerDown`/`pointerUp` straight into the state machine
// instance, 576 presses covering the whole artboard, produces no trigger and
// no state change at all — so this is upstream of the canvas, the coordinate
// maths, the browser and the runtime version (2.39.2 and 2.40.0 both). It is
// something about how the two listeners are authored in seal_survivor.riv,
// which is why `tStart` has only ever been reachable with the Enter key.
// `npm run looks:splash` has a "sweep for live listeners" button that says
// which state the shipped file is in.
//
// So the press is caught on the WRAPPER and mapped into artboard space by
// hand. The rectangle below is the glyph's own box, MEASURED off the rendered
// artboard rather than guessed — and that is also the weakness: move the
// button in the Rive editor and this rect points at empty water, silently.
//
// IT DISABLES ITSELF. The moment `tRandomizeName` arrives from the artboard,
// `riveButtonLive` latches and this path never runs again — so the day the
// listener is fixed, the workaround stops participating on its own and the
// only thing left to do is delete it.
// ---------------------------------------------------------------------------

// The glyph measured at 288.7..368.2 x 726.7..792.7 in artboard units, grown
// to a comfortable target. The name field's left edge is at x≈404, so the box
// stops well short of it: a press meant for the field must never roll a name.
const DICE_HIT = { minX: 268, maxX: 392, minY: 703, maxY: 816 };

// THE NAME FIELD, measured the same way — the panel's own edges, walked across
// the render rather than read off a design. This box is not a control here: it
// is what a press must NOT be taken for. A tap on the field means "I want to
// type", and with the rule below (anywhere else starts the run) it is the one
// place on the splash where nothing at all should happen.
const FIELD_HIT = { minX: 411, maxX: 1509, minY: 702, maxY: 830 };

/** Is an artboard-space point inside one of the boxes above? */
function inside(box, p) {
  return !!p && p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;
}

// The artboard's own size, for the mapping below. Read off the loaded file
// when it can be, because a resized artboard would move every hit box on the
// screen; these are what `Splash Screen` measures today.
const ARTBOARD_W = 1920;
const ARTBOARD_H = 1080;

// How long to wait for the ARTBOARD to answer before doing it ourselves. The
// trigger arrives from inside Rive's advance, a frame or more after the press,
// so firing on the press itself would double up the day the listener works.
// Three frames is under the eye's threshold for a button and well over Rive's.
const DICE_GRACE_MS = 60;

// How long after the splash appears a press cannot yet start the run. Long
// enough to swallow the gesture that brought the player here, short enough
// that somebody who means it never notices.
const START_DEADTIME_MS = 400;

/**
 * A client point in ARTBOARD units, for `Fit.Contain` centred — which is the
 * layout this file mounts with, a few lines below. Rive computes the same
 * matrix internally and does not expose it, and the alternative (reaching into
 * `rive._layout` and `rive.runtime`) is two underscored properties that a
 * runtime bump is free to rename.
 */
function toArtboard(rect, clientX, clientY) {
  const scale = Math.min(rect.width / ARTBOARD_W, rect.height / ARTBOARD_H);
  if (!(scale > 0)) return null;
  return {
    x: (clientX - rect.left - (rect.width - ARTBOARD_W * scale) / 2) / scale,
    y: (clientY - rect.top - (rect.height - ARTBOARD_H * scale) / 2) / scale,
  };
}

export function mountRiveSplash({
  parent = document.body,
  onReady,
  onError,
  onDismiss,
  // Keep dismissing on any stray input, the way this always did. FALSE is the
  // shipping value now that the artboard has a Start button — see the note
  // above — and it flips itself back to true if the file turns out to have no
  // `tStart`, which is the only thing standing between a bad export and an
  // unstartable game.
  startFallback = false,
  // What the wrapper paints BEHIND the artboard, which is fitted `Contain` and
  // so never covers the whole screen on its own.
  //
  // Opaque is the value this shipped with and still the default, because for
  // most of the game's life there was nothing behind the splash worth seeing.
  // There is now: the title screen holds the seal up against the lens and lets
  // the player move it (systems/titleSeal.js), and that is drawn on the game
  // canvas underneath this wrapper. Anything with alpha in it reveals that.
  //
  // Passing a transparent value here is NOT on its own enough if the artboard
  // carries a full-bleed background rectangle of its own — that is a change in
  // the .riv, not one this option can make.
  background = '#05070d',
  // Every pointer move over the splash, as client coordinates plus the pointer
  // type. The wrapper is `pointer-events: all` and covers the canvas, so the
  // game's own mousemove listener — which is ON the canvas — receives nothing
  // at all while this is up. Without this the seal underneath aims at whatever
  // the cursor was doing before the page finished loading.
  //
  // A callback rather than a call into input.js for the reason at the top of
  // this file: this module knows nothing about the rest of the game, and a test
  // page hands in nothing.
  onPointer,
  // A REAL USER GESTURE, reported the moment one lands on the splash — before
  // anything decides what it meant.
  //
  // This exists because of `tStart`. The trigger is dispatched from inside
  // Rive's advance, which is a rAF and not a gesture call stack, so a run begun
  // that way builds its AudioContext outside a gesture and comes up suspended.
  // The press that pushed Rive's button IS a gesture and it bubbles to the
  // wrapper a frame earlier — so audio unlocks there, and by the time the
  // trigger arrives the context is already awake.
  //
  // Called on every gesture, not just the first, and must be cheap and
  // idempotent. unlockAudio is both.
  onGesture,
  // How the splash LEAVES. Given `(wrap, done)`, it owns the wrapper until it
  // calls `done`, which removes it. Optional: without it the wrapper goes on
  // the frame the player dismisses it, which is what this did before.
  //
  // Kept as a callback rather than an effect implemented here, because this
  // module deliberately knows nothing about the rest of the UI — ui.js hands
  // in a reveal, and a test page can hand in nothing.
  exit,
} = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'sv-riv';
  // pointer-events must be explicit: the splash sits inside .sv-ui in the real
  // game, and that container is pointer-events:none so the 3D scene below it
  // stays clickable.
  wrap.style.cssText =
    `position:absolute; inset:0; pointer-events:all; z-index:20; background:${background};`;

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block; width:100%; height:100%;';
  wrap.appendChild(canvas);

  // THE FIELD THE PLAYER ACTUALLY TYPES INTO. Invisible, over the artboard, and
  // real — see the note at the top for why it cannot be a keydown listener and
  // why it must not be parked off-screen.
  //
  // maxlength is the board's own limit, so the field cannot accept a name the
  // leaderboard would then silently cut. autocapitalize/autocorrect off because
  // this is a handle, not prose, and a phone helpfully turning "sealboy" into
  // "Sea lboy" is the kind of thing nobody reports and everybody notices.
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = MAX_NAME_LEN;
  nameInput.setAttribute('aria-label', 'Your name');
  nameInput.autocomplete = 'off';
  nameInput.autocapitalize = 'off';
  nameInput.spellcheck = false;
  nameInput.setAttribute('autocorrect', 'off');
  // `enterkeyhint` puts "Go" on the phone keyboard's return key rather than
  // "return", which is the only label on that key that describes what it does
  // here. Enter starts the run — see onNameKey.
  nameInput.setAttribute('enterkeyhint', 'go');
  // POINTER-EVENTS OFF, and this is the whole reason the field can cover the
  // artboard at all. It has to be full-size and in the layout (see above), and
  // a full-size element that takes clicks would swallow every one of them —
  // including the click on Rive's own Start button, which is hit-tested on the
  // canvas underneath. The artboard would be unclickable and `tStart` could
  // never fire, which looks exactly like a broken state machine.
  //
  // So the canvas keeps all the pointer events and focus is driven by hand,
  // from the pointerup handler below. That is also the iOS-safe shape: calling
  // focus() from inside a real gesture handler is what raises the keyboard,
  // and it will not raise it from anywhere else.
  //
  // font-size 16px is not a look — it is invisible. Anything smaller and
  // mobile Safari zooms the page when the field takes focus.
  nameInput.style.cssText =
    'position:absolute; inset:0; width:100%; height:100%; opacity:0; '
    + 'pointer-events:none; border:0; outline:0; background:transparent; '
    + 'color:transparent; caret-color:transparent; font-size:16px; text-align:center;';
  wrap.appendChild(nameInput);

  // THE TIP JAR. A DOM element over the artboard rather than a button in it,
  // for the same reason the name field is one: the splash is a Rive export,
  // and a link that has to open a URL is a thing the .riv cannot do — it would
  // need a trigger, a binding and a re-export to change where it points.
  //
  // It takes its own pointer events and stops them dead (see mountSplashTipJar)
  // so a tap on the jar is not also a tap on the card underneath it.
  const tipJar = mountSplashTipJar(wrap, { tiers: TIP_TIERS });

  parent.appendChild(wrap);

  let rive = null;
  let destroyed = false;
  // The trigger property, once bound. Held so it can be unsubscribed on the way
  // out: the callback closes over `destroy`, and a Rive instance outliving the
  // splash with a live listener is a run that can be started twice.
  let startTrigger = null;
  let onStartTrigger = null;
  // The dice button's trigger, held for the same reason: a Rive instance that
  // outlived the splash with a live listener would be typing into a field that
  // is no longer on the page.
  let randomTrigger = null;
  let onRandomTrigger = null;
  // When this splash went up, for the dead time above.
  const mountedAt = performance.now();
  // Whether the press being released began on the splash — see maybeStart.
  let pressBeganHere = false;

  // THE STATE MACHINE'S OWN INPUTS, once the machine is running. The game
  // says whether the pointer is on the button and when it was pressed; the
  // artboard decides what either looks like. See SPLASH_INPUTS.
  let hoverInput = null;
  let clickInput = null;
  // How long the press animation runs, read off the file so a retime in the
  // editor carries. Only used on touch — see maybeDice.
  let clickDur = 0.6;
  let hoverOn = false;
  let touchHoverTimer = 0;

  // Set the first time the ARTBOARD fires the dice trigger. It latches off the
  // hand-rolled hit test above — see the note at the top of the file.
  let riveButtonLive = false;

  // Rive draws at the canvas's backing-store size, not its CSS size, so a
  // resize that only changes layout leaves the animation rendering at the old
  // resolution until the drawing surface is resynced.
  const onResize = () => rive?.resizeDrawingSurfaceToCanvas();

  function destroy(reason = 'manual') {
    if (destroyed) return;
    destroyed = true;

    window.removeEventListener('resize', onResize);
    clearTimeout(touchHoverTimer);
    for (const [target, type, fn] of inputListeners) target.removeEventListener(type, fn);

    // THE NAME IS BANKED ON THE WAY OUT, whatever ended the splash. Not on
    // every keystroke: savePlayerName writes to localStorage, and a synchronous
    // storage write per character is the one thing that can make typing feel
    // heavy on a slow phone. Not on submit-only either — that is how a player
    // who typed a name and started with Enter ends up called Seal.
    //
    // A blank is ignored by savePlayerName rather than clearing, so backing out
    // of a field that was pre-filled does not erase the name they already had.
    savePlayerName(nameInput.value);
    // Off the DOM before the exit animation: the wrapper hangs around for the
    // dissolve, and a focused input inside it keeps the phone keyboard up over
    // the first second of the run.
    nameInput.blur();
    nameInput.remove();
    // Off with it. The wrapper hangs around for the dissolve and the canvas
    // keeps the last frame it painted — but the jar is DOM, so it would sit
    // there perfectly crisp while the art it belongs to breaks up.
    tipJar.remove();

    // Unsubscribed before cleanup(), because the callback's whole job is to
    // call this function and a second arrival would start the run twice.
    if (startTrigger && onStartTrigger) startTrigger.off(onStartTrigger);
    startTrigger = null;
    onStartTrigger = null;
    if (randomTrigger && onRandomTrigger) randomTrigger.off(onRandomTrigger);
    randomTrigger = null;
    onRandomTrigger = null;

    // cleanup() stops the render loop and frees the WASM-side artboard. Without
    // it the instance keeps drawing into a detached canvas. The canvas keeps
    // the last frame it painted, which is what the exit animation dissolves.
    rive?.cleanup();
    rive = null;

    // Off immediately, whatever happens next: the wrapper covers the whole
    // screen, and an exit animation that took a second would otherwise eat the
    // first second of the run's input.
    wrap.style.pointerEvents = 'none';

    // Before the exit, not after: the run starts NOW and the splash dissolves
    // over the top of a game that is already moving. Waiting would be a second
    // of nothing between the player asking to play and the game answering.
    onDismiss?.(reason);

    if (exit) exit(wrap, () => wrap.remove());
    else wrap.remove();
  }

  // THE FALLBACK PATH ONLY — see the note at the top. Live when the artboard
  // has no `tStart` to fire, and dead otherwise, because with a text field on
  // screen "any keydown starts the game" means the first letter of your name
  // does.
  //
  // pointerUP, not pointerdown: tearing the wrapper out on pointerdown leaves
  // the rest of that same physical click to land on whatever is underneath —
  // which is the start menu's "Start run" button. Waiting for the release
  // keeps the whole gesture on the splash.
  const dismiss = (e) => { if (startFallback) destroy(e.type); };

  // A tap anywhere on the splash hands the keyboard to the name field. The
  // field takes no pointer events of its own (see its style above), so this is
  // the only route to focus — and it has to be a real gesture handler, because
  // that is the only place iOS will raise the on-screen keyboard from.
  //
  // Runs BEFORE `dismiss` in the same listener rather than as a second one on
  // the same event: on the fallback path that tap also ends the splash, and
  // focusing a field inside a wrapper that is about to be removed would be a
  // keyboard flashing up over the first frame of the run.
  // WHAT A PRESS ON THE SPLASH MEANS, decided here because the artboard cannot
  // decide it — see the note at the top of the file. Three places, and the
  // third is everywhere else:
  //
  //   the dice   roll a name
  //   the field  take focus, so the player can type. NOTHING else: this is the
  //              one press that must not start the run, or a player reaching
  //              for the keyboard would be thrown into the game instead.
  //   anywhere   start the run
  //
  // "Anywhere else starts" is looser than the artboard's own Start button,
  // which is a rectangle somewhere in the file we cannot see. It is also the
  // only thing that makes the game startable on a phone at all, since `tStart`
  // has never fired and Enter needs a keyboard. When the artboard's listener
  // works this whole path can go.
  // A press BEGINNING on the splash, which is what makes the release above a
  // click rather than the tail of somebody else's gesture.
  const onSplashDown = () => { pressBeganHere = true; };

  const onSplashPointer = (e) => {
    // First, and before any branch below can end the splash — see onGesture.
    onGesture?.();
    const began = pressBeganHere;
    pressBeganHere = false;
    if (startFallback) { dismiss(e); return; }

    const p = toArtboard(canvas.getBoundingClientRect(), e.clientX, e.clientY);

    if (inside(FIELD_HIT, p)) {
      // Focus is given HERE and nowhere else now. It used to be handed over on
      // any press at all, which was right while every press also meant
      // "nothing" — it is wrong now that a press elsewhere starts the run,
      // because raising a phone's keyboard on the way into the game is a
      // keyboard that opens over the first second of play.
      if (document.activeElement !== nameInput) nameInput.focus();
      return;
    }

    if (inside(DICE_HIT, p)) { maybeDice(); return; }

    maybeStart(began);
  };

  // BEGIN THE RUN, unless the artboard beats us to it. Same grace period and
  // the same reasoning as the dice: `tStart` arrives from inside Rive's
  // advance, a frame or more after the press, and destroy() is idempotent
  // anyway — so the check is simply whether the splash is still standing.
  //
  // TWO GUARDS, because "anywhere else starts the run" is a very large button
  // and both of these are ways of pressing it without meaning to:
  //
  //   the press must have BEGUN here. A pointerup on its own is not a click —
  //   it is also what arrives when a drag that started somewhere else lets go
  //   over the splash, or when a press that dismissed something underneath
  //   releases up here. Those must not start a run.
  //
  //   ...and not in the first moments. The splash mounts under whatever
  //   gesture brought the player to it (a reload, a click on the page, a
  //   dismissed dialog), and a run that begins before the title has been read
  //   looks exactly like the splash failing to appear at all.
  function maybeStart(began) {
    if (destroyed) return;
    if (!began) return;
    if (performance.now() - mountedAt < START_DEADTIME_MS) return;
    setTimeout(() => {
      if (destroyed) return;
      destroy('press');
    }, DICE_GRACE_MS);
  }

  // Is the point inside the dice's box, in artboard units? Used by the hover
  // writer, which asks it of every mouse move.
  function overDice(clientX, clientY) {
    return inside(DICE_HIT, toArtboard(canvas.getBoundingClientRect(), clientX, clientY));
  }

  // THE LIT STATE, written straight at the artboard. The hover half of the
  // workaround: the button's highlight is the artboard's own animation off
  // `bRandomHover`, and with the file's hover listeners inert this is the only
  // thing that ever sets it. Written on change only — a boolean assigned every
  // mousemove is a dirty flag on the view model sixty times a second.
  //
  // The CURSOR rides along, because a thing that lights up under the pointer
  // and does not become a hand still does not read as a button.
  function setDiceHover(on) {
    if (hoverOn === on) return;
    hoverOn = on;
    canvas.style.cursor = on ? 'pointer' : '';
    try { if (hoverInput) hoverInput.value = on; } catch { /* see writeName */ }
  }

  // Did that press land on the dice? Only asked while the artboard has never
  // answered for itself — see DICE_HIT at the top of the file.
  function maybeDice() {
    if (riveButtonLive || destroyed) return;

    // THE PRESS ANIMATION, which the artboard only plays while it also thinks
    // the button is hovered — correct for a mouse, and impossible on a finger,
    // which never hovers anything. So a touch press holds the hover input up
    // for the length of the press animation and then drops it: a tap gets the
    // same animation a click does rather than nothing at all.
    try {
      if (touchPrimary() && hoverInput) {
        hoverInput.value = true;
        clearTimeout(touchHoverTimer);
        touchHoverTimer = setTimeout(() => {
          if (destroyed) return;
          try { if (hoverInput) hoverInput.value = false; } catch { /* see writeName */ }
        }, clickDur * 1000);
      }
      clickInput?.fire();
    } catch (err) {
      console.warn(`[riveSplash] could not fire ${SPLASH_INPUTS.click} —`, err?.message ?? err);
    }

    // The grace period is the whole reason this is not a race: if the artboard
    // was going to answer, it has by now, and `riveButtonLive` is set.
    setTimeout(() => {
      if (riveButtonLive || destroyed) return;
      randomizeName();
    }, DICE_GRACE_MS);
  }

  // Enter starts the run from the keyboard, on both paths. It is what the
  // return key means in a form, it is what `enterkeyhint="go"` has promised the
  // phone keyboard, and it costs a player who is already typing a reach for the
  // mouse. Not a general keydown — only this one key, and only from the field.
  const onNameKey = (e) => {
    onGesture?.();
    if (e.key !== 'Enter') return;
    e.preventDefault();
    destroy('enter');
  };

  // MIRRORED ON EVERY KEYSTROKE, through the same sanitiser the leaderboard
  // uses. Sanitising HERE rather than on the way out is what makes the artboard
  // honest: the text run shows exactly the characters that will be stored and
  // posted, so a player typing something the board would strip watches it not
  // appear instead of finding it missing from the board later.
  //
  // The field is rewritten only when the sanitiser actually changed something —
  // assigning `.value` unconditionally moves the caret to the end, which turns
  // editing the middle of a name into a fight.
  const onNameInput = () => {
    const clean = sanitizeName(nameInput.value);
    if (clean !== nameInput.value) nameInput.value = clean;
    writeName(clean);
  };

  // MOUSE ONLY, and the filter is the important half. Forwarding a touchmove
  // here would leave a phone convinced it had a mouse — see feedMouse in
  // input.js for what that costs for the rest of the run.
  const onSplashMove = (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    // MOUSE ONLY, which is the right filter for a hover as well as for the
    // seal's aim: a finger is never "hovering" a button, and a touch that lit
    // this one would leave it lit until the next tap somewhere else.
    if (!riveButtonLive && !destroyed) setDiceHover(overDice(e.clientX, e.clientY));
    onPointer?.(e.clientX, e.clientY);
  };

  // The pointer leaving the window entirely produces no move inside it, so
  // without this the button stays lit after the cursor is gone.
  const onSplashLeave = () => setDiceHover(false);

  const inputListeners = [
    [wrap, 'pointermove', onSplashMove],
    [wrap, 'pointerleave', onSplashLeave],
    [wrap, 'pointerdown', onSplashDown],
    [wrap, 'pointerup', onSplashPointer],
    [window, 'keydown', dismiss],
    [nameInput, 'input', onNameInput],
    [nameInput, 'keydown', onNameKey],
  ];
  for (const [target, type, fn] of inputListeners) target.addEventListener(type, fn);

  // Take the dice button's inputs off the running machine. See the call site
  // for why it cannot happen any earlier.
  function takeInputs(machines) {
    try {
      const inputs = machines.length ? (rive.stateMachineInputs(machines[0]) ?? []) : [];
      hoverInput = inputs.find((i) => i.name === SPLASH_INPUTS.hover) ?? null;
      clickInput = inputs.find((i) => i.name === SPLASH_INPUTS.click) ?? null;
      if (!hoverInput || !clickInput) {
        console.info(
          `[riveSplash] this export has ${inputs.length ? inputs.map((i) => i.name).join(', ') : 'no'} state machine inputs — `
          + `the dice button wants "${SPLASH_INPUTS.hover}" and "${SPLASH_INPUTS.click}" to animate.`,
        );
      }
      // The press animation's own length, for the touch pulse in maybeDice.
      const press = rive.animator?.animations?.find((a) => a.name === 'Random_Click');
      const fps = press?.animation?.fps ?? 0;
      if (fps > 0) clickDur = press.animation.duration / fps;
    } catch (err) {
      console.info('[riveSplash] could not read the splash state machine inputs —', err?.message ?? err);
    }
  }

  // Push the current text at the artboard. A no-op until the view model is
  // bound, which is what makes it safe to call from the input handler before
  // the file has finished loading — a fast typist beats a 1.7MB parse.
  function writeName(value) {
    try {
      const prop = rive?.viewModelInstance?.string(SPLASH_BINDINGS.name);
      if (prop) prop.value = value;
    } catch (err) {
      // A missing property throws rather than returning null on some paths.
      // The splash still works — the name is stored either way, and the only
      // loss is seeing it on the artboard while typing.
      console.warn(`[riveSplash] could not write ${SPLASH_BINDINGS.name} —`, err?.message ?? err);
    }
  }

  // THE DICE. Rolls a name, puts it in the field, mirrors it to the artboard —
  // and hands it back, so a caller driving this by hand can see what landed.
  //
  // The current value is passed as `avoid`: a randomise button that returns the
  // name already on screen reads as a button that did nothing, and with a
  // couple of dozen parts that happens often enough to notice.
  //
  // NOT SAVED HERE. destroy() banks whatever is in the field on the way out,
  // the same as a typed name — so rolling through six names and then typing
  // your own leaves exactly one write to storage, and backing out of the
  // splash never files you under a name you rejected.
  function randomizeName() {
    if (destroyed) return '';
    const name = randomPlayerName(nameInput.value);
    nameInput.value = name;
    writeName(name);
    return name;
  }

  rive = new Rive({
    src: splashUrl,
    canvas,
    // NAMED, not left to the file's default. This used to be omitted, which was
    // safe only for as long as the file had exactly one artboard — it now has
    // two, and "the default artboard" is a property of the .riv that changes
    // when someone reorders or re-marks them in the editor. The failure that
    // guards against is a silent one: the splash would simply come up as the
    // boss health bar one morning, with nothing in the code having changed.
    artboard: SPLASH_ARTBOARD,
    // autoplay would start the artboard's FIRST TIMELINE. This file has three
    // of them plus a state machine, and the state machine is what sequences
    // them — so play it explicitly once the names are known, rather than
    // whichever timeline happens to sit at index 0.
    autoplay: false,
    // WITHOUT THIS `rive.viewModelInstance` IS NULL and both the name and the
    // start trigger silently do nothing — no error, no warning, a splash that
    // looks perfect and cannot be typed into or started. It hands back the
    // artboard's own default instance, which is what the boss bar and the
    // polaroid already use.
    autoBind: true,
    layout: new Layout({ fit: Fit.Contain, alignment: Alignment.Center }),
    onLoad: () => {
      // A splash that gets dismissed during the load would otherwise come back
      // on screen the moment loading finishes.
      if (destroyed) { rive?.cleanup(); rive = null; return; }
      rive.resizeDrawingSurfaceToCanvas();
      window.addEventListener('resize', onResize);

      // THE RUN'S OWN START BUTTON. `.on()` fires when the property changed
      // during an advance, and the state machine firing it counts — see the
      // note at the top for where that is in the runtime.
      try {
        startTrigger = rive.viewModelInstance?.trigger(SPLASH_BINDINGS.start) ?? null;
      } catch {
        startTrigger = null;
      }
      if (startTrigger) {
        onStartTrigger = () => destroy('start');
        startTrigger.on(onStartTrigger);
      } else {
        // No trigger in this export. Loud, and then survivable: without the
        // fallback the splash is a wall with no door, which is a worse failure
        // than the sloppy dismiss it goes back to.
        console.warn(
          `[riveSplash] the artboard has no "${SPLASH_BINDINGS.start}" trigger — `
          + 'falling back to dismiss-on-any-input so the game can still be started.',
        );
        startFallback = true;
      }

      // THE DICE BUTTON. Optional in a way `tStart` is not — see the note at
      // the top — so an export without it costs one line in the console and
      // changes nothing else about the splash.
      try {
        randomTrigger = rive.viewModelInstance?.trigger(SPLASH_BINDINGS.random) ?? null;
      } catch {
        randomTrigger = null;
      }
      if (randomTrigger) {
        onRandomTrigger = () => { riveButtonLive = true; randomizeName(); };
        randomTrigger.on(onRandomTrigger);
      } else {
        console.info(
          `[riveSplash] no "${SPLASH_BINDINGS.random}" trigger in this export — `
          + 'the name field works, there is just no dice button to roll one.',
        );
      }

      // A returning player's name, into both the field and the artboard. Read
      // here rather than at mount so it lands after the state machine has had
      // its defaults — a write before the first advance is one the machine can
      // still overwrite.
      // A RETURNING PLAYER MAY BE RETURNING AS A DEAD SEAL. The score card names
      // the next one on the way out of a run (see offerNextSeal in ui/ui.js),
      // but a player who closes the tab on the game-over screen never gets
      // there — and the name still in storage belongs to a seal with a
      // headstone. Rolled fresh here rather than shown and refused later: the
      // splash is the last surface between that saved name and a run being
      // played by somebody the ledger says is buried.
      //
      // Saved immediately, not left in the field. The field is the only thing
      // that has changed otherwise, and a player who presses Play without
      // touching it would start under the buried name again.
      const remembered = loadPlayerName();
      if (remembered && isNameBuried(remembered)) savePlayerName(randomPlayerName(remembered));
      nameInput.value = loadPlayerName();
      writeName(nameInput.value);

      // Focus so a keyboard player can type without clicking. Two exceptions:
      //
      //   touch     focusing throws the on-screen keyboard up over the splash
      //             art before the player has asked for it. Same rule, and the
      //             same reason, as the game-over name field in ui.js.
      //   fallback  on that path any keydown starts the run, so handing the
      //             field focus would invite typing that cannot survive its own
      //             first letter. Better to leave the name to the game-over
      //             screen than to eat it here.
      if (!startFallback && !touchPrimary()) nameInput.focus();

      // Read the name off the file instead of hardcoding it, so re-exporting
      // from Rive with a renamed machine doesn't silently fall back to a
      // static first frame.
      const machines = rive.stateMachineNames ?? [];
      if (machines.length) rive.play(machines[0]);
      else rive.play();



      // play() doesn't register until the runtime's next frame, so sampling
      // what's live has to wait one — reading it here reports "nothing
      // playing" even when the machine started fine.
      requestAnimationFrame(() => {
        if (destroyed) return;

        // THE STATE MACHINE'S INPUTS, taken here and not next to the play()
        // above, for exactly the reason this frame is being waited for at all:
        // the machine INSTANCE — which is what owns the inputs — does not
        // exist until the runtime's next frame. Asked for one line after
        // play(), `stateMachineInputs` answers "no state machine inputs" about
        // a file that has two, and the button silently never animates.
        takeInputs(machines);

        onReady?.({
          artboards: rive.contents?.artboards?.map((a) => a.name) ?? [],
          animations: rive.animationNames ?? [],
          stateMachines: machines,
          playingStateMachines: rive.playingStateMachineNames ?? [],
          playingAnimations: rive.playingAnimationNames ?? [],
          playing: rive.isPlaying,
        });
      });
    },
    onLoadError: (err) => {
      destroy('error');
      onError?.(err);
    },
  });

  return {
    destroy,
    // Roll a name into the field, exactly as the artboard's dice button does.
    // Exposed so the feature can be driven — and seen — from a test page or the
    // console before the button exists in the .riv.
    randomize: randomizeName,
    get isDestroyed() { return destroyed; },
    get isPlaying() { return !!rive?.isPlaying; },
    // Escape hatch for driving state-machine inputs from outside — e.g. feeding
    // hover/press from a real DOM button rather than letting Rive hit-test it.
    get rive() { return rive; },
  };
}
