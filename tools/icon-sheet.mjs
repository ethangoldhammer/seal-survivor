#!/usr/bin/env node
// Every upgrade icon on one page, on the hive's own colour, at the size it is
// actually looked at.
//
//   npm run icons:sheet -- <shots-dir> [out.png] [cell-px]
//
// THE ONLY WAY TO JUDGE THESE. An icon is not right or wrong on its own; it is
// right or wrong next to the other forty-six. Six of the roster are pale marine
// mammals and a third of it is the same thrown stone in a different
// arrangement, so "can I tell these two apart" is a question that can only be
// asked of the set — and it has to be asked at 56px, because that is the size
// of a hive tile. Opening the PNGs one at a time answers a different question
// and answers it reassuringly.
//
// Reads icons.json rather than the directory, so the sheet is in the spec's
// order (families, as the picker groups them) and a leftover render from a
// deleted upgrade cannot appear on it.
import sharp from 'sharp';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const [dirArg, outArg, cellArg] = process.argv.slice(2);
if (!dirArg) {
  console.error('usage: npm run icons:sheet -- <shots-dir> [out.png] [cell-px]');
  console.error('  the shots dir is whatever you passed to atlas-render/server.mjs --out');
  process.exit(1);
}
const OUT = outArg ?? join(dirArg, 'sheet.png');
const CELL = Number(cellArg ?? 128);

const specs = JSON.parse(await readFile(join(HERE, 'atlas-render/icons.json'), 'utf8'))
  .filter((s) => s.kind === 'scene' || s.kind === 'render');
const onDisk = new Set(await readdir(dirArg));
const rows = specs.filter((s) => onDisk.has(`${s.key}.png`));
const absent = specs.filter((s) => !onDisk.has(`${s.key}.png`)).map((s) => s.key);

const COLS = 6, PAD = 10, LABEL = 16;
const cw = CELL + PAD * 2, ch = CELL + PAD * 2 + LABEL;
const W = COLS * cw, H = Math.ceil(rows.length / COLS) * ch;

const layers = [];
const labels = [];
for (let i = 0; i < rows.length; i++) {
  const x = (i % COLS) * cw + PAD, y = Math.floor(i / COLS) * ch + PAD;
  // `contain` on a transparent background, so a wide icon is not stretched into
  // reading as a bigger one than it is — the same reason the renderer pads its
  // crop back out to a square before downsampling.
  layers.push({
    input: await sharp(join(dirArg, `${rows[i].key}.png`))
      .resize(CELL, CELL, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png().toBuffer(),
    left: x, top: y,
  });
  labels.push(`<text x="${x + CELL / 2}" y="${y + CELL + 12}" fill="#9fc4d8" `
    + `font-family="monospace" font-size="10" text-anchor="middle">${rows[i].key}</text>`);
}
layers.push({ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${labels.join('')}</svg>`), left: 0, top: 0 });

await sharp({ create: { width: W, height: H, channels: 4, background: { r: 14, g: 28, b: 42, alpha: 1 } } })
  .composite(layers).png().toFile(OUT);

console.log(`${rows.length} icons -> ${OUT} (${W}x${H}, ${CELL}px cells)`);
if (absent.length) console.log(`  NOT RENDERED: ${absent.join(', ')}`);
