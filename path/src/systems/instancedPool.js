import * as THREE from 'three';

// ---------------------------------------------------------------------------
// One draw call per shape, instead of one per object.
//
// Chum is the worst offender in the game by count: CONFIG.pickups.maxAlive is
// 140, every orb was its own Mesh in the scene, and each of those is a draw
// call with its own uniform block — for a stone with 80 faces. Across a busy
// arena that is more draws spent on litter on the seabed than on every
// creature in the water put together.
//
// THE MESH STAYS. acquire() takes the Mesh createVisual already built and
// hands the same object straight back, minus the scene membership. It is then
// a pure transform holder: everything that reads `orb.mesh.position`, writes
// `orb.mesh.scale`, or calls updateTumble on it carries on working untouched,
// because all of those are Object3D properties that never needed a scene. Only
// the two lines that said `scene.add` and `scene.remove` change.
//
// The cost of that trick is that nothing draws until flush() copies the
// transforms into the instance buffer, so flush has to run every frame, late,
// after everything that moves an orb has had its turn.
//
// FRUSTUM CULLING IS GIVEN UP, on purpose. One InstancedMesh spans the whole
// arena, so three can only cull all of it or none of it — and a bounding
// sphere built from the geometry alone (which is all three has) sits at the
// origin and would cull the lot the moment the camera panned. It is a good
// trade at these sizes: 140 orbs of 80 faces is 34k vertices for one draw,
// against 140 draws for the half of them that happen to be on screen.
// ---------------------------------------------------------------------------

// Instance buffers can't grow, so a full group is rebuilt at twice the size.
// Starting small keeps the common case (a handful of variants in play, most of
// them holding two or three orbs) from allocating for a worst case that only
// ever lands on one of them.
const START = 32;

const _color = new THREE.Color();

/**
 * @param {THREE.Scene} scene
 * @param {string} name  shows up in the scene graph; debugging only
 */
