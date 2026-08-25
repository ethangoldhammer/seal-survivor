#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:press
//
// TAP, HOLD, AND PULL OFF — the three endings a press has, and the one that
// was missing everywhere.
//
// On a phone every menu in this game committed on touch: you tapped a level-up
// card and you had taken it. There was no way to READ one first (a tip that
// opens on hover is a tip a thumb can never see) and no way to change your mind
// (a press that had begun was already a decision). ui/press.js is both halves.
//
// SEVEN THINGS, and six of them are invisible from the outside — the control
// looks wired, the listener runs, and the wrong thing happens:
//
//   THE CAPTURE BREAKS THE CLICK   A hold has to setPointerCapture or the
//                     events stop arriving the moment the finger drifts a
//                     pixel. Capture retargets `click` to the capturing
//                     element — so the browser's own "released somewhere else,
//                     so no click" rule stops applying at exactly the moment
//                     this code starts needing it. Sliding a thumb off a card
//                     fires the card. That IS the reported bug, and it only
//                     appears once the hold is added.
//
//   A HOLD IS ALSO A TAP   Without cancelling the activation, holding a card to
//                     read it takes it — which turns the feature into a worse
//                     version of the bug it was meant to fix.
//
//   A SUPPRESSOR THAT LATCHES   The click after a slip may never come (a
//                     cancelled gesture produces none on any platform). A
//                     suppressor armed and never disarmed eats the player's
//                     NEXT tap: a menu that ignores every press, which is the
//                     worst way for this to fail.
//
//   ZERO SLOP CANCELS EVERYTHING   A thumb on glass wanders 4-8px over a
//                     quarter second. A rule that treats any movement as a slip
//                     cancels nearly every real hold, and the feature reads as
//                     broken rather than as strict.
//
//   THE KEYBOARD GETS CAUGHT   A synthesised click has no press behind it to
//                     have slipped. Swallow it and the pad, the keyboard and
//                     the screen reader all stop working — on the controls that
//                     exist for exactly those users.
//
//   THE RELEASE TARGET LIES   Capture makes `e.target` the captured element
//                     however far away the finger is, so "did it come up
//                     inside" cannot be read off the event and has to be
//                     measured against the rectangle.
//
//   A REBUILT SURFACE STOPS ANSWERING   The hive throws every tile away on each
//                     pick and the level-up row is re-dealt per level, so
//                     per-element wiring means re-binding after every rebuild —
//                     and the first missed re-bind is a tile that silently
//                     stops answering.
//
// Load order is the jsdom recipe: jsdom, then the vite loader, then the game
// modules. Run WITHOUT --import.
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true,
});
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Image = dom.window.Image;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(0), 0);

const { registerHooks } = await import('node:module');
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@rive-app/canvas') return { url: 'stub:rive', format: 'module', shortCircuit: true };
    if (spec.endsWith('.riv?url') || spec.endsWith('.wasm?url')) return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === 'stub:rive') return { format: 'module', shortCircuit: true, source: 'export class Rive {} export const EventType={};export const Layout=class{};export const Fit={};export const Alignment={};export const RuntimeLoader={setWasmUrl(){}};' };
    if (url === 'stub:rivurl') return { format: 'module', shortCircuit: true, source: 'export default "s.riv";' };
    return next(url, ctx);
  },
});
await import('./vite-loader.mjs');
globalThis.fetch = async () => ({ ok: false, status: 404 });
console.warn = () => {};

const { pressable, pressableWithin } = await import('../path/src/ui/press.js');

