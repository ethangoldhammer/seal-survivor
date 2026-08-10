import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { surfaceHeightAt, waveTimeNow, sea, bounds, WAVE } from '../arena.js';

// One draw call for every particle in the game.
//
// The whole simulation lives in the vertex shader: each point stores an origin,
// a velocity, a drag coefficient and a spawn time, and its position is solved
// analytically from age. The CPU only writes attributes when a burst is emitted,
// so thousands of particles cost almost nothing per frame.

// --- the current ------------------------------------------------------------
// Everything in this game happens underwater, and until now nothing in a burst
// knew that: particles flew ballistic arcs, slowed by drag, in perfectly
// straight lines. Real debris in water doesn't — it gets taken by whatever the
// water is doing. TURBULENCE is one field covering the whole arena that every
// particle is pushed by, so two bursts going off next to each other bend the
// same way and read as being in the same body of water.
//
// The field is the curl of a sum of sines: each component depends only on the
// OTHER axis, which makes it divergence-free by construction. That is what
// separates "liquid" from "wobble" — a divergence-free field can only swirl
// things around, never pile them up or pull them apart, so a cloud of
// particles caught in it shears and folds the way a cloud in water does.
//
// The JS twin of this function is `turbulenceAt` below. The two have to agree
// exactly: the CPU solves bubble positions with it to decide where a bubble
// bursts, and a pop landing off the bubble that made it is exactly the tell
// that they've drifted apart. Same reasoning as the four copies of WAVE.
const TURBULENCE_GLSL = /* glsl */ `
  vec2 turbulenceAt(vec2 p, float t) {
    return vec2(
      sin(p.y + t)        + 0.5 * sin(p.y * 2.13 - t * 1.70 + 1.3),
      sin(p.x * 1.17 - t) + 0.5 * sin(p.x * 2.47 + t * 1.10 + 4.1)
    );
  }
`;

