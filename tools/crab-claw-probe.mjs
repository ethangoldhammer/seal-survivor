// What a crab model's claw can actually be made to do — measured, not guessed.
//
// Answers the questions that decide whether systems/crabClaw.js can drive a
// given file, each of which a wrong guess turns into a silent visual bug:
//
//   1. Is the claw head TWO JAWS or one lump? A pincer needs two vertex lobes
//      with a gap between them, driven by different bones. Without that there
//      is nothing to open and the pinch has to be faked by swinging the whole
//      head (which is what crabwalking.glb forces).
//   2. Which LOCAL axis hinges a jaw, and which sign closes it? That pair is
//      what ASSETS.<key>.clawRig has to declare.
//   3. Which bones does the clip actually KEY? applyChainToPoint treats
//      whatever is in a bone as the clip's pose and blends away from it, so an
//      UNKEYED bone under IK drifts a little further every frame. A rig whose
//      fingers are unkeyed needs the anti-ratchet, not just the mixer.
//   4. Which way does biolumSkin's aBioAxis run? It comes from the LONGEST
//      bounding-box side, and on a crab two sides are usually close enough
//      that the answer is effectively arbitrary.
//
//   node --import ./tools/vite-loader.mjs tools/crab-claw-probe.mjs [file.glb]
//
// Defaults to the model the game ships. Pass a path to audition a new one.
import './dom-stub.mjs';
// A textured GLB embeds its images, and GLTFLoader decodes them through
// createImageBitmap. Without a stub the parse promise never settles and the
// script exits with "unsettled top-level await" and no error at all.
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : resolve(HERE, '../public/models/crabwalking.glb');

const buf = readFileSync(FILE);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
);
const root = gltf.scene;
// Without this every pose measures identical and nothing throws — everything
// below reads world matrices the loader has not composed yet.
root.updateMatrixWorld(true);

let skin = null;
let tris = 0;
root.traverse((o) => {
  if (o.isSkinnedMesh && !skin) skin = o;
  if (o.isMesh && o.geometry?.index) tris += o.geometry.index.count / 3;
});
if (!skin) {
  console.log(`\n${basename(FILE)} has no skinned mesh — nothing to drive.\n`);
  process.exit(1);
}
const bones = skin.skeleton.bones;
const geo = skin.geometry;
const pos = geo.attributes.position;
const si = geo.attributes.skinIndex;
const sw = geo.attributes.skinWeight;
const idxOf = (n) => bones.findIndex((b) => b.name === n);

console.log(`\n=== ${basename(FILE)} ===`);
console.log(`  ${(buf.length / 1048576).toFixed(2)} MB on disk, ${tris.toLocaleString()} triangles, `
  + `${pos.count.toLocaleString()} verts, ${bones.length} bones`);
console.log(`  clips: ${gltf.animations.map((c) => `"${c.name}" ${c.duration.toFixed(2)}s/${c.tracks.length}tr`).join(', ') || 'none'}`);

// --- which bones does the clip actually write? ------------------------------
// The difference between "the mixer hands us a clean pose every frame" and
// "this bone is ours alone and will drift if we do not restore it".
const keyedRot = new Set();
for (const clip of gltf.animations) {
  for (const t of clip.tracks) {
    const [name, prop] = t.name.split('.');
    if (prop === 'quaternion') keyedRot.add(name);
  }
}
console.log(`  clip keys rotation on ${keyedRot.size} of ${bones.length} bones`
  + `${keyedRot.size < bones.length ? '  <-- the rest DRIFT under IK unless restored' : ''}`);

// Vertices this bone dominates, in mesh space.
function cloud(boneName, minW = 0.25) {
  const bi = idxOf(boneName);
  if (bi < 0) return [];
  const out = [];
  for (let i = 0; i < pos.count; i++) {
    let w = 0;
    for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === bi) w += sw.getComponent(i, k);
    if (w > minW) out.push(new THREE.Vector3().fromBufferAttribute(pos, i));
  }
  return out;
}
const mean = (pts) => pts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / (pts.length || 1));

// --- find the claw ----------------------------------------------------------
// A pincer shows up in the HIERARCHY as a bone with two child chains that both
// drive geometry. Nothing here is keyed to a naming convention — it looks for
// the shape rather than for "Hand" or "Palm", so it works on a rig nobody has
// seen before.
const drives = new Map();
for (const b of bones) drives.set(b.name, cloud(b.name).length);

function subtreeVerts(b) {
  let n = drives.get(b.name) ?? 0;
  for (const c of b.children) if (c.isBone) n += subtreeVerts(c);
  return n;
}

