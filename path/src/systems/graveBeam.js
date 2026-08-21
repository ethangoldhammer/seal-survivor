import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { getAssetMaterials } from '../assets.js';
import { CAUSTICS_GLSL } from './causticsGlsl.js';
import { WISP_GLSL } from './wispGlsl.js';
import { setGraveRay, clearGraveRay } from './graveRay.js';

// ============================================================================
// THE BEAM ACROSS A GRAVE — a shaft of caustic light that finds a stone as you
// swim over it, and is gone again.
//
// The graveyard sits on the floor a couple of units behind the play plane,
// which is where it belongs and is also the worst place in the frame to notice
// anything. The label (ui/graveLabel.js) answers WHO is buried there; this
// answers where to look. It fires on the same event, sweeps once, and stops.
//
// A WORLD-SPACE BAND, and that single decision is what makes the whole thing
// affordable. The obvious build is a light or a shader per stone, and it cannot
// work: createVisual clones the model but the clone SHARES the template's
// material, so every headstone in the yard is one material object. A per-stone
// uniform would light all of them at once, and giving each its own material
// means Material.clone(), which silently drops every onBeforeCompile the look
// pipeline already injected (see the note in assets.js).
//
// So the band is defined in the WORLD instead of on an object: one uniform
// bag, shared by all three stone materials, carrying a world x for the beam's
// centre. A stone lights up because the band is passing over where it stands.
// Nothing is per-instance, nothing is cloned, and the effect is correct for one
// stone or six — including the case the label already restricts itself to,
// which is one at a time.
//
// IT IS ADDED, NOT LIT. Injected as an addition to gl_FragColor just before
// <dithering_fragment>, exactly where systems/noiseShader.js puts the seal's
// wet sheen and for the same reason: by that point the fragment carries the lit
// body, the fog and the tone map, and a beam that went through the light path
// would be knocked down to nothing at night — which is precisely when a
// graveyard most needs help being seen.
//
// THE CAUSTIC FUNCTION IS THE WATER'S OWN — CAUSTICS_GLSL, the same three
// interfering sines the ocean and the seal's wet film sample. THE NUMBERS ARE
// NOT. Caustic scale and intensity in this game are authored against the fill,
// which is tens of units across; a stone is five. At the water's scale a single
// vein is wider than the whole headstone, so the stone comes up evenly brighter
// and reads as a flat wash rather than as light through water. The scale below
// is several times the ocean's for that reason, and it is the one number here
// most worth distrusting when this looks wrong.
// ============================================================================

// One bag, shared by every stone material — see the header. Assigned into each
// shader's `uniforms` rather than merged, so all three keep pointing at THESE
// objects and one write reaches all of them.
const uniforms = {
  uGraveBeamX: { value: 0 },
  // The height the rake is measured FROM. Not a style knob — see the note on
  // the rake in BEAM_GLSL. Written per sweep, from the base of the stone being
  // lit.
  uGraveBeamY: { value: 0 },
  uGraveBeamHalf: { value: 2 },
  uGraveBeamStrength: { value: 0 },
  uGraveBeamTime: { value: 0 },
  uGraveBeamScale: { value: 2.2 },
  uGraveBeamTilt: { value: 0.35 },
  uGraveBeamFloor: { value: 0.25 },
  uGraveBeamWisp: { value: 0.75 },
  uGraveBeamWispScale: { value: 0.55 },
  uGraveBeamWispSpeed: { value: 0.35 },
  uGraveBeamColor: { value: new THREE.Color(0xbfe9ff) },
};

const attached = new WeakSet();
let installed = false;

// The live sweep. `span` is how far either side of the stone it travels, so the
// band starts and finishes clear of it rather than appearing on top of it.
const sweep = { active: false, t: 0, from: 0, to: 0, span: 0 };

function cfg() {
  return CONFIG.gravesite?.beam ?? {};
}

