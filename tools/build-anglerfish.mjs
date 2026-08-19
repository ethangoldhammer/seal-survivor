// ---------------------------------------------------------------------------
// Condenses the 8-file Creepy_Anglerfish FBX pack into one anglerfish.glb.
//
//   node tools/build-anglerfish.mjs [--out=public/models/anglerfish.glb]
//                                   [--fps=30] [--no-webp] [--keep-stubs]
//
// WHAT THE PACK IS. Eight .FBX files, 35.6MB, plus 15.6MB of PNG beside them:
//
//     _Atlantic_Footballfish.FBX   1.5MB   mesh + rig, NO clip
//     animations/idle.FBX          5.0MB   mesh + rig + one clip
//     animations/swim1.FBX         4.0MB   "
//     animations/swim2.FBX         4.7MB   "
//     animations/swim_start.FBX    5.0MB   "
//     animations/swim_end.FBX      5.3MB   "
//     animations/bite.FBX          4.9MB   "
//     animations/trap.FBX          6.5MB   "
//
// Every animation file is a COMPLETE COPY of the animal — the same 4 skinned
// meshes, the same 19,558 triangles, the same 353 bones, the same 10 material
// slots — carrying one clip each, all of them named "Take 001". The mesh is
// therefore stored eight times and the clips are stored under a name that
// collides seven ways. That is the whole reason the pack is 35MB, and it is
// the entire thing this script removes: ONE copy of the animal, SEVEN clips
// named after the file they came from.
//
// The merge is safe to do by name, and that was checked rather than assumed:
// all eight files are FBX 7400, all eight carry the same 353-bone set, and
// every one of the ~600 tracks in every clip names a node that exists in the
// base file. Nothing is retargeted; nothing is guessed.
//
// THE RIG HAS 136 DOUBLED BONE NAMES, and they are not a corruption. Each is a
// parent with a same-named child sitting at exactly (0,0,0) with no children of
// its own — the shape 3ds Max writes for a bone's terminator. three.js binds
// animation tracks by name through a depth-first search, so an ambiguous track
// resolves to the PARENT, both here and in the original file. The merge keeps
// the hierarchy byte-for-byte as loaded so that resolution cannot change; the
// terminators are dropped only when they are provably inert (no skin weight,
// no children, no track), and the count of what was dropped is printed.
//
// FOUR THINGS COST REAL BYTES, and each is handled separately:
//
//   1. THE CLIPS, which dominate. 605 tracks x ~250 baked frames x position +
//      rotation + scale is ~2MB per clip, 14MB for seven, on a rig that almost
//      exclusively ROTATES — the position and scale tracks are hundreds of
//      copies of one value. `resample` collapses those to two keys. This is
//      lossless: it removes keys that lie on the line the sampler already
//      draws between their neighbours.
//   2. THE 209 GEOMETRY GROUPS on footballfish_body. Seven materials are split
//      across 209 runs, and a run is a draw call — 212 of them for one fish.
//      Triangles are reordered so each material is one contiguous run, taking
//      the whole animal to 7 primitives. Vertex data is untouched; only the
//      order changes.
//   3. THE UNWELDED VERTICES. The FBX ships three vertices per triangle
//      (38,454 for 12,818 tris), so every vertex is stored ~3x. `weld` merges
//      the ones that are genuinely identical across position, normal, uv AND
//      skin binding.
//   4. THE TEXTURES, 15.6MB of 2048^2 PNG for maps that are painted, not line
//      art. Re-encoded to WebP inside the glb through EXT_texture_webp — the
//      same trade tools/webp-textures.mjs makes across the roster, and a
//      format three.js's GLTFLoader has read for years. Pixel dimensions are
//      left alone, so VRAM does not move; this is a download win only.
//
// THE MATERIALS ARE REBUILT, because FBX Phong is not glTF PBR and the loader
// only carries across what the two share. All four maps sit in ONE 2048^2
// atlas on ONE UV set — measured: every group's UVs land inside 0-1 and in its
// own island — so all seven materials get all four maps and keep their FBX
// tint as baseColorFactor:
//
//     diff  -> baseColorTexture      (sRGB; alpha is atlas padding, flattened)
//     gloss -> metallicRoughness.G   (INVERTED — glTF stores roughness, and
//                                     the source is glossiness)
//     emis  -> emissiveTexture       (the esca, and near-black everywhere else)
//     bump  -> normalTexture         (derived; see below)
//
// THE BUMP MAP IS CONVERTED, NOT COPIED. glTF has no height-map slot, so the
// choice is convert it or lose it. It is Sobel-differentiated into a tangent-
// space normal map here. That is an approximation of a channel the source only
// ever had as an approximation, so `--no-bump` drops it instead.
//
// THE THREE DEAD MATERIALS go. "football_fiah Slot #8/#9/#10" are black,
// map-less, and referenced by no group in any mesh — 3ds Max multi-material
// slots that were never assigned. They would arrive in the glb as three real
// materials that nothing draws.
//
// THE PROOF IS AT THE BOTTOM. It is not enough that the file opens: the clips
// have to still move the animal the way the originals did. Every clip is
// re-loaded out of the finished glb, applied to the merged rig, and the SKINNED
// VERTEX POSITIONS are compared against the same clip driving its own original
// .FBX at the same times. Bone names and track counts can match perfectly while
// the animal stands still — so what is measured is where the vertices land.
//
// Source art is never written to: this reads from _C4D and writes only to
// public/models.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';

