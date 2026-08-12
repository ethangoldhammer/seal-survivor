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

/**
 * Parse the table into { prefix: [...], root: [...], epithet: [...] }.
 * Every slot is always present, possibly empty.
 */
export function parseBossNameCsv(text, warn = console.warn) {
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
    out[slot].push({ id, text: partText, weight: w == null ? 1 : w });
  }

  if (!out.prefix.length || !out.root.length) {
    warn(`[${LABEL}] ${FILE} has no usable ${!out.prefix.length ? 'prefix' : 'root'} rows — `
      + `every boss will be called "${FALLBACK_BOSS_NAME}".`);
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

/**
 * Roll a boss name. `random` is injectable so the distribution can be checked
 * without running the game; it is Math.random in the real build.
 */
export function rollBossName(parts, random = Math.random) {
  const prefix = pickPart(parts?.prefix, random);
  const root = pickPart(parts?.root, random);
  if (!prefix || !root) return FALLBACK_BOSS_NAME;

  const name = `${prefix.text}${root.text}`;

  let epithet = pickPart(parts?.epithet, random);
  if (epithet && echoes(root.text, epithet.text)) {
    epithet = pickPart(parts.epithet, random);
    if (epithet && echoes(root.text, epithet.text)) return name;
  }

  return epithet ? `${name} ${epithet.text}` : name;
}
