// ============================================================================
// THE RUN, SMALL ENOUGH TO SURVIVE THE PROCESS THAT WAS PLAYING IT.
//
// On iOS a run does not end, it disappears: the kernel kills WKWebView's
// WebContent process at its per-process memory limit and Capacitor's delegate
// calls webView.reload() underneath the app (see systems/crashWatch.js). Every
// variable goes with it. The player watches a loading bar and arrives back at
// the title with twenty minutes and forty upgrades gone, and nothing anywhere
// says what happened.
//
// crashLog.js and crashWatch.js already answer "did that just happen" on the
// next boot. This file is the other half — the part that makes the answer
// worth something, by keeping enough of the run OUTSIDE the process to put the
// player back in it.
//
// WHAT IS KEPT IS A TUPLE, NOT A SAVE FILE, and that is the whole reason this
// is cheap. entities/player.js builds the entire stat block by replaying every
// held pick from scratch (`computeStats` — upgrades, then level growth, then
// the boss pellet, then the damage scaling), so the block is not state at all:
// it is a pure function of a few dozen bytes. The picks, the level, the four
// run-long counters and the clock are the run. Restoring them and calling
// recomputeStats() reproduces a stat block identical to the one that died,
// including cards taken at a rarity the roller would never deal twice.
//
// WHAT IS NOT KEPT is the arena — enemy positions, projectiles in flight, the
// boss's animation clock, the particle field. That is megabytes of churning
// state, it would have to be versioned against every entity change in the
// game, and restoring it wrong is worse than not restoring it: a seal that
// comes back inside a creature is a bug report, where a seal that comes back
// into open water is a mercy. A resumed run gets a fresh ocean at the
// difficulty it had reached.
//
// THE COUNTER IS THE SAFETY ON THE SAFETY NET. If the run itself is what
// exhausts the memory — a level-16 board at three thousand draw calls is a
// plausible cause of the kill, not just its victim — then restoring it walks
// straight back into the same wall, and an automatic resume would turn one
// crash into an unescapable loop with no way to the menu. `resumes` rides in
// the snapshot and increments on each restore; past `maxResumes` the snapshot
// is refused and dropped, and the player lands on the title the old way.
//
// STORED SEPARATELY FROM THE CRASH BEACON, deliberately. The beacon is a
// diagnostic that is claimed and cleared on read; this is a save that must
// survive being read, and must be cleared only by a run that ended properly.
// Merging them would mean one of the two behaviours had to be wrong.
// ============================================================================

const KEY = 'sv.run.v1';

// Bumped when the shape below changes in a way that would make an old snapshot
// restore into something wrong rather than something missing. A snapshot from
// a different version is dropped, not migrated: this is a crash net, and a
// week-old save is worth nothing anyway.
const VERSION = 1;

function store() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Private mode on some browsers throws on the ACCESS, not just the write.
    return null;
  }
}

/**
 * Everything the run is, as plain JSON.
 *
 * Pure, and exported for the test: this is the only part of the file that can
 * be wrong in a way nothing would notice — a field dropped here is a card the
 * player silently does not get back.
 */
