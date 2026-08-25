import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { advanceCycles } from './beatSync.js';

// Seabed grass bending in the current, done entirely in the vertex shader.
// Nothing here touches the CPU per frame except one uniform write for the
// clock, so a field of grass costs the same whether there are two clumps or
// two hundred — which is the only reason scattering it is affordable at all.
//
// WHY uv.y IS THE MASK
//
// The bend has to be zero at the root and full at the tip, so it needs a
// per-vertex "how far up my own blade am I" number. Two candidates, and the
// obvious one is wrong:
//
//   - Object-space Y is per-CLUMP, not per-blade. The clump is 3.96 units tall
//     but its blades run from 0.3 to 3.4, so a short blade's tip sits at the
//     same height as a tall blade's middle. Masking on height bends every
//     blade by a different fraction of its own length: the short ones barely
//     move while the tall ones whip.
//   - uv.y is per-BLADE and already normalised. Every card in the source is
//     unwrapped root-at-0, tip-at-1 (measured: uv.y spans exactly 0..1 on all
//     18 meshes, correlating 0.876–1.000 with local Y). It is exactly the
//     parameter this needs, it costs nothing, and it is already in the file.
//
// So tools/optimize-grass.mjs remaps u into its atlas slot and leaves v
// untouched. If anyone re-atlases this asset vertically, the sway dies — and
// it dies quietly, as grass that bends from the wrong place rather than as an
// error. That is the one thing to keep in mind when touching that script.
//
// WHY THE PUSH IS IN OBJECT SPACE
//
// assets.js seats every model inside an orientation group (see
// orientationQuaternion), so the asset's own axes are not the world's. Bending
// `transformed` in object space, before that group's rotation, means the grass
// leans along its own ground plane no matter how the entry is oriented or
// which way CONFIG.view has the camera pointing. Bending in world space would
// make the blades shear sideways out of the seabed the moment the view changed.
//
// The wave phase, by contrast, IS read from world position — that is what
// stops every clump in the field from pulsing in unison, and it wants to be a
// property of where the clump stands, not of its local mesh.

const GLSL_SWAY = `
uniform float uSwayCycle;        // main sway position, in cycles
uniform float uSwayFlutterCycle; // tip chatter position, in cycles
uniform float uSwayAmplitude;
uniform float uSwayStiffness;
uniform float uSwayWavelength;
uniform vec2  uSwayDir;
uniform float uSwayFlutter;
uniform float uSwayBend;
uniform float uSwayHeight;  // subject height, in the space transformed arrives in
uniform float uSwayUseUv;   // 1 = mask on uv.y, 0 = on height (see attachGrassSway)
`;

