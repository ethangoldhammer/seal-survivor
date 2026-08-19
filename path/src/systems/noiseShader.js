import * as THREE from 'three';
import { CONFIG } from '../config.js';
// The water's own caustic function, shared rather than copied — see that file.
import { CAUSTICS_GLSL } from './causticsGlsl.js';

// Procedural Perlin noise painted onto a creature's diffuse, injected into
// three.js's own MeshStandardMaterial rather than replacing it — so the model
// keeps real lighting, shadows, the emissive map and everything else the
// standard material does. Only `diffuseColor` is touched.
//
// This exists because the seal ships no texture at all (furseal.glb has UVs
// but no image), so it renders as one flat colour. Noise gives it surface
// without anyone having to paint a map.
//
// WHY THE NOISE IS SAMPLED IN BIND-POSE OBJECT SPACE
//
// The obvious choices are both wrong here:
//   - UV space would need a sensible unwrap, and this model's is unknown.
//   - Post-skinning object space moves with the animation, so the pattern
//     swims across the body as the seal swims — the mottling would crawl
//     over the skin like it was projected from outside.
// `transformed` immediately after <begin_vertex> is the raw vertex position
// BEFORE skinning is applied, which is fixed to the mesh. Sampling there
// paints the pattern onto the seal once and it deforms with the body. Same
// reasoning as the outline shells in assets.js, which offset at the same
// point for the same reason.
//
// Genuine gradient (Perlin) noise, not the value noise used elsewhere in the
// project (systems/calamari.js, systems/garlic.js). Value noise is cheaper
// but has visible axis-aligned blockiness at low frequencies, which on a
// large smooth body is exactly where it would show.

const GLSL_NOISE = `
uniform float uNoiseSize;
uniform float uNoiseStrength;
uniform float uNoiseContrast;
uniform vec3  uNoiseColor;
// THE GLOW (Glow Up!, systems/elements.js). Off — strength 0 — on every
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
uniform float uChargeAxisRange;
// THE WET FILM (CONFIG.sealShader.wet*). Amount 0 — bone dry, not one
// instruction of difference — on every material that never asks for it, which
// is every material until someone moves the slider. See the block at the
// bottom of this file for what the layer is and why it is shaped this way.
uniform float uWetAmount;
uniform vec3  uWetColor;
uniform float uWetGloss;
uniform float uWetTight;
uniform float uWetEdge;
uniform float uWetSoft;
uniform float uWetSteps;
uniform float uWetRim;
uniform float uWetRimPower;
uniform float uWetPatch;
uniform float uWetCaustics;
uniform float uWetCausticScale;
uniform float uWetCausticUp;
uniform float uWetGlow;
uniform float uWetTint;
// THE OCEAN'S SIDE OF IT — what the film has to reflect, pushed once a frame
// from the water's own resolved state (setNoiseWetEnv, called from world.js).
// SHARED uniform objects: every wearer holds the same object, so this is one
// write per frame however many animals are in the water.
uniform vec4  uWetSea;      // x scale, y phase, z depth falloff, w day/night
uniform vec3  uWetSeaColor;
uniform vec2  uWetSeaSpan;  // still-water line, seabed
varying vec3  vNoisePos;
// THE ANIMATED WORLD POSITION, and the exact opposite decision from vNoisePos
// directly above it — which is deliberately bind-pose so the markings stay
// painted on. The caustics are not on the animal, they are in the WATER: the
// veins have to stay put in the world and let the seal swim through them, so
// this one is sampled after skinning and pushed all the way out to world space.
// Get these two the wrong way round and the dapple either freezes to the body
// (bind pose) or the markings swim across the skin (world), and both look like
// a plausible effect rather than like a bug.
varying vec3  vNoiseWorld;

const vec3 NOISE_LUMA = vec3(0.2126, 0.7152, 0.0722);

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
}
${CAUSTICS_GLSL}
`;

// Every material this has been attached to, so a tuner change can push new
// uniform values without rebuilding anything.
const attached = new Set();

