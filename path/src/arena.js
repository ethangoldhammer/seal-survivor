import { CONFIG } from './config.js';

// The playfield is a vertical slice of ocean. Water surface sits at y = 0;
// positive y is air, negative y is water. Bounds are recomputed on resize so
// the surface always lands at `surfaceFromTop` of the screen height.
//
// left/right/width/top are the ARENA — where the walls and the ceiling are,
// which is what almost everything in the game means when it asks about the
// world. `frameWidth` and `frameTop` are the FRAME: what the camera sees at
// zoom 1. They were the same numbers until `arena.widthScale` / `airScale`,
// and are still equal at 1; above that the arena is bigger than the frame and
// the camera pans across the difference. Anything that means "the screen"
// rather than "the ocean" wants the frame pair.
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

  // The frame first — what the camera sees at zoom 1.
  bounds.frameWidth = h * aspect;
  bounds.frameTop = air;

  // Then the walls and the ceiling, pushed out beyond it. Both cost a camera
  // that can follow, and the cinematic rig already pans and clamps in x and y
  // for the shot, so what they really cost is that the rig has somewhere to
  // go — see clampFocus in world.js.
  const wide = Math.max(1, CONFIG.arena.widthScale ?? 1);
  bounds.right = (bounds.frameWidth * wide) / 2;
  bounds.left = -bounds.right;
  bounds.width = bounds.right - bounds.left;

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
