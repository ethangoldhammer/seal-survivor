import * as THREE from 'three';
import { CONFIG } from '../config.js';

// ---------------------------------------------------------------------------
// A HITBOX MEASURED OFF THE FLESH
//
// Every collision in this game is a circle: `e.radius`, one number per
// creature, and for anything roughly fish-shaped at fish scale that is the
// right call. It stops being the right call at boss scale, because the error
// stops being a rounding difference and becomes the fight. Measured on the
// shipped bodies:
//
//   bossShark (megalodon.glb)  circle r 8.10   body 12.88 long x 3.98 wide
//   bossOrca  (orca.glb)       circle r 8.57   body 12.38 long x 11.54 wide
//
// So the shark's circle is TWICE the width of the animal and two-thirds of its
// length: you shoot its nose and its tail and hit nothing, and you take fifty
// contact damage from a body-width of empty water above and below it. The orca
// is the other failure — its bind-pose box is nearly square, and that width is
// splayed pectoral fins rather than torso, which is why an axis-aligned box
// would be just as wrong in the other direction.
//
// This builds the shape from the only thing that cannot lie about where a
// creature's body is: the vertices, and which bone drives each one.
//
// WHY BONES AND NOT A BOX. Bone names lie and hierarchies lie — the same
// lesson the rig work keeps relearning — but skin weights do not, because
// they are what the GPU actually uses to put the flesh on screen. Binning
// every vertex to its dominant bone and fitting a sphere to each bin gives a
// shape that (a) came off the mesh rather than off a guess, and (b) rides the
// skeleton for free, so a shark mid-turn has a BENT hitbox and its tail sweep
// genuinely reaches. A capsule cannot do the second thing and a convex hull
// cannot do either, since a hull is the bind pose frozen.
//
// COST. The vertex pass is once per ASSET, at the first spawn, and the result
// is cached — a boss is one creature and the pass is a few hundred thousand
// vector ops. Per query it is `maxSpheres` distance tests behind a broad-phase
// circle, on the handful of creatures that opt in. Nothing else in the game
// changes shape at all.
//
// WHAT IT IS NOT. `e.radius` still exists and still means what it always
// meant: how big this animal is, for spacing, knockback, AI reach and the
// crowd. This shape is consulted for one question — did that touch the body —
// and the two are deliberately separate, because a shape that is honest about
// a shark's outline is a terrible number to space a school with.
// ---------------------------------------------------------------------------

/** @typedef {{ wx:number, wy:number, wz:number, wr:number, m:THREE.Matrix4 }} HitSphere */

// asset key -> the measured recipe. Bones are per-instance (createVisual
// clones the skeleton), so what is cached is INDICES into the clone plus the
// constant part of each sphere's transform.
const recipes = new Map();

const _v = new THREE.Vector3();
const _c = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _head = new THREE.Matrix4();
const _inv = new THREE.Matrix4();

function cfg() {
  return CONFIG.hitShape ?? {};
}

// ---------------------------------------------------------------------------
// MEASURING
// ---------------------------------------------------------------------------

