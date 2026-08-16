import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';
import { emit } from '../entities/particles.js';
import { assetBaseColor, createVisual, hasModel } from '../assets.js';

// ---------------------------------------------------------------------------
// A MAN EATEN IN THE WATER.
//
// A body was the best pickup in the game and the quietest: eatCrew() deleted
// the figure and fired one `bite` burst — the same twenty-six pink specks a
// mackerel gets — over the spot where a person had been. Whether the seal took
// him, or a shark broke off a hunt to get there first, the water was clean on
// the next frame.
//
// So he comes apart instead, in two halves that fail independently:
//
//   THE RED is particles, and is the whole effect on its own. Three emitters
//   fired together because this is three things at once — a hard spray that
//   says the instant it happened (`gore`), a haze that hangs there while the
//   spray is already gone (`goreMist`), and a mass that FUSES in the density
//   pass and is still in the water afterwards (`goreCloud`). One burst cannot
//   be all three: anything thrown hard enough to read as an impact has torn
//   itself apart long before it can read as a cloud.
//
//   THE PIECES are lit, tumbling solids thrown out of where the body was,
//   which sink, splash on their way in, and shrink into the silt. Same
//   simulation as the boss wreckage in systems/bossGibs.js and for the same
//   reasons — see the long note there about why a chunk is shaded rather than
//   additive, and why it leaves by shrinking rather than fading.
//
// WHERE THE SHAPES COME FROM, and this is the part that is not bossGibs. A
// boss bursts into three hundred identical lumps sampled out of its own posed
// hitbox; that works because at that count and that speed no individual chunk
// is ever looked at. Sixteen pieces off a man ARE looked at, so they have to be
// things — a femur, a rib, a piece of him — and identical icosahedra read as
// confetti at this count.
//
// So the pool is a list of SHAPES, and each one comes from either:
//
//   a MODEL listed in CONFIG.gore.pieces.assets, where every separate mesh
//   inside it becomes one shape (a .glb holding a dozen bones as a dozen
//   meshes is a dozen shapes, no authoring), or
//
//   the PROCEDURAL SET below, which stands in until there are models to throw.
//
// The fallback is not a placeholder to be deleted later: an asset key that
// hasn't loaded, a model that failed to parse, an upload the player never
// makes — all of them land here, and the effect has to be correct in every one
// of those cases rather than silently becoming nothing. Listing real models
// simply replaces the pool.
//
// Every shape is CENTRED AND NORMALISED to unit size as it goes in, so a
// piece's size on screen is CONFIG.gore.pieces.size times the man's own
// height and nothing else. Neither the model's authored scale nor the tuner's
// Size slider can reach it — which matters because both of those are set for
// how the asset looks as an asset, and a thrown fragment of one is not that.
//
// ONE DRAW CALL PER SHAPE. Not per piece: sixteen meshes a meal, several meals
// in the water at once, is a pile of draws for a handful of triangles each.
// Each shape owns an InstancedMesh rewritten from the chunk array every frame,
// which grows by rebuild when a burst needs more room than it has.
//
// TUNING is CONFIG.gore, and all of it is look — no xp, no heal, no radius
// anything is tested against. What a body is WORTH is CONFIG.boats.crew.food,
// and this system never touches it.
// ---------------------------------------------------------------------------

// Live pieces, oldest first. Not a ring buffer over fixed slots: these are
// simulated on the CPU and rewritten wholesale every frame, so an array that
// is exactly as long as what is actually in the water lets an arena with no
// gore in it cost nothing to draw.
const chunks = [];

// The shape pool. Each entry is { geometry, mesh, capacity, color, bone }.
let shapes = [];
// What the pool was built FROM. Rebuilt when this changes, which is how a
// model uploaded mid-session gets into the burst without a reload — see
// poolStamp().
let stamp = null;
// Whether the pool is the procedural stand-in rather than real models. Reported
// by the test harness; nothing about the burst reads it.
let poolIsFallback = true;
// The two halves of the pool, split once at build time rather than filtered on
// every piece thrown. `boneShare` only means anything while BOTH are non-empty
// — with one kind in the pool there is no split to make, and a burst that
// honoured the number anyway would throw a fraction of the pieces it was asked
// for and silently be a lighter effect.
let boneShapes = [];
let fleshOnly = [];
let material = null;
let sceneRef = null;

