#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:guest
//
// Checks that tools/optimize-guest.mjs took 81MB of VRAM and 10 draw calls off
// the yacht's business guest WITHOUT taking anything off the man himself.
//
// It compares the optimized model against the original in .model-orig/ when
// that is present (right after a conversion, which is when the answer matters)
// and falls back to checking the shipped model's invariants alone once the
// backup has been deleted.
//
// The four things that can go wrong here all fail SILENTLY — which is the only
// reason this file exists:
//
//   THE MERGE DROPS VERTICES. Concatenating five attribute streams across
//     thirteen primitives is index arithmetic, and an off-by-one leaves a hole
//     that renders as a few missing triangles on a 15px model. Nothing throws.
//     So the triangle and vertex totals are compared against the original.
//
//   THE SKIN COMES UNDONE. glTF prune() removes nodes nothing references, and
//     the thirteen mesh nodes it is meant to collect sit in the same graph as
//     the 55 joints it must not. A skeleton that loses joints does not error —
//     the vertices bound to them collapse to the origin, and a background prop
//     that has folded into a spike at the deck's centre is exactly the kind of
//     thing nobody looks at. Joint count and joint NAMES are both compared, and
//     the mesh is posed to prove the weights still drive it.
//
//   THE ATLAS TILES SWAP. Remapping UVs into a 4x4 grid is two integers per
//     material, and getting them the wrong way round puts the suit texture on
//     the head. The result is a plausible-looking man in the wrong colours, so
//     every tile is sampled and compared to the original map's mean colour.
//
//   THE MR FACTORS ARE FORGOTTEN. Every material in the source ships
//     metallic=1.0 roughness=1.0 and leans on a map for the real values.
//     Dropping the map without averaging it back leaves thirteen mirrors, and
//     a mirror in this renderer looks like a lighting bug rather than a
//     conversion bug.
// ---------------------------------------------------------------------------

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = path.join(ROOT, 'public/models/businessguest.glb');
const BACKUP = path.join(ROOT, '.model-orig/businessguest.glb');
const PREVIEW = path.join(ROOT, '.model-orig/businessguest.optimized.glb');

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

// The optimized model is the shipped one once --write has run, and the preview
// beforehand. Preferring the preview means this can be run before committing to
// the swap, which is the point at which it is worth running.
const optPath = fs.existsSync(PREVIEW) ? PREVIEW : MODEL;
const opt = await io.read(optPath);
const optRoot = opt.getRoot();
const orig = fs.existsSync(BACKUP) ? await io.read(BACKUP) : null;

console.log(`\noptimized: ${path.relative(ROOT, optPath)}`);
console.log(orig ? `original:  ${path.relative(ROOT, BACKUP)}` : 'original:  not on disk — invariant checks only');

const census = (doc) => {
  const r = doc.getRoot();
  let tris = 0; let verts = 0; let prims = 0;
  for (const mesh of r.listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      prims++;
      const pos = p.getAttribute('POSITION');
      const idx = p.getIndices();
      tris += idx ? idx.getCount() / 3 : pos.getCount() / 3;
      verts += pos.getCount();
    }
  }
  let vram = 0;
  for (const t of r.listTextures()) { const [w, h] = t.getSize(); vram += (w * h * 4 * 4) / 3; }
  return { tris, verts, prims, vram, maps: r.listTextures().length, mats: r.listMaterials().length };
};

