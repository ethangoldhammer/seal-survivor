// Static server for a look page, plus a drop box for the frames it renders.
//
//   node tools/looks/serve.mjs <builtDir> [--out <dir>] [--port 4600]
//
// A look page is a vite BUILD (see tools/looks/vite.*.config.mjs), not a dev
// server, and this is what puts it on an http origin — file:// never executes a
// module and the Browser pane will not load 127.0.0.1. It serves the build
// read-only alongside public/models, public/textures and public/flags, and it
// never imports
// config.js, so nothing it does can reach imported-tuning.json.
//
// The /shot endpoint is the important half. The Browser pane's own screenshot
// goes blank or times out on a tall contact sheet, so each cell POSTs its
// canvas here as a PNG and the frames are read off disk instead.
import http from 'node:http';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyRecorded } from '../apply-shaders.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '../..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : fallback;
};
const ROOT = resolve(argv.find((a) => !a.startsWith('--')) ?? '.');
const SHOTS = resolve(flag('--out', join(ROOT, 'shots')));

// Writes into the drop box, RE-CREATING IT FIRST.
//
// The out dir usually lives inside the built directory, and every `vite build`
// runs with emptyOutDir — so a rebuild while this server is up deletes the box
// from under it. Without the mkdir the next POST throws ENOENT and takes the
// whole server down, which presents as the page's save button failing for no
// visible reason several minutes after the thing that actually caused it.
async function drop(name, body) {
  await mkdir(SHOTS, { recursive: true });
  await writeFile(join(SHOTS, name), body);
}
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
  // The pre-shrink copies, for tools/looks/shrunk.js's before/after. Absent in
  // the normal case and harmless when it is — a page that does not ask for one
  // never notices, and the directory is deleted once the comparison has been
  // looked at.
  ['/models-orig/', join(PROJECT, 'public/models-orig')],
  ['/textures/', join(PROJECT, 'public/textures')],
  ['/sprites/', join(PROJECT, 'public/sprites')],
  ['/flags/', join(PROJECT, 'public/flags')],
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

  // A look page saving the numbers it just chose. This server never imports
  // config.js, so a saved preset is a file for a human to move across, not a
  // write into the game's tuning. See SERVERS.md.
  //
  // NOT THE SHOTS DIR, and that is the whole reason "apply" never reached the
  // game. The drop box lives inside the vite outDir, and every look script runs
  // `vite build` with emptyOutDir before starting this server — so
  // `npm run looks:shaderlab` DELETED the choices the last session had applied,
  // before anyone could run the tool that reads them. The file was gone by the
  // time you went looking for it, and nothing said so.
  //
  // Saved beside the page instead, where it is tracked in git, survives a
  // rebuild, and shows up in a diff when it changes.
  if (req.method === 'POST' && url.pathname.startsWith('/shader/')) {
    const name = url.pathname.slice('/shader/'.length).replace(/[^\w.-]/g, '');
    if (!name.endsWith('.json')) { res.writeHead(400).end('json only'); return; }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    try { JSON.parse(body.toString()); } catch (err) {
      res.writeHead(400).end('not valid json: ' + err.message); return;
    }
    await mkdir(HERE, { recursive: true });
    await writeFile(join(HERE, name), body);
    console.log(`  wrote tools/looks/${name} (${body.length} bytes)`);

    // ...and straight on into the game, which is the whole point of the button.
    //
    // Recording used to stop at this file and rely on someone remembering to run
    // `npm run shaders:apply`. Nothing said so, so a choice made in the lab
    // simply never appeared in the game and the button looked broken.
    //
    // This is the SAME code the CLI runs (tools/apply-shaders.mjs), imported
    // rather than shelled out to, so there is one implementation of what
    // "apply" means. It reads config.js as TEXT and never imports it, so this
    // server still cannot reach imported-tuning.json — see the header.
    let report = null;
    try {
      report = await applyRecorded(JSON.parse(body.toString()), { dry: false });
      if (report.rows.length) console.log(`  assets.csv: ${report.rows.join('; ')}`);
      if (report.presets.length) console.log(`  config.js: +${report.presets.join(', ')}`);
      if (report.rims?.length) console.log(`  assets.js: ${report.rims.join(', ')}`);
      for (const n of report.notes) console.log(`  ${n}`);
    } catch (err) {
      console.log(`  apply failed: ${err.message}`);
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ saved: true, error: err.message }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ saved: true, ...report }));
    return;
  }

  // ...and reading it back, which is what stops the page clobbering its own
  // history. `applied` lives in the page's memory and starts empty, so a save
  // wrote a file containing ONLY the creatures recorded since the last reload —
  // recording an orca on Tuesday silently dropped Monday's shark. The page seeds
  // itself from this on boot instead. Served from beside the page rather than
  // through the static mounts, because the file deliberately lives outside the
  // built directory those serve.
  if (req.method === 'GET' && url.pathname.startsWith('/shader/')) {
    const name = url.pathname.slice('/shader/'.length).replace(/[^\w.-]/g, '');
    if (!name.endsWith('.json')) { res.writeHead(400).end('json only'); return; }
    try {
      const body = await readFile(join(HERE, name));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
    } catch {
      // Nothing recorded yet is the normal first run, not an error.
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    }
    return;
  }

  // A LOOK PAGE'S CHOSEN NUMBERS, saved and read back. The generic version of
  // the /shader/ pair above, minus the apply: this writes the file and stops
  // there, because most look pages tune a CONFIG block that no tool knows how
  // to splice. The page reads it back on boot, so a saved preset survives a
  // reload without anything being pasted anywhere; pasting it into config.js is
  // what makes it the game's default, and that stays a human's decision.
  //
  // BESIDE THE PAGE, not in the drop box — same reason as /shader/: the box
  // lives inside the vite outDir and every `npm run looks:*` empties it, so a
  // preset saved there is deleted by the next build with nothing to say so.
  // Here it is tracked in git and shows up in a diff.
  if (req.method === 'POST' && url.pathname.startsWith('/preset/')) {
    const name = url.pathname.slice('/preset/'.length).replace(/[^\w.-]/g, '');
    if (!name.endsWith('.json')) { res.writeHead(400).end('json only'); return; }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    try { JSON.parse(body.toString()); } catch (err) {
      res.writeHead(400).end('not valid json: ' + err.message); return;
    }
    await writeFile(join(HERE, name), body);
    console.log(`  wrote tools/looks/${name} (${body.length} bytes)`);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ saved: true }));
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/preset/')) {
    const name = url.pathname.slice('/preset/'.length).replace(/[^\w.-]/g, '');
    if (!name.endsWith('.json')) { res.writeHead(400).end('json only'); return; }
    // READ FIRST, THEN WRITE THE HEAD. Awaiting inside the `.end()` argument
    // sends the headers before the read is even attempted, so the miss — which
    // is the normal first run, with no preset saved yet — lands in the catch
    // with headers already gone, throws ERR_HTTP_HEADERS_SENT out of the
    // request handler, and takes the whole server down. It presents as the look
    // page dying at random on a reload.
    let body = '{}';
    try { body = await readFile(join(HERE, name)); } catch { /* nothing saved yet */ }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/shot/')) {
    const name = url.pathname.slice('/shot/'.length).replace(/[^\w.-]/g, '');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    await drop(name, body);
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

