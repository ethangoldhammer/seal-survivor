import * as THREE from 'three';
import { CONFIG } from '../config.js';

// One draw call for every particle in the game.
//
// The whole simulation lives in the vertex shader: each point stores an origin,
// a velocity, a drag coefficient and a spawn time, and its position is solved
// analytically from age. The CPU only writes attributes when a burst is emitted,
// so thousands of particles cost almost nothing per frame.

const vertexShader = /* glsl */ `
  attribute vec3 aVelocity;
  attribute vec3 aColor;
  attribute vec2 aGravity;
  attribute float aStart;
  attribute float aLife;
  attribute float aSize;
  attribute float aDrag;

  uniform float uTime;
  uniform float uScale; // device pixels per world unit

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float age = uTime - aStart;
    float t = age / max(aLife, 0.0001);
    float alive = step(0.0, age) * step(t, 1.0);

    // Closed form of velocity under linear drag, plus gravity.
    float k = max(aDrag, 0.0001);
    vec3 disp = aVelocity * ((1.0 - exp(-k * age)) / k);
    disp.xy += 0.5 * aGravity * age * age;

    vec3 pos = position + disp * alive;
    // Park dead points outside the frustum so they never rasterise.
    pos.z -= (1.0 - alive) * 100000.0;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);

    float fade = 1.0 - t;
    vColor = aColor;
    vAlpha = alive * clamp(fade, 0.0, 1.0);
    gl_PointSize = aSize * uScale * (0.35 + 0.65 * clamp(fade, 0.0, 1.0)) * alive;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = dot(uv, uv);
    if (d > 0.25) discard;
    float edge = smoothstep(0.25, 0.0, d);
    gl_FragColor = vec4(vColor, vAlpha * edge);
  }
`;

let points = null;
let material = null;
let geometry = null;
let capacity = 0;
let cursor = 0;
let clock = 0;

const attrs = {};

export function initParticles(scene) {
  disposeParticles(scene);

  capacity = Math.max(64, Math.floor(CONFIG.fx.maxParticles));
  geometry = new THREE.BufferGeometry();

  attrs.position = new THREE.Float32BufferAttribute(new Float32Array(capacity * 3), 3);
  attrs.aVelocity = new THREE.Float32BufferAttribute(new Float32Array(capacity * 3), 3);
  attrs.aColor = new THREE.Float32BufferAttribute(new Float32Array(capacity * 3), 3);
  attrs.aGravity = new THREE.Float32BufferAttribute(new Float32Array(capacity * 2), 2);
  attrs.aStart = new THREE.Float32BufferAttribute(new Float32Array(capacity), 1);
  attrs.aLife = new THREE.Float32BufferAttribute(new Float32Array(capacity), 1);
  attrs.aSize = new THREE.Float32BufferAttribute(new Float32Array(capacity), 1);
  attrs.aDrag = new THREE.Float32BufferAttribute(new Float32Array(capacity), 1);

  for (const [name, attr] of Object.entries(attrs)) {
    attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attr);
  }

  // Everything starts long dead.
  for (let i = 0; i < capacity; i++) attrs.aStart.array[i] = -1e9;

  material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uScale: { value: 40 },
    },
  });

  points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 10;
  scene.add(points);
}

export function disposeParticles(scene) {
  if (!points) return;
  scene.remove(points);
  geometry.dispose();
  material.dispose();
  points = null;
  geometry = null;
  material = null;
}

// Points are sized in pixels, so the world-to-pixel ratio has to follow the
// orthographic camera and the canvas size.
export function updateParticleScale(camera, renderer) {
  if (!material) return;
  // Divided by `zoom`, or a camera punch-in (see world.js) leaves the sprites
  // at their un-zoomed pixel size while everything drawn as geometry around
  // them grows — particles visibly shrinking on the frame the screen punches.
  const viewHeight = (camera.top - camera.bottom) / (camera.zoom || 1);
  if (viewHeight <= 0) return;
  material.uniforms.uScale.value = renderer.domElement.height / viewHeight;
}

function rand(range, fallback) {
  if (!range) return fallback;
  if (typeof range === 'number') return range;
  return range[0] + Math.random() * (range[1] - range[0]);
}

/**
 * Fire a named burst from CONFIG.emitters.
 * opts: { dirX, dirY, vx, vy, scale, color }
 */
export function emit(name, x, y, opts = {}) {
  const def = CONFIG.emitters[name];
  if (!def || !geometry) return;

  const count = Math.max(1, Math.round((def.count ?? 8) * (opts.scale ?? 1)));
  const colors = def.colors ?? [0xffffff];
  const cone = def.cone ?? 0;
  const inherit = def.inherit ?? 0;
  const baseAngle = Math.atan2(opts.dirY ?? 0, opts.dirX ?? 1);

  const color = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const idx = cursor % capacity;
    cursor += 1;

    const angle = cone > 0
      ? baseAngle + (Math.random() - 0.5) * cone * 2
      : Math.random() * Math.PI * 2;
    const speed = rand(def.speed, 6);

    const p3 = idx * 3;
    const p2 = idx * 2;

    attrs.position.array[p3] = x;
    attrs.position.array[p3 + 1] = y;
    attrs.position.array[p3 + 2] = 0;

    attrs.aVelocity.array[p3] = Math.cos(angle) * speed + (opts.vx ?? 0) * inherit;
    attrs.aVelocity.array[p3 + 1] = Math.sin(angle) * speed + (opts.vy ?? 0) * inherit;
    attrs.aVelocity.array[p3 + 2] = 0;

    if (opts.color != null) {
      // A caller-supplied colour (a dying creature's own emissive) applies to
      // every particle, which on its own reads as a flat blob rather than an
      // explosion. Scattering brightness per particle restores the depth the
      // multi-colour palettes give the other emitters, while staying
      // unmistakably that one hue.
      color.set(opts.color);
      const shade = 0.65 + Math.random() * 0.7;
      color.multiplyScalar(shade);
    } else {
      color.set(colors[(Math.random() * colors.length) | 0]);
    }
    // Glow overdrive: multiplying color channels past 1.0 here is what
    // actually does something now that particles render to an HDR target —
    // bloom's bright-pass sees the true value, not a pre-clamped 1.0. Each
    // emitter has its own baseline (def.glow), and CONFIG.bloom.particleOverdrive
    // is a global multiplier on top for "way beyond threshold" on demand.
    const glow = (def.glow ?? 1) * (CONFIG.bloom?.particleOverdrive ?? 1) * (opts.glow ?? 1);
    attrs.aColor.array[p3] = color.r * glow;
    attrs.aColor.array[p3 + 1] = color.g * glow;
    attrs.aColor.array[p3 + 2] = color.b * glow;

    attrs.aGravity.array[p2] = def.gravity ? def.gravity[0] : 0;
    attrs.aGravity.array[p2 + 1] = def.gravity ? def.gravity[1] : 0;

    attrs.aStart.array[idx] = clock;
    attrs.aLife.array[idx] = rand(def.life, 0.5);
    attrs.aSize.array[idx] = rand(def.size, 0.15);
    attrs.aDrag.array[idx] = def.drag ?? 2;
  }

  for (const attr of Object.values(attrs)) attr.needsUpdate = true;
}

export function updateParticles(dt) {
  clock += dt;
  if (material) material.uniforms.uTime.value = clock;
}

export function resetParticles() {
  if (!geometry) return;
  for (let i = 0; i < capacity; i++) attrs.aStart.array[i] = -1e9;
  attrs.aStart.needsUpdate = true;
  cursor = 0;
}

export function particleCount() {
  return Math.min(cursor, capacity);
}
