// ---------------------------------------------------------------------------
// THE BUILD STAMP — which build is this, readable from across the room.
//
// A phone in your hand cannot answer "is this the fix, or the build from
// before lunch". The App Store's version field is three taps into Settings,
// the console is a cable away, and a TestFlight-style build list does not
// exist here. So the number is on the glass: the splash and the main menu,
// the two screens every session passes through before anything can go wrong.
//
// It is the SAME NUMBER the phone knows itself by. `npm run ship:phone` puts
// the commit count in CFBundleVersion and passes it to the web build as
// SEAL_BUILD, so what Settings shows and what this draws cannot drift — which
// is the only property that makes the stamp worth trusting at all.
//
// NOT PART OF THE TYPE SYSTEM, on purpose. Every other string on these screens
// is a role in textRoles.js, tunable in the Text panel, and belongs to the
// game's voice. This is an instrument reading. Giving it a role would put it
// in the picker beside "Menu title" as though someone might want to design it,
// and would let a tuning snapshot make it invisible — which is the one failure
// this cannot have, because a stamp you cannot read is worse than no stamp:
// it still looks like it is telling you something.
//
// THE DEFINES ARE READ THROUGH `typeof`. __BUILD_NUMBER__ and __BUILD_ID__ are
// vite `define` substitutions, so they simply do not exist in a Node harness
// that imports this module directly — and a bare reference to an undeclared
// identifier is a ReferenceError, not undefined. Every test that touches a
// menu would fail on a line about a build number.
// ---------------------------------------------------------------------------

/** The commit count the build was made at, or 'dev' from a dev server. */
export const BUILD_NUMBER = typeof __BUILD_NUMBER__ === 'string' ? __BUILD_NUMBER__ : 'dev';

/** The commit it came from — 'abc1234', or 'abc1234-dirty' if it was built
 *  over uncommitted work. Shared with the run records (systems/playtest.js),
 *  so a build on the phone and a run in the collection name the same thing. */
export const BUILD_SHA = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

// Number first: it is the part that increments, so it is the part being
// compared to the last one. The sha is there for the moment the number is not
// enough — two builds off one commit, or a build made over a dirty tree.
export function buildLabel() {
  if (BUILD_NUMBER === 'dev' && BUILD_SHA === 'dev') return 'dev';
  if (BUILD_NUMBER === 'dev') return BUILD_SHA;
  return `${BUILD_NUMBER} · ${BUILD_SHA}`;
}

// Bottom right, inside the safe area on both axes — held sideways, that corner
// is exactly where the home indicator and the rounded glass eat into a phone,
// and 12px from the edge is behind them.
// Exported so the test can read the real declarations: jsdom's CSS engine
// REWRITES env() into nonsense on the way in (`env(0px * , * safe-area-inset-
// right)`), so anything asserted against a jsdom element's cssText is
// asserting against a mangled copy rather than what a phone gets.
export const STAMP_CSS = 'position:absolute; z-index:1;'
  + ' right:calc(12px + env(safe-area-inset-right, 0px));'
  + ' bottom:calc(10px + env(safe-area-inset-bottom, 0px));'
  + ' margin:0; padding:0; pointer-events:none; -webkit-user-select:none; user-select:none;'
  + ' font:500 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;'
  + ' font-variant-numeric:tabular-nums; letter-spacing:0.08em;'
  + ' color:rgba(232,236,243,0.42); text-shadow:0 1px 2px rgba(0,0,0,0.55);';

/**
 * Draws the stamp into `parent` and hands back a handle.
 *
 * The handle's `el` is deliberately exposed: the main menu fades this on the
 * same curve as its button labels, and a stamp still sitting at full strength
 * over the opening shot of a run is litter.
 *
 * @param {HTMLElement} parent
 * @returns {{ el: HTMLElement, text: string, remove: () => void }}
 */
export function mountBuildStamp(parent) {
  const el = (parent?.ownerDocument ?? document).createElement('div');
  el.className = 'sv-build-stamp';
  el.style.cssText = STAMP_CSS;
  el.textContent = buildLabel();
  parent?.appendChild(el);
  return { el, text: el.textContent, remove: () => el.remove() };
}
