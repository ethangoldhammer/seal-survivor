// ---------------------------------------------------------------------------
// Re-encode a model's textures to WebP, and change nothing else — `npm run webp`.
//
// `npm run tex` measures two separate costs and this fixes exactly one of them:
// the DOWNLOAD. WebP against PNG is roughly an 80% cut on a painted texture and
// it is invisible on screen. It does not move VRAM by a single byte — that is
// decided by the pixel dimensions, which this tool deliberately leaves alone.
// Resizing is a judgement call per model; re-encoding is not, which is why the
// two are separate jobs and only this one runs over the whole roster.
//
// The per-model optimize-*.mjs scripts already do this as their last step, in
// among decimation, welding and quantization tuned to one creature. This is
// that last step on its own, so a model that needs nothing else does not have
// to be given a bespoke script to get it.
//
// three.js has read WebP inside a glb through EXT_texture_webp for years, and
// four of these models already ship that way — crabpincer, mosasaurus, squid
// and fisherman all came out of the per-model scripts. This is not a new format
// for the loader, it is the same one applied to the rest.
//
// SAFE BY DEFAULT: writes alongside as `<name>.webp.glb` and reports, touching
// nothing. `--write` is what replaces the originals, and it keeps a copy of
// each. Nothing here can regenerate a source texture, so the copy is the only
// way back.
//
// The copies go to .model-orig/ at the repo root rather than next to the
// models, because vite copies public/ into the build WHOLESALE — a backup left
// in public/models is 30MB of dead weight shipped to every player, and it would
// be invisible in testing since nothing ever requests it.
//
//   node tools/webp-textures.mjs                  # every model, dry run
//   node tools/webp-textures.mjs --write          # every model, in place
//   node tools/webp-textures.mjs shark.glb --write
//   node tools/webp-textures.mjs --quality=92 --write
// ---------------------------------------------------------------------------

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = path.join(ROOT, 'public/models');
const BACKUP = path.join(ROOT, '.model-orig');

const argv = process.argv.slice(2);
const write = argv.includes('--write');
const qArg = argv.find((a) => a.startsWith('--quality='));
// 88 is what the per-model scripts settled on. Painted textures at 88 are
// indistinguishable from the PNG at play size; the artefacts WebP produces are
// in flat gradients, and none of these maps is one.
const quality = qArg ? Number(qArg.split('=')[1]) : 88;

const named = argv.filter((a) => !a.startsWith('--'));
const files = named.length
  ? named.map((f) => (f.endsWith('.glb') ? f : `${f}.glb`))
  : fs.readdirSync(MODELS).filter((f) => f.endsWith('.glb'));

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const MB = 1048576;

console.log(write ? `Re-encoding to WebP q${quality}, IN PLACE (.orig kept)\n` : `Dry run — nothing is written. Add --write.\n`);
console.log('  before    after   saved   model');
console.log('  ' + '-'.repeat(58));

let before = 0;
let after = 0;
let touched = 0;

for (const file of files) {
  const src = path.join(MODELS, file);
  if (!fs.existsSync(src)) {
    console.log(`  ${'—'.padStart(7)}  ${'—'.padStart(7)}          ${file}  (not found)`);
    continue;
  }

  const doc = await io.read(src);
  const textures = doc.getRoot().listTextures();
  // Already WebP, or carries no images at all. Re-encoding a WebP would be a
  // second generation of loss for no gain.
  if (!textures.length || textures.every((t) => t.getMimeType() === 'image/webp')) continue;

  const sizeBefore = fs.statSync(src).size;

  await doc.transform(
    textureCompress({ encoder: sharp, targetFormat: 'webp', quality }),
  );

  const out = write ? src : src.replace(/\.glb$/, '.webp.glb');
  if (write) {
    fs.mkdirSync(BACKUP, { recursive: true });
    fs.copyFileSync(src, path.join(BACKUP, file));
  }
  await io.write(out, doc);

  const sizeAfter = fs.statSync(out).size;
  before += sizeBefore;
  after += sizeAfter;
  touched++;

  console.log(
    `  ${(sizeBefore / MB).toFixed(2).padStart(6)}MB ${(sizeAfter / MB).toFixed(2).padStart(6)}MB `
    + `${(100 - (sizeAfter / sizeBefore) * 100).toFixed(0).padStart(4)}%   ${file}`,
  );
}

console.log('  ' + '-'.repeat(58));
console.log(
  `  ${(before / MB).toFixed(2).padStart(6)}MB ${(after / MB).toFixed(2).padStart(6)}MB `
  + `${(100 - (after / before) * 100).toFixed(0).padStart(4)}%   ${touched} models\n`,
);

if (!write) {
  console.log('Wrote <name>.webp.glb next to each original. Compare, then re-run with --write.');
} else {
  console.log('Originals kept in .model-orig/ (gitignored, outside the build).');
  console.log('Delete them once the game looks right:');
  console.log('  rm -r .model-orig');
}
