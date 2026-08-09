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
export const WAVE = { k1: 0.25, w1: 2.0, k2: 0.11, w2: -1.3, amp2: 0.5 };

export function surfaceHeightAt(x, waveT, amp = CONFIG.arena.waveAmplitude) {
  return bounds.surfaceY
    + Math.sin(x * WAVE.k1 + waveT * WAVE.w1) * amp
    + Math.sin(x * WAVE.k2 + waveT * WAVE.w2) * amp * WAVE.amp2;
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