// THE OCEAN'S SIDE OF THE WET FILM — what the water is doing this frame, which
// is the same for every animal in it.
//
// ONE OBJECT, HANDED TO EVERY MATERIAL BY REFERENCE rather than copied per
// wearer: three reads `.value` at draw time, so writing these four fields once
// updates a school of forty. The alternative is a loop over `attached` every
// frame doing eight assignments each, for values that cannot differ between
// them.
const wetSea = {
  uWetSea: { value: new THREE.Vector4(0.16, 0, 1.6, 1) },
  uWetSeaColor: { value: new THREE.Color(0xbfefff) },
  uWetSeaSpan: { value: new THREE.Vector2(0, -1) },
};

/**
 * Tell the wet film what the water is doing. Called once a frame from
 * world.js with systems/water.js's `liveCaustics` — which is the state the
 * water plane just finished uploading, after the punch-in gain, the day/night
 * bus and the sun's tint.
 *
 * Cheap enough to be unconditional: four writes, no traversal, no allocation.
 */
export function setNoiseWetEnv(c) {
  if (!c) return;
  // Intensity carries `on`, so switching the caustics off in the tuner takes
  // them off the animals in the same frame it takes them out of the water —
  // and the shader's own `uWetSea.w > 0.0` test then skips the sample.
  // `light`, not `intensity` — see the note in water.js. The film's own
  // strength is CONFIG.sealShader.wetCaustics; this carries the time of day and
  // the tuner's off switch, and nothing else.
  wetSea.uWetSea.value.set(c.scale, c.phase, c.falloff, c.on > 0.5 ? c.light : 0);
  wetSea.uWetSeaColor.value.copy(c.color);
  wetSea.uWetSeaSpan.value.set(c.surfaceY, c.bottomY);
}

/**
 * Inject the noise into one material. Safe to call on a material that has
 * already been processed — it no-ops rather than stacking a second copy.
 */
