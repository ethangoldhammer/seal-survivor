// ============================================================================
// WHAT THE PAGE WAS DOING WHEN IT STOPPED.
//
// On a desktop browser a JavaScript error is a red line in a console somebody
// is already looking at. On a phone in a native shell there is no console at
// all, and the two ways a run can end badly look IDENTICAL from the outside:
//
//   1. something threw — the frame loop dies, the picture freezes;
//   2. the WebContent process was killed — WebKit reloads the page from
//      scratch, and the game is suddenly back at the title as if the app had
//      restarted itself.
//
// The second one leaves nothing behind. No error fires, no handler runs, no
// crash report is written by the system for the APP (the app never died — its
// web view did), and the run that was in progress is simply gone: even
// playtest.js's 'interrupted' path cannot catch it, because that runs on
// pagehide and a killed process gets no pagehide.
//
// So this keeps a breadcrumb trail in localStorage — synchronous, already on
// disk before the process dies — and reads it back on the NEXT boot. A session
// that never closed itself is a session that was cut off, and the last
// breadcrumb says where. That is the difference between "it crashed somewhere"
// and "it was three frames into the kill shot".
//
// LOCALSTORAGE IS THE DURABLE SINK, and it has to be: nothing asynchronous can
// be trusted to complete on a process that is about to be killed. The
// Capacitor file write below is not the record, it is a COPY of the record,
// made at leisure on the next launch so the whole thing can be pulled off the
// phone over the cable:
//
//   npm run crash
//
// EVERY MARK IS WRITTEN, with no throttle between them, and that is the whole
// design rather than an oversight. A trail batched behind a timer is a trail
// whose LAST entry — the only one that ever matters — is the one still in
// memory when the process is killed. There are a handful of marks in a run,
// not one per frame, so the cost of honesty here is a few setItem calls of
// about a kilobyte across several minutes of play.
// ============================================================================

const KEY = 'sv.crash.v1';       // the session in flight
const LOG_KEY = 'sv.crash.log';  // what earlier sessions ended as
const CRUMBS = 40;               // how much trail is kept — see the heartbeat in main.js
const KEEP_REPORTS = 6;          // how many past endings are kept

let session = null;
let store = null;
let target = null;
let installed = false;

function clock() {
  try {
    return Math.round(globalThis.performance?.now?.() ?? 0);
  } catch {
    return 0;
  }
}

function buildId() {
  try {
    return typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'unknown';
  } catch {
    return 'unknown';
  }
}

function read(key) {
  try {
    const raw = store?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    store?.setItem(key, JSON.stringify(value));
  } catch {
    // A full quota or a private window. The diagnostic is the first thing that
    // should be dropped when storage is tight, never the thing that throws.
  }
}

/**
 * WHAT AN OLD SESSION TURNED OUT TO BE. Pure, and exported for the test: this
 * is the only part of the file with an answer that can be wrong.
 *
 * 'clean'  — the page said goodbye (pagehide), which is a reload, a navigation
 *            or the app being closed properly.
 * 'error'  — something threw or rejected and was never survived.
 * 'cut'    — the record was left open. Nothing ran after the last breadcrumb,
 *            so the process went away underneath it.
 *
 * A 'cut' that happened while the app was in the BACKGROUND is reported as
 * such rather than as a crash: iOS reclaims a backgrounded web view routinely,
 * and calling that a crash would bury the real ones in noise.
 */
export function verdictFor(prev) {
  if (!prev || typeof prev !== 'object') return null;
  const crumbs = Array.isArray(prev.crumbs) ? prev.crumbs : [];
  const last = crumbs[crumbs.length - 1] ?? null;
  const kind = prev.err ? 'error' : prev.open === false ? 'clean' : prev.hidden ? 'cut-bg' : 'cut';
  return {
    kind,
    at: prev.at ?? 0,
    build: prev.build ?? 'unknown',
    // The breadcrumb the session never got past — the whole point of the file.
    tag: last?.tag ?? null,
    // How long it had been running when the trail stopped, in seconds, which
    // is what makes a report comparable to a playtest run's duration.
    upSeconds: last ? Math.round(last.t / 100) / 10 : 0,
    err: prev.err ?? null,
    crumbs,
  };
}

