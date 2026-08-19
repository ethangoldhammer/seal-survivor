import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ImprovedNoise } from 'three/examples/jsm/math/ImprovedNoise.js';
import { CONFIG } from '../config.js';
import { bounds, seabedTopY, maxWaveExcursion } from '../arena.js';

// The walls, made visible.
//
// clampToArena has always stopped the seal dead at bounds.left / bounds.right,
// and for as long as the arena was exactly the frame that was fine — you hit
// the edge of the screen, which is a boundary everyone already understands.
// `arena.widthScale` moved the walls out into open water, where a seal that
// stops swimming in the middle of nothing reads as a bug rather than a shore.
// So: a rock face at each wall, tall enough to be the thing you stop against.
//
// It is SCENERY, not collision. The wall is still clampToArena and this does
// not know the player exists — which is deliberate, because two sources of
// truth for where the world ends is exactly how a rock ends up somewhere the
// seal can swim through. The stack is instead built to land its inner face on
// the line the seal actually stops at, so the two agree by construction.
//
// Rebuilt on resize like the grid, and for the same reason: every number here
// comes off `bounds`, which moves when the window or the tuner does.

// One shared unit boulder, transformed per instance. Building a fresh
// IcosahedronGeometry per rock and displacing it individually would be the
// obvious way and costs an allocation and a noise walk for each — this walks
// the noise once per SHAPE and reuses it, which is what keeps a 60-boulder
// wall inside a rebuild the resize can afford.
const SHAPE_VARIANTS = 5;

/**
 * Deterministic RNG. The stack has to survive a rebuild unchanged: the
 * backdrop is torn down on every resize, and a wall that reshuffles its
 * boulders when you drag the window reads as the scenery glitching rather
 * than as the window resizing.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const noise = new ImprovedNoise();

/**
 * A lumpy unit-radius boulder. The displacement is two octaves of 3D noise on
 * the vertex direction, so neighbouring faces move together and the result is
 * a worn rock rather than a sea urchin — one octave at this amplitude is a
 * smooth blob and three is visually indistinguishable from two.
 *
 * Non-indexed and flat-shaded on purpose: faceted rock catches the key light
 * in a way a smooth normal cannot, and the game's whole backdrop is flat.
 */
function boulderShape(seed, detail, roughness) {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = noise.noise(v.x * 1.6 + seed, v.y * 1.6 + seed, v.z * 1.6 + seed) * 0.7
            + noise.noise(v.x * 3.9 - seed, v.y * 3.9 - seed, v.z * 3.9 - seed) * 0.3;
    v.multiplyScalar(1 + n * roughness);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  // IcosahedronGeometry is already non-indexed in this three; calling
  // toNonIndexed() anyway only earns a console warning per boulder.
  return geo.index ? geo.toNonIndexed() : geo;
}

// How deep the drawn face is, in world units past the wall — at its THINNEST
// point, which is the only measurement the camera can safely spend. The
// cinematic rig is allowed to drift the frame a little past bounds.left /
// bounds.right so the edge of the ocean isn't a hard stop (see clampFocus in
// world.js), and what it may spend is exactly this: drift further than the
// face is deep and the frame shows open water OUTSIDE the shore at whichever
// height the stack happens to be meanest, which is the one thing the shore
// exists to prevent.
//
// Measured off the merged triangles rather than off the boulder radii,
// because the radii are pre-rotation: a boulder is scaled unequally on three
// axes and then spun, so its x-extent is not any of the numbers that built it.
//
// SCANLINES, NOT VERTICES. Bucketing vertices leaves an empty bucket wherever
// a triangle spans one without landing a corner in it, and an empty bucket
// reads as a hole in a face that has none — the first version of this
// reported zero cover on the shipped wall. Intersecting each triangle with
// the scanline IS the silhouette, and costs one pass over a geometry that was
// only just built. A quarter-unit step: measured against a sweep twenty times
// finer, the thinnest point of the shipped wall is a broad minimum rather than
// a spike, and both sweeps report the same 1.84.
const COVER_STEP = 0.25;

