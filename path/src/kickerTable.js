// ============================================================================
// KICKER TABLE — the label above the cause of death on the polaroid, kept in
// kickers.csv.
//
// "cause of death: Homing Missile". The kicker is the first half, the stamp is
// the second, and the whole point of a table is that the first half is not the
// same five words on every print a player ever takes. Same reasoning as
// quips.csv: this is a line the player reads on every boss kill of every run,
// which is the place a bit of voice is worth the most, and adding one should be
// a row rather than a code change.
//
// Columns (order doesn't matter, unknown columns are ignored):
//   id       a short handle for the row. Must be unique; never shown.
//   text     the label itself, WITHOUT its trailing space — see below.
//   enabled  FALSE takes it out of rotation. Blank means enabled.
//   weight   how likely this line is RELATIVE TO THE OTHER ROWS. Blank means
//            1; 0 is never shown. `cause of death:` ships at 3 against the
//            others' 1, because it is the straight reading and the jokes are
//            better for being the exception — a bit that lands one print in
//            five is a bit, and one that lands every print is the format.
//
// THE TRAILING SPACE IS NOT IN THE FILE, and that is a deliberate change from
// how this string used to work. The gap between the label and the value is the
// last character of the kicker — the artboard sets the two as separate runs
// side by side, so there is no padding between them but this. That worked as a
// constant in one file. It cannot work in a spreadsheet: a trailing space is
// invisible in every editor that would open this, most CSV writers strip it,
// and a row that lost one would print "cause of death:Homing Missile" with
// nothing anywhere saying why.
//
// So the file carries the words and `pickKicker` adds exactly one space. A row
// written WITH a space still comes out right, because the text is trimmed
// first — the invisible character cannot be wrong in either direction.
// ============================================================================

import { parseIdTable, parseBool, parseNumber } from './csvTable.js';
// The card's own default, from the file that describes the artboard. Imported
// rather than restated: two copies of a string whose last character is an
// invisible space is two copies that will eventually differ by it, and nothing
// would show which one a given print used. riveContract.js has no imports of
// its own, so nothing cycles.
import { SNAPSHOT_KICKER } from './ui/riveContract.js';

const LABEL = 'kickers';
const FILE = 'kickers.csv';

/**
 * What the card says when the table gives us nothing. Like FALLBACK_QUIP, this
 * module's one promise is that the print is never captioned with a blank —
 * this file is editable, and an empty label beside a weapon name reads as the
 * write having failed rather than as a row having been deleted.
 *
 * Carries its space, because it is a finished kicker rather than a row.
 */
export const FALLBACK_KICKER = SNAPSHOT_KICKER;

export function parseKickerCsv(text, warn = console.warn) {
  const rows = parseIdTable(text, LABEL, FILE, warn);
  const out = [];

  for (const [id, row] of rows) {
    const label = String(row.text ?? '').trim();
    if (!label) {
      warn(`[${LABEL}] "${id}" has no text — the row is being ignored.`);
      continue;
    }
    if (!parseBool(row.enabled, LABEL, id, 'enabled', warn)) continue;
    const w = parseNumber(row.weight, LABEL, id, 'weight', warn, { min: 0 });
    out.push({ id, text: label, weight: w == null ? 1 : w });
  }

  if (!out.length) {
    warn(`[${LABEL}] ${FILE} produced no usable lines — falling back to "${FALLBACK_KICKER}".`);
  }
  return out;
}

/**
 * Pick one, weighted, and hand it back READY TO WRITE — trimmed of whatever
 * the file had and given exactly one trailing space.
 *
 * `random` is injectable so the distribution can be checked without running the
 * game; it is Math.random in the real build.
 *
 * ROLLED ONCE PER PRINT, at the moment the frame is grabbed, and banked on the
 * shot beside the cause and the player's name (systems/bossShot.js). Rolling
 * it where the card is BUILT would re-roll every print in the fan every time
 * the score screen lays them out, so a print the player watched come out of the
 * camera saying "kill'd by:" would be captioned "defeated via:" thirty seconds
 * later on the same screen — which reads as the card being broken rather than
 * as the game having a sense of humour.
 *
 * A table whose every weight is 0 falls back to picking uniformly rather than
 * showing nothing — same rule as pickQuip and drawUpgrades, for the same
 * reason: the file is misconfigured, and a blank label is worse than a line
 * that was asked not to appear.
 */
export function pickKicker(kickers, random = Math.random) {
  if (!kickers?.length) return FALLBACK_KICKER;

  let total = 0;
  for (const k of kickers) total += k.weight > 0 ? k.weight : 0;
  if (total <= 0) return kickerText(kickers[Math.floor(random() * kickers.length)]);

  let roll = random() * total;
  let last = kickers[0];
  for (const k of kickers) {
    if (k.weight <= 0) continue; // skipped, not merely worth nothing
    last = k;
    roll -= k.weight;
    if (roll <= 0) return kickerText(k);
  }
  return kickerText(last); // float drift ate the total
}

/** One row as the card wants it. The space is added here and nowhere else. */
function kickerText(row) {
  const s = String(row?.text ?? '').trim();
  return s ? `${s} ` : FALLBACK_KICKER;
}
