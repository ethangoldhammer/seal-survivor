#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:device
//
// WHICH DEVICE IS IN THE PLAYER'S HANDS — the tracker in input.js that decides
// whether a tip says "Hold Space", "Double-tap and hold" or "Hold a trigger".
//
// Every failure this covers is silent and lands on somebody else's hardware:
//
//   THE SYNTHESISED MOUSE. Every browser fires a mousemove/mousedown pair after
//   a tap. Believing them means a phone player's FIRST touch flips them to the
//   keyboard wording and the first thing the game ever says to them names a key
//   they cannot press. It is invisible on a laptop, which is where the code was
//   written and where it will be looked at again.
//
//   THE PAD ON THE DESK. A controller lying still with a drifting stick must not
//   take the words off the keyboard. If it can, it does so on every frame, and
//   no amount of typing wins them back.
//
//   THE GUESS BEFORE ANY INPUT. The first tip fires a couple of seconds into a
//   run, and on a phone the only tap so far may have been on the start button
//   rather than on the canvas. Waiting for evidence teaches the first lesson to
//   the wrong device.
//
// Load order is the jsdom recipe: jsdom, then the vite loader, then the game
// modules. Run WITHOUT --import for that reason.
//
//   node tools/input-device-test.mjs
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';

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
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
dom.window.HTMLCanvasElement.prototype.getContext = () => null;

await import('./vite-loader.mjs');

const THREE = await import('three');
const {
  initInput, updateInput, inputDevice, inputTokens, inputStatus, input,
} = await import('../path/src/input.js');
const { DEVICES, defaultDevice, shoulderLabel } = await import('../path/src/devices.js');

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
initInput(canvas);

const camera = new THREE.OrthographicCamera(-20, 20, 20, -20, 0.1, 100);
camera.updateMatrixWorld(true);
const origin = new THREE.Vector3(0, 0, 0);

// --- the events, hand-built ------------------------------------------------
// jsdom has no TouchEvent, so a touch is an ordinary cancelable Event carrying
// a changedTouches list. input.js only ever reads identifier/clientX/clientY off
// it through an index loop, which is exactly what a plain array gives us.
function touch(type, touches) {
  const ev = new dom.window.Event(type, { cancelable: true, bubbles: true });
  Object.defineProperty(ev, 'changedTouches', { value: touches });
  canvas.dispatchEvent(ev);
}

function key(type, k = 'w') {
  window.dispatchEvent(new dom.window.KeyboardEvent(type, { key: k, bubbles: true }));
}

function mouse(type, { x = 10, y = 10, button = 0 } = {}) {
  const ev = new dom.window.MouseEvent(type, {
    clientX: x, clientY: y, button, bubbles: true, cancelable: true,
  });
  (type === 'mouseup' ? window : canvas).dispatchEvent(ev);
}

// A pad the browser would report. `axes` at rest are zeros; a button is
// {pressed, value} the way the Gamepad API delivers it.
function setPad(pad) {
  dom.window.navigator.getGamepads = () => (pad ? [pad] : []);
}
const padAt = (axes = [0, 0, 0, 0], buttons = []) => ({
  index: 0,
  connected: true,
  id: 'test pad',
  mapping: 'standard',
  axes,
  buttons: Array.from({ length: 16 }, (_, i) => ({
    pressed: !!buttons[i], value: buttons[i] ? 1 : 0,
  })),
});
setPad(null);

// ---------------------------------------------------------------------------
section('before anybody has touched anything');
// ---------------------------------------------------------------------------
{
  // jsdom's matchMedia answers false to everything, which is the desktop case.
  check('a machine that does not look like a phone is assumed to be a keyboard',
    defaultDevice() === 'kbm', defaultDevice());
  check('...and that is what is reported before any input', inputDevice() === 'kbm',
    inputDevice());
  check('every answer is one of the three names', DEVICES.includes(inputDevice()));

  // The phone case, which jsdom cannot report on its own. This is the guess
  // that has to be right without evidence: the first tip fires seconds into the
  // run, and the only tap so far may have landed on the start button.
  const realMatchMedia = window.matchMedia;
  window.matchMedia = (q) => ({ matches: q.includes('coarse'), media: q });
  check('a coarse pointer with no hover is assumed to be touch',
    defaultDevice() === 'touch', defaultDevice());
  window.matchMedia = undefined;
  check('a browser too old to answer still gets a device', defaultDevice() === 'kbm',
    defaultDevice());
  window.matchMedia = realMatchMedia;
  check('...and a controller is never guessed either way — the browser hides one until it is pressed',
    defaultDevice() !== 'pad', defaultDevice());
}

