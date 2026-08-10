// Which vertical orientation does a model's UV layout actually want?
//
// A texture is applied through two conventions that must agree: the mesh's UV
// origin and the texture's `flipY`. GLTFLoader sets flipY = false because glTF
// UVs are top-left origin; FBXLoader sets nothing, so an FBX keeps the
// THREE.Texture default of true. Forcing one value for both mirrors the map
// vertically on half the roster, and a mirrored mask still looks like a
// plausible mask — which is why this measures instead of reasoning.
//
//   node tools/uv-flip-check.mjs public/models/seagull.fbx "$HOME/Documents/..."
//
// It rasterises the model's own mapped UV triangles onto the art sheet in both
// orientations and reports what fraction of the mapped area lands on sheet
// BACKGROUND. The correct orientation is the one that lands on the art.
import './dom-stub.mjs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const FILE = process.argv[2];
const ART = process.argv[3];
if (!FILE || !ART) {
  console.error('usage: node tools/uv-flip-check.mjs <model> <base-colour art>');
  process.exit(1);
}

const buf = readFileSync(FILE);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
let root;
if (FILE.endsWith('.fbx')) root = new FBXLoader().parse(ab, '');
else root = (await new GLTFLoader().parseAsync(ab, '')).scene;

// What the loader left on the model's own base-colour map, if it has one.
const seen = new Set();
root.traverse((o) => {
  for (const m of [o.material].flat().filter(Boolean)) {
    if (m.map) seen.add(`${m.name || m.type}.map.flipY = ${m.map.flipY}`);
  }
});
console.log(`loader default flipY on this model's own maps: ${seen.size ? [...seen].join(', ') : '(model carries no usable base-colour map)'}`);

const N = 512;
const cover = new Uint8Array(N * N);
function raster(uvs, idx, flip) {
  const tri = (a, b, c) => {
    const pts = [a, b, c].map(([u, v]) => [u * N, (flip ? 1 - v : v) * N]);
    const minx = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[0]))));
    const maxx = Math.min(N - 1, Math.ceil(Math.max(...pts.map((p) => p[0]))));
    const miny = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1]))));
    const maxy = Math.min(N - 1, Math.ceil(Math.max(...pts.map((p) => p[1]))));
    const [[x0, y0], [x1, y1], [x2, y2]] = pts;
    const d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (Math.abs(d) < 1e-12) return;
    for (let y = miny; y <= maxy; y++) {
      for (let x = minx; x <= maxx; x++) {
        const px = x + 0.5, py = y + 0.5;
        const l1 = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / d;
        const l2 = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / d;
        const l3 = 1 - l1 - l2;
        if (l1 >= 0 && l2 >= 0 && l3 >= 0) cover[y * N + x] = 1;
      }
    }
  };
  for (let i = 0; i < idx.length; i += 3) {
    tri(uvs[idx[i]], uvs[idx[i + 1]], uvs[idx[i + 2]]);
  }
}

function collect() {
  const out = [];
  root.traverse((o) => {
    const g = o.geometry;
    if (!g?.attributes?.uv) return;
    const uv = g.attributes.uv;
    const uvs = [];
    for (let i = 0; i < uv.count; i++) uvs.push([uv.getX(i), uv.getY(i)]);
    const idx = g.index ? Array.from(g.index.array) : uvs.map((_, i) => i);
    out.push({ uvs, idx });
  });
  return out;
}

const meshes = collect();
console.log(`${meshes.length} mesh(es), ${meshes.reduce((a, m) => a + m.idx.length / 3, 0)} triangles`);

// Sheet background: the art's near-black (or near-uniform corner) region. Take
// the corner colour as the background reference — UV atlases pad with it.
const art = await sharp(ART).resize(N, N, { fit: 'fill' }).greyscale().raw().toBuffer();
const corner = art[0];
const isBg = (v) => Math.abs(v - corner) <= 8;
let bgTotal = 0;
for (const v of art) if (isBg(v)) bgTotal++;
console.log(`art background reference = ${corner} (${(100 * bgTotal / art.length).toFixed(1)}% of the sheet)`);

for (const flip of [false, true]) {
  cover.fill(0);
  for (const m of meshes) raster(m.uvs, m.idx, flip);
  let mapped = 0, onBg = 0;
  for (let i = 0; i < cover.length; i++) {
    if (!cover[i]) continue;
    mapped++;
    if (isBg(art[i])) onBg++;
  }
  const label = flip ? 'flipY = true  (V flipped, FBX convention)' : 'flipY = false (V as-is,   glTF convention)';
  console.log(`${label}: ${(100 * mapped / cover.length).toFixed(1)}% of sheet mapped, ${(100 * onBg / mapped).toFixed(1)}% of mapped area on BACKGROUND`);
}
