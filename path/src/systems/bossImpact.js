import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { shapeLocalToWorld, worldToShapeLocal } from './hitShape.js';

// ---------------------------------------------------------------------------
// HITTING SOMETHING BIG
//
// Two effects that answer two different questions, which is why neither one
// does both jobs and why they are in the same file.
//
//   THE BREAK    fires per hit, at the point on the skin the shot actually
//                reached. A hard-edged ring and a spray of shards thrown along
//                the surface normal, gone in a fifth of a second. Geometric on
//                purpose: the arena is full of soft additive light already
//                (bloom, bioluminescence, the water) and one more soft glow
//                per pellet is a smear. A crisp edge is the only thing that
//                still reads at the moment a boss fills a third of the screen.
//                This is the "did I connect" channel.
//
//   THE WOUND    sticks. Anchored in the BONE SPACE of the sphere it landed on
//                (systems/hitShape.js), so it rides the animal through every
//                tail-beat and every turn instead of sliding off it. A dark
//                wet puncture that opens fast and closes over a couple of
//                seconds, rimmed with light that bleeds outward along the
//                body. Twenty of them accumulate, so a boss you have been
//                chewing on visibly looks chewed on. This is the "how is this
//                fight going" channel, and it is the only readout of that in
//                the game that is on the creature rather than on the HUD.
//
// BOTH ARE ONE DRAW CALL EACH. A boss fight with multishot is thirty impacts a
// second and a mesh per impact is the churn the visual pool exists to avoid.
// Each is a single InstancedMesh with per-instance attributes and a shader
// that ages the instance from one uniform clock, so a burst costs an attribute
// write and nothing else.
//
// TUNING lives in CONFIG.bossImpact. Nothing here is a gameplay number — no
// damage, no radius that anything is tested against, no rate. It is entirely
// what the hit looks like, which is exactly what belongs in the tuner.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THE BREAK — rings and shards
// ---------------------------------------------------------------------------

// One quad per shard, aged on the GPU. `aSeed` is what stops a burst reading
// as a rosette: every instance takes its spin, its length and its exact death
// from the same number, so eight shards from one impact are eight shards and
// not one shard drawn eight times.
const shardVert = /* glsl */ `
  attribute vec3 aOrigin;   // where on the skin it started
  attribute vec3 aVel;      // direction and speed, arena units/sec
  attribute vec4 aLife;     // x born, y lifespan, z length, w width
  attribute vec3 aTint;
  attribute float aSeed;

  uniform float uTime;
  uniform float uDrag;

  varying float vAge;
  varying vec3 vTint;
  varying vec2 vUv;
  varying float vSeed;

  void main() {
    float age = (uTime - aLife.x) / aLife.y;
    vAge = age;
    vTint = aTint;
    vUv = uv;
    vSeed = aSeed;
    if (age < 0.0 || age > 1.0) {
      // Retired instances are collapsed to a degenerate point rather than
      // culled on the CPU. The pool is a ring buffer; a dead slot has to cost
      // nothing and, above all, must not draw last frame's shard.
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    float t = age * aLife.y;
    // Water, not vacuum. An exponential slowdown is what makes a chip of
    // something read as being thrown THROUGH a medium instead of flung in a
    // straight line, and it is the one physical thing in this effect.
    float travel = (1.0 - exp(-uDrag * t)) / uDrag;
    vec3 centre = aOrigin + aVel * travel;

    // Aligned to its own flight, so a shard is a streak along the direction it
    // is going rather than a rotating sprite.
    vec2 dir = normalize(aVel.xy + vec2(1e-5, 0.0));
    vec2 side = vec2(-dir.y, dir.x);

    // It stretches as it leaves and snaps shut as it dies — the shape of a
    // spark, and the reason this reads as brittle rather than as a puff.
    float stretch = aLife.z * (0.35 + 1.65 * pow(1.0 - age, 0.45));
    float width = aLife.w * pow(1.0 - age, 1.6);

    vec3 offset = vec3(dir * (position.x * stretch) + side * (position.y * width), 0.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(centre + offset, 1.0);
  }
`;

