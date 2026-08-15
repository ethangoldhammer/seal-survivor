import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';
import { emit } from '../entities/particles.js';
import { assetBaseColor } from '../assets.js';
import { hitShapeSpheres } from './hitShape.js';

// ---------------------------------------------------------------------------
// WHAT IS LEFT OF A BOSS
//
// A boss used to leave nothing. The body was released back to the visual pool
// on the frame its health ran out, so the biggest animal in the run ended by
// being deleted — one burst of the same kill particles a mackerel gets, over a
// hole where forty seconds of fight had been. The slow motion and the push-in
// (systems/bossKill.js) then held the camera on that hole for a beat and a
// half, which is the worst possible thing to point a close-up at.
//
// So it comes apart instead. Hundreds of small chunks, thrown out of the body
// along the line from its centre, tumbling as they go, carrying the animal's
// own colour and a share of the speed it was making when it died. They hang in
// the dilated water while the shot holds, spread as the ocean comes back, and
// sink away into the dark over the seconds after it — the beat has something
// in it now, and what it has is the animal.
//
// WHERE THE CHUNKS COME FROM. Not from the mesh: cutting a skinned body into
// pieces is a job for a rig, and a boss is posed by an animation mixer at the
// instant it dies, so a slice taken off the bind pose would spray out of a
// shape the animal is not currently in. The HITBOX is already a volumetric
// model of the posed flesh — a handful of spheres fitted to the body and
// carried along by its bones, see systems/hitShape.js — so chunks are sampled
// from INSIDE those spheres, weighted by volume. A megalodon's tail throws as
// many chunks as its head in proportion to how much tail there is, the burst
// is in the pose the animal died in, and none of it costs a measurement.
//
// Creatures with no hitbox (nothing small is given one) fall back to a single
// sphere at the body's own radius, which is the same idea at one sphere.
//
// ONE DRAW CALL. Three hundred chunks is three hundred meshes done the obvious
// way, which is more draws than the rest of the arena put together at the
// exact moment the game most wants the frame. It is one InstancedMesh with
// per-instance colour instead, rewritten each frame from a plain array of
// chunk records — every chunk is already moving every frame, so there is no
// dirty-tracking to be saved by holding still.
//
// TUNING is CONFIG.boss.gibs, and all of it is look: no damage, no radius
// anything is tested against, nothing that changes how a fight goes.
// ---------------------------------------------------------------------------

// Live chunks, oldest first. Not a ring buffer over fixed slots (the shape
// bossImpact.js uses) because these are simulated on the CPU and rewritten
// wholesale every frame: an array that is exactly as long as the number of
// chunks in the water lets `mesh.count` be that number too, so an arena with
// no wreckage in it costs nothing to draw rather than a poolful of degenerate
// instances.
const chunks = [];

let mesh = null;
let geometry = null;
let material = null;

// Reused per frame rather than per chunk — three hundred chunks is three
// hundred of each of these otherwise, every frame, all garbage.
const _m = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _scale = new THREE.Vector3();
const _col = new THREE.Color();
const _hot = new THREE.Color();

function cfg() {
  return CONFIG.boss?.gibs ?? {};
}

// How many instances the buffer actually holds. Fixed when the mesh is built,
// because an instance buffer cannot grow — reading `max` live would let the
// tuner raise the cap above the array the chunks are written into, which is a
// silent write past the end rather than a bigger burst.
let allocated = 0;

function capacity() {
  return allocated || Math.max(16, Math.round(cfg().max ?? 360));
}

