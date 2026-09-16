// ============================================================================
// FILMING THE WINDOW, AND NOTHING ELSE.
//
// `screencapture -v -l <windowid> -o` — the window's own surface, with the
// compositor's shadow and rounded corners left off.
//
// THE REJECTED ALTERNATIVE, which this used to be. `-R x,y,w,h` films a screen
// RECTANGLE: exactly the right size, and it captures whatever pixels are in
// that rectangle. A notification, the Dock, another app raised over the game —
// all of it lands in the take. Measured with a red window held over a green
// one: the rect came back 13% red, the window capture 100% green, still
// filming the game while the red window had focus.
//
// `-o` is the whole reason a window capture is usable at all. Without it the
// file is 2144x1368 around a 1920x1080 window — the shadow and the transparent
// margin — which is the black border that made a rectangle look like the
// better answer in the first place.
//
// ---------------------------------------------------------------------------
// WHY THE BUILT-IN TOOL AND NOT ffmpeg.
//
// Because it is already here. ffmpeg would mean a dependency on a machine that
// does not have one, a device index to discover, and an avfoundation capture
// path that is a second thing to be wrong; `screencapture` ships with the OS,
// is hardware-encoded, and needs the same Screen Recording permission either
// way. The one thing it cannot do is system audio — see the note on `-g` below.
//
// ---------------------------------------------------------------------------
// THE FAILURE THIS GUARDS, because it is silent and it ruins a whole take.
//
// MOVING THE WINDOW MID-TAKE CORRUPTS THE RECORDING. A window capture does not
// simply follow the window: measured, a take whose window was moved 1.2s in
// read 65% BLACK at three seconds, with the game squeezed into the remaining
// third of the frame. (Occlusion is fine — a window held over the game is
// excluded cleanly, and the take carries on. It is the MOVE that breaks it.)
//
// So the window is pinned for the duration (setMovable below), and a move or
// resize that gets through anyway stops the take, loudly, with the part that
// was already good still on disk.
// ============================================================================

import { app, screen, shell } from 'electron';
import { spawn, execFile } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { OUTPUT } from './captureSize.js';
import { RECORDINGS, takeName, captureArgs, BLACKHOLE_UID } from './takeFile.js';

export { RECORDINGS, takeName, captureArgs, BLACKHOLE_UID } from './takeFile.js';

/**
 * Scale a finished take down to exactly 1920x1080, in place.
 *
 * A window big enough to PLAY in is bigger than the one that captures natively
 * at 1080p, so the take comes off the screen at 2560x1440 and has to come back.
 * avconvert ships with macOS and does it at about a fifth of real time — a ten
 * second take took 2.1s.
 *
 * ITS PRESETS ARE CEILINGS, NOT TARGETS, which is worth knowing before trusting
 * this: `Preset1920x1080` scales 2560x1440 down correctly and leaves a
 * 1920x1144 source completely untouched, because the width is already at the
 * limit. So it can only be relied on when the source is genuinely larger in
 * BOTH axes — which a whole-multiple capture always is.
 *
 * The original is replaced only once the new file exists, so a failed pass
 * leaves the oversized take rather than nothing at all.
 */
function toOutputSize(file, done) {
  const scaled = `${file}.1080.mov`;
  // DETACHED, and unref'd. The take usually ends BECAUSE the game is quitting,
  // so the scaling would otherwise be killed a few milliseconds after it
  // started and leave an oversized file — which is exactly what happened the
  // first time: 2560x1440 on disk, no error, and a log that stopped mid-line.
  // Detaching lets it finish in the seconds after the app is gone.
  //
  // A leftover avconvert is harmless in a way a leftover screencapture is not
  // (it holds nothing, touches no input, and exits on its own), which is why
  // this is allowed to outlive the app and the recorder is not.
  const proc = spawn('/usr/bin/avconvert', [
    '--source', file, '--output', scaled,
    '--preset', `Preset${OUTPUT.width}x${OUTPUT.height}`, '--replace',
  ], { detached: true, stdio: 'ignore' });
  proc.unref();

  // Renamed by a watcher rather than inside the child, because the child is a
  // system binary and cannot be asked to do it: poll for the scaled file to
  // stop growing, then swap it in. Only runs while this process is alive; if
  // the app quit first, `finish` below does it on the next launch.
  proc.on('exit', (code) => {
    if (code !== 0) {
      console.warn(`[record] could not scale to ${OUTPUT.width}x${OUTPUT.height} — keeping the take as filmed`);
      done(file);
      return;
    }
    try { renameSync(scaled, file); done(file); } catch { done(scaled); }
  });
}

/**
 * Finish any take a previous session left oversized or half-scaled.
 *
 * The scaling outlives the app but the RENAME cannot, so a session that quit
 * during the pass leaves `take.mov` beside `take.mov.1080.mov`. Swapping them
 * in on the next launch is what makes that self-healing rather than something
 * to notice and fix by hand.
 */
