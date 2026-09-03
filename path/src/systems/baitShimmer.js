import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { NOISE_FIELD_GLSL } from './noiseGlsl.js';

// ---------------------------------------------------------------------------
// THE SHIMMER — the bait ball's noise field, sampled in the fragment shader
// ---------------------------------------------------------------------------
// The flock is pushed around by a slow Perlin field (see baitNoise in
// systems/baitBall.js). This lights the fish with THE SAME FIELD, at the same
// scale and the same phase, so the shimmer running through a bait ball is not
// decoration beside the motion — it is the motion, made visible. A fish
// brightens because of the water it is actually in, and the bright patch drifts
// across the mass at exactly the speed the drift does.
//
// WHY IT IS A WORLD-SPACE FIELD AND NOT A PER-FISH UNIFORM. Every instance of a
// species shares ONE material — measured: two `fish` spawned separately come
// back with the same MeshBasicMaterial object — so there is no per-fish uniform
// to write. Anything stamped on that material repaints every fish of that
// species in the arena, which is the bubble problem in the memory notes.
//
// Sampling world position solves it outright: one material, one time uniform,
// and every fragment gets a different answer because it is somewhere else. It
// is also the more honest model — the shimmer is a property of the WATER, not
// of any animal.
//
// ...WHICH LEAVES THE OTHER HALF OF THE PROBLEM: the same material is worn by
// loose fish of that species swimming about outside any ball, and they must not
// shimmer. So the effect is gated on distance to the nearest live ball centre,
// passed in as an array. Outside every ball it is exactly zero and the fragment
// is the one that shipped before this existed.
//
// UNLIT MATERIALS. These fish are MeshBasicMaterial, so there is no lighting to
// hook — the shimmer modulates `diffuseColor` directly, after the map fetch and
// before anything else reads it.
// ---------------------------------------------------------------------------

// How many balls the shader can be told about. A compile-time array size — it
// cannot be a uniform, so this is a hard ceiling and CONFIG.baitBall.maxBalls
// has to stay under it. Deliberately generous against a cap of 3.
export const MAX_SHIMMER_BALLS = 8;

// Materials this module has injected. Membership, not a userData flag:
// Material.clone() JSON round-trips userData, so a clone carries a flag that
// LOOKS right over a shader that was never copied — see the same note in
// systems/noiseShader.js.
const attached = new Set();

// Every attached material's uniform block, so the per-frame write is a walk
// over what exists rather than a scene traverse.
const blocks = [];

/**
 * Inject the shimmer into one material. Idempotent, and a no-op on anything
 * with no `color` to modulate.
 */
