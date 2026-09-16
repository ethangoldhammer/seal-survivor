#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:fullscreen
//
// THE ONE CONTROL THAT IS ONLY EVER USED ON A DEVICE THIS SUITE CANNOT RUN ON.
// A phone in a browser is the whole reason the button exists, so every way it
// can be wrong is a way that is invisible here and invisible on a laptop:
//
//   IT DRAWS ON A SHELL THAT CANNOT DO IT   Element fullscreen did not exist on
//                                           iPhone for most of this game's life
//                                           — the method was ABSENT, not
//                                           refused — so a button drawn on
//                                           faith is a dead control on exactly
//                                           the device that wants it, and a
//                                           dead control is worse than none:
//                                           you have to press it to find out.
//   THE PREFIX IS MISSED                    Safari answers only the webkit-
//                                           spelled getter, and a miss there
//                                           reads as "not fullscreen" — so the
//                                           button re-requests instead of
//                                           exiting and there is no way back.
//   THE GLYPH RUNS AHEAD OF THE REQUEST     the request can be refused. A
//                                           button that has already redrawn
//                                           itself as "leave" over a windowed
//                                           game is lying about the state of
//                                           the display.
//   THE MOUNT IS DROPPED                    a refactor of ui.js loses one line
//                                           and the button is simply not there.
//                                           Nothing throws, and nothing on a
//                                           desktop would ever show it anyway.
//
//   node tools/fullscreen-button-test.mjs
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// jsdom before the game modules, per the harness recipe.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;

// --- the device, faked at the two seams the code actually asks through -------
// touchPrimary() is a media query and platform.js reads globals the shells set,
// so both are controllable from here without either module knowing it is being
// tested.
let touch = true;
dom.window.matchMedia = () => ({ matches: touch, addEventListener() {}, removeEventListener() {} });

// The Fullscreen API, absent until a test hands it over. jsdom implements none
// of it, which is the pre-iOS-26 iPhone exactly.
function giveApi({ prefixed = false, enabled = true, reject = false } = {}) {
  const el = document.documentElement;
  const name = prefixed ? 'webkitRequestFullscreen' : 'requestFullscreen';
  el[name] = function request() {
    requests.push(name);
    return reject ? Promise.reject(new Error('refused')) : Promise.resolve();
  };
  document[prefixed ? 'webkitFullscreenEnabled' : 'fullscreenEnabled'] = enabled;
  document[prefixed ? 'webkitExitFullscreen' : 'exitFullscreen'] = function exit() {
    requests.push(prefixed ? 'webkitExitFullscreen' : 'exitFullscreen');
    return Promise.resolve();
  };
}
function takeApi() {
  for (const k of ['requestFullscreen', 'webkitRequestFullscreen']) delete document.documentElement[k];
  for (const k of ['fullscreenEnabled', 'webkitFullscreenEnabled', 'exitFullscreen', 'webkitExitFullscreen',
    'fullscreenElement', 'webkitFullscreenElement']) delete document[k];
}
let requests = [];

// Quiet: a refused request warns on purpose, and the warning is the thing being
// asserted rather than noise to read.
const warnings = [];
console.warn = (...a) => warnings.push(a.map(String).join(' '));

await import('./vite-loader.mjs');
const FS = await import('../path/src/systems/fullscreen.js');
const { mountFullscreenButton, FS_BUTTON_CSS } = await import('../path/src/ui/fullscreenButton.js');

// ===========================================================================
section('1. the capability is asked, never assumed');
// ===========================================================================
takeApi();
check('an engine with no request method answers no', FS.fullscreenAvailable() === false,
  'the iPhone this button was written for, before Safari 26');
check('and asking to go fullscreen there does nothing rather than throwing',
  FS.enterFullscreen() === false);

giveApi({ enabled: false });
check('an embed that disallows it answers no', FS.fullscreenAvailable() === false,
  'fullscreenEnabled is present and false — a real refusal');

takeApi();
giveApi({ prefixed: true });
check('the webkit spelling counts', FS.fullscreenAvailable() === true);

takeApi();
giveApi();
check('so does the plain one', FS.fullscreenAvailable() === true);

// ===========================================================================
section('2. which way is out');
// ===========================================================================
requests = [];
check('out of fullscreen, it asks to go in', FS.toggleFullscreen() === true && requests.at(-1) === 'requestFullscreen',
  requests.join(','));

document.fullscreenElement = document.documentElement;
check('and the element getter is what says we are in', FS.isFullscreen() === true);
requests = [];
FS.toggleFullscreen();
check('so the next press exits rather than re-requesting', requests.at(-1) === 'exitFullscreen',
  requests.join(','));

// THE PREFIX, on its own. This is the one that has no symptom short of a player
// stuck in a fullscreen they cannot leave.
delete document.fullscreenElement;
document.webkitFullscreenElement = document.documentElement;
check('a webkit-only Safari still reads as in fullscreen', FS.isFullscreen() === true);
delete document.webkitFullscreenElement;

