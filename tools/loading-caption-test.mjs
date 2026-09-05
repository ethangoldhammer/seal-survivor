// ============================================================================
// THE RESUME HAS TO LOOK DIFFERENT FROM A RESTART.
//
// systems/runSnapshot.js gives the player their run back, but the seconds they
// wait for it are the SAME seconds a cold boot takes — same bar, same vortex,
// same nothing-on-screen. Without the caption the safety net's best case still
// reads as the app restarting itself: the run does come back, but only after
// the player has already decided it didn't.
//
// So the caption is not decoration, it is the feature, and it is exactly the
// kind of thing that survives a refactor as a dead branch nobody notices —
// `resuming` quietly stops being passed, the line stops rendering, and every
// other test in the suite still passes. This is the one that wouldn't.
//
// jsdom rather than tools/dom-stub.mjs: showLoading builds real elements and
// reads innerHTML back, and the stub has no 2D canvas context (the module
// takes one on the first line of its body and would throw before rendering
// anything). The context is stubbed here to the handful of calls the vortex
// makes.
//
// RUN WITHOUT `--import ./tools/vite-loader.mjs`. jsdom loads through a CJS
// require chain that the loader hooks break (`request for
// './fallback/encoding.js' is not in cache`), so jsdom has to be imported
// FIRST and the hooks registered afterwards — which is why the loader is a
// dynamic import in the middle of this file rather than a flag on the command
// line. uiTextTable.js needs it, for `./uiText.csv?raw`.
// ============================================================================

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
});

// The 2D context, to the depth ui/loading.js actually uses it. Deliberately
// not a no-op Proxy: a Proxy answers every call and would hide the day the
// module reaches for something a real context has and this one does not.
const ctx2d = {
  clearRect() {}, beginPath() {}, arc() {}, fill() {}, fillRect() {},
  setTransform() {}, closePath() {}, rect() {}, roundRect() {}, ellipse() {},
  translate() {}, scale() {}, clip() {},
  moveTo() {}, lineTo() {}, stroke() {}, save() {}, restore() {},
  createLinearGradient: () => ({ addColorStop() {} }),
  set fillStyle(_v) {}, get fillStyle() { return ''; },
  set strokeStyle(_v) {}, get strokeStyle() { return ''; },
  set lineWidth(_v) {}, get lineWidth() { return 1; },
  set globalAlpha(_v) {}, get globalAlpha() { return 1; },
  set shadowBlur(_v) {}, get shadowBlur() { return 0; },
  set shadowColor(_v) {}, get shadowColor() { return ''; },
};
dom.window.HTMLCanvasElement.prototype.getContext = () => ctx2d;
// The lane has no layout in jsdom, so the vortex would divide by a zero width.
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { get: () => 340 });
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { get: () => 48 });
dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
  width: 340, height: 48, top: 0, left: 0, right: 340, bottom: 48, x: 0, y: 0,
});
dom.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

globalThis.window = dom.window;
globalThis.document = dom.window.document;
// NOT jsdom's performance. Its Performance delegates to the global one, so
// assigning it here recurses until the stack blows. Node's own is close enough.
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.devicePixelRatio = 2;

// The Vite hooks, now that jsdom is in. See the header.
await import('./vite-loader.mjs');

const { showLoading } = await import('../path/src/ui/loading.js');
const { uiText } = await import('../path/src/uiTextTable.js');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) return;
  failures += 1;
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

const CAP = '.sv-load-cap';

// --- an ordinary boot -------------------------------------------------------
const plain = showLoading();
check('a normal boot has no caption', !document.querySelector(CAP),
  'the line would then appear on every launch, which makes it mean nothing');
check('the bar is up either way', !!document.querySelector('.sv-load-lane'));
plain.remove();
check('remove() takes the screen down', !document.querySelector('.sv-load'));

// --- coming back from a kill ------------------------------------------------
const resumed = showLoading({ resuming: true });
const cap = document.querySelector(CAP);
check('a resume says so', !!cap,
  'without this the net gives the run back and still looks like a restart');
if (cap) {
  const expected = uiText('loadResuming');
  check('the words come from uiText.csv', cap.textContent === expected,
    `rendered "${cap.textContent}" but the table says "${expected}"`);
  // A missing row renders its own id (see uiTextTable.uiText), which is the
  // designed failure — loud, not blank. Assert it is not THAT, or a deleted
  // row would pass every check above.
  check('the row exists', cap.textContent !== 'loadResuming',
    'uiText fell back to the id, so uiText.csv has no loadResuming row');
  check('the caption is short enough not to wrap on a phone',
    cap.textContent.length <= 48, `${cap.textContent.length} characters`);
}
// The composition must not move: same lane, same place, caption stacked out of
// flow underneath. A caption inside the lane's layout would make the two
// screens different pictures, which is the opposite of the intent.
check('the caption lives under the lane, not in the bar',
  cap?.parentElement?.className === 'sv-load-lane');
resumed.remove();
check('the resume screen comes down too', !document.querySelector('.sv-load'));

if (failures) {
  console.error(`\n[loading-caption] ${failures} check${failures === 1 ? '' : 's'} failed`);
  process.exit(1);
}
console.log('[loading-caption] a resumed boot says it is a resume.');
