// ---------------------------------------------------------------------------
// Dither masks — the tiles the upgrade menu dissolves in through.
// ---------------------------------------------------------------------------
//
// Two independent tiled masks, generated here and applied by ui.js to two
// NESTED elements (the menu container and the panel inside it). Nesting is the
// whole trick: masks multiply down the tree, so two ordinary single-layer
// masks combine without `mask-composite`, which is the one part of CSS masking
// whose keywords and layer order still differ between engines.
//
//   1. THE HEX LATTICE (hexMaskSet). An ordered dither on a flat-top hex grid
//      rather than a square one, because everything else on this screen is a
//      hexagon — the cards are clipped to one, the seabed is tiled with them.
//      A square Bayer dither over hexagonal cards read as two grids arguing.
//      Cells light up in Bayer order, which is what keeps the fill dispersed
//      instead of clumping into a corner.
//   2. THE ORGANIC FIELD (noiseMaskSet). Tileable 3D value noise, thresholded
//      to a binary mask. The third axis is TIME: phase N and phase N+1 are two
//      slices of one continuous field, so cycling them boils rather than
//      flickers, the way a hand-drawn animation's line does. The lattice wraps
//      in all three axes, so the loop is seamless in space and in time.
//
// Both are baked once into data-URI PNGs and cached — nothing here runs per
// frame. ui.js animates by swapping which tile is on which element, plus a
// mask-position drift, all of which are cheap.
//
// Deliberately dependency-free (no CONFIG, no three, nothing): it's imported
// by ui.js, and it's also loaded directly by the standalone mask-check page
// used to eyeball the tiles in a real browser, which has no bundler.

// Standard 8x8 Bayer matrix, values 0..63 — the order cells light up in.
const BAYER8 = [
   0, 32,  8, 40,  2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44,  4, 36, 14, 46,  6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
   3, 35, 11, 43,  1, 33,  9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47,  7, 39, 13, 45,  5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

function canvas2d(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext('2d') };
}

// A fully clear and a fully opaque 1x1, used for the ends of every ramp. Both
// ends are exact by construction this way: no amount of care with antialiased
// hex edges guarantees a seamless solid, and a menu that finishes its reveal
// with a faint honeycomb etched into it looks like a rendering bug.
//
// Generated rather than written out as literal data URIs — a hand-typed
// base64 GIF that is subtly not what you meant fails as "the last frame of the
// reveal is blank", which is a long way from where the mistake is.
let ends = null;
function endMasks() {
  if (ends) return ends;
  const { canvas, ctx } = canvas2d(1, 1);
  const clear = `url(${canvas.toDataURL()})`;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 1, 1);
  ends = { clear, solid: `url(${canvas.toDataURL()})` };
  return ends;
}

// ---------------------------------------------------------------------------
// Hex lattice
// ---------------------------------------------------------------------------

// Flat-top hexagon: points at the left and right, flat edges top and bottom —
// the same orientation the cards are clipped to.
function hexPath(ctx, cx, cy, w, h, grow) {
  const rx = w / 2 + grow;
  const ry = h / 2 + grow;
  const qx = w / 4 + grow;
  ctx.beginPath();
  ctx.moveTo(cx + rx, cy);
  ctx.lineTo(cx + qx, cy + ry);
  ctx.lineTo(cx - qx, cy + ry);
  ctx.lineTo(cx - rx, cy);
  ctx.lineTo(cx - qx, cy - ry);
  ctx.lineTo(cx + qx, cy - ry);
  ctx.closePath();
  ctx.fill();
}

const HEX_COLS = 8; // one Bayer matrix exactly: 64 cells, every threshold once
const HEX_ROWS = 8;

// Keyed by parameters, because several surfaces reveal through different
// fields now (see CONFIG.reveals) and a single-slot cache would have them
// evicting each other — every level-up rebuilding what the score card just
// built, at a tenth of a second a time.
const hexCache = new Map();

