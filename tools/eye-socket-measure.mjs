#!/usr/bin/env node
// Measure eye sockets on a rig that has no eye bones.
//   node --import ./tools/vite-loader.mjs tools/eye-socket-measure.mjs <model> [emissive]
import './dom-stub.mjs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';

const modelPath = process.argv[2];
const emissivePath = process.argv[3];

const rawBuf = readFileSync(modelPath);

/**
 * The same .glb with every texture reference removed.
 *
 * Models with EMBEDDED maps (the mosasaur carries three webps inside the file)
 * stall GLTFLoader forever under dom-stub: it has no ImageBitmapLoader and no
 * canvas to decode into, and the promise simply never settles — no error, no
 * warning, just a hang. Nothing here needs a material: the geometry, the UVs
 * and the skinning are all accessors, and the maps are sampled separately with
 * sharp. So the JSON chunk is rewritten without them and the binary chunk is
 * left exactly as it was.
 */
function stripTextures(buf) {
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  json.images = [];
  json.textures = [];
  json.samplers = [];
  for (const m of json.materials ?? []) {
    delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture;
    if (m.pbrMetallicRoughness) {
      delete m.pbrMetallicRoughness.baseColorTexture;
      delete m.pbrMetallicRoughness.metallicRoughnessTexture;
    }
  }
  // Chunks are 4-byte aligned and JSON pads with spaces, per the glTF spec.
  let text = JSON.stringify(json);
  while (text.length % 4 !== 0) text += ' ';
  const jsonBytes = Buffer.from(text, 'utf8');
  const rest = buf.subarray(20 + jsonLen);
  const out = Buffer.alloc(12 + 8 + jsonBytes.length + rest.length);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonBytes.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonBytes.copy(out, 20);
  rest.copy(out, 20 + jsonBytes.length);
  return out;
}

const buf = stripTextures(rawBuf);
const gltf = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('GLTFLoader stalled (textures)')), 20000);
  new GLTFLoader().parse(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
    (g) => { clearTimeout(t); res(g); }, (e) => { clearTimeout(t); rej(e); },
  );
});

const scene = new THREE.Scene();
scene.add(gltf.scene);
scene.updateMatrixWorld(true);

let mesh = null;
gltf.scene.traverse((o) => { if (!mesh && o.isSkinnedMesh) mesh = o; });
if (!mesh) { console.log('no skinned mesh'); process.exit(0); }

const pos = mesh.geometry.attributes.position;
const uv = mesh.geometry.attributes.uv;
const si = mesh.geometry.attributes.skinIndex;
const sw = mesh.geometry.attributes.skinWeight;
const sk = mesh.skeleton;
console.log(`${modelPath}: ${pos.count} verts, ${sk.bones.length} bones, uv=${!!uv}`);

// dominant bone per vertex
const dom = new Int32Array(pos.count);
for (let v = 0; v < pos.count; v++) {
  let best = -1, bw = 0;
  for (let k = 0; k < 4; k++) {
    const w = sw.getComponent(v, k);
    if (w > bw) { bw = w; best = si.getComponent(v, k); }
  }
  dom[v] = best;
}
const counts = new Map();
for (const b of dom) counts.set(b, (counts.get(b) ?? 0) + 1);
console.log('dominant counts:', [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8)
  .map(([b, n]) => `${sk.bones[b]?.name ?? b}:${n}`).join('  '));

// --- per-bone geometry, for a rig whose names say nothing -------------------
// The mosasaur's 57 bones are all `BoneNNN_NN`, so the head cannot be picked by
// name and must be found by where its vertices are. `--bones` prints the
// dominated-vertex centroid of each, sorted along the model's long axis, and
// the head is the one at the snout end with a substantial share of the skin.
if (process.argv.includes('--bones')) {
  const rows = [];
  const q = new THREE.Vector3();
  for (const [b, n] of counts) {
    if (n < 20) continue;
    const c = new THREE.Vector3();
    let k = 0;
    for (let v = 0; v < pos.count; v++) {
      if (dom[v] !== b) continue;
      q.fromBufferAttribute(pos, v); c.add(q); k++;
    }
    c.divideScalar(k || 1);
    rows.push({ name: sk.bones[b]?.name ?? b, n, c });
  }
  const axis = process.argv.includes('--axis=x') ? 'x' : process.argv.includes('--axis=y') ? 'y' : 'z';
  rows.sort((a, b) => b.c[axis] - a.c[axis]);
  console.log(`\nbones by ${axis} (snout first):`);
  for (const r of rows.slice(0, 12)) {
    console.log(`  ${r.name.padEnd(14)} ${String(r.n).padStart(5)} verts  centroid ${r.c.toArray().map((v) => v.toFixed(2)).join(', ')}`);
  }
}

