#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:phoneprompts
//
// THE THREE PROMPTS ARE ALL ABOUT A DEVICE THIS SUITE CANNOT RUN ON, and every
// way they can be wrong is a way that is invisible on a laptop:
//
//   A ROW THAT LATCHES          the whole point of the surface is that nothing
//                               in it is "shown" — every row is the current
//                               answer to a live question. The failure is the
//                               rotate prompt still sitting on a landscape
//                               screen, or the fullscreen row still offering a
//                               display the player already took. Neither throws,
//                               and neither is reachable from a desktop.
//   A ROW ON THE WRONG SCREEN   the title card is an opaque layer over the whole
//                               overlay, so a prompt under it is styled,
//                               measured and completely invisible — it looks
//                               exactly like a prompt that correctly decided not
//                               to speak.
//   THE STAGE IS PUSHED ONCE    main.js derives the stage every frame rather
//                               than pushing it at each route, because a route
//                               that forgets to push strands a row with nothing
//                               able to take it down. A refactor that turns that
//                               back into a push is invisible here unless it is
//                               asserted.
//   A DISMISSAL THAT COMES BACK the ledger is the one piece of state in the
//                               file, and the one thing a player will notice if
//                               it is wrong.
//   THE MOUNT IS DROPPED        a refactor of ui.js loses one line and the stack
//                               is simply not there. Nothing throws, and nothing
//                               on a desktop would ever show it anyway.
//
//   node tools/phone-prompt-test.mjs
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
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.localStorage = dom.window.localStorage;

// --- the device, faked at the seams the code actually asks through -----------
// TWO QUERIES, ANSWERED SEPARATELY, and that is the whole reason this stub is
// not the one in fullscreen-button-test.mjs. A stub that returns one `matches`
// for every question cannot tell "a thumb" from "held upright", so the rotate
// row and the sound row would be indistinguishable — and the single bug this
// file exists to catch (a row answering the wrong question) would pass.
let touch = true;
let portrait = true;
const listeners = new Map(); // query string -> Set of handlers
dom.window.matchMedia = (q) => {
  const answer = () => (q.includes('orientation: portrait') ? portrait
    : q.includes('pointer: coarse') ? touch
      : false);
  const set = listeners.get(q) ?? new Set();
  listeners.set(q, set);
  return {
    media: q,
    get matches() { return answer(); },
    addEventListener(_t, fn) { set.add(fn); },
    removeEventListener(_t, fn) { set.delete(fn); },
  };
};
// Fire the change events a real browser would, so the surface is exercised
// through its listeners rather than only through a hand-called refresh().
function flip({ toTouch = touch, toPortrait = portrait } = {}) {
  touch = toTouch;
  portrait = toPortrait;
  // ui.js's markTouch listens to the same query and rewrites the class; the
  // prompts then re-ask. Done first so the class is already right by the time
  // their own handler runs — which is the ordering the real page has, since
  // markTouch is registered at initUI and this surface is mounted after it.
  markTouch?.();
  for (const set of listeners.values()) for (const fn of set) fn({ matches: true });
}

// The Fullscreen API, present and available unless a test takes it away.
function giveApi() {
  document.documentElement.requestFullscreen = () => Promise.resolve();
  document.fullscreenEnabled = true;
  document.exitFullscreen = () => Promise.resolve();
}
function takeApi() {
  delete document.documentElement.requestFullscreen;
  delete document.documentElement.webkitRequestFullscreen;
  for (const k of ['fullscreenEnabled', 'webkitFullscreenEnabled', 'exitFullscreen',
    'webkitExitFullscreen', 'fullscreenElement', 'webkitFullscreenElement']) delete document[k];
}
giveApi();

const warnings = [];
console.warn = (...a) => warnings.push(a.map(String).join(' '));

await import('./vite-loader.mjs');
const {
  mountMobilePrompts, setMobilePromptStage, resetMobilePromptStage, PROMPT_CSS,
} = await import('../path/src/ui/mobilePrompts.js');
const { settings, setSetting } = await import('../path/src/systems/settings.js');

