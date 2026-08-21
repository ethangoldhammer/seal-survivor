#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Cuts the SeaFlora&Shells pack (sea_bed.glb) into one prop per file, and
// prices each one like decor instead of like a hero model.
//
//   node tools/split-seabed.mjs                # measure, write nothing
//   node tools/split-seabed.mjs --sweep        # cost of each deviation budget
//   node tools/split-seabed.mjs --write        # write public/models/seabed/
//   node tools/split-seabed.mjs --error=0.02   # looser deviation budget
//   node tools/split-seabed.mjs --floor=200    # never go below this many tris
//   node tools/split-seabed.mjs --merge=0.25   # fewer, coarser prop groups
//   node tools/split-seabed.mjs --keep-unlit   # leave KHR_materials_unlit on
//
// WHAT ARRIVED. sea_bed.glb is a Sketchfab scene, not an asset pack: 86 meshes
// on 175 nodes, 368,982 triangles, 11.5MB. For scale, the whole shipped roster
// — 55 models, every creature and boss in the game — is 428,649 triangles. One
// seabed dressing file is 86% of that, and the thing it is dressing the seabed
// WITH is already in the game: grass.glb, a scattered clump, 452 triangles.
//
// The 86 meshes are 45 distinct shapes and 19 keepable PROPS. Plant1 alone
// appears 37 times: four fronds at three sizes, and thirty-three copies of a
// leaf 10cm long that differ from each other by a few vertices of hand-nudging.
// A scatter system wants one file per prop and its own random rotation, not
// nineteen near-identical files of one leaf.
//
// WHAT THIS DOES, per prop:
//
//   1. GROUPS the meshes by SHAPE — a scale- and rotation-invariant signature,
//      so 32 hand-nudged placements of one leaf are one prop while Plant1's
//      frond and Plant1's leaf are two. Neither obvious key works: by name,
//      "Plant1" is three different plants; by geometry, the leaf is 19 files.
//   2. BAKES the node chain. The source nests a 0.01 scale under per-prop
//      scales of 15–446, so a plant's own vertices are in centimetre-ish units
//      that mean nothing on their own. Baking rotation and scale but NOT
//      translation keeps every prop at its true size relative to the others,
//      which is the only reason the family reads as one set.
//      That bake is also the whole of the axis handling: the pack's Z-up to
//      Y-up conversion lives on the individual prop nodes, so baking the world
//      matrix lands every plant growing along +Y with nothing added on top —
//      see bakeMatrix, and the mistake it documents. Y-up means one assets.js
//      entry, `forward: '+Y', up: '-X'`, the pair grass already uses.
//   3. SEATS the base at y=0, centred on x/z. prepareModel recentres on the
//      centroid anyway, so this is for anything that loads the file directly.
//   4. FIXES THE MATERIAL, which is the part that decides whether any of this
//      renders at all. Every material in the pack is unlit with a BLACK
//      baseColorFactor and the art in the EMISSIVE slot. KHR_materials_unlit
//      maps to MeshBasicMaterial in three.js, and MeshBasicMaterial has no
//      emissive — it does not ignore it in a subtle way, it has no such
//      channel. Loaded as shipped, every plant, shell and bubble in this file
//      draws pure black and nothing throws. So base colour takes the emissive
//      map, the factor takes the emissive factor (keeping the old alpha), and
//      the emissive slot is cleared. The two materials that ALSO had a base
//      map keep its alpha channel — see repairMaterial for why those maps look
//      like blank placeholders and are not.
//   5. CROPS the atlas. All twelve plants and shells share one 512x1024
//      watercolour sheet, and each uses a patch of it — the conch is 52x138
//      texels of the 524,288. Kept whole it is 2.7MB of VRAM per prop, and
//      per PROP is right rather than alarmist: three.js keys texture uploads
//      on the image source, and one .glb per file means one source per file,
//      so twelve copies of the sheet is twelve uploads. Cropping to the prop's
//      own UV box with four texels of margin, then fitting to a power of two,
//      is where most of the 12.1MB goes.
//   6. WELDS BY POSITION, then decimates to a MEASURED deviation budget —
//      binary-searching the triangle count until the surface really is within
//      tolerance, one connected strand at a time. Each of those three words is
//      load-bearing and each is explained where it happens: see weldByPosition
//      (gltf-transform's weld() merges nothing at all here), deviation (a
//      bounding box cannot see a deleted strand), and simplifyComponents.
//
// Every prop is a closed solid — a watercolour silhouette extruded and
// solidified, 0 boundary edges on all of them — so there is no alpha cut whose
// fringe a simplifier could eat, and the only thing to protect is the outline.
// Holding the budget as a fraction of the prop's OWN longest axis is what lets
// a 10cm leaf and a 1.4-unit kelp frond be held to the same visual tolerance
// rather than the same triangle count.
//
// UNLIT COMES OFF by default. grass.glb is lit on purpose, so the daylight
// cycle reaches it — decor that stays noon-bright while the water goes to dusk
// is the thing that gives decor away — and these props stand in the same water.
// --keep-unlit puts it back.
// ---------------------------------------------------------------------------