export function createInstancedPool(scene, name = 'instances') {
  // Keyed by geometry, because that is what an InstancedMesh cannot vary
  // between its instances. Rock assets hand out one of N pre-built variants per
  // spawn (assets.js getRockGeometry), so a pool of 10 variants is 10 groups —
  // still 10 draws where there were 140.
  //
  // Keyed by the geometry OBJECT, not by an asset name, which is what makes
  // this survive the tuner: editing CONFIG.rocks disposes the variant pool and
  // builds a new one, so new orbs simply arrive with a geometry this map has
  // never seen and get a group of their own. The old group drains as its orbs
  // are collected and is dropped when it empties.
  const groups = new Map();

  function groupFor(mesh) {
    const key = mesh.geometry;
    let g = groups.get(key);
    if (!g) {
      g = { mesh: null, capacity: 0, proxies: [], material: mesh.material, colored: false };
      groups.set(key, g);
      grow(g, key, START);
    }
    return g;
  }

  function grow(g, geometry, capacity) {
    const old = g.mesh;
    const next = new THREE.InstancedMesh(geometry, g.material, capacity);
    next.name = `${name}:${capacity}`;
    next.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // See the note at the top — one mesh spanning the arena can only be culled
    // whole, and three would cull it against a bounding sphere at the origin.
    next.frustumCulled = false;
    next.count = 0;
    if (g.colored) {
      next.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      next.instanceColor.setUsage(THREE.DynamicDrawUsage);
      // White FIRST, then the old colours over the top. instanceColor
      // multiplies into the vertex colour, so the zeros a fresh Float32Array
      // arrives full of are black — every slot past the copied region would
      // come out unlit until something happened to set it.
      next.instanceColor.array.fill(1);
      if (old?.instanceColor) {
        next.instanceColor.array.set(old.instanceColor.array.subarray(0, g.capacity * 3));
      }
    }
    if (old) {
      scene.remove(old);
      // The geometry and material are the asset's, shared with every other
      // group and with anything else holding this key — only the instance
      // buffers belong to this mesh, and dispose() is what frees them.
      old.dispose();
    }
    scene.add(next);
    g.mesh = next;
    g.capacity = capacity;
  }

  /**
   * Take a Mesh out of scene-membership and into the instance buffer. Returns
   * the same mesh, so the caller's own bookkeeping needs no changes.
   */
  function acquire(mesh) {
    const g = groupFor(mesh);
    if (g.proxies.length >= g.capacity) grow(g, mesh.geometry, g.capacity * 2);
    mesh.userData.__poolSlot = g.proxies.length;
    mesh.userData.__poolKey = mesh.geometry;
    g.proxies.push(mesh);
    return mesh;
  }

  /** Give the slot back. Safe to call on a mesh that was never acquired. */
  function release(mesh) {
    const key = mesh?.userData?.__poolKey;
    const g = key && groups.get(key);
    if (!g) return;
    const slot = mesh.userData.__poolSlot;
    const last = g.proxies.length - 1;
    // Swap-remove, so releasing an orb in the middle of a pile doesn't shuffle
    // every slot behind it. The mesh that moves has to be told where it went.
    if (slot !== last) {
      g.proxies[slot] = g.proxies[last];
      g.proxies[slot].userData.__poolSlot = slot;
    }
    g.proxies.pop();
    mesh.userData.__poolKey = null;
    if (g.proxies.length === 0) {
      scene.remove(g.mesh);
      g.mesh.dispose();
      groups.delete(key);
    }
  }

  /**
   * Per-instance tint. Without this every orb of one asset shares a single
   * material colour, so the last one to spawn decided the colour of all of
   * them — which is why spawnXpOrb used to be able to set a tier colour only
   * when the player had not tinted the asset themselves.
   */
  function setColor(mesh, hex) {
    const key = mesh?.userData?.__poolKey;
    const g = key && groups.get(key);
    if (!g) return;
    if (!g.colored) {
      g.colored = true;
      g.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(g.capacity * 3), 3);
      g.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      // Everything already in the buffer predates the colour attribute and
      // would come out black, since instanceColor multiplies into the vertex
      // colour. White is the identity.
      g.mesh.instanceColor.array.fill(1);
    }
    // Through Color rather than by unpacking the hex by hand: `set` applies
    // the renderer's colour management, so this lands in the same working
    // space material.color would have, and a tier colour doesn't come out
    // brighter as an instance than it did as a mesh.
    _color.set(hex);
    _color.toArray(g.mesh.instanceColor.array, mesh.userData.__poolSlot * 3);
    g.mesh.instanceColor.needsUpdate = true;
  }

  /**
   * Copy every live transform into the instance buffers. Once per frame, late
   * — after everything that can move, scale or spin one of these has run.
   */
  function flush() {
    for (const g of groups.values()) {
      const n = g.proxies.length;
      for (let i = 0; i < n; i++) {
        const m = g.proxies[i];
        m.updateMatrix();
        g.mesh.setMatrixAt(i, m.matrix);
      }
      g.mesh.count = n;
      if (n > 0) {
        // Only the live slots. A bare needsUpdate re-sends the whole capacity
        // every frame, which for a group that grew to hold one busy variant is
        // most of a megabyte of matrices to move a dozen orbs.
        g.mesh.instanceMatrix.addUpdateRange(0, n * 16);
        g.mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /** Drop everything — a run ending. */
  function reset() {
    for (const g of groups.values()) {
      for (const m of g.proxies) m.userData.__poolKey = null;
      scene.remove(g.mesh);
      g.mesh.dispose();
    }
    groups.clear();
  }

  /** Live instances, and the draws they cost. Diagnostics only. */
  function stats() {
    let instances = 0;
    for (const g of groups.values()) instances += g.proxies.length;
    return { instances, draws: groups.size };
  }

  return { acquire, release, setColor, flush, reset, stats };
}