export function attachNoiseShader(material, preset = null) {
  if (!material || material.userData.__noiseAttached) return;
  // Needs a diffuseColor to modulate, which the unlit/basic materials the
  // procedural fallback shapes use do have, but the sprite path does not.
  if (!('color' in material)) return;
  material.userData.__noiseAttached = true;
  // Which block under CONFIG.sealShader.presets this material wears. Null means
  // the base — which is every material that existed before per-species noise,
  // so nothing changes for the seal or the escorts.
  material.userData.__noisePreset = preset;

  const u = {
    uNoiseSize: { value: 0.4 },
    uNoiseStrength: { value: 0.35 },
    uNoiseContrast: { value: 1.0 },
    uNoiseColor: { value: new THREE.Color(0x0a2233) },
    // Strength 0 = an ordinary animal. Nothing but setNoiseGlow ever raises
    // it, so a material that is never given a glow renders exactly as it did
    // before this existed — the branch in the shader is uniform, so it costs
    // one test the GPU takes the same way for every fragment in the draw.
    uNoiseGlowColor: { value: new THREE.Color(0x00e5ff) },
    uNoiseGlowTip: { value: new THREE.Color(0xffffff) },
    uNoiseGlowStrength: { value: 0 },
    uNoiseGlowEdge: { value: 0.7 },
    uNoiseGlowSoft: { value: 0.23 },
    uNoiseGlowWhite: { value: 0.35 },
    uNoiseGlowPulse: { value: 1 },
    uNoiseGlowScale: { value: 1 },
    // Same "off costs nothing" reasoning as the element glow above: strength 0
    // and wave -1 means the branch is never entered, and the test is uniform
    // so every fragment in the draw takes it the same way.
    uChargeColor: { value: new THREE.Color(0x7ad7ff) },
    uChargeTip: { value: new THREE.Color(0xffffff) },
    uChargeStrength: { value: 0 },
    uChargeEdge: { value: 0.7 },
    uChargeSoft: { value: 0.23 },
    uChargeWhite: { value: 0.35 },
    uChargePulse: { value: 1 },
    uChargeWave: { value: -1 },
    uChargeAxis: { value: new THREE.Vector3(1, 0, 0) },
    uChargeAxisMin: { value: -1 },
    uChargeAxisRange: { value: 2 },
    // THE WET FILM. Amount 0 is dry and is the shipped default, so every
    // material that has ever worn this shader renders bit for bit what it did
    // before — the rest of these are the shape the film takes the moment
    // someone turns it up, not values anything is using yet.
    uWetAmount: { value: 0 },
    uWetColor: { value: new THREE.Color(0xdff2ff) },
    uWetGloss: { value: 0.7 },
    uWetTight: { value: 24 },
    uWetEdge: { value: 0.15 },
    uWetSoft: { value: 0.5 },
    uWetSteps: { value: 2 },
    uWetRim: { value: 0.9 },
    uWetRimPower: { value: 3.4 },
    uWetPatch: { value: 0.35 },
    uWetCaustics: { value: 1.2 },
    uWetCausticScale: { value: 4 },
    uWetCausticUp: { value: 0.75 },
    uWetGlow: { value: 1 },
    uWetTint: { value: 0.5 },
  };
  material.userData.__noiseUniforms = u;

  material.onBeforeCompile = (shader) => {
    // Both bags: `u` is this material's own, `wetSea` is the one every wearer
    // shares. Assigned rather than merged so the shared objects stay shared —
    // a spread here would give each material a private copy and setNoiseWetEnv
    // would silently stop reaching any of them.
    Object.assign(shader.uniforms, u, wetSea);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vNoisePos;\nvarying vec3 vNoiseWorld;')
      // Straight after <begin_vertex>, where `transformed` is still the
      // bind-pose position — see the note at the top of this file.
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvNoisePos = transformed;')
      // ...and straight BEFORE <project_vertex>, which is the last moment
      // `transformed` is still a position rather than a clip-space vertex — and
      // by then it has been through the morph, skin and displacement chunks, so
      // this is where the animal actually IS this frame. modelMatrix takes it
      // the rest of the way out to the world the caustics live in.
      .replace('#include <project_vertex>', '\tvNoiseWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#include <project_vertex>');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL_NOISE)
      // After <map_fragment>, so this modulates whatever the colour map left
      // behind rather than being overwritten by it. On a model with no map
      // that include is empty and this simply tints the flat base colour.
      //
      // NOT wrapped in a block any more: `noiseLit` has to survive down to
      // <dithering_fragment> below, and both chunks sit at the top level of
      // main() so a plain local reaches from one to the other.
      .replace('#include <map_fragment>', `#include <map_fragment>
  float noiseN = clamp(noiseFbm(vNoisePos / max(0.0001, uNoiseSize)) * uNoiseContrast * 0.5 + 0.5, 0.0, 1.0);
  // WHICH END OF THE FIELD IS THE BRIGHT ONE, derived rather than assumed.
  // The noise paints toward uNoiseColor, so where that colour is DARKER than
  // the body (which is what it is for — the seal ships no texture and this is
  // its mottling) a high n is a dark patch and the lit skin is 1-n. Tune the
  // noise colour lighter than the body and it flips, which is the only way
  // "the bright patches glow" stays true of whatever is on the sliders.
  float noisePolarity = step(dot(uNoiseColor, NOISE_LUMA), dot(diffuseColor.rgb, NOISE_LUMA));
  float noiseLit = mix(noiseN, 1.0 - noiseN, noisePolarity);
  diffuseColor.rgb = mix(diffuseColor.rgb, uNoiseColor, uNoiseStrength * noiseN);`)
      // THE GLOW RIDES THE SAME FIELD. Added at <dithering_fragment>, where
      // the colour is already final, so this is light on top of the animal
      // rather than a change to its pigment — and it lands the same way on a
      // lit or an unlit material, which is the reason biolumSkin.js hooks the
      // same chunk.
      //
      // Sampling `noiseLit` rather than a second noise field is the whole
      // point: the light comes out of the seal's OWN markings, so a glowing
      // seal is recognisably the same animal as a dark one. A second pattern
      // over the top read as a decal, and darkening the body to make it show
      // read as the seal disappearing.
      .replace('#include <dithering_fragment>', `
  // HOW MUCH LIGHT THIS FRAGMENT IS PUTTING OUT, accumulated by the two glow
  // layers below as they add it. The wet film reads it at the bottom: a film of
  // water over something that is glowing reflects the glow as well as letting
  // it through, so the sheen has to burn hotter exactly where the animal does.
  //
  // Accumulated rather than re-derived from gl_FragColor, which by here also
  // carries the lit body, the fog and the tone map — keying the film off that
  // would make a seal in bright water permanently shiny and a seal in the deep
  // permanently dull, which is a depth cue, not a glow reaction.
  float noiseGlowLum = 0.0;

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

  // -------------------------------------------------------------------------
  // THE WET FILM. A sheet of water lying on the animal, drawn as a TOON
  // reflection: one hard-edged sheet of light with a countable number of steps
  // in it, not a smooth Blinn lobe. A seal that has just surfaced is the
  // shiniest thing in the frame and the surface was the one property this
  // shader had no opinion about at all.
  //
  // TWO HALVES, AND THE SPLIT IS THE WHOLE DESIGN:
  //
  //   the MASK   where the film catches anything — the banded specular sheet,
  //              the grazing rim, and the caustic veins landing on it. Shape
  //              only; none of it knows how bright the world is.
  //   the LIGHT  how hot that catch burns — 1 on an ordinary animal, more on
  //              one that is glowing.
  //
  // They multiply, and that is what makes the layer REACT rather than just sit
  // there: an element glow or a full strike meter drives the film hotter
  // wherever it already is, so lighting the seal up also makes it look wetter,
  // and the shape of the sheen is still the shape of the light on the body.
  // Adding the two instead would paint a flat wash of colour over the animal on
  // every frame it happened to be glowing.
  //
  // NEEDS A LIT MATERIAL — geometryNormal and geometryViewDir are declared by
  // <lights_fragment_begin>, so this is fenced to STANDARD (which covers
  // MeshPhysicalMaterial too). The unlit fallback shapes that also wear this
  // shader would be a COMPILE ERROR without the fence, and a fragment shader
  // that fails to compile renders nothing at all and reports nothing.
#ifdef STANDARD
  if (uWetAmount > 0.0) {
    vec3 wetN = normalize(geometryNormal);
    vec3 wetV = geometryViewDir;
    // THE KEY LIGHT IS THE SUN. daylight.js swings it across the sky over the
    // run, so the wet highlight crawls along the body as the hours pass and
    // goes low and long at dusk — for free, and correct by construction,
    // because it is the same vector the diffuse shading used. Head-on off the
    // camera if the scene has no directional light, which is only ever a
    // harness.
    vec3 wetL = wetV;
    #if NUM_DIR_LIGHTS > 0
      wetL = directionalLights[0].direction;
    #endif
    float lobe = pow(max(dot(wetN, normalize(wetL + wetV)), 0.0), max(uWetTight, 1.0));
    // uWetEdge is where the sheet STARTS — everything below it is dry surface,
    // and what is left is stretched back over the full range so the terraces
    // below always have the whole sheet to spread across however narrow the cut.
    float wetT = clamp((lobe - uWetEdge) / max(1.0 - uWetEdge, 1e-4), 0.0, 1.0);
    // ...and then terraced, which is the toon part. THE SAME IDIOM AS THE BANDS
    // IN systems/toonShade.js, deliberately down to the arithmetic, because the
    // two are looked at on the same animal and a highlight that stepped by a
    // different rule than the shading under it reads as two effects arguing.
    //
    // The shoulder is on the LEADING edge of each terrace, which is the part
    // that matters on this model. A plain floor() is a razor cut, and a razor
    // cut through a value interpolated across a low-poly body traces the
    // TESSELLATION: the seal came out wearing hard-edged white quads, which
    // does not read as a hard cel highlight, it reads as the mesh showing
    // through. With a shoulder the steps stay countable and their edges stop
    // being polygons.
    float wetS = max(uWetSteps, 1.0);
    float wetScaled = wetT * wetS;
    float wetIdx = min(floor(wetScaled), wetS - 1.0);
    float wetFrac = wetScaled - wetIdx;
    // Never a zero-width smoothstep: edge0 == edge1 is undefined in GLSL, and
    // "undefined" here means one driver draws the sheet and another draws
    // nothing. uWetSoft 0 is meant to be the hardest cel edge, not a coin flip.
    float wetShoulder = uWetSoft > 1e-4 ? smoothstep(0.0, uWetSoft, wetFrac) : 0.0;
    float wetShape = clamp((wetIdx + wetShoulder) / max(wetS - 1.0, 1.0), 0.0, 1.0);
    // The rim. Water beads to the edge of a curved body and the silhouette is
    // where a wet animal gives itself away at a glance — at play scale this
    // carries the read further than the highlight does.
    float wetFres = pow(1.0 - clamp(dot(wetN, wetV), 0.0, 1.0), max(uWetRimPower, 0.5));

    // THE CAUSTICS, sampled from the SAME function, at the SAME world
    // coordinates, on the SAME phase as the water plane behind the animal
    // (systems/causticsGlsl.js, fed by setNoiseWetEnv). That is the entire
    // trick: a vein crossing the water is the vein crossing the seal, so the
    // dapple is one continuous field the animal is swimming through instead of
    // a texture stuck to it.
    float wetCau = 0.0;
    if (uWetCaustics > 0.0 && uWetSea.w > 0.0) {
      // Depth measured from the still line to the seabed, exactly as the fill
      // measures it, so the veins run out on the animal at the same depth they
      // run out in the water it is in.
      float wetDepth = clamp((uWetSeaSpan.x - vNoiseWorld.y)
        / max(uWetSeaSpan.x - uWetSeaSpan.y, 0.0001), 0.0, 1.0);
      float wetFade = pow(1.0 - wetDepth, uWetSea.z);
      float c = caustics(vNoiseWorld.xy * (uWetSea.x * uWetCausticScale), uWetSea.y);
      // IT COMES FROM ABOVE. Refracted sunlight arrives pointing down, so a
      // back catches it and a belly does not — without this the veins wrap all
      // the way round the animal and read as a pattern printed on it rather
      // than as light falling on it. World up, taken into view space where the
      // normal already lives.
      vec3 wetUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
      float up = mix(1.0, clamp(dot(wetN, wetUp) * 0.5 + 0.5, 0.0, 1.0), uWetCausticUp);
      wetCau = c * uWetSea.w * wetFade * up;
    }

    // Added to the mask rather than multiplied into it: a vein is light
    // ARRIVING, and it lands across the whole wet back, not only inside the
    // key light's sheet. Multiplied, the caustics would be invisible anywhere
    // the highlight already wasn't — which is most of the animal.
    float wetMask = wetShape * uWetGloss + wetFres * uWetRim + wetCau * uWetCaustics;
    // Wet is not even. The markings this whole file exists to paint decide
    // where the film beads and where the fur has drained — 0 is a uniformly
    // lacquered animal, 1 is sheen only on the bright patches.
    wetMask *= mix(1.0, noiseLit, uWetPatch);

    // THE COLOUR IT REFLECTS. uWetTint pulls the film from its own authored
    // white toward the light the ocean is actually making this minute — which
    // is already warm at dawn, cold at night and knocked down by the day/night
    // bus, because it is the caustic colour the water resolved rather than the
    // one in config.
    vec3 wetC = mix(uWetColor, uWetSeaColor, uWetTint);
    gl_FragColor.rgb += wetC * (max(wetMask, 0.0) * (1.0 + uWetGlow * noiseGlowLum) * uWetAmount);
  }
#endif
#include <dithering_fragment>`);
  };
  material.needsUpdate = true;
  attached.add(material);
}