// The centre and radius of one bone's share of the flesh, in GEOMETRY space —
// the raw position attribute, before any bone or instance transform touches
// it. Everything variable (the pose, the instance's scale, the boss's size
// step) is re-applied at refresh time from live matrices, so the recipe stays
// valid for a body of any size in any pose.
//
// The radius is mean + k*sigma of the distance from the centroid rather than
// the furthest vertex, and that is not a shortcut. megalodon.glb ships a
// degenerate face with a stray vertex 59 units off the body (assets.js
// documents finding it), and a max-distance radius hands that one broken
// vertex the entire hitbox. A mean plus a couple of standard deviations
// notices a shape and ignores a speck. Clamped to the real maximum so the
// statistic can never claim more than the flesh.
function fitBoneSpheres(mesh, minVerts, sigma) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const si = geo.attributes.skinIndex;
  const sw = geo.attributes.skinWeight;
  if (!pos || !si || !sw) return [];

  const boneCount = mesh.skeleton?.bones?.length ?? 0;
  if (!boneCount) return [];

  const count = pos.count;
  const owner = new Int32Array(count);
  const n = new Int32Array(boneCount);
  const sx = new Float64Array(boneCount);
  const sy = new Float64Array(boneCount);
  const sz = new Float64Array(boneCount);

  // Pass 1 — who drives this vertex, and where is each bone's cloud centred.
  for (let i = 0; i < count; i++) {
    let best = -1;
    let bestW = 0;
    // The four influences three's skinning shader reads. Dominant weight wins
    // outright rather than the vertex being shared out: a vertex on a seam
    // belongs to a sphere, not to a fraction of two, and the overlap between
    // neighbouring spheres already covers the seam.
    const w = [sw.getX(i), sw.getY(i), sw.getZ(i), sw.getW(i)];
    const b = [si.getX(i), si.getY(i), si.getZ(i), si.getW(i)];
    for (let k = 0; k < 4; k++) {
      if (w[k] > bestW && b[k] >= 0 && b[k] < boneCount) { bestW = w[k]; best = b[k]; }
    }
    owner[i] = best;
    if (best < 0) continue;
    n[best] += 1;
    sx[best] += pos.getX(i);
    sy[best] += pos.getY(i);
    sz[best] += pos.getZ(i);
  }

  for (let b = 0; b < boneCount; b++) {
    if (n[b] > 0) { sx[b] /= n[b]; sy[b] /= n[b]; sz[b] /= n[b]; }
  }

  // Pass 2 — how far the cloud reaches from its own centre.
  const sd = new Float64Array(boneCount);
  const sd2 = new Float64Array(boneCount);
  const dmax = new Float64Array(boneCount);
  for (let i = 0; i < count; i++) {
    const b = owner[i];
    if (b < 0) continue;
    const dx = pos.getX(i) - sx[b];
    const dy = pos.getY(i) - sy[b];
    const dz = pos.getZ(i) - sz[b];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    sd[b] += d;
    sd2[b] += d * d;
    if (d > dmax[b]) dmax[b] = d;
  }

  const out = [];
  for (let b = 0; b < boneCount; b++) {
    // A handful of vertices is an eyeball, a tooth or a stray — not a piece of
    // body worth a collision test.
    if (n[b] < minVerts) continue;
    const mean = sd[b] / n[b];
    const varr = Math.max(0, sd2[b] / n[b] - mean * mean);
    const r = Math.min(dmax[b], mean + sigma * Math.sqrt(varr));
    if (!(r > 0)) continue;
    out.push({ bone: b, cx: sx[b], cy: sy[b], cz: sz[b], r });
  }
  return out;
}

// Slice a rigid (unskinned) body along its own forward axis instead. The same
// idea one dimension down: without bones there is nothing for the shape to
// ride, so it is a static chain of spheres down the length of the model. This
// is what a creature with no skeleton gets, and it is still strictly better
// than one circle for anything longer than it is wide.
function fitAxisSpheres(mesh, slices) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  if (!pos) return [];
  geo.computeBoundingBox();
  const box = geo.boundingBox;
  if (!box) return [];

  // Local +Y is forward for every creature in this project — createVisual
  // builds them nose-up. So the long axis of a swimmer is Y, and slicing along
  // it is slicing the body from nose to tail.
  const lo = box.min.y;
  const hi = box.max.y;
  const span = hi - lo;
  if (!(span > 0)) return [];

  const n = new Int32Array(slices);
  const sx = new Float64Array(slices);
  const sy = new Float64Array(slices);
  const sz = new Float64Array(slices);
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) - lo) / span;
    const s = Math.min(slices - 1, Math.max(0, Math.floor(t * slices)));
    n[s] += 1; sx[s] += pos.getX(i); sy[s] += pos.getY(i); sz[s] += pos.getZ(i);
  }
  for (let s = 0; s < slices; s++) if (n[s]) { sx[s] /= n[s]; sy[s] /= n[s]; sz[s] /= n[s]; }

  const sd = new Float64Array(slices);
  const sd2 = new Float64Array(slices);
  const dmax = new Float64Array(slices);
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) - lo) / span;
    const s = Math.min(slices - 1, Math.max(0, Math.floor(t * slices)));
    const dx = pos.getX(i) - sx[s];
    const dy = pos.getY(i) - sy[s];
    const dz = pos.getZ(i) - sz[s];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    sd[s] += d; sd2[s] += d * d; if (d > dmax[s]) dmax[s] = d;
  }

  const out = [];
  for (let s = 0; s < slices; s++) {
    if (n[s] < 8) continue;
    const mean = sd[s] / n[s];
    const varr = Math.max(0, sd2[s] / n[s] - mean * mean);
    const r = Math.min(dmax[s], mean + 1.6 * Math.sqrt(varr));
    if (r > 0) out.push({ bone: -1, cx: sx[s], cy: sy[s], cz: sz[s], r });
  }
  return out;
}

