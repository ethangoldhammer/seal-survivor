#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:record
//
// THE TAKE IS THE WINDOW AND NOTHING ELSE — electron/takeFile.js.
//
// macOS's own window recording pads the picture with the compositor's shadow,
// corners and transparent margin, which is the whole reason this records a
// RECTANGLE instead. Turning a window into that rectangle is arithmetic, and
// every way it goes wrong produces a file that plays perfectly and is framed
// wrong — you find out in the edit:
//
//   A fractional point TRUNCATES rather than rounds, so one edge loses a
//   column and the file is no longer exactly 16:9.
//
//   Window bounds instead of CONTENT bounds puts the title bar across the top
//   of every take.
//
// With --live it films a real two-second rectangle and reads the dimensions
// back out of the mov it wrote. That is the only check that the OS still
// behaves the way this module assumes — that -R takes POINTS and the file
// comes back at the display's scale factor — and it is the assumption the
// whole design rests on. It needs Screen Recording permission and writes a
// file, so it is not in the ship gate.
//
//   node tools/record-test.mjs [--live]
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { mkdtempSync, openSync, readSync, closeSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RECORDINGS, takeName, captureArgs, BLACKHOLE_UID } from '../electron/takeFile.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail && !cond ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

section('where a take goes');
check('under ~/Movies', /\/Movies\//.test(RECORDINGS), RECORDINGS);
check('not in the app\'s data', !/Application Support/.test(RECORDINGS), RECORDINGS);

section('what it is called');
const at = new Date(2026, 8, 14, 14, 34, 2);
check('sortable and to the second', takeName(at) === 'seal-2026-09-14-143402.mov', takeName(at));
check('pads every field', takeName(new Date(2026, 0, 2, 3, 4, 5)) === 'seal-2026-01-02-030405.mov',
  takeName(new Date(2026, 0, 2, 3, 4, 5)));
// Two takes in the same second would collide and the second would overwrite
// the first; a second apart must not.
check('a second apart is a different file',
  takeName(new Date(2026, 8, 14, 14, 34, 2)) !== takeName(new Date(2026, 8, 14, 14, 34, 3)));

section('the rectangle');
check('is -v -R x,y,w,h file',
  captureArgs({ x: 224, y: 191, width: 1280, height: 720 }, '/t.mov')
    .join(' ') === '-v -R 224,191,1280,720 /t.mov');
// A window dragged onto a display with a different scale factor reports
// fractional bounds, and screencapture truncates rather than rounds them.
const frac = captureArgs({ x: 224.5, y: 190.5, width: 1279.6, height: 719.6 }, '/t.mov');
check('rounds a fractional rect', frac[2] === '225,191,1280,720', frac[2]);
check('and the rounded size is still 16:9', (() => {
  const [, , w, h] = frac[2].split(',').map(Number);
  return w * 9 === h * 16;
})(), frac[2]);

section('sound');
// -G takes a device UID and refuses a NAME outright, killing the whole
// recording rather than just the audio — so the argument's shape is the thing
// to pin. `npm run audio` is what prints the ids.
const withSound = captureArgs({ x: 0, y: 0, width: 1280, height: 720 }, '/t.mov', BLACKHOLE_UID);
check('-G comes before -R', withSound.indexOf('-G') < withSound.indexOf('-R'), withSound.join(' '));
check('carries the device id', withSound[withSound.indexOf('-G') + 1] === BLACKHOLE_UID);
check('the rect is unchanged by it', withSound[withSound.indexOf('-R') + 1] === '0,0,1280,720');
// SILENT IS THE DEFAULT, and must stay that way: the only source macOS offers
// without setup is the microphone, and a trailer take with the room on it is
// one you do not notice until the edit.
check('no -G at all without a device',
  !captureArgs({ x: 0, y: 0, width: 1280, height: 720 }, '/t.mov').includes('-G'));
check('and null is the same as absent',
  captureArgs({ x: 0, y: 0, width: 1, height: 1 }, '/t.mov', null).join(' ')
  === captureArgs({ x: 0, y: 0, width: 1, height: 1 }, '/t.mov').join(' '));
check('BlackHole\'s id is a UID, not its name', !BLACKHOLE_UID.includes(' '), BLACKHOLE_UID);

// --- the live half ----------------------------------------------------------
if (process.argv.includes('--live')) {
  section('a real two seconds');
  const dir = mkdtempSync(join(tmpdir(), 'seal-take-'));
  const file = join(dir, takeName());
  // -V bounds it, so a hung recorder fails the test rather than the machine.
  const args = captureArgs({ x: 100, y: 100, width: 320, height: 180 }, file);
  const run = spawnSync('screencapture', [...args.slice(0, 1), '-V', '2', ...args.slice(1)], { encoding: 'utf8' });

  if (run.status !== 0) {
    check('screencapture ran', false, run.stderr?.trim() || `exit ${run.status} (Screen Recording permission?)`);
  } else {
    check('wrote a file', statSync(file).size > 0);
    const size = movSize(file);
    check('the mov is readable', !!size, 'no moov/tkhd — the file was not finalised');
    // THE ASSUMPTION THE DESIGN RESTS ON: -R is in POINTS, and the file comes
    // back multiplied by the display's scale factor. If macOS ever changed
    // this to pixels, every take would be a quarter of the window with no
    // error anywhere.
    if (size) {
      check('is a whole multiple of the rect asked for',
        size.w % 320 === 0 && size.h % 180 === 0, `${size.w}x${size.h} from 320x180`);
      check('and is exactly 16:9', size.w * 9 === size.h * 16, `${size.w}x${size.h}`);
    }
    unlinkSync(file);
  }

  section('closing the window mid-take');
  // A REAL window, because the bug is what a DESTROYED one does — see
  // electron/record-smoke.js. Nothing in plain Node can produce it.
  const electron = join(import.meta.dirname, '..', 'node_modules/.bin/electron');
  const smoke = join(import.meta.dirname, '..', 'electron/record-smoke.js');
  const run2 = spawnSync(electron, [smoke], { encoding: 'utf8' });
  const line = run2.stdout.split('\n').find((l) => l.startsWith('SEAL_RECORD '));
  if (!line) {
    check('the smoke reported', false, run2.stderr?.trim().split('\n').slice(-2).join(' | ') || 'no output');
  } else {
    const r = JSON.parse(line.slice('SEAL_RECORD '.length));
    if (r.error) check('the smoke ran', false, r.error);
    else {
      check('the window is pinned while filming', r.pinnedWhileFilming);
      check('and raised above everything else', r.raisedWhileFilming);
      // `Object has been destroyed` — an unguarded window call on `closed`.
      check('closing mid-take throws nothing', (r.problems ?? []).length === 0, (r.problems ?? []).join(' | '));
      check('and the take still reached disk', r.wrote, r.file);
      // The one that matters most: a stranded screencapture holds the
      // interactive capture overlay over the WHOLE SCREEN until it is killed,
      // and there is no window left to say so.
      check('no screencapture is left running', r.orphans === 0, `${r.orphans} still alive`);
      if (r.wrote) {
        const size = movSize(r.file);
        check('and is finalised', !!size, 'no moov/tkhd — screencapture was killed, not interrupted');
        unlinkSync(r.file);
      }
    }
  }
}

/** width/height out of a mov's moov/trak/tkhd, which is where the truth is. */
function movSize(path) {
  const fd = openSync(path, 'r');
  const end = statSync(path).size;
  try {
    const find = (from, stop, want) => {
      let at = from;
      while (at < stop - 8) {
        const head = Buffer.alloc(8);
        readSync(fd, head, 0, 8, at);
        let size = head.readUInt32BE(0);
        const type = head.toString('latin1', 4, 8);
        let body = at + 8;
        if (size === 1) { const big = Buffer.alloc(8); readSync(fd, big, 0, 8, at + 8); size = Number(big.readBigUInt64BE(0)); body += 8; }
        if (size <= 0) return null;
        if (type === want[0]) {
          return want.length === 1 ? { body, stop: at + size } : find(body, at + size, want.slice(1));
        }
        at += size;
      }
      return null;
    };
    const tkhd = find(0, end, ['moov', 'trak', 'tkhd']);
    if (!tkhd) return null;
    const d = Buffer.alloc(100);
    readSync(fd, d, 0, 100, tkhd.body);
    // version/flags 4, times+id+reserved+duration, reserved 8, layer/alt/
    // volume/reserved 8, matrix 36, then width/height as 16.16 fixed point.
    const off = 4 + (d[0] === 1 ? 32 : 20) + 8 + 8 + 36;
    return { w: d.readUInt32BE(off) >> 16, h: d.readUInt32BE(off + 4) >> 16 };
  } finally {
    closeSync(fd);
  }
}

console.log(failures ? `\n${failures} failed` : '\nall good');
process.exit(failures ? 1 : 0);
