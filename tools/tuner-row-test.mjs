#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:tunerrow
//
// One rule, and it is a rule the tuner broke live on 2026-08-14: BUILDING A
// PANEL MUST NOT CHANGE ANY VALUE.
//
// `<input type=range>` clamps an undefined value to the middle of its range,
// and buildRow used to push that clamp straight back into CONFIG. So merely
// opening the ` panel invented a number for every schema path the config did
// not declare — and the next save wrote it to disk, where a saved value beats
// config.js forever. Adding a single `shell glow` row put 0.5 on all seven
// bioluminescence presets and gave every glowing fish a bright shell.
//
// That class of path is normal, not exotic: the glow presets are DIFFS against
// `base` (withoutInheritedPresetKeys), so most of their keys are absent by
// design, and the same is true of any key added to a shared item list.
// ---------------------------------------------------------------------------

// LOAD ORDER: jsdom FIRST, then the vite loader hooks, then the game modules —
// the other way round breaks the CJS chain jsdom loads through and fails with
// an error about an encoding fallback that has nothing to do with anything.
// Same recipe as tools/menu-sound-test.mjs, which is why this script is run
// WITHOUT --import in package.json.
import { JSDOM } from 'jsdom';

// `url` set, or localStorage throws on the opaque origin.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);

await import('./vite-loader.mjs');
const { CONFIG, getPath, setPath } = await import('../path/src/config.js');
const { buildRow } = await import('../path/src/ui/tunerControls.js');

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

console.log('\nBUILDING A ROW MUST NOT INVENT A VALUE');

// An absent path, in a container that really exists — exactly the shape a new
// key on a glow preset has.
{
  const path = 'biolumSkin.presets.lantern.__testAbsent';
  check('the path really is absent to start with', getPath(CONFIG, path) === undefined);
  const row = buildRow({ path, min: 0, max: 1, step: 0.01, label: 'test' });
  check('...and building a slider for it leaves it absent',
    getPath(CONFIG, path) === undefined,
    `now ${JSON.stringify(getPath(CONFIG, path))}`);
  // The row still has to be usable and honest about what it shows: the low end
  // of the range, not the midpoint the input would have picked on its own.
  const slider = row.querySelector('input[type=range]');
  check('...and shows the low end rather than the middle',
    Number(slider.value) === 0, `slider reads ${slider.value}`);

  // ...but a real edit is still a real edit.
  slider.value = '0.42';
  slider.dispatchEvent(new dom.window.Event('input'));
  check('moving it writes, like any other control',
    Math.abs(getPath(CONFIG, path) - 0.42) < 1e-9, `${getPath(CONFIG, path)}`);
  setPath(CONFIG, path, undefined);
  delete CONFIG.biolumSkin.presets.lantern.__testAbsent;
}

// A declared path must be untouched — including one whose value sits outside
// the row's own min/max, which the input would clamp and write back.
{
  const path = 'biolumSkin.base.strength';
  const before = getPath(CONFIG, path);
  buildRow({ path, min: 0, max: 4, step: 0.05, label: 'test' });
  check('a declared value survives being rendered',
    getPath(CONFIG, path) === before, `${before} -> ${getPath(CONFIG, path)}`);
}
{
  const path = 'biolumSkin.base.__testOutOfRange';
  setPath(CONFIG, path, 9);
  buildRow({ path, min: 0, max: 1, step: 0.01, label: 'test' });
  check('...and so does one the row could not display',
    getPath(CONFIG, path) === 9, `${getPath(CONFIG, path)}`);
  delete CONFIG.biolumSkin.base.__testOutOfRange;
}

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
