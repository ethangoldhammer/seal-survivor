// ============================================================================
// 16:9 FOR THE TRAILER — the window half.
//
// A screen capture of this window is only usable in an edit if the window is
// the shape the edit is: anything else has to be cropped, and cropping a game
// that has already composed its HUD to the window's edges throws the HUD away.
// So rather than crop afterwards, the window is made exactly 16:9 before the
// recording starts, and LOCKED there so a stray drag on the corner cannot walk
// it off mid-take.
//
//   Cmd/Ctrl + Alt + 1 … 4   snap to a 16:9 size and lock the aspect
//   Cmd/Ctrl + Alt + 0       unlock, back to a window that resizes freely
//   Cmd/Ctrl + Alt + R       start / stop filming the window — see record.js
//
// Add `--audio` for the game's sound through BlackHole (`npm run audio` lists
// the device ids); without it a take is silent, because the only source macOS
// offers unasked is the microphone.
//
// or `npm run desktop -- --capture` to start a session already locked, which is
// what you want when the take is the first thing you do, and `--record` beside
// it to film the whole session without touching anything.
//
// ---------------------------------------------------------------------------
// WHY NOT FULLSCREEN, which is the obvious answer.
//
// Because no Mac laptop is 16:9. Fullscreen on a 14" MacBook Pro is 16:10, and
// the game fills it — correctly, and unusably for a 16:9 edit. Shift+F in the
// game does the same thing. Fullscreen is the right way to PLAY and the wrong
// way to film; this is windowed on purpose.
//
// ---------------------------------------------------------------------------
// NOT IN A MENU, and no on-screen indicator.
//
// A menu item is a string a player reads, and this is not for players — the
// keys are live unpackaged (where Ethan films) and, in a packaged build, only
// behind the launch flag. An indicator would be worse still: it would be in
// the shot. The confirmation is a console line with the numbers that actually
// matter, which is also where the crop rectangle for OBS comes from.
// ============================================================================

import { app, screen } from 'electron';
import { OUTPUT, captureSizeFor, playSizeFor, recordedSize, fitCapture, is169 } from './captureSize.js';
import { createRecorder, sweepUnfinished } from './record.js';
import { BLACKHOLE_UID } from './takeFile.js';

const RATIO = 16 / 9;

// Unpackaged this is always live — that is the build the trailer is filmed
// from. Packaged it takes the flag, so a player who happens to press
// Cmd+Alt+2 gets nothing rather than a window that jumps.
export function captureEnabled(argv = process.argv, env = process.env) {
  return !app.isPackaged || argv.some((a) => a.startsWith('--capture')) || !!env.SEAL_CAPTURE;
}

/**
 * Whether this session is a filming session.
 *
 * NO SIZE ARGUMENT ANY MORE. There is exactly one window size that records at
 * 1920x1080 on a given display and captureSize.js derives it, so a size here
 * could only ever be a way to ask for a file that is not 1080p. `--capture=W`
 * is still accepted and ignored, with a word about why, because it was the
 * documented spelling for a while and silently doing something else would be
 * worse than saying so.
 */
export function wantsCapture(argv = process.argv, env = process.env) {
  const flag = argv.find((a) => a === '--capture' || a.startsWith('--capture='));
  if (flag?.includes('=')) {
    console.warn(`[capture] ignoring ${flag} — the window size is whatever records at `
      + `${OUTPUT.width}x${OUTPUT.height} on this display, and nothing else will`);
  }
  return !!flag || !!env.SEAL_CAPTURE || wantsRecord(argv, env);
}

/** `--record`, or SEAL_RECORD in the environment. */
export function wantsRecord(argv = process.argv, env = process.env) {
  return argv.includes('--record') || !!env.SEAL_RECORD;
}

/**
 * Which audio device a take records from, or null for a silent one.
 *
 *   --audio              BlackHole, the usual answer — see BLACKHOLE_UID
 *   --audio=<uid>        any other CoreAudio device, BY UID not by name
 *   (nothing)            no sound
 *
 * SILENT BY DEFAULT, deliberately. The only device macOS will hand you without
 * setup is the microphone, and a trailer take with the room on it is worse
 * than one with nothing — you would not notice until the edit, and by then the
 * take is spent.
 */
export function audioSource(argv = process.argv, env = process.env) {
  const flag = argv.find((a) => a === '--audio' || a.startsWith('--audio='));
  const raw = flag?.includes('=') ? flag.split('=').slice(1).join('=') : (flag ? '' : env.SEAL_AUDIO ?? null);
  if (raw === null || raw === undefined) return null;
  return raw.trim() || BLACKHOLE_UID;
}

