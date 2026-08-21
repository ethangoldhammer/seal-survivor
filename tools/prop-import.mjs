#!/usr/bin/env node
// ---------------------------------------------------------------------------
// IMPORT A LIT PBR PROP PACK — one game-ready .glb per object.
//
//   node tools/prop-import.mjs <in.glb> --id barrel
//   node tools/prop-import.mjs <in.glb> --split --drop=Grave3 --seat --plate
//   node tools/prop-import.mjs <in.glb> --id barrel --write
//
// WHY THIS EXISTS ALONGSIDE tools/split-seabed.mjs. That tool is the seabed's,
// and not by naming alone: `--write` regenerates path/src/seabedProps.js from
// whatever it just processed, so pointing it at a pack of gravestones replaces
// the entire seabed prop table with three gravestones. It also assumes the
// SeaFlora pack's materials — unlit, black base colour, art in the emissive
// slot — and "repairs" a normal lit material by copying its emissive FACTOR
// into base colour. On a Sketchfab PBR prop that factor is 0,0,0, so every
// object comes out pure black and nothing throws.
//
// So this is the lit-PBR route: no shape grouping, no generated species table,
// and no material repair beyond what the game's own pipeline needs.
//
// WHAT IT ACTUALLY FIXES, because it is not what "optimise a model" suggests.
// These packs arrive at 1,000–7,000 triangles — against a 428,649-triangle
// roster, decimating them saves nothing worth measuring. What they arrive with
// is THREE 1024-square PNGs each (base, normal, metallic-roughness), and that
// is 16MB of VRAM per prop before anything is drawn. `npm run tex` prints the
// two costs separately for this reason. So the work here is texture:
//
//   1. CROP each map to the object's own UV box. A pack that lays four graves
//      out on one atlas gives each grave a patch of it — cropping is what stops
//      four files carrying four copies of the whole sheet.
//   2. ...ACROSS EVERY SLOT, WITH ONE UV REMAP. This is the part that is easy
//      to get wrong and impossible to see: base, normal and MR share
//      TEXCOORD_0, so cropping each one and remapping the UVs each time applies
//      the remap three times. The crop box is therefore computed ONCE and the
//      UVs are rewritten ONCE, after every slot has been cut to it. A tool that
//      crops only the base map — as the seabed one does, correctly, because
//      that pack has no other slot — leaves the normal and MR maps at full size
//      and reports a VRAM saving that is 33x better than the truth.
//   3. CAP the result. `--maxtex` fits the crop UP to a power of two, capped.
//      256 is more texel than a prop that covers 40 screen pixels can show.
//   4. RE-ENCODE to WebP, which is ~80% off disk and exactly 0% off VRAM.
//
// DECIMATION IS OPTIONAL AND OFF BY DEFAULT, and that is a claim about these
// packs rather than a shortcut: `--simplify=<ratio>` is there when a prop
// really is dense (a 6,752-triangle boulder is the one that would earn it), and
// it uses meshopt's own error bound. When a prop needs a MEASURED deviation
// rather than a bounded one — a bundle of separate strands, where the cheapest
// thing a simplifier can do is delete a whole strand at no cost to the bounding
// box — split-seabed.mjs already has the one-sided Hausdorff search, and that
// is the tool to reach for.
//
// `--plate` MEASURES THE INSCRIPTION FACE. A gravestone marking a previous
// run's death spot has to carry text, and the pack's stones share an atlas with
// no UV island of their own to paint into — so the text goes on a separate quad
// parented in front of the face. That quad needs to be placed, and placing it
// by eye is how you get a plate floating inside the stone. This finds the
// largest planar cluster of triangles by area, and reports its outward normal,
// its centre and its extents in the plane, in the same model units as `fit`.
//
// SAFE BY DEFAULT. Writes previews to .model-orig/props/ and nothing else;
// `--write` is what puts files in public/models/. Previews go outside public/
// because vite copies that folder into the build wholesale, so a spare .glb
// left there ships to every player.
// ---------------------------------------------------------------------------

