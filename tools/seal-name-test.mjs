#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:sealnames
//
// THE DICE BUTTON ON THE SPLASH — sealNames.csv, and the one thing it has to
// do that the boss name table never did: FIT IN A REAL TEXT FIELD.
//
// A boss name is drawn by the game onto a bar the game owns, so it can be any
// length it likes. A seal name goes into an <input maxlength=24> and then
// through the leaderboard's sanitiser, which means every way of being too long
// or of containing the wrong character is a name the player watches get cut or
// eaten in front of them — a randomise button that visibly mangles its own
// answer reads as broken, not as generous.
//
// So the claims below are mostly about the edges:
//
//   THE PAIR FITS. The nickname is drawn first and only the adjectives that
//   still fit beside it are drawn from. A nickname long enough to leave no room
//   stands alone rather than being paired and cut.
//
//   A WRITTEN NAME THAT CANNOT FIT IS REFUSED AT PARSE, because nothing can
//   rescue it at roll time — there is no half of it to drop.
//
//   THE SANITISER RUNS AT PARSE. An apostrophe in the file would be rolled into
//   the field and vanish on the next keystroke; it is removed here, loudly.
//
//   NEVER BLANK. Every failure path ends at a name.
//
//   AVOID. Pressing the button must not hand back the name already on screen.
//
// The rules are driven on synthetic tables, so this does not start failing the
// day somebody writes a good name. The SHIPPED file is checked too, but only
// for the mechanical properties above — never for its contents.
//
//   node --import ./tools/vite-loader.mjs tools/seal-name-test.mjs
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseSealNameCsv, rollSealName, rollSealPart, splitSealName, joinSealName,
  SEAL_SLOTS, SEAL_NAME_SLOTS, FALLBACK_SEAL_NAME, DEFAULT_FULL_CHANCE,
} from '../path/src/sealNameTable.js';
import { sanitizeName, MAX_NAME_LEN } from '../path/src/systems/playerName.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const HEAD = 'id,slot,text,enabled,weight,notes';
const table = (...rows) => {
  const warns = [];
  const parts = parseSealNameCsv([HEAD, ...rows].join('\n'), (m) => warns.push(m));
  return { parts, warns };
};
// Enough rolls that a one-in-thirty branch cannot hide. Unseeded on purpose:
// every claim below is "always" or "never", so a flake here is a real bug.
const rollMany = (parts, opts = {}, n = 800) => {
  const out = new Set();
  for (let i = 0; i < n; i++) out.add(rollSealName(parts, opts, Math.random));
  return [...out];
};

const BASE = ['a1,adjective,Fat,,,', 'n1,nickname,Tony,,,'];

// ===========================================================================
section('THE SLOTS');
// ===========================================================================
check('SEAL_SLOTS is the two halves a name is BUILT from',
  SEAL_SLOTS.join(',') === 'adjective,nickname', SEAL_SLOTS.join(','));
check('...and SEAL_NAME_SLOTS adds the hand-written one',
  SEAL_NAME_SLOTS.includes('full') && SEAL_NAME_SLOTS.length === 3, SEAL_NAME_SLOTS.join(','));
{
  const { parts, warns } = table(...BASE, 'x1,adjectives,Salty,,,');
  check('a typo\'d slot is dropped, loudly',
    parts.adjective.length === 1 && warns.some((w) => w.includes('adjectives')));
  check('...and the good rows still build a name',
    rollSealName(parts, { fullChance: 0 }, Math.random) === 'Fat Tony');
}

