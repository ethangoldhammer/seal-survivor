#!/usr/bin/env node
// ---------------------------------------------------------------------------
// FBX -> glb, mesh + rig + every clip, for a creature the Sealitaire tank
// pack (tools/sealitaire-fish.mjs) or the game wants but that only exists as
// an .fbx in public/models — the seagull, the beluga, the moray, the trout.
//
//   node tools/fbx-to-glb.mjs seagull [beluga ...]     public/models/<name>.fbx -> <name>.glb
//   node tools/fbx-to-glb.mjs --all                    every .fbx in public/models with no .glb beside it
//   --force                                            overwrite a .glb that already exists
//
// Three things it does on purpose, each learned the hard way (see
// tools/build-anglerfish.mjs, which does the same for a multi-file pack):
//
//   1. THE UVS ARE FLIPPED (v -> 1 - v). FBX puts (0,0) at the image's
//      bottom-left, glTF at the top-left; FBXLoader hides that with a
//      render-time flipY that does not survive export and cannot be reapplied
//      to an ImageBitmap on load. Flipping the data once here is what makes
//      the .glb carry honest glTF UVs. The tank pack reads no textures, but
//      the file lands in public/models and the game may.
//   2. THE MAPS ARE STRIPPED before the exporter sees them. Nothing in Node
//      decodes a PNG for three.js, so FBXLoader's Texture objects are empty
//      and GLTFExporter would write empty images. The material colours are
//      kept; a caller that wants the maps attaches them the way
//      build-anglerfish.mjs does, from the source art.
//   3. NOTHING IS WELDED OR PRUNED. The tank baker weighs nothing by vertex
//      count, and a pass that reorders vertices under a skin is a way to lose
//      the skin. Small enough files come out of a plain export.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
// dom-stub covers what the LOADERS touch. GLTFExporter goes one further: it
// serialises the binary chunk through a FileReader, which Node has no reason
// to provide. Without it the export dies on the very last line of writeAsync.
globalThis.FileReader = class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then((b) => { this.result = b; this.onloadend?.(); }); }
};
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = path.join(ROOT, 'public/models');
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const ALL = args.includes('--all');
let names = args.filter((a) => !a.startsWith('--'));
if (ALL) {
  names = fs.readdirSync(MODELS).filter((f) => /\.fbx$/i.test(f)).map((f) => f.replace(/\.fbx$/i, ''))
    .filter((n) => FORCE || !fs.existsSync(path.join(MODELS, `${n}.glb`)));
}
if (!names.length) {
  console.error('usage: node tools/fbx-to-glb.mjs <name> [...] | --all   [--force]');
  process.exit(1);
}

const mb = (n) => (n / 1048576).toFixed(2) + 'MB';
const loader = new FBXLoader();

for (const name of names) {
  const src = fs.readdirSync(MODELS).find((f) => f.toLowerCase() === `${name}.fbx`.toLowerCase());
  const out = path.join(MODELS, `${name}.glb`);
  if (!src) { console.error(`${name}: no ${name}.fbx in public/models`); process.exitCode = 1; continue; }
  if (fs.existsSync(out) && !FORCE) { console.log(`${name}: ${name}.glb exists (--force to overwrite)`); continue; }
  const b = fs.readFileSync(path.join(MODELS, src));
  const scene = loader.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.length), MODELS + '/');

  // FBX scenes carry lights and cameras the pack has no use for; the
  // exporter would only warn about them.
  const strays = [];
  scene.traverse((o) => { if (o.isLight || o.isCamera) strays.push(o); });
  for (const o of strays) o.removeFromParent();
  let meshes = 0, skinned = 0, tris = 0, uvFlipped = 0;
  scene.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    if (o.isSkinnedMesh) skinned++;
    const g = o.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    const uv = g.attributes.uv;
    if (uv) { for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i)); uv.needsUpdate = true; uvFlipped++; }
    for (const m of [].concat(o.material)) {
      for (const k of ['map', 'bumpMap', 'normalMap', 'specularMap', 'emissiveMap', 'roughnessMap', 'metalnessMap', 'lightMap', 'aoMap', 'alphaMap', 'envMap']) m[k] = null;
      m.needsUpdate = true;
    }
  });
  // A morph-target track with no morph dictionary behind it is an exporter
  // error (the moray has one); the tank pack skins bones only, so drop them.
  const clips = (scene.animations || []).map((c) => {
    const kept = c.tracks.filter((t) => !t.name.includes('morphTargetInfluences'));
    if (kept.length !== c.tracks.length) console.log(`${name}: ${c.name}: dropped ${c.tracks.length - kept.length} morph-target tracks`);
    return new THREE.AnimationClip(c.name, c.duration, kept);
  });
  const glb = await new Promise((res, rej) => new GLTFExporter().parse(scene, res, rej, { binary: true, animations: clips, onlyVisible: false }));
  const raw = Buffer.from(glb);
  fs.writeFileSync(out, raw);
  console.log(`${name.padEnd(12)} ${mb(b.length)} fbx -> ${mb(raw.length)} glb  ${meshes} meshes (${skinned} skinned, ${Math.round(tris)} tris, uv flipped on ${uvFlipped})  clips: ${clips.length ? clips.map((c) => `${c.name} (${c.duration.toFixed(2)}s)`).join(' | ') : 'none'}`);
}