export function initBossGibs(scene) {
  if (mesh || !scene) return;
  // An icosahedron rather than a box: twenty faces is nothing to draw, and it
  // is the smallest shape that still reads as a lump of something at any
  // orientation. A cube has three ways to look flat and hits all of them
  // while it tumbles. Radius 0.5 so the per-instance scale IS the chunk's
  // width in world units.
  geometry = new THREE.IcosahedronGeometry(0.5, 0);
  // LIT, unlike most of the effects in this game, which are additive sprites.
  // A chunk is a solid object and has to be shaded like one — an unlit chunk
  // is a flat silhouette with no form, and three hundred of them read as
  // confetti. The colour is per-instance (the animal's, varied) and multiplies
  // into this white base.
  material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.78,
    metalness: 0,
  });
  allocated = Math.max(16, Math.round(cfg().max ?? 360));
  mesh = new THREE.InstancedMesh(geometry, material, allocated);
  mesh.name = 'bossGibs';
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(allocated * 3).fill(1), 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  // NO vertexColors on the material. instanceColor works on its own; switching
  // vertex colours on to "enable" it renders every instance black, because
  // there is no colour attribute on the geometry for it to read.
  //
  // One mesh spans the whole arena, so three can only cull all of it or none,
  // and the bounding sphere it would cull against sits at the origin.
  mesh.frustumCulled = false;
  mesh.count = 0;
  scene.add(mesh);
}

export function disposeBossGibs(scene) {
  if (!mesh) return;
  scene?.remove(mesh);
  mesh.dispose();
  geometry.dispose();
  material.dispose();
  mesh = null;
  geometry = null;
  material = null;
  allocated = 0;
  chunks.length = 0;
}

// The spheres the burst is sampled from, and the body radius to fall back on.
// Each entry is a world-space centre and radius: for a boss with a hitbox that
// is the posed flesh, one sphere per lump of animal.
function bodySpheres(e) {
  const out = [];
  const spheres = e?.hitShape ? hitShapeSpheres(e.hitShape) : null;
  if (spheres?.length) {
    for (const s of spheres) {
      if (!(s.wr > 0)) continue;
      out.push({ x: s.wx, y: s.wy, z: s.wz, r: s.wr });
    }
  }
  if (out.length) return out;
  // No measured hitbox: one sphere at the creature's own collision radius.
  // Same burst, coarser body.
  const p = e?.mesh?.position;
  if (!p) return out;
  out.push({ x: p.x, y: p.y, z: 0, r: Math.max(0.3, e.radius ?? e.def?.radius ?? 1) });
  return out;
}

/**
 * Blow a creature apart where it floats.
 *
 * Called from main.js's kill hook, on the frame the last hit lands and while
 * the body is still in the water — NOT from systems/boss.js, which finds out a
 * boss died the frame afterwards by noticing it has left the enemy list. By
 * then the visual has gone back to the pool and its bones are posing somebody
 * else, so there is no body left to measure. That one-frame gap is why the
 * chunks are fired from here and the camera from there.
 *
 * @returns the number of chunks thrown. 0 means the caller has nothing to
 *          wait for — switched off, or a creature with no body to break.
 */
