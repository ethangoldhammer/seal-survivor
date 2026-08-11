// HOW FAR THE NIGHT SKY REACHES, at a given depth of food chain.
//
// Eight lines of arithmetic in a file of their own, because three callers need
// the answer and none of them can be the one that owns it:
//
//   systems/constellations.js  builds the geometry ONCE, at the deepest chain's
//                              reach, and then gates it per frame with these
//                              same numbers as uniforms.
//   config.js                  prints what a chain buys, in the tuner, beside
//                              the sliders that change it.
//   tools/constellation-test   asserts the built field can actually serve the
//                              deepest chain it promises.
//
// config.js cannot import the system — the system reaches arena.js, which reads
// CONFIG at module scope, so the cycle would land in a temporal dead zone
// rather than merely being ugly. Same reason ../beatDivisions.js exists, and
// the same shape: a leaf with NO IMPORTS holding the rule, with the live
// interpretation left to whoever has the clock.
//
// The drift this prevents is specific and silent: a field built to a smaller
// reach than the shader is asked to draw is a set of links that never appear,
// at exactly the moment the player earned them.

/**
 * @param level how many links of food chain are live. Infinity asks for the
 *   deepest the config allows, which is what the builder sizes itself on.
 * @param cfg   CONFIG.constellations
 * @returns {{depth: number, radius: number, links: number}} — the clamped
 *   depth, the reach in world units, and how many neighbours each star may
 *   hold. `links` is fractional on purpose: the newest neighbour fades up as
 *   the chain climbs rather than snapping in on a whole number.
 */
export function chainReachAt(level, cfg = {}) {
  const chain = cfg.chain ?? {};
  const depth = chain.enabled === false
    ? 0
    : Math.max(0, Math.min(chain.maxLevel ?? 8, level));
  return {
    depth,
    radius: (cfg.linkRadius ?? 10) * (1 + (chain.reach ?? 0) * depth),
    links: (cfg.links ?? 2) + (chain.links ?? 0) * depth,
  };
}
