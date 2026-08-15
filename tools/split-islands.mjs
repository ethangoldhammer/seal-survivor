#!/usr/bin/env node
// npm run split -- <in.glb> <outDir> [--prefix name] [--list]
//
// SPLIT ONE MESH INTO THE OBJECTS IT IS ACTUALLY MADE OF.
//
// A prop pack ships a pile of things as a single merged primitive — four rolls
// of cash in one draw call, one material, one index buffer. The game needs them
// one at a time: a projectile is an asset key, assets.js loads a FILE, and
// there is no way to say "the third node of that glb".
//
// So this cuts the primitive into connected components, groups the components
// that belong to the same object, bakes the node chain, recentres each piece on
// its own bounding box, and writes one .glb per object.
//
// WHY IT DOES NOT USE THREE.JS. GLTFExporter needs a canvas to re-encode the
// baseColor texture, and this project's headless stub has no 2D context (see
// tools/dom-stub.mjs). Copying the PNG bufferView across verbatim is both
// simpler and lossless — every output shares the source's own texture bytes.
//
// TWO THINGS THAT ARE NOT OBVIOUS:
//
//   A SPLIT-NORMAL SEAM DUPLICATES VERTICES, so a hard edge around the rim of a
//   cylinder makes the cap a separate component from the body even though they
//   are one object. Components are therefore WELDED BY POSITION before the
//   union-find, and then grouped again by overlapping bounding box — the cap
//   sits inside the body's box, and nothing else does.
//
//   RECENTRING IS THE POINT, not a tidy-up. Each roll is authored where it lay
//   in the pile, so an unrecentred export spawns a projectile whose art is a
//   third of a metre off its own hitbox, and rotates about a point outside
//   itself.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [file, outDir] = args.filter((a) => !a.startsWith('--'));
const prefix = (() => {
  const i = args.indexOf('--prefix');
  return i >= 0 ? args[i + 1] : 'piece';
})();
if (!file) {
  console.error('usage: node tools/split-islands.mjs <in.glb> <outDir> [--prefix name] [--list]');
  process.exit(1);
}

// --- read -------------------------------------------------------------------

const buf = readFileSync(file);
if (buf.toString('utf8', 0, 4) !== 'glTF') { console.error(`${file} is not a .glb`); process.exit(1); }
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
const bin = buf.subarray(20 + jsonLen + 8);

const CTOR = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const COMPS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function read(accIdx) {
  const acc = gltf.accessors[accIdx];
  const bv = gltf.bufferViews[acc.bufferView];
  const off = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const n = acc.count * COMPS[acc.type];
  const ctor = CTOR[acc.componentType];
  // byteStride would mean an interleaved buffer; nothing exported by the tools
  // that produce these packs interleaves, and a silent wrong read is worse
  // than a stop.
  if (bv.byteStride && bv.byteStride !== COMPS[acc.type] * ctor.BYTES_PER_ELEMENT) {
    throw new Error(`accessor ${accIdx} is interleaved (stride ${bv.byteStride}) — not supported`);
  }
  const src = new ctor(bin.buffer, bin.byteOffset + off, n);
  return { data: Float64Array.from(src), acc, comps: COMPS[acc.type] };
}

// --- the node chain ---------------------------------------------------------
// The mesh's world matrix is the product of every matrix above it. Sketchfab
// exports routinely stack three of them — a Y-up fix, a centimetre scale, and
// the FBX's own axis swap — and the numbers only mean anything multiplied out.