// Reused per frame rather than per piece — every one of these would otherwise
// be garbage, sixteen times a meal, every frame.
const _m = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _scale = new THREE.Vector3();
const _v = new THREE.Vector3();
const _col = new THREE.Color();

function cfg() {
  return CONFIG.gore ?? {};
}

function pcfg() {
  return CONFIG.gore?.pieces ?? {};
}

export function initGore(scene) {
  sceneRef = scene ?? null;
  if (!material) {
    // LIT, like the boss wreckage and unlike almost every other effect in this
    // game. A bone is a solid object and needs form: unlit, a femur tumbling
    // edge-on is a white streak that could be anything. Rough and non-metallic
    // — this is the one material in the game that must not look wet.
    material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.82,
      metalness: 0,
    });
  }
}

export function disposeGore(scene) {
  for (const s of shapes) {
    if (s.mesh) {
      (scene ?? sceneRef)?.remove(s.mesh);
      s.mesh.dispose();
    }
    s.geometry.dispose();
  }
  shapes = [];
  stamp = null;
  chunks.length = 0;
  material?.dispose();
  material = null;
  sceneRef = null;
}

// ---------------------------------------------------------------------------
// Building the shape pool
// ---------------------------------------------------------------------------

// Centre a geometry on its own bounding box and scale it so its LONGEST axis
// is exactly 1. Everything in the pool goes through this, which is what makes
// `pieces.size` mean one thing across shapes that arrived at wildly different
// scales — a bone exported in centimetres, a procedural shape authored in
// arena units, and a model somebody dragged the Size slider on.
//
// The longest axis rather than the diagonal, deliberately: a femur normalised
// on its diagonal comes out shorter than a rib normalised the same way, which
// is the difference between "these are all pieces of one man" and "somebody
// scaled the small ones up".
//
// Returns WHICH axis was the longest (0/1/2), because the per-piece stretch in
// spawnGore has to be applied along the shape's own length. A stretch on a
// fixed axis instead would lengthen one model and fatten the next, depending
// entirely on how its author happened to lay it out in the file — and bone.glb
// lies along X while every procedural shape here is built along Y.
function normalise(geo) {
  geo.computeBoundingBox();
  const box = geo.boundingBox;
  if (!box) return 1;
  box.getCenter(_v);
  geo.translate(-_v.x, -_v.y, -_v.z);
  box.getSize(_v);
  const size = [_v.x, _v.y, _v.z];
  const longest = Math.max(size[0], size[1], size[2]);
  if (longest > 1e-6) geo.scale(1 / longest, 1 / longest, 1 / longest);
  geo.computeBoundingSphere();
  return size.indexOf(longest);
}

// normalise() plus the bookkeeping every caller then wants: the geometry, and
// which of its axes is its length.
function shapeFrom(geo, rest) {
  const axis = normalise(stripAttributes(geo));
  return { geometry: geo, axis, ...rest };
}

// Strip everything the instanced material will never read. A bone model can
// arrive with uvs, tangents, vertex colours and — if it was rigged — skin
// indices and weights, none of which mean anything once the geometry has been
// frozen into its bind pose and handed to an InstancedMesh. Position and
// normal are the whole draw.
function stripAttributes(geo) {
  for (const name of Object.keys(geo.attributes)) {
    if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
  }
  if (!geo.attributes.normal) geo.computeVertexNormals();
  return geo;
}

