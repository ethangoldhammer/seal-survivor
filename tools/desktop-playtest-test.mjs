#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run desktop:test:playtest
//
// THE RUN LOG — that a run finished in the desktop build ends up somewhere
// `npm run perf` can read it.
//
// Every failure here is silent, and that is the whole reason it is worth a
// test: the desktop build recorded frame times for months and dropped every
// one of them, because the destination it was reaching for (a Vite middleware
// declared `apply: 'serve'`) does not exist behind a packaged app. Nothing
// threw. The report simply never had a desktop row in it, which reads exactly
// like a build nobody has played.
//
// So the four things that would bring that back:
//
//   THE BRIDGE MUST BE REACHABLE FROM THE PAGE'S WORLD. contextBridge exposes
//   across an isolated-world boundary out of a sandboxed preload. A capability
//   missing there is not an error — platform.js reads it as "this is a
//   browser" and the run goes back to being dropped.
//
//   THE RENDERER MUST ACTUALLY CALL IT. The bridge working and the game using
//   it are different facts, and the bundle is where the second one is settled.
//
//   A BAD RECORD MUST LEAVE NOTHING BEHIND. A half-written line makes every
//   future `npm run perf` warn about a malformed file — a permanent complaint
//   about a log that is otherwise fine.
//
//   THE TRIM MUST CUT ON A LINE. Same failure, arrived at from the other end:
//   a byte-offset cut leaves a fragment at the head of the file forever.
//
// Runs the real Electron shell against dist-desktop with a THROWAWAY userData
// directory — see electron/playtest-smoke.js.
//
//   node tools/desktop-playtest-test.mjs
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { existsSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ELECTRON = join(ROOT, 'node_modules/.bin/electron');
const SMOKE = join(ROOT, 'electron/playtest-smoke.js');
const DIST = join(ROOT, 'dist-desktop');

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

console.log('\nDESKTOP RUN LOG — a finished run reaches userData, and npm run perf');

if (!existsSync(ELECTRON)) {
  console.log('\n  FAIL electron is not installed — run `npm i`\n');
  process.exit(1);
}
if (!existsSync(join(DIST, 'index.html'))) {
  console.log('\n  FAIL no dist-desktop/ — run `npm run build:desktop` first\n');
  process.exit(1);
}

const out = await new Promise((done) => {
  const child = spawn(ELECTRON, [SMOKE], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; });
  child.stderr.on('data', (d) => { buf += d; });
  child.on('close', () => done(buf));
});

const line = out.split('\n').find((l) => l.startsWith('SEAL_PLAYTEST '));
if (!line) {
  console.log('\n  FAIL the shell produced no result\n');
  console.log(out.split('\n').slice(-25).join('\n'));
  process.exit(1);
}

const r = JSON.parse(line.slice('SEAL_PLAYTEST '.length));
if (r.error) {
  console.log(`\n  FAIL ${r.error}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
section('the page can reach the shell');
{
  check(
    'filePlaytest is a function in the page\'s own world',
    r.caps.filePlaytest === true,
    'the expression platform.js keys on, read from the main world',
  );
  check('and the shell still identifies itself', r.caps.isDesktop === true);
}

// ---------------------------------------------------------------------------
section('a run reaches the file');
{
  check('the first run is filed', r.filedFirst === true);
  check('and the second', r.filedSecond === true);
  check('two runs are two lines', r.afterTwo.length === 2, `${r.afterTwo.length} line(s)`);
  // The claim that makes a desktop run comparable to a posted one at all.
  check(
    'the bytes on disk are the bytes the page sent',
    r.afterTwo[0] === r.expected[0] && r.afterTwo[1] === r.expected[1],
    'byte-identical to the body a POST would have carried',
  );
  check(
    'in the order they were played',
    JSON.parse(r.afterTwo[0]).level === 1 && JSON.parse(r.afterTwo[1]).level === 2,
  );
  check(
    'the device profile says which shell played it',
    JSON.parse(r.afterTwo[0]).meta?.device?.shell === 'desktop',
    'without this a desktop run is fused to a browser run on the same machine',
  );
}

// ---------------------------------------------------------------------------
section('a bad record leaves nothing behind');
{
  check('text that is not JSON is refused', r.refused.notJson === false);
  check('a JSON array is refused', r.refused.array === false, 'a run is an object');
  check('an empty string is refused', r.refused.empty === false);
  check('the literal null is refused', r.refused.null === false);
  check(
    'a record over the per-record cap is refused',
    r.refused.huge === false,
    'a future accumulator that stopped aggregating fails on run one, not on disk',
  );
  check(
    'and none of them wrote a line',
    r.refused.linesAfter === 2,
    `${r.refused.linesAfter} line(s) — still just the two real runs`,
  );
}

// ---------------------------------------------------------------------------
section('one run is always one line');
{
  check('a record with newlines in it is filed', r.newline.filed === true);
  check(
    'and is still a single line',
    r.newline.lines === 3,
    `${r.newline.lines} line(s) — JSON.stringify escapes them, JSONL stays parseable`,
  );
}

// ---------------------------------------------------------------------------
section('the log cannot run away');
{
  check(
    'the log grew past its cap to set this up',
    r.beforeTrim.bytes > r.maxBytes,
    `${(r.beforeTrim.bytes / 1024 / 1024).toFixed(1)}MB over an ${(r.maxBytes / 1024 / 1024).toFixed(0)}MB cap`,
  );
  check('a run still files against an oversized log', r.filedAfterTrim === true);
  check(
    'and the log is back under the cap',
    r.afterTrim.bytes < r.maxBytes,
    `${(r.afterTrim.bytes / 1024 / 1024).toFixed(1)}MB, ${r.afterTrim.lines} runs`,
  );
  check(
    'every surviving line still parses',
    r.afterTrim.allParse === true,
    'a byte-offset cut would leave a fragment that warns forever',
  );
  check('the newest run is the last line', r.afterTrim.lastMarker === 'after-trim');
  check(
    'and the recent history survived rather than the oldest',
    r.afterTrim.keptMarkerBefore === true,
    'a trim keeps the tail',
  );
}

// ---------------------------------------------------------------------------
// THE BUNDLE, not the shell. The three sections above prove the bridge works;
// this one proves the game uses it. They fail independently — a build that
// aliased systems/playtest.js out, or a persist() that stopped calling the
// bridge, would pass everything above and still file nothing.
section('the built game actually calls it');
{
  const bundles = readdirSync(join(DIST, 'assets')).filter((f) => f.endsWith('.js'));
  const src = bundles.map((f) => readFileSync(join(DIST, 'assets', f), 'utf8')).join('\n');
  check(
    'dist-desktop reaches for filePlaytest',
    src.includes('filePlaytest'),
    `${bundles.length} bundle(s) searched`,
  );
}

// The sandbox userData directory, which exists only for this run.
try {
  if (r.sandbox?.includes('seal-playtest-')) rmSync(r.sandbox, { recursive: true, force: true });
} catch { /* a temp directory that outlives the test is not a failure */ }

console.log(
  failures
    ? `\n${failures} failure${failures === 1 ? '' : 's'}.\n`
    : '\nA desktop run lands on disk, whole, and npm run perf can find it.\n',
);
process.exit(failures ? 1 : 0);