import { Document, Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { copyToDocument, transformPrimitive, simplifyPrimitive, prune, dedup } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const num = (n, d) => {
  const a = argv.find((s) => s.startsWith(`--${n}=`));
  return a ? Number(a.split('=')[1]) : d;
};
const str = (n, d) => {
  const a = argv.find((s) => s.startsWith(`--${n}=`));
  return a ? a.split('=').slice(1).join('=') : d;
};

const SRC = argv.find((s) => !s.startsWith('--'))
  ?? '/Users/ethangoldhammer/Documents/_DesignSystems/SealSurvivor/sea_bed.glb';
const OUTDIR = str('out', path.join(ROOT, 'public/models/seabed'));
// Previews go outside public/ — vite copies that folder into the build
// wholesale, so a spare .glb left there ships to every player. `--out` without
// `--write` redirects them, which is how the render harness gets at them.
const PREVIEW = str('out', path.join(ROOT, '.model-orig/seabed'));

// Fraction of the prop's own longest axis the silhouette may move. 1% on a
// plant that is drawn a few hundred pixels tall at most is a couple of pixels
// of outline, and these are watercolour blobs whose outline is a soft edge in
// the texture anyway — there is no hard feature at this scale to lose.
const ERROR = num('error', 0.01);
// The simplifier is asked for this fraction and stops early when the error
// budget binds, so the budget is what actually decides. 0.02 is low enough to
// never be the constraint on the props that could go further.
const RATIO = num('ratio', 0.02);
// ...except on the small props, where 2% of 768 triangles is a tetrahedron.
const FLOOR = num('floor', 150);
// Texels of margin around a prop's UV box. Four is enough that the bilinear
// kernel and the first two mip levels stay inside the crop; the sheet has
// white gaps between the props anyway, so a margin that overruns picks up
// background rather than a neighbour's leaf.
const PAD = num('pad', 4);
// Position-weld tolerance, as a fraction of the prop's longest axis. 1e-5 is
// tight enough that two genuinely distinct surfaces never merge and loose
// enough to catch the exporter's float drift at a seam.
const WELD_EPS = num('weld-eps', 1e-5);
// Crops are fitted UP to a power of two, capped here. 256 on a prop whose
// widest patch is 157 texels is already more texel than the source has.
const MAXTEX = num('maxtex', 256);

const write = has('write');
const sweep = has('sweep');
const keepUnlit = has('keep-unlit');

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
// prune() narrates every accessor it drops, twenty-eight times over.
const QUIET = new Logger(Logger.Verbosity.ERROR);

// --- little bits of linear algebra -----------------------------------------
// Column-major, matching the mat4 layout gltf-transform passes around.
// The pack's axis conversion is already IN the node chain, and it is worth
// being exact about where, because it is not where it looks like it is. The two
// Sketchfab wrappers rotate -90 and +90 about X and cancel; the conversion is
// on each PROP node, which carries its own -90 about X. So the world matrix
// alone lands a plant growing along +Y, and an axis fix applied on top of it —
// which is what the first version of this tool did, on the strength of the
// wrappers cancelling — rotates every prop back to Z-up. That renders as a
// contact sheet of plants pointing at the camera: each one foreshortened to a
// few pixels, and no error anywhere.

const bboxOf = (prim) => {
  const pos = prim.getAttribute('POSITION');
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const e = [0, 0, 0];
  for (let i = 0; i < pos.getCount(); i++) {
    pos.getElement(i, e);
    for (let k = 0; k < 3; k++) {
      if (e[k] < b[k]) b[k] = e[k];
      if (e[k] > b[k + 3]) b[k + 3] = e[k];
    }
  }
  return b;
};
const triCount = (prim) => {
  const idx = prim.getIndices();
  return Math.round((idx ? idx.getCount() : prim.getAttribute('POSITION').getCount()) / 3);
};
const uvBox = (prim) => {
  const uv = prim.getAttribute('TEXCOORD_0');
  if (!uv) return null;
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const e = [0, 0];
  for (let i = 0; i < uv.getCount(); i++) {
    uv.getElement(i, e);
    b[0] = Math.min(b[0], e[0]); b[1] = Math.min(b[1], e[1]);
    b[2] = Math.max(b[2], e[0]); b[3] = Math.max(b[3], e[1]);
  }
  return b;
};

// --- read the pack ----------------------------------------------------------

if (!fs.existsSync(SRC)) {
  console.error(`\nno such file: ${SRC}\n`);
  process.exit(1);
}
const doc = await io.read(SRC);
const root = doc.getRoot();
const srcBytes = fs.statSync(SRC).size;

let srcTris = 0;
for (const m of root.listMeshes()) for (const p of m.listPrimitives()) srcTris += triCount(p);

console.log(`\n${path.basename(SRC)} — ${root.listMeshes().length} meshes, ${root.listNodes().length} nodes, `
  + `${srcTris.toLocaleString()} triangles, ${(srcBytes / 1024 / 1024).toFixed(1)}MB`);

// --- group the meshes into props -------------------------------------------
//
// The hard part of "break this out" is deciding what a prop IS. Neither of the
// two obvious answers works:
//
//   - by NAME: "Plant1" is 37 meshes and at least three different plants — a
//     1.45-unit frond, a mid one, and a 10cm leaf.
//   - by GEOMETRY: 45 of the 86 meshes are distinct vertex-for-vertex, because
//     the leaf was hand-nudged in each of its 32 placements. That is 19 files
//     of the same leaf.
//
// So: by SHAPE, up to placement. Each mesh gets a signature that is invariant
// under the things the scene did to it and sensitive to the things the modeller
// did — vertices to the centroid, normalised so the RMS radius is 1 (kills
// scale), binned by distance (kills rotation). Two placements of one leaf land
// on top of each other; the frond and the leaf do not. `--merge` is the L1
// distance under which two signatures are called the same prop, and the
// clustering is printed so the number can be argued with.
//
// This is also what stops the silent duplicates: Clam Shell appears at three
// scales and one rotation, and grouping on world size alone exported it twice.

const MERGE = num('merge', 0.15);
const BINS = 16;
const SIG_HI = 2.5;                   // bins span 0..2.5 RMS radii

/** A mesh node's world matrix with the translation column zeroed. */
function bakeMatrix(node) {
  const w = node.getWorldMatrix().slice();
  w[12] = w[13] = w[14] = 0;
  return w;
}

const candidates = [];
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const prim = mesh.listPrimitives()[0];
  const M = bakeMatrix(node);
  const pos = prim.getAttribute('POSITION');
  const e = [0, 0, 0];

  // Baked positions, once — the signature and the world extents both need them,
  // and some props carry a NON-UNIFORM scale (Waves/Wind.003 is 161/161/76),
  // which changes the shape rather than just its size. Signing the unbaked
  // vertices would call those the same prop.
  const P = new Float64Array(pos.getCount() * 3);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  let cx = 0; let cy = 0; let cz = 0;
  for (let i = 0; i < pos.getCount(); i++) {
    pos.getElement(i, e);
    for (let k = 0; k < 3; k++) {
      const v = M[k] * e[0] + M[4 + k] * e[1] + M[8 + k] * e[2];
      P[i * 3 + k] = v;
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
    cx += P[i * 3]; cy += P[i * 3 + 1]; cz += P[i * 3 + 2];
  }
  const n = pos.getCount();
  cx /= n; cy /= n; cz /= n;

  let ss = 0;
  const rs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = Math.hypot(P[i * 3] - cx, P[i * 3 + 1] - cy, P[i * 3 + 2] - cz);
    rs[i] = r; ss += r * r;
  }
  const rms = Math.sqrt(ss / n) || 1;
  const sig = new Float64Array(BINS);
  for (let i = 0; i < n; i++) sig[Math.min(BINS - 1, Math.floor((rs[i] / rms / SIG_HI) * BINS))]++;
  for (let i = 0; i < BINS; i++) sig[i] /= n;

  const size = [0, 1, 2].map((k) => hi[k] - lo[k]);
  const base = (mesh.getName() || node.getName() || 'prop').replace(/\.\d{3}(?=_|$)/, '').replace(/_[A-Za-z]+_0$/, '');
  candidates.push({ node, mesh, prim, base, size, longest: Math.max(...size), tris: triCount(prim), M, sig });
}