// THE UI ROOT, MARKED THE WAY ui.js MARKS IT. `.sv-touch` is the game's single
// answer to "is there a thumb on this screen" (see markTouch in ui.js), and the
// prompts read it rather than the media query — so the harness has to set it,
// exactly as `npm run layout` does for the device it is standing in for.
const host = document.createElement('div');
host.className = 'sv-ui';
document.body.appendChild(host);
// markTouch's own rule, restated here: the class follows the query.
const markTouch = () => host.classList.toggle('sv-touch', touch);
markTouch();
const stack = mountMobilePrompts({ parent: host });
const up = () => stack.shown().sort().join(',');

// ===========================================================================
section('1. nothing speaks over the title card');
// ===========================================================================
// The card is an opaque z-index 20 layer, so a row that draws under it is a row
// the player cannot see and cannot dismiss.
check('the stage starts on the splash', up() === '', `showing: ${up() || 'nothing'}`);
check('and the container is not a live pointer target either',
  stack.el.hidden === true && stack.el.style.display === 'none');

// ===========================================================================
section('2. the menu is where the two setup rows live');
// ===========================================================================
setMobilePromptStage('menu');
check('a phone in a browser on the menu gets all three',
  up() === 'fullscreen,rotate,sound', `showing: ${up()}`);

setMobilePromptStage('run');
check('a run gets only the one that can change mid-fight',
  up() === 'rotate', `showing: ${up() || 'nothing'}`);
setMobilePromptStage('menu');

// ===========================================================================
section('3. every condition is live — nothing latches');
// ===========================================================================
// THE ROW THIS FILE IS REALLY ABOUT. Turning the phone must take it down on the
// media query, not at the next resize and not never.
flip({ toPortrait: false });
check('turning the phone sideways takes the rotate row down', !stack.shown().includes('rotate'),
  `showing: ${up()}`);
flip({ toPortrait: true });
check('and turning it back brings it back', stack.shown().includes('rotate'), `showing: ${up()}`);

// ...and the same question asked through the other event, because iOS fires
// orientationchange before the viewport has finished changing shape and some
// shells fire only one of the two.
portrait = false;
window.dispatchEvent(new dom.window.Event('orientationchange'));
check('orientationchange is listened for as well as the query',
  !stack.shown().includes('rotate'), `showing: ${up()}`);
portrait = true;
window.dispatchEvent(new dom.window.Event('resize'));
check('and so is resize', stack.shown().includes('rotate'), `showing: ${up()}`);

// The display being taken is what answers the fullscreen row, and it is the
// same path the player's own escape gesture takes — the only way the row can
// learn about a change it did not cause.
document.fullscreenElement = document.documentElement;
document.dispatchEvent(new dom.window.Event('fullscreenchange'));
check('taking the whole display takes the fullscreen row down',
  !stack.shown().includes('fullscreen'), `showing: ${up()}`);
delete document.fullscreenElement;
document.dispatchEvent(new dom.window.Event('webkitfullscreenchange'));
check("and Safari's own event name is listened for too", stack.shown().includes('fullscreen'),
  `showing: ${up()}`);

takeApi();
stack.refresh();
check('a browser that cannot do fullscreen is not offered it',
  !stack.shown().includes('fullscreen'), 'a dead row is worse than a missing one');
giveApi();
stack.refresh();

dom.window.Capacitor = { isNativePlatform: () => true };
stack.refresh();
check('nor the iOS app, which owns its own window', !stack.shown().includes('fullscreen'));
delete dom.window.Capacitor;
stack.refresh();

// ===========================================================================
section('4. the sound row does not argue with a choice it was asked to make');
// ===========================================================================
check('it is up while the game thinks it should be heard', stack.shown().includes('sound'));
setSetting('audio.muted', true);
check('a player who muted the game is not told to unmute their phone',
  !stack.shown().includes('sound'), `showing: ${up()}`);
check('and it went on the setting rather than at the next resize',
  settings.audio.muted === true);
setSetting('audio.muted', false);
check('unmuting brings the question back', stack.shown().includes('sound'), `showing: ${up()}`);

// ===========================================================================
section('5. a mouse is never any of this');
// ===========================================================================
flip({ toTouch: false });
check('no thumb, no prompts', up() === '', `showing: ${up() || 'nothing'}`);
check('and the empty stack stops being a pointer target',
  stack.el.hidden === true && stack.el.style.display === 'none');
