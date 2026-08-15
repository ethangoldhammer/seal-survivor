#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Cuts ONE animal out of Orca_Family_opt.glb and writes it as a standalone,
// game-ready orca — the candidate replacement for public/models/orca.glb.
//
// WHY THIS EXISTS. The orca the game ships is a 968-vertex body on a rig that
// was built for a quadruped: its pectoral flippers are driven by bones called
// `Thigh_F01_L` -> `Foot_F02_L` -> `Foot_F03_L` -> `Foot_F04_L`, hanging off a
// `hip_01`. assets.js already says so — the fin chains in `enemyOrca.rig` were
// identified by measuring world positions because the names are junk. That is
// a rigging problem, and no amount of clip tuning fixes it.
//
// The source file is three orcas in one scene — a male, a female and a calf,
// each with its own skeleton and its own tracks inside a single shared take —
// plus three baked DirectionalLights. None of that can ship. This takes one
// animal, its bones, its share of the animation and nothing else.
//
// WHAT IT DOES NOT DO. It does not re-author the clip. `Take 001` is 1.93
// seconds of swim cycle and that is the only motion in the file, so the output
// has one clip where the shipped orca has three (idle / swim / rushbeach). Any
// swap has to decide what `idle` and `boost` become — see the notes printed at
// the end of a run.
//
//   node --import ./tools/vite-loader.mjs tools/orca-split.mjs [male|female|calf] [--out path]
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
// The GLB parse decodes embedded textures through createImageBitmap; without a
// stub the promise never settles and the script exits silently. Nothing here
// reads a pixel.
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
// And the binary EXPORT packs its buffer through a Blob and a FileReader,
// neither of which Node has. Both shims touch nothing but the bytes.
class NodeFileReader {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buf) => { this.result = buf; this.onloadend?.(); });
  }
}
globalThis.FileReader = NodeFileReader;

import * as THREE from 'three';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// THE UNWELDED SOURCE, and not the one called `_opt`. The two files hold the
// SAME mesh — 11,238 triangles per animal, identical silhouette — and differ
// only in how the vertices are shared:
//
//   Orca_Family_opt.glb   6,994 verts, welded, NO UV attribute
//   Orca_Family_GLB.glb  33,714 verts, unwelded, uv present
//
// `_opt` is the obvious pick on size and it is the wrong one twice over. It
// has no texture coordinates at all, so the orca_male / orca_female diffuse and
// emissive maps sitting next to it in the same folder cannot be applied to it —
// a detail invisible until somebody tries. And the wireframe-driven emissive
// needs per-triangle vertices anyway, so the welding it paid for would have to
// be undone. Unwelded costs vertex memory and nothing on the triangle count,
// which is what actually draws.
const DEFAULT_SRC = `${process.env.HOME}/Documents/_DesignSystems/SealSurvivor/Orca_Family_GLB.glb`;
const srcArg = process.argv.indexOf('--src');
const SRC = srcArg > -1 ? resolve(process.argv[srcArg + 1]) : DEFAULT_SRC;

const WHICH = (process.argv[2] ?? 'male').toLowerCase();
const ANIMALS = {
  male: { node: 'Orca_Male_World', mesh: 'Orca_Male', suffix: '' },
  female: { node: 'Orca_Female_World', mesh: 'Orca_Female', suffix: '_ncl1_1' },
  calf: { node: 'Orca_Calf_World', mesh: 'Orca_Calf', suffix: '_ncl1_2' },
};
const pick = ANIMALS[WHICH];
if (!pick) {
  console.error(`unknown animal "${WHICH}" — one of ${Object.keys(ANIMALS).join(', ')}`);
  process.exit(1);
}
const outArg = process.argv.indexOf('--out');
const OUT = outArg > -1
  ? resolve(process.argv[outArg + 1])
  : resolve(HERE, `../.orca-${WHICH}.glb`);

const buf = readFileSync(SRC);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
);
gltf.scene.updateMatrixWorld(true);

// --- the animal ------------------------------------------------------------
// Taken as the whole `*_World` subtree, which is what holds BOTH halves: the
// `*_SRT` node carrying the bone root and the `GEO` group carrying the mesh.
// Lifting the SkinnedMesh alone would take the flesh and leave the skeleton.
let world = null;
gltf.scene.traverse((o) => { if (o.name === pick.node) world = o; });
if (!world) {
  console.error(`"${pick.node}" is not in ${SRC} — the source file changed shape.`);
  process.exit(1);
}

// Reparented rather than cloned. SkeletonUtils.clone is the usual way to copy a
// skinned hierarchy, and it is unnecessary here: this process exports once and
// exits, so the original scene has no further claim on these nodes, and moving
// them keeps every Skeleton and every bone reference exactly as the loader
// built it. A clone is one more place for a bind matrix to be lost.
const out = new THREE.Scene();
out.name = `Orca_${WHICH}`;
world.position.set(0, 0, 0);
world.quaternion.identity();
world.scale.set(1, 1, 1);
out.add(world);

