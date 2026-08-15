#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:qr
//
// The QR code that goes on the share image (path/src/qr.js), and the only
// question that matters about it: does a phone read it?
//
// Nothing else about a QR code fails LOUDLY. A wrong block-count row, an
// inverted mask, format bits written for the wrong correction level, a
// remainder bit left unmasked — every one of those produces a matrix that
// looks exactly like a QR code, draws without complaint, and scans as
// nothing. The picture goes out to other people's phones with a dead square
// on it and the game never hears about it.
//
// So this harness does two things:
//
//   1. STRUCTURE, in pure JS: version selection, the furniture, the quiet
//      zone, and the refusal to encode something too long. Fast, always runs.
//   2. THE ROUND TRIP: every version and level this file supports is rendered
//      to a PNG and handed to the system's own scanner (tools/qr-decode.swift,
//      macOS Vision) to be read back. This is the only check that can tell a
//      correct code from a plausible one, and it is why the block table is
//      allowed to be a hand-typed lookup.
//
// The round trip needs `swift`, which is macOS-only. Where it is missing the
// harness says so and skips it rather than passing quietly.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// jsdom comes in BEFORE the vite loader is registered further down, and that
// order is not a style choice: jsdom is CommonJS, and loading it once those
// synchronous hooks are installed dies inside its own require chain with
// "request for './fallback/encoding.js' is not in cache". Same dance as
// tools/boss-shot-test.mjs — which is why this harness is run by plain `node`
// and registers the loader itself.
import { JSDOM } from 'jsdom';
import { encodeQr, qrRows } from '../path/src/qr.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// ---------------------------------------------------------------------------
section('STRUCTURE — the code is shaped like a code');
// ---------------------------------------------------------------------------

const url = 'https://seal-survivor.pages.dev';
const qr = encodeQr(url, 'M');
check('a URL encodes', !!qr);
check('size matches the version', qr.size === qr.version * 4 + 17,
  `v${qr.version}, ${qr.size}x${qr.size}`);
check('one byte per module', qr.modules.length === qr.size * qr.size);

const rows = qrRows(qr);
// The three finders, as a scanner looks for them: dark ring, light ring, dark
// core. A code with a broken finder is invisible to every scanner alive.
function finderAt(r0, c0) {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      if (rows[r0 + r][c0 + c] !== (ring === 2 ? 0 : 1)) return false;
    }
  }
  return true;
}
check('finder, top-left', finderAt(0, 0));
check('finder, top-right', finderAt(0, qr.size - 7));
check('finder, bottom-left', finderAt(qr.size - 7, 0));
check('no finder bottom-right', !finderAt(qr.size - 7, qr.size - 7));

// Timing: the dotted line between finders, alternating from a dark module.
let timing = true;
for (let i = 8; i < qr.size - 8; i++) {
  if (rows[6][i] !== (i % 2 === 0 ? 1 : 0)) timing = false;
  if (rows[i][6] !== (i % 2 === 0 ? 1 : 0)) timing = false;
}
check('timing patterns run both ways', timing);
check('the dark module is dark', rows[qr.size - 8][8] === 1);

// Version selection: the smallest that fits, and a version bump exactly where
// the payload crosses a capacity. 16 data codewords at v1/M is 128 bits, less
// the four-bit mode and the eight-bit length — 14 bytes, and not one more.
check('14 bytes fit version 1', encodeQr('x'.repeat(14), 'M').version === 1);
check('15 bytes need version 2', encodeQr('x'.repeat(15), 'M').version === 2);
check('a heavier level takes a bigger version',
  encodeQr(url, 'H').version > encodeQr(url, 'L').version,
  `H=v${encodeQr(url, 'H').version}, L=v${encodeQr(url, 'L').version}`);

// The refusals. Both of these are drawn onto the frame a boss died on, so
// neither may throw.
check('too long returns null, does not throw', encodeQr('x'.repeat(400), 'M') === null);
check('empty returns null', encodeQr('', 'M') === null);
check('an unknown level falls back rather than failing', !!encodeQr(url, 'Z'));

// UTF-8, because a boss name could end up in one of these one day and a
// multi-byte character must be counted in BYTES, not characters.
const wide = encodeQr('https://seal-survivor.pages.dev/🦭', 'M');
check('multi-byte text encodes', !!wide);

