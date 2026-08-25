#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run look:tips -- [out.html]
//
// A LOOK PAGE FOR THE UPGRADE TIP — every row combination, every verbosity, and
// the end-of-run snapshot it sits over, built by the REAL ui.js and the REAL
// upgradeTip.js under jsdom and written out as a static page.
//
// Why not just run the game: any page served off a dev server can write
// path/src/imported-tuning.json, and an agent opening the game to take a
// screenshot is how a session's tuning gets flattened. This imports the same
// modules, takes the same CSS, and touches nothing. Same argument as
// look:hive, which this sits beside.
//
// WHAT IT IS ACTUALLY FOR. The tip is a TABLE of measurements next to a label
// column, and the two things that can be wrong with it are invisible in a unit
// test: whether three rows of different lengths still read as a table, and
// whether the longest real line in the game fits the box. Both are questions
// about a rendered box, so they need a rendered box.
//
// THE LEDGER IS FAKED, and only the ledger. The names, the descs and every
// measured number are the real ones — a synthetic run is injected so the "this
// run" row has something to show, because a static page has no run in it.
//
// Load order is the jsdom recipe: jsdom, then the vite loader, then the game
// modules. Run WITHOUT --import.
// ---------------------------------------------------------------------------

import { writeFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const OUT = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'tip-look.html';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true,
});
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Image = dom.window.Image;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
dom.window.HTMLCanvasElement.prototype.getContext = function getContext() {
  return {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {}, getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    clearRect() {}, fillRect() {}, drawImage() {}, save() {}, restore() {},
    set fillStyle(v) { this._fill = v; }, get fillStyle() { return this._fill; },
  };
};
dom.window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};

const { registerHooks } = await import('node:module');
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@rive-app/canvas') return { url: 'stub:rive', format: 'module', shortCircuit: true };
    if (spec.endsWith('.riv?url') || spec.endsWith('.wasm?url')) return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === 'stub:rive') return { format: 'module', shortCircuit: true, source: 'export class Rive { constructor(){} on(){} play(){} cleanup(){} } export const EventType = {}; export const Layout = class {}; export const Fit = {}; export const Alignment = {}; export const RuntimeLoader = { setWasmUrl(){} };' };
    if (url === 'stub:rivurl') return { format: 'module', shortCircuit: true, source: 'export default "stub.riv";' };
    return next(url, ctx);
  },
});
await import('./vite-loader.mjs');
globalThis.fetch = async () => ({ ok: false, status: 404 });
console.warn = () => {};

const { CONFIG } = await import('../path/src/config.js');
const tip = await import('../path/src/ui/upgradeTip.js');
const hive = await import('../path/src/ui/upgradeHive.js');
const { SOURCE_UPGRADES } = await import('../path/src/systems/playtestAnalysis.js');
const { player, recomputeStats, statsWithOneMore } = await import('../path/src/entities/player.js');
const ui = await import('../path/src/ui/ui.js');
ui.initUI({ onStart() {}, onRestart() {}, onLevelChoice() {}, onResume() {}, onPauseRestart() {} });

// The CSS ui.js injected — taken rather than copied, so this page cannot drift
// from what the game actually renders.
const css = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n');

// A SYNTHETIC LEDGER. Every source in the table gets a plausible figure so the
// "this run" row is populated for whatever is on the page, with a couple of
// deliberate extremes: one ability that ran away with the run, and one the
// player has been carrying all game that has done nothing.
const TOTALS = { dealtBySource: {}, killsBySource: {}, controlEvents: {} };
{
  let n = 0;
  for (const source in SOURCE_UPGRADES) {
    n += 1;
    if (SOURCE_UPGRADES[source].control) { TOTALS.controlEvents[source] = 3 + (n * 7) % 40; continue; }
    TOTALS.dealtBySource[source] = 900 + ((n * 37139) % 900000);
    TOTALS.killsBySource[source] = 1 + (n * 13) % 400;
  }
  TOTALS.dealtBySource.gun = 2_410_000;      // the one that ran away with it
  TOTALS.killsBySource.gun = 1873;
  delete TOTALS.dealtBySource.seagull;        // and the one that did nothing
  delete TOTALS.killsBySource.seagull;
}

