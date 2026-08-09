import * as THREE from 'three';

// How a solid object leaves the screen: eaten away by an organic noise field,
// never scaled down. A box shrinking toward nothing reads as it retreating
// into the distance and fights whatever tumble it had; holes opening across it
// reads as it going.
//
// The same family of noise the menus reveal through (see ui/dither.js's
// "organic field") — the project has one algorithm for "this surface is going
// away", and this is the 3D end of it. Cheap value noise rather than the
// gradient noise in systems/noiseShader.js: the threshold here is binary, so
// the blockiness that rules value noise out for shading is exactly what gives
// the dissolve its grain.
//
// Used by the boat wreckage (systems/boatDebris.js) and by the crew
// (systems/crew.js).

const GLSL_DISSOLVE = `
uniform float uDissolve;
uniform float uDissolveScale;
varying vec3 vDissolvePos;

float dissolveHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float dissolveNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(dissolveHash(i + vec3(0.0, 0.0, 0.0)), dissolveHash(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(dissolveHash(i + vec3(0.0, 1.0, 0.0)), dissolveHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(dissolveHash(i + vec3(0.0, 0.0, 1.0)), dissolveHash(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(dissolveHash(i + vec3(0.0, 1.0, 1.0)), dissolveHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
`;

// One knob per thing that dissolves. `cells` is the grain measured in noise
// cells ACROSS THE OBJECT rather than in world units, because a trawler's
// chunk is twice a rowboat's and a fixed world frequency would give the two
// visibly different dissolves.
export function dissolveUniforms(objectSize, cells = 6) {
  return {
    uDissolve: { value: 0 },
    uDissolveScale: { value: cells / Math.max(objectSize, 1e-3) },
  };
}

// Adds the dissolve to a material without disturbing what it already does —
// an outline shell arrives with an onBeforeCompile of its own (the rim push),
// and it has to keep running.
//
// `tag` pins three.js's program cache key. Every wreck and every body builds
// its own materials (they must: a dissolve written to a shared material takes
// everything wearing it), and three keys compiled programs by, among other
// things, the SOURCE of onBeforeCompile — which is identical for all of these.
// A constant tag means the second object reuses the first's program instead of
// compiling one, and that two materials wearing this same wrapper for
// different purposes (a body and its rim, both MeshBasicMaterial) can never be
// handed each other's shader.
export function attachDissolve(material, uniforms, tag) {
  const previous = material.onBeforeCompile;
  material.customProgramCacheKey = () => tag;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDissolvePos;')
      // After <begin_vertex> — and, on a shell, after the rim push that
      // follows it, so the body and its outline sample the same point and
      // dissolve as one object rather than as a box inside a cage.
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvDissolvePos = transformed;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL_DISSOLVE)
      // First thing in main(), so a discarded fragment costs nothing else.
      .replace(
        '#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\n\tif (uDissolve > 0.0 && dissolveNoise(vDissolvePos * uDissolveScale) < uDissolve) discard;'
      );
  };
  return material;
}

// A box with SPHERICAL normals, which is what the debris and the crew are both
// built out of. The rim is an inverted hull pushed along the normal, and a
// cube's per-face normals push its six faces apart into six floating slabs
// with daylight at every edge. Normals that radiate from the centre push the
// shell outward as one skin.
export function roundedNormalBox(w, h, d) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const pos = geo.attributes.position;
  const normal = geo.attributes.normal;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    normal.setXYZ(i, v.x, v.y, v.z);
  }
  normal.needsUpdate = true;
  return geo;
}
