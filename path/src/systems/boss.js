// ---------------------------------------------------------------------------
// THE BOSS
// ---------------------------------------------------------------------------
// Every eight to twelve levels the water sends one enormous shark: a megalodon
// body at CONFIG.boss.sizeMul, a name rolled out of bossNames.csv, and a red
// health bar across the top of the screen for as long as it is alive.
//
// It is paced in LEVELS, not seconds. The run already has a clock scaling
// everything else (difficulty), and hanging the marquee spawn off that too
// would make the boss one more thing that gets bigger over time rather than an
// interruption. Levels are also the player's own pace: a build that is eating
// well meets its boss sooner, which is the right way round.
//
// WHY THIS IS A SYSTEM AND NOT A ROW IN THE SPAWN TABLE. The weighted pool
// answers "what should the water send next"; a boss is not an answer to that
// question at any weight. `bossShark` sits in CONFIG.enemies at weight 0 so it
// can carry stats, a model and a spawn group like every other creature, and
// this file is the only thing that can put one in the water.
//
// The whole file is one small state machine with three states — waiting for
// the level, alive, and gone — and no timers of its own.
// ---------------------------------------------------------------------------

import { CONFIG } from '../config.js';
import { clearForBoss, enemies, spawnNamed } from '../entities/enemies.js';
import bossNamesCsv from '../bossNames.csv?raw';
import { parseBossNameCsv, rollBossName } from '../bossNameTable.js';

// Parsed once — the file can't change without a page reload, since it's the
// dev server that notices the write. Same deal as the quip table.
const NAME_PARTS = parseBossNameCsv(bossNamesCsv);

/**
 * What is in the water, for anything that needs to draw it.
 *
 * `enemy` is the live creature, or null. Everything else is only meaningful
 * while it is non-null, and `hpFrac` is kept up to date each frame so the HUD
 * doesn't have to know what a boss is made of.
 */
export const bossState = {
  enemy: null,
  name: '',
  hpFrac: 1,
  // The level the next boss arrives at. Rolled at reset and again on every
  // spawn, so the gap between bosses is a fresh roll each time.
  nextLevel: 0,
  // How many have been sent this run. Not used for scaling — the creature's
  // own hpPerDifficulty already does that — but it is what a HUD or a score
  // screen would want, and it is one line to keep honest.
  defeated: 0,
};

// Inclusive, and clamped so a hand-edited config with max below min still
// produces a legal gap rather than a NaN that never arrives.
function rollGap(random = Math.random) {
  const cfg = CONFIG.boss ?? {};
  const min = Math.max(1, Math.round(cfg.everyLevelsMin ?? 8));
  const max = Math.max(min, Math.round(cfg.everyLevelsMax ?? 12));
  return min + Math.floor(random() * (max - min + 1));
}

/**
 * Back to "no boss, first one due in 8-12 levels". Called at the start of
 * every run — the creature itself is removed by resetEnemies, so this only
 * drops our reference to it.
 */
export function resetBoss(random = Math.random) {
  bossState.enemy = null;
  bossState.name = '';
  bossState.hpFrac = 1;
  bossState.defeated = 0;
  // Levels start at 1, so a gap of 8 means the first boss arrives AT level 8 —
  // seven level-ups in, not eight past the first one.
  bossState.nextLevel = rollGap(random);
}

// The size step, applied to all three things that have to move together: the
// model, the hitbox, and the "how big is this one for its species" number that
// physics and feedback read. Scaling only the visual gives a boss you can
// shoot through the nose of; scaling only the radius gives an invisible wall.
//
// multiplyScalar rather than setScalar on the visual, because the scale it
// already carries is the model's own fit times the tuner's Size slider — see
// the note on createVisual's root scale. Setting it would silently drop both.
function applyBossScale(e, mul) {
  if (!e || !(mul > 0) || mul === 1) return;
  e.visual.scale.multiplyScalar(mul);
  e.spawnScale *= mul;
  e.sizeMul *= mul;
  e.radius *= mul;
}

/**
 * One tick of the boss clock. Call it from the running branch of the frame
 * loop, after spawning — it reads `gameState.level` and the live enemy list,
 * and owns nothing else.
 *
 * Returns the boss that was spawned this frame, or null. Nothing needs that
 * today; it is there so an arrival cue (a sound, a camera push) has something
 * to hang off without this file growing a callback.
 */