const byId = new Map(CONFIG.upgrades.map((u) => [u.id, u]));
const enabled = CONFIG.upgrades.filter((u) => u.enabled);

// A REAL RUN, briefly, so the span in the `next` row has something to measure.
//
// "And where does that put me" is the live stat block plus one more pick, and
// there is no honest way to fake it — the figure folds in the base, the level
// growth and every other card. So the page stands the player up holding `owned`
// copies of the card, recomputes, and takes the two blocks. Cheap: it is a few
// object spreads per sample and it touches nothing outside this process.
function withRun(id, owned, fn) {
  const was = player.upgrades.slice();
  const wasLevel = player.level;
  player.upgrades.length = 0;
  for (let i = 0; i < owned; i++) player.upgrades.push({ id, rarity: 'common' });
  // A level a build that deep would plausibly be at, so the baseline growth in
  // the block is not a level-1 one under a fifteen-stack card.
  player.level = Math.max(1, owned * 2);
  recomputeStats();
  const out = fn({ live: player.stats, after: statsWithOneMore(id, 'common') });
  player.upgrades.length = 0;
  for (const p of was) player.upgrades.push(p);
  player.level = wasLevel;
  recomputeStats();
  return out;
}

// One tip, rendered into a detached box wearing the real class.
function tipHtml(id, owned, verbosity) {
  const content = withRun(id, owned, ({ live, after }) => tip.upgradeTipContent(id, {
    owned, verbosity, totals: TOTALS, liveStats: live, afterStats: after,
  }));
  if (!content) return '<div class="none">no tip</div>';
  const node = document.createElement('div');
  node.className = 'sv-uptip sv-uptip-on';
  // Static, so it cannot be positioned — the page lays these out in a grid and
  // the only question here is what the BOX looks like, not where it lands.
  node.style.position = 'static';
  tip.renderTipInto(node, content);
  return node.outerHTML;
}

// The three levels, over one card that is worth reading at each.
const LEVELS = ['full', 'short', 'off'];

// A spread chosen for the SHAPES of tip they produce, not for the abilities:
// an unheld card (one row), a deep stack of a weapon (all three), a control
// ability (events, not damage), a stat card (no run row at all), an ability
// that has done nothing, and one at its cap.
const CASES = [
  { id: 'shrimpRing', owned: 0, why: 'never taken — the total IS the next stack, so there is only one row' },
  { id: 'shrimpRing', owned: 4, why: 'four deep — where you are, and what it has done' },
  { id: 'shrimpRing', owned: byId.get('shrimpRing')?.maxStacks ?? 15, why: 'at its cap — there is no next one' },
  { id: 'rapidFire', owned: 3, why: 'one of five cards booked under Fin Pebbles — the row names the LINE' },
  { id: 'octoGrab', owned: 2, why: 'damageless: its whole output is an event' },
  { id: 'oxygenMax', owned: 5, why: 'a stat card — no damage tag at all, so no run row' },
  { id: 'seagullBomb', owned: 2, why: 'held all run and has done nothing — the tip says so out loud' },
  { id: 'orcaFamily', owned: 1, why: 'a long unlock phrase, for the widest the box gets' },
].filter((c) => byId.has(c.id));

// EVERY ENABLED CARD AT ONE STACK. The question the cases above cannot ask: is
// there a card in the roster whose measured phrase is so long it breaks the
// box, and is there one whose rows come out empty. Generated off CONFIG so it
// cannot go stale.
const ROSTER = enabled.map((u) => ({
  id: u.id, name: u.name, html: tipHtml(u.id, 1, 'full'),
}));

// The snapshot, at the size the score rail uses and at the size the sheet
// opens to — the two the player actually sees.
const BUILD = [
  ['shrimpRing', 'legendary'], ['shrimpRing', 'common'], ['shrimpRing', 'common'],
  ['shrimpRing', 'common'], ['club', 'epic'], ['clubBoom', 'rare'],
  ['seaGarlic', 'rare'], ['harp', 'epic'], ['octoGrab', 'rare'],
  ['oxygenMax', 'uncommon'], ['oxygenMax', 'common'], ['rapidFire', 'common'],
  ['rapidFire', 'common'], ['orcaFamily', 'legendary'], ['maneater', 'epic'],
].filter(([id]) => byId.has(id)).map(([id, rarity]) => ({ id, rarity }));

