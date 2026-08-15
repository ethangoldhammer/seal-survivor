import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { pipCount } from './strike.js';
import { playerOverlayZ } from '../entities/player.js';

// ============================================================================
// THE CHARGE METER — TWO ARCS around the ship, Sektori-style, instead of a
// number in the corner.
//
//   OUTER, in PIPS: the FUEL. One pip is exactly one chum (see pipCount in
//     systems/strike.js), so the bar is countable rather than continuous, and
//     a link adding a pip is the cost escalation made visible.
//   INNER: the BANKED POWER — what letting go right now would actually buy.
//
// WHY TWO. The two quantities move in OPPOSITE directions while you hold, and
// the ring used to draw only the first: fuel visibly drained while the strike
// being wound up got stronger, and the only sign of the second was an alpha
// step on the first. One arc could not stop contradicting itself.
//
// WHY THE INNER ARC SITS AT 0.58 AND NOT THE OBVIOUS 0.78.
//
// Bloom, and the numbers are tighter than they look. The ring is
// `radius` 1.9 world units against a 44-unit view (arena.viewHeight 52 at the
// cinematic rig's base zoom 1.18), which is 24.5 px per world unit — so the
// whole meter is 93 px across on a 1080p screen and a band is under 4 px. The
// bright pass is built at CONFIG.bloom.divisor 4 with radius 3, spreading
// roughly 14 px at full res. Two bands 10 px apart (which is what 0.78 gives)
// fuse into one fat smear, and the fix is radial separation, not a thinner
// band. 0.58 buys 20 px.
//
// The inner arc is also kept deliberately DIMMER than the outer one for the
// same reason: what does not pass CONFIG.bloom.threshold does not get a halo,
// and a banked-power arc that never blooms cannot bleed into the fuel it sits
// inside. See `innerGlowMul`.
//
// The whole thing hangs off `scale` and `offset` (CONFIG.strike.ring), so the
// meter can be sized and pushed off the seal without touching `radius` — which
// is the number the pip geometry is derived from and wants to stay put.
// ============================================================================

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// One quad, both rings, drawn in normalised space where the OUTER ring sits at
// r = 1.0. Every radius below is a fraction of that, so `scale` on the mesh
// moves the whole instrument and nothing here has to know about world units.
const fragmentShader = /* glsl */ `
  #define MAX_PIPS 16
  uniform float uPips;         // how many segments the fuel ring is cut into
  uniform float uPending;      // 0..1 banked power, spring-smoothed
  uniform float uArmed;        // 1 once enough power is banked to fire
  uniform float uFlash;        // 0..1 — the bar being spent, fades out
  uniform float uThickness;
  uniform float uGap;          // radians of blank between pips
  uniform float uInnerR;       // inner arc radius, as a fraction of the outer
  uniform float uInnerT;       // ...and its thickness, as a fraction
  uniform float uInnerGlow;    // held under the bloom threshold on purpose
  uniform float uChainR;       // the chain-window arc, outside the fuel ring
  uniform float uChainLeft;    // 0..1 of the window still to run, 0 = no chain
  uniform vec3  uColor;
  uniform vec3  uReadyColor;
  uniform vec3  uComboColor;
  uniform vec3  uPipColor;     // what the LAST pip is tinted, so "one from
                               // full" reads without counting
  uniform float uGlow;
  // PER-PIP STATE. Sized to a constant rather than to uPips because an array
  // uniform's length is fixed at compile time, and the pip count moves at
  // runtime as links land. MAX_PIPS comfortably clears CONFIG.strike.charge
  // .maxPips; entries past uPips are simply never read.
  uniform float uPipFill[MAX_PIPS];  // 0..1 each, its own spring
  uniform float uPipPop[MAX_PIPS];   // 1 on landing, decaying to 0
  uniform float uPopSwell;     // how much a pop widens its band
  uniform float uPopGlow;      // ...and how far past 1 it drives the colour
  varying vec2 vUv;

  #define TAU 6.28318530718

  // Distance-to-band, returned as a soft mask. One helper for all three rings
  // so they antialias identically instead of each rolling their own smoothstep.
  float bandMask(float r, float centre, float halfWidth) {
    return 1.0 - smoothstep(halfWidth * 0.55, halfWidth * 1.45, abs(r - centre));
  }

  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);

    // Angle measured clockwise from straight up, so pip 0 starts at 12
    // o'clock and the ring fills the way a clock hand sweeps.
    float ang = atan(p.x, p.y);
    if (ang < 0.0) ang += TAU;

    vec3  col = vec3(0.0);
    float alpha = 0.0;
    float halfT = uThickness * 0.5;

    // ---- THE FUEL RING, in pips -------------------------------------------
    // EVERY PIP IS ITS OWN ANIMATION. The fill and the pop arrive as arrays
    // rather than being derived from one bar value, which is the whole reason
    // five chum swallowed on a single frame come up one at a time instead of
    // as one jump — see the stagger queue in updateStrikeRing.
    float seg = TAU / max(uPips, 1.0);
    float idxF = floor(ang / seg);
    float within = (ang - idxF * seg) / seg;      // 0..1 across this pip
    float gapFrac = clamp(uGap / seg, 0.0, 0.6);

    float pf = 0.0;   // how full this pip is, 0..1 (its own spring)
    float pp = 0.0;   // its pop, 1 on landing, decaying to 0
    if (idxF >= 0.0 && idxF < uPips) {
      int idx = int(idxF);
      pf = uPipFill[idx];
      pp = uPipPop[idx];
    }

    // THE POP SWELLS THE BAND. Widening the pip rather than only brightening
    // it is what makes the landing read as a physical plop — brightness alone
    // on a 4px band is a twinkle, and the swell is visible even where the
    // colour has nowhere left to go.
    float outerC = 1.0 - halfT;
    float mOuter = bandMask(r, outerC, halfT * (1.0 + pp * uPopSwell));
    if (mOuter > 0.001 && within <= 1.0 - gapFrac) {
      float lit = step(within / max(0.0001, 1.0 - gapFrac), clamp(pf, 0.0, 1.0));

      // COLOUR CODED ALONG THE RING: the ramp walks the charging colour
      // toward the ready colour as the pips climb, and the last pip is
      // pinned to uPipColor. Approaching full is then legible from the
      // hue alone, before the ring is anywhere near closed.
      float t = uPips > 1.0 ? idxF / (uPips - 1.0) : 1.0;
      vec3 ramp = mix(uColor, uReadyColor, t * 0.75);
      bool lastPip = idxF >= uPips - 1.0;
      vec3 pipCol = lastPip ? uPipColor : ramp;

      // Overdriven on the pop, deliberately past 1: the bright pass is a
      // HalfFloat target, so this blooms outward for a moment instead of
      // clipping to white in place. That bloom IS the glow.
      col = mix(col, pipCol * (1.0 + pp * uPopGlow), lit);
      // The empty track stays faintly visible so the ring reads as a
      // container rather than as a floating arc.
      alpha = max(alpha, mOuter * mix(0.14, 1.0, lit));
    }

    // ---- THE BANKED-POWER ARC, inside ------------------------------------
    // Continuous, not pipped: power is not bought in mouthfuls and drawing it
    // in segments would say it was.
    float innerHalf = uThickness * uInnerT * 0.5;
    float mInner = bandMask(r, uInnerR, innerHalf);
    if (mInner > 0.001) {
      float lit = step(ang / TAU, uPending);
      vec3 pc = mix(uColor, uReadyColor, uArmed);
      col = mix(col, pc * uInnerGlow, lit * mInner);
      alpha = max(alpha, mInner * mix(0.10, mix(0.55, 1.0, uArmed), lit));
    }

    // ---- THE CHAIN WINDOW, outside ---------------------------------------
    // The 1s combo timer draining. It was never drawn at all before: the ring
    // pulsed at a fixed rate whether there was 0.9s left or 0.05s.
    if (uChainLeft > 0.0) {
      float mChain = bandMask(r, uChainR, halfT * 0.42);
      if (mChain > 0.001 && ang / TAU <= uChainLeft) {
        col = mix(col, uComboColor, mChain);
        alpha = max(alpha, mChain * 0.85);
      }
    }

    if (alpha <= 0.002) discard;

    // The spend flash: the whole instrument blows out white and fades, so the
    // release reads as the moment the fuel turned into a strike.
    if (uFlash > 0.0) {
      col = mix(col, vec3(1.0), uFlash);
      alpha = max(alpha, uFlash * mOuter);
    }

    gl_FragColor = vec4(col * uGlow * alpha, alpha);
  }
`;

