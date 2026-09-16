#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:cover
//
// THE FULL-SCREEN BLACK RECTANGLE, AND THE TWO WAYS IT USED TO STAY UP.
//
// #svTransition is the cover over the gap between one run and the next. It is
// opaque, it is the size of the viewport, and its pointer-events are off — so
// when it fails to come down there is nothing on screen to click and nothing
// behind it to click either. That is not a visual bug. It is the end of the
// session, with the music still going.
//
// It shipped that way, and the route that found it is the newest one:
// `beginRestartTransition` runs its callback SYNCHRONOUSLY when there is
// nothing dilated to come back from, and a Blubberball match ends with a live
// seal. So `versusHooks.onMainMenu` put the hide in the same tick as the show,
// while the fade-in was still two requestAnimationFrames out. The remove ran
// against a class that was not on the element yet; the add landed afterwards;
// the cover went opaque with every route that would have cleared it already
// spent. The score card has the same shape any time the death dive did not run
// — it is not a Blubberball bug, it is a bug in the cover.
//
// So the claims here are ORDERING claims, and the harness has to be able to
// see two frames pass without any of the game running: the rAF shim below is
// a queue this file drains by hand, because a test that used real timers would
// pass or fail on how fast the machine is.
//
// Three sections:
//   1  a hide in the same tick as the show wins — the shipped bug
//   2  the ordinary asynchronous route still fades in and still clears
//   3  the watchdog clears a cover nobody ever hid — the backstop for the
//      routes that are not written yet
//
// NOTE the load order: jsdom FIRST, then the vite loader hooks, then the game
// modules. See the jsdom-harness recipe.
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true,
});
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Image = dom.window.Image;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);

// THE RAF QUEUE. Hand-drained, so "two frames later" is a thing this file
// decides rather than something it waits for. A real timer here would make
// every claim below a race against the machine.
let rafQueue = [];
globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};
dom.window.requestAnimationFrame = globalThis.requestAnimationFrame;
/** Drain exactly one frame's worth of callbacks — ones queued BY them wait. */
function frame() {
  const due = rafQueue;
  rafQueue = [];
  for (const fn of due) fn(Date.now());
}

// THE TIMER QUEUE, for the same reason: the watchdog is six seconds out and
// nothing about this file should take six seconds. setTimeout is recorded with
// its delay so section 3 can fire it on demand.
const timers = [];
const realSetTimeout = dom.window.setTimeout.bind(dom.window);
dom.window.setTimeout = (fn, ms = 0) => {
  timers.push({ fn, ms, id: timers.length + 1, dead: false });
  return timers.length;
};
dom.window.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].dead = true; };
/** Fire every pending timer whose delay is at or under `ms`. */
function advance(ms) {
  for (const t of timers) {
    if (t.dead || t.fired || t.ms > ms) continue;
    t.fired = true;
    t.fn();
  }
}

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
    if (spec === '@rive-app/canvas' || spec === '@rive-app/webgl2') return { url: 'stub:rive', format: 'module', shortCircuit: true };
    if (spec.endsWith('.riv?url')) return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    if (spec.endsWith('.wasm?url')) return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === 'stub:rive') {
      return { format: 'module', shortCircuit: true, source: 'export class Rive { constructor(){} on(){} play(){} cleanup(){} resizeDrawingSurfaceToCanvas(){} } export const EventType = {}; export const Layout = class {}; export const Fit = {}; export const Alignment = {}; export const RuntimeLoader = { setWasmUrl(){} };' };
    }
    if (url === 'stub:rivurl') return { format: 'module', shortCircuit: true, source: 'export default "stub.riv";' };
    return next(url, ctx);
  },
});
await import('./vite-loader.mjs');

const ui = await import('../path/src/ui/ui.js');
const deathDive = await import('../path/src/systems/deathDive.js');

ui.initUI({
  onStart() {}, onRestart() {}, onLevelChoice() {},
  onResume() {}, onPauseRestart() {}, onSplash() {},
});

