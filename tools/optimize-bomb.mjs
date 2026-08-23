// Turns the raw cartoon-bomb download into the game's voicemail bomb.
//
//   node tools/optimize-bomb.mjs [source.glb] [out.glb]
//
// The source is 4.01MB for 6,420 triangles, and that ratio is the whole story:
// the mesh is nearly free and the file is 90% TEXTURE. Five 1024x1024 maps
// (3.51MB of JPEG and PNG) on an object that is about one world unit across
// and appears one or two at a time.
//
// FOUR THINGS ARE WRONG WITH IT, and only one of them is size.
//
//   1. IT IS SPEC-GLOSS. The materials carry KHR_materials_pbrSpecularGlossiness,
//      an extension three.js dropped support for years ago. Loaded as-is the
//      bomb renders with no diffuse map at all — the base colour lives inside
//      the extension, so GLTFLoader reads a material whose baseColorTexture
//      slot is genuinely empty and draws a flat white ball. Nothing throws.
//      metalRough() converts it, and that has to happen FIRST because every
//      step after it operates on the textures it produces.
//
//   2. THE FUSE IS 70% OF THE MODEL. 4,536 of the 6,420 triangles are the
//      "Rope" mesh — a curly wick 0.77 units long on a 4.4-unit model, which
//      is a few pixels across in play. It is decimated harder than the ball,
//      separately, because one global ratio either leaves the fuse fat or
//      eats the sphere.
//
//   3. IT IS Z-UP, AND ONLY HALF OF IT KNOWS. The geometry is authored Z-up
//      and a wrapper node carries the rotation that stands it up, so the raw
//      accessor data and the space three.js draws in differ by ninety degrees.
//      Step 0 bakes that away before anything measures anything — read the
//      note there, because the failure it prevents is a flame ninety degrees
//      off a fuse with every other number checking out.
//
//   4. NOTHING TELLS THE GAME WHERE THE WICK TIP IS. systems/bakalar.js has to
//      put a flame on the end of the fuse and burn it down toward the bomb,
//      and there is no node, bone or locator for it. So this script MEASURES
//      the fuse — tip, root, and the polyline between them — and writes the
//      result into the output file's scene extras, where assets.js can read it
//      off the loaded model. Measured rather than typed, because a hand-typed
//      offset is a number that silently stops being true the moment the model
//      is re-exported.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//
//   * Weld before textures are attached. prune() drops UVs it thinks nothing
//     reads, and a model that renders one flat colour with every other check
//     passing is the result. metalRough() runs first for the same reason.
//   * Quantize POSITION. The model is ~4 units across, the wick locator is
//     measured off these exact coordinates, and the saving is nothing on a
//     5k-vertex mesh.
//   * Keep the occlusion map. It is a 1024x1024 PNG baking shadow into a
//     cartoon object that the game lights itself and outlines. Dropped, not
//     shrunk.
//
// The fuse is re-measured at the end and the script FAILS if it did not
// survive: a decimated wick that has collapsed to a stub still renders a
// perfectly good bomb, and the flame simply sits in the wrong place forever.

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup, prune, weld, simplifyPrimitive, quantize, textureCompress, metalRough,
  flatten, clearNodeTransform,
} from '@gltf-transform/functions';
import sharp from 'sharp';
import { MeshoptSimplifier } from 'meshoptimizer';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flag = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : dflt;
};

const SRC = args[0]
  ? resolve(process.cwd(), args[0])
  : '/Users/ethangoldhammer/Documents/_DesignSystems/SealSurvivor/simple_bomb.glb';
const OUT = args[1]
  ? resolve(process.cwd(), args[1])
  : resolve(HERE, '../public/models/voicemailbomb.glb');

// Two ratios, because the fuse and the ball are different problems. The ball
// is a sphere: it needs enough rings not to facet on its silhouette, which is
// the one place a low-poly sphere shows. The fuse is a tube a few pixels
// across whose only job is to be a squiggle with a light on the end.
const BALL_RATIO = flag('ball', 0.34);
const FUSE_RATIO = flag('fuse', 0.10);
const ERROR = flag('error', 0.004);
const FUSE_ERROR = flag('fuseError', 0.08);
const TEX = flag('tex', 512);
const BRIGHTEN = flag('brighten', 1.7);

// Which material name is which mesh. Named rather than indexed: the source has
// exactly two primitives and an index would survive a re-export that reordered
// them, silently swapping the two ratios.
const FUSE_MATERIAL = 'Rope';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
await MeshoptSimplifier.ready;