// A deterministic wobble keyed on DIRECTION rather than on the vertex index.
// Two vertices sitting at the same point — a uv seam, or every corner of a
// non-indexed face — get the same displacement and stay welded. Jittering per
// index instead tears the shape open along exactly those seams, and the hole
// only shows from one side, which is how it survives a first look.
function lumpify(geo, amount, seed) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    _v.fromBufferAttribute(pos, i);
    const len = _v.length();
    if (len < 1e-6) continue;
    const nx = _v.x / len;
    const ny = _v.y / len;
    const nz = _v.z / len;
    const wobble = Math.sin(nx * 5.1 + seed) * Math.sin(ny * 4.3 + seed * 1.7)
      * Math.sin(nz * 6.7 + seed * 2.3);
    const k = 1 + amount * wobble;
    pos.setXYZ(i, _v.x * k, _v.y * k, _v.z * k);
  }
  pos.needsUpdate = true;
  // Recomputed AFTER the displacement, or every piece is lit as the sphere it
  // used to be. On a non-indexed geometry this comes out flat-faceted, which
  // is what a broken thing should look like.
  geo.computeVertexNormals();
  return geo;
}

// THE STAND-IN BONES: four shapes that read as parts of a skeleton at a glance
// and at a tumble. Deliberately built out of primitives rather than sculpted —
// these exist to be replaced by real models, and anything more elaborate would
// be work thrown away the day a bone pack lands.
//
// Kept in the file after real bones arrive, not deleted: they are what a
// missing model, a failed parse or an unloaded asset falls back to, and a gore
// burst that silently became nothing would take weeks to notice.
function proceduralBones() {
  const out = [];

  // A LONG BONE. A shaft with a knuckle at each end — the silhouette that
  // says "bone" from any angle, and the reason this is a merge rather than one
  // primitive: a plain capsule reads as a pill.
  {
    const shaft = new THREE.CylinderGeometry(0.1, 0.1, 0.72, 7, 1);
    const headA = new THREE.SphereGeometry(0.17, 7, 5).translate(0, 0.36, 0);
    const headB = new THREE.SphereGeometry(0.15, 7, 5).translate(0, -0.36, 0);
    const merged = mergeGeometries([shaft, headA, headB], false);
    shaft.dispose();
    headA.dispose();
    headB.dispose();
    if (merged) out.push(shapeFrom(merged, { bone: true }));
  }

  // A RIB. An open arc, thin — the one shape in the set with a hole through
  // it, which is most of what makes the burst look like it has variety in it
  // rather than several sizes of the same lump.
  {
    const geo = new THREE.TorusGeometry(0.4, 0.055, 5, 14, Math.PI * 1.15);
    out.push(shapeFrom(geo, { bone: true }));
  }

  // A VERTEBRA. A body with a spur off the back of it.
  {
    const body = new THREE.CylinderGeometry(0.2, 0.2, 0.22, 8, 1);
    const spur = new THREE.BoxGeometry(0.1, 0.28, 0.12).translate(0, -0.02, -0.22);
    const wingL = new THREE.BoxGeometry(0.24, 0.08, 0.1).translate(0.16, 0, -0.08);
    const wingR = new THREE.BoxGeometry(0.24, 0.08, 0.1).translate(-0.16, 0, -0.08);
    const merged = mergeGeometries([body, spur, wingL, wingR], false);
    body.dispose();
    spur.dispose();
    wingL.dispose();
    wingR.dispose();
    if (merged) out.push(shapeFrom(merged, { bone: true }));
  }

  // A PIECE OF SKULL. A dome, open at the bottom — a closed sphere at this
  // size is a ball, and a ball in a gore burst reads as a pickup.
  {
    const geo = new THREE.SphereGeometry(0.5, 9, 6, 0, Math.PI * 2, 0, Math.PI * 0.58);
    out.push(shapeFrom(geo, { bone: true }));
  }

  return out;
}

