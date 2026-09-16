// ============================================================================
// THE CAPTURE SMOKE — a real window, snapped to each 16:9 preset, reporting
// what the OS actually gave back.
//
// Driven by tools/desktop-capture-test.mjs, whose other half is arithmetic.
// This half exists because the arithmetic is not where 16:9 goes wrong: the
// window's minimum size can clamp a content size on the way through,
// setContentSize is ignored outright on a maximized window, and the title bar
// is a different height on every platform. All three produce a window that is
// nearly the right shape, and none of them says anything.
//
// A HIDDEN window with the same minimums the real one has, because the minimum
// is one of the things being tested.
// ============================================================================

import { app, BrowserWindow, screen } from 'electron';
import { registerCapture } from './capture.js';
import { OUTPUT, captureSizeFor, recordedSize, is169 } from './captureSize.js';

// process.exit, not app.exit. app.exit did NOT end this process — the result
// printed and the watchdog still fired twenty seconds later, which in a suite
// is a harness that has already answered and goes on holding the run open.
const say = (payload) => {
  process.stdout.write(`\nSEAL_CAPTURE ${JSON.stringify(payload)}\n`);
  process.exit(payload?.error ? 1 : 0);
};

// A HARNESS THAT HANGS FAILS THE WHOLE RUN AND SAYS NOTHING. This one is in
// `npm run desktop:test`, so a wait that never resolves is a suite that sits
// there forever rather than a test that fails — every wait below is bounded,
// and this is the backstop for the ones nobody thought of.
setTimeout(() => say({ error: 'timed out waiting for the window' }), 20000);

/**
 * The content size once it stops changing, or whatever it is at the deadline.
 * Two frames the same is the settle condition — setContentSize lands over
 * several ticks on macOS and the first read after it is often the old size.
 */
async function settledSize(win, deadlineMs) {
  const until = Date.now() + deadlineMs;
  let last = null;
  while (Date.now() < until) {
    const now = win.getContentSize();
    if (last && last[0] === now[0] && last[1] === now[1] && now[0] > 0) return now;
    last = now;
    await new Promise((r) => setTimeout(r, 100));
  }
  return win.getContentSize();
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 960, minHeight: 600, show: false,
  });

  const capture = registerCapture(win);
  if (!capture) { say({ error: 'capture mode did not register' }); app.exit(1); return; }

  // THE KEYS, through the real before-input-event path. Worth driving rather
  // than assuming: on macOS Option+1 arrives as '¡', so a handler written
  // against input.key matches nothing on the one platform this gets used on,
  // and the symptom is a shortcut that simply does nothing.
  //
  // Needs a document — before-input-event does not fire at a renderer with no
  // page in it — and a data URL is enough; nothing here loads the game.
  await win.loadURL('data:text/html,<title>capture</title>');

  // SEAL_CAPTURE is set by the harness, so the launch flag's own
  // apply lands on ready-to-show. WAITED FOR rather than assumed: it fires
  // after loadURL resolves, so a key test that did not wait would measure the
  // startup size arriving late and read it as its own result — which is a test
  // that passes when the shortcut does nothing at all.
  //
  // POLLED FOR THE RESULT, not awaited on the event. `ready-to-show` fires
  // ONCE, and capture.js has its own `win.once` on it — so by the time this
  // line runs the event may already be spent, and a listener registered here
  // would wait for something that will never happen again. That is a hang
  // rather than a failure, which in a suite is worse: it takes the whole run
  // down with no output at all. Waiting for the SIZE asks about the state
  // instead of the notification, and cannot miss an edge.
  const [startW, startH] = await settledSize(win, 5000);

  // The KEY, through the real before-input-event path. Knocked off the
  // capture size first so landing back on it proves the handler fired, rather
  // than proving the window was already there.
  win.setContentSize(1280, 800);
  const mod = process.platform === 'darwin' ? 'meta' : 'control';
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '1', modifiers: ['alt', mod] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '1', modifiers: ['alt', mod] });
  await new Promise((r) => setTimeout(r, 300));
  const [keyW, keyH] = win.getContentSize();

  // ONE SIZE NOW, not a ladder — see captureSize.js. Applied twice, because
  // the second apply is the one that would expose a size that drifts when it
  // is re-locked (an aspect ratio nudging the frame, a minimum clamping it).
  const results = [];
  for (let i = 0; i < 2; i++) {
    capture.apply();
    const [width, height] = win.getContentSize();
    const [minWidth, minHeight] = win.getMinimumSize();
    const frame = win.getBounds();
    const display = screen.getDisplayMatching(frame);
    const area = display.workArea;
    const shot = recordedSize({ width, height }, display.scaleFactor);
    results.push({
      pass: i, width, height, minWidth, minHeight, square: is169({ width, height }),
      shot, scaleFactor: display.scaleFactor,
      insideX: frame.x >= area.x && frame.x + frame.width <= area.x + area.width,
      insideY: frame.y >= area.y && frame.y + frame.height <= area.y + area.height,
      offCentre: Math.abs((frame.x - area.x) - (area.x + area.width - (frame.x + frame.width))),
    });
  }

  // And back off again — the minimums must come back, or a session that
  // filmed a take is left with a window it cannot resize down afterwards.
  capture.off();
  const [restoredW, restoredH] = win.getMinimumSize();

  say({ results, byFlag: { width: startW, height: startH }, byKey: { width: keyW, height: keyH }, restored: { width: restoredW, height: restoredH } });
});
