import * as THREE from 'three';
import { CONFIG } from '../config.js';

// WHERE AM I POINTING — a glowing beam along the aim direction, a reticle out
// at the end of it, or both. Each half has its own enable, so this is three
// usable looks and not one: line only, reticle only, or the pair.
//
// Not to be confused with the dash corridor in the lens (see cineCamera.js).
// They answer different questions and can legitimately disagree on screen:
// this is where the GUN points (input.aim, the cursor or the right stick),
// the corridor is where a released strike would TRAVEL (halfway between the
// swim and the aim — see strikeDirection in systems/strike.js). Aiming one way
// while swimming another is normal play, and seeing both at once is the point;
// the corridor then sits between this beam and the direction of travel.
//
// The reticle sits a fixed distance along the aim rather than on the cursor.
// That is the correct model, not a shortcut: input.aim is a normalized
// DIRECTION for every input device — the mouse's world point never leaves
// input.js — and the weapons fire along that direction with no notion of
// range. A reticle parked on the mouse would therefore claim a precision the
// guns do not have, and would have nothing to sit on for a pad or a thumbstick.
//
// One quad, centred on the seal and big enough to hold whichever parts are
// switched on, with everything drawn as signed-distance work in the aim's own
// frame. Additive and depth-tested OFF: an aim indicator that a passing shark
// can hide is not doing its job.

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec2  uAim;      // normalized, world space
  uniform float uHalf;     // half-extent of this quad, in world units
  uniform float uAlpha;    // master fade

  uniform float uLineOn;
  uniform float uLineStart;   // gap between the seal and the near end
  uniform float uLineLength;
  uniform float uLineWidth;
  uniform float uLineSoft;    // 0 = hard edge, 1 = all falloff
  uniform float uLineFade;    // how much it dims toward the far end
  uniform vec3  uLineColor;
  uniform float uLineGlow;
  uniform float uDashOn;
  uniform float uDashSize;
  uniform float uDashDuty;
  uniform float uDashScroll;

  uniform float uRetOn;
  uniform float uRetDist;
  uniform float uRetRadius;
  uniform float uRetThick;
  uniform float uRetTickCount;
  uniform float uRetTickLen;
  uniform float uRetTickWidth;
  uniform float uRetDot;
  uniform float uRetSpin;
  uniform vec3  uRetColor;
  uniform float uRetGlow;

  varying vec2 vUv;

  #define TAU 6.28318530718

  void main() {
    // Into the aim's own frame: t runs along the aim, n across it. Every
    // shape below is written in that frame, which is why none of them need a
    // rotation matrix and why the whole thing works at any angle for free.
    vec2 p = (vUv - 0.5) * 2.0 * uHalf;
    vec2 f = uAim;
    vec2 s = vec2(-f.y, f.x);
    float t = dot(p, f);
    float n = dot(p, s);

    vec3 color = vec3(0.0);

    if (uLineOn > 0.5) {
      float d = t - uLineStart;
      // Across the beam: a soft core rather than a slab, so it reads as light
      // rather than as a drawn rectangle.
      float core = 1.0 - smoothstep(uLineWidth * (1.0 - uLineSoft), uLineWidth, abs(n));
      // Along it: eased on at the near end so the beam doesn't start with a
      // squared-off cap, and dimming toward the far end by uLineFade.
      float cap = smoothstep(0.0, max(uLineWidth * 2.0, 1e-4), d);
      float along = clamp(d / max(uLineLength, 1e-4), 0.0, 1.0);
      float tail = 1.0 - smoothstep(0.92, 1.0, along);
      float fade = mix(1.0, 1.0 - along, uLineFade);
      float dash = 1.0;
      if (uDashOn > 0.5) {
        // Scrolls outward, which reads as the beam flowing away from the seal
        // and is most of what makes a dashed line feel alive.
        float ph = fract((d - uDashScroll) / max(uDashSize, 1e-4));
        dash = 1.0 - smoothstep(uDashDuty, min(uDashDuty + 0.14, 1.0), ph);
      }
      float m = step(0.0, d) * core * cap * tail * fade * dash;
      color += uLineColor * m * uLineGlow;
    }

    if (uRetOn > 0.5) {
      // Same frame, origin moved out to the reticle's stand-off distance.
      vec2 q = vec2(t - uRetDist, n);
      float r = length(q);
      float ring = 1.0 - smoothstep(0.0, uRetThick, abs(r - uRetRadius));

      float ticks = 0.0;
      if (uRetTickLen > 0.0 && uRetTickCount >= 1.0) {
        float seg = TAU / uRetTickCount;
        float ang = atan(q.y, q.x) + uRetSpin;
        // Angular distance to the nearest tick, converted to an ARC LENGTH so
        // uRetTickWidth is a width in world units and the ticks don't fan out
        // as the reticle grows.
        float k = abs(fract(ang / seg + 0.5) - 0.5) * seg * max(r, 1e-4);
        float angMask = 1.0 - smoothstep(0.0, uRetTickWidth, k);
        float inner = uRetRadius + uRetThick;
        float radMask = smoothstep(inner, inner + uRetThick, r)
                      * (1.0 - smoothstep(inner + uRetTickLen, inner + uRetTickLen + uRetThick, r));
        ticks = angMask * radMask;
      }

      float dot0 = uRetDot > 0.0 ? (1.0 - smoothstep(uRetDot * 0.4, uRetDot, r)) : 0.0;
      // max, not sum: where a tick meets the ring the two would otherwise add
      // to double brightness and put a bright bead at every junction.
      float m = max(ring, max(ticks, dot0));
      color += uRetColor * m * uRetGlow;
    }

    float a = max(max(color.r, color.g), color.b);
    if (a <= 0.002) discard;
    gl_FragColor = vec4(color * uAlpha, a * uAlpha);
  }
