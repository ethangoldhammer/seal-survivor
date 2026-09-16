#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run wheel — candidate colour wheels for the Blubberball team select,
// generated with poline and screened on the two things a KIT colour has to do.
//
// CONFIG.versus.wheel is twelve hexes a captain picks a team's colour from, and
// picking them by eye is how you end up with a set that looks like a palette
// and plays like two teams you cannot tell apart. poline
// (https://meodai.github.io/poline, MIT) draws lines between anchor points in
// HSL polar space, which is a good way to find a coherent ring — and a coherent
// ring is exactly what a set of OPPOSING colours must not be. So this generates
// and then argues with what it generated.
//
// NOTHING SHIPS FROM HERE. The output is hex rows to paste into config.js.
// poline is a devDependency and is not in the bundle: the wheel is a list
// somebody chose, and a generator wired into the game is a list that changes
// without anyone deciding.
//
// THE TWO SCREENS, and both are things the eye cannot check from a swatch grid:
//
//   TELLABLE APART. Two kits at speed, at the size of a goal light. Measured in
//   OKLab, not HSL — HSL's "distance" is a made-up cylinder in which yellow and
//   blue at the same L are equally far from green, which is not what anybody
//   sees. The bar is not invented either: it is the SHIPPED wheel's own worst
//   pair, so a candidate set is accepted when it is no worse than what is in
//   the game today.
//
//   IT LIGHTS ITS GOAL. The mouth burns in the scoring team's colour and the
//   bloom pass thresholds on LUMINANCE (CONFIG.bloom.threshold), where blue is
//   worth 7% and green 72%. A ring at one HSL lightness therefore blooms for
//   some teams and not others — of the twelve shipping today only three cross
//   the line, with red at 0.27 against yellow at 0.68. This reports the split
//   so a wheel can be chosen knowing which half of it lights up.
//
// USAGE
//   npm run wheel                       one set off the shipped wheel's anchors
//   npm run wheel -- --sets 8           eight candidates, ranked
//   npm run wheel -- --n 12             how many colours the wheel holds
//   npm run wheel -- --anchors ff0044,00ffe1,ffee00
//   npm run wheel -- --fn arcPosition   a poline position function
//   npm run wheel -- --lift             raise every colour to the bloom line
// ---------------------------------------------------------------------------

import { Poline, positionFunctions } from 'poline';
import { CONFIG } from '../path/src/config.js';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return v == null || v.startsWith('--') ? true : v;
};

const WANT = Math.max(2, Number(flag('n', CONFIG.versus?.wheelMax ?? 12)) || 12);
const SETS = Math.max(1, Number(flag('sets', 1)) || 1);
const FN = String(flag('fn', 'sinusoidalPosition'));
const LIFT = !!flag('lift', false);
const SEED = Number(flag('seed', 1)) || 1;

if (!positionFunctions[FN]) {
  console.error(`unknown --fn "${FN}". One of: ${Object.keys(positionFunctions).join(', ')}`);
  process.exit(1);
}

// Seeded, so a run that turns up a wheel worth keeping can be run again. poline
// draws on Math.random for its own anchors and for nothing else.
let seed = SEED >>> 0 || 1;
Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// --- colour ------------------------------------------------------------------

