#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SIX LABELLED VIEWS OF A GLB, WITH NO GL AND NO SERVER.
//
//   npm run acc:render                       # every accessory in public/models
//   npm run acc:render -- path/to/one.glb    # or named files
//   npm run acc:render -- --before           # the Sketchfab sources instead
//
// tools/optimize-accessories.mjs ends by saying it will not judge its own
// result and that you should render the before and after and look at it. There
// was nothing to do that with. The accessory lab is a browser page and a whole
// GL context; a decimation only needs a silhouette, and a silhouette is a
// rasteriser.
//
// WHY IT EXISTS AS WELL AS THE LAB. Two questions this answers that a picture
// of the seal cannot:
//
//   1. WHICH WAY DOES IT FACE. `forward` and `up` in an ASSETS entry are the
//      difference between a hat and a hat on its side, and they cannot be
//      derived — a brim is nearly symmetric and the tell is small (the
//      bowler's goggles, the tricorn's point, a shark's jaw). The six panels
//      are labelled with the axis each is looking down, so the answer is read
//      off rather than guessed and then discovered on the seal.
//
//   2. DID THE DECIMATION SURVIVE. Rendered from the same six angles before
//      and after, a lost tooth or a collapsed tentacle is obvious. This is how
//      the second batch was checked.
//
// IT RENDERS GEOMETRY, NOT THE LOOK. Flat grey, one hard light, no textures and
// no materials — every colour, glow, rim and blend belongs to the shader lab
// and to the game. Reading a colour off these images would be reading it off
// the wrong thing.
//
// SKINNING IS EVALUATED, at rest, by linear blend. A posed skinned source (both
// jellyfish) is nowhere near its stored vertex positions, and a renderer that
// ignored the skin would show a shape that does not exist and quietly disagree
// with what the optimizer bakes.
// ---------------------------------------------------------------------------

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

// One panel per view. Big enough to read a tooth; the game draws these at 65.
const S = 260;

// The label is the axis the CAMERA looks down, so "-Z (front)" is the view you
// get standing out at +Z looking back — which is exactly what `forward: '+Z'`
// means in an ASSETS entry.
const VIEWS = [
  { label: '-Z (front)', h: 0, v: 1, d: 2, hs: 1, vs: 1, ds: 1 },
  { label: '+Z (back)', h: 0, v: 1, d: 2, hs: -1, vs: 1, ds: -1 },
  { label: '-X (left)', h: 2, v: 1, d: 0, hs: -1, vs: 1, ds: 1 },
  { label: '+X (right)', h: 2, v: 1, d: 0, hs: 1, vs: 1, ds: -1 },
  { label: '-Y (below)', h: 0, v: 2, d: 1, hs: 1, vs: 1, ds: -1 },
  { label: '+Y (above)', h: 0, v: 2, d: 1, hs: 1, vs: -1, ds: 1 },
];

const mulPoint = (m, v) => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
];

// The skinning matrix of every joint at rest: joint world x inverse bind. The
// same product tools/optimize-accessories.mjs bakes with, on purpose — if these
// two ever disagree, the picture stops describing the file.
function skinMatrices(skin) {
  const ibm = skin.getInverseBindMatrices();
  return skin.listJoints().map((j, i) => {
    const b = [];
    ibm.getElement(i, b);
    const jw = j.getWorldMatrix();
    const m = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += jw[k * 4 + r] * b[c * 4 + k];
        m[c * 4 + r] = s;
      }
    }
    return m;
  });
}

