#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Measures every asset in ASSETS and writes the Model Atlas's data blob.
//
//   node --import ./tools/vite-loader.mjs tools/atlas-data.mjs [--out dir]
//
// The atlas page renders ENTIRELY from one embedded JSON blob — every stat
// tile, the scale lineup, the ledger, the plates, the findings. So keeping it
// current is a matter of regenerating this and re-injecting it, and NOT of
// editing numbers in the page, which is how a page ends up disagreeing with
// the game while looking authoritative.
//
// It writes three files:
//
//   rows.json     the blob, minus the two things Node cannot make
//   list.json     render specs for tools/atlas-render (a browser, because
//                 Node has no WebGL)
//   images/       every embedded base-colour map, extracted and thumbnailed,
//                 for the plate swatches
//
// WHY THE LOADERS AND NOT A JSON WALK. `dims` is the raw file's Box3 and it is
// what `fit` is computed against, so it has to come from the same measurement
// assets.js itself makes: THREE's own GLTFLoader/FBXLoader plus
// Box3.setFromObject. An earlier atlas walked the glTF node transforms by hand
// and disagreed with the loader — the loader was right.
//
// WHY THE MERGED CONFIG. `sizeMultiplier` is not in assets.js; it is in
// assets.csv and applied at import (see assetTable.js), and glow/emissive/
// roughness live in CONFIG.assetLooks which saved tuning writes over. Reading
// the source literals would report numbers the game does not use.
//
// MESHINDEX IS HONOURED, and has to be. Several assets share one binary and
// pick one mesh out of it; a pass that ignores that reports each of the three
// fish packs as carrying all three fishes' triangles and gives them identical
// proportions. That is a bug this atlas has actually shipped.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

import * as THREE from 'three';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { ASSETS } from '../path/src/assets.js';
import { CONFIG } from '../path/src/config.js';
import { ASSET_ROWS } from '../path/src/assetTable.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');
const PUBLIC = join(PROJECT, 'public');
const outArg = process.argv.indexOf('--out');
const OUT = outArg > -1 ? resolve(process.argv[outArg + 1]) : join(HERE, 'atlas-render/data');
mkdirSync(join(OUT, 'images'), { recursive: true });

const quiet = console.warn;
console.warn = (m, ...r) => {
  if (typeof m === 'string' && (m.startsWith('[assets]') || m.startsWith('[animation]') || m.startsWith('[assetTable]'))) return;
  quiet(m, ...r);
};

// --- who names what -------------------------------------------------------
// The `role` column is MEASURED, not declared. It used to come from a
// hand-kept list, so two thirds of the roster fell through to "Unused" while
// being spawned by name from systems/. The tuner and texture panels are
// excluded because they walk the whole roster by construction and would make
// every asset look referenced.
const SRC = join(PROJECT, 'path/src');
const SKIP_REF = /(tunerControls|textures)\.js$/;
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const srcFiles = walk(SRC).filter((f) => !SKIP_REF.test(f));
const srcText = new Map(srcFiles.map((f) => [f.slice(SRC.length + 1), readFileSync(f, 'utf8')]));

function referencesTo(key) {
  const rx = new RegExp(`(^|[^\\w])${key}(?![\\w])`, 'g');
  const hits = [];
  for (const [rel, text] of srcText) {
    if (rel === 'assets.js') continue; // the definition itself
    const n = (text.match(rx) ?? []).length;
    if (n) hits.push([rel, n]);
  }
  hits.sort((a, b) => b[1] - a[1]);
  return hits;
}

// --- enemies that use an asset --------------------------------------------
const enemyByAsset = new Map();
for (const [id, def] of Object.entries(CONFIG.enemies ?? {})) {
  // `assets` (plural) as well as `asset`. A creature can pick at random from
  // several bodies — the orca boss is a bull or a cow, the kraken is one of
  // its own — and reading only the singular leaves those models looking like
  // nothing in the game spawns them. They came out labelled "System · config",
  // which is the tell: the only file naming them was the one defining them.
  const used = def?.assets ?? (def?.asset ? [def.asset] : []);
  for (const assetKey of used) {
  if (!enemyByAsset.has(assetKey)) enemyByAsset.set(assetKey, []);
  enemyByAsset.get(assetKey).push({
    id,
    radius: def.radius ?? null,
    hp: def.hp ?? null,
    behavior: def.behavior ?? null,
    minDiff: def.minDifficulty ?? 0,
    minLvl: def.minPlayerLevel ?? 0,
    speed: def.speed ?? null,
    xp: def.xp ?? null,
    contact: def.contactDamage ?? null,
    maxConc: def.maxConcurrent ?? null,
    group: def.group ? `${def.group.min}-${def.group.max}` : null,
    scalePerDiff: def.scalePerDifficulty ?? null,
    maxGrowth: def.maxGrowth ?? null,
  });
  }
}

