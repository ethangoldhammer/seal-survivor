import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CONFIG } from '../config.js';
import { bounds, WAVE, sea } from '../arena.js';
import { dayState, horizonY, bodySize } from './daylight.js';

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
//
// WHERE THEY ARE DRAWN is not quite where daylight.js puts them. Two things sit
// between the orbit and the frame — the drift (a near-zero parallax, so the sky
// reads as infinitely far away) and the frame fit (so a body is never half off
// the edge of the shot) — and both are resolved here, in the layer that draws
// them, rather than in the clock. `celestialFrame` below publishes the answer,
// because the trigger zones have to sit where the player SEES the sun, not
// where the ellipse says it is.

const Z = -5.5; // in front of the sky plane (-6), behind everything else

// ---------------------------------------------------------------------------
// WHERE THE BODIES ACTUALLY ARE, in world units, after the drift and the frame
// fit — and how big they are on the day the tuner last touched them.
//
// Published as module state rather than returned from update() for the same
// reason dayState is: the readers are systems/celestialPass.js and whatever it
// hands its hits to, and none of them hold the rig's handle. `radius` is the
// DISC; `trigger` is the zone inside it that counts as a pass, which is a
// fraction of the disc so that the zone is always inside the thing you can see.
// ---------------------------------------------------------------------------
export const celestialFrame = {
  sun: { x: 0, y: 0, radius: 0, trigger: 0, visible: false, color: 0xffffff },
  moon: { x: 0, y: 0, radius: 0, trigger: 0, visible: false, color: 0xffffff },
};

// ---------------------------------------------------------------------------
// THE FLARE — what a body does when something goes through it.
//
// Module state, not per-rig, so the gameplay side can reach it without holding
// the handle world.js keeps. One envelope per body: `level` is how much shine
// is banked and decays every frame, `t` is the flicker's own clock and restarts
// on every hit so a second pass re-strikes rather than continuing a phase
// nobody can see the start of.
// ---------------------------------------------------------------------------
const flares = {
  sun: { level: 0, t: 0 },
  moon: { level: 0, t: 0 },
};

/**
 * Light a body up. Called when the seal passes through it — see
 * systems/celestialPass.js.
 *
 * @param which 'sun' | 'moon'
 * @param amount how hard, 1 being a clean pass through the middle.
 */
export function flareCelestial(which, amount = 1) {
  const f = flares[which];
  if (!f || !(amount > 0)) return;
  const cfg = CONFIG.dayNight?.pass?.flare ?? {};
  f.level = Math.min(cfg.max ?? 3, f.level + amount);
  f.t = 0;
}

/** Put both bodies back to a cold, unlit state. Called on a run reset. */
export function clearCelestialFlares() {
  for (const f of Object.values(flares)) { f.level = 0; f.t = 0; }
}

// How much extra light a body is carrying THIS frame, and the flicker on top of
// it. Returns 0 the moment the envelope has run out, so the whole thing costs a
// compare on every frame of a run that never touches the sky.
//
// TWO SINES at incommensurate rates rather than a random number per frame: the
// flare lasts about a second, and white noise at 60fps reads as a rendering
// fault where a beat between two rates reads as something burning. Bounded
// below at 0 for the same reason the halo strength is — an additive glow driven
// negative is a hole in the sky.
function advanceFlare(f, dt) {
  if (f.level <= 0) return 0;
  const cfg = CONFIG.dayNight?.pass?.flare ?? {};
  f.t += dt;
  f.level *= Math.exp(-dt / Math.max(0.05, cfg.decay ?? 0.55));
  if (f.level < 0.002) { f.level = 0; return 0; }
  const rate = cfg.flickerRate ?? 17;
  const wobble = Math.sin(f.t * rate) * 0.6 + Math.sin(f.t * rate * 0.37 + 1.7) * 0.4;
  return Math.max(0, f.level * (1 + wobble * (cfg.flicker ?? 0.45)));
}

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

