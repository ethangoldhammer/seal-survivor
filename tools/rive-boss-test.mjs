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
  instances: [],   // the stub instances themselves, for driving triggers
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
    if (spec === '@rive-app/canvas' || spec === '@rive-app/webgl2') return { url: 'stub:rive', format: 'module', shortCircuit: true };
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
// A TRIGGER, and the direction that matters is Rive -> game. The real runtime
// dispatches these from inside advance(), after the state machine has run, so
// \`fire()\` here stands in for the artboard's own Start button being pressed —
// which is the only way a run begins now. \`on\`/\`off\` mirror
// ViewModelInstanceValue's, including that off() with no argument clears all.
function trig(name) {
  const cbs = [];
  return {
    on(cb) { cbs.push(cb); },
    off(cb) { const i = cb ? cbs.indexOf(cb) : -1; if (i >= 0) cbs.splice(i, 1); else if (!cb) cbs.length = 0; },
    trigger() { L.writes.push([name, 'fired-by-game']); },
    fire() { for (const cb of [...cbs]) cb(); },
    get listeners() { return cbs.length; },
  };
}
export class Rive {
  constructor(opts) {
    L.built.push(opts);
    // The instance as well as its options: the splash test has to play the
    // ARTBOARD'S part (fire tStart), which needs the view model, not the
    // constructor arguments.
    L.instances.push(this);
    this.opts = opts;
    this.stateMachineNames = ['State Machine 1'];
    const vmi = {
      _p: { numBossHealth: prop('numBossHealth'), numHealthBarSize: prop('numHealthBarSize') },
      _s: { strBossName: prop('strBossName'), strPlayerName: prop('strPlayerName') },
      _t: { tStart: trig('tStart'), tRandomizeName: trig('tRandomizeName') },
      number(n) { return C.mode === 'missing-prop' && n === 'numHealthBarSize' ? null : (this._p[n] ?? null); },
      string(n) { return this._s[n] ?? null; },
      // 'no-trigger' is an export whose Start button was renamed or lost. The
      // splash has to survive it, because a splash that can only be dismissed
      // by a trigger that does not exist is a game nobody can start.
      trigger(n) { return C.mode === 'no-trigger' ? null : (this._t[n] ?? null); },
    };
    this.viewModelInstance = C.mode === 'no-vm' ? null : vmi;
    // Handed to the test so it can play the artboard's part.
    this.__vmi = vmi;
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
const { SPLASH_ARTBOARD } = await import('../path/src/ui/riveContract.js');
const splash = riveLog.built.find((o) => o.artboard === SPLASH_ARTBOARD);
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
section('THE SPLASH — a name goes in, a trigger starts the run');
// ---------------------------------------------------------------------------
// EVERYTHING HERE FAILS SILENTLY IN A BROWSER, which is why it is worth a
// harness. A missing autoBind, a trigger nobody subscribed to, a name written
// to a property that does not exist — none of them throws, none of them logs,
// and all of them look like a splash that simply sits there. The one that
// cannot be caught by looking is the last: the artwork is perfect and the game
// is unstartable.
{
  const { mountRiveSplash } = await import('../path/src/ui/riveSplash.js');
  const NAME = await import('../path/src/systems/playerName.js');
  const SPLASH = (await import('../path/src/ui/riveContract.js')).SPLASH_BINDINGS;

  // Mount one, load it, and hand back the pieces the artboard's side needs.
  //
  // SCOPED TO THE WRAPPER THIS CALL CREATED, and that is not fussiness: the
  // artboard-naming check further up mounted a splash and never dismissed it,
  // so a document-wide `.sv-riv input` finds THAT one and every assertion below
  // silently measures the wrong splash. It read as five unrelated failures.
  const mount = (opts = {}) => {
    const before = riveLog.instances.length;
    const handle = mountRiveSplash({ parent: document.body, ...opts });
    globalThis.__riveControl.release();
    const inst = riveLog.instances[before];
    const wraps = document.body.querySelectorAll('.sv-riv');
    const wrap = wraps[wraps.length - 1];
    return { handle, inst, wrap, vmi: inst?.__vmi, input: wrap?.querySelector('input') };
  };
  const typeInto = (input, text) => {
    input.value = text;
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };

  NAME.clearPlayerName();
  {
    const { handle, inst, vmi, input, wrap } = mount();
    check('the splash binds its view model, or every write is a silent no-op',
      inst?.opts?.autoBind === true, String(inst?.opts?.autoBind));
    check('there is a real input for the player to type into', !!input);
    check('...which takes no pointer events, or Rive never sees its own button',
      input?.style.pointerEvents === 'none', input?.style.pointerEvents);
    check('...and is capped at the length the leaderboard will accept',
      input?.maxLength === NAME.MAX_NAME_LEN, String(input?.maxLength));

    typeInto(input, 'Ethan');
    check('typing reaches the artboard live',
      vmi?._s[SPLASH.name]?.value === 'Ethan', vmi?._s[SPLASH.name]?.value);

    // The sanitiser runs on the way IN, so the artboard shows exactly what will
    // be stored — a player watching a character not appear learns immediately,
    // where one who finds it missing from the board later just sees a bug.
    // Sanitised on the way IN. The claim worth asserting is not which
    // characters go — that is the sanitiser's own test — but that the artboard,
    // the field and what would be stored are all the SAME string, so a player
    // watching a character fail to appear learns it immediately rather than
    // finding their name cut on the board later.
    typeInto(input, 'Zo<b>e</b>');
    check('...sanitised on the way in, so the artboard cannot promise a name the board would cut',
      vmi?._s[SPLASH.name]?.value === input.value && !/[<>]/.test(input.value),
      `artboard "${vmi?._s[SPLASH.name]?.value}" vs field "${input.value}"`);

    // THE RUN BEGINS BECAUSE THE ARTBOARD SAYS SO.
    typeInto(input, 'Ethan');
    check('the splash subscribed to the start trigger',
      vmi?._t?.tStart?.listeners === 1, String(vmi?._t?.tStart?.listeners));
    vmi._t.tStart.fire();
    check('firing it from the artboard ends the splash', handle.isDestroyed);
    check('...and banks the name that was typed', NAME.loadPlayerName() === 'Ethan',
      NAME.loadPlayerName());
    check('...unsubscribing on the way out, so a second fire cannot start twice',
      vmi?._t?.tStart?.listeners === 0, String(vmi?._t?.tStart?.listeners));
    check('...and takes the field off the DOM with it, so no keyboard over the run',
      !wrap.querySelector('input'));
  }

  {
    // THE DICE BUTTON. Same handshake as tStart, pointed the other way round
    // the field: the artboard fires, the game rolls, and the answer comes back
    // through the SAME string property the typing does — so the artboard needs
    // nothing about the vocabulary, and a rolled name is edited, banked and
    // sanitised by exactly the code a typed one is.
    //
    // It lands IN THE FIELD rather than beside it, which is the claim worth
    // asserting: a roll that only reached the artboard would look right and
    // then be thrown away by the next keystroke, and banked as whatever was
    // in the box before.
    NAME.clearPlayerName();
    const { handle, vmi, input } = mount();
    check('the splash subscribed to the randomise trigger',
      vmi?._t?.tRandomizeName?.listeners === 1, String(vmi?._t?.tRandomizeName?.listeners));

    vmi._t.tRandomizeName.fire();
    const rolled = input.value;
    check('firing it puts a name in the field', rolled.length > 0, `"${rolled}"`);
    check('...one the field can actually hold', rolled.length <= NAME.MAX_NAME_LEN,
      `${rolled.length} chars`);
    check('...unchanged by the sanitiser, so it cannot vanish on the next keystroke',
      NAME.sanitizeName(rolled) === rolled, rolled);
    check('...and mirrored to the artboard, like typing',
      vmi?._s[SPLASH.name]?.value === rolled, vmi?._s[SPLASH.name]?.value);

    // PRESSED AGAIN. A button that hands back the name already on screen reads
    // as a button that did nothing, so the roll is told what to avoid.
    let same = 0;
    for (let i = 0; i < 40; i++) {
      const was = input.value;
      vmi._t.tRandomizeName.fire();
      if (input.value === was) same++;
    }
    check('...and pressing it again changes the name', same === 0, `${same}/40 repeats`);

    // NOT BANKED PER PRESS — banked on the way out, like a typed name. Forty
    // rolls are forty writes to localStorage otherwise, for a name the player
    // has not agreed to yet.
    check('rolling does not write to storage on its own', NAME.loadPlayerName() === '',
      NAME.loadPlayerName());
    const last = input.value;
    handle.destroy('test');
    check('...it is banked when the splash goes, like anything else typed',
      NAME.loadPlayerName() === last, `${NAME.loadPlayerName()} vs ${last}`);
    check('...unsubscribing on the way out, so a dead splash cannot be typed into',
      vmi?._t?.tRandomizeName?.listeners === 0, String(vmi?._t?.tRandomizeName?.listeners));
    NAME.clearPlayerName();
  }

  {
    // A RETURNING PLAYER. Both the field and the artboard start from the name
    // already on file — read after load, not at mount, or the state machine's
    // own defaults land on top of it.
    NAME.savePlayerName('Ada');
    const { handle, vmi, input } = mount();
    check('a remembered name pre-fills the field', input?.value === 'Ada', input?.value);
    check('...and is on the artboard before a key is pressed',
      vmi?._s[SPLASH.name]?.value === 'Ada', vmi?._s[SPLASH.name]?.value);
    handle.destroy('test');
    check('backing out without typing does not erase it', NAME.loadPlayerName() === 'Ada',
      NAME.loadPlayerName());
  }

  {
    // THE GESTURE, and why it is separate from the dismiss. `tStart` arrives
    // from inside Rive's advance — a rAF, not a gesture — so an AudioContext
    // built there comes up suspended and the run is silent. The press that
    // pushed Rive's button has to be reported a frame earlier.
    let gestures = 0;
    const { handle, vmi, wrap } = mount({ onGesture: () => gestures++ });
    wrap.dispatchEvent(new dom.window.Event('pointerup', { bubbles: true }));
    check('a press on the splash is reported as a gesture', gestures === 1, String(gestures));
    check('...without ending the splash, which is the artboard\'s call now',
      !handle.isDestroyed);
    vmi._t.tStart.fire();
    check('...and the trigger still ends it', handle.isDestroyed);
  }

  {
    // THE EXPORT THAT LOST ITS TRIGGER. Without the fallback this is a splash
    // with no way past it, on every device, with nothing thrown.
    globalThis.__riveControl.mode = 'no-trigger';
    const warns = [];
    const realWarn = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    const { handle, wrap } = mount();
    console.warn = realWarn;
    check('a file with no start trigger says so', warns.some((w) => w.includes('tStart')),
      warns.join(' | '));
    check('...and is not yet dismissed', !handle.isDestroyed);
    wrap.dispatchEvent(new dom.window.Event('pointerup', { bubbles: true }));
    check('...but any press gets past it, so the game is still playable',
      handle.isDestroyed);
    globalThis.__riveControl.mode = 'ok';
  }
  NAME.clearPlayerName();
}

// ---------------------------------------------------------------------------
section('THE SHIPPED FILE — what is actually in path/src/ui/seal_survivor.riv');
// ---------------------------------------------------------------------------
// The one thing every check above takes on trust: that the .riv in the repo —
// the copy Vite hashes into the bundle and deploys — still contains the
// artboards and bindings the code asks for. It is a binary this project does
// not author — Rive exports straight over it — and a rename in the editor
// breaks it with nothing failing to compile.
//
// THIS IS NOW THE ONLY GUARD. There used to be a sync tool that validated an
// export on its way in from a second copy under ~/Documents; both are gone (a
// one-way sync between two editable copies reverted a finished export once).
// So the check that used to be a courtesy at copy time is the whole of the
// safety net, which is the right place for it anyway: it runs in `npm test`
// and therefore gates a deploy, where a tool nobody remembered to run did not.
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
  for (const name of want.viewModels ?? []) {
    // The only names in the contract that are UNIQUE. `strBossName` is on both
    // view models now, so a scan for it survives the polaroid's copy being
    // renamed — the view model names are what actually fail in that case.
    check(`...and the "${name}" view model`, riv.includes(name));
  }
  for (const name of want.bindings) {
    check(`...and the "${name}" binding`, riv.includes(name));
  }
  // THE PENDING NAMES — written by the game, not yet required of the file.
  // Reported rather than checked, because the code half of a new binding and
  // the export half land in different commits and the code half is the
  // harmless one: an absent property makes vmi.string() return null and the
  // write is skipped. See PENDING_BINDINGS in riveContract.js.
  //
  // The louder line is the one for a name that HAS arrived. A pending list
  // nobody empties is a permanent hole in the check above, so an export that
  // contains the property is reported as work to do here rather than quietly
  // passing.
  for (const name of want.pending ?? []) {
    if (riv.includes(name)) {
      console.log(`  TODO  "${name}" is in the shipped file now — move it out of PENDING_BINDINGS so it is required`);
    } else {
      console.log(`  PEND  "${name}" is written by the game and not yet in the file (harmless; the write is skipped)`);
    }
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
