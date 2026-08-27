#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:tunersearch
//
// The search box every tuning panel now carries. Four things it has to get
// right, and each of them fails silently rather than loudly:
//
//   1. A HIT KEEPS ITS CONTEXT. The filter folds the tree rather than listing
//      matches, so a surviving row must still be inside its open group inside
//      its open section. A filter that hid the headers would leave a column of
//      anonymous sliders, which is the state the accordion exists to prevent.
//
//   2. A MATCHING HEADER IS ONE HIT, NOT EVERYTHING UNDER IT. Typing "camera" is
//      a request for the camera group, so the group survives whole and folded.
//      Unfolding it instead is the version that shipped first and it is worse
//      on the real panel: "shark" matches two skin-preset groups named for it,
//      and opening them put 78 sliders above the one model row being hunted.
//
//   3. CLEARING RESTORES, IT DOES NOT EXPAND. The obvious bug is a cleared box
//      leaving the panel fully unfolded — every header the search opened stuck
//      open — which reads as "the search broke my panel" and is invisible until
//      someone has 46 groups on screen. Headers go back to the persisted open
//      set, not to open.
//
//   4. SEARCHING IS NOT AN EDIT. Same rule as tools/tuner-row-test.mjs, one
//      level up: rendering must not write, and neither must filtering — not to
//      CONFIG and not to the open-groups store, which is a view preference that
//      must survive a search untouched.
//
// The panel-level check at the end is the one that catches a regression by
// omission: it asserts every in-game tuning panel actually builds a box, so
// adding a fourth panel without one fails here rather than being noticed later.
// ---------------------------------------------------------------------------

// LOAD ORDER: jsdom FIRST, then the vite loader hooks, then the game modules.
// See tools/tuner-row-test.mjs — the other way round fails with an encoding
// error that has nothing to do with anything.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
// The Look & Sound block at the end builds the real panel, which reaches audio
// and asset code. Same globals as tools/surface-panel-test.mjs — navigator has
// only a getter on globalThis, so it has to be defined rather than assigned.
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

await import('./vite-loader.mjs');
const { CONFIG } = await import('../path/src/config.js');
const {
  buildSectionedTunerGroups, buildTunerSearch, applyTunerFilter, setRowSearchText,
} = await import('../path/src/ui/tunerControls.js');

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const hidden = (el) => !!el?.classList.contains('sv-t-miss');
const open = (el) => !!el?.classList.contains('sv-t-open');
const byName = (root, sel, text) =>
  [...root.querySelectorAll(sel)].find((e) => e.textContent === text)?.closest('.sv-t-section, .sv-t-groupwrap');
const section = (root, title) => byName(root, '.sv-t-section-name', title);
const group = (root, title) => byName(root, '.sv-t-group-name', title);
const rowNamed = (root, label) =>
  [...root.querySelectorAll('.sv-t-row')].find((r) => r.dataset.search?.startsWith(label.toLowerCase()));

// A stand-in schema rather than the real TUNER_SCHEMA: the assertions below are
// about the shape of the tree, and pinning them to the live schema would turn
// every future rename of a group into a failure of the search.
const SCHEMA = [
  { group: 'Bloom', section: 'Look & FX', items: [
    { path: 'bloom.intensity', label: 'intensity', min: 0, max: 3, step: 0.01 },
    { path: 'bloom.knee', label: 'knee', min: 0, max: 1, step: 0.01 },
  ] },
  { group: 'Camera shake', section: 'Camera', items: [
    { path: 'camera.shake', label: 'amount', min: 0, max: 2, step: 0.01 },
    { path: 'camera.decay', label: 'settle', min: 0, max: 2, step: 0.01 },
  ] },
  { group: 'Oxygen', section: 'Gameplay', items: [
    { path: 'oxygen.drain', label: 'drain', min: 0, max: 5, step: 0.01 },
  ] },
];
const SECTIONS = [['Gameplay', '#7ad7ff'], ['Camera', '#c9a6ff'], ['Look & FX', '#ff8fb1']];

