// Turns Squid_01.obj from the sea-animals-01 pack into public/models/squid.glb.
//
//   node tools/build-squid.mjs [source.obj] [out.glb]
//
// The shared defects of that pack — no normals, no smoothing groups, non-indexed
// quads, CRLF — are handled in tools/lib/obj-glb.mjs. What is specific to this
// model, and what took measuring:
//
//   1. THE MTL WIRES NOTHING. One material, `wire_087224198`, holding a flat
//      teal Kd — the 3ds Max wireframe-colour default. The five 4096x4096 PBR
//      maps sit next to it unreferenced, so anything that trusts the MTL renders
//      a solid cyan blob. Only the diffuse is carried over here; the asset entry
//      lights this model with the shared creature material and never samples the
//      other four. (The octopus in the same pack DOES wire its maps. Do not
//      assume either way for the next one.)
//
//   2. THE POSE IS OFF-AXIS. The body runs diagonally through XZ — principal
//      axis (0.582, 0.136, -0.802). No `forward`/`up` pair in assets.js can
//      express a diagonal, so the rotation is baked here and the entry gets a
//      clean '+Z'/'+Y'.
//
//      This is also what makes the source bounding box lie. 23.2 x 9.6 x 26.5
//      reads as a squat splayed thing; it is actually a STREAMLINED squid whose
//      axis-aligned box is inflated by running corner to corner through it.
//      Rotated onto its own axis the box is 0.475 x 0.252 x 1.000 — better than
//      2:1, arms gathered, a clean swimming silhouette. Anything measured along
//      world Z on the raw file ("how much of this is arm") is measuring the
//      diagonal, and has to be re-measured after the rotation.
//
//   3. NOTHING IN THE FILE SAYS WHICH END LEADS. Both ends of a squid taper, so
//      the usual shape heuristics are nearly useless on one: split at the
//      midpoint of its own axis this mesh carries 461 vs 437 units of surface
//      area, a 5% margin, and 0.240 vs 0.234 max radius. The mantle is the
//      heavier half by both, and by margins far too thin to bet on — which is
//      why the direction is checked against a RENDERED PLATE (tools/atlas-render)
//      and not believed from the numbers alone. An earlier pass keyed on mean
//      off-axis radius and got it exactly backwards: a gathered arm bundle is
//      more compact than a finned mantle, not less.
//
// NOT decimated, unlike the octopus in the same pack. 24,928 triangles is
// already inside the roster's budget, and every triangle removed from a mesh
// this size comes off a tentacle silhouette.
//
// What cannot be fixed: the arms are frozen in the pose the artist left them in.
// OBJ carries no bones, and the only rig-capable sibling is a 2017 VRay .c4d.
// That pose is a good one — arms gathered and trailing, the shape a squid holds
// while swimming — so the creature gets a plain `chase`, the one behaviour that
// keeps a static mesh travelling nose-first.
//
// Source art is never written to: this reads from _ASSETS and writes only to
// public/models, so re-running it after a new export is the whole update.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { parseObj, weld, smoothNormals, principalAxis, basisTo, areaSplit, writeGlb } from './lib/obj-glb.mjs';

const SRC = process.argv[2]
  ?? '/Users/ethangoldhammer/Documents/_C4D/_ASSETS/_Nature/096421758-sea-animals-01/Squid_01.obj';
const OUT = process.argv[3]
  ?? path.resolve(import.meta.dirname, '../public/models/squid.glb');
const TEX = path.resolve(path.dirname(SRC), 'Squid_Diffuse.png');

// 4096 is a still-render size. At the scale this renders in game — a couple of
// hundred pixels at most — 1024 is already generous, and it takes the map from
// a 23MB PNG to a fraction of that as WebP.
const TEX_SIZE = 1024;
const TEX_QUALITY = 82;

const parsed = parseObj(fs.readFileSync(SRC, 'utf8'));
console.log(`parsed  ${parsed.positions.length} positions, ${parsed.uvs.length} uvs, ${parsed.faces.length} triangles`);

