#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:pause
//
// The pause menu and the player-settings layer under it, driven through the
// real modules in jsdom.
//
// The hazards this pins down are all silent ones — every single failure here
// would look like "the game is fine" right up until it isn't:
//
//   LEAKING INTO CONFIG   the whole point of systems/settings.js is that a
//                         player's volume never reaches CONFIG, because
//                         saveTuning snapshots whole CONFIG sections and would
//                         ship one player's choices to everybody. A setter
//                         that wrote through to CONFIG would pass every
//                         gameplay test in the repo and be caught by nothing.
//   DEFAULTS THAT AREN'T  the scales must multiply out to exactly 1 and the
//                         overrides to null, or the shipped build quietly
//                         renders and sounds different from the authored one.
//   NaN INTO A GAIN NODE  localStorage is user-writable and survives across
//                         versions. A junk value reaching master.gain is
//                         silence, with nothing in the console.
//   AN UNREACHABLE MENU   a rebind that orphans an action, or a pause key that
//                         only toggles one way, strands the player in a paused
//                         game with no way out.
//   A KEY REACHING BOTH   binding "swim up" to D must not also steer the seal
//                         right on the frame it is bound.
//
// NOTE the load order: jsdom FIRST, then the vite loader hooks, then the game
// modules. The other way round breaks the CJS chain jsdom loads through and
// fails with an error about an encoding fallback that has nothing to do with
// anything. See the jsdom-harness recipe.
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// `url` set, or localStorage throws on the opaque origin the moment anything
// touches it — which here is the first line of the module under test.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Node 22 defines `navigator` as a getter-only global, so it has to be
// redefined rather than assigned — the plain assignment throws with a message
// about "an Object which has only a getter" that says nothing about jsdom.
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true,
});
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Image = dom.window.Image;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// jsdom's canvas is a stub. The reveal code only needs these to exist.
dom.window.HTMLCanvasElement.prototype.getContext = function getContext() {
  return {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    clearRect() {}, fillRect() {}, drawImage() {}, save() {}, restore() {},
    set fillStyle(v) { this._fill = v; }, get fillStyle() { return this._fill; },
  };
};
dom.window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';

const { registerHooks } = await import('node:module');
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@rive-app/canvas') return { url: 'stub:rive', format: 'module', shortCircuit: true };
    if (spec.endsWith('.riv?url')) return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === 'stub:rive') {
      return { format: 'module', shortCircuit: true, source: 'export class Rive { constructor(){} on(){} play(){} cleanup(){} } export const EventType = {}; export const Layout = class {}; export const Fit = {}; export const Alignment = {};' };
    }
    if (url === 'stub:rivurl') return { format: 'module', shortCircuit: true, source: 'export default "stub.riv";' };
    return next(url, ctx);
  },
});
await import('./vite-loader.mjs');

const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => warnings.push(a.map(String).join(' '));

const S = await import('../path/src/systems/settings.js');
const { CONFIG } = await import('../path/src/config.js');

const STORAGE_KEY = 'sealsurvivor.settings.v1';
const stored = () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');

// ---------------------------------------------------------------------------
section('Defaults are the authored build, exactly');
// Every one of these is a multiplication or a fallback that happens on the hot
// path of a shipped game. "Approximately 1" is not good enough: 0.9999 in the
// pixel-ratio cap is a different render target size.
check('sfx scale is exactly 1', S.sfxScale() === 1, String(S.sfxScale()));
check('music scale is exactly 1', S.musicScale() === 1, String(S.musicScale()));
check('resolution scale is exactly 1', S.resolutionScale() === 1, String(S.resolutionScale()));
check('shake scale is exactly 1', S.shakeScale() === 1, String(S.shakeScale()));
check('rumble scale is exactly 1', S.rumbleScale() === 1, String(S.rumbleScale()));
check('screen filter falls through to the authored preset',
  S.screenFilter('vhs') === 'vhs' && S.screenFilter('crt') === 'crt');
check('bloom falls through to the authored flag',
  S.bloomEnabled(true) === true && S.bloomEnabled(false) === false);
