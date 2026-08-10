// Rebuild public/models/hammerhead.glb from the raw download, KEEPING ITS UVs.
//
//   node tools/optimize-hammerhead.mjs [source.glb] [out.glb]
//
// There was already an optimised hammerhead on disk (295KB from a 2.25MB
// source, made 8 Aug), and it is a good optimisation with one fatal omission:
// it dropped `TEXCOORD_0`. Measured, the two files are:
//
//     source   20,292 verts / 6,764 tris   POSITION NORMAL TEXCOORD_0 JOINTS_0 WEIGHTS_0
//     old opt   4,635 verts / 6,764 tris   POSITION NORMAL            JOINTS_0 WEIGHTS_0
//
// Same triangles, so nothing was decimated — the mesh was WELDED, which is
// where the 4.4x came from and is entirely sound. But a mesh with no UV set
// cannot be textured at all, and the failure is silent in the worst way: three
// .js still compiles the shader, samples the map at a single undefined
// coordinate, and paints the whole animal in whatever colour happens to live in
// that one texel. It does not warn and it does not fall back. That is why the
// model rendered as a flat dark shape rather than as an untextured grey one,
// which would at least have looked like a missing texture.
//
// It matters here more than it would on most models because this is the one
// asset in the roster whose base colour is a LOOSE file: nothing is embedded,
// so `assets.js` points at /textures/hammerhead.jpg, and without a UV set that
// wiring can never land.
//
// So this redoes the same weld and keeps the UVs, then takes the two cheap
// quantisations the old file did not:
//
//   WEIGHTS_0 -> normalized uint8. A skin weight is a 0..1 number about to be
//   summed with three others; float32 is four bytes of precision no one can
//   see. Renormalised after rounding so each vertex still sums to exactly 255.
//
//   JOINTS_0 -> uint8. This rig has 12 bones. It fit in a byte with 243 spare.
//
// The source art is never written to: this reads from _DesignSystems and writes
// only to public/models, so re-running it after a new export is the whole
// update process.

import fs from 'node:fs';
import path from 'node:path';

const SRC = process.argv[2]
  ?? '/Users/ethangoldhammer/Documents/_DesignSystems/SealSurvivor/Hammerhead_2009-GLB.glb';
const OUT = process.argv[3]
  ?? path.resolve(import.meta.dirname, '../public/models/hammerhead.glb');

const COMPONENT = {
  5120: { array: Int8Array, size: 1 }, 5121: { array: Uint8Array, size: 1 },
  5122: { array: Int16Array, size: 2 }, 5123: { array: Uint16Array, size: 2 },
  5125: { array: Uint32Array, size: 4 }, 5126: { array: Float32Array, size: 4 },
};
const COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readGLB(file) {
  const buf = fs.readFileSync(file);
  let o = 12, json = null, bin = null;
  while (o < buf.length) {
    const len = buf.readUInt32LE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    if (type === 'JSON') json = JSON.parse(buf.toString('utf8', o + 8, o + 8 + len));
    else if (type.startsWith('BIN')) bin = buf.subarray(o + 8, o + 8 + len);
    o += 8 + len;
  }
  return { json, bin };
}

// Accessors here are all tightly packed, but honour byteStride anyway rather
// than assuming — a strided read that silently works on this file and breaks on
// the next export is not worth the three lines it saves.
function readAccessor(json, bin, index) {
  const acc = json.accessors[index];
  const view = json.bufferViews[acc.bufferView];
  const { array: Arr, size } = COMPONENT[acc.componentType];
  const n = COUNT[acc.type];
  const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = view.byteStride ?? n * size;
  const out = new Arr(acc.count * n);
  for (let i = 0; i < acc.count; i++) {
    const at = base + i * stride;
    for (let c = 0; c < n; c++) out[i * n + c] = new Arr(bin.buffer, bin.byteOffset + at + c * size, 1)[0];
  }
  return out;
}

const { json, bin } = readGLB(SRC);
const prim = json.meshes[0].primitives[0];
const attr = prim.attributes;
if (attr.TEXCOORD_0 == null) throw new Error('source has no TEXCOORD_0 — nothing to preserve');

