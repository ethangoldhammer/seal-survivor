#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:jetsam
//
// The reader for the one number nobody has. tools/jetsam-pull.mjs exists
// because every instrument inside the game measures ~390MB while the phone
// kills the web view at something nearer 1.8GB — so a report that is misread
// here does not produce a wrong answer, it produces a CONFIDENT wrong answer
// about the only evidence there is.
//
// Two ways it can be wrong, and both are silent:
//
//   `rpages` is a PAGE COUNT. Printed as bytes it is out by the page size —
//   16KB on every current iPhone — which turns 1.8GB into 115MB and argues
//   that memory was never the problem at all.
//
//   Reports come in two layouts. One is a single JSON document; the .ips shape
//   is a header line of JSON followed by the body. A parser that knows one of
//   them reports "no reports found" on a directory full of them, which reads
//   as "the phone never ran out of memory".
// ---------------------------------------------------------------------------
import { parseReport, describeJetsam as colourful, syncLine } from './jetsam-pull.mjs';

// The colour codes are for a terminal, not for a matcher: `> 1800MB` arrives as
// `\x1b[31m> 1800MB`, so an anchored assertion about the marker silently tests
// the escape sequence instead of the row.
const describeJetsam = (r, o) => colourful(r, o).replace(/\x1b\[[0-9;]*m/g, '');

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

// 16KB pages, and page counts that land on round megabytes: 115200 pages is
// 1800MB, which is the reading the census header quotes for this game.
const PAGE = 16384;
const body = {
  timestamp: '2026-09-17 18:45:18.000 -0400',
  os_version: 'iPhone OS 18.2',
  largestProcess: 'WebKit Web Content',
  memoryStatus: { pageSize: PAGE, memoryPages: { free: 6400, wired: 32000 } },
  // THE NAMES AND THE COALITION ARE THE REAL ONES, copied off
  // JetsamEvent-2026-09-17-183629.ips. This fixture used to call the shell
  // 'SealSurvivor', which appears in no report iOS has ever written — the
  // executable is named `App` — so the test certified a match that found
  // nothing on the device. A fixture that invents its subject's name proves
  // only that the tool can read the fixture.
  processes: [
    { name: 'com.apple.WebKit.WebContent', rpages: 115200, lifetimeMax: 121600, reason: 'per-process-limit', states: ['frontmost'], coalition: 8982 },
    { name: 'com.apple.WebKit.GPU', rpages: 6400, lifetimeMax: 6400, coalition: 8982 },
    { name: 'App', rpages: 12800, lifetimeMax: 12800, states: ['frontmost'], coalition: 8982 },
    { name: 'mediaserverd', rpages: 6400, coalition: 12 },
  ],
};

console.log('\nTHE TWO LAYOUTS');
check('a single JSON document parses', parseReport(JSON.stringify(body))?.processes?.length === 4);
{
  const ips = `${JSON.stringify({ timestamp: body.timestamp, bug_type: '298' })}\n${JSON.stringify(body)}`;
  const r = parseReport(ips);
  check('a header line plus a body parses', r?.processes?.length === 4);
  check('...and keeps the timestamp', !!r?.timestamp, String(r?.timestamp));
}
check('something that is not a report is null, not a throw', parseReport('not json at all') === null);
check('...including JSON with no processes in it', parseReport('{"a":1}') === null);

console.log('\nPAGES ARE NOT BYTES');
{
  const line = describeJetsam(body);
  check('the web view is reported at 1800MB, not 115MB', /1800MB/.test(line),
    'rpages is a page count; printing it as bytes is off by the 16KB page size'
    + ' and turns the kill into a rounding error');
  check('...and the peak is carried when it differs', /peak 1900MB/.test(line), line);
  check('the native shell is found under the name iOS actually gives it',
    /200MB {2}App/.test(line), line);
  check('the kill reason is on the row', /per-process-limit/.test(line), line);
  check('our processes are marked', (line.match(/^\s+>/gm) ?? []).length === 3, line);
  check('a page size the report states is the one used',
    /900MB/.test(describeJetsam({ ...body, memoryStatus: { pageSize: 8192 } })),
    'a hardcoded 16KB would misread any device that does not use it');
}

console.log('\nTHE COALITION IS THE APP');
{
  const line = describeJetsam(body);
  check('the four processes of one app are summed', /2100MB \(peak 2200MB\)/.test(line),
    'the web view alone understates the app: the GPU process and the shell are'
    + ' billed separately and are scattered through five hundred rows');
  check('...and a daemon in another coalition is not in the sum',
    !/2200MB \(peak 2300MB\)/.test(line), line);
}

console.log('\nAN ABSENCE IS ONLY EVIDENCE IF THE SYNC REACHED IT');
{
  const t = (h, m) => new Date(2026, 8, 18, h, m).getTime();
  check('a sync older than the kill says so outright',
    /has not been collected/.test(syncLine(t(0, 34), t(2, 0), t(1, 21))),
    'this tool reads a folder Xcode fills; "no report for that kill" off a folder'
    + ' last written BEFORE the kill is the misread that costs a week');
  check('...and a sync that covers the kill does not', 
    !/has not been collected/.test(syncLine(t(1, 30), t(2, 0), t(1, 21))),
    syncLine(t(1, 30), t(2, 0), t(1, 21)));
  check('nothing synced is not a time', syncLine(0) === null);
  check('minutes below the hour read as minutes', /19 min ago/.test(syncLine(t(1, 41), t(2, 0))));
}

console.log('\nTHE REPORT WORTH READING IS THE ONE WHERE WE ARE NOT BIGGEST');
{
  // Forty daemons above us is the normal shape of a real report, and cutting to
  // the top few would drop the only two rows anybody opened this for.
  const many = {
    ...body,
    largestProcess: 'somethingelse',
    processes: [
      ...Array.from({ length: 20 }, (_, i) => ({ name: `daemon${i}`, rpages: 64000 - i })),
      { name: 'WebKit Web Content', rpages: 6400 },
    ],
  };
  const line = describeJetsam(many);
  check('the web view is named even when it is nowhere near the top',
    /WebKit Web Content \(rank 21\)/.test(line), line);
  check('...and the list is still cut', (line.match(/daemon/g) ?? []).length <= 8, line);
}

console.log(failures ? `\njetsam: ${failures} check failed\n` : '\njetsam: all good\n');
process.exit(failures ? 1 : 0);