// dom-stub covers what the LOADERS touch. GLTFExporter goes one further: it
// serialises the binary chunk through a FileReader, which Node has no reason to
// provide. Without it the export dies on the very last line of writeAsync,
// after all the work.
globalThis.FileReader = class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then((b) => { this.result = b; this.onloadend?.(); }); }
};
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import { dedup, prune, weld, resample, quantize } from '@gltf-transform/functions';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
const has = (n) => argv.includes(`--${n}`);

const SRC = flag('src', '/Users/ethangoldhammer/Documents/_C4D/_ASSETS/_Nature/atlantic-footballfish');
const PACK = path.join(SRC, 'source/Creepy_Anglerfish');
const TEX = path.join(SRC, 'textures');
const OUT = path.resolve(ROOT, flag('out', 'public/models/anglerfish.glb'));
const FPS = +flag('fps', 30);
const WEBP = !has('no-webp');
const BUMP = !has('no-bump');
const KEEP_STUBS = has('keep-stubs');
const TINT = has('tint');

// Source file -> the clip name it becomes. The FBX name is the only thing that
// distinguishes these: all seven clips are called "Take 001" inside the files.
const CLIPS = ['idle', 'swim1', 'swim2', 'swim_start', 'swim_end', 'bite', 'trap'];

// Slots that no geometry group in any mesh references. Named rather than
// detected-and-trusted so a re-export that starts USING one fails the audit
// below instead of quietly dropping painted faces.
const DEAD_MATERIALS = ['football_fiah Slot #8', 'football_fiah Slot #9', 'football_fiah Slot #10'];

const MAPS = {
  diff: 'Atlantic_Footballfish_diff.png',
  bump: 'Atlantic_Footballfish_bump.png',
  gloss: 'Atlantic_Footballfish_gloss.png',
  emis: 'Atlantic_Footballfish_emis.png',
};

const fail = (m) => { console.error(`\n  [FAIL] ${m}\n`); process.exit(1); };
const mb = (n) => (n / 1048576).toFixed(2) + 'MB';
const loader = new FBXLoader();
const readFBX = (f) => {
  const b = fs.readFileSync(f);
  return loader.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.length), path.dirname(f) + '/');
};

// ---------------------------------------------------------------------------
// 1. the source, and what it costs today
// ---------------------------------------------------------------------------
const files = [['_Atlantic_Footballfish.FBX', path.join(PACK, '_Atlantic_Footballfish.FBX')],
  ...CLIPS.map((c) => [`${c}.FBX`, path.join(PACK, 'animations', `${c}.FBX`)])];
let srcBytes = 0;
console.log('\nSOURCE PACK');
for (const [name, file] of files) {
  if (!fs.existsSync(file)) fail(`missing ${file}`);
  const n = fs.statSync(file).size; srcBytes += n;
  console.log(`  ${name.padEnd(30)} ${mb(n).padStart(8)}`);
}
let texBytes = 0;
for (const f of Object.values(MAPS)) {
  const p = path.join(TEX, f);
  if (!fs.existsSync(p)) fail(`missing texture ${p}`);
  const n = fs.statSync(p).size; texBytes += n;
  console.log(`  ${f.padEnd(30)} ${mb(n).padStart(8)}`);
}
console.log(`  ${''.padEnd(30)} ${'--------'}\n  ${'TOTAL'.padEnd(30)} ${mb(srcBytes + texBytes).padStart(8)}`);

// ---------------------------------------------------------------------------
// 2. the carrier: one copy of the animal, from the file that has no clip
// ---------------------------------------------------------------------------
const base = readFBX(files[0][1]);
const meshes = [];
base.traverse((o) => { if (o.isMesh) meshes.push(o); });
const baseNames = new Set(); base.traverse((o) => baseNames.add(o.name));
const baseBones = []; base.traverse((o) => { if (o.isBone) baseBones.push(o); });
console.log(`\nCARRIER  ${meshes.length} skinned meshes, ${baseBones.length} bones`);

// ---------------------------------------------------------------------------
// 3. the clips
// ---------------------------------------------------------------------------
console.log('\nCLIPS');
const originals = {};                       // kept for the skinning proof
base.animations = [];
for (const name of CLIPS) {
  const file = path.join(PACK, 'animations', `${name}.FBX`);
  const obj = readFBX(file);
  if (obj.animations.length !== 1) fail(`${name}.FBX has ${obj.animations.length} clips, expected 1`);
  const clip = obj.animations[0];

  // Every track must name a node the carrier actually has. A track that does
  // not resolve is silently ignored by three.js at play time — the clip runs,
  // the bone never moves, and nothing anywhere reports it.
  const missing = [...new Set(clip.tracks.map((t) => t.name.split('.')[0]))].filter((n) => !baseNames.has(n));
  if (missing.length) fail(`${name}: ${missing.length} track targets absent from the carrier rig (${missing.slice(0, 5)})`);

  clip.name = name;
  base.animations.push(clip);
  originals[name] = obj;
  console.log(`  ${name.padEnd(11)} ${clip.duration.toFixed(3)}s  ${String(clip.tracks.length).padStart(3)} tracks  ${new Set(clip.tracks.map((t) => t.name.split('.')[0])).size} nodes  all resolve`);
}

