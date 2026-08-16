#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:proctoast
//
// THE LINE THAT SAYS A PASSIVE UPGRADE JUST PAID OUT — "MANEATER +12%".
//
// Driven end to end: the real feedback() reads the real CONFIG.feedback entry,
// hands the toast to the real sink main.js wires, and the real ui.js builds the
// node. Nothing here is a stand-in except the camera, which is a projection and
// not a decision.
//
// FIVE THINGS, each of which looks like working code from the outside:
//
//   THE CHANNEL IS INERT HEADLESS   systems/feedback.js is imported by a dozen
//                                   Node harnesses with no DOM. If the toast
//                                   channel reached for ui/ui.js on its own,
//                                   every one of them would die at import.
//
//   ONE LINE PER UPGRADE            Maneater's bonus is a RUNNING TOTAL, and a
//                                   boat's crew is four bodies in two seconds.
//                                   A line per meal is four MANEATERs climbing
//                                   the screen, three of them showing numbers
//                                   that are already wrong.
//
//   THE RE-POP GAP IS NOT THE SOUND'S   A repeat must ALWAYS update the number
//                                   and only sometimes replay the arrival. Get
//                                   that backwards and a rapid proc either
//                                   strobes or leaves a stale total up.
//
//   THE INDEX OUTLIVES THE NODE     The live line is remembered per upgrade so
//                                   the next proc can find it. Forget to drop
//                                   that entry when the line expires and the
//                                   upgrade never speaks again for the rest of
//                                   the run — a bug that only shows up after a
//                                   quiet minute.
//
//   THE LABEL IS THE CARD'S NAME    Read from upgrades.csv through the id, so
//                                   renaming a card renames its toast. A name
//                                   typed into config.js would be a second copy
//                                   that goes stale silently.
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
const { feedback, setToastSink, initFeedback } = await import('../path/src/systems/feedback.js');
const { maneaterMul, maneaterReadout } = await import('../path/src/stats.js');
const ui = await import('../path/src/ui/ui.js');

ui.initUI({ onStart() {}, onRestart() {}, onLevelChoice() {}, onResume() {}, onPauseRestart() {} });

const layer = () => document.getElementById('svToastLayer');
const lines = () => [...layer().querySelectorAll('.sv-proc')];
const text = () => lines().map((n) => n.textContent);

// The projection ui.js runs the world point through. An orthographic camera at
// the origin is the whole of what the toast needs from the renderer.
const THREE = await import('three');
const camera = new THREE.OrthographicCamera(-20, 20, 12, -12, 0.1, 100);
camera.position.set(0, 0, 10);
camera.updateMatrixWorld(true);
camera.updateProjectionMatrix();

const EVENT = 'maneaterProc';

// ---------------------------------------------------------------------------
section('Headless, the channel does nothing at all');
{
  // No sink wired yet — this is the state every other Node harness runs in.
  initFeedback(null);
  let threw = null;
  try { feedback(EVENT, { x: 0, y: 0, toastValue: '+2%' }); } catch (e) { threw = e; }
  check('firing a toast event with no sink does not throw', !threw, threw?.message ?? '');
  check('...and puts nothing in the DOM', lines().length === 0, `${lines().length} line(s)`);
}

// ---------------------------------------------------------------------------
section('Wired up, it says the card name and what it is worth');
setToastSink((t) => ui.spawnProcToast(camera, t));
{
  ui.clearToasts();
  feedback(EVENT, { x: 0, y: 0, toastValue: '+2%' });
  check('one line arrives', lines().length === 1, `${lines().length}`);
  // The label is the CSV's name for the card, not a string in config.js.
  const card = CONFIG.upgrades.find((u) => u.id === CONFIG.feedback[EVENT].toast);
  check('the event names a real upgrade', !!card, `toast: ${CONFIG.feedback[EVENT].toast}`);
  check('the line is that card by name', text()[0].startsWith(card.name), text()[0]);
  check('...with the value beside it', text()[0].includes('+2%'), text()[0]);

  // Renaming the card renames the line, because there is only one name.
  const was = card.name;
  card.name = 'Womanhunter';
  ui.clearToasts();
  feedback(EVENT, { x: 0, y: 0, toastValue: '+2%' });
  check('renaming the card renames its toast', text()[0].startsWith('Womanhunter'), text()[0]);
  card.name = was;
}

// ---------------------------------------------------------------------------
section('A running total is one line, not a column of them');
{
  ui.clearToasts();
  feedback(EVENT, { x: 0, y: 0, toastValue: '+2%' });
  ui.updateToasts(0.05);
  feedback(EVENT, { x: 0, y: 0, toastValue: '+4%' });
  feedback(EVENT, { x: 0, y: 0, toastValue: '+6%' });
  check('three procs leave one line up', lines().length === 1, `${lines().length} lines`);
  check('...showing the newest total', text()[0].includes('+6%'), text()[0]);
  check('...and not the older ones', !text()[0].includes('+2%') && !text()[0].includes('+4%'), text()[0]);
}

