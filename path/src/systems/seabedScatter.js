import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { seabedTopY, bounds } from '../arena.js';
import { createVisual } from '../assets.js';
import { setGrassSwayHeight, registerShovedInstances, clearShovedInstances } from './grassSway.js';
import { SEABED_PROPS } from '../seabedProps.js';

// A bed of seabed plants, scattered rather than placed.
//
// systems/decor.js already stands ONE prop on the floor and handles the three
// ways that goes quietly wrong (the origin is not the base, the floor moves
// with the tuner, the model cache starts empty — read its header, all three
// still apply here). This is the other half: deciding WHERE a few hundred of
// them go, and drawing them for less than a few hundred draw calls.
//
// WHY NOT plantDecor IN A LOOP. It is the obvious build and it is one draw
// call per plant. systems/instancedPool.js exists because 140 chum orbs of 80
// faces each was already more draws than every creature in the water put
// together; a bed is bigger than the chum and never moves. So: one
// InstancedMesh per VARIANT — nineteen draws for the whole seabed, whatever
// the count — and the per-plant cost becomes sixteen floats in a buffer that
// is written once at build and never touched again.
//
// The plants are still the real models with the real materials. The template
// comes from createVisual, exactly as decor.js's would, and the material
// handed to the InstancedMesh is that template's own object — not a clone,
// because Material.clone() silently drops onBeforeCompile and with it every
// shader the look pipeline injected (see the note in assets.js). What gets
// baked into the instanced geometry is only the template's TRANSFORM: fit,
// the orientation group, and any size multiplier, which live on three
// different nodes and are the reason this measures the assembled object
// rather than reading numbers off the asset entry.

/**
 * Deterministic RNG — the same one wallRocks.js and rocks.js use, for the same
 * reason. The bed is rebuilt whenever the floor moves, and a bed that
 * reshuffles when you drag the tuner reads as the scenery glitching rather
 * than as the tuner working.
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

/**
 * Blue-noise points in a BAND: throw a dart, keep it only if nothing already
 * kept is within `spacing`. Rejection sampling rather than Bridson's algorithm
 * on purpose — Bridson fills a region to saturation, and a bed that is
 * saturated everywhere reads as turf. Darts thrown at a fixed budget leave the
 * gaps and clusters that make it read as growth, and `attempts` is a legible
 * dial for how packed it gets.
 *
 * A BAND AND NOT A DISC. A disc is the right domain for a bed you can walk
 * around; this game is a side view of a floor, so the domain is the floor:
 * `width` wall to wall, `depth` the narrow band of z the seabed is visible in.
 * A disc here had to have its second axis squeezed into that band anyway,
 * which meant the spacing you asked for was not the spacing you got — the
 * squeeze pulled every gap in z shut by the ratio of the two, and no number in
 * the config said so.
 *
 * The grid is not an optimisation detail, it is what makes the count
 * affordable: a naive all-pairs check is O(n^2) and a bed of 400 plants at 30
 * attempts each is 4.8 million distance tests on the boot path.
 *
 * Returns points in world XZ, centred on (0, 0) — the caller offsets them.
 */
export function blueNoiseBand(rand, { width, depth, spacing, count, attempts = 30 }) {
  const points = [];
  if (width <= 0 || count <= 0) return points;
  // Below this the spacing test can never fail and the grid is pure overhead.
  const cell = Math.max(spacing, 1e-4) / Math.SQRT2;
  const grid = new Map();
  const key = (cx, cz) => `${cx},${cz}`;
  const min2 = spacing * spacing;

  const fits = (x, z) => {
    if (spacing <= 0) return true;
    const cx = Math.floor(x / cell); const cz = Math.floor(z / cell);
    // Two cells either way: a cell is spacing/sqrt(2) across, so a point
    // `spacing` away can be two cells out on the diagonal. One ring misses
    // those and lets pairs land visibly on top of each other.
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) {
        const bucket = grid.get(key(cx + i, cz + j));
        if (!bucket) continue;
        for (const p of bucket) {
          const dx = p[0] - x; const dz = p[1] - z;
          if (dx * dx + dz * dz < min2) return false;
        }
      }
    }
    return true;
  };

  for (let i = 0; i < count; i++) {
    for (let a = 0; a < attempts; a++) {
      // Uniform over the rectangle. No sqrt weighting here — that was the
      // disc's fix for its own geometry (uniform radius packs half the points
      // into the inner quarter of the area) and a rectangle has no centre to
      // crowd.
      const x = (rand() - 0.5) * width;
      const z = (rand() - 0.5) * depth;
      if (!fits(x, z)) continue;
      points.push([x, z]);
      const cx = Math.floor(x / cell); const cz = Math.floor(z / cell);
      const k = key(cx, cz);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push([x, z]);
      break;
    }
  }
  return points;
}

