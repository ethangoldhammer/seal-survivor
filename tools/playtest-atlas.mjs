#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run playtest:atlas [-- options]
//
// Renders the collected runs as ONE self-contained HTML page, for publishing to
// a permanent URL. The terminal report answers "what does the last session say";
// this answers "what has every run ever said, and which build said it".
//
//   --out <path>   where to write (default playtest/atlas.html)
//   --local        include playtest/runs.jsonl (dev runs) as well
//   --min <sec>    floor for a run to be judged at all (default 60)
//
// THE ANALYSIS IS INLINED, NOT REIMPLEMENTED. playtestAnalysis.js imports
// nothing — the property that lets the CLI import it without a bundler — which
// also means its source can be pasted into the page and called there. So the
// filters recompute with the SAME code the terminal runs, and a verdict can
// never differ between the two. Reimplementing the aggregation in the page
// would produce a dashboard that quietly disagrees with `npm run playtest`,
// which is worse than having no dashboard.
//
// SELF-CONTAINED BY REQUIREMENT. The published page is served under a strict
// CSP with no external hosts: no CDN, no fonts, no fetch. Every byte — data,
// analysis, charts — is in the file. That also makes it a durable artifact: it
// still renders years later with the worker long gone.
// ---------------------------------------------------------------------------

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ANALYSIS = resolve(ROOT, 'path/src/systems/playtestAnalysis.js');

