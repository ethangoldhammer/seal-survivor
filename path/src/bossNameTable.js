// ============================================================================
// BOSS NAME TABLE — what the giant shark is called, kept in bossNames.csv.
//
// A boss with a health bar and no name is a big enemy. The name is most of
// what makes it an event, and it is also the cheapest thing in the game to
// author: this table is PARTS, not names, so eight prefixes, eight roots and
// ten epithets are 640 sharks rather than 26 rows.
//
// Like quips.csv, this table joins to nothing in code — the `id` is only a
// handle for diffs and warnings, so a part can be reworded without the row
// losing its identity in a pull request.
//
// Columns (order doesn't matter, unknown columns are ignored):
//   id       a short handle for the row. Must be unique; never shown.
//   slot     which PART of the name this is. One of:
//              prefix   the front half of the name  — "Gore"
//              root     the back half of it         — "maw"
//              epithet  what follows the name       — "the Devourer"
//            A row with any other slot is ignored, loudly: a typo'd slot is
//            a part that silently never appears.
//   text     the part itself. Case is used EXACTLY as typed — prefixes are
//            capitalised, roots are not ("Gore" + "maw" = "Goremaw"), and an
//            epithet carries its own article ("the Devourer") because not
//            all of them want one ("Warden of the Deep").
//   enabled  FALSE takes the part out of rotation. Blank means enabled.
//   weight   how likely this part is RELATIVE TO THE OTHER ROWS IN ITS SLOT.
//            Blank means 1; 0 is never used. Weights do not cross slots —
//            a prefix competes only with other prefixes.
//   bosses   which BOSS ARCHETYPES this part fits, as a space- or
//            comma-separated list of ids from bosses.csv ("bossOrca", or
//            "bossShark bossOrca"). BLANK MEANS ALL, which is the answer that
//            makes an unedited table behave the way it always did: every part
//            was universal before this column existed, and a blank cell in a
//            fifty-row table is the normal state of it rather than an
//            omission. Fill it in to narrow a part — "Sharky" is not a name an
//            orca can carry, and "fluke" is not a word for a shark's tail.
//   perk     which BOSS PERK this part belongs to, an id from bossPerks.csv.
//            Blank is the GENERAL POOL — the parts any boss can be built from.
//            A row with a perk is vocabulary that only exists while that perk
//            is on the boss, and one of them is GUARANTEED to land: see
//            rollBossName. This is the whole reason perks drive names — the
//            electric boss is called something electric, every time, and that
//            is the only warning the player gets.
//
// Epithets are optional in a way the other two slots are not: with no epithet
// rows at all, a boss is simply "Goremaw", which is a name. With no prefixes
// or no roots there is nothing to build from, and the fallback below is used.
// ============================================================================

import { parseIdTable, parseBool, parseNumber } from './csvTable.js';

const LABEL = 'bossNames';
const FILE = 'bossNames.csv';

export const SLOTS = ['prefix', 'root', 'epithet'];

// The one thing this module must never do is return nothing. A nameless boss
// is a visibly broken health bar, and it would be caused by a file the player
// can edit — so every failure path below ends at this name instead.
export const FALLBACK_BOSS_NAME = 'The Old Shadow';

// A `bosses` cell into a list of ids. Space OR comma, for the same reason
// `spawnGroup` accepts both: the value comes out of a spreadsheet cell, where
// a comma has to be quoted, and a hand-edit that forgets the quotes would
// otherwise silently produce one archetype id named "bossShark,bossOrca" that
// matches nothing at all.
function parseBossList(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null; // null, not [] — "any boss", which is not "no boss"
  const ids = s.split(/[\s,]+/).filter(Boolean);
  return ids.length ? ids : null;
}

/**
 * Parse the table into { prefix: [...], root: [...], epithet: [...] }.
 * Every slot is always present, possibly empty.
 *
 * `known` is optional: pass { bosses, perks } (arrays of legal ids) and every
 * `bosses`/`perk` cell is checked against them. `known.exclusive` (ids whose
 * `ownNames` is set) additionally checks that each of those archetypes has
 * written vocabulary in every slot — an exclusive archetype missing a slot
 * silently borrows the shared pool for it, which is precisely the thing it was
 * marked exclusive to avoid. Worth doing, because both
 * columns fail SILENTLY when wrong — a part tagged for a boss archetype that
 * no longer exists is simply a part that never appears again, and nothing
 * about the game looks broken while it happens.
 */
