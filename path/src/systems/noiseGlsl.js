// ============================================================================
// THE MOTTLING, AS SHARED GLSL — the noise field that IS the seal's surface.
//
// A LEAF MODULE WITH NO IMPORTS, for the same reason causticsGlsl.js is one and
// says so at length: two consumers sample this field and they have to sample
// the SAME one. systems/noiseShader.js paints it onto every creature in the
// game; tools/atlas-render/iconRender.js paints it onto the stills that go in
// documents. A copy in the renderer would agree on the day it was written and
// drift the first time anyone retuned an octave — and the failure is not an
// error, it is a picture of an animal that is very slightly not the animal.
//
// It carries the MOTTLING and nothing else. The glow, the charge flash and the
// wet film stay in noiseShader.js: all three ship at strength 0, all three are
// driven by run-time gameplay state, and a still has none of that state to be
// driven by. What a picture of the seal needs is its hide.
//
// NO `import * as THREE` either, deliberately. These are strings. The uniform
// VALUES live with whoever is building the material, because the game reads
// them off CONFIG.sealShader and the renderer reads them off a spec file, and
// neither should have to reach through the other to get them.
// ============================================================================

/**
 * The mottling's own uniforms. Declared apart from the glow/charge/wet block
 * because those are noiseShader.js's alone.
 */
export const MOTTLE_UNIFORMS_GLSL = `uniform float uNoiseSize;
uniform float uNoiseStrength;
uniform float uNoiseContrast;
uniform vec3  uNoiseColor;
// THE PAINT COAT — how much of the model's own baked map survives underneath.
//
// uNoiseStrength above can only ever MIX toward uNoiseColor where the field is
// bright, so a photographed body keeps its photograph in every trough no matter
// how far that slider goes. On a barracuda at strength 1.22 the result still
// reads as a photo of a barracuda with some shadows painted on it, which is the
// one thing this shader was not supposed to be able to look like.
//
// So the map is dealt with separately, before the mottling: paint 1 covers it
// over with a flat coat and the noise then paints the whole hide, paint 0 is
// exactly what shipped before this existed. Anything between is a hide showing
// through its own markings. Same shape as biolumSkin's pigment, deliberately —
// the two are the same question asked of the two painting layers.
uniform vec3  uNoiseBase;
uniform float uNoisePaint;
// ...and how much of the model's baked EMISSIVE map survives that same coat.
// 0 by default, so covering the photograph covers the light it was giving off
// too. See the note at the emissivemap_fragment injection.
uniform float uNoisePaintGlow;`;

/**
 * The noise field: Perlin, three octaves, plus the luma weights the polarity
 * test below reads. Needs no uniforms of its own — it is pure functions.
 */
export const NOISE_FIELD_GLSL = `const vec3 NOISE_LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 noiseHash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

// Classic Perlin: dot each corner's random gradient with the offset to the
// sample point, then interpolate with the quintic-ish smoothstep so the
// first derivative is continuous across cell boundaries (a plain lerp shows
// the lattice as faint creases).
float perlin3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(dot(noiseHash3(i + vec3(0.0, 0.0, 0.0)), f - vec3(0.0, 0.0, 0.0)),
            dot(noiseHash3(i + vec3(1.0, 0.0, 0.0)), f - vec3(1.0, 0.0, 0.0)), u.x),
        mix(dot(noiseHash3(i + vec3(0.0, 1.0, 0.0)), f - vec3(0.0, 1.0, 0.0)),
            dot(noiseHash3(i + vec3(1.0, 1.0, 0.0)), f - vec3(1.0, 1.0, 0.0)), u.x), u.y),
    mix(mix(dot(noiseHash3(i + vec3(0.0, 0.0, 1.0)), f - vec3(0.0, 0.0, 1.0)),
            dot(noiseHash3(i + vec3(1.0, 0.0, 1.0)), f - vec3(1.0, 0.0, 1.0)), u.x),
        mix(dot(noiseHash3(i + vec3(0.0, 1.0, 1.0)), f - vec3(0.0, 1.0, 1.0)),
            dot(noiseHash3(i + vec3(1.0, 1.0, 1.0)), f - vec3(1.0, 1.0, 1.0)), u.x), u.y), u.z);
}

// Three octaves, unrolled at a fixed count on purpose: making it a uniform
// would mean recompiling the shader every time the tuner moved, and three is
// enough to break up the lattice without the top octave aliasing into noise
// at the size this renders.
float noiseFbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * perlin3(p);
    p *= 2.02;   // not exactly 2, so octave lattices don't line up
    a *= 0.5;
  }
  return v;
}`;

/**
 * The bind-pose position the field is sampled at. See the long note at the top
 * of noiseShader.js for why it is bind-pose and not world: the pattern is
 * painted ON the animal and has to deform with it rather than swim across it.
 */
