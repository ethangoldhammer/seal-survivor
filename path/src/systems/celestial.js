import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CONFIG } from '../config.js';
import { bounds, WAVE, sea } from '../arena.js';
import { dayState, horizonY } from './daylight.js';

// The sun and the moon. Two identical rigs riding the ellipse in daylight.js
// on opposite points of it, so which one is up is never a decision anything
// has to make — it falls out of the geometry.
//
// Each rig is a halo behind a disc, and the disc is a PLACEHOLDER by design:
//   texture: '/textures/sky/sun.webp'  -> flat art on the same quad
//   model:   '/models/sun.glb'         -> a model, auto-scaled to `size`
// Both are hot-swappable at runtime; the paths are re-read every frame and a
// change reloads on the spot. A model is scaled by its own bounding box
// rather than trusted to arrive at the right size, because authored assets
// never do.
//
// WHERE THEY GET CUT, which is the whole difficulty of a body at the horizon.
//
// This used to be a real THREE.Plane at horizonY(), shared by every material
// here, on the reasoning that the disc should be "cut by a straight edge
// exactly where the water starts". The premise is false: the water does not
// start at horizonY(), it starts at the WAVE, which is up to half a unit either
// side of it in a calm and nearly two in a storm. So the plane cut a straight
// line across a curved sea — and in every trough it left the cut hanging in
// open air above the water, a hard horizontal edge that did not move with the
// swell. Measured at 77/255 in one pixel row an hour after sunrise, brightest
// exactly when the horizon fog had already eased off (see below).
//
// There is no plane now, and nothing needs one:
//
//   THE DISC is cut by the WATER FILL, which is opaque, sits in front of these
//     at z=-5.4 (see world.js) and clips itself to the wave per pixel. That is
//     the same edge the drawn surface line traces, so a half-set sun is cut on
//     the curve the sea is actually drawn at, crests included.
//   THE HALO dissolves into that same wave over `haloFade` world units, in the
//     shader below. It has to be a soft fade rather than a cut for the reason
//     the fog band exists at all: this is a wide additive glow, and ending one
//     abruptly puts a hard edge in the frame wherever it ends, however correct
//     the place it ends is. Fading it to nothing AT the water line means the
//     seam is left carrying exactly the contrast it carries at noon, and the
//     glow above it is a ramp rather than a step.
//
// Both keep what the plane was actually for — no glow lighting the sea from
// underneath once the body has gone down — because both reach zero at the water
// and the fill covers everything below it.

const Z = -5.5; // in front of the sky plane (-6), behind everything else

// ---------------------------------------------------------------------------
// Shared by the disc and the halo, so both quads are positioned by exactly the
// same arithmetic.
//
// World position out of the MODEL MATRIX, not `position.xy` plus a centre: both
// rigs are unit quads stretched by their transform, so the raw position only
// ever spans +/-0.5 and every fragment would solve the wave at the same point —
// the halo would meet one flat water line across its whole width. Same trap,
// and the same fix, as systems/horizon.js.
//
// The disc's fragment shader ignores vWorldPos; it costs one interpolator and
// keeps the two rigs on one vertex program.
// ---------------------------------------------------------------------------
const bodyVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec2 vWorldPos;

  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPos = world.xy;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

// The wave function again, injected from the same WAVE constants the fill, the
// grid and the fog band use — so the halo dissolves into the curve the sea is
// drawn at rather than into one of its own. Every value carries a decimal point
// because GLSL ES will not coerce int to float; see the identical note in
// water.js.
const WAVE_GLSL = /* glsl */ `
  uniform float uSurfaceY;
  uniform float uWaveT;
  uniform float uWaveAmp;
  uniform float uChop;

  float surfaceAt(float x) {
    return uSurfaceY
      + sin(x * ${WAVE.k1.toFixed(4)} + uWaveT * ${WAVE.w1.toFixed(4)}) * uWaveAmp
      + sin(x * ${WAVE.k2.toFixed(4)} + uWaveT * ${WAVE.w2.toFixed(4)}) * uWaveAmp * ${WAVE.amp2.toFixed(4)}
      + sin(x * ${WAVE.k3.toFixed(4)} + uWaveT * ${WAVE.w3.toFixed(4)}) * uWaveAmp * ${WAVE.amp3.toFixed(4)} * uChop;
  }
`;

