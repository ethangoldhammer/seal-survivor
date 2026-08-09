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
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeRun, analyzeRuns, formatRunReport, formatAggregateReport, formatClock } from '../path/src/systems/playtestAnalysis.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOG = resolve(HERE, '../playtest/runs.jsonl');

function parseArgs(argv) {
  const args = { last: Infinity, since: null, min: 60, runs: false, json: false, file: DEFAULT_LOG };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--last') args.last = Number(argv[++i]);
    else if (a === '--since') args.since = new Date(argv[++i]).getTime();
    else if (a === '--min') args.min = Number(argv[++i]);
    else if (a === '--runs') args.runs = true;
    else if (a === '--json') args.json = true;
    else if (a === '--file') args.file = resolve(process.cwd(), argv[++i]);
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
  npm run playtest -- [options]

    --last N        only the N most recent runs
    --since <date>  only runs started after this date
    --min <sec>     ignore runs shorter than this (default 60)
    --runs          print the full per-run report for each run too
    --json          machine-readable dump
    --file <path>   read a different log file
`);
}

async function readRuns(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`No runs yet — ${file} does not exist.\n`);
      console.error('Play a run with `npm run dev` open and it will be filed automatically.');
      console.error('(Runs are only written to disk by the dev server; a production build records nothing.)');
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

const args = parseArgs(process.argv.slice(2));
let runs = await readRuns(args.file);

if (args.since != null && !Number.isNaN(args.since)) runs = runs.filter((r) => (r.startedAt ?? 0) >= args.since);
runs = runs.filter((r) => (r.duration ?? 0) >= args.min);
runs.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
if (Number.isFinite(args.last)) runs = runs.slice(-args.last);

if (!runs.length) {
  console.error('No runs matched those filters.');
  process.exit(1);
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

console.log(`\n${runs.length} run${runs.length === 1 ? '' : 's'} from ${args.file}`);
if (groups.size > 1) {
  console.log(`${groups.size} different difficulty settings in this log — reported separately, because they are not the same game.`);
}

for (const [, group] of groups) {
  const first = group[0];
  console.log('\n' + '='.repeat(74));
  console.log(`${describeRamp(first)}  ·  ${group.length} run${group.length === 1 ? '' : 's'}`);
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
