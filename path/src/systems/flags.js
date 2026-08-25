import * as THREE from 'three';
import { CONFIG } from '../config.js';
import flagsCsv from '../flags.csv?raw';
import { parseFlagCsv, buildFlags, pickFlag } from '../flagTable.js';

// FLAGS — the image flying off a hull's masthead.
//
// One quad, one texture, no gameplay. What is here is the two things a flag
// cannot be given by hand: WHERE the masthead is, and the flutter.
//
// THE MASTHEAD IS MEASURED, never typed. Three hulls fly flags and no two of
// them agree on anything — the trawler's gantry is at one end of a 19-unit
// model, the yacht's hardtop sits a third of the way back down a 40-unit one,
// and both are then scaled by `fit` and again by whatever the T panel's Size
// slider says. A hand-written offset would be right for one boat at one size,
// and the way it fails is a flag hanging in the sky beside a mast, which reads
// as a bug in the art rather than as a stale number. So the hull's own
// vertices are read at attach time: the top of the model is the masthead, and
// the flag is hoisted just under it.
//
// MEASURED AFTER EVERYTHING ELSE MEASURES THE HULL, and this is the ordering
// that matters most in this file. Both callers box the hull for something
// structural — Bakalar's net is the width of his own boat, and the boat boss's
// wake is laid out along its measured length — and a flag streaming aft is
// several units of Box3 that is not hull. Attach last, and those measurements
// are taken on the boat. Attach first and the net quietly grows a flag's worth
// of mouth, which is a balance change nobody made.
//
// THE FLUTTER IS IN THE SILHOUETTE, not in the shading. The natural way to
// wave a flag is to ripple it in Z and let the light do the rest — and these
// hulls are unlit near-black silhouettes seen from side on, so a Z ripple is
// invisible twice over. The wave here displaces Y and shortens X, so the shape
// itself moves; the fragment shader then darkens the far side of each fold
// from the wave's own slope, which is the shading a flat quad would never get.
// No derivatives are involved (see GLSL ES 1.00), because the slope is known
// analytically in the vertex shader.

const roster = buildFlags(parseFlagCsv(flagsCsv), { hulls: hullKeys() });

function hullKeys() {
  return Object.keys(CONFIG.flags?.hulls ?? {});
}

function cfg() {
  return CONFIG.flags ?? {};
}

// One clock for every flag in the scene, so a frame is one write rather than
// one per boat. Each flag carries its own phase, which is what keeps two boats
// on screen from flying the same wave in lockstep.
const uTime = { value: 0 };

// { group, mesh, material } per live flag. Pruned when the group loses its
// parent — see updateFlags for why that is the whole of the teardown.
const live = [];

// src -> Promise<THREE.Texture>. A texture is shared by every flag flying that
// image, and is never disposed: the pool is a handful of small files and a
// boss arriving twice in a run should not decode its flag twice.
const textures = new Map();

function loadFlagTexture(src) {
  let pending = textures.get(src);
  if (pending) return pending;
  pending = new THREE.TextureLoader().loadAsync(src).then((tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    // No repeat: a flag's own edge is its edge, and CLAMP means a fluttering
    // UV can never wrap the far side of the image into view.
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  });
  textures.set(src, pending);
  return pending;
}

// ---------------------------------------------------------------------------
// The mast
// ---------------------------------------------------------------------------

/**
 * The hull, in the frame the flag will be parented into: its box, and the
 * average horizontal position of everything in the top `band` of it.
 *
 * Why the average and not simply the box's centre: the top of a boat is a mast,
 * a gantry or a radar arch, and it is nowhere near the middle of the hull. The
 * trawler's crossbeam sits well forward of centre and the yacht's hardtop well
 * aft of it, so a flag hung at the box centre flies from the sky above the
 * deck on one boat and from the middle of a window on the other.
 *
 * Exported for tools/flag-test.mjs, which runs it over hand-built geometry —
 * no .glb loads in Node, so the real hulls are measured in the browser and the
 * arithmetic is measured here.
 */
export function measureMast(points, band = 0.03) {
  if (!points.length) return null;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const height = maxY - minY;
  if (!(height > 0)) return null;

  // A band, not the single highest vertex: the top of a mast is a cap of a
  // dozen vertices and one of them is a corner. Taken as a fraction of the
  // hull's height so it means the same thing on a 15-unit model and a 0.7-unit
  // one.
  const cut = maxY - height * Math.max(1e-4, band);
  let x = 0;
  let z = 0;
  let n = 0;
  for (const p of points) {
    if (p.y < cut) continue;
    x += p.x;
    z += p.z;
    n++;
  }
  if (!n) return null;
  return { x: x / n, y: maxY, z: z / n, height };
}

