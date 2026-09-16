#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:dock
//
// THE F PANEL DOCKED TO THE RIGHT EDGE — ui/workbench.js.
//
// The panel ships two shapes now: full bleed, which it has always had, and a
// column against the right edge so the pitch it is tuning stays on screen
// beside it. Both are the SAME DOM — one tree, shown through different CSS —
// and that is the decision this file exists to protect. A docked mode that
// rebuilt the panes would be a second layout to keep in step with the first,
// and the one that is not open is the one that rots.
//
// WHAT THIS COVERS, and every one of these is a failure you can look straight
// at without seeing:
//
//   THE ELEMENTS ARE THE SAME ONES. If docking ever re-parents or re-creates a
//   pane, every els.* reference and every listener bound in initWorkbench is
//   still pointing at the old node — the panel draws perfectly and no control
//   does anything. Checked by identity, before and after.
//
//   THE MODE IS A SET, NOT A TOGGLE. It is remembered between runs, so a
//   harness that clicks its way to a state starts from wherever the last
//   session left the panel and then grades the opposite one. The look page
//   beside this (tools/looks/workbench-dock.js) failed 28 checks that way
//   before setWorkbenchDocked existed.
//
//   THE STRIP BORROWS ITS WORDS. Four tabs whose labels are read off the DOM —
//   the rail's heading, the live detail title, the dock's own two tabs — so
//   there is no second copy of a label to fall out of date, and no new
//   player-facing string in a panel whose every word is Ethan's (CLAUDE.md).
//   A tab that silently starts rendering "undefined" is the tell.
//
//   THE LIBRARY PAIR SHARE AN ELEMENT. 'lib' and 'live' are two tabs onto one
//   dock, so picking one out here has to move the dock's own inner switch as
//   well or the strip and the pane say different things.
//
//   FULL BLEED MUST NOT HAVE MOVED. The mode is new; the panel is not.
//
// WHAT IT CANNOT COVER: geometry. jsdom has no layout engine, so every rect
// here is 0x0 and a stylesheet that never matched a single element passes this
// file clean. Widths, the pane that fills the cell, the card column and the
// drag handle are measured in a real browser by `npm run looks:dock`.
//
// Load order is the jsdom recipe: jsdom, then the loader, then game modules.
// Run WITHOUT --import for that reason.
//
//   node tools/workbench-dock-test.mjs
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
globalThis.Image = dom.window.Image;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
dom.window.HTMLCanvasElement.prototype.getContext = () => null;

// BEFORE our own hooks below. registerHooks runs newest-first and the loader
// claims every `?raw`/`?url` import, so registering it after us would swallow
// the stubs. See the note in tools/vite-loader.mjs.
await import('./vite-loader.mjs');

const { registerHooks } = await import('node:module');
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@rive-app/canvas' || spec === '@rive-app/webgl2') return { url: 'stub:rive', format: 'module', shortCircuit: true };
    if (spec.endsWith('.riv?url') || spec.endsWith('.wasm?url')) {
      return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === 'stub:rive') {
      return { format: 'module', shortCircuit: true, source: 'export class Rive { constructor(){} on(){} play(){} cleanup(){} } export class RiveFile { constructor(){} on(){} cleanup(){} } export const decodeImage = async () => ({ unref(){} }); export const EventType = {}; export const Layout = class {}; export const Fit = {}; export const Alignment = {}; export const RuntimeLoader = { setWasmUrl(){} };' };
    }
    if (url === 'stub:rivurl') return { format: 'module', shortCircuit: true, source: 'export default "stub.riv";' };
    return next(url, ctx);
  },
});
globalThis.fetch = async () => ({ ok: false, status: 404 });

const { initWorkbench, setWorkbenchVisible, setWorkbenchDocked, workbenchDockState } =
  await import('../path/src/ui/workbench.js');

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails++;
};
const section = (t) => console.log(`\n${t}`);

initWorkbench();
setWorkbenchVisible(true);

const panel = document.querySelector('.sv-wb');
const q = (sel) => document.querySelector(sel);
const tabs = () => [...document.querySelectorAll('.sv-wb-panetabs .sv-wb-tab')];
const tabFor = (pane) => tabs().find((t) => t.dataset.pane === pane);
const labels = () => tabs().map((t) => t.textContent);

// ---------------------------------------------------------------------------
section('FULL BLEED — unchanged');
setWorkbenchDocked(false);
check('the panel mounted', !!panel);
check('it is not docked', !panel.classList.contains('sv-wb-docked'));
check('the three panes are all in the tree', !!q('.sv-wb-rail') && !!q('.sv-wb-main') && !!q('.sv-wb-dock'));
check('the dock keeps its own tabs', !!q('.sv-wb-dock > .sv-wb-tabs'));
// The strip and the handle exist in BOTH modes — CSS hides them, not a branch.
// A mode that builds its own furniture is a mode with a code path that only
// ever runs when somebody is looking at it.
check('the docked strip is built even here', tabs().length === 4, `${tabs().length} tabs`);
check('...and the width handle', !!q('.sv-wb-grip'));

// The identity check. Held across the toggle below.
const before = {
  rail: q('.sv-wb-rail'), main: q('.sv-wb-main'), dock: q('.sv-wb-dock'),
  cols: q('.sv-wb-cols'), list: q('.sv-wb-ev'), feed: q('.sv-wb-feed'),
};

