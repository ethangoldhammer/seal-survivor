// ============================================================================
// CLOSING THE WINDOW MID-TAKE — the one path that cannot be tested without a
// real BrowserWindow, because the bug is what a DESTROYED one does.
//
// `closed` fires after the native window is gone, and every method on a
// destroyed BrowserWindow throws `Object has been destroyed`. record.js's stop
// handler runs on exactly that event and touches the window (to unpin it), so
// an unguarded call there is an uncaught exception at the moment the player
// quits — which is both the worst time to show one and the hardest to notice
// in testing, because the app is on its way out anyway and the take still
// lands on disk.
//
// Driven by tools/record-test.mjs --live.
// ============================================================================

import { app, BrowserWindow } from 'electron';
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRecorder } from './record.js';

const problems = [];
// The whole point: an unguarded window call lands HERE and nowhere else.
process.on('uncaughtException', (err) => problems.push(String(err?.message ?? err)));

const say = (payload) => {
  process.stdout.write(`\nSEAL_RECORD ${JSON.stringify(payload)}\n`);
  process.exit(0);
};
setTimeout(() => say({ error: 'timed out' }), 20000);

// Electron's DEFAULT is to quit once every window is closed — on macOS too;
// the convention of staying alive is something an app implements, and
// electron/main.js does. Without this the close below ends the process before
// the report is written, and the harness looks like it produced no output when
// what actually happened is that it was never asked a question.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 640, height: 360 });
  const rec = createRecorder(win);

  const file = rec.start();
  if (!file) { say({ error: 'the recorder would not start' }); return; }

  const pinned = win.isMovable();
  // Raised above everything for the take — see the note in record.js. Without
  // it a rectangle films whatever happens to be over the game, and the take is
  // ruined by a notification nobody remembers arriving.
  const raised = win.isAlwaysOnTop();
  await new Promise((r) => setTimeout(r, 1500));

  // THE MOMENT UNDER TEST.
  win.close();

  // Long enough for screencapture to finalise the file it was interrupted in.
  await new Promise((r) => setTimeout(r, 1500));

  // NO ORPHAN. The bug that stranded a screencapture on the user's screen was
  // an exception in stop() that ran BEFORE the kill — so the take "worked",
  // nothing looked wrong, and the machine was left with a dimmed screen and a
  // selection rectangle that nothing would clear. Counted rather than
  // inspected: any screencapture still alive after this harness has finished
  // is one this harness started.
  const alive = spawnSync('pgrep', ['-f', 'screencapture -v -R'], { encoding: 'utf8' })
    .stdout.split('\n').filter(Boolean).length;

  say({
    problems,
    pinnedWhileFilming: pinned === false,
    raisedWhileFilming: raised === true,
    // Both must come back, or the game is left welded over every other window
    // on the machine — a worse bug than the one it prevents.
    restoredMovable: win.isDestroyed() ? null : win.isMovable(),
    restoredOnTop: win.isDestroyed() ? null : win.isAlwaysOnTop(),
    orphans: alive,
    file,
    wrote: existsSync(file) && statSync(file).size > 0,
  });
});
