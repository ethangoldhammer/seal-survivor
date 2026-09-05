// ---------------------------------------------------------------------------
// WHERE EVERYTHING ON THE TITLE CARD IS, in CSS pixels, from the artboard's
// own layout rules — and the one function that decides how big the entry
// column may be so that it never sits on the wordmark.
//
// WHY THIS IS A MODULE. The dice and the Start button are drawn by Rive, not
// the DOM, so no getBoundingClientRect can find them. Their position is a
// function of three things the game can know: the canvas size (the artboard
// is fitted `Layout`, so artboard units ARE CSS pixels), the scale the game
// writes to `numEntryScale`, and the pill's width the artboard reports back
// through `numEntryWidth`. Everything else is a design constant of the
// `Splash Responsive` artboard, and those constants used to live in three
// places — ui/riveSplash.js knew the strip, the name-swap dissolve knew the
// pill, and a 0.42 "fraction of the height" stood in for the wordmark. The
// 0.42 was a guess at where the wordmark ends, and it was wrong on every wide
// screen: a laptop at 1280x800 and a phone held sideways both put the dice
// on the SURVIVOR. This file is the one copy, and the fit reads the wordmark's
// real edge instead of guessing at it.
//
// It is also what the checks read: tools/splash-layout-test.mjs sweeps every
// viewport through `fitEntryScale` and `splashFindings` in Node, and the
// layout audit (`npm run layout`, surface `splash`) does the same in a real
// browser against the width the artboard actually laid out. Dependency-free
// on purpose, so both can import it without a DOM.
//
// THE NUMBERS BELOW ARE MEASURED FROM THE .RIV, not designed here. Read out of
// the Rive editor on 2026-09-05 (artboard `Splash Responsive`, 1-116099):
//
//   Entry Row   (1-138830)  absolute, width 100%, height 324pt, bottom 72pt,
//                           alignment bottom-centre, padding 4% a side.
//   Entry Group (1-154814)  a column hugging its content, gap 16 x scale, sat
//                           on the strip's bottom edge: dice 80, pill 132,
//                           start 80, all x scale (numEntryScale drives each
//                           through a formula converter — see riveContract.js).
//   Title Slot  (1-138828)  absolute, width 100%, height 57%, top 0, padding
//                           1.5% a side; holds `SR Wordmark` (1920x640) fitted
//                           CONTAIN and centred.
//
// and the wordmark's INK — where its pixels actually are inside its own
// 1920x640 artboard, which is not its text boxes (the SEAL/SURVIVOR runs are
// 1846 wide with the glyphs centred in them, and the fin between SUR and
// VIVOR is an image that hangs to the bottom edge). Scanned off three
// rendered frames at different fits (desktop, laptop, iPad mini) and rounded
// outward; all three agreed within a few units. If the wordmark is redrawn,
// re-scan: render the probe (`npm run looks:splash`) at 1920x1080, where the
// artboard sits at scale 0.962 and x 36.5, and find the extent of its
// white / grey / purple pixels above the entry column.
// ---------------------------------------------------------------------------

export const SPLASH_GEOMETRY = Object.freeze({
  strip: Object.freeze({ height: 324, bottom: 72 }),
  column: Object.freeze({
    button: 80,        // the dice and the Start button are squares
    gap: 16,           // between each of the three
    pill: 132,         // the name pill's height
    pillPadX: 40,      // the pill's padding a side; its text fills the rest
    pillRadius: 29,
    perChar: 52,       // Playfair Display SC at 84px, per character — the
                       // estimate for the frame before the artboard has
                       // reported a real width
  }),
  title: Object.freeze({ heightFrac: 0.57, padFrac: 0.015 }),
  wordmark: Object.freeze({
    width: 1920,
    height: 640,
    ink: Object.freeze({ left: 185, top: 88, right: 1760, bottom: 640 }),
  }),
});

/** Every part of the entry column, added up at scale 1. */
export function entryColumnHeight(g = SPLASH_GEOMETRY) {
  const c = g.column;
  return c.button + c.gap + c.pill + c.gap + c.button;
}

/**
 * The wordmark's ink, on screen. `SR Wordmark` is a 1920x640 artboard fitted
 * CONTAIN inside the title slot (the top 57% of the screen, less 1.5% padding
 * a side) and centred in it, so its scale is whichever axis binds and its box
 * floats in the middle of the slot. The ink rectangle inside that box is the
 * measured constant above.
 */
export function wordmarkRect(W, H, g = SPLASH_GEOMETRY) {
  const slotW = W * (1 - 2 * g.title.padFrac);
  const slotH = H * g.title.heightFrac;
  const s = Math.min(slotW / g.wordmark.width, slotH / g.wordmark.height);
  const boxW = g.wordmark.width * s;
  const boxH = g.wordmark.height * s;
  const left = (W - boxW) / 2;
  const top = (slotH - boxH) / 2;
  const ink = g.wordmark.ink;
  return {
    left: left + ink.left * s,
    top: top + ink.top * s,
    right: left + ink.right * s,
    bottom: top + ink.bottom * s,
    scale: s,
  };
}