// ---------------------------------------------------------------------------
// 4. dead material slots
// ---------------------------------------------------------------------------
const used = new Set();
for (const m of meshes) for (const g of m.geometry.groups) if (g.count) used.add([].concat(m.material)[g.materialIndex]?.name);
const deadFound = [].concat(...meshes.map((m) => [].concat(m.material))).map((m) => m.name).filter((n, i, a) => a.indexOf(n) === i && !used.has(n));
console.log(`\nMATERIALS  ${used.size} drawn, ${deadFound.length} referenced by no group`);
for (const n of deadFound) {
  if (!DEAD_MATERIALS.includes(n)) fail(`unexpected unused material "${n}" — the export changed; check it before dropping it`);
  console.log(`    dropped "${n}"`);
}
for (const n of DEAD_MATERIALS) if (used.has(n)) fail(`"${n}" is now DRAWN but this script is written to drop it`);

// ---------------------------------------------------------------------------
// 5. one contiguous run per material
//
// Reorders triangles so a mesh split across N groups becomes one group per
// material. The geometry is non-indexed (three vertices per triangle, none
// shared), so a triangle is three consecutive vertices in every attribute and
// the reorder is a permutation of whole triples — no attribute can fall out of
// step with another.
// ---------------------------------------------------------------------------
console.log('\nDRAW CALLS');
let groupsBefore = 0, groupsAfter = 0;
for (const mesh of meshes) {
  const geo = mesh.geometry;
  const mats = [].concat(mesh.material);
  groupsBefore += geo.groups.length;
  if (geo.index) fail(`${mesh.name} is indexed; the triangle reorder assumes the FBX's non-indexed layout`);

  const byMat = new Map();
  for (const g of geo.groups) {
    if (!g.count) continue;
    if (!byMat.has(g.materialIndex)) byMat.set(g.materialIndex, []);
    byMat.get(g.materialIndex).push(g);
  }
  const order = [];                       // source vertex index, in new order
  const groups = [];
  for (const [mi, runs] of [...byMat].sort((a, b) => a[0] - b[0])) {
    const start = order.length;
    for (const r of runs) for (let i = r.start; i < r.start + r.count; i++) order.push(i);
    groups.push({ start, count: order.length - start, materialIndex: mi });
  }
  if (order.length !== geo.attributes.position.count) {
    fail(`${mesh.name}: reorder covers ${order.length} of ${geo.attributes.position.count} vertices`);
  }
  for (const [key, attr] of Object.entries(geo.attributes)) {
    const it = attr.itemSize, Arr = attr.array.constructor;
    const out = new Arr(order.length * it);
    for (let i = 0; i < order.length; i++) {
      const s = order[i] * it, d = i * it;
      for (let c = 0; c < it; c++) out[d + c] = attr.array[s + c];
    }
    geo.setAttribute(key, new THREE.BufferAttribute(out, it, attr.normalized));
  }
  geo.clearGroups();
  // Remap to a dense material array so the dead slots cannot survive as holes.
  const kept = groups.map((g) => mats[g.materialIndex]);
  mesh.material = kept.length === 1 ? kept[0] : kept;
  groups.forEach((g, i) => geo.addGroup(g.start, g.count, kept.length === 1 ? 0 : i));
  groupsAfter += groups.length;
  const runs = [...byMat].reduce((n, [, r]) => n + r.length, 0);
  console.log(`  ${mesh.name.padEnd(22)} ${String(runs).padStart(3)} runs over ${byMat.size} material${byMat.size > 1 ? 's' : ''} -> ${groups.length} primitive${groups.length > 1 ? 's' : ''}`);
}
console.log(`  total draw calls ${groupsBefore} -> ${groupsAfter}`);

// ---------------------------------------------------------------------------
// 5b. the V axis
//
// FBX puts UV (0,0) at the BOTTOM-left of the image; glTF puts it at the
// TOP-left. three.js papers over the difference at load time by setting
// `flipY = true` on FBX textures, so nothing looks wrong in an FBX viewer and
// nothing looks wrong in three — but the flag is a RENDER-TIME correction, not
// a property of the data. Exporting the UVs unchanged and attaching the
// original PNGs writes a file where the two disagree.
//
// It does not fail loudly. It fails by mirroring the atlas vertically, and on
// an animal whose atlas is fish-skin top and bottom, the result is a perfectly
// convincing fish wearing its own texture upside down. What gave it away was
// the emissive map: the esca — the lit bulb on the tip of the lure, and the
// single most recognisable thing about an anglerfish — was landing on the
// underside of the tail. See the assertion at the bottom, which is written
// against exactly that.
//
// The UVs are flipped rather than the images, so the file stays canonical: the
// glb carries glTF-convention UVs and the untouched source artwork, and
// re-encoding a map later from the original PNG cannot reintroduce this.
//
// Do NOT "fix" this by setting flipY on the texture instead. GLTFLoader decodes
// through createImageBitmap, and three cannot apply unpackFlipY to an
// ImageBitmap — the flag is silently ignored, which is a second way this bug
// hides.
for (const mesh of meshes) {
  const uv = mesh.geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  uv.needsUpdate = true;
}
console.log(`\nUV  V axis flipped on ${meshes.length} meshes (FBX bottom-left origin -> glTF top-left)`);

