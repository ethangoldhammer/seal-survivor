// ============================================================================
// THE DESKTOP BUILD'S ANSWER TO "WHICH NAME SCREEN": always the Rive card.
//
// Swapped in for path/src/ui/splashChoice.js by vite.desktop.config.js. The web
// build keeps the real one and the audition it runs.
//
// WHY A SWAP AND NOT A BRANCH IN THE REAL FILE. A branch would leave
// ui/splineSplash.js in the desktop bundle — reachable or not, its module body
// carries the unpkg URL it fetches the Spline runtime from, and a build that
// ships that string is a build somebody has to keep checking. Replacing the
// chooser means the import graph never reaches the Spline module at all, so
// Rollup drops it and there is nothing left to audit. `npm run desktop:test`
// asserts exactly that.
//
// It also means path/src is untouched: no flag threaded through ui.js, and the
// web build's audition keeps working exactly as it does today.
// ============================================================================

/**
 * Always 'rive'.
 *
 * No URL read and no localStorage read, deliberately — not merely because
 * neither would say 'spline' on a fresh desktop origin, but because a stub that
 * consulted them would be a stub with a way of being wrong. There is no Spline
 * module in this bundle to choose; the only correct answer is the one that is
 * always the same.
 */
export function splashChoice() {
  return 'rive';
}

/** Nothing to override — the Rive card has no `src`. */
export function splineSrcOverride() {
  return '';
}

/** The scene's workbench cannot be kept up when there is no scene. */
export function splinePanelWanted() {
  return false;
}
