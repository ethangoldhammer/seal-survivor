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
import { SPLASH_ARTBOARD, SPLASH_BINDINGS } from './riveContract.js';
import { loadPlayerName, savePlayerName, sanitizeName, MAX_NAME_LEN } from '../systems/playerName.js';
import { touchPrimary } from '../devices.js';
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
    'position:absolute; inset:0; pointer-events:all; z-index:20; background:#05070d;';

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
  parent.appendChild(wrap);

  let rive = null;
  let destroyed = false;
  // The trigger property, once bound. Held so it can be unsubscribed on the way
  // out: the callback closes over `destroy`, and a Rive instance outliving the
  // splash with a live listener is a run that can be started twice.
  let startTrigger = null;
  let onStartTrigger = null;

  // Rive draws at the canvas's backing-store size, not its CSS size, so a
  // resize that only changes layout leaves the animation rendering at the old
  // resolution until the drawing surface is resynced.
  const onResize = () => rive?.resizeDrawingSurfaceToCanvas();

  function destroy(reason = 'manual') {
    if (destroyed) return;
    destroyed = true;

    window.removeEventListener('resize', onResize);
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

    // Unsubscribed before cleanup(), because the callback's whole job is to
    // call this function and a second arrival would start the run twice.
    if (startTrigger && onStartTrigger) startTrigger.off(onStartTrigger);
    startTrigger = null;
    onStartTrigger = null;

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
  const onSplashPointer = (e) => {
    // First, and before any branch below can end the splash — see onGesture.
    onGesture?.();
    if (startFallback) { dismiss(e); return; }
    if (document.activeElement !== nameInput) nameInput.focus();
  };

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

  const inputListeners = [
    [wrap, 'pointerup', onSplashPointer],
    [window, 'keydown', dismiss],
    [nameInput, 'input', onNameInput],
    [nameInput, 'keydown', onNameKey],
  ];
  for (const [target, type, fn] of inputListeners) target.addEventListener(type, fn);

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

      // A returning player's name, into both the field and the artboard. Read
      // here rather than at mount so it lands after the state machine has had
      // its defaults — a write before the first advance is one the machine can
      // still overwrite.
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
    get isDestroyed() { return destroyed; },
    get isPlaying() { return !!rive?.isPlaying; },
    // Escape hatch for driving state-machine inputs from outside — e.g. feeding
    // hover/press from a real DOM button rather than letting Rive hit-test it.
    get rive() { return rive; },
  };
}
