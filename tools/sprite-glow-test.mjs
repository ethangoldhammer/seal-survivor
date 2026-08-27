#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:spriteglow
//
// Measures the REAL sprite files and checks that an asset asking to glow
// actually will — for every variant in its pool, not just the bright ones.
//
// The failure this exists for is specific and silent. A sprite pool is several
// DRAWN images, and drawn images are not calibrated against each other: the
// five starfish measure a mean linear luminance of 0.054 to 0.29, a factor of
// five. On an ordinary sprite that gap is invisible. On a glowing one it means
// a single glow multiplier pushes the bright stars past CONFIG.bloom.threshold
// and leaves the dark ones under it, so the same ability throws one star that
// blazes and one that does not light at all — which reads as a bug.
//
// Nothing else can catch it. The browser preview suspends requestAnimationFrame
// so it never renders a frame, and even if it did, "is this star glowing" is
// not a question a screenshot answers reliably against a dark seabed.
//
//   node --import ./tools/vite-loader.mjs tools/sprite-glow-test.mjs
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

import { CONFIG } from '../path/src/config.js';
import { ASSETS, spriteLumaNorm } from '../path/src/assets.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(HERE, '../public');

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// --- PNG decode -------------------------------------------------------------
// The sprites ship as webp, which nothing in Node decodes without a native
// dependency. `sips` is on every macOS box and converts to PNG, which is a
// format worth 40 lines to read here rather than adding a build dependency for
// a test. Skips cleanly where sips is unavailable rather than failing the
// suite on a machine that simply cannot look at the files.
function decodePng(file) {
  const d = readFileSync(file);
  let i = 8;
  let idat = Buffer.alloc(0);
  let w = 0; let h = 0; let ct = 0;
  while (i < d.length) {
    const len = d.readUInt32BE(i);
    const type = d.toString('ascii', i + 4, i + 8);
    const data = d.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    else if (type === 'IDAT') idat = Buffer.concat([idat, data]);
    else if (type === 'IEND') break;
    i += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  if (!ch) throw new Error(`unsupported colour type ${ct}`);
  const raw = zlib.inflateSync(idat);
  const stride = w * ch;
  const out = Buffer.alloc(w * h * ch);
  let prev = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[pos++];
    const line = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      if (f === 1) line[x] = (line[x] + a) & 255;
      else if (f === 2) line[x] = (line[x] + b) & 255;
      else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    line.copy(out, y * stride);
    prev = line;
  }
  return { w, h, ch, px: out };
}

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

