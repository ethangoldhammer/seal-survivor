import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { chainHex } from './chainColor.js';
import { pipCount, liveChain, releaseOffset, sweetHalfWidth } from './strike.js';
import { ease } from '../ease.js';
import { playerOverlayZ } from '../entities/player.js';

// ============================================================================
// THE CHARGE METER — a RING and a DROP around the ship, Sektori-style, instead
// of a number in the corner.
//
//   OUTER, in PIPS: the FUEL. One pip is exactly one chum (see pipCount in
//     systems/strike.js), so the bar is countable rather than continuous, and
//     a link adding a pip is the cost escalation made visible.
//   THE CORE: the BANKED POWER — what letting go right now would actually buy.
//     A blob of goo at the seal's centre that grows outward as power banks.
//
// WHY TWO. The two quantities move in OPPOSITE directions while you hold, and
// the ring used to draw only the first: fuel visibly drained while the strike
// being wound up got stronger, and the only sign of the second was an alpha
// step on the first. One arc could not stop contradicting itself.
//
// WHY THE SECOND ONE IS NOT AN ARC. It was, and it swept round in the same
// direction as the fuel ring it sat inside — two concentric arcs filling the
// same way, which is one instrument saying two different things in the same
// words. Whichever is read first is the one that gets believed. Making the
// core a RADIAL fill puts the two quantities on different axes: fuel goes
// round, power comes out. Neither can be mistaken for the other, and the whole
// state is legible from the corner of an eye that is busy aiming.
//
// WHY IT IS GOO. Banked power is something being gathered and held, and a
// liquid pulled together by its own surface tension is the only shape that
// says both at once. It is also the substance the rest of the game already
// speaks in (CONFIG.fx.goo), so the meter reads as part of the same world
// rather than as a HUD element that wandered onto the animal. The field here
// is built from the identical cubic splat kernel entities/particles.js uses
// and cut at an isoline exactly like the goo pass, with the same wet rim and
// gradient-lit highlight — but analytically, in this one small quad, because
// the screen-space pass needs live particles and a fullscreen draw and this is
// a 90px instrument stuck to a moving animal.
//
// AND IT POPS. The frame the wind-up is fully banked (CONFIG.strike.charge
// .perfectAt) the drop swells past its own full size, blows past the bloom
// threshold, flings its lobes outward and throws a shock ring through the fuel
// ring. That moment is a thing the player will be asked to hit deliberately —
// the tell ships before the mechanic, so the timing is already familiar when
// it starts paying. See the note on `perfect` in systems/strike.js.
//
// WHY THE CORE STOPS AT 0.58 AND NOT THE OBVIOUS 0.78.
//
// Bloom, and the numbers are tighter than they look. The ring is
// `radius` 1.9 world units against a 44-unit view (arena.viewHeight 52 at the
// cinematic rig's base zoom 1.18), which is 24.5 px per world unit — so the
// whole meter is 93 px across on a 1080p screen and a band is under 4 px. The
// bright pass is built at CONFIG.bloom.divisor 4 with radius 3, spreading
// roughly 14 px at full res. Two features 10 px apart (which is what 0.78
// gives) fuse into one fat smear, and the fix is radial separation, not a
// thinner band. 0.58 buys 20 px.
//
// The core is also kept deliberately DIMMER than the ring for the same reason:
// what does not pass CONFIG.bloom.threshold does not get a halo, and a core
// that never blooms cannot bleed into the fuel around it. See `innerGlowMul` —
// and note that the perfect pop breaks that rule on purpose, for a fifth of a
// second, which is exactly why it reads as an event.
//
// The whole thing hangs off `scale` and `offset` (CONFIG.strike.ring), so the
// meter can be sized and pushed off the seal without touching `radius` — which
// is the number the pip geometry is derived from and wants to stay put.
// ============================================================================

// HOW MUCH QUAD THERE IS OUTSIDE THE FUEL RING.
//
// Everything in the shader is drawn in a space where the fuel ring sits at
// r = 1, and the quad used to stop there — a plane of exactly 2x2. Anything
// further out was CLIPPED TO THE CORNERS, which is not a subtle failure: a
// band at r = 1.14 exists only where the square reaches past the circle, so
// the chain-window arc has been drawing as four corner smears rather than as
// an arc, and the perfect charge's shock ring would leave the instrument as
// four blobs in a square frame.
//
// The quad is grown instead of the radii being capped, because the radii are
// the design and the quad is a detail. The extra area is transparent and
// discarded on the first branch of the shader; what it costs is the rasterised
// area of a 90px sprite, twice.
//
// It is a #define rather than a uniform so the two cannot disagree: the same
// constant sizes the geometry and scales the coordinates, in one place.
const OVERSCAN = 1.45;

