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
import { NAME_SWAP_DEFAULTS } from '../../path/src/ui/nameSwap.js';

// The sky shader's knobs at the shipped values (CONFIG.splashSky). A plain
// object rather than the config, so this page keeps the standalone property the
// module has — see the header of ui/riveSplash.js.
const SKY_FX = {
  bandDrift: 0.4,
  bandDensity: 1,
  bandStrength: 1,
  shimmer: 0.08,
  cloudSpeed: 1,
  cloudScale: 0.2,
  cloudAmount: 1,
  noiseDetail: 1,
};
window.__skyFx = SKY_FX;

const stage = document.getElementById('stage');
const hud = document.getElementById('hud');
const lines = [];
const say = (s) => { lines.push(s); hud.textContent = lines.join('\n'); };

say(`viewport ${window.innerWidth}x${window.innerHeight}`);

const handle = mountRiveSplash({
  parent: stage,
  // The dice's dissolve at its defaults, so the look can be seen here too.
  nameSwap: NAME_SWAP_DEFAULTS,
  // The sky shader's knobs, through the same path the game uses — a mutable
  // object the module polls. `__skyFx` on the window is the handle for driving
  // them from the console: set a field and the sky follows within 250ms.
  skyFx: SKY_FX,
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
      if (!prop.startsWith('t')) continue; // only the triggers are worth a line
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
// ?guards USED TO TEST THE PRESS-AT-MOUNT GUARDS. There is nothing to guard
// now: a run begins only when the artboard's own Start button fires `tStart`
// (on pointer DOWN — see onSplashPointer in riveSplash.js), and a press on
// empty water focuses the name field and nothing else. The sweep above is the
// check that still matters: it must report tStart firing somewhere.
if (location.search.includes('guards')) say('guards: retired — the artboard owns Start now; run the sweep instead');

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
