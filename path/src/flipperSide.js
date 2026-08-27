// ============================================================================
// WHICH FLIPPER A FLIPPERS UP! STACK FEEDS — and nothing else.
//
// A leaf module with no imports, for the reason beatDivisions.js is one: both
// ends of this need the rule and they sit on opposite sides of a dependency
// edge. config.js holds the upgrade's apply(), which decides which fin a stack
// grows; systems/elements.js decides which fin a stack's rolled ELEMENT lands
// on; entities/player.js rolls it. elements.js and player.js both import CONFIG,
// so config.js importing either would be a cycle.
//
// It is one line of arithmetic, which is exactly why it is worth a file. The
// alternative is the rule written out in three places, and a card whose size
// went on the left while its element went on the right is a bug nothing would
// catch — both halves look right on their own. `npm run test:upgrades` asserts
// that replaying apply() n times moves the side this names.
//
// See [[paired reaches must measure alike]]: the failure mode is not that one
// copy is wrong, it is that two correct-looking copies stop agreeing.
// ============================================================================

/** The two fins, in the order assets.js declares them — index 0 is the left. */
export const FLIPPER_SIDES = ['left', 'right'];

/**
 * The fin the `stack`-th pick of Flippers Up! feeds. 1-BASED: stack 1 is the
 * first card ever taken, and it is the left flipper.
 *
 * Parity and not "whichever multiplier is smaller", which is what this replaced.
 * The two agree while every stack multiplies by the same factor — and stop
 * agreeing the moment a stack does something other than multiply, which is
 * precisely what the element stacks do.
 */
export function flipperSideForStack(stack) {
  return FLIPPER_SIDES[(Math.max(1, Math.round(stack)) - 1) % 2];
}

/**
 * WHICH ELEMENT EACH FLIPPER IS CARRYING, read off a pick list — `{ left, right }`,
 * either side null.
 *
 * Here rather than in systems/elements.js, where it belongs by subject, because
 * entities/player.js needs it to roll the next one and elements.js already
 * imports player.js. That would be the first import cycle in either file, and a
 * pure scan over an array of picks has no business creating one.
 *
 * The element is stamped on the PICK when the stack is taken (addUpgrade), for
 * the reason elements.js gives about the run's element: recomputeStats() rebuilds
 * the stat block from scratch several times a minute, so an identity decided by
 * Math.random inside apply() would be re-rolled that often. Read back off the
 * pick list it is a pure function of what was taken, in the order taken — the
 * same shape activeElement() has.
 *
 * A pick with no stamped element (the first two, and any pick made before this
 * existed) contributes nothing and is SKIPPED rather than defaulted: a fin
 * quietly given an element nobody rolled is worse than a fin with none.
 */
export function finElementsIn(picks) {
  const out = { left: null, right: null };
  let n = 0;
  for (const p of picks ?? []) {
    if (p?.id !== 'flippersUp') continue;
    n += 1;
    if (p.finElement) out[flipperSideForStack(n)] = p.finElement;
  }
  return out;
}

/** The fin opposite `side`. */
export function otherSide(side) {
  return side === 'left' ? 'right' : 'left';
}
