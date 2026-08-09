// Generate high-contrast emissive masks from the models in public/models.
//
//   node tools/make-emissive-masks.mjs            # every model
//   node tools/make-emissive-masks.mjs greatwhite # just one
//   node tools/make-emissive-masks.mjs greatwhite --lit 0.3
//   node tools/make-emissive-masks.mjs --pure     # two-tone, no base colour
//   node tools/make-emissive-masks.mjs morayeel --pure --lit 0.05 --blur 4 --slope 6
//
// By default the mask is COMPOSITED over the model's own base-colour texture:
// white where the markings glow, and the creature's actual texture everywhere
// else, instead of black. That matters because emissive is what the material
// emits regardless of scene lighting — a black area emits nothing and the
// creature falls back to whatever the water lighting gives it, which down
// deep is very little. Compositing keeps the whole body self-lit at its own
// colour while the markings blow out to white for the bloom to catch.
//
// `--pure` gives the old two-tone behaviour: white markings, black elsewhere,
// so only the markings emit at all.
//
// Output goes to public/textures/emissive/<model>.png, which is what an
// asset's `texture.emissive` points at. See CONFIG.glow.emissiveMaps for what
// the game does with them.
//
// Needs sharp, which is NOT a project dependency — this is an offline asset
// step, not something the game bundles:
//
//   npm i -D sharp
//
// Three decisions worth knowing about, because they are the difference
// between a usable mask and a shimmering mess:
//
//   BASE COLOUR ONLY. A model's image list also holds normal and packed ORM
//   maps, and thresholding a normal map produces confetti. The only reliable
//   way to tell them apart is to follow
//   materials[].pbrMetallicRoughness.baseColorTexture rather than guessing
//   from image order or size.
//
//   THE PIVOT IS PER TEXTURE. These range from a near-black orca to a pale
//   reef fish; one fixed threshold crushes half of them to solid black. It is
//   taken as a percentile of each texture's own histogram (`--lit`, default
//   0.15 = brightest 15% glows), ignoring pure black because that is UV
//   background on most of these atlases and counting it drags the percentile
//   down into the body tone.
//
//   NO DITHERING, SLIGHT BLUR. A palette-dithered or single-texel-noisy mask
//   shimmers once it is minified into a mip chain and bloomed. The 0.6px blur
//   costs nothing at this scale and kills it. The ramp is steep but not a
//   hard binary threshold, for the same anti-aliasing reason.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let sharp;
try {
  ({ default: sharp } = await import('sharp'));
} catch {
  console.error('This tool needs sharp, which the game itself does not bundle:\n\n  npm i -D sharp\n');
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = path.join(ROOT, 'public/models');
const OUT = path.join(ROOT, 'public/textures/emissive');

const args = process.argv.slice(2);
// Each of these takes a VALUE, and that value is not a model name. Guard the
// absent case explicitly: with the flag missing, indexOf is -1 and idx + 1 is
// 0, which would silently drop the first positional argument and quietly
// rebuild every mask when you asked for one.
const valueIdxs = new Set();
function numFlag(name, dflt) {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  valueIdxs.add(i + 1);
  return Number(args[i + 1]);
}
const LIT = numFlag('--lit', 0.15);
// How far the mask is blurred before thresholding, and how steep the ramp is.
// The defaults suit a texture with distinct markings on a plain body. A busy,
// evenly mottled one — the moray's speckled skin is the case that forced this
// — thresholds into single-texel confetti at those settings, which is exactly
// the mip-chain shimmer described above. More blur and a shallower slope trade
// the fine detail for larger, softer regions that survive minification:
//
//   node tools/make-emissive-masks.mjs morayeel --pure --lit 0.05 --blur 4 --slope 6
const BLUR = numFlag('--blur', 0.6);
const SLOPE = numFlag('--slope', 10);
const only = args.filter((a, i) => !a.startsWith('--') && !valueIdxs.has(i));
const PURE = args.includes('--pure');

function readGLB(p) {
  const b = fs.readFileSync(p);
  let o = 12, json = null, bin = null;
  while (o < b.length) {
    const len = b.readUInt32LE(o), t = b.toString('ascii', o + 4, o + 8);
    if (t === 'JSON') json = JSON.parse(b.toString('utf8', o + 8, o + 8 + len));
    if (t.startsWith('BIN')) bin = b.subarray(o + 8, o + 8 + len);
    o += 8 + len;
  }
  return { json, bin };
}

function pickPivot(hist, lit) {
  const total = hist.reduce((a, b) => a + b, 0);
  const usable = total - hist[0];
  if (usable <= 0) return 128;
  let seen = 0;
  for (let v = 255; v > 0; v--) {
    seen += hist[v];
    if (seen >= usable * lit) return v;
  }
  return 128;
}

// Models whose base colour is NOT inside the model file. The two FBX creatures
// reference their maps by absolute Windows path or through 3dsMax shader slots,
// so nothing usable survives the export and there is no image to pull out of
// the binary — see the atlas. Their real source art is in the C4D asset
// library, outside the repo, so the mask is generated from there and only the
// MASK lands in public/. Paths are resolved against $HOME.
//
// Same shape as a GLB job, so everything downstream is unchanged.
const EXTERNAL = {
  seagull: 'Documents/_C4D/_ASSETS/SEAGULL RAW FILES/Textures/T_Seagull_BaseColor.jpg',
  morayeel: 'Documents/_C4D/_ASSETS/_Nature/096438851-gymnothorax-javanicus/tex/MorayEel_Diffuse(Standard).png',
  // The exact file beluga.fbx names, as an unreachable `D:\artworks\…` path.
  beluga: 'Documents/_C4D/_ASSETS/_Nature/beluga-whale/textures/beluga_whale_diff.png',
};

fs.mkdirSync(OUT, { recursive: true });

const jobs = [];
for (const f of fs.readdirSync(MODELS).filter((x) => x.endsWith('.glb')).sort()) {
  const model = f.replace(/\.glb$/, '');
  if (only.length && !only.includes(model)) continue;
  const { json, bin } = readGLB(path.join(MODELS, f));
  if (!json?.images?.length) continue;
  const base = new Map();
  for (const m of json.materials ?? []) {
    const ti = m.pbrMetallicRoughness?.baseColorTexture?.index;
    if (ti == null) continue;
    const img = json.textures?.[ti]?.source;
    if (img != null && !base.has(img)) base.set(img, true);
  }
  for (const img of base.keys()) {
    const bv = json.bufferViews[json.images[img].bufferView];
    if (!bv) continue;
    jobs.push({ model, img, multi: base.size > 1,
                bytes: bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength) });
  }
}