// ===========================================================================
section('THE LENGTH RULE — the field holds ' + MAX_NAME_LEN);
// ===========================================================================
{
  // A nickname with room for a short adjective and not a long one. Every roll
  // must be one of exactly two answers, and neither may be truncated.
  const nick = 'Constantine';                      // 11
  const room = MAX_NAME_LEN - nick.length - 1;     // 12
  const long = 'X'.repeat(room + 1);               // one over
  const short = 'Fat';
  const { parts } = table(
    `n1,nickname,${nick},,,`,
    `a1,adjective,${short},,,`,
    `a2,adjective,${long},,,`,
  );
  const names = rollMany(parts, { fullChance: 0 });
  check('every rolled name fits the field',
    names.every((n) => n.length <= MAX_NAME_LEN), names.join(' / '));
  check('the adjective that fits is used', names.includes(`${short} ${nick}`));
  check('the one that does not is never drawn',
    !names.some((n) => n.includes(long)), names.join(' / '));
}
{
  // No adjective can fit beside this one at all. The nickname stands alone —
  // which is a name, and the reason nicknames carry the fallback rather than
  // adjectives doing.
  const nick = 'X'.repeat(MAX_NAME_LEN - 1);
  const { parts } = table(`n1,nickname,${nick},,,`, 'a1,adjective,Blubbery,,,');
  const names = rollMany(parts, { fullChance: 0 }, 60);
  check('a nickname with no room beside it stands alone',
    names.length === 1 && names[0] === nick, `${names.length} distinct`);
}
{
  // A written name has no half to drop, so it cannot be rescued at roll time.
  const tooLong = 'Y'.repeat(MAX_NAME_LEN + 1);
  const { parts, warns } = table(...BASE, `f1,full,${tooLong},,,`);
  check('an over-long full name is refused at parse',
    parts.full.length === 0 && warns.some((w) => w.includes('f1')),
    warns.join(' | ') || 'no warning');
  check('...so it can never be rolled',
    rollMany(parts, { fullChance: 1 }).every((n) => n === 'Fat Tony'));
}

// ===========================================================================
section('THE SANITISER RUNS AT PARSE');
// ===========================================================================
{
  const { parts, warns } = table('n1,nickname,Lil\' Chum,,,');
  check('a stripped character is removed at load',
    parts.nickname[0]?.text === 'Lil Chum', parts.nickname[0]?.text);
  check('...and the row is named in a warning',
    warns.some((w) => w.includes('n1')), warns.join(' | ') || 'no warning');
}
{
  // Nothing rolled may change when it goes through the field's own sanitiser —
  // that is the whole point of doing it here.
  const { parts } = table(...BASE, 'f1,full,The Wet Bandit,,,');
  const names = rollMany(parts, { fullChance: 0.5 });
  check('nothing rolled is changed by sanitizeName',
    names.every((n) => sanitizeName(n) === n), names.join(' / '));
}
{
  const { parts, warns } = table('n1,nickname,"""\'\'\'",,,', 'n2,nickname,Tony,,,');
  check('a row that is nothing BUT stripped characters is dropped',
    parts.nickname.length === 1 && warns.some((w) => w.includes('n1')),
    warns.join(' | ') || 'no warning');
}

// ===========================================================================
section('FULL NAMES — the way out of the machine');
// ===========================================================================
{
  const { parts } = table(...BASE, 'f1,full,Sir Flops-A-Lot,,,');
  check('at chance 1 the written name is all you get',
    rollMany(parts, { fullChance: 1 }).join('') === 'Sir Flops-A-Lot');
  check('at chance 0 it never appears',
    rollMany(parts, { fullChance: 0 }).every((n) => n === 'Fat Tony'));
  const mixed = rollMany(parts, {});
  check('at the default both are reachable',
    mixed.includes('Fat Tony') && mixed.includes('Sir Flops-A-Lot'),
    `${DEFAULT_FULL_CHANCE} -> ${mixed.join(' / ')}`);
}
{
  // A table of nothing but written names is a legitimate way to run this, and
  // must not depend on the chance roll to reach them.
  const { parts, warns } = table('f1,full,The Wet Bandit,,,');
  check('a file of only full names still rolls one at chance 0',
    rollMany(parts, { fullChance: 0 }).join('') === 'The Wet Bandit');
  check('...and is not reported as broken', !warns.length, warns.join(' | '));
}

