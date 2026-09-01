// ---------------------------------------------------------------------------
// npm run test:uitext
//
// path/src/uiText.csv and the table under it. This file is a JOIN and nothing
// else — the code asks for `finPanelTitle` by name and the table answers — so
// the failures worth catching are all failures of the join, and every one of
// them is silent in the game:
//
//   A READ WITH NO ROW    the label falls back to its id, so the score screen
//                         says "finPanelTitle" where a heading goes. Loud on
//                         the one screen it appears on and invisible
//                         everywhere else, which is a bug found by a player.
//   A ROW WITH NO READ    a line Ethan is asked to write that nothing will
//                         ever show. Worse than dead weight: it puts a chore
//                         on the "needs your words" list that clearing
//                         achieves nothing.
//   A BLANK LINE          a row with an id and no text would render an empty
//                         heading, which reads as a layout bug and gets chased
//                         as one.
//
//   node --import ./tools/vite-loader.mjs tools/ui-text-test.mjs
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { UI_TEXT, uiText, parseUiTextCsv } from '../path/src/uiTextTable.js';
import { COPY_COLUMNS } from './draft-copy.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'path/src');
const TABLE = 'path/src/uiTextTable.js';

let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${msg}`);
  if (!cond) failed++;
};

// ===========================================================================
console.log('\n1. the join — every read has a row, every row has a read');
// ===========================================================================

// Every `uiText('someId')` in the game, and the file it is in. Regex over the
// source rather than an import, for the reason tools/csv-editor.mjs gives
// about the same trick: this wants a list of strings, not a browser's worth of
// globals. It can only miss a read that is built at runtime — which is exactly
// the shape this test would otherwise be asked to bless, so a computed id
// stays something nobody writes.
const reads = new Map();                       // id -> [where it is asked for]
for (const path of walk(SRC)) {
  const rel = relative(ROOT, path);
  if (rel === TABLE) continue;                 // the accessor's own definition
  const text = readFileSync(path, 'utf8');
  for (const m of text.matchAll(/\buiText\(\s*'([^']+)'\s*\)/g)) {
    if (!reads.has(m[1])) reads.set(m[1], []);
    reads.get(m[1]).push(rel);
  }
}

ok(reads.size > 0, `the source asks for ${reads.size} lines by id`);

for (const [id, where] of [...reads].sort()) {
  ok(id in UI_TEXT, `${id} has a row (asked for in ${[...new Set(where)].join(', ')})`);
}

for (const id of Object.keys(UI_TEXT)) {
  ok(reads.has(id), `${id} is read by something${reads.has(id) ? '' : ' — nothing shows this line'}`);
}

// A COMPUTED ID WOULD DEFEAT THE TWO CHECKS ABOVE, so it is refused outright:
// `uiText(key)` cannot be matched to a row by anything static, and a table that
// only mostly knows what reads it is a table nobody can safely delete from.
const computed = [];
for (const path of walk(SRC)) {
  const rel = relative(ROOT, path);
  if (rel === TABLE) continue;
  for (const m of readFileSync(path, 'utf8').matchAll(/\buiText\(\s*([^'\s)][^)]*)\)/g)) {
    computed.push(`${rel}: uiText(${m[1]})`);
  }
}
ok(computed.length === 0, `every read names its id as a literal${computed.length ? ` — ${computed[0]}` : ''}`);

// ===========================================================================
console.log('\n2. the fallback — a missing row is visible, never blank');
// ===========================================================================

const warnings = [];
const realWarn = console.warn;
console.warn = (m) => warnings.push(String(m));
const missing = uiText('noSuchLineExists');
const missingAgain = uiText('noSuchLineExists');
console.warn = realWarn;

ok(missing === 'noSuchLineExists', 'a missing row shows its id — never an empty string');
ok(missing === missingAgain, 'and does so consistently');
ok(warnings.length === 1,
  `it warns once, not once per read (warned ${warnings.length} time${warnings.length === 1 ? '' : 's'})`);
ok(warnings[0]?.includes('uiText.csv'), 'and the warning names the file to add the row to');

// ===========================================================================
console.log('\n3. the parser');
// ===========================================================================

{
  const warn = [];
  const table = parseUiTextCsv(
    'id,text,notes\nkept,  A line  ,\nblank,,a row with no words\n',
    (m) => warn.push(m),
  );
  ok(table.kept === 'A line', 'a cell is trimmed — a stray space in a spreadsheet is not part of the line');
  ok(!('blank' in table), 'a row with no text is dropped rather than rendered as nothing');
  ok(warn.some((m) => m.includes('blank')), 'and it says which row it dropped');
}

// ===========================================================================
console.log('\n4. the copy gate can see this table');
// ===========================================================================

// The whole reason the table exists: these lines were unreachable from the CSV
// editor and from `npm run copy:review` while they were string constants. Both
// of those read COPY_COLUMNS, so this one entry is what wires them — and its
// absence would be the table quietly going back to being invisible.
ok(COPY_COLUMNS['uiText.csv']?.includes('text'),
  'tools/draft-copy.mjs lists uiText.csv `text` as copy, so the editor flags it and the ship gate counts it');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

console.log(failed ? `\n${failed} FAILED\n` : '\nall good\n');
process.exit(failed ? 1 : 0);
