import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';
import { emit } from '../entities/particles.js';
import { makeOutlineMaterial } from '../assets.js';
import { attachDissolve, dissolveUniforms, roundedNormalBox } from './dissolve.js';

// The people on the boats. They stand on deck while the hull is healthy, throw
// themselves overboard once it's clearly going down, and go limp the moment
// they leave it — and when the boat finally explodes, whoever was still aboard
// goes with the blast.
//
// PLACEHOLDER ART, REAL RIG. The figure is a verlet ragdoll: eleven points and
// a set of distance constraints, which is what actually produces the motion.
// What's DRAWN is one box per bone, built here. Swapping in a real model later
// is a matter of binding its bones to the segments below by name and deleting
// buildBody — nothing else in this file knows or cares what the segments look
// like, and the joint layout is already the one a humanoid rig has.
//
// Verlet rather than a spring rig (systems/boneSpring.js) or IK
// (systems/ikChain.js) because those two both drive bones toward a pose that
// something else authored. A ragdoll has no pose to reach: it has lengths that
// must hold and joints that must not bend backwards, which is exactly what a
// constraint solver is and neither of the others is.

export const crew = [];

// Bone lengths and rest offsets, all as a fraction of the figure's height, so
// one number in CONFIG sizes the whole person. Origin is between the feet.
const RIG = {
  foot: 0.00,
  knee: 0.26,
  hip: 0.52,
  chest: 0.80,
  head: 0.95,
  legSplay: 0.09, // ± x of the feet
  armSplay: 0.16, // ± x of the hands
  elbowDrop: 0.18, // below the shoulder
  handDrop: 0.36,
};

// Which points each drawn bone runs between, and how thick to draw it. A real
// model binds here: same names, same endpoints.
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

const HEAD_SIZE = 0.19; // drawn as its own box rather than as a bone

function cfg() {
  return CONFIG.boats.crew ?? {};
}

