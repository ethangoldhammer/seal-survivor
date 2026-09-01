// ============================================================================
// CSV EDITOR TEST — the two ways this tool could quietly do damage.
//
// 1. ROUND-TRIP. The editor reads a CSV into objects and writes objects back
//    out. If that trip is not byte-for-byte identical, then saving a single
//    cell reformats the whole file and buries the change in a diff nobody can
//    review. This is the test that catches an over-eager quoting rule.
//
// 2. SCHEMA. Every dropdown here is read out of the game at startup by regex.
//    Those regexes are the price of not importing config.js, and the way they
//    fail is silently: a renamed const gives an empty list, every cell falls
//    back to a text box, and the editor still looks fine. So assert the lists
//    are non-empty and that they still line up with the real columns.
//
// Run: npm run test:csv
// ============================================================================

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { TABLES, SCHEMA, loadTable, writeCsv, cardArt } from './csv-editor.mjs';
import { DRAFT_PATTERN, BRIEF_PATTERN, COPY_COLUMNS } from './draft-copy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${msg}`);
  if (!cond) failed++;
};

const diff = (a, b) => {
  const x = a.split('\n'), y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) return `        line ${i + 1}\n         was: ${x[i]}\n         now: ${y[i]}`;
  }
  return '';
};

console.log('\nround-trip — saving an untouched table must not change a byte');
for (const t of TABLES) {
  const original = await readFile(join(ROOT, t.file), 'utf8');
  const loaded = await loadTable(t);
  const rewritten = writeCsv(loaded.header, loaded.rows, original);
  const same = rewritten === original;
  ok(same, `${t.file} (${loaded.rows.length} rows, ${loaded.header.length} columns)`);
  if (!same) console.log(diff(original, rewritten));
}

// The real workflow: change one cell, save, and see one changed line. This is
// the test that would have failed on musselVolley's needlessly quoted
// description before writeCsv learned to leave untouched cells alone.
console.log('\none edit — one changed line');
for (const t of TABLES) {
  const original = await readFile(join(ROOT, t.file), 'utf8');
  const loaded = await loadTable(t);
  const target = loaded.columns.find((c) => c.type === 'number') || loaded.columns[1];
  const rows = loaded.rows.map((r) => ({ ...r }));
  rows[rows.length - 1][target.name] = '3.5';
  const rewritten = writeCsv(loaded.header, rows, original);
  const a = original.split('\n'), b = rewritten.split('\n');
  const changed = a.map((l, i) => l !== b[i]).filter(Boolean).length;
  ok(changed === 1, `${t.file}: editing ${target.name} on the last row changed ${changed} line(s)`);
  if (changed !== 1) console.log(diff(original, rewritten));
}

// ---------------------------------------------------------------------------
// THE EDITOR AND THE GATE MUST FLAG THE SAME ROWS.
//
// They are two implementations of one rule — the suite tests cells in Node, the
// editor re-tests them in the browser on every keystroke — and they only stay
// in step because the server hands the PATTERNS over rather than the answers.
// When the brief detector was added to the gate and not to that handover, the
// two disagreed silently: five rows in statText.csv blocked the ship and were
// invisible in the editor, which is the worst arrangement of the three (both
// blind is at least honest).
//
// So both patterns are checked to exist, to compile, and to answer the way the
// editor's two helpers will answer with them.
console.log('\nthe placeholder flag — one rule, two implementations');
{
  const draftRe = new RegExp(DRAFT_PATTERN, 'i');
  const briefRe = new RegExp(BRIEF_PATTERN, 'i');
  ok(draftRe.test('lorem ipsum dolor sit'), 'the copy detector still sees lorem');
  ok(!draftRe.test('Snuffed out by a boat!'), '...and leaves a written line alone');
  ok(briefRe.test('NEEDS YOUR WORDS: a lead for the `shot` cause'),
    'the brief detector sees an open brief');
  ok(!briefRe.test('what the line has to do, now that it is written'),
    '...and leaves a finished note alone');
  // The case the pair exists for: finished-looking copy with an open brief.
  ok(!draftRe.test('Shot Down') && briefRe.test('NEEDS YOUR WORDS: a lead'),
    'a plausible placeholder is caught by the brief alone, which is the whole point');

  // The editor is served these two and nothing else, so a copy column list that
  // drifted apart from the gate's would flag different rows in each.
  const html = await readFile(join(ROOT, 'tools', 'csv-editor.html'), 'utf8');
  ok(html.includes('data.draftPattern') && html.includes('data.briefPattern'),
    'the editor reads BOTH patterns off the payload');
  ok(Object.keys(COPY_COLUMNS).length > 0,
    `the copy-column list is shared, not copied — ${Object.keys(COPY_COLUMNS).length} tables`);
}

