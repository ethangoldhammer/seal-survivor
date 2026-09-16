#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run film:finish
//
// BRING ANY OVERSIZED TAKE DOWN TO 1920x1080.
//
// The window you play in is bigger than the one that captures natively at
// 1080p, so a take comes off the screen at 2560x1440 and is scaled back down
// afterwards. record.js does that itself when the app is still running — but a
// take usually ends BECAUSE the game is quitting, and the scaling is a child
// process that needs the event loop for one more turn to even start. Sometimes
// it doesn't get it.
//
// So this runs after the game exits, from the session script, and sweeps up
// whatever was left. Idempotent: a take already at 1920x1080 is skipped, not
// re-encoded.
//
//   node tools/finish-takes.mjs
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { openSync, readSync, closeSync, statSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { RECORDINGS } from '../electron/takeFile.js';
import { OUTPUT } from '../electron/captureSize.js';

/** A mov's real pixel size, read out of moov/trak/tkhd. */
function dimensions(path) {
  const fd = openSync(path, 'r');
  try {
    const end = statSync(path).size;
    const find = (from, stop, want) => {
      let at = from;
      while (at < stop - 8) {
        const h = Buffer.alloc(8); readSync(fd, h, 0, 8, at);
        let size = h.readUInt32BE(0); const type = h.toString('latin1', 4, 8); let body = at + 8;
        if (size === 1) { const b = Buffer.alloc(8); readSync(fd, b, 0, 8, at + 8); size = Number(b.readBigUInt64BE(0)); body += 8; }
        if (size <= 0) return null;
        if (type === want[0]) return want.length === 1 ? { body, stop: at + size } : find(body, at + size, want.slice(1));
        at += size;
      }
      return null;
    };
    // EVERY track, not the first one. A take with sound has two, and an audio
    // track's tkhd carries width and height of ZERO — so reading the first
    // trak returns 0x0 for half the files here, which compares as "already
    // small enough" and skips the scaling silently, forever. Observed on a real
    // take: reported 0x0, never scaled, stayed 2560x1440.
    const moov = find(0, end, ['moov']);
    if (!moov) return null;
    let best = null;
    let at = moov.body;
    const stop = moov.stop ?? end;
    while (at < stop - 8) {
      const h = Buffer.alloc(8); readSync(fd, h, 0, 8, at);
      const size = h.readUInt32BE(0); const type = h.toString('latin1', 4, 8);
      if (size <= 0) break;
      if (type === 'trak') {
        const t = find(at + 8, at + size, ['tkhd']);
        if (t) {
          const d = Buffer.alloc(100); readSync(fd, d, 0, 100, t.body);
          const off = 4 + (d[0] === 1 ? 32 : 20) + 8 + 8 + 36;
          const w = d.readUInt32BE(off) >> 16;
          const hgt = d.readUInt32BE(off + 4) >> 16;
          if (w > 0 && hgt > 0 && (!best || w > best.width)) best = { width: w, height: hgt };
        }
      }
      at += size;
    }
    return best;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

let takes = [];
try {
  takes = readdirSync(RECORDINGS).filter((f) => f.endsWith('.mov') && !f.endsWith('.1080.mov'));
} catch {
  process.exit(0); // no folder yet
}

for (const name of takes) {
  const file = join(RECORDINGS, name);
  const size = dimensions(file);
  // A take still being written has no readable moov yet — leave it alone
  // rather than re-encoding half a file out from under the recorder.
  if (!size || size.width <= OUTPUT.width) continue;

  const scaled = `${file}.1080.mov`;
  process.stdout.write(`  scaling ${name} from ${size.width}x${size.height}… `);
  try {
    execFileSync('/usr/bin/avconvert', [
      '--source', file, '--output', scaled,
      '--preset', `Preset${OUTPUT.width}x${OUTPUT.height}`, '--replace',
    ], { stdio: 'ignore' });
    renameSync(scaled, file);
    console.log(`${OUTPUT.width}x${OUTPUT.height}`);
  } catch {
    try { unlinkSync(scaled); } catch { /* nothing to clean */ }
    console.log('failed — keeping it as filmed');
  }
}