function flush() {
  if (!session) return;
  write(KEY, session);
}

/**
 * A breadcrumb. `tag` is a short stable key — 'run:start', 'boss:defeated',
 * 'shot:capture' — and NOT a sentence: these are read back as a trail, and a
 * trail of prose is unreadable at twenty entries.
 */
export function mark(tag, extra) {
  if (!session) return;
  const crumb = { t: clock(), tag };
  if (extra !== undefined) crumb.d = extra;
  session.crumbs.push(crumb);
  if (session.crumbs.length > CRUMBS) session.crumbs.shift();
  flush();
}

function fail(err, how) {
  if (!session) return;
  session.err = {
    how,
    msg: String(err?.message ?? err ?? 'unknown'),
    // Two frames of stack, not the whole thing: the file is read on a terminal
    // and the top of the stack is the part that names the code.
    at: String(err?.stack ?? '').split('\n').slice(0, 3).join(' | '),
  };
  flush();
}

/**
 * Install the trail. Call this FIRST, before anything else in the boot, so a
 * throw from the boot itself is inside it.
 *
 * @returns the verdict on the PREVIOUS session, or null if there wasn't one.
 */
export function initCrashLog(opts = {}) {
  if (installed) return null;
  store = opts.storage ?? globalThis.localStorage ?? null;
  target = opts.target ?? globalThis.window ?? null;
  if (!store) return null;
  installed = true;

  const prev = verdictFor(read(KEY));
  if (prev && prev.kind !== 'clean') {
    const log = read(LOG_KEY);
    const list = Array.isArray(log) ? log : [];
    list.push(prev);
    while (list.length > KEEP_REPORTS) list.shift();
    write(LOG_KEY, list);
    // The one line a developer with a cable sees without pulling anything.
    console.warn(`[crash] last session ended '${prev.kind}' at '${prev.tag}' (${prev.upSeconds}s)`,
      prev.err ?? '');
  }

  session = { v: 1, at: Date.now(), build: buildId(), open: true, hidden: false, crumbs: [], err: null };
  flush();

  target?.addEventListener?.('error', (e) => fail(e?.error ?? e?.message, 'error'));
  target?.addEventListener?.('unhandledrejection', (e) => fail(e?.reason, 'rejection'));
  // pagehide and not beforeunload: iOS fires pagehide reliably and
  // beforeunload not at all, and a "clean" that only ever fires on desktop
  // would report every normal phone reload as a crash.
  target?.addEventListener?.('pagehide', () => { session.open = false; flush(); });
  target?.document?.addEventListener?.('visibilitychange', () => {
    session.hidden = target.document.visibilityState === 'hidden';
    mark(session.hidden ? 'app:hidden' : 'app:shown');
  });

  mark('boot');
  copyToDevice();
  return prev;
}

/** Every ending kept, newest last. The file written to the device, and the test's subject. */
export function crashReports() {
  const log = read(LOG_KEY);
  return Array.isArray(log) ? log : [];
}

// A COPY, on the next launch, of what is already safely in localStorage — see
// the header. Written to Documents/ because that is the one directory
// `devicectl device copy from` can reach over the cable, which is what makes
// this readable without Xcode, without Safari and without the phone being
// unlocked in front of anybody.
function copyToDevice() {
  if (!globalThis.window?.Capacitor?.isNativePlatform?.()) return;
  const reports = crashReports();
  if (!reports.length) return;
  import('@capacitor/filesystem')
    .then(({ Filesystem, Directory, Encoding }) => Filesystem.writeFile({
      path: 'crash.json',
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
      data: JSON.stringify({ build: buildId(), written: Date.now(), reports }, null, 2),
    }))
    .catch((err) => console.warn('[crash] could not write the report —', err?.message ?? err));
}

/** Test seam: forget everything this module is holding in memory. */
export function __resetCrashLog() {
  session = null;
  store = null;
  target = null;
  installed = false;
}
