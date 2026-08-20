#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Turns the yacht's business guest into something a background prop can cost.
//
//   node tools/optimize-guest.mjs            # measure, write nothing
//   node tools/optimize-guest.mjs --write    # replace public/models/businessguest.glb
//   node tools/optimize-guest.mjs --tile=256 # bigger atlas tiles
//   node tools/optimize-guest.mjs --ratio=0.3 # keep more triangles
//
// businessguest.glb is an untouched Avaturn avatar export, and it arrived with
// an avatar's budget: 13 materials, 27 texture maps, 29,552 triangles. The
// texture audit prices it at 81MB of VRAM — the second heaviest model in the
// game, behind only the anglerfish BOSS — for a man who is 15 pixels tall on
// the yacht's deck (54 at 4K full screen).
//
// It is worth being precise about why "we already compressed it" did not help.
// The 27 maps are 1.34MB on disk as WebP, which is excellent compression. WebP
// is a FILE format: the GPU cannot sample it, so every map is decoded to raw
// RGBA8 on upload and the driver builds a mip chain on top. VRAM is
// `w x h x 4 x 4/3` no matter what the file cost, so a 1024² map is 5.6MB held
// whether it arrived as 70KB or 4MB. Disk and VRAM are different problems and
// only one of them was ever solved here.
//
// WHAT THIS DOES
//
//   1. DROPS every normal, metallicRoughness and occlusion map — 15 of the 27.
//      None of them can resolve at 15px: a normal map perturbs shading at a
//      scale finer than this model's entire silhouette. The mr maps are not
//      simply deleted, they are AVERAGED first and written back as the
//      material's metallic/roughness FACTORS, because every material in this
//      file ships factors of 1.0/1.0 and leans on the map for the real values.
//      Dropping the map without that turns thirteen materials into mirrors.
//   2. ATLASES the 13 base-colour maps into one 4x4 grid, and remaps each
//      primitive's UVs into its tile.
//   3. MERGES the primitives by alpha mode, which the shared atlas makes
//      possible: 13 draw calls per guest become 3 (opaque / masked / blended).
//      The yacht fields more than one of these, and a cloned visual gets its
//      own material, so the count multiplies by the size of the party.
//   4. DROPS TANGENT (only a normal map reads it) and TEXCOORD_1..4 (nothing
//      reads them at all — the file carries up to five UV sets per primitive).
//
// WHY THE ATLAS IS SAFE AT LOW MIPS, which is the trap this kind of tool
// usually falls into: an atlas bleeds between tiles as the mip chain shrinks,
// and a model rendered at 15px is sampling deep mips — exactly where bleeding
// would tint the whole man. It does not happen here because the grid is
// POWER-OF-TWO tiles on a POWER-OF-TWO grid. Box-filtered mip generation
// halves the atlas each level, and a tile boundary that starts on an even
// texel stays on an even texel, so the filter never straddles two tiles until
// a tile is down to a single texel. On top of that the remapped UVs are inset
// by half a texel, which keeps the BILINEAR kernel inside its own tile at the
// edges too. Both are checked below rather than asserted.
//
// The original goes to .model-orig/ — outside public/, because vite copies
// that folder into the build wholesale and a backup left beside the model
// would ship to every player. Nothing here can regenerate a source texture.
// ---------------------------------------------------------------------------

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, weld, simplify } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = path.join(ROOT, 'public/models/businessguest.glb');
const BACKUP = path.join(ROOT, '.model-orig');

const argv = process.argv.slice(2);
const write = argv.includes('--write');
const flag = (name, dflt) => {
  const a = argv.find((s) => s.startsWith(`--${name}=`));
  return a ? Number(a.split('=')[1]) : dflt;
};

// 128 per tile against a man who is 15px tall is already eight times more
// texel than he can show. It is the generous end on purpose — the saving here
// is three orders of magnitude, so there is nothing to buy by trimming it
// further and a close-up on the deck to lose.
const TILE = flag('tile', 128);
const GRID = 4;                       // 4x4 = 16 slots for 13 materials
const ATLAS = TILE * GRID;

