#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:splashhit — the title card's buttons respond where they are drawn.
//
// Builds the probe page, serves it read-only, drives it through a hidden
// Electron window and prints what it found. See tools/hit/splash-hit.js for
// what is actually being measured and why the existing layout checks cannot
// measure it: they compute where the dice and the Start button are DRAWN, and
// nothing in the repo has ever pressed one.
//
// IT NEEDS A BROWSER, for a harder reason than the layout audit does. That one
// needs a layout engine; this one needs the Rive runtime's own hit test, which
// runs against a real canvas, a real WebGL context and a state machine that is
// actually advancing. There is no version of this measurement in Node — a
// harness that stubbed the runtime would be asserting its own arithmetic.
//
// IT ALWAYS EXITS. Nothing here waits on a person: the browser is opened by the
// tool (tools/layout/drive.js, shared with `npm run layout`), a stall is
// detected against the page's own progress pings and reported as a finding
// about the tool rather than as silence, and every way out of this process
// takes the browser with it.
//
//   npm run test:splashhit              build, drive, print, exit non-zero on a finding
//   npm run test:splashhit -- --show    drive it in a window you can watch
//   npm run test:splashhit -- --manual  print the URL and wait for a browser
//   npm run test:splashhit -- --only iphone   just the devices whose name matches
//   npm run test:splashhit -- --trace   a line per sample, for a renderer that wedges
// ---------------------------------------------------------------------------

import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VIEWPORTS } from './hit/devices.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');
const OUT = resolve(PROJECT, 'dist-splash-hit');
const argv = process.argv.slice(2);
const SHOW = argv.includes('--show');
const MANUAL = argv.includes('--manual');
const PORT = Number(argv[argv.indexOf('--port') + 1]) || 4657;
// One device rather than eight, matched loosely on its name: `--only iphone`.
const ONLY = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
// A line per sample through the renderer's console, for the one failure that
// leaves no report behind: the page going silent mid-sweep. The stall printer
// shows the tail, which names the sample it stopped on.
const TRACE = argv.includes('--trace');
// The name in the pill, which sets the entry column's scale and with it every
// number this tool reports. Defaults to the widest the roller can draw — see
// the note in tools/hit/splash-hit.js.
const NAME = argv.includes('--name') ? argv[argv.indexOf('--name') + 1] : null;
const ELECTRON = resolve(PROJECT, 'node_modules/.bin/electron');
// The same driver as `npm run layout`: an Electron main process that opens a URL
// and holds it, with background throttling off so a hidden window still runs its
// timers at full speed. Shared rather than copied — the three command-line
// switches it sets are the whole reason a hidden sweep finishes at all.
const DRIVER = resolve(HERE, 'layout/drive.js');

// Declared up here with the other consts because the child's first line of
// stderr can arrive before the function that uses it — see the same note in
// tools/layout-audit.mjs, where a `const` beside its function put this in a
// temporal dead zone and took the run down.
const driverSaid = [];

// Whose report this is. A page left over from an earlier run posts numbers
// measured against a build that no longer exists and there is nothing in them
// that could give it away, so the check cannot be on the numbers.
const RUN = randomUUID().slice(0, 8);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.riv': 'application/octet-stream', '.glb': 'model/gltf-binary',
};

// The build first, then public/ — the card reaches for a font by absolute path
// and those are not part of the bundle.
const MOUNTS = [['/', OUT], ['/', resolve(PROJECT, 'public')]];

console.log('building the probe page…');
await run('npx', ['vite', 'build', '--config', 'tools/hit/vite.hit.config.mjs']);

// ONE BROWSER PER DEVICE, and the reason is not tidiness.
//
// The measurement is thousands of synthetic events into a WebGL2 canvas and a
// wasm state machine, and on this machine the renderer wedges part way through
// perhaps one run in three: the page stops answering, its own heartbeat stops
// with it, and nothing is ever reported. A single window sweeping eight devices
// loses the whole run to that; a window per device loses one device, and a
// retry usually gets it back. The cost is eight Electron launches, which is a
// couple of seconds each and worth every one of them.
//
// A device that is still silent after its retry is reported as a finding about
// the probe rather than quietly dropped — `--trace` is the flag for chasing it,
// and it prints the tail of the renderer's console, which names the last sample
// before the silence.
const DEVICE_MS = Number(argv[argv.indexOf('--deadline') + 1]) || 150_000;

