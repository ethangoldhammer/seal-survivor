// Inspect the octopus rig: hierarchy, clips, and — the part that matters —
// which vertices each bone actually drives.
//
// Bone names and hierarchy lie. A chain called "Arm_L_01..05" can turn out to
// drive the mantle, and a rig can carry stub bones that move nothing at all.
// The only trustworthy way to identify a chain is to rotate one bone and
// measure which skinned vertices moved and where they are, which is what the
// skinning probe at the bottom does.
import '../tools/dom-stub.mjs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync } from 'node:fs';

const FILE = process.argv[2] ?? '/Users/ethangoldhammer/Documents/_DesignSystems/SealSurvivor/octopus_rig.glb';
const buf = readFileSync(FILE);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
);

const root = gltf.scene;
root.updateMatrixWorld(true);

// --- clips -----------------------------------------------------------------
console.log(`\nCLIPS (${gltf.animations.length})`);
for (const c of gltf.animations) {
  console.log(`  "${c.name}"  ${c.duration.toFixed(2)}s  ${c.tracks.length} tracks`);
}

// --- skinned meshes --------------------------------------------------------
const skins = [];
root.traverse((o) => { if (o.isSkinnedMesh) skins.push(o); });
console.log(`\nSKINNED MESHES (${skins.length})`);
for (const s of skins) {
  console.log(`  ${s.name}  verts=${s.geometry.attributes.position.count}  bones=${s.skeleton.bones.length}`);
}

// --- hierarchy -------------------------------------------------------------
const bones = [];
root.traverse((o) => { if (o.isBone) bones.push(o); });
console.log(`\nBONES (${bones.length})`);

const wp = new THREE.Vector3();
function line(o, depth) {
  o.getWorldPosition(wp);
  const kids = o.children.filter((c) => c.isBone).length;
  console.log(`${'  '.repeat(depth + 1)}${o.name}  [${wp.x.toFixed(2)}, ${wp.y.toFixed(2)}, ${wp.z.toFixed(2)}]${kids === 0 ? '  <TIP>' : ''}`);
  for (const c of o.children) if (c.isBone) line(c, depth + 1);
}
for (const b of bones) {
  if (!b.parent?.isBone) line(b, 0);
}

// --- chains ----------------------------------------------------------------
// A chain is a root-to-tip run. Branch points end a chain and start new ones.
const tips = bones.filter((b) => !b.children.some((c) => c.isBone));
console.log(`\nTIPS (${tips.length}) — one target goes on each of these`);
for (const t of tips) {
  const chain = [];
  let cur = t;
  while (cur?.isBone) { chain.unshift(cur.name); cur = cur.parent; }
  t.getWorldPosition(wp);
  console.log(`  ${t.name}  depth=${chain.length}  world=[${wp.x.toFixed(2)}, ${wp.y.toFixed(2)}, ${wp.z.toFixed(2)}]`);
  console.log(`     ${chain.join(' > ')}`);
}

// --- SKINNING PROBE --------------------------------------------------------
// Rotate each candidate root bone hard, re-skin on the CPU, and report the
// centroid of everything that moved plus how far it moved. This is what tells
// a real arm from a stub: a stub bone moves nothing, and a mislabelled one
// moves a centroid nowhere near where its name claims.
console.log('\nSKINNING PROBE — rotate each bone, measure the vertices it drives');

const skin = skins[0];
if (!skin) {
  console.log('  no skinned mesh — nothing to probe');
} else {
  const pos = skin.geometry.attributes.position;
  const skinIndex = skin.geometry.attributes.skinIndex;
  const skinWeight = skin.geometry.attributes.skinWeight;
  const boneIndexOf = new Map(skin.skeleton.bones.map((b, i) => [b, i]));

  // Total weight each bone carries, and the rest-pose centroid of the
  // vertices it influences. Cheaper and more direct than re-skinning: if a
  // bone carries no weight it drives nothing, full stop.
  const totals = new Float64Array(skin.skeleton.bones.length);
  const cx = new Float64Array(skin.skeleton.bones.length);
  const cy = new Float64Array(skin.skeleton.bones.length);
  const cz = new Float64Array(skin.skeleton.bones.length);

  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(skin.matrixWorld);
    for (let k = 0; k < 4; k++) {
      const bi = skinIndex.getComponent(i, k);
      const w = skinWeight.getComponent(i, k);
      if (w <= 0) continue;
      totals[bi] += w;
      cx[bi] += v.x * w; cy[bi] += v.y * w; cz[bi] += v.z * w;
    }
  }

  const rows = [];
  skin.skeleton.bones.forEach((b, i) => {
    if (totals[i] <= 1e-6) { rows.push({ name: b.name, weight: 0, centroid: null }); return; }
    rows.push({
      name: b.name,
      weight: totals[i],
      centroid: [cx[i] / totals[i], cy[i] / totals[i], cz[i] / totals[i]],
    });
  });

  const dead = rows.filter((r) => r.weight === 0);
  console.log(`  bones driving NO vertices (${dead.length}): ${dead.map((d) => d.name).join(', ') || 'none'}`);
  console.log('  bone influence centroids (world space):');
  for (const r of rows) {
    if (!r.centroid) continue;
    const [x, y, z] = r.centroid;
    console.log(`    ${r.name.padEnd(28)} w=${r.weight.toFixed(1).padStart(8)}  centroid=[${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}]`);
  }
}

// --- extents ---------------------------------------------------------------
const box = new THREE.Box3().setFromObject(root);
const size = new THREE.Vector3();
box.getSize(size);
console.log(`\nEXTENTS  size=[${size.x.toFixed(2)}, ${size.y.toFixed(2)}, ${size.z.toFixed(2)}]`);
console.log(`         min=[${box.min.x.toFixed(2)}, ${box.min.y.toFixed(2)}, ${box.min.z.toFixed(2)}] max=[${box.max.x.toFixed(2)}, ${box.max.y.toFixed(2)}, ${box.max.z.toFixed(2)}]`);
