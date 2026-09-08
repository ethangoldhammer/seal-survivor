import * as THREE from 'three';
import { CONFIG } from '../config.js';

// Filaments hanging off a float, flowing in the current — done entirely in the
// vertex shader. Nothing here touches the CPU per frame except one uniform
// write for the clock, so eighteen tentacles cost the same as one.
//
// WHY THIS IS NOT A BONE RIG, which it was until now. tools/rig-manowar.mjs
// gave the model a 93-bone skeleton and tools/manowar-rig-test.mjs proves the
// skin deforms correctly — but the .glb ships ZERO animation clips, so nothing
// in the game ever moved those bones and the tentacles hung stiff. Wiring a
// driver to them would mean 93 bones of skinning per man o' war, and a bone
// texture allocated per spawn is the thing that was already caught hitching
// this game once. For motion that is decorative — the sting is a circle in
// combat.js and does not read the mesh — a vertex shader is the whole feature
// for none of the cost.
//
// WHY IT IS NOT systems/grassSway.js, which is the same idea and very nearly
// fits. Two reasons, and the second is the load-bearing one:
//
//   IT HANGS. Grass masks on `transformed.y / height` clamped to 0..1 and
//        scales the push by `bladeY = transformed.y`. Every filament here is
//        at NEGATIVE y — below the origin, under the float — so both terms
//        clamp to zero and the sign of the second is inverted. The parameter
//        this needs is distance BELOW the crown, not height above the floor.
//   ITS PROGRAM IS SHARED. attachGrassSway pins every material it touches to
//        one cached program (`customProgramCacheKey = 'grassSway'`), which is
//        only sound while the injected source is byte-identical for all of
//        them. That is a deliberate optimisation for a seabed of two hundred
//        clumps, and it means a branch added there for this animal is a branch
//        compiled into every blade of grass in the game.
//
// So this is a sibling, built the same way and stating its own reasons. The
// arithmetic is grass's with the axis turned over.
//
// WHERE THE CROWN COMES FROM. `uTentCrown` is an object-space y: everything
// above it is the float and does not move, everything below is filament. It is
// passed in rather than guessed, because "where do the tentacles start" is a
// fact about the model (tools/rig-manowar.mjs measures it — 0.512 in model
// units on manowar.glb) and a fraction-of-height default would put it in a
// different place on any other body that ever wants this.

const GLSL_TENTACLE = `
uniform float uTentCycle;
uniform float uTentFlutterCycle;
uniform float uTentAmplitude;
uniform float uTentStiffness;
uniform float uTentWavelength;
uniform float uTentFlutter;
uniform float uTentCrown;
uniform float uTentSpan;
uniform vec2  uTentDir;
`;

// Injected after <begin_vertex>, where `transformed` is still the modeller's
// object-space position — the same insertion point grass, the noise shader and
// the outline shells all use, and the last moment the vertex is untouched.
//
// The prose stays out here. That string is shipped verbatim to every driver's
// GLSL compiler, so comments in it are bytes on the wire, and the GLSL ES
// source character set does not promise to accept the punctuation this file is
// otherwise written with.
//
//   hang    0 at the crown, 1 at the tips. Distance BELOW uTentCrown over the
//           span, which is the hanging mirror of grass's root-to-tip mask. It
//           is clamped at 0, so every vertex of the float returns exactly zero
//           and the sail is rigid without needing a branch.
//
//   mask    pow() concentrates the motion toward the tips. 1.0 swings the whole
//           filament from the crown like a pendulum; higher values hold the top
//           still and let the ends trail, which is what a line in water does.
//
//   drop    length of THIS vertex below the crown, a real length in object
//           units. The push scales by it for grass's reason: amplitude then
//           means a fraction of each strand's own length rather than a count of
//           model units, so it reads the same at any `fit`, and the short stubs
//           in this model's eighteen do not thrash while the long ones lean.
//
//   phase   read from WORLD position, so two man o' wars in the same water are
//           never in step. Two incommensurate rates — a slow body sway the
//           whole animal shares plus a faster flutter weighted to the tips —
//           because one sine alone reads as a metronome however it is tuned.
//
//   the lift  a strand pushed sideways without it gets LONGER, and the tentacle
//           reads as rubber. Raising the tip by d*d/2L holds the arc length
//           roughly constant. It is + here and - in grass for the one reason
//           this whole file exists: these hang.
const GLSL_TENTACLE_BODY = `
{
  float drop = max(uTentCrown - transformed.y, 0.0);
  float hang = clamp(drop / max(uTentSpan, 0.0001), 0.0, 1.0);
  float mask = pow(hang, uTentStiffness);

  vec3 tentWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
  float phase = tentWorld.x * uTentWavelength + uTentCycle * 6.2831853;

  float body = sin(phase);
  float flutter = sin(phase * 2.7 + uTentFlutterCycle * 6.2831853) * uTentFlutter * hang;

  vec2 push = uTentDir * (body * uTentAmplitude + flutter) * mask * drop;

  transformed.x += push.x;
  transformed.z += push.y;
  transformed.y += dot(push, push) / (2.0 * max(drop, 0.0001));
}
`;

