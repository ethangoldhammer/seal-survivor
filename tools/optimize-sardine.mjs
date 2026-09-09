#!/usr/bin/env node
// ---------------------------------------------------------------------------
// TURNS THE SARDINE DOWNLOAD INTO THE SARDINE SWIRL'S BODY.
//
//   node tools/optimize-sardine.mjs            # measure, write nothing
//   node tools/optimize-sardine.mjs --write    # write public/models/sardine.glb
//   node tools/optimize-sardine.mjs --tris=500 --error=0.02   # try a number
//
// The swirl draws eight to twenty-four of these at once, all of them moving,
// all of them small: `fit` x assets.csv's `size` puts one body at about 1.25
// world units against a camera framing 52 (CONFIG.arena.viewHeight), so a
// sardine is roughly 26 pixels long at 1080p and 80 at cinecam's zoomMax. That
// is the whole budget, and it is why the numbers below are as hard as they are
// — the school is a texture, not a model anyone reads.
//
// WHAT THE SOURCE IS. 2,132 triangles, one material, one 1024-square PNG at
// 536KB, no skin and no clips — a clean Sketchfab fish with the usual four
// pieces of waste on it:
//
//   1. FOUR IDENTICAL UV SETS. TEXCOORD_1..3 are byte-for-byte TEXCOORD_0
//      (measured, not assumed — see trimAttributes), and the material reads
//      slot 0. Three copies of a vec2 per vertex for nothing.
//
//   2. THE SKETCHFAB NODE CHAIN. Sketchfab_model / .fbx / RootNode / Sphere,
//      carrying two rotations that cancel and one that does not, plus a
//      non-uniform scale of (0.023, 0.016, 0.016) — the artist's lateral
//      squash, which is real and is baked rather than dropped. Flattened, so
//      that anybody measuring this file measures the fish.
//
//   3. doubleSided. The mesh is a closed manifold — 3,198 edges, every one of
//      them shared by exactly two triangles, no boundary and nothing
//      non-manifold — so there is no fin card here that back-face culling
//      would delete. It is a Sketchfab default costing overdraw on every body
//      in the school, and it goes.
//
//   4. A 1024 MAP. VRAM is w*h*4*4/3 whatever the file costs (see
//      tools/texture-budget.mjs), so the source holds 5.6MB for a fish that
//      can show 80 texels across at the most zoomed-in frame in the game.
//
// AND WHAT IS DELIBERATELY NOT DONE: the UVs sit inside v 0.035..0.572, so the
// bottom 43% of the map is empty backdrop and a crop would buy a sharper fish
// for the same VRAM. It is not worth the risk — remapping v is the one edit on
// this path that fails silently and asymmetrically (see the note in memory
// about FBX->glTF and the V flip), and at 256 square the fish is already
// oversampled three times over. If it is ever wanted, do it with a rendered
// before/after, not blind.
//
// ORIENTATION IS MEASURED HERE AND DECLARED IN assets.js, not rotated into the
// file. After the flatten the nose lies on world -Z and the dorsal fin on +Y,
// which is `forward: '-Z', up: '+Y'` — the same pair the fishes.glb trio takes.
// The tool prints it, so a re-export that comes out turned says so in the
// console instead of in the game. See the block on `sardineBlade` in assets.js.
//
// The source lives outside the repo, in ~/Documents/_DesignSystems/SealSurvivor
// — see the note in memory about SeaBed. Nothing here writes to one.
// ---------------------------------------------------------------------------

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, weld, simplify } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const write = argv.includes('--write');
const flag = (name) => (argv.find((s) => s.startsWith(`--${name}=`)) || '').split('=')[1];

const SRC = flag('src') || path.join(os.homedir(), 'Documents/_DesignSystems/SealSurvivor/sardine.glb');
const OUT = flag('out') || path.join(ROOT, 'public/models/sardine.glb');

// THE TRIANGLE TARGET. A sardine is a smooth spindle with five thin fins, and
// the split matters: the spindle decimates to almost nothing visible because
// the simplifier's error is measured against a surface with no features on it,
// while a fin is a flat wedge two pixels across whose whole read is its
// outline. 420 is where the fins stop losing corners — measured by rendering
// the silhouette at 300 / 420 / 600 and looking at them, which is the only way
// this number can be chosen. For scale, the blade stand-in it replaces is 160
// triangles and enemyClownFish is 1,884.
const TRIS = Number(flag('tris')) || 420;
// Error-bounded as well as ratio-bounded, so the simplifier stops rather than
// mangle the tail fin to hit a count. 0.01 rather than the accessories' 0.004:
// that pool's objects are looked at on a still kill-shot, and this one is eight
// bodies tumbling through a strange attractor.
const ERROR = Number(flag('error')) || 0.01;
// See the header. 256 is three times what the most zoomed-in frame can resolve
// on a body this size, and 350KB of VRAM for the whole school.
const MAP = 256;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