export function parseBossNameCsv(text, warn = console.warn, known = null) {
  const rows = parseIdTable(text, LABEL, FILE, warn);
  const out = {};
  for (const slot of SLOTS) out[slot] = [];

  for (const [id, row] of rows) {
    const slot = String(row.slot ?? '').trim().toLowerCase();
    if (!SLOTS.includes(slot)) {
      warn(`[${LABEL}] "${id}" has slot "${row.slot ?? ''}", which is not one of ${SLOTS.join(', ')} — the row is being ignored.`);
      continue;
    }
    // Not trimmed to nothing and not trimmed at the edges either: the space
    // between the name and its epithet is added when the name is assembled,
    // so a row with a trailing space would double it.
    const partText = String(row.text ?? '').trim();
    if (!partText) {
      warn(`[${LABEL}] "${id}" has no text — the row is being ignored.`);
      continue;
    }
    if (!parseBool(row.enabled, LABEL, id, 'enabled', warn)) continue;

    const w = parseNumber(row.weight, LABEL, id, 'weight', warn, { min: 0 });

    const bosses = parseBossList(row.bosses);
    if (bosses && known?.bosses) {
      for (const b of bosses) {
        if (!known.bosses.includes(b)) {
          warn(`[${LABEL}] "${id}" is tagged for boss "${b}", which is not in bosses.csv — `
            + `the part will never appear. Known: ${known.bosses.join(', ')}.`);
        }
      }
    }

    const perk = String(row.perk ?? '').trim() || null;
    if (perk && known?.perks && !known.perks.includes(perk)) {
      warn(`[${LABEL}] "${id}" is tagged for perk "${perk}", which is not in bossPerks.csv — `
        + `the part will never appear. Known: ${known.perks.join(', ')}.`);
    }

    out[slot].push({ id, text: partText, weight: w == null ? 1 : w, bosses, perk });
  }

  // The GENERAL pool is what a boss is built from — perk vocabulary is extra,
  // and a table that was all perk rows would have nothing to hang them on. So
  // the check below counts only parts with no perk, which is what makes the
  // warning fire on the file that is actually broken.
  const general = (slot) => out[slot].filter((p) => !p.perk).length;
  if (!general('prefix') || !general('root')) {
    warn(`[${LABEL}] ${FILE} has no usable general (perk-less) ${!general('prefix') ? 'prefix' : 'root'} rows — `
      + `every boss will be called "${FALLBACK_BOSS_NAME}".`);
  }

  // Every archetype that asked for its own vocabulary, checked slot by slot.
  // Reported per missing slot rather than per archetype: "the boat has no
  // roots" is a thing to go and write, while "the boat is misconfigured" is a
  // thing to go and investigate.
  for (const id of known?.exclusive ?? []) {
    for (const slot of SLOTS) {
      const mine = out[slot].filter((p) => !p.perk && p.bosses?.includes(id));
      if (mine.length) continue;
      warn(`[${LABEL}] "${id}" is marked ownNames in bosses.csv but has no ${slot} rows of its own — `
        + `it will borrow the shared pool for that slot, which is what ownNames exists to prevent.`);
    }
  }
  return out;
}

// One part from one slot, weighted. Same contract as pickQuip: a slot whose
// every weight is 0 picks uniformly rather than returning nothing, because
// the file is misconfigured and no name is worse than an unwanted one.
function pickPart(parts, random) {
  if (!parts?.length) return null;

  let total = 0;
  for (const p of parts) total += p.weight > 0 ? p.weight : 0;
  if (total <= 0) return parts[Math.floor(random() * parts.length)];

  let roll = random() * total;
  let last = parts[0];
  for (const p of parts) {
    if (p.weight <= 0) continue; // skipped, not merely worth nothing
    last = p;
    roll -= p.weight;
    if (roll <= 0) return p;
  }
  return last; // float drift ate the total
}

// "Grimtide the Tidebreaker" reads as a bug rather than as a name, and with
// parts drawn independently it comes up about as often as any other pairing.
// One reroll, not a loop: this is a nudge away from the obvious echo, not a
// guarantee, and a table where every epithet echoes every root must still
// terminate.
function echoes(root, epithet) {
  return epithet.toLowerCase().includes(root.toLowerCase());
}

