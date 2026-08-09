import * as THREE from 'three';

// ============================================================================
// BIOLUMINESCENCE — procedural glow that runs ALONG a creature, not over it.
//
// An emissive texture answers "which pixels of this animal light up". It can't
// answer "how far along this particular tentacle are we, and is THAT tentacle
// busy right now" — that's geometry and gameplay, not art. This system answers
// the second question, and leaves the first one to the masks that already
// exist.
//
// THE WHOLE IDEA IS TWO NUMBERS PER VERTEX:
//
//   channel   which region this vertex belongs to — which arm, which stripe,
//             which body zone. An integer, baked once at attach time.
//   param     how far along that region it sits, ALWAYS normalised 0 at the
//             base to 1 at the tip.
//
// Gameplay then writes one intensity per channel per frame, and the shader
// lights each vertex by `intensity[channel] * falloff(param)`.
//
// `param` being normalised is what makes this work on any mesh at any size.
// Nothing here is in world units, so a 0.4-unit shrimp and a 40-unit whale use
// the same numbers, and rescaling a model — or the per-asset size slider —
// changes nothing about how the glow reads. That was the requirement, and it
// is the reason the parameterisation is normalised at BUILD time rather than
// measured in the shader.
//
// SOURCES decide how those two numbers are derived, and they are the extension
// point. Three ship here:
//
//   boneChains  dominant skin bone -> which chain, and how far along it.
//               For limbs: octopus arms, a jellyfish's tentacles.
//   axis        normalised position along a model axis. For head-to-tail
//               gradients and stripes.
//   radial      normalised distance from a point. For a glowing core that
//               fades outward.
//
// Adding a fourth means adding one function that returns { channel, param }
// per vertex. Nothing else in the file needs to know about it.
//
// RENDERING. The glow is injected into whatever material the model already
// has, via onBeforeCompile, and ADDED to the final colour rather than
// replacing anything — so textures, tint, outline shells and the existing
// emissive masks all keep working. The hook is `#include <dithering_fragment>`
// because that chunk exists in basic, lambert, phong AND standard, which is
// what lets the same system light an unlit silhouette and a lit body without
// caring which it got.
//
// Values above 1 are meaningful: the bloom chain renders to a HalfFloat
// target, so an intensity pushed past 1 survives to the bright-pass instead of
// clipping first. Keep the base colour dark-ish and let `strength` do the
// work — a bright colour AT high strength is how you get a flat white blob
// with no shape in it.
// ============================================================================

const DEFAULTS = {
  color: 0x66ffe0,
  strength: 1.4, // multiplier on the whole effect
  falloff: 2.2, // >1 concentrates the glow at the tip; 1 is a linear ramp
  // How much of the region, from the tip back, lights up at all. 1 lets the
  // glow run the whole way to the base; 0.35 keeps it to the last third.
  span: 0.55,
  ambient: 0.0, // floor intensity every channel gets even when "off"
  shimmerAmp: 0.25,
  shimmerFreq: 6.0, // cycles along the region
  shimmerSpeed: 2.2,
};

// --- sources ---------------------------------------------------------------
// Each returns a function (vertexIndex) => { channel, param }, or null for a
// vertex that belongs to no region. Building the lookup up front rather than
// per vertex keeps the O(verts) pass cheap on a 16k-vertex mesh.

/**
 * Limbs, from the skeleton. A vertex takes the channel of whichever bone has
 * the largest influence on it, and its `param` is that bone's index along its
 * chain — so the parameterisation follows the ANIMATION rather than the rest
 * pose, and an arm that curls keeps its glow running correctly along itself.
 *
 * `chains` is an array of arrays of bone names, one per channel.
 */
function boneChainSource(mesh, chains) {
  const skeleton = mesh.skeleton;
  if (!skeleton) return null;

  const skinIndex = mesh.geometry.attributes.skinIndex;
  const skinWeight = mesh.geometry.attributes.skinWeight;
  if (!skinIndex || !skinWeight) return null;

  // Which bones actually deform anything. Rigs routinely end a chain with a
  // LOCATOR bone that carries no skin weight — the octopus does, on all seven
  // of its chains — and normalising across it means no vertex ever reaches
  // param 1. The tip then sits partway down the falloff curve and the glow is
  // quietly dimmer than configured, at exactly the place it was supposed to be
  // brightest. Dropping unweighted bones BEFORE normalising fixes that for any
  // rig, without anyone having to know their tips are locators.
  const weighted = new Set();
  for (let v = 0; v < skinIndex.count; v++) {
    for (let k = 0; k < 4; k++) {
      if (skinWeight.getComponent(v, k) > 0) weighted.add(skinIndex.getComponent(v, k));
    }
  }

  // bone index in the skeleton -> { channel, param }
  const byBone = new Map();
  chains.forEach((names, channel) => {
    const live = names
      .map((name) => skeleton.bones.findIndex((b) => b.name === name))
      .filter((i) => i >= 0 && weighted.has(i));
    const n = live.length;
    live.forEach((bone, i) => {
      byBone.set(bone, { channel, param: n > 1 ? i / (n - 1) : 1 });
    });
  });

  return (v) => {
    // Dominant bone, not a weighted average of the params: averaging across
    // two different arms would put a vertex on a fictional arm between them.
    let best = -1;
    let bestW = 0;
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(v, k);
      if (w > bestW) { bestW = w; best = skinIndex.getComponent(v, k); }
    }
    return byBone.get(best) ?? null;
  };
}

