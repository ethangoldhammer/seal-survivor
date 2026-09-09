import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { chainPoint } from './ikChain.js';

// ---------------------------------------------------------------------------
// BUBBLES OFF THE SEAL UNDER THE CARDS.
//
// The run's seal breathes from its mouth and trails a wake off its flipper
// tips and tail (systems/bubbles.js, through entities/particles.js). That
// seal is in the game's scene, in world units, and its bubbles go into the
// one particle ring bound to that scene — behind the honeycomb scrim, where
// the level-up seal is not. This seal lives on a canvas of its own in screen
// pixels (systems/levelUpSeal.js), so it gets a ring of its own here: the
// same two emitter definitions (CONFIG.emitters.breathBubbles / wakeBubbles),
// the same spots on the animal (the rig's mouth anchor, the four flipper tips,
// points down the tail — the same picker as the run's wakeOrigin), the same
// closed-form ballistic sprite the run draws, scaled from world units into
// this canvas's pixels by the puppet's own px-per-unit.
//
// THE CADENCE IS THE POINT. Nothing bubbles while the animal hangs still, and
// three things open it up (CONFIG.levelUpSeal.bubbles):
//   moving    the wake, at a rate that ramps with the swim's speed exactly as
//             the run's does, off the tips and the tail; and the breath
//             shortens its interval by `breath.moveRate` at full speed.
//   pointing  a flipper on a card or the head looking out at the viewer: the
//             breath shortens by `breath.pointRate`, and a trickle from the
//             mouth at `point.perSecond` — a seal holding a pose is working.
//   leaving   the exit is a boost; the wake follows it off the top.
//
// A pure-enough module: create() builds the ring and the mesh (no renderer
// needed, so a Node harness can count what it emits); update() reads the
// puppet's rig and state and emits. The canvas code adds the mesh to the
// seal's scene and calls update() once a frame before drawing.
// ---------------------------------------------------------------------------

function cfg() {
  return CONFIG.levelUpSeal?.bubbles ?? {};
}

function rand(range, fallback = 1) {
  if (Array.isArray(range)) return range[0] + Math.random() * (range[1] - range[0]);
  return typeof range === 'number' ? range : fallback;
}

