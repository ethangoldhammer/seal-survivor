import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';
import { emit } from '../entities/particles.js';
import { createVisual, hasModel, makeOutlineMaterial, ensureOutlineNormal } from '../assets.js';
import { attachDissolve, dissolveUniforms, roundedNormalBox } from './dissolve.js';
import { buildHumanoidRig, bindHumanoidRig, aimBone, anchorToHips } from './humanoidRig.js';
import { spawnGore } from './gore.js';

// The man on the boat.
//
// He has two lives in one file. Standing on deck he is an ordinary animated
// model playing an idle, PARENTED TO THE HULL — so he rides its bob, its roll
// and its heading exactly, because he is part of it. He does nothing else and
// decides nothing: a boat being shot to pieces under him is not his business.
//
// Then something hits him — a bullet, a blast, or the seal itself coming
// through the deck — and he stops being an animation at all: the mixer is
// switched off, he is detached from the boat with his pose intact, and a verlet
// ragdoll takes his skeleton over and lets the water have him.
//
// THE RAGDOLL DRIVES THE REAL BONES. The joints it drives were found by
// measuring where the vertices each bone moves actually sit — see
// systems/humanoidRig.js, and note that this model's rig calls a bone `peg
// leg` and has a coat rigged well enough to impersonate a forearm. If the
// model is missing or doesn't measure up as a humanoid, the figure falls back
// to the box body further down, which is the same ragdoll wearing nothing.

export const crew = [];

// Which model the crew wears, and the one measurement of it. Both the walk of
// every vertex and the bone map are the same for every person wearing a given
// model, so this happens once per model per session.
//
// KEYED BY ASSET, because there is more than one kind of person on the water
// now: a fisherman on the working boats, and the yacht boss's guests in white
// tie (see CONFIG.enemies.bossYacht). A single cached measurement was fine
// while there was one model and would silently hand the second model the first
// one's skeleton — every bone looked up by name, so it would not throw, it
// would just bind nothing and fall back to boxes.
const DEFAULT_ASSET = 'fisherman';
const measured = new Map();

// Bone lengths as a fraction of standing height — the FALLBACK proportions,
// used for the box body and for anything the model's own measurement couldn't
// place. Origin is between the feet.
const RIG = {
  foot: 0.00,
  knee: 0.26,
  hip: 0.52,
  chest: 0.80,
  head: 0.95,
  legSplay: 0.09,
  armSplay: 0.16,
  elbowDrop: 0.18,
  handDrop: 0.36,
};

// Which points each drawn bone runs between, and how thick to draw it. Only
// the box body uses these; the model has its own.
const SEGMENTS = [
  { name: 'torso', a: 'chest', b: 'hips', thick: 0.20, depth: 0.14 },
  { name: 'armUpperL', a: 'chest', b: 'elbowL', thick: 0.075, depth: 0.075 },
  { name: 'armLowerL', a: 'elbowL', b: 'handL', thick: 0.065, depth: 0.065 },
  { name: 'armUpperR', a: 'chest', b: 'elbowR', thick: 0.075, depth: 0.075 },
  { name: 'armLowerR', a: 'elbowR', b: 'handR', thick: 0.065, depth: 0.065 },
  { name: 'legUpperL', a: 'hips', b: 'kneeL', thick: 0.095, depth: 0.095 },
  { name: 'legLowerL', a: 'kneeL', b: 'footL', thick: 0.08, depth: 0.08 },
  { name: 'legUpperR', a: 'hips', b: 'kneeR', thick: 0.095, depth: 0.095 },
  { name: 'legLowerR', a: 'kneeR', b: 'footR', thick: 0.08, depth: 0.08 },
];

const HEAD_SIZE = 0.19;

function cfg() {
  return CONFIG.boats.crew ?? {};
}

// ---------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------

// Measure the model once. Called at boat spawn, like the wreckage measurement
// next door, so the cost lands while nothing is exploding.
export function primeCrew(asset = DEFAULT_ASSET) {
  if (measured.has(asset)) return measured.get(asset);
  // Not cached: the model may simply not have finished loading yet, and a
  // `null` written now would be remembered for the rest of the session.
  if (!hasModel(asset)) return null;
  let rig = null;
  try {
    rig = buildHumanoidRig(createVisual(asset)) ?? null;
    if (!rig) {
      console.warn(`[crew] "${asset}" did not measure up as a humanoid — using the box body`);
    }
  } catch (err) {
    console.warn(`[crew] could not measure "${asset}"`, err);
  }
  measured.set(asset, rig);
  return rig;
}

// The standing pose, in world coordinates around (x, y) with the feet on y.
// Taken from the MODEL's own measured joints where it has them, so the ragdoll
// is the shape of the man rather than the shape of an assumption.
function standingPose(x, y, h, face, rig) {
  const r = rig?.rest ?? null;
  const at = (dx, dy) => ({ x: x + dx * h * face, y: y + dy * h });
  const from = (joint, dx, dy) => {
    const m = r?.[joint];
    return m ? at(m.x, m.y) : at(dx, dy);
  };
  return {
    head: from('head', 0, RIG.head),
    chest: from('chest', 0, RIG.chest),
    hips: from('hips', 0, RIG.hip),
    elbowL: from('elbowL', -RIG.armSplay * 0.7, RIG.chest - RIG.elbowDrop),
    handL: from('handL', -RIG.armSplay, RIG.chest - RIG.handDrop),
    elbowR: from('elbowR', RIG.armSplay * 0.7, RIG.chest - RIG.elbowDrop),
    handR: from('handR', RIG.armSplay, RIG.chest - RIG.handDrop),
    kneeL: from('kneeL', -RIG.legSplay * 0.8, RIG.knee),
    footL: from('footL', -RIG.legSplay, RIG.foot),
    kneeR: from('kneeR', RIG.legSplay * 0.8, RIG.knee),
    footR: from('footR', RIG.legSplay, RIG.foot),
  };
}

const LINKS = [
  ['head', 'chest'],
  ['chest', 'hips'],
  ['chest', 'elbowL'], ['elbowL', 'handL'],
  ['chest', 'elbowR'], ['elbowR', 'handR'],
  ['hips', 'kneeL'], ['kneeL', 'footL'],
  ['hips', 'kneeR'], ['kneeR', 'footR'],
];

// Loose links: they only pull when a joint has gone further than a body can.
// This stands in for joint limits — a knee that can't straighten past its leg
// length, a spine that can't fold in half. Cheaper and steadier than real
// angular constraints, and at this size nobody can tell.
const LIMITS = [
  // A torso barely compresses. Loose enough to bend, tight enough that the
  // head can't fold back over the hips — without this the spine happily turned
  // inside out mid-flight, which reads as a broken model rather than a body.
  ['head', 'hips', 0.82, 1.05],
  ['chest', 'kneeL', 0.4, 1.0], ['chest', 'kneeR', 0.4, 1.0],
  // An arm folds a long way — a hand reaches its own chest — so this is loose.
  // Set tighter (0.45 was tried) it spends every tick shoving a folded arm
  // back out while the link holding the forearm's length shoves back, and the
  // forearm ends up visibly short.
  ['chest', 'handL', 0.3, 1.0], ['chest', 'handR', 0.3, 1.0],
  ['hips', 'footL', 0.5, 1.0], ['hips', 'footR', 0.5, 1.0],
  ['footL', 'footR', 0.25, 1.6],
  ['handL', 'handR', 0.2, 1.6],
];

function buildRig(x, y, h, face, model) {
  const pose = standingPose(x, y, h, face, model);
  const points = {};
  for (const [name, at] of Object.entries(pose)) {
    // prev === pos means "at rest": verlet reads velocity as the gap between
    // them, so a figure built this way starts stationary rather than exploding.
    points[name] = { x: at.x, y: at.y, px: at.x, py: at.y, pinned: false };
  }
  const links = LINKS.map(([a, b]) => {
    // Floored at a real fraction of the man's height. The rest pose is a 3D
    // pose flattened into the ragdoll's plane, so a limb that happens to point
    // at the camera measures as almost nothing — and a bone of almost nothing
    // is a joint the solver can pivot through freely, which looks like the
    // model coming apart. In a side-on game a limb is allowed to LOOK
    // foreshortened; it is not allowed to be hinged at a point.
    const rest = Math.max(
      Math.hypot(points[a].x - points[b].x, points[a].y - points[b].y),
      h * 0.06,
    );
    // `base` is the length this bone was BUILT at, kept because the handover
    // re-measures against a live pose and that measurement can lie — see the
    // clamp in goLimp.
    return { a, b, rest, base: rest };
  });
  const limits = LIMITS.map(([a, b, lo, hi]) => {
    const d = Math.hypot(points[a].x - points[b].x, points[a].y - points[b].y);
    // Ratios kept, not just the numbers they produced: the pose these were
    // measured from is replaced wholesale when the animation hands over (see
    // goLimp), and limits still describing the old one fight the links
    // forever — which showed up as a figure stretched 17% out of shape.
    return { a, b, lo, hi, base: d, min: d * lo, max: d * hi };
  });
  // The solver runs this list several times per tick per figure; walking
  // Object.values() there would allocate an array each pass.
  return { points, links, limits, list: Object.values(points) };
}