/** Every triangle in the file, in scene space, skin evaluated. */
function triangles(doc) {
  const out = [];
  doc.getRoot().listScenes()[0].traverse((node) => {
    const mesh = node.getMesh();
    if (!mesh) return;
    const skin = node.getSkin();
    // A skinned node's own transform is ignored by glTF — the joints carry the
    // whole chain. Using both is the double-transform that put a jellyfish
    // upside down; see the note in optimize-accessories.mjs.
    const mats = skin ? skinMatrices(skin) : null;
    const wm = skin ? null : node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const J = prim.getAttribute('JOINTS_0');
      const W = prim.getAttribute('WEIGHTS_0');
      const idx = prim.getIndices();
      const P = new Array(pos.getCount());
      const v = [0, 0, 0];
      const ja = [0, 0, 0, 0];
      const wa = [0, 0, 0, 0];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, v);
        if (mats && J && W) {
          J.getElement(i, ja);
          W.getElement(i, wa);
          const o = [0, 0, 0];
          let total = 0;
          for (let k = 0; k < 4; k++) if (wa[k] > 0) total += wa[k];
          if (!(total > 0)) { P[i] = [...v]; continue; }
          for (let k = 0; k < 4; k++) {
            if (!(wa[k] > 0)) continue;
            const p = mulPoint(mats[ja[k]], v);
            const w = wa[k] / total;
            o[0] += p[0] * w; o[1] += p[1] * w; o[2] += p[2] * w;
          }
          P[i] = o;
        } else P[i] = mulPoint(wm, v);
      }
      const n = idx ? idx.getCount() : pos.getCount();
      for (let i = 0; i < n; i += 3) {
        const a = P[idx ? idx.getScalar(i) : i];
        const b = P[idx ? idx.getScalar(i + 1) : i + 1];
        const c = P[idx ? idx.getScalar(i + 2) : i + 2];
        if (a && b && c) out.push([a, b, c]);
      }
    }
  });
  return out;
}

/**
 * One panel. Orthographic, z-buffered, flat-shaded off the FACE normal.
 *
 * Every panel is framed on the model's LONGEST axis rather than on its own two,
 * so the six are at one scale and a view along a short axis reads as short —
 * which is most of what tells a hat from a hat on its side.
 */
function panel(tris, view, box) {
  const { h, v, d, hs, vs, ds } = view;
  const span = Math.max(...box.size) || 1;
  const pad = S * 0.09;
  const sc = (S - 2 * pad) / span;
  const px = new Uint8Array(S * S * 3).fill(17);
  const zb = new Float32Array(S * S).fill(-Infinity);
  // A light off the camera's shoulder: straight-on would flatten every curve to
  // one value and the silhouette would be all there is to read.
  const L = [0.35, 0.62, 0.70];
  const ll = Math.hypot(...L);

  for (const t of tris) {
    const s = t.map((p) => [
      S / 2 + (p[h] - box.centre[h]) * sc * hs,
      S / 2 - (p[v] - box.centre[v]) * sc * vs,
    ]);
    const u = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]];
    const w = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]];
    const nrm = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const nl = Math.hypot(...nrm) || 1;
    // Absolute, because these files are not reliably wound and a back face
    // rendering black would read as a hole in the model.
    const lam = Math.abs((nrm[0] * L[0] + nrm[1] * L[1] + nrm[2] * L[2]) / (nl * ll));
    const shade = Math.round(46 + 196 * Math.pow(lam, 0.8));
    const z = ((t[0][d] + t[1][d] + t[2][d]) / 3) * ds;

    const x0 = Math.max(0, Math.floor(Math.min(s[0][0], s[1][0], s[2][0])));
    const x1 = Math.min(S - 1, Math.ceil(Math.max(s[0][0], s[1][0], s[2][0])));
    const y0 = Math.max(0, Math.floor(Math.min(s[0][1], s[1][1], s[2][1])));
    const y1 = Math.min(S - 1, Math.ceil(Math.max(s[0][1], s[1][1], s[2][1])));
    const area = (s[1][0] - s[0][0]) * (s[2][1] - s[0][1]) - (s[2][0] - s[0][0]) * (s[1][1] - s[0][1]);
    if (Math.abs(area) < 1e-9) continue;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const w0 = ((s[1][0] - x) * (s[2][1] - y) - (s[2][0] - x) * (s[1][1] - y)) / area;
        const w1 = ((s[2][0] - x) * (s[0][1] - y) - (s[0][0] - x) * (s[2][1] - y)) / area;
        if (w0 < 0 || w1 < 0 || 1 - w0 - w1 < 0) continue;
        const i = y * S + x;
        if (z <= zb[i]) continue;
        zb[i] = z;
        px[i * 3] = shade; px[i * 3 + 1] = shade; px[i * 3 + 2] = Math.min(255, shade + 10);
      }
    }
  }
  return px;
}

