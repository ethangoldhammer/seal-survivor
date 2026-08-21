#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:leads
//
// THE MIDDLE LINE OF A GRAVESTONE — epitaphs.csv and path/src/epitaphTable.js.
//
//     FAT TONY
//     chomped by     <- this
//     a shark
//
// Every failure here is silent in the same way the greeting's are: the stone
// still carves, still reads, and says the blandest thing in the file.
//
//   THE BLAND STONE      a cause nobody wrote for falls back to the general
//                        pool. That is the DESIGN — but a cause that fell back
//                        because its tag was misspelled is the same picture,
//                        and the file cannot tell you which.
//   THE EMPTY GENERAL    if every row is tagged, the fallback pool is empty and
//   POOL                 every unwritten cause gets the hardcoded string. The
//                        table looks broken from outside and fine from inside.
//   THE STONE THAT       the lead is rolled ONCE when the grave is filed. Roll
//   CHANGES ITS MIND     it at draw time instead and the inscription rewords
//                        itself every time the player swims past.
//   THE MISMATCHED PAIR  the caption over the grave and the carving on it are
//                        one sentence about one death. Two rolls make two.
// ---------------------------------------------------------------------------
import '../tools/dom-stub.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CSV = resolve(here, '../path/src/epitaphs.csv');

const {
  parseEpitaphCsv, rollLead, leadPool, causesWithoutLeads, FALLBACK_LEAD,
} = await import('../path/src/epitaphTable.js');
const { DEATH_CAUSES, DEATH_CAUSE_IDS, primaryCause } = await import('../path/src/deathCauses.js');

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

section('The shipped file');
const warned = [];
const rows = parseEpitaphCsv(readFileSync(CSV, 'utf8'), (m) => warned.push(m));
check('parses to a table', rows.length >= 10, `${rows.length} leads`);
check('with no warnings', warned.length === 0, warned.slice(0, 2).join(' | '));
check('ids are unique', new Set(rows.map((r) => r.id)).size === rows.length);
check('every lead has text', rows.every((r) => r.text.trim()));
check('every lead has a positive weight', rows.every((r) => r.weight > 0));

// THE GENERAL POOL IS WHAT EVERY UNWRITTEN CAUSE GETS. Empty it and eighteen
// causes fall through to a string hardcoded in a JS file, which is the one
// outcome a table of prose exists to prevent.
check('the general pool is not empty',
  rows.filter((r) => !r.causes).length >= 2,
  `${rows.filter((r) => !r.causes).length} untagged`);

// A LEAD IS A CONNECTOR. It ends where the cause begins, on the line below —
// see the header in epitaphTable.js. Capitalisation is the tell: a lead that
// starts with a capital is a sentence somebody wrote thinking the cause would
// be inside it.
check('every lead is lowercase, so it reads into the line below',
  rows.every((r) => /^[a-z]/.test(r.text)),
  rows.filter((r) => !/^[a-z]/.test(r.text)).map((r) => r.id).join(', '));
check('and none of them ends in punctuation',
  rows.every((r) => !/[.!?,;:]$/.test(r.text)),
  rows.filter((r) => /[.!?,;:]$/.test(r.text)).map((r) => r.id).join(', '));

section('Every death has words of its own');
// THE DRIFT CHECK, and the same one deathCauses.js's own test makes: a creature
// added to enemies.csv and classified into a new cause would fall back here
// silently. The file says which causes are bare rather than the game showing it.
const bare = causesWithoutLeads(rows);
check('every cause has at least one lead written for it', bare.length === 0,
  bare.length ? `bare: ${bare.join(', ')}` : `all ${DEATH_CAUSE_IDS.length}`);

for (const c of DEATH_CAUSES) {
  const pool = leadPool(rows, c.id);
  const own = pool.every((r) => r.causes?.includes(c.id));
  check(`${c.id} draws from its own lines`, pool.length > 0 && own,
    `${pool.length} line(s)`);
}

section('It reads as a sentence');
// EVERY PAIR, PRINTED. A lead is only right in company, and no assertion can
// judge English — so this composes one for each of the eighteen causes and puts
// it in the output where a person reads it.
//
// It is not decoration. "who ran out of" was a perfectly good drowning lead
// until it was set beside the label it would actually be paired with, which is
// the gerund "running out of air" and not the word "air" — and the file shipped
// reading "who ran out of running out of air" with every mechanical check
// green. The composed line is the only thing that could show that.
//
// What IS asserted is the mechanical half: the pair must not repeat a word,
// which is what a lead written against an imagined cause looks like.
const STOP = new Set(['a', 'an', 'the', 'of', 'by', 'to', 'out', 'in', 'who', 'or']);
for (const c of DEATH_CAUSES) {
  const lead = rollLead(rows, c.id, () => 0);
  const words = (t) => t.toLowerCase().split(/[^a-z']+/).filter((x) => x && !STOP.has(x));
  const shared = words(lead).filter((x) => words(c.label).includes(x));
  check(`"${lead} ${c.label}"`, shared.length === 0,
    shared.length ? `repeats "${shared.join(', ')}" — the lead was written against a different cause` : '');
}

section('The roll');
{
  const pool = leadPool(rows, 'shark');
  const seen = new Set(Array.from({ length: 400 }, () => rollLead(rows, 'shark')));
  check('a cause with several lines uses all of them', seen.size === pool.length,
    `${seen.size} of ${pool.length}`);
  check('...and only its own', [...seen].every((t) => pool.some((r) => r.text === t)),
    [...seen].join(' / '));
}
{
  // A cause nobody wrote for. This is the design, not a failure — but it must
  // land in the general pool rather than on the hardcoded fallback.
  const general = rows.filter((r) => !r.causes).map((r) => r.text);
  const got = new Set(Array.from({ length: 200 }, () => rollLead(rows, 'notacause')));
  check('an unknown cause falls back to the general pool',
    [...got].every((t) => general.includes(t)), [...got].join(' / '));
}
{
  check('an empty table still says something', rollLead([], 'shark') === FALLBACK_LEAD);
  check('...and so does a null one', rollLead(null, null) === FALLBACK_LEAD);
  // Every weight zero is a misconfigured file, not an instruction to be silent.
  const zeroed = parseEpitaphCsv('id,text,cause,weight\na,dashed by,,0\nb,undone by,,0', () => {});
  check('a table of zero weights is not silence',
    ['dashed by', 'undone by'].includes(rollLead(zeroed, null)));
}

section('Bad rows are dropped loudly');
{
  const w = [];
  const t = parseEpitaphCsv('id,text,cause\nok,chomped by,shark\nbad,eaten by,crustacean', (m) => w.push(m));
  check('an unknown cause id is dropped', t.find((r) => r.id === 'bad')?.causes === null);
  check('and warns, naming it', w.some((m) => m.includes('crustacean')));
  const w2 = [];
  parseEpitaphCsv('id,text,cause\nall,chomped by,shark', (m) => w2.push(m));
  check('a file with no general rows warns about the fallback',
    w2.some((m) => /every lead/i.test(m)), w2.join(' | '));
}

console.log(failures ? `\nFAILED — ${failures} check(s)\n` : '\nPASS — all checks\n');
process.exit(failures ? 1 : 0);
