#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:accessoryicons
//
// THE TILE PIPELINE — tools/accessory-icons.mjs, the picker's baker registry,
// and the drawer that reads what comes out.
//
// What this exists to catch is a pipeline that quietly stops covering the
// roster. Every failure here is silent by nature: an accessory added to
// config.js with no spec is a lozenge, which is also what a correctly-unshot
// accessory looks like; a bake pointed at the wrong list writes the wrong
// module and says "baked 8 icons" either way; and a picker whose apply button
// runs somebody else's baker overwrites a file nobody was looking at.
//
// Five sections:
//
//   THE ROSTER   every accessory in CONFIG has a spec, and every spec is an
//                accessory. This is the half that makes "add an accessory and
//                the icons follow" true rather than a habit.
//   THE SPEC     the structural fields are the ASSET TABLE's, not a copy. A
//                tile shot down a different basis than the game orients the
//                model by is a picture of a different hat, and the only way to
//                know is to compare the two.
//   THE BAKE     a foreign key cannot reach the drawer's module, and --strict
//                writes NOTHING rather than a module with holes in it. Both are
//                proved by running the real bake against a fixture.
//   THE BAKERS   every --bake-with name in the server resolves to a tool that
//                exists, and every picker names one. This is the check that
//                would have caught the bug this system was built with: the
//                design picker's apply button baking the UPGRADE icons.
//   THE DRAWER   a baked tile is used, and an accessory without one falls back
//                to its lozenge rather than to an empty box.
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SPEC = join(ROOT, 'tools/atlas-render/accessory-icons.json');
const MODULE = join(ROOT, 'path/src/ui/accessoryIcons.js');

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// jsdom BEFORE the loader hooks, per the harness recipe — importing the vite
// loader first breaks the CJS chain jsdom itself loads through.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.PointerEvent = dom.window.PointerEvent ?? dom.window.MouseEvent;

await import('./vite-loader.mjs');
const { CONFIG } = await import('../path/src/config.js');
const { ASSETS } = await import('../path/src/assets.js');
const { ACCESSORY_ICONS } = await import('../path/src/ui/accessoryIcons.js');
const { mountAccessoryDrawer } = await import('../path/src/ui/accessoryDrawer.js');

const roster = Object.keys(CONFIG.accessories.items);
const specs = JSON.parse(await readFile(SPEC, 'utf8'));
const specBy = new Map(specs.map((s) => [s.key, s]));

// ---------------------------------------------------------------------------
section('THE ROSTER');
// ---------------------------------------------------------------------------
check('there are accessories to make tiles for', roster.length > 0, `${roster.length}`);
for (const key of roster) {
  check(`${key} has a spec`, specBy.has(key));
}
for (const s of specs) {
  check(`the spec "${s.key}" is an accessory`, roster.includes(s.key));
}
check('the spec list is in the drawer’s order',
  specs.map((s) => s.key).join() === roster.join());