export function registerCapture(win) {
  if (!captureEnabled()) return null;

  // The window's own minimums, kept so `off` can put them back. They are 960
  // x600 — a 4:3-ish floor that is NOT 16:9, and while capture mode is on it
  // has to go, or the OS clamps a small display's window up to 960x600 and the
  // careful arithmetic in captureSize.js is overruled by a constraint set in
  // main.js. That clamp does not throw and does not log; the window is simply
  // the wrong shape.
  const [minW, minH] = win.getMinimumSize();
  let locked = false;
  sweepUnfinished();
  const recorder = createRecorder(win, { audio: audioSource() });

  function off() {
    // A take in progress ends here rather than carrying on into a window that
    // is about to become resizable again.
    recorder.stop();
    locked = false;
    win.setAspectRatio(0);
    win.setMinimumSize(minW, minH);
    console.log('[capture] aspect unlocked');
  }

  function apply() {
    // setContentSize is IGNORED on a maximized or fullscreen window — it
    // returns nothing and changes nothing — so leave both first. Native
    // fullscreen leaves with an animation, so the size has to wait for the
    // event rather than being set on the next line, where it would land while
    // the window was still full and be dropped.
    if (win.isFullScreen()) {
      win.once('leave-full-screen', () => apply());
      win.setFullScreen(false);
      return;
    }
    if (win.isMaximized()) win.unmaximize();

    const display = screen.getDisplayMatching(win.getBounds());
    // What is left for the CONTENT after the OS's own furniture. Measured as
    // the difference between the two bounds rather than assumed: it is 0 on the
    // frameless window a filming session opens, ~32pt on a framed one, and
    // something else again on Windows.
    const chromeH = win.getSize()[1] - win.getContentSize()[1];
    const chromeW = win.getSize()[0] - win.getContentSize()[0];

    const want = playSizeFor(display.scaleFactor, {
      width: display.workArea.width - chromeW,
      height: display.workArea.height - chromeH,
    });
    if (want.exact === false) {
      console.warn(`[capture] this display reports a scale of ${display.scaleFactor}, which does not `
        + `divide ${OUTPUT.width}x${OUTPUT.height} — takes will be ${recordedSize(want, display.scaleFactor).width}`
        + `x${recordedSize(want, display.scaleFactor).height}, not ${OUTPUT.height}p`);
    }

    const avail = {
      width: display.workArea.width - chromeW,
      height: display.workArea.height - chromeH,
    };
    const size = fitCapture(want, avail);
    if (size.fitted) {
      console.warn(`[capture] ${want.width}x${want.height} does not fit this display `
        + `(${avail.width}x${avail.height} of content) — using ${size.width}x${size.height}, `
        + `which will NOT record at ${OUTPUT.width}x${OUTPUT.height}`);
    }

    // Minimum first, so the setContentSize below cannot be clamped by the old
    // one on the way through.
    win.setMinimumSize(size.width, size.height + chromeH);
    win.setAspectRatio(RATIO, { width: chromeW, height: chromeH });
    win.setContentSize(size.width, size.height);
    centre(display);
    locked = true;
    report(win, display);
  }

  /**
   * Put the window in the middle of the screen it is on.
   *
   * setContentSize GROWS FROM THE ORIGIN — the top-left corner stays where it
   * was and the other two edges move out — so snapping a window that was
   * sitting anywhere right of centre pushes its right edge off the display.
   * The window is still exactly 16:9 and the capture rect is still correct;
   * it is the part you cannot SEE that is missing, which is why this reads as
   * "it opens cut off" rather than as a wrong size.
   *
   * Against workArea, not the display's full bounds: `bounds` includes the
   * space under the menu bar and behind the dock, and centring in it puts a
   * 16:9 window's top edge behind the menu bar on every snap.
   *
   * Explicit arithmetic rather than win.center(), which centres on the screen
   * rather than the work area and is a different answer on a Mac with a dock.
   */
  function centre(display) {
    const area = display.workArea;
    const frame = win.getBounds();
    win.setPosition(
      Math.round(area.x + (area.width - frame.width) / 2),
      Math.round(area.y + (area.height - frame.height) / 2),
    );
  }

  // FILMING IS REFUSED WHILE UNLOCKED, rather than allowed with a warning.
  // The whole point of the file is that it needs no crop, and a take of a
  // window that happens to be 1728x1117 is one nobody will notice is wrong
  // until it is on a 16:9 timeline with bars down the sides.
  function film() {
    if (!locked && !recorder.recording()) {
      console.warn('[record] not filming — the window is not locked to 16:9 yet (Cmd/Ctrl+Alt+1)');
      return;
    }
    recorder.toggle();
  }

  win.webContents.on('before-input-event', (event, input) => {
    // input.code, NOT input.key: on macOS Option+1 is '¡', Option+2 is '™' and
    // so on, so a handler written against `key` matches nothing on the one
    // platform this is being used on. `code` is the physical key.
    if (input.type !== 'keyDown' || !input.alt || !(input.meta || input.control)) return;
    if (input.code === 'KeyR') { event.preventDefault(); film(); return; }
    if (input.code === 'Digit1') { event.preventDefault(); apply(); return; }
    if (input.code === 'Digit0') { event.preventDefault(); off(); }
  });

  // Belt and braces for the thing that would ruin a take silently: if anything
  // ever resizes the window off 16:9 while locked, say so rather than let it
  // be discovered in the edit.
  win.on('resize', () => {
    if (!locked) return;
    const [w, h] = win.getContentSize();
    if (!is169({ width: w, height: h })) console.warn(`[capture] window is ${w}x${h} — not 16:9`);
  });

  if (wantsCapture()) win.once('ready-to-show', () => apply());

  // --record films the whole session. Deferred past apply()'s setContentSize
  // rather than started beside it: that call fires a `resize`, and record.js
  // treats a resize during a take as a ruined take — correctly — so starting
  // on the same tick would stop itself immediately.
  if (wantsCapture() && wantsRecord()) win.once('ready-to-show', () => setImmediate(film));

  return { apply, off, film, recorder };
}

// The one number that matters before you film: what the FILE will be. The
// window's own size is the means, not the point, so it is reported second.
//
// CONTENT only. The take is a rectangle over the content bounds (see the note
// in takeFile.js), so the title bar is outside it and must not be counted —
// an earlier version of this line added the chrome and reported 1920x1144 for
// a window that was recording perfectly at 1920x1080.
function report(win, display) {
  const [w, h] = win.getContentSize();
  const s = display.scaleFactor;
  const shot = recordedSize({ width: w, height: h }, s);
  const native = shot.width === OUTPUT.width && shot.height === OUTPUT.height;
  const how = native ? '' : ` (captured at ${shot.width}x${shot.height}, scaled down after the take)`;
  console.log(`[capture] takes will be ${OUTPUT.width}x${OUTPUT.height}${how}  — window ${w}x${h} @${s}x`);
}
