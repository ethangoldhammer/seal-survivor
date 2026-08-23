// Ship gate: no AI-written player-facing copy leaves this repo.
//
// The rule (CLAUDE.md § Copy): Claude never writes finished prose for the
// game. Anything staged for testing goes in as lorem ipsum, and this suite
// fails while any of it is still there — so a draft line physically cannot
// reach production. Ethan replaces the lorem with his own words, the suite
// goes green, and only then can `npm run ship` commit.
//
// It is named `test:copy` on purpose: tools/ship.mjs builds its gate list by
// reading every `test:*` script out of package.json, so this file gates the
// deploy simply by existing.
//
// What counts as a draft lives in tools/draft-copy.mjs, shared with the CSV
// editor so the flag you see on a row and the gate that blocks the ship are
// the same rule.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseCsv } from '../path/src/csvTable.js';
import { COPY_COLUMNS, DRAFT_RE } from './draft-copy.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'path/src');

// The detector, checked against itself before it is trusted to gate a deploy.
// A regex that quietly stopped matching would turn this suite into a green
// light that means nothing — the one failure mode a gate cannot have, because
// nobody investigates a passing test.
const SELF = [
  ['Lorem ipsum dolor sit amet', true, 'plain lorem'],
  ['LOREM IPSUM', true, 'lorem, shouted'],
  ['[DRAFT] Boost', true, 'a marked draft in real English'],
  ['consectetur adipiscing elit', true, 'lorem without the first two words'],
  ['Snuffed out by a boat!', false, 'a real quip'],
  ['Kissed by a rose on the grave.', false, 'another real quip'],
  ['', false, 'an empty cell'],
];
const wrong = SELF.filter(([v, want]) => DRAFT_RE.test(v) !== want);
if (wrong.length) {
  console.error('\n  the draft detector is broken — it cannot be trusted to gate a ship:\n');
  for (const [v, want, why] of wrong) {
    console.error(`    ${want ? 'missed' : 'false alarm on'} ${why}: ${JSON.stringify(v)}`);
  }
  console.error('');
  process.exit(1);
}

const findings = [];

for (const [file, columns] of Object.entries(COPY_COLUMNS)) {
  let text;
  try { text = readFileSync(join(SRC, file), 'utf8'); }
  catch { continue; }              // a CSV can be retired without editing this list
  const rows = parseCsv(text);
  if (!rows.length) continue;
  const header = rows[0].map((h) => h.trim());
  const idIdx = header.indexOf('id');
  const notesIdx = header.indexOf('notes');
  for (let r = 1; r < rows.length; r++) {
    for (const col of columns) {
      const c = header.indexOf(col);
      if (c < 0) continue;
      const value = (rows[r][c] || '').trim();
      if (!value || !DRAFT_RE.test(value)) continue;
      const id = idIdx >= 0 ? rows[r][idIdx] : `row ${r + 1}`;
      // The brief, if one was written where it belongs — printing it here is
      // the difference between a list of chores and a list you can act on.
      const brief = notesIdx >= 0 ? (rows[r][notesIdx] || '').trim() : '';
      findings.push({ where: `path/src/${file}  ${id}.${col}`, value, brief });
    }
  }
}

// Sweep the source for the marker too, so a draft string hardcoded in a .js
// file is caught the same way a CSV row is.
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { walk(path); continue; }
    if (!/\.(js|mjs|html|css|json)$/.test(name)) continue;
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    lines.forEach((line, n) => {
      if (DRAFT_RE.test(line)) {
        findings.push({ where: `${relative(ROOT, path)}:${n + 1}`, value: line.trim(), brief: '' });
      }
    });
  }
}
walk(SRC);

if (findings.length) {
  const n = findings.length;
  console.error(`\n  ${n} line${n === 1 ? '' : 's'} still waiting for your words:\n`);
  for (const f of findings) {
    console.error(`    ${f.where}`);
    console.error(`      staged: ${f.value.slice(0, 72)}`);
    if (f.brief) console.error(`      brief:  ${f.brief.slice(0, 72)}`);
  }
  console.error(`
  These are placeholders, not copy. Open the CSV editor (npm run csv) — the
  rows are flagged amber and "Needs words" filters to just these. Replace the
  lorem with your own line and this gate goes green.
`);
  process.exit(1);
}

console.log('copy: no draft lines staged — every player-facing string is yours');
