import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';
import { weatherState } from './weather.js';

// CLOUDS — a stub, deliberately.
//
// There is no cloud LAYER here: no sprites, no shapes, no shadows on the
// water. What there is, is a two-octave noise field over the sky band that
// darkens as a storm builds and scrolls with the wind. From a distance that
// reads as overcast, which is all a first pass has to do — and it costs one
// transparent quad.
//
// It reads the same two numbers as everything else in the weather system
// (weatherState.intensity and .wind) and nothing else, so when real clouds
// arrive they slot in beside this rather than replacing it: this becomes the
// haze underneath them, and anything new reads the same two numbers.
//
// The plane sizes itself off `bounds` every frame instead of being rebuilt on
// resize. It's a unit quad scaled to the air band, so there's nothing to
// rebuild — one scale and one position per frame, and no resize hook to
// forget to call.

const Z = -5.2; // in front of the sun and moon (-5.5), behind the water line

const vertexShader = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uCoverage;
  uniform float uSoftness;
  uniform vec2 uOffset;
  uniform vec2 uSpan;   // world units the quad covers, so noise stays square
  uniform float uScale;

  varying vec2 vUv;

  float hash21(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }

  // Value noise — smoothstepped bilinear interpolation between cell corners.
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  void main() {
    // Two octaves. Three would be prettier and this is a stub; the second
    // octave scrolls faster than the first, which is the cheapest way to
    // stop the field reading as one sheet sliding past.
    vec2 p = vUv * uSpan * uScale;
    float n = noise(p + uOffset) * 0.65
            + noise(p * 2.3 + uOffset * 1.7 + 11.3) * 0.35;

    // uCoverage is a threshold on that field: low and only the peaks survive
    // as wisps, high and the whole sky closes over.
    float cover = smoothstep(1.0 - uCoverage - uSoftness, 1.0 - uCoverage + uSoftness, n);

    // Thinner toward the water line. Cloud is overhead; a dark band sitting
    // right on the horizon reads as dirt on the lens.
    cover *= smoothstep(0.0, 0.45, vUv.y);

    float a = cover * uOpacity;
    if (a <= 0.002) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

export function createClouds(scene) {
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uColor: { value: new THREE.Color(0x0a1220) },
      uOpacity: { value: 0 },
      uCoverage: { value: 0.4 },
      uSoftness: { value: 0.35 },
      uOffset: { value: new THREE.Vector2(0, 0) },
      uSpan: { value: new THREE.Vector2(80, 20) },
      uScale: { value: 0.055 },
    },
    transparent: true,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  mesh.position.z = Z;
  mesh.frustumCulled = false;
  // In front of the sun and moon (-11), still behind everything in the water.
  mesh.renderOrder = -10;
  scene.add(mesh);

  const offset = new THREE.Vector2(0, 0);

  function update(dt) {
    const cfg = CONFIG.weather?.clouds;
    const on = CONFIG.weather?.enabled && cfg?.enabled;

    // `base` is the haze that's there on a clear day; the storm adds to it.
    // Both are folded in here rather than in the shader so a value of zero
    // genuinely costs nothing — the mesh goes away.
    const cover = on ? (cfg.base ?? 0) + (1 - (cfg.base ?? 0)) * weatherState.intensity : 0;
    mesh.visible = cover > 0.002;
    if (!mesh.visible) return;

    // Scrolls with the wind, and drifts slowly upward regardless, so a dead
    // calm still has weather moving in it.
    offset.x += weatherState.wind * (cfg.drift ?? 3) * (cfg.scale ?? 0.05) * dt;
    offset.y += 0.04 * (cfg.scale ?? 0.05) * dt;

    const w = bounds.width * 1.2;
    const h = Math.max(1, bounds.top - bounds.surfaceY);
    mesh.scale.set(w, h, 1);
    mesh.position.set(0, bounds.surfaceY + h / 2, Z);

    const u = material.uniforms;
    u.uSpan.value.set(w, h);
    u.uScale.value = cfg.scale ?? 0.055;
    u.uOffset.value.copy(offset);
    u.uColor.value.set(cfg.color ?? 0x0a1220);
    u.uOpacity.value = (cfg.opacity ?? 0.6) * cover;
    u.uCoverage.value = cfg.coverage ?? 0.42;
    u.uSoftness.value = Math.max(0.02, cfg.softness ?? 0.35);
  }

  return { update, mesh };
}
