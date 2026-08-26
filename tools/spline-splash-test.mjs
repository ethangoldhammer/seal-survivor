#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:splinesplash
//
// The Spline name screen (ui/splineSplash.js) and the switch that chooses it
// (ui/splashChoice.js), driven through the real modules in jsdom.
//
// WHY THIS EXISTS AT ALL for a screen that is only an audition: the audition is
// worthless if the two screens are not doing the same job. The Rive card holds
// the name rules — sanitise on the way in, bank on the way out, refuse a name
// the ledger says is buried — and every one of them is a thing a second
// implementation can silently drop. A Spline screen that "wins" because it let
// a dead seal's name straight through has not won anything, and nothing on
// screen would show it.
//
// Each of these fails INVISIBLY in the game:
//
//   THE NAME NOT BANKED     destroy() is the only write to storage. Miss it and
//                           a player who typed their name and pressed play is
//                           called Seal, with no error anywhere.
//   A BURIED NAME RUNNING   death is permanent (systems/nameLedger.js). A
//                           returning player whose last seal died must not come
//                           back as that seal, and the name screen is the last
//                           surface between the two.
//   THE FIELD STARTING      "press anywhere plays" is what makes this startable
//                           on a phone. If the field's own press also counts,
//                           reaching for the keyboard throws you into the game.
//   A DEAD SCENE FATAL      a name screen that cannot reach its backdrop is
//                           still a name screen. If a bad URL took the screen
//                           down with it, the game would be a wall with no door.
//   THE SWITCH DEFAULTING   the default must be the Rive card. An audition that
//                           can change what a player who typed nothing sees is
//                           not an audition.
//
// NOTE the load order: jsdom FIRST, then the vite loader hooks, then the game
// modules. The other way round breaks the CJS chain jsdom loads through. See
// the jsdom-harness recipe.
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// `url` set, or localStorage throws on the opaque origin the moment anything
// touches it — which here is the first line of the module under test.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Node 22 defines `navigator` as a getter-only global, so it has to be
// redefined rather than assigned.
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true,
});
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

await import('./vite-loader.mjs');

const { mountSplineSplash } = await import('../path/src/ui/splineSplash.js');
const { splashChoice, splineSrcOverride, SPLINE_ENABLED } = await import('../path/src/ui/splashChoice.js');
const { loadPlayerName, savePlayerName } = await import('../path/src/systems/playerName.js');
const { buryName, clearNameLedger } = await import('../path/src/systems/nameLedger.js');

// A real gesture, the way the browser delivers one: the press begins on the
// wrapper and the release names the element it landed on.
function press(el, target = el) {
  el.dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true }));
  target.dispatchEvent(new dom.window.PointerEvent('pointerup', { bubbles: true }));
}

const field = (wrap) => wrap.querySelector('input[type=text]');

/** Mount past the dead time, so a press in the test means what a press means. */
function mountAged(opts = {}) {
  const handle = mountSplineSplash({ parent: document.body, ...opts });
  const wrap = document.body.querySelector('.sv-spline');
  return { handle, wrap };
}