// --- a finger ---------------------------------------------------------------
//
// jsdom has no PointerEvent and no layout, so both are supplied here. The
// RECTANGLE is the part that matters: press.js reads it on release to decide
// whether the finger came up inside, and jsdom returns all zeroes — which would
// make every release read as "outside" and pass the slip tests for the wrong
// reason. Each element under test is given a real one.
function rect(el, r) {
  el.getBoundingClientRect = () => ({
    left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h,
    width: r.w, height: r.h, x: r.x, y: r.y,
  });
  return el;
}
const ev = (type, { x = 0, y = 0, id = 1, detail = 1, bubbles = true } = {}) => {
  const e = new dom.window.Event(type, { bubbles, cancelable: true });
  Object.assign(e, { clientX: x, clientY: y, pointerId: id, button: 0, detail });
  return e;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Longer than press.js's 280ms hold, short enough to keep the suite quick.
const PAST_HOLD = 340;

// setPointerCapture does not exist in jsdom. A no-op is the honest stub: the
// harness delivers every event to the element directly, which is what capture
// achieves on a real device.
dom.window.Element.prototype.setPointerCapture = function () {};
dom.window.Element.prototype.releasePointerCapture = function () {};

function control(x = 0, y = 0) {
  const el = document.createElement('button');
  document.body.appendChild(el);
  return rect(el, { x, y, w: 100, h: 100 });
}

// ---------------------------------------------------------------------------
section('a clean tap still activates');
{
  const el = control();
  let clicks = 0;
  el.addEventListener('click', () => { clicks += 1; });
  pressable(el, {});

  el.dispatchEvent(ev('pointerdown', { x: 50, y: 50 }));
  el.dispatchEvent(ev('pointerup', { x: 52, y: 51 }));
  el.dispatchEvent(ev('click', { x: 52, y: 51 }));
  check('a tap that does not move fires the click', clicks === 1, String(clicks));

  // A thumb on glass is not still. Zero slop would cancel nearly every real
  // press and the whole thing would read as broken rather than as strict.
  el.dispatchEvent(ev('pointerdown', { x: 50, y: 50 }));
  el.dispatchEvent(ev('pointerup', { x: 57, y: 56 }));
  el.dispatchEvent(ev('click', { x: 57, y: 56 }));
  check('...and a little drift is still the same press', clicks === 2, String(clicks));
}

// ---------------------------------------------------------------------------
section('pulling off cancels it');
{
  const el = control();
  let clicks = 0;
  let slips = 0;
  el.addEventListener('click', () => { clicks += 1; });
  pressable(el, { onSlip: () => { slips += 1; } });

  el.dispatchEvent(ev('pointerdown', { x: 50, y: 50 }));
  el.dispatchEvent(ev('pointermove', { x: 50, y: 90 }));
  check('moving past the slop radius is a slip', slips === 1, String(slips));
  el.dispatchEvent(ev('pointerup', { x: 50, y: 190 }));
  // THE CLICK STILL ARRIVES. The capture a hold needs retargets it to the
  // captured element however far away the finger went, so the browser's own
  // rule is not doing this for us — which is the whole bug.
  el.dispatchEvent(ev('click', { x: 50, y: 190 }));
  check('...and the click is eaten', clicks === 0, String(clicks));

  // Released OUTSIDE without a move event in between — which is what a fast
  // flick reports. Measured against the rectangle, because the capture makes
  // e.target lie.
  el.dispatchEvent(ev('pointerdown', { x: 50, y: 50 }));
  el.dispatchEvent(ev('pointerup', { x: 400, y: 400 }));
  el.dispatchEvent(ev('click', { x: 400, y: 400 }));
  check('a release outside the box is a slip too, with no move to warn of it',
    clicks === 0, String(clicks));

  // AND THE SUPPRESSOR MUST NOT LATCH.
  el.dispatchEvent(ev('pointerdown', { x: 50, y: 50 }));
  el.dispatchEvent(ev('pointerup', { x: 50, y: 50 }));
  el.dispatchEvent(ev('click', { x: 50, y: 50 }));
  check('the NEXT press still works', clicks === 1, String(clicks));
}

// ---------------------------------------------------------------------------
section('a hold reads rather than picks');
{
  const el = control();
  let clicks = 0;
  let held = 0;
  let ended = 0;
  el.addEventListener('click', () => { clicks += 1; });
  pressable(el, { onHold: () => { held += 1; }, onHoldEnd: () => { ended += 1; } });

  el.dispatchEvent(ev('pointerdown', { x: 50, y: 50 }));
  check('nothing has happened yet', held === 0);
  await wait(PAST_HOLD);
  check('holding opens it', held === 1, String(held));
  el.dispatchEvent(ev('pointerup', { x: 50, y: 50 }));
  el.dispatchEvent(ev('click', { x: 50, y: 50 }));
  // THE POINT OF THE WHOLE THING: reading a card is not choosing it.
  check('...and the release does NOT activate', clicks === 0, String(clicks));
  check('...and it closes on release', ended === 1, String(ended));

  // A tap under the hold length is still a tap.
  el.dispatchEvent(ev('pointerdown', { x: 50, y: 50 }));
  await wait(40);
  el.dispatchEvent(ev('pointerup', { x: 50, y: 50 }));
  el.dispatchEvent(ev('click', { x: 50, y: 50 }));
  check('a short press is unaffected', clicks === 1 && held === 1, `${clicks} clicks, ${held} holds`);
}

// ---------------------------------------------------------------------------
section('a hold that slips goes away as you pull');
{
  const el = control();
  let held = 0;
  let ended = 0;
  pressable(el, { onHold: () => { held += 1; }, onHoldEnd: () => { ended += 1; }, onSlip: () => {} });

  el.dispatchEvent(ev('pointerdown', { x: 50, y: 50 }));
  await wait(PAST_HOLD);
  el.dispatchEvent(ev('pointermove', { x: 50, y: 200 }));
  // Not on the release. A box describing something the finger has already left
  // is the moment it stops being an answer to anything.
  check('the tip goes as the finger leaves, not when it lets go', ended === 1, String(ended));
  el.dispatchEvent(ev('pointerup', { x: 50, y: 200 }));
  check('...and does not close twice', ended === 1, String(ended));

  // Moving first means the hold never opens at all.
  el.dispatchEvent(ev('pointerdown', { x: 50, y: 50 }));
  el.dispatchEvent(ev('pointermove', { x: 50, y: 200 }));
  await wait(PAST_HOLD);
  check('a press that moved first never holds', held === 1, String(held));
  el.dispatchEvent(ev('pointerup', { x: 50, y: 200 }));
}

// ---------------------------------------------------------------------------
section('a cancelled gesture leaves nothing armed');
{
  const el = control();
  let clicks = 0;
  let held = 0;
  el.addEventListener('click', () => { clicks += 1; });
  pressable(el, { onHold: () => { held += 1; } });

  // A scroll, a second finger, an OS edge swipe. No click follows on any
  // platform — so nothing may be left waiting to eat one.
  el.dispatchEvent(ev('pointerdown', { x: 50, y: 50 }));
  el.dispatchEvent(ev('pointercancel', { x: 50, y: 50 }));
  await wait(PAST_HOLD);
  check('the hold does not fire after the gesture was taken away', held === 0, String(held));

  el.dispatchEvent(ev('pointerdown', { x: 50, y: 50 }));
  el.dispatchEvent(ev('pointerup', { x: 50, y: 50 }));
  el.dispatchEvent(ev('click', { x: 50, y: 50 }));
  check('...and the next real tap is not swallowed', clicks === 1, String(clicks));
}

// ---------------------------------------------------------------------------
section('the keyboard and the pad are untouched');
{
  const el = control();
  let clicks = 0;
  el.addEventListener('click', () => { clicks += 1; });
  pressable(el, { onHold: () => {} });

  // A slip arms the suppressor; the click that follows is a SYNTHESISED one —
  // .click() from updateMenuNav, or Enter on a focused button. detail 0 is the
  // tell. Swallowing it would break the pad and the screen reader on exactly
  // the controls that exist for them.
  el.dispatchEvent(ev('pointerdown', { x: 50, y: 50 }));
  el.dispatchEvent(ev('pointerup', { x: 400, y: 400 }));
  el.dispatchEvent(ev('click', { x: 0, y: 0, detail: 0 }));
  check('a synthesised click passes through a live suppressor', clicks === 1, String(clicks));
}

// ---------------------------------------------------------------------------
section('a right-click is not a press');
{
  const el = control();
  let held = 0;
  pressable(el, { onHold: () => { held += 1; } });
  const e = ev('pointerdown', { x: 50, y: 50 });
  e.button = 2;
  el.dispatchEvent(e);
  await wait(PAST_HOLD);
  check('the secondary button arms nothing', held === 0, String(held));
}

// ---------------------------------------------------------------------------
section('a rebuilt surface keeps answering');
{
  // The hive throws every tile away on each pick and the level-up row is
  // re-dealt per level. Delegated on the container, which outlives all of it —
  // per-element wiring means re-binding after every rebuild, and the first
  // missed re-bind is a tile that silently stops answering.
  const host = document.createElement('div');
  document.body.appendChild(host);
  let held = null;
  pressableWithin(host, '.tile', {
    onHold: (el) => { held = el.dataset.id; },
    onHoldEnd: () => { held = null; },
  });

  const build = (id) => {
    host.textContent = '';
    const t = document.createElement('div');
    t.className = 'tile';
    t.dataset.id = id;
    host.appendChild(t);
    return rect(t, { x: 0, y: 0, w: 60, h: 60 });
  };

  const a = build('shrimpRing');
  a.dispatchEvent(ev('pointerdown', { x: 30, y: 30 }));
  await wait(PAST_HOLD);
  check('a tile answers a hold', held === 'shrimpRing', String(held));
  a.dispatchEvent(ev('pointerup', { x: 30, y: 30 }));

  // The rebuild every pick causes.
  const b = build('seagullBomb');
  b.dispatchEvent(ev('pointerdown', { x: 30, y: 30 }));
  await wait(PAST_HOLD);
  check('...and so does the one that replaced it', held === 'seagullBomb', String(held));
  b.dispatchEvent(ev('pointerup', { x: 30, y: 30 }));

  // A press that starts outside any tile arms nothing.
  held = null;
  host.dispatchEvent(ev('pointerdown', { x: 200, y: 200 }));
  await wait(PAST_HOLD);
  check('a press on the gaps between them does nothing', held === null, String(held));
}

// ---------------------------------------------------------------------------
section('the surfaces are actually wired');
{
  // The rules above are only worth anything where they are applied. Read off
  // the source rather than driven, because standing up the level-up row, the
  // dividend and the score screen is what test:tooltip and test:tips already
  // do — what can silently regress here is a call site being dropped.
  const { readFileSync } = await import('node:fs');
  const src = (f) => readFileSync(new URL(`../path/src/ui/${f}`, import.meta.url), 'utf8');
  const ui = src('ui.js');
  check('the level-up cards hold to read', /pressable\(card, \{/.test(ui));
  check('the score screen snapshot does', /pressableWithin\(slot, '\.sv-hive-tile'/.test(ui));
  check('the expanded build does', /pressableWithin\(el\.svHiveViewStage/.test(ui));
  check('every menu control has slip protection',
    /pressableWithin\(document\.body, MENU_CONTROLS/.test(ui));
  check('...and cards and hexagons are left out of that guard, having their own',
    !/'\.sv-card'|'\.sv-hive-tile'/.test(ui.slice(ui.indexOf('const MENU_CONTROLS'), ui.indexOf('let root = null'))));
  check('the corner hive does', /pressableWithin\(state\.host, '\.sv-hive-tile'/.test(src('upgradeHive.js')));
  check('the boss dividend does', /pressableWithin\(host, '\.sv-hive-tile'/.test(src('hiveReward.js')));
  // iOS answers a long press with its own callout — the copy bubble, or a
  // drag-out of the image under the finger — on top of the tip that was asked
  // for, having also stolen the gesture that would dismiss it.
  check('a hold cannot become an iOS text selection',
    /-webkit-touch-callout: none/.test(ui) && /touch-action: manipulation/.test(ui));
}

console.log(`\n${failures ? `FAILED (${failures})` : 'all passed'}`);
process.exit(failures ? 1 : 0);
