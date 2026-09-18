#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE CONTROLLER MARKS — bake a directory of drawn icons into the game.
//
//   npm run device:icons                       what it is looking for, and what it has
//   npm run device:icons -- --bake <dir>       embed everything in that directory
//   npm run device:icons -- --bake <dir> --strict   refuse unless all five are there
//
// FIVE KEYS, AND THEY ARE NOT A LIST HERE. They are ui/padBrand.js's answers
// plus the keyboard, imported rather than restated: a sixth brand added to the
// detector is a sixth icon this asks for on the next run, with nothing to
// forget and no way for the two lists to drift apart. That is the mistake the
// accessory bake's header describes having made once already.
//
// A DRAWING, NOT A RENDER, which is why this is a dozen lines against
// accessory-icons.mjs's several hundred. There is no mesh to shoot and no
// browser needed: a controller mark is a drawn thing, so the pipeline is
// read a file, base64 it, write the module.
//
// PARTIAL IS FINE BY DEFAULT. Three of five is three chips with a proper mark
// and two still on their glyph, which is a better screen than the one before
// and a perfectly reasonable place to stop for a night. --strict is for the
// run that is meant to be complete, and it writes nothing rather than half.
//
// IT IS A FULL OVERWRITE, the same contract the other two bakes have: what is
// in the directory is what ends up in the module, so a key removed from the
// directory is a key removed from the game. Anything else and a file deleted
// on purpose lives on in a generated module nobody reads.
// ---------------------------------------------------------------------------
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICON_FORMATS, ICON_EXTS, extOf, mimeFor } from './atlas-render/icon-formats.mjs';
import { PAD_BRANDS } from '../path/src/ui/padBrand.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_OUT = join(HERE, '../path/src/ui/deviceIcons.js');
// Where the art lives when nobody says otherwise. In the repo rather than in
// _DesignSystems, deliberately: five files of under 2KB each, and a bake whose
// input is a folder on one person's Mac is a bake nobody else can re-run.
const DEFAULT_DIR = join(HERE, '../art/device-icons');

// The keyboard is not a brand — nothing detects it, it is simply the one device
// in the room that is not a controller — so it is added here rather than living
// in PAD_BRANDS, where a detector would have to pretend it could return it.
const KEYS = ['keyboard', ...PAD_BRANDS];

const argv = process.argv.slice(2);
const bakeAt = argv.indexOf('--bake');
// `--bake` with no path is the repo's own folder — the common case, and the one
// that has to be a single word to be worth typing.
const DIR = bakeAt > -1 ? (argv[bakeAt + 1] && !argv[bakeAt + 1].startsWith('--') ? argv[bakeAt + 1] : DEFAULT_DIR) : null;
const STRICT = argv.includes('--strict');

if (!DIR) {
  console.log('device icons — the marks on the team select\'s controller chips\n');
  console.log(`  keys:    ${KEYS.join(', ')}`);
  console.log(`  formats: ${ICON_EXTS.join(', ')}`);
  console.log('  name each file for its key — xbox.svg, pad.png — and:\n');
  console.log('    npm run device:icons -- --bake <dir>\n');
  const { DEVICE_ICONS } = await import('../path/src/ui/deviceIcons.js');
  const have = Object.keys(DEVICE_ICONS);
  console.log(have.length
    ? `  in the game now: ${have.join(', ')}`
    : '  in the game now: none — every chip is drawing its glyph');
  const want = KEYS.filter((k) => !have.includes(k));
  if (want.length) console.log(`  still on a glyph: ${want.join(', ')}`);
  process.exit(0);
}

/**
 * TIDY AN SVG ON ITS WAY IN — and the first line of it is the one that matters.
 *
 * A VIEWBOX, OR IT DOES NOT SCALE. Kenney's files carry `width="64" height="64"`
 * and no viewBox, which is an SVG with a fixed canvas and no statement about how
 * its contents map onto one of another size. As a CSS background with `contain`
 * that is a coin toss between engines: Chromium infers the box and scales, and
 * an engine that does not simply draws the artwork at 64px inside an 18px
 * element and clips it. This game is played on iOS Safari, so the mark would
 * have come out as a crop of a controller on the devices the marks matter most
 * on — and it renders perfectly in the Browser pane while it does.
 *
 * ...AND THE REST IS BYTES. Every one of these is inlined into a module as a
 * base64 data URI, where three bytes of source cost four in the bundle, so the
 * cruft is worth removing rather than shrugging at: an empty `<defs/>`, an xlink
 * namespace nothing references, a `stroke="none"` on every path (which is SVG's
 * initial value anyway), and the newlines and indentation between tags.
 *
 * NOT A MINIFIER. It does not touch path data, merge shapes or round
 * coordinates — those are the changes that can silently alter a drawing, and
 * this runs unattended on art nobody is going to re-check pixel by pixel. What
 * it removes is only ever exactly redundant.
 */
