#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:defer
//
// Three models in the roster are `defer: true` — megalodon, mosasaurus and the
// yacht — because only a boss ever wears them and a boss announces itself three
// seconds before it arrives. That is 21MB of the 76MB the model bank costs in
// geometry and transcoded texture, not resident during the minutes of a run
// where no boss exists, on a device that kills the web view for memory.
//
// WHAT THIS GUARDS, and none of it is "does it skip the file":
//
//   1. ELIGIBILITY. A model shared with an ordinary enemy can NEVER be
//      deferred, because an ordinary enemy spawns with no warning at all. The
//      anglerfish, the crab's pincer, the hammerhead and the trawler are each
//      worn by something that swims in level one. Deferring one of those is a
//      creature that pops in as a grey primitive mid-fight, and the only thing
//      standing between that and the roster is a person remembering the rule.
//      So the rule is asserted instead.
//
//   2. THE ARRIVAL WAITS. createVisual falls back to the built-in shape for a
//      model it does not have, so a boss whose body has not landed is a grey
//      blob wearing a boss health bar — it fights correctly, it is named
//      correctly, and it reads as a broken art pipeline.
//
//   3. THE WAIT ENDS. Which is the opposite failure and the worse one: a fetch
//      that fails, or a file that is not deployed, must not mean a run that
//      never meets a boss with the spawner held and the ocean empty. Waiting
//      is better than a grey boss; waiting forever is worse than both.
//
//   node --import ./tools/vite-loader.mjs tools/deferred-assets-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import { ASSETS } from '../path/src/assets.js';
import { CONFIG } from '../path/src/config.js';
import { parseBossCsv } from '../path/src/bossTable.js';
import bossesCsv from '../path/src/bosses.csv?raw';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const deferred = Object.entries(ASSETS).filter(([, d]) => d.defer);
const roster = parseBossCsv(bossesCsv, CONFIG.enemies, () => {});

// Which asset key each archetype actually wears. NOT the archetype id and NOT
// the enemy key — `CONFIG.enemies[enemy].asset` is the indirection spawnNamed
// uses, and reading it off either of the other two silently answers about a
// creature that does not exist.
const bossAssetKeys = new Set(
  roster.map((b) => CONFIG.enemies[b.enemy]?.asset).filter(Boolean),
);

// ===========================================================================
section('Only a boss-worn model may be deferred');

check('something is actually deferred', deferred.length > 0,
  `${deferred.length}: ${deferred.map(([k]) => k).join(', ')}`);

for (const [key] of deferred) {
  check(`"${key}" is worn by a boss`, bossAssetKeys.has(key));
}

// ===========================================================================
section('...and never by anything that can spawn without warning');

// THE RULE THAT MATTERS. A deferred model is fetched at the start of the boss
// hush and nowhere else, so any OTHER asset naming the same file would spawn
// against a model that is simply not there — a shark that is a grey lozenge for
// the first few seconds of a run, with nothing thrown and nothing logged.
for (const [key, def] of deferred) {
  const sharers = Object.entries(ASSETS)
    .filter(([k, d]) => k !== key && d.model === def.model)
    .map(([k]) => k);
  check(`"${key}" has ${def.model.replace('/models/', '')} to itself`,
    sharers.length === 0, sharers.join(', '));
}

// And the inverse, which is the direction a mistake would actually come from:
// somebody adds `defer: true` to a model an ordinary enemy shares. Checked as
// a sweep over the whole roster rather than over the three, so a fourth one
// added later is covered without anybody editing this file.
{
  const byModel = new Map();
  for (const [k, d] of Object.entries(ASSETS)) {
    if (typeof d.model !== 'string') continue;
    if (!byModel.has(d.model)) byModel.set(d.model, []);
    byModel.get(d.model).push(k);
  }
  const bad = [];
  for (const [model, keys] of byModel) {
    const anyDeferred = keys.some((k) => ASSETS[k].defer);
    const anyEager = keys.some((k) => !ASSETS[k].defer);
    if (anyDeferred && anyEager) bad.push(`${model} (${keys.join(', ')})`);
  }
  check('no model is deferred by one asset and expected at boot by another',
    bad.length === 0, bad.join(' · '));
}

// ===========================================================================
section('The boss guard waits for a body, and stops waiting');

// Driven through the real updateBoss rather than by calling the guard, which
// is not exported — the question is whether an ARRIVAL is held, and the guard
// is only interesting through the thing it gates.
const boss = await import('../path/src/systems/boss.js');
const assets = await import('../path/src/assets.js');
const THREE = await import('three');

// assetsReady() is false in this harness — nothing can serve a model file — and
// the guard is deliberately inert in that state: every creature is a primitive
// there, so holding one back costs the run its boss and buys nothing. That is
// checked here rather than assumed, because it is also what lets every OTHER
// boss test in the repo keep spawning.
check('with no loader at all, nothing is held', assets.assetsReady() === false,
  'a Node harness serves no models');

{
  const scene = new THREE.Scene();
  const gameState = { running: true, level: 40, time: 300, difficulty: 6 };
  boss.resetBoss(scene);
  let arrived = null;
  for (let i = 0; i < 2000 && !arrived; i++) {
    arrived = boss.updateBoss(1 / 60, gameState, scene, { skipHush: true });
  }
  check('a boss still arrives', !!arrived,
    arrived ? `after ${arrived.def?.key ?? 'a body'}` : 'none in 2000 frames');
  boss.resetBoss(scene);
}

// ===========================================================================
section('...and the ordinary spawner refuses a body that is not resident');

