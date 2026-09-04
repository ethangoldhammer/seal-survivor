// HOW THE NAME CHANGES: the old one boils away through the house noise.
//
// The splash's name pill hugs its text (see riveContract.js, `entryWidth`), and
// the artboard interpolates the pill's width when the text changes — so the
// SHAPE already moves. The text itself does not: Rive swaps one run for another
// between two frames, and a word that is suddenly a different word reads as a
// glitch under a box that is smoothly resizing around it.
//
// So the moment before the new name is written, the pill's pixels are copied
// off the Rive canvas into a canvas of their own, laid exactly over the pill,
// and eaten through the same baked dither field every menu in this game reveals
// through (ui/dither.js). The new name is drawn by Rive underneath from the first
// frame; the old one breaks up into flakes and is gone in under half a second.
// It is the tip's `boil` (ui/tipDissolve.js) pointed at a photograph instead of
// at DOM text, and it shares the field for the reason that file gives: one noise
// vocabulary.
//
// A SNAPSHOT, NOT A MASK OVER RIVE. The canvas cannot be masked per region, and
// the runtime has no per-object opacity we could animate from outside — but
// drawImage from one canvas to another is free, same-origin, and needs nothing
// from Rive at all. The overlay knows where the pill is because the artboard
// reports its own layout back through the view model (numEntryWidth, the scale
// and the offsets the game writes); see pillRect in ui/riveSplash.js.
//
// Dependency-free apart from the mask tiles, like dither.js and tipDissolve.js,
// so a look page can drive it with sliders and no game under it.

import { noiseMaskSet } from './dither.js';

/**
 * What a swap may be given. CONFIG.reveals.nameSwap is passed straight in by
 * the game; a look page can hand in its own. Every field is optional.
 */
export const NAME_SWAP_DEFAULTS = {
  enabled: true,
  // The field. `algo` is one of NOISE_ALGOS; `scale` is noise cells across the
  // baked tile — higher is finer, patchier grain. Both re-bake on change (tens
  // of milliseconds, cached by parameters).
  algo: 'billow',
  scale: 4,
  softness: 0.18,
  // Time to nothing, in seconds. Short on purpose: this runs on top of a pill
  // that is already resizing over ~0.3s, and the two should end together.
  time: 0.45,
  // The tile's size on screen, in multiples of the pill's HEIGHT — so the
  // flakes scale with the type and not with how long the name is.
  cell: 1.2,
  // Frames per second of churn in the field, and how far it slides while it
  // eats (px/s). Zero either to freeze it.
  boilHz: 12,
  drift: 40,
  // Openness steps and boil frames in the bake; the curve on progress.
  levels: 12,
  phases: 6,
  curve: 1.15,
};

function fieldFor(o) {
  return noiseMaskSet({
    size: 64,
    levels: o.levels ?? NAME_SWAP_DEFAULTS.levels,
    phases: o.phases ?? NAME_SWAP_DEFAULTS.phases,
    scale: o.scale ?? NAME_SWAP_DEFAULTS.scale,
    octaves: 2,
    algo: o.algo ?? NAME_SWAP_DEFAULTS.algo,
    softness: o.softness ?? NAME_SWAP_DEFAULTS.softness,
  });
}

/**
 * Bake the tiles ahead of the first roll. Tens of milliseconds; the game calls
 * this from warmReveals at idle. Safe to call with nothing — it just bakes the
 * defaults — and safe to call again after a slider moves, since the bake is
 * cached by its parameters.
 */
export function warmNameSwap(opts) {
  try { fieldFor({ ...NAME_SWAP_DEFAULTS, ...(opts || {}) }); } catch { /* no tiles: swapWithNoise falls back to a fade */ }
}

function setMask(style, image, size, position) {
  style.webkitMaskImage = image;
  style.maskImage = image;
  style.webkitMaskSize = size;
  style.maskSize = size;
  style.webkitMaskRepeat = 'repeat';
  style.maskRepeat = 'repeat';
  style.webkitMaskPosition = position;
  style.maskPosition = position;
  style.webkitMaskMode = 'alpha';
  style.maskMode = 'alpha';
}

/**
 * Copy `rect` (CSS px, relative to `source`) off the source canvas into an
 * overlay inside `wrap`, positioned over the same spot, and dissolve it.
 *
 * Call this BEFORE writing the new value: the source canvas still holds the
 * last frame with the old text on it, which is the whole photograph.
 *
 * @returns {{ cancel(): void }} — cancel removes the overlay at once (the
 *   splash is being torn down, or a second swap has begun).
 */
export function swapWithNoise({ wrap, source, rect, radius = 0, opts, now = () => performance.now(), raf = (cb) => requestAnimationFrame(cb) }) {
  const o = { ...NAME_SWAP_DEFAULTS, ...(opts || {}) };
  if (!wrap || !source || !rect || !(rect.w > 2) || !(rect.h > 2)) return { cancel() {} };

  // Backing store to CSS px, so a retina canvas is sampled at full resolution.
  const kx = source.width / (source.clientWidth || source.width);
  const ky = source.height / (source.clientHeight || source.height);
  const overlay = document.createElement('canvas');
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  overlay.width = Math.max(1, Math.round(rect.w * dpr));
  overlay.height = Math.max(1, Math.round(rect.h * dpr));
  overlay.className = 'sv-name-swap';
  overlay.style.cssText =
    `position:absolute; left:${rect.x}px; top:${rect.y}px; width:${rect.w}px; height:${rect.h}px; `
    + `border-radius:${radius}px; pointer-events:none; z-index:2;`;
  try {
    overlay.getContext('2d').drawImage(
      source, rect.x * kx, rect.y * ky, rect.w * kx, rect.h * ky,
      0, 0, overlay.width, overlay.height,
    );
  } catch {
    // A tainted or lost canvas: nothing to dissolve, and nothing lost either —
    // the new name is already on its way underneath.
    return { cancel() {} };
  }
  wrap.appendChild(overlay);

  let field = null;
  try { field = fieldFor(o); } catch { field = null; }

  let alive = true;
  const t0 = now();
  const time = Math.max(0.05, o.time);
  const cell = Math.max(8, rect.h * o.cell);

  const cancel = () => {
    if (!alive) return;
    alive = false;
    overlay.remove();
  };

  const frame = () => {
    if (!alive) return;
    const elapsed = (now() - t0) / 1000;
    const p = Math.min(1, elapsed / time);
    if (p >= 1) { cancel(); return; }
    if (field) {
      // Level counts DOWN: the set opens the darkest fraction first, so
      // `levels` is solid and 0 is nothing. Near-linear on progress — see the
      // note in tipDissolve's applyBoil about why a squared curve is wrong on
      // type.
      const level = Math.round(field.levels * Math.pow(1 - p, o.curve));
      const phase = o.boilHz > 0 ? Math.floor(elapsed * o.boilHz) % field.phases : 0;
      const dx = -elapsed * o.drift * 0.6;
      const dy = -elapsed * o.drift;
      setMask(overlay.style, field.masks[phase][level], `${cell}px ${cell}px`, `${dx}px ${dy}px`);
    } else {
      overlay.style.opacity = String(1 - p);
    }
    raf(frame);
  };
  frame();
  return { cancel };
}