const forks = [];
for (const b of bones) {
  const kids = b.children.filter((c) => c.isBone && subtreeVerts(c) > 0);
  if (kids.length >= 2) forks.push({ bone: b, kids });
}

console.log(`\nFORKS — bones whose children split into two or more skinned chains`);
if (!forks.length) console.log('  none. There is no pincer in this rig; a pinch has to be faked.');
for (const { bone, kids } of forks) {
  console.log(`  ${bone.name}  ->  ${kids.map((k) => `${k.name} (${subtreeVerts(k)}v)`).join('  +  ')}`);
}

// --- can the fork actually OPEN? -------------------------------------------
// A fork is necessary but not sufficient, and the tempting test is the wrong
// one: comparing the two prongs' vertex CENTROIDS says "one lump" for any claw
// modelled shut, because two closed fingers lying alongside each other have
// nearly the same centroid. Measured that way the real pincer in
// animated_crab_rigged_free.glb scores 0.10x — indistinguishable from the
// solid lump in crabwalking.glb.
//
// So this drives it instead. Rotate the movable prong and measure the distance
// between the two prongs' TIPS. A real pincer opens; a fork over one lump
// does not. The control is built in: rotating a finger about its own LENGTH
// axis must not change the aperture at all, and if it does, the reading is
// noise rather than a hinge.
console.log(`\nAPERTURE TEST — rotate one prong, measure the tip-to-tip gap`);
const pairForks = forks.filter((f) => f.kids.length === 2);
if (!pairForks.length) {
  console.log('  no two-way fork in this rig — every branch point is a hub with three or more');
  console.log('  limbs coming off it, which is a body, not a claw. There is nothing here that can');
  console.log('  open, so a pinch has to be faked by swinging the whole head.');
}
const _p = new THREE.Vector3();
const worldOf = (o) => { root.updateMatrixWorld(true); return new THREE.Vector3().setFromMatrixPosition(o.matrixWorld); };
const deepest = (b) => {
  let best = b;
  let depth = 0;
  const walk = (n, d) => { if (d > depth) { depth = d; best = n; } for (const c of n.children) if (c.isBone) walk(c, d + 1); };
  walk(b, 0);
  return best;
};

for (const { bone, kids } of pairForks) {
  const [a, b] = kids;
  const tipA = deepest(a);
  const tipB = deepest(b);
  const rest = worldOf(tipA).distanceTo(worldOf(tipB));
  const armLen = worldOf(bone).distanceTo(worldOf(tipA));
  if (armLen < 1e-6) continue;

  let best = null;
  const saved = b.quaternion.clone();
  for (const [n, v] of [['x', [1, 0, 0]], ['y', [0, 1, 0]], ['z', [0, 0, 1]]]) {
    for (const ang of [0.4, -0.4]) {
      b.quaternion.copy(saved).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...v), ang));
      const d = worldOf(tipA).distanceTo(worldOf(tipB));
      if (!best || d > best.d) best = { n, ang, d };
    }
  }
  b.quaternion.copy(saved);
  root.updateMatrixWorld(true);

  const openPct = (best.d / rest - 1) * 100;
  const verdict = openPct > 60
    ? `<-- A REAL PINCER: rotate ${b.name} about local '${best.n}' by ${best.ang > 0 ? '+' : ''}${best.ang}`
    : '(does not open — one lump behind a fork; the pinch has to be faked)';
  console.log(`  ${bone.name.padEnd(16)} prongs ${a.name} / ${b.name}`);
  console.log(`  ${''.padEnd(16)} rest aperture ${rest.toFixed(4)} (${(rest / armLen * 100).toFixed(0)}% of prong length)`
    + ` -> best ${best.d.toFixed(4)} (+${openPct.toFixed(0)}%)  ${verdict}`);
}

// --- biolumSkin's body axis -------------------------------------------------
geo.computeBoundingBox();
const box = geo.boundingBox;
const size = box.getSize(new THREE.Vector3());
const axis = size.x >= size.y && size.x >= size.z ? 0 : (size.y >= size.z ? 1 : 2);
const sorted = [size.x, size.y, size.z].sort((a, b) => b - a);
console.log(`\nBIOLUM AXIS`);
console.log(`  geometry bbox (${size.x.toFixed(2)}, ${size.y.toFixed(2)}, ${size.z.toFixed(2)})`
  + `  -> derived axis ${['X', 'Y', 'Z'][axis]}, winning by ${((sorted[0] / sorted[1] - 1) * 100).toFixed(1)}%`);
console.log(`  (under ~10% is a coin flip — declare biolumAxis on the asset instead)`);
