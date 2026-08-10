import * as THREE from 'three';
import { CONFIG } from '../config.js';

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
uniform float uBioTime;
uniform float uBioScale;
uniform float uBioStrength;
uniform float uBioContrast;
uniform float uBioCoverage;
uniform float uBioFlow;
uniform float uBioPulseAmp;
uniform float uBioPulseSpeed;
uniform float uBioHueScale;
uniform float uBioHueSpread;
uniform float uBioTailBias;
uniform float uBioWarp;
uniform float uBioPhase;
uniform float uBioFlickerAmp;
uniform float uBioFlickerRate;
uniform float uBioBodyDarken;
uniform vec3  uBioColorA;
uniform vec3  uBioColorB;
uniform vec3  uBioColorC;
varying vec3  vBioPos;
varying float vBioAxis;

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
    // looking like a decal; on 'pulse' it is the travel itself.
    vec3 drift = vec3(0.0, 0.0, uBioTime * uBioFlow);

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
      float wave = sin(vBioAxis * 12.0 / max(0.2, uBioScale * 4.0) - (uBioTime + uBioPhase) * uBioPulseSpeed * 2.0);
      float patches = bioFbm(bp) * 0.5 + 0.5;
      bioMaskV = bioMask((wave * 0.5 + 0.5) * (0.4 + 0.6 * patches));
      bioHue = fract(vBioAxis - (uBioTime + uBioPhase) * uBioPulseSpeed * 0.08) * uBioHueSpread + 0.5;
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

    // One global breath over the top of whatever the pattern is doing, and a
    // stutter over the top of THAT. Both read uBioPhase, which is per
    // INSTANCE — that offset is the only reason a school of nine doesn't
    // breathe and blink in lockstep like one animal with nine bodies.
    float breathe = 1.0 + uBioPulseAmp * sin((uBioTime + uBioPhase) * uBioPulseSpeed);
    // Mixed toward rather than multiplied in, so amp 0 is exactly "off" and
    // no flicker maths can dim a creature that asked for none.
    breathe *= mix(1.0, bioFlicker((uBioTime + uBioPhase) * uBioFlickerRate), uBioFlickerAmp);

    gl_FragColor.rgb += bioRamp(bioHue) * (bioMaskV * uBioStrength * breathe);
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
 */
export function attachBiolumSkin(material, mesh, preset = 'lantern') {
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
    // Which axis that is decides what "head to tail" means. On every fish in
    // the roster the model's long axis is the body axis, which is the only
    // reason this can be derived rather than declared per asset.
    const axis = size.x >= size.y && size.x >= size.z ? 0 : (size.y >= size.z ? 1 : 2);
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
  }

  material.userData.__bioSkin = true;
  // Which block of CONFIG.biolumSkin.presets this material answers to. Carried
  // on the material rather than passed to applyBiolumSkinSettings, because by
  // the time a slider moves there is nothing left holding the asset key.
  material.userData.__bioSkinPreset = preset;

  const u = freshUniforms();
  material.userData.__bioSkinUniforms = u;
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
    uBioTime: { value: 0 },
    uBioScale: { value: 0.25 },
    uBioStrength: { value: 1.6 },
    uBioContrast: { value: 1.4 },
    uBioCoverage: { value: 0.45 },
    uBioFlow: { value: 0.05 },
    uBioPulseAmp: { value: 0.25 },
    uBioPulseSpeed: { value: 1.8 },
    uBioHueScale: { value: 1.2 },
    uBioHueSpread: { value: 1.0 },
    uBioTailBias: { value: 0.2 },
    uBioWarp: { value: 0.8 },
    uBioPhase: { value: 0 },
    uBioFlickerAmp: { value: 0 },
    uBioFlickerRate: { value: 2.5 },
    uBioBodyDarken: { value: 0.35 },
    uBioColorA: { value: new THREE.Color(0x00e5ff) },
    uBioColorB: { value: new THREE.Color(0x7b2dff) },
    uBioColorC: { value: new THREE.Color(0xffd166) },
  };
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
varying vec3 vBioPos;
varying float vBioAxis;`)
      // After <begin_vertex>: the attributes are per-vertex constants so the
      // position makes no difference to them, but sitting after that chunk
      // keeps this clear of the outline shells' rim push, which rewrites
      // `transformed` at exactly that point.
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  vBioPos = aBioPos;
  vBioAxis = aBioAxis;`);

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
      const u = freshUniforms();
      u.uBioPhase.value = Math.random() * 100;
      // Inherit the template's clock so a fish spawning at minute nine isn't
      // a second-zero animal swimming next to a school mid-cycle.
      u.uBioTime.value = mat.userData.__bioSkinUniforms?.uBioTime.value ?? 0;
      copy.userData.__bioSkinUniforms = u;
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
    u.uBioStrength.value = off ? 0 : (cfg.strength ?? 1.6);
    u.uBioBodyDarken.value = off ? 1 : (cfg.bodyDarken ?? 0.35);
    u.uBioScale.value = cfg.scale ?? 0.25;
    u.uBioContrast.value = cfg.contrast ?? 1.4;
    u.uBioCoverage.value = cfg.coverage ?? 0.45;
    u.uBioFlow.value = cfg.flow ?? 0.05;
    u.uBioPulseAmp.value = cfg.pulseAmp ?? 0.25;
    u.uBioPulseSpeed.value = cfg.pulseSpeed ?? 1.8;
    u.uBioFlickerAmp.value = cfg.flickerAmp ?? 0;
    u.uBioFlickerRate.value = cfg.flickerRate ?? 2.5;
    u.uBioHueScale.value = cfg.hueScale ?? 1.2;
    u.uBioHueSpread.value = cfg.hueSpread ?? 1.0;
    u.uBioTailBias.value = cfg.tailBias ?? 0.2;
    u.uBioWarp.value = cfg.warp ?? 0.8;
    u.uBioColorA.value.set(cfg.colorA ?? 0x00e5ff);
    u.uBioColorB.value.set(cfg.colorB ?? 0x7b2dff);
    u.uBioColorC.value.set(cfg.colorC ?? 0xffd166);
    // A per-instance material keeps the phase it was born with; a template
    // one has no individual to be, and `phaseSpread` at 0 collapses a school
    // back into lockstep on purpose (useful for judging a pattern).
    if (m.userData.__bioSkinInstance) {
      u.uBioPhase.value = (u.uBioPhase.value % 100) * (cfg.phaseSpread ?? 1);
    }
  }
}

/**
 * Advance the pattern clock. Raw dt, not the hitstop-scaled one: a creature's
 * own light doesn't stop because the game froze for 60ms on a hit.
 *
 * Also where collected instance materials are pruned out of the weak set — see
 * the note on `instances`.
 */
export function updateBiolumSkin(rawDt) {
  for (const m of liveMaterials()) {
    const u = m.userData.__bioSkinUniforms;
    if (u) u.uBioTime.value += rawDt;
  }
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