// 0.20 puts him at ~8,800 triangles, just under the ballroom guest standing
// next to him on the same deck at the same `fit` — which is the only budget
// worth aiming at, because it is the one this exact shot already proves is
// enough. Measured drift at this ratio is 0.13% of his height, or about two
// hundredths of a pixel at the size he is drawn.
const RATIO = flag('ratio', 0.20);
// Relative to the model's extents; the simplifier stops rather than exceed it,
// so a ratio it cannot reach cleanly under-delivers instead of mangling him.
const ERROR = flag('error', 0.01);

const pot = (n) => (n & (n - 1)) === 0;
if (!pot(TILE)) { console.error(`--tile must be a power of two, got ${TILE}`); process.exit(1); }

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

// THE SOURCE IS THE BACKUP WHEN THERE IS ONE, and that is not a convenience.
// This tool is not idempotent: run it on its own output and you atlas an atlas
// — thirteen tiles squeezed into one tile of a new grid — and decimate an
// already-decimated mesh. Reading the pristine copy makes --ratio and --tile
// knobs you can turn repeatedly, which is the only way to choose a value.
const PRISTINE = path.join(BACKUP, 'businessguest.glb');
const SOURCE = fs.existsSync(PRISTINE) ? PRISTINE : MODEL;
const doc = await io.read(SOURCE);
const root = doc.getRoot();