// ---------------------------------------------------------------------------
// 6. the doubled bones, and why they all stay
//
// 136 of the 353 bones are a same-named child of their parent, sitting at
// exactly (0,0,0) with no children — the terminator shape 3ds Max writes. They
// look like free bytes, and they are not, for two independent reasons that were
// both measured rather than reasoned about:
//
//   THEY CARRY SKIN WEIGHT. 293 of 353 bones have vertices bound to them, and
//   the terminators are in that set. Dropping one is not a no-op on the mesh.
//
//   THEIR TRACKS ARE UNADDRESSABLE. A track names a bone by a string, and that
//   string matches BOTH copies. There is no way to tell from the clip which one
//   a key was authored for, so there is no way to drop one copy's tracks
//   without a 50% chance of dropping the pair's only animation.
//
// This block therefore measures and reports; it never removes. It is kept
// because a future re-export could break the tie, and because the numbers are
// the answer to "why is this rig 353 bones for a fish".
// ---------------------------------------------------------------------------
const weighted = new Set();
for (const m of meshes) {
  const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
  for (let i = 0; i < si.count; i++) {
    for (const c of ['X', 'Y', 'Z', 'W']) if (sw[`get${c}`](i) > 0) weighted.add(m.skeleton.bones[si[`get${c}`](i)]);
  }
}
const doubled = baseBones.filter((b) => b.parent?.name === b.name && b.children.length === 0 && b.position.lengthSq() === 0);
const inert = doubled.filter((b) => !weighted.has(b));
console.log(`\nRIG  ${baseBones.length} bones, ${weighted.size} carry skin weight`);
console.log(`  ${doubled.length} are doubled terminators; ${inert.length} of those carry no weight`);
console.log(`  keeping all ${baseBones.length} — a doubled name cannot be told apart by its tracks`);

// ---------------------------------------------------------------------------
// 7. export
//
// Maps are stripped before the exporter sees them: FBXLoader built Texture
// objects with no decoded image behind them (nothing in Node decodes a PNG for
// three.js), so GLTFExporter would write empty images. The real maps are
// attached in step 8, where the encoding is under this script's control.
// ---------------------------------------------------------------------------
const tints = {};
base.traverse((o) => {
  if (!o.material) return;
  for (const m of [].concat(o.material)) {
    tints[m.name] = m.color.toArray();
    for (const k of ['map', 'bumpMap', 'normalMap', 'specularMap', 'emissiveMap', 'roughnessMap', 'lightMap', 'aoMap', 'alphaMap', 'envMap']) m[k] = null;
    m.needsUpdate = true;
  }
});

const glb = await new Promise((res, rej) => new GLTFExporter().parse(
  base, res, rej, { binary: true, animations: base.animations, onlyVisible: false },
));
const raw = Buffer.from(glb);
console.log(`\nEXPORTED  ${mb(raw.length)} before optimisation`);

// ---------------------------------------------------------------------------
// 8. optimise, and wire the real maps
// ---------------------------------------------------------------------------
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.readBinary(new Uint8Array(raw));
const root = doc.getRoot();

const animBytes = () => root.listAnimations().reduce((n, a) => n + a.listSamplers()
  .reduce((s, x) => s + (x.getInput()?.getArray()?.byteLength || 0) + (x.getOutput()?.getArray()?.byteLength || 0), 0), 0);
const vertCount = () => root.listMeshes().reduce((n, m) => n + m.listPrimitives()
  .reduce((s, p) => s + p.getAttribute('POSITION').getCount(), 0), 0);

// GLTFExporter names the NODE but leaves the mesh anonymous, and a mesh split
// across materials comes back out of GLTFLoader as children called mesh_1_0,
// mesh_1_1... — names nothing can resolve. Naming the mesh after its node is
// what makes the parts come back as footballfish_body_0..3.
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (mesh && !mesh.getName()) mesh.setName(node.getName());
}

// THE MAPS ARE ATTACHED BEFORE ANYTHING IS PRUNED OR WELDED, and the order is
// not cosmetic. Both of the passes below read the materials to decide what the
// geometry still needs, so wiring the textures afterwards silently destroys the
// thing they address:
//
//   PRUNE deletes attributes no material uses. With the maps not yet attached,
//   TEXCOORD_0 is unreferenced and prune removes it — leaving a file with no
//   UVs at all. Nothing errors. Every fragment then samples texel (0,0), so the
//   animal renders in one flat colour that still looks like a shaded fish, and
//   the emissive map reads exactly zero because (0,0) of that atlas is black.
//
//   WELD merges vertices that agree on every attribute it can see. Without UVs
//   it happily merges across UV seams, which glues distant parts of the atlas
//   together permanently.

