#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:boompanel
//
// THE BOSS GOING UP, IN THE FEEL WORKBENCH — ui/workbench.js.
//
// The explosion's 35 controls live in the F panel rather than the ` tuner, and
// the reason they can is that the workbench grew its first view that is NOT a
// feedback event. Every other row in that rail is a key of CONFIG.feedback and
// the detail pane is written against one; this one is a synthetic row with a
// hand-built pane behind it. That is exactly the kind of seam that renders an
// empty column and throws nothing.
//
// WHAT THIS COVERS, and each of these has failed silently at least once in a
// panel of this shape:
//
//   A DEAD SLIDER. A row whose `path` no longer resolves still draws — it just
//   reads 0 and writes into nothing. The ` tuner has a test for exactly this
//   (tools/tuner-row-test.mjs) and moving the rows out of it moved them out of
//   that safety net, so it is rebuilt here against the live CONFIG.
//
//   A CONTROL THAT DOES NOT WRITE BACK. Every slider here is a get/set pair
//   typed by hand, and a `set` that assigns to the wrong object is invisible:
//   the handle moves, the number changes, and the explosion does not.
//
//   THE ROW IS UNREACHABLE. It is added to the rail by hand inside one section
//   and matched on a bag of words rather than on its id, so both the section
//   and the filter are load-bearing in a way no other row's is.
//
//   THE BURST CARD, SHARED. It was extracted from the event view so the boom
//   could have it; the event view must still get it, with its shared-emitter
//   warning intact, and the boom view must get it without one.
//
//   FIRING IT MUST NOT NEED AN ANIMAL. The button builds a synthetic body, and
//   fireBossBoom's fallback chain is what makes that legal.
//
// Load order is the jsdom recipe: jsdom, then the loader, then game modules.
// Run WITHOUT --import for that reason.
//
//   node tools/workbench-boom-test.mjs
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
globalThis.fetch = async () => ({ ok: false, status: 404 });

const { CONFIG } = await import('../path/src/config.js');
const { initWorkbench, setWorkbenchVisible } = await import('../path/src/ui/workbench.js');
const { bossBoomCount, resetBossBooms } = await import('../path/src/systems/bossBoom.js');

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails++;
};
const section = (t) => console.log(`\n${t}`);

initWorkbench();
setWorkbenchVisible(true);

const panel = document.querySelector('.sv-wb');
const rail = () => [...document.querySelectorAll('.sv-wb-ev')];
const rowNamed = (text) => rail().find((r) => r.textContent.includes(text));
const cards = () => [...document.querySelectorAll('.sv-wb-card h3')].map((h) => h.textContent);

// ---------------------------------------------------------------------------
section('THE RAIL');
check('the panel mounted', !!panel);

const sections = [...document.querySelectorAll('.sv-wb-sec')].map((s) => s.textContent);
check('there is a Bosses section', sections.includes('Bosses'), sections.join(' · '));

const boomRow = rowNamed('The boss going up');
check('the explosion has a row in it', !!boomRow);

// It has to sit under Bosses specifically — the row is appended by the section
// loop, so a wrong section name silently puts it somewhere else or nowhere.
if (boomRow) {
  let prevSec = null;
  for (const el of [...panel.querySelectorAll('.sv-wb-sec, .sv-wb-ev')]) {
    if (el.classList.contains('sv-wb-sec')) prevSec = el.textContent;
    if (el === boomRow) break;
  }
  check('...under Bosses, not loose', prevSec === 'Bosses', `under "${prevSec}"`);
}

const bossEvents = ['bossDieFlesh', 'bossDieShell', 'bossDieHull', 'bossHitFlesh', 'bossHitShell', 'bossHitHull', 'bossDaze'];
check('the boss voices are reachable too', bossEvents.every((k) => !!rowNamed(k)),
  `${bossEvents.filter((k) => rowNamed(k)).length}/${bossEvents.length}`);