const sigDist = (a, b) => { let s = 0; for (let i = 0; i < BINS; i++) s += Math.abs(a[i] - b[i]); return s; };

const byBase = new Map();
for (const c of candidates) {
  if (!byBase.has(c.base)) byBase.set(c.base, []);
  byBase.get(c.base).push(c);
}

// --- what each prop actually is ---------------------------------------------
//
// The pack's own names are a modeller's working notes — "Plant1" is three
// different plants and "Plan3" is a typo — so the ids they slug into say
// nothing about what comes out. This table renames them to the species they
// are, read off the contact sheet rather than off the source names.
//
// The key is the id the clustering above produces (base name, then `_b`, `_c`
// by descending size), so a species can own several variants: kelp is three
// lengths of the same leafy strand, broadleaf is a big blade plus three small
// leaves. That is what a scatter wants — one species, several shapes, so a bed
// of it does not read as a stamp repeated.
//
// Anything mapped to null is not exported. The Waves/Wind meshes are white
// ribbon curls with no texture at all, meant to be read as motion lines in a
// still render; in a game that has actual water they are nothing.
const SPECIES = {
  plant1: 'kelp', plant1_b: 'kelp_b', plant1_c: 'kelp_c',
  plant4: 'broadleaf', plant1_d: 'broadleaf_b', plant1_e: 'broadleaf_c', plant1_f: 'broadleaf_d',
  plant2: 'ribbonweed', plant2_b: 'ribbonweed_b',
  plan3: 'bladegrass',
  plant6: 'fanweed',
  plant7: 'fern',
  plant5: 'reed',
  coralplant: 'coral', coralplant_b: 'coral_b',
  clamshell: 'clamshell', conchshell: 'conchshell', bubble: 'bubble',
  backgroundeffect: 'cloudcard',
  waveswind: null, waveswind_b: null, waveswind_c: null, waveswind_d: null,
};

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const SUFFIX = ['', '_b', '_c', '_d', '_e', '_f', '_g', '_h'];
const props = [];
const dropped = [];
const cut = [];
for (const [base, list] of byBase) {
  const clusters = [];
  // Densest first, so the mesh that seeds a cluster — and becomes its
  // representative — is the one that was modelled rather than a hand-thinned
  // copy of it.
  for (const c of list.slice().sort((a, b) => b.tris - a.tris)) {
    const hit = clusters.find((cl) => sigDist(cl[0].sig, c.sig) < MERGE);
    if (hit) hit.push(c); else clusters.push([c]);
  }
  clusters.sort((a, b) => b[0].longest - a[0].longest);
  clusters.forEach((cl, i) => {
    const raw = slug(base) + (clusters.length > 1 ? SUFFIX[i] ?? `_${i}` : '');
    // An id the table has never heard of keeps its generated name and is
    // exported. Silently dropping it instead would mean a re-clustered prop
    // (a different --merge, a re-exported source) vanishing with no mention.
    const id = raw in SPECIES ? SPECIES[raw] : raw;
    if (id === null) { cut.push(raw); return; }
    props.push({
      id,
      raw,
      base,
      rep: cl[0],
      copies: cl.length,
      spread: [Math.min(...cl.map((m) => m.longest)), Math.max(...cl.map((m) => m.longest))],
    });
  });
}

// THE SWATCH PLANE. Sketchfab authors leave texture previews in the scene, and
// tools/optimize-grass.mjs had to drop four of them for the same reason: they
// are not props, they are the sheet held up flat. The signature here is exact —
// two triangles, showing the WHOLE of a texture that other props are using
// pieces of. A real backdrop card (Background Effect, the teal watercolour
// cloud) owns its texture and survives this.
// The art can be in either slot — the plants carry it as emissive, AquaFlora
// as base colour — so the sheet has to be looked for in both, or the swatch
// that holds the WHOLE sheet is the one prop the rule misses.
const artOf = (prim) => {
  const m = prim.getMaterial();
  return m ? (m.getEmissiveTexture() ?? m.getBaseColorTexture()) : null;
};
const sharedTex = new Map();
for (const p of props) {
  const t = artOf(p.rep.prim);
  if (t) sharedTex.set(t, (sharedTex.get(t) ?? 0) + 1);
}
for (let i = props.length - 1; i >= 0; i--) {
  const p = props[i];
  const t = artOf(p.rep.prim);
  const box = uvBox(p.rep.prim);
  const whole = box && box[0] <= 0.001 && box[1] <= 0.001 && box[2] >= 0.999 && box[3] >= 0.999;
  if (p.rep.tris <= 2 && whole && t && sharedTex.get(t) > 1) {
    dropped.push(p);
    props.splice(i, 1);
  }
}

props.sort((a, b) => b.rep.tris - a.rep.tris);

console.log(`\n${props.length} props from ${candidates.length} meshes `
  + `(shape merge threshold ${MERGE}):\n`);
console.log('  id              was          source name       placed   src tris   size range   world size (baked, Y-up)');
for (const p of props) {
  console.log(`  ${p.id.padEnd(15)} ${p.raw.padEnd(12)} ${p.base.padEnd(17)} ${String(p.copies).padStart(5)}   ${String(p.rep.tris).padStart(8)}   `
    + `${p.spread[0].toFixed(2)}-${p.spread[1].toFixed(2)}`.padStart(11) + '   '
    + p.rep.size.map((v) => v.toFixed(3)).join(' x '));
}
for (const p of dropped) {
  console.log(`\n  dropped ${p.id} — ${p.rep.tris} triangles showing the whole shared texture sheet: a swatch preview, not a prop.`);
}
if (cut.length) console.log(`\n  not exported (SPECIES table): ${cut.sort().join(', ')}`);

