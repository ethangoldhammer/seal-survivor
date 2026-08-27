#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:gravelabel
//
// The caption that names the grave you swim over — ui/graveLabel.js, driven
// through jsdom against a real yard of stones.
//
// THE THREE THINGS THAT GO WRONG HERE all look fine on the happy path:
//
//   THE SWAP        two stones a few units apart, and a seal crossing from one
//                   to the other. Changing the words in place under a moving
//                   caption reads as a glitch; it has to go out and come back.
//                   A test that only walks one grave never sees this.
//   THE STUCK LABEL the subject is a stone, and stones do not get collected or
//                   die — so nothing ever "ends" a grave caption the way a
//                   coach tip ends. If leaving does not take it down, it hangs
//                   over the fight for the rest of the run.
//   THE FALLING ONE a stone still in the air is having this exact text cut
//                   into its face. Captioning it first tells the joke before
//                   the picture, and a label chasing a falling stone down
//                   through the water is its own kind of silly.
//
// NOTE the load order: jsdom FIRST, then the vite loader hooks, then the game
// modules. See the jsdom-harness recipe.
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// `url` set, or localStorage throws on the opaque origin the moment the
// leaderboard module touches it.
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

// Rich enough for the kill-shot composite as well as the reveal masks. The
// capture path is wrapped in a try/catch that reports a lost context as "no
// trophy this run" — so a stub missing one text method does not throw here, it
// silently produces a card with no trophy row, and the pad checks below would
// then pass for the wrong reason.
dom.window.HTMLCanvasElement.prototype.getContext = function getContext() {
  return {
    canvas: this,
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    clearRect() {}, fillRect() {}, strokeRect() {}, drawImage() {}, save() {}, restore() {},
    fillText() {}, measureText: (t) => ({ width: String(t).length * 10 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    // The bubble layer's own calls. Present so the turn runs its real loop
    // here; the drawing is npm run layout's and a browser's to judge.
    setTransform() {}, beginPath() {}, arc() {}, stroke() {}, fill() {},
    set lineWidth(v) { this._lw2 = v; }, get lineWidth() { return this._lw2; },
    set fillStyle(v) { this._f = v; }, get fillStyle() { return this._f; },
    set font(v) { this._font = v; }, get font() { return this._font; },
    set letterSpacing(v) { this._ls = v; }, get letterSpacing() { return this._ls; },
    set textAlign(v) { this._ta = v; }, get textAlign() { return this._ta; },
    set textBaseline(v) { this._tb = v; }, get textBaseline() { return this._tb; },
    set strokeStyle(v) { this._ss = v; }, get strokeStyle() { return this._ss; },
    set lineWidth(v) { this._lw = v; }, get lineWidth() { return this._lw; },
  };
};
dom.window.HTMLCanvasElement.prototype.toBlob = function toBlob(cb) {
  setTimeout(() => cb(new dom.window.Blob(['png'], { type: 'image/png' })), 0);
};
dom.window.URL.createObjectURL = () => 'blob:http://localhost/stub';
dom.window.URL.revokeObjectURL = () => {};
globalThis.URL = dom.window.URL;
dom.window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';

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

// No AudioContext is installed, so playSfx bails before it reaches the graph
// and every menu sound is a no-op. That is the point: this file is about the
// markup, and tools/menu-sound-test.mjs is the one that listens.
globalThis.fetch = async () => ({ ok: false, status: 404 });
const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => warnings.push(a.map(String).join(' '));

const { initFeedback } = await import('../path/src/systems/feedback.js');
initFeedback(null);

const ui = await import('../path/src/ui/ui.js');
const playtest = await import('../path/src/systems/playtest.js');
const shots = await import('../path/src/systems/bossShot.js');
const { menuInput } = await import('../path/src/input.js');
// THE TURN TAKES TIME, and every check about which face is live has to wait for
// it. Polled rather than slept: the rate is a config number and a fixed sleep
// would start failing the day somebody tunes it.
// Nothing on the score card animates on a clock any more — the flip is gone —
// but the screen still does work in promises. A settle is a drain of the
// microtask queue plus a few macrotasks, not a wait on an angle.
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  return true;
};


const THREE = await import('three');
const { CONFIG } = await import('../path/src/config.js');
const { installModel } = await import('../path/src/assets.js');
const { bounds } = await import('../path/src/arena.js');
const gy = await import('../path/src/systems/gravesite.js');
const gl = await import('../path/src/ui/graveLabel.js');

ui.initUI({ onStart() {}, onRestart() {}, onLevelChoice() {}, onNameSubmit() {} });
gl.initGraveLabel(ui.uiRoot());

// An orthographic camera matching the game's: unrotated, so worldToScreen is
// exact and the projection is not what any of this is testing. It FOLLOWS THE
// SEAL, like the real one — parked at y=0 it framed open water while every
// stone sat forty units below, which is a camera no player ever has and the
// state the old clamp was quietly papering over.
const camera = new THREE.OrthographicCamera(-40, 40, 22, -22, 0.1, 1000);
camera.position.set(0, 0, 100);
camera.updateMatrixWorld(true);

for (const key of CONFIG.gravesite.stones) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 0.3), new THREE.MeshBasicMaterial());
  const root = new THREE.Object3D();
  root.add(mesh);
  installModel(key, root);
}