// ---------------------------------------------------------------------------
section('ROUND TRIP — the system scanner reads it back');
// ---------------------------------------------------------------------------

// A minimal greyscale PNG. Written by hand because the alternative is a canvas
// (this harness has no DOM) or a dependency, and a PNG of a black-and-white
// grid is a deflate stream and two chunks.
function png(qr, scale = 6, quiet = 4) {
  const side = (qr.size + quiet * 2) * scale;
  const raw = Buffer.alloc((side + 1) * side, 0xff);
  for (let y = 0; y < side; y++) {
    raw[y * (side + 1)] = 0; // filter byte: none
    const mr = Math.floor(y / scale) - quiet;
    if (mr < 0 || mr >= qr.size) continue;
    for (let x = 0; x < side; x++) {
      const mc = Math.floor(x / scale) - quiet;
      if (mc < 0 || mc >= qr.size) continue;
      if (qr.modules[mr * qr.size + mc]) raw[y * (side + 1) + 1 + x] = 0x00;
    }
  }
  const chunk = (type, body) => {
    const out = Buffer.alloc(body.length + 12);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'ascii');
    body.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + body.length)) >>> 0, 8 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 0;  // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function haveSwift() {
  try {
    execFileSync('which', ['swift'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// One case per (version, level) this file supports — all forty — so every row
// of the block table is exercised by something a scanner has to read. The
// payload is grown a byte at a time until it lands on the version wanted,
// rather than being a realistic URL: a URL long enough to reach version 10 is
// also long enough that the small versions have no case at all, and the small
// versions are the ones this game actually ships.
const CASES = [];
for (const level of ['L', 'M', 'Q', 'H']) {
  for (let v = 1; v <= 10; v++) {
    let text = null;
    for (let n = 1; n <= 300; n++) {
      const candidate = 'seal-survivor/'.repeat(40).slice(0, n);
      const made = encodeQr(candidate, level);
      if (!made) break;
      if (made.version === v) { text = candidate; break; }
      if (made.version > v) break;
    }
    if (text) CASES.push({ level, version: v, text });
  }
}
check('every version and level has a case', CASES.length === 40, `${CASES.length} cases`);

if (!haveSwift()) {
  console.log('  SKIP  system scanner — `swift` not found (macOS only)');
  console.log('        The structure checks above cannot tell a correct code');
  console.log('        from a plausible one. Run this on a Mac before shipping.');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'qr-test-'));
  const files = [];
  for (const c of CASES) {
    const file = join(dir, `v${c.version}-${c.level}.png`);
    writeFileSync(file, png(encodeQr(c.text, c.level)));
    files.push(file);
    c.file = file;
  }
  let read = {};
  try {
    const out = execFileSync('swift', ['tools/qr-decode.swift', ...files], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 24,
    });
    for (const line of out.split('\n')) {
      const [file, count, ...rest] = line.split('\t');
      if (file) read[file] = { count: Number(count), text: rest.join('\t') };
    }
  } catch (err) {
    check('the scanner ran', false, String(err.stderr || err).slice(0, 400));
  }
  let good = 0;
  for (const c of CASES) {
    if (read[c.file]?.text === c.text) good++;
    else check(`v${c.version} ${c.level} reads back`, false,
      `got ${JSON.stringify((read[c.file]?.text ?? '').slice(0, 60))}`);
  }
  check('every version and level scans', good === CASES.length,
    `${good}/${CASES.length}`);

  // The one that actually ships.
  const shipFile = join(dir, 'ship.png');
  writeFileSync(shipFile, png(encodeQr(url, 'M')));
  const shipOut = execFileSync('swift', ['tools/qr-decode.swift', shipFile], { encoding: 'utf8' });
  check('the game URL scans to the game URL', shipOut.trim().endsWith(url),
    shipOut.trim().split('\t').pop());

  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('ON THE PICTURE — the code survives being drawn');
// ---------------------------------------------------------------------------
//
// An encoder that is provably correct is only half of it. The code reaches a
// phone through systems/bossShot.js drawing it onto a canvas at whatever size
// the frame allows, and the drawing is where the remaining ways to ship a dead
// square live: a module size that lands on a fraction of a pixel, a quiet zone
// eaten by the layout, a panel drawn under the photograph instead of over it.
//
// So the share images are composed for real — same code path the game uses —
// onto a canvas that records its fills into a pixel buffer, and the result is
// handed to the same scanner. jsdom has no 2D context, so this harness brings
// one: fills only, which is all a QR code is.

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const buffers = new WeakMap();
const madeCanvases = [];

function grey(style) {
  if (typeof style !== 'string') return null; // a gradient — not our business
  const hex = /^#([0-9a-f]{6})$/i.exec(style.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return ((n >> 16 & 255) * 0.299 + (n >> 8 & 255) * 0.587 + (n & 255) * 0.114) | 0;
  }
  const rgb = /^rgba?\(([^)]+)\)/i.exec(style.trim());
  if (rgb) {
    const [r, g, b] = rgb[1].split(',').map(Number);
    return (r * 0.299 + g * 0.587 + b * 0.114) | 0;
  }
  return null;
}

