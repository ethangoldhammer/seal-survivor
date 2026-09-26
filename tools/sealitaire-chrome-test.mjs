#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:sealitairechrome
//
// THE TABLE'S OWN CHROME, on the device it is for and the suite cannot run.
// A phone held sideways is the whole reason the fullscreen button exists
// there: mobile Safari keeps a bar over the bottom of the page and sizes the
// page around it, so the board is laid out correctly into a viewport shorter
// than the glass and the foot strip sits under browser furniture. The table
// cannot see that from the inside, and neither can a laptop.
//
// So what is checked here is the wiring, which is where it can actually go
// wrong:
//
//   THE BUTTON IS THERE AT ALL, and mounted before the .riv is fetched —
//   showSealitaire awaits a 22MB download partway through, and a button
//   appended after that await is a control that does not exist for the
//   several seconds a phone spends waiting, which is exactly when somebody
//   reaches for it.
//
//   IT IS NOT DRAWN ON A SHELL THAT CANNOT DO IT. Element fullscreen was
//   absent outright on iPhone for years — the method missing, not refused —
//   and a button drawn on faith is a dead control on the device that wants
//   it most. systems/fullscreen.js answers that question; this checks the
//   table asks it.
//
//   CLOSING GIVES THE SCREEN BACK. Leaving the table fullscreen drops the
//   player into the menu with no browser chrome and nothing to say why, and
//   the teardown is in hideSealitaire rather than in the Back handler
//   because Back is only one of the ways out — the menu closes the table
//   directly.
//
// The Rive import inside showSealitaire is dynamic and happens after all of
// this, so none of it needs a runtime, a canvas or the 22MB file: the mount
// is called and not awaited, and the DOM is read on the same tick.
// ---------------------------------------------------------------------------
// JSDOM FIRST, THE LOADER SECOND, and that order is the harness recipe rather
// than a preference: jsdom loads through CJS, and registering the vite loader
// ahead of it breaks that chain with ERR_VM_MODULE_LINK_FAILURE from inside
// html-encoding-sniffer, which names neither jsdom nor this file. The loader
// is needed at all because the table's chrome reads uiText.csv?raw.
import { JSDOM } from 'jsdom';
await import('./vite-loader.mjs');

// THE MOUNT IS DELIBERATELY NOT AWAITED — everything checked here happens
// before its first await, and awaiting it would mean standing up a WebGL
// runtime and a 22MB file to look at three DOM nodes. What that leaves is a
// promise still in flight when the checks are done: it goes on to
// `import('@rive-app/webgl2')`, which has no ESM build Node can link, and an
// unhandled rejection would exit non-zero over a suite that passed.
process.on('unhandledRejection', (err) => {
  const why = String(err?.message ?? err);
  if (/@rive-app|RuntimeLoader|WebGL|canvas/i.test(why)) return;
  throw err;
});

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.fetch = () => new Promise(() => {});   // the .riv never arrives; we never await it
dom.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });

const exits = [];
/** Hand the document a fullscreen API, or take it away entirely. */
function setApi(present, { active = false } = {}) {
  const el = document.documentElement;
  if (!present) {
    delete el.requestFullscreen; delete el.webkitRequestFullscreen;
    document.fullscreenEnabled = false; document.webkitFullscreenEnabled = false;
    delete document.exitFullscreen; delete document.webkitExitFullscreen;
    document.fullscreenElement = null; document.webkitFullscreenElement = null;
    return;
  }
  el.requestFullscreen = () => Promise.resolve();
  document.fullscreenEnabled = true;
  document.exitFullscreen = () => { exits.push('exit'); document.fullscreenElement = null; return Promise.resolve(); };
  document.fullscreenElement = active ? el : null;
}

const { showSealitaire, hideSealitaire, tableDpr } = await import('../path/src/ui/sealitaireTable.js');
const findBtn = () => document.querySelector('.sv-sealitaire button[aria-label], .sv-sealitaire .sv-fsbtn, .sv-sealitaire button:not(.sv-sealitaire-back)');

console.log('the fullscreen button on the table:');