// ---------------------------------------------------------------------------

const mulPoint = (m, v) => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
];

// Normals take the inverse transpose of the linear part, done the long way
// because this file's scale is non-uniform — rotating the normals with the
// rotation alone would tilt every one of them off the squashed surface.
function normalMatrix(m) {
  const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const det =
    a[0] * (a[4] * a[8] - a[5] * a[7]) -
    a[1] * (a[3] * a[8] - a[5] * a[6]) +
    a[2] * (a[3] * a[7] - a[4] * a[6]);
  if (Math.abs(det) < 1e-12) return (v) => v;
  const i = [
    (a[4] * a[8] - a[5] * a[7]) / det, (a[2] * a[7] - a[1] * a[8]) / det, (a[1] * a[5] - a[2] * a[4]) / det,
    (a[5] * a[6] - a[3] * a[8]) / det, (a[0] * a[8] - a[2] * a[6]) / det, (a[2] * a[3] - a[0] * a[5]) / det,
    (a[3] * a[7] - a[4] * a[6]) / det, (a[1] * a[6] - a[0] * a[7]) / det, (a[0] * a[4] - a[1] * a[3]) / det,
  ];
  // i is the inverse of the 3x3 in row-major; the transpose is what multiplies
  // a normal, so read it back by columns.
  return (v) => {
    const r = [
      i[0] * v[0] + i[3] * v[1] + i[6] * v[2],
      i[1] * v[0] + i[4] * v[1] + i[7] * v[2],
      i[2] * v[0] + i[5] * v[1] + i[8] * v[2],
    ];
    const l = Math.hypot(r[0], r[1], r[2]) || 1;
    return [r[0] / l, r[1] / l, r[2] / l];
  };
}

/** Triangles, materials, textures — the before/after line. */
function stats(doc) {
  const root = doc.getRoot();
  let tris = 0;
  let verts = 0;
  for (const m of root.listMeshes()) {
    for (const p of m.listPrimitives()) {
      const idx = p.getIndices();
      tris += idx ? idx.getCount() / 3 : p.getAttribute('POSITION').getCount() / 3;
      verts += p.getAttribute('POSITION').getCount();
    }
  }
  let texBytes = 0;
  for (const t of root.listTextures()) texBytes += t.getImage()?.byteLength ?? 0;
  return {
    tris: Math.round(tris),
    verts,
    mats: root.listMaterials().length,
    texes: root.listTextures().length,
    texKB: Math.round(texBytes / 1024),
  };
}

/**
 * Drop the vertex attributes nothing downstream reads.
 *
 * The duplicate UV sets are CHECKED against slot 0 rather than assumed away. A
 * second UV set is sometimes a real lightmap or a real detail layer, and this
 * file's happen to be copies — which is a fact about this export, not about
 * Sketchfab, so a re-export that ships a genuine second set will keep it and
 * say so here rather than quietly losing it.
 */
function trimAttributes(doc) {
  const notes = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const uv0 = prim.getAttribute('TEXCOORD_0');
      for (const sem of prim.listSemantics()) {
        let drop = sem === 'TANGENT';
        if (/^TEXCOORD_[1-9]/.test(sem) && uv0) {
          drop = sameAttribute(prim.getAttribute(sem), uv0);
          if (!drop) notes.push(`${sem}: KEPT — not a copy of TEXCOORD_0`);
        }
        if (!drop) continue;
        const acc = prim.getAttribute(sem);
        prim.setAttribute(sem, null);
        acc.dispose();
        notes.push(`dropped ${sem}`);
      }
    }
  }
  return notes;
}

function sameAttribute(a, b) {
  if (!a || !b || a.getCount() !== b.getCount() || a.getElementSize() !== b.getElementSize()) return false;
  const n = a.getElementSize();
  const va = new Array(n).fill(0);
  const vb = new Array(n).fill(0);
  for (let i = 0; i < a.getCount(); i++) {
    a.getElement(i, va);
    b.getElement(i, vb);
    for (let k = 0; k < n; k++) if (Math.abs(va[k] - vb[k]) > 1e-6) return false;
  }
  return true;
}

