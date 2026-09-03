import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';

// ---------------------------------------------------------------------------
// A FROZEN BODY COMING APART.
//
// A fish killed while it is ice does not bleed. The kill event swaps its spray
// and its goo for the ice versions (CONFIG.feedback.killFrozen — splinters as
// sprites, and a `killIceGoo` burst into the `ice` group, which is the blood
// surface made hard-edged and glassy). Those are the whole effect at fight
// scale, the way the red is the whole effect of systems/gore.js.
//
// THESE ARE THE SOLIDS under that: a handful of lit, faceted shards thrown out
// of where the body was, tumbling, that RISE rather than sink — ice floats —
// and melt away by shrinking. Same simulation as the gore's bones and the boss
// wreckage, and separate from both for two reasons that are the same reason:
// the shapes are splinters rather than bones, and the material is glass
// rather than meat. Neither is a parameter of the gore, and a `kind` switch
// threaded through a system whose every number is about a man being eaten
// would have made both harder to read.
//
// Sized off the BODY. `size` is a multiple of the creature's own radius, so
// a frozen shark throws bigger ice than a frozen sardine and the effect
// survives a species being retuned — the same rule the gore's `pieces.size`
// follows against the crew height. Never a world unit typed by hand.
//
// ONE DRAW CALL PER SHAPE, the gore's arrangement: each shape owns an
// InstancedMesh rewritten from the shard array every frame, grown by rebuild
// when a burst needs more room than it has.
//
// TUNING is CONFIG.statusFx.shatter, and all of it is look.
// ---------------------------------------------------------------------------

const shards = [];
let shapes = [];
let material = null;
let sceneRef = null;

const _m = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _scale = new THREE.Vector3();
const _v = new THREE.Vector3();
const _col = new THREE.Color();

function cfg() {
  return CONFIG.statusFx?.shatter ?? {};
}

export function initIceShatter(scene) {
  sceneRef = scene ?? null;
  if (!material) {
    const c = cfg();
    // LIT, like the bones — a shard needs a facet catching light or it is a
    // pale streak that could be anything. Smooth where the bone is rough, and
    // faintly self-lit so it still reads in dark water: ice at depth is lit
    // by whatever is in it, and here that is the cold that made it.
    material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: c.roughness ?? 0.12,
      metalness: 0,
      emissive: new THREE.Color(c.emissive ?? 0x2f8fc4),
      emissiveIntensity: c.emissiveIntensity ?? 0.45,
    });
  }
}

export function disposeIceShatter(scene) {
  for (const s of shapes) {
    if (s.mesh) {
      (scene ?? sceneRef)?.remove(s.mesh);
      s.mesh.dispose();
    }
    s.geometry.dispose();
  }
  shapes = [];
  shards.length = 0;
  material?.dispose();
  material = null;
  sceneRef = null;
}

// Centre on the bounding box and scale so the LONGEST axis is 1 — the gore's
// normalise, for the same reason: `size` has to mean one thing across shapes.
function normalise(geo) {
  geo.computeBoundingBox();
  const box = geo.boundingBox;
  if (!box) return geo;
  box.getCenter(_v);
  geo.translate(-_v.x, -_v.y, -_v.z);
  box.getSize(_v);
  const longest = Math.max(_v.x, _v.y, _v.z);
  if (longest > 1e-6) geo.scale(1 / longest, 1 / longest, 1 / longest);
  geo.computeBoundingSphere();
  return geo;
}

// A deterministic wobble keyed on direction rather than vertex index, so the
// corners of a non-indexed face stay welded — lifted from the gore's lumpify,
// with a bigger amount: a lump reads as flesh, a SPIKE reads as ice.
function splinter(geo, amount, seed) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    _v.fromBufferAttribute(pos, i);
    const len = _v.length();
    if (len < 1e-6) continue;
    const nx = _v.x / len;
    const ny = _v.y / len;
    const nz = _v.z / len;
    const w = Math.sin(nx * 7.3 + seed) * Math.sin(ny * 5.9 + seed * 1.9) * Math.sin(nz * 8.1 + seed * 2.7);
    const k = 1 + amount * w;
    pos.setXYZ(i, _v.x * k, _v.y * k, _v.z * k);
  }
  pos.needsUpdate = true;
  // Recomputed AFTER the displacement, on a non-indexed geometry, so every
  // facet is flat — which is what a broken thing should look like.
  geo.computeVertexNormals();
  return geo;
}