const o = census(opt);
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)}MB`;

// ===========================================================================
section('The man survived the merge');

// The budget is not a round number. It is the BALLROOM guest — 9,128 triangles,
// standing on the same deck at the same `fit`, which makes it the one figure
// this exact shot has already proved is enough.
const BALLROOM_TRIS = 9128;

if (orig) {
  const b = census(orig);
  check('decimated under the ballroom guest beside him',
    o.tris < BALLROOM_TRIS, `${b.tris} -> ${o.tris} tris, against his neighbour's ${BALLROOM_TRIS}`);
  check('and the vertex count came down with it', o.verts < b.verts / 2,
    `${b.verts} -> ${o.verts} verts`);
  check('drawn in far fewer pieces', o.prims < b.prims, `${b.prims} primitives -> ${o.prims}`);
  check('VRAM is an order of magnitude down',
    o.vram < b.vram / 10, `${mb(b.vram)} -> ${mb(o.vram)} (${(b.vram / o.vram).toFixed(0)}x)`);
} else {
  check('the geometry is inside the ballroom guest\'s budget', o.tris < BALLROOM_TRIS,
    `${Math.round(o.tris)} tris, ${o.verts} verts`);
  check('drawn in 3 pieces or fewer', o.prims <= 3, `${o.prims} primitives`);
  check('and holds under 2MB of VRAM', o.vram < 2 * 1024 * 1024, mb(o.vram));
}
check('one texture does the whole man', o.maps === 1, `${o.maps} map(s)`);
check('one material per alpha mode, no more', o.mats <= 3, `${o.mats} material(s)`);

// THE SILHOUETTE, which is the only thing a decimation can take that matters
// at this size — and the one thing the counts above cannot see. A mis-added
// index base in the merge offsets a whole vertex block, and a simplifier told
// to go too far eats the extremities; both leave the totals looking right and
// move the box.
//
// It also covers the `fit` in assets.csv, which is derived from the box: a
// model whose extents moved is a model that spawns at the wrong size.
const boxOf = (doc) => {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const m of doc.getRoot().listMeshes()) {
    for (const p of m.listPrimitives()) {
      const pos = p.getAttribute('POSITION');
      const e = [0, 0, 0];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, e);
        for (let k = 0; k < 3; k++) {
          if (e[k] < b[k]) b[k] = e[k];
          if (e[k] > b[k + 3]) b[k + 3] = e[k];
        }
      }
    }
  }
  return b;
};
const ob = boxOf(opt);
if (orig) {
  const bb = boxOf(orig);
  const drift = Math.max(...ob.map((v, i) => Math.abs(v - bb[i])));
  const tall = bb[4] - bb[1];
  // He is 15 logged-window pixels tall — the figure tools/texture-audit.mjs
  // sizes maps from. A tolerance in model units means nothing to anyone; the
  // question is whether the change is visible, so the budget is a quarter of
  // one pixel at the size he is actually drawn.
  const px = (drift / tall) * 15;
  check('and his silhouette held', px < 0.25,
    `worst extent moved ${(drift / tall * 100).toFixed(2)}% — ${px.toFixed(3)}px at 15px tall, ` +
    `${tall.toFixed(3)} tall -> ${(ob[4] - ob[1]).toFixed(3)}`);
}

// ===========================================================================
section('The skeleton came through');

const skins = optRoot.listSkins();
check('there is exactly one skin', skins.length === 1, `${skins.length}`);
const joints = skins[0]?.listJoints() ?? [];
if (orig) {
  const wasJoints = orig.getRoot().listSkins()[0].listJoints();
  check('with every joint the original had', joints.length === wasJoints.length,
    `${wasJoints.length} -> ${joints.length}`);
  const before = new Set(wasJoints.map((j) => j.getName()));
  const missing = joints.length ? wasJoints.filter((j) => !joints.some((k) => k.getName() === j.getName())) : wasJoints;
  check('and they are the same joints, by name', missing.length === 0,
    missing.length ? `missing ${missing.slice(0, 4).map((j) => j.getName()).join(', ')}` : `${before.size} names matched`);
} else {
  check('with all 55 joints', joints.length === 55, `${joints.length}`);
}

const anims = optRoot.listAnimations();
check('the idle clip is still on the file', anims.length === 1, anims.map((a) => a.getName()).join(',') || 'none');
// A clip whose channels point at joints prune() removed is the failure this
// catches: the animation object survives, its targets do not.
const jointSet = new Set(joints);
const orphan = anims.flatMap((a) => a.listChannels()).filter((c) => {
  const t = c.getTargetNode();
  return !t || (!jointSet.has(t) && !optRoot.listNodes().includes(t));
});
check('and every channel still has a node to drive', orphan.length === 0, `${orphan.length} orphaned`);

