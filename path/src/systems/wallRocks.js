import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ImprovedNoise } from 'three/examples/jsm/math/ImprovedNoise.js';
import { CONFIG } from '../config.js';
import { bounds, seabedTopY } from '../arena.js';

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

export function createWallRocks(scene) {
  const group = new THREE.Group();
  scene.add(group);

  let mesh = null;
  let material = null;

  function dispose() {
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

  return { build, dispose, stats, get mesh() { return mesh; } };
}