/**
 * `steps + 1` hex masks, from empty to full.
 *
 * @param steps how many threshold levels the reveal is quantised to. Fewer is
 *              chunkier and more obviously stepped, which is the look — a
 *              smooth version of this is just a fade.
 * @param size  hex width, point to point, in px.
 * @returns { masks, tile: 'WWpx HHpx' } — the CSS mask-size the tile wants.
 */
export function hexMaskSet(steps, size) {
  const cacheKey = `${steps}|${size}`;
  const hit = hexCache.get(cacheKey);
  if (hit) return hit;

  // Rounded to whole pixels so the tile repeats without drifting a subpixel
  // per repetition, which shows up as a visible seam every few columns. The
  // 1% it squashes the hexagon by is not something an eye can find.
  const w = Math.max(4, Math.round(size / 4) * 4); // /4 so the 0.75w column pitch stays whole
  const h = Math.max(2, Math.round((w * Math.sqrt(3)) / 2));
  const dx = (w * 3) / 4;
  const tileW = HEX_COLS * dx;
  const tileH = HEX_ROWS * h;

  const { canvas, ctx } = canvas2d(tileW, tileH);
  ctx.fillStyle = '#000';
  const masks = [];
  const { clear, solid } = endMasks();

  for (let s = 0; s <= steps; s++) {
    if (s === 0) { masks.push(clear); continue; }
    if (s === steps) { masks.push(solid); continue; }
    // Strictly-less-than against a threshold that reaches 64.
    const cut = (s / steps) * 64;
    ctx.clearRect(0, 0, tileW, tileH);
    for (let col = 0; col < HEX_COLS; col++) {
      for (let row = 0; row < HEX_ROWS; row++) {
        if (BAYER8[(row % 8) * 8 + (col % 8)] >= cut) continue;
        const cx = col * dx + dx / 2;
        // Odd columns drop half a row — that offset IS the hex lattice.
        const cy = row * h + (col % 2 ? h : h / 2);
        // Drawn nine times, wrapped, so a cell overhanging an edge comes back
        // in on the opposite one and the tile is seamless in both axes.
        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            hexPath(ctx, cx + ox * tileW, cy + oy * tileH, w, h, 0.5);
          }
        }
      }
    }
    masks.push(`url(${canvas.toDataURL()})`);
  }

  const built = { masks, steps, size, tile: `${tileW}px ${tileH}px` };
  hexCache.set(cacheKey, built);
  return built;
}

// ---------------------------------------------------------------------------
// Organic field
// ---------------------------------------------------------------------------