let mesh = null;

// ---------------------------------------------------------------------------
// THE SPRING. Underdamped on purpose — a pip landing overshoots a little and
// settles, which is what makes eating feel like it lands rather than like a
// number changing.
//
// OVERSHOOT NEVER REACHES THE FILL. `value` is clamped to the true target's
// side of the boundary before it goes to the shader, and the leftover energy
// comes out as GLOW instead (see `over`). A bar springing visibly past full
// would read as ready a frame or two before it was, which is the one lie a
// charge meter must not tell.
//
// Asymmetric by design: gains ring, spends do not. A smoothed drain makes the
// wind-up feel laggy — the cost of holding has to land on the frame you press.
// ---------------------------------------------------------------------------
function makeSpring() {
  return { x: 0, v: 0, over: 0 };
}

function trackSpring(s, target, dt, stiffness, damping) {
  // Rising: spring toward it. Falling: snap, so the burn is felt immediately.
  if (target < s.x) {
    s.x = target;
    s.v = 0;
    s.over = 0;
    return s.x;
  }
  s.v += (target - s.x) * stiffness * dt;
  s.v *= Math.exp(-damping * dt);
  s.x += s.v * dt;
  if (s.x < 0) { s.x = 0; if (s.v < 0) s.v = 0; }
  s.over = Math.max(0, s.x - target);
  return Math.min(s.x, target);
}

