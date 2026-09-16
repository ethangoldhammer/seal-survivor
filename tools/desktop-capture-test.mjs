#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:capture
//
// EVERY TAKE IS 1920x1080 — electron/captureSize.js.
//
// The window size is not a preference: `screencapture` writes a rectangle at
// points x the display's scale factor, so there is exactly one window size per
// display that produces a 1080p file, and this is the arithmetic that finds
// it. Every failure here is one you would find in the edit rather than on
// screen — a file that is 1906x1072, or 16:9 in one axis only. Neither throws,
// and neither is visible while you are filming.
//
//   node tools/desktop-capture-test.mjs
// ---------------------------------------------------------------------------

// With --window (npm run desktop:test:capture) it also drives a real hidden
// Electron window through electron/capture-smoke.js, which is the only place
// the platform's own three ways of quietly refusing a content size show up: a
// minimum size clamping it, a maximized window ignoring it, and a title bar
// that is a different height on every OS. That half needs Electron and a
// display, so it is NOT in the ship gate — this file's arithmetic is.

import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { OUTPUT, captureSizeFor, recordedSize, fitCapture, is169, unitsToSize } from '../electron/captureSize.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail && !cond ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

section('the detector itself');
// is169 with any tolerance in it would pass everything below without measuring
// anything, so it is checked against a size that is visibly nearly right.
check('1280x720 is 16:9', is169({ width: 1280, height: 720 }));
check('1365x768 is not', !is169({ width: 1365, height: 768 }));
check('1280x800 is not', !is169({ width: 1280, height: 800 }));

section('the size that records at 1080p');
// THE WHOLE CONTRACT: window points x scale factor == 1920x1080. Checked by
// doing the multiplication, not by trusting the division that produced it.
for (const scale of [1, 1.5, 2, 3, 4]) {
  const want = captureSizeFor(scale);
  const shot = recordedSize(want, scale);
  check(`scale ${scale} -> ${want.width}x${want.height} records ${shot.width}x${shot.height}`,
    want.exact && shot.width === OUTPUT.width && shot.height === OUTPUT.height);
  check(`scale ${scale} is 16:9`, is169(want), `${want.width}x${want.height}`);
}

// A SCALE THAT DOES NOT DIVIDE 1920 must say so rather than round. macOS
// reports fractional factors on a scaled display, and 1920/1.7777 is 1080.0 x
// 607.5 — a size no window can be. Rounding it produces a file that is not
// 1080p and does not admit it; `exact: false` is how the caller knows to warn.
const odd = captureSizeFor(1920 / 1080);
check('a scale that does not divide is flagged', odd.exact === false, JSON.stringify(odd));
check('and still yields a legal 16:9 window', is169(odd), `${odd.width}x${odd.height}`);
check('and one that is under 1080p, never over',
  recordedSize(odd, 1920 / 1080).width <= OUTPUT.width);

check('the 2x window fits a 14" MacBook Pro workspace',
  captureSizeFor(2).width <= 1512 && captureSizeFor(2).height <= 900);
// A zero or negative scale factor is nonsense the display could hand us on a
// disconnect; it must not produce Infinity for a window size.
for (const bad of [0, -2, NaN]) {
  const g = captureSizeFor(bad);
  check(`scale ${bad} falls back to 1x`, g.width === OUTPUT.width && g.height === OUTPUT.height,
    `${g.width}x${g.height}`);
}

section('unitsToSize cannot round');
let offSquare = null;
for (let u = 1; u <= 400 && !offSquare; u++) if (!is169(unitsToSize(u))) offSquare = u;
check('every unit count from 1 to 400', !offSquare, offSquare && `${offSquare} units is not 16:9`);

section('fitCapture');
const big = { width: 3840, height: 2160 };
const laptop = { width: 1512, height: 954 };

// Against the derived size, not a hardcoded pair.
const want2x = captureSizeFor(2);
const asked = fitCapture(want2x, { width: 2560, height: 1440 });
check('a size that fits is returned untouched',
  asked.width === want2x.width && asked.height === want2x.height && !asked.fitted,
  `${asked.width}x${asked.height} from ${want2x.width}x${want2x.height}`);

const shrunk = fitCapture(big, laptop);
check('a size that does not fit is shrunk', shrunk.fitted);
check('and is still exactly 16:9', is169(shrunk), `${shrunk.width}x${shrunk.height}`);
check('and actually fits', shrunk.width <= laptop.width && shrunk.height <= laptop.height,
  `${shrunk.width}x${shrunk.height} in ${laptop.width}x${laptop.height}`);
