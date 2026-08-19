#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:weaponnames
//
// What the polaroid calls the weapon that killed the boss, once the run has
// modified it — "Cloned Pebbles" rather than "Fin Pebbles".
//
// Every failure here is silent, and three of them are the quiet kind that reads
// as a feature nobody bothered to finish:
//
//   A DEAD NAME        a `weaponName` written on a row that no weapon lists in
//                      WEAPON_MODIFIERS can never appear. The row looks filled
//                      in, the spreadsheet looks right, and the stamp says
//                      "Fin Pebbles" forever.
//   A DEAD TOKEN       `{element}` expands from CONFIG.biolum.elements.<id>
//                      .label. Rename an element in config.js and the token
//                      resolves to nothing, which would caption a print with a
//                      leading space and a noun.
//   THE WRONG TIE      a player holding three modifiers gets exactly one name,
//                      and "most recently taken" is the entire rule. A loop
//                      that happens to run forwards is right about half the
//                      time, which is the worst way for this to be wrong.
//   A BLANK STAMP      any path that returns '' captions the print with
//                      nothing at all, which reads as a broken write rather
//                      than as a plain weapon.
//
// Plain Node — weaponName.js reaches CONFIG and the player, so the JSON loader
// shim is needed, but no DOM is.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

await import('./vite-loader.mjs');

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const here = dirname(fileURLToPath(import.meta.url));
const { CONFIG } = await import('../path/src/config.js');
const { weaponName, weaponNameAudit, WEAPON_MODIFIERS } = await import('../path/src/weaponName.js');
const { sourceLabel } = await import('../path/src/systems/playtestAnalysis.js');
const elements = await import('../path/src/systems/elements.js');

const pick = (id) => ({ id, rarity: 'common' });

// ---------------------------------------------------------------------------
section('THE JOIN — every name a weapon can actually reach');
// ---------------------------------------------------------------------------
const audit = weaponNameAudit();
check('the shipped table names at least the gun', audit.named.length >= 2,
  `${audit.named.length} named: ${audit.named.join(', ')}`);
check('no name is written for an upgrade no weapon lists',
  audit.unclaimed.length === 0,
  audit.unclaimed.length ? `orphaned: ${audit.unclaimed.join(', ')}` : '');
check('no upgrade renames two different weapons',
  audit.shared.length === 0, audit.shared.join(', '));
// Not a failure — a modifier with no name written yet is a perfectly good
// state, and saying so out loud is the point.
if (audit.unnamed.length) {
  console.log(`  note  listed but unnamed, so they leave the base name alone: ${audit.unnamed.join(', ')}`);
}

// Every id in the join has to be a real upgrade, or it is a typo that silently
// never matches a pick.
// CONFIG.upgrades is an array, so this is a find and not an index — the same
// trap the resolver itself had to be corrected for.
const byId = (id) => CONFIG.upgrades.find((u) => u.id === id);
const unknown = Object.values(WEAPON_MODIFIERS).flat().filter((id) => !byId(id));
check('every modifier is a real upgrade id', unknown.length === 0, unknown.join(', '));

// ---------------------------------------------------------------------------
section('THE COLUMN — upgrades.csv reaches CONFIG');
// ---------------------------------------------------------------------------
// The column is new, and a column that is written but never parsed looks
// exactly like a column that is parsed and never used.
const csv = readFileSync(resolve(here, '../path/src/upgrades.csv'), 'utf8');
check('upgrades.csv carries the column', csv.split('\n')[0].includes('weaponName'),
  csv.split('\n')[0]);
check('...and it arrived on the upgrade', byId('multishot')?.weaponName === 'Cloned Pebbles',
  JSON.stringify(byId('multishot')?.weaponName));
check('...while a row that names nothing stays null',
  !byId('seaGarlic')?.weaponName,
  JSON.stringify(byId('seaGarlic')?.weaponName));

// ---------------------------------------------------------------------------
section('RESOLUTION — what the stamp says');
// ---------------------------------------------------------------------------
check('an unmodified gun is still the base name',
  weaponName('gun', []) === 'Fin Pebbles', weaponName('gun', []));
