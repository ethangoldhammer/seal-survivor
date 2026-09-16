#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:pellet
//
// THE RECEIPT A DEAD BOSS LEAVES — "pebbles up ++" or "lasers up ++" depending
// on the gun the run rolled, pinned to the seal and rippling in and out.
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
// SEVEN THINGS, and six of them fail while looking perfectly alive:
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
//   THE WORDING IS ETHAN'S       Checked as an exact string, in uiText.csv, on
//                                BOTH loadouts. A receipt whose text drifted
//                                would be new copy arriving through a
//                                refactor — and a laser run reading "pebbles"
//                                is the wrong one of two correct lines, which
//                                no gate can see.
//
//   THE PAIR SHARES AN ANCHOR    A boss pays its pellet and its reroll on the
//                                same frame and both are pinned. With no
//                                offset they are written to the same point and
//                                one is drawn over the other: two payouts, one
//                                legible line, and it reads as a rendering
//                                fault rather than as a reward.
//
//   PINNED IS NOT STAPLED        The pin zeroes the velocity, so without
//                                `pinDrift` a receipt rides the seal through
//                                the whole victory lap like part of the HUD.
//                                The drift is an offset off the anchor, not a
//                                velocity — so it still tracks the seal
//                                sideways while it leaves.
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
const { feedback, setToastSink } = await import('../path/src/systems/feedback.js');
const { uiText } = await import('../path/src/uiTextTable.js');
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
// What main.js hands in as `toastLabel`, per loadout. The two ids are the two
// rows; the CHOICE between them is checked against main.js's own source below,
// because this harness has no run to roll a loadout in.
const PEBBLES = uiText('bossPelletPebbles');
const LASERS = uiText('bossPelletLaser');
// Where the seal is, in the shape updateToasts is handed by main.js.
const seal = (x, y) => ({ x, y, left: 0, prompt: 0, promptText: '' });

// ---------------------------------------------------------------------------
section('The event exists, and says what Ethan wrote');
{
  check('there is a feedback entry for the pellet', !!def, EVENT);
  // THE KEY, NOT THE WORDS. `toast` on a def is an upgrade id or, as here, a
  // bare key — no card grants this, so there is nothing in upgrades.csv to read
  // and the line itself comes in as `toastLabel` from the call site.
  check('the def holds a key rather than a line', def.toast === EVENT,
    JSON.stringify(def.toast));
  check('the pebble wording is exact', PEBBLES === 'pebbles up ++', JSON.stringify(PEBBLES));
  check('the laser wording is exact', LASERS === 'lasers up ++', JSON.stringify(LASERS));
  check('...and they are two different lines', PEBBLES !== LASERS);
  // Neither may fall through to uiText's missing-row fallback, which prints the
  // id — a receipt reading "bossPelletLaser" is a deleted row, not a line.
  check('...and neither is the id showing through',
    PEBBLES !== 'bossPelletPebbles' && LASERS !== 'bossPelletLaser');
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
  feedback(EVENT, { x: 0, y: 0, toastLabel: PEBBLES });
  check('one line arrives', lines().length === 1, `${lines().length}`);
  check('it reads the line it was handed', lines()[0].textContent.startsWith(PEBBLES),
    JSON.stringify(lines()[0].textContent));
  // ...AND NOT THE KEY. `toast` on the def is 'bossPellet', which is what the
  // label falls back to when a call site forgets `toastLabel` — the one failure
  // here that ships a working animation with an internal name inside it.
  check('...not the event key', !lines()[0].textContent.includes(EVENT),
    JSON.stringify(lines()[0].textContent));
  check('it is split into per-character spans',
    glyphs().length === [...PEBBLES].length,
    `${glyphs().length} spans for ${[...PEBBLES].length} characters`);
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
  feedback(EVENT, { x: 0, y: 0, toastLabel: PEBBLES });

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
    feedback(EVENT, { x: 0, y: 0, toastLabel: PEBBLES });
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
  feedback(EVENT, { x: 0, y: 0, toastLabel: PEBBLES });
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

  // THE RISE MUST NOT STILL BE INTEGRATING. `rise` and `gravity` are a velocity
  // and an acceleration, and a pinned line that kept them would climb away from
  // the seal on its own momentum and never come back — the pin failing slowly
  // rather than visibly. What moves it instead is `pinDrift`, which is an
  // OFFSET off the anchor: predictable to the pixel, and still tracking.
  const topBefore = Number.parseFloat(node.style.top);
  const ageBefore = 0.15; // three 0.05s frames, above
  for (let i = 0; i < 12; i++) ui.updateToasts(0.05, camera, seal(0, 0));
  const topAfter = Number.parseFloat(node.style.top);
  const climbed = topBefore - topAfter;
  const wanted = M.pinDrift * (0.6);
  // `lift` is the only OTHER thing allowed to move it, and only during the
  // departure — so it is the whole of the tolerance here.
  check('a pinned line leaves the seal at the drift rate, and only that',
    Math.abs(climbed - wanted) <= Math.abs(M.out.lift) + 1,
    `climbed ${climbed.toFixed(1)}px in 0.6s, wanted ${wanted.toFixed(1)}px`);
  void ageBefore;
  check('...which is an actual departure, not a tremor', climbed > 8,
    `${climbed.toFixed(1)}px`);
}

