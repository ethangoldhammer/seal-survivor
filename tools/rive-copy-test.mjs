#!/usr/bin/env node
// ============================================================================
// THE JOIN BETWEEN uiText.csv AND THE RIVE ARTBOARD, CHECKED FROM BOTH ENDS.
//
// A Rive file is the one place a player-facing string can live where nothing
// else in this repo is watching: it is a value typed into a binary, in a tool
// where typing a word is the obvious thing to do, and `npm run test:copy` reads
// neither the .riv nor the .rml. That is a gap with a hole exactly the shape of
// a line nobody chose shipping in a voice that is not Ethan's.
//
// Several things have to be true, and each fails silently on its own:
//
//   1. every property ui/statsCopy.js writes into EXISTS in data.rml.
//      Rename one in the editor and the write is a no-op — the page keeps
//      drawing the artboard's placeholder, and nothing throws.
//   2. every uiText id it reads HAS A ROW. (ui-text-test.mjs already fails on
//      a read with no row; this fails on the same thing from the other side,
//      so a project that stops running that suite still cannot drift.)
//   3. every string property that a player READS is covered by the manifest.
//      Add a text slot in the editor, bind it, ship it — and it draws lorem
//      forever unless something notices it was never joined to a row.
//   4. every text run in the artboard is DATA-BOUND. This is the structural
//      one, and it is what makes the rest hold: a run with no bind draws its
//      own literal, forever, and no amount of writing in the CSV can reach it.
//      With every run bound, no word typed into Rive can ever reach a player —
//      which is the invariant `npm run test:copy` enforces for every other
//      file in the game and cannot enforce for a binary.
//   5. the authored strings in the .rml are still PLACEHOLDERS. This is the
//      one that the round trip makes live: words written in the Rive editor
//      come back into data.rml through `npm run rive:pull`, and a real
//      sentence sitting there is a second home for copy that the CSV editor's
//      "needs your words" chip cannot see.
//   6. every ROW the players tab draws is written. This one is not about the
//      CSV at all: a row that is drawn but never handed a seal keeps the name
//      it was authored with, so the seal you just played against is called
//      "Lorem ipsum". See ui/statsSeats.js.
//
// AND IT CHECKS ITS OWN DETECTOR FIRST, the way tools/copy-check.mjs does. A
// parser that quietly stops matching turns this into a green light that means
// nothing, which is worse than not having it.
//
//   npm run test:rivecopy
// ============================================================================

import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../path/src/csvTable.js';
import { isDraft, hasOpenBrief } from './draft-copy.mjs';
// The seat→row arithmetic, which is a fifth way the page can draw lorem and the
// only one that is not about the CSV at all — see section 8.
import { STATS_SEATS, STATS_PER_COLUMN, seatIndexForRow } from '../path/src/ui/statsSeats.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RML = join(ROOT, 'rive/blubberball/data.rml');
const ARTBOARDS = ['rive/blubberball/seat-card.rml', 'rive/blubberball/stats-page.rml',
                   'rive/blubberball/goal-card.rml'];
const COPY = join(ROOT, 'path/src/ui/statsCopy.js');
const CSV = join(ROOT, 'path/src/uiText.csv');

let failed = 0;
const pass = (m, d = '') => console.log(`  ok   ${m}${d ? ` — ${d}` : ''}`);
const fail = (m, d = '') => { failed++; console.log(`  FAIL ${m}${d ? ` — ${d}` : ''}`); };
const section = (t) => console.log(`\n${t}`);

// --------------------------------------------------------------------- parse

/**
 * Every `ViewModelPropertyString` in the .rml, as name → { id, viewModel }.
 *
 * Deliberately a regex over the markup rather than a run of `rive inspect`:
 * this has to work with no CLI installed and no network, because a gate that
 * only runs on the machine that authored the file is not a gate.
 */
function stringProperties(text) {
  const out = new Map();
  let vm = null;
  for (const line of text.split(/\r?\n/)) {
    const model = /<ViewModel\b[^>]*\bname="([^"]+)"/.exec(line);
    if (model) vm = model[1];
    const prop = /<ViewModelPropertyString\b[^>]*\bname="([^"]+)"[^>]*\bid="([^"]+)"/.exec(line);
    if (prop) out.set(prop[1], { id: prop[2], viewModel: vm });
  }
  return out;
}

/** The authored value of every string, as property id → value. */
function authoredStrings(text) {
  const out = new Map();
  for (const m of text.matchAll(
    /<ViewModelInstanceString\b[^>]*\bpropertyValue="([^"]*)"[^>]*\bviewModelPropertyId="([^"]+)"/g)) {
    out.set(m[2], m[1]);
  }
  return out;
}

