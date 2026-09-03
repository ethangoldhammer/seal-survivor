#!/usr/bin/env node
// ---------------------------------------------------------------------------
// BRING EVERY MAP DOWN TO THE SIZE IT CAN JUSTIFY — `npm run shrink`.
//
// `npm run tex` measures two costs and says which lever fixes each: DISK is the
// compression, VRAM is the pixel dimensions and nothing else. The roster's maps
// have been WebP for a while, so the disk half is done; this is the other half,
// and it is the one that matters on a phone.
//
// WHY NOW. The phone's own census reads `tex128` — 128MB of transcoded ASTC,
// resident from the menu, mirrored again on the GPU — inside a WebContent
// process that iOS kills for memory. Past the device's budget the driver does
// not fail, it PAGES: evicting and re-uploading under you for the rest of the
// session, which is continuous hitching rather than one stall.
//
// TWO RULES, AND THEY COME FROM DIFFERENT PLACES:
//
//   THE BUDGET, from tools/texture-budget.mjs. One texel per pixel at the
//     largest the model is ever drawn — a 4K panel with the kill shot's 3.15x
//     cinematic push already folded in. A map above that is texels the
//     rasteriser averages away, and the mip chain means it does not even look
//     sharper: it looks identical. This is the audit's own `justified` column,
//     so the two tools cannot disagree.
//
//   THE CAP, which is an art call and is Ethan's: nothing needs 2K. Five maps
//     were over it — the anglerfish's four and the grass — and the anglerfish
//     alone was 85MB of the roster's 407MB for a body the budget would let sit
//     at 2048. The cap overrides the budget where they disagree.
//
// NORMAL MAPS ARE RE-ENCODED LOSSLESS, colour at quality 90. A normal map is
// not a picture — its channels are a direction — and a lossy round trip here
// would compound with the UASTC pass `npm run ktx2` does afterwards, which is
// the one that has to be judged on its own artefacts. See the note in that file
// about why normals get a different codec.
//
// AFTERWARDS, ALWAYS: `npm run ktx2`. The game loads the compressed twins in
// public/models-ktx2/, so a source model resized without re-encoding is a file
// nobody reads — the shrink appears to have done nothing, and `npm run tex`
// (which reads the sources) will happily tell you it worked. That is the one
// way to be fooled by this, and it is the same trap ktx2-models.mjs names in
// its own header from the other direction.
//
//   node tools/shrink-textures.mjs [--dry] [--cap 1024] [--only <name>] [--steps 2]
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  MODELS, MB, vramOf, keysByModel, sizesByKey, budgetFor,
} from './texture-budget.mjs';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const capArg = argv.indexOf('--cap');
const CAP = capArg > -1 ? Number(argv[capArg + 1]) : 1024;
// HOW FAR ANY ONE MAP MAY FALL IN A SINGLE PASS, in powers of two.
//
// The audit's advice about its own number is "step down one power of two, look
// at it, step again", and the reason is that `justified` is an average over the
// whole map — a UV layout that gives the face its own big island wants more
// than the average says. Two steps is that advice with one round trip saved;
// what it stops is the fish, whose budget is 128² against a 1024² map and which
// would otherwise lose 8x in one go with nobody having looked at it.
//
// Re-run to go further. The tool is idempotent, so a second pass takes anything
// still above its budget down another two steps.
const stepArg = argv.indexOf('--steps');
const MAX_STEPS = stepArg > -1 ? Number(argv[stepArg + 1]) : 2;

// ONE MODEL, WHEN THE DECISION WAS ABOUT ONE MODEL. The cap is an art call over
// the whole roster and the sweep is the right shape for it — but a cap that is
// right for the anglerfish is not thereby right for the giant squid, whose base
// maps move 9.4/255 at the size it is drawn where the fish's move under one. A
// substring of the filename, so `--only angler` is enough.
//
// It is also what makes this safe to run while the roster-wide pass is still
// being judged: rewriting thirty binaries to change one is how two people's
// work ends up in one commit.
const onlyArg = argv.indexOf('--only');
const ONLY = onlyArg > -1 ? argv[onlyArg + 1] : null;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const { map: users, fits } = keysByModel();
const sizes = sizesByKey();

// Which slot a texture is in, so normals can be told from colour. Asked of the
// materials rather than of the texture's own name, because a name is optional
// and most of these are unnamed.
function slotsOf(doc, tex) {
  const out = new Set();
  for (const m of doc.getRoot().listMaterials()) {
    if (m.getBaseColorTexture?.() === tex) out.add('base');
    if (m.getNormalTexture?.() === tex) out.add('normal');
    if (m.getEmissiveTexture?.() === tex) out.add('emissive');
    if (m.getMetallicRoughnessTexture?.() === tex) out.add('metalRough');
    if (m.getOcclusionTexture?.() === tex) out.add('occlusion');
  }
  return out;
}

