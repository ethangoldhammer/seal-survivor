#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:bossnames
//
// NICKNAMES — the way out of the name machine.
//
// bossNames.csv is a table of PARTS, which is what makes 26 rows into 640
// sharks. It is also why "Ol' Chompy" was impossible to write: a name that
// depends on being exactly the words somebody chose cannot be assembled from
// halves. A `nickname` row is a whole name that replaces the prefix and the
// root together, and a `solo` row is one that replaces the epithet as well.
//
// Everything below is about the ways that could go wrong rather than about it
// working, because the working case is one line:
//
//   THE PERK GUARANTEE. A perk's name vocabulary is the only warning the player
//   gets about what the fight does, and a nickname REPLACES two of the three
//   slots that warning could have been in. So a nickname must never be able to
//   silence a perk — the roll picks which slot the perk speaks through first,
//   and the nickname decision obeys it.
//
//   SOLO. A solo name takes no epithet, ever. That is the whole point of the
//   slot, and it is also a second way to lose a perk telegraph, so a solo name
//   is refused when the epithet is the thing carrying it.
//
//   ONE POOL, TWO SLOTS. `nickname` and `solo` are rolled together — they are
//   two rows in the table and one kind of thing in the game. Anything that
//   reaches for the nickname pool and finds only one of them retires half the
//   hand-written names in the file without saying so.
//
//   NO REGRESSION. A table with no nicknames in it must roll exactly what it
//   rolled before any of this existed.
//
// Driven on synthetic tables rather than on the real bossNames.csv, on purpose:
// this is about the RULES, and a test that read the shipping file would start
// failing the day somebody wrote a good name.
//
//   node --import ./tools/vite-loader.mjs tools/boss-name-test.mjs
// ---------------------------------------------------------------------------

import {
  parseBossNameCsv, rollBossName, NAME_SLOTS, SLOTS, FALLBACK_BOSS_NAME,
} from '../path/src/bossNameTable.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const HEAD = 'id,slot,text,weight,enabled,bosses,perk,notes';
const table = (...rows) => {
  const warns = [];
  const parts = parseBossNameCsv([HEAD, ...rows].join('\n'), (m) => warns.push(m), null);
  return { parts, warns };
};
// Enough rolls that a one-in-twenty branch cannot hide. Unseeded on purpose:
// every claim below is "always" or "never", so a flake here is a real bug
// rather than an unlucky draw.
const rollMany = (parts, opts, n = 600) => {
  const out = new Set();
  for (let i = 0; i < n; i++) out.add(rollBossName(parts, opts, Math.random));
  return [...out];
};

const BASE = [
  'p1,prefix,Gore,,,,,',
  'r1,root,maw,,,,,',
  'e1,epithet,the Devourer,,,,,',
];

// ===========================================================================
section('THE SLOT LISTS ARE DIFFERENT ON PURPOSE');
// ===========================================================================
check('SLOTS is the three parts a name is BUILT from',
  SLOTS.join(',') === 'prefix,root,epithet', SLOTS.join(','));
check('...and NAME_SLOTS is what a row may declare',
  NAME_SLOTS.includes('nickname') && NAME_SLOTS.includes('solo'), NAME_SLOTS.join(','));
// The distinction is load-bearing: SLOTS is what an `ownNames` archetype is
// checked for completeness against, and demanding a hand-written nickname per
// exclusive archetype would warn about every well-formed table in existence.
check('...and neither hand-written slot is in the built-from list',
  !SLOTS.includes('nickname') && !SLOTS.includes('solo'));
{
  // ...and that is what keeps the `ownNames` completeness check honest. It
  // warns per slot when an exclusive archetype has none of its own, so a fifth
  // slot in the wrong list would demand a hand-written name from every boat in
  // the game. A console full of warnings about something genuinely optional is
  // how the real ones get ignored.
  const warns = [];
  parseBossNameCsv([HEAD,
    'b1,prefix,Rusty,,,bossBoat,,',
    'b2,root,hull,,,bossBoat,,',
    'b3,epithet,the Net Loss,,,bossBoat,,',
  ].join('\n'), (m) => warns.push(m), { exclusive: ['bossBoat'] });
  check('an exclusive archetype is never asked for a hand-written name',
    !warns.some((w) => w.includes('nickname') || w.includes('solo')),
    warns.join(' | ') || 'no warnings');
}

