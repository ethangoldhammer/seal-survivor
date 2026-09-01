#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:chain
//
// THE CHAIN HAS TO CONTAIN EVERY SUITE, and nothing but a machine will keep it
// that way.
//
// `npm test` is one long `&&` chain typed out by hand in package.json. Writing
// a new suite and forgetting to add it there costs nothing and says nothing:
// the suite passes when you run it, `npm test` goes green without it, and the
// only symptom is a check that never runs again. It has drifted four times in
// a week — 172 of 172 after a hand-fix, then 184 of 188, 185 of 190, 190 of
// 198 — and every one of those gaps was found by counting rather than by
// anything failing.
//
// `npm run ship` is unaffected throughout: tools/ship.mjs builds its gate list
// by ENUMERATING every `test:*` script, so a suite outside the chain still
// blocks a deploy. That is exactly what makes this so easy to miss — the thing
// that matters keeps working while the thing you run by hand quietly stops
// being the whole suite. This file is the same enumeration, pointed at the
// chain.
//
// Four ways it can be wrong, and none of them throws on its own:
//
//   MISSING    A `test:*` script the chain never names. The check that exists
//              to catch something stops being run and nothing says so.
//   DEAD       A chain entry naming a script that does not exist. `&&` stops
//              at the first non-zero exit, so a typo here silently truncates
//              the suite — `test:dividend` did exactly this and took the 25
//              suites after it down with it for days.
//   DOUBLED    The same suite twice. Harmless to correctness and pure waste,
//              and a sign the list was edited by hand in two places.
//   UNDECLARED An exception nobody wrote a reason for. The one legitimate
//              exclusion is below, with the argument for it; anything else
//              being out is a bug rather than a decision.
//
//   npm run test:chain
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// THE ONE EXCEPTION, and the reason it is one.
//
// `test:copy` fails while any lorem or [DRAFT] string is staged in path/src,
// which is its whole job — see CLAUDE.md. In the chain it would hold `npm test`
// red for as long as a line is waiting on Ethan, and a check that is always red
// is a check you stop reading. That is the same argument the project already
// makes for not gating a ship on the 637-row review backlog: a gate nobody can
// clear today teaches the habit of ignoring gates.
//
// It still runs on every deploy, because ship.mjs enumerates rather than
// reading this chain. So: `npm test` asks whether the code works, and `ship`
// also asks whether the words are written.
// ---------------------------------------------------------------------------
const EXCEPTIONS = new Map([
  ['test:copy', 'blocks on unwritten copy by design — ship.mjs still runs it'],
]);

const scripts = Object.keys(pkg.scripts);
const suites = scripts.filter((k) => k.startsWith('test:') && k !== 'test');
const chain = String(pkg.scripts.test ?? '')
  .split('&&')
  .map((s) => s.trim().replace(/^npm run /, ''))
  .filter(Boolean);

console.log(`\n${suites.length} test:* scripts, ${chain.length} links in the chain`);

// --- DEAD ------------------------------------------------------------------
// First, because a chain that names a script which does not exist truncates
// itself at that point and every count below would be read against a suite
// that never finishes.
const dead = chain.filter((c) => !pkg.scripts[c]);
check('every link in the chain is a script that exists', dead.length === 0,
  dead.length ? `no such script: ${dead.join(', ')}` : `all ${chain.length} resolve`);

// --- DOUBLED ---------------------------------------------------------------
const seen = new Set();
const doubled = [...new Set(chain.filter((c) => (seen.has(c) ? true : (seen.add(c), false))))];
check('no suite is run twice', doubled.length === 0,
  doubled.length ? doubled.join(', ') : 'none repeated');

// --- MISSING ---------------------------------------------------------------
const inChain = new Set(chain);
const missing = suites.filter((s) => !inChain.has(s) && !EXCEPTIONS.has(s));
check('every test:* script is in the chain', missing.length === 0,
  missing.length
    ? `${missing.length} never run by npm test: ${missing.join(', ')}`
    : `all ${suites.length - EXCEPTIONS.size} of them, plus ${EXCEPTIONS.size} declared exception(s)`);

// --- UNDECLARED ------------------------------------------------------------
// An exception for a script that no longer exists is a reason nobody is
// reading any more, and would quietly excuse a future script of the same name.
const stale = [...EXCEPTIONS.keys()].filter((e) => !pkg.scripts[e]);
check('every declared exception is a real script', stale.length === 0,
  stale.length ? `no such script: ${stale.join(', ')}` : `${EXCEPTIONS.size} declared`);

// ...and an exception that IS in the chain is a stale note the other way: it
// was excused once and has since been added, so the reason below it is a lie
// about the current state.
const excused = [...EXCEPTIONS.keys()].filter((e) => inChain.has(e));
check('no declared exception is quietly in the chain anyway', excused.length === 0,
  excused.length ? excused.join(', ') : 'the list and the chain agree');

// --- THIS FILE -------------------------------------------------------------
// The guard has to be inside what it guards. Outside the chain it would only
// run on a deploy, which is the last moment anybody wants to find out that
// half the suite has not been running.
check('...and this check is itself in the chain', inChain.has('test:chain'),
  inChain.has('test:chain') ? 'guarded by the thing it guards' : 'test:chain is not in npm test');

for (const [name, why] of EXCEPTIONS) console.log(`        exception: ${name} — ${why}`);

console.log(failures ? `\n${failures} FAILED\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
