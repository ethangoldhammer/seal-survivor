#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:chainbanner
//
// THE FOOD CHAIN! BANNER, PINNED — and the strip under it that draws the
// chain's own window running out.
//
// WHAT CHANGED AND WHY IT NEEDS A TEST. The banner used to be an ordinary
// toast: it rose out of the water at the point the mouthful was swallowed and
// aged out after CONFIG.textMotion.chain.life. Two things were wrong with that
// and neither of them looks like a bug from inside the code:
//
//   IT WAS SOMEWHERE ELSE. A link is scored wherever the food was, and the seal
//   is usually travelling — so the one number telling you how deep the chain is
//   appeared in a different place every time, away from the animal.
//
//   IT LEFT FIRST. The banner lives 1.3s and the window is 2.2s
//   (CONFIG.strike.chainWindow), so the last 40% of every chain ran with
//   nothing on screen saying a chain was running — which is exactly the part
//   where you are about to lose it.
//
// So it holds above the seal for as long as the window does, and the strip
// behind the words is that window draining. Everything here is about the
// arithmetic that makes those two sentences true, because the failure modes are
// all quiet: a banner that never leaves, a banner that leaves anyway, a strip
// that freezes part-full on a dead chain, or a blink that stops when the game
// hit-stops.
//
// THE ONE NUMBER IS QUOTED, NOT COPIED. `left` comes from chainWindowLeft() in
// systems/strike.js, which is the same expression the arc outside the boost
// ring draws. The checks below run the REAL strike model to produce it rather
// than handing the UI a made-up fraction, so a change to the window shows up
// here as a changed reading and not as a test that still passes.
//
// Load order is the jsdom recipe: jsdom, then the vite loader, then the game
// modules. Run WITHOUT --import for that reason.
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
globalThis.localStorage = dom.window.localStorage;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true,
});
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Image = dom.window.Image;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// jsdom has no 2D context, and ui.js reaches for one. See the memory note:
// unstubbed this throws from inside three.js with a misleading message.
dom.window.HTMLCanvasElement.prototype.getContext = function getContext() {
  return {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {}, getImageData: (w, h) => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    clearRect() {}, fillRect() {}, drawImage() {}, save() {}, restore() {},
    set fillStyle(v) { this._fill = v; }, get fillStyle() { return this._fill; },
  };
};
dom.window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};

const { registerHooks } = await import('node:module');
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@rive-app/canvas') return { url: 'stub:rive', format: 'module', shortCircuit: true };
    if (spec.endsWith('.riv?url')) return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    if (spec.endsWith('.wasm?url')) return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === 'stub:rive') {
      return { format: 'module', shortCircuit: true, source: 'export class Rive { constructor(){} on(){} play(){} cleanup(){} } export const EventType = {}; export const Layout = class {}; export const Fit = {}; export const Alignment = {}; export const RuntimeLoader = { setWasmUrl(){} };' };
    }
    if (url === 'stub:rivurl') return { format: 'module', shortCircuit: true, source: 'export default "stub.riv";' };
    return next(url, ctx);
  },
});
await import('./vite-loader.mjs');

globalThis.fetch = async () => ({ ok: false, status: 404 });
const warnings = [];
console.warn = (...a) => warnings.push(a.map(String).join(' '));

const { CONFIG } = await import('../path/src/config.js');
const strike = await import('../path/src/systems/strike.js');
const ui = await import('../path/src/ui/ui.js');

ui.initUI({ onStart() {}, onRestart() {}, onLevelChoice() {}, onResume() {}, onPauseRestart() {} });

const THREE = await import('three');
// An orthographic camera at the origin: the whole of what the banner needs from
// the renderer is a projection, and a projection is not a decision. The frame
// is the game's own (arena.viewHeight tall) so the pixel distances below are
// the ones a player would be looking at.
const VIEW = CONFIG.arena?.viewHeight ?? 52;
const camera = new THREE.OrthographicCamera(
  -VIEW * 1.6 / 2, VIEW * 1.6 / 2, VIEW / 2, -VIEW / 2, 0.1, 100,
);
camera.position.set(0, 0, 10);
camera.updateMatrixWorld(true);
camera.updateProjectionMatrix();

const layer = () => document.getElementById('svToastLayer');
const banner = () => layer().querySelector('.sv-chain');
const strip = () => layer().querySelector('.sv-chain-strip');
const fillOf = () => layer().querySelector('.sv-chain-fill');
const leftVar = () => Number(strip()?.style.getPropertyValue('--sv-chain-left'));
const flashVar = () => Number(strip()?.style.getPropertyValue('--sv-chain-flash'));
const topPx = () => Number.parseFloat(banner()?.style.top ?? 'NaN');
const leftPx = () => Number.parseFloat(banner()?.style.left ?? 'NaN');

// The seal, and a pin built the way main.js builds it. `left` is asked of the
// real model rather than invented, which is the whole point — see the header.
const seal = { x: 0, y: 0 };
const pinAt = () => ({ x: seal.x, y: seal.y, left: strike.chainWindowLeft() });

