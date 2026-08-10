// Turns the raw rigged-crab download into something a CROWD can afford.
//
//   node tools/optimize-crab.mjs [source.glb] [out.glb]
//
// The source is a 8.64MB, 92,491-triangle, 126-bone crab. Every one of those
// numbers is fine for a hero model and none of them is fine for this one,
// because the crab is the only creature in the game that arrives in a heap:
// maxConcurrent is 10 and the death pile-on allows 20. Measured against what
// the game currently spends, the raw file is:
//
//     92,491 tris   10.9x the crab it replaces (8,520), and more than DOUBLE
//                   the heaviest asset in the roster (fisherman, 43,164).
//                   Twenty of them is ~1.85M triangles against a whole-game
//                   budget of 284,879 across all 39 assets.
//     51,686 verts  10.6x — and these are SKINNED, so this is per-frame CPU
//                   or vertex-shader work, not just rasterisation.
//        126 bones  3x. Bone matrices are uploaded per instance per frame.
//
// WHY IT IS WORTH THE TROUBLE ANYWAY: this rig has a real pincer. Its claw
// forks into two finger chains that drive separate geometry, and rotating the
// movable one opens the tip aperture by 277% (measured — see
// tools/crab-claw-probe.mjs). crabwalking.glb cannot do that at any price: its
// claw is one closed lump on a leaf bone, which is why systems/crabClaw.js has
// to fake the pinch by swinging the whole head.
//
// WHAT THIS DOES, and why each step is safe:
//
//   1. SIMPLIFY the mesh to `--ratio` of its triangles (default 0.13, so about
//      12k). This is the whole point of the script. meshoptimizer's simplifier
//      is skin-aware: it carries JOINTS_0/WEIGHTS_0 through, so the fingers
//      keep being driven by the finger bones. At 0.13 they still hold roughly
//      150-230 verts each, which is plenty for a shape that is ~30px across in
//      play. The claw is re-measured after the fact rather than assumed.
//   2. WELD first, because a simplifier cannot collapse an edge across a seam
//      it cannot see. Sketchfab exports routinely ship split vertices for
//      every UV island; unwelded, the ratio silently under-delivers.
//   3. QUANTIZE joints and weights to bytes. 126 joints fit in a byte, and a
//      skin weight is a number between 0 and 1 about to be summed with three
//      others — float32 is four bytes of precision nobody can see.
//   4. PRUNE and DEDUP: unused accessors, duplicate materials/textures.
//   5. RE-ENCODE the three 1024x1024 maps to WebP. They arrive as a JPEG and
//      two PNGs totalling 3.14MB, which is most of what is left after the mesh
//      is decimated — PNG is lossless and meant for line art, and these are
//      painted textures. three.js has read WebP inside a glb through
//      EXT_texture_webp for years. Same trade the fisherman script makes.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//
//   * Touch the SKELETON. Dropping the unused IK helper bones
//     (IKRootleg*) would save four matrices and is not worth the risk of
//     renumbering something systems/crabClaw.js resolves by name.
//   * Quantize POSITION. Same call the fisherman script makes: the bind pose
//     is what every skin weight is relative to, and this model is 0.476 units
//     across, so absolute precision is already tight.
//   * Resample the animation. The clip is 0.48s over 66 tracks — it is
//     already small, and it is one walk stride.
//
// The claw fork is re-measured at the end and the script FAILS if the pincer
// did not survive, because a decimated claw that has lost its two prongs looks
// perfectly fine sitting still and simply never opens.

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld, simplify, quantize, textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';
import { MeshoptSimplifier } from 'meshoptimizer';
import { resolve, dirname, basename } from 'node:path';
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
  : '/Users/ethangoldhammer/Documents/_DesignSystems/SealSurvivor/animated_crab_rigged_free.glb';
const OUT = args[1]
  ? resolve(process.cwd(), args[1])
  : resolve(HERE, '../public/models/crabpincer.glb');
const RATIO = flag('ratio', 0.13);
const ERROR = flag('error', 0.005);

// The two finger chains, per side. These are what the pincer IS — if the
// simplifier drops the vertices they drive, the claw stops being able to open
// and nothing else in the pipeline would notice.
//
// NAMES HERE CARRY DOTS AND THE ONES IN assets.js DO NOT. This file reads the
// raw glTF, where the joints are `Hand.6.L_046`; three.js sanitises node names
// on load (PropertyBinding strips the reserved characters), so by the time
// systems/crabClaw.js calls getObjectByName the same bone is `Hand6L_046`.
// Using either form in the other place resolves nothing, silently — a chain
// that "isn't found" just makes the limb stop moving.
const CLAW_BONES = [
  'Hand.6.L_046', 'Hand.5.L_047', 'Hand.7.L_048',
  'Hand.6.R_056', 'Hand.5.R_057', 'Hand.7.R_058',
];

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
await MeshoptSimplifier.ready;