// --- the maps --------------------------------------------------------------
console.log('\nTEXTURES');
const png = (n) => fs.readFileSync(path.join(TEX, MAPS[n]));
const encode = (pipeline) => (WEBP
  ? pipeline.webp({ quality: 90 }).toBuffer().then((data) => ({ data, mime: 'image/webp' }))
  : pipeline.png({ compressionLevel: 9 }).toBuffer().then((data) => ({ data, mime: 'image/png' })));

const made = {};
const addTex = async (slot, srcKey, pipeline, note) => {
  const { data, mime } = await encode(pipeline);
  made[slot] = doc.createTexture(slot).setImage(data).setMimeType(mime);
  const was = fs.statSync(path.join(TEX, MAPS[srcKey])).size;
  console.log(`  ${slot.padEnd(11)} ${MAPS[srcKey].replace('Atlantic_Footballfish_', '').padEnd(10)} ${mb(was).padStart(8)} -> ${mb(data.length).padStart(8)}  ${note}`);
};

// baseColor. The PNG's alpha is the padding around the atlas islands, the
// material is OPAQUE, and nothing samples it — so it is flattened rather than
// shipped as a fourth channel no shader reads.
await addTex('baseColor', 'diff', sharp(png('diff')).removeAlpha(), 'alpha (atlas padding) flattened');

// metallicRoughness. glTF packs occlusion/roughness/metalness into R/G/B, and
// the G it wants is ROUGHNESS while the source map is GLOSSINESS — so the
// channel is inverted, not copied. B is forced to black: a fish is a
// dielectric, and leaving the source's mid-grey there would render the whole
// animal as polished metal.
{
  const W = 2048;
  const rough = await sharp(png('gloss')).removeAlpha().extractChannel('green').negate()
    .raw().toBuffer();
  const black = Buffer.alloc(W * W, 0);
  const one = { raw: { width: W, height: W, channels: 1 } };
  // R = occlusion (unmapped, black), G = roughness, B = metalness (dielectric).
  const packed = sharp(black, one).joinChannel(rough, one).joinChannel(black, one);
  await addTex('metalRough', 'gloss', packed, 'gloss INVERTED into G, metal forced to 0 in B');
}

// emissive — the esca on the illicium, and near-black over the rest of the
// body (channel means 6.7/4.0/5.3 of 255). This is the map that makes the
// animal an anglerfish rather than a large mouth.
await addTex('emissive', 'emis', sharp(png('emis')).removeAlpha(), 'the lure');

// normal, derived. glTF has no height-map slot, so a bump map is either
// converted or lost. Sobel-differentiated here; `strength` 2.0 turns a full
// black-to-white step across one texel into a 45-degree tilt, which is the
// neutral reading of a map that never specified its own scale. `--no-bump`
// drops it instead.
if (BUMP) {
  const W = 2048, strength = 2.0;
  const h = await sharp(png('bump')).removeAlpha().greyscale().raw().toBuffer();
  const n = Buffer.alloc(W * W * 3);
  const at = (x, y) => h[(Math.min(W - 1, Math.max(0, y)) * W) + Math.min(W - 1, Math.max(0, x))] / 255;
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
    const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
    let vx = -dx * strength, vy = -dy * strength, vz = 1;
    const l = Math.hypot(vx, vy, vz); vx /= l; vy /= l; vz /= l;
    const i = (y * W + x) * 3;
    n[i] = (vx * 0.5 + 0.5) * 255; n[i + 1] = (vy * 0.5 + 0.5) * 255; n[i + 2] = (vz * 0.5 + 0.5) * 255;
  }
  await addTex('normal', 'bump', sharp(n, { raw: { width: W, height: W, channels: 3 } }), 'Sobel height -> tangent-space normal');
}