/** Normalised position along a model axis, as one channel. */
function axisSource(mesh, { axis = 'y', channel = 0, invert = false } = {}) {
  const pos = mesh.geometry.attributes.position;
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox;
  const lo = box.min[axis];
  const span = Math.max(1e-6, box.max[axis] - lo);
  return (v) => {
    const t = (pos.getComponent(v, axis === 'x' ? 0 : axis === 'y' ? 1 : 2) - lo) / span;
    return { channel, param: invert ? 1 - t : t };
  };
}

/** Normalised distance from a point in model space, as one channel. */
function radialSource(mesh, { origin = [0, 0, 0], channel = 0, invert = false } = {}) {
  const pos = mesh.geometry.attributes.position;
  const o = new THREE.Vector3().fromArray(origin);
  const p = new THREE.Vector3();
  let max = 1e-6;
  for (let v = 0; v < pos.count; v++) {
    max = Math.max(max, p.fromBufferAttribute(pos, v).distanceTo(o));
  }
  return (v) => {
    const t = p.fromBufferAttribute(pos, v).distanceTo(o) / max;
    return { channel, param: invert ? 1 - t : t };
  };
}

function sourceFor(mesh, spec) {
  switch (spec.source?.type) {
    case 'boneChains': return boneChainSource(mesh, spec.source.chains ?? []);
    case 'axis': return axisSource(mesh, spec.source);
    case 'radial': return radialSource(mesh, spec.source);
    default:
      console.warn(`[biolum] unknown source type "${spec.source?.type}" — nothing will glow.`);
      return null;
  }
}

// --- shader ----------------------------------------------------------------

const VERT_HEAD = `
attribute float aGlowChannel;
attribute float aGlowParam;
uniform float uGlowIntensity[GLOW_CHANNELS];
varying float vGlowLevel;
varying float vGlowParam;
`;

// The channel lookup is a constant-bounds loop rather than a dynamic array
// index. Dynamic indexing of a uniform array is legal in GLSL ES 3.00 but not
// reliably in 1.00, and this costs nothing at these channel counts — six
// comparisons on a vertex shader that is already skinning four bones.
const VERT_BODY = `
  vGlowParam = aGlowParam;
  vGlowLevel = 0.0;
  int glowCh = int(aGlowChannel + 0.5);
  for (int i = 0; i < GLOW_CHANNELS; i++) {
    if (i == glowCh) vGlowLevel = uGlowIntensity[i];
  }
`;

const FRAG_HEAD = `
uniform vec3 uGlowColor;
uniform float uGlowStrength;
uniform float uGlowFalloff;
uniform float uGlowSpan;
uniform float uGlowShimmer;
uniform float uGlowShimmerFreq;
uniform float uGlowShimmerSpeed;
uniform float uGlowTime;
varying float vGlowLevel;
varying float vGlowParam;
`;

// Runs where gl_FragColor is already final. Additive, so nothing the material
// was already doing is disturbed.
//
// A NEGATIVE vGlowParam marks a vertex that belongs to no region at all; the
// clamp turns it into zero glow, and the interpolated band between a lit
// region and an unlit one falls off smoothly instead of showing a seam.
const FRAG_BODY = `
  if (vGlowLevel > 0.001 && vGlowParam > 0.0) {
    // Remap so only the last uGlowSpan of the region lights up, then shape it.
    float band = clamp((vGlowParam - (1.0 - uGlowSpan)) / max(1e-4, uGlowSpan), 0.0, 1.0);
    float shape = pow(band, uGlowFalloff);
    float shimmer = 1.0 + uGlowShimmer * sin(vGlowParam * uGlowShimmerFreq - uGlowTime * uGlowShimmerSpeed);
    gl_FragColor.rgb += uGlowColor * (vGlowLevel * shape * shimmer * uGlowStrength);
  }
`;

let attachSeq = 0;

/**
 * Light a model.
 *
 * @param root   the Object3D returned by createVisual — every SkinnedMesh and
 *               Mesh under it is attached.
 * @param spec   { channels, source, color, strength, falloff, span, ambient,
 *                 shimmerAmp, shimmerFreq, shimmerSpeed, tag }
 * @returns a handle: setChannel(i, v), setAll(v), setColor(hex), update(dt),
 *          dispose(). Null if nothing could be attached.
 */