// TWO PIECES OF HIM. Faceted lumps, each wobbled on a different seed so they
// are visibly two things and not one geometry drawn twice. The second is
// stretched, because a burst of nothing but round lumps has no long axis in it
// and stops looking torn.
//
// Their own function because they are wanted on BOTH paths: they are half the
// stand-in pool, and they are also mixed in alongside real bones (see
// `pieces.flesh`). Ivory against dark red is the only contrast the burst has,
// and a pool that is all one or all the other reads as a handful of rocks or a
// handful of mush.
function fleshShapes() {
  return [
    shapeFrom(lumpify(new THREE.IcosahedronGeometry(0.5, 0), 0.42, 1.7), { bone: false }),
    shapeFrom(
      lumpify(new THREE.IcosahedronGeometry(0.5, 0), 0.34, 4.1).scale(1, 1.9, 0.75),
      { bone: false },
    ),
  ];
}

// What the pool would be built from, as a string. Both halves matter: the KEYS
// (the tuner can edit the list), and which of them have actually LOADED — an
// upload that lands mid-run changes the second without touching the first, and
// without it in the stamp the pool would stay procedural until a reload.
function poolStamp() {
  const keys = Array.isArray(pcfg().assets) ? pcfg().assets : [];
  if (!keys.length) return 'procedural';
  return keys.map((k) => `${k}:${hasModel(k) ? 1 : 0}`).join(',');
}

// Every mesh inside a model, as its own shape, baked into the model root's
// frame. One mesh = one shape is the whole convention here: it costs nothing,
// it is how a bone pack is naturally exported, and a pack that came out as a
// single merged mesh still works — it is simply one shape, and `npm run split`
// is what cuts it apart.
function shapesFromAsset(key) {
  const out = [];
  const visual = createVisual(key);
  if (!visual) return out;
  // Forced, and not optional: nothing has added this to a scene, so every
  // matrixWorld on it is identity until somebody says otherwise — and the bake
  // below would then flatten a hierarchy of offsets into one pile at the
  // origin without throwing anything.
  visual.updateMatrixWorld(true);
  const tint = assetBaseColor(key);
  visual.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    // Cloned, because the source geometry belongs to the shared model template
    // — baking a transform into it would move the asset everywhere it is used,
    // and disposing it later would delete the asset outright.
    const geo = o.geometry.clone();
    geo.applyMatrix4(o.matrixWorld);
    out.push(shapeFrom(geo, { bone: true, color: tint ?? null }));
  });
  return out;
}


// Build (or rebuild) the pool if what it would be built from has changed.
// Cheap to call every burst: the common case is a string compare.
function ensurePool() {
  const next = poolStamp();
  if (stamp === next && shapes.length) return;

  for (const s of shapes) {
    if (s.mesh) {
      sceneRef?.remove(s.mesh);
      s.mesh.dispose();
    }
    s.geometry.dispose();
  }
  shapes = [];
  // Every piece in the water was drawn by a mesh that no longer exists.
  chunks.length = 0;

  const keys = Array.isArray(pcfg().assets) ? pcfg().assets : [];
  const built = [];
  for (const key of keys) {
    if (!hasModel(key)) continue;
    built.push(...shapesFromAsset(key));
  }
  // Nothing listed, nothing loaded, or a model with no meshes in it. The
  // stand-in bones are the floor, and the effect never silently becomes
  // nothing.
  poolIsFallback = built.length === 0;
  if (poolIsFallback) built.push(...proceduralBones());
  // The flesh goes in either way unless it is switched off — see the note on
  // fleshShapes(). `boneShare` is what decides how much of a burst it is, and
  // it is meaningful on BOTH paths now: whether the ivory came from a model or
  // from a primitive, the split between it and the red is the same decision.
  if (pcfg().flesh !== false) built.push(...fleshShapes());

  for (const s of built) {
    s.mesh = null;
    s.capacity = 0;
    shapes.push(s);
  }
  boneShapes = shapes.filter((s) => s.bone);
  fleshOnly = shapes.filter((s) => !s.bone);
  stamp = next;
}

