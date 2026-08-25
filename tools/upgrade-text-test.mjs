// ---------------------------------------------------------------------------
// npm run test:text
//
// The {placeholder} system in path/src/upgradeText.js, which exists so card
// text can't drift from the code that makes it true. Four things to hold:
//
//   1. MEASUREMENT   the two-probe classifier calls a multiplier a multiplier
//                    and an addition an addition, and reads the FIRST-PICK
//                    branch that the all-100 block in upgrade-test.mjs hides.
//   2. COVERAGE      every stat an upgrade actually touches has an English
//                    label. A new stat with no entry silently degrades to its
//                    variable name on a card, which is the one failure mode
//                    nobody would notice in review.
//   3. TOKENS        each one resolves, and a typo'd one stays VISIBLE.
//   4. CONTENT       every {token} written in upgrades.csv today resolves
//                    without a warning.
//
//   node --import ./tools/vite-loader.mjs tools/upgrade-text-test.mjs
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG, LEVELUP_IMAGE_KEYS } from '../path/src/config.js';
import { baseStats } from '../path/src/stats.js';
import { parseUpgradeCsv, applyUpgradeTable } from '../path/src/upgradeTable.js';
import { STAT_TEXT, TOKENS, measure, measureTotal, phrase, phraseAll, expandDesc, sentenceCase } from '../path/src/upgradeText.js';
import { parseStatTextCsv, KINDS } from '../path/src/statTextTable.js';
import { savePlayerName, clearPlayerName, expandPlayer, DEFAULT_PLAYER_NAME } from '../path/src/systems/playerName.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${msg}`);
  if (!cond) failed++;
};
const by = (id) => CONFIG.upgrades.find((u) => u.id === id);

// ===========================================================================
console.log('\n1. measurement — multipliers, additions, and the first-pick branch');
// ===========================================================================

const rapid = measure(by('rapidFire'), 1);
ok(rapid.length === 1 && rapid[0].stat === 'fireRate' && rapid[0].how === 'mul',
  `rapidFire reads as a multiplier on fireRate (${rapid[0]?.how} on ${rapid[0]?.stat})`);
ok(Math.abs(rapid[0].ratio - 0.75) < 1e-9, `and the ratio measures 0.75 (got ${rapid[0]?.ratio})`);
ok(phraseAll(rapid) === '+25% fire rate', `phrased as "+25% fire rate" (got "${phraseAll(rapid)}")`);

const vit = measure(by('vitality'), 1);
ok(vit[0].how === 'add' && vit[0].amount === 30, `vitality reads as +30 additive (${vit[0]?.how} ${vit[0]?.amount})`);

// The one the synthetic all-100 block cannot see: shrimpRing's apply() opens
// the ring at CONFIG.shrimpRing.baseCount only when shrimpCount is falsy, and
// a block seeded at 100 takes the other branch every time.
const shrimp1 = measure(by('shrimpRing'), 1);
const shrimp2 = measure(by('shrimpRing'), 2);
const baseCount = CONFIG.shrimpRing.baseCount;
ok(shrimp1[0].amount === baseCount,
  `shrimpRing's FIRST pick measures the opening ring of ${baseCount}, not +1 (got +${shrimp1[0]?.amount})`);
ok(shrimp2[0].amount === 1, `and its second pick measures +1 (got +${shrimp2[0]?.amount})`);

// Compounding around 1 is neither additive nor a clean ratio, and must fall
// through to the honest before -> after rather than being forced into one.
const chain = measure(by('strikePower'), 1).find((c) => c.stat === 'strikeChainMul');
ok(chain?.how === 'other', `strikePower's compounding chain multiplier reports as measured endpoints (${chain?.how})`);

// {total} across stacks compounds rather than multiplying by the stack count.
const total4 = measureTotal(by('rapidFire'), 4).find((c) => c.stat === 'fireRate');
ok(Math.abs(total4.ratio - 0.75 ** 4) < 1e-9,
  `four Rapid Fires compound to 0.75^4 (got ${total4.ratio.toFixed(6)})`);

