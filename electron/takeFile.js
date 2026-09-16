// ============================================================================
// WHERE A TAKE GOES AND WHAT IT IS CALLED — the half of record.js with no
// Electron in it, for the same reason captureSize.js exists: `import { app }
// from 'electron'` throws under plain node, and a module that throws on import
// cannot be unit tested at all.
// ============================================================================

import { join } from 'node:path';
import { homedir } from 'node:os';

// ~/Movies, because that is where a screen recording belongs and where every
// other tool on the machine will look for it. NOT userData: these are footage,
// not app state, and a trailer take should survive deleting the app's data.
export const RECORDINGS = join(homedir(), 'Movies', 'Seal Survivor');

/** `seal-2026-09-14-143402.mov` — sortable, and unique to the second. */
export function takeName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `seal-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
    + `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.mov`;
}

/**
 * The argument list for `screencapture`.
 *
 * `-R x,y,w,h` — a screen RECTANGLE, handed the window's content bounds.
 *
 * WHY NOT `-l <windowid>`, WHICH SOUNDS LIKE THE RIGHT ANSWER. A window
 * capture really does exclude everything drawn over the game — measured, a red
 * window held over a green one came back 100% green — but its VIDEO output is
 * not the size you asked for and is not even the same size twice: the same
 * 960x540 window recorded as 1924x1080 on one run and 1912x1076 on the next,
 * while a STILL of it was exactly 1920x1080 every time. A trailer master
 * cannot be "about 1080p", and there is nothing on this machine that can
 * resize it afterwards (`avconvert --preset Preset1920x1080` returns a
 * 1920x1144 source unchanged — the presets are ceilings, not targets).
 *
 * A rectangle is exact and deterministic. What it cannot do by itself is keep
 * other windows out of the shot, so record.js raises the game above them for
 * the duration — see the note on the screen-saver level there.
 *
 * ROUNDED, because screencapture takes integers and truncates a fractional
 * point silently — on a half-point boundary that is one column of pixels gone
 * from one edge, and the file is no longer exactly 16:9.
 */
export function captureArgs(bounds, file, audio = null) {
  const r = [bounds.x, bounds.y, bounds.width, bounds.height].map((n) => Math.round(n));
  // -G takes a CoreAudio device UID, NOT the device's name — and the failure
  // is immediate and total: `screencapture: Capture audio device BlackHole 2ch
  // not found.`, no file written. The name is what every audio UI shows you,
  // so passing it is the obvious first attempt and it never works. `npm run
  // audio` prints the ids.
  const sound = audio ? ['-G', audio] : [];
  return ['-v', ...sound, '-R', r.join(','), file];
}

// BlackHole's published device UID. A loopback: anything routed to it as OUTPUT
// can be recorded from it as INPUT, which is the only way to get the GAME's
// sound rather than the room's — `screencapture -g` records the MICROPHONE,
// which on a trailer take is the sound of you playing it.
//
// Hard-coded rather than discovered because the main process has no way to
// enumerate CoreAudio, and a UID is stable in a way a name is not. Override
// with --audio=<id> for any other device.
export const BLACKHOLE_UID = 'BlackHole2ch_UID';
