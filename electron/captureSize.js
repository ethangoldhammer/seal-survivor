// ============================================================================
// ONE SIZE, AND IT IS THE ONE THAT RECORDS AT 1920x1080.
//
// A take has exactly one correct window size, and it is not a preference: the
// file must be 1920x1080, and `screencapture` writes a window at its size in
// POINTS times the display's scale factor. So the window size is forced by the
// display — 960x540 on a 2x Retina panel, 1920x1080 on a 1x one — and picking
// it from a menu of sizes could only ever produce a file that is not 1080p.
//
// THE ALTERNATIVE WAS MEASURED AND DOES NOT WORK. Recording bigger and scaling
// down afterwards needs a resizer, and the one macOS ships is not one:
// `avconvert --preset Preset1920x1080` on a 1920x1144 source returns 1920x1144
// unchanged. The presets are ceilings that preserve aspect, not targets. There
// is no ffmpeg on this machine either — see record.js. So the size has to be
// right at capture, and that is the whole reason this file is arithmetic
// rather than a list.
//
// NOTHING HERE IMPORTS 'electron': `import { app } from 'electron'` throws
// under plain node, and a module that throws on import cannot be unit tested.
// ============================================================================

/** What every take must be, in real pixels. Not configurable — see above. */
export const OUTPUT = { width: 1920, height: 1080 };

/** Exactly 16:9, with no rounding possible — see unitsToSize's note. */
export const unitsToSize = (units) => ({ width: units * 16, height: units * 9 });

/** True only for a size that is exactly 16:9 — no tolerance, on purpose. */
export const is169 = ({ width, height }) => width * 9 === height * 16;

/**
 * The window size, in points, whose capture is exactly 1920x1080.
 *
 * `screencapture -l` writes the window at points x scaleFactor, so this is
 * just OUTPUT divided by that factor: 960x540 at 2x, 1920x1080 at 1x, 640x360
 * at the 3x a phone reports.
 *
 * A FRACTIONAL RESULT IS REFUSED rather than rounded. macOS reports fractional
 * scale factors on a scaled display (1.5, 1.7777…), and 1920/1.5 is a clean
 * 1280x720 while 1920/1.7777 is 1080.0000...x607.5 — a size no window can be,
 * which would round to something that captures at 1919 or 1921 and produce a
 * file that is not 1080p and does not say so. `exact` is how the caller knows
 * to say it out loud.
 */
export function captureSizeFor(scaleFactor) {
  const s = scaleFactor > 0 ? scaleFactor : 1;
  const width = OUTPUT.width / s;
  const height = OUTPUT.height / s;
  const exact = Number.isInteger(width) && Number.isInteger(height);
  if (exact) return { width, height, scaleFactor: s, exact: true };
  // The nearest whole 16:9 below, so the window is at least a legal shape and
  // the file is slightly under 1080p rather than a non-integer nonsense.
  const units = Math.floor(Math.min(width / 16, height / 9));
  return { ...unitsToSize(Math.max(units, 1)), scaleFactor: s, exact: false };
}

/** What a window of `size` points records as, at that display's scale. */
export const recordedSize = ({ width, height }, scaleFactor) => ({
  width: Math.round(width * scaleFactor),
  height: Math.round(height * scaleFactor),
});

/**
 * The largest exact 16:9 that fits `avail`, for the one case the derived size
 * cannot be used: a display whose work area is smaller than the window 1080p
 * needs. Rare (960x540 fits anything modern) and loud when it happens, because
 * the take will not be 1920x1080 and nothing else would say so.
 */
export function fitCapture(request, avail) {
  if (request.width <= avail.width && request.height <= avail.height) {
    return { ...request, fitted: false };
  }
  const units = Math.floor(Math.min(avail.width / 16, avail.height / 9));
  return { ...unitsToSize(Math.max(units, 1)), fitted: true };
}
