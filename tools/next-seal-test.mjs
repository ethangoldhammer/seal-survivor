#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:nextseal
//
// Naming the next seal, on the score card, under permadeath.
//
// THE RULE: a name dies with the seal that wore it and can never be used
// again (systems/nameLedger.js). That makes the row beside "Try again" not an
// offer but an IDENTITY — the name the player arrived with is on a headstone
// by the time this card is up, so there is nothing to keep and no way to
// decline. Try again commits whatever is in the field, touched or not.
//
// THIS FILE ASSERTED THE OPPOSITE AN HOUR AGO, and the reversal is worth
// stating rather than quietly rewriting. Before permadeath the row was a
// suggestion, and committing a field the player never looked at would have
// renamed them on every single death: silent, repeated, and indistinguishable
// from the game losing their name. That reasoning was correct and is now moot —
// the same write is no longer a rename, it is a new seal, because the old one
// is dead. What was the bug is now the requirement.
//
// SO THE FAILURES THIS GUARDS ARE THE MIRROR IMAGES:
//
//   THE UNDEAD SEAL   Try again leaves the player as the seal that just died,
//                     so the next run is played by somebody with a stone in
//                     the graveyard. This is what the OLD rule now causes.
//   THE ROLL THAT     the dice hand back a name already on a stone. The button
//   CANNOT BE TAKEN   looks like it worked and the commit then refuses it.
//   THE DEAD END      a name the game will not accept and a Try again that
//                     will not start — on the one screen whose whole job is
//                     getting the player back into a run.
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
const { cardFlipMoving } = await import('../path/src/ui/cardFlip.js');
const settle = async () => {
  for (let i = 0; i < 600 && cardFlipMoving(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return !cardFlipMoving();
};


const { savePlayerName, loadPlayerName, clearPlayerName } = await import('../path/src/systems/playerName.js');
const { buryName, buryMany, isNameBuried, buriedCount, clearNameLedger } = await import('../path/src/systems/nameLedger.js');

let restarts = 0;
ui.initUI({ onStart() {}, onRestart() { restarts += 1; }, onLevelChoice() {}, onNameSubmit() {} });

const $ = (id) => document.getElementById(id);
const click = (node) => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const warning = () => ($('svNextWarn').classList.contains('sv-hidden') ? '' : $('svNextWarn').textContent);

/**
 * A death, as the game performs one: the seal's name goes into the ledger and
 * then the score card comes up. Both halves matter — a card opened without the
 * burial is rolling against a graveyard that does not yet contain the seal
 * whose card it is.
 */
function die(as) {
  clearPlayerName();
  if (as) savePlayerName(as);
  buryName(as);
  ui.hideAllMenus();
  ui.showGameOver({ score: 1000, kills: 10, level: 3, time: 90 });
  return $('svNextInput');
}

function typeInto(input, text) {
  input.value = text;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

const tryAgain = () => click($('svRestartBtn'));

section('the seal that died does not come back');
{
  clearNameLedger();
  const input = die('FAT TONY');
  check('the field comes up with a name', !!input.value, `"${input.value}"`);
  check('and it is not the seal that just died',
    input.value.toLowerCase() !== 'fat tony', input.value);
  check('nor anything else already buried', !isNameBuried(input.value), input.value);

  tryAgain();
  check('Try again takes it even though nothing was touched',
    loadPlayerName() === input.value, `"${loadPlayerName()}" vs "${input.value}"`);
  check('so the next run is NOT the dead seal',
    loadPlayerName().toLowerCase() !== 'fat tony', loadPlayerName());
}

section('ten deaths, ten seals');
{
  clearNameLedger();
  clearPlayerName();
  const lived = [];
  let name = 'FIRST SEAL';
  for (let i = 0; i < 10; i += 1) {
    die(name);
    tryAgain();
    name = loadPlayerName();
    lived.push(name);
  }
  const unique = new Set(lived.map((n) => n.trim().toLowerCase()));
  check('every run had its own name', unique.size === lived.length,
    `${unique.size} distinct out of ${lived.length}: ${lived.join(', ')}`);
  check('and none of them was reused from the graveyard',
    lived.every((n, i) => !lived.slice(0, i).some((p) => p.toLowerCase() === n.toLowerCase())));
}

section('typing one of your own dead');
{
  clearNameLedger();
  const input = die('FAT TONY');
  typeInto(input, 'FAT TONY');
  check('the field says so while you type', /already buried/i.test(warning()), warning());
  check('...and names the seal', /FAT TONY/i.test(warning()), warning());

  typeInto(input, 'BRINE');
  check('a free name clears the warning', warning() === '', warning());
  tryAgain();
  check('and is taken', loadPlayerName() === 'BRINE', loadPlayerName());
}
{
  // Committed anyway. The warning was up, the player pressed Try again, and the
  // run has to start as SOMEBODY — just never as the dead seal.
  clearNameLedger();
  const input = die('FAT TONY');
  typeInto(input, 'FAT TONY');
  tryAgain();
  check('pressing Try again on a buried name does not resurrect it',
    loadPlayerName().toLowerCase() !== 'fat tony', loadPlayerName());
  check('...it starts the run as somebody free instead',
    !!loadPlayerName() && !isNameBuried(loadPlayerName()), loadPlayerName());
}

section('the ways out are never closed');
{
  clearNameLedger();
  const input = die('FAT TONY');
  typeInto(input, '');
  tryAgain();
  check('a cleared field still names the seal', !!loadPlayerName(), `"${loadPlayerName()}"`);
  check('...with something free', !isNameBuried(loadPlayerName()), loadPlayerName());

  const input2 = die(loadPlayerName());
  click($('svNextRoll'));
  check('Roll never hands back one of the dead', !isNameBuried(input2.value), input2.value);
  check('and clears any warning it was showing', warning() === '', warning());

  const before = restarts;
  tryAgain();
  check('Try again still restarts the run', restarts === before + 1, `${before} -> ${restarts}`);
}

section('a graveyard full of one family');
{
  // The table exhausted. Rather than refuse — which would leave the button dead
  // on the one screen that has to get the player back into a game — the roller
  // starts a lineage. Simulated by burying everything it can build.
  clearNameLedger();
  const { randomPlayerName, sealNameParts } = await import('../path/src/systems/randomName.js');
  const parts = sealNameParts();
  const space = (parts.adjective?.length ?? 0) * (parts.nickname?.length ?? 0)
    + (parts.nickname?.length ?? 0) + (parts.full?.length ?? 0);

  // Collected against an EMPTY ledger and buried in one write. Drawing while
  // burying would be quadratic twice over — a storage re-serialise per name and
  // a membership check that grows with what has already been buried — and the
  // point of this block is the roller's fallback, not how fast a graveyard
  // fills.
  // DRAWN UNTIL IT RUNS DRY, not until a count is reached. adjectives x
  // nicknames is an UPPER BOUND and not the real space — sealNameTable's length
  // rule drops any adjective that will not fit in the field beside the nickname
  // it drew, so a long nickname has fewer partners than a short one. Testing
  // against the product finds 97% and calls it a failure, which is a wrong
  // denominator reported as a bug in the roller.
  const seen = new Set();
  let dry = 0;
  for (let i = 0; i < 400000 && dry < 20000; i += 1) {
    const before = seen.size;
    seen.add(randomPlayerName(''));
    dry = seen.size === before ? dry + 1 : 0;
  }
  check('the harness really did drain the table', dry >= 20000,
    `gave up with ${seen.size} names and only ${dry} dry draws`);
  check('...and what it drained is most of the theoretical space',
    seen.size > space * 0.9 && seen.size <= space,
    `${seen.size} names against an upper bound of ${space}`);
  buryMany([...seen]);
  check('every one of them is buried', buriedCount() === seen.size,
    `${buriedCount()} buried vs ${seen.size} drawn`);

  const next = randomPlayerName('');
  check('it still returns a name', !!next, String(next));
  check('and it is not one of the buried', !isNameBuried(next), next);
  check('the way out is a lineage, not a serial number',
    / (II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|XIII|XIV|XV|XVI|XVII|XVIII|XIX|XX)$/.test(next),
    next);
  check('and it still fits the field', next.length <= 32, `${next.length} chars`);
  clearNameLedger();
}

section('the two name fields stay separate');
{
  clearNameLedger();
  const input = die('FAT TONY');
  const before = $('svNameInput').value;
  check('the leaderboard field holds the seal that played the run',
    before === 'FAT TONY', `"${before}"`);
  click($('svNextRoll'));
  check('rolling the next seal does not touch it',
    $('svNameInput').value === before, `"${before}" -> "${$('svNameInput').value}"`);
  typeInto(input, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
  check('a long next-seal name never stacks the leaderboard row',
    !$('svNameRow').classList.contains('sv-name-stacked'));
}

clearNameLedger();
console.warn = realWarn;
console.log(failures ? `\nFAILED — ${failures} check(s)\n` : '\nPASS — all checks\n');
process.exit(failures ? 1 : 0);
