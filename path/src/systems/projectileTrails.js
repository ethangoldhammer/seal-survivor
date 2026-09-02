import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { emit } from '../entities/particles.js';
import { elementColor, elementTrailMix, elementFlightParticles } from './elements.js';

// Ribbon trails behind projectiles. Same reason as the lightning arcs: WebGL
// ignores line width, so a trail has to be real geometry to be visible at
// all. Each trail keeps a short history of world positions and rebuilds a
// tapering, fading ribbon through them every frame.
//
// Geometry is allocated ONCE per trail at its maximum length and rewritten
// in place — allocating a new BufferGeometry every frame for every bullet on
// screen would churn the GC hard during a busy fight.

const trails = new Map(); // projectile object -> trail record

// ONE MATERIAL FOR EVERY TRAIL, and it must be shared rather than copied.
//
// This used to be a `new THREE.MeshBasicMaterial` per trail, disposed when the
// trail retired. That reads as tidy and is the opposite: three refcounts
// PROGRAMS by cache key, so disposing the last material holding a key releases
// the linked program, and the next shot — identical in every parameter —
// links the same shader again from source. Create, build, dispose, release,
// create, rebuild, for as long as the run goes on.
//
// It is not a small effect. `npm run playtest` measures it directly:
// perfLog counts a build per key, and a 580s run shows ONE key at 138 builds
// with a sibling at 125, out of 7034 programs from 99 distinct keys. That is
// the unbounded case the note above programBuilds in systems/perfLog.js was
// written to tell apart from a cold warm-up, and it costs a compile hitch each
// time plus whatever the driver holds onto.
//
// SAFE TO SHARE, WHICH IS NOT TRUE OF EVERY MATERIAL HERE — see the note about
// primitive assets sharing one material, where fading one bubble faded all of
// them. Nothing about a trail's appearance lives on the material: colour and
// fade are written into `geo.attributes.color` per vertex (vertexColors is on),
// and width is geometry. Two trails of different colours already differ only in
// their buffers, so there is nothing left for a per-instance material to carry.
let sharedMat = null;

function trailMaterial() {
  sharedMat ??= new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  return sharedMat;
}

// ---------------------------------------------------------------------------
// ONE MESH PER RIBBON LENGTH, NOT ONE PER RIBBON.
//
// A trail was a Mesh in the scene, so a volley cost a draw call each — on top
// of the pellet's own, which is now an instance (entities/projectiles.js). The
// phone runs are what made that unaffordable rather than untidy: draws per
// frame tracked the player's LEVEL and not the creature count, climbing from
// ~100 at level 1 to a sustained 3184 at level 16 with sixty-one enemies in
// the water, while the frame rate fell from 57fps to 22. multishot, rapidFire
// and projectileAmount all multiply the number of things in the air, and every
// one of those calls crosses into WebKit's GPU process.
//
// The ribbons could not go into the instance buffer the pellets use: an
// InstancedMesh draws one geometry many times, and every ribbon rewrites its
// own vertices every frame. So they are MERGED instead — one big buffer that
// several trails write disjoint slices of, drawn once.
//
// GROUPED BY `points`, because that is the slot size: a preset's point count
// is the ribbon's length in frames of history and it is fixed at authoring
// time. Eight distinct values across every preset in CONFIG.trails, and only
// the two or three in play at once cost anything — a full volley of pebbles is
// one draw however many are in the air.
//
// THE Z GOES INTO THE VERTICES, and that is the one thing that had to change
// about how a ribbon is drawn. It used to live on the mesh transform
// (`mesh.position.z = trailZ(...)`), which a merged mesh cannot express: the
// mussel's ribbon clears its shell by a multiple of the shell's own depth and
// the pebble's sits at -0.02, and one transform cannot be both. Written per
// vertex it is exactly as correct — the material writes no depth but still
// TESTS it, which is what lets an opaque shell occlude its own trail — and it
// is now a property of the ribbon rather than of the object drawing it.
const ribbonGroups = new Map(); // maxPts -> group

