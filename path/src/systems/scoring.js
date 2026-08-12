import { CONFIG } from '../config.js';
import { chainLevel } from './strike.js';

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
// Reads the PIP depth rather than the bar counter, like every other chain
// multiplier does now — see chainLevel() in systems/strike.js. The score
// climbs with each mouthful instead of stepping once a bar, and
// `comboMultiplierPerChain` still means exactly what it meant per link,
// because the level it multiplies is fractional.
export function comboMultiplierFor(strikeState) {
  if (!strikeState || strikeState.chainTimer <= 0) return 1;
  const level = chainLevel();
  const offset = CONFIG.strike.chainLevelOffset ?? 1;
  if (level <= offset) return 1;
  const extra = (level - offset) * CONFIG.points.comboMultiplierPerChain;
  return 1 + Math.min(CONFIG.points.comboMaxMultiplier - 1, extra);
}
