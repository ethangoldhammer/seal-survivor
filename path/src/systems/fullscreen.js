// ---------------------------------------------------------------------------
// FULLSCREEN — the browser chrome, gone.
//
// A file of its own rather than the private helper it used to be in main.js,
// because there are two callers now and they cannot see each other: the Shift+F
// key (main.js) and the touch button in the corner (ui/fullscreenButton.js).
// A second copy of the prefix dance would be a copy that drifts, and the way it
// drifts is silent — a missed webkit prefix reads as "not fullscreen", so every
// press re-requests instead of exiting.
//
// WHY A PHONE NEEDS THIS AT ALL. Held sideways, mobile Safari keeps a bar of
// its own over the bottom of the page and the page is sized around it: the game
// is drawn correctly into a viewport that is simply shorter than the glass, so
// the bottom of the HUD sits under browser furniture and nothing about it looks
// like a bug the game could fix from the inside. Fullscreen is the only thing
// that actually hands the whole display over.
//
// THE CAPABILITY IS ASKED, NEVER ASSUMED. Element fullscreen did not exist on
// iPhone for most of this game's life — the API was absent outright, not merely
// refused — so a button drawn on faith is a dead control on exactly the device
// that most wants it. Everything here answers honestly on a shell that cannot
// do it, and the button asks before it draws itself.
// ---------------------------------------------------------------------------

/** The element that goes fullscreen: the whole document, never the canvas.
 *
 *  The HUD, the pause menu and the callout band are all appended to
 *  document.body (see ui/ui.js) rather than to the renderer's container, so
 *  fullscreening #root alone would show the ocean with every overlay clipped
 *  away — which looks exactly like the overlays failing to draw. */
function target() {
  return typeof document === 'undefined' ? null : document.documentElement;
}

/**
 * Can this shell put the game on the whole display?
 *
 * A capability rather than an identity, the way platform.js asks its questions:
 * what matters is not which browser this is but whether the request would do
 * anything, and the answer is false inside an iframe that was embedded without
 * `allowfullscreen` as well as on a browser that never implemented it.
 */
export function fullscreenAvailable() {
  const el = target();
  if (!el) return false;
  if (typeof (el.requestFullscreen ?? el.webkitRequestFullscreen) !== 'function') return false;
  // Present and FALSE is a real answer — an embed that disallows it — while
  // absent is an old engine that never shipped the flag alongside a request
  // method that works. Only the first is a no.
  const enabled = document.fullscreenEnabled ?? document.webkitFullscreenEnabled;
  return enabled !== false;
}

/** Are we in it right now? */
export function isFullscreen() {
  if (typeof document === 'undefined') return false;
  return !!(document.fullscreenElement ?? document.webkitFullscreenElement);
}

/**
 * Go in, or come back out. MUST be called from a real user gesture — every
 * engine refuses otherwise, and iOS refuses silently enough that a handler
 * called a frame later looks like a dead button.
 *
 * world.js already listens for `resize`, which fires on the way in and on the
 * way out, so the camera and the drawing buffer need nothing from here.
 */
export function toggleFullscreen() {
  return isFullscreen() ? exitFullscreen() : enterFullscreen();
}

export function enterFullscreen() {
  const el = target();
  if (!el) return false;
  const request = el.requestFullscreen ?? el.webkitRequestFullscreen;
  if (typeof request !== 'function') return false;
  // Rejects when the gesture isn't trusted or the embed disallows it. Nothing
  // to recover — the run carries on windowed — but swallowing it silently would
  // make an iframe that blocks fullscreen look like a dead control.
  try {
    request.call(el)?.catch?.((err) => console.warn('[fullscreen]', err?.message ?? err));
  } catch (err) {
    console.warn('[fullscreen]', err?.message ?? err);
    return false;
  }
  return true;
}

export function exitFullscreen() {
  if (typeof document === 'undefined') return false;
  const exit = document.exitFullscreen ?? document.webkitExitFullscreen;
  if (typeof exit !== 'function') return false;
  try {
    exit.call(document)?.catch?.((err) => console.warn('[fullscreen]', err?.message ?? err));
  } catch (err) {
    console.warn('[fullscreen]', err?.message ?? err);
    return false;
  }
  return true;
}

/**
 * Tell me when it changes — including when the PLAYER changes it, which is the
 * case a button cannot see any other way: every platform has its own way out
 * (a swipe from the edge, Escape, the browser's own control), and a glyph still
 * showing "exit" over a windowed game is a control lying about its own state.
 *
 * Both event names, unprefixed and webkit-, because Safari fires only the
 * second. Hands back an unsubscribe.
 */
export function onFullscreenChange(fn) {
  if (typeof document === 'undefined') return () => {};
  const handler = () => fn(isFullscreen());
  for (const type of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(type, handler);
  }
  return () => {
    for (const type of ['fullscreenchange', 'webkitfullscreenchange']) {
      document.removeEventListener(type, handler);
    }
  };
}
