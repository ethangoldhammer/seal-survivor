// ============================================================================
// QUIP TABLE — the headline on the game-over screen, kept in quips.csv.
//
// This was the fixed string "Run ended", which is accurate and says nothing.
// Dying is the most-repeated moment in the game, so it is the line the player
// reads more often than any other — and the one place a bit of voice is worth
// the most. A table means adding one is a row, not a code change.
//
// Unlike upgrades.csv and enemies.csv the `id` here joins to nothing in code:
// it is only a handle for diffs and warnings, so a quip can be reworded
// without the row losing its identity in a pull request. That is also why a
// row with an unknown id is NOT a warning here the way it is there — every id
// is unknown, by design. `causes` is the one column that does join, to
// deathCauses.js, and it warns like the others when it misses.
//
// Columns (order doesn't matter, unknown columns are ignored):
//   id       a short handle for the row. Must be unique; never shown.
//   text     the headline itself. This is the whole point of the row.
//   enabled  FALSE takes it out of rotation. Blank means enabled.
//   weight   how likely this line is RELATIVE TO THE OTHER ROWS. Blank means
//            1; 0 is never shown. Same rule as upgrades.csv, so "You Died!"
//            can be made the common case with the punchier lines kept rare —
//            a joke you see every third death stops being one.
//   causes   what has to have killed you for this line to fire, as one or more
//            ids from deathCauses.js. BLANK MEANS ANY DEATH, which is why
//            every row that shipped before this column existed still works.
//
// HOW `causes` PICKS, because the rule is a design decision and not an
// obvious one: a line written for a cause BEATS the general pool rather than
// competing with it. Die to a crab and the draw happens among the crab lines
// only; the general lines are what you get when nothing was written for how
// you died. The alternative — throwing the crab line in with the other eight
// and letting the weights sort it out — means "Crab Food." shows up one death
// in nine and mostly when a shark ate you, which is not a joke landing, it is
// a joke misfiring. Variety inside a cause comes from writing a second line
// for it, which is one row.
// ============================================================================

import { parseIdTable, parseBool, parseNumber } from './csvTable.js';
import { DEATH_CAUSE_IDS } from './deathCauses.js';

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
    out.push({ id, text: quipText, weight: w == null ? 1 : w, causes: parseCauses(row.causes, id, warn) });
  }

  if (!out.length) {
    warn(`[${LABEL}] ${FILE} produced no usable lines — falling back to "${FALLBACK_QUIP}".`);
  }
  return out;
}

// A `causes` cell into a list of cause ids. Space OR comma, the same rule the
// `bosses` column follows and for the same reason: the value comes out of a
// spreadsheet, where a comma has to be quoted, and a hand-edit that forgets
// the quotes would otherwise produce one cause named "shark,crab" that matches
// nothing at all.
//
// An id no cause answers to is dropped WITH A WARNING rather than kept. Kept,
// it would be a line that can never fire — invisible from the file, and
// indistinguishable from a line nobody happens to have rolled yet.
function parseCauses(raw, id, warn) {
  const s = String(raw ?? '').trim();
  if (!s) return null; // null, not [] — "any death", which is not "no death"
  const ids = s.split(/[\s,]+/).filter(Boolean);
  const known = ids.filter((c) => {
    if (DEATH_CAUSE_IDS.includes(c)) return true;
    warn(`[${LABEL}] "${id}" is tagged for cause "${c}", which is not a death cause — `
      + `that tag is being ignored. Known: ${DEATH_CAUSE_IDS.join(', ')}.`);
    return false;
  });
  return known.length ? known : null;
}

// Pick one line, weighted. `random` is injectable so the distribution can be
// checked without running the game; it is Math.random in the real build.
//
// `causes` is the Set from causesOfDeath() — what killed the player. Lines
// written for one of those causes are drawn from ALONE; if none were, the
// draw falls back to the lines that named no cause, which is what the table
// looked like before the column existed. Passing nothing (a test, the demo
// score screen) means every line is in play.
//
// A table whose every weight is 0 falls back to picking uniformly rather than
// showing nothing — same reasoning as drawUpgrades, and for the same reason:
// the file is misconfigured, and a blank headline is worse than a line that
// was asked not to appear.
export function pickQuip(quips, random = Math.random, causes = null) {
  if (!quips?.length) return FALLBACK_QUIP;
  quips = poolFor(quips, causes);

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

// The three-step narrowing, kept separate because every step is a fallback and
// the order they run in is the whole behaviour.
//
// Note the last line: a table of nothing but cause-specific lines, dying to a
// cause none of them names, still returns EVERY line rather than none. This
// module's one promise is that the score screen is never blank, and it outranks
// the tagging.
function poolFor(quips, causes) {
  // NO ARGUMENT and an EMPTY SET are different questions, and conflating them
  // is how a crab joke gets told about a death with no crab in it. Nothing
  // passed means "don't filter" — the demo score screen, a test, any caller
  // that isn't a death. An empty set is a real death whose source no cause
  // claimed, and that one belongs in the general pool.
  if (causes == null) return quips;
  const has = (c) => (causes.has ? causes.has(c) : causes.includes(c));
  const matched = quips.filter((q) => q.causes?.some(has));
  if (matched.length) return matched;
  const general = quips.filter((q) => !q.causes);
  return general.length ? general : quips;
}
