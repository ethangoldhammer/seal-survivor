import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { advanceCycles, phaseOffset } from './beatSync.js';
import skinsCsv from '../skins.csv?raw';
import { parseSkinCsv, buildSkins, rollSkin } from '../skinTable.js';

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
  // --- the backdrop's own lattice, wrapped onto a body ---------------------
  'lattice', // hex cells that spring apart on the breath — see bioHexEdge
  // --- the model's own topology --------------------------------------------
  'wireframe', // every triangle edge on the body, lit — see bakeEdges
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
// WHERE IN THE FIELD THE PATTERN IS SAMPLING, as an offset rather than a
// distance. It was a float — one axis, travelled forever — and it is a vec3 so
// the path can be a LOOP instead of a line. See the note by drift in
// FRAG_BODY for why that is the whole trick.
uniform vec3  uBioDrift;
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
// PIGMENT, NOT LIGHT — how much of the BASE COLOUR this pattern replaces.
//
// The glow above is additive and lands after the lighting chunks have run, so
// it is light coming off a body no matter what the sun is doing. That is right
// for an organ and wrong for a hide: a shark painted additively is a decal, lit
// identically at noon and at midnight, with no shading anywhere on it.
//
// At 1 the pattern IS the diffuse colour — the ramp where the mask is bright,
// uBioShellColor where it is dark — so the standard lighting chunks shade it
// exactly as they would a photograph, and the model's own texture is never
// read. That is the whole point: a species on full pigment has no use for the
// jpeg baked into its .glb, and the file can lose it.
//
// At 0 this is bit-for-bit what shipped before the uniform existed — the base
// colour is only darkened, and every luminous preset stays exactly as tuned.
// The two are not exclusive; a pigment shell with a few glowing organs is
// pigment 1 with a low strength.
uniform float uBioPigment;
uniform vec3  uBioColorA;
uniform vec3  uBioColorB;
uniform vec3  uBioColorC;
// THE SHELL BETWEEN THE MARKINGS. 'bodyDarken' takes the body down so the glow
// reads as light coming out of it, and on an already-dark animal that lands on
// black — the negative space of the pattern becomes a silhouette. This lifts it
// back off the floor with a colour of its own: deep orange under an ember crab
// is metal that has not cooled yet, rather than a hole in the water. 0 is off,
// and off is bit-for-bit what shipped before it existed.
uniform vec3  uBioShellColor;
uniform float uBioShellGlow;
// THE SCHOOL WAVE — the one term in this shader sampled in WORLD space.
//
// Everything else is deliberately body-local, so a pattern belongs to an
// animal and swims with it. This is the opposite on purpose: a slow noise
// field filling the water, which each creature reads at wherever it happens to
// be floating. A shoal drifting through it lights up a few fish at a time, in
// the order the water reaches them, and reads as one organism rather than as
// nine animals that happen to be nearby.
//
// It modulates BRIGHTNESS, not the pattern. Sampling the pattern itself in
// world space would drag the markings across each body as it swam, which looks
// like a texture sliding off a model — the failure the bind-pose note at the
// top of this file exists to prevent.
//
// uBioSchoolT is a distance, not a cycle, and it is GLOBAL: every material is
// handed the same value on the same frame (see updateBiolumSkin). A per-
// material clock here would give every fish its own private wave, which is
// exactly not a field.
uniform float uBioSchoolAmp;   // 0 = off. How deep the field dips a creature.
uniform float uBioSchoolScale; // world units per noise feature
uniform float uBioSchoolT;     // how far the field has travelled, in world units
varying vec3  vBioWorld;
varying vec3  vBioPos;
varying float vBioAxis;
varying float vEyeGlow;
varying vec3  vBioEdge;
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

// THE HONEYCOMB, as a voronoi of a TRIANGULAR LATTICE with no jitter. The
// borders between neighbouring points of a triangular lattice are exactly a
// hex grid, so the cell-edge field is the same F2-F1 the 'net' pattern lights
// its seams with, and the two answer to coverage/contrast identically. Reusing
// that rather than a distance-to-hex-edge formula is the whole reason the
// regular grid and the organic one look like the same skin.
//
// Returns:
//   x  distance to the nearest cell centre
//   y  distance to the second nearest — y-x is 0 exactly on an edge
//   z  a 0..1 id for the cell, so neighbours can disagree about colour
//
// The 3x3 search is exhaustive for this lattice: with basis (1,0) and
// (0.5, 0.866) every one of a cell's six neighbours is within +/-1 of it in
// both axial coordinates.
const float HEX_H = 0.86602540;