check('deadzone matches the constant it replaced', S.stickDeadzone() === 0.15,
  String(S.stickDeadzone()));

// ---------------------------------------------------------------------------
section('Nothing reaches CONFIG');
const authoredMaster = CONFIG.audio.masterVolume;
const authoredPreset = CONFIG.post.preset;
const authoredRatio = CONFIG.render.pixelRatio;
const authoredBloom = CONFIG.bloom.enabled;
S.setSetting('audio.master', 0.2);
S.setSetting('video.filter', 'vga');
S.setSetting('video.resolution', 0.5);
S.setSetting('video.bloom', false);
check('CONFIG.audio.masterVolume untouched', CONFIG.audio.masterVolume === authoredMaster);
check('CONFIG.post.preset untouched', CONFIG.post.preset === authoredPreset);
check('CONFIG.render.pixelRatio untouched', CONFIG.render.pixelRatio === authoredRatio);
check('CONFIG.bloom.enabled untouched', CONFIG.bloom.enabled === authoredBloom);
check('the override is what changed instead',
  S.screenFilter(authoredPreset) === 'vga' && S.bloomEnabled(true) === false
  && S.sfxScale() === 0.2 && S.resolutionScale() === 0.5);
S.resetSettings();

// ---------------------------------------------------------------------------
section('Mute');
S.setSetting('audio.master', 0.8);
S.setSetting('audio.music', 0.5);
S.setSetting('audio.muted', true);
check('mute zeroes the sfx scale', S.sfxScale() === 0);
// The bug this guards: mute used to be a flag checked at the top of playSfx
// only, so continuous voices (the mussel in flight, the strike wind-up) kept
// sounding through it. Both scales going to zero is what fixes that, because
// both are folded into gains those voices ride.
check('mute zeroes the music scale too', S.musicScale() === 0);
S.setSetting('audio.muted', false);
check('unmuting restores both, not just one',
  Math.abs(S.sfxScale() - 0.8) < 1e-9 && Math.abs(S.musicScale() - 0.4) < 1e-9,
  `${S.sfxScale()} / ${S.musicScale()}`);
S.resetSettings();

// ---------------------------------------------------------------------------
section('Persistence and hostile input');
S.setSetting('audio.music', 0.35);
S.setSetting('controls.deadzone', 0.3);
S.saveSettings({ immediate: true });
check('a change is written to its own key, not the tuning cache',
  stored().audio.music === 0.35 && stored().controls.deadzone === 0.3);
check('the tuning cache is untouched', localStorage.getItem('sealsurvivor.tuning') === null
  || !JSON.stringify(localStorage.getItem('sealsurvivor.tuning')).includes('0.35'));

// Straight into the store, the way a stale build or a hand-edited profile
// would leave it, then reload.
localStorage.setItem(STORAGE_KEY, JSON.stringify({
  audio: { master: 'loud', sfx: 99, music: -4, muted: 'yes' },
  video: { resolution: NaN, filter: 'kaleidoscope', shake: null, bloom: 'maybe' },
  controls: { deadzone: {}, keys: { up: 'tab', left: 12, strike: 'k' }, vibration: 0, rumble: 1e9 },
}));
S.loadSettings();
check('a non-numeric volume falls back to its default, not NaN',
  S.settings.audio.master === 1, String(S.settings.audio.master));
check('an over-range volume clamps to the maximum', S.settings.audio.sfx === 1);
check('an under-range volume clamps to the minimum', S.settings.audio.music === 0);
check('NaN never reaches the resolution scale',
  Number.isFinite(S.resolutionScale()) && S.resolutionScale() === 1);
check('an unknown filter name falls back to the authored preset',
  S.settings.video.filter === null && S.screenFilter('crt') === 'crt');
check('a non-boolean tri-state reads as "default"', S.settings.video.bloom === null);
check('a null range falls back rather than zeroing the shake', S.shakeScale() === 1);
check('a junk deadzone falls back', S.stickDeadzone() === 0.15);
check('an over-range rumble clamps', S.settings.controls.rumble === 1.5,
  String(S.settings.controls.rumble));
