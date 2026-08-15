// Reading and writing .glb without three.js, a DOM or a GPU.
//
// tools/lib/obj-glb.mjs writes one, but only the simple kind it needed: one
// primitive, one material, no skin. This is the other half — a reader that
// hands back decoded attributes with the node transforms already applied, and a
// writer that can emit JOINTS_0/WEIGHTS_0 and a skin. Between them a static
// mesh can be picked up, given a skeleton and put back down.
//
// The loader-based route is not an option here: GLTFLoader hangs in this
// project's headless stub (see tools/dom-stub.mjs), and everything below is
// arithmetic on typed arrays that never needed a renderer in the first place.
import { readFileSync, writeFileSync } from 'node:fs';

const COMPONENT = {
  5120: { array: Int8Array, size: 1 },
  5121: { array: Uint8Array, size: 1 },
  5122: { array: Int16Array, size: 2 },
  5123: { array: Uint16Array, size: 2 },
  5125: { array: Uint32Array, size: 4 },
  5126: { array: Float32Array, size: 4 },
};
const COUNTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

// ---------------------------------------------------------------------------
// Matrices — column-major, the layout glTF and three.js both use on the wire
// ---------------------------------------------------------------------------

export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function matMul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

/** A node's local matrix, from either its baked `matrix` or its T/R/S. */
export function nodeMatrix(n) {
  if (n.matrix) return n.matrix.slice();
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

export function transformPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** Directions ignore translation. Correct for normals only when the matrix has
 *  no non-uniform scale, which is the case for every import chain here. */
export function transformDir(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2],
  ];
}

/** Inverse of a translation+rotation matrix (no scale). Enough for the inverse
 *  bind matrices below, whose bones are built without scale on purpose. */
