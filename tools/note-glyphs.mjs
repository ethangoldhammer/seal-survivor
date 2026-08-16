#!/usr/bin/env node
// npm run notes
//
// Pull the music-note GLYPHS out of the Particle Flow bake and write them as
// game assets.
//
// The source (pflow_practice_-_music_spread.glb, 865 KB) is a 3ds Max practice
// scene: a particle source travelling in a straight line, dropping a note every
// few frames for four seconds. 199 baked meshes, 415 nodes, one animation with
// 596 channels. NONE OF THAT MOTION IS USABLE — measured, the cloud is a line
// 400 world units long with no per-particle spin at all, against a seal whose
// hit radius is 1. Replaying the clip would fling notes off the far side of the
// arena in a row.
//
// What IS usable is the art. The 199 meshes are 8 distinct glyphs repeated:
// eighth, quarter, beamed pairs and beamed triples, 6.1k triangles for the
// whole file, flat at z = 0, unlit, one material and NO TEXTURES. That is the
// ideal shape for VFX here — flat means it reads at any angle in a side-on
// game, and untextured means colour is entirely ours to set per instance.
//
// Two outputs, because two different systems want them:
//
//   musicnote.glb    one glyph, the plain eighth note. Goes through the normal
//                    asset pipeline as `musicNote` — the harp's projectile, and
//                    the fallback anything else draws.
//   musicnotes.glb   all 8, as separate nodes in one file. Loaded by
//                    systems/noteStorm.js, which needs the GEOMETRIES rather
//                    than a built visual: it instances them, and an
//                    InstancedMesh cannot vary geometry between its instances,
//                    so one draw call per glyph is the whole reason they stay
//                    apart.
//
// Recentred and scaled here rather than in config, for the usual reason — an
// unrecentred glyph rotates about a point outside itself, and a glyph left at
// its authored 4.4 units would need a 0.05 in every slider that touches it.
import { readGlb, readAccessor } from './lib/glb.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');
const SRC = process.argv[2]
  ?? '/Users/ethangoldhammer/Documents/_DesignSystems/SealSurvivor/pflow_practice_-_music_spread.glb';
const OUT = join(PROJECT, 'public/models');

// The height of one plain eighth note becomes 1.0 world unit, and every other
// glyph is divided by the SAME number rather than normalised to its own box. A
// beamed triple really is taller and four times wider than a single note, and
// that is the engraving, not an accident to be flattened out — the variety in
// the swarm is most of what makes it read as music rather than as confetti.
const REFERENCE_GLYPH = 0;

// Named in engraving order once they're sorted by copy count, which is also
// (checked) their order of visual complexity. Purely for legibility in the
// scene graph and in the tool's output.
const NAMES = [
  'eighth', 'quarter', 'beam2', 'beam2wide', 'beam3', 'beam3flag', 'eighthFlag', 'beam2gap',
];

const glb = readGlb(SRC);
const { json } = glb;

// --- gather the distinct glyphs --------------------------------------------
// A particle bake repeats one source object per particle, so identical glyphs
// come out byte-identical. Hashing the local positions is enough to collapse
// 199 meshes into the handful actually drawn.
const byHash = new Map();
for (const mesh of json.meshes) {
  const prim = mesh.primitives[0];
  const pos = readAccessor(glb, prim.attributes.POSITION);
  const nrm = prim.attributes.NORMAL !== undefined
    ? readAccessor(glb, prim.attributes.NORMAL) : null;
  const idx = prim.indices != null ? readAccessor(glb, prim.indices) : null;
  const key = pos.map((v) => v.toFixed(4)).join(',');
  if (!byHash.has(key)) byHash.set(key, { pos, nrm, idx, copies: 0 });
  byHash.get(key).copies++;
}
const glyphs = [...byHash.values()].sort((a, b) => b.copies - a.copies);

// --- recentre and rescale ---------------------------------------------------
const bboxOf = (pos) => {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], pos[i + k]);
      hi[k] = Math.max(hi[k], pos[i + k]);
    }
  }
  return { lo, hi };
};
const refHeight = (() => {
  const { lo, hi } = bboxOf(glyphs[REFERENCE_GLYPH].pos);
  return hi[1] - lo[1];
})();
const scale = 1 / refHeight;

for (const [i, g] of glyphs.entries()) {
  const { lo, hi } = bboxOf(g.pos);
  const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  g.name = NAMES[i] ?? `note${i}`;
  g.out = g.pos.map((v, k) => (v - c[k % 3]) * scale);
  g.size = [0, 1, 2].map((k) => (hi[k] - lo[k]) * scale);
  // Winding is whatever Max baked; the material is drawn DoubleSide in game, so
  // a glyph presenting its back as it tumbles is still solid. Normals are kept
  // anyway — an unlit material ignores them, but a future lit one would not.
  g.nrmOut = g.nrm ?? new Array(g.pos.length).fill(0).map((_, k) => (k % 3 === 2 ? 1 : 0));
  g.idxOut = g.idx ?? [...Array(g.pos.length / 3).keys()];
}

