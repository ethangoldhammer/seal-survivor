#!/usr/bin/env node
// Give the man o' war scan a skeleton, so its filaments can drift.
//
//   npm run rig:manowar -- [source.glb] [out.glb] [--tris=N] [--dry]
//
// The SOURCE is the untouched download, which lives outside the repo:
//   ~/Documents/_DesignSystems/SealSurvivor/portuguese_man_o_war.glb
// The output is public/models/manowar.glb. Run it against the source, never
// against the output — a second pass would flatten the skin it just made.
//
// WHAT ARRIVES. A Sketchfab STL scan: 3 nodes, 0 skins, 0 clips, 73,722
// triangles — 1.7x the heaviest model in the game — and a -24.6 degree X
// rotation held in the root node's matrix. flattenMesh bakes that away for
// free, which is the only reason it is not a step below.
//
// Three things about the source are worth knowing before reading the rest:
//
//   THE UVs ARE DEGENERATE. TEXCOORD_0's accessor reports min = max = [0,0]:
//        every one of the 37,454 vertices samples the same texel. Both PNGs
//        are therefore decoration on a single pixel, and they turn out to be
//        flat anyway — the baseColour map is pure white at alpha 81/255 and
//        the transmission map is uniform. So the animal has NO COLOUR of its
//        own; it is clear glass, and whatever it looks like in the game will
//        come entirely from its `surface` preset. Both maps are dropped and
//        the one fact they carried (alpha 0.318) is baked into a factor.
//        KHR_materials_transmission goes with them: writeSkinnedGlb has no
//        extensionsUsed to declare it in, and an undeclared extension is
//        invalid glTF that three.js silently ignores.
//   IT IS CLEAN. 0 non-manifold edges, and 1,426 boundary edges — holes, but
//        no self-intersecting junk to trip the simplifier.
//   IT IS 22 SHELLS. One real one of 37,384 vertices and 21 fragments of 3-7
//        vertices each: scan noise. Any of those can win a weight and then fly
//        across the screen on its own, so they are dropped rather than rigged.
//
// HOW THE STRANDS ARE FOUND, which is the whole job. A tentacle is not a
// separate object here — every filament is welded to the underside of the
// float, so the mesh is one shell and no component split can separate them.
// But CUT the vertex graph at a horizontal plane and the part below it falls
// into exactly the filaments that cross it. So this sweeps the cut plane down
// the model and counts components below it; the count climbs as the crown
// fans out, then sits on a plateau for the length of the tentacle field. The
// crown is the highest cut that reaches that plateau, and each component below
// it is one strand.
//
// That is a measurement rather than a threshold, and it is why there is no
// "tentacles start 20% down" constant anywhere below. It also self-checks: a
// count that never plateaus means the sweep found a shape this tool cannot
// rig, and it says so instead of writing a plausible-looking wrong file.
//
// WHY DECIMATION COMES FIRST. Normally it comes last (see the note on
// tools/fish-split.mjs — dead attributes are seams that hold the ratio back).
// Here there are no attributes to strip except the dead UVs, and simplifying
// after skinning is the case meshoptimizer handles worst: a vertex that comes
// out of the collapse with four zero weights pins to the origin and draws a
// spike through the scene without throwing. Rigging the decimated mesh means
// every weight this tool writes is a weight that ships.
import { writeFileSync } from 'node:fs';
import { MeshoptSimplifier } from 'meshoptimizer';
import { readGlb, flattenMesh, writeSkinnedGlb } from './lib/glb.mjs';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const a = argv.find((s) => s.startsWith(`--${name}=`));
  return a ? Number(a.split('=')[1]) : dflt;
};
const dry = argv.includes('--dry');
const positional = argv.filter((s) => !s.startsWith('--'));
const SRC = positional[0]
  ?? `${process.env.HOME}/Documents/_DesignSystems/SealSurvivor/portuguese_man_o_war.glb`;
const OUT = positional[1] ?? 'public/models/manowar.glb';
if (SRC === OUT) {
  console.error('refusing to rig a file onto itself — pass the untouched source, not the output');
  process.exit(1);
}

// 10,000 against a jellyfish that ships 3,780 and a giant squid that ships
// 41,943. The filaments are the reason it sits at the high end of the wave
// roster rather than beside the jellyfish: eighteen tubes cost their vertices
// in circumference, and a tube decimated past about six sides stops reading as
// round and starts reading as a folded ribbon.
const TARGET_TRIS = flag('tris', 10000);