// --- the material every prop shares the fix for -----------------------------

/**
 * Sketchfab exported this pack emission-only: the art is in the emissive slot,
 * baseColorFactor is black, and KHR_materials_unlit is on — which in three.js
 * is a MeshBasicMaterial, a shader with no emissive channel at all. Move the
 * art to base colour or the prop renders black.
 *
 * Returns a note for the report, or null if the material needed nothing.
 */
async function repairMaterial(mat, log) {
  const emisTex = mat.getEmissiveTexture();
  const baseTex = mat.getBaseColorTexture();
  const emisFactor = mat.getEmissiveFactor();
  const alpha = mat.getBaseColorFactor()[3];

  if (emisTex) {
    // THE BASE MAP IS NOT BLANK, which is the second trap in this material and
    // the one that survives fixing the first. Both base-colour maps in the pack
    // are pure white in RGB — min and max both 255 on all three channels — so
    // they look like placeholders and dropping them looks free. Their ALPHA is
    // the artwork: tex1 carries the cloud's silhouette and tex3 the bubbles'.
    // The emissive JPEG has no alpha channel at all, so promoting it on its own
    // turns a soft transparent bubble into an opaque white ball and the cutout
    // cloud card into a black rectangle — which is exactly what the first
    // contact sheet showed, on the two props whose art is a cutout.
    //
    // So: emissive RGB, base alpha, one texture.
    if (baseTex && baseTex !== emisTex) {
      const [ew, eh] = emisTex.getSize();
      const rgb = sharp(Buffer.from(emisTex.getImage())).resize(ew, eh, { fit: 'fill' });
      const mask = await sharp(Buffer.from(baseTex.getImage()))
        .resize(ew, eh, { fit: 'fill' })
        .ensureAlpha()
        .extractChannel(3)
        .raw()
        .toBuffer();
      const merged = await rgb
        .removeAlpha()
        .joinChannel(mask, { raw: { width: ew, height: eh, channels: 1 } })
        .png()
        .toBuffer();
      const combined = emisTex.clone().setImage(merged).setMimeType('image/png');
      mat.setBaseColorTexture(combined);
      log.push('emissive map + base map\'s alpha -> one base-colour map');
    } else {
      mat.setBaseColorTexture(emisTex);
      log.push('emissive map -> base colour');
    }
    mat.setBaseColorFactor([1, 1, 1, alpha]);
    mat.setEmissiveTexture(null);
  } else {
    // Waves/Wind carries no map at all: black base, white emissive factor.
    // The colour it was authored to be is the emissive one.
    mat.setBaseColorFactor([...emisFactor, alpha]);
    log.push(`emissive factor -> base colour (${emisFactor.map((v) => v.toFixed(2)).join(',')})`);
  }
  mat.setEmissiveFactor([0, 0, 0]);

  if (!keepUnlit && mat.getExtension('KHR_materials_unlit')) {
    mat.setExtension('KHR_materials_unlit', null);
    // grass.glb's values — wet plant is not metal, and a high roughness keeps
    // the key light off a flat watercolour surface as a specular hotspot.
    mat.setRoughnessFactor(0.9);
    mat.setMetallicFactor(0);
    log.push('unlit off, roughness 0.9 / metalness 0');
  }
  return log;
}

/**
 * Crop the shared sheet down to this prop's own UV box and remap the UVs into
 * the crop. Returns {before, after} pixel dimensions, or null when the prop
 * has no map.
 */
async function cropTexture(prim, tex, notes) {
  const box = uvBox(prim);
  if (!box) return null;
  const [W, H] = tex.getSize();

  // glTF puts the UV origin at the TOP-LEFT, which is also sharp's origin, so
  // v maps straight to y with no flip. (flipY is a three.js render-time thing
  // and does not survive an export — see tools/fbx-to-glb notes.)
  const left = Math.max(0, Math.floor(box[0] * W) - PAD);
  const top = Math.max(0, Math.floor(box[1] * H) - PAD);
  const right = Math.min(W, Math.ceil(box[2] * W) + PAD);
  const bottom = Math.min(H, Math.ceil(box[3] * H) + PAD);
  const cw = Math.max(1, right - left);
  const ch = Math.max(1, bottom - top);

  if (cw >= W && ch >= H) {
    notes.push(`texture uses the whole ${W}x${H} sheet — not cropped`);
    return { before: [W, H], after: [W, H] };
  }

  const pot = (n) => Math.min(MAXTEX, 2 ** Math.ceil(Math.log2(Math.max(2, n))));
  const tw = pot(cw);
  const th = pot(ch);

  const out = await sharp(Buffer.from(tex.getImage()))
    .extract({ left, top, width: cw, height: ch })
    .resize(tw, th, { fit: 'fill' })
    .webp({ quality: 92, alphaQuality: 100 })
    .toBuffer();
  tex.setImage(out).setMimeType('image/webp');

  // Normalised coordinates, so the resize to a power of two does not enter
  // into it — only the crop does.
  const uv = prim.getAttribute('TEXCOORD_0');
  const e = [0, 0];
  for (let i = 0; i < uv.getCount(); i++) {
    uv.getElement(i, e);
    uv.setElement(i, [(e[0] * W - left) / cw, (e[1] * H - top) / ch]);
  }
  return { before: [W, H], after: [tw, th] };
}

// --- build one file per prop ------------------------------------------------

await MeshoptSimplifier.ready;

/** RGBA8 plus the mip chain — the arithmetic tools/texture-audit.mjs uses. */
const vramOf = (w, h) => (w * h * 4 * 4) / 3;

// Budgets the sweep prices, as a fraction of each prop's longest axis.
const SWEEP_BUDGETS = [0.005, 0.01, 0.02, 0.05, 0.10];

