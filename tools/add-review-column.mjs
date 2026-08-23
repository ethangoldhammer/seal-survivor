// The `review` column: add it to every copy-bearing CSV, in the right place.
//
// Non-destructive by construction — it never touches a cell that has words in
// it. It only adds the column (marking every existing row as waiting) and
// moves it to sit immediately after the copy it refers to.
//
// POSITION IS THE POINT. Appended at the end of the row the flag is a column
// you have to go and find, on the far side of six columns of numbers; beside
// the text it describes, the question it asks ("is this line yours?") is next
// to the thing being asked about. In every one of these tables the copy
// columns are contiguous, so "immediately after the last of them" is a place
// that always exists — and the script refuses rather than guesses if that ever
// stops being true.
//
// Safe to re-run: a row that has already been cleared stays cleared, and a
// column already in the right place is left alone.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COPY_COLUMNS, REVIEW_COLUMN } from './draft-copy.mjs';

const SRC = join(new URL('..', import.meta.url).pathname, 'path/src');

const needsQuote = (s) => /[",\n\r]/.test(s);
const quote = (s) => `"${s.replace(/"/g, '""')}"`;

// A quote-aware reader that also records WHICH cells arrived quoted. The game
// reads a value the same either way, but the diff does not: re-quoting on a
// whim turns a one-column change into a 637-line one and buries the actual
// edit. Same reason the CSV editor's writer carries marks.
function parseCsv(text, marks) {
  const rows = [], flags = [];
  let row = [], flag = [], field = '', quoted = false, started = false, wasQuoted = false;
  const endField = () => { row.push(field); flag.push(wasQuoted); field = ''; started = false; wasQuoted = false; };
  const endRow = () => { endField(); rows.push(row); flags.push(flag); row = []; flag = []; };
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
      continue;
    }
    if (c === '"' && !started) { quoted = true; started = true; wasQuoted = true; continue; }
    if (c === ',') { endField(); continue; }
    if (c === '\r') continue;
    if (c === '\n') { endRow(); continue; }
    field += c; started = true;
  }
  if (field !== '' || row.length) endRow();
  const keep = rows.map((r) => r.some((v) => v.trim() !== ''));
  marks.push(...flags.filter((_, i) => keep[i]));
  return rows.filter((_, i) => keep[i]);
}

let moved = 0, added = 0, already = 0;

for (const [file, copyColumns] of Object.entries(COPY_COLUMNS)) {
  const path = join(SRC, file);
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { console.log(`skip  ${file} (no such file)`); continue; }

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trailing = /\r?\n$/.test(text);
  const marks = [];
  const grid = parseCsv(text, marks);
  if (!grid.length) { console.log(`skip  ${file} (empty)`); continue; }

  const header = grid[0].map((h) => h.trim());

  // Where the flag belongs: right after the last copy column. Contiguity is
  // checked rather than assumed — a table whose prose columns got split up is
  // one where "next to the text" has no single answer, and quietly picking
  // one would put the flag next to the wrong line.
  const at = copyColumns.map((c) => header.indexOf(c)).filter((i) => i >= 0);
  if (!at.length) { console.log(`skip  ${file} (no copy column found)`); continue; }
  const contiguous = at.every((v, i) => i === 0 || v === at[i - 1] + 1);
  if (!contiguous) {
    console.log(`SKIP  ${file} — its copy columns (${copyColumns.join(', ')}) are no longer adjacent, so there is no one place to put the flag. Move them together, or place it by hand.`);
    continue;
  }
  const want = Math.max(...at) + 1;

  const had = header.indexOf(REVIEW_COLUMN);
  if (had === want) { already++; console.log(`ok    ${file}  already after \`${copyColumns[copyColumns.length - 1]}\``); continue; }

  // Rebuild each row as { column -> value }, keeping the quoting it arrived
  // with, then lay the columns back out in the new order.
  const order = header.filter((h) => h !== REVIEW_COLUMN);
  const insertAt = had >= 0 && had < want ? want - 1 : want;   // removing it first shifts anything after it left
  order.splice(insertAt, 0, REVIEW_COLUMN);

  const out = [order.map((h) => {
    const i = header.indexOf(h);
    return i >= 0 && marks[0][i] ? quote(h) : (needsQuote(h) ? quote(h) : h);
  }).join(',')];

  let flagged = 0;
  for (let r = 1; r < grid.length; r++) {
    out.push(order.map((h) => {
      const i = header.indexOf(h);
      if (i < 0) { flagged++; return 'TRUE'; }          // the column is new: every existing line is waiting
      const v = grid[r][i] ?? '';
      if (needsQuote(v)) return quote(v);
      return marks[r][i] ? quote(v) : v;                 // keep a cell that was quoted for no reason quoted
    }).join(','));
  }

  writeFileSync(path, out.join(eol) + (trailing ? eol : ''));
  if (had >= 0) { moved++; console.log(`ok    ${file}  review moved to sit after \`${copyColumns[copyColumns.length - 1]}\``); }
  else { added++; console.log(`ok    ${file}  +review after \`${copyColumns[copyColumns.length - 1]}\`, ${flagged} rows waiting`); }
}

console.log(`\n  ${added} added, ${moved} moved, ${already} already in place.`);
