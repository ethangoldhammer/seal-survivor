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
import { COPY_COLUMNS, DRAFT_RE, hasOpenBrief } from './draft-copy.mjs';

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

// ...AND THE BRIEF DETECTOR CHECKS ITSELF THE SAME WAY. It is the half that
// catches a placeholder written in convincing English, so a regex that quietly
// stopped matching would take the whole point of it with it.
const SELF_BRIEF = [
  ['NEEDS YOUR WORDS: a lead for the `shot` cause', true, 'a brief still open'],
  ['needs your words: same, shouted quietly', true, 'case does not matter'],
  ['  NEEDS YOUR WORDS: leading space', true, 'leading whitespace is skipped'],
  ['what the line has to do, now that it is written', false, 'a note that is not a brief'],
  ['a lead that NEEDS YOUR WORDS mid-sentence', false, 'only an opening brief counts'],
  ['', false, 'no notes at all'],
];
const wrongBrief = SELF_BRIEF.filter(([v, want]) => hasOpenBrief(v) !== want);
if (wrongBrief.length) {
  console.error('\n  the BRIEF detector is broken — it cannot be trusted to gate anything:');
  for (const [v, want, why] of wrongBrief) {
    console.error(`    ${JSON.stringify(v)} (${why}) should be ${want ? 'flagged' : 'clean'}`);
  }
  process.exit(1);
}
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
      if (!value) continue;
      // The brief, if one was written where it belongs — printing it here is
      // the difference between a list of chores and a list you can act on.
      const brief = notesIdx >= 0 ? (rows[r][notesIdx] || '').trim() : '';
      // EITHER DETECTOR IS ENOUGH. The copy cell may read as finished English
      // and still be waiting — see BRIEF_RE in draft-copy.mjs for the two rows
      // that proved it. A brief that still opens with NEEDS YOUR WORDS says the
      // row is outstanding no matter how convincing the cell above it looks.
      if (!DRAFT_RE.test(value) && !hasOpenBrief(brief)) continue;
      const id = idIdx >= 0 ? rows[r][idIdx] : `row ${r + 1}`;
      findings.push({ where: `path/src/${file}  ${id}.${col}`, value, brief });
    }
  }
}

// Sweep the source for the marker too, so a draft string hardcoded in a .js
// file is caught the same way a CSV row is.
//
// CODE ONLY — the comments are blanked out first, and that is not a loosening
// of the gate. The rule this file enforces is written down in the source it
// scans: uiTextTable.js explains why a placeholder has to be unmistakable,
// weaponName.js says the lorem in a column is what makes a line owed, and
// three more comments like them. Scanning prose ABOUT the rule meant the gate
// could never go green no matter how much copy was written — and a gate that
// is permanently red is one nobody reads, which is the same failure as a gate
// that is permanently green. A draft STRING is code and is still caught; a
// sentence explaining the marker is not a line any player reads.
//
// Only `//` and block comments are stripped, and only where the language has
// them: a `//` in a CSS `url(https://...)` is not a comment, and blanking from
// there would hide the rest of the line.
function stripComments(text, ext) {
  if (ext === 'html' || ext === 'json') return text;   // no comment syntax to strip
  const lineComments = ext === 'js' || ext === 'mjs';
  let out = '';
  let quote = null;          // ' " or ` while inside a string
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    // Keep newlines whatever happens, so a finding still reports its own line.
    if (quote) {
      out += c;
      if (c === '\\') { out += text[++i] ?? ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; out += c; continue; }
    // An escape outside a string is a regex literal's \/ — skipping the pair
    // keeps /https:\/\// from reading as the start of a comment.
    if (c === '\\') { out += c + (text[++i] ?? ''); continue; }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const skipped = text.slice(i, end < 0 ? text.length : end + 2);
      out += skipped.replace(/[^\n]/g, ' ');
      i += skipped.length - 1;
      continue;
    }
    if (lineComments && c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end - 1;
      continue;
    }
    out += c;
  }
  return out;
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { walk(path); continue; }
    const ext = /\.(js|mjs|html|css|json)$/.exec(name)?.[1];
    if (!ext) continue;
    const lines = stripComments(readFileSync(path, 'utf8'), ext).split(/\r?\n/);
    const source = readFileSync(path, 'utf8').split(/\r?\n/);
    lines.forEach((line, n) => {
      if (DRAFT_RE.test(line)) {
        // Report the REAL line, not the comment-stripped one — a finding you
        // cannot recognise in your own file is a finding you cannot act on.
        findings.push({ where: `${relative(ROOT, path)}:${n + 1}`, value: source[n].trim(), brief: '' });
      }
    });
  }
}

// ...AND THE STRIPPER CHECKS ITSELF, for the reason the two detectors above
// do. It is the one part of this gate that can make a finding DISAPPEAR, so a
// bug in it reads as "all the copy is written" — the exact failure a gate is
// not allowed to have.
const SELF_STRIP = [
  ["const X = '[DRAFT] Boost';", 'js', true, 'a staged string is still caught'],
  ["const X = '[DRAFT] Boost'; // a note about it", 'js', true, 'even with a comment on the same line'],
  ['// lorem is what says the line is owed', 'js', false, 'a comment about the rule is not a draft'],
  ['/* [DRAFT] in a block comment */', 'js', false, 'block comments too'],
  ["const s = 'https://example.com/[DRAFT] Boost';", 'js', true, 'a // inside a string does not start a comment'],
  ['a { background: url(https://x/y); content: "[DRAFT] Boost"; }', 'css', true,
   'a css url is not a comment, so what follows it is still scanned'],
];
const wrongStrip = SELF_STRIP.filter(([v, ext, want]) => DRAFT_RE.test(stripComments(v, ext)) !== want);
if (wrongStrip.length) {
  console.error('\n  the comment stripper is broken — it can hide a staged line:\n');
  for (const [v, , want, why] of wrongStrip) {
    console.error(`    ${want ? 'lost' : 'false alarm on'} ${why}: ${JSON.stringify(v)}`);
  }
  console.error('');
  process.exit(1);
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
