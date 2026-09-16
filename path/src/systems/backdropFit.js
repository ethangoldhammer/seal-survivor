// ---------------------------------------------------------------------------
// WHERE THE BACKDROP'S EDGES ARE — the geometry world.js builds its flat picture
// of the ocean from, as numbers, with no three.js in the way.
//
// world.js owns the MESHES; this owns the RECTANGLES. The split exists because
// the one question worth asking about a backdrop is whether a camera can see
// past it, and that question cannot be asked of a mesh: building one needs a
// WebGLRenderer, which needs a real GL context, which a Node harness has not
// got. Before this file the seam test would have had to keep its own copy of
// `bounds.width * 1.2 + margins.side * 2`, and a copy of a number is a test
// that passes on the day the shipped number changes.
//
// So: `npm run test:seams` and world.js read the same four functions, and a
// backdrop that shrinks fails the test that says it may not.
// ---------------------------------------------------------------------------

import { CONFIG } from '../config.js';
import { bounds, maxWaveExcursion, SEABED_HEIGHT, SEABED_Z, WATER_FILL_Z, FLOOR_OVERSCAN } from '../arena.js';
import { skyPlaneMetrics } from './sky.js';
import { tunnelDepth } from './versusGoal.js';
import { versusActive } from './versusFlag.js';

/** The z the sky plane sits at — out of the water fill's band. */
export const SKY_Z = -6;

/**
 * How far the replay's camera can ever stand off what it is filming: the pool's
 * longest shot, backed off as far as poseShot's keep-in-frame dolly may take
 * it. Every overscan here is measured against this one number, because the
 * replay is the only camera in the game that stands anywhere but on the plane.
 */
export function replayStandOff() {
  const cams = CONFIG.versus?.replay?.cams ?? {};
  let dist = 0;
  for (const shot of cams.shots ?? []) dist = Math.max(dist, shot.distance ?? 0);
  return dist * Math.max(1, cams.keepDolly ?? 1.6);
}

/**
 * How much further than a run the backdrop has to reach in a MATCH, per side:
 * sideways into each goal's tunnel, and up and down for a frame that may zoom
 * out below 1 to hold both seals (CONFIG.versus.camera.zoomMin) — at zoomMin the
 * frame is 1/zoomMin of the arena tall, and the half of that past the arena's
 * own height is what would otherwise be bare background.
 *
 * ...AND THE REPLAY'S PARALLAX ON TOP. All of that is measured for the match's
 * own ORTHOGRAPHIC frame, where the backdrop sits square behind the play and its
 * edges are exactly where the frame's are. The replay is filmed by a perspective
 * camera standing off the plane (systems/replayCams.js), and its rays keep
 * spreading for the four-odd units back to the backdrop — so a shot yawed at the
 * far end of the pitch looks out past the side of a strip the game's own camera
 * could never reach the end of. Free: a wider pair of triangles, not more of
 * them, and the shaders on them are bounded by the screen either way.
 */
export function matchMargins() {
  if (!versusActive()) return { side: 0, vertical: 0 };
  const zoomMin = Math.max(0.1, Math.min(1, CONFIG.versus?.camera?.zoomMin ?? 1));
  const arenaH = bounds.top - bounds.bottom;
  const reach = replayStandOff();
  return {
    side: tunnelDepth() + 2 + reach,
    vertical: Math.max(0, (arenaH / zoomMin - arenaH) / 2) + 2 + reach,
  };
}

/** The width every upright backdrop plane is built at. */
export function backdropWidth(margins = matchMargins()) {
  return bounds.width * 1.2 + margins.side * 2;
}

/** How far below the arena floor the seabed strip hangs. */
export function seabedSkirt(margins = matchMargins()) {
  return FLOOR_OVERSCAN + 2 + margins.vertical;
}

/** How far above the still line the water fill runs, to contain the worst wave. */
export function waveHeadroom() {
  const stormAmp = CONFIG.arena.waveAmplitude * Math.max(1, CONFIG.weather?.sea?.amp ?? 1);
  return maxWaveExcursion(stormAmp, 1) + 1.5;
}

/**
 * How far out the deep shell's floor runs. The camera can stand
 * `replayStandOff` from a look-at anywhere on the pitch and from there its rays
 * graze along the shell to the horizon — so the quad is sized off the whole
 * arena plus that stand-off, with room over. Big and free rather than tight and
 * wrong: it is two triangles at any size, and an edge that comes into shot is
 * the exact bug the shell is for.
 */
export function shellReach() {
  return (bounds.width + (bounds.top - bounds.bottom) + replayStandOff()) * 4;
}

/**
 * Every surface of the backdrop as a rectangle, nearest first — which is the
 * order a ray should test them in, and the order they occlude each other in.
 *
 * `axis: 'z'` is an upright plane at that z, bounded in x and y; `axis: 'y'` is
 * the shell's floor at that y, bounded in x and z.
 */
export function backdropRects() {
  const margins = matchMargins();
  const w = backdropWidth(margins);
  const skirt = seabedSkirt(margins);
  const sky = skyPlaneMetrics(bounds);
  const reach = shellReach();
  const half = reach / 2;
  return [
    { name: 'shellFloor', axis: 'y', y: bounds.bottom + SEABED_HEIGHT, x0: -half, x1: half, z0: -half, z1: half },
    {
      name: 'seabed', axis: 'z', z: SEABED_Z,
      x0: -w / 2, x1: w / 2,
      y0: bounds.bottom - skirt, y1: bounds.bottom + SEABED_HEIGHT,
    },
    {
      name: 'water', axis: 'z', z: WATER_FILL_Z,
      x0: -w / 2, x1: w / 2,
      y0: bounds.bottom, y1: bounds.surfaceY + waveHeadroom(),
    },
    {
      name: 'sky', axis: 'z', z: SKY_Z,
      x0: -w / 2, x1: w / 2,
      // Built taller by margins.vertical and slid up by half of it, so the plane
      // grows upward only — see world.js.
      y0: sky.centerY - sky.height / 2,
      y1: sky.centerY + sky.height / 2 + margins.vertical,
    },
  ];
}