check('a RESERVED key in a saved profile is refused', S.settings.controls.keys.up === 'w');
check('a non-string binding is refused', S.settings.controls.keys.left === 'a');
check('a legitimate saved binding still loads', S.settings.controls.keys.strike === 'k');
// A truthy-but-wrong `vibration: 0` is a real shape an older build could have
// written; it has to read as OFF rather than as garbage.
check('a 0/1 boolean still means what it says', S.settings.controls.vibration === false
  && S.rumbleScale() === 0);

localStorage.setItem(STORAGE_KEY, '{ not json');
S.loadSettings();
check('unparseable settings fall back to defaults without throwing',
  S.settings.audio.master === 1 && S.sfxScale() === 1);
check('...and say so once', warnings.some((w) => w.includes('[settings]')));
localStorage.removeItem(STORAGE_KEY);
S.resetSettings();

// ---------------------------------------------------------------------------
section('Key bindings');
check('a default binding resolves', S.actionForKey('w') === 'up');
check('lookup is case-folded', S.actionForKey('W') === 'up');
check('an unbound key resolves to nothing', S.actionForKey('j') === null);

S.bindKey('up', 'i');
check('rebinding takes effect', S.actionForKey('i') === 'up' && S.actionForKey('w') === null);

// The one that matters. Binding "swim up" to the key "swim down" already holds
// must not leave `down` with nothing — a screen that can silently unbind an
// action is a screen that can strand the player.
S.bindKey('up', 's');
check('a collision SWAPS rather than orphaning the other action',
  S.actionForKey('s') === 'up' && S.actionForKey('i') === 'down',
  `s -> ${S.actionForKey('s')}, i -> ${S.actionForKey('i')}`);
const bound = Object.values(S.settings.controls.keys);
check('every action still holds a key', bound.every(Boolean) && new Set(bound).size === bound.length,
  bound.join(', '));

check('a reserved key is refused and changes nothing',
  S.bindKey('up', 'Tab') === false && S.actionForKey('s') === 'up');
check('Enter is refused too', S.bindKey('strike', 'Enter') === false);
check('an unknown action is refused', S.bindKey('fly', 'q') === false);
S.resetSettings('controls');
check('resetting the section restores the defaults',
  S.actionForKey('w') === 'up' && S.actionForKey('s') === 'down');

check('a space binding is labelled, not rendered blank', S.keyLabel(' ') === 'Space');
check('an unbound slot is labelled', S.keyLabel(null) === '—');
check('arrow keys read as words', S.keyLabel('arrowup') === 'Arrow Up');

// ---------------------------------------------------------------------------
section('input.js honours the bindings');
const inputMod = await import('../path/src/input.js');
// setKey is not exported — it is wired to window in initInput, which is the
// path a real key takes, so drive it that way.
const canvas = document.createElement('canvas');
canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
inputMod.initInput(canvas);
// Dispatched on document.body, NOT on window, and that is load-bearing rather
// than incidental. A real keypress goes to the focused ELEMENT and bubbles up,
// so window sees the capture phase before the bubble phase — which is what
// lets the pause menu's capture listener stop a key being bound from also
// reaching input.js. Dispatched straight at window it would be AT_TARGET
// instead, where registration order decides and the game listener (registered
// first) wins. Chrome and jsdom disagree about that case, so a harness that
// dispatched on window would be asserting something the browser does not do.
const press = (k, down = true) => document.body.dispatchEvent(
  new dom.window.KeyboardEvent(down ? 'keydown' : 'keyup', { key: k, bubbles: true })
);
// updateInput needs a camera to unproject through; only `move` is read here.
const fakeCamera = { isCamera: true, matrixWorld: null };
const readMove = () => {
  // A minimal stand-in for the camera path: aim falls back to the mouse only
  // when hasMouse, which no event here has set.
  inputMod.updateInput(fakeCamera, { x: 0, y: 0 });
  return { x: inputMod.input.move.x, y: inputMod.input.move.y };
};

