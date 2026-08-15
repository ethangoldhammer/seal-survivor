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
import { causesOfDeath, unclassifiedSources } from '../path/src/deathCauses.js';

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

// ---------------------------------------------------------------------------
// CAUSE OF DEATH
//
// The `causes` column decides WHICH line a death gets, and every failure in
// here is silent: a tag that matches nothing is a line that never fires, and a
// creature nobody classified is a joke that never lands. Neither shows up as
// an error in the game — you would only notice by dying a hundred times and
// feeling that the headline had gone generic.
// ---------------------------------------------------------------------------
section('Cause of death — the taxonomy');

const idsOf = (rel) => readFileSync(resolve(here, rel), 'utf8')
  .trim().split(/\r?\n/).slice(1).map((l) => l.split(',')[0].trim()).filter(Boolean);

// THE DRIFT CHECK. deathCauses.js writes its membership out by hand — there is
// no flag on a creature to derive it from — so this is what stops a creature
// added to enemies.csv from killing the player under no cause at all. If this
// fails, the fix is a one-word edit: put the new id in the cause it belongs to.
const unclassified = unclassifiedSources(idsOf('../path/src/enemies.csv'));
check('every creature in enemies.csv belongs to a cause',
  unclassified.length === 0, unclassified.join(', '));
const unclassifiedBosses = unclassifiedSources(idsOf('../path/src/bosses.csv'));
check('every archetype in bosses.csv belongs to a cause',
  unclassifiedBosses.length === 0, unclassifiedBosses.join(', '));

// Every boss is a boss, whichever animal it is wearing.
check('a boss death is also its animal\'s cause',
  [...causesOfDeath('bossShark')].sort().join(',') === 'boss,shark',
  [...causesOfDeath('bossShark')].join(','));
// The trawler's salvo and every perk arrive with no creature key at all.
check('a boss ATTACK still counts as a boss death',
  causesOfDeath('boss:boatSalvo').has('boss'));
// ...and the shells specifically are still the trawler killing you, which is
// the difference between the boat line firing on a ram and firing on a shot.
check('the trawler\'s shells count as the trawler',
  ['boss:boatRain', 'boss:boatSalvo', 'boss:boatSpread'].every((s) => causesOfDeath(s).has('boat')));
check('a boss PERK is a boss death and nothing narrower',
  [...causesOfDeath('boss:electricAura')].join(',') === 'boss');
check('the three non-animal deaths classify',
  causesOfDeath('drowning').has('drowning')
  && causesOfDeath('lightning').has('lightning')
  && causesOfDeath('enemy shot').has('shot'));
// A guess here would be worse than nothing: it would fire somebody's crab joke
// for a death that had no crab in it.
check('an unknown source claims no cause', causesOfDeath('kelp').size === 0);
check('no source at all claims no cause', causesOfDeath(null).size === 0);

section('Cause of death — which line is dealt');
const tagged = parseQuipCsv(
  'id,text,causes\ngeneral,Anything,\ngeneral2,Anything else,\ncrabby,Crab Food,crab\nwet,No air,drowning\nboth,"Crab or shark",crab shark',
  quiet,
);
const drawn = (cause, n = 200) => {
  const out = new Set();
  for (let i = 0; i < n; i++) out.add(pickQuip(tagged, Math.random, causesOfDeath(cause)));
  return out;
};

// The design decision this table exists to enforce: a written-for line WINS,
// it does not merely join the queue. Tagging "Crab Food" for crab and then
// seeing it one death in five would be the bug.
const byCrab = drawn('walkingCrab');
check('a crab death only draws crab lines',
  [...byCrab].every((t) => t === 'Crab Food' || t === 'Crab or shark'),
  [...byCrab].join(' | '));
check('both crab lines are reachable', byCrab.size === 2, `${byCrab.size}`);
check('a multi-cause line also fires for its other cause',
  drawn('megalodon').has('Crab or shark'));
check('drowning gets the drowning line',
  [...drawn('drowning')].join('') === 'No air');

// The fallbacks, in order. Each one is the difference between a generic
// headline and a blank one.
const byUntagged = drawn('otter');
check('a cause nobody wrote for falls back to the general lines',
  byUntagged.size === 2 && [...byUntagged].every((t) => t.startsWith('Anything')),
  [...byUntagged].join(' | '));
check('an unclassified death falls back to the general lines',
  [...drawn('kelp')].every((t) => t.startsWith('Anything')));
const allTagged = parseQuipCsv('id,text,causes\na,Only crab,crab', quiet);
check('a table of nothing but tagged lines still answers a foreign death',
  pickQuip(allTagged, Math.random, causesOfDeath('drowning')) === 'Only crab');
check('no cause passed at all puts every line in play',
  (() => {
    const seen = new Set();
    for (let i = 0; i < 400; i++) seen.add(pickQuip(tagged));
    return seen.size === 5;
  })());

// A tag that matches nothing is dropped at parse rather than kept, so the row
// stays in the general pool instead of becoming unreachable.
let warned = '';
const typo = parseQuipCsv('id,text,causes\na,Typo,crustacean', (m) => { warned = m; });
check('an unknown cause id is dropped', typo[0].causes === null);
check('and warns, naming it', warned.includes('crustacean'), warned.slice(0, 60));
check('the row still fires for an ordinary death',
  pickQuip(typo, Math.random, causesOfDeath('shark')) === 'Typo');
// Space or comma, because the value comes out of a spreadsheet either way.
check('commas separate causes as well as spaces',
  parseQuipCsv('id,text,causes\na,A,"crab,shark"', quiet)[0].causes.length === 2);

section('The shipped file — causes');
const shippedTags = shipped.filter((q) => q.causes);
check('at least one line is written for a cause', shippedTags.length > 0,
  shippedTags.map((q) => `${q.id}:${q.causes.join('+')}`).join(' '));
// Untagged rows are the safety net for every death nobody wrote a line for.
// Tagging the last of them would make a shark death the only one with a joke.
check('the general pool is not empty', shipped.some((q) => !q.causes),
  `${shipped.filter((q) => !q.causes).length} general`);

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