const srgb = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
const hex = (rgb) => '0x' + rgb.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('');
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Rec.709 relative luminance — the number CONFIG.bloom.threshold is compared against. */
function luminance(rgb) {
  const [r, g, b] = rgb.map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * OKLab. A perceptual space, so a distance in it is roughly a distance the eye
 * agrees with — which HSL is not: two hues 60 degrees apart are the same
 * "distance" in HSL whether they are orange and yellow (nearly the same colour)
 * or green and cyan (obviously different).
 */
function oklab(rgb) {
  const [r, g, b] = rgb.map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

const dE = (a, b) => {
  const p = oklab(a); const q = oklab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
};

function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

/**
 * RAISE A COLOUR TO THE BLOOM LINE without moving its hue — lightness only,
 * bisected, because luminance is not monotonic in anything HSL exposes and
 * there is no formula to invert. Refused where the hue cannot get there at all:
 * a saturated blue tops out around 0.3 and the honest answer is that no blue
 * kit lights its goal, not a blue that has been washed out until it does.
 */
function liftToBloom(rgb, want) {
  if (luminance(rgb) >= want) return rgb;
  const white = [1, 1, 1];
  let lo = 0; let hi = 1;
  for (let i = 0; i < 24; i++) {
    const t = (lo + hi) / 2;
    const mix = rgb.map((c, j) => c + (white[j] - c) * t);
    if (luminance(mix) >= want) hi = t; else lo = t;
  }
  const out = rgb.map((c, j) => c + (white[j] - c) * hi);
  return luminance(out) >= want - 1e-4 ? out : rgb;
}

// --- the screens -------------------------------------------------------------

const THRESHOLD = CONFIG.bloom?.threshold ?? 0.55;
const SHIPPED = (CONFIG.versus?.wheel ?? []).map(srgb);

/** The closest two colours in a set, and how close. */
function worstPair(set) {
  let worst = Infinity; let at = [0, 0];
  for (let i = 0; i < set.length; i++) {
    for (let j = i + 1; j < set.length; j++) {
      const d = dE(set[i], set[j]);
      if (d < worst) { worst = d; at = [i, j]; }
    }
  }
  return { worst, at };
}

function report(set) {
  const { worst, at } = worstPair(set);
  const lums = set.map(luminance);
  const blooming = lums.filter((l) => l >= THRESHOLD).length;
  return { worst, at, lums, blooming };
}

// --- generate ----------------------------------------------------------------

function anchorsFromFlag() {
  const raw = flag('anchors', null);
  if (typeof raw !== 'string') return null;
  return raw.split(',').map((s) => {
    const rgb = srgb(parseInt(s.trim().replace(/^0x|^#/, ''), 16));
    return rgbToHsl(rgb);
  });
}

function rgbToHsl([r, g, b]) {
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-9) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h < 0 ? h + 360 : h, s, l];
}

/**
 * A candidate wheel of exactly WANT colours.
 *
 * poline interpolates BETWEEN anchors, so what `colors` holds is anchors x
 * numPoints on a closed loop — which almost never lands on the number the ring
 * holds, and a wheel with eleven or thirteen slots is not a wheel. `getColorAt`
 * samples anywhere along the palette, so the count is ours to choose: even
 * positions round the loop, WANT of them.
 *
 * It returns a POINT (an object with a `color` on it), not an HSL triple —
 * destructuring it throws, which is the kind of thing a README example hides.
 */
function candidate(anchors) {
  const p = new Poline({
    anchorColors: anchors ?? undefined,
    numPoints: 4,
    positionFunction: positionFunctions[FN],
    closedLoop: true,
  });
  const raw = [];
  for (let i = 0; i < WANT; i++) {
    const at = p.getColorAt(i / WANT);
    const [h, s, l] = at?.color ?? at;
    raw.push(hslToRgb(h, s, l));
  }
  // Both, always — the lifted set is what gets printed, and the raw one is what
  // says how much the lift COST. See the note where that is reported.
  return { raw, set: LIFT ? raw.map((c) => liftToBloom(c, THRESHOLD)) : raw };
}

// --- output ------------------------------------------------------------------

const bar = report(SHIPPED);
console.log(`\nTHE WHEEL IN THE GAME TODAY — ${SHIPPED.length} colours`);
console.log(`  closest pair       ${bar.worst.toFixed(4)} in OKLab  (#${hex(SHIPPED[bar.at[0]]).slice(2)} vs #${hex(SHIPPED[bar.at[1]]).slice(2)})`);
console.log(`  lights its goal    ${bar.blooming} of ${SHIPPED.length} over the bloom line (${THRESHOLD})`);
console.log(`  luminance          ${Math.min(...bar.lums).toFixed(3)} … ${Math.max(...bar.lums).toFixed(3)}`);
console.log(`\n  That closest pair is the BAR below: a candidate is only better if no two`);
console.log(`  of its colours are nearer than the nearest two already in the game.\n`);

const anchors = anchorsFromFlag();
const rows = [];
for (let i = 0; i < SETS; i++) {
  const { raw, set } = candidate(anchors);
  rows.push({ set, raw, ...report(set), rawWorst: worstPair(raw).worst });
}
rows.sort((a, b) => b.worst - a.worst);

for (const [i, r] of rows.entries()) {
  const ok = r.worst >= bar.worst;
  console.log(`--- candidate ${i + 1} of ${rows.length}  (${FN}${LIFT ? ', lifted' : ''}) ${ok ? 'PASSES' : 'FAILS'} the bar`);
  console.log(`  closest pair       ${r.worst.toFixed(4)}  vs ${bar.worst.toFixed(4)} shipping  ${ok ? '' : '<- two teams that read as one'}`);
  console.log(`  lights its goal    ${r.blooming} of ${r.set.length}`);
  // WHAT THE LIFT COST, stated rather than left to be inferred. Raising a
  // colour to the bloom line moves it toward white, and white is where every
  // hue converges: a set lifted until all twelve light their goals is a set
  // whose twelve teams are harder to tell apart than the one it came from.
  // Both numbers, so the trade is a number and not a feeling.
  if (LIFT) {
    const cost = r.rawWorst - r.worst;
    console.log(`  the lift cost      ${r.rawWorst.toFixed(4)} -> ${r.worst.toFixed(4)}`
      + (cost > 1e-4 ? `  (${(100 * cost / Math.max(1e-6, r.rawWorst)).toFixed(0)}% of the separation, spent on reaching the bloom line)` : ''));
  }
  console.log(`  luminance          ${Math.min(...r.lums).toFixed(3)} … ${Math.max(...r.lums).toFixed(3)}`);
  console.log('    wheel: [');
  for (let k = 0; k < r.set.length; k += 6) {
    console.log(`      ${r.set.slice(k, k + 6).map(hex).join(', ')},`);
  }
  console.log('    ],');
  // Which of them light their goal, listed rather than marked in the block
  // above — the block is meant to be copied into config.js as it stands.
  const lit = r.set.map((c, k) => (luminance(c) >= THRESHOLD ? hex(c) : null)).filter(Boolean);
  console.log(`    lights its goal: ${lit.length ? lit.join(' ') : 'none of them'}\n`);
}
