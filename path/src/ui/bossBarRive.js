// THE BOSS HEALTH BAR, drawn by Rive.
//
// The bar the game shipped with is three divs and a width in ui.js. This is the
// same information — a name, a fill, a length — drawn by the `Boss Health`
// artboard in seal_survivor.riv, so the look of the most dramatic three seconds
// in the run is authored in Rive rather than in a stylesheet.
//
// THE CODED BAR IS STILL THERE, and this file's most important promise is that
// it can always be handed back to. Everything below reports whether it is
// actually drawing, and ui.js draws the div bar whenever the answer is no —
// see `bossBarLive`. That is not defensiveness for its own sake: this bar is
// made of a WASM runtime, a network fetch and a file the game does not author,
// and a boss fight with no health bar is a worse outcome than a boss fight with
// a plain one. The failure has to be a downgrade rather than a hole.
//
// The artboard's contract, measured rather than assumed (see tools/rive-boss-test.mjs):
//
//   numBossHealth     0..100  how full the bar is, as a percent of its length
//   numHealthBarSize  0..100  the bar's LENGTH, as a percent of artboard width
//   strBossName               the name under it
//
// All three live on `ViewModel1`, which the splash shares — each artboard gets
// its own instance under autoBind, so the two cannot tread on each other.

import { Rive, Layout, Fit, Alignment } from '@rive-app/canvas';
// Sets the WASM url. Imported for the side effect, and it must be imported by
// anything that constructs a Rive instance — see riveRuntime.js.
import './riveRuntime.js';
import rivUrl from './seal_survivor.riv?url';
// The artboard name and the three property names, shared with the export check
// so a re-export that renames one is refused before it reaches the game rather
// than discovered as a bar that never moves. See riveContract.js.
import { BOSS_BAR_ARTBOARD, BOSS_BAR_BINDINGS } from './riveContract.js';
import { CONFIG } from '../config.js';

// What the module knows about itself. `ready` is the one flag ui.js acts on,
// and it is only ever set from the runtime's own onLoad — a bar that is loading,
// that failed, or that was switched off in config all read the same way to the
// caller: not drawing, use the other one.
const state = {
  wrap: null,
  canvas: null,
  rive: null,
  ready: false,
  failed: false,
  showing: false,
  // The bound properties, or null. Held rather than looked up per frame: the
  // lookup walks a path string through the view model, and this runs at 60Hz
  // for the whole of a fight.
  health: null,
  size: null,
  name: null,
  lastName: null,
};

function cfg() {
  return CONFIG.boss?.bar ?? {};
}

/** Is the Rive bar actually drawing right now? ui.js draws the div bar if not. */
export function bossBarLive() {
  return !!(state.ready && !state.failed && cfg().rive !== false);
}

/**
 * Build the canvas and start loading the artboard. Called once from initUI,
 * minutes before any boss exists.
 *
 * EAGER ON PURPOSE. Everything expensive here — the WASM instantiation, the
 * 645KB file, the artboard and its state machine — would otherwise be paid on
 * the frame a boss arrives, which is the single worst frame in the run to hand
 * the main thread a decode. Loading it at boot costs a hidden canvas for the
 * whole run and nothing else, and by the time the first fight comes round the
 * only work left is writing three numbers.
 */