// ---------------------------------------------------------------------------
section('THE FILTER');
const search = document.querySelector('.sv-wb-search');
const typeFilter = (v) => {
  search.value = v;
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
};
for (const term of ['boom', 'explosion', 'smoke', 'shockwave']) {
  typeFilter(term);
  check(`"${term}" finds it`, !!rowNamed('The boss going up'));
}
// And it must not survive a filter that has nothing to do with it, or the row
// is simply always present and the search box lies about the rest.
typeFilter('garlic');
check('"garlic" does not', !rowNamed('The boss going up'));
typeFilter('');

// ---------------------------------------------------------------------------
section('THE VIEW');
rowNamed('The boss going up').dispatchEvent(new dom.window.Event('click', { bubbles: true }));

const titles = cards();
for (const t of ['The moment', 'The cloud', 'Its surface', 'How random it is', 'The outermost ring', 'The shockwave', 'The body letting go', 'Burst · bossBoom']) {
  check(`card: ${t}`, titles.some((x) => x.startsWith(t)), titles.join(' · '));
}

const sliders = [...document.querySelectorAll('.sv-wb-card input[type=range]')];
const boxes = [...document.querySelectorAll('.sv-wb-card input[type=checkbox]')];
check('every control drew', sliders.length >= 30, `${sliders.length} sliders, ${boxes.length} toggles`);

// ---------------------------------------------------------------------------
section('EVERY SLIDER WRITES SOMEWHERE');
// The one that matters. A handle that moves and changes nothing is the failure
// this whole panel is exposed to, and it cannot be seen by looking at it.
//
// Snapshot the whole of what the effect reads, nudge each slider, and demand
// that SOMETHING moved. Deep-compared rather than watching one field, because
// the point is to catch a `set` that wrote to the wrong object.
//
// CONFIG.bodyPalette is in the snapshot because the explosion's colour card
// reaches into it: "how much do we trust the texture average" is a fact about
// reading a body, not about a boss going up, so it lives in its own block and
// the panel writes across the seam. A slider whose target is not in here reads
// as deaf when it is working perfectly, which is the same false alarm in the
// opposite direction from the bug this check exists for.
const snapshot = () => JSON.stringify([
  CONFIG.boss.boom, CONFIG.fx.goo.groups.boom, CONFIG.emitters.bossBoom, CONFIG.bodyPalette,
  CONFIG.boss.dissolve, CONFIG.emitters.bossDissolve,
]);
// THE ONE EXEMPTION, and it is exempt for the reason stageState exists: the
// test body's radius is where the knob happens to be sitting while you work,
// not an authored value, so it deliberately writes to a module local and never
// into CONFIG. Named rather than detected — a slider that stopped writing would
// otherwise be able to hide by being unlabelled.
const KNOBS = ['test body radius'];
let deaf = [];
for (const s of sliders) {
  const label = s.previousElementSibling?.textContent ?? '?';
  if (KNOBS.includes(label)) continue;
  const before = snapshot();
  const lo = Number(s.min);
  const hi = Number(s.max);
  const now = Number(s.value);
  // Toward whichever end is further away, so a control already at one end is
  // still genuinely moved.
  s.value = String(Math.abs(now - lo) > Math.abs(hi - now) ? lo : hi);
  s.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  if (snapshot() === before) deaf.push(label);
}
check('no slider is deaf', deaf.length === 0,
  deaf.length ? deaf.join(', ') : `${sliders.length - KNOBS.length} checked, ${KNOBS.length} knob exempt`);

// The staging radius is deliberately NOT in CONFIG — it is a knob, not a value
// — so it is the one control expected to leave the snapshot alone. Confirmed
// by name rather than by exempting it above, which would hide a real failure.
const testRow = [...document.querySelectorAll('.sv-wb-f')].find((r) => r.textContent.includes('test body radius'));
check('the test radius is a knob, not config', !!testRow && CONFIG.boss.boom.testRadius === undefined);

// ---------------------------------------------------------------------------
section('FIRING IT NEEDS NO ANIMAL');
resetBossBooms();
const btn = [...document.querySelectorAll('.sv-wb-btn')].find((b) => b.textContent.includes('Blow up the seal'));
check('the Fire button is there', !!btn);
btn?.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
check('...and it detonates', bossBoomCount() === 1, `${bossBoomCount()} in flight`);
resetBossBooms();