vec3 bioHexEdge(vec2 p) {
  float j = p.y / HEX_H;
  float i = p.x - j * 0.5;
  vec2 base = floor(vec2(i, j));
  float f1 = 8.0;
  float f2 = 8.0;
  float id = 0.0;
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      vec2 cell = base + vec2(float(x), float(y));
      vec2 centre = vec2(cell.x + cell.y * 0.5, cell.y * HEX_H);
      float d = length(centre - p);
      if (d < f1) { f2 = f1; f1 = d; id = bioHash1(vec3(cell, 0.0)); }
      else if (d < f2) { f2 = d; }
    }
  }
  return vec3(f1, f2, id);
}

// THE SPRING, lifted term for term from the backdrop grid's vertex shader
// (systems/grid.js): a radial direction, a sine travelling outward from the
// origin, and an exponential decay that puts the lattice back where it was.
// Displacing the SAMPLE POINT before the cells are built is what makes the
// cells themselves stretch and settle — brightening a static lattice on the
// same clock reads as a light flashing, not as a mesh being shoved.
//
// 'age' is 0..1 within one ripple. Returns the displacement, so the caller can
// use its length as the grid's own 'vWarp' heat.
vec2 bioLatticeShove(vec2 q, float age, float amp) {
  vec2 d = q + vec2(0.0, 0.0001); // origin is the body's centre in lattice space
  float r = length(d) + 0.0001;
  float wave = sin(r * 2.4 - age * 6.2831853 * 1.5) * exp(-age * 2.6);
  return (d / r) * wave * amp;
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
// THE PATTERN, EVALUATED ONCE, AT <map_fragment>.
//
// It used to run at <dithering_fragment> with everything else, which is after
// the lighting chunks — the only place an additive glow can go. Pigment cannot
// live there: a colour written after the lights is a colour the lights never
// touched. So the evaluation moved forward to the base-colour chunk, and the
// three values the emission still needs are declared OUTSIDE the block so they
// survive down to it. Same maths, same cost — one evaluation, read twice.
//
// The names are all bio-prefixed for a reason that is not style: these are at
// main()'s scope now, alongside every local three.js's own chunks declare, and
// a collision there is a compile error that renders every glowing creature in
// the ocean as nothing. Everything that can stay inside the block does.
const FRAG_SURFACE = `
  float bioMaskV = 0.0;
  vec3  bioRampCol = vec3(0.0);
  float bioBreathe = 1.0;
  {
    vec3 bp = vBioPos / max(0.01, uBioScale);
    // The whole field moves. On a still pattern this is what stops it looking
    // like a decal.
    //
    // THIS USED TO BE UNSYNCABLE, AND THE REASON IT NO LONGER IS, IS THE SHAPE
    // OF THE PATH. A straight translation through noise never comes back
    // round: "one drift per bar" is meaningless because there is nothing to
    // come back TO, and wrapping the offset to loop it snaps the whole pattern
    // to a different part of the field once a bar. That is why this was a
    // seconds-based rate and documented as impossible to quantise.
    //
    // A CLOSED path has no such problem. Walk a circle through the field and
    // every lap ends exactly where it started, on the same noise values, with
    // no seam anywhere — so a lap IS a cycle and a cycle can go on the grid.
    // The field still never repeats; the PATH through it does, which is all
    // the sync ever needed. The radius is what "how far through the field"
    // means now (biolumSkin.flowSpan), and the lap is on flowSync.
    //
    // Straight-line drift is still here and still the default: with flowSync
    // 'free' the JS writes (0, 0, distance) into this and nothing about an
    // existing preset changes.
    vec3 drift = uBioDrift;

    // bioMaskV is declared above this block, not here — the emission half
    // reads it after the lighting chunks have run.
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

      // TRAVELLING, head to tail. The breath clock is subtracted from the
      // AXIS rather than added to the phase, which translates the whole band
      // pattern along the body: at cycle 1 every band sits exactly where its
      // neighbour was, so one full traverse takes exactly one breath. Before
      // this the bands were pinned to the body and only the warp above moved,
      // so they shimmered in place and never went anywhere.
      //
      // Riding uBioCycle rather than a clock of its own is what keeps a shoal
      // from marching in lockstep: that clock already carries each
      // individual's phase offset, and it is the same one the brightness
      // breathes on, so a band arrives as the body swells.
      //
      // WHY THE BAND COUNT IS ROUNDED TO A WHOLE NUMBER. uBioCycle wraps at
      // 2, and the jump it makes there shifts this phase by two times the
      // band count in turns. That is invisible only when the band count is an
      // integer; at the raw 3.0/scale (5.45 on the shark) the wrap would snap
      // the whole pattern sideways every few seconds. Same reasoning as the
      // wrap note in the pulse branch below. Rounding also makes the bands
      // fit the animal, with no half-stripe left over at the tail.
      float bands = max(1.0, floor(3.0 / max(0.05, uBioScale) + 0.5));
      float s = sin((vBioAxis - uBioCycle) * 6.2831853 * bands + warp);
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
    } else if (uBioPattern == 9) {   // marble
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
    } else if (uBioPattern == 10) {  // lattice
      // THE BACKDROP'S GRID, WORN. Built in the model's own X/Y, which is the
      // plane that faces the camera for every creature in the game — createVisual
      // stands a body up along world +Y and nothing ever spins it about anything
      // but Z — so the cells read as cells instead of as a grid seen edge-on.
      // The small Z shear is what stops a rounded body looking printed: cells on
      // the far side of the shell slide against the ones on the near side.
      //
      // The one pattern that ignores uBioDrift. Cells are anatomy here — plates
      // on a shell — and a honeycomb sliding across a body it is supposed to be
      // part of is the exact failure the bind-pose note at the top of this file
      // exists to prevent. What moves instead is the SPRING below.
      vec2 q = bp.xy + vec2(bp.z * 0.15, bp.z * -0.08);

      // HOW FAR THE CELLS TRAVEL is 'warp'; WHETHER THEY TRAVEL AT ALL is the
      // breath. That pairing is deliberate: a preset with pulseAmp 0 has
      // declared itself static (see 'carapace', which is a shell texture on a
      // daylight animal), and a lattice springing about on it would give the
      // whole thing away exactly as a crawling mottle would. A luminous preset
      // gets the ripple for free from the breath it already has.
      //
      // fract() of the cycle is one ripple per breath. uBioCycle wraps at 2, so
      // the fract steps 1->0 twice a cycle-pair, and both steps land where the
      // decay has already taken the wave to nothing — a new ripple starting,
      // not a jump. The cycle carries this individual's phase offset, so a heap
      // of crabs ripples in ones rather than as a single organism.
      float age = fract(uBioCycle);
      vec2 shove = bioLatticeShove(q, age, uBioWarp * uBioPulseAmp * 2.0);
      vec3 h = bioHexEdge(q + shove);

      // y-x is 0 on a border and grows inward. The x3 is the same normalisation
      // 'net' needs and for the same reason: on this lattice the difference
      // tops out near 0.33, so the raw field is near 1 over the whole cell and
      // inverting it alone lights every plate solid instead of its seams.
      bioMaskV = bioMask(1.0 - min((h.y - h.x) * 3.0, 1.0));
      // The grid's 'vWarp' heat, on the same idea: the stretched part of the
      // lattice is the bright part, so the ripple is visible as light travelling
      // as well as as geometry moving.
      bioMaskV *= 1.0 + length(shove) * 1.6;
      bioHue = fract(h.z * 2.9) * uBioHueSpread + 0.5;
    } else {                         // wireframe
      // THE MODEL'S OWN TOPOLOGY, LIT. Every other pattern in this file is a
      // field sampled on the body; this one is the body's triangulation, so it
      // is the only look here that is different on every animal for free — a
      // shark's edge flow and an orca's are different drawings because they are
      // different meshes.
      //
      // Barycentric coordinates: each fragment carries how far it is from each
      // of its triangle's three corners, and the SMALLEST of the three is the
      // distance to the nearest edge. Zero on a body that never opted in (see
      // bakeEdges), which is what the guard below detects.
      // ALREADY A DISTANCE, in fractions of the body's longest side — the bake
      // multiplied each barycentric coordinate by its triangle's own height, so
      // the interpolated value IS the perpendicular distance to that edge and
      // no derivative is needed. See bakeEdges for why that matters: the
      // fwidth() version of this did not compile, and since every
      // bioluminescent creature shares one program it would have taken every
      // glowing animal in the ocean down with it rather than just the orca.
      float dist = min(min(vBioEdge.x, vBioEdge.y), vBioEdge.z);
      float declared = vBioEdge.x + vBioEdge.y + vBioEdge.z;

      // CONSTANT WIDTH ON THE ANIMAL, which is the whole difference between a
      // wireframe and a mess: a plain barycentric threshold draws hairlines
      // across the big triangles and floods the small ones, and these are
      // skinned bodies whose triangles change size as they swim. A real
      // distance gives one line weight everywhere.
      //
      // The camera is orthographic, so constant on the animal is also constant
      // on screen — there is no perspective divide to thin the far end.
      //
      // coverage is the line width and contrast is how hard it falls off — the
      // same two knobs every other pattern uses, pointed at the only two things
      // a line has. Scaled small because the unit here is the whole body: at
      // 0.38 the line is about a thousandth of the animal's length.
      float width = max(0.0004, uBioCoverage * 0.0025);
      bioMaskV = 1.0 - smoothstep(width, width * (1.0 + uBioContrast), dist);

      // The breath travels ALONG the body rather than pulsing the whole lattice
      // at once, so a wireframe animal reads as charge running through it —
      // which is the thing this look is for. Rides the axis the gradient
      // already knows about, so it runs head to tail on anything.
      float wave = sin((vBioAxis * 3.0 - uBioCycle) * 6.2831) * 0.5 + 0.5;
      bioMaskV *= mix(1.0, wave, clamp(uBioPulseAmp, 0.0, 1.0));

      // Hue walks along the body too, so the far end of the animal is a
      // different colour from the near end rather than the whole cage being
      // one tint.
      // drift.z, not uBioDrift -- that was a float and is a vec3 now, and
      // float + vec3 is a compile error, which links no program and renders
      // the creature as NOTHING rather than as a wrong colour. Z is the axis
      // the free path travels along, so this walks exactly as it used to; on a
      // looped path it swings back and forth with the lap instead.
      bioHue = fract(vBioAxis * 1.7 + drift.z * 0.1) * uBioHueSpread;

      // A body that did not declare biolumEdges has no barycentric attribute
      // and would render as a solid glowing blob — every fragment reads
      // distance 0, which is "on an edge" everywhere. Drawn as nothing instead:
      // an animal that fails to light is a visible, findable mistake, and a
      // solid one looks like a deliberate art choice.
      bioMaskV *= step(0.5, declared);
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
    // Local while the school wave is still being folded in below; published to
    // the outer scope at the end of the block.

    // THE SCHOOL WAVE, over the top of both — see the note by its uniforms.
    // The field travels along X, which is the long axis of a side-on arena and
    // the direction a shoal drifts, so the wave arrives at one end of a school
    // and leaves at the other rather than switching all of it on at once.
    //
    // Mixed toward, like the flicker, so amp 0 is bit-for-bit "no wave" and a
    // creature that opts out cannot be dimmed by a field it is not in.
    if (uBioSchoolAmp > 0.0) {
      // Both the position and the travel are divided by the same scale, so
      // uBioSchoolT stays honest about its unit: world units of water, not
      // noise features. Retuning the scale then changes how BIG the wave is
      // without also changing how fast it crosses the arena.
      float schoolScale = max(0.5, uBioSchoolScale);
      vec3 wp = vBioWorld / schoolScale;
      float field = bioFbm(vec3(wp.x - uBioSchoolT / schoolScale, wp.y, wp.z)) * 0.5 + 0.5;
      breathe *= mix(1.0, field, uBioSchoolAmp);
    }

    bioRampCol = bioRamp(bioHue);
    bioBreathe = breathe;
  }

  // PIGMENT. The one line in this file that writes the base colour rather than
  // adding to it, and the reason the evaluation above had to move up here.
  //
  // Where the mask is bright the body takes the ramp; where it is dark it takes
  // uBioShellColor, which is already "what the animal looks like where the
  // light isn't" for the emissive half and means the same thing here. So a
  // preset describes a whole hide with the colours it already had.
  //
  // The mix's first arm is the untouched original: at uBioPigment 0 this
  // compiles to the same multiply that was here before, and every luminous
  // preset in the file is unmoved.
  //
  // NOT breathed and NOT flickered, on purpose. Pigment does not pulse — a
  // hide that brightened on the beat is the animal being lit from outside,
  // which is the same argument the shell floor below makes. bioBreathe belongs
  // to the light only.
  //
  // TIMES THE PER-SPECIES TINT, and that multiply is what makes one preset
  // serve a roster. The uniform named diffuse is the material colour before any
  // texture — the thing the Models tab's tint swatch writes — so four animals
  // can share one pattern and still be four colours, exactly the way four fish
  // already share the lantern preset. Reading diffuseColor instead would fold
  // in the model's own texture, which is the thing being replaced.
  //
  // Every material three.js compiles this into declares it: basic, lambert,
  // phong and standard alike.
  //
  // NO BACKTICKS IN THIS STRING — see the note by the eyes. Naming the uniform
  // in code font here ended the literal and pointed the SyntaxError at a
  // comment, which is the failure that note exists to prevent.
  diffuseColor.rgb = mix(
    diffuseColor.rgb * uBioBodyDarken,
    mix(uBioShellColor, bioRampCol, clamp(bioMaskV, 0.0, 1.0)) * diffuse,
    clamp(uBioPigment, 0.0, 1.0)
  );
`;

// THE EMISSION, at <dithering_fragment> — after every lighting chunk, which is
// the only place additive light can go and be light rather than paint. Reads
// the three values FRAG_SURFACE left at main()'s scope.
const FRAG_EMIT = `
  {
    gl_FragColor.rgb += bioRampCol * (bioMaskV * uBioStrength * bioBreathe);

    // ...and the shell it sits on. Faded out where the pattern is bright, so
    // the two never stack into white — the floor is what the animal looks like
    // where the light ISN'T, which is exactly the complement of the mask.
    //
    // Deliberately does NOT breathe. The markings pulse because they are
    // organs; a shell that brightened and dimmed along with them would read as
    // the whole animal being lit from outside, and it also puts the pulse on
    // every pixel of the silhouette rather than on the pattern.
    if (uBioShellGlow > 0.0) {
      gl_FragColor.rgb += uBioShellColor * (uBioShellGlow * (1.0 - clamp(bioMaskV, 0.0, 1.0)));
    }
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
    bakeEdges(geom, mesh, longest);
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
    uBioDrift: { value: new THREE.Vector3() },
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
    // 0 by default, which is exactly the behaviour that shipped before pigment
    // existed: every preset already tuned keeps painting with light only.
    uBioPigment: { value: 0 },
    uBioColorA: { value: new THREE.Color(0x00e5ff) },
    uBioColorB: { value: new THREE.Color(0x7b2dff) },
    uBioColorC: { value: new THREE.Color(0xffd166) },
    // The shell between the markings. Strength 0 by default, so a preset that
    // says nothing about it renders exactly as it did before this existed.
    uBioShellColor: { value: new THREE.Color(0x000000) },
    uBioShellGlow: { value: 0 },
    // The world-space school wave. Amp 0 by default so a creature whose
    // preset says nothing about it is bit-for-bit unaffected.
    uBioSchoolAmp: { value: 0 },
    uBioSchoolScale: { value: 7 },
    uBioSchoolT: { value: 0 },
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
  // `drift` is the straight-line distance (flowSync 'free'); `lap` is the
  // position around the closed path (flowSync on a division). Only one of the
  // two is advanced on any given frame — see updateBiolumSkin.
  return { drift: 0, cycle: 0, flick: 0, lap: 0 };
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
      // vEyeGlow is declared HERE as well as in GLSL (which only reaches the
      // fragment stage). Writing an undeclared varying is not a silent no-op:
      // it fails the VERTEX shader outright — 'vEyeGlow' : undeclared
      // identifier — so the program never links and every creature wearing a
      // glow skin renders as nothing at all. The seal, the lanternfish, both
      // crabs and the escort squad all went invisible on one missing line, and
      // the only trace was a console message behind a game that still ran.
      .replace('#include <common>', `#include <common>
attribute vec3 aBioPos;
attribute float aBioAxis;
attribute float aEyeGlow;
attribute vec3 aBioEdge;
varying vec3 vBioPos;
varying float vBioAxis;
varying float vEyeGlow;
varying vec3 vBioWorld;
varying vec3 vBioEdge;`)
      // After <begin_vertex>: the attributes are per-vertex constants so the
      // position makes no difference to them, but sitting after that chunk
      // keeps this clear of the outline shells' rim push, which rewrites
      // `transformed` at exactly that point.
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  vBioPos = aBioPos;
  vBioAxis = aBioAxis;
  vEyeGlow = aEyeGlow;
  // Barycentric, for the wireframe pattern. Zero on every body that did not
  // opt in (an absent attribute reads as 0), which the pattern detects and
  // reports rather than drawing a solid animal — see bakeEdges.
  vBioEdge = aBioEdge;
  // Where this fragment actually is in the ocean, for the world-space school
  // wave. Taken from the pre-skin position on purpose: it is read at a scale
  // of several world units, so the centimetres a skinned tail adds are noise,
  // and reading it here costs one matrix multiply instead of chasing the
  // skinning chunks that rewrite the transformed position further down.
  // (No backticks in this string, ever — see the note in FRAG_BODY.)
  vBioWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL}`)
      // The pattern and the base colour it writes run at <map_fragment> — on
      // the base colour, BEFORE any lighting chunk — so a bright pattern sits
      // on a dark body instead of being washed out by it, so the darkening can
      // never dim the glow it exists to make legible, and so pigment is a
      // surface the lights can actually shade.
      //
      // <map_fragment> is in the source of basic, lambert, phong and standard
      // alike, and its USE_MAP test is INSIDE the chunk — so this lands on a
      // material with no texture at all, which is the case that matters most
      // here.
      .replace('#include <map_fragment>', `#include <map_fragment>\n${FRAG_SURFACE}`)
      .replace('#include <dithering_fragment>', `${FRAG_EMIT}\n#include <dithering_fragment>`);
  };
  material.needsUpdate = true;
}