// --- embedded textures ------------------------------------------------------
// Several of these models carry their maps inside the .glb rather than beside
// it. `--dump` writes them out so the same sampling below can be pointed at one.
if (process.argv.includes('--dump')) {
  const jsonLen = rawBuf.readUInt32LE(12);
  const json = JSON.parse(rawBuf.subarray(20, 20 + jsonLen).toString('utf8'));
  const binOff = 20 + jsonLen + 8;
  const bin = rawBuf.subarray(binOff);
  const { writeFileSync } = await import('node:fs');
  (json.images ?? []).forEach((img, i) => {
    const bv = json.bufferViews[img.bufferView];
    const bytes = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    const ext = (img.mimeType ?? '').includes('webp') ? 'webp' : (img.mimeType ?? '').includes('png') ? 'png' : 'jpg';
    const out = `/tmp/glb-img-${i}.${ext}`;
    writeFileSync(out, bytes);
    console.log(`  image ${i}: ${out} (${bytes.length} bytes)`);
  });
  // Which one is the base colour, so the dark-spot search is pointed at the
  // map the eye is actually painted on rather than a normal or roughness map.
  (json.materials ?? []).forEach((m) => {
    const t = m.pbrMetallicRoughness?.baseColorTexture?.index;
    if (t === undefined) return;
    // `source` is undefined on a webp texture: EXT_texture_webp moves it into
    // the extension, and reading the plain field gives `image undefined` while
    // looking like the model simply has no colour map.
    const tex = json.textures[t];
    const src = tex.source ?? tex.extensions?.EXT_texture_webp?.source
      ?? tex.extensions?.KHR_texture_basisu?.source;
    console.log(`  material "${m.name}" baseColor -> image ${src}`);
  });
}

if (!emissivePath) process.exit(0);

// --- the emissive mask: which vertices sit on a lit texel ------------------
const img = await sharp(emissivePath).raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H, channels: C } = img.info;
const data = img.data;
console.log(`emissive ${W}x${H}x${C}`);
const rgbAt = (u, v) => {
  const x = Math.min(W - 1, Math.max(0, Math.round(u * (W - 1))));
  const y = Math.min(H - 1, Math.max(0, Math.round((1 - v) * (H - 1))));
  const i = (y * W + x) * C;
  return [data[i], data[i + 1], data[i + 2]];
};
const lumAt = (u, v) => {
  // glTF uv origin is top-left in image space after the loader's flipY handling
  const x = Math.min(W - 1, Math.max(0, Math.round(u * (W - 1))));
  const y = Math.min(H - 1, Math.max(0, Math.round((1 - v) * (H - 1))));
  const i = (y * W + x) * C;
  return (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
};

const DARK = process.argv.includes('--dark');
// COLOUR MATCHING, for a body whose eye is PAINTED rather than modelled or
// masked. The mosasaur is the case this exists for: its whole hide is dark, so
// "the darkest texels" finds patches all over the skull, but its eye is a
// saturated yellow-green slit that nothing else on the atlas comes near. Look
// at the base colour map before reaching for a threshold — the feature you
// need is usually obvious to an eye and invisible to a percentile.
const HUE = (process.argv.find((a) => a.startsWith('--rgb=')) ?? '').slice(6);
const TARGET = HUE ? HUE.split(',').map(Number) : null;
const TOL = Number((process.argv.find((a) => a.startsWith('--tol=')) ?? '--tol=60').slice(6));
const ONLY = (process.argv.find((a) => a.startsWith('--bone=')) ?? '').slice(7);

let hi = 0;
const lums = [];
for (let v = 0; v < pos.count; v++) {
  // With `--rgb` the score is DISTANCE FROM A COLOUR rather than luminance, and
  // is inverted so the same "lowest wins" path below selects the closest match.
  const l = TARGET
    ? Math.hypot(...rgbAt(uv.getX(v), uv.getY(v)).map((c, k) => c - TARGET[k])) / 441
    : lumAt(uv.getX(v), uv.getY(v));
  lums.push(l);
  if (l > hi) hi = l;
}
const sorted = [...lums].sort((a, b) => b - a);
console.log(`emissive per-vertex luminance: max ${hi.toFixed(3)}, p99 ${sorted[Math.floor(pos.count * 0.01)].toFixed(3)}, median ${sorted[pos.count >> 1].toFixed(3)}`);

// The extreme vertices, clustered by side. `--dark` looks for the DARKEST
// instead of the brightest, which is what finds an eye in a diffuse map: a
// shark's eye is a black dot on a grey body. `--bone=` restricts to one bone's
// own vertices, so a dark mouth three joints away cannot join the cluster.
const asc = [...lums].sort((a, b) => a - b);
const cut = TARGET ? TOL / 441
  : DARK ? asc[Math.floor(pos.count * 0.01)]
    : Math.max(0.35, sorted[Math.floor(pos.count * 0.01)]);
const lit = [];
const p = new THREE.Vector3();
for (let v = 0; v < pos.count; v++) {
  if ((DARK || TARGET) ? lums[v] > cut : lums[v] < cut) continue;
  if (ONLY && sk.bones[dom[v]]?.name !== ONLY) continue;
  p.fromBufferAttribute(pos, v);
  lit.push({ v, p: p.clone(), bone: sk.bones[dom[v]]?.name, lum: lums[v] });
}
console.log(`\n${lit.length} vertices ${(DARK || TARGET) ? 'below' : 'above'} ${cut.toFixed(3)}${TARGET ? ` of rgb(${TARGET})` : ''}${ONLY ? ` on ${ONLY}` : ''}`);
const byBone = new Map();
for (const l of lit) byBone.set(l.bone, (byBone.get(l.bone) ?? 0) + 1);
console.log('  on bones:', [...byBone].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([b, n]) => `${b}:${n}`).join('  '));