// Cut the candidate list down to something worth testing every frame.
//
// THE BUDGET IS THE PROBLEM, and it is what the first two attempts at this
// both got wrong in the same direction. megalodon.glb offers thirty candidate
// spheres and twelve get kept, so the rule that picks them decides which two
// thirds of a shark you can shoot.
//
//   Attempt one: keep the LARGEST twelve. The spine bones down a shark's tail
//   are exactly the small ones, so the size rank cut them first and 6.2 of the
//   animal's 16.1 units came out unhittable — a worse hitbox than the circle
//   it replaced over that stretch, and one that looks perfect in a screenshot.
//
//   Attempt two: greedy maximum coverage — repeatedly take whichever sphere
//   swallows the most others. Correct with an unlimited budget and no better
//   than the size rank with this one, because a dense cluster of overlapping
//   torso spheres scores highest every round and the tail, whose spheres cover
//   nothing but themselves, never gets a turn. It selected the same twelve.
//
// So the rule is REACH, not coverage or size: each round takes the candidate
// whose centre sits furthest OUTSIDE everything kept so far. The first pick is
// the biggest sphere in the body, the second is inevitably the far tail — the
// point furthest from it — and every pick after that lands in the largest
// remaining hole. Run out of budget and what you have is an even spread over
// the whole animal, which is the right way to run out. Run to completion and
// every candidate centre is inside the shape, which is the stopping rule.
//
// Fins and jaw furniture come last for free: their centres sit close to the
// torso spheres that are already there, so they have almost no reach to offer
// until the body itself is whole.
//
// RUN ON THE RESOLVED, LIVE SPHERES — world positions, at rest, on a real
// instance — and not on the recipe's geometry-space numbers. That is the third
// thing this function got wrong before it got right: a model's own geometry
// axes are not the arena's (createVisual rotates every body to point nose-up,
// so "forward" in the raw position attribute can be any axis at all), and the
// fit scale does not live on the visual root either, so there is no single
// cheap matrix that turns a geometry-space centre into an arena-plane one.
// Resolving first and pruning second sidesteps the whole question: reach
// comparisons are unchanged by where the body happens to be standing.
//
// Returns INDICES into `list`, which the caller caches on the recipe — the
// pick is a property of the model, so the second instance of an asset skips
// this entirely.
function prune(list, maxSpheres) {
  if (list.length === 0) return [];

  // Ordered biggest first, which is both the seed and the tie-break.
  const order = list.map((_, i) => i).sort((a, b) => list[b].wr - list[a].wr);

  // Seeded with the biggest, which for every body in this project is the
  // middle of the torso. Seeding with the reach rule instead would start at
  // whichever extremity happens to be furthest from the model origin, and the
  // origin is not the animal's centre — on megalodon.glb it sits up near the
  // head, with the body running from +2.4 to -13.7 behind it.
  const keep = [order[0]];
  const taken = new Set(keep);

  while (keep.length < maxSpheres) {
    let bestIdx = -1;
    let bestGap = 0; // strictly positive, so a centre already inside the shape never wins
    for (const i of order) {
      if (taken.has(i)) continue;
      const s = list[i];
      let gap = Infinity;
      for (const ki of keep) {
        const k = list[ki];
        // MEASURED FLAT: the hit test is 2D, z here is a drawing lane rather
        // than somewhere you can dodge to, so two spheres that differ only in
        // depth are the same spot as far as anything will ever ask. Measuring
        // reach in 3D spent four of the orca's twelve slots on pectoral fins
        // splayed to z +/-4.8 that project straight onto its own torso, while
        // the middle of its tail went uncovered.
        const dx = s.wx - k.wx, dy = s.wy - k.wy;
        const d = Math.sqrt(dx * dx + dy * dy) - k.wr;
        if (d < gap) gap = d;
      }
      // `order` is biggest-first and the comparison is strict, so equal reach
      // keeps the bigger sphere with no explicit tie-break.
      if (gap > bestGap) { bestGap = gap; bestIdx = i; }
    }
    if (bestIdx < 0) break; // everything left is already inside the shape
    taken.add(bestIdx);
    keep.push(bestIdx);
  }
  return keep;
}

