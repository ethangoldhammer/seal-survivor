import { CONFIG } from '../config.js';
import { projectileCount } from '../stats.js';
import { getAssetSizeMultiplier } from '../assets.js';

// RAZOR CLAMS — the fan.
//
// Everything in here is a pure function of the level, and that is the point:
// the card text measures itself off these (see upgradeText.js), the tuner
// readout reads them, and main.js spends them. One arithmetic, one place.
//
// The ability's whole identity is that its SHAPE moves with its level — a
// narrow aimed spray at one stack, a full ring at `arcFullAt`. Two independent
// curves get it there: `razorClamCount` for how many blades, `razorClamArc`
// for how wide. Folding the second into the first (a fixed angle per blade,
// say) would have made the middle levels a waypoint instead of a place, and
// would have tied the moment the circle closes to a blade count nobody chose.
//
// See CONFIG.razorClam for the numbers and systems/../entities/projectiles.js
// for what a blade does once it has left.

const TAU = Math.PI * 2;

/** Seconds between volleys at this level. Compounds, like the starfish's. */
export function razorClamFireRate(level) {
  const c = CONFIG.razorClam;
  return c.fireRate * Math.pow(c.fireRatePerLevel, Math.max(1, level) - 1);
}

/**
 * Blades in one volley, before Clone Warz.
 *
 * Kept a pure level -> blades function so the card and the tuner can both
 * quote it; `projectileCount` is applied at the launch instead, exactly as the
 * mussel barrage does it.
 */
export function razorClamCount(level) {
  const c = CONFIG.razorClam;
  return Math.max(1, Math.round(c.count + c.countPerLevel * (Math.max(1, level) - 1)));
}

/**
 * How wide the fan is at this level, in radians.
 *
 * Ramps linearly from `arc` at level 1 to a full turn at `arcFullAt`, and
 * stops there — a stack past the circle cannot buy an arc of 400 degrees, it
 * buys blades. Clamped at both ends rather than only at the top, because a
 * harness may well ask about level 0.
 */
export function razorClamArc(level) {
  const c = CONFIG.razorClam;
  const span = Math.max(1, (c.arcFullAt ?? 8) - 1);
  const t = Math.min(1, Math.max(0, (Math.max(1, level) - 1) / span));
  return c.arc + (TAU - c.arc) * t;
}

/**
 * HOW BIG A BLADE ACTUALLY IS — the art multiplier from assets.csv, which is
 * the only place a spawn size lives (the Size slider is a readout now).
 *
 * It is in this file rather than read at the launch site because three things
 * have to agree about it and none of them can see each other: what is DRAWN,
 * what it CUTS (below), and how fat a ribbon it drags. A shell rendered at two
 * and a half units with a quarter-unit reach is a weapon that visibly passes
 * through fish, and nothing reports it.
 */
export function bladeSize() {
  return getAssetSizeMultiplier('razorBlade') || 1;
}

/**
 * The blade's collision radius, in world units.
 *
 * `CONFIG.razorClam.radius` is the reach of a blade drawn at size 1, so this
 * is the same PROPORTION of the shell it always was — a bigger picture is a
 * bigger cut, in step, by construction rather than by two numbers being edited
 * together and eventually not being.
 */
export function razorClamRadius() {
  return CONFIG.razorClam.radius * bladeSize();
}

/**
 * How fast one blade whips about its own long axis, in radians a second.
 *
 * SIGNED PER BLADE, and that is the whole trick: a fan where every shell rolls
 * the same way reads as one rigid object being turned, and the chrome flashes
 * arrive in unison. Opposite hands scattered through the volley is a handful
 * of thrown shells.
 *
 * The roll is also what makes the metal work. CONFIG.chromeBlade is a
 * view-space horizon with one hot key lobe in it — an environment the body has
 * to TURN THROUGH to show anything — and until now the blades never rolled at
 * all, so every shell flew with one static shade on it. See the chrome note in
 * assets.js.
 */
export function razorClamRoll(rand = Math.random) {
  const c = CONFIG.razorClam;
  const base = c.roll ?? 0;
  const vary = c.rollJitter ?? 0;
  return base * (1 + (rand() * 2 - 1) * vary) * (rand() < 0.5 ? -1 : 1);
}

/** What one blade hits for at this level, before abilityDamage. */
export function razorClamDamage(level) {
  const c = CONFIG.razorClam;
  return c.damage + c.damagePerLevel * (Math.max(1, level) - 1);
}

/**
 * Bodies beyond the first one blade cuts through.
 *
 * FLOORED, for the reason the starfish's pierce gives: a value that crept up
 * by three fifths would cut two bodies for two levels and then silently three,
 * with nothing on the card able to say when.
 */
export function razorClamPierce(level) {
  const c = CONFIG.razorClam;
  return Math.min(
    c.pierceMax ?? 9,
    Math.max(0, Math.floor((c.basePierce ?? 0) + (c.piercePerLevel ?? 0) * (Math.max(1, level) - 1))),
  );
}

/**
 * The headings of one volley, in radians, centred on `heading`.
 *
 * THE CLOSED-CIRCLE CASE IS NOT A ROUNDING DETAIL. An open fan spans its arc
 * INCLUSIVELY — a blade on each edge and the rest between, which is what makes
 * a three-blade spray look like a spray rather than like two shots and a
 * straggler. Spread a full turn the same way and the first and last blade land
 * on the SAME heading, because -PI and +PI are one direction: the ring the
 * whole card is building toward would quietly arrive one blade short, with a
 * doubled lane where the seam is, and it would look exactly like a fan that
 * simply got wide.
 *
 * So a closed arc divides by `count` and an open one by `count - 1`, and the
 * seam is what decides which. The threshold is a hair under a full turn so
 * that a float landing at 6.283185 rather than 6.283185307 still counts as
 * closed.
 *
 * Jitter is rolled per blade AFTER the lane is placed, so it scatters the fan
 * without moving where the fan is.
 */
export function razorClamHeadings(level, heading, count = null, rand = Math.random) {
  const c = CONFIG.razorClam;
  const n = Math.max(1, count ?? razorClamCount(level));
  const arc = razorClamArc(level);
  const closed = arc >= TAU - 1e-3;
  const step = arc / (closed ? n : Math.max(1, n - 1));
  // A lone blade sits dead centre rather than at one edge of its own fan.
  const start = n > 1 ? heading - arc * 0.5 : heading;

  const out = [];
  for (let i = 0; i < n; i++) {
    // A closed ring is offset half a step so that the lanes straddle the aim
    // instead of one of them sitting exactly on it. Cosmetic on a full circle
    // — but it means the seam of the ring is never the direction the player is
    // pointing, which is the one lane they would notice being different.
    const lane = closed ? start + step * (i + 0.5) : start + step * i;
    out.push(lane + (rand() * 2 - 1) * (c.spread ?? 0));
  }
  return out;
}

/**
 * Everything one volley needs, in one call. `stats` is the live block, for
 * Clone Warz — pass null in a harness that only wants the card's numbers.
 */
export function razorClamVolley(level, heading, stats = null, rand = Math.random) {
  const count = projectileCount(razorClamCount(level), stats);
  return {
    count,
    headings: razorClamHeadings(level, heading, count, rand),
    damage: razorClamDamage(level),
    pierce: razorClamPierce(level),
    fireRate: razorClamFireRate(level),
    arc: razorClamArc(level),
    // The art half, which does not move with the level but does move with
    // assets.csv — handed over here so the launch spends one call and cannot
    // pick up a reach that disagrees with the shell it is drawing.
    size: bladeSize(),
    radius: razorClamRadius(),
  };
}
