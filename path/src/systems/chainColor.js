import { CONFIG } from '../config.js';
import { liveChain } from './strike.js';

// ============================================================================
// THE FOOD CHAIN'S COLOUR — one hue, walking round the wheel, one step per
// link, and back to the start the moment the chain breaks.
//
// ONE ALGORITHM, THREE SURFACES, and that is the whole reason this is a file
// rather than three functions. The FOOD CHAIN! banner, the "STRIKE NOW!"
// prompt riding the boost ring and the ring's own combo arc are all saying the
// same thing about the same run of links; if each owned its own ramp they
// would agree at link one and drift apart by link six, and the player would
// have three colours to learn instead of one. Same reasoning as the shared
// reveal in systems/dissolve.js and the shared curves in ease.js.
//
// IT REPLACED A TWO-STOP RAMP — gold at the bottom, hot orange by link eight,
// and nothing past that. Two problems with it, and the second is the one that
// mattered: it ran out. A deep chain is the loudest thing in the game and it
// spent its last four links looking identical, so the moment the chain became
// genuinely reachable the escalation stopped escalating exactly where it was
// most deserved. A wheel never runs out — it comes round, which reads as "this
// has been going for a while" rather than as "this has stopped".
//
// WHOLE LINKS, NOT THE FRACTIONAL DEPTH. `chainLevel()` moves with every
// mouthful and would slide the hue continuously, which sounds nicer and is
// wrong here: the banner prints "x6" beside the colour, and a hue that has
// already drifted a third of the way to the next link's is a colour that does
// not match the number it is standing next to. The pips are the fine grain;
// the colour is the coarse one.
//
// WHY HSL AND NOT A LIST OF STOPS. A list is a rainbow with a length, and the
// chain has none: a link is a mouthful, so a good feast runs to three figures.
// Any list would either repeat visibly or run out again. The wheel is the
// honest shape for "keeps going".
// ============================================================================

/** The wheel's settings, with the shipped defaults for a harness that has none. */
function cfg() {
  return CONFIG.strike?.chainColor ?? {};
}

/**
 * WHERE ON THE WHEEL a given link sits, 0..1.
 *
 * `link` is the chain COUNT — 0 for no chain at all, which lands on `hue` and
 * is the gold the banner has always opened on. So the first link and no chain
 * are the same colour on purpose: the prompt is not a chain announcement, it
 * is the chain's colour showing what a strike would join.
 *
 * Wrapped rather than clamped, which is the difference between cycling and
 * stopping. The modulo is written to survive a negative (nothing hands one in
 * today, and a clamp that silently produced hue -0.1 would be a black banner).
 */
export function chainHue(link = 0) {
  const c = cfg();
  const start = c.hue ?? 0.13;
  const step = c.huePerLink ?? 0.12;
  const h = start + step * Math.max(0, link);
  return ((h % 1) + 1) % 1;
}

// HSL -> RGB, the standard piecewise form. Written out rather than borrowed
// from THREE.Color because two of the three callers are DOM nodes and pulling
// the renderer into a stylesheet to mix a colour would be the wrong dependency
// — and because THREE's own setHSL writes into the WORKING colour space, which
// is linear, while everything here is sRGB going straight at a screen.
function hue2rgb(p, q, t) {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 1 / 2) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
}

/**
 * The link's colour as three 0..255 channels.
 *
 * Saturation and lightness are held constant across the wheel deliberately:
 * they are what keeps every link equally legible over the water, and letting
 * them drift with the hue is how a rainbow ends up with one link nobody can
 * read. What they cannot do is equalise BLOOM — see the note on the ring's arc
 * in systems/strikeRing.js.
 */
export function chainRgb255(link = 0) {
  const c = cfg();
  const h = chainHue(link);
  const s = Math.max(0, Math.min(1, c.sat ?? 0.9));
  const l = Math.max(0, Math.min(1, c.light ?? 0.62));
  if (s <= 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

/** The link's colour as a CSS string, for the two nodes that wear it. */
export function chainCss(link = 0) {
  const { r, g, b } = chainRgb255(link);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * The link's colour as a 0xRRGGBB integer, for THREE.Color.set().
 *
 * A hex and not setRGB, and that is not a style choice: `.set(hex)` runs the
 * sRGB -> working-space conversion that every other colour in the ring gets
 * (they all arrive as hex out of CONFIG), and setRGB would skip it — so the
 * arc would come out a different brightness from the ring it sits outside.
 */
export function chainHex(link = 0) {
  const { r, g, b } = chainRgb255(link);
  return (r << 16) | (g << 8) | b;
}

/**
 * THE COLOUR RIGHT NOW — whatever the live chain is worth.
 *
 * Reads `liveChain()` rather than the raw counter, so a chain whose window has
 * lapsed reads as no chain and the wheel is back at the start before the next
 * one begins. That is the "start the process over" half of the rule, and it is
 * one function call rather than a reset anything has to remember to perform.
 */
export function liveChainCss() {
  return chainCss(liveChain());
}