// An ability level also starts at 0, so naming the ability has to be reserved
// for a single level rather than for any climb that began at zero — a maxed
// Sea Garlic totals nine levels, and naming the aura would lose them.
const garlic1 = phraseAll(measureTotal(by('seaGarlic'), 1));
const garlic9 = phraseAll(measureTotal(by('seaGarlic'), 9));
ok(garlic1 === STAT_TEXT.garlicLevel.unlock, `one Sea Garlic totals to the ability itself ("${garlic1}")`);
ok(garlic9 === '+9 sea garlic levels', `nine total to nine levels, not to an unlock ("${garlic9}")`);

// ===========================================================================
console.log('\n2. coverage — every stat an upgrade moves has English for it');
// ===========================================================================

const touched = new Map();
for (const u of CONFIG.upgrades) {
  for (const c of measure(u, 1)) {
    if (!touched.has(c.stat)) touched.set(c.stat, u.id);
  }
}
const unlabelled = [...touched].filter(([stat]) => !STAT_TEXT[stat]);
ok(unlabelled.length === 0, unlabelled.length
  ? `no label in STAT_TEXT for: ${unlabelled.map(([s, id]) => `${s} (${id})`).join(', ')} — those would render as raw variable names`
  : `all ${touched.size} stats moved by an upgrade have a label`);

// A label for a stat nothing touches is dead weight, not a failure — it may be
// waiting for an upgrade that isn't written yet (recoil is exactly that).
const unused = Object.keys(STAT_TEXT).filter((s) => !touched.has(s));
if (unused.length) console.log(`        (labelled but unmoved, fine: ${unused.join(', ')})`);

// Every upgrade says SOMETHING, or is a known no-op. overboost scales `recoil`,
// which sits at 0, so multiplying it changes nothing — and {effect} correctly
// declines to claim an effect rather than inventing "+30%".
const silent = CONFIG.upgrades.filter((u) => !phraseAll(measure(u, 1)));
const expectedSilent = silent.every((u) => {
  const s = baseStats();
  return measure(u, 1).length === 0;
});
ok(expectedSilent, `every upgrade with no {effect} text genuinely moves no stat: ${silent.map((u) => u.id).join(', ') || 'none'}`);
if (silent.length) console.log(`        (silent: ${silent.map((u) => u.id).join(', ')} — check the base value isn't zero)`);

// ===========================================================================
console.log('\n3. tokens — each resolves, and a bad one stays on the card');
// ===========================================================================

// Expected values are sentence-cased, because expandDesc is the last thing a
// card's text goes through and it opens the string with a capital. "+25% fire
// rate" is untouched — the rule only reaches a letter, so a measured number
// still leads with the number it measured.
const r = by('rapidFire');
const cases = [
  ['{effect}', '+25% fire rate'],
  ['{name}', r.name],
  ['{level}', '1'],
  ['{owned}', '0'],
  ['{stacks}', r.maxStacks == null ? 'Unlimited' : String(r.maxStacks)],
  ['{cfg:weapon.damage}', String(CONFIG.weapon.damage)],
  ['no braces here', 'No braces here'],
];
for (const [input, want] of cases) {
  const got = expandDesc(input, r, { owned: 0 });
  ok(got === want, `${input} -> "${got}"${got === want ? '' : ` (expected "${want}")`}`);
}

ok(expandDesc('a {effect:3} b', r, { owned: 0 }) === 'A +25% fire rate b', '{effect:3} resolves a specific stack');
ok(expandDesc('{level}', r, { owned: 4 }) === '5', '{level} follows how many are already owned');

const warned = [];
const bad = expandDesc('x {nope} y {cfg:not.a.path} z', r, { owned: 0, warn: (m) => warned.push(m) });
ok(bad === 'X {nope} y {cfg:not.a.path} z', 'unknown tokens are left visible rather than blanked');
ok(warned.length === 2, `and both warn (${warned.length} warnings)`);

// A broken apply() must not take the level-up screen down with it.
const exploding = { id: 'boom', name: 'Boom', apply: () => { throw new Error('nope'); } };
ok(expandDesc('{effect}', exploding, { owned: 0 }) === '{effect}', 'an apply() that throws leaves the token, it does not crash');
ok(TOKENS.length > 0 && TOKENS.every((t) => t.token && t.help), `TOKENS documents all ${TOKENS.length} placeholders for the editor`);

// {player} — the one token here that is not about the card. It is worth a
// check on THIS path specifically: a card resolves its tokens through
// expandDesc and a callout resolves the same token through fillBindings, so
// "they agree" is a claim about two code paths that share only the module the
// name lives in. A second copy of the name is what this catches.
clearPlayerName();
ok(expandDesc('{player} did it', r, { owned: 0 }) === `${DEFAULT_PLAYER_NAME} did it`,
  '{player} falls back to the default on a card');
