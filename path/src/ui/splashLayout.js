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
//   Title Slot  (1-138828)  absolute, width 100%, height 32%, top 0, padding
//                           1.5% a side, alignment BOTTOM-centre; holds
//                           `SR Wordmark` (1920x360) fitted CONTAIN and
//                           bottom-aligned.
//
// THE TITLE IS PINNED TO THE HORIZON, and that is what the 32% is. `Sky`
// (1-138785) is 32% of the screen tall and `Sea` fills the rest, so the
// waterline sits at 0.32*H at every size. The Title Slot is the SAME 32%,
// which makes its bottom edge the horizon exactly, and the wordmark is
// bottom-aligned in it — so the wordmark's own bottom edge lands ON the
// waterline whatever the browser is.
//
// `SR Wordmark` is 1920x360 and its art HANGS OUT THE BOTTOM (the artboard's
// clip is off): SEAL sits inside the box, SURVIVOR and the fin spill below
// y=360 and therefore below the waterline. THAT IS THE CONTROL. The distance
// from the words to the horizon is where the art sits inside those 360 units
// — set it once in the Rive editor and it holds at every viewport, because
// the whole wordmark scales as one piece about a bottom edge that is always
// the horizon.
//
// It used to be a 57%-tall slot holding a 1920x640 artboard fitted CONTAIN and
// CENTRED, which anchored the title to nothing: the box floated in the middle
// of a slot whose height AND whose letterboxing both moved with the viewport,
// so the waterline crossed the wordmark at a different place on every screen.
// Measured before the change: the ink ended 270px below the horizon at
// 1920x1080, 179 at 1280x800, 118 on a portrait iPad and 34 on a phone — the
// fin drifting from mid-SURVIVOR to above the S. 0.57/640 and 0.32/360 are
// within 0.2% of each other, so the wordmark's SIZE at any given viewport is
// unchanged; only where it is anchored moved.
//
// and the wordmark's INK — where its pixels actually are inside its own
// artboard, which is not its text boxes (the SEAL/SURVIVOR runs are
// 1846 wide with the glyphs centred in them, and the fin between SUR and
// VIVOR is an image that hangs to the bottom edge). Scanned off three
// rendered frames at different fits (desktop, laptop, iPad mini) and rounded
// outward; all three agreed within a few units. If the wordmark is redrawn,
// re-scan: render the probe (`npm run looks:splash`) at 1920x1080, where the
// fit is exactly 0.96 and the box runs x 38.4..1881.6, y 0..345.6, and take
// the extent of every pixel brighter than the sea that is not the sun. Done
// that way on 2026-09-11 and stable from luma>100 to luma>200, which is what
// the numbers below are. `bottom` is past 360 because the art hangs below the
// waterline — that is the design, not a stale measurement.
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
  // `heightFrac` is the HORIZON, not a title area: Sky is this tall, Sea is
  // the rest, and the Title Slot is the same height so its bottom edge is the
  // waterline. Move it and the sea level moves with the title.
  // `padFrac` is 0 AND THE ARTBOARD'S 1.5% IS NOT A MISTAKE. The Title Slot
  // really does carry 1.5% padding a side, but the nested artboard inside it
  // fits the slot's BORDER box and ignores it — measured, not assumed: across
  // thirteen viewports the rendered wordmark comes out at exactly
  // min(W/1920, 0.32*H/360), binding ratio 1.0000 either way round, and 0.97
  // misses by 3% on every screen where the width binds. It was 0.015 here from
  // the day this file was written, which made the model put the title 3%
  // smaller — and so slightly higher — than it draws.
  title: Object.freeze({ heightFrac: 0.32, padFrac: 0 }),
  wordmark: Object.freeze({
    width: 1920,
    // The ARTBOARD's height, which is shorter than its art: the box ends at
    // the horizon and SURVIVOR hangs below it. `ink.bottom` is past this on
    // purpose — see the header.
    height: 360,
    ink: Object.freeze({ left: 225, top: 0, right: 1715, bottom: 628 }),
  }),
});

/** The waterline, in CSS pixels down the screen. Sky is this tall; Sea is the
 * rest; the wordmark's bottom edge sits exactly here. */
export function horizonY(H, g = SPLASH_GEOMETRY) {
  return H * g.title.heightFrac;
}

/** Every part of the entry column, added up at scale 1. */
export function entryColumnHeight(g = SPLASH_GEOMETRY) {
  const c = g.column;
  return c.button + c.gap + c.pill + c.gap + c.button;
}

/**
 * The wordmark's ink, on screen. `SR Wordmark` is a 1920x360 artboard fitted
 * CONTAIN inside the title slot (the top 32% of the screen, less 1.5% padding
 * a side) and BOTTOM-aligned in it, so whichever axis binds the scale, the
 * box's bottom edge lands on the slot's — which is the horizon. The ink
 * rectangle is the measured constant above, and its bottom is past the box's
 * because the art hangs below the waterline.
 */
export function wordmarkRect(W, H, g = SPLASH_GEOMETRY) {
  const slotW = W * (1 - 2 * g.title.padFrac);
  const slotH = H * g.title.heightFrac;
  const s = Math.min(slotW / g.wordmark.width, slotH / g.wordmark.height);
  const boxW = g.wordmark.width * s;
  const boxH = g.wordmark.height * s;
  const left = (W - boxW) / 2;
  // Bottom-aligned, not centred: the slot's bottom edge is the horizon, so
  // this is the one line that pins the title to the waterline.
  const top = slotH - boxH;
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