// Give a shape room for `want` instances, rebuilding its InstancedMesh at the
// next power of two when it runs out. An instance buffer cannot grow, and
// sizing every shape for the global cap up front would allocate a full pool
// per shape — fine at six, wasteful the moment somebody lists a thirty-bone
// model. Growth is one-way and bounded by `max`, so this settles after the
// first couple of meals and never runs again.
function ensureCapacity(s, want) {
  if (s.capacity >= want) return;
  const cap = Math.max(16, Math.min(Math.max(16, Math.round(pcfg().max ?? 140)), 1 << Math.ceil(Math.log2(want))));
  if (s.mesh) {
    sceneRef?.remove(s.mesh);
    s.mesh.dispose();
  }
  const mesh = new THREE.InstancedMesh(s.geometry, material, cap);
  mesh.name = 'gorePieces';
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  // instanceColor works on its own — switching `vertexColors` on to "enable"
  // it renders every instance black, because there is no colour attribute on
  // the geometry for it to read.
  //
  // Culling is given up: one mesh spans the whole arena, so three can only
  // cull all of it or none, and the bounding sphere it would cull against sits
  // at the origin.
  mesh.frustumCulled = false;
  mesh.count = 0;
  s.mesh = mesh;
  s.capacity = cap;
  sceneRef?.add(mesh);
}

// ---------------------------------------------------------------------------
// The burst
// ---------------------------------------------------------------------------

/**
 * A man taken apart in the water. Fired from eatCrew() in systems/crew.js —
 * the single route every mouth in the game takes to a body — and from nowhere
 * else.
 *
 * @param x,y   where he was
 * @param opts  { height, vx, vy } — the man's own height, which is the only
 *              scale the pieces are sized against, and the EATER's velocity,
 *              which the burst carries a share of. A shark that takes a body
 *              at a run and leaves the red hanging perfectly still behind it
 *              reads as two unrelated things on the same frame.
 * @returns the number of solid pieces thrown. 0 means the red fired and
 *          nothing else did — switched off, or no scene to put them in.
 */