// ---------------------------------------------------------------------------
// The body — the model, or boxes when there isn't one
// ---------------------------------------------------------------------------

function makeKit(h) {
  const c = cfg();
  const uniforms = dissolveUniforms(h, c.dissolveCells ?? 7);
  const body = attachDissolve(
    new THREE.MeshBasicMaterial({ color: c.color ?? 0x14202c }), uniforms, 'crewBody',
  );
  const shell = c.outlineColor == null ? null : attachDissolve(
    makeOutlineMaterial({ color: c.outlineColor, thickness: c.outlineThickness ?? 0.035 }),
    uniforms, 'crewRim',
  );
  return { uniforms, body, shell };
}

// One box per bone, at that bone's rest length. Sizes are baked into the
// geometry rather than applied as scale so the rim, which the shader pushes in
// object space, comes out the same width on every limb (see dissolve.js).
function buildBoxBody(rig, kit, h) {
  const group = new THREE.Group();
  const parts = [];
  const geometries = [];

  const add = (geometry, key) => {
    const mesh = new THREE.Mesh(geometry, kit.body);
    group.add(mesh);
    let rim = null;
    if (kit.shell) {
      // The rim shader offsets along `aOutlineNormal`, not the raw normal, and a
      // geometry without it reads (0,0,0) and simply has no rim — silently, the
      // way a missing attribute always fails. These shells are built here rather
      // than by addOutlineShells, so the attribute has to be asked for here too.
      ensureOutlineNormal(geometry);
      rim = new THREE.Mesh(geometry, kit.shell);
      rim.renderOrder = -1;
      group.add(rim);
    }
    geometries.push(geometry);
    parts.push({ ...key, mesh, rim });
  };

  for (const seg of SEGMENTS) {
    const a = rig.points[seg.a];
    const b = rig.points[seg.b];
    const length = Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1e-3);
    add(roundedNormalBox(seg.thick * h, length, seg.depth * h), { a: seg.a, b: seg.b, name: seg.name });
  }
  const size = HEAD_SIZE * h;
  add(roundedNormalBox(size, size * 1.1, size), { a: 'head', b: null, name: 'head' });

  return { kind: 'boxes', group, parts, geometries, kit };
}

// Point the drawn boxes at wherever the solver left the joints.
function poseBoxBody(figure) {
  const { points } = figure.rig;
  for (const part of figure.body.parts) {
    const a = points[part.a];
    if (!part.b) {
      const chest = points.chest;
      part.mesh.position.set(a.x, a.y, 0);
      part.mesh.rotation.z = Math.atan2(a.x - chest.x, a.y - chest.y) * -1;
      if (part.rim) {
        part.rim.position.copy(part.mesh.position);
        part.rim.rotation.z = part.mesh.rotation.z;
      }
      continue;
    }
    const b = points[part.b];
    const angle = Math.atan2(a.x - b.x, a.y - b.y) * -1;
    part.mesh.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, 0);
    part.mesh.rotation.z = angle;
    if (part.rim) {
      part.rim.position.copy(part.mesh.position);
      part.rim.rotation.z = angle;
    }
  }
}

// Which verlet joints drive which bone. The bone is aimed from the first point
// toward the second — a limb points at the joint below it.
const DRIVEN = [
  ['hips', 'hips', 'chest'],
  ['chest', 'chest', 'head'],
  ['head', 'head', 'chest', -1],
  ['upperArmL', 'chest', 'elbowL'],
  ['lowerArmL', 'elbowL', 'handL'],
  ['upperArmR', 'chest', 'elbowR'],
  ['lowerArmR', 'elbowR', 'handR'],
  ['upperLegL', 'hips', 'kneeL'],
  ['lowerLegL', 'kneeL', 'footL'],
  ['upperLegR', 'hips', 'kneeR'],
  ['lowerLegR', 'kneeR', 'footR'],
];

// THE SPINE ONLY — what a man standing on a deck gets. See swayAboard.
//
// The ragdoll is FLAT: every joint solves at z = 0, and aimBone points each
// bone at a direction with no z in it. For a body tumbling through the air that
// is the whole design and costs nothing. For a man standing still it is
// ruinous, because his arms are not flat — this one stands in an A-pose with
// his hands a little forward of his hips — and driving them squashes that pose
// into the screen plane. The shoulders collapse, the far arm swings round to
// the near side, and the coat's lapel ends up across his face. He is not moving
// and he already looks broken.
//
// The spine does not have that problem: it runs up the mid-line, so flattening
// it changes nothing at rest and still shows the whole upper body rocking —
// the arms come along because they hang off the chest, in their own real pose.
// NOT the hips, and that is the whole point of the set. `hips` is the ROOT
// bone: everything the model has hangs off it, so aiming it turns the entire
// figure. Its measured axis is the direction of its own flesh — (-0.01, 1.00,
// -0.07) on this model, near vertical but not exactly — and aiming that at the
// ragdoll's dead-straight (0, 1) rolls the whole man a few degrees off plumb
// and leaves him standing on the deck at a lean, before anything has hit him.
// It also carries no information: the hips point is PINNED, so what is being
// aimed is a constant.
//
// The chest and the head are what the sway is, and neither is a root.
const DRIVEN_ABOARD = new Set(['chest', 'head']);

// Hand the skeleton over to the ragdoll for this frame.
//
// `anchor` moves the whole model to wherever the solver put the hips, which is
// what a body falling through the air needs and what a man standing on a deck
// must not have. Aboard, the group is already parented at his own spot on the
// hull; anchorToHips corrects a WORLD error into a LOCAL position, so on a hull
// that is scaled, or turned to face the other way, the correction is applied in
// the wrong frame and the figure walks off the boat a little more each frame.
function poseModelBody(figure, anchor = true, only = null) {
  const { model } = figure.body;
  const points = figure.rig.points;
  // Parents before children: aimBone reads its parent's world rotation, so the
  // torso has to be solved before the arms hanging off it.
  for (const [joint, from, to, sign] of DRIVEN) {
    if (only && !only.has(joint)) continue;
    const seg = model.segments[joint];
    if (!seg) continue;
    const a = points[from];
    const b = points[to];
    aimBone(seg, (b.x - a.x) * (sign ?? 1), (b.y - a.y) * (sign ?? 1));
  }
  if (anchor) {
    anchorToHips(figure.body.group, model.segments.hips.bone, points.hips.x, points.hips.y);
  }
}

// ---------------------------------------------------------------------------
// Where the deck is
// ---------------------------------------------------------------------------

// The height of the boat's own DECK at a given point along it, measured off
// the hull geometry — not a hand-typed offset, which is how the crew ended up
// standing in mid-air above a boat whose deck sits wherever that model's deck
// happens to sit.
//
// Measured in the boat's LOCAL space, so it survives the hull's bob, roll and
// heading for free, and cached per asset because it is a fact about the model.
//
// The hull's SURFACE AREA is dropped into a grid down the side of the boat,
// and the deck at any point is the highest cell above the waterline holding a
// real surface's worth of it.
//
// Area, not vertices and not width, for the same reason the wreckage is
// measured by area (see boatDebris.js). Two cheaper rules were tried and both
// put a man somewhere ridiculous: counting vertices stood him on the masthead,
// because a mast's top face has as many corners as anything else; measuring
// how far the geometry spreads across the beam stood him on top of the
// trawler's gantry, whose two legs span the whole boat with nothing but air
// between them. A square metre of deck is a square metre of deck.
//
// AND IT HAS TO BE A FLOOR. Area alone is not enough, and the yacht is what
// proved it: a hull's TOPSIDES — the plating between the waterline and the deck
// edge — are a huge, continuous, perfectly vertical surface, and they land in
// the lowest cell above the water in every bin along the boat. "The lowest
// surface above the waterline" then finds the side of the boat, and four guests
// stood a metre under the deck they appeared to be leaning on, buried to the
// chest in it. The trawler never showed this because its topsides are barely a
// cell tall and its working deck is the first thing above them.
//
// So each triangle contributes its HORIZONTAL PROJECTION: a deck counts for its
// full area, a sloping cabin roof for rather less, and a wall for nothing at
// all. That is the same quantity as "how much floor is there", which is the
// question that was being asked all along.
const DECK_BINS = 24;
const DECK_COVERAGE = 1.0; // cells-worth of floor before you can stand on it
// How far a surface may tilt and still be a floor: within 60° of horizontal.
// Steeper than a companionway and nobody is standing on it.
const DECK_MAX_TILT = 0.5;
// Elbow room, in bins, between two people gathered at the same end of a boat.
// A bin is about half a person wide on a hull the size of the yacht, so
// neighbouring bins put two guests inside each other.
const DECK_GAP_BINS = 2;
const deckCache = new Map();