// The standing pose, in world coordinates around (x, y) with the feet on y.
// `face` is +1 or -1 — which way the figure is turned, so a crew member looks
// along the boat rather than all of them facing the same way.
function standingPose(x, y, h, face) {
  const p = (dx, dy) => ({ x: x + dx * h * face, y: y + dy * h });
  return {
    head: p(0, RIG.head),
    chest: p(0, RIG.chest),
    hips: p(0, RIG.hip),
    elbowL: p(-RIG.armSplay * 0.7, RIG.chest - RIG.elbowDrop),
    handL: p(-RIG.armSplay, RIG.chest - RIG.handDrop),
    elbowR: p(RIG.armSplay * 0.7, RIG.chest - RIG.elbowDrop),
    handR: p(RIG.armSplay, RIG.chest - RIG.handDrop),
    kneeL: p(-RIG.legSplay * 0.8, RIG.knee),
    footL: p(-RIG.legSplay, RIG.foot),
    kneeR: p(RIG.legSplay * 0.8, RIG.knee),
    footR: p(RIG.legSplay, RIG.foot),
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

// Loose links: they only pull when the joint has gone further than a body can.
// This is what stands in for joint limits — a knee that can't straighten past
// its leg length and a spine that can't fold in half. Cheaper and steadier
// than real angular constraints, and at this size nobody can tell.
const LIMITS = [
  ['head', 'hips', 0.55, 1.05],
  ['chest', 'kneeL', 0.4, 1.0], ['chest', 'kneeR', 0.4, 1.0],
  ['chest', 'handL', 0.45, 1.0], ['chest', 'handR', 0.45, 1.0],
  ['hips', 'footL', 0.5, 1.0], ['hips', 'footR', 0.5, 1.0],
  ['footL', 'footR', 0.25, 1.6],
  ['handL', 'handR', 0.2, 1.6],
];

function buildRig(x, y, h, face) {
  const pose = standingPose(x, y, h, face);
  const points = {};
  for (const [name, at] of Object.entries(pose)) {
    // prev === pos means "at rest": verlet reads velocity as the gap between
    // them, so a figure built this way starts stationary rather than exploding.
    points[name] = { x: at.x, y: at.y, px: at.x, py: at.y, pinned: false };
  }
  const links = LINKS.map(([a, b]) => ({
    a, b, rest: Math.hypot(points[a].x - points[b].x, points[a].y - points[b].y),
  }));
  const limits = LIMITS.map(([a, b, lo, hi]) => {
    const d = Math.hypot(points[a].x - points[b].x, points[a].y - points[b].y);
    return { a, b, min: d * lo, max: d * hi };
  });
  // The solver runs this list several times per tick per figure; walking
  // Object.values() there would allocate an array each pass.
  return { points, links, limits, list: Object.values(points) };
}

// One box per bone, at that bone's rest length. Sizes are baked into the
// geometry rather than applied as scale so the rim, which the shader pushes in
// object space, comes out the same width on every limb (see dissolve.js).
function buildBody(rig, kit, h) {
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
    // Built along Y and rotated to face, so the bone's own length is the axis
    // the constraint solver holds constant.
    add(roundedNormalBox(seg.thick * h, length, seg.depth * h), { a: seg.a, b: seg.b, name: seg.name });
  }
  const size = HEAD_SIZE * h;
  add(roundedNormalBox(size, size * 1.1, size), { a: 'head', b: null, name: 'head' });

  return { group, parts, geometries };
}

// Point the drawn bones at wherever the solver left the joints.
function poseBody(figure) {
  const { points } = figure.rig;
  for (const part of figure.body.parts) {
    const a = points[part.a];
    if (!part.b) {
      // The head rides its own point, tilted with the neck so it doesn't stay
      // bolt upright on a body that has gone over.
      const chest = points.chest;
      part.mesh.position.set(a.x, a.y, 0);
      part.mesh.rotation.z = Math.atan2(a.x - chest.x, a.y - chest.y) * -1;
      part.rim?.position.copy(part.mesh.position);
      if (part.rim) part.rim.rotation.z = part.mesh.rotation.z;
      continue;
    }
    const b = points[part.b];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    // The box is built along +Y, so the angle is measured off vertical.
    const angle = Math.atan2(a.x - b.x, a.y - b.y) * -1;
    part.mesh.position.set(mx, my, 0);
    part.mesh.rotation.z = angle;
    if (part.rim) {
      part.rim.position.copy(part.mesh.position);
      part.rim.rotation.z = angle;
    }
  }
}

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

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

export function spawnCrewFor(scene, boat) {
  const c = cfg();
  if (c.enabled === false) return;
  const min = Math.max(0, Math.round((boat.isTrawler ? c.trawlerMin : c.min) ?? 1));
  const max = Math.max(min, Math.round((boat.isTrawler ? c.trawlerMax : c.max) ?? 2));
  const count = min + ((Math.random() * (max - min + 1)) | 0);
  const spread = (boat.halfLength ?? 3) * (c.deckSpread ?? 0.6);

  for (let i = 0; i < count; i++) {
    // Height varies a little per person; nothing here scales with the boat,
    // because a trawler being bigger than a rowboat doesn't make its crew
    // bigger. See CONFIG.boats.crew.height.
    const h = (c.height ?? 1.25) * (0.9 + Math.random() * 0.2);
    // Spaced across the deck rather than placed at random, or two of three
    // spawn inside each other.
    const slot = count === 1 ? 0 : (i / (count - 1)) * 2 - 1;
    const deckX = slot * spread + (Math.random() - 0.5) * spread * 0.25;
    const deckY = (c.deckHeight ?? 0.5) * (boat.spawnScale ?? 1);
    const face = Math.random() < 0.5 ? 1 : -1;

    const rig = buildRig(boat.mesh.position.x + deckX, boat.mesh.position.y + deckY, h, face);
    const kit = makeKit(h);
    const body = buildBody(rig, kit, h);
    scene.add(body.group);

    crew.push({
      rig,
      body,
      kit,
      boat,
      height: h,
      deckX,
      deckY,
      face,
      state: 'aboard',
      // Staggered, so a crew doesn't leave in formation.
      bailIn: (c.bailDelay ?? 0.35) * i + Math.random() * (c.bailSpread ?? 0.9),
      life: 0,
      sway: Math.random() * Math.PI * 2,
      accumulator: 0,
      wet: false,
    });
  }
}

export function resetCrew(scene) {
  for (const f of crew) disposeFigure(scene, f);
  crew.length = 0;
}

function disposeFigure(scene, f) {
  scene.remove(f.body.group);
  for (const g of f.body.geometries) g.dispose();
  f.kit.body.dispose();
  f.kit.shell?.dispose();
}

// ---------------------------------------------------------------------------
// Leaving the boat
// ---------------------------------------------------------------------------

// Verlet stores velocity as the gap between this position and the last one, so
// this is how you shove a ragdoll: move where it CAME FROM.
function push(f, vx, vy, spin = 0) {
  const step = 1 / 60;
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

function goLimp(f) {
  f.state = 'ragdoll';
  f.boat = null;
}

// Over the side. `dir` is which way the boat is from them, so they jump away
// from it rather than through it.
function bail(f, dir) {
  const c = cfg();
  goLimp(f);
  push(f,
    dir * (c.jumpOut ?? 3.4) * (0.7 + Math.random() * 0.6),
    (c.jumpUp ?? 5.5) * (0.8 + Math.random() * 0.5),
    (Math.random() - 0.5) * (c.jumpSpin ?? 4));
}

// The hull going up under them. Everyone still aboard is thrown, and anyone
// already in the water nearby gets shoved too.
export function blastCrew(x, y, radius, strength) {
  for (const f of crew) {
    const hips = f.rig.points.hips;
    const dx = hips.x - x;
    const dy = hips.y - y;
    const dist = Math.hypot(dx, dy);
    if (dist > radius) continue;
    if (f.state === 'aboard') goLimp(f);
    const push0 = strength * (1 - dist / Math.max(radius, 1e-3));
    const len = dist || 1;
    push(f,
      (dx / len) * push0,
      // Never straight down, for the same reason the wreckage isn't: a body
      // driven into the water is a body nobody sees leave.
      Math.abs(dy / len) * push0 * 0.5 + push0 * 0.7,
      (Math.random() - 0.5) * push0 * 0.8);
  }
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
    goLimp(f);
  }
}

// ---------------------------------------------------------------------------
// The solver
// ---------------------------------------------------------------------------

function solve(f, step) {
  const c = cfg();
  const points = f.rig.points;
  const gravity = c.gravity ?? 22;
  const waterY = bounds.surfaceY;
  const floor = bounds.bottom + (c.floorClearance ?? 0.3);

  for (const p of f.rig.list) {
    if (p.pinned) continue;
    const underwater = p.y < waterY;
    const drag = underwater ? (c.waterDrag ?? 4.5) : (c.airDrag ?? 0.25);
    const damp = Math.exp(-drag * step);
    let vx = (p.x - p.px) * damp;
    let vy = (p.y - p.py) * damp;
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
      const shift = ((d - target) / d) * 0.5;
      const ox = dx * shift;
      const oy = dy * shift;
      if (!a.pinned) { a.x += ox; a.y += oy; }
      if (!b.pinned) { b.x -= ox; b.y -= oy; }
    }
    // Collisions last, so the solver can't push a body back through the floor
    // on the same tick it was lifted out of it.
    for (const p of f.rig.list) {
      if (p.y < floor) {
        p.y = floor;
        // Ground friction, applied by dragging the previous position toward
        // the current one — a body landing on the seabed shouldn't skate.
        p.px += (p.x - p.px) * (c.floorFriction ?? 0.35);
      }
      const edge = bounds.left + 1;
      const far = bounds.right - 1;
      if (p.x < edge) p.x = edge;
      if (p.x > far) p.x = far;
    }
  }
}