// --- how far the surface actually moved -------------------------------------
//
// A bounding box cannot answer this. Every prop in this pack is a BUNDLE of
// separate closed strands — Plant7 is 23 of them, Plant6 is 11 — and the
// cheapest thing a quadric simplifier can do to a bundle is delete a whole
// interior strand, which costs it nothing on any corner of the box. The first
// run of this tool reported Plant6 at 17,264 -> 344 triangles with the
// silhouette "moved 0.27%", and 344 triangles cannot be 11 strands.
//
// So: one-sided Hausdorff. Take the ORIGINAL vertices and measure each one's
// distance to the nearest point on the SIMPLIFIED surface. A deleted strand
// puts its whole length of vertices far from anything that is left, and shows
// up in the maximum immediately. Point-to-TRIANGLE, not point-to-vertex — a
// coarse mesh has few vertices and a vertex distance would report a large
// error for a surface that is actually right there.

/** Squared distance from p to triangle (a,b,c). Ericson, Real-Time Collision Detection. */
function pointTriSq(p, a, b, c) {
  const abx = b[0] - a[0]; const aby = b[1] - a[1]; const abz = b[2] - a[2];
  const acx = c[0] - a[0]; const acy = c[1] - a[1]; const acz = c[2] - a[2];
  const apx = p[0] - a[0]; const apy = p[1] - a[1]; const apz = p[2] - a[2];
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let x; let y; let z;
  if (d1 <= 0 && d2 <= 0) { x = a[0]; y = a[1]; z = a[2]; } else {
    const bpx = p[0] - b[0]; const bpy = p[1] - b[1]; const bpz = p[2] - b[2];
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { x = b[0]; y = b[1]; z = b[2]; } else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        x = a[0] + abx * v; y = a[1] + aby * v; z = a[2] + abz * v;
      } else {
        const cpx = p[0] - c[0]; const cpy = p[1] - c[1]; const cpz = p[2] - c[2];
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { x = c[0]; y = c[1]; z = c[2]; } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            x = a[0] + acx * w; y = a[1] + acy * w; z = a[2] + acz * w;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
              const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
              x = b[0] + (c[0] - b[0]) * w; y = b[1] + (c[1] - b[1]) * w; z = b[2] + (c[2] - b[2]) * w;
            } else {
              const den = 1 / (va + vb + vc);
              const v = vb * den; const w = vc * den;
              x = a[0] + abx * v + acx * w; y = a[1] + aby * v + acy * w; z = a[2] + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  const dx = p[0] - x; const dy = p[1] - y; const dz = p[2] - z;
  return dx * dx + dy * dy + dz * dz;
}

const SAMPLES = num('samples', 4000);

/**
 * Deviation of `prim`'s surface from the original vertex cloud, in model
 * units. Brute force over triangles, with a bounding-sphere reject — a few
 * thousand samples against a few thousand triangles is a second at worst, and
 * an acceleration structure here would be more code than the thing it speeds
 * up.
 */
function deviation(samples, prim) {
  const pos = prim.getAttribute('POSITION');
  const idx = prim.getIndices();
  const n = idx ? idx.getCount() : pos.getCount();
  const tri = [];
  const e = [0, 0, 0];
  for (let i = 0; i < n; i += 3) {
    const v = [];
    for (let j = 0; j < 3; j++) { pos.getElement(idx ? idx.getScalar(i + j) : i + j, e); v.push([e[0], e[1], e[2]]); }
    const cx = (v[0][0] + v[1][0] + v[2][0]) / 3;
    const cy = (v[0][1] + v[1][1] + v[2][1]) / 3;
    const cz = (v[0][2] + v[1][2] + v[2][2]) / 3;
    let r = 0;
    for (const q of v) r = Math.max(r, Math.hypot(q[0] - cx, q[1] - cy, q[2] - cz));
    tri.push({ v, c: [cx, cy, cz], r });
  }
  let max = 0; let sum = 0;
  const all = [];
  for (const p of samples) {
    let best = Infinity;
    for (const t of tri) {
      const dx = p[0] - t.c[0]; const dy = p[1] - t.c[1]; const dz = p[2] - t.c[2];
      const lo = Math.hypot(dx, dy, dz) - t.r;
      if (lo > 0 && lo * lo >= best) continue;
      const d = pointTriSq(p, t.v[0], t.v[1], t.v[2]);
      if (d < best) best = d;
    }
    const d = Math.sqrt(best);
    all.push(d);
    sum += d;
    if (d > max) max = d;
  }
  all.sort((a, b) => a - b);
  return { max, mean: sum / all.length, p99: all[Math.min(all.length - 1, Math.floor(all.length * 0.99))] };
}

/** Up to SAMPLES of a primitive's vertices, evenly strided. */
function sampleVerts(prim) {
  const pos = prim.getAttribute('POSITION');
  const step = Math.max(1, Math.floor(pos.getCount() / SAMPLES));
  const out = []; const e = [0, 0, 0];
  for (let i = 0; i < pos.getCount(); i += step) { pos.getElement(i, e); out.push([e[0], e[1], e[2]]); }
  return out;
}

// --- welding, for real ------------------------------------------------------
//
// gltf-transform's weld() merges vertices that are identical in EVERY
// attribute. On this pack that is nothing at all: Plant7 goes in with 21,888
// vertices and comes out with 21,888, because the exporter split them at every
// UV seam and hard edge and so no two agree on their normal. The mesh LOOKS
// welded — 0 boundary edges, closed shells — and is not: as far as the
// simplifier's topology is concerned it is 3,458 loose fragments, of which
// 3,428 are single quads. An edge collapse cannot cross a fragment boundary,
// so the ratio silently under-delivers and then jams. That is what the 7,000
// triangle plateau on Plant7 was, and it survived a weld() call sitting right
// above it doing nothing.
//
// So: weld on POSITION only, quantised, and let the seam vertices merge. What
// that throws away is the second copy of a normal or a UV at a seam. The UV
// loss is a few texels on a watercolour gradient. The normal loss is real — a
// hard extrusion rim becomes smooth — and normals are recomputed after
// decimation anyway, since the simplifier moves the surface out from under
// whatever they were.

/** Weld by position, quantised to `eps` of the prop's own size. First value wins for the rest. */
function weldByPosition(prim, eps) {
  const pos = prim.getAttribute('POSITION');
  const idx = prim.getIndices();
  const n = pos.getCount();
  const b = bboxOf(prim);
  const scale = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]) || 1;
  const q = eps * scale;

  const semantics = ['POSITION', 'NORMAL', 'TEXCOORD_0'].filter((s) => prim.getAttribute(s));
  const table = new Map();
  const remap = new Uint32Array(n);
  const kept = [];
  const e = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    pos.getElement(i, e);
    const key = `${Math.round(e[0] / q)},${Math.round(e[1] / q)},${Math.round(e[2] / q)}`;
    let at = table.get(key);
    if (at === undefined) { at = kept.length; table.set(key, at); kept.push(i); }
    remap[i] = at;
  }
  if (kept.length === n) return n;

  for (const s of semantics) {
    const a = prim.getAttribute(s);
    const size = a.getElementSize();
    const arr = new Float32Array(kept.length * size);
    const el = new Array(size);
    kept.forEach((from, to) => { a.getElement(from, el); arr.set(el, to * size); });
    prim.setAttribute(s, a.clone().setArray(arr));
  }
  // Every primitive in this pack is indexed; an unindexed one would need an
  // accessor built from the host document, which this helper does not hold.
  if (!idx) throw new Error('weldByPosition expects an indexed primitive');
  const out = new Uint32Array(idx.getCount());
  for (let i = 0; i < out.length; i++) out[i] = remap[idx.getScalar(i)];
  prim.setIndices(idx.clone().setArray(out));
  return kept.length;
}