const cover = () => document.querySelector('#svTransition');
/** What the player sees: opaque means the frame is gone. */
const opaque = () => {
  const c = cover();
  return !!c && !c.classList.contains('sv-hidden') && c.classList.contains('sv-trans-in');
};
const inTree = () => !cover()?.classList.contains('sv-hidden');

check('the cover exists and starts hidden', !!cover() && !inTree());

// ---------------------------------------------------------------------------
section('1  a hide in the same tick as the show — the shipped bug');
// ---------------------------------------------------------------------------
// This is leaveForMenu from the pause menu, verbatim in shape: show, then a
// beginRestartTransition whose callback runs NOW because nothing is dilated,
// then the hide — all before a single frame has gone by.

check('nothing is dilated, so the callback is synchronous', (() => {
  let ran = false;
  const started = deathDive.beginRestartTransition(() => { ran = true; });
  return ran && started === false;
})());

ui.showRestartTransition(0.9);
ui.hideRestartTransition(0.54);
// The two frames the fade-in was waiting on, arriving after the hide.
frame();
frame();
check('the cover is not opaque after the frames land', !opaque(),
  opaque() ? 'the fade-in landed after its own hide — the black screen is back' : 'clear');
advance(700);
check('...and it is out of the tree again', !inTree());

// ---------------------------------------------------------------------------
section('2  the ordinary route still works');
// ---------------------------------------------------------------------------
// The guard must not have cost the feature: a show with no hide racing it
// still has to go opaque, and a hide a beat later still has to clear it.

ui.showRestartTransition(0.9);
check('not opaque in the frame it is shown', !opaque());
frame();
frame();
check('opaque two frames later', opaque());
ui.hideRestartTransition(0.54);
check('the fade-out starts on the hide', !opaque());
advance(700);
check('and it leaves the tree once it is clear', !inTree());

// ---------------------------------------------------------------------------
section('3  the watchdog — a cover nobody hid');
// ---------------------------------------------------------------------------
// The backstop, for the route that is not written yet: whatever put the cover
// up threw, or is waiting on something that never comes. After long enough the
// cover clears itself rather than ending the session.

ui.showRestartTransition(0.9);
frame();
frame();
check('opaque, and nothing is going to hide it', opaque());
advance(5000);
check('still up at five seconds — no premature rescue mid-transition', opaque());
advance(6001);
check('cleared by the watchdog', !opaque() && !inTree());

// And the rescue must not leave the cover poisoned for the next honest run.
ui.showRestartTransition(0.9);
frame();
frame();
check('a show after a rescue still works', opaque());
ui.hideRestartTransition(0.54);
advance(700);
check('and still clears', !inTree());

// ---------------------------------------------------------------------------
section('4  clearRestartTransition is the hammer');
// ---------------------------------------------------------------------------
ui.showRestartTransition(0.9);
frame();
frame();
ui.clearRestartTransition();
check('gone immediately, no fade, no timer', !opaque() && !inTree());
// A fade-in already queued must not come back over the top of the clear.
ui.showRestartTransition(0.9);
ui.clearRestartTransition();
frame();
frame();
check('a queued fade-in cannot undo the clear', !opaque() && !inTree());

// ---------------------------------------------------------------------------
section('5  every show still owes a hide');
// ---------------------------------------------------------------------------
// A source-shape claim rather than a behavioural one, because the failure it
// guards cannot be reached from here: the hide lives inside a callback that
// runs a beat later, and anything that throws between the two takes the screen
// with it. The `finally` is what makes that impossible, and a `finally` is
// exactly the kind of thing a later edit drops without noticing.

const main = await readFile(new URL('../path/src/main.js', import.meta.url), 'utf8');
for (const fn of ['leaveForMenu', 'restartRun']) {
  const at = main.indexOf(`function ${fn}`);
  const body = at < 0 ? '' : main.slice(at, at + 1400);
  check(`${fn} shows the cover`, /showRestartTransition\(/.test(body));
  check(`...and hides it in a finally`, /\}\s*finally\s*\{[^}]*hideRestartTransition\(/.test(body),
    'a throw on the far side must not cost the screen');
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
realSetTimeout(() => process.exit(failures ? 1 : 0), 0);
