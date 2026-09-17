#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:release
//
// EVERY BODY THIS GAME BUILDS OWNS A TEXTURE, AND ONE FUNCTION FREES THEM.
//
// createVisual clones a rigged asset. Geometry and materials come from the
// template and are shared with every other instance — but SkeletonUtils.clone
// gives each body a Skeleton of its own, and three uploads a bone DataTexture
// for it inside the first frame it draws. That texture is the clone's alone.
//
// `renderer.info.memory.textures` counts an upload until dispose() is called on
// it, and disposeVisual in assets.js — reachable only through releaseVisual —
// is the ONLY code in this game that ever calls dispose() on a skeleton. So a
// system that drops a body with scene.remove() leaks a texture for the life of
// the page, and nothing anywhere says so:
//
//   - the byte census reads flat, because a bone texture is about 4KB;
//   - the frame rate is fine, because nothing is being drawn;
//   - the run ends when iOS kills the WebContent process, minutes later,
//     somewhere else entirely.
//
// That is what the 9/17 trail is: a flat tex105MB through three sessions while
// the renderer's own tally went 306 -> 704 inside one run.
//
// So this counts the systems that mint bodies and never hand one back. It is a
// RATCHET, not a clean bill of health — the list below is the outstanding work,
// it is accurate as of the day it was written, and the only edit it accepts is
// a shorter one. A system that starts creating bodies without a release path is
// a new name, and a new name fails.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const SRC = ['path/src/systems', 'path/src/entities'];

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

// A body is created here and never given back. Shrinking this list is the
// work; every name on it is a bone texture the process cannot reclaim, at
// whatever rate that system builds bodies.
//
// NOT SPLIT INTO "leaks" AND "singletons", deliberately. A system that builds
// one body at boot and holds it forever genuinely costs nothing, and it is
// tempting to file those separately and call the rest the real list — but
// which of these is which is a claim about a call site's frequency that goes
// stale the first time somebody moves the call, and a body built once today is
// built per wave tomorrow with the excuse already written down beside it. One
// list, every name, and a name comes off when the file releases what it makes.
const OUTSTANDING = new Set([
  'systems/accessories.js',
  'systems/bakalar.js',
  'systems/beluga.js',
  'systems/calamari.js',
  'systems/club.js',
  'systems/decor.js',
  'systems/dumbo.js',
  'systems/eel.js',
  'systems/gore.js',
  'systems/gravesite.js',
  'systems/harp.js',
  'systems/levelUpGhost.js',
  'systems/levelUpSeal.js',
  'systems/levelUpWarmup.js',
  'systems/musselShell.js',
  'systems/octoGrab.js',
  'systems/orca.js',
  'systems/oyster.js',
  'systems/sardineSwirl.js',
  'systems/seabedScatter.js',
  'systems/sealTeam.js',
  'systems/seagull.js',
  'systems/shaderWarmup.js',
  'systems/shrimpRing.js',
  'systems/whale.js',
  'entities/pickups.js',
  'entities/player.js',
  'entities/projectiles.js',
]);

function walk(dir) {
  const out = [];
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...walk(join(dir, e.name)));
    else if (e.name.endsWith('.js')) out.push(join(dir, e.name));
  }
  return out;
}

// Comments in this codebase discuss createVisual at length, and a mention is
// not a call. Strip them, or the tool's own documentation becomes its evidence.
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const files = SRC.flatMap(walk);
check('the source tree was found', files.length > 50, `${files.length} files`);

const creating = [];
for (const file of files) {
  const src = code(readFileSync(join(root, file), 'utf8'));
  // acquireVisual is the POOLED door and ends in the same place, so a file that
  // only ever acquires is already correct by construction: releaseVisual is
  // the other half of that pair and the pool disposes what it cannot park.
  if (!/(?<!e)\bcreateVisual\s*\(/.test(src)) continue;
  const frees = /\b(releaseVisual|disposeVisual)\s*\(/.test(src);
  if (!frees) creating.push(relative('path/src', file));
}

const surprises = creating.filter((f) => !OUTSTANDING.has(f));
check('no system creates bodies it never frees without being on the list',
  surprises.length === 0,
  surprises.length
    ? `${surprises.join(', ')} — every body createVisual returns owns a bone texture, and`
      + ' releaseVisual is the only thing in the game that frees one'
    : '');

const fixed = [...OUTSTANDING].filter((f) => !creating.includes(f));
check('the list has not gone stale', fixed.length === 0,
  fixed.length ? `${fixed.join(', ')} release now — take them off OUTSTANDING` : '');

// The ratchet's own teeth: a detector that silently stopped matching would turn
// this whole suite into a green light meaning nothing. If the regex above can
// no longer find a call in a file that certainly has one, say so here.
check('the detector still recognises a createVisual call',
  /(?<!e)\bcreateVisual\s*\(/.test('const m = createVisual("boat");'));
check('...and is not fooled by acquireVisual',
  !/(?<!e)\bcreateVisual\s*\(/.test('const m = acquireVisual("boat");'));

console.log(`\n${creating.length} system(s) still build bodies they never hand back.`);
console.log(failures ? `\nvisual-release: ${failures} check failed\n` : '\nvisual-release: all good\n');
process.exit(failures ? 1 : 0);