// ===========================================================================
section('A NICKNAME REPLACES THE PREFIX AND THE ROOT');
// ===========================================================================
{
  const { parts, warns } = table(...BASE, "n1,nickname,Ol' Chompy,,,,,");
  check('the row parses into its own pool', parts.nickname.length === 1,
    `${parts.nickname.length} nickname(s), ${warns.length} warning(s)`);

  const names = rollMany(parts, {});
  const nicked = names.filter((n) => n.startsWith("Ol' Chompy"));
  const built = names.filter((n) => n.startsWith('Goremaw'));
  check('both kinds of name turn up', nicked.length > 0 && built.length > 0,
    names.join(' / '));
  check('...and a nickname never keeps the prefix or root',
    !names.some((n) => n.includes("Ol' Chompy") && n.includes('maw')));
  check('...while an epithet may still follow it',
    nicked.some((n) => n.includes('the Devourer')), nicked.join(' / '));
}

// The dice, both ends of them. 0 is the switch that turns the feature off
// without anyone having to edit the table.
{
  const { parts } = table(...BASE, "n1,nickname,Ol' Chompy,,,,,");
  check('nicknameChance 0 never picks one',
    rollMany(parts, { nicknameChance: 0 }).every((n) => n.startsWith('Goremaw')));
  check('...and 1 always does',
    rollMany(parts, { nicknameChance: 1 }).every((n) => n.startsWith("Ol' Chompy")));
}

// ===========================================================================
section('SOLO IS A SLOT, NOT A FLAG');
// ===========================================================================
// It used to be a `solo` COLUMN: a boolean that meant something on nickname
// rows and nothing on the other three, kept honest by six lines of parsing and
// a runtime warning policing a cell four of the five slots had no use for. As a
// slot value that mistake cannot be written down at all. What follows is the
// behaviour that had to survive the move.
{
  const { parts, warns } = table(...BASE, 'n1,solo,Steve,,,,,');
  check('a solo row parses into its own pool',
    parts.solo.length === 1 && parts.solo[0].solo === true,
    `${parts.solo.length} solo row(s), ${warns.length} warning(s)`);
  const names = rollMany(parts, { nicknameChance: 1 });
  check('...and a solo name is the entire name', names.length === 1 && names[0] === 'Steve',
    names.join(' / '));
}
{
  // The other half of what the column used to say. A blank `solo` cell meant
  // "an epithet may still follow", and that is now simply what `nickname` is.
  const { parts } = table(...BASE, 'n1,nickname,Steve,,,,,');
  const names = rollMany(parts, { nicknameChance: 1 });
  check('a nickname row still lets an epithet follow',
    names.some((n) => n === 'Steve the Devourer'), names.join(' / '));
}
{
  // ONE POOL. The two slots are drawn together, so a table with one of each
  // must produce both — a roll that reached only for the `nickname` array would
  // silently retire every solo name in the file.
  const { parts } = table(...BASE, 'n1,nickname,Chompy,,,,,', 'n2,solo,Steve,,,,,');
  const names = rollMany(parts, { nicknameChance: 1 });
  check('nickname and solo are drawn from one pool',
    names.some((n) => n.startsWith('Chompy')) && names.includes('Steve'),
    names.join(' / '));
  check('...and neither leaves room for a built name',
    !names.some((n) => n.includes('Goremaw')), names.join(' / '));
}
{
  // The typo path — the only thing left to police once the flag can no longer
  // land on the wrong kind of row.
  const { parts, warns } = table(...BASE, 'oops,solos,Steve,,,,,');
  check('a typo\'d slot is refused loudly rather than ignored',
    warns.filter((w) => w.includes('solos')).length === 1 && !parts.solo.length,
    warns.join(' | '));
}

