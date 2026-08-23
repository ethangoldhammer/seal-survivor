// `npm run copy:review` — what is left to read, by table.
//
// Deliberately NOT a `test:` script. These lines already ship and are already
// fine; the column records whose words they are, and a gate over 637 rows
// would only teach the habit of passing --no-verify — which would also
// disable the lorem gate that does matter. This is a worklist, so it always
// exits 0.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from '../path/src/csvTable.js';
import { COPY_COLUMNS, REVIEW_COLUMN, needsReview } from './draft-copy.mjs';

const SRC = join(new URL('..', import.meta.url).pathname, 'path/src');
const only = process.argv[2];               // `npm run copy:review quips` lists one table's lines
const bar = (done, total, w = 24) => {
  const n = total ? Math.round((done / total) * w) : w;
  return '█'.repeat(n) + '░'.repeat(w - n);
};

let waiting = 0, total = 0;
const tables = [];

for (const file of Object.keys(COPY_COLUMNS)) {
  let text;
  try { text = readFileSync(join(SRC, file), 'utf8'); } catch { continue; }
  const grid = parseCsv(text);
  if (!grid.length) continue;
  const header = grid[0].map((h) => h.trim());
  if (!header.includes(REVIEW_COLUMN)) continue;
  const rows = grid.slice(1).map((cells) => {
    const rec = {};
    header.forEach((h, c) => { rec[h] = cells[c] ?? ''; });
    return rec;
  });
  const pending = rows.filter(needsReview);
  tables.push({ file, rows, pending, columns: COPY_COLUMNS[file] });
  waiting += pending.length;
  total += rows.length;
}

if (!tables.length) {
  console.log('no copy tables carry a review column yet.');
  process.exit(0);
}

const name = (f) => f.replace('.csv', '');
const pad = Math.max(...tables.map((t) => name(t.file).length));

console.log('');
for (const t of tables) {
  if (only && !name(t.file).startsWith(only)) continue;
  const done = t.rows.length - t.pending.length;
  const flag = t.pending.length ? '' : '  ✓';
  console.log(`  ${name(t.file).padEnd(pad)}  ${bar(done, t.rows.length)}  ${done}/${t.rows.length}${flag}`);

  // Naming a table lists its actual lines, so the report can be worked from
  // directly instead of sending you back to the editor to find out which.
  if (only) {
    for (const r of t.pending) {
      const line = t.columns.map((c) => r[c]).filter(Boolean).join('  ·  ');
      console.log(`      ${(r.id || '?').padEnd(16)} ${line.slice(0, 78)}`);
    }
  }
}

const done = total - waiting;
console.log(`\n  ${done}/${total} lines are yours; ${waiting} still to read.`);
if (waiting && !only) {
  console.log(`  Work through one in the editor (npm run csv) or list it here:`);
  console.log(`      npm run copy:review ${name(tables.find((t) => t.pending.length).file)}\n`);
} else {
  console.log('');
}