/**
 * Pick a species by weight. Weights are relative, so a species can be turned
 * off with a 0 and the rest keep their proportions without renormalising by
 * hand.
 */
function pickWeighted(rand, entries, total) {
  let roll = rand() * total;
  for (const [name, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return name;
  }
  return entries[entries.length - 1][0];
}

/**
 * Flatten a template into one geometry in ITS OWN space, with every transform
 * on the way down baked in, and the base moved to y=0.
 *
 * The bake is the whole job. createVisual hands back an assembly, not a mesh:
 * `fit` is on a grandchild, the orientation group carries the forward/up
 * rotation, and a size multiplier sits on the root — so the mesh's own
 * geometry is in the modeller's units and pointing the modeller's way. An
 * InstancedMesh has one geometry and one matrix per instance and no room for
 * that chain, so it has to be collapsed first.
 *
 * Base-to-y=0 is decor.js's `seat` written once instead of per plant: with the
 * base at the origin, planting is `position.y = seabedTopY()` and nothing else.
 */
function bakeTemplate(id) {
  const template = createVisual(id);
  template.updateMatrixWorld(true);

  const parts = [];
  let material = null;
  template.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const geo = o.geometry.clone();
    geo.applyMatrix4(o.matrixWorld);
    parts.push(geo);
    material ??= o.material;
  });
  if (!parts.length) return null;

  // These props are one mesh each, but the fallback shape is not and a
  // re-export could not be. Merging keeps the "one draw per variant" promise
  // true rather than approximately true.
  const geometry = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  if (!geometry) return null;
  if (parts.length > 1) for (const p of parts) p.dispose();

  geometry.computeBoundingBox();
  const base = geometry.boundingBox.min.y;
  geometry.translate(0, -base, 0);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, material, height: geometry.boundingBox.max.y };
}

/**
 * How wide the bed is and where its centre sits — wall to wall, taken off
 * `bounds` rather than written down.
 *
 * WRITTEN DOWN IS WRONG HERE, and quietly: bounds.left/right come from the
 * ASPECT RATIO (updateBounds takes only those two from it), so the floor is a
 * different width on a laptop, on a 21:9 monitor, and after any drag of the
 * window. A bed sized by a constant is the right width on exactly one screen
 * and stops short of the wall on every other one — which reads as the level
 * ending before the wall does, not as a setting being wrong.
 *
 * `overhang` runs the bed PAST the walls. The rock face has depth and the
 * camera has an asymmetric frustum, so a bed that stops exactly at
 * bounds.right shows its last plant with open floor beside it.
 */
export function bedSpan(cfg = CONFIG.seabed ?? {}) {
  const overhang = cfg.overhang ?? 3;
  const left = bounds.left - overhang;
  const right = bounds.right + overhang;
  return { width: right - left, centre: (left + right) / 2 };
}

/**
 * World z for one planned plant.
 *
 * EXPORTED, and used by scatterSeabed rather than duplicated inside it, because
 * this is the one number the Node harness cannot get at any other way: no model
 * loads there, so the harness can never call scatterSeabed and would otherwise
 * have to re-derive the shift from the config — which is exactly the copy that
 * goes stale the first time the anchoring changes.
 *
 * The shift is anchored on the band's BACK edge (`depth[0]`), so the whole
 * foreground layer clears the play plane whatever thickness the band is retuned
 * to. Anchoring on its centre would let the near half of a thick band slide
 * back behind the seal, silently, and half the foreground layer would simply
 * stop being in front of anything.
 */