savePlayerName('Ethan');
ok(expandDesc('{player} did it', r, { owned: 0 }) === 'Ethan did it',
  '...and follows the typed name');
ok(expandDesc('{player}', r, { owned: 0 }) === expandPlayer('{player}'),
  '...to exactly what the other text tables say');
ok(TOKENS.some((t) => t.token === '{player}'),
  '...and it is documented for the editor, like every other placeholder');
clearPlayerName();

// ===========================================================================
console.log('\n4. content — the tokens actually written in upgrades.csv today');
// ===========================================================================

const csv = await readFile(resolve(HERE, '../path/src/upgrades.csv'), 'utf8');
const rows = parseUpgradeCsv(csv, () => {});
let templated = 0, clean = 0;
for (const [id, row] of rows) {
  const desc = String(row.desc ?? '');
  if (!desc.includes('{')) continue;
  templated++;
  const u = by(id);
  if (!u) { ok(false, `${id} has a templated desc but no upgrade with that id`); continue; }
  const w = [];
  const out = expandDesc(desc, u, { owned: 0, warn: (m) => w.push(m) });
  if (w.length) ok(false, `${id}: ${w[0]}`);
  else { clean++; console.log(`  ok   ${id} -> "${out}"`); }
}
ok(templated === clean, templated
  ? `${clean}/${templated} templated descriptions resolve cleanly`
  : 'no descriptions use placeholders yet — nothing to check');

// HOUSE STYLE, checked against every card rather than against the handful
// above: a desc opens like a sentence, and the measured half never puts a verb
// in front of an ability it is handing over. Both are one-line rules that a
// new STAT_TEXT entry or a new CSV row can break silently — the card still
// renders, it just reads wrong, and nobody diffs forty-nine strings by eye.
{
  const lowerOpen = [], verbed = [];
  for (const u of CONFIG.upgrades) {
    for (const level of [1, 2]) {
      const out = expandDesc(u.levelDescs?.[level] ?? u.desc ?? '', u, { owned: level - 1 });
      if (/^[a-z]/.test(out)) lowerOpen.push(`${u.id}: "${out}"`);
      if (/\bunlocks\b/.test(out)) verbed.push(`${u.id}: "${out}"`);
    }
  }
  ok(!lowerOpen.length, `every card opens on a capital or a number (${lowerOpen[0] ?? 'all 49'})`);
  ok(!verbed.length, `and none of them says "unlocks" (${verbed[0] ?? 'none do'})`);
}

// The rule reaches a sentence boundary too, and stops at anything that is not
// a letter — bounceShot's "{effect}" sits after a full stop, and rapidFire's
// opens on a "+" that must survive untouched.
ok(sentenceCase('all balls, no pit. a chaining ricochet shot')
   === 'All balls, no pit. A chaining ricochet shot', 'sentence case reaches past the first word');
ok(sentenceCase('+25% fire rate') === '+25% fire rate', '...and leaves a measured number alone');

// ===========================================================================
console.log('\n5. the wording table — statText.csv');
// ===========================================================================
// The words {effect} says now live in a spreadsheet rather than in a 60-entry
// object. That moved a whole class of mistake from "will not compile" to "will
// render wrong and ship", so the parser's guarantees are checked here.

{
  const parse = (csv) => {
    const warns = [];
    const out = parseStatTextCsv(csv, (m) => warns.push(m));
    return { out, warns };
  };
  const head = 'id,kind,label,plural,unlock,template,unit,lower,bare,percentOfOne';

  // The three flag columns invert the `enabled` convention: blank means NO.
  // Reading a blank as TRUE would silently flip fireRate's sign on every card.
  const blanks = parse(`${head}\nfoo,percent,foo,,,,,,,`).out.foo;
  ok(!blanks.lower && !blanks.bare && !blanks.percentOfOne,
     'a blank flag column means no, not yes');

  const flags = parse(`${head}\nfoo,percent,foo,,,,,TRUE,TRUE,TRUE`).out.foo;
  ok(flags.lower && flags.bare && flags.percentOfOne, 'TRUE in a flag column means yes');

  // A row with no label is the one case that cannot be defaulted — the
  // fallback is the raw stat key, which is what this table exists to prevent.
  const nolabel = parse(`${head}\nfoo,percent,,,,,,,,`);
  ok(!nolabel.out.foo && nolabel.warns.some((w) => /no label/.test(w)),
     'a row with no label is dropped, with a warning');

  const badkind = parse(`${head}\nfoo,sideways,foo,,,,,,,`);
  ok(badkind.out.foo.kind === 'flat' && badkind.warns.some((w) => /sideways/.test(w)),
     'an unrecognised kind falls back to flat and says so');

  // Every kind the editor offers must be one phrase() can actually render.
  ok(KINDS.every((k) => ['percent', 'flat', 'count', 'level'].includes(k)),
     `the kinds the parser accepts are the four phrase() implements (${KINDS.join(', ')})`);
}