// Scratch for fitToFrame — see the note there.
const _fit = { x: 0, y: 0 };

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

  // ---------------------------------------------------------------------------
  // THE FRAME FIT. Where a body ends up once the shot has had its say.
  //
  // `at` is the world point the orbit and the drift put it at; the return is
  // where it is drawn. Both axes are guarantees rather than looks — nothing
  // here moves a body that is already comfortably inside the frame.
  //
  // X is a plain clamp. The frame is the camera's, at whatever zoom it ended up
  // at, so a push-in that would have cropped the sun brings it in instead.
  //
  // Y IS THE HARD ONE, and it is capped by the horizon rather than by taste.
  // Height above the water line is what encodes the time of day (see the note
  // in update below), so sliding a body down the frame is a lie: it stages a
  // sunset the clock never ordered. But it is only a lie SOMEONE CAN SEE while
  // the water line is in the shot — dive far enough and the horizon has left
  // the top of the frame, and with nothing left to measure the sun against, the
  // sky may as well come down with the camera. So the shift is bounded by
  // exactly how far the water line already sits above the frame: at the surface
  // that is zero and nothing moves at all, and however deep you go the horizon
  // is never dragged back into view to be compared against.
  //
  // That bound is also why this cannot promise a body is always in shot. Deep
  // enough and the whole sky is out of frame, horizon included, and a sun
  // pinned to the top edge of an underwater shot would be the same lie in a
  // louder voice.
  //
  // Writes into `_fit`, which is scratch shared by both bodies: this runs twice
  // a frame for the whole life of a run, and the two object literals it used to
  // build are two allocations a frame that never needed to exist. Same reason
  // daylight.js keeps its colours module-level.
  function fitToFrame(x, y, pad, view, keep) {
    const at = _fit;
    at.x = x;
    at.y = y;
    if (!view || !(keep > 0)) return at;

    const limitX = Math.max(0, view.halfW - pad);
    at.x = Math.min(view.x + limitX, Math.max(view.x - limitX, at.x));

    const visibleTop = view.y + view.halfH;
    const slack = Math.max(0, horizonY() - visibleTop);
    const need = Math.max(0, (at.y + pad) - visibleTop);
    at.y -= Math.min(need, slack) * keep;
    return at;
  }

  function updateBody(body, which, state, cfg, waveT, view, dt) {
    loadArt(body, cfg);

    // Bigger and brighter the moment the disc straddles the water line. The
    // size bump is small on purpose — the flare should read as light, not as
    // the sun growing on the way down.
    const touch = state.horizonMix;
    const flare = 1 + (cfg.horizonGlow ?? 0) * touch;
    // ...and the other flare: what a seal going through it left behind.
    const shine = advanceFlare(flares[which], dt);
    const passCfg = CONFIG.dayNight?.pass ?? {};

    const orbit = CONFIG.dayNight.orbit;
    // THE one size, resolved by daylight.js — the same number the orbit sized
    // its arc against. Read here rather than off cfg.size directly because
    // `frameSize` (a fraction of the visible sky) is what the tuner writes now,
    // and a rig scaling a disc by one number while the arc was placed by
    // another is a sun that fits the frame everywhere except where it is drawn.
    const size = bodySize(cfg);
    const radius = size * 0.5;
    // How much clearance the fit keeps, in disc radii: 1 is the disc exactly
    // touching the edge, above it leaves a margin of the halo showing too.
    const at = fitToFrame(
      state.x + group.position.x, state.y,
      radius * (orbit.framePad ?? 1.25),
      view,
      Math.max(0, Math.min(1, orbit.keepInFrame ?? 1)),
    );

    // Back into the layer's own space — the group carries the drift, so the
    // child holds whatever is left of the world position after it.
    body.root.position.set(at.x - group.position.x, at.y, 0);
    // A cull, not a look: below this the whole halo is under the water line and
    // the fill covers every pixel of it. `at.y` IS the world height the body is
    // drawn at, so this and the trigger zone published below are reading one
    // number and cannot disagree about whether the sun is up.
    body.root.visible = at.y > horizonY() - size * (cfg.halo ?? 2) * 0.5;

    const zone = celestialFrame[which];
    zone.x = at.x;
    zone.y = at.y;
    zone.radius = radius;
    // Inside the sphere, which is the whole point of it: the seal has to be
    // properly in the light for it to count, not clipping the rim.
    zone.trigger = radius * Math.max(0, passCfg.radius ?? 0.7);
    zone.color = cfg.color;
    // NOT `body.root.visible`, which is the DRAW cull and asks a wider question
    // — a body whose disc has set can still have half a halo above the water,
    // and that is worth drawing. It is not worth flying through: the disc is
    // under the fill, there is nothing on screen there, and the seal swims
    // through that patch of sea constantly. So the zone is armed by the body
    // being UP, the same test dayState.above makes.
    zone.visible = at.y > horizonY();

    if (!body.root.visible) return;

    // `art` is only ever a MODEL now — flat art rides the disc itself, so the
    // quad is still the target when a .webp is in place.
    const target = body.art ?? body.disc;
    target.scale.setScalar(size * (target.userData.unitScale ?? 1));

    // A model carries its own materials and its own idea of colour; tinting it
    // from here would fight whatever it was authored with. The quad — with or
    // without art on it — is ours to light.
    if (!body.art) {
      const u = body.disc.material.uniforms;
      u.uColor.value.set(cfg.color);
      // The disc takes a much smaller share of the flare than the halo does,
      // and deliberately: the body is a painted object, and driving its own
      // brightness hard flattens the art into a white blob — the exact failure
      // the note on `moon.brightness` in config.js is about. The shine belongs
      // to the corona.
      u.uBrightness.value = cfg.brightness * (1 + shine * (CONFIG.dayNight?.pass?.flare?.discGain ?? 0.35));
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
    const flareCfg = CONFIG.dayNight?.pass?.flare ?? {};
    halo.scale.setScalar(size * (cfg.halo ?? 2)
      * (1 + 0.12 * touch + shine * (flareCfg.swell ?? 0.18)));
    const hu = halo.material.uniforms;
    hu.uColor.value.set(cfg.color);
    hu.uStrength.value = haloStrengthFor(cfg) * flare * (1 + shine * (flareCfg.haloGain ?? 1.6));
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
   *   Horizontal only. The vertical axis takes no drift, by design — see
   *   below; `view` carries the camera's height, but only so the frame fit can
   *   tell where the edges of the shot are.
   *
   * @param waveT the surface clock, so the halos dissolve into the same swell
   *   the fill clips to and the drawn line traces. Solved against a different
   *   wave, the glow slides along the water instead of meeting it.
   *
   * @param view the frame in world units — { x, y, halfW, halfH } about the
   *   frustum's own centre, at the zoom the camera ended up at. Optional: with
   *   no view the frame fit is skipped entirely, which is what lets a headless
   *   harness drive the rig without inventing a camera.
   *
   * @param dt real seconds, for the pass flare's envelope. Real rather than
   *   gameplay time on purpose — a hit-stop should not hold a flicker still.
   */
  function update(camX = 0, waveT = 0, view = null, dt = 0) {
    const cfg = CONFIG.dayNight;
    group.visible = !!cfg?.enabled;
    if (!group.visible) {
      celestialFrame.sun.visible = false;
      celestialFrame.moon.visible = false;
      return;
    }

    // DRIFT, done as a plain counter-offset because an ORTHOGRAPHIC camera
    // gets no parallax for free — there is no perspective divide, so a sun at
    // z=-40 and a sun at z=-5 pan at exactly the same rate. Sitting the layer
    // at camPos * (1 - drift) means a camera move of D slides the body D *
    // drift across the FRAME: at 0.04 a full-width crossing of the ocean moves
    // the sun under two units on a ninety-unit frame, which is the point —
    // something genuinely far away does not slide behind the foreground, it
    // hangs there. Turn it up toward 1 and the sky sits in the world like a
    // rock on the seabed.
    //
    // X ONLY. The vertical axis gets no drift at all, and that is not a
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
    // what pans them across the frame. The one exception is the frame fit in
    // fitToFrame above, which may lower a body only while the water line is
    // already off the top of the shot — see the note there for why that is the
    // one case where nobody can tell.
    //
    // Independent of zoom, and deliberately so: zoom scales the whole frustum
    // about the camera, and both the offset and everything it is measured
    // against scale with it, so the ratio survives a push-in untouched.
    //
    // `drift` REPLACED `parallax`, which is still in every saved tuning
    // snapshot at its old 0.15. A field already in imported-tuning.json cannot
    // be re-defaulted from here — the snapshot wins the merge — so the only way
    // to actually deliver a quieter sky was a name the snapshot has never heard
    // of. The old value is read as the fallback so nothing breaks; it is simply
    // no longer what the tuner writes.
    const orbit = cfg.orbit;
    const keep = 1 - Math.max(0, Math.min(1, orbit.drift ?? orbit.parallax ?? 1));
    group.position.set(camX * keep, 0, orbit.depth ?? Z);

    updateBody(bodies.sun, 'sun', dayState.sun, cfg.sun, waveT, view, dt);
    updateBody(bodies.moon, 'moon', dayState.moon, cfg.moon, waveT, view, dt);
  }

  return { update, group };
}
