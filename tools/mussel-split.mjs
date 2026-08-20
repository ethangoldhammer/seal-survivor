#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Cuts the two mussels out of the Spline scene in SeaBed and writes them as
// standalone, game-ready props:
//
//   public/models/mussel.glb        the closed shell — the homing mussel
//   public/models/musselopen.glb    the same animal gaping — its detonation
//
//   node --import ./tools/vite-loader.mjs tools/mussel-split.mjs [--src p] [--out d]
//   npm run mussels
//
// WHY THIS EXISTS. toon_shaded_mussel.gltf is a SCENE, not a prop: 25 nodes
// holding two closed mussels, one open one built from six meshes, nine grains
// of salt, a ground plane, three lights and a camera. Nothing in it can ship as
// it stands, and the transform that makes it shippable is not obvious enough to
// be worth redoing by hand the next time the art is re-exported.
//
// WHAT THE NAME PROMISES AND THE FILE DOES NOT DELIVER. There is no toon
// shading in the export. THREE.GLTFExporter wrote plain PBR — metallic 0,
// roughness ~0.95, a flat baseColorFactor per material, no textures, and
// `KHR_lights_punctual` as the only extension. Whatever Spline was showing is a
// Spline material and did not survive. The banding the game puts on these comes
// from CONFIG.toonShade via the `noise:mussel` surface in assets.csv, which is
// a different mechanism reaching the same look.
//
// NEITHER MESH HAS UVs — POSITION and NORMAL only. That is survivable here and
// only here: systems/noiseShader.js samples object space, not UV, so the
// procedural surface the pair wears needs no unwrap. Anything that wants a
// TEXTURE on these has to unwrap them first.
//
// ---------------------------------------------------------------------------
// THE CANON BOTH MODELS ARE BAKED INTO, and why each part of it is needed
//
//   world-baked   every node in the source carries a baked matrix (Spline
//                 writes `matrix`, not TRS) under a root scaled to 0.01, and
//                 the open mussel is six children arranged in the group's
//                 space. Reading geometry without the world matrix gives six
//                 shells stacked on the origin at a hundred times the size.
//   long axis +Z  the closed mussel already lies that way; the open one is
//                 authored along X, hence the yaw. `forward: '+Z'` in ASSETS
//                 is then true of both rather than true of one.
//   nose at +Z    the pointed umbo LEADS. The two mussels disagreed about this
//                 in the source — the yaw that lines their long axes up leaves
//                 their points at opposite ends — so the sign is measured off
//                 the render, not assumed. A shell flying blunt-end-first is
//                 the kind of wrong that reads as "the homing is lagging".
//   centred       on the bounding box, so `fit` and the detonation's own spin
//                 both work about the middle of the shell instead of about
//                 wherever Spline's origin happened to be (x = -1.73 here).
//
// AND THE INDEX WIDTH. GLTFExporter always writes UNSIGNED_INT; every mesh in
// here is under 2k vertices, so half of every index buffer is leading zeroes.
// Narrowing them to uint16 is a fifth of the closed file and a quarter of the
// open one, for no change to a single vertex.
//
// ---------------------------------------------------------------------------
// THE HIDE, LIFTED — the one look decision this tool makes, and it is here
// rather than in ASSETS because it has to be true of BOTH files at once.
//
// The source gives every outer valve about a 2.5% albedo. That is too dark for
// the surface the pair wears in the game: systems/toonShade.js divides the
// albedo out, bands the light and multiplies the albedo back — so its output is
// capped by the albedo, and at 2.5% a perfectly working two-band ramp has
// nothing to spend the bands on. See CONFIG.toonShade.presets.mussel.
//
// WHY NOT `tint` IN ASSETS, which is where a colour override belongs. Because
// `tint` repaints every material on a model and the open mussel has six: its
// orange body, its tan mantle and its pale nacre are the entire reason that
// file exists, and a blanket tint flattens all three to the hide colour. There
// is no per-mesh tint in the asset layer. Tinting only the closed shell was the
// other option and it shipped for one revision — the detonation then swapped a
// lifted charcoal shell for a jet-black one mid-flash, two tones for one
// animal. Doing it here, to the dark materials only, is the version that keeps
// the pair matching AND keeps the inside of the mussel.
//
// Picked on the look page against the water it is drawn on (npm run
// looks:mussels), and picked LOW on purpose: it lands within a point of the
// water's own luminance, because what separates a mussel from the sea is that
// it is neutral against a blue field rather than brighter than one. Chasing a
// luminance gap argues this all the way up to a pale grey pebble.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
// The GLB export packs its buffer through a Blob and a FileReader, neither of
// which Node has. The shim touches nothing but the bytes.
class NodeFileReader {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buf) => { this.result = buf; this.onloadend?.(); });
  }
}
globalThis.FileReader = NodeFileReader;

