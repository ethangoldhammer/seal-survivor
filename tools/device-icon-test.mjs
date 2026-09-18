#!/usr/bin/env node
// ---------------------------------------------------------------------------
// WHICH CONTROLLER IS THIS, and what the chip draws for it.
//
// Two halves, and the second is the one that matters more:
//
//   THE BRAND   is read out of the Gamepad API's free-text `id` — a string the
//               driver wrote, different on every platform and every browser.
//               The ids below are real ones, copied from what Chrome, Firefox
//               and Safari actually report, because a detector tested only
//               against ids somebody invented for the test is a detector tested
//               against its own assumptions.
//
//   THE ART      is five CC0 drawings from Kenney's Input Prompts pack, baked
//               into ui/deviceIcons.js. Nothing in Node can look at a drawing,
//               so what is checked is the pair of properties that fail SILENTLY
//               and only somewhere else: that a viewBox survived the bake (or
//               the mark is a 64px crop on iOS Safari and perfect in Chromium),
//               and that the four pads in a room draw four DIFFERENT pictures,
//               which is the entire point of the feature.
//
//   THE CHIP     falls back to the glyph it has always drawn wherever a key has
//               no art. Unreachable today — all five are baked — and forced
//               here by taking a key off the module, because it is the branch a
//               bake that dropped one lands on, and the difference between a
//               chip that reads plainer and a chip that is empty.
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);

await import('./vite-loader.mjs');
const { padBrand, PAD_BRANDS } = await import('../path/src/ui/padBrand.js');
const { DEVICE_ICONS } = await import('../path/src/ui/deviceIcons.js');

// ---------------------------------------------------------------------------
section('The brand, read out of what the browser says');

// Chrome and Safari: words AND a vendor id.
check('an Xbox pad on Chrome',
  padBrand('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)') === 'xbox');
check('a DualSense on Chrome',
  padBrand('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)') === 'playstation');
check('a DualShock 4 on Chrome',
  padBrand('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)') === 'playstation');
check('a Switch Pro Controller on Chrome',
  padBrand('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)') === 'switch');

// Firefox, which reports the numbers and barely any words — the case the
// vendor-id route exists for.
check('an Xbox pad on Firefox, which gives no brand name',
  padBrand('045e-02fd-Xbox Wireless Controller') === 'xbox');
check('a DualShock on Firefox, whose name says only "Wireless Controller"',
  padBrand('054c-09cc-Wireless Controller') === 'playstation', padBrand('054c-09cc-Wireless Controller'));
check('a Switch pad on Firefox', padBrand('057e-2009-Pro Controller') === 'switch');

// ...and the other way round: a name and no numbers at all.
check('a name with no vendor id still reads', padBrand('Nintendo Switch Pro Controller') === 'switch');
check('"Pro Controller" alone is the Switch pad', padBrand('Pro Controller') === 'switch');
check('a DualShock named without numbers', padBrand('Sony DualShock 4') === 'playstation');

// ---------------------------------------------------------------------------
section('A pad it does not know is a pad, not a wrong guess');
check('an unknown pad with no marks at all', padBrand('Unknown Gamepad') === 'pad');
check('...and one with a vendor nobody here knows',
  padBrand('Generic USB Joystick (Vendor: 0079 Product: 0006)') === 'pad');
// THE ONE THE VENDOR ID IS FOR. Third-party pads put a brand's name in their
// own id all the time; the USB vendor number is the half that cannot flatter
// itself, so where the two disagree the number wins.
check('a third-party pad calling itself an Xbox controller is not taken for one',
  padBrand('Xbox 360 Controller for Windows (Vendor: 0079 Product: 0006)') === 'pad',
  padBrand('Xbox 360 Controller for Windows (Vendor: 0079 Product: 0006)'));
check('nothing at all is a pad', padBrand('') === 'pad' && padBrand(undefined) === 'pad');
check('every answer is one of the declared brands',
  ['Xbox', 'DualSense', 'Pro Controller', 'junk', ''].every((s) => PAD_BRANDS.includes(padBrand(s))));

// ---------------------------------------------------------------------------
section('The baked art itself');
// ---------------------------------------------------------------------------
// npm run device:icons -- --bake --strict writes ui/deviceIcons.js from
// art/device-icons. What is asserted here is not that the drawings are good —
// nothing in Node can see them — but the two properties that fail SILENTLY and
// only on somebody else's device.
const KEYS = ['keyboard', ...PAD_BRANDS];
check('every key the screen can ask for has art',
  KEYS.every((k) => typeof DEVICE_ICONS[k] === 'string' && DEVICE_ICONS[k].startsWith('data:')),
  KEYS.filter((k) => !DEVICE_ICONS[k]).join(', ') || 'all five');