const doc = await io.read(SRC);
const before = statSync(SRC).size;

// --- 0. BAKE THE NODE TRANSFORMS INTO THE VERTICES --------------------------
// FIRST, before anything measures anything, and it is the step this script
// was wrong without.
//
// The file is a Sketchfab export: the geometry is authored Z-up and a wrapper
// node called "Sketchfab_model" carries the -90 degree X rotation that stands
// it up. So there are two different coordinate systems in play — the raw
// accessor data this script reads, and the space three.js actually draws the
// mesh in — and they differ by exactly that rotation.
//
// It cost an afternoon. The wick path measured out of the accessors came back
// running along +Z, the game transformed it by the model's own matrix (which
// does NOT include a descendant node's rotation), and the flame ended up
// ninety degrees away from the fuse — pointing straight at the camera, on a
// bomb whose every other number checked out. Both the path and the model were
// self-consistent; they were just answers to different questions.
//
// Baking removes the question. After this the accessors ARE the scene space:
// the bomb is Y-up, the wick runs +Y, and the `forward`/`up` on the def in
// assets.js describe axes you can read straight off the file.
await doc.transform(flatten());
for (const node of doc.getRoot().listNodes()) clearNodeTransform(node);

function stats() {
  let tris = 0;
  let verts = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      tris += (idx ? idx.getCount() : prim.getAttribute('POSITION').getCount()) / 3;
      verts += prim.getAttribute('POSITION').getCount();
    }
  }
  return { tris: Math.round(tris), verts };
}

// Every primitive wearing `matName`, or every primitive that is NOT wearing it.
function primsFor(matName, invert = false) {
  const out = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const hit = prim.getMaterial()?.getName() === matName;
      if (hit !== invert) out.push(prim);
    }
  }
  return out;
}

// THE WICK, measured rather than typed.
//
// The fuse is a tube, so its centreline is recovered by slicing the vertices
// along the axis it is longest on and taking the mean of each slice. That
// gives an ordered polyline from the root (buried in the bomb's neck) to the
// tip (the free end, the highest point in the file) — which is exactly what a
// burn needs: a path to walk a flame down, not a single point.
//
// Sliced on the LONGEST axis rather than assumed to be Z: the source is Z-up
// today, and a re-export from a different tool would quietly hand back a
// centreline running across the wick instead of along it.
function measureFuse(prims, samples = 9) {
  if (!prims?.length) return null;

  const pts = [];
  const v = [0, 0, 0];
  for (const prim of prims) {
    const pos = prim.getAttribute('POSITION');
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, v);
      pts.push([v[0], v[1], v[2]]);
    }
  }

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  const span = max.map((m, k) => m - min[k]);
  const axis = span.indexOf(Math.max(...span));

  // Mean of each slice. A tube's cross-section is a ring, and the mean of a
  // ring is its centre — which is why this works on a curled wick where a
  // bounding box tells you nothing about where the middle of it is.
  const path = [];
  for (let s = 0; s < samples; s++) {
    const lo = min[axis] + (span[axis] * s) / samples;
    const hi = min[axis] + (span[axis] * (s + 1)) / samples;
    let n = 0;
    const sum = [0, 0, 0];
    for (const p of pts) {
      if (p[axis] < lo || p[axis] > hi) continue;
      n++;
      for (let k = 0; k < 3; k++) sum[k] += p[k];
    }
    if (n) path.push(sum.map((c) => c / n));
  }
  // Tip last: the free end is the one at the HIGH end of the long axis (the
  // root is buried in the bomb's neck), and the slices are already in that
  // order, so the array reads root -> tip the way a fuse burns.
  return { axis, path, length: span[axis] };
}

// THE FUSE PRIMITIVE, resolved once and held by REFERENCE for the rest of the
// script. It was looked up by material name every time, which stopped working
// the moment dedup() noticed that both materials point at the same maps and
// merged them: the geometry was untouched, the wick measured as GONE, and the
// script failed on a model that was completely fine. A Primitive survives
// every transform below — the name on the material it happens to wear does
// not.
const fusePrims = primsFor(FUSE_MATERIAL);
const ballPrims = primsFor(FUSE_MATERIAL, true);

const s0 = stats();
const fuse0 = measureFuse(fusePrims);
console.log(`source  ${(before / 1e6).toFixed(2)}MB  ${s0.tris} tris  ${s0.verts} verts`);
console.log(`        fuse ${fuse0 ? `${fuse0.length.toFixed(3)} long on axis ${'XYZ'[fuse0.axis]}, ${fuse0.path.length} centreline points` : 'NOT FOUND'}`);
console.log(`        textures ${doc.getRoot().listTextures().length}, extensions ${doc.getRoot().listExtensionsUsed().map((e) => e.extensionName).join(', ') || 'none'}`);