// The `template` column: an override may restate the measured number in any
// wording, but it must never be able to invent one.
{
  const change = { stat: 'fireRate', how: 'mul', ratio: 0.75, from: 1, to: 0.75 };
  const withTpl = (tpl) => {
    const saved = STAT_TEXT.fireRate;
    STAT_TEXT.fireRate = { ...saved, template: tpl };
    try { return phrase(change); } finally { STAT_TEXT.fireRate = saved; }
  };

  ok(withTpl('{label} up {n%}') === 'fire rate up +25%',
     `a template rewrites the phrase and keeps the measurement ("${withTpl('{label} up {n%}')}")`);
  ok(withTpl('') === phrase(change), 'a blank template falls through to the standard shape');
  // A template of only unknown tokens renders to nothing, and a card with a
  // hole in it is worse than a card with the old wording.
  ok(withTpl('{nope}') === '{nope}' || withTpl('   ') === phrase(change),
     'a template that renders empty falls back rather than blanking the card');
  ok(/25/.test(withTpl('{label} up {n%}')),
     'the number in an overridden phrase is still the measured one');
}

// ===========================================================================
console.log('\n6. the sfx column');
// ===========================================================================

const sfxKeys = Object.keys(CONFIG.sfx ?? {});
ok(sfxKeys.length > 0, `CONFIG.sfx has ${sfxKeys.length} sound keys for the picker`);

// Whatever the file happens to say today, the column has to WORK — so drive
// applyUpgradeTable with a synthetic table rather than only reading the rows
// that exist. Every column in this file was blank on the day it was added.
{
  const good = sfxKeys[0];
  const table = new Map([
    ['rapidFire', { id: 'rapidFire', sfx: good }],
    ['vitality', { id: 'vitality', sfx: 'nosuchsound' }],
    ['multishot', { id: 'multishot', sfx: '' }],
  ]);
  const copies = CONFIG.upgrades.map((u) => ({ ...u }));
  const base = new Map(copies.map((u) => [u.id, { name: u.name, desc: u.desc, maxStacks: u.maxStacks, enabled: u.enabled, weight: undefined, cardArt: null, sfx: null }]));
  const warnings = [];
  applyUpgradeTable(copies, base, table, LEVELUP_IMAGE_KEYS, (m) => warnings.push(m), sfxKeys);

  const at = (id) => copies.find((u) => u.id === id);
  ok(at('rapidFire').sfx === good, `a valid key lands on the upgrade (rapidFire.sfx = ${at('rapidFire').sfx})`);
  ok(at('vitality').sfx === null, `an unknown key falls back to the shared level-up sound, not to silence`);
  ok(warnings.some((w) => w.includes('nosuchsound')), 'and it warns, so a typo is visible rather than mysterious');
  ok(at('multishot').sfx === null, 'a blank cell means the shared sound');
  ok(at('projectileLife').sfx === null, 'an upgrade with no row keeps the built-in null');
}

const withSfx = [...rows].filter(([, row]) => String(row.sfx ?? '').trim());
for (const [id, row] of withSfx) {
  const key = String(row.sfx).trim();
  ok(sfxKeys.includes(key), `${id} asks for sound "${key}"${sfxKeys.includes(key) ? '' : ' — not a key in CONFIG.sfx'}`);
}
if (!withSfx.length) console.log('        (no upgrade names its own sound yet — all use the shared level-up)');

console.log(failed ? `\n${failed} FAILED\n` : '\nall good\n');
process.exit(failed ? 1 : 0);
