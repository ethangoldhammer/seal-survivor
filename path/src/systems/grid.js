import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds, WAVE, sea } from '../arena.js';
import { hexMetrics, hexCorners, hexCellsIn } from './hexLattice.js';
import { touchSlots, TOUCH_SLOTS } from '../input.js';

// The backdrop grid. Every node is displaced in the vertex shader by a ring
// buffer of ripples plus a constant pull from the ship's wake, so the whole
// field breathes with what the player is doing. Nothing is simulated on the
// CPU — JS only pushes ripple positions into a uniform array.
//
// On a phone the player's own fingers are in there too: every contact shoves
// the lattice apart and lights it in a colour of its own. See CONFIG.grid
// .touchGlow, and input.js for how a finger gets its slot.

const MAX_RIPPLES = 24; // must match the shader's loop bound
// WAKE SOURCES. Slot 0 is the seal, always; the rest are HULLS — up to
// `boats.maxAlive` sailing past plus the one boat boss. The field pulls toward
// each of them, so a boat displaces the water it is sitting in instead of
// floating on a lattice that has not noticed it.
//
// Enough slots for the roster and no more: this is a per-vertex loop over the
// whole grid, so every slot is paid for on every vertex whether it holds
// anything or not. A source with zero strength contributes exactly nothing but
// still costs its iteration.
const MAX_WAKES = 6; // must match the shader's loop bound
// Same contract, for the fingers. Read from input.js rather than retyped so the
// shader loop and the slot registry cannot drift apart.
const MAX_TOUCH = TOUCH_SLOTS;

// One vec4 per source, reused in place — a fresh array every frame would be a
// new uniform upload of the whole block.
const wakes = Array.from({ length: MAX_WAKES }, () => new THREE.Vector4(0, 0, 1, 0));
// Which slots were claimed by a hull this frame — see hullWake and the sweep in
// update(). A boolean per slot rather than a count, because a hull destroyed
// mid-frame must not leave the slot behind it holding its last position.
const wakeClaims = new Array(MAX_WAKES).fill(false);
let wakeCursor = 1; // slot 0 is the seal's and is never handed out

