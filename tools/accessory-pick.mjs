#!/usr/bin/env node
// ============================================================================
// ACCESSORY PICKER — choose the angle for each tile in the drawer.
//
//   npm run accessories:pick
//   then open http://localhost:4602/picker.html?list=accessory-icons.json
//
// The same picker and the same renderer as the upgrade icons, pointed at a
// third spec list: drag to orbit, save the numbers, shoot the PNG, apply. What
// comes out is path/src/ui/accessoryIcons.js, which the drawer reads instead of
// its coloured lozenges.
//
// A SERVER OF ITS OWN, on a port that never moves, for the reason
// tools/design-pick.mjs has one: the panel (tools/servers.mjs) identifies a
// tool by its process, and two jobs in one process is one row that cannot say
// which of them you are using. 4599 is the upgrade picker's, 4601 the design
// one's, and this is 4602 — all three can be up at once.
//
// --bake-with accessories IS THE IMPORTANT ARGUMENT. Without it the apply
// button on this page would run the UPGRADE bake, which is what it did on every
// picker before this change; see the note by BAKERS in the server.
//
// It REGENERATES THE SPEC FIRST, every time, so a picker can never show you a
// hat framed down an axis assets.js stopped using — and so an accessory added
// to config.js since the last run is simply there.
//
// WHAT IT MAY WRITE: tools/atlas-render/accessory-icons.json (the angles), PNGs
// under tools/atlas-render/shots/accessories, and — on apply —
// path/src/ui/accessoryIcons.js. It never runs the game and never loads the
// tuning, so it cannot touch imported-tuning.json.
// ============================================================================
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const PORT = 4602;
const LIST = 'accessory-icons.json';
// Beside the upgrade icons' shots rather than in a scratch directory: these are
// small, there are eight of them, and the bake is strict — which means the
// ordinary flow (shoot one, apply) needs the other seven still on disk.
const SHOTS = join(ROOT, 'tools/atlas-render/shots/accessories');

const gen = spawn(process.execPath,
  ['--import', './tools/vite-loader.mjs', 'tools/accessory-icons.mjs'],
  { cwd: ROOT, stdio: 'inherit' });

gen.on('exit', (code) => {
  if (code !== 0) {
    console.error('\nthe spec generator failed — not starting the server');
    process.exit(code ?? 1);
  }
  // BUILT, not raw. The tiles wear the game's own biolumSkin now, and
  // biolumSkin.js imports config.js and a `?raw` CSV — neither of which a file
  // server can hand a browser. tools/looks/vite.picker.config.mjs bundles the
  // picker for exactly this, and --built points the server at the result while
  // leaving this directory mounted behind it so the spec list and the shots
  // still answer on the URLs they always did.
  const build = spawnSync('npx', [
    'vite', 'build', '--config', 'tools/looks/vite.picker.config.mjs',
  ], { cwd: ROOT, stdio: 'inherit' });
  if (build.status !== 0) {
    console.error('\nthe picker build failed — not starting the server');
    process.exit(build.status ?? 1);
  }
  const server = spawn(process.execPath, [
    'tools/atlas-render/server.mjs',
    '--port', String(PORT),
    '--out', SHOTS,
    '--list', LIST,
    '--bake-with', 'accessories',
    '--built', 'dist-picker',
  ], { cwd: ROOT, stdio: 'inherit' });
  server.on('exit', (c) => process.exit(c ?? 0));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.kill(sig));
});
