#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run playtest:pull [-- options]
//
// Brings runs collected from the live site down into the repo, where the same
// report that reads local runs can read them:
//
//   npm run playtest:pull
//   npm run playtest -- --remote
//
// INCREMENTAL AND APPEND-ONLY. The worker's keys sort chronologically, so a
// pull is "everything after the last key I saw" — kept in a cursor file
// beside the output. That makes a second pull cheap.
//
// THE WORKER IS THE SOURCE, THIS FILE IS A CACHE. `playtest/` is gitignored
// (session data, and a thousand runs is tens of MB), so the local file is not
// backed up by anything. That's survivable in one direction only: delete it
// and `npm run playtest:pull -- --all` rebuilds it from the collection. What
// that cannot recover is a run the worker has already expired — six months,
// see RETENTION_S — so a collection you care about past that wants an
// occasional copy of this file kept somewhere that isn't the repo.
//
// It also DEDUPES BY RUN ID against what's already on disk. The cursor alone
// would be enough in the normal case, but a state file lost or rewound would
// otherwise duplicate every run it re-fetched, and duplicates in a balance
// aggregate are silent — they don't look like an error, they look like more
// players agreeing with each other.
//
//   --out <path>    write somewhere else (default playtest/remote.jsonl)
//   --all           ignore the saved cursor and pull the whole collection
//   --index         list what the collection holds, download nothing
//   --url <url>     override the worker URL
//   --limit N       stop after about N runs
// ---------------------------------------------------------------------------

import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DEFAULT_OUT = resolve(ROOT, 'playtest/remote.jsonl');

// The cursor belongs to the FILE, not to the repo. A fixed state path would
// mean a pull into somewhere else — a scratch copy, a second collection —
// leaves its cursor behind as the one the next real pull starts from, and a
// cursor that has run ahead does not fail, it silently skips every run in
// between. Keeping them together makes that impossible.
const stateFileFor = (out) => `${out}.state.json`;

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT, all: false, index: false, url: null, limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = resolve(process.cwd(), argv[++i]);
    else if (a === '--all') args.all = true;
    else if (a === '--index') args.index = true;
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else {
      console.error(`unknown option: ${a}`);
      printHelp();
      process.exit(1);
    }
  }
  return args;
}

function printHelp() {
  console.log(`
  npm run playtest:pull -- [options]

    --out <path>   write somewhere else (default playtest/remote.jsonl)
    --all          ignore the saved cursor and pull everything
    --index        list what the collection holds, download nothing
    --url <url>    override PLAYTEST_URL
    --limit N      stop after about N runs

  Needs PLAYTEST_URL and PLAYTEST_TOKEN — see server/playtest/README.md.
`);
}