// ===========================================================================
section('The weights still drive it');

// The merge concatenates JOINTS_0 and WEIGHTS_0 across thirteen primitives. A
// vertex whose weights were dropped reads as four zeros and pins to the origin,
// which is invisible in every count above.
const mesh = optRoot.listMeshes()[0];
let zeroWeight = 0;
let outOfRange = 0;
let weighted = 0;
for (const p of mesh.listPrimitives()) {
  const w = p.getAttribute('WEIGHTS_0');
  const j = p.getAttribute('JOINTS_0');
  check(`${p.getMaterial().getName()} carries skinning`, !!w && !!j, w && j ? `${w.getCount()} verts` : 'MISSING');
  if (!w || !j) continue;
  const we = [0, 0, 0, 0]; const je = [0, 0, 0, 0];
  for (let i = 0; i < w.getCount(); i++) {
    w.getElement(i, we);
    j.getElement(i, je);
    const sum = we[0] + we[1] + we[2] + we[3];
    if (sum < 0.001) zeroWeight++; else weighted++;
    for (const idx of je) if (idx >= joints.length) outOfRange++;
  }
}
check('no vertex lost its weights', zeroWeight === 0, `${zeroWeight} of ${weighted + zeroWeight} would pin to the origin`);
check('no joint index points past the skeleton', outOfRange === 0,
  `${outOfRange} indices >= ${joints.length}`);

// ===========================================================================
section('The atlas tiles are the right way round');

// Every material's UVs were moved into one cell of a 4x4 grid. Sampling the
// cell and comparing it to the original map's mean colour is what separates
// "atlased" from "atlased with the head and the shoes swapped" — a mistake that
// costs two integers and renders a complete, wrong man.
if (orig) {
  const tex = optRoot.listTextures()[0];
  const [aw, ah] = tex.getSize();
  const { data } = await sharp(Buffer.from(tex.getImage())).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const GRID = 4;
  const cell = aw / GRID;

  // APPLES TO APPLES, and it took a false failure to get here. Comparing the
  // WHOLE original map's mean against the MIDDLE of its tile fails on any map
  // that isn't uniform — the eye texture is a dark iris in a white sclera, so
  // its centre reads nothing like its average, and the check reported a swap
  // that had not happened. So the expected value is built the way the tool
  // builds a tile (resize to the cell, multiply the factor in) and the same
  // middle region is read from both.
  const midMean = (d, w, x0, y0, size) => {
    let r = 0; let g = 0; let b = 0; let n = 0;
    for (let y = size * 0.25; y < size * 0.75; y++) {
      for (let x = size * 0.25; x < size * 0.75; x++) {
        const i = (((y0 + y) | 0) * w + ((x0 + x) | 0)) * 4;
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
      }
    }
    return [r / n, g / n, b / n];
  };

  const expectedMean = async (buf, factor) => {
    const { data: d } = await sharp(buf).resize(cell, cell, { fit: 'fill' }).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    const m = midMean(d, cell, 0, 0, cell);
    return m.map((v, k) => v * factor[k]);
  };

  const cellMean = (col, row) => midMean(data, aw, col * cell, row * cell, cell);

  const origMats = orig.getRoot().listMaterials();
  let placed = 0; let wrong = [];
  for (let i = 0; i < origMats.length; i++) {
    const m = origMats[i];
    const t = m.getBaseColorTexture();
    if (!t) continue;                       // the glasses lens is a factor, nothing to compare
    const f = m.getBaseColorFactor() ?? [1, 1, 1, 1];
    const want = await expectedMean(Buffer.from(t.getImage()), f);
    const got = cellMean(i % GRID, (i / GRID) | 0);
    // Generous: a 128px tile resized from 1024 and re-encoded at q90 moves the
    // mean a little, and the check is looking for a SWAP, which is tens of
    // levels apart, not units.
    const dist = Math.hypot(want[0] - got[0], want[1] - got[1], want[2] - got[2]);
    if (dist < 24) placed++;
    else wrong.push(`${m.getName()} off by ${dist.toFixed(0)}`);
  }
  check('every tile holds its own material\'s colour', wrong.length === 0,
    wrong.length ? wrong.slice(0, 3).join('; ') : `${placed} tiles matched`);
}

