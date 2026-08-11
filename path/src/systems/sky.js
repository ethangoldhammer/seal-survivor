import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { skyLight } from './daylight.js';
import { STAR_FIELD_GLSL } from './starField.js';

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
  varying vec2 vWorldPos;

  void main() {
    vWorldPos = position.xy + uCenter;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  ${STAR_FIELD_GLSL}

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
  uniform float uSurfaceY;
  uniform float uAirH;

  varying vec2 vWorldPos;

  void main() {
    // Height above the water line, normalised against the FRAME's air band —
    // NOT against the plane's own uv. The plane runs all the way up to the
    // arena ceiling so there is sky to see when a strike throws the seal up
    // there (arena.airScale), and reading uv.y meant the whole two-stop ramp
    // was stretched over that ceiling: at airScale 3 the visible fifth of the
    // screen only ever showed the bottom third of the gradient, so the zenith
    // never appeared in frame and every sky washed out to its horizon colour.
    //
    // Clamped, so the air above the frame is flat zenith rather than a ramp
    // that keeps going — which is what a sky does anyway.
    float h = clamp((vWorldPos.y - uSurfaceY) / max(uAirH, 0.0001), 0.0, 1.0);
    // The curve pushes the horizon colour up the frame — a real sky keeps its
    // warm band thin and the interesting part is where it meets the zenith.
    float t = pow(h, uCurve);
    vec3 color = mix(uHorizon, uZenith, t);

    // Stars, on a jittered grid: one candidate per cell, most cells empty, the
    // survivors placed at a random point inside their own cell so the field
    // doesn't read as a lattice. Faded toward the horizon by the same t as
    // the gradient, because that's where the haze is.
    //
    // The placement is systems/starField.js — the same rule, in the same
    // numbers, that systems/constellations.js walks on the CPU to decide where
    // to hang the constellations. Those lines are strung between stars painted
    // right here, and the moment the two formulas differ they stop being.
    if (uStars > 0.001) {
      vec2 g = vWorldPos * uStarDensity;
      vec2 cell = floor(g);
      vec2 f = fract(g);
      float h = starHash21(cell);
      if (h > STAR_THRESHOLD) {
        vec2 at = starOffset(cell);
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
    color += (starHash21(gl_FragCoord.xy) - 0.5) * uDither;

    gl_FragColor = vec4(color, 1.0);
  }
`;

// Headroom above the arena ceiling for the sky plane. The ceiling is reachable
// by the camera to the unit, so a flush plane shows its own top edge the first
// time a punch or a shake lands at the top of a breach.
export const SKY_OVERSCAN = 8;

/**
 * How big the sky plane is and what its gradient is measured against — the two
 * numbers that must NOT be the same one.
 *
 * The plane spans the ARENA's air, so there is sky to see wherever the seal can
 * be thrown (arena.airScale). The gradient spans the FRAME's air, so the ramp
 * from horizon to zenith is the thing you actually look at. Tying the gradient
 * to the plane, as this did until the ceiling became independent, stretches a
 * two-stop ramp over ground that is off screen: at airScale 3 the visible fifth
 * of the sky only reached a third of the way up the gradient and every sky
 * washed out to its horizon colour.
 *
 * Pure, so the invariant is testable without a GL context.
 */
export function skyPlaneMetrics(view) {
  const airH = view.top - view.surfaceY;
  const height = airH + SKY_OVERSCAN;
  return {
    height,
    centerY: view.surfaceY + height / 2,
    // What the gradient is normalised against.
    gradientAirH: Math.max(1, view.frameTop - view.surfaceY),
  };
}

export function createSkyMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uCenter: { value: new THREE.Vector2(0, 0) },
      uZenith: { value: new THREE.Color(CONFIG.colors.sky) },
      uHorizon: { value: new THREE.Color(CONFIG.colors.sky) },
      uCurve: { value: 1.35 },
      // World-space, written by world.js on every resize. The gradient is a
      // function of the frame, the plane is a function of the arena, and these
      // two are what keep them from being the same number.
      uSurfaceY: { value: 0 },
      uAirH: { value: 1 },
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