export function tidySvg(src) {
  let out = src;
  // The viewBox, from the width and height the file already declares.
  if (!/\sviewBox\s*=/i.test(out)) {
    const w = /\swidth\s*=\s*["']([\d.]+)/i.exec(out)?.[1];
    const h = /\sheight\s*=\s*["']([\d.]+)/i.exec(out)?.[1];
    if (w && h) out = out.replace(/<svg\b/i, `<svg viewBox="0 0 ${w} ${h}"`);
  }
  return out
    .replace(/<\?xml[^>]*\?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<defs\s*\/>/gi, '')
    .replace(/<defs\s*>\s*<\/defs>/gi, '')
    .replace(/\sxmlns:xlink\s*=\s*["'][^"']*["']/gi, (m) => (/xlink:/.test(out) ? m : ''))
    .replace(/\sstroke\s*=\s*["']none["']/gi, '')
    // Between tags only — never inside path data, where a space is a separator.
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const files = await readdir(DIR).catch(() => null);
if (!files) {
  console.error(`device icons: no directory at ${DIR}`);
  process.exit(2);
}

const entries = [];
const missing = [];
const ignored = [];

for (const key of KEYS) {
  // The first file named for this key in a format the repo accepts. Sorted so
  // a directory holding both xbox.svg and xbox.png bakes the same one every
  // run rather than whichever the filesystem listed first.
  const named = files.filter((f) => f.slice(0, f.lastIndexOf('.')) === key && extOf(f) in ICON_FORMATS).sort();
  if (!named.length) { missing.push(key); continue; }
  if (named.length > 1) ignored.push(`${key}: took ${named[0]}, left ${named.slice(1).join(', ')}`);
  const file = named[0];
  const raw = await readFile(join(DIR, file));
  const bytes = extOf(file) === '.svg' ? Buffer.from(tidySvg(raw.toString('utf8')), 'utf8') : raw;
  entries.push({
    key, file, was: raw.length, now: bytes.length,
    uri: `data:${mimeFor(file)};base64,${bytes.toString('base64')}`,
  });
}

// Anything in the directory that is not one of the five, so a misnamed file
// does not simply vanish into a silent "missing" for the key it was meant to be.
for (const f of files) {
  const stem = f.slice(0, f.lastIndexOf('.'));
  if (extOf(f) in ICON_FORMATS && !KEYS.includes(stem)) ignored.push(`${f}: "${stem}" is not one of ${KEYS.join(', ')}`);
}

if (STRICT && missing.length) {
  console.error(`REFUSED to bake: ${missing.length} of ${KEYS.length} icon(s) are not in ${DIR}.`);
  for (const m of missing) console.error(`  MISSING ${m}${ICON_EXTS.join('|')}`);
  console.error(`\nNothing was written. ${MODULE_OUT} still holds the last good set.`);
  process.exit(2);
}

const head = await readFile(MODULE_OUT, 'utf8');
// The header is the file's own, re-read rather than restated, so the paragraphs
// explaining what this module is stay in one place and survive every bake.
const banner = head.slice(0, head.indexOf('export const DEVICE_ICONS'));
const src = `${banner}export const DEVICE_ICONS = {
${entries.map((e) => `  '${e.key}': '${e.uri}',`).join('\n')}
};

export const DEVICE_ICON_KEYS = Object.keys(DEVICE_ICONS);
`;

await writeFile(MODULE_OUT, src);
const kb = (Buffer.byteLength(src) / 1024).toFixed(0);
console.log(`baked ${entries.length} of ${KEYS.length} device icons into ${MODULE_OUT} (${kb}KB)`);
for (const e of entries) {
  const svg = extOf(e.file) === '.svg';
  console.log(`  ${e.key.padEnd(12)} ${e.file.padEnd(18)} ${e.was}B${svg ? ` -> ${e.now}B` : ''}`);
}
for (const m of missing) console.log(`  ${m.padEnd(12)} — none in ${DIR}, still on its glyph`);
for (const i of ignored) console.log(`  IGNORED ${i}`);
