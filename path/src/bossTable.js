// ============================================================================
// BOSS ROSTER — which creatures can be THE boss, kept in bosses.csv.
//
// This used to be one string, `CONFIG.boss.enemy`, and one string is the right
// shape right up until there are two of something. A boss is not just a big
// creature: it is a body, a size step, and a point in the run where it becomes
// available — three numbers that want to be read across a row and compared
// down a column, which is what a table is for.
//
// Columns (order doesn't matter, unknown columns are ignored):
//   id        a short handle for the archetype. Must be unique. It is also
//             what bossNames.csv's `bosses` column joins to, so renaming one
//             silently unhooks its name parts — the parser warns when a name
//             row names an archetype that is not here.
//   enemy     the row in enemies.csv / CONFIG.enemies this boss is built from.
//             A key that does not exist is a boss that cannot spawn, so it is
//             checked at parse time rather than at the moment one is due.
//   sizeMul   how much bigger than its own row it arrives, applied to the
//             model, the hitbox and the size roll together (see boss.js).
//   minLevel  the player level from which this archetype is available at all.
//             0 means "from the first boss". This is the difficulty curve: the
//             shark is what a run meets first, and everything else is an
//             escalation that has to be earned.
//   weight    how likely it is RELATIVE TO THE OTHER ELIGIBLE ARCHETYPES.
//             Blank means 1; 0 takes it out without disabling the row.
//   ownNames  TRUE means this archetype draws ONLY from name parts that name
//             it, never from the shared pool. See parseBossNameCsv — a boat is
//             not a fish and should not be able to roll "Grimtide".
//   enabled   FALSE takes the archetype out of rotation entirely.
//
// HOW ONE IS PICKED: a shuffle bag, not an independent roll. See nextBoss.
// ============================================================================

import { parseIdTable, parseBool, parseNumber } from './csvTable.js';

const LABEL = 'bosses';
const FILE = 'bosses.csv';

// The archetype used when bosses.csv gives us nothing usable. Not a null and
// not a throw: the file is hand-edited, and a run with no boss at all is a
// feature quietly switching itself off with no symptom but silence.
export const FALLBACK_BOSS = Object.freeze({
  id: 'bossShark', enemy: 'bossShark', sizeMul: 1.6, weight: 1, minLevel: 0, ownNames: false,
});

/**
 * Parse the table into an array of archetypes, in file order.
 *
 * `enemies` is CONFIG.enemies (or any object with the creature keys on it), so
 * a row pointing at a creature that does not exist can be caught here — at
 * boot, next to the file that is wrong — rather than eight levels into a run.
 * Pass nothing to skip the check; the harness does that when it only wants to
 * test the parsing.
 */
export function parseBossCsv(text, enemies = null, warn = console.warn) {
  const rows = parseIdTable(text, LABEL, FILE, warn);
  const out = [];

  for (const [id, row] of rows) {
    if (!parseBool(row.enabled, LABEL, id, 'enabled', warn)) continue;

    const enemy = String(row.enemy ?? '').trim();
    if (!enemy) {
      warn(`[${LABEL}] "${id}" has no \`enemy\` — there is no creature to send, so the row is being ignored.`);
      continue;
    }
    if (enemies && !enemies[enemy]) {
      warn(`[${LABEL}] "${id}" points at enemy "${enemy}", which is not in CONFIG.enemies — the row is being ignored.`);
      continue;
    }

    const sizeMul = parseNumber(row.sizeMul, LABEL, id, 'sizeMul', warn, { min: 0 });
    const weight = parseNumber(row.weight, LABEL, id, 'weight', warn, { min: 0 });
    const minLevel = parseNumber(row.minLevel, LABEL, id, 'minLevel', warn, { min: 0, integer: true });
    // Blank is FALSE: an archetype says nothing and shares the pool, which is
    // what every archetype did before this column existed.
    const ownNames = row.ownNames == null || String(row.ownNames).trim() === ''
      ? false
      : parseBool(row.ownNames, LABEL, id, 'ownNames', warn);

    out.push({
      id,
      enemy,
      // A sizeMul of 0 is a boss scaled out of existence, which is never what
      // a blank-or-mistyped cell meant. Only a positive number is taken.
      sizeMul: sizeMul > 0 ? sizeMul : 1,
      weight: weight == null ? 1 : weight,
      minLevel: minLevel == null ? 0 : minLevel,
      ownNames,
    });
  }

  if (!out.length) {
    warn(`[${LABEL}] ${FILE} has no usable rows — every boss will be a "${FALLBACK_BOSS.id}".`);
    return [FALLBACK_BOSS];
  }
  return out;
}

/** Which archetypes the player has unlocked at this level. */
export function eligibleBosses(roster, level) {
  return roster.filter((b) => (level ?? 1) >= b.minLevel && b.weight > 0);
}

// ---------------------------------------------------------------------------
// THE SHUFFLE BAG
// ---------------------------------------------------------------------------
// An independent weighted roll per boss gives runs that fight the same shark
// four times, and with a roster this small that is most runs. It is also the
// worst possible outcome for the feature: the whole point of a second
// archetype is that the player meets it, and "unlucky" is indistinguishable
// from "not implemented" when the only evidence is what did NOT turn up.
//
// So archetypes are DRAWN, not rolled: each one comes out of the bag once,
// and the bag is refilled only when it runs dry. Weight still decides the
// order within a bag, which is what keeps a rare archetype from being exactly
// as common as a common one.
//
// The bag is refilled from what is eligible AT THE MOMENT IT EMPTIES, so an
// archetype that unlocks mid-run joins the next bag rather than the current
// one — a boss the player has not reached the level for can't be sitting in
// the bag waiting to be drawn.
//
// State lives in a plain object the caller owns (see bossState.bag) rather
// than in a module-level array, so a run reset is one assignment and a test
// can hold two independent bags at once.

/** A fresh, empty bag. */
export function newBossBag() {
  return { drawn: [] };
}

/**
 * Draw the next archetype. Returns null only when nothing is eligible yet,
 * which at level 1 with a roster gated behind minLevel is a real answer.
 */
export function nextBoss(roster, bag, level, random = Math.random) {
  const eligible = eligibleBosses(roster, level);
  if (!eligible.length) return null;

  // Anything already drawn this bag is out. An archetype that became eligible
  // part way through a bag is not in `drawn`, so it is available immediately —
  // the refill rule above is about what a bag STARTS with, and letting a newly
  // unlocked boss wait for the next refill would delay it by up to a full
  // roster.
  let pool = eligible.filter((b) => !bag.drawn.includes(b.id));
  if (!pool.length) {
    // Bag empty: refill. The one just fought is not excluded — with a single
    // eligible archetype it is the only answer there is, and with several the
    // odds of drawing it first out of a fresh bag are already low.
    bag.drawn = [];
    pool = eligible;
  }

  let total = 0;
  for (const b of pool) total += b.weight > 0 ? b.weight : 0;
  // Every eligible weight is 0 — the file says "none of these", and a boss is
  // still due. Uniform beats no boss.
  let pick = pool[Math.floor(random() * pool.length)];
  if (total > 0) {
    let roll = random() * total;
    for (const b of pool) {
      if (b.weight <= 0) continue;
      pick = b;
      roll -= b.weight;
      if (roll <= 0) break;
    }
  }

  bag.drawn.push(pick.id);
  return pick;
}
