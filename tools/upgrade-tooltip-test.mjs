#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:tooltip
//
// The auto-generated effect tooltip on the level-up cards, driven through the
// real ui.js under jsdom.
//
// The tooltip exists because `desc` in upgrades.csv is hand-typed English and
// not one of the forty-four rows says {effect} — so the machinery that can
// measure a card by replaying its own apply() described nothing a player ever
// saw, while half the cards say only "All balls, no pit." The tooltip is that
// measurement, generated per card, per stack, with nothing to keep in sync.
//
// Four ways it can break, none of which is visible by looking at one card:
//
//   SAYS IT TWICE   most stat cards already spell the effect out, verbatim.
//                   A tooltip repeating "+25% fire rate" under a card reading
//                   "+25% fire rate" trains the player to stop reading the box
//                   on the cards where it is the only information there is.
//   EMPTY BOX       `overboost` multiplies a stat that sits at 0, so it
//                   measures no change at all. A bordered box with nothing in
//                   it looks like a bug and is one.
//   ORPHANED NODE   the tooltip lives inside #svCards, and showLevelUp clears
//                   that container with innerHTML = ''. Hold the reference
//                   across a re-deal and every tooltip from level 2 onwards is
//                   positioned inside an element no longer in the document.
//   MOUSE ONLY      on a pad the pointer never moves. Bind to pointerenter
//                   alone and a controller run never sees an effect at all.
//
// NOTE the load order: jsdom FIRST, then the vite loader hooks, then the game
// modules. The other way round breaks the CJS chain jsdom loads through and
// fails with an error about an encoding fallback. See the jsdom-harness recipe.
//
// jsdom has no layout engine, so getBoundingClientRect() is all zeroes here.
// This file tests WHICH text appears and WHEN — never where the box lands.
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
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Image = dom.window.Image;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
// Not copying window.performance: jsdom's delegates to the global one and
// swapping it in recurses until the stack blows.

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
const { initFeedback } = await import('../path/src/systems/feedback.js');
const { measure, phraseAll, sentenceCase } = await import('../path/src/upgradeText.js');
const { player } = await import('../path/src/entities/player.js');
const { menuInput } = await import('../path/src/input.js');
initFeedback(null);

const ui = await import('../path/src/ui/ui.js');
const picked = [];
ui.initUI({
  onStart() {}, onRestart() {}, onLevelChoice(c) { picked.push(c.id); }, onNameSubmit() {},
});

const cards = () => document.getElementById('svCards');
const fx = () => cards().querySelector('.sv-card-fx');
const shown = () => {
  const n = fx();
  return n && n.classList.contains('sv-fx-on') ? n.textContent : null;
};
const pointerEnter = (node) => node.dispatchEvent(new dom.window.Event('pointerenter', { bubbles: false }));
const pointerLeave = (node) => node.dispatchEvent(new dom.window.Event('pointerleave', { bubbles: false }));

// Deal a hand of exactly the upgrades named, by narrowing the offer pool. The
// real menu rolls three from forty-four, which cannot be asserted against.
const enabledWas = new Map(CONFIG.upgrades.map((u) => [u.id, u.enabled]));
const choicesWas = CONFIG.upgradeChoices;
function deal(...ids) {
  for (const u of CONFIG.upgrades) u.enabled = ids.includes(u.id);
  CONFIG.upgradeChoices = ids.length;
  ui.showLevelUp();
  return [...cards().querySelectorAll('.sv-card')];
}
const restore = () => {
  for (const u of CONFIG.upgrades) u.enabled = enabledWas.get(u.id);
  CONFIG.upgradeChoices = choicesWas;
};

const byId = new Map(CONFIG.upgrades.map((u) => [u.id, u]));
const effectOf = (id, stack = 1) => phraseAll(measure(byId.get(id), stack), stack);

// ---------------------------------------------------------------------------
section('A card that only has flavour text gets the measurement');
{
  // bounceShot's desc is "All balls, no pit." — it does not say anywhere that
  // it hands over a ricochet, and this box is the only place a player can find
  // that out before spending the pick.
  const [card] = deal('bounceShot');
  pointerEnter(card);
  const text = shown();
  check('hovering bounceShot shows a tooltip', !!text, text ?? 'nothing shown');
  // The tooltip is the measurement sentence-cased: it is a box of its own, so
  // it opens with a capital where the raw fragment does not.
  check('...and it is the measured effect', text === sentenceCase(effectOf('bounceShot')),
    `got "${text}" want "${sentenceCase(effectOf('bounceShot'))}"`);
  check('...naming the ability first, with no "unlocks" verb in front of it',
    text?.startsWith('A chaining ricochet shot') === true, text ?? '');
  pointerLeave(card);
  check('leaving the card takes it away', shown() === null, shown() ?? '');
}

// ---------------------------------------------------------------------------
section('...and a card that already says it does not repeat itself');
{
  // The suppression is the difference between a tooltip worth reading and
  // furniture. rapidFire's desc IS the effect, word for word.
  const [rapid] = deal('rapidFire');
  pointerEnter(rapid);
  check('rapidFire ("+25% fire rate") shows no tooltip', shown() === null,
    shown() ?? '');

  // The same, wrapped in a sentence: "Bullets pierce +1 enemy" contains the
  // measured "+1 enemy" and reads perfectly well already.
  const [pierce] = deal('pierce');
  pointerEnter(pierce);
  check('pierce ("Bullets pierce +1 enemy") shows no tooltip', shown() === null,
    shown() ?? '');
}