// ---------------------------------------------------------------------------
section('THE SPEC');
// ---------------------------------------------------------------------------
// DERIVED, not typed. A stale `forward` here is a tile of the hat lying on its
// side, and the only thing that can tell you is the asset table it came from.
for (const key of roster) {
  const spec = specBy.get(key);
  const def = ASSETS[key];
  if (!spec || !def) continue;
  const file = def.model?.replace(/^\/models\//, '');
  if (!file) {
    check(`${key} has no model, so its spec says so`, spec.kind === 'none', spec.kind);
    continue;
  }
  check(`${key} names the asset table’s file`, spec.file === file, `${spec.file} vs ${file}`);
  check(`${key} is shot down the asset table’s axes`,
    spec.forward === (def.forward ?? '+Z') && spec.up === (def.up ?? '+Y'),
    `${spec.forward}/${spec.up}`);
  check(`${key} names a model that is on disk`,
    existsSync(join(ROOT, 'public/models', file)));
}

// ---------------------------------------------------------------------------
section('THE BAKE');
// ---------------------------------------------------------------------------
const tmp = await mkdtemp(join(tmpdir(), 'acc-icons-'));
const fixtureList = join(tmp, 'list.json');
const fixtureModule = join(tmp, 'out.js');
const bake = (args) => run(process.execPath,
  ['--import', './tools/vite-loader.mjs', 'tools/accessory-icons.mjs', ...args],
  { cwd: ROOT, maxBuffer: 1 << 24 });

// A one-pixel PNG, so the fixture can have a real file to embed without this
// test depending on anything having been rendered.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

// THE GUARD: a key that is not an accessory must not reach the module, even
// when the list says to bake it. This is the mirror of the upgrade bake's own
// check and it is the reason three spec lists can share one picker safely.
{
  const real = roster[0];
  await writeFile(fixtureList, JSON.stringify([
    { key: real, kind: 'render' },
    { key: 'shrimpRing', kind: 'render' },       // an UPGRADE id
    { key: 'notAnything', kind: 'render' },
  ]));
  await writeFile(join(tmp, `${real}.png`), PIXEL);
  await writeFile(join(tmp, 'shrimpRing.png'), PIXEL);
  await writeFile(join(tmp, 'notAnything.png'), PIXEL);
  const { stdout } = await bake(['--bake', tmp, '--list', fixtureList, '--module', fixtureModule]);
  const out = await readFile(fixtureModule, 'utf8');
  check('an accessory in the list is baked', out.includes(`'${real}'`));
  check('an UPGRADE id in the list is not', !out.includes('shrimpRing'),
    'it would become a tile for something the drawer cannot equip');
  check('a key nothing declares is not', !out.includes('notAnything'));
  check('...and it says which it skipped rather than dropping them quietly',
    /skipped shrimpRing/.test(stdout) && /skipped notAnything/.test(stdout));
}

// --strict: NOTHING IS WRITTEN when a named PNG is absent. The failure this
// guards is not "one tile is stale" — a bake is a full overwrite of the module
// and the shots directory is scratch, so it is every OTHER tile deleted.
{
  const before = await readFile(fixtureModule, 'utf8');
  const beforeAt = (await stat(fixtureModule)).mtimeMs;
  await writeFile(fixtureList, JSON.stringify([
    { key: roster[0], kind: 'render' },
    { key: roster[1], kind: 'render' },          // no PNG for this one
  ]));
  let refused = false; let code = null; let said = '';
  try {
    await bake(['--bake', tmp, '--list', fixtureList, '--module', fixtureModule, '--strict']);
  } catch (err) {
    refused = true; code = err.code; said = `${err.stderr ?? ''}`;
  }
  check('--strict refuses when a named tile has no PNG', refused);
  check('...with exit 2, which is what the picker reads to offer "apply anyway"', code === 2);
  check('...naming the one that is missing', said.includes(roster[1]));
  check('...and the module is untouched, not half-written',
    (await readFile(fixtureModule, 'utf8')) === before
    && (await stat(fixtureModule)).mtimeMs === beforeAt);

  // And without --strict it goes ahead, which is the other half of the choice.
  await bake(['--bake', tmp, '--list', fixtureList, '--module', fixtureModule]);
  const out = await readFile(fixtureModule, 'utf8');
  check('without --strict the tiles that ARE there still bake',
    out.includes(`'${roster[0]}'`) && !out.includes(`'${roster[1]}'`));
}
await rm(tmp, { recursive: true, force: true });

// ---------------------------------------------------------------------------
section('THE BAKERS');
// ---------------------------------------------------------------------------
// The registry in the render server, read as TEXT. It cannot be imported —
// server.mjs binds a port at module load — and the thing being checked is a
// table of paths, which text is enough to see.
const serverSrc = await readFile(join(ROOT, 'tools/atlas-render/server.mjs'), 'utf8');
const bakerBlock = serverSrc.slice(serverSrc.indexOf('const BAKERS = {'));
const tools = [...bakerBlock.matchAll(/tool:\s*'([^']+)'/g)].map((m) => m[1]);
check('the server declares bakers', tools.length >= 2, tools.join(', '));
for (const t of tools) check(`${t} exists`, existsSync(join(ROOT, t)));
check('the accessory baker is one of them', tools.includes('tools/accessory-icons.mjs'));

// EVERY PICKER NAMES ITS OWN. This is the check that would have caught the bug
// the registry was added for: before it, the design picker's "apply to the
// game" ran the UPGRADE bake, because the bake was hardcoded and the banner
// merely apologised for it.
for (const [file, want] of [
  ['tools/accessory-pick.mjs', 'accessories'],
  ['tools/design-pick.mjs', 'none'],
]) {
  const src = await readFile(join(ROOT, file), 'utf8');
  const m = src.match(/'--bake-with',\s*\n?\s*'([^']+)'/);
  check(`${file} says what it bakes`, !!m, m?.[1]);
  check(`...and it is "${want}"`, m?.[1] === want, m?.[1]);
}
// An unrecognised name is refused at startup rather than at the button.
check('an unknown --bake-with is refused', /is not one of/.test(serverSrc));

// ---------------------------------------------------------------------------
section('THE DRAWER');
// ---------------------------------------------------------------------------
const parent = document.createElement('div');
document.body.appendChild(parent);
mountAccessoryDrawer({ parent, sealRect: () => ({ x: 400, y: 240, r: 90 }) });
const swatchFor = (key) => [...parent.querySelectorAll('.sv-acc-tile')]
  .find((t) => t.dataset.key === key)?.querySelector('.sv-acc-swatch');

const shot = roster.find((k) => ACCESSORY_ICONS[k]);
if (shot) {
  const sw = swatchFor(shot);
  check(`${shot} shows its baked render`, /^data:image\//.test(ACCESSORY_ICONS[shot])
    && (sw?.style.background ?? '').includes('data:image/'));
  check('...and the tile grows to hold a picture', sw?.classList.contains('shot'));
} else {
  // Nothing baked yet is a real state — a fresh checkout — and the drawer is
  // correct in it. Say so rather than passing a check that ran on nothing.
  console.log('  ..    no tiles are baked, so there is nothing to check here');
}

// THE FALLBACK, proved by taking one away rather than by hoping one is missing.
// An accessory with no render must be a lozenge — that is what every tile was
// before this pipeline existed, and what a newly imported one is until somebody
// shoots it.
{
  const key = roster.at(-1);
  const kept = ACCESSORY_ICONS[key];
  delete ACCESSORY_ICONS[key];
  const p2 = document.createElement('div');
  document.body.appendChild(p2);
  mountAccessoryDrawer({ parent: p2, sealRect: () => ({ x: 0, y: 0, r: 1 }) });
  const sw = [...p2.querySelectorAll('.sv-acc-tile')]
    .find((t) => t.dataset.key === key)?.querySelector('.sv-acc-swatch');
  const bg = sw?.style.background ?? '';
  check(`${key} with no render falls back to a lozenge`, bg.includes('gradient'), bg.slice(0, 40));
  check('...and does not claim the taller picture row', !sw?.classList.contains('shot'));
  if (kept) ACCESSORY_ICONS[key] = kept;
}
// The bare seal is the one tile that can never have a render.
check('the bare-seal tile is a lozenge by nature',
  (swatchFor('')?.style.background ?? '').includes('gradient'));

console.log(failures === 0 ? '\nall good\n' : `\n${failures} failing\n`);
process.exit(failures === 0 ? 0 : 1);
