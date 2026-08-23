import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { weatherEnabled } from './settings.js';
import { bounds, surfaceHeightAt } from '../arena.js';
import { emit } from '../entities/particles.js';

// Weather, which right now means rainstorms and nothing else.
//
// The whole system is two numbers. `weatherState.intensity` is how hard it is
// raining, 0..1; `weatherState.wind` is which way and how hard, -1..1. Every
// visual reads those and only those — the rain here, the cloud overlay in
// clouds.js, and the storm dimming the day/night light bus applies. That's the
// seam to build on: a new weather TYPE is a new state in the schedule below
// plus something that reads the numbers, and none of the existing consumers
// need to learn it exists.
//
// The schedule runs on REAL seconds and never pauses. A storm that stopped
// while the upgrade screen was open, and resumed mid-downpour on close, read
// as a bug every time.

export const weatherState = {
  intensity: 0, // 0..1, eased — what everything downstream reads
  target: 0, // where the schedule wants intensity to be
  wind: 0, // -1..1, signed
  turbulence: 0, // 0..1, how gusty it is right now
  // 0..1 SEA STATE, and deliberately not the same number as `intensity`.
  // Water has mass: a squall does not raise a swell the instant it starts
  // raining, and the sea is still heaving long after the last drop. This
  // lags the storm in both directions and much harder on the way down —
  // which is the whole reason it exists as a separate value rather than
  // everything just reading `intensity`.
  swell: 0,
  phase: 'clear', // clear | storm
  timer: 0, // seconds left in this phase
  peak: 0, // the intensity this storm tops out at
};

let windPhase = 0;

function randomBetween(a, b) {
  return a + Math.random() * Math.max(0, b - a);
}

function randomIn(range, fallback = 0) {
  if (!Array.isArray(range)) return range ?? fallback;
  return randomBetween(range[0], range[1]);
}

export function resetWeather() {
  const cfg = CONFIG.weather;
  weatherState.intensity = 0;
  weatherState.target = 0;
  weatherState.phase = 'clear';
  weatherState.timer = randomIn(cfg?.firstDelay, 60);
  weatherState.peak = 0;
  weatherState.wind = cfg?.wind?.base ?? 0;
  weatherState.turbulence = 0;
  weatherState.swell = 0;
}

/**
 * Advance the schedule. REAL seconds, same as the day clock and for the same
 * reason — the weather belongs to the world, not to the run.
 */
