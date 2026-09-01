#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:frameguard
//
// The frame loop surviving a throw — systems/frameGuard.js.
//
// THE FREEZE THIS EXISTS FOR. three's setAnimationLoop schedules the next
// frame after the callback RETURNS, so a throw out of animate() does not drop
// one frame, it drops every frame after it. The renderer keeps its last
// picture, the audio graph plays on because it runs on its own clock, and the
// game is frozen with the music still going — not crashed, not reset, and with
// nothing in a console a player has.
//
// That is what every lock-up in this game has looked like, whatever the bug
// underneath it was: `t.hitShape` off the end of the enemy list was one
// instance, and tools/hit-guard-test.mjs covers that one. This covers the
// property that turned it into a dead game rather than a dropped frame.
//
// The last section is the one that would actually catch a regression: a
// perfect frameGuard.js that main.js has stopped calling is exactly as useful
// as no frameGuard.js at all.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { guardFrame, signatureOf } from '../path/src/systems/frameGuard.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
const survives = (fn) => {
  try { return { ok: true, value: fn() }; } catch (err) { return { ok: false, err }; }
};

section('A THROWING FRAME DOES NOT ESCAPE THE LOOP');
{
  const bad = guardFrame(() => { throw new Error('boom'); });
  const first = survives(() => bad(0));
  check('the guarded frame answers instead of throwing', first.ok, first.err?.message);
  // The whole point: three calls this again next frame only if it returned.
  let ran = 0;
  const again = guardFrame(() => { ran++; throw new Error('boom'); });
  for (let i = 0; i < 10; i++) survives(() => again(i));
  check('and it is still being run ten frames later', ran === 10, `ran ${ran}`);
}

section('A GOOD FRAME IS UNTOUCHED');
{
  const seen = [];
  const ok = guardFrame((a, b) => { seen.push([a, b]); return a + b; });
  check('arguments arrive as passed', ok(2, 3) === 5 && seen[0][0] === 2 && seen[0][1] === 3);
}

section('EVERY DISTINCT FAILURE IS ANNOUNCED ONCE');
{
  const reports = [];
  let n = 0;
  // The same error five times, then a different one.
  const g = guardFrame(() => {
    n++;
    throw new Error(n <= 5 ? 'same' : 'other');
  }, { report: (r) => reports.push(r) });
  for (let i = 0; i < 6; i++) g(i);
  check('every failing frame reports', reports.length === 6, `${reports.length}`);
  check('only the first of a signature is flagged `first`',
    reports.filter((r) => r.first).length === 2,
    `${reports.filter((r) => r.first).length} — one per distinct error`);
  check('a repeat is counted, not renamed', reports[4].count === 5, `count ${reports[4].count}`);
  check('a different error starts its own count', reports[5].count === 1 && reports[5].first);
}

section('A STREAK IS THE STREAK, AND IT RESETS');
{
  const reports = [];
  let mode = 'bad';
  const g = guardFrame(() => { if (mode === 'bad') throw new Error('boom'); },
    { report: (r) => reports.push(r), stuckAfter: 3 });
  g(0); g(1);
  check('under the threshold nothing is declared stuck', !reports.some((r) => r.stuck));
  g(2);
  check('at the threshold the loop is declared stuck', reports[2].stuck === true);
  g(3);
  check('...and said once, not once a frame', reports[3].stuck === false);
  // A frame that completes is the loop recovering, which is the case the
  // whole guard exists to produce.
  mode = 'good';
  g(4);
  mode = 'bad';
  g(5); g(6);
  // reports[4] is the first failure AFTER the good frame — reports only exist
  // for failing frames, so the recovery itself is the gap in the list.
  check('a completed frame resets the streak', reports[4].consecutive === 1, `${reports[4].consecutive}`);
  check('...and the next one counts up from there', reports[5].consecutive === 2, `${reports[5].consecutive}`);
  check('...but the run-long tally keeps climbing', reports[5].count === 6, `count ${reports[5].count}`);
}

section('THE INSTRUMENT CANNOT BE THE THING THAT KILLS THE LOOP');
{
  const g = guardFrame(() => { throw new Error('boom'); },
    { report: () => { throw new Error('the reporter is broken too'); } });
  check('a report that throws is survived', survives(() => g(0)).ok);
}

section('A SIGNATURE NAMES THE CODE, NOT THE MESSAGE');
{
  // V8 puts a header line on the stack. Taking "the first line" gets
  // `Error: <message>` — the message again, which identifies nothing, and
  // would collapse every distinct throw of the same message into one entry.
  const v8 = signatureOf(new Error('undefined is not an object'));
  check('the V8 header line is skipped', /\bat\b/.test(v8), v8);
  // And the phone speaks a different dialect entirely: no header, and frames
  // read `fn@file:line:col`.
  const jsc = signatureOf({ message: 'undefined is not an object', stack: 'club@app.js:1:2\nq@app.js:3:4' });
  check('a JavaScriptCore frame is found', jsc.endsWith('club@app.js:1:2'), jsc);
  check('two throws of one message from different places differ',
    signatureOf({ message: 'm', stack: 'a@f.js:1:1' }) !== signatureOf({ message: 'm', stack: 'b@f.js:1:1' }));
  check('no stack still yields the message', signatureOf({ message: 'bare' }) === 'bare');
  check('a thrown non-Error is survived', signatureOf('a string') === 'a string');
}

section('AND main.js ACTUALLY INSTALLS IT');
{
  // The regression that would otherwise be invisible: everything above can
  // pass with the game handing its raw frame straight to three.
  // COMMENTS STRIPPED FIRST. Every check below is a search for a line of code,
  // and the file explains each of these decisions in prose directly above the
  // code that makes them — so a check run over the raw text finds the sentence
  // describing the mistake and reports the mistake. This test failed on its
  // own documentation before the strip was here.
  const main = readFileSync(new URL('../path/src/main.js', import.meta.url), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  check('the frame body is not what the loop is given',
    !/setAnimationLoop\(\s*runFrame\s*\)/.test(main));
  check('setAnimationLoop is handed the guarded frame',
    /setAnimationLoop\(\s*animate\s*\)/.test(main));
  check('and `animate` is built by guardFrame', /guardFrame\(\s*runFrame\b/.test(main));
  // It was a hoisted declaration before, and boot() reaches setAnimationLoop
  // while this module is still evaluating. A `const animate = ...` only works
  // because an await happens to intervene.
  check('`animate` is hoisted, so boot cannot outrun it',
    /function animate\(/.test(main) && !/const animate\s*=/.test(main));
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
