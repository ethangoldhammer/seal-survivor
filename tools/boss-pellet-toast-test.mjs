#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:pellet
//
// THE RECEIPT A DEAD BOSS LEAVES — "pebbles up ++", pinned to the seal and
// rippling in and out.
//
// The pellet itself is arithmetic and is checked where arithmetic is checked.
// This is about the only place the grant is ever VISIBLE: there is no menu, no
// card and no pickup for it, so if this line does not arrive the payout is a
// gun that is quietly wider and nothing that said why.
//
// Driven end to end on the real modules, the same way tools/proc-toast-test.mjs
// is: the real feedback() reads the real CONFIG.feedback entry, hands the toast
// to the real sink main.js wires, and the real ui.js builds the node.
//
// FIVE THINGS, and four of them fail while looking perfectly alive:
//
//   THE PIN IS NOT THE RISE      A followed line is WRITTEN to the seal's
//                                projected point every frame. Leave the rise
//                                integrating as well and it climbs away from
//                                the animal at 34px a second — the pin failing
//                                slowly rather than visibly, and only on the
//                                frames anybody is looking.
//
//   THE WAVE NEEDS INLINE-BLOCK  A transform does nothing at all on an inline
//                                box. The spans are built, the styles are
//                                written, and the line simply does not move.
//
//   IT MUST BE STILL TO BE READ  The ripple is on the two TRANSITIONS. A wave
//                                that ran through the hold would be a receipt
//                                squirming while it is being read, which is the
//                                one job this line has.
//
//   THE BANNER IS THE OTHER SPLITTER   The chain prompt also comes apart into
//                                glyphs, off its own clock. Waving everything
//                                with `chars` would write over it once a frame
//                                and the prompt would lose its ripple silently.
//
//   THE WORDING IS ETHAN'S       Checked as an exact string. A receipt whose
//                                text drifted would be new copy arriving
//                                through a refactor.
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

// jsdom has no 2D context, and ui.js reaches for one. Unstubbed this throws
// from inside three.js with a misleading message.
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
const { feedback, setToastSink } = await import('../path/src/systems/feedback.js');
const ui = await import('../path/src/ui/ui.js');

ui.initUI({ onStart() {}, onRestart() {}, onLevelChoice() {}, onResume() {}, onPauseRestart() {} });
setToastSink((t) => ui.spawnProcToast(camera, t));

const layer = () => document.getElementById('svToastLayer');
const lines = () => [...layer().querySelectorAll('.sv-proc')];
const glyphs = () => [...layer().querySelectorAll('.sv-proc-ch')];
// The ride each glyph is currently taking, in em, off the transform the wave
// writes. Sign preserved: the crest LIFTS, and screen space points down, so a
// wave that came out positive would be the one sign error this file can make.
const rides = () => glyphs().map((g) => Number(/translateY\(([-\d.]+)em\)/.exec(g.style.transform)?.[1] ?? NaN));
const peak = () => Math.max(...rides().map(Math.abs));

const THREE = await import('three');
const camera = new THREE.OrthographicCamera(-20, 20, 12, -12, 0.1, 100);
camera.position.set(0, 0, 10);
camera.updateMatrixWorld(true);
camera.updateProjectionMatrix();

const EVENT = 'bossPellet';
const def = CONFIG.feedback[EVENT];
const M = CONFIG.textMotion.proc;
// Where the seal is, in the shape updateToasts is handed by main.js.
const seal = (x, y) => ({ x, y, left: 0, prompt: 0, promptText: '' });

// ---------------------------------------------------------------------------
section('The event exists, and says what Ethan wrote');
{
  check('there is a feedback entry for the pellet', !!def, EVENT);
  check('its wording is exact', def.toast === 'pebbles up ++', JSON.stringify(def.toast));
  check('it asks to follow the seal', def.toastPin === true, `toastPin: ${def.toastPin}`);
  check('it asks for the ripple', def.toastWave === true, `toastWave: ${def.toastWave}`);
  // The kill shot owns the camera and the clock for the whole time this is up.
  check('it does not punch the frame the kill shot owns',
    !def.shake && !def.hitstop, `shake ${def.shake}, hitstop ${def.hitstop}`);
  check('the ripple has numbers to run on', !!M.wave && M.wave.crest >= 0.4,
    JSON.stringify(M.wave));
}

