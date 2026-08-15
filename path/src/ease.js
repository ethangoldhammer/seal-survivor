// ============================================================================
// EASING CURVES, and nothing else.
//
// A leaf module with no imports, for the same reason beatDivisions.js is one:
// both ends of the system need it and they sit on opposite sides of a
// dependency edge. config.js builds the tuner's button picker out of these
// names, and the systems turn a name into a curve — so a system importing
// CONFIG means config importing that system would be a cycle.
//
// WHY A NAMED TABLE RATHER THAN A FUNCTION PER CALLER. Before this file the
// project had exactly one easing curve written down (a smootherstep local to
// systems/cineCamera.js) and everything else was a CSS transition or a raw
// lerp. That is fine until two things are supposed to feel the same, at which
// point there is nothing to point at — and it means an easing choice can never
// be TUNED, because there is no vocabulary for the tuner to offer. Now there
// is: any `{ path: '…', type: 'choice', options: EASINGS }` row gives a curve
// a row of pills, and any system can read one with `ease(name, t)`.
//
// THE NAME IS THE WIRE FORMAT. These strings land in CONFIG and are written
// into imported-tuning.json, so appending is safe and RENAMING silently unsyncs
// every effect that was set to the old name.
//
// Every curve here maps 0→0 and 1→1, and none of them overshoot. Overshoot is
// a real and useful family (back, elastic), but it is not interchangeable with
// these: a bar that eases past 100% and settles back reads as a bug in a
// progress meter, and a picker whose options are not swappable is a trap.
// ============================================================================

// Clamped, because every caller is feeding this a progress value it computed
// from a clock, and one frame of overshoot at the end of a timer is the normal
// state of that rather than a bug worth propagating into a curve.
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

export const EASE_TABLE = [
  // No curve at all. Kept as a real option rather than as "unset", because
  // "does this actually need easing" is a question worth being able to answer
  // by clicking rather than by editing.
  { name: 'linear', fn: (t) => t },

  // --- OUT: fast to start, settling into the end ---------------------------
  // The family for anything ARRIVING. The motion is over almost as soon as it
  // begins and then eases into place, which reads as something that was
  // already moving before you looked at it.
  { name: 'outQuad', fn: (t) => 1 - (1 - t) * (1 - t) },
  { name: 'outCubic', fn: (t) => 1 - (1 - t) ** 3 },
  { name: 'outQuart', fn: (t) => 1 - (1 - t) ** 4 },
  // The hardest of them: 90% of the way there in the first fifth of the time.
  // Useful when the END of the move is the moment that matters and the travel
  // is just how it got there.
  { name: 'outExpo', fn: (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)) },

  // --- IN: slow to start, fastest at the end -------------------------------
  // The family for anything BUILDING toward a hit. Deliberately listed after
  // the out curves: it is the rarer choice, and picking it by accident for an
  // arrival is what produces the "nothing, nothing, nothing, JUMP" that this
  // table exists to make easy to fix.
  { name: 'inQuad', fn: (t) => t * t },
  { name: 'inCubic', fn: (t) => t ** 3 },

  // --- IN-OUT: eased at both ends ------------------------------------------
  { name: 'inOutQuad', fn: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2) },
  { name: 'inOutCubic', fn: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2) },
  // Smoothstep and its gentler sibling, which is the curve systems/cineCamera.js
  // already reaches for by hand — a zero second derivative at both ends, so a
  // move that is chained into another one does not corner at the join.
  { name: 'smoothstep', fn: (t) => t * t * (3 - 2 * t) },
  { name: 'smootherstep', fn: (t) => t * t * t * (t * (t * 6 - 15) + 10) },
];

/** Just the names, in table order — what a tuner `choice` row wants. */
export const EASINGS = EASE_TABLE.map((e) => e.name);

const BY_NAME = new Map(EASE_TABLE.map((e) => [e.name, e.fn]));

// Declared above `ease` rather than below it: a `const` referenced before its
// initialiser has run throws, and while nothing calls ease() during module
// evaluation today, "today" is the only thing keeping that true.
const warned = new Set();

/**
 * Apply a named curve. An unknown name falls back to linear rather than
 * throwing or returning undefined: the name comes out of a config file the
 * developer edits and out of saved tuning that can outlive a rename, and a
 * NaN progress value would be a frozen animation with no error to explain it.
 */
export function ease(name, t) {
  const fn = BY_NAME.get(name);
  const x = clamp01(t);
  if (!fn) {
    // Warned once per bad name rather than per frame — this is read from
    // inside animation loops, and a per-frame warning would bury everything
    // else in the console within a second.
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(`[ease] "${name}" is not a curve in ease.js — using linear. Known: ${EASINGS.join(', ')}`);
    }
    return x;
  }
  return fn(x);
}

/** True if this name resolves to a real curve. For tests and for validation. */
export function isEasing(name) {
  return BY_NAME.has(name);
}