// Six bones over a 3.5-unit filament is a bone every 0.6 units, which is about
// the amplitude of the curl this animal wants. Short strands get fewer, in
// proportion, because six bones inside a 0.3-unit stub is 5 joints that can
// only ever fold it into itself.
const MAX_BONES_PER_STRAND = 6;
const MIN_BONES_PER_STRAND = 2;

const glb = readGlb(SRC);
const src = flattenMesh(glb);
console.log(`\n${SRC}`);
console.log(`  in   ${src.positions.length / 3} verts, ${src.indices.length / 3} tris`);

// ---------------------------------------------------------------------------
// Weld, drop the scan noise, decimate
// ---------------------------------------------------------------------------

// Welded by position. There are no UVs to preserve a seam for and the normals
// are recomputed below, so this loses nothing and gives the simplifier a mesh
// that is actually connected — an unwelded edge is a border it will not
// collapse across.
function weld(positions, indices) {
  const map = new Map();
  const remap = new Int32Array(positions.length / 3);
  const out = [];
  for (let i = 0; i < positions.length / 3; i++) {
    const k = `${Math.round(positions[i * 3] * 1e5)},${Math.round(positions[i * 3 + 1] * 1e5)},${Math.round(positions[i * 3 + 2] * 1e5)}`;
    let j = map.get(k);
    if (j === undefined) {
      j = out.length / 3;
      out.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      map.set(k, j);
    }
    remap[i] = j;
  }
  const idx = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) idx[i] = remap[indices[i]];
  return { positions: Float32Array.from(out), indices: idx };
}

// Union-find over an index buffer, as a per-vertex component label.
function components(vertCount, indices) {
  const p = new Int32Array(vertCount);
  for (let i = 0; i < vertCount; i++) p[i] = i;
  const find = (x) => { let r = x; while (p[r] !== r) r = p[r]; while (p[x] !== r) { const n = p[x]; p[x] = r; x = n; } return r; };
  const uni = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) p[ra] = rb; };
  for (let t = 0; t < indices.length; t += 3) { uni(indices[t], indices[t + 1]); uni(indices[t + 1], indices[t + 2]); }
  const label = new Int32Array(vertCount);
  for (let i = 0; i < vertCount; i++) label[i] = find(i);
  return label;
}

// Keep only the triangles of the largest shell, and compact the vertices down
// to the ones they still use.
function keepLargestShell(positions, indices) {
  const n = positions.length / 3;
  const label = components(n, indices);
  const size = new Map();
  for (let i = 0; i < n; i++) size.set(label[i], (size.get(label[i]) ?? 0) + 1);
  let main = -1; let best = -1;
  for (const [k, v] of size) if (v > best) { best = v; main = k; }
  const tris = [];
  for (let t = 0; t < indices.length; t += 3) {
    if (label[indices[t]] === main) tris.push(indices[t], indices[t + 1], indices[t + 2]);
  }
  return { dropped: size.size - 1, droppedVerts: n - best, ...compact(positions, Uint32Array.from(tris)) };
}

// Drop vertices no triangle references, renumbering what is left.
function compact(positions, indices) {
  const used = new Int32Array(positions.length / 3).fill(-1);
  for (const i of indices) used[i] = 0;
  const out = [];
  for (let i = 0; i < used.length; i++) {
    if (used[i] !== 0) continue;
    used[i] = out.length / 3;
    out.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  }
  const idx = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) idx[i] = used[indices[i]];
  return { positions: Float32Array.from(out), indices: idx };
}

let { positions, indices } = weld(src.positions, src.indices);
const weldedVerts = positions.length / 3;
const shell = keepLargestShell(positions, indices);
positions = shell.positions; indices = shell.indices;
console.log(`  weld ${weldedVerts} verts (from ${src.positions.length / 3}), dropped ${shell.dropped} noise shells / ${shell.droppedVerts} verts`);

await MeshoptSimplifier.ready;
const targetIndexCount = Math.min(indices.length, TARGET_TRIS * 3);
const [simplified, error] = MeshoptSimplifier.simplify(
  indices, positions, 3, targetIndexCount, 0.05,
);
({ positions, indices } = compact(positions, simplified));
const N = positions.length / 3;
console.log(`  trim ${N} verts, ${indices.length / 3} tris (target ${TARGET_TRIS}, error ${error.toFixed(4)})`);

const px = (i) => positions[i * 3];
const py = (i) => positions[i * 3 + 1];
const pz = (i) => positions[i * 3 + 2];