// ---------------------------------------------------------------------------
section('A card whose apply() moves nothing gets no empty box');
{
  // overboost multiplies `recoil`, which the stat block seeds at 0 — so
  // `recoil *= 1.3` measures as no change and there is nothing to report. The
  // card's own desc claims "+30% recoil boost", which is a separate problem
  // and not one a tooltip should paper over by inventing a number.
  check('overboost really does measure nothing', effectOf('overboost') === '',
    `measured "${effectOf('overboost')}"`);
  const [card] = deal('overboost');
  pointerEnter(card);
  check('...so hovering it shows no tooltip', shown() === null, shown() ?? '');
}

// ---------------------------------------------------------------------------
section('The measurement disagreeing with the desc is the point');
{
  // shrimpRing's desc promises "+1 orbiting shrimp" and its apply() hands over
  // three. The tooltip is measured, so it says three — and the card stops
  // being able to lie quietly.
  const [card] = deal('shrimpRing');
  pointerEnter(card);
  check('shrimpRing shows a tooltip', !!shown(), shown() ?? 'nothing shown');
  check('...quoting what apply() actually does', shown() === effectOf('shrimpRing'),
    `card desc says "${byId.get('shrimpRing').desc}", tooltip says "${shown()}"`);
}

// ---------------------------------------------------------------------------
section('The tooltip answers for the stack being offered');
{
  // Every repeatable card is a different card the second time, and bounceShot
  // is the clearest case: the first one hands over the ricochet and the second
  // only widens it, so a tooltip stuck on stack 1 would go on offering
  // something the player already owns.
  //
  // Asserted as a DIFFERENCE and not just against the measured string. Both
  // stacks matching `effectOf(id, stack)` is also true when the tooltip is
  // suppressed at both and every comparison is null against null — which is
  // how a card that never varies passes a stacking test without stacking.
  const [first] = deal('bounceShot');
  pointerEnter(first);
  const atOne = shown();

  player.upgrades.push({ ...byId.get('bounceShot') });
  const [second] = deal('bounceShot');
  pointerEnter(second);
  const atTwo = shown();
  player.upgrades.length = 0;

  check('the first stack quotes stack 1', atOne === sentenceCase(effectOf('bounceShot', 1)),
    `got "${atOne}"`);
  check('the second stack quotes stack 2', atTwo === sentenceCase(effectOf('bounceShot', 2)),
    `got "${atTwo}"`);
  check('...and the two really are different text', !!atOne && !!atTwo && atOne !== atTwo,
    `"${atOne}" vs "${atTwo}"`);
  check('...with only the first one naming the ability',
    atOne?.includes('chaining ricochet shot') === true
    && atTwo?.includes('chaining ricochet shot') === false,
    `stack 2 says "${atTwo}"`);
}

// ---------------------------------------------------------------------------
section('A re-deal does not leave the tooltip in a detached container');
{
  // showLevelUp clears #svCards with innerHTML = '', which deletes the tooltip
  // node along with the cards. A held reference would still take text and
  // still report itself visible, while sitting in an element that is no longer
  // in the document — nothing throws and nothing is ever drawn.
  const [a] = deal('bounceShot');
  pointerEnter(a);
  check('first deal shows one', !!shown(), shown() ?? 'nothing shown');

  const [b] = deal('laserEyes');
  pointerEnter(b);
  const node = fx();
  check('second deal shows one too', !!shown(), shown() ?? 'nothing shown');
  check('...and it is inside the live card row', !!node && node.parentElement === cards(),
    node ? `parent is ${node.parentElement?.id ?? 'detached'}` : 'no node');
  check('...with only one tooltip in the document',
    document.querySelectorAll('.sv-card-fx').length === 1,
    `${document.querySelectorAll('.sv-card-fx').length} found`);
}

// ---------------------------------------------------------------------------
section('The pad and the keyboard get it as well');
{
  const [card] = deal('bounceShot');
  check('nothing is shown before an input arrives', shown() === null, shown() ?? '');

  // updateMenuNav reads menuInput every frame, so poking a direction in is
  // exactly what a stick push looks like from the menu's side.
  menuInput.x = 1;
  ui.updateMenuNav?.();
  menuInput.x = 0;
  check('a pad move selects and shows the tooltip', shown() === effectOf('bounceShot'),
    shown() ?? 'nothing shown');
}

// ---------------------------------------------------------------------------
section('Choosing a card takes the tooltip with it');
{
  const [card] = deal('bounceShot');
  pointerEnter(card);
  check('up before the pick', !!shown(), shown() ?? 'nothing shown');
  card.click();
  check('the card was taken', picked.includes('bounceShot'), picked.join(', '));
  check('...and the tooltip went with it', shown() === null, shown() ?? '');
}

// ---------------------------------------------------------------------------
section('Nothing warned');
{
  const noisy = warnings.filter((w) => w.includes('[upgrades]'));
  check('no placeholder warnings from the cards', noisy.length === 0, noisy.join(' | '));
}

restore();
console.log(`\n${failures ? `FAILED (${failures})` : 'All checks passed'}`);
process.exit(failures ? 1 : 0);