// Open a chain window on the model, without going anywhere near tryStrike's
// timing gate. `chainTimer` IS the window (see the note on it in strike.js), so
// setting it is setting the thing every reader reads.
function openWindow(frac = 1) {
  strike.resetStrike();
  strike.strikeState.chainTimer = CONFIG.strike.chainWindow * frac;
}
const stepWindow = (dt) => {
  strike.strikeState.chainTimer = Math.max(0, strike.strikeState.chainTimer - dt);
};

// One frame: the model's clock, then the layer's. Same order as main.js.
function frame(dt) {
  stepWindow(dt);
  ui.updateToasts(dt, camera, pinAt());
}

// ---------------------------------------------------------------------------
section('It hangs above the seal, not where the food was');
{
  ui.clearToasts();
  openWindow();
  seal.x = 0; seal.y = 0;
  ui.spawnChainToast(2);
  ui.updateToasts(1 / 60, camera, pinAt());
  check('a link puts one banner up', !!banner(), `${layer().querySelectorAll('.sv-chain').length} banner(s)`);

  const atOrigin = { x: leftPx(), y: topPx() };

  // THE REAL TEST OF A PIN: move the animal and the banner follows, on the same
  // frame, with no new link scored. A banner placed once at spawn would sit
  // exactly where it was left.
  seal.x = 12;
  seal.y = -6;
  ui.updateToasts(1 / 60, camera, pinAt());
  const moved = { x: leftPx(), y: topPx() };
  check('moving the seal moves the banner with it',
    Math.abs(moved.x - atOrigin.x) > 40 && Math.abs(moved.y - atOrigin.y) > 20,
    `(${atOrigin.x.toFixed(0)},${atOrigin.y.toFixed(0)}) -> (${moved.x.toFixed(0)},${moved.y.toFixed(0)})`);

  // ...and it is genuinely ABOVE. Projected, the seal's own y and the banner's
  // top, on one frame, with the sign of the screen axis taken from the
  // projection itself rather than assumed.
  const v = new THREE.Vector3(seal.x, seal.y, 0).project(camera);
  const sealTop = (-v.y * 0.5 + 0.5) * (globalThis.window.innerHeight || 768);
  check('...and it stays above the animal',
    topPx() < sealTop, `banner ${topPx().toFixed(0)}px vs seal ${sealTop.toFixed(0)}px`);

  seal.x = 0; seal.y = 0;
}

// ---------------------------------------------------------------------------
section('It holds for as long as the chain does');
{
  ui.clearToasts();
  openWindow();
  ui.spawnChainToast(3);

  const life = CONFIG.textMotion.chain.life;
  const window0 = CONFIG.strike.chainWindow;
  check('the window really does outlast the banner’s own life',
    window0 > life, `${window0}s window vs ${life}s life`);

  // Run past the life the banner would have had as a plain toast. It must
  // still be there — this is the check that fails the moment anyone puts the
  // age back on a free-running clock.
  let t = 0;
  while (t < life + 0.2) { frame(1 / 60); t += 1 / 60; }
  check('...and the banner is still up past that life', !!banner(), `${t.toFixed(2)}s in`);
  check('...at full opacity rather than mid-fade',
    Number(banner().style.opacity) > 0.99, `opacity ${banner().style.opacity}`);

  // Now let the window lapse. The banner has to LEAVE — a pin that never
  // released would leave a dead chain announced for the rest of the run.
  while (strike.strikeState.chainTimer > 0) { frame(1 / 60); t += 1 / 60; }
  check('the window has closed', strike.chainWindowLeft() === 0);
  const fading = [];
  for (let i = 0; i < 60 && banner(); i++) { frame(1 / 60); fading.push(Number(banner()?.style.opacity ?? 0)); }
  check('...and the banner goes with it', !banner(), `after ${fading.length} frames`);
  check('...by fading rather than vanishing',
    fading.length > 4 && fading.some((o) => o > 0.05 && o < 0.95),
    `opacity walked ${fading.filter((o) => o < 0.95).length} frames on the way out`);
}