function measureCover(geo) {
  // The band that has to stay hidden: from the top of the seabed (below it the
  // floor strip is opaque and overscans the arena on its own) up to the
  // highest the water ever reaches. Above that line there is nothing behind
  // the wall but sky, which is the same sky either side of it.
  const stormAmp = CONFIG.arena.waveAmplitude * Math.max(1, CONFIG.weather?.sea?.amp ?? 1);
  const lo = seabedTopY();
  const hi = bounds.surfaceY + maxWaveExcursion(stormAmp, 1);
  const n = Math.max(2, Math.ceil((hi - lo) / COVER_STEP) + 1);
  const right = new Float64Array(n).fill(-Infinity);
  const left = new Float64Array(n).fill(-Infinity);

  const pos = geo.attributes.position;
  const ax = [0, 0, 0];
  const ay = [0, 0, 0];
  for (let t = 0; t + 2 < pos.count; t += 3) {
    let yLo = Infinity, yHi = -Infinity;
    for (let k = 0; k < 3; k++) {
      ax[k] = pos.getX(t + k);
      ay[k] = pos.getY(t + k);
      if (ay[k] < yLo) yLo = ay[k];
      if (ay[k] > yHi) yHi = ay[k];
    }
    // Which wall this triangle belongs to. The two stacks never meet, so one
    // corner's sign decides it.
    const outward = ax[0] > 0 ? right : left;
    const i0 = Math.max(0, Math.ceil((yLo - lo) / COVER_STEP));
    const i1 = Math.min(n - 1, Math.floor((yHi - lo) / COVER_STEP));
    for (let i = i0; i <= i1; i++) {
      const y = lo + i * COVER_STEP;
      let far = -Infinity;
      for (let k = 0; k < 3; k++) {
        const j = (k + 1) % 3;
        const y0 = ay[k], y1 = ay[j];
        if ((y0 <= y && y1 >= y) || (y1 <= y && y0 >= y)) {
          const f = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
          const x = ax[k] + (ax[j] - ax[k]) * f;
          // Outward is +x on the right wall and -x on the left, so both sides
          // are reduced to "units past the wall" before they are compared.
          const d = outward === right ? x - bounds.right : bounds.left - x;
          if (d > far) far = d;
        }
      }
      if (far > outward[i]) outward[i] = far;
    }
  }

  let worst = Infinity;
  for (let i = 0; i < n; i++) {
    worst = Math.min(worst, Math.max(0, right[i] === -Infinity ? 0 : right[i]));
    worst = Math.min(worst, Math.max(0, left[i] === -Infinity ? 0 : left[i]));
  }
  return Number.isFinite(worst) ? worst : 0;
}