// ---------------------------------------------------------------------------
// AN EMISSIVE MAP IS RESAMPLED ON ITS MAXIMUM
// ---------------------------------------------------------------------------
// Everything else in this file averages, and averaging is correct: it is what
// the mip chain was already doing to those texels, which is the whole argument
// for taking a map down at all. On a GLOW map it is wrong, and it fails in a
// way neither the budget nor the loss measurement below can see.
//
// What an emissive map is FOR is crossing CONFIG.bloom.threshold. That is a
// test on the brightest texel, not on the average — and a glow map is mostly
// black (the anglerfish's is 86% pure black, with 0.8% of it above mid-grey),
// so every box-filtered output texel is a bright one averaged with its dark
// neighbours. Measured on the anglerfish at 1024 -> 512: peak luminance 0.950
// -> 0.911, a 4% loss that put the lure's commit at 17.31 against the 18 the
// fight claims — the boss's brightest moment quietly stopped being the
// brightest thing in the game. The mean absolute difference this tool reports
// for that same resize was 1.44/255, i.e. "invisible": a mean cannot see a peak.
//
// It is not only the bulb. The photophore rows along the flank are two and
// three texels across, and a box filter at half resolution is exactly how you
// turn a row of lights into a smudge.
//
// So the bright thing wins its block. The peak is preserved by construction
// rather than restored by a gain afterwards — a gain that big clips whichever
// channel was already near 255, and picking the gain from luminance while the
// clipping happens per channel is its own bug (see [[glow-clips-any-baked-shading]]).
// The cost is that lit regions grow by up to half a source texel, which on a
// map whose job is to bloom is the direction to err in.
//
// INTEGER FACTORS ONLY. Every resize this tool does is a power of two, so the
// fallback is unreachable today; it is here because a non-integer factor would
// otherwise silently max-pool with a wrong stride, and a glow map that came out
// subtly sheared is not something the loss column would flag either.
async function maxPool(buf, nw, nh) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const fx = info.width / nw;
  const fy = info.height / nh;
  if (!Number.isInteger(fx) || !Number.isInteger(fy)) {
    return sharp(buf).resize(nw, nh, { fit: 'fill' }).webp({ quality: 90 }).toBuffer();
  }
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      // PER CHANNEL, and that is deliberate rather than sloppy. Taking the
      // whole source texel that had the brightest luminance would preserve the
      // peak too, but it is a nearest-neighbour pick dressed up as a filter and
      // it aliases the falloff around the bulb. Per channel keeps the colour of
      // the brightest thing in each channel, which on a glow map — where the
      // esca is near-white and the photophores are near-white — is the same
      // pixel almost everywhere and a smoother edge where it is not.
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = y * fy; sy < (y + 1) * fy; sy++) {
        for (let sx = x * fx; sx < (x + 1) * fx; sx++) {
          const i = (sy * info.width + sx) * 4;
          if (data[i] > r) r = data[i];
          if (data[i + 1] > g) g = data[i + 1];
          if (data[i + 2] > b) b = data[i + 2];
          if (data[i + 3] > a) a = data[i + 3];
        }
      }
      const o = (y * nw + x) * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
  }
  // LOSSLESS, like the normals and for a related reason: the peak this just
  // went to the trouble of preserving is one texel, and quality-90 WebP is
  // free to move an isolated bright texel by a few levels. It is a cheap file —
  // a mostly-black map compresses to nothing.
  return sharp(out, { raw: { width: nw, height: nh, channels: 4 } })
    .webp({ lossless: true }).toBuffer();
}

console.log(`\n  cap ${CAP}²${ONLY ? `   only *${ONLY}*` : ''}${DRY ? '   (dry run — nothing is written)' : ''}\n`);
console.log('  model                  map                     from        to      VRAM saved');
console.log('  ' + '-'.repeat(78));

let before = 0;
let after = 0;
let touched = 0;
const changedFiles = [];
const losses = [];