// ---------------------------------------------------------------------------
section('It arrives as glyphs, one per character');
{
  ui.clearToasts();
  feedback(EVENT, { x: 0, y: 0 });
  check('one line arrives', lines().length === 1, `${lines().length}`);
  check('it reads what the event says', lines()[0].textContent.startsWith(def.toast),
    JSON.stringify(lines()[0].textContent));
  check('it is split into per-character spans',
    glyphs().length === [...def.toast].length,
    `${glyphs().length} spans for ${[...def.toast].length} characters`);
  // A transform on an inline box does nothing, and says nothing about it.
  const sheet = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n');
  check('...and those spans are inline-block, or the wave is inert',
    /\.sv-proc-ch\s*\{[^}]*inline-block/.test(sheet));
  check('...and hold their spaces, or the words run together',
    /\.sv-proc-ch\s*\{[^}]*white-space:\s*pre/.test(sheet));
}

// ---------------------------------------------------------------------------
section('An ordinary proc is untouched — the control for all of the above');
{
  ui.clearToasts();
  feedback('maneaterProc', { x: 0, y: 0, toastValue: '+2%' });
  check('a receipt that did not ask for it is not split', glyphs().length === 0,
    `${glyphs().length} spans`);
  const plain = CONFIG.feedback.maneaterProc;
  check('...and did not ask to be pinned either', !plain.toastPin);
}

// ---------------------------------------------------------------------------
section('The ripple runs on the two transitions and nowhere else');
{
  ui.clearToasts();
  feedback(EVENT, { x: 0, y: 0 });

  // MID-ARRIVAL. in.time is 0.16s, so half of it is the crest at the middle of
  // the line and every glyph in it off its baseline.
  ui.updateToasts(M.in.time * 0.5, camera, seal(0, 0));
  const arriving = peak();
  check('a glyph is riding the crest as it arrives', arriving > 0.01,
    `peak ${arriving.toFixed(4)}em`);
  check('...and it rides UP, not down', Math.min(...rides()) < 0,
    `lowest ${Math.min(...rides()).toFixed(4)}em`);
  // WHICH END. The arrival sweeps left to right, so at the halfway point the
  // crest is nearer the middle than either end — and the FIRST glyph is
  // already back down while the last has not moved yet.
  const mid = rides();
  check('...and the sweep is under way rather than uniform',
    new Set(mid.map((v) => v.toFixed(3))).size > 2,
    `${new Set(mid.map((v) => v.toFixed(3))).size} distinct offsets`);

  // THE HOLD. Past the arrival, well before the departure opens.
  const holdAt = M.in.time + (M.life - M.in.time - M.out.time) * 0.5;
  ui.updateToasts(holdAt - M.in.time * 0.5, camera, seal(0, 0));
  check('it is perfectly still while it is being read', peak() < 1e-6,
    `peak ${peak()}em at ${holdAt.toFixed(2)}s of ${M.life}s`);

  // THE DEPARTURE, halfway through.
  const outAt = M.life - M.out.time * 0.5;
  ui.updateToasts(outAt - holdAt, camera, seal(0, 0));
  const leaving = peak();
  check('the ripple runs again on the way out', leaving > 0.01,
    `peak ${leaving.toFixed(4)}em`);
}

// ---------------------------------------------------------------------------
section('...and the two sweeps go opposite ways');
{
  // Both sampled at the same fraction into their own window, so the only thing
  // that can differ is direction. A departure that replayed the arrival would
  // put the crest at the same end at the same time.
  const crestEnd = (frac, into) => {
    ui.clearToasts();
    feedback(EVENT, { x: 0, y: 0 });
    ui.updateToasts(into, camera, seal(0, 0));
    const r = rides().map(Math.abs);
    // Which half of the line is carrying the crest.
    const half = Math.floor(r.length / 2);
    const left = r.slice(0, half).reduce((a, b) => a + b, 0);
    const right = r.slice(r.length - half).reduce((a, b) => a + b, 0);
    void frac;
    return left > right ? 'left' : 'right';
  };
  // A QUARTER IN, each window. The arrival's crest is a quarter of the way
  // along from the left; the departure's is a quarter of the way BACK from the
  // right, because it walks the other way.
  const inEnd = crestEnd(0.25, M.in.time * 0.25);
  const outEnd = crestEnd(0.25, M.life - M.out.time * 0.75);
  check('the arrival starts at the left', inEnd === 'left', inEnd);
  check('the departure starts at the right', outEnd === 'right', outEnd);
}