// Slots to start a group at. Small on purpose: most groups hold one or two
// ribbons (a boss missile, a thrown club) and only the gun's ever fills up.
const RIBBON_START = 8;

const vertsPerSlot = (maxPts) => maxPts * 2;
const indicesPerSlot = (maxPts) => (maxPts - 1) * 6;

function growRibbons(g, capacity) {
  const verts = vertsPerSlot(g.maxPts);
  const pos = new Float32Array(capacity * verts * 3);
  const col = new Float32Array(capacity * verts * 3);
  if (g.pos) {
    // The live slots carry over. Without this a regrow blanks every ribbon in
    // the air for a frame, which at the moment a volley gets big enough to
    // trigger one is exactly when somebody is looking at them.
    pos.set(g.pos);
    col.set(g.col);
  }

  // The index list is the same shape in every slot, offset by the slot's base
  // vertex — built once here at capacity rather than per frame, because it
  // never changes for the life of the buffer.
  const perSlot = indicesPerSlot(g.maxPts);
  const idx = new Uint32Array(capacity * perSlot);
  let w = 0;
  for (let s = 0; s < capacity; s++) {
    const base = s * verts;
    for (let i = 0; i < g.maxPts - 1; i++) {
      const a = base + i * 2;
      idx[w++] = a; idx[w++] = a + 1; idx[w++] = a + 2;
      idx[w++] = a + 1; idx[w++] = a + 3; idx[w++] = a + 2;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));

  const mesh = new THREE.Mesh(geo, trailMaterial());
  // One mesh spanning the arena can only be culled whole, and its bounding
  // sphere is whatever the last frame's vertices happened to describe. Same
  // trade systems/instancedPool.js takes, and for the same reason.
  mesh.frustumCulled = false;
  mesh.name = `trails:${g.maxPts}`;

  if (g.mesh) {
    g.scene.remove(g.mesh);
    g.geo.dispose();
  }
  g.scene.add(mesh);
  g.mesh = mesh;
  g.geo = geo;
  g.pos = pos;
  g.col = col;
  g.capacity = capacity;
}

function ribbonGroup(scene, maxPts) {
  let g = ribbonGroups.get(maxPts);
  if (!g) {
    g = { maxPts, scene, mesh: null, geo: null, pos: null, col: null, capacity: 0, slots: [], dirty: false };
    ribbonGroups.set(maxPts, g);
    growRibbons(g, RIBBON_START);
  }
  return g;
}

/** Take a slot in the merged buffer for this ribbon length. */
function takeRibbonSlot(scene, maxPts) {
  const g = ribbonGroup(scene, maxPts);
  if (g.slots.length >= g.capacity) growRibbons(g, g.capacity * 2);
  const t = {
    group: g, slot: g.slots.length, history: [], maxPts,
    emitDebt: 0, extents: null, extentsKey: null,
  };
  g.slots.push(t);
  return t;
}

/**
 * Give a slot back.
 *
 * SWAP-REMOVE, and the moved ribbon's vertices travel WITH it. Telling it its
 * new slot number would be enough only if every ribbon were rewritten after
 * every release — it is not: the frame's writes have already happened by the
 * time the dead ones are swept, so a ribbon that merely learned its new index
 * would be drawn from whatever the dead one left in that block until its own
 * next update. On screen that is one shot's streak flicking onto another's
 * path for a frame, which is the shape of bug that never reproduces on demand.
 */
function freeRibbonSlot(t) {
  const g = t.group;
  const verts = vertsPerSlot(g.maxPts);
  const span = verts * 3;
  const last = g.slots.length - 1;
  if (t.slot !== last) {
    const moved = g.slots[last];
    g.pos.copyWithin(t.slot * span, last * span, (last + 1) * span);
    g.col.copyWithin(t.slot * span, last * span, (last + 1) * span);
    moved.slot = t.slot;
    g.slots[t.slot] = moved;
  }
  g.slots.pop();
  t.group = null;
  g.dirty = true;
}

