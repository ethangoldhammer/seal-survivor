import * as THREE from 'three';
import { CONFIG } from '../config.js';

// Procedural Perlin noise painted onto a creature's diffuse, injected into
// three.js's own MeshStandardMaterial rather than replacing it — so the model
// keeps real lighting, shadows, the emissive map and everything else the
// standard material does. Only `diffuseColor` is touched.
//
// This exists because the seal ships no texture at all (furseal.glb has UVs
// but no image), so it renders as one flat colour. Noise gives it surface
// without anyone having to paint a map.
//
// WHY THE NOISE IS SAMPLED IN BIND-POSE OBJECT SPACE
//
// The obvious choices are both wrong here:
//   - UV space would need a sensible unwrap, and this model's is unknown.
//   - Post-skinning object space moves with the animation, so the pattern
//     swims across the body as the seal swims — the mottling would crawl
//     over the skin like it was projected from outside.
// `transformed` immediately after <begin_vertex> is the raw vertex position
// BEFORE skinning is applied, which is fixed to the mesh. Sampling there
// paints the pattern onto the seal once and it deforms with the body. Same
// reasoning as the outline shells in assets.js, which offset at the same
// point for the same reason.
//
// Genuine gradient (Perlin) noise, not the value noise used elsewhere in the
// project (systems/calamari.js, systems/garlic.js). Value noise is cheaper
// but has visible axis-aligned blockiness at low frequencies, which on a
// large smooth body is exactly where it would show.

const GLSL_NOISE = `
uniform float uNoiseSize;
uniform float uNoiseStrength;
uniform float uNoiseContrast;
uniform vec3  uNoiseColor;
varying vec3  vNoisePos;

vec3 noiseHash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

// Classic Perlin: dot each corner's random gradient with the offset to the
// sample point, then interpolate with the quintic-ish smoothstep so the
// first derivative is continuous across cell boundaries (a plain lerp shows
// the lattice as faint creases).
float perlin3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(dot(noiseHash3(i + vec3(0.0, 0.0, 0.0)), f - vec3(0.0, 0.0, 0.0)),
            dot(noiseHash3(i + vec3(1.0, 0.0, 0.0)), f - vec3(1.0, 0.0, 0.0)), u.x),
        mix(dot(noiseHash3(i + vec3(0.0, 1.0, 0.0)), f - vec3(0.0, 1.0, 0.0)),
            dot(noiseHash3(i + vec3(1.0, 1.0, 0.0)), f - vec3(1.0, 1.0, 0.0)), u.x), u.y),
    mix(mix(dot(noiseHash3(i + vec3(0.0, 0.0, 1.0)), f - vec3(0.0, 0.0, 1.0)),
            dot(noiseHash3(i + vec3(1.0, 0.0, 1.0)), f - vec3(1.0, 0.0, 1.0)), u.x),
        mix(dot(noiseHash3(i + vec3(0.0, 1.0, 1.0)), f - vec3(0.0, 1.0, 1.0)),
            dot(noiseHash3(i + vec3(1.0, 1.0, 1.0)), f - vec3(1.0, 1.0, 1.0)), u.x), u.y), u.z);
}

// Three octaves, unrolled at a fixed count on purpose: making it a uniform
// would mean recompiling the shader every time the tuner moved, and three is
// enough to break up the lattice without the top octave aliasing into noise
// at the size this renders.
float noiseFbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * perlin3(p);
    p *= 2.02;   // not exactly 2, so octave lattices don't line up
    a *= 0.5;
  }
  return v;
}
`;

// Every material this has been attached to, so a tuner change can push new
// uniform values without rebuilding anything.
const attached = new Set();

/**
 * Inject the noise into one material. Safe to call on a material that has
 * already been processed — it no-ops rather than stacking a second copy.
 */
export function attachNoiseShader(material) {
  if (!material || material.userData.__noiseAttached) return;
  // Needs a diffuseColor to modulate, which the unlit/basic materials the
  // procedural fallback shapes use do have, but the sprite path does not.
  if (!('color' in material)) return;
  material.userData.__noiseAttached = true;

  const u = {
    uNoiseSize: { value: 0.4 },
    uNoiseStrength: { value: 0.35 },
    uNoiseContrast: { value: 1.0 },
    uNoiseColor: { value: new THREE.Color(0x0a2233) },
  };
  material.userData.__noiseUniforms = u;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vNoisePos;')
      // Straight after <begin_vertex>, where `transformed` is still the
      // bind-pose position — see the note at the top of this file.
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvNoisePos = transformed;');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL_NOISE)
      // After <map_fragment>, so this modulates whatever the colour map left
      // behind rather than being overwritten by it. On a model with no map
      // that include is empty and this simply tints the flat base colour.
      .replace('#include <map_fragment>', `#include <map_fragment>
  {
    float n = noiseFbm(vNoisePos / max(0.0001, uNoiseSize));
    n = clamp(n * uNoiseContrast * 0.5 + 0.5, 0.0, 1.0);
    diffuseColor.rgb = mix(diffuseColor.rgb, uNoiseColor, uNoiseStrength * n);
  }`);
  };
  material.needsUpdate = true;
  attached.add(material);
}

/**
 * Push CONFIG.sealShader onto every attached material. Pure uniform writes —
 * no recompile, so this is safe to call from a slider's input event.
 */
export function applyNoiseSettings() {
  const cfg = CONFIG.sealShader ?? {};
  for (const m of attached) {
    const u = m.userData.__noiseUniforms;
    if (!u) continue;
    u.uNoiseSize.value = cfg.size ?? 0.4;
    // `enabled` folds into strength rather than branching in the shader:
    // one less uniform for the fragment to test per pixel, and it makes the
    // toggle fade the same way the slider does instead of popping.
    u.uNoiseStrength.value = cfg.enabled === false ? 0 : (cfg.strength ?? 0.35);
    u.uNoiseContrast.value = cfg.contrast ?? 1;
    u.uNoiseColor.value.set(cfg.color ?? 0x0a2233);
  }
}

export function noiseShaderMaterialCount() {
  return attached.size;
}
