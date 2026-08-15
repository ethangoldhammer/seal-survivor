// Turns the raw Sketchfab mosasaurus into a boss the game can afford to ship.
//
//   node tools/optimize-mosasaurus.mjs [source.glb] [out.glb] [--ratio=0.5]
//
// THE SOURCE is 8.25MB: 67,434 triangles, 36,024 vertices, 50 bones, one
// material, and 3.94MB of PNG across four map slots (base, metallic-roughness,
// normal, occlusion — mr and ao share an image, as ORM packing usually does).
//
// Measured against what the game already ships, the mesh is not the problem and
// the textures are:
//
//     67,434 tris    2.2x the megalodon (30,100), the heaviest boss body in the
//                    roster. High, but a boss is a SINGLETON — maxConcurrent 1,
//                    and the arena is emptied for it — so this is a download
//                    cost far more than a frame cost.
//      3.94 MB PNG   48% of the whole file, and PNG is a lossless format meant
//                    for line art. These are painted maps.
//
// WHAT THIS DOES:
//
//   1. WELD, then SIMPLIFY to `--ratio` (default 0.5, so about 34k — the
//      megalodon's band). Welding first is not optional: a simplifier cannot
//      collapse an edge across a split vertex, and Sketchfab exports ship them
//      at every UV island, so an unwelded ratio silently under-delivers.
//   2. RESAMPLE the animation. 147 tracks over 49 nodes is position, rotation
//      AND scale keyed on all 330 frames of a rig that only ever rotates — the
//      position and scale tracks are 330 copies of one value each.
//   3. QUANTIZE normals, UVs and skin weights to the precision anyone can see.
//      POSITION is left alone: the bind pose is what every skin weight is
//      relative to, and this rig is what the animation drives.
//   4. RE-ENCODE the maps to WebP. three.js has read WebP inside a glb through
//      EXT_texture_webp for years — the same trade the crab and fisherman
//      scripts make.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//
//   * Cut the ANIMATION into takes. The file's one 13.2s reel holds a swim
//     cycle, two bites and a quiet hold, and assets.js can slice it without
//     touching the binary — see `subclips` on enemyMosasaur and the frame
//     numbers measured by tools/clip-takes.mjs. Baking the cuts in here would
//     put them somewhere nobody can re-measure them.
//   * Touch the SKELETON. 50 bones is unremarkable and assets.js resolves
//     every one of them by name.
//
// THE SURVIVAL CHECK at the end is the point of the script being a script. The
// simplifier is skin-aware but it is not told what matters, and on this body
// three things can be decimated away while the animal still looks perfectly
// fine standing still:
//
//   THE JAW      Bone021_6 carries 4,214 vertices and swings 62 degrees open on
//                the bite this boss is built around. A sparse jaw still opens —
//                it just tears away from the skull while it does.
//   THE FLIPPERS four 3-bone chains of 150-450 verts each. They are the small
//                geometry on a body whose torso is enormous, so they are
//                exactly what a global ratio takes first.
//   THE FLUKE    Bone017_14, the tail tip, is where the whole spring chain's
//                motion ends up. Lose it and the trail stops at the peduncle.
//
// Source art is never written to: this reads from _DesignSystems and writes
// only to public/models, so re-running it after a new export is the whole
// update process.

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld, simplify, quantize, resample, textureCompress } from '@gltf-transform/functions';
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
  : '/Users/ethangoldhammer/Documents/_DesignSystems/SealSurvivor/mosasaurus.glb';
const OUT = args[1]
  ? resolve(process.cwd(), args[1])
  : resolve(HERE, '../public/models/mosasaurus.glb');
const RATIO = flag('ratio', 0.5);
const ERROR = flag('error', 0.004);

