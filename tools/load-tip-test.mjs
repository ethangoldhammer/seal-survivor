// ============================================================================
// THE QUICK TIPS ON THE LOADING SCREEN — loadTips.csv, loadTipTable.js and the
// rotation in ui/loading.js.
//
// Four failures this is written against, all of which leave a green suite:
//
//   1. THE ROTATION STOPS. A tip appears, and the timer that was supposed to
//      turn it over never fires again — a boot that lasts twelve seconds shows
//      one line for eleven of them. Nothing throws, nothing is blank, and it
//      looks exactly like a screen that only ever had one tip.
//   2. THE SAME TIP TWICE. An independent roll per slot repeats itself about
//      half the time on a four-row table, and the repeat is thirty seconds
//      after the original with nothing else on screen to look at.
//   3. A BRACE ON THE GLASS. `{clap}` reaching the screen unresolved, which is
//      the one sentence a player reads most carefully.
//   4. A PHONE TOLD TO PRESS A KEY. A row naming a key binding with no
//      textTouch — invisible to whoever is editing the CSV on a laptop, which
//      is everybody.
//   5. THE TEXT PANEL SILENTLY LOSING. The two lines are Text panel roles now
//      (`loadTip`, `loadCaption`), and loading.js still ships its own
//      stylesheet for the layout. Leave one type declaration in there, or file
//      the sheet after the role sheet instead of before it, and every row in
//      the panel writes CONFIG, saves to disk and changes nothing on screen —
//      the exact failure ui/typography.js's header describes for the font
//      picker, which went unnoticed for months.
//
// jsdom rather than tools/dom-stub.mjs, and the clock is faked, for the
// reasons documented in tools/loading-caption-test.mjs and below. RUN WITHOUT
// `--import ./tools/vite-loader.mjs` — see that file's header.
// ============================================================================

import { JSDOM } from 'jsdom';

// `url` is not decoration: settings.js reaches for localStorage, and jsdom
// refuses it on the default about:blank ("opaque") origin with a SecurityError
// thrown before a single check runs.
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});

const ctx2d = {
  clearRect() {}, beginPath() {}, arc() {}, fill() {}, fillRect() {},
  setTransform() {}, closePath() {}, rect() {}, roundRect() {}, ellipse() {},
  translate() {}, scale() {}, clip() {},
  moveTo() {}, lineTo() {}, stroke() {}, save() {}, restore() {},
  createLinearGradient: () => ({ addColorStop() {} }),
  createRadialGradient: () => ({ addColorStop() {} }),
  set fillStyle(_v) {}, get fillStyle() { return ''; },
  set strokeStyle(_v) {}, get strokeStyle() { return ''; },
  set lineWidth(_v) {}, get lineWidth() { return 1; },
  set globalAlpha(_v) {}, get globalAlpha() { return 1; },
};
dom.window.HTMLCanvasElement.prototype.getContext = () => ctx2d;
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { get: () => 340 });
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { get: () => 48 });
dom.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.devicePixelRatio = 2;
globalThis.localStorage ??= dom.window.localStorage;
// applyTypography dispatches a CustomEvent on the document, and jsdom checks
// the brand: Node's own CustomEvent is a different class and is rejected with
// "parameter 1 is not of type 'Event'" from inside the dispatch.
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.Event = dom.window.Event;

// --- a clock we can wind ----------------------------------------------------
// The rotation is on timers rather than on the rAF loop ON PURPOSE (it has to
// keep turning under reduced motion, where the loop does not run), so a real
// wait would make this test six seconds long per tip and flaky on a loaded
// machine. ui/loading.js calls a bare `setTimeout`, which resolves against
// globalThis at call time — so replacing it here is enough, and jsdom's own
// window timers are left alone for anything else that wants them.
let clockNow = 0;
let nextTimerId = 0;
const timers = new Map();
globalThis.setTimeout = (fn, ms = 0) => {
  const id = ++nextTimerId;
  timers.set(id, { at: clockNow + ms, fn });
  return id;
};
globalThis.clearTimeout = (id) => { timers.delete(id); };