/**
 * Draw only the slots that are live, and upload only those.
 *
 * The draw range is in INDICES, which is what an indexed geometry counts, and
 * the vacated tail of the buffer is simply never reached — cheaper and safer
 * than blanking it, because a blank slot is still vertices the rasteriser has
 * to be handed.
 */
function flushRibbonGroups() {
  for (const [key, g] of ribbonGroups) {
    const n = g.slots.length;
    g.geo.setDrawRange(0, n * indicesPerSlot(g.maxPts));
    if (n > 0 && g.dirty) {
      const span = vertsPerSlot(g.maxPts) * 3;
      g.geo.attributes.position.addUpdateRange(0, n * span);
      g.geo.attributes.position.needsUpdate = true;
      g.geo.attributes.color.addUpdateRange(0, n * span);
      g.geo.attributes.color.needsUpdate = true;
    }
    g.dirty = false;
    // An emptied group is dropped rather than left drawing nothing: a preset
    // that fired once early in a run should not cost a mesh in the scene for
    // the rest of it, and the group rebuilds on the next shot that wants it.
    if (n === 0) {
      g.scene.remove(g.mesh);
      g.geo.dispose();
      ribbonGroups.delete(key);
    }
  }
}

// How big the projectile ACTUALLY renders, in world units.
//
// This has to be measured rather than assumed. The asset's configured radius
// is only half the story: every asset can carry a `sizeMultiplier` from the
// Look panel, and the mussel's is 7.38 — so a shell described in config.js as
// radius 0.16 is a 2.4-unit-long object on screen. Anything positioned
// relative to the shell in hand-typed world units is therefore wrong by
// whatever that multiplier happens to be, and silently re-breaks the moment
// somebody drags the size slider.
//
// Measured with rotation zeroed so the numbers are the shell's own dimensions
// rather than the bounding box of however it's currently turned — otherwise
// the trail offset would breathe as the mussel curves. Art forward is +Y (see
// the `oval` shape), so that axis is the length.
function measureShell(mesh) {
  const { x: rx, y: ry, z: rz } = mesh.rotation;
  mesh.rotation.set(0, 0, 0);
  mesh.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
  mesh.rotation.set(rx, ry, rz);
  mesh.updateMatrixWorld(true);
  return { halfLength: size.y * 0.5, halfDepth: size.z * 0.5 };
}

// Cached, and refreshed only when the scale actually changes — a Box3 over a
// model every frame for every shot in the air is not free, and this only moves
// when somebody touches the size slider.
function shellExtents(t, p) {
  const key = `${p.mesh.scale.x}|${p.mesh.scale.y}|${p.mesh.scale.z}`;
  if (t.extentsKey !== key) {
    t.extentsKey = key;
    t.extents = measureShell(p.mesh);
  }
  return t.extents;
}

// How far behind the shell's centre the trail is anchored, in world units.
// `tailOffset` is a MULTIPLE of the shell's own half-length (1 = exactly at
// the tail), so it stays correct at any size. A trail is exhaust, and exhaust
// comes out of the back of the thing — anchored at the centre, the widest,
// brightest end of the ribbon sat in the middle of the shell and the burning
// chips spawned inside its body, which is what made the mussel look like it
// was disintegrating rather than trailing a plume.
function tailBack(t, p, cfg) {
  if (!cfg.tailOffset) return 0;
  return shellExtents(t, p).halfLength * cfg.tailOffset;
}

// Where the ribbon sits in z. `depthClearance` is a MULTIPLE of the shell's
// half-depth, so the ribbon clears the body whatever size it renders at. The
// projectile is opaque and writes depth, so once the ribbon is genuinely
// behind it the shell occludes its own trail for free. Presets that don't set
// this keep the legacy near-zero offset, so the small bullets are untouched.
function trailZ(t, p, cfg) {
  if (cfg.depthClearance == null) return cfg.z ?? -0.02;
  return Math.min(-0.02, -shellExtents(t, p).halfDepth * cfg.depthClearance);
}

