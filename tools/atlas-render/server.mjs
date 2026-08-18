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
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
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
  // The DRAWN art, for icons that should be a picture rather than a render.
  // public/sprites already holds the five starfish, which are better icons than
  // any render of them — the ability throws a drawing, not a mesh.
  ['/sprites/', join(PROJECT, 'public/sprites')],
  ['/', HERE],
];

// Where the picker puts an uploaded icon. Inside this directory rather than in
// public/ so an experiment cannot end up in the game's asset folder by accident;
// `--bake` reads it back from here.
const CUSTOM = join(HERE, 'custom');
await mkdir(CUSTOM, { recursive: true });

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

  // A drawn icon uploaded through the picker.
  //
  // Extension-checked, not sniffed: this only ever writes into `custom/` and the
  // only consumer is a data: URI in a generated module, so the question is not
  // "is this really a webp" but "is this something a browser will render". A
  // wrong extension shows up immediately as a broken preview in the picker.
  if (req.method === 'POST' && url.pathname.startsWith('/custom/')) {
    const name = url.pathname.slice('/custom/'.length).replace(/[^\w.-]/g, '');
    if (!/\.(webp|png|jpe?g)$/i.test(name)) {
      res.writeHead(400).end('webp, png or jpg only');
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    await writeFile(join(CUSTOM, name), body);
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ path: `custom/${name}`, bytes: body.length }));
    console.log(`  wrote custom/${name} (${body.length} bytes)`);
    return;
  }

  // The picker saving the angles it just chose.
  //
  // Writes NEXT TO THIS PAGE rather than into the shots directory: a spec list
  // is source, not output, and `--out` points at a scratch folder that gets
  // wiped. `[^\w.-]` stripping plus the .json requirement keeps this to a
  // filename in this one directory — it cannot be walked out of with ../ and it
  // cannot be aimed at a .js or a .html.
  if (req.method === 'POST' && url.pathname.startsWith('/spec/')) {
    const name = url.pathname.slice('/spec/'.length).replace(/[^\w.-]/g, '');
    if (!name.endsWith('.json')) { res.writeHead(400).end('json only'); return; }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    // Parsed before it is written. A truncated POST would otherwise land as a
    // spec file that every later run fails to read — and render.html's own
    // error path would then blame the generator for a file the picker broke.
    try { JSON.parse(body.toString()); } catch (err) {
      res.writeHead(400).end('not valid json: ' + err.message);
      return;
    }

    // THE WHOLE LIST IS POSTED, so a save is a full overwrite — which makes a
    // stale tab a data-loss weapon. A picker opened before someone else's edits
    // (or before a generator run) holds a snapshot from then; saving it would
    // silently revert every angle and colour chosen in between, with no error
    // and nothing to notice until the next render came back wrong.
    //
    // So the picker sends the mtime it loaded, and a file that has moved since
    // is a 409 rather than an overwrite. Same rule the CSV editor follows for
    // the same reason. `?force=1` is the deliberate escape hatch.
    const target = join(HERE, name);
    const seen = url.searchParams.get('since');
    if (seen && url.searchParams.get('force') !== '1') {
      const now = await stat(target).then((s) => String(s.mtimeMs)).catch(() => null);
      if (now && now !== seen) {
        res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({
          error: 'changed on disk since this page loaded',
          mtime: now,
        }));
        console.log(`  REFUSED stale save of ${name} (loaded ${seen}, on disk ${now})`);
        return;
      }
    }

    await writeFile(target, body);
    const after = await stat(target).then((s) => String(s.mtimeMs)).catch(() => null);
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ok: true, mtime: after }));
    console.log(`  wrote spec ${name} (${body.length} bytes)`);
    return;
  }

  const file = resolveSafe(decodeURIComponent(url.pathname));
  if (!file) { res.writeHead(404).end('no'); return; }
  try {
    const body = await readFile(file);
    // The mtime rides along on every response. The picker keeps the one it got
    // with the spec list and hands it back on save, which is what lets the
    // conflict check above tell "nothing moved" from "someone else saved".
    const mtime = await stat(file).then((st) => String(st.mtimeMs)).catch(() => '');
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'x-mtime',
      ...(mtime ? { 'x-mtime': mtime } : {}),
    }).end(body);
  } catch {
    res.writeHead(404).end('missing');
  }
});

server.listen(4599, () => {
  console.log('atlas renderer on http://localhost:4599/render.html');
  console.log(`writing shots to ${SHOTS}`);
});
