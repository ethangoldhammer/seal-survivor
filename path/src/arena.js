import { CONFIG } from './config.js';
import { fovScale } from './systems/settings.js';

// How far below the seabed the frame may travel, in world units, and equally
// how far the seabed strip is extended down to meet it. One constant for both
// because they are the same number seen from two sides: let the camera past
// what the backdrop covers and you see the bare scene background under the
// ocean floor.
//
// HERE rather than in world.js, where it used to live, because it now has a
// third reader that cannot import world.js: updateBounds clamps the player's
// field of view against it (see below). world.js still owns both the spending
// of it — the death dive's framing — and the skirt that pays for it.
export const FLOOR_OVERSCAN = 7;

// The playfield is a vertical slice of ocean. Water surface sits at y = 0;
// positive y is air, negative y is water. Bounds are recomputed on resize so
// the surface always lands at `surfaceFromTop` of the screen height.
//
// left/right/width/top are the ARENA — where the walls and the ceiling are,
// which is what almost everything in the game means when it asks about the
// world. `frameWidth` and `frameTop` are the FRAME: what the camera sees at
// zoom 1. Anything that means "the screen" rather than "the ocean" wants the
// frame pair.
//
// THE TWO ARE NO LONGER PROPORTIONAL, and that is the point. The frame follows
// the window's aspect, because it is a rectangle of screen. The arena does
// not: it is measured off `arena.referenceAspect`, so the ocean is the same
// ocean in portrait and landscape and only the window onto it changes. See
// updateBounds for what that was costing.
//
// The FLOOR is deliberately not in that list: bounds.bottom is the frame's
// bottom edge and the arena's floor at once, because the death dive already
// spends the space below it (see FLOOR_OVERSCAN in world.js).
export const bounds = {
  left: -40,
  right: 40,
  top: 10,
  bottom: -40,
  surfaceY: 0,
  width: 80,
  height: 50,
  frameWidth: 80,
  frameTop: 10,
  // The frame's BOTTOM edge, which is only a separate number because of the
  // field-of-view setting. At fov 1 it is exactly `bottom` — the arena's floor
  // and the frame's lower edge are the same line, as they always were — and a
  // wider view is what pulls the two apart. Anything that means THE FLOOR still
  // wants `bottom`; only the camera wants this.
  frameBottom: -40,
};

// How much visible seabed sits above bounds.bottom. world.js builds the floor
// plane so its TOP edge lands exactly here (the rest of that plane is a skirt
// hanging below, covering the death dive's camera overshoot). Anything planted
// ON the floor has to agree with it, so the number lives here rather than
// being written once in the backdrop and once in whatever stands on it.
export const SEABED_HEIGHT = 1.2;

// The depth the seabed strip is DRAWN at. world.js builds the plane there; the
// spawner reads it to know how far back a creature has to be to be behind the
// floor rather than standing on it (see the deep entrance in entities/
// enemies.js). One constant rather than a -4 written in each, because the two
// are the same fact and a creature hiding at the wrong side of the floor is
// invisible in exactly the way a bug is.
export const SEABED_Z = -4;

// ...and the depth the water fill is drawn at. It spans the whole column, so
// it is the FLOOR under every hiding depth the entrance uses: a body behind
// this is not concealed by scenery, it is behind the sea itself, and it would
// appear out of nothing on the way forward into its lane. Declared next to the
// seabed for the same reason — world.js draws it, the spawner has to stay in
// front of it, and one number is the only way those two can agree.
export const WATER_FILL_Z = -5.4;

// World Y of the seabed surface — where a plant's roots or a crab's feet go.
// A function, not a constant: bounds.bottom moves on every resize.
export function seabedTopY() {
  return bounds.bottom + SEABED_HEIGHT;
}