check('and is the largest that does', shrunk.width + 16 > laptop.width || shrunk.height + 9 > laptop.height,
  `${shrunk.width}x${shrunk.height} leaves room for another unit`);

// Height-bound and width-bound displays take different branches of the min().
const tall = fitCapture(big, { width: 2000, height: 600 });
check('a short workspace binds on height', tall.height <= 600 && is169(tall), `${tall.width}x${tall.height}`);
const narrow = fitCapture(big, { width: 800, height: 2000 });
check('a narrow workspace binds on width', narrow.width <= 800 && is169(narrow), `${narrow.width}x${narrow.height}`);

// Fuzzed, because the failure this guards is arithmetic and a handful of hand
// picked displays is exactly how a rounding bug survives a test file.
let bad = null;
for (let w = 320; w <= 4000 && !bad; w += 7) {
  for (let h = 200; h <= 2400; h += 11) {
    const f = fitCapture(big, { width: w, height: h });
    if (!is169(f) || f.width > w || f.height > h) { bad = { w, h, f }; break; }
  }
}
check('every workspace from 320x200 to 4000x2400', !bad,
  bad && `${bad.w}x${bad.h} gave ${bad.f.width}x${bad.f.height}`);

if (process.argv.includes('--window')) {
  section('a real window');
  const ROOT = resolve(import.meta.dirname, '..');
  const run = spawnSync(join(ROOT, 'node_modules/.bin/electron'), [join(ROOT, 'electron/capture-smoke.js')], {
    encoding: 'utf8',
    // SEAL_CAPTURE is what makes captureEnabled() true in a packaged build;
    // unpackaged it is already true, but passing it keeps this test honest
    // about what it is exercising.
    env: { ...process.env, SEAL_CAPTURE: '1280x720' },
  });
  const line = run.stdout.split('\n').find((l) => l.startsWith('SEAL_CAPTURE '));
  if (!line) {
    check('the smoke reported', false, run.stderr.trim().split('\n').slice(-3).join(' | ') || 'no output');
  } else {
    const { results, byFlag, byKey, restored, error } = JSON.parse(line.slice('SEAL_CAPTURE '.length));
    if (error) check('the smoke ran', false, error);
    for (const r of results ?? []) {
      const label = `pass ${r.pass}: ${r.width}x${r.height} @${r.scaleFactor}x`;
      // THE CONTRACT, measured on a real window rather than derived: what this
      // window records as.
      check(`${label} records ${r.shot.width}x${r.shot.height}`,
        r.shot.width === 1920 && r.shot.height === 1080);
      check(`${label} is 16:9`, r.square);
      // The minimum has to come DOWN to the capture size, or on a small
      // display the OS clamps the window back up to 960x600 and the arithmetic
      // is overruled by a constraint set in main.js.
      check(`${label} lowers the minimum`, r.minWidth <= r.width, `min ${r.minWidth}x${r.minHeight}`);
      check(`${label} lands fully on screen`, r.insideX && r.insideY,
        `insideX=${r.insideX} insideY=${r.insideY}`);
      check(`${label} is centred`, r.offCentre <= 1, `${r.offCentre}pt off centre`);
    }
    // Locking twice must not drift. An aspect ratio that nudges the frame, or
    // a minimum that clamps it, shows up here and nowhere else.
    if (results?.length === 2) {
      check('locking twice gives the same size',
        results[0].width === results[1].width && results[0].height === results[1].height,
        `${results[0].width}x${results[0].height} then ${results[1].width}x${results[1].height}`);
    }
    check('--capture locks the window at launch',
      byFlag?.width === results?.[0]?.width && byFlag?.height === results?.[0]?.height,
      `${byFlag?.width}x${byFlag?.height}`);
    check('Cmd/Ctrl+Alt+1 snaps the window',
      byKey?.width === results?.[0]?.width && byKey?.height === results?.[0]?.height,
      `${byKey?.width}x${byKey?.height}`);
    check('unlocking restores the original minimum', restored?.width === 960 && restored?.height === 600,
      `${restored?.width}x${restored?.height}`);
  }
}

console.log(failures ? `\n${failures} failed` : '\nall good');
process.exit(failures ? 1 : 0);