// ---------------------------------------------------------------------------
section('The strip is the window, drawn');
{
  ui.clearToasts();
  openWindow();
  ui.spawnChainToast(4);
  ui.updateToasts(1 / 60, camera, pinAt());

  check('the banner carries a strip', !!strip(), '');
  check('...with a fill inside it', !!fillOf(), '');
  check('...and the words are still the banner’s own text',
    banner().textContent.startsWith('FOOD CHAIN!'), banner().textContent);
  check('...with the link count on it', banner().textContent.includes('×4'), banner().textContent);

  const readings = [];
  for (let i = 0; i < 4; i++) {
    for (let k = 0; k < 15; k++) frame(1 / 60);
    readings.push({ model: strike.chainWindowLeft(), drawn: leftVar() });
  }
  // THE STRIP IS THE MODEL, not a countdown of its own. Two clocks would agree
  // for a while and drift the first time anything paused one of them.
  const agree = readings.every((r) => Math.abs(r.model - r.drawn) < 1e-3);
  check('the strip reads exactly what the model says is left',
    agree, readings.map((r) => `${r.drawn.toFixed(2)}/${r.model.toFixed(2)}`).join('  '));
  check('...and it goes DOWN', readings[0].drawn > readings[3].drawn + 0.2,
    `${readings[0].drawn.toFixed(2)} -> ${readings[3].drawn.toFixed(2)}`);

  // A LINK REFILLS IT. This is what makes the strip worth watching: the whole
  // loop is "keep eating before it runs out", and a bar that only ever went
  // down would be a countdown to a fixed doom rather than a resource.
  const low = leftVar();
  strike.strikeState.chainTimer = CONFIG.strike.chainWindow;
  ui.spawnChainToast(5);
  ui.updateToasts(1 / 60, camera, pinAt());
  check('a fresh link refills the strip', leftVar() > low + 0.3,
    `${low.toFixed(2)} -> ${leftVar().toFixed(2)}`);
  check('...on the same banner, not a second one',
    layer().querySelectorAll('.sv-chain').length === 1, '');
  check('...with the new count on it', banner().textContent.includes('×5'), banner().textContent);
}

// ---------------------------------------------------------------------------
section('It blinks when it is nearly out');
{
  const flashAt = CONFIG.strike.foodChain.strip.flashAt;
  ui.clearToasts();
  openWindow();
  ui.spawnChainToast(6);

  // Well above the threshold: dead steady. A strip that blinked for the whole
  // window would be a warning about nothing.
  let calm = [];
  while (strike.chainWindowLeft() > flashAt + 0.15) {
    frame(1 / 60);
    calm.push(flashVar());
  }
  check('it is steady while there is time left',
    calm.length > 5 && calm.every((v) => v === 0), `${calm.filter((v) => v !== 0).length} lit frames of ${calm.length}`);

  // Under it: it has to actually go on AND off, which a single sample cannot
  // tell from a bar that simply got brighter.
  const lit = [];
  while (strike.chainWindowLeft() > 0.02) {
    frame(1 / 60);
    lit.push(flashVar());
  }
  check('...and blinks once it is nearly out',
    lit.some((v) => v > 0.5), `peak ${Math.max(...lit).toFixed(2)}`);
  check('...blinking rather than simply brightening',
    lit.some((v) => v < 0.05), `${lit.filter((v) => v < 0.05).length} dark frames of ${lit.length}`);

  // How many times it crossed. A blink is EDGES, and counting frames over a
  // threshold cannot tell one long flare from six flashes — the same trap the
  // frozen-timer bug in this codebase was built on.
  let edges = 0;
  for (let i = 1; i < lit.length; i++) if (lit[i - 1] <= 0.5 && lit[i] > 0.5) edges++;
  check('...several times, not once', edges >= 2, `${edges} blinks over ${(lit.length / 60).toFixed(2)}s`);
}

// ---------------------------------------------------------------------------
section('Nothing is left over when it is done');
{
  ui.clearToasts();
  openWindow();
  ui.spawnChainToast(7);
  for (let i = 0; i < 20; i++) frame(1 / 60);
  // Kill the chain outright, the way a lapse does, and keep drawing. The strip
  // must empty rather than freeze part-full: a dead chain still showing time on
  // it is the last thing on screen telling the player a lie.
  strike.strikeState.chainTimer = 0;
  ui.updateToasts(1 / 60, camera, pinAt());
  check('the strip empties when the chain dies', leftVar() === 0, `${leftVar()}`);
  check('...and stops blinking with it', flashVar() === 0, `${flashVar()}`);

  ui.clearToasts();
  check('clearing the layer takes the banner with it', !banner(), '');
  // ...AND THE PIN. A run that ended mid-chain would otherwise hold the first
  // banner of the NEXT run at the dead seal's last anchor until its first
  // update, with a strip reporting time on a chain that ended with the run.
  openWindow();
  ui.spawnChainToast(2);
  ui.updateToasts(1 / 60, camera, null);
  check('...and a frame with nothing to pin to does not hold it',
    Number(banner().style.opacity) > 0, 'the banner still draws, unpinned');
  let n = 0;
  while (banner() && n < 300) { ui.updateToasts(1 / 60, camera, null); n++; }
  check('...it simply ages out like any other popup', !banner(), `${(n / 60).toFixed(2)}s`);
}

// ---------------------------------------------------------------------------
section('The old callers are gone');
{
  // spawnChainToast no longer takes a position. A caller still passing the old
  // four arguments would put the CAMERA in `chain` and print "×[object]".
  check('spawnChainToast takes only the depth', ui.spawnChainToast.length === 1,
    `arity ${ui.spawnChainToast.length}`);
  check('updateToasts takes the camera and the pin', ui.updateToasts.length === 1,
    'dt required, camera and pin optional');
}

console.log(failures ? `\n${failures} FAILED` : '\nPASS — all checks');
process.exit(failures ? 1 : 0);