// 1. A shell that CAN: the button is up before the .riv is asked for.
setApi(true);
showSealitaire({});
const withApi = findBtn();
check('mounted, and before the .riv download is awaited', Boolean(withApi),
  withApi ? `<${withApi.tagName.toLowerCase()}> in the table's own wrap` : 'no button in .sv-sealitaire');
check('it is in the table\'s layer, so it comes down with it',
  Boolean(withApi && withApi.closest('.sv-sealitaire')));
// Opposite corner from Back, which sits top-left.
check('it sits clear of Back', Boolean(withApi && withApi.style.left === 'auto' && withApi.style.right));

// 2. Closing gives the screen back, through the one teardown.
document.fullscreenElement = document.documentElement;
hideSealitaire();
check('closing the table leaves fullscreen', exits.length === 1, `${exits.length} exit call(s)`);
check('and the whole layer is gone', document.querySelector('.sv-sealitaire') === null);

// 3. A shell that CANNOT: no dead control.
setApi(false);
exits.length = 0;
showSealitaire({});
check('no button on a shell with no fullscreen API', findBtn() === null);
hideSealitaire();
check('and closing there asks nothing of the missing API', exits.length === 0);

// ---------------------------------------------------------------------------
console.log('\nthe resolution the table renders at:');
// ---------------------------------------------------------------------------
// The other half of a phone that cannot read its own cards. The board lays
// out in CSS pixels, so a landscape iPhone puts the card at 47% of its design
// size and the corner's rank at about 7px; rendering that at 2x on a 3x
// display throws away a third of the resolution the glass has, on the one
// element that is already at the edge of legible. LAYOUT.cornerScale makes
// the glyph bigger; this is whether it is drawn sharp.
//
// The guard that has to survive raising the cap is the AREA one — the table
// is eight full-screen shader passes a frame, and the case it is there for is
// a fullscreen 5K window, not a phone. So both ends are asserted: a small
// viewport gets everything the display has, and a large one is still held.
const asCanvas = (w, h) => ({ getBoundingClientRect: () => ({ width: w, height: h }) });
const at = (dpr, w, h) => {
  dom.window.devicePixelRatio = dpr;
  return tableDpr(asCanvas(w, h));
};

// A landscape iPhone, which is the whole reason this moved.
check('a 3x phone renders at 3x', Math.abs(at(3, 852, 393) - 3) < 1e-9, `${at(3, 852, 393)}`);
check('...which is fewer device pixels than a retina laptop already pays',
  852 * 393 * 9 < 1512 * 982 * 4,
  `${Math.round(852 * 393 * 9 / 1e5) / 10}M vs ${Math.round(1512 * 982 * 4 / 1e5) / 10}M`);
// A 2x laptop is untouched: it was never the case the cap was aimed at.
check('a 2x laptop is unchanged', Math.abs(at(2, 1512, 982) - 2) < 1e-9, `${at(2, 1512, 982)}`);
// The area guard still bites where it always did.
const bigWindow = at(2, 2560, 1440);
check('a 5K window is still held under the pixel budget', bigWindow < 2,
  `${Math.round(bigWindow * 1000) / 1000}x on 2560x1440`);
check('...and that budget is 3840x2160 device pixels',
  Math.abs(2560 * bigWindow * (1440 * bigWindow) - 3840 * 2160) < 1,
  `${Math.round(2560 * bigWindow * 1440 * bigWindow / 1e6)}M`);
// A panel that reports more than 3 is capped: a 4x phone is 78% more pixels
// again for a difference nobody can see, and that IS the case the ratio cap
// is for now.
check('a 4x panel is capped at 3', Math.abs(at(4, 852, 393) - 3) < 1e-9, `${at(4, 852, 393)}`);
// A canvas with no box yet — the first call happens before layout — must not
// divide by zero and must not return 0, which would build zero-sized targets.
dom.window.devicePixelRatio = 3;
check('a canvas with no box yet still answers', tableDpr(asCanvas(0, 0)) === 3);

console.log('');
if (failures) { console.error(`${failures} FAILED`); process.exit(1); }
console.log('sealitaire chrome: all checks passed');