// ---------------------------------------------------------------------------
section('DOCKED');
setWorkbenchDocked(true);
check('the class is on', panel.classList.contains('sv-wb-docked'));
check('the state agrees', workbenchDockState().docked === true);
check('every pane is the SAME element, not a rebuild',
  before.rail === q('.sv-wb-rail') && before.main === q('.sv-wb-main')
  && before.dock === q('.sv-wb-dock') && before.cols === q('.sv-wb-cols')
  && before.feed === q('.sv-wb-feed'));
check('...including the rail rows', before.list === q('.sv-wb-ev'));
// display:none is the whole mechanism. If the rule ever loses its selector the
// panel shows three panes stacked on one grid cell, which is not subtle — but
// the class is what the stylesheet keys on and it is worth naming here.
check('the panel carries a chosen pane', !!panel.dataset.pane, panel.dataset.pane);

// ---------------------------------------------------------------------------
section('THE STRIP AND ITS BORROWED WORDS');
check('the rail heading is the first tab', labels()[0] === q('.sv-wb-railhead h2').textContent,
  `"${labels()[0]}"`);
check('the dock’s own two labels are the last two',
  labels()[2] === q('.sv-wb-dock > .sv-wb-tabs').children[0].textContent
  && labels()[3] === q('.sv-wb-dock > .sv-wb-tabs').children[1].textContent,
  labels().join(' · '));
check('no tab is blank or undefined', labels().every((l) => l && l !== 'undefined'), labels().join(' · '));

// The middle tab is the live title, and the point of it is that it FOLLOWS.
tabFor('feel').click();
const goalRow = [...document.querySelectorAll('.sv-wb-ev')].find((r) => r.textContent.includes('The goal'));
check('the goal has a row to pick', !!goalRow);
goalRow.click();
check('picking it jumps to the cards', workbenchDockState().pane === 'tune', workbenchDockState().pane);
check('...and the middle tab says what you are looking at', labels()[1] === q('.sv-wb-title h1').textContent,
  `"${labels()[1]}"`);
const killRow = [...document.querySelectorAll('.sv-wb-ev')].find((r) => r.textContent.trim() === 'kill');
killRow.click();
check('...and follows to the next thing', labels()[1] === 'kill', `"${labels()[1]}"`);

// ---------------------------------------------------------------------------
section('THE FOUR PANES');
for (const pane of ['feel', 'tune', 'lib', 'live']) {
  tabFor(pane).click();
  check(`"${tabFor(pane).textContent}" is selected`,
    panel.dataset.pane === pane && tabFor(pane).classList.contains('on'));
  check('...and it is the only one lit', tabs().filter((t) => t.classList.contains('on')).length === 1);
}
// Library and Live are one element behind two tabs.
const innerOn = () => [...q('.sv-wb-dock > .sv-wb-tabs').children].findIndex((t) => t.classList.contains('on'));
tabFor('lib').click();
check('Library drives the dock’s own switch', innerOn() === 0, `inner tab ${innerOn()}`);
tabFor('live').click();
check('...and so does Live', innerOn() === 1, `inner tab ${innerOn()}`);
check('the library pane really gave way to the feed',
  !q('.sv-wb-pane.on .sv-wb-liblist') && !!q('.sv-wb-pane.on .sv-wb-feed'));

// ---------------------------------------------------------------------------
section('WIDTH');
// The clamp, not the drag — the drag is pointer geometry and belongs in the
// browser. What matters here is that neither end can run away: a dock over most
// of the window is not a dock, and one narrower than a card is a column of
// clipped controls.
const root = document.documentElement;
const cssWidth = () => parseInt(root.style.getPropertyValue('--sv-wb-w'), 10);
check('a width is published to the root, where the hint can read it too', cssWidth() > 0, `${cssWidth()}px`);
setWorkbenchDocked(true);
const start = workbenchDockState().width;
check('it opens at a sane default', start >= 338 && start <= 520, `${start}px`);

// ---------------------------------------------------------------------------
section('AND BACK');
setWorkbenchDocked(false);
check('the class comes off', !panel.classList.contains('sv-wb-docked'));
check('the state agrees', workbenchDockState().docked === false);
check('the panes are STILL the same elements',
  before.rail === q('.sv-wb-rail') && before.main === q('.sv-wb-main') && before.dock === q('.sv-wb-dock'));
// The detail pane has to survive the round trip with something in it. An empty
// column here is the shape of a render that stopped being called.
check('the cards are still there', document.querySelectorAll('.sv-wb-card').length > 0,
  `${document.querySelectorAll('.sv-wb-card').length} cards`);

// ---------------------------------------------------------------------------
section('IT IS REMEMBERED');
check('docked is written down', localStorage.getItem('sv-wb-docked') === '0');
setWorkbenchDocked(true, 'live');
check('...and so is the pane', localStorage.getItem('sv-wb-docked') === '1' && localStorage.getItem('sv-wb-pane') === 'live',
  `${localStorage.getItem('sv-wb-docked')} / ${localStorage.getItem('sv-wb-pane')}`);

console.log(fails ? `\n${fails} FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