let landDevice = null;
const heard = { at: Date.now(), label: null, i: 0, total: 0, connected: false, foreign: 0 };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.searchParams.get('run') !== RUN) {
    if (url.pathname === '/report/hit.json') console.log('\n  ignored a report from an older run — is a stale tab still open?');
    heard.foreign++;
    res.writeHead(409).end('not this run');
    return;
  }

  if (req.method === 'POST' && url.pathname === '/report/progress') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    res.writeHead(204).end();
    heard.at = Date.now();
    try {
      const { i, total, label } = JSON.parse(Buffer.concat(chunks).toString());
      heard.i = i; heard.total = total; heard.label = label;
      // One rewritten line on a terminal; ordinary lines when stdout is a pipe,
      // where \r buys nothing and would run the whole sweep together.
      if (!process.stdout.isTTY) console.log(`  measuring ${i + 1}/${total} — ${label}`);
    } catch { /* a malformed ping is still a sign of life, which is the point */ }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/report/hit.json') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    res.writeHead(204).end();
    try {
      landDevice?.(JSON.parse(Buffer.concat(chunks).toString()));
    } catch (err) {
      console.error(`  a malformed report — ${err.message}`);
      landDevice?.({ results: [], total: 0 });
    }
    return;
  }

  // A browser has arrived. Tracked apart from progress because the two failures
  // want different words: nothing ever fetched the page is a driver that did not
  // start, and a page that loaded and went quiet is a sweep that stalled.
  heard.connected = true;
  heard.at = Date.now();

  for (const file of resolveSafe(decodeURIComponent(url.pathname))) {
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' }).end(body);
      return;
    } catch { /* try the next mount */ }
  }
  res.writeHead(404).end('no');
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
// localhost rather than 127.0.0.1: the Browser pane refuses the numeric form.
const PAGE = `http://localhost:${PORT}/tools/hit/splash-hit.html?run=${RUN}`
  + (TRACE ? '&trace=1' : '')
  + (NAME ? `&name=${encodeURIComponent(NAME)}` : '');
console.log(`\n  ${PAGE}\n`);

const devices = ONLY
  ? VIEWPORTS.filter((v) => v.name.toLowerCase().includes(ONLY.toLowerCase()))
  : VIEWPORTS;
if (!devices.length) {
  console.log(`  no device matches "${ONLY}" — try one of: ${VIEWPORTS.map((v) => v.name).join(', ')}`);
  server.close();
  process.exit(1);
}

if (MANUAL) {
  console.log('waiting for a browser to open that page…');
  const report = await new Promise((r) => { landDevice = r; });
  await writeFile(join(OUT, 'hit-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  printReport(report);
  server.close();
  process.exit(report.total > 0 ? 1 : 0);
}

console.log(`pressing the card at ${devices.length} device size${devices.length === 1 ? '' : 's'} — about ${Math.ceil(devices.length * 0.6)} minute${devices.length > 2 ? 's' : ''}…\n`);

const results = [];
for (const [i, device] of devices.entries()) {
  heard.i = i; heard.total = devices.length; heard.label = device.name;
  let landed = null;
  for (let attempt = 0; attempt < 2 && !landed; attempt++) {
    process.stdout.write(`  ${i + 1}/${devices.length} ${device.name}${attempt ? ' (again)' : ''}… `);
    landed = await measureDevice(device);
    if (!landed && attempt === 0) console.log('the page went silent — retrying in a fresh window');
  }
  if (landed) {
    const r = landed.results?.[0];
    results.push(r ?? { viewport: device.name, w: device.w, h: device.h, findings: [{ type: 'threw', what: 'the page reported nothing for this device' }], detail: null });
    const n = r?.findings?.length ?? 0;
    console.log(n ? `${n} finding${n === 1 ? '' : 's'}` : 'clean');
  } else {
    console.log('gave up');
    results.push({
      viewport: device.name, w: device.w, h: device.h, detail: null,
      findings: [{ type: 'threw', what: 'the renderer went silent twice — run again with --trace to see the last sample it took' }],
    });
  }
}

const total = results.reduce((n, r) => n + r.findings.length, 0);
const report = { results, total };
await writeFile(join(OUT, 'hit-report.json'), `${JSON.stringify(report, null, 2)}\n`);
printReport(report);
server.close();
process.exit(total > 0 ? 1 : 0);

/**
 * One device in a browser of its own: spawn, wait for its report, kill. Returns
 * null if it never reported inside the deadline — see the note on DEVICE_MS.
 */
async function measureDevice(device) {
  const url = `${PAGE}&only=${encodeURIComponent(device.name)}`;
  const child = startDriver(url);
  if (!child) return null;
  const landed = await new Promise((done) => {
    landDevice = done;
    const timer = setTimeout(() => done(null), DEVICE_MS);
    timer.unref?.();
  });
  landDevice = null;
  stopDriver(child);
  // The port is reused by the next window; give the old renderer a moment to
  // let go of it rather than racing its own successor.
  await new Promise((r) => setTimeout(r, 400));
  return landed;
}

// ---------------------------------------------------------------------------

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

function startDriver(url) {
  if (!existsSync(ELECTRON)) {
    console.log('  (no electron in node_modules — open the URL above yourself)');
    return null;
  }
  // DETACHED so the child gets a process group of its own: node_modules/.bin/
  // electron is a node wrapper that spawns the real binary as its own child, so
  // killing the wrapper leaves a Chromium running, still pointed at this URL and
  // still posting. The next run binds the same port and inherits it. See the
  // long version of this in tools/layout-audit.mjs.
  const child = spawn(ELECTRON, [DRIVER, url, ...(SHOW ? ['--show'] : [])], {
    cwd: PROJECT,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.on('data', (d) => {
    for (const line of String(d).split('\n')) {
      if (line.startsWith('SEAL_LAYOUT_GONE ')) driverSaid.push(line.slice('SEAL_LAYOUT_GONE '.length));
      else if (line.startsWith('SEAL_LAYOUT_CONSOLE ')) {
        const msg = line.slice('SEAL_LAYOUT_CONSOLE '.length);
        if (!msg.startsWith('[sealNames]') && !msg.includes('Electron Security Warning')) driverSaid.push(msg);
      }
    }
  });
  child.stderr.on('data', (d) => driverSaid.push(String(d).trim()));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) driverSaid.push(`the browser exited ${code}`);
  });
  const reap = () => stopDriver(child);
  process.once('exit', reap);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => { reap(); process.exit(130); });
  }
  return child;
}

