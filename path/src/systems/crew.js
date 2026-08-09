import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';
import { emit } from '../entities/particles.js';
import { createVisual, hasModel, makeOutlineMaterial } from '../assets.js';
import { attachDissolve, dissolveUniforms, roundedNormalBox } from './dissolve.js';
import { buildHumanoidRig, bindHumanoidRig, aimBone, anchorToHips } from './humanoidRig.js';

// The man on the boat.
//
// He has three lives in one file. Standing on deck he is an ordinary animated
// model playing an idle. Once the hull is holed he panics — the same walk
// cycle at speed, pacing the deck, turning at the rail. And when the boat goes
// up he stops being an animation at all: the mixer is switched off and a verlet
// ragdoll takes his skeleton over, throws him off the blast, and lets the water
// have him.
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
// Spawning
// ---------------------------------------------------------------------------

export function spawnCrewFor(scene, boat) {
  const c = cfg();
  if (c.enabled === false) return;
  const model = primeCrew();
  const min = Math.max(0, Math.round((boat.isTrawler ? c.trawlerMin : c.min) ?? 1));
  const max = Math.max(min, Math.round((boat.isTrawler ? c.trawlerMax : c.max) ?? 2));
  const count = min + ((Math.random() * (max - min + 1)) | 0);
  const spread = (boat.halfLength ?? 3) * (c.deckSpread ?? 0.6);

  for (let i = 0; i < count; i++) {
    const slot = count === 1 ? 0 : (i / (count - 1)) * 2 - 1;
    const deckX = slot * spread + (Math.random() - 0.5) * spread * 0.25;
    const deckY = (c.deckHeight ?? 0.5) * (boat.spawnScale ?? 1);
    const face = Math.random() < 0.5 ? 1 : -1;
    const x = boat.mesh.position.x + deckX;
    const y = boat.mesh.position.y + deckY;

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
          walk: null,
          playing: null,
        };
        attachClips(body, visual);
        scene.add(visual);
      }
    }
    if (!body) {
      // No model, or a model that isn't a humanoid: the box figure. Same
      // ragdoll underneath, so everything below this line is unaware.
      h = (c.height ?? 1.25) * (0.9 + Math.random() * 0.2);
    }

    const rig = buildRig(x, y, h ?? 1.25, face, body?.kind === 'model' ? body.model : null);
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
      pace: face, // which way he is walking while panicking
      panicFor: 0,
      life: 0,
      sway: Math.random() * Math.PI * 2,
      accumulator: 0,
      wet: false,
    };
    crew.push(figure);
    // Stood on the deck NOW rather than on the first update. A model is added
    // to the scene at the world origin, and one frame of a fisherman standing
    // in open water at (0, 0) is one frame too many.
    ride(figure, 0);
    if (figure.body.kind === 'boxes') poseBoxBody(figure);
  }
}

// The two clips, by the names the asset entry gives them. Driven from a plain
// mixer rather than through createAnimationController: that controller is the
// creature state machine — beat-synced idles, procedural fallbacks, spring
// chains — and a man walking on a boat wants none of it.
function attachClips(body, visual) {
  const clips = visual.userData.clips ?? [];
  if (!clips.length) return;
  const names = visual.userData.animationNames ?? {};
  const find = (key) => (names[key] ? THREE.AnimationClip.findByName(clips, names[key]) : null);
  const idleClip = find('idle') ?? clips[0];
  const walkClip = find('swim') ?? find('boost') ?? idleClip;
  body.mixer = new THREE.AnimationMixer(visual);
  body.idle = body.mixer.clipAction(idleClip);
  body.walk = body.mixer.clipAction(walkClip);
  for (const action of [body.idle, body.walk]) {
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.enabled = true;
  }
  // Everyone aboard is at a different point in the loop, or a deck of three
  // reads as one man rendered three times.
  body.idle.time = Math.random() * idleClip.duration;
  body.idle.setEffectiveWeight(1).play();
  body.playing = 'idle';
}

function playClip(body, which, speed = 1) {
  if (!body.mixer || body.playing === which) {
    if (body.mixer && which === 'walk') body.walk.timeScale = speed;
    return;
  }
  const from = body.playing === 'idle' ? body.idle : body.walk;
  const to = which === 'idle' ? body.idle : body.walk;
  to.timeScale = which === 'walk' ? speed : 1;
  to.reset().setEffectiveWeight(1).play();
  from.crossFadeTo(to, cfg().clipFade ?? 0.18, false);
  body.playing = which;
}

