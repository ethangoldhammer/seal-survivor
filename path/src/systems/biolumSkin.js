import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { advanceCycles, phaseOffset } from './beatSync.js';

// ============================================================================
// BIOLUMINESCENT SKIN — procedural glow PATTERNS painted across a whole body.
//
// The sibling to systems/bioluminescence.js, and deliberately not the same
// thing. That system answers "how far along THIS tentacle are we, and is that
// tentacle busy" — one intensity per region, driven by gameplay. This one
// answers "what does the light on this animal look like": patches, spots,
// stripes, veins, a travelling pulse. No gameplay reads it and no rig feeds
// it; it is surface, the way an emissive map is surface, except generated.
//
// WHY NOT AN EMISSIVE MAP. Because the point is CHOICE. Ten patterns times a
// three-colour ramp times coverage/contrast/warp is a space you explore on
// sliders in ten seconds; as textures it is ten files per fish, repainted
// every time the palette moves.
//
// WHY THE PATTERN IS SAMPLED IN NORMALISED BIND-POSE SPACE
//
// Two attributes are baked at attach time, both unitless:
//
//   aBioPos    the vertex position inside the mesh's own bounding box,
//              divided by the box's LONGEST side and centred. Proportions
//              survive (a fish is not squashed to a cube) but absolute size
//              does not, so `scale: 0.2` means the same number of spots on a
//              0.4-unit lanternfish and a 40-unit whale.
//   aBioAxis   0 at the head end, 1 at the tail end, along whichever local
//              axis the box is longest on. Stripes and travelling pulses run
//              along it, which is what makes them read as anatomy instead of
//              as a pattern projected from outside.
//
// Baked from `position` (bind pose) and read in the vertex shader right after
// <begin_vertex>, so the pattern deforms WITH the swimming body rather than
// swimming across it. Same reasoning as systems/noiseShader.js, written out
// there at length.
//
// This normalisation is not a nicety. Per-asset size multipliers are live in
// the tuner, and any feature size in world units would silently change every
// pattern the moment someone dragged a creature's Size slider.
//
// RENDERING. Injected into whatever material the model already has via
// onBeforeCompile, ADDED to the final colour at <dithering_fragment> — the
// one chunk that exists in basic, lambert, phong and standard alike, so this
// lights the `unlit: true` half of the roster as readily as a lit body.
// (Hooking <emissivemap_fragment> instead would skip every unlit model, which
// is most of the fish.) A second, separate hook at <map_fragment> optionally
// DARKENS the base colour, because the glow only reads as light if the body
// under it reads as dark — see `bodyDarken`.
//
// Strength above 1 is meaningful and intended: post.js renders the bright
// pass to a HalfFloat target, so an over-bright pattern blooms instead of
// clipping. Keep the base colours saturated and mid-dark and let `strength`
// carry them past 1 — a pale colour AT high strength is how you get a white
// blob with no pattern in it. See the note in glow-clips memory territory:
// the composite is LDR, so anything already near white has nowhere to go.
//
// THE SHADER IS HANDED PHASES, NOT A CLOCK. There is no uTime in here. Three
// separate positions arrive as uniforms — a drift, a breath/travel cycle and a
// flicker step — each computed on the CPU in updateBiolumSkin. That is what
// lets the same GLSL run a breath at 1.8 rad/s or at exactly one per two bars
// of the loop that's playing, and it is why "keep time with the music" costs
// no branch per fragment. See systems/beatSync.js for the transport, and the
// note on updateBiolumSkin for why a synced phase is derived while a free one
// is integrated.
//
// PATTERN SELECTION IS A UNIFORM, NOT A #define. All ten live in the
// compiled shader and an `int` picks between them. That costs a handful of
// dead instructions the GPU never reaches (the branch is uniform, so every
// fragment in the draw takes the same path) and buys the thing that actually
// matters here: the tuner dropdown changes the look on creatures ALREADY
// SWIMMING, with no recompile and no respawn. Comparing ten patterns is the
// entire workflow this exists for, and a recompile per comparison would make
// it a chore.
// ============================================================================

// The dropdown's values, in the order they appear in the tuner. The index is
// what reaches the shader, so this array IS the wire format — appending is
// safe, reordering silently repaints every tuned fish.
export const BIOLUM_PATTERNS = [
  'blotches', // soft mottled patches — the default "deep sea animal" read
  'spots', // discrete round photophores, one colour each
  'net', // glowing web along the borders between cells
  'stripes', // bands across the body, warped so they aren't ruled lines
  'veins', // ridged filaments branching over the skin
  'pulse', // travelling waves running head to tail
  'speckle', // a fine dust of tiny bright points
  // --- the organic family, the same shapes the menus dissolve through ---
  'flow', // domain-warped fbm — ink pulled through water
  'billow', // puffy rounded lobes
  'marble', // turbulence-folded veining
];

export function patternIndex(name) {
  const i = BIOLUM_PATTERNS.indexOf(name);
  return i < 0 ? 0 : i;
}