const powerSpring = makeSpring();

// ---------------------------------------------------------------------------
// THE STAGGER — why five chum on one frame is five plops, not one jump.
//
// A magnet sweep or a release gulp swallows a whole bar's worth inside a single
// frame. Fed straight to the ring that is one instantaneous jump from empty to
// full: the most rewarding moment in the loop, over in 16ms, reading as a
// number changing rather than as five things being eaten.
//
// So the ring does NOT draw the bar. It draws a queue catching up to it. The
// true fill is the target; pips are RELEASED to animate one at a time on
// `pipStagger`, each with its own spring and its own pop. Eat five at once and
// you watch five land in sequence.
//
// This is presentation only and deliberately owns no gameplay: `charge` is
// already whatever it is, the strike is already affordable, and the ring is
// simply late to say so. The one thing that must never lag is the DRAIN — see
// the snap below.
//
// It intentionally mirrors the audio queue in systems/strike.js, which drains
// pip TICKS on CONFIG.strike.charge.pipGap. `pipStagger` defaults to that same
// value so the plop you see and the tick you hear are the same event; they are
// separate fields because one is a sound-design floor and the other is an
// animation rate, and pinning them together forever would be a coincidence
// rather than a decision.
// ---------------------------------------------------------------------------
const MAX_PIPS = 16;
const pipFill = new Float32Array(MAX_PIPS);   // 0..1 each, sent to the shader
const pipVel = new Float32Array(MAX_PIPS);    // its spring velocity
const pipPop = new Float32Array(MAX_PIPS);    // 1 on landing, decays to 0
let revealed = 0;      // pips released to animate up so far
let staggerLeft = 0;   // seconds until the next one is released
let lastPips = 0;      // pip count last frame, to detect a re-segmentation

/** Put the springs back where a fresh run starts them. */
export function resetStrikeRing() {
  powerSpring.x = 0; powerSpring.v = 0; powerSpring.over = 0;
  pipFill.fill(0);
  pipVel.fill(0);
  pipPop.fill(0);
  revealed = 0;
  staggerLeft = 0;
  lastPips = 0;
}