// --- the wireframe ----------------------------------------------------------
// The `wireframe` pattern lights the MESH'S OWN EDGES: every triangle border on
// the body becomes a filament, so the animal reads as a lattice of light rather
// than as a lit surface. It is the one pattern here whose shape is the model's
// topology instead of a noise field, which is exactly why it looks unlike
// anything else in the water.
//
// IT NEEDS BARYCENTRIC COORDINATES, and those need one vertex per triangle
// corner. A welded mesh shares a vertex between the triangles that meet at it,
// and a shared vertex cannot be (1,0,0) for one of them and (0,1,0) for
// another — so the geometry has to be split first. That is what `toNonIndexed`
// does, and it roughly triples the vertex count: the orca goes 6,994 -> 33,714,
// which is precisely the shape the source file shipped in before
// tools/orca-split.mjs welded it to save four megabytes of download. The weld
// is paid back on disk and the split is paid once here, in memory, on the
// handful of bodies that opt in.
//
// OPT-IN PER ASSET (`biolumEdges: true`), NOT per pattern, and that is
// deliberate. The pattern is a live slider — a preset can be switched to
// `wireframe` while the game is running — and re-splitting geometry underneath
// a creature that is already swimming is not something a slider should ever
// do. So a body that declares it pays the split at load and can wear the
// pattern; a body that does not gets a black pattern and one warning, which is
// a legible failure rather than a mysterious hitch.
function bakeEdges(geom, mesh, longest) {
  if (!mesh?.userData?.__bioEdges && !geom.userData.__bioEdges) return;
  if (geom.attributes.aBioEdge) return;
  if (geom.index) {
    console.warn('[biolumSkin] wireframe glow needs non-indexed geometry; call splitForEdges before attaching.');
    return;
  }
  const pos = geom.attributes.position;
  const n = pos.count;
  const edge = new Float32Array(n * 3);

  // NOT PLAIN BARYCENTRIC, and this is the whole trick. The obvious encoding is
  // (1,0,0)/(0,1,0)/(0,0,1) per corner, with the shader turning the
  // interpolated value into a screen-space width using fwidth(). That does not
  // compile here: these shaders are GLSL ES 1.00, where the derivative
  // functions need GL_OES_standard_derivatives, and an #extension directive has
  // to precede every non-preprocessor token in the file — which is impossible
  // from an injection point two hundred lines down somebody else's shader. It
  // fails to compile on WebGL2 as readily as on WebGL1, and because every
  // bioluminescent creature in the game shares ONE compiled program, the cost
  // of that would not have been a wrong-looking orca. It would have been every
  // glowing animal in the ocean rendering as nothing.
  //
  // So the distance is baked instead of derived. Each corner stores the
  // TRIANGLE'S HEIGHT from that corner to the opposite edge; the interpolated
  // value is then barycentric x height, which IS the perpendicular distance to
  // that edge, in model units, for free. The shader takes the smallest of the
  // three and compares it to a width. No derivatives, no extension, and it is
  // exact rather than a one-pixel approximation.
  //
  // Normalised by the body's longest side, the same figure aBioPos uses, so
  // `coverage` means "line width as a fraction of the animal's length" and
  // reads the same on a 700-unit orca as on a 14-unit shark.
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cross = new THREE.Vector3();
  for (let t = 0; t + 2 < n; t += 3) {
    a.fromBufferAttribute(pos, t);
    b.fromBufferAttribute(pos, t + 1);
    c.fromBufferAttribute(pos, t + 2);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    // Twice the area. Height from a corner = 2 * area / (opposite side length).
    const twiceArea = cross.crossVectors(ab, ac).length();
    const lenBC = c.distanceTo(b);
    const lenCA = a.distanceTo(c);
    const lenAB = b.distanceTo(a);
    const h = (side) => (side > 1e-9 ? twiceArea / side / longest : 0);
    edge[t * 3 + 0] = h(lenBC);       // corner a, opposite edge bc
    edge[(t + 1) * 3 + 1] = h(lenCA); // corner b, opposite edge ca
    edge[(t + 2) * 3 + 2] = h(lenAB); // corner c, opposite edge ab
  }
  geom.setAttribute('aBioEdge', new THREE.BufferAttribute(edge, 3));
}

