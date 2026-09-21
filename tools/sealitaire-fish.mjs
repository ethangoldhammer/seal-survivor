#!/usr/bin/env node
// ============================================================================
// THE TANK PACK — every creature a Sealitaire card face can hold, baked from
// public/models into one blob the fish shader draws instanced.
//
// rive/sealitaire/tanks.csv is the pick list: one row per card that is a
// tank (the fish suit's 2-10 hold a sardine school; every A, J, Q and K
// holds one creature). This tool bakes each distinct `model` the table
// names — the script reads the SAME csv at runtime for the per-card count,
// size and colours, so re-picking a model is: edit the row, run this.
//
//   header    u32 magic 'TNK3', u32 speciesCount, u32 vertexCount,
//             u32 indexCount, u32 paletteFloats, u32 boneCount,
//             u32 chainWords, u32 reserved                          (32 bytes)
//   species   speciesCount x 80 bytes:
//               char[24] name (zero padded)
//               u32 vertexOffset, u32 vertexCount, u32 indexOffset, u32 indexCount
//               f32 width, f32 height   (normalised extents; length is 1)
//               u32 bones, u32 frames, f32 duration (s), u32 paletteOffset
//                                      (a FLOAT index into the palette block)
//               u32 boneOffset (an ENTRY index into the bones block),
//               u32 chainCount, u32 chainOffset (a WORD index into chains),
//               u32 reserved
//   vertices  vertexCount x 32 bytes: px py pz nx ny nz f32, joints u8x4,
//             weights unorm8x4
//   indices   indexCount x u32, ABSOLUTE into the shared vertex list, so a
//             species draws with drawIndexed(count, n, firstIndex) and no
//             base vertex (the Rive GPU API has none)
//   bones     boneCount x 16 bytes, per species one entry per palette slot:
//             u32 parent (the slot above it, 0xFFFFFFFF at the root or on an
//             unrigged species), f32 hx hy hz — the bone's head in CANONICAL
//             space. That is what a spring solver needs and all it needs: a
//             joint to rotate about, and a parent to compose with.
//   chains    chainWords x u32: per species, per chain, u32 role (0 tail,
//             1 fin), u32 boneCount, then that many u32 palette slots, root
//             first. rive/sealitaire/rigs.csv is where they come from.
//   palette   paletteFloats x f32: per species, frames x bones x 12 — the
//             three rows of a 3x4 affine, in CANONICAL space, RELATIVE TO THE
//             REST POSE (below). table.luau uploads each species' block as an
//             rgba32float texture, bones*3 wide and frames tall, and fish.wgsl
//             skins from it per instance.
//
// Every body is put in ONE frame so the script can treat them alike:
// centred, the long axis along z, the HEAD AT -z, length 1. Skinned models
// are baked at rest pose (every joint at its node's own TRS). The head end
// is guessed as the fatter end (summed cross-section over the outer 30% —
// a tail fin is thin in one axis, a head is thick in both); the `flip`
// column overrides a wrong guess. The tool prints its guess per species so
// a backwards creature is caught here, not in the tank.
//
// THE CLIP. A row's `clip` cell names one of the model's animations (a
// case-insensitive substring of its name: `Dance`, `swim`, `Turtle_idle`)
// and the pack then carries that clip as a bone palette, sampled at CLIP_FPS,
// so fish.wgsl can pose every instance at its own phase. A blank cell is the
// rest pose, with a one-bone identity palette, so the shader has ONE path
// and a still creature costs one texel read. `--list` prints every model's
// clips so there is something to copy from.
//
// The palette is RELATIVE: the vertices in the pack are already posed at
// rest and in the canonical frame, so each bone's matrix maps a REST-POSED
// canonical vertex to its posed canonical position — C · G_f · G_rest⁻¹ ·
// C⁻¹ per joint. Exact wherever rest is bind (every model here); for a
// vertex split across joints it is the usual delta-skinning approximation.
// It is what lets a skinned and an unskinned species share one vertex
// layout and one shader.
//
// A species is ONE mesh, so `flip` and `clip` must agree across every row
// that names it; the tool refuses a disagreement rather than picking one.
//
//   node tools/sealitaire-fish.mjs           the ship bake: what tanks.csv uses
//   node tools/sealitaire-fish.mjs --pool    the LAB bake: that, plus every row of
//                                            pool.csv, so the tuner's card rows can
//                                            step a card through the whole roster
//                                            live, with no rebake between picks
//   node tools/sealitaire-fish.mjs --list    every clip in every model the two
//                                            tables name, with its length; bakes nothing
// ============================================================================

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSV = join(ROOT, 'rive/sealitaire/tanks.csv');
const RIGS = join(ROOT, 'rive/sealitaire/rigs.csv');
const POOL = join(ROOT, 'rive/sealitaire/pool.csv');
const WITH_POOL = process.argv.includes('--pool');
const LIST = process.argv.includes('--list');
const OUT = join(ROOT, 'rive/sealitaire/fish.mesh');
const MODELS = join(ROOT, 'public/models');