`;

let mesh = null;
let scroll = 0;
let spin = 0;
let alpha = 0;

function cfg() {
  return CONFIG.aimIndicator ?? {};
}

export function createAimIndicator() {
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    // An aim indicator that disappears behind whatever it is aimed at is
    // worse than none — it vanishes exactly when there is something to shoot.
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uAim: { value: new THREE.Vector2(1, 0) },
      uHalf: { value: 1 },
      uAlpha: { value: 0 },
      uLineOn: { value: 0 },
      uLineStart: { value: 1 },
      uLineLength: { value: 14 },
      uLineWidth: { value: 0.16 },
      uLineSoft: { value: 0.75 },
      uLineFade: { value: 0.8 },
      uLineColor: { value: new THREE.Color(0x6fd3ff) },
      uLineGlow: { value: 1.4 },
      uDashOn: { value: 0 },
      uDashSize: { value: 1.6 },
      uDashDuty: { value: 0.55 },
      uDashScroll: { value: 0 },
      uRetOn: { value: 0 },
      uRetDist: { value: 15 },
      uRetRadius: { value: 1.1 },
      uRetThick: { value: 0.16 },
      uRetTickCount: { value: 4 },
      uRetTickLen: { value: 0.5 },
      uRetTickWidth: { value: 0.14 },
      uRetDot: { value: 0.18 },
      uRetSpin: { value: 0 },
      uRetColor: { value: new THREE.Color(0x9fe8ff) },
      uRetGlow: { value: 1.6 },
    },
  });
  mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  // In front of everything it might otherwise be sorted behind. Paired with
  // depthTest:false above — renderOrder alone only settles ties between
  // transparent objects, it does not beat a depth buffer.
  mesh.renderOrder = 30;
  mesh.frustumCulled = false;
  return mesh;
}

export function resetAimIndicator() {
  scroll = 0;
  spin = 0;
  alpha = 0;
  if (mesh) mesh.visible = false;
}

/**
 * @param aim     input.aim — a normalized direction, not a point.
 * @param firing  lets the indicator sit back when nobody is shooting; see
 *                `idleOpacity`.
 */
export function updateAimIndicator(dt, playerPos, aim, firing, running) {
  if (!mesh) return;
  const c = cfg();
  const line = c.line ?? {};
  const ret = c.reticle ?? {};
  const wantLine = !!line.enabled;
  const wantRet = !!ret.enabled;

  // Fade rather than cut, so toggling it in the tuner or dying doesn't pop.
  const target = (running && c.enabled && (wantLine || wantRet))
    ? (firing ? (c.opacity ?? 1) : (c.idleOpacity ?? 0.55) * (c.opacity ?? 1))
    : 0;
  const rate = 1 - Math.exp(-dt / Math.max(0.001, c.fade ?? 0.12));
  alpha += (target - alpha) * rate;
  mesh.visible = alpha > 0.004;
  if (!mesh.visible) return;

  scroll += dt * (line.dashSpeed ?? 6);
  spin += dt * (ret.spinSpeed ?? 0);

  const u = mesh.material.uniforms;
  // Guard the zero vector: input.aim is normalized in every path that writes
  // it, but it starts life as (1,0) and a zero here would make atan and the
  // frame below produce NaN across the whole quad.
  const len = Math.hypot(aim?.x ?? 0, aim?.y ?? 0);
  if (len > 0.0001) u.uAim.value.set(aim.x / len, aim.y / len);

  // The quad has to cover whichever parts are on, and no more — it is
  // additive and depth-test-free, so every pixel of it is real fill cost.
  const lineReach = wantLine ? (line.start ?? 1) + (line.length ?? 14) : 0;
  const retReach = wantRet
    ? (ret.distance ?? 15) + (ret.radius ?? 1.1) + (ret.tickLength ?? 0.5) + 2 * (ret.thickness ?? 0.16)
    : 0;
  const half = Math.max(1, lineReach, retReach) + Math.max(line.width ?? 0.16, 0.5);
  mesh.position.set(playerPos.x, playerPos.y, c.z ?? -0.04);
  mesh.scale.setScalar(half);
  u.uHalf.value = half;
  u.uAlpha.value = alpha;

  u.uLineOn.value = wantLine ? 1 : 0;
  u.uLineStart.value = line.start ?? 1;
  u.uLineLength.value = line.length ?? 14;
  u.uLineWidth.value = line.width ?? 0.16;
  u.uLineSoft.value = Math.min(0.999, line.softness ?? 0.75);
  u.uLineFade.value = line.fade ?? 0.8;
  u.uLineColor.value.set(line.color ?? 0x6fd3ff);
  u.uLineGlow.value = line.glow ?? 1.4;
  u.uDashOn.value = line.dashed ? 1 : 0;
  u.uDashSize.value = Math.max(0.05, line.dashSize ?? 1.6);
  u.uDashDuty.value = Math.min(0.95, line.dashDuty ?? 0.55);
  u.uDashScroll.value = scroll;

  u.uRetOn.value = wantRet ? 1 : 0;
  u.uRetDist.value = ret.distance ?? 15;
  u.uRetRadius.value = ret.radius ?? 1.1;
  u.uRetThick.value = Math.max(0.01, ret.thickness ?? 0.16);
  u.uRetTickCount.value = Math.max(0, Math.round(ret.tickCount ?? 4));
  u.uRetTickLen.value = ret.tickLength ?? 0.5;
  u.uRetTickWidth.value = Math.max(0.01, ret.tickWidth ?? 0.14);
  u.uRetDot.value = ret.dot ?? 0.18;
  u.uRetSpin.value = spin;
  u.uRetColor.value.set(ret.color ?? 0x9fe8ff);
  u.uRetGlow.value = ret.glow ?? 1.6;
}