// Area-weighted vertex normals. The source's normals belonged to vertices the
// simplifier has since collapsed; carrying them across would shade the new
// surface with the old one's creases.
const normals = new Float32Array(N * 3);
for (let t = 0; t < indices.length; t += 3) {
  const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
  const ux = px(b) - px(a); const uy = py(b) - py(a); const uz = pz(b) - pz(a);
  const vx = px(c) - px(a); const vy = py(c) - py(a); const vz = pz(c) - pz(a);
  const nx = uy * vz - uz * vy; const ny = uz * vx - ux * vz; const nz = ux * vy - uy * vx;
  for (const i of [a, b, c]) { normals[i * 3] += nx; normals[i * 3 + 1] += ny; normals[i * 3 + 2] += nz; }
}
for (let i = 0; i < N; i++) {
  const l = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]) || 1;
  normals[i * 3] /= l; normals[i * 3 + 1] /= l; normals[i * 3 + 2] /= l;
}

// The vertex graph, which everything below reads: strand membership, the
// crown sweep, and the weight smoothing.
const neighbours = Array.from({ length: N }, () => new Set());
const link = (a, b) => { neighbours[a].add(b); neighbours[b].add(a); };
for (let t = 0; t < indices.length; t += 3) {
  link(indices[t], indices[t + 1]); link(indices[t + 1], indices[t + 2]); link(indices[t + 2], indices[t]);
}

let lo = Infinity; let hi = -Infinity;
for (let i = 0; i < N; i++) { if (py(i) < lo) lo = py(i); if (py(i) > hi) hi = py(i); }
const H = hi - lo;

// ---------------------------------------------------------------------------
// Where the float ends and the strands begin
// ---------------------------------------------------------------------------

// Components of the sub-graph below a plane, as arrays of vertex indices.
// Anything under a handful of vertices is a scrap of surface clipped by the
// plane rather than a filament, and is not counted.
const MIN_STRAND_VERTS = 12;
function strandsBelow(yCut) {
  const below = [];
  const mark = new Int32Array(N).fill(-1);
  for (let i = 0; i < N; i++) if (py(i) < yCut) { mark[i] = 0; below.push(i); }
  const seen = new Int32Array(N).fill(-1);
  const out = [];
  for (const s of below) {
    if (seen[s] >= 0) continue;
    const id = out.length;
    const group = [];
    const stack = [s];
    seen[s] = id;
    while (stack.length) {
      const v = stack.pop();
      group.push(v);
      for (const w of neighbours[v]) if (mark[w] === 0 && seen[w] < 0) { seen[w] = id; stack.push(w); }
    }
    out.push(group);
  }
  return out.filter((g) => g.length >= MIN_STRAND_VERTS);
}

// THE SWEEP. From just under the top of the model to just above the bottom.
// The count of filaments crossing the plane rises through the crown, holds
// while every filament is present, then falls away as the short ones end. The
// crown is the HIGHEST plane whose count is within one of the maximum: cut any
// higher and two filaments are still joined by float, cut any lower and the
// shortest ones are already behind you and would be rigged to nothing.
const SWEEP = 120;
const profile = [];
for (let s = 1; s < SWEEP; s++) {
  const y = hi - (H * s) / SWEEP;
  profile.push([y, strandsBelow(y).length]);
}
const peak = Math.max(...profile.map(([, c]) => c));
if (peak < 2) {
  console.error('the sweep never found more than one strand — this is not a shape this tool can rig');
  process.exit(1);
}
const crownAt = profile.find(([, c]) => c >= peak - 1);
const crownY = crownAt[0];
const strands = strandsBelow(crownY);
console.log(`  crown y ${crownY.toFixed(3)} (${((hi - crownY) / H * 100).toFixed(0)}% down), ${strands.length} strands, peak ${peak}`);

// ---------------------------------------------------------------------------
// The skeleton
// ---------------------------------------------------------------------------

// A strand's own centre-line, sampled as the centroid of horizontal bands.
// The centroid rather than any extreme vertex, so a bulb halfway down does not
// drag the line sideways and leave the bone running outside its own flesh.
function centreLine(verts, bands) {
  let a = Infinity; let b = -Infinity;
  for (const i of verts) { if (py(i) < a) a = py(i); if (py(i) > b) b = py(i); }
  const out = [];
  for (let k = 0; k < bands; k++) {
    const y0 = a + ((b - a) * k) / bands;
    const y1 = a + ((b - a) * (k + 1)) / bands;
    let n = 0; let sx = 0; let sy = 0; let sz = 0;
    for (const i of verts) {
      if (py(i) < y0 || (k < bands - 1 ? py(i) >= y1 : py(i) > y1)) continue;
      sx += px(i); sy += py(i); sz += pz(i); n++;
    }
    if (n) out.push([sx / n, sy / n, sz / n]);
  }
  return out.reverse(); // top of the strand first, so a chain reads root -> tip
}

