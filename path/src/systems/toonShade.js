import * as THREE from 'three';
import { CONFIG } from '../config.js';

// BANDED (CEL) LIGHTING, injected into three.js's own MeshStandardMaterial
// rather than replacing it.
//
// The icon renderer (tools/atlas-render/iconRender.js) gets its toon look by
// swapping every material for a MeshToonMaterial. That is right there — an icon
// is a still frame with no gameplay attached — and wrong here, because a swap
// throws away everything else the surface is carrying:
//
//   the emissive map      an unlit/toon material cannot receive one at all
//   biolumSkin            patches MeshStandardMaterial's own chunks
//   noiseShader           same, and both are onBeforeCompile injections
//   roughness/metalness   which is what CONFIG.bloom was tuned against
//
// So this quantises the light INSIDE the standard material. Everything above
// keeps working, and — the point of the exercise — a creature can carry a
// painted pattern and banded shading at the same time.
//
// ---------------------------------------------------------------------------
// WHY THE CHAIN, and the bug it exists to prevent
//
// noiseShader and biolumSkin both do `material.onBeforeCompile = fn`. It is an
// ASSIGNMENT, so whichever attaches last silently wins and the other's shader is
// simply gone — no error, no warning, and the symptom is a creature that renders
// perfectly except that its pattern (or its bands) never appears. Since the
// whole purpose of this file is to sit on materials that already have one of
// those, it composes: the previous callback is kept and called first, and this
// patches the shader it produced.
//
// Same reason Material.clone() is dangerous here — the clone drops
// onBeforeCompile entirely. Clone first, attach second, always.
// ---------------------------------------------------------------------------

const LUMA = 'vec3(0.2126, 0.7152, 0.0722)';

const GLSL = `
uniform float uToonSteps;
uniform float uToonStrength;
uniform float uToonLow;
uniform float uToonHigh;
uniform float uToonGamma;
uniform float uToonSoft;
uniform float uToonRange;
`;

// Quantise THE LIGHT THIS FRAGMENT RECEIVED — not the lit result.
//
// THE DIFFERENCE IS THE WHOLE CORRECTNESS OF THIS FILE. `reflectedLight` is
// already light × albedo, so banding its luminance to absolute levels forces
// every pixel to one of N brightnesses REGARDLESS of the animal's own colour: a
// great white's dark grey back and its white belly both land on the same band and
// the shark renders as a pale silhouette with its markings gone. That is what the
// first version did, and on a photograph-textured body it reads as the texture
// having failed to load rather than as a shading choice.
//
// So the incoming light is recovered first by dividing out the albedo
// (`diffuseColor`, still in scope here), banded on its own, and multiplied back.
// Albedo survives untouched — a dark back stays dark — and only the gradient
// across the body is stepped, which is what cel shading is.
//
// LUMINANCE, then rescale the colour to match — not per-channel banding. Banding
// R, G and B separately quantises the HUE as well as the brightness, so a warm
// key on a blue-grey shark steps through green on its way down the body.
//
// Applied to direct + indirect together. Banding only the direct term leaves the
// ambient floor smooth underneath, which reads as a cel-shaded animal sitting in
// a photographic haze — worse than either look on its own.
const GLSL_BODY = `
{
  vec3 toonDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
  float toonLum = dot(toonDiffuse, ${LUMA});
  // The albedo this fragment is wearing, AFTER the map, the noise and any
  // pigment pattern have had their say — so a painted marking bands with the
  // body rather than being flattened by it.
  float toonAlbedo = max(dot(diffuseColor.rgb, ${LUMA}), 1e-4);
  // The light on its own, with the animal's colour divided out.
  float toonLight = toonLum / toonAlbedo;
  if (uToonStrength > 0.0 && toonLum > 1e-5) {
    float steps = max(uToonSteps, 1.0);
    // uToonRange is what counts as "fully lit", in LIGHT units now — so it is a
    // property of the scene's exposure rather than of the animal, and one value
    // works across a dark shark and a white beluga.
    float t = clamp(pow(clamp(toonLight / max(uToonRange, 1e-4), 0.0, 1.0), uToonGamma), 0.0, 1.0);
    float scaled = t * steps;
    float idx = min(floor(scaled), steps - 1.0);
    float frac = scaled - idx;
    // Soft is a shoulder on the LEADING edge of each band, so the steps stay
    // visible as steps however soft the transitions get. 0 is a hard cel edge.
    float shoulder = uToonSoft > 1e-4 ? smoothstep(0.0, uToonSoft, frac) : 0.0;
    float level = clamp((idx + shoulder) / max(steps - 1.0, 1.0), 0.0, 1.0);
    float banded = mix(uToonLow, uToonHigh, level);
    // Back through the albedo, so the band is a LIGHT level and the colour under
    // it is whatever the surface already was.
    vec3 toonLit = toonDiffuse * (banded / max(toonLight, 1e-4));
    vec3 mixed = mix(toonDiffuse, toonLit, uToonStrength);
    // Split back over the two terms in the proportion they arrived, so anything
    // downstream that reads them separately still sees a sane ratio.
    float share = toonLum > 1e-5
      ? dot(reflectedLight.directDiffuse, ${LUMA}) / toonLum
      : 1.0;
    reflectedLight.directDiffuse = mixed * share;
    reflectedLight.indirectDiffuse = mixed * (1.0 - share);
  }
}
`;

