#!/usr/bin/env node
// ============================================================================
// THE WORKBENCH — one door to every tool in this repo.
//
//   npm run hub          then open http://localhost:5178
//
// There are a hundred and thirty-odd npm scripts here, two dozen browser
// pages, and four different servers that put those pages on an origin. All of
// it is real, all of it is used, and none of it is findable: the scripts live
// in package.json in the order they were written, the pages live in three
// directories, and what each one is for is a paragraph at the top of a file
// you have to already know to open.
//
// So this is an index that reads itself out of the repo — see hub-catalogue.mjs
// for how, and for why nothing here is a hand-maintained list.
//
// WHY A PORT OF ITS OWN, when the dev server could have served this page.
//
//   Because the dev server is the thing you most often need a link TO, and its
//   port moves. Vite takes whatever it can get, so the game has been on 3000,
//   54865 and 63641 in a single day (see SERVERS.md). A bookmark to the game
//   is wrong by lunchtime.
//
//   5178 never moves. The hub discovers where the game landed and rewrites the
//   links, which is a job that cannot be done by the server whose address is
//   the unknown. It also means the hub is up when the game is not, and can
//   offer to start it — a page served by the dev server can only be reached by
//   someone who already found the dev server.
//
//   And it keeps this out of the game's process. Every dev server carries the
//   tuning writer; a second one is a live threat to imported-tuning.json. The
//   hub reads the socket table and spawns things, and never imports config.js,
//   so nothing it does can reach your tuning.
//
// WHAT IT WILL AND WILL NOT DO FOR YOU
//
//   It runs checks, audits and generators, and streams their output back. It
//   starts the servers and links to them. It will NOT deploy, publish or ship
//   — those get a copyable command and no button, because a page left open in
//   a background tab all day should not be one stray click from the live site.
// ============================================================================

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { survey, ROLES, stop as stopPid } from './servers.mjs';
import { commands, pages, GROUP_ORDER, ROOT } from './hub-catalogue.mjs';

// The one number in this repo that is allowed to be a constant. PORT is
// honoured so a second session can run its own hub rather than failing on
// "address in use" — but 5178 is the address you type, and it is what the
// docs and the servers panel both name.
const PORT = Number(process.env.HUB_PORT || process.env.PORT || 5178);

// ---------------------------------------------------------------------------
// RUNS
//
// A run is a spawned npm script plus everything it has said so far. Output is
// kept in a bounded ring: `npm test` prints tens of thousands of lines and the
// hub is not a log store — the tail is what you read, and the terminal is
// still there for the rest.
// ---------------------------------------------------------------------------
const MAX_LINES = 600;
const runs = new Map();
let nextId = 1;