/** Bake every node matrix onto the vertices and flatten the chain. */
function flattenTransforms(doc) {
  const scene = doc.getRoot().listScenes()[0];
  const meshNodes = [];
  scene.traverse((n) => { if (n.getMesh()) meshNodes.push(n); });
  for (const n of meshNodes) {
    const m = n.getWorldMatrix();
    const nm = normalMatrix(m);
    const seen = new Set();
    for (const prim of n.getMesh().listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (pos && !seen.has(pos)) {
        seen.add(pos);
        const v = [0, 0, 0];
        for (let i = 0; i < pos.getCount(); i++) { pos.getElement(i, v); pos.setElement(i, mulPoint(m, v)); }
      }
      const nor = prim.getAttribute('NORMAL');
      if (nor && !seen.has(nor)) {
        seen.add(nor);
        const v = [0, 0, 0];
        for (let i = 0; i < nor.getCount(); i++) { nor.getElement(i, v); nor.setElement(i, nm(v)); }
      }
    }
    n.setMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    n.getParentNode()?.removeChild(n);
    scene.addChild(n);
  }
  for (const n of doc.getRoot().listNodes()) {
    if (!n.getMesh() && n.listChildren().length === 0) n.dispose();
  }
}

/** Put the bounding box on the origin, and report it. */
function centre(doc) {
  const lo = [1e9, 1e9, 1e9];
  const hi = [-1e9, -1e9, -1e9];
  const accs = [];
  const seen = new Set();
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos || seen.has(pos)) continue;
      seen.add(pos);
      accs.push(pos);
      const v = [0, 0, 0];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, v);
        for (let k = 0; k < 3; k++) { if (v[k] < lo[k]) lo[k] = v[k]; if (v[k] > hi[k]) hi[k] = v[k]; }
      }
    }
  }
  const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  for (const pos of accs) {
    const v = [0, 0, 0];
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, v);
      pos.setElement(i, [v[0] - c[0], v[1] - c[1], v[2] - c[2]]);
    }
  }
  return { size: [0, 1, 2].map((k) => hi[k] - lo[k]), lo, hi };
}

/**
 * Which way the fish ends up pointing, read off the geometry rather than
 * asserted.
 *
 * The LONG axis is the nose-tail line and the SHORT one is the lateral squash,
 * which leaves the middle axis as up — true of every fish and of nothing else
 * in this file, which is why this is a sardine importer and not a general one.
 *
 * WHICH END IS THE NOSE is the half that a bounding box cannot answer, so it is
 * measured: a caudal fin is the thinnest cross-section on the body and the
 * tallest, and a snout is neither. The half of the long axis whose extreme
 * slice is WIDE relative to its height is the head.
 */
function measureAxes(doc) {
  const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  const pos = prim.getAttribute('POSITION');
  const lo = [1e9, 1e9, 1e9];
  const hi = [-1e9, -1e9, -1e9];
  const P = [];
  const v = [0, 0, 0];
  for (let i = 0; i < pos.getCount(); i++) {
    pos.getElement(i, v);
    P.push([v[0], v[1], v[2]]);
    for (let k = 0; k < 3; k++) { if (v[k] < lo[k]) lo[k] = v[k]; if (v[k] > hi[k]) hi[k] = v[k]; }
  }
  const size = [0, 1, 2].map((k) => hi[k] - lo[k]);
  const order = [0, 1, 2].sort((a, b) => size[b] - size[a]);
  const long = order[0];
  const up = order[1];
  const lat = order[2];

  // The outermost tenth at each end of the long axis.
  const end = (sign) => {
    const cut = sign > 0 ? hi[long] - size[long] * 0.1 : lo[long] + size[long] * 0.1;
    let w = 0;
    let h = 0;
    for (const p of P) {
      if (sign > 0 ? p[long] < cut : p[long] > cut) continue;
      w = Math.max(w, Math.abs(p[lat]));
      h = Math.max(h, Math.abs(p[up]));
    }
    return w / Math.max(h, 1e-9);
  };
  const AXIS = ['X', 'Y', 'Z'];
  const noseSign = end(+1) > end(-1) ? +1 : -1;
  return {
    size,
    forward: `${noseSign > 0 ? '+' : '-'}${AXIS[long]}`,
    up: `+${AXIS[up]}`,
    ratio: { plus: end(+1), minus: end(-1) },
  };
}