export function resetCrew(scene) {
  for (const f of crew) disposeFigure(scene, f);
  crew.length = 0;
}

function disposeFigure(scene, f) {
  scene.remove(f.body.group);
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

// Hand the skeleton over. Seeded from where the model ACTUALLY IS — mid-stride,
// mid-panic, wherever the clip had him — so the ragdoll starts in the pose the
// last animated frame ended on instead of snapping to a T.
function goLimp(f) {
  if (f.state === 'ragdoll') return;
  f.state = 'ragdoll';
  f.boat = null;
  const body = f.body;
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

// Over the side. `dir` is which way to jump.
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
    goLimp(f);
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
  const gravity = c.gravity ?? 22;
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

  // BONE LENGTHS GET THE LAST WORD. Everything above — the joint limits, the
  // neck angle, the floor — is allowed to be approximate; a limb changing
  // length is not, because that is the one artefact that reads as the model
  // being broken rather than as a body being thrown about. An arm folded
  // against the chest could otherwise end a tick 16% short, pulled in by the
  // reach limit that was trying to push the hand back out.
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

// ---------------------------------------------------------------------------
// Aboard
// ---------------------------------------------------------------------------

// While aboard, the figure is placed rather than simulated. Positions are
// written straight into the verlet points as well, which means the motion of
// the boat is ALREADY in the ragdoll the instant it lets go — a man who goes
// over the side of a boat sailing left keeps going left, for free.
function ride(f, dt) {
  const boat = f.boat;
  if (!boat) return;
  const c = cfg();
  const spread = (boat.halfLength ?? 3) * (c.deckSpread ?? 0.6);

  if (f.state === 'panic') {
    // Pacing the deck, turning at the rail. This is the panic: the same walk
    // cycle, faster, going nowhere.
    f.deckX += f.pace * (c.panicSpeed ?? 2.2) * dt;
    if (f.deckX > spread) { f.deckX = spread; f.pace = -1; }
    if (f.deckX < -spread) { f.deckX = -spread; f.pace = 1; }
    f.face = f.pace;
    playClip(f.body, 'walk', c.panicClipSpeed ?? 1.9);
  } else {
    f.sway += dt * (c.swaySpeed ?? 2.2);
    playClip(f.body, 'idle');
  }

  const lean = f.state === 'panic' ? 0 : Math.sin(f.sway) * (c.sway ?? 0.03);
  const x = boat.mesh.position.x + f.deckX * (boat.dir >= 0 ? 1 : -1) + lean;
  const y = boat.mesh.position.y + f.deckY;

  if (f.body.kind === 'model') {
    const g = f.body.group;
    g.position.set(x, y + f.body.footOffset, 0);
    // Turned to face the way he is going. The model is modelled facing +Z and
    // oriented side-on by the asset entry, so this is the same 180° flip a
    // boat sailing the other way gets.
    g.rotation.y = f.face >= 0 ? 0 : Math.PI;
    g.rotation.z = boat.mesh.rotation.z; // ride the hull's roll
  }

  // The verlet points shadow the animation, so the handover has somewhere to
  // start even before goLimp reads the bones.
  const pose = standingPose(x, y, f.height, f.face, f.body.kind === 'model' ? f.body.model : null);
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

    if (f.state !== 'ragdoll') {
      const boat = f.boat;
      // The hull is clearly going down. Panic is measured on the boat's
      // health, so a boat chipped at slowly empties gradually and one deleted
      // in a single hit never gets the chance — its crew is thrown by the
      // explosion instead (see blastCrew).
      const hurt = boat && boat.hp / Math.max(boat.maxHp, 1e-3) <= (c.panicAt ?? 0.35);
      if (hurt && f.state === 'idle') f.state = 'panic';
      if (f.state === 'panic') {
        f.panicFor += dt;
        // Long enough on a boat that is plainly going down, and he takes his
        // chances in the water instead.
        const after = c.bailAfter ?? 4;
        if (after > 0 && f.panicFor > after + Math.random() * (c.bailSpread ?? 0.9)) {
          bail(f, boat.dir >= 0 ? -1 : 1);
          emit('splash', f.rig.points.hips.x, bounds.surfaceY, { scale: 0.25, dirX: 0, dirY: 1 });
        }
      }
      if (f.state !== 'ragdoll') {
        ride(f, dt);
        f.body.mixer?.update(dt);
        if (f.body.kind === 'boxes') poseBoxBody(f);
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