// Where the head reaches, so a cluster at the lateral extreme can be
// recognised as one rather than taken on trust.
{
  const box = new THREE.Box3();
  const q = new THREE.Vector3();
  for (let v = 0; v < pos.count; v++) {
    if (ONLY && sk.bones[dom[v]]?.name !== ONLY) continue;
    q.fromBufferAttribute(pos, v); box.expandByPoint(q);
  }
  console.log(`  ${ONLY || 'mesh'} spans x ${box.min.x.toFixed(2)}..${box.max.x.toFixed(2)}  y ${box.min.y.toFixed(2)}..${box.max.y.toFixed(2)}  z ${box.min.z.toFixed(2)}..${box.max.z.toFixed(2)}`);
}

for (const side of [1, -1]) {
  const grp = lit.filter((l) => Math.sign(l.p.x) === side || (side === 1 && l.p.x === 0));
  if (!grp.length) continue;
  const c = new THREE.Vector3();
  for (const g of grp) c.add(g.p);
  c.divideScalar(grp.length);
  const box = new THREE.Box3();
  for (const g of grp) box.expandByPoint(g.p);
  console.log(`  x${side > 0 ? '+' : '-'}: ${grp.length} verts, centroid ${c.toArray().map((n) => n.toFixed(3))}, span ${box.getSize(new THREE.Vector3()).toArray().map((n) => n.toFixed(3))}`);
  // ...and the same point in the BONE's own space, which is what an anchor
  // offset has to be. Geometry positions are in BIND space, so they go through
  // bindMatrix and then the bone's inverse bind — never through the bone's
  // current matrixWorld, which is the pose and not the bind. Mixing those is
  // the mistake that put the crab's eye socket a stalk-length away.
  if (ONLY) {
    const bi = sk.bones.findIndex((b) => b.name === ONLY);
    if (bi >= 0) {
      const toLocal = (pt) => pt.clone().applyMatrix4(mesh.bindMatrix).applyMatrix4(sk.boneInverses[bi]);
      console.log(`        bone-local on ${ONLY}: [${toLocal(c).toArray().map((n) => n.toFixed(4)).join(', ')}]`);
      // AND ITS MIRROR. Only one side of a symmetric animal usually shows up:
      // the two eyes share a UV island, so a colour or texel search finds the
      // pair as one cluster and the geometry split by x picks whichever side
      // the island is unwrapped from. The other eye is the reflection, and it
      // has to be reflected in MODEL space and converted afterwards — the
      // bone's own frame is not axis aligned, so negating a component of the
      // local offset gives a point somewhere off the head.
      const m = c.clone(); m.x = -m.x;
      console.log(`        mirrored (x ${m.x.toFixed(3)}): [${toLocal(m).toArray().map((n) => n.toFixed(4)).join(', ')}]`);
    }
  }
}