export function updateWeather(dt) {
  const cfg = CONFIG.weather;
  // ONE GATE, HERE, and not seven. `CONFIG.weather?.enabled` has readers in the
  // rain sheet, the clouds, the horizon fog, the lightning, the swell and the
  // day/night bus — patching the player's setting into each of them would be
  // six chances to miss one, and the one missed is a storm that half exists.
  // Everything downstream already reads `weatherState`, and everything already
  // treats intensity 0 as clear, so zeroing the state at the source turns all
  // of it off at once.
  if (!cfg?.enabled || !weatherEnabled(true)) {
    weatherState.intensity = 0;
    weatherState.target = 0;
    weatherState.turbulence = 0;
    weatherState.swell = 0;
    return;
  }

  // --- the schedule ---------------------------------------------------------
  // Skipped entirely while the intensity is pinned for tuning: the point of
  // the override is to hold a downpour still while you look at it, and a
  // schedule ticking underneath would end the storm out from under you the
  // moment you let go of the slider.
  const forced = cfg.forceIntensity;
  if (forced >= 0) {
    weatherState.target = Math.min(1, forced);
    weatherState.phase = forced > 0 ? 'storm' : 'clear';
  } else {
    weatherState.timer -= dt;
    if (weatherState.phase === 'clear') {
      weatherState.target = 0;
      if (weatherState.timer <= 0) {
        weatherState.phase = 'storm';
        weatherState.timer = randomIn(cfg.duration, 45);
        weatherState.peak = Math.min(1, randomIn(cfg.peak, 0.7));
      }
    } else {
      // The tail of the storm IS the ramp out: once there's less time left
      // than the ramp takes, the target slides to zero, so a storm always
      // ends by easing off rather than by switching off.
      const out = Math.max(0.01, cfg.rampOut);
      weatherState.target = weatherState.peak * Math.min(1, Math.max(0, weatherState.timer) / out);
      if (weatherState.timer <= 0) {
        weatherState.phase = 'clear';
        weatherState.timer = randomIn(cfg.gap, 120);
        weatherState.target = 0;
      }
    }
  }

  // Asymmetric easing — rain arrives faster than it leaves, which is both what
  // weather does and what keeps a storm from feeling like a fade.
  const rate = weatherState.target > weatherState.intensity
    ? 1 / Math.max(0.01, cfg.rampIn)
    : 1 / Math.max(0.01, cfg.rampOut);
  const step = rate * dt;
  const diff = weatherState.target - weatherState.intensity;
  weatherState.intensity += Math.abs(diff) <= step ? diff : Math.sign(diff) * step;
  weatherState.intensity = Math.max(0, Math.min(1, weatherState.intensity));

  // --- wind -----------------------------------------------------------------
  // Two slow sines at unrelated frequencies: the sum never repeats on an
  // interval anyone can perceive, which is the whole trick, and it costs two
  // sines instead of a noise table.
  const w = cfg.wind ?? {};
  const [s1, s2] = w.speed ?? [0.11, 0.29];
  windPhase += dt;
  const gust = Math.sin(windPhase * s1 * Math.PI * 2) * 0.62
    + Math.sin(windPhase * s2 * Math.PI * 2 + 1.7) * 0.38;
  // Storms blow harder, but a calm day is not dead still.
  const strength = (w.calmGust ?? 0.35) + (1 - (w.calmGust ?? 0.35)) * weatherState.intensity;
  weatherState.wind = Math.max(-1, Math.min(1, (w.base ?? 0) + gust * (w.gust ?? 0.8) * strength));
  weatherState.turbulence = Math.min(1, Math.abs(gust) * strength);

  // --- sea state ------------------------------------------------------------
  // Chases the storm, slowly, and asymmetrically: a sea gets up over tens of
  // seconds and takes minutes to lie back down. Linear rather than
  // exponential so `buildTime` and `settleTime` mean what they say — the
  // seconds to travel the whole range — instead of being time constants that
  // have to be reasoned about.
  const seaCfg = cfg.sea ?? {};
  if (seaCfg.enabled === false) {
    weatherState.swell = 0;
  } else {
    const rising = weatherState.intensity > weatherState.swell;
    const secs = Math.max(0.1, rising ? (seaCfg.buildTime ?? 25) : (seaCfg.settleTime ?? 70));
    const step = dt / secs;
    const diff = weatherState.intensity - weatherState.swell;
    weatherState.swell += Math.abs(diff) <= step ? diff : Math.sign(diff) * step;
    weatherState.swell = Math.max(0, Math.min(1, weatherState.swell));
  }
}

// ---------------------------------------------------------------------------
// RAIN
// ---------------------------------------------------------------------------
// Drawn as line segments rather than points, because a raindrop is a streak:
// two vertices per drop, the tail trailing back along the drop's own velocity,
// so the streak always points the way the drop is actually travelling and
// leans over on its own as the wind picks up. Per-vertex alpha fades the tail
// out, which is what stops a heavy shower reading as a wire fence.
//
// The pool is fixed. Spawning past capacity recycles the oldest drop, exactly
// like the particle ring buffer — a frame spike can't grow the buffer.

const rainVertex = /* glsl */ `
  attribute float aAlpha;
  varying float vAlpha;

  void main() {
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const rainFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vAlpha;

  void main() {
    gl_FragColor = vec4(uColor, vAlpha * uOpacity);
  }
`;