/**
 * Push CONFIG.sealShader onto every attached material. Pure uniform writes —
 * no recompile, so this is safe to call from a slider's input event.
 */
export function applyNoiseSettings() {
  const cfg = CONFIG.sealShader ?? {};
  for (const m of attached) {
    const u = m.userData.__noiseUniforms;
    if (!u) continue;
    // BASE, THEN THE SPECIES' OWN OVERRIDES — the same fall-through
    // CONFIG.biolumSkin and CONFIG.toonShade use.
    //
    // This started as one global set of four numbers, because the only thing
    // wearing it was the seal. A shark and an orca want different mottling from
    // each other and from the animal it was authored for, and with one global
    // block the second species to be tuned silently retunes the first. A
    // material with no preset reads the base alone, so every existing wearer is
    // bit-for-bit what it was.
    const preset = m.userData.__noisePreset;
    const p = preset ? { ...cfg, ...(cfg.presets?.[preset] ?? {}) } : cfg;
    u.uNoiseSize.value = p.size ?? 0.4;
    // `enabled` folds into strength rather than branching in the shader:
    // one less uniform for the fragment to test per pixel, and it makes the
    // toggle fade the same way the slider does instead of popping.
    u.uNoiseStrength.value = (cfg.enabled === false || p.enabled === false)
      ? 0 : (p.strength ?? 0.35);
    u.uNoiseContrast.value = p.contrast ?? 1;
    u.uNoiseColor.value.set(p.color ?? 0x0a2233);

    // THE WET FILM. Flat keys rather than a `wet: {}` block, and that is not a
    // style choice: the preset fall-through three lines up is a SHALLOW spread,
    // so a species overriding one nested field would replace the whole object
    // and silently inherit the shader's own defaults for the other fourteen.
    // Flat, a preset can disagree about `wetRim` alone.
    //
    // `enabled` folds into the amount the same way it does for the noise, so
    // the master switch fades the film out instead of popping it.
    u.uWetAmount.value = (cfg.enabled === false || p.enabled === false)
      ? 0 : Math.max(0, p.wet ?? 0.55);
    u.uWetColor.value.set(p.wetColor ?? 0xdff2ff);
    u.uWetGloss.value = p.wetGloss ?? 0.7;
    u.uWetTight.value = Math.max(1, p.wetTight ?? 24);
    u.uWetEdge.value = p.wetEdge ?? 0.15;
    u.uWetSoft.value = p.wetSoft ?? 0.5;
    u.uWetSteps.value = Math.max(1, p.wetSteps ?? 2);
    u.uWetRim.value = p.wetRim ?? 0.9;
    u.uWetRimPower.value = Math.max(0.5, p.wetRimPower ?? 3.4);
    u.uWetPatch.value = p.wetPatch ?? 0.35;
    u.uWetCaustics.value = p.wetCaustics ?? 1.2;
    u.uWetCausticScale.value = Math.max(0.01, p.wetCausticScale ?? 4);
    u.uWetCausticUp.value = p.wetCausticUp ?? 0.75;
    u.uWetGlow.value = p.wetGlow ?? 1;
    u.uWetTint.value = p.wetTint ?? 0.5;
  }
}