export const MOTTLE_VARYING_GLSL = 'varying vec3 vNoisePos;';

/**
 * What the vertex shader has to do to fill that varying — one replacement,
 * straight after <begin_vertex>, where `transformed` is still the raw vertex.
 */
export function injectMottleVertex(vertexShader) {
  return vertexShader
    .replace('#include <common>', '#include <common>\n' + MOTTLE_VARYING_GLSL)
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvNoisePos = transformed;');
}

/**
 * The paint coat, the polarity test and the mix, as they go in after
 * <map_fragment>. Leaves `noiseN`, `noisePolarity` and `noiseLit` in scope at
 * the top level of main() — noiseShader.js's glow layers read `noiseLit` much
 * further down, so this may not be wrapped in a block.
 */
export const MOTTLE_FRAGMENT_GLSL = `  float noiseN = clamp(noiseFbm(vNoisePos / max(0.0001, uNoiseSize)) * uNoiseContrast * 0.5 + 0.5, 0.0, 1.0);
  // THE PAINT COAT, BEFORE the mottling and before the polarity below. See the
  // note by uNoisePaint: this is the only line here that can take the model's
  // baked texture off, and the mottling then has a flat hide to work on.
  //
  // TIMES the diffuse uniform — the material colour before any map, which is
  // the field the Models tab's tint swatch writes. So uNoiseBase left white
  // means "paint it whatever this asset is tinted", and one preset can still
  // serve a roster of differently-coloured animals, exactly the way
  // biolumSkin's pigment does.
  //
  // ABOVE the polarity test on purpose. That test asks whether uNoiseColor is
  // darker than the body it is painting on, and the body it is painting on is
  // this coat — not the photograph underneath it. Derived from the map instead,
  // covering a pale texture with a dark coat would flip the mask and light the
  // wrong half of the markings.
  diffuseColor.rgb = mix(diffuseColor.rgb, uNoiseBase * diffuse, clamp(uNoisePaint, 0.0, 1.0));
  // WHICH END OF THE FIELD IS THE BRIGHT ONE, derived rather than assumed.
  // The noise paints toward uNoiseColor, so where that colour is DARKER than
  // the body (which is what it is for — the seal ships no texture and this is
  // its mottling) a high n is a dark patch and the lit skin is 1-n. Tune the
  // noise colour lighter than the body and it flips, which is the only way
  // "the bright patches glow" stays true of whatever is on the sliders.
  float noisePolarity = step(dot(uNoiseColor, NOISE_LUMA), dot(diffuseColor.rgb, NOISE_LUMA));
  float noiseLit = mix(noiseN, 1.0 - noiseN, noisePolarity);
  diffuseColor.rgb = mix(diffuseColor.rgb, uNoiseColor, uNoiseStrength * noiseN);`;

/**
 * The seal's shipped values, as the renderer's starting point.
 *
 * NOT the source of truth — CONFIG.sealShader is, and the game reads it there.
 * These are here so a tool that cannot import config.js (anything running in a
 * plain browser: config.js pulls in the tuning JSON and the CSVs through Vite)
 * still starts from the animal rather than from zero. tools/design-icons.mjs
 * overwrites every one of them off CONFIG when it writes a spec, so the numbers
 * that actually get rendered come from the game either way.
 */
export const MOTTLE_DEFAULTS = {
  size: 0.4,
  strength: 0.35,
  contrast: 1.0,
  color: 0x0a2233,
  baseColor: 0xffffff,
  paint: 0,
};

/**
 * The two GLOW LAYERS — the element glow (Glow Up!) and the strike-meter charge
 * flash — as they go in at <dithering_fragment>.
 *
 * Shared for the same reason the mottling above is: the glow rides the seal's
 * OWN markings (`noiseLit`, left in scope by MOTTLE_FRAGMENT_GLSL) rather than
 * a second pattern, so a lit seal is recognisably the same animal as a dark
 * one — and an icon of the upgrade that lights it has to be lit the same way or
 * it is a picture of a different effect.
 *
 * Both ship at strength 0, and the tests are uniform, so a material that never
 * asks for either pays one comparison. It also leaves `noiseGlowLum` in scope,
 * which is what the wet film (still in noiseShader.js, and fenced to lit
 * STANDARD materials) reads to burn hotter where the animal is glowing.
 *
 * REQUIRES the mottle fragment to have run first, for `noiseLit` and
 * `noisePolarity`.
 */