for (const [model, rel] of Object.entries(EXTERNAL)) {
  if (only.length && !only.includes(model)) continue;
  const src = path.join(os.homedir(), rel);
  if (!fs.existsSync(src)) {
    console.warn(`${model.padEnd(24)} SKIPPED — source art not found at ~/${rel}`);
    continue;
  }
  jobs.push({ model, img: 0, multi: false, bytes: fs.readFileSync(src), external: rel });
}

for (const j of jobs) {
  // A model with several base-colour textures gets one mask per texture,
  // suffixed by image index. `texture.emissive` is a single path applied to
  // every material on the asset, so those variants can't be wired as-is —
  // they're emitted so the data exists, not because they're usable yet.
  const name = j.multi ? `${j.model}__${j.img}` : j.model;
  // Two-tone masks stay PNG (a handful of colours, hard edges). Composites
  // carry the full base texture, so they're photographic and belong in JPEG —
  // PNG of one of these runs 8-10x larger for no visible gain.
  const out = path.join(OUT, `${name}.${PURE ? 'png' : 'jpg'}`);
  const raw = await sharp(j.bytes).greyscale().resize(256, 256, { fit: 'fill' }).raw().toBuffer();
  const hist = new Array(256).fill(0);
  for (const v of raw) hist[v]++;
  const pivot = pickPivot(hist, LIT);
  const slope = SLOPE;

  const mask = await sharp(j.bytes)
    .greyscale()
    .resize(512, 512, { fit: 'fill' })
    .blur(BLUR)
    .linear(slope, 128 - slope * pivot)
    .toColourspace('b-w')
    .png()
    .toBuffer();

  if (PURE) {
    await sharp(mask).png({ compressionLevel: 9, palette: true, colours: 16, dither: 0 }).toFile(out);
  } else {
    // 'lighten' takes the per-channel max, which is exactly the rule wanted:
    // white wins wherever the mask is lit, and the base colour survives
    // untouched wherever the mask is black. A plain alpha blend would instead
    // wash the whole texture toward grey through the mask's soft edges.
    const base = await sharp(j.bytes).resize(512, 512, { fit: 'fill' }).toColourspace('srgb').png().toBuffer();
    await sharp(base)
      .composite([{ input: mask, blend: 'lighten' }])
      .jpeg({ quality: 82, mozjpeg: true })
      .toFile(out);
  }

  const m = await sharp(mask).greyscale().raw().toBuffer();
  let lit = 0; for (const v of m) if (v > 127) lit++;
  console.log(`${name.padEnd(24)} pivot ${String(pivot).padStart(3)}  ${(100 * lit / m.length).toFixed(1).padStart(5)}% lit  ${(fs.statSync(out).size / 1024).toFixed(0).padStart(3)} KB  ${PURE ? 'two-tone' : 'composite'}${j.multi ? '   (multi-material — not wirable as one path)' : ''}`);
}
console.log(`\n${jobs.length} masks -> public/textures/emissive`);
