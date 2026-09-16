// ---------------------------------------------------------------------------
// THE FULLSCREEN BUTTON — the phone's only way to the whole screen.
//
// A phone held sideways in a browser is playing the game in a letterbox: mobile
// Safari keeps a bar of its own along the bottom and sizes the page around it,
// so the run draws correctly into a viewport that is shorter than the glass and
// the bottom of the HUD sits under browser furniture. Nothing about that is
// fixable from inside the page — see systems/fullscreen.js — and there was no
// way to ask for the display at all without a keyboard, because the only
// fullscreen the game had was Shift+F.
//
// IT ASKS BEFORE IT DRAWS ITSELF. Three conditions, all of them capabilities
// rather than guesses about a device:
//
//   a thumb          touchPrimary(). A mouse has Shift+F and the browser's own
//                    F11, and a second always-on control would be clutter on
//                    the surface it costs the most.
//   the API is real  fullscreenAvailable(). Element fullscreen did not exist on
//                    iPhone for most of this game's life — absent, not refused
//                    — and a button drawn on faith is a dead control on exactly
//                    the device that most wants it.
//   a browser tab    isBrowser(). The iOS app and the desktop build own their
//                    own window; there is no chrome to escape and the button
//                    would be asking a question that has no answer there.
//
// A TAP, NOT A HOLD, which is the one place it departs from the pause button
// beside it. That control holds because a stray press costs you the run's
// momentum and has no visible undo; this one toggles something the player can
// see instantly and can put back with the same thumb on the same button. The
// cheap protection is enough: it sits in the top-left column, the one corner
// neither thumb lives in.
//
// WHERE IT IS NOT. .sv-center surfaces — the splash, the pause menu, the score
// card, the level-up cards — are full-screen layers at z-index 8 and this sits
// at 4 with the rest of the run's furniture, so it is covered while any of them
// is up. That is the intended rule and not an oversight: the button belongs to
// the game's own screen, and a control floating over a menu that has its own
// buttons is the kind of thing that gets tapped by accident.
// ---------------------------------------------------------------------------

import { touchPrimary } from '../devices.js';
import { isBrowser } from '../platform.js';
import { fullscreenAvailable, isFullscreen, onFullscreenChange, toggleFullscreen } from '../systems/fullscreen.js';
import { uiText } from '../uiTextTable.js';

// Directly under the pause button's 44px slot, in the same column: 34 of inset,
// 44 of button, 8 of gap. It keeps that slot even on the screens where the
// pause button is hidden (the menu), because a control that moves between
// screens is a control you have to find twice.
export const FS_BUTTON_CSS = 'position:fixed; z-index:4;'
  + ' top:calc(86px + env(safe-area-inset-top, 0px));'
  + ' left:calc(8px + env(safe-area-inset-left, 0px));'
  + ' width:44px; height:44px; padding:0; margin:0; border:0; background:none;'
  // OPTING BACK IN. .sv-ui is pointer-events:none so the overlay does not eat
  // the ocean underneath it, and that inherits — an interactive child that does
  // not say this draws perfectly and simply cannot be pressed.
  + ' pointer-events:all; cursor:pointer;'
  // The press must not also scroll, rubber-band or raise iOS's selection sheet.
  + ' touch-action:none; -webkit-tap-highlight-color:transparent;'
  + ' -webkit-touch-callout:none; -webkit-user-select:none; user-select:none;'
  + ' opacity:0.45; transition:opacity 0.18s ease;';

// Two glyphs in one <svg>, swapped by hiding a group — the same 16px square
// read twice: brackets facing out for "take the screen", facing in for "give it
// back". Stroked rather than filled so it stays legible at 0.45 opacity over
// bright water.
const GLYPH = `
      <g class="sv-fsbtn-in" fill="none" stroke="#e8ecf3" stroke-width="2.4"
         stroke-linecap="round" stroke-linejoin="round">
        <path d="M13 18 V13 H18" />
        <path d="M26 13 H31 V18" />
        <path d="M31 26 V31 H26" />
        <path d="M18 31 H13 V26" />
      </g>
      <g class="sv-fsbtn-out" fill="none" stroke="#e8ecf3" stroke-width="2.4"
         stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 13 V18 H13" />
        <path d="M31 18 H26 V13" />
        <path d="M26 31 V26 H31" />
        <path d="M13 26 H18 V31" />
      </g>`;

/**
 * Draw the button into `parent` and hand back a handle.
 *
 * @param opts.parent   the .sv-ui overlay.
 * @param opts.onPress  called on a real press, for the click sound — ui.js owns
 *                      feedback(), and importing it here would drag the audio
 *                      stack into every harness that mounts this button.
 * @returns {{ el: HTMLElement, refresh: () => void, remove: () => void }}
 */
export function mountFullscreenButton({ parent, onPress = null } = {}) {
  const doc = parent?.ownerDocument ?? document;
  const el = doc.createElement('button');
  el.className = 'sv-fsbtn';
  el.id = 'svFullscreenBtn';
  el.type = 'button';
  el.style.cssText = FS_BUTTON_CSS;
  el.innerHTML = `<svg viewBox="0 0 44 44" width="44" height="44" aria-hidden="true"
      style="display:block; filter:drop-shadow(0 1px 2px rgba(0,0,0,0.9));">${GLYPH}</svg>`;

  const enterGlyph = el.querySelector('.sv-fsbtn-in');
  const exitGlyph = el.querySelector('.sv-fsbtn-out');

  // WHETHER IT MAY BE ON SCREEN AT ALL, and what it is currently offering.
  // One function for both because they are answered at the same moments — the
  // media query flipping, fullscreen changing under us — and two would be two
  // chances to leave the glyph disagreeing with the state.
  function refresh() {
    const on = isFullscreen();
    const show = touchPrimary() && isBrowser() && (fullscreenAvailable() || on);
    el.style.display = show ? 'block' : 'none';
    // `hidden` alongside the style so a screen reader and the pad's own row
    // lists agree with the glass about what exists.
    el.hidden = !show;
    enterGlyph.style.display = on ? 'none' : '';
    exitGlyph.style.display = on ? '' : 'none';
    el.setAttribute('aria-label', on ? uiText('fullscreenExit') : uiText('fullscreenEnter'));
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  el.addEventListener('click', () => {
    onPress?.();
    toggleFullscreen();
    // Optimistic nothing: the glyph follows the CHANGE EVENT rather than the
    // request, because the request can be refused and a button that has already
    // redrawn itself as "exit" over a windowed game is lying.
  });

  const stopWatching = onFullscreenChange(refresh);
  // Plugging a mouse into a tablet flips touchPrimary(), and a control sized
  // for the wrong hand until the next reload is the kind of thing nobody
  // reports. Same query markTouch() in ui.js listens to, asked separately
  // because this button is not styled through that class.
  const query = globalThis.window?.matchMedia?.('(hover: none) and (pointer: coarse)');
  query?.addEventListener?.('change', refresh);

  refresh();
  parent?.appendChild(el);

  return {
    el,
    refresh,
    remove: () => {
      stopWatching();
      query?.removeEventListener?.('change', refresh);
      el.remove();
    },
  };
}