// NO GRADIENT. Every other impact in this project fades to nothing at its own
// edge; this one has a hard boundary and steps down in two bands, which is the
// whole difference between a spark and a shard.
const shardFrag = /* glsl */ `
  precision highp float;
  uniform float uGlow;
  uniform float uSplit;
  varying float vAge;
  varying vec3 vTint;
  varying vec2 vUv;
  varying float vSeed;

  void main() {
    if (vAge < 0.0 || vAge > 1.0) discard;

    // Chisel the quad into a wedge: full width at the leading edge, a point at
    // the trailing one. Done in the fragment rather than in the geometry so
    // every shard can carry its own taper from its seed.
    float taper = mix(0.35, 1.0, 1.0 - vUv.x);
    if (abs(vUv.y - 0.5) * 2.0 > taper) discard;

    // Two flat bands and nothing between them. uSplit is where the hot core
    // ends, and stepping (rather than smoothstepping) is what keeps the edge.
    float core = step(abs(vUv.y - 0.5) * 2.0, taper * uSplit);
    vec3 col = mix(vTint, vec3(1.0), core * (1.0 - vAge * 0.7));

    // Dies in steps too — five of them, so it flickers out instead of dimming.
    // At this size and lifespan the eye reads a smooth fade as motion blur and
    // a stepped one as something breaking.
    float a = 1.0 - vAge;
    a = ceil(a * 5.0) / 5.0;

    gl_FragColor = vec4(col * uGlow * a, a);
  }
`;

// The ring. A perfect circle with a hard inner and outer edge, expanding on a
// curve that is almost entirely over in the first three frames — the shock
// arriving, not a bubble inflating.
const ringVert = /* glsl */ `
  attribute vec3 aOrigin;
  attribute vec4 aLife;   // x born, y lifespan, z radius, w tilt
  attribute vec3 aTint;
  uniform float uTime;
  varying float vAge;
  varying vec2 vUv;
  varying vec3 vTint;
  varying float vTilt;

  void main() {
    float age = (uTime - aLife.x) / aLife.y;
    vAge = age;
    vUv = uv;
    vTint = aTint;
    vTilt = aLife.w;
    if (age < 0.0 || age > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    float grow = 1.0 - pow(1.0 - age, 3.0);
    float r = aLife.z * (0.12 + 0.88 * grow);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(aOrigin + vec3(position.xy * r, 0.0), 1.0);
  }
`;

const ringFrag = /* glsl */ `
  precision highp float;
  uniform float uGlow;
  uniform float uThickness;
  varying float vAge;
  varying vec2 vUv;
  varying vec3 vTint;
  varying float vTilt;

  void main() {
    if (vAge < 0.0 || vAge > 1.0) discard;
    vec2 p = (vUv - 0.5) * 2.0;
    // Squashed ACROSS the impact normal, so the ring reads as a shell leaving
    // a surface rather than as a hoop lying on the screen. vTilt is how much
    // — a square-on hit is nearly round, a graze is nearly a line.
    p.y /= max(0.15, vTilt);
    float d = length(p);

    // A band, not a disc. Both edges hard: the outer one is the shock front
    // and the inner one is what makes it a ring at all.
    float w = uThickness * (0.35 + 0.65 * (1.0 - vAge));
    float band = step(1.0 - w, d) * step(d, 1.0);
    if (band < 0.5) discard;

    // Hot at the front edge, the hit's own colour behind it.
    float lead = smoothstep(1.0 - w, 1.0, d);
    vec3 col = mix(vTint, vec3(1.0), lead * (1.0 - vAge));
    float a = (1.0 - vAge) * (1.0 - vAge);
    gl_FragColor = vec4(col * uGlow * a, a);
  }
`;

