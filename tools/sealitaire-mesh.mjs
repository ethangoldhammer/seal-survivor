#!/usr/bin/env node
// ============================================================================
// SEALITAIRE'S SEAL — bake public/models/furseal.glb into a blob the Rive
// script can hand straight to the GPU.
//
// Rive's Luau has no model loader: a GPU canvas takes vertex and index
// buffers and nothing else. So this reads the GLB here, in Node, and writes
// rive/sealitaire/seal.mesh — a flat little-endian file the script slices into
// GPUBuffer.new({ data }) with two buffer.copy calls.
//
//   header   u32 magic 'SEAL', u32 vertexCount, u32 indexCount, u32 boneCount
//   vertices vertexCount x 12 f32:  px py pz  nx ny nz  r g b  j0j1j2j3(packed u8x4 as f32 bits? no — see below)
//   indices  indexCount x u32
//   bones    boneCount x (u32 parent, 16 f32 local bind matrix, 16 f32 inverse bind)
//
// Vertex layout (stride 48 bytes):
//   0  float32x3 position     (model space, the mesh node's own transform baked in)
//   12 float32x3 normal
//   24 float32x3 color        (COLOR_0, or a fur ramp when the file's colours are flat)
//   36 uint8x4   joints
//   40 unorm8x4  weights      (renormalised to sum 1)
//   44 (pad to 48)
//
// The rig is exported too, so the script can pose the neck toward a card the
// way systems/aimRig.js does in the game. Bind matrices are what the shader
// needs: skin = sum w_i * (world_i * inverseBind_i).
//
//   node tools/sealitaire-mesh.mjs            writes the blob, prints the bones
// ============================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'public/models/furseal.glb');
const OUT = join(ROOT, 'rive/sealitaire/seal.mesh');

const glb = readFileSync(SRC);
const jsonLen = glb.readUInt32LE(12);
const gltf = JSON.parse(glb.toString('utf8', 20, 20 + jsonLen));
const binStart = 20 + jsonLen + 8;
const bin = glb.subarray(binStart, binStart + glb.readUInt32LE(20 + jsonLen));

const CT = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] };
const N = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function accessor(i) {
  const a = gltf.accessors[i];
  const bv = gltf.bufferViews[a.bufferView];
  const [Arr, bytes] = CT[a.componentType];
  const n = N[a.type];
  const stride = bv.byteStride || n * bytes;
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const out = new Float64Array(a.count * n);
  for (let k = 0; k < a.count; k++) {
    const view = new Arr(bin.buffer, bin.byteOffset + base + k * stride, n);
    for (let c = 0; c < n; c++) out[k * n + c] = view[c];
  }
  return { data: out, n, count: a.count, normalized: !!a.normalized, componentType: a.componentType };
}

// --- node transforms ---------------------------------------------------------
const nodes = gltf.nodes;
const parentOf = new Map();
nodes.forEach((nd, i) => (nd.children || []).forEach((c) => parentOf.set(c, i)));

function localMatrix(nd) {
  if (nd.matrix) return Float64Array.from(nd.matrix);
  const t = nd.translation || [0, 0, 0];
  const q = nd.rotation || [0, 0, 0, 1];
  const s = nd.scale || [1, 1, 1];
  const [x, y, z, w] = q;
  const m = new Float64Array(16);
  m[0] = (1 - 2 * (y * y + z * z)) * s[0]; m[1] = (2 * (x * y + z * w)) * s[0]; m[2] = (2 * (x * z - y * w)) * s[0]; m[3] = 0;
  m[4] = (2 * (x * y - z * w)) * s[1]; m[5] = (1 - 2 * (x * x + z * z)) * s[1]; m[6] = (2 * (y * z + x * w)) * s[1]; m[7] = 0;
  m[8] = (2 * (x * z + y * w)) * s[2]; m[9] = (2 * (y * z - x * w)) * s[2]; m[10] = (1 - 2 * (x * x + y * y)) * s[2]; m[11] = 0;
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
  return m;
}
function mul(a, b) { // column-major a*b
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
function worldMatrix(i) {
  const p = parentOf.get(i);
  const l = localMatrix(nodes[i]);
  return p === undefined ? l : mul(worldMatrix(p), l);
}
function xformPoint(m, x, y, z) {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}
function xformDir(m, x, y, z) {
  return [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
}

// --- the mesh ----------------------------------------------------------------
const meshNodeIndex = nodes.findIndex((nd) => nd.mesh != null);
const meshNode = nodes[meshNodeIndex];
const prim = gltf.meshes[meshNode.mesh].primitives[0];
const pos = accessor(prim.attributes.POSITION);
const nrm = accessor(prim.attributes.NORMAL);
const col = prim.attributes.COLOR_0 != null ? accessor(prim.attributes.COLOR_0) : null;
const jnt = accessor(prim.attributes.JOINTS_0);
const wgt = accessor(prim.attributes.WEIGHTS_0);
const idx = accessor(prim.indices);

// The skin's joints are bound in the SKELETON's space, and the skinned mesh is
// drawn in the space of the node the skin lives on (glTF: the mesh node's own
// transform is ignored for skinned meshes; the joint world matrices are what
// place it). We bake nothing into positions here — the shader multiplies by
// bone matrices, and those bone matrices carry the whole chain.
const skin = gltf.skins[meshNode.skin];
const ibm = accessor(skin.inverseBindMatrices);
const joints = skin.joints;
const jointSlot = new Map(joints.map((n, k) => [n, k]));

// Per-joint parent (in slot terms) and local bind matrix.
const bones = joints.map((nodeIdx, k) => {
  let p = parentOf.get(nodeIdx);
  // Walk up until we hit another joint, or the top of the tree (root joint).
  while (p !== undefined && !jointSlot.has(p)) p = parentOf.get(p);
  const parentSlot = p === undefined ? -1 : jointSlot.get(p);
  // Local = parentWorld^-1 * world, so that world = parentWorld * local.
  const world = worldMatrix(nodeIdx);
  return { name: nodes[nodeIdx].name, parentSlot, world, local: null, ibm: ibm.data.subarray(k * 16, k * 16 + 16) };
});
function invert(m) {
  // General 4x4 inverse (column-major).
  const a = m, o = new Float64Array(16);
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  const d = 1 / det;
  o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d; o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d; o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d; o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d; o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d; o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d; o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d; o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d; o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d; o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d; o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d; o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d; o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return o;
}
for (const b of bones) {
  b.local = b.parentSlot < 0 ? b.world : mul(invert(bones[b.parentSlot].world), b.world);
}

// --- normalise the figure ----------------------------------------------------
// Skinned vertices land in the skeleton's world space at bind pose; measure
// that so the script can scale/centre by numbers instead of guessing.
let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
const skinMats = bones.map((b) => mul(b.world, b.ibm));
for (let v = 0; v < pos.count; v++) {
  const p = [pos.data[v * 3], pos.data[v * 3 + 1], pos.data[v * 3 + 2]];
  let acc = [0, 0, 0];
  for (let k = 0; k < 4; k++) {
    const w = wgt.data[v * 4 + k]; if (w === 0) continue;
    const q = xformPoint(skinMats[jnt.data[v * 4 + k]], p[0], p[1], p[2]);
    acc = [acc[0] + q[0] * w, acc[1] + q[1] * w, acc[2] + q[2] * w];
  }
  for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], acc[c]); mx[c] = Math.max(mx[c], acc[c]); }
}
const size = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
const centre = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];

