#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:quips
//
// The game-over headline table. Every check here is about the one failure that
// matters: the screen rendering with NO headline, or the same one every time.
//
// A quip is content in a file the player can edit, which is the whole point of
// the table and also the whole risk — a stray edit must degrade to a working
// headline rather than to a blank <div> above the score. So the parser is
// tested with the shapes a spreadsheet actually produces: blank cells, a
// deleted body, every row disabled, weights of zero, a duplicated id.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseQuipCsv, pickQuip, FALLBACK_QUIP } from '../path/src/quipTable.js';

const here = dirname(fileURLToPath(import.meta.url));
const CSV = resolve(here, '../path/src/quips.csv');

let failures = 0;
const quiet = () => {};

function section(name) { console.log(`\n${name}`); }
function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

section('The shipped file');
const shipped = parseQuipCsv(readFileSync(CSV, 'utf8'));
check('parses to at least two lines', shipped.length >= 2, `${shipped.length} lines`);
check('every line has text', shipped.every((q) => q.text.trim().length > 0));
check('every line has a positive weight', shipped.every((q) => q.weight > 0));
check('ids are unique', new Set(shipped.map((q) => q.id)).size === shipped.length);
// The two the game shipped with. Renaming these is fine; losing them is not,
// because they are the ones the screen was designed around.
check('"You Died!" is in the table', shipped.some((q) => q.text === 'You Died!'));
check('"Your Fate is Sealed!" is in the table',
  shipped.some((q) => q.text === 'Your Fate is Sealed!'));
check('no line is long enough to wrap the title',
  shipped.every((q) => q.text.length <= 34),
  shipped.map((q) => q.text.length).join(','));

section('Broken files still produce a headline');
const cases = [
  ['empty file', ''],
  ['header only', 'id,text,enabled,weight'],
  ['no id column', 'text\nYou Died!'],
  ['every row disabled', 'id,text,enabled\na,You Died!,FALSE\nb,Nope,FALSE'],
  ['every row blank text', 'id,text\na,\nb,   '],
  ['garbage', 'not,a,table\n\n,,,'],
];
for (const [label, csv] of cases) {
  const rows = parseQuipCsv(csv, quiet);
  check(`${label} → fallback`, pickQuip(rows) === FALLBACK_QUIP, pickQuip(rows));
}

section('Weights');
const weighted = parseQuipCsv(
  'id,text,weight\ncommon,Common,9\nrare,Rare,1\nnever,Never,0',
  quiet,
);
check('a zero-weight line is never dealt', (() => {
  for (let i = 0; i < 4000; i++) {
    if (pickQuip(weighted, Math.random) === 'Never') return false;
  }
  return true;
})());

// 9:1 over 4000 draws lands near 90%; the band is wide enough that this can't
// fail on variance but narrow enough to catch the weights being ignored, which
// would show as 50%.
const counts = { Common: 0, Rare: 0 };
for (let i = 0; i < 4000; i++) counts[pickQuip(weighted, Math.random)]++;
const commonShare = counts.Common / 4000;
check('a 9:1 weight is respected', commonShare > 0.85 && commonShare < 0.95,
  `${(commonShare * 100).toFixed(1)}% common`);

check('random()===0 does not hand the draw to a zero-weight row',
  pickQuip(weighted, () => 0) !== 'Never');
check('random() just under 1 stays in range',
  ['Common', 'Rare'].includes(pickQuip(weighted, () => 0.999999)));

const allZero = parseQuipCsv('id,text,weight\na,A,0\nb,B,0', quiet);
check('all-zero weights fall back to uniform rather than nothing',
  ['A', 'B'].includes(pickQuip(allZero)));

section('Rotation');
// Not a distribution check — just that more than one line can come out, which
// is what "table of quips" means and what a bad `pickQuip` would silently
// break by always returning row zero.
const seen = new Set();
for (let i = 0; i < 500; i++) seen.add(pickQuip(shipped));
check('more than one line is reachable', seen.size > 1, `${seen.size} distinct`);
check('every enabled line is reachable', seen.size === shipped.length,
  `${seen.size} of ${shipped.length}`);

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