/**
 * Area-weighted smooth normals. The simplifier moves the surface, so whatever
 * normals came in describe a shape that no longer exists; recomputing is not
 * optional tidying.
 */
function recomputeNormals(prim) {
  const pos = prim.getAttribute('POSITION');
  const nrm = prim.getAttribute('NORMAL');
  if (!nrm) return;
  const idx = prim.getIndices();
  const n = pos.getCount();
  const acc = new Float64Array(n * 3);
  const a = [0, 0, 0]; const b = [0, 0, 0]; const c = [0, 0, 0];
  const count = idx ? idx.getCount() : n;
  for (let i = 0; i < count; i += 3) {
    const ia = idx ? idx.getScalar(i) : i;
    const ib = idx ? idx.getScalar(i + 1) : i + 1;
    const ic = idx ? idx.getScalar(i + 2) : i + 2;
    pos.getElement(ia, a); pos.getElement(ib, b); pos.getElement(ic, c);
    // Cross product of the edges, NOT normalised — its length is twice the
    // triangle's area, which is the weight we want.
    const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    for (const v of [ia, ib, ic]) { acc[v * 3] += nx; acc[v * 3 + 1] += ny; acc[v * 3 + 2] += nz; }
  }
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const len = Math.hypot(acc[i * 3], acc[i * 3 + 1], acc[i * 3 + 2]) || 1;
    arr[i * 3] = acc[i * 3] / len;
    arr[i * 3 + 1] = acc[i * 3 + 1] / len;
    arr[i * 3 + 2] = acc[i * 3 + 2] / len;
  }
  prim.setAttribute('NORMAL', nrm.clone().setArray(arr));
}

// --- decimating a bundle of strands ----------------------------------------
//
// Every plant here is several separate closed shells: Plant7 is 23 strands,
// Plant6 is 11, Plant1 is 15. Handing the whole bundle to meshopt at a low
// ratio does not thin the strands, it DELETES them — measured, at ratio 0.1
// Plant7 comes back as one component instead of 23 — and then jams, because
// whatever survives is the one piece it cannot collapse further. The sweep
// showed it as a plateau: 7,614 triangles at a 0.5% budget and 6,990 at 10%,
// a budget twenty times looser buying 8% fewer triangles. That is not a
// quality/cost curve, it is a wall.
//
// So each strand is simplified on its own and the results are concatenated.
// A strand cannot then be spent to buy budget for its neighbours, every one
// of them gets thinned by the same proportion, and the bundle stays a bundle.

/** Triangle lists per connected component, over a WELDED primitive. */
function components(prim) {
  const pos = prim.getAttribute('POSITION');
  const idx = prim.getIndices();
  const n = idx ? idx.getCount() : pos.getCount();
  const parent = new Int32Array(pos.getCount());
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const at = (i) => (idx ? idx.getScalar(i) : i);
  for (let i = 0; i < n; i += 3) {
    const a = find(at(i)); const b = find(at(i + 1)); const c = find(at(i + 2));
    if (a !== b) parent[b] = a;
    if (find(a) !== c) parent[c] = find(a);
  }
  const buckets = new Map();
  for (let i = 0; i < n; i += 3) {
    const r = find(at(i));
    if (!buckets.has(r)) buckets.set(r, []);
    buckets.get(r).push(at(i), at(i + 1), at(i + 2));
  }
  return [...buckets.values()];
}

// A strand thinned past this stops being a tube and starts being a splinter.
const COMPONENT_FLOOR = num('component-floor', 24);

/**
 * Simplify `prim` in place, one connected component at a time. `prim` must
 * already be welded — the components are found on vertex indices, and an
 * unwelded seam would split one strand into several.
 */
function simplifyComponents(hostDoc, prim, ratio) {
  const parts = components(prim);
  if (parts.length <= 1) {
    simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio, error: 1, lockBorder: false });
    return 1;
  }

  const semantics = ['POSITION', 'NORMAL', 'TEXCOORD_0'].filter((s) => prim.getAttribute(s));
  const src = Object.fromEntries(semantics.map((s) => [s, prim.getAttribute(s)]));
  const stacks = Object.fromEntries(semantics.map((s) => [s, []]));
  const outIndices = [];
  let base = 0;

  for (const tris of parts) {
    // Compact the component onto its own vertices, or the simplifier prices a
    // strand against the extents of the whole plant and every ratio reads as
    // already-tiny.
    const remap = new Map();
    const local = [];
    for (const v of tris) {
      if (!remap.has(v)) remap.set(v, remap.size);
      local.push(remap.get(v));
    }
    const scratch = new Document().setLogger(QUIET);
    const part = scratch.createPrimitive();
    for (const s of semantics) {
      const a = src[s];
      const size = a.getElementSize();
      const arr = new Float32Array(remap.size * size);
      const e = new Array(size);
      for (const [from, to] of remap) { a.getElement(from, e); arr.set(e, to * size); }
      part.setAttribute(s, scratch.createAccessor().setType(a.getType()).setArray(arr));
    }
    part.setIndices(scratch.createAccessor().setArray(new Uint32Array(local)));

    const want = Math.max(COMPONENT_FLOOR / (local.length / 3), ratio);
    if (want < 1) simplifyPrimitive(part, { simplifier: MeshoptSimplifier, ratio: want, error: 1, lockBorder: false });

    const pPos = part.getAttribute('POSITION');
    for (const s of semantics) {
      const a = part.getAttribute(s);
      const size = a.getElementSize();
      const e = new Array(size);
      for (let i = 0; i < a.getCount(); i++) { a.getElement(i, e); stacks[s].push(...e); }
    }
    const pIdx = part.getIndices();
    for (let i = 0; i < pIdx.getCount(); i++) outIndices.push(pIdx.getScalar(i) + base);
    base += pPos.getCount();
  }

  for (const s of semantics) {
    prim.setAttribute(s, hostDoc.createAccessor()
      .setType(src[s].getType())
      .setArray(Float32Array.from(stacks[s])));
  }
  prim.setIndices(hostDoc.createAccessor().setArray(new Uint32Array(outIndices)));
  return parts.length;
}