// The clip's sampling. 30fps like the seal's clips; a long clip is sampled
// slower rather than deeper so the palette stays a few hundred KB — it is
// a texture of frames x bones*3 float texels, and a 16s jellyfish loop at
// 30fps would be 500 rows of 1648 bones. Rigs past MAX_BONES bake at rest.
const CLIP_FPS = 30;
const MAX_FRAMES = 240;
const MAX_BONES = 255;   // joints are u8

// --- the csv -----------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.some((v) => v.trim() !== '')).map((r) => Object.fromEntries(head.map((h, k) => [h.trim(), (r[k] ?? '').trim()])));
}
// THE RIGS (rigs.csv). A species named there keeps its SKELETON: joints,
// weights, each bone's parent and rest head, and the chains a contact may
// shove. One with no row is flattened onto one identity bone as before.
//
// The bone names there are the spellings GLTFLoader produced, which have had
// their DOTS STRIPPED — `Bone.003_Armature_5` in greatwhite.glb is
// `Bone003_Armature_5` in path/src/assets.js, where these were copied from.
// Matching on the stripped name accepts both spellings; a name that resolves
// to nothing THROWS, because the failure this is guarding against is the one
// that cost the orca cow her whole dorsal by silently dropping a chain.
const ROLES = { tail: 0, fin: 1 };
const rigOf = new Map();  // species -> [{ chain, role, bones: [name] }]
for (const r of parseCsv(readFileSync(RIGS, 'utf8'))) {
  if (!r.species || !r.bones) continue;
  const role = ROLES[(r.role || '').trim()];
  if (role === undefined) throw new Error(`rigs.csv: ${r.species} chain "${r.chain}" has role "${r.role}"; it must be one of ${Object.keys(ROLES).join(', ')}`);
  const bones = r.bones.split('|').map((b) => b.trim()).filter(Boolean);
  if (!rigOf.has(r.species)) rigOf.set(r.species, []);
  rigOf.get(r.species).push({ chain: r.chain || String(rigOf.get(r.species).length + 1), role, bones });
}
const rows = parseCsv(readFileSync(CSV, 'utf8')).map((r) => ({ ...r, from: 'tanks.csv' }));
if (WITH_POOL || LIST) rows.push(...parseCsv(readFileSync(POOL, 'utf8')).map((r) => ({ ...r, from: 'pool.csv' })));
const species = new Map(); // name -> { flip, clip }
for (const r of rows) {
  if (!r.model) continue;
  const flip = r.flip === '1' || /^true$/i.test(r.flip);
  const clip = (r.clip || '').trim();
  const prev = species.get(r.model);
  if (prev) {
    if (prev.flip !== flip) throw new Error(`${r.from}: ${r.model} has flip set on one row and not another; it is one mesh`);
    // A blank clip on one row and a named one on another is not a
    // disagreement: the pool's row is a listing, the tank's row is the pick.
    if (clip && prev.clip && prev.clip !== clip) throw new Error(`${r.from}: ${r.model} names clip "${clip}" on one row and "${prev.clip}" on another; it is one mesh`);
    if (clip && !prev.clip) prev.clip = clip;
  } else {
    species.set(r.model, { flip, clip });
  }
}
if (!LIST) console.log(WITH_POOL ? `pool bake: ${species.size} species (tanks.csv + pool.csv)` : `ship bake: ${species.size} species (tanks.csv only; --pool adds pool.csv)`);