press('w');
check('the default binding steers', readMove().y === 1);
press('w', false);
press('arrowup');
check('the fixed arrow alternate steers as well', readMove().y === 1);
press('arrowup', false);

S.bindKey('up', 'i');
press('w');
check('the OLD key stops steering after a rebind', readMove().y === 0);
press('w', false);
press('i');
check('the NEW key steers', readMove().y === 1);
press('i', false);
press('arrowup');
check('the arrow alternate survives the rebind', readMove().y === 1,
  'the arrows are the way back from a tangled binding — they must never be rebindable away');
press('arrowup', false);
check('a rebound key does not also do its old job',
  readMove().y === 0 && readMove().x === 0);
S.resetSettings('controls');

// The strike, which is the one action with an edge AND a held state.
press(' ');
inputMod.updateInput(fakeCamera, { x: 0, y: 0 });
check('the default strike key raises the press edge', inputMod.input.strike === true);
check('...and reads as held', inputMod.input.strikeHeld === true);
press(' ', false);
inputMod.updateInput(fakeCamera, { x: 0, y: 0 });
check('letting go raises the release edge', inputMod.input.strikeRelease === true);

S.bindKey('strike', 'f');
press('f');
inputMod.updateInput(fakeCamera, { x: 0, y: 0 });
check('the rebound strike key charges', inputMod.input.strike === true && inputMod.input.strikeHeld === true);
press('f', false);
inputMod.updateInput(fakeCamera, { x: 0, y: 0 });
press(' ');
inputMod.updateInput(fakeCamera, { x: 0, y: 0 });
check('the old strike key no longer charges', inputMod.input.strikeHeld === false);
press(' ', false);
S.resetSettings('controls');

// The deadzone is a setting now; the rescale must still start at the edge.
S.setSetting('controls.deadzone', 0.4);
check('the deadzone setting reaches the stick rescale', S.stickDeadzone() === 0.4);
S.resetSettings('controls');

// ---------------------------------------------------------------------------
section('The menu itself');
const pause = await import('../path/src/ui/pauseMenu.js');
let resumed = 0;
let restarted = 0;
// No reveal: the mask path is ui.js's and is covered by its own surfaces. What
// matters here is that the menu works when the reveal cannot run at all, which
// is a real configuration (reduced motion, no mask support).
pause.initPauseMenu({
  root: document.body,
  reveal: (name, opts) => { opts.onDone?.(); return false; },
  revealSeconds: () => 0,
  onResume: () => { resumed++; },
  onRestart: () => { restarted++; },
});

const wrap = document.getElementById('svPauseMenu');
const hidden = () => wrap.classList.contains('sv-hidden');
check('the menu starts hidden', hidden() && pause.isPauseOpen() === false);

pause.showPauseMenu();
check('opening shows it', !hidden() && pause.isPauseOpen() === true);
check('it lands on the Audio tab', document.querySelector('.sv-pm-tab.sv-pm-on').dataset.tab === 'audio');
check('every audio setting has a row',
  document.querySelectorAll('#svPauseBody .sv-pm-row').length === S.SCHEMA.audio.items.length,
  String(document.querySelectorAll('#svPauseBody .sv-pm-row').length));

// Keyboard nav, through the real window listener.
// On document.body for the same reason as `press` above — see the note there.
const menuKey = (k) => document.body.dispatchEvent(
  new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
);
const selected = () => [...document.querySelectorAll('.sv-pm-sel')];

check('the cursor opens on the tab strip',
  selected().length === 1 && selected()[0].id === 'svPauseTabs');
menuKey('ArrowRight');
check('left/right on the strip switches tab',
  document.querySelector('.sv-pm-tab.sv-pm-on').dataset.tab === 'video');
menuKey('ArrowLeft');
check('and switches back', document.querySelector('.sv-pm-tab.sv-pm-on').dataset.tab === 'audio');

menuKey('ArrowDown');
const masterBefore = S.settings.audio.master;
menuKey('ArrowLeft');
check('left on a slider row lowers the setting', S.settings.audio.master < masterBefore,
  `${masterBefore} -> ${S.settings.audio.master}`);
