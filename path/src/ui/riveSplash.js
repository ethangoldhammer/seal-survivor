// A one-shot Rive splash: mounts its own canvas, takes the player's name, and
// tears itself down when the artboard says the run has begun. Deliberately
// standalone — it knows nothing about ui.js or the game loop, so it can be
// tested on its own page before it's wired into the start menu.
//
// ---------------------------------------------------------------------------
// HOW THE NAME GETS IN — THE DICE, AND ONLY THE DICE.
//
// (And, on arrival, the dice rolling itself: a new player's pill flips through
// a reel of names and lands on one rather than showing a placeholder that asks
// for a name nothing here can take. See nameScramble.js and scrambleTo below.)
//
// There is no text field on this screen and no way to type into it. The name
// is a value this module holds (`currentName`), rolled out of sealNames.csv,
// mirrored into `strPlayerName` for the artboard to draw, and banked on the way
// out. The player's whole vocabulary here is the dice button.
//
// This used to be a real invisible <input> stretched over the canvas, because
// Rive cannot capture typing and only a focused field raises a phone keyboard.
// That machinery is gone with the typing: with nothing to type into there is
// nothing to focus, so the keyboard never comes up on a phone, the page never
// scrolls itself to reach a field, and a press on empty water is just a press.
//
// The name still goes through the same sanitiser and the same length limit
// (systems/playerName.js), because the roll can only offer what the leaderboard
// will accept and the artboard must show exactly what gets stored.
//
// The score card's "Next seal" row in ui/ui.js is the surface that still takes
// a typed name; nothing here is the leaderboard's only door.
//
// ---------------------------------------------------------------------------
// HOW THE RUN STARTS, and why it is no longer "any input at all".
//
// This used to dismiss on the first pointerup or keydown anywhere, which the
// old text field made unusable — the first letter of your own name would start
// the game. The artboard decides now, by firing `tStart`, and the game listens.
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
// sealNames.csv (systems/randomName.js), holds it and mirrors it back through
// `strPlayerName`. So the artboard owns the button and nothing else: it does
// not need the vocabulary, the length limit or the leaderboard's sanitiser,
// all of which live on this side.
//
// Roll again and again as far as they like — nothing is written to storage per
// press. Whatever is showing when the splash goes is what gets banked.
//
// AND ONE STEP BACK, because the dice being the only control makes a roll
// irreversible in a way it never was while a name could be typed back in.
// `previousName` walks the history the rolls have built; the game binds it to
// the pad's left shoulder and the right one to the dice (see updateMenuNav in
// ui/ui.js). The artboard has no back button, so on a mouse or a phone the way
// back is to keep rolling.
//
// The trigger is OPTIONAL, unlike `tStart`. An export without it still starts
// a run — so a missing property here is one line in the console and nothing
// else. It costs more than it used to, though: the dice is now the ONLY way to
// change the name on this screen, so an export without the button is a screen
// where a returning player's own name is all they can play as. See
// PENDING_BINDINGS in riveContract.js.
//
// THE ARTBOARD OWNS THE POINTER. `Splash Responsive` (riveContract.js) has
// working listeners on its dice and its Start button — hover, click and press
// all arrive through the view model, measured in the browser — so nothing here
// hit-tests a rectangle any more. The previous artboard's listeners were inert
// and this file carried hand-measured hit boxes for the dice and the field,
// which pointed at empty water the moment anything moved in the editor. Gone.
//
// The wrapper's pointerup survives them both, but only to report the gesture
// (see `onGesture`) and to work the fallback path. It used to hand focus to the
// hidden field as well; there is no field to focus now — see onSplashPointer.
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
// Where the column, the pill and the wordmark are, and how big the column may
// be without sitting on the title. The one copy of the artboard's geometry —
// see ui/splashLayout.js, which the layout checks read too.
import { fitEntryScale, entryRects, estimateRowWidth } from './splashLayout.js';
import { loadPlayerName, savePlayerName, sanitizeName } from '../systems/playerName.js';
// What the dice button spends. Parsed once at module load, out of
// sealNames.csv — see the note above and path/src/sealNameTable.js.
import { randomPlayerName, randomNamePart, splitPlayerName, joinPlayerName } from '../systems/randomName.js';
// Death is permanent — see systems/nameLedger.js.
import { isNameBuried } from '../systems/nameLedger.js';
// The tip jar, on the one screen a player is not busy. Dependency-free by
// design, so importing it here does not cost this module the standalone
// property the header above is built on — see ui/tipJar.js.
import { mountSplashTipJar } from './tipJar.js';
import { mountBuildStamp } from './buildStamp.js';
// The old name boiling out of the pill when the dice rolls — see nameSwap.js.
import { swapWithNoise } from './nameSwap.js';
// The reel of names the pill flips through before the first one lands — see
// nameScramble.js.
import { runNameScramble } from './nameScramble.js';
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
  // How the FIRST name arrives: the pill flips through a run of combinations
  // and settles on one, instead of showing the artboard's placeholder to a
  // player who has no way to type into it. The settings object for
  // ui/nameScramble.js (CONFIG.reveals.nameScramble in the game). Undefined or
  // `enabled: false` puts the starting name up on the first frame.
  nameScramble,
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
  // outlived the splash with a live listener would be rolling names into an
  // artboard that is no longer on the page.
  let randomTrigger = null;
  let onRandomTrigger = null;
  // What the cursor currently says, so it is only rewritten on change.
  let hoverOn = false;
  // The dissolve in flight, if any, so a second roll or the teardown can end it.
  let swap = null;
  // The opening reel, while it runs — see scrambleTo. The dice, the back
  // button and the teardown each cut it short.
  let scramble = null;
  // What the sky shader was last told, per knob, so a slider is written only
  // when it moved; and the timer that watches CONFIG for that.
  const skyWritten = {};
  let skyTimer = 0;
  // The tuner has no change event this module can hear, so the knobs are
  // compared on a slow clock. Eight number compares four times a second is
  // nothing; a rAF loop for it would not be.
  const SKY_POLL_MS = 250;
  // THE NAME, and the whole of the player's say in it. Rolled by the dice,
  // seeded from storage on load, banked on the way out. A plain string rather
  // than an input's `.value` because there is no input — see the note at the
  // top. Sanitised at every write, so this is always something the leaderboard
  // would accept verbatim.
  let currentName = '';

  // EVERY NAME THIS SCREEN HAS SHOWN, oldest first, with `historyAt` marking
  // where the player is standing in it. It exists because the dice is the only
  // control left: without a way back, a name somebody liked is gone the instant
  // their thumb rolls once too often, and there is no field to type it into
  // again. `previousName` walks back through this; the dice walks forward by
  // rolling.
  //
  // Entry 0 is the name they ARRIVED with, when they had one — so the first
  // press of back returns a returning player to their own seal rather than to
  // the game's suggestion.
  //
  // Rolling from partway back TRUNCATES what was in front, the way a browser's
  // history does: the alternative is a right shoulder that sometimes rolls and
  // sometimes replays, which is a button whose meaning depends on something the
  // player cannot see.
  const history = [];
  let historyAt = -1;
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
  //
  // Rarely seen now: a new player's name is rolled on load (see scrambleTo),
  // so the only way to an empty name is a sealNames.csv with nothing usable
  // in it. Kept because that is exactly when a line in Ethan's words beats an
  // 80px stub.
  let placeholder = '';

  // THE ENTRY ROW, for fitEntryRow. The row hugs the name (see `entryScale` in
  // riveContract.js), so its width is a function of the text — and the
  // artboard reports that width back through `numEntryWidth`, measured by its
  // own layout, so nothing here estimates a font. The estimate in
  // splashLayout.js is only for the frame before the first layout has run,
  // when the number reads 0.
  //
  // The entry is a COLUMN — dice above the pill, start below — sat on the
  // bottom edge of a strip 324 tall that hangs 72 off the bottom of the
  // screen. Every number describing it lives in ui/splashLayout.js now, and
  // so does the rule for how big it may be: as big as the pill's width allows,
  // and never so tall that the dice reaches the wordmark. That second rule
  // used to be "no more than 42% of the height", which is not where the
  // wordmark ends: on a laptop at 1280x800, an iPad held sideways or a phone
  // held sideways, the dice sat on the SURVIVOR. The wordmark's real edge is
  // computed from the title slot's fit now, and the same computation is what
  // `npm run test:splashlayout` and the layout audit check against.
  const ENTRY_MARGIN = 24;                          // breathing room at each screen edge
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

  // ---------------------------------------------------------------------------
  // ROTATING THE PHONE, which is the one resize that used to break this.
  //
  // Rive draws at the canvas's BACKING-STORE size, and `resizeDrawingSurfaceToCanvas`
  // reads the element's CSS box AT CALL TIME — under Fit.Layout it also sets the
  // artboard's width and height from that box, which is what makes the layout
  // reflow. So the whole question is WHEN the box is right.
  //
  // A `resize` listener is not the answer on a phone. Both `resize` and
  // `orientationchange` fire BEFORE the browser has reflowed to the new
  // orientation, so the box read there is the old one: the artboard keeps its
  // portrait dimensions, the backing store is the wrong shape, and the picture
  // is stretched across the new screen. Nothing fires afterwards to correct it,
  // which is why it stayed stretched until the splash was dismissed.
  //
  // A ResizeObserver is: it reports the element's box AFTER layout, once per
  // change, and it sees changes the window never announces at all — the URL bar
  // collapsing, a software keyboard opening under the name field, the pane the
  // look page runs in. The window events stay as a belt-and-braces nudge for the
  // rare browser whose observer misses a rotation, and cost nothing because the
  // work below no-ops when the box has not moved.
  // ---------------------------------------------------------------------------

  // The box the drawing surface was last built for. Compared before rebuilding,
  // because resizeDrawingSurfaceToCanvas reallocates the backing store and
  // re-lays the artboard out — cheap once, wasteful sixty times a second.
  let sizedW = 0;
  let sizedH = 0;
  let sizePending = 0;

  /**
   * Rebuild the drawing surface for the canvas's current CSS box, if it moved.
   *
   * A zero box is IGNORED rather than applied: an element that is display:none,
   * or measured before its first layout, reports 0×0, and handing that to Rive
   * sets a 0×0 backing store the canvas never recovers from on its own.
   */
  function applyCanvasSize(force = false) {
    if (destroyed || !rive) return;
    const w = Math.round(canvas.clientWidth);
    const h = Math.round(canvas.clientHeight);
    if (!(w > 0 && h > 0)) return;
    if (!force && w === sizedW && h === sizedH) return;
    sizedW = w;
    sizedH = h;
    rive.resizeDrawingSurfaceToCanvas();
    // The row's scale is a function of the canvas width, so it has to be
    // recomputed for the new one — see fitEntryRow.
    fitEntryRow();
  }

  // Coalesce a burst of changes into one rebuild on the next frame. A rotation
  // can deliver an observer callback, a resize event and an orientationchange
  // within the same frame; all three want the same single rebuild.
  function scheduleCanvasSize() {
    if (destroyed || sizePending) return;
    sizePending = requestAnimationFrame(() => {
      sizePending = 0;
      applyCanvasSize();
    });
  }

  // WHAT THE WINDOW EVENTS ADD, given the observer already covers the box: a
  // rotation on iOS settles over several frames, and the FIRST post-rotation
  // layout is sometimes still the interim one. These re-check on a short ladder
  // so a box that lands late is still caught; each pass is a no-op unless it
  // actually moved.
  const RESETTLE_MS = [0, 60, 180, 400];
  let resettleTimers = [];
  function resettleAfterRotation() {
    for (const t of resettleTimers) clearTimeout(t);
    resettleTimers = RESETTLE_MS.map((ms) => setTimeout(() => {
      if (!destroyed) applyCanvasSize();
    }, ms));
  }
  const onResize = () => { scheduleCanvasSize(); resettleAfterRotation(); };

  // The observer is the primary signal — see the note above. Held so it can be
  // disconnected: an observer outliving the splash keeps the canvas, the
  // wrapper and this whole closure alive.
  let sizeObserver = null;

  function destroy(reason = 'manual') {
    if (destroyed) return;
    destroyed = true;

    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    sizeObserver?.disconnect();
    sizeObserver = null;
    if (sizePending) cancelAnimationFrame(sizePending);
    sizePending = 0;
    for (const t of resettleTimers) clearTimeout(t);
    resettleTimers = [];
    clearTimeout(entrySettleTimer);
    clearInterval(skyTimer);
    for (const [target, type, fn] of inputListeners) target.removeEventListener(type, fn);
    // A reel still spinning stops where it is: the name on screen is the one
    // banked below, which is the one the player pressed Start over.
    scramble?.cancel();
    scramble = null;

    // THE NAME IS BANKED ON THE WAY OUT, whatever ended the splash. Not per
    // roll: savePlayerName writes to localStorage, and a player thumbing the
    // dice a dozen times would be a dozen synchronous storage writes for names
    // they are in the middle of rejecting.
    //
    // A blank is ignored by savePlayerName rather than clearing, so leaving the
    // splash without touching the dice does not erase the name already on file.
    savePlayerName(currentName);
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

  // WHAT A PRESS ON THE SPLASH MEANS: a gesture, and on the fallback path a
  // dismiss. Nothing else. The artboard decides the buttons — its dice fires
  // `tRandomizeName` on click, its Start fires `tStart` on pointer DOWN — and
  // a press anywhere else is a press on empty water.
  //
  // This handler used to hand focus to the hidden name field, which was the
  // only way to raise a phone keyboard. With the typing gone that branch went
  // with it, and so did its cost: a tap into open ocean no longer throws a
  // keyboard up over the art.
  //
  // onGesture runs FIRST, before any branch below can end the splash — see the
  // option's own note for why the gesture has to be reported from here.
  const onSplashPointer = (e) => {
    onGesture?.();
    if (startFallback) dismiss(e);
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

  // THE KEYBOARD, such as it is: two keys, neither of which enters a character.
  //
  //   space   roll a name, exactly as the artboard's dice does
  //   enter   start the run, exactly as the artboard's Start button does
  //
  // Both are unconditional now. Space used to have to decide whether it was a
  // dice or a space — names have spaces in them ("Whiskered Lenny") and a key
  // that eats one mid-word is a field nobody can type into — and with no field
  // there is no other thing space could mean.
  //
  // On window rather than on an element, because nothing on this screen holds
  // focus. A text entry anywhere on the page is still respected: the tip sheet
  // is DOM over the splash and could grow one.
  const onWindowKey = (e) => {
    if (destroyed || isTextEntry(e.target)) return;
    if (e.key === ' ') {
      e.preventDefault();
      onGesture?.();
      randomizeName();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    onGesture?.();
    destroy('enter');
  };

  function isTextEntry(el) {
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

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
  ];
  for (const [target, type, fn] of inputListeners) target.addEventListener(type, fn);

  // Push the current text at the artboard. A no-op until the view model is
  // bound, which is what makes it safe to call before the file has finished
  // parsing — a dice press beats a 1.7MB load.
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
      if (!(rowW > 0)) rowW = estimateRowWidth(currentName || placeholder);
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      if (!(W > 2 * ENTRY_MARGIN) || !(H > 0)) return;
      const s = fitEntryScale({ W, H, rowW, margin: ENTRY_MARGIN });
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
  // (the pill's own width, the scale last written) and the column's geometry
  // in ui/splashLayout.js — the same numbers the fit above and the layout
  // checks use, so the dissolve and the overlap rule cannot disagree about
  // where the pill is.
  function pillRect() {
    const vmi = rive?.viewModelInstance;
    if (!vmi) return null;
    let w = 0; let s = 1;
    try {
      w = vmi.number(SPLASH_BINDINGS.entryWidth)?.value ?? 0;
      s = vmi.number(SPLASH_BINDINGS.entryScale)?.value ?? 1;
    } catch { return null; }
    if (!(s > 0) || !(w > 2)) return null;
    const rects = entryRects(canvas.clientWidth, canvas.clientHeight, s, w);
    const p = rects.pill;
    return { x: p.left, y: p.top, w, h: p.bottom - p.top, radius: rects.pillRadius };
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
      // loss is seeing the roll land on the artboard.
      console.warn(`[riveSplash] could not write ${SPLASH_BINDINGS.name} —`, err?.message ?? err);
    }
  }

  // THE DICE, and the only way a name changes on this screen. Rolls one, holds
  // it, mirrors it to the artboard — and hands it back, so a caller driving
  // this by hand can see what landed.
  //
  // The current value is passed as `avoid`: a randomise button that returns the
  // name already on screen reads as a button that did nothing, and with a
  // couple of dozen parts that happens often enough to notice.
  //
  // Sanitised even though the table is: sealNames.csv is checked on load
  // (sealNameTable.js) but this is the one place a name reaches storage from,
  // and a door that trusts its own side of the wall is a door that stops being
  // checked. It also means `currentName` is what the leaderboard would keep,
  // character for character, at every moment rather than only on the way out.
  //
  // NOT SAVED HERE. destroy() banks whatever is showing on the way out — so
  // rolling through six names leaves exactly one write to storage, and backing
  // out of the splash never files you under a name you rejected.
  function randomizeName() {
    if (destroyed) return '';
    // A press mid-reel is the player taking over: the reel stops and the dice
    // rolls from whatever it was showing.
    scramble?.cancel();
    scramble = null;
    const name = sanitizeName(randomPlayerName(currentName));
    // Anything the player had walked back past is dropped here — see `history`.
    history.length = historyAt + 1;
    history.push(name);
    historyAt = history.length - 1;
    showName(name);
    return name;
  }

  /**
   * BACK ONE NAME — the left shoulder's half of the dice.
   *
   * Nothing to go back to is a no-op rather than a wrap-around to the end: a
   * button that silently jumps to the far end of a list the player cannot see
   * is worse than one that does nothing, and the pill standing still says "that
   * was the first one" clearly enough.
   *
   * Never rolls. This is the one thing on the screen that is guaranteed to hand
   * back a name they have already seen, which is the whole reason it exists.
   */
  function previousName() {
    if (destroyed || historyAt <= 0) return currentName;
    scramble?.cancel();
    scramble = null;
    historyAt -= 1;
    showName(history[historyAt]);
    return currentName;
  }

  // Put a name up: photograph the old one first (the dissolve reads the last
  // drawn frame — see beginNameSwap), then hold it and mirror it.
  function showName(name) {
    if (name !== currentName) beginNameSwap();
    currentName = name;
    writeName(name);
  }

  // THE OPENING REELS. Flips the pill's two halves — the adjective and the
  // nickname, each out of its own hat — on their own clocks, the adjective
  // settling first, and lands on `landing`; see nameScramble.js for the shape
  // of it. Each interim flip is a hard cut and is HELD as currentName while it
  // shows: a player who presses Start mid-reel starts as the seal they saw,
  // not the one the reels were on their way to, and rolling the dice mid-reel
  // rolls away from what is showing. The landing goes through showName so the
  // last word gets the dissolve.
  //
  // The landing is split against the table so each reel knows its half. A
  // hand-written whole name, or a bare nickname, has no adjective half: that
  // reel flips through adjectives and settles on nothing, which reads as the
  // front hat coming up empty — true, as it happens.
  //
  // The landing enters the history when it lands, and only if the history is
  // empty: for a new player it is the first name they can go back to; for a
  // returning player (`always`) entry 0 is already their own seal and the
  // reel is landing on it.
  function scrambleTo(landing) {
    scramble?.cancel();
    const halves = splitPlayerName(landing);
    scramble = runNameScramble({
      reels: [
        {
          landing: halves.adjective,
          stop: nameScramble?.adjectiveStop,
          // Drawn to fit beside whatever nickname is showing, so no interim
          // pair is ever longer than the field.
          roll: (_previous, values) => randomNamePart('adjective', { beside: values[1] }),
        },
        {
          landing: halves.nickname,
          stop: 1,
          roll: () => randomNamePart('nickname'),
        },
      ],
      join: ([adjective, nickname]) => sanitizeName(joinPlayerName(adjective, nickname)),
      show: (name) => {
        if (destroyed) return;
        currentName = name;
        writeName(name);
      },
      land: () => {
        scramble = null;
        if (destroyed) return;
        // The landing as it was rolled, not as the halves re-join: a name
        // that did not split (a written one, a lineage) round-trips anyway,
        // and this is the string the leaderboard already accepted.
        showName(landing);
        if (!history.length) { history.push(landing); historyAt = 0; }
      },
      opts: nameScramble,
    });
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
      applyCanvasSize(true);
      // See the note on rotation above: the observer is the one that fires
      // AFTER layout, the window events are the nudge for what it misses.
      if (typeof ResizeObserver === 'function') {
        sizeObserver = new ResizeObserver(scheduleCanvasSize);
        sizeObserver.observe(canvas);
      }
      window.addEventListener('resize', onResize);
      window.addEventListener('orientationchange', onResize);

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
          + 'the splash still starts a run, there is just no way to roll a name on it.',
        );
      }

      // A returning player's name, onto the artboard. Read here rather than at
      // mount so it lands after the state machine has had its defaults — a
      // write before the first advance is one the machine can still overwrite.
      // A RETURNING PLAYER MAY BE RETURNING AS A DEAD SEAL. The score card names
      // the next one on the way out of a run (see offerNextSeal in ui/ui.js),
      // but a player who closes the tab on the game-over screen never gets
      // there — and the name still in storage belongs to a seal with a
      // headstone. Rolled fresh here rather than shown and refused later: the
      // splash is the last surface between that saved name and a run being
      // played by somebody the ledger says is buried.
      //
      // Saved immediately rather than only held here, because a player who
      // presses Play without touching the dice would otherwise start under the
      // buried name again.
      const remembered = loadPlayerName();
      if (remembered && isNameBuried(remembered)) savePlayerName(randomPlayerName(remembered));
      currentName = loadPlayerName();
      // Entry 0 of the history, so a returning player can roll and still get
      // back to their own seal. A player with no name on file starts with an
      // empty history; the reel below fills entry 0 with the name it lands
      // on, which is the first name they were actually given.
      if (currentName) { history.push(currentName); historyAt = 0; }
      // A NEW PLAYER'S FIRST NAME IS ROLLED, NOT ASKED FOR. There is nothing
      // on this screen to type into, so the placeholder that used to sit in
      // the pill was a question with no way to answer it. The reel
      // (scrambleTo, below) flips through the table and lands on this one; a
      // returning player keeps what is on file and skips the reel unless
      // `always` asks for it.
      const arrived = !!currentName;
      const landing = currentName || sanitizeName(randomPlayerName(''));
      const reel = !!nameScramble && nameScramble.enabled !== false
        && (!arrived || nameScramble.always === true);
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
      if (reel) scrambleTo(landing);
      else {
        currentName = landing;
        if (!history.length) { history.push(landing); historyAt = 0; }
        writeName(landing);
      }
      syncSkyFx();
      if (skyFx) skyTimer = setInterval(syncSkyFx, SKY_POLL_MS);

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
    // Roll a name, exactly as the artboard's dice button does. Exposed so the
    // feature can be driven — and seen — from a test page or the console before
    // the button exists in the .riv.
    randomize: randomizeName,
    // Back one name. The pad's left shoulder is the only thing that calls this
    // in the game (see updateMenuNav in ui/ui.js) — the artboard has no back
    // button, so this is the whole of the feature on any other device.
    previous: previousName,
    // What the pill is showing. For a harness, and for a caller that wants to
    // know what it would be banking.
    get name() { return currentName; },
    // Whether the opening reel is still flipping — for a harness that wants to
    // wait for it to land before reading `name`.
    get isScrambling() { return !!scramble; },
    get isDestroyed() { return destroyed; },
    get isPlaying() { return !!rive?.isPlaying; },
    // Escape hatch for driving state-machine inputs from outside — e.g. feeding
    // hover/press from a real DOM button rather than letting Rive hit-test it.
    get rive() { return rive; },
  };
}