export function createRain(scene) {
  const cap = Math.max(64, Math.floor(CONFIG.weather?.rain?.maxDrops ?? 800));

  // x, y, vx, vy, len, seed — flat arrays rather than objects, so the whole
  // pool is six typed arrays and the update loop touches no garbage.
  const px = new Float32Array(cap);
  const py = new Float32Array(cap);
  const vx = new Float32Array(cap);
  const vy = new Float32Array(cap);
  const len = new Float32Array(cap);
  const seed = new Float32Array(cap);
  const alive = new Uint8Array(cap);

  const positions = new Float32Array(cap * 2 * 3);
  const alphas = new Float32Array(cap * 2);

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const alphaAttr = new THREE.BufferAttribute(alphas, 1).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('aAlpha', alphaAttr);
  // Nothing is alive at boot, and every dead drop's two vertices sit on top of
  // each other at the origin — a degenerate segment, which draws nothing.
  geometry.setDrawRange(0, 0);

  const material = new THREE.ShaderMaterial({
    vertexShader: rainVertex,
    fragmentShader: rainFragment,
    uniforms: {
      uColor: { value: new THREE.Color(CONFIG.weather?.rain?.color ?? 0xc6e2f5) },
      uOpacity: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
  });

  const mesh = new THREE.LineSegments(geometry, material);
  // In front of the creatures: rain falls between the camera and the ocean,
  // and putting it behind meant a downpour vanished the moment anything
  // swam past.
  mesh.position.z = 2;
  mesh.frustumCulled = false;
  // Above the creatures, below the particles (10) and impact flashes (9) —
  // rain falls in front of the ocean but must not sit on top of an explosion.
  mesh.renderOrder = 8;
  scene.add(mesh);

  let cursor = 0;
  let carry = 0; // fractional spawns carried between frames
  let clock = 0;
  let liveCount = 0;

  function spawn() {
    const cfg = CONFIG.weather.rain;
    const i = cursor % cap;
    cursor += 1;

    // Overscan the spawn band by the horizontal distance a drop can cover on
    // the way down, or a strong wind leaves a bare triangle on the windward
    // side of the screen.
    const margin = Math.abs(weatherState.wind) * cfg.drift * 1.5 + 4;
    px[i] = bounds.left - margin + Math.random() * (bounds.width + margin * 2);
    // Sown just above the FRAME. Started at the arena ceiling instead, a
    // drop would fall three times as far, live three times as long, and the
    // buffer would saturate long before the storm looked any heavier.
    py[i] = bounds.frameTop + Math.random() * 3;
    vy[i] = -randomIn(cfg.speed, 36);
    vx[i] = 0;
    len[i] = randomIn(cfg.length, 1.2);
    seed[i] = Math.random() * 100;
    // Recycling a slot that was still falling doesn't add a drop to the world,
    // it replaces one — so the live count only moves when the slot was free.
    if (!alive[i]) liveCount += 1;
    alive[i] = 1;
  }

  function kill(i) {
    if (alive[i]) liveCount -= 1;
    alive[i] = 0;
    const v = i * 6;
    // Collapse both vertices to a point. Cheaper than compacting the buffer,
    // and a zero-length segment rasterises to nothing.
    positions[v] = positions[v + 1] = positions[v + 2] = 0;
    positions[v + 3] = positions[v + 4] = positions[v + 5] = 0;
    alphas[i * 2] = 0;
    alphas[i * 2 + 1] = 0;
  }

  /**
   * @param waveT the surface animation's clock, so a drop lands on the wave it
   *              can actually see rather than on a flat y = 0.
   */
  function update(dt, waveT) {
    const cfg = CONFIG.weather?.rain;
    const on = CONFIG.weather?.enabled && cfg?.enabled && weatherState.intensity > 0.001;

    material.uniforms.uColor.value.set(cfg?.color ?? 0xc6e2f5);
    material.uniforms.uOpacity.value = (cfg?.opacity ?? 0.45) * weatherState.intensity;

    // Nothing to spawn and nothing still falling: the common case by a wide
    // margin (it is not raining most of the time), and worth skipping the
    // whole pool sweep for. Note this is `!on && !liveCount`, not `!on` —
    // when a storm ends, what's already in the air has to finish falling
    // rather than blinking out on the frame the schedule closes.
    if (!on && liveCount === 0) {
      if (mesh.visible) {
        mesh.visible = false;
        geometry.setDrawRange(0, 0);
      }
      return;
    }
    clock += dt;

    if (on) {
      // `perSecond` is a DENSITY, read as "this much rain on screen", so it
      // is scaled by how much wider than the frame the arena runs. Drops are
      // sown across the whole width but only a frame of it is ever watched,
      // so without this a widened arena (arena.widthScale) spreads the same
      // budget thinner and a downpour turns into drizzle. Bounded by `cap`
      // below either way, and a drop lives about a third of a second, so
      // there is a long way to go before the buffer is the limit.
      const spread = bounds.width / Math.max(1, bounds.frameWidth);
      carry += cfg.perSecond * spread * weatherState.intensity * dt;
      // Hard cap per frame: a tab restored after a minute in the background
      // hands us one enormous dt, and without this that frame tries to spawn
      // a minute of rain at once.
      let n = Math.min(cap, Math.floor(carry));
      carry -= n;
      while (n-- > 0) spawn();
    } else {
      carry = 0;
    }

    const drift = (cfg?.drift ?? 24) * weatherState.wind;
    const turb = (cfg?.turbulence ?? 5) * weatherState.turbulence;
    const splash = cfg?.splash && (cfg?.splashChance ?? 0) > 0;

    for (let i = 0; i < cap; i++) {
      if (!alive[i]) continue;

      // Wind is a target the drop accelerates toward, not a value assigned
      // to it — drops already falling should get pushed over by a gust, not
      // teleport sideways with it.
      const wobble = Math.sin(clock * 2.3 + seed[i]) * turb;
      vx[i] += ((drift + wobble) - vx[i]) * Math.min(1, dt * 3.5);

      px[i] += vx[i] * dt;
      py[i] += vy[i] * dt;

      const surface = surfaceHeightAt(px[i], waveT);
      if (py[i] <= surface) {
        if (splash && Math.random() < cfg.splashChance) {
          emit('rainSplash', px[i], surface, {
            dirX: vx[i] * 0.02,
            dirY: 1,
            // Heavier rain hits harder. Kept under 1 either way: this is the
            // most frequently fired emitter in the game by an order of
            // magnitude and it has to stay under everything else.
            scale: 0.5 + 0.5 * weatherState.intensity,
          });
        }
        kill(i);
        continue;
      }
      // Blown clean off the side, or fell past the frame somehow.
      if (px[i] < bounds.left - 12 || px[i] > bounds.right + 12) {
        kill(i);
        continue;
      }

      // The streak: tail one `len` back along the velocity, so it leans with
      // the wind for free instead of needing an authored tilt.
      const speed = Math.max(0.001, Math.hypot(vx[i], vy[i]));
      const tailX = px[i] - (vx[i] / speed) * len[i];
      const tailY = py[i] - (vy[i] / speed) * len[i];

      const v = i * 6;
      positions[v] = tailX;
      positions[v + 1] = tailY;
      positions[v + 2] = 0;
      positions[v + 3] = px[i];
      positions[v + 4] = py[i];
      positions[v + 5] = 0;
      alphas[i * 2] = 0;
      alphas[i * 2 + 1] = 1;
    }

    mesh.visible = liveCount > 0;
    geometry.setDrawRange(0, mesh.visible ? cap * 2 : 0);
    posAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
  }

  function reset() {
    for (let i = 0; i < cap; i++) if (alive[i]) kill(i);
    carry = 0;
    mesh.visible = false;
    geometry.setDrawRange(0, 0);
    posAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
  }

  return { update, reset, mesh };
}