// The credentials live in the environment, not in a file under git. Read from
// a .env in the repo root as a convenience, since that's where the build
// already keeps VITE_PLAYTEST_URL and it saves keeping the URL in two places.
async function loadEnv() {
  const env = { ...process.env };
  try {
    const text = await readFile(resolve(ROOT, '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i.exec(line);
      if (!m) continue;
      // Only fills gaps — a variable exported in the shell beats the file, so
      // a one-off pull against a preview worker doesn't need the file edited.
      if (env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env — the shell had better have them */ }
  return env;
}

async function readState(out) {
  try {
    return JSON.parse(await readFile(stateFileFor(out), 'utf8'));
  } catch {
    return { after: '' };
  }
}

/** Run ids already on disk, so a re-pull can't double-count them. */
async function existingIds(file) {
  const ids = new Set();
  try {
    const text = await readFile(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const id = JSON.parse(line).id;
        if (id) ids.add(id);
      } catch { /* a truncated last line from an interrupted append */ }
    }
  } catch { /* no file yet */ }
  return ids;
}

async function request(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new Error('rejected: PLAYTEST_TOKEN does not match the worker secret');
  if (res.status === 503) throw new Error('the worker has no PULL_TOKEN set — run `npx wrangler secret put PULL_TOKEN` in server/playtest/');
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = await loadEnv();
  const base = (args.url ?? env.PLAYTEST_URL ?? env.VITE_PLAYTEST_URL ?? '').replace(/\/+$/, '');
  const token = env.PLAYTEST_TOKEN ?? '';

  if (!base) {
    console.error('No worker URL. Set PLAYTEST_URL in .env, or pass --url.\nSee server/playtest/README.md.\n');
    process.exit(1);
  }
  if (!token) {
    console.error('No PLAYTEST_TOKEN. Set it in .env to the value you gave `wrangler secret put PULL_TOKEN`.\nSee server/playtest/README.md.\n');
    process.exit(1);
  }

  if (args.index) return await showIndex(base, token);

  const state = args.all ? { after: '' } : await readState(args.out);
  const seen = await existingIds(args.out);
  await mkdir(dirname(args.out), { recursive: true });

  let after = state.after ?? '';
  let pulled = 0;
  let skipped = 0;

  for (;;) {
    const url = `${base}/runs?after=${encodeURIComponent(after)}`;
    const page = await request(url, token);
    const runs = page.runs ?? [];

    const fresh = runs.filter((r) => r.id && !seen.has(r.id));
    for (const r of fresh) seen.add(r.id);
    skipped += runs.length - fresh.length;

    if (fresh.length) {
      // One JSON object per line, matching playtest/runs.jsonl exactly, so
      // the report doesn't need to know which file it's reading.
      await appendFile(args.out, fresh.map((r) => JSON.stringify(r)).join('\n') + '\n');
      pulled += fresh.length;
    }

    // The cursor is saved after EVERY page, not at the end. An interrupted
    // pull of a thousand runs then resumes where it stopped instead of
    // starting over — and since the append already happened, a cursor saved
    // late is the case that would duplicate, not the case that would lose.
    after = page.after ?? after;
    await writeFile(stateFileFor(args.out), JSON.stringify({ after, at: Date.now() }, null, 2) + '\n');

    process.stdout.write(`\r  pulled ${pulled} run${pulled === 1 ? '' : 's'}…`);
    if (page.done || pulled >= args.limit) break;
  }

  process.stdout.write('\r');
  if (!pulled) {
    console.log(`Nothing new. ${seen.size} run${seen.size === 1 ? '' : 's'} already in ${rel(args.out)}.`);
  } else {
    console.log(`Pulled ${pulled} run${pulled === 1 ? '' : 's'} into ${rel(args.out)} (${seen.size} total).`);
  }
  if (skipped) console.log(`  ${skipped} already had — skipped.`);
  console.log(`\nRead them with:\n  npm run playtest -- --remote\n`);
}

async function showIndex(base, token) {
  let after = '';
  const rows = [];
  for (;;) {
    const page = await request(`${base}/runs?index=1&after=${encodeURIComponent(after)}`, token);
    rows.push(...(page.index ?? []));
    after = page.after ?? after;
    if (page.done) break;
  }

  if (!rows.length) {
    console.log('The collection is empty.');
    return;
  }

  // Grouped by build, because that's the axis a decision gets made on: a
  // build with four runs is not evidence, and a run count spread over six
  // builds is six small samples wearing one big one's clothes.
  const byBuild = new Map();
  for (const r of rows) {
    const b = byBuild.get(r.build) ?? { runs: 0, clients: new Set(), secs: 0, first: Infinity, last: 0 };
    b.runs += 1;
    b.clients.add(r.client);
    b.secs += r.dur ?? 0;
    b.first = Math.min(b.first, r.at ?? Infinity);
    b.last = Math.max(b.last, r.at ?? 0);
    byBuild.set(r.build, b);
  }

  const bytes = rows.reduce((n, r) => n + (r.bytes ?? 0), 0);
  console.log(`\n  ${rows.length} runs collected, ${(bytes / 1048576).toFixed(1)} MB\n`);
  console.log('  build              runs  players  median run  first seen');
  console.log('  ' + '-'.repeat(58));
  const sorted = [...byBuild.entries()].sort((a, b) => b[1].last - a[1].last);
  for (const [build, b] of sorted) {
    const median = b.runs ? b.secs / b.runs : 0;
    console.log(
      `  ${build.padEnd(18)} ${String(b.runs).padStart(4)}  ${String(b.clients.size).padStart(7)}  ${clock(median).padStart(10)}  ${new Date(b.first).toISOString().slice(0, 10)}`,
    );
  }
  console.log('');
}

function clock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function rel(p) {
  return p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p;
}

main().catch((err) => {
  console.error(`\nPull failed: ${err.message}\n`);
  process.exit(1);
});