// Deterministic hash → [0,1). Seeded per lattice point; no RNG state, so the
// same tile is generated identically every time (a reveal that looked good
// once should look the same on the next level-up).
function hash3(x, y, z) {
  let n = x * 374761393 + y * 668265263 + z * 2147483647;
  n = (n ^ (n >>> 13)) >>> 0;
  n = Math.imul(n, 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function fade(t) {
  return t * t * (3 - 2 * t);
}

// The organic field is built from one of several noise algorithms — they look
// genuinely different, and which one suits a reveal is a taste call rather
// than a correctness one, so each surface names its own in CONFIG.reveals
// rather than the choice being baked in here.
//
//   value    smooth interpolated random values. Soft, round, a bit bland — the
//            plainest "clouds".
//   perlin   gradient noise. Same scale as value but with more structure to
//            the shapes: lobes and channels rather than blobs.
//   simplex  gradient noise on a triangular lattice. Reads as the most
//            "organic" of the three — no square-grid bias in the shapes, and
//            the flow between phases is smoother.
//   worley   cellular / Voronoi. Distance to the nearest scattered point, so
//            it grows as rounded cells with seams between them — bubbles or
//            foam rather than clouds.
//   ridged   1 - |perlin|, stacked. Veins and ridges: sharp bright lines
//            through a dark field, which reveals in strands rather than blobs.
//   billow   |perlin|, stacked. The inverse feel: puffy, cauliflower clumps.
//
// All of them wrap in z (the time axis) so the boil loops. The lattice ones
// also wrap in x and y; simplex can't, and doesn't need to — the field is
// stretched across the menu rather than tiled across it (see ui.js), so
// nothing ever meets its own edge.
export const NOISE_ALGOS = ['value', 'perlin', 'simplex', 'worley', 'ridged', 'billow'];

// Which of them are periodic in z by construction. The rest get looped by
// crossfading the end of the sequence back into its start.
const Z_PERIODIC = new Set(['value', 'perlin', 'worley', 'ridged', 'billow']);

function wrap(v, n) {
  return ((v % n) + n) % n;
}

// Value noise on a lattice that WRAPS at `period` in x and y and at `zPeriod`
// in z.
function valueNoise(x, y, z, period, zPeriod) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = fade(x - xi);
  const yf = fade(y - yi);
  const zf = fade(z - zi);
  let out = 0;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const wx = dx ? xf : 1 - xf;
        const wy = dy ? yf : 1 - yf;
        const wz = dz ? zf : 1 - zf;
        out += wx * wy * wz * hash3(
          wrap(xi + dx, period), wrap(yi + dy, period), wrap(zi + dz, zPeriod),
        );
      }
    }
  }
  return out;
}

// The 12 edge-midpoint directions of a cube: the standard gradient set for 3D
// gradient noise. Even coverage of directions, and every dot product is two
// adds — no multiplies needed if you unroll it, though here clarity wins.
const GRAD3 = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

function gradAt(ix, iy, iz, period, zPeriod) {
  return GRAD3[Math.floor(hash3(wrap(ix, period), wrap(iy, period), wrap(iz, zPeriod)) * 12) % 12];
}

// Classic gradient (Perlin) noise, periodic in all three axes. Returns -1..1.
function perlin3(x, y, z, period, zPeriod) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fy = y - yi;
  const fz = z - zi;
  const u = fade(fx);
  const v = fade(fy);
  const w = fade(fz);
  let out = 0;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const g = gradAt(xi + dx, yi + dy, zi + dz, period, zPeriod);
        const ox = fx - dx;
        const oy = fy - dy;
        const oz = fz - dz;
        const wx = dx ? u : 1 - u;
        const wy = dy ? v : 1 - v;
        const wz = dz ? w : 1 - w;
        out += wx * wy * wz * (g[0] * ox + g[1] * oy + g[2] * oz);
      }
    }
  }
  // The corner dots land in roughly ±0.75; scaled so the field uses its range.
  return Math.max(-1, Math.min(1, out * 1.4));
}

// 3D simplex noise. The lattice is a skewed tetrahedral grid rather than a
// cube, which is what removes the axis-aligned bias you can see in Perlin
// (and why this reads as the least "computery" of the set). Returns -1..1.
//
// Not periodic in x or y — see the note on NOISE_ALGOS. `zPeriod` is still
// honoured for the gradient lookup so the time axis behaves the same way.
const F3 = 1 / 3;
const G3 = 1 / 6;
function simplex3(x, y, z, period, zPeriod) {
  const s = (x + y + z) * F3;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);
  const k = Math.floor(z + s);
  const t = (i + j + k) * G3;
  // Distances from the cell origin, unskewed back into real space.
  const x0 = x - (i - t);
  const y0 = y - (j - t);
  const z0 = z - (k - t);

  // Which of the six tetrahedra in this cell the point is in, as the order the
  // three coordinates step from the origin corner to the opposite one.
  let i1; let j1; let k1; let i2; let j2; let k2;
  if (x0 >= y0) {
    if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
    else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
  } else if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
  else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
  else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }

  const corners = [
    [x0, y0, z0, i, j, k],
    [x0 - i1 + G3, y0 - j1 + G3, z0 - k1 + G3, i + i1, j + j1, k + k1],
    [x0 - i2 + 2 * G3, y0 - j2 + 2 * G3, z0 - k2 + 2 * G3, i + i2, j + j2, k + k2],
    [x0 - 1 + 3 * G3, y0 - 1 + 3 * G3, z0 - 1 + 3 * G3, i + 1, j + 1, k + 1],
  ];

  let out = 0;
  for (const [ox, oy, oz, gi, gj, gk] of corners) {
    // The radial falloff each corner contributes through. Negative means the
    // point is outside this corner's sphere of influence and it adds nothing.
    let falloff = 0.6 - ox * ox - oy * oy - oz * oz;
    if (falloff <= 0) continue;
    falloff *= falloff;
    const g = gradAt(gi, gj, gk, period, zPeriod);
    out += falloff * falloff * (g[0] * ox + g[1] * oy + g[2] * oz);
  }
  return Math.max(-1, Math.min(1, out * 32));
}