function tailPoint(p, back, extraBack = 0) {
  const d = back + extraBack;
  return {
    x: p.mesh.position.x - p.dir.x * d,
    y: p.mesh.position.y - p.dir.y * d,
  };
}

// Shed particles along the path at a fixed rate. The leftover fraction is
// carried in emitDebt rather than dropped, so the rate holds at any framerate
// instead of quietly thinning out when frames are long — and a rate under one
// per frame still emits, just not every frame.
function shedParticles(t, p, spec, dt, back, fx = 1) {
  if (!spec?.emitter || !(spec.perSecond > 0)) return;
  t.emitDebt += spec.perSecond * fx * dt;
  let bursts = Math.floor(t.emitDebt);
  if (bursts <= 0) return;
  t.emitDebt -= bursts;
  // One long frame shouldn't dump a whole second of chips in one place.
  bursts = Math.min(bursts, 4);
  for (let i = 0; i < bursts; i++) {
    // Spread the burst back along the segment just travelled, so the chips
    // lie in a line behind the shell rather than stacking at its current
    // position in clumps of `bursts`. On top of that, the whole line starts
    // at the shell's TAIL (see tailPoint) — chips shedding from the middle of
    // the body read as the mussel disintegrating, not as an exhaust plume.
    const { x, y } = tailPoint(p, back, (i / bursts) * p.speed * dt);
    emit(spec.emitter, x, y, {
      vx: p.dir.x * p.speed,
      vy: p.dir.y * p.speed,
    });
  }
}

// Which trail preset a projectile uses, by its asset key. Anything not
// listed simply gets no trail.
//
// `trailKey` OVERRIDES THE ASSET, and exists for the one case the asset key
// cannot answer: a shot whose ribbon belongs to the SYSTEM that fired it rather
// than to the body it happens to be wearing. An attractor storm picks its body
// at random per shot out of a list (see the `body` column in
// attractorStormTable.js), so keying its trail on the asset would mean one
// preset per possible body and a shoal whose ribbons changed colour fish by
// fish. The storm names its own preset instead and every cube in it matches.
//
// Falls THROUGH to the asset when the named preset does not exist, rather than
// returning nothing: a typo'd key is then a shot with its ordinary trail, not a
// shot that silently lost one.
function presetFor(p) {
  return (p.trailKey ? CONFIG.trails[p.trailKey] : null)
    ?? CONFIG.trails[p.mesh?.name]
    ?? null;
}

// WHAT THIS PROJECTILE IS SHEDDING, which is usually its preset's own chips —
// the mussel's embers, the yacht's paper — and on the basic shot is the run's
// element instead.
//
// THE ELEMENT WINS on the pellet rather than adding to it. `bullet` has no
// `particles` of its own today, so in practice there is nothing to stack; the
// rule is written down anyway because the alternative reads as an accident the
// first time somebody gives the plain pellet a spark of its own and finds a
// Voltaic run shedding two kinds at once from one 0.18-wide stone.
//
// Keyed on the asset name for the same reason the preset and the colour are:
// 'bullet' is the gun's ammunition and nothing else's. The escorts fire the
// same asset and so crackle too, which is correct — Seal Team's volley IS the
// player's gun, scaled (see systems/sealTeam.js), and it already takes the
// element's colour for exactly that reason.
// WHICH ASSETS ARE THE GUN'S AMMUNITION. Two now rather than one: a run rolls
// either pebbles or fin lasers (see ../loadout.js), and both are fired by the
// same weapon, book their damage under the same source and take the same
// element. A set rather than a string comparison because the alternative — the
// second key added to one of the two tests below and not the other — is a bolt
// that sheds the element's sparks while dragging a ribbon in the stock colour,
// and nothing about that reads as a missing line.
const GUN_ASSETS = new Set(['bullet', 'finLaser']);

function shedSpec(p, cfg) {
  if (!GUN_ASSETS.has(p.mesh?.name)) return cfg.particles;
  return elementFlightParticles() ?? cfg.particles;
}