for (const file of fs.readdirSync(MODELS).sort()) {
  if (!file.endsWith('.glb')) continue;
  if (ONLY && !file.includes(ONLY)) continue;
  const full = path.join(MODELS, file);
  let doc;
  try {
    doc = await io.read(full);
  } catch (err) {
    console.log(`  ${file.padEnd(22)} READ FAILED — ${err.message}`);
    continue;
  }

  const keys = users.get(file) ?? [];
  const budget = budgetFor(file, keys, fits, sizes);
  // NO KEY, NO OPINION. A model nothing in ASSETS names has no on-screen size
  // to reason from, so the budget cannot speak for it — but the CAP still can,
  // because "nothing needs 2K" is a statement about the art and not about any
  // particular model's framing.
  const limit = Math.min(CAP, budget?.want ?? Infinity);

  let fileTouched = false;
  for (const tex of doc.getRoot().listTextures()) {
    const size = tex.getSize();
    if (!size) continue;
    const [w, h] = size;
    const biggest = Math.max(w, h);
    before += vramOf({ w, h });
    if (biggest <= limit) { after += vramOf({ w, h }); continue; }

    // The LONG axis lands on the limit and the aspect is kept, so a 2048x1024
    // becomes 1024x512 rather than being squared off.
    // ...and never further than MAX_STEPS powers of two below where it is now.
    const floor = biggest / 2 ** MAX_STEPS;
    const target = Math.max(limit, floor);
    if (biggest <= target) { after += vramOf({ w, h }); before -= vramOf({ w, h }); before += vramOf({ w, h }); continue; }
    const scale = target / biggest;
    const nw = Math.max(1, Math.round(w * scale));
    const nh = Math.max(1, Math.round(h * scale));
    after += vramOf({ w: nw, h: nh });
    touched++;
    fileTouched = true;

    const slots = slotsOf(doc, tex);
    const lossless = slots.has('normal');
    // AN EMISSIVE MAP IS RESAMPLED ON ITS MAXIMUM, NOT ITS AVERAGE — see
    // maxPool below. Every other slot averages, which is what a mip chain does
    // and what makes the claim above ("the smaller map resolves to the same
    // pixels") true.
    const peaked = slots.has('emissive');
    console.log(
      `  ${file.padEnd(22)} ${[...slots].join('+').padEnd(22)} ${`${w}x${h}`.padStart(9)}`
      + ` ${`${nw}x${nh}`.padStart(9)}   ${((vramOf({ w, h }) - vramOf({ w: nw, h: nh })) / MB).toFixed(1).padStart(6)}MB`
      + `${peaked ? '  (max-pooled, lossless)' : lossless ? '  (lossless)' : ''}`,
    );

    const img = tex.getImage();
    const out = peaked
      ? await maxPool(Buffer.from(img), nw, nh)
      : await sharp(Buffer.from(img))
        .resize(nw, nh, { fit: 'fill' })
        .webp(lossless ? { lossless: true } : { quality: 90 })
        .toBuffer();

    // WHAT WAS ACTUALLY LOST, measured rather than asserted.
    //
    // The claim this tool makes is narrow and checkable: at the size the model
    // is drawn, the mip chain was already averaging those texels away, so the
    // smaller map resolves to the same pixels. So resample BOTH to the widest
    // the model ever gets and compare them there. A near-zero difference means
    // the claim holds; a large one means this map carries detail the average
    // hides — a face with its own UV island, which is exactly the case the
    // audit's "ceiling, not a target" warning is about.
    //
    // It is not a substitute for looking at it, and it is not meant to be. It
    // is what says WHICH ones to look at.
    if (budget) {
      const px = Math.max(8, Math.min(1024, Math.round(Math.max(...budget.spans) * 3.15)));
      const at = (buf) => sharp(Buffer.from(buf))
        .resize(px, px, { fit: 'fill' }).removeAlpha().raw().toBuffer();
      const [a, b] = await Promise.all([at(img), at(out)]);
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
      const mad = sum / a.length; // mean absolute difference, 0-255
      losses.push({ file, slots: [...slots].join('+'), px, mad, from: `${w}x${h}`, to: `${nw}x${nh}` });
    }

    if (DRY) continue;
    tex.setImage(new Uint8Array(out));
    tex.setMimeType('image/webp');
  }

  if (fileTouched && !DRY) {
    await io.write(full, doc);
    changedFiles.push(file);
  }
}

console.log('  ' + '-'.repeat(78));
console.log(`  ${touched} map(s) resized  ·  ${(before / MB).toFixed(0)}MB -> ${(after / MB).toFixed(0)}MB of uncompressed VRAM`
  + `${ONLY ? `  (of the models matching *${ONLY}*, not the roster)` : ''}`);
console.log(`  (the phone holds a quarter of that as ASTC — see the census note in npm run crash)\n`);
// WHICH ONES TO GO AND LOOK AT. Sorted by how much the picture actually moved
// at the size it is drawn — see the note beside the measurement. Everything
// under a couple of levels out of 255 is a map whose extra texels the mip chain
// was already discarding; anything above that is a map with detail packed
// somewhere the average does not see, and is a judgement rather than a saving.
if (losses.length) {
  losses.sort((a, b) => b.mad - a.mad);
  console.log('  WHAT MOVED, at the size the model is drawn (0-255 per channel):\n');
  for (const l of losses.slice(0, ONLY ? losses.length : 10)) {
    const verdict = l.mad < 2 ? 'invisible' : l.mad < 6 ? 'look at it' : 'LOOK AT IT';
    console.log(`  ${l.mad.toFixed(2).padStart(6)}  ${l.file.padEnd(22)} ${l.slots.padEnd(22)}`
      + ` ${l.from} -> ${l.to} at ${l.px}px   ${verdict}`);
  }
  console.log();
}

if (!DRY && changedFiles.length) {
  console.log(`  ${changedFiles.length} model(s) rewritten. NOW RUN:  npm run ktx2`);
  console.log('  The game loads public/models-ktx2/, so until you do, none of this ships.\n');
}
