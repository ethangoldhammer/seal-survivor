// Turns the Cinema 4D bowhead export into public/models/whale.glb.
//
//   node tools/build-whale.mjs [source.glb] [out.glb]
//
// The source is Bowhead_Whale_2009-3.glb, re-exported by hand from
// Bowhead_Whale_2009-3.c4d. That re-export was necessary because the .fbx that
// shipped with the pack is **FileVersion 6100** (2009), which three.js's
// FBXLoader and Blender 5.0 both refuse outright — "must be 7100 or later".
// Nothing in this repo can open it, so the .fbx is not the source of truth for
// anything and should not be pointed at.
//
// WHAT THE RE-EXPORT ACTUALLY CARRIES, all of it measured rather than assumed:
//
//   28 joints, one skin, 2812 triangles, 8436 vertices (fully unwelded — three
//   per triangle), one white MeshStandardMaterial with no maps, three morph
//   targets, two directional lights, and one animation clip.
//
// THE CLIP IS EMPTY, and this is the single most important fact about the
// asset. "Take 001" is 0.033s long with three tracks, of which exactly one has
// any range at all: `Bowhead_Whale1.quaternion`, two keys — the FBX root's
// axis-conversion, not animation. Posing the skin across the clip's whole
// duration moves every sampled vertex by 0.00 units. It is not a swim cycle
// that failed to export; the source file never had one. The original .fbx says
// the same thing in its own format: its entire Take 001 is
// `Channel: "Visibility", KeyCount 1`.
//
// So the clip is DROPPED here rather than shipped. Left in, it is a named clip
// of the right shape for systems/animation.js to bind as a locomotion state,
// and binding it would suppress the procedural wag fallback that is the only
// thing actually moving this animal — a whale gliding through the arena rigid
// as a lamppost, with no error anywhere. See ASSETS.whale.rig in assets.js for
// the chain that drives it instead.
//
// THE MORPH TARGETS ARE UNNAMED. glTF carries target names in a mesh `extras`
// that the C4D exporter did not write, so they arrive as 0/1/2 and
// morphTargetDictionary comes out empty — meaning `mesh.morphTargetInfluences`
// can only be reached by index, and an index is exactly the kind of thing that
// silently shifts on the next re-export. They are named here, and NOT by
// trusting their order: each target is identified by MEASURING how far it
// pushes vertices and where that motion is centred, then checked against the
// table below. A re-export that reorders them fails this script instead of
// quietly swapping the whale's blowhole for its jaw.
//
// THE LIGHTS ARE STRIPPED. Two DirectionalLights are parented into the scene
// graph, and createVisual() adds whatever it loads to the world — so every
// whale that swam through would permanently brighten the arena, and the effect
// would accumulate across a run rather than reading as one obvious bug.
//
// Source art is never written to: this reads from _DesignSystems and writes
// only to public/models, so re-running it after a new export is the whole
// update.

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune } from '@gltf-transform/functions';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const SRC = args[0]
  ? resolve(process.cwd(), args[0])
  : '/Users/ethangoldhammer/Documents/_DesignSystems/SealSurvivor/Bowhead_Whale_2009-3.glb';
const OUT = args[1]
  ? resolve(process.cwd(), args[1])
  : resolve(HERE, '../public/models/whale.glb');

// The three shape targets, identified by what they DO to the mesh.
//
// `maxDelta` is the furthest any single vertex travels, in source units, on a
// body 180.4 units long. `centre` is the delta-weighted centroid of the moved
// vertices — i.e. where on the animal the motion lives. Both were measured off
// the sibling OBJ set (T_Blowhole.obj, T_MouthOpen_Narrow.obj,
// T_MouthOpen_Wide.obj) and independently off this .glb; they agree to two
// decimal places, which is what makes them safe to match on.
//
// The three are far enough apart on both numbers that a mismatch means the
// export changed, not that the tolerance is tight: 1.12 vs 17.49 vs 25.12 on
// travel, and z=45 vs z=66 on position.
const TARGETS = [
  { name: 'blowhole', maxDelta: 1.12, centre: [0, 29.0, 45.2], what: 'the spout bump on top of the head' },
  { name: 'mouthNarrow', maxDelta: 17.49, centre: [0, 9.4, 65.9], what: 'jaw part-open — the cruising gape' },
  { name: 'mouthWide', maxDelta: 25.12, centre: [0, 9.4, 66.7], what: 'jaw fully open — the feeding gape' },
];
// Generous on purpose. These are identity checks between three targets that
// differ by more than an order of magnitude, not a regression test on the
// exporter's float precision.
const DELTA_TOL = 0.5;
const CENTRE_TOL = 4;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(SRC);
const root = doc.getRoot();
const before = statSync(SRC).size;

const fail = (msg) => { console.error(`\n  [FAIL] ${msg}\n`); process.exit(1); };

// --- 1. the empty clip -----------------------------------------------------
const clips = root.listAnimations();
console.log(`\nCLIPS IN SOURCE: ${clips.length}`);
for (const anim of clips) {
  // Duration and per-channel range, so the log says WHY it is being dropped
  // rather than just that it was.
  let maxRange = 0;
  let duration = 0;
  for (const ch of anim.listChannels()) {
    const s = ch.getSampler();
    const times = s?.getInput()?.getArray();
    const vals = s?.getOutput()?.getArray();
    if (times?.length) duration = Math.max(duration, times[times.length - 1]);
    if (vals?.length) maxRange = Math.max(maxRange, Math.max(...vals) - Math.min(...vals));
  }
  console.log(`  "${anim.getName()}" ${duration.toFixed(3)}s, ${anim.listChannels().length} channels, widest value range ${maxRange.toFixed(3)}`);
  anim.dispose();
  console.log('    -> dropped (moves no skinned vertex; see the note at the top of this file)');
}