function deckProfile(boat) {
  const cached = deckCache.get(boat.assetKey);
  if (cached !== undefined) return cached;

  boat.mesh.updateWorldMatrix(true, true);
  const toLocal = new THREE.Matrix4().copy(boat.mesh.matrixWorld).invert();
  const local = new THREE.Matrix4();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const cVec = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cross = new THREE.Vector3();
  const p = new THREE.Vector3();

  const tris = [];
  let lo = Infinity;
  let hi = -Infinity;
  boat.mesh.traverse((o) => {
    if (o.userData.__crew) return;
    if (!o.isMesh || o.userData.__isOutline || !o.geometry?.attributes?.position) return;
    local.multiplyMatrices(toLocal, o.matrixWorld);
    const geo = o.geometry;
    const pos = geo.attributes.position;
    const index = geo.index;
    const count = Math.floor((index ? index.count : pos.count) / 3);
    for (let t = 0; t < count; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(local);
      b.fromBufferAttribute(pos, i1).applyMatrix4(local);
      cVec.fromBufferAttribute(pos, i2).applyMatrix4(local);
      tris.push(a.x, a.y, a.z, b.x, b.y, b.z, cVec.x, cVec.y, cVec.z);
      lo = Math.min(lo, a.x, b.x, cVec.x);
      hi = Math.max(hi, a.x, b.x, cVec.x);
    }
  });
  if (!tris.length || !(hi > lo)) {
    deckCache.set(boat.assetKey, null);
    return null;
  }

  const span = hi - lo;
  const cell = span / DECK_BINS;
  const cellArea = cell * cell;
  const columns = Array.from({ length: DECK_BINS }, () => new Map());

  for (let i = 0; i < tris.length; i += 9) {
    a.set(tris[i], tris[i + 1], tris[i + 2]);
    b.set(tris[i + 3], tris[i + 4], tris[i + 5]);
    cVec.set(tris[i + 6], tris[i + 7], tris[i + 8]);
    ab.subVectors(b, a);
    ac.subVectors(cVec, a);
    cross.crossVectors(ab, ac);
    const twice = cross.length();
    if (!(twice > 0)) continue;
    const area = twice * 0.5;
    // How flat this triangle lies, and WHICH WAY UP: cos of the angle between
    // its normal and up, signed. `cross.y` is already that times the doubled
    // area, so the projection below costs nothing beyond the divide that was
    // needed anyway.
    //
    // Signed, not absolute. A hull flares outward above the waterline, and the
    // UNDERSIDE of that flare is every bit as horizontal as a deck — taken
    // unsigned it fills the first cell above the water along most of the boat,
    // and the guests stand on the ceiling of the hull's overhang. A floor you
    // can stand on faces up.
    const flat = cross.y / twice;
    if (flat < DECK_MAX_TILT) continue;
    // Its horizontal projection — the floor it actually offers. See the note
    // above on the yacht's topsides for what happens without this.
    const floor = area * flat;
    // Spread over the cells it actually covers, or one long deck plank lands
    // entirely on whichever cell held its centroid. Sampled by the triangle's
    // REAL extent, not its projection, or a big gently-sloping roof would be
    // dropped into fewer cells than it spans.
    const samples = Math.min(24, Math.max(1, Math.ceil(area / cellArea)));
    const share = floor / samples;
    for (let s = 0; s < samples; s++) {
      let u = Math.random();
      let v = Math.random();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      p.copy(a).addScaledVector(ab, u).addScaledVector(ac, v);
      const col = Math.min(DECK_BINS - 1, Math.max(0, Math.floor((p.x - lo) / cell)));
      const row = Math.floor(p.y / cell);
      const at = columns[col];
      at.set(row, (at.get(row) ?? 0) + share);
    }
  }

  const need = cellArea * DECK_COVERAGE;

  // THE DECK IS ONE LEVEL, AND IT IS THE SAME LEVEL ALL THE WAY ALONG. Picked
  // across the WHOLE boat rather than bin by bin, which is the difference
  // between finding a deck and finding whatever happened to be overhead at each
  // point: choose per bin and the yacht puts one guest on the swim platform,
  // one on the main deck and one on the sun deck, because each of those is the
  // biggest thing above its own slice of hull.
  //
  // Two per-bin rules were tried before this and each fails on one of the two
  // hulls. HIGHEST puts a man on the trawler's bridge roof, standing in its
  // rigging. LOWEST puts the yacht's guests on its swim platform and its bow
  // flare, a metre below the deck they appear to be leaning on — the trawler
  // never showed it because its working deck IS the lowest thing above its
  // water, which is exactly the coincidence that let a wrong rule look right.
  //
  // What both were reaching for is "the deck", and a deck is the level of a
  // boat with the most floor on it. Totalled down the boat, the trawler's
  // working deck outweighs its wheelhouse roof and the yacht's main deck
  // outweighs both its swim platform and its flybridge, with neither needing to
  // be named. Ties go downward: two levels of equal floor is a boat where the
  // lower one is the one being worked.
  const rowTotals = new Map();
  for (const rows of columns) {
    for (const [row, area] of rows) {
      if (row < 0 || area < need) continue;
      rowTotals.set(row, (rowTotals.get(row) ?? 0) + area);
    }
  }
  let deckRow = null;
  let deckTotal = 0;
  for (const [row, total] of rowTotals) {
    if (total > deckTotal || (total === deckTotal && deckRow != null && row < deckRow)) {
      deckTotal = total;
      deckRow = row;
    }
  }
  // Then every bin that has a real share of THAT level is somewhere to stand,
  // and every bin that does not — the pointed bow, the overhanging stern — is
  // not. Which is also what keeps a guest off the stem: it is not that the bow
  // is out of bounds, it is that there is no deck out there to stand on.
  const heights = columns.map((rows) => {
    if (deckRow == null) return null;
    const area = rows.get(deckRow) ?? 0;
    return area >= need ? (deckRow + 1) * cell : null;
  });

  // AND WHAT EACH BIN HAS OF ITS OWN, for the places the main deck does not
  // reach. The yacht's foredeck is a real deck with a rail on it and a man can
  // stand there, but it is a step DOWN from the main deck, so a rule that
  // insists on one level for the whole boat has nothing to offer at the bow.
  // Only the placements that ask for a specific end of the boat use this; the
  // default spread still stays on the one main deck, which is the thing that
  // stopped four guests standing on four different levels.
  const ownHeights = columns.map((rows) => {
    let best = null;
    let bestArea = 0;
    for (const [row, area] of rows) {
      if (row < 0 || area < need) continue;
      if (area > bestArea || (area === bestArea && best != null && row < best)) {
        bestArea = area;
        best = row;
      }
    }
    return best == null ? null : (best + 1) * cell;
  });
  const profile = { lo, span, heights, ownHeights };
  deckCache.set(boat.assetKey, profile);
  return profile;
}

// Deck height at a position along the hull, in the boat's local space.
function deckAt(profile, x) {
  if (!profile) return null;
  const t = (x - profile.lo) / profile.span;
  const b = Math.min(DECK_BINS - 1, Math.max(0, Math.floor(t * DECK_BINS)));
  // Out from the requested bin until one of them has a surface. The bow and
  // stern bins of a pointed hull can be too sparse to call.
  for (let step = 0; step < DECK_BINS; step++) {
    const left = profile.heights[b - step];
    if (left != null) return left;
    const right = profile.heights[b + step];
    if (right != null) return right;
  }
  return null;
}