dom.window.HTMLCanvasElement.prototype.getContext = function getContext() {
  const canvas = this;
  madeCanvases.push(canvas);
  const pixels = () => {
    let buf = buffers.get(canvas);
    if (!buf) {
      buf = { w: canvas.width, h: canvas.height, data: new Uint8Array(canvas.width * canvas.height).fill(255) };
      buffers.set(canvas, buf);
    }
    return buf;
  };
  return {
    canvas,
    _fill: '#000000',
    set fillStyle(v) { this._fill = v; }, get fillStyle() { return this._fill; },
    set font(v) {}, get font() { return ''; },
    set letterSpacing(v) {}, get letterSpacing() { return ''; },
    set textAlign(v) {}, get textAlign() { return 'left'; },
    set textBaseline(v) {}, get textBaseline() { return 'alphabetic'; },
    set strokeStyle(v) {}, get strokeStyle() { return ''; },
    set lineWidth(v) {}, get lineWidth() { return 1; },
    save() {}, restore() {}, strokeRect() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    measureText: (t) => ({ width: String(t).length * 10 }),
    // Type is not drawn: it cannot land on the code (that is the layout's
    // whole job) and rasterising it here would only be this harness marking
    // its own homework.
    fillText() {},
    fillRect(x, y, w, h) {
      const tone = grey(this._fill);
      if (tone === null) return;
      const buf = pixels();
      const x0 = Math.max(0, Math.round(x));
      const y0 = Math.max(0, Math.round(y));
      const x1 = Math.min(buf.w, Math.round(x + w));
      const y1 = Math.min(buf.h, Math.round(y + h));
      for (let r = y0; r < y1; r++) buf.data.fill(tone, r * buf.w + x0, r * buf.w + x1);
    },
    // Images are RESAMPLED rather than filled in as a grey block, and that is
    // what makes the count above mean anything: the sheet's cells are drawn
    // from the kill shots, so if a cell carried a code this is the step that
    // would put it in the sheet for the scanner to find. A grey rectangle here
    // would make that check pass on its own.
    drawImage(src, x = 0, y = 0, w = 0, h = 0) {
      const from = buffers.get(src);
      const dw = Math.round(w || src?.width || 0);
      const dh = Math.round(h || src?.height || 0);
      if (!from) {
        this._fill = '#808080';
        this.fillRect(x, y, dw, dh);
        return;
      }
      const buf = pixels();
      const x0 = Math.round(x);
      const y0 = Math.round(y);
      for (let r = 0; r < dh; r++) {
        const ty = y0 + r;
        if (ty < 0 || ty >= buf.h) continue;
        const sy = Math.min(from.h - 1, Math.floor((r * from.h) / dh));
        for (let cIdx = 0; cIdx < dw; cIdx++) {
          const tx = x0 + cIdx;
          if (tx < 0 || tx >= buf.w) continue;
          const sx = Math.min(from.w - 1, Math.floor((cIdx * from.w) / dw));
          buf.data[ty * buf.w + tx] = from.data[sy * from.w + sx];
        }
      }
    },
  };
};
dom.window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
dom.window.HTMLCanvasElement.prototype.toBlob = () => {};

