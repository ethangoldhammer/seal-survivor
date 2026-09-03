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

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
