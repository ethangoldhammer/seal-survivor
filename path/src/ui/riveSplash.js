// A one-shot Rive splash: mounts its own canvas, plays, and tears itself down
// on the first user input. Deliberately standalone — it knows nothing about
// ui.js or the game loop, so it can be tested on its own page before it's
// wired into the start menu.

import { Rive, Layout, Fit, Alignment } from '@rive-app/canvas';
// ?url so Vite emits the .riv as a hashed asset and hands back a path. The
// alternative — base64 in a JS module, the way levelUpImages.js does it —
// would push 644KB of binary through the module graph on every reload.
import splashUrl from './seal_survivor.riv?url';

export function mountRiveSplash({
  parent = document.body,
  onReady,
  onError,
  onDismiss,
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
  parent.appendChild(wrap);

  let rive = null;
  let destroyed = false;

  // Rive draws at the canvas's backing-store size, not its CSS size, so a
  // resize that only changes layout leaves the animation rendering at the old
  // resolution until the drawing surface is resynced.
  const onResize = () => rive?.resizeDrawingSurfaceToCanvas();

  function destroy(reason = 'manual') {
    if (destroyed) return;
    destroyed = true;

    window.removeEventListener('resize', onResize);
    for (const [target, type, fn] of inputListeners) target.removeEventListener(type, fn);

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

  // Any of these count as "the player is ready to move on".
  //
  // pointerUP, not pointerdown: tearing the wrapper out on pointerdown leaves
  // the rest of that same physical click to land on whatever is underneath —
  // which is the start menu's "Start run" button. Waiting for the release
  // keeps the whole gesture on the splash.
  const dismiss = (e) => destroy(e.type);
  const inputListeners = [
    [wrap, 'pointerup', dismiss],
    [window, 'keydown', dismiss],
  ];
  for (const [target, type, fn] of inputListeners) target.addEventListener(type, fn);

  rive = new Rive({
    src: splashUrl,
    canvas,
    // autoplay would start the artboard's FIRST TIMELINE. This file has three
    // of them plus a state machine, and the state machine is what sequences
    // them — so play it explicitly once the names are known, rather than
    // whichever timeline happens to sit at index 0.
    autoplay: false,
    layout: new Layout({ fit: Fit.Contain, alignment: Alignment.Center }),
    onLoad: () => {
      // A splash that gets dismissed during the load would otherwise come back
      // on screen the moment loading finishes.
      if (destroyed) { rive?.cleanup(); rive = null; return; }
      rive.resizeDrawingSurfaceToCanvas();
      window.addEventListener('resize', onResize);

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