check('...as it is with picks that do not touch it',
  weaponName('gun', [pick('seaGarlic'), pick('club')]) === 'Fin Pebbles',
  weaponName('gun', [pick('seaGarlic'), pick('club')]));
check('one modifier renames it',
  weaponName('gun', [pick('multishot')]) === 'Cloned Pebbles',
  weaponName('gun', [pick('multishot')]));

// THE TIE-BREAK, in both directions. A loop that runs forwards passes the first
// of these and fails the second, and it is the same table either way round —
// which is why both are here rather than one.
const three = [pick('heavyRounds'), pick('multishot'), pick('rapidFire')];
check('the most recently taken modifier wins',
  weaponName('gun', three) === 'Rapid Pebbles', weaponName('gun', three));
check('...and it really is recency, not table order',
  weaponName('gun', [...three].reverse()) === 'Giant Pebbles',
  weaponName('gun', [...three].reverse()));
// Stacking the same upgrade again is a fresh pick, so it takes the name back.
check('taking a modifier again brings its name back',
  weaponName('gun', [...three, pick('multishot')]) === 'Cloned Pebbles',
  weaponName('gun', [...three, pick('multishot')]));
// A pick with no name must not blank the weapon — it is skipped, and an
// earlier modifier still holds the name.
check('a later un-naming pick does not erase the name',
  weaponName('gun', [pick('multishot'), pick('seaGarlic')]) === 'Cloned Pebbles',
  weaponName('gun', [pick('multishot'), pick('seaGarlic')]));

// ---------------------------------------------------------------------------
section('THE ELEMENT TOKEN');
// ---------------------------------------------------------------------------
const ids = Object.keys(CONFIG.biolum?.elements ?? {});
check('the run has elements to be named after', ids.length >= 2, ids.join(', '));

for (const id of ids) {
  elements.resetElements(null);
  elements.commitElement(id);
  const got = weaponName('gun', [pick('bioluminescence')]);
  const label = CONFIG.biolum.elements[id].label;
  check(`${id} names the pebbles after its own label`, got === `${label} Pebbles`, got);
}

// The token's source of truth is the element's label, so a rename in config.js
// has to carry through rather than leaving two spellings in two files.
elements.resetElements(null);
elements.commitElement(ids[0]);
check('the token reads the label rather than a second copy of it',
  weaponName('gun', [pick('bioluminescence')]).startsWith(CONFIG.biolum.elements[ids[0]].label),
  weaponName('gun', [pick('bioluminescence')]));

// GLOW UP! HELD WITH NO ELEMENT cannot happen in a run — the card commits one
// on the pick — but it is one bad merge away, and the failure it would produce
// is a print captioned " Pebbles".
elements.resetElements(null);
const noElement = weaponName('gun', [pick('multishot'), pick('bioluminescence')]);
check('an element that never rolled falls through instead of captioning a space',
  noElement === 'Cloned Pebbles', JSON.stringify(noElement));

// ---------------------------------------------------------------------------
section('NEVER BLANK');
// ---------------------------------------------------------------------------
// Whatever is thrown at it, the stamp is either a name or the ledger's own
// label — never '', and never the word "undefined".
const nonsense = ['gun', 'missile', 'club', 'strike', 'impact', 'splash', 'nope', ''];
const answers = nonsense.map((s) => weaponName(s, [pick('multishot'), pick('bioluminescence')]));
check('every source resolves to something printable',
  answers.every((a) => typeof a === 'string' && !/undefined/.test(a)),
  answers.join(' | '));
check('...and a weapon the ledger knows is never blank',
  nonsense.slice(0, 5).every((s, i) => answers[i].trim().length > 0),
  answers.slice(0, 5).join(' | '));
// A source nothing has ever heard of comes back as itself, which is what
// sourceLabel has always done — visible rather than hidden.
check('an unknown source is shown rather than swallowed',
  weaponName('nope', []) === sourceLabel('nope'), weaponName('nope', []));

console.log(failures ? `\n${failures} FAILED` : '\nPASS — all checks');
process.exit(failures ? 1 : 0);