// Injected after <begin_vertex>, where `transformed` is the raw object-space
// position. Same insertion point the noise shader and the outline shells use,
// for the same reason: it is the last moment the vertex is still the modeller's.
//
// The reasoning lives out here rather than inside the template on purpose. That
// string is shipped verbatim to every driver's GLSL compiler, so prose in it is
// bytes on the wire and a portability risk besides — the GLSL ES source
// character set does not promise to accept the em dashes and curly quotes this
// file is otherwise written with. Comments inside the shader stay short and
// ASCII; the "why" stays here.
//
//   swayT   root-to-tip parameter, 0 at the base and 1 at the tip. TWO sources,
//           and which one is right is a fact about the model, not a preference
//           — see attachGrassSway's `mask` option.
//
//           uv.y is the grass clump's, for the reason at the top of the file.
//           The guard is USE_MAP, not USE_UV: since r152 three gives each map
//           its own varying, and vMapUv is declared under USE_MAP while USE_UV
//           governs the unrelated vUv. Guarding on the wrong one still compiles
//           and quietly takes the other branch, which is the worst of both
//           outcomes. <uv_vertex> assigns it well before <begin_vertex>, so it
//           is live here, and mapTransform is identity absent
//           KHR_texture_transform — so this is the raw v.
//
//           Object-space height is the SeaFlora bed's. Those props are one
//           plant per file with the base already at y=0, so height IS the
//           blade parameter and there is no mixed-height clump to get it
//           wrong. Their UVs cannot be used: split-seabed.mjs crops each prop
//           to its own patch of the shared watercolour sheet, and while that
//           leaves v spanning roughly 0..1 it does not promise which end is
//           the root — measured, broadleaf_b correlates -0.80 with its own
//           height and the two corals only 0.77-0.80, so uv.y there would bend
//           a leaf from the tip and no error would say so.
//
//           Selected by UNIFORM rather than by #define, because
//           customProgramCacheKey below pins every sway material to one cached
//           program and that is only sound while the injected source is
//           byte-identical for all of them. A #define here would hand the
//           second material the first one's compiled shader.
//
//   swayDir the current, in the space the push is applied in. Under
//           USE_INSTANCING that is NOT the world: seabedScatter gives every
//           plant a random yaw on its instance matrix, which would rotate an
//           object-space push into a different world direction per plant and
//           turn one current into a field of plants each leaning its own way.
//           Carrying the world direction back through the instance's basis
//           (its transpose, which for a rotation is its inverse) makes the
//           whole bed lean together again. The PHASE stays world — a gust
//           crossing the bed is a place, not an orientation.
//
//   mask    pow() concentrates the bend toward the tip. 1.0 hinges the whole
//           blade at the root and reads like a wiper; higher values keep the
//           lower third planted and let the top curl, which is what a stem in
//           a current actually does.
//
//   bladeY  height of THIS vertex above the seabed, which is a real length only
//           because optimize-grass.mjs reseats the clump to put the blade bases
//           at y=0.
//
//   phase   read from WORLD position, so the current crosses the field as a
//           travelling gust instead of every clump breathing together. Two
//           components at deliberately incommensurate rates: a slow body sway
//           the clump shares, plus a faster flutter weighted to the tips. One
//           sine alone reads as a metronome no matter how it is tuned.
//
//   push    scaled by bladeY, which does two things at once. It makes amplitude
//           a fraction of blade length rather than raw model units, so it means
//           the same thing at any fit value (assets.js puts fit on the node's
//           scale, not the geometry). And it scales each blade by ITS OWN
//           length rather than the clump's: this stand mixes blades from 0.3 to
//           3.4 units tall, and a shared scale gives the short ones the same
//           absolute push as the tall ones, which on a 0.3-unit blade is most
//           of its own height. They thrash while the tall ones lean.
//
//   the drop  a blade pushed sideways without it gets LONGER, and the grass
//           reads as rubber. Dropping the tip by d*d/2h holds the arc length
//           roughly constant: measured, that is +0.002% stretch against +0.66%
//           uncorrected (tools/grass-sway-test.mjs). Bounded already, since
//           push is masked by the same swayT that appears in the denominator,
//           but clamped anyway so no tuner value can invert a blade through its
//           own root.
const GLSL_SWAY_BODY = `
{
  // height within the subject; also the fallback when there are no UVs at all
  float swayH = clamp(transformed.y / max(uSwayHeight, 0.0001), 0.0, 1.0);
  float swayT = swayH;
  #ifdef USE_MAP
    swayT = mix(swayH, clamp(vMapUv.y, 0.0, 1.0), uSwayUseUv);
  #endif

  float mask = pow(swayT, uSwayStiffness);
  float bladeY = transformed.y;

  vec2 swayDir = uSwayDir;
  vec4 swayLocal = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    // world = modelMatrix * instanceMatrix * transformed, the order three uses
    // in <worldpos_vertex> and <project_vertex>.
    swayLocal = instanceMatrix * swayLocal;
    // basis columns, normalised so a per-instance scale cannot bias the turn
    vec3 axisX = instanceMatrix[0].xyz;
    vec3 axisZ = instanceMatrix[2].xyz;
    vec3 wantWorld = vec3(uSwayDir.x, 0.0, uSwayDir.y);
    vec2 dirLocal = vec2(
      dot(wantWorld, axisX / max(length(axisX), 0.0001)),
      dot(wantWorld, axisZ / max(length(axisZ), 0.0001)));
    float dirLen = length(dirLocal);
    // degenerate basis (a zeroed instance matrix) falls back rather than NaNs
    swayDir = mix(uSwayDir, dirLocal / max(dirLen, 0.0001), step(0.0001, dirLen));
  #endif

  vec3 swayWorld = (modelMatrix * swayLocal).xyz;
  // uSwayCycle and uSwayFlutterCycle arrive as POSITIONS (in cycles), not as
  // a clock and a rate, which is what lets the same shader run at 1.1 rad/s
  // or at one sway per two bars — see systems/beatSync.js. The spatial term
  // is untouched: a gust crossing the field is a distance, not a tempo.
  float phase = dot(swayWorld.xz, uSwayDir) * uSwayWavelength + uSwayCycle * 6.2831853;

  float body = sin(phase);
  float flutter = sin(phase * 2.7 + uSwayFlutterCycle * 6.2831853) * uSwayFlutter * swayT;

  vec2 push = swayDir * (body * uSwayAmplitude + flutter) * mask * bladeY;
  transformed.xz += push;

  // hold arc length: drop the tip to pay for moving it sideways
  float d = length(push);
  float h = max(bladeY, 0.0001);
  transformed.y -= min(d * d / (2.0 * h), bladeY) * uSwayBend;
}
`;

