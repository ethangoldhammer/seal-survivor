// Produces small, texture-free, clip-trimmed variants of every model for the
// self-contained playtest build ONLY. The real project (neon.zip) always
// keeps the original, full-fidelity files.
//
// Two size wins, both legitimate — nothing here changes what the game looks
// like in the real project:
//   1. Texture maps are stripped (the playtest re-derives its own flat
//      material colours; the full project keeps real textures).
//   2. Only the animation clips actually referenced in ASSETS.<key>.animations
//      are kept — e.g. the fur seal ships 11 clips and maps 10, so the unmapped
//      one is dropped from the playtest copy specifically. It's still in the
//      real source file. An asset that maps NOTHING is the exception and keeps
//      every clip: that's the single-clip-reuse path (the walking crab), where
//      the absence of a mapping is what makes the lone clip get used.
globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.ProgressEvent = class { constructor(t, o = {}) { Object.assign(this, o); this.type = t; } };
globalThis.document = {
  createElementNS: () => ({ style: {}, getContext: () => null, addEventListener() {}, removeEventListener() {} }),
  createElement: () => ({ style: {}, getContext: () => null, addEventListener() {}, removeEventListener() {} }),
};
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buf) => { this.result = buf; this.onloadend?.(); });
  }
};

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS } from '../path/src/assets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.resolve(root, '../playtest_models');
fs.mkdirSync(outDir, { recursive: true });

function stripGLBTextures(buf) {
  let o = 12, json = null, bin = null;
  while (o < buf.length) {
    const len = buf.readUInt32LE(o), t = buf.toString('ascii', o + 4, o + 8);
    if (t === 'JSON') json = JSON.parse(buf.toString('utf8', o + 8, o + 8 + len));
    if (t.startsWith('BIN')) bin = buf.subarray(o + 8, o + 8 + len);
    o += 8 + len;
  }
  for (const m of json.materials || []) {
    for (const k of Object.keys(m)) if (/Texture$/.test(k)) delete m[k];
    if (m.pbrMetallicRoughness) for (const k of Object.keys(m.pbrMetallicRoughness)) if (/Texture$/.test(k)) delete m.pbrMetallicRoughness[k];
    delete m.extensions;
  }
  delete json.textures; delete json.images; delete json.samplers;
  delete json.extensionsUsed; delete json.extensionsRequired;
  const js = Buffer.from(JSON.stringify(json), 'utf8');
  const jsPad = Buffer.concat([js, Buffer.alloc((4 - js.length % 4) % 4, 0x20)]);
  const head = Buffer.alloc(12); head.write('glTF', 0, 'ascii'); head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + jsPad.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsPad.length, 0); jh.write('JSON', 4, 'ascii');
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.write('BIN\0', 4, 'ascii');
  return Buffer.concat([head, jh, jsPad, bh, bin]);
}

function stripMaterialMaps(object) {
  object.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap', 'bumpMap']) {
        if (m[slot]) m[slot] = null;
      }
    }
  });
}

async function exportSlim(object, clips) {
  const exporter = new GLTFExporter();
  const result = await new Promise((resolve, reject) => {
    exporter.parse(object, resolve, reject, { binary: true, animations: clips });
  });
  return Buffer.from(result);
}

const entries = Object.entries(ASSETS).filter(([, def]) => def.model && !def.model.startsWith('data:'));
const summary = [];
const doneByModelPath = new Map(); // model path -> output path, for dupes like the fish pack

