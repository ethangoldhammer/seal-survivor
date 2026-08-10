// ============================================================================
// THE MUSICAL DIVISIONS, and nothing else.
//
// A leaf module with no imports, because both ends of the system need it and
// they sit on opposite sides of a dependency edge: config.js builds the tuner's
// button picker out of these names, and systems/beatSync.js turns a name into a
// number of beats. beatSync imports CONFIG, so config importing beatSync would
// be a cycle — and the alternative the codebase reached for last time (writing
// the list out twice and adding a test that the copies agree, as
// BIOLUM_PATTERNS does) is a test that only ever fails after the bug ships.
//
// THE NAME IS THE WIRE FORMAT. These strings land in CONFIG and are written
// into imported-tuning.json, so appending is safe and RENAMING silently unsyncs
// every effect that was set to the old name.
// ============================================================================

// Ascending by cycle length. `beats` is an absolute figure; `bars` defers to
// CONFIG.beatSync.beatsPerBar, so a config in 3/4 retimes every bar-length
// effect without touching this table.
//
// `plain` marks the power-of-two figures — the only ones nearestDivision()
// will snap TO. A dotted eighth or a triplet is a deliberate choice, not
// something an automatic fit should hand you because it landed 4% closer than
// the straight eighth beside it.
export const BEAT_DIVISION_TABLE = [
  { name: 'free', beats: 0 },
  { name: '1/16', beats: 0.25, plain: true },
  { name: '1/8T', beats: 1 / 3 },
  { name: '1/8', beats: 0.5, plain: true },
  { name: '1/4T', beats: 2 / 3 },
  { name: '1/8.', beats: 0.75 },
  { name: '1/4', beats: 1, plain: true },
  { name: '1/4.', beats: 1.5 },
  { name: '1/2', beats: 2, plain: true },
  { name: '1 bar', bars: 1, plain: true },
  { name: '2 bars', bars: 2, plain: true },
  { name: '4 bars', bars: 4, plain: true },
  { name: '8 bars', bars: 8, plain: true },
];

/** What the tuner's picker offers, in order. */
export const BEAT_DIVISIONS = BEAT_DIVISION_TABLE.map((d) => d.name);

const BY_NAME = new Map(BEAT_DIVISION_TABLE.map((d) => [d.name, d]));

/**
 * Beats per cycle of `division`. 0 means "free" — no grid, run at own rate,
 * which is also what an unknown name gets so a stale config degrades to the
 * old behaviour rather than to a divide-by-zero.
 *
 * Takes `beatsPerBar` rather than reading CONFIG so this stays a pure
 * function of its arguments and both callers — the live clock and the tuner's
 * readout — can use it.
 */
export function divisionBeatsIn(division, beatsPerBar = 4) {
  const d = BY_NAME.get(division);
  if (!d) return 0;
  return d.bars != null ? d.bars * Math.max(1, beatsPerBar) : d.beats;
}

/**
 * The musical division closest to a cycle authored in seconds — the bridge
 * from every hand-tuned rad/sec already in the config to a name on the grid.
 *
 * Distance is compared on LOG RATIO because tempo distance is multiplicative:
 * 1 beat vs 2 is the same musical jump as 2 vs 4, which a linear difference
 * gets badly wrong at the long end. Same comparison the crabs' gait sync uses
 * in entities/enemies.js.
 *
 * Only the `plain` figures are candidates — see the note on the table.
 */
export function nearestDivisionIn(seconds, beatSeconds, beatsPerBar = 4) {
  if (!(seconds > 0) || !Number.isFinite(seconds) || !(beatSeconds > 0)) return 'free';
  let best = 'free';
  let bestErr = Infinity;
  for (const d of BEAT_DIVISION_TABLE) {
    if (!d.plain) continue;
    const secs = divisionBeatsIn(d.name, beatsPerBar) * beatSeconds;
    if (!(secs > 0)) continue;
    const err = Math.abs(Math.log(secs / seconds));
    if (err < bestErr) { bestErr = err; best = d.name; }
  }
  return best;
}