// ===========================================================================
section('IT ALWAYS ANSWERS');
// ===========================================================================
{
  const { parts, warns } = table('a1,adjective,Fat,,,');
  check('adjectives alone are not a name — the file is reported',
    warns.some((w) => w.includes('no nickname rows')), warns.join(' | ') || 'no warning');
  check('...and the roll falls back rather than returning nothing',
    rollSealName(parts, {}, Math.random) === FALLBACK_SEAL_NAME);
  check('an empty table falls back too',
    rollSealName({}, {}, Math.random) === FALLBACK_SEAL_NAME);
  check('...and so does no table at all',
    rollSealName(null, {}, Math.random) === FALLBACK_SEAL_NAME);
}
{
  // Every weight 0 picks uniformly rather than showing nothing — the file is
  // misconfigured, and a blank field is worse than an unwanted name.
  const { parts } = table('n1,nickname,Tony,,0,', 'n2,nickname,Bruno,,0,');
  const names = rollMany(parts, { fullChance: 0 }, 200);
  check('a slot of nothing but 0 weights still answers',
    names.length === 2 && names.every((n) => n === 'Tony' || n === 'Bruno'), names.join(' / '));
}

// ===========================================================================
section('AVOID — a button that returns what is already there did nothing');
// ===========================================================================
{
  const { parts } = table('a1,adjective,Fat,,,', 'n1,nickname,Tony,,,', 'n2,nickname,Bruno,,,');
  let repeats = 0;
  for (let i = 0; i < 400; i++) {
    if (rollSealName(parts, { avoid: 'Fat Tony', fullChance: 0 }, Math.random) === 'Fat Tony') repeats++;
  }
  check('the name being avoided comes back far less often', repeats < 120, `${repeats}/400`);
}
{
  // ONE REROLL, NOT A LOOP. A table with exactly one name in it must still
  // terminate and still answer.
  const { parts } = table('n1,nickname,Tony,,,');
  check('a table with one name still answers when that name is avoided',
    rollSealName(parts, { avoid: 'Tony', fullChance: 0 }, Math.random) === 'Tony');
}

// ===========================================================================
section('THE SHIPPED FILE — mechanics only, never its contents');
// ===========================================================================
{
  const here = dirname(fileURLToPath(import.meta.url));
  const csv = readFileSync(resolve(here, '../path/src/sealNames.csv'), 'utf8');
  const warns = [];
  const parts = parseSealNameCsv(csv, (m) => warns.push(m));
  const counts = SEAL_NAME_SLOTS.map((s) => `${s} ${parts[s].length}`).join(', ');
  // TWO KINDS OF WARNING, and only one of them is a broken file.
  //
  // A stripped character is a NOTICE: the row still works, it just reads on
  // screen as the sanitiser leaves it — "Slipp'ry" is played as "Slippry". That
  // is worth saying out loud every run, and it is not worth failing a deploy
  // over somebody's spelling, which is what this did when it counted every
  // warning the same.
  //
  // Everything else — an unknown slot, a missing text cell, a name too long for
  // the field — is a row that is being DROPPED, and a table quietly losing rows
  // is exactly what a check in `npm test` is for.
  const notices = warns.filter((w) => w.includes('will be used as'));
  const faults = warns.filter((w) => !notices.includes(w));
  check('sealNames.csv parses with no rows dropped', !faults.length, faults.join(' | ') || counts);
  for (const n of notices) console.log(`  note ${n.replace(/^\[sealNames\] /, '')}`);
  check('it has both halves and something written', parts.adjective.length && parts.nickname.length && parts.full.length, counts);

  const names = rollMany(parts, {}, 4000);
  check('every name the shipped table can roll fits the field',
    names.every((n) => n.length <= MAX_NAME_LEN),
    names.filter((n) => n.length > MAX_NAME_LEN).join(' / ') || `${names.length} distinct, longest ${Math.max(...names.map((n) => n.length))}`);
  check('...survives the field\'s sanitiser unchanged',
    names.every((n) => sanitizeName(n) === n),
    names.filter((n) => sanitizeName(n) !== n).join(' / ') || 'all clean');
  check('...and is never blank', names.every((n) => n.trim().length > 0));
  // Not a content judgement — a floor on VARIETY. The button is pressed
  // several times in a row by anyone who presses it once, and a table that
  // could only answer a dozen ways would repeat itself immediately.
  check('the table can answer hundreds of ways', names.length > 200, `${names.length} distinct in 4000 rolls`);
}

