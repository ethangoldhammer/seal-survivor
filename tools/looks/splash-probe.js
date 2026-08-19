// WHAT IS ACTUALLY BEHIND THE TITLE CARD.
//
// The title screen holds the seal up against the lens and lets the player move
// it (systems/titleSeal.js). All of that is drawn on the GAME canvas, and the
// Rive splash sits on top of it — so the whole feature is visible only to the
// extent that the card is not painted over it. Two separate things can hide it,
// and they look identical on screen:
//
//   THE WRAPPER, which ui/riveSplash.js fills behind the artboard because the
//   artboard is fitted `Contain` and never covers a wide screen on its own.
//   That is ours, it is one number (CONFIG.titleSeal.scrim), and it is fixable
//   from the tuner.
//
//   THE ARTBOARD, if the designer put a full-bleed background rectangle on the
//   bottom layer of `Splash Screen`. That is a fact about seal_survivor.riv and
//   NO value in the game can reveal what is under it.
//
// This page mounts the real splash — the shipping module, the shipping .riv —
// with a transparent wrapper, over a magenta/cyan checker. Whatever is still
// checkered is where the seal can be seen. Whatever is not, cannot.
//
//   npm run looks:splash
//
// Re-run it after any Rive re-export: the artboard growing a background is a
// change nothing in the codebase can detect, and the symptom is a title screen
// that quietly loses its seal.
import { mountRiveSplash } from '../../path/src/ui/riveSplash.js';
import { SPLASH_BINDINGS } from '../../path/src/ui/riveContract.js';

const stage = document.getElementById('stage');
const hud = document.getElementById('hud');
const lines = [];
const say = (s) => { lines.push(s); hud.textContent = lines.join('\n'); };

say(`viewport ${window.innerWidth}x${window.innerHeight}`);

const handle = mountRiveSplash({
  parent: stage,
  // The whole point of the page. `startFallback` stays off so a stray pointer
  // event while screenshotting does not tear the card down mid-look.
  background: 'transparent',
  onPointer: (x, y) => { hud.dataset.pointer = `${x},${y}`; },
  onReady: (info) => {
    say(`artboards: ${info.artboards.join(', ') || '(none)'}`);
    say(`state machines: ${info.stateMachines.join(', ') || '(none)'}`);
    say(`playing: ${info.playing}`);
    say('checkered = the seal would show through');
    say('bottom right: sweep the artboard for live listeners');
    // THE TWO TRIGGERS, and whether the artboard has them at all. Both fail
    // silently in the game — a splash with no `tStart` falls back to
    // dismiss-on-any-input and a missing `tRandomizeName` is simply a dice
    // button that does nothing — so an export that lost one looks perfect
    // here as well unless the page says so out loud.
    const vmi = handle.rive?.viewModelInstance;
    for (const [role, prop] of Object.entries(SPLASH_BINDINGS)) {
      if (role === 'name') continue;
      let has = false;
      try { has = !!vmi?.trigger(prop); } catch { has = false; }
      say(`${prop}: ${has ? 'bound' : 'NOT IN THIS EXPORT'}`);
    }
    // WHAT THE FIELD SAYS, sampled rather than listened for: the dice button
    // writes into the hidden <input>, so a press that fired the trigger shows
    // up here and one the artboard swallowed does not. That distinction is the
    // whole reason this readout exists — the two failures (a button whose
    // listener never fires, and a game that never subscribed) are identical on
    // screen.
    const field = stage.querySelector('input');
    let last = null;
    setInterval(() => {
      const now = field?.value ?? '';
      if (now === last) return;
      last = now;
      say(`name field: "${now}"`);
    }, 100);
  },
  onError: (err) => say(`LOAD FAILED — ${err?.message ?? err}`),
  onDismiss: (why) => say(`dismissed (${why})`),
});