flip({ toTouch: true });
check('plugging the mouse back out brings them back', up() === 'fullscreen,rotate,sound');

// ===========================================================================
section('6. dismissed means dismissed');
// ===========================================================================
const x = stack.el.querySelector('[data-prompt="rotate"] .sv-phone-prompt-x');
x.dispatchEvent(new dom.window.Event('click'));
check('the X takes its own row down and leaves the others', up() === 'fullscreen,sound',
  `showing: ${up()}`);

// A SECOND MOUNT, the way a reload of the page is. The ledger has to survive it
// — a dismissal that comes back is the one thing in this file a player notices.
stack.remove();
resetMobilePromptStage();
const again = mountMobilePrompts({ parent: host });
setMobilePromptStage('menu');
check('and it is still dismissed on the next page load',
  again.shown().sort().join(',') === 'fullscreen,sound', `showing: ${again.shown().join(',')}`);

// ...but a HAND-EDITED key cannot silence a prompt that does not exist yet.
localStorage.setItem('sealSurvivor.phonePrompts.v1', JSON.stringify(['rotate', 'somethingElse']));
again.remove();
resetMobilePromptStage();
const third = mountMobilePrompts({ parent: host });
setMobilePromptStage('menu');
check('an unknown id in the ledger is dropped rather than trusted',
  third.shown().sort().join(',') === 'fullscreen,sound', `showing: ${third.shown().join(',')}`);

// ===========================================================================
section('7. the copy is a table, and the mount is really there');
// ===========================================================================
const text = (id) => third.el.querySelector(`[data-prompt="${id}"] .sv-phone-prompt-text`).textContent;
for (const id of ['sound', 'rotate', 'fullscreen']) {
  check(`the ${id} row has a line in it`, text(id).trim().length > 0);
  // uiText() falls back to the ID when a row is missing, which is the one
  // failure that renders as something and means nothing.
  check(`and it is not the id showing through`, !/^mobile[A-Za-z]+Prompt$/.test(text(id).trim()),
    text(id));
}
const dismissLabel = third.el.querySelector('.sv-phone-prompt-x').getAttribute('aria-label');
check('the X has a spoken label that is not a missing row',
  !!dismissLabel && dismissLabel !== 'mobilePromptDismiss', dismissLabel);

// ===========================================================================
section('8. where it sits, and how big the target is');
// ===========================================================================
// AGAINST THE SOURCE, NOT THE MOUNTED NODE. jsdom rewrites env() into nonsense
// on the way into a stylesheet, so a check read back off the element fails on
// styling that is perfectly correct on a phone.
//
// AND THIS IS THE ONLY PLACE THE GEOMETRY IS CHECKED AT ALL. `npm run layout`
// measures real surfaces at real device sizes, but it drives an iframe on a
// laptop — `pointer: coarse` is inherited from the machine, not from the device
// being stood in for — so every row here answers "no thumb" and is never drawn
// in a single one of its 128 tiles. The same blind spot the fullscreen button
// has, and the same answer.
check('it opts back into pointer events', /pointer-events:\s*all/.test(PROMPT_CSS),
  '.sv-ui is pointer-events:none and that inherits');
check('the empty container does NOT, so it cannot eat the ocean',
  /\.sv-phone-prompts \{[^}]*pointer-events:\s*none/.test(PROMPT_CSS));
check('the X is a thumb-sized target', /width:\s*44px;\s*height:\s*44px/.test(PROMPT_CSS),
  'TAP_MIN in tools/layout/layout-audit.js');
