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
// THE ARTBOARD OWNS THE POINTER. `Splash Responsive` (riveContract.js) has
// working listeners on its dice and its Start button — hover, click and press
// all arrive through the view model, measured in the browser — so nothing here
// hit-tests a rectangle any more. The previous artboard's listeners were inert
// and this file carried hand-measured hit boxes for the dice and the field,
// which pointed at empty water the moment anything moved in the editor. Gone.
//
// One thing the artboard cannot do is raise the phone keyboard: only a focus()
// call inside a real gesture handler does that. So the wrapper's pointerup
// still exists, and its whole job is to hand focus to the hidden field when the
// press was not on a button — see onSplashPointer.
//
// ---------------------------------------------------------------------------
// THERE IS STILL A WAY OUT WITHOUT THE TRIGGER, and it is not politeness. If a
// .riv is ever exported without `tStart` — renamed in the editor, or an older
// file dropped in — then a splash that only listens for it is a game nobody can
// start, on every device, with nothing in the console. `startFallback` keeps
// the old behaviour alive for exactly that case and for nothing else.
// ---------------------------------------------------------------------------

// THE WEBGL2 PACKAGE, not the canvas one the boss bar and polaroid use. The
// splash is the surface with feathers in it — the wordmark's shadows, the
// buttons' hover lift — and only the Rive Renderer draws a feather soft; the
// Canvas2D renderer draws it as a hard offset copy. Same JavaScript API, its
// own WASM. See riveRuntimeGl.js.
import { Rive, Layout, Fit, Alignment } from '@rive-app/webgl2';
// Points the runtime at our own copy of its WASM instead of unpkg. Imported for
// the side effect, and it has to happen before any Rive instance exists — see
// riveRuntimeGl.js.
import './riveRuntimeGl.js';
import { SPLASH_ARTBOARD, SPLASH_STATE_MACHINE, SPLASH_BINDINGS, SKY_FX_BINDINGS } from './riveContract.js';
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
import { mountBuildStamp } from './buildStamp.js';
// The old name boiling out of the pill when the dice rolls — see nameSwap.js.
import { swapWithNoise } from './nameSwap.js';
import { parseTipCsv } from '../tipTable.js';
import tipsCsv from '../tips.csv?raw';