// Every material carrying the sway, so a tuner move can push new values without
// recompiling anything.
const attached = new Set();

/**
 * Inject the sway into one material. Idempotent — calling it twice on the same
 * material no-ops rather than stacking a second copy of the displacement.
 *
 * `height` is the subject's height IN THE SPACE `transformed` arrives in, which
 * is the raw model space for anything drawn as a loaded model and is NOT that
 * for the instanced bed — seabedScatter bakes fit, the orientation group and
 * the size multiplier into its geometry, so it re-measures and calls
 * setGrassSwayHeight afterwards. Passing the wrong one does not error; it
 * scales the root-to-tip mask, so the plant bends from part-way up itself.
 *
 * @param {object} [opts]
 * @param {'uv'|'height'} [opts.mask]  which root-to-tip parameter to bend on.
 *   'uv' for a model whose v really does run root-to-tip (grass.glb); 'height'
 *   for one plant per file with its base at y=0 (the SeaFlora bed). See the
 *   swayT note above — the wrong one is a silent, plausible-looking bend.
 * @param {number} [opts.scale]  per-subject multiplier on amplitude and
 *   flutter, so one current can move kelp and coral by different amounts
 *   without a second copy of CONFIG.grass.sway's nine numbers.
 */
export function attachGrassSway(material, height = 1, opts = {}) {
  if (!material || material.userData.__swayAttached) return material;
  material.userData.__swayAttached = true;
  material.userData.__swayScale = opts.scale ?? 1;

  const u = {
    uSwayCycle: { value: 0 },
    uSwayFlutterCycle: { value: 0 },
    uSwayAmplitude: { value: 0.09 },
    uSwayStiffness: { value: 1.8 },
    uSwayWavelength: { value: 0.35 },
    uSwayDir: { value: new THREE.Vector2(1, 0) },
    uSwayFlutter: { value: 0.025 },
    uSwayBend: { value: 1 },
    uSwayHeight: { value: height },
    uSwayUseUv: { value: opts.mask === 'height' ? 0 : 1 },
  };
  material.userData.__swayUniforms = u;

  // Chained, not assigned: an outline shell arrives with its own rim push on
  // onBeforeCompile and that has to keep running, or the border detaches from
  // the blade it is supposed to be tracing. Same contract as dissolve.js.
  const previous = material.onBeforeCompile;
  // three keys compiled programs partly by the SOURCE of onBeforeCompile, which
  // is identical for every material wearing this wrapper. A constant tag lets
  // the second clump reuse the first's program instead of compiling its own.
  material.customProgramCacheKey = () => 'grassSway';
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + GLSL_SWAY)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + GLSL_SWAY_BODY);
  };
  material.needsUpdate = true;
  attached.add(material);
  return material;
}

