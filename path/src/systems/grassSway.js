import * as THREE from 'three';
import { CONFIG } from '../config.js';

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
uniform float uSwayTime;
uniform float uSwayAmplitude;
uniform float uSwayStiffness;
uniform float uSwaySpeed;
uniform float uSwayWavelength;
uniform vec2  uSwayDir;
uniform float uSwayFlutter;
uniform float uSwayFlutterSpeed;
uniform float uSwayBend;
uniform float uSwayHeight; // clump height, model units; only the UV fallback
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
//   swayT   root-to-tip parameter, 0 at the base and 1 at the tip. The guard is
//           USE_MAP, not USE_UV: since r152 three gives each map its own
//           varying, and vMapUv is declared under USE_MAP while USE_UV governs
//           the unrelated vUv. Guarding on the wrong one still compiles and
//           quietly takes the fallback, which is the worst of both outcomes.
//           <uv_vertex> assigns it well before <begin_vertex>, so it is live
//           here, and mapTransform is identity absent KHR_texture_transform —
//           so this is the raw v, and the atlas only ever remaps u.
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
  #ifdef USE_MAP
    float swayT = clamp(vMapUv.y, 0.0, 1.0);
  #else
    // no UVs: fall back to height within the clump
    float swayT = clamp(transformed.y / max(uSwayHeight, 0.0001), 0.0, 1.0);
  #endif

  float mask = pow(swayT, uSwayStiffness);
  float bladeY = transformed.y;

  vec3 swayWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
  float phase = dot(swayWorld.xz, uSwayDir) * uSwayWavelength + uSwayTime * uSwaySpeed;

  float body = sin(phase);
  float flutter = sin(phase * 2.7 + uSwayTime * uSwayFlutterSpeed) * uSwayFlutter * swayT;

  vec2 push = uSwayDir * (body * uSwayAmplitude + flutter) * mask * bladeY;
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
 * `heightFallback` is the model's object-space height, used only when the
 * material has no UVs (see the #else branch above).
 */
export function attachGrassSway(material, heightFallback = 1) {
  if (!material || material.userData.__swayAttached) return material;
  material.userData.__swayAttached = true;

  const u = {
    uSwayTime: { value: 0 },
    uSwayAmplitude: { value: 0.09 },
    uSwayStiffness: { value: 1.8 },
    uSwaySpeed: { value: 1.1 },
    uSwayWavelength: { value: 0.35 },
    uSwayDir: { value: new THREE.Vector2(1, 0) },
    uSwayFlutter: { value: 0.025 },
    uSwayFlutterSpeed: { value: 3.7 },
    uSwayBend: { value: 1 },
    uSwayHeight: { value: heightFallback },
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
  for (const m of attached) {
    const u = m.userData.__swayUniforms;
    if (u) u.uSwayTime.value += rawDt;
  }
}

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
    // `enabled` folds into amplitude rather than branching in the shader — one
    // less thing for the vertex to test, and the toggle settles the grass
    // instead of snapping it straight.
    u.uSwayAmplitude.value = cfg.enabled === false ? 0 : (cfg.amplitude ?? 0.09);
    u.uSwayStiffness.value = cfg.stiffness ?? 1.8;
    u.uSwaySpeed.value = cfg.speed ?? 1.1;
    u.uSwayWavelength.value = cfg.wavelength ?? 0.35;
    u.uSwayDir.value.set(Math.cos(dir), Math.sin(dir));
    u.uSwayFlutter.value = cfg.enabled === false ? 0 : (cfg.flutter ?? 0.025);
    u.uSwayFlutterSpeed.value = cfg.flutterSpeed ?? 3.7;
    u.uSwayBend.value = cfg.bend ?? 1;
  }
}

export function grassSwayMaterialCount() {
  return attached.size;
}