// The bones whose flesh has to survive, and the floor for each. Not one shared
// number: a flipper prong and a skull are different amounts of geometry, and a
// single threshold would either pass a gutted flipper or fail an intact one.
//
// Floors are set at roughly a third of what each bone starts with, which is
// what `--ratio 0.5` should cost a region that decimates EVENLY. A region that
// comes back far under its share has been singled out by the error metric, and
// that is the case worth failing on.
const MUST_SURVIVE = [
  { bone: 'Bone021_6', floor: 900, what: 'lower jaw — the 62-degree bite' },
  { bone: 'Bone004_7', floor: 1800, what: 'skull' },
  { bone: 'Bone017_14', floor: 120, what: 'tail tip / fluke' },
  { bone: 'Bone016_15', floor: 120, what: 'fluke root' },
  { bone: 'Bone026_37', floor: 60, what: 'front flipper L, tip' },
  { bone: 'Bone035_41', floor: 60, what: 'front flipper R, tip' },
  { bone: 'Bone031_22', floor: 60, what: 'hind flipper L, tip' },
  { bone: 'Bone039_26', floor: 60, what: 'hind flipper R, tip' },
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

/** How many vertices each watched bone dominates. Run before and after. */
function fleshCounts() {
  const skin = doc.getRoot().listSkins()[0];
  if (!skin) return new Map();
  const joints = skin.listJoints();
  const wanted = new Map();
  for (const { bone } of MUST_SURVIVE) {
    const i = joints.findIndex((j) => j.getName() === bone);
    if (i < 0) console.warn(`  [warn] ${bone} is not a joint of this skin`);
    else wanted.set(i, bone);
  }
  const counts = new Map(MUST_SURVIVE.map((m) => [m.bone, 0]));
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

/** Total keyframes across every animation — what `resample` is measured on. */
const keyCount = () => doc.getRoot().listAnimations()
  .flatMap((a) => a.listSamplers())
  .reduce((n, s) => n + (s.getInput()?.getCount() ?? 0), 0);

const s0 = stats();
const flesh0 = fleshCounts();
const keys0 = keyCount();
console.log(`\n${basename(SRC)}`);
console.log(`  ${(before / 1048576).toFixed(2)} MB  ${s0.tris.toLocaleString()} tris  ${s0.verts.toLocaleString()} verts  `
  + `${doc.getRoot().listSkins()[0]?.listJoints().length ?? 0} bones  ${keys0.toLocaleString()} keys`);

await doc.transform(
  dedup(),
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio: RATIO, error: ERROR }),
  // Rotation only gets a real tolerance; position and scale are held constant by
  // this rig, so anything above zero collapses each of those tracks to a single
  // key rather than approximating a curve that was never there.
  resample({ tolerance: 1e-4 }),
  prune(),
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
const flesh1 = fleshCounts();
const keys1 = keyCount();

console.log(`\n${basename(OUT)}`);
console.log(`  ${(after / 1048576).toFixed(2)} MB  ${s1.tris.toLocaleString()} tris  ${s1.verts.toLocaleString()} verts  ${keys1.toLocaleString()} keys`);
console.log(`  -> ${((1 - after / before) * 100).toFixed(0)}% smaller, ${((1 - s1.tris / s0.tris) * 100).toFixed(0)}% fewer triangles, `
  + `${((1 - keys1 / keys0) * 100).toFixed(0)}% fewer keyframes`);

console.log(`\nWHAT HAD TO SURVIVE`);
let lost = 0;
for (const { bone, floor, what } of MUST_SURVIVE) {
  const a = flesh0.get(bone) ?? 0;
  const b = flesh1.get(bone) ?? 0;
  const ok = b >= floor;
  if (!ok) lost++;
  console.log(`  ${ok ? 'ok  ' : 'LOST'}  ${bone.padEnd(12)} ${String(a).padStart(5)} -> ${String(b).padStart(5)} verts `
    + `(floor ${floor})   ${what}`);
}
if (lost) {
  console.error(`\n${lost} region(s) decimated past their floor. Raise --ratio and re-run.\n`);
  process.exit(1);
}
console.log(`\nevery watched region intact. Re-measure the takes with:`);
console.log(`  node --import ./tools/vite-loader.mjs tools/clip-takes.mjs ${OUT} --max=90\n`);