/**
 * The manifest: rive property → the uiText ids that can land in it, read
 * straight out of statsCopy.js.
 *
 * TWO SHAPES, AND A PROPERTY CAN HAVE MORE THAN ONE ROW. Most slots are a
 * `name: uiText('id')` line in the labels map and have exactly one. The
 * result's line has two — a win and a draw are different sentences in the same
 * slot — and is written as an exported function named for the property, with
 * both ids as literals inside it. The literal is the whole requirement: it is
 * what lets this file, and tools/ui-text-test.mjs, match a read to a row
 * without running anything. An id held in a variable satisfies neither shape
 * and is meant not to.
 */
function manifest(text) {
  const out = new Map();
  const add = (prop, id) => { out.set(prop, [...(out.get(prop) ?? []), id]); };
  for (const m of text.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):\s*uiText\('([^']+)'\)/gm)) {
    add(m[1], m[2]);
  }
  // `export function championLabel(draw) { return draw ? uiText('a') : uiText('b'); }`
  // — the function's name IS the property, and every literal id in its body is
  // a row that can reach that slot.
  //
  // NOT THE FUNCTION THAT RETURNS THE MAP. statsLabels() is a function full of
  // uiText calls too, and read this way it becomes one imaginary property
  // called "statsLabels" holding sixteen rows — which fails section 1 against
  // a data.rml that of course has no such property. A body carrying `name:`
  // lines is a manifest and the loop above has already had it.
  const isMap = /^\s*[A-Za-z][A-Za-z0-9]*:\s*uiText\(/m;
  for (const fn of text.matchAll(/^export function ([A-Za-z][A-Za-z0-9]*)\s*\([^)]*\)\s*\{([\s\S]*?)^\}/gm)) {
    if (isMap.test(fn[2])) continue;
    for (const m of fn[2].matchAll(/uiText\('([^']+)'\)/g)) add(fn[1], m[1]);
  }
  return out;
}

// ------------------------------------------------------- the detectors' test

section('0. the parsers can still see what they are looking for');
{
  const probe = `
    <ViewModel defaultInstanceId="9:1" name="Probe" id="9:0">
        <ViewModelPropertyString name="probeLabel" id="9:2"/>
        <ViewModelInstance exports="true" name="Default" id="9:1">
            <ViewModelInstanceString propertyValue="lorem" viewModelPropertyId="9:2" id="0:1"/>
        </ViewModelInstance>
    </ViewModel>`;
  const props = stringProperties(probe);
  const vals = authoredStrings(probe);
  props.has('probeLabel')
    ? pass('a string property is found', `probeLabel on ${props.get('probeLabel').viewModel}`)
    : fail('the property parser matched nothing — every check below is meaningless');
  vals.get('9:2') === 'lorem'
    ? pass('its authored value is found')
    : fail('the authored-value parser matched nothing');
  manifest(`    title: uiText('statsTitle'),`).get('title')?.[0] === 'statsTitle'
    ? pass('a manifest line is found')
    : fail('the manifest parser matched nothing');
  // ...and the function shape, which carries more than one row into one slot.
  const both = manifest([
    "export function resultLabel(draw) {",
    "  return draw ? uiText('aDraw') : uiText('aWin');",
    '}',
  ].join('\n')).get('resultLabel') ?? [];
  both.length === 2 && both.includes('aDraw') && both.includes('aWin')
    ? pass('a multi-row slot is found', both.join(' / '))
    : fail(`the function-shape parser matched ${both.length} id(s), not 2`);
}

// ---------------------------------------------------------------------- load

const rml = readFileSync(RML, 'utf8');
const props = stringProperties(rml);
const authored = authoredStrings(rml);
const map = manifest(readFileSync(COPY, 'utf8'));

const csv = parseCsv(readFileSync(CSV, 'utf8'));
const head = csv[0];
const col = (n) => head.indexOf(n);
const rows = new Map(csv.slice(1).map((r) => [r[col('id')], r]));

if (!map.size) fail('statsCopy.js declared no labels at all');

// ------------------------------------------------------------------ 1. props

section('1. every property statsCopy.js writes exists in data.rml');
for (const [prop, ids] of map) {
  props.has(prop)
    ? pass(prop, `${ids.join(' / ')} → ${props.get(prop).viewModel}.${prop}`)
    : fail(prop, `no ViewModelPropertyString named "${prop}" — the write is a silent no-op`);
}

// ------------------------------------------------------------------- 2. rows

section('2. every uiText id it reads has a row');
for (const [prop, ids] of map) for (const id of ids) {
  const row = rows.get(id);
  if (!row) { fail(id, `no row in uiText.csv, so ${prop} would render the id itself`); continue; }
  const text = row[col('text')] ?? '';
  if (!text.trim()) fail(id, 'the row is there but its text is empty');
  else pass(id, JSON.stringify(text.slice(0, 28)));
}

