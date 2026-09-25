#!/usr/bin/env node
// WETRIS DRAWS SEALITAIRE'S SEA AND SWIMS SEALITAIRE'S SEAL — the files below
// are the same bytes in both projects, and this keeps them the same.
//
//   the water   goo, foam, surface (.wgsl) — NOT the vortex: wetris forks it
//               as whirl.wgsl to expose its constants as sliders
//   the tuner   tuner.rml (the row and header parts) and the Inter font its
//               text names by id
//   the seal    seal.mesh (the baked rig and clips), seal.wgsl, puppet.luau
//               (the swim, the blender, the clips) and react.luau (the
//               celebrations) — motion.luau is NOT shared: its landing points
//               are the game's own
//
// They are COPIES because they cannot be links: the rive CLI's directory scan
// skips a symlinked asset without a word, the build reports 0 errors, and
// `context:shader('vortex')` comes back nil at run time — the board then
// falls back to its flat draw, which is a playable-looking game with no water
// in it. So the copy is the only way, and a copy drifts: sealitaire is tuned
// often, and a uniform-row change there with no matching change here would
// draw garbage.
//
//   npm run test:wetrisshared   fails on any byte of difference
//   npm run wetris:sync         copies sealitaire's over wetris's
//
// After a copy, check board.luau's and seal.luau's passes still write the rows
// each shader's header documents, and that puppet.luau's Frame still has the
// fields seal.luau hands it — a layout change is the one thing a copy cannot
// carry across for you.
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = ['goo.wgsl', 'foam.wgsl', 'surface.wgsl', 'seal.wgsl', 'seal.mesh', 'puppet.luau', 'react.luau', 'tuner.rml', 'fonts/Inter.ttf', 'knock.luau'];
const write = process.argv.includes('--write');

let bad = 0;
for (const name of SHARED) {
  const from = join(ROOT, 'rive/sealitaire', name);
  const to = join(ROOT, 'rive/wetris', name);
  const src = readFileSync(from);
  let dst = null;
  let link = false;
  try {
    link = lstatSync(to).isSymbolicLink();
    dst = readFileSync(to);
  } catch { /* missing */ }
  if (link) {
    console.log(`  FAIL  ${name} is a symlink — the rive build skips those silently`);
    bad++;
    if (!write) continue;
  }
  if (!link && dst !== null && dst.equals(src)) {
    console.log(`  ok    ${name} matches sealitaire`);
    continue;
  }
  if (write) {
    writeFileSync(to, src);
    console.log(`  wrote ${name} from sealitaire`);
  } else {
    if (!link) console.log(`  FAIL  ${name} ${dst === null ? 'is missing' : 'differs from rive/sealitaire'} — npm run wetris:sync`);
    bad++;
  }
}
if (bad && !write) process.exit(1);