// ---------------------------------------------------------------------------
section('real input claims the prompts');
// ---------------------------------------------------------------------------
{
  key('keydown');
  check('a keypress says keyboard', inputDevice() === 'kbm', inputDevice());

  touch('touchstart', [{ identifier: 1, clientX: 50, clientY: 50 }]);
  check('a finger on the glass says touch', inputDevice() === 'touch', inputDevice());

  // The whole point: the browser manufactures these immediately after the tap.
  mouse('mousemove', { x: 50, y: 50 });
  mouse('mousedown', { x: 50, y: 50 });
  mouse('mouseup', { x: 50, y: 50 });
  check('the mouse events a tap manufactures are ignored', inputDevice() === 'touch',
    inputDevice());

  touch('touchend', [{ identifier: 1, clientX: 50, clientY: 50 }]);
  check('...and lifting the finger does not change that', inputDevice() === 'touch',
    inputDevice());
}
{
  // Far enough after the touch that a mouse moving now is a real mouse. Slept
  // rather than faked, because the thing under test IS the clock.
  await new Promise((r) => setTimeout(r, 800));
  mouse('mousemove', { x: 80, y: 40 });
  check('a mouse moving well after the tap is believed', inputDevice() === 'kbm',
    inputDevice());
}

// ---------------------------------------------------------------------------
section('the pad');
// ---------------------------------------------------------------------------
{
  setPad(padAt());
  updateInput(camera, origin);
  check('a pad sitting still does not take the words off the keyboard',
    inputDevice() === 'kbm', inputDevice());

  // Under the deadzone: a worn stick resting off-centre is the case that would
  // otherwise re-claim the prompts on every single frame, forever.
  setPad(padAt([0.05, -0.04, 0, 0]));
  updateInput(camera, origin);
  check('...nor does a drifting stick', inputDevice() === 'kbm', inputDevice());

  setPad(padAt([0.9, 0, 0, 0]));
  updateInput(camera, origin);
  check('pushing a stick does', inputDevice() === 'pad', inputDevice());

  setPad(padAt());
  updateInput(camera, origin);
  check('...and letting go does not hand them back — nothing else has spoken',
    inputDevice() === 'pad', inputDevice());

  const buttons = [];
  buttons[0] = true;
  setPad(padAt([0, 0, 0, 0], buttons));
  updateInput(camera, origin);
  check('a button counts as pushing it too', inputDevice() === 'pad', inputDevice());

  key('keydown');
  check('and the keyboard can take them straight back', inputDevice() === 'kbm',
    inputDevice());

  setPad(null);
  updateInput(camera, origin);
  check('the frame loop publishes the answer for a bug report to read',
    inputStatus.device === inputDevice(), `${inputStatus.device} / ${inputDevice()}`);
}

// ---------------------------------------------------------------------------
section('aiming, which is a gesture and not a heading');
// ---------------------------------------------------------------------------
{
  // `aim` always holds a direction — something has to be true for the guns. The
  // coach needs the other question: is the player POINTING right now. Getting
  // these two confused would mark the aim tip answered on the first frame of
  // every run, on every device, and the tip would never be seen.
  setPad(padAt());
  updateInput(camera, origin);
  check('a centred right stick is not aiming', input.aiming === false);

  setPad(padAt([0, 0, 0.8, 0.1]));
  updateInput(camera, origin);
  check('a pushed right stick is', input.aiming === true);

  setPad(padAt([0, 0, 0.03, 0.02]));
  updateInput(camera, origin);
  check('...and a drifting one is not', input.aiming === false);

  setPad(padAt([0.9, 0.9, 0, 0]));
  updateInput(camera, origin);
  check('the LEFT stick does not count as aiming', input.aiming === false);
  check('...though it is still steering', input.move.lengthSq() > 0);

  setPad(null);
  updateInput(camera, origin);
  check('the mouse never reports aiming — it points by existing',
    input.aiming === false);
  check('...while the heading it produced is still a real direction',
    input.aim.lengthSq() > 0.9);
}

// ---------------------------------------------------------------------------
section('what this pad calls its shoulder buttons');
// ---------------------------------------------------------------------------
{
  // The Gamepad API has no button labels — only the free-text id — so this is
  // the only way a tip can say "L1" to somebody holding a DualSense.
  const cases = [
    ['DualSense Wireless Controller (Vendor: 054c Product: 0ce6)', 'L1 or R1'],
    ['Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', 'LB or RB'],
    ['Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)', 'L or R'],
    ['054c-0ce6-Wireless Controller', 'L1 or R1'],
  ];
  for (const [id, want] of cases) {
    check(`"${id.slice(0, 26)}…" → ${want}`, shoulderLabel(id) === want, shoulderLabel(id));
  }
  check('an unknown pad gets a phrase that is true of every controller',
    shoulderLabel('Some Gamepad (Vendor: ffff)') === 'a shoulder button',
    shoulderLabel('Some Gamepad (Vendor: ffff)'));
  check('...and so does no pad at all', shoulderLabel(null) === 'a shoulder button');

  setPad(padAt());
  dom.window.navigator.getGamepads = () => [{
    ...padAt(), id: 'DualSense Wireless Controller (Vendor: 054c Product: 0ce6)',
  }];
  updateInput(camera, origin);
  check('the tokens the frame loop hands out name the pad it is reading',
    inputTokens().bumper === 'L1 or R1', inputTokens().bumper);
  setPad(null);
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