const GLSL = `
uniform int   uBioPattern;
// THREE CLOCKS, NOT ONE, and none of them is a time in seconds. Each is
// already the phase the shader wants, computed on the CPU by updateBiolumSkin
// so that a musical division ('1 bar') and a free-running rate ('1.8 rad/s')
// are the same two floats down here — see systems/beatSync.js. A shader that
// took a raw time and a rate could only ever run free.
uniform float uBioDrift;    // distance the pattern field has travelled (not a cycle)
uniform float uBioCycle;    // breath/travel position in CYCLES, wrapped to [0,2)
uniform float uBioFlickerT; // the flicker's noise coordinate, in whole steps
uniform float uBioScale;
uniform float uBioStrength;
uniform float uBioContrast;
uniform float uBioCoverage;
uniform float uBioPulseAmp;
uniform float uBioHueScale;
uniform float uBioHueSpread;
uniform float uBioTailBias;
uniform float uBioHueBias;
uniform float uBioWarp;
uniform float uBioFlickerAmp;
uniform float uBioBodyDarken;
uniform vec3  uBioColorA;
uniform vec3  uBioColorB;
uniform vec3  uBioColorC;
varying vec3  vBioPos;
varying float vBioAxis;
varying float vEyeGlow;
uniform vec3 uEyeColor;
uniform float uEyeStrength;
uniform float uEyeFalloff;
uniform float uEyePulse;

vec3 bioHash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

// 0..1 scalar per lattice cell. Voronoi needs a per-cell FEATURE POINT and a
// per-cell random number for its colour; this is the second of those.
float bioHash1(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
}

// Classic gradient (Perlin) noise, matching systems/noiseShader.js. Value
// noise would be cheaper, but its axis-aligned blockiness is exactly what
// shows up as a grid of glowing squares at these low frequencies.
float bioPerlin(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(dot(bioHash3(i + vec3(0.0, 0.0, 0.0)), f - vec3(0.0, 0.0, 0.0)),
            dot(bioHash3(i + vec3(1.0, 0.0, 0.0)), f - vec3(1.0, 0.0, 0.0)), u.x),
        mix(dot(bioHash3(i + vec3(0.0, 1.0, 0.0)), f - vec3(0.0, 1.0, 0.0)),
            dot(bioHash3(i + vec3(1.0, 1.0, 0.0)), f - vec3(1.0, 1.0, 0.0)), u.x), u.y),
    mix(mix(dot(bioHash3(i + vec3(0.0, 0.0, 1.0)), f - vec3(0.0, 0.0, 1.0)),
            dot(bioHash3(i + vec3(1.0, 0.0, 1.0)), f - vec3(1.0, 0.0, 1.0)), u.x),
        mix(dot(bioHash3(i + vec3(0.0, 1.0, 1.0)), f - vec3(0.0, 1.0, 1.0)),
            dot(bioHash3(i + vec3(1.0, 1.0, 1.0)), f - vec3(1.0, 1.0, 1.0)), u.x), u.y), u.z);
}

// Four octaves rather than noiseShader's three: this one is asked for veins
// and filaments, which are the top octave. Fixed count on purpose — a uniform
// octave count means a recompile on every slider move.
float bioFbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * bioPerlin(p);
    p *= 2.02; // not exactly 2, so the octave lattices never line up
    a *= 0.5;
  }
  return v;
}

// |perlin| summed per octave rather than the signed value — the 'billow' of
// ui/dither.js's NOISE_ALGOS. Every octave's zero crossing becomes a crease,
// and stacking creases gives rounded, puffy, cauliflower lobes instead of the
// smooth hills of ordinary fbm. Its opposite number is the ridged field
// 'veins' uses; between them they are the two ways to make fbm organic.
float bioBillow(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * abs(bioPerlin(p));
    p *= 2.02;
    a *= 0.5;
  }
  return v;
}

// DOMAIN WARP — fbm sampled at a position that fbm itself displaced. This is
// the one operation that turns noise from "blobs" into "flow": the pattern
// stops being a field of lumps and starts looking advected, like ink pulled
// through water, because the sample grid is itself curved.
//
// Three decorrelated offsets, not one shared displacement: a single scalar
// pushed into all three axes moves the sample point along a diagonal and the
// result just looks smeared. Three separate fields curve it.
vec3 bioWarp(vec3 p, float amount) {
  vec3 q = vec3(
    bioFbm(p + vec3(0.0, 0.0, 0.0)),
    bioFbm(p + vec3(5.2, 1.3, 9.7)),
    bioFbm(p + vec3(9.1, 7.4, 2.8))
  );
  return p + q * amount;
}

// FLICKER — 1D value noise in time, not a sine. A sine is a throb, which is
// what 'breathe' already does; a real photophore stutters. Two octaves at a
// non-harmonic ratio so the stutter never settles into a countable rhythm.
//
// Its output is 0..1 with the mean near the top, because this is used as a
// DIP: light spends most of its time on and drops out briefly, which is the
// asymmetry that reads as a living thing rather than as a strobe.
float bioFlicker(float t) {
  float i0 = floor(t);
  float f0 = fract(t);
  f0 = f0 * f0 * (3.0 - 2.0 * f0);
  float a = mix(bioHash1(vec3(i0, 0.0, 0.0)), bioHash1(vec3(i0 + 1.0, 0.0, 0.0)), f0);

  float t2 = t * 2.37;
  float i1 = floor(t2);
  float f1 = fract(t2);
  f1 = f1 * f1 * (3.0 - 2.0 * f1);
  float b = mix(bioHash1(vec3(i1, 9.0, 0.0)), bioHash1(vec3(i1 + 1.0, 9.0, 0.0)), f1);

  return clamp(0.35 + 0.65 * (a * 0.7 + b * 0.3) * 1.6, 0.0, 1.0);
}

// Voronoi over a 3x3x3 neighbourhood. Returns:
//   x  distance to the nearest feature point (F1)
//   y  distance to the second nearest (F2) — F2-F1 is the cell BORDER field
//   z  a 0..1 random id for the nearest cell, which is what lets every
//      photophore pick its own colour instead of the school sharing one.
vec3 bioVoronoi(vec3 p) {
  vec3 ip = floor(p);
  vec3 fp = fract(p);
  float f1 = 8.0;
  float f2 = 8.0;
  float id = 0.0;
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      for (int z = -1; z <= 1; z++) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 cell = ip + g;
        // 0.5 + 0.5*hash keeps the point inside its own cell, which is what
        // makes the 3x3x3 search exhaustive rather than merely usual.
        vec3 pt = g + 0.5 + 0.5 * bioHash3(cell);
        float d = length(pt - fp);
        if (d < f1) { f2 = f1; f1 = d; id = bioHash1(cell + 0.37); }
        else if (d < f2) { f2 = d; }
      }
    }
  }
  return vec3(f1, f2, id);
}

// Three-stop ramp. 't' is 0..1 and comes either from a smooth noise field
// (continuous patterns) or from a cell id (the voronoi ones), which is the
// whole difference between "the colour drifts across the body" and "each dot
// is its own colour".
vec3 bioRamp(float t) {
  t = clamp(t, 0.0, 1.0);
  return t < 0.5 ? mix(uBioColorA, uBioColorB, t * 2.0)
                 : mix(uBioColorB, uBioColorC, (t - 0.5) * 2.0);
}

// Shape a raw 0..1 field into a mask. 'uBioCoverage' slides the threshold —
// high coverage lights most of the body, low keeps it to the brightest
// crests — and 'uBioContrast' decides whether the edge is a hard rim or a
// soft wash. The softness floor stops contrast from ever producing an
// aliased one-pixel edge that crawls as the fish swims.
float bioMask(float v) {
  float soft = max(0.03, 0.5 / max(0.05, uBioContrast));
  float edge = 1.0 - clamp(uBioCoverage, 0.0, 1.0);
  return smoothstep(edge - soft, edge + soft, v);
}
`;