// -------------------------------------------------------------- 3. coverage

// The string properties a player does NOT read as a written line: they carry
// names and numbers the match supplies, and their authored values are pure
// stand-ins. Listed by hand and with a reason, because "everything else is
// covered" is the check — a slot added later and left off this list fails
// rather than passing quietly.
const DATA_OWNED = new Map([
  ['leftName', 'the left side\'s team name, cast by systems/teamNameCast.js'],
  ['rightName', 'the right side\'s team name, same'],
  ['seatName', 'a seat\'s seal, cast by systems/rosterCast.js (SeatCard)'],
  ['roleLabel', 'captain / locked / cpu — written by the team select, not this page'],
  ['readyLabel', 'the ready stamp, written by the team select'],
  ['name', 'a seat\'s seal on the players tab (PlayerStat)'],
  ['scorerName', 'who scored, off systems/rosterCast.js (GoalCard)'],
  ['goalLine', 'the assist or own-goal line, ALREADY COMPOSED — versus.js fills {name} into the versusAssist row, because who assisted is a sentence the match builds and not a label this artboard could look up'],
  ['goalClock', 'the match clock the goal landed on'],
  ['championName', 'the winning SIDE, cast by systems/teamNameCast.js — the label beside it is copy and is checked above, but who won is the match\'s own fact. Blank on a draw, where the label carries the whole line'],
]);

section('3. every player-facing string property is joined to a row');
for (const [prop, meta] of props) {
  if (map.has(prop)) continue;
  DATA_OWNED.has(prop)
    ? pass(`${prop} is data, not copy`, DATA_OWNED.get(prop))
    : fail(prop, `on ${meta.viewModel} — neither in statsCopy.js nor listed as data, so it would draw its placeholder forever`);
}

// --------------------------------------------------------------- 4. bound

/**
 * Every `TextValueRun`, and whether it carries a `DataBindContext`.
 *
 * A run is written either as a self-closing tag (no bind, nothing inside it)
 * or as an open tag with children. That difference IS the check, so it is read
 * off the markup rather than inferred: `<TextValueRun … />` draws its own
 * `text=` and nothing can ever replace it.
 */
function textRuns(text) {
  const out = [];
  for (const m of text.matchAll(/<TextValueRun\b([^>]*?)(\/)?>/g)) {
    const attrs = m[1];
    const selfClosing = Boolean(m[2]);
    const name = /\bname="([^"]*)"/.exec(attrs)?.[1] ?? '?';
    const id = /\bid="([^"]*)"/.exec(attrs)?.[1] ?? '?';
    const value = /\btext="([^"]*)"/.exec(attrs)?.[1] ?? '';
    let bound = false;
    if (!selfClosing) {
      const close = text.indexOf('</TextValueRun>', m.index);
      bound = close > 0 && text.slice(m.index, close).includes('<DataBindContext');
    }
    out.push({ id, name, value, bound });
  }
  return out;
}

section('4. every text run in the artboard is data-bound');
{
  const probe = textRuns('<TextValueRun text="x" id="1:1"/>\n'
    + '<TextValueRun text="y" id="1:2"><DataBindContext propertyKey="268"/></TextValueRun>');
  if (probe.length !== 2 || probe[0].bound || !probe[1].bound) {
    fail('the run parser is broken — it cannot tell a bound run from an unbound one');
  } else {
    pass('the run parser tells them apart');
    for (const file of ARTBOARDS) {
      const runs = textRuns(readFileSync(join(ROOT, file), 'utf8'));
      const loose = runs.filter((r) => !r.bound);
      loose.length === 0
        ? pass(file.split('/').pop(), `all ${runs.length} runs bound`)
        : fail(file.split('/').pop(),
            `${loose.length} run(s) draw their own text and no CSV row can reach them: `
            + loose.map((r) => `${r.name} ${r.id} = ${JSON.stringify(r.value)}`).join('; '));
    }
  }
}

// ------------------------------------------------------- 5. still placeholder

section('5. the .rml still holds placeholders, not copy');
for (const [prop, id] of map) {
  const pid = props.get(prop)?.id;
  if (!pid) continue;                       // already failed in section 1
  const value = authored.get(pid);
  if (value === undefined) { fail(prop, 'has no authored value at all'); continue; }
  isDraft(value)
    ? pass(prop, `${JSON.stringify(value)} — still a placeholder`)
    : fail(prop, `authored as ${JSON.stringify(value)}. Words in the .rml are a second home for copy the CSV editor cannot see — put it in uiText.csv row "${id}" and leave lorem here`);
}

// ------------------------------------------------------------------ 5. brief