// config.js imports imported-tuning.json and a pile of CSV with Vite's ?raw
// suffix, neither of which plain Node understands — the loader is what makes
// the next two lines possible at all.
await import('./vite-loader.mjs');
const { captureBossShot, composeRunSheet, resetBossShot } = await import('../path/src/systems/bossShot.js');
const { CONFIG } = await import('../path/src/config.js');

// A frame the size the game actually hands over.
const frame = document.createElement('canvas');
frame.width = 1600;
frame.height = 900;

CONFIG.boss.kill.snapshot.qr.enabled = true;
resetBossShot();
madeCanvases.length = 0;
check('a kill shot composes', captureBossShot(frame, {
  name: 'Wicked Grimgullet the Chumbucket Rumbler', level: 14, score: 82400, time: 512,
}));
const sheetCanvas = await composeRunSheet({ score: 82400, kills: 640, level: 14, time: 512, bosses: 1 });
check('the run sheet composes', !!sheetCanvas);

function toPng(canvas) {
  const buf = buffers.get(canvas);
  if (!buf) return null;
  const raw = Buffer.alloc((buf.w + 1) * buf.h);
  for (let y = 0; y < buf.h; y++) {
    raw[y * (buf.w + 1)] = 0;
    Buffer.from(buf.data.buffer, y * buf.w, buf.w).copy(raw, y * (buf.w + 1) + 1);
  }
  const chunk = (type, body) => {
    const out = Buffer.alloc(body.length + 12);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'ascii');
    body.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + body.length)) >>> 0, 8 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(buf.w, 0);
  ihdr.writeUInt32BE(buf.h, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Which canvas is which: the kill shot is the frame's own aspect, the sheet is
// the tall one. Found by size rather than by order, because the roll also
// makes a thumbnail per shot and that is a canvas too.
const shotCanvas = madeCanvases.find((c) => c.width === 1600 && c.height === 900 && buffers.has(c));

if (!haveSwift()) {
  console.log('  SKIP  the drawn code — `swift` not found (macOS only)');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'qr-image-'));
  const targets = [['kill shot', shotCanvas], ['run sheet', sheetCanvas]];
  const files = [];
  for (const [name, canvas] of targets) {
    const png = canvas && toPng(canvas);
    check(`${name} rasterises`, !!png);
    if (!png) continue;
    const file = join(dir, `${name.replace(' ', '-')}.png`);
    writeFileSync(file, png);
    files.push([name, file]);
  }
  if (files.length) {
    const out = execFileSync('swift', ['tools/qr-decode.swift', ...files.map(([, f]) => f)],
      { encoding: 'utf8', maxBuffer: 1 << 24 });
    const read = {};
    for (const line of out.split('\n')) {
      const [file, count, ...rest] = line.split('\t');
      if (file) read[file] = { count: Number(count), text: rest.join('\t') };
    }
    for (const [name, file] of files) {
      check(`the ${name} carries a scannable code`, read[file]?.text === url,
        JSON.stringify((read[file]?.text ?? '').slice(0, 60)));
      // ONE code per image. The sheet's cells are the kill shots, and a kill
      // shot carries a code of its own — so a sheet that did not take the
      // thumbnail before stamping would come out of here with three, two of
      // them too small to scan. See captureBossShot.
      check(`the ${name} carries exactly one`, read[file]?.count === 1,
        `${read[file]?.count} found`);
    }
  }

  // ...and the switch really is a switch. A picture composed with the code
  // turned off must have nothing on it for a scanner to find — the toggle is
  // the whole reason this is optional.
  CONFIG.boss.kill.snapshot.qr.enabled = false;
  resetBossShot();
  madeCanvases.length = 0;
  captureBossShot(frame, { name: 'A Boss', level: 3, score: 100, time: 60 });
  const bare = madeCanvases.find((c) => c.width === 1600 && c.height === 900 && buffers.has(c));
  const bareFile = join(dir, 'no-qr.png');
  writeFileSync(bareFile, toPng(bare));
  const bareOut = execFileSync('swift', ['tools/qr-decode.swift', bareFile], { encoding: 'utf8' });
  check('switched off, there is no code on the image', bareOut.trim().endsWith('NONE'),
    bareOut.trim().split('\t').pop());
  CONFIG.boss.kill.snapshot.qr.enabled = true;

  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
