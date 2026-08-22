#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:bossrim
//
// A BOSS DOES NOT WEAR THE WILDLIFE THREAT RIM — and the one thing that can go
// wrong with that is invisible until a boss has already died.
//
// `bossShark` is built from `enemyMegalodon`, the same asset key the wildlife
// megalodon uses. CONFIG.creatureOutline.on is keyed by asset and the shells of
// a species share ONE material (that sharing is what makes the tuner switches
// work on creatures already swimming), so no switch can rim one and not the
// other. The only lever left is per-instance `visible` on the shell meshes,
// which is what systems/outlines.js hideOutlineOn writes.
//
// That lever is safe ONLY because of an ordering in assets.js:
//
//   acquireVisual -> createVisual (the spawn hook attaches the shells, visible)
//                 -> captureRest  (the snapshot records them AS VISIBLE)
//   ...boss.js then hides them on this instance.
//   releaseVisual -> the body goes back on the free list, still hidden
//   acquireVisual -> resetVisual restores every flag FROM THE SNAPSHOT
//
// Move captureRest one line later and the snapshot records the hidden state
// instead. Nothing throws. Nothing looks wrong for the length of a boss fight.
// The next wildlife megalodon out of the pool simply comes up with no rim, and
// so does every one after it, and the only way to see it is to have watched a
// boss die first. So the ordering is asserted here rather than trusted.
//
//   node --import ./tools/vite-loader.mjs tools/boss-rim-test.mjs
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONFIG } from '../path/src/config.js';
import { hideOutlineOn } from '../path/src/systems/outlines.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// captureRest and resetVisual are internal to assets.js on purpose — nothing
// outside the pool should be calling them. Re-exported into a temp copy rather
// than widened in the source, the same way tools/apply-shaders-test.mjs reaches
// spliceHandPresets: the point is to test the real functions, not a retyped
// copy of them, and a retyped copy is exactly what would keep passing after the
// real ordering changed.
// WRITTEN BESIDE THE ORIGINAL, not in /tmp, and that is not a detail. The copy
// keeps assets.js's own imports verbatim — `three` and a dozen `./` siblings —
// so it has to sit where those resolve from. In a temp directory the very first
// line fails on `three` and the whole file is a test that never ran.
const src = await readFile(resolve(HERE, '../path/src/assets.js'), 'utf8');
const mod = resolve(HERE, '../path/src/assets.__bossrimtest.js');
await writeFile(mod, src
  .replace('function captureRest(', 'export function captureRest(')
  .replace('function resetVisual(', 'export function resetVisual('));
// Imported by URL so the vite loader's JSON/?raw handling still applies, and
// from a path beside the original so its own relative imports resolve.
let captureRest, resetVisual;
try {
  ({ captureRest, resetVisual } = await import(pathToFileURL(mod).href));
} finally {
  // Removed the moment it is loaded rather than at the end of the run: another
  // session working in this repo should never see it, and a crash below must
  // not leave a second copy of assets.js sitting in path/src for someone to
  // find and wonder about. See the note in MEMORY on concurrent sessions.
  await rm(mod, { force: true });
}

// A stand-in for a creature body: a root, a body mesh, and two shells flagged
// the way addOutlineShells flags them. NOT a loaded model — no GLB loads in
// Node — and it does not need to be: every function under test here walks the
// hierarchy and reads `userData.__isOutline`, which is exactly what this has.
function makeBody() {
  const root = new THREE.Group();
  root.name = 'enemyMegalodon';
  const body = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  root.add(body);
  for (let i = 0; i < 2; i++) {
    const shell = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    shell.userData.__isOutline = true;
    // Parented to the body, not to the root, because that is where
    // addOutlineShells puts them — a hide that only looked at direct children
    // would pass on a flat fixture and miss every real creature.
    body.add(shell);
  }
  return { root, body };
}

const shellsOf = (root) => {
  const out = [];
  root.traverse((o) => { if (o.userData?.__isOutline) out.push(o); });
  return out;
};

console.log('\nTAKING THE RIM OFF ONE BODY');
{
  const { root } = makeBody();
  const n = hideOutlineOn(root);
  check('every shell is hidden, however deep it sits', n === 2 && shellsOf(root).every((s) => !s.visible),
    `${n} hidden`);
  check('the creature itself is untouched — this hides a rim, not an animal',
    root.children[0].visible === true);
  check('a body with no shells is a no-op rather than a throw',
    hideOutlineOn(new THREE.Group()) === 0);
  check('and so is nothing at all', hideOutlineOn(null) === 0);
}

console.log('\nTHE POOL PUTS IT BACK');
{
  const { root } = makeBody();
  // The real order: the shells exist and are visible when the snapshot is taken.
  captureRest(root);
  hideOutlineOn(root);
  check('the boss body is bare', shellsOf(root).every((s) => !s.visible));

  // ...and this is what acquireVisual does to a body coming off the free list.
  const ok = resetVisual(root);
  check('a recycled body accepts the reset', ok === true);
  check('THE RIM IS BACK — the next wildlife megalodon is not bare',
    shellsOf(root).every((s) => s.visible), shellsOf(root).map((s) => s.visible).join(', '));
}

console.log('\nTHE ORDERING THAT MAKES THAT TRUE');
{
  // The inverse, spelled out: snapshot the body AFTER hiding and the pool
  // faithfully restores the hidden state forever. This is not a bug being
  // tested for, it is the reason the assertion above is worth having — if this
  // case ever passes as "rim restored" then resetVisual has stopped reading the
  // snapshot and the test above has stopped meaning anything.
  const { root } = makeBody();
  hideOutlineOn(root);
  captureRest(root);
  resetVisual(root);
  check('a snapshot taken after the hide keeps the body bare — so the snapshot IS the source',
    shellsOf(root).every((s) => !s.visible));
}

console.log('\nTHE SWITCH THAT TURNS IT BACK ON');
{
  check('CONFIG.creatureOutline.bosses exists and ships off',
    CONFIG.creatureOutline?.bosses === false, String(CONFIG.creatureOutline?.bosses));
  // The guard in boss.js is `!== true`, not `=== false`, and this asserts that
  // it is still written that way. A key deleted from the snapshot or missing
  // from a future config has to fail SAFE, which for a boss means no wildlife
  // rim — `=== false` would put the rim back on the day the flag went missing,
  // which is the day nobody is looking.
  const bossSrc = await readFile(resolve(HERE, '../path/src/systems/boss.js'), 'utf8');
  check('boss.js guards on `!== true`, so a missing flag still means bare',
    /creatureOutline\?\.bosses !== true/.test(bossSrc));
}

console.log(failures ? `\n${failures} failure(s)\n` : '\nthe boss stays bare and the pool stays honest\n');
process.exit(failures ? 1 : 0);