check('it is inside the safe area at the bottom', /env\(safe-area-inset-bottom/.test(PROMPT_CSS));
check('it cannot be wider than the screen it is on',
  /width:\s*min\(340px, calc\(100vw - 32px\)\)/.test(PROMPT_CSS),
  'a fixed width is a row hanging off a 375px phone');
check('it is under the menus rather than over them', /z-index:\s*5/.test(PROMPT_CSS),
  '.sv-center surfaces are 8, and a prompt over a menu gets tapped by mistake');
check('it clears the pause and fullscreen buttons rather than sitting on them',
  /bottom:\s*calc/.test(PROMPT_CSS) && !/\btop:\s*calc/.test(PROMPT_CSS),
  'both of those live in the top-left column');
check('a press cannot also raise the iOS selection sheet',
  /-webkit-touch-callout:\s*none/.test(PROMPT_CSS));
check('and the entrance is behind a reduced-motion guard',
  /@media \(prefers-reduced-motion: no-preference\)/.test(PROMPT_CSS));

third.remove();
check('and removal takes the stack with it', host.querySelector('.sv-phone-prompts') === null);

const ui = readFileSync(join(ROOT, 'path/src/ui/ui.js'), 'utf8');
check('ui.js mounts it', /mountMobilePrompts\(\{\s*parent:\s*root/.test(ui));
check('and it exports the one thing main.js needs to tell the splash from the menu',
  /export function splashUp\(\)/.test(ui));

const main = readFileSync(join(ROOT, 'path/src/main.js'), 'utf8');
check('main.js sets the stage', /setMobilePromptStage\(/.test(main));
// DERIVED, NOT PUSHED. If this ever becomes a call at each route instead, a
// route that forgets to make it strands a row on the wrong screen — see the
// header. The assertion is that the call sits beside the pause button at the
// top of the frame, which is the one place that cannot be skipped.
check('from the frame, beside the pause button, rather than at each route',
  /setPauseButtonVisible\(canPause\(\)[\s\S]{0,1600}?setMobilePromptStage\(/.test(main),
  'a push per route is a route that gets forgotten');
check('and it can tell the title card from the menu',
  /splashUp\(\)\s*\?\s*'splash'/.test(main));

// ===========================================================================
section('9. the two reading rows close themselves');
// ===========================================================================
// THE CLOCK IS THE ONE PIECE OF THIS SURFACE THAT LOOKS IDENTICAL TO A BUG. A
// row that never closes and a row that closed itself are the same screenshot
// eight seconds apart, and a row that closes while its question is still true
// is indistinguishable from the latching failure this whole file is against —
// so both directions are asserted, at a delay the harness sets rather than the
// eight seconds a phone gets.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
localStorage.removeItem('sealSurvivor.phonePrompts.v1');
resetMobilePromptStage();
const timed = mountMobilePrompts({ parent: host, autoDismissMs: 30 });
setMobilePromptStage('menu');
check('all three are up to begin with', timed.shown().sort().join(',') === 'fullscreen,rotate,sound',
  `showing: ${timed.shown().join(',')}`);
await sleep(90);
check('the sound and rotate rows are gone without a tap',
  timed.shown().sort().join(',') === 'fullscreen', `showing: ${timed.shown().join(',') || 'nothing'}`);
check('and the offer with a decision in it is still standing',
  timed.shown().includes('fullscreen'), 'an offer that expires while you decide is worse than one you close');

// It went through the LEDGER, not through a hidden flag — so a row that closed
// itself is closed for good, exactly as a tapped one is.
timed.remove();
resetMobilePromptStage();
const afterTimer = mountMobilePrompts({ parent: host });
setMobilePromptStage('menu');
check('a row that timed out does not come back next page load',
  afterTimer.shown().sort().join(',') === 'fullscreen', `showing: ${afterTimer.shown().join(',')}`);
afterTimer.remove();

// ...and the clock is thrown away rather than paused when the row goes down for
// its own reason. A rotate row that was up for a moment before the phone turned
// was not read, and must get its whole time again the next time it is upright.
localStorage.removeItem('sealSurvivor.phonePrompts.v1');
resetMobilePromptStage();
const restarts = mountMobilePrompts({ parent: host, autoDismissMs: 60 });
setMobilePromptStage('run'); // the one stage where rotate is alone
flip({ toPortrait: false });
await sleep(120);
flip({ toPortrait: true });
check('a clock that never finished is not carried over to the next time',
  restarts.shown().includes('rotate'), `showing: ${restarts.shown().join(',') || 'nothing'}`);
await sleep(120);
check('and it does finish once the row has actually been up that long',
  !restarts.shown().includes('rotate'), `showing: ${restarts.shown().join(',') || 'nothing'}`);
restarts.remove();

console.log(failures ? `\n${failures} failed` : '\nall good');
process.exit(failures ? 1 : 0);