function advance(ms) {
  const end = clockNow + ms;
  for (;;) {
    let pick = null;
    for (const [id, t] of timers) {
      if (t.at > end) continue;
      if (!pick || t.at < pick.t.at || (t.at === pick.t.at && id < pick.id)) pick = { id, t };
    }
    if (!pick) break;
    clockNow = pick.t.at;
    timers.delete(pick.id);
    pick.t.fn();
  }
  clockNow = end;
}

await import('./vite-loader.mjs');

const { parseLoadTipCsv, tipOrder, tipsForDevice } = await import('../path/src/loadTipTable.js');
const { checkBindingText, fillBindings, namesForeignHardware } = await import('../path/src/systems/bindingText.js');
const { textForDevice } = await import('../path/src/deviceText.js');
const { showLoading } = await import('../path/src/ui/loading.js');
const { initTypography } = await import('../path/src/ui/typography.js');
const { TEXT_ROLES } = await import('../path/src/textRoles.js');
const { readFile } = await import('node:fs/promises');

// The role sheet has to exist before the screen builds its own, which is the
// order main.js boots in — see the note on initTypography in boot().
initTypography();

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures += 1;
  console.error(`  ✗    ${name}${detail ? ` — ${detail}` : ''}`);
}

const CSV = new URL('../path/src/loadTips.csv', import.meta.url);
const SHIPPING = parseLoadTipCsv(await readFile(CSV, 'utf8'), () => {});

// --- the shipping table -----------------------------------------------------
console.log('\nthe table');
check('loadTips.csv has tips in it', SHIPPING.length > 0, `${SHIPPING.length} rows`);
// The bag only earns its keep once there is something to shuffle, and a
// one-row table would make every check below vacuous.
check('...more than one, so the rotation is a rotation', SHIPPING.length > 1);
check('every row has words', SHIPPING.every((t) => t.text.length > 0));
check('no tip is long enough to overrun two lines on a phone',
  SHIPPING.every((t) => t.text.length <= 96),
  SHIPPING.map((t) => t.text.length).join(', '));

// The failure this catches is a phone being told to press a key it does not
// have — invisible to whoever is editing the CSV on a laptop. Same check the
// callout table runs at boot, on the same resolver.
console.log('\na tip that names a button says it to the right hands');
const bindingWarnings = [];
checkBindingText('loadTips', SHIPPING, (m) => bindingWarnings.push(m));
check('every device is told about hardware it is holding', bindingWarnings.length === 0,
  bindingWarnings.join('\n         '));

// THE PROSE HALF, unit-tested, because it is a word list and a word list is
// the kind of thing that quietly stops matching. The `{bumper}` case is the
// one that matters most: it contains the word "bumper" and is CORRECT on every
// device, so a check that scanned the raw cell would flag exactly the rows
// that did the right thing — and the obvious fix (delete the word from the
// list) would blind it to the prose it exists for.
check('"left stick" is wrong on a keyboard',
  namesForeignHardware('Left stick to swim', 'kbm') === 'a controller');
check('...and right on a pad', namesForeignHardware('Left stick to swim', 'pad') === null);
check('"tap" is wrong on a pad', namesForeignHardware('Tap the seal', 'pad') === 'a touchscreen');
check('...and right on a touchscreen', namesForeignHardware('Tap the seal', 'touch') === null);
check('a {bumper} token is not prose about a bumper',
  namesForeignHardware('Squeeze {bumper} to charge', 'kbm') === null,
  'the token is the device-correct construction — flagging it punishes the right answer');
check('an ordinary tip trips nothing',
  namesForeignHardware('Hoover up your chum before the crabs get to it!', 'kbm') === null);

// The token, resolved the way the screen resolves it. Direct rather than
// through the rotation: which tip comes up when is the bag's business, and a
// brace check that depends on the shuffle is a brace check that can pass by
// never drawing the row that has one.
const clapRow = SHIPPING.find((t) => /\{\w+\}/.test(t.text));
if (clapRow) {
  const resolved = fillBindings(textForDevice(clapRow, 'kbm'));
  check('a control token resolves to a key the player has', !/[{}]/.test(resolved), resolved);
  check('...and to something, not to nothing', resolved.length >= clapRow.text.length - 8, resolved);
}