// While aboard, the figure is placed rather than simulated: it stands on the
// deck and rides the boat's bob. Positions are written straight into the verlet
// points (and their previous positions left alone), which means the motion of
// the boat is ALREADY in the ragdoll the instant it lets go — a crew member
// who bails off a boat sailing left keeps going left, for free.
function ride(f, dt) {
  const boat = f.boat;
  if (!boat) return;
  f.sway += dt * (cfg().swaySpeed ?? 2.2);
  const lean = Math.sin(f.sway) * (cfg().sway ?? 0.03);
  const x = boat.mesh.position.x + f.deckX * (boat.dir >= 0 ? 1 : -1);
  const y = boat.mesh.position.y + f.deckY;
  const pose = standingPose(x + lean, y, f.height, f.face);
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
  const step = 1 / 60;

  for (let i = crew.length - 1; i >= 0; i--) {
    const f = crew[i];

    if (f.state === 'aboard') {
      const boat = f.boat;
      // The hull is clearly going down — time to go. Panic is measured on the
      // boat's health, so a boat chipped at slowly empties gradually and one
      // deleted in a single hit never gets the chance (its crew is thrown by
      // the explosion instead, see blastCrew).
      const hurt = boat && boat.hp / Math.max(boat.maxHp, 1e-3) <= (c.panicAt ?? 0.35);
      if (hurt) {
        f.bailIn -= dt;
        if (f.bailIn <= 0) {
          bail(f, boat.dir >= 0 ? -1 : 1);
          emit('splash', f.rig.points.hips.x, bounds.surfaceY, { scale: 0.25, dirX: 0, dirY: 1 });
        }
      }
      if (f.state === 'aboard') {
        ride(f, dt);
        poseBody(f);
        continue;
      }
    }

    f.life += dt;

    // Fixed timestep: a constraint solver run at whatever dt the frame happens
    // to be is a constraint solver that behaves differently on every machine,
    // and at a long frame it detonates.
    f.accumulator = Math.min(f.accumulator + dt, step * 6);
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

    poseBody(f);

    const left = life - f.life;
    if (left < fade) f.kit.uniforms.uDissolve.value = Math.min(1, Math.max(0, 1 - left / fade));
    if (f.life >= life) {
      disposeFigure(scene, f);
      crew.splice(i, 1);
    }
  }
}