const AXIS_INDEX = { X: 0, Y: 1, Z: 2 };
const axisOf = (name) => AXIS_INDEX[(name ?? '+Z').slice(1)] ?? 2;

// --- what an asset is FOR --------------------------------------------------
// `Enemy` and `Boss` are derived — an asset named by CONFIG.enemies is an
// enemy, and bosses.csv says which of those are bosses. Everything else is a
// judgement about intent that no reference count can make: `boat` and `trawler`
// are both scenery driven from the same file, `shrimp` and `octoGrabber` are
// both abilities, and "the file that mentions it most" cannot tell those apart
// from a system. So the rest is a table, keyed on the DRIVING MODULE where one
// covers a family and on the asset key where it does not.
//
// A key that reaches neither is labelled by its driver rather than guessed at,
// which keeps a new asset honest ("System - octoGrab") until somebody decides
// what it is. `Unused` really means nothing in path/src names it.
const ROLE_BY_KEY = {
  ship: 'Player', sealTeam: 'Escort',
  orcaFriendBull: 'Escort', orcaFriendCow: 'Escort', orcaFriendCalf: 'Escort',
  dumboOcto: 'Companion', belugaDrone: 'Companion', eelCompanion: 'Companion',
  seagull: 'Ability', shrimp: 'Ability', octoGrabber: 'Ability', scallopShell: 'Ability',
  harp: 'Ability', club: 'Ability', clubThrow: 'Ability', clubBoom: 'Ability', clubIce: 'Ability',
  moneyRoll1: 'Ability', moneyRoll2: 'Ability', moneyRoll3: 'Ability', moneyRoll4: 'Ability',
  boat: 'Backdrop', trawler: 'Backdrop', grass: 'Backdrop',
  bakalarBoat: 'Event', fisherman: 'Event',
  ballroomGuest: 'Cast', businessGuest: 'Cast',
};
const BOSS_ASSETS = new Set();
try {
  const csv = readFileSync(join(PROJECT, 'path/src/bosses.csv'), 'utf8').trim().split(/\r?\n/);
  const cols = csv[0].split(',').map((c) => c.trim());
  const enemyCol = cols.indexOf('enemy');
  if (enemyCol > -1) for (const line of csv.slice(1)) BOSS_ASSETS.add(line.split(',')[enemyCol]?.trim());
} catch { /* no bosses.csv: everything just stays an Enemy */ }

function roleOf(key, mine, drivers) {
  if (ROLE_BY_KEY[key]) return ROLE_BY_KEY[key];
  if (mine.length) return mine.some((e) => BOSS_ASSETS.has(e.id)) ? 'Boss' : 'Enemy';
  if (!drivers.length) return 'Unused';
  return `System · ${basename(drivers[0][0], '.js')}`;
}

// --- thumbnails ------------------------------------------------------------
// sips, because PIL is not installed and this is macOS. Writes the extracted
// image out, resizes a copy, and reads it back as a data URI.
let thumbSeq = 0;
function thumbnail(bytes, mime) {
  const ext = mime?.includes('png') ? 'png' : mime?.includes('webp') ? 'webp' : 'jpg';
  const raw = join(OUT, 'images', `_raw${thumbSeq}.${ext}`);
  const small = join(OUT, 'images', `_small${thumbSeq}.jpg`);
  thumbSeq += 1;
  try {
    writeFileSync(raw, bytes);
    execFileSync('/usr/bin/sips', ['-Z', '128', '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', raw, '--out', small], { stdio: 'ignore' });
    const b64 = readFileSync(small).toString('base64');
    return `data:image/jpeg;base64,${b64}`;
  } catch {
    return null;
  } finally {
    for (const f of [raw, small]) { try { rmSync(f, { force: true }); } catch { /* nothing to clean */ } }
  }
}

function imageSize(path) {
  try {
    const out = execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], { encoding: 'utf8' });
    return {
      w: Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1] ?? 0),
      h: Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1] ?? 0),
    };
  } catch { return { w: 0, h: 0 }; }
}

// --- the glTF JSON chunk, for what the loader throws away ------------------
// Image byte counts, the extension list and which map plays which role are all
// in the JSON and gone by the time you have an Object3D.
function glbMeta(buf) {
  if (buf.toString('utf8', 0, 4) !== 'glTF') return null;
  const len = buf.readUInt32LE(12);
  const g = JSON.parse(buf.toString('utf8', 20, 20 + len));
  const binOff = 20 + len + 8;
  const bin = buf.subarray(binOff);
  const role = new Map();
  for (const m of g.materials ?? []) {
    const p = m.pbrMetallicRoughness ?? {};
    const put = (t, r) => { if (t?.index != null) role.set(g.textures[t.index]?.source, r); };
    put(p.baseColorTexture, 'baseColor');
    put(p.metallicRoughnessTexture, 'metalRough');
    put(m.normalTexture, 'normal');
    put(m.emissiveTexture, 'emissive');
    put(m.occlusionTexture, 'occlusion');
  }
  const images = (g.images ?? []).map((im, i) => {
    const bv = g.bufferViews?.[im.bufferView];
    if (!bv) return { img: i, role: role.get(i) ?? 'other', mime: im.mimeType ?? null, bytes: 0, data: null };
    const off = bv.byteOffset ?? 0;
    return {
      img: i,
      role: role.get(i) ?? 'other',
      mime: im.mimeType ?? null,
      bytes: bv.byteLength,
      data: bin.subarray(off, off + bv.byteLength),
    };
  });
  return { images, extensions: g.extensionsUsed ?? [] };
}