function stopDriver(child) {
  if (!child || child.killed) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* nothing left to kill */ }
  }
}

function printReport({ results, total }) {
  const bad = results.filter((r) => r.findings.length);
  console.log('');
  for (const r of bad) {
    console.log(`  ${r.viewport} ${r.w}x${r.h}`);
    for (const f of r.findings) console.log(`      ${describe(f)}`);
  }
  // WHAT IT MEASURED, not only what it objected to. A hitbox that matches its
  // picture to the pixel is worth reading — it is the evidence that a clean run
  // was a measurement rather than a probe that quietly found nothing.
  {
    console.log('');
    const named = results.find((r) => r.detail?.name);
    // Named, always: the scale is a function of it and every number below moves
    // with the scale, so a table without the name it was measured at is a table
    // that cannot be compared with the next one.
    if (named) {
      console.log(NAME
        ? `  measured with the name you asked for — "${named.detail.name}"\n`
        : `  measured with the widest name the roller can draw — "${named.detail.name}" (--name for another)\n`);
    }
    for (const r of results) {
      if (!r.detail?.hit) continue;
      const t = r.detail.touch ?? {};
      const rot = r.detail.rotation ?? {};
      const path = t.touch ? 'touch' : t.mouse ? 'mouse only' : 'neither';
      const lag = rot.arrivedMs == null ? '—' : `${rot.arrivedMs}ms`;
      console.log(`  ${r.viewport.padEnd(20)} scale ${String(r.detail.scale ?? '—').padEnd(6)} dice ${String(r.detail.hit.dice).padEnd(18)} start ${String(r.detail.hit.start).padEnd(18)} press: ${path.padEnd(11)} rotate: ${lag}`);
    }
  }
  console.log('');
  if (bad.some((r) => r.findings.some((f) => f.type === 'threw')) && driverSaid.length) {
    console.log('  what the browser said:');
    for (const line of driverSaid.filter(Boolean).slice(-14)) console.log(`      ${line}`);
    console.log('');
  }
  console.log(total === 0
    ? `  PASS  every button responds where it is drawn (${results.length} devices)`
    : `  FAIL  ${total} finding(s) across ${bad.length} of ${results.length} devices`);
  console.log(`\n  full report: ${join(OUT, 'hit-report.json')}`);
}

// RESTATED rather than imported from the page module: that file is a browser
// module that imports the Rive runtime and the .riv, and pulling it into Node to
// borrow one string formatter would drag all of that with it.
function describe(f) {
  if (f.type === 'hit-offset') return `${f.what} — responds ${f.by}px off where it is drawn (hit ${f.hit}, drawn ${f.drawn})`;
  if (f.type === 'hit-missing') return `${f.what} — nothing responded where it is drawn: ${f.by ?? 'and the probe had nothing more to say'}`;
  if (f.type === 'hit-unread') return `${f.what} — ${f.by}`;
  if (f.type === 'hit-unbounded') return `${f.what} — still live ${f.by}px out; the search found no edge`;
  if (f.type === 'tap') return `${f.what} — hitbox ${f.w}x${f.h}, under 44`;
  if (f.type === 'touch-dead') return `${f.what} — ${f.by}`;
  if (f.type === 'hit-stale') return `${f.what} — the old hitbox stayed live ${f.by}ms after the box changed`;
  if (f.type === 'hit-late') return `${f.what} — took ${f.by} to respond after the box changed`;
  if (f.type === 'probe-broken') return `the probe itself — ${f.what}`;
  if (f.type === 'threw') return `the tile failed — ${f.what}`;
  return `${f.what} — ${f.type} ${f.by ?? ''}`;
}

function run(cmd, args) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd: PROJECT, stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${cmd} exited ${code}`))));
  });
}