const scene = new THREE.Scene();
const settleYard = () => { for (let i = 0; i < 900; i += 1) gy.updateGravesites(1 / 60); };
/** Where the stones ended up. The bed is wherever bounds put it in this
 *  harness, so nothing here may hardcode a depth — a swim-over is measured
 *  against the yard's own height. */
const bedY = () => (gy.nearestGrave(0, 1e4)?.topY ?? bounds.bottom);
/**
 * Hold the seal at (x, y) for `seconds` and hand back what the label says.
 * `y` defaults to just over the stones, because that is where a seal reading a
 * grave IS — and the camera goes with it, as it does in the game.
 */
const swimTo = (x, seconds = 1, y = bedY() + 1) => {
  camera.position.set(0, y, 100);
  camera.updateMatrixWorld(true);
  for (let i = 0; i < Math.round(seconds * 60); i += 1) {
    gl.updateGraveLabel(1 / 60, { camera, x, y, live: true });
  }
  return gl.graveLabelState();
};

CONFIG.gravesite.max = 6;
CONFIG.gravesite.label.enabled = true;
const R = CONFIG.gravesite.label.radius;

section('a grave you swim over names itself');
{
  gy.clearGraves(); gl.clearGraveLabel();
  gy.markDeathSite(scene, { x: 0, z: -3.2, name: 'FAT TONY', cause: 'a shark' }, () => {});
  settleYard();

  check('nothing to say out at sea', swimTo(R * 6, 1) === null);
  const over = swimTo(0, 1);
  check('the name is up when the seal is over it', over?.name === 'FAT TONY', JSON.stringify(over));
  check('and how they died, in the stone\'s own words',
    over?.cause === `${CONFIG.gravesite.etch.lead} a shark`, over?.cause);
  check('fully faded in', over?.alpha === 1, String(over?.alpha));
  // WHERE IT SITS IS THE STONE'S BUSINESS, not the window's. Measured against
  // the projection of the grave itself rather than against the frame: the
  // caption has to be centred on the stone and above it, and a check that only
  // asked "is it somewhere in the window" passed happily while the label was
  // parked on the bottom edge with its stone off-screen below.
  const node = document.querySelector('.sv-grave');
  const top = Number.parseFloat(node.style.top);
  const left = Number.parseFloat(node.style.left);
  const grave = gy.nearestGrave(0, 1e4);
  const stone = ui.worldToScreen(camera, grave.x, grave.topY, { x: 0, y: 0 });
  check('the caption is centred on the stone', Math.abs(left + node.offsetWidth / 2 - stone.x) < 1,
    `left ${left} vs stone x ${stone.x.toFixed(1)}`);
  check('...and stands above it', top + node.offsetHeight <= stone.y,
    `bottom ${(top + node.offsetHeight).toFixed(1)} vs stone top ${stone.y.toFixed(1)}`);
}