/**
 * Split a body's geometry so it can wear the wireframe pattern. Called from
 * assets.js at install time for assets that declare `biolumEdges`, i.e. once
 * per asset rather than once per creature — every clone shares the geometry.
 */
export function splitForEdges(root) {
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.index) return;
    const split = o.geometry.toNonIndexed();
    o.geometry.dispose();
    o.geometry = split;
    o.geometry.userData.__bioEdges = true;
    o.userData.__bioEdges = true;
  });
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
  const made = [];
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
      made.push(copy);
      return copy;
    };
    o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
  });
  // Only the clones just made — same argument as in setBiolumSkinVariant. This
  // runs on every body built from scratch, and a global restamp here made a
  // spawn's cost proportional to how many creatures were already on screen:
  // measured at 120 alive, 190us to say that one new body exists, against 3us
  // for the body itself.
  if (made.length) applyBiolumSkinSettings(made);
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
  // Only the materials this actually stamped are re-resolved. It used to push
  // the whole config over EVERY live material — fine for the debug lineup,
  // which stamps a handful of creatures once, and not fine at all now that
  // this runs on every spawn: at four crabs a second with a hundred alive,
  // a global restamp is four hundred materials and twenty-odd uniform writes
  // each, per second, to say that one new body has a palette. Nothing else
  // could have changed anyway.
  const touched = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const stamp = (mat) => {
      if (!mat?.userData?.__bioSkin || !mat.userData.__bioSkinInstance) return;
      mat.userData.__bioSkinVariant = variant;
      touched.push(mat);
    };
    if (Array.isArray(o.material)) o.material.forEach(stamp);
    else stamp(o.material);
  });
  if (touched.length) applyBiolumSkinSettings(touched);
}

