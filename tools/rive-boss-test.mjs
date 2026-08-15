#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:bossbar
//
// The boss health bar's HANDOVER — which of the two bars is on screen, and what
// the Rive one is actually told.
//
// What this does NOT test is what the artboard draws. That was established by
// driving the real runtime in a browser (the probe under scratchpad/rivetest):
// `numBossHealth` fills the bar, `numHealthBarSize` is its length as a percent
// of artboard width, `strBossName` is the label. Nothing here can re-check
// that, and pretending otherwise with a stub would be worse than not trying.
//
// What IS here is everything between systems/boss.js and those three
// properties, and every failure in it is silent:
//
//   BOTH BARS AT ONCE       the div bar is hidden by a class the Rive path
//                           never touches, so a missed hide leaves two health
//                           bars stacked on the same fight.
//   NEITHER BAR             the inverse, and much worse: the Rive bar claims
//                           the frame while not actually drawing, and the boss
//                           fight runs with no bar at all.
//   THE FALLBACK NEVER RUNS a bar that fails to load has to hand back to the
//                           coded one. If that path is broken it is broken
//                           exactly when nobody is watching — offline, on a
//                           bad CDN day, or after a re-export renamed the
//                           artboard.
//   THE WRONG NUMBERS       `frac` is 0..1 and the artboard wants 0..100. A
//                           factor of a hundred here is a bar that is either
//                           always full or never visible.
//   A WRITE PER FRAME       the name crosses into WASM and re-lays out text; it
//                           changes once per boss and must be written that often.
//
// NOTE the load order: jsdom first, then the loader hooks, then the modules.
// See the jsdom-harness recipe.
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
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
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

// ---------------------------------------------------------------------------
// A Rive runtime under our control
// ---------------------------------------------------------------------------
// The real one wants a WASM binary and a GPU and hangs forever in Node without
// them. This stub is deliberately NOT a mock that always says yes: it holds its
// onLoad until the test releases it (so the "still loading" window is a state
// the test can sit in), it can be told to fail, and it records every property
// write so the numbers can be asserted rather than assumed.
const riveLog = {
  built: [],       // constructor options, one per instance
  writes: [],      // every property write, in order
  played: 0,
  paused: 0,
  resized: 0,
};
globalThis.__riveControl = {
  // 'ok' | 'error' | 'no-vm' | 'missing-prop'
  mode: 'ok',
  pending: [],     // one held onLoad per instance built
  release() { const q = this.pending.splice(0); for (const fire of q) fire(); },
};

const { registerHooks } = await import('node:module');
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@rive-app/canvas') return { url: 'stub:rive', format: 'module', shortCircuit: true };
    if (spec.endsWith('.riv?url') || spec.endsWith('.wasm?url')) {
      return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === 'stub:rive') {
      return {
        format: 'module', shortCircuit: true, source: `
const L = globalThis.__riveLog;
const C = globalThis.__riveControl;
function prop(name) {
  let v = 0;
  return { get value() { return v; }, set value(x) { v = x; L.writes.push([name, x]); } };
}
export class Rive {
  constructor(opts) {
    L.built.push(opts);
    this.opts = opts;
    this.stateMachineNames = ['State Machine 1'];
    const vmi = {
      _p: { numBossHealth: prop('numBossHealth'), numHealthBarSize: prop('numHealthBarSize') },
      _s: { strBossName: prop('strBossName') },
      number(n) { return C.mode === 'missing-prop' && n === 'numHealthBarSize' ? null : (this._p[n] ?? null); },
      string(n) { return this._s[n] ?? null; },
    };
    this.viewModelInstance = C.mode === 'no-vm' ? null : vmi;
    // Held, not fired: the caller decides when loading finishes, which is the
    // only way to test what the game draws WHILE it is still loading. A QUEUE
    // rather than one slot — the splash builds an instance too, and a single
    // slot meant whichever was constructed last was the only one that could
    // ever finish loading.
    C.pending.push(() => {
      if (C.mode === 'error') opts.onLoadError?.('stubbed failure');
      else opts.onLoad?.();
    });
  }
  resizeDrawingSurfaceToCanvas() { L.resized++; }
  play() { L.played++; }
  pause() { L.paused++; }
  cleanup() {}
  on() {}
}
export const EventType = {};
export const Layout = class {};
export const Fit = {};
export const Alignment = {};
export const RuntimeLoader = { setWasmUrl(u) { L.wasmUrl = u; } };
`,
      };
    }
    if (url === 'stub:rivurl') return { format: 'module', shortCircuit: true, source: 'export default "stub-asset";' };
    return next(url, ctx);
  },
});
globalThis.__riveLog = riveLog;
await import('./vite-loader.mjs');