// ---------------------------------------------------------------------------
// The placeholder disc. A soft-edged circle on a unit quad — the same quad a
// .webp would land on, so swapping art in changes the material and nothing
// else about the rig.
//
// One shader for both the placeholder and flat art — a .webp is the same quad
// with uUseMap turned on. Worth keeping them on one material rather than
// swapping in a MeshBasicMaterial: the disc keeps its circular mask, its
// tint and its >1 brightness (which is what pushes it past the bloom
// threshold), so swapping the art in doesn't quietly change how it lights.
// ---------------------------------------------------------------------------
const discFragment = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uUseMap;
  uniform float uMask;
  uniform float uLimb;
  uniform vec3 uColor;
  uniform float uBrightness;
  uniform float uEdge;
  varying vec2 vUv;

  void main() {
    float d = length(vUv * 2.0 - 1.0);
    float edge = smoothstep(1.0, 1.0 - uEdge, d);

    // Always sampled, never branched — uMap defaults to a 1x1 white pixel, so
    // the placeholder path costs one trivially-cached fetch and the shader has
    // no divergent control flow around a texture read.
    vec4 tex = texture2D(uMap, vUv);
    vec3 rgb = mix(vec3(1.0), tex.rgb, uUseMap);
    float texA = mix(1.0, tex.a, uUseMap);

    // uMask folds the circular edge into the alpha. On for the placeholder,
    // and on by DEFAULT for art too — a moon painted on an opaque white
    // background is otherwise a white square in the sky, and that is the
    // single most likely thing to be wrong with a dropped-in .webp. Turn it
    // off for art that deliberately spills past its circle.
    float a = mix(texA, texA * edge, uMask);
    if (a <= 0.002) discard;

    // Limb darkening: the difference between a light source and a sticker.
    // Zeroed for real art, which already carries its own shading.
    vec3 c = rgb * uColor * uBrightness * (1.0 - uLimb * d * d);
    gl_FragColor = vec4(c, a);
  }
`;

// ---------------------------------------------------------------------------
// The halo. Two falloff lobes summed — a tight core and a wide soft bloom —
// because a single power curve is either a hard ring or a grey smudge.
// Additive, so it lifts whatever sky it's over instead of flattening it.
//
// ...and it meets the sea by DISSOLVING into it, not by stopping at it. See the
// note at the top of the file: the amount of light being taken away at the
// water line is around 0.9 in linear, which is most of the frame's range, and
// removing that in one pixel is a hard edge wherever you do it. Spread over
// `uFade` the same subtraction is a ramp of about five 8-bit steps per pixel —
// steeper than the sky gradient, but a gradient, which is what a glow is.
// ---------------------------------------------------------------------------
const haloFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uStrength;
  uniform float uFade;
  varying vec2 vUv;
  varying vec2 vWorldPos;

  ${WAVE_GLSL}

  void main() {
    // Zero AT the wave and below it, full uFade units above. Anchored to the
    // wave rather than to the still line so the glow is thinnest exactly where
    // the water is, whichever way the swell has gone — a fade solved against
    // the flat line is a straight edge again, just a softer one.
    // (No backticks in here: this whole shader is a JS template literal and one
    // would end the string, with the error reported against a comment.)
    float meet = smoothstep(0.0, max(uFade, 0.0001), vWorldPos.y - surfaceAt(vWorldPos.x));
    if (meet <= 0.0) discard;

    float d = length(vUv * 2.0 - 1.0);
    float r = max(0.0, 1.0 - d);
    float a = pow(r, 2.6) * 0.65 + pow(r, 9.0) * 0.35;
    gl_FragColor = vec4(uColor * a * uStrength * meet, 1.0);
  }
`;