import { Document, Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { copyToDocument, transformPrimitive, simplifyPrimitive, prune, dedup } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const num = (n, d) => {
  const a = argv.find((s) => s.startsWith(`--${n}=`));
  return a ? Number(a.split('=')[1]) : d;
};
const str = (n, d) => {
  const a = argv.find((s) => s.startsWith(`--${n}=`));
  return a ? a.split('=').slice(1).join('=') : d;
};

const SRC = argv.find((s) => !s.startsWith('--'));
if (!SRC) {
  console.error('\nusage: node tools/prop-import.mjs <in.glb> [--id name | --split] [options]\n');
  process.exit(1);
}

const write = has('write');
const split = has('split');
const seat = has('seat');           // base at y=0 — a prop that stands on the floor
const plate = has('plate');
const ID = str('id', path.basename(SRC, '.glb'));
const SUBDIR = str('dir', '');      // public/models/<dir>/
const MAXTEX = num('maxtex', 256);
const PAD = num('pad', 4);
const SIMPLIFY = num('simplify', 0);
const QUALITY = num('quality', 92);
// Slots to keep. A normal map costs as much VRAM as the base colour and is
// worth very little under this game's banded toon shading (systems/toonShade.js
// quantises the lambert term, which is most of what a normal map perturbs), so
// dropping it is usually right — but it is a look call, so it is a flag.
const DROP_SLOTS = str('drop-slots', '').split(',').map((s) => s.trim()).filter(Boolean);
const dropMeshes = new Set(str('drop', '').split(',').map((s) => s.trim()).filter(Boolean));
// --name=Grave1:slab,Grave2:headstone — the pack's names are a modeller's
// working notes and the game's are the ones that end up in assets.js.
const renames = new Map(
  str('name', '').split(',').map((s) => s.trim()).filter(Boolean)
    .map((pair) => pair.split(':').map((s) => s.trim())),
);

const OUTDIR = write
  ? path.join(ROOT, 'public/models', SUBDIR)
  : path.join(ROOT, '.model-orig/props', SUBDIR);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const QUIET = new Logger(Logger.Verbosity.ERROR);

// --- little bits ------------------------------------------------------------

const COMPS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

const triCount = (prim) => {
  const idx = prim.getIndices();
  return Math.round((idx ? idx.getCount() : prim.getAttribute('POSITION').getCount()) / 3);
};

const bboxOf = (prim) => {
  const pos = prim.getAttribute('POSITION');
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const e = [0, 0, 0];
  for (let i = 0; i < pos.getCount(); i++) {
    pos.getElement(i, e);
    for (let k = 0; k < 3; k++) {
      if (e[k] < b[k]) b[k] = e[k];
      if (e[k] > b[k + 3]) b[k + 3] = e[k];
    }
  }
  return b;
};

/** RGBA8 plus the mip chain — the arithmetic tools/texture-audit.mjs uses. */
const vramOf = (w, h) => (w * h * 4 * 4) / 3;

// Column-major 4x4, matching the mat4 layout gltf-transform passes around.
function mul(a, b) {
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

/**
 * The node's world matrix — the product of every matrix above it.
 *
 * Sketchfab exports routinely stack three of these: a Y-up fix, a centimetre
 * scale, and the source DCC's own axis swap. The numbers only mean anything
 * multiplied out, which is also why every size this tool prints is measured
 * AFTER the bake and never off the raw accessor.
 */
function worldMatrix(node) {
  let m = node.getMatrix();
  let p = node.getParentNode?.() ?? null;
  while (p) {
    m = mul(p.getMatrix(), m);
    p = p.getParentNode?.() ?? null;
  }
  return m;
}

// --- the texture work -------------------------------------------------------

/** Every texture slot on a material, as {name, get, set} triples. */
function slotsOf(mat) {
  const defs = [
    ['baseColor', 'BaseColorTexture'],
    ['normal', 'NormalTexture'],
    ['metallicRoughness', 'MetallicRoughnessTexture'],
    ['emissive', 'EmissiveTexture'],
    ['occlusion', 'OcclusionTexture'],
  ];
  const out = [];
  for (const [name, suffix] of defs) {
    const tex = mat[`get${suffix}`]?.();
    if (tex) out.push({ name, tex, set: (t) => mat[`set${suffix}`](t) });
  }
  return out;
}

/**
 * The UV box this primitive actually uses, in normalised coordinates.
 *
 * glTF puts the UV origin at the TOP-LEFT, which is also sharp's origin, so v
 * maps straight to y with no flip. (flipY is a three.js render-time thing and
 * does not survive an export — see the note in tools/split-seabed.mjs.)
 */
function uvBox(prim) {
  const uv = prim.getAttribute('TEXCOORD_0');
  if (!uv) return null;
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const e = [0, 0];
  for (let i = 0; i < uv.getCount(); i++) {
    uv.getElement(i, e);
    b[0] = Math.min(b[0], e[0]); b[1] = Math.min(b[1], e[1]);
    b[2] = Math.max(b[2], e[0]); b[3] = Math.max(b[3], e[1]);
  }
  return b;
}

/**
 * Crop EVERY map on the material to this primitive's UV box, then remap the
 * UVs ONCE.
 *
 * The single remap is the whole point of doing this in one function rather than
 * per slot. Base, normal and MR all read TEXCOORD_0; remapping inside a per-map
 * loop applies the transform once per map, and the second pass reads UVs that
 * are already in crop space. The result is a model textured with one corner of
 * its own map, which looks like a broken export rather than like a bug in the
 * tool that made it.
 *
 * The crop box is in NORMALISED coordinates so that maps of different sizes all
 * cut the same region — a 1024-square base map and a 512-square normal map
 * crop to the same part of the surface, at their own resolutions.
 */
async function cropAllMaps(prim, mat, notes) {
  const box = uvBox(prim);
  if (!box) return null;

  for (const name of DROP_SLOTS) {
    const s = slotsOf(mat).find((x) => x.name === name);
    if (s) { s.set(null); notes.push(`dropped the ${name} map`); }
  }
  const slots = slotsOf(mat);
  if (!slots.length) return null;

  // THE CROP RECT IS DECIDED ONCE, IN NORMALISED COORDINATES, before any map is
  // touched — because it is also the UV remap, and the UVs are shared. The pad
  // is a count of TEXELS and so needs a resolution to mean anything; the
  // largest map supplies it, and the sub-texel disagreement that leaves on a
  // smaller map is smaller than the bilinear kernel that reads it.
  const refW = Math.max(...slots.map((s) => s.tex.getSize()[0]));
  const refH = Math.max(...slots.map((s) => s.tex.getSize()[1]));
  const u0 = Math.max(0, Math.floor(box[0] * refW) - PAD) / refW;
  const v0 = Math.max(0, Math.floor(box[1] * refH) - PAD) / refH;
  const u1 = Math.min(refW, Math.ceil(box[2] * refW) + PAD) / refW;
  const v1 = Math.min(refH, Math.ceil(box[3] * refH) + PAD) / refH;
  const du = Math.max(1e-6, u1 - u0);
  const dv = Math.max(1e-6, v1 - v0);

  let before = 0; let after = 0;
  let reported = null;

  for (const slot of slots) {
    const [W, H] = slot.tex.getSize();
    before += vramOf(W, H);

    const left = Math.round(u0 * W);
    const top = Math.round(v0 * H);
    const cw = Math.max(1, Math.min(W - left, Math.round(du * W)));
    const ch = Math.max(1, Math.min(H - top, Math.round(dv * H)));

    const pot = (n) => Math.min(MAXTEX, 2 ** Math.ceil(Math.log2(Math.max(2, n))));
    const tw = pot(cw);
    const th = pot(ch);

    const img = sharp(Buffer.from(slot.tex.getImage()));
    // extract() is skipped when the object uses the whole sheet, so a prop that
    // was never atlased is only resized and re-encoded.
    const whole = cw >= W && ch >= H;
    const cropped = whole ? img : img.extract({ left, top, width: cw, height: ch });
    const out = await cropped
      .resize(tw, th, { fit: 'fill' })
      .webp({ quality: QUALITY, alphaQuality: 100 })
      .toBuffer();
    slot.tex.setImage(out).setMimeType('image/webp');
    after += vramOf(tw, th);
    if (!reported) reported = { before: [W, H], after: [tw, th], whole };
  }

  // ONE remap, after every slot has been cut to the same normalised rect. The
  // resize to a power of two does not enter into it — only the crop does.
  const uv = prim.getAttribute('TEXCOORD_0');
  const e = [0, 0];
  for (let i = 0; i < uv.getCount(); i++) {
    uv.getElement(i, e);
    uv.setElement(i, [(e[0] - u0) / du, (e[1] - v0) / dv]);
  }

  const n = slots.length;
  notes.push(`${n} map${n > 1 ? 's' : ''} ${reported.before.join('x')} -> ${reported.after.join('x')}`
    + (reported.whole ? ' (whole sheet, resized only)' : ` (cropped to ${(du * 100).toFixed(0)}x${(dv * 100).toFixed(0)}% of the atlas)`));
  return { before, after };
}

// --- the inscription plate --------------------------------------------------

/**
 * The flat faces on the object, largest first — somewhere to hang a text quad.
 *
 * Triangles are clustered by normal and the clusters weighted by AREA, not by
 * count. Area is what matters and count is actively misleading here: a
 * gravestone's carved border is dozens of little triangles all facing the same
 * way as the panel they surround, while the panel itself is two big ones.
 *
 * CLUSTERING IS A GREEDY MERGE, NOT A QUANTISED GRID, and that is a fix rather
 * than a preference. A grid puts a fixed lattice over the sphere of directions
 * and a face whose normal lands near a cell boundary is split across two cells
 * — which is exactly what an arched headstone does, because its front is very
 * slightly off-axis. The first version of this reported that stone's face as a
 * 28-unit band on a 94-unit stone, and the number is plausible enough to use.
 * Merging against the running mean instead means a face is one cluster whatever
 * angle it happens to sit at.
 *
 * FACES POINTING DOWN ARE DROPPED. The largest flat face on almost any prop
 * that stands on the ground is the underside it stands on, and it is never
 * where an inscription goes.
 *
 * A cluster is COPLANAR, not CONNECTED: two separate faces on the same plane
 * merge into one. Nothing in this pack has a pair, and the extents would read
 * as one implausibly wide face if it did — but it is the assumption to check
 * first if a plate ever comes out too big.
 *
 * Returns the outward normal, the centre and the in-plane extents, all in the
 * object's own units — the same ones `fit` is expressed in, so a caller can
 * scale a quad to it directly.
 */
function measureFaces(prim, top = 3) {
  const pos = prim.getAttribute('POSITION');
  const idx = prim.getIndices();
  const n = idx ? idx.getCount() : pos.getCount();
  const get = (i) => {
    const e = [0, 0, 0];
    pos.getElement(idx ? idx.getScalar(i) : i, e);
    return e;
  };

  const COS = Math.cos(15 * Math.PI / 180);
  const clusters = [];
  for (let i = 0; i < n; i += 3) {
    const a = get(i); const b = get(i + 1); const c = get(i + 2);
    const ux = b[0] - a[0]; const uy = b[1] - a[1]; const uz = b[2] - a[2];
    const vx = c[0] - a[0]; const vy = c[1] - a[1]; const vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    const area = len / 2;
    const un = [nx / len, ny / len, nz / len];

    let hit = null;
    for (const cl of clusters) {
      if (un[0] * cl.nrm[0] + un[1] * cl.nrm[1] + un[2] * cl.nrm[2] >= COS) { hit = cl; break; }
    }
    if (!hit) {
      hit = { area: 0, sum: [0, 0, 0], nrm: un.slice(), tris: [] };
      clusters.push(hit);
    }
    hit.area += area;
    hit.sum[0] += un[0] * area; hit.sum[1] += un[1] * area; hit.sum[2] += un[2] * area;
    const sl = Math.hypot(...hit.sum);
    hit.nrm = hit.sum.map((v) => v / sl);
    hit.tris.push(a, b, c);
  }

  const faces = [];
  for (const cl of clusters.sort((x, y) => y.area - x.area)) {
    if (cl.nrm[1] < -0.5) continue;  // the underside it stands on
    const nrm = cl.nrm;

    // An orthonormal frame in the face's plane. The seed axis is whichever world
    // axis the normal is LEAST aligned with, so the cross product never collapses.
    const seed = Math.abs(nrm[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const t = [
      seed[1] * nrm[2] - seed[2] * nrm[1],
      seed[2] * nrm[0] - seed[0] * nrm[2],
      seed[0] * nrm[1] - seed[1] * nrm[0],
    ];
    const tl = Math.hypot(...t);
    const T = t.map((v) => v / tl);
    const B = [
      nrm[1] * T[2] - nrm[2] * T[1],
      nrm[2] * T[0] - nrm[0] * T[2],
      nrm[0] * T[1] - nrm[1] * T[0],
    ];

    let uMin = Infinity; let uMax = -Infinity; let vMin = Infinity; let vMax = -Infinity;
    let d = 0;
    for (const p of cl.tris) {
      const u = p[0] * T[0] + p[1] * T[1] + p[2] * T[2];
      const v = p[0] * B[0] + p[1] * B[1] + p[2] * B[2];
      uMin = Math.min(uMin, u); uMax = Math.max(uMax, u);
      vMin = Math.min(vMin, v); vMax = Math.max(vMax, v);
      d += p[0] * nrm[0] + p[1] * nrm[1] + p[2] * nrm[2];
    }
    // The centre is put back ON the plane rather than left at the centroid of
    // the triangle soup — a face with more geometry along one edge has a
    // centroid that is not in the middle of it, and a plate hung there sits
    // off-centre.
    const midU = (uMin + uMax) / 2;
    const midV = (vMin + vMax) / 2;
    const plane = d / cl.tris.length;
    faces.push({
      normal: nrm,
      centre: [
        T[0] * midU + B[0] * midV + nrm[0] * plane,
        T[1] * midU + B[1] * midV + nrm[1] * plane,
        T[2] * midU + B[2] * midV + nrm[2] * plane,
      ],
      width: uMax - uMin,
      height: vMax - vMin,
      area: cl.area,
    });
    if (faces.length >= top) break;
  }
  return faces;
}

// --- read -------------------------------------------------------------------

if (!fs.existsSync(SRC)) {
  console.error(`\nno such file: ${SRC}\n`);
  process.exit(1);
}
await MeshoptSimplifier.ready;

const doc = await io.read(SRC);
const root = doc.getRoot();
const srcBytes = fs.statSync(SRC).size;

// Mesh nodes, with the node chain resolved. A pack may reference one mesh from
// several nodes; each REFERENCE is its own placement and gets its own entry, so
// a pack that ships the same stone twice at two sizes yields two props.
const placements = [];
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  for (const prim of mesh.listPrimitives()) {
    placements.push({ node, mesh, prim, M: worldMatrix(node), name: mesh.getName() || node.getName() || 'mesh' });
  }
}

let srcTris = 0;
for (const p of placements) srcTris += triCount(p.prim);

console.log(`\n${path.basename(SRC)} — ${placements.length} mesh placement(s), `
  + `${srcTris.toLocaleString()} triangles, ${(srcBytes / 1024 / 1024).toFixed(2)}MB`);

// --- what to build ----------------------------------------------------------

const kept = placements.filter((p) => {
  const short = p.name.replace(/_.*$/, '');
  return !dropMeshes.has(p.name) && !dropMeshes.has(short);
});
const dropped = placements.filter((p) => !kept.includes(p));
if (dropped.length) {
  console.log(`  dropped: ${dropped.map((p) => p.name).join(', ')}`);
}
if (!kept.length) { console.error('\nnothing left to build\n'); process.exit(1); }

const jobs = split
  ? kept.map((p) => {
    const short = p.name.replace(/_.*$/, '');
    return { id: renames.get(p.name) ?? renames.get(short) ?? short.toLowerCase(), parts: [p] };
  })
  : [{ id: ID, parts: kept }];

// --- build ------------------------------------------------------------------

const results = [];
for (const job of jobs) {
  const notes = [];
  const out = new Document().setLogger(QUIET);
  const scene = out.createScene('scene');

  // One primitive per job. Every pack handled so far is one primitive per
  // object; a job that gathers several is merged only in the sense that each
  // becomes its own node, which keeps materials separate.
  const prims = [];
  for (const part of job.parts) {
    const map = copyToDocument(out, doc, [part.mesh]);
    const mesh = map.get(part.mesh);
    mesh.setName(job.id);
    scene.addChild(out.createNode(job.id).setMesh(mesh));
    for (const prim of mesh.listPrimitives()) {
      // Bake the node chain into the vertices and drop it, so the file's own
      // units are the ones every measurement below reports.
      transformPrimitive(prim, part.M);
      prims.push(prim);
    }
  }

  // Seat or centre. `--seat` is for a prop that stands on the seabed: base at
  // y=0, centred on x/z. Everything else is centred on its own bounding box,
  // which is what a projectile needs — an unrecentred barrel rotates about a
  // point outside itself and flies with its art offset from its hitbox.
  {
    let b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const prim of prims) {
      const pb = bboxOf(prim);
      for (let k = 0; k < 3; k++) {
        b[k] = Math.min(b[k], pb[k]);
        b[k + 3] = Math.max(b[k + 3], pb[k + 3]);
      }
    }
    const dx = -(b[0] + b[3]) / 2;
    const dy = seat ? -b[1] : -(b[1] + b[4]) / 2;
    const dz = -(b[2] + b[5]) / 2;
    for (const prim of prims) {
      const pos = prim.getAttribute('POSITION');
      const e = [0, 0, 0];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, e);
        pos.setElement(i, [e[0] + dx, e[1] + dy, e[2] + dz]);
      }
    }
  }

  const preTris = prims.reduce((s, p) => s + triCount(p), 0);
  let box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const prim of prims) {
    const pb = bboxOf(prim);
    for (let k = 0; k < 3; k++) {
      box[k] = Math.min(box[k], pb[k]);
      box[k + 3] = Math.max(box[k + 3], pb[k + 3]);
    }
  }
  const size = [box[3] - box[0], box[4] - box[1], box[5] - box[2]];
  const longest = Math.max(...size);

  // Textures, per material. Done before any decimation so the UV box is the
  // one the modelled surface uses.
  let vramBefore = 0; let vramAfter = 0;
  for (const prim of prims) {
    const mat = prim.getMaterial();
    if (!mat) continue;
    const r = await cropAllMaps(prim, mat, notes);
    if (r) { vramBefore += r.before; vramAfter += r.after; }
  }

  // Optional decimation. Off by default — see the header for why geometry is
  // not the cost in these packs.
  if (SIMPLIFY > 0 && SIMPLIFY < 1) {
    for (const prim of prims) {
      simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio: SIMPLIFY, error: 0.01 });
    }
    notes.push(`simplified ${preTris} -> ${prims.reduce((s, p) => s + triCount(p), 0)} triangles`);
  }

  const faces = plate ? measureFaces(prims[0]) : null;

  await out.transform(dedup(), prune());
  const buffer = await io.writeBinary(out);

  results.push({
    id: job.id,
    preTris,
    postTris: prims.reduce((s, p) => s + triCount(p), 0),
    size,
    longest,
    box,
    vramBefore,
    vramAfter,
    bytes: buffer.byteLength,
    notes,
    faces,
    buffer,
  });
}