section('and it is pinned to the stone, not to the frame');
{
  // THE BUG: a seal at the surface is forty units over the yard, and the
  // graveyard is nowhere near the frame — but the horizontal test alone said
  // "you are over a grave" and the clamp then drew the caption along the edge
  // of the screen, the only piece of the grave still in shot.
  const c = CONFIG.gravesite.label;
  const high = swimTo(0, 1, bedY() + c.reach + 8);
  check('no caption from the surface', high === null, JSON.stringify(high));
  check('...nor just outside the reach', swimTo(0, 1, bedY() + c.reach + 0.5) === null);
  check('but a swim over still names it', swimTo(0, 1, bedY() + c.reach - 0.5)?.name === 'FAT TONY');

  // And with the stone out of frame, the caption leaves with it rather than
  // sliding to an edge. Driven directly so the camera can be somewhere the
  // seal is not — a level-up card holds the frame still while the seal moves.
  const node = document.querySelector('.sv-grave');
  const before = Number.parseFloat(node.style.top);
  camera.position.set(0, bedY() + 60, 100);
  camera.updateMatrixWorld(true);
  gl.updateGraveLabel(1 / 60, { camera, x: 0, y: bedY() + 1, live: true });
  const after = Number.parseFloat(node.style.top);
  check('a stone that leaves the frame takes its caption with it',
    after > window.innerHeight, `top ${after} in a ${window.innerHeight}px window`);
  check('...it moved with the stone rather than parking on an edge',
    after > before + 100, `${before} -> ${after}`);
}

section('a stone under the bottom edge says nothing');
{
  // THE ONE THAT SHIPPED. The field-of-view setting can frame in past the
  // seabed, and then the yard is below the picture with the seal down there in
  // it: every proximity test passes honestly, the stone's top projects a little
  // way under the frame, and the caption — drawn its own height ABOVE that
  // point — lands back inside the window naming a grave nobody can see.
  //
  // Framed so the top of the head sits JUST under the bottom edge, because that
  // is the only band where this happens. Push the yard further down and the
  // caption goes off the bottom with it, which always looked fine.
  const grave = gy.nearestGrave(0, 1e4);
  const halfH = (camera.top - camera.bottom) / 2;
  gl.clearGraveLabel();
  camera.position.set(0, grave.topY + halfH + 1, 100);
  camera.updateMatrixWorld(true);

  // The trap is only a trap if the caption WOULD have landed on screen — a
  // stone parked so far under the frame that the words go with it proves
  // nothing. Measured before the check, so this cannot quietly stop testing
  // anything the day the gap or the type size moves.
  const node = document.querySelector('.sv-grave');
  const stone = ui.worldToScreen(camera, grave.x, grave.topY, { x: 0, y: 0 });
  const wouldBe = stone.y - CONFIG.gravesite.label.gap - node.offsetHeight;
  check('the setup is the trap: the stone is under the frame',
    stone.y > window.innerHeight, `stone top at ${stone.y.toFixed(0)}px`);
  check('...while its caption would land inside it',
    wouldBe > 0 && wouldBe < window.innerHeight, `caption would sit at ${wouldBe.toFixed(0)}px`);

  // The seal is right there at the grave — alongside the stone, so both the
  // horizontal radius and the vertical reach are satisfied. Nothing about the
  // swim is wrong here; only the camera is.
  for (let i = 0; i < 120; i += 1) {
    gl.updateGraveLabel(1 / 60, { camera, x: grave.x, y: grave.topY - 1, live: true });
  }
  check('no caption for a grave that is out of shot', gl.graveLabelState() === null,
    JSON.stringify(gl.graveLabelState()));

  // And it comes straight back when the frame drops to include the yard —
  // the stone is what was missing, not the seal.
  check('...and it returns when the stone is back in the picture',
    swimTo(grave.x, 1, grave.topY - 1)?.name === 'FAT TONY');
}