// --- glb -----------------------------------------------------------------------
const CT = {
  5120: [Int8Array, 1, 127], 5121: [Uint8Array, 1, 255], 5122: [Int16Array, 2, 32767],
  5123: [Uint16Array, 2, 65535], 5125: [Uint32Array, 4, 0], 5126: [Float32Array, 4, 0],
};
const N = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function loadGlb(file) {
  const glb = readFileSync(file);
  const jsonLen = glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.toString('utf8', 20, 20 + jsonLen));
  const binStart = 20 + jsonLen + 8;
  const bin = glb.subarray(binStart, binStart + glb.readUInt32LE(20 + jsonLen));
  function accessor(i) {
    const a = gltf.accessors[i];
    if (a.bufferView == null) throw new Error(`accessor ${i} has no bufferView (draco?) — not supported`);
    const bv = gltf.bufferViews[a.bufferView];
    const [Arr, bytes, norm] = CT[a.componentType];
    const n = N[a.type];
    const stride = bv.byteStride || n * bytes;
    const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const out = new Float64Array(a.count * n);
    const div = a.normalized && norm ? norm : 1;
    for (let k = 0; k < a.count; k++) {
      const view = new Arr(bin.buffer, bin.byteOffset + base + k * stride, n);
      for (let c = 0; c < n; c++) out[k * n + c] = view[c] / div;
    }
    return { data: out, n, count: a.count };
  }
  return { gltf, accessor };
}

function trsMatrix(t, q, s) {
  const [x, y, z, w] = q;
  const m = new Float64Array(16);
  m[0] = (1 - 2 * (y * y + z * z)) * s[0]; m[1] = 2 * (x * y + z * w) * s[0]; m[2] = 2 * (x * z - y * w) * s[0];
  m[4] = 2 * (x * y - z * w) * s[1]; m[5] = (1 - 2 * (x * x + z * z)) * s[1]; m[6] = 2 * (y * z + x * w) * s[1];
  m[8] = 2 * (x * z + y * w) * s[2]; m[9] = 2 * (y * z - x * w) * s[2]; m[10] = (1 - 2 * (x * x + y * y)) * s[2];
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
  return m;
}
function localMatrix(nd) {
  if (nd.matrix) return Float64Array.from(nd.matrix);
  return trsMatrix(nd.translation || [0, 0, 0], nd.rotation || [0, 0, 0, 1], nd.scale || [1, 1, 1]);
}
function mul(a, b) {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; }
  return o;
}
// General 4x4 inverse (column-major), for the rest pose and the canonical frame.
function inv(m) {
  const a = m, o = new Float64Array(16);
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) throw new Error('singular matrix');
  det = 1 / det;
  o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return o;
}
function xp(m, x, y, z) { return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]; }
function xd(m, x, y, z) { return [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z]; }
const IDENTITY = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

// Linear (nlerp for quats) between the bracketing keys of one channel.
function sampleChannel(times, values, n, t) {
  let k = 0;
  while (k < times.length - 1 && times[k + 1] < t) k++;
  const k2 = Math.min(k + 1, times.length - 1);
  const span = times[k2] - times[k];
  const u = span > 1e-9 ? Math.max(0, Math.min(1, (t - times[k]) / span)) : 0;
  const a = values.subarray(k * n, k * n + n);
  const b = values.subarray(k2 * n, k2 * n + n);
  const out = new Array(n);
  let dotp = 0;
  if (n === 4) for (let c = 0; c < 4; c++) dotp += a[c] * b[c];
  const sign = n === 4 && dotp < 0 ? -1 : 1;
  for (let c = 0; c < n; c++) out[c] = a[c] + (b[c] * sign - a[c]) * u;
  if (n === 4) {
    const len = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
    for (let c = 0; c < 4; c++) out[c] /= len;
  }
  return out;
}

function clipNames(gltf) {
  return (gltf.animations || []).map((a) => {
    let max = 0;
    for (const s of a.samplers) { const acc = gltf.accessors[s.input]; if (acc.max) max = Math.max(max, acc.max[0]); }
    return { name: a.name || '?', duration: max };
  });
}