// --- 1. spec-gloss -> metallic-roughness ------------------------------------
// FIRST, and everything else depends on it. Until this runs the diffuse map is
// inside an extension three.js cannot read, and prune() below would see a
// material with no base colour texture, decide the UVs feed nothing, and throw
// them away — which renders the bomb as one flat colour with every other check
// in this script still passing.
await doc.transform(metalRough());

// --- 2. weld, then decimate each mesh on its own budget ---------------------
// Welded first: a simplifier cannot collapse an edge across a seam it cannot
// see, and Sketchfab exports split vertices at every UV island. Unwelded, the
// ratio silently under-delivers — 5,013 verts for 6,420 triangles is already
// the tell that this file is split.
await doc.transform(weld());

// PER PRIMITIVE, not per document. simplify() is a whole-document transform
// with one ratio, and the obvious workaround — park the other mesh, run it,
// put the mesh back — does not work: a Mesh whose only primitive has just been
// parked looks like dead weight, the pass deletes it and the Node above it,
// and the primitive comes back attached to an orphan the writer then drops.
// The symptom is half the model silently missing. simplifyPrimitive is the
// same simplifier without the document plumbing, so each half gets its own
// budget and nothing is ever detached.
// The error tolerances differ as much as the ratios do. meshopt's `error` is
// relative to the PRIMITIVE's own extents, and the fuse's extents are a tenth
// of the ball's — so the ball's tolerance applied to the wick is an absolute
// budget forty times tighter, and the simplifier simply refuses most of the
// collapses it is asked for. The first run of this script came back with the
// fuse at 3,546 triangles against a ratio that asked for 454.
for (const [name, prims, ratio, error] of [
  ['ball', ballPrims, BALL_RATIO, ERROR],
  ['fuse', fusePrims, FUSE_RATIO, FUSE_ERROR],
]) {
  let was = 0;
  let now = 0;
  for (const prim of prims) {
    was += (prim.getIndices()?.getCount() ?? 0) / 3;
    simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio, error });
    now += (prim.getIndices()?.getCount() ?? 0) / 3;
  }
  console.log(`  ${name} ${Math.round(was)} -> ${Math.round(now)} tris (ratio ${ratio})`);
}

// --- 3. drop every map the game will not read -------------------------------
// VRAM here is per SOURCE image, not per file byte: a 512x512 webp is 23KB on
// disk and a full megabyte once the driver has it. So the question for each
// map is not "is it small" but "does anything look at it".
//
//   occlusion   a 1024x1024 bake of shadow, on a cartoon object the game
//               lights itself, tints, and draws an outline around. It fights
//               all three.
//   specular    metalRough() emits KHR_materials_specular for the half of
//               spec-gloss that metallic-roughness cannot express — and here
//               those maps are SINGLE COLOURED (prune says so itself and
//               declines to remove them). A megabyte each to say "the same
//               number everywhere".
//   metal-rough this is a matte black ball with a rope on it. One roughness
//               and one metalness for the whole object, set on the def in
//               assets.js, says the same thing for free.
//
// Base colour and normal survive: the paint is the model, and the normal is
// what keeps the rope reading as braid rather than as a smooth tube once the
// geometry that made the braid has been decimated away.
for (const mat of doc.getRoot().listMaterials()) {
  mat.setOcclusionTexture(null);
  mat.setMetallicRoughnessTexture(null);
  mat.setExtension('KHR_materials_specular', null);
  mat.setExtension('KHR_materials_ior', null);
}
// ...and dispose the EXTENSIONS themselves, not only the materials' use of
// them. A document-level Extension keeps its own reference to the textures it
// created, so clearing every material still leaves prune() looking at images
// that something in the graph is holding: the file came out with two orphaned
// 512x512 maps — a megabyte of VRAM each once uploaded — and extensionsUsed
// still advertising features no material had.
for (const ext of doc.getRoot().listExtensionsUsed()) {
  if (ext.extensionName === 'KHR_materials_specular' || ext.extensionName === 'KHR_materials_ior') ext.dispose();
}