const { CONFIG } = await import('../path/src/config.js');
const UI = await import('../path/src/ui/ui.js');
const BAR = await import('../path/src/ui/bossBarRive.js');

const banner = (over = {}) => ({ name: 'Grimtide the Tidebreaker', frac: 1, maxHp: 600, arriving: false, perk: null, ...over });
const divBar = () => document.getElementById('svBossBar');
const rivBar = () => document.querySelector('.sv-bossbar-riv');
const hidden = (e) => !e || e.classList.contains('sv-hidden');
const lastWrite = (name) => [...riveLog.writes].reverse().find((w) => w[0] === name)?.[1];

// ---------------------------------------------------------------------------
section('THE DEFAULT — Rive is the bar, and it is loaded before it is needed');
// ---------------------------------------------------------------------------
check('the shipped config asks for the Rive bar', CONFIG.boss.bar.rive === true);
UI.initUI({ onStart() {}, onRestart() {}, onLevelChoice() {}, onResume() {}, onPauseRestart() {} });

const built = riveLog.built.find((o) => o.artboard === 'Boss Health');
check('a Rive instance is built at init, not at the first boss', !!built);
check('...naming its artboard rather than trusting the file default',
  built?.artboard === 'Boss Health', built?.artboard);
check('...with autoBind on, or every write would be a silent no-op', built?.autoBind === true);
check('...and it does not autoplay into an empty run', built?.autoplay === false);
// THE SPLASH HAS TO NAME ITS ARTBOARD NOW TOO, and it is checked here rather
// than in a test of its own because this is the change that broke it: it never
// passed one, which was safe for exactly as long as the file had a single
// artboard. "The default artboard" is a property of the .riv, so a re-export
// that reordered them would have brought the game up on the boss health bar
// with nothing in the code having changed. Mounted for real — asserting on a
// splash nobody built would pass whatever the answer was.
const { mountRiveSplash } = await import('../path/src/ui/riveSplash.js');
mountRiveSplash({ parent: document.body });
const splash = riveLog.built.find((o) => o.artboard === 'Splash Screen');
check('the splash names its artboard too, now that there are two',
  !!splash, `built: ${riveLog.built.map((o) => o.artboard ?? '(FILE DEFAULT)').join(', ')}`);

// ---------------------------------------------------------------------------
section('WHILE IT IS STILL LOADING — the coded bar carries the run');
// ---------------------------------------------------------------------------
check('the Rive bar does not claim the frame before it has loaded', BAR.bossBarLive() === false);
UI.updateBossBar(banner());
check('...so the coded bar is what is drawn', !hidden(divBar()));
check('...and it drew the real fill', divBar().querySelector('.sv-boss-fill').style.width === '100%');

// ---------------------------------------------------------------------------
section('ONCE IT LOADS — the handover, in both directions');
// ---------------------------------------------------------------------------
globalThis.__riveControl.release();
check('the Rive bar is live once the artboard has loaded', BAR.bossBarLive() === true);
check('...and the artboard is left reading empty, so its first move is to fill',
  lastWrite('numBossHealth') === 0, `${lastWrite('numBossHealth')}`);