export function noiseShaderMaterialCount() {
  return attached.size;
}

// ---------------------------------------------------------------------------
// THE GLOW — Glow Up! lighting up the seal's own markings.
//
// WHY IT LIVES HERE AND NOT IN systems/biolumSkin.js, which is the file whose
// whole job is glowing skin. Because the seal already HAS a pattern. Attaching
// a biolum skin to it painted a second, unrelated field over the first and
// darkened the body underneath to make that field legible, which is two
// separate ways of not looking like the same animal: a decal, on a seal that
// had gone dark enough to lose against the water. The markings the player has
// been looking at all run ARE the pattern; this makes their bright patches
// emit and leaves everything else exactly where it was.
//
// It is also the honest place for it. The mask is `noiseLit`, a value that
// only exists inside this shader — reading it from another system would mean
// duplicating three octaves of Perlin and hoping the two copies stayed in
// step through every tuner change.
//
// SCOPED TO ONE ROOT, not pushed globally like applyNoiseSettings. The glow is
// the player's ability, not a property of the noise: any other model given
// `noiseShader: true` must stay unlit, and the escorts must not light up
// because the seal did.
// ---------------------------------------------------------------------------

/**
 * Light one creature's noise pattern.
 *
 * @param root  the object returned by createVisual — every material under it
 *              that carries the noise shader is lit.
 * @param glow  { color, tipColor, strength, coverage, contrast, white, scale }
 *              `coverage` and `contrast` shape the mask exactly as they do in
 *              biolumSkin's bioMask, so the two glows read the same on the
 *              same numbers. strength 0 (or omitting the argument) puts the
 *              animal back.
 */
