// WHICH NAME SCREEN COMES UP — the audition switch, and nothing else.
//
//   ?splash=spline    the Spline scene (ui/splineSplash.js)
//   ?splash=rive      the artboard (ui/riveSplash.js) — what ships today
//
// A URL PARAM AND NOT A SETTING, because of what the splash is: it mounts once
// per page load and never comes back (`splashPlayed` latches in ui.js). There
// is no moment in a session when a toggle could be flipped and seen — the only
// way to see the other one is a reload, and a reload is exactly what typing a
// query string is. A row in the options menu would be a control that does
// nothing until you leave the screen it lives on.
//
// IT STICKS, though, which is the part a bare query string does not give you.
// The choice is remembered so the next reload — and every navigation that drops
// the query, which is most of them — comes back to the same screen. Auditioning
// is looking at one thing repeatedly, and re-typing `?splash=spline` after
// every hard refresh is how a comparison quietly becomes a comparison of
// whichever one you last remembered to ask for.
//
//   ?splash=rive     switches back AND clears the memory, so it is also the
//                    way out rather than a third state to get stuck in.
//
// NOT A PLAYER SETTING. This is a design decision being made, not a preference
// being offered — see systems/settings.js for the things that are. When the
// audition is over one of these two loses and this file is deleted along with
// it; that deletion condition is the reason the switch is one word in one
// place instead of plumbing.
//
// DEFAULT IS RIVE, always, and deliberately: an audition must not be able to
// change what a player who typed nothing sees.

const KEY = 'sv.splash.audition';

// ---------------------------------------------------------------------------
// THE AUDITION IS OFF — every build, until further notice (2026-08-25).
//
// Flip this to true and everything below wakes up exactly as it was: the URL
// param, the stickiness, `?splineSrc=`, the panel. Nothing has been deleted, so
// turning it back on is this line and nothing else.
//
// WHY IT IS A CONSTANT HERE RATHER THAN A DELETION. The Spline screen is a bet
// that has not been called yet — ui/splineSplash.js is 400 lines of scene
// wrangling that would be expensive to write again, and the note at the top of
// this file already says one of the two loses and gets deleted along with this
// switch. That day is not today. Off is not the same as gone.
//
// WHY IT IS HERE RATHER THAN IN A BUILD CONFIG. The dev server has to agree
// with the shipped build. A switch that lived only in vite.desktop.config.js
// would leave `?splash=spline` still working in dev, so the one place it is
// easiest to forget the decision is the one place it would not apply.
//
// THE DESKTOP BUILD DOES NOT RELY ON THIS. vite.desktop.config.js aliases this
// whole module out and drops ui/splineSplash.js from the import graph, so the
// Steam build cannot ship the Spline runtime even if this constant goes back to
// true. That is deliberate: "off for now" and "never in the downloaded build"
// are two different decisions and they should not share one switch.
//
// tools/offline-audit.mjs READS THIS CONSTANT rather than being told about it,
// so the unpkg fetch in ui/splineSplash.js is reported as unreachable while
// this is false and starts failing the gate again the moment it is true.
// ---------------------------------------------------------------------------
export const SPLINE_ENABLED = false;

/**
 * 'spline' or 'rive'. Reads the URL first, then what was last asked for.
 *
 * Storage is wrapped because it throws outright in a private window on some
 * browsers, and a name screen that fails to appear because it could not read a
 * preference about which name screen to appear as is the worst possible way to
 * lose this bet.
 */
export function splashChoice() {
  // The switch wins over the URL AND over what was last asked for. Both matter:
  // a link with `?splash=spline` in it is still in somebody's history, and
  // anyone who auditioned the scene has 'spline' latched in localStorage on
  // that origin — so an off switch that only ignored the query string would
  // leave the Spline screen coming up for exactly the people who had looked at
  // it most.
  if (!SPLINE_ENABLED) return 'rive';

  let asked = null;
  try {
    asked = new URLSearchParams(window.location.search).get('splash');
  } catch {
    // No location at all (a harness).
  }

  if (asked === 'spline') {
    try { window.localStorage.setItem(KEY, 'spline'); } catch { /* private window */ }
    return 'spline';
  }
  if (asked === 'rive' || asked === 'off') {
    try { window.localStorage.removeItem(KEY); } catch { /* private window */ }
    return 'rive';
  }

  try {
    if (window.localStorage.getItem(KEY) === 'spline') return 'spline';
  } catch {
    // As above.
  }
  return 'rive';
}

/**
 * The scene the Spline screen should load, if the default in config.js is being
 * overridden for one look. `?splineSrc=<url>` — which is how a fresh export
 * gets tried without editing a file, and how two exports get compared in two
 * tabs.
 */
export function splineSrcOverride() {
  try {
    return new URLSearchParams(window.location.search).get('splineSrc') ?? '';
  } catch {
    return '';
  }
}

/**
 * Keep the scene's own workbench on screen — `?splinePanel`.
 *
 * The Spline file's HTML content is a fly-camera HUD, a current/cloth slider
 * stack and a name lab, and the code export brings all of it along. The name
 * screen hides it (see THE PANEL in ui/splineSplash.js), because a title screen
 * with a slider panel in the corner is not a title screen — but the sliders are
 * how that scene gets tuned, and tuning them against the game's own framing
 * beats tuning them in Spline.
 *
 * IT ALSO MAKES THE SCREEN UNUSABLE, which is the point of it being opt-in: the
 * frame covers everything and takes the pointer, so with the panel up the name
 * field cannot be reached and the run cannot be started. It is a thing to look
 * at, not a thing to play through.
 */
export function splinePanelWanted() {
  try {
    return new URLSearchParams(window.location.search).has('splinePanel');
  } catch {
    return false;
  }
}
