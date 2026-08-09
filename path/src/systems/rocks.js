import * as THREE from 'three';
import { ImprovedNoise } from 'three/examples/jsm/math/ImprovedNoise.js';

// ---------------------------------------------------------------------------
// Procedural rocks — the 3D element behind the basic shot's ammo and the
// pickups (chum bits, strike and rapid-fire orbs).
//
// Each one is an icosphere whose vertices are pushed along their own normal by
// 3D Perlin noise (fBm over a few octaves), then squashed onto a per-variant
// ellipsoid so no two silhouettes match. The displacement is a function of the
// vertex DIRECTION only, which is what lets this run on the raw
// IcosahedronGeometry: PolyhedronGeometry is non-indexed, so every triangle
// carries its own copy of each shared corner, and identical positions displace
// identically without having to weld the geometry first.
//
// Shading is baked into vertex colours rather than left to the scene lights.
// These assets are all `unlit: true` (MeshBasicMaterial) so that the bloom
// bright-pass can see their colour driven past 1.0 — that's how the tuner's
// glow slider works on them at all (see applyColorAndGlow in assets.js). An
// unlit rock is a flat silhouette with no facets visible whatsoever, so the
// facet shading is precomputed here as a GREYSCALE multiplier. three
// multiplies vertex colour into the material colour, so the tuner's tint and
// glow stay in sole charge of the hue and this only darkens the faces turned
// away from an imagined key light.
//
// The trade-off of baking: the shading tumbles with the rock instead of
// staying put, so the key light reads as attached to the object. At these
// sizes and speeds it registers as facets catching the light rather than as a
// lighting error, and it's the only way to get form onto an unlit mesh without
// giving up the glow pipeline these assets are built around.
// ---------------------------------------------------------------------------

const noise = new ImprovedNoise();

// Upper-left and slightly toward the camera. The game plays in the XY plane
// looking down -Z, so this puts the lit side up where a rock's lit side goes.
const LIGHT = new THREE.Vector3(-0.35, 0.78, 0.52).normalize();

const _v = new THREE.Vector3();
const _c = new THREE.Vector3();

