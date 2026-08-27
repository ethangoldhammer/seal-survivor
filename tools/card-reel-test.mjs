#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:reel
//
// THE LEVEL-UP HAND ROLLING IN — ui/cardReel.js, and the several ways a slot
// machine can run perfectly and still be wrong.
//
// SIX THINGS, and every one of them renders something plausible:
//
//   THE WRONG CARD LAST     the reels stop in TIER order, lowest first, which
//                           is not the order the cards sit in. Stop them left
//                           to right instead and the hand still rolls in
//                           beautifully — it just no longer ends on the best
//                           thing on the table, which is the entire point of
//                           the sequence and is invisible in a still.
//
//   A STALL AT THE HANDOVER the roll cruises and then decelerates, and the two
//                           phases have to meet at the same speed. A cubic
//                           ease-out over distance D in time T opens at 3D/T,
//                           so the travel is DERIVED from the cruise speed.
//                           Set the two independently and the reel visibly
//                           hesitates a third of the way from the end — which
//                           reads as a dropped frame, so it gets blamed on the
//                           machine rather than on the curve.
//
//   A CAP THAT EATS TRAVEL  the face count is capped so a menu never builds
//                           ninety divs. The cap has to lower the SPEED. Clamp
//                           the count alone and the reel arrives early and
//                           sits there holding a still card for the rest of
//                           its duration.
//
//   A REEL THAT NEVER LANDS the position has to be exactly the last face at
//                           t = duration, not merely close to it. A tail that
//                           lands at 0.998 of a card leaves every card in the
//                           hand a couple of pixels up its own window, and the
//                           strip is removed on that frame so it never
//                           corrects.
//
//   A CARD LEFT WRAPPED     landing puts the card's own content and art back
//                           on .sv-card and deletes the strip. Everything
//                           downstream reads the shape showLevelUp built — the
//                           text fit, the hover tip, the pick, the clone that
//                           flies to the hive — so a card that stayed inside
//                           its strip works until the first of those goes
//                           looking for a child it can no longer see.
//
//   A RING THAT SPOILS IT   the tier ring is drawn on the WINDOW, not on the
//                           faces, so it sits perfectly still through the roll
//                           spelling out the tier the reel is about to land
//                           on. It has to be off for the duration and back
//                           afterwards.
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
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true,
});
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Image = dom.window.Image;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.MutationObserver = dom.window.MutationObserver;
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
console.warn = () => {};

const { CONFIG } = await import('../path/src/config.js');
const { initFeedback } = await import('../path/src/systems/feedback.js');
await import('../path/src/entities/player.js');
initFeedback(null);