const snaps = [30, 60, 92].map((size) => {
  const s = hive.buildHiveSnapshot(BUILD, { size });
  return { size, html: s ? s.host.outerHTML : '<i>empty</i>' };
});

const page = `<meta charset="utf-8"><title>upgrade tips</title>
<style>
${css}
body { margin: 0; padding: 26px 30px 60px; background: #06121a; color: #cfe6f5;
  font: 13px/1.5 ui-sans-serif, system-ui, sans-serif; }
h1 { font-size: 17px; margin: 0 0 4px; color: #eaf6ff; }
h2 { font-size: 14px; margin: 34px 0 4px; color: #9fe3ff; letter-spacing: 0.04em;
  text-transform: uppercase; }
.lede { color: rgba(207,230,245,0.55); max-width: 70ch; margin: 0 0 6px; }
.grid { display: flex; flex-wrap: wrap; gap: 18px; align-items: flex-start; margin-top: 12px; }
.cell { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px; padding: 12px; }
.cap { font-size: 11px; color: rgba(207,230,245,0.5); margin-bottom: 8px; max-width: 34ch; }
.cap b { color: #cfe6f5; font-weight: 600; }
.none { font-size: 11px; color: rgba(207,230,245,0.3); font-style: italic;
  border: 1px dashed rgba(255,255,255,0.15); border-radius: 7px; padding: 10px 12px; }
.roster { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
.roster .cell { padding: 8px; }
.roster .cap { margin-bottom: 5px; }
/* THE RULER. Every box is shown against a 260px mark, which is .sv-uptip's own
   max-width — anything that reaches it is a line that will wrap in the game. */
.ruler { position: relative; }
.ruler::after { content: ''; position: absolute; left: 260px; top: 0; bottom: 0;
  width: 1px; background: rgba(255,120,120,0.35); }
.on-water { background:
  radial-gradient(120% 90% at 30% 10%, rgba(26,86,120,0.9), rgba(4,16,24,0.95)); }
</style>

<h1>upgrade tips</h1>
<p class="lede">Built by the real <code>ui/upgradeTip.js</code> under jsdom &mdash; the names,
the descs and every measured number are the game's. Only the RUN LEDGER is synthetic, because a
static page has no run in it. The red line is <code>.sv-uptip</code>'s 260px max-width: a box that
reaches it wraps in the game.</p>

<h2>the shapes a tip comes in</h2>
<div class="grid ruler">
${CASES.map((c) => `  <div class="cell"><div class="cap"><b>${byId.get(c.id).name}</b> &times;${c.owned} &mdash; ${c.why}</div>${tipHtml(c.id, c.owned, 'full')}</div>`).join('\n')}
</div>

<h2>the three verbosities</h2>
<p class="lede">The same card at four stacks. Full is the default; Short is the question at the
moment of a pick with the reading dropped; Off is nothing anywhere.</p>
<div class="grid ruler">
${LEVELS.map((v) => `  <div class="cell"><div class="cap"><b>${v}</b></div>${tipHtml('shrimpRing', 4, v)}</div>`).join('\n')}
</div>

<h2>the end-of-run snapshot</h2>
<p class="lede">The same lattice as the corner, at three sizes: 30px is the block on the score
rail beside the last polaroid, 60&ndash;92px is what the sheet opens to depending on the window.</p>
<div class="grid">
${snaps.map((s) => `  <div class="cell on-water"><div class="cap"><b>${s.size}px</b> hexagons</div>${s.html}</div>`).join('\n')}
</div>

<h2>every enabled card, one stack, full</h2>
<p class="lede">${ROSTER.length} cards. Generated off CONFIG, so a card added tomorrow appears here
without anyone maintaining a list. What to look for: a measured phrase long enough to cross the red
line, and a box with no rows in it.</p>
<div class="roster ruler">
${ROSTER.map((r) => `  <div class="cell"><div class="cap">${r.name}</div>${r.html}</div>`).join('\n')}
</div>
`;

await writeFile(OUT, page);
console.log(`wrote ${OUT} — ${CASES.length} shapes, ${ROSTER.length} cards, ${(Buffer.byteLength(page) / 1024).toFixed(0)}KB`);