const vertexShader = /* glsl */ `
  #define MAX_RIPPLES ${MAX_RIPPLES}
  #define MAX_TOUCH ${MAX_TOUCH}
  #define MAX_WAKES ${MAX_WAKES}

  uniform float uTime;
  uniform vec3 uRipples[MAX_RIPPLES];   // xy = origin, z = start time
  uniform vec2 uRippleParams[MAX_RIPPLES]; // x = strength, y = radius
  uniform vec4 uWake[MAX_WAKES];        // xy = source, z = radius, w = strength
  uniform vec4 uTouch[MAX_TOUCH];       // xy = world pos, z = radius, w = level
  uniform vec4 uTouchWarp;              // x = push, y = swirl, z = wave, w = spin
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

    // Every wake source, summed. The seal is slot 0 and the hulls follow it —
    // see MAX_WAKES. Unfilled slots carry a strength of zero and add nothing,
    // which is why there is no count uniform to branch on.
    for (int i = 0; i < MAX_WAKES; i++) {
      vec2 wakeDelta = pos.xy - uWake[i].xy;
      float wakeDist = length(wakeDelta) + 0.0001;
      float wakeFall = smoothstep(uWake[i].z, 0.0, wakeDist);
      disp += (wakeDelta / wakeDist) * wakeFall * uWake[i].w;
    }

    // Fingers. Two components on purpose: a radial shove that pulses outward
    // (the finger pushing the water away) and a tangential shear (the lattice
    // twisting around it). The radial part alone just makes a clean bubble —
    // it's the shear that breaks the hexes out of alignment with their
    // neighbours, which is the thing that reads as DISRUPTION rather than as
    // one more ripple. A slot with level 0 contributes exactly nothing.
    for (int i = 0; i < MAX_TOUCH; i++) {
      float level = uTouch[i].w;
      vec2 delta = pos.xy - uTouch[i].xy;
      float dist = length(delta) + 0.0001;
      vec2 dir = delta / dist;
      float fall = smoothstep(uTouch[i].z, 0.0, dist);
      float pulse = sin(dist * uTouchWarp.z - uTime * uTouchWarp.w);
      disp += (dir * pulse * uTouchWarp.x + vec2(-dir.y, dir.x) * uTouchWarp.y)
              * fall * level;
    }

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
  #define MAX_TOUCH ${MAX_TOUCH}

  uniform vec3 uColor;
  uniform vec3 uHotColor;
  uniform float uOpacity;
  uniform float uWarpGain;
  uniform float uSurfaceY;
  uniform float uWaveT;
  uniform float uWaveAmp;
  uniform float uChop;
  uniform float uClip;    // 0 = draw everywhere, 1 = water only
  uniform vec4 uTouch[MAX_TOUCH];      // xy = world pos, z = radius, w = level
  uniform vec3 uTouchColor[MAX_TOUCH]; // one hue per finger, by arrival order
  uniform vec2 uTouchGain;             // x = colour gain, y = extra opacity

  varying float vWarp;
  varying vec2 vPos;

  // Mirrors surfaceHeightAt() in arena.js. Every constant is written with a
  // decimal point — GLSL ES has no int/float coercion, so a WAVE value that
  // happened to be a whole number would otherwise fail to compile.
  float surfaceAt(float x) {
    return uSurfaceY
      + sin(x * ${WAVE.k1.toFixed(4)} + uWaveT * ${WAVE.w1.toFixed(4)}) * uWaveAmp
      + sin(x * ${WAVE.k2.toFixed(4)} + uWaveT * ${WAVE.w2.toFixed(4)}) * uWaveAmp * ${WAVE.amp2.toFixed(4)}
      + sin(x * ${WAVE.k3.toFixed(4)} + uWaveT * ${WAVE.w3.toFixed(4)}) * uWaveAmp * ${WAVE.amp3.toFixed(4)} * uChop;
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
    float alpha = uOpacity * (0.3 + heat * 0.7) * mask;

    // Per-fragment rather than per-vertex: a span is only cut into as many
    // pieces as CONFIG.grid.subdivisions asks for, so a glow evaluated at the
    // nodes would step down the line in visible blocks instead of falling off
    // smoothly. Distances are measured against the DISPLACED position, so the
    // light stays on the line the finger just shoved out of place.
    //
    // Colours ADD — two fingers overlapping give you the blend of both, which
    // is what a light does — while the opacity takes the strongest of them
    // rather than summing, so a crowded corner of the screen brightens without
    // blowing out to a white blob.
    vec3 fingerLight = vec3(0.0);
    float fingerAmt = 0.0;
    for (int i = 0; i < MAX_TOUCH; i++) {
      float d = distance(vPos, uTouch[i].xy);
      float f = smoothstep(uTouch[i].z, 0.0, d);
      f *= f; // squared, so the falloff has a hot core instead of a flat disc
      float a = f * uTouch[i].w;
      fingerLight += uTouchColor[i] * a;
      fingerAmt = max(fingerAmt, a);
    }

    gl_FragColor = vec4(
      color + fingerLight * uTouchGain.x,
      clamp(alpha + fingerAmt * uTouchGain.y * mask, 0.0, 1.0)
    );
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

// The lattice is generated across the WALLS but only up to the FRAME's top,
// never the arena ceiling. `clipAtSurface` throws away everything above the
// water line in the fragment shader, so lattice built up into the jump ceiling
// (arena.airScale) is vertices paid for and then discarded — at the shipped
// airScale 3 that is three times the air band, for nothing on screen. Width is
// different and is NOT trimmed: that is all underwater, and all drawn.
function gridRect() {
  return { left: bounds.left, right: bounds.right, top: bounds.frameTop, bottom: bounds.bottom };
}

function squarePoints(spacing, sub) {
  const pts = [];
  const { left, right, top, bottom } = gridRect();

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
  for (const cell of hexCellsIn(gridRect(), m, 0)) {
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

  // One entry per finger slot. `w` is the eased level — it rises while a finger
  // is down and falls back after it lifts, so nothing pops on or off.
  const touch = new Array(MAX_TOUCH).fill(0).map(() => new THREE.Vector4(0, 0, 1, 0));
  const touchColor = new Array(MAX_TOUCH).fill(0).map(() => new THREE.Color(0xffffff));
  const touchWarp = new THREE.Vector4(0, 0, 1, 0);
  const touchGain = new THREE.Vector2(0, 0);
  // Which finger each slot is currently showing. A slot freed and immediately
  // re-taken by another finger has to restart rather than slide its glow across
  // the screen from wherever the last one was.
  const touchOwner = new Array(MAX_TOUCH).fill(null);
  const touchPoint = new THREE.Vector3();
  // Seconds until this finger's next charge pulse. Counted down per slot rather
  // than off one global clock so two fingers charging at once don't pulse in
  // lockstep, which reads as one big event instead of two.
  const touchPulseAt = new Float32Array(MAX_TOUCH);

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
        uWake: { value: wakes },
        uTouch: { value: touch },
        uTouchColor: { value: touchColor },
        uTouchWarp: { value: touchWarp },
        uTouchGain: { value: touchGain },
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
        uChop: { value: 0 },
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

  // The fingers, resolved from screen space into the water every frame. It has
  // to be every frame, not just when a finger moves: the camera follows the
  // player, so a thumb held perfectly still is over a different piece of ocean
  // each frame, and a world position cached at touchdown would slide out from
  // under it. Slots keep their last NDC after the lift, so the fade-out stays
  // put on screen where the finger was.
  //
  // `view.charging` / `view.charge` are the strike meter, handed in by main.js
  // rather than imported. systems/strike.js pulls the whole enemy graph in
  // behind it, and the backdrop wants two numbers, not a dependency on combat.
  function updateTouch(dt, view) {
    const camera = view.camera;
    const cfg = CONFIG.grid.touchGlow ?? {};
    const fingers = cfg.fingers ?? [];
    const on = cfg.enabled !== false && !!camera;

    touchWarp.set(cfg.push ?? 0, cfg.swirl ?? 0, cfg.wave ?? 1, cfg.spin ?? 0);
    touchGain.set(cfg.gain ?? 0, cfg.alpha ?? 0);

    const knock = cfg.ripple ?? {};
    const chg = cfg.charge ?? {};

    for (let i = 0; i < MAX_TOUCH; i++) {
      const slot = touchSlots[i];
      const live = on && slot.id !== null;
      // Falls back to the last entry rather than going dark, so shortening the
      // palette in the tuner doesn't silently disable the outer fingers.
      const finger = fingers[i] ?? fingers[fingers.length - 1] ?? {};
      const u = touch[i];

      const landed = live && slot.id !== touchOwner[i];
      const lifted = !live && touchOwner[i] !== null;
      if (landed) {
        // A brand-new finger in this slot: start from nothing, wherever it
        // landed, instead of inheriting the last one's level and position.
        u.w = 0;
        touchOwner[i] = slot.id;
        touchPulseAt[i] = 0;
      }
      if (!live) touchOwner[i] = null;

      // How far into a wind-up this finger is, 0..1. Only the finger actually
      // doing it grows — the strike meter is ONE meter shared by every route
      // into it (a held trigger charges the same one), so without the per-slot
      // flag a thumb resting on the glass would swell along with it.
      const winding = live && slot.charging && !!view.charging;
      const wind = winding ? Math.min(1, Math.max(0, view.charge ?? 0)) : 0;

      // Skip the unproject once a released slot has faded out — there's nothing
      // left to place, and this is the state every slot is in most of the time.
      if (live || u.w > 0.001) {
        touchPoint.set(slot.x, slot.y, 0).unproject(camera);
        u.x = touchPoint.x;
        u.y = touchPoint.y;
        u.z = Math.max(0.001,
          (cfg.radius ?? 6) * (finger.spread ?? 1) * (1 + (chg.grow ?? 0) * wind));
      }

      // Both knocks are fired AFTER the position above is resolved, or the
      // first one of a touch would land at wherever the slot pointed last.
      if (landed) ripple(u.x, u.y, knock.strength ?? 0, knock.radius ?? 1);
      if (lifted) {
        ripple(u.x, u.y, (knock.strength ?? 0) * (knock.liftScale ?? 0), knock.radius ?? 1);
      }

      // The wind-up's own beat. Timed rather than fired on a fraction of the
      // meter so it keeps pulsing on an empty tank — the player is still
      // holding, the strike is still coming, and a backdrop that went quiet
      // exactly when the fuel ran out would read as the input being dropped.
      if (winding) {
        touchPulseAt[i] -= dt;
        if (touchPulseAt[i] <= 0) {
          ripple(u.x, u.y, (chg.pulseStrength ?? 0) * (0.35 + 0.65 * wind),
            (chg.pulseRadius ?? 1) * (0.55 + 0.45 * wind));
          const gap = (chg.pulseAt ?? 0.5) + ((chg.pulseAtFull ?? 0.15) - (chg.pulseAt ?? 0.5)) * wind;
          touchPulseAt[i] = Math.max(0.02, gap);
        }
      } else {
        touchPulseAt[i] = 0; // so the next wind-up pulses immediately
      }

      // Exponential, so it's framerate-independent — the same feel at 60 and at
      // 120. Attack is the faster of the two: a finger landing should be
      // instant, a finger lifting should trail.
      const target = live ? (finger.power ?? 1) * (1 + (chg.power ?? 0) * wind) : 0;
      const rate = live ? (cfg.attack ?? 16) : (cfg.release ?? 5);
      u.w += (target - u.w) * (1 - Math.exp(-Math.max(0, rate) * dt));
      if (!live && u.w < 0.001) u.w = 0;

      touchColor[i].set(finger.color ?? 0xffffff);
    }
  }

  function update(dt, shipPos, shipVel, view = {}) {
    clock += dt;
    if (!material) return;
    material.uniforms.uTime.value = clock;
    material.uniforms.uDecay.value = CONFIG.grid.rippleDecay;
    material.uniforms.uFreq.value = CONFIG.grid.rippleFreq;
    material.uniforms.uWavelength.value = CONFIG.grid.rippleWavelength;
    material.uniforms.uOpacity.value = CONFIG.grid.opacity;
    material.uniforms.uWarpGain.value = CONFIG.grid.warpGain;
    material.uniforms.uSurfaceY.value = bounds.surfaceY;
    // The live sea state — see the same note in water.js. The grid clips to
    // the water line too, so it has to be cut on the same curve.
    material.uniforms.uWaveAmp.value = sea.amp;
    material.uniforms.uChop.value = sea.chop;
    material.uniforms.uClip.value = CONFIG.grid.clipAtSurface ? 1 : 0;

    const speed = shipVel ? Math.hypot(shipVel.x, shipVel.y) : 0;
    wakes[0].set(
      shipPos.x,
      shipPos.y,
      CONFIG.grid.wakeRadius,
      CONFIG.grid.wakeStrength * (1 + speed * CONFIG.grid.wakeSpeedGain)
    );
    // THE HULLS. Re-published every frame by whoever owns them rather than
    // registered once: a boat is destroyed mid-frame more often than not, and a
    // registry would leave its dent in the water behind it. Anything that did
    // not claim a slot this frame is cleared here, so a source can only ever
    // persist by asserting itself.
    for (let i = 1; i < MAX_WAKES; i++) {
      if (wakeClaims[i]) wakeClaims[i] = false;
      else wakes[i].w = 0;
    }
    wakeCursor = 1;

    updateTouch(dt, view);
  }

  /**
   * A HULL DISPLACING WATER. Published every frame by whoever owns the boat —
   * systems/boats.js for the ones sailing past, systems/bossBoat.js for the
   * boss — and dropped automatically by the sweep in update() the first frame
   * nobody re-asserts it. That is deliberate rather than a registry with an
   * unregister: hulls are destroyed mid-frame constantly, and the failure mode
   * of a registry is a permanent dent in the water where a boat used to be.
   *
   * Past MAX_WAKES the extra hulls simply do not warp the field. They still
   * bubble (systems/boatWake.js is unbounded) — this is the decoration, and
   * dropping the sixth boat's share of it costs nothing anybody can see.
   *
   * @param strength signed, and NEGATIVE pulls the lattice inward toward the
   *        hull — the same convention CONFIG.grid.wakeStrength uses for the
   *        seal, and the reason a boat reads as sitting IN the water rather
   *        than as a bubble pushing it away.
   */
  function hullWake(x, y, radius, strength) {
    if (wakeCursor >= MAX_WAKES || !(radius > 0)) return;
    const i = wakeCursor++;
    wakes[i].set(x, y, radius, strength);
    wakeClaims[i] = true;
  }

  function reset() {
    for (let i = 1; i < MAX_WAKES; i++) {
      wakes[i].set(0, 0, 1, 0);
      wakeClaims[i] = false;
    }
    wakeCursor = 1;
    for (let i = 0; i < MAX_RIPPLES; i++) rippleParams[i].set(0, 1);
    cursor = 0;
    for (let i = 0; i < MAX_TOUCH; i++) {
      touch[i].set(0, 0, 1, 0);
      touchOwner[i] = null;
      touchPulseAt[i] = 0;
    }
  }

  build();
  reset();

  return { build, dispose, ripple, hullWake, update, reset, setWaveTime };
}