// Runs where gl_FragColor is already final, so nothing the material was doing
// is disturbed. 'mask' and 'hue' are computed per pattern; everything after
// the branch is shared, which is what keeps the seven looking like one
// creature's biology rather than seven unrelated effects.
const FRAG_BODY = `
  {
    vec3 bp = vBioPos / max(0.01, uBioScale);
    // The whole field drifts slowly. On a still pattern this is what stops it
    // looking like a decal.
    //
    // DELIBERATELY NOT BEAT-SYNCED. Drift is a translation through the noise
    // field — it never comes back round, so there is no cycle to quantise and
    // "one drift per bar" would only mean something if the pattern repeated,
    // which noise does not. The three things below that DO repeat are synced;
    // this one is honestly a rate in seconds. See systems/beatSync.js.
    vec3 drift = vec3(0.0, 0.0, uBioDrift);

    float bioMaskV = 0.0;
    float bioHue = 0.0;

    if (uBioPattern == 0) {          // blotches
      float n = bioFbm(bp + drift) * 0.5 + 0.5;
      bioMaskV = bioMask(n);
      bioHue = bioFbm(bp / max(0.05, uBioHueScale) + 17.3) * uBioHueSpread + 0.5;
    } else if (uBioPattern == 1) {   // spots
      vec3 v = bioVoronoi(bp + drift);
      // Distance from the cell's centre, inverted: a round falloff, not a
      // thresholded blob, so a photophore has a hot core and a soft halo.
      bioMaskV = bioMask(1.0 - v.x);
      // Half the cells go dark, so the spots read as scattered organs rather
      // than as a regular lattice with every seat filled.
      if (v.z < 0.45) bioMaskV = 0.0;
      bioHue = fract(v.z * 3.7) * uBioHueSpread + 0.5;
    } else if (uBioPattern == 2) {   // net
      vec3 v = bioVoronoi(bp + drift);
      // F2-F1 is zero exactly on a border between two cells and grows inward,
      // so inverting it lights the seams. The x4 is what makes it a NET: in
      // 3D that difference rarely exceeds ~0.25, so the raw field is near 1
      // over almost the whole body and inverting it alone lights everything.
      bioMaskV = bioMask(1.0 - min((v.y - v.x) * 4.0, 1.0));
      bioHue = fract(v.z * 2.3) * uBioHueSpread + 0.5;
    } else if (uBioPattern == 3) {   // stripes
      // Warped by fbm before the sine, which is the difference between bands
      // that follow the animal and bands ruled across it with a straightedge.
      float warp = bioFbm(bp * 0.6 + drift) * 1.6;
      float s = sin(vBioAxis * 6.2831 * max(0.5, 3.0 / max(0.05, uBioScale)) + warp);
      bioMaskV = bioMask(s * 0.5 + 0.5);
      bioHue = vBioAxis * uBioHueSpread + 0.5;
    } else if (uBioPattern == 4) {   // veins
      // Ridged turbulence: |fbm| has a crease at every zero crossing, and
      // inverting it turns those creases into filaments. The x2.5 before the
      // inversion is what keeps them FILAMENTS — four-octave fbm spends most
      // of its range near zero, so 1-|fbm| on its own is close to 1 across
      // the whole body and the "veins" come out as a solid wash.
      float r = clamp(1.0 - abs(bioFbm(bp + drift)) * 2.5, 0.0, 1.0);
      bioMaskV = bioMask(r * r);
      bioHue = bioFbm(bp / max(0.05, uBioHueScale) - 4.1) * uBioHueSpread + 0.5;
    } else if (uBioPattern == 5) {   // pulse
      // A wave travelling head to tail, MASKED by a static noise field so the
      // light moves through the body's own patchwork instead of sweeping it
      // as a clean bar.
      //
      // Two travelling waves per breath cycle, which is the ratio this had
      // when both were driven off pulseSpeed — so setting the breath to
      // '1 bar' puts a wave down the body on beats 1 and 3.
      float wave = sin(vBioAxis * 12.0 / max(0.2, uBioScale * 4.0) - uBioCycle * 2.0 * 6.2831853);
      float patches = bioFbm(bp) * 0.5 + 0.5;
      bioMaskV = bioMask((wave * 0.5 + 0.5) * (0.4 + 0.6 * patches));
      // The colour crawls at half a cycle per breath. It is a fract(), not a
      // sin(), which is the reason uBioCycle wraps at 2 rather than at 1: at
      // wrap 1 this term would jump from 0.5 back to 0 every cycle and the
      // hue would visibly snap. See the wrap argument to advanceCycles.
      bioHue = fract(vBioAxis - uBioCycle * 0.5) * uBioHueSpread + 0.5;
    } else if (uBioPattern == 6) {   // speckle
      // Same voronoi at a much higher frequency, kept to the cell cores only.
      vec3 v = bioVoronoi(bp * 4.0 + drift);
      bioMaskV = bioMask(1.0 - v.x * 1.6);
      bioHue = fract(v.z * 5.1) * uBioHueSpread + 0.5;
    } else if (uBioPattern == 7) {   // flow
      // Domain-warped fbm. The COLOUR field is warped by the same displacement
      // as the mask, which is what makes a patch look like one substance
      // flowing rather than a shape with an unrelated tint laid over it.
      vec3 w = bioWarp(bp + drift, uBioWarp);
      bioMaskV = bioMask(bioFbm(w) * 0.5 + 0.5);
      bioHue = bioFbm(w / max(0.05, uBioHueScale) + 3.7) * uBioHueSpread + 0.5;
    } else if (uBioPattern == 8) {   // billow
      // Puffy lobes. Inverted, because the billow field is BRIGHT at the
      // creases and dark inside the lobes — lighting it raw would glow along
      // the gaps between the clumps rather than on the clumps themselves.
      float b = bioBillow(bioWarp(bp + drift, uBioWarp * 0.5));
      bioMaskV = bioMask(1.0 - b * 1.8);
      bioHue = bioBillow(bp / max(0.05, uBioHueScale)) * 2.0 * uBioHueSpread + 0.3;
    } else {                         // marble
      // Ink in water: bands whose coordinate is displaced by turbulence, so
      // the lines fold back on themselves instead of running parallel. The
      // classic marble formula, and the reason the warp is applied to the
      // BAND COORDINATE rather than to the sample point is that displacing a
      // 1D coordinate is what makes veins, while displacing the 3D point just
      // makes wobbly noise.
      float turb = bioBillow(bp + drift) * 3.0;
      float band = sin((bp.x + bp.y * 0.35) * 6.2831 + turb * (1.0 + uBioWarp * 2.0));
      bioMaskV = bioMask(abs(band));
      bioHue = fract(turb * 0.4) * uBioHueSpread + 0.4;
    }

    // Head-to-tail bias. Positive concentrates light toward the tail,
    // negative toward the head; 0 leaves it even. Deep-sea animals are almost
    // never lit uniformly, and this is the cheapest way to say so.
    bioMaskV *= clamp(1.0 + uBioTailBias * (vBioAxis - 0.5) * 2.0, 0.0, 2.0);

    // ...and the same bias applied to COLOUR rather than to brightness, which
    // is a different statement about the animal. tailBias says "the light
    // gathers at one end"; this says "the light CHANGES colour along the
    // body" — the ramp is sampled further toward colorC at the high end and
    // further toward colorA at the low end. On the crab that is the whole
    // read: a dark red shell whose claws come out ember, from one pattern and
    // one ramp rather than a second material. Zero leaves the ramp exactly
    // where the pattern put it, so nothing that does not ask for it moves.
    bioHue += uBioHueBias * (vBioAxis - 0.5) * 2.0;

    // One global breath over the top of whatever the pattern is doing, and a
    // stutter over the top of THAT. Both clocks already carry this material's
    // per-INSTANCE offset, folded in on the CPU — that offset is the only
    // reason a school of nine doesn't breathe and blink in lockstep like one
    // animal with nine bodies. See phaseOffset in systems/beatSync.js for why
    // the offset is quantised as well as the rate.
    float breathe = 1.0 + uBioPulseAmp * sin(uBioCycle * 6.2831853);
    // Mixed toward rather than multiplied in, so amp 0 is exactly "off" and
    // no flicker maths can dim a creature that asked for none.
    breathe *= mix(1.0, bioFlicker(uBioFlickerT), uBioFlickerAmp);

    gl_FragColor.rgb += bioRamp(bioHue) * (bioMaskV * uBioStrength * breathe);
  }

  // THE EYES. Deliberately OUTSIDE the uBioStrength block above, and outside
  // the body pattern entirely: an eye is a lamp, not a patch of skin. The day
  // crab's shell is pigment with its glow turned down to nothing (the
  // carapace preset, luminous:false) and its eyes should still light up,
  // which cannot happen if this hangs off the pattern's strength.
  //
  // NO BACKTICKS ANYWHERE IN THIS STRING. It is a JS template literal, so one
  // in a comment ends it early and the SyntaxError points at the comment
  // rather than at the shader.
  //
  // pow() puts the brightness at the TIP. aEyeGlow is a linear 0..1 up the
  // stalk, so raising it to a power keeps the socket dark and blows out only
  // the last few millimetres — the eyeball. Falloff 1.0 would light the whole
  // stalk evenly, which reads as a glowing antenna rather than an eye.
  if (uEyeStrength > 0.0 && vEyeGlow > 0.0) {
    // Breathes on the same clock as the body so the two never drift into
    // looking like separate creatures, but at its own depth — an eye that
    // pulses as hard as the shell reads as a blinking light.
    float eyeBreathe = 1.0 + uEyePulse * sin(uBioCycle * 6.2831853);
    gl_FragColor.rgb += uEyeColor * (pow(vEyeGlow, uEyeFalloff) * uEyeStrength * eyeBreathe);
  }
`;

