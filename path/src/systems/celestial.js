import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CONFIG } from '../config.js';
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
// Below the water line they are CLIPPED, not faded — a real clipping plane at
// the horizon, so the disc is cut by a straight edge exactly where the water
// starts and the halo is cut with it. That's what a setting sun does, and it
// means the halo can be as wide as you like without lighting up the sea from
// underneath once the body has gone down.

const Z = -5.5; // in front of the sky plane (-6), behind everything else

// ---------------------------------------------------------------------------
// The placeholder disc. A soft-edged circle on a unit quad — the same quad a
// .webp would land on, so swapping art in changes the material and nothing
// else about the rig.
// ---------------------------------------------------------------------------
const discVertex = /* glsl */ `
  varying vec2 vUv;
  #include <clipping_planes_pars_vertex>

  void main() {
    vUv = uv;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <clipping_planes_vertex>
  }
`;

// One shader for both the placeholder and flat art — a .webp is the same quad
// with uUseMap turned on. Worth keeping them on one material rather than
// swapping in a MeshBasicMaterial: the disc keeps its circular mask, its
// tint and its >1 brightness (which is what pushes it past the bloom
// threshold), so swapping the art in doesn't quietly change how it lights.
const discFragment = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uUseMap;
  uniform float uMask;
  uniform float uLimb;
  uniform vec3 uColor;
  uniform float uBrightness;
  uniform float uEdge;
  varying vec2 vUv;
  #include <clipping_planes_pars_fragment>

  void main() {
    #include <clipping_planes_fragment>
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
// ---------------------------------------------------------------------------
const haloFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uStrength;
  varying vec2 vUv;
  #include <clipping_planes_pars_fragment>

  void main() {
    #include <clipping_planes_fragment>
    float d = length(vUv * 2.0 - 1.0);
    float r = max(0.0, 1.0 - d);
    float a = pow(r, 2.6) * 0.65 + pow(r, 9.0) * 0.35;
    gl_FragColor = vec4(uColor * a * uStrength, 1.0);
  }
`;

// A single white pixel, shared by both discs, so the shader can sample
// unconditionally whether or not art has been dropped in.
function makeWhitePixel() {
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

function makeDiscMaterial(plane, white) {
  return new THREE.ShaderMaterial({
    vertexShader: discVertex,
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
    // ShaderMaterial opts INTO clipping — without this three never hands the
    // shader its clippingPlanes uniform and the includes above compile to
    // nothing.
    clipping: true,
    clippingPlanes: [plane],
  });
}

function makeHaloMaterial(plane) {
  return new THREE.ShaderMaterial({
    vertexShader: discVertex,
    fragmentShader: haloFragment,
    uniforms: {
      uColor: { value: new THREE.Color(0xffffff) },
      uStrength: { value: 0.5 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    clipping: true,
    clippingPlanes: [plane],
  });
}

export function createCelestials(scene) {
  // One plane, shared by every material here. Normal +Y with constant
  // -horizonY keeps the half-space above the water line; the constant is
  // rewritten each frame so a resize (which moves the water line) can't leave
  // the clip and the orbit disagreeing.
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  const group = new THREE.Group();
  group.position.z = Z;
  scene.add(group);

  const quad = new THREE.PlaneGeometry(1, 1);
  const loader = new GLTFLoader();
  const textures = new THREE.TextureLoader();
  const white = makeWhitePixel();

  function makeBody() {
    const root = new THREE.Group();

    const halo = new THREE.Mesh(quad, makeHaloMaterial(plane));
    halo.position.z = -0.1;
    // Negative, and below every other transparent thing in the game (outline
    // shells sit at -1, particles at 10): these are BACKDROP. renderOrder is
    // compared before depth in the transparent sort, so a positive value here
    // would draw the sun over the creatures in front of it.
    halo.renderOrder = -12;

    const disc = new THREE.Mesh(quad, makeDiscMaterial(plane, white));
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

  // Everything a loaded model brings with it has to be clipped too, or a .glb
  // sun keeps shining out of the seabed.
  function clipAll(object) {
    object.traverse((o) => {
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) {
        m.clippingPlanes = [plane];
        m.clipShadows = false;
        m.needsUpdate = true;
      }
    });
  }

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
        const pivot = unitPivot(gltf.scene);
        clipAll(pivot);
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

  function updateBody(body, state, cfg) {
    loadArt(body, cfg);

    // Bigger and brighter the moment the disc straddles the water line. The
    // size bump is small on purpose — the flare should read as light, not as
    // the sun growing on the way down.
    const touch = state.horizonMix;
    const flare = 1 + (cfg.horizonGlow ?? 0) * touch;

    body.root.position.set(state.x, state.y, 0);
    // state.y IS the world height: the layer carries no vertical offset (see
    // update), so this test and the world-space clipping plane are looking at
    // the same number and cannot disagree.
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
    }

    const halo = body.halo;
    halo.scale.setScalar(cfg.size * (cfg.halo ?? 2) * (1 + 0.12 * touch));
    halo.material.uniforms.uColor.value.set(cfg.color);
    halo.material.uniforms.uStrength.value = (cfg.haloStrength ?? 0.5) * flare;
  }

  /**
   * @param camX where the camera has been FRAMED this frame — its position
   *   before any shake is added on top. Handed in rather than read off the
   *   camera on purpose: shake is a per-frame random offset applied after the
   *   framing, and parallaxing against it would counter-shake the sky, so the
   *   sun would visibly buzz through every explosion.
   *
   *   Horizontal only. There is no camY, by design — see below.
   */
  function update(camX = 0) {
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
    // horizon this sky is measured against does not move. horizonY() is the
    // water line in WORLD space and the clipping plane is pinned to it, so
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

    plane.constant = -horizonY();
    updateBody(bodies.sun, dayState.sun, cfg.sun);
    updateBody(bodies.moon, dayState.moon, cfg.moon);
  }

  return { update, group, horizonPlane: plane };
}