// Strip ANSI. Every tool here colours its output for a TTY, and while stdio is
// a pipe most of them still do — the codes would render as literal `[32m`.
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// Any localhost URL a run prints becomes a link. This is how `looks:*` and the
// atlas renderer are reached without the hub knowing their ports: they say
// where they landed, on the same line they always have.
const URL_RE = /https?:\/\/localhost:\d+[^\s'"()]*/g;

function startRun(entry) {
  const existing = [...runs.values()].find((r) => r.name === entry.name && r.status === 'running');
  if (existing) return existing;

  const run = {
    id: nextId++,
    name: entry.name,
    risk: entry.risk,
    status: 'running',
    exit: null,
    started: Date.now(),
    ended: null,
    lines: [],
    urls: [],
  };
  runs.set(run.id, run);

  // `npm run` rather than the raw command, so a script that chains (`&&`) or
  // relies on npm's PATH behaves exactly as it does in a terminal. Shell off:
  // the argument is a validated script name from package.json, never text.
  //
  // `detached` is what makes Stop work. `npm run looks:goo` is a shell running
  // vite and then a server; without its own process group, killing the pid we
  // hold leaves the server holding its port with nothing pointing at it — a
  // stale listener the panel then has to warn about. Its own group means one
  // signal reaches the whole tree. The hub kills its runs on the way out (see
  // the exit handler at the bottom), so detached never means abandoned.
  const child = spawn('npm', ['run', entry.name], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  run.pid = child.pid;

  let buffer = '';
  const onData = (chunk) => {
    buffer += plain(String(chunk));
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const line of parts) {
      run.lines.push(line);
      for (const url of line.match(URL_RE) ?? []) {
        if (!run.urls.includes(url)) run.urls.push(url);
      }
    }
    if (run.lines.length > MAX_LINES) run.lines.splice(0, run.lines.length - MAX_LINES);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('close', (code) => {
    if (buffer) run.lines.push(buffer);
    run.status = code === 0 ? 'passed' : run.status === 'stopped' ? 'stopped' : 'failed';
    run.exit = code;
    run.ended = Date.now();
  });
  child.on('error', (err) => {
    run.lines.push(`could not start — ${err.message}`);
    run.status = 'failed';
    run.exit = -1;
    run.ended = Date.now();
  });

  return run;
}

function stopRun(id) {
  const run = runs.get(id);
  if (!run || run.status !== 'running' || !run.pid) return false;
  run.status = 'stopped';
  // The whole group: `npm run` is a shell wrapper around the real process, and
  // killing only the wrapper leaves a vite build (or a look server) orphaned
  // and still holding its port.
  try { process.kill(-run.pid, 'SIGTERM'); } catch { try { process.kill(run.pid, 'SIGTERM'); } catch { /* gone */ } }
  return true;
}

// ---------------------------------------------------------------------------
// STATE — what is running, and where everything is right now.
//
// The origins are the whole point of this endpoint. A page in the repo root is
// only reachable through the dev server, and the dev server's port is not
// knowable in advance, so every link to one is resolved here, on every poll,
// against the socket table. Nothing in the page is allowed to remember a port.
// ---------------------------------------------------------------------------
function state() {
  const found = survey();
  const keeper = (role) => found.find((p) => p.role === role && p.verdict === 'keep')
    ?? found.find((p) => p.role === role);
  const originOf = (role) => {
    const p = keeper(role);
    return p ? `http://localhost:${p.ports[0]}` : '';
  };

  const origins = {
    dev: originOf('dev'),
    csv: originOf('csv'),
    atlas: originOf('atlas'),
    looks: originOf('looks'),
  };

  return {
    port: PORT,
    origins,
    servers: found.map((p) => ({
      pid: p.pid,
      role: p.role,
      // Which build a look server is serving, straight off its command line
      // (`node tools/looks/serve.mjs dist-shaderlab --out ...`). This is what
      // ties a running server back to the page on its card — several can be up
      // at once, on ports none of them chose, so the address cannot be the key.
      dist: p.role === 'looks'
        ? (/serve\.mjs\s+(?!--)(\S+)/.exec(p.command)?.[1] ?? '')
        : '',
      label: ROLES[p.role].label,
      why: ROLES[p.role].why,
      start: ROLES[p.role].start,
      need: ROLES[p.role].need,
      ports: p.ports,
      age: p.age,
      owner: p.owner,
      verdict: p.verdict,
      note: p.note,
    })),
    missing: ['dev', 'csv'].filter((role) => !found.some((p) => p.role === role && p.verdict === 'keep')),
    runs: [...runs.values()].map((r) => ({
      id: r.id, name: r.name, status: r.status, exit: r.exit,
      started: r.started, ended: r.ended, urls: r.urls, lines: r.lines.length,
    })).sort((a, b) => b.id - a.id),
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const json = (res, body, code = 200) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((done) => {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 100_000) req.destroy(); });
  req.on('end', () => { try { done(JSON.parse(body || '{}')); } catch { done({}); } });
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (path === '/' || path === '/index.html') {
    const html = await readFile(join(ROOT, 'tools/hub.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }

  // The catalogue is read fresh on every request rather than cached at boot.
  // Adding a script to package.json while the hub is open should show up on
  // the next poll — a tool index that needs restarting to see a new tool is
  // the failure mode this whole file exists to avoid.
  if (path === '/api/catalogue') {
    return json(res, { commands: commands(), pages: pages(), groups: GROUP_ORDER });
  }

  if (path === '/api/state') return json(res, state());

  if (path === '/api/log') {
    const run = runs.get(Number(url.searchParams.get('id')));
    if (!run) return json(res, { error: 'no such run' }, 404);
    const since = Number(url.searchParams.get('since') || 0);
    return json(res, {
      id: run.id, name: run.name, status: run.status, exit: run.exit, urls: run.urls,
      // Sending from an absolute index over a ring buffer would repeat or skip
      // lines once it wraps. The tail is always correct and always cheap.
      total: run.lines.length,
      lines: since < run.lines.length ? run.lines.slice(since) : [],
    });
  }

  if (req.method === 'POST' && path === '/api/run') {
    const { name } = await readBody(req);
    const entry = commands().find((c) => c.name === name);
    // Two gates, and the order matters: the name must be a script that exists
    // (so nothing here can ever become a command runner), and its risk must be
    // one the hub is willing to take.
    if (!entry) return json(res, { error: 'not a script in package.json' }, 400);
    if (entry.risk === 'publish') return json(res, { error: 'publish scripts are terminal-only' }, 403);
    return json(res, { id: startRun(entry).id });
  }

  if (req.method === 'POST' && path === '/api/stop-run') {
    const { id } = await readBody(req);
    return json(res, { stopped: stopRun(Number(id)) });
  }

  if (req.method === 'POST' && path === '/api/stop-server') {
    const { pid } = await readBody(req);
    // Only something the panel itself found, and never the hub's own process.
    // A pid off the wire is otherwise a licence to kill anything on the box.
    const target = survey().find((p) => p.pid === Number(pid));
    if (!target) return json(res, { error: 'not one of ours' }, 400);
    if (target.pid === process.pid) return json(res, { error: 'that is this hub' }, 400);
    stopPid(target.pid, ROLES[target.role].label);
    return json(res, { ok: true });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('no');
});

// Runs are spawned detached, so they outlive this process unless we say
// otherwise — and a hub closed with Ctrl-C that leaves four look servers
// holding ports is exactly the mess `npm run servers -- clean` exists to
// clear up. Take them with us.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const run of runs.values()) stopRun(run.id);
    process.exit(0);
  });
}

// STARTING A HUB THAT IS ALREADY UP IS NOT AN ERROR.
//
// This is the one server in the repo you are told to leave running forever, so
// something will inevitably try to start a second one — a launch config, a
// second terminal, a session that did not check. Crashing on EADDRINUSE would
// present as the workbench being broken at the exact moment it is working.
//
// So knock first: if the thing on our port answers /api/state like a hub, the
// job is already done. If it is something else entirely, that IS an error —
// silently taking another port would break the one promise this port makes.
server.on('error', async (err) => {
  if (err.code !== 'EADDRINUSE') {
    console.error(`  hub: ${err.message}`);
    process.exit(1);
  }
  const mine = await fetch(`http://localhost:${PORT}/api/state`)
    .then((r) => r.json())
    .then((s) => s.port === PORT)
    .catch(() => false);
  if (mine) {
    console.log(`\n  Workbench already running — http://localhost:${PORT}\n`);
    process.exit(0);
  }
  console.error(`\n  Port ${PORT} is taken by something that is not the workbench.`);
  console.error(`  Find it with: npm run servers\n`);
  process.exit(1);
});

// 127.0.0.1, not 0.0.0.0. This endpoint spawns processes in the repo; it has
// no business being reachable from anything but this machine.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  SEAL SURVIVOR — WORKBENCH\n`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  Every tool in the repo, on a port that never moves.`);
  console.log(`  Leave it open — it finds the game's port for you as it changes.\n`);
});
