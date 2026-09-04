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
    if (spec === '@rive-app/canvas' || spec === '@rive-app/webgl2') return { url: 'stub:rive', format: 'module', shortCircuit: true };
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
const { chainRgb255 } = await import('../path/src/systems/chainColor.js');
const { CALLOUTS, resolveCalloutText } = await import('../path/src/systems/callouts.js');
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
const word = () => layer().querySelector('.sv-chain-word');
const count = () => layer().querySelector('.sv-chain-x');
const nowVar = () => Number(banner()?.style.getPropertyValue('--sv-chain-now'));
const PROMPT = resolveCalloutText(CALLOUTS.get('strikeNow'), 'key', {});
const strip = () => layer().querySelector('.sv-chain-strip');
const fillOf = () => layer().querySelector('.sv-chain-fill');
const leftVar = () => Number(strip()?.style.getPropertyValue('--sv-chain-left'));
const flashVar = () => Number(strip()?.style.getPropertyValue('--sv-chain-flash'));
const topPx = () => Number.parseFloat(banner()?.style.top ?? 'NaN');
const leftPx = () => Number.parseFloat(banner()?.style.left ?? 'NaN');

// The seal, and a pin built the way main.js builds it. `left` is asked of the
// real model rather than invented, which is the whole point — see the header.
const seal = { x: 0, y: 0 };
let prompting = false;
const pinAt = () => ({
  x: seal.x, y: seal.y, left: strike.chainWindowLeft(),
  prompt: prompting, promptText: PROMPT,
});

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

