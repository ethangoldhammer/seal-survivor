// Turns Octopus.obj from the sea-animals-01 pack into public/models/octopus.glb.
//
//   node tools/build-octopus.mjs [source.obj] [out.glb] [targetTris]
//
// This is the squid's pipeline (tools/lib/obj-glb.mjs, and see build-squid.mjs
// for the pack's shared defects) plus the one stage the squid did not need:
// DECIMATION. Measured, the source is
//
//     143,666 triangles   71,879 positions / 81,241 uvs
//     430,998 loose verts (non-indexed quads)
//     377.6 x 191.6 x 428.0 bounding box
//
// Two independent things are wrong with that, and they need different fixes.
//
//   THE VERTEX COUNT IS AN ENCODING ARTEFACT. 431k loose verts is what a
//   non-indexed OBJ export looks like; welding takes it to 81,243 without
//   touching a single triangle. That is a 5.3x win for free — but it is not a
//   fix, because the triangle count is unchanged and triangles are what cost.
//
//   THE TRIANGLE COUNT IS REAL. 143,666 is roughly six times the squid and
//   twenty times the hammerhead. It also puts the welded mesh over 65,535
//   vertices, which forces 32-bit indices and doubles the index buffer. Only
//   actual simplification fixes that.
//
// Welding and simplifying are not alternatives, and the order matters: a
// simplifier can do nothing at all with an unwelded mesh, because no two
// triangles share a vertex and there is no edge to collapse. Weld, then
// simplify. (optimize-hammerhead.mjs only welds, correctly — its source was
// already 6,764 triangles and all of its bloat was duplicate vertices.)
//
// THE SIMPLIFIER IS meshoptimizer, AND THAT IS THE LOAD-BEARING CHOICE.
// three.js ships SimplifyModifier and it was the obvious thing to reach for.
// It does not work on this mesh. It collapses edges without testing the link
// condition, so it changes topology as it goes: handed a mesh with every hole
// capped and ZERO open edges, it returned one with 8,012 OPEN EDGES IN 367
// LOOPS. Most are small enough to hide. One lands on the smooth curve of the
// mantle beside the eye and reads as a hard-edged dark gash — present at 2.5x
// reduction and no worse at 8.5x, which is the tell that these are not
// proportional damage but simply wherever the algorithm broke the surface.
//
// That gash survives every fix aimed at the wrong cause, and each of those is a
// plausible story that measures out clean:
//   * not UVs — it is still there on an untextured white render
//   * not winding — the source's interior edges are already 100% consistent
//   * not seam tearing — still there when decimating a position-welded mesh
//   * not the mouth boundary — still there after capping both loops
//
// meshopt_simplify builds an internal POSITION REMAP before it starts, so it
// knows that two vertices split across a UV seam are one point on the surface,
// and it preserves topology and attribute seams by construction. Same mesh,
// same target: 0 open edges, in 0.1s instead of 20.
//
// The UV range and non-finite count are still checked afterwards, because a
// silently untextured model is the bug that cost this project a hammerhead
// once already — see optimize-hammerhead.mjs.
//
// Normals are recomputed AFTER decimating, not carried through it. A simplifier
// interpolates whatever normals it is handed, and interpolated normals on a mesh
// whose triangles have all moved are wrong in a way that shows as blotchy
// shading.
//
// UNLIKE THE SQUID, THIS MODEL'S MTL IS HONEST: it references
// Octopus_Diffuse.png and Map__7_Normal_Bump.png, and both are carried over.
// The normal map is the whole reason this animal reads — the suckers are
// entirely in it, not in the geometry, which is also what makes it safe to take
// 85% of the triangles away.
//
// Source art is never written to: this reads from _ASSETS and writes only to
// public/models.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { MeshoptSimplifier } from 'meshoptimizer';
import { parseObj, weld, weldByPosition, capHoles, smoothNormals, principalAxis, basisTo, areaSplit, writeGlb } from './lib/obj-glb.mjs';

const SRC = process.argv[2]
  ?? '/Users/ethangoldhammer/Documents/_C4D/_ASSETS/_Nature/096421758-sea-animals-01/Octopus.obj';
const OUT = process.argv[3]
  ?? path.resolve(import.meta.dirname, '../public/models/octopus.glb');
const TARGET_TRIS = +(process.argv[4] ?? 22000);

const DIR = path.dirname(SRC);
const TEX_DIFFUSE = path.join(DIR, 'Octopus_Diffuse.png');
const TEX_NORMAL = path.join(DIR, 'Map__7_Normal_Bump.png');
const TEX_SIZE = 1024;

