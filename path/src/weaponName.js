// ============================================================================
// WHAT THE WEAPON IS CALLED, once the player has got their hands on it.
//
// "cause of death: Fin Pebbles" is true and slightly disappointing on a run
// where the pebbles have been cloned four times and are carrying an element.
// A boss that went down to that was not killed by the level-one gun, and the
// stamp on the polaroid is the one place in the game that says out loud what
// the run's build actually was.
//
// So: a weapon's name is its BASE name until an upgrade renames it, and after
// that it is whatever that upgrade says. "Cloned Pebbles". "Voltaic Pebbles".
// The names live in upgrades.csv, in the `weaponName` column, on the row of the
// upgrade that causes the change — which is the only place somebody adding a
// gun upgrade is already looking.
//
// THE MOST RECENTLY TAKEN ONE WINS, and that is the whole tie-break. A player
// holding Cloned, Giant and Voltaic could reasonably be told any of the three,
// and every other rule needs an authored priority that would be invisible in
// the spreadsheet and arbitrary in the file: "most stacks" ties constantly,
// "rarest" makes the name jump backwards when a common upgrade is taken late,
// and a `weaponRank` column is a number nobody would ever be confident about.
// Most recent is the one rule with nothing hidden in it, and it makes the name
// a record of the last decision the player made about that weapon — which is
// what a caption on a photograph should be.
//
// WHY THE JOIN IS WRITTEN OUT below rather than derived. playtestAnalysis.js
// already knows which upgrades PAY for which damage source, and that is a
// different question from which upgrades RENAME it: Glow Up! is its own damage
// source (the elemental packet is booked separately) while also being the thing
// that makes the pebbles voltaic. Deriving one list from the other would name
// the element's own damage and never the gun's.
//
// The cost of writing it out is drift — a row given a `weaponName` that no
// weapon claims does nothing at all, silently. `npm run test:weaponnames`
// asserts that every named row is claimed by exactly one weapon, and fails
// naming the ones that are not.
// ============================================================================

import { CONFIG } from './config.js';
import { player } from './entities/player.js';
import { activeElement, elementLabel } from './systems/elements.js';
import { sourceLabel } from './systems/playtestAnalysis.js';

/**
 * Which upgrades rename which weapon, by damage-source key.
 *
 * The key is the string that reaches playtest.recordDamage — 'gun', 'club',
 * 'missile' — because that is what a kill is credited to and therefore what
 * arrives here. Only the gun has names written for it so far; the rest of the
 * kit is a row away whenever somebody wants it.
 */
export const WEAPON_MODIFIERS = {
  gun: [
    'rapidFire', 'heavyRounds', 'multishot', 'pierce', 'velocity',
    // Not a gun upgrade in the ledger — it books its own damage under
    // 'bioluminescence' — but it is unarguably a thing that happens to the
    // pebbles, and it is the rename a player would most want to see.
    'bioluminescence',
  ],
};

/**
 * The upgrade with this id, or null.
 *
 * CONFIG.upgrades is an ARRAY and not a map — every other reader does the same
 * `.find`, and doing it here rather than indexing is the difference between a
 * name and `undefined`. Worth stating because indexing an array by a string id
 * fails silently in exactly the direction that leaves the base name in place,
 * which looks identical to "this weapon has not been modified".
 */
function upgradeById(id, upgrades = CONFIG.upgrades ?? []) {
  return upgrades.find?.((u) => u?.id === id) ?? null;
}

/**
 * The tokens a `weaponName` may contain, expanded — or NULL if any of them had
 * nothing to expand to.
 *
 * `{element}` is what makes a single row cover four names: Glow Up! rolls one
 * of four elements per run and the pebbles should be called after whichever it
 * was. It expands to the element's own authored label (CONFIG.biolum.elements
 * .<id>.label — 'Voltaic', 'Venom', 'Chill', 'Infected'), so renaming an
 * element renames the weapon with it rather than leaving two spellings of the
 * same idea in two files.
 *
 * NULL AND NOT THE LEFTOVERS, which is the whole reason this returns something
 * other than a string. Dropping an unfilled token and trimming leaves
 * "{element} Pebbles" as the perfectly plausible "Pebbles" — a name that reads
 * like a deliberate choice, on a card, forever. A row that depends on a token
 * it cannot fill has nothing to say, and the caller moves on to the next
 * modifier.
 */
function expandTokens(name) {
  if (!name.includes('{')) return name;
  let missing = false;
  const out = name.replace(/\{element\}/g, () => {
    const label = elementLabel(activeElement());
    if (!label) missing = true;
    return label ?? '';
  }).trim();
  return missing || !out ? null : out;
}

/**
 * What to call the weapon behind `source`, given the run as it stands.
 *
 * Falls back to the ledger's own label — 'Fin Pebbles' — whenever nothing has
 * renamed it, which is every weapon with no rows written and every run before
 * the first modifying pick. NEVER EMPTY for a source the ledger knows: a blank
 * name on the card reads as a failed write rather than as a plain weapon.
 *
 * @param source a damage-source key, e.g. 'gun'.
 * @param picks  the upgrades held, oldest first. Defaults to the live player's;
 *               passed explicitly by the tests, which have no run.
 */
export function weaponName(source, picks = player?.upgrades ?? []) {
  const base = sourceLabel(source);
  const modifiers = WEAPON_MODIFIERS[source];
  if (!modifiers?.length || !picks?.length) return base;

  // Backwards through the picks, so the FIRST hit is the most recent one.
  for (let i = picks.length - 1; i >= 0; i--) {
    const id = picks[i]?.id;
    if (!id || !modifiers.includes(id)) continue;
    const written = String(upgradeById(id)?.weaponName ?? '').trim();
    if (!written) continue;
    // A row whose token could not be filled — Glow Up! held with no element
    // rolled, which cannot happen in a run but can in a harness and is one bad
    // merge away — falls through to the next-most-recent modifier rather than
    // captioning the print with the leftovers. See expandTokens.
    const named = expandTokens(written);
    if (named) return named;
  }
  return base;
}

/**
 * Every upgrade id that carries a `weaponName`, and which weapon claims it.
 *
 * The drift check, exported rather than left in the test so the same answer is
 * available from a console at 2am. A row in the first list and not the second
 * is a name that can never appear.
 */
export function weaponNameAudit(upgrades = CONFIG.upgrades ?? []) {
  const named = (upgrades ?? []).filter((u) => u?.weaponName).map((u) => u.id);
  const claimed = new Map();
  for (const [source, ids] of Object.entries(WEAPON_MODIFIERS)) {
    for (const id of ids) {
      if (!claimed.has(id)) claimed.set(id, []);
      claimed.get(id).push(source);
    }
  }
  return {
    named,
    // Named, and no weapon lists it — the name is dead.
    unclaimed: named.filter((id) => !claimed.has(id)),
    // Listed by a weapon, and has no name — harmless, but usually a row
    // somebody meant to fill in.
    unnamed: [...claimed.keys()].filter((id) => !upgradeById(id, upgrades)?.weaponName),
    // Listed by two weapons: one pick would rename both, which is almost
    // certainly a copy-paste rather than an intention.
    shared: [...claimed.entries()].filter(([, s]) => s.length > 1).map(([id]) => id),
  };
}
