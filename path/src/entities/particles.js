import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { surfaceHeightAt } from '../arena.js';

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

// --- surface pops -----------------------------------------------------------
// The simulation is entirely GPU-side, so nothing on the CPU normally knows
// where a particle IS. Bubbles are the exception: one that reaches the water
// line has to burst there rather than sail on into the sky, and that needs a
// position on this side. Only emitters that ask for it (`surfacePop`, naming
// the burst to fire) are tracked, and the solve below is the same closed form
// the vertex shader uses, so the burst lands exactly where the bubble is drawn.
const tracked = [];
// A ceiling on the bookkeeping, not on the bubbles: past this, extra particles
// simply aren't followed and fade out on their own timer as they always did.
// Well above what breath and wake produce together at full tilt.
const MAX_TRACKED = 256;

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
  tracked.length = 0;
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

    const vx = Math.cos(angle) * speed + (opts.vx ?? 0) * inherit;
    const vy = Math.sin(angle) * speed + (opts.vy ?? 0) * inherit;
    attrs.aVelocity.array[p3] = vx;
    attrs.aVelocity.array[p3 + 1] = vy;
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

    const life = rand(def.life, 0.5);
    const drag = def.drag ?? 2;
    attrs.aStart.array[idx] = clock;
    attrs.aLife.array[idx] = life;
    attrs.aSize.array[idx] = rand(def.size, 0.15);
    attrs.aDrag.array[idx] = drag;

    // Spawned above the water already (a breach mid-puff) — there is no
    // surface left for it to reach, and following it would burst it instantly
    // in the air.
    if (def.surfacePop && tracked.length < MAX_TRACKED && y < surfaceHeightAt(x)) {
      tracked.push({
        idx,
        start: clock,
        life,
        drag,
        x,
        y,
        vx,
        vy,
        gx: attrs.aGravity.array[p2],
        gy: attrs.aGravity.array[p2 + 1],
        pop: def.surfacePop,
      });
    }
  }

  for (const attr of Object.values(attrs)) attr.needsUpdate = true;
}

// Solve every tracked bubble's position and burst the ones that have broken
// the surface. Mirrors the vertex shader's closed form exactly — the two
// drifting apart would show up as a pop happening off the bubble.
function updateSurfacePops() {
  if (!tracked.length) return;
  let pops = null;

  for (let i = tracked.length - 1; i >= 0; i--) {
    const p = tracked[i];
    const age = clock - p.start;
    // Slots are a ring buffer, so a busy frame can hand this one to a newer
    // burst. The spawn time is the cheapest thing that says so, and once the
    // slot has been reused the bubble we were following is gone anyway.
    if (age >= p.life || attrs.aStart.array[p.idx] !== p.start) {
      tracked[i] = tracked[tracked.length - 1];
      tracked.pop();
      continue;
    }

    const k = Math.max(p.drag, 0.0001);
    const f = (1 - Math.exp(-k * age)) / k;
    const x = p.x + p.vx * f + 0.5 * p.gx * age * age;
    const y = p.y + p.vy * f + 0.5 * p.gy * age * age;

    const surf = surfaceHeightAt(x);
    if (y < surf) continue;

    // Killed outright rather than left to fade: a bubble that has burst is
    // gone, and one still drifting up through its own spray is the tell.
    attrs.aStart.array[p.idx] = -1e9;
    attrs.aStart.needsUpdate = true;
    (pops ??= []).push({ x, y: surf, name: p.pop });
    tracked[i] = tracked[tracked.length - 1];
    tracked.pop();
  }

  // Fired after the walk, never during it: emit() writes into the same ring
  // buffer this loop reads, and a burst that recycled a slot mid-walk would be
  // indistinguishable from the bubble that slot used to hold.
  if (!pops) return;
  for (const p of pops) emit(p.name, p.x, p.y, { dirX: 0, dirY: 1 });
}

export function updateParticles(dt) {
  clock += dt;
  if (material) material.uniforms.uTime.value = clock;
  updateSurfacePops();
}

export function resetParticles() {
  if (!geometry) return;
  for (let i = 0; i < capacity; i++) attrs.aStart.array[i] = -1e9;
  attrs.aStart.needsUpdate = true;
  cursor = 0;
  tracked.length = 0;
}

export function particleCount() {
  return Math.min(cursor, capacity);
}