// ---------------------------------------------------------------------------
// THE SMEAR — a little of the animal, let go into the water
// ---------------------------------------------------------------------------
//
// Positioned on the CPU (its anchor is a bone-space point that has to be run
// through a live matrix every frame) and shaped on the GPU. The split is
// deliberate: there are at most a couple of dozen of these and the matrix is
// the cheap half, while the thing that makes them read — an edge eaten by
// noise so no two are the same shape — is per-pixel work.
//
// THIS WAS A WOUND, and the wound was the wrong idea. It was a dark hole with a
// pulsing rim that opened in four frames, then sat at the same size, in the
// same place, for two and a half seconds. Every one of those is a decal
// property rather than a fluid one, and together they read as a sticker on the
// model: hard-edged, unchanging, and — with a rim around a dark middle —
// obviously a shape somebody drew. Five of them at once looked like texture.
//
// What replaced it is the same anchor and nothing else of the old design:
//
//   NO RIM, NO HOLE   one soft blob, brightest in the middle, falling off to
//                     nothing. The ring structure was most of the artifice.
//   NO HARD EDGE      the old one cut itself out with `discard` at a noise
//                     radius, which is a cookie cutter however ragged you make
//                     the cutter. This fades all the way out.
//   IT MOVES          it spreads and thins for its whole life and drifts a
//                     little off the skin. A mark that holds its size and then
//                     switches off is the single most decal-like thing it can
//                     do — dispersing is what says "in water".
//   IT IS SHORT       about half a second, against two and a half. Long enough
//                     to register on the hit, gone before it can accumulate.
//   IT IS NOT ROUND   stretched along the direction the hit travelled across
//                     the surface, so it is a smear rather than a splat.

const woundVert = /* glsl */ `
  attribute vec3 aOrigin;
  attribute vec4 aLife;   // x born, y lifespan, z size, w seed
  attribute vec3 aTint;
  // The direction the hit travelled ACROSS the surface, unit length. The long
  // axis of the smear, and the reason none of these is a circle.
  attribute vec2 aSmear;
  uniform float uTime;
  uniform float uSpread;   // how much bigger it gets across its life
  uniform float uStretch;  // long axis against short
  uniform float uDrift;    // how far it lifts off the skin as it goes
  varying float vAge;
  varying vec2 vUv;
  varying vec3 vTint;
  varying float vSeed;

  void main() {
    float age = (uTime - aLife.x) / aLife.y;
    vAge = age;
    vUv = uv;
    vTint = aTint;
    vSeed = aLife.w;
    if (age < 0.0 || age > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

    // SPREADS FOR ITS WHOLE LIFE. On a sqrt, so most of the growth is in the
    // first moments and it eases out — ink hitting water, not a balloon. The
    // old version opened in four frames and then held one size, which is what
    // a decal does.
    float grow = mix(0.55, uSpread, sqrt(age));
    float s = aLife.z * grow;

    vec2 axis = normalize(aSmear + vec2(1e-6, 0.0));
    // Long along the smear, short across it, then rotated into place. Doing it
    // here rather than baking a rotation per instance keeps the quad shared.
    vec2 q = vec2(position.x * s * uStretch, position.y * s / uStretch);
    // NOT named "flat": that is a reserved interpolation qualifier in GLSL ES
    // 3.0, and a variable using it fails to COMPILE — which renders nothing at
    // all and throws nowhere. Caught by tools/impact-shader-check.mjs, which is
    // the only thing in the project that can see it.
    vec2 onSurface = axis * q.x + vec2(-axis.y, axis.x) * q.y;

    // ...and it lets go of the surface. The perpendicular IS the surface
    // normal (both live in the same plane), so this is the mark lifting off
    // the skin into the water rather than sliding along it.
    vec2 normal = vec2(-axis.y, axis.x);
    vec2 drift = normal * uDrift * aLife.z * age * age;

    gl_Position = projectionMatrix * modelViewMatrix
      * vec4(aOrigin + vec3(onSurface + drift, 0.0), 1.0);
  }
`;