// ---------------------------------------------------------------------------
section('It follows the seal instead of drifting off the spawn point');
{
  ui.clearToasts();
  feedback(EVENT, { x: 0, y: 0 });
  const node = lines()[0];
  const left = () => Number.parseFloat(node.style.left);

  ui.updateToasts(0.05, camera, seal(0, 0));
  const atOrigin = left();
  // The seal swims right. Nothing else changes.
  ui.updateToasts(0.05, camera, seal(8, 0));
  const atEight = left();
  check('the line moves with the seal', Math.abs(atEight - atOrigin) > 10,
    `${atOrigin.toFixed(1)}px -> ${atEight.toFixed(1)}px`);
  // ...and it is TRACKING, not drifting: back to the origin puts it back.
  ui.updateToasts(0.05, camera, seal(0, 0));
  check('...and back again when the seal comes back', Math.abs(left() - atOrigin) < 0.5,
    `${left().toFixed(1)}px vs ${atOrigin.toFixed(1)}px`);

  // THE RISE MUST NOT STILL BE INTEGRATING. Held over the same spot for most of
  // a second, a pinned line that kept its velocity climbs 34px a second away
  // from the seal it is pinned to.
  const topBefore = Number.parseFloat(node.style.top);
  for (let i = 0; i < 12; i++) ui.updateToasts(0.05, camera, seal(0, 0));
  const topAfter = Number.parseFloat(node.style.top);
  // `lift` is the only thing allowed to move it, and only during the departure.
  check('a pinned line holds station over the seal',
    Math.abs(topAfter - topBefore) <= Math.abs(M.out.lift) + 1,
    `${topBefore.toFixed(1)}px -> ${topAfter.toFixed(1)}px over 0.6s`);
}

// ---------------------------------------------------------------------------
section('With no seal to follow, it finishes where it was');
{
  ui.clearToasts();
  feedback(EVENT, { x: 0, y: 0 });
  ui.updateToasts(0.05, camera, seal(4, 0));
  const held = Number.parseFloat(lines()[0].style.left);
  // The run ended — main.js hands null the moment the seal is gone.
  let threw = null;
  try { ui.updateToasts(0.05, camera, null); } catch (e) { threw = e; }
  check('a dead run does not throw', !threw, threw?.message ?? '');
  check('...and does not snap the line to the origin',
    Math.abs(Number.parseFloat(lines()[0].style.left) - held) < 60,
    `${held.toFixed(1)}px -> ${Number.parseFloat(lines()[0].style.left).toFixed(1)}px`);
}

// ---------------------------------------------------------------------------
section('The chain banner still owns its own ripple');
{
  // The banner is the other surface that splits into glyphs, and it is waved
  // from its own block off its own one-shot clock. If updateToasts waved
  // everything with `chars`, the second write would win every frame.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../path/src/ui/ui.js', import.meta.url), 'utf8'));
  check('the popup wave excludes the banner by name',
    /if \(t\.chars && t !== chainToast\)/.test(src));
  check('...and the banner is still waved from its own block',
    /waveWord\(chainToast,/.test(src));
  check('the banner\'s glyphs are a different class from a receipt\'s',
    /'sv-chain-ch'/.test(src) && /'sv-proc-ch'/.test(src));
}

// ---------------------------------------------------------------------------
console.log(warnings.length ? `\n${warnings.length} warning(s) during load` : '');
console.log(failures ? `\nFAIL — ${failures} check(s)` : '\nPASS — all checks');
process.exit(failures ? 1 : 0);
