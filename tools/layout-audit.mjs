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
// IT OPENS THE BROWSER ITSELF, and that part WAS a shortcoming. The first
// version printed a URL and blocked on `waiting for the page to report…` with
// no other way out: run it with nobody at the keyboard to open that URL and it
// sat there, silent, with an empty output directory, until it was killed. Ten
// minutes of that on 2026-08-27 is why this comment exists. Needing a layout
// engine is a fact about the problem; needing a person is not, and a check that
// a person has to finish by hand is a check that does not run. So the sweep is
// driven through a hidden Electron window (tools/layout/drive.js, the same
// pattern electron/smoke.js already uses for the desktop shell), and `--manual`
// is how you ask for the old flow when you want the page in the Browser pane.
//
// IT SAYS WHAT IT IS DOING. The report only exists at the very end, two minutes
// after the start, so a running sweep and a hung one used to look identical
// from the terminal. The page pings /report/progress per tile and that is
// echoed here — and counted against, because a sweep that stops pinging is
// abandoned with the tile it stopped on named. Nothing in this tool waits
// forever any more.
//
//   npm run layout           build, drive, print the report, KEEP SERVING
//   npm run layout -- --once report and exit (non-zero on a finding), for CI
//   npm run layout -- --manual   don't open anything; print the URL and wait
//   npm run layout -- --show     drive it in a window you can watch
// ---------------------------------------------------------------------------

import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
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
// --manual is the old behaviour: print the URL and wait for a browser somebody
// else opens. Worth keeping — the Browser pane is how a single tile gets looked
// at — but it is no longer what happens when you just run the thing.
const MANUAL = argv.includes('--manual') || argv.includes('--no-open');
// A window rather than a hidden one. The default for a sweep you are going to
// READ is still the terminal report, so the window is opt-in; --once never
// shows one.
const SHOW = argv.includes('--show') && !ONCE;
// HOW LONG SILENCE IS ALLOWED TO LAST, in ms, measured from the last thing the
// page said rather than from the start. An absolute deadline would have to be
// longer than the slowest honest sweep on the slowest machine, which is a
// number nobody knows; a stall is the thing actually being detected, and 60s is
// four times the page's own 15s per-tile timeout, so a tile that gives up
// normally can never trip this.
const STALL_MS = Number(argv[argv.indexOf('--stall') + 1]) || 60_000;
const ELECTRON = resolve(PROJECT, 'node_modules/.bin/electron');
const DRIVER = resolve(HERE, 'layout/drive.js');

// UP HERE, with the other consts, and it has to be. `function` hoists and
// `const` does not, so declaring this next to startDriver() — which is below
// the call — left the child's first line of stderr reaching a variable in its
// temporal dead zone and taking the whole run down. The same trap, in the same
// shape, that the bottom of tools/layout/layout-audit.js already documents.
const driverSaid = [];

// WHOSE REPORT IS THIS. Handed to the page in its URL and echoed back on every
// post; anything arriving under a different one is dropped.
//
// Killing the browser properly (stopDriver, below) is the fix for the leak, and
// this is the guarantee that does not depend on that fix being right. A page
// left over from an earlier run — a Browser pane tab somebody forgot, an
// Electron that survived a SIGKILL race — posts a report measured against a
// build that no longer exists, and it looks exactly like a real one. There is
// nothing in the numbers themselves that could give it away, so the check
// cannot be on the numbers.
const RUN = randomUUID().slice(0, 8);

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

// WHAT THE PAGE LAST SAID, and when. The watchdog reads both: `at` is what
// tells a slow sweep from a stopped one, and `label` is what turns "it hung"
// into the name of the tile it hung on — which is the difference between a bug
// report and a shrug.
const heard = { at: Date.now(), label: null, i: 0, total: 0, connected: false, foreign: 0 };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // A post from some other run's page. Dropped without a word on the progress
  // channel — it is noise by definition — but said out loud for a report,
  // because a sweep that seems to have vanished should name the reason.
  if (req.method === 'POST' && url.searchParams.get('run') !== RUN) {
    if (url.pathname === '/report/layout.json') {
      console.log('\n  ignored a report from an older run — is a stale tab still open?');
    }
    heard.foreign++;
    res.writeHead(409).end('not this run');
    return;
  }

  if (req.method === 'POST' && url.pathname === '/report/progress') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    res.writeHead(204).end();
    try {
      const { i, total, label } = JSON.parse(Buffer.concat(chunks).toString());
      heard.at = Date.now();
      heard.i = i; heard.total = total; heard.label = label;
      // One rewritten line rather than a scrolling column of sixty-four. When
      // stdout is not a terminal (a CI log, a pipe) \r buys nothing and would
      // run the whole sweep together on one unreadable line, so that case gets
      // ordinary lines and only every eighth tile.
      if (process.stdout.isTTY) {
        process.stdout.write(`\r  measuring ${i + 1}/${total} — ${label}`.padEnd(72));
      } else if (i % 8 === 0) {
        console.log(`  measuring ${i + 1}/${total} — ${label}`);
      }
    } catch { /* a malformed ping is still a sign of life, which is the point */ }
    return;
  }

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

  // A browser has arrived. Tracked separately from progress because the two
  // failures want different words: nothing ever fetched the page is a driver
  // that did not start, while a page that loaded and went quiet is a sweep that
  // stalled, and telling somebody the wrong one costs them the afternoon.
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

