import { CONFIG } from '../config.js';

// ===========================================================================
// CROWD CONTROL — who may be held, and who simply may not.
// ===========================================================================
// Six systems in this game stop a creature moving: the beluga's bubbles, the
// octopus grab, the bakalar's net, the club's ice on saturation, the club's own
// contact hold, and the dumbo's charm. They all express it the same way —
// `trapTimer` for "held, inert, harmless" and `charmTimer` for "fighting for
// the other side" — which is exactly right, and is why this file is possible at
// all: one concept, one field, one place to ask permission.
//
// THE RULE: A BOSS IS NEVER HELD BY A BASIC ABILITY.
//
// Not because it would be too strong. Because it deletes the fight. A boss is
// the one creature the whole arena is arranged around — the water is emptied
// for it, the camera frames it, it has forty times the health of anything else
// — and every one of the abilities above is on a short enough cooldown that
// two of them together mean a three-tonne animal that never gets a turn. The
// player would win, every time, and would never find out what the fight was.
//
// It also breaks the perks outright. `lunge` is a wind-up and a committed dash
// the player is meant to read and sidestep; a bubble landing during the wind-up
// leaves a boss frozen mid-tell with its contact damage multiplied, and the
// tell it is holding is now a lie. `teleport` blinks a body that is supposed to
// be locked in place. Neither is a bug in those perks — they are what a fight
// looks like when the thing having it can be switched off.
//
// WHAT A BOSS IS STILL VULNERABLE TO, deliberately: damage of every kind,
// knockback, the chill SLOW, marks, elemental burn. A slow is a tax on its
// movement and the player still has to swim away from it; a hold is the
// movement not happening. That line — does the boss still get a turn? — is
// what this file is drawing, and it is why chillEnemy keeps stacking cold on a
// boss and only the freeze at saturation is refused.
//
// The gate is the CREATURE, not the ability, on purpose. A new hold added
// tomorrow routes through holdEnemy because that is how holds are written in
// this codebase, and it inherits the rule without knowing the rule exists. The
// alternative — an allow-list of abilities that may hold bosses — is a list
// somebody has to remember to add to, which is the same as no list at all.
// ===========================================================================

/**
 * Is this creature immune to being held?
 *
 * `CONFIG.boss.control.immune` can turn the rule off for a debug session; a
 * missing config block means immune, so the rule holds even against a tuning
 * snapshot that has never heard of it. (A saved tuning file outranks a config
 * default, so a rule that defaulted the other way would be one stale snapshot
 * away from being off in someone's live game.)
 */
export function controlImmune(e) {
  if (!e?.isBoss) return false;
  return CONFIG.boss?.control?.immune !== false;
}

/**
 * May this creature be held right now? Callers use it as a TARGETING test as
 * much as a permission one — a bubble that pops on a boss and does nothing has
 * still been spent, so the beluga skips it while choosing rather than being
 * refused afterwards.
 */
export function canHold(e) {
  return !!e && !controlImmune(e);
}

/**
 * Hold a creature still for `seconds`. Returns whether it took, so a caller
 * can decide not to spend a charge, play a sound, or count a control event.
 *
 * Latching (max, not assign) is the shared contract: two bubbles on one fish
 * is the longer of the two holds, never the second one cutting the first short.
 */
export function holdEnemy(e, seconds) {
  if (!canHold(e) || !(seconds > 0)) return false;
  e.trapTimer = Math.max(e.trapTimer ?? 0, seconds);
  return true;
}

/**
 * Turn a creature against its own side for `seconds`. Same rule and the same
 * return: a charmed boss is a boss that isn't in the fight.
 */
export function charmEnemy(e, seconds) {
  if (!canHold(e) || !(seconds > 0)) return false;
  e.charmTimer = Math.max(e.charmTimer ?? 0, seconds);
  return true;
}