export const GLOW_UNIFORMS_GLSL = `// THE GLOW (Glow Up!, systems/elements.js). Off — strength 0 — on every
// material that never asks for it, which is all of them until the seal takes
// the upgrade. See the note on setNoiseGlow.
uniform vec3  uNoiseGlowColor;
uniform vec3  uNoiseGlowTip;
uniform float uNoiseGlowStrength;
uniform float uNoiseGlowEdge;
uniform float uNoiseGlowSoft;
uniform float uNoiseGlowWhite;
uniform float uNoiseGlowPulse;
uniform float uNoiseGlowScale;
// THE CHARGE GLOW (the strike meter, systems/chargeSkin.js). A SECOND, fully
// independent layer over the same markings — see the note on
// setNoiseChargeGlow for why it could not just borrow the one above.
uniform vec3  uChargeColor;
uniform vec3  uChargeTip;
uniform float uChargeStrength;
uniform float uChargeEdge;
uniform float uChargeSoft;
uniform float uChargeWhite;
uniform float uChargePulse;
// The head-to-tail crossing flash. <0 = no wave running. The axis is resolved
// on the CPU from the mesh's own bounding box (longest side), so this is a
// normalised 0-at-the-head, 1-at-the-tail position and no model needs to agree
// about which way it was exported.
uniform float uChargeWave;
uniform vec3  uChargeAxis;
uniform float uChargeAxisMin;
uniform float uChargeAxisRange;`;

export const GLOW_LAYERS_GLSL = `  float noiseGlowLum = 0.0;

  if (uNoiseGlowStrength > 0.0) {
    // SCALE 1 IS THE POINT: the glow lights the markings the seal already has,
    // sampled at the same size as the skin, so it is the same pattern rather
    // than a second one.
    //
    // It is a knob anyway because the two are tuned for opposite jobs. The
    // skin's own size wants to be small — it is surface texture on a body with
    // no map at all — and a glow at that size comes out as a fine speckle
    // rather than as patches of light. Above 1 samples the SAME field further
    // out, so the light gathers into bigger areas of the same shape. The
    // branch is uniform, so scale 1 pays nothing for the option.
    float lit = noiseLit;
    if (uNoiseGlowScale != 1.0) {
      float n2 = clamp(noiseFbm(vNoisePos / max(0.0001, uNoiseSize * uNoiseGlowScale))
        * uNoiseContrast * 0.5 + 0.5, 0.0, 1.0);
      lit = mix(n2, 1.0 - n2, noisePolarity);
    }
    // The same mask shape as bioMask in systems/biolumSkin.js — coverage
    // slides the threshold, contrast decides whether the rim is hard or a
    // wash — so the two glows answer to their sliders identically.
    float g = smoothstep(uNoiseGlowEdge - uNoiseGlowSoft, uNoiseGlowEdge + uNoiseGlowSoft, lit);
    // Hottest patches run toward the tip colour. A single flat hue over the
    // whole mask reads as paint; a core that goes white reads as light coming
    // out of something. g*g keeps the white to the crests rather than
    // washing the whole patch out.
    vec3 glowC = mix(uNoiseGlowColor, uNoiseGlowTip, g * g * uNoiseGlowWhite);
    vec3 glowAdd = glowC * (g * uNoiseGlowStrength * uNoiseGlowPulse);
    gl_FragColor.rgb += glowAdd;
    noiseGlowLum += dot(glowAdd, NOISE_LUMA);
  }

  // THE CHARGE GLOW. Same markings, same mask shape, its own everything else —
  // so the strike meter can light the seal on a run that never took Glow Up!,
  // and an element can light it while the meter is empty, without either one
  // reading the other's uniforms.
  if (uChargeStrength > 0.0 || uChargeWave >= 0.0) {
    float cg = smoothstep(uChargeEdge - uChargeSoft, uChargeEdge + uChargeSoft, noiseLit);
    float amount = uChargeStrength * uChargePulse;

    // THE CROSSING FLASH — one band of light travelling head to tail on the
    // frame the bar fills. Added to the steady level rather than replacing it,
    // so it reads as the seal surging rather than as the glow restarting.
    if (uChargeWave >= 0.0) {
      float t = clamp((dot(vNoisePos, uChargeAxis) - uChargeAxisMin)
        / max(0.0001, uChargeAxisRange), 0.0, 1.0);
      float d = t - uChargeWave;
      // Narrow gaussian: a band crossing the body, not a whole-body flash.
      // Fades as the wave runs out so the tail end doesn't snap off.
      amount += 2.6 * exp(-(d * d) / 0.012) * (1.0 - uChargeWave);
    }

    vec3 cc = mix(uChargeColor, uChargeTip, cg * cg * uChargeWhite);
    vec3 chargeAdd = cc * (cg * amount);
    gl_FragColor.rgb += chargeAdd;
    noiseGlowLum += dot(chargeAdd, NOISE_LUMA);
  }
`;

/**
 * What a still needs to light the markings up, in the units the uniforms take.
 * `strength` 0 is an ordinary animal; the card art wants it well up.
 */
export const GLOW_DEFAULTS = {
  color: 0x00e5ff,
  tip: 0xffffff,
  strength: 0,
  edge: 0.7,
  soft: 0.23,
  white: 0.35,
  scale: 1,
};