// The shader. Kept as one string because a compile error in an injected chunk
// renders NOTHING — no exception, no warning three surfaces, just a black
// object — so the only way to find one is to compile it in a real GL context.
// tools/looks/graves.html is that context; npm run looks:graves is the check.
//
// NO DERIVATIVES ANYWHERE IN HERE. fwidth is unreachable from an injected
// shader on GLSL ES 1.00, and reaching for one is the usual way a band like
// this gets a soft edge. smoothstep over a distance the caller already knows
// in world units does the same job and compiles on both.
const BEAM_GLSL = /* glsl */ `
  // Distance from the band's centre line, slanted by uGraveBeamTilt so the
  // shaft comes DOWN through the water rather than standing upright. A vertical
  // band on a vertical stone reads as the stone changing colour; a raked one
  // reads as light arriving from somewhere.
  //
  // THE RAKE IS MEASURED FROM THE STONE'S OWN BASE, and that is not tidiness.
  // Raking off world y instead — which is what this shipped as — multiplies the
  // tilt by the ABSOLUTE height of the fragment, and the graveyard lives on the
  // seabed at y = -38.8. At a tilt of 0.35 that is thirteen and a half world
  // units of sideways shift on a band 1.7 units wide: the beam fired, swept,
  // measured brighter in a harness, and passed over empty water a dozen units
  // from any stone every single time.
  //
  // It was invisible to the look page too, because a look page stands its
  // subject at the origin — which is exactly the height at which this bug does
  // not exist. tools/looks/graves.js seats its stones at the real seabed depth
  // now, and asserts the beam lands, for this reason.
  float gbDist = abs(vGraveWorld.x - uGraveBeamX + (vGraveWorld.y - uGraveBeamY) * uGraveBeamTilt);
  // smoothstep with its edges REVERSED — 1 at the centre, 0 at the edge. The
  // right way round would need a 1.0 - and one more chance to get it backwards.
  float gbBand = smoothstep(uGraveBeamHalf, 0.0, gbDist);

  // ORGANIC, NOT A GRADIENT. A clean smoothstep band is a soft-edged stripe and
  // reads as one — the give-away is that its edges are the same everywhere down
  // its length, which no light through water has ever been. The wisp eats into
  // it: thinning it in places, tearing it open in others, drifting as it goes.
  //
  // The SAME field the shaft in the water is torn by, at the same coordinates
  // and the same time (systems/wispGlsl.js, and see systems/graveRay.js for why
  // the two share their numbers). They are one beam seen twice, so a hole in
  // the shaft has to be a hole in what lands under it — two independent noises
  // would give a stone lit by a beam that is visibly somewhere else.
  //
  // Mixed toward 1 rather than multiplied outright. At full strength the band
  // is torn to pieces and stops reading as a beam at all; uGraveBeamWisp is how
  // much of it the water is allowed to eat, and 0 leaves the plain band this
  // shipped as.
  float gbW = wisp(vGraveWorld.xy * uGraveBeamWispScale, uGraveBeamTime * uGraveBeamWispSpeed);
  gbBand *= mix(1.0, gbW, uGraveBeamWisp);

  float gbC = caustics(vGraveWorld.xy * uGraveBeamScale, uGraveBeamTime);
  // The floor is what keeps the beam a BEAM. Caustics are mostly dark with
  // bright veins through them (the cube in caustics() sharpens exactly that),
  // so multiplying the band by the pattern alone gives scattered bright dashes
  // with nothing joining them up. A base term under the veins is the shaft they
  // are travelling in.
  gl_FragColor.rgb += uGraveBeamColor * (gbBand * uGraveBeamStrength * (uGraveBeamFloor + gbC));
`;

function attach(material) {
  if (!material || attached.has(material)) return;
  attached.add(material);

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGraveWorld;')
      // Immediately BEFORE <project_vertex> — the last moment `transformed` is
      // still a position rather than a clip-space vertex. Same insertion point
      // systems/noiseShader.js uses, and for the same reason: modelMatrix takes
      // it out to the world the caustics are defined in.
      .replace('#include <project_vertex>', '\tvGraveWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#include <project_vertex>');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vGraveWorld;
uniform float uGraveBeamX;
uniform float uGraveBeamY;
uniform float uGraveBeamHalf;
uniform float uGraveBeamStrength;
uniform float uGraveBeamTime;
uniform float uGraveBeamScale;
uniform float uGraveBeamTilt;
uniform float uGraveBeamFloor;
uniform float uGraveBeamWisp;
uniform float uGraveBeamWispScale;
uniform float uGraveBeamWispSpeed;
uniform vec3 uGraveBeamColor;
${CAUSTICS_GLSL}
${WISP_GLSL}`)
      .replace('#include <dithering_fragment>', `${BEAM_GLSL}
#include <dithering_fragment>`);
  };

  // Three caches compiled programs across materials, and two stones that differ
  // only in their map would otherwise be handed one program — which would be
  // the RIGHT one here, since all three get the same injection, but only by
  // luck. Naming the key makes that explicit rather than incidental.
  material.customProgramCacheKey = () => 'graveBeam';
  material.needsUpdate = true;
}

/**
 * Put the beam into the grave stones' materials. Call once, after
 * preloadAssets resolves — before the models are in there are no materials to
 * reach and this quietly does nothing, which would leave a beam that never
 * appears and never says why.
 *
 * Safe to call again: a material is injected once and remembered.
 */
export function initGraveBeam() {
  const stones = CONFIG.gravesite?.stones ?? [];
  let found = 0;
  for (const key of stones) {
    for (const m of getAssetMaterials(key) ?? []) { attach(m); found += 1; }
  }
  installed = found > 0;
  return found;
}