const VERT = /* glsl */ `
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
    float k = max(aDrag, 0.0001);
    vec3 disp = aVelocity * ((1.0 - exp(-k * age)) / k);
    disp.xy += 0.5 * aGravity * age * age;
    vec3 pos = position + disp * alive;
    // Park the dead outside the frustum so they never rasterise.
    pos.z += (1.0 - alive) * 1.0e6;
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    vColor = aColor;
    float fade = 1.0 - smoothstep(0.55, 1.0, t);
    vAlpha = alive * clamp(fade, 0.0, 1.0);
    gl_PointSize = aSize * uScale * (0.35 + 0.65 * clamp(fade, 0.0, 1.0)) * alive;
  }
`;
const FRAG = /* glsl */ `
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

/**
 * @param capacity  the ring's size — recycled oldest-first.
 */
export function createLevelUpBubbles({ capacity = 600 } = {}) {
  const geometry = new THREE.BufferGeometry();
  const attrs = {
    position: new THREE.BufferAttribute(new Float32Array(capacity * 3), 3),
    aVelocity: new THREE.BufferAttribute(new Float32Array(capacity * 3), 3),
    aColor: new THREE.BufferAttribute(new Float32Array(capacity * 3), 3),
    aGravity: new THREE.BufferAttribute(new Float32Array(capacity * 2), 2),
    aStart: new THREE.BufferAttribute(new Float32Array(capacity).fill(-1e9), 1),
    aLife: new THREE.BufferAttribute(new Float32Array(capacity).fill(1), 1),
    aSize: new THREE.BufferAttribute(new Float32Array(capacity), 1),
    aDrag: new THREE.BufferAttribute(new Float32Array(capacity).fill(1), 1),
  };
  for (const [k, a] of Object.entries(attrs)) { a.setUsage(THREE.DynamicDrawUsage); geometry.setAttribute(k, a); }
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uScale: { value: 40 } },
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 10;

  let clock = 0;
  let cursor = 0;
  let breathTimer = 0;
  let wakeCarry = 0;
  let pointCarry = 0;
  let wakeSide = 0;
  const _pt = new THREE.Vector3();
  const _tips = [];
  const _color = new THREE.Color();
  let emitted = 0; // for the harness

  function nextBreath(rate = 1) {
    const [lo, hi] = cfg().breath?.interval ?? CONFIG.bubbles?.breath?.interval ?? [1.1, 2.6];
    return rand([lo, hi]) * rate;
  }

  /**
   * One burst of an emitter, at a point in the puppet's world (px, y up).
   * `scale` is px per world unit — the emitter's speeds, sizes and gravity
   * are world numbers.
   */
  function emit(name, x, y, { dirX = 0, dirY = 1, vx = 0, vy = 0, scale = 40, count = 1, sizeMul = 1 } = {}) {
    const def = CONFIG.emitters?.[name];
    if (!def) return 0;
    const colors = def.colors ?? [0xffffff];
    const cone = def.cone ?? 0;
    const inherit = def.inherit ?? 0;
    const baseAngle = Math.atan2(dirY, dirX);
    const n = Math.max(1, Math.round((def.count ?? 4) * count));
    const g = def.gravity ?? [0, 0];
    for (let i = 0; i < n; i++) {
      const idx = cursor % capacity;
      cursor += 1;
      const angle = cone > 0 ? baseAngle + (Math.random() - 0.5) * cone * 2 : Math.random() * Math.PI * 2;
      const speed = rand(def.speed, 1) * scale;
      attrs.position.setXYZ(idx, x, y, 0);
      attrs.aVelocity.setXYZ(idx, Math.cos(angle) * speed + vx * inherit, Math.sin(angle) * speed + vy * inherit, 0);
      _color.set(colors[Math.floor(Math.random() * colors.length)]);
      const glow = Math.min(1.4, def.glow ?? 1);
      attrs.aColor.setXYZ(idx, _color.r * glow, _color.g * glow, _color.b * glow);
      attrs.aGravity.setXY(idx, g[0] * scale, g[1] * scale);
      attrs.aStart.setX(idx, clock);
      attrs.aLife.setX(idx, rand(def.life, 1));
      attrs.aSize.setX(idx, rand(def.size, 0.1) * sizeMul * (cfg().sizeMul ?? 1));
      attrs.aDrag.setX(idx, def.drag ?? 1);
    }
    for (const a of Object.values(attrs)) a.needsUpdate = true;
    emitted += n;
    return n;
  }

  // The run's wakeOrigin: a flipper tip in turn, or a point down the tail.
  function wakeOrigin(rig, wc) {
    _tips.length = 0;
    for (const m of rig.muzzles ?? []) _tips.push(m);
    if (rig.anchors?.finL) _tips.push(rig.anchors.finL);
    if (rig.anchors?.finR) _tips.push(rig.anchors.finR);
    const chain = rig.tail;
    if (chain && (_tips.length === 0 || Math.random() < (wc.tailShare ?? 0.45))) {
      const s = Math.pow(Math.random(), 1 / (1 + Math.max(0, wc.tipBias ?? 3)));
      return chainPoint(chain, s, _pt);
    }
    if (_tips.length > 0) return _tips[wakeSide++ % _tips.length];
    return rig.anchors?.tail || null;
  }

  return {
    points,
    get emitted() { return emitted; },
    get clock() { return clock; },
    /** Live bubbles, at the ring's own clock. */
    alive(now = clock) {
      let n = 0;
      for (let i = 0; i < capacity; i++) {
        const age = now - attrs.aStart.getX(i);
        if (age >= 0 && age <= attrs.aLife.getX(i)) n++;
      }
      return n;
    },
    reset() {
      clock = 0; cursor = 0; wakeCarry = 0; pointCarry = 0; emitted = 0;
      breathTimer = nextBreath();
      attrs.aStart.array.fill(-1e9);
      attrs.aStart.needsUpdate = true;
      material.uniforms.uTime.value = 0;
    },
    /**
     * @param dt         wall seconds
     * @param puppet     the level-up puppet — its rig's anchors are read
     * @param pixelRatio device pixels per CSS pixel, for the sprite size
     */
    update(dt, puppet, pixelRatio = 1) {
      clock += dt;
      material.uniforms.uTime.value = clock;
      const c = cfg();
      const st = puppet?.state;
      const rig = puppet?.rig;
      if (c.enabled === false || !st || !rig || !puppet.active) { wakeCarry = 0; pointCarry = 0; return; }
      const scale = st.scale || 1;
      material.uniforms.uScale.value = scale * pixelRatio;
      // Velocity in px/s, screen y down -> the puppet's world y up.
      const vx = st.velX; const vy = -st.velY;
      const speed = st.speed; // world units per second, as the run measures it
      const maxSpeed = Math.max(1, CONFIG.player?.maxSpeed ?? 34);
      const moving = Math.min(1, speed / maxSpeed);
      const pointing = Math.max(
        st.finGate?.reduce((m, g) => Math.max(m, g), 0) ?? 0,
        st.faceOut ?? 0,
      );

      // --- breath ---------------------------------------------------------
      const bc = c.breath ?? {};
      const mouth = rig.anchors?.mouth;
      if (bc.enabled !== false && mouth) {
        // The interval shortens with effort: `moveRate` at full speed,
        // `pointRate` while pointing, whichever is the shorter.
        const rate = Math.min(1 - (1 - (bc.moveRate ?? 0.5)) * moving, 1 - (1 - (bc.pointRate ?? 0.45)) * pointing);
        breathTimer -= dt / Math.max(0.05, rate);
        if (breathTimer <= 0) {
          breathTimer = nextBreath();
          const effort = 1 + (bc.speedScale ?? 0.35) * moving + (bc.pointScale ?? 0.3) * pointing;
          emit('breathBubbles', mouth.x, mouth.y, { dirX: 0, dirY: 1, vx, vy, scale, count: (bc.scale ?? 0.7) * effort });
        }
      }

      // --- the wake, off the tips and the tail, by speed ---------------------
      const wc = c.wake ?? {};
      const minSpeed = wc.minSpeed ?? 2.5;
      if (wc.enabled !== false && speed >= minSpeed) {
        const ramp = Math.min(1, (speed - minSpeed) / Math.max(0.01, maxSpeed - minSpeed));
        wakeCarry += (wc.perSecond ?? 26) * Math.pow(ramp, wc.curve ?? 0.6) * dt;
        let bursts = Math.floor(wakeCarry);
        wakeCarry -= bursts;
        bursts = Math.min(bursts, 4);
        const sp = Math.hypot(vx, vy);
        const dirX = sp > 1e-4 ? -vx / sp : 0;
        const dirY = sp > 1e-4 ? -vy / sp : 1;
        for (let i = 0; i < bursts; i++) {
          const from = wakeOrigin(rig, wc);
          if (!from) break;
          emit('wakeBubbles', from.x, from.y, { dirX, dirY, vx, vy, scale, count: wc.scale ?? 0.55 });
        }
      } else {
        wakeCarry = 0;
      }

      // --- pointing: a trickle from the mouth ------------------------------
      const pc = c.point ?? {};
      if (pc.enabled !== false && mouth && pointing > 0.05) {
        pointCarry += (pc.perSecond ?? 3) * pointing * dt;
        let bursts = Math.floor(pointCarry);
        pointCarry -= bursts;
        bursts = Math.min(bursts, 3);
        for (let i = 0; i < bursts; i++) {
          emit('breathBubbles', mouth.x, mouth.y, { dirX: 0, dirY: 1, vx, vy, scale, count: pc.scale ?? 0.35 });
        }
      } else {
        pointCarry = 0;
      }
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