// --- 2. the lights ---------------------------------------------------------
// Lights ride in KHR_lights_punctual, so they are extension properties on the
// node rather than nodes in their own right. Drop the node when it carries a
// light and nothing else, so an export that later parents something useful
// under one is not silently thrown away with it.
let lightsRemoved = 0;
for (const node of root.listNodes()) {
  const ext = node.getExtension('KHR_lights_punctual');
  if (!ext) continue;
  if (node.listChildren().length || node.getMesh()) {
    console.warn(`  [warn] "${node.getName()}" carries a light AND content — unlinking the light only.`);
    node.setExtension('KHR_lights_punctual', null);
  } else {
    node.dispose();
  }
  lightsRemoved++;
}
// Belt and braces: the exporter may also have written them as plain named
// nodes with no light extension at all, which is what this source does.
for (const node of root.listNodes()) {
  if (!/^directionalLight/i.test(node.getName())) continue;
  if (node.listChildren().length || node.getMesh()) continue;
  node.dispose();
  lightsRemoved++;
}
console.log(`\nLIGHTS REMOVED: ${lightsRemoved}`);
if (lightsRemoved === 0) console.warn('  [warn] none found — the source used to ship two. Check the export.');

// --- 3. name the morph targets ---------------------------------------------
const meshes = root.listMeshes();
if (meshes.length !== 1) fail(`expected exactly 1 mesh, found ${meshes.length}: ${meshes.map((m) => m.getName()).join(', ')}`);
const prim = meshes[0].listPrimitives()[0];
const targets = prim.listTargets();
console.log(`\nMORPH TARGETS: ${targets.length}`);
if (targets.length !== TARGETS.length) {
  fail(`expected ${TARGETS.length} morph targets, found ${targets.length}. The C4D export changed — re-measure before editing TARGETS.`);
}

const basePos = prim.getAttribute('POSITION').getArray();
const measured = targets.map((t) => {
  // Targets are stored as deltas from the base position, so the array IS the
  // displacement — no subtraction needed, unlike the OBJ set it came from.
  const d = t.getAttribute('POSITION').getArray();
  let maxDelta = 0;
  let moved = 0;
  let wsum = 0;
  const c = [0, 0, 0];
  for (let v = 0; v < d.length / 3; v++) {
    const len = Math.hypot(d[v * 3], d[v * 3 + 1], d[v * 3 + 2]);
    if (len > 1e-3) {
      moved++;
      wsum += len;
      for (let k = 0; k < 3; k++) c[k] += basePos[v * 3 + k] * len;
    }
    if (len > maxDelta) maxDelta = len;
  }
  return { maxDelta, moved, centre: wsum ? c.map((n) => n / wsum) : [0, 0, 0] };
});

// Match by measurement, not by index. Each expected target claims the measured
// one it fits; a target that fits none, or two that fit the same one, is a
// changed export and stops the build.
const claimed = new Map();
for (const want of TARGETS) {
  const hits = measured
    .map((m, i) => ({ m, i }))
    .filter(({ m, i }) => !claimed.has(i)
      && Math.abs(m.maxDelta - want.maxDelta) <= DELTA_TOL
      && Math.hypot(...m.centre.map((n, k) => n - want.centre[k])) <= CENTRE_TOL);
  if (hits.length === 0) {
    console.error('\n  measured targets:');
    measured.forEach((m, i) => console.error(`    [${i}] maxDelta=${m.maxDelta.toFixed(2)} moved=${m.moved} centre=[${m.centre.map((n) => n.toFixed(1)).join(', ')}]`));
    fail(`no morph target matches "${want.name}" (expected maxDelta ~${want.maxDelta}, centre ~[${want.centre.join(', ')}]).`);
  }
  if (hits.length > 1) fail(`"${want.name}" matches ${hits.length} morph targets — the tolerances no longer separate them.`);
  const { m, i } = hits[0];
  claimed.set(i, want.name);
  targets[i].setName(want.name);
  console.log(`  [${i}] -> "${want.name}"  maxDelta=${m.maxDelta.toFixed(2)} (${(m.maxDelta / 180.4 * 100).toFixed(1)}% of body) moved=${m.moved} verts  — ${want.what}`);
}

// glTF reads target names from the MESH's extras, not the target objects, and
// three.js builds morphTargetDictionary from exactly that. Setting the names
// above is not enough on its own; this is the half that reaches the runtime.
meshes[0].setExtras({ ...meshes[0].getExtras(), targetNames: targets.map((t) => t.getName()) });

// --- 4. tidy ---------------------------------------------------------------
// dedup merges identical accessors; prune drops anything now unreferenced —
// including the material slots and accessors the dropped clip and lights held.
// Deliberately NOT weld/simplify/quantize: 2812 triangles is a fifth of the
// squid's budget already, and welding a mesh that carries both skin weights
// and morph deltas risks the seams for a saving this model does not need.
await doc.transform(dedup(), prune());

const skin = root.listSkins()[0];
if (!skin) fail('no skin survived — the whale would render in bind pose with no wag.');
console.log(`\nSKIN: ${skin.listJoints().length} joints`);
const idx = prim.getIndices();
console.log(`MESH: ${(idx ? idx.getCount() : prim.getAttribute('POSITION').getCount()) / 3} triangles, ${prim.getAttribute('POSITION').getCount()} verts`);
console.log(`CLIPS OUT: ${root.listAnimations().length}`);

await io.write(OUT, doc);
const after = statSync(OUT).size;
console.log(`\nWROTE ${OUT}`);
console.log(`  ${(before / 1024).toFixed(0)}KB -> ${(after / 1024).toFixed(0)}KB\n`);