export function updateBounds(aspect) {
  const h = CONFIG.arena.viewHeight;
  const air = h * CONFIG.arena.surfaceFromTop;

  bounds.surfaceY = 0;
  bounds.bottom = -(h - air);
  bounds.height = h;

  // The frame first — what the camera sees at zoom 1. This one IS the window's
  // aspect, and has to be: it is a rectangle of screen.
  //
  // ...times the player's field of view, which is the one term here that is a
  // preference rather than a measurement. It scales the frame about the frame's
  // OWN CENTRE, not about the water line, so widening the view shows more sky
  // and more depth in the proportion the shot was composed in — anchoring it at
  // the surface instead would slide the water line up the screen and quietly
  // undo `surfaceFromTop`.
  //
  // Clamped against what the WORLD contains rather than against a typed limit.
  // Above the frame there is arena all the way to the jump ceiling, but below
  // it there is only the seabed skirt (FLOOR_OVERSCAN, which world.js builds
  // the floor plane down to), and past that is bare scene background under the
  // ocean. So the floor is the binding constraint and the ceiling never is —
  // at the shipped 52-unit frame the skirt runs out at fov 1.27 while the
  // ceiling would allow 1.80. Derived, so raising FLOOR_OVERSCAN or the air
  // scale moves it on its own instead of leaving a stale number here.
  const halfH = h / 2;
  const centreY = air - halfH;
  const fov = Math.min(fovScale(), (centreY - (-(h - air) - FLOOR_OVERSCAN)) / halfH);
  bounds.frameWidth = h * aspect * fov;
  bounds.frameTop = centreY + halfH * fov;
  bounds.frameBottom = centreY - halfH * fov;

  // Then the walls and the ceiling, pushed out beyond it. Both cost a camera
  // that can follow, and the cinematic rig already pans and clamps in x and y
  // for the shot, so what they really cost is that the rig has somewhere to
  // go — see clampFocus in world.js.
  //
  // THE WALLS ARE MEASURED OFF A REFERENCE FRAME, NOT THE PLAYER'S. This is
  // the one line that decides whether the ocean is the same ocean on every
  // device, and it used to read `bounds.frameWidth` — the live one. That made
  // the entire playfield a function of the window's aspect ratio, and on a
  // phone that is not a subtlety: a portrait iPhone 14 Pro got a 48-unit
  // arena, landscape got 225. Under eight seal lengths wall to wall, against
  // thirty-seven. Turning the phone sideways did not re-frame the game, it
  // replaced it — every wall bounce, every off-screen spawn distance
  // (spawnEdgeX below), every crossing time and every chase geometry moved by
  // 4.7x, while the per-second spawn budgets that know nothing about the arena
  // stayed put and concentrated the same pressure into a fifth of the water.
  //
  // So the arena is now derived from `referenceAspect` — the shape the game is
  // authored and tuned at — and the player's real aspect only decides how much
  // of it is on screen. That is the camera's job, and the camera already has
  // the vocabulary for it (see cineAspectZoom in systems/cineCamera.js).
  //
  // Vertical never had this problem: viewHeight is a constant, so the water
  // has always been 41.6 deep whichever way the phone was held.
  const ref = h * (CONFIG.arena.referenceAspect || 16 / 9);
  const wide = Math.max(1, CONFIG.arena.widthScale ?? 1);
  bounds.right = (ref * wide) / 2;
  bounds.left = -bounds.right;
  bounds.width = bounds.right - bounds.left;

  // ...but a frame WIDER than the arena would show bare scene background past
  // both walls, which no amount of camera work can hide. An ultrawide window,
  // or a `widthScale` somebody has pulled down to 1, can both get there. The
  // walls give way rather than the frame, because the frame is a fact about
  // the display and the arena is a number we chose.
  if (bounds.frameWidth > bounds.width) {
    bounds.right = bounds.frameWidth / 2;
    bounds.left = -bounds.right;
    bounds.width = bounds.frameWidth;
  }

  // THE CEILING, and it is a real one: clampToArena stops the seal dead at
  // bounds.top, so this is the height a breach is allowed to reach and not a
  // decoration. `surfaceFromTop` cannot do this job — it is a share of the
  // frame, so buying air with it spends water depth one for one, and the
  // frame is only 52 units tall to begin with. A strike dash wants far more
  // sky than the frame has: measured (npm run test:gravity), straight up off a
  // 46 u/s dash now reaches 28.0 units, and more than 70 deep in a combo. It
  // was 16.4 before the air stopped applying the seal's WATER drag to a jump —
  // real air is nearly frictionless, so an honest arc goes almost twice as
  // high off the same launch, and at airScale 3 this clears it by 3.2 units.
  const tall = Math.max(1, CONFIG.arena.airScale ?? 1);
  bounds.top = air * tall;
  return bounds;
}

export function midWater() {
  return (bounds.surfaceY + bounds.bottom) / 2;
}

// The shape of the water line: two sine terms beating against each other so it
// never reads as a repeating pattern. These constants are the single source of
// truth — world.js walks the surface geometry through `surfaceHeightAt`, and
// the grid shader clips against the same numbers by injecting WAVE into its
// GLSL, so the drawn line and anything cut to it cannot drift apart.
// k3/w3/amp3 are the CHOP: a third, shorter, faster term that only appears in
// heavy weather. Weighted by `sea.chop`, which is 0 in a calm — so on a clear
// day the formula is exactly the two-term wave it has always been, and the
// storm adds to it rather than replacing it.
export const WAVE = {
  k1: 0.25, w1: 2.0,
  k2: 0.11, w2: -1.3, amp2: 0.5,
  k3: 0.63, w3: 3.4, amp3: 0.45,
};

