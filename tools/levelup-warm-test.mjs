#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:levelwarm
//
// systems/levelUpWarmup.js — the queue that pays for a companion card while the
// cards are still on screen, instead of on the first live frame after the pick.
//
// FIVE THINGS, and the third is the one that stops this rotting:
//
//   1. INERT      with no pipeline installed every entry point is a no-op and
//                 none of them throw. This is not a formality: the file is
//                 imported by main.js, which is imported by half the harnesses
//                 in this directory, and a warm-up that threw in Node would
//                 take them all down.
//   2. THE QUEUE  one body per tick, one texture per tick, one compile at the
//                 end, and the job clears itself. Driven with fake models
//                 installed under the real asset keys and a stub pipeline that
//                 records what it was asked to upload — see THE FAKE MODELS.
//   3. COVERAGE   every system in path/src/systems that grows a list of
//                 createVisual bodies to match a count is either in the warm
//                 list or in the allow-list below WITH A REASON. This is the
//                 check that fails when a fifth companion is added and nobody
//                 remembers this file — which is the failure the warm-up would
//                 otherwise have: it runs, reports itself finished, and the new
//                 ability hitches on exactly one card.
//   4. LEDGER     warm once per run, and a cancel keeps what it already paid
//                 for while leaving the rest for the next menu.
//   5. THE GATE   CONFIG.levelUp.warmup.enabled false puts the hitch back.
//
// WHAT THIS CANNOT REACH. There is no GL context in Node, so nothing here
// proves an upload happened — only that the queue asked for one, in order, one
// per tick. Whether initTexture and post.warm actually cost what they are meant
// to save is a question for a real renderer, and the evidence for it is in
// playtest/runs.jsonl (`npm run perf`): a `{cards}` frame attributed to
// `compile` is this warm-up having missed something.
//
//   node --import ./tools/vite-loader.mjs tools/levelup-warm-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { CONFIG } from '../path/src/config.js';
import { ASSETS, installModel } from '../path/src/assets.js';
import {
  levelUpWarmupKeys, levelUpWarmupState, installLevelUpWarmup,
  beginLevelUpWarmup, tickLevelUpWarmup, cancelLevelUpWarmup, resetLevelUpWarmup,
} from '../path/src/systems/levelUpWarmup.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SYSTEMS = resolve(HERE, '../path/src/systems');

