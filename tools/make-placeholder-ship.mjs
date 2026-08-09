// Generates public/models/ship.gltf — a low-poly placeholder so the model
// pipeline works out of the box. Replace that file with your own .glb/.gltf.
// Run with: node tools/make-placeholder-ship.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../public/models/ship.gltf');

// glTF convention: +Y up, -Z forward. The loader re-orients this for the game.
const verts = [
  [0, 0, -1.0],    // 0 nose
  [-0.62, 0, 0.55], // 1 left wingtip
  [0.62, 0, 0.55],  // 2 right wingtip
  [0, 0, 0.3],      // 3 tail notch
  [0, 0.24, -0.05], // 4 dorsal ridge
  [0, -0.14, -0.05],// 5 keel
];

const tris = [
  [0, 1, 4], [0, 4, 2], [4, 1, 3], [4, 3, 2], // upper hull
  [0, 5, 1], [0, 2, 5], [5, 3, 1], [5, 2, 3], // lower hull
];

// Smooth vertex normals from accumulated face normals.
const normals = verts.map(() => [0, 0, 0]);
for (const [a, b, c] of tris) {
  const u = sub(verts[b], verts[a]);
  const v = sub(verts[c], verts[a]);
  const n = cross(u, v);
  for (const i of [a, b, c]) {
    normals[i][0] += n[0];
    normals[i][1] += n[1];
    normals[i][2] += n[2];
  }
}
for (const n of normals) {
  const len = Math.hypot(...n) || 1;
  n[0] /= len; n[1] /= len; n[2] /= len;
}

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

const POS_BYTES = verts.length * 3 * 4;
const NRM_BYTES = normals.length * 3 * 4;
const IDX_COUNT = tris.length * 3;
const IDX_BYTES = IDX_COUNT * 2;
const IDX_OFFSET = POS_BYTES + NRM_BYTES; // 144, already 4-byte aligned

const buffer = Buffer.alloc(IDX_OFFSET + IDX_BYTES);
let o = 0;
for (const v of verts) for (const c of v) { buffer.writeFloatLE(c, o); o += 4; }
for (const n of normals) for (const c of n) { buffer.writeFloatLE(c, o); o += 4; }
for (const t of tris) for (const i of t) { buffer.writeUInt16LE(i, o); o += 2; }

const min = [0, 1, 2].map((i) => Math.min(...verts.map((v) => v[i])));
const max = [0, 1, 2].map((i) => Math.max(...verts.map((v) => v[i])));

const gltf = {
  asset: { version: '2.0', generator: 'placeholder-ship' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: 'Ship' }],
  meshes: [{ name: 'Ship', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
  materials: [
    {
      name: 'Hull',
      doubleSided: true,
      pbrMetallicRoughness: {
        baseColorFactor: [0.478, 0.843, 1.0, 1.0],
        metallicFactor: 0.2,
        roughnessFactor: 0.35,
      },
      emissiveFactor: [0.06, 0.28, 0.36],
    },
  ],
  accessors: [
    { bufferView: 0, componentType: 5126, count: verts.length, type: 'VEC3', min, max },
    { bufferView: 1, componentType: 5126, count: normals.length, type: 'VEC3' },
    { bufferView: 2, componentType: 5123, count: IDX_COUNT, type: 'SCALAR' },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: POS_BYTES, target: 34962 },
    { buffer: 0, byteOffset: POS_BYTES, byteLength: NRM_BYTES, target: 34962 },
    { buffer: 0, byteOffset: IDX_OFFSET, byteLength: IDX_BYTES, target: 34963 },
  ],
  buffers: [
    {
      byteLength: buffer.length,
      uri: `data:application/octet-stream;base64,${buffer.toString('base64')}`,
    },
  ],
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(gltf, null, 2));
console.log(`wrote ${out} (${verts.length} verts, ${tris.length} tris, ${buffer.length} byte buffer)`);
