// Turns the raw Sketchfab grass download into something the game can scatter.
//
//   node tools/optimize-grass.mjs [source.glb] [out.glb]
//
// The source (game_ready_grass.glb) is 18 meshes across 4 materials, and four
// of those meshes are junk: single quads floating at world Y ~2.85 carrying one
// texture each. They are the swatch previews Sketchfab authors leave in the
// scene, and they matter more than their 8 triangles suggest — assets.js sizes
// a model by normalising its LONGEST bounding-box axis to `fit`, and the
// swatches stretch the box from ~2.2 units tall to 7.16. Left in, the grass
// would render at roughly a third of the size asked for, with a column of empty
// space above it.
//
// What this does, in order:
//   1. drops the four swatch quads
//   2. bakes the node transforms (the source nests a 0.01 scale under
//      per-clump scales of 117–387, which is nobody's idea of readable)
//   3. packs the four 512x1024 blade textures into one 2048x1024 strip and
//      remaps u into its slot — the source UVs sit inside 0.19..0.83, so there
//      is no tiling to break and a half-cell of natural gutter at every seam
//   4. merges everything into ONE indexed mesh with ONE material: 18 draw
//      calls to 1, which is the whole point if this is going to be scattered
//   5. reseats the clump so its base sits at y=0 and it is centred on x/z, so
//      placing it means setting the seabed height and nothing else
//   6. writes alphaMode MASK instead of BLEND
//
// BLEND is wrong for alpha-cut foliage: it sorts per-draw, so blades render
// through each other depending on camera angle, and it costs overdraw for an
// edge that is a hard cut in the source art anyway. MASK is the standard.
//
// doubleSided STAYS true. That is a defect on a solid model and correct here —
// these are flat cards, and culling their back faces deletes every blade facing
// away from the camera.
//
// uv.y is left exactly as it is, because systems/grassSway.js reads it as the
// root-to-tip mask. See the note there before touching anything about uv.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const SRC = process.argv[2]
  ?? '/Users/ethangoldhammer/Documents/_DesignSystems/SealSurvivor/game_ready_grass.glb';
const OUT = process.argv[3]
  ?? path.join(process.cwd(), 'public/models/grass.glb');

const ATLAS_COLS = 4;       // four source textures, side by side
const CELL_W = 512, CELL_H = 1024;

// ---------------------------------------------------------------- glb reading

function readGLB(file) {
  const buf = fs.readFileSync(file);
  let o = 12, json = null, bin = null;
  while (o < buf.length) {
    const len = buf.readUInt32LE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    if (type === 'JSON') json = JSON.parse(buf.toString('utf8', o + 8, o + 8 + len));
    if (type.startsWith('BIN')) bin = buf.subarray(o + 8, o + 8 + len);
    o += 8 + len;
  }
  return { json, bin, bytes: buf.length };
}

const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NUM_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(json, bin, index) {
  const acc = json.accessors[index];
  const n = NUM_COMPONENTS[acc.type];
  const Ctor = COMPONENT[acc.componentType];
  const out = new Float32Array(acc.count * n);
  if (acc.bufferView == null) return out; // sparse/zero-filled
  const view = json.bufferViews[acc.bufferView];
  const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = view.byteStride ?? 0;
  const elemBytes = Ctor.BYTES_PER_ELEMENT;
  for (let i = 0; i < acc.count; i++) {
    const at = stride ? base + i * stride : base + i * n * elemBytes;
    for (let c = 0; c < n; c++) {
      const byteAt = at + c * elemBytes;
      let v;
      switch (acc.componentType) {
        case 5126: v = bin.readFloatLE(byteAt); break;
        case 5125: v = bin.readUInt32LE(byteAt); break;
        case 5123: v = bin.readUInt16LE(byteAt); break;
        case 5122: v = bin.readInt16LE(byteAt); break;
        case 5121: v = bin.readUInt8(byteAt); break;
        case 5120: v = bin.readInt8(byteAt); break;
        default: throw new Error('componentType ' + acc.componentType);
      }
      out[i * n + c] = v;
    }
  }
  return out;
}

// ------------------------------------------------------------------ transforms

