import { player } from '../entities/player.js';

// WHERE YOU HIT IT FROM DECIDES WHAT IT IS WORTH.
//
// One creature uses this — the man o' war — and the whole fight is built on it:
// a float sitting on the waterline with a metre of filament hanging under it.
// Coming at it from below means swimming up through the stinging half, so it
// pays almost nothing. Meeting it along the surface, front or back, is the
// ordinary exchange. Dropping on it from above means leaving the water first,
// which is a real commitment on a body that cannot chase you, and it pays full.
//
// THREE BANDS, NOT AN ANGLE. A continuous falloff was the first instinct and it
// is worse for the one reason that matters here: the player has to be able to
// tell which band they are in WHILE they are deciding, and a smooth curve gives
// them no such moment. Bands make "get above it" a thing you can aim for.
//
// "FRONT AND BACK AT THE WATER SURFACE" IS THE MIDDLE BAND, and it needs no
// test of its own. This animal floats: its origin sits a hair under the
// waterline by construction (see CONFIG.enemies.*.surface.lift), so being level
// with it IS being at the surface, and the horizontal side you are on has never
// mattered to anything here. Anything that ever wanted a real front/back split
// would need a facing test, and this creature has no front.
//
// MEASURED IN THE BODY'S OWN RADII, never world units — a boss's radius follows
// its `sizeMul` and an absolute gap here would stop describing the animal the
// day anyone resized it.

/**
 * The multiplier a hit on `e` is worth right now, from where the player is.
 * 1 when the creature has no zones, so every caller can multiply blindly.
 */
export function damageZoneMul(e) {
  const z = e?.def?.damageZones;
  if (!z || !player?.mesh || !e?.mesh) return 1;
  const r = e.radius || 1;
  const dy = player.mesh.position.y - e.mesh.position.y;
  if (dy > (z.aboveGap ?? 1.5) * r) return z.above ?? 1;
  if (dy < -(z.belowGap ?? 0.5) * r) return z.below ?? 0.15;
  return z.side ?? 0.5;
}

/** Which band, as a name — for feedback and for tests that must not re-derive it. */
export function damageZoneName(e) {
  const z = e?.def?.damageZones;
  if (!z || !player?.mesh || !e?.mesh) return null;
  const r = e.radius || 1;
  const dy = player.mesh.position.y - e.mesh.position.y;
  if (dy > (z.aboveGap ?? 1.5) * r) return 'above';
  if (dy < -(z.belowGap ?? 0.5) * r) return 'below';
  return 'side';
}

/**
 * The EXTRA a weak spot pays for being struck from above, on top of the crit
 * and on top of the band. Separate from `above` so the reward for finding a
 * spot while airborne can be tuned without moving what an ordinary top hit is
 * worth — they are two different lessons and the player learns them apart.
 */
export function hotSpotZoneBonus(e) {
  const z = e?.def?.damageZones;
  if (!z) return 1;
  return damageZoneName(e) === 'above' ? (z.hotSpotAbove ?? 1) : 1;
}