// Counted from a baseline rather than from zero: the splash mounted above
// plays its own state machine, and a global tally would be measuring both.
const playedBefore = riveLog.played;
UI.updateBossBar(banner({ frac: 0.5 }));
check('the coded bar is hidden the moment Rive takes over', hidden(divBar()));
check('...and the Rive bar is shown', !hidden(rivBar()));
check('...and it started playing on the way in', riveLog.played === playedBefore + 1,
  `${riveLog.played - playedBefore} play(s)`);

// THE NUMBERS. frac is 0..1 and the artboard wants 0..100.
check('frac is sent as a percent, not a fraction', lastWrite('numBossHealth') === 50,
  `${lastWrite('numBossHealth')}`);
UI.updateBossBar(banner({ frac: 0.25 }));
check('...and it tracks damage', lastWrite('numBossHealth') === 25, `${lastWrite('numBossHealth')}`);
check('the name went across', lastWrite('strBossName') === 'Grimtide the Tidebreaker');

// THE LENGTH. Both bars read one curve — see bossBarSpan — so they can never
// disagree about which boss is the bigger one.
const smallest = CONFIG.boss.bar.sizeMin;
const biggest = CONFIG.boss.bar.sizeMax;
// DRIVEN FROM THE CURVE'S OWN ENDPOINTS, not from hp numbers typed here. This
// block used to say 600 and 99999, which were the ends of the range when boss
// health was in the hundreds; health went up fourfold, both literals landed in
// the bottom of the new range, and the test started asserting that a late boss
// gets a short bar. See BOSS_BAR_HP_RANGE.
const [hpFloor, hpCeil] = UI.BOSS_BAR_HP_RANGE;
const hpMid = Math.round((Math.sqrt(hpFloor) + Math.sqrt(hpCeil)) ** 2 / 4); // halfway ALONG THE CURVE
UI.updateBossBar(banner({ maxHp: hpFloor }));
check('the first boss of a run gets the short bar', lastWrite('numHealthBarSize') === smallest,
  `${lastWrite('numHealthBarSize')} vs ${smallest}`);
UI.updateBossBar(banner({ maxHp: hpCeil * 2 }));
check('...and a late one gets the full width', lastWrite('numHealthBarSize') === biggest,
  `${lastWrite('numHealthBarSize')} vs ${biggest}`);
UI.updateBossBar(banner({ maxHp: hpMid }));
const mid = lastWrite('numHealthBarSize');
check('...with the middle of the range in between', mid > smallest && mid < biggest, `${mid.toFixed(1)}`);
check('...and it really is near the middle, not clinging to an end',
  mid > smallest + (biggest - smallest) * 0.35 && mid < smallest + (biggest - smallest) * 0.65,
  `${((mid - smallest) / (biggest - smallest) * 100).toFixed(0)}% along`);
check('...on the same curve the coded bar uses',
  Math.abs(mid - (smallest + (biggest - smallest) * UI.bossBarSpan(hpMid))) < 1e-9);

// A STRING WRITE PER FRAME is a text re-layout per frame.
const before = riveLog.writes.filter((w) => w[0] === 'strBossName').length;
for (let i = 0; i < 10; i++) UI.updateBossBar(banner({ frac: 0.4 }));
const after = riveLog.writes.filter((w) => w[0] === 'strBossName').length;
check('the name is written once per boss, not once per frame', after === before,
  `${after - before} write(s) over 10 frames`);
UI.updateBossBar(banner({ name: 'Shockinghide the Glizzy Guzzler' }));
check('...but a new boss does write it', lastWrite('strBossName') === 'Shockinghide the Glizzy Guzzler');

// THE ARRIVAL rides the same number: `frac` is the ceremony while the boss
// swims in (see tickArrival), already eased, so the bar fills for free.
UI.updateBossBar(banner({ frac: 0, arriving: true }));
check('an arriving boss starts the bar empty', lastWrite('numBossHealth') === 0);
UI.updateBossBar(banner({ frac: 0.62, arriving: true }));
check('...and the ceremony fills it', lastWrite('numBossHealth') === 62);

