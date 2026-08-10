import * as THREE from 'three';
import { createVisual } from '../assets.js';
import { seabedTopY } from '../arena.js';

// Hand-placed scenery that stands on the seabed. No behaviour, no per-frame
// cost — plant it once and it is part of the backdrop.
//
// This exists because "add the model at the seabed height" is wrong in three
// separate ways, each of which fails quietly rather than loudly:
//
//   THE ORIGIN IS NOT THE BASE. assets.js recentres every model on its
//   area-weighted centroid (see computeCentroid), not on its bounding box and
//   not on its feet. The grass GLB is authored with its blade bases at y=0,
//   and by the time createVisual hands it back the origin has moved 44% of
//   the way up the clump. Setting position.y to the floor height buries the
//   bottom half. The offset is not a constant anyone can write down either —
//   it depends on `fit`, on the centroid, and on any size multiplier — so
//   this measures the object it was actually given instead of trusting a
//   number.
//
//   THE SEABED MOVES — but not when you would guess. updateBounds derives
//   bounds.bottom from CONFIG.arena.viewHeight and surfaceFromTop, and takes
//   only left/right from the aspect ratio, so dragging the window leaves the
//   floor exactly where it was. What strands decor is the TUNER: moving
//   arena.viewHeight shifts the floor by whole world units (measured: a 1.25x
//   viewHeight drops it from -40.4 to -50.8) while anything planted on it
//   hangs in the water at the old height. That path calls world.resize()
//   directly and never fires a window resize event, which is why main.js has
//   to call reseatDecor there by hand.
//
//   THE MODEL CACHE STARTS EMPTY. createVisual before preloadAssets resolves
//   silently returns the procedural fallback shape — a green cone, in the
//   grass's case. main.js has the scar tissue on this one: the eel companion
//   and beluga drone only appeared once you nudged their size slider. Plant
//   from inside boot(), after the await.
//
// Deliberately added to world.scene rather than to the backdrop group: the
// backdrop is disposed and rebuilt wholesale on every resize (world.js
// disposeBackdrop), which would take the geometry and materials with it.

const planted = [];

/**
 * Stand one piece of decor on the seabed.
 *
 * @param {THREE.Scene} scene   world.scene — NOT the backdrop group
 * @param {string} key          an ASSETS key, e.g. 'grass'
 * @param {object} opts
 *   x      world X to plant at
 *   z      depth. The seabed plane is at z=-4 and the play area at z=0, so
 *          something between reads as sitting on the floor behind the action.
 *   scale  multiplier on top of the asset's own `fit`
 *   sink   world units to push below the surface, for bedding a clump in
 *   flip   mirror on X, so repeats of one model don't read as photocopies
 */
export function plantDecor(scene, key, { x = 0, z = -3.5, scale = 1, sink = 0, flip = false } = {}) {
  const object = createVisual(key);
  if (scale !== 1) object.scale.multiplyScalar(scale);
  if (flip) object.scale.x *= -1;
  object.position.set(x, 0, z);

  const entry = { object, sink };
  planted.push(entry);
  seat(entry);
  scene.add(object);
  return object;
}

// Measure where the base actually is, then lift the object so it lands on the
// floor. Done with the object's own world matrix rather than the asset's
// declared size, so it stays right through fit changes, size multipliers and
// the flip above.
function seat(entry) {
  const { object } = entry;
  object.position.y = 0;
  object.updateMatrixWorld(true);
  // With the origin at y=0, box.min.y IS the signed distance from origin to
  // the lowest point — negative for anything whose origin sits inside it.
  const baseOffset = new THREE.Box3().setFromObject(object).min.y;
  object.position.y = seabedTopY() - baseOffset - entry.sink;
}

/**
 * Re-plant everything at the current seabed height. Call after anything that
 * moves bounds.bottom.
 */
export function reseatDecor() {
  for (const entry of planted) seat(entry);
}

/** Remove every planted piece — used when tearing a run down. */
export function clearDecor() {
  for (const { object } of planted) object.parent?.remove(object);
  planted.length = 0;
}

// Belt and braces. A window resize does not currently move the floor (see the
// note above), so this is a no-op today and is here so it stays correct if
// bounds.bottom ever does start depending on the aspect. The path that really
// matters is main.js's tuner handler. world.js registers its own resize
// listener when the world is built, strictly before the first plantDecor call
// — models have to load first — and listeners fire in registration order, so
// bounds is already current by the time this runs.
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('resize', reseatDecor);
}
