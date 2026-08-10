import { player } from '../entities/player.js';

// ============================================================================
// THE CROSS-CUTTING UPGRADES, as functions.
//
// Splash Zone and Big Rigz don't own an ability — they scale numbers that
// belong to a dozen other systems. Without this file each of those systems
// would import the player, reach into the stat block, and write its own
// `?? 1` fallback, which is twelve chances to spell the rule differently and
// twelve places to update when it changes.
//
// So: one import per consuming system, and the stat names appear exactly once
// in the whole codebase. A run with neither card taken multiplies by 1, which
// is why every call site can apply these unconditionally instead of branching
// on whether the upgrade was taken.
//
// These read `player.stats` live rather than taking it as an argument. That is
// deliberate — the stat block is REPLACED on every level-up and every tuner
// change (recomputeStats returns a fresh object), so a system that captured it
// at spawn time would keep scaling by whatever the numbers were when the wave
// was fired.
// ============================================================================

/**
 * How far a blast, aura or wavefront REACHES. The thing the Splash Zone card
 * is actually about.
 */
export function aoe(radius) {
  return radius * (player.stats?.aoeMul ?? 1);
}

/**
 * How far an ability LOOKS for something to point itself at — acquisition
 * radii, hunt ranges, cluster scans.
 *
 * Split from `aoe` and scaled far more gently on purpose. Reach and
 * acquisition feel like the same stat on a card and are nothing alike in play:
 * doubling a blast makes a good hit better, while doubling acquisition means
 * every companion in the game is engaging targets off the top of the screen
 * and the arena stops having a near and a far.
 */
export function targeting(range) {
  return range * (player.stats?.targetingMul ?? 1);
}

/**
 * Companion body scale — Big Rigz. Applied to the MESH and to the contact
 * radius by the same factor, so a bigger escort really does sweep a wider
 * path rather than just looking like it.
 */
export function companionScale() {
  return player.stats?.companionScale ?? 1;
}

/** Companion damage — the other half of Big Rigz. */
export function companionDamage(damage) {
  return damage * (player.stats?.companionDamageMul ?? 1);
}

/**
 * Size a companion's mesh, safely, from anywhere in its update loop.
 *
 * The naive version of this is `obj.scale.setScalar(companionScale())`, and it
 * is wrong twice: it discards the model's `fit` normalisation and the per-asset
 * Size multiplier that createVisual just wrote (the same overwrite that had the
 * beluga's bubble ignoring its slider entirely), and `multiplyScalar` instead
 * would compound the multiplier every frame until the companion filled the
 * arena in about a second.
 *
 * So the scale the object was BUILT at is stashed on it the first time it's
 * seen, and every frame after that is that base times the current multiplier.
 * Idempotent, safe to call unconditionally, and it picks up a level-up on the
 * next frame without needing to be told one happened.
 */
export function applyCompanionScale(obj) {
  if (!obj) return;
  if (obj.userData.rigBaseScale == null) obj.userData.rigBaseScale = obj.scale.x;
  obj.scale.setScalar(obj.userData.rigBaseScale * companionScale());
}
