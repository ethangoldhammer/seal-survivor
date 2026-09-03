// ---------------------------------------------------------------------------
// HOW BIG A MODEL'S MAP IS ALLOWED TO BE — the arithmetic, in one place.
//
// Split out of tools/texture-audit.mjs when tools/shrink-textures.mjs started
// needing the same answer. A second copy is the obvious way to write the second
// tool and it is the way this rots: the audit would go on reporting a saving
// against a number the shrinker no longer used, and the two would disagree
// silently — a report that says a model is right-sized about a file that is not.
//
// THE NUMBER. A creature's texture budget is set by the pixels it covers on
// screen and by nothing else. The camera is orthographic and frames
// `viewHeight` world units top to bottom whatever the window is, so
// pixels-per-world-unit is the canvas height over that; a model's world size is
// `fit` (its longest axis) times the size multiplier from assets.csv.
//
// Everything below is the CEILING and not the target — see the note the audit
// prints. It assumes the map is spread evenly over the model, and a UV layout
// that gives the face its own big island wants more than the average says.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MODELS = path.join(ROOT, 'public/models');
export const MB = 1048576;

export const VIEW_HEIGHT = 52; // CONFIG.arena.viewHeight

// And the frame is not always the resting one. The cinematic rig pushes in to
// cinecam.base.zoomMax, and it does it for the kill shot — the single most
// looked-at moment in a run, held on a stopped clock. A map sized for the
// resting frame is a map that goes soft exactly there, which is the worst
// possible place to save memory. Everything in frame scales, not just the
// subject, so this multiplies every row.
export const ZOOM_MAX = 3.15; // CONFIG.cinecam.base.zoomMax

// Two windows, because the answer has to hold for both and they are a factor of
// four apart. The first is what the playtest logs actually record
// (render.mpix 0.54 at pixelRatio 0.65); the second is a full-screen 4K panel at
// device pixel ratio 1, which is as many pixels as this game will ever be asked
// to cover.
export const WINDOWS = [
  { label: 'logged window', px: 581 },
  { label: '4K full screen', px: 2160 },
];

/** RGBA8 plus the mip chain, which is the +1/3. */
export const vramOf = (i) => (i.w * i.h * 4 * 4) / 3;

/**
 * Rounded up to a power of two, which is the only thing worth shipping: a
 * non-power-of-two map costs the same VRAM as the next one up and loses the mip
 * chain on some drivers. Floored at 32.
 */
export const pot = (n) => 2 ** Math.max(5, Math.ceil(Math.log2(Math.max(1, n))));

/**
 * Which asset keys use each model, and each key's `fit`.
 *
 * Scanned out of assets.js rather than imported: config.js pulls in a JSON
 * module, which plain Node refuses to load without a shim, and this only needs
 * two shapes of line.
 */
export function keysByModel() {
  const src = fs.readFileSync(path.join(ROOT, 'path/src/assets.js'), 'utf8').split('\n');
  const map = new Map();
  const fits = new Map();
  let key = null;
  for (const line of src) {
    const open = line.match(/^ {2}(\w+):\s*\{/);
    if (open) key = open[1];
    if (!key) continue;
    const fit = line.match(/^\s*fit:\s*([\d.]+)/);
    if (fit) fits.set(key, parseFloat(fit[1]));
    const model = line.match(/model:\s*'\/models\/([^']+)'/);
    if (model) {
      if (!map.has(model[1])) map.set(model[1], []);
      map.get(model[1]).push(key);
    }
  }
  return { map, fits };
}

/**
 * Which asset keys use each LOOSE side-car texture — the ones that live in
 * public/textures/ rather than inside a .glb.
 *
 * A separate scan because they are declared differently: a `texture:` block on
 * the asset naming a path, rather than a `model:`. Same budget applies to both
 * — a mask drawn over a creature is drawn at the creature's size — and the
 * emissive masks were the half of the roster the audit could not see, because
 * it only ever opened .glb files.
 */
export function looseTextureUsers() {
  const src = fs.readFileSync(path.join(ROOT, 'path/src/assets.js'), 'utf8').split('\n');
  const map = new Map();
  let key = null;
  for (const line of src) {
    const open = line.match(/^ {2}(\w+):\s*\{/);
    if (open) key = open[1];
    if (!key) continue;
    for (const m of line.matchAll(/'(\/textures\/[^']+)'/g)) {
      if (!map.has(m[1])) map.set(m[1], []);
      map.get(m[1]).push(key);
    }
  }
  return map;
}

/** Each asset key's size multiplier, from assets.csv. */
export function sizesByKey() {
  const csv = fs.readFileSync(path.join(ROOT, 'path/src/assets.csv'), 'utf8').split('\n');
  const out = new Map();
  for (const line of csv.slice(1)) {
    const m = line.match(/^([\w]+),([\d.]+)/);
    if (m) out.set(m[1], parseFloat(m[2]));
  }
  return out;
}

/**
 * The widest this model ever gets on screen, and the map that justifies.
 *
 * @returns { world, via, spans, want } — `want` is a power of two, or null when
 *   no key using this model declares a size (nothing to reason from).
 */
export function budgetFor(file, keys, fits, sizes) {
  // The biggest key using this model, since one map serves them all.
  let world = 0;
  let via = null;
  for (const k of keys) {
    const w = (fits.get(k) ?? 0) * (sizes.get(k) ?? 1);
    if (w > world) { world = w; via = k; }
  }
  if (!world) return null;
  const spans = WINDOWS.map((w) => world * (w.px / VIEW_HEIGHT));
  const widest = Math.max(...spans) * ZOOM_MAX;
  // One texel per pixel at the largest the model ever gets, rounded up. No
  // headroom multiplier: the mip chain already means a map sampled below 1:1
  // costs nothing in sharpness, and the 4K row is already the ceiling.
  return { world, via, spans, want: pot(widest) };
}