/**
 * Advance the per-pip animation one frame.
 *
 * @param fuel 0..1 the TRUE meter — the ring chases this, it never sets it.
 * @param n    how many pips the bar is cut into right now.
 */
function updatePips(fuel, n, dt, ring) {
  const whole = Math.floor(fuel * n + 1e-6);
  const frac = fuel * n - whole;

  // A LINK RE-SEGMENTS THE RING. The pip count changed, so the pips on screen
  // are no longer the pips in the model and animating between the two would be
  // a meaningless tween. Snap, and let the next mouthful animate normally.
  if (n !== lastPips) {
    lastPips = n;
    revealed = whole;
    staggerLeft = 0;
    for (let i = 0; i < MAX_PIPS; i++) {
      pipFill[i] = i < whole ? 1 : (i === whole ? frac : 0);
      pipVel[i] = 0;
    }
  }

  // THE DRAIN NEVER LAGS. Holding burns fuel and the release spends it, and
  // both are things the player DID — a bar that empties late reads as input
  // lag. Only gains are allowed to queue.
  if (whole < revealed) {
    revealed = whole;
    staggerLeft = 0;
  }

  // Release the backlog one pip at a time.
  const backlog = whole > revealed;
  if (backlog) {
    staggerLeft -= dt;
    if (staggerLeft <= 0) {
      pipPop[revealed] = 1;            // the new pip lands
      revealed++;
      staggerLeft = Math.max(0, ring.pipStagger ?? CONFIG.strike.charge.pipGap ?? 0.055);
    }
  } else {
    staggerLeft = 0;
  }

  const k = ring.pipStiffness ?? 320;
  const c = ring.pipDamping ?? 13;
  const popDecay = ring.popDecay ?? 4.5;
  // Still-backlogged pips hold at 0 rather than showing the fraction: the
  // partial only means anything once the queue has caught up, and letting it
  // through would fill the very pip that is waiting its turn.
  for (let i = 0; i < MAX_PIPS; i++) {
    let target = 0;
    if (i < revealed) target = 1;
    else if (i === revealed && !backlog) target = Math.max(0, Math.min(1, fuel * n - i));

    if (target < pipFill[i]) {
      pipFill[i] = target;             // drain: immediate
      pipVel[i] = 0;
    } else {
      pipVel[i] += (target - pipFill[i]) * k * dt;
      pipVel[i] *= Math.exp(-c * dt);
      pipFill[i] += pipVel[i] * dt;
      if (pipFill[i] < 0) { pipFill[i] = 0; pipVel[i] = 0; }
    }
    if (pipPop[i] > 0) pipPop[i] = Math.max(0, pipPop[i] - dt * popDecay);
  }
}

export function createStrikeRing() {
  const geometry = new THREE.PlaneGeometry(2, 2);
  const ring = CONFIG.strike.ring;
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uPips: { value: 5 },
      uPending: { value: 0 },
      uPipFill: { value: pipFill },
      uPipPop: { value: pipPop },
      uPopSwell: { value: ring.popSwell ?? 0.9 },
      uPopGlow: { value: ring.popGlow ?? 2.6 },
      uArmed: { value: 0 },
      uFlash: { value: 0 },
      uThickness: { value: ring.thickness },
      uGap: { value: ring.segmentGap },
      uInnerR: { value: ring.innerRadiusMul ?? 0.58 },
      uInnerT: { value: ring.innerThicknessMul ?? 0.7 },
      uInnerGlow: { value: ring.innerGlowMul ?? 0.55 },
      uChainR: { value: ring.chainRadiusMul ?? 1.14 },
      uChainLeft: { value: 0 },
      uColor: { value: new THREE.Color(ring.color) },
      uReadyColor: { value: new THREE.Color(ring.readyColor) },
      uComboColor: { value: new THREE.Color(ring.comboColor) },
      uPipColor: { value: new THREE.Color(ring.lastPipColor ?? ring.readyColor) },
      uGlow: { value: ring.glow },
    },
  });
  mesh = new THREE.Mesh(geometry, material);
  // Behind the whole seal, not just behind its origin — see playerOverlayZ.
  // Restamped every frame in updateStrikeRing, because the seal's size is a
  // slider and this is derived from it.
  mesh.position.z = playerOverlayZ();
  mesh.frustumCulled = false;
  resetStrikeRing();
  return mesh;
}

