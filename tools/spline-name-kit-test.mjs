// ============================================================================
// THE NAME KIT, EXERCISED AS THE SCENE WILL RUN IT.
//
//   npm run test:splinekit
//
// The bundle is the ONLY thing checked here, and on purpose. path/src is
// covered by tools/seal-name-test.mjs and friends; what those cannot see is
// whether the bundle the Spline scene actually runs still contains that code.
// A stale bundle passes every test in the repo and shows the wrong names on
// screen, which is the exact failure mode of the 30x30 word list this replaced.
//
// So the bundle is loaded the way the browser loads it — evaluated as a script
// in a bare context with nothing but a `window` and a storage stub — and then
// asked questions whose answers come from path/src. If someone edits
// sealNames.csv and forgets `npm run spline:kit`, the counts here stop matching
// the CSV and this fails.
// ============================================================================

import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failed = 0;
const ok = (cond, what) => {
  if (cond) console.log(`  ok   ${what}`);
  else { failed += 1; console.log(`  FAIL ${what}`); }
};

// A storage stub rather than none. nameLedger survives storage being absent by
// falling back to memory-only — which would make every ledger assertion below
// pass for the wrong reason, since the in-memory copy behaves identically for
// one session. Giving it working storage means the persisted path is the one
// under test.
function makeContext() {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const ctx = { console, localStorage };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return createContext(ctx);
}

const bundlePath = path.join(HERE, 'spline', 'name-kit.bundle.js');
let code;
try {
  code = await readFile(bundlePath, 'utf8');
} catch {
  console.log(`FAIL no bundle at ${path.relative(ROOT, bundlePath)} — run \`npm run spline:kit\``);
  process.exit(1);
}

const ctx = makeContext();
runInContext(code, ctx, { filename: 'name-kit.bundle.js' });
const K = ctx.SealNames;

console.log('\nthe bundle loads');
ok(!!K, 'evaluates and exposes window.SealNames');
if (!K) process.exit(1);
ok(typeof K.randomPlayerName === 'function', 'exposes randomPlayerName');
ok(typeof K.makeSyntheticRecords === 'function', 'exposes makeSyntheticRecords');

// ---------------------------------------------------------------------------
// THE TABLE IS THE REAL ONE.
//
// Measured by running path/src's OWN PARSER over path/src's own CSV, and not by
// counting lines in the file. A line count is a second, worse implementation of
// the parser and it disagrees with the real one the moment the file does
// anything interesting: two rows sharing an `id` collapse to one (parseIdTable
// keeps the last), a disabled row is a line that is not a part, and a quoted
// note containing a comma is not even a column boundary. Counting lines here
// once reported 72 adjectives against the parser's 71 and called the bundle
// stale when it was current.
//
// So this compares PARSER TO PARSER: path/src's, running now, against the copy
// frozen into the bundle. Which is exactly the question — has the CSV moved
// since the bundle was built?
console.log('\nthe table is the game\'s table, not a copy of one');
const { parseSealNameCsv } = await import(new URL('../path/src/sealNameTable.js', import.meta.url));
const csv = await readFile(path.join(ROOT, 'path/src/sealNames.csv'), 'utf8');
const live = parseSealNameCsv(csv, () => {});   // warnings are the table's business, not this test's
const stats = K.tableStats();
ok(stats.adjectives === live.adjective.length, `${stats.adjectives} adjectives, and the CSV parses to ${live.adjective.length}`);
ok(stats.nicknames === live.nickname.length, `${stats.nicknames} nicknames, and the CSV parses to ${live.nickname.length}`);
ok(stats.full === live.full.length, `${stats.full} written names, and the CSV parses to ${live.full.length}`);
ok(stats.adjectives > 30 && stats.nicknames > 30, 'not the 30x30 word list the scene used to carry');

// Not just the counts: the same words, in the same order, with the same
// weights. A row whose TEXT was edited leaves every count identical, and that
// is the commonest edit the table gets.
const flat = (p) => [...p.adjective, ...p.nickname, ...p.full].map((r) => `${r.id}:${r.text}:${r.weight}`).join('|');
ok(flat(K.sealNameParts()) === flat(live), 'and the same rows, word for word');

// A word from the CSV that the old fork could not possibly have produced.
const parts = K.sealNameParts();
const adjText = parts.adjective.map((a) => a.text);
ok(adjText.includes('The Honorable'), 'carries "The Honorable", which only comes from the real table');

// ---------------------------------------------------------------------------
console.log('\nrolled names obey the field\'s rules');
const seen = new Set();
let longest = 0;
for (let i = 0; i < 4000; i += 1) {
  const n = K.randomPlayerName('');
  seen.add(n);
  longest = Math.max(longest, n.length);
  if (n !== K.stripName(n).trim()) { ok(false, `"${n}" contains a character the field strips`); break; }
}
ok(longest <= K.MAX_NAME_LEN, `longest of 4000 rolls is ${longest}, and the field holds ${K.MAX_NAME_LEN}`);
ok(seen.size > 500, `4000 rolls produced ${seen.size} distinct names`);