/**
 * Where a flag is tied on, given a mast — the point just under the truck, stood
 * off toward the camera so the cloth clears the spar it hangs beside.
 *
 * Its own function because tools/looks/flags.js hoists a flag the same way this
 * module does, on the real hulls, and a look page placing its subject by
 * different arithmetic from the game is a look page judging something else.
 */
export function hoistPoint(mast) {
  return new THREE.Vector3(
    mast.x,
    mast.y - mast.height * (cfg().hoistDrop ?? 0.02),
    // Side view, so this is depth only and never reads as the flag being in the
    // wrong place — it only keeps the quad from z-fighting through the mast.
    mast.z + (cfg().standoff ?? 0.05) * mast.height,
  );
}

// Every vertex of a subtree, in that subtree's own frame. The frame matters:
// the flag is parented to the visual, so the mast has to be found in the
// visual's coordinates rather than in the world's — the hull has already been
// oriented and scaled by then, and it is about to be turned to face the way it
// is sailing.
export function hullVertices(root) {
  root.updateMatrixWorld(true);
  const toLocal = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const out = [];
  root.traverse((o) => {
    // Skip anything a previous attach put here, and skip the outline shell —
    // it is the hull pushed out along its normals, so it is a second copy of
    // every vertex sitting fractionally proud of the first.
    if (!o.isMesh || o.userData?.flag || o.userData?.__isOutline) return;
    const pos = o.geometry?.attributes?.position;
    if (!pos) return;
    m.multiplyMatrices(toLocal, o.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      out.push(v.fromBufferAttribute(pos, i).applyMatrix4(m).clone());
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// The cloth
// ---------------------------------------------------------------------------

// Pinned so three.js reuses one compiled program for every flag rather than
// keying on the source of onBeforeCompile, which is identical for all of them.
// See the same note on attachDissolve.
const PROGRAM_TAG = 'flag-wave';

const GLSL_WAVE = /* glsl */`
  uniform float uFlagTime;
  uniform float uFlagPhase;
  uniform float uFlagWidth;
  uniform float uFlagWaves;
  uniform float uFlagSpeed;
  uniform float uFlagAmp;
  uniform float uFlagDroop;
  uniform float uFlagShade;
  varying float vFlagShade;
`;

function makeFlagMaterial(tex, uniforms) {
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    // Cutout rather than blending, the same choice the sprites make: a flag
    // with a shaped edge is drawn on transparency, and blending alone would
    // leave it fighting every other transparent thing in the water for sort
    // order — over a boat that is already drawing an outline shell.
    transparent: false,
    alphaTest: 0.5,
    // The hull spins 180° to sail the other way, and takes the flag with it.
    side: THREE.DoubleSide,
  });
  mat.customProgramCacheKey = () => PROGRAM_TAG;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${GLSL_WAVE}`)
      .replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        // 0 at the hoist, 1 at the fly. The quad is built along -X (aft of the
        // mast), so this is negated rather than divided straight through.
        float fly = clamp(-transformed.x / max(0.0001, uFlagWidth), 0.0, 1.0);
        float k = fly * uFlagWaves * 6.2831853 - uFlagTime * uFlagSpeed + uFlagPhase;
        float wave = sin(k);
        // The whole flag is on the same wave, but only the free end can move:
        // the hoist is tied to the mast, so the amplitude has to start at zero
        // there or the flag saws through its own halyard.
        float reach = fly * fly;
        transformed.y += uFlagAmp * reach * wave;
        // ...and it hangs. A flag with no droop reads as a signboard.
        transformed.y -= uFlagDroop * reach;
        // Cloth does not stretch: a fold has to come from somewhere, so the
        // fly end pulls in by the length the wave took out of it.
        transformed.x += uFlagAmp * reach * (1.0 - cos(k)) * 0.25;
        // The slope of the wave IS the shading — a fold turning away from the
        // light is the darker half of every real flag. Analytic, because an
        // injected shader has no dFdx to ask.
        float slope = cos(k) * uFlagWaves * 6.2831853 * reach;
        vFlagShade = 1.0 - uFlagShade * clamp(slope * 0.5 + 0.5, 0.0, 1.0);
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFlagShade;')
      // After the map, so the shading multiplies the art rather than the flat
      // material colour underneath it.
      .replace('#include <map_fragment>', '#include <map_fragment>\n\tdiffuseColor.rgb *= vFlagShade;');
  };
  return mat;
}

/**
 * The cloth itself: one quad, sized to the image's own aspect ratio and hung
 * from its top-right corner so the group it goes into IS the point on the mast
 * the flag is tied to.
 *
 * Split out from attachFlag so tools/flag-test.mjs can build one over a stub
 * texture — no image decodes in Node, and everything worth checking about a
 * flag (its aspect, where its hoist edge is, whether the wave GLSL actually
 * landed) is on this side of the download.
 */
export function buildFlagQuad(tex, { height, rand = Math.random } = {}) {
  const image = tex?.image ?? {};
  const aspect = (image.width || 1) / (image.height || 1);
  const width = height * aspect;

  const uniforms = {
    uFlagTime: uTime,
    uFlagPhase: { value: rand() * Math.PI * 2 },
    uFlagWidth: { value: width },
    uFlagWaves: { value: cfg().waves ?? 1.1 },
    uFlagSpeed: { value: cfg().speed ?? 3.4 },
    uFlagAmp: { value: height * (cfg().amplitude ?? 0.22) },
    uFlagDroop: { value: height * (cfg().droop ?? 0.12) },
    uFlagShade: { value: cfg().shade ?? 0.35 },
  };

  // Segments along the fly only: the wave runs that way and a flag is one
  // strip of cloth, so segments across it would be geometry that never moves.
  const geo = new THREE.PlaneGeometry(width, height, Math.max(2, Math.round(cfg().segments ?? 12)), 1);
  // Hoist edge at the origin, cloth hanging aft and down from it.
  geo.translate(-width / 2, -height / 2, 0);

  const mesh = new THREE.Mesh(geo, makeFlagMaterial(tex, uniforms));
  mesh.userData.flag = true;
  // A flag is cloth on a stick: nothing else in the game should be measuring
  // it, and localPoints below skips a node marked this way — so a second boat
  // measured for a mast never finds the first flag's quad.
  mesh.userData.noMeasure = true;
  mesh.frustumCulled = false;
  return { mesh, uniforms };
}

// ---------------------------------------------------------------------------
// Attaching one
// ---------------------------------------------------------------------------

/**
 * Hoist a flag on a hull.
 *
 * @param visual   the DRAWN body — the node that carries the hull's heading,
 *                 not the container it sits in. Parent a flag to the container
 *                 and the boat comes about underneath it: the mast moves and
 *                 the flag doesn't. Same node the crew stand on, for the same
 *                 reason (see systems/crew.js).
 * @param hull     the asset key, which is what flags.csv's `hulls` column names.
 * @param opts.rand  injected for the tests.
 * @returns the flag's group, or null if this hull has nothing to fly. The
 *          group is returned EMPTY and fills itself in when the image decodes,
 *          so a caller never has to await anything — and a missing file leaves
 *          a group with nothing in it rather than a blank white rectangle.
 */
export function attachFlag(visual, hull, { rand = Math.random } = {}) {
  if (!visual || cfg().enabled === false) return null;
  const hullCfg = cfg().hulls?.[hull];
  if (!hullCfg || hullCfg.enabled === false) return null;

  const flag = pickFlag(roster, hull, rand);
  if (!flag) return null;

  const mast = measureMast(hullVertices(visual), cfg().mastBand ?? 0.03);
  if (!mast) return null;

  const group = new THREE.Group();
  group.name = `flag:${hull}`;
  group.userData.flag = true;
  group.position.copy(hoistPoint(mast));
  visual.add(group);

  const height = mast.height * (hullCfg.size ?? 1) * (cfg().heightFraction ?? 0.16);

  loadFlagTexture(flag.src).then((tex) => {
    // The boat can be long gone by the time an image decodes.
    if (!group.parent) return;
    const { mesh, uniforms } = buildFlagQuad(tex, { height, rand });
    mesh.name = group.name;
    group.add(mesh);
    live.push({ group, mesh, uniforms });
  }).catch((err) => {
    console.warn(`[flags] "${flag.id}" could not load ${flag.src} — that mast flies nothing.`, err?.message ?? err);
  });

  return group;
}

/**
 * Advance every flag in the water.
 *
 * The teardown is here too, and it is deliberately not a detach call: a flag is
 * a child of a hull, and every hull in this game is already removed by
 * something that owns it (resetBossBoat's `owned` list, the scene teardown
 * behind Bakalar's boat). A flag whose group has lost its parent has therefore
 * already been taken out of the scene by that owner, and all that is left is to
 * stop ticking it and free the two GPU objects it made. The texture is NOT
 * freed — it is shared with every other flag flying the same image.
 */
export function updateFlags(dt) {
  uTime.value += dt;
  for (let i = live.length - 1; i >= 0; i--) {
    const f = live[i];
    if (f.group.parent) continue;
    f.mesh.geometry.dispose();
    f.mesh.material.dispose();
    live.splice(i, 1);
  }
}

/** For the tests and the tuner's Reset — everything this module is holding. */
export function flagCount() {
  return live.length;
}

/** The parsed roster, for tools/flag-test.mjs and the T panel's audit. */
export function flagRoster() {
  return roster;
}
