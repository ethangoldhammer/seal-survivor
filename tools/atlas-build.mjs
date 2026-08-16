#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Builds the Model Atlas page: template + measured data + rendered portraits.
//
//   node --import ./tools/vite-loader.mjs tools/atlas-data.mjs --out <dir>
//   node tools/atlas-render/server.mjs --out <dir>/renders    (then open
//     http://localhost:4599/render.html with <dir>/list.json copied alongside)
//   node tools/atlas-build.mjs --data <dir> --renders <dir>/renders [--out f]
//
// THE PAGE IS A TEMPLATE PLUS ONE JSON BLOB. Every stat tile, the scale
// lineup, the ledger, every plate and the findings are built client-side from
// `<script id="atlas-data">`; nothing is baked into the markup. So updating the
// atlas is: re-measure, re-render, re-inject. Editing a number in the page by
// hand puts it out of step with the game while still looking authoritative,
// which is the one failure this whole arrangement exists to prevent.
//
// TWO CONSTRAINTS THE PUBLISHED PAGE DEPENDS ON:
//
//   PURE ASCII. The Artifact wrapper owns <head> and sets no charset, so a
//   stray non-ASCII byte renders as mojibake. The template uses HTML entities
//   and this re-encodes the JSON with \uXXXX escapes. Asserted before writing.
//
//   NO requestAnimationFrame. rAF never fires in a backgrounded tab, so the
//   page draws everything synchronously. Nothing here can reintroduce that,
//   but it is why the template looks the way it does.
//
// Renders are read off disk and embedded as data URIs. They are downscaled
// BEFORE they get here (sips -Z 340): at full size the set is 20MB, which is
// over the 16MB artifact cap once base64 adds a third.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const DATA = resolve(arg('--data', join(HERE, 'atlas-render/data')));
const RENDERS = resolve(arg('--renders', join(DATA, 'renders')));
const OUT = resolve(arg('--out', join(DATA, 'atlas.html')));
const TEMPLATE = join(HERE, 'atlas.template.html');

const blob = JSON.parse(readFileSync(join(DATA, 'rows.json'), 'utf8'));

// --- portraits -------------------------------------------------------------
let embedded = 0;
const missing = [];
for (const row of blob.rows) {
  const png = join(RENDERS, `${row.key}.png`);
  if (!existsSync(png)) { missing.push(row.key); row.render = null; continue; }
  row.render = `data:image/png;base64,${readFileSync(png).toString('base64')}`;
  embedded += 1;
}
const extra = readdirSync(RENDERS).filter((f) => f.endsWith('.png'))
  .map((f) => basename(f, '.png'))
  .filter((k) => !blob.rows.some((r) => r.key === k));

// --- masthead and changelog ------------------------------------------------
// Passed in rather than invented: what changed since the last revision is the
// one thing on this page a measuring pass cannot know.
const NOTES = existsSync(join(DATA, 'notes.json'))
  ? JSON.parse(readFileSync(join(DATA, 'notes.json'), 'utf8'))
  : null;

let page = readFileSync(TEMPLATE, 'utf8');

if (NOTES?.eyebrow) {
  page = page.replace(/(<p class="eyebrow">)[^<]*(<\/p>)/, `$1${NOTES.eyebrow}$2`);
}
if (NOTES?.entries?.length) {
  const html = NOTES.entries
    .map((e) => `\n    <b>${e.label}</b>\n    <span>${e.body}</span>`)
    .join('');
  page = page.replace('<div class="changelog">', `<div class="changelog">${html}`);
}

// JSON.stringify does not escape non-ASCII, so do it here rather than trusting
// every string that ever reaches this blob to be plain.
const json = JSON.stringify(blob).replace(/[-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
page = page.replace('__ATLAS_DATA__', () => json);

if (!/^[\x00-\x7f]*$/.test(page)) {
  const bad = [...page].find((c) => c.charCodeAt(0) > 127);
  console.error(`REFUSING: the page is not pure ASCII (found ${JSON.stringify(bad)}).`);
  console.error('The Artifact wrapper sets no charset, so this would ship as mojibake.');
  process.exit(1);
}

writeFileSync(OUT, page);
const mb = Buffer.byteLength(page) / 1048576;
console.log(`${blob.rows.length} models, ${blob.shapes.length} procedural, ${embedded} portraits embedded`);
if (missing.length) console.log(`no portrait for: ${missing.join(', ')}`);
if (extra.length) console.log(`renders with no row (stale): ${extra.join(', ')}`);
console.log(`${OUT}  ${mb.toFixed(2)} MB${mb > 15 ? '  <-- over the 16MB artifact cap' : ''}`);