// Measure a body once. `visual` is any instance — they are all clones of one
// template, so the geometry and the bone ORDER are identical and only the bone
// objects differ.
function buildRecipe(visual, key) {
  const c = cfg();
  const minVerts = Math.max(1, c.minVertsPerBone ?? 12);
  const sigma = c.sigma ?? 1.6;
  const maxSpheres = Math.max(1, c.maxSpheres ?? 12);
  const minFrac = c.minRadiusFrac ?? 0.16;

  const meshes = [];
  visual.traverse((o) => { if (o.isMesh) meshes.push(o); });

  const parts = [];
  for (let mi = 0; mi < meshes.length; mi++) {
    const mesh = meshes[mi];
    const skinned = mesh.isSkinnedMesh && mesh.skeleton?.bones?.length > 0;
    const spheres = skinned
      ? fitBoneSpheres(mesh, minVerts, sigma)
      : fitAxisSpheres(mesh, Math.max(2, c.axisSlices ?? 6));
    if (spheres.length === 0) continue;
    parts.push({ meshIndex: mi, skinned, spheres });
  }
  if (parts.length === 0) return null;

  // One flat candidate list ACROSS meshes, not one per mesh. A model split
  // into body / fins / teeth would otherwise keep its full quota of teeth.
  const flat = [];
  for (const p of parts) for (const s of p.spheres) flat.push({ ...s, meshIndex: p.meshIndex, skinned: p.skinned });

  // The only filter applied here. Everything under `minFrac` of the body's
  // biggest sphere is an eyelid, a tooth or a fin tip: most of the list and
  // none of the animal. WHICH of the survivors are worth testing every frame
  // is decided later, on resolved world positions — see prune.
  let biggest = 0;
  for (const s of flat) if (s.r > biggest) biggest = s.r;
  const cand = flat.filter((s) => s.r >= biggest * minFrac)
    .sort((a, b) => b.r - a.r);
  if (cand.length === 0) return null;

  // `keep` is filled in by the first instance to attach and reused by every
  // one after it — the pick is a property of the model, not of the individual.
  const recipe = { key, candidates: cand, keep: null, maxSpheres, meshCount: meshes.length };
  if (c.log) {
    console.log(`[hitShape] "${key}": ${cand.length} candidate spheres from ${flat.length} bone bins`);
  }
  return recipe;
}

// ---------------------------------------------------------------------------
// ATTACHING
// ---------------------------------------------------------------------------

/**
 * Give a creature a measured hitbox. Cheap on every call after the first for a
 * given asset, and free on every call after the first for a given BODY —
 * visuals are pooled (see assets.js), and a recycled body still has the same
 * bones the shape was resolved against.
 *
 * @param {THREE.Object3D} visual the model instance (e.visual)
 * @param {string} key            the asset key, for the recipe cache
 * @returns {object|null}
 */
export function attachHitShape(visual, key) {
  if (!visual || cfg().enabled === false) return null;

  const cached = visual.userData.__hitShape;
  if (cached && cached.key === key) { cached.alive = true; cached.stamp = -1; return cached; }

  let recipe = recipes.get(key);
  if (recipe === undefined) {
    recipe = buildRecipe(visual, key);
    recipes.set(key, recipe); // null is cached too — a body with no measurable flesh must not be re-measured every spawn
  }
  if (!recipe) return null;

  // Resolve the recipe's indices against THIS body. Traversal order is stable
  // across clones (cloneSafe walks the same hierarchy), which is what makes an
  // index a safe thing to have cached.
  const meshes = [];
  visual.traverse((o) => { if (o.isMesh) meshes.push(o); });
  if (meshes.length !== recipe.meshCount) return null;

  const resolve = (s) => {
    const mesh = meshes[s.meshIndex];
    if (!mesh) return null;
    const bone = s.skinned ? mesh.skeleton.bones[s.bone] : null;
    if (s.skinned && !bone) return null;
    return {
      mesh,
      bone,
      // The constant half of the transform: bind pose into the bone's own
      // space. The variable half (where that bone is now, and how big this
      // individual is) is rebuilt every refresh.
      pre: s.skinned ? new THREE.Matrix4().multiplyMatrices(mesh.skeleton.boneInverses[s.bone], mesh.bindMatrix) : null,
      cx: s.cx, cy: s.cy, cz: s.cz,
      r: s.r,
      // Live world values, rewritten by refreshHitShape.
      wx: 0, wy: 0, wz: 0, wr: s.r,
      m: new THREE.Matrix4(),
    };
  };

  const shape = {
    key,
    visual,
    spheres: [],
    bound: 0,
    stamp: -1,
    alive: true,
    // Set only on the first body of an asset, and cleared by the refresh that
    // does the pruning.
    recipe: null,
  };

  if (recipe.keep) {
    for (const i of recipe.keep) {
      const s = resolve(recipe.candidates[i]);
      if (s) shape.spheres.push(s);
    }
  } else {
    // FIRST BODY OF THIS ASSET, and the only one that pays for the pick: every
    // candidate is resolved, and the prune runs at the first REFRESH rather
    // than here.
    //
    // Not here, because here is too early. attachHitShape is called from
    // inside spawnOne while the creature object is still being built, and the
    // prune has to work on where the spheres actually are (see the note on
    // prune) — which means posed bones under a body that is properly parented
    // and whose world matrices are current. Pruning at this moment produced a
    // shark whose spheres measured out at y 32 to 116 against a body that
    // occupies y -13.7 to 2.4: bind matrices from the template against world
    // matrices from a body not yet in the scene. It failed silently, because
    // a nonsense set of spheres still prunes to a plausible-looking twelve.
    for (let i = 0; i < recipe.candidates.length; i++) {
      const s = resolve(recipe.candidates[i]);
      if (s) { s.ci = i; shape.spheres.push(s); }
    }
    shape.recipe = recipe;
  }
  if (shape.spheres.length === 0) return null;

  visual.userData.__hitShape = shape;
  sweepShapes();
  liveShapes.add(shape);
  return shape;
}