export function updateStrikeRing(dt, playerPos, strikeState, running, stats = null) {
  if (!mesh) return;
  mesh.visible = running && CONFIG.strike.enabled;
  if (!mesh.visible) return;

  const ring = CONFIG.strike.ring;

  // SCALE and OFFSET are the two dials that move the instrument without
  // touching `radius`. The pip geometry and the band thicknesses are all
  // fractions of the quad, so scaling is a pure size change — no relayout, and
  // the bloom separation argued for at the top of this file scales with it.
  //
  // The offset is in WORLD units from the player, not screen pixels: the seal
  // rotates and the camera zooms, and a pixel offset would slide the ring
  // around the animal as either happened.
  mesh.position.x = playerPos.x + (ring.offsetX ?? 0);
  mesh.position.y = playerPos.y + (ring.offsetY ?? 0);
  mesh.position.z = playerOverlayZ();
  mesh.scale.setScalar(ring.radius * (ring.scale ?? 1));

  const u = mesh.material.uniforms;
  const fuel = Math.max(0, Math.min(1, strikeState.charge));
  const power = Math.max(0, Math.min(1, strikeState.pending));

  const k = ring.springStiffness ?? 210;
  const c = ring.springDamping ?? 18;
  u.uPending.value = trackSpring(powerSpring, power, dt, k, c);

  // The pip count first: updatePips needs it to spot a re-segmentation, and
  // the Float32Arrays it writes ARE the uniform values (three uploads the same
  // buffer object every frame), so there is nothing to copy afterwards.
  const pips = pipCount(stats);
  u.uPips.value = pips;
  updatePips(fuel, pips, dt, ring);
  u.uPopSwell.value = ring.popSwell ?? 0.9;
  u.uPopGlow.value = ring.popGlow ?? 2.6;
  // Armed reads the POWER BANKED, not the fuel left — they move in opposite
  // directions while holding, and the one the player needs to know about is
  // whether letting go now would actually launch anything.
  u.uArmed.value = strikeState.pending >= CONFIG.strike.charge.minFire ? 1 : 0;
  // Normalised so the flash fades out over flashTime rather than popping off.
  u.uFlash.value = Math.max(0, Math.min(1, strikeState.flash / Math.max(0.01, CONFIG.strike.charge.flashTime)));
  u.uChainLeft.value = strikeState.chainTimer > 0
    ? Math.min(1, strikeState.chainTimer / Math.max(0.05, CONFIG.strike.chainWindow))
    : 0;

  u.uThickness.value = ring.thickness;
  u.uGap.value = ring.segmentGap;
  u.uInnerR.value = ring.innerRadiusMul ?? 0.58;
  u.uInnerT.value = ring.innerThicknessMul ?? 0.7;
  u.uInnerGlow.value = ring.innerGlowMul ?? 0.55;
  u.uChainR.value = ring.chainRadiusMul ?? 1.14;
  u.uColor.value.set(ring.color);
  u.uReadyColor.value.set(ring.readyColor);
  u.uComboColor.value.set(ring.comboColor);
  u.uPipColor.value.set(ring.lastPipColor ?? ring.readyColor);
  // The spring's leftover energy comes out here rather than as fill, so a pip
  // landing BLOOMS instead of overshooting the bar it is landing in.
  // The whole ring lifts a little on a landing, on top of the per-pip flare —
  // read off the loudest pop rather than a whole-bar spring, which no longer
  // exists now that every pip springs on its own.
  let loudest = 0;
  for (let i = 0; i < pips; i++) if (pipPop[i] > loudest) loudest = pipPop[i];
  u.uGlow.value = ring.glow * (1 + loudest * (ring.bounceGlow ?? 6) * 0.12);
}
