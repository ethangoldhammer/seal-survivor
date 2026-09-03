// ---------------------------------------------------------------------------
// GPU-COMPRESSED TEXTURES for every model — `npm run ktx2`.
//
// WHAT THIS IS FOR, and it is not download size. `npm run tex` measures the two
// costs separately and the split here is stark: the roster's textures are 27MB
// on disk (they are already WebP) and **405MB in VRAM**, because a WebP and a
// PNG decode to exactly the same RGBA8 upload. 405MB is survivable on a desktop
// GPU and is not survivable inside a WKWebView on a phone — past the budget the
// driver pages rather than fails, and the content process is eventually killed
// outright, which presents as the app vanishing.
//
// KTX2 fixes the column that matters. A .ktx2 stays compressed ON THE GPU:
// KTX2Loader transcodes to whatever the device wants — ASTC 4x4 on any iPhone —
// and that is 8 bits per texel against RGBA8's 32. Four times less, for every
// map, with no change to the pixel dimensions and so no art call to make.
//
// WHAT THIS DELIBERATELY DOES NOT DO: resize anything. The audit's `justified`
// column is the other lever and it is a bigger one on some models, but its own
// header says it is a ceiling and not a target — "step down one power of two,
// look at it, step again". That is an art judgement per model and it does not
// belong in a batch job. Compression is the free half; the resize is the half
// somebody has to look at.
//
// ETC1S FOR COLOUR, UASTC FOR NORMALS. ETC1S is the small one and its artefacts
// live in chroma, which is invisible on these stylised hides. A normal map is
// not a picture — its channels are a direction, and ETC1S's endpoint fitting
// puts visible facets into curved shading. UASTC costs disk and is the only
// honest option for the 13 normal maps in the roster.
//
// The source models are NEVER touched. Output goes to public/models-ktx2/ and
// the game prefers it per-file through the generated table this writes; a model
// that fails to encode simply keeps loading from public/models/.
//
// THE ONE WAY TO BE FOOLED BY THIS: replace a file in public/models/ and do not
// re-run it. The game will go on loading the twin, so the new art simply does
// not appear, with no error anywhere — and the file on disk is plainly correct,
// which is a bad hour. Re-running is cheap (this skips anything whose twin is
// already newer than its source), so run it after any change under
// public/models/. `--force` re-encodes everything.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { ktx2 } from 'ktx2-encoder/gltf-transform';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'public/models');
const OUT = path.join(ROOT, 'public/models-ktx2');
const BASIS_SRC = path.join(ROOT, 'node_modules/three/examples/jsm/libs/basis');
const BASIS_OUT = path.join(ROOT, 'public/basis');
const TABLE = path.join(ROOT, 'path/src/ktx2Models.js');

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const force = process.argv.includes('--force');

// The encoder is a WASM Basis build and takes raw RGBA — it cannot read the
// WebP and PNG the models carry, so decoding is ours to do. sharp is already a
// dependency (tools/app-icon.mjs), and ensureAlpha matters: a three-channel
// buffer is silently misread as a smaller image rather than rejected.
const imageDecoder = async (buffer) => {
  const { data, info } = await sharp(Buffer.from(buffer))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
};

// One pass per colour space, because "is this sRGB" is not a property of the
// file, it is a property of the SLOT the file is plugged into — and getting it
// wrong is a texture that is subtly too dark or too bright everywhere, with
// nothing in the pipeline to complain about it.
const PASSES = [
  {
    name: 'colour',
    slots: /baseColorTexture|emissiveTexture|diffuseTexture|specularTexture|specularGlossinessTexture/,
    options: { isUASTC: false, qualityLevel: 200, compressionLevel: 2, isPerceptual: true, isSetKTX2SRGBTransferFunc: true },
  },
  {
    name: 'data',
    slots: /metallicRoughnessTexture|occlusionTexture/,
    // Roughness and occlusion are numbers that happen to be stored as pixels.
    // Encoding them "perceptually" applies a curve to a value that was never a
    // colour, which reads as a material that is glossier in the mid-tones.
    options: { isUASTC: false, qualityLevel: 200, compressionLevel: 2, isPerceptual: false, isSetKTX2SRGBTransferFunc: false },
  },
  {
    name: 'normal',
    slots: /normalTexture|clearcoatNormalTexture/,
    options: { isUASTC: true, uastcLDRQualityLevel: 2, needSupercompression: true, isNormalMap: true, isPerceptual: false, isSetKTX2SRGBTransferFunc: false },
  },
];

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(BASIS_OUT, { recursive: true });

// THE TRANSCODER HAS TO BE SERVED. KTX2Loader fetches basis_transcoder.js and
// .wasm from the path it is given at runtime; copied here rather than committed
// by hand so it tracks whatever version of three is installed. A mismatch
// between the two is a transcode that fails at load with a message about an
// unknown format.
for (const f of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
  fs.copyFileSync(path.join(BASIS_SRC, f), path.join(BASIS_OUT, f));
}
console.log(`  transcoder  public/basis/ (from three ${JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/three/package.json'))).version})`);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const MB = 1024 * 1024;

// RGBA8 plus its mip chain, which is what an uncompressed upload actually
// costs. The same arithmetic tools/texture-audit.mjs prints.
const rgba8 = (w, h) => w * h * 4 * (4 / 3);
// ASTC 4x4 is one byte per texel, and the mip chain rides along the same way.
const astc = (w, h) => Math.ceil(w / 4) * Math.ceil(h / 4) * 16 * (4 / 3);

