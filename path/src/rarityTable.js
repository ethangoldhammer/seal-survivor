// ============================================================================
// RARITY TABLE — the whole of every rarity tier, kept in rarities.csv.
//
// Unlike upgrades.csv, which is the editable HALF of an upgrade (the other
// half being its apply(), which can't live in a spreadsheet), a rarity has no
// code half. A tier is entirely data: a name, a colour, how hard it glows, how
// much it multiplies by, how often it comes up early and late in a run, and
// which sound announces it. So the CSV is the whole definition and config.js
// carries only the fallbacks that keep the game running if the file is empty.
//
// THE ORDER OF THE ROWS IS THE ORDER OF THE TIERS. Row 1 is the floor and the
// last row is the top; nothing else establishes rank, so moving a row moves the
// tier. That's deliberate — a separate `rank` column would be a second source
// of truth for something the file already says by its shape, and the two would
// eventually disagree.
//
// Columns (order doesn't matter, unknown columns are ignored):
//   id           the join key. Referenced by saved picks, so RENAMING AN ID
//                is not the same as renaming a tier — change `name` for that.
//   name         what the card and the tuner call it. This is the column to
//                edit to get away from Common/Uncommon/Rare/Epic/Legendary.
//   color        the ring and glow colour. `#rrggbb`, or a bare hex.
//   glow         how far the card blooms, 0..~2. 0 is a ring and no glow,
//                which is what the floor tier should look like — see below.
//   statMul      how much this tier amplifies the upgrade. 1 is "no change",
//                and the floor tier must be 1 or every card in the game is
//                secretly buffed. See systems/rarity.js for what gets
//                amplified and what deliberately doesn't.
//   weightEarly  how often this tier is rolled at the START of a run...
//   weightLate   ...and at full difficulty. The roll interpolates between the
//                two, so the ramp from "grey cards with the odd green" to "a
//                real chance at the top tier" is these two columns and nothing
//                else. Relative within their own column, like upgrade weights.
//   sfx          a key from CONFIG.sfx, played when a card of this tier is
//                OFFERED — one sting per level-up, for the best tier on the
//                table (see ui.js). Blank means that tier arrives silently,
//                which is the right answer for the floor tier and the wrong
//                answer for every other one.
//
// WHY THE FLOOR TIER SHOULD STAY PLAIN. Every level-up deals three cards, and
// most of them will be the floor tier for most of a run. If that tier has a
// colour, a glow and a sound, then "this card is ordinary" is announced three
// times per level with the same emphasis as a top-tier drop, and the whole
// system stops carrying information. A grey ring, no bloom and no sting is
// what makes the green one mean something.
// ============================================================================

import { parseIdTable, parseNumber } from './csvTable.js';

const LABEL = 'rarities';
const FILE = 'rarities.csv';

export function parseRarityCsv(text, warn = console.warn) {
  return parseIdTable(text, LABEL, FILE, warn);
}

// '#4aa8ff' or '4aa8ff' -> 0x4aa8ff. Returns null on anything unreadable, and
// the caller falls back to the built-in rather than to black — an unparseable
// colour that rendered as a black ring would look deliberate.
function parseColor(raw, id, warn) {
  const s = String(raw ?? '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) {
    if (s) warn(`[${LABEL}] "${id}" has colour "${raw}", which isn't a 6-digit hex — keeping the built-in colour.`);
    return null;
  }
  return parseInt(s, 16);
}

/**
 * Build the live tier list from the CSV, falling back to `base` per field.
 *
 * Returns a NEW array rather than mutating in place, which is the opposite of
 * applyUpgradeTable's contract and deliberate: an upgrade exists in config.js
 * and the CSV only decorates it, so the CSV must not be able to invent or
 * delete one. A rarity is the other way round — the file defines the whole
 * ladder, including how many rungs it has — so adding a row has to add a tier.
 *
 * `base` is only consulted for rows whose id it already knows, so a brand-new
 * tier gets sane defaults instead of inheriting some other tier's.
 */
export function buildRarities(rows, base = [], warn = console.warn) {
  const byId = new Map(base.map((r) => [r.id, r]));
  const out = [];

  for (const [id, row] of rows) {
    const b = byId.get(id) ?? {};
    const name = String(row.name ?? '').trim();
    const color = 'color' in row ? parseColor(row.color, id, warn) : null;

    out.push({
      id,
      name: name || b.name || id,
      color: color ?? b.color ?? 0xb8c2cc,
      glow: numberOr('glow', row, id, b.glow ?? 0, warn, { min: 0 }),
      statMul: numberOr('statMul', row, id, b.statMul ?? 1, warn, { min: 1 }),
      weightEarly: numberOr('weightEarly', row, id, b.weightEarly ?? 1, warn, { min: 0 }),
      weightLate: numberOr('weightLate', row, id, b.weightLate ?? 1, warn, { min: 0 }),
      sfx: 'sfx' in row ? (String(row.sfx ?? '').trim() || null) : (b.sfx ?? null),
    });
  }

  if (!out.length) {
    warn(`[${LABEL}] ${FILE} produced no tiers — falling back to the built-in ladder.`);
    return base.map((r) => ({ ...r }));
  }

  // The floor tier is what an ordinary card is, and an ordinary card must be
  // exactly what config.js says it is. A statMul above 1 on row one is a
  // global buff to all 38 upgrades wearing a rarity costume, and it would show
  // up as every number in the game being quietly wrong.
  if (out[0].statMul !== 1) {
    warn(`[${LABEL}] the first tier ("${out[0].id}") has statMul ${out[0].statMul}; the floor tier must be 1 or every card is silently buffed. Forcing it to 1.`);
    out[0].statMul = 1;
  }

  // Ranks must climb. A ladder whose third rung multiplies by less than its
  // second still deals cards and still colours them, so nothing breaks — it
  // just quietly stops meaning anything, which is worse than breaking.
  for (let i = 1; i < out.length; i++) {
    if (out[i].statMul < out[i - 1].statMul) {
      warn(`[${LABEL}] "${out[i].id}" (statMul ${out[i].statMul}) is weaker than "${out[i - 1].id}" (${out[i - 1].statMul}), but sits above it. Row order IS tier order — reorder the rows or fix the numbers.`);
    }
  }

  return out;
}

function numberOr(field, row, id, fallback, warn, opts) {
  if (!(field in row)) return fallback;
  const n = parseNumber(row[field], LABEL, id, field, warn, opts);
  return n == null ? fallback : n;
}

/**
 * Validate the sfx keys against CONFIG.sfx, once the table is built.
 *
 * Separate from buildRarities because CONFIG.sfx isn't assembled yet at the
 * point the table is built — same ordering problem upgrades.csv's sfx column
 * has, solved the same way rather than by moving the table build later.
 */
export function checkRaritySfx(rarities, sfxKeys, warn = console.warn) {
  if (!sfxKeys?.length) return;
  for (const r of rarities) {
    if (r.sfx && !sfxKeys.includes(r.sfx)) {
      warn(`[${LABEL}] "${r.id}" asks for sound "${r.sfx}", which isn't a key in CONFIG.sfx — that tier will be announced silently.`);
      r.sfx = null;
    }
  }
}
