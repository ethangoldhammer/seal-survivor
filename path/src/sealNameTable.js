// ============================================================================
// SEAL NAME TABLE — what the DICE call the player, kept in sealNames.csv.
//
// The splash has a name field and a randomise button beside it. This is what
// the button spends. Same shape as bossNames.csv and for the same reason: the
// cheapest content in the game is a table of parts, and two dozen adjectives
// against two dozen nicknames is five hundred seals rather than fifty rows.
//
// IT IS A SUGGESTION, NOT AN IDENTITY. Everything rolled here lands in the
// text field the player is already typing in — they can edit it, clear it, or
// hit the button again. That is the whole design: a roll that is nearly right
// is a starting point, so the parts are chosen to be funny in combination
// rather than to be complete on their own.
//
// Columns (order doesn't matter, unknown columns are ignored):
//   id       a short handle for the row. Must be unique; never shown.
//   slot     which PART of the name this is. One of:
//              adjective  the front half — "Fat"
//              nickname   the back half  — "Tony"
//              full       a WHOLE name, written out — "Sir Flops-A-Lot"
//            A row with any other slot is ignored, loudly: a typo'd slot is a
//            part that silently never appears.
//
//            FULL IS THE WAY OUT OF THE MACHINE, exactly like bossNames.csv's
//            `nickname` slot. Parts are wonderful for volume and useless for a
//            joke — "Sir Flops-A-Lot" cannot be assembled from halves, and
//            neither can anything else that depends on being exactly the words
//            somebody chose. A full name replaces the adjective and the
//            nickname together.
//
//            It is a POOL, not an override: hand-written names compete with
//            the built one at `fullChance`, so writing one does not mean every
//            roll is now that name.
//   text     the part itself, used with EXACTLY the capitalisation typed here.
//            Both halves are capitalised — "Fat" + "Tony" — because the two
//            are set side by side with a space and either one can also be read
//            alone (see the length rule below).
//   enabled  FALSE takes the part out of rotation. Blank means enabled.
//   weight   how likely this part is RELATIVE TO THE OTHER ROWS IN ITS SLOT.
//            Blank means 1; 0 is never used. Weights do not cross slots.
//   notes    free text; nothing reads it.
//
// THE LENGTH RULE, and it is the one thing here that a boss name never had to
// care about. A boss name is drawn by the game onto a bar it owns. A seal name
// goes into a real <input> with `maxlength` set from MAX_NAME_LEN and then
// through the leaderboard's sanitiser — so a rolled name one character over
// would be cut in front of the player, which reads as the button being broken
// rather than as the name being long.
//
// So the pair is chosen to FIT: the nickname is drawn first, and only the
// adjectives that still fit beside it are drawn from. If none do, the nickname
// stands alone — every nickname is a usable name by itself, which is what
// makes that a graceful answer rather than a failure. A `full` row that cannot
// fit is refused at parse, loudly, because nothing can rescue it at roll time.
//
// SANITISED AT PARSE, through the same function the field uses. The characters
// the leaderboard strips (<>&"'\) would otherwise be rolled into the box and
// vanish on the next keystroke — so an apostrophe in "Lil' Chum" is removed
// here, with a warning naming the row, rather than being quietly eaten later.
// That is why no row in the shipped file has one.
// ============================================================================

import { parseIdTable, parseBool, parseNumber } from './csvTable.js';
// The field's own rules, from the module that owns the player's name. Imported
// rather than restated: MAX_NAME_LEN is already the server's limit mirrored
// once, and a second copy here would let this table start rolling names the
// board silently cuts. playerName.js imports nothing, so nothing cycles.
import { stripName, MAX_NAME_LEN, DEFAULT_PLAYER_NAME } from './systems/playerName.js';

const LABEL = 'sealNames';
const FILE = 'sealNames.csv';

/** The two slots a name is BUILT from, in the order they are written. */
export const SEAL_SLOTS = ['adjective', 'nickname'];

/** ...and every slot a row may legally declare. The parser reads this one. */
export const SEAL_NAME_SLOTS = [...SEAL_SLOTS, 'full'];

/**
 * How often a hand-written whole name wins over a built one, when the table
 * has any. Deliberately under half, same as the boss table's nicknames: the
 * written names are the seasoning, and a button that mostly returned them
 * would waste the vocabulary that makes the next press different from the last.
 */
export const DEFAULT_FULL_CHANCE = 0.25;

/**
 * What the button gives you when the table gives us nothing. The same word an
 * un-named player is already called, so a broken file produces a name the rest
 * of the game was going to use anyway rather than a blank field.
 */
export const FALLBACK_SEAL_NAME = DEFAULT_PLAYER_NAME;

/**
 * Parse the table into { adjective: [...], nickname: [...], full: [...] }.
 * Every slot is always present, possibly empty.
 */