export function spawnBossGibs(e) {
  const c = cfg();
  if (c.enabled === false || !mesh || !e) return 0;

  const spheres = bodySpheres(e);
  if (!spheres.length) return 0;

  // How big the animal actually is on screen, taken off the hitbox rather than
  // off `def.radius` — a def radius is the species' figure, and the whole
  // point of a boss is that this individual is several times it. The largest
  // sphere is the body's own thickness, which is what a chunk should be a
  // fraction of.
  let bodyR = 0;
  let volume = 0;
  for (const s of spheres) {
    bodyR = Math.max(bodyR, s.r);
    volume += s.r * s.r * s.r;
  }

  const wanted = Math.round((c.count ?? 90) + (c.perRadius ?? 34) * bodyR);
  const room = capacity() - chunks.length;
  // A second boss killed on top of the first takes the room it needs from the
  // oldest wreckage rather than being thrown a handful of chunks. The chunks
  // that go are the ones that have already had their moment.
  const count = Math.max(0, Math.min(wanted, capacity()));
  if (count > room) chunks.splice(0, count - room);
  if (count === 0) return 0;

  // The animal's own colour — the tuned signature one where the Look panel has
  // set it, the asset's authored colour otherwise. A boss coming apart into
  // chunks of some other colour is the one thing that would make this read as
  // an effect played at a position rather than as the body breaking.
  _col.set(assetBaseColor(e.assetKey) ?? c.fallbackColor ?? 0xc4705c);

  const centre = e.mesh?.position ?? { x: spheres[0].x, y: spheres[0].y };
  const speed = c.speed ?? [5, 20];
  const tintVary = c.tint ?? 0.4;
  const sizeJitter = c.sizeJitter ?? 0.55;
  const life = c.life ?? 3.2;

  for (let i = 0; i < count; i++) {
    // Which lump of animal this chunk came off, weighted by VOLUME rather than
    // picked evenly. Even picking gives a snout the same number of chunks as a
    // torso eight times its size, and the burst then reads as a cloud around
    // the head with a bare tail behind it.
    let roll = Math.random() * volume;
    let s = spheres[spheres.length - 1];
    for (const cand of spheres) {
      roll -= cand.r * cand.r * cand.r;
      if (roll <= 0) { s = cand; break; }
    }

    // A point inside that sphere. The cube root is what makes it UNIFORM in
    // the volume — a plain random radius piles two thirds of the chunks into
    // the middle third of the body, which comes out as a dense core with a
    // thin skin around it instead of a solid animal coming apart.
    const dir = new THREE.Vector3(
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
    );
    if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
    dir.normalize();
    const depth = Math.cbrt(Math.random()) * s.r;
    const px = s.x + dir.x * depth;
    const py = s.y + dir.y * depth;
    const pz = s.z + dir.z * depth;

    // Thrown out along the line from the animal's CENTRE, not from the sphere
    // it came off: chunks that each fly away from their own lump come out as
    // several small bursts in a row, and what has to read is one body opening.
    let ox = px - centre.x;
    let oy = py - centre.y;
    const olen = Math.hypot(ox, oy) || 1;
    ox /= olen;
    oy /= olen;

    const sp = speed[0] + Math.random() * (speed[1] - speed[0]);
    // Scatter, because the chunks nearest the centre have no outward direction
    // worth the name and would otherwise all leave along the same near-random
    // line they happened to be sampled on.
    const scatter = c.scatter ?? 3.5;
    const size = Math.max(0.02, s.r * (c.size ?? 0.16) * (1 - sizeJitter * 0.5 + Math.random() * sizeJitter));

    chunks.push({
      x: px, y: py, z: pz,
      // A share of what the animal was doing when it died. A boss killed
      // mid-charge that drops its wreckage straight down looks like the body
      // was swapped for a pile.
      vx: ox * sp + (e.vx ?? 0) * (c.carry ?? 0.45) + (Math.random() - 0.5) * scatter,
      vy: oy * sp + (e.vy ?? 0) * (c.carry ?? 0.45) + (Math.random() - 0.5) * scatter
        + (c.upBias ?? 2.5) * Math.random(),
      vz: dir.z * sp * 0.25,
      ex: Math.random() * Math.PI * 2,
      ey: Math.random() * Math.PI * 2,
      ez: Math.random() * Math.PI * 2,
      // Mostly about the view axis. This is a side-on game and a tumble in the
      // other two only ever reads as the chunk flickering edge-on.
      ax: (Math.random() - 0.5) * (c.spin ?? 9) * 0.5,
      ay: (Math.random() - 0.5) * (c.spin ?? 9) * 0.5,
      az: (Math.random() - 0.5) * (c.spin ?? 9) * 2,
      size,
      // Small chunks are dragged to a stop sooner than big ones and sink
      // slower, which is most of what sells them as different sizes of the
      // same material rather than as one size drawn at several scales.
      dragMul: Math.max(0.5, (c.size ?? 0.16) * bodyR / Math.max(size, 1e-3)),
      age: 0,
      life: life * (1 - (c.lifeJitter ?? 0.35) * 0.5 + Math.random() * (c.lifeJitter ?? 0.35)),
      // The animal's colour, carried per chunk rather than looked up in the
      // update: the Look panel can be dragged while wreckage is still in the
      // water, and a burst that re-read the asset every frame would change
      // colour halfway down.
      r: _col.r, g: _col.g, b: _col.b,
      // How bright this particular chunk sits. Without the variation three
      // hundred chunks of one colour read as a single flat mass moving.
      tint: 1 - tintVary * 0.5 + Math.random() * tintVary,
      // Whether it is under the water line already, tracked rather than
      // latched: a chunk thrown clear of the surface and back in again
      // splashes on each way in, the way the boat wreckage does.
      wet: py < bounds.surfaceY,
    });
  }

  return count;
}