export function setNoiseGlow(root, glow = null) {
  if (!root) return;
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      // `attached` membership, not a userData flag: Material.clone() deep-
      // copies userData through JSON, so a clone carries a __noiseUniforms
      // that LOOKS right and whose colours came back as plain objects with no
      // .set — and nothing in its shader reads them anyway, because clone()
      // does not copy onBeforeCompile. Only a material this module injected
      // has live uniforms.
      if (!attached.has(m)) continue;
      const u = m.userData.__noiseUniforms;
      if (!glow) { u.uNoiseGlowStrength.value = 0; continue; }
      u.uNoiseGlowStrength.value = Math.max(0, glow.strength ?? 0);
      u.uNoiseGlowColor.value.set(glow.color ?? 0x00e5ff);
      u.uNoiseGlowTip.value.set(glow.tipColor ?? 0xffffff);
      u.uNoiseGlowWhite.value = Math.min(1, Math.max(0, glow.white ?? 0.35));
      u.uNoiseGlowScale.value = Math.max(0.05, glow.scale ?? 1);
      // Same shaping as bioMask: coverage slides the threshold, contrast
      // decides how hard the rim is, and the softness floor is what stops a
      // high contrast from producing a one-pixel edge that crawls as the
      // seal swims.
      u.uNoiseGlowEdge.value = 1 - Math.min(1, Math.max(0, glow.coverage ?? 0.3));
      u.uNoiseGlowSoft.value = Math.max(0.03, 0.5 / Math.max(0.05, glow.contrast ?? 2.2));
    }
  });
}

