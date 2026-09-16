// ---------------------------------------------------------------------------
// WHERE A WORLD POINT LANDS ON THE SCREEN — one description of it, in a leaf.
//
// This lived in ui/ui.js, which is the right home for something only the UI
// layer asks. It stopped being that the moment the match wanted it too: the
// names over the seals (systems/versus.js) are DOM labels moved to where their
// animal is, and versus.js importing ui.js drags the whole UI module — the Rive
// artboard included — into the match's dependency graph, which a Node harness
// cannot even load (`Unknown file extension ".riv"`).
//
// So the arithmetic moved down here and ui.js re-exports it. Nothing that
// imported it from there had to change, and there is still exactly one copy of
// "where does this bit of ocean appear on screen" — which is the whole point:
// the toasts, the seal's floating bars, the callout's arrows and now the name
// tags all have to agree about it, and two copies agree until one is edited.
//
// Depends on three.js and on `window`, and on nothing else in the game.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

// Scratch. These run a few times a frame and have no business allocating.
const V = new THREE.Vector3();

/**
 * A world point in CSS pixels: { x, y }. Writes into a caller-owned `out`.
 *
 * The renderer canvas fills the viewport, so NDC maps straight onto the window
 * — there is no canvas offset to subtract, and adding one "for safety" would be
 * a correction for a layout the game does not have.
 */
export function worldToScreen(camera, x, y, out = { x: 0, y: 0 }) {
  V.set(x, y, 0);
  return projectToScreen(camera, V, out);
}

/** The same, from a Vector3 the caller is already holding. */
export function projectToScreen(camera, worldPos, out = { x: 0, y: 0 }) {
  V.copy(worldPos).project(camera);
  out.x = (V.x * 0.5 + 0.5) * window.innerWidth;
  out.y = (-V.y * 0.5 + 0.5) * window.innerHeight;
  return out;
}