// And if there is NO backup, the shipped model may already have been converted
// — in which case there is no way back and this must not run. One texture and
// three materials is that signature; the source has 27 and 13.
if (SOURCE === MODEL && root.listTextures().length <= 3) {
  console.error('\npublic/models/businessguest.glb looks already converted and .model-orig/ is gone.');
  console.error('Running again would atlas an atlas. Restore the original from git history first:');
  console.error('  git show <sha>:public/models/businessguest.glb > .model-orig/businessguest.glb\n');
  process.exit(1);
}
console.log(`\nsource: ${path.relative(ROOT, SOURCE)}`);

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)}MB`;
// RGBA8 plus the mip chain, which is the +1/3 — the same arithmetic
// tools/texture-audit.mjs prices the roster with.
const vramOf = (w, h) => (w * h * 4 * 4) / 3;

/** Triangles, vertices and the bounding box, which is the silhouette. */
function census() {
  let tris = 0; let verts = 0;
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const m of root.listMeshes()) {
    for (const p of m.listPrimitives()) {
      const pos = p.getAttribute('POSITION');
      const idx = p.getIndices();
      tris += idx ? idx.getCount() / 3 : pos.getCount() / 3;
      verts += pos.getCount();
      const e = [0, 0, 0];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, e);
        for (let k = 0; k < 3; k++) {
          if (e[k] < b[k]) b[k] = e[k];
          if (e[k] > b[k + 3]) b[k + 3] = e[k];
        }
      }
    }
  }
  return { tris: Math.round(tris), verts, box: b };
}

// Measured on the file as it arrived — the decimation below runs at the end of
// the pipeline, and this is the only point where the original geometry exists.
const preDecimate = census();


// --- what the textures cost -------------------------------------------------
let vramBefore = 0;
let diskBefore = 0;
for (const t of root.listTextures()) {
  const [w, h] = t.getSize();
  vramBefore += vramOf(w, h);
  diskBefore += t.getImage()?.byteLength ?? 0;
}
const prims = [];
for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) prims.push({ mesh, prim: p });
console.log(`\nbusinessguest.glb — ${root.listMaterials().length} materials, ${root.listTextures().length} maps, ${prims.length} primitives`);
console.log(`  ${mb(vramBefore)} VRAM, ${mb(diskBefore)} of texture on disk\n`);

// --- one tile per material --------------------------------------------------
//
// Materials, not textures: two materials sharing a map still need their own
// tile, because the base-colour FACTOR is baked in here (see below) and they
// may not share that.
const materials = root.listMaterials();
if (materials.length > GRID * GRID) {
  console.error(`${materials.length} materials will not fit a ${GRID}x${GRID} atlas`);
  process.exit(1);
}

const slotOf = new Map();             // Material -> {col,row}
materials.forEach((m, i) => slotOf.set(m, { col: i % GRID, row: (i / GRID) | 0 }));

/** A material's base colour as a TILE x TILE RGBA buffer, factor baked in. */
async function tileFor(mat) {
  const tex = mat.getBaseColorTexture();
  const factor = mat.getBaseColorFactor() ?? [1, 1, 1, 1];
  let img;
  if (tex) {
    img = sharp(Buffer.from(tex.getImage()))
      .resize(TILE, TILE, { fit: 'fill' })
      .ensureAlpha();
  } else {
    // No map at all — the glasses lens is a factor and nothing else. A flat
    // tile keeps it mergeable with the rest of the blended group.
    img = sharp({
      create: {
        width: TILE, height: TILE, channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    });
  }
  const { data } = await img.raw().toBuffer({ resolveWithObject: true });
  // The FACTOR multiplies the map in the shader. Merging materials throws the
  // factors away, so each one is baked into its own tile first — including
  // alpha, which is the whole of the glasses lens (0.1).
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.round(data[i] * factor[0]);
    data[i + 1] = Math.round(data[i + 1] * factor[1]);
    data[i + 2] = Math.round(data[i + 2] * factor[2]);
    data[i + 3] = Math.round(data[i + 3] * factor[3]);
  }
  return data;
}

/** Mean metallic (B) and roughness (G) of an mr map — the factors that replace it. */
async function mrFactors(mat) {
  const tex = mat.getMetallicRoughnessTexture();
  if (!tex) return null;
  const { data, info } = await sharp(Buffer.from(tex.getImage()))
    .resize(32, 32, { fit: 'fill' }).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  let g = 0; let b = 0;
  const n = info.width * info.height;
  for (let i = 0; i < data.length; i += 4) { g += data[i + 1]; b += data[i + 2]; }
  return { rough: g / n / 255, metal: b / n / 255 };
}

const atlasBuf = Buffer.alloc(ATLAS * ATLAS * 4);
const report = [];
for (const mat of materials) {
  const { col, row } = slotOf.get(mat);
  const tile = await tileFor(mat);
  for (let y = 0; y < TILE; y++) {
    const src = y * TILE * 4;
    const dst = ((row * TILE + y) * ATLAS + col * TILE) * 4;
    tile.copy(atlasBuf, dst, src, src + TILE * 4);
  }

  const mr = await mrFactors(mat);
  const dropped = [];
  if (mat.getNormalTexture()) { mat.setNormalTexture(null); dropped.push('normal'); }
  if (mat.getOcclusionTexture()) { mat.setOcclusionTexture(null); dropped.push('ao'); }
  if (mr) {
    mat.setMetallicRoughnessTexture(null);
    mat.setMetallicFactor(mr.metal);
    mat.setRoughnessFactor(mr.rough);
    dropped.push('metalRough');
  }
  // Baked into the tile, so the factor itself becomes neutral.
  mat.setBaseColorFactor([1, 1, 1, 1]);
  report.push({
    name: mat.getName() || '(unnamed)',
    slot: `${col},${row}`,
    alpha: mat.getAlphaMode(),
    metal: mr ? mr.metal.toFixed(2) : String(mat.getMetallicFactor().toFixed(2)),
    rough: mr ? mr.rough.toFixed(2) : String(mat.getRoughnessFactor().toFixed(2)),
    dropped: dropped.join('+') || '—',
  });
}

const atlasWebp = await sharp(atlasBuf, { raw: { width: ATLAS, height: ATLAS, channels: 4 } })
  .webp({ quality: 90, alphaQuality: 100 })
  .toBuffer();

console.log(`atlas: ${ATLAS}x${ATLAS}, ${GRID}x${GRID} tiles of ${TILE}px — ${mb(atlasWebp.byteLength)} on disk, ${mb(vramOf(ATLAS, ATLAS))} VRAM\n`);
console.log('  material                     slot   alpha    metal  rough   maps dropped');
for (const r of report) {
  console.log(`  ${r.name.padEnd(28)} ${r.slot.padEnd(6)} ${r.alpha.padEnd(8)} ${r.metal.padStart(5)}  ${r.rough.padStart(5)}   ${r.dropped}`);
}

// --- UVs into their tile ----------------------------------------------------
//
// Inset by half a texel of the ATLAS, so the bilinear kernel at a tile's edge
// still lands on that tile's own texels. Anything outside [0,1] is clamped
// first: a UV of 1.005 would otherwise remap into the neighbouring tile, which
// is the one way an atlas goes visibly wrong rather than subtly wrong.
const INSET = 0.5 / ATLAS;
let clamped = 0;
let uvTotal = 0;

const DEAD_SEMANTICS = ['TANGENT', 'TEXCOORD_1', 'TEXCOORD_2', 'TEXCOORD_3', 'TEXCOORD_4'];
let deadDropped = 0;

for (const { prim } of prims) {
  const mat = prim.getMaterial();
  const { col, row } = slotOf.get(mat);
  const uv = prim.getAttribute('TEXCOORD_0');
  if (uv) {
    const a = [0, 0];
    for (let i = 0; i < uv.getCount(); i++) {
      uv.getElement(i, a);
      let u = a[0]; let v = a[1];
      if (u < 0 || u > 1 || v < 0 || v > 1) clamped++;
      u = Math.min(1, Math.max(0, u));
      v = Math.min(1, Math.max(0, v));
      // Into the tile, then in off the edge by half an atlas texel.
      const lo = INSET; const hi = 1 - 2 * INSET;
      uv.setElement(i, [
        (col + lo + u * hi) / GRID,
        (row + lo + v * hi) / GRID,
      ]);
      uvTotal++;
    }
  }
  for (const s of DEAD_SEMANTICS) {
    if (prim.getAttribute(s)) { prim.setAttribute(s, null); deadDropped++; }
  }
}
console.log(`\n  ${uvTotal} UVs remapped, ${clamped} clamped back inside their tile`);
console.log(`  ${deadDropped} dead vertex attributes dropped (TANGENT + 4 spare UV sets)`);

// --- one texture, one material per alpha mode -------------------------------
//
// The atlas replaces every base-colour map, so materials that agree on alpha
// mode now differ in nothing the renderer can see — which is what makes the
// geometry mergeable below.
const atlasImage = doc.createTexture('guestAtlas')
  .setImage(atlasWebp)
  .setMimeType('image/webp');

const byMode = new Map();
for (const mat of materials) {
  const mode = mat.getAlphaMode();
  if (!byMode.has(mode)) {
    const merged = doc.createMaterial(`guest_${mode.toLowerCase()}`)
      .setBaseColorTexture(atlasImage)
      .setAlphaMode(mode)
      .setMetallicFactor(mat.getMetallicFactor())
      .setRoughnessFactor(mat.getRoughnessFactor())
      // Every mesh in this file is double-sided except the head and the hair
      // cap, and both are closed shells whose backfaces are hidden by their own
      // front faces. One flag for the group costs a little fill and no pixels.
      .setDoubleSided(true);
    if (mode === 'MASK') merged.setAlphaCutoff(mat.getAlphaCutoff());
    byMode.set(mode, merged);
  }
}
for (const { prim } of prims) prim.setMaterial(byMode.get(prim.getMaterial().getAlphaMode()));

// --- merge the geometry -----------------------------------------------------
//
// By hand rather than through join(): these are SKINNED primitives on separate
// nodes, and a mesh join has to decide what to do with the node transforms. It
// does not arise here — glTF says a skinned mesh ignores its node's transform
// entirely, the vertices being placed by the skeleton — so concatenating the
// attributes is the whole operation. Everything left shares one skin.
const skins = root.listSkins();
if (skins.length !== 1) {
  console.error(`expected one skin, found ${skins.length} — the merge assumes every primitive is on it`);
  process.exit(1);
}

const groups = new Map();             // Material -> [prim]
for (const { prim } of prims) {
  const m = prim.getMaterial();
  if (!groups.has(m)) groups.set(m, []);
  groups.get(m).push(prim);
}

const KEEP = ['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0'];
const mergedMesh = doc.createMesh('businessGuest');

for (const [mat, group] of groups) {
  // Every primitive in a group must carry the same attributes or the merged
  // buffer would be ragged — a hole nothing reports, since the missing values
  // read as zero and a zero WEIGHTS_0 pins those vertices to the origin.
  const semantics = KEEP.filter((s) => group[0].getAttribute(s));
  for (const p of group) {
    for (const s of semantics) {
      if (!p.getAttribute(s)) {
        console.error(`${mat.getName()}: a primitive is missing ${s} — refusing to merge a ragged group`);
        process.exit(1);
      }
    }
  }

  const out = doc.createPrimitive().setMaterial(mat);
  let base = 0;
  const indices = [];
  const stacks = new Map(semantics.map((s) => [s, []]));

  for (const p of group) {
    const count = p.getAttribute('POSITION').getCount();
    for (const s of semantics) {
      const attr = p.getAttribute(s);
      const el = new Array(attr.getElementSize());
      const into = stacks.get(s);
      for (let i = 0; i < count; i++) { attr.getElement(i, el); into.push(...el); }
    }
    const idx = p.getIndices();
    if (idx) for (let i = 0; i < idx.getCount(); i++) indices.push(idx.getScalar(i) + base);
    else for (let i = 0; i < count; i++) indices.push(i + base);
    base += count;
  }

  for (const s of semantics) {
    const proto = group[0].getAttribute(s);
    const Ctor = proto.getArray().constructor;
    const acc = doc.createAccessor()
      .setType(proto.getType())
      .setArray(Ctor.from(stacks.get(s)))
      .setNormalized(proto.getNormalized());
    out.setAttribute(s, acc);
  }
  out.setIndices(doc.createAccessor().setArray(new Uint32Array(indices)));
  mergedMesh.addPrimitive(out);
}

// One node carrying the merged mesh, in place of thirteen. It keeps the skin
// and goes where the old skinned nodes were — under the same parent, so the
// scene graph the game walks is unchanged apart from being shorter.
const oldNodes = root.listNodes().filter((n) => n.getMesh());
const parent = oldNodes[0].getParentNode() ?? null;
const holder = doc.createNode('businessGuest').setMesh(mergedMesh).setSkin(skins[0]);
if (parent) parent.addChild(holder);
else root.listScenes()[0].addChild(holder);
for (const n of oldNodes) { n.setMesh(null); n.setSkin(null); }

// PRUNE LAST, and only now. It removes accessors nothing references, and the
// atlas has to be attached before it runs or the UVs it feeds go with it.
await doc.transform(dedup(), prune());

// --- decimate ---------------------------------------------------------------
//
// 29,552 triangles for a man 15 pixels tall is two thousand triangles per pixel
// he covers, and it made him the sixth heaviest model in a 53-model roster —
// above the megalodon. The budget worth aiming at is not a round number, it is
// the BALLROOM guest: 9,128 triangles, standing on the same deck at the same
// `fit`, which makes it the one figure this exact shot has already proved is
// enough.
//
// WELD FIRST. A simplifier cannot collapse an edge across a seam it cannot see,
// and this file splits vertices at every UV island and material border — 23,377
// vertices for 29,552 triangles is most of a vertex per triangle. Unwelded, the
// ratio silently under-delivers, which is the same trap tools/optimize-crab.mjs
// documents.
//
// The simplifier is skin-aware: it carries JOINTS_0/WEIGHTS_0 onto the vertices
// that survive, so the fingers keep being driven by the finger bones. That is
// asserted afterwards rather than trusted — a vertex that lost its weights
// reads as four zeros and pins to the origin, which draws a spike through the
// deck and throws no error.
await MeshoptSimplifier.ready;
await doc.transform(
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio: RATIO, error: ERROR }),
);
const postDecimate = census();

const height = (c) => c.box[4] - c.box[1];
const drift = Math.max(...postDecimate.box.map((v, i) => Math.abs(v - preDecimate.box[i])));
// He is 15 logged-window pixels tall (54 at 4K full screen) — the numbers
// tools/texture-audit.mjs sizes maps from. Reporting the drift in the units the
// decision is made in beats reporting it in model units nobody can picture.
const driftPx = (drift / height(preDecimate)) * 15;

console.log(`\ndecimate: ratio ${RATIO}, error ${ERROR}`);
console.log(`  ${preDecimate.tris} -> ${postDecimate.tris} triangles`
  + `  ·  ${preDecimate.verts} -> ${postDecimate.verts} vertices`);
console.log(`  silhouette moved ${drift.toFixed(5)} on a ${height(preDecimate).toFixed(4)} body`
  + ` — ${((drift / height(preDecimate)) * 100).toFixed(2)}%, about ${driftPx.toFixed(3)}px at the size he is drawn`);

let lostWeights = 0;
for (const m of root.listMeshes()) {
  for (const p of m.listPrimitives()) {
    const w = p.getAttribute('WEIGHTS_0');
    if (!w) continue;
    const e = [0, 0, 0, 0];
    for (let i = 0; i < w.getCount(); i++) {
      w.getElement(i, e);
      if (e[0] + e[1] + e[2] + e[3] < 0.001) lostWeights++;
    }
  }
}
if (lostWeights) {
  console.error(`  ${lostWeights} vertices came out of the simplifier with no skin weights.`);
  console.error('  They would pin to the origin. Raise --ratio and re-run.');
  process.exit(1);
}
console.log(`  every one of ${postDecimate.verts} surviving vertices kept its skin weights`);

const outBuf = await io.writeBinary(doc);

// --- what it costs after ----------------------------------------------------
let vramAfter = 0;
for (const t of root.listTextures()) { const [w, h] = t.getSize(); vramAfter += vramOf(w, h); }
const drawsBefore = prims.length;
const drawsAfter = mergedMesh.listPrimitives().length;

console.log(`\n  ${root.listMaterials().length} material(s), ${root.listTextures().length} map(s), ${drawsAfter} primitive(s)`);
console.log(`  VRAM   ${mb(vramBefore).padStart(8)} -> ${mb(vramAfter)}   (${(vramBefore / vramAfter).toFixed(0)}x less)`);
console.log(`  draws  ${String(drawsBefore).padStart(8)} -> ${drawsAfter}   per guest, and the yacht fields more than one`);
console.log(`  tris   ${String(preDecimate.tris).padStart(8)} -> ${postDecimate.tris}`);
console.log(`  file   ${mb(fs.statSync(SOURCE).size).padStart(8)} -> ${mb(outBuf.byteLength)}`);

if (!write) {
  // The preview goes to .model-orig/ rather than next to the model, for the
  // same reason the backup does: public/ is copied into the build wholesale,
  // so a spare glb left beside the original ships to every player and nothing
  // in testing would ever ask for it.
  fs.mkdirSync(BACKUP, { recursive: true });
  const preview = path.join(BACKUP, 'businessguest.optimized.glb');
  fs.writeFileSync(preview, outBuf);
  console.log(`\nModel not replaced. Preview written to ${path.relative(ROOT, preview)}`);
  console.log('Check it (npm run test:guest), then re-run with --write.\n');
  process.exit(0);
}

fs.mkdirSync(BACKUP, { recursive: true });
const kept = path.join(BACKUP, 'businessguest.glb');
// Only if there isn't one already: a second --write would otherwise back up
// the ALREADY-CONVERTED model over the original and quietly destroy the only
// copy of the source textures.
if (!fs.existsSync(kept)) fs.copyFileSync(MODEL, kept);
fs.writeFileSync(MODEL, outBuf);
// The preview is what tools/guest-test.mjs reads in preference to the shipped
// model, so leaving it behind would have the test checking a stale file that
// happens to agree.
fs.rmSync(path.join(BACKUP, 'businessguest.optimized.glb'), { force: true });
console.log(`\nWrote ${path.relative(ROOT, MODEL)}. Original kept in .model-orig/ (gitignored, outside the build).`);
console.log('Look at him on the yacht deck, then: rm -r .model-orig\n');