/** A recycled body's shape is stale, not wrong — this re-arms it. */
export function releaseHitShape(shape) {
  if (shape) shape.alive = false;
}

// ---------------------------------------------------------------------------
// REFRESHING
// ---------------------------------------------------------------------------

let frameStamp = 0;

/** Called once a frame by the game loop, so a shape refreshes at most once. */
export function tickHitShapes() {
  frameStamp += 1;
}

/**
 * Bring a shape's spheres up to date with where the body actually is this
 * frame. Idempotent within a frame — combat asks several times per boss (once
 * per projectile in range) and the second ask through is a stamp comparison.
 */
export function refreshHitShape(shape) {
  if (!shape || shape.stamp === frameStamp) return shape;
  shape.stamp = frameStamp;

  // The whole subtree, once. Reading bone matrices without this measures every
  // pose as identical — the trap the skinning harness documents — and doing it
  // per bone would walk the same parent chain a dozen times.
  shape.visual.updateWorldMatrix(true, true);

  let lastMesh = null;
  let bound = 0;
  const ox = shape.visual.matrixWorld.elements[12];
  const oy = shape.visual.matrixWorld.elements[13];

  for (const s of shape.spheres) {
    if (s.bone) {
      // worldPos = (mesh.matrixWorld * bindMatrixInverse) * bone.matrixWorld * (boneInverse * bindMatrix) * geomPos
      //
      // That leading pair is three's own skinning transform, not a flourish:
      // for an attached bind mode it is identity at bind time and becomes the
      // instance's scale afterwards — which is exactly how a boss that was
      // scaled 1.6x after spawning gets a 1.6x hitbox with nothing here
      // knowing a boss exists.
      if (s.mesh !== lastMesh) {
        _head.multiplyMatrices(s.mesh.matrixWorld, s.mesh.bindMatrixInverse);
        lastMesh = s.mesh;
      }
      s.m.multiplyMatrices(_head, s.bone.matrixWorld).multiply(s.pre);
    } else {
      s.m.copy(s.mesh.matrixWorld);
    }

    _c.set(s.cx, s.cy, s.cz).applyMatrix4(s.m);
    s.wx = _c.x; s.wy = _c.y; s.wz = _c.z;

    // Uniform scale is assumed, which every creature in this project has —
    // the fit, the tuner's Size slider and the boss step are all scalars.
    const e = s.m.elements;
    s.wr = s.r * Math.sqrt(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]);

    const dx = s.wx - ox, dy = s.wy - oy;
    const d = Math.sqrt(dx * dx + dy * dy) + s.wr;
    if (d > bound) bound = d;
  }
  // The broad phase measured on the POSE, so a body curled into a turn gets a
  // tighter early-out than one stretched out straight.
  shape.bound = bound;

  // THE PICK, once per asset, on the first refresh of the first body — the
  // earliest moment at which the spheres are posed, parented and current. See
  // attachHitShape for why it cannot happen at spawn.
  if (shape.recipe && !shape.recipe.keep) {
    const all = shape.spheres;
    const keep = prune(all, shape.recipe.maxSpheres);
    shape.recipe.keep = keep.map((i) => all[i].ci);
    shape.spheres = keep.map((i) => all[i]);
    shape.recipe = null;
    if (cfg().log) {
      console.log(`[hitShape] "${shape.key}": kept ${shape.spheres.length} of ${all.length}, in pick order:`);
      shape.spheres.forEach((s, i) => console.log(
        `  ${String(i).padStart(2)}  x ${s.wx.toFixed(2).padStart(7)}  y ${s.wy.toFixed(2).padStart(7)}  r ${s.wr.toFixed(2)}  ${s.bone?.name ?? '(rigid)'}`,
      ));
    }
    // Recomputed over the survivors, or the broad phase would keep whatever
    // the widest DISCARDED sphere reached — a fin tip, usually, and an
    // early-out that is too generous is invisible rather than wrong.
    bound = 0;
    for (const s of shape.spheres) {
      const dx = s.wx - ox, dy = s.wy - oy;
      const d = Math.sqrt(dx * dx + dy * dy) + s.wr;
      if (d > bound) bound = d;
    }
    shape.bound = bound;
  }
  return shape;
}