// localhost rather than 127.0.0.1: the Browser pane refuses the numeric form.
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const PAGE = `http://localhost:${PORT}/tools/layout/layout-audit.html?run=${RUN}`;
console.log(`\n  ${PAGE}\n`);

const driver = MANUAL ? null : startDriver();
console.log(MANUAL
  ? 'waiting for a browser to open that page…'
  : 'measuring — 64 tiles, about a minute…');

const report = await Promise.race([reported, watchdog()]);
if (process.stdout.isTTY) process.stdout.write('\r'.padEnd(74) + '\r');
// --show asked for a window to WATCH, so it outlives the report — the whole
// point of it is to still be there when you look up. Every other shape of run
// is done with the browser the moment the numbers are in, and a hidden Chromium
// left running is exactly the leak stopDriver exists for.
if (!SHOW || ONCE) stopDriver(driver);
printReport(report);
// A STALL ALWAYS EXITS, in both modes. Staying up after a stall is tempting —
// the page is right there and you could go and look at it — but that is exactly
// the shape of the original bug, a process holding the terminal with nothing
// coming, and the invitation below gets you the same look without it.
if (ONCE || report.stalled) {
  server.close();
  if (report.stalled && !MANUAL) {
    // Only worth saying when the tool was the one driving. In --manual the
    // reader IS the browser, and telling them to run --manual is telling them
    // to do what they just did.
    console.log(`  To watch it happen:  npm run layout -- --manual`);
    console.log(`  then open that URL — the ?run= is part of it — and watch the tiles.`);
  }
  process.exit(report.total > 0 || report.silent > 0 ? 1 : 0);
}
console.log(`\n  still serving on ${PAGE}`);
console.log('  Click any tile to remount it, or reload to sweep again. Ctrl-C to stop.');

// THE BROWSER, OPENED BY THE TOOL. See tools/layout/drive.js for why it is
// Electron and why the window is hidden. A missing electron is a clear message
// and a fall back to the manual flow rather than a crash — the page is still
// perfectly good, it just needs somebody to open it.
function startDriver() {
  if (!existsSync(ELECTRON)) {
    console.log('  (no electron in node_modules — open the URL above yourself)');
    return null;
  }
  // DETACHED, so the child gets a process group of its own and the whole group
  // can be killed at once.
  //
  // node_modules/.bin/electron is a NODE WRAPPER that spawns the real binary as
  // a child of its own, so `child.kill()` reaps the wrapper and leaves an actual
  // Chromium running — still pointed at this URL, still measuring, still
  // POSTing. The next `npm run layout` binds the same port and inherits it: two
  // browsers reporting into one server, progress counting 33, then 9, then 41,
  // and findings from a page built against the PREVIOUS bundle, which arrive as
  // `Failed to fetch dynamically imported module` on assets whose hash no
  // longer exists. Four consecutive runs gave four different answers before
  // this was found, and every one of them looked like a flaky layout rather
  // than a leaked process.
  const child = spawn(ELECTRON, [DRIVER, PAGE, ...(SHOW ? ['--show'] : [])], {
    cwd: PROJECT,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  // The renderer's own errors, kept until they are needed. A page-level failure
  // — a bad import, a bundle that will not parse — produces no findings and no
  // report, so without this the tool would notice the silence and have nothing
  // to say about its cause.
  child.stdout.on('data', (d) => {
    for (const line of String(d).split('\n')) {
      if (line.startsWith('SEAL_LAYOUT_GONE ')) {
        driverSaid.push(line.slice('SEAL_LAYOUT_GONE '.length));
      } else if (line.startsWith('SEAL_LAYOUT_CONSOLE ')) {
        const msg = line.slice('SEAL_LAYOUT_CONSOLE '.length);
        // The name tables narrate their own sanitising on every boot, once per
        // frame, sixty-four times. Real, already reported by the tool that owns
        // it, and it would bury anything worth reading.
        if (!msg.startsWith('[sealNames]') && !msg.includes('Electron Security Warning')) {
          driverSaid.push(msg);
        }
      }
    }
  });
  child.stderr.on('data', (d) => driverSaid.push(String(d).trim()));
  child.on('exit', (code) => {
    // Electron quitting before the report is in is itself the answer to why the
    // report is not in.
    if (code !== 0 && code !== null) driverSaid.push(`the browser exited ${code}`);
  });
  // Ctrl-C, an uncaught throw, a normal exit — every way out of this process has
  // to take the browser with it, because the one that does not is the one that
  // leaks. process.exit() runs 'exit' handlers, so the --once path is covered
  // by the same line as the rest.
  const reap = () => stopDriver(child);
  process.once('exit', reap);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => { reap(); process.exit(130); });
  }
  return child;
}