section('and lets go when you leave');
{
  const gone = swimTo(R * 6, 2);
  check('swimming away takes it down', gone === null, JSON.stringify(gone));
  // The failure this is really about: the caption has no natural end, so if
  // leaving does not end it, it hangs over the rest of the run.
  const stillGone = swimTo(R * 6, 4);
  check('and it stays down', stillGone === null, JSON.stringify(stillGone));
}

section('crossing from one grave to another');
{
  gy.clearGraves(); gl.clearGraveLabel();
  gy.markDeathSite(scene, { x: -R, z: -3.2, name: 'FIRST SEAL', cause: 'a shark' }, () => {});
  settleYard();
  gy.markDeathSite(scene, { x: R, z: -3.2, name: 'SECOND SEAL', cause: 'a crab' }, () => {});
  settleYard();

  check('the first one is named', swimTo(-R, 1)?.name === 'FIRST SEAL');

  // Straight across, in one step, which is the worst case: the nearest grave
  // changes on a single frame. The words must not change with it.
  const mid = gl.graveLabelState();
  gl.updateGraveLabel(1 / 60, { camera, x: R, y: 0, live: true });
  const justAfter = gl.graveLabelState();
  check('the words do not change under the caption',
    justAfter === null || justAfter.name === mid.name,
    `${mid.name} -> ${justAfter?.name}`);
  check('...they fade out first', justAfter === null || justAfter.alpha < mid.alpha,
    `alpha ${mid.alpha} -> ${justAfter?.alpha}`);

  const arrived = swimTo(R, 2);
  check('and the second one arrives', arrived?.name === 'SECOND SEAL', JSON.stringify(arrived));
  check('with its own cause', arrived?.cause.includes('a crab'), arrived?.cause);
}

section('a stone still in the air says nothing');
{
  gy.clearGraves(); gl.clearGraveLabel();
  gy.markDeathSite(scene, { x: 0, z: -3.2, name: 'MIDAIR', cause: 'drowning' }, () => {});
  // Advanced only a few frames, so it is still falling — the text is being cut
  // into its face at this exact moment.
  for (let i = 0; i < 6; i += 1) gy.updateGravesites(1 / 60);
  check('the yard agrees it has not landed',
    gy.graveList()[0].phase !== 'done', gy.graveList()[0].phase);
  check('and no caption is offered for it', swimTo(0, 1) === null);
  settleYard();
  check('once it lands, it speaks', swimTo(0, 1)?.name === 'MIDAIR');
}

section('the run owns the caption');
{
  const up = gl.graveLabelState();
  check('a caption is up to begin with', up?.name === 'MIDAIR');
  // A menu, a death, the score card. It fades rather than blinking off.
  const paused = swimTo(0, 2);
  const notLive = (() => {
    for (let i = 0; i < 120; i += 1) gl.updateGraveLabel(1 / 60, { camera, x: 0, y: 0, live: false });
    return gl.graveLabelState();
  })();
  check('a frame that is not being played takes it down', notLive === null,
    JSON.stringify(paused && notLive));
  gl.clearGraveLabel();
  check('and clearing leaves nothing', gl.graveLabelState() === null);
}

section('the switch works');
{
  gy.clearGraves(); gl.clearGraveLabel();
  gy.markDeathSite(scene, { x: 0, z: -3.2, name: 'OFF', cause: 'a shark' }, () => {});
  settleYard();
  CONFIG.gravesite.label.enabled = false;
  check('switched off says nothing', swimTo(0, 1) === null);
  CONFIG.gravesite.label.enabled = true;
  check('switched back on says it again', swimTo(0, 1)?.name === 'OFF');
}

gy.clearGraves();
console.warn = realWarn;
console.log(failures ? `\nFAILED — ${failures} check(s)\n` : '\nPASS — all checks\n');
process.exit(failures ? 1 : 0);
