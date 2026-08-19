// ---------------------------------------------------------------------------
// WORN EDGE — the score card's border, eaten by the house noise field.
//
// The card is a slab of glossy black emulsion, and a slab with a mathematically
// perfect rounded rectangle for an outline reads as a browser element. This
// bakes a mask whose middle is solid and whose border is eroded: the silhouette
// keeps its shape and loses its precision.
//
// BAKED ONCE PER SIZE, cached, applied as a static `mask-image`. Nothing here
// runs per frame, which is the entire design constraint — the alternative is an
// SVG `feTurbulence` + `feDisplacementMap` filter on the face, and a filter on a
// layer that is being rotated in 3D re-rasterises the whole face on every frame
// of the turn. That is affordable on a desktop and is exactly the kind of thing
// that costs a phone its frame rate during the one animation the player sees at
// the end of every single run.
//
// THE FIELD IS THE MENUS' OWN (ui/dither.js, buildField). Not a similar one:
// the same function, so an edge worn here and a menu dissolving in are the same
// material at two scales. See the note on the export there.
//
// TWO THINGS DECIDE THE LOOK, and they are separate on purpose:
//
//   depth   how far in from the edge the wear can reach, in CSS pixels. This is
//           the SIZE of the effect and reads as how battered the card is.
//   style   how the field is CUT inside that band. Same field, same depth,
//           completely different material — see STYLES.
//
// WHY THE CUT IS BY QUANTILE. The field clusters around its middle, so a
// threshold walked evenly from 0 to 1 spends most of its travel outside the
// range the pixels actually occupy: the edge stays perfect, stays perfect,
// stays perfect, and then vanishes entirely. ui/tipDissolve.js hit this and
// solved it by naming the crossing point; noiseMaskSet solves it by cutting at
// quantiles. This does the latter, which is stronger — every pixel is replaced
// by its RANK in the field, so "half of this band survives" is true by
// construction rather than by tuning, whatever the noise happened to come out
// like this time.
// ---------------------------------------------------------------------------

import { buildField } from './dither.js';

/**
 * How the band is cut, once every pixel has been replaced by its rank.
 *
 *   soft   0 is a binary cut — hard flakes, the edge breaks off in pieces.
 *          Above 0 the cut becomes a ramp that wide in rank space, and the
 *          border comes out greyscale: worn smooth rather than broken.
 *   scale  the field's period across the card, in the same units dither.js
 *          uses. Small numbers are big slow shapes; large numbers are grain.
 *   bite   how much of the band the wear is allowed to take at its deepest.
 *          1 would let a hole reach all the way through the band on the worst
 *          pixel, which puts a notch in the card. Below 1 the inner edge of the
 *          band is always solid, so the outline is always closed.
 */
export const STYLES = {
  // THE DEFAULT, and the one that matches the rest of the interface: the same
  // grain the upgrade menu dissolves through, at the same coarseness.
  houseField: { algo: 'simplex', scale: 7, octaves: 2, soft: 0.10, bite: 0.85 },
  // Higher frequency and a hard cut. Reads as lacquer that has been chipped —
  // sharper and more literal than the house field, and a second vocabulary.
  chipped: { algo: 'value', scale: 15, octaves: 3, soft: 0, bite: 0.95 },
  // Blurred before it is cut. Handled rather than damaged; the softest of the
  // three and the one that survives being small.
  rubbed: { algo: 'simplex', scale: 5, octaves: 2, soft: 0.42, bite: 0.7 },
};

export const STYLE_NAMES = Object.keys(STYLES);

// Baking a mask costs a few milliseconds and the card is one of about four
// sizes across a run (phone, tablet, desktop, and whatever a resize lands on).
// Keyed on everything that changes a pixel.
const cache = new Map();
const CACHE_LIMIT = 12;