// ===========================================================================
section('THE PERK GUARANTEE SURVIVES');
// ===========================================================================
// The whole risk of this feature in one section: a nickname is two thirds of
// the name, so it is two thirds of the places a perk's telegraph could live.
{
  // Vocabulary in the nickname AND the epithet, so the roll has a real choice
  // to make and both branches get exercised.
  const { parts } = table(
    ...BASE,
    "n1,nickname,Ol' Chompy,,,,,",
    'n3,nickname,Sparky,,,,electric,',
    'e2,epithet,the Live Wire,,,,electric,',
  );
  const names = rollMany(parts, { perk: 'electric' });
  check('every electric boss says electric, however it was named',
    names.every((n) => n.includes('Sparky') || n.includes('the Live Wire')),
    names.join(' / '));
  check('...including through a perk-tagged nickname',
    names.some((n) => n.startsWith('Sparky')), names.join(' / '));
  check('...and a general nickname can still wear the perk epithet',
    names.some((n) => n.startsWith("Ol' Chompy") && n.includes('the Live Wire')));
}
{
  // The narrow case: the perk lives ONLY in the prefix. A nickname would take
  // that prefix away, so no nickname may be chosen at all.
  const { parts } = table(
    ...BASE,
    "n1,nickname,Ol' Chompy,,,,,",
    'p2,prefix,Storm,,,,electric,',
  );
  const names = rollMany(parts, { perk: 'electric', nicknameChance: 1 });
  check('a perk that lives only in the prefix forbids a nickname outright',
    names.every((n) => n.startsWith('Storm')), names.join(' / '));
}
{
  // ...and the other narrow case: the perk lives only in the epithet, so a
  // SOLO name would drop it. A nickname is still fine.
  const { parts } = table(
    ...BASE,
    'n1,solo,Steve,,,,,',
    "n2,nickname,Ol' Chompy,,,,,",
    'e2,epithet,the Live Wire,,,,electric,',
  );
  const names = rollMany(parts, { perk: 'electric', nicknameChance: 1 });
  check('a solo name is refused when the epithet carries the perk',
    !names.includes('Steve'), names.join(' / '));
  check('...and every name still says electric',
    names.every((n) => n.includes('the Live Wire')), names.join(' / '));
}
{
  // A perk-tagged SOLO name is still allowed to be the slot the perk speaks
  // through: the whole name is the telegraph, so there is nothing to drop.
  const { parts } = table(
    ...BASE,
    'n1,solo,Sparky,,,,electric,',
  );
  const names = rollMany(parts, { perk: 'electric', nicknameChance: 1 });
  check('a perk can speak through a solo name', names.includes('Sparky'), names.join(' / '));
  check('...and every electric name still says electric',
    names.every((n) => n.includes('Sparky')), names.join(' / '));
}

// ===========================================================================
section('THE EDGES');
// ===========================================================================
{
  // A table of nothing but hand-written names is a legitimate way to run this.
  const { parts, warns } = table('n1,nickname,Ol Chompy,,,,,');
  check('a nickname-only table names a boss', rollBossName(parts, {}, Math.random) === 'Ol Chompy');
  check('...and is not reported as a broken file',
    !warns.some((w) => w.includes(FALLBACK_BOSS_NAME)), warns.join(' | '));
}
{
  // ...and so is a table of nothing but solo ones, which the "is there anything
  // to fall back on" check has to count as well.
  const { parts, warns } = table('n1,solo,The Rusty Maiden,,,,,');
  check('a solo-only table names a boss',
    rollBossName(parts, {}, Math.random) === 'The Rusty Maiden');
  check('...and is not reported as a broken file either',
    !warns.some((w) => w.includes(FALLBACK_BOSS_NAME)), warns.join(' | '));
}
{
  const { parts, warns } = table('e1,epithet,the Devourer,,,,,');
  check('a table with nothing to build from AND no nicknames still warns',
    warns.some((w) => w.includes(FALLBACK_BOSS_NAME)));
  check('...and falls back rather than returning nothing',
    rollBossName(parts, {}, Math.random) === FALLBACK_BOSS_NAME);
}
{
  // NO REGRESSION. The shape of the answer for a table with no nicknames must
  // be exactly what it was before this existed.
  const { parts } = table(...BASE);
  const names = rollMany(parts, {});
  check('a table with no nicknames rolls what it always did',
    names.every((n) => n === 'Goremaw' || n === 'Goremaw the Devourer'),
    names.join(' / '));
}
{
  // `bosses` narrows a nickname like any other part.
  const { parts } = table(
    ...BASE,
    'n1,nickname,Sharky Steve,,,bossShark,,',
  );
  check('a nickname tagged for one archetype never lands on another',
    rollMany(parts, { boss: 'bossOrca', nicknameChance: 1 }).every((n) => n.startsWith('Goremaw')));
  check('...and does land on the one it names',
    rollMany(parts, { boss: 'bossShark', nicknameChance: 1 }).some((n) => n.startsWith('Sharky Steve')));
}
{
  // The union has to be narrowed as ONE pool. An exclusive archetype whose only
  // hand-written name is a solo one must wear it — narrowing the two slots
  // separately would find an empty solo pool for the general nickname's sake,
  // fall back to the shared rows, and put somebody else's name on the boat.
  const { parts } = table(
    ...BASE,
    'n1,nickname,Chompy,,,,,',
    'n2,solo,The Rusty Maiden,,,bossBoat,,',
  );
  const names = rollMany(parts, { boss: 'bossBoat', exclusive: true, nicknameChance: 1 });
  check('an exclusive archetype with only a solo name of its own wears it',
    names.length === 1 && names[0] === 'The Rusty Maiden', names.join(' / '));
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
