import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds, WAVE, sea, maxWaveExcursion } from '../arena.js';
import { skyLight } from './daylight.js';
import { weatherState } from './weather.js';

// Fog on the water line.
//
// The seam between the sky plane and the water fill is the hardest edge in the
// frame: two flat gradients meeting at a one-pixel stroke. This is a band of
// haze lying over that seam, riding the same wave curve the fill clips itself
// to and the drawn line traces, so all three agree exactly.
//
// Three things make it read as fog rather than as a gradient strip, and all
// three matter:
//
//   1. It BLENDS, it doesn't add. Premultiplied alpha, so the band partly
//      hides what is behind it and partly emits — which is what a
//      participating medium does. Pure additive light on a bright sky just
//      climbs to white and clips, and a clipped gradient is a hard edge no
//      amount of softening will remove.
//   2. Its silhouette is NOISE. The height of the fog varies along the water
//      and drifts, so the top of it is ragged. A band of even height is read
//      as a rectangle however soft its falloff is.
//   3. It is DITHERED. A wide, shallow gradient across a fifth of the screen
//      is the textbook case for 8-bit banding, and the composite is LDR with
//      no tonemapping to hide it. A little per-pixel noise below the
//      quantisation step is the whole fix.
//
// On top of that it widens, brightens and takes the sky's own colour through
// the twilights — `skyLight.twilight` peaks exactly as the sun crosses the
// line, which is when sky and sea are furthest apart in tone and the seam is
// most visible.
//
// It is not a light source and nothing reads it back; it draws over the seam
// and that is all.

const Z = -3.2; // over the water fill and the sky, just behind the drawn line