const woundFrag = /* glsl */ `
  precision highp float;
  uniform float uGlow;
  uniform float uOpacity;
  varying float vAge;
  varying vec2 vUv;
  varying vec3 vTint;
  varying float vSeed;

  // Cheap value noise. Nothing here needs to tile or to be gradient-correct —
  // it exists to stop the outline being an ellipse, and an ellipse is the one
  // thing that would make these read as decals stamped on a model.
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  void main() {
    if (vAge < 0.0 || vAge > 1.0) discard;
    vec2 p = (vUv - 0.5) * 2.0;
    float ang = atan(p.y, p.x);

    // The radius, chewed by two octaves keyed on the instance's own seed, so
    // every smear is its own shape and keeps that shape for its whole life.
    float n = vnoise(vec2(cos(ang), sin(ang)) * 2.2 + vSeed * 37.0) * 0.30
            + vnoise(vec2(cos(ang), sin(ang)) * 5.0 + vSeed * 91.0) * 0.14;
    float r = length(p) / max(0.35, 0.80 + n * 0.44);

    // SOFT ALL THE WAY OUT — no discard at an edge, which is what a cookie
    // cutter is however ragged you make the cutter. Squared to pull the mass
    // into the middle: a blob with a bright heart, not a flat disc.
    float body = 1.0 - smoothstep(0.0, 1.0, r);
    body *= body;

    // Thins as it spreads, and faster than it grows, so the total ink on
    // screen is falling from the first frame. Cubed rather than linear: a
    // linear fade is visible AS a fade, and this should look like it was
    // taken by the water.
    float fade = 1.0 - vAge;
    fade *= fade * fade;

    // Additive, so it disperses into whatever is behind it instead of sitting
    // on top as a lighter shape. The old one blended normally because its
    // middle was a HOLE and had to darken; nothing here is darker than the
    // animal, so nothing here needs to subtract.
    gl_FragColor = vec4(vTint * uGlow * body * fade, body * fade * uOpacity);
  }
`;

// ---------------------------------------------------------------------------

let group = null;
let shards = null;
let rings = null;
let wounds = null;
let clock = 0;

// Ring buffers. A cursor and a modulo, with no free list: every instance dies
// on a clock the shader already reads, so "is this slot free" is a question
// nobody has to ask. The oldest slot is always the one to reuse.
const state = {
  shardCursor: 0,
  ringCursor: 0,
  woundCursor: 0,
};

// The live wounds, CPU-side, because each one has to be dragged along by the
// bone it is stuck to. Parallel to the instance attribute array by index.
const woundAnchors = [];

const _p = { x: 0, y: 0, z: 0 };
const _col = new THREE.Color();

function cfg() {
  return CONFIG.bossImpact ?? {};
}

function makeShards(count) {
  // A unit quad from (0,0) to (1,1) in x: the vertex shader stretches x along
  // the flight and y across it, so the origin of the shard is its leading
  // edge rather than its middle.
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1).translate(-0.5, 0, 0);
  geo.index = quad.index;
  geo.attributes.position = quad.attributes.position;
  geo.attributes.uv = quad.attributes.uv;
  geo.instanceCount = count;

  geo.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aVel', new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aLife', new THREE.InstancedBufferAttribute(new Float32Array(count * 4).fill(-1), 4));
  geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(count), 1));

  const mat = new THREE.ShaderMaterial({
    vertexShader: shardVert,
    fragmentShader: shardFrag,
    transparent: true,
    depthWrite: false,
    // Same reasoning as the impact flash: this is light, not geometry, and
    // depth-testing it against the creature it is coming off clips it in half
    // along the body it is centred on.
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uDrag: { value: 6 },
      uGlow: { value: 2.4 },
      uSplit: { value: 0.45 },
    },
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 11;
  return mesh;
}

function makeRings(count) {
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(2, 2);
  geo.index = quad.index;
  geo.attributes.position = quad.attributes.position;
  geo.attributes.uv = quad.attributes.uv;
  geo.instanceCount = count;

  geo.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aLife', new THREE.InstancedBufferAttribute(new Float32Array(count * 4).fill(-1), 4));
  geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3));

  const mat = new THREE.ShaderMaterial({
    vertexShader: ringVert,
    fragmentShader: ringFrag,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uGlow: { value: 2.2 },
      uThickness: { value: 0.16 },
    },
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  return mesh;
}

