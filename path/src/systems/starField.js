// WHERE THE STARS ARE. One placement rule, written once, in both languages.
//
// Two things draw this field and they must agree about it:
//
//   systems/sky.js            paints a tiny dot per star, in the gradient's own
//                             fragment shader, for the price of one hash.
//   systems/constellations.js promotes the brightest of those to real geometry
//                             and draws the lines between them.
//
// If the two used their own formulas, the constellations would be strung
// between stars that aren't there, over a field of stars that aren't in any
// constellation — two unrelated skies on top of each other, which reads as a
// bug rather than as a design. So the hash and the jitter live here, exported
// as GLSL for the shader and as functions for the CPU, and the density slider
// in the Sky panel moves both fields at once.
//
// This module imports NOTHING on purpose (config.js reads it to size its
// readouts, and config.js is what everything else imports).

// Fraction of cells that DON'T get a star. A star field is mostly empty sky —
// at 0.9 one cell in ten is lit, which at the default density is a couple of
// hundred stars over a landscape frame.
export const STAR_THRESHOLD = 0.9;

// The GLSL half. sky.js includes this and then draws whatever it likes with
// it; constellations.js doesn't need it (it places its geometry on the CPU),
// but the numbers below have to be the same ones.
export const STAR_FIELD_GLSL = /* glsl */ `
  #define STAR_THRESHOLD ${STAR_THRESHOLD}

  float starHash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  // Where inside its own cell this star sits, 0..1 on both axes. Two more
  // hashes of the same cell, so it costs nothing and never has to be stored.
  // Without it the field reads as a lattice, which is the one thing a sky
  // must not look like.
  vec2 starOffset(vec2 cell) {
    return vec2(starHash21(cell + 1.7), starHash21(cell + 3.1));
  }
`;

const fract = (v) => v - Math.floor(v);

// Every step rounded to single precision, because the GPU's copy of this hash
// runs in floats and JS runs in doubles. The intermediate here reaches ~8500
// before the final fract, and at that magnitude a float has about three digits
// of fraction left — so the two languages disagree in the third decimal unless
// the CPU is made to throw the same bits away. They still won't agree on a
// GPU that quietly ran this at mediump, and a cell whose hash lands within a
// whisker of the threshold can go either way. That costs a bright star with no
// faint dot underneath it, which is invisible; it is not worth defending
// against any harder than this.
const f = Math.fround;

export function starHash21(x, y) {
  let px = f(fract(f(x * 123.34)));
  let py = f(fract(f(y * 456.21)));
  const dot = f(f(px * f(px + 45.32)) + f(py * f(py + 45.32)));
  px = f(px + dot);
  py = f(py + dot);
  return fract(f(px * py));
}

/**
 * Every star inside a world-space rectangle, at a given density.
 *
 * @param rect      {left, right, bottom, top} in world units
 * @param density   cells per world unit — the Sky panel's `star density`. A
 *                  bigger number is a finer grid and so MORE stars.
 * @param threshold cells above this hash get a star. Defaults to the shared
 *                  STAR_THRESHOLD, which is what the sky shader uses; pass a
 *                  higher one to take only the brightest of the same field.
 * @returns [{ x, y, seed, spin }] — `seed` is the cell's hash, 0..1, which is
 *          also what the sky shader scales its dot's brightness by, and `spin`
 *          is a second, independent one.
 *
 * WHY THERE ARE TWO RANDOM NUMBERS. `seed` is not a uniform 0..1 in the stars
 * that come back: a star EXISTS because its hash cleared the threshold, so
 * every seed here is crowded into the top tenth of the range, and anything
 * that promotes a subset crowds it further. Quantising that into beat slots
 * puts the entire sky on one slot — which looks exactly like a working effect
 * until you notice the whole field is flashing at once. Anything that wants a
 * spread wants `spin`, which is drawn from the same cell and is not what
 * selected it.
 */
export function starsIn(rect, density, threshold = STAR_THRESHOLD) {
  const d = Math.max(0.01, density);
  const stars = [];
  // The cell grid is anchored at the WORLD origin, not at the rectangle — so
  // a resize (which moves every bound) slides the frame over a field that
  // stays where it was, rather than reshuffling every star in the sky.
  const c0 = Math.floor(rect.left * d);
  const c1 = Math.ceil(rect.right * d);
  const r0 = Math.floor(rect.bottom * d);
  const r1 = Math.ceil(rect.top * d);
  // A degenerate rect (or a density cranked past anything sane) would
  // otherwise spin here for a very long time before running out of memory.
  if (!(c1 > c0) || !(r1 > r0) || (c1 - c0) * (r1 - r0) > 400000) return stars;

  for (let col = c0; col <= c1; col++) {
    for (let row = r0; row <= r1; row++) {
      const seed = starHash21(col, row);
      if (seed <= threshold) continue;
      const x = (col + starHash21(col + 1.7, row + 1.7)) / d;
      const y = (row + starHash21(col + 3.1, row + 3.1)) / d;
      if (x < rect.left || x > rect.right || y < rect.bottom || y > rect.top) continue;
      stars.push({ x, y, seed, spin: starHash21(col + 5.3, row + 9.7) });
    }
  }
  return stars;
}
