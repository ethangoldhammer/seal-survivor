import { CONFIG } from '../config.js';
import { liveChain } from './strike.js';

// Called at the moment of a kill, BEFORE the enemy is removed from the
// `enemies` array — so a school-wipe can be detected by checking whether any
// other member with the same schoolId is still alive.
export function computeKillPoints(e, allEnemies, comboMultiplier = 1) {
  const mult = e.def.prey ? CONFIG.points.preyMultiplier : CONFIG.points.predatorMultiplier;
  const base = (e.def.xp ?? 1) * mult;

  let schoolWipe = false;
  if (e.schoolId != null) {
    const remaining = allEnemies.some((o) => o !== e && o.schoolId === e.schoolId);
    schoolWipe = !remaining;
  }
  const bonus = schoolWipe ? CONFIG.points.schoolWipeBonus : 0;

  const points = Math.round((base + bonus) * comboMultiplier);
  return { points, schoolWipe, base: Math.round(base), bonus };
}

// Reads the strike system's current chain state — a chain in progress
// multiplies points on top of whatever the strike system already does to
// damage, so a big combo run is worth disproportionately more.
//
// READS THE NUMBER ON THE BANNER — `liveChain()`, whole links — because that
// number is spelled `x10` above the seal's head and there is no reading of
// that which is not a promise about the score. It used to read the fractional
// PIP depth instead, which is the same quantity divided by the mouthfuls in a
// bar: a chain announcing x10 paid x1.5, and the first five links on screen
// paid nothing at all. `comboMultiplierPerChain` still means per link; it is
// the same unit, counted at the grain the player is shown.
//
// The damage multiplier moved with it (chainDamageMul in systems/strike.js).
// The XP multiplier deliberately did NOT — see chainXpMul.
export function comboMultiplierFor(strikeState) {
  if (!strikeState || strikeState.chainTimer <= 0) return 1;
  const level = liveChain();
  const offset = CONFIG.strike.chainLevelOffset ?? 1;
  if (level <= offset) return 1;
  // UNCAPPED, and the only one of the four that is. The other three multiply
  // something the player then acts with — damage spent on a creature, speed
  // they have to steer at, xp that compounds into every rung of the ladder —
  // so each has a ceiling to keep the run playable. Score multiplies a number
  // on a scoreboard. Nothing downstream of it has to survive being large, and
  // a cap there does the one thing a scoreboard must never do: it makes the
  // best chain anyone has ever held score the same as a merely good one.
  const extra = (level - offset) * CONFIG.points.comboMultiplierPerChain;
  return 1 + extra;
}