/** The breath, 0..2-ish, written every frame. Separate from setNoiseGlow so the
 * per-frame path is one uniform write rather than a full restamp. */
export function setNoiseGlowPulse(root, pulse) {
  if (!root) return;
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!attached.has(m)) continue;
      m.userData.__noiseUniforms.uNoiseGlowPulse.value = pulse;
    }
  });
}

// ---------------------------------------------------------------------------
// THE CHARGE GLOW — the strike meter, read off the seal itself.
//
// WHY A SECOND LAYER AND NOT setNoiseGlow WITH DIFFERENT NUMBERS.
//
// Because the two are owned by different systems that are live at the same
// time and neither can be asked to yield. systems/elements.js restamps the
// glow above whenever the element, its level, the night factor or the day
// power bucket moves, and it early-outs entirely at element level 0 — so a run
// that never took Glow Up! has no glow uniforms being written at all, and a
// charge read routed through them would simply not exist on most runs. Sharing
// one layer would mean whichever system stamped last won, and the loser would
// look like a bug on a timer.
//
// Two layers, added independently in the same hook, is the whole fix: the
// element says what the seal IS, the charge says what it HAS, and they compose
// the way two lights do.
// ---------------------------------------------------------------------------

// Resolved once per body: which local axis runs head to tail, and over what
// range. Cached on the root because it is a bounding-box sweep over every
// skinned mesh and the answer cannot change without the model changing.
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

