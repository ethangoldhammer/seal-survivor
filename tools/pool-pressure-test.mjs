#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Pool pressure: does the body pool still cover a full arena?
//
// assets.js keeps POOL_PER_KEY = 24 recycled bodies per asset key, and
// CONFIG.spawn.maxAlive is 220. Below the cap a wave of deaths is entirely
// absorbed and the next wave costs nothing. Above it, every body past the 24th
// is disposed on death and CLONED AGAIN on the next spawn — a skeletonClone
// plus a fresh Skeleton, which is a new bone texture to upload.
//
// The recorded runs show alive going from ~12-25 through levels 5-7 to
// 127-204 by levels 8-10, so this measures the hit rate on both sides of that.
//
//   node --import ./tools/vite-loader.mjs tools/pool-pressure-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import { acquireVisual, releaseVisual, clearVisualPool } from '../path/src/assets.js';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

const KEY = 'enemyFish';

// One wave: take `n` bodies, then hand them all back. Returns how many of the
// bodies issued this time were ones we had already seen — i.e. recycled.
function wave(n, seen) {
  const got = [];
  let recycled = 0;
  for (let i = 0; i < n; i++) {
    const v = acquireVisual(KEY);
    if (seen.has(v)) recycled++;
    seen.add(v);
    got.push(v);
  }
  for (const v of got) releaseVisual(v);
  return recycled;
}

console.log('\nA wave dies, the next wave spawns. How much of it comes off the pool?');
console.log('  alive per species   recycled   fresh clones   hit rate');
const rows = [];
for (const n of [10, 20, 24, 40, 80, 150]) {
  clearVisualPool();
  const seen = new Set();
  wave(n, seen);          // prime: everything here is fresh by definition
  const recycled = wave(n, seen); // the wave we actually measure
  const fresh = n - recycled;
  rows.push({ n, recycled, fresh });
  console.log(
    String(n).padStart(19),
    String(recycled).padStart(10),
    String(fresh).padStart(14),
    `${(recycled / n * 100).toFixed(0)}%`.padStart(11),
  );
}

console.log('\nWhat that means');
const small = rows.find((r) => r.n === 20);
const big = rows.find((r) => r.n === 150);
check(
  'below the cap, a whole wave recycles',
  small.fresh === 0,
  `${small.recycled}/${small.n} recycled, ${small.fresh} fresh`,
);
check(
  'above the cap, most of the wave is cloned from scratch every time',
  big.fresh > big.recycled,
  `${big.fresh} of ${big.n} bodies are fresh clones each wave`,
);
console.log(`\n  At ${big.n} of one species alive, ${big.fresh} bodies per wave are a fresh skeletonClone`);
console.log('  and a fresh Skeleton — a new bone texture each — while the pool absorbs only 24.\n');

process.exit(failures ? 1 : 0);