// One species: every primitive of every mesh node, skinned ones at rest
// pose, into flat position/normal/joint/weight/index arrays in the canonical
// frame — and, if the row names a clip, that clip's bone palette.
function bake(name, flip, clip, rigChains) {
  const { gltf, accessor } = loadGlb(join(MODELS, `${name}.glb`));
  const nodes = gltf.nodes;
  const parentOf = new Map();
  nodes.forEach((nd, i) => (nd.children || []).forEach((c) => parentOf.set(c, i)));
  const worldCache = new Map();
  function world(i) {
    if (worldCache.has(i)) return worldCache.get(i);
    const p = parentOf.get(i);
    const l = localMatrix(nodes[i]);
    const w = p === undefined ? l : mul(world(p), l);
    worldCache.set(i, w);
    return w;
  }

  // The bone list: slot 0 is the identity for every unskinned vertex, then
  // each skin's joints in order. `rest[slot]` is G_rest · ibm for that joint.
  const boneNode = [-1];
  const rest = [IDENTITY];
  const slotOfSkinJoint = new Map(); // skinIndex -> [slot per joint]
  const wantClip = clip !== '';
  const wantRig = rigChains.length > 0;
  let anim = null;
  if (wantClip) {
    const lc = clip.toLowerCase();
    anim = (gltf.animations || []).find((a) => (a.name || '').toLowerCase().includes(lc)) || null;
    if (!anim) throw new Error(`no clip matching "${clip}"; it has: ${clipNames(gltf).map((c) => c.name).join(', ') || 'none'}`);
  }
  let tooManyBones = false;
  (gltf.skins || []).forEach((skin, si) => {
    const ibm = accessor(skin.inverseBindMatrices);
    const slots = skin.joints.map((j, k) => {
      const slot = boneNode.length;
      boneNode.push(j);
      rest.push(mul(world(j), ibm.data.subarray(k * 16, k * 16 + 16)));
      return slot;
    });
    slotOfSkinJoint.set(si, slots);
  });
  // An UNSKINNED mesh node can still animate — cutesquid and jellyfish are
  // rigid parts moved by node tracks — so each one gets a slot of its own,
  // its rest being its world matrix, and rides the same relative palette.
  const slotOfRigidNode = new Map();
  if (wantClip) {
    nodes.forEach((nd, i) => {
      if (nd.mesh == null || nd.skin != null) return;
      slotOfRigidNode.set(i, boneNode.length);
      boneNode.push(i);
      rest.push(world(i));
    });
  }
  if (boneNode.length - 1 > MAX_BONES) tooManyBones = true;
  // A rig alone is enough to keep the skeleton: the clip is what fills the
  // palette with movement, the rig is what makes the palette addressable.
  const skinned = (wantClip || wantRig) && !tooManyBones;

  const positions = [], normals = [], joints = [], weights = [], indices = [];
  nodes.forEach((nd, ni) => {
    if (nd.mesh == null) return;
    let skinMats = null, slots = null;
    if (nd.skin != null) {
      skinMats = slotOfSkinJoint.get(nd.skin).map((s) => rest[s]);
      slots = slotOfSkinJoint.get(nd.skin);
    }
    const m = world(ni);
    for (const prim of gltf.meshes[nd.mesh].primitives) {
      if (prim.mode != null && prim.mode !== 4) continue;
      const pos = accessor(prim.attributes.POSITION);
      const nrm = prim.attributes.NORMAL != null ? accessor(prim.attributes.NORMAL) : null;
      const jnt = skinMats && prim.attributes.JOINTS_0 != null ? accessor(prim.attributes.JOINTS_0) : null;
      const wgt = skinMats && prim.attributes.WEIGHTS_0 != null ? accessor(prim.attributes.WEIGHTS_0) : null;
      const base = positions.length / 3;
      for (let v = 0; v < pos.count; v++) {
        const x = pos.data[v * 3], y = pos.data[v * 3 + 1], z = pos.data[v * 3 + 2];
        const nx = nrm ? nrm.data[v * 3] : 0, ny = nrm ? nrm.data[v * 3 + 1] : 1, nz = nrm ? nrm.data[v * 3 + 2] : 0;
        let p, n;
        const J = [0, 0, 0, 0], W = [1, 0, 0, 0];
        if (jnt && wgt) {
          p = [0, 0, 0]; n = [0, 0, 0];
          let wsum = 0;
          for (let k = 0; k < 4; k++) {
            const w = wgt.data[v * 4 + k]; if (w === 0) continue;
            const sm = skinMats[jnt.data[v * 4 + k]];
            const q = xp(sm, x, y, z), d = xd(sm, nx, ny, nz);
            for (let c = 0; c < 3; c++) { p[c] += q[c] * w; n[c] += d[c] * w; }
            wsum += w;
          }
          if (wsum > 0 && Math.abs(wsum - 1) > 1e-3) for (let c = 0; c < 3; c++) { p[c] /= wsum; n[c] /= wsum; }
          if (skinned) {
            for (let k = 0; k < 4; k++) { J[k] = slots[jnt.data[v * 4 + k]]; W[k] = wsum > 0 ? wgt.data[v * 4 + k] / wsum : (k === 0 ? 1 : 0); }
          }
        } else {
          p = xp(m, x, y, z); n = xd(m, nx, ny, nz);
          if (skinned && slotOfRigidNode.has(ni)) J[0] = slotOfRigidNode.get(ni);
        }
        positions.push(p[0], p[1], p[2]);
        const len = Math.hypot(n[0], n[1], n[2]) || 1;
        normals.push(n[0] / len, n[1] / len, n[2] / len);
        joints.push(...J);
        weights.push(...W);
      }
      if (prim.indices != null) {
        const idx = accessor(prim.indices);
        for (let i = 0; i < idx.count; i++) indices.push(base + idx.data[i]);
      } else {
        for (let i = 0; i < pos.count; i++) indices.push(base + i);
      }
    }
  });
  if (positions.length === 0) throw new Error(`${name}: no triangles`);

  // Extents, then the long axis to z: a rotation, never a mirror, so the
  // body keeps its handedness. The same transform is accumulated as C so
  // the palette can be brought into the canonical frame.
  const ext = () => {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < positions.length; v += 3) for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], positions[v + c]); mx[c] = Math.max(mx[c], positions[v + c]); }
    return { mn, mx, size: mx.map((v, c) => v - mn[c]) };
  };
  let e = ext();
  const axis = e.size.indexOf(Math.max(...e.size));
  const rot = (fn) => { for (let v = 0; v < positions.length; v += 3) { fn(positions, v); fn(normals, v); } };
  let C = IDENTITY;
  if (axis === 0) {        // about y, -90: x -> z
    rot((a, v) => { const x = a[v], z = a[v + 2]; a[v] = -z; a[v + 2] = x; });
    C = Float64Array.from([0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1]);
  } else if (axis === 1) { // about x, +90: y -> z
    rot((a, v) => { const y = a[v + 1], z = a[v + 2]; a[v + 1] = -z; a[v + 2] = y; });
    C = Float64Array.from([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]);
  }
  e = ext();
  const longest = e.size[2];
  const centre = e.mn.map((v, c) => (v + e.mx[c]) / 2);
  for (let v = 0; v < positions.length; v += 3) for (let c = 0; c < 3; c++) positions[v + c] = (positions[v + c] - centre[c]) / longest;
  const k = 1 / longest;
  C = mul(Float64Array.from([k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0, -centre[0] * k, -centre[1] * k, -centre[2] * k, 1]), C);

  // Which end is the head: the fatter one. Slice the outer 30% of each end
  // into 6 bins, take each bin's cross-section box area, sum.
  const bins = 6, span = 0.3 / bins;
  const area = (lo, hi) => {
    const b = Array.from({ length: bins }, () => ({ mnx: Infinity, mxx: -Infinity, mny: Infinity, mxy: -Infinity }));
    for (let v = 0; v < positions.length; v += 3) {
      const z = positions[v + 2];
      if (z < lo || z > hi) continue;
      const kk = Math.min(bins - 1, Math.floor((z - lo) / span));
      const s = b[kk];
      s.mnx = Math.min(s.mnx, positions[v]); s.mxx = Math.max(s.mxx, positions[v]);
      s.mny = Math.min(s.mny, positions[v + 1]); s.mxy = Math.max(s.mxy, positions[v + 1]);
    }
    return b.reduce((acc, s) => acc + (s.mxx > s.mnx ? (s.mxx - s.mnx) * (s.mxy - s.mny) : 0), 0);
  };
  const aNeg = area(-0.5, -0.2), aPos = area(0.2, 0.5);
  let headAtNeg = aNeg >= aPos;
  if (flip) headAtNeg = !headAtNeg;
  if (!headAtNeg) {
    rot((a, v) => { a[v] = -a[v]; a[v + 2] = -a[v + 2]; }); // half turn about y
    C = mul(Float64Array.from([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]), C);
  }
  e = ext();

  // --- the bones and their chains -------------------------------------------
  // Everything a spring solver needs and nothing more: the joint to rotate
  // about, in the canonical frame the vertices are already in, and the slot
  // above it to compose with. The chain rows resolve to slots here rather
  // than at runtime, so a name that misses is caught by the bake.
  const boneParent = [], boneHead = [], chains = [];
  if (skinned) {
    const slotOfNode = new Map();
    boneNode.forEach((n, sl) => { if (n >= 0) slotOfNode.set(n, sl); });
    for (let sl = 0; sl < boneNode.length; sl++) {
      const n = boneNode[sl];
      if (n < 0) { boneParent.push(0xFFFFFFFF); boneHead.push(0, 0, 0); continue; }
      const pn = parentOf.get(n);
      const ps = pn === undefined ? undefined : slotOfNode.get(pn);
      boneParent.push(ps === undefined ? 0xFFFFFFFF : ps);
      const w = world(n);
      const h = xp(C, w[12], w[13], w[14]);
      boneHead.push(h[0], h[1], h[2]);
    }
    // The names GLTFLoader would have produced, which is the spelling
    // rigs.csv carries: the dots are gone. Both spellings resolve.
    const bare = (t) => t.replace(/\./g, '');
    const slotOfName = new Map();
    boneNode.forEach((n, sl) => { if (n >= 0 && nodes[n].name) slotOfName.set(bare(nodes[n].name), sl); });
    for (const c of rigChains) {
      const slots = c.bones.map((bn) => {
        const sl = slotOfName.get(bare(bn));
        if (sl === undefined) throw new Error(`rigs.csv: ${name} chain "${c.chain}" names bone "${bn}", which is not in the rig. It has: ${[...slotOfName.keys()].slice(0, 8).join(', ')}...`);
        return sl;
      });
      chains.push({ role: c.role, slots });
    }
  } else if (wantRig) {
    throw new Error(`${name}: rigs.csv names it but its rig is ${boneNode.length - 1} joints, over ${MAX_BONES}`);
  }

  // --- the palette ----------------------------------------------------------
  // frames x bones x 12 floats: the three rows of C · G_f(j) · G_rest(j)⁻¹ · C⁻¹.
  let bones = 1, frames = 1, duration = 0;
  let palette = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  let clipName = '';
  if (skinned) {
    bones = boneNode.length;
    // THE REST PALETTE. A rigged species with no clip still needs a palette
    // entry per bone, because its vertices now reference real slots: one
    // frame of identities, which skins to exactly the rest pose it is
    // already in. A clip below overwrites this with movement.
    palette = new Float32Array(bones * 12);
    for (let b2 = 0; b2 < bones; b2++) { palette[b2 * 12] = 1; palette[b2 * 12 + 5] = 1; palette[b2 * 12 + 10] = 1; }
  }
  if (skinned && wantClip) {
    clipName = anim.name;
    const perNode = new Map();
    for (const ch of anim.channels) {
      const smp = anim.samplers[ch.sampler];
      const times = accessor(smp.input).data;
      const vals = accessor(smp.output);
      duration = Math.max(duration, times[times.length - 1]);
      if (!perNode.has(ch.target.node)) perNode.set(ch.target.node, {});
      perNode.get(ch.target.node)[ch.target.path] = { times, values: vals.data, n: vals.n };
    }
    frames = Math.max(1, Math.min(MAX_FRAMES, Math.round(duration * CLIP_FPS)));
    const Cinv = inv(C);
    palette = new Float32Array(frames * bones * 12);
    for (let f = 0; f < frames; f++) {
      const t = frames > 1 ? (f / frames) * duration : 0;
      // Every node's local TRS at t, then worlds down the hierarchy.
      const localAt = new Map();
      const localOf = (i) => {
        if (localAt.has(i)) return localAt.get(i);
        const nd = nodes[i];
        const ch = perNode.get(i);
        let l;
        if (!ch) l = localMatrix(nd);
        else {
          const tr = ch.translation ? sampleChannel(ch.translation.times, ch.translation.values, 3, t) : (nd.translation || [0, 0, 0]);
          const ro = ch.rotation ? sampleChannel(ch.rotation.times, ch.rotation.values, 4, t) : (nd.rotation || [0, 0, 0, 1]);
          const sc = ch.scale ? sampleChannel(ch.scale.times, ch.scale.values, 3, t) : (nd.scale || [1, 1, 1]);
          l = trsMatrix(tr, ro, sc);
        }
        localAt.set(i, l);
        return l;
      };
      const worldAt = new Map();
      const worldOf = (i) => {
        if (worldAt.has(i)) return worldAt.get(i);
        const p = parentOf.get(i);
        const w = p === undefined ? localOf(i) : mul(worldOf(p), localOf(i));
        worldAt.set(i, w);
        return w;
      };
      for (let s = 0; s < bones; s++) {
        let M;
        if (s === 0) M = IDENTITY;
        else {
          // G_f · ibm · (G_rest · ibm)⁻¹ = G_f · G_rest⁻¹ — the ibm cancels.
          const gf = worldOf(boneNode[s]);
          M = mul(C, mul(mul(gf, inv(world(boneNode[s]))), Cinv));
        }
        const o = (f * bones + s) * 12;
        // Row r of the 3x4: (m[r], m[4+r], m[8+r], m[12+r]) in column-major.
        for (let r = 0; r < 3; r++) {
          palette[o + r * 4] = M[r]; palette[o + r * 4 + 1] = M[4 + r]; palette[o + r * 4 + 2] = M[8 + r]; palette[o + r * 4 + 3] = M[12 + r];
        }
      }
    }
  }
  if (!skinned) {
    // No rig and no clip: every joint collapses to slot 0, the identity.
    for (let v = 0; v < joints.length; v++) joints[v] = 0;
    for (let v = 0; v < weights.length; v += 4) { weights[v] = 1; weights[v + 1] = 0; weights[v + 2] = 0; weights[v + 3] = 0; }
  }
  return {
    name, positions, normals, joints, weights, indices, width: e.size[0], height: e.size[1], axis,
    guess: aNeg >= aPos ? '-' : '+', flip, bones, frames, duration, palette, clipName,
    boneParent, boneHead, chains,
    note: wantClip && tooManyBones ? `rig has ${boneNode.length - 1} joints, over ${MAX_BONES}: baked at rest` : '',
  };
}