// Template materials — one per asset key, alive as long as the asset is.
const attached = new Set();

// Per-instance materials, held WEAKLY. There is one per spawned creature, so a
// ten-minute run creates thousands and a strong set would keep every one of
// them alive forever, walked by every slider drag.
//
// A WeakRef rather than a liveness test on the scene graph, and that choice
// was a bug first: "is the root still parented?" is wrong at BOTH ends — a
// creature is unparented for the moment between createVisual and the caller
// adding it to a container (which silently dropped every material on the frame
// it spawned), and after despawn its visual is still parented to the container
// that was removed, so it would never have been collected either. Ownership
// isn't observable from here. Reachability is, and it is exactly the question
// worth asking.
const instances = new Set();

// Every live material, template and instance, pruning WeakRefs whose material
// has been collected. The prune is why this is a generator over a live set
// rather than a snapshot.
function* liveMaterials() {
  yield* attached;
  let dead = null;
  for (const ref of instances) {
    const m = ref.deref();
    if (m) yield m;
    else (dead ??= []).push(ref);
  }
  if (dead) for (const ref of dead) instances.delete(ref);
}

/**
 * Light a material's whole surface with a procedural pattern.
 *
 * @param material the material to inject into (already cloned per instance by
 *                 the asset pipeline, so this never leaks across species).
 * @param mesh     the mesh it belongs to — needed for the bind-pose bounding
 *                 box the two attributes are normalised against.
 * @param preset   which block of CONFIG.biolumSkin.presets drives it. This is
 *                 what makes a glowing ray and a glowing fish two different
 *                 animals rather than the same effect at two sizes.
 * @param axisName optional 'x' | 'y' | 'z' — which local axis aBioAxis runs
 *                 along, overriding the longest-side derivation below. See
 *                 ASSETS.enemyWalkingCrab.biolumAxis for the creature that
 *                 needs it and why.
 */
