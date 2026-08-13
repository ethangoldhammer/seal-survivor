#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:prune
//
// Guards pruneUnknownKeys in config.js — the thing that stops a field DELETED
// from config.js coming back out of a saved snapshot and living there forever.
//
// Two halves, and the second is the one that matters:
//
//   IT PRUNES     a key config.js no longer declares is gone after a merge,
//                 on the import path as well as at boot, and Reset does not
//                 bring it back (DEFAULTS is captured after the prune).
//
//   IT SPARES     the containers whose children are USER ENTRIES rather than
//                 a shape config.js declares — the model looks, the sound
//                 workbench's voices and takes, the per-species glow diffs.
//                 A prune that gets this wrong deletes work that only exists
//                 in imported-tuning.json, silently, at boot, with the file
//                 rewritten before anyone notices. Every check in this half
//                 is a thing that was nearly lost while writing it:
//                 `sfx.oxygenWarn2` is a voice made with the workbench's
//                 duplicate button, and a per-voice rule ate it.
//
// The crab section is the subtle one. linkCrabVariants() points the night
// crab's nested blocks AT the day crab's objects, so from the second merge
// onward `emberCrab.crawl` and `walkingCrab.crawl` are the same object —
// and a prune that walked into it under the ember crab's name would strip the
// walking crab's own behaviour out from under it, since those keys are
// registered under the walking crab's path. It must delete the ember crab's
// REFERENCE and let linkCrabVariants restore it.
// ---------------------------------------------------------------------------

import { CONFIG, importTuning, resetConfigToDefaults } from '../path/src/config.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const crawlKeysBefore = Object.keys(CONFIG.enemies.walkingCrab.crawl).length;
const looksBefore = Object.keys(CONFIG.assetLooks).length;
const sfxBefore = Object.keys(CONFIG.sfx).length;

// A snapshot shaped like the real one: the two keys this was written for,
// a couple of older ghosts, and — mixed in — entries that must survive.
importTuning({
  // `orbitDepth` rather than `maxSeals`, and `emissive` rather than
  // `sizeMultiplier`, deliberately: weapons.csv and assets.csv own those two
  // and reassert them after every merge, so testing with them would measure
  // the tables rather than the prune.
  sealTeam: { skin: { enabled: true, variants: [{ pattern: 'spots' }] }, orbitDepth: 1.9 },
  beluga: { droneScale: 0.5, orbitRadius: 3.1 },
  strike: { maxCharges: 3 },
  enemies: { emberCrab: { crawl: { bogus: 1 } }, walkingCrab: { group: 'x' } },
  assetLooks: { madeUpAsset: { emissive: 0x334455, glow: 2 } },
  sfx: { myNewVoice: { srcs: ['/sfx/x.mp3'] } },
  biolumSkin: { presets: { lantern: { bodyDarken: 0.9, madeUpKey: 7 } } },
});

section('IT PRUNES');
check('sealTeam.skin is gone', CONFIG.sealTeam.skin === undefined);
check('beluga.droneScale is gone', CONFIG.beluga.droneScale === undefined);
check('an older ghost goes too (strike.maxCharges)', CONFIG.strike.maxCharges === undefined);
check('one level down as well (walkingCrab.group)', CONFIG.enemies.walkingCrab.group === undefined);
check('the real values beside them are kept',
  CONFIG.sealTeam.orbitDepth === 1.9 && CONFIG.beluga.orbitRadius === 3.1,
  `orbitDepth=${CONFIG.sealTeam.orbitDepth} orbitRadius=${CONFIG.beluga.orbitRadius}`);

section('THE SHARED CRAB BLOCK');
check('emberCrab.crawl is still the walking crab\'s object',
  CONFIG.enemies.emberCrab.crawl === CONFIG.enemies.walkingCrab.crawl);
check('and that object still has all its keys',
  Object.keys(CONFIG.enemies.walkingCrab.crawl).length === crawlKeysBefore,
  `${Object.keys(CONFIG.enemies.walkingCrab.crawl).length} of ${crawlKeysBefore}`);
check('the snapshot\'s bogus crawl key did not survive',
  CONFIG.enemies.walkingCrab.crawl.bogus === undefined);

section('IT SPARES');
check('a model look config.js never declared', CONFIG.assetLooks.madeUpAsset?.emissive === 0x334455);
check('and the 50-odd already there', Object.keys(CONFIG.assetLooks).length === looksBefore + 1,
  `${Object.keys(CONFIG.assetLooks).length} entries`);
check('a voice made with the workbench\'s duplicate button',
  CONFIG.sfx.myNewVoice?.srcs?.[0] === '/sfx/x.mp3');
check('and every voice already in the bank', Object.keys(CONFIG.sfx).length === sfxBefore + 1,
  `${Object.keys(CONFIG.sfx).length} voices`);
check('a take list on a built-in voice', (CONFIG.sfx.shoot?.srcs ?? []).length > 0,
  `${(CONFIG.sfx.shoot?.srcs ?? []).length} takes on sfx.shoot`);
check('a per-species glow key config.js never declared',
  CONFIG.biolumSkin.presets.lantern.madeUpKey === 7);
check('a tuned preset diff', CONFIG.biolumSkin.presets.lantern.bodyDarken === 0.9);

section('RESET DOES NOT RESURRECT THEM');
resetConfigToDefaults();
check('sealTeam.skin still gone', CONFIG.sealTeam.skin === undefined);
check('beluga.droneScale still gone', CONFIG.beluga.droneScale === undefined);

console.log(failures ? `\n${failures} FAILED` : '\nAll passed.');
process.exit(failures ? 1 : 0);