function makeWounds(count) {
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(2, 2);
  geo.index = quad.index;
  geo.attributes.position = quad.attributes.position;
  geo.attributes.uv = quad.attributes.uv;
  geo.instanceCount = count;

  geo.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aLife', new THREE.InstancedBufferAttribute(new Float32Array(count * 4).fill(-1), 4));
  geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3));
  // Seeded pointing straight up rather than at zero: normalize() of a zero
  // vector is a NaN, and a NaN in a position attribute takes the whole
  // instanced draw with it — every smear in the pool would vanish, including
  // the ones that were fine.
  const smear = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) smear[i * 2 + 1] = 1;
  geo.setAttribute('aSmear', new THREE.InstancedBufferAttribute(smear, 2));

  const mat = new THREE.ShaderMaterial({
    vertexShader: woundVert,
    fragmentShader: woundFrag,
    transparent: true,
    depthWrite: false,
    // THE ONE THING HERE THAT IS DEPTH-TESTED, and the reason is the opposite
    // of the shards': a smear is ON the body, so it has to be occluded by the
    // parts of the body in front of it or a hit on the far flank shows through
    // the animal.
    depthTest: true,
    // Additive, like the shards and the ring. This used to blend normally
    // because its middle was a dark HOLE; nothing in a smear is darker than
    // the animal, and additive is what lets it disperse into the water behind
    // it rather than sit on top of it as a lighter shape.
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uGlow: { value: 1.8 },
      uOpacity: { value: 0.9 },
      uSpread: { value: 1.9 },
      uStretch: { value: 1.7 },
      uDrift: { value: 0.5 },
    },
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 8;
  return mesh;
}

export function initBossImpacts(scene) {
  if (group) disposeBossImpacts(scene);
  const c = cfg();
  group = new THREE.Group();
  group.frustumCulled = false;
  shards = makeShards(Math.max(16, c.shardPool ?? 320));
  rings = makeRings(Math.max(4, c.ringPool ?? 48));
  wounds = makeWounds(Math.max(4, c.woundPool ?? 24));
  group.add(rings, shards, wounds);
  woundAnchors.length = 0;
  for (let i = 0; i < wounds.geometry.instanceCount; i++) woundAnchors.push(null);
  scene.add(group);
}

export function disposeBossImpacts(scene) {
  if (!group) return;
  scene.remove(group);
  for (const m of [shards, rings, wounds]) {
    if (!m) continue;
    m.geometry.dispose();
    m.material.dispose();
  }
  group = null;
  shards = null;
  rings = null;
  wounds = null;
  woundAnchors.length = 0;
}

export function clearBossImpacts() {
  if (!group) return;
  for (const m of [shards, rings, wounds]) {
    const life = m.geometry.attributes.aLife;
    life.array.fill(-1);
    life.needsUpdate = true;
  }
  for (let i = 0; i < woundAnchors.length; i++) woundAnchors[i] = null;
}

/**
 * A hit landed on a body, at a point on its skin.
 *
 * @param {object} at    the contact from systems/hitShape.js — { x, y, nx, ny,
 *                       sphere, index }. Called with a plain { x, y } for
 *                       anything that has no measured shape, in which case the
 *                       break still fires and the wound does not: there is
 *                       nothing to anchor it to, and a wound left in world
 *                       space slides off the animal on the next frame.
 * @param {object} opts  { shape, scale, color, wound }
 */
export function spawnBossImpact(at, opts = {}) {
  if (!group || !at) return;
  const c = cfg();
  if (c.enabled === false) return;

  const scale = Math.max(0.25, Math.min(c.maxScale ?? 3, opts.scale ?? 1));
  _col.set(opts.color ?? c.color ?? 0x9ff4ff);

  // The direction the surface faces at the hit. Everything is thrown along it,
  // which is what makes the break read as coming OFF the animal — a burst
  // thrown along the bullet's own travel goes into the body instead.
  let nx = at.nx ?? 0;
  let ny = at.ny ?? 1;
  const nlen = Math.hypot(nx, ny) || 1;
  nx /= nlen; ny /= nlen;

  fireRing(at, nx, ny, scale, c);
  fireShards(at, nx, ny, scale, c);
  if (opts.wound !== false) fireWound(at, opts.shape, scale, c, nx, ny);
}