import * as THREE from 'three';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');

const DEFAULT_SRC = `${process.env.HOME}/Documents/_DesignSystems/SealSurvivor/toon_shaded_mussel.gltf`;
const srcArg = process.argv.indexOf('--src');
const SRC = srcArg > -1 ? resolve(process.argv[srcArg + 1]) : DEFAULT_SRC;
const outArg = process.argv.indexOf('--out');
const OUT = outArg > -1 ? resolve(process.argv[outArg + 1]) : join(PROJECT, 'public/models');

// NAMES AS GLTFLoader SEES THEM, not as the file spells them. The loader runs
// every node name through PropertyBinding.sanitizeNodeName, which turns the
// spaces in "Closed Mussel A" into underscores — so a lookup written from
// reading the .gltf finds nothing and reports it as a missing mesh.
const SUBJECTS = {
  closed: {
    file: 'mussel.glb',
    parts: ['Closed_Mussel_A'],
    yaw: 0,
  },
  open: {
    file: 'musselopen.glb',
    // Outer shells first so the file reads hull-inwards; the order is cosmetic.
    parts: [
      'Shell_Bottom_Outer', 'Shell_Bottom_Inner',
      'Shell_Top_Outer', 'Shell_Top_Inner',
      'Mussel_Body', 'Mussel_Mantle',
    ],
    // Authored along X. +90 lines the long axis up with Z and leaves the point
    // at -Z; -90 lines it up AND puts the point where the closed shell's is.
    yaw: -90,
  },
};

// The lifted hide, as an sRGB hex. THREE.Color converts on the way in and
// GLTFExporter writes baseColorFactor back out in linear, so this is the number
// you would type into a colour picker and not the number in the .gltf.
const HIDE = 0x2b2f3f;
// What counts as "an outer valve", measured rather than named: any material
// under this linear luminance. BY LUMINANCE AND NOT BY MESH NAME because the
// names are the export's, and a re-export that renames `Shell_Top_Outer` would
// silently stop lifting it and leave one valve black — a difference small
// enough to look like a lighting quirk. The gap in this model is not close:
// the two valves sit at 0.020 and 0.024, and the next darkest material (the
// mantle) is at 0.60.
const DARK_BELOW = 0.1;

function fail(msg) { console.error(`[mussel-split] ${msg}`); process.exit(1); }

const raw = readFileSync(SRC);
const loader = new GLTFLoader();
const gltf = await loader.parseAsync(
  // A .gltf is JSON; .parse wants the text, and the buffer rides along as a
  // data: URI inside it, so there is no sidecar .bin to resolve.
  raw.toString('utf8'), dirname(SRC) + '/',
);
const scene = gltf.scene;
scene.updateMatrixWorld(true);

const byName = new Map();
scene.traverse((n) => byName.set(n.name, n));

/** Collapse a list of source meshes into one origin-centred, canon-axis group. */
function build(spec, label) {
  const group = new THREE.Group();
  const lifted = [];
  for (const name of spec.parts) {
    const src = byName.get(name);
    if (!src?.isMesh) fail(`"${name}" is not a mesh in ${SRC} — the source changed.`);
    src.updateWorldMatrix(true, false);
    const geo = src.geometry.clone();
    // applyMatrix4 carries the normals through the normal matrix, which is what
    // makes a world-bake safe on a node whose matrix is a rotation.
    geo.applyMatrix4(src.matrixWorld);
    const mat = (Array.isArray(src.material) ? src.material[0] : src.material).clone();
    // The hide lift — see the block at the top. Linear luminance, because
    // mat.color is already linear here and the threshold is quoted that way.
    const lum = 0.2126 * mat.color.r + 0.7152 * mat.color.g + 0.0722 * mat.color.b;
    if (lum < DARK_BELOW) {
      mat.color.setHex(HIDE);
      lifted.push(`${name} ${lum.toFixed(3)}`);
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    group.add(mesh);
  }
  const yaw = new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(spec.yaw));
  for (const m of group.children) m.geometry.applyMatrix4(yaw);

  const box = new THREE.Box3().setFromObject(group);
  const c = box.getCenter(new THREE.Vector3());
  const shift = new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z);
  for (const m of group.children) {
    m.geometry.applyMatrix4(shift);
    m.geometry.computeBoundingBox();
  }

  const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
  let tris = 0;
  for (const m of group.children) {
    tris += m.geometry.index ? m.geometry.index.count / 3 : m.geometry.attributes.position.count / 3;
  }
  // THE ONE ASSERTION WORTH MAKING. Everything downstream — `fit`, `forward`,
  // the detonation's spin axis — assumes Z is the long side. A re-export that
  // rotated the scene would otherwise sail through and land a mussel flying
  // sideways at 1/3 scale, which looks like a tuning mistake, not a data one.
  if (!(size.z > size.x && size.z > size.y)) {
    fail(`${label}: long axis is not Z (${size.x.toFixed(2)}, ${size.y.toFixed(2)}, `
      + `${size.z.toFixed(2)}) — the source's orientation changed, so `
      + `SUBJECTS.${label}.yaw needs re-deriving.`);
  }
  console.log(`  ${label}: ${group.children.length} mesh(es), ${tris} tris, `
    + `${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}`);
  // SAID OUT LOUD, because a threshold that silently matches nothing is the
  // failure mode here: the pair would ship with the source's black hide, the
  // banding would have nothing to work on, and every check downstream still
  // passes. Both files must lift something.
  if (!lifted.length) {
    fail(`${label}: no material was under the ${DARK_BELOW} hide threshold — `
      + 'the source\'s colours changed, so HIDE is being applied to nothing.');
  }
  console.log(`    hide lifted to #${HIDE.toString(16)} on: ${lifted.join(', ')}`);
  return group;
}

