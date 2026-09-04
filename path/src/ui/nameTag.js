// THE NAMETAG — the player's name on a card beside the seal, on the main menu.
//
// Drawn by the `NAMETAG` artboard in seal_survivor.riv, whose one text run is
// bound to `strPlayerName` on ViewModel1 — the same property the splash writes
// on every keystroke — so the game writes the name once, at mount, and the
// artboard lays it out. The menu (systems/mainMenu.js) owns WHERE it goes: it
// projects the seal's measured bust through the camera every frame and hands
// this a point, a height and the viewport, and this file turns those into a
// box. Nothing here knows what a seal is.
//
// A DOM element over the canvas, in the menu's own label layer, rather than a
// quad in the scene: the artboard is a raster with type in it, and the label
// layer already leaves with the menu, so there is nothing extra to tear down.
//
// ON PLAY IT FLIES OFF TO THE RIGHT and is then switched off — paused, hidden,
// and cleaned up when the menu is. The buttons FADE on the same press; this
// does not, because a card that dims in place reads as a card that failed,
// where a card that leaves reads as the run starting. The fly is its own
// clock, on real time, exactly like the menu's glide.
//
// THE CANVAS RUNTIME, not the WebGL2 one the splash uses: the artboard is an
// image and a line of text, with nothing feathered in it, and the WebGL2
// package would hold a second GL context alive beside the game's for the
// whole time the menu is up. Same package and same reasoning as the boss bar.
//
// FAILS TO NOTHING. A missing artboard, a stalled WASM, a file that lost the
// binding — every one of them makes `live` false and the menu carries on with
// no tag. There is no coded fallback the way the boss bar has one, because a
// name beside a menu is decoration and a health bar is not.
//
// THE NAME IS NOT ON THE SEAL, and the note on why is worth reading before
// anyone tries: design/NAME-ON-THE-SEAL.md. The short version is that a name
// on the animal has to be sampled in the seal's own UV space by the shader
// already injected into its material, and a quad held at a bone — which is
// what a first pass at this was — is a card floating beside the flank rather
// than a mark on it.
//
// A FIXED BACKING STORE (`surface`) rather than the CSS box times the device
// pixel ratio. The runtime lays the artboard out in `canvas.width/height`, so
// setting those once at construction is the whole of the sizing: there is no
// resize handler, nothing to re-sync when the card's box changes with the
// window, and the 0x0 trap the boss bar guards against (a surface sized while
// the wrapper was still unlaid-out draws nothing, forever, without erroring)
// cannot happen here at all. 1024 across is comfortably more than the card is
// ever drawn at, so it costs one upload and buys a crisp card at any size.

import { Rive, Layout, Fit, Alignment } from '@rive-app/canvas';
// Sets the WASM url. Imported for the side effect — see riveRuntime.js.
import './riveRuntime.js';
import rivUrl from './seal_survivor.riv?url';
import { NAMETAG_ARTBOARD, SPLASH_BINDINGS } from './riveContract.js';
import { ease } from '../ease.js';

/** The artboard's own proportions (800 x 501 in the editor). */
export const NAMETAG_ASPECT = 800 / 501;

/**
 * What a mount may be given. CONFIG.splashBust.nametag is passed straight in by
 * the menu; a harness can hand in its own. Every field is optional.
 */
export const NAMETAG_DEFAULTS = {
  enabled: true,
  // The backing store's width in pixels; the height follows the artboard's
  // aspect. Not the CSS box — see the note above.
  surface: 1024,
  // The tag's height as a fraction of the bust's height on screen.
  height: 0.26,
  // Air between the bust's right edge and the tag's left, in bust heights.
  gap: 0.06,
  // Where the tag's vertical centre sits on the bust, 0 = the bottom of the
  // measured box (the crop's waist), 1 = the crown.
  y: 0.62,
  // The fly-out on Play — seconds, and a curve name from ease.js.
  flyTime: 0.55,
  flyEase: 'inCubic',
  // How far past the screen's edge the fly ends, in tag widths, so the card's
  // own shadow does not stop at the edge.
  overshoot: 0.25,
  // The nearest the tag may get to the right edge of the screen while held, in
  // CSS px. On a phone held upright the seal already fills the width, so the
  // tag shrinks to fit inside this rather than hang off the side.
  margin: 8,
};