/**
 * @param dt SCALED seconds — the gameplay clock, dilation and all. Unlike the
 *           impact effects (which run on the wall clock so a hit-stop cannot
 *           freeze them), the wreckage is part of the world the kill shot is
 *           slowing down: chunks hanging almost still through the held beat
 *           and then falling away as the ocean comes back IS the shot. On the
 *           wall clock they would be on the seabed before the camera let go.
 */
export function updateBossGibs(dt) {
  if (!mesh || chunks.length === 0) {
    if (mesh) mesh.count = 0;
    return;
  }
  const c = cfg();
  const floor = bounds.bottom + 0.4;
  const fade = Math.max(0.05, c.fade ?? 0.9);
  const flashFor = Math.max(1e-3, c.flash ?? 0.16);
  const flashGain = Math.max(1, c.flashGain ?? 2.6);
  const surface = bounds.surfaceY;
  // Every chunk leaves the body glowing and cools to the animal's colour over
  // the first tenth of a second. Read once per frame rather than per chunk.
  _hot.set(c.flashColor ?? 0xfff0d8);

  let n = 0;
  for (let i = chunks.length - 1; i >= 0; i--) {
    const g = chunks[i];
    g.age += dt;
    if (g.age >= g.life) {
      chunks.splice(i, 1);
      continue;
    }

    if (dt > 0) {
      const underwater = g.y < surface;
      if (underwater && !g.wet && g.vy < 0) {
        // Small enough that three hundred of them don't turn the surface into
        // a wall of white — it is the shape of the rain that reads, not any
        // one splash.
        emit('splash', g.x, surface, { scale: c.splashScale ?? 0.18, dirX: 0, dirY: 1 });
      }
      g.wet = underwater;

      if (underwater) {
        const drag = Math.exp(-(c.drag ?? 2.2) * g.dragMul * dt);
        g.vx *= drag;
        g.vy *= drag;
        g.vz *= drag;
        g.vy = Math.max(g.vy - (c.waterGravity ?? 4) * dt, -(c.sink ?? 1.3) / Math.max(0.4, g.dragMul));
        const spinDamp = Math.exp(-(c.spinDamp ?? 1.6) * dt);
        g.ax *= spinDamp;
        g.ay *= spinDamp;
        g.az *= spinDamp;
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
        g.vy = 0;
        const rest = Math.exp(-6 * dt);
        g.vx *= rest;
        g.vz *= rest;
        g.ax *= rest;
        g.ay *= rest;
        g.az *= rest;
      }
    }

    // Gone by shrinking rather than by fading. Opacity would mean a
    // transparent material, which for three hundred overlapping solids means
    // sorting three hundred instances the renderer cannot sort — and a chunk
    // that shrinks into the silt reads as settling anyway.
    const left = g.life - g.age;
    const shrink = left < fade ? Math.max(0, left / fade) : 1;
    const size = g.size * shrink;
    if (size <= 1e-4) continue;

    _pos.set(g.x, g.y, g.z);
    _euler.set(g.ex, g.ey, g.ez);
    _quat.setFromEuler(_euler);
    _scale.set(size, size, size);
    _m.compose(_pos, _quat, _scale);
    mesh.setMatrixAt(n, _m);

    // Cooling from the flash to the animal's own colour. The gain is above 1
    // on purpose: the scene renders to an HDR target, so a chunk brighter than
    // white is caught by the bright pass and throws light for the first tenth
    // of a second of its life instead of merely being pale.
    const heat = g.age < flashFor ? 1 - g.age / flashFor : 0;
    const lit = g.tint + heat * (flashGain - g.tint);
    mesh.instanceColor.setXYZ(
      n,
      (g.r + (_hot.r - g.r) * heat) * lit,
      (g.g + (_hot.g - g.g) * heat) * lit,
      (g.b + (_hot.b - g.b) * heat) * lit,
    );
    n++;
  }

  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
}

/** Every chunk in the water, gone. Called on a run reset. */
export function resetBossGibs() {
  chunks.length = 0;
  if (mesh) mesh.count = 0;
}

/** For the test harness. */
export function bossGibCount() {
  return chunks.length;
}