// SET BEFORE THE FIRST GROUP IS BUILT. tunerControls reads the open-groups key
// once, lazily, and caches it for the process — a panel built first and a
// localStorage write second leaves the module holding an empty set, and the
// restore assertions below then pass for the wrong reason.
localStorage.setItem('svTunerOpenGroups', JSON.stringify(['Oxygen']));

const root = document.createElement('div');
root.appendChild(buildSectionedTunerGroups(SCHEMA, SECTIONS, null, 'test'));
document.body.appendChild(root);

console.log('\nA ROW IS SEARCHABLE BY ITS PATH, NOT ONLY ITS LABEL');
{
  const row = rowNamed(root, 'knee');
  check('the row carries a search stamp', !!row?.dataset.search, row?.dataset.search);
  check('...which holds the config path', row.dataset.search.includes('bloom.knee'), row.dataset.search);
  const [hits] = applyTunerFilter(root, 'bloom.knee');
  check('...so the path alone finds exactly one row', hits === 1, `${hits} hits`);
  check('...and it is the right one', !hidden(row));
  check('...with its neighbour folded away', hidden(rowNamed(root, 'intensity')));
}

console.log('\nA HIT KEEPS ITS SECTION AND GROUP OPEN AROUND IT');
{
  applyTunerFilter(root, 'knee');
  check('the group is open', open(group(root, 'Bloom')) && !hidden(group(root, 'Bloom')));
  check('the section above it is open', open(section(root, 'Look & FX')) && !hidden(section(root, 'Look & FX')));
  check('a section with no hits is folded away', hidden(section(root, 'Gameplay')));
  check('and so is a group with no hits', hidden(group(root, 'Camera shake')));
  const count = group(root, 'Bloom').querySelector('.sv-t-group-count');
  check('the header counts its HITS while filtered', count.textContent === '1', count.textContent);
}

console.log('\nA MATCHING HEADER IS ONE HIT, KEPT WHOLE AND FOLDED');
{
  const [hits] = applyTunerFilter(root, 'camera shake');
  check('the group counts as one hit, not as its contents', hits === 1, `${hits} hits`);
  const g = group(root, 'Camera shake');
  check('...the group is showing', !hidden(g));
  check('...folded, as the panel had it', !open(g));
  check('...with its real count, not a filtered one',
    g.querySelector('.sv-t-group-count').textContent === '2',
    g.querySelector('.sv-t-group-count').textContent);
  check('...and nothing inside it hidden, so opening it shows the group',
    !hidden(rowNamed(root, 'settle')) && !hidden(rowNamed(root, 'amount')));
  check('...while the rest of the panel is folded away', hidden(group(root, 'Bloom')));
  check('...and the section above it opened to reveal it', open(section(root, 'Camera')));
}

console.log('\nA QUERY THAT MATCHES NOTHING HIDES EVERYTHING, AND SAYS SO');
{
  const [hits] = applyTunerFilter(root, 'zzzz');
  check('no hits', hits === 0);
  check('every section folded', SECTIONS.every(([t]) => hidden(section(root, t))));
}

console.log('\nCLEARING RESTORES THE PANEL RATHER THAN EXPANDING IT');
{
  // Only Oxygen was open before anyone searched — the state a real panel is in,
  // seeded above the first build.
  const fresh = document.createElement('div');
  fresh.appendChild(buildSectionedTunerGroups(SCHEMA, SECTIONS, null, 'test2'));
  check('Oxygen starts open', open(group(fresh, 'Oxygen')));
  check('Bloom starts shut', !open(group(fresh, 'Bloom')));

  applyTunerFilter(fresh, 'knee');
  check('searching opens Bloom', open(group(fresh, 'Bloom')));

  const stored = JSON.parse(localStorage.getItem('svTunerOpenGroups'));
  check('...without writing that to the open-groups store',
    JSON.stringify(stored) === JSON.stringify(['Oxygen']), JSON.stringify(stored));

  applyTunerFilter(fresh, '');
  check('clearing shuts Bloom again', !open(group(fresh, 'Bloom')));
  check('...leaves Oxygen open', open(group(fresh, 'Oxygen')));
  check('...unhides everything', ![...fresh.querySelectorAll('*')].some(hidden));
  const count = group(fresh, 'Bloom').querySelector('.sv-t-group-count');
  check('...and puts the real counts back', count.textContent === '2', count.textContent);
}