for (const [key, def] of entries) {
  const srcPath = path.join(root, 'public', def.model);
  if (!fs.existsSync(srcPath)) { console.warn(`skip ${key}: ${srcPath} not found`); continue; }

  // Multiple keys can share one source file (fishPackA/B/C all point at
  // fishpack.glb) — the per-instance meshIndex split happens at runtime, so
  // there's no reason to export+embed the same bytes three times.
  const dupeOf = doneByModelPath.get(def.model);
  if (dupeOf) {
    fs.copyFileSync(dupeOf, path.join(outDir, `${key}.glb`));
    const sz = fs.statSync(dupeOf).size;
    summary.push({ key, originalSize: fs.statSync(srcPath).size, slimSize: sz, clipsKept: 0, clipsTotal: 0, dupe: true });
    continue;
  }
  const ext = def.model.split('.').pop().toLowerCase();
  const raw = fs.readFileSync(srcPath);
  const originalSize = raw.length;

  let object, allClips;
  try {
    if (ext === 'fbx') {
      object = new FBXLoader().parse(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), '');
      allClips = object.animations ?? [];
    } else {
      const stripped = stripGLBTextures(raw);
      const gltf = await new Promise((resolve, reject) =>
        new GLTFLoader().parse(stripped.buffer.slice(stripped.byteOffset, stripped.byteOffset + stripped.byteLength), '', resolve, reject));
      object = gltf.scene;
      allClips = gltf.animations ?? [];
    }
  } catch (err) {
    console.warn(`FAILED to load ${key} (${srcPath}): ${err.message}`);
    continue;
  }

  stripMaterialMaps(object);

  // An asset with NO `animations` mapping is not an asset with no animation —
  // systems/animation.js reuses a lone clip across idle/swim/boost precisely
  // when nothing is explicitly mapped (see `singleClipReuse`). Filtering by an
  // empty wanted-set would strip that clip and ship a frozen model, so mirror
  // the runtime rule: unmapped means keep what's there.
  const wantedNames = new Set(Object.values(def.animations ?? {}));
  const keepClips = wantedNames.size === 0 ? allClips : allClips.filter((c) => wantedNames.has(c.name));

  const outPath = path.join(outDir, `${key}.glb`);
  try {
    const slim = await exportSlim(object, keepClips);
    const finalBuf = slim.length < originalSize ? slim : raw;
    fs.writeFileSync(outPath, finalBuf);
    doneByModelPath.set(def.model, outPath);
    summary.push({ key, originalSize, slimSize: finalBuf.length, clipsKept: keepClips.length, clipsTotal: allClips.length, keptOriginal: finalBuf === raw });
  } catch (err) {
    console.warn(`FAILED to export ${key}: ${err.message} — falling back to texture-strip only, no clip trimming`);
    // Safety net: if export fails for some reason, at least ship the
    // texture-stripped GLB (with all clips) rather than nothing.
    if (ext !== 'fbx') {
      fs.writeFileSync(outPath, stripGLBTextures(raw));
      doneByModelPath.set(def.model, outPath);
      summary.push({ key, originalSize, slimSize: fs.statSync(outPath).size, clipsKept: allClips.length, clipsTotal: allClips.length, fallback: true });
    } else {
      fs.writeFileSync(outPath, raw);
      doneByModelPath.set(def.model, outPath);
      summary.push({ key, originalSize, slimSize: raw.length, clipsKept: allClips.length, clipsTotal: allClips.length, fallback: true });
    }
  }
}

// --- size budget ---------------------------------------------------------
// The playtest is ONE self-contained HTML file, and base64 inflates bytes by
// ~33% on top of the raw model size. Past roughly 20MB browsers start
// struggling to parse it (and iframe previews fail outright), so the build
// enforces a budget: models are kept in priority order — the player and the
// abilities you look at constantly first, big background props last — and
// anything that doesn't fit is dropped from the PLAYTEST only. Dropped
// models fall back to their procedural shape there; the full project zip
// always keeps every model at full quality.
const BUDGET_BYTES = 11e6;
const PRIORITY = [
  'ship', 'belugaDrone', 'eelCompanion', 'seagull',
  'enemyShark', 'enemyGlowingShark', 'enemyFish', 'enemyTang', 'enemyReeffish',
  'enemyTrout', 'enemyGreatWhite', 'enemyHammerhead', 'enemyMightyMeg',
  'enemyWalkingCrab', 'enemyOtter', 'enemyMegalodon',
  'enemyFishPackA', 'enemyFishPackB', 'enemyFishPackC',
];
const rank = (k) => { const i = PRIORITY.indexOf(k); return i === -1 ? 999 : i; };
summary.sort((a, b) => rank(a.key) - rank(b.key));
let used = 0;
const dropped = [];
for (const entry of summary) {
  if (used + entry.slimSize <= BUDGET_BYTES) {
    used += entry.slimSize;
  } else {
    entry.dropped = true;
    dropped.push(entry.key);
    fs.rmSync(path.join(outDir, `${entry.key}.glb`), { force: true });
  }
}
if (dropped.length) {
  console.log(`\nBUDGET: kept ${(used / 1e6).toFixed(1)}MB of models (cap ${(BUDGET_BYTES / 1e6).toFixed(0)}MB).`);
  console.log(`Dropped from the PLAYTEST only (they fall back to procedural shapes there; the zip keeps them): ${dropped.join(', ')}`);
}

let totalOrig = 0, totalSlim = 0;
console.log('key'.padEnd(18), 'original'.padStart(10), 'slim'.padStart(10), 'clips');
for (const s of summary) {
  totalOrig += s.originalSize; totalSlim += s.slimSize;
  console.log(
    s.key.padEnd(18),
    (s.originalSize / 1e6).toFixed(2).padStart(9) + 'M',
    (s.slimSize / 1e6).toFixed(2).padStart(9) + 'M',
    `${s.clipsKept}/${s.clipsTotal}` + (s.fallback ? ' (fallback)' : '') + (s.keptOriginal ? ' (kept original — smaller)' : '') + (s.dupe ? ' (reused)' : '')
  );
}
console.log('\nTOTAL', (totalOrig / 1e6).toFixed(1) + 'M ->', (totalSlim / 1e6).toFixed(1) + 'M');