// THE PAGE, not the root. `vite build` keeps the input's path relative to the
// project root, so the built page is at /tools/looks/<name>.html and the root
// of this server is a directory listing nothing serves — a link to `/` 404s
// with "no", which reads exactly like the build having failed.
//
// So find what was actually built and print that. One line per page, absolute,
// clickable in a terminal and scrapeable by the workbench (tools/hub.mjs),
// which turns whatever a run prints into the link on its card.
async function builtPages() {
  const out = [];
  const walk = async (dir, prefix) => {
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'shots' || e.name === 'assets') continue;
      if (e.isDirectory()) await walk(join(dir, e.name), `${prefix}${e.name}/`);
      else if (e.name.endsWith('.html')) out.push(`${prefix}${e.name}`);
    }
  };
  await walk(ROOT, '/');
  return out;
}

async function announce(port) {
  const pages = await builtPages();
  if (pages.length) for (const page of pages) console.log(`looks: http://localhost:${port}${page}`);
  else console.log(`looks: http://localhost:${port}/  (root ${ROOT} — nothing built?)`);
  console.log(`shots: ${SHOTS}`);
}

// A SECOND LOOK PAGE MUST NOT KILL ITSELF ON THE FIRST ONE'S PORT.
//
// Every `looks:*` script calls this file with no --port, so they all want
// 4600. Opening a second look page while one is up used to die on EADDRINUSE
// before printing anything, which from the workbench looks like the build
// failing and from a terminal looks like nothing at all. Comparing two looks
// side by side is a normal thing to want, so take any free port instead and
// say which one — the address was never the interesting part, the link is.
//
// An explicitly requested --port is honoured strictly: if you asked for a
// number you have a reason, and silently landing somewhere else would be worse
// than failing.
const asked = argv.includes('--port');

// localhost and not 127.0.0.1 — see the note in the header.
server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE' || asked) {
    console.error(`looks: ${err.message}`);
    process.exit(1);
  }
  console.log(`looks: ${PORT} is taken — taking a free port instead`);
  server.listen(0, '127.0.0.1');
});
server.on('listening', () => announce(server.address().port));
server.listen(PORT, '127.0.0.1');
