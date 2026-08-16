#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run playtest [-- options]
//
// Reads every run the game has filed to playtest/runs.jsonl and prints the
// balance read: does enemy pressure outgrow player output, and is any ability
// returning more than the picks spent on it.
//
// The verdicts come from path/src/systems/playtestAnalysis.js — the same
// module the in-game B panel uses, imported directly rather than reimplemented,
// so the terminal and the overlay can never disagree about what "balanced"
// means. That file imports nothing, which is what makes this possible without
// a bundler.
//
//   --last N        only the N most recent runs
//   --since <date>  only runs started after this date (anything Date can parse)
//   --min <sec>     ignore runs shorter than this (default 60)
//   --runs          also print the full per-run report for each run
//   --json          machine-readable dump instead of the text report
//   --file <path>   read a different log (e.g. one downloaded from a browser)
//   --remote        read runs pulled from the live site (playtest/remote.jsonl)
//   --all           read both the local and the pulled logs
//   --build <sha>   only runs played on this build (prefix match)
//   --client <id>   only runs from one browser
//   --who           who and what is in the log, and print nothing else
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeRun, analyzeRuns, formatRunReport, formatAggregateReport, formatClock } from '../path/src/systems/playtestAnalysis.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOG = resolve(HERE, '../playtest/runs.jsonl');
// Runs collected from the live site, brought down by `npm run playtest:pull`.
// A SEPARATE FILE from the local log, not merged into it: runs played against
// half-saved tuning on a dev server and runs played by someone else on a
// shipped build are different evidence, and a report has to be able to ask for
// one without the other. `--all` reads both when that's what you want.
const REMOTE_LOG = resolve(HERE, '../playtest/remote.jsonl');

function parseArgs(argv) {
  const args = {
    last: Infinity, since: null, min: 60, runs: false, json: false,
    files: null, build: null, client: null, who: false,
  };
  let remote = false;
  let all = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--last') args.last = Number(argv[++i]);
    else if (a === '--since') args.since = new Date(argv[++i]).getTime();
    else if (a === '--min') args.min = Number(argv[++i]);
    else if (a === '--runs') args.runs = true;
    else if (a === '--json') args.json = true;
    else if (a === '--file') (args.files ??= []).push(resolve(process.cwd(), argv[++i]));
    else if (a === '--remote') remote = true;
    else if (a === '--all') all = true;
    else if (a === '--build') args.build = argv[++i];
    else if (a === '--client') args.client = argv[++i];
    else if (a === '--who') args.who = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else {
      console.error(`unknown option: ${a}`);
      printHelp();
      process.exit(1);
    }
  }
  // An explicit --file always wins; otherwise the flags pick the defaults.
  if (!args.files) {
    if (all) args.files = [DEFAULT_LOG, REMOTE_LOG];
    else if (remote) args.files = [REMOTE_LOG];
    else args.files = [DEFAULT_LOG];
  }
  return args;
}

function printHelp() {
  console.log(`
  npm run playtest -- [options]

    --last N        only the N most recent runs
    --since <date>  only runs started after this date
    --min <sec>     ignore runs shorter than this (default 60)
    --runs          print the full per-run report for each run too
    --json          machine-readable dump
    --file <path>   read a different log file (repeatable)
    --remote        read runs pulled from the live site
    --all           read both the local and the pulled logs
    --build <sha>   only runs played on this build (prefix match)
    --client <id>   only runs from one browser
    --who           summarise who and what is in the log, print nothing else
`);
}

async function readRuns(file, optional = false) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      // With --all, one of the two logs missing is the normal state, not an
      // error: a machine that has only ever played locally has no remote log,
      // and one that only reads the collection has no local one.
      if (optional) return [];
      console.error(`No runs yet — ${file} does not exist.\n`);
      if (file.endsWith('remote.jsonl')) {
        console.error('Runs played on the live site are collected by the worker in server/playtest/.');
        console.error('Bring them down with `npm run playtest:pull`.');
      } else {
        console.error('Play a run with `npm run dev` open and it will be filed automatically.');
        console.error('(Runs from a deployed build go to the collection worker instead — see `npm run playtest:pull`.)');
      }
      process.exit(1);
    }
    throw err;
  }
  const runs = [];
  let skipped = 0;
  // One object per line. A half-written final line is expected — the browser
  // can be closed mid-append — so a bad line is counted and stepped over
  // rather than being allowed to kill the report.
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      runs.push(JSON.parse(trimmed));
    } catch {
      skipped += 1;
    }
  }
  if (skipped) console.error(`(skipped ${skipped} unreadable line${skipped === 1 ? '' : 's'} in the log)\n`);
  return runs;
}

// Runs recorded under different difficulty knobs are not the same experiment.
// Grouping by the ramp fingerprint means a report can say "these 6 runs were
// played under the current numbers, these 3 under the old ones" instead of
// silently averaging a tuning change away.
function rampKey(run) {
  const c = run.config ?? {};
  const r = c.ramp ?? {};
  return JSON.stringify([c.difficultyPerSecond, r.hp, r.hpMax, r.damage, r.damageMax, r.speed, r.speedMax, c.countPerDifficulty, c.baseInterval]);
}

function describeRamp(run) {
  const c = run.config ?? {};
  const r = c.ramp ?? {};
  if (!r.hp && !r.damage && !r.speed) return 'no stat ramp';
  return `ramp hp +${(r.hp * 100).toFixed(1)}%/20s, dmg +${(r.damage * 100).toFixed(1)}%, speed +${(r.speed * 100).toFixed(1)}%`;
}