const reel = await import('../path/src/ui/cardReel.js');
const ui = await import('../path/src/ui/ui.js');
ui.initUI({ onStart() {}, onRestart() {}, onLevelChoice() {}, onNameSubmit() {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cardsEl = () => document.getElementById('svCards');
const cards = () => [...cardsEl().querySelectorAll('.sv-card')];

// ---------------------------------------------------------------------------
section('The sequence — which reel stops when');

{
  // Cards sitting on screen as [epic, common, rare]: the reel must stop the
  // common one first and the epic one last, whatever order they are drawn in.
  const plan = reel.reelPlan([7, 1, 4]);
  const order = plan.map((p) => p.step);
  check('lowest tier stops first', order[1] === 0, `steps ${order.join(',')}`);
  check('highest tier stops last', order[0] === 2, `steps ${order.join(',')}`);
  check('landings are staggered in time',
    plan[1].seconds < plan[2].seconds && plan[2].seconds < plan[0].seconds,
    plan.map((p) => p.seconds.toFixed(2)).join(' < '));

  const tie = reel.reelPlan([3, 3, 3]);
  check('ties keep their dealt order', tie.map((p) => p.step).join(',') === '0,1,2');

  const one = reel.reelPlan([2]);
  check('a hand of one still plans', one.length === 1 && one[0].step === 0);
}

// ---------------------------------------------------------------------------
section('The curve — cruise, handover, landing');

{
  const c = {
    enabled: true, speed: 22, first: 0.62, stagger: 0.3, knee: 0.66,
    bounce: 0.9, blur: 2, minFaces: 6, maxFaces: 26,
  };
  const secs = 1.22;
  const n = reel.faceCount(secs, c);
  const at = (t) => reel.reelPos(t, secs, n, c);

  check('lands exactly on the last face', at(secs) === n, `${at(secs)} vs ${n}`);
  check('starts on the first face', at(0) === 0);
  check('past the end stays put', at(secs * 2) === n);

  // Velocity either side of the knee. A handover that does not match shows up
  // here as a step and on screen as a hesitation.
  const k = secs * c.knee, h = 0.004;
  const before = (at(k - h) - at(k - 2 * h)) / h;
  const after = (at(k + 2 * h) - at(k + h)) / h;
  check('speed is continuous at the knee', Math.abs(before - after) / before < 0.06,
    `${before.toFixed(1)} -> ${after.toFixed(1)} faces/s`);

  // Cruise is a straight line, so three samples inside it are evenly spaced.
  const a1 = at(0.1), a2 = at(0.2), a3 = at(0.3);
  check('cruise is constant speed', Math.abs((a2 - a1) - (a3 - a2)) < 1e-6);

  // The tail slows down. Sampled either side of the last quarter.
  const late = at(secs) - at(secs - 0.05);
  check('the tail is slower than the cruise', late < (a2 - a1) * 0.5,
    `${late.toFixed(2)} vs ${(a2 - a1).toFixed(2)} faces per 0.1s`);

  // The settle: past the card and back onto it.
  let peak = 0;
  for (let t = 0; t <= secs; t += secs / 400) peak = Math.max(peak, at(t));
  check('it overshoots and settles back', peak > n && peak - n < 0.25,
    `peak ${peak.toFixed(3)} vs ${n}`);

  const dead = reel.faceCount(secs, { ...c, bounce: 0 });
  let deadPeak = 0;
  for (let t = 0; t <= secs; t += secs / 400) deadPeak = Math.max(deadPeak, reel.reelPos(t, secs, dead, { ...c, bounce: 0 }));
  check('bounce 0 is a dead stop', Math.abs(deadPeak - dead) < 1e-9, `peak ${deadPeak.toFixed(4)}`);
}

{
  // THE CAP LOWERS THE SPEED. A reel that hits it must still be moving when it
  // gets there, not parked.
  const c = {
    enabled: true, speed: 400, first: 0.62, stagger: 0.3, knee: 0.66,
    bounce: 0.9, blur: 2, minFaces: 6, maxFaces: 12,
  };
  const n = reel.faceCount(2, c);
  check('face count is capped', n === 12, `${n}`);
  check('a capped reel still lands', reel.reelPos(2, 2, n, c) === n);
  // THE CAP CHANGES THE SPEED, NOT THE CURVE. Two reels of the same duration
  // and different lengths have to trace the same shape — which is exactly what
  // clamping the count alone would break, by leaving the curve to arrive early
  // and then hold a still card.
  const half = 6;
  let same = true;
  for (let t = 0; t <= 2; t += 0.05) {
    const a = reel.reelPos(t, 2, n, c) / n;
    const b = reel.reelPos(t, 2, half, c) / half;
    if (Math.abs(a - b) > 1e-9) same = false;
  }
  check('a capped reel traces the same curve, slower', same);
  const mid = reel.reelPos(1, 2, n, c);
  check('a capped reel has not arrived at half time', mid < n * 0.8,
    `on face ${mid.toFixed(2)} of ${n}`);

  const tiny = reel.faceCount(0.05, { ...c, speed: 1 });
  check('a short reel still has faces to roll', tiny >= c.minFaces, `${tiny}`);
}

// ---------------------------------------------------------------------------
section('The strip — what the cards look like mid-roll');

// Short enough that the whole hand lands inside a test rather than inside a
// level-up: the shape being asserted is the same at any speed.
const was = { ...CONFIG.upgradeReel };
Object.assign(CONFIG.upgradeReel, { first: 0.05, stagger: 0.04, maxFaces: 8 });

{
  const lit = [];
  const obs = new MutationObserver((records) => {
    for (const r of records) {
      if (r.target.classList.contains('sv-lit') && !lit.includes(r.target)) lit.push(r.target);
    }
  });

  // A HAND WITH MORE THAN ONE TIER IN IT. Tiers are rolled per card, so a deal
  // of three of the same one is normal — and it makes the assertion that the
  // best card lights last pass without ever comparing two different tiers,
  // which is the same as not testing it. Re-dealt until the hand can answer
  // the question. Each deal cancels the one before it, and nothing has landed
  // yet: the first reel stops 50ms out and this loop is synchronous.
  let mixed = false;
  for (let i = 0; i < 60 && !mixed; i++) {
    ui.showLevelUp();
    mixed = new Set(cards().map((c) => c.dataset.rarityRank)).size > 1;
  }
  check('dealt a hand with more than one tier in it', mixed,
    cards().map((c) => c.dataset.rarityRank).join(','));
  obs.observe(cardsEl(), { subtree: true, attributes: true, attributeFilter: ['class'] });

  const hand = cards();
  check('a hand was dealt', hand.length === CONFIG.upgradeChoices, `${hand.length} cards`);

  const strips = hand.map((card) => card.querySelector('.sv-reel'));
  check('every card is rolling', strips.every(Boolean));

  const faces = strips[0].querySelectorAll('.sv-reel-face');
  check('the strip is decoys plus the card itself', faces.length >= 3,
    `${faces.length} faces`);
  check('the card is the LAST cell of the strip',
    faces[faces.length - 1].querySelector('.sv-card-content') !== null);
  check('the card is not also still in the window',
    hand[0].querySelector(':scope > .sv-card-content') === null);
  check('faces are stacked one card apart',
    [...faces].every((f, i) => f.style.top === `${i * 100}%`),
    [...faces].slice(0, 3).map((f) => f.style.top).join(' '));

  const decoys = [...faces].slice(0, -1);
  check('decoys carry a name', decoys.every((f) => f.querySelector('.sv-card-name')));
  check('decoys carry NO description', decoys.every((f) => !f.querySelector('.sv-card-desc')));
  check('decoys draw their own tier ring',
    decoys.some((f) => /inset 0 0 0/.test(f.style.boxShadow)));
  check('the window ring is off while it rolls',
    hand.every((c) => c.style.getPropertyValue('--sv-ring-w') === '0px'));
  check('the menu is locked while it rolls',
    document.getElementById('svLevelUpMenu').classList.contains('sv-menu-locked'));

  const dealt = hand.map((c) => Number(c.dataset.rarityRank) || 0);
  await sleep(400);

  check('every strip is gone once it lands',
    hand.every((c) => !c.querySelector('.sv-reel')));
  check('the content is back on the card',
    hand.every((c) => c.querySelector(':scope > .sv-card-content')));
  check('the tier ring is back',
    hand.every((c) => c.style.getPropertyValue('--sv-ring-w') !== '0px'),
    hand.map((c) => c.style.getPropertyValue('--sv-ring-w')).join(' '));
  check('the menu unlocked',
    !document.getElementById('svLevelUpMenu').classList.contains('sv-menu-locked'));
  check('every card lit', lit.length === hand.length, `${lit.length}/${hand.length}`);

  // The whole reason the sequence exists: the last card to light is the best
  // one in the hand.
  const litRanks = lit.map((slot) => Number(slot.querySelector('.sv-card').dataset.rarityRank) || 0);
  check('cards lit lowest tier first',
    litRanks.every((r, i) => i === 0 || r >= litRanks[i - 1]),
    `ranks ${litRanks.join(',')} (dealt ${dealt.join(',')})`);
  obs.disconnect();
}

// ---------------------------------------------------------------------------
section('The skip');

{
  Object.assign(CONFIG.upgradeReel, { first: 0.4, stagger: 0.4 });
  const picked = [];
  ui.initUI({ onStart() {}, onRestart() {}, onLevelChoice(c) { picked.push(c.id); }, onNameSubmit() {} });
  ui.showLevelUp();
  const hand = cards();
  check('rolling before the skip', hand.every((c) => c.querySelector('.sv-reel')));

  // A click ON A CARD. The same event must cut the roll short and pick
  // nothing — the menu unlocks a moment later, and a click still travelling
  // would land on whatever is under the finger.
  hand[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

  check('the skip landed every reel', hand.every((c) => !c.querySelector('.sv-reel')));
  check('the skip picked nothing', picked.length === 0, picked.join(','));
  check('the menu unlocked on the skip',
    !document.getElementById('svLevelUpMenu').classList.contains('sv-menu-locked'));

  await sleep(400);
  check('the hand still lit itself after the skip',
    hand.every((c) => c.parentElement.classList.contains('sv-lit')));

  // ...and the menu works afterwards.
  hand[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  check('a card can be picked once the roll is over', picked.length === 1, picked.join(','));
}

// ---------------------------------------------------------------------------
section('With the reel switched off');

{
  CONFIG.upgradeReel.enabled = false;
  ui.showLevelUp();
  const hand = cards();
  check('no strips are built', hand.every((c) => !c.querySelector('.sv-reel')));
  check('the card is intact', hand.every((c) => c.querySelector(':scope > .sv-card-content')));
  await sleep(300);
  check('the hand still lights itself',
    hand.every((c) => c.parentElement.classList.contains('sv-lit')));
  check('and the menu is not left locked',
    !document.getElementById('svLevelUpMenu').classList.contains('sv-menu-locked'));
}

Object.assign(CONFIG.upgradeReel, was);

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