function isolateMesh(root, index) {
  const meshes = [];
  root.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) meshes.push(o); });
  const target = meshes[index];
  if (!target) return;
  const keep = new Set();
  for (let o = target; o; o = o.parent) keep.add(o);
  for (const m of meshes) if (!keep.has(m)) m.parent?.remove(m);
}

async function loadRoot(path, fmt) {
  const buf = readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  if (fmt === 'fbx') {
    const root = new FBXLoader().parse(ab, '');
    return { root, clips: root.animations ?? [] };
  }
  const g = await new GLTFLoader().parseAsync(ab, '');
  return { root: g.scene, clips: g.animations ?? [] };
}

const rows = [];
const shapes = [];
const missing = [];

for (const [key, def] of Object.entries(ASSETS)) {
  const sizeMul = Number(ASSET_ROWS.get(key)?.size ?? 1) || 1;
  const look = CONFIG.assetLooks?.[key] ?? {};

  if (!def.model) {
    shapes.push({
      key,
      shape: def.shape ?? null,
      sprites: def.sprites?.length ?? null,
      radius: def.radius ?? null,
      sizeMul,
      world: def.radius != null ? Number((def.radius * 2 * sizeMul).toFixed(4)) : null,
      color: def.color ?? null,
      tint: def.tint ?? null,
      glow: look.glow ?? null,
      rockVariants: def.rock?.variants ?? null,
    });
    continue;
  }

  const rel = def.model.replace(/^\//, '');
  const path = join(PUBLIC, rel);
  if (!existsSync(path)) { missing.push(`${key} -> ${def.model}`); continue; }

  const fmt = extname(path).slice(1).toLowerCase() === 'fbx' ? 'fbx' : 'glb';
  const buf = readFileSync(path);
  const meta = fmt === 'glb' ? glbMeta(buf) : null;

  const { root, clips } = await loadRoot(path, fmt);
  if (def.meshIndex != null) isolateMesh(root, def.meshIndex);
  root.updateMatrixWorld(true);

  let tris = 0, verts = 0, loose = 0, fbxMeshes = 0, fbxMapped = 0;
  // THE SKELETON'S bone count, not the subtree's. They differ, and the
  // skeleton's is the one that costs something: three builds a DataTexture of
  // the matrix palette per Skeleton, sized by `bones.length`, and every spawn
  // gets its own. A locator or an empty parented into the rig inflates a
  // traversal count without ever appearing in that palette.
  const skeletons = new Set();
  root.traverse((o) => {
    if (o.isBone) loose += 1;
    if (o.isSkinnedMesh && o.skeleton) skeletons.add(o.skeleton);
    if (!o.isMesh && !o.isSkinnedMesh) return;
    fbxMeshes += 1;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.some((m) => m?.map)) fbxMapped += 1;
    const g = o.geometry;
    const n = g.index ? g.index.count : g.attributes.position.count;
    tris += n / 3;
    verts += g.attributes.position.count;
  });
  const bones = skeletons.size
    ? Math.max(...[...skeletons].map((s) => s.bones.length))
    : loose;

  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const dims = [size.x, size.y, size.z].map((v) => Number(v.toFixed(4)));
  const longest = Math.max(...dims) || 1;
  const world = Number((def.fit * sizeMul).toFixed(4));
  const scale = world / longest;
  const fwdI = axisOf(def.forward);
  const upI = axisOf(def.up ?? '+Y');

  const thumbs = (meta?.images ?? [])
    .filter((im) => im.data)
    .map((im) => ({ img: im.img, role: im.role, mime: im.mime, bytes: im.bytes, thumb: thumbnail(im.data, im.mime) }))
    .filter((t) => t.thumb)
    .sort((a, b) => (a.role === 'baseColor' ? -1 : b.role === 'baseColor' ? 1 : 0));

  const mine = enemyByAsset.get(key) ?? [];
  const drivers = referencesTo(key);
  const role = roleOf(key, mine, drivers);

  rows.push({
    key,
    file: basename(path),
    fmt,
    fit: def.fit ?? null,
    sizeMul,
    world,
    lenW: Number((dims[fwdI] * scale).toFixed(3)),
    hgtW: Number((dims[upI] * scale).toFixed(3)),
    dims,
    forward: def.forward ?? '+Z',
    up: def.up ?? '+Y',
    pivot: def.pivot ?? null,
    meshIndex: def.meshIndex ?? null,
    tris: Math.round(tris),
    verts,
    bones,
    bytes: buf.length,
    imgCount: meta?.images.length ?? 0,
    imgBytes: (meta?.images ?? []).reduce((s, i) => s + i.bytes, 0),
    clips: clips.map((c) => c.name),
    clipDur: Object.fromEntries(clips.map((c) => [c.name, Number(c.duration.toFixed(2))])),
    wantClips: def.animations ?? {},
    fbxMeshes: fmt === 'fbx' ? fbxMeshes : null,
    fbxMapped: fmt === 'fbx' ? fbxMapped : null,
    tint: def.tint ?? null,
    glow: look.glow ?? 1,
    emissive: look.emissive ?? null,
    roughness: def.material?.roughness ?? look.roughness ?? null,
    emissiveMap: def.texture?.emissive ?? null,
    baseColorMap: def.texture?.map ?? null,
    modelUnlit: def.modelUnlit ?? null,
    noiseShader: def.noiseShader ? true : null,
    outline: def.outline ?? null,
    aimRig: !!def.aimRig,
    lookRig: !!def.lookRig,
    biteRig: !!def.biteRig,
    thumbs,
    extensions: meta?.extensions ?? [],
    enemies: mine,
    role,
    source: mine.length ? `config.js enemies.${mine[0].id}` : (drivers[0]?.[0] ?? 'nothing in path/src'),
    drivers,
    refCount: drivers.reduce((s, d) => s + d[1], 0),
    hitR: mine.length && mine[0].radius != null ? Number((mine[0].radius * sizeMul).toFixed(3)) : null,
  });
}