export function spawnGore(x, y, opts = {}) {
  const c = cfg();
  if (c.enabled === false) return 0;

  const height = opts.height ?? CONFIG.boats?.crew?.height ?? 1.25;
  const eaterVx = opts.vx ?? 0;
  const eaterVy = opts.vy ?? 0;

  // The red. Fired first and unconditionally — it is the effect, and every
  // early return below it is about the solids only.
  //
  // The eater's velocity goes in RAW: how much of it each layer keeps is the
  // emitter's own `inherit`, which is where every other burst in the game
  // decides that. `gore.carry` below is the solids' share and theirs alone —
  // applying it here as well would be the same smear counted twice.
  if ((c.spray ?? 0) > 0) emit('gore', x, y, { scale: c.spray, vx: eaterVx, vy: eaterVy });
  if ((c.mist ?? 0) > 0) emit('goreMist', x, y, { scale: c.mist, vx: eaterVx, vy: eaterVy });
  if ((c.cloud ?? 0) > 0) emit('goreCloud', x, y, { scale: c.cloud, vx: eaterVx, vy: eaterVy });

  const carry = c.carry ?? 0.35;
  const vx = eaterVx * carry;
  const vy = eaterVy * carry;

  const p = pcfg();
  if (p.enabled === false || !material) return 0;
  ensurePool();
  if (!shapes.length) return 0;

  const max = Math.max(1, Math.round(p.max ?? 140));
  const wanted = Math.max(0, Math.round(p.count ?? 16));
  const count = Math.min(wanted, max);
  if (count === 0) return 0;
  // A second body eaten on top of the first takes the room it needs from the
  // oldest pieces in the water rather than being thrown a handful. The ones
  // that go are the ones that have already had their moment.
  const room = max - chunks.length;
  if (count > room) chunks.splice(0, count - room);

  const speed = p.speed ?? [3, 14];
  const sizeJitter = p.sizeJitter ?? 0.7;
  const tintVary = p.tint ?? 0.45;
  const life = p.life ?? 5.5;
  const lifeJitter = p.lifeJitter ?? 0.4;
  const scatter = p.scatter ?? 2.6;
  const spin = p.spin ?? 11;
  const baseSize = height * (p.size ?? 0.3);
  const boneShare = p.boneShare ?? 0.6;
  const lengthJitter = p.lengthJitter ?? 0;
  const girthJitter = p.girthJitter ?? 0;
  const boneColor = p.boneColor ?? 0xe4dcc4;
  const meatColor = p.meatColor ?? 0x7d1420;

  // Bone or flesh first, then a shape of that kind — rather than picking
  // evenly across the pool, where the ratio would be whatever the number of
  // shapes happened to be. One bone model plus two flesh lumps is a burst two
  // thirds red that nobody chose, and it would silently re-weight itself the
  // day a second bone was added to the list.
  const split = boneShapes.length > 0 && fleshOnly.length > 0;

  for (let i = 0; i < count; i++) {
    const pick = split
      ? (Math.random() < boneShare ? boneShapes : fleshOnly)
      : shapes;
    const s = pick[(Math.random() * pick.length) | 0] ?? shapes[0];

    // Thrown out from a point just inside where the body was, in a direction
    // of its own. A man is small enough that sampling a volume the way the
    // boss burst does would be sampling a point — this is a sphere of his own
    // radius, which is all the body there is to come apart.
    const dir = new THREE.Vector3(
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
    );
    if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
    dir.normalize();
    // Cube root so the starting points are UNIFORM in the volume. A plain
    // random radius piles two thirds of them into the middle third of him.
    const depth = Math.cbrt(Math.random()) * height * 0.28;

    const sp = speed[0] + Math.random() * (speed[1] - speed[0]);
    const size = Math.max(0.01, baseSize * (1 - sizeJitter * 0.5 + Math.random() * sizeJitter));

    // The non-uniform half of the jitter, and the reason ONE bone model is
    // enough: stretched along the shape's own length and thinned across it,
    // every piece is a different bone rather than the same bone at a different
    // size. `s.axis` is which axis that length is, measured when the pool was
    // normalised — assuming a fixed one lengthens a model laid out along X and
    // fattens the next one laid out along Y.
    const stretch = 1 - lengthJitter * 0.5 + Math.random() * lengthJitter;
    const girth = 1 - girthJitter * 0.5 + Math.random() * girthJitter;
    const axisScale = [girth, girth, girth];
    axisScale[s.axis ?? 1] = stretch;

    _col.set(s.color ?? (s.bone ? boneColor : meatColor));

    chunks.push({
      shape: s,
      sx: axisScale[0], sy: axisScale[1], sz: axisScale[2],
      x: x + dir.x * depth,
      y: y + dir.y * depth,
      z: dir.z * depth,
      vx: dir.x * sp + vx + (Math.random() - 0.5) * scatter,
      vy: dir.y * sp + vy + (Math.random() - 0.5) * scatter + (p.upBias ?? 2.2) * Math.random(),
      vz: dir.z * sp * 0.25,
      ex: Math.random() * Math.PI * 2,
      ey: Math.random() * Math.PI * 2,
      ez: Math.random() * Math.PI * 2,
      // Mostly about the view axis. This is a side-on game and a tumble in the
      // other two only ever reads as the piece flickering edge-on.
      ax: (Math.random() - 0.5) * spin * 0.5,
      ay: (Math.random() - 0.5) * spin * 0.5,
      az: (Math.random() - 0.5) * spin * 2,
      size,
      // Small pieces are dragged to a stop sooner than big ones and sink
      // slower, which is most of what sells them as different sizes of one
      // material rather than one size drawn at several scales.
      dragMul: Math.max(0.5, baseSize / Math.max(size, 1e-3)),
      age: 0,
      life: life * (1 - lifeJitter * 0.5 + Math.random() * lifeJitter),
      // Carried per piece rather than looked up in the update: the Look panel
      // can be dragged while pieces are still in the water, and a burst that
      // re-read the colour every frame would change colour halfway down.
      r: _col.r, g: _col.g, b: _col.b,
      // Without this, sixteen pieces of one colour read as a single flat mass.
      tint: 1 - tintVary * 0.5 + Math.random() * tintVary,
      // Tracked rather than latched: a piece thrown clear of the surface and
      // back in again splashes on each way in, the way the wreckage does.
      wet: y < bounds.surfaceY,
    });
  }

  return count;
}

