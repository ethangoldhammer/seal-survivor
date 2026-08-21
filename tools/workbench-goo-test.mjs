#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:goopanel
//
// THE GOO, IN THE FEEL WORKBENCH — ui/workbench.js.
//
// Every substance in the game — the blood a kill leaves, the foam off a breach,
// a burning hull's smoke, the ichor out of a weak spot — is one group in
// CONFIG.fx.goo.groups, and until this view existed exactly one of them (`boom`)
// had a control anywhere. The rest were edited in config.js.
//
// WHAT THIS COVERS, and every one of these fails silently:
//
//   RENDERING IS NOT AN EDIT. A group is a DIFF against CONFIG.fx.goo's own
//   keys, so most rows in most groups are showing a number that belongs to
//   EVERY group. A panel that wrote its displayed value back on render would
//   turn each of those into an override the moment you looked at the group —
//   the ` tuner shipped exactly that bug once (see tools/tuner-row-test.mjs).
//   Opening every group here must leave the config byte-identical.
//
//   A DEAD SLIDER. A get/set pair typed by hand against the wrong object moves,
//   reads and writes nothing. Nudged one at a time, on every group.
//
//   THE SECOND BURST. An event fires `emit` AND `goo` off one call — the spray
//   and the body of liquid under it — and the event view could only see the
//   first. Nine events fire a goo burst; each needs its picker and its card.
//
//   THE `goo: true` SPELLING. Emitters written before groups existed resolve to
//   the FIRST group. A view that only matched `goo === name` would report those
//   emitters as feeding nothing and hide them from the panel entirely.
//
//   THE ROW IS UNREACHABLE. It is added to the rail by hand and matched on a
//   bag of words rather than on its id.
//
// Load order is the jsdom recipe: jsdom, then the loader, then game modules.
// Run WITHOUT --import for that reason.
//
//   node tools/workbench-goo-test.mjs
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

const { registerHooks } = await import('node:module');
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@rive-app/canvas') return { url: 'stub:rive', format: 'module', shortCircuit: true };
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
await import('./vite-loader.mjs');
// BEFORE the game modules, and load-bearing: a save posts the whole tuning
// snapshot to the dev server, and this panel saves on every slider it nudges.
// Left live, a test run would overwrite whatever is open in the browser with a
// snapshot assembled here.
globalThis.fetch = async () => ({ ok: false, status: 404 });

const { CONFIG, TUNER_SCHEMA } = await import('../path/src/config.js');
const { initWorkbench, setWorkbenchVisible } = await import('../path/src/ui/workbench.js');

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails++;
};
const section = (t) => console.log(`\n${t}`);

const tuned = [];
initWorkbench((path) => tuned.push(path));
setWorkbenchVisible(true);

const click = (el) => el?.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
const rail = () => [...document.querySelectorAll('.sv-wb-ev')];
const rowNamed = (text) => rail().find((r) => r.textContent.includes(text));
const cards = () => [...document.querySelectorAll('.sv-wb-card h3')].map((h) => h.textContent);
const pills = () => [...document.querySelectorAll('.sv-wb-card .sv-wb-pill')];
const pillNamed = (t) => pills().find((p) => p.textContent === t);
const sliders = () => [...document.querySelectorAll('.sv-wb-card input[type=range]')];
const labelOf = (s) => s.previousElementSibling?.textContent ?? '?';
const groups = () => Object.keys(CONFIG.fx.goo.groups);

// ---------------------------------------------------------------------------
section('THE RAIL');
check('the panel mounted', !!document.querySelector('.sv-wb'));
check('the goo has a row', !!rowNamed('The goo'));

const search = document.querySelector('.sv-wb-search');
const typeFilter = (v) => {
  search.value = v;
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
};
for (const term of ['goo', 'blood', 'foam', 'ichor', 'smoke']) {
  typeFilter(term);
  check(`"${term}" finds it`, !!rowNamed('The goo'));
}
typeFilter('garlic');
check('"garlic" does not', !rowNamed('The goo'));
typeFilter('');

// ---------------------------------------------------------------------------
section('THE VIEW');
click(rowNamed('The goo'));
const shown = cards();
for (const t of ['Which substance', 'The pass', 'Its surface', 'What feeds it', 'Burst ·']) {
  check(`card: ${t}`, shown.some((x) => x.startsWith(t)), shown.join(' · '));
}
check('every group has a pill', groups().every((g) => !!pillNamed(g)),
  `${pills().length} pills for ${groups().length} groups`);
check('...and the shared block has one', !!pillNamed('shared default'));

// ---------------------------------------------------------------------------
section('RENDERING IS NOT AN EDIT');
// The one that would be invisible in use and permanent on disk: a group is a
// DIFF, so a row that wrote its displayed value back on render would fork the
// group off the shared surface simply by being looked at.
const before = JSON.stringify(CONFIG.fx.goo);
for (const g of groups()) click(pillNamed(g));
click(pillNamed('shared default'));
check('opening every group changed nothing', JSON.stringify(CONFIG.fx.goo) === before);