// Cellular (Worley) noise: distance to the nearest of one scattered point per
// lattice cell, over the 27 cells around the sample. Returns 0..1, bright at
// the cell centres, so it opens as rounded cells with seams between them.
//
// The most expensive of the set by a wide margin — 27 cells, three hashes
// each. That's what the bake timing in the check page is for.
function worley3(x, y, z, period, zPeriod) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  let best = 3;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx;
        const cy = yi + dy;
        const cz = zi + dz;
        const wx = wrap(cx, period);
        const wy = wrap(cy, period);
        const wz = wrap(cz, zPeriod);
        // Three decorrelated offsets from one wrapped cell, so the feature
        // point moves with the cell and the field stays periodic.
        const fx = cx + hash3(wx, wy, wz);
        const fy = cy + hash3(wx + 101, wy + 313, wz + 7);
        const fz = cz + hash3(wx + 809, wy + 41, wz + 577);
        const d = (x - fx) ** 2 + (y - fy) ** 2 + (z - fz) ** 2;
        if (d < best) best = d;
      }
    }
  }
  return Math.max(0, 1 - Math.sqrt(best));
}

// One octave of whichever algorithm, normalised to 0..1.
function octave(algo, x, y, z, period, zPeriod) {
  switch (algo) {
    case 'perlin': return perlin3(x, y, z, period, zPeriod) * 0.5 + 0.5;
    case 'simplex': return simplex3(x, y, z, period, zPeriod) * 0.5 + 0.5;
    case 'worley': return worley3(x, y, z, period, zPeriod);
    case 'ridged': return 1 - Math.abs(perlin3(x, y, z, period, zPeriod));
    case 'billow': return Math.abs(perlin3(x, y, z, period, zPeriod));
    default: return valueNoise(x, y, z, period, zPeriod);
  }
}

// Same as hexCache, and it matters more here: a field costs up to about 130ms
// to bake, and three surfaces each want a different algorithm.
const noiseCache = new Map();

// Two lattice cells of travel per loop, spread across however many phases
// there are. This is what separates a boil from a flicker: the phases are
// samples ALONG a smooth path through the field, not independent draws from
// it. One cell would loop too obviously; more just slows the churn down.
const Z_PERIOD = 2;

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// One phase's field, fractal-summed over `octaves`.
/**
 * The raw field, before any cut. Exported for ui/wornEdge.js, which erodes the
 * score card's border with it.
 *
 * EXPORTED RATHER THAN REIMPLEMENTED, and that is the whole point: this project
 * has ONE noise vocabulary — the menus reveal through it, the boat wreckage and
 * the crew dissolve through the 3D version of it, and a card whose edge is worn
 * by a second, unrelated turbulence would look like it came from another game.
 * Everything downstream of this call decides how to CUT the field; nobody else
 * gets to decide what the field is.
 *
 * Values land roughly in 0..1 and are NOT evenly spread across it — fractal
 * noise clusters hard around the middle. Cut by quantile, never by a raw
 * threshold, or the control does nothing across most of its travel and
 * everything across a sliver of it. See noiseMaskSet, which does exactly that.
 */