/**
 * The dice, the pill and the Start button, on screen, for a given scale and
 * pill width (the width the artboard reports through `numEntryWidth`, which
 * is already at that scale). The column sits on the strip's bottom edge and
 * is centred, so a smaller scale lowers its top and leaves its bottom alone.
 */
export function entryRects(W, H, scale, pillW, g = SPLASH_GEOMETRY) {
  const s = scale;
  const c = g.column;
  const bottom = H - g.strip.bottom;
  const btn = c.button * s;
  const gap = c.gap * s;
  const pillH = c.pill * s;
  const start = { left: (W - btn) / 2, right: (W + btn) / 2, top: bottom - btn, bottom };
  const pill = { left: (W - pillW) / 2, right: (W + pillW) / 2, top: start.top - gap - pillH, bottom: start.top - gap };
  const dice = { left: (W - btn) / 2, right: (W + btn) / 2, top: pill.top - gap - btn, bottom: pill.top - gap };
  return {
    dice, pill, start,
    column: { left: Math.min(dice.left, pill.left), right: Math.max(dice.right, pill.right), top: dice.top, bottom },
    pillRadius: c.pillRadius * s,
  };
}

/**
 * The scale the entry column should be drawn at, for this screen.
 *
 * Three ceilings, the smallest wins, and 1 on any screen that clears all of
 * them (every desktop):
 *
 *   width     the pill must fit between the screen's edges with `margin`
 *             to spare — `rowW` is the pill's width at scale 1;
 *   wordmark  the dice's top must sit `clearance` below the wordmark's ink,
 *             which is the rule the old 0.42-of-the-height stood in for and
 *             got wrong on every wide screen;
 *   1         the design size.
 *
 * The floor is low ON PURPOSE. A floor above the wordmark ceiling would be a
 * decision to overlap, and the one thing this must never do is that. Where
 * the floor binds (a phone held sideways is 393px tall and the wordmark
 * takes 57% of it) the buttons come out small, and the layout audit says so
 * as a tap-target finding — which is the right place for that trade-off to
 * be visible, and the artboard is the right place to fix it (a shorter title
 * slot on short screens). Nothing here can shrink the wordmark.
 */
export function fitEntryScale({
  W, H, rowW,
  margin = 24,
  clearance = 8,
  minScale = 0.12,
  g = SPLASH_GEOMETRY,
} = {}) {
  const byWidth = rowW > 0 ? (W - 2 * margin) / rowW : 1;
  const wm = wordmarkRect(W, H, g);
  const room = H - g.strip.bottom - clearance - wm.bottom;
  const byWordmark = room / entryColumnHeight(g);
  const s = Math.min(1, byWidth, byWordmark);
  if (!Number.isFinite(s)) return 1;
  return Math.max(minScale, s);
}

/** Estimate of the pill's width at scale 1 from its text, for the first frame. */
export function estimateRowWidth(text, g = SPLASH_GEOMETRY) {
  return 2 * g.column.pillPadX + String(text ?? '').length * g.column.perChar;
}

/** Overlap of two rects in pixels on each axis, or null when they are apart. */
export function overlap(a, b, tolerance = 1) {
  const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return ox > tolerance && oy > tolerance ? { x: ox, y: oy } : null;
}

/**
 * Everything wrong with the entry column at this size, in the shape the
 * layout audit reports (`type`, `what`, and the numbers). Empty is the pass.
 *
 *   splash-over-wordmark   a button or the pill on the title's ink
 *   splash-over-ui         a button or the pill on a DOM element — the tip
 *                          jar, the build stamp — passed in as `others`
 *   off-*                  a button or the pill past the screen's edge
 *   tap                    a button under `tapMin` on a touch device
 */
export function splashFindings({
  W, H, scale, pillW,
  others = [],
  touch = false,
  tapMin = 44,
  g = SPLASH_GEOMETRY,
} = {}) {
  const out = [];
  const rects = entryRects(W, H, scale, pillW, g);
  const wm = wordmarkRect(W, H, g);
  const parts = [['splash dice', rects.dice], ['splash name pill', rects.pill], ['splash start button', rects.start]];
  for (const [what, r] of parts) {
    const hit = overlap(r, wm);
    if (hit) out.push({ type: 'splash-over-wordmark', what, by: `${Math.round(hit.x)}x${Math.round(hit.y)}` });
    for (const o of others) {
      const h = overlap(r, o.rect);
      if (h) out.push({ type: 'splash-over-ui', what, over: o.what, by: `${Math.round(h.x)}x${Math.round(h.y)}` });
    }
    if (r.left < -1) out.push({ type: 'off-left', what, by: Math.round(-r.left) });
    if (r.right > W + 1) out.push({ type: 'off-right', what, by: Math.round(r.right - W) });
    if (r.top < -1) out.push({ type: 'off-top', what, by: Math.round(-r.top) });
    if (r.bottom > H + 1) out.push({ type: 'off-bottom', what, by: Math.round(r.bottom - H) });
    const w = r.right - r.left;
    const h = r.bottom - r.top;
    if (touch && what !== 'splash name pill' && (w < tapMin || h < tapMin)) {
      out.push({ type: 'tap', what, w: Math.round(w), h: Math.round(h) });
    }
  }
  return out;
}