// --- the device narrowing ---------------------------------------------------
console.log('\nthe device narrowing');
const KBM_ONLY = [
  { id: 'a', text: 'kbm only', deviceText: {}, devices: ['kbm'], weight: 1 },
  { id: 'b', text: 'everyone', deviceText: {}, devices: null, weight: 1 },
];
check('a kbm row is out on a phone',
  tipsForDevice(KBM_ONLY, 'touch').map((t) => t.id).join() === 'b');
check('...and in on a keyboard',
  tipsForDevice(KBM_ONLY, 'kbm').map((t) => t.id).join() === 'a,b');

// --- the bag ----------------------------------------------------------------
console.log('\nthe bag');
const bag = tipOrder(SHIPPING, mulberry(7));
check('one pass covers every tip exactly once',
  bag.length === SHIPPING.length && new Set(bag.map((t) => t.id)).size === SHIPPING.length);
// A shuffle that always returns file order is a shuffle that is not running,
// and it passes the check above every single time.
let sawAShuffle = false;
for (let seed = 1; seed <= 40 && !sawAShuffle; seed += 1) {
  const order = tipOrder(SHIPPING, mulberry(seed)).map((t) => t.id).join();
  if (order !== SHIPPING.map((t) => t.id).join()) sawAShuffle = true;
}
check('...in an order that actually varies', sawAShuffle,
  sawAShuffle ? '' : 'forty seeds all produced file order, so nothing is being shuffled');

const HEAVY = [
  { id: 'light', text: 'l', deviceText: {}, devices: null, weight: 1 },
  { id: 'heavy', text: 'h', deviceText: {}, devices: null, weight: 9 },
];
let heavyFirst = 0;
const rnd = mulberry(3);
for (let i = 0; i < 400; i += 1) if (tipOrder(HEAVY, rnd)[0].id === 'heavy') heavyFirst += 1;
check('weight buys an earlier slot, not a louder one', heavyFirst > 280 && heavyFirst < 400,
  `${heavyFirst}/400 boots opened on the 9x tip`);
const ZEROED = HEAVY.map((t) => ({ ...t, weight: 0 }));
check('every weight zero is a broken file, not an instruction to be silent',
  tipOrder(ZEROED, mulberry(1)).length === 2);

// --- the two lines are Text panel roles -------------------------------------
console.log('\nthe type belongs to the Text panel');
const ROLE_SELECTORS = { loadTip: '.sv-load-tip-line', loadCaption: '.sv-load-cap' };
for (const [key, selector] of Object.entries(ROLE_SELECTORS)) {
  const role = TEXT_ROLES.find((r) => r.key === key);
  check(`${key} is a role`, !!role, 'without one the line is unreachable from Y');
  check(`...pointed at the markup loading.js writes`, role?.selector === selector,
    `${role?.selector} vs ${selector}`);
}

// THE DISJOINTNESS CONTRACT. loading.js owns the layout and the roles own the
// type; a property in both places is a control that looks live and is not.
const LOADING_SRC = await readFile(new URL('../path/src/ui/loading.js', import.meta.url), 'utf8');
const SHEET = LOADING_SRC.slice(LOADING_SRC.indexOf('const STYLES = `') + 16,
  LOADING_SRC.indexOf('`;', LOADING_SRC.indexOf('const STYLES = `')));
