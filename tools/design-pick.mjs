#!/usr/bin/env node
// ============================================================================
// DESIGN PICKER — choose the angle for a model shot that goes in a document.
//
//   npm run pick
//   then open http://localhost:4601/picker.html?list=design-icons.json
//
// The same picker and the same renderer as the upgrade icons, pointed at a
// different spec list: drag to orbit, scrub the pose, save the numbers, shoot
// the PNG. What comes out is art for a one-pager, a slide or a poster — it is
// never baked into the game.
//
// A SERVER OF ITS OWN, on a port that never moves, for the reason the hub has
// one: a tool you reach by remembering a port and a query string is a tool you
// stop using. This one is in `npm run servers` beside the CSV editor, so the
// panel can tell you it is already running — which is the failure this
// replaced, an `icons:pick` that appeared to be broken because something else
// was already holding 4599 and quietly serving the wrong list.
//
// It REGENERATES THE SPEC FIRST, every time. tools/design-icons.mjs re-derives
// the structural half of each spec from the asset table and keeps the angles
// you chose, so starting the picker can never show you a shot framed down an
// axis the game stopped using.
//
// WHAT IT MAY WRITE: tools/atlas-render/design-icons.json (the angles) and
// PNGs under design/shots — and nothing in the game, which is now enforced
// rather than warned about. See --bake-with below.
//
// It never runs the game and never loads config.js, so it cannot touch
// imported-tuning.json.
// ============================================================================
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// Fixed, and deliberately not 4599: the upgrade-icon picker owns that one, and
// the whole point of this file is that both can be up at once.
const PORT = 4601;
const LIST = 'design-icons.json';
const SHOTS = join(ROOT, 'design/shots');

// The spec generator imports path/src/assets.js, which is Vite-flavoured — the
// same loader every other tool that reads the asset table goes through.
const gen = spawn(process.execPath,
  ['--import', './tools/vite-loader.mjs', 'tools/design-icons.mjs'],
  { cwd: ROOT, stdio: 'inherit' });

gen.on('exit', (code) => {
  if (code !== 0) {
    console.error('\nthe spec generator failed — not starting the server');
    process.exit(code ?? 1);
  }
  // --bake-with none, and it is a fix rather than a setting. This page's
  // "apply to the game" ran the UPGRADE bake — the server's own banner used to
  // warn about it — so a design shot applied here overwrote the hive's icons
  // with whatever PNGs happened to be in design/shots. There is nothing in the
  // game for these to become, so the button now says that.
  const server = spawn(process.execPath, [
    'tools/atlas-render/server.mjs',
    '--port', String(PORT), '--out', SHOTS, '--list', LIST,
    '--bake-with', 'none',
  ], { cwd: ROOT, stdio: 'inherit' });
  server.on('exit', (c) => process.exit(c ?? 0));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.kill(sig));
});