// --- the bubble ----------------------------------------------------------------
// Not a model and not in tanks.csv: a procedural UV sphere, always in the
// pack, that the tanks emit when a body knocks the glass. It goes through the
// same pipeline as every creature — same camera, same tile clipping, same
// depth — so a bubble costs one more instance and no new pass. It is drawn
// flat white by the emissive flag the instance carries (fish.wgsl reads
// belly.w), because a lit sphere reads as a pearl and an unlit one reads as air.
//
// Length 1 along z like every other species, so the instance scale is a
// diameter and baitball.luau can size it the way it sizes a fish.
function sphere(rings = 8, segments = 12) {
  const positions = [], normals = [], indices = [], joints = [], weights = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    for (let s = 0; s <= segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      const x = Math.sin(phi) * Math.cos(theta);
      const y = Math.cos(phi);
      const z = Math.sin(phi) * Math.sin(theta);
      positions.push(x * 0.5, y * 0.5, z * 0.5);
      normals.push(x, y, z);
      joints.push(0, 0, 0, 0);
      weights.push(1, 0, 0, 0);
    }
  }
  const row = segments + 1;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * row + s, b = a + row;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return { name: 'bubble', positions, normals, joints, weights, indices, width: 1, height: 1, axis: 2, guess: '-', flip: false, bones: 1, frames: 1, duration: 0, palette: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]), clipName: '', boneParent: [], boneHead: [], chains: [], note: '' };
}