/** Kill the browser and everything it spawned. See startDriver for why. */
function stopDriver(child) {
  if (!child || child.killed) return;
  try {
    // The NEGATIVE pid is the process group, which is the whole point of
    // detached above — SIGKILL rather than SIGTERM because a Chromium mid-load
    // takes its time about a polite one, and there is nothing here worth
    // shutting down cleanly.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Already gone, or never got a group. Fall back to the direct kill, which
    // is at least the wrapper.
    try { child.kill('SIGKILL'); } catch { /* nothing left to kill */ }
  }
}

// NOTHING HERE WAITS FOREVER. Resolves to a report-shaped object so the normal
// printing path handles it — a stall is a finding about the tool, and it should
// come out through the same channel and the same non-zero exit as a finding
// about the layout, not as a different kind of event nobody has written a
// handler for.
function watchdog() {
  return new Promise((done) => {
    const tick = setInterval(() => {
      const quiet = Date.now() - heard.at;
      if (quiet < STALL_MS) return;
      clearInterval(tick);
      const what = heard.foreign
        // Its posts were arriving and being refused, which is a completely
        // different problem from silence and must not be described as one.
        ? `a page from another run is reporting — open ${PAGE} (with the ?run=, it is not optional)`
        : !heard.connected
        ? (MANUAL
          ? `nothing opened ${PAGE} — this is --manual, so it was waiting for you`
          : 'the browser never fetched the page — see tools/layout/drive.js')
        : heard.label
          ? `the sweep stopped at tile ${heard.i + 1}/${heard.total} — ${heard.label}`
          : 'the page loaded but never started measuring';
      done({
        results: [{
          viewport: '—', w: 0, h: 0, surface: 'the audit itself',
          findings: [{ type: 'threw', what: `${what} (silent for ${Math.round(quiet / 1000)}s)` }],
        }],
        total: 1,
        silent: 0,
        stalled: true,
      });
    }, 1000);
    // An interval is the only thing holding this process up between tiles;
    // unref so a finished run is never kept alive by its own watchdog.
    tick.unref?.();
  });
}

function printReport({ results, total, silent, stalled }) {
  const bad = results.filter((r) => r.findings.length);
  console.log('');
  for (const r of bad) {
    console.log(`  ${r.viewport} ${r.w}x${r.h} — ${r.surface}`);
    for (const f of r.findings) console.log(`      ${describe(f)}`);
  }
  console.log('');
  if (silent) console.log(`  ${silent} frame(s) never reported — a surface threw while building.`);
  // Only on a stall, and only then: on a normal run these are the page's
  // ordinary chatter and printing them would train everyone to ignore the
  // block they are printed in.
  if (stalled && driverSaid.length) {
    console.log('\n  what the browser said:');
    for (const line of [...new Set(driverSaid)].filter(Boolean).slice(-12)) {
      console.log(`      ${line}`);
    }
  }
  console.log(total === 0 && !silent
    ? `  PASS  every surface fits every viewport (${results.length} pairs)`
    : `  FAIL  ${total} finding(s) across ${bad.length} of ${results.length} surface/viewport pairs`);
  // Not on a stall: nothing was written this run, so the path would point at
  // whatever the last successful sweep left behind — a stale file offered as
  // this run's answer is worse than no file at all.
  if (!stalled) console.log(`\n  full report: ${join(OUT, 'layout-report.json')}`);
}

function describe(f) {
  if (f.type === 'tap') return `${f.what} — tap target ${f.w}x${f.h}, under 44`;
  if (f.type === 'clipped') return `${f.what} — clipped, content ${f.contentW}px in a ${f.boxW}px box`;
  if (f.type === 'threw') return `surface failed to build — ${f.what}`;
  if (f.type === 'callout-over-ui') return `${f.what} — sitting on ${f.over}, ${f.by}px of overlap`;
  if (f.type === 'out-of-panel') return `${f.what} — ${f.by}px outside the menu panel it belongs to`;
  if (f.type === 'clipped-below') return `${f.what} — cut off at the bottom, content ${f.contentH}px in a ${f.boxH}px box`;
  return `${f.what} — ${f.type} by ${f.by}px`;
}

function run(cmd, args) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd: PROJECT, stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${cmd} exited ${code}`))));
  });
}