/**
 * A `url(data:image/png...)` mask for a card of this size, or null when one
 * cannot be made — a canvas that will not give up pixels, an unknown style, a
 * degenerate size. NULL IS A SUPPORTED ANSWER and the caller must apply no mask
 * at all rather than an empty one: an empty mask hides the entire card, which
 * on this screen is the difference between "the wear did not happen" and "the
 * player cannot get back into the game".
 *
 * @param w,h     the card's size in CSS pixels.
 * @param radius  its corner radius, so the mask follows the same outline.
 * @param depth   how far in the wear may reach, CSS pixels.
 * @param style   a key of STYLES.
 * @param seed    shifts the field. Two cards baked with different seeds are
 *                worn differently; the same seed is the same card every time,
 *                which is what stops the outline changing on a resize.
 */
export function wornEdgeMask({ w, h, radius = 14, depth = 9, style = 'houseField', seed = 0 } = {}) {
  const spec = STYLES[style];
  if (!spec || !(w > 8) || !(h > 8) || !(depth > 0)) return null;

  const key = `${Math.round(w)}|${Math.round(h)}|${radius}|${depth}|${style}|${seed}`;
  if (cache.has(key)) return cache.get(key);

  let url = null;
  try {
    url = bake(Math.round(w), Math.round(h), radius, depth, spec, seed);
  } catch (err) {
    // A canvas that refuses getImageData, or a browser without it. The card
    // shows with a clean edge, which is the look this replaced.
    console.warn(`[wornEdge] could not bake the border mask — ${err}`);
    url = null;
  }

  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, url);
  return url;
}

function bake(w, h, radius, depth, spec, seed) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');

  // ONE SQUARE FIELD, sampled across a rectangle. Building it at the card's
  // aspect would stretch the grain on a wide card and squash it on a tall one,
  // so the same style would look like two different materials on a phone and a
  // desktop. A square field sampled by the LONG edge keeps the grain the same
  // size in pixels whatever shape the card is.
  const size = 128;
  const field = buildField(spec.algo, size, spec.scale, spec.octaves, seed * 0.37);

  // Rank, not value — see the header. Sorting once and binary-searching is the
  // cheap way to turn every pixel into "what fraction of the field is below me".
  const sorted = Float32Array.from(field).sort();
  const rankOf = (v) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo / sorted.length;
  };

  const img = ctx.createImageData(w, h);
  const data = img.data;
  const long = Math.max(w, h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255; // only alpha is read

      // How far inside the rounded rectangle this pixel is. Negative is
      // outside the outline entirely and is cut with no reference to the noise
      // at all — the wear eats the edge, it does not add anything beyond it.
      const d = insetDistance(x + 0.5, y + 0.5, w, h, radius);
      if (d <= 0) { data[i + 3] = 0; continue; }
      if (d >= depth) { data[i + 3] = 255; continue; }

      // 0 at the outline, 1 at the inner lip of the band. `bite` holds the
      // deepest possible hole short of the lip, so the outline never breaks.
      const along = (d / depth) / spec.bite;
      const fx = Math.floor(((x / long) * size * 2) % size + size) % size;
      const fy = Math.floor(((y / long) * size * 2) % size + size) % size;
      const r = rankOf(field[fy * size + fx]);

      if (spec.soft <= 0) {
        data[i + 3] = r < along ? 255 : 0;
      } else {
        // Eased across a band `soft` wide in rank space, so the transition is
        // a gradient rather than a decision.
        const t = clamp01((along - r) / spec.soft + 0.5);
        data[i + 3] = Math.round(255 * t * t * (3 - 2 * t));
      }
    }
  }

  ctx.putImageData(img, 0, 0);
  return `url(${canvas.toDataURL()})`;
}

/**
 * Distance from (x, y) to the edge of a rounded rectangle — positive inside,
 * negative outside. The standard rounded-box SDF, negated so "how far in am I"
 * reads the way the loop above wants it.
 */
function insetDistance(x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  const px = Math.abs(x - w / 2) - (w / 2 - r);
  const py = Math.abs(y - h / 2) - (h / 2 - r);
  const qx = Math.max(px, 0);
  const qy = Math.max(py, 0);
  const outside = Math.hypot(qx, qy);
  const inside = Math.min(Math.max(px, py), 0);
  return r - (outside + inside);
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
