// ============================================================================
// WHERE THE GRAVE BEAM IS RIGHT NOW — six numbers, and nothing else.
//
// The beam that finds a gravestone is drawn TWICE, by two systems that cannot
// see each other:
//
//   THE SHAFT   systems/water.js. The water fill already draws every light beam
//               in the game as a soft band in its own fragment shader, so the
//               aimed one is another entry in that loop rather than a second
//               implementation of a god ray with its own mesh, its own blend
//               mode and its own opinion about depth.
//   THE LANDING systems/graveBeam.js. The same band, injected into the stones'
//               materials, so the light the shaft is carrying actually lands on
//               something.
//
// They are ONE BEAM and they must agree exactly — same x, same rake, same wisp,
// same frame. A shaft that is a hand's width from the stone it is lighting is
// the most obviously wrong thing this feature could do, and neither system can
// detect it, because each one is correct on its own.
//
// WHY A MODULE OF ITS OWN rather than water.js importing the beam. graveBeam.js
// imports assets.js to reach the stones' materials, and assets.js pulls in the
// glTF and FBX loaders, the texture cache and the look pipeline. water.js is
// imported by world.js and by half the look pages, several of which have no
// business loading a model at all. This is a leaf with no imports — the same
// rule causticsGlsl.js and wispGlsl.js follow — so the two ends of one beam can
// share a number without sharing a dependency graph.
//
// WRITTEN BY ONE SYSTEM, READ BY BOTH. graveBeam.js owns the sweep and is the
// only thing that calls setGraveRay; water.js only ever reads. Kept that way
// deliberately: two writers to a shared mutable object is how the shaft ends up
// a frame behind the landing, which looks like nothing at all until somebody
// slows the sweep down.
// ============================================================================

/**
 * The live beam. A module-level object rather than a value, so both readers
 * hold the same reference and neither has to poll a getter sixty times a
 * second.
 *
 * `strength` at 0 means there is no beam — every reader is expected to check it
 * and do nothing, rather than draw a beam of zero brightness. The water's ray
 * loop in particular is a real cost per fragment and should not be paid for a
 * beam nobody can see.
 */
export const graveRay = {
  /** World x of the band's centre line, at `baseY`. */
  x: 0,
  /** The height the rake is measured FROM — the base of the stone being lit.
   *  Not a style value: see the note on the rake in systems/graveBeam.js, where
   *  measuring it from world zero instead put the beam thirteen units wide of
   *  a graveyard sitting at y = -38.8. */
  baseY: 0,
  /** 0 when nothing is being lit. Peak of the sweep's bell otherwise. */
  strength: 0,
  /** Half-width of the band in world units. */
  halfWidth: 2,
  /** Radians of lean per world unit of height above `baseY`. */
  tilt: 0.35,
  /** The beam's own clock, for the caustics and the wisp. Advances whether or
   *  not a sweep is running, so a beam fired twice over the same stone is not
   *  the same picture twice. */
  time: 0,
};

/**
 * Hand the beam its numbers for this frame. Called once per frame by
 * systems/graveBeam.js and by nothing else — see the header.
 *
 * Fields are assigned rather than the object replaced, because both readers
 * hold the reference.
 */
export function setGraveRay(next) {
  if (!next) return;
  for (const key of Object.keys(graveRay)) {
    const v = next[key];
    if (typeof v === 'number' && Number.isFinite(v)) graveRay[key] = v;
  }
}

/** No beam. What a restart and a death call, through graveBeam's own clear. */
export function clearGraveRay() {
  graveRay.strength = 0;
}
