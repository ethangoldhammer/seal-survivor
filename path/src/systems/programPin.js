// ---------------------------------------------------------------------------
// THE LAST MATERIAL OF A KIND IS NEVER DISPOSED
//
// three caches compiled programs by cache key and refcounts them: every
// material that gets drawn does `++program.usedTimes`, and `material.dispose()`
// does `--usedTimes` and DELETES the program when it reaches zero. So a family
// of materials that all die at the same moment takes its shader down with it,
// and the next one of that kind pays for the link again — on the main thread,
// on the frame it appears.
//
// WHAT THE RUNS SAID. `npm run perf` counts program builds by three's own
// program ids and separately counts how many of those keys it had already seen
// this run. On 9/5 that split read:
//
//     local, 11:46      130 distinct keys   113 rebuilds
//     local, 10:14       92 distinct keys    55 rebuilds
//     phone, 0:38        52 distinct keys    13 rebuilds   worst frame 907ms
//
// Roughly half of every mid-run shader link in this game was a program that had
// already been compiled once, thrown away, and compiled again. The boot warm-up
// (systems/shaderWarmup.js) cannot help with any of it — the whole point of
// that file is that the program WAS warm, and something released it.
//
// WHY THE OWNERS ARE ALL RIGHT TO DISPOSE. Every call site this replaces has a
// good reason for the dispose it was doing: a bomb's flame material is per bomb
// because two bombs must gutter out of phase, a wreck's chunks share a kit that
// goes with the last chunk, a boat's flag is its own quad. None of them is
// leaking and none of them should hold its material forever. The thing that
// must be held forever is one material PER PROGRAM FAMILY, and no single system
// is in a position to know it is the last one alive.
//
// SO THAT IS ALL THIS DOES. `retireMaterial(m)` is `m.dispose()` except that the
// first material of a family to come through is kept instead — alive, off the
// scene, referenced by nothing but the map below. Its usedTimes never reaches
// zero, so the program survives every subsequent create/destroy cycle and every
// later one of its kind gets the cached program for free.
//
// THE COST IS ONE MATERIAL PER FAMILY, FOREVER, and that is the honest way to
// describe it: a few dozen objects and whatever textures they reference. The
// textures are the part worth watching, which is why the pin drops the maps it
// can (see `stripMaps`) — the program's cache key only cares THAT there was a
// map, not which one, so a pinned material can keep the shape of its shader
// without keeping a 1024-square hide resident for the session.
//
// IT ONLY PINS A MATERIAL THE RENDERER ACTUALLY CLAIMED. A material that was
// never drawn owns no program, so pinning it would fill the family slot with
// something that pins nothing and quietly leave the churn in place. three hangs
// a 'dispose' listener on a material the first time it builds a program for it
// (WebGLRenderer's onMaterialDispose), so that listener is the signal — and its
// absence is also what makes this a plain `dispose()` in every Node harness,
// where there is no renderer and no program to protect.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

/**
 * family key -> the one material of that family kept alive for its program.
 * Never cleared in a shipped session: a pin released between runs is a pin that
 * did not do its job, because run two is exactly when the re-link would land.
 */
const pinned = new Map();

/** Cheap 32-bit hash, for shader sources that are far too long to be map keys. */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * The parts of three's program cache key a material can carry on its own.
 *
 * Deliberately an APPROXIMATION, and only wrong in the cheap direction. Too
 * coarse and two families share a slot, so one of them keeps churning — which
 * is today's behaviour and no worse. Too fine and we pin an extra material,
 * which costs one object. What it must not do is throw: this is called from
 * teardown paths that run while something else is already going wrong.
 *
 * Object-side parameters (skinning, instancing, morph targets, the scene's
 * light counts) are not here because a material cannot see them. Every family
 * this file exists for is used one way, so they are constant per family.
 */