function mul(a, b) { // column-major 4x4, a then b applied
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function localMatrix(n) {
  if (n.matrix) return n.matrix;
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
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

// Walk to the first node carrying a mesh, accumulating the chain.
let meshNode = -1;
let world = IDENT;
(function walk(idx, m) {
  if (meshNode >= 0) return;
  const n = gltf.nodes[idx];
  const here = mul(m, localMatrix(n));
  if (n.mesh !== undefined) { meshNode = idx; world = here; return; }
  for (const c of n.children ?? []) walk(c, here);
}(gltf.scenes?.[gltf.scene ?? 0]?.nodes?.[0] ?? 0, IDENT));

const xform = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];
// Normals take the inverse transpose. Every chain here is a rotation and a
// uniform scale, where that is the rotation part renormalised — and doing it
// this way avoids inverting a matrix for a case that never needs it.
function normalDir(m, x, y, z) {
  const [a, b, c] = [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
  const len = Math.hypot(a, b, c) || 1;
  return [a / len, b / len, c / len];
}

// --- components -------------------------------------------------------------

const prim = gltf.meshes[gltf.nodes[meshNode].mesh].primitives[0];
const P = read(prim.attributes.POSITION);
const N = prim.attributes.NORMAL !== undefined ? read(prim.attributes.NORMAL) : null;
const C = prim.attributes.COLOR_0 !== undefined ? read(prim.attributes.COLOR_0) : null;
const T = prim.attributes.TEXCOORD_0 !== undefined ? read(prim.attributes.TEXCOORD_0) : null;
const idx = read(prim.indices).data;
const nVerts = gltf.accessors[prim.attributes.POSITION].count;

// Weld by position, so a hard-edge seam is not read as a second object.
const welded = new Map();
const weld = new Int32Array(nVerts);
for (let i = 0; i < nVerts; i++) {
  const k = `${P.data[i * 3].toFixed(5)},${P.data[i * 3 + 1].toFixed(5)},${P.data[i * 3 + 2].toFixed(5)}`;
  if (!welded.has(k)) welded.set(k, i);
  weld[i] = welded.get(k);
}
const parent = Int32Array.from({ length: nVerts }, (_, i) => i);
const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
for (let t = 0; t < idx.length; t += 3) {
  union(weld[idx[t]], weld[idx[t + 1]]);
  union(weld[idx[t + 1]], weld[idx[t + 2]]);
}

// One entry per component: its triangles and its bounding box, in SOURCE space.
const comps = new Map();
for (let t = 0; t < idx.length; t += 3) {
  const root = find(weld[idx[t]]);
  let c = comps.get(root);
  if (!c) { c = { tris: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }; comps.set(root, c); }
  c.tris.push(t);
  for (let k = 0; k < 3; k++) {
    const v = idx[t + k];
    for (let a = 0; a < 3; a++) {
      c.min[a] = Math.min(c.min[a], P.data[v * 3 + a]);
      c.max[a] = Math.max(c.max[a], P.data[v * 3 + a]);
    }
  }
}

// GROUPING, and the rule here is CONTAINMENT rather than overlap.
//
// Overlap is the obvious rule and it is wrong: props in a pile touch each
// other, so two rolls resting against one another share a sliver of box and
// come out welded into one object. What a cap has that a neighbour does not is
// that it sits ENTIRELY INSIDE its own cylinder — it is the same surface,
// re-emitted with its own normals.
//
// `slack` is 3% of the container's longest side, because a cap is modelled a
// hair PROUD of the rim it belongs to (measured: about 1.2% on this pack) and
// a strict test would leave every end face as its own file.
const list = [...comps.values()];
const gparent = list.map((_, i) => i);
const gfind = (a) => { while (gparent[a] !== a) { gparent[a] = gparent[gparent[a]]; a = gparent[a]; } return a; };
const span = (c) => Math.max(c.max[0] - c.min[0], c.max[1] - c.min[1], c.max[2] - c.min[2]);
for (let i = 0; i < list.length; i++) for (let j = 0; j < list.length; j++) {
  if (i === j) continue;
  const inner = list[i], outer = list[j];
  if (span(inner) > span(outer)) continue;
  const slack = span(outer) * 0.03;
  const inside = [0, 1, 2].every((k) => inner.min[k] >= outer.min[k] - slack && inner.max[k] <= outer.max[k] + slack);
  if (inside) { const ra = gfind(i), rb = gfind(j); if (ra !== rb) gparent[ra] = rb; }
}
const groups = new Map();
list.forEach((c, i) => {
  const r = gfind(i);
  if (!groups.has(r)) groups.set(r, []);
  groups.get(r).push(c);
});

// Left to right in the source, so the numbering matches how the pile reads and
// re-running the tool cannot silently renumber the outputs.
const objects = [...groups.values()].map((cs) => {
  const tris = cs.flatMap((c) => c.tris);
  const min = [0, 1, 2].map((k) => Math.min(...cs.map((c) => c.min[k])));
  const max = [0, 1, 2].map((k) => Math.max(...cs.map((c) => c.max[k])));
  return { tris, min, max, parts: cs.length };
}).sort((a, b) => (a.min[0] + a.max[0]) - (b.min[0] + b.max[0]));

// --- alignment --------------------------------------------------------------
// `--align` turns four props that were authored lying in a heap into four
// pieces that point the same way, so any of them can be dropped into the same
// slot and the one that spawns is a variant rather than a different asset.
//
// FINDING THE AXIS OF A CYLINDER — and the two obvious methods both fail here.
// The bounding box is no help: these rolls are 0.085 long and 0.07 across, so
// the longest box side is decided by which way the prop happens to be leaning.
// The covariance of the POSITIONS is no better, because for a hollow shell the
// variance along the axis (L²/12) and across it (r²/2) come out within 2% of
// each other on a roll this stubby.
//
// The NORMALS decide it cleanly. On a cylinder every normal is either
// perpendicular to the axis (the curved side) or parallel to it (the two end
// caps) and nothing is in between, so the true axis is the direction that
// maximises how sharply that split holds. Any wrong direction puts a large
// share of the normals at some middling angle and scores badly. Searched
// coarsely over a hemisphere and then refined, because it is a few hundred
// thousand dot products on a 460-vertex mesh and does not need to be clever.
function cylinderAxis(verts, normals) {
  const score = (ax, ay, az) => {
    let s = 0;
    for (let i = 0; i < normals.length; i += 3) {
      const d = Math.abs(normals[i] * ax + normals[i + 1] * ay + normals[i + 2] * az);
      // 1 at either end of the range, 0 at 45 degrees: a flat-topped well that
      // rewards "perpendicular OR parallel" and punishes everything else.
      s += Math.abs(2 * d * d - 1);
    }
    return s / (normals.length / 3);
  };
  let best = [0, 1, 0];
  let bestScore = -Infinity;
  const test = (v) => {
    const len = Math.hypot(...v) || 1;
    const u = v.map((c) => c / len);
    const s = score(...u);
    if (s > bestScore) { bestScore = s; best = u; }
  };
  // A Fibonacci hemisphere, then a local refinement around the winner.
  const N0 = 900;
  for (let i = 0; i < N0; i++) {
    const y = 1 - (i / (N0 - 1));               // hemisphere: sign is irrelevant for an axis
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = Math.PI * (1 + Math.sqrt(5)) * i;
    test([Math.cos(th) * r, y, Math.sin(th) * r]);
  }
  for (let pass = 0, step = 0.08; pass < 4; pass++, step /= 3) {
    const [bx, by, bz] = best;
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
      test([bx + dx * step, by + dy * step, bz + dz * step]);
    }
  }
  return { axis: best, score: bestScore };
}

// A rotation taking `from` to `to`, as a column-major 4x4. Rodrigues, with the
// antiparallel case handled explicitly — an axis that comes out pointing the
// wrong way down the target is otherwise a 180-degree rotation about an
// undefined axis, and every component of the matrix becomes NaN.
function rotationBetween(from, to) {
  const d = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
  let ax = from[1] * to[2] - from[2] * to[1];
  let ay = from[2] * to[0] - from[0] * to[2];
  let az = from[0] * to[1] - from[1] * to[0];
  let s = Math.hypot(ax, ay, az);
  if (s < 1e-8) {
    if (d > 0) return IDENT.slice();
    // Any perpendicular will do for a half turn.
    const p = Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    ax = from[1] * p[2] - from[2] * p[1];
    ay = from[2] * p[0] - from[0] * p[2];
    az = from[0] * p[1] - from[1] * p[0];
    s = Math.hypot(ax, ay, az);
  }
  ax /= s; ay /= s; az /= s;
  // From the DOT, not from the cross product's length: both inputs are unit
  // vectors, and acos is unambiguous over the full half-turn where asin is not.
  const ang = Math.acos(Math.max(-1, Math.min(1, d)));
  const co = Math.cos(ang), si = Math.sin(ang), t = 1 - co;
  return [
    t * ax * ax + co, t * ax * ay + si * az, t * ax * az - si * ay, 0,
    t * ax * ay - si * az, t * ay * ay + co, t * ay * az + si * ax, 0,
    t * ax * az + si * ay, t * ay * az - si * ax, t * az * az + co, 0,
    0, 0, 0, 1,
  ];
}

const alignTo = (() => {
  const i = args.indexOf('--align');
  if (i < 0) return null;
  const spec = (args[i + 1] ?? '+y').toLowerCase();
  const sign = spec.startsWith('-') ? -1 : 1;
  const a = spec.replace(/[+-]/, '');
  return { x: [sign, 0, 0], y: [0, sign, 0], z: [0, 0, sign] }[a] ?? [0, sign, 0];
})();

// --- write ------------------------------------------------------------------

function buildGlb(obj, name) {
  // Remap only the vertices this object uses.
  const remap = new Map();
  const indices = [];
  for (const t of obj.tris) for (let k = 0; k < 3; k++) {
    const v = idx[t + k];
    if (!remap.has(v)) remap.set(v, remap.size);
    indices.push(remap.get(v));
  }
  const n = remap.size;
  const pos = new Float32Array(n * 3);
  const nrm = N ? new Float32Array(n * 3) : null;
  const col = C ? new Float32Array(n * C.comps) : null;
  const uv = T ? new Float32Array(n * 2) : null;

  // World space first — the chain is what makes the numbers metres.
  for (const [src, dst] of remap) {
    const p = xform(world, P.data[src * 3], P.data[src * 3 + 1], P.data[src * 3 + 2]);
    for (let a = 0; a < 3; a++) pos[dst * 3 + a] = p[a];
    if (nrm) {
      const d = normalDir(world, N.data[src * 3], N.data[src * 3 + 1], N.data[src * 3 + 2]);
      for (let a = 0; a < 3; a++) nrm[dst * 3 + a] = d[a];
    }
    if (col) for (let a = 0; a < C.comps; a++) col[dst * C.comps + a] = C.data[src * C.comps + a];
    if (uv) { uv[dst * 2] = T.data[src * 2]; uv[dst * 2 + 1] = T.data[src * 2 + 1]; }
  }

  // THEN the alignment, while the piece is still where it was rather than
  // after the recentre — a rotation about the world origin and a rotation about
  // the object's own centre are the same rotation only once the object is at
  // the origin, and it is not yet.
  let axisInfo = null;
  if (alignTo && nrm) {
    const found = cylinderAxis(pos, nrm);
    axisInfo = found;
    const R = rotationBetween(found.axis, alignTo);
    for (let i = 0; i < n; i++) {
      const p = xform(R, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      const d = normalDir(R, nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]);
      for (let a = 0; a < 3; a++) { pos[i * 3 + a] = p[a]; nrm[i * 3 + a] = d[a]; }
    }
  }

  // And last the recentre, which is what makes the origin the thing itself.
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) {
    box.min[a] = Math.min(box.min[a], pos[i * 3 + a]);
    box.max[a] = Math.max(box.max[a], pos[i * 3 + a]);
  }
  const centre = [0, 1, 2].map((a) => (box.min[a] + box.max[a]) / 2);
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) pos[i * 3 + a] -= centre[a];

  const size = [0, 1, 2].map((a) => box.max[a] - box.min[a]);
  const ind = n > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);

  // Pack: every attribute, the indices, then the source's PNG verbatim.
  const chunks = [];
  let offset = 0;
  const bufferViews = [];
  const push = (typed, target) => {
    const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const padded = bytes.length % 4 ? Buffer.concat([bytes, Buffer.alloc(4 - (bytes.length % 4))]) : bytes;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, ...(target ? { target } : {}) });
    chunks.push(padded);
    offset += padded.length;
    return bufferViews.length - 1;
  };

  const accessors = [];
  const attributes = {};
  const addAcc = (typed, type, comps, componentType, target, minmax) => {
    const bv = push(typed, target);
    accessors.push({ bufferView: bv, componentType, count: typed.length / comps, type, ...(minmax ?? {}) });
    return accessors.length - 1;
  };
  attributes.POSITION = addAcc(pos, 'VEC3', 3, 5126, 34962, {
    min: [0, 1, 2].map((a) => -size[a] / 2),
    max: [0, 1, 2].map((a) => size[a] / 2),
  });
  if (nrm) attributes.NORMAL = addAcc(nrm, 'VEC3', 3, 5126, 34962);
  if (col) attributes.COLOR_0 = addAcc(col, C.comps === 4 ? 'VEC4' : 'VEC3', C.comps, 5126, 34962);
  if (uv) attributes.TEXCOORD_0 = addAcc(uv, 'VEC2', 2, 5126, 34962);
  const indAcc = addAcc(ind, 'SCALAR', 1, ind.BYTES_PER_ELEMENT === 4 ? 5125 : 5123, 34963);

  // The texture, byte for byte. Re-encoding it would be the one lossy step in
  // an otherwise exact copy, and there is no reason for it.
  const out = {
    asset: { version: '2.0', generator: `seal-survivor split-islands from ${file.split('/').pop()}` },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives: [{ attributes, indices: indAcc, material: 0, mode: 4 }] }],
    materials: [JSON.parse(JSON.stringify(gltf.materials[prim.material ?? 0]))],
    bufferViews,
    accessors,
    buffers: [],
  };
  const srcImage = gltf.images?.[gltf.textures?.[0]?.source ?? 0];
  if (srcImage?.bufferView !== undefined) {
    const bv = gltf.bufferViews[srcImage.bufferView];
    const png = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    const imgView = push(new Uint8Array(png));
    out.images = [{ bufferView: imgView, mimeType: srcImage.mimeType ?? 'image/png' }];
    out.textures = [{ source: 0, ...(gltf.textures[0].sampler !== undefined ? { sampler: 0 } : {}) }];
    if (gltf.samplers?.length) out.samplers = [gltf.samplers[gltf.textures[0].sampler ?? 0]];
  } else {
    delete out.materials[0].pbrMetallicRoughness?.baseColorTexture;
  }

  const binChunk = Buffer.concat(chunks);
  out.buffers = [{ byteLength: binChunk.length }];
  let json = Buffer.from(JSON.stringify(out), 'utf8');
  if (json.length % 4) json = Buffer.concat([json, Buffer.alloc(4 - (json.length % 4), 0x20)]);

  const header = Buffer.alloc(12);
  header.write('glTF', 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + binChunk.length, 8);
  const jHead = Buffer.alloc(8); jHead.writeUInt32LE(json.length, 0); jHead.writeUInt32LE(0x4e4f534a, 4);
  const bHead = Buffer.alloc(8); bHead.writeUInt32LE(binChunk.length, 0); bHead.writeUInt32LE(0x004e4942, 4);
  return { glb: Buffer.concat([header, jHead, json, bHead, binChunk]), size, verts: n, tris: obj.tris.length, axisInfo };
}