function parseArgs(argv) {
  const args = { out: resolve(ROOT, 'playtest/atlas.html'), local: false, min: 60 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = resolve(process.cwd(), argv[++i]);
    else if (a === '--local') args.local = true;
    else if (a === '--min') args.min = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log('\n  npm run playtest:atlas -- [--out <path>] [--local] [--min <sec>]\n');
      process.exit(0);
    } else {
      console.error(`unknown option: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

async function readJsonl(file, source) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const run = JSON.parse(t);
      // Where the run came from is not in the record — a run posted by the
      // deployed game and one written straight to disk by the dev server are
      // byte-identical. It matters for reading them, though: a dev run was
      // played against half-finished tuning. Tagged at load, from which file
      // it was in.
      run.source = source;
      out.push(run);
    } catch { /* a truncated final line, from a run filed as the tab closed */ }
  }
  return out;
}

// Must match SENTINEL_HP in path/src/systems/playtest.js. Not imported, because
// this tool reads logs and never boots the game — and the constant is a
// property of the RECORDED DATA, not of the running game.
const SENTINEL_HP = 5e6;

/** The single largest per-source damage total in a run, for the guard below. */
function worstSource(run) {
  let amount = 0;
  let source = null;
  const totals = {};
  for (const b of run.buckets ?? []) {
    for (const k in b.dealtBySource ?? {}) {
      totals[k] = (totals[k] ?? 0) + b.dealtBySource[k];
      if (totals[k] > amount) { amount = totals[k]; source = k; }
    }
  }
  return { amount, source };
}

// The page needs the analysis as plain top-level declarations, not as a module
// with exports — it is pasted into one <script type="module">, so `export`
// keywords would be legal but pointless, and stripping them keeps the injected
// text obviously inert. The `</script>` guard is the one thing that could break
// out of the tag; nothing else in JS can.
function inlineAnalysis(src) {
  return src
    .replace(/^export\s+(function|const|class|let)\s/gm, '$1 ')
    .replace(/<\/script>/gi, '<\\/script>');
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  const remote = await readJsonl(resolve(ROOT, 'playtest/remote.jsonl'), 'live');
  const local = args.local ? await readJsonl(resolve(ROOT, 'playtest/runs.jsonl'), 'local') : [];

  // A run can legitimately be in both files — one played on the dev server and
  // later pulled is impossible, but a re-pull into a fresh file is not, and a
  // duplicate would double every total it touches. Keyed on the run id, which
  // is minted per run and never reused.
  const byId = new Map();
  for (const r of [...local, ...remote]) byId.set(r.id, r);
  const all = [...byId.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));

  // QUARANTINE THE PRE-GUARD RUNS.
  //
  // Runs recorded before the recorder learned about placeholder hp carry a
  // single source with billions of damage against it — a lethal hazard that
  // killed a creature whose hp meant "cannot be killed". One such run was
  // 99.87% of all damage across 151 runs, which took every real ability in the
  // pooled table to a 0% share.
  //
  // The recorder drops these at the source now and the table no longer holds a
  // number that could produce one, so this only ever matches the archive. It
  // stays because the archive is permanent: those runs are on disk, they are
  // still valid for survival and threat data, and nothing about a later fix
  // can reach back and clean the figure that was written.
  //
  // COUNTED AND REPORTED, never silently dropped. A dashboard that quietly
  // discards data is worse than one that shows bad data, because only one of
  // them can be argued with.
  const poisoned = [];
  const runs = all.filter((r) => {
    const worst = worstSource(r);
    if (worst.amount < SENTINEL_HP) return true;
    poisoned.push({ ...worst, id: r.id, startedAt: r.startedAt });
    return false;
  });

  if (!runs.length) {
    console.error('No runs to render. Pull some with `npm run playtest:pull`, or pass --local.\n');
    process.exit(1);
  }

  const analysisSrc = inlineAnalysis(await readFile(ANALYSIS, 'utf8'));
  const html = renderPage(runs, analysisSrc, args, poisoned);
  await writeFile(args.out, html, 'utf8');

  const builds = new Set(runs.map((r) => r.meta?.build ?? 'unknown'));
  const kb = Math.round(Buffer.byteLength(html) / 1024);
  console.log(`\n  ${runs.length} runs · ${builds.size} build${builds.size === 1 ? '' : 's'} · ${kb} KB`);
  for (const p of poisoned) {
    const when = new Date(p.startedAt).toISOString().slice(0, 16).replace('T', ' ');
    console.log(`  excluded ${when} — ${p.source} ${Math.round(p.amount).toLocaleString()} (placeholder hp)`);
  }
  console.log(`  wrote ${args.out}\n`);
};

// THE OUTPUT IS PURE ASCII, by construction.
//
// The page declares no charset and cannot: the publisher wraps this file in its
// own <head>, so a <meta charset> of ours would land in the body, where it is
// honoured only by the browser's byte pre-scan and not by contract. Served over
// a plain static server with no charset in the Content-Type, every em dash in
// the flag text rendered as mojibake.
//
// Escaping instead of declaring removes the question. An ASCII file reads
// identically as UTF-8, Latin-1, or anything else that agrees about the low
// 128 — so it survives any header, any wrapper, and any future host.
//
// Two escapes, because the file is two languages: HTML text takes numeric
// entities, JavaScript takes \u. Applying either to the other's region would
// print the escape verbatim.
const asciiHtml = (s) => s.replace(/[^\x00-\x7F]/g, (c) => '&#x' + c.codePointAt(0).toString(16) + ';');
// Escaped per UTF-16 code unit, so an astral character becomes its surrogate
// pair — which is exactly what a JS string literal wants.
const asciiJs = (s) => s.replace(/[^\x00-\x7F]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

function renderPage(runs, analysisSrc, args, poisoned = []) {
  const excluded = poisoned.length
    ? `<p>${poisoned.length} run${poisoned.length === 1 ? '' : 's'} excluded: recorded before the
       recorder guarded against placeholder hp, so a single source carries
       ${Math.round(poisoned[0].amount).toLocaleString()} damage
       (<code>${poisoned[0].source}</code>) and would be the whole pool. Still on disk in
       <code>playtest/runs.jsonl</code>.</p>`
    : '';
  // The records go in as JSON rather than as JS source: a run record is pure
  // data and JSON.parse of one string is faster to boot than a large object
  // literal the JS parser has to walk.
  const data = JSON.stringify(JSON.stringify(runs));

  const shell = `<title>Playtest Atlas</title>
<style>
${STYLE}
</style>

<div class="wrap">
  <header class="head">
    <div>
      <h1>Playtest Atlas</h1>
      <p class="sub" id="subtitle">Seal Survivor — collected runs</p>
    </div>
    <div class="stamp">
      <span id="stamp-date"></span>
      <span class="dot">·</span>
      <span id="stamp-count"></span>
    </div>
  </header>

  <div class="filters" role="group" aria-label="Filters">
    <label class="field">
      <span>Build</span>
      <select id="f-build"></select>
    </label>
    <label class="field">
      <span>Source</span>
      <select id="f-source">
        <option value="all">All runs</option>
        <option value="live">Live site only</option>
        <option value="local">Dev server only</option>
      </select>
    </label>
    <label class="field">
      <span>Browser</span>
      <select id="f-client"></select>
    </label>
    <p class="hint" id="filter-note"></p>
  </div>

  <div id="body"></div>

  <footer class="foot">
    <p>Generated by <code>npm run playtest:atlas</code>. Every number is
    recomputed in this page by <code>playtestAnalysis.js</code> — the same module
    <code>npm run playtest</code> and the in-game <kbd>B</kbd> panel use, inlined
    rather than reimplemented, so this page and the terminal cannot disagree.</p>
    <p>Runs shorter than ${args.min}s are recorded but not judged.</p>
    ${excluded}
  </footer>
</div>

<script type="module">
__SCRIPT__
</script>
`;

  const script = [
    analysisSrc,
    '',
    `const RUNS = JSON.parse(${data});`,
    `const MIN_JUDGED = ${args.min};`,
    '',
    PAGE_SCRIPT,
  ].join('\n');

  // The placeholder is ASCII, so escaping the shell can never disturb it.
  return asciiHtml(shell).replace('__SCRIPT__', () => asciiJs(script));
}

// ---------------------------------------------------------------------------
// Style. Tokens are declared on bare :root for light, then redefined under both
// the OS media query and the explicit [data-theme] stamp — the published page
// renders in the viewer's theme, which has three states (explicit light,
// explicit dark, and unset/system), and a color defined only inside a media
// block has no value in the third.
// ---------------------------------------------------------------------------
const STYLE = `
:root {
  color-scheme: light;
  --plane: #f9f9f7;
  --surface: #fcfcfb;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --muted: #898781;
  --grid: #e1e0d9;
  --axis: #c3c2b7;
  --border: rgba(11,11,11,0.10);
  --player: #2a78d6;
  --enemy: #eb6834;
  --seq-1: #cde2fb;
  --seq-4: #3987e5;
  --seq-6: #184f95;
  --good: #0ca30c;
  --warning: #fab219;
  --serious: #ec835a;
  --critical: #d03b3b;
  --good-text: #006300;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --plane: #0d0d0d;
    --surface: #1a1a19;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --muted: #898781;
    --grid: #2c2c2a;
    --axis: #383835;
    --border: rgba(255,255,255,0.10);
    --player: #3987e5;
    --enemy: #d95926;
    --seq-1: #184f95;
    --seq-4: #3987e5;
    --seq-6: #cde2fb;
    --good-text: #0ca30c;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --plane: #0d0d0d;
  --surface: #1a1a19;
  --ink: #ffffff;
  --ink-2: #c3c2b7;
  --muted: #898781;
  --grid: #2c2c2a;
  --axis: #383835;
  --border: rgba(255,255,255,0.10);
  --player: #3987e5;
  --enemy: #d95926;
  --seq-1: #184f95;
  --seq-4: #3987e5;
  --seq-6: #cde2fb;
  --good-text: #0ca30c;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--plane);
  color: var(--ink);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1080px; margin: 0 auto; padding: 32px 20px 64px; }

.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
h1 { font-size: 26px; font-weight: 640; letter-spacing: -0.02em; margin: 0 0 2px; }
.sub { margin: 0; color: var(--ink-2); font-size: 14px; }
.stamp { color: var(--muted); font-size: 13px; white-space: nowrap; }
.dot { opacity: 0.5; margin: 0 4px; }

.filters { display: flex; gap: 14px; flex-wrap: wrap; align-items: flex-end; padding: 14px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 22px; }
.field { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--ink-2); }
.field select {
  font: inherit; font-size: 14px; color: var(--ink); background: var(--surface);
  border: 1px solid var(--axis); border-radius: 7px; padding: 6px 9px; min-width: 150px;
}
.hint { flex: 1 1 220px; margin: 0; color: var(--muted); font-size: 12.5px; align-self: center; }

section { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin-bottom: 18px; }
h2 { font-size: 15px; font-weight: 620; margin: 0 0 3px; letter-spacing: -0.01em; }
.note { margin: 0 0 16px; color: var(--muted); font-size: 12.5px; max-width: 68ch; }

.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 2px; background: var(--border); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; margin-bottom: 18px; }
.kpi { background: var(--surface); padding: 16px 18px; }
.kpi .k { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 5px; }
.kpi .v { font-size: 27px; font-weight: 620; letter-spacing: -0.02em; line-height: 1.1; }
.kpi.hero .v { font-size: 44px; }
.kpi .x { font-size: 12.5px; color: var(--ink-2); margin-top: 3px; }

.flags { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 9px; }
.flag { display: flex; gap: 10px; align-items: flex-start; font-size: 13.5px; }
.flag .ic { flex: none; width: 17px; height: 17px; border-radius: 50%; margin-top: 1px; display: grid; place-items: center; font-size: 11px; font-weight: 700; color: #fff; }
.flag .ic.bad { background: var(--critical); }
.flag .ic.warn { background: var(--serious); }
.flag .ic.ok { background: var(--good); }
.flag .n { flex: none; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; padding-top: 1px; }

.legend { display: flex; gap: 16px; flex-wrap: wrap; margin: 0 0 10px; font-size: 12.5px; color: var(--ink-2); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.swatch { width: 11px; height: 11px; border-radius: 3px; flex: none; }

.scroll { overflow-x: auto; }
svg { display: block; max-width: 100%; height: auto; }
.grid-line { stroke: var(--grid); stroke-width: 1; }
.axis-line { stroke: var(--axis); stroke-width: 1; }
.tick { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.axis-title { fill: var(--muted); font-size: 11px; }
.dlabel { font-size: 11.5px; font-weight: 600; }

table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
th { text-align: left; font-weight: 600; color: var(--ink-2); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; padding: 0 10px 8px 0; border-bottom: 1px solid var(--border); white-space: nowrap; }
td { padding: 7px 10px 7px 0; border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; }
tr:last-child td { border-bottom: 0; }
td.name { font-variant-numeric: normal; }
.num { text-align: right; }
.bar-cell { width: 34%; min-width: 110px; }
.bar-track { height: 9px; background: var(--grid); border-radius: 4px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 4px; background: var(--seq-4); }
.pill { display: inline-block; font-size: 11.5px; padding: 1px 7px; border-radius: 20px; border: 1px solid var(--border); color: var(--ink-2); }
.pill.live { color: var(--good-text); border-color: currentColor; }

.empty { color: var(--muted); font-size: 13.5px; padding: 8px 0; }
.foot { color: var(--muted); font-size: 12px; margin-top: 30px; border-top: 1px solid var(--border); padding-top: 16px; }
.foot p { margin: 0 0 6px; max-width: 76ch; }
code, kbd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }

.tip { position: fixed; pointer-events: none; z-index: 10; background: var(--surface); color: var(--ink); border: 1px solid var(--axis); border-radius: 8px; padding: 8px 10px; font-size: 12.5px; box-shadow: 0 4px 14px rgba(0,0,0,0.16); opacity: 0; transition: opacity 0.09s; max-width: 250px; }
.tip.on { opacity: 1; }
.tip .tt { font-weight: 620; margin-bottom: 4px; }
.tip .tr { display: flex; justify-content: space-between; gap: 14px; font-variant-numeric: tabular-nums; }
.tip .tr span:first-child { color: var(--ink-2); }
.hit { fill: transparent; cursor: crosshair; }
.cross { stroke: var(--axis); stroke-width: 1; stroke-dasharray: 3 3; }

.field select:focus-visible, a:focus-visible {
  outline: 2px solid var(--player);
  outline-offset: 2px;
}

/* The only motion on the page is the tooltip fade. Honour the setting anyway:
   a reader who asked for no motion gets none, and an instant tooltip is no
   worse than a faded one. */
@media (prefers-reduced-motion: reduce) {
  .tip { transition: none; }
}

@media (max-width: 620px) {
  .wrap { padding: 20px 14px 48px; }
  .kpi.hero .v { font-size: 36px; }
}
`;

// ---------------------------------------------------------------------------
// The page's own script. A template string in this file, so it ships verbatim.
// ---------------------------------------------------------------------------
const PAGE_SCRIPT = String.raw`
const $ = (s) => document.querySelector(s);
const fmtPct = (v) => (v * 100).toFixed(0) + '%';
// Every branch returns a STRING. The middle one used to return a bare number,
// which is invisible everywhere it lands in a template and throws only where
// it is passed to a DOM helper as a child.
const fmtNum = (v) => v >= 10000 ? Math.round(v).toLocaleString() : v >= 100 ? String(Math.round(v)) : v.toFixed(1);

const SVG = 'http://www.w3.org/2000/svg';

// Anything that is not already a node becomes text. A number, a Date, a value
// some formatter forgot to stringify: all of them are things a reader should
// SEE, and none of them is a reason for the section to vanish. appendChild
// throws on a non-Node, and because each section is built before it is
// attached, one such value takes out the whole panel rather than one cell.
function child(c) {
  return c instanceof Node ? c : document.createTextNode(String(c));
}
function kidsOf(kids) {
  return [].concat(kids).filter((c) => c !== null && c !== undefined && c !== false);
}

function el(tag, attrs = {}, kids = []) {
  const n = document.createElementNS(SVG, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  for (const c of kidsOf(kids)) n.appendChild(child(c));
  return n;
}
function h(tag, attrs = {}, kids = []) {
  const n = document.createElement(tag);
  for (const k in attrs) {
    if (k === 'class') n.className = attrs[k];
    else if (k === 'html') n.innerHTML = attrs[k];
    else n.setAttribute(k, attrs[k]);
  }
  for (const c of kidsOf(kids)) n.appendChild(child(c));
  return n;
}

// --- tooltip -------------------------------------------------------------
const tip = h('div', { class: 'tip' });
document.body.appendChild(tip);
function showTip(x, y, title, rows) {
  tip.innerHTML = '';
  tip.appendChild(h('div', { class: 'tt' }, title));
  for (const [k, v] of rows) {
    tip.appendChild(h('div', { class: 'tr' }, [h('span', {}, k), h('span', {}, v)]));
  }
  tip.classList.add('on');
  const r = tip.getBoundingClientRect();
  // Flip before the edge rather than after, so the tip never induces a
  // horizontal scrollbar on the page it is describing.
  const left = x + 14 + r.width > innerWidth ? x - r.width - 14 : x + 14;
  const top = Math.min(Math.max(8, y - r.height / 2), innerHeight - r.height - 8);
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}
const hideTip = () => tip.classList.remove('on');

// --- filters -------------------------------------------------------------
const builds = [...new Set(RUNS.map((r) => r.meta?.build ?? 'unknown'))].sort();
const clients = [...new Set(RUNS.map((r) => r.meta?.client ?? 'unknown'))].sort();

function fillSelect(sel, values, allLabel, counts) {
  sel.appendChild(h('option', { value: 'all' }, allLabel));
  for (const v of values) {
    sel.appendChild(h('option', { value: v }, v + (counts ? '  (' + counts.get(v) + ')' : '')));
  }
}
const countBy = (key) => {
  const m = new Map();
  for (const r of RUNS) { const k = key(r); m.set(k, (m.get(k) ?? 0) + 1); }
  return m;
};
fillSelect($('#f-build'), builds, 'All builds', countBy((r) => r.meta?.build ?? 'unknown'));
fillSelect($('#f-client'), clients, 'All browsers', countBy((r) => r.meta?.client ?? 'unknown'));

function selected() {
  const b = $('#f-build').value, s = $('#f-source').value, c = $('#f-client').value;
  return RUNS.filter((r) =>
    (b === 'all' || (r.meta?.build ?? 'unknown') === b) &&
    (s === 'all' || r.source === s) &&
    (c === 'all' || (r.meta?.client ?? 'unknown') === c));
}

for (const id of ['#f-build', '#f-source', '#f-client']) $(id).addEventListener('change', render);

// --- charts --------------------------------------------------------------
const W = 640, H = 210;

// The left gutter has to hold the widest tick, and a growth multiple reaches
// three digits ("150.6x") where a percentage never does — at 40px the leading
// digit was sliced off. The right gutter holds the direct labels, which only
// exist on a multi-series chart; a single-series chart gets the space back as
// plot rather than as blank margin.
function padFor(series) {
  return { t: 14, r: series.length > 1 ? 74 : 22, b: 30, l: 54 };
}

function axes(svg, xMax, yMax, yFmt, xLabel, PAD) {
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = (yMax / steps) * i;
    const y = PAD.t + ih - (v / yMax) * ih;
    svg.appendChild(el('line', { class: i === 0 ? 'axis-line' : 'grid-line', x1: PAD.l, y1: y, x2: W - PAD.r, y2: y }));
    svg.appendChild(el('text', { class: 'tick', x: PAD.l - 7, y: y + 3.5, 'text-anchor': 'end' }, yFmt(v)));
  }
  const xStep = Math.max(1, Math.ceil(xMax / 8));
  for (let m = 0; m <= xMax; m += xStep) {
    const x = PAD.l + (xMax ? (m / xMax) * iw : 0);
    svg.appendChild(el('text', { class: 'tick', x, y: H - PAD.b + 15, 'text-anchor': 'middle' }, String(m)));
  }
  svg.appendChild(el('text', { class: 'axis-title', x: PAD.l + iw / 2, y: H - 2, 'text-anchor': 'middle' }, xLabel));
  return { iw, ih };
}

// A line chart with a crosshair. The series argument is [{key,label,color}];
// every chart on this page shares one hover implementation, so they behave
// identically. No backticks anywhere below this line — the whole block is a
// String.raw template in playtest-atlas.mjs, and one would end it early with
// an error that points at the comment rather than at the cause.
function lineChart(rows, series, opts) {
  const box = h('div', { class: 'scroll' });
  if (!rows.length) { box.appendChild(h('p', { class: 'empty' }, 'No buckets in range.')); return box; }

  const PAD = padFor(series);
  const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': opts.aria });
  const xMax = Math.max(1, ...rows.map((r) => r.x));
  // The parens are load-bearing: ?? cannot sit beside || unparenthesised, and
  // the whole module is a SyntaxError if it does.
  const yMax = opts.yMax ?? (Math.max(...rows.flatMap((r) => series.map((s) => r[s.key] ?? 0))) * 1.15 || 1);
  const { iw, ih } = axes(svg, xMax, yMax, opts.yFmt, opts.xLabel, PAD);
  const X = (v) => PAD.l + (v / xMax) * iw;
  const Y = (v) => PAD.t + ih - Math.min(1, v / yMax) * ih;

  if (opts.ref != null && opts.ref <= yMax) {
    svg.appendChild(el('line', { class: 'cross', x1: PAD.l, y1: Y(opts.ref), x2: W - PAD.r, y2: Y(opts.ref) }));
    svg.appendChild(el('text', { class: 'tick', x: W - PAD.r, y: Y(opts.ref) - 5, 'text-anchor': 'end' }, opts.refLabel));
  }

  for (const s of series) {
    const pts = rows.map((r) => X(r.x) + ',' + Y(r[s.key] ?? 0)).join(' ');
    svg.appendChild(el('polyline', { points: pts, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    // A single point draws no line — mark it so a one-bucket filter isn't blank.
    if (rows.length === 1) svg.appendChild(el('circle', { cx: X(rows[0].x), cy: Y(rows[0][s.key] ?? 0), r: 4, fill: s.color }));
    const last = rows[rows.length - 1];
    if (series.length > 1) {
      svg.appendChild(el('text', { class: 'dlabel', x: X(last.x) + 5, y: Y(last[s.key] ?? 0) + 4, fill: s.color }, s.label));
    }
  }

  const cross = el('line', { class: 'cross', y1: PAD.t, y2: PAD.t + ih, opacity: 0 });
  svg.appendChild(cross);
  const hit = el('rect', { class: 'hit', x: PAD.l, y: PAD.t, width: iw, height: ih });
  svg.appendChild(hit);
  hit.addEventListener('pointermove', (e) => {
    const bb = svg.getBoundingClientRect();
    const px = ((e.clientX - bb.left) / bb.width) * W;
    let best = rows[0];
    for (const r of rows) if (Math.abs(X(r.x) - px) < Math.abs(X(best.x) - px)) best = r;
    cross.setAttribute('x1', X(best.x)); cross.setAttribute('x2', X(best.x)); cross.setAttribute('opacity', 1);
    showTip(e.clientX, e.clientY, opts.tipTitle(best), opts.tipRows(best));
  });
  hit.addEventListener('pointerleave', () => { cross.setAttribute('opacity', 0); hideTip(); });

  box.appendChild(svg);
  return box;
}

function legend(series) {
  return h('div', { class: 'legend' }, series.map((s) =>
    h('span', {}, [h('i', { class: 'swatch', style: 'background:' + s.color }), s.label])));
}

// --- sections ------------------------------------------------------------
function kpis(agg, runs) {
  const live = runs.filter((r) => r.source === 'live').length;
  const bs = new Set(runs.map((r) => r.meta?.build ?? 'unknown'));
  const cs = new Set(runs.map((r) => r.meta?.client ?? 'unknown'));
  const wrap = h('div', { class: 'kpis' });
  const add = (k, v, x, hero) => wrap.appendChild(
    h('div', { class: 'kpi' + (hero ? ' hero' : '') }, [
      h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), x ? h('div', { class: 'x' }, x) : null]));

  add('Median survival', agg.usableCount ? formatClock(agg.medianSurvival) : '—',
    agg.usableCount ? formatClock(agg.survivalSpread[0]) + '–' + formatClock(agg.survivalSpread[1]) : 'no judged runs', true);
  add('Runs', String(agg.runCount), agg.usableCount + ' long enough to judge');
  add('From live site', String(live), live === runs.length ? 'all of them' : (runs.length - live) + ' from dev');
  add('Builds', String(bs.size), [...bs].slice(0, 2).join(', ') + (bs.size > 2 ? '…' : ''));
  add('Browsers', String(cs.size), cs.size === 1 ? 'one player' : 'distinct clients');
  return wrap;
}

function flagsSection(agg) {
  const s = h('section');
  s.appendChild(h('h2', {}, 'What the runs flag'));
  s.appendChild(h('p', { class: 'note' }, agg.confident
    ? 'Each line fired in the number of runs shown. Verdicts come from playtestAnalysis.js.'
    : 'Fewer than 3 judged runs — these are hints, not verdicts.'));
  if (!agg.flags.length) { s.appendChild(h('p', { class: 'empty' }, 'Nothing flagged.')); return s; }
  const ul = h('ul', { class: 'flags' });
  for (const f of agg.flags) {
    const cls = f.level === 'bad' ? 'bad' : 'warn';
    ul.appendChild(h('li', { class: 'flag' }, [
      h('i', { class: 'ic ' + cls, 'aria-hidden': 'true' }, '!'),
      h('span', { class: 'n' }, f.runs + '/' + agg.runCount),
      h('span', {}, f.text),
    ]));
  }
  s.appendChild(ul);
  return s;
}

function curveSection(agg) {
  const s = h('section');
  s.appendChild(h('h2', {}, 'Power curves — you vs the water'));
  s.appendChild(h('p', { class: 'note' },
    'Both lines are growth multiples against their own first minute, not raw units — that is what lets output and pressure share one axis honestly. If the orange line pulls away, enemy scaling is outrunning the build.'));
  const base = agg.timeline[0];
  if (!base) { s.appendChild(h('p', { class: 'empty' }, 'No timeline yet.')); return s; }
  const rows = agg.timeline.map((t) => ({
    x: t.minute,
    player: base.dps > 0 ? t.dps / base.dps : 0,
    enemy: base.pressure > 0 ? t.pressure / base.pressure : 0,
    raw: t,
  }));
  const series = [
    { key: 'player', label: 'You', color: 'var(--player)' },
    { key: 'enemy', label: 'Enemies', color: 'var(--enemy)' },
  ];
  s.appendChild(legend(series));
  s.appendChild(lineChart(rows, series, {
    aria: 'Player output and enemy pressure as growth multiples per minute',
    xLabel: 'minute', yFmt: (v) => v.toFixed(1) + 'x', ref: 1, refLabel: 'start',
    tipTitle: (r) => 'Minute ' + r.x,
    tipRows: (r) => [
      ['Your output', r.player.toFixed(2) + 'x'],
      ['Enemy pressure', r.enemy.toFixed(2) + 'x'],
      ['DPS', fmtNum(r.raw.dps)],
      ['Runs here', String(r.raw.runs)],
    ],
  }));
  return s;
}

function clearSection(agg) {
  const s = h('section');
  s.appendChild(h('h2', {}, 'Clear rate and health floor'));
  s.appendChild(h('p', { class: 'note' },
    'Clear rate is enemy hp killed over enemy hp arriving: below 1.0x the arena is filling faster than it empties. Health is the median fraction the player held that minute.'));
  const rows = agg.timeline.map((t) => ({ x: t.minute, clear: t.clearRatio, hp: t.avgHpFrac, raw: t }));
  if (!rows.length) { s.appendChild(h('p', { class: 'empty' }, 'No timeline yet.')); return s; }
  s.appendChild(lineChart(rows, [{ key: 'clear', label: 'Clear rate', color: 'var(--player)' }], {
    aria: 'Clear rate per minute', xLabel: 'minute', yFmt: (v) => v.toFixed(1) + 'x',
    ref: 1, refLabel: 'breaking even',
    tipTitle: (r) => 'Minute ' + r.x,
    tipRows: (r) => [['Clear rate', r.clear.toFixed(2) + 'x'], ['Lethal/min', fmtNum(r.raw.lethalPerMin)], ['Runs here', String(r.raw.runs)]],
  }));
  s.appendChild(h('p', { class: 'note', style: 'margin-top:14px' }, 'Median health held:'));
  s.appendChild(lineChart(rows, [{ key: 'hp', label: 'Health', color: 'var(--player)' }], {
    aria: 'Median player health fraction per minute', xLabel: 'minute',
    // Exactly 1, not 1.05 headroom: a fraction axis wants to read 0/25/50/75/
    // 100%, and the headroom turned every tick into an odd number.
    yFmt: fmtPct, yMax: 1,
    tipTitle: (r) => 'Minute ' + r.x,
    tipRows: (r) => [['Health held', fmtPct(r.hp)], ['Runs here', String(r.raw.runs)]],
  }));
  return s;
}

function abilitySection(agg) {
  const s = h('section');
  s.appendChild(h('h2', {}, 'Where the damage came from'));
  s.appendChild(h('p', { class: 'note' },
    'Return is damage share over investment share: 1.0x means an ability paid back exactly the picks spent on it. Sources with no picks are baseline, not build choices.'));
  const rows = agg.abilities.filter((a) => a.damage > 0);
  if (!rows.length) { s.appendChild(h('p', { class: 'empty' }, 'No damage recorded.')); return s; }
  const max = Math.max(...rows.map((a) => a.damageShare));
  const t = h('table');
  t.appendChild(h('thead', {}, h('tr', {}, [
    h('th', {}, 'Ability'), h('th', { class: 'bar-cell' }, 'Damage share'),
    h('th', { class: 'num' }, 'Damage'), h('th', { class: 'num' }, 'Return'), h('th', { class: 'num' }, 'Runs'),
  ])));
  const tb = h('tbody');
  for (const a of rows) {
    const bar = h('div', { class: 'bar-track' }, h('div', {
      class: 'bar-fill', style: 'width:' + Math.max(2, (a.damageShare / max) * 100) + '%',
    }));
    const cell = h('td', { class: 'bar-cell' }, [bar]);
    cell.title = fmtPct(a.damageShare);
    const tr = h('tr', {}, [
      h('td', { class: 'name' }, a.label ?? a.source),
      cell,
      h('td', { class: 'num' }, fmtPct(a.damageShare)),
      h('td', { class: 'num' }, a.investShare > 0 ? a.efficiency.toFixed(2) + 'x' : '—'),
      h('td', { class: 'num' }, String(a.runs)),
    ]);
    tr.addEventListener('pointermove', (e) => showTip(e.clientX, e.clientY, a.label ?? a.source, [
      ['Damage', fmtNum(a.damage)],
      ['Share of all damage', fmtPct(a.damageShare)],
      ['Share of investment', a.investShare > 0 ? fmtPct(a.investShare) : 'none'],
      ['Per stack-minute', fmtNum(a.dpsPerStackMinute)],
    ]));
    tr.addEventListener('pointerleave', hideTip);
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  s.appendChild(h('div', { class: 'scroll' }, t));
  return s;
}

function threatSection(runs) {
  const s = h('section');
  s.appendChild(h('h2', {}, 'What actually hurt'));
  s.appendChild(h('p', { class: 'note' }, 'Damage dealt to the player, pooled across the runs in view.'));
  const total = new Map();
  for (const r of runs) {
    for (const b of r.buckets ?? []) {
      for (const k in b.takenBySource ?? {}) total.set(k, (total.get(k) ?? 0) + b.takenBySource[k]);
    }
  }
  const rows = [...total.entries()].map(([source, damage]) => ({ source, damage })).sort((a, b) => b.damage - a.damage);
  if (!rows.length) { s.appendChild(h('p', { class: 'empty' }, 'Nothing hurt the player.')); return s; }
  const sum = rows.reduce((a, b) => a + b.damage, 0);
  const max = rows[0].damage;
  const t = h('table');
  t.appendChild(h('thead', {}, h('tr', {}, [
    h('th', {}, 'Source'), h('th', { class: 'bar-cell' }, 'Share'), h('th', { class: 'num' }, 'Damage'), h('th', { class: 'num' }, 'Share'),
  ])));
  const tb = h('tbody');
  for (const r of rows.slice(0, 12)) {
    tb.appendChild(h('tr', {}, [
      h('td', { class: 'name' }, sourceLabel(r.source)),
      h('td', { class: 'bar-cell' }, h('div', { class: 'bar-track' },
        h('div', { class: 'bar-fill', style: 'width:' + Math.max(2, (r.damage / max) * 100) + '%; background: var(--enemy)' }))),
      h('td', { class: 'num' }, fmtNum(r.damage)),
      h('td', { class: 'num' }, fmtPct(r.damage / sum)),
    ]));
  }
  t.appendChild(tb);
  s.appendChild(h('div', { class: 'scroll' }, t));
  return s;
}

function runTable(runs, singles) {
  const s = h('section');
  s.appendChild(h('h2', {}, 'Every run'));
  s.appendChild(h('p', { class: 'note' }, 'Newest first. Runs below ' + MIN_JUDGED + 's are listed but excluded from the aggregate above.'));
  const t = h('table');
  t.appendChild(h('thead', {}, h('tr', {}, [
    h('th', {}, 'When'), h('th', {}, 'Source'), h('th', {}, 'Build'),
    h('th', { class: 'num' }, 'Survived'), h('th', { class: 'num' }, 'Level'),
    h('th', { class: 'num' }, 'Kills'), h('th', { class: 'num' }, 'Score'), h('th', {}, 'Ended'),
  ])));
  const tb = h('tbody');
  const order = [...singles].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  for (const a of order) {
    const run = runs.find((r) => r.id === a.id);
    const when = a.startedAt ? new Date(a.startedAt) : null;
    tb.appendChild(h('tr', {}, [
      h('td', { class: 'name' }, when ? when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'),
      h('td', { class: 'name' }, h('span', { class: 'pill' + (run?.source === 'live' ? ' live' : '') }, run?.source ?? '—')),
      h('td', { class: 'name' }, h('code', {}, run?.meta?.build ?? 'unknown')),
      h('td', { class: 'num' }, formatClock(a.duration)),
      h('td', { class: 'num' }, String(a.level)),
      h('td', { class: 'num' }, String(a.kills)),
      h('td', { class: 'num' }, a.score ? a.score.toLocaleString() : '0'),
      h('td', { class: 'name' }, a.endReason),
    ]));
  }
  t.appendChild(tb);
  s.appendChild(h('div', { class: 'scroll' }, t));
  return s;
}

// --- render --------------------------------------------------------------
function render() {
  const runs = selected();
  const body = $('#body');
  body.innerHTML = '';

  $('#stamp-count').textContent = runs.length + ' of ' + RUNS.length + ' runs';

  if (!runs.length) {
    body.appendChild(h('section', {}, h('p', { class: 'empty' }, 'No runs match these filters.')));
    return;
  }

  const agg = analyzeRuns(runs);
  const mixed = new Set(runs.map((r) => r.meta?.build ?? 'unknown')).size > 1;
  $('#filter-note').textContent = mixed
    ? 'Showing more than one build — runs from different builds describe different games. Filter to one before drawing conclusions.'
    : 'One build in view.';

  body.appendChild(kpis(agg, runs));
  body.appendChild(flagsSection(agg));
  body.appendChild(curveSection(agg));
  body.appendChild(clearSection(agg));
  body.appendChild(abilitySection(agg));
  body.appendChild(threatSection(runs));
  body.appendChild(runTable(runs, agg.runs));
}

// OPENS ON THE NEWEST BUILD, not on everything.
//
// "All builds" is the wrong first thing to show, for two reasons that both bite
// hard. Runs from different builds describe different games, so any pooled
// number is an average over rules that were never simultaneously true. And the
// archive carries runs recorded before the recorder clamped SENTINEL HP: a
// seaTurtle enters with 1e9 hp, so whatever killed one booked a billion damage
// and took every other ability in the pool to a 0% share. One such run is
// enough to make the damage table read as though a single source did
// everything.
//
// Both are still reachable from the filter, with the warning above the charts.
// The default just isn't the view that needs a caveat to read correctly.
const newestBuild = RUNS.reduce((best, r) =>
  (r.startedAt ?? 0) > (best.startedAt ?? 0) ? r : best, RUNS[0])?.meta?.build;
if (newestBuild && builds.includes(newestBuild)) $('#f-build').value = newestBuild;

$('#stamp-date').textContent = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
$('#subtitle').textContent = 'Seal Survivor — ' + RUNS.length + ' collected run' + (RUNS.length === 1 ? '' : 's');
render();
`;

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