// The reroll contract: pass what is in the field and you do not get it back.
// Checked over many draws because ONE reroll is the contract — a table with a
// single usable name must still terminate — so a rare repeat is legal and a
// systematic one is the bug.
let repeats = 0;
for (let i = 0; i < 2000; i += 1) {
  const cur = K.randomPlayerName('');
  if (K.randomPlayerName(cur) === cur) repeats += 1;
}
ok(repeats < 40, `${repeats}/2000 rerolls handed back the name already in the field`);

// ---------------------------------------------------------------------------
console.log('\nthe ledger buries, and the dice respect it');
K.clearNameLedger();
ok(K.buriedCount() === 0, 'starts empty');
const victim = K.randomPlayerName('');
K.buryName(victim);
ok(K.isNameBuried(victim), `"${victim}" is buried`);
ok(K.isNameBuried(victim.toUpperCase()), 'and buried case-insensitively');
let offered = false;
for (let i = 0; i < 3000; i += 1) if (K.randomPlayerName('') === victim) { offered = true; break; }
ok(!offered, 'and is never offered again in 3000 rolls');

// ---------------------------------------------------------------------------
console.log('\nsynthetic graveyards are made of real parts');
K.clearNameLedger();
const a = K.makeSyntheticRecords({ seed: 7, count: 40, stones: 12 });
const b = K.makeSyntheticRecords({ seed: 7, count: 40, stones: 12 });
const c = K.makeSyntheticRecords({ seed: 8, count: 40, stones: 12 });
ok(JSON.stringify(a) === JSON.stringify(b), 'the same seed gives the same graveyard');
ok(JSON.stringify(a) !== JSON.stringify(c), 'a different seed gives a different one');
ok(a.buried.length === 40, `asked for 40 seals and got ${a.buried.length}`);
ok(new Set(a.buried.map(K.nameKey)).size === 40, 'all 40 are distinct seals, not 40 draws');
ok(a.graves.length === 12, `12 stones stand over ${a.buried.length} buried`);
ok(a.graves.every((g) => a.buried.includes(g.name)), 'every stone names someone in the ledger');

const causeLabels = new Set(K.DEATH_CAUSES.map((d) => d.label));
ok(a.graves.every((g) => causeLabels.has(g.cause)), 'every cause is one deathCauses.js words');
ok(a.graves.every((g) => g.cause !== 'a boss'), 'and never the unclassified "a boss" bucket');
ok(a.graves.every((g) => g.lead && g.lead.trim()), 'every stone has an epitaph lead');

// ---------------------------------------------------------------------------
console.log('\nthe file survives the round trip');
const json = K.packRecordsJson({ buried: a.buried, graves: a.graves });
const back = K.parseRecords(json);
ok(back.warnings.length === 0, 'a file we wrote reads with no warnings');
ok(back.buried.length === a.buried.length, `${back.buried.length} buried back out of ${a.buried.length}`);
ok(JSON.stringify(back.graves) === JSON.stringify(a.graves), 'the stones come back identical');

ok(K.parseRecords('not json').warnings.length === 1, 'garbage is one warning, not a throw');
ok(K.parseRecords('[]').buried.length === 0, 'a bare array is refused, not read');
const dirty = K.parseRecords(JSON.stringify({ kind: K.RECORDS_KIND, version: 1, buried: ['Fat Tony', 3, '', null], graves: [{ cause: 'a shark' }] }));
ok(dirty.buried.length === 1 && dirty.buried[0] === 'Fat Tony', 'non-string names are dropped, not carried as undefined');
ok(dirty.graves.length === 0, 'a grave with no name is dropped');
ok(dirty.warnings.length === 2, `and both drops are reported (${dirty.warnings.length} warnings)`);

// ---------------------------------------------------------------------------
console.log('\nloading a file replaces the ledger rather than adding to it');
K.clearNameLedger();
K.loadRecords(a.buried);
ok(K.buriedCount() === 40, `40 loaded, ledger holds ${K.buriedCount()}`);
ok(K.isNameBuried(a.buried[0]), 'and the first of them is buried');
K.loadRecords(c.buried);
ok(K.buriedCount() === c.buried.length, 'a second load replaces the first');
const onlyInA = a.buried.filter((n) => !c.buried.some((m) => K.nameKey(m) === K.nameKey(n)));
ok(onlyInA.length === 0 || !K.isNameBuried(onlyInA[0]), 'names from the first file are gone, not merged');

console.log(failed ? `\n${failed} failed\n` : '\nall good\n');
process.exit(failed ? 1 : 0);