const attached = new Set();

/**
 * Band the lighting on one material. `preset` names a block under
 * CONFIG.toonShade.presets; absent, it wears the base.
 *
 * Safe to call on a material that already carries a noise or biolum shader —
 * see the note on chaining above. Idempotent.
 */
export function attachToonShade(material, preset = null) {
  if (!material || material.userData.__toonAttached) return;
  // Needs a lit material: the quantise reads `reflectedLight`, which only the
  // lighting chunks declare. The unlit fallbacks (MeshBasicMaterial shapes, the
  // sprite path, and the outline shells) have no such thing, and injecting there
  // would be a compile error — which renders NOTHING and reports nothing.
  if (!material.isMeshStandardMaterial && !material.isMeshPhysicalMaterial) return;
  material.userData.__toonAttached = true;
  material.userData.__toonPreset = preset;

  const u = {
    // Strength 0 means an attached material renders EXACTLY as it did before,
    // so attaching early and deciding later costs nothing. applyToonSettings
    // is what turns it on.
    uToonStrength: { value: 0 },
    uToonSteps: { value: 3 },
    uToonLow: { value: 0.28 },
    uToonHigh: { value: 1.0 },
    uToonGamma: { value: 1 },
    uToonSoft: { value: 0 },
    uToonRange: { value: 1 },
  };
  material.userData.__toonUniforms = u;

  // THE CHAIN. Kept as a local so a later attach of something else can chain
  // onto this one in turn.
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = function toonOnBeforeCompile(shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    Object.assign(shader.uniforms, u);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL)
      // AFTER lights_fragment_end, which is where reflectedLight holds the
      // finished direct and indirect diffuse. Before it, the terms are still
      // being accumulated per light and banding would quantise each light's
      // contribution separately — three lights would give three sets of bands
      // crossing each other.
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + GLSL_BODY);
    material.userData.__toonCompiled = true;
  };
  material.needsUpdate = true;
  attached.add(material);
}

/** Push CONFIG at every attached material. Cheap; call after any tuner change. */
export function applyToonSettings() {
  const cfg = CONFIG.toonShade ?? {};
  const base = cfg.base ?? {};
  for (const m of attached) {
    const u = m.userData.__toonUniforms;
    if (!u) continue;
    const preset = m.userData.__toonPreset;
    // base, then the species' own overrides — the same fall-through
    // CONFIG.biolumSkin uses, so one slider can move the whole family while a
    // species still gets to disagree.
    const p = { ...base, ...(preset ? (cfg.presets?.[preset] ?? {}) : {}) };
    // `enabled` folds into strength rather than branching, so the toggle fades
    // the same way the slider does instead of popping.
    const off = cfg.enabled === false || p.enabled === false;
    u.uToonStrength.value = off ? 0 : (p.strength ?? 1);
    u.uToonSteps.value = Math.max(1, p.steps ?? 3);
    u.uToonLow.value = p.low ?? 0.28;
    u.uToonHigh.value = p.high ?? 1;
    u.uToonGamma.value = p.gamma ?? 1;
    u.uToonSoft.value = p.soft ?? 0;
    u.uToonRange.value = p.range ?? 1;
  }
}

export function toonShadeMaterialCount() {
  return attached.size;
}

/** For harnesses: forget every material, so a count means what it says. */
export function resetToonShade() {
  attached.clear();
}