export function createWallRocks(scene) {
  const group = new THREE.Group();
  scene.add(group);

  let mesh = null;
  let material = null;
  // Units of face past each wall that the frame may safely drift into. Zero
  // until the stack is built, and zero again the moment it is disposed or
  // turned off — with no shore drawn there is nothing to hide behind, so the
  // camera goes back to stopping dead on the wall.
  let cover = 0;

  function dispose() {
    cover = 0;
    if (!mesh) return;
    group.remove(mesh);
    mesh.geometry.dispose();
    mesh = null;
  }

  function build() {
    dispose();
    const cfg = CONFIG.wallRocks ?? {};
    if (cfg.enabled === false) return;

    const rand = mulberry32(cfg.seed ?? 1337);
    const detail = Math.max(0, Math.min(3, Math.round(cfg.detail ?? 1)));
    const roughness = cfg.roughness ?? 0.32;
    const shapes = [];
    for (let i = 0; i < SHAPE_VARIANTS; i++) shapes.push(boulderShape(rand() * 100, detail, roughness));

    // The stack runs from below the seabed — buried, so no boulder ever shows
    // a floating underside where it meets the floor — up to `aboveWater` units
    // past the surface, which is what makes it read as a shore rather than as
    // a reef that happens to stop.
    const footY = seabedTopY() - (cfg.bury ?? 2.5);
    const headY = bounds.surfaceY + (cfg.aboveWater ?? 5);
    const span = Math.max(1, headY - footY);
    const count = Math.max(1, Math.round(cfg.count ?? 26));
    // A [smallest, largest] range — the spread is what stops the face reading
    // as one boulder repeated. config.js owns the shape of this (healTunedShapes
    // repairs a saved snapshot that holds a bare number); the guard is only so
    // that scenery can never again take the whole boot down before first frame.
    const [rMin, rMax] = Array.isArray(cfg.size) ? cfg.size : [1.6, 4.4];

    const parts = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const scl = new THREE.Vector3();
    const at = new THREE.Vector3();

    // How far a boulder may bite past the wall, and how far it may hang back.
    // The seal's CENTRE stops at bounds.right - hitRadius and its body reaches
    // the wall itself, so the face wants to sit on the wall: hang back and the
    // seal bounces off open water short of the rock, bite deeper than its
    // radius and the seal disappears into the cliff. Both are small, and the
    // spread between them is what keeps the face from being a drawn straight
    // line. Clamped against the live hitRadius rather than a written constant.
    const reach = Math.min(0.7, (CONFIG.player?.hitRadius ?? 1) * 0.7);

    for (const side of [-1, 1]) {
      for (let i = 0; i < count; i++) {
        // Stratified up the wall rather than uniformly random, so the face has
        // no holes — pure random over 26 boulders reliably leaves a gap you
        // can see the background through, which is the one thing this exists
        // to prevent.
        const t = (i + rand() * 0.85) / count;
        const r = rMin + rand() * (rMax - rMin);
        // Boulders get smaller toward the top: a cliff tapers, and an even
        // column reads as a wall of identical bubbles.
        const taper = 1 - (cfg.taper ?? 0.35) * t;
        const rad = r * taper;

        e.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI);
        q.setFromEuler(e);
        // Squashed on y so they read as bedded, weathered rock rather than as
        // dropped spheres.
        scl.set(rad, rad * (0.62 + rand() * 0.4), rad * (0.8 + rand() * 0.4));

        const y = footY + t * span + (rand() - 0.5) * (span / count);
        const z = (cfg.z ?? -2.2) + (rand() - 0.5) * 1.6;

        const g = shapes[(i + (side > 0 ? 1 : 0)) % shapes.length].clone();
        // Placed at x = 0 first, then MEASURED and slid into position. The
        // inner face has to land on the wall, and where that face falls is a
        // function of a random rotation applied to three unequal scales on a
        // lumpy shape — there is no closed form for it worth trusting, and
        // guessing it with a fraction of the radius is what put the last
        // version four units inside the water the seal can swim in.
        at.set(0, y, z);
        m.compose(at, q, scl);
        g.applyMatrix4(m);
        g.computeBoundingBox();

        // Where this boulder's face should sit: on the wall, give or take.
        const faceX = bounds.right - rand() * reach;
        const bb = g.boundingBox;
        g.translate(side > 0 ? faceX - bb.min.x : -faceX - bb.max.x, 0, 0);
        parts.push(g);
      }
    }

    const merged = mergeGeometries(parts, false);
    for (const g of parts) g.dispose();
    for (const g of shapes) g.dispose();
    if (!merged) return;
    merged.computeVertexNormals();

    if (!material) {
      material = new THREE.MeshLambertMaterial({
        color: cfg.color ?? 0x0d2230,
        flatShading: true,
      });
    }
    material.color.set(cfg.color ?? 0x0d2230);

    cover = measureCover(merged);

    mesh = new THREE.Mesh(merged, material);
    // Behind the swimming plane, in front of the seabed backdrop at -4.4, so
    // creatures pass in front of the cliff and the cliff in front of the floor.
    mesh.renderOrder = -1;
    group.add(mesh);
  }

  function stats() {
    return {
      verts: mesh?.geometry.attributes.position.count ?? 0,
      draws: mesh ? 1 : 0,
    };
  }

  return {
    build, dispose, stats,
    get mesh() { return mesh; },
    // See measureCover: how far past the wall the camera may look and still be
    // looking at rock.
    get cover() { return cover; },
  };
}