const floatVerts = [];
for (let i = 0; i < N; i++) if (py(i) >= crownY) floatVerts.push(i);
const centroid = (verts) => {
  let sx = 0; let sy = 0; let sz = 0;
  for (const i of verts) { sx += px(i); sy += py(i); sz += pz(i); }
  return [sx / verts.length, sy / verts.length, sz / verts.length];
};

// THE FLOAT IS TWO BONES, not one. A man o' war's crest is a sail standing
// well proud of the body — on this scan it reaches z = 1.99 against a body
// half-width of 0.79 — and a single rigid bone through the whole float means
// the one part of the animal that obviously catches the water cannot move at
// all. `float` is the root and carries the body; `crest` hangs off it at the
// top so the sail can be leant.
const floatAt = centroid(floatVerts);
let crestTop = floatVerts[0];
for (const i of floatVerts) if (py(i) > py(crestTop)) crestTop = i;
const crestAt = [(floatAt[0] + px(crestTop)) / 2, (floatAt[1] + py(crestTop)) / 2, (floatAt[2] + pz(crestTop)) / 2];

const bones = [];      // { name, parent, position } — what writeSkinnedGlb wants
const boneSeg = [];    // the segment of flesh each bone carries, for skinning
const boneStrand = []; // which strand a bone belongs to, or -1 for the float
const addBone = (name, parent, position, to, strand) => {
  bones.push({ name, parent, position });
  boneSeg.push([position, to]);
  boneStrand.push(strand);
  return bones.length - 1;
};
const FLOAT = addBone('float', null, floatAt, crestAt, -1);
addBone('crest', FLOAT, crestAt, [px(crestTop), py(crestTop), pz(crestTop)], -1);

// Longest strand first, so the bone list reads longest-to-shortest and the
// names are stable against a re-run: a strand's index is a fact about its
// length rather than about which vertex the flood fill happened to start on.
strands.sort((a, b) => {
  const spanOf = (g) => { let a2 = Infinity; let b2 = -Infinity; for (const i of g) { if (py(i) < a2) a2 = py(i); if (py(i) > b2) b2 = py(i); } return b2 - a2; };
  return spanOf(b) - spanOf(a);
});

let longest = 0;
for (const g of strands) { let a = Infinity; let b = -Infinity; for (const i of g) { if (py(i) < a) a = py(i); if (py(i) > b) b = py(i); } longest = Math.max(longest, b - a); }

const strandInfo = [];
strands.forEach((group, s) => {
  let a = Infinity; let b = -Infinity;
  for (const i of group) { if (py(i) < a) a = py(i); if (py(i) > b) b = py(i); }
  const span = b - a;
  const count = Math.max(
    MIN_BONES_PER_STRAND,
    Math.round(MIN_BONES_PER_STRAND + (MAX_BONES_PER_STRAND - MIN_BONES_PER_STRAND) * (span / longest)),
  );
  // One band per bone plus one, so every bone has a segment ending at the next
  // sample and the last one ends at the tip.
  const line = centreLine(group, count + 1);
  if (line.length < 2) return;
  let parent = FLOAT;
  const chain = [];
  for (let k = 0; k < line.length - 1; k++) {
    parent = addBone(`strand${s}_${k}`, parent, line[k], line[k + 1], s);
    chain.push(parent);
  }
  strandInfo.push({ s, verts: group.length, span, bones: chain.length, top: line[0], tip: line[line.length - 1] });
});

// ---------------------------------------------------------------------------
// Skinning
// ---------------------------------------------------------------------------

// A vertex's PART is its strand, or the float. This is the wall that stops a
// filament claiming its neighbour's flesh — two strands can pass within a few
// hundredths of each other on a scan of a drifting animal, so nearest-segment
// alone hands one strand's midriff to the one beside it, and then they swing
// apart and tear a hole between them. Membership came from the graph, and no
// distance test may overrule it.
const part = new Int32Array(N).fill(-1);
strands.forEach((group, s) => { for (const i of group) part[i] = s; });

function segDist(p, a, b) {
  const abx = b[0] - a[0]; const aby = b[1] - a[1]; const abz = b[2] - a[2];
  const apx = p[0] - a[0]; const apy = p[1] - a[1]; const apz = p[2] - a[2];
  const len2 = abx * abx + aby * aby + abz * abz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / len2)) : 0;
  return Math.hypot(apx - abx * t, apy - aby * t, apz - abz * t);
}

