#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:curtain
//
// THE TITLE SCREEN LEAVING, driven through the real ui/ui.js in jsdom.
//
// The splash used to dissolve where it stood, and now it is pulled up off the
// top of the screen (CONFIG.reveals.splash.curtain). Both are the same one-line
// contract with ui/riveSplash.js — it hands its wrapper to `exit` and does not
// remove it until `done` is called — and every way of getting that wrong looks
// identical to a working game right up until it doesn't:
//
//   THE WRAPPER NEVER LEAVES     a curtain that finishes without calling done
//                                leaves a full-screen div over the run. It is
//                                pointer-events:none by then, so the game plays
//                                perfectly underneath a picture of its title.
//   THE WRAPPER LEAVES AT ONCE   count the two animations wrong and `done`
//                                arrives on the first frame, so the card
//                                vanishes and there is no curtain to see.
//   NOTHING MOVES AT ALL         with the curtain off, or under reduced motion,
//                                the old dissolve has to still take it away.
//
// The move itself is a transform on that wrapper, so the numbers are readable
// here: what matters is that it only ever goes UP, that it clears a whole
// screen height, and that the eased middle of it is BEHIND a linear ramp —
// which is what "eases in, then speeds up" means and the one property an
// out-curve picked by accident would invert.
//
// NOTE the load order: jsdom FIRST, then the vite loader hooks, then the game
// modules. See the jsdom-harness recipe and tools/main-menu-test.mjs.
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';

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
// A real frame queue rather than setTimeout(0): the curtain times itself off
// performance.now(), and a queue that drains faster than the clock moves would
// spin thousands of frames through a 0.2s move for no extra coverage.
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

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

// A FRESH ui.js PER CASE. The name screen is asked for once per page load and
// `splashPlayed` in ui.js is the latch that guarantees it — so a second
// showStartMenu in the same module mounts nothing. A cache-busting query
// re-evaluates that one module and leaves its imports (CONFIG, input.js, the
// name tables) shared, which is exactly the split this needs: a new latch, the
// same tuning object the checks below are writing to.
let uiSerial = 0;
const freshUI = () => import(`../path/src/ui/ui.js?case=${++uiSerial}`);

const ui = await freshUI();
const { CONFIG } = await import('../path/src/config.js');
const { ease } = await import('../path/src/ease.js');
const { menuInput } = await import('../path/src/input.js');

const wired = {
  onStart() {}, onRestart() {}, onLevelChoice() {}, onResume() {},
  onPauseRestart() {}, onSplash() {}, onMenu() {},
};

const card = () => document.querySelector('.sv-riv');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How far up the wrapper is, in screen heights. Read off the inline transform
// rather than getComputedStyle: jsdom does not resolve transforms, and the
// string this writes is the one a browser would be reading anyway.
function lifted(el) {
  const m = /translate3d\(0,\s*(-?[\d.]+)%/.exec(el?.style.transform ?? '');
  return m ? -Number(m[1]) / 100 : 0;
}

// A fresh title screen, dismissed the way a pad dismisses one — the one route
// into the exit a harness can drive, since the artboard's own Start button is
// a stub here. See tools/main-menu-test.mjs.
async function showAndDismiss(mod) {
  mod.initUI(wired);
  mod.showStartMenu();
  const wrap = card();
  menuInput.anyPress = true;
  mod.updateMenuNav();
  menuInput.anyPress = false;
  return wrap;
}

// ---------------------------------------------------------------------------
section('The card is pulled up off the screen, and only then removed');
const curtain = CONFIG.reveals.splash.curtain;
curtain.enabled = true;
curtain.seconds = 0.3;
curtain.distance = 1.02;
curtain.ease = 'inCubic';
curtain.dissolve = false;

let wrap = await showAndDismiss(ui);
check('the card was mounted', !!wrap);
check('...and is still on screen the moment the run starts', wrap.isConnected);

const track = [];
for (let i = 0; i < 12; i++) {
  await sleep(25);
  if (!wrap.isConnected) break;
  track.push(lifted(wrap));
}
check('it moved', track.at(-1) > 0, `${track.length} samples, last ${track.at(-1)?.toFixed(3)}`);
check('it only ever went up', track.every((v, i) => i === 0 || v >= track[i - 1]),
  track.map((v) => v.toFixed(2)).join(' '));

await sleep(400);
check('and it is gone once the travel is over', !wrap.isConnected);
check('...having cleared a whole screen height', lifted(wrap) >= 1,
  `${lifted(wrap).toFixed(3)} screens`);

// ---------------------------------------------------------------------------
section('The curve leans in — slow off the top, fastest as the last of it clears');
// The property, not the name: any of the IN family is a legitimate choice here
// and this is what they have in common. An OUT curve is most of the way gone by
// the halfway point, which is the same move played backwards.
const mid = ease(curtain.ease, 0.5);
check('half way through the time, less than half the distance is spent',
  mid < 0.5, `${(mid * 100).toFixed(0)}% at t=0.5`);
check('...and it still lands exactly on the target', Math.abs(ease(curtain.ease, 1) - 1) < 1e-6);

// ---------------------------------------------------------------------------
section('With the curtain off, the card still leaves');
// The regression that would strand a full-screen div over a live run.
curtain.enabled = false;
wrap = await showAndDismiss(await freshUI());
await sleep(1400); // longer than reveals.splash.outTime at any tuned value
check('the wrapper was taken away by the dissolve', !wrap.isConnected);
check('...and nothing moved it', lifted(wrap) === 0, wrap.style.transform || '(none)');

// ---------------------------------------------------------------------------
section('A curtain with nowhere to go is not a curtain');
// distance 0 is a tuner slider at its floor. It must read as "off" rather than
// as a zero-length move that still owns the wrapper.
curtain.enabled = true;
curtain.distance = 0;
wrap = await showAndDismiss(await freshUI());
await sleep(1400);
check('the wrapper still leaves', !wrap.isConnected);

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