// ---------------------------------------------------------------------------
// ASKING
// ---------------------------------------------------------------------------

/**
 * Did a circle at (x, y) touch the body?
 *
 * Flattened to the arena plane — z is a drawing lane here, not a dimension you
 * can dodge in, and every other collision test in the game already ignores it.
 *
 * On a hit, `out` is filled with where on the SURFACE it landed and which way
 * that surface faces, which is what the impact effects are drawn from. The
 * contact point is on the sphere the shot actually reached, so a hit on the
 * tail draws at the tail — the thing a single circle could never tell you.
 *
 * @param {object} shape
 * @param {number} x
 * @param {number} y
 * @param {number} r      radius of the thing doing the hitting
 * @param {object} [out]  { x, y, nx, ny, depth, sphere, index }
 * @returns {boolean}
 */
export function hitShapeTest(shape, x, y, r = 0, out = null) {
  if (!shape) return false;
  refreshHitShape(shape);

  const pad = cfg().padding ?? 1;
  let bestGap = Infinity;
  let best = null;
  let bestIdx = -1;

  for (let i = 0; i < shape.spheres.length; i++) {
    const s = shape.spheres[i];
    const sr = s.wr * pad;
    const dx = x - s.wx;
    const dy = y - s.wy;
    const d2 = dx * dx + dy * dy;
    const reach = sr + r;
    if (d2 > reach * reach) continue;
    const gap = Math.sqrt(d2) - sr; // negative once inside the body
    if (gap < bestGap) { bestGap = gap; best = s; bestIdx = i; }
  }

  if (!best) return false;
  if (!out) return true;

  const sr = best.wr * pad;
  let dx = x - best.wx;
  let dy = y - best.wy;
  let d = Math.sqrt(dx * dx + dy * dy);
  if (d < 1e-5) {
    // Dead centre of a sphere — a shot that made it inside before anything
    // tested it. There is no surface direction to read off the geometry, so
    // the caller's travel direction stands in (filled by the caller when it
    // has one; straight up otherwise, which never happens twice in a row).
    dx = 0; dy = 1; d = 1;
  }
  const nx = dx / d;
  const ny = dy / d;
  out.nx = nx;
  out.ny = ny;
  // ON THE SKIN, not at the projectile. A shell travelling 40 units a second
  // moves two thirds of a metre between frames, so the position it was at when
  // the test passed is already inside the animal — drawing there buries the
  // impact in the body.
  out.x = best.wx + nx * sr;
  out.y = best.wy + ny * sr;
  out.depth = Math.max(0, sr - d);
  out.sphere = best;
  out.index = bestIdx;
  return true;
}

/**
 * The same question with no shape involved, so callers can have one code path.
 * Falls back to the circle every creature has always used.
 */