// ---------------------------------------------------------------------------
section('INHERITED ROWS ARE MARKED, AND MOVING ONE FORKS IT');
// BEFORE the sweep below, which forks every group by writing into all of them:
// after that there is nothing left inherited to look at. `gore` declares four
// keys and inherits the rest — the exact shape this marking exists for.
const partial = groups().find((g) => {
  const own = Object.keys(CONFIG.fx.goo.groups[g] ?? {}).length;
  return own > 0 && own < 8;
}) ?? groups()[0];
click(pillNamed(partial));
const inherited = [...document.querySelectorAll('.sv-wb-f.sv-wb-inh')];
check(`${partial} shows inherited rows`, inherited.length > 0,
  `${inherited.length} of ${sliders().length + 1}`);
const row = inherited.find((r) => r.querySelector('input[type=range]'));
if (row) {
  const s = row.querySelector('input[type=range]');
  const keysBefore = Object.keys(CONFIG.fx.goo.groups[partial]).length;
  s.value = String(Number(s.max));
  s.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  check('...and moving one gives the group its own',
    Object.keys(CONFIG.fx.goo.groups[partial]).length === keysBefore + 1,
    `${keysBefore} → ${Object.keys(CONFIG.fx.goo.groups[partial]).length}`);
}

// ---------------------------------------------------------------------------
section('EVERY SLIDER WRITES SOMEWHERE');
// Snapshot the whole pass plus the emitter under the Burst card, nudge each
// handle, and demand that SOMETHING moved. Deep-compared, because the failure
// being hunted is a `set` that assigns to the wrong object.
let deaf = [];
let checked = 0;
for (const g of [...groups(), 'shared default']) {
  click(pillNamed(g));
  const shot = [...document.querySelectorAll('.sv-wb-card h3')]
    .map((h) => h.textContent).find((t) => t.startsWith('Burst ·'))?.split(' · ')[1]?.split(' ')[0];
  const snapshot = () => JSON.stringify([CONFIG.fx.goo, shot ? CONFIG.emitters[shot] : null]);
  for (const s of sliders()) {
    const label = labelOf(s);
    const was = snapshot();
    const lo = Number(s.min);
    const hi = Number(s.max);
    const now = Number(s.value);
    s.value = String(Math.abs(now - lo) > Math.abs(hi - now) ? lo : hi);
    s.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    checked++;
    if (snapshot() === was) deaf.push(`${g}/${label}`);
  }
}
check('no slider is deaf', deaf.length === 0, deaf.length ? deaf.join(', ') : `${checked} checked`);

// The field's resolution is the one row that is not picked up on the next
// frame — it is sized with the post chain — so it has to ask for a rebuild.
click(pillNamed('shared default'));
tuned.length = 0;
const coarse = sliders().find((s) => labelOf(s) === 'coarseness');
if (coarse) {
  coarse.value = String(Number(coarse.value) === 1 ? 3 : 1);
  coarse.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}
check('coarseness asks for a resize', tuned.includes('fx.goo.divisor'), tuned.join(', ') || 'nothing');

// ---------------------------------------------------------------------------
section('WHAT FEEDS EACH GROUP');
// `goo: true` is the pre-groups spelling and resolves to the FIRST group. An
// emitter table where nothing says `true` is fine; one where something does and
// the panel cannot see it is a substance with no visible source.
const first = groups()[0];
const legacy = Object.keys(CONFIG.emitters).filter((k) => CONFIG.emitters[k].goo === true);
click(pillNamed(first));
const feedNames = [...document.querySelectorAll('.sv-wb-take .fn')].map((n) => n.textContent);
check('the legacy `goo: true` spelling lands in the first group',
  legacy.every((k) => feedNames.includes(k)),
  legacy.length ? `${legacy.join(', ')} → ${first}` : 'nothing uses it today');

let orphans = [];
for (const g of groups()) {
  click(pillNamed(g));
  const feeds = [...document.querySelectorAll('.sv-wb-take .fn')].map((n) => n.textContent);
  const real = Object.keys(CONFIG.emitters).filter((k) => {
    const v = CONFIG.emitters[k].goo;
    return v === true ? g === first : v === g;
  });
  if (feeds.length !== real.length) orphans.push(`${g}: ${feeds.length} shown, ${real.length} real`);
}
check('every group lists exactly its own emitters', orphans.length === 0, orphans.join(' · '));

// ---------------------------------------------------------------------------
section('THE SECOND BURST, ON THE EVENT VIEW');
const gooEvents = Object.keys(CONFIG.feedback).filter((e) => CONFIG.feedback[e].goo);
check('some events fire one', gooEvents.length > 0, `${gooEvents.length} events`);