// A single white pixel, shared by both discs, so the shader can sample
// unconditionally whether or not art has been dropped in.
function makeWhitePixel() {
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

// The halo's falloff, straight out of haloFragment above: two summed lobes, a
// tight core and a wide soft one. Needed on the CPU so `bloomRim` below can be
// solved rather than guessed at.
function haloFalloff(d) {
  const r = Math.max(0, 1 - d);
  return Math.pow(r, 2.6) * 0.65 + Math.pow(r, 9.0) * 0.35;
}

// Rec.709, matching the bright pass in systems/post.js exactly. This is the
// coefficient set that makes a cold body far dimmer to bloom than it looks:
// blue counts for 7%, green for 72%.
function relLuminance(hex) {
  const n = hex >>> 0;
  return 0.2126 * (((n >> 16) & 255) / 255)
    + 0.7152 * (((n >> 8) & 255) / 255)
    + 0.0722 * ((n & 255) / 255);
}

/**
 * How strong the halo has to be for the corona to actually GLOW.
 *
 * `haloStrength` alone is a number you drag until it looks right, and it stops
 * being right the moment anything around it moves: change `color` toward a
 * deeper blue and the luminance the bright pass sees drops by two thirds;
 * widen `halo` and the visible rim slides further down the falloff curve;
 * retune CONFIG.bloom.threshold and every body needs redoing. Worse, the part
 * of the halo you can see is the part the disc ISN'T covering, which is
 * exactly where the falloff has already eaten most of it — so the slider lies
 * about what it is doing.
 *
 * `bloomRim` states the thing actually wanted — "the corona's rim should sit
 * this far past the bloom threshold" — and this solves for the strength that
 * achieves it. 1.0 is exactly at the threshold; 1.6 is comfortably over.
 *
 * Only ever RAISES: a hand-tuned strength above the solve still wins, so this
 * is a floor rather than an override and the slider keeps working. That also
 * makes it safe against a saved tuning snapshot, which is the practical
 * reason it exists — `haloStrength` is persisted in imported-tuning.json, so a
 * new default in config.js would never reach a machine that has one.
 */
function haloStrengthFor(cfg) {
  const base = cfg.haloStrength ?? 0.5;
  const want = cfg.bloomRim ?? 0;
  if (!(want > 0) || CONFIG.bloom?.enabled === false) return base;
  const lum = relLuminance(cfg.color ?? 0xffffff);
  // Where the disc's own edge lands on the halo quad — everything inside this
  // is hidden behind the body, so it is the innermost visible ring.
  const rim = haloFalloff(1 / Math.max(1, cfg.halo ?? 2));
  const need = (CONFIG.bloom?.threshold ?? 0.55) * want / Math.max(1e-4, lum * rim);
  return Math.max(base, need);
}

function makeDiscMaterial(white) {
  return new THREE.ShaderMaterial({
    vertexShader: bodyVertex,
    fragmentShader: discFragment,
    uniforms: {
      uMap: { value: white },
      uUseMap: { value: 0 },
      uMask: { value: 1 },
      uLimb: { value: 0.18 },
      uColor: { value: new THREE.Color(0xffffff) },
      uBrightness: { value: 1 },
      uEdge: { value: 0.06 },
    },
    transparent: true,
    depthWrite: false,
  });
}

function makeHaloMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: bodyVertex,
    fragmentShader: haloFragment,
    uniforms: {
      uColor: { value: new THREE.Color(0xffffff) },
      uStrength: { value: 0.5 },
      uFade: { value: 4.5 },
      uSurfaceY: { value: 0 },
      uWaveT: { value: 0 },
      uWaveAmp: { value: 0.35 },
      uChop: { value: 0 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

export function createCelestials(scene) {
  const group = new THREE.Group();
  group.position.z = Z;
  scene.add(group);

  const quad = new THREE.PlaneGeometry(1, 1);
  const loader = new GLTFLoader();
  const textures = new THREE.TextureLoader();
  const white = makeWhitePixel();

  function makeBody() {
    const root = new THREE.Group();

    const halo = new THREE.Mesh(quad, makeHaloMaterial());
    halo.position.z = -0.1;
    // Negative, and below every other transparent thing in the game (outline
    // shells sit at -1, particles at 10): these are BACKDROP. renderOrder is
    // compared before depth in the transparent sort, so a positive value here
    // would draw the sun over the creatures in front of it.
    halo.renderOrder = -12;

    const disc = new THREE.Mesh(quad, makeDiscMaterial(white));
    disc.renderOrder = -11;

    root.add(halo, disc);
    group.add(root);

    return {
      root,
      halo,
      disc, // the placeholder quad — hidden while custom art is in place
      art: null, // whatever replaced it: a textured quad or a loaded model
      source: null, // the path `art` was built from, so we can spot a change
      token: 0, // guards against a slow load landing after a newer one
    };
  }

  const bodies = { sun: makeBody(), moon: makeBody() };

  function clearArt(body) {
    if (!body.art) return;
    body.root.remove(body.art);
    body.art.traverse?.((o) => {
      if (o.geometry && o.geometry !== quad) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) {
        m.map?.dispose();
        m.dispose();
      }
    });
    body.art = null;
  }

  // Wrap a loaded model in a pivot that is centred on it and scaled so its
  // largest dimension is one world unit. Everything the rig hangs on the
  // orbit is then a unit-sized thing it can scale by `size` — the same
  // treatment the placeholder quad gets, which is what keeps `size` a live
  // slider for models too instead of a number baked in at load time.
  function unitPivot(model) {
    const box = new THREE.Box3().setFromObject(model);
    const span = Math.max(
      box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z, 0.0001,
    );
    // In the model's own units, inside the pivot, so the pivot's scale
    // applies to the offset as well — an off-origin model orbits about its
    // own middle rather than swinging around a point outside itself.
    model.position.sub(box.getCenter(new THREE.Vector3()));

    const pivot = new THREE.Group();
    // Read back by updateBody, which multiplies it by `size` every frame.
    pivot.userData.unitScale = 1 / span;
    pivot.add(model);
    return pivot;
  }

  // Back to the built-in disc: white pixel, limb darkening on, quad shown.
  // Every failure path lands here, so a typo'd path or a missing file costs a
  // warning and a placeholder rather than an empty sky.
  function toPlaceholder(body) {
    const u = body.disc.material.uniforms;
    if (u.uMap.value !== white) u.uMap.value.dispose?.();
    u.uMap.value = white;
    u.uUseMap.value = 0;
    u.uLimb.value = 0.18;
    body.disc.visible = true;
  }

  function loadArt(body, cfg) {
    const source = cfg.model || cfg.texture || null;
    if (source === body.source) return;

    clearArt(body);
    toPlaceholder(body);
    body.source = source;
    body.token += 1;
    const token = body.token;
    if (!source) return;

    if (cfg.model) {
      body.disc.visible = false;
      loader.load(cfg.model, (gltf) => {
        // A newer path was set while this was in flight — drop it.
        if (token !== body.token) return;
        // No clipping to apply: a model is cut by the water fill in front of it
        // like the placeholder disc is. See the note at the top of the file.
        const pivot = unitPivot(gltf.scene);
        body.art = pivot;
        body.root.add(pivot);
      }, undefined, (err) => {
        console.warn(`[celestial] could not load ${cfg.model} — falling back to the placeholder disc.`, err?.message ?? err);
        if (token === body.token) toPlaceholder(body);
      });
      return;
    }

    // Flat art rides the disc's own material rather than a mesh of its own,
    // so it keeps the circular mask, the tint and the bloom-pushing
    // brightness. Only the map and two switches change.
    textures.load(cfg.texture, (map) => {
      if (token !== body.token) { map.dispose(); return; }
      map.colorSpace = THREE.SRGBColorSpace;
      const u = body.disc.material.uniforms;
      u.uMap.value = map;
      u.uUseMap.value = 1;
      u.uLimb.value = 0; // real art carries its own shading
      body.disc.visible = true;
    }, undefined, (err) => {
      // On the deployed site a missing file does NOT 404: the Pages SPA
      // fallback serves index.html with a 200, which then fails to decode as
      // an image and lands here. So "could not load" covers both "not there"
      // and "not an image", and the message has to be useful for either.
      console.warn(`[celestial] could not load ${cfg.texture} — falling back to the placeholder disc. Is the file in public/?`, err?.message ?? err);
      if (token === body.token) toPlaceholder(body);
    });
  }

  function updateBody(body, state, cfg, waveT) {
    loadArt(body, cfg);

    // Bigger and brighter the moment the disc straddles the water line. The
    // size bump is small on purpose — the flare should read as light, not as
    // the sun growing on the way down.
    const touch = state.horizonMix;
    const flare = 1 + (cfg.horizonGlow ?? 0) * touch;

    body.root.position.set(state.x, state.y, 0);
    // A cull, not a look: below this the whole halo is under the water line and
    // the fill covers every pixel of it. state.y IS the world height — the
    // layer carries no vertical offset (see update) — so this and the orbit are
    // reading the same number and cannot disagree.
    body.root.visible = state.y > horizonY() - cfg.size * (cfg.halo ?? 2) * 0.5;
    if (!body.root.visible) return;

    // `art` is only ever a MODEL now — flat art rides the disc itself, so the
    // quad is still the target when a .webp is in place.
    const target = body.art ?? body.disc;
    target.scale.setScalar(cfg.size * (target.userData.unitScale ?? 1));

    // A model carries its own materials and its own idea of colour; tinting it
    // from here would fight whatever it was authored with. The quad — with or
    // without art on it — is ours to light.
    if (!body.art) {
      const u = body.disc.material.uniforms;
      u.uColor.value.set(cfg.color);
      u.uBrightness.value = cfg.brightness;
      u.uMask.value = (cfg.maskToDisc ?? true) ? 1 : 0;
      // How wide the circular alpha edge is, in disc radii. Config-driven
      // rather than the constant it used to be because it is the one control
      // that rescues hand-painted art: a disc that doesn't quite reach the
      // frame, on a background that isn't quite transparent, leaves a bright
      // rim between the paint and the mask, and widening the feather is what
      // eats it. Nothing else in the rig can reach that ring.
      u.uEdge.value = cfg.edgeFeather ?? 0.06;
    }

    const halo = body.halo;
    halo.scale.setScalar(cfg.size * (cfg.halo ?? 2) * (1 + 0.12 * touch));
    const hu = halo.material.uniforms;
    hu.uColor.value.set(cfg.color);
    hu.uStrength.value = haloStrengthFor(cfg) * flare;
    // How far above the water the glow takes to come up to full. The one number
    // that decides whether the horizon has an edge on it: at 0 this is the hard
    // cut it replaced, and it wants to be comparable to the fog band's own
    // reach (CONFIG.horizonGlow.up) so the two read as one piece of haze.
    hu.uFade.value = Math.max(0, cfg.haloFade ?? 4.5);
    // The wave the glow dissolves into, refreshed from the LIVE sea state and
    // the caller's waveT — the same curve the fill clips to and the line is
    // drawn on. Solved a frame late, or against a calm amplitude while a storm
    // is running, the glow slides against the water instead of meeting it.
    hu.uSurfaceY.value = bounds.surfaceY;
    hu.uWaveT.value = waveT;
    hu.uWaveAmp.value = sea.amp;
    hu.uChop.value = sea.chop;
  }

  /**
   * @param camX where the camera has been FRAMED this frame — its position
   *   before any shake is added on top. Handed in rather than read off the
   *   camera on purpose: shake is a per-frame random offset applied after the
   *   framing, and parallaxing against it would counter-shake the sky, so the
   *   sun would visibly buzz through every explosion.
   *
   *   Horizontal only. There is no camY, by design — see below.
   *
   * @param waveT the surface clock, so the halos dissolve into the same swell
   *   the fill clips to and the drawn line traces. Solved against a different
   *   wave, the glow slides along the water instead of meeting it.
   */
  function update(camX = 0, waveT = 0) {
    const cfg = CONFIG.dayNight;
    group.visible = !!cfg?.enabled;
    if (!group.visible) return;

    // Parallax, done as a plain counter-offset because an ORTHOGRAPHIC camera
    // gets none for free — there is no perspective divide, so a sun at z=-40
    // and a sun at z=-5 pan at exactly the same rate. Sitting the layer at
    // camPos * (1 - parallax) means a camera move of D slides it D * parallax
    // across the world: at 0.15 the sky drifts at a seventh of the speed of
    // the ocean in front of it, which is what sells it as far away.
    //
    // X ONLY. The vertical axis gets no parallax at all, and that is not a
    // simplification — a vertical offset is actively wrong here, because the
    // horizon this sky is measured against does not move. The water line is a
    // WORLD-space curve and the halo's fade is solved against it per pixel, so
    // offsetting the layer in Y slides the sun up and down past a fixed
    // horizon: dive twenty units and a low sun visibly sets, surface again
    // and it rises. Height above the horizon is what encodes the time of day,
    // and it must be a function of the orbit and nothing else.
    //
    // So the sky is locked to the world vertically. Swimming up and down does
    // not move the sun and moon in the sky; it moves YOU under them, which is
    // what pans them across the frame.
    //
    // Independent of zoom, and deliberately so: zoom scales the whole frustum
    // about the camera, and both the offset and everything it is measured
    // against scale with it, so the ratio survives a push-in untouched.
    const orbit = cfg.orbit;
    const keep = 1 - Math.max(0, Math.min(1, orbit.parallax ?? 1));
    group.position.set(camX * keep, 0, orbit.depth ?? Z);

    updateBody(bodies.sun, dayState.sun, cfg.sun, waveT);
    updateBody(bodies.moon, dayState.moon, cfg.moon, waveT);
  }

  return { update, group };
}