/** 1024 -> 256, and out of PNG if there is no alpha to keep. */
async function shrinkTextures(doc) {
  const notes = [];
  for (const tex of doc.getRoot().listTextures()) {
    const [w, h] = tex.getSize() ?? [0, 0];
    if (w <= MAP && h <= MAP) continue;
    const src = Buffer.from(tex.getImage());
    const alpha = (await sharp(src).stats()).channels.length === 4;
    const img = sharp(src).resize(MAP, MAP, { fit: 'fill' });
    const buf = alpha
      ? await img.png({ compressionLevel: 9 }).toBuffer()
      : await img.jpeg({ quality: 85, chromaSubsampling: '4:2:0' }).toBuffer();
    tex.setImage(buf).setMimeType(alpha ? 'image/png' : 'image/jpeg');
    notes.push(`texture ${w}x${h} -> ${MAP}x${MAP} ${alpha ? 'png' : 'jpeg'} (${Math.round(buf.byteLength / 1024)}KB)`);
  }
  return notes;
}

// ---------------------------------------------------------------------------

await MeshoptSimplifier.ready;
if (!fs.existsSync(SRC)) {
  console.error(`missing source: ${SRC}`);
  process.exit(1);
}

const doc = await io.read(SRC);
const before = { ...stats(doc), fileKB: Math.round(fs.statSync(SRC).size / 1024) };

for (const n of trimAttributes(doc)) console.log('  ' + n);
flattenTransforms(doc);

// SINGLE-SIDED. See the header — the mesh is closed, so nothing disappears and
// half the fragments stop being shaded. Checked rather than declared: a
// re-export that opens the mesh up keeps its two-sidedness and says so.
const openEdges = countBoundaryEdges(doc);
for (const mat of doc.getRoot().listMaterials()) {
  if (!mat.getDoubleSided()) continue;
  if (openEdges > 0) { console.log(`  doubleSided KEPT — ${openEdges} boundary edges (open surfaces)`); continue; }
  mat.setDoubleSided(false);
  console.log('  doubleSided -> false (closed manifold)');
}

for (const n of await shrinkTextures(doc)) console.log('  ' + n);

await doc.transform(prune());
const mid = stats(doc);
await doc.transform(
  // Weld first: the simplifier collapses edges and cannot see two coincident
  // vertices as one, so the 74 UV-seam splits in this file would each be a
  // crack it refuses to close.
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio: Math.min(1, TRIS / mid.tris), error: ERROR, lockBorder: false }),
  prune(),
  dedup(),
);

const box = centre(doc);
const axes = measureAxes(doc);
const after = stats(doc);
const glb = await io.writeBinary(doc);
after.fileKB = Math.round(glb.byteLength / 1024);

const line = (l, s) =>
  `  ${l.padEnd(6)} ${String(s.tris).padStart(5)} tris  ${String(s.verts).padStart(5)} verts  ` +
  `${String(s.mats).padStart(2)} mats  ${String(s.texes).padStart(2)} tex ${String(s.texKB).padStart(5)}KB  ` +
  `${String(s.fileKB ?? '').padStart(5)}KB file`;
console.log(line('before', before));
console.log(line('after', after));
console.log(`  bbox ${box.size.map((n) => n.toFixed(4)).join(' x ')}`);
console.log(`  longest axis ${Math.max(...box.size).toFixed(4)}  ->  assets.js  forward: '${axes.forward}', up: '${axes.up}'`);
console.log(`  nose test: +end width/height ${axes.ratio.plus.toFixed(2)}, -end ${axes.ratio.minus.toFixed(2)} (the fatter end is the head)`);

if (write) {
  fs.writeFileSync(OUT, Buffer.from(glb));
  console.log(`  -> ${path.relative(ROOT, OUT)}`);
} else {
  console.log('\nnothing written — pass --write');
}

/** Edges used by exactly one triangle, over the whole document. */
function countBoundaryEdges(document) {
  let open = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const idx = prim.getIndices();
      if (!pos || !idx) continue;
      // Keyed on POSITION, not on the index, so a UV seam is not read as a hole.
      const id = new Array(pos.getCount());
      const at = new Map();
      const v = [0, 0, 0];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, v);
        const k = `${v[0].toFixed(5)},${v[1].toFixed(5)},${v[2].toFixed(5)}`;
        if (!at.has(k)) at.set(k, at.size);
        id[i] = at.get(k);
      }
      const use = new Map();
      for (let t = 0; t < idx.getCount(); t += 3) {
        const a = id[idx.getScalar(t)];
        const b = id[idx.getScalar(t + 1)];
        const c = id[idx.getScalar(t + 2)];
        for (const [p, q] of [[a, b], [b, c], [c, a]]) {
          const k = p < q ? `${p}_${q}` : `${q}_${p}`;
          use.set(k, (use.get(k) ?? 0) + 1);
        }
      }
      for (const n of use.values()) if (n === 1) open++;
    }
  }
  return open;
}
