import * as THREE from 'three';
import { CONFIG } from '../config.js';

// The charge meter, drawn as a ring around the ship — Sektori-style — instead
// of a number in the corner. It sweeps clockwise as you hold the strike
// button, dim until it passes the firing threshold and solid in `readyColor`
// once full, so how much strike you are holding is legible without moving
// your eyes off the seal. Mid-combo the same arc is what eating refills.
// While a strike combo is live the whole ring pulses in the combo colour.
//
// The shader still speaks in "segments" because it used to draw one arc per
// banked charge. There is only ever one now (uMaxCharges is pinned to 1), so
// the segment maths collapses to a single sweep; `uGap` leaves a small notch
// at 12 o'clock, which reads as the start line.

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uCharges;      // how many whole charges are banked
  uniform float uMaxCharges;
  uniform float uPartial;      // 0..1 fill of the charge meter
  uniform float uArmed;        // 1 once enough power is banked to fire
  uniform float uFlash;        // 0..1 — the bar being spent, fades out
  uniform float uThickness;
  uniform float uGap;          // radians of blank between segments
  uniform float uCombo;        // 0 = no combo, >0 = combo depth
  uniform float uPulse;        // 0..1 pulse phase while combo is live
  uniform vec3 uColor;
  uniform vec3 uReadyColor;
  uniform vec3 uComboColor;
  uniform float uGlow;
  varying vec2 vUv;

  #define TAU 6.28318530718

  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);

    // Ring band test — everything outside the annulus is discarded so the
    // quad reads as a ring rather than a disc.
    float halfT = uThickness * 0.5;
    if (r > 1.0 || r < 1.0 - uThickness * 2.0) discard;
    float band = 1.0 - smoothstep(halfT * 0.6, halfT * 2.0, abs(r - (1.0 - uThickness)));
    if (band <= 0.001) discard;

    // Angle measured clockwise from straight up, so segment 0 starts at 12
    // o'clock and fills the way a clock hand sweeps.
    float ang = atan(p.x, p.y);
    if (ang < 0.0) ang += TAU;

    float segArc = TAU / max(uMaxCharges, 1.0);
    float segIndex = floor(ang / segArc);
    float withinSeg = (ang - segIndex * segArc) / segArc; // 0..1 across this segment

    // Blank the gap at the end of each segment so charges read as separate.
    float gapFrac = uGap / segArc;
    if (withinSeg > 1.0 - gapFrac) discard;

    float fill;
    if (segIndex < uCharges) {
      fill = 1.0;                                   // banked charge
    } else if (segIndex < uCharges + 1.0) {
      fill = step(withinSeg, uPartial);             // the one recharging
    } else {
      fill = 0.0;                                   // not yet started
    }

    vec3 col = uColor;
    float alpha = 0.16;                             // empty track stays faintly visible

    if (fill > 0.5) {
      bool full = uCharges >= uMaxCharges;
      col = full ? uReadyColor : uColor;
      // Below the firing threshold the arc is drawn but held back, so "winding
      // up" and "ready to spend" are two different-looking states rather than
      // one arc that happens to be longer.
      alpha = full ? 1.0 : mix(0.45, 1.0, uArmed);
    }

    if (uCombo > 0.0) {
      float flash = 0.55 + 0.45 * sin(uPulse * TAU);
      col = mix(col, uComboColor, min(1.0, 0.35 + uCombo * 0.15));
      alpha = max(alpha, 0.35) * (0.7 + 0.6 * flash);
    }

    // The spend flash: the whole ring blows out white and fades, so the
    // release reads as the moment the fuel turned into a strike.
    if (uFlash > 0.0) {
      col = mix(col, vec3(1.0), uFlash);
      alpha = max(alpha, uFlash);
    }

    gl_FragColor = vec4(col * uGlow * alpha, alpha * band);
  }
`;

let mesh = null;
let pulseClock = 0;

export function createStrikeRing() {
  const geometry = new THREE.PlaneGeometry(2, 2);
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uCharges: { value: 0 },
      uMaxCharges: { value: 2 },
      uPartial: { value: 0 },
      uArmed: { value: 0 },
      uFlash: { value: 0 },
      uThickness: { value: CONFIG.strike.ring.thickness },
      uGap: { value: CONFIG.strike.ring.segmentGap },
      uCombo: { value: 0 },
      uPulse: { value: 0 },
      uColor: { value: new THREE.Color(CONFIG.strike.ring.color) },
      uReadyColor: { value: new THREE.Color(CONFIG.strike.ring.readyColor) },
      uComboColor: { value: new THREE.Color(CONFIG.strike.ring.comboColor) },
      uGlow: { value: CONFIG.strike.ring.glow },
    },
  });
  mesh = new THREE.Mesh(geometry, material);
  mesh.position.z = -0.05;
  mesh.frustumCulled = false;
  return mesh;
}

export function updateStrikeRing(dt, playerPos, strikeState, running) {
  if (!mesh) return;
  mesh.visible = running && CONFIG.strike.enabled;
  if (!mesh.visible) return;

  pulseClock += dt * CONFIG.strike.ring.pulseSpeed;

  const ring = CONFIG.strike.ring;
  mesh.position.x = playerPos.x;
  mesh.position.y = playerPos.y;
  mesh.scale.setScalar(ring.radius);

  const u = mesh.material.uniforms;
  // One bar, so one segment: a single arc showing the FUEL left, shrinking
  // back anticlockwise as holding burns it and growing again as chum goes
  // down. `uCharges` degenerates to a full/not-full flag, which is what
  // switches the colour to `readyColor` on a full tank.
  const charge = Math.max(0, Math.min(1, strikeState.charge));
  const full = charge >= 1;
  u.uCharges.value = full ? 1 : 0;
  u.uMaxCharges.value = 1;
  u.uPartial.value = full ? 0 : charge;
  // Armed reads the POWER BANKED, not the fuel left — they move in opposite
  // directions while holding, and the one the player needs to know about is
  // whether letting go now would actually launch anything.
  u.uArmed.value = strikeState.pending >= CONFIG.strike.charge.minFire ? 1 : 0;
  // Normalised so the flash fades out over flashTime rather than popping off.
  u.uFlash.value = Math.max(0, Math.min(1, strikeState.flash / Math.max(0.01, CONFIG.strike.charge.flashTime)));
  u.uThickness.value = ring.thickness;
  u.uGap.value = ring.segmentGap;
  u.uCombo.value = strikeState.chainTimer > 0 ? strikeState.chainCount : 0;
  u.uPulse.value = pulseClock;
  u.uColor.value.set(ring.color);
  u.uReadyColor.value.set(ring.readyColor);
  u.uComboColor.value.set(ring.comboColor);
  u.uGlow.value = ring.glow;
}