// Deterministic per-variant RNG. Variant 3 has to be the same rock on every
// reload — a pool that reshuffles each load makes the look impossible to tune.
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fbm(x, y, z, octaves, lacunarity, gain) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise.noise(x * freq, y * freq, z * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

// One greyscale value per triangle, written to all three of its corners.
// Reads the first corner's normal, which after computeVertexNormals() on
// non-indexed geometry is the flat face normal.
//
// `floor` is the multiplier the darkest facet gets; lambert lerps from there
// up to 1. See shadingFloor for why it isn't simply 1 - shade.
function bakeFacetShading(geo, floor, grit) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const colors = new Float32Array(pos.count * 3);

  for (let i = 0; i < pos.count; i += 3) {
    _v.fromBufferAttribute(nrm, i);
    const lambert = Math.max(0, _v.dot(LIGHT));
    let v = floor + (1 - floor) * lambert;

    if (grit) {
      // A second, much finer noise sample at the face centroid, so neighbouring
      // facets at the same angle to the light still differ slightly.
      _c.set(0, 0, 0);
      for (let k = 0; k < 3; k++) _c.add(_v.fromBufferAttribute(pos, i + k));
      _c.multiplyScalar(1 / 3);
      v *= 1 + grit * noise.noise(_c.x * 9.1 + 31.7, _c.y * 9.1 + 17.3, _c.z * 9.1 + 53.9);
    }

    v = Math.max(0, v);
    for (let k = 0; k < 3; k++) {
      colors[(i + k) * 3] = v;
      colors[(i + k) * 3 + 1] = v;
      colors[(i + k) * 3 + 2] = v;
    }
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// How dark the darkest facet is allowed to go, as a plain multiplier.
//
// `shade` alone is not enough, because glow on an unlit asset is applied by
// multiplying the material colour past 1.0 (applyColorAndGlow in assets.js)
// and the composite target is LDR — post.js does no tonemapping, so anything
// at or above 1.0 clamps to flat white. At the bullet's tuned glow of ~5, a
// shading range of 0.45..1.0 comes out as 2.2..5.0: every facet clips, the
// whole rock is one white blob, and the geometry may as well be a sphere.
//
// So the floor is pinned relative to the glow instead: the darkest facet lands
// at `headroom` in final output no matter how hard the asset is glowing, which
// keeps it below the clamp and leaves it as visible coloured shadow against a
// white-hot lit side. Unglowed assets (glow 1) are untouched by this and just
// use `shade`, since 1 - shade is already the smaller number.
function shadingFloor(shade, glow, headroom) {
  return Math.min(1 - shade, headroom / Math.max(1, glow));
}

// `radius` is the MEAN radius — noise pushes each vertex either side of it, so
// a rock swapped in for a sphere of the same radius reads at the same size.
// `detail` is icosphere subdivision: 0 = 20 faces, 1 = 80, 2 = 320. 1 is the
// sweet spot for something this small; 2 starts costing more than it shows.
export function createRockGeometry({
  radius = 0.3,
  detail = 1,
  seed = 0,
  frequency = 2.2,
  amplitude = 0.4,
  octaves = 3,
  lacunarity = 2.1,
  gain = 0.5,
  squash = 0.3,
  shade = 0.55,
  grit = 0.08,
  glow = 1,
  glowHeadroom = 0.55,
} = {}) {
  const rand = mulberry32(seed | 0);

  // Perlin noise is exactly zero at every integer lattice point, so an offset
  // landing on integers would hand back a suspiciously smooth ball. Park each
  // variant at its own fractional corner of the field.
  const ox = rand() * 100 + 0.5;
  const oy = rand() * 100 + 0.5;
  const oz = rand() * 100 + 0.5;

  // Per-variant ellipsoid. Rocks are rarely round, and without this the pool
  // reads as one shape seen from six angles rather than as six shapes.
  const ax = 1 + (rand() * 2 - 1) * squash;
  const ay = 1 + (rand() * 2 - 1) * squash;
  const az = 1 + (rand() * 2 - 1) * squash;

  const geo = new THREE.IcosahedronGeometry(1, Math.max(0, Math.round(detail)));
  const pos = geo.attributes.position;

  for (let i = 0; i < pos.count; i++) {
    _v.fromBufferAttribute(pos, i).normalize();
    const n = fbm(
      _v.x * frequency + ox,
      _v.y * frequency + oy,
      _v.z * frequency + oz,
      Math.max(1, Math.round(octaves)), lacunarity, gain,
    );
    const r = radius * (1 + amplitude * n);
    pos.setXYZ(i, _v.x * r * ax, _v.y * r * ay, _v.z * r * az);
  }
  pos.needsUpdate = true;

  // Non-indexed input means this yields one flat normal per face. The faceted
  // read is the point, not a compromise.
  geo.computeVertexNormals();
  bakeFacetShading(geo, shadingFloor(shade, glow, glowHeadroom), grit);
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------------------
// Tumbling
//
// A rock that doesn't turn is a blob. Every rock gets a random resting
// orientation (so a volley of the same variant doesn't leave the flipper with
// the same face forward) and a spin about one arbitrary fixed axis. A fixed
// axis rather than per-frame Euler wobble because it's what a thrown rock
// actually does, and because rotateOnAxis composes onto the quaternion without
// the gimbal artefacts of accumulating three Euler angles.
// ---------------------------------------------------------------------------

export function startTumble(mesh, speed, variance = 0.5) {
  mesh.quaternion.random();
  if (!speed) return;

  // Uniform point on the sphere, so no axis is favoured.
  const z = Math.random() * 2 - 1;
  const t = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const axis = new THREE.Vector3(r * Math.cos(t), r * Math.sin(t), z);

  const jitter = 1 - variance + Math.random() * variance * 2;
  const rate = speed * jitter * (Math.random() < 0.5 ? -1 : 1);
  mesh.userData.tumble = { axis, rate };
}

// No-op on anything that isn't a tumbling rock, so callers can hand it any
// mesh — a bullet whose asset was swapped for an uploaded model just doesn't
// tumble, instead of needing a check at every call site.
export function updateTumble(mesh, dt) {
  const t = mesh?.userData?.tumble;
  if (t) mesh.rotateOnAxis(t.axis, t.rate * dt);
}