// Where on the boat people actually stand. Not evenly spaced along it — spread
// across whatever bins hold the deck, kept apart from each other.
//
// The RANKING is already done: deckProfile picks one level for the whole boat
// and reports a height only for the bins that actually have it, so everything
// in `all` is a piece of the same deck. All that is left is where along it.
// (This used to re-rank by height here as well, taking the lowest surface it
// could find — which on the yacht meant re-deriving the swim platform after the
// profile had correctly found the main deck.)
function pickSlots(profile, count, where = null) {
  if (!profile) return null;
  const cell = profile.span / DECK_BINS;
  const at = (i, y) => ({ x: profile.lo + (i + 0.5) * cell, y });

  // A NAMED END OF THE BOAT, when the row asks for one. The yacht's guests
  // gather at the bow because that is where passengers stand, and because it is
  // the part of that hull the player can see clearly past the superstructure.
  //
  // Searched from the end inwards, and against each bin's OWN deck rather than
  // the boat's main one: a bow is a step down from the main deck on most hulls,
  // so insisting on the main level would walk them back amidships and quietly
  // ignore what was asked for. A party filling up from the bow therefore spills
  // onto whatever deck comes next, at that deck's own height — which is a group
  // spread over a boat rather than a rank standing on one line.
  if (where === 'bow' || where === 'stern') {
    const bins = [...profile.ownHeights.keys()];
    // Local +x is the bow. The hull is turned about y to face its heading (see
    // systems/bossBoat.js), so this stays the bow whichever way it is sailing.
    if (where === 'bow') bins.reverse();
    const taken = [];
    for (const i of bins) {
      const y = profile.ownHeights[i];
      if (y == null) continue;
      const spot = at(i, y);
      // Far enough apart to be two people rather than one blurred one. A bin is
      // about half a person wide on a hull this size, so neighbouring bins are
      // not enough — and standing two guests inside each other is also one shot
      // taking both of them.
      if (taken.some((t) => Math.abs(t.x - spot.x) < cell * DECK_GAP_BINS)) continue;
      taken.push(spot);
      if (taken.length >= count) break;
    }
    return taken.length ? taken : null;
  }

  const pool = [];
  profile.heights.forEach((y, i) => {
    if (y == null) return;
    pool.push(at(i, y));
  });
  if (!pool.length) return null;

  // FARTHEST-POINT: start amidships and each next man goes wherever is
  // furthest from everyone already placed. A minimum-gap rule was tried and
  // fails the case it exists for — when the deck is short it has to give the
  // gap up, and two men end up standing in each other, which one shot then
  // takes both of.
  const middle = profile.lo + profile.span / 2;
  const taken = [pool.reduce((best, s) =>
    (Math.abs(s.x - middle) < Math.abs(best.x - middle) ? s : best))];
  while (taken.length < count && taken.length < pool.length) {
    let best = null;
    let bestGap = -1;
    for (const spot of pool) {
      if (taken.includes(spot)) continue;
      const gap = Math.min(...taken.map((t) => Math.abs(t.x - spot.x)));
      if (gap > bestGap) { bestGap = gap; best = spot; }
    }
    if (!best) break;
    taken.push(best);
  }
  // Fewer places to stand than people: the rest double up, which is at least
  // an honest answer to "there is one square metre of deck on this boat".
  return taken;
}