export function hitCreature(e, x, y, r = 0, out = null) {
  if (e.hitShape?.alive) {
    // Broad phase first. `bound` is the posed extent of the measured body, NOT
    // e.radius — see buildRecipe.
    const dx = x - e.mesh.position.x;
    const dy = y - e.mesh.position.y;
    refreshHitShape(e.hitShape);
    const reach = e.hitShape.bound * (cfg().padding ?? 1) + r;
    if (dx * dx + dy * dy > reach * reach) return false;
    return hitShapeTest(e.hitShape, x, y, r, out);
  }

  const reach = e.radius + r;
  const dx = x - e.mesh.position.x;
  const dy = y - e.mesh.position.y;
  const d2 = dx * dx + dy * dy;
  if (d2 > reach * reach) return false;
  if (out) {
    const d = Math.sqrt(d2) || 1;
    out.nx = dx / d;
    out.ny = dy / d;
    out.x = e.mesh.position.x + out.nx * e.radius;
    out.y = e.mesh.position.y + out.ny * e.radius;
    out.depth = Math.max(0, e.radius - d);
    out.sphere = null;
    out.index = -1;
  }
  return true;
}

// Squared distance from a point to a segment, and where along it the nearest
// point sits. The same maths club.js already does — a swung weapon is a swept
// line, not a position, or a fast swing steps straight over a small fish
// between frames — lifted here so the segment can be tested against a measured
// body instead of against one circle.
function segClosest(px, py, ax, ay, bx, by, out) {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 1e-9 ? Math.min(1, Math.max(0, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
  out.x = ax + vx * t;
  out.y = ay + vy * t;
  const dx = px - out.x;
  const dy = py - out.y;
  return dx * dx + dy * dy;
}

const _seg = { x: 0, y: 0 };

/**
 * Did a swept circle of radius `r`, travelling from (ax, ay) to (bx, by),
 * touch the body? For clubs and anything else that hits along a line.
 *
 * `out` is filled the same way hitCreature fills it, with one difference worth
 * knowing: the contact point is on the sphere nearest the SWING, so a club
 * that catches a shark across the flank marks the flank rather than marking
 * wherever the shark's origin happens to be.
 */
export function hitCreatureSegment(e, ax, ay, bx, by, r = 0, out = null) {
  if (e.hitShape?.alive) {
    const shape = e.hitShape;
    refreshHitShape(shape);
    const pad = cfg().padding ?? 1;

    // Broad phase against the whole posed body, so a swing nowhere near the
    // animal costs one segment test rather than twelve.
    const bound = shape.bound * pad + r;
    if (segClosest(e.mesh.position.x, e.mesh.position.y, ax, ay, bx, by, _seg) > bound * bound) return false;

    let bestGap = Infinity;
    let best = null;
    let bestIdx = -1;
    let bestPx = 0;
    let bestPy = 0;
    for (let i = 0; i < shape.spheres.length; i++) {
      const s = shape.spheres[i];
      const sr = s.wr * pad;
      const d2 = segClosest(s.wx, s.wy, ax, ay, bx, by, _seg);
      const reach = sr + r;
      if (d2 > reach * reach) continue;
      const gap = Math.sqrt(d2) - sr;
      if (gap < bestGap) { bestGap = gap; best = s; bestIdx = i; bestPx = _seg.x; bestPy = _seg.y; }
    }
    if (!best) return false;
    if (!out) return true;

    const sr = best.wr * pad;
    let dx = bestPx - best.wx;
    let dy = bestPy - best.wy;
    let d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1e-5) { dx = bx - ax; dy = by - ay; d = Math.sqrt(dx * dx + dy * dy) || 1; }
    out.nx = dx / d;
    out.ny = dy / d;
    out.x = best.wx + out.nx * sr;
    out.y = best.wy + out.ny * sr;
    out.depth = Math.max(0, sr - d);
    out.sphere = best;
    out.index = bestIdx;
    return true;
  }

  const reach = e.radius + r;
  const d2 = segClosest(e.mesh.position.x, e.mesh.position.y, ax, ay, bx, by, _seg);
  if (d2 > reach * reach) return false;
  if (out) {
    const px = _seg.x;
    const py = _seg.y;
    let dx = px - e.mesh.position.x;
    let dy = py - e.mesh.position.y;
    let d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1e-5) { dx = bx - ax; dy = by - ay; d = Math.sqrt(dx * dx + dy * dy) || 1; }
    out.nx = dx / d;
    out.ny = dy / d;
    out.x = e.mesh.position.x + out.nx * e.radius;
    out.y = e.mesh.position.y + out.ny * e.radius;
    out.depth = Math.max(0, e.radius - d);
    out.sphere = null;
    out.index = -1;
  }
  return true;
}

/**
 * Turn a world point on (or near) a body into something that will still be on
 * that body several seconds and one tail-beat later. Used by the wound decals:
 * a mark stored as a world position slides off the animal the instant it moves.
 */