check('...and nothing is baked under a key nothing will ever look up',
  Object.keys(DEVICE_ICONS).every((k) => KEYS.includes(k)),
  Object.keys(DEVICE_ICONS).filter((k) => !KEYS.includes(k)).join(', '));

// A VIEWBOX, OR IT DOES NOT SCALE — and it scales in Chromium either way, which
// is the whole problem. An SVG with width/height and no viewBox has no
// statement about mapping its contents onto a box of another size; as a CSS
// background with `contain` Chromium infers one and iOS Safari need not, so the
// mark comes out as a 64px crop inside an 18px element on the devices these
// marks matter most on. Kenney's files ship without one; tidySvg in
// tools/device-icons.mjs adds it, and this is what says it did.
for (const k of KEYS) {
  const uri = DEVICE_ICONS[k] ?? '';
  if (!uri.startsWith('data:image/svg+xml')) continue;
  const svg = Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64').toString('utf8');
  check(`${k} carries a viewBox, so it scales off Chromium too`, /viewBox\s*=/.test(svg),
    svg.slice(0, 70));
}

// ---------------------------------------------------------------------------
section('Every device draws its own mark');
const ts = await import('../path/src/ui/teamSelect.js');
const { uiText } = await import('../path/src/uiTextTable.js');

function pad(index, id, { a = false, dpad = null } = {}) {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  if (a) buttons[0] = { pressed: true, value: 1 };
  if (dpad === 'right') buttons[15] = { pressed: true, value: 1 };
  return { index, connected: true, id, mapping: 'standard', axes: [0, 0, 0, 0], buttons };
}
const tap = (list) => { ts.updateTeamSelect(list); ts.updateTeamSelect(list.map((p) => pad(p.index, p.id))); };

ts.showTeamSelect({ parent: document.body, onStart() {}, onBack() {} });
const root = document.getElementById('svTeamSelect');
const poolChips = () => [...root.querySelectorAll('.sv-teams-pool .sv-teams-chip')];
const chipFor = (label) => poolChips().find((n) => n.getAttribute('aria-label') === label);
const markOf = (n) => n?.querySelector('.sv-teams-mark')?.style.backgroundImage ?? '';

// THE ROOM THIS SCREEN IS FOR: four controllers, none of them the same make.
tap([
  pad(0, 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'),
  pad(1, 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'),
  pad(2, 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)'),
  pad(3, 'Unknown Gamepad (Vendor: 0079 Product: 0006)'),
]);
{
  const chips = [0, 1, 2, 3].map((i) => chipFor(`${uiText('teamPad')} ${i + 1}`));
  check('all four pads are in the pool', chips.every(Boolean),
    poolChips().map((n) => n.getAttribute('aria-label')).join(' / '));
  check('every one of them draws a mark', chips.every((n) => !!markOf(n)));
  // THE POINT OF THE WHOLE THING. Four identical emoji told apart by a digit is
  // what this replaced, so four DIFFERENT marks is the property worth asserting
  // — not merely that each drew something.
  const marks = chips.map(markOf);
  check('...and no two of them are the same picture', new Set(marks).size === 4,
    `${new Set(marks).size} distinct of 4`);
  check('the number still follows the mark', chips.every((n, i) => n.textContent === String(i + 1)),
    chips.map((n) => JSON.stringify(n.textContent)).join(' '));

  const kb = chipFor(uiText('teamKeyboard'));
  check('the keyboard has a mark of its own', !!markOf(kb));
  check('...different from every controller in the room', !marks.includes(markOf(kb)));
  check('...and no number, because there is only ever one of it',
    kb?.textContent === '', JSON.stringify(kb?.textContent));
}

// ---------------------------------------------------------------------------
section('A key with no art falls back to the glyph it always drew');
// ---------------------------------------------------------------------------
// Unreachable today — all five keys are baked — and worth a test anyway: it is
// the branch a bake that dropped a key lands on, and the difference between a
// chip that reads a little plainer and a chip that is EMPTY. Forced by taking a
// key off the module the screen reads by name every render, so this walks the
// real branch in dressChip rather than a copy of it.
{
  const keep = DEVICE_ICONS.switch;
  delete DEVICE_ICONS.switch;
  tap([
    pad(0, 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'),
    pad(2, 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)'),
  ]);
  const sw = chipFor(`${uiText('teamPad')} 3`);
  check('the pad whose art has gone is back on the controller glyph',
    sw?.textContent === '\u{1F3AE}3', JSON.stringify(sw?.textContent));
  check('...with no empty mark element left behind', !sw?.querySelector('.sv-teams-mark'));
  // THE MIXED CASE, which is the argument for the fallback being per-key rather
  // than all-or-nothing: one brand with art beside one without, both legible.
  const xb = chipFor(`${uiText('teamPad')} 1`);
  check('...while the pad beside it keeps its mark', !!markOf(xb));
  DEVICE_ICONS.switch = keep;
}
ts.hideTeamSelect();

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