const parsed = parseObj(fs.readFileSync(SRC, 'utf8'));
console.log(`parsed   ${parsed.positions.length} positions, ${parsed.uvs.length} uvs, ${parsed.faces.length} triangles`);

// --- orient ---------------------------------------------------------------
// Same measure as the squid: principal axis, then surface area either side of
// its midpoint. The head/mantle is the solid end and the arms taper, so the
// heavier half is the head. Forward leads with the ARMS — an octopus closing on
// something leads with its arms, and it keeps the eyes pointing at the target.
const { axis, centroid } = principalAxis(parsed.positions);
const { neg, pos } = areaSplit(parsed.positions, parsed.faces, axis, centroid);
const headAtNeg = neg > pos;
const forward = axis.map((x) => (headAtNeg ? x : -x));
console.log(`axis     (${axis.map((x) => x.toFixed(3)).join(', ')})`);
console.log(`area     -t ${neg.toFixed(0)} vs +t ${pos.toFixed(0)} => head at ${headAtNeg ? '-t' : '+t'}, arms lead`);

// --- transform ------------------------------------------------------------
// Rotation and scale are resolved up front and applied to the SOURCE point
// list, so the decimated mesh and the surface transferUvs samples from are in
// one space. Normalising before decimating also matters on its own: the
// simplifier's error metric is in world units, and a 428-unit model makes its
// thresholds mean something different than a 1-unit one.
const rot = basisTo(forward, [0, 1, 0], centroid);
const rotated = parsed.positions.map(rot);
const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
for (const p of rotated) for (let k = 0; k < 3; k++) {
  if (p[k] < mn[k]) mn[k] = p[k];
  if (p[k] > mx[k]) mx[k] = p[k];
}
const span = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
const s = 1 / Math.max(...span);
const srcPositions = rotated.map((p) => [p[0] * s, p[1] * s, p[2] * s]);
const xform = (p) => { const q = rot(p); return [q[0] * s, q[1] * s, q[2] * s]; };
console.log(`bbox     ${span.map((x) => (x * s).toFixed(3)).join(' x ')} (normalised, body axis on +Z)`);

// --- cap the mouth --------------------------------------------------------
// Found on the CLOSED index list, because a uv-split weld turns every seam into
// a false boundary and buries the two real ones in 18,790 of them. See capHoles
// for why leaving these in is what produces the dark gap in the head.
const closed = weldByPosition(parsed, xform);
console.log(`welded   ${parsed.faces.length * 3} loose verts -> ${closed.positions.length / 3} by position (closed)`);
const capped = capHoles(parsed, closed.indices);
console.log(`capped   ${capped.loops} open boundary loop(s) filled with ${capped.capped} triangles`);

// The decimator gets the UV-SPLIT weld. Carrying UVs through the collapse is
// what keeps the texture exact — an earlier pass decimated the closed mesh and
// re-projected the UVs afterwards, and re-projection smeared them badly wherever
// an output triangle picked up the wrong source triangle across a thin arm.
const welded = weld(capped, xform);
const weldedVerts = welded.positions.length / 3;
console.log(`         -> ${weldedVerts} by position+uv (seams split, for decimation)`);
const scaled = welded.positions;