// Scratch colours for trailColour below — one ribbon rewrites its whole colour
// buffer every frame, so nothing here may allocate.
const _trailCol = new THREE.Color();
const _elemCol = new THREE.Color();

// The ribbon's colour, which is the preset's except on the basic shot.
//
// The bullet's pellet takes the run's element (systems/elements.js), and a
// green pellet dragging a yellow streak reads as two objects rather than one.
// Pulled from elements.js per frame rather than pushed, because it rides
// elementPower() and therefore changes with the sky all through dusk.
//
// Keyed on the asset name for the same reason the preset is: 'bullet' is the
// gun's ammunition and nothing else's.
function trailColour(p, cfg) {
  _trailCol.set(cfg.color);
  if (!GUN_ASSETS.has(p.mesh?.name)) return _trailCol;
  const mix = elementTrailMix();
  if (mix > 0) _trailCol.lerp(_elemCol.set(elementColor()), mix);
  return _trailCol;
}

/**
 * Draw one mover's ribbon.
 *
 * A "mover" is anything shaped like a projectile — { mesh, dir, speed } — and
 * that is deliberately a smaller contract than "a projectile". The clubs on
 * the ring are not projectiles and never will be (they are swung, they carry
 * riders, they belong to systems/club.js), but a ribbon only ever needed a
 * position with a name on it and a heading, so they hand one over and get the
 * same trail the thrown ones get rather than a second implementation of this
 * file. See clubTrailMovers in systems/club.js.
 */
function updateTrail(p, dt, scene, live) {
  const cfg = presetFor(p);
  if (!cfg) return;
  live.add(p);
  // HOW BIG THIS PARTICULAR ONE'S RIBBON IS. An upgrade's only channel on a
  // thing already in flight — see `trailScale` in entities/projectiles.js.
  // Multiplies the WIDTH and the shed rate and nothing else: the length is
  // `points`, which is geometry allocated once at the maximum, and the glow
  // is left alone because a trail bright enough to bloom at one stack should
  // not be six times over the threshold at six.
  const fx = Math.max(0, p.trailScale ?? 1);

  let t = trails.get(p);
  if (!t) {
    t = takeRibbonSlot(scene, Math.max(2, Math.round(cfg.points)));
    trails.set(p, t);
  }

  // Both are measured off the shell as it actually renders, so a size
  // change in the Look panel moves them with it.
  const back = tailBack(t, p, cfg);
  shedParticles(t, p, shedSpec(p, cfg), dt, back, fx);

  // Read live, so dragging the depth in the tuner moves a trail that's already
  // in the air rather than only the next one to spawn. It goes into the
  // VERTICES now rather than onto a mesh transform — see the note above
  // ribbonGroups for why a merged mesh cannot carry it any other way.
  const z = trailZ(t, p, cfg);

  // Record the head position — the shell's TAIL, not its centre — and drop
  // the oldest once past the cap.
  const head = tailPoint(p, back);
  t.history.unshift(new THREE.Vector3(head.x, head.y, 0));
  while (t.history.length > t.maxPts) t.history.pop();

  // This ribbon's slice of the shared buffers. Written as raw Float32Arrays
  // rather than through BufferAttribute.setXYZ because the offset is the
  // slot's and setXYZ would have to be told it every call — and because this
  // is the one loop in the file that runs per ribbon per frame.
  const g = t.group;
  const base = t.slot * vertsPerSlot(t.maxPts) * 3;
  const pos = g.pos;
  const col = g.col;
  g.dirty = true;
  const colour = trailColour(p, cfg);
  const up = new THREE.Vector3(0, 0, 1);
  const dir = new THREE.Vector3();
  const side = new THREE.Vector3();
  const n = t.history.length;

  for (let i = 0; i < t.maxPts; i++) {
    // Past the end of the recorded history, collapse remaining vertices
    // onto the tail so the ribbon doesn't stretch back to the origin
    // while it's still filling up.
    const idx = Math.min(i, n - 1);
    const cur = t.history[idx];
    const prev = t.history[Math.max(0, idx - 1)];
    const next = t.history[Math.min(n - 1, idx + 1)];
    dir.subVectors(next, prev);
    if (dir.lengthSq() < 1e-10) dir.set(1, 0, 0);
    dir.normalize();

    const f = i / (t.maxPts - 1); // 0 at the head, 1 at the tail
    const w = cfg.width * fx * 0.5 * (1 - f) ** cfg.taper;
    side.crossVectors(dir, up).normalize().multiplyScalar(w);

    const a = base + i * 6;
    pos[a] = cur.x + side.x; pos[a + 1] = cur.y + side.y; pos[a + 2] = z;
    pos[a + 3] = cur.x - side.x; pos[a + 4] = cur.y - side.y; pos[a + 5] = z;

    // Fade to black toward the tail — with additive blending, black is
    // transparent, so this doubles as the alpha ramp.
    const bright = cfg.glow * (1 - f) ** cfg.fade;
    const r = colour.r * bright;
    const gr = colour.g * bright;
    const b = colour.b * bright;
    col[a] = r; col[a + 1] = gr; col[a + 2] = b;
    col[a + 3] = r; col[a + 4] = gr; col[a + 5] = b;
  }
}