export function attachBaitShimmer(material) {
  if (!material || attached.has(material) || !('color' in material)) return false;
  // A COPY THAT ALREADY CARRIES THE CLOSURE. systems/damageGlow.js and
  // systems/emissivePulse.js hand a hit creature a per-instance material by
  // cloning it and copying `onBeforeCompile` across by reference — so a fish
  // that has been hit wears a new material object whose shader is already
  // this injection, bound to the ORIGINAL's uniform block (which is in
  // `blocks` and fed every frame, so the copy shimmers correctly as it is).
  // Not in the set, so without this it would be injected a second time,
  // chained onto the first: every varying and uniform declared twice, three
  // functions given two bodies, and the material failing to compile — every
  // fish of that species drawn as nothing. The closure is marked so a copy of
  // it can be recognised however it travelled.
  if (material.onBeforeCompile?.__baitShimmer) { attached.add(material); return false; }
  attached.add(material);

  const u = {
    // Strength 0 until a ball is actually in the water, so a material that has
    // been injected and never used renders exactly as it did before.
    uBaitStrength: { value: 0 },
    uBaitTime: { value: 0 },
    uBaitScale: { value: 3.2 },
    uBaitContrast: { value: 1 },
    uBaitTint: { value: new THREE.Color(0x9fe8ff) },
    uBaitCount: { value: 0 },
    // xyz = centre, w = the radius the effect fades out over.
    uBaitBalls: { value: Array.from({ length: MAX_SHIMMER_BALLS }, () => new THREE.Vector4()) },
  };
  material.userData.__baitShimmer = u;
  blocks.push(u);

  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    // CHAINED, never assigned over. These fish may already carry the toon
    // shader or a biolum skin, and an assignment here silently deletes
    // whichever ran first — see the note in systems/toonShade.js about exactly
    // that bug.
    if (typeof prev === 'function') prev(shader, renderer);
    Object.assign(shader.uniforms, u);
    // ONCE PER PROGRAM, whatever chain led here. The marker above catches the
    // copies this project makes; this catches any it does not — a chain built
    // from a closure that was already this one is a chain that has already
    // injected, and injecting again is the compile failure described there.
    if (shader.vertexShader.includes('vBaitWorld')) return;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBaitWorld;')
      // AFTER the skinning chunk, so `transformed` is the posed vertex. Before
      // it, every fish in a school would sample the field at its bind pose and
      // the shimmer would be painted ON the animal rather than lying in the
      // water it swims through — which is the same distinction noiseShader.js
      // makes in the other direction, on purpose, for its mottle.
      .replace('#include <skinning_vertex>',
        '#include <skinning_vertex>\n  vBaitWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vBaitWorld;
uniform float uBaitStrength;
uniform float uBaitTime;
uniform float uBaitScale;
uniform float uBaitContrast;
uniform vec3 uBaitTint;
uniform int uBaitCount;
uniform vec4 uBaitBalls[${MAX_SHIMMER_BALLS}];
${NOISE_FIELD_GLSL}`)
      // After the map fetch, so the field modulates the texture rather than
      // being modulated by it.
      .replace('#include <map_fragment>', `#include <map_fragment>
  if (uBaitStrength > 0.0 && uBaitCount > 0) {
    // HOW MUCH OF A BALL THIS FRAGMENT IS IN. Nearest of up to
    // MAX_SHIMMER_BALLS, smoothstepped to zero at the ball's own reach, so a
    // fish of the same species swimming loose elsewhere in the arena is
    // untouched — which it must be, because it shares this material.
    float baitIn = 0.0;
    for (int i = 0; i < ${MAX_SHIMMER_BALLS}; i++) {
      if (i >= uBaitCount) break;
      vec4 b = uBaitBalls[i];
      float d = distance(vBaitWorld, b.xyz);
      baitIn = max(baitIn, 1.0 - smoothstep(b.w * 0.55, b.w, d));
    }
    if (baitIn > 0.0) {
      // THE SAME FIELD THE FLOCK SWIMS IN. Same divisor, same drift along z —
      // see baitNoise in systems/baitBall.js, which is a hand port of noiseFbm
      // and is checked against it in tools/bait-ball-test.mjs.
      vec3 np = vec3(vBaitWorld.x, vBaitWorld.y, vBaitWorld.z) / max(0.0001, uBaitScale);
      np.z += uBaitTime;
      float n = clamp(noiseFbm(np) * uBaitContrast * 0.5 + 0.5, 0.0, 1.0);
      // Signed about the middle, so the field DARKENS as much as it brightens
      // and the mass keeps its average. A one-sided lift just makes the whole
      // ball paler and reads as fog.
      float lift = (n - 0.5) * 2.0 * uBaitStrength * baitIn;
      diffuseColor.rgb = mix(diffuseColor.rgb, uBaitTint, max(0.0, lift));
      diffuseColor.rgb *= 1.0 + lift * 0.6;
    }
  }`);
  };

  // Its own program, pinned to a constant so every material wearing this
  // shimmer shares ONE compile rather than one per species. Without it three
  // would also happily hand this material a cached program built WITHOUT the
  // injection, and the shimmer would be missing on some draws and not others.
  const prevKey = material.customProgramCacheKey;
  material.customProgramCacheKey = () => `baitShimmer|${typeof prevKey === 'function' ? prevKey.call(material) : ''}`;
  material.onBeforeCompile.__baitShimmer = true;
  material.needsUpdate = true;
  return true;
}

/**
 * One frame. `balls` is anything with { x, y, z, shell } — the live anchors.
 *
 * Writes uniforms only; it never touches a material's flags, so this costs a
 * handful of number assignments per attached material per frame however many
 * fish are drawn.
 */
export function updateBaitShimmer(balls, dt) {
  const c = CONFIG.baitBall ?? {};
  const s = c.shimmer ?? {};
  if (!blocks.length) return;

  const on = s.enabled !== false && (s.strength ?? 0) > 0;
  const n = on ? Math.min(balls.length, MAX_SHIMMER_BALLS) : 0;
  // The field's own clock, advanced on the same rate the flock's drift uses so
  // the two stay in phase. Accumulated rather than read off a global time, for
  // the same reason every other clock in this feature is: anything that stops
  // the game has to stop this, or the shimmer runs on behind a level-up card.
  shimmerTime += dt * (c.noiseRate ?? 0.25);

  for (const u of blocks) {
    u.uBaitCount.value = n;
    if (n === 0) { u.uBaitStrength.value = 0; continue; }
    u.uBaitStrength.value = s.strength ?? 0;
    u.uBaitTime.value = shimmerTime;
    u.uBaitScale.value = Math.max(0.05, c.noiseScale ?? 3.2);
    u.uBaitContrast.value = s.contrast ?? 1.6;
    u.uBaitTint.value.set(s.color ?? 0x9fe8ff);
    for (let i = 0; i < n; i++) {
      const b = balls[i];
      // THE REACH IS THE BALL PLUS A MARGIN, not the shell. A fish out on the
      // far side of a ball sits a little past the shell (the flock's
      // equilibrium is outside it — see wallWeight), and a gate cut exactly at
      // the shell would leave the outermost fish — the ones most on show —
      // as the only ones not shimmering.
      // THE COLUMN IS TALLER THAN IT IS WIDE, so the gate has to be sized off
      // both. This is a SPHERE around the anchor, and a radius taken from the
      // shell alone would cut a 7-unit column off at 2.6 — the top and bottom
      // of every ball, which is most of it, simply would not shimmer, and the
      // effect would look like it was failing on the fish furthest from the
      // middle for no reason anybody could name.
      const shell = b.shell ?? 1.2;
      const tall = (c.height ?? 7) * 0.5 * (shell / Math.max(0.01, c.radius ?? 1.2));
      u.uBaitBalls.value[i].set(b.x, b.y, b.z ?? 0,
        Math.max(shell * (s.reach ?? 2.2), tall * (s.reach ?? 2.2) * 0.7));
    }
  }
}

let shimmerTime = 0;

/** Start of a run. */
export function resetBaitShimmer() {
  shimmerTime = 0;
  for (const u of blocks) { u.uBaitCount.value = 0; u.uBaitStrength.value = 0; }
}

/** For the harness and the debug readout. */
export function baitShimmerMaterialCount() {
  return blocks.length;
}

/** The injected GLSL, so tools/bait-shader-check.mjs can compile it for real. */
export function shimmerFragmentSource() {
  return NOISE_FIELD_GLSL;
}