console.log('\nSEARCHING IS NOT AN EDIT');
{
  const before = JSON.stringify({ bloom: CONFIG.bloom, camera: CONFIG.camera });
  for (const q of ['knee', 'camera', 'zzz', '']) applyTunerFilter(root, q);
  check('four queries later, CONFIG is byte-identical',
    JSON.stringify({ bloom: CONFIG.bloom, camera: CONFIG.camera }) === before);
}

console.log('\nA HAND-BUILT ROW IS FINDABLE BY WHAT IT IS STAMPED WITH');
{
  // The Look & Sound panel's model, emitter and upgrade rows aren't schema
  // rows: they carry a dozen identical slider labels each, so an unstamped
  // search on "glow" would match all 48 of them at once.
  const wrap = document.createElement('div');
  const sec = document.createElement('div');
  sec.className = 'sv-t-section';
  sec.dataset.openKey = 'section:test:Models';
  const head = document.createElement('button');
  head.className = 'sv-t-sectionhead';
  const nm = document.createElement('span');
  nm.className = 'sv-t-section-name';
  nm.textContent = 'Models';
  head.appendChild(nm);
  const body = document.createElement('div');
  body.className = 'sv-t-sectionbody';
  for (const [key, label] of [['shrimp', 'Shrimp'], ['seagull', 'Seagull']]) {
    const r = document.createElement('div');
    r.className = 'sv-tex-row';
    r.textContent = 'Upload Tint Glow Roughness Size';
    setRowSearchText(r, `${key} ${label}`);
    body.appendChild(r);
  }
  sec.append(head, body);
  wrap.appendChild(sec);

  check('the stamp wins over the row text', applyTunerFilter(wrap, 'shrimp')[0] === 1);
  check('...so a shared slider label matches nothing', applyTunerFilter(wrap, 'roughness')[0] === 0);
}

console.log('\nSEVERAL ROOTS AT ONCE REPORT PER-ROOT HITS');
{
  const a = document.createElement('div');
  a.appendChild(buildSectionedTunerGroups([SCHEMA[0]], SECTIONS, null, 'a'));
  const b = document.createElement('div');
  b.appendChild(buildSectionedTunerGroups([SCHEMA[1]], SECTIONS, null, 'b'));
  const hits = applyTunerFilter([a, b], 'settle');
  check('one hit, and it says which root it is in',
    JSON.stringify(hits) === JSON.stringify([0, 1]), JSON.stringify(hits));
}

console.log('\nTHE BOX ITSELF');
{
  const r = document.createElement('div');
  r.appendChild(buildSectionedTunerGroups(SCHEMA, SECTIONS, null, 'box'));
  let seen = null;
  const box = buildTunerSearch(r, { placeholder: 'test', onFilter: (h, q) => (seen = [h, q]) });
  const input = box.querySelector('input');
  input.value = 'knee';
  input.dispatchEvent(new dom.window.Event('input'));
  check('typing filters', hidden(rowNamed(r, 'intensity')));
  check('...reports the count beside the box',
    box.querySelector('.sv-t-searchcount').textContent === '1');
  check('...and hands the hits to the panel', JSON.stringify(seen) === JSON.stringify([[1], 'knee']));

  input.value = 'zzz';
  input.dispatchEvent(new dom.window.Event('input'));
  check('a dead query reads "none" rather than 0',
    box.querySelector('.sv-t-searchcount').textContent === 'none');

  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
  check('Escape empties the box', input.value === '');
  check('...and unfolds the panel', !hidden(rowNamed(r, 'intensity')));
  check('...and clears the count', box.querySelector('.sv-t-searchcount').textContent === '');
}