// ===========================================================================
section('THE HALVES — what the splash reel spins one at a time');
{
  const long = 'X'.repeat(MAX_NAME_LEN - 4);            // leaves room for a 3-letter adjective
  const { parts } = table(
    'a1,adjective,Fat,,,', 'a2,adjective,The One and Only,,,', 'a3,adjective,The,,,',
    'n1,nickname,Tony,,,', 'n2,nickname,Osbourne,,,', `n3,nickname,${long},,,`,
    'f1,full,Flip Flop,,,',
  );
  const adjectives = new Set();
  const nicknames = new Set();
  for (let i = 0; i < 400; i++) {
    adjectives.add(rollSealPart(parts, 'adjective', {}, Math.random));
    nicknames.add(rollSealPart(parts, 'nickname', {}, Math.random));
  }
  check('an adjective comes from the adjective hat', [...adjectives].every((a) => ['Fat', 'The One and Only', 'The'].includes(a)), [...adjectives].join(' / '));
  check('a nickname comes from the nickname hat', [...nicknames].every((n) => ['Tony', 'Osbourne', long].includes(n)), [...nicknames].map((n) => n.slice(0, 8)).join(' / '));
  check('...and both hats are actually drawn from', adjectives.size === 3 && nicknames.size === 3, `${adjectives.size} / ${nicknames.size}`);
  const beside = new Set();
  for (let i = 0; i < 200; i++) beside.add(rollSealPart(parts, 'adjective', { beside: long }, Math.random));
  check('an adjective drawn beside a long nickname is one that fits', [...beside].every((a) => a === 'Fat' || a === 'The'), [...beside].join(' / '));
  check('...and nothing fits beside a nickname that fills the field', rollSealPart(parts, 'adjective', { beside: 'Y'.repeat(MAX_NAME_LEN) }) === '');
  check('an unknown slot is an empty half, not a throw', rollSealPart(parts, 'full') === '');

  check('a built name splits into its halves', JSON.stringify(splitSealName(parts, 'Fat Tony')) === '{"adjective":"Fat","nickname":"Tony"}');
  check('...longest adjective first', JSON.stringify(splitSealName(parts, 'The One and Only Osbourne')) === '{"adjective":"The One and Only","nickname":"Osbourne"}');
  check('a written whole name is all nickname', JSON.stringify(splitSealName(parts, 'Flip Flop')) === '{"adjective":"","nickname":"Flip Flop"}');
  check('a lineage is all nickname', JSON.stringify(splitSealName(parts, 'Fat Tony II')) === '{"adjective":"","nickname":"Fat Tony II"}');
  check('a name from somewhere else is all nickname', JSON.stringify(splitSealName(parts, 'Ethan')) === '{"adjective":"","nickname":"Ethan"}');
  check('a blank splits to nothing', JSON.stringify(splitSealName(parts, '')) === '{"adjective":"","nickname":""}');

  check('halves join with a space', joinSealName('Fat', 'Tony') === 'Fat Tony');
  check('no adjective is the nickname alone', joinSealName('', 'Tony') === 'Tony');
  check('a pair that will not fit is the nickname alone', joinSealName('The One and Only', long) === long);
  check('a join never exceeds the field', joinSealName('Fat', 'Z'.repeat(60)).length === MAX_NAME_LEN);
  for (let i = 0; i < 300; i++) {
    const name = rollSealName(parts, { fullChance: 0 }, Math.random);
    const h = splitSealName(parts, name);
    if (joinSealName(h.adjective, h.nickname) !== name) { check('every built name round-trips split → join', false, name); break; }
    if (i === 299) check('every built name round-trips split → join', true);
  }
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