// --- 3b. LIFT THE PAINT -----------------------------------------------------
// The download is authored for a hero render on a white background and it is
// far too dark for this game. 78% of its painted area sits at sRGB 48-63 and
// nothing in the file goes above 143.
//
// THE REASON THAT IS WORSE THAN IT SOUNDS is the colour space. sRGB 55 is
// linear 0.039 — under a quarter of what the number looks like — and lighting
// happens in linear. The game's whole rig (ambient 0.85, key 1.25, hemi 0.4)
// multiplies that to about 0.04, which comes back out as sRGB 55 again: a ball
// almost exactly as dark as the water behind it, with only its outline
// separating the two. Reading the texture as "dark grey, the lights will pick
// it up" is the mistake, and it is invisible until the model is in the scene.
//
// A GAMMA LIFT, not a multiply. A flat multiply that brings the ball to a
// readable charcoal takes the rope past 200 and bleaches it; the curve lifts
// the bottom of the range hard and the top gently, so the ball goes 55 -> 107
// and the rope 104 -> 151. Applied to the BASE COLOUR only — a normal map is
// not a colour and lifting one bends every surface it describes.
if (BRIGHTEN !== 1) {
  const done = new Set();
  for (const mat of doc.getRoot().listMaterials()) {
    const tex = mat.getBaseColorTexture();
    if (!tex || done.has(tex)) continue;
    done.add(tex);
    const img = sharp(Buffer.from(tex.getImage()));
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += info.channels) {
      for (let k = 0; k < Math.min(3, info.channels); k++) {
        data[i + k] = Math.round(255 * (data[i + k] / 255) ** (1 / BRIGHTEN));
      }
    }
    const out = await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
      .png().toBuffer();
    tex.setImage(new Uint8Array(out)).setMimeType('image/png');
  }
  console.log(`  base colour lifted by gamma ${BRIGHTEN}`);
}

// --- 4. shrink and re-encode ------------------------------------------------
// 512 is generous for something that is about one world unit across; the
// source maps are 1024 and were authored for a hero render. WebP because these
// are painted textures and PNG is a lossless format meant for line art — the
// same trade tools/optimize-crab.mjs makes, and three.js has read WebP inside
// a glb through EXT_texture_webp for years.
await doc.transform(
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [TEX, TEX], quality: 84 }),
  dedup(),
  prune(),
  // POSITION is excluded by the PATTERN rather than by a bit count: the
  // option takes 8-16 and has no "off", so asking for 0 throws. It keeps its
  // float32 because the wick centreline below is measured off these exact
  // coordinates, and the saving on a 3k-vertex mesh is noise.
  quantize({
    pattern: /^(NORMAL|TANGENT|TEXCOORD(_\d+)?|COLOR(_\d+)?)$/,
    quantizeNormal: 10,
    quantizeTexcoord: 12,
    quantizeGeneric: 8,
  }),
);

// --- 5. the wick locator, into the file -------------------------------------
// Re-measured AFTER decimation, because the number the game reads has to
// describe the mesh the game loads. Written into the scene's extras so it
// travels with the model: assets.js pulls it off the parsed glTF, and a
// re-export that changed the fuse changes this with it.
const fuse1 = measureFuse(fusePrims);
if (!fuse1 || fuse1.length < fuse0.length * 0.8) {
  console.error(`\nFAILED: the fuse did not survive — was ${fuse0?.length.toFixed(3)}, now ${fuse1?.length.toFixed(3) ?? 'gone'}.`);
  console.error('A collapsed wick still renders a perfectly good bomb; the flame just sits in the wrong place forever.');
  process.exit(1);
}
doc.getRoot().listScenes()[0].setExtras({
  ...doc.getRoot().listScenes()[0].getExtras(),
  // Root -> tip, in the SOURCE file's axes. assets.js converts once, on load,
  // using the same up/forward the model itself is oriented with.
  wickPath: fuse1.path.map((p) => p.map((n) => Number(n.toFixed(4)))),
});

await io.write(OUT, doc);

const s1 = stats();
const after = statSync(OUT).size;
console.log(`\noutput  ${(after / 1e6).toFixed(2)}MB  ${s1.tris} tris  ${s1.verts} verts`);
console.log(`        ${(before / after).toFixed(1)}x smaller, ${(s0.tris / s1.tris).toFixed(1)}x fewer triangles`);
console.log(`        textures ${doc.getRoot().listTextures().length} @ ${TEX}px webp`);
console.log(`        wick ${fuse1.path.length} points, tip ${fuse1.path.at(-1).map((n) => n.toFixed(3)).join(', ')}`);
console.log(`\nwrote ${OUT}`);