export function materialFamily(material) {
  const m = material;
  let tag = '';
  try {
    if (typeof m.customProgramCacheKey === 'function') tag = String(m.customProgramCacheKey.call(m));
  } catch { /* a tag that throws is a tag we do without */ }

  const shader = m.isShaderMaterial
    ? hash(String(m.vertexShader ?? '')) + ':' + hash(String(m.fragmentShader ?? ''))
    : '';

  // `!!` rather than the texture itself: the cache key records that a slot was
  // filled, never which image filled it, so two hides share one program.
  return [
    m.type, tag, shader,
    !!m.map, !!m.alphaMap, !!m.aoMap, !!m.bumpMap, !!m.displacementMap,
    !!m.emissiveMap, !!m.envMap, !!m.gradientMap, !!m.lightMap, !!m.matcap,
    !!m.metalnessMap, !!m.normalMap, !!m.roughnessMap, !!m.specularMap,
    m.vertexColors, m.transparent, m.blending, m.side, m.flatShading, m.fog,
    m.alphaTest > 0, m.alphaHash, m.premultipliedAlpha, m.alphaToCoverage,
    m.dithering, m.depthPacking ?? 0, m.sizeAttenuation ?? '', m.combine ?? '',
  ].join('|');
}

/**
 * Has a renderer built a program for this material?
 *
 * three adds its own 'dispose' listener the first time it prepares a material,
 * and takes it off again in that handler — so this is true exactly while the
 * material owns a program worth protecting. Reaching into `_listeners` is
 * reaching into three, and the alternative is a renderer reference threaded
 * through a dozen teardown paths that have no other use for one.
 */
function claimedByRenderer(material) {
  return (material?._listeners?.dispose?.length ?? 0) > 0;
}

/**
 * The maps a pinned material can let go of.
 *
 * Only the ones whose PRESENCE is in the cache key, and it stays present — the
 * texture object is dropped, the slot is not, so the family the pin represents
 * is unchanged. Without this a pinned boss hide would hold a 1024-square
 * compressed texture for the session, which is the trade the whole file exists
 * to avoid making.
 */
const MAP_SLOTS = [
  'map', 'alphaMap', 'aoMap', 'bumpMap', 'displacementMap', 'emissiveMap',
  'gradientMap', 'lightMap', 'matcap', 'metalnessMap', 'normalMap',
  'roughnessMap', 'specularMap',
];

// One shared stand-in for every dropped map, and a REAL 1x1 texture rather than
// a marker object. A pinned material is removed from the scene before it gets
// here and is never drawn again, so a marker would do — but "never drawn again"
// is an assumption about twenty call sites, and the failure if one of them is
// wrong is three uploading something with no image. A white pixel costs four
// bytes and cannot fail. Built lazily so importing this module in a Node
// harness allocates nothing.
let placeholder = null;
function placeholderMap() {
  placeholder ??= new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  placeholder.needsUpdate = true;
  return placeholder;
}

function stripMaps(material) {
  // A sentinel, not null: null would change the family this material stands
  // for, and three would key its next program without the map define. It is
  // never uploaded because a pinned material is never drawn again.
  for (const slot of MAP_SLOTS) if (material[slot]) material[slot] = placeholderMap();
}

/**
 * Dispose a material — unless it is the last of its program family, in which
 * case keep it so the compiled program survives.
 *
 * Drop-in for `material.dispose()` at any site that destroys a material the
 * game will build another of later.
 *
 * @returns {boolean} true if the material was disposed, false if it was pinned.
 */
export function retireMaterial(material) {
  if (!material) return false;

  // Arrays are legal on a Mesh, and a multi-material mesh is exactly the case
  // where forgetting this leaves half the programs churning.
  if (Array.isArray(material)) {
    let disposed = true;
    for (const m of material) disposed = retireMaterial(m) && disposed;
    return disposed;
  }

  // Nothing to protect: no renderer has ever compiled this, so a pin would
  // occupy the family's one slot and hold no program at all. This is also the
  // whole of the Node-harness path.
  if (!claimedByRenderer(material)) {
    material.dispose?.();
    return true;
  }

  const family = materialFamily(material);
  if (!pinned.has(family)) {
    stripMaps(material);
    pinned.set(family, material);
    return false;
  }

  material.dispose();
  return true;
}

/** How many families are pinned. For the harness and the perf report. */
export function pinnedProgramCount() {
  return pinned.size;
}

/** The families held, for a test that needs to name one. */
export function pinnedProgramFamilies() {
  return [...pinned.keys()];
}

/**
 * Let every pin go. HARNESS ONLY — a shipped session never calls this, because
 * releasing a pin between runs re-links the program on the next run's first
 * frames, which is the hitch this file removes.
 */
export function clearProgramPins() {
  for (const m of pinned.values()) m.dispose?.();
  pinned.clear();
}