/**
 * Advance the sway clock. Wall-clock dt, like the sky and the weather in
 * main.js: the current belongs to the world, not to the run, and grass that
 * freezes behind the upgrade screen or crawls through a hit-stop reads as a
 * bug rather than as drama.
 */
export function updateGrassSway(rawDt) {
  if (CONFIG.grass?.sway?.enabled === false) return;
  const cfg = CONFIG.grass?.sway ?? {};
  // Advanced ONCE, then broadcast. Every clump answers to the same config, so
  // there is nothing per-material to track — the thing that makes a field look
  // like a field rather than like one plant repeated is the spatial term in the
  // shader (see uSwayWavelength), not a per-clump clock.
  //
  // Both rates are authored in radians/sec, so they divide by 2π to become the
  // cycles/sec the free path wants. Wrap 1: each cycle is read by a single
  // sin(), so a full turn is the whole period.
  swayCycle = advanceCycles(swayCycle, cfg.speedSync, (cfg.speed ?? 1.1) / TWO_PI, rawDt, 1);
  flutterCycle = advanceCycles(
    flutterCycle, cfg.flutterSync, (cfg.flutterSpeed ?? 3.7) / TWO_PI, rawDt, 1);
  for (const m of attached) {
    const u = m.userData.__swayUniforms;
    if (!u) continue;
    u.uSwayCycle.value = swayCycle;
    u.uSwayFlutterCycle.value = flutterCycle;
  }
}

const TWO_PI = Math.PI * 2;
let swayCycle = 0;
let flutterCycle = 0;

/**
 * Push CONFIG.grass.sway onto every attached material. Pure uniform writes, no
 * recompile, so this is safe to call from a slider's input event.
 */
export function applyGrassSettings() {
  const cfg = CONFIG.grass?.sway ?? {};
  const dir = cfg.direction ?? 0;
  for (const m of attached) {
    const u = m.userData.__swayUniforms;
    if (!u) continue;
    // Per-subject softening. Applied here rather than in the shader so it stays
    // a property of the PLANT — a coral head and a kelp frond in the same
    // current move by different amounts — while everything about the current
    // itself is still one config block that a slider moves for the whole bed.
    const scale = m.userData.__swayScale ?? 1;
    // `enabled` folds into amplitude rather than branching in the shader — one
    // less thing for the vertex to test, and the toggle settles the grass
    // instead of snapping it straight.
    u.uSwayAmplitude.value = cfg.enabled === false ? 0 : (cfg.amplitude ?? 0.09) * scale;
    u.uSwayStiffness.value = cfg.stiffness ?? 1.8;
    u.uSwayWavelength.value = cfg.wavelength ?? 0.35;
    u.uSwayDir.value.set(Math.cos(dir), Math.sin(dir));
    u.uSwayFlutter.value = cfg.enabled === false ? 0 : (cfg.flutter ?? 0.025) * scale;
    u.uSwayBend.value = cfg.bend ?? 1;
    // `speed` and `flutterSpeed` are NOT written here any more: they are rates,
    // and the shader is handed positions. updateGrassSway owns both.
  }
}

/**
 * Correct the height the root-to-tip mask normalises against, once the caller
 * knows the space its geometry actually ended up in.
 *
 * systems/seabedScatter.js is the reason this exists: it collapses
 * createVisual's whole assembly into one geometry and reseats the base at y=0,
 * so the height assets.js measured off the raw model is in the wrong units by
 * whatever fit and the size multiplier came to. Wrong here is not an error and
 * not invisible either — the mask saturates part-way up the plant and the top
 * third bends as one rigid piece.
 */
export function setGrassSwayHeight(material, height) {
  const u = material?.userData?.__swayUniforms;
  if (!u || !(height > 0)) return;
  u.uSwayHeight.value = height;
}

export function grassSwayMaterialCount() {
  return attached.size;
}