// Not a failure: a row still waiting is the copy gate's business, and this
// says so rather than duplicating that verdict.
section('6. rows still waiting on Ethan (reported, not failed)');
{
  const owed = [...map.values()].filter((id) => {
    const row = rows.get(id);
    return row && (isDraft(row[col('text')]) || hasOpenBrief(row[col('notes')]));
  });
  if (!owed.length) pass('every label on the stats page is written');
  else console.log(`  ..   ${owed.length} waiting: ${owed.join(', ')}  (npm run test:copy blocks the ship)`);
}

// ------------------------------------------------------------------ 7. stale

// THE FILE THE GAME LOADS IS A COPY, and a copy goes stale in silence. Editing
// a .rml and forgetting `npm run rive` leaves path/src/ui/blubberball.riv at
// the previous build — every test here still passes, because every test here
// reads the SOURCE, and the game keeps drawing the old artboard.
//
// Compared by mtime rather than by content: checking the content would mean
// running the Rive CLI, which this deliberately does not require. A timestamp
// cannot prove the copy is right, but it catches the whole of the mistake that
// actually happens, which is forgetting to make one.
section('7. the .riv the game loads is not older than its source');
{
  const shipped = join(ROOT, 'path/src/ui/blubberball.riv');
  let riv = null;
  try { riv = statSync(shipped).mtimeMs; } catch { riv = null; }
  if (riv === null) {
    fail('path/src/ui/blubberball.riv is missing', 'run `npm run rive`');
  } else {
    const sources = [RML, ...ARTBOARDS.map((f) => join(ROOT, f))];
    const stale = sources.filter((f) => statSync(f).mtimeMs > riv).map((f) => f.split('/').pop());
    stale.length
      ? fail('the shipped .riv is older than', `${stale.join(', ')} — run \`npm run rive\``)
      : pass(`up to date with all ${sources.length} .rml files`);
  }
}

// ------------------------------------------------------------- 8. seat rows

// THE FIFTH WAY THIS PAGE DRAWS LOREM, and the only one with nothing to do
// with the CSV: a row of the players tab that is DRAWN but never WRITTEN keeps
// the name it was authored with, which is "Lorem ipsum".
//
// The two columns are the two sides — `player1`..`player4` down the left,
// `player5`..`player8` down the right — and `seatsPerSide` says how many rows
// of each are drawn. The seat list the match hands over is dense, so the break
// between the sides is at `seatsPerSide`, not at four. Reading it as "0..3
// left, 4..7 right" is right for a four-a-side and wrong for every smaller
// match; a 1v1 wrote `player1` and `player2` and drew `player1` and `player5`.
//
// So: for every roster size, every row the artboard DRAWS must be handed a
// seal, each seal must be handed to exactly one row, and the sides must land
// in the right columns.
section('8. every row the players tab draws is written');
for (let perSide = 1; perSide <= STATS_PER_COLUMN; perSide++) {
  const drawn = [];
  for (let i = 0; i < STATS_SEATS; i++) {
    if (i % STATS_PER_COLUMN < perSide) drawn.push(i);
  }
  const at = drawn.map((i) => seatIndexForRow(i, perSide));
  const unwritten = drawn.filter((_, k) => at[k] < 0);
  const seals = perSide * 2;

  if (unwritten.length) {
    fail(`${perSide}-a-side fills every drawn row`,
         `player${unwritten.map((i) => i + 1).join(', player')} would draw lorem`);
  } else if (new Set(at).size !== seals || at.some((x) => x >= seals)) {
    fail(`${perSide}-a-side reads each seal once`, `rows read seats ${at.join(',')}`);
  } else {
    // The left column must be the first side and the right the second —
    // otherwise both sides are written but a seal sits under the wrong team.
    const left = drawn.filter((i) => i < STATS_PER_COLUMN).map((i) => seatIndexForRow(i, perSide));
    const right = drawn.filter((i) => i >= STATS_PER_COLUMN).map((i) => seatIndexForRow(i, perSide));
    const ok = left.every((x) => x < perSide) && right.every((x) => x >= perSide);
    ok
      ? pass(`${perSide}-a-side`, `left ${left.join(',')} | right ${right.join(',')}`)
      : fail(`${perSide}-a-side puts each side in its own column`,
             `left ${left.join(',')} | right ${right.join(',')}`);
  }
}
{
  // A row past the end of its column is left alone ON PURPOSE — it is not
  // drawn. If that ever started returning an index, a four-a-side artboard
  // showing one row a side would print the wrong seal in it.
  const quiet = seatIndexForRow(1, 1) < 0 && seatIndexForRow(STATS_PER_COLUMN + 1, 1) < 0;
  quiet ? pass('a row the artboard is not drawing is left alone')
        : fail('a row the artboard is not drawing is left alone', 'it was handed a seal');
}

console.log(failed ? `\n${failed} failed\n` : '\nall good\n');
process.exit(failed ? 1 : 0);