const vertexShader = /* glsl */ `
  attribute vec3 aVelocity;
  attribute vec3 aColor;
  attribute vec2 aGravity;
  attribute float aStart;
  attribute float aLife;
  attribute float aSize;
  attribute float aDrag;
  attribute float aTurb;    // how hard the current takes this one
  attribute float aClip;    // 1 = die at the water line rather than sail through it

  uniform float uTime;
  uniform float uScale; // device pixels per world unit
  uniform vec3 uTurb;   // x = strength, y = spatial frequency, z = time scale

  // The water line, transcribed from WAVE in arena.js — see grid.js for the
  // same block and the same warning about decimal points.
  uniform float uSurfaceY;
  uniform float uWaveT;
  uniform float uWaveAmp;
  uniform float uChop;

  varying vec3 vColor;
  varying float vAlpha;

${TURBULENCE_GLSL}

  float surfaceHeightAt(float x) {
    return uSurfaceY
      + sin(x * ${WAVE.k1.toFixed(4)} + uWaveT * ${WAVE.w1.toFixed(4)}) * uWaveAmp
      + sin(x * ${WAVE.k2.toFixed(4)} + uWaveT * ${WAVE.w2.toFixed(4)}) * uWaveAmp * ${WAVE.amp2.toFixed(4)}
      + sin(x * ${WAVE.k3.toFixed(4)} + uWaveT * ${WAVE.w3.toFixed(4)}) * uWaveAmp * ${WAVE.amp3.toFixed(4)} * uChop;
  }

  void main() {
    float age = uTime - aStart;
    float t = age / max(aLife, 0.0001);
    float alive = step(0.0, age) * step(t, 1.0);

    // Closed form of velocity under linear drag, plus gravity.
    float k = max(aDrag, 0.0001);
    vec3 disp = aVelocity * ((1.0 - exp(-k * age)) / k);
    disp.xy += 0.5 * aGravity * age * age;

    vec3 pos = position + disp * alive;

    // Sampled at the BALLISTIC position, not the turbulent one: feeding the
    // displaced position back in would make the field self-advecting, which
    // has no closed form and would drift from the CPU's solve immediately.
    // Ramped by age from zero, or every burst would snap sideways on its first
    // frame — the current takes hold of debris, it doesn't kick it.
    pos.xy += turbulenceAt(pos.xy * uTurb.y, uTime * uTurb.z) * (uTurb.x * aTurb * age) * alive;

    // A bubble that reaches the surface has burst. Killing it HERE rather than
    // only in the CPU tracker is what makes that a guarantee: the tracker has a
    // budget and can be full, and anything it missed used to carry on into the
    // sky. Nothing gets past this.
    alive *= 1.0 - aClip * step(surfaceHeightAt(pos.x), pos.y);

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

// The CPU twin of TURBULENCE_GLSL. Kept next to it so a change to one is
// visibly a change to the other; the doc comment up there is the contract.
export function turbulenceAt(x, y, t) {
  return [
    Math.sin(y + t) + 0.5 * Math.sin(y * 2.13 - t * 1.70 + 1.3),
    Math.sin(x * 1.17 - t) + 0.5 * Math.sin(x * 2.47 + t * 1.10 + 4.1),
  ];
}

function turbSettings() {
  const tb = CONFIG.fx?.turbulence;
  if (!tb || tb.enabled === false) return null;
  return tb;
}

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
  attrs.aTurb = new THREE.Float32BufferAttribute(new Float32Array(capacity), 1);
  attrs.aClip = new THREE.Float32BufferAttribute(new Float32Array(capacity), 1);

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
      uTurb: { value: new THREE.Vector3(0, 0.35, 0.6) },
      uSurfaceY: { value: bounds.surfaceY },
      uWaveT: { value: 0 },
      uWaveAmp: { value: sea.amp },
      uChop: { value: sea.chop },
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
 * opts: { dirX, dirY, vx, vy, scale, glow }
 * Colour is not among them — see the palette note in CONFIG.emitters.
 */
export function emit(name, x, y, opts = {}) {
  const def = CONFIG.emitters[name];
  if (!def || !geometry) return;

  const count = Math.max(1, Math.round((def.count ?? 8) * (opts.scale ?? 1)));
  const colors = def.colors ?? [0xffffff];
  const cone = def.cone ?? 0;
  const inherit = def.inherit ?? 0;
  const baseAngle = Math.atan2(opts.dirY ?? 0, opts.dirX ?? 1);

  const tb = turbSettings();
  const turb = tb ? (def.turbulence ?? 1) : 0;
  // How much the drag of any one particle is allowed to differ from the
  // emitter's figure. Water is not uniform and neither is what's thrown
  // through it: at 0 a burst is a rigid shell of particles all stopping on the
  // same frame, and every value above it spreads that stop out — the light
  // bits stall in the water while the heavy ones punch on through. This is
  // most of what makes a burst read as being IN something rather than as a
  // sprite animation played at a position.
  const dragVary = Math.max(0, tb?.dragVary ?? 0);

  // Bubbles are killed at the water line (see the shader), but only ones that
  // were BORN under it. A puff let out mid-breach started in the air and has no
  // surface left to reach; flagging it would delete it on its first frame.
  const clipsAtSurface = (def.killAtSurface ?? !!def.surfacePop) && y < surfaceHeightAt(x);

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

    // The emitter's palette, and NOTHING else. There was a `opts.color` path
    // here that let a caller tint a burst — kills and mussel impacts used it to
    // fire in the dying creature's own colour, which sounds like it reads as
    // "that creature, hit" and in a real fight reads as the screen throwing a
    // different hue every second: magenta, lime, purple, yellow, whatever the
    // roster happened to be. The palettes below are authored per emitter as
    // one colour family each; a burst's colour says what KIND of event it was,
    // and that only works if it is the only thing saying it.
    color.set(colors[(Math.random() * colors.length) | 0]);
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
    // Clamped above zero: a drag of 0 is a particle that never slows, and the
    // closed form divides by it.
    const drag = Math.max(0.05, rand(def.drag, 2) * (1 + (Math.random() * 2 - 1) * dragVary));
    attrs.aStart.array[idx] = clock;
    attrs.aLife.array[idx] = life;
    // Read BACK rather than reusing `clock`. The attribute is a Float32Array
    // and `clock` is a double, so the stored value is a rounded copy of it —
    // and the tracker below compares the two to notice a recycled slot. Kept as
    // the double, that comparison was unequal the instant `clock` stopped being
    // exactly representable, which is a second or so into any real session: the
    // bookkeeping dropped every bubble on the frame after it was emitted and no
    // bubble has burst at the surface since. The bug is invisible in a fresh
    // harness, where clock starts at 0 and every early value is exact.
    const start32 = attrs.aStart.array[idx];
    attrs.aSize.array[idx] = rand(def.size, 0.15);
    attrs.aDrag.array[idx] = drag;
    attrs.aTurb.array[idx] = turb;
    attrs.aClip.array[idx] = clipsAtSurface ? 1 : 0;

    // The shader kills every flagged particle at the surface no matter what;
    // this list is only about the BURST one leaves behind, which needs a
    // position on the CPU to fire from. Past the cap a bubble still dies at the
    // water line, it just goes quietly.
    if (def.surfacePop && clipsAtSurface && tracked.length < MAX_TRACKED) {
      tracked.push({
        idx,
        start: start32,
        life,
        drag,
        turb,
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
    let x = p.x + p.vx * f + 0.5 * p.gx * age * age;
    let y = p.y + p.vy * f + 0.5 * p.gy * age * age;

    // Same push the shader gives it, sampled at the same ballistic position.
    const tb = turbSettings();
    if (tb && p.turb) {
      const freq = tb.frequency ?? 0.35;
      const [tx, ty] = turbulenceAt(x * freq, y * freq, clock * (tb.timeScale ?? 0.6));
      const amt = (tb.strength ?? 0) * p.turb * age;
      x += tx * amt;
      y += ty * amt;
    }

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
  if (material) {
    const u = material.uniforms;
    u.uTime.value = clock;

    const tb = turbSettings();
    u.uTurb.value.set(
      tb ? (tb.strength ?? 0) : 0,
      tb?.frequency ?? 0.35,
      tb?.timeScale ?? 0.6,
    );

    // Read rather than pushed in from world.js: the sea state and the wave
    // phase both live in arena.js already, and one more system asking it
    // directly can't fall a frame out of step with the drawn water the way a
    // fourth plumbing route could.
    u.uSurfaceY.value = bounds.surfaceY;
    u.uWaveT.value = waveTimeNow();
    u.uWaveAmp.value = sea.amp;
    u.uChop.value = sea.chop;
  }
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
