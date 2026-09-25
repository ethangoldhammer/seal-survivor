#!/usr/bin/env node
// ============================================================================
// THE MARKUP FILES HAVE TO BE IN THE RIGHT ORDER — npm run test:rmlorder
//
// The Rive CLI scans `*.rml` alphabetically and compiles them "as one
// document". On the WEB runtime, a markup file sorted BEFORE the one holding
// the <ScriptedLayout> kills every Luau script in the build: the console says
// `ScriptAsset doesn't have a generator function <name>`, the artboard draws
// its background fill, and nothing else happens.
//
// It only bites when the file also contains a WGSL shader, which is why
// nothing local catches it. The CLI viewer plays the same build perfectly,
// `--verify` passes with zero errors, and `--publish` signs it happily. The
// first sign is a black screen in a browser, and the error names a script, so
// the hunt starts in the wrong file entirely — which cost most of a night.
//
// rive/sealitaire's `cards.rml` was exactly this. It is `table-cards.rml`
// now, and this test is here so the next .rml nobody thinks twice about —
// `art.rml`, `back.rml`, `cards.rml` again — fails here instead of silently
// on the web.
// ============================================================================
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const fail = (m, hint) => { failures++; console.error(`  FAIL ${m}${hint ? `\n       ${hint}` : ''}`); };
const ok = (m) => console.log(`  ok   ${m}`);

// Every Rive CLI project in the repo, not just Sealitaire: blubberball has no
// scripts today and the rule costs it nothing, but a script added there later
// should not have to rediscover this.
const projects = readdirSync(join(ROOT, 'rive'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => join(ROOT, 'rive', d.name));

for (const dir of projects) {
  const rels = readdirSync(dir).filter((f) => f.endsWith('.rml')).sort();
  if (rels.length < 2) continue;
  // Which file holds the ScriptedLayout / ScriptedDrawable — the one whose
  // scripts die if anything sorts ahead of it.
  const scripted = rels.filter((f) => /<Scripted[A-Za-z]*\b/.test(readFileSync(join(dir, f), 'utf8')));
  if (scripted.length === 0) continue;
  const name = dir.split('/').pop();
  for (const holder of scripted) {
    const ahead = rels.filter((f) => f < holder);
    if (ahead.length) {
      fail(
        `rive/${name}: ${ahead.join(', ')} sort${ahead.length === 1 ? 's' : ''} before ${holder}, which holds the script`,
        `rename so ${holder} comes first alphabetically — on the web every Luau script in this build will be dead`,
      );
    } else {
      ok(`rive/${name}: ${holder} sorts first of ${rels.length} markup files`);
    }
  }
}

// EVERY require() HAS TO NAME A DECLARED <ScriptAsset>. The CLI viewer finds
// an undeclared .luau on disk and runs it happily; the web runtime only has
// the scripts the markup declares, so the require throws at load and the
// script that asked for it is the one reported dead — `ScriptAsset doesn't
// have a generator function table` — with nothing pointing at the module.
// cascade.luau shipped exactly like this on 2026-09-25 and blanked the table.
for (const dir of projects) {
  const name = dir.split('/').pop();
  const rml = readdirSync(dir).filter((f) => f.endsWith('.rml'))
    .map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  const declared = new Set([...rml.matchAll(/<ScriptAsset\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1]));
  const luau = readdirSync(dir).filter((f) => f.endsWith('.luau'));
  if (!luau.length) continue;
  let missing = 0;
  for (const f of luau) {
    const src = readFileSync(join(dir, f), 'utf8').replace(/--.*$/gm, '');
    for (const [, mod] of src.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (declared.has(mod)) continue;
      missing++;
      fail(
        `rive/${name}: ${f} requires '${mod}', which no <ScriptAsset> declares`,
        `add <ScriptAsset file="${mod}.luau" isModule="true" name="${mod}" id="…"/> beside the others — on the web the require fails and ${f.replace(/\.luau$/, '')} never loads`,
      );
    }
  }
  if (!missing) ok(`rive/${name}: every require() names a declared ScriptAsset`);
}

// THE SHIPPED .riv HAS TO FIT CLOUDFLARE PAGES, which refuses any file over
// 25 MiB — and it refuses in the deploy step, after the push, so every test is
// green and the site simply keeps its last build. fish.mesh's lab bake
// (`npm run sealitaire:pool`) is 29 MB on its own; the ship bake is
// `npm run sealitaire:fish`. Four deploys died on this before it was noticed.
const PAGES_MAX = 25 * 1024 * 1024;
for (const dir of projects) {
  const name = dir.split('/').pop();
  const riv = join(ROOT, 'public', `${name}.riv`);
  let size;
  try { size = statSync(riv).size; } catch { continue; }
  const mb = (size / 1048576).toFixed(1);
  if (size > PAGES_MAX) {
    fail(`public/${name}.riv is ${mb} MiB — Cloudflare Pages rejects files over 25 MiB`,
      name === 'sealitaire' ? 'rebake fish.mesh with `npm run sealitaire:fish` (not --pool), then `npm run sealitaire:ship`' : 'shrink its embedded assets');
  } else {
    ok(`public/${name}.riv is ${mb} MiB, under the 25 MiB Pages limit`);
  }
}

console.log('');
if (failures) {
  console.error(`rml order: ${failures} problem${failures === 1 ? '' : 's'}`);
  process.exit(1);
}
console.log('rml order: every scripted markup file sorts first');