// ---------------------------------------------------------------------------
section('...and it drifts without ever letting go of the seal');
{
  // THE TWO HALVES OF `pinDrift` ARE SEPARABLE, and this is the one that a
  // velocity would fail: a line carried by momentum keeps its accumulated
  // climb wherever the seal goes, while an offset off the anchor is re-derived
  // every frame — so the same age over a moved seal is the same height over
  // THAT seal.
  ui.clearToasts();
  feedback(EVENT, { x: 0, y: 0, toastLabel: PEBBLES });
  const node = lines()[0];
  ui.updateToasts(0.3, camera, seal(0, 0));
  const topAtOrigin = Number.parseFloat(node.style.top);
  // The seal swims up-screen. The line must land the same distance above it.
  ui.updateToasts(0.0001, camera, seal(0, 6));
  const topAtSix = Number.parseFloat(node.style.top);
  const sealMoved = Math.abs(topAtSix - topAtOrigin);
  check('the height over the seal is re-derived, not accumulated', sealMoved > 10,
    `${topAtOrigin.toFixed(1)}px -> ${topAtSix.toFixed(1)}px as the seal rose`);
  ui.updateToasts(0.0001, camera, seal(0, 0));
  check('...and comes straight back with it',
    Math.abs(Number.parseFloat(node.style.top) - topAtOrigin) < 1,
    `${Number.parseFloat(node.style.top).toFixed(1)}px vs ${topAtOrigin.toFixed(1)}px`);
}

// ---------------------------------------------------------------------------
section('The pellet and the reroll do not land on top of each other');
{
  // BOTH FIRE ON THE SAME FRAME OF THE SAME KILL (see the gained branch in
  // main.js) and both are pinned, so the anchor is identical. Without a slot
  // each they are two nodes at one point: the payout still happened, the
  // animation still ran, and the player read one line.
  const reroll = CONFIG.feedback.rerollEarned;
  check('the reroll receipt is pinned too, or there is nothing to collide',
    reroll.toastPin === true);
  check('they ask for different slots',
    (def.toastPinDy ?? 0) !== (reroll.toastPinDy ?? 0),
    `pellet ${def.toastPinDy ?? 0}px, reroll ${reroll.toastPinDy ?? 0}px`);

  ui.clearToasts();
  feedback(EVENT, { x: 0, y: 0, toastLabel: PEBBLES });
  feedback('rerollEarned', { x: 0, y: 0, toastLabel: 'x', toastValue: '+1' });
  ui.updateToasts(0.05, camera, seal(0, 0));
  check('both lines are on the layer', lines().length === 2, `${lines().length}`);
  const tops = lines().map((n) => Number.parseFloat(n.style.top));
  const gap = Math.abs(tops[0] - tops[1]);
  // A LINE IS 13px OF TYPE. Anything under its own height is an overlap rather
  // than a stack, which is the failure this whole slot mechanism exists for.
  check('...and are more than a line apart', gap > 16, `${gap.toFixed(1)}px apart`);
  check('...by exactly the slots they asked for',
    Math.abs(gap - Math.abs((def.toastPinDy ?? 0) - (reroll.toastPinDy ?? 0))) < 0.5,
    `${gap.toFixed(1)}px`);

  // THEY LEAVE TOGETHER. One drift for both, so the gap that makes them
  // readable at birth is the gap they still have on the way out — a per-event
  // drift would let them converge mid-flight and collide halfway through.
  for (let i = 0; i < 10; i++) ui.updateToasts(0.05, camera, seal(0, 0));
  const late = lines().map((n) => Number.parseFloat(n.style.top));
  check('...and hold that gap the whole way out',
    Math.abs(Math.abs(late[0] - late[1]) - gap) < 0.5,
    `${Math.abs(late[0] - late[1]).toFixed(1)}px vs ${gap.toFixed(1)}px`);
  check('...having both actually left', Math.min(...tops) - Math.min(...late) > 8,
    `${Math.min(...tops).toFixed(1)}px -> ${Math.min(...late).toFixed(1)}px`);
}

// ---------------------------------------------------------------------------
section('The words follow the gun the run rolled');
{
  // THE CHOICE IS MAIN.JS'S — it is the only place that knows the loadout, and
  // there is no run here to roll one. So the branch is read off the source, the
  // same way the banner's wave is above. A harness that re-implemented the
  // choice would prove only that this file can write an if.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../path/src/main.js', import.meta.url), 'utf8'));
  const call = /feedback\('bossPellet',[\s\S]{0,400}?\}\);/.exec(src)?.[0] ?? '';
  check('the call site hands in a label at all', /toastLabel:/.test(call));
  check('...chosen on the loadout', /isLaser\(/.test(call), call.slice(0, 0));
  check('...from the laser row on a laser run',
    /isLaser\([\s\S]*?\?\s*uiText\('bossPelletLaser'\)/.test(call));
  check('...and the pebble row otherwise',
    /:\s*uiText\('bossPelletPebbles'\)/.test(call));
  // BOTH IDS AS LITERALS. npm run test:uitext matches them statically and
  // refuses a computed one outright — an id built out of the loadout key would
  // be two rows nothing can prove are ever shown.
  check('...both named as literals, not built from the key',
    !/uiText\(`/.test(call) && !/uiText\([a-z]/.test(call));
}

// ---------------------------------------------------------------------------
section('With no seal to follow, it finishes where it was');
{
  ui.clearToasts();
  feedback(EVENT, { x: 0, y: 0, toastLabel: PEBBLES });
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