export function plantWorldZ(p, cfg = CONFIG.seabed ?? {}) {
  const depth = Array.isArray(cfg.depth) ? cfg.depth : [-5.5, -1.5];
  const midZ = (depth[0] + depth[1]) / 2;
  const shift = p.front ? (cfg.front?.gap ?? 1.2) - depth[0] : 0;
  return midZ + p.z + shift;
}

const group = new THREE.Group();
group.name = 'seabedBed';
let built = false;
let placements = [];

/**
 * Decide the whole bed — every position, rotation and scale — without touching
 * three.js. Split out from the building so tools/seabed-scatter-test.mjs can
 * check the layout in Node, where no model loads and no GL context exists.
 *
 * @returns {{variant: string, x: number, z: number, yaw: number, scale: number}[]}
 */
export function planBed(cfg = CONFIG.seabed ?? {}, span = bedSpan(cfg)) {
  const rand = mulberry32(cfg.seed ?? 1337);
  const depth = Array.isArray(cfg.depth) ? cfg.depth : [-5.5, -1.5];
  const points = blueNoiseBand(rand, {
    width: span.width,
    depth: Math.max(0.01, depth[1] - depth[0]),
    spacing: cfg.spacing ?? 1.8,
    count: Math.max(0, Math.round(cfg.count ?? 150)),
    attempts: Math.max(1, Math.round(cfg.attempts ?? 30)),
  });

  const weights = cfg.species ?? {};
  const entries = Object.entries(weights)
    .filter(([name, w]) => w > 0 && SEABED_PROPS[name]);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (!entries.length || total <= 0) return [];

  const [sMin, sMax] = Array.isArray(cfg.scale) ? cfg.scale : [0.75, 1.35];
  const yawRange = cfg.yawRange ?? Math.PI * 2;

  // A FEW PLANTS IN FRONT OF THE PLAY PLANE, so the seal swims THROUGH the bed
  // rather than always in front of it. Rolled on a SEPARATE stream seeded off
  // the same number, and that is the whole reason it is not just another
  // rand() call in the loop below: every draw in that loop happens in a fixed
  // order, so slipping a new one in shifts every subsequent plant's species and
  // size. The bed would reshuffle the moment this feature was added, and again
  // the moment anyone turned it off. On its own stream, a plant either steps
  // forward or does not and nothing else about the bed changes.
  const frontShare = Math.max(0, Math.min(1, cfg.front?.share ?? 0.12));
  const frontRand = mulberry32(((cfg.seed ?? 1337) ^ 0x9e3779b9) >>> 0);

  // Every draw from `rand` happens in a fixed order per plant, so the same
  // seed gives the same bed — and adding a species to the weights changes
  // which species each plant is without moving any of them.
  const out = [];
  for (const [x, z] of points) {
    const species = pickWeighted(rand, entries, total);
    const variants = SEABED_PROPS[species];
    const variant = variants[Math.floor(rand() * variants.length)] ?? variants[0];
    out.push({
      variant: variant.id,
      species,
      x, z,
      // Which SIDE of the seal this plant stands on. A flag rather than a
      // second z, because the shift that applies it belongs with the rest of
      // the world placement in scatterSeabed — planBed deals in the sampled
      // band and nothing else, which is what lets the Node harness check the
      // layout without knowing where the play plane is.
      front: frontShare > 0 && frontRand() < frontShare,
      yaw: (rand() - 0.5) * yawRange,
      scale: sMin + rand() * (sMax - sMin),
    });
  }
  return out;
}

/**
 * Build the bed and add it to the scene.
 *
 * MUST be called after preloadAssets resolves. createVisual before the model
 * cache fills returns the procedural fallback — a green cone — and does it
 * silently; main.js has the scar tissue on this one for the eel companion and
 * the beluga drone. See decor.js's header.
 *
 * @param {THREE.Scene} scene  world.scene, NOT the backdrop group — the
 *   backdrop is disposed and rebuilt wholesale on every resize, which would
 *   take these geometries and materials with it.
 */