// ---------------------------------------------------------------------------
section('the switch');
{
  check('defaults to the Rive card', splashChoice() === 'rive', splashChoice());
  check('no scene override by default', splineSrcOverride() === '');

  // THE OFF SWITCH — SPLINE_ENABLED in ui/splashChoice.js, false since
  // 2026-08-25. These two are the cases an off switch is most likely to miss,
  // and both leave the Spline screen coming up for the people most likely to
  // see it: a link with ?splash=spline in it is still in somebody's history,
  // and anyone who actually auditioned the scene has 'spline' latched in
  // localStorage on that origin.
  //
  // Written to be true either way rather than asserting "off": when the switch
  // goes back on, these should keep passing by exercising the audition instead
  // of failing because the constant moved. What is NOT allowed is the switch
  // being off and one of these still answering 'spline'.
  const wantsSpline = SPLINE_ENABLED;

  dom.reconfigure({ url: 'http://localhost/?splash=spline' });
  check(
    `a ?splash=spline URL ${wantsSpline ? 'is honoured' : 'is ignored'}`,
    splashChoice() === (wantsSpline ? 'spline' : 'rive'),
    splashChoice(),
  );

  // Latched deliberately, because the query above would have set it when the
  // switch is on — this asserts the stored value on its own terms.
  dom.reconfigure({ url: 'http://localhost/' });
  localStorage.setItem('sv.splash.audition', 'spline');
  check(
    `a latched audition ${wantsSpline ? 'comes back' : 'does not come back'}`,
    splashChoice() === (wantsSpline ? 'spline' : 'rive'),
    splashChoice(),
  );
  localStorage.removeItem('sv.splash.audition');
}

// ---------------------------------------------------------------------------
section('the name');
{
  clearNameLedger();
  savePlayerName('Chonker');
  const { handle, wrap } = mountAged();

  check('the saved name is in the field', field(wrap).value === 'Chonker', field(wrap).value);

  field(wrap).value = 'Blubber';
  field(wrap).dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  handle.destroy('test');

  check('typed name banked on the way out', loadPlayerName() === 'Blubber', loadPlayerName());
  check('the wrapper is gone', !document.body.querySelector('.sv-spline'));
}

// ---------------------------------------------------------------------------
section('a buried seal does not come back');
{
  clearNameLedger();
  savePlayerName('Doomed Squish');
  buryName('Doomed Squish');
  const { handle, wrap } = mountAged();

  const shown = field(wrap).value;
  check('the field holds a different name', shown && shown !== 'Doomed Squish', shown);
  check('and it is already saved', loadPlayerName() !== 'Doomed Squish', loadPlayerName());
  handle.destroy('test');
  clearNameLedger();
}

// ---------------------------------------------------------------------------
section('the dice');
{
  savePlayerName('Chonker');
  const { handle, wrap } = mountAged();
  const before = field(wrap).value;
  const rolled = handle.randomize();
  check('rolls something else', rolled && rolled !== before, `${before} -> ${rolled}`);
  check('and it lands in the field', field(wrap).value === rolled);
  check('but is not saved yet', loadPlayerName() === 'Chonker', loadPlayerName());
  handle.destroy('test');
}

// ---------------------------------------------------------------------------
section('what a press means');
{
  // THE DEAD TIME IS REAL TIME. Mounted and pressed immediately, the screen
  // must NOT start — this is the gesture that brought the player here.
  const early = mountAged();
  press(early.wrap);
  check('a press in the first moments does nothing', !early.handle.isDestroyed);
  early.handle.destroy('test');

  const { handle, wrap } = mountAged();
  await new Promise((r) => setTimeout(r, 450));

  // The field's own press means "I want to type", and nothing else.
  press(wrap, field(wrap));
  check('a press on the field does not start the run', !handle.isDestroyed);

  let reason = '';
  const outer = mountSplineSplash({ parent: document.body, onDismiss: (r) => { reason = r; } });
  const outerWrap = document.body.querySelectorAll('.sv-spline')[1];
  await new Promise((r) => setTimeout(r, 450));
  press(outerWrap);
  check('a press anywhere else does', outer.isDestroyed);
  check('and says why', reason === 'press', reason);

  handle.destroy('test');
}

// ---------------------------------------------------------------------------
section('a scene that never arrives');
{
  const { handle, wrap } = mountAged({ src: 'https://example.invalid/nothing.glb' });
  // A model is refused outright — see the module header. The screen survives it.
  await new Promise((r) => setTimeout(r, 20));
  check('the screen is still standing', !handle.isDestroyed);
  check('and still has a name field', !!field(wrap), 'a screen with no door is the worst failure here');
  handle.destroy('test');
}

// ---------------------------------------------------------------------------
console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