let missing = [];
for (const e of gooEvents) {
  click(rowNamed(e));
  const want = CONFIG.feedback[e].goo;
  if (!cards().some((t) => t.startsWith(`Burst · ${want}`))) missing.push(e);
}
check('each gets a burst card for it', missing.length === 0,
  missing.length ? missing.join(', ') : `${gooEvents.length} checked`);

const ev = gooEvents[0];
click(rowNamed(ev));
const gooSel = [...document.querySelectorAll('.sv-wb-sel')]
  .find((s) => s.previousElementSibling?.textContent === 'goo');
check('the picker is there and points at it', gooSel?.value === CONFIG.feedback[ev].goo,
  `${ev} → ${gooSel?.value}`);

// Clearing it and putting it back, because the round trip is where a null goes
// missing — the select's own "none" is a string, not an absent value.
if (gooSel) {
  const was = CONFIG.feedback[ev].goo;
  gooSel.value = '— none —';
  gooSel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  const cleared = CONFIG.feedback[ev].goo === null;
  const gone = !cards().some((t) => t.startsWith(`Burst · ${was}`));
  const back = [...document.querySelectorAll('.sv-wb-sel')]
    .find((s) => s.previousElementSibling?.textContent === 'goo');
  back.value = was;
  back.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  check('clearing it drops the burst', cleared && gone, `cleared ${cleared}, card gone ${gone}`);
  check('...and it comes back', CONFIG.feedback[ev].goo === was);
}

// Shared exactly as hard as a shared spray: killGoo is thrown by kill AND
// bigKill, and the warning is what stops one being retuned for the other.
const sharedGoo = Object.entries(CONFIG.feedback)
  .filter(([, d]) => d.goo)
  .reduce((m, [e, d]) => { (m[d.goo] ??= []).push(e); return m; }, {});
const pair = Object.entries(sharedGoo).find(([, es]) => es.length > 1);
if (pair) {
  click(rowNamed(pair[1][0]));
  const warned = [...document.querySelectorAll('.sv-wb-scope')]
    .some((w) => w.textContent.includes(pair[1][1]));
  check('a shared goo burst says who else throws it', warned,
    `${pair[0]}: ${pair[1].join(', ')}`);
} else {
  check('a shared goo burst says who else throws it', true, 'none shared today');
}

// ---------------------------------------------------------------------------
section('IT COVERS WHAT THE ` TUNER COVERS');
// The goo has 33 rows scattered across four ` panels (the shared surface, plus
// bits of foam, smoke, aura and hit filed under the systems that use them).
// This view is meant to be the whole substance in one place, so every path any
// of those rows writes has to be reachable here — otherwise the F panel is a
// prettier subset and the answer to "where is that number" is still "it
// depends". Checked by MOVING controls and watching the path, not by reading
// the source: a row pointed at the wrong object is exactly what this catches.
const readPath = (path) => path.split('.').reduce((o, k) => o?.[k], CONFIG);
const gooPaths = TUNER_SCHEMA.flatMap((g) => g.items ?? [])
  .map((i) => i?.path)
  .filter((path) => path?.startsWith('fx.goo.'));

// Back to the goo view first: the section above left an EVENT selected, and a
// pill click that lands on nothing would quietly nudge that event's sliders
// instead — which reads as "nothing covers this path" for every path at once.
click(rowNamed('The goo'));
const uncovered = [];
for (const path of gooPaths) {
  const inGroup = path.startsWith('fx.goo.groups.') ? path.split('.')[3] : null;
  click(pillNamed(inGroup ?? 'shared default'));
  const at = () => JSON.stringify(readPath(path) ?? null);
  let covered = false;
  for (const el of sliders()) {
    const was = at();
    const lo = Number(el.min);
    const hi = Number(el.max);
    el.value = String(Math.abs(Number(el.value) - lo) > Math.abs(hi - Number(el.value)) ? lo : hi);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    if (at() !== was) { covered = true; break; }
  }
  // The toggles are walked by INDEX and re-queried each time: flipping one
  // re-renders the whole view, so a list captured up front is stale after the
  // first — which is how `fx.goo.additive` first read as uncovered while its
  // checkbox was sitting right there under the pass's own.
  const boxes = () => [...document.querySelectorAll('.sv-wb-card input[type=checkbox]')];
  for (let i = 0; !covered && i < boxes().length; i++) {
    const was = at();
    const box = boxes()[i];
    box.checked = !box.checked;
    box.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    if (at() !== was) covered = true;
  }
  if (!covered) uncovered.push(path);
}
check('every ` tuner goo row has a control here', uncovered.length === 0,
  uncovered.length ? uncovered.join(', ') : `${gooPaths.length} paths`);

console.log(fails ? `\n${fails} FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