// --- colours -----------------------------------------------------------------
let flat = true;
if (col) {
  const c0 = [col.data[0], col.data[1], col.data[2]];
  for (let v = 1; v < col.count && flat; v++) {
    if (Math.abs(col.data[v * col.n] - c0[0]) > 0.02 || Math.abs(col.data[v * col.n + 1] - c0[1]) > 0.02 || Math.abs(col.data[v * col.n + 2] - c0[2]) > 0.02) flat = false;
  }
}

// --- write -------------------------------------------------------------------
const STRIDE = 48;
const vcount = pos.count, icount = idx.count, bcount = bones.length;
const headerBytes = 16;
const vertBytes = vcount * STRIDE;
const idxBytes = icount * 4;
const boneBytes = bcount * (4 + 64 + 64);
const out = Buffer.alloc(headerBytes + vertBytes + idxBytes + boneBytes);
out.write('SEAL', 0, 'latin1');
out.writeUInt32LE(vcount, 4); out.writeUInt32LE(icount, 8); out.writeUInt32LE(bcount, 12);
let o = headerBytes;
for (let v = 0; v < vcount; v++) {
  out.writeFloatLE(pos.data[v * 3], o); out.writeFloatLE(pos.data[v * 3 + 1], o + 4); out.writeFloatLE(pos.data[v * 3 + 2], o + 8);
  out.writeFloatLE(nrm.data[v * 3], o + 12); out.writeFloatLE(nrm.data[v * 3 + 1], o + 16); out.writeFloatLE(nrm.data[v * 3 + 2], o + 20);
  let r = 0.62, g = 0.5, b = 0.4;
  if (col && !flat) { r = col.data[v * col.n]; g = col.data[v * col.n + 1]; b = col.data[v * col.n + 2]; }
  out.writeFloatLE(r, o + 24); out.writeFloatLE(g, o + 28); out.writeFloatLE(b, o + 32);
  const ws = [0, 1, 2, 3].map((k) => wgt.data[v * 4 + k]);
  const sum = ws.reduce((a, c) => a + c, 0) || 1;
  for (let k = 0; k < 4; k++) {
    out.writeUInt8(jnt.data[v * 4 + k], o + 36 + k);
    out.writeUInt8(Math.round((ws[k] / sum) * 255), o + 40 + k);
  }
  o += STRIDE;
}
for (let i = 0; i < icount; i++) { out.writeUInt32LE(idx.data[i], o); o += 4; }
for (const b of bones) {
  out.writeInt32LE(b.parentSlot, o); o += 4;
  for (let k = 0; k < 16; k++) { out.writeFloatLE(b.local[k], o); o += 4; }
  for (let k = 0; k < 16; k++) { out.writeFloatLE(b.ibm[k], o); o += 4; }
}
writeFileSync(OUT, out);

console.log(`wrote ${OUT} (${out.length} bytes): ${vcount} verts, ${icount / 3} tris, ${bcount} bones, colours ${col ? (flat ? 'flat -> fur ramp' : 'from COLOR_0') : 'none -> fur ramp'}`);
console.log(`bind-pose bounds min ${mn.map((v) => v.toFixed(3))} max ${mx.map((v) => v.toFixed(3))}`);
console.log(`size ${size.map((v) => v.toFixed(3))} centre ${centre.map((v) => v.toFixed(3))}`);
console.log('bones:');
bones.forEach((b, k) => console.log(`  ${k.toString().padStart(2)} ${b.name} (parent ${b.parentSlot})`));