/**
 * @param projectiles the live shots
 * @param extra       anything else that wants a ribbon this frame, shaped the
 *                    same way — today, the clubs on the ring. Iterated as a
 *                    second list rather than concatenated, so the common frame
 *                    allocates nothing.
 */
export function updateProjectileTrails(dt, scene, projectiles, extra = null) {
  if (!CONFIG.trails.enabled) {
    if (trails.size) clearProjectileTrails(scene);
    return;
  }

  const live = new Set();
  for (const p of projectiles) updateTrail(p, dt, scene, live);
  if (extra) for (const p of extra) updateTrail(p, dt, scene, live);

  // Tear down trails whose mover is gone — a shot that landed, a club that
  // moved into a flipper or was taken off the ring by a level-up.
  //
  // NOTHING IS DISPOSED HERE ANY MORE. The geometry belongs to the group and
  // outlives every ribbon in it; the material belongs to everybody and always
  // did — disposing it per trail is what used to release the linked program
  // and make the next shot rebuild the identical shader (see trailMaterial()).
  // A retiring ribbon only hands its slot back.
  for (const [p, t] of trails) {
    if (live.has(p)) continue;
    freeRibbonSlot(t);
    trails.delete(p);
  }

  // LAST, after both the writes and the sweep. The draw range is the live slot
  // count, so flushing before the sweep would draw the retired ribbons for one
  // more frame at the positions they died on — and flushing before the writes
  // would upload the previous frame's buffer, which is a whole volley lagging
  // its own shots.
  flushRibbonGroups();
}

/**
 * How many ribbons are in the water, and what they cost.
 *
 * For the playtest ledger, so a phone run can say how much of its draw count
 * was the trails rather than the pellets — and the two numbers are no longer
 * the same one. `ribbons` is how many are drawn; `draws` is how many calls
 * that takes, which is one per distinct ribbon LENGTH in play rather than one
 * per shot. A gap between them is the merge working.
 */
export function trailCount() {
  return trails.size;
}

/** Draw calls the ribbons are costing right now. Diagnostics only. */
export function trailDrawCount() {
  return ribbonGroups.size;
}

export function clearProjectileTrails(scene) {
  for (const g of ribbonGroups.values()) {
    scene.remove(g.mesh);
    g.geo.dispose();
  }
  ribbonGroups.clear();
  trails.clear();
  // The shared material outlives individual trails but not the system. Dropped
  // here, at the one point where nothing is left holding it, so a run that ends
  // does not leave a program linked for a scene that no longer exists — and so
  // the next run builds it once rather than inheriting a stale one.
  sharedMat?.dispose();
  sharedMat = null;
}