export function worldToShapeLocal(shape, index, x, y, z, out) {
  const s = shape?.spheres?.[index];
  if (!s) return false;
  _inv.copy(s.m).invert();
  _v.set(x, y, z).applyMatrix4(_inv);
  out.x = _v.x; out.y = _v.y; out.z = _v.z;
  return true;
}

/** The inverse, per frame, for anything anchored by worldToShapeLocal. */
export function shapeLocalToWorld(shape, index, lx, ly, lz, out) {
  const s = shape?.spheres?.[index];
  if (!s) return false;
  refreshHitShape(shape);
  _v.set(lx, ly, lz).applyMatrix4(s.m);
  out.x = _v.x; out.y = _v.y; out.z = _v.z;
  return true;
}

/** For the debug overlay and the test harness. */
export function hitShapeSpheres(shape) {
  if (!shape) return [];
  refreshHitShape(shape);
  return shape.spheres;
}

/** Drop every measurement. Called when models are swapped under the game. */
export function clearHitShapeCache() {
  recipes.clear();
}

// ---------------------------------------------------------------------------
// SEEING IT
//
// A hitbox you cannot look at is a hitbox you are guessing about, and the
// whole argument for measuring one off the mesh is that guessing is what went
// wrong. CONFIG.hitShape.debug draws every live sphere as a ring, on top of
// everything, so "does the shape match the animal" is a question you answer by
// looking rather than by playing.
//
// Instanced, one draw call, and it allocates nothing while switched off.
// ---------------------------------------------------------------------------

// Every attached shape, so the overlay can find them without importing the
// enemy list (which imports this file).
//
// Bounded rather than unbounded: a shape lives on its visual and visuals are
// pooled, so re-attaching to a recycled body hands back the same object and
// the set stops growing on its own — but a body disposed past the pool cap
// would otherwise be held here forever by a debugging aid nobody switched on.
// Swept when it gets large, dropping the ones whose creature is gone.
const liveShapes = new Set();
const SHAPE_REGISTRY_CAP = 96;

function sweepShapes() {
  if (liveShapes.size < SHAPE_REGISTRY_CAP) return;
  for (const s of liveShapes) if (!s.alive) liveShapes.delete(s);
}

let debugGroup = null;
let debugMesh = null;
const DEBUG_MAX = 64;

export function initHitShapeDebug(scene) {
  debugGroup = new THREE.Group();
  debugGroup.frustumCulled = false;
  debugGroup.visible = false;
  scene.add(debugGroup);
}

function buildDebugMesh() {
  // A ring, not a disc: a filled circle over a creature hides the creature,
  // and what is being checked is where the EDGE of the hitbox falls against
  // the edge of the animal.
  const geo = new THREE.RingGeometry(0.94, 1, 32);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x36ff9a,
    transparent: true,
    opacity: 0.55,
    depthTest: false,
    depthWrite: false,
  });
  debugMesh = new THREE.InstancedMesh(geo, mat, DEBUG_MAX);
  debugMesh.frustumCulled = false;
  debugMesh.renderOrder = 999;
  debugMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  debugGroup.add(debugMesh);
}

const _dm = new THREE.Matrix4();

export function updateHitShapeDebug() {
  if (!debugGroup) return;
  const on = cfg().debug === true;
  debugGroup.visible = on;
  if (!on) return;
  if (!debugMesh) buildDebugMesh();

  let n = 0;
  for (const shape of liveShapes) {
    if (!shape.alive || n >= DEBUG_MAX) continue;
    refreshHitShape(shape);
    const pad = cfg().padding ?? 1;
    for (const s of shape.spheres) {
      if (n >= DEBUG_MAX) break;
      // Drawn at the PADDED radius, because that is the shape that is actually
      // tested. An overlay showing the honest fit while combat uses the padded
      // one would be a debugging tool that lies by a few percent, which is
      // worse than none.
      _dm.makeScale(s.wr * pad, s.wr * pad, 1);
      _dm.setPosition(s.wx, s.wy, 0.6);
      debugMesh.setMatrixAt(n, _dm);
      n += 1;
    }
  }
  // Unused slots parked at zero scale rather than left holding last frame's
  // ring — an InstancedMesh has no notion of a slot being empty.
  _dm.makeScale(0, 0, 0);
  for (let i = n; i < DEBUG_MAX; i++) debugMesh.setMatrixAt(i, _dm);
  debugMesh.count = DEBUG_MAX;
  debugMesh.instanceMatrix.needsUpdate = true;
}