menuKey('ArrowRight');
check('right puts it back', S.settings.audio.master === masterBefore);
// At the top of the range there is nowhere to go, and the clamp must hold
// rather than the slider running off into 1.05.
for (let i = 0; i < 6; i++) menuKey('ArrowRight');
check('a slider clamps at its maximum', S.settings.audio.master === 1);
for (let i = 0; i < 30; i++) menuKey('ArrowLeft');
check('and at its minimum', S.settings.audio.master === 0);
check('the readout follows the value',
  document.querySelectorAll('#svPauseBody .sv-pm-val')[0].textContent === '0%');

// Down past the last row wraps to the top, which is how a pad player gets back
// to the tab strip without holding up through the whole list.
const rowCount = document.querySelectorAll('#svPauseBody .sv-pm-row').length;
for (let i = 0; i < rowCount + 4; i++) menuKey('ArrowDown');
check('the cursor wraps rather than sticking at the end', selected().length === 1);

S.resetSettings('audio');

// The tri-state, which is the control most likely to be got wrong: "Default"
// has to be a real, reachable value and not just the absence of one.
pause.showPauseMenu();
document.querySelector('.sv-pm-tab[data-tab="video"]').click();
check('clicking a tab switches it', document.querySelector('.sv-pm-tab.sv-pm-on').dataset.tab === 'video');
const filterBtn = document.querySelectorAll('#svPauseBody .sv-pm-choice')[0];
check('the filter starts on Default and says what that resolves to',
  filterBtn.textContent === `Default (${CONFIG.post.preset})`, filterBtn.textContent);
filterBtn.click();
check('clicking it pins an explicit preset', S.settings.video.filter === 'off');
const cycles = S.FILTER_OPTIONS.length + 1;
for (let i = 0; i < cycles - 1; i++) filterBtn.click();
check('cycling all the way round returns to Default', S.settings.video.filter === null,
  String(S.settings.video.filter));
S.resetSettings('video');

// Rebinding, and the thing it must not do.
pause.showPauseMenu();
document.querySelector('.sv-pm-tab[data-tab="controls"]').click();
const keyBtn = document.querySelector('.sv-pm-key[data-action="up"]');
check('the binding button shows the current key', keyBtn.textContent === 'W');
keyBtn.click();
check('clicking it asks for a key', keyBtn.textContent === 'Press a key');

// This is the load-bearing one. The captured key must reach the binding and
// NOT the game — press 'd', which is bound to "swim right".
inputMod.clearPendingInput();
menuKey('d');
check('the pressed key is bound', S.settings.controls.keys.up === 'd');
check('the prompt closes', keyBtn.textContent === 'D');
inputMod.updateInput(fakeCamera, { x: 0, y: 0 });
check('the key being bound never reached the game',
  inputMod.input.move.x === 0 && inputMod.input.move.y === 0,
  `move was ${inputMod.input.move.x},${inputMod.input.move.y} — the capture listener let it through`);
check('the action it collided with was swapped, not orphaned',
  S.actionForKey('w') === 'right', `w -> ${S.actionForKey('w')}`);

keyBtn.click();
menuKey('Escape');
check('Escape cancels the prompt without binding', keyBtn.textContent === 'D'
  && S.settings.controls.keys.up === 'd');
keyBtn.click();
menuKey('Tab');
check('a reserved key leaves the prompt open rather than binding it',
  keyBtn.textContent === 'Press a key' && S.settings.controls.keys.up === 'd');
menuKey('Escape');

// Defaults is per-tab, so it must not take the other two with it.
S.setSetting('audio.music', 0.25);
document.querySelector('.sv-pm-tab[data-tab="controls"]').click();
[...document.querySelectorAll('#svPauseFoot .sv-btn')].find((b) => b.textContent === 'Defaults').click();
check('Defaults restores this tab', S.settings.controls.keys.up === 'w');
check('...and leaves the other tabs alone', S.settings.audio.music === 0.25,
  'a single button that wiped all three would be the one misclick in here that costs real work');