// ===========================================================================
section('Every vertex still sits on the colour it had');

// THE END-TO-END CHECK, and the only one here that would catch a V flip inside
// a tile, a half-texel inset applied the wrong way, or a remap formula that
// disagrees with the atlas it was built alongside. Everything above tests the
// pieces; this tests the composition.
//
// For a sample of merged vertices: find the vertex at the same POSITION in the
// original file, sample the original material's map at its original UV, sample
// the atlas at the merged UV, and compare. Matching by position rather than by
// index is deliberate — an index-order assumption would be testing the same
// belief the merge is built on, and would agree with it whether or not it was
// right.
if (orig) {
  const key = (e) => `${e[0].toFixed(5)},${e[1].toFixed(5)},${e[2].toFixed(5)}`;

  // position -> {uv, material}, with anything ambiguous struck out. Two prims
  // sharing a vertex position but not a UV cannot be judged.
  const origAt = new Map();
  const ambiguous = new Set();
  for (const m of orig.getRoot().listMeshes()) {
    for (const p of m.listPrimitives()) {
      const pos = p.getAttribute('POSITION');
      const uv = p.getAttribute('TEXCOORD_0');
      if (!uv) continue;
      const pe = [0, 0, 0]; const ue = [0, 0];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, pe);
        uv.getElement(i, ue);
        const k = key(pe);
        const had = origAt.get(k);
        if (had && (Math.abs(had.uv[0] - ue[0]) > 1e-6 || Math.abs(had.uv[1] - ue[1]) > 1e-6)) {
          ambiguous.add(k);
        }
        origAt.set(k, { uv: [ue[0], ue[1]], mat: p.getMaterial() });
      }
    }
  }

  // Decode every source map once, and the atlas once.
  const raw = new Map();
  const decode = async (tex) => {
    if (!tex) return null;
    if (!raw.has(tex)) {
      const { data: d, info } = await sharp(Buffer.from(tex.getImage())).ensureAlpha().raw()
        .toBuffer({ resolveWithObject: true });
      raw.set(tex, { d, w: info.width, h: info.height });
    }
    return raw.get(tex);
  };
  const atlasTex = optRoot.listTextures()[0];
  const atlas = (await decode(atlasTex));

  // Nearest-texel, clamped. Bilinear would only blur the comparison, and the
  // question is whether the lookup lands in the right PLACE.
  const sample = (img, u, v) => {
    const x = Math.min(img.w - 1, Math.max(0, Math.floor(u * img.w)));
    const y = Math.min(img.h - 1, Math.max(0, Math.floor(v * img.h)));
    const i = (y * img.w + x) * 4;
    return [img.d[i], img.d[i + 1], img.d[i + 2]];
  };

  // PER MATERIAL, and by MEAN, which took a false failure to arrive at. A
  // per-vertex pass rate looks like the strict choice and is the wrong
  // instrument: the tiles are their source maps at an eighth of the resolution,
  // so a texel on a hard edge — a nostril, a lapel seam, a hair strand —
  // legitimately lands somewhere else, and the size of that tail moves with
  // the decimation ratio rather than with anything being wrong.
  //
  // The thing worth failing on is a SYSTEMATIC error: a wrong tile, a flipped
  // V, an inset applied the wrong way. Those do not produce a tail, they move
  // a whole material's mean — to 100+ out of a 441 maximum. Resolution loss
  // keeps every material under 40, hair included. So the gate is the mean and
  // the tail is reported beside it.
  const per = new Map();
  let compared = 0; let matched = 0; let unmatched = 0;
  const worst = [];
  for (const m of optRoot.listMeshes()) {
    for (const p of m.listPrimitives()) {
      const pos = p.getAttribute('POSITION');
      const uv = p.getAttribute('TEXCOORD_0');
      // Every 3rd vertex. The mesh is decimated now, so a wide stride buys
      // nothing and costs the statistics.
      const stride = 3;
      const pe = [0, 0, 0]; const ue = [0, 0];
      for (let i = 0; i < pos.getCount(); i += stride) {
        pos.getElement(i, pe);
        const k = key(pe);
        if (ambiguous.has(k)) continue;
        const was = origAt.get(k);
        if (!was) { unmatched++; continue; }
        const srcImg = await decode(was.mat.getBaseColorTexture());
        if (!srcImg) continue;             // the lens has no map to compare
        const f = was.mat.getBaseColorFactor() ?? [1, 1, 1, 1];
        const want = sample(srcImg, was.uv[0], was.uv[1]).map((c, j) => c * f[j]);
        uv.getElement(i, ue);
        const got = sample(atlas, ue[0], ue[1]);
        const dist = Math.hypot(want[0] - got[0], want[1] - got[1], want[2] - got[2]);
        compared++;
        if (dist < 60) matched++; else worst.push(dist);
        const name = was.mat.getName();
        const r = per.get(name) ?? { n: 0, sum: 0 };
        r.n++; r.sum += dist;
        per.set(name, r);
      }
    }
  }
  worst.sort((a, b) => b - a);
  const means = [...per].map(([name, r]) => ({ name, mean: r.sum / r.n, n: r.n }))
    .sort((a, b) => b.mean - a.mean);
  const offenders = means.filter((m) => m.mean >= 50);
  check('no material samples the wrong part of the atlas',
    offenders.length === 0,
    offenders.length
      ? offenders.map((m) => `${m.name} mean ${m.mean.toFixed(0)}`).join('; ')
      : `worst material is ${means[0].name} at mean ${means[0].mean.toFixed(1)} of 441`);
  check('and most texels come back unchanged', compared && matched / compared > 0.9,
    `${matched}/${compared} sampled vertices within 60` +
    (worst.length ? `, tail at ${worst.slice(0, 3).map((d) => d.toFixed(0)).join('/')}` : ''));
  check('every merged vertex came from a real one', unmatched === 0,
    `${unmatched} had no match in the original`);
}

