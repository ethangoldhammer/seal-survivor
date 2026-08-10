// ============================================================================
// QUIP TABLE — the headline on the game-over screen, kept in quips.csv.
//
// This was the fixed string "Run ended", which is accurate and says nothing.
// Dying is the most-repeated moment in the game, so it is the line the player
// reads more often than any other — and the one place a bit of voice is worth
// the most. A table means adding one is a row, not a code change.
//
// Unlike upgrades.csv and enemies.csv this table joins to nothing in code: the
// `id` is only a handle for diffs and warnings, so a quip can be reworded
// without the row losing its identity in a pull request. That is also why a
// row with an unknown id is NOT a warning here the way it is there — every id
// is unknown, by design.
//
// Columns (order doesn't matter, unknown columns are ignored):
//   id       a short handle for the row. Must be unique; never shown.
//   text     the headline itself. This is the whole point of the row.
//   enabled  FALSE takes it out of rotation. Blank means enabled.
//   weight   how likely this line is RELATIVE TO THE OTHER ROWS. Blank means
//            1; 0 is never shown. Same rule as upgrades.csv, so "You Died!"
//            can be made the common case with the punchier lines kept rare —
//            a joke you see every third death stops being one.
// ============================================================================

import { parseIdTable, parseBool, parseNumber } from './csvTable.js';

const LABEL = 'quips';
const FILE = 'quips.csv';

// The one thing this module must never do is return nothing: an empty headline
// is a visibly broken menu, and it would be caused by a file the player can
// edit. Every failure path below ends at this string instead.
export const FALLBACK_QUIP = 'You Died!';

export function parseQuipCsv(text, warn = console.warn) {
  const rows = parseIdTable(text, LABEL, FILE, warn);
  const out = [];

  for (const [id, row] of rows) {
    const quipText = String(row.text ?? '').trim();
    if (!quipText) {
      warn(`[${LABEL}] "${id}" has no text — the row is being ignored.`);
      continue;
    }
    if (!parseBool(row.enabled, LABEL, id, 'enabled', warn)) continue;

    const w = parseNumber(row.weight, LABEL, id, 'weight', warn, { min: 0 });
    out.push({ id, text: quipText, weight: w == null ? 1 : w });
  }

  if (!out.length) {
    warn(`[${LABEL}] ${FILE} produced no usable lines — falling back to "${FALLBACK_QUIP}".`);
  }
  return out;
}

// Pick one line, weighted. `random` is injectable so the distribution can be
// checked without running the game; it is Math.random in the real build.
//
// A table whose every weight is 0 falls back to picking uniformly rather than
// showing nothing — same reasoning as drawUpgrades, and for the same reason:
// the file is misconfigured, and a blank headline is worse than a line that
// was asked not to appear.
export function pickQuip(quips, random = Math.random) {
  if (!quips?.length) return FALLBACK_QUIP;

  let total = 0;
  for (const q of quips) total += q.weight > 0 ? q.weight : 0;
  if (total <= 0) return quips[Math.floor(random() * quips.length)].text;

  let roll = random() * total;
  let last = quips[0];
  for (const q of quips) {
    if (q.weight <= 0) continue; // skipped, not merely worth nothing — see drawUpgrades
    last = q;
    roll -= q.weight;
    if (roll <= 0) return q.text;
  }
  return last.text; // float drift ate the total
}