export function buildField(algo, size, scale, octaves, z) {
  const px = size * size;
  const field = new Float32Array(px);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const period = scale * (1 << o);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        field[y * size + x] += amp * octave(algo, (x / size) * period, (y / size) * period, z, period, Z_PERIOD);
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < px; i++) field[i] /= total;
  return field;
}

/**
 * A grid of masks indexed [phase][level]: the organic layer.
 *
 * Coverage is set by QUANTILE, not by a fixed noise threshold — level k is cut
 * at the value that leaves k/levels of the field open, per phase. Both halves
 * of that matter: a fixed cut makes the ramp's pace depend on how the noise
 * happened to come out, and re-deriving it per phase is what stops the boil
 * from also flickering the menu's brightness as blobs churn.
 *
 * `softness` is the whole difference between the two looks. At 0 the mask is
 * binary — a hard edge, which is what the hex lattice wants underneath it. Above
 * 0 the cut becomes a ramp that wide a fraction of the field's range, and the
 * mask comes out greyscale: no dither at all, just an organic edge easing
 * across the menu.
 *
 * @returns { masks, levels, phases }
 */
export function noiseMaskSet({ size, levels, phases, scale, octaves = 2, algo = 'simplex', softness = 0 }) {
  const key = `${size}|${levels}|${phases}|${scale}|${octaves}|${algo}|${softness}`;
  const hit = noiseCache.get(key);
  if (hit) return hit;

  const px = size * size;
  const { canvas, ctx } = canvas2d(size, size);
  const masks = [];
  const { clear, solid } = endMasks();
  const loops = Z_PERIODIC.has(algo);

  for (let p = 0; p < phases; p++) {
    const z = (p / phases) * Z_PERIOD;
    let field = buildField(algo, size, scale, octaves, z);
    if (!loops) {
      // An algorithm that isn't periodic in z would pop on the frame the boil
      // wraps. Crossfading the sequence into a copy of itself shifted by a
      // whole period closes the loop for any field at all: at p = 0 this is
      // entirely the first field, and one phase past the end it would be
      // entirely the same thing again.
      const back = buildField(algo, size, scale, octaves, z - Z_PERIOD);
      const w = p / phases;
      for (let i = 0; i < px; i++) field[i] = field[i] * (1 - w) + back[i] * w;
    }

    // Quantiles off a sorted copy — coverage per level without searching.
    const sorted = Float32Array.from(field).sort();
    const span = Math.max(1e-6, sorted[px - 1] - sorted[0]);
    const soft = softness * span;
    const row = [];

    for (let l = 0; l <= levels; l++) {
      if (l === 0) { row.push(clear); continue; }
      if (l === levels) { row.push(solid); continue; }
      // Open the DARKEST fraction: pixels cross in a stable order as the level
      // climbs, so a blob grows outward instead of the pattern reshuffling.
      const cut = sorted[Math.min(px - 1, Math.floor((l / levels) * px))];
      const img = ctx.createImageData(size, size);
      const data = img.data;
      for (let i = 0; i < px; i++) {
        // Only alpha matters — the mask is applied in alpha mode.
        if (soft <= 0) {
          if (field[i] < cut) data[i * 4 + 3] = 255;
        } else {
          // 1 well below the cut, 0 well above it, eased across the band.
          data[i * 4 + 3] = 255 * (1 - fade(clamp01((field[i] - cut) / soft + 0.5)));
        }
      }
      ctx.putImageData(img, 0, 0);
      row.push(`url(${canvas.toDataURL()})`);
    }
    masks.push(row);
  }

  const built = { masks, levels, phases, key };
  noiseCache.set(key, built);
  return built;
}