// ===========================================================================
section('Nothing became a mirror');

// The source ships metallic=1.0 roughness=1.0 on every material and gets the
// real values from a map. Dropping that map without averaging it back is the
// one conversion mistake here that looks like a renderer bug.
const metals = optRoot.listMaterials().map((m) => m.getMetallicFactor());
check('no material is left fully metallic', metals.every((v) => v < 0.5),
  metals.map((v) => v.toFixed(2)).join(', '));
const roughs = optRoot.listMaterials().map((m) => m.getRoughnessFactor());
check('and none is left mirror-smooth', roughs.every((v) => v > 0.05),
  roughs.map((v) => v.toFixed(2)).join(', '));

// ===========================================================================
section('The dead weight is gone');

let tangents = 0; let spareUVs = 0;
for (const m of optRoot.listMeshes()) {
  for (const p of m.listPrimitives()) {
    if (p.getAttribute('TANGENT')) tangents++;
    for (const s of ['TEXCOORD_1', 'TEXCOORD_2', 'TEXCOORD_3', 'TEXCOORD_4']) {
      if (p.getAttribute(s)) spareUVs++;
    }
  }
}
check('no TANGENT survives — nothing reads one without a normal map', tangents === 0, `${tangents}`);
check('and no spare UV set', spareUVs === 0, `${spareUVs}`);
const slots = optRoot.listMaterials().flatMap((m) => [
  m.getNormalTexture() && 'normal', m.getOcclusionTexture() && 'ao',
  m.getMetallicRoughnessTexture() && 'metalRough', m.getEmissiveTexture() && 'emissive',
]).filter(Boolean);
check('base colour is the only map slot in use', slots.length === 0, slots.join(', ') || 'none');

console.log(failures ? `\nFAILED — ${failures} check(s)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