// --- decimate -------------------------------------------------------------
// meshoptimizer, NOT three's SimplifyModifier.
//
// That was the first choice here and it does not work on this mesh. three's
// simplifier collapses edges without testing the link condition, so it changes
// the topology as it goes: fed a mesh with every hole capped and zero open
// edges, it returned one with 8,012 OPEN EDGES IN 367 LOOPS. Most are small
// enough to hide, but one lands on the smooth curve of the mantle beside the
// eye and reads as a hard-edged dark gash. It is there at 2.5x reduction and no
// worse at 8.5x, which is the tell: the tears are not proportional damage, they
// are just where the algorithm happened to break the surface.
//
// meshopt_simplify builds an internal POSITION REMAP first, so it understands
// that two vertices split across a UV seam are one point on the surface, and it
// preserves topology and attribute seams by construction. `simplifyWithAttributes`
// additionally carries the UVs as a weighted error term, so texture stretch is
// part of what it minimises rather than something repaired afterwards.
//
// The attribute weight is deliberately low. UV error and position error are in
// different units, and weighting UVs heavily makes the simplifier protect the
// atlas layout at the cost of the silhouette — on an animal that is mostly thin
// tapering arms, the silhouette is the whole read.
await MeshoptSimplifier.ready;
const srcIndices = new Uint32Array(welded.indices);
console.log(`decimate ${weldedVerts} verts / ${srcIndices.length / 3} tris -> target ~${TARGET_TRIS} tris…`);
const t0 = Date.now();
const [simpIndices, simpError] = MeshoptSimplifier.simplifyWithAttributes(
  srcIndices,
  scaled, 3,
  welded.uvs, 2,
  [0.05, 0.05],
  null,
  TARGET_TRIS * 3,
  1.0, // allow whatever error the target count needs; the count is the budget
  [],
);
// Drop the vertices nothing references any more and renumber. Done by hand
// rather than with MeshoptSimplifier.compactMesh: that returns a remap sized to
// the INDEX BUFFER's own vertex range, not to this vertex array, and indexing a
// 81,245-entry array with it silently leaves most vertices at the origin. The
// result is not subtly wrong — every unwritten vertex collapses to (0,0,0) and
// the model renders as a black starburst.
const renum = new Map();
const outIdx = new Array(simpIndices.length);
for (let i = 0; i < simpIndices.length; i++) {
  const old = simpIndices[i];
  let n = renum.get(old);
  if (n === undefined) renum.set(old, n = renum.size);
  outIdx[i] = n;
}
const outVerts = renum.size;
const outPos = new Float32Array(outVerts * 3);
const outUv = new Float32Array(outVerts * 2);
for (const [old, n] of renum) {
  outPos[n * 3] = scaled[old * 3];
  outPos[n * 3 + 1] = scaled[old * 3 + 1];
  outPos[n * 3 + 2] = scaled[old * 3 + 2];
  outUv[n * 2] = welded.uvs[old * 2];
  outUv[n * 2 + 1] = welded.uvs[old * 2 + 1];
}
console.log(`         ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${outVerts} verts / ${outIdx.length / 3} tris `
  + `(${(parsed.faces.length / (outIdx.length / 3)).toFixed(1)}x fewer triangles, error ${simpError.toFixed(5)})`);

