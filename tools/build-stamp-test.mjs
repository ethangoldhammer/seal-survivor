#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:buildstamp
//
// THE NUMBER ON THE GLASS. The stamp exists so a phone in your hand can say
// which build it is running, and every way it fails is silent:
//
//   THE DEFINE GOES MISSING     __BUILD_NUMBER__ is a vite substitution. Drop
//                               it from the config and the stamp still draws,
//                               still looks deliberate, and reads "dev" on a
//                               real build forever.
//   THE TWO NUMBERS DRIFT       CFBundleVersion comes from ship-ios.mjs and
//                               the stamp comes from vite. If they are not the
//                               same number the stamp is worse than nothing —
//                               it is a confident wrong answer.
//   THE MOUNT IS REMOVED        a refactor of either screen drops one line and
//                               the stamp is simply not there. Nothing throws.
//
// The menu screen cannot run headless (GL context, the loaded seal, a post
// stack — see tools/main-menu-test.mjs), so the two mounts are checked at the
// source level. That is a weaker check than driving them and it is stated
// rather than dressed up: it catches deletion, not misplacement.
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// jsdom before the game module, per the harness recipe.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;

const { mountBuildStamp, buildLabel, BUILD_NUMBER, BUILD_SHA, STAMP_CSS } = await import('../path/src/ui/buildStamp.js');

section('the module survives having no defines at all');
// This is the Node case — no vite, so neither identifier exists. A bare
// reference would be a ReferenceError, which would take every menu test with
// it, so the fallback is the thing being checked here.
check('BUILD_NUMBER falls back rather than throwing', BUILD_NUMBER === 'dev', BUILD_NUMBER);
check('BUILD_SHA falls back rather than throwing', BUILD_SHA === 'dev', BUILD_SHA);
check('the label is not an empty corner', buildLabel() === 'dev', `"${buildLabel()}"`);

section('what it draws');
const host = document.createElement('div');
document.body.appendChild(host);
const stamp = mountBuildStamp(host);
check('it lands in the element it was given', host.lastChild === stamp.el);
check('it carries the text', stamp.el.textContent === buildLabel(), `"${stamp.el.textContent}"`);
check('it is findable by class', stamp.el.className === 'sv-build-stamp');
// Read from the module's own constant, NOT from the element: jsdom's CSS
// engine rewrites env() into `env(0px * , * safe-area-inset-right)` on its way
// into a style attribute, so an assertion against a jsdom element's cssText
// fails on styling that is perfectly correct in the browser this ships to.
check('it cannot eat a tap', /pointer-events:\s*none/.test(STAMP_CSS));
check('it sits inside the safe area on both axes',
  /env\(safe-area-inset-right/.test(STAMP_CSS) && /env\(safe-area-inset-bottom/.test(STAMP_CSS));
check('digits are tabular, so the number does not jitter', /tabular-nums/.test(STAMP_CSS));
check('it is legible over art', /text-shadow/.test(STAMP_CSS));
check('the element really was styled', !!stamp.el.getAttribute('style')?.includes('position: absolute'));
stamp.remove();
check('remove() takes it off the page', host.children.length === 0);

section('the label reads number first');
// The number is what increments, so it is what a person compares against the
// last one; the sha is the tiebreak. Asserted through the real module by
// faking the defines a build would have supplied.
globalThis.__BUILD_NUMBER__ = '412';
globalThis.__BUILD_ID__ = 'abc1234';
const fresh = await import(`../path/src/ui/buildStamp.js?defines=1`);
check('a real build shows "<number> · <sha>"', fresh.buildLabel() === '412 · abc1234', fresh.buildLabel());
globalThis.__BUILD_NUMBER__ = 'dev';
const devish = await import(`../path/src/ui/buildStamp.js?defines=2`);
check('a dev server with a real sha shows the sha alone', devish.buildLabel() === 'abc1234', devish.buildLabel());
delete globalThis.__BUILD_NUMBER__;
delete globalThis.__BUILD_ID__;

section('the vite define is actually wired');
const viteConfig = (await import('../vite.config.js')).default;
const built = viteConfig({ command: 'build', mode: 'production' });
const served = viteConfig({ command: 'serve', mode: 'development' });
check('a production build defines a number', typeof built.define.__BUILD_NUMBER__ === 'string');
check('...and it is a bare integer, quoted as a string literal',
  /^"\d+"$/.test(built.define.__BUILD_NUMBER__), built.define.__BUILD_NUMBER__);
check('a dev server defines "dev" instead of a number that would freeze',
  served.define.__BUILD_NUMBER__ === '"dev"', served.define.__BUILD_NUMBER__);

// The agreement that makes the stamp trustworthy: ship-ios.mjs passes the
// number it wrote into CFBundleVersion as SEAL_BUILD, and vite must prefer it
// over deriving its own.
process.env.SEAL_BUILD = '777';
const forced = viteConfig({ command: 'build', mode: 'production' });
check('SEAL_BUILD wins, so the screen and CFBundleVersion cannot disagree',
  forced.define.__BUILD_NUMBER__ === '"777"', forced.define.__BUILD_NUMBER__);
delete process.env.SEAL_BUILD;

section('both screens still mount it');
const splash = await readFile(join(ROOT, 'path/src/ui/riveSplash.js'), 'utf8');
const menu = await readFile(join(ROOT, 'path/src/systems/mainMenu.js'), 'utf8');
check('the splash mounts the stamp', /mountBuildStamp\(wrap\)/.test(splash));
check('the menu mounts the stamp', /mountBuildStamp\(labelLayer\)/.test(menu));
check('the menu mounts it in the layer it tears down', /labelLayer\.remove\(\)/.test(menu));
// One expression, used twice. Two copies would drift the day the buttons' exit
// is retuned, and the stamp would hang in the corner of the opening shot.
check('the stamp leaves on the buttons\' own fade curve',
  /stamp\.el\.style\.opacity = String\(labelFade\(w\)\)/.test(menu)
  && /labels\[i\]\.style\.opacity = String\(labelFade\(w\)\)/.test(menu));

console.log(failures ? `\n${failures} FAILED\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