export function packRun(src = {}) {
  const picks = Array.isArray(src.picks) ? src.picks : [];
  return {
    v: VERSION,
    at: Date.now(),
    // How many times this same run has already been restored. Carried forward
    // by the caller across a resume — see noteResume.
    resumes: Math.max(0, Math.round(src.resumes ?? 0)),
    // --- the picks, oldest first, with the tier each was dealt at ------------
    // `finElement` rides along because Flippers Up! rolls a side's element once
    // and every later stack reads what is already held (rollFinElement in
    // entities/player.js). Dropping it would re-roll the seal's colours on a
    // resume, which is visible.
    picks: picks.map((p) => ({
      id: String(p?.id ?? ''),
      rarity: p?.rarity ?? null,
      ...(p?.finElement ? { finElement: p.finElement } : {}),
    })).filter((p) => p.id),
    loadout: src.loadout ?? null,
    // --- the run's own counters ---------------------------------------------
    level: num(src.level, 1),
    xp: num(src.xp, 0),
    xpToNext: num(src.xpToNext, 0),
    time: num(src.time, 0),
    difficulty: num(src.difficulty, 0),
    kills: num(src.kills, 0),
    score: num(src.score, 0),
    // The four things computeStats reads that are not picks or level.
    humansEaten: num(src.humansEaten, 0),
    bosses: num(src.bosses, 0),
    hp: num(src.hp, 0),
    oxygen: num(src.oxygen, 0),
    // CARDS OWED AND NOT YET TAKEN. The level-up screen is one of the two
    // places the crash trail says the process is most often killed, and a
    // player killed while looking at three cards has already earned the pick —
    // dropping it would make the net's worst case "you lose the thing you were
    // in the middle of choosing". tryOpenLevelUp puts the screen back up on the
    // first frame of the resumed run that is allowed to have it.
    pendingLevels: Math.max(0, Math.round(num(src.pendingLevels, 0))),
    // Where the boss schedule had got to. Without these a resumed run either
    // re-fights a boss it already beat or waits out a cadence that has already
    // passed — see bossState in systems/boss.js.
    bossNextLevel: num(src.bossNextLevel, 0),
    bossLastLevel: num(src.bossLastLevel, 0),
  };
}

function num(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Is this snapshot worth offering back?
 *
 * Pure, and the three refusals are the whole policy:
 *
 *   version   a shape this build cannot read.
 *   age       a snapshot from a session hours ago is not a crash to recover
 *             from, it is a run the player walked away from. Coming back to
 *             the game the next morning and being dropped into a stale fight
 *             would be the net doing harm.
 *   level     a run that had barely started is cheaper to replay than to
 *             explain. The floor is about the player's investment, not about
 *             whether the restore would work.
 *   resumes   see the counter note at the top of the file.
 */
export function resumable(snap, { now = Date.now(), maxAgeMs = 15 * 60 * 1000, minLevel = 2, maxResumes = 2 } = {}) {
  if (!snap || typeof snap !== 'object') return false;
  if (snap.v !== VERSION) return false;
  if (!Number.isFinite(snap.at) || now - snap.at > maxAgeMs) return false;
  if (!Number.isFinite(snap.level) || snap.level < minLevel) return false;
  if ((snap.resumes ?? 0) >= maxResumes) return false;
  return true;
}

/**
 * Write the run down. Synchronous, and called only at the handful of moments
 * the run actually changes shape — a card taken, a level crossed, a boss
 * beaten — plus the crash heartbeat's own cadence, which is already a
 * localStorage write every couple of seconds. There is no timer batching this
 * for the same reason crashLog has none: the entry that matters is always the
 * last one, and a batched last entry is the one still in memory when the
 * process is killed.
 */
export function saveRun(src) {
  const s = store();
  if (!s) return null;
  const snap = packRun(src);
  try {
    s.setItem(KEY, JSON.stringify(snap));
  } catch {
    // Quota, or a private window. A net we cannot write is a net we do not
    // have — never the thing that ends the run it is holding.
    return null;
  }
  return snap;
}

/** The snapshot as stored, or null. Does NOT clear it — see the note at the
 *  top about why this is not the crash beacon. */
export function readRun() {
  const s = store();
  if (!s) return null;
  try {
    const raw = s.getItem(KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw);
    return snap && typeof snap === 'object' ? snap : null;
  } catch {
    return null;
  }
}

/** Forget the run. Every path that ends one properly comes through here. */
export function clearRun() {
  const s = store();
  if (!s) return;
  try {
    s.removeItem(KEY);
  } catch {
    /* see saveRun */
  }
}

/**
 * Spend a resume: hand back the snapshot to restore from, with the counter
 * already advanced and written back.
 *
 * WRITTEN BACK BEFORE THE RUN STARTS, not after it survives a while. The whole
 * hazard the counter guards against is a restore that dies before anything
 * else can run — a counter incremented on the far side of that would never
 * increment at all, which is exactly the loop it exists to break.
 */
export function noteResume(snap) {
  const next = { ...snap, resumes: (snap?.resumes ?? 0) + 1 };
  const s = store();
  if (s) {
    try {
      s.setItem(KEY, JSON.stringify(next));
    } catch {
      /* see saveRun */
    }
  }
  return next;
}
