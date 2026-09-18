#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:mergeguard
//
// THE TUNING MERGE RULE IS THE KIND THAT CAN BE ABSENT WITHOUT LOOKING ABSENT.
//
// .gitattributes says `path/src/imported-tuning.json merge=ours`, and git has
// no built-in driver by that name. With the attribute set and no driver in
// config, git does not warn, does not fall back to something safe, and does
// not mention the attribute at all — it runs an ordinary 3-way merge and
// conflicts, exactly as if .gitattributes had never been written. The file
// LOOKS like protection and is worth nothing.
//
// So checking the attribute alone would be a green light that means nothing.
// This does three things instead:
//
//   1. the attribute is present, and git agrees it applies to that path
//   2. merge.ours.driver is set in this clone
//   3. A REAL MERGE, in a throwaway repo, actually keeps our side
//
// (3) is the one that matters. It is the same self-checking shape as
// test:copy verifying its own detector first: if some future git drops or
// renames the mechanism, this fails loudly rather than certifying a rule that
// silently stopped being enforced.
//
//   node tools/merge-driver-test.mjs
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const GUARDED = 'path/src/imported-tuning.json';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail && !cond ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};
const git = (args, cwd = ROOT) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

section('the attribute');
{
  let attrs = '';
  try { attrs = readFileSync(join(ROOT, '.gitattributes'), 'utf8'); } catch { /* reported below */ }
  check('.gitattributes exists and names the tuning file', attrs.includes(GUARDED),
    'without it every branch merge can replay a stale snapshot over live tuning');

  // Ask git rather than trusting the text: a pattern can be present and still
  // not match the path it was meant for.
  let applied = '';
  try { applied = git(['check-attr', 'merge', '--', GUARDED]); } catch { /* reported below */ }
  check(`git resolves merge=ours for ${GUARDED}`, applied.endsWith(': merge: ours'),
    `git says "${applied || '(nothing)'}"`);
}

section('the driver this clone actually has');
{
  let driver = '';
  try { driver = git(['config', '--get', 'merge.ours.driver']); } catch { /* unset */ }
  check('merge.ours.driver is configured', driver !== '',
    'run `npm run mergedriver` — the attribute above does NOTHING without it');
}

section('a real merge keeps our side');
{
  // Proving the mechanism, not the config: a throwaway repo, a genuine
  // divergence on the guarded path, and a genuine `git merge`.
  const dir = mkdtempSync(join(tmpdir(), 'mergeguard-'));
  try {
    const g = (...a) => git(a, dir);
    g('init', '-q', '-b', 'main', '.');
    g('config', 'user.email', 'test@example.invalid');
    g('config', 'user.name', 'mergeguard');
    g('config', 'merge.ours.driver', 'true');
    writeFileSync(join(dir, '.gitattributes'), 'tuning.json merge=ours\n');
    writeFileSync(join(dir, 'tuning.json'), '{"v":"base"}\n');
    g('add', '-A'); g('commit', '-qm', 'base');

    g('checkout', '-qb', 'stale-branch');
    writeFileSync(join(dir, 'tuning.json'), '{"v":"STALE-BRANCH-SNAPSHOT"}\n');
    g('commit', '-qam', 'branch drifts');

    g('checkout', '-q', 'main');
    writeFileSync(join(dir, 'tuning.json'), '{"v":"LIVE-MAIN-TUNING"}\n');
    g('commit', '-qam', 'main is tuned');

    let merged = true;
    try { g('merge', 'stale-branch', '-m', 'merge'); } catch { merged = false; }
    check('the merge completes without conflict', merged);

    const after = readFileSync(join(dir, 'tuning.json'), 'utf8');
    check('main\'s tuning survived the merge', after.includes('LIVE-MAIN-TUNING'),
      `file now holds ${after.trim()}`);
    check('the branch\'s stale snapshot did not land', !after.includes('STALE-BRANCH-SNAPSHOT'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

section('the guard would notice if the driver vanished');
{
  // The detector's own detector. Same repo shape, driver deliberately absent:
  // if THIS still merges cleanly then `ours` has become a built-in somewhere
  // and the checks above have stopped proving anything.
  const dir = mkdtempSync(join(tmpdir(), 'mergeguard-neg-'));
  try {
    const g = (...a) => git(a, dir);
    g('init', '-q', '-b', 'main', '.');
    g('config', 'user.email', 'test@example.invalid');
    g('config', 'user.name', 'mergeguard');
    writeFileSync(join(dir, '.gitattributes'), 'tuning.json merge=ours\n');
    writeFileSync(join(dir, 'tuning.json'), '{"v":"base"}\n');
    g('add', '-A'); g('commit', '-qm', 'base');
    g('checkout', '-qb', 'side');
    writeFileSync(join(dir, 'tuning.json'), '{"v":"branch"}\n');
    g('commit', '-qam', 'side');
    g('checkout', '-q', 'main');
    writeFileSync(join(dir, 'tuning.json'), '{"v":"main"}\n');
    g('commit', '-qam', 'main');

    let conflicted = false;
    try { g('merge', 'side', '-m', 'merge'); } catch { conflicted = true; }
    check('without the driver the same merge conflicts', conflicted,
      'git now honours merge=ours on its own — this test is measuring nothing, rewrite it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(failures ? `\n${failures} failing\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