// ---------------------------------------------------------------------------
// THE LISTENER SWEEP — press L.
//
// WHY THIS EXISTS. The artboard's buttons are Rive LISTENERS, and a listener
// that never fires is the quietest failure in the file: the button draws, it
// animates, it takes the press, and nothing downstream happens. There is no
// error and nothing in the console. `tStart` was in that state for months —
// the game was startable only with the Enter key, which the DOM handles, so
// nothing ever pointed at the artboard.
//
// The sweep presses every point of a grid over the ARTBOARD, straight into the
// state machine instance — not through the canvas. That is the whole value of
// it: it skips the DOM, the fit/alignment maths and the browser's own event
// plumbing, all of which are suspects when a button "does nothing" and none of
// which can be cleared by clicking harder. What is left is the file.
//
// A hit is anything the state machine did in response: a state change, or the
// name field moving because tRandomizeName landed. It presses tStart too, so
// the splash may dismiss itself mid-sweep — that IS the pass condition, and it
// is reported before the page goes.
// ---------------------------------------------------------------------------
function sweepListeners() {
  const rive = handle.rive;
  const sm = rive?.animator?.stateMachines?.[0]?.instance;
  if (!sm) { say('sweep: no state machine instance'); return; }
  const b = rive.artboard.bounds;
  const field = () => stage.querySelector('input')?.value ?? '(gone)';
  const NX = 32, NY = 18;
  let before = field();
  const changes = [];
  for (let gy = 0; gy < NY; gy++) {
    for (let gx = 0; gx < NX; gx++) {
      const x = b.minX + (gx + 0.5) * (b.maxX - b.minX) / NX;
      const y = b.minY + (gy + 0.5) * (b.maxY - b.minY) / NY;
      // Advanced between each step, because a click is down and up on the same
      // shape and the machine has to run to notice the first one.
      sm.pointerMove(x, y, 0); sm.advanceAndApply(0.016);
      sm.pointerDown(x, y, 0); sm.advanceAndApply(0.016);
      sm.pointerUp(x, y, 0); sm.advanceAndApply(0.016);
      if (handle.isDestroyed) { say(`sweep: tStart FIRED at artboard ${Math.round(x)},${Math.round(y)}`); return; }
      if (field() !== before) { changes.push(`${Math.round(x)},${Math.round(y)}`); before = field(); }
    }
  }
  const states = sm.stateChangedCount();
  if (changes.length) say(`sweep: tRandomizeName fired at ${changes.slice(0, 4).join(' / ')}`);
  if (!changes.length && !states) {
    say(`sweep: NO LISTENER RESPONDED to ${NX * NY} presses across the artboard`);
    say('       (the file\'s listeners are inert — not the code, not the browser)');
  } else if (!changes.length) {
    say(`sweep: no trigger fired, but ${states} state change(s) — listeners are alive`);
  }
}
// ?guards — DOES A PRESS AT MOUNT START THE RUN?
//
// The splash begins a run on a press anywhere that is not the dice or the name
// field, which is a very large button; two guards keep an accidental press off
// it (a release whose press began elsewhere, and a dead time right after the
// splash appears). Both are invisible when they work, and the dead time cannot
// be tested from outside the page at all — a driver's round trip is longer than
// the window it guards. So the page tests it itself, on the frame it mounts.
if (location.search.includes('guards')) {
  const fire = (type, ax, ay) => {
    const wrap = stage.querySelector('.sv-riv'); const c = stage.querySelector('canvas');
    if (!wrap || !c) return false;
    const r = c.getBoundingClientRect();
    const sc = Math.min(r.width / 1920, r.height / 1080);
    const x = r.left + (r.width - 1920 * sc) / 2 + ax * sc;
    const y = r.top + (r.height - 1080 * sc) / 2 + ay * sc;
    wrap.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    return true;
  };
  const alive = () => !handle.isDestroyed;
  // Straight away: a full click on empty artboard, inside the dead time.
  setTimeout(() => {
    fire('pointerdown', 960, 250); fire('pointerup', 960, 250);
    setTimeout(() => {
      say(`guard: a click ${Math.round(performance.now())}ms after load — ${alive() ? 'ignored (dead time held)' : 'STARTED (dead time failed)'}`);
      // ...and again once the dead time is well past, which must start it.
      setTimeout(() => {
        fire('pointerdown', 960, 250); fire('pointerup', 960, 250);
        setTimeout(() => say(`guard: a click after the dead time — ${alive() ? 'ignored (BAD)' : 'started (good)'}`), 150);
      }, 700);
    }, 150);
  }, 0);
}

// A BUTTON, NOT A KEY. The splash holds focus on its hidden name field the
// whole time it is up, so every letter you press is typed into it — a keyboard
// shortcut here reads as the page ignoring you while quietly filling the field
// with the shortcut. The button sits above the splash wrapper and opts back
// into pointer events; see the stylesheet.
document.getElementById('sweep')?.addEventListener('click', () => {
  say('sweeping…');
  // Deferred a frame so the line above is painted before the sweep blocks the
  // main thread for its 1700-odd advances.
  requestAnimationFrame(() => sweepListeners());
});

// THE HANDLE, on the window. This page is a probe and the console is half of
// it: `__splash.randomize()` rolls a name without the artboard's help, which is
// the control experiment for a dice button that appears to do nothing — the
// game's side working there and not on a press narrows it to the listener.
window.__splash = handle;