const attached = new Set();

/**
 * Make `material` flow below `crown`.
 *
 * @param material  the creature's own material. Cloned per template by
 *   assets.js, so this never reaches another asset — but see the guard below:
 *   a GLB's clones SHARE their template's material, which is the trap
 *   damageGlow already documents.
 * @param crown  object-space y where the float ends and the filaments begin.
 * @param span   object-space length of the longest filament below that.
 * @param opts   { scale } per-subject multiplier on amplitude and flutter.
 */
export function attachTentacleSway(material, crown = 0, span = 1, opts = {}) {
  if (!material || material.userData.__tentacleAttached) return material;
  material.userData.__tentacleAttached = true;
  material.userData.__tentacleScale = opts.scale ?? 1;

  const u = {
    uTentCycle: { value: 0 },
    uTentFlutterCycle: { value: 0 },
    uTentAmplitude: { value: 0.18 },
    uTentStiffness: { value: 1.5 },
    uTentWavelength: { value: 0.3 },
    uTentFlutter: { value: 0.05 },
    uTentCrown: { value: crown },
    uTentSpan: { value: span },
    uTentDir: { value: new THREE.Vector2(1, 0) },
  };
  material.userData.__tentacleUniforms = u;

  // CHAINED, not assigned. An outline shell arrives with its own rim push on
  // onBeforeCompile and that has to keep running, or the border detaches from
  // the body it is tracing. Same contract as dissolve.js and grassSway.
  const previous = material.onBeforeCompile;
  // three keys compiled programs partly by the SOURCE of onBeforeCompile, which
  // is identical for every material wearing this wrapper — a constant tag lets
  // the second animal reuse the first's program instead of compiling its own.
  // Sound only because nothing above is selected by #define: every uniform here
  // varies at runtime, so the injected source really is byte-identical.
  material.customProgramCacheKey = () => 'tentacleSway';
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + GLSL_TENTACLE)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + GLSL_TENTACLE_BODY);
  };
  material.needsUpdate = true;
  attached.add(material);
  return material;
}

let cycle = 0;
let flutterCycle = 0;

/**
 * Advance the flow. WALL-CLOCK dt, like the sky and the grass: the current
 * belongs to the world rather than to the run, and tentacles that freeze behind
 * the upgrade screen or crawl through a hit-stop read as a bug rather than as
 * drama.
 */
export function updateTentacleSway(rawDt) {
  const cfg = CONFIG.tentacleSway ?? {};
  if (cfg.enabled === false) return;
  const dt = Math.min(rawDt ?? 0, 0.1);
  cycle += dt * (cfg.rate ?? 0.22);
  flutterCycle += dt * (cfg.flutterRate ?? 0.6);
  // Kept small rather than allowed to grow all session: a float carrying a
  // 90-minute run's worth of cycles has lost the precision the sine needs, and
  // the tentacles visibly step. Wrapping on a whole cycle is invisible.
  if (cycle > 1) cycle -= Math.floor(cycle);
  if (flutterCycle > 1) flutterCycle -= Math.floor(flutterCycle);

  for (const m of attached) {
    const u = m.userData.__tentacleUniforms;
    if (!u) continue;
    const scale = m.userData.__tentacleScale ?? 1;
    u.uTentCycle.value = cycle;
    u.uTentFlutterCycle.value = flutterCycle;
    u.uTentAmplitude.value = (cfg.amplitude ?? 0.18) * scale;
    u.uTentFlutter.value = (cfg.flutter ?? 0.05) * scale;
    u.uTentStiffness.value = cfg.stiffness ?? 1.5;
    u.uTentWavelength.value = cfg.wavelength ?? 0.3;
    const dir = cfg.direction ?? 0;
    u.uTentDir.value.set(Math.cos(dir), Math.sin(dir));
  }
}

/** Every attached material, for the look page and the shader audit. */
export function tentacleSwayMaterials() { return [...attached]; }
export function tentacleSwayMaterialCount() { return attached.size; }