// The float's two bones are candidates for every vertex, not just the float's
// own. A strand's topmost ring IS the crown, and it should be held partly by
// the body it hangs from — otherwise the join is a hinge with nothing on the
// far side of it.
const owner = new Int32Array(N);
for (let i = 0; i < N; i++) {
  const p = [px(i), py(i), pz(i)];
  let best = FLOAT; let bestD = Infinity;
  for (let k = 0; k < bones.length; k++) {
    if (boneStrand[k] !== -1 && boneStrand[k] !== part[i]) continue;
    const d = segDist(p, boneSeg[k][0], boneSeg[k][1]);
    if (d < bestD) { bestD = d; best = k; }
  }
  owner[i] = best;
}

// Laplacian smoothing over the vertex graph turns the hard edge between two
// bones into a blend about three vertices wide. The graph only crosses between
// strands at the crown, so the blend happens along each filament and where it
// meets the float, and nowhere between two filaments that merely pass close.
const B = bones.length;
let W = new Float64Array(N * B);
for (let i = 0; i < N; i++) W[i * B + owner[i]] = 1;
const PASSES = 6;
for (let pass = 0; pass < PASSES; pass++) {
  const next = new Float64Array(N * B);
  for (let i = 0; i < N; i++) {
    let count = 1;
    for (let k = 0; k < B; k++) next[i * B + k] = W[i * B + k];
    for (const j of neighbours[i]) {
      for (let k = 0; k < B; k++) next[i * B + k] += W[j * B + k];
      count++;
    }
    for (let k = 0; k < B; k++) next[i * B + k] /= count;
  }
  W = next;
}

// glTF carries four influences. Keep the four heaviest and renormalise — and
// assert every row still sums to one, because a vertex that comes out with
// four zeros binds to nothing, sits at the origin, and drags a spike across
// the scene without anything throwing.
const jointsOut = new Uint16Array(N * 4);
const weightsOut = new Float32Array(N * 4);
let maxInfluences = 0;
let worstSum = 1;
for (let i = 0; i < N; i++) {
  const row = [];
  for (let k = 0; k < B; k++) if (W[i * B + k] > 0.02) row.push([k, W[i * B + k]]);
  row.sort((a, b) => b[1] - a[1]);
  const top = row.slice(0, 4);
  if (!top.length) { console.error(`vertex ${i} has no bone`); process.exit(1); }
  maxInfluences = Math.max(maxInfluences, top.length);
  const total = top.reduce((s, r) => s + r[1], 0);
  for (let k = 0; k < top.length; k++) {
    jointsOut[i * 4 + k] = top[k][0];
    weightsOut[i * 4 + k] = top[k][1] / total;
  }
  let sum = 0;
  for (let k = 0; k < 4; k++) sum += weightsOut[i * 4 + k];
  worstSum = Math.min(worstSum, sum);
}
if (worstSum < 0.999) { console.error(`a weight row sums to ${worstSum} — the mesh would tear`); process.exit(1); }

// ---------------------------------------------------------------------------
// Out
// ---------------------------------------------------------------------------

console.log('  STRANDS (longest first)');
for (const s of strandInfo) {
  console.log(`    strand${String(s.s).padEnd(2)} ${String(s.verts).padStart(5)} verts  span ${s.span.toFixed(2)}  ${s.bones} bones  `
    + `top [${s.top.map((v) => v.toFixed(2)).join(', ')}] tip [${s.tip.map((v) => v.toFixed(2)).join(', ')}]`);
}

if (dry) { console.log('\n  --dry, wrote nothing'); process.exit(0); }

const out = writeSkinnedGlb({
  positions,
  normals,
  uvs: new Float32Array(N * 2), // the source's were degenerate; these are honestly zero
  indices,
  joints: jointsOut,
  weights: weightsOut,
  bones,
  // White glass. The alpha is the one number the dropped baseColour map
  // carried; the transmission map's 0.68 has nowhere to live without an
  // extensionsUsed entry, and the surface preset governs the look anyway.
  materials: [{
    name: 'manowar',
    alphaMode: 'BLEND',
    doubleSided: true,
    pbrMetallicRoughness: {
      baseColorFactor: [1, 1, 1, 0.318],
      metallicFactor: 0,
      roughnessFactor: 0.6,
    },
  }],
  name: 'manowar',
});
writeFileSync(OUT, out);

const perBone = new Array(B).fill(0);
for (let i = 0; i < N; i++) perBone[owner[i]]++;
const orphans = perBone.filter((c) => c === 0).length;
console.log(`\n  wrote ${OUT} — ${(out.length / 1024 / 1024).toFixed(2)} MB, ${B} bones, `
  + `up to ${maxInfluences} influences per vertex, ${orphans} bones owning no vertex outright`);