// --- --list ----------------------------------------------------------------------
if (LIST) {
  for (const [name] of species) {
    const file = join(MODELS, `${name}.glb`);
    if (!existsSync(file)) { console.log(`${name.padEnd(16)} (no glb)`); continue; }
    const { gltf } = loadGlb(file);
    const joints = (gltf.skins || []).reduce((a, s) => a + s.joints.length, 0);
    const clips = clipNames(gltf);
    console.log(`${name.padEnd(16)} ${String(joints).padStart(4)} joints  ${clips.length ? clips.map((c) => `${c.name} (${c.duration.toFixed(2)}s)`).join(' | ') : '-'}`);
  }
  process.exit(0);
}

// --- the pack ------------------------------------------------------------------
const baked = [sphere()];
for (const [name, { flip, clip }] of species) {
  try {
    baked.push(bake(name, flip, clip, rigOf.get(name) || []));
  } catch (err) {
    console.error(`SKIP ${name}: ${err.message}`);
  }
}
if (baked.length === 0) { console.error('nothing baked'); process.exit(1); }

let vtotal = 0, itotal = 0, ptotal = 0, btotal = 0, ctotal = 0;
for (const b of baked) {
  vtotal += b.positions.length / 3; itotal += b.indices.length; ptotal += b.palette.length;
  btotal += b.bones;
  for (const c of b.chains) ctotal += 2 + c.slots.length;
}
const HEADER = 32, REC = 80, VSTRIDE = 32, BREC = 16;
const out = Buffer.alloc(HEADER + baked.length * REC + vtotal * VSTRIDE + itotal * 4 + btotal * BREC + ctotal * 4 + ptotal * 4);
out.write('TNK3', 0, 'latin1');
out.writeUInt32LE(baked.length, 4); out.writeUInt32LE(vtotal, 8); out.writeUInt32LE(itotal, 12); out.writeUInt32LE(ptotal, 16);
out.writeUInt32LE(btotal, 20); out.writeUInt32LE(ctotal, 24);
let vo = 0, io = 0, po = 0, bo = 0, co = 0, o = HEADER + baked.length * REC;
const idxStart = o + vtotal * VSTRIDE;
const boneStart = idxStart + itotal * 4;
const chainStart = boneStart + btotal * BREC;
const palStart = chainStart + ctotal * 4;
baked.forEach((b, k) => {
  const r = HEADER + k * REC;
  out.fill(0, r, r + REC);
  out.write(b.name.slice(0, 23), r, 'latin1');
  const vc = b.positions.length / 3, ic = b.indices.length;
  out.writeUInt32LE(vo, r + 24); out.writeUInt32LE(vc, r + 28); out.writeUInt32LE(io, r + 32); out.writeUInt32LE(ic, r + 36);
  out.writeFloatLE(b.width, r + 40); out.writeFloatLE(b.height, r + 44);
  out.writeUInt32LE(b.bones, r + 48); out.writeUInt32LE(b.frames, r + 52); out.writeFloatLE(b.duration, r + 56); out.writeUInt32LE(po, r + 60);
  out.writeUInt32LE(bo, r + 64); out.writeUInt32LE(b.chains.length, r + 68); out.writeUInt32LE(co, r + 72);
  for (let v = 0; v < vc; v++) {
    for (let c = 0; c < 3; c++) { out.writeFloatLE(b.positions[v * 3 + c], o); o += 4; }
    for (let c = 0; c < 3; c++) { out.writeFloatLE(b.normals[v * 3 + c], o); o += 4; }
    for (let c = 0; c < 4; c++) { out.writeUInt8(Math.min(255, Math.max(0, b.joints[v * 4 + c] | 0)), o); o += 1; }
    // unorm8x4: the four must sum to 255 or the body shrinks by the rounding.
    const w = [0, 1, 2, 3].map((c) => Math.round(Math.min(1, Math.max(0, b.weights[v * 4 + c])) * 255));
    const sum = w[0] + w[1] + w[2] + w[3];
    if (sum !== 255 && sum > 0) { let big = 0; for (let c = 1; c < 4; c++) if (w[c] > w[big]) big = c; w[big] += 255 - sum; }
    else if (sum === 0) w[0] = 255;
    for (let c = 0; c < 4; c++) { out.writeUInt8(w[c], o); o += 1; }
  }
  let p = idxStart + io * 4;
  for (const i of b.indices) { out.writeUInt32LE(vo + i, p); p += 4; }
  // The bones: always one entry per palette slot, so `boneOffset + slot` is
  // the address whether the species is rigged or not.
  let bq = boneStart + bo * BREC;
  for (let sl = 0; sl < b.bones; sl++) {
    out.writeUInt32LE(b.boneParent.length ? b.boneParent[sl] : 0xFFFFFFFF, bq);
    for (let c = 0; c < 3; c++) out.writeFloatLE(b.boneHead.length ? b.boneHead[sl * 3 + c] : 0, bq + 4 + c * 4);
    bq += BREC;
  }
  let cq = chainStart + co * 4;
  for (const c of b.chains) {
    out.writeUInt32LE(c.role, cq); out.writeUInt32LE(c.slots.length, cq + 4); cq += 8;
    for (const sl of c.slots) { out.writeUInt32LE(sl, cq); cq += 4; }
  }
  let q = palStart + po * 4;
  for (const f of b.palette) { out.writeFloatLE(f, q); q += 4; }
  const skew = b.guess === '-' ? '' : ' (was +z, turned)';
  const clip = b.frames > 1 ? `  clip "${b.clipName}" ${b.frames}f/${b.duration.toFixed(2)}s ${b.bones - 1} bones` : (b.note ? `  ${b.note}` : '');
  const rig = b.chains.length ? `  RIG ${b.bones - 1} bones, ${b.chains.length} chains (${b.chains.reduce((a, c) => a + c.slots.length, 0)} sprung)` : '';
  console.log(`${b.name.padEnd(14)} ${String(vc).padStart(6)} verts ${String(ic / 3).padStart(6)} tris  long axis ${'xyz'[b.axis]}  w ${b.width.toFixed(2)} h ${b.height.toFixed(2)}  head guessed at ${b.guess}z${skew}${b.flip ? '  FLIPPED by csv' : ''}${clip}${rig}`);
  vo += vc; io += ic; po += b.palette.length; bo += b.bones;
  for (const c of b.chains) co += 2 + c.slots.length;
});
writeFileSync(OUT, out);
console.log(`wrote ${OUT}: ${baked.length} species, ${vtotal} verts, ${itotal / 3} tris, ${(ptotal * 4 / 1024).toFixed(0)} KB of clips, ${btotal} bones in ${baked.reduce((a, b) => a + b.chains.length, 0)} chains, ${(out.length / 1024).toFixed(0)} KB`);
console.log('CHECK the render: the nose must lead the motion. baitball.luau assumes the head at -z and the length 1.');