rows.sort((a, b) => a.key.localeCompare(b.key));
shapes.sort((a, b) => a.key.localeCompare(b.key));

// --- the loose texture library --------------------------------------------
const texRefs = new Map();
for (const [key, def] of Object.entries(ASSETS)) {
  for (const p of [def.texture?.emissive, def.texture?.map]) if (p) texRefs.set(p, 'mask');
  for (const p of def.sprites ?? []) texRefs.set(p, 'sprite');
  void key;
}
const tex = {};
for (const [url, kind] of texRefs) {
  const path = join(PUBLIC, url.replace(/^\//, ''));
  if (!existsSync(path)) continue;
  const { w, h } = imageSize(path);
  tex[url] = {
    thumb: thumbnail(readFileSync(path), url.endsWith('.png') ? 'image/png' : url.endsWith('.webp') ? 'image/webp' : 'image/jpeg'),
    bytes: statSync(path).size, w, h, kind, pure: null,
  };
}

const maskDir = join(PUBLIC, 'textures/emissive');
const allMasks = existsSync(maskDir) ? readdirSync(maskDir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)) : [];
const usedMask = new Set([...texRefs.keys()].filter((u) => u.includes('/emissive/')).map((u) => basename(u)));

function dirBytes(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += dirBytes(join(dir, e.name));
    else n += statSync(join(dir, e.name)).size;
  }
  return n;
}

const blob = {
  rows,
  shapes,
  tex,
  staleLooks: Object.keys(CONFIG.assetLooks ?? {}).filter((k) => !ASSETS[k]),
  masksUsed: allMasks.filter((f) => usedMask.has(f)).sort(),
  masksUnused: allMasks.filter((f) => !usedMask.has(f)).sort(),
  modelDirBytes: dirBytes(join(PUBLIC, 'models')),
};

writeFileSync(join(OUT, 'rows.json'), JSON.stringify(blob));
writeFileSync(join(OUT, 'list.json'), JSON.stringify(rows.map((r) => ({
  key: r.key, file: r.file, fmt: r.fmt, meshIndex: r.meshIndex,
  wantClips: r.wantClips, baseColorMap: r.baseColorMap,
  forward: r.forward, up: r.up,
})), null, 1));

console.log(`${rows.length} models, ${shapes.length} procedural, ${Object.keys(tex).length} loose textures`);
console.log(`public/models is ${(blob.modelDirBytes / 1048576).toFixed(1)} MB`);
console.log(`masks: ${blob.masksUsed.length} used, ${blob.masksUnused.length} unused`);
if (blob.staleLooks.length) console.log(`stale assetLooks keys: ${blob.staleLooks.join(', ')}`);
if (missing.length) console.log(`\nMODEL FILE MISSING (these got no row):\n  ${missing.join('\n  ')}`);
console.log(`\nwrote ${join(OUT, 'rows.json')} and list.json`);