function composeTRS(node) {
  if (node.matrix) return node.matrix.slice();
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

const mulMat = (a, b) => { // column-major, returns a*b (b applied first)
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
};
const applyPoint = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];
// Normals need the inverse-transpose. Every transform in this file is a
// similarity (uniform scale + rotation + translation), so the rotation part
// renormalised is exactly that, without inverting anything.
const applyDir = (m, x, y, z) => {
  const v = [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
  const len = Math.hypot(...v) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
};

// ---------------------------------------------------------------------- main

const { json, bin, bytes: srcBytes } = readGLB(SRC);

// Walk the node tree, accumulating world matrices for every mesh instance.
const instances = [];
(function walk(nodeIndex, parentMatrix, nameTrail) {
  const node = json.nodes[nodeIndex];
  const world = mulMat(parentMatrix, composeTRS(node));
  const trail = node.name ? [...nameTrail, node.name] : nameTrail;
  if (node.mesh != null) instances.push({ mesh: node.mesh, world, trail, name: node.name ?? '' });
  for (const child of node.children ?? []) walk(child, world, trail);
})(json.scenes[json.scene ?? 0].nodes[0], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], []);

// The swatch quads: named exactly `trasparent_grassN` with no numeric suffix,
// 2 triangles, parked well above the clumps. Matching on all three rather than
// on the name alone, so a re-export that renames things fails loudly here
// instead of silently shipping the swatches again.
const isSwatch = (inst) => {
  const parent = inst.trail[inst.trail.length - 2] ?? '';
  // The source spells them with a space and a typo ("trasparent grass4");
  // three.js sanitises the space to an underscore when it builds the scene
  // graph, so accept either and don't "fix" the typo.
  if (!/^trasparent[ _]grass[1-4]$/.test(parent)) return false;
  const prim = json.meshes[inst.mesh].primitives[0];
  const triCount = json.accessors[prim.indices].count / 3;
  return triCount <= 2 && applyPoint(inst.world, 0, 0, 0)[1] > 2;
};

const swatches = instances.filter(isSwatch);
const keep = instances.filter((i) => !isSwatch(i));
if (swatches.length !== 4) {
  throw new Error(`expected 4 swatch quads, matched ${swatches.length} — source layout changed, re-inspect before trusting this script`);
}

// material index -> atlas slot, in a stable order
const materialSlot = new Map();
for (const inst of keep) {
  for (const prim of json.meshes[inst.mesh].primitives) {
    if (!materialSlot.has(prim.material)) materialSlot.set(prim.material, materialSlot.size);
  }
}
if (materialSlot.size > ATLAS_COLS) throw new Error(`${materialSlot.size} materials, atlas has ${ATLAS_COLS} slots`);

// Flatten every kept primitive into one vertex/index stream.
const positions = [], normals = [], uvs = [], indices = [];
let vertexBase = 0, triTotal = 0;
for (const inst of keep) {
  for (const prim of json.meshes[inst.mesh].primitives) {
    const pos = readAccessor(json, bin, prim.attributes.POSITION);
    const nrm = prim.attributes.NORMAL != null ? readAccessor(json, bin, prim.attributes.NORMAL) : null;
    const uv = readAccessor(json, bin, prim.attributes.TEXCOORD_0);
    const idx = readAccessor(json, bin, prim.indices);
    const slot = materialSlot.get(prim.material);
    const count = pos.length / 3;
    for (let i = 0; i < count; i++) {
      const [x, y, z] = applyPoint(inst.world, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      positions.push(x, y, z);
      if (nrm) { const [nx, ny, nz] = applyDir(inst.world, nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]); normals.push(nx, ny, nz); }
      else normals.push(0, 1, 0);
      // u into the atlas slot; v untouched — grassSway.js depends on it
      uvs.push((uv[i * 2] + slot) / ATLAS_COLS, uv[i * 2 + 1]);
    }
    for (let i = 0; i < idx.length; i++) indices.push(idx[i] + vertexBase);
    vertexBase += count;
    triTotal += idx.length / 3;
  }
}

// Reseat: base to y=0, centred on x/z. Placing it is then "set the seabed Y".
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (let i = 0; i < positions.length; i += 3) {
  minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
  minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1]);
  minZ = Math.min(minZ, positions[i + 2]); maxZ = Math.max(maxZ, positions[i + 2]);
}
const shift = [-(minX + maxX) / 2, -minY, -(minZ + maxZ) / 2];
for (let i = 0; i < positions.length; i += 3) {
  positions[i] += shift[0]; positions[i + 1] += shift[1]; positions[i + 2] += shift[2];
}
const bbMin = [minX + shift[0], 0, minZ + shift[2]];
const bbMax = [maxX + shift[0], maxY + shift[1], maxZ + shift[2]];

if (vertexBase > 65535) throw new Error('vertex count exceeds UNSIGNED_SHORT indices');

// ------------------------------------------------------------------- atlas

