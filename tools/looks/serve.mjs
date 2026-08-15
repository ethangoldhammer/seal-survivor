// Static server for a look page, plus a drop box for the frames it renders.
//
//   node tools/looks/serve.mjs <builtDir> [--out <dir>] [--port 4600]
//
// A look page is a vite BUILD (see tools/looks/vite.*.config.mjs), not a dev
// server, and this is what puts it on an http origin — file:// never executes a
// module and the Browser pane will not load 127.0.0.1. It serves the build
// read-only alongside public/models and public/textures, and it never imports
// config.js, so nothing it does can reach imported-tuning.json.
//
// The /shot endpoint is the important half. The Browser pane's own screenshot
// goes blank or times out on a tall contact sheet, so each cell POSTs its
// canvas here as a PNG and the frames are read off disk instead.
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '../..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : fallback;
};
const ROOT = resolve(argv.find((a) => !a.startsWith('--')) ?? '.');
const SHOTS = resolve(flag('--out', join(ROOT, 'shots')));
const PORT = Number(flag('--port', 4600));
await mkdir(SHOTS, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.fbx': 'application/octet-stream',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.riv': 'application/octet-stream', '.wasm': 'application/wasm',
};

// The build first, so a page that bundled its own copy of something wins; then
// the two public directories the models actually live in. `normalize` plus the
// startsWith check is what stops ../ walking out of a mount.
const MOUNTS = [
  ['/models/', join(PROJECT, 'public/models')],
  ['/textures/', join(PROJECT, 'public/textures')],
  ['/sprites/', join(PROJECT, 'public/sprites')],
  ['/', ROOT],
];

function resolveSafe(urlPath) {
  for (const [prefix, dir] of MOUNTS) {
    if (!urlPath.startsWith(prefix)) continue;
    const rel = urlPath.slice(prefix.length);
    const full = normalize(join(dir, rel || '.'));
    if (!full.startsWith(dir)) return null;
    return full;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.pathname.startsWith('/shot/')) {
    const name = url.pathname.slice('/shot/'.length).replace(/[^\w.-]/g, '');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    await writeFile(join(SHOTS, name), body);
    res.writeHead(200).end('ok');
    console.log(`  wrote ${name} (${(body.length / 1024).toFixed(0)} KB)`);
    return;
  }

  const file = resolveSafe(decodeURIComponent(url.pathname));
  if (!file) { res.writeHead(404).end('no'); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('no');
  }
});

// localhost and not 127.0.0.1 — see the note in the header.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`looks: http://localhost:${PORT}/  (root ${ROOT})`);
  console.log(`shots: ${SHOTS}`);
});