// ---------------------------------------------------------------------------
// THE SKIN ROSTER — which variants exist, from skins.csv. See skinTable.js for
// what a row means and why the list is a file rather than a tuner panel.
//
// Built once at module load, like the boss perks: the file is data the game
// boots with, and rebuilding it per spawn would parse a CSV two to four times
// a second at the rate crabs arrive.
// ---------------------------------------------------------------------------

// Is this preset LIGHT or PIGMENT? Resolved through `base` the same way every
// other preset key is, so a preset that simply doesn't mention `luminous`
// inherits the family's answer instead of counting as pigment.
function presetIsNight(name) {
  const root = CONFIG.biolumSkin ?? {};
  const preset = root.presets?.[name];
  if (!preset) return null; // config.js has never heard of it — see buildSkins
  return (preset.luminous ?? root.base?.luminous ?? true) !== false;
}

const SKINS = buildSkins(parseSkinCsv(skinsCsv), { patterns: BIOLUM_PATTERNS, presetIsNight });

/** The parsed roster, for the contact sheet and the tests. */
export function skinRoster() {
  return SKINS;
}

/** Which preset an already-built body is wearing, or null if it wears none. */
export function biolumSkinPresetOf(root) {
  let found = null;
  root?.traverse?.((o) => {
    if (found || !o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (m?.userData?.__bioSkin && m.userData.__bioSkinPreset) {
        found = m.userData.__bioSkinPreset;
        return;
      }
    }
  });
  return found;
}

