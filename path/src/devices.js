// ============================================================================
// INPUT DEVICES — the three ways this game is played, named once.
//
// This exists as a file of its own, with no imports, because two very
// different layers need the same three words and neither may depend on the
// other: input.js (which decides which device is in the player's hands) and
// calloutTable.js (which reads per-device wording out of a spreadsheet). A
// copy of the list in each would be a copy that drifts, and the way it would
// drift is silent — a `devices` cell saying `gamepad` when the code says `pad`
// parses, warns nothing, and simply never matches.
//
//   kbm    keyboard and mouse. The default on anything that isn't a phone.
//   touch  a touchscreen, driving the two floating sticks in input.js.
//   pad    a Standard Gamepad.
//
// THE MOUSE AND THE KEYBOARD ARE ONE DEVICE, deliberately. They are never
// alone — a mouse-only player still has a keyboard under their other hand —
// and the one thing this list is FOR is choosing words: "Hold Space or click"
// is one sentence, and splitting it in two would mean writing a variant for a
// player who does not exist.
// ============================================================================

export const DEVICES = ['kbm', 'touch', 'pad'];

/** For warnings, which are the only place these are shown to a human. */
export const DEVICE_LABELS = {
  kbm: 'keyboard & mouse',
  touch: 'touch',
  pad: 'controller',
};

// --- what this particular controller calls its shoulder buttons -------------
// The Gamepad API has no button LABELS. It gives an index and a free-text `id`
// the manufacturer wrote, so this is the only way to say "L1" to somebody
// holding a DualSense and "LB" to somebody holding an Xbox pad — and it is
// worth saying, because "shoulder button" is a phrase nobody's hand knows.
//
// Matched on the id string, vendor code included: Chrome's ids read like
// "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)"
// while Firefox's are often just the numbers. An unrecognised pad — and there
// will always be one — gets the generic phrase, which is true of every
// controller ever made.
const SHOULDER_NAMES = [
  { test: /dualsense|dualshock|playstation|\b054c\b/i, label: 'L1 or R1' },
  { test: /xbox|xinput|\b045e\b/i, label: 'LB or RB' },
  { test: /nintendo|switch|joy-?con|pro controller|\b057e\b/i, label: 'L or R' },
];

/** What to call the shoulder buttons on the pad with this `id`. */
export function shoulderLabel(padId) {
  const id = String(padId ?? '');
  for (const { test, label } of SHOULDER_NAMES) if (test.test(id)) return label;
  return 'a shoulder button';
}

/**
 * Does this machine's PRIMARY pointer suggest a touchscreen? `hover: none`
 * alongside `pointer: coarse` is the pair that means it: coarse on its own is
 * also a TV remote or a stylus, and a laptop with a touchscreen still hovers.
 *
 * Only ever a guess about a device nobody has touched yet — see defaultDevice.
 */
export function touchPrimary() {
  // `typeof` rather than a plain check, and not merely belt and braces: a Node
  // harness that imports input.js gets no `window` at all, and a bare reference
  // to a name that was never declared is a ReferenceError rather than an
  // undefined — so this would take the whole module down at the first call
  // instead of falling back to the keyboard.
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(hover: none) and (pointer: coarse)').matches ?? false;
}

/**
 * What to assume before any real input has arrived. It matters more than it
 * sounds: the first tip fires a couple of seconds into a run, and on a phone
 * the only touch so far may have landed on the start button rather than on the
 * canvas — so waiting for evidence would teach the first lesson wrong.
 *
 * `pad` is never guessed. There is no media query for a controller, and the
 * browser hides one entirely until a button on it is pressed, so a pad player
 * is always a player who has already told us.
 */
export function defaultDevice() {
  return touchPrimary() ? 'touch' : 'kbm';
}