// The same measurement systems/assets.js makes at load, over the full image
// rather than a 16x16 downscale — if the two disagreed the downscale would be
// the thing at fault, and it is worth knowing that from the real numbers.
function lumaSamples(file) {
  const { ch, px } = decodePng(file);
  const lums = [];
  for (let i = 0; i < px.length; i += ch) {
    const a = ch === 4 ? px[i + 3] : 255;
    if (a < 8) continue;
    const r = toLinear(px[i] / 255);
    const g = toLinear(px[i + 1] / 255);
    const b = toLinear(px[i + 2] / 255);
    lums.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  return lums;
}

console.log('\nSPRITE GLOW');

const key = 'starfish';
const def = ASSETS[key];
check('the starfish asks to be normalised', !!def.spriteNormalize, `target ${def.spriteNormalize}`);

let tmp;
try {
  execFileSync('which', ['sips'], { stdio: 'ignore' });
  tmp = mkdtempSync(join(tmpdir(), 'sprite-glow-'));
} catch {
  console.log('  (sips unavailable — skipping the pixel measurements)\n');
  process.exit(failures ? 1 : 0);
}

const glow = CONFIG.assetLooks?.[key]?.glow ?? 1;
const threshold = CONFIG.bloom.threshold;
const measured = [];

for (const url of def.sprites) {
  const src = resolve(PUBLIC, `.${url}`);
  if (!existsSync(src)) { check(`${url} exists`, false); continue; }
  const png = join(tmp, `${url.split('/').pop()}.png`);
  execFileSync('sips', ['-s', 'format', 'png', src, '--out', png], { stdio: 'ignore' });
  const lums = lumaSamples(png);
  const luma = lums.reduce((a, b) => a + b, 0) / lums.length;
  const norm = spriteLumaNorm(luma, def.spriteNormalize);
  // What fraction of the drawing is driven past 1.0 and therefore lands as
  // flat white in the LDR composite. This is the number that decides whether
  // the star still looks drawn.
  const clipped = lums.filter((l) => l * norm * glow > 1).length / lums.length;
  measured.push({ url, luma, norm, clipped, lums });
}

check('every declared sprite was measured', measured.length === def.sprites.length,
  `${measured.length} of ${def.sprites.length}`);

// THE POINT. Every variant, once normalised and glowed, has to clear the bloom
// threshold — otherwise the pool contains a star that does not light.
console.log(`  (bloom threshold ${threshold}, asset glow ${glow}, target ${def.spriteNormalize})`);
for (const m of measured) {
  const final = m.luma * m.norm * glow;
  console.log(`    ${m.url.padEnd(28)} luma ${m.luma.toFixed(3)}  x${m.norm.toFixed(2)}`
    + `  -> ${final.toFixed(2)}  ${(m.clipped * 100).toFixed(0)}% clipped`);
}

const dimmest = measured.reduce((a, b) => (a.luma * a.norm * glow < b.luma * b.norm * glow ? a : b));
const dimmestFinal = dimmest.luma * dimmest.norm * glow;
check('even the dimmest variant clears the bloom threshold',
  dimmestFinal > threshold,
  `${dimmestFinal.toFixed(2)} vs threshold ${threshold}`);

// CLEARING THE GATE IS NOT THE SAME AS GOING THROUGH IT, which is what the old
// `threshold * 1.5` was reaching for without saying so. The bright pass is
//
//   m = smoothstep(uThreshold, uThreshold + 0.25, lum);   bloom = c * m
//
// so the response over the first quarter above the threshold is a smoothstep,
// not a step: a value sitting just over the line contributes almost nothing and
// only reaches full strength at threshold + 0.25. A sprite can therefore pass
// the check above and still not visibly light, which is precisely the failure
// this section says it is about.
//
// Written as the shader's own curve so it stays true if the threshold moves.
const brightResponse = (v) => {
  const t = Math.min(1, Math.max(0, (v - threshold) / 0.25));
  return t * t * (3 - 2 * t);
};
const response = brightResponse(dimmestFinal);
// ...AND AS FAR THROUGH IT AS THE DRAWING SURVIVES, which is the honest form of
// this check and not the half-strength bar it used to carry.
//
// Half strength wants luminance 0.705 at a threshold of 0.58 — normalise 0.40
// against the glow of 1.8 in the Look panel — and the pool is unrecognisable
// there: measured on the shipped art, 0.40 puts four of the five stars past a
// third of their pixels at flat white and one at 61%. The two goals genuinely
// trade, the cliff is between 0.38 and 0.40, and asking for both was asking
// for art that does not exist. Sitting over the line at a few percent is what
// this pool CAN do: a lift you notice against the seabed, on drawings that are
// still drawings.
//
// So the response bar is what the clipping ceilings below allow, worked out
// from the same pixels rather than typed in: the check is that the shipped
// normalisation is within a hair of the brightest one the art survives. Push
// the target down and this fails as too dim; push it up and the clip checks
// fail first.
const clipAt = (target) => measured.map((m) => {
  const norm = spriteLumaNorm(m.luma, target);
  return m.lums.filter((l) => l * norm * glow > 1).length / m.lums.length;
});
const survives = (target) => {
  const c = clipAt(target);
  return Math.max(...c) < 0.35 && c.filter((v) => v < 0.1).length >= c.length - 1;
};
let brightestSafe = 0;
for (let t = 0.1; t <= 1.0; t += 0.005) if (survives(t)) brightestSafe = t;
check('...and it is as far past the line as this art survives',
  response > 0 && def.spriteNormalize >= brightestSafe - 0.01,
  `bloom response ${(response * 100).toFixed(0)}% at normalise ${def.spriteNormalize}`
  + ` — the brightest the drawings survive is ${brightestSafe.toFixed(3)},`
  + ` and full strength would need ${(threshold + 0.25).toFixed(2)}`);

// ...and the raw art does NOT, which is what proves the normalisation is the
// thing doing the work rather than the sprites having been fine all along.
const rawDimmest = dimmest.luma * glow;
check('...which it would not do on the raw art at the same glow',
  rawDimmest < dimmestFinal, `${rawDimmest.toFixed(2)} raw vs ${dimmestFinal.toFixed(2)} normalised`);

// The spread is the actual complaint: five stars that glow by wildly different
// amounts read as broken. After normalising they should be within a stop.
const finals = measured.map((m) => m.luma * m.norm * glow);
const spread = Math.max(...finals) / Math.min(...finals);
const rawSpread = Math.max(...measured.map((m) => m.luma)) / Math.min(...measured.map((m) => m.luma));
check('the pool glows evenly rather than a star at a time',
  spread < 1.6, `${spread.toFixed(2)}x spread, down from ${rawSpread.toFixed(2)}x raw`);

// THE CEILING, and it has to be measured per pixel rather than off the mean.
// The composite is LDR, so anything past 1.0 lands as flat white: push the
// glow far enough and a drawn star stops being a drawing and becomes a
// silhouette. Measured rather than assumed because the cliff is sharp and
// sits in a different place for each image — at glow 2.4 these same five go
// to 30/68/28/35/55% clipped and the art is gone, where at 1.8 only the star
// with genuine bright highlights blows them, which is what glow should do.
const worstClip = Math.max(...measured.map((m) => m.clipped));
check('the drawing survives the glow rather than blowing out to white',
  worstClip < 0.35, `worst ${(worstClip * 100).toFixed(0)}% of pixels clipped`);
check('...and most of the pool keeps nearly all of its detail',
  measured.filter((m) => m.clipped < 0.1).length >= measured.length - 1,
  `${measured.filter((m) => m.clipped < 0.1).length} of ${measured.length} under 10%`);

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