// A refusal is reported and survived — both matter: silence would make an
// iframe that blocks fullscreen look like a dead control.
takeApi();
giveApi({ reject: true });
warnings.length = 0;
FS.enterFullscreen();
await new Promise((r) => setTimeout(r, 0));
check('a refused request warns instead of vanishing', warnings.some((w) => w.includes('[fullscreen]')),
  warnings.join(' | '));
takeApi();
giveApi();

// ===========================================================================
section('3. when the button may be on screen at all');
// ===========================================================================
const host = document.createElement('div');
document.body.appendChild(host);

const btn = mountFullscreenButton({ parent: host });
check('it lands in the layer it was given', host.lastChild === btn.el);
check('a phone in a browser with the API gets it', btn.el.hidden === false && btn.el.style.display === 'block');

touch = false;
btn.refresh();
check('a mouse does not — it has Shift+F and F11', btn.el.hidden === true);
touch = true;

takeApi();
btn.refresh();
check('nor does a browser that cannot do it', btn.el.hidden === true,
  'a dead control is worse than a missing one');
giveApi();

dom.window.Capacitor = { isNativePlatform: () => true };
btn.refresh();
check('nor the iOS app, which owns its own window', btn.el.hidden === true);
delete dom.window.Capacitor;

dom.window.sealDesktop = { isDesktop: true };
btn.refresh();
check('nor the desktop build', btn.el.hidden === true);
delete dom.window.sealDesktop;
btn.refresh();

// ===========================================================================
section('4. the glyph follows the display, not the press');
// ===========================================================================
const shows = (g) => btn.el.querySelector(g).style.display !== 'none';
check('it starts as "take the screen"', shows('.sv-fsbtn-in') && !shows('.sv-fsbtn-out'));

requests = [];
btn.el.click();
check('a press asks', requests.at(-1) === 'requestFullscreen', requests.join(','));
check('and the button has NOT redrawn itself yet', shows('.sv-fsbtn-in'),
  'the request can still be refused');

// The browser saying yes is what turns it round — and it is the same path the
// player's own escape gesture takes, which is the only way the button can learn
// about an exit it did not ask for.
document.fullscreenElement = document.documentElement;
document.dispatchEvent(new dom.window.Event('fullscreenchange'));
check('the change event turns it round', shows('.sv-fsbtn-out') && !shows('.sv-fsbtn-in'));
check('and the spoken label turns round with it',
  btn.el.getAttribute('aria-label') !== '' && btn.el.getAttribute('aria-pressed') === 'true');
const inLabel = btn.el.getAttribute('aria-label');

// Safari fires only the prefixed event.
delete document.fullscreenElement;
document.dispatchEvent(new dom.window.Event('webkitfullscreenchange'));
check('and Safari\'s own event name is listened for too', shows('.sv-fsbtn-in'));
check('the two labels are different lines', btn.el.getAttribute('aria-label') !== inLabel,
  `"${btn.el.getAttribute('aria-label')}" vs "${inLabel}"`);
check('neither is a missing row', !/^fullscreen(Enter|Exit)$/.test(btn.el.getAttribute('aria-label')),
  'uiText falls back to the id, which would be read aloud as one');

// ===========================================================================
section('5. where it sits, and that it is really there');
// ===========================================================================
// Read from the module's own constant, NOT the element: jsdom's CSS engine
// rewrites env() into nonsense on the way into a style attribute, so asserting
// against cssText fails on styling that is perfectly correct on a phone.
check('it opts back into pointer events', /pointer-events:\s*all/.test(FS_BUTTON_CSS),
  '.sv-ui is pointer-events:none and that inherits');
check('it is inside the safe area on both axes',
  /env\(safe-area-inset-top/.test(FS_BUTTON_CSS) && /env\(safe-area-inset-left/.test(FS_BUTTON_CSS));
check('it clears the pause button rather than sitting on it', /top:calc\(86px/.test(FS_BUTTON_CSS),
  '34 of inset + 44 of button + 8 of gap');
check('it is a thumb-sized target', /width:44px; height:44px/.test(FS_BUTTON_CSS));
check('a press cannot also scroll or raise the iOS selection sheet',
  /touch-action:\s*none/.test(FS_BUTTON_CSS) && /-webkit-touch-callout:\s*none/.test(FS_BUTTON_CSS));
check('it is under the menus rather than over them', /z-index:4/.test(FS_BUTTON_CSS),
  '.sv-center surfaces are 8');

btn.remove();
check('and it takes its listeners with it', host.querySelector('.sv-fsbtn') === null);

const ui = readFileSync(join(ROOT, 'path/src/ui/ui.js'), 'utf8');
check('ui.js mounts it', /mountFullscreenButton\(\{\s*parent:\s*root/.test(ui));
const main = readFileSync(join(ROOT, 'path/src/main.js'), 'utf8');
check('Shift+F asks the same module, so the two cannot drift',
  /import \{ toggleFullscreen \} from '\.\/systems\/fullscreen\.js'/.test(main));

console.log(failures ? `\n${failures} failed` : '\nall good');
process.exit(failures ? 1 : 0);
