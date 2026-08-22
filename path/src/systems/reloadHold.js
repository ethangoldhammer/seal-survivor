// Holding the dev server's full page reload still.
//
// Nothing in this app accepts a hot update, so an edit ANYWHERE in the tree
// falls through to a full reload. That throws away the run in progress and
// leaves nothing behind: the recorder only writes at endRun (systems/
// playtest.js), so a page that reloads mid-run discards the whole record
// rather than truncating it. With more than one agent editing the repo at
// once that is not an occasional annoyance — it is the reason a playtest
// "cuts off and reloads" with no trace of it in playtest/runs.jsonl.
//
// TWO INDEPENDENT OWNERS, ONE LATCH. The stage bar holds while it is open, and
// a recorded run holds for as long as it lasts. They overlap constantly,
// because staging an effect and then playing it is the normal way to use the
// bar. A plain boolean loses that overlap: closing the bar mid-run would
// release a hold the run still needs, and the next save would reload the page
// out from under it. So holders are counted by name and the latch follows
// whether the SET is empty, not whatever released last.
//
// The latch itself lives in the dev server (reloadHold in vite.config.js)
// because the browser cannot win this one — Vite awaits its
// `vite:beforeFullReload` listeners through Promise.allSettled, so the usual
// advice of throwing from a listener is swallowed and the page reloads
// regardless. All this side does is ask, and report what piled up.
//
// import.meta.hot is undefined in a production build, in the jsdom harness and
// in a plain Node import, so every export here is a no-op outside `npm run
// dev`. That is deliberate: this file is on the import path of playtest.js,
// which the terminal tools load without a bundler.

const holders = new Set();
const staleListeners = new Set();

// Last thing the server told us piled up. Kept here rather than in the badge
// so a listener that binds AFTER the report still sees it — the stage bar is
// built during boot, but a run can start holding before anything is watching.
let stale = { count: 0, files: [] };

function send() {
  import.meta.hot?.send('stage:hold', { hold: holders.size > 0 });
}

/**
 * Ask the dev server to swallow full reloads while `who` needs the page to sit
 * still. Idempotent per holder — calling it twice with the same name is one
 * hold, and releasing a name that never held is a no-op.
 *
 * @param who  a stable name for the holder ('stage', 'run')
 * @param on   whether that holder needs the page held
 */
export function holdReloads(who, on) {
  const before = holders.size > 0;
  if (on) holders.add(who);
  else holders.delete(who);
  const after = holders.size > 0;
  // Only on the edges. The server resets its pending set when the latch is
  // released, so re-sending `hold: false` while already released would throw
  // away a staleness report the badge has not shown yet.
  if (before !== after) send();
}

/** Whether anything is currently holding the page still. */
export function isHolding() {
  return holders.size > 0;
}

/** What the server has swallowed and not yet reloaded for. */
export function stalePage() {
  return stale;
}

/**
 * Notified whenever the swallowed-edit count changes, including the report the
 * server sends on RELEASE — releasing the latch does not un-swallow anything,
 * so a page that held through a run is still stale when the run ends.
 */
export function onStalePage(fn) {
  staleListeners.add(fn);
  fn(stale);
  return () => staleListeners.delete(fn);
}

import.meta.hot?.on('stage:pending', ({ count, files }) => {
  stale = { count: count ?? 0, files: files ?? [] };
  for (const fn of staleListeners) fn(stale);
});

// A reconnect is a fresh server (or a fresh page): the server clears its latch
// on every new websocket connection, so anything still holding here has to say
// so again or it is holding nothing.
import.meta.hot?.on('vite:ws:connect', () => {
  if (holders.size > 0) send();
});