const pos = readAccessor(json, bin, attr.POSITION);
const nrm = readAccessor(json, bin, attr.NORMAL);
const uv = readAccessor(json, bin, attr.TEXCOORD_0);
const jnt = readAccessor(json, bin, attr.JOINTS_0);
const wgt = readAccessor(json, bin, attr.WEIGHTS_0);
const idx = readAccessor(json, bin, prim.indices);
const srcVerts = json.accessors[attr.POSITION].count;

// --- weld ------------------------------------------------------------------
// Two vertices merge only when EVERY attribute matches, UVs included — which
// is what keeps a UV seam a seam. Positions and normals are keyed at 1e-5 and
// UVs at 1e-6; both are far below anything the source authored, so this
// removes exact duplicates from an unwelded export rather than approximating.
const map = new Map();
const P = [], N = [], T = [], J = [], W = [];
const newIdx = new Uint32Array(idx.length);
for (let i = 0; i < idx.length; i++) {
  const v = idx[i];
  const key = [
    pos[v * 3].toFixed(5), pos[v * 3 + 1].toFixed(5), pos[v * 3 + 2].toFixed(5),
    nrm[v * 3].toFixed(5), nrm[v * 3 + 1].toFixed(5), nrm[v * 3 + 2].toFixed(5),
    uv[v * 2].toFixed(6), uv[v * 2 + 1].toFixed(6),
    jnt[v * 4], jnt[v * 4 + 1], jnt[v * 4 + 2], jnt[v * 4 + 3],
    wgt[v * 4].toFixed(5), wgt[v * 4 + 1].toFixed(5), wgt[v * 4 + 2].toFixed(5), wgt[v * 4 + 3].toFixed(5),
  ].join(',');
  let at = map.get(key);
  if (at === undefined) {
    at = P.length / 3;
    map.set(key, at);
    P.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
    N.push(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]);
    T.push(uv[v * 2], uv[v * 2 + 1]);
    J.push(jnt[v * 4], jnt[v * 4 + 1], jnt[v * 4 + 2], jnt[v * 4 + 3]);
    W.push(wgt[v * 4], wgt[v * 4 + 1], wgt[v * 4 + 2], wgt[v * 4 + 3]);
  }
  newIdx[i] = at;
}
const verts = P.length / 3;
if (verts > 65535) throw new Error(`${verts} verts will not fit uint16 indices`);

// --- quantise --------------------------------------------------------------
const maxJoint = Math.max(...J);
if (maxJoint > 255) throw new Error(`joint index ${maxJoint} does not fit a byte`);
const joints8 = Uint8Array.from(J);

// Round each weight to a byte, then hand the rounding error to the largest
// component so the four still sum to 255. Letting them sum to 254 or 256
// leaves the shader normalising a slightly-off total, which shows up as a
// vertex creeping toward or away from its heaviest bone.
const weights8 = new Uint8Array(verts * 4);
for (let i = 0; i < verts; i++) {
  const w = [W[i * 4], W[i * 4 + 1], W[i * 4 + 2], W[i * 4 + 3]];
  const sum = w[0] + w[1] + w[2] + w[3] || 1;
  const q = w.map((x) => Math.round((x / sum) * 255));
  let big = 0;
  for (let c = 1; c < 4; c++) if (q[c] > q[big]) big = c;
  q[big] += 255 - (q[0] + q[1] + q[2] + q[3]);
  for (let c = 0; c < 4; c++) weights8[i * 4 + c] = q[c];
}

const positions = Float32Array.from(P);
const normals = Float32Array.from(N);
const uvs = Float32Array.from(T);
const indices16 = Uint16Array.from(newIdx);

// --- rebuild ---------------------------------------------------------------
// Everything that is not the mesh — the skin, the skeleton, the clip — is
// copied across untouched, so the bone names, hierarchy and inverse binds this
// project's rig declarations were measured against stay exactly as they are.
const parts = [];
let offset = 0;
const bufferViews = [];
const push = (typed, target) => {
  const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  const pad = (4 - (bytes.length % 4)) % 4;
  parts.push(bytes, Buffer.alloc(pad));
  const i = bufferViews.length;
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, ...(target ? { target } : {}) });
  offset += bytes.length + pad;
  return i;
};