// --- report -----------------------------------------------------------------

console.log(`\n  id                 tris     size (baked, x/y/z)          file      VRAM`);
let totBytes = 0; let vramB = 0; let vramA = 0;
for (const r of results) {
  totBytes += r.bytes; vramB += r.vramBefore; vramA += r.vramAfter;
  console.log(`  ${r.id.padEnd(16)} ${String(r.postTris).padStart(6)}   `
    + `${r.size.map((v) => v.toFixed(3).padStart(8)).join(' ')}   `
    + `${(r.bytes / 1024).toFixed(0).padStart(5)}KB   `
    + `${(r.vramBefore / 1024 / 1024).toFixed(2)} -> ${(r.vramAfter / 1024 / 1024).toFixed(2)}MB`);
}

if (results.some((r) => r.notes.length)) {
  console.log('\n  notes:');
  for (const r of results) if (r.notes.length) console.log(`    ${r.id.padEnd(16)} ${r.notes.join('; ')}`);
}

if (plate) {
  // Candidates rather than an answer: the biggest upward-or-outward face is the
  // right one on a plain headstone and the wrong one on anything with a broad
  // top, so the pick is a look call. Undersides are already excluded.
  console.log('\n  --- flat faces, largest first (object units, same as `fit`) ---');
  console.log('  id                 normal (x,y,z)             centre (x,y,z)              w x h');
  for (const r of results) {
    if (!r.faces?.length) { console.log(`  ${r.id.padEnd(16)}  no flat face found`); continue; }
    r.faces.forEach((f, i) => {
      console.log(`  ${(i === 0 ? r.id : '').padEnd(16)} ${i === 0 ? '*' : ' '} `
        + `${f.normal.map((v) => v.toFixed(2).padStart(6)).join(',')}   `
        + `${f.centre.map((v) => v.toFixed(2).padStart(8)).join(',')}   `
        + `${f.width.toFixed(1).padStart(6)} x ${f.height.toFixed(1)}`);
    });
  }
}

console.log(`\n  ${srcTris.toLocaleString()} triangles  ->  ${results.reduce((s, r) => s + r.postTris, 0).toLocaleString()} across ${results.length} file(s)`);
console.log(`  ${(srcBytes / 1024 / 1024).toFixed(2)}MB  ->  ${(totBytes / 1024 / 1024).toFixed(2)}MB on disk`);
console.log(`  ${(vramB / 1024 / 1024).toFixed(1)}MB  ->  ${(vramA / 1024 / 1024).toFixed(2)}MB of texture VRAM`);

// --- write ------------------------------------------------------------------

fs.mkdirSync(OUTDIR, { recursive: true });
for (const r of results) fs.writeFileSync(path.join(OUTDIR, `${r.id}.glb`), r.buffer);

if (write) {
  console.log(`\nWrote ${results.length} file(s) to ${path.relative(ROOT, OUTDIR)}/\n`);
} else {
  console.log(`\nNothing written to public/. Previews in ${path.relative(ROOT, OUTDIR)}/ (gitignored, outside the build).`);
  console.log('Look at them, then re-run with --write.\n');
}