/**
 * Who and what is in the log — the view to read BEFORE trusting any average.
 *
 * A hundred runs is not a hundred opinions if ninety of them are one person,
 * and it is not one experiment if they span four builds. Both of those are
 * invisible in the aggregate report, which will happily average across them
 * and produce a confident number about a game nobody played.
 */
function formatWho(runs) {
  const builds = new Map();
  const clients = new Map();
  for (const r of runs) {
    const b = r.meta?.build ?? 'unknown';
    const c = r.meta?.client ?? 'unknown';
    builds.set(b, (builds.get(b) ?? 0) + 1);
    const seen = clients.get(c) ?? { runs: 0, secs: 0, best: 0, touch: r.meta?.device?.touch };
    seen.runs += 1;
    seen.secs += r.duration ?? 0;
    seen.best = Math.max(seen.best, r.level ?? 0);
    clients.set(c, seen);
  }

  const out = [];
  out.push(`\n  ${runs.length} runs · ${builds.size} build${builds.size === 1 ? '' : 's'} · ${clients.size} browser${clients.size === 1 ? '' : 's'}\n`);

  out.push('  build                 runs');
  out.push('  ' + '-'.repeat(28));
  for (const [b, n] of [...builds].sort((x, y) => y[1] - x[1])) {
    out.push(`  ${b.padEnd(20)} ${String(n).padStart(4)}`);
  }

  out.push('\n  browser              runs   played  best lvl  input');
  out.push('  ' + '-'.repeat(52));
  for (const [c, s] of [...clients].sort((x, y) => y[1].runs - x[1].runs)) {
    out.push(
      `  ${c.padEnd(20)} ${String(s.runs).padStart(4)} ${formatClock(s.secs).padStart(8)} ${String(s.best).padStart(9)}  ${s.touch ? 'touch' : 'kbd'}`,
    );
  }

  // The thing most likely to make the aggregate a lie, said out loud rather
  // than left for someone to notice.
  const top = [...clients.values()].sort((a, b) => b.runs - a.runs)[0];
  if (top && clients.size > 1 && top.runs / runs.length > 0.5) {
    out.push(`\n  NOTE: one browser is ${Math.round((top.runs / runs.length) * 100)}% of these runs — the aggregate is mostly that player.`);
  }
  if (builds.size > 1) {
    out.push('\n  More than one build here. Use --build <sha> to read a single game.');
  }
  return out.join('\n') + '\n';
}

const args = parseArgs(process.argv.slice(2));
const loaded = [];
for (const file of args.files) loaded.push(...(await readRuns(file, args.files.length > 1)));
// --all can present the same run twice if it was pulled into the remote log
// and also happens to sit in the local one. Deduped by id: a duplicated run in
// a balance aggregate does not look like an error, it looks like agreement.
const byId = new Map();
for (const r of loaded) byId.set(r.id ?? Symbol(), r);
let runs = [...byId.values()];

if (args.since != null && !Number.isNaN(args.since)) runs = runs.filter((r) => (r.startedAt ?? 0) >= args.since);
if (args.build) runs = runs.filter((r) => (r.meta?.build ?? '').startsWith(args.build));
if (args.client) runs = runs.filter((r) => (r.meta?.client ?? '') === args.client);
runs = runs.filter((r) => (r.duration ?? 0) >= args.min);
runs.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
if (Number.isFinite(args.last)) runs = runs.slice(-args.last);

if (!runs.length) {
  console.error('No runs matched those filters.');
  process.exit(1);
}

if (args.who) {
  console.log(formatWho(runs));
  process.exit(0);
}

if (args.json) {
  console.log(JSON.stringify(analyzeRuns(runs), null, 2));
  process.exit(0);
}

// Group by tuning fingerprint, newest group last — the group you're currently
// playing under is the one at the bottom, where you'll be looking.
const groups = new Map();
for (const run of runs) {
  const key = rampKey(run);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(run);
}

console.log(`\n${runs.length} run${runs.length === 1 ? '' : 's'} from ${args.files.join(', ')}`);
if (groups.size > 1) {
  console.log(`${groups.size} different difficulty settings in this log — reported separately, because they are not the same game.`);
}

for (const [, group] of groups) {
  const first = group[0];
  console.log('\n' + '='.repeat(74));
  console.log(`${describeRamp(first)}  ·  ${group.length} run${group.length === 1 ? '' : 's'}`);
  // The ramp fingerprint only sees CONFIG.spawn — it cannot notice a change
  // to weapons.csv, an upgrade's numbers, or a creature's hp, all of which
  // change what these runs mean. The build id sees everything, so a group
  // that spans builds is flagged even though its ramp matched.
  const builds = [...new Set(group.map((r) => r.meta?.build ?? 'unknown'))];
  const clients = new Set(group.map((r) => r.meta?.client ?? 'unknown'));
  if (builds.length === 1 && builds[0] !== 'unknown') {
    console.log(`build ${builds[0]}  ·  ${clients.size} browser${clients.size === 1 ? '' : 's'}`);
  } else if (builds.length > 1) {
    console.log(`SPANS ${builds.length} BUILDS (${builds.slice(0, 4).join(', ')}${builds.length > 4 ? ', …' : ''}) — same spawn ramp, but everything else may have moved. --build <sha> to separate them.`);
  }
  console.log('='.repeat(74) + '\n');
  console.log(formatAggregateReport(analyzeRuns(group)));

  if (args.runs) {
    for (const run of group) {
      console.log('\n' + '-'.repeat(74));
      console.log(`${new Date(run.startedAt).toLocaleString()} — ${formatClock(run.duration)}`);
      console.log('-'.repeat(74));
      console.log(formatRunReport(analyzeRun(run)));
    }
  }
}
console.log('');