// --- uint16 index narrowing --------------------------------------------------
// Done on the finished GLB rather than on the geometry, because THREE picks the
// index type at export time off the vertex count and setIndex cannot override
// it. Rebuilding the container is the only place the choice is ours.
const pad4 = (b, fill) => Buffer.concat([b, Buffer.alloc((4 - b.length % 4) % 4, fill)]);

function narrowIndices(glb) {
  const buf = Buffer.from(glb);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen + 8;
  const bin = buf.subarray(binStart, binStart + buf.readUInt32LE(20 + jsonLen));

  // One accessor per bufferView is what the exporter emits. A shared view would
  // make the per-accessor rewrite below quietly corrupt its sibling, so this is
  // checked rather than assumed.
  const users = new Map();
  json.accessors.forEach((a, i) => {
    if (!users.has(a.bufferView)) users.set(a.bufferView, []);
    users.get(a.bufferView).push(i);
  });
  for (const list of users.values()) if (list.length !== 1) return glb; // leave it alone

  const chunks = [];
  let offset = 0;
  json.bufferViews.forEach((bv, vi) => {
    let data = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    const acc = json.accessors[users.get(vi)[0]];
    if (acc.componentType === 5125 && acc.type === 'SCALAR') {
      const wide = new Uint32Array(data.buffer, data.byteOffset, acc.count);
      let max = 0;
      for (const v of wide) if (v > max) max = v;
      if (max < 65536) {
        const narrow = Buffer.alloc(acc.count * 2);
        for (let i = 0; i < acc.count; i++) narrow.writeUInt16LE(wide[i], i * 2);
        data = narrow;
        acc.componentType = 5123;
      }
    }
    bv.byteOffset = offset;
    bv.byteLength = data.length;
    const padded = pad4(Buffer.from(data), 0);
    chunks.push(padded);
    offset += padded.length;
  });

  const newBin = Buffer.concat(chunks);
  json.buffers = [{ byteLength: newBin.length }];
  // THE JSON CHUNK PADS WITH SPACES and the BIN chunk with zeroes. Padding the
  // JSON with NULs produces a file every validator accepts on length and
  // JSON.parse throws on one byte past the closing brace — "Unexpected
  // non-whitespace character after JSON", pointing at nothing.
  const js = pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const body = Buffer.concat([
    (() => { const h = Buffer.alloc(8); h.writeUInt32LE(js.length, 0); h.write('JSON', 4); return h; })(), js,
    (() => { const h = Buffer.alloc(8); h.writeUInt32LE(newBin.length, 0); h.write('BIN\0', 4); return h; })(), newBin,
  ]);
  const head = Buffer.alloc(12);
  head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([head, body]);
}

mkdirSync(OUT, { recursive: true });
console.log(`[mussel-split] ${SRC}`);
const exporter = new GLTFExporter();
for (const [label, spec] of Object.entries(SUBJECTS)) {
  const group = build(spec, label);
  const glb = await exporter.parseAsync(group, { binary: true, onlyVisible: false });
  const out = narrowIndices(glb);
  writeFileSync(join(OUT, spec.file), out);
  console.log(`  -> ${join(OUT, spec.file)}  ${glb.byteLength} -> ${out.length} bytes`);
}