function fireRing(at, nx, ny, scale, c) {
  const geo = rings.geometry;
  const i = state.ringCursor++ % geo.instanceCount;
  const life = geo.attributes.aLife;
  const origin = geo.attributes.aOrigin;
  const tint = geo.attributes.aTint;

  origin.array[i * 3] = at.x;
  origin.array[i * 3 + 1] = at.y;
  origin.array[i * 3 + 2] = (at.z ?? 0) + (c.ringZ ?? 0.28);
  life.array[i * 4] = clock;
  life.array[i * 4 + 1] = (c.ringLife ?? 0.19);
  life.array[i * 4 + 2] = (c.ringRadius ?? 2.1) * scale;
  // How square-on the hit was, from the normal's screen-space tilt. A ring
  // that is always round says every hit arrived the same way; this one tells
  // you whether you punched into the body or skimmed along it.
  life.array[i * 4 + 3] = Math.max(0.18, Math.abs(ny) * 0.85 + 0.15);
  tint.array[i * 3] = _col.r;
  tint.array[i * 3 + 1] = _col.g;
  tint.array[i * 3 + 2] = _col.b;

  life.needsUpdate = true;
  origin.needsUpdate = true;
  tint.needsUpdate = true;
  rings.material.uniforms.uGlow.value = c.ringGlow ?? 2.2;
  rings.material.uniforms.uThickness.value = c.ringThickness ?? 0.16;
}

function fireShards(at, nx, ny, scale, c) {
  const geo = shards.geometry;
  const count = Math.max(1, Math.round((c.shardCount ?? 7) * Math.min(1.8, scale)));
  const spread = c.shardSpread ?? 1.05;
  const speed = c.shardSpeed ?? [14, 30];
  const len = c.shardLength ?? [0.7, 1.9];

  const life = geo.attributes.aLife;
  const origin = geo.attributes.aOrigin;
  const vel = geo.attributes.aVel;
  const tint = geo.attributes.aTint;
  const seed = geo.attributes.aSeed;

  const base = Math.atan2(ny, nx);
  for (let k = 0; k < count; k++) {
    const i = state.shardCursor++ % geo.instanceCount;
    // Spread across the normal, biased toward it: a cone that is flat across
    // its whole width reads as a firework, and one that is a tight jet reads
    // as a nozzle. Two random samples averaged is a cheap triangular
    // distribution, which is neither.
    const jitter = ((Math.random() + Math.random()) - 1) * spread;
    const ang = base + jitter;
    const sp = speed[0] + Math.random() * (speed[1] - speed[0]);

    origin.array[i * 3] = at.x;
    origin.array[i * 3 + 1] = at.y;
    origin.array[i * 3 + 2] = (at.z ?? 0) + (c.shardZ ?? 0.3);
    vel.array[i * 3] = Math.cos(ang) * sp * scale;
    vel.array[i * 3 + 1] = Math.sin(ang) * sp * scale;
    vel.array[i * 3 + 2] = 0;
    life.array[i * 4] = clock;
    life.array[i * 4 + 1] = (c.shardLife ?? 0.16) * (0.7 + Math.random() * 0.6);
    life.array[i * 4 + 2] = (len[0] + Math.random() * (len[1] - len[0])) * scale;
    life.array[i * 4 + 3] = (c.shardWidth ?? 0.16) * scale;
    tint.array[i * 3] = _col.r;
    tint.array[i * 3 + 1] = _col.g;
    tint.array[i * 3 + 2] = _col.b;
    seed.array[i] = Math.random();
  }

  life.needsUpdate = true;
  origin.needsUpdate = true;
  vel.needsUpdate = true;
  tint.needsUpdate = true;
  seed.needsUpdate = true;
  shards.material.uniforms.uGlow.value = c.shardGlow ?? 2.4;
  shards.material.uniforms.uDrag.value = c.shardDrag ?? 6;
  shards.material.uniforms.uSplit.value = c.shardCore ?? 0.45;
}