export function attachBiolumSkin(material, mesh, preset = 'lantern', axisName = null, eyeStalks = null) {
  if (!material || material.userData.__bioSkin) return;
  const geom = mesh?.geometry;
  const pos = geom?.attributes?.position;
  if (!pos) return;

  // Baked once per geometry. Clones of one asset share the geometry, so the
  // guard means a school of forty fish bakes one set of attributes, not forty.
  if (!geom.attributes.aBioPos) {
    geom.computeBoundingBox();
    const box = geom.boundingBox;
    const size = new THREE.Vector3();
    const centre = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(centre);
    // The LONGEST side, not each side separately: dividing per axis would
    // stretch the pattern to fit the box and a fish's spots would come out
    // as ellipses.
    const longest = Math.max(size.x, size.y, size.z, 1e-6);
    // Which axis that is decides what "head to tail" means. On a FISH the
    // model's long axis is the body axis, which is why this can be derived at
    // all — but it is a derivation about anatomy dressed up as one about a
    // bounding box, and a crab breaks it. A crab is WIDER THAN IT IS LONG:
    // crabpincer.glb's bind-pose box is (0.476, 0.178, 0.321), so the longest
    // side is X, and X on a crab runs from one claw to the OTHER. Derived, the
    // gradient would light the left claw and black out the right; declaring
    // 'z' runs it front-to-back instead, which is the axis the animal actually
    // has. Nothing about this is marginal — X wins by 40% here, so no
    // re-export is going to fix it by accident.
    // tools/crab-claw-probe.mjs prints the box and the winning margin.
    const declared = axisName ? { x: 0, y: 1, z: 2 }[axisName] : undefined;
    if (axisName && declared === undefined) {
      console.warn(`[biolumSkin] biolumAxis "${axisName}" is not x, y or z — falling back to the longest side.`);
    }
    const axis = declared ?? (size.x >= size.y && size.x >= size.z ? 0 : (size.y >= size.z ? 1 : 2));
    const axisLo = box.min.getComponent(axis);
    const axisSpan = Math.max(1e-6, box.max.getComponent(axis) - axisLo);

    const bioPos = new Float32Array(pos.count * 3);
    const bioAxis = new Float32Array(pos.count);
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v);
      const y = pos.getY(v);
      const z = pos.getZ(v);
      bioPos[v * 3 + 0] = (x - centre.x) / longest;
      bioPos[v * 3 + 1] = (y - centre.y) / longest;
      bioPos[v * 3 + 2] = (z - centre.z) / longest;
      bioAxis[v] = ((axis === 0 ? x : axis === 1 ? y : z) - axisLo) / axisSpan;
    }
    geom.setAttribute('aBioPos', new THREE.BufferAttribute(bioPos, 3));
    geom.setAttribute('aBioAxis', new THREE.BufferAttribute(bioAxis, 1));
    geom.userData.__bioAxisName = axisName ?? 'auto';
    bakeEyeGlow(geom, mesh, eyeStalks);
  } else if ((geom.userData.__bioAxisName ?? 'auto') !== (axisName ?? 'auto')) {
    // The bake above is per GEOMETRY and the attributes are already there, so a
    // second attach asking for a different axis silently gets the first one's.
    // Today that cannot happen — loadedModels is keyed by asset key, so the two
    // crabs hold separate geometry even though they load the same file — but it
    // is exactly the kind of thing that starts happening the day someone adds a
    // geometry cache, and it would present as "the tuner's axis slider does
    // nothing on one variant".
    console.warn(`[biolumSkin] this geometry was already baked for axis "${geom.userData.__bioAxisName}"; the request for "${axisName ?? 'auto'}" is being ignored.`);
  }

  material.userData.__bioSkin = true;
  // Which block of CONFIG.biolumSkin.presets this material answers to. Carried
  // on the material rather than passed to applyBiolumSkinSettings, because by
  // the time a slider moves there is nothing left holding the asset key.
  material.userData.__bioSkinPreset = preset;

  const u = freshUniforms();
  material.userData.__bioSkinUniforms = u;
  material.userData.__bioSkinClock = freshClock();
  inject(material, u);
  attached.add(material);
  // The defaults in freshUniforms are what the shader would show if nobody
  // ever touched a slider. Pushing the live config immediately means a
  // material built AFTER boot — a re-uploaded model, an asset rebuilt by the
  // texture panel — comes up wearing the tuned look, not the built-in one.
  applyBiolumSkinSettings();
}

// Created up front rather than inside onBeforeCompile: that callback doesn't
// run until the material first renders, so settings pushed before the first
// frame — which is every setting, since main.js applies them at boot — would
// be silently dropped. Same reasoning as bioluminescence.js.
function freshUniforms() {
  return {
    uBioPattern: { value: 0 },
    uBioDrift: { value: 0 },
    uBioCycle: { value: 0 },
    uBioFlickerT: { value: 0 },
    uBioScale: { value: 0.25 },
    uBioStrength: { value: 1.6 },
    uBioContrast: { value: 1.4 },
    uBioCoverage: { value: 0.45 },
    uBioPulseAmp: { value: 0.25 },
    uBioHueScale: { value: 1.2 },
    uBioHueSpread: { value: 1.0 },
    uBioTailBias: { value: 0.2 },
    uBioHueBias: { value: 0 },
    uBioWarp: { value: 0.8 },
    uBioFlickerAmp: { value: 0 },
    uBioBodyDarken: { value: 0.35 },
    uBioColorA: { value: new THREE.Color(0x00e5ff) },
    uBioColorB: { value: new THREE.Color(0x7b2dff) },
    uBioColorC: { value: new THREE.Color(0xffd166) },
    // The eyes, independent of the body pattern — see the note where these are
    // used in FRAG_BODY. Strength 0 by default so every creature that does not
    // declare eye stalks is bit-for-bit unaffected.
    uEyeColor: { value: new THREE.Color(0xffd166) },
    uEyeStrength: { value: 0 },
    uEyeFalloff: { value: 3 },
    uEyePulse: { value: 0 },
  };
}

// The CPU-side half of the three clocks above. Kept off the uniform block on
// purpose: `cycle` here is the material's own un-offset position, and what
// reaches the shader is that plus the individual's phase offset. Folding the
// offset into the stored value instead would re-add it every frame and walk
// the whole school apart.
//
// `flick` is separate from `cycle` rather than derived from it because the two
// answer to different divisions — a shark can breathe on four bars while its
// photophores stutter on sixteenths, which is most of the point of having a
// picker per FX rather than one per creature.
function freshClock() {
  return { drift: 0, cycle: 0, flick: 0 };
}

function inject(material, u) {
  const previous = material.onBeforeCompile;
  // three keys compiled programs partly by the SOURCE of onBeforeCompile, and
  // every individual now carries its own material — pinning the key to a
  // constant means a school of forty shares ONE compiled program, which is
  // what makes the per-instance material affordable at all.
  material.customProgramCacheKey = () => 'bioSkin';
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    Object.assign(shader.uniforms, u);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 aBioPos;
attribute float aBioAxis;
attribute float aEyeGlow;
varying vec3 vBioPos;
varying float vBioAxis;`)
      // After <begin_vertex>: the attributes are per-vertex constants so the
      // position makes no difference to them, but sitting after that chunk
      // keeps this clear of the outline shells' rim push, which rewrites
      // `transformed` at exactly that point.
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  vBioPos = aBioPos;
  vBioAxis = aBioAxis;
  vEyeGlow = aEyeGlow;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL}`)
      // Darkening runs at <map_fragment> — on the base colour, BEFORE the
      // glow is added — so a bright pattern sits on a dark body instead of
      // being washed out by it, and so the darkening can never dim the glow
      // it exists to make legible.
      .replace('#include <map_fragment>', `#include <map_fragment>
  diffuseColor.rgb *= uBioBodyDarken;`)
      .replace('#include <dithering_fragment>', `${FRAG_BODY}\n#include <dithering_fragment>`);
  };
  material.needsUpdate = true;
}