/** The furthest out, in fuel-ring radii, anything drawn here can reach. */
export const RING_OVERSCAN = OVERSCAN;

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
  #define OVERSCAN ${OVERSCAN.toFixed(4)}
  uniform float uPips;         // how many segments the fuel ring is cut into
  uniform float uPending;      // 0..1 banked power, spring-smoothed
  uniform float uArmed;        // 1 once enough power is banked to fire
  uniform float uFlash;        // 0..1 — the bar being spent, fades out
  uniform float uThickness;
  uniform float uGap;          // radians of blank between pips
  uniform float uInnerR;       // what a FULL core reaches, as a fraction of
                               // the outer ring
  uniform float uInnerGlow;    // held under the bloom threshold on purpose

  // --- THE CORE, as goo ---------------------------------------------------
  uniform float uCore;         // 1 = draw it at all
  uniform float uCoreK;        // kernel radius / isoline radius, computed on
                               // the CPU from uIso so the surface lands where
                               // the fill says it does
  uniform float uLobes;        // satellites orbiting the core, 0..CORE_LOBES
  uniform float uWobble;       // how far out they ride, x the fill radius
  uniform float uLobeSize;     // ...and how big each is, x the core kernel
  uniform float uChurn;        // radians the lobe ring has rolled
  uniform float uBreathe;      // per-lobe size pulse, and its phase
  uniform float uBreathePhase;
  uniform float uIso;          // the surface, in accumulated density
  uniform float uSoft;         // half-width of the transition
  uniform float uBody;         // how bright the BODY of the drop is, so the
                               // rim has room to read as a wet edge above it
  uniform float uRim;
  uniform float uRimWidth;
  uniform float uSpec;
  uniform float uSpecPower;
  uniform float uNormal;       // how far the gradient bends the fake normal
  uniform vec2  uLight;
  uniform float uCorePop;      // 0..1, the perfect charge ringing out
  uniform float uCorePopGlow;  // NOT uPopGlow — that one is the PIP pop, up in
                               // the fuel ring's block
  // The release, blowing the drop apart. uCoreMul empties the middle,
  // uSpread is the radial impulse carrying the lobes out (in the same
  // normalised units as everything else, so 1 is the fuel ring), uLobeMul
  // shrinks each droplet as it flies and uCoreFade takes what is left off
  // the screen.
  uniform float uCoreMul;
  uniform float uLobeMul;
  uniform float uSpread;
  uniform float uCoreFade;
  uniform float uShockR;       // the shock ring's radius this frame...
  uniform float uShockW;       // ...its half-width...
  uniform float uShockGlow;    // ...and how hard it burns. 0 = not running.
  uniform float uShockWheel;   // 1 = it wears the fuel wheel's colours, 0 = the
                               // core's own single hue
  uniform float uChainR;       // the chain-window arc, outside the fuel ring
  uniform float uChainLeft;    // 0..1 of the window still to run, 0 = no chain

  // --- THE LEAD-IN: the release moment ARRIVING ---------------------------
  // A ring expanding out of the core to land on the fuel ring at the instant a
  // release would be on the beat, and the tolerance drawn where it is going to
  // land. Every other cue for that moment fires AT it; this is the only one
  // that shows it coming. See CONFIG.strike.ring.lead.
  uniform float uLeadR;        // where the traveller is NOW, in ring radii
  uniform float uLeadW;        // its half-width
  uniform float uLeadGlow;     // 0 = there is no wind-up to lead
  uniform float uLeadHit;      // 1 while it is inside the tolerance
  uniform float uSweetW;       // half-width of the TOLERANCE band, at r = 1
  uniform float uSweetGlow;
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
  // A GLSL ES 1.00 loop needs a constant bound, so the lobe count is a
  // ceiling here and uLobes masks the ones past it out. Seven is already
  // more than the silhouette can show at 90px.
  #define CORE_LOBES 7

  // Distance-to-band, returned as a soft mask. One helper for all three rings
  // so they antialias identically instead of each rolling their own smoothstep.
  float bandMask(float r, float centre, float halfWidth) {
    return 1.0 - smoothstep(halfWidth * 0.55, halfWidth * 1.45, abs(r - centre));
  }

  // THE COLOUR THE FUEL WHEEL CARRIES at a given fraction round it, and the
  // one place that ramp is written down. The pips quote it per SEGMENT and the
  // shock ring quotes it CONTINUOUSLY, and the two must not be able to drift
  // apart — a ring leaving the instrument in colours the instrument is not
  // wearing reads as a second effect that happens to be circular.
  //
  // lastPip blends in the colour the final segment is pinned to, so "one
  // mouthful from a strike" keeps its own hue wherever it is quoted.
  vec3 wheelColor(float t, float lastPip) {
    return mix(mix(uColor, uReadyColor, clamp(t, 0.0, 1.0) * 0.75), uPipColor, lastPip);
  }

  // ONE SPLAT OF THE DENSITY FIELD, and deliberately the same kernel as
  // entities/particles.js: cubic, so it is smooth in value AND in slope at the
  // rim, which is what stops a lobe's own edge showing up as a crease in the
  // silhouette once the field is thresholded.
  //
  // The gradient is accumulated alongside the value rather than taken from
  // extra taps: it is analytic here (this field is a handful of circles, not a
  // texture), and dFdx/dFdy is an extension in GLSL ES 1.00 that this shader
  // has no business depending on.
  //
  //   f  = (1 - q)^3,  q = |p - c|^2 / rad^2
  //   df = -6 (1 - q)^2 (p - c) / rad^2
  float splat(vec2 p, vec2 c, float rad, inout vec2 grad) {
    vec2 d = p - c;
    float r2 = max(rad * rad, 1e-6);
    float q = dot(d, d) / r2;
    if (q >= 1.0) return 0.0;
    float k = 1.0 - q;
    grad += -6.0 * k * k * d / r2;
    return k * k * k;
  }

  void main() {
    // The quad reaches OVERSCAN ring-radii out (see the note by the constant),
    // and this is the line that keeps r = 1 meaning the fuel ring regardless.
    vec2 p = (vUv - 0.5) * 2.0 * OVERSCAN;
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
      vec3 pipCol = wheelColor(t, idxF >= uPips - 1.0 ? 1.0 : 0.0);

      // Overdriven on the pop, deliberately past 1: the bright pass is a
      // HalfFloat target, so this blooms outward for a moment instead of
      // clipping to white in place. That bloom IS the glow.
      col = mix(col, pipCol * (1.0 + pp * uPopGlow), lit);
      // The empty track stays faintly visible so the ring reads as a
      // container rather than as a floating arc.
      alpha = max(alpha, mOuter * mix(0.14, 1.0, lit));
    }

    // ---- THE SPEND FLASH, on the RING only --------------------------------
    // The fuel blowing out white as it becomes a strike. Applied here rather
    // than at the end of the shader, which is where it used to be: from the
    // end it also painted the core, and the core on that exact frame is a drop
    // of goo being torn apart by the release. Whitening it hid the one event
    // the flash is supposed to be announcing, and turned a spray of liquid
    // into a handful of white beads.
    if (uFlash > 0.0) {
      col = mix(col, vec3(1.0), uFlash);
      alpha = max(alpha, uFlash * mOuter);
    }

    // ---- THE CORE: banked power, as a drop of goo -------------------------
    // Continuous, not pipped: power is not bought in mouthfuls and drawing it
    // in segments would say it was. RADIAL, not angular — see the note at the
    // top of this file for why it must not sweep the way the fuel ring does.
    if (uCore > 0.5 && uPending > 0.0) {
      // The isoline reaches uInnerR at a full bank, swelling past it while a
      // perfect charge rings out. uCoreK converts that requested surface
      // radius into the KERNEL radius that puts the surface there — without
      // it, every knob below would quietly resize the drop.
      float fillR = uInnerR * uPending;
      float coreK = fillR * uCoreK;

      vec2 grad = vec2(0.0);
      // THE MIDDLE GOES FIRST ON A RELEASE. uCoreMul collapses the central
      // blob while uSpread below carries the lobes outward, which is what
      // makes the drop TEAR rather than fade: the welds between the lobes and
      // the core are the first density to fall under the isoline, so the body
      // comes apart into separate droplets before any of it disappears. That
      // is the one thing a metaball field does that a sprite cannot fake.
      float dens = splat(p, vec2(0.0), coreK * uCoreMul, grad);

      // THE LOBES ARE WHAT MAKE IT LIQUID. A circle grown from the middle is a
      // dial; a circle with things moving under its skin is a substance. Each
      // rides its own slot on a slowly rolling ring and breathes on a rate
      // that shares no factor with the roll, so the outline never settles into
      // a repeating shape.
      float thrown = coreK * uWobble + uSpread;
      for (int i = 0; i < CORE_LOBES; i++) {
        if (float(i) >= uLobes) break;
        // The even slot, plus a fixed per-lobe offset. Without it the lobes sit
        // on a perfect polygon, which survives being rolled and being flung —
        // a release came apart into six beads at six even compass points, and
        // an even spray is the one arrangement a liquid never makes. Hashed off
        // the index rather than random, so the drop is the same drop every
        // frame and every run.
        float a = uChurn + TAU * float(i) / max(uLobes, 1.0)
                + sin(float(i) * 12.9898) * 0.4;
        float b = 1.0 + uBreathe * sin(uBreathePhase + float(i) * 2.399);
        dens += splat(p, vec2(sin(a), cos(a)) * (thrown * b), coreK * uLobeSize * uLobeMul * b, grad);
      }

      float ca = smoothstep(uIso - uSoft, uIso + uSoft, dens);
      if (ca > 0.002) {
        // Exactly the surface CONFIG.fx.goo builds: a fake normal off the
        // density gradient (the field falls fastest at the surface, so its
        // gradient points out of the goo), a specular off that, and a rim
        // band just inside the edge where a thick liquid gathers the light it
        // is carrying.
        vec3 n = normalize(vec3(-grad * uNormal, 1.0));
        vec3 l = normalize(vec3(uLight, 0.8));
        float spec = pow(max(dot(n, l), 0.0), uSpecPower) * uSpec;
        float rim = (1.0 - smoothstep(uIso, uIso + uRimWidth, dens)) * uRim;

        // Same colour rule the arc had: the charging hue until enough is
        // banked to fire, the ready hue after. The POP is a brightness event
        // rather than a colour one — the hue is what says "loaded", and
        // changing it in the same moment would spend the same word twice.
        vec3 cc = mix(uColor, uReadyColor, uArmed);
        vec3 lit = cc * (uBody + rim) + spec * mix(vec3(1.0), cc, 0.35);
        ca *= uCoreFade;
        col = mix(col, lit * uInnerGlow * (1.0 + uCorePop * uCorePopGlow), ca);
        alpha = max(alpha, ca * mix(0.55, 1.0, uArmed));
      }
    }

    // ---- THE LEAD-IN: the release moment arriving --------------------------
    //
    // TWO PARTS AND THEY ARE DIFFERENT THINGS. The TOLERANCE is a fixed band
    // at the fuel ring — where a release scores, standing still. The
    // TRAVELLER expands out of the core and crosses it. Let go as they meet.
    //
    // Drawn before the shock ring and after everything else, so a release fired
    // on the beat is the pop landing on top of the cue that earned it.
    if (uLeadGlow > 0.0) {
      // The target first, so the traveller reads as passing OVER it rather
      // than being occluded by its own destination.
      if (uSweetGlow > 0.0) {
        float mSweet = bandMask(r, 1.0, uSweetW);
        if (mSweet > 0.001) {
          col += uReadyColor * uSweetGlow * mSweet;
          alpha = max(alpha, mSweet * min(1.0, uSweetGlow) * 0.7);
        }
      }
      float mLead = bandMask(r, uLeadR, uLeadW);
      if (mLead > 0.001) {
        // TWO SIGNALS FOR ONE EVENT, because either alone is fragile.
        //
        // THE HUE: the charging colour on the way in, the ready colour for
        // exactly as long as a release would arm — the same pair the core and
        // the pips already use for "this will fire", so the cue is speaking the
        // instrument's own language rather than inventing a vocabulary.
        //
        // THE COINCIDENCE: the traveller arriving on the target. That one is
        // geometric and survives anything the composite does to the colours,
        // which matters more here than it looks — the ring's hues are TUNED
        // (they are orange and green in the shipped snapshot, not the blue and
        // mint in config.js's defaults), so a cue that leaned on one specific
        // pair of colours would be at the mercy of a tuner slider.
        //
        // The hit rides on top as brightness as well. Kept modest on purpose:
        // everything here is multiplied by uGlow (2.2) on the way out, and a
        // band that clips has no hue left to change — at glow 1.15 the
        // traveller measured rgb(255,189,76), a clipped white-amber with the
        // signal burnt out of it. See the pixel checks in
        // tools/looks/boost-core.js, which are what set the number below.
        vec3 leadCol = mix(uColor, uReadyColor, uLeadHit);
        col += leadCol * uLeadGlow * (1.0 + uLeadHit * 0.9) * mLead;
        alpha = max(alpha, mLead * min(1.0, uLeadGlow * (1.0 + uLeadHit)));
      }
    }

    // ---- THE SHOCK RING off a perfect charge -------------------------------
    // The one thing in the instrument allowed to cross the fuel ring: it is
    // the surface letting go, so it has to leave.
    if (uShockGlow > 0.0) {
      float mShock = bandMask(r, uShockR, uShockW);
      if (mShock > 0.001) {
        // IT WEARS THE WHOLE WHEEL. The ring leaves through the fuel ring, so
        // it carries the fuel ring's colours out with it — every hue the pips
        // are wearing, at the angle each of them is wearing it, read
        // CONTINUOUSLY rather than in segments because this is one moving band
        // and not a bar with a count. Quoting the ramp is what makes the pop
        // look like it came off THIS instrument.
        //
        // The last pip's own colour is blended in over the width of that last
        // segment, so the ring carries that hue where the wheel does.
        float tc = ang / TAU;
        float lastMix = smoothstep(1.0 - 1.0 / max(uPips, 1.0), 1.0, tc);
        vec3 shockCol = mix(mix(uColor, uReadyColor, uArmed), wheelColor(tc, lastMix), uShockWheel);
        col += shockCol * uShockGlow * mShock;
        alpha = max(alpha, mShock * min(1.0, uShockGlow));
      }
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
// THE CORE'S OWN CLOCK AND ITS TWO EVENTS.
//
// The drop churns on `coreClock`, which is REAL time — the ring is handed
// realDt by main.js, and a liquid that stops moving because the game hit-stops
// for 60ms reads as the meter having frozen rather than as the world having.
//
// `burstFill` is the one piece of state the shader cannot derive. A release
// sets `pending` to 0 on the frame it fires, so by the time the drop is being
// blown apart there is nothing left in the model saying how big it was — the
// size is latched here, off the rising edge of the spend flash, and held for
// as long as the burst runs.
// ---------------------------------------------------------------------------
let coreClock = 0;
let coreChurn = 0;   // integrated, not clock * rate: the rate itself moves
let coreFill = 0;    // the fill DRAWN last frame — see burstFill
let burstFill = 0;
let lastFlash = 0;

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
  coreClock = 0;
  coreChurn = 0;
  coreFill = 0;
  burstFill = 0;
  lastFlash = 0;
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

// ---------------------------------------------------------------------------
// THE CORE — the drop of goo, its perfect-charge pop, and the release that
// blows it apart. Everything here is written into uniforms; nothing in this
// function touches the model, and none of it can change what a strike is
// worth. See the top of the file for what the drop is and why.
// ---------------------------------------------------------------------------
function updateCore(dt, strikeState, u, ring) {
  const g = ring.core ?? {};
  const on = g.enabled !== false;
  u.uCore.value = on ? 1 : 0;
  if (!on) {
    // The shock ring is the drop's own event and is drawn outside the block
    // `uCore` gates, so switching the core off has to silence it here or a
    // perfect charge would throw a ring off nothing.
    u.uShockGlow.value = 0;
    return;
  }

  // HOW MUCH POWER IS WORTH DRAWING, and how small the smallest drop is.
  // Below `minFill` there is nothing: a couple of pixels of green under the
  // seal is not a readout, it is dirt. Above it the fill is mapped onto the
  // band between `floor` and 1 rather than onto 0..1, because the meter is
  // drawn BEHIND the animal and an honest mapping spends its first third
  // hidden inside the silhouette. See the note by `floor` in CONFIG.
  const minFill = Math.max(0, g.minFill ?? 0.05);
  const floor = Math.max(0, Math.min(0.95, g.floor ?? 0.35));
  // Skipped while a release is being drawn: the burst below owns the size for
  // the whole of it, and it is drawing a value that was already mapped.
  if ((strikeState.flash ?? 0) <= 0) {
    u.uPending.value = u.uPending.value < minFill
      ? 0
      : floor + (1 - floor) * u.uPending.value;
  }

  const iso = g.iso ?? 0.42;
  const lobes = Math.max(0, Math.min(7, Math.round(g.lobes ?? 6)));
  const wobble = g.wobble ?? 0.3;
  const lobeSize = g.lobeSize ?? 0.62;
  const breathe = g.breathe ?? 0.18;

  // WHERE THE SURFACE ACTUALLY IS. A splat peaks at 1 at its centre and falls
  // off cubically, so the isoline sits well inside the kernel: solving
  // (1 - q)^3 = iso gives surface = kernel * sqrt(1 - cbrt(iso)), which at the
  // shipped 0.42 is barely half of it. Left uncorrected, a full bank would
  // draw a drop half the size it asked for and every knob above would resize
  // it as a side effect — the exact failure CONFIG.fx.goo's `gore` group
  // documents from the other direction.
  //
  // The LOBES are in the reach too, because they are what the eye measures the
  // drop by: at the shipped numbers they stick out past the core's own surface
  // and it is their bulges that touch `innerRadiusMul`, not the ball behind
  // them. Where a lobe overlaps the core the two densities sum and the weld
  // pushes a few percent further still; that is the goo doing its job and is
  // not worth a correction term.
  const isoScale = Math.sqrt(Math.max(1e-4, 1 - Math.cbrt(Math.max(1e-4, iso))));
  const reach = Math.max(isoScale, (wobble + lobeSize * isoScale) * (1 + breathe));
  u.uCoreK.value = 1 / Math.max(1e-3, reach);

  u.uLobes.value = lobes;
  u.uWobble.value = wobble;
  u.uLobeSize.value = lobeSize;
  u.uBreathe.value = breathe;
  u.uIso.value = iso;
  u.uSoft.value = g.soft ?? 0.12;
  u.uBody.value = g.body ?? 0.5;
  u.uRim.value = g.rim ?? 0.9;
  u.uRimWidth.value = g.rimWidth ?? 0.5;
  u.uSpec.value = g.spec ?? 0.3;
  u.uSpecPower.value = g.specPower ?? 14;
  u.uNormal.value = g.normal ?? 0.5;
  u.uLight.value.set(g.lightX ?? -0.5, g.lightY ?? 0.85);

  // --- THE PERFECT CHARGE, ringing out ------------------------------------
  // `perfectFlash` counts DOWN from perfectFlashTime, so the envelope is built
  // off elapsed time rather than off the remainder: a pop is an attack and a
  // settle, and the attack is the part that has to be visible. Ninety
  // milliseconds of swell and the rest easing back is what separates it from
  // the instantaneous step a bare decay would draw — the same finding as the
  // pip pops above, where brightness alone read as a twinkle.
  const flashTime = Math.max(0.01, CONFIG.strike.charge.perfectFlashTime ?? 0.5);
  const left = Math.max(0, Math.min(flashTime, strikeState.perfectFlash ?? 0));
  const gone = 1 - left / flashTime;          // 0 at the landing, 1 when spent
  const attack = 0.18;
  const pop = left <= 0 ? 0
    : gone < attack
      ? ease('outQuad', gone / attack)
      : 1 - ease('outCubic', (gone - attack) / (1 - attack));

  // --- THE RELEASE, blowing it apart --------------------------------------
  // Driven off the SPEND FLASH, which is set on the frame the dash launches
  // and only then, so the ring's white blowout and the drop coming apart are
  // one event on one clock. The rising edge is what latches the size: `pending`
  // is already 0 by the time this runs.
  const spendTime = Math.max(0.01, CONFIG.strike.charge.flashTime ?? 0.28);
  const flash = Math.max(0, strikeState.flash ?? 0);
  // LAST FRAME'S fill, not this frame's. tryStrike sets `pending` to 0 and the
  // flash on the SAME frame, and the spring above has already snapped to the
  // new zero by the time this runs — so reading the live value latches a burst
  // of size nothing, and the drop vanishes instead of coming apart. The value
  // being latched is the one the player was last shown.
  if (flash > lastFlash + 1e-6) burstFill = coreFill;
  lastFlash = flash;
  const bursting = flash > 0 && burstFill > 0;
  // 0 on the frame it fires, 1 when the spray is gone.
  const burst = bursting ? ease(g.burstEase ?? 'outCubic', 1 - flash / spendTime) : 0;

  if (bursting) {
    // The drop is drawn at the size it was RELEASED at for the whole burst.
    // Springing it down to zero as well would be the meter emptying and the
    // meter bursting at the same time, and the two read as one weak event.
    u.uPending.value = burstFill;
    u.uCoreMul.value = 1 + (Math.max(0, g.burstCore ?? 0.1) - 1) * burst;
    u.uLobeMul.value = 1 + (Math.max(0, g.burstShrink ?? 0.45) - 1) * burst;
    // The impulse itself: outward, from the centre, in the units the rest of
    // the instrument is drawn in.
    u.uSpread.value = (g.burstSpread ?? 0.62) * burst;
    // Held at full while the spray is still a spray, then taken off. Fading
    // from the first frame would hide the tearing, which is the part worth
    // watching.
    const fadeFrom = Math.min(0.99, Math.max(0, g.burstFade ?? 0.35));
    u.uCoreFade.value = burst <= fadeFrom ? 1 : 1 - (burst - fadeFrom) / (1 - fadeFrom);
    // Brightest on the frame it tears and falling with the spray. `pop` is
    // still in there because a strike released the instant a perfect charge
    // landed is both events at once, and the louder of the two should win.
    u.uCorePop.value = Math.max(pop, 1 - burst);
    // A burst only ever follows a release that FIRED, which by definition had
    // enough banked to fire — so the spray keeps the ready hue even though
    // `pending` is already back to zero and `uArmed` would otherwise drop it
    // back to the charging colour halfway through.
    u.uArmed.value = 1;
  } else {
    burstFill = 0;
    u.uCoreMul.value = 1;
    u.uLobeMul.value = 1;
    u.uSpread.value = 0;
    u.uCoreFade.value = 1;
    u.uCorePop.value = pop;
    // The perfect pop swells the drop past its own full radius. On uPending
    // rather than on a scale uniform of its own, so it travels through the
    // same isoline correction as every other size in here and cannot drift
    // away from what `innerRadiusMul` promises.
    if (pop > 0) u.uPending.value = Math.min(1.6, u.uPending.value * (1 + ((g.popScale ?? 1.5) - 1) * pop));
  }
  u.uCorePopGlow.value = bursting ? (g.burstGlow ?? 1.8) : (g.popGlow ?? 4.5);
  // What the drop was drawn at this frame, for the release above to latch. Not
  // updated during a burst, which is already drawing the latched value.
  if (!bursting) coreFill = u.uPending.value;

  // --- THE CHURN ----------------------------------------------------------
  // Integrated rather than clock x rate: the rate itself jumps on a pop and on
  // a release, and multiplying a running clock by a changed rate teleports the
  // lobes to a new arrangement instead of accelerating them from where they
  // were.
  coreClock += dt;
  const churnRate = (g.churn ?? 0.55)
    * (1 + ((g.popChurn ?? 5) - 1) * pop)
    * (bursting ? 1 + ((g.burstChurn ?? 2.5) - 1) * (1 - burst) : 1);
  coreChurn += churnRate * dt * Math.PI * 2;
  u.uChurn.value = coreChurn;
  u.uBreathePhase.value = coreClock * (g.breatheHz ?? 0.9) * Math.PI * 2;
  // The lobes fling outward as the surface tension lets go, on top of whatever
  // the release is doing — a perfect charge that is spent immediately gets
  // both, which is exactly what happens.
  u.uWobble.value = wobble * (1 + ((g.popWobble ?? 2.2) - 1) * pop);

  // --- THE SHOCK RING off a perfect charge --------------------------------
  // Not part of the drop and deliberately not shaped like it: a thin, clean
  // band leaving at speed says the surface snapped, where a second blob would
  // just be more goo. It is the one thing in the instrument allowed to cross
  // the fuel ring.
  if (pop > 0 && left > 0) {
    const t = ease('outCubic', gone);
    u.uShockR.value = (g.ringFrom ?? 0.6) + ((g.ringTo ?? 1.4) - (g.ringFrom ?? 0.6)) * t;
    u.uShockW.value = Math.max(0.01, g.ringWidth ?? 0.1);
    u.uShockWheel.value = Math.max(0, Math.min(1, g.ringWheel ?? 1));
    u.uShockGlow.value = (g.ringGlow ?? 3.2) * (1 - gone) * (1 - gone);
  } else {
    u.uShockGlow.value = 0;
  }
}

/**
 * THE LEAD-IN — the release moment drawn as something you can SEE COMING.
 *
 * A pure mapping of one number onto one radius: the seconds between now and
 * the moment a release would be on the beat, onto where the traveller sits
 * between the core and the fuel ring.
 *
 *   offset -time  the traveller is born at the core's own reach
 *   offset     0  it is ON the fuel ring — let go
 *   offset +time  it has expanded past and is leaving
 *
 * LINEAR, and it has to be. This is a clock being read, and any easing on it
 * would make the ring travel at a speed that does not match the time it is
 * reporting — the moment would arrive early or late by however much the curve
 * bent, which is precisely the failure the whole cue exists to fix.
 *
 * IT CANNOT MOVE THE GATE. `releaseOffset` is the same expression tryStrike
 * judges the release with (systems/strike.js) and `sweetHalfWidth` is the same
 * tolerance, so the band drawn here is the window by construction rather than
 * by two files agreeing to use the same number.
 */
function updateLead(strikeState, u, ring, stats) {
  const g = ring.lead ?? {};
  const time = Math.max(0.05, g.time ?? 0.5);
  const offset = releaseOffset(strikeState);

  // NOTHING TO LEAD INTO. No wind-up in hand (`pending` is 0 from the frame a
  // strike is spent, see clearPending), or the moment is further off than the
  // cue is meant to reach.
  if (g.enabled === false || !(strikeState.pending > 0)
    || !Number.isFinite(offset) || Math.abs(offset) > time) {
    u.uLeadGlow.value = 0;
    u.uSweetGlow.value = 0;
    return;
  }

  const span = Math.max(0.01, g.span ?? 0.3);
  const half = sweetHalfWidth(stats);
  // INWARD. The traveller is born OUTSIDE the instrument and closes on the fuel
  // ring, which is the approach every rhythm game converged on and is not the
  // direction this started in.
  //
  // Outward, from the core, read better on paper — born at the drop's own
  // surface, the same gesture as the power being banked. It cannot work: the
  // goo reaches 0.84 of the ring radius at a full bank (measured, see
  // tools/looks/boost-core.js), so the first third of the travel is drawn
  // INSIDE the drop, in front of a bright green blob, which is exactly the
  // stretch of the approach the player is meant to be reading. Coming in from
  // outside, the only thing it crosses is the chain arc at 1.14, and that for
  // one frame.
  u.uLeadR.value = 1 - (offset / time) * span;
  u.uLeadW.value = Math.max(0.005, g.width ?? 0.055);
  // The tolerance through the SAME mapping, so what the band covers and what
  // the gate accepts are the same span of time by construction.
  u.uSweetW.value = Math.max(0.005, (half / time) * span);
  u.uLeadHit.value = Math.abs(offset) <= half ? 1 : 0;

  // ARRIVING RATHER THAN APPEARING. Faded over the first slice of the
  // approach — a cue that pops into existence is itself an event, and this one
  // is on screen precisely to stop the player reacting to events.
  const fade = Math.max(0, Math.min(0.99, g.fadeIn ?? 0.25));
  const age = 1 - Math.min(1, Math.max(0, -offset) / time);   // 0 at birth, 1 at the moment
  const fadeIn = fade <= 0 ? 1 : Math.min(1, age / fade);
  // ...AND LEAVING AFTER IT. Past the moment the traveller is heading into the
  // drop, and a miss should not end with the cue sitting on top of the core at
  // full brightness arguing for a release that is already gone.
  const fadeOut = offset <= 0 ? 1 : 1 - Math.min(1, offset / time);
  const lit = fadeIn * fadeOut;
  u.uLeadGlow.value = (g.glow ?? 1) * lit;
  u.uSweetGlow.value = (g.sweetGlow ?? 0.45) * lit;
}

export function createStrikeRing() {
  const geometry = new THREE.PlaneGeometry(2 * OVERSCAN, 2 * OVERSCAN);
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
      uInnerGlow: { value: ring.innerGlowMul ?? 0.55 },
      uCore: { value: 1 },
      uCoreK: { value: 2 },
      uLobes: { value: 6 },
      uWobble: { value: 0.3 },
      uLobeSize: { value: 0.62 },
      uChurn: { value: 0 },
      uBreathe: { value: 0.18 },
      uBreathePhase: { value: 0 },
      uIso: { value: 0.42 },
      uSoft: { value: 0.12 },
      uBody: { value: 0.5 },
      uRim: { value: 0.9 },
      uRimWidth: { value: 0.5 },
      uSpec: { value: 0.3 },
      uSpecPower: { value: 14 },
      uNormal: { value: 0.5 },
      uLight: { value: new THREE.Vector2(-0.5, 0.85) },
      uCorePop: { value: 0 },
      uCorePopGlow: { value: 4.5 },
      uCoreMul: { value: 1 },
      uLobeMul: { value: 1 },
      uSpread: { value: 0 },
      uCoreFade: { value: 1 },
      uShockR: { value: 0 },
      uShockW: { value: 0 },
      uShockGlow: { value: 0 },
      uShockWheel: { value: 1 },
      uChainR: { value: ring.chainRadiusMul ?? 1.14 },
      uChainLeft: { value: 0 },
      uLeadR: { value: 1 },
      uLeadW: { value: 0.055 },
      uLeadGlow: { value: 0 },
      uLeadHit: { value: 0 },
      uSweetW: { value: 0.05 },
      uSweetGlow: { value: 0 },
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

  updateCore(dt, strikeState, u, ring);
  updateLead(strikeState, u, ring, stats);

  u.uThickness.value = ring.thickness;
  u.uGap.value = ring.segmentGap;
  u.uInnerR.value = ring.innerRadiusMul ?? 0.58;
  u.uInnerGlow.value = ring.innerGlowMul ?? 0.55;
  u.uChainR.value = ring.chainRadiusMul ?? 1.14;
  u.uColor.value.set(ring.color);
  u.uReadyColor.value.set(ring.readyColor);
  // THE CHAIN ARC WEARS THE CHAIN'S OWN COLOUR, off the same hue wheel as the
  // FOOD CHAIN! banner and the STRIKE NOW! prompt (systems/chainColor.js), so
  // the three surfaces reporting one run of links cannot say three different
  // things. `ring.comboColor` is what it falls back to with no chain running,
  // which is also what liveChain() reading 0 lands on, so the swatch in the
  // tuner is still the colour of a chain's first link.
  //
  // Set from a HEX for the same reason every other colour on this ring is:
  // .set() runs the sRGB -> working-space conversion and setRGB would skip it,
  // which would put the arc at a different brightness from the ring it rides
  // outside. And a caution rather than a bug — the wheel cannot equalise
  // BLOOM: the bright pass thresholds LUMINANCE, which is 7% blue, so the cold
  // third of the wheel haloes visibly less than the warm third at the same
  // saturation. See npm run glow.
  u.uComboColor.value.set(liveChain() > 0 ? chainHex(liveChain()) : ring.comboColor);
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