/**
 * Decimate a throwaway copy to `ratio` and measure what it cost. The copy is
 * real — Primitive.clone() shares its accessors, so simplifying a clone would
 * decimate the original underneath it.
 *
 * meshopt's own `error` parameter is left wide open here, so the RATIO is the
 * only control. Its error metric is quadric, and quadric error does not price
 * the thing these props actually lose: Plant7 is 23 separate closed strands and
 * Plant6 is 11, and deleting one whole thin strand is nearly free by that
 * measure while being the most visible thing that can happen to a plant. Asking
 * for error 0.01 and believing it gave Plant6 at 344 triangles — eleven strands
 * in 344 triangles — and the first version of this tool reported that as a
 * 0.27% change, because it was comparing bounding boxes.
 */
function probe(hostDoc, prim, ratio, samples) {
  const scratch = new Document().setLogger(QUIET);
  const copy = copyToDocument(scratch, hostDoc, [prim]).get(prim);
  const parts = simplifyComponents(scratch, copy, ratio);
  return { ratio, tris: triCount(copy), parts, dev: deviation(samples, copy) };
}

/**
 * The fewest triangles whose surface stays within `budget` model units of the
 * original — found by bisecting the ratio and MEASURING each step, because the
 * simplifier's own estimate is the thing that cannot be trusted here.
 *
 * Bisection on ratio is sound because deviation falls monotonically as the
 * ratio rises: more triangles is never a worse approximation. The search runs
 * on a reduced sample count and the winner is re-measured at full precision by
 * the caller, so a lucky sample set cannot promote a bad ratio.
 */
function fitToBudget(hostDoc, prim, budget, samples, floorRatio, steps = 8) {
  let lo = Math.min(1, floorRatio);          // known-cheap, deviation unknown
  let hi = 1;                                // known-good, deviation 0
  let best = probe(hostDoc, prim, lo, samples);
  if (best.dev.max <= budget) return best;   // the floor already clears it
  best = probe(hostDoc, prim, hi, samples);
  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2;
    const r = probe(hostDoc, prim, mid, samples);
    if (r.dev.max <= budget) { best = r; hi = mid; } else { lo = mid; }
  }
  return best;
}

const results = [];
for (const p of props) {
  const out = new Document().setLogger(QUIET);
  const map = copyToDocument(out, doc, [p.rep.mesh]);
  const mesh = map.get(p.rep.mesh);
  const prim = mesh.listPrimitives()[0];
  const notes = [];

  out.createScene('scene').addChild(out.createNode(p.id).setMesh(mesh));
  mesh.setName(p.id);

  // 1. bake rotation + scale, drop everything the pack's node chain adds
  transformPrimitive(prim, p.rep.M);

  // 2. seat: centred on x/z, base on y=0
  {
    const b = bboxOf(prim);
    const dx = -(b[0] + b[3]) / 2;
    const dy = -b[1];
    const dz = -(b[2] + b[5]) / 2;
    const pos = prim.getAttribute('POSITION');
    const e = [0, 0, 0];
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, e);
      pos.setElement(i, [e[0] + dx, e[1] + dy, e[2] + dz]);
    }
  }

  const preBox = bboxOf(prim);
  const preTris = triCount(prim);
  const longest = Math.max(preBox[3] - preBox[0], preBox[4] - preBox[1], preBox[5] - preBox[2]);

  // 3. material, then texture — in that order, because the crop reads the map
  //    the repair just promoted into the base-colour slot.
  const mat = prim.getMaterial();
  let vramBefore = 0; let vramAfter = 0;
  if (mat) {
    await repairMaterial(mat, notes);
    const tex = mat.getBaseColorTexture();
    if (tex) {
      const [w0, h0] = tex.getSize();
      vramBefore = vramOf(w0, h0);
      const crop = await cropTexture(prim, tex, notes);
      vramAfter = crop ? vramOf(crop.after[0], crop.after[1]) : vramBefore;
      if (crop && crop.after[0] !== crop.before[0]) {
        notes.push(`texture ${crop.before.join('x')} -> ${crop.after.join('x')}`);
      }
    }
  }

  // 4. weld, then decimate to the error budget
  const preWeld = prim.getAttribute('POSITION').getCount();
  const welded = weldByPosition(prim, WELD_EPS);
  const seams = preWeld - welded;
  if (seams) notes.push(`welded ${preWeld} -> ${welded} vertices (${seams} seam duplicates gltf-transform's weld() leaves in place)`);
  const ratio = Math.max(RATIO, Math.min(1, FLOOR / preTris));

  // The cloud the deviation is measured against is taken BEFORE the simplifier
  // runs and after the weld, so it is the surface as modelled.
  const samples = sampleVerts(prim);
  const coarse = samples.filter((_, i) => i % 3 === 0);   // for the search

  // Every column of the sweep is a real fit, not an extrapolation from this
  // one — the curve is the argument for whichever budget ends up chosen.
  const sweeps = sweep
    ? SWEEP_BUDGETS.map((b) => ({ budget: b, ...fitToBudget(out, prim, b * longest, coarse, ratio) }))
    : null;

  const fit = fitToBudget(out, prim, ERROR * longest, coarse, ratio);
  const parts = simplifyComponents(out, prim, fit.ratio);
  recomputeNormals(prim);

  const postTris = triCount(prim);
  // Re-measured at full sample density on the primitive that is actually
  // written, so the number in the report is not the search's own estimate.
  const dev = deviation(samples, prim);

  await out.transform(dedup(), prune());
  const bytes = await io.writeBinary(out);

  results.push({
    ...p, preTris, postTris, welded, longest, dev, parts, preBox, bytes: bytes.byteLength,
    vramBefore, vramAfter, notes, sweeps, buffer: bytes,
  });
}