// THE HOLE THE SWEEP ABOVE CANNOT SEE. It asks whether two ASSETS entries
// share a file; it never asks which CONFIG.enemies archetypes wear the KEY.
// `megalodon` (a real spawn: weight 0.07, level 8, difficulty 3) wears
// `enemyMegalodon` — the same key as `bossShark` — so deferring the shark
// boss's body deferred the megalodon's, and the pool spawned it as the cone.
// The guard that ends that lives in entities/enemies.js (bodyMissing), and it
// is inert until assetsReady() is true, which in this harness means flipping
// it by hand. See markAssetsPreloaded.
const en = await import('../path/src/entities/enemies.js');
const { readFileSync } = await import('node:fs');
const { resolve, dirname } = await import('node:path');
const { fileURLToPath } = await import('node:url');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const HERE = dirname(fileURLToPath(import.meta.url));

function stripTextures(buf) {
  let o = 12, json = null, jsonStart = 0, jsonLen = 0;
  while (o < buf.length) {
    const len = buf.readUInt32LE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    if (type === 'JSON') {
      json = JSON.parse(buf.toString('utf8', o + 8, o + 8 + len));
      jsonStart = o + 8;
      jsonLen = len;
    }
    o += 8 + len;
  }
  if (!json) return buf;
  for (const m of json.materials || []) {
    for (const k of Object.keys(m)) if (/Texture$/.test(k)) delete m[k];
    if (m.pbrMetallicRoughness) {
      for (const k of Object.keys(m.pbrMetallicRoughness)) if (/Texture$/.test(k)) delete m.pbrMetallicRoughness[k];
    }
    if (m.extensions) for (const e of Object.values(m.extensions)) for (const k of Object.keys(e)) if (/Texture$/.test(k)) delete e[k];
  }
  delete json.textures; delete json.images; delete json.samplers;
  let js = Buffer.from(JSON.stringify(json), 'utf8');
  if (js.length > jsonLen) throw new Error('stripped JSON grew — cannot patch in place');
  js = Buffer.concat([js, Buffer.alloc(jsonLen - js.length, 0x20)]);
  const out = Buffer.from(buf);
  js.copy(out, jsonStart);
  return out;
}

const deferredKeys = new Set(deferred.map(([k]) => k));
const wearers = Object.entries(CONFIG.enemies)
  .filter(([, d]) => [d.asset, d.nightAsset, ...(Array.isArray(d.assets) ? d.assets : [])]
    .some((k) => k && deferredKeys.has(k)));
const poolWearers = wearers.filter(([, d]) => (d.weight ?? 0) > 0 || (d.weightPerDifficulty ?? 0) > 0);
console.log(`  deferred bodies are worn by: ${wearers.map(([k]) => k).join(', ')}`);
check('at least one ordinary (pool-weighted) species wears a deferred body — the case under test',
  poolWearers.length > 0, poolWearers.map(([k]) => k).join(', '));

{
  const scene = new THREE.Scene();
  assets.markAssetsPreloaded(true);
  try {
    en.resetEnemies(scene);
    // Direct spawn, body absent: refused, and nothing goes in the water.
    const direct = en.spawnNamed(scene, 'megalodon', 6);
    check('spawnNamed refuses the megalodon while its body is not resident',
      direct === null && en.enemies.length === 0,
      direct ? `spawned ${direct.type}` : `${en.enemies.length} in the water`);

    // The pool, ticked long enough that every gate the megalodon has is open
    // and something else is being sent — the refusal must land on ONE species
    // and not on the spawner.
    en.resetEnemies(scene);
    const gs = { running: true, level: 40, time: 600, difficulty: 6 };
    const seen = new Map();
    for (let i = 0; i < 60 * 60; i++) {
      en.updateSpawning(1 / 60, gs, scene);
      for (const e of en.enemies) seen.set(e.type, (seen.get(e.type) ?? 0) + 1);
      // Churn so the cap never pins the cast on whatever came first.
      while (en.enemies.length > 40) en.removeEnemy(scene, en.enemies.length - 1);
    }
    const leaked = poolWearers.map(([k]) => k).filter((k) => seen.has(k));
    check('the pool sends nothing that would wear a placeholder', leaked.length === 0,
      leaked.length ? `spawned: ${leaked.join(', ')}` : `${seen.size} other species spawned`);
    check('...and the pool is not simply empty', seen.size > 0, `${seen.size} species`);

    // The boss keeps its own door: systems/boss.js has already waited with a
    // deadline, and what happens after it is that file's call. `overfill` is
    // the boss's and nobody else's, so it is the flag the refusal steps aside for.
    en.resetEnemies(scene);
    const viaBossDoor = en.spawnNamed(scene, 'bossMosasaur', 6, undefined, { ignoreCaps: true, overfill: true });
    check('the boss door (overfill) is not refused — that wait belongs to boss.js', !!viaBossDoor);

    // Then the body lands, and the same spawn goes through wearing it.
    const file = resolve(HERE, '../public/models/megalodon.glb');
    // Textures dropped before the parse — GLTFLoader decodes embedded images
    // through a blob: URL Node cannot serve, and the parse then never settles
    // (an "unsettled top-level await" with no stack). Same trick as
    // tools/apex-spring-test.mjs; nothing here looks at the material.
    const buf = stripTextures(readFileSync(file));
    const gltf = await new GLTFLoader().parseAsync(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
    assets.installModel('enemyMegalodon', gltf.scene, gltf.animations);
    en.resetEnemies(scene);
    const after = en.spawnNamed(scene, 'megalodon', 6);
    let rigged = false;
    after?.mesh?.traverse?.((o) => { if (o.isSkinnedMesh) rigged = true; });
    check('once the body is resident the megalodon spawns, and on the real rig',
      !!after && rigged, after ? (rigged ? 'skinned mesh present' : 'PRIMITIVE — the cone') : 'still refused');
    en.resetEnemies(scene);
  } finally {
    assets.markAssetsPreloaded(false);
  }
}

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