/**
 * Roll this individual's skin and stamp it. Called for every creature that
 * spawns (entities/enemies.js, spawnOne).
 *
 * STAMPED ON EVERY SPAWN, not only on a fresh body, because bodies are POOLED
 * — acquireVisual hands back a crab that already died once, still carrying the
 * variant it wore then. Re-rolling is what keeps the heap mixed instead of
 * gradually settling into whatever the first nine crabs of the run happened to
 * roll.
 *
 * Returns the variant, or null for the creatures with no skins at all, which
 * is every one of them but the crabs today.
 */
export function rollBiolumSkinVariant(root, rng = Math.random) {
  const variant = rollSkin(SKINS, biolumSkinPresetOf(root), rng);
  if (variant) setBiolumSkinVariant(root, variant);
  return variant;
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
export function applyBiolumSkinSettings(only = null) {
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

  // `only` is a list of materials to restamp instead of the whole roster —
  // see setBiolumSkinVariant for why that matters now. A slider still passes
  // nothing and moves everything.
  for (const m of (only ?? liveMaterials())) {
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
    // Switched off with the rest of it. `off` has to hand the model its own
    // texture back intact, and a pigment left at 1 would keep the whole body
    // painted after the system that painted it was disabled — an "off" that
    // still owns the animal's colour is the worst of both.
    u.uBioPigment.value = off ? 0 : (cfg.pigment ?? 0);
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
    // Follows the master switch like everything additive: `enabled: false` has
    // to leave an ordinary animal behind, not one still glowing at the seams.
    u.uBioShellGlow.value = off ? 0 : (cfg.shellGlow ?? 0);
    u.uBioShellColor.value.set(cfg.shellColor ?? 0x000000);

    // The school wave. Resolved per material like everything else, so a preset
    // CAN opt out (the crab on the seabed is not in the water column with the
    // shoals), but the travel itself is global — see updateBiolumSkin.
    u.uBioSchoolAmp.value = off ? 0 : (cfg.schoolAmp ?? 0);
    u.uBioSchoolScale.value = Math.max(0.5, cfg.schoolScale ?? 7);

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
  // THE ONE CLOCK THAT IS NOT PER-MATERIAL. The school wave is a field in the
  // water, so every creature has to read the same field at the same instant —
  // advancing it inside the loop below, or storing it on each material's own
  // clock, would hand every fish a private wave and the whole effect would
  // collapse into "each animal flickers on its own". A fish spawning at minute
  // nine has to join the wave already in progress, which it does for free by
  // reading a value that never belonged to it.
  //
  // World units per second, from the shared base — one ocean, one current.
  const schoolSpeed = CONFIG.biolumSkin?.base?.schoolSpeed ?? 0;
  schoolTravel += rawDt * schoolSpeed;

  for (const m of liveMaterials()) {
    const u = m.userData.__bioSkinUniforms;
    if (!u) continue;
    const cfg = m.userData.__bioSkinResolved ?? EMPTY;
    const clock = (m.userData.__bioSkinClock ??= freshClock());
    const offset = m.userData.__bioSkinOffset ?? 0;

    // WHERE THE PATTERN IS SAMPLING THE FIELD FROM. Two paths, and which one
    // runs is `flowSync`: a division walks a closed loop through the field, so
    // the lap lands on the grid; 'free' (the default) keeps the straight-line
    // drift in seconds that every preset had before this existed.
    const lapDiv = cfg.flowSync ?? 'free';
    if (lapDiv && lapDiv !== 'free') {
      // The lap position, 0..1, derived from the transport exactly like the
      // breath and the flicker — so it is the SAME instant of the bar on every
      // creature, not a per-material accumulation that drifts apart over a run.
      // `flow` is the free-run twin the picker falls back to, in laps/sec.
      clock.lap = advanceCycles(clock.lap ?? 0, lapDiv, cfg.flow ?? 0.05, rawDt, 1);
      let lap = clock.lap + offset;
      // THE PULSE. Quantising the lap into whole steps makes the field JUMP
      // rather than glide — one shove per step, landing on the beat. 0 is a
      // smooth lap, which is the same path taken continuously.
      const steps = Math.max(0, Math.round(cfg.flowSteps ?? 0));
      if (steps > 0) lap = Math.floor(lap * steps) / steps;
      const th = lap * Math.PI * 2;
      // Radius from the span the caller asked for: `flowSpan` is how far the
      // sample point travels in one lap, and a circle of circumference S has
      // radius S/2pi. Expressed as distance rather than radius so it means the
      // same thing as `flow` did — field units covered.
      const r = (cfg.flowSpan ?? 3) / (Math.PI * 2);
      // Offset so theta 0 sits at the field origin: the loop starts exactly
      // where an unsynced pattern starts, rather than a radius away from it.
      u.uBioDrift.value.set(r * Math.sin(th), 0, r * (1 - Math.cos(th)));
    } else {
      clock.drift += rawDt * (cfg.flow ?? 0.05);
      u.uBioDrift.value.set(0, 0, clock.drift);
    }

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

    // The shared field position — deliberately NOT offset per individual, for
    // the same reason it is not advanced per individual.
    u.uBioSchoolT.value = schoolTravel;
  }
}

const EMPTY = {};
const TWO_PI = Math.PI * 2;

// How far the world-space school field has drifted, in world units. Module
// scope because it belongs to the ocean rather than to any creature in it.
// Never wrapped: it is a translation through noise, so there is no cycle to
// come back round to, and float32 stays comfortable for hours at these rates.
let schoolTravel = 0;
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
export const __shaderSource = { GLSL, FRAG_SURFACE, FRAG_EMIT };