export function invertRigid(m) {
  const r = [
    m[0], m[4], m[8], 0,
    m[1], m[5], m[9], 0,
    m[2], m[6], m[10], 0,
    0, 0, 0, 1,
  ];
  const t = [m[12], m[13], m[14]];
  r[12] = -(r[0] * t[0] + r[4] * t[1] + r[8] * t[2]);
  r[13] = -(r[1] * t[0] + r[5] * t[1] + r[9] * t[2]);
  r[14] = -(r[2] * t[0] + r[6] * t[1] + r[10] * t[2]);
  return r;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function readGlb(file) {
  const buf = readFileSync(file);
  if (buf.toString('utf8', 0, 4) !== 'glTF') throw new Error(`${file} is not a .glb`);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
  // The BIN chunk follows the JSON chunk, each with its own 8-byte header.
  const binStart = 20 + jsonLen + 8;
  const binLen = buf.readUInt32LE(20 + jsonLen);
  const bin = buf.subarray(binStart, binStart + binLen);
  return { json, bin, buf };
}

/** Decode one accessor into a flat JS array. Sparse accessors are not handled —
 *  nothing in this project's art ships them, and a silent wrong answer would be
 *  worse than the throw. */
export function readAccessor({ json, bin }, index) {
  const acc = json.accessors[index];
  if (acc.sparse) throw new Error('sparse accessors are not supported');
  const comp = COMPONENT[acc.componentType];
  const n = COUNTS[acc.type];
  const out = new Array(acc.count * n);
  if (acc.bufferView === undefined) return out.fill(0);
  const view = json.bufferViews[acc.bufferView];
  const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = view.byteStride ?? comp.size * n;
  for (let i = 0; i < acc.count; i++) {
    const at = base + i * stride;
    for (let k = 0; k < n; k++) {
      const o = at + k * comp.size;
      let v;
      switch (acc.componentType) {
        case 5120: v = bin.readInt8(o); break;
        case 5121: v = bin.readUInt8(o); break;
        case 5122: v = bin.readInt16LE(o); break;
        case 5123: v = bin.readUInt16LE(o); break;
        case 5125: v = bin.readUInt32LE(o); break;
        default: v = bin.readFloatLE(o);
      }
      out[i * n + k] = v;
    }
  }
  return out;
}

/**
 * Every primitive in the file, with node transforms applied and merged into
 * ONE set of buffers.
 *
 * Merging rather than preserving the node tree is deliberate: a rig has to be
 * one skinned mesh (systems/humanoidRig.js measures the first one it finds, and
 * a figure split across two would be half-measured), and baking the world
 * transform in means the skinned mesh can sit at the scene root where the
 * spec's "ignore the node transform" rule cannot bite.
 *
 * Only primitives sharing `material` are merged; a file with more than one is
 * rejected rather than quietly losing a material.
 */
export function flattenMesh(glb) {
  const { json } = glb;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  let material = null;

  const walk = (idx, parent) => {
    const n = json.nodes[idx];
    const world = matMul(parent, nodeMatrix(n));
    if (n.mesh !== undefined) {
      for (const prim of json.meshes[n.mesh].primitives ?? []) {
        if (material == null) material = prim.material ?? null;
        else if ((prim.material ?? null) !== material) {
          throw new Error('more than one material — merging would lose one');
        }
        const p = readAccessor(glb, prim.attributes.POSITION);
        const nrm = prim.attributes.NORMAL !== undefined
          ? readAccessor(glb, prim.attributes.NORMAL) : null;
        const uv = prim.attributes.TEXCOORD_0 !== undefined
          ? readAccessor(glb, prim.attributes.TEXCOORD_0) : null;
        const idxs = prim.indices !== undefined ? readAccessor(glb, prim.indices) : null;

        const base = positions.length / 3;
        const count = p.length / 3;
        for (let i = 0; i < count; i++) {
          const w = transformPoint(world, [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]);
          positions.push(w[0], w[1], w[2]);
          if (nrm) {
            const d = transformDir(world, [nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]]);
            const len = Math.hypot(d[0], d[1], d[2]) || 1;
            normals.push(d[0] / len, d[1] / len, d[2] / len);
          } else normals.push(0, 1, 0);
          uvs.push(uv ? uv[i * 2] : 0, uv ? uv[i * 2 + 1] : 0);
        }
        if (idxs) for (const i of idxs) indices.push(base + i);
        else for (let i = 0; i < count; i++) indices.push(base + i);
      }
    }
    for (const c of n.children ?? []) walk(c, world);
  };
  for (const s of json.scenes[json.scene ?? 0].nodes) walk(s, IDENTITY);

  return { positions, normals, uvs, indices, material };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const pad4 = (n) => (n + 3) & ~3;

/**
 * Write a single-primitive .glb, optionally skinned.
 *
 * `bones` is a flat list of { name, parent, position } in the SAME space as the
 * positions — world space, since flattenMesh baked the transforms in. Their
 * inverse bind matrices are derived here rather than passed, because they are
 * not an independent fact: a bind matrix that disagrees with where the bone
 * actually is deforms the mesh on load with nothing to point at.
 *
 * `images`/`textures`/`samplers`/`materials` are copied verbatim from a source
 * file's JSON, with image bytes handed over in `imageData`.
 */
export function writeSkinnedGlb({
  positions, normals, uvs, indices,
  joints = null, weights = null, bones = null,
  images = [], imageData = [], textures = [], samplers = [], materials = [],
  name = 'Mesh', out,
}) {
  const chunks = []; // { data, target? } -> bufferViews in order
  const views = [];
  const accessors = [];
  let offset = 0;

  const addView = (data, target) => {
    const byteOffset = offset;
    chunks.push(data);
    views.push({ buffer: 0, byteOffset, byteLength: data.byteLength, ...(target ? { target } : {}) });
    offset += pad4(data.byteLength);
    return views.length - 1;
  };
  const addAccessor = (data, componentType, type, count, target, extra = {}) => {
    accessors.push({
      bufferView: addView(data, target), componentType, count, type, ...extra,
    });
    return accessors.length - 1;
  };

  const minMax = (arr, n) => {
    const min = new Array(n).fill(Infinity);
    const max = new Array(n).fill(-Infinity);
    for (let i = 0; i < arr.length; i += n) {
      for (let k = 0; k < n; k++) {
        if (arr[i + k] < min[k]) min[k] = arr[i + k];
        if (arr[i + k] > max[k]) max[k] = arr[i + k];
      }
    }
    return { min, max };
  };

  const pos = new Float32Array(positions);
  const attributes = {
    POSITION: addAccessor(Buffer.from(pos.buffer), 5126, 'VEC3', positions.length / 3, 34962,
      minMax(positions, 3)),
    NORMAL: addAccessor(Buffer.from(new Float32Array(normals).buffer), 5126, 'VEC3', normals.length / 3, 34962),
    TEXCOORD_0: addAccessor(Buffer.from(new Float32Array(uvs).buffer), 5126, 'VEC2', uvs.length / 2, 34962),
  };
  if (joints && weights) {
    attributes.JOINTS_0 = addAccessor(Buffer.from(new Uint16Array(joints).buffer), 5123, 'VEC4', joints.length / 4, 34962);
    attributes.WEIGHTS_0 = addAccessor(Buffer.from(new Float32Array(weights).buffer), 5126, 'VEC4', weights.length / 4, 34962);
  }
  // 32-bit indices only when they are actually needed — a 16-bit index buffer
  // is half the size and every mesh here that fits should get one.
  const big = positions.length / 3 > 65535;
  const idxAcc = addAccessor(
    Buffer.from((big ? new Uint32Array(indices) : new Uint16Array(indices)).buffer),
    big ? 5125 : 5123, 'SCALAR', indices.length, 34963,
  );

  const nodes = [];
  const meshNode = { mesh: 0, name };
  nodes.push(meshNode);
  const sceneNodes = [0];

  const json = {
    asset: { version: '2.0', generator: 'seal-survivor tools/lib/glb.mjs' },
    scene: 0,
    scenes: [{ nodes: sceneNodes }],
    nodes,
    meshes: [{ name, primitives: [{ attributes, indices: idxAcc, ...(materials.length ? { material: 0 } : {}) }] }],
  };

  if (bones?.length) {
    // Bones are written with LOCAL translations (each relative to its parent),
    // which is what a node tree stores — the caller thinks in world positions
    // because that is what a measurement produces.
    const boneNode = new Map();
    bones.forEach((b, i) => {
      const parentPos = b.parent == null ? [0, 0, 0] : bones[b.parent].position;
      nodes.push({
        name: b.name,
        translation: [
          b.position[0] - parentPos[0],
          b.position[1] - parentPos[1],
          b.position[2] - parentPos[2],
        ],
      });
      boneNode.set(i, nodes.length - 1);
    });
    bones.forEach((b, i) => {
      if (b.parent == null) return;
      const p = nodes[boneNode.get(b.parent)];
      (p.children ??= []).push(boneNode.get(i));
    });
    // Roots join the scene so the skeleton is reachable from it.
    bones.forEach((b, i) => { if (b.parent == null) sceneNodes.push(boneNode.get(i)); });

    // No rotation anywhere in the chain, so a bone's world matrix is a pure
    // translation and its inverse bind matrix is the negation of it.
    const ibm = new Float32Array(bones.length * 16);
    bones.forEach((b, i) => {
      const m = invertRigid([
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
        b.position[0], b.position[1], b.position[2], 1,
      ]);
      ibm.set(m, i * 16);
    });
    json.skins = [{
      joints: bones.map((_, i) => boneNode.get(i)),
      inverseBindMatrices: addAccessor(Buffer.from(ibm.buffer), 5126, 'MAT4', bones.length),
      skeleton: boneNode.get(bones.findIndex((b) => b.parent == null)),
    }];
    meshNode.skin = 0;
  }

  if (images.length) {
    json.images = images.map((img, i) => ({
      mimeType: img.mimeType,
      bufferView: addView(imageData[i]),
    }));
    json.samplers = samplers;
    json.textures = textures;
  }
  if (materials.length) json.materials = materials;

  json.bufferViews = views;
  json.accessors = accessors;
  json.buffers = [{ byteLength: offset }];

  const binBody = Buffer.alloc(offset);
  let at = 0;
  for (const c of chunks) {
    c.copy(binBody, at);
    at += pad4(c.byteLength);
  }

  const jsonText = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = Buffer.alloc(pad4(jsonText.length) - jsonText.length, 0x20);
  const jsonChunk = Buffer.concat([jsonText, jsonPad]);

  const header = Buffer.alloc(12);
  header.write('glTF', 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binBody.length, 8);

  const jsonHead = Buffer.alloc(8);
  jsonHead.writeUInt32LE(jsonChunk.length, 0);
  jsonHead.write('JSON', 4);
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(binBody.length, 0);
  binHead.write('BIN\0', 4);

  const glb = Buffer.concat([header, jsonHead, jsonChunk, binHead, binBody]);
  if (out) writeFileSync(out, glb);
  return glb;
}

/** The raw bytes behind an image entry, for handing to writeSkinnedGlb. */
export function imageBytes({ json, bin }, img) {
  const v = json.bufferViews[img.bufferView];
  return Buffer.from(bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength));
}