const f = (v) => v.toFixed(3).padStart(7);
console.log(`\n${file}\n  ${objects.length} objects, from ${list.length} components\n`);
if (!flags.has('--list')) mkdirSync(outDir, { recursive: true });
objects.forEach((obj, i) => {
  const name = `${prefix}${i + 1}`;
  const built = buildGlb(obj, name);
  const [w, h, d] = built.size;
  const axis = ['x', 'y', 'z'][built.size.indexOf(Math.max(...built.size))];
  console.log(
    `  ${name.padEnd(12)} ${String(built.tris).padStart(4)} tris  ${String(built.verts).padStart(4)} verts`
    + `  ${obj.parts} parts  size [${f(w)} ${f(h)} ${f(d)}]  longest ${axis}`
    // The score is the thing to distrust the result by: a real cylinder comes
    // out near 1, and anything much below that means the piece is not one and
    // the "axis" is whichever direction happened to fit least badly.
    + (built.axisInfo ? `  cyl ${built.axisInfo.score.toFixed(3)}` : ''),
  );
  if (flags.has('--list')) return;
  const dest = join(outDir, `${name}.glb`);
  writeFileSync(dest, built.glb);
  console.log(`  ${''.padEnd(12)} -> ${dest} (${(built.glb.length / 1024).toFixed(0)} KB)`);
});