// THREE SPLINTERS. Non-indexed so the facets are flat; each one stretched a
// different way so a burst has a long axis in it and does not read as a
// handful of pebbles.
function buildShapes() {
  const make = (amount, seed, sx, sy, sz) => {
    const geo = new THREE.IcosahedronGeometry(0.5, 0).toNonIndexed();
    splinter(geo, amount, seed);
    geo.scale(sx, sy, sz);
    geo.computeVertexNormals();
    return { geometry: normalise(geo), mesh: null, capacity: 0, pending: 0, written: 0 };
  };
  return [
    make(0.55, 2.3, 1, 1.9, 0.45), // a splinter
    make(0.4, 5.1, 0.42, 2.6, 0.38), // a needle
    make(0.5, 7.7, 1.4, 1, 0.3), // a plate
  ];
}

function ensurePool() {
  if (shapes.length) return;
  shapes = buildShapes();
}

function ensureCapacity(s, n) {
  if (s.mesh && s.capacity >= n) return;
  const capacity = Math.max(32, Math.ceil(n * 1.5));
  if (s.mesh) {
    sceneRef?.remove(s.mesh);
    s.mesh.dispose();
  }
  const mesh = new THREE.InstancedMesh(s.geometry, material, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Per-instance colour rides alone — see [[instancecolor-needs-no-vertexcolors]].
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.name = 'iceShards';
  sceneRef?.add(mesh);
  s.mesh = mesh;
  s.capacity = capacity;
}

/**
 * Throw the ice off a body that just died frozen.
 *
 * @param x, y   where the body was
 * @param opts.radius  the body's live radius — sizes and counts the burst
 * @param opts.vx/vy   the body's velocity; a share of it is carried
 * @returns how many shards were thrown
 */
export function spawnIceShatter(x, y, opts = {}) {
  const c = cfg();
  if (c.enabled === false || !material) return 0;
  ensurePool();
  if (!shapes.length) return 0;

  const radius = Math.max(0.05, opts.radius ?? 0.5);
  const max = Math.max(1, Math.round(c.max ?? 180));
  const wanted = Math.max(0, Math.round((c.count ?? 10) + (c.perRadius ?? 9) * radius));
  const count = Math.min(wanted, max);
  if (count === 0) return 0;
  // A second body shattering takes its room from the oldest ice in the water.
  const room = max - shards.length;
  if (count > room) shards.splice(0, count - room);

  const speed = c.speed ?? [3, 12];
  const sizeJitter = c.sizeJitter ?? 0.7;
  const tintVary = c.tint ?? 0.35;
  const life = c.life ?? 1.4;
  const lifeJitter = c.lifeJitter ?? 0.4;
  const spin = c.spin ?? 12;
  const carry = c.carry ?? 0.35;
  const baseSize = radius * (c.size ?? 0.34);
  const vx0 = (opts.vx ?? 0) * carry;
  const vy0 = (opts.vy ?? 0) * carry;
  _col.set(c.color ?? 0xd6f4ff);

  for (let i = 0; i < count; i++) {
    const s = shapes[(Math.random() * shapes.length) | 0];
    const dir = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
    if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
    dir.normalize();
    // Cube root so the starting points are uniform in the body's volume.
    const depth = Math.cbrt(Math.random()) * radius * 0.8;
    const sp = speed[0] + Math.random() * (speed[1] - speed[0]);
    const size = Math.max(0.01, baseSize * (1 - sizeJitter * 0.5 + Math.random() * sizeJitter));
    shards.push({
      shape: s,
      x: x + dir.x * depth,
      y: y + dir.y * depth,
      z: dir.z * depth,
      vx: dir.x * sp + vx0,
      vy: dir.y * sp + vy0,
      vz: dir.z * sp * 0.25,
      ex: Math.random() * Math.PI * 2,
      ey: Math.random() * Math.PI * 2,
      ez: Math.random() * Math.PI * 2,
      // Mostly about the view axis: side-on, a tumble in the other two only
      // ever reads as the piece flickering edge-on.
      ax: (Math.random() - 0.5) * spin * 0.5,
      ay: (Math.random() - 0.5) * spin * 0.5,
      az: (Math.random() - 0.5) * spin * 2,
      size,
      dragMul: Math.max(0.5, baseSize / Math.max(size, 1e-3)),
      age: 0,
      life: life * (1 - lifeJitter * 0.5 + Math.random() * lifeJitter),
      r: _col.r, g: _col.g, b: _col.b,
      tint: 1 - tintVary * 0.5 + Math.random() * tintVary,
    });
  }
  return count;
}

/**
 * @param dt SCALED seconds — the water's clock, like the gore: ice thrown
 *           under a kill's hit-stop hangs with it.
 */
export function updateIceShatter(dt) {
  if (shards.length === 0) {
    for (const s of shapes) if (s.mesh) s.mesh.count = 0;
    return;
  }
  const c = cfg();
  const surface = bounds.surfaceY;
  const floor = bounds.bottom + 0.3;
  const fade = Math.max(0.05, c.fade ?? 0.5);
  const drag = c.drag ?? 2.4;
  // ICE FLOATS. A terminal rise rather than a sink — a small one, so the burst
  // is still a burst and only the tail of it drifts upward.
  const rise = c.rise ?? 0.9;
  const buoyancy = c.buoyancy ?? 2.2;
  const spinDamp = c.spinDamp ?? 1.2;

  for (let i = shards.length - 1; i >= 0; i--) {
    const g = shards[i];
    g.age += dt;
    if (g.age >= g.life) {
      shards.splice(i, 1);
      continue;
    }
    if (dt <= 0) continue;
    if (g.y < surface) {
      const d = Math.exp(-drag * g.dragMul * dt);
      g.vx *= d;
      g.vy *= d;
      g.vz *= d;
      g.vy = Math.min(g.vy + buoyancy * dt, rise / Math.max(0.4, g.dragMul));
      const sd = Math.exp(-spinDamp * dt);
      g.ax *= sd;
      g.ay *= sd;
      g.az *= sd;
    } else {
      g.vy -= CONFIG.arena.gravity * dt;
    }
    g.x += g.vx * dt;
    g.y += g.vy * dt;
    g.z += g.vz * dt;
    g.ex += g.ax * dt;
    g.ey += g.ay * dt;
    g.ez += g.az * dt;
    if (g.y < floor) {
      g.y = floor;
      g.vy = Math.max(0, g.vy);
    }
  }

  // Two passes: size the buffers BEFORE writing, because a write past the end
  // of an instance buffer is silent.
  for (const s of shapes) s.pending = 0;
  for (const g of shards) g.shape.pending += 1;
  for (const s of shapes) {
    if (s.pending > 0) ensureCapacity(s, s.pending);
    s.written = 0;
  }

  for (const g of shards) {
    const s = g.shape;
    if (!s.mesh || s.written >= s.capacity) continue;
    // Gone by MELTING — shrinking — rather than fading. Opacity would mean a
    // transparent material and a sort the renderer cannot do for overlapping
    // solids, and ice that shrinks away reads as melting anyway.
    const left = g.life - g.age;
    const shrink = left < fade ? Math.max(0, left / fade) : 1;
    const size = g.size * shrink;
    if (size <= 1e-4) continue;
    const n = s.written++;
    _pos.set(g.x, g.y, g.z);
    _euler.set(g.ex, g.ey, g.ez);
    _quat.setFromEuler(_euler);
    _scale.set(size, size, size);
    _m.compose(_pos, _quat, _scale);
    s.mesh.setMatrixAt(n, _m);
    s.mesh.instanceColor.setXYZ(n, g.r * g.tint, g.g * g.tint, g.b * g.tint);
  }

  for (const s of shapes) {
    if (!s.mesh) continue;
    s.mesh.count = s.written;
    s.mesh.instanceMatrix.needsUpdate = true;
    s.mesh.instanceColor.needsUpdate = true;
  }
}

/** Every shard gone. A run reset. */
export function resetIceShatter() {
  shards.length = 0;
  for (const s of shapes) if (s.mesh) s.mesh.count = 0;
}

/** For the harness. */
export function iceShardCount() {
  return shards.length;
}

/** For the harness: the shards themselves, read-only by convention. */
export function iceShards() {
  return shards;
}

/** For the harness: how many drawn instances each shape's buffer can hold. */
export function iceShatterCapacity() {
  ensurePool();
  return shapes.map((s) => s.capacity);
}