// ---------------------------------------------------------------------------
section('THE SHARED BURST CARD');
// The boom's card must NOT carry the shared-emitter warning: that warning is
// about other feedback events throwing the same particles, and the boom has no
// event at all. An empty `event` reaching the old code path would have thrown.
const boomScope = [...document.querySelectorAll('.sv-wb-scope')];
check('no shared-burst warning on the boom', boomScope.length === 0);

// ...and the event view still has its own. `kill` and `bigKill` share nothing,
// so this is asserted on an emitter that really is shared.
const shared = Object.entries(CONFIG.feedback)
  .filter(([, d]) => d.emit)
  .reduce((m, [e, d]) => { (m[d.emit] ??= []).push(e); return m; }, {});
const pair = Object.values(shared).find((es) => es.length > 1);
if (pair) {
  rowNamed(pair[0]).dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  check('the event view kept its warning', document.querySelectorAll('.sv-wb-scope').length > 0,
    `${pair[0]} shares with ${pair.slice(1).join(', ')}`);
  check('...and still draws its burst card', cards().some((t) => t.startsWith('Burst ·')));
} else {
  check('the event view kept its warning', true, 'no shared emitter in the table to test with');
}

// ---------------------------------------------------------------------------
section('NOTHING LEFT BEHIND IN THE ` TUNER');
const { TUNER_SCHEMA } = await import('../path/src/config.js');
const stragglers = TUNER_SCHEMA.flatMap((g) => g.items ?? [])
  .filter((i) => i?.path && (i.path.startsWith('boss.boom') || i.path.startsWith('fx.goo.groups.boom')))
  .map((i) => i.path);
check('the boom rows moved rather than copied', stragglers.length === 0, stragglers.join(', '));

// ---------------------------------------------------------------------------
section('THE LIGHT ON THE KILL');
// The second synthetic row in this section, and it is exposed to every one of
// the seams the boom row is: a hand-built pane behind a row that is not a
// feedback event, matched on a bag of words rather than on its id.
typeFilter('');
const lightRow = rowNamed('The light on the kill');
check('the light has a row of its own', !!lightRow);
if (lightRow) {
  let prevSec = null;
  for (const el of [...panel.querySelectorAll('.sv-wb-sec, .sv-wb-ev')]) {
    if (el.classList.contains('sv-wb-sec')) prevSec = el.textContent;
    if (el === lightRow) break;
  }
  check('...under Bosses, beside the explosion it lights', prevSec === 'Bosses', `under "${prevSec}"`);
}
for (const term of ['shaft', 'volumetric', 'trophy', 'wash']) {
  typeFilter(term);
  check(`"${term}" finds it`, !!rowNamed('The light on the kill'));
}
typeFilter('garlic');
check('"garlic" does not', !rowNamed('The light on the kill'));
typeFilter('');

rowNamed('The light on the kill').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
{
  const titles = cards();
  for (const t of ['The moment', 'The hero shaft', 'Where it lands', 'The wash on the body', 'The bodies themselves']) {
    check(`card: ${t}`, titles.some((x) => x.startsWith(t)), titles.join(' · '));
  }
  // THE ONE THAT MATTERS, same as for the boom: a handle that moves and changes
  // nothing is invisible by looking at it. The lift sliders write into
  // CONFIG.damageGlow.sources rather than into CONFIG.boss.light, which is
  // exactly the kind of second target a `set` gets wrong, so the snapshot
  // covers both.
  const snap = () => JSON.stringify([CONFIG.boss.light, CONFIG.damageGlow.sources]);
  const deafLight = [];
  for (const el of [...document.querySelectorAll('.sv-wb-card input[type=range]')]) {
    const label = el.previousElementSibling?.textContent ?? '?';
    const before = snap();
    const lo = Number(el.min);
    const hi = Number(el.max);
    const now = Number(el.value);
    el.value = String(Math.abs(now - lo) > Math.abs(hi - now) ? lo : hi);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    if (snap() === before) deafLight.push(label);
  }
  check('no slider is deaf', deafLight.length === 0, deafLight.join(', '));
}

console.log(fails ? `\n${fails} FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