const files = fs.readdirSync(SRC)
  .filter((f) => f.endsWith('.glb'))
  .filter((f) => !only.length || only.includes(f) || only.includes(path.basename(f, '.glb')));

const done = [];
let vramBefore = 0;
let vramAfter = 0;
let diskBefore = 0;
let diskAfter = 0;

for (const file of files) {
  const src = path.join(SRC, file);
  const dst = path.join(OUT, file);
  // Incremental, on mtime. Encoding the whole roster is minutes of CPU and
  // almost every run of this changes one model.
  if (!force && fs.existsSync(dst) && fs.statSync(dst).mtimeMs >= fs.statSync(src).mtimeMs) {
    const doc = await io.read(dst);
    const sizes = doc.getRoot().listTextures().map((t) => t.getSize() ?? [0, 0]);
    if (sizes.length) {
      vramBefore += sizes.reduce((s, [w, h]) => s + rgba8(w, h), 0);
      vramAfter += sizes.reduce((s, [w, h]) => s + astc(w, h), 0);
      diskBefore += fs.statSync(src).size;
      diskAfter += fs.statSync(dst).size;
      done.push(file);
    }
    console.log(`  skip        ${file}`);
    continue;
  }

  const doc = await io.read(src);
  const textures = doc.getRoot().listTextures();
  if (!textures.length) continue; // nothing to compress; the game keeps the original

  const before = textures.map((t) => t.getSize() ?? [0, 0]);
  const t0 = Date.now();
  try {
    for (const pass of PASSES) {
      await doc.transform(ktx2({ imageDecoder, slots: pass.slots, ...pass.options }));
    }
  } catch (err) {
    // A model that will not encode is not a build failure — it simply does not
    // get an entry in the table, and the game goes on loading the original.
    console.warn(`  FAILED      ${file} — ${err?.message ?? err}`);
    continue;
  }

  // Proof rather than assumption: a slot regex that matched nothing leaves the
  // texture exactly as it was, and a model where every pass missed would
  // otherwise be written out unchanged and counted as a saving.
  const encoded = doc.getRoot().listTextures().filter((t) => t.getMimeType() === 'image/ktx2').length;
  if (!encoded) {
    console.warn(`  NONE        ${file} — no slot matched, left alone`);
    continue;
  }

  fs.writeFileSync(dst, await io.writeBinary(doc));
  vramBefore += before.reduce((s, [w, h]) => s + rgba8(w, h), 0);
  vramAfter += before.reduce((s, [w, h]) => s + astc(w, h), 0);
  diskBefore += fs.statSync(src).size;
  diskAfter += fs.statSync(dst).size;
  done.push(file);
  console.log(
    `  ${String(encoded).padStart(2)} maps     ${file.padEnd(24)} `
    + `${(fs.statSync(src).size / MB).toFixed(2)}MB -> ${(fs.statSync(dst).size / MB).toFixed(2)}MB  `
    + `${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
}

done.sort();

// --- THE MANIFEST IS THE OUTPUT DIRECTORY, NOT THIS RUN ----------------------
// Built by scanning public/models-ktx2/ rather than from `done`, and the
// difference is a whole roster.
//
// `done` is what THIS invocation encoded, which is every model only when the
// run had no name filter. `node tools/ktx2-models.mjs anglerfish` encodes one
// model and, written from `done`, publishes a list of one — so the other
// thirty-one lose their compressed twin, silently, and every creature in the
// game goes back to loading an uncompressed WebP. Nothing fails: the fallback
// path is the shipping path from before KTX2 existed, so the only symptom is
// the VRAM this tool was written to save quietly coming back. Measured when it
// happened: 232MB of RGBA8 where there had been a quarter of it.
//
// The directory cannot get that wrong, because the comment below is already the
// definition of the list — "the models that have a compressed twin in
// public/models-ktx2/" — and a scan is that sentence rather than a proxy for it.
// Intersected with the source directory so a twin left behind by a model that
// has since been deleted does not keep being advertised.
const sources = new Set(fs.readdirSync(SRC).filter((f) => f.endsWith('.glb')));
const shipped = fs.readdirSync(OUT)
  .filter((f) => f.endsWith('.glb') && sources.has(f))
  .sort();

fs.writeFileSync(TABLE, `// GENERATED by tools/ktx2-models.mjs — do not edit.
//
// The models that have a GPU-compressed twin in public/models-ktx2/. assets.js
// swaps the URL for anything named here; anything not named here loads from
// public/models/ exactly as it always did, which is what makes a model that
// fails to encode a non-event rather than a missing creature.
//
// A LIST AND NOT A DIRECTORY SCAN because the browser cannot read a directory,
// and the alternative — trying the compressed URL and falling back on a 404 —
// is a wasted round trip per model and, on a host with an SPA fallback, a 200
// carrying index.html that GLTFLoader then tries to parse. See the note in
// [[pages-spa-fallback-hides-404s]].
export const KTX2_MODELS = new Set(${JSON.stringify(shipped, null, 2).replace(/\n/g, '\n  ')});
`);

console.log(`\n  ${done.length} models compressed  ·  ${shipped.length} in the manifest`);
console.log(`  disk  ${(diskBefore / MB).toFixed(1)}MB -> ${(diskAfter / MB).toFixed(1)}MB`);
console.log(`  VRAM  ${(vramBefore / MB).toFixed(0)}MB -> ${(vramAfter / MB).toFixed(0)}MB  (RGBA8 vs ASTC 4x4, mips included)`);
console.log('\n  VRAM is the number this exists for. See the header, and `npm run tex`');
console.log('  for the resize lever, which is a separate and art-judged saving.\n');