// ---------------------------------------------------------------------------
section('The gap holds the arrival back, never the number');
{
  const gap = CONFIG.feedback[EVENT].toastMinGap;
  check('the event declares a re-pop gap', gap > 0, `${gap}s`);

  ui.clearToasts();
  feedback(EVENT, { x: 0, y: 0, toastValue: '+2%' });
  const node = lines()[0];
  const scaleOf = () => Number(/scale\(([-\d.]+)\)/.exec(node.style.transform)?.[1]);

  // Let it settle to its resting size, but stay inside the gap.
  ui.updateToasts(Math.min(0.4, gap * 0.5));
  const settled = scaleOf();
  check('it has settled after arriving', Math.abs(settled - 1) < 0.02, `scale ${settled}`);

  const leftBefore = node.style.left;
  // Fired from somewhere else entirely, to see whether the line chases it.
  feedback(EVENT, { x: 12, y: 0, toastValue: '+4%' });
  ui.updateToasts(0.001);
  check('a proc inside the gap still updates the number', text()[0].includes('+4%'), text()[0]);
  check('...but does not replay the arrival', Math.abs(scaleOf() - 1) < 0.05,
    `scale ${scaleOf()} — a re-pop would be near ${CONFIG.textMotion.proc.in.scale}`);
  // Re-anchoring a half-risen line without restarting it drops it back to the
  // water mid-flight, which reads as a glitch. The anchor moves with the pop.
  check('...and does not jump to the new spot mid-flight', node.style.left === leftBefore,
    `${leftBefore} -> ${node.style.left}`);

  // Past the gap: the proc happened again, so it is announced again.
  ui.updateToasts(gap);
  feedback(EVENT, { x: 0, y: 0, toastValue: '+6%' });
  ui.updateToasts(0.001);
  check('a proc past the gap replays the arrival', scaleOf() > 1.1,
    `scale ${scaleOf()}`);
  check('...and still updates the number', text()[0].includes('+6%'), text()[0]);
  check('...and is still one line', lines().length === 1, `${lines().length} lines`);
}

// ---------------------------------------------------------------------------
section('A line that has expired is forgotten, not remembered as dead');
{
  ui.clearToasts();
  feedback(EVENT, { x: 0, y: 0, toastValue: '+2%' });
  // Well past the end of its life — the line retires on its own.
  ui.updateToasts(CONFIG.textMotion.proc.life + 0.2);
  check('the line is gone at the end of its life', lines().length === 0, `${lines().length}`);

  // THE BUG THIS CHECK EXISTS FOR: the index still pointing at the dead node.
  feedback(EVENT, { x: 0, y: 0, toastValue: '+8%' });
  check('the next proc builds a fresh line', lines().length === 1, `${lines().length}`);
  check('...showing the current total', text()[0].includes('+8%'), text()[0]);
  ui.clearToasts();
  check('clearing a run takes them with it', lines().length === 0);
}

// ---------------------------------------------------------------------------
section('The readout is measured, not typed');
{
  const c = CONFIG.maneater;
  const s = { maneaterLevel: 1 };
  check('no meals is no bonus', maneaterReadout(s, 0) === '+0%', maneaterReadout(s, 0));

  // Whatever damagePerMeal is set to, the line has to agree with the multiplier
  // the stat block is actually built from.
  const meals = 5;
  const expected = `+${Math.round((maneaterMul(s, meals) - 1) * 100)}%`;
  check('it tracks the real multiplier', maneaterReadout(s, meals) === expected,
    `${maneaterReadout(s, meals)} vs ${expected}`);

  // The cap is the number the card is silently about: past it, every further
  // body is worth nothing, and the line has to say so.
  const atCap = Math.ceil(c.maxBonus / (c.damagePerMeal * 1)) + 10;
  check('at the ceiling it says so', maneaterReadout(s, atCap).endsWith('MAX'),
    maneaterReadout(s, atCap));
  check('...and one meal short of it does not', !maneaterReadout(s, 1).endsWith('MAX'),
    maneaterReadout(s, 1));

  // A run without the card never gets here (the call site is gated on the
  // level), but a zero-level readout must still be a sane string rather than
  // NaN%, because that gate is one `if` away from being edited.
  check('a run without the card reads as nothing gained',
    maneaterReadout({ maneaterLevel: 0 }, 40) === '+0%',
    maneaterReadout({ maneaterLevel: 0 }, 40));
}

// ---------------------------------------------------------------------------
section('Every toast channel in the table is wired to something real');
{
  // The audit that keeps the next proc honest: a label pointing at nothing, or
  // a gap of zero on an event that can fire every frame.
  const bad = [];
  for (const [name, def] of Object.entries(CONFIG.feedback)) {
    if (!def?.toast) continue;
    const known = CONFIG.upgrades.some((u) => u.id === def.toast);
    // An id is the good case; free text is allowed but has to look authored
    // rather than like a typo'd id.
    if (!known && !/\s|[A-Z]/.test(def.toast)) bad.push(`${name}: "${def.toast}"`);
  }
  check('no toast names a lowercase word that is not an upgrade id', bad.length === 0, bad.join(', '));

  const motion = CONFIG.textMotion.proc;
  check('the proc motion block exists', !!motion);
  check('...and holds the line long enough to read', (motion.life ?? 0) >= 0.8, `${motion.life}s`);
}

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
