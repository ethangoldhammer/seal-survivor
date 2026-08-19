// Measures what a boss arrival actually costs, per archetype, on the real files.
//   node --import ./tools/vite-loader.mjs tools/boss-entrance-probe.mjs
import './dom-stub.mjs';
globalThis.createImageBitmap = async (src) => ({ width: src?.width ?? 1, height: src?.height ?? 1, close() {} });
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS, installModel, createVisual, instantiateParsedModel } from '../path/src/assets.js';
import { CONFIG } from '../path/src/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const BOSS_ENEMIES = ['bossShark','bossOrca','bossSquid','bossCrab','bossMosasaur','bossHammerhead','bossBoat','bossYacht','bossAnglerfish'];

function assetKeysFor(enemyKey) {
  const def = CONFIG.enemies[enemyKey];
  if (!def) return [];
  const out = [];
  if (def.assets?.length) out.push(...def.assets);
  else if (def.asset) out.push(def.asset);
  if (def.crewAsset) out.push(def.crewAsset);
  return out;
}

async function load(key) {
  const def = ASSETS[key];
  if (!def?.model) return null;
  const path = resolve(HERE, '../public', def.model.replace(/^\//, ''));
  if (!existsSync(path)) return null;
  const buf = readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  let source, clips;
  if (/\.fbx$/i.test(def.model)) {
    const g = new FBXLoader().parse(ab, '');
    source = g; clips = g.animations ?? [];
  } else {
    const g = await new GLTFLoader().parseAsync(ab, '');
    source = g.scene; clips = g.animations ?? [];
  }
  installModel(key, instantiateParsedModel(source), clips);
  return { bytes: statSync(path).size };
}

function stats(visual) {
  let nodes = 0, meshes = 0, bones = 0, tris = 0;
  const mats = new Set(), texSources = new Map();
  visual.traverse((o) => {
    nodes++;
    if (o.isBone) bones++;
    if (o.isMesh || o.isSkinnedMesh) {
      meshes++;
      const g = o.geometry;
      if (g) tris += (g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!m) continue;
        mats.add(m);
        for (const slot of ['map','emissiveMap','normalMap','roughnessMap','metalnessMap','aoMap','alphaMap']) {
          const t = m[slot];
          if (t?.source && !texSources.has(t.source.uuid)) {
            const img = t.source.data;
            texSources.set(t.source.uuid, (img?.width ?? 0) * (img?.height ?? 0));
          }
        }
      }
    }
  });
  let px = 0;
  for (const v of texSources.values()) px += v;
  return { nodes, meshes, bones, tris: Math.round(tris), mats: mats.size, texs: texSources.size, mpx: px / 1e6 };
}

const time = (fn, n) => {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  return (performance.now() - t0) / n;
};

console.log('\nBOSS ARRIVAL COST — real models, node (CPU only; no GPU upload or link here)\n');
const rows = [];
for (const enemyKey of BOSS_ENEMIES) {
  for (const asset of assetKeysFor(enemyKey)) {
    const info = await load(asset);
    if (!info) { console.log(`  (skip ${enemyKey}/${asset} — no model on disk)`); continue; }
    // COLD: the first clone of a template, which is what an arrival pays.
    const t0 = performance.now();
    const first = createVisual(asset);
    const cold = performance.now() - t0;
    const warm = time(() => createVisual(asset), 5);
    const s = stats(first);
    rows.push({ enemyKey, asset, cold, warm, ...s, file: info.bytes / 1e6 });
  }
}

rows.sort((a, b) => b.cold - a.cold);
const pad = (v, n) => String(v).padStart(n);
console.log('  boss            asset                 clone-cold  clone-warm   nodes  bones  meshes    tris   mats  texs   MPx   file');
for (const r of rows) {
  console.log(`  ${r.enemyKey.padEnd(15)} ${r.asset.padEnd(21)} ${pad(r.cold.toFixed(1), 8)}ms ${pad(r.warm.toFixed(1), 9)}ms ${pad(r.nodes,6)} ${pad(r.bones,6)} ${pad(r.meshes,7)} ${pad(r.tris,7)} ${pad(r.mats,6)} ${pad(r.texs,5)} ${pad(r.mpx.toFixed(1),5)} ${pad(r.file.toFixed(1),6)}MB`);
}
const worst = rows[0];
console.log(`\n  worst single body: ${worst.enemyKey} — ${worst.cold.toFixed(1)}ms of clone alone, ${worst.mpx.toFixed(1)} megapixels of texture waiting to upload.`);
console.log(`  total texture across all boss bodies: ${rows.reduce((a, r) => a + r.mpx, 0).toFixed(1)} MPx (~${(rows.reduce((a,r)=>a+r.mpx,0)*4*1.33).toFixed(0)}MB as RGBA8 + mips)\n`);
