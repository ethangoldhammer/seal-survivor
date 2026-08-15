import { CONFIG } from '../config.js';
import { rollChunkT } from '../entities/pickups.js';

// ---------------------------------------------------------------------------
// WHO PUTS A CHUM CHUNK IN THE WATER — see CONFIG.chumChunk for the design and
// spawning.csv for the numbers.
//
// Three sources, one file, because the interesting property is the one you can
// only see with all three in front of you: a chunk is the biggest single swing
// in the run's economy, and it must not be possible for two of these to hand
// out four of them inside ten seconds. The ambient timer is slow, the boss
// budget is finite and per-fight, and the pity chunk is once per fight.
// Scattered across three call sites those three facts are each individually
// true and jointly unverifiable.
//
// This module owns the CLOCKS and nothing else. It never touches the scene, the
// arena, the feedback table or the player — it is handed the fight and the
// seal's health and it calls back with a roll and a place. That is what makes
// it testable: tools/chum-chunk-test.mjs runs whole simulated fights through
// it in a few milliseconds, which is the only practical way to find out whether
// a five-minute fight can throw four chunks. See npm run test:chunks.
// ---------------------------------------------------------------------------

export const chunkSpawnState = {
  // Seconds to the next ambient chunk.
  ambient: 0,
  // The boss creature this budget belongs to. Keyed on the OBJECT rather than
  // on a boolean, because the only reliable "this is a new fight" signal is a
  // different creature in bossState.enemy — a run kills several bosses, and a
  // flag that reset on anything less would let one long fight inherit the last
  // one's spent budget, or hand every fight a pity chunk it had already used.
  fight: null,
  bossLeft: 0,   // ejections still owed this fight
  bossTimer: 0,  // seconds to the next one
  pityUsed: false, // the one-per-fight rescue, spent or not
  pityTimer: 0,  // seconds to the next pity roll
};

function between(rand, lo, hi) {
  return lo + rand() * (hi - lo);
}

/** Start of a run. */
export function resetChumChunkSpawner(rand = Math.random) {
  const c = CONFIG.chumChunk ?? {};
  chunkSpawnState.ambient = between(rand, c.spawnMin ?? 0, c.spawnMax ?? 0);
  chunkSpawnState.fight = null;
  chunkSpawnState.bossLeft = 0;
  chunkSpawnState.bossTimer = 0;
  chunkSpawnState.pityUsed = false;
  chunkSpawnState.pityTimer = 0;
}

/**
 * Where the pity chunk's roll starts, as a position in the 0..1 size range
 * rather than as a heal.
 *
 * Converted here because CONFIG states it as a heal fraction — which is the
 * readable way to author it ("at least 45% of a health bar") — while rollChunkT
 * works in roll space. Doing this conversion at the call site is exactly how
 * the size a chunk WEARS stops matching the heal it PAYS, which is the one
 * promise this whole pickup rests on.
 */
export function pityFloor() {
  const c = CONFIG.chumChunk ?? {};
  const lo = c.healMin ?? 0.1;
  const hi = c.healMax ?? 0.75;
  const want = c.pity?.healMin ?? lo;
  if (hi <= lo) return 0;
  return Math.max(0, Math.min(1, (want - lo) / (hi - lo)));
}

/**
 * One frame of chunk scheduling.
 *
 * @param dt   seconds
 * @param ctx  {
 *   boss:    the live boss creature, or null. Pass null while it is still
 *            ARRIVING — the entrance is where the creature is untouchable and
 *            the health bar is still filling, and kicking a chunk out of it
 *            there would have the fight paying out before it had started.
 *   hpFrac:  the seal's health, 0..1.
 *   onAmbient(t):      put one somewhere in the arena.
 *   onBoss(t, reason): kick one out of the boss. `reason` is 'boss' or 'pity',
 *                      for anything that wants to tell them apart.
 *   rand:    injected so the harness can seed it.
 * }
 */
export function updateChumChunkSpawner(dt, ctx) {
  const c = CONFIG.chumChunk;
  if (!c?.enabled) return;
  const rand = ctx.rand ?? Math.random;

  // 1. AMBIENT. Runs during boss fights too, deliberately: the ambient clock is
  // slow enough that colliding with a fight is rare, and pausing it would make
  // a long fight the one stretch of the run with no chunks in it at all — the
  // exact opposite of what the boss budget below is for.
  chunkSpawnState.ambient -= dt;
  if (chunkSpawnState.ambient <= 0) {
    chunkSpawnState.ambient = between(rand, c.spawnMin ?? 0, c.spawnMax ?? 0);
    ctx.onAmbient?.(rollChunkT(rand, c.healBias));
  }

  const boss = ctx.boss ?? null;
  const b = c.boss ?? {};

  // A DIFFERENT BOSS, or none. Both the ejection budget and the pity chunk are
  // per-fight, so both reset here — and the first ejection is scheduled a full
  // gap out rather than immediately, so a boss never arrives already throwing.
  if (boss !== chunkSpawnState.fight) {
    chunkSpawnState.fight = boss;
    chunkSpawnState.bossLeft = boss ? (b.maxPerFight ?? 0) : 0;
    chunkSpawnState.bossTimer = between(rand, b.gapMin ?? 0, b.gapMax ?? 0);
    chunkSpawnState.pityUsed = false;
    chunkSpawnState.pityTimer = c.pity?.checkEvery ?? 0;
  }
  if (!boss) return;

  // 2. THE BOSS KICKS ONE LOOSE. On a random gap rather than at HP milestones:
  // a fight is long, and a heal that arrives on a schedule you can learn stops
  // being relief and becomes a resource you plan around — which makes the fight
  // easier in the way that reads as the boss being weaker rather than as the
  // fight being survivable.
  if (b.enabled !== false && chunkSpawnState.bossLeft > 0) {
    chunkSpawnState.bossTimer -= dt;
    if (chunkSpawnState.bossTimer <= 0) {
      chunkSpawnState.bossLeft -= 1;
      chunkSpawnState.bossTimer = between(rand, b.gapMin ?? 0, b.gapMax ?? 0);
      ctx.onBoss?.(rollChunkT(rand, b.healBias ?? c.healBias), 'boss');
    }
  }

  // 3. THE PITY CHUNK. Once per fight, and only while the seal is genuinely in
  // trouble. Rolled on an interval rather than on the frame the gate is crossed
  // so it doesn't land inside the same instant as the hit that nearly killed
  // you, which reads as the game apologising rather than as a break.
  const p = c.pity ?? {};
  if (p.enabled === false || chunkSpawnState.pityUsed) return;
  if (ctx.hpFrac > (p.hpFrac ?? 0)) return;
  chunkSpawnState.pityTimer -= dt;
  if (chunkSpawnState.pityTimer > 0) return;
  chunkSpawnState.pityTimer = p.checkEvery ?? 2;
  if (rand() > (p.chance ?? 0)) return;
  // Spent whether or not the next fight needs one — that is what "once per
  // fight" means, and a pity chunk that could fire twice is a health bar the
  // boss can no longer take away.
  chunkSpawnState.pityUsed = true;
  // From the top of the range only. Anything less is a 12% chunk delivered at
  // 15% HP, which is worse than nothing: it is the game noticing you are dying
  // and doing almost nothing about it.
  ctx.onBoss?.(rollChunkT(rand, b.healBias ?? c.healBias, pityFloor()), 'pity');
}