/**
 * Sweep the beam across a grave. Fired by ui/graveLabel.js at the moment it
 * adopts a stone — the two are one event to the player, and splitting the
 * trigger would let a caption arrive with no light or a light with no caption.
 *
 * ONE AT A TIME, like the label. A second call re-aims the sweep and restarts
 * it rather than queueing: the player has moved to another stone, and finishing
 * the old sweep would be lighting a grave they have already left.
 *
 * @param {number} x     world x of the stone
 * @param {number} baseY world y the stone STANDS ON. Required in practice: the
 *   rake is measured from it, and defaulting it to zero puts the band thirteen
 *   units away from a graveyard that lives at y = -38.8. See BEAM_GLSL.
 */
export function sweepGrave(x, baseY = 0) {
  const c = cfg();
  if (c.enabled === false || !installed) return;
  const span = c.span ?? 9;
  uniforms.uGraveBeamY.value = baseY;
  sweep.active = true;
  sweep.t = 0;
  sweep.span = span;
  // Right to left by default, against the reading direction, so it does not
  // race the eye to the caption that is arriving at the same moment.
  sweep.from = x + span * (c.reversed === false ? -1 : 1);
  sweep.to = x - span * (c.reversed === false ? -1 : 1);
}

/**
 * @param {number} rawDt WALL-CLOCK seconds. The beam is a piece of scenery
 *   reacting to a swimming seal, but it also has to survive a level-up card
 *   opening on top of it — and a sweep frozen at half brightness for as long as
 *   somebody takes to pick an upgrade is a stone with a stripe painted on it.
 */
export function updateGraveBeam(rawDt) {
  if (!installed) return;
  const c = cfg();
  const step = Math.min(Math.max(rawDt ?? 0, 0), 0.1);

  uniforms.uGraveBeamHalf.value = c.width ?? 2;
  uniforms.uGraveBeamScale.value = c.scale ?? 2.2;
  uniforms.uGraveBeamTilt.value = c.tilt ?? 0.35;
  uniforms.uGraveBeamFloor.value = c.floor ?? 0.25;
  uniforms.uGraveBeamWisp.value = c.wisp ?? 0.75;
  uniforms.uGraveBeamWispScale.value = c.wispScale ?? 0.55;
  uniforms.uGraveBeamWispSpeed.value = c.wispSpeed ?? 0.35;
  uniforms.uGraveBeamColor.value.set(c.color ?? 0xbfe9ff);
  // The pattern crawls whether or not a sweep is running, so a beam fired twice
  // in the same spot is not the same picture twice.
  uniforms.uGraveBeamTime.value += step * (c.crawl ?? 0.7);

  // THE SHAFT IN THE WATER READS THIS. Published every frame, including the
  // frames with no sweep running — the wisp and the caustics have to keep
  // crawling or a beam fired twice over one stone is the same picture twice,
  // and `strength: 0` is what tells water.js there is nothing to draw. See
  // systems/graveRay.js.
  const publish = () => setGraveRay({
    x: uniforms.uGraveBeamX.value,
    baseY: uniforms.uGraveBeamY.value,
    strength: uniforms.uGraveBeamStrength.value,
    halfWidth: uniforms.uGraveBeamHalf.value,
    tilt: uniforms.uGraveBeamTilt.value,
    time: uniforms.uGraveBeamTime.value,
  });

  if (!sweep.active) {
    uniforms.uGraveBeamStrength.value = 0;
    publish();
    return;
  }

  const time = Math.max(0.05, c.time ?? 1.1);
  sweep.t += step;
  const k = Math.min(1, sweep.t / time);
  uniforms.uGraveBeamX.value = sweep.from + (sweep.to - sweep.from) * k;

  // A bell rather than a fade-out: the shaft arrives from off the stone, is at
  // its brightest crossing it, and leaves. sin(pi k) is zero at both ends, so
  // it never pops on or off, and squaring it holds the peak nearer the middle
  // where the stone actually is.
  const bell = Math.sin(Math.PI * k);
  uniforms.uGraveBeamStrength.value = bell * bell * (c.strength ?? 1.6);

  if (k >= 1) {
    sweep.active = false;
    uniforms.uGraveBeamStrength.value = 0;
  }
  publish();
}

/** Kill any sweep now. What a restart and a death call. */
export function clearGraveBeam() {
  sweep.active = false;
  sweep.t = 0;
  uniforms.uGraveBeamStrength.value = 0;
  // The shaft goes with it. Left alone, the water would keep drawing a beam
  // standing over a graveyard that the restart has already moved on from.
  clearGraveRay();
}

/** What the beam is doing. For the look page and the harness — a uniform is not
 *  otherwise readable from outside, and "did it actually fire" is the question
 *  every test here asks. */
export function graveBeamState() {
  return {
    installed,
    active: sweep.active,
    x: uniforms.uGraveBeamX.value,
    y: uniforms.uGraveBeamY.value,
    strength: uniforms.uGraveBeamStrength.value,
  };
}
