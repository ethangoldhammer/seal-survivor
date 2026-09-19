#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:ci — the gate a GitHub runner can actually hold.
//
// WHY NOT JUST `npm test`. Two reasons, and the second is the important one.
//
// 1. Five of the 301 tests need a Mac. They drive a real Electron window,
//    call screencapture, or ask Xcode about a paired phone. On ubuntu-latest
//    they do not fail meaningfully — they fail because the machine is not a
//    Mac, which tells you nothing about the commit.
//
// 2. `npm test` is one long && chain, so THE FIRST FAILURE HIDES THE REST.
//    That is tolerable when you are sitting in front of it and can re-run;
//    it is miserable in CI, where each round trip is minutes and you find out
//    about the next broken test only after fixing this one. This runs every
//    test and reports all of them at the end.
//
// THE LIST IS DERIVED, NOT MAINTAINED. It reads the same `test` chain out of
// package.json that `npm test` runs and subtracts the exclusions below, so a
// new test:* script is in this gate the moment it joins the chain — the same
// rule tools/ship.mjs uses. A hand-kept second list of 300 names would drift
// within a week, which is exactly how 8,164 build files ended up tracked.
//
// IT IS `ci:test`, NOT `test:ci`, and the prefix is load-bearing. tools/ship.mjs
// builds its gate list from every script starting with `test:`, so a name in
// that namespace would make `npm run ship` run all 296 of these a second time,
// on top of running each one individually.
//
//   npm run ci:test            run the gate
//   npm run ci:test -- --list  print what would run, run nothing
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cpus } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');

// Each of these needs macOS or a desktop session. The reason is recorded so
// that "why is this not in CI" never has to be re-derived from the source.
const DESKTOP_ONLY = {
  'test:shipios':   'asks Xcode/devicectl about paired iPhones',
  'test:shipmac':   'checks the packaged Mac app',
  'test:capture':   'drives Electron + screencapture for the 1920x1080 take',
  'test:record':    'drives Electron + screencapture for the take file',
  'test:splashhit': 'drives a real Electron window to hit-test the title card',

  // Added after the first CI run failed on it. Its guard is `which swift`,
  // and ubuntu-latest SHIPS Swift — so the guard passes and the compile then
  // dies on `import Vision`, a macOS framework. Detecting the binary is not
  // detecting the platform, which is the whole reason this was mis-classified.
  'test:qr': 'needs Apple Vision via swift; ubuntu has swift but not Vision',

  // Compares the built .riv against its .rml sources BY MTIME (see the note
  // in the test itself). Git does not record mtimes, so on a fresh clone
  // every file carries its checkout time and the comparison measures checkout
  // order. It cannot mean anything in CI, whatever the repo's real state.
  'test:rivecopy': 'mtime comparison; a fresh clone has no meaningful mtimes',
};
// test:sfxtrim stays IN: it detects its missing macOS binary and exits early
// rather than failing.

const TIMEOUT_MS = 300000;
const CONCURRENCY = Math.max(2, Math.min(6, cpus().length - 1));

const scripts = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).scripts;
const chain = scripts.test.split('&&').map((s) => s.trim().replace(/^npm run /, '')).filter(Boolean);

// A stale exclusion is worse than none: it silently drops a test that was
// renamed rather than retired. Fail loudly instead of quietly skipping.
const stale = Object.keys(DESKTOP_ONLY).filter((n) => !chain.includes(n));
if (stale.length) {
  console.error(`\nDESKTOP_ONLY names nothing in the test chain: ${stale.join(', ')}`);
  console.error('Renamed or removed? Update tools/ci-tests.mjs.\n');
  process.exit(1);
}

const run = chain.filter((n) => !(n in DESKTOP_ONLY));

if (process.argv.includes('--list')) {
  console.log(run.join('\n'));
  console.log(`\n${run.length} of ${chain.length} (${chain.length - run.length} desktop-only)`);
  process.exit(0);
}

console.log(`${run.length} tests (${chain.length - run.length} desktop-only, skipped), ${CONCURRENCY} at a time\n`);

const results = [];
let next = 0;

const one = (name) => new Promise((done) => {
  const t0 = Date.now();
  let timedOut = false;
  const child = execFile('npm', ['run', '--silent', name], { cwd: ROOT, maxBuffer: 1 << 26 },
    (err, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`;
      done({
        name,
        ms: Date.now() - t0,
        ok: !err && !timedOut,
        why: timedOut ? `timed out after ${TIMEOUT_MS / 1000}s` : '',
        output,
      });
    });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, TIMEOUT_MS);
  child.on('exit', () => clearTimeout(timer));
});

async function worker() {
  for (let i = next++; i < run.length; i = next++) {
    const r = await one(run[i]);
    results.push(r);
    process.stdout.write(r.ok ? '.' : 'F');
    if (results.length % 60 === 0) process.stdout.write(`  ${results.length}/${run.length}\n`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const failed = results.filter((r) => !r.ok).sort((a, b) => a.name.localeCompare(b.name));
console.log(`\n\n${results.length - failed.length}/${results.length} passed\n`);

for (const f of failed) {
  console.log(`${'='.repeat(70)}\nFAIL  ${f.name}${f.why ? `  (${f.why})` : ''}`);
  const lines = f.output.trimEnd().split('\n');
  // THE FAILING LINES FIRST, then context. A plain tail was the first
  // version and it was useless on the first real run: hub prints twenty
  // passing assertions after its two failures, so the tail showed a wall of
  // `ok` under the word FAIL and the actual cause had scrolled off. These
  // harnesses print their verdict wherever it happens, not at the end.
  const hits = lines
    .map((l, i) => [l, i])
    .filter(([l]) => /\bFAIL\b|\bError\b|error:|Traceback|not ok/.test(l));
  if (hits.length) {
    console.log(`  ${hits.length} failing line(s):`);
    for (const [l] of hits.slice(0, 20)) console.log(`  ${l.trim()}`);
    console.log('  --- last 20 lines of output ---');
  }
  console.log(lines.slice(-20).join('\n'));
}

if (failed.length) {
  console.log(`\n${failed.length} failing: ${failed.map((f) => f.name).join(', ')}\n`);
  process.exit(1);
}
console.log('all good\n');