// Comments stripped first: the sheet explains the contract in prose that names
// the very properties it must not declare.
const DECLS = SHEET.replace(/\/\*[\s\S]*?\*\//g, '');
const OWNED_BY_ROLES = [
  'font-family', 'font-size', 'font-weight', 'letter-spacing',
  'text-transform', 'text-shadow', 'color',
];
for (const prop of OWNED_BY_ROLES) {
  // Word-bounded, so `background-color` is not read as `color` and
  // `font-size` is not matched inside `font-family`.
  const re = new RegExp(`(^|[;{\\s])${prop}\\s*:`, 'm');
  check(`the screen's own sheet declares no ${prop}`, !re.test(DECLS),
    'it would beat the panel, which is filed after it');
}
check('...and no `font:` shorthand either', !/(^|[;{\s])font\s*:/m.test(DECLS),
  'the shorthand sets family, size and weight at once');

// --- the screen -------------------------------------------------------------
console.log('\nthe screen');
const LINE = '.sv-load-tip-line';
const screen = showLoading({ tips: { device: 'kbm', random: mulberry(11) } });
const lineEl = document.querySelector(LINE);
check('the tip box is mounted above the bar', !!lineEl);

// THE ORDER, which is the whole mechanism — there is no !important anywhere.
const sheets = [...document.head.querySelectorAll('style')];
const roleAt = sheets.findIndex((el) => el.id === 'svTypographyRoles');
const ownAt = sheets.findIndex((el) => el.textContent.includes('.sv-load-lane'));
check('the screen files its stylesheet UNDER the role sheet', ownAt >= 0 && ownAt < roleAt,
  `own sheet at ${ownAt}, roles at ${roleAt}`);
// And the rule really reaches the element, resolved by jsdom's cascade rather
// than asserted off the text of the sheet.
const computed = document.defaultView.getComputedStyle(lineEl);
check('...so the role sets the family', computed.fontFamily === 'var(--sv-font)',
  computed.fontFamily || '(nothing)');
check('...and the size', /^calc\(15px \* var\(--sv-scale\)\)$/.test(computed.fontSize),
  computed.fontSize || '(nothing)');
check('...inside the lane, so the bar stays centred',
  lineEl?.parentElement?.parentElement?.className === 'sv-load-lane');
check('nothing is said on the first frame', lineEl?.textContent === '',
  'a warm reload would flash half a sentence and then vanish');

advance(900);
const first = lineEl.textContent;
check('a tip arrives once the boot is clearly not instant', first.length > 0, first);
check('...visible, not merely present', lineEl.classList.contains('is-up'));
check('no brace reached the glass', !/[{}]/.test(first), first);
// Drive a whole cycle and collect what was said.
const seen = [first];
for (let i = 1; i < SHIPPING.length; i += 1) {
  const before = lineEl.textContent;
  advance(5000);                       // the hold runs out
  check(`tip ${i} fades before the next one is written`,
    !lineEl.classList.contains('is-up') && lineEl.textContent === before);
  advance(420);                        // the crossfade
  check(`tip ${i + 1} arrives`, lineEl.classList.contains('is-up') && lineEl.textContent !== '');
  seen.push(lineEl.textContent);
}
check('a boot long enough to show the table shows all of it, once',
  new Set(seen).size === SHIPPING.length,
  seen.join(' / '));

// The bag refills rather than stopping — failure 1 at the top of this file.
advance(5000 + 420);
check('the rotation keeps going past the end of the table',
  lineEl.classList.contains('is-up') && lineEl.textContent.length > 0);
check('...and does not open the new bag on the line still on screen',
  lineEl.textContent !== seen[seen.length - 1],
  `${seen[seen.length - 1]} -> ${lineEl.textContent}`);

const pending = timers.size;
screen.remove();
check('remove() takes the tips down with the bar', !document.querySelector(LINE));
check('...and cancels the pending rotation', timers.size < pending,
  'a live timer would fire into a detached node for the rest of the session');

// --- one tip, nothing to rotate to ------------------------------------------
// The degenerate table, because it is what an author leaves behind while they
// are writing: disabling three of four rows must not make the fourth blink
// itself out and back in on the same words.
console.log('\none tip and nowhere to turn');
const solo = showLoading({ tips: { device: 'kbm', rows: [SHIPPING[0]], random: mulberry(2) } });
advance(900);
const soloLine = document.querySelector(LINE);
const soloText = soloLine?.textContent ?? '';
advance((5000 + 420) * 3);
check('a lone tip stays up rather than flickering',
  !!soloLine?.classList.contains('is-up') && soloLine.textContent === soloText, soloText);
solo.remove();

// A table this device can see nothing in adds no box at all, rather than an
// empty one holding 2.8em of space above the bar for the whole boot.
const none = showLoading({ tips: { device: 'touch', rows: [{ id: 'k', text: 'kbm', deviceText: {}, devices: ['kbm'], weight: 1 }] } });
advance(2000);
check('a device with no tips gets no empty box', !document.querySelector('.sv-load-tip'));
none.remove();

// A tiny seeded PRNG, so the order above is the same on every machine. See the
// note in MEMORY about seeding spawn harnesses: an unseeded shuffle test is a
// test that fails on a Tuesday.
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

if (failures) {
  console.error(`\n[load-tips] ${failures} check${failures === 1 ? '' : 's'} failed`);
  process.exit(1);
}
console.log('\nall good');