console.log('\nschema — the lists read out of the game source');
ok(Object.keys(SCHEMA.ENEMY_REQUIRED).length > 0, `required enemy columns: ${Object.keys(SCHEMA.ENEMY_REQUIRED).join(', ')}`);
ok(Object.keys(SCHEMA.ENEMY_OPTIONAL).length > 0, `optional enemy columns: ${Object.keys(SCHEMA.ENEMY_OPTIONAL).length} found`);
ok(SCHEMA.ENEMY_FLAGS.length > 0, `enemy flag columns: ${SCHEMA.ENEMY_FLAGS.join(', ')}`);
ok(SCHEMA.CARD_ART_KEYS.length > 0, `card art keys: ${SCHEMA.CARD_ART_KEYS.length} found`);
ok(SCHEMA.SPAWN_GROUPS.length > 0, `spawn groups: ${SCHEMA.SPAWN_GROUPS.join(', ')}`);

// A min that came through as a string, or an integer flag that never parsed,
// would make validation either useless or wrong. Spot-check the two that carry
// the least obvious specs.
ok(SCHEMA.ENEMY_OPTIONAL.maxConcurrent?.integer === true, 'maxConcurrent parsed as whole-numbers-only');
ok(SCHEMA.ENEMY_REQUIRED.hp?.min === 0, 'hp parsed with min 0');

// A column with no doc is a column added since this tool was written. It still
// edits fine as a text box, which is the point of the fallback — but an
// UNDOCUMENTED column is worth saying out loud, since the alternative is
// wondering later why one column has no tooltip.
console.log('\nschema vs. the actual files');
for (const t of TABLES) {
  const loaded = await loadTable(t);
  const typed = loaded.columns.filter((c) => c.type !== 'text').length;
  const documented = loaded.columns.filter((c) => c.doc).length;
  ok(typed > 0, `${t.file}: ${typed}/${loaded.columns.length} columns get a real control`);
  ok(documented === loaded.columns.length,
    `${t.file}: ${documented}/${loaded.columns.length} columns carry a tooltip`);
  const undocumented = loaded.columns.filter((c) => !c.doc).map((c) => c.name);
  if (undocumented.length) console.log(`        (no doc — column added since this tool was written? ${undocumented.join(', ')})`);
}

// Every key the CSV can name has to have an image behind it, or the picker
// shows a broken thumbnail for a value the game accepts.
console.log('\ncard art — every key in the dropdown has an image');
const art = cardArt();
const missing = SCHEMA.CARD_ART_KEYS.filter((k) => !art[k]);
ok(missing.length === 0, missing.length ? `no image for: ${missing.join(', ')}` : `all ${SCHEMA.CARD_ART_KEYS.length} keys resolve to a data URI`);
const orphan = Object.keys(art).filter((k) => !SCHEMA.CARD_ART_KEYS.includes(k));
ok(orphan.length === 0, orphan.length ? `image with no key in LEVELUP_IMAGE_KEYS: ${orphan.join(', ')}` : 'no images orphaned from the key list');

// The cells the game reads with no fallback of its own. A blank one is not a
// crash, but it is a creature quietly keeping a config.js value the table
// claims to own — worth knowing about before it's a balance mystery.
console.log('\ncontent — required cells that are blank today');
const enemies = await loadTable(TABLES.find((t) => t.file.endsWith('enemies.csv')));
let blanks = 0;
for (const row of enemies.rows) {
  for (const f of Object.keys(SCHEMA.ENEMY_REQUIRED)) {
    if (f in row && String(row[f]).trim() === '') { console.log(`        ${row.id}.${f} is blank`); blanks++; }
  }
}
ok(true, blanks ? `${blanks} blank required cells (the game keeps config.js values and warns)` : 'no blank required cells');

console.log(failed ? `\n${failed} FAILED\n` : '\nall good\n');
process.exit(failed ? 1 : 0);