// THE LIVE SEA STATE. `CONFIG.arena.waveAmplitude` is the calm-water baseline;
// this is what the water is actually doing right now, after the weather has
// had its say (see world.updateSurface, which is the only writer).
//
// It exists because the wave formula has FOUR copies — this one, plus a GLSL
// transcription in the water fill, the grid and the horizon fog — and every
// one of them used to read the config value independently. The moment the
// amplitude became a live number rather than a constant, four independent
// readers meant four chances to be a frame out of step, and a fill clipped to
// a different wave than the line drawn on it is a visible tear.
export const sea = {
  amp: CONFIG.arena.waveAmplitude,
  chop: 0, // 0..1, how much of the storm term is mixed in
};

export function setSeaState(amp, chop) {
  sea.amp = amp;
  sea.chop = chop;
}

// The furthest the surface can stray from the still line at the CURRENT
// settings — every term at once, all in phase. Whoever sizes geometry that has
// to contain the wave asks this rather than guessing a headroom, because the
// guess stops being right the moment a storm multiplies the amplitude.
export function maxWaveExcursion(amp = sea.amp, chop = 1) {
  return amp * (1 + WAVE.amp2 + WAVE.amp3 * chop);
}

// Where the wave is RIGHT NOW. world.updateSurface advances it and publishes it
// here once a frame; the grid and the water fill still have it pushed into their
// uniforms, because a shader can't read a module. This exists for the callers
// that aren't shaders — anything asking "is this point out of the water yet?"
// shouldn't have to have the phase handed to it from four frames of plumbing.
let waveTime = 0;

export function setWaveTime(t) {
  waveTime = t;
}

// For the readers that need the raw phase rather than a height — a shader
// uniform, in practice. Everything else should call surfaceHeightAt.
export function waveTimeNow() {
  return waveTime;
}

export function surfaceHeightAt(x, waveT = waveTime, amp = sea.amp, chop = sea.chop) {
  return bounds.surfaceY
    + Math.sin(x * WAVE.k1 + waveT * WAVE.w1) * amp
    + Math.sin(x * WAVE.k2 + waveT * WAVE.w2) * amp * WAVE.amp2
    + Math.sin(x * WAVE.k3 + waveT * WAVE.w3) * amp * WAVE.amp3 * chop;
}

// Clamp a position into the arena and reflect velocity off whichever walls it
// hit. Shared by the player and every enemy so nothing can leave the slice.
export function clampToArena(pos, vel, radius, restitution) {
  let hit = false;
  if (pos.x < bounds.left + radius) {
    pos.x = bounds.left + radius;
    if (vel && vel.x < 0) { vel.x = -vel.x * restitution; hit = true; }
  } else if (pos.x > bounds.right - radius) {
    pos.x = bounds.right - radius;
    if (vel && vel.x > 0) { vel.x = -vel.x * restitution; hit = true; }
  }
  if (pos.y < bounds.bottom + radius) {
    pos.y = bounds.bottom + radius;
    if (vel && vel.y < 0) { vel.y = -vel.y * restitution; hit = true; }
  } else if (pos.y > bounds.top - radius) {
    pos.y = bounds.top - radius;
    if (vel && vel.y > 0) { vel.y = -vel.y * restitution; hit = true; }
  }
  return hit;
}

export function isUnderwater(y) {
  return y < bounds.surfaceY;
}

// How deep `y` is as a 0..1 fraction: 0 at (or above) the surface, 1 at the
// seabed. Shared by everything that fades with depth — the music filter and
// the SFX bus filter both ride this curve but clamp it to their own frequency
// range, so they share the geometry without having to share a sound.
export function depthFraction(y) {
  const span = Math.max(0.001, bounds.surfaceY - bounds.bottom);
  const depth = Math.max(0, bounds.surfaceY - y);
  return Math.max(0, Math.min(1, depth / span));
}

// Keep sea creatures in the water rather than flopping into the sky.
export function clampBelowSurface(pos, radius) {
  const ceiling = bounds.surfaceY - radius;
  if (pos.y > ceiling) pos.y = ceiling;
  if (pos.y < bounds.bottom + radius) pos.y = bounds.bottom + radius;
  if (pos.x < bounds.left + radius) pos.x = bounds.left + radius;
  if (pos.x > bounds.right - radius) pos.x = bounds.right - radius;
}