// --- write ------------------------------------------------------------------
// A hand-rolled writer rather than three's GLTFExporter, which wants a DOM and
// a canvas it can never get here (see the note in tools/split-islands.mjs). The
// file is one buffer, one unlit material and N nodes; nothing about that needs
// a renderer.
const pad4 = (n) => (n + 3) & ~3;

function writeGlb(parts, dest) {
  const views = [];
  const accessors = [];
  const meshes = [];
  const nodes = [];
  const blobs = [];
  let offset = 0;

  const addView = (data, target) => {
    blobs.push(data);
    views.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength, target });
    offset += pad4(data.byteLength);
    return views.length - 1;
  };
  const addAccessor = (data, componentType, type, count, target, extra = {}) => {
    accessors.push({
      bufferView: addView(data, target), componentType, count, type, ...extra,
    });
    return accessors.length - 1;
  };

  for (const p of parts) {
    const pos = new Float32Array(p.out);
    const { lo, hi } = bboxOf(p.out);
    // POSITION is the one accessor the spec REQUIRES min/max on, and three's
    // loader builds the bounding sphere from them. Omitting it doesn't throw —
    // it produces a geometry that frustum-culls itself at the origin.
    const a = addAccessor(pos, 5126, 'VEC3', pos.length / 3, 34962, { min: lo, max: hi });
    const n = addAccessor(new Float32Array(p.nrmOut), 5126, 'VEC3', p.nrmOut.length / 3, 34962);
    const i = addAccessor(new Uint16Array(p.idxOut), 5123, 'SCALAR', p.idxOut.length, 34963);
    meshes.push({ name: p.name, primitives: [{ attributes: { POSITION: a, NORMAL: n }, indices: i, material: 0 }] });
    nodes.push({ name: p.name, mesh: meshes.length - 1 });
  }

  const bin = Buffer.alloc(offset);
  let at = 0;
  for (const b of blobs) {
    Buffer.from(b.buffer, b.byteOffset, b.byteLength).copy(bin, at);
    at += pad4(b.byteLength);
  }

  const gltf = {
    asset: { version: '2.0', generator: 'seal-survivor tools/note-glyphs.mjs' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: offset }],
    // Unlit and white. The source baked baseColor BLACK, which would make every
    // tint and every glow multiplier in the game a no-op on it — black stays
    // black however hard you multiply it. White is the identity the per-instance
    // colour needs.
    materials: [{
      name: 'note',
      doubleSided: true,
      extensions: { KHR_materials_unlit: {} },
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 },
    }],
    extensionsUsed: ['KHR_materials_unlit'],
  };

  const jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPad = Buffer.alloc(pad4(jsonBuf.length) - jsonBuf.length, 0x20);
  const binPad = Buffer.alloc(pad4(bin.length) - bin.length, 0);
  const jsonChunk = Buffer.concat([jsonBuf, jsonPad]);
  const binChunk = Buffer.concat([bin, binPad]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const jsonHead = Buffer.alloc(8);
  jsonHead.writeUInt32LE(jsonChunk.length, 0);
  jsonHead.writeUInt32LE(0x4e4f534a, 4); // 'JSON'
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(binChunk.length, 0);
  binHead.writeUInt32LE(0x004e4942, 4); // 'BIN'
  const out = Buffer.concat([header, jsonHead, jsonChunk, binHead, binChunk]);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, out);
  return out.length;
}

mkdirSync(OUT, { recursive: true });
const allBytes = writeGlb(glyphs, join(OUT, 'musicnotes.glb'));
const oneBytes = writeGlb([glyphs[REFERENCE_GLYPH]], join(OUT, 'musicnote.glb'));

console.log(`\n${SRC.split('/').pop()}`);
console.log(`  ${json.meshes.length} baked meshes -> ${glyphs.length} distinct glyphs`);
console.log(`  reference height ${refHeight.toFixed(2)} src units -> 1.00 world unit (x${scale.toFixed(4)})\n`);
let tris = 0;
for (const g of glyphs) {
  tris += g.idxOut.length / 3;
  console.log(
    `  ${g.name.padEnd(11)} ${String(g.copies).padStart(3)} copies  `
    + `${String(g.idxOut.length / 3).padStart(3)}t  `
    + `${g.size[0].toFixed(2)} x ${g.size[1].toFixed(2)} world units`,
  );
}
console.log(`\n  musicnotes.glb  ${glyphs.length} glyphs, ${tris} tris, ${(allBytes / 1024).toFixed(1)} KB`);
console.log(`  musicnote.glb   1 glyph,  ${glyphs[REFERENCE_GLYPH].idxOut.length / 3} tris, ${(oneBytes / 1024).toFixed(1)} KB`);
console.log(`  (source was ${(readGlb(SRC).buf.length / 1024).toFixed(0)} KB)\n`);