// --- eye glow ---------------------------------------------------------------
// A second, much smaller gradient: 0 everywhere on the body, ramping to 1 at
// the tip of an eye stalk. `aEyeGlow` rides alongside aBioAxis and the shader
// adds a colour scaled by it, so a crab's eyes can burn while the shell stays
// where the pattern put it.
//
// WHY THIS IS NOT AN EMISSIVE MAP, which is the obvious way to do it:
//
//   1. THE EYES HAVE NO UV ISLAND. Measured on crabpincer.glb, the 208
//      eye-weighted vertices scatter over the whole atlas — their UV bounds
//      cover u 0.02..0.89, and 5,490 BODY vertices share that region. A
//      painted rectangle would light half the shell, so a mask would have to
//      be rasterised from the eye triangles into a whole extra 1024x1024.
//   2. HALF THE CREATURES THAT WANT IT CANNOT HAVE IT. An emissive map needs
//      MeshStandardMaterial. Anything `modelUnlit` — the ember crab, the
//      lantern ray, the abyss shark — is a MeshBasicMaterial with no
//      `emissive`, `emissiveMap` or `emissiveIntensity` slot at all, and
//      assets.js's applyEmissiveMode bails on exactly that check, silently.
//      biolumSkin already injects into BOTH the lit and unlit shaders, so a
//      vertex attribute reaches every creature a texture could not.
//   3. IT WOULD FIGHT THE TUNED LOOK. Turning a mask on neutralises the flat
//      emissive colour (see applyEmissiveMode), so an eyes-only mask replaces
//      whatever uniform glow a creature was tuned with rather than adding to
//      it.
//
// The bake is per GEOMETRY, like aBioPos, so a crowd of twenty costs one pass.
// Vertices with no eye weight get 0, which the shader multiplies out to
// nothing — a model that declares no stalks pays one float per vertex and
// renders identically.
function bakeEyeGlow(geom, mesh, stalks) {
  const pos = geom.attributes.position;
  const glow = new Float32Array(pos.count); // 0 everywhere by default
  const skeleton = mesh?.skeleton;

  if (Array.isArray(stalks) && stalks.length && skeleton) {
    const si = geom.attributes.skinIndex;
    const sw = geom.attributes.skinWeight;
    if (!si || !sw) {
      console.warn('[biolumSkin] eyeStalks declared but the mesh has no skinning attributes — no eye glow baked.');
    } else {
      const byName = new Map(skeleton.bones.map((b, i) => [b.name, i]));
      const v = new THREE.Vector3();
      const _m4 = new THREE.Matrix4();
      const base = new THREE.Vector3();
      const tip = new THREE.Vector3();
      const dir = new THREE.Vector3();

      for (const stalk of stalks) {
        const names = Array.isArray(stalk) ? stalk : [];
        if (names.length < 2) continue;
        const missing = names.filter((n) => !byName.has(n));
        if (missing.length) {
          console.warn(`[biolumSkin] eye stalk names not on this skeleton: ${missing.join(', ')} `
            + '— that stalk will not glow. Node names lose their dots on load '
            + '(Hand.6.L_046 becomes Hand6L_046), which is the usual cause.');
          continue;
        }
        const ids = new Set(names.map((n) => byName.get(n)));

        // Which vertices this stalk owns, gathered first because the axis is
        // derived from them.
        const owned = [];
        for (let i = 0; i < pos.count; i++) {
          let w = 0;
          for (let k = 0; k < 4; k++) if (ids.has(si.getComponent(i, k))) w += sw.getComponent(i, k);
          if (w > 0.001) owned.push(i, w);
        }
        if (owned.length < 12) continue; // too few to be a stalk

        // THE BASE comes from the first bone's BIND pose, via the inverse bind
        // matrix rather than bone.matrixWorld. Position attributes are in bind
        // space and matrixWorld is the CURRENT pose in world space; mixing the
        // two put the base 1.4 stalk-lengths off, drove every t negative, and
        // baked a solid-black attribute without throwing. Going through
        // boneInverses also makes the bake independent of when matrices were
        // last updated and of whatever pose the clip is in — which matters,
        // because this runs once per geometry and every clone inherits it.
        _m4.copy(skeleton.boneInverses[byName.get(names[0])]).invert();
        base.setFromMatrixPosition(_m4).applyMatrix4(mesh.bindMatrixInverse);

        // THE TIP IS NOT READ FROM THE LAST BONE, deliberately. Leaf locators
        // routinely ship with a degenerate inverse bind matrix — crabpincer's
        // Eye3L_end_099 inverts to the identity and reports its bind position
        // as the model ORIGIN, which aimed the whole gradient at the middle of
        // the crab. The vertices cannot lie in the same way, so the tip is the
        // owned vertex furthest from the base. That also self-calibrates on a
        // rig whose last bone sits short of the eyeball it drives.
        let far = -1;
        let farD = 0;
        for (let n = 0; n < owned.length; n += 2) {
          const d = v.fromBufferAttribute(pos, owned[n]).sub(base).lengthSq();
          if (d > farD) { farD = d; far = owned[n]; }
        }
        if (far < 0) continue;
        tip.fromBufferAttribute(pos, far);
        dir.copy(tip).sub(base);
        const len = dir.length();
        if (len < 1e-9) continue;
        dir.multiplyScalar(1 / len);

        // Project every owned vertex onto that axis, then RESCALE to the range
        // the geometry actually occupies.
        //
        // The rescale is what makes this work on a decimated asset, and
        // skipping it produces a flat result that looks like the gradient not
        // existing. Measured on crabpincer.glb: the eye survives as a tight
        // ball 1.67 units from the socket spanning only 0.017 — the shaft is
        // gone, welded into the head. Against the raw base-to-tip length every
        // one of those vertices lands between 0.99 and 1.00, so the eyeball
        // lights evenly and nothing is "brighter at the tip" at all.
        // Normalising over the vertices' own extent spends the full 0..1 on
        // whatever geometry is left, which is the eyeball, giving a dark inner
        // face and a hot outer one.
        //
        // Weight is used for MEMBERSHIP only and not multiplied in. It reads
        // like a free socket fade, but a partially-weighted vertex out at the
        // eyeball then comes back dark for a reason that has nothing to do
        // with where it is — which is exactly what broke the right eye while
        // the left, whose weights happen to be solid, looked perfect.
        let tMin = Infinity;
        let tMax = -Infinity;
        for (let n = 0; n < owned.length; n += 2) {
          v.fromBufferAttribute(pos, owned[n]).sub(base);
          const t = v.dot(dir) / len;
          if (t < tMin) tMin = t;
          if (t > tMax) tMax = t;
        }
        const tSpan = Math.max(1e-9, tMax - tMin);

        for (let n = 0; n < owned.length; n += 2) {
          const i = owned[n];
          // Projected rather than stepped per bone: stepping a four-bone chain
          // by bone index gives four visible bands, and the point is a smooth
          // ramp.
          v.fromBufferAttribute(pos, i).sub(base);
          const t = Math.min(1, Math.max(0, (v.dot(dir) / len - tMin) / tSpan));
          glow[i] = Math.max(glow[i], t);
        }
      }
    }
  }
  geom.setAttribute('aEyeGlow', new THREE.BufferAttribute(glow, 1));
}