// --- topology audit -------------------------------------------------------
// The check three's simplifier fails. Counted on a POSITION weld so UV seams do
// not register as boundaries — the input is fully closed after capHoles, so
// anything here is a tear the simplifier introduced.
{
  const pw = new Map(), w = new Array(outVerts);
  for (let i = 0; i < outVerts; i++) {
    const k = `${outPos[i * 3].toFixed(5)}_${outPos[i * 3 + 1].toFixed(5)}_${outPos[i * 3 + 2].toFixed(5)}`;
    let a = pw.get(k);
    if (a === undefined) pw.set(k, a = pw.size);
    w[i] = a;
  }
  const use = new Map();
  for (let i = 0; i < outIdx.length; i += 3) {
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const u = w[outIdx[i + a]], v = w[outIdx[i + b]];
      const k = u < v ? `${u}_${v}` : `${v}_${u}`;
      use.set(k, (use.get(k) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const n of use.values()) if (n === 1) open++;
  console.log(`topology ${open} open edges (input was closed; three's SimplifyModifier left 8,012 here)`);
  if (open > 2000) throw new Error(`simplifier tore the surface: ${open} open edges`);
}

// --- uv integrity ---------------------------------------------------------
// The check optimize-hammerhead exists because nobody ran. A mesh with no UVs,
// or with UVs pushed outside the atlas, still compiles and still renders — it
// just paints the animal in one arbitrary texel, which looks like a lighting
// bug rather than a missing attribute.
let nonFinite = 0, uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
for (let i = 0; i < outVerts; i++) {
  const u = outUv[i * 2], v = outUv[i * 2 + 1];
  if (!Number.isFinite(u) || !Number.isFinite(v)) nonFinite++;
  uMin = Math.min(uMin, u); uMax = Math.max(uMax, u);
  vMin = Math.min(vMin, v); vMax = Math.max(vMax, v);
}
if (nonFinite) throw new Error(`${nonFinite} vertices carry non-finite UVs`);
if (uMin < -0.01 || uMax > 1.01 || vMin < -0.01 || vMax > 1.01) {
  throw new Error(`UVs left the atlas: u[${uMin.toFixed(3)}, ${uMax.toFixed(3)}] v[${vMin.toFixed(3)}, ${vMax.toFixed(3)}]`);
}
console.log(`uv       ok — u[${uMin.toFixed(3)}, ${uMax.toFixed(3)}] v[${vMin.toFixed(3)}, ${vMax.toFixed(3)}], 0 non-finite`);

// --- normals --------------------------------------------------------------
// Recomputed, not carried through the collapse: the simplifier interpolates
// whatever normals it is handed, and interpolated normals on a mesh whose
// triangles have all moved are wrong in a way that shows as blotchy shading.
//
// `groups` re-derives which vertices are the same POINT (the decimated mesh is
// still split at every UV seam) so the average crosses a seam instead of
// creasing at it.
const groups = new Map();
const posOf = new Array(outVerts);
for (let i = 0; i < outVerts; i++) {
  const k = `${outPos[i * 3].toFixed(5)}_${outPos[i * 3 + 1].toFixed(5)}_${outPos[i * 3 + 2].toFixed(5)}`;
  let at = groups.get(k);
  if (at === undefined) groups.set(k, at = groups.size);
  posOf[i] = at;
}
const normals = smoothNormals(outPos, outIdx, posOf, groups.size);
console.log(`normals  ${outVerts} verts over ${groups.size} distinct points — seams averaged across`);

// Winding audit on the RESULT. The repair happened on the source; this confirms
// none of it was undone, because a single flipped triangle at this scale is a
// black hole in the model rather than a speck.
{
  let bad = 0;
  for (let i = 0; i < outIdx.length; i += 3) {
    const p = [0, 1, 2].map((k) => outIdx[i + k]);
    const a = p.map((v) => [outPos[v * 3], outPos[v * 3 + 1], outPos[v * 3 + 2]]);
    const e1 = [a[1][0] - a[0][0], a[1][1] - a[0][1], a[1][2] - a[0][2]];
    const e2 = [a[2][0] - a[0][0], a[2][1] - a[0][1], a[2][2] - a[0][2]];
    const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const len = Math.hypot(...fn);
    if (len < 1e-12) continue;
    let d = 0;
    for (const v of p) d += (fn[0] * normals[v * 3] + fn[1] * normals[v * 3 + 1] + fn[2] * normals[v * 3 + 2]) / len;
    if (d < 0) bad++;
  }
  console.log(`winding  ${bad} triangles still lit from behind after decimating`);
  if (bad > outIdx.length / 3 * 0.05) throw new Error(`${bad} triangles will render black`);
}

// --- textures -------------------------------------------------------------
const [diffuse, normalMap] = await Promise.all([
  sharp(TEX_DIFFUSE).resize(TEX_SIZE, TEX_SIZE, { fit: 'fill' }).webp({ quality: 82 }).toBuffer(),
  // The normal map is encoded data, not a picture: WebP's chroma handling can
  // tint a normal and tilt every lit surface slightly. Quality is held high and
  // it is checked visually rather than trusted at the same 82 as the colour.
  sharp(TEX_NORMAL).resize(TEX_SIZE, TEX_SIZE, { fit: 'fill' }).webp({ quality: 92 }).toBuffer(),
]);
console.log(`texture  diffuse ${(fs.statSync(TEX_DIFFUSE).size / 1e6).toFixed(1)}MB -> ${(diffuse.length / 1024).toFixed(0)}KB`
  + `, normal ${(fs.statSync(TEX_NORMAL).size / 1e6).toFixed(1)}MB -> ${(normalMap.length / 1024).toFixed(0)}KB (webp ${TEX_SIZE})`);

const { glb, verts, tris, indexBits } = writeGlb({
  positions: outPos,
  normals,
  uvs: outUv,
  indices: outIdx,
  images: [
    { buffer: diffuse, mimeType: 'image/webp' },
    { buffer: normalMap, mimeType: 'image/webp' },
  ],
  // 0.3 is the `-bm` bump multiplier the source MTL asks for. Carried across
  // rather than defaulted to 1, which on a map this detailed reads as gravel.
  material: { baseColor: 0, normal: 1, normalScale: 0.3, roughness: 0.75 },
  name: 'Octopus',
});
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, glb);

const srcBytes = fs.statSync(SRC).size + fs.statSync(TEX_DIFFUSE).size + fs.statSync(TEX_NORMAL).size;
console.log(`\n${path.basename(SRC)} + 2 maps ${(srcBytes / 1e6).toFixed(1)}MB -> ${path.basename(OUT)} ${(glb.length / 1024).toFixed(0)}KB`);
console.log(`  ${verts} verts / ${tris} tris, uint${indexBits} indices, smooth normals, forward +Z / up +Y`);