function bounds(tris) {
  const lo = [1e9, 1e9, 1e9];
  const hi = [-1e9, -1e9, -1e9];
  for (const t of tris) for (const p of t) for (let k = 0; k < 3; k++) {
    if (p[k] < lo[k]) lo[k] = p[k];
    if (p[k] > hi[k]) hi[k] = p[k];
  }
  const centre = [0, 1, 2].map((k) => (hi[k] + lo[k]) / 2);
  // THE FURTHEST VERTEX, not half the box diagonal. `outline.thickness` in
  // assets.js is 0.012 x this, and the half-diagonal overstates it by 10-25%
  // on every one of these shapes — a hat is a dome, not a cube, so no vertex
  // is anywhere near the corner the diagonal measures to. Reproduces the eight
  // radii already tabulated in assets.js to three decimals; the diagonal did
  // not, which is how the difference was noticed.
  let r2 = 0;
  for (const t of tris) for (const p of t) {
    const d = (p[0] - centre[0]) ** 2 + (p[1] - centre[1]) ** 2 + (p[2] - centre[2]) ** 2;
    if (d > r2) r2 = d;
  }
  return { size: [0, 1, 2].map((k) => hi[k] - lo[k]), centre, radius: Math.sqrt(r2) };
}

const label = (text, w) => Buffer.from(
  `<svg width="${w}" height="22"><text x="6" y="16" font-family="monospace" font-size="13" fill="#8a8f98">${text}</text></svg>`,
);

const argv = process.argv.slice(2);
const before = argv.includes('--before');
const files = argv.filter((a) => !a.startsWith('--'));
const outDir = path.join(ROOT, before ? 'dist-accessory-shots/before' : 'dist-accessory-shots');
fs.mkdirSync(outDir, { recursive: true });

let list = files;
if (!list.length) {
  const dir = before
    ? path.join(os.homedir(), 'Documents/_DesignSystems/SealSurvivor')
    : path.join(ROOT, 'public/models');
  const names = before
    ? ['hard_hat.glb', 'hat.glb', 'wizards_hat.glb', 'gawr_gura_shark_hat.glb',
       'jellyfish.glb']
    // The wardrobe, and only the wardrobe. jellyfish.glb came in on the same
    // batch and is a CREATURE, so it is not listed — pass it by name when you
    // want to look at it. Nothing here refuses a path; the list is only what
    // a bare `npm run acc:render` draws.
    : ['hardhat.glb', 'cowboyhat.glb', 'wizardhat.glb', 'sharkhood.glb',
       'bowlerhat.glb', 'tricornhat.glb', 'fedorahat.glb', 'roundglasses.glb',
       'aviatorglasses.glb', 'wireglasses.glb'];
  list = names.map((n) => path.join(dir, n)).filter((p) => fs.existsSync(p));
}

for (const file of list) {
  const doc = await io.read(file);
  const tris = triangles(doc);
  if (!tris.length) { console.error(`${path.basename(file)}: no geometry`); continue; }
  const box = bounds(tris);
  const panels = VIEWS.map((v) => panel(tris, v, box));

  const W = S * 6;
  const strip = new Uint8Array(W * S * 3);
  for (let i = 0; i < 6; i++) {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const src = (y * S + x) * 3;
        const dst = (y * W + i * S + x) * 3;
        strip[dst] = panels[i][src];
        strip[dst + 1] = panels[i][src + 1];
        strip[dst + 2] = panels[i][src + 2];
      }
    }
  }
  const name = path.basename(file, '.glb');
  // The bounding-SPHERE radius, which is what an ASSETS `outline.thickness` is
  // derived from — 0.012 x this. See the rim note in assets.js for why that
  // number cannot be copied between two files.
  const radius = box.radius;
  const caption = `${name}   ${tris.length} tris   bbox ${box.size.map((s) => +s.toFixed(3)).join(' x ')}   `
    + `sphere r ${radius.toFixed(3)}   outline 0.012r = ${(radius * 0.012).toFixed(5)}`;
  const out = path.join(outDir, `${name}.png`);
  await sharp(Buffer.from(strip), { raw: { width: W, height: S, channels: 3 } })
    .extend({ top: 22, bottom: 22, background: { r: 17, g: 17, b: 17 } })
    .composite([
      ...VIEWS.map((v, i) => ({ input: label(v.label, S), top: 0, left: i * S })),
      { input: label(caption, W), top: S + 22, left: 0 },
    ])
    .png().toFile(out);
  console.log(`${path.relative(ROOT, out)}  ${caption}`);
}