export function sweepUnfinished() {
  let swapped = 0;
  try {
    for (const name of readdirSync(RECORDINGS)) {
      if (!name.endsWith('.1080.mov')) continue;
      const scaled = join(RECORDINGS, name);
      const original = join(RECORDINGS, name.slice(0, -'.1080.mov'.length));
      // Only when it looks complete: a partial file from a pass that was
      // killed is worse than the oversized take it would replace.
      if (statSync(scaled).size < 1024) { continue; }
      renameSync(scaled, original);
      swapped++;
    }
  } catch { /* no folder yet, or nothing to do */ }
  if (swapped) console.log(`[record] finished scaling ${swapped} take(s) from a previous session`);
}

/** The display scale where the window is now — 2 on a Retina panel. */
function scaleOf(win) {
  return screen.getDisplayMatching(win.getBounds()).scaleFactor || 1;
}

export function createRecorder(win, { audio = null } = {}) {
  let proc = null;
  let file = null;
  let startedAt = 0;
  let shotWidth = 0;
  // Why the take ended, set by whoever ends it. Read in the exit handler,
  // which is the only place that knows the take is actually over.
  let ending = '';

  const recording = () => proc !== null;

  function start(withAudio = audio) {
    if (recording()) return null;
    // CONTENT bounds, not window bounds: the difference is the title bar, and
    // filming it is what would make a 960x540 window record as 1920x1144.
    const bounds = win.getContentBounds();
    mkdirSync(RECORDINGS, { recursive: true });
    file = join(RECORDINGS, takeName());

    startedAt = Date.now();
    ending = '';
    proc = spawn('screencapture', captureArgs(bounds, file, withAudio), { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });

    proc.on('exit', (code, signal) => {
      // SIGINT is how stop() ends a take and is the SUCCESS path — the file is
      // finalised on the way out (measured: a 2.5s take interrupted at 2.5s
      // writes a valid 2.31s mov). Anything else ended badly.
      // THE LENGTH AND THE REASON, every time. A take that ended because the
      // window moved is indistinguishable from one you stopped yourself until
      // you open the file — and while filming you are watching the game, not
      // this terminal, so the only place to find out afterwards is here.
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      const failed = !(signal === 'SIGINT' || code === 0);
      const missingDevice = failed && /audio device .* not found/i.test(stderr);
      proc = null;

      // A MISSING AUDIO DEVICE MUST NOT COST THE TAKE. screencapture refuses
      // the whole recording when -G names a device it cannot find — it exits
      // before writing a frame — so an unplugged interface, or a BlackHole
      // that was never installed, would silently mean no footage at all rather
      // than footage with no sound. Retried without audio, which loses the
      // first fraction of a second and nothing else.
      if (missingDevice && withAudio) {
        console.warn(`[record] ${stderr.trim()} — filming without sound. \`npm run audio\` lists the ids.`);
        start(null);
        return;
      }
      if (!failed) {
        const done = (at) => console.log(`[record] ${secs}s — ${ending || 'stopped'} — ${at}`);
        // Scaled only when it was filmed larger. A native 1080p take is left
        // alone rather than run through a re-encode that could only lose to it.
        if (shotWidth > OUTPUT.width) {
          console.log(`[record] ${secs}s — ${ending || 'stopped'} — scaling to ${OUTPUT.width}x${OUTPUT.height}…`);
          toOutputSize(file, done);
        } else done(file);
        return;
      }

      // EXIT 1 WITH NOTHING ON STDERR IS THE PERMISSION, essentially always.
      // Screen Recording is granted to an APP, and `screencapture` is
      // attributed to whichever app launched this process — not to Electron,
      // which reports `granted` either way and is a red herring. Denied, it
      // exits within a second having written nothing and said nothing, so the
      // raw report ("exited 1 — no output") sends you looking at the recorder.
      if (code === 1 && !stderr.trim() && Number(secs) < 2) {
        console.warn('[record] screencapture wrote nothing and said nothing, which is almost always'
          + '\n  Screen Recording not being granted to the app that launched this session.'
          + '\n  System Settings > Privacy & Security > Screen Recording, then relaunch it.');
        return;
      }
      console.warn(`[record] screencapture exited ${code ?? signal} after ${secs}s — ${stderr.trim() || 'no output'}`);
    });

    proc.on('error', (err) => {
      // The likely one is Screen Recording permission, which macOS refuses
      // without ever prompting when the app was launched from a terminal that
      // has it and the app itself does not.
      console.warn(`[record] could not start — ${err?.message ?? err}`);
      proc = null;
    });

    // PINNED FOR THE DURATION. The rect is fixed when screencapture starts and
    // cannot be re-aimed, so a drag mid-take is a file that is part game and
    // part desktop. Detecting that afterwards is worth doing (see the guard
    // below) but it is a consolation prize — making the drag impossible is the
    // actual fix, and a window you cannot nudge is what you want while filming
    // anyway. Restored in stop(), always.
    win.setMovable(false);

    // NOTHING GETS IN THE SHOT. A rectangle films whatever pixels are in it, so
    // the guarantee has to come from the game being the thing in front:
    // 'screen-saver' is the highest level Electron offers, above ordinary
    // always-on-top windows, above panels, above notifications. Measured — a
    // window that set itself always-on-top at 'pop-up-menu' AND took focus did
    // not appear in the take at all.
    //
    // Restored in stop(), with the same guard as the unpin: leaving the game
    // welded over everything else is a worse bug than the one it prevents.
    win.setAlwaysOnTop(true, 'screen-saver');

    // What this take will come off the screen at, so the exit handler knows
    // whether it needs bringing back down to 1920x1080.
    shotWidth = Math.round(bounds.width * scaleOf(win));
    const sound = withAudio ? `, sound from ${withAudio}` : ', no sound';
    console.log(`[record] filming ${bounds.width}x${bounds.height} at ${bounds.x},${bounds.y}${sound} -> ${file}`);
    return file;
  }

  function stop({ reveal = false, why = 'you stopped it' } = {}) {
    // THE CHILD DIES FIRST, BEFORE ANYTHING THAT CAN THROW.
    //
    // This ordering is the whole lesson of the worst bug in this file. The
    // unpin below used to be the first statement, and on the `closed` event it
    // threw `Object has been destroyed` — so stop() never reached the kill, the
    // recorder was never stopped, and `screencapture` outlived the app holding
    // the interactive capture overlay: the screen dimmed with a selection
    // rectangle on it, permanently, with no window left to explain why. A
    // child process is not cleaned up when its parent exits on macOS, so an
    // exception anywhere above this line strands one on the user's machine.
    //
    // So: kill, then tidy. Nothing that can throw goes in front of it, and
    // everything after it is wrapped.
    const done = file;
    if (proc) {
      ending = why;
      // SIGINT rather than SIGTERM: SIGTERM kills it where it stands and leaves
      // a mov with no moov atom, which no player will open — an entire take,
      // gone, for the sake of the wrong signal.
      proc.kill('SIGINT');
    }

    // UNPINNED even when there was no take to stop, so a start() that failed
    // after setMovable cannot leave the window stuck for the session — and
    // guarded, because `closed` is one of this function's callers and by then
    // the native window is gone.
    try {
      if (!win.isDestroyed()) {
        win.setMovable(true);
        win.setAlwaysOnTop(false);
      }
    } catch (err) {
      // Reported, never rethrown. The take is already safe by this point and
      // an unpin that failed is cosmetic; throwing here would only put the
      // exception back in front of a user who is quitting.
      console.warn(`[record] could not unpin the window — ${err?.message ?? err}`);
    }

    if (!done || !proc) return null;
    if (reveal) setTimeout(() => shell.showItemInFolder(done), 600);
    return done;
  }

  // A MOVED WINDOW IS A RUINED TAKE — see the header. Stopped rather than
  // re-aimed: screencapture cannot change its rect mid-recording, and silently
  // restarting would leave a cut in the middle of what looks like one take.
  //
  // The GUARD is the backstop; the fix is that the window cannot be dragged
  // while a take is running (setMovable above). A guard that only reports the
  // ruined take still costs you the take.
  const abort = (why) => {
    if (!proc || win.isDestroyed()) return;
    console.warn(`[record] the window ${why}, so the rest of the take would not have been the game`);
    stop({ why: `the window ${why}` });
  };
  win.on('move', () => abort('moved'));
  win.on('resize', () => abort('was resized'));

  // Quitting mid-take must still finalise the file. Without this the process
  // group goes down with the app and the take is unplayable.
  // Both of these can be the LAST word, and which one fires first depends on
  // how the app is ending — Cmd+Q reaches before-quit first, a closed window
  // on macOS may never reach it at all. stop() is idempotent (`if (!proc)`),
  // so whichever arrives second is a no-op rather than a double SIGINT.
  // THE LAST-DITCH NET. Everything above is a path someone thought of; this
  // one catches the paths nobody did. `exit` handlers must be synchronous, so
  // this is a bare kill with no logging and no file bookkeeping — the only job
  // is that no screencapture is left holding the screen.
  process.on('exit', () => { try { proc?.kill('SIGINT'); } catch { /* exiting */ } });

  const onQuit = () => stop({ why: 'the game quit' });
  app.on('before-quit', onQuit);
  win.on('closed', () => {
    // Dropped here or it outlives the window it refers to — with the recorder
    // holding `win` in its closure, that is a destroyed window kept alive for
    // the life of the app.
    app.off('before-quit', onQuit);
    stop({ why: 'the window closed' });
  });

  return { start, stop, recording, toggle: () => (recording() ? stop({ reveal: true }) : start()) };
}
