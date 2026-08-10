import { CONFIG } from './config.js';

// The playfield is a vertical slice of ocean. Water surface sits at y = 0;
// positive y is air, negative y is water. Bounds are recomputed on resize so
// the surface always lands at `surfaceFromTop` of the screen height.
export const bounds = {
  left: -40,
  right: 40,
  top: 10,
  bottom: -40,
  surfaceY: 0,
  width: 80,
  height: 50,
};

// How much visible seabed sits above bounds.bottom. world.js builds the floor
// plane so its TOP edge lands exactly here (the rest of that plane is a skirt
// hanging below, covering the death dive's camera overshoot). Anything planted
// ON the floor has to agree with it, so the number lives here rather than
// being written once in the backdrop and once in whatever stands on it.
export const SEABED_HEIGHT = 1.2;

// World Y of the seabed surface — where a plant's roots or a crab's feet go.
// A function, not a constant: bounds.bottom moves on every resize.
export function seabedTopY() {
  return bounds.bottom + SEABED_HEIGHT;
}

export function updateBounds(aspect) {
  const h = CONFIG.arena.viewHeight;
  const air = h * CONFIG.arena.surfaceFromTop;

  bounds.surfaceY = 0;
  bounds.top = air;
  bounds.bottom = -(h - air);
  bounds.right = (h * aspect) / 2;
  bounds.left = -bounds.right;
  bounds.width = bounds.right - bounds.left;
  bounds.height = h;
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
