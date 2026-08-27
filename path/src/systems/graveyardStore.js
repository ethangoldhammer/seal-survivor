import { bounds } from '../arena.js';

// ============================================================================
// THE GRAVEYARD, ACROSS SESSIONS — the last few stones, kept on disk.
//
// NOT A LEDGER. systems/nameLedger.js is the permanent record and it is a RULE:
// every name that has ever died, forever, because permadeath is meaningless
// without it. This is the opposite kind of thing — a handful of stones so that
// opening the game shows some evidence of the last few times you played. It is
// capped, it forgets, and forgetting is the point: a graveyard that grew
// without limit would stop being scenery and become an archive.
//
// WHAT IS STORED, and the one field that is not what you would expect:
//
//   fx     the stone's position as a FRACTION of the arena's half-width, NOT a
//          world x. This is the whole reason the module exists rather than
//          being three lines inside gravesite.js.
//
//          bounds.right is viewHeight x ASPECT x widthScale — the arena is as
//          wide as the window is. Measured: a 16:9 desktop spans -92.4 to 92.4
//          and an iPhone in portrait spans -24.0 to 24.0. A grave saved at x=60
//          on a laptop is two and a half arena-widths outside a phone's world,
//          so a stored world coordinate is not a position, it is a position ON
//          THE MACHINE THAT SAVED IT.
//
//          Stored as a fraction and re-derived on load, the stone comes back
//          where it was RELATIVE TO THE ARENA, which is the only thing that
//          survives a change of screen. The failure this avoids is silent and
//          platform-specific: the yard simply is not there on a phone, and
//          "my graveyard is gone" is not a bug anybody reports usefully.
//
//   z      the stone's RESTING depth — where it stands in every session after
//          the one that carved it, rolled once at death. The session that made
//          it stands it in front of the plant bed instead, because that is the
//          one moment its name is being read; this is the depth it takes when
//          it becomes scenery. Read the depth block in gravesite.js.
//
//   name, cause, lead, stone
//          the rest of the inscription, as it was carved. `lead` in particular
//          is stored rather than re-rolled: a stone is carved and then it is
//          carved, and a headstone that reworded itself between sessions would
//          be the one thing on the seabed that changes its mind.
//
// `y` IS NOT STORED. It is re-measured against the live seabed every time the
// stone is seated (see seat() in gravesite.js), which is what keeps the yard on
// the floor when the tuner moves it. A stored y would be a stone hanging in the
// water at last week's arena height.
//
// NEVER THROWS. Read on the boot path and written on the death path, and
// neither is allowed to fail because storage is full, disabled, or holds
// something somebody typed by hand. A yard that cannot be read is an empty
// yard, which is exactly what a new player has.
// ============================================================================

const KEY = 'seal-survivor-graveyard';

// Bumped when the stored shape changes in a way an old record cannot satisfy.
// A mismatch is DISCARDED rather than migrated: this is decoration with a hard
// cap, so the cost of throwing it away is a few stones nobody had looked at
// yet, and the cost of a migration path is a branch that runs on the boot path
// forever and is exercised once.
const VERSION = 1;

/** How many are kept on disk. Deliberately the same order as the yard's own
 *  cap — storing more than can ever be planted would be writing rows for a
 *  graveyard that has no room for them. */
const MAX_STORED = 12;

/**
 * A world x as a fraction of the arena's half-width. Clamped, because a stone
 * exactly on the wall reads as part of the scenery rather than as a grave, and
 * because a NaN here would put the whole yard at the origin.
 */
function toFraction(x) {
  const half = Math.abs(bounds.right) || 1;
  const f = (Number(x) || 0) / half;
  return Math.max(-0.98, Math.min(0.98, f));
}

function fromFraction(fx) {
  const half = Math.abs(bounds.right) || 1;
  const f = Number(fx);
  return Number.isFinite(f) ? f * half : 0;
}

/**
 * Everything on disk, oldest first, as records gravesite.js can plant.
 *
 * Positions are resolved against the arena AS IT IS NOW — so this must be
 * called after updateBounds, which in practice means after the world is built.
 * Called before it, every stone comes back at a fraction of a stale width.
 */
export function loadGraveyard() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const rec = JSON.parse(raw);
    if (!rec || rec.v !== VERSION || !Array.isArray(rec.graves)) return [];
    return rec.graves
      .filter((g) => g && typeof g === 'object' && typeof g.name === 'string' && g.name.trim())
      .slice(-MAX_STORED)
      .map((g) => ({
        x: fromFraction(g.fx),
        z: Number.isFinite(Number(g.z)) ? Number(g.z) : undefined,
        name: String(g.name).trim(),
        cause: typeof g.cause === 'string' ? g.cause : '',
        lead: typeof g.lead === 'string' ? g.lead : '',
        stone: typeof g.stone === 'string' ? g.stone : null,
      }));
  } catch {
    // Private window, opaque origin, or a value somebody edited. A yard that
    // cannot be read is an empty yard — which is what a new player has, and is
    // a far better failure than a boot that throws over decoration.
    return [];
  }
}

/**
 * Write the yard. Called whenever it changes, which is once per death — not
 * per frame, and not per stone.
 *
 * Takes the LIVE records rather than reading them back out of gravesite.js, so
 * this module never has to know how a grave is shaped while it is standing.
 */
export function saveGraveyard(graves) {
  const list = (graves ?? [])
    .filter((g) => g && g.name)
    .slice(-MAX_STORED)
    .map((g) => ({
      fx: toFraction(g.x),
      // THE RESTING DEPTH, WHICH IS NOT WHERE THE STONE IS STANDING. The newest
      // grave stands in front of the plant bed for the session that made it —
      // its inscription is being read at that moment — and takes a rolled depth
      // among the plants from the next session on. `restZ` is that rolled one,
      // decided at death and stored so it never changes again. See the depth
      // block in gravesite.js. `z` is the fallback for a record that has no
      // opinion, which is what a harness planting a stone by hand hands over.
      z: Number.isFinite(g.restZ) ? g.restZ : g.z,
      name: g.name,
      cause: g.cause ?? '',
      lead: g.lead ?? '',
      stone: g.stone ?? null,
    }));
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: VERSION, graves: list }));
  } catch {
    // Full, disabled, or a private window. The session keeps its own yard
    // either way — this only decides whether it is there next time. Never
    // throws: the caller is a run that is in the middle of ending.
  }
}

/** Forget the yard. The development door, and what a harness calls between
 *  simulated players. Not in the game's UI: the cap is what forgets. */
export function clearGraveyardStore() {
  try {
    localStorage.removeItem(KEY);
  } catch { /* nothing to do, and nothing worth taking a run down for */ }
}