// --- rebuild the materials -------------------------------------------------
console.log('\nMATERIAL SLOTS');
// baseColorFactor is WHITE, and that is a correction, not a style choice.
//
// FBX stores a scalar DiffuseColor and, separately, a texture CONNECTED TO the
// DiffuseColor slot. The texture overrides the scalar; it does not modulate it.
// three.js's FBXLoader carries both across as `color` and `map`, and three
// multiplies them — so a naive import renders this animal at the product of
// the two. On FS_body that product is the atlas times #1f1a1a, i.e. 1.3% of
// linear, and the fish comes out a silhouette with all its painted detail
// still in the file and none of it on screen.
//
// What settles it is the atlas, measured rather than argued about: EVERY one
// of the seven materials' UV islands is 100% painted (tools measured opaque
// coverage per island), and the only two materials with a genuinely odd tint —
// #1f1a1a and #984f4f — are exactly the two the artist DID wire the bitmap
// into. The scalars are 3ds Max sub-material defaults sitting behind a map.
//
// So the atlas is the authored colour for all seven, and the factors are white.
// `--tint` restores the FBX scalars for anyone who wants the naive import back.
for (const m of root.listMaterials()) {
  const tint = TINT ? tints[m.getName()] : null;
  m.setBaseColorTexture(made.baseColor)
    .setMetallicRoughnessTexture(made.metalRough)
    .setEmissiveTexture(made.emissive)
    .setEmissiveFactor([1, 1, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(1)
    .setAlphaMode('OPAQUE')
    .setDoubleSided(false);
  if (BUMP && made.normal) m.setNormalTexture(made.normal).setNormalScale(1);
  m.setBaseColorFactor(tint ? [...tint, 1] : [1, 1, 1, 1]);
  // Printed as sRGB because that is what the FBX and any colour picker show;
  // what is STORED is the linear triple glTF asks for.
  const fbx = tints[m.getName()];
  const was = fbx ? '#' + new THREE.Color().fromArray(fbx).getHexString() : '(none)';
  console.log(`  ${m.getName().padEnd(22)} baseColorFactor ${tint ? was : '#ffffff'}${tint ? '' : `   (FBX scalar ${was} dropped — the map overrides it)`}`);
}
// REQUIRED, not merely used: nothing here writes a PNG fallback into
// texture.source, so a loader that skips the extension finds no image at all.
// It is also what the four models already shipping WebP declare.
if (WEBP) doc.createExtension(EXTTextureWebP).setRequired(true);

const animWas = animBytes(), vertsWas = vertCount();
await doc.transform(
  dedup({ keepUniqueNames: true }),
  resample({ tolerance: 1e-4 }),
  weld({ tolerance: 0 }),
  prune({ keepAttributes: false, keepLeaves: false }),
);
console.log(`  animation data  ${mb(animWas)} -> ${mb(animBytes())}`);
console.log(`  vertices        ${vertsWas} -> ${vertCount()}`);


// POSITION is deliberately absent from the pattern. It is the bind pose, which
// is what every skin weight and every animated bone is measured against —
// quantizing it moves the rest state of the animal, not just its surface.
// `keepUniqueNames` is what stops dedup collapsing the seven materials into
// one. With the atlas on all of them and the factors white they ARE
// byte-identical, and merging them is correct for rendering and wrong for
// everything downstream: the eyes, the teeth and the lure stop being
// separately addressable the moment they share a material slot. Unnamed
// properties — accessors, above all — still merge normally.
await doc.transform(
  quantize({
    pattern: /^(NORMAL|TANGENT|TEXCOORD(_\d+)?|COLOR(_\d+)?|WEIGHTS(_\d+)?)$/,
    quantizeNormal: 10,
    quantizeTexcoord: 12,
    quantizeWeight: 8,
    quantizeGeneric: 8,
  }),
  dedup({ keepUniqueNames: true }),
  prune(),
);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
await io.write(OUT, doc);
const outBytes = fs.statSync(OUT).size;

// ---------------------------------------------------------------------------
// 9. the proof: do the clips still move the animal the same way?
// ---------------------------------------------------------------------------
// The check re-reads the file that was just written, with ONE change: the
// images are stripped from the copy it parses. GLTFLoader decodes an embedded
// image through the browser's image pipeline, and Node has none — so on the
// real file `parse` never calls back and never throws. It simply hangs, which
// reads as the script freezing rather than as a texture problem. The maps are
// checked on their own, below, by decoding them directly.
console.log('\nSKINNING PARITY  (merged glb vs the original .FBX, same clip, same times)');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const bare = await io.readBinary(await io.writeBinary(doc));
bare.getRoot().listTextures().forEach((t) => t.dispose());
// Deliberately NOT pruned. With the textures gone the UVs become unreferenced,
// and prune would drop them — taking the esca check below down with it.
const bareBin = await io.writeBinary(bare);
const gltf = await new Promise((res, rej) => new GLTFLoader().parse(
  bareBin.buffer.slice(bareBin.byteOffset, bareBin.byteOffset + bareBin.byteLength), '', res, rej,
));

// Vertices cannot be compared index-to-index: welding took 174,036 stored
// vertices down to 12,766, so the merged mesh's indices mean nothing to the
// original's. What survives welding is a vertex's REST POSITION — the merged
// set is exactly the original set with the duplicates removed — so each sample
// point is paired by looking its rest position up in the other file, per mesh.
// If a pairing cannot be made, that is itself the failure: it means welding
// moved a vertex rather than merging identical ones.
const restKey = (v) => `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
// A mesh split across materials comes back out of GLTFLoader as one child per
// primitive — footballfish_body becomes footballfish_body, _1, _2, _3 — so the
// merged side is grouped back under the source mesh's name before pairing.
const SOURCE_MESHES = meshes.map((m) => m.name);
const stem = (o) => {
  for (let n = o; n; n = n.parent) {
    const hit = SOURCE_MESHES.find((s) => n.name === s || n.name.startsWith(s + '_'));
    if (hit) return hit;
  }
  return o.name;
};
const skinnedByStem = (scene) => {
  const m = new Map();
  scene.traverse((o) => { if (o.isSkinnedMesh) { const k = stem(o); if (!m.has(k)) m.set(k, []); m.get(k).push(o); } });
  return m;
};

const mergedByStem = skinnedByStem(gltf.scene);
const origByStem = skinnedByStem(originals[CLIPS[0]]);

// Pairs are built once, off one source file, and reused for every clip: the
// mesh is byte-identical in all eight.
const pairSet = [];
{
  for (const [name, oms] of origByStem) {
    const parts = mergedByStem.get(name);
    if (!parts) fail(`mesh "${name}" is missing from the merged glb (merged has ${[...mergedByStem.keys()]})`);
    const per = new Map();
    for (const mm of parts) {
      const pos = mm.geometry.attributes.position, v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i); const k = restKey(v); if (!per.has(k)) per.set(k, { mesh: mm, i }); }
    }
    for (const om of oms) {
      const pos = om.geometry.attributes.position, v = new THREE.Vector3();
      const step = Math.max(1, Math.floor(pos.count / 256));
      for (let i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i);
        const hit = per.get(restKey(v));
        if (!hit) fail(`${name} vertex ${i} at ${restKey(v)} has no counterpart in the merged glb — welding MOVED a vertex instead of merging identical ones`);
        pairSet.push({ orig: om, iOrig: i, merged: hit.mesh, iMerged: hit.i });
      }
    }
  }
  console.log(`  pairing ${pairSet.length} vertices by rest position across ${origByStem.size} meshes`);
}

const poseAt = (scene, clip, t) => {
  const mixer = new THREE.AnimationMixer(scene);
  mixer.clipAction(clip).play();
  mixer.setTime(t);
  scene.updateMatrixWorld(true);   // skinning reads world matrices; without this
                                   // every pose measures identical and nothing throws
  scene.traverse((o) => { if (o.isSkinnedMesh) o.skeleton.update(); });
};
const readPairs = (side, remap) => {
  const out = new Float64Array(pairSet.length * 3), v = new THREE.Vector3();
  pairSet.forEach((p, n) => {
    const m = remap ? remap(p[side]) : p[side];
    m.getVertexPosition(p[side === 'orig' ? 'iOrig' : 'iMerged'], v); m.localToWorld(v);
    out[n * 3] = v.x; out[n * 3 + 1] = v.y; out[n * 3 + 2] = v.z;
  });
  return out;
};

let worst = 0, worstClip = '';
for (const name of CLIPS) {
  const mine = gltf.animations.find((a) => a.name === name);
  if (!mine) fail(`clip "${name}" is not in the finished glb`);
  const orig = originals[name];
  const origClip = orig.animations[0];
  const byName = new Map(); orig.traverse((o) => { if (o.isSkinnedMesh) byName.set(o.name, o); });
  const toThisClip = (m) => byName.get(m.name);
  if (Math.abs(mine.duration - origClip.duration) > 1 / FPS) {
    fail(`${name}: duration ${mine.duration.toFixed(3)}s vs source ${origClip.duration.toFixed(3)}s`);
  }
  const dur = Math.min(mine.duration, origClip.duration);

  poseAt(orig, origClip, 0);
  const rest = readPairs('orig', toThisClip);

  let clipWorst = 0, travel = 0;
  for (const f of [0.13, 0.37, 0.61, 0.88]) {
    poseAt(gltf.scene, mine, dur * f);
    const a = readPairs('merged');
    poseAt(orig, origClip, dur * f);
    const b = readPairs('orig', toThisClip);
    for (let i = 0; i < a.length; i += 3) {
      clipWorst = Math.max(clipWorst, Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]));
      travel = Math.max(travel, Math.hypot(b[i] - rest[i], b[i + 1] - rest[i + 1], b[i + 2] - rest[i + 2]));
    }
  }
  // A clip that moves nothing is the failure mode that looks like success: it
  // binds, it plays, it reports a perfect 0.0000 error, and the animal is
  // frozen. So the SOURCE has to be shown moving before the match means anything.
  if (travel < 0.05) fail(`${name}: the SOURCE clip moves no vertex more than ${travel.toFixed(4)} units — it is an empty take, do not ship it as a clip`);
  if (clipWorst > worst) { worst = clipWorst; worstClip = name; }
  console.log(`  ${name.padEnd(11)} ${mine.duration.toFixed(3)}s  worst error ${clipWorst.toFixed(4)}u   (source moves vertices up to ${travel.toFixed(2)}u)`);
}
// The rig is ~62 units long. A tenth of a unit is well under a pixel at any
// size this animal is ever drawn, and it is what quantizing skin weights costs.
const TOL = 0.1;
if (worst > TOL) fail(`${worstClip} drifts ${worst.toFixed(4)}u from the source, over the ${TOL}u budget`);

// --- the maps, decoded back out of the finished file ----------------------
// Re-encoding is where a map can quietly become the wrong thing: a channel
// swap, a resize, or a silent format failure all leave a file that opens.
console.log('\nTEXTURE READBACK  (decoded out of the written glb)');
const written = await io.read(OUT);
for (const t of written.getRoot().listTextures()) {
  const img = sharp(Buffer.from(t.getImage()));
  const meta = await img.metadata();
  if (meta.width !== 2048 || meta.height !== 2048) fail(`${t.getName()} decoded at ${meta.width}x${meta.height}, not 2048x2048 — VRAM was supposed to be untouched`);
  const st = await img.stats();
  console.log(`  ${t.getName().padEnd(11)} ${meta.format} ${meta.width}x${meta.height} channel means ${st.channels.map((c) => c.mean.toFixed(1)).join('/')}`);
}
// Roughness must be the INVERSE of the source gloss, not a copy of it. Compared
// as means, since WebP is lossy and an exact match would be the wrong test.
{
  const src = (await sharp(fs.readFileSync(path.join(TEX, MAPS.gloss))).removeAlpha().stats()).channels[1].mean;
  const t = written.getRoot().listTextures().find((x) => x.getName() === 'metalRough');
  const got = (await sharp(Buffer.from(t.getImage())).stats()).channels;
  if (Math.abs(got[1].mean - (255 - src)) > 4) fail(`roughness mean ${got[1].mean.toFixed(1)}, expected ~${(255 - src).toFixed(1)} (inverse of gloss ${src.toFixed(1)}) — the channel was copied, not inverted`);
  // The channel is written black, but it decodes at ~1/255 because WebP is
  // lossy and a flat channel beside a detailed one picks up its ringing. What
  // actually guarantees a dielectric is metallicFactor, which MULTIPLIES this
  // channel — so that is asserted too, and it is the one that cannot drift.
  if (got[2].mean > 3) fail(`metalness channel mean ${got[2].mean.toFixed(1)} — expected ~0; the fish would render as metal`);
  const metalFactors = written.getRoot().listMaterials().map((m) => m.getMetallicFactor());
  if (metalFactors.some((f) => f !== 0)) fail(`metallicFactor is ${metalFactors} — every one must be 0`);
  console.log(`  roughness ${got[1].mean.toFixed(1)} = 255 - gloss ${src.toFixed(1)};  metalness channel ${got[2].mean.toFixed(1)} x metallicFactor 0`);
}

// --- UVs still exist ------------------------------------------------------
// This is checked on its own, and first, because losing TEXCOORD_0 is the
// failure that hides best: the file opens, the maps are all present and
// correct, the materials point at them, and the animal renders in one flat
// colour that still reads as shaded skin. The esca check below would catch it
// too, but only by crashing on a missing attribute rather than saying why.
console.log('\nATTRIBUTES');
for (const mesh of written.getRoot().listMeshes()) {
  for (const [i, prim] of mesh.listPrimitives().entries()) {
    if (!prim.getAttribute('TEXCOORD_0')) fail(`${mesh.getName()} primitive ${i} has no TEXCOORD_0 — every fragment would sample texel (0,0). Check that the maps are attached BEFORE prune runs.`);
  }
  console.log(`  ${mesh.getName().padEnd(22)} ${mesh.listPrimitives().length} primitive(s), all with UVs`);
}

// --- the esca ------------------------------------------------------------
// The one check that catches a vertically mirrored atlas. It is written
// against the emissive map because that map has an unambiguous subject: an
// anglerfish's lure is lit and the rest of it is not, so the bright texels
// MUST land at the top of the illicium. A flip puts them on the belly, and
// every other check in this file passes while it does.
console.log('\nTHE ESCA  (where the emissive map lands on the body)');
{
  const emisTex = written.getRoot().listMaterials()[0].getEmissiveTexture();
  const { data, info } = await sharp(Buffer.from(emisTex.getImage())).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const bb = new THREE.Box3().setFromObject(gltf.scene);
  const span = bb.max.y - bb.min.y;
  const bright = [];
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const uv = o.geometry.attributes.uv, pos = o.geometry.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < uv.count; i++) {
      const px = Math.min(info.width - 1, Math.max(0, Math.round(uv.getX(i) * (info.width - 1))));
      const py = Math.min(info.height - 1, Math.max(0, Math.round(uv.getY(i) * (info.height - 1))));
      const k = (py * info.width + px) * 3;
      if (Math.max(data[k], data[k + 1], data[k + 2]) > 200) bright.push(v.clone().fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld));
    }
  });
  if (bright.length < 50) fail(`only ${bright.length} vertices reach a bright emissive texel — the lure is not lit at all`);
  const top = bright.filter((p) => p.y > bb.max.y - span * 0.15).length / bright.length;
  const cy = bright.reduce((a, p) => a + p.y, 0) / bright.length;
  console.log(`  ${bright.length} vertices sample emissive > 200`);
  console.log(`  centroid y ${cy.toFixed(1)}, body spans ${bb.min.y.toFixed(1)}..${bb.max.y.toFixed(1)}`);
  console.log(`  ${(top * 100).toFixed(0)}% of them sit in the top 15% of the animal — the lure`);
  if (top < 0.3) fail(`the emissive map lands on the BOTTOM of the animal (${(top * 100).toFixed(0)}% up top). The atlas is mirrored vertically — check the V flip in step 5b`);
}

const box = new THREE.Box3().setFromObject(gltf.scene);
const size = box.getSize(new THREE.Vector3());
console.log(`\nRESULT  ${path.relative(ROOT, OUT)}`);
console.log(`  ${mb(srcBytes + texBytes)} across ${files.length + 4} files  ->  ${mb(outBytes)} in one`);
console.log(`  ${(100 - (outBytes / (srcBytes + texBytes)) * 100).toFixed(1)}% smaller`);
console.log(`  ${gltf.animations.length} clips, ${vertCount()} vertices, ${root.listMaterials().length} materials, ${groupsAfter} primitives`);
console.log(`  bounds ${size.toArray().map((v) => v.toFixed(2)).join(' x ')} source units\n`);