function fireWound(at, shape, scale, c, nx, ny) {
  // NO ANCHOR, NO SMEAR. This is the whole reason the effect is worth having:
  // a mark stored in world space is off the animal one frame later, and a boss
  // covered in marks that do not move with it looks like a bug rather than
  // like damage. The contact carries which sphere it landed on, and that
  // sphere carries a bone — so the mark is stored where the flesh keeps it.
  if (!shape || !at.sphere || at.index < 0) return;
  if (!worldToShapeLocal(shape, at.index, at.x, at.y, at.z ?? 0, _p)) return;

  const geo = wounds.geometry;
  const i = state.woundCursor++ % geo.instanceCount;
  const life = geo.attributes.aLife;
  const tint = geo.attributes.aTint;
  const smearAttr = geo.attributes.aSmear;

  life.array[i * 4] = clock;
  life.array[i * 4 + 1] = (c.woundLife ?? 0.55) * (0.8 + Math.random() * 0.4);
  life.array[i * 4 + 2] = (c.woundSize ?? 1.15) * scale;
  life.array[i * 4 + 3] = Math.random();
  _col.set(c.woundColor ?? 0x7ff0d0);
  tint.array[i * 3] = _col.r;
  tint.array[i * 3 + 1] = _col.g;
  tint.array[i * 3 + 2] = _col.b;

  // WHICH WAY IT SMEARS. Along the surface, not along the normal: the tangent
  // is the direction a hit actually drags something across skin, and a blob
  // stretched along the normal would read as squirting out of the body. The
  // jitter is what stops four hits on the same flank drawing four parallel
  // marks.
  const jitter = (Math.random() - 0.5) * (c.woundSmearJitter ?? 0.9);
  const cj = Math.cos(jitter);
  const sj = Math.sin(jitter);
  const tx = -ny;
  const ty = nx;
  smearAttr.array[i * 2] = tx * cj - ty * sj;
  smearAttr.array[i * 2 + 1] = tx * sj + ty * cj;

  life.needsUpdate = true;
  tint.needsUpdate = true;
  smearAttr.needsUpdate = true;
  // Re-read per hit rather than at init, the same as the ring and the shards,
  // so dragging a slider in the tuner changes the next smear rather than
  // needing the page reloaded.
  const u = wounds.material.uniforms;
  u.uGlow.value = c.woundGlow ?? 1.8;
  u.uOpacity.value = c.woundOpacity ?? 0.9;
  u.uSpread.value = c.woundSpread ?? 1.9;
  u.uStretch.value = Math.max(0.2, c.woundStretch ?? 1.7);
  u.uDrift.value = c.woundDrift ?? 0.5;

  woundAnchors[i] = {
    shape,
    index: at.index,
    lx: _p.x, ly: _p.y, lz: _p.z,
    // The z it should draw at, nudged toward the camera so the mark sits ON
    // the skin rather than inside it. Small — depth here is a drawing lane.
    lift: c.woundLift ?? 0.12,
    dead: false,
  };
}

/**
 * @param realDt unscaled seconds. Deliberately NOT the hit-stopped clock: an
 *               impact effect that freezes with the frame during its own
 *               hit-stop is the one thing guaranteed to be on screen while
 *               everything else is held, and holding it too reads as a stall.
 */
export function updateBossImpacts(realDt) {
  if (!group) return;
  clock += realDt;
  shards.material.uniforms.uTime.value = clock;
  rings.material.uniforms.uTime.value = clock;
  wounds.material.uniforms.uTime.value = clock;

  // Drag every live wound along with the body it is stuck to.
  const geo = wounds.geometry;
  const life = geo.attributes.aLife;
  const origin = geo.attributes.aOrigin;
  let moved = false;
  let killed = false;

  for (let i = 0; i < woundAnchors.length; i++) {
    const a = woundAnchors[i];
    if (!a) continue;
    const born = life.array[i * 4];
    const span = life.array[i * 4 + 1];
    if (born < 0 || clock - born > span) { woundAnchors[i] = null; continue; }

    // THE ANIMAL DIED WEARING IT. Retired rather than left where it was: a
    // wound floating in open water after the boss is gone is a mark with
    // nothing to be a mark ON, and the shape is exactly what knows this — its
    // bones went back to the pool with the body.
    if (!a.shape.alive) {
      life.array[i * 4] = -1;
      woundAnchors[i] = null;
      killed = true;
      continue;
    }

    if (!shapeLocalToWorld(a.shape, a.index, a.lx, a.ly, a.lz, _p)) {
      life.array[i * 4] = -1;
      woundAnchors[i] = null;
      killed = true;
      continue;
    }
    origin.array[i * 3] = _p.x;
    origin.array[i * 3 + 1] = _p.y;
    origin.array[i * 3 + 2] = _p.z + a.lift;
    moved = true;
  }

  if (moved) origin.needsUpdate = true;
  if (killed) life.needsUpdate = true;
}

/** For the harness — how many marks are currently riding a body. */
export function liveWoundCount() {
  let n = 0;
  for (const a of woundAnchors) if (a) n += 1;
  return n;
}