let failures = 0;
const ok = (cond, what, detail = '') => {
  if (cond) console.log(`  ok   ${what}`);
  else { failures++; console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ''}`); }
};

// ---------------------------------------------------------------------------
// THE FAKE MODELS
//
// hasModel() is false for every key in Node — no GLB is ever loaded here — and
// beginLevelUpWarmup skips a key with no model on purpose (a primitive stand-in
// shares one cached material and has nothing per-asset to warm). So the queue
// would never start, and a test that drove it would be asserting against an
// empty list while looking exactly like it passed.
//
// installModel puts a real template under the real key, so createVisual clones
// it the way the game does. One material with one map each, which is what makes
// the upload count below a number this test can predict.
// ---------------------------------------------------------------------------
function fakeModel() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
  // Its OWN texture per key, not a shared one: collectTextures dedupes by
  // source, so one texture across four keys would upload once and this test
  // would happily certify a queue that only ever warmed the first asset.
  const tex = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
  const root = new THREE.Group();
  root.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: tex })));
  return root;
}

// A pipeline that records instead of drawing. `warm` has to return a promise —
// stepCompile clears the job in its `finally`, so a stub returning undefined
// would throw inside the queue rather than finishing it.
function stubPost() {
  const log = { uploads: [], warms: 0 };
  return {
    log,
    post: {
      initTexture: (t) => log.uploads.push(t),
      warm: async (group) => { log.warms++; log.lastGroupSize = group.children.length; },
    },
  };
}

const drive = (limit = 200) => {
  let ticks = 0;
  while (tickLevelUpWarmup() && ticks < limit) ticks++;
  return ticks;
};

// ---------------------------------------------------------------------------
console.log('\nlevel-up warm-up\n');

// --- 1. INERT ---------------------------------------------------------------
installLevelUpWarmup({});
ok(levelUpWarmupState().ready === false, 'no pipeline: not ready');
ok(beginLevelUpWarmup() === false, 'no pipeline: begin is a no-op');
ok(tickLevelUpWarmup() === false, 'no pipeline: tick is a no-op');

// --- the keys are real ------------------------------------------------------
const keys = levelUpWarmupKeys();
ok(keys.length > 0, 'the warm list is not empty', `${keys.length} keys`);
const unknown = keys.filter((k) => !ASSETS[k]);
ok(unknown.length === 0, 'every warm key is an asset', unknown.join(', '));
ok(new Set(keys).size === keys.length, 'the warm list has no duplicates');

// --- 2. THE QUEUE -----------------------------------------------------------
for (const k of keys) installModel(k, fakeModel());
const { post, log } = stubPost();
installLevelUpWarmup({ post, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera() });
resetLevelUpWarmup();

ok(beginLevelUpWarmup() === true, 'begin starts a queue');

// One step per tick, checked as it runs rather than at the end: the whole point
// of the queue is that it never does two expensive things on one frame, and a
// version that did them all in the first tick would finish with identical
// totals.
let worstBuildJump = 0;
let worstUploadJump = 0;
let prev = levelUpWarmupState();
let ticks = 0;
while (tickLevelUpWarmup() && ticks < 200) {
  const now = levelUpWarmupState();
  worstBuildJump = Math.max(worstBuildJump, now.built - prev.built);
  worstUploadJump = Math.max(worstUploadJump, now.uploaded - prev.uploaded);
  prev = now;
  ticks++;
}
ok(worstBuildJump <= 1, 'never more than one body per tick', `saw ${worstBuildJump}`);
ok(worstUploadJump <= 1, 'never more than one upload per tick', `saw ${worstUploadJump}`);
ok(ticks >= keys.length, 'took at least one tick per key', `${ticks} ticks for ${keys.length} keys`);

ok(log.uploads.length === keys.length,
  'uploaded one texture per key', `${log.uploads.length} of ${keys.length}`);
ok(new Set(log.uploads).size === log.uploads.length, 'no texture uploaded twice');
ok(log.warms === 1, 'compiled once, at the end', `${log.warms} compiles`);
ok(log.lastGroupSize === keys.length, 'compiled every body it built', `${log.lastGroupSize}`);

// The job clears in the compile's `finally`, which is a microtask behind us.
await Promise.resolve();
await Promise.resolve();
ok(levelUpWarmupState().active === false, 'the job clears itself when it drains');

// --- 4. LEDGER --------------------------------------------------------------
ok(beginLevelUpWarmup() === false, 'a second level-up starts nothing');
ok(levelUpWarmupState().warmed.length === keys.length, 'every key is marked warm');

resetLevelUpWarmup();
ok(levelUpWarmupState().warmed.length === 0, 'a new run clears the ledger');
ok(beginLevelUpWarmup() === true, 'a new run warms again');

// A menu closed early keeps what it paid for and leaves the rest.
tickLevelUpWarmup();
cancelLevelUpWarmup();
const part = levelUpWarmupState();
ok(part.active === false, 'cancel drops the queue');
ok(part.warmed.length === 1, 'cancel keeps the key it already built', `${part.warmed.length}`);
ok(beginLevelUpWarmup() === true, 'the next menu picks up the rest');
const rest = levelUpWarmupState();
ok(rest.keys === keys.length - 1, 'and only the rest', `${rest.keys} left of ${keys.length}`);
drive();
await Promise.resolve();

// --- 5. THE GATE ------------------------------------------------------------
resetLevelUpWarmup();
CONFIG.levelUp.warmup.enabled = false;
ok(beginLevelUpWarmup() === false, 'the config switch turns it off');
CONFIG.levelUp.warmup.enabled = true;

// --- 3. COVERAGE ------------------------------------------------------------
//
// Which files build a body PER INSTANCE to match a count. That is the shape
// that lands on the frame after a pick — a `while (list.length < n)` around a
// createVisual — and it is the shape a new companion will be written in,
// because it is the shape all four existing ones are written in.
//
// Anything found that the warm list does not cover has to be named here with a
// reason. A silent allow-list would be the same failure as a stale key list.
const ALLOWED = {
  'crew.js': 'boss-side — the yacht\'s guests, warmed by systems/bossWarmup.js during the arrival hush',
  'orca.js': 'boss-side — the pod, warmed by systems/bossWarmup.js during the arrival hush',
};

const GROWS = /while\s*\(\s*[\w.]+\.length\s*<\s*[^)]+\)/;
const found = [];
for (const file of readdirSync(SYSTEMS).filter((f) => f.endsWith('.js'))) {
  const src = readFileSync(join(SYSTEMS, file), 'utf8');
  if (!GROWS.test(src)) continue;
  // The call, not the prose — half this codebase's comments say "createVisual".
  if (!/^\s*(?:const|let|var)?[^/\n]*\bcreateVisual\s*\(/m.test(src)) continue;
  found.push(file);
}
const covered = new Set(['shrimpRing.js', 'sealTeam.js', 'harp.js', 'club.js', 'sardineSwirl.js']);

// THE DETECTOR IS TESTED FIRST, the same way the copy gate tests its own regex.
// A scan that has quietly stopped matching finds nothing, allows everything and
// passes — which is worse than not scanning at all, because it reads as
// coverage. These two say it can still see: it finds all four of the builders
// we know about, and it would object to one it did not.
const missed = [...covered].filter((f) => !found.includes(f));
ok(missed.length === 0, 'the scan still sees the builders it is meant to see',
  missed.length ? `blind to ${missed.join(', ')}` : `found ${found.join(', ')}`);

const canary = 'function grow(n) { while (list.length < n) list.push(createVisual(\'x\')); }';
ok(GROWS.test(canary) && /^\s*(?:const|let|var)?[^/\n]*\bcreateVisual\s*\(/m.test(canary),
  'the scan would object to a new builder');

const strays = found.filter((f) => !covered.has(f) && !ALLOWED[f]);
ok(strays.length === 0,
  'every per-instance builder is warmed or allow-listed',
  strays.length ? `${strays.join(', ')} — add its assets to the warm list, or allow-list it with a reason` : '');

// ...and the other direction: a system in `covered` that stopped exporting its
// keys would leave the warm list quietly short.
for (const file of covered) {
  const src = readFileSync(join(SYSTEMS, file), 'utf8');
  const m = src.match(/export const (\w*ASSETS)\b/);
  ok(!!m, `${file} still exports its asset list`, m ? '' : 'no `export const *_ASSETS`');
}

console.log(failures ? `\n${failures} failed\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