S.resetSettings();

section('Resume and restart');
pause.showPauseMenu();
[...document.querySelectorAll('#svPauseFoot .sv-btn')].find((b) => b.textContent === 'Resume').click();
check('Resume calls back exactly once', resumed === 1, String(resumed));
pause.hidePauseMenu();
check('hiding clears the open flag', pause.isPauseOpen() === false);
check('...and hides the element', hidden());

pause.showPauseMenu();
[...document.querySelectorAll('#svPauseFoot .sv-btn')].find((b) => b.textContent === 'Restart run').click();
check('Restart calls back exactly once', restarted === 1, String(restarted));
pause.hidePauseMenu();

// A closed menu must be inert: its window listener is registered for the life
// of the page, and arrow keys have to go back to steering the seal.
S.resetSettings();
const beforeClosed = S.settings.audio.master;
menuKey('ArrowLeft');
check('a closed menu ignores navigation keys', S.settings.audio.master === beforeClosed);
// ...and that same ArrowLeft DID reach the game, because a closed menu must
// not be swallowing keys. Released here so it doesn't steer into the next
// check — an unreleased key is exactly the latch clearPendingInput exists for.
check('...and it reached the game instead', readMove().x === -1, String(readMove().x));
press('arrowleft', false);
press('arrowup');
check('...and the arrows steer again', readMove().y === 1);
press('arrowup', false);

// The way OUT, from the row most likely to break it. main.js guards its pause
// key with isTextEntry rather than isTypingTarget precisely because the cursor
// focuses this menu's sliders — and a range input is a "typing target" by the
// broader test, which would have made Escape dead on every volume row. That is
// a paused game the player cannot leave, so it is checked here at the level
// both guards actually agree on: what the focused element is.
section('Escape stays live on every kind of row');
const { isTextEntry, isTypingTarget } = await import('../path/src/ui/typing.js');
pause.showPauseMenu();
// The menu remembers its tab across opens, and the section above left it on
// Controls — whose first rows are buttons. Sliders are what this is about.
document.querySelector('.sv-pm-tab[data-tab="audio"]').click();
menuKey('ArrowDown'); // off the tab strip, onto the first slider
const onSlider = document.activeElement;
check('the cursor really does focus the slider', onSlider?.type === 'range', String(onSlider?.tagName));
check('the broad test would have blocked Escape here', isTypingTarget(onSlider) === true);
check('the narrow one does not', isTextEntry(onSlider) === false);
check('a real text field is still protected', isTextEntry(
  Object.assign(document.createElement('input'), { type: 'text' })) === true);
check('...including the types nobody remembers to list', isTextEntry(
  Object.assign(document.createElement('input'), { type: 'search' })) === true);
check('and a bare input with no type at all', isTextEntry(document.createElement('input')) === true);
pause.hidePauseMenu();

// Reopening after a close must not leave a stale cursor or a stale prompt.
pause.showPauseMenu();
check('reopening lands on the tab strip again',
  selected().length === 1 && selected()[0].id === 'svPauseTabs');
check('no binding prompt survives a close', !document.querySelector('.sv-pm-listening'));
pause.hidePauseMenu();

// The menu is built from the schema, so a setting added there with no matching
// widget type would render an empty row and be silently unreachable.
section('Every schema entry is reachable');
pause.showPauseMenu();
for (const [name, def] of Object.entries(S.SCHEMA)) {
  document.querySelector(`.sv-pm-tab[data-tab="${name}"]`).click();
  const widgets = document.querySelectorAll('#svPauseBody .sv-pm-range, #svPauseBody .sv-pm-choice, #svPauseBody .sv-pm-key');
  const expected = def.items.reduce(
    (n, item) => n + (item.type === 'keys' ? Object.keys(item.def).length : 1), 0);
  check(`${name}: every item has a control`, widgets.length === expected,
    `${widgets.length} of ${expected}`);
}
pause.hidePauseMenu();

console.warn = realWarn;
console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
