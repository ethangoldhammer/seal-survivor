// Turns the Sketchfab humpback into public/models/humpback.glb.
//
//   node tools/build-humpback.mjs [source.glb] [out.glb]
//   npm run humpback
//
// The source is humpback_whale_-_animated_-_marine_mammals.glb in
// _DesignSystems/SealSurvivor — a Sketchfab rip of a low-poly humpback with a
// full clip vocabulary. Everything below was MEASURED off the file (see the
// scratch script that produced these numbers, folded into the checks at the
// bottom), not read off the node names.
//
// WHAT THE SOURCE CARRIES:
//
//   32 nodes, 25 joints, TWO meshes on one skin, one PNG, 12 clips.
//
//   The animal is 17.8 source units nose to fluke along +Z (head +Z, dorsal +Y,
//   pectorals along ±X — the same frame as the bowhead), 14.3 wide across the
//   pectorals and 3.4 deep. 1,244 vertices.
//
// FOUR THINGS ARE CHANGED, and each one would be a visible bug if it shipped:
//
//   1. THE WATER SURFACE IS DROPPED. The second mesh is a 4-vertex quad
//      ("HumpbackWhale.004_1") skinned to a `WaterSurface` joint that hangs
//      5.3 units ABOVE the body, wearing a 20%-alpha blue material. It is the
//      Sketchfab preview's water line. systems/whale.js MEASURES the body it
//      builds — length, nose distance, shove capsule, despawn margin all come
//      off the bounding box — so a quad floating over the animal would make
//      every one of those numbers wrong by a third and nothing would throw.
//
//   2. THE TEXTURE IS DROPPED, ON PURPOSE. The one material is
//      KHR_materials_unlit with a 31 KB gradient PNG. Both go: the body is
//      painted procedurally instead (`biolum:humpbackWhale` in assets.csv,
//      pigment 1 — see ASSETS.humpbackWhale), which needs a LIT material to
//      shade and band, so the unlit extension is removed and the material is
//      left as a plain white MeshStandard for assets.js to tint and dress.
//      UVs are kept (prune's keepAttributes) so the texture panel's override
//      slot still works; they cost nothing at this vertex count.
//
//   3. THE CLIPS ARE CUT TO THE TWO THE GAME CAN USE. Twelve clips are
//      authored; the sweep plays "EAT-delphinidae" (0.875s: the jaw opens 67°,
//      the throat pouch — `jaw.001`, 7.2 units of translation — balloons, and
//      the whole spine undulates 10-25° a bone) as its locomotion loop, slowed
//      by CONFIG.whale.clipSpeed. "SWIM-delphinidae" is kept as the obvious
//      alternative; the other ten (death, hurt, jump, turn...) are dead weight
//      on an animal that is never hit, never dies and never turns.
//
//   4. THE NODE NAMES ARE CLEANED. Every joint is suffixed "_Armature-
//      whale.004" and the paired bones carry Blender's dotted suffixes
//      ("tail05.L", "jaw.001"). GLTFLoader strips every '.' when it loads
//      (PropertyBinding.sanitizeNodeName), so the name in the file is NOT the
//      name getObjectByName sees — "tail05.L_Armature-whale.004" arrives as
//      "tail05L_Armature-whale004". Renaming here means the names in
//      assets.js are the names in the file are the names at runtime, with no
//      third spelling in between.
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
  : '/Users/ethangoldhammer/Documents/_DesignSystems/SealSurvivor/humpback_whale_-_animated_-_marine_mammals.glb';
const OUT = args[1]
  ? resolve(process.cwd(), args[1])
  : resolve(HERE, '../public/models/humpback.glb');

// The clips that ship. Matched on the prefix before the "-delphinidae" the
// pack stamps on every clip name; the full name is what assets.js maps.
const KEEP_CLIPS = ['EAT-delphinidae', 'SWIM-delphinidae'];
// The joint whose whole job is to hold the preview's water quad.
const WATER_JOINT = 'WaterSurface';
// The exporter's per-armature suffix on every node.
const SUFFIX_RE = /_Armature-whale\.004$/;

const fail = (msg) => { console.error(`\n  [FAIL] ${msg}\n`); process.exit(1); };

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(SRC);
const root = doc.getRoot();
const before = statSync(SRC).size;

// --- 1. the water surface --------------------------------------------------
// Identified by what it IS, not by its index: the primitive with four vertices
// and a blended material. A re-export that reorders the meshes still finds it,
// and one that has already lost it fails loudly rather than deleting the whale.
let waterMeshes = 0;
for (const mesh of root.listMeshes()) {
  const prims = mesh.listPrimitives();
  const tiny = prims.every((p) => (p.getAttribute('POSITION')?.getCount() ?? 0) <= 8);
  if (!tiny) continue;
  const mat = prims[0]?.getMaterial();
  console.log(`\nWATER SURFACE: mesh "${mesh.getName()}" — ${prims[0]?.getAttribute('POSITION')?.getCount()} vertices,`
    + ` material "${mat?.getName()}" alpha ${mat?.getAlphaMode()} → dropped`);
  for (const node of root.listNodes()) if (node.getMesh() === mesh) node.dispose();
  mesh.dispose();
  waterMeshes++;
}
if (waterMeshes !== 1) fail(`expected exactly one water-surface quad, found ${waterMeshes}`);
// Its joint is a leaf under the root joint with nothing skinned to it once the
// quad is gone; the skin still lists it, and dropping a joint out of a skin
// renumbers JOINTS_0 for every vertex, so it stays — a joint that drives
// nothing costs one matrix.
const water = root.listNodes().find((n) => n.getName().startsWith(WATER_JOINT));
if (!water) console.warn(`  [warn] no "${WATER_JOINT}" joint — the source used to carry one`);

