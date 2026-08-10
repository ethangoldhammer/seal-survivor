// Static server for the atlas renderer, plus a drop box for the images it makes.
//
//   node tools/atlas-render/server.mjs [--out <dir>]
//   then open http://localhost:4599/render.html in a real browser
//
// Renders every model in `list.json` (see the Model Atlas notes for how that is
// generated from the atlas data) and POSTs each PNG back here. The browser is
// doing the work because these need real WebGL; Node has none.
//
// Deliberately NOT the project's dev server: it serves three.js, public/models
// and public/textures read-only and never imports config.js, so nothing here
// can touch imported-tuning.json. Writes go only into this scratchpad.
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from this file rather than hardcoded, so it keeps working outside
// the session that wrote it. `--out` puts the PNGs somewhere else (a scratch
// directory) when you do not want them in the repo.
const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '../..');
const outArg = process.argv.indexOf('--out');
const SHOTS = outArg > -1 ? resolve(process.argv[outArg + 1]) : join(HERE, 'shots');
await mkdir(SHOTS, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.fbx': 'application/octet-stream',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
};

// Prefix -> directory. Anything outside these is a 404, and `normalize` plus the
// startsWith check below stops ../ from walking out of them.
const MOUNTS = [
  ['/three/', join(PROJECT, 'node_modules/three')],
  ['/models/', join(PROJECT, 'public/models')],
  ['/textures/', join(PROJECT, 'public/textures')],
  ['/', HERE],
];

function resolveSafe(urlPath) {
  for (const [prefix, dir] of MOUNTS) {
    if (!urlPath.startsWith(prefix)) continue;
    const rel = urlPath.slice(prefix.length) || 'render.html';
    const full = normalize(join(dir, rel));
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
    await writeFile(join(SHOTS, name), Buffer.concat(chunks));
    res.writeHead(200).end('ok');
    console.log(`  wrote ${name} (${Buffer.concat(chunks).length} bytes)`);
    return;
  }

  const file = resolveSafe(decodeURIComponent(url.pathname));
  if (!file) { res.writeHead(404).end('no'); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'access-control-allow-origin': '*',
    }).end(body);
  } catch {
    res.writeHead(404).end('missing');
  }
});

server.listen(4599, () => {
  console.log('atlas renderer on http://localhost:4599/render.html');
  console.log(`writing shots to ${SHOTS}`);
});
