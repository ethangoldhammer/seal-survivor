// Static server for the atlas renderer, plus a drop box for the images it makes.
//
//   node tools/atlas-render/server.mjs [--out <dir>] [--port <n>]
//   then open http://localhost:4599/render.html in a real browser
//
// `--port` exists so a SECOND picker can be up beside this one on a port of
// its own — see tools/design-pick.mjs, which serves the same pages against a
// different spec list. Two servers rather than one with two lists because the
// panel (tools/servers.mjs) identifies a tool by its process, and a single
// process serving two jobs is one row that cannot say which of them you are
// using.
//
// Renders every model in `list.json` (see the Model Atlas notes for how that is
// generated from the atlas data) and POSTs each PNG back here. The browser is
// doing the work because these need real WebGL; Node has none.
//
// Deliberately NOT the project's dev server: it serves three.js, public/models
// and public/textures read-only, and it never runs the game — so nothing here
// can touch imported-tuning.json.
//
// It does write three things, all of them generated and all of them named:
// the shot PNGs (into --out), the spec list next to this file, and — on /bake —
// path/src/ui/upgradeIcons.js, by shelling out to tools/upgrade-icons.mjs. That
// last one is what puts an icon in the game, and it runs the SAME bake the
// terminal does rather than a second copy of it; a button that embedded its own
// version of the round trip is a button that produces a different module from
// the one `npm run icons -- --bake` produces.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ICON_FORMATS, ICON_EXTS, isIconFile } from './icon-formats.mjs';

const run = promisify(execFile);