// The same tiers the other two jars show. Parsed here rather than passed in
// because this module is written to know nothing about ui.js — see its header.
const TIP_TIERS = parseTipCsv(tipsCsv);
// ?url so Vite emits the .riv as a hashed asset and hands back a path. The
// alternative — base64 in a JS module, the way levelUpImages.js does it —
// would push 644KB of binary through the module graph on every reload.
import splashUrl from './seal_survivor.riv?url';


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
  // How the OLD name leaves the pill when the dice rolls a new one: the
  // settings object for ui/nameSwap.js (CONFIG.reveals.nameSwap in the game).
  // Undefined or `enabled: false` means the text simply changes. Only the dice
  // does this — a typed keystroke is the player watching their own letters
  // land, and a dissolve per keystroke would be noise over the thing they are
  // looking at.
  nameSwap,
  // THE SKY SHADER'S KNOBS — CONFIG.splashSky in the game, by reference so the
  // tuner's sliders reach a splash that is already up. Each field is written to
  // the view-model number of the same name in SKY_FX_BINDINGS when it changes.
  // Undefined leaves the artboard's own defaults alone.
  skyFx,
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

  // WHICH BUILD THIS IS. Last child of the wrap, so it paints over the
  // artboard without a z-index fight, and it leaves with the splash because it
  // is inside the thing that gets removed. See ui/buildStamp.js.
  mountBuildStamp(wrap);

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
  // What the cursor currently says, so it is only rewritten on change.
  let hoverOn = false;
  // The dissolve in flight, if any, so a second roll or the teardown can end it.
  let swap = null;
  // What the sky shader was last told, per knob, so a slider is written only
  // when it moved; and the timer that watches CONFIG for that.
  const skyWritten = {};
  let skyTimer = 0;
  // The tuner has no change event this module can hear, so the knobs are
  // compared on a slow clock. Eight number compares four times a second is
  // nothing; a rAF loop for it would not be.
  const SKY_POLL_MS = 250;
  // The last name the dice put in the field. SPACE rolls a new name, but only
  // while the field holds a rolled name or nothing — the moment the player has
  // typed something of their own, space is a space again, because names have
  // spaces in them ("Whiskered Lenny") and a key that eats them mid-word is a
  // field that cannot be typed into.
  let lastRolled = '';
  // The artboard's own report of the row's width, subscribed so the centring
  // in fitEntryRowNow follows the pill while it interpolates to a new name.
  let widthProp = null;
  let onWidth = null;
  // WHAT THE FIELD SHOWS WHEN THE NAME IS EMPTY: the artboard's own default
  // for `strPlayerName`, read off the view model before the first write. The
  // name pill hugs its text now (see riveContract.js), so an empty string is
  // not an empty box but an 80px stub with nothing in it — and the line that
  // belongs there is already in the file, in Ethan's words, as the instance
  // default. Read, never written here.
  let placeholder = '';

  // THE ENTRY ROW, for fitEntryRow. The row hugs the name (see `entryScale` in
  // riveContract.js), so its width is a function of the text — and the
  // artboard reports that width back through `numEntryWidth`, measured by its
  // own layout, so nothing here estimates a font. The fallback below is only
  // for the frame before the first layout has run, when the number reads 0:
  // Playfair Display SC at 84px is about 50px a character in small caps.
  // The entry is a COLUMN now — dice above the pill, start below — so the
  // only width that matters is the pill's: its text plus 40px of padding a
  // side. The strip it is centred in is 324 tall (80 + 16 + 132 + 16 + 80) and
  // anchored to the bottom of the screen, so a 16:9 window does not lose the
  // start button off the bottom edge.
  const ENTRY_FIXED_W = 2 * 40;                     // the pill's padding
  const ENTRY_PER_CHAR = 52;
  const ENTRY_STRIP_H = 324;                        // the strip's design height
  const ENTRY_STRIP_BOTTOM = 72;                    // px between the strip and the bottom edge: room for the tip jar
  // The column may not climb past this fraction of the screen's height, or on
  // a phone held sideways it sits on the wordmark. Width alone fits the pill;
  // height is what a 393px-tall screen runs out of.
  const ENTRY_MAX_HEIGHT_FRAC = 0.42;
  const ENTRY_PILL_H = 132;                         // the pill's design height
  const ENTRY_PILL_TOP = 80 + 16;                   // dice and gap above the pill
  const ENTRY_MARGIN = 24;                          // breathing room at each screen edge
  const ENTRY_MIN_SCALE = 0.3;
  // The row's width is re-read after every change the artboard reports, but
  // while the pill is INTERPOLATING to a new name the width is mid-way, and a
  // scale computed from a mid-way width is wrong twice — once on the way and
  // once back. So the number is only recomputed once the width has held still
  // for this long, which is longer than one frame and shorter than the eye.
  const ENTRY_SETTLE_MS = 120;
  // The scale last written, so the row's design width can be recovered from
  // the width the artboard reports at that scale (everything in the row scales
  // with the same number, so width / scale is the width at 1).
  let entryScale = 1;
  let entrySettleTimer = 0;

  // Rive draws at the canvas's backing-store size, not its CSS size, so a
  // resize that only changes layout leaves the animation rendering at the old
  // resolution until the drawing surface is resynced.
  const onResize = () => { rive?.resizeDrawingSurfaceToCanvas(); fitEntryRow(); };

  function destroy(reason = 'manual') {
    if (destroyed) return;
    destroyed = true;

    window.removeEventListener('resize', onResize);
    clearTimeout(entrySettleTimer);
    clearInterval(skyTimer);
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
    if (widthProp && onWidth) { try { widthProp.off(onWidth); } catch { /* gone with the file */ } }
    widthProp = null;
    onWidth = null;
    swap?.cancel();
    swap = null;

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
  // WHAT A PRESS ON THE SPLASH MEANS. The artboard decides the buttons — its
  // dice fires `tRandomizeName` on click, its Start fires `tStart` on pointer
  // DOWN — and the one thing left to this side is focus:
  //
  //   the field, or anywhere that is not a button   focus the name field
  //
  // Anywhere-that-is-not-a-button rather than the field's own rectangle,
  // because the field's rectangle is a layout the runtime computes and does
  // not expose, and a phone needs focus() inside THIS gesture handler to raise
  // its keyboard. The cost is a keyboard on a tap into empty water, which is a
  // player reaching for the field and missing.
  //
  // Start is on pointer DOWN in the artboard for exactly this handler's sake:
  // `tStart` reaches `.on()` from inside Rive's next advance, one frame after
  // the press, which is well before the release — so by the time this pointerup
  // arrives destroy() has run and nothing here fires. A press on Start never
  // focuses the field, and a phone never flashes its keyboard over the first
  // frame of the run.
  //
  // A button is told apart by asking the artboard: its own enter listeners
  // have set `bRandomHover` / `bStartHover` by the time the release arrives (a
  // tap is a pointerdown over the button, which is an enter). A read of the
  // view model is synchronous, so this is the same gesture and the same call
  // stack.
  const onSplashPointer = (e) => {
    // First, and before any branch below can end the splash — see onGesture.
    onGesture?.();
    if (startFallback) { dismiss(e); return; }
    if (destroyed) return;
    if (overButton()) return;
    if (document.activeElement !== nameInput) nameInput.focus();
  };

  // Is the pointer over the dice or the Start button, as far as the ARTBOARD
  // is concerned? Its own hover listeners keep these booleans; the game only
  // reads them. False for an export without the property, which is a splash
  // without that button.
  function overButton() {
    const vmi = rive?.viewModelInstance;
    if (!vmi) return false;
    for (const prop of [SPLASH_BINDINGS.hover, SPLASH_BINDINGS.startHover]) {
      try { if (vmi.boolean(prop)?.value) return true; } catch { /* not in this export */ }
    }
    return false;
  }

  // THE CURSOR, because a thing that lights up under the pointer and does not
  // become a hand still does not read as a button. The lit state itself is the
  // artboard's own transition off `bRandomHover`; this only follows it. A frame
  // behind, since the listener writes during Rive's advance, and nobody can see
  // a frame.
  function syncCursor(on) {
    if (hoverOn === on) return;
    hoverOn = on;
    canvas.style.cursor = on ? 'pointer' : '';
  }

  // Enter starts the run from the keyboard, on both paths. It is what the
  // return key means in a form, it is what `enterkeyhint="go"` has promised the
  // phone keyboard, and it costs a player who is already typing a reach for the
  // mouse. Not a general keydown — only this one key, and only from the field.
  const onNameKey = (e) => {
    onGesture?.();
    if (e.key === ' ' && spaceRolls()) {
      e.preventDefault();
      randomizeName();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    destroy('enter');
  };

  // Is space the dice right now? See `lastRolled`.
  function spaceRolls() {
    const v = nameInput.value;
    return v === '' || v === lastRolled;
  }

  // SPACE FROM ANYWHERE ON THE PAGE. The field normally holds focus on a
  // desktop, so this is for the moments it does not — the tip jar was clicked,
  // the page was clicked outside the wrapper — and for the same rule.
  const onWindowKey = (e) => {
    if (e.key !== ' ' || e.target === nameInput || destroyed) return;
    if (isTextEntry(e.target)) return;
    if (!spaceRolls()) return;
    e.preventDefault();
    randomizeName();
  };

  function isTextEntry(el) {
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

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
    if (!destroyed) syncCursor(overButton());
    onPointer?.(e.clientX, e.clientY);
  };

  // The pointer leaving the window entirely produces no move inside it, so
  // without this the hand stays up after the cursor is gone.
  const onSplashLeave = () => syncCursor(false);

  const inputListeners = [
    [wrap, 'pointermove', onSplashMove],
    [wrap, 'pointerleave', onSplashLeave],
    [wrap, 'pointerup', onSplashPointer],
    [window, 'keydown', dismiss],
    [window, 'keydown', onWindowKey],
    [nameInput, 'input', onNameInput],
    [nameInput, 'keydown', onNameKey],
  ];
  for (const [target, type, fn] of inputListeners) target.addEventListener(type, fn);

  // Push the current text at the artboard. A no-op until the view model is
  // bound, which is what makes it safe to call from the input handler before
  // the file has finished loading — a fast typist beats a 1.7MB parse.
  // SHRINK THE ROW TO THE SCREEN. Written on every name change and every
  // resize, because both move the answer: the row is as wide as the name, and
  // the screen is as wide as the phone is being held. 1 on any screen that fits
  // the row at design size, which is every desktop.
  //
  // Written a frame LATE on purpose: a name change reflows the row inside
  // Rive's next advance, and the width bound out of it is the width of the
  // previous frame's text until then. The rAF here lands after that advance.
  function fitEntryRow() {
    clearTimeout(entrySettleTimer);
    entrySettleTimer = setTimeout(fitEntryRowNow, ENTRY_SETTLE_MS);
  }

  function fitEntryRowNow() {
    if (destroyed) return;
    try {
      const vmi = rive?.viewModelInstance;
      const scaleProp = vmi?.number(SPLASH_BINDINGS.entryScale);
      if (!scaleProp) return;
      // The pill's width at scale 1, recovered from what the artboard reports
      // at the scale last written. Estimated from the text only before the first
      // layout has run.
      let rowW = 0;
      try { rowW = (vmi.number(SPLASH_BINDINGS.entryWidth)?.value ?? 0) / (entryScale || 1); } catch { rowW = 0; }
      if (!(rowW > 0)) rowW = ENTRY_FIXED_W + (nameInput.value || placeholder).length * ENTRY_PER_CHAR;
      const avail = canvas.clientWidth - 2 * ENTRY_MARGIN;
      if (!(avail > 0)) return;
      const byWidth = avail / rowW;
      const byHeight = (canvas.clientHeight * ENTRY_MAX_HEIGHT_FRAC) / ENTRY_STRIP_H;
      const s = Math.max(ENTRY_MIN_SCALE, Math.min(1, byWidth, byHeight));
      // Written on a real change only: every write re-lays the row out, and the
      // layout engine would happily animate a 0.3% correction on every frame.
      if (Math.abs(s - entryScale) < 0.005) return;
      entryScale = s;
      scaleProp.value = s;
    } catch { /* an export without the number keeps its design size */ }
  }

  // PUSH THE SKY KNOBS AT THE ARTBOARD, changed ones only. Safe on an export
  // without the shader: the number simply is not there and the write is
  // skipped. See SKY_FX_BINDINGS.
  function syncSkyFx() {
    if (!skyFx || destroyed) return;
    const vmi = rive?.viewModelInstance;
    if (!vmi) return;
    for (const [knob, prop] of Object.entries(SKY_FX_BINDINGS)) {
      const v = Number(skyFx[knob]);
      if (!Number.isFinite(v) || skyWritten[knob] === v) continue;
      try {
        const p = vmi.number(prop);
        if (p) { p.value = v; skyWritten[knob] = v; }
      } catch { /* not in this export */ }
    }
  }

  // WHERE THE PILL IS, in CSS px of the canvas, from what the artboard reports
  // (the pill's own width) and the entry's design: a column of dice, pill and
  // start, centred both ways in a strip 324 tall whose top sits at 65% of the
  // artboard, the pill 96 down from the column's top at scale 1. The one place
  // those numbers are repeated outside the .riv; if the column is redesigned
  // in the editor this is the line to revisit.
  function pillRect() {
    const vmi = rive?.viewModelInstance;
    if (!vmi) return null;
    let w = 0; let s = 1;
    try {
      w = vmi.number(SPLASH_BINDINGS.entryWidth)?.value ?? 0;
      s = vmi.number(SPLASH_BINDINGS.entryScale)?.value ?? 1;
    } catch { return null; }
    if (!(s > 0) || !(w > 2)) return null;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    // The strip hangs a fixed 72px off the bottom of the artboard, so its top
    // is the height less that gap less its own 324.
    // The column sits on the strip's BOTTOM edge (not centred in it), so a
    // shrunken column stays as low as it can and clear of the wordmark.
    const stripBottom = H - ENTRY_STRIP_BOTTOM;
    return {
      x: (W - w) / 2,
      y: stripBottom - ENTRY_STRIP_H * s + ENTRY_PILL_TOP * s,
      w,
      h: ENTRY_PILL_H * s,
      radius: 29 * s,
    };
  }

  // Photograph the pill as it is and start it boiling away. Called by the dice
  // BEFORE the new name is written, while the canvas still shows the old one.
  function beginNameSwap() {
    if (!nameSwap || nameSwap.enabled === false || destroyed || !rive) return;
    const rect = pillRect();
    if (!rect) return;
    swap?.cancel();
    // Reads the LAST DRAWN frame, which still shows the old name — possible
    // only because the context below was created with preserveDrawingBuffer.
    swap = swapWithNoise({ wrap, source: canvas, rect, radius: rect.radius, opts: nameSwap });
  }

  function writeName(value) {
    fitEntryRow();
    try {
      const prop = rive?.viewModelInstance?.string(SPLASH_BINDINGS.name);
      if (prop) prop.value = value || placeholder;
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
    // The old name has to be photographed before it is overwritten.
    if (name !== nameInput.value) beginNameSwap();
    nameInput.value = name;
    lastRolled = name;
    writeName(name);
    return name;
  }

  // THE CONTEXT IS OURS FIRST. The WebGL2 runtime calls getContext('webgl2')
  // with preserveDrawingBuffer OFF, and a WebGL canvas whose buffer is not
  // preserved is blank to drawImage the moment the browser has composited the
  // frame — which is every moment the name swap (nameSwap.js) wants to
  // photograph the pill, since it runs from inside Rive's own advance, before
  // this frame is drawn and after the last one was shown. getContext hands back
  // the FIRST context made on a canvas, attributes and all, so asking here with
  // the buffer preserved is what the runtime then draws into. The other
  // attributes match the runtime's own request so nothing about the surface
  // differs. `drawFrame()` was tried instead and does nothing while the frame
  // loop has a request pending, which is always.
  try {
    canvas.getContext('webgl2', {
      alpha: true, depth: true, stencil: true, antialias: true,
      premultipliedAlpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance',
    });
  } catch { /* no WebGL2: the runtime will say so itself via onLoadError */ }

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
    // NAMED HERE, NOT ONLY IN play() BELOW. `autoBind` binds the view model to
    // the state machines that exist at load; a machine first instanced by a
    // later play() is never bound, its listeners write into nothing, and the
    // artboard's own buttons go dead with no error anywhere. That is exactly
    // what the previous artboard's "inert listeners" were. See
    // SPLASH_STATE_MACHINE in riveContract.js for the measurement.
    stateMachines: SPLASH_STATE_MACHINE,
    // GPU CANVAS, and it can only be asked for HERE. The sky band is painted by
    // a WGSL shader (splash/SkyScanlines) that a Rive node script renders into a
    // GPU canvas, and `context:gpuCanvas()` throws "requires a RenderContext"
    // unless the file was IMPORTED in deferred mode — the runtime fixes the mode
    // at import and warns rather than switching if the flag arrives later. The
    // cost of asking on a file that has no shader is nothing; the cost of not
    // asking is a sky that renders flat with three errors in the console.
    enableGPUCanvas: true,
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
    // LAYOUT, not Contain. The artboard is built from percentage slots and
    // leaf components, so the runtime sizes it to the canvas and it reflows —
    // no letterbox in portrait, no bars on an ultrawide. See riveContract.js.
    layout: new Layout({ fit: Fit.Layout, alignment: Alignment.Center }),
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
        onRandomTrigger = () => randomizeName();
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
      // The file's default for the name, before anything overwrites it — see
      // `placeholder` above. A file with no default shows an empty pill, which
      // is what it showed before.
      try { placeholder = rive.viewModelInstance?.string(SPLASH_BINDINGS.name)?.value ?? ''; } catch { placeholder = ''; }
      // Re-fit whenever the artboard reports a new row width — a new name, a
      // new scale landing — once it has settled; see ENTRY_SETTLE_MS.
      try {
        widthProp = rive.viewModelInstance?.number(SPLASH_BINDINGS.entryWidth) ?? null;
        if (widthProp) { onWidth = () => fitEntryRow(); widthProp.on(onWidth); }
      } catch { widthProp = null; }
      writeName(nameInput.value);
      syncSkyFx();
      if (skyFx) skyTimer = setInterval(syncSkyFx, SKY_POLL_MS);

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