console.log('\nEVERY TUNING PANEL BUILDS ONE');
{
  // By source, not by rendering the panels: two of the three need the whole
  // game up to build. The point is to fail when a fourth panel is added
  // without a box, which is the regression nobody notices from inside one
  // panel that still has its own.
  const { readFileSync } = await import('node:fs');
  for (const [file, label] of [
    ['path/src/ui/tuner.js', 'the ` tuner'],
    ['path/src/ui/textures.js', 'Look & Sound (T)'],
    ['path/src/ui/textPanel.js', 'the text panel (Y)'],
  ]) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    check(`${label} has a search box`, src.includes('buildTunerSearch('));
  }
  // The workbench and the shader lab have their own, older boxes over content
  // that is not a TUNER_SCHEMA tree — checked here so "all of them have one"
  // stays a true statement of the whole set.
  for (const [file, label] of [
    ['path/src/ui/workbench.js', 'the Feel workbench (F)'],
    ['tools/looks/shader-lab.js', 'the shader lab'],
  ]) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    check(`${label} still has its own`, /search/i.test(src) && /placeholder/.test(src));
  }
}

console.log('\nTHE REAL LOOK & SOUND PANEL (T), SIX TABS AT ONCE');
{
  // Built for real rather than mocked, because the thing worth checking is the
  // part no unit test shape covers: five of the six tabs are display:none at
  // any moment, so a search that only filtered the visible one would answer
  // "nothing found" for a control sitting one click away.
  const { initTexturePanel } = await import('../path/src/ui/textures.js');
  CONFIG.assetLooks = CONFIG.assetLooks ?? {};
  initTexturePanel(() => {}, () => {});
  const tex = document.querySelector('.sv-tex');
  const box = tex.querySelector('.sv-t-search');
  check('the panel built a box', !!box);

  const type = (v) => { box.value = v; box.dispatchEvent(new dom.window.Event('input')); };
  const modelRows = [...tex.querySelectorAll('.sv-tex-row[data-key]')];
  const shark = modelRows.find((r) => r.dataset.key.toLowerCase().includes('shark'));
  const other = modelRows.find((r) => !r.dataset.key.toLowerCase().includes('shark'));
  check('the Models tab has rows to filter', !!shark && !!other, `${modelRows.length} rows`);

  type('shark');
  check('the shark model survives', !hidden(shark), shark?.dataset.key);
  check('...and an unrelated model folds away', hidden(other), other?.dataset.key);

  const counts = [...tex.querySelectorAll('.sv-tex-tabcount')].map((e) => e.textContent);
  check('every tab reports a count, not just the open one',
    counts.length === 6 && counts.every((c) => c !== ''), counts.join(' / '));
  check('...the Models tab among them', Number(counts[0]) > 0, counts[0]);
  // The number that says the header rule is working. Two skin-preset groups are
  // named for sharks and hold 39 sliders each; counting their contents made
  // this 79 and put all of it on screen.
  check('...as a handful of destinations rather than every slider under them',
    Number(counts[0]) < 10, `${counts[0]} hits on Models`);
  check('...and a tab with nothing is marked empty',
    [...tex.querySelectorAll('.sv-tex-tab')].some((t) => t.classList.contains('sv-tex-tab-empty')));

  type('');
  check('clearing brings the other models back', !hidden(other));
  check('...and takes the counts off the tabs',
    [...tex.querySelectorAll('.sv-tex-tabcount')].every((e) => e.textContent === ''));
}

console.log(failures ? `\n${failures} FAILED\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);
