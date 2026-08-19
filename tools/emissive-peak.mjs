#!/usr/bin/env node
// ---------------------------------------------------------------------------
// node tools/emissive-peak.mjs <model.glb>
//
// What an emissive map can actually drive, as a number.
//
// `emissiveIntensity` is a multiplier on `emissive x emissiveMap`, so what a
// creature reaches on screen is the intensity times the MAP's own peak — and
// whether that blooms is then a question about CONFIG.bloom.threshold, which
// the bright pass in systems/post.js applies to LUMINANCE (0.2126/0.7152/0.0722,
// so blue counts for 7%). None of that is visible from the intensity alone: the
// same slider value is a blazing lure on one model and nothing at all on
// another, depending entirely on how bright the artist painted the mask.
//
// Prints JSON so a test can assert against it. It lives in its own file, run as
// a SUBPROCESS rather than imported, because `sharp` is a native CJS module and
// cannot be loaded under tools/vite-loader.mjs at all — static or dynamic, it
// fails with Node's "Unexpected module status 3" out of semver, which names
// neither sharp nor the import that pulled it.
// ---------------------------------------------------------------------------
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';

const src = process.argv[2];
if (!src) { console.error('usage: node tools/emissive-peak.mjs <model.glb>'); process.exit(2); }

const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(src);
const out = { file: src, materials: [], peak: 0, coverage: {} };

for (const m of doc.getRoot().listMaterials()) {
  const tex = m.getEmissiveTexture();
  if (!tex) continue;
  const { data, info } = await sharp(Buffer.from(tex.getImage())).raw().toBuffer({ resolveWithObject: true });
  let peak = 0; let sum = 0; let n = 0;
  const bands = [0.05, 0.25, 0.5, 0.75];
  const over = bands.map(() => 0);
  for (let i = 0; i < data.length; i += info.channels) {
    const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    if (lum > peak) peak = lum;
    sum += lum; n++;
    for (let b = 0; b < bands.length; b++) if (lum > bands[b]) over[b]++;
  }
  out.materials.push({ name: m.getName(), w: info.width, h: info.height, peak, mean: sum / n });
  if (peak > out.peak) {
    out.peak = peak;
    out.coverage = Object.fromEntries(bands.map((b, i) => [b, over[i] / n]));
  }
}
console.log(JSON.stringify(out, null, 2));