// --- report -----------------------------------------------------------------

console.log('\n--- decimation (error budget '
  + `${(ERROR * 100).toFixed(1)}% of each prop's longest axis, floor ${FLOOR} tris) ---\n`);
// `worst` is the one-sided Hausdorff maximum and `typical` the 99th
// percentile, both as a percentage of the prop's own longest axis. The pair
// matters: a deleted strand moves the maximum and leaves the percentile alone,
// which is exactly the failure a single averaged number hides.
console.log('  id                 tris      ->     tris   typical    worst     file      VRAM');
let totBytes = 0; let vramB = 0; let vramA = 0;
for (const r of results) {
  totBytes += r.bytes;
  vramB += r.vramBefore; vramA += r.vramAfter;
  const typ = ((r.dev.p99 / r.longest) * 100).toFixed(2);
  const worst = ((r.dev.max / r.longest) * 100).toFixed(2);
  console.log(`  ${r.id.padEnd(15)} ${String(r.preTris).padStart(8)}  ->  ${String(r.postTris).padStart(7)}   `
    + `${typ.padStart(5)}%   ${worst.padStart(6)}%  ${(r.bytes / 1024).toFixed(0).padStart(5)}KB   `
    + `${(r.vramBefore / 1024 / 1024).toFixed(2)} -> ${(r.vramAfter / 1024 / 1024).toFixed(2)}MB`);
}

if (sweep) {
  console.log('\n--- triangles needed to hold each deviation budget (measured, not estimated) ---\n');
  console.log('  id             ' + SWEEP_BUDGETS.map((e) => `${(e * 100).toFixed(1)}%`.padStart(12)).join(''));
  for (const r of results) {
    console.log(`  ${r.id.padEnd(14)}` + r.sweeps.map((s) => String(s.tris).padStart(12)).join(''));
  }
}

console.log('\n  notes:');
for (const r of results) if (r.notes.length) console.log(`    ${r.id.padEnd(15)} ${r.notes.join('; ')}`);

const sumPost = results.reduce((s, r) => s + r.postTris, 0);
console.log(`\n  ${srcTris.toLocaleString()} triangles in one scene  ->  ${sumPost.toLocaleString()} across ${results.length} reusable props`);
console.log(`  ${(srcBytes / 1024 / 1024).toFixed(1)}MB  ->  ${(totBytes / 1024 / 1024).toFixed(2)}MB on disk`);
console.log(`  ${(vramB / 1024 / 1024).toFixed(1)}MB  ->  ${(vramA / 1024 / 1024).toFixed(2)}MB of texture VRAM if every prop is in play at once`);
console.log(`  for reference: grass.glb is 452 triangles, and the whole 55-model roster is 428,649.`);

// --- write ------------------------------------------------------------------

const dir = write ? OUTDIR : PREVIEW;
fs.mkdirSync(dir, { recursive: true });
for (const r of results) fs.writeFileSync(path.join(dir, `${r.id}.glb`), r.buffer);

if (write) {
  // --- the measured table the game reads ------------------------------------
  //
  // Written rather than hand-copied because every number in it is a
  // measurement, and a hand-copied measurement is a number that was true once.
  // `fit` in particular: assets.js normalises a model's LONGEST axis to it, so
  // giving each prop its own measured length as its fit is what preserves the
  // pack's relative sizes — a kelp frond really is thirteen times a leaf, and
  // one shared fit would flatten the whole bed to one height.
  const bySpecies = new Map();
  for (const r of results) {
    const species = r.id.replace(/_[b-z]$/, '');
    if (!bySpecies.has(species)) bySpecies.set(species, []);
    bySpecies.get(species).push(r);
  }
  const lines = [];
  for (const [species, list] of [...bySpecies].sort()) {
    list.sort((a, b) => b.longest - a.longest);
    lines.push(`  ${species}: [`);
    for (const r of list) {
      lines.push(`    { id: '${r.id}', model: '/models/seabed/${r.id}.glb', `
        + `fit: ${r.longest.toFixed(3)}, tris: ${r.postTris}, `
        + `size: [${[0, 1, 2].map((k) => (r.preBox[k + 3] - r.preBox[k]).toFixed(3)).join(', ')}] },`);
    }
    lines.push('  ],');
  }
  const module = `// Seabed props cut from sea_bed.glb — GENERATED, do not hand-edit.
//
//   npm run seabed          # measure and preview
//   npm run seabed -- --write
//
// One key per species, holding its variants largest-first. Every number is
// measured by tools/split-seabed.mjs, which is also where the species names
// come from (the pack's own names are a modeller's working notes: "Plant1" is
// three different plants and "Plan3" is a typo).
//
//   fit    the prop's real long axis in the pack's units. Used AS the assets.js
//          fit, which is what keeps the bed's relative sizes — see the note in
//          split-seabed.mjs where this file is written.
//   size   full extents, Y-up, base at y=0. The plants grow along +Y.
//   tris   after decimation, held to ${(ERROR * 100).toFixed(1)}% of each prop's own long axis.

export const SEABED_PROPS = {
${lines.join('\n')}
};

/** Every variant, flattened — the order assets.js registers them in. */
export const SEABED_VARIANTS = Object.values(SEABED_PROPS).flat();
`;
  const modPath = path.join(ROOT, 'path/src/seabedProps.js');
  fs.writeFileSync(modPath, module);

  console.log(`\nWrote ${results.length} files to ${path.relative(ROOT, OUTDIR)}/`);
  console.log(`Wrote ${path.relative(ROOT, modPath)} — ${bySpecies.size} species, `
    + `${results.length} variants, ${results.reduce((s, r) => s + r.postTris, 0).toLocaleString()} triangles.\n`);
} else {
  console.log(`\nNothing written to public/. Previews in ${path.relative(ROOT, PREVIEW)}/ (gitignored, outside the build).`);
  console.log('Look at them, then re-run with --write.\n');
}