export function updateBoss(gameState, scene) {
  const cfg = CONFIG.boss ?? {};
  if (!cfg.enabled) {
    // Switched off mid-run: let go of whatever is in the water rather than
    // holding a stale reference (and a stale health bar) forever. The creature
    // stays and is killable — it just stops being THE boss.
    //
    // `isBoss` has to come off it with the reference, and that is not tidiness:
    // the spawn lockout is keyed on that flag rather than on this module (see
    // bossLockout), so a creature left carrying it would suppress every other
    // spawn in the game for the rest of the run — an ocean that quietly
    // emptied itself and never refilled, from a toggle in the tuner.
    if (bossState.enemy) bossState.enemy.isBoss = false;
    bossState.enemy = null;
    return null;
  }

  // Is the one we sent still alive? `enemies` is the authority: a boss can
  // leave the list by being killed, by a run reset, or by anything else that
  // removes a creature, and none of those routes owes this file a callback.
  if (bossState.enemy) {
    if (enemies.includes(bossState.enemy)) {
      const e = bossState.enemy;
      bossState.hpFrac = Math.max(0, Math.min(1, e.hp / Math.max(1, e.maxHp)));
      return null;
    }
    bossState.enemy = null;
    bossState.hpFrac = 0;
    bossState.defeated += 1;
    // Nothing else this frame. A player who gained the whole next gap DURING
    // the fight is already past the threshold, and without this the next boss
    // would arrive in the same tick the last one died — the bar would never
    // clear, and the kill would read as the health bar refilling itself. It
    // arrives on the next frame instead, which is a breath rather than a wait.
    return null;
  }

  if (!gameState?.running) return null;
  if ((gameState.level ?? 1) < bossState.nextLevel) return null;

  const key = cfg.enemy ?? 'bossShark';
  if (!CONFIG.enemies[key]) {
    // A boss that cannot spawn must not retry every frame for the rest of the
    // run: that is a warning per frame and a check per frame, both for a
    // config error that will not fix itself mid-run.
    console.warn(`[boss] CONFIG.boss.enemy is "${key}", which is not in CONFIG.enemies — no boss this run.`);
    bossState.nextLevel = Infinity;
    return null;
  }

  // ignoreCaps: the boss holds a slot in the `apex` and `shark` families for
  // as long as it lives (which is the point — a boss fight is not also a
  // shiver), but its own arrival can't be blocked by them, or the marquee
  // spawn of the run would silently not happen because two sharks were
  // already swimming.
  // `overfill` as well: maxAlive was the last door left, and it is the one
  // that shuts hardest at exactly the wrong moment. A boss is due at a LEVEL,
  // and the ocean is fullest when the player has been farming their way to
  // one — so the arrival would silently not happen, and the retry would find
  // the arena just as full next frame, and the run's marquee spawn would be
  // skipped in precisely the fights that most needed clearing. One body over a
  // memory bound, for the few seconds it takes the clear-out below to empty
  // the water. See spawnNamed.
  const e = spawnNamed(scene, key, gameState.difficulty ?? 0, undefined, {
    ignoreCaps: true,
    overfill: true,
  });
  if (!e) return null; // unreachable today; the guard costs nothing

  applyBossScale(e, cfg.sizeMul ?? 1);

  // Marked BEFORE the clear-out, so the sweep can recognise the boss without
  // being handed it, and so the spawn lockout is live from this same frame
  // rather than from the next one — a tick's worth of ordinary spawning
  // landing on top of the arrival is exactly the frame the water should be
  // emptying.
  e.isBoss = true;
  // Everything that is not an escort turns for the wall. See clearForBoss:
  // they swim out, they do not vanish, and nothing is credited as a kill.
  clearForBoss(e);

  bossState.enemy = e;
  bossState.name = rollBossName(NAME_PARTS);
  bossState.hpFrac = 1;
  bossState.nextLevel = (gameState.level ?? 1) + rollGap();
  return e;
}

/**
 * What the HUD should draw, or null for "no boss". A view rather than the
 * state itself, so the UI never has to reason about a dead enemy that hasn't
 * been noticed yet.
 */
export function bossBanner() {
  if (!bossState.enemy) return null;
  return { name: bossState.name, frac: bossState.hpFrac };
}