const doc = await io.read(SRC);
const before = statSync(SRC).size;

const stats = () => {
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
};

// How many vertices each claw bone dominates. Run before and after, because
// "the pincer survived" is the one property this script can silently destroy.
function clawWeights() {
  const skins = doc.getRoot().listSkins();
  if (!skins.length) return null;
  const joints = skins[0].listJoints();
  const index = new Map();
  joints.forEach((j, i) => index.set(j.getName(), i));

  const counts = new Map(CLAW_BONES.map((b) => [b, 0]));
  // Joint index -> the claw bone it is, so the inner loop is a lookup rather
  // than a scan over 126 names per vertex per influence.
  const wanted = new Map();
  for (const name of CLAW_BONES) {
    if (index.has(name)) wanted.set(index.get(name), name);
    else console.warn(`  [warn] ${name} is not a joint of this skin`);
  }

  const je = [];
  const we = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const J = prim.getAttribute('JOINTS_0');
      const W = prim.getAttribute('WEIGHTS_0');
      if (!J || !W) continue;
      for (let v = 0; v < J.getCount(); v++) {
        J.getElement(v, je);
        W.getElement(v, we);
        for (let k = 0; k < 4; k++) {
          if (we[k] <= 0.25) continue;
          const name = wanted.get(je[k]);
          if (name) counts.set(name, counts.get(name) + 1);
        }
      }
    }
  }
  return counts;
}

const s0 = stats();
const claw0 = clawWeights();
console.log(`\n${basename(SRC)}`);
console.log(`  ${(before / 1048576).toFixed(2)} MB  ${s0.tris.toLocaleString()} tris  ${s0.verts.toLocaleString()} verts  `
  + `${doc.getRoot().listSkins()[0]?.listJoints().length ?? 0} bones`);

await doc.transform(
  dedup(),
  // Welding is not optional here: a simplifier cannot collapse an edge across
  // a split vertex, and this file ships them at every UV seam.
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio: RATIO, error: ERROR }),
  prune(),
  // POSITION is excluded by the pattern rather than by a bit count: the option
  // takes 8-16 and has no "off", so asking for 0 throws. The bind pose is what
  // every skin weight is relative to and this model is 0.476 units across, so
  // it keeps its float32.
  quantize({
    pattern: /^(NORMAL|TANGENT|TEXCOORD(_\d+)?|COLOR(_\d+)?|WEIGHTS(_\d+)?)$/,
    quantizeNormal: 10,
    quantizeTexcoord: 12,
    quantizeWeight: 8,
    quantizeGeneric: 8,
  }),
  // Last, so it runs on whatever textures survived the prune.
  textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 88 }),
);

await io.write(OUT, doc);
const after = statSync(OUT).size;
const s1 = stats();
const claw1 = clawWeights();

console.log(`\n${basename(OUT)}`);
console.log(`  ${(after / 1048576).toFixed(2)} MB  ${s1.tris.toLocaleString()} tris  ${s1.verts.toLocaleString()} verts`);
console.log(`  -> ${((1 - after / before) * 100).toFixed(0)}% smaller, ${((1 - s1.tris / s0.tris) * 100).toFixed(0)}% fewer triangles`);

console.log(`\nDID THE PINCER SURVIVE?`);
let lost = 0;
for (const bone of CLAW_BONES) {
  const a = claw0?.get(bone) ?? 0;
  const b = claw1?.get(bone) ?? 0;
  const ok = b >= 24; // below this a prong is too sparse to deform as a shape
  if (!ok) lost++;
  console.log(`  ${ok ? 'ok  ' : 'LOST'}  ${bone.padEnd(14)} ${String(a).padStart(5)} -> ${String(b).padStart(4)} verts`);
}
if (lost) {
  console.error(`\n${lost} claw bone(s) lost their geometry. Raise --ratio and re-run; `
    + `a claw with no prongs looks fine standing still and simply never opens.\n`);
  process.exit(1);
}
console.log(`\nboth pincers intact. Re-measure the aperture with:`);
console.log(`  node --import ./tools/vite-loader.mjs tools/crab-claw-probe.mjs ${OUT}\n`);