/**
 * @param dt SCALED seconds — the gameplay clock, dilation and all. A body
 *           being eaten is a world event, not an interface one: the pieces
 *           belong to the water and should hang in it through a hit-stop
 *           rather than carrying on at wall speed while the ocean holds.
 */
export function updateGore(dt) {
  if (chunks.length === 0) {
    for (const s of shapes) if (s.mesh) s.mesh.count = 0;
    return;
  }
  const p = pcfg();
  const floor = bounds.bottom + 0.35;
  const surface = bounds.surfaceY;
  const fade = Math.max(0.05, p.fade ?? 1.1);
  const drag = p.drag ?? 2.0;
  const waterGravity = p.waterGravity ?? 3.6;
  const sink = p.sink ?? 1.1;
  const spinDamp = p.spinDamp ?? 1.4;

  for (let i = chunks.length - 1; i >= 0; i--) {
    const g = chunks[i];
    g.age += dt;
    if (g.age >= g.life) {
      chunks.splice(i, 1);
      continue;
    }
    if (dt <= 0) continue;

    const underwater = g.y < surface;
    if (underwater && !g.wet && g.vy < 0) {
      emit('splash', g.x, surface, { scale: p.splashScale ?? 0.22, dirX: 0, dirY: 1 });
    }
    g.wet = underwater;

    if (underwater) {
      const d = Math.exp(-drag * g.dragMul * dt);
      g.vx *= d;
      g.vy *= d;
      g.vz *= d;
      // Terminal, scaled by size: a big piece sinks faster than a small one.
      g.vy = Math.max(g.vy - waterGravity * dt, -sink / Math.max(0.4, g.dragMul));
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
      g.vy = 0;
      const rest = Math.exp(-6 * dt);
      g.vx *= rest;
      g.vz *= rest;
      g.ax *= rest;
      g.ay *= rest;
      g.az *= rest;
    }
  }

  // How many each shape is about to draw, so the buffers can be grown BEFORE
  // anything is written into them. Two passes rather than one because a write
  // past the end of an instance buffer is silent.
  for (const s of shapes) s.pending = 0;
  for (const g of chunks) g.shape.pending += 1;
  for (const s of shapes) {
    if (s.pending > 0) ensureCapacity(s, s.pending);
    s.written = 0;
  }

  for (const g of chunks) {
    const s = g.shape;
    if (!s.mesh || s.written >= s.capacity) continue;
    // Gone by shrinking rather than fading. Opacity would mean a transparent
    // material, which for overlapping solids means a sort the renderer cannot
    // do — and a piece that shrinks into the silt reads as settling anyway.
    const left = g.life - g.age;
    const shrink = left < fade ? Math.max(0, left / fade) : 1;
    const size = g.size * shrink;
    if (size <= 1e-4) continue;

    const n = s.written++;
    _pos.set(g.x, g.y, g.z);
    _euler.set(g.ex, g.ey, g.ez);
    _quat.setFromEuler(_euler);
    // The per-axis jitter rolled at spawn multiplies into the overall size, so
    // the shrink-away at the end of a life takes the stretch with it rather
    // than un-stretching the piece on its way out.
    _scale.set(size * g.sx, size * g.sy, size * g.sz);
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

/** Every piece in the water, gone. Called on a run reset. */
export function resetGore() {
  chunks.length = 0;
  for (const s of shapes) if (s.mesh) s.mesh.count = 0;
}

/** For the test harness. */
export function gorePieceCount() {
  return chunks.length;
}

/** For the test harness: how many distinct shapes the burst is drawing from. */
export function goreShapeCount() {
  ensurePool();
  return shapes.length;
}
