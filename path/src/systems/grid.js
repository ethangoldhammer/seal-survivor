import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds, WAVE } from '../arena.js';
import { hexMetrics, hexCorners, hexCellsIn } from './hexLattice.js';

// The backdrop grid. Every node is displaced in the vertex shader by a ring
// buffer of ripples plus a constant pull from the ship's wake, so the whole
// field breathes with what the player is doing. Nothing is simulated on the
// CPU — JS only pushes ripple positions into a uniform array.

const MAX_RIPPLES = 24; // must match the shader's loop bound

const vertexShader = /* glsl */ `
  #define MAX_RIPPLES ${MAX_RIPPLES}

  uniform float uTime;
  uniform vec3 uRipples[MAX_RIPPLES];   // xy = origin, z = start time
  uniform vec2 uRippleParams[MAX_RIPPLES]; // x = strength, y = radius
  uniform vec4 uWake;                   // xy = ship, z = radius, w = strength
  uniform float uDecay;
  uniform float uFreq;
  uniform float uWavelength;

  varying float vWarp;
  varying vec2 vPos;

  void main() {
    vec3 pos = position;
    vec2 disp = vec2(0.0);

    for (int i = 0; i < MAX_RIPPLES; i++) {
      vec2 delta = pos.xy - uRipples[i].xy;
      float dist = length(delta) + 0.0001;
      vec2 dir = delta / dist;

      float strength = uRippleParams[i].x;
      float radius = uRippleParams[i].y;
      float age = uTime - uRipples[i].z;

      float isLive = step(0.0001, strength) * step(0.0, age);
      float decay = exp(-age * uDecay);
      float wave = sin(dist * uWavelength - age * uFreq);
      float falloff = smoothstep(radius, 0.0, dist);

      disp += dir * wave * falloff * strength * decay * isLive;
    }

    vec2 wakeDelta = pos.xy - uWake.xy;
    float wakeDist = length(wakeDelta) + 0.0001;
    float wakeFall = smoothstep(uWake.z, 0.0, wakeDist);
    disp += (wakeDelta / wakeDist) * wakeFall * uWake.w;

    pos.xy += disp;
    vWarp = length(disp);
    // Post-displacement, so the surface clip cuts where the line actually ends
    // up — a ripple that throws a node into the air gets clipped with it.
    // The mesh carries no transform but a z offset, so this is world space.
    vPos = pos.xy;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

// The wave constants are injected from arena.js rather than retyped, so the
// clip line here is the same curve world.js draws the surface with.
const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uHotColor;
  uniform float uOpacity;
  uniform float uWarpGain;
  uniform float uSurfaceY;
  uniform float uWaveT;
  uniform float uWaveAmp;
  uniform float uClip;    // 0 = draw everywhere, 1 = water only

  varying float vWarp;
  varying vec2 vPos;

  // Mirrors surfaceHeightAt() in arena.js. Every constant is written with a
  // decimal point — GLSL ES has no int/float coercion, so a WAVE value that
  // happened to be a whole number would otherwise fail to compile.
  float surfaceAt(float x) {
    return uSurfaceY
      + sin(x * ${WAVE.k1.toFixed(4)} + uWaveT * ${WAVE.w1.toFixed(4)}) * uWaveAmp
      + sin(x * ${WAVE.k2.toFixed(4)} + uWaveT * ${WAVE.w2.toFixed(4)}) * uWaveAmp * ${WAVE.amp2.toFixed(4)};
  }

  void main() {
    // A narrow band rather than a hard cut: an additive hairline snapped off
    // mid-pixel crawls with the wave, and this costs nothing to avoid.
    const float FADE = 0.2;
    float surf = surfaceAt(vPos.x);
    float underwater = 1.0 - smoothstep(surf - FADE, surf, vPos.y);
    float mask = mix(1.0, underwater, uClip);
    if (mask <= 0.0) discard;

    float heat = clamp(vWarp * uWarpGain, 0.0, 1.0);
    vec3 color = mix(uColor, uHotColor, heat);
    gl_FragColor = vec4(color, uOpacity * (0.3 + heat * 0.7) * mask);
  }
`;

// Every line the grid draws goes through here, so both patterns get the same
// `subdivisions` treatment: a straight run is cut into pieces that the vertex
// shader can bend independently, otherwise a ripple only kinks the endpoints.
function pushRun(pts, x1, y1, x2, y2, sub) {
  for (let s = 0; s < sub; s++) {
    const t0 = s / sub;
    const t1 = (s + 1) / sub;
    pts.push(
      x1 + (x2 - x1) * t0, y1 + (y2 - y1) * t0, 0,
      x1 + (x2 - x1) * t1, y1 + (y2 - y1) * t1, 0
    );
  }
}

function squarePoints(spacing, sub) {
  const pts = [];
  const { left, right, top, bottom } = bounds;

  // Horizontal runs, subdivided so warped lines curve instead of kinking.
  for (let y = bottom; y <= top + 0.001; y += spacing) {
    for (let x = left; x < right - 0.001; x += spacing) {
      const span = Math.min(spacing, right - x);
      pushRun(pts, x, y, x + span, y, sub);
    }
  }
  // Vertical runs.
  for (let x = left; x <= right + 0.001; x += spacing) {
    for (let y = bottom; y < top - 0.001; y += spacing) {
      const span = Math.min(spacing, top - y);
      pushRun(pts, x, y, x, y + span, sub);
    }
  }
  return pts;
}

