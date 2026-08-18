#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run layout
//
// Builds the layout audit page, serves it, and waits for a browser to report.
// Prints what does not fit and exits non-zero if anything doesn't, so this can
// be run the way every other check in this repo is.
//
// IT NEEDS A BROWSER, and that is not a shortcoming to be engineered around.
// Every question it asks — how wide is this line of text, does this row of
// buttons wrap, where does the card end up — is answered by a layout engine,
// and there is no layout engine in Node. jsdom returns 0 for every rectangle it
// is asked about, which is not a small inaccuracy: it is a harness that reports
// a clean sheet for a screen that is entirely broken. So the measuring happens
// in a real browser, at real viewport sizes (see tools/layout/layout-audit.js
// for why they are iframes), and this process is the terminal end of it.
//
// A STATIC SERVER, with no way to write to the source tree. The one endpoint
// that takes a POST writes a single JSON report into the scratch build
// directory. In particular there is no /__tuning here — see SERVERS.md for why
// a second writer of imported-tuning.json is the thing to avoid.
//
// IT STAYS UP AFTER IT REPORTS, and that is the important default. This is a
// page you LOOK at — forty-eight tiles of real interface at real device sizes,
// each one clickable to remount and inspect — and the first version exited the
// moment the report landed, which pulled the server out from under the browser
// a second after the grid finished drawing. A tool you cannot see is not a
// tool. `--once` is the other mode, for when this is being run as a check
// rather than read: report, exit, non-zero if anything does not fit.
//
//   npm run layout           build, serve, print the report, KEEP SERVING
//   npm run layout -- --once report and exit (non-zero on a finding), for CI
// ---------------------------------------------------------------------------

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');
const OUT = resolve(PROJECT, 'dist-layout-audit');
const argv = process.argv.slice(2);
// --keep is still honoured because it is what the first version called this,
// and it now means what the default already does.
const ONCE = argv.includes('--once') && !argv.includes('--keep');
const PORT = Number(argv[argv.indexOf('--port') + 1]) || 4650;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.riv': 'application/octet-stream', '.glb': 'model/gltf-binary',
};

// The build first, then public/ — the UI reaches for a sprite or a font by
// absolute path and those are not part of the bundle.
const MOUNTS = [['/', OUT], ['/', resolve(PROJECT, 'public')]];

function resolveSafe(urlPath) {
  const out = [];
  for (const [prefix, dir] of MOUNTS) {
    if (!urlPath.startsWith(prefix)) continue;
    const full = normalize(join(dir, urlPath.slice(prefix.length) || '.'));
    // The startsWith check is what stops ../ walking out of a mount.
    if (full.startsWith(dir)) out.push(full);
  }
  return out;
}

console.log('building the audit page…');
await run('npx', ['vite', 'build', '--config', 'tools/layout/vite.layout.config.mjs']);

let settle;
const reported = new Promise((r) => { settle = r; });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/report/layout.json') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    res.writeHead(204).end();
    try {
      const report = JSON.parse(body);
      await writeFile(join(OUT, 'layout-report.json'), `${JSON.stringify(report, null, 2)}\n`);
      settle(report);
    } catch (err) {
      console.error(`  a malformed report — ${err.message}`);
      settle({ results: [], total: 0, silent: 1 });
    }
    return;
  }

  for (const file of resolveSafe(decodeURIComponent(url.pathname))) {
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' }).end(body);
      return;
    } catch { /* try the next mount */ }
  }
  res.writeHead(404).end('no');
});

// localhost rather than 127.0.0.1: the Browser pane refuses the numeric form.
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log(`\n  open  http://localhost:${PORT}/tools/layout/layout-audit.html\n`);
console.log('waiting for the page to report…');

const report = await reported;
printReport(report);
if (ONCE) {
  server.close();
  process.exit(report.total > 0 || report.silent > 0 ? 1 : 0);
}
console.log(`\n  still serving on http://localhost:${PORT}/tools/layout/layout-audit.html`);
console.log('  Click any tile to remount it, or reload to sweep again. Ctrl-C to stop.');

function printReport({ results, total, silent }) {
  const bad = results.filter((r) => r.findings.length);
  console.log('');
  for (const r of bad) {
    console.log(`  ${r.viewport} ${r.w}x${r.h} — ${r.surface}`);
    for (const f of r.findings) console.log(`      ${describe(f)}`);
  }
  console.log('');
  if (silent) console.log(`  ${silent} frame(s) never reported — a surface threw while building.`);
  console.log(total === 0 && !silent
    ? `  PASS  every surface fits every viewport (${results.length} pairs)`
    : `  FAIL  ${total} finding(s) across ${bad.length} of ${results.length} surface/viewport pairs`);
  console.log(`\n  full report: ${join(OUT, 'layout-report.json')}`);
}

function describe(f) {
  if (f.type === 'tap') return `${f.what} — tap target ${f.w}x${f.h}, under 44`;
  if (f.type === 'clipped') return `${f.what} — clipped, content ${f.contentW}px in a ${f.boxW}px box`;
  if (f.type === 'threw') return `surface failed to build — ${f.what}`;
  if (f.type === 'callout-over-ui') return `${f.what} — sitting on ${f.over}, ${f.by}px of overlap`;
  return `${f.what} — ${f.type} by ${f.by}px`;
}

function run(cmd, args) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd: PROJECT, stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${cmd} exited ${code}`))));
  });
}
