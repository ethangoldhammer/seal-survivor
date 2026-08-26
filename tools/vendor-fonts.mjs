#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run fonts
//
// PUT THE FONT SHELF ON DISK — every family in path/src/fonts.js that carries a
// `google` entry, downloaded once into public/fonts/ and served from there.
//
// WHY. Two things reach for Google Fonts at runtime today, and both fail badly
// in a downloaded game:
//
//   ui/ui.js       @imports Inter, which is the UI's default family. The whole
//                  interface is sized in px against Inter's metrics (roughly
//                  1em per glyph), so offline it falls through to system-ui and
//                  every px-tuned element is subtly wrong. No error, no
//                  warning, nothing on screen that says what happened.
//   ui/typography.js  loads any of the other twelve on demand — and NOT only
//                  for the tuner. systems/epitaph.js picks a family per grave,
//                  so offline every epitaph renders in a fallback and that
//                  whole treatment is silently dead.
//
// A Steam player is offline often enough that this is not an edge case, and
// Valve's reviewer will launch the build disconnected at least once.
//
// VENDORED FOR THE WEB BUILD TOO, not just for desktop. One code path is worth
// more than the bandwidth: a shelf that is local in one build and remote in
// another is a shelf where a font-metric bug reproduces in exactly one of them.
// It is also faster and it stops the game telling Google who is playing it.
//
// SUBSET TO latin + latin-ext. Google serves each family cut into latin,
// latin-ext, cyrillic, greek and vietnamese; the game's copy is English and
// systems/playerName.js already strips the characters that would break a name,
// but latin-ext is kept because it carries the accents a European player's name
// actually needs. The other three are dropped, which is most of the weight.
//
// RE-RUNNABLE. Deletes nothing it did not write, and rewrites fonts.css from
// scratch each time, so adding a family to fonts.js means running this again.
//
//   node tools/vendor-fonts.mjs [--dry]
// ---------------------------------------------------------------------------

import { mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'public/fonts');

// Google decides which format to serve from the UA. An old or absent one gets
// TTF, which is roughly four times the size for the same glyphs — so this asks
// as a browser that supports woff2, which every target of this game does.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const KEEP_SUBSETS = new Set(['latin', 'latin-ext']);

const dry = process.argv.includes('--dry');

// The shelf is the source of truth — imported rather than restated, so a family
// added to fonts.js cannot be forgotten here.
const { FONTS } = await import('../path/src/fonts.js');
const families = FONTS.filter((f) => f.google);

console.log(`\nVENDORING FONTS — ${families.length} families from the shelf\n`);

/**
 * Google's CSS labels each @font-face block with a `/* subset *\/` comment on
 * the line above it. That comment is the ONLY thing identifying which cut a
 * block is: the unicode-range would work too but means hard-coding ranges that
 * Google revises. Parsed as blocks so a family with six weights keeps all six.
 */
function parseFaces(css) {
  const faces = [];
  const re = /\/\*\s*([a-z-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g;
  for (const m of css.matchAll(re)) faces.push({ subset: m[1], block: m[2] });
  return faces;
}

function urlIn(block) {
  return block.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/)?.[1] ?? null;
}

/** A stable filename from the gstatic URL, which already encodes family+cut. */
function fileNameFor(url) {
  return url.split('/').slice(-2).join('-').replace(/[^\w.-]+/g, '_');
}

if (!dry) await mkdir(OUT, { recursive: true });

const sheets = [];
let downloaded = 0;
let bytes = 0;
let failures = 0;
const seen = new Set();

for (const font of families) {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${font.google}&display=swap`;
  let css;
  try {
    const res = await fetch(cssUrl, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    css = await res.text();
  } catch (err) {
    console.log(`  FAIL ${font.label} — ${err?.message ?? err}`);
    failures++;
    continue;
  }

  const faces = parseFaces(css).filter((f) => KEEP_SUBSETS.has(f.subset));
  if (!faces.length) {
    console.log(`  FAIL ${font.label} — no latin faces found; the CSS format may have changed`);
    failures++;
    continue;
  }

  let kept = 0;
  for (const { block } of faces) {
    const url = urlIn(block);
    if (!url) continue;
    const name = fileNameFor(url);
    // A VARIABLE family serves ONE file for every weight in the range, so its
    // six @font-face blocks all name the same URL. Without this the file is
    // fetched once per block and written over itself — 2MB of transfer for
    // 0.5MB on disk, and the count in the summary reads like six files.
    if (seen.has(name)) {
      sheets.push(block.replace(/url\(https:\/\/fonts\.gstatic\.com\/[^)]+\)/, `url(/fonts/${name})`));
      kept++;
      continue;
    }
    seen.add(name);
    if (!dry) {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) {
        console.log(`  FAIL ${font.label} — ${name}: HTTP ${res.status}`);
        failures++;
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(join(OUT, name), buf);
      bytes += buf.length;
    }
    downloaded++;
    kept++;
    // Rewritten to the local path. Absolute, like every other asset reference
    // in this game — the desktop shell serves from an origin root, so a leading
    // slash means the same thing there as it does on the deployed site.
    sheets.push(block.replace(/url\(https:\/\/fonts\.gstatic\.com\/[^)]+\)/, `url(/fonts/${name})`));
  }
  console.log(`  ok   ${font.label.padEnd(12)} ${kept} face${kept === 1 ? '' : 's'}`);
}

const header = `/* GENERATED by tools/vendor-fonts.mjs — do not edit.
   The font shelf (path/src/fonts.js), downloaded from Google Fonts and served
   locally so the game works with no network. Re-run \`npm run fonts\` after
   adding a family to the shelf. */\n\n`;

if (!dry) {
  await writeFile(join(OUT, 'fonts.css'), header + sheets.join('\n\n') + '\n');
  const files = await readdir(OUT);
  let total = 0;
  for (const f of files) total += (await stat(join(OUT, f))).size;
  console.log(`\n  wrote public/fonts/fonts.css and ${files.length - 1} woff2 files`);
  console.log(`  ${(total / 1024 / 1024).toFixed(2)} MB on disk\n`);
} else {
  console.log(`\n  --dry: would download ${downloaded} files\n`);
}

if (failures) {
  console.log(`${failures} failure${failures === 1 ? '' : 's'} — the shelf is incomplete.\n`);
  process.exit(1);
}

console.log(`${downloaded} faces vendored (${(bytes / 1024).toFixed(0)} KB downloaded).\n`);