function hexPoints(spacing, sub) {
  const pts = [];
  const m = hexMetrics(spacing);

  // Neighbouring cells share an edge, so the same segment comes up twice as
  // the lattice is walked. Drawing it twice would double its brightness under
  // additive blending — a visible seam pattern — so edges are de-duplicated by
  // their (quantised) endpoints, orientation-independent.
  const seen = new Set();
  // hexCellsIn already overscans by a full cell on every side, which is enough
  // for a warped edge to stay off-screen — no extra margin needed here.
  for (const cell of hexCellsIn(bounds, m, 0)) {
    const corners = hexCorners(cell.x, cell.y, m.R);
    for (let k = 0; k < 6; k++) {
      const [x1, y1] = corners[k];
      const [x2, y2] = corners[(k + 1) % 6];
      const a = `${Math.round(x1 * 1e4)},${Math.round(y1 * 1e4)}`;
      const b = `${Math.round(x2 * 1e4)},${Math.round(y2 * 1e4)}`;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pushRun(pts, x1, y1, x2, y2, sub);
    }
  }
  return pts;
}

export function createGrid(scene) {
  let mesh = null;
  let material = null;
  let clock = 0;
  let cursor = 0;
  let waveT = 0; // pushed in by world.updateSurface; see setWaveTime

  const ripples = new Array(MAX_RIPPLES).fill(0).map(() => new THREE.Vector3());
  const rippleParams = new Array(MAX_RIPPLES).fill(0).map(() => new THREE.Vector2());

  function build() {
    dispose();
    if (!CONFIG.grid.enabled) return;

    const spacing = Math.max(0.5, CONFIG.grid.spacing);
    const sub = Math.max(1, Math.floor(CONFIG.grid.subdivisions));
    const pts = CONFIG.grid.pattern === 'hex'
      ? hexPoints(spacing, sub)
      : squarePoints(spacing, sub);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));

    material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uRipples: { value: ripples },
        uRippleParams: { value: rippleParams },
        uWake: { value: new THREE.Vector4(0, 0, CONFIG.grid.wakeRadius, CONFIG.grid.wakeStrength) },
        uDecay: { value: CONFIG.grid.rippleDecay },
        uFreq: { value: CONFIG.grid.rippleFreq },
        uWavelength: { value: CONFIG.grid.rippleWavelength },
        uColor: { value: new THREE.Color(CONFIG.grid.color) },
        uHotColor: { value: new THREE.Color(CONFIG.grid.hotColor) },
        uOpacity: { value: CONFIG.grid.opacity },
        uWarpGain: { value: CONFIG.grid.warpGain },
        uSurfaceY: { value: bounds.surfaceY },
        uWaveT: { value: waveT },
        uWaveAmp: { value: CONFIG.arena.waveAmplitude },
        uClip: { value: CONFIG.grid.clipAtSurface ? 1 : 0 },
      },
    });

    mesh = new THREE.LineSegments(geometry, material);
    mesh.position.z = -4.5;
    mesh.frustumCulled = false;
    scene.add(mesh);
  }

  function dispose() {
    if (!mesh) return;
    scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
    mesh = null;
    material = null;
  }

  // The surface owns the wave clock; the grid only borrows it to know where to
  // cut. Kept off update() so the grid never has to be told twice per frame.
  function setWaveTime(t) {
    waveT = t;
    if (material) material.uniforms.uWaveT.value = t;
  }

  // Punch the grid. Called by the feedback system for every juicy event.
  function ripple(x, y, strength, radius) {
    if (!material || !strength) return;
    const slot = cursor % MAX_RIPPLES;
    cursor += 1;
    ripples[slot].set(x, y, clock);
    rippleParams[slot].set(strength, Math.max(0.1, radius));
  }

  function update(dt, shipPos, shipVel) {
    clock += dt;
    if (!material) return;
    material.uniforms.uTime.value = clock;
    material.uniforms.uDecay.value = CONFIG.grid.rippleDecay;
    material.uniforms.uFreq.value = CONFIG.grid.rippleFreq;
    material.uniforms.uWavelength.value = CONFIG.grid.rippleWavelength;
    material.uniforms.uOpacity.value = CONFIG.grid.opacity;
    material.uniforms.uWarpGain.value = CONFIG.grid.warpGain;
    material.uniforms.uSurfaceY.value = bounds.surfaceY;
    material.uniforms.uWaveAmp.value = CONFIG.arena.waveAmplitude;
    material.uniforms.uClip.value = CONFIG.grid.clipAtSurface ? 1 : 0;

    const speed = shipVel ? Math.hypot(shipVel.x, shipVel.y) : 0;
    const wake = material.uniforms.uWake.value;
    wake.set(
      shipPos.x,
      shipPos.y,
      CONFIG.grid.wakeRadius,
      CONFIG.grid.wakeStrength * (1 + speed * CONFIG.grid.wakeSpeedGain)
    );
  }

  function reset() {
    for (let i = 0; i < MAX_RIPPLES; i++) rippleParams[i].set(0, 1);
    cursor = 0;
  }

  build();
  reset();

  return { build, dispose, ripple, update, reset, setWaveTime };
}
