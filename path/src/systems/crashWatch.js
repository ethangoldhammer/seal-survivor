// ---------------------------------------------------------------------------
// CATCHING A CRASH THAT LEAVES NO STACK TRACE.
//
// On iOS the game does not crash — the page does. WKWebView runs the web
// content in its own process with its own memory ceiling, well below the app's,
// and when iOS kills it Capacitor's WebViewDelegationHandler does exactly this:
//
//     open func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
//         CAPLog.print("⚡️  WebView process terminated")
//         bridge?.reset()
//         webView.reload()
//     }
//
// The app never dies. The page is simply reloaded under it, so from the
// player's side the run vanishes and the title card comes back — a "reset".
// From the code's side it is worse than a crash: every variable, every counter
// and the entire in-progress playtest record go with the process, and the next
// thing that runs is a cold boot that has no idea anything happened. There is
// no exception to catch, no unload event, no beforeunload — the process is gone
// between one frame and the next.
//
// So the only place a crash can leave a message is somewhere OUTSIDE the
// process, and localStorage is the one such place a page can write to cheaply.
// This module keeps a beacon there: refreshed every couple of seconds while a
// run is live, deleted the moment a run ends properly. A beacon still present
// at boot therefore means exactly one thing — the last run did not end, it was
// killed — and it carries the last census taken before the lights went out.
//
// WHY THE CENSUS IS THE POINT, not the fact of the crash. `heapPeakMB` reads 0
// on every iOS run because Safari does not implement performance.memory, which
// left the ledger blind to the one number that would explain a memory kill.
// renderer.info is the substitute available everywhere: textures, programs and
// geometries are the three things this game accumulates without bound, and a
// beacon showing 900 textures at death against a healthy run's 300 names the
// culprit without anyone holding a USB cable.
//
// NOT sessionStorage, which is scoped to the tab and would survive this fine —
// but a WebContent kill takes the session storage with it on some iOS versions,
// and the whole value of this file is being readable after the worst case.
// ---------------------------------------------------------------------------

const KEY = 'seal-survivor-crash-beacon';

// Refresh interval. Every frame would be 60 localStorage writes a second, each
// one a synchronous serialise-and-store on the main thread — a measurable
// stall in aid of resolution nobody needs. Two seconds bounds how stale the
// census can be at the moment of death, which is the only accuracy that
// matters here.
const BEAT_MS = 2000;

let lastBeat = 0;
let armed = false;

/** localStorage throws in private mode and when the quota is gone. Never let
 *  the instrument be the thing that ends the run it is watching. */
function write(value) {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* a beacon we cannot write is a diagnosis we do not get — nothing more */
  }
}

function clear() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* see write() */
  }
}

/**
 * Read and CLEAR any beacon left by a previous session.
 *
 * Cleared on read, deliberately: a beacon that survived its own claim would be
 * reported again after the next clean run and every run after that, turning
 * one real crash into a permanent phantom in the ledger.
 *
 * @returns the last census before the kill, or null if the last run ended
 *          properly (or there was no last run).
 */
export function claimCrash() {
  let raw = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  clear();
  try {
    const beacon = JSON.parse(raw);
    // A beacon with no elapsed time is a run that died during boot, before the
    // first beat. Still worth reporting — that is its own bug — but it must
    // not be mistaken for a run that reached zero seconds and stopped.
    return { ...beacon, claimedAt: Date.now() };
  } catch {
    // Corrupt beacon. The fact that one existed is still the signal, so say so
    // rather than returning null and reporting the crash as a clean run.
    return { corrupt: true, claimedAt: Date.now() };
  }
}

/** Begin watching. Called where the run starts, next to perfRunStart. */
export function armCrash() {
  armed = true;
  lastBeat = 0;
}

/**
 * Stop watching and delete the beacon. Called on every path that ENDS a run
 * properly — death, restart, quit. Anything that ends a run without coming
 * through here will be reported as a crash, which is the correct default: a
 * missed disarm shows up as a false positive in the ledger, whereas a missed
 * arm loses a real crash silently.
 */
export function disarmCrash() {
  armed = false;
  clear();
}

/**
 * Refresh the beacon, at most once per BEAT_MS. Safe to call every frame.
 *
 * @param census  a flat object of whatever is worth knowing at death — this
 *                module deliberately does not reach for renderer.info itself,
 *                because the caller already holds it and reading it twice a
 *                frame from two places is how the two readings drift.
 */
export function crashBeat(census) {
  if (!armed) return;
  const now = Date.now();
  if (now - lastBeat < BEAT_MS) return;
  lastBeat = now;
  write({ at: now, ...census });
}
