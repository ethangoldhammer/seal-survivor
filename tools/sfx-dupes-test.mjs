#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:sfxdupes
//
// Nothing in the sound bank should be there twice.
//
// A duplicate is not an error anywhere — it plays fine, it looks fine in the F
// menu, and it costs almost nothing. What it does is QUIETLY REWEIGHT a voice:
// pickSample chooses uniformly from `srcs`, so a file listed twice in a
// nine-take voice is heard twice as often as each of the other eight. You
// cannot hear "this take comes up more than it should" — you can only hear a
// voice that feels less varied than the number of takes says it is, which
// sounds like a mixing problem and gets fixed by adding more takes.
//
// Three ways it happens, all of them real in this repo:
//
//   THE DOUBLE CLICK   the library row in the workbench snapshots which files
//                      are on the voice when the row is BUILT, so two clicks
//                      landing before the re-render both read "not in the set"
//                      and both append. That is why the handler dedupes on the
//                      way in (see ui/workbench.js) — this checks the result.
//   THE RE-RUN         tools/sfx-assign.mjs appends a fixed mapping. It skips
//                      files already present, but only exactly: a rename, a
//                      path with a different case, or the same audio under a
//                      second filename all slip past.
//   THE SAME SOUND     ten of the delivered library files were byte-identical
//   TWICE ON DISK      renames of others in the same drop. Assign both and the
//                      voice has a take listed once and heard twice, with no
//                      repeated filename anywhere to show it.
//
// So the disk is hashed as well as the lists being compared. A file that
// duplicates another is a finding on its own even when nothing points at it:
// it ships, and it is one careless click from reweighting a voice.
//
//   node --import ./tools/vite-loader.mjs tools/sfx-dupes-test.mjs
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import './dom-stub.mjs';
import { CONFIG } from '../path/src/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SFX_DIR = join(HERE, '..', 'public', 'sfx');

let failures = 0;
const fail = (msg) => { console.log(`  FAIL  ${msg}`); failures++; };
const pass = (msg) => console.log(`  ok    ${msg}`);

// CONFIG, not the tuning file: a saved value beats the config default, so the
// merged object is the only place the list the game will actually play exists.
const takesOf = (def) => {
  if (!def) return [];
  if (Array.isArray(def.srcs) && def.srcs.filter(Boolean).length) return def.srcs.filter(Boolean);
  return def.src ? [def.src] : [];
};

// --- 1. the same file twice in one voice ------------------------------------
{
  const offenders = [];
  for (const [name, def] of Object.entries(CONFIG.sfx ?? {})) {
    const counts = new Map();
    for (const src of takesOf(def)) counts.set(src, (counts.get(src) ?? 0) + 1);
    const dupes = [...counts].filter(([, n]) => n > 1);
    if (dupes.length) {
      offenders.push(`${name}: ${dupes.map(([s, n]) => `${s.split('/').pop()} x${n}`).join(', ')}`);
    }
  }
  if (offenders.length) for (const o of offenders) fail(`a take is listed more than once — ${o}`);
  else pass(`no voice lists the same file twice (${Object.keys(CONFIG.sfx ?? {}).length} voices)`);
}

// --- 2. src and srcs both set -----------------------------------------------
// `src` is the one-file shorthand and playSfx ignores it whenever `srcs` has
// anything in it. Both set is not a duplicate today, but it is a take that
// looks assigned and never plays — and it becomes a duplicate the moment
// somebody empties the list.
{
  const both = Object.entries(CONFIG.sfx ?? {})
    .filter(([, d]) => d?.src && Array.isArray(d.srcs) && d.srcs.filter(Boolean).length)
    .map(([n, d]) => `${n} (src: ${d.src.split('/').pop()})`);
  if (both.length) fail(`src set alongside srcs, and it will never be heard — ${both.join(', ')}`);
  else pass('no voice carries a dead `src` behind its take list');
}

// --- 3. the ambient bed -----------------------------------------------------
// Its rotation picks by index, so a clip listed twice comes round twice as
// often — the same reweighting as a voice, over a much longer cycle where it
// is even harder to notice.
{
  const srcs = (CONFIG.ambient?.srcs ?? []).filter(Boolean);
  const counts = new Map();
  for (const s of srcs) counts.set(s, (counts.get(s) ?? 0) + 1);
  const dupes = [...counts].filter(([, n]) => n > 1);
  if (dupes.length) fail(`the ambient bed repeats ${dupes.map(([s, n]) => `${s.split('/').pop()} x${n}`).join(', ')}`);
  else pass(`the ambient bed is ${srcs.length} distinct clips`);
}

// --- 4. the same audio under two filenames ----------------------------------
{
  const byHash = new Map();
  for (const file of readdirSync(SFX_DIR)) {
    if (!/\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(file)) continue;
    const hash = createHash('md5').update(readFileSync(join(SFX_DIR, file))).digest('hex');
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(file);
  }
  const clones = [...byHash.values()].filter((names) => names.length > 1);
  if (clones.length) {
    for (const names of clones) {
      const kb = (statSync(join(SFX_DIR, names[0])).size / 1024).toFixed(0);
      fail(`identical audio under ${names.length} names (${kb}KB each) — ${names.join(', ')}`);
    }
  } else pass(`every file in public/sfx is a distinct recording (${byHash.size} files)`);
}

console.log(failures ? `\n  ${failures} failure(s)\n` : '\n  sfx dupes: all good\n');
process.exit(failures ? 1 : 0);