export function attachBioluminescence(root, spec = {}) {
  const cfg = { ...DEFAULTS, ...spec };
  const channels = Math.max(1, Math.round(cfg.channels ?? 1));

  // The uniform objects are created HERE and handed to each shader, rather
  // than written into shader.uniforms from inside onBeforeCompile — that
  // callback doesn't run until the material first renders, so an intensity
  // set before the first frame (or while the creature is offscreen) would be
  // silently dropped. Same reasoning as makeOutlineMaterial's uOutline.
  const uniforms = {
    uGlowIntensity: { value: new Float32Array(channels).fill(cfg.ambient) },
    uGlowColor: { value: new THREE.Color(cfg.color) },
    uGlowStrength: { value: cfg.strength },
    uGlowFalloff: { value: cfg.falloff },
    uGlowSpan: { value: cfg.span },
    uGlowShimmer: { value: cfg.shimmerAmp },
    uGlowShimmerFreq: { value: cfg.shimmerFreq },
    uGlowShimmerSpeed: { value: cfg.shimmerSpeed },
    uGlowTime: { value: 0 },
  };

  const tag = `${cfg.tag ?? 'biolum'}:${channels}`;
  const touched = [];
  let attached = 0;

  root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;

    const read = sourceFor(o, cfg);
    if (!read) return;

    const count = o.geometry.attributes.position.count;
    const chAttr = new Float32Array(count);
    const paramAttr = new Float32Array(count);
    let lit = 0;
    for (let v = 0; v < count; v++) {
      const r = read(v);
      if (!r) { chAttr[v] = 0; paramAttr[v] = -1; continue; }
      chAttr[v] = r.channel;
      paramAttr[v] = r.param;
      lit++;
    }
    if (!lit) return;

    o.geometry.setAttribute('aGlowChannel', new THREE.BufferAttribute(chAttr, 1));
    o.geometry.setAttribute('aGlowParam', new THREE.BufferAttribute(paramAttr, 1));

    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const mat of mats) {
      if (!mat || mat.userData.__biolum) continue;
      injectInto(mat, uniforms, channels, tag);
      touched.push(mat);
    }
    attached++;
  });

  if (!attached) {
    console.warn('[biolum] nothing attached — no mesh produced a glow region.');
    return null;
  }

  attachSeq++;
  return {
    channels,
    setChannel(i, value) {
      if (i < 0 || i >= channels) return;
      uniforms.uGlowIntensity.value[i] = Math.max(cfg.ambient, value);
    },
    setAll(value) {
      uniforms.uGlowIntensity.value.fill(Math.max(cfg.ambient, value));
    },
    setColor(hex) { uniforms.uGlowColor.value.set(hex); },
    // Reads the live config every frame on purpose, so the tuner sliders move
    // the look of a creature already on screen instead of only new ones.
    apply(look = {}) {
      if (look.color != null) uniforms.uGlowColor.value.set(look.color);
      if (look.strength != null) uniforms.uGlowStrength.value = look.strength;
      if (look.falloff != null) uniforms.uGlowFalloff.value = look.falloff;
      if (look.span != null) uniforms.uGlowSpan.value = look.span;
      if (look.shimmerAmp != null) uniforms.uGlowShimmer.value = look.shimmerAmp;
      if (look.shimmerFreq != null) uniforms.uGlowShimmerFreq.value = look.shimmerFreq;
      if (look.shimmerSpeed != null) uniforms.uGlowShimmerSpeed.value = look.shimmerSpeed;
    },
    update(dt) { uniforms.uGlowTime.value += dt; },
    uniforms,
    dispose() {
      for (const mat of touched) {
        delete mat.userData.__biolum;
        mat.needsUpdate = true;
      }
      touched.length = 0;
    },
  };
}

function injectInto(mat, uniforms, channels, tag) {
  const previous = mat.onBeforeCompile;
  mat.userData.__biolum = true;

  // three keys compiled programs partly by the SOURCE of onBeforeCompile, and
  // every creature instance gets its own material. Pinning the key to a
  // constant means twenty octopuses share one compiled program instead of
  // compiling twenty — and, just as importantly, that two materials wearing
  // DIFFERENT channel counts can never be handed each other's shader.
  mat.customProgramCacheKey = () => tag;

  mat.onBeforeCompile = (shader, renderer) => {
    previous?.call(mat, shader, renderer);
    Object.assign(shader.uniforms, uniforms);

    const head = VERT_HEAD.replace(/GLOW_CHANNELS/g, String(channels));
    const body = VERT_BODY.replace(/GLOW_CHANNELS/g, String(channels));

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${head}`)
      // After <begin_vertex> rather than before: the attributes are per-vertex
      // constants, so where they're read makes no difference to them, but
      // sitting after begin_vertex keeps this out of the way of the outline
      // shells' rim push, which rewrites `transformed` at exactly that point.
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${body}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
      // `dithering_fragment` is the one chunk shared by basic, lambert, phong
      // and standard, and by then gl_FragColor is final. Hooking the lit-only
      // <emissivemap_fragment> instead would silently skip every model marked
      // `modelUnlit`, which is a third of the roster.
      .replace('#include <dithering_fragment>', `${FRAG_BODY}\n#include <dithering_fragment>`);
  };
  mat.needsUpdate = true;
}

// Exported for tools/biolum-test.mjs, which checks the injected GLSL against
// the real three.js shader source — the failure this guards against is a three
// upgrade renaming a chunk, at which point the replace silently no-ops and the
// glow just never appears.
export const __shaderChunks = { VERT_HEAD, VERT_BODY, FRAG_HEAD, FRAG_BODY };