// ...and one frame with the chain window held OPEN.
//
// The prompt checks below hold a wind-up for two seconds to prove the
// announcement does not re-fire, and the chain window is 2.2s — so an ordinary
// frame() would let the chain lapse under them and take the banner with it.
// The first version of those checks did exactly that and failed with "0 spans",
// which reads as the splitter being broken rather than as the harness having
// starved the thing it was testing.
//
// Refreshing the window is not cheating: a link is one mouthful, and a player
// holding a wind-up over a pile of chum is refreshing it for real.
function frameLive(dt) {
  strike.strikeState.chainTimer = CONFIG.strike.chainWindow;
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
section('It is drawn at the size the plate is set to');
{
  // WHY THIS IS A TEST. The banner's size is a transform, not a font size —
  // the Chain banner role owns the type and any saved tuning snapshot owns
  // that, so the box is resized by CONFIG.strike.foodChain.bannerScale on top
  // (see chainBannerScale in ui/ui.js). A transform is easy to write in one of
  // the two places that need it: the other is the clearance above the boost
  // ring, which is measured off offsetHeight and would leave a shrunken banner
  // floating in the gap the old size cleared.
  ui.clearToasts();
  openWindow();
  const was = CONFIG.strike.foodChain.bannerScale;

  CONFIG.strike.foodChain.bannerScale = 1;
  ui.spawnChainToast(2);
  // Past the arrival, so `pose.scale` is at rest and the number read is the
  // plate's own size rather than a frame of the pop.
  for (let i = 0; i < 40; i++) frameLive(1 / 60);
  const full = /scale\(([\d.]+)\)/.exec(banner()?.style.transform ?? '');
  check('at 1 the banner draws at its layout size', full && Math.abs(+full[1] - 1) < 0.02,
    `scale ${full?.[1]}`);
  const fullTop = topPx();

  CONFIG.strike.foodChain.bannerScale = 0.5;
  frameLive(1 / 60);
  const half = /scale\(([\d.]+)\)/.exec(banner()?.style.transform ?? '');
  check('  ...and half the setting is half the box', half && Math.abs(+half[1] - 0.5) < 0.02,
    `scale ${half?.[1]}`);
  // The clearance follows it. jsdom lays nothing out, so offsetHeight is 0 and
  // the two tops are equal — the check is that the size did not move the pin in
  // the WRONG direction, which is what a scale applied to only one of the two
  // readers looks like at any real height.
  check('  ...and the pin is still above the ring, not pushed down by it',
    topPx() <= fullTop + 1, `${topPx().toFixed(0)}px vs ${fullTop.toFixed(0)}px`);

  CONFIG.strike.foodChain.bannerScale = was;
  ui.clearToasts();
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
section('One colour, so it is always legible');
{
  ui.clearToasts();
  openWindow();
  const want = CONFIG.strike.foodChain.color;
  const hex = `#${(want >>> 0 & 0xffffff).toString(16).padStart(6, '0')}`;

  // THE SAME COLOUR AT EVERY DEPTH. The banner used to walk the chain wheel one
  // step per link, which is right for a band on a lit meter and wrong for type
  // over open water — a couple of depths a lap sank into the sea, and which
  // ones depended on the time of day.
  const seen = new Set();
  for (const depth of [1, 3, 6, 9, 14, 27]) {
    ui.spawnChainToast(depth);
    ui.updateToasts(1 / 60, camera, pinAt());
    seen.add(banner().style.color);
  }
  check('every depth wears one colour', seen.size === 1, [...seen].join(' / '));
  // Compared through the DOM rather than as a string: jsdom (and every browser)
  // normalises an inline `color` to rgb(), so `#6dffa8 === "rgb(109, 255, 168)"`
  // is a comparison that can only ever fail. Both sides go through one parser.
  const norm = (v) => { const n = document.createElement('i'); n.style.color = v; return n.style.color; };
  check('...and it is the one CONFIG names', banner().style.color === norm(hex),
    `${banner().style.color} vs ${norm(hex)}`);

  // ...and it is NOT the wheel. Asserted against the wheel's own output rather
  // than against "not blue": chainColor.js still drives the ring's arc and the
  // ring's prompt, and the check that matters is that the banner has left it.
  const wheelDepths = [1, 3, 6, 9, 14, 27].map((d) => {
    const { r, g, b } = chainRgb255(d);
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
  });
  check('...not a step on the chain wheel', !wheelDepths.map(norm).includes(norm(hex)),
    `banner ${hex}, wheel walks ${wheelDepths.slice(0, 3).join(' ')}...`);

  // Depth is still ON the banner. Losing the hue is only acceptable because the
  // exact readout was always the count beside the words.
  check('the depth is still printed', count().textContent === '×27', count().textContent);

  // ...AND THE COLOUR HAS TO BE A LEGIBLE ONE. The whole reason the banner left
  // the wheel was that some of the wheel could not be read over water, so a
  // fixed colour that is itself dark would be the same failure arrived at from
  // the other direction — and it would be one slider away at any time.
  //
  // Relative luminance, the WCAG definition, against the darkest thing the
  // banner is ever drawn over: its own plate (rgba(6,10,16,0.62)) over deep
  // water. 0.35 is a floor rather than a target — it rules out a dark colour
  // without pretending to know what looks good.
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (n) => 0.2126 * lin(((n >> 16) & 255) / 255)
    + 0.7152 * lin(((n >> 8) & 255) / 255)
    + 0.0722 * lin((n & 255) / 255);
  const L = lum(want);
  check('the banner colour is bright enough to be read over water', L > 0.35,
    `relative luminance ${L.toFixed(2)}`);
  // The count is drawn at 0.9 alpha in the same colour, so it inherits this —
  // there is nothing here that could be legible while the number beside it was
  // not.
}

// ---------------------------------------------------------------------------
section('The banner takes the STRIKE NOW! prompt');
{
  ui.clearToasts();
  openWindow();
  prompting = false;
  ui.spawnChainToast(4);
  frame(1 / 60);
  check('it says the chain by default', word().textContent === 'FOOD CHAIN!', word().textContent);
  check('...with the count beside it', count().style.display !== 'none', `display "${count().style.display}"`);
  check('...and reports the ring can keep its own line',
    ui.chainBannerHasPrompt() === false, '');

  // The moment arrives.
  prompting = true;
  frame(1 / 60);
  check('the moment swaps the words in place', word().textContent === PROMPT, word().textContent);
  // THE WORDS ARE callouts.csv's. Nothing in ui.js or config.js types them, so
  // rewording the row rewords the banner — the check that the two surfaces
  // cannot start saying different things.
  check('...and they are the callouts.csv row, not a string in the UI',
    PROMPT === CALLOUTS.get('strikeNow').text, `"${PROMPT}"`);
  check('...the count steps aside', count().style.display === 'none', `display "${count().style.display}"`);
  check('...the plate is marked for the neon edge',
    banner().classList.contains('sv-chain-now'), banner().className);
  check('...and the banner reports it, so the ring stands down',
    ui.chainBannerHasPrompt() === true, '');

  // IT FLASHES, and a blink is EDGES. A single sample cannot tell a flash from
  // a thing that simply got brighter and stayed there. Sampled INSIDE the one
  // shot: the announcement is `prompt.time` long and the banner is back to the
  // food chain after it, so a second of frames would mostly be measuring
  // silence.
  const P = CONFIG.strike.foodChain.prompt;
  const runFrames = Math.round(P.time * 60);
  const lit = [];
  for (let i = 0; i < runFrames - 4; i++) { frameLive(1 / 60); lit.push(nowVar()); }
  let edges = 0;
  for (let i = 1; i < lit.length; i++) if (lit[i - 1] <= 0.5 && lit[i] > 0.5) edges++;
  check('the prompt flashes rather than holding lit',
    edges >= 2 && lit.some((v) => v < 0.05),
    `${edges} flashes and ${lit.filter((v) => v < 0.05).length} dark frames in ${P.time}s`);
  // ...faster than the almost-empty blink, which is the other thing this plate
  // can be doing. Two urgencies on one object have to be tellable apart.
  check('...faster than the window-running-out blink',
    (P.flashHz ?? 0) > (CONFIG.strike.foodChain.strip.flashHz ?? 0),
    `${P.flashHz}Hz vs ${CONFIG.strike.foodChain.strip.flashHz}Hz`);

  // --- IT IS ONE SHOT, AND IT ENDS -----------------------------------------
  //
  // This is the property the whole rework is for. strikeLoaded() stays true for
  // the rest of the hold, so drawn as a STATE the banner sat on the instruction
  // indefinitely and the chain's count and window were off screen for seconds.
  // `prompting` is deliberately left TRUE through all of this.
  for (let i = 0; i < 8; i++) frameLive(1 / 60);
  check('the announcement ends while the moment is still live',
    word().textContent === 'FOOD CHAIN!', word().textContent);
  check('...and the count comes back with it',
    count().style.display !== 'none' && count().textContent === '×4', count().textContent);
  check('...and the neon edge goes out', nowVar() === 0, `${nowVar()}`);
  // ...BUT THE CLAIM IS KEPT. The ring's own line popping up the instant the
  // banner finished would be one sentence said twice in a row by two surfaces.
  // What carries the moment after this is the ring's traveller and its perfect
  // latch, which is the instrument saying it geometrically.
  check('...while the banner still holds the claim, so nothing re-announces it',
    ui.chainBannerHasPrompt() === true, '');

  // AND IT DOES NOT RE-FIRE. The gate is a level; without a latch it would
  // start a fresh sweep the frame the last one ended and loop for as long as
  // the button was down.
  let refired = false;
  for (let i = 0; i < 120; i++) { frameLive(1 / 60); if (word().textContent !== 'FOOD CHAIN!') refired = true; }
  check('...and it does not fire again while the button is held',
    !refired, 'two seconds of a held wind-up');

  // IT RE-ARMS ON THE MOMENT ENDING — the release, or a wind-up thrown away.
  // One sweep per wind-up, not one per second.
  prompting = false;
  frameLive(1 / 60);
  prompting = true;
  frameLive(1 / 60);
  check('the next wind-up gets its own sweep', word().textContent === PROMPT, word().textContent);

  // --- THE SWEEP: NORMAL, WARPED, NORMAL -----------------------------------
  //
  // The brief in one line: it starts on the plain word, one crest crosses it,
  // and it ends on the plain word. A repeating ripple has to be cut off at
  // whatever phase it is at when the prompt ends; a pass that has finished is
  // already back to normal, so the swap back to FOOD CHAIN! is the only thing
  // that moves.
  const chars = () => [...word().querySelectorAll('.sv-chain-ch')];
  const ysNow = () => chars().map((c) => {
    const m = /translateY\((-?[\d.]+)em\)/.exec(c.style.transform);
    return m ? Number(m[1]) : 0;
  });
  const warp = () => ysNow().reduce((a, v) => a + Math.abs(v), 0);
  {
    check('the prompt line is split into glyphs',
      chars().length === Array.from(PROMPT).length, `${chars().length} spans for "${PROMPT}"`);
    // THE STRING SURVIVES THE SPLIT, and the space is the whole reason this is
    // checked: an ordinary space inside an inline-block collapses to nothing, so
    // the words run together and it reads as the splitter having eaten it. The
    // fix is white-space: pre on the glyph, and this is what fails without it.
    check('...and still says exactly what it said',
      chars().map((c) => c.textContent).join('') === PROMPT,
      `"${chars().map((c) => c.textContent).join('')}"`);
    check('...including the space',
      chars().some((c) => c.textContent === ' '),
      `${chars().filter((c) => c.textContent === ' ').length} space span(s)`);

    // THE THREE MOMENTS OF THE SWEEP, sampled across one run. The crest is born
    // clear of the first glyph and dies clear of the last, so the ends are at
    // REST — which is what makes the announcement leave cleanly instead of
    // snapping out of a half-finished warp.
    const shape = [];
    for (let i = 0; i < runFrames; i++) {
      shape.push(warp());
      frameLive(1 / 60);
    }
    const peak = Math.max(...shape);
    check('the sweep starts on the plain word', shape[0] < peak * 0.05,
      `${shape[0].toFixed(4)}em of warp at the first frame, peak ${peak.toFixed(3)}`);
    check('...warps through the middle', peak > 0.05, `${peak.toFixed(3)}em`);
    check('...and ends on the plain word again',
      shape[shape.length - 1] < peak * 0.05,
      `${shape[shape.length - 1].toFixed(4)}em at the last frame`);
    // ONE crest, not several. A repeating ripple would cross the line more than
    // once inside the run; counting the times the total warp rises through half
    // its peak is what tells the two apart, and it is an EDGE count for the
    // same reason the blink checks are.
    let crossings = 0;
    for (let i = 1; i < shape.length; i++) {
      if (shape[i - 1] <= peak * 0.5 && shape[i] > peak * 0.5) crossings++;
    }
    check('...exactly once', crossings === 1, `${crossings} passes through the line`);
  }

  // THE CREST GOES FORWARD, and this is the check that took two attempts — the
  // first one is worth recording because it looked completely sound.
  //
  // It found the highest glyph and asserted the peak index had grown a moment
  // later. That works only while exactly one crest is on the line: with the
  // continuous ripple it replaced there were about one and a half, so the
  // leading one kept walking off the end and "the highest glyph" jumped
  // backward to the trailing one. A correct wave failed it.
  //
  // What is actually true of a forward wave is that a glyph inherits its
  // neighbour's motion a moment later. Both hypotheses are scored against the
  // same pair of samples and the right one has to win — direction-sensitive by
  // construction, and indifferent to how many crests are on screen.
  prompting = false;
  frameLive(1 / 60);
  prompting = true;
  frameLive(1 / 60);
  {
    const w = CONFIG.strike.foodChain.prompt.wave;
    // Into the middle of the sweep, where the crest is actually on the line.
    for (let i = 0; i < Math.round(runFrames * 0.4); i++) frameLive(1 / 60);
    const y0 = ysNow();
    // One glyph of travel. The crest crosses `n - 1 + 2 * crest` glyph-widths
    // over the whole run, so a glyph is that fraction of it.
    const span = chars().length - 1 + 2 * w.crest;
    for (let i = 0, f = Math.max(1, Math.round((P.time / span) * 60)); i < f; i++) frameLive(1 / 60);
    const y1 = ysNow();
    let fwd = 0;
    let back = 0;
    for (let i = 0; i + 1 < y0.length; i++) {
      fwd += Math.abs(y1[i + 1] - y0[i]);   // glyph i+1 inherited glyph i's motion
      back += Math.abs(y1[i] - y0[i + 1]);  // ...or the wave ran the other way
    }
    check('the wave travels toward the END of the line',
      fwd < back * 0.5, `forward error ${fwd.toFixed(3)} vs backward ${back.toFixed(3)}`);
  }

  // A SWEEP THAT STARTED FINISHES, even if the moment ends under it. That is
  // the brief — one CLEAN pass — and a pass cut off at 30% is a line left
  // mid-warp, which is exactly the snap the one shot exists to remove.
  prompting = false;
  frameLive(1 / 60);
  check('letting go does not cut the sweep off mid-warp',
    word().textContent === PROMPT, word().textContent);

  // ...and when it does finish, the spans go with the sentence. Left behind,
  // the wave would go on writing transforms into nodes a later textContent has
  // already destroyed — which throws nothing and simply stops moving.
  for (let i = 0; i < runFrames + 2; i++) frameLive(1 / 60);
  check('...and the split is undone when it does end',
    chars().length === 0 && word().textContent === 'FOOD CHAIN!', word().textContent);
  check('...leaving nothing warped behind it', warp() === 0, `${warp()}em`);
  prompting = true;
  frameLive(1 / 60);
  check('...and it is rebuilt on the next moment', chars().length === Array.from(PROMPT).length, '');

  // A LINK CUTS IT SHORT, and that is the one thing allowed to: the count
  // arriving is the ANSWER to the instruction, and a better thing to be looking
  // at than the line that asked for it.
  // THE FLIP BACK, on the link itself. Not on the next frame: the release that
  // earned the link is over by definition, and a banner that showed the new
  // count one frame after the pop reads as correcting itself.
  strike.strikeState.chainTimer = CONFIG.strike.chainWindow;
  ui.spawnChainToast(5);
  check('a link puts the chain back immediately', word().textContent === 'FOOD CHAIN!', word().textContent);
  check('...with the new count', count().textContent === '×5', count().textContent);
  check('...and the neon edge off', !banner().classList.contains('sv-chain-now'), banner().className);
  prompting = false;
}

// ---------------------------------------------------------------------------
section('The prompt only moves when there is a plate to move it to');
{
  // A WINDOW WITH NO BANNER YET is the case that decides this. A release opens
  // the window before any link is scored, so there is a chain running and
  // nothing announcing it — and that is the moment the prompt matters most.
  // If the banner claimed the line here, nothing at all would say it.
  ui.clearToasts();
  openWindow();
  prompting = true;
  ui.updateToasts(1 / 60, camera, pinAt());
  check('a live window with no banner does not claim the prompt',
    ui.chainBannerHasPrompt() === false, 'the ring keeps its line');

  // ...and no chain at all, obviously.
  strike.resetStrike();
  ui.updateToasts(1 / 60, camera, pinAt());
  check('...nor does no chain at all', ui.chainBannerHasPrompt() === false, '');

  // The banner must not hold a stale prompt across a clear either.
  openWindow();
  ui.spawnChainToast(3);
  ui.updateToasts(1 / 60, camera, pinAt());
  check('a banner does claim it', ui.chainBannerHasPrompt() === true, '');
  ui.clearToasts();
  check('...and lets go of it when the layer is cleared',
    ui.chainBannerHasPrompt() === false, '');
  prompting = false;
}

// ---------------------------------------------------------------------------
section('The neon edge has a colour to be');
{
  ui.clearToasts();
  openWindow();
  ui.spawnChainToast(2);
  const p = CONFIG.strike.foodChain.prompt;
  const triple = `${(p.neon >> 16) & 255},${(p.neon >> 8) & 255},${p.neon & 255}`;
  // Stamped as an R,G,B TRIPLE and not a hex, which is not a detail: the
  // stylesheet drops it inside an rgba() whose alpha is a calc() over
  // --sv-chain-now, and rgba() cannot take a hex.
  check('the prompt colour reaches the plate as an rgb triple',
    banner().style.getPropertyValue('--sv-chain-neon') === triple,
    `"${banner().style.getPropertyValue('--sv-chain-neon')}" vs "${triple}"`);
  check('...and the glow reaches it with a unit on it',
    banner().style.getPropertyValue('--sv-chain-glow') === `${p.glow}px`,
    banner().style.getPropertyValue('--sv-chain-glow'));
  // It is a DIFFERENT colour from the banner's own. The plate is green because
  // green is what this instrument says READY in; the edge is what it says NOW
  // in, and the same hue louder would be the same word twice.
  check('...and it is not the colour the banner already wears',
    p.neon !== CONFIG.strike.foodChain.color,
    `edge #${p.neon.toString(16)} vs banner #${CONFIG.strike.foodChain.color.toString(16)}`);

  // THE WORDS GO HOT ORANGE, on the same channel and out of the same block.
  const hot = `${(p.hot >> 16) & 255},${(p.hot >> 8) & 255},${p.hot & 255}`;
  check('the prompt text colour reaches the plate too',
    banner().style.getPropertyValue('--sv-chain-hot') === hot,
    `"${banner().style.getPropertyValue('--sv-chain-hot')}" vs "${hot}"`);
  // ...and it is ORANGE, asserted as a channel ordering rather than as a hex,
  // so the check survives somebody warming or cooling it and only fails if it
  // stops being orange at all. Red dominant, green in the middle, blue last is
  // the whole definition; equal red and green would be yellow.
  const R = (p.hot >> 16) & 255; const G = (p.hot >> 8) & 255; const B = p.hot & 255;
  check('...and it is an orange', R > G && G > B && R > 200 && G > 60,
    `rgb(${R},${G},${B})`);
  // IT IS NOT THE PLATE'S HUE. The words changing colour is the entire signal
  // that the sentence has changed; a warm green would be the announcement in a
  // slightly different mood.
  const bg = CONFIG.strike.foodChain.color;
  check('...and nothing like the green it interrupts',
    Math.abs(R - ((bg >> 16) & 255)) + Math.abs(G - ((bg >> 8) & 255)) + Math.abs(B - (bg & 255)) > 200,
    `text rgb(${R},${G},${B}) vs plate rgb(${(bg >> 16) & 255},${(bg >> 8) & 255},${bg & 255})`);
  // THE PLATE STAYS GREEN WHILE THE WORDS DO NOT, which only works because the
  // strip is a SIBLING of the word rather than its child — a colour set on the
  // word cannot reach it. Checked on the DOM rather than trusted: moving the
  // strip inside the word would still render, and would silently turn the
  // whole banner orange at every flash.
  check('...and the strip is a sibling of the words, so the plate keeps its own',
    strip().parentElement === banner() && !word().contains(strip()), '');
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
