#!/usr/bin/env node
// ============================================================================
// THE CONTACT SHEET — every species in fish.mesh, on the table, one frame
// each, so a creature can be picked by looking rather than by name.
//
// Each frame is the real thing: the whole scene rendered headless with
// `--data=lab=<species>`, which table.luau reads as "that species on every
// card" and deals a fixed seed for, so the same seven faces show each one —
// the 2-10 as a school of it, the court as one of it. Through the tank's own
// cel shading, outline, glass and rim, at the size a card gives it. A model
// viewer would show the mesh; this shows the card.
//
//   node tools/sealitaire-sheet.mjs                every species in the pack
//   node tools/sealitaire-sheet.mjs orca_male whale  just these
//
// Writes rive/sealitaire/build/sheet/<species>.png and an index.html beside
// them. Bake the pool first (`npm run sealitaire:pool`) or the sheet is only
// what tanks.csv already uses. About a second a species.
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = join(ROOT, 'rive/sealitaire');
const OUT = join(PROJECT, 'build/sheet');
const RIVE = process.env.RIVE_CLI || join(process.env.HOME ?? '', '.rive/bin/rive');

// The pack's species, from fish.mesh's own header (tools/sealitaire-fish.mjs).
function packSpecies() {
  const data = readFileSync(join(PROJECT, 'fish.mesh'));
  if (data.toString('latin1', 0, 4) !== 'TNK3') throw new Error('fish.mesh is not a tank pack; run npm run sealitaire:pool');
  const n = data.readUInt32LE(4);
  const names = [];
  // Header 32 bytes, then one 80-byte species record each — the TNK3 layout
  // at the top of tools/sealitaire-fish.mjs. This read was still on the
  // pre-TNK3 header and threw on every pack the baker writes.
  for (let k = 0; k < n; k++) {
    const r = 32 + k * 80;
    const name = data.toString('latin1', r, r + 24).replace(/\0.*$/, '');
    if (name !== 'bubble') names.push(name);
  }
  return names.sort();
}

// Who uses what today, for the caption.
function usedBy() {
  const rows = readFileSync(join(PROJECT, 'tanks.csv'), 'utf8').split('\n').slice(1);
  const by = new Map();
  for (const line of rows) {
    const [card, model] = line.split(',');
    if (!card || !model) continue;
    if (!by.has(model)) by.set(model, []);
    by.get(model).push(card);
  }
  return by;
}

const want = process.argv.slice(2);
const all = packSpecies();
const missing = want.filter((w) => !all.includes(w));
if (missing.length) { console.error(`not in fish.mesh: ${missing.join(' ')} (run npm run sealitaire:pool)`); process.exit(1); }
const list = want.length ? want : all;
mkdirSync(OUT, { recursive: true });

const uses = usedBy();
const t0 = Date.now();
for (const name of list) {
  const png = join(OUT, `${name}.png`);
  execFileSync(RIVE, [PROJECT, `--screenshot=${png}`, '--viewport=1600x1000', '--advance=90', `--data=lab=${name}`], { stdio: ['ignore', 'ignore', 'inherit'] });
  // The strip: the tableau's band of the frame, so the sheet is cards and not
  // water. At 1600x1000 the seven columns sit at x 290..1310, y 330..600
  // (layout.luau's reference numbers); the full frame stays behind the link.
  execFileSync('/usr/bin/sips', ['-c', '270', '1020', '--cropOffset', '330', '290', png, '--out', join(OUT, `${name}-strip.png`)], { stdio: 'ignore' });
  console.log(`${name.padEnd(16)} ${(uses.get(name) || []).join(', ')}`);
}

// The page: tooling, not a player's screen.
const cards = all.map((name) => {
  const used = uses.get(name) || [];
  return `<figure${used.length ? ' class="used"' : ''}><a href="${name}.png"><img loading="lazy" src="${name}-strip.png" alt="${name}"></a><figcaption><b>${name}</b>${used.length ? `<span>${used.join(', ')}</span>` : ''}</figcaption></figure>`;
}).join('\n');
writeFileSync(join(OUT, 'index.html'), `<!doctype html>
<meta charset="utf-8">
<title>Sealitaire tank sheet</title>
<style>
  body { margin: 0; padding: 16px; background: #07182b; color: #b9d4ee; font: 12px/1.4 ui-monospace, Menlo, monospace; }
  h1 { font-size: 14px; font-weight: 600; margin: 0 0 12px; color: #f5b02e; }
  h1 small { color: #6f8fb0; font-weight: 400; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(620px, 1fr)); gap: 12px; }
  figure { margin: 0; background: #0b2238; border: 1px solid #16324c; border-radius: 6px; overflow: hidden; }
  figure.used { border-color: #f5b02e88; }
  img { display: block; width: 100%; aspect-ratio: 1020 / 270; }
  figcaption { display: flex; justify-content: space-between; gap: 8px; padding: 6px 8px; }
  figcaption b { color: #f6f1e7; }
  figcaption span { color: #6f8fb0; }
</style>
<h1>Sealitaire tank sheet <small>${all.length} species in fish.mesh · amber = on a card in tanks.csv · the same deal on every frame · click for the whole table</small></h1>
<div class="grid">
${cards}
</div>
`);
console.log(`wrote ${OUT}/index.html: ${list.length} of ${all.length} species in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