export function parseSealNameCsv(text, warn = console.warn) {
  const rows = parseIdTable(text, LABEL, FILE, warn);
  const out = {};
  for (const slot of SEAL_NAME_SLOTS) out[slot] = [];

  for (const [id, row] of rows) {
    const slot = String(row.slot ?? '').trim().toLowerCase();
    if (!SEAL_NAME_SLOTS.includes(slot)) {
      warn(`[${LABEL}] "${id}" has slot "${row.slot ?? ''}", which is not one of ${SEAL_NAME_SLOTS.join(', ')} — the row is being ignored.`);
      continue;
    }

    const raw = String(row.text ?? '').trim();
    if (!raw) {
      warn(`[${LABEL}] "${id}" has no text — the row is being ignored.`);
      continue;
    }
    // The field's CHARACTER rule, applied here so what is rolled is exactly
    // what gets stored. `stripName` and not `sanitizeName`, because the latter
    // also cuts to length — and a row that is too long has to be refused with
    // a warning rather than quietly shortened into a name nobody wrote. Trimmed
    // after, because stripName deliberately keeps a trailing space (it is how
    // somebody is mid-word) and a part is not.
    const partText = stripName(raw).trim();
    if (!partText) {
      warn(`[${LABEL}] "${id}" is nothing but characters the name field strips — the row is being ignored.`);
      continue;
    }
    if (partText !== raw) {
      warn(`[${LABEL}] "${id}" was written "${raw}" and will be used as "${partText}" — `
        + 'the name field strips <>&"\'\\, so those characters cannot appear in a name.');
    }
    if (!parseBool(row.enabled, LABEL, id, 'enabled', warn)) continue;

    // A written name that cannot fit is refused HERE rather than at roll time,
    // where the only options would be showing a truncated name or silently
    // giving the player a different one. Built names have a way out (see
    // rollSealName); a `full` row has none, so it must be a file error.
    if (partText.length > MAX_NAME_LEN) {
      warn(`[${LABEL}] "${id}" is ${partText.length} characters and the name field holds ${MAX_NAME_LEN} — `
        + 'the row is being ignored, because a name the field would cut is worse than one part fewer.');
      continue;
    }

    const w = parseNumber(row.weight, LABEL, id, 'weight', warn, { min: 0 });
    out[slot].push({ id, text: partText, weight: w == null ? 1 : w });
  }

  // A nickname alone is a name; an adjective alone is not, which is why the
  // nickname pool is the one that has to exist. A file of nothing but `full`
  // rows is a legitimate way to run this — every roll is a name somebody wrote.
  if (!out.nickname.length && !out.full.length) {
    warn(`[${LABEL}] ${FILE} has no nickname rows and no full names — `
      + `every roll will return "${FALLBACK_SEAL_NAME}".`);
  }
  return out;
}

// One part from one pool, weighted. Same contract as pickQuip and pickPart in
// bossNameTable.js: a pool whose every weight is 0 picks uniformly rather than
// returning nothing, because the file is misconfigured and no name is worse
// than an unwanted one.
function pick(parts, random) {
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

/**
 * Roll a seal name.
 *
 * `opts.fullChance` is how often a hand-written whole name is preferred to a
 * built one. `opts.avoid` is a name not to hand back — pass what is already in
 * the field, because a randomise button that returns the name you are looking
 * at reads as a button that did nothing. `random` is injectable so the
 * distribution can be checked without running the game.
 *
 * ALWAYS RETURNS SOMETHING, and always something the field can hold: at most
 * MAX_NAME_LEN characters, and only characters the leaderboard keeps.
 */
export function rollSealName(parts, opts = {}, random = Math.random) {
  const avoid = String(opts.avoid ?? '').trim();
  const name = drawSealName(parts, opts, random);
  // ONE REROLL, not a loop. A table with one usable name in it must still
  // terminate, and the second draw is allowed to repeat — at that point the
  // player has been given everything the file has.
  if (avoid && name === avoid) return drawSealName(parts, opts, random);
  return name;
}

function drawSealName(parts, opts, random) {
  const chance = opts.fullChance ?? DEFAULT_FULL_CHANCE;
  const full = parts?.full ?? [];
  if (full.length && chance > 0 && random() < chance) {
    const written = pick(full, random);
    if (written) return written.text;
  }

  // THE NICKNAME FIRST, because it is the half that can stand alone and so the
  // half the length rule has to be measured against. Drawing the adjective
  // first would mean discovering that nothing fits beside it and having to
  // throw the draw away.
  const nick = pick(parts?.nickname ?? [], random);
  if (!nick) {
    // No nicknames at all — the written names are the only thing left, and are
    // reached here even when the roll above said no. A table of nothing but
    // `full` rows is a table where `fullChance` has nothing to choose against.
    const written = pick(full, random);
    return written ? written.text : FALLBACK_SEAL_NAME;
  }

  // Only the adjectives that still fit in the field beside this nickname. See
  // the length rule at the top of the file: the alternative is a name the
  // player watches get cut off as it arrives.
  const room = MAX_NAME_LEN - nick.text.length - 1; // -1 for the space
  const fits = room > 0 ? (parts?.adjective ?? []).filter((a) => a.text.length <= room) : [];
  const adj = pick(fits, random);
  return adj ? `${adj.text} ${nick.text}` : nick.text;
}