// NO BOSS. Both bars must go, and the render loop with them.
const pausedBefore = riveLog.paused;
UI.updateBossBar(null);
check('a dead boss hides the Rive bar', hidden(rivBar()));
check('...and the coded bar stays hidden too', hidden(divBar()));
check('...and the render loop is paused, not left drawing an empty HUD',
  riveLog.paused === pausedBefore + 1, `${riveLog.paused - pausedBefore} pause(s)`);
UI.updateBossBar(null);
check('...and a second null frame does not pause it again', riveLog.paused === pausedBefore + 1);

// ---------------------------------------------------------------------------
section('THE SWITCH — config forces the coded bar');
// ---------------------------------------------------------------------------
CONFIG.boss.bar.rive = false;
check('the Rive bar stands down', BAR.bossBarLive() === false);
UI.updateBossBar(banner({ frac: 0.8 }));
check('...and the coded bar is drawn instead', !hidden(divBar()));
check('...with the right fill', divBar().querySelector('.sv-boss-fill').style.width === '80%');
CONFIG.boss.bar.rive = true;
UI.updateBossBar(null);

// ---------------------------------------------------------------------------
section('THE FALLBACK — every way the artboard can let us down');
// ---------------------------------------------------------------------------
// Each case rebuilds the bar from scratch through the real init, because the
// thing being tested is what happens on a load that goes wrong — not what
// happens to a bar that was already working.
const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => warnings.push(a.map(String).join(' '));

for (const [label, mode] of [
  ['the file never loads (offline, bad CDN, missing asset)', 'error'],
  ['the artboard binds no view model', 'no-vm'],
  ['a re-export renamed one of the properties', 'missing-prop'],
]) {
  BAR.resetBossBarRive();
  warnings.length = 0;
  globalThis.__riveControl.mode = mode;
  BAR.initBossBarRive(document.body);
  globalThis.__riveControl.release();

  check(`${label}: the Rive bar does not claim the frame`, BAR.bossBarLive() === false);
  UI.updateBossBar(banner({ frac: 0.33 }));
  check('  ...the coded bar draws the fight instead', !hidden(divBar()));
  check('  ...with the real fill, not a stale one',
    divBar().querySelector('.sv-boss-fill').style.width === '33%');
  check('  ...its canvas is taken out of the tree rather than left blank on top',
    rivBar() === null);
  check('  ...and it said why, once', warnings.length === 1, warnings[0] ?? 'silent');
  UI.updateBossBar(null);
}
console.warn = realWarn;

