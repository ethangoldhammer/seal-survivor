import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';
import { weatherState } from './weather.js';
import { skyLight } from './daylight.js';

// CLOUDS — a stack of noise bands at different distances, which is where the
// sky gets its depth from.
//
// This was one quad: a two-octave noise field over the air band that darkened
// as a storm built. It is now N of them (CONFIG.weather.clouds.layers), and the
// three things that changed are the whole point:
//
//   THEY SIT AT DIFFERENT DISTANCES. Each layer has its own `drift` — the same
//     number the sun and moon ride (see systems/celestial.js), meaning how far
//     it slides across the FRAME per unit of camera motion. The sky is at 0.04
//     and the ocean in front of you is at 1, and a cloud deck at 0.2 and
//     another at 0.6 are what put anything BETWEEN those two. One flat layer
//     welded to the world, which is what this was, is a painted backdrop; four
//     moving at different rates is a sky you are underneath.
//
//   THEY ARE LIT BY THE SKY. Each layer mixes toward skyLight.horizon by its
//     own `skyTint`, so the deck goes orange at sunset and near-black at
//     midnight without a single keyframe of its own. A fixed dark blue was
//     legible as weather and nothing else.
//
//   THEY HAVE NO EDGES. The old quad spanned exactly the frame's air band and
//     faded only at the BOTTOM, so its top edge was a dead straight horizontal
//     line across the sky at y = frameTop — invisible while the camera sits
//     still and perfectly obvious the moment a breach lifts it into view. Every
//     layer now fades in AND out across its band (`feather`), and the quad is
//     built taller than the band it paints so the window reaches zero well
//     inside the geometry. Nothing here has an edge that is a straight line.
//
// It still reads the same two weather numbers (weatherState.intensity and
// .wind) and still costs nothing when the sky is clear: a layer whose cover
// rounds to zero is switched off rather than drawn empty.

const Z = -5.2; // in front of the sun and moon, behind everything in the water