// The source ships three baked DirectionalLights. A model that carries its own
// lighting fights the scene it is dropped into.
const strays = [];
out.traverse((o) => { if (o.isLight) strays.push(o); });
for (const s of strays) s.parent?.remove(s);

// --- the skeleton ----------------------------------------------------------
// EVERY MESH IN THIS FILE IS BOUND TO ALL 152 BONES — the male's, the female's
// and the calf's — even though only 46 to 48 of them drive any of its flesh.
// That is legal and normal for a scene exported as one take, and it is fatal to
// a split: the exported GLB writes a skin whose joint list points at a hundred
// nodes that are no longer in the file, and GLTFLoader dies on the way back in
// with `Cannot set properties of undefined (setting 'isBone')`. It does not
// warn on the way out. The first version of this tool wrote three 480KB files
// that were all unloadable, and every number about them looked right.
//
// So the skeleton is rebuilt to just this animal's bones and the geometry's
// joint indices are remapped to match. Weights are checked, not assumed: a
// vertex genuinely pulled by a dropped bone would be a bad split, and this
// reports the worst one it finds rather than quietly zeroing it.
{
  const mine = new Set();
  out.traverse((o) => { if (o.isBone) mine.add(o); });

  let worstOrphanWeight = 0;
  const rebound = [];
  out.traverse((o) => { if (o.isSkinnedMesh) rebound.push(o); });

  for (const mesh of rebound) {
    const old = mesh.skeleton;
    const keep = [];
    const inverses = [];
    const remap = new Int32Array(old.bones.length).fill(-1);
    for (let i = 0; i < old.bones.length; i++) {
      if (!mine.has(old.bones[i])) continue;
      remap[i] = keep.length;
      keep.push(old.bones[i]);
      inverses.push(old.boneInverses[i].clone());
    }

    const si = mesh.geometry.attributes.skinIndex;
    const sw = mesh.geometry.attributes.skinWeight;
    const comps = ['X', 'Y', 'Z', 'W'];
    for (let v = 0; v < si.count; v++) {
      for (const c of comps) {
        const b = si[`get${c}`](v);
        const w = sw[`get${c}`](v);
        const to = remap[b] ?? -1;
        if (to >= 0) { si[`set${c}`](v, to); continue; }
        // Bound to a bone that belongs to another animal. Expected to carry no
        // weight; if it ever does, the split took the wrong subtree.
        if (w > worstOrphanWeight) worstOrphanWeight = w;
        si[`set${c}`](v, 0);
        sw[`set${c}`](v, 0);
      }
    }
    si.needsUpdate = true;
    sw.needsUpdate = true;

    // Rebound with the ORIGINAL bindMatrix. Letting bind() default it to the
    // mesh's current world matrix would re-bind the flesh to wherever the body
    // happens to be standing, which moves the skin off the bones.
    mesh.bind(new THREE.Skeleton(keep, inverses), mesh.bindMatrix.clone());
    console.log(`skeleton "${mesh.name}": ${old.bones.length} bones -> ${keep.length}`);
  }

  if (worstOrphanWeight > 1e-4) {
    console.error(`\nREFUSING: vertices carry up to ${worstOrphanWeight.toFixed(4)} weight on bones outside "${pick.node}".`);
    console.error('That is another animal pulling on this one — the split is wrong, not the file.\n');
    process.exit(1);
  }
}

// --- welding ---------------------------------------------------------------
// The source is fully unwelded — one vertex per triangle corner, 33,714 of them
// for 11,238 triangles — which is what a 4.4MB file per animal buys you and
// nothing at all on the triangle count, the number that actually draws.
//
// mergeVertices collapses only vertices identical in EVERY attribute, so the
// UV seams and hard normals that needed splitting stay split. That is the whole
// difference between this and the `_opt` file, which welded on position alone
// and lost the texture coordinates.
//
// The wireframe-driven emissive still wants per-triangle vertices, and it gets
// them at load with toNonIndexed() — a transform that costs nothing on disk and
// only applies to the bodies actually wearing that skin.
{
  const welds = [];
  out.traverse((o) => { if (o.isMesh) welds.push(o); });
  for (const mesh of welds) {
    const before = mesh.geometry.attributes.position.count;
    const merged = mergeVertices(mesh.geometry);
    // Refuse a weld that lost triangles — that is geometry going missing, not
    // vertices being shared.
    const triBefore = (mesh.geometry.index ? mesh.geometry.index.count : before) / 3;
    const triAfter = (merged.index ? merged.index.count : merged.attributes.position.count) / 3;
    if (triAfter !== triBefore) {
      console.error(`REFUSING: weld changed the triangle count on "${mesh.name}" (${triBefore} -> ${triAfter}).`);
      process.exit(1);
    }
    mesh.geometry.dispose();
    mesh.geometry = merged;
    console.log(`weld "${mesh.name}": ${before} verts -> ${merged.attributes.position.count}, ${triAfter} triangles either way`);
  }
}