export function clearDeckCache() {
  deckCache.clear();
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

const _feet = new THREE.Vector3();

export function spawnCrewFor(scene, boat) {
  const c = cfg();
  if (c.enabled === false) return;
  // WHO IS ABOARD is the boat's to say. The working boats say nothing and get
  // the fisherman at the tuned count; the yacht boss names its own model and
  // brings its own party (CONFIG.enemies.bossYacht). Deliberately read off the
  // boat rather than switched on inside here — everything below this line, and
  // everything in the ragdoll, is unaware there is more than one kind of
  // person, which is what keeps the yacht from being a second code path.
  // A LIST when the boat has one, and one is rolled PER PERSON, so a party is a
  // party rather than the same man printed four times. `crewAssets` is a new key
  // rather than a list written into `crewAsset` — the same move the boss orca's
  // two bodies had to make. Saved tuning beats config.js in the merge and every
  // snapshot ever written carries `crewAsset` as the string it used to be, so a
  // list put into that key would be overwritten by the snapshot on load, for
  // anybody who has opened the tuner, and the deck would come up empty.
  const roster = boat.crewAssets?.length ? boat.crewAssets
    : [boat.crewAsset ?? DEFAULT_ASSET];
  // HOW MANY, rolled between two bounds when the boat gives them. Rolled per
  // arrival rather than fixed so two yachts in one run are not the same boat.
  const lo = boat.crewMin;
  const hi = boat.crewMax;
  const rolled = lo != null && hi != null
    ? Math.round(lo + Math.random() * Math.max(0, hi - lo))
    : (boat.crewCount ?? (boat.isTrawler ? c.trawlerCount : c.count) ?? 2);
  const count = Math.max(0, Math.round(rolled));
  if (!count) return;
  const profile = deckProfile(boat);
  const boatScale = boat.mesh.scale.x || 1;
  // Along the hull in the BOAT's own units, so the spread means the same thing
  // on a rowboat and on a trawler.
  const spread = ((boat.halfLength ?? 3) / boatScale) * (c.deckSpread ?? 0.6);
  const slots = pickSlots(profile, count, boat.crewAt ?? null);

  for (let i = 0; i < count; i++) {
    const spot = slots?.[i % slots.length];
    const deckX = spot ? spot.x : ((count === 1 ? 0 : (i / (count - 1)) * 2 - 1) * spread);
    // The boat's actual deck at that point, with the old hand-typed offset
    // kept only for a hull the measurement can't read.
    const deckY = spot?.y ?? deckAt(profile, deckX)
      ?? ((c.deckHeight ?? 0.5) * (boat.spawnScale ?? 1)) / boatScale;
    const face = Math.random() < 0.5 ? 1 : -1;

    // This person's own model, and its own measurement. Measured per ASSET and
    // cached (see primeCrew), so a mixed party costs one measurement per kind of
    // person rather than one per person.
    const asset = roster[Math.floor(Math.random() * roster.length)];
    const model = primeCrew(asset);

    let body;
    let h;
    if (model) {
      const visual = createVisual(asset);
      const scale = visual.scale.x || 1;
      const bound = bindHumanoidRig(visual, model);
      if (bound) {
        h = model.height * scale;
        body = {
          kind: 'model',
          group: visual,
          model: bound,
          // Feet to origin, so he can be stood on a deck. prepareModel centres
          // every model on its centre of mass, which on a person is the navel.
          footOffset: -model.originToFeet * scale,
          mixer: null,
          idle: null,
          playing: null,
        };
        attachClips(body, visual);
        // Tagged so the boat's own measurements can tell him from the boat.
        // He is a CHILD of the hull, and the wreck cut and the deck profile
        // both walk that hull's geometry — without this, a man standing on
        // deck when a re-measure happens becomes part of the boat.
        visual.userData.__crew = true;
        // PARENTED TO THE HULL, not merely positioned near it every frame.
        // The boat bobs, rolls with every hit, and sails; a man standing on it
        // has to do all three exactly, and being a child of it is the only way
        // that is exact rather than nearly. The counter-scale is because the
        // trawler's mesh is scaled up and its crew is not — people are people.
        visual.scale.setScalar(scale / boatScale);
        visual.position.set(deckX, deckY + body.footOffset / boatScale, 0);
        visual.rotation.y = face >= 0 ? 0 : Math.PI;
        boat.mesh.add(visual);
      }
    }
    if (!body) {
      // No model, or a model that isn't a humanoid: the box figure. Same
      // ragdoll underneath, so everything below this line is unaware.
      h = (c.height ?? 1.25) * (0.9 + Math.random() * 0.2);
    }

    boat.mesh.updateWorldMatrix(true, true);
    _feet.set(deckX, deckY, 0).applyMatrix4(boat.mesh.matrixWorld);
    const rig = buildRig(_feet.x, _feet.y, h ?? 1.25, face, body?.kind === 'model' ? body.model : null);
    if (!body) {
      const kit = makeKit(h);
      body = buildBoxBody(rig, kit, h);
      scene.add(body.group);
    }

    const figure = {
      rig,
      body,
      boat,
      height: h,
      deckX,
      deckY,
      face,
      state: 'idle',
      life: 0,
      sway: Math.random() * Math.PI * 2,
      accumulator: 0,
      wet: false,
      // GLUED TO THE DECK. A fishing boat's crew come off it one at a time —
      // a bullet finds one, and he goes over the side while the others carry
      // on — and that is most of what makes shooting at a boat feel like
      // shooting at people. A BOSS is not that: its deck is inside a bullet
      // hell that the player is spraying through for a minute at a time, so
      // hit-by-hit knock-off empties it in the first few seconds and the rest
      // of the fight is a bare hull. Glued, the party rides the whole fight
      // and all of it goes into the water at the moment the boat does — see
      // resetBossBoat, which is the only thing that can let go of them.
      glued: boat.crewGlued === true,
    };
    // WHAT IS PLANTED, while he is glued. Everything from the hips down: two
    // feet, two knees and the pelvis. Not the feet alone — pin only those and
    // the hips are free to sway, the legs swing under them, and since the drawn
    // model hangs off the hips bone the MESH's feet slide across the deck while
    // the solver's feet sit perfectly still. Pinning the whole lower body makes
    // the man rock from the waist, which is what a person standing on a boat
    // that has just been hit actually does.
    if (figure.glued) {
      for (const name of ['footL', 'footR', 'kneeL', 'kneeR', 'hips']) {
        rig.points[name].pinned = true;
      }
    }
    crew.push(figure);
    if (figure.body.kind === 'boxes') poseBoxBody(figure);
  }
}

// The idle, by the name the asset entry gives it. Driven from a plain mixer
// rather than through createAnimationController: that controller is the
// creature state machine — beat-synced idles, procedural fallbacks, spring
// chains — and a man standing on a boat wants none of it.
//
// Only the idle plays. The model ships a walk cycle too and the asset entry
// still names it, so it is one line away if the crew ever needs to move about
// the deck; nothing here runs it.
function attachClips(body, visual) {
  const clips = visual.userData.clips ?? [];
  if (!clips.length) return;
  const names = visual.userData.animationNames ?? {};
  const idleClip = (names.idle ? THREE.AnimationClip.findByName(clips, names.idle) : null) ?? clips[0];
  body.mixer = new THREE.AnimationMixer(visual);
  body.idle = body.mixer.clipAction(idleClip);
  body.idle.setLoop(THREE.LoopRepeat, Infinity);
  body.idle.enabled = true;
  // Everyone aboard starts at a different point in the loop, or a deck of two
  // reads as one man rendered twice.
  body.idle.time = Math.random() * idleClip.duration;
  body.idle.setEffectiveWeight(1).play();
  body.playing = 'idle';
}

export function resetCrew(scene) {
  for (const f of crew) disposeFigure(scene, f);
  crew.length = 0;
}

function disposeFigure(scene, f) {
  // removeFromParent, not scene.remove: while aboard a figure is a CHILD OF
  // THE BOAT, and asking the scene to remove it would leave it hanging off a
  // hull that is itself on its way out.
  f.body.group.removeFromParent();
  if (f.body.kind === 'boxes') {
    for (const g of f.body.geometries) g.dispose();
    f.body.kit.body.dispose();
    f.body.kit.shell?.dispose();
    return;
  }
  f.body.mixer?.stopAllAction();
  // Only the copies made for this man's dissolve. The model's own materials
  // are shared with everybody else wearing it and are not ours to dispose.
  for (const m of f.body.cloned ?? []) m.dispose();
}

// ---------------------------------------------------------------------------
// Leaving the boat
// ---------------------------------------------------------------------------

// The solver's fixed tick. 120Hz rather than the frame rate: a body knocked off
// a deck by a seal at speed moves further in one 60Hz step than its shortest
// bone is long, which no number of constraint iterations can tidy up
// afterwards — halving the step is what actually fixes it, and this rig is
// eleven points, so twice as many of them costs nothing worth counting.
const SOLVER_STEP = 1 / 120;

// Verlet stores velocity as the gap between this position and the last one, so
// this is how you shove a ragdoll: move where it CAME FROM.
function push(f, vx, vy, spin = 0) {
  const step = SOLVER_STEP;
  for (const p of f.rig.list) {
    p.px -= vx * step;
    p.py -= vy * step;
  }
  if (spin) {
    const hips = f.rig.points.hips;
    for (const p of f.rig.list) {
      // Tangential kick about the hips — what actually makes a thrown body
      // turn over instead of sailing off in one piece, facing the same way.
      p.px += (p.y - hips.y) * spin * step;
      p.py -= (p.x - hips.x) * spin * step;
    }
  }
}

// Hand the skeleton over. Seeded from where the model ACTUALLY IS — mid-stride,
// mid-panic, wherever the clip had him — so the ragdoll starts in the pose the
// last animated frame ended on instead of snapping to a T.
function goLimp(f, scene) {
  if (f.state === 'ragdoll') return;
  f.state = 'ragdoll';
  f.boat = null;
  // The glue is the hull's, and the hull has just let go. Cleared here rather
  // than at the call site so there is no route into the ragdoll that leaves a
  // body still claiming to be attached to a boat it is falling away from — and
  // with it the pins, or he falls into the sea with his feet nailed to where
  // the boat used to be.
  f.glued = false;
  for (const p of f.rig.list) p.pinned = false;
  const body = f.body;
  // Off the hull and into the world, keeping exactly where he already was.
  // `attach` rather than `add` is the whole difference: it composes out the
  // boat's transform, so a man thrown off a rolling, scaled trawler doesn't
  // jump a metre sideways and double in size at the moment he lets go.
  if (scene && body.group.parent && body.group.parent !== scene) scene.attach(body.group);
  if (body.kind !== 'model' || !body.mixer) return;

  body.group.updateMatrixWorld(true);
  const world = new THREE.Vector3();
  // A bone's ORIGIN is the joint at the top of it: the forearm starts at the
  // elbow, the shin at the knee. So each verlet point is read off the bone
  // BELOW it, and the shoulder and hip joints — which the ragdoll doesn't
  // have points for — are simply not read. (Reading the upper arm into the
  // chest point, which is the obvious-looking mapping, quietly moved the whole
  // torso out to one shoulder and left the figure fighting itself.)
  for (const [joint, into] of [
    ['hips', 'hips'], ['chest', 'chest'], ['head', 'head'],
    ['lowerArmL', 'elbowL'], ['lowerArmR', 'elbowR'],
    ['lowerLegL', 'kneeL'], ['lowerLegR', 'kneeR'],
  ]) {
    const seg = body.model.segments[joint];
    const p = f.rig.points[into];
    if (!seg || !p) continue;
    world.setFromMatrixPosition(seg.bone.matrixWorld);
    p.x = world.x;
    p.y = world.y;
    p.px = p.x;
    p.py = p.y;
  }
  // Hands and feet are the far ends of limbs, and no bone's origin sits there.
  // Placed along the direction the limb is actually pointing — read off the
  // bone's own measured axis — at the length the figure was built with, so a
  // hand ends up where the model's hand is rather than at a guessed offset.
  const tip = new THREE.Vector3();
  for (const [joint, from, to] of [
    ['lowerArmL', 'elbowL', 'handL'], ['lowerArmR', 'elbowR', 'handR'],
    ['lowerLegL', 'kneeL', 'footL'], ['lowerLegR', 'kneeR', 'footR'],
  ]) {
    const seg = body.model.segments[joint];
    const from0 = f.rig.points[from];
    const p = f.rig.points[to];
    if (!seg || !p) continue;
    const link = f.rig.links.find((l) => (l.a === from && l.b === to) || (l.a === to && l.b === from));
    const length = link?.rest ?? f.height * 0.18;
    world.setFromMatrixPosition(seg.bone.matrixWorld);
    tip.copy(seg.axis).applyMatrix4(seg.bone.matrixWorld).sub(world);
    if (tip.lengthSq() < 1e-10) tip.set(0, -1, 0);
    tip.normalize();
    p.x = from0.x + tip.x * length;
    p.y = from0.y + tip.y * length;
    p.px = p.x;
    p.py = p.y;
  }
  // The links and limits were measured off the standing pose; re-measure both
  // against the pose he is actually in, or the first solver tick yanks him
  // back to standing — and a limit left describing the old pose spends the
  // rest of the body's life pulling against the links.
  //
  // CLAMPED, because the measurement can lie. The model is 3D and the ragdoll
  // is flat: an arm pointing at the camera projects to almost no length at
  // all, and a forearm handed over at that instant came out 4mm long on a
  // 1.14-unit man — a bone the solver then defended for the rest of his life
  // while everything attached to it pulled the other way. A limb doesn't
  // change length; only its projection does.
  for (const link of f.rig.links) {
    const a = f.rig.points[link.a];
    const b = f.rig.points[link.b];
    const seen = Math.hypot(a.x - b.x, a.y - b.y);
    link.rest = Math.min(Math.max(seen, link.base * 0.6), link.base * 1.2);
  }
  for (const lim of f.rig.limits) {
    const a = f.rig.points[lim.a];
    const b = f.rig.points[lim.b];
    const seen = Math.hypot(a.x - b.x, a.y - b.y);
    const d = Math.min(Math.max(seen, lim.base * 0.6), lim.base * 1.2);
    lim.min = d * lim.lo;
    lim.max = d * lim.hi;
  }
  body.mixer.stopAllAction();
  body.playing = null;
  // The hull's roll was being worn by the whole model while he stood on it.
  // The bones carry every rotation from here, so anything left on the wrapper
  // would tilt the ragdoll for the rest of its life. Facing (rotation.y) does
  // stay — a man thrown off a boat is still facing the way he was.
  body.group.rotation.z = 0;
}

// The hull going up under them. Everyone still aboard is thrown, and anyone
// already in the water nearby gets shoved too.
export function blastCrew(scene, x, y, radius, strength) {
  for (const f of crew) {
    const hips = f.rig.points.hips;
    const dx = hips.x - x;
    const dy = hips.y - y;
    const dist = Math.hypot(dx, dy);
    if (dist > radius) continue;
    goLimp(f, scene);
    const power = strength * (1 - dist / Math.max(radius, 1e-3));
    const len = dist || 1;
    push(f,
      (dx / len) * power,
      // Never straight down, for the same reason the wreckage isn't: a body
      // driven into the water is a body nobody sees leave.
      Math.abs(dy / len) * power * 0.5 + power * 0.7,
      (Math.random() - 0.5) * power * 0.8);
  }
}

/**
 * THE HULL WENT DOWN AND TOOK THE PARTY WITH IT.
 *
 * Deliberately not blastCrew. That one is a point explosion and falls off to
 * nothing at its radius, which is right for a barrel going up next to somebody
 * and wrong for the deck they are standing on: a yacht's guests are spread over
 * the whole length of the hull, so a radius big enough to reach the bow leaves
 * everyone amidships getting a fraction of the shove, and a radius tuned for
 * amidships misses the ends entirely. Both were tried and each left two of the
 * four standing in mid-air where the boat used to be.
 *
 * So this reaches everyone who was ON this boat, by their glue and not by their
 * distance, and throws all of them at full strength. After that they are on the
 * solver alone — gravity, air and water drag, the seabed and the arena walls.
 *
 * @returns how many were thrown.
 */
export function throwCrewOff(scene, boat, x, y, strength) {
  let thrown = 0;
  for (const f of crew) {
    if (f.boat !== boat || f.state === 'ragdoll') continue;
    const hips = f.rig.points.hips;
    // Outward from the hull's centre. Which way that is depends on where they
    // were standing: a crew spread down a boat goes over both rails, and the
    // yacht's party — gathered at the bow, all forward of the centre — goes
    // over the bow together, which is the honest answer for a group standing
    // in one place. Someone exactly amidships has no side to be thrown to, so
    // he gets one.
    const dx = hips.x - x;
    const away = Math.abs(dx) > 1e-3 ? Math.sign(dx) : (Math.random() < 0.5 ? -1 : 1);
    // How far out along the hull he was, as a fraction of its reach: the ends
    // are whipped, amidships is mostly lifted. That is what a boat breaking its
    // back does to the people on it, and it is also what stops four bodies
    // leaving on identical arcs.
    const lever = Math.min(1, Math.abs(dx) / Math.max(boat.halfLength ?? 5, 1e-3));
    goLimp(f, scene);
    push(f,
      away * strength * (0.45 + 0.75 * lever) * (0.85 + Math.random() * 0.3),
      // Never straight sideways: the ones near the middle go UP, which is what
      // sells the deck heaving rather than the boat sliding out from under them.
      strength * (0.85 - 0.35 * lever) * (0.85 + Math.random() * 0.3),
      (Math.random() - 0.5) * strength * 0.5);
    emit('splash', hips.x, y, { scale: 0.4, dirX: 0, dirY: 1 });
    thrown++;
  }
  return thrown;
}

// SOMETHING HIT HIM. A bullet, a blast, or the seal itself going through the
// deck at speed — they're the same event from the crew's point of view: he was
// standing there a moment ago and now he isn't.
//
// Nothing here consumes the shot or reports damage. A man is not cover, and he
// has no health to speak of; the interesting part is entirely that he comes
// off the boat.
//
// Returns how many were knocked off.
export function damageCrew(scene, x, y, radius, opts = {}) {
  if (!crew.length) return 0;
  const c = cfg();
  let hit = 0;
  for (const f of crew) {
    if (f.state === 'ragdoll') continue;
    // The boss's guests do not come off one at a time — see `glued`. Skipped
    // rather than counted as a miss, so nothing upstream reports a hit it
    // didn't get.
    if (f.glued) continue;
    const hips = f.rig.points.hips;
    const dx = hips.x - x;
    const dy = hips.y - y;
    // Measured against his body, not a point: `reach` is a torso's worth
    // either side of the hips, so a shot at his head or his boots counts.
    const reach = radius + f.height * (c.hitRadius ?? 0.45);
    if (dx * dx + dy * dy > reach * reach) continue;

    hit++;
    goLimp(f, scene);
    const len = Math.hypot(dx, dy) || 1;
    const knock = (c.knock ?? 7) * (0.8 + Math.random() * 0.5);
    push(f,
      // Off the way the hit was going where the caller knows (a bullet), and
      // away from the impact otherwise.
      (opts.dirX ?? dx / len) * knock,
      Math.abs(opts.dirY ?? dy / len) * knock * 0.5 + knock * 0.55,
      (Math.random() - 0.5) * (c.knockSpin ?? 6));
    emit('splash', hips.x, bounds.surfaceY, { scale: 0.3, dirX: 0, dirY: 1 });
    opts.onCrewHit?.(hips.x, hips.y);
  }
  return hit;
}

// The boat this crew belonged to is gone. `exploded` false means it simply
// sailed off the edge of the arena, and its crew goes quietly with it.
export function releaseCrew(scene, boat, exploded) {
  for (let i = crew.length - 1; i >= 0; i--) {
    const f = crew[i];
    if (f.boat !== boat) continue;
    if (!exploded) {
      disposeFigure(scene, f);
      crew.splice(i, 1);
      continue;
    }
    goLimp(f, scene);
  }
}

// ---------------------------------------------------------------------------
// A body in the water is food
// ---------------------------------------------------------------------------
//
// Once he is off the boat and in the sea he stops being scenery and becomes the
// best meal on the map: the seal eats him on contact, and the hunters — sharks
// and the orca pod — will break off whatever they were doing to get to him.
//
// He is deliberately NOT an entry in `enemies`. He has no hp, no contact
// damage and no AI; he is a floating object that several systems are allowed
// to reach for. Everything below is that reach, and nothing else.

// Is this one in the water and available? A man still standing on a deck is
// not lunch, and neither is one still in the air on his way there.
function afloat(f) {
  return f.state === 'ragdoll' && !f.eaten && f.rig.points.hips.y < bounds.surfaceY;
}

// How big a target he is — the reach a mouth needs, from his own size.
export function crewRadius(f) {
  return f.height * ((cfg().food?.radius) ?? 0.35);
}

// The nearest body in the water to (x, y), or null. `maxDist` is the searcher's
// own reach; the body's size is added to it.
export function nearestFloatingCrew(x, y, maxDist) {
  let best = null;
  let bestD2 = Infinity;
  for (const f of crew) {
    if (!afloat(f)) continue;
    const hips = f.rig.points.hips;
    const dx = hips.x - x;
    const dy = hips.y - y;
    const reach = maxDist + crewRadius(f);
    const d2 = dx * dx + dy * dy;
    if (d2 > reach * reach || d2 >= bestD2) continue;
    bestD2 = d2;
    best = f;
  }
  return best;
}

export function crewPosition(f) {
  return f.rig.points.hips;
}

// Eaten. Returns what the meal was worth, or null if this one was already
// taken — two hunters can reach the same body on the same frame, and only one
// of them can have it.
//
// `opts.vx`/`opts.vy` are the EATER's velocity, not the body's, and are passed
// straight through to the gore burst so what comes out of him carries a share
// of what took him.
//
// THE GORE IS FIRED FROM HERE rather than from the callers' `onCrewEaten`
// hooks, and that is the whole reason this function is worth reading. There
// are four mouths in the game — the seal, a hunting shark, an orca, and the
// pod's grabber — and only three of them go through a hook; the seal's own
// meal, the one the player actually causes, is a bare call in main.js. This is
// the one line every single one of them passes through.
export function eatCrew(scene, f, opts = {}) {
  if (!f || f.eaten || !crew.includes(f)) return null;
  const food = cfg().food ?? {};
  const hips = f.rig.points.hips;
  const at = { x: hips.x, y: hips.y, xp: food.xp ?? 12, healMul: food.healMul ?? 2.5 };
  f.eaten = true;
  // The `emit('bite')` that used to be here is gone, not moved: the gore burst
  // below is ninety particles across three layers and the twenty-six pink
  // specks of a fish being swallowed were invisible inside it. The feedback
  // event's own `emit` went with it for the same reason — see
  // CONFIG.feedback.crewEaten.
  //
  // His own height is the only scale the thrown pieces are sized against — see
  // the note in systems/gore.js about why nothing there is in world units.
  spawnGore(at.x, at.y, { height: f.height, vx: opts.vx ?? 0, vy: opts.vy ?? 0 });
  const i = crew.indexOf(f);
  if (i !== -1) crew.splice(i, 1);
  disposeFigure(scene, f);
  return at;
}

// ---------------------------------------------------------------------------
// The solver
// ---------------------------------------------------------------------------

// Keep the bend at `b` from closing past `minDot` (the cosine of the widest
// angle allowed between a->b and b->c). Only `c` moves, and only around `b`,
// so the joint's length is untouched and the rest of the solver never notices.
function limitBend(a, b, c, minDot) {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const un = Math.hypot(ux, uy) || 1e-6;
  const vx = c.x - b.x;
  const vy = c.y - b.y;
  const vn = Math.hypot(vx, vy) || 1e-6;
  const nx = ux / un;
  const ny = uy / un;
  const mx = vx / vn;
  const my = vy / vn;
  const dot = nx * mx + ny * my;
  if (dot >= minDot) return;
  // Turn c the short way round until the angle is exactly at the limit.
  const cross = nx * my - ny * mx;
  const current = Math.atan2(cross, dot);
  const allowed = Math.sign(cross || 1) * Math.acos(Math.min(1, Math.max(-1, minDot)));
  const turn = allowed - current;
  const cs = Math.cos(turn);
  const sn = Math.sin(turn);
  c.x = b.x + (mx * cs - my * sn) * vn;
  c.y = b.y + (mx * sn + my * cs) * vn;
}

function solve(f, step) {
  const c = cfg();
  const points = f.rig.points;
  // A body in the air falls at the world's rate (arena.gravity), the same one
  // the seal and the ordnance use; `buoyancy` below is what makes the water a
  // different place rather than a second gravity constant.
  const gravity = CONFIG.arena.gravity;
  const waterY = bounds.surfaceY;
  const floor = bounds.bottom + (c.floorClearance ?? 0.3);

  for (const p of f.rig.list) {
    if (p.pinned) continue;
    const underwater = p.y < waterY;
    const drag = underwater ? (c.waterDrag ?? 4.5) : (c.airDrag ?? 0.25);
    const damp = Math.exp(-drag * step);
    const vx = (p.x - p.px) * damp;
    const vy = (p.y - p.py) * damp;
    // Buoyancy cancels most of gravity in the water, so a body slows hard on
    // entry and then settles rather than dropping like a stone.
    const g = underwater ? gravity * (1 - (c.buoyancy ?? 0.82)) : gravity;
    p.px = p.x;
    p.py = p.y;
    p.x += vx;
    p.y += vy - g * step * step;
  }

  const iterations = Math.max(1, Math.round(c.iterations ?? 4));
  for (let k = 0; k < iterations; k++) {
    // The one real ANGLE limit, and it goes FIRST so the link pass below
    // always gets the last word on lengths. Distance constraints alone can't
    // stop a neck folding back over the spine — head-to-hips barely shortens
    // when the bend is at the top — and a head lying on its own shoulder
    // blades is the one ragdoll failure nobody reads as physics.
    limitBend(points.hips, points.chest, points.head, c.neckLimit ?? -0.15);

    for (const link of f.rig.links) {
      const a = points[link.a];
      const b = points[link.b];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1e-6;
      const shift = ((d - link.rest) / d) * 0.5;
      const ox = dx * shift;
      const oy = dy * shift;
      if (!a.pinned) { a.x += ox; a.y += oy; }
      if (!b.pinned) { b.x -= ox; b.y -= oy; }
    }
    for (const lim of f.rig.limits) {
      const a = points[lim.a];
      const b = points[lim.b];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1e-6;
      const target = d < lim.min ? lim.min : (d > lim.max ? lim.max : 0);
      if (!target) continue;
      // Deliberately SOFT (0.5 would be a hard constraint like the links).
      // These stand in for joint limits and are approximate by nature; solved
      // as hard as the links they win arguments they shouldn't, and a folded
      // arm comes out visibly shortened.
      const shift = ((d - target) / d) * 0.5 * (c.limitStiffness ?? 0.35);
      const ox = dx * shift;
      const oy = dy * shift;
      if (!a.pinned) { a.x += ox; a.y += oy; }
      if (!b.pinned) { b.x -= ox; b.y -= oy; }
    }
    // Collisions last, so the solver can't push a body back through the floor
    // on the same tick it was lifted out of it.
    //
    // EVERY clamp moves `px` with `p`. In verlet the velocity IS the gap
    // between this position and the last one, so moving a point without
    // moving where it came from doesn't stop it — it INVENTS the speed it
    // would have needed to get there. A body thrown at the arena edge was
    // being teleported a dozen units by this and coming out at 480 units a
    // second, which is not a ragdoll, it is a bullet.
    const edge = bounds.left + 1;
    const far = bounds.right - 1;
    const bounce = c.bounce ?? 0.2;
    for (const p of f.rig.list) {
      if (p.y < floor) {
        const vy = p.y - p.py;
        p.y = floor;
        p.py = floor + vy * bounce;
        // Ground friction, applied by dragging the previous position toward
        // the current one — a body landing on the seabed shouldn't skate.
        p.px += (p.x - p.px) * (c.floorFriction ?? 0.35);
      }
      if (p.x < edge) {
        const vx = p.x - p.px;
        p.x = edge;
        p.px = edge + vx * bounce;
      } else if (p.x > far) {
        const vx = p.x - p.px;
        p.x = far;
        p.px = far + vx * bounce;
      }
    }
  }

  // BONE LENGTHS GET THE LAST WORD. Everything above — the joint limits, the
  // neck angle, the floor, the arena wall — is allowed to be approximate; a
  // limb changing length is not, because that is the one artefact that reads
  // as the model being broken rather than as a body being thrown about. An arm
  // folded against the chest could otherwise end a tick 16% short, pulled in
  // by the reach limit that was trying to push the hand back out.
  //
  // Twice, because one pass leaves the last few links carrying the error the
  // earlier ones pushed into them.
  for (let pass = 0; pass < 2; pass++) {
    for (const link of f.rig.links) {
      const a = points[link.a];
      const b = points[link.b];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1e-6;
      const shift = ((d - link.rest) / d) * 0.5;
      a.x += dx * shift;
      a.y += dy * shift;
      b.x -= dx * shift;
      b.y -= dy * shift;
    }
  }
}

// ---------------------------------------------------------------------------
// Aboard
// ---------------------------------------------------------------------------

// While aboard, the model needs nothing done to it at all — it is a child of
// the boat, so the bob, the roll and the heading arrive for free. What this
// does is keep the verlet points SHADOWING where he actually is, which is what
// makes the handover seamless: the motion of the boat is already in the
// ragdoll the instant it lets go, so a man knocked off a boat sailing left
// keeps going left without anything having to remember to add that.
function ride(f) {
  const boat = f.boat;
  if (!boat) return;
  // ANCESTORS FIRST — updateWorldMatrix(true, …), not updateMatrixWorld(true).
  // The two names are one letter apart and do opposite halves of the job:
  // updateMatrixWorld rebuilds this node and everything UNDER it from its
  // parent's CACHED world matrix, so on a node that hangs off something else —
  // and a boss's hull is a body inside a creature's container — it happily
  // composes against a stale parent and places the man where the boat was last
  // frame. In the browser that is a frame of lag nobody sees; in a Node harness,
  // where nothing ever renders and the container's matrix is never refreshed at
  // all, it is a man standing forty units from his boat.
  boat.mesh.updateWorldMatrix(true, true);
  _feet.set(f.deckX, f.deckY, 0).applyMatrix4(boat.mesh.matrixWorld);

  const pose = standingPose(_feet.x, _feet.y, f.height, f.face,
    f.body.kind === 'model' ? f.body.model : null);
  for (const [name, at] of Object.entries(pose)) {
    const p = f.rig.points[name];
    p.px = p.x;
    p.py = p.y;
    p.x = at.x;
    p.y = at.y;
  }
}

// The bone-length pass on its own. `solve` has always ended with one; the
// standing sway below needs the same thing and for the same reason, so it is
// one function rather than two copies that can drift apart.
function settleLinks(f, passes) {
  const points = f.rig.points;
  for (let pass = 0; pass < passes; pass++) {
    for (const link of f.rig.links) {
      const a = points[link.a];
      const b = points[link.b];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1e-6;
      const shift = ((d - link.rest) / d) * 0.5;
      const ox = dx * shift;
      const oy = dy * shift;
      if (!a.pinned) { a.x += ox; a.y += oy; }
      if (!b.pinned) { b.x -= ox; b.y -= oy; }
    }
  }
}

// ---------------------------------------------------------------------------
// STANDING, BUT NOT A STATUE
// ---------------------------------------------------------------------------
//
// `ride` above is a hard snap: every joint is written to where a standing man's
// joint goes, every frame. It is right for a fishing boat's crew, who are on
// screen for a few seconds before something shoots them, and it is wrong for a
// BOSS's deck, which the player stares at for a minute while shelling it. A
// figure that cannot move at all next to a hull that rolls and takes hits reads
// as scenery painted on the boat.
//
// So a glued figure is solved instead of snapped:
//
//   THE FEET ARE PLANTED. Pinned, and rewritten from the deck every tick, so
//        they ride the hull's bob and roll exactly and no accumulated sway can
//        walk a man off his own spot.
//
//   EVERYTHING ABOVE IS SPRUNG toward where it would be if he were standing
//        still. That single spring does all three jobs at once: it carries the
//        boat's motion up through the body (the deck moves, the target moves,
//        the body follows late), it lets a jostle displace him, and it is what
//        brings him back to the idle afterwards. There is no separate "return"
//        behaviour to get wrong.
//
//   AND NO GRAVITY. He is holding himself up; that is what standing IS. Gravity
//        here would only be a constant the spring has to win against, and the
//        amount it lost by would be a permanent slouch.
function swayAboard(f, dt) {
  const boat = f.boat;
  if (!boat) return;
  boat.mesh.updateWorldMatrix(true, true);
  _feet.set(f.deckX, f.deckY, 0).applyMatrix4(boat.mesh.matrixWorld);
  const pose = standingPose(_feet.x, _feet.y, f.height, f.face,
    f.body.kind === 'model' ? f.body.model : null);

  const c = cfg().sway ?? {};
  const stiffness = c.stiffness ?? 120;
  const damping = c.damping ?? 7;
  const step = SOLVER_STEP;

  f.accumulator = Math.min(f.accumulator + dt, step * 8);
  while (f.accumulator >= step) {
    const decay = Math.exp(-damping * step);
    for (const [name, at] of Object.entries(pose)) {
      const p = f.rig.points[name];
      if (p.pinned) {
        // Position AND history. Writing only the position would have the
        // solver read the boat's own travel as this man's velocity, and a
        // figure on a boat crossing the arena would be permanently blown
        // backwards by his own ride.
        p.x = at.x; p.y = at.y; p.px = at.x; p.py = at.y;
        continue;
      }
      const vx = (p.x - p.px) * decay + (at.x - p.x) * stiffness * step * step;
      const vy = (p.y - p.py) * decay + (at.y - p.y) * stiffness * step * step;
      p.px = p.x; p.py = p.y;
      p.x += vx; p.y += vy;
    }
    // Bone lengths still get the last word, exactly as in the ragdoll — a
    // spring pulling eleven points independently is free to stretch him.
    settleLinks(f, 2);
    f.accumulator -= step;
  }
}

/**
 * SOMETHING HIT THE BOAT. Not the man — the deck under him.
 *
 * The party is glued on (see `glued`), so a hit cannot take anyone off; what it
 * does instead is shove the top of every body on that deck and let the spring
 * in swayAboard haul it back upright. Which is the whole point of gluing them:
 * a boss's deck stays populated for the fight AND still visibly reacts to being
 * shot, where knocking men off one at a time gave a reaction once each and then
 * an empty boat.
 *
 * Scaled by height above the feet, so the shove is a body rocking on its heels
 * rather than a figure sliding sideways.
 */
export function jostleCrew(x, y, radius, power = 1) {
  if (!crew.length) return 0;
  const c = cfg().sway ?? {};
  const kick = (c.jostle ?? 3.2) * power;
  const step = SOLVER_STEP;
  let shaken = 0;
  for (const f of crew) {
    if (!f.glued || f.state === 'ragdoll') continue;
    const hips = f.rig.points.hips;
    const dx = hips.x - x;
    const dy = hips.y - y;
    const dist = Math.hypot(dx, dy);
    if (dist > radius) continue;
    shaken++;
    const falloff = 1 - dist / Math.max(radius, 1e-3);
    // Away from the blow, and always a little up: a deck heaving under a man
    // lifts him as well as pushing him.
    const len = dist || 1;
    const ax = (dx / len) * kick * falloff;
    const ay = Math.abs(dy / len) * kick * falloff * 0.4;
    const foot = f.rig.points.footL.y;
    for (const p of f.rig.list) {
      if (p.pinned) continue;
      // Height above the feet as a fraction of the man — the hat end takes the
      // whole kick, the hips a third of it, and the ankles nothing.
      const up = Math.max(0, (p.y - foot) / Math.max(f.height, 1e-3));
      p.px -= ax * up * step;
      p.py -= ay * up * step;
    }
  }
  return shaken;
}

export function updateCrew(dt, scene) {
  if (!crew.length) return;
  const c = cfg();
  const life = c.life ?? 9;
  const fade = c.fade ?? 1.6;
  const step = SOLVER_STEP;

  for (let i = crew.length - 1; i >= 0; i--) {
    const f = crew[i];

    // Aboard: he idles, and that is all he does. He comes off the boat when
    // something hits him (damageCrew) or when the hull goes up under him
    // (blastCrew) — never on his own initiative.
    if (f.state !== 'ragdoll') {
      // Glued figures SWAY on their planted feet; everyone else is snapped to
      // the standing pose. See swayAboard for why a boss's deck needs the
      // difference and an ordinary fishing boat does not.
      if (f.glued) swayAboard(f, dt);
      else ride(f);
      f.body.mixer?.update(dt);
      // Only a glued figure is POSED while aboard. Everyone else is a plain
      // animated model riding the hull, which is what they have always been —
      // there is no sway to draw, and driving the bones would only replace a
      // walk cycle with a mannequin.
      if (f.glued && f.body.kind === 'model') poseModelBody(f, false, DRIVEN_ABOARD);
      else if (f.body.kind === 'boxes') poseBoxBody(f);
      continue;
    }

    f.life += dt;

    // Fixed timestep: a constraint solver run at whatever dt the frame happens
    // to be is a constraint solver that behaves differently on every machine,
    // and at a long frame it detonates.
    f.accumulator = Math.min(f.accumulator + dt, step * 8);
    while (f.accumulator >= step) {
      solve(f, step);
      f.accumulator -= step;
    }

    const hips = f.rig.points.hips;
    const underwater = hips.y < bounds.surfaceY;
    if (underwater && !f.wet) {
      emit('splash', hips.x, bounds.surfaceY, { scale: 0.5, dirX: 0, dirY: 1 });
    }
    f.wet = underwater;

    if (f.body.kind === 'model') poseModelBody(f);
    else poseBoxBody(f);

    const left = life - f.life;
    if (left < fade) {
      const cut = Math.min(1, Math.max(0, 1 - left / fade));
      if (f.body.kit) f.body.kit.uniforms.uDissolve.value = cut;
      else fadeModel(f.body, f.height, cut);
    }
    if (f.life >= life) {
      disposeFigure(scene, f);
      crew.splice(i, 1);
    }
  }
}

// The model wears the asset's own shared materials, which every other crew
// member is wearing too — so this one can't be faded through them. Its
// materials are cloned on the way out, once, and the dissolve written to the
// copies.
function fadeModel(body, height, cut) {
  if (!body.kit) {
    const uniforms = dissolveUniforms(height, cfg().dissolveCells ?? 7);
    body.cloned = [];
    body.group.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh || !o.material) return;
      const rim = o.userData.__isOutline || o.material.userData?.__isOutline;
      const copy = attachDissolve(o.material.clone(), uniforms, rim ? 'crewModelRim' : 'crewModelBody');
      copy.needsUpdate = true;
      o.material = copy;
      body.cloned.push(copy);
    });
    body.kit = { uniforms };
  }
  body.kit.uniforms.uDissolve.value = cut;
}