// Resolved from this file rather than hardcoded, so it keeps working outside
// the session that wrote it. `--out` puts the PNGs somewhere else (a scratch
// directory) when you do not want them in the repo.
const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '../..');
const outArg = process.argv.indexOf('--out');
const SHOTS = outArg > -1 ? resolve(process.argv[outArg + 1]) : join(HERE, 'shots');
const portArg = process.argv.indexOf('--port');
const PORT = portArg > -1 ? Number(process.argv[portArg + 1]) : 4599;
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`--port ${process.argv[portArg + 1]} is not a port`);
  process.exit(1);
}
// The spec list this server is FOR, used only to print a URL you can click.
// The pages take it as a query string, so nothing here has to understand it.
const listArg = process.argv.indexOf('--list');
const LIST = listArg > -1 ? process.argv[listArg + 1] : null;
await mkdir(SHOTS, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.fbx': 'application/octet-stream',
  // The image formats come from the shared list rather than being repeated,
  // so serving an uploaded icon back for the preview can never disagree with
  // the gate that accepted it. See icon-formats.mjs.
  ...ICON_FORMATS,
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
  // THE GAME'S OWN SOURCE, read-only, so a render can wear the shader the
  // player sees rather than an impression of it — path/src/systems/noiseGlsl.js
  // is the seal's mottling and is a leaf module with no imports, which is what
  // lets a plain browser load it. config.js could not be served this way: it
  // pulls in the tuning JSON and the CSVs through Vite.
  ['/src/', join(PROJECT, 'path/src')],
  // The hex card art, for the design hex picker (hexpick.html). Read-only like
  // every other mount here.
  ['/hexart/', join(PROJECT, 'design/assets')],
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
  // "is this really a webp" but "is this something a browser will render". The
  // list of those lives in icon-formats.mjs, shared with the bake. A
  // wrong extension shows up immediately as a broken preview in the picker.
  // The picker reads its file input's `accept` from here rather than hardcoding
  // one, which is the fourth copy of the format list removed.
  // WHAT HEX ART IS ON DISK. There is no directory listing anywhere else in
  // this server and there should not be one — but the hex picker's gallery IS
  // the contents of design/assets, and a hand-written list in the page would go
  // stale the first time art is added. So: one directory, one route, names
  // only.
  if (req.method === 'GET' && url.pathname === '/hexart.json') {
    const dir = join(PROJECT, 'design/assets');
    const names = await readdir(dir).catch(() => []);
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify(names.filter((n) => !n.startsWith('.'))));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/icon-formats.json') {
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ exts: ICON_EXTS }));
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/custom/')) {
    const name = url.pathname.slice('/custom/'.length).replace(/[^\w.-]/g, '');
    if (!isIconFile(name)) {
      res.writeHead(400).end(`${ICON_EXTS.join(', ')} only`);
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

  // APPLY: bake every shot in this server's output directory into the game's
  // icon module. `?strict=1` refuses to write when anything named by icons.json
  // is missing from disk — see the note on --strict in tools/upgrade-icons.mjs.
  // The picker sends strict by default and only clears it when the person has
  // read the list of what is absent and said to go anyway.
  // config.js announces every stale key in the saved tuning on startup, and the
  // bake imports it. That is a dozen lines of unrelated chatter ahead of the one
  // line you clicked the button to read — and on a refusal it pushed the list of
  // what is MISSING off the bottom of the notes pane. Dropped here rather than
  // in the picker so the server's own log is readable too.
  const trimConfigChatter = (text) => text.split('\n')
    .filter((line, i, all) => {
      if (line.startsWith('[config]')) return false;
      // The indented continuation lines under a `[config]` heading. Only those:
      // the bake's own output is indented the same way, so this walks back to
      // find which kind of block a line belongs to rather than matching on shape.
      if (!/^\s/.test(line)) return true;
      for (let j = i - 1; j >= 0; j--) {
        if (!/^\s/.test(all[j])) return !all[j].startsWith('[config]');
      }
      return true;
    })
    .join('\n').trim();

  if (req.method === 'POST' && url.pathname === '/bake') {
    const args = ['--import', './tools/vite-loader.mjs', 'tools/upgrade-icons.mjs', '--bake', SHOTS];
    if (url.searchParams.get('strict') !== '0') args.push('--strict');
    try {
      // cwd is the PROJECT, because the loader path above is relative to it and
      // because upgrade-icons.mjs resolves its own outputs from its own location.
      const { stdout } = await run(process.execPath, args, { cwd: PROJECT, maxBuffer: 1 << 22 });
      const log = trimConfigChatter(stdout);
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true, log }));
      console.log(`  baked into the game:\n${log.split('\n').map((l) => '    ' + l).join('\n')}`);
    } catch (err) {
      // Exit 2 is the strict refusal and carries the list of what is missing on
      // stderr; anything else is a real failure. Both come back as the same
      // shape so the picker can just show what the tool said.
      const out = trimConfigChatter(`${err.stderr ?? ''}${err.stdout ?? ''}`)
        || String(err.message ?? err);
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: false, refused: err.code === 2, log: out }));
      console.log(`  bake ${err.code === 2 ? 'refused' : 'failed'}: ${out.split('\n')[0]}`);
    }
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

// A port already in use is the failure this whole file looks broken from: the
// page loads (from the OTHER server), writes its shots somewhere you are not
// looking, and nothing says why. So say it, and say what to do about it.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is already in use — something else is serving it.`);
    console.error('  npm run servers        see what, and what is safe to stop');
    console.error(`  npm run servers -- stop ${PORT}`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  const q = LIST ? `?list=${LIST}` : '';
  console.log(`atlas renderer on http://localhost:${PORT}/render.html${q}`);
  console.log(`  pick angles at  http://localhost:${PORT}/picker.html${q}`);
  // The bake is the upgrade icons' round trip and nothing else's. Saying so on
  // a server started for a different list would be an invitation to press a
  // button that rewrites a module this list has no business in.
  if (LIST) console.log('  (shots here are for documents — "apply to the game" bakes the UPGRADE icons, not these)');
  console.log(`writing shots to ${SHOTS}`);
  if (!LIST) console.log('  picker.html can bake straight into path/src/ui/upgradeIcons.js');
});