// World position out of the model matrix, NOT `position.xy + centre`. The
// backdrop's other shaders can get away with the latter because their
// geometry is built at full world size; this one is a unit quad stretched by
// its transform, so its raw `position` only ever spans +/-0.5 and every
// fragment would sample the same point of the wave — which draws the fog as
// one flat rectangle over the entire sky.
const vertexShader = /* glsl */ `
  varying vec2 vWorldPos;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPos = world.xy;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

// The wave function again, injected from the same WAVE constants as the fill
// and the grid. Every value carries a decimal point because GLSL ES will not
// coerce int to float — see the identical note in water.js.
const fragmentShader = /* glsl */ `
  uniform float uSurfaceY;
  uniform float uWaveT;
  uniform float uWaveAmp;
  uniform float uChop;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uLight;
  uniform float uUp;
  uniform float uDown;
  uniform float uFalloff;
  uniform float uNoise;
  uniform float uNoiseScale;
  uniform float uNoiseStretch;
  uniform vec2 uDrift;
  uniform float uDither;

  varying vec2 vWorldPos;

  float surfaceAt(float x) {
    return uSurfaceY
      + sin(x * ${WAVE.k1.toFixed(4)} + uWaveT * ${WAVE.w1.toFixed(4)}) * uWaveAmp
      + sin(x * ${WAVE.k2.toFixed(4)} + uWaveT * ${WAVE.w2.toFixed(4)}) * uWaveAmp * ${WAVE.amp2.toFixed(4)}
      + sin(x * ${WAVE.k3.toFixed(4)} + uWaveT * ${WAVE.w3.toFixed(4)}) * uWaveAmp * ${WAVE.amp3.toFixed(4)} * uChop;
  }

  float hash21(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  // Three octaves. Two is visibly a lattice at this scale and four costs more
  // than the difference is worth on a band this thin.
  float fbm(vec2 p) {
    return vnoise(p) * 0.55
         + vnoise(p * 2.17 + 13.7) * 0.30
         + vnoise(p * 4.41 + 47.3) * 0.15;
  }

  void main() {
    // Distance from the wave, not from a flat line — so the whole thing rides
    // the swell instead of the swell passing through it.
    float d = vWorldPos.y - surfaceAt(vWorldPos.x);

    // Sampled against that same distance, so the fog is anchored to the water
    // and rises and falls with it. Stretched hard along x: fog is made of
    // long shallow banks, and isotropic noise reads as clouds or as static.
    vec2 np = vec2(vWorldPos.x * uNoiseScale, d * uNoiseScale * uNoiseStretch) + uDrift;
    float n = fbm(np);

    // The noise perturbs the REACH rather than the density. That is what
    // gives the bank a ragged silhouette that drifts — modulating density
    // alone just makes an even band with dirt on it.
    float lift = mix(1.0, 0.35 + 1.3 * n, uNoise);
    float reach = (d >= 0.0 ? uUp : uDown) * lift;

    // Light scatters up into the air far more than it penetrates down into
    // the water, hence the two reaches; a symmetric band reads as a glowing
    // pipe laid on the sea rather than as the sea being lit.
    float k = abs(d) / max(reach, 0.0001);

    // Gaussian. No hard shoulder anywhere in it, unlike a pow() ramp, and the
    // smoothstep tail takes it to exactly zero before the quad's own edge so
    // the geometry boundary can never show.
    // Written as 1 - smoothstep(lo, hi) rather than smoothstep(hi, lo):
    // GLSL leaves smoothstep undefined when edge0 >= edge1, and while every
    // driver in practice computes the reversed ramp, "in practice" is not
    // something to rest a visual on.
    // The tail runs well PAST k = 1 rather than closing at it. Ending the
    // taper where the reach nominally ends leaves a detectable boundary in
    // the sky — soft, but findable, which is a seam. Trailing it out to 1.7
    // costs a little fill and removes the last edge in the picture.
    float density = exp(-k * k * uFalloff) * (1.0 - smoothstep(0.5, 1.7, k));
    density *= mix(0.75, 1.15, n); // and a little unevenness in the body
    if (density <= 0.0006) discard;

    // Dither, faded out where there is nothing to band. Amplitude is about a
    // quantisation step of the 8-bit composite this eventually lands in —
    // enough to break the contours, far too little to read as grain.
    density += (hash21(gl_FragCoord.xy) - 0.5) * uDither * smoothstep(0.0, 0.03, density);
    density = clamp(density, 0.0, 1.0);

    // Premultiplied alpha: rgb is already scaled by coverage, and the blend
    // is ONE / ONE_MINUS_SRC_ALPHA. With uLight == uOpacity this is exactly
    // fog — mix(background, colour, density). Pushing uLight above uOpacity
    // makes it emit as well as occlude, which is the soft glow, and it still
    // cannot blow out because the background is being attenuated in step.
    gl_FragColor = vec4(uColor * density * uLight, density * uOpacity);
  }
`;

export function createHorizonGlow(scene) {
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uSurfaceY: { value: 0 },
      uWaveT: { value: 0 },
      uWaveAmp: { value: 0.35 },
      uChop: { value: 0 },
      uColor: { value: new THREE.Color(0x6fd3ff) },
      uOpacity: { value: 0 },
      uLight: { value: 0 },
      uUp: { value: 3 },
      uDown: { value: 1.8 },
      uFalloff: { value: 3.2 },
      uNoise: { value: 0.7 },
      uNoiseScale: { value: 0.06 },
      uNoiseStretch: { value: 5 },
      uDrift: { value: new THREE.Vector2(0, 0) },
      uDither: { value: 0.014 },
    },
    transparent: true,
    depthWrite: false,
    // Premultiplied alpha. Not AdditiveBlending: additive on a bright sky
    // climbs to white and clips, and a clipped gradient has a hard edge that
    // no amount of softening in the falloff will remove.
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquation: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  mesh.position.z = Z;
  mesh.frustumCulled = false;
  // ABOVE the water fill, which is itself transparent (it clips to the wave
  // with a soft alpha edge) and therefore sorts in the transparent pass at
  // renderOrder 0. At a negative order — where the rest of the backdrop
  // sits — this drew first and the water painted straight over it, which
  // looks exactly like the fog not existing. Still below the rain (8), the
  // bolts (7) and the particles (10), and depth-testing keeps it behind any
  // creature breaching through it.
  mesh.renderOrder = 1;
  scene.add(mesh);

  const tint = new THREE.Color(); // scratch, so the mixing allocates nothing
  const drift = new THREE.Vector2(0, 0);

  /**
   * @param dt    real seconds, for the drift
   * @param waveT the surface clock, so the fog rides the same swell the fill
   *   clips to and the drawn line traces. Solved against a different wave, it
   *   slides along the water instead of sitting on it.
   */
  function update(dt, waveT) {
    const cfg = CONFIG.horizonGlow;
    mesh.visible = !!cfg?.enabled && (cfg.light ?? 0) + (cfg.opacity ?? 0) > 0;
    if (!mesh.visible) return;

    // Twilight is the whole point of the feature, so it drives four things at
    // once — how far the fog reaches, how thick it is, how much it emits, and
    // how much of the sky's own colour it takes. With the day cycle off it is
    // simply 0 and this collapses to the plain bank.
    const tw = CONFIG.dayNight?.enabled ? skyLight.twilight : 0;
    const spread = 1 + tw * (cfg.twilightSpread ?? 0);
    const boost = 1 + tw * (cfg.twilightBoost ?? 0);

    // Drifts on its own slow clock, pushed along by whatever the wind is
    // doing — so a storm visibly moves the bank rather than leaving it the
    // one still thing in a gale.
    const wind = CONFIG.weather?.enabled ? (weatherState.wind ?? 0) : 0;
    drift.x += ((cfg.drift ?? 0.02) + wind * (cfg.windDrift ?? 0.05)) * dt;
    drift.y -= (cfg.drift ?? 0.02) * 0.35 * dt;

    // Tall enough to hold the widest the fog can get — the noise can lift the
    // reach to 1.65x, and the band rides a wave that is itself moving — plus
    // margin. The gaussian is already at zero well inside this; the headroom
    // exists so the quad's edge is never anywhere near a visible value.
    const reachUp = (cfg.up ?? 3) * spread;
    const reachDown = (cfg.down ?? 2) * spread;
    const amp = sea.amp;
    // Sized for that 1.7 tail plus the noise's own 1.5x lift on the reach,
    // plus the swell it rides. The gaussian is long dead well inside this;
    // the headroom exists so the quad's edge is never near a visible value.
    const h = (reachUp + reachDown) * 2.9 + maxWaveExcursion() * 4 + 4;
    const cy = bounds.surfaceY + (reachUp - reachDown) / 2;
    const w = bounds.width * 1.2;
    mesh.scale.set(w, h, 1);
    mesh.position.set(0, cy, Z);

    const u = material.uniforms;
    u.uSurfaceY.value = bounds.surfaceY;
    u.uWaveT.value = waveT;
    u.uWaveAmp.value = amp;
    u.uChop.value = sea.chop;
    u.uUp.value = reachUp;
    u.uDown.value = reachDown;
    u.uFalloff.value = Math.max(0.2, cfg.falloff ?? 3.2);
    u.uNoise.value = cfg.noise ?? 0.7;
    u.uNoiseScale.value = cfg.noiseScale ?? 0.06;
    u.uNoiseStretch.value = Math.max(0.05, cfg.noiseStretch ?? 5);
    u.uDrift.value.copy(drift);
    u.uDither.value = cfg.dither ?? 0.014;

    // The colour is what actually dissolves the seam. Pulling the fog toward
    // the sky's own horizon band means that at sunset the haze IS the sunset
    // rather than a blue bank sitting in front of one — which is the
    // difference between softening the transition and decorating it.
    tint.set(cfg.color ?? 0x6fd3ff);
    if (CONFIG.dayNight?.enabled) {
      tint.lerp(skyLight.horizon, (cfg.skyTint ?? 0) * (1 - tw) + (cfg.twilightTint ?? 0) * tw);
    }
    u.uColor.value.copy(tint);
    u.uOpacity.value = Math.min(1, (cfg.opacity ?? 0) * boost);
    u.uLight.value = (cfg.light ?? 0) * boost;
  }

  return { update, mesh };
}