/**
 * Give one spawned creature its OWN copy of the glow, so `phase` can differ
 * per individual. Called from createVisual for any asset carrying `biolumSkin`.
 *
 * WHY THIS EXISTS. The asset pipeline shares one material across every clone
 * of a key, which is the right default and the reason forty fish cost one
 * material. But a uniform on a shared material is shared BY DEFINITION, so a
 * school driven that way breathes and blinks in perfect unison — nine bodies
 * animated as one animal, which is worse than no animation at all. There is
 * no per-instance channel to smuggle a phase down: the geometry is shared too,
 * so an attribute can't carry it, and a seed derived from the world matrix
 * would change as the creature swam and make the flicker jitter with motion.
 *
 * So: one material per individual, one uniform block per individual, one
 * random phase each. The cost is a Material object per creature, NOT a shader
 * — `customProgramCacheKey` is pinned to a constant, so all of them still
 * share a single compiled program.
 */
export function instantiateBiolumSkin(root) {
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const swap = (mat) => {
      if (!mat?.userData?.__bioSkin || mat.userData.__bioSkinInstance) return mat;
      const copy = mat.clone();
      // clone() deep-copies userData through JSON, which drops the uniform
      // objects (they hold THREE.Color instances and would come back as plain
      // data with no `.set`). Rebuilding them is the point anyway — a shared
      // uniform block is exactly what this function exists to avoid.
      copy.userData.__bioSkin = true;
      copy.userData.__bioSkinPreset = mat.userData.__bioSkinPreset;
      copy.userData.__bioSkinInstance = true;
      // The individual's STABLE random number, 0..1, and the only thing about
      // it that is random. Everything downstream — how far apart the school
      // sits, whether that spacing is quantised — is derived from this in
      // applyBiolumSkinSettings, which is why it is a seed and not a phase.
      //
      // Storing the phase itself was a bug: the old code recomputed
      // `phase = (phase % 100) * phaseSpread` on every apply, and apply runs
      // on every spawn and every slider move. At the shipped phaseSpread of
      // 0.5 that halved the whole school's spread each time anything spawned,
      // so a shoal drifted into perfect lockstep after a dozen fish — the
      // exact failure per-instance materials exist to prevent.
      copy.userData.__bioSkinSeed = Math.random();
      const u = freshUniforms();
      copy.userData.__bioSkinUniforms = u;
      // Inherit the template's clocks so a fish spawning at minute nine isn't
      // a second-zero animal swimming next to a school mid-cycle. (A synced
      // clock would re-derive itself from the transport on the next frame
      // anyway; a free-running one would not, which is what this is for.)
      copy.userData.__bioSkinClock = { ...(mat.userData.__bioSkinClock ?? freshClock()) };
      inject(copy, u);
      instances.add(new WeakRef(copy));
      return copy;
    };
    o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
  });
  applyBiolumSkinSettings();
}

/**
 * Override the look of ONE individual, on top of its species preset.
 *
 * WHY THIS EXISTS, given presets already exist. A preset answers "what does
 * this species look like" and is shared by every clone of the key — which is
 * right for a school, where nine fish wearing one pattern IS the read. The
 * seal team wants the opposite: five escorts that are visibly five different
 * animals, each with its own pattern and palette, all built from one model.
 * Without this the only per-individual channel was `phase`, which varies WHEN
 * a body lights, never HOW.
 *
 * Call AFTER instantiateBiolumSkin (createVisual does that for any asset
 * carrying `biolumSkin`), because the variant is stamped on the per-instance
 * material clone — writing it onto the shared template would repaint every
 * clone of the key, which is exactly the bug this is here to avoid. Silently
 * does nothing on a root whose materials aren't instanced, rather than
 * corrupting the template.
 *
 * @param root    the object returned by createVisual
 * @param variant any subset of the preset keys — pattern, colorA/B/C, scale,
 *                coverage, strength, and so on
 */
export function setBiolumSkinVariant(root, variant) {
  if (!root || !variant) return;
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const stamp = (mat) => {
      if (!mat?.userData?.__bioSkin || !mat.userData.__bioSkinInstance) return;
      mat.userData.__bioSkinVariant = variant;
    };
    if (Array.isArray(o.material)) o.material.forEach(stamp);
    else stamp(o.material);
  });
  applyBiolumSkinSettings();
}

/**
 * Push CONFIG.biolumSkin onto every attached material. Pure uniform writes —
 * no recompile, including the pattern switch, so this is safe to call from a
 * slider's every input event.
 *
 * Each material reads the PRESET it was attached with, layered over `base`.
 * That layering is what lets one slider ("glow strength") move every glowing
 * creature at once while a preset still overrides it for the one species that
 * needs to disagree.
 */