// ---------------------------------------------------------------------------
section('THE BAR — a later boss is visibly longer');
// ---------------------------------------------------------------------------
// The bar is sized from the fight's max health so escalation is readable before
// the first hit lands. That mapping has two hand-set endpoints in ui.js and
// they track a number that lives in enemies.csv, which is exactly the pair that
// drifts apart: boss hp was raised fourfold and the endpoints were not, so
// every boss from the first was past the ceiling and every bar drew full width.
// Nothing failed — the bars were just all the same.
//
// So the curve is re-derived here from the SHIPPED CSV plus the difficulty ramp
// the run actually applies, at the minutes a run actually meets bosses.
{
  const E = CONFIG.enemies;
  const R = CONFIG.spawn.ramp;
  const dps = CONFIG.spawn.difficultyPerSecond;
  // The same arithmetic spawnOne does: the linear per-difficulty term, then the
  // global ramp multiplier on top, capped.
  const effectiveHp = (def, minutes) => {
    const d = minutes * 60 * dps;
    return (def.hp + def.hpPerDifficulty * d) * (1 + Math.min(R.hpMax - 1, R.hp * d));
  };
  // Bosses land every five levels; these are the minutes those levels land at
  // in a run that is going well. Approximate on purpose — the check is about
  // the SHAPE of the curve across a run, not about a specific fight.
  const MINUTES = [3, 6, 9, 13, 18];
  const spans = MINUTES.map((m) => UI.bossBarSpan(effectiveHp(E.bossShark, m)));

  console.log(`       ${MINUTES.map((m, i) => `${m}min ${(spans[i] * 100).toFixed(0)}%`).join('  ')}`);

  check('the first boss does not already fill the bar', spans[0] < 0.25,
    `${(spans[0] * 100).toFixed(0)}% at the first fight`);
  check('a deep-run boss does fill it', spans[spans.length - 1] > 0.9,
    `${(spans[spans.length - 1] * 100).toFixed(0)}% at ${MINUTES[MINUTES.length - 1]}min`);
  check('every boss is longer than the one before it',
    spans.every((v, i) => i === 0 || v > spans[i - 1] + 0.04),
    spans.map((v) => `${(v * 100).toFixed(0)}%`).join(' → '));
  // The endpoints are a range, not a pair of numbers that happen to work: a
  // bar clamped at either end for two consecutive fights is the stale-range
  // failure starting, one fight before it is total.
  check('...and none of them is clamped against a neighbour',
    new Set(spans.map((v) => v.toFixed(3))).size === spans.length,
    `${new Set(spans.map((v) => v.toFixed(3))).size} distinct widths over ${spans.length} fights`);
}

// ---------------------------------------------------------------------------
section('THE SHIPPED FILE — what is actually in path/src/ui/seal_survivor.riv');
// ---------------------------------------------------------------------------
// The one thing every check above takes on trust: that the .riv in the repo —
// the copy Vite hashes into the bundle and deploys — still contains the
// artboards and bindings the code asks for. It is a binary this project does
// not author, swapped in by hand from a Rive export (see npm run riv), and a
// rename in the editor breaks it with nothing failing to compile.
//
// A scan for the name strings rather than a parse of the format: Rive stores
// them as plain text in the file, so this catches a rename, a dropped binding
// and an export of the wrong file, and claims nothing about the artwork.
{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const { riveRequirements } = await import('../path/src/ui/riveContract.js');
  // latin1, not utf-8: the file is arbitrary binary around the names, and
  // utf-8 decoding mangles bytes — including, sometimes, ones inside a name.
  const riv = readFileSync(resolve(here, '../path/src/ui/seal_survivor.riv')).toString('latin1');
  const want = riveRequirements(CONFIG.boss.bar.artboard);

  for (const name of want.artboards) {
    check(`the shipped file has the "${name}" artboard`, riv.includes(name));
  }
  for (const name of want.bindings) {
    check(`...and the "${name}" binding`, riv.includes(name));
  }
  // The name the code asks for and the name in the file have to be the SAME
  // string — a config override pointing at an artboard nobody exported is the
  // same failure wearing a different hat.
  check('the artboard config points at one that exists',
    riv.includes(CONFIG.boss.bar.artboard), CONFIG.boss.bar.artboard);
}

// ---------------------------------------------------------------------------
section('THE WASM — off unpkg, into the bundle');
// ---------------------------------------------------------------------------
// The runtime fetches a 2MB binary from a third-party CDN unless it is told
// otherwise, and it is told once, at module load, before any instance exists.
// A boss bar that has to appear five levels into a run cannot be waiting on
// unpkg. The url is stubbed here; what is being checked is that the call
// happened at all.
check('the runtime was pointed at a bundled WASM url', riveLog.wasmUrl === 'stub-asset',
  String(riveLog.wasmUrl));
const { riveWasmUrl } = await import('../path/src/ui/riveRuntime.js');
check('...and it is not unpkg', !String(riveWasmUrl()).includes('unpkg'), riveWasmUrl());

console.log(failures ? `\n${failures} FAILED` : '\nPASS — all checks');
process.exit(failures ? 1 : 0);