export function scatterSeabed(scene) {
  const cfg = CONFIG.seabed ?? {};
  clearSeabed();
  if (cfg.enabled === false) return group;

  placements = planBed(cfg, bedSpan(cfg));
  if (!placements.length) return group;

  const byVariant = new Map();
  for (const p of placements) {
    if (!byVariant.has(p.variant)) byVariant.set(p.variant, []);
    byVariant.get(p.variant).push(p);
  }

  const bedScale = cfg.bedScale ?? 1.8;
  const span = bedSpan(cfg);

  // Depth comes from plantWorldZ below. The exact figure
  // barely matters beyond its sign: the camera is ORTHOGRAPHIC (world.js), so a
  // plant at z=1 and a plant at z=5 are drawn at identical size and all z
  // decides is what occludes what. That is also why there is no scale bump to
  // sell the foreground — in a flat side view the occlusion IS the depth cue,
  // and a multiplier would be lost inside the bed's own 0.4x-2.1x spread.
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();

  for (const [variantId, list] of byVariant) {
    const baked = bakeTemplate(variantId);
    if (!baked) continue;
    // The sway masks root-to-tip on height, and assets.js could only measure
    // that off the RAW model — before fit, the orientation group and the size
    // multiplier, all three of which the bake above just folded into these
    // vertices. So the plant the shader is bending is a different size from the
    // one it was told about, and correcting it is a uniform write on a material
    // this variant does not share with anything else. Wrong here does not
    // error: the mask saturates part-way up and the top of every plant bends as
    // one rigid piece. No-ops for the shells, which carry no sway.
    setGrassSwayHeight(baked.material, baked.height);
    const mesh = new THREE.InstancedMesh(baked.geometry, baked.material, list.length);
    // One InstancedMesh spans the whole bed, so three can only cull all of it
    // or none of it — and its bounding sphere comes from the geometry alone,
    // which sits at the origin. Left on, the bed vanishes the moment the
    // camera pans. Same trade instancedPool.js takes, and for the same reason.
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.name = `seabed:${variantId}`;

    // Where each plant's stem runs, for the shove. Collected in the SAME LOOP
    // that writes the matrices rather than derived afterwards, because the
    // attribute is indexed by instance id and the two orders drifting apart is
    // an off-by-one that shoves the wrong plants and reads as bad tuning.
    const stems = [];
    list.forEach((p, i) => {
      // The band is sampled centred on (0,0) in world units, so placing it is
      // an offset and nothing else — no remap, which is the point of sampling
      // the floor's real shape instead of a disc.
      pos.set(span.centre + p.x, seabedTopY(), plantWorldZ(p, cfg));
      q.setFromAxisAngle(up, p.yaw);
      scl.setScalar(p.scale * bedScale);
      m.compose(pos, q, scl);
      mesh.setMatrixAt(i, m);
      // The instance's own scale, not the bed's: this bed runs 0.4x to 2.1x on
      // top of bedScale, so a seedling and a full-grown frond of one species
      // are five units apart at the tip and a shared height would have the seal
      // brushing thin air over half of them.
      stems.push({ x: pos.x, y0: pos.y, y1: pos.y + baked.height * scl.y });
    });
    mesh.instanceMatrix.needsUpdate = true;
    // Only the plants. A shell carries no sway material and therefore no
    // aShove attribute for this to write into — registering one would be a
    // buffer uploaded every frame to be read by nothing.
    if (baked.material?.userData?.__swayAttached) registerShovedInstances(mesh, stems);
    group.add(mesh);
  }

  scene.add(group);
  built = true;
  return group;
}

/** Every plant in the bed, as planned. For tests and for the tuner readout. */
export function bedPlacements() {
  return placements;
}

/** Rebuild at the current seabed height. Call after anything that moves bounds.bottom. */
export function reseatSeabed(scene) {
  if (!built) return;
  scatterSeabed(scene ?? group.parent);
}

/** Drop the bed and everything it owns. */
export function clearSeabed() {
  // Before the meshes go: the shove holds a reference to each one and its own
  // copy of where every plant stands, and the bed is rebuilt on every resize
  // and every tuner move of the floor. Left behind, each rebuild would leave a
  // dead set of springs integrating against geometry nobody is drawing.
  clearShovedInstances();
  for (const child of [...group.children]) {
    group.remove(child);
    child.geometry?.dispose();
    // The MATERIAL is not disposed: it belongs to the template createVisual
    // built, which the asset cache may hand to something else. Disposing it
    // here would take the texture with it and blank whatever shares it.
    child.dispose?.();
  }
  group.parent?.remove(group);
  placements = [];
  built = false;
}