function resolveChargeAxis(root) {
  if (root.userData.__chargeAxis) return root.userData.__chargeAxis;
  const box = new THREE.Box3();
  let any = false;
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    // The BIND pose, which is what vNoisePos carries — geometry.boundingBox is
    // computed from `position`, before skinning, so the two agree by
    // construction. Measuring the world box instead would drift every frame
    // the seal moved.
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    if (o.geometry.boundingBox) { box.union(o.geometry.boundingBox); any = true; }
  });
  if (!any || box.isEmpty()) {
    return { axis: AXES[0], min: -1, range: 2 };
  }
  const size = box.getSize(new THREE.Vector3());
  // Longest side wins — the same rule biolumSkin bakes aBioAxis with, so a
  // travelling pulse runs along the animal in both systems.
  const i = size.x >= size.y && size.x >= size.z ? 0 : (size.y >= size.z ? 1 : 2);
  const comp = ['x', 'y', 'z'][i];
  const out = {
    axis: AXES[i],
    min: box.min[comp],
    range: Math.max(0.0001, size[comp]),
  };
  root.userData.__chargeAxis = out;
  return out;
}

/**
 * Light the seal's markings with the CHARGE state.
 *
 * @param root  the seal's visual root.
 * @param glow  { color, tipColor, strength, coverage, contrast, white } —
 *              shaped exactly like setNoiseGlow's argument so the two layers
 *              answer to the same numbers. Null or strength 0 puts it out.
 */
export function setNoiseChargeGlow(root, glow = null) {
  if (!root) return;
  const ax = glow ? resolveChargeAxis(root) : null;
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!attached.has(m)) continue;
      const u = m.userData.__noiseUniforms;
      if (!glow) { u.uChargeStrength.value = 0; u.uChargeWave.value = -1; continue; }
      u.uChargeStrength.value = Math.max(0, glow.strength ?? 0);
      u.uChargeColor.value.set(glow.color ?? 0x7ad7ff);
      u.uChargeTip.value.set(glow.tipColor ?? 0xffffff);
      u.uChargeWhite.value = Math.min(1, Math.max(0, glow.white ?? 0.35));
      u.uChargeEdge.value = 1 - Math.min(1, Math.max(0, glow.coverage ?? 0.3));
      u.uChargeSoft.value = Math.max(0.03, 0.5 / Math.max(0.05, glow.contrast ?? 2.2));
      u.uChargeAxis.value.copy(ax.axis);
      u.uChargeAxisMin.value = ax.min;
      u.uChargeAxisRange.value = ax.range;
    }
  });
}

/**
 * The per-frame channels: the breath, and the crossing wave's position.
 *
 * Separate from the stamp above for the same reason setNoiseGlowPulse is —
 * these move every frame and a full restamp per frame would be a traverse and
 * a dozen uniform writes to say one number changed.
 *
 * @param wave 0..1 head-to-tail position, or <0 for no wave running.
 */
export function setNoiseChargePulse(root, pulse, wave = -1) {
  if (!root) return;
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!attached.has(m)) continue;
      const u = m.userData.__noiseUniforms;
      u.uChargePulse.value = pulse;
      u.uChargeWave.value = wave;
    }
  });
}

/**
 * Put every noise-shaded animal back to unlit. Called at RUN START.
 *
 * Global rather than per-root on purpose: the glow is written onto a material
 * that outlives the run — the seal's body is not rebuilt between runs, and the
 * ship asset's materials are not rebuilt at all — so a run that ended glowing
 * green hands the next one a green seal, before a single card has been drawn.
 * At reset there is no body to walk anyway; resetElements runs before the
 * player is put back.
 */
export function clearNoiseGlow() {
  for (const m of attached) {
    const u = m.userData.__noiseUniforms;
    if (!u) continue;
    u.uNoiseGlowStrength.value = 0;
    u.uNoiseGlowPulse.value = 1;
    // The charge layer outlives a run exactly the same way — the seal's body
    // is not rebuilt between runs — so a run that ended on a full meter would
    // otherwise hand the next one a lit seal before it had eaten anything.
    u.uChargeStrength.value = 0;
    u.uChargePulse.value = 1;
    u.uChargeWave.value = -1;
  }
}