const meshes = root.listMeshes();
if (meshes.length !== 1) fail(`expected exactly 1 mesh after the drop, found ${meshes.length}: ${meshes.map((m) => m.getName()).join(', ')}`);

// --- 2. the texture and the unlit flag -------------------------------------
console.log('\nMATERIALS:');
for (const mat of root.listMaterials()) {
  const tex = mat.getBaseColorTexture();
  const unlit = !!mat.getExtension('KHR_materials_unlit');
  console.log(`  "${mat.getName()}" — ${tex ? `baseColorTexture ${tex.getSize()?.join('x')} ${tex.getMimeType()}` : 'no map'}, ${unlit ? 'KHR_materials_unlit' : 'lit'}`);
  mat.setBaseColorTexture(null);
  mat.setBaseColorFactor([1, 1, 1, 1]);
  mat.setExtension('KHR_materials_unlit', null);
  mat.setMetallicFactor(0);
  mat.setRoughnessFactor(0.72);
  mat.setDoubleSided(false);
  mat.setAlphaMode('OPAQUE');
  mat.setName('humpbackHide');
  console.log('    → white, lit, opaque, no map — the biolum pigment paints it (assets.csv surface column)');
}
for (const tex of root.listTextures()) tex.dispose();

// --- 3. the clips ----------------------------------------------------------
console.log('\nCLIPS:');
let kept = 0;
for (const anim of root.listAnimations()) {
  let duration = 0;
  for (const ch of anim.listChannels()) {
    const times = ch.getSampler()?.getInput()?.getArray();
    if (times?.length) duration = Math.max(duration, times[times.length - 1]);
  }
  const keep = KEEP_CLIPS.includes(anim.getName());
  console.log(`  ${keep ? 'keep' : 'drop'} "${anim.getName()}" ${duration.toFixed(3)}s, ${anim.listChannels().length} channels`);
  if (keep) { kept++; continue; }
  // Channels and samplers are root-owned properties, not children of the clip:
  // disposing the animation alone leaves 700-odd orphaned samplers whose
  // accessors prune() then keeps as "referenced". Measured: 927 accessors and
  // 340 KB with the one-line dispose, against ~170 and far less with this.
  for (const ch of anim.listChannels()) ch.dispose();
  for (const smp of anim.listSamplers()) smp.dispose();
  anim.dispose();
}
if (kept !== KEEP_CLIPS.length) fail(`expected to keep ${KEEP_CLIPS.join(', ')}, kept ${kept}`);

// --- 4. the names ----------------------------------------------------------
// Strip the armature suffix and turn Blender's ".L"/".001" into "_L"/"_001",
// which survives GLTFLoader's sanitizer unchanged. Checked for collisions,
// because two nodes landing on one name is exactly the silent failure
// getObjectByName is built to produce.
const seen = new Map();
for (const node of root.listNodes()) {
  const was = node.getName();
  let name = was.replace(SUFFIX_RE, '').replace(/\./g, '_');
  if (seen.has(name) && seen.get(name) !== was) fail(`name collision: "${was}" and "${seen.get(name)}" both become "${name}"`);
  seen.set(name, was);
  node.setName(name);
}
console.log(`\nNAMES: ${seen.size} nodes renamed, e.g. ${[...seen.entries()].filter(([a, b]) => a !== b).slice(0, 4).map(([a, b]) => `"${b}" → "${a}"`).join(', ')}`);

// --- 5. tidy and write -----------------------------------------------------
// keepAttributes: prune would otherwise delete TEXCOORD_0 the moment the map
// is gone, and the texture panel's override slot needs it.
await doc.transform(dedup(), prune({ keepAttributes: true, keepLeaves: true }));
await io.write(OUT, doc);
const after = statSync(OUT).size;

// --- 6. read it back -------------------------------------------------------
const back = (await io.read(OUT)).getRoot();
const names = new Set(back.listNodes().map((n) => n.getName()));
const checks = [
  ['one mesh', back.listMeshes().length === 1],
  ['no textures', back.listTextures().length === 0],
  ['no images', back.listTextures().length === 0 && !back.listTextures().some((t) => t.getImage())],
  ['one lit material', back.listMaterials().length === 1 && !back.listMaterials()[0].getExtension('KHR_materials_unlit')],
  [`clips: ${KEEP_CLIPS.join(', ')}`, KEEP_CLIPS.every((c) => back.listAnimations().some((a) => a.getName() === c))],
  ['skin survived', back.listSkins().length === 1 && back.listSkins()[0].listJoints().length === 25],
  ['spring bones named', ['tail01', 'tail02', 'tail03', 'tail04', 'tail05', 'tailFin02', 'fin_L', 'finTip_L', 'fin_R', 'finTip_R', 'jaw', 'jaw_001', 'head', 'body'].every((n) => names.has(n))],
  ['no dotted names', [...names].every((n) => !n.includes('.'))],
];
console.log('\nREAD BACK:');
let bad = 0;
for (const [what, ok] of checks) { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++; }
console.log(`\n${SRC}\n  → ${OUT}\n  ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB\n`);
if (bad) process.exit(1);