const keepAnim = [];
const oldToNew = new Map();
// Animation samplers and inverse binds ride along; re-emitted in place so the
// accessor indices stay valid after the mesh accessors are replaced.
const carry = (accIndex) => {
  if (oldToNew.has(accIndex)) return oldToNew.get(accIndex);
  const acc = json.accessors[accIndex];
  const data = readAccessor(json, bin, accIndex);
  const bv = push(data);
  const at = keepAnim.length;
  keepAnim.push({
    bufferView: bv, componentType: acc.componentType, count: acc.count, type: acc.type,
    ...(acc.min ? { min: acc.min } : {}), ...(acc.max ? { max: acc.max } : {}),
  });
  oldToNew.set(accIndex, at);
  return at;
};

const accessors = [];
const addAcc = (bv, componentType, count, type, extra = {}) => {
  accessors.push({ bufferView: bv, componentType, count, type, ...extra });
  return accessors.length - 1;
};

let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < verts; i++) for (let c = 0; c < 3; c++) {
  min[c] = Math.min(min[c], positions[i * 3 + c]);
  max[c] = Math.max(max[c], positions[i * 3 + c]);
}

const aPos = addAcc(push(positions, 34962), 5126, verts, 'VEC3', { min, max });
const aNrm = addAcc(push(normals, 34962), 5126, verts, 'VEC3');
const aUv = addAcc(push(uvs, 34962), 5126, verts, 'VEC2');
const aJnt = addAcc(push(joints8, 34962), 5121, verts, 'VEC4');
const aWgt = addAcc(push(weights8, 34962), 5121, verts, 'VEC4', { normalized: true });
const aIdx = addAcc(push(indices16, 34963), 5123, indices16.length, 'SCALAR');

// Now the carried accessors, appended after the mesh ones.
const base = accessors.length;
const out = structuredClone(json);
for (const skin of out.skins ?? []) skin.inverseBindMatrices = base + carry(json.skins[out.skins.indexOf(skin)].inverseBindMatrices);
for (let ai = 0; ai < (out.animations ?? []).length; ai++) {
  for (const s of out.animations[ai].samplers) {
    s.input = base + carry(json.animations[ai].samplers[out.animations[ai].samplers.indexOf(s)].input);
    s.output = base + carry(json.animations[ai].samplers[out.animations[ai].samplers.indexOf(s)].output);
  }
}

out.accessors = [...accessors, ...keepAnim];
out.bufferViews = bufferViews;
out.meshes[0].primitives[0] = {
  attributes: { POSITION: aPos, NORMAL: aNrm, TEXCOORD_0: aUv, JOINTS_0: aJnt, WEIGHTS_0: aWgt },
  indices: aIdx,
  ...(prim.material != null ? { material: prim.material } : {}),
};

const binOut = Buffer.concat(parts);
out.buffers = [{ byteLength: binOut.length }];

const js = Buffer.from(JSON.stringify(out), 'utf8');
const jsPad = Buffer.concat([js, Buffer.alloc((4 - js.length % 4) % 4, 0x20)]);
const header = Buffer.alloc(12);
header.write('glTF', 0, 'ascii');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsPad.length + 8 + binOut.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jsPad.length, 0); jh.write('JSON', 4, 'ascii');
const bh = Buffer.alloc(8); bh.writeUInt32LE(binOut.length, 0); bh.write('BIN\0', 4, 'ascii');
fs.writeFileSync(OUT, Buffer.concat([header, jh, jsPad, bh, binOut]));

const srcSize = fs.statSync(SRC).size, outSize = fs.statSync(OUT).size;
console.log(`${path.basename(SRC)} ${(srcSize / 1e6).toFixed(2)}MB -> ${path.basename(OUT)} ${(outSize / 1024).toFixed(0)}KB`);
console.log(`  ${srcVerts} verts welded to ${verts} (${(idx.length / 3)} triangles, unchanged)`);
console.log(`  TEXCOORD_0 kept; JOINTS_0 -> uint8 (max joint ${maxJoint}), WEIGHTS_0 -> normalized uint8`);
