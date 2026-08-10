import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { skyLight } from './daylight.js';

// The air band above the water line, as a two-stop vertical gradient plus a
// star field. Same pattern as water.js and for the same reason: one fragment
// shader over the plane the backdrop already had, uniforms refreshed from the
// day/night light bus every frame, so scrubbing the clock (or dragging a
// colour picker) applies with no rebuild.
//
// It owns none of the colour decisions. Both stops and the brightness come
// straight off skyLight, which is where the keyframe interpolation lives —
// this file is just the surface they get painted on.

const vertexShader = /* glsl */ `
  uniform vec2 uCenter;
  varying vec2 vUv;
  varying vec2 vWorldPos;

  void main() {
    vUv = uv;
    vWorldPos = position.xy + uCenter;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform float uCurve;
  uniform float uDim;
  uniform float uFlash;
  uniform vec3 uFlashColor;
  uniform float uStars;
  uniform float uStarDensity;
  uniform float uTwinkle;
  uniform float uDither;
  uniform float uTime;

  varying vec2 vUv;
  varying vec2 vWorldPos;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  void main() {
    // uv.y is 0 at the water line and 1 at the top of the frame. The curve
    // pushes the horizon colour up the frame — a real sky keeps its warm band
    // thin and the interesting part is where it meets the zenith.
    float t = pow(clamp(vUv.y, 0.0, 1.0), uCurve);
    vec3 color = mix(uHorizon, uZenith, t);

    // Stars, on a jittered grid: one candidate per cell, most cells empty, the
    // survivors placed at a random point inside their own cell so the field
    // doesn't read as a lattice. Faded toward the horizon by the same t as
    // the gradient, because that's where the haze is.
    if (uStars > 0.001) {
      vec2 g = vWorldPos * uStarDensity;
      vec2 cell = floor(g);
      vec2 f = fract(g);
      float h = hash21(cell);
      if (h > 0.90) {
        vec2 at = vec2(hash21(cell + 1.7), hash21(cell + 3.1));
        float d = length(f - at);
        float twinkle = 1.0 - uTwinkle * 0.5 * (1.0 + sin(uTime * 1.7 + h * 62.0));
        float dot_ = smoothstep(0.14, 0.0, d) * (0.4 + 0.6 * h);
        color += vec3(0.85, 0.9, 1.0) * dot_ * uStars * max(twinkle, 0.0) * t;
      }
    }

    color *= uDim;

    // Lightning. A MIX toward the flash colour rather than a multiply, and
    // that distinction is the whole effect: a night sky is near-black, and
    // scaling near-black by any amount leaves it near-black. The sky has to
    // go pale for a moment, not merely less dark.
    color = mix(color, uFlashColor, clamp(uFlash, 0.0, 1.0));

    // Dither. This is a two-stop ramp across a fifth of the screen landing in
    // an 8-bit composite with no tonemapping — the textbook case for visible
    // contour rings, and they show worst on exactly the wide flat dusk skies
    // the keyframes are proudest of. One quantisation step of per-pixel noise
    // is the entire fix, and it is invisible at this amplitude.
    color += (hash21(gl_FragCoord.xy) - 0.5) * uDither;

    gl_FragColor = vec4(color, 1.0);
  }
`;

export function createSkyMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uCenter: { value: new THREE.Vector2(0, 0) },
      uZenith: { value: new THREE.Color(CONFIG.colors.sky) },
      uHorizon: { value: new THREE.Color(CONFIG.colors.sky) },
      uCurve: { value: 1.35 },
      uDim: { value: 1 },
      uFlash: { value: 0 },
      uFlashColor: { value: new THREE.Color(0xdce8ff) },
      uStars: { value: 0 },
      uStarDensity: { value: 0.55 },
      uTwinkle: { value: 0.7 },
      uDither: { value: 0.005 },
      uTime: { value: 0 },
    },
  });
}

// Every frame, like updateWaterMaterial. `horizon` is handed back so the
// caller can match the scene background to the band at the water line —
// nothing should ever be visible past the sky plane, but if the frame does
// slip past its edge the seam shouldn't be a different colour.
export function updateSkyMaterial(material, clock) {
  const u = material.uniforms;
  const cfg = CONFIG.dayNight;
  u.uTime.value = clock;

  if (!cfg?.enabled) {
    // The original flat sky, exactly as it was before any of this existed.
    u.uZenith.value.set(CONFIG.colors.sky);
    u.uHorizon.value.set(CONFIG.colors.sky);
    u.uDim.value = 1;
    u.uFlash.value = 0;
    u.uStars.value = 0;
    return u.uHorizon.value;
  }

  u.uZenith.value.copy(skyLight.zenith);
  u.uHorizon.value.copy(skyLight.horizon);
  u.uCurve.value = cfg.skyCurve ?? 1.35;

  // The keyframes already carry the time of day's own brightness in their
  // colours, so this is only the WEATHER's share of the dimming — applying
  // skyLight.intensity whole would darken dusk twice over.
  u.uDim.value = skyLight.clear > 0.0001 ? skyLight.intensity / skyLight.clear : 1;

  // The flash rides the light bus like everything else, so the sky doesn't
  // need to know lightning exists — only that the bus went bright.
  u.uFlash.value = skyLight.flash;
  u.uFlashColor.value.set(CONFIG.weather?.lightning?.flash?.color ?? 0xdce8ff);

  const stars = cfg.stars;
  u.uStars.value = stars?.enabled ? (stars.intensity ?? 0) * skyLight.night : 0;
  u.uStarDensity.value = stars?.density ?? 0.55;
  u.uTwinkle.value = stars?.twinkle ?? 0.7;
  u.uDither.value = CONFIG.horizonGlow?.skyDither ?? 0.005;

  return u.uHorizon.value;
}
