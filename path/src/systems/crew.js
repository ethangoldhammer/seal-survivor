import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';
import { emit } from '../entities/particles.js';
import { createVisual, hasModel, makeOutlineMaterial } from '../assets.js';
import { attachDissolve, dissolveUniforms, roundedNormalBox } from './dissolve.js';
import { buildHumanoidRig, bindHumanoidRig, aimBone, anchorToHips } from './humanoidRig.js';

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
// every vertex and the bone map are the same for every person aboard every
// boat, so this happens once a session.
const ASSET = 'fisherman';
let measured;
let measuredFailed = false;

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
export function primeCrew() {
  if (measured !== undefined || measuredFailed) return measured ?? null;
  if (!hasModel(ASSET)) return null;
  try {
    const probe = createVisual(ASSET);
    measured = buildHumanoidRig(probe) ?? null;
    if (!measured) {
      measuredFailed = true;
      console.warn('[crew] the crew model did not measure up as a humanoid — using the box body');
    }
  } catch (err) {
    measuredFailed = true;
    console.warn('[crew] could not measure the crew model', err);
  }
  return measured ?? null;
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

// Hand the skeleton over to the ragdoll for this frame.
function poseModelBody(figure) {
  const { model } = figure.body;
  const points = figure.rig.points;
  // Parents before children: aimBone reads its parent's world rotation, so the
  // torso has to be solved before the arms hanging off it.
  for (const [joint, from, to, sign] of DRIVEN) {
    const seg = model.segments[joint];
    if (!seg) continue;
    const a = points[from];
    const b = points[to];
    aimBone(seg, (b.x - a.x) * (sign ?? 1), (b.y - a.y) * (sign ?? 1));
  }
  anchorToHips(figure.body.group, model.segments.hips.bone, points.hips.x, points.hips.y);
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
const DECK_BINS = 24;
const DECK_COVERAGE = 1.0; // cells-worth of surface before you can stand on it
const deckCache = new Map();

function deckProfile(boat) {
  const cached = deckCache.get(boat.assetKey);
  if (cached !== undefined) return cached;

  boat.mesh.updateMatrixWorld(true);
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
    const area = cross.crossVectors(ab, ac).length() * 0.5;
    if (!(area > 0)) continue;
    // Spread over the cells it actually covers, or one long deck plank lands
    // entirely on whichever cell held its centroid.
    const samples = Math.min(24, Math.max(1, Math.ceil(area / cellArea)));
    const share = area / samples;
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
  const heights = columns.map((rows) => {
    let best = null;
    for (const [row, area] of rows) {
      // Above the waterline. These hulls float half-submerged — a boat's own
      // origin sits at the water — so the biggest surface under a point near
      // the stern is often a piece of hull half a metre down, and standing on
      // it put a fisherman up to his knees in the sea.
      if (row < 0 || area < need) continue;
      // The LOWEST surface above the water, not the highest: that is the main
      // deck, which is where a crew works. Taking the highest put a man on the
      // trawler's bridge roof, standing in the middle of its rigging.
      if (best == null || row < best) best = row;
    }
    return best == null ? null : (best + 1) * cell;
  });
  const profile = { lo, span, heights };
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

// Where on the boat people actually stand. Not evenly spaced along it — the
// LOWEST decks first, kept apart from each other.
//
// Height is the whole ranking: the lowest surface above the water is the main
// working deck, and the highest is a wheelhouse roof or the top of a gantry.
// Spacing them evenly along the hull instead put one man out on the trawler's
// aft structure, standing in the rigging.
function pickSlots(profile, count) {
  if (!profile) return null;
  const cell = profile.span / DECK_BINS;
  const all = [];
  profile.heights.forEach((y, i) => {
    if (y == null) return;
    all.push({ x: profile.lo + (i + 0.5) * cell, y });
  });
  if (!all.length) return null;

  // The main deck: everything within a cell of the lowest surface found. A
  // wheelhouse roof is a place to stand, but not while there's deck free.
  const lowest = Math.min(...all.map((s) => s.y));
  let pool = all.filter((s) => s.y <= lowest + cell);
  if (pool.length < count) pool = all;

  // Then FARTHEST-POINT: start amidships and each next man goes wherever is
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
  const model = primeCrew();
  const count = Math.max(0, Math.round((boat.isTrawler ? c.trawlerCount : c.count) ?? 2));
  if (!count) return;
  const profile = deckProfile(boat);
  const boatScale = boat.mesh.scale.x || 1;
  // Along the hull in the BOAT's own units, so the spread means the same thing
  // on a rowboat and on a trawler.
  const spread = ((boat.halfLength ?? 3) / boatScale) * (c.deckSpread ?? 0.6);
  const slots = pickSlots(profile, count);

  for (let i = 0; i < count; i++) {
    const spot = slots?.[i % slots.length];
    const deckX = spot ? spot.x : ((count === 1 ? 0 : (i / (count - 1)) * 2 - 1) * spread);
    // The boat's actual deck at that point, with the old hand-typed offset
    // kept only for a hull the measurement can't read.
    const deckY = spot?.y ?? deckAt(profile, deckX)
      ?? ((c.deckHeight ?? 0.5) * (boat.spawnScale ?? 1)) / boatScale;
    const face = Math.random() < 0.5 ? 1 : -1;

    let body;
    let h;
    if (model) {
      const visual = createVisual(ASSET);
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

    boat.mesh.updateMatrixWorld(true);
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
    };
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
export function eatCrew(scene, f) {
  if (!f || f.eaten || !crew.includes(f)) return null;
  const food = cfg().food ?? {};
  const hips = f.rig.points.hips;
  const at = { x: hips.x, y: hips.y, xp: food.xp ?? 12, healMul: food.healMul ?? 2.5 };
  f.eaten = true;
  emit('bite', at.x, at.y, { scale: 1.2 });
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
  boat.mesh.updateMatrixWorld(true);
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
      ride(f);
      f.body.mixer?.update(dt);
      if (f.body.kind === 'boxes') poseBoxBody(f);
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