const vertexShader = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uCoverage;
  uniform float uSoftness;
  uniform vec2 uOffset;
  uniform vec2 uSpan;   // world units the quad covers, so noise stays square
  uniform float uScale;
  uniform float uFeather; // fraction of the band that is fade, at EACH end

  varying vec2 vUv;

  float hash21(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }

  // Value noise — smoothstepped bilinear interpolation between cell corners.
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  void main() {
    // Two octaves. Three would be prettier; the second octave scrolls faster
    // than the first, which is the cheapest way to stop the field reading as
    // one sheet sliding past.
    vec2 p = vUv * uSpan * uScale;
    float n = noise(p + uOffset) * 0.65
            + noise(p * 2.3 + uOffset * 1.7 + 11.3) * 0.35;

    // uCoverage is a threshold on that field: low and only the peaks survive
    // as wisps, high and the whole sky closes over.
    float cover = smoothstep(1.0 - uCoverage - uSoftness, 1.0 - uCoverage + uSoftness, n);

    // THE BAND, faded in at the bottom and out at the top. Both ends, and that
    // is the fix: a deck that simply stopped at the top of its quad drew a
    // straight horizontal line across the sky wherever the geometry ended.
    // Cloud is at an altitude; it should thin out into clear air above it
    // exactly as it thins out toward the horizon below.
    //
    // Anchored to the quad's own edges (0 and 1) rather than to a band inside
    // it, so the alpha is zero AT the geometry by construction — there is no
    // arrangement of the numbers that can leave a visible value on the edge.
    float lo = smoothstep(0.0, uFeather, vUv.y);
    float hi = 1.0 - smoothstep(1.0 - uFeather, 1.0, vUv.y);
    cover *= lo * hi;

    float a = cover * uOpacity;
    if (a <= 0.002) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

// A layer's value for one field: its own if it has one, otherwise the shared
// default at the top of CONFIG.weather.clouds. Written this way so the flat
// keys that were there before layers existed still mean what they meant — the
// tuned coverage and softness in a saved snapshot are the look every layer
// starts from, and a layer overrides only what makes it that layer.
function pick(layer, cfg, key, fallback) {
  return layer[key] ?? cfg[key] ?? fallback;
}

export function createClouds(scene) {
  const layers = []; // { mesh, material, offset }
  const geometry = new THREE.PlaneGeometry(1, 1);
  const tint = new THREE.Color();

  function makeLayer(index) {
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uColor: { value: new THREE.Color(0x0a1220) },
        uOpacity: { value: 0 },
        uCoverage: { value: 0.4 },
        uSoftness: { value: 0.35 },
        uOffset: { value: new THREE.Vector2(0, 0) },
        uSpan: { value: new THREE.Vector2(80, 20) },
        uScale: { value: 0.055 },
        uFeather: { value: 0.3 },
      },
      transparent: true,
      depthWrite: false,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.z = Z;
    mesh.frustumCulled = false;
    // Between the celestial bodies (-12 and -11) and everything in the water
    // (0 and up), in FAR-TO-NEAR order so the near decks draw over the distant
    // ones. renderOrder decides this rather than z: every layer sits on the
    // same plane, because depth in an orthographic camera buys nothing and the
    // sort is what actually orders transparent draws.
    mesh.renderOrder = -10.5 + index * 0.1;
    scene.add(mesh);
    return { mesh, material, offset: new THREE.Vector2(0, 0) };
  }

  // Built to match the config, and REBUILT if the config's layer count changes
  // — a layer added or removed in the tuner should appear without a reload,
  // and a stale mesh left behind would be a deck nothing can ever switch off.
  function ensureLayers(n) {
    while (layers.length < n) layers.push(makeLayer(layers.length));
    while (layers.length > n) {
      const dead = layers.pop();
      scene.remove(dead.mesh);
      dead.material.dispose();
    }
  }

  /**
   * @param dt   seconds, for the wind scroll.
   * @param camX where the camera was FRAMED this frame — the same banked
   *   anchor the sun and moon parallax against, never camera.position, which
   *   by this point in the frame also carries the shake. A deck that
   *   parallaxed against the shake would counter-shake the sky.
   */
  function update(dt, camX = 0) {
    const cfg = CONFIG.weather?.clouds;
    const on = CONFIG.weather?.enabled && cfg?.enabled;
    const defs = (on && Array.isArray(cfg.layers) && cfg.layers.length) ? cfg.layers : null;
    if (!defs) {
      ensureLayers(0);
      return;
    }
    ensureLayers(defs.length);

    const storm = weatherState.intensity ?? 0;
    const wind = weatherState.wind ?? 0;
    // The visible sky, which is what every layer's `y` and `height` are
    // fractions of. The FRAME's air band, not the arena's: the ceiling is three
    // times the visible sky (arena.airScale) and a deck authored against it
    // would sit mostly where the camera never goes.
    const airH = Math.max(1, bounds.frameTop - bounds.surfaceY);
    const w = bounds.width * 1.2;

    for (let i = 0; i < defs.length; i++) {
      const def = defs[i] ?? {};
      const { mesh, material, offset } = layers[i];

      // How much of this deck is there right now: what it carries on a clear
      // day, plus whatever share of the storm it takes. Folded in here rather
      // than in the shader so a layer at zero genuinely costs nothing.
      const base = def.base ?? cfg.base ?? 0;
      const cover = base + (1 - base) * storm * (def.storm ?? 1);
      mesh.visible = cover > 0.002;
      if (!mesh.visible) continue;

      // WHERE IT IS, side to side. Same arithmetic as the celestial layer: a
      // quad sitting at camX * (1 - drift) slides across the frame at exactly
      // `drift` per unit of camera motion. The noise is welded to the QUAD (it
      // is sampled from the uvs), which is what makes that the layer's apparent
      // speed rather than the pattern's.
      const drift = Math.max(0, Math.min(1, def.drift ?? 0));
      // ...and nothing in Y, for the reason the sun takes none: the horizon
      // this is measured against does not move, so a vertical offset slides
      // the whole deck up and down past a fixed water line every time the seal
      // dives. See the note in systems/celestial.js.
      const centre = bounds.surfaceY + (def.y ?? 0.5) * airH;
      // The deck's whole thickness, fades included: the quad IS the band, and
      // the alpha ramps to zero at both of its edges (see uFeather in the
      // shader). Nothing is cropped by the geometry, so `height` reads as the
      // altitude range the cloud occupies rather than as a plane it sits on.
      const h = Math.max(0.05, def.height ?? 0.6) * airH;
      // Half at most: past that the two ramps meet and the deck never reaches
      // full strength anywhere, which is a legitimate look (a thin veil) but
      // must not happen by accident from a number over 0.5.
      const feather = Math.max(0.02, Math.min(0.5, def.feather ?? 0.35));

      mesh.scale.set(w, h, 1);
      mesh.position.set(camX * (1 - drift), centre, Z);

      // Scrolls with the wind, faster the nearer it is, and drifts slowly on
      // its own regardless so a dead calm still has weather moving in it.
      const scale = pick(def, cfg, 'scale', 0.055);
      const speed = def.speed ?? 1;
      offset.x += wind * (cfg.drift ?? 3) * scale * speed * dt;
      offset.y += 0.04 * scale * dt;

      // Lit by the sky rather than by a colour of its own: at `skyTint` 1 the
      // deck IS the horizon's colour, which is what makes it catch the sunset
      // and go properly black at midnight. The layer's own colour is what it
      // brings to that — the storm haze keeps most of its own, the high wisps
      // almost none.
      tint.set(pick(def, cfg, 'color', 0x0a1220));
      if (CONFIG.dayNight?.enabled) tint.lerp(skyLight.horizon, def.skyTint ?? 0);

      const u = material.uniforms;
      u.uSpan.value.set(w, h);
      u.uScale.value = scale;
      u.uOffset.value.copy(offset);
      u.uColor.value.copy(tint);
      u.uOpacity.value = pick(def, cfg, 'opacity', 0.6) * cover;
      u.uCoverage.value = pick(def, cfg, 'coverage', 0.42);
      u.uSoftness.value = Math.max(0.02, pick(def, cfg, 'softness', 0.35));
      u.uFeather.value = feather;
    }
  }

  // Built NOW rather than on the first frame of play. The decks are created by
  // update() (there is one material per layer and the count comes from config),
  // and systems/shaderWarmup.js warms the pipeline by drawing the real scene
  // once behind the loading screen — so a stack that did not exist yet would
  // compile its program on the first frame the player actually sees. One frame
  // at zero dt costs nothing and puts the meshes where the warm-up can find
  // them; the bounds it sizes them against are re-read every frame anyway.
  update(0, 0);

  return { update, layers };
}