// Everything in a slot this boss is allowed to wear. `perk` null asks for the
// general pool; a perk id asks for that perk's vocabulary and nothing else.
//
// `exclusive` is the archetype's `ownNames` column (see bosses.csv). Off, the
// boss wears its own tagged parts PLUS everything untagged, which is what makes
// the shark and the orca share most of a vocabulary and read as the same kind
// of thing. On, it wears only what names it.
//
// THE FLAG IS ON THE ARCHETYPE AND NOT ON THE ROWS, and that is the whole
// design. The alternative — tagging all seventy shared parts with "not the
// boat" — is the same fact written seventy times, and it fails open: the next
// generic prefix somebody adds is one nobody remembered to exclude, so the boat
// quietly starts rolling "Chompy" again months later. This way exclusivity is
// one cell, and a new shared part can never leak into an exclusive archetype.
function poolFor(parts, slot, boss, perk, exclusive = false) {
  const rows = parts?.[slot];
  if (!rows?.length) return [];
  const mine = rows.filter((p) => {
    if ((p.perk ?? null) !== perk) return false;
    if (!p.bosses) return false;
    return boss != null && p.bosses.includes(boss);
  });
  if (exclusive && mine.length) return mine;
  // FALLING BACK RATHER THAN RETURNING NOTHING. An exclusive archetype with no
  // rows in a slot would otherwise roll an empty pool, and an empty prefix or
  // root is the fallback name — every boat in the game called "The Old Shadow".
  // A boat wearing one shared root is a wobble; a boat with no name at all is
  // the feature visibly broken, so the shared pool is what an unwritten slot
  // gets. parseBossNameCsv warns at boot when this is the case, naming the
  // archetype and the slot, so it is loud without being fatal.
  return rows.filter((p) => {
    if ((p.perk ?? null) !== perk) return false;
    // Blank `bosses` is every boss. A row that names archetypes only fits the
    // ones it names — and with no boss id supplied at all (the harness, or a
    // caller that predates the roster) a narrowed row is skipped rather than
    // matched, so a shark-only name can't turn up on something that isn't one.
    if (!p.bosses) return true;
    return boss != null && p.bosses.includes(boss);
  });
}

/**
 * Roll a boss name.
 *
 * `opts.boss` is the archetype id from bosses.csv and `opts.perk` the perk id
 * from bossPerks.csv, either of which may be null. `random` is injectable so
 * the distribution can be checked without running the game.
 *
 * THE PERK ALWAYS SHOWS. If the perk has vocabulary, exactly one slot is
 * handed over to it and the others roll normally — so an electric boss is
 * "Stormmaw the Everhungry" or "Goremaw the Live Wire", never "Goremaw". That
 * guarantee is the feature: the name is the telegraph, and a name that only
 * SOMETIMES carried the perk would be a telegraph the player learns not to
 * trust, which is worse than none.
 *
 * WHICH slot it takes is rolled, weighted by how much vocabulary the perk has
 * in each — a perk with four prefixes and two epithets front-loads more often,
 * which is what an author writing four prefixes was asking for.
 */
export function rollBossName(parts, opts = {}, random = Math.random) {
  // Called as rollBossName(parts, random) before the roster existed, and the
  // shape of the second argument is what tells the two apart. Not a nicety: a
  // function passed where an options object is expected would silently name
  // every boss with no perk and no archetype, which is exactly the bug this
  // whole file is trying not to have.
  if (typeof opts === 'function') { random = opts; opts = {}; }

  const boss = opts.boss ?? null;
  const perk = opts.perk ?? null;
  // The archetype's `ownNames`. Resolved by the caller, which is the only place
  // that has the roster row — see systems/boss.js.
  const exclusive = !!opts.exclusive;

  // Which slot, if any, the perk speaks for this time.
  let perkSlot = null;
  if (perk) {
    const weights = SLOTS.map((slot) => {
      let total = 0;
      for (const p of poolFor(parts, slot, boss, perk, exclusive)) total += p.weight > 0 ? p.weight : 1;
      return total;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    if (total > 0) {
      let roll = random() * total;
      for (let i = 0; i < SLOTS.length; i++) {
        if (weights[i] <= 0) continue;
        perkSlot = SLOTS[i];
        roll -= weights[i];
        if (roll <= 0) break;
      }
    }
  }

  const draw = (slot) => pickPart(
    poolFor(parts, slot, boss, slot === perkSlot ? perk : null, exclusive), random);

  const prefix = draw('prefix');
  const root = draw('root');
  if (!prefix || !root) return FALLBACK_BOSS_NAME;

  const name = `${prefix.text}${root.text}`;

  let epithet = draw('epithet');
  if (epithet && echoes(root.text, epithet.text)) {
    epithet = draw('epithet');
    // Dropped only when it is a GENERAL epithet. Dropping a perk's would trade
    // the echo for a boss whose name no longer says what it does, and the echo
    // is a cosmetic wobble while the missing telegraph is the feature failing.
    if (epithet && echoes(root.text, epithet.text) && perkSlot !== 'epithet') return name;
  }

  return epithet ? `${name} ${epithet.text}` : name;
}