export function applyBiolumSkinSettings() {
  const root = CONFIG.biolumSkin ?? {};
  const off = root.enabled === false;
  const base = root.base ?? {};
  const cache = new Map(); // preset name -> resolved settings, once per call
  const resolve = (name) => {
    let hit = cache.get(name);
    if (!hit) {
      hit = { ...base, ...(root.presets?.[name] ?? {}) };
      cache.set(name, hit);
    }
    return hit;
  };

  for (const m of liveMaterials()) {
    const u = m.userData.__bioSkinUniforms;
    if (!u) continue;
    const preset = resolve(m.userData.__bioSkinPreset ?? 'lantern');
    // A VARIANT is a third layer, over base and preset, carried per material
    // by whoever built the individual — see setBiolumSkinVariant. The preset
    // says what the species looks like; this says what THIS ONE looks like.
    // Spread rather than cached because it differs per material by definition,
    // which is the whole point of it.
    const variant = m.userData.__bioSkinVariant;
    const cfg = variant ? { ...preset, ...variant } : preset;
    u.uBioPattern.value = patternIndex(cfg.pattern);
    // `enabled` folds into strength rather than branching in the shader —
    // one less test per fragment, and the toggle fades out the same way the
    // slider does instead of popping. The body darkening comes back to 1 with
    // it, so switching the glow off leaves an ordinary fish behind.
    //
    // `glow` is a second multiplier rather than a bigger `strength` for two
    // reasons. It is one knob that moves the WHOLE family's bloom without
    // disturbing how bright the species are relative to each other — which is
    // the tuning you actually want to keep once the palettes are settled. And
    // it is a key nothing has saved yet, so its config default takes effect on
    // a machine whose imported-tuning.json already pins every `strength`.
    u.uBioStrength.value = off ? 0 : (cfg.strength ?? 1.6) * (cfg.glow ?? 1);
    u.uBioBodyDarken.value = off ? 1 : (cfg.bodyDarken ?? 0.35);
    u.uBioScale.value = cfg.scale ?? 0.25;
    u.uBioContrast.value = cfg.contrast ?? 1.4;
    u.uBioCoverage.value = cfg.coverage ?? 0.45;
    u.uBioPulseAmp.value = cfg.pulseAmp ?? 0.25;
    u.uBioFlickerAmp.value = cfg.flickerAmp ?? 0;
    u.uBioHueScale.value = cfg.hueScale ?? 1.2;
    u.uBioHueSpread.value = cfg.hueSpread ?? 1.0;
    u.uBioTailBias.value = cfg.tailBias ?? 0.2;
    u.uBioHueBias.value = cfg.hueBias ?? 0;
    u.uBioWarp.value = cfg.warp ?? 0.8;
    u.uBioColorA.value.set(cfg.colorA ?? 0x00e5ff);
    u.uBioColorB.value.set(cfg.colorB ?? 0x7b2dff);
    u.uBioColorC.value.set(cfg.colorC ?? 0xffd166);

    // THE EYES. Follows `biolumSkin.enabled` (so the master switch still turns
    // everything off) but NOT the pattern's own `strength` — the day crab's
    // shell is pigment with no glow at all and its eyes still light up. See
    // FRAG_BODY.
    u.uEyeStrength.value = off ? 0 : (cfg.eyeStrength ?? 0);
    u.uEyeFalloff.value = Math.max(0.05, cfg.eyeFalloff ?? 3);
    u.uEyePulse.value = cfg.eyePulse ?? 0;
    u.uEyeColor.value.set(cfg.eyeColor ?? 0xffd166);

    // The three clocks are advanced by updateBiolumSkin, which runs every
    // frame over every material and has no business re-resolving base +
    // preset + variant each time. Cached here instead, where the values can
    // only have changed.
    m.userData.__bioSkinResolved = cfg;

    // WHERE THIS INDIVIDUAL SITS IN THE CYCLE. A template material has no
    // individual to be, so it stays at 0.
    //
    // `phaseSteps` is what keeps the school ON the grid while still spreading
    // it out: a continuous random offset puts every fish a random fraction of
    // a beat late, which undoes the division picker one creature at a time.
    // See phaseOffset in systems/beatSync.js.
    const seed = m.userData.__bioSkinSeed;
    if (seed != null) {
      const spread = cfg.phaseSpread ?? 1;
      m.userData.__bioSkinOffset = phaseOffset(seed, spread, cfg.phaseSteps ?? 0);
      // The flicker's offset is a WHOLE number of steps, not a fraction of
      // one. A fractional offset would slide each fish's stutter off the beat
      // it was just quantised to; a whole-step one hands every fish a
      // different stretch of the same noise, so they stutter differently on
      // the same instants. 64 is enough distinct sequences that a school
      // never reads as two fish repeated.
      m.userData.__bioSkinFlickOffset = Math.floor(phaseOffset(seed, spread, 0) * 64);
    }
  }
}

/**
 * Advance the three clocks. Raw dt, not the hitstop-scaled one: a creature's
 * own light doesn't stop because the game froze for 60ms on a hit.
 *
 * WHY THE PHASES ARE COMPUTED HERE AND NOT IN GLSL. A synced cycle is derived
 * ABSOLUTELY from the beat transport, so it stays locked to the grid however
 * long the run has gone and however far the death dive has dragged the tempo;
 * a free one is integrated from its own last value, so changing the rate bends
 * it from where it is rather than teleporting it. The shader cannot tell those
 * two apart from a time and a rate, so it is handed the answer instead — see
 * advanceCycles in systems/beatSync.js.
 *
 * Also where collected instance materials are pruned out of the weak set — see
 * the note on `instances`.
 */
export function updateBiolumSkin(rawDt) {
  for (const m of liveMaterials()) {
    const u = m.userData.__bioSkinUniforms;
    if (!u) continue;
    const cfg = m.userData.__bioSkinResolved ?? EMPTY;
    const clock = (m.userData.__bioSkinClock ??= freshClock());
    const offset = m.userData.__bioSkinOffset ?? 0;

    // Drift is a rate in seconds by design — see the note in FRAG_BODY.
    clock.drift += rawDt * (cfg.flow ?? 0.05);
    u.uBioDrift.value = clock.drift;

    // `pulseSpeed` is authored in RADIANS per second (it was written straight
    // into a sin), so it divides by 2π to become the cycles/second the free
    // path wants. Nothing about the look changes; only where the conversion
    // happens.
    clock.cycle = advanceCycles(
      clock.cycle, cfg.pulseSync, (cfg.pulseSpeed ?? 1.8) / TWO_PI, rawDt, 2);
    u.uBioCycle.value = wrap(clock.cycle + offset, 2);

    // `flickerRate` is already in steps per second, so it needs no conversion.
    clock.flick = advanceCycles(
      clock.flick, cfg.flickerSync, cfg.flickerRate ?? 2.5, rawDt, FLICKER_WRAP);
    u.uBioFlickerT.value = clock.flick + (m.userData.__bioSkinFlickOffset ?? 0);
  }
}

const EMPTY = {};
const TWO_PI = Math.PI * 2;
// The flicker's noise coordinate has to stay a large WHOLE number at the wrap,
// or floor() jumps mid-step and every creature blinks on the same frame. 4096
// steps is over ten minutes at a fast flicker, and keeps float32 precision
// comfortable — well short of where the fractional part starts coarsening.
const FLICKER_WRAP = 4096;

function wrap(v, m) {
  return v - Math.floor(v / m) * m;
}

export function biolumSkinMaterialCount() {
  let n = 0;
  for (const _ of liveMaterials()) n++;
  return n;
}

// Exported for tools/biolum-skin-test.mjs, which checks the injected GLSL
// against the real three.js shader source — the failure this guards against
// is a three upgrade renaming a chunk, at which point the replace silently
// no-ops and the fish just never lights up.
export const __shaderSource = { GLSL, FRAG_BODY };