// --- the animation ---------------------------------------------------------
// One take animates all three animals at once; each animal's nodes carry a
// suffix (`_ncl1_1` for the female, `_ncl1_2` for the calf, none for the male).
// Keeping the whole clip would drive bones that are no longer here — harmless
// but for the fact that three.js binds tracks by name and silently drops the
// misses, which is exactly the failure mode that hides a wrong split.
//
// So the tracks are filtered by whether their target node actually survived,
// which is the honest test and needs no knowledge of the suffix scheme at all.
const present = new Set();
out.traverse((o) => { if (o.name) present.add(o.name); });

const clips = [];
for (const clip of gltf.animations) {
  const kept = clip.tracks.filter((t) => present.has(t.name.split('.')[0]));
  if (kept.length === 0) continue;
  // Renamed to what the game asks assets.js for. The source name is `Take 001`,
  // which says nothing, and the motion in it is a swim cycle.
  clips.push(new THREE.AnimationClip('swim', clip.duration, kept));
  console.log(`clip "${clip.name}" -> "swim": kept ${kept.length} of ${clip.tracks.length} tracks (${clip.duration.toFixed(2)}s)`);
}

// --- the names -------------------------------------------------------------
// AFTER THE TRACK FILTER, NEVER BEFORE. The filter tells the three animals'
// tracks apart BY the suffix (a track is kept when its target node survived the
// split), so renaming first makes all 126 tracks look like they belong to
// whichever animal is being cut — every body then comes out carrying three
// conflicting animations layered on the same bones. The first run of this did
// exactly that and reported "kept 126 of 126", which is the tell.
//
// THREE COPIES OF ONE RIG IN ONE FILE means two of them had to be renamed to
// keep the names unique: the female's bones are `Spine8_ncl1_1`, the calf's are
// `Spine8_ncl1_2`, and only the male's are plain. That is an artefact of the
// packing, not a fact about the animals — they are the same skeleton.
//
// Stripped here, so all three come out with identical bone names and can share
// one rig block in assets.js. Left in, the shared chains resolve on the bull
// and silently miss on the cow: same boss, same fight, and its fins and tail
// stop trailing on half the arrivals. tools/apex-spring-test.mjs is what
// caught it, by checking both bodies rather than assuming one stood in for
// the other.
//
// The animation tracks are renamed to match in the same pass — they target
// nodes BY NAME, and renaming the bones alone would leave every track pointing
// at something that no longer exists, which three drops silently.
const SUFFIX = /_ncl1_\d+$/;
{
  let renamed = 0;
  out.traverse((o) => {
    if (o.name && SUFFIX.test(o.name)) { o.name = o.name.replace(SUFFIX, ''); renamed += 1; }
  });
  for (const clip of clips) {
    for (const t of clip.tracks) {
      const [node, ...rest] = t.name.split('.');
      if (SUFFIX.test(node)) t.name = [node.replace(SUFFIX, ''), ...rest].join('.');
    }
  }
  if (renamed) console.log(`names: stripped the packing suffix from ${renamed} node(s)`);
}


// --- report ----------------------------------------------------------------
out.updateMatrixWorld(true);
const mesh = (() => { let m = null; out.traverse((o) => { if (o.isSkinnedMesh) m ??= o; }); return m; })();
const bones = [];
out.traverse((o) => { if (o.isBone) bones.push(o); });
const box = new THREE.Box3().setFromObject(out);
const size = box.getSize(new THREE.Vector3());
const dims = [['x', size.x], ['y', size.y], ['z', size.z]].sort((a, b) => b[1] - a[1]);

console.log(`\n${pick.mesh}`);
console.log(`  ${mesh?.geometry.attributes.position.count} verts, ${bones.length} bones`);
console.log(`  bind box ${dims.map(([a, v]) => `${a} ${v.toFixed(1)}`).join('  ')}`);
console.log(`  long axis is ${dims[0][0].toUpperCase()}, long:next ${(dims[0][1] / dims[1][1]).toFixed(2)} : 1`);

// --- write -----------------------------------------------------------------
const glb = await new GLTFExporter().parseAsync(out, {
  binary: true,
  animations: clips,
  // The bind pose is the thing being preserved; letting the exporter bake a
  // world transform into it would move the flesh off the bones.
  onlyVisible: false,
});
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(glb));
console.log(`\nwrote ${OUT}  (${(glb.byteLength / 1024).toFixed(0)} KB)`);