// --- orient ---------------------------------------------------------------
// FORWARD LEADS WITH THE ARMS, which is the opposite of "how a squid jets".
// Both are real — a squid jets mantle-first to flee and swims arms-first to
// hunt — and this one is chasing the player. Leading with the tentacles points
// its eyes and its grasping end at what it is closing on and leaves the fins
// trailing where they read as propulsion. Mantle-first would send it at the
// seal tail-first with its face pointing home.
const { axis, centroid } = principalAxis(parsed.positions);
const { neg, pos } = areaSplit(parsed.positions, parsed.faces, axis, centroid);
const mantleAtNeg = neg > pos;
const forward = axis.map((x) => (mantleAtNeg ? x : -x));
console.log(`axis    (${axis.map((x) => x.toFixed(3)).join(', ')})`);
console.log(`area    -t ${neg.toFixed(1)} vs +t ${pos.toFixed(1)} => mantle at ${mantleAtNeg ? '-t' : '+t'}, arms lead`);

const welded = weld(parsed, basisTo(forward, [0, 1, 0], centroid));
console.log(`welded  ${parsed.faces.length * 3} loose verts -> ${welded.positions.length / 3}`);

const normals = smoothNormals(welded.positions, welded.indices, welded.posOf, welded.srcCount);

// --- scale ----------------------------------------------------------------
// Normalised so the longest bbox axis is 1. prepareModel re-scales to `fit`
// anyway, but shipping a unit model means the number in assets.js reads as
// world units instead of as a ratio against 26.5 arbitrary ones.
const verts = welded.positions.length / 3;
const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < verts; i++) for (let k = 0; k < 3; k++) {
  mn[k] = Math.min(mn[k], welded.positions[i * 3 + k]);
  mx[k] = Math.max(mx[k], welded.positions[i * 3 + k]);
}
const span = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
const s = 1 / Math.max(...span);
const positions = new Float32Array(verts * 3);
for (let i = 0; i < verts * 3; i++) positions[i] = welded.positions[i] * s;

// Where the mantle ends and the arms begin, by the same area measure but per
// slice. `fit` scales the WHOLE length, so this is what says how much of that
// number buys body and how much buys trailing arm.
const SLICES = 40;
const zLo = mn[2] * s, zHi = mx[2] * s;
const sliceArea = new Array(SLICES).fill(0);
for (let i = 0; i < welded.indices.length; i += 3) {
  const p = [0, 1, 2].map((k) => {
    const v = welded.indices[i + k];
    return [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
  });
  const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
  const e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
  const A = Math.hypot(
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ) / 2;
  const zc = (p[0][2] + p[1][2] + p[2][2]) / 3;
  sliceArea[Math.min(SLICES - 1, Math.floor((zc - zLo) / (zHi - zLo) * SLICES))] += A;
}
// The waist: thinnest slice in the middle third, i.e. where the mantle closes
// up and the arm bundle begins.
let waist = Math.floor(SLICES / 2);
for (let k = Math.floor(SLICES * 0.33); k < Math.floor(SLICES * 0.66); k++) {
  if (sliceArea[k] < sliceArea[waist]) waist = k;
}
const total = zHi - zLo;
const mantleLen = (waist + 0.5) / SLICES * total;
console.log(`bbox    ${span.map((x) => (x * s).toFixed(3)).join(' x ')} (normalised, body axis on +Z)`);
console.log(`split   mantle ${mantleLen.toFixed(3)} + arms ${(total - mantleLen).toFixed(3)} — ${(mantleLen / total * 100).toFixed(0)}% body`);
console.log(`        at fit=F: total F units, mantle ~${mantleLen.toFixed(2)}*F, arms ~${(total - mantleLen).toFixed(2)}*F`);

// --- texture --------------------------------------------------------------
const webp = await sharp(TEX).resize(TEX_SIZE, TEX_SIZE, { fit: 'fill' }).webp({ quality: TEX_QUALITY }).toBuffer();
console.log(`texture ${(fs.statSync(TEX).size / 1e6).toFixed(1)}MB png -> ${(webp.length / 1024).toFixed(0)}KB webp ${TEX_SIZE}`);

const { glb, tris, indexBits } = writeGlb({
  positions,
  normals,
  uvs: welded.uvs,
  indices: welded.indices,
  images: [{ buffer: webp, mimeType: 'image/webp' }],
  material: { baseColor: 0, roughness: 0.7 },
  name: 'Squid',
});
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, glb);

console.log(`\n${path.basename(SRC)} -> ${path.basename(OUT)} ${(glb.length / 1024).toFixed(0)}KB`);
console.log(`  ${verts} verts / ${tris} tris, uint${indexBits} indices, smooth normals, forward +Z / up +Y`);