export function initBossBarRive(parent) {
  if (state.wrap || cfg().rive === false) return;

  const c = cfg();
  state.wrap = document.createElement('div');
  state.wrap.className = 'sv-bossbar-riv sv-hidden';
  // Sized in vw with a px ceiling, like the div bar it stands in for, and with
  // the artboard's own 1920x307 aspect so Fit.Contain has nothing to letterbox.
  // pointer-events off: it sits over the water the player is aiming into.
  const width = c.width ?? 'min(1040px, 88vw)';
  // THE INSET IS ADDED, NOT SUBSTITUTED FOR THE TUNED TOP. `c.top` is a
  // composition choice about how far under the top edge the bar hangs; the
  // inset is how far down the top edge actually is once the page draws under
  // the Dynamic Island (index.html carries viewport-fit=cover). Sizes down to
  // 0 on anything without a notch, so this is not a phone special case — it is
  // the same 14px everywhere the top edge is the top edge.
  state.wrap.style.cssText =
    `position:absolute; top:calc(${c.top ?? 14}px + env(safe-area-inset-top, 0px)); left:50%; transform:translateX(-50%);` +
    `width:${width}; aspect-ratio:1920 / 307; pointer-events:none;`;

  state.canvas = document.createElement('canvas');
  state.canvas.style.cssText = 'display:block; width:100%; height:100%;';
  state.wrap.appendChild(state.canvas);
  parent.appendChild(state.wrap);

  state.rive = new Rive({
    src: rivUrl,
    canvas: state.canvas,
    artboard: c.artboard ?? BOSS_BAR_ARTBOARD,
    // THE WHOLE POINT. Without autoBind there is no view model instance and
    // every write below is a silent no-op.
    autoBind: true,
    autoplay: false,
    layout: new Layout({ fit: Fit.Contain, alignment: Alignment.Center }),
    onLoadError: (err) => {
      // The file is missing, the artboard was renamed, the WASM never arrived.
      // Reported once and then never again — and `failed` is what sends ui.js
      // back to the div bar for the rest of the session.
      console.warn(`[bossBar] Rive bar unavailable, falling back to the coded bar — ${err}`);
      state.failed = true;
      state.wrap?.remove();
      state.wrap = null;
    },
    onLoad: () => {
      resize();
      // A SECOND RESIZE, NEXT FRAME, and it is not belt-and-braces. Rive sizes
      // its drawing surface from the canvas's CSS box AT THE MOMENT IT IS
      // ASKED, and onLoad can land before the layout carrying this wrapper has
      // been resolved — a 0x0 box gives a 0x0 backing store, and the artboard
      // then draws nothing at all, forever, without erroring. A bar that is
      // mounted, bound, playing and invisible is the exact failure this line
      // exists to prevent.
      requestAnimationFrame(resize);
      window.addEventListener('resize', resize);

      const vmi = state.rive?.viewModelInstance;
      if (!vmi) {
        console.warn('[bossBar] the Boss Health artboard bound no view model — falling back to the coded bar.');
        state.failed = true;
        state.wrap?.remove();
        state.wrap = null;
        return;
      }
      state.health = vmi.number(BOSS_BAR_BINDINGS.health);
      state.size = vmi.number(BOSS_BAR_BINDINGS.size);
      state.name = vmi.string(BOSS_BAR_BINDINGS.name);
      // A missing property is a re-export with a renamed binding, and it is
      // worth being loud about: the bar would otherwise draw perfectly and
      // simply never move.
      const missing = [
        !state.health && BOSS_BAR_BINDINGS.health,
        !state.size && BOSS_BAR_BINDINGS.size,
        !state.name && BOSS_BAR_BINDINGS.name,
      ].filter(Boolean);
      if (missing.length) {
        console.warn(`[bossBar] the artboard is missing ${missing.join(', ')} — falling back to the coded bar.`);
        state.failed = true;
        state.wrap?.remove();
        state.wrap = null;
        return;
      }
      // The artboard's own timeline drives numBossHealth down to zero once on
      // load. Harmless — nothing is on screen yet, and update() overwrites it
      // on the first frame of the first fight — but the bar is left reading
      // empty rather than at whatever the file was saved at, so the first
      // thing the player ever sees it do is fill.
      state.health.value = 0;
      state.ready = true;
    },
  });
}

function resize() {
  state.rive?.resizeDrawingSurfaceToCanvas();
}

// HOW LONG THE BAR IS, 0..1, from the fight's max health. The curve is ui.js's
// — a square root, because boss health runs from 600 to several thousand across
// a run and a linear map either pins the first boss at a sliver or runs the
// sixth off both edges — and it is imported rather than re-derived so the two
// bars cannot disagree about which boss is bigger.
function sizePercent(span) {
  const c = cfg();
  const min = c.sizeMin ?? 52;
  const max = c.sizeMax ?? 100;
  return min + (max - min) * Math.max(0, Math.min(1, span));
}

/**
 * One frame of the bar.
 *
 * @param banner systems/boss.js's bossBanner(), or null for "no boss".
 * @param span   0..1, how big this fight is — ui.js's bossBarSpan(maxHp), passed
 *               in rather than computed here so both bars read one curve.
 * @returns whether this drew. False means ui.js must draw the coded bar.
 */
export function updateBossBarRive(banner, span = 0) {
  if (!bossBarLive()) return false;

  if (!banner) {
    if (state.showing) {
      state.showing = false;
      state.wrap.classList.add('sv-hidden');
      // PAUSED, not merely hidden. Rive's render loop is its own rAF, and it
      // does not care that the canvas is display:none — left playing, a bar
      // nobody can see would draw a 1920x307 artboard sixty times a second for
      // the ninety-five percent of a run that has no boss in it.
      state.rive?.pause();
    }
    return true;
  }

  if (!state.showing) {
    state.showing = true;
    state.wrap.classList.remove('sv-hidden');
    const machines = state.rive?.stateMachineNames ?? [];
    if (machines.length) state.rive.play(machines[0]);
    else state.rive?.play();
    // The wrapper was display:none until this frame, so its box only became
    // real just now — and a drawing surface sized while it was hidden is the
    // 0x0 case again. Re-synced on the way in, every time.
    resize();
  }

  // `frac` is health for most of a fight and the ARRIVAL CEREMONY while the
  // boss is swimming in (see tickArrival) — already eased, already 0..1, so the
  // bar fills across the entrance for free and needs to know nothing about it.
  state.health.value = Math.max(0, Math.min(1, banner.frac)) * 100;
  state.size.value = sizePercent(span);
  // Guarded because a string write crosses into WASM and re-lays out the text,
  // and the name changes once per boss rather than once per frame.
  if (banner.name !== state.lastName) {
    state.lastName = banner.name;
    state.name.value = banner.name ?? '';
  }
  return true;
}

/** Drop it entirely — for a harness, or a hot reload. */
export function resetBossBarRive() {
  window.removeEventListener('resize', resize);
  state.rive?.cleanup();
  state.wrap?.remove();
  state.wrap = null;
  state.canvas = null;
  state.rive = null;
  state.ready = false;
  state.failed = false;
  state.showing = false;
  state.health = state.size = state.name = null;
  state.lastName = null;
}