const slotImages = [...materialSlot.entries()].sort((a, b) => a[1] - b[1]).map(([mat]) => {
  const texIndex = json.materials[mat].pbrMetallicRoughness?.baseColorTexture?.index;
  const src = json.textures[texIndex].source;
  const view = json.bufferViews[json.images[src].bufferView];
  return bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
});

const composited = await Promise.all(slotImages.map(async (b, i) => ({
  input: await sharp(b).resize(CELL_W, CELL_H, { fit: 'fill' }).png().toBuffer(),
  left: i * CELL_W,
  top: 0,
})));

const atlas = await sharp({
  create: { width: CELL_W * ATLAS_COLS, height: CELL_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite(composited)
  // palette+dither keeps the blade art readable at a fraction of the bytes;
  // the alpha channel survives, which is the one thing JPEG could not do here
  .png({ palette: true, quality: 90, effort: 10 })
  .toBuffer();

// ---------------------------------------------------------------- glb writing

const pad4 = (n) => (4 - (n % 4)) % 4;
const chunks = [];
let offset = 0;
const pushView = (buf, extra = {}) => {
  const padded = Buffer.concat([buf, Buffer.alloc(pad4(buf.length))]);
  chunks.push(padded);
  const view = { buffer: 0, byteOffset: offset, byteLength: buf.length, ...extra };
  offset += padded.length;
  return view;
};

const f32 = (arr) => Buffer.from(new Float32Array(arr).buffer);
const u16 = (arr) => Buffer.from(new Uint16Array(arr).buffer);

const views = [
  pushView(f32(positions), { target: 34962 }),
  pushView(f32(normals), { target: 34962 }),
  pushView(f32(uvs), { target: 34962 }),
  pushView(u16(indices), { target: 34963 }),
  pushView(atlas),
];

const outJson = {
  asset: { version: '2.0', generator: 'seal-survivor tools/optimize-grass.mjs' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: 'grass' }],
  meshes: [{ name: 'grass', primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
  materials: [{
    name: 'grass',
    alphaMode: 'MASK',
    alphaCutoff: 0.35,
    doubleSided: true, // deliberate — see header
    pbrMetallicRoughness: {
      baseColorTexture: { index: 0 },
      metallicFactor: 0,
      roughnessFactor: 0.9,
    },
  }],
  textures: [{ source: 0, sampler: 0 }],
  images: [{ bufferView: 4, mimeType: 'image/png' }],
  // CLAMP on both axes: the atlas packs four cells into one image, and REPEAT
  // on a filtered edge would fetch the neighbouring blade's pixels.
  samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: vertexBase, type: 'VEC3', min: bbMin, max: bbMax },
    { bufferView: 1, componentType: 5126, count: vertexBase, type: 'VEC3' },
    { bufferView: 2, componentType: 5126, count: vertexBase, type: 'VEC2' },
    { bufferView: 3, componentType: 5123, count: indices.length, type: 'SCALAR' },
  ],
  bufferViews: views,
  buffers: [{ byteLength: offset }],
};

const jsonBuf = Buffer.from(JSON.stringify(outJson), 'utf8');
const jsonPad = Buffer.concat([jsonBuf, Buffer.alloc(pad4(jsonBuf.length), 0x20)]);
const binBuf = Buffer.concat(chunks);

const header = Buffer.alloc(12);
header.write('glTF', 0, 'ascii');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonPad.length + 8 + binBuf.length, 8);
const jsonHeader = Buffer.alloc(8); jsonHeader.writeUInt32LE(jsonPad.length, 0); jsonHeader.write('JSON', 4, 'ascii');
const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(binBuf.length, 0); binHeader.write('BIN\0', 4, 'ascii');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([header, jsonHeader, jsonPad, binHeader, binBuf]));

const mb = (b) => (b / 1e6).toFixed(3) + 'MB';
const out = fs.statSync(OUT);
console.log(`source  ${path.basename(SRC)}  ${mb(srcBytes)}  18 meshes / 4 materials / 4 draw calls`);
console.log(`dropped ${swatches.length} swatch quads: ${swatches.map((s) => s.trail[s.trail.length - 2]).join(', ')}`);
console.log(`written ${OUT}  ${mb(out.size)}`);
console.log(`        ${triTotal} tris / ${vertexBase} verts / 1 mesh / 1 material / 1 draw call`);
console.log(`        atlas ${CELL_W * ATLAS_COLS}x${CELL_H} = ${mb(atlas.length)}`);
console.log(`        bbox ${(bbMax[0] - bbMin[0]).toFixed(2)} x ${bbMax[1].toFixed(2)} x ${(bbMax[2] - bbMin[2]).toFixed(2)}, base at y=0`);