/**
 * Put the tag up.
 *
 * @param parent  the element it goes in — the menu's label layer.
 * @param name    the player's name, written once to the artboard.
 * @param cfg     see NAMETAG_DEFAULTS.
 * @returns a handle, or null when disabled. `live` is false until the artboard
 *          has loaded and stays false if it never does; every method is safe
 *          to call either way.
 */
export function mountNameTag({ parent, name, cfg = {} } = {}) {
  const o = { ...NAMETAG_DEFAULTS, ...cfg };
  if (o.enabled === false || !parent) return null;

  const el = document.createElement('div');
  el.className = 'sv-nametag';
  // Anchored at its LEFT edge and its vertical CENTRE, which is what "beside
  // the seal" means when the seal's crop moves with the window. Hidden until
  // the runtime has drawn, so a slow load never shows an empty box.
  el.style.cssText = 'position:absolute; left:0; top:0; height:0; pointer-events:none; opacity:0; transform:translate(0,-50%); will-change:transform;';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block; width:100%; height:100%;';
  // The fixed backing store — see the note at the top. Set BEFORE the runtime
  // is built, because that is when it reads the size it lays the artboard out
  // in.
  const surface = Math.max(64, Math.round(o.surface || NAMETAG_DEFAULTS.surface));
  canvas.width = surface;
  canvas.height = Math.max(1, Math.round(surface / NAMETAG_ASPECT));
  el.appendChild(canvas);
  parent.appendChild(el);

  const state = {
    rive: null,
    ready: false,
    failed: false,
    destroyed: false,
    // 'held' | 'out' | 'gone'
    phase: 'held',
    elapsed: 0,
    // The box, in CSS px, as last placed.
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    viewportW: 0,
    // What the fly is measured against — how far the tag has to travel to be
    // fully off the right-hand edge from where it stood when Play was pressed.
    flyDistance: 0,
    // The menu's own opacity for it while held — the buttons' fade, on the way
    // in. Kept separate from the fly so one never overwrites the other.
    fade: 0,
  };

  function warn(why) {
    console.warn(`[nameTag] the name tag is off — ${why}`);
  }

  try {
    state.rive = new Rive({
      src: rivUrl,
      canvas,
      artboard: NAMETAG_ARTBOARD,
      // WITHOUT THIS `viewModelInstance` IS NULL and the name write below is a
      // silent no-op — the card would draw the editor's placeholder text.
      autoBind: true,
      autoplay: false,
      layout: new Layout({ fit: Fit.Contain, alignment: Alignment.Center }),
      onLoadError: (err) => {
        state.failed = true;
        warn(`the ${NAMETAG_ARTBOARD} artboard did not load (${err})`);
        el.remove();
      },
      onLoad: () => {
        // Torn down during the load — a menu that was Played through before
        // the file arrived. Nothing to show it on.
        if (state.destroyed) { try { state.rive?.cleanup(); } catch { /* gone */ } state.rive = null; return; }
        const vmi = state.rive?.viewModelInstance;
        let prop = null;
        try { prop = vmi?.string(SPLASH_BINDINGS.name) ?? null; } catch { prop = null; }
        if (!prop) {
          // An export whose run lost its binding. The card would draw whatever
          // text the artboard was saved with, which is worse than no card.
          state.failed = true;
          warn(`the artboard has no "${SPLASH_BINDINGS.name}" to write the name into`);
          el.remove();
          return;
        }
        prop.value = name ?? '';
        const machines = state.rive?.stateMachineNames ?? [];
        if (machines.length) state.rive.play(machines[0]);
        else state.rive.play();
        state.ready = true;
        apply();
      },
    });
  } catch (err) {
    state.failed = true;
    warn(`the runtime could not be built (${err?.message ?? err})`);
    el.remove();
  }

  /** Write the box and the fly to the element. */
  function apply() {
    if (state.destroyed || state.failed) return;
    el.style.left = `${state.left.toFixed(1)}px`;
    el.style.top = `${state.top.toFixed(1)}px`;
    el.style.height = `${state.height.toFixed(1)}px`;
    el.style.width = `${state.width.toFixed(1)}px`;
    const fly = state.phase === 'held' ? 0 : flyOffset();
    el.style.transform = `translate(${fly.toFixed(1)}px, -50%)`;
    // Nothing shows until the runtime has drawn once; after that the menu's
    // fade owns it on the way in and the fly owns it on the way out.
    el.style.opacity = state.ready ? String(state.phase === 'held' ? state.fade : 1) : '0';
  }

  function flyOffset() {
    if (state.phase === 'gone') return state.flyDistance;
    const t = Math.min(1, state.elapsed / Math.max(0.01, o.flyTime));
    return ease(o.flyEase, t) * state.flyDistance;
  }

  const handle = {
    el,
    /** The canvas the artboard draws into. */
    canvas,
    /** Is the artboard drawing? */
    get live() { return state.ready && !state.failed && !state.destroyed; },
    /** 'held' | 'out' | 'gone' */
    get phase() { return state.phase; },

    /**
     * Put the box beside the seal, in CSS px of the viewport.
     *
     * @param x           the bust's right edge on screen
     * @param yBottom     the bust's bottom edge on screen
     * @param bustHeight  the bust's height on screen
     * @param viewportW   the width of the viewport, for the clamp and the fly
     * @param fade        0..1, the menu's own opacity for it while held
     */
    place({ x, yBottom, bustHeight, viewportW, fade = 1 }) {
      if (state.destroyed || state.failed) return;
      // NOT WHILE FLYING. The fly is measured from where the card stood when
      // Play was pressed, and the camera under the menu is pulling out for
      // the whole of it — a box re-placed off a moving bust would drift with
      // the zoom on top of its own fly, and could land short of the edge.
      if (state.phase !== 'held') return;
      // The tag is a shape of the BUST, not of the window: gap, height and
      // where it sits all scale with the animal, so a window that frames the
      // seal bigger frames the tag bigger with it.
      let height = Math.max(0, bustHeight * o.height);
      let width = height * NAMETAG_ASPECT;
      const left = x + bustHeight * o.gap;
      // ...UNLESS IT WOULD HANG OFF THE SCREEN. Portrait frames the seal edge
      // to edge; the tag shrinks to whatever is left rather than leaving.
      const room = viewportW - o.margin - left;
      if (width > room) {
        width = Math.max(0, room);
        height = width / NAMETAG_ASPECT;
      }
      state.left = left;
      state.top = yBottom - bustHeight * o.y;
      state.width = width;
      state.height = height;
      state.viewportW = viewportW;
      state.fade = Math.max(0, Math.min(1, fade));
      apply();
    },

    /**
     * PLAY. Starts the fly to the right; `update` carries it. Measured from
     * where the tag stands now, so a tag that has already been clamped small
     * on a phone still travels exactly far enough.
     */
    flyOut() {
      if (state.phase !== 'held') return;
      state.phase = 'out';
      state.elapsed = 0;
      state.flyDistance = Math.max(0, state.viewportW - state.left) + state.width * o.overshoot;
      apply();
    },

    /** One frame, on real time. Only the fly needs it. */
    update(dt) {
      if (state.phase !== 'out') return;
      state.elapsed += dt;
      if (state.elapsed >= o.flyTime) {
        // OFF, not merely off screen: the runtime's render loop is its own
        // rAF and would keep drawing an 800x501 artboard nobody can see.
        state.phase = 'gone';
        el.style.display = 'none';
        try { state.rive?.pause(); } catch { /* gone */ }
      }
      apply();
    },

    /** Drop it entirely. The menu calls this from its own tidy. */
    dispose() {
      if (state.destroyed) return;
      state.destroyed = true;
      try { state.rive?.cleanup(); } catch { /* already gone */ }
      state.rive = null;
      el.remove();
    },
  };
  return handle;
}
