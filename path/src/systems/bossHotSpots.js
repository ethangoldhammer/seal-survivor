import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { hitShapeSpheres, worldToShapeLocal, shapeLocalToWorld } from './hitShape.js';
import { emit } from '../entities/particles.js';

// ---------------------------------------------------------------------------
// WEAK SPOTS ON A BOSS
//
// One to three of them, lit bright green, sitting ON THE OUTER EDGE of the
// animal's silhouette. Shooting one crits. Feed it enough damage and it
// RUPTURES — a burst of hot jagged ichor, the light goes out, and a few
// seconds later a new one opens somewhere else on the perimeter.
//
// WHY THE PERIMETER AND NOT ANYWHERE ON THE BODY. A mark in the middle of a
// megalodon is a mark you cannot see the shape of: the animal is dark, the
// glow is additive, and a bright patch surrounded on all sides by flesh reads
// as a texture on the model rather than as a place. On the edge it breaks the
// silhouette — half the glow is over open water — which is the only way a
// small light stays findable while a boss is turning, and it is also the only
// way the player can see one that is on the far side of the body coming
// round. The silhouette is the read; everything else here serves it.
//
// WHAT A SPOT IS ANCHORED TO. The same thing the impact smears are anchored to
// (systems/bossImpact.js): a point in the BONE SPACE of one of the hit shape's
// spheres. Not a world position, which is off the animal one frame later, and
// not a bone name, which lies. The hit shape is already a set of spheres
// riding the skeleton, so a spot placed on one rides the flesh through every
// tail-beat and every turn for free, and — this is the part that matters — the
// crit test and the drawn glow read the SAME anchor and the SAME radius, so
// the light and the reach cannot drift apart the way a paired reach in two
// files always eventually does.
//
// WHAT IS GAMEPLAY AND WHAT IS LOOK. The split is the usual one and it is
// enforced by where the number lives:
//
//   behaviour.csv owns  how many, how big, the crit multiplier, how much
//                       damage ruptures one, how long until it relights.
//                       Judged over a fight and against the rest of the
//                       economy, so it belongs in a spreadsheet next to the
//                       other creature throughput.
//   CONFIG.hotSpots     owns the colours, the glow, the pulse, the jag on the
//                       edge, the goo. Judged by eye in the second it happens.
//
// THE POOL. Every spot in the game is one instance in one additive quad, the
// same arrangement as the impacts: a boss is one creature and three spots, but
// the corpse of the last one can still be wearing its ruptured ones while the
// next arrives, so the pool is sized for a handful of bodies rather than for
// one.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THE GLOW
// ---------------------------------------------------------------------------

const spotVert = /* glsl */ `
  attribute vec4 aSpot;   // xyz world position, w world radius
  attribute vec4 aMood;   // x alive 0..1, y flash 0..1, z heat 0..1, w seed

  uniform float uTime;
  uniform float uPulse;
  uniform float uPulseDepth;
  uniform float uFlashSwell;

  varying vec2 vUv;
  varying vec4 vMood;

  void main() {
    vUv = uv;
    vMood = aMood;

    if (aSpot.w <= 0.0 || aMood.x <= 0.0) {
      // Retired slots collapse to a degenerate point rather than being culled
      // on the CPU — the pool is a ring of slots and a dead one has to cost
      // nothing and, above all, must not draw the last spot that used it.
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    // BREATHING, and it speeds up with heat. A spot that has taken damage is
    // about to burst, and the pulse rate is the only warning that costs no
    // extra pixels — the player reads "this one is nearly done" off the
    // rhythm rather than off a bar. Phase is per-instance so three spots on
    // one animal are never in step, which is what would make them read as a
    // UI element bolted to the model.
    float rate = uPulse * mix(1.0, 3.2, aMood.z);
    float breathe = 1.0 + uPulseDepth * sin(uTime * rate + aMood.w * 43.0);

    // The quad grows on a hit. Small — this is the flash punching outward, and
    // anything large enough to read as a size change reads as the spot moving.
    float swell = 1.0 + uFlashSwell * aMood.y;

    // Sized off the world radius the crit test uses, with a margin for the
    // glow to fall off in. THE MARGIN IS IN THE QUAD, NOT IN THE RADIUS: the
    // fragment shader puts the spot's edge at uEdge of the quad's half-width
    // so the drawn boundary lands exactly on aSpot.w, and the soft light
    // outside it is spill. Growing the radius instead would make the light
    // honest and the reach a lie.
    float s = aSpot.w * 2.2 * breathe * swell * min(1.0, aMood.x * 1.6);

    // Camera-facing by construction: the arena is a plane and every effect in
    // this game is a quad in it, so there is no billboard to build.
    vec3 centre = aSpot.xyz;
    gl_Position = projectionMatrix * modelViewMatrix
      * vec4(centre + vec3(position.xy * s, 0.0), 1.0);
  }
`;

const spotFrag = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform float uGlow;
  uniform float uEdge;
  uniform float uJag;
  uniform float uJagRate;
  uniform float uCore;
  uniform float uWhite;
  uniform vec3 uLit;
  uniform vec3 uHot;
  uniform vec3 uFlash;

  varying vec2 vUv;
  varying vec4 vMood;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  void main() {
    if (vMood.x <= 0.0) discard;

    vec2 p = (vUv - 0.5) * 2.0;
    float d = length(p);
    float ang = atan(p.y, p.x);

    // THE EDGE IS CHEWED, not round. Sampled in cos/sin rather than on the
    // angle, so it wraps with no seam — a noise field sampled on the angle has
    // a discontinuity at pi that puts a notch in the same place on every spot.
    //
    // THE DOMAIN RADII ARE THE WHOLE TRICK, and the first version had them ten
    // times too small. A unit circle scaled by 2.6 crosses about four cells of
    // a lattice whose cells are one unit across, so the "noise" had four-fold
    // symmetry and every spot in the game rendered as the same green diamond.
    // Nine, nineteen and forty-one are far enough apart (and far enough from
    // multiples of each other) that the three octaves never line their cell
    // boundaries up, which is what turns a wobble into something gnawed.
    vec2 dir = vec2(cos(ang), sin(ang));
    float t = uTime * uJagRate;
    float n = (vnoise(dir * 9.0 + vec2(t, vMood.w * 51.0)) - 0.5)
            + (vnoise(dir * 19.0 + vec2(-t * 1.7, vMood.w * 17.0)) - 0.5) * 0.55
            + (vnoise(dir * 41.0 + vec2(t * 0.6, vMood.w * 83.0)) - 0.5) * 0.22;

    // Where the spot's own boundary sits in the quad. Everything outside is
    // spill; everything inside is the sore.
    float r0 = d / max(0.05, uEdge);

    // THE CHEWING IS CONFINED TO THE RIM, and that is the difference between a
    // sore and a sparkle. Displacing the radius by the same amount everywhere
    // stretches the noise across the whole falloff, so the bright middle picks
    // up the high-frequency octaves and the spot renders as a starburst with
    // rays — which looks like a pickup, not like a wound. Ramped in from a
    // quarter of the way out, the core stays a clean glow and only the
    // boundary is gnawed.
    float bite = smoothstep(0.25, 0.95, r0);
    float jag = 1.0 + n * uJag * bite * mix(1.0, 1.8, vMood.z);
    float r = r0 / max(0.2, jag);
    if (r > 1.35) discard;

    // NO PLATEAU. A falloff with a flat middle plus an additive glow above 1
    // clips the whole interior to one saturated value — the spot renders as a
    // flat green counter stuck on the animal, with the hot core, the heat
    // shift and the hit flash all invisible inside it because every one of
    // them was already over the ceiling. This curve falls from the first
    // pixel, so the light has somewhere to go.
    float body = pow(max(0.0, 1.0 - r), 1.7);
    float core = pow(max(0.0, 1.0 - r), uCore);

    // GREEN → AMBER as it takes damage, and all the way to white-red on the
    // frame it is struck. Three colours and three mixes, in that order,
    // because each one has to win over the last: a nearly-ruptured spot is
    // already warm and a hit on it still has to read as a hit, and the middle
    // of any of them is hot enough to be white.
    vec3 col = mix(uLit, uHot, vMood.z);
    col = mix(col, uFlash, vMood.y);
    col = mix(col, vec3(1.0), core * uWhite);

    float lift = 1.0 + vMood.y * 2.4;
    float a = clamp(body, 0.0, 1.0) * vMood.x;

    gl_FragColor = vec4(col * uGlow * lift * a, a);
  }
`;

// ---------------------------------------------------------------------------

let group = null;
let mesh = null;
let clock = 0;

// Every live spot, CPU side, parallel to the instance attributes by index.
// Boss-agnostic: a spot knows the shape it rides and nothing else, which is
// what lets a corpse keep wearing its own while the next boss lights up.
const slots = [];
let cursor = 0;

// The bodies that own spots. One entry per boss, so the roll (how many, and
// where they go once one ruptures) has somewhere to live that outlives an
// individual spot.
const owners = new Map();

const _p = { x: 0, y: 0, z: 0 };
const _col = new THREE.Color();

function cfg() {
  return CONFIG.hotSpots ?? {};
}

function look() {
  return cfg().look ?? {};
}

function makeMesh(count) {
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(2, 2);
  geo.index = quad.index;
  geo.attributes.position = quad.attributes.position;
  geo.attributes.uv = quad.attributes.uv;
  geo.instanceCount = count;

  geo.setAttribute('aSpot', new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4));
  geo.setAttribute('aMood', new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4));

  const l = look();
  const mat = new THREE.ShaderMaterial({
    vertexShader: spotVert,
    fragmentShader: spotFrag,
    transparent: true,
    depthWrite: false,
    // NOT depth-tested, and this is the opposite call from the impact smears
    // in bossImpact.js — deliberately. A smear is ON the skin and has to be
    // hidden by the parts of the body in front of it. A hot spot is the thing
    // the player is aiming at: it may never be clipped in half by the animal
    // it is attached to, and since it sits on the silhouette the half that
    // would be clipped is the half over open water.
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uGlow: { value: l.glow ?? 2.6 },
      uEdge: { value: l.edge ?? 0.46 },
      uJag: { value: l.jag ?? 0.34 },
      uJagRate: { value: l.jagRate ?? 1.4 },
      uCore: { value: l.core ?? 3.2 },
      uWhite: { value: l.white ?? 0.85 },
      uPulse: { value: l.pulse ?? 3.4 },
      uPulseDepth: { value: l.pulseDepth ?? 0.11 },
      uFlashSwell: { value: l.flashSwell ?? 0.35 },
      uLit: { value: new THREE.Color(l.litColor ?? 0x4dff7a) },
      uHot: { value: new THREE.Color(l.hotColor ?? 0xffc23a) },
      uFlash: { value: new THREE.Color(l.flashColor ?? 0xff3a24) },
    },
  });

  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  // Above the impact smears (8) and under the break's ring and shards (10, 11).
  // A hot spot is part of the animal; a hit landing on it is an event on top.
  m.renderOrder = 9;
  return m;
}

export function initBossHotSpots(scene) {
  if (group) disposeBossHotSpots(scene);
  group = new THREE.Group();
  group.frustumCulled = false;
  mesh = makeMesh(Math.max(4, cfg().pool ?? 12));
  group.add(mesh);
  slots.length = 0;
  for (let i = 0; i < mesh.geometry.instanceCount; i++) slots.push(null);
  cursor = 0;
  owners.clear();
  scene.add(group);
}

export function disposeBossHotSpots(scene) {
  if (!group) return;
  scene.remove(group);
  mesh.geometry.dispose();
  mesh.material.dispose();
  group = null;
  mesh = null;
  slots.length = 0;
  owners.clear();
}

export function resetBossHotSpots() {
  if (!group) return;
  const mood = mesh.geometry.attributes.aMood;
  mood.array.fill(0);
  mood.needsUpdate = true;
  for (let i = 0; i < slots.length; i++) slots[i] = null;
  owners.clear();
  cursor = 0;
}

// ---------------------------------------------------------------------------
// WHERE A SPOT GOES
//
// The silhouette is the union of the hit shape's spheres projected into the
// arena plane — z is a drawing lane in this game, not a dimension, so that
// projection is the whole shape. A point is ON THE PERIMETER when it is on
// one sphere's rim and inside no other sphere. That is the entire test, and it
// is why this cannot be done from a bone name: which parts of a shark are on
// its outline depends on how it is bent right now.
// ---------------------------------------------------------------------------

/**
 * Sample candidate points on the outer boundary of a posed body.
 *
 * @param shape   a live hit shape (systems/hitShape.js)
 * @param rays    angular samples per sphere
 * @returns       [{ index, wx, wy, wz, nx, ny, hostR }] in no particular order
 */
export function perimeterCandidates(shape, rays = 24) {
  const spheres = hitShapeSpheres(shape);
  const out = [];
  if (!spheres.length) return out;

  // The same inflation the contacts land on. A spot placed on the raw flesh
  // while every hit reports a point on the padded surface would sit a few
  // percent inside the boundary the player is actually shooting at — small,
  // constant, and exactly the kind of offset nobody finds by looking.
  const pad = CONFIG.hitShape?.padding ?? 1;

  for (let i = 0; i < spheres.length; i++) {
    const s = spheres[i];
    const sr = s.wr * pad;
    if (!(sr > 0)) continue;

    for (let k = 0; k < rays; k++) {
      // Offset per sphere so neighbouring spheres do not sample the same
      // angles — an aligned grid puts candidates in radial lines and the
      // spacing rule below then rejects most of them for being in the same
      // spoke.
      const ang = (k + (i * 0.37)) / rays * Math.PI * 2;
      const nx = Math.cos(ang);
      const ny = Math.sin(ang);
      const wx = s.wx + nx * sr;
      const wy = s.wy + ny * sr;

      let buried = false;
      for (let j = 0; j < spheres.length; j++) {
        if (j === i) continue;
        const o = spheres[j];
        const or = o.wr * pad;
        const dx = wx - o.wx;
        const dy = wy - o.wy;
        // A hair inside, so a point sitting exactly on the seam where two
        // spheres touch is not rejected by both of them and kept by neither.
        if (dx * dx + dy * dy < or * or * 0.9801) { buried = true; break; }
      }
      if (buried) continue;

      out.push({ index: i, wx, wy, wz: s.wz, nx, ny, hostR: sr });
    }
  }
  return out;
}

// Pick one candidate, biased toward the big parts of the animal and away from
// the spots already placed.
//
// THE BIAS IS NOT DECORATION. Without it the pick is uniform over candidates,
// and a small sphere on a fin tip contributes as many candidates as the torso
// while being a tenth of the flesh — so most spots would land on extremities,
// which are the parts that move fastest, are thinnest, and are hardest to
// hit. Weighting by the host sphere's radius puts them on the animal.
function pickCandidate(cands, taken, minGap) {
  let total = 0;
  const weights = new Array(cands.length);
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    let w = c.hostR;
    for (const t of taken) {
      const dx = c.wx - t.wx;
      const dy = c.wy - t.wy;
      // Not a hard reject: on a small body there may be no candidate far
      // enough from the first spot, and a hard rule there means the second
      // spot silently never appears. Crushed instead, so distance wins
      // wherever distance is available.
      if (dx * dx + dy * dy < minGap * minGap) w *= 0.02;
    }
    weights[i] = w;
    total += w;
  }
  if (total <= 0) return null;

  let roll = Math.random() * total;
  for (let i = 0; i < cands.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return cands[i];
  }
  return cands[cands.length - 1];
}

// ---------------------------------------------------------------------------
// LIGHTING ONE
// ---------------------------------------------------------------------------

// AGAINST THE WHOLE ANIMAL, then capped by the piece of it the spot is sitting
// on. Both halves are load-bearing and the first version had only the second.
//
// Sizing off the host sphere alone reads as the obviously right answer and is
// wrong on every body in the game: a megalodon's twelve fitted spheres are
// about 1.9 units at their biggest against a boss whose overall reach is 5, so
// half of one is a light under a metre across on an animal thirteen metres
// long. Every spot clamped to `minRadius` and the fraction did nothing at all —
// which the harness caught and no amount of looking at the code would have.
//
// The cap is what stops the other failure: a spot that landed on a fin tip
// would otherwise be drawn several times the size of the fin, and a crit reach
// bigger than the flesh it is attached to is reach over open water.
function spotRadius(bodyR, hostR) {
  const c = cfg();
  const r = (bodyR ?? 1) * (c.radiusFrac ?? 0.34);
  const capped = Math.min(r, hostR * (c.hostCap ?? 1.1));
  return Math.max(c.minRadius ?? 0.6, Math.min(c.maxRadius ?? 3.2, capped));
}

function lightSpot(owner, cands) {
  const c = cfg();
  const e = owner.e;
  const taken = owner.spots.filter((s) => s && s.alive && !s.dead);
  // In multiples of the animal's own size, so "not on top of each other" means
  // the same thing on a megalodon and on a crab.
  const pick = pickCandidate(cands, taken, (c.minGapFrac ?? 0.7) * (e.radius ?? 1));
  if (!pick) return null;

  if (!worldToShapeLocal(owner.shape, pick.index, pick.wx, pick.wy, pick.wz, _p)) return null;

  const i = cursor++ % slots.length;
  const spot = {
    shape: owner.shape,
    owner,
    index: pick.index,
    lx: _p.x, ly: _p.y, lz: _p.z,
    // Where it is RIGHT NOW as well as where it is anchored. The world pair is
    // rewritten every frame from the anchor, but it has to exist before the
    // first update or the spacing rule above compares against undefined — and
    // NaN fails every distance test silently, so three spots would open on top
    // of each other on the frame a boss arrives and never again.
    wx: pick.wx, wy: pick.wy, wz: pick.wz,
    wnx: pick.nx, wny: pick.ny,
    r: spotRadius(e.radius, pick.hostR),
    // Which way the body faces here, kept in the SPHERE's frame as well, so
    // the goo comes out along the skin's normal even after the animal has
    // turned ninety degrees since the spot was placed.
    nx: pick.nx, ny: pick.ny,
    // How much damage it has swallowed, against the pool that ruptures it.
    taken: 0,
    pool: Math.max(1, (e.maxHp ?? 1) * (c.ruptureFraction ?? 0.06)),
    alive: 1,
    fade: 0,       // eases 0 → 1 as it opens
    flash: 0,
    // Rolled, not derived from the slot index. A slot is reused, so a
    // slot-derived seed gives the replacement spot the same pulse phase and
    // the same chewed edge as the one that just burst in that position.
    seed: Math.random(),
    slot: i,
  };

  const old = slots[i];
  if (old) old.dead = true;
  slots[i] = spot;
  owner.spots.push(spot);
  return spot;
}

/**
 * Give a boss its weak spots. Called from systems/boss.js the same way the
 * perk, the boat and the kraken's ink are attached.
 *
 * NOTHING IS PLACED HERE, and that is the whole reason this is two steps. The
 * spheres a spot rides are meaningless until the body has been posed and its
 * world matrices are current, and at attach time the creature is still being
 * built — the identical trap that put a shark's hit spheres a hundred units
 * off the animal when the prune ran too early. So this records the intent and
 * the first update that finds a refreshed shape does the placing.
 */
export function attachHotSpots(scene, e) {
  if (!group || !e || !e.isBoss) return null;
  const c = cfg();
  if (c.enabled === false) return null;
  if (!e.hitShape) return null; // no measured body, no silhouette to sit on

  const lo = Math.max(0, Math.round(c.countMin ?? 1));
  const hi = Math.max(lo, Math.round(c.countMax ?? 3));
  const want = lo + Math.floor(Math.random() * (hi - lo + 1));
  if (want <= 0) return null;

  const owner = { e, shape: e.hitShape, want, spots: [], relightIn: 0, placed: false };
  owners.set(e, owner);
  return owner;
}

/** The body is gone (or its shape went back to the pool). Put its lights out. */
export function releaseHotSpots(e) {
  const owner = owners.get(e);
  if (!owner) return;
  for (const s of owner.spots) s.dead = true;
  owners.delete(e);
}

// ---------------------------------------------------------------------------
// BEING HIT
// ---------------------------------------------------------------------------

/**
 * Did this hit land on a weak spot, and what is the damage worth?
 *
 * Called by the damage sources that AIM — bullets, the club's swing, the
 * strike. Deliberately not by the auras and rings: a weak spot is a reward for
 * putting a shot somewhere, and a field that covers the whole animal cannot
 * put a shot anywhere. An aura that critted would multiply its own tick rate
 * against a target that is standing in it by definition, which is a different
 * (and much larger) change than this one.
 *
 * @param {object} e    the creature that was hit
 * @param {object} at   the contact from systems/hitShape.js — { x, y, index }
 * @param {number} dmg  damage about to be applied
 * @returns {number}    the damage to apply instead. `dmg` unchanged when the
 *                      hit missed every spot, which is every hit on every
 *                      creature in the game that is not a boss.
 */
export function hotSpotDamage(e, at, dmg) {
  if (!group || !at || !(dmg > 0)) return dmg;
  const owner = owners.get(e);
  if (!owner || !owner.placed) return dmg;

  const spot = spotAt(owner, at.x, at.y);
  if (!spot) return dmg;

  const c = cfg();
  const mul = Math.max(1, c.critMul ?? 2.2);
  const out = dmg * mul;

  // THE POOL TAKES THE CRIT DAMAGE, not the raw damage. Two reasons and they
  // point the same way: a spot should burst on the strength of what actually
  // went into it, and pooling the raw number would make the rupture threshold
  // silently mean `ruptureFraction / critMul` of the bar — a second number
  // hidden inside the first, which is exactly the kind of coupling that makes
  // a CSV row stop meaning what it says.
  spot.taken += out;
  spot.flash = 1;

  // A little of it comes out on every hit. Small and thrown along the skin's
  // normal, so a spot you are chewing on visibly leaks before it goes.
  bleed(spot, c, 1);

  if (spot.taken >= spot.pool) rupture(spot, c);
  return out;
}

/** The live spot a point is inside, or null. Exported for the harness. */
export function spotAt(owner, x, y) {
  if (!owner) return null;
  for (const s of owner.spots) {
    if (!s.alive || s.dead) continue;
    const dx = x - s.wx;
    const dy = y - s.wy;
    // THE DRAWN RADIUS, exactly. The glow's boundary and the crit's reach are
    // one number read from one place — the moment they become two numbers in
    // two files, one of them gets retuned and the other does not, and the
    // symptom is a weak spot that stops paying out with nothing in the diff
    // that looks like it could have caused it.
    if (dx * dx + dy * dy <= s.r * s.r) return s;
  }
  return null;
}

/** The owner record for a creature, for the harness and for boss.js. */
export function hotSpotsOf(e) {
  return owners.get(e) ?? null;
}

// A little of it comes out on every crit.
//
// BORN AT THE RIM, NOT AT THE CENTRE, and the offset is the whole difference
// between a spurt and a lid. Fired from the middle of the spot the lobes fuse
// into one disc sitting exactly on top of the light — it covers the white core
// and the hit flash underneath it, so the frame that is supposed to read as a
// hit reads as an orange lozenge appearing. Started a radius out along the
// skin's normal, the same mass is leaving the wound instead of capping it.
function bleed(spot, c, scale) {
  if (c.goo === false) return;
  const out = spot.r * (c.bleedOffset ?? 0.8);
  emit('hotSpotBleed', spot.wx + spot.wnx * out, spot.wy + spot.wny * out, {
    dirX: spot.wnx,
    dirY: spot.wny,
    scale,
  });
}

function rupture(spot, c) {
  spot.alive = 0;
  spot.ruptured = true;

  if (c.goo !== false) {
    // THE BIG ONE. Scaled by multiplying `size` and `speed` together and by
    // the same factor, which is the only lever that makes a fusing mass bigger
    // without changing what it is: blobs twice as big thrown twice as far are
    // the same shape at twice the size. Bigger blobs alone weld into one flat
    // slab; faster ones alone tear into separate dots.
    // Against a stated reference size rather than against the size floor with
    // a fudge factor on top: `ruptureScale` has to mean "1 is the burst as
    // authored", or the CSV row is a number whose neutral value nobody can
    // work out.
    const ref = Math.max(0.2, c.ruptureRefRadius ?? 1.6);
    const g = Math.max(0.3, (c.ruptureScale ?? 1) * (spot.r / ref));
    emit('hotSpotRupture', spot.wx, spot.wy, {
      dirX: spot.wnx,
      dirY: spot.wny,
      sizeMul: g,
      speedMul: g,
    });
  }

  // The replacement is scheduled on the OWNER rather than on the spot, because
  // the spot is about to stop existing and the promise has to outlive it.
  const owner = spot.owner;
  if (owner) owner.relightIn = Math.max(0, c.relightSeconds ?? 4);
}

// ---------------------------------------------------------------------------
// THE FRAME
// ---------------------------------------------------------------------------

/**
 * @param dt      the run's scaled seconds — the pulse and the relight are part
 *                of the fight and should slow down when the fight does.
 * @param realDt  unscaled, for the hit flash. A flash that freezes during its
 *                own hit-stop is the one thing guaranteed to be on screen
 *                while everything else is held, and holding it reads as a
 *                stall — the same call bossImpact.js makes.
 */
export function updateBossHotSpots(dt, realDt = dt) {
  if (!group) return;
  clock += realDt;

  const c = cfg();
  const l = look();
  const u = mesh.material.uniforms;
  u.uTime.value = clock;
  // Re-read per frame rather than at init, so dragging a slider moves what is
  // already on screen instead of only the next boss.
  u.uGlow.value = l.glow ?? 2.6;
  u.uEdge.value = l.edge ?? 0.46;
  u.uJag.value = l.jag ?? 0.34;
  u.uJagRate.value = l.jagRate ?? 1.4;
  u.uCore.value = l.core ?? 3.2;
  u.uWhite.value = l.white ?? 0.85;
  u.uPulse.value = l.pulse ?? 3.4;
  u.uPulseDepth.value = l.pulseDepth ?? 0.11;
  u.uFlashSwell.value = l.flashSwell ?? 0.35;
  _col.set(l.litColor ?? 0x4dff7a); u.uLit.value.copy(_col);
  _col.set(l.hotColor ?? 0xffc23a); u.uHot.value.copy(_col);
  _col.set(l.flashColor ?? 0xff3a24); u.uFlash.value.copy(_col);

  // --- the bodies -------------------------------------------------------
  for (const [e, owner] of owners) {
    // A boss whose shape went back to the pool takes its spots with it. Same
    // rule the impact smears follow, and for the same reason: a glow with
    // nothing to be a glow ON is a light floating in open water.
    if (!owner.shape?.alive) { releaseHotSpots(e); continue; }

    const live = owner.spots.filter((s) => s.alive && !s.dead);

    // First placement, and every replacement, happen through the same path —
    // one call, one set of candidates, however many are owed.
    let owed = owner.want - live.length;
    if (owed > 0) {
      if (!owner.placed) {
        // The opening set. No wait: the arrival is invulnerable anyway, so
        // there is nothing to be gained by holding them back and there is a
        // whole ceremony's worth of screen time to light up during.
        const cands = perimeterCandidates(owner.shape, c.rays ?? 24);
        if (cands.length) {
          while (owed-- > 0 && lightSpot(owner, cands)) { /* placed */ }
          owner.placed = true;
        }
      } else {
        owner.relightIn -= dt;
        if (owner.relightIn <= 0) {
          const cands = perimeterCandidates(owner.shape, c.rays ?? 24);
          if (cands.length && lightSpot(owner, cands)) {
            // One at a time. Two ruptures close together should relight on
            // their own clocks rather than both arriving on the frame the
            // second timer expires.
            owner.relightIn = Math.max(0, c.relightSeconds ?? 4);
          }
        }
      }
    }
  }

  // --- the lights -------------------------------------------------------
  const spotAttr = mesh.geometry.attributes.aSpot;
  const moodAttr = mesh.geometry.attributes.aMood;
  const openRate = 1 / Math.max(0.02, l.openSeconds ?? 0.45);
  const closeRate = 1 / Math.max(0.02, l.closeSeconds ?? 0.22);
  const flashRate = 1 / Math.max(0.02, l.flashSeconds ?? 0.16);

  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (!s) { moodAttr.array[i * 4] = 0; continue; }

    if (s.dead || !s.shape?.alive) {
      s.fade = Math.max(0, s.fade - closeRate * realDt);
      if (s.fade <= 0) { slots[i] = null; moodAttr.array[i * 4] = 0; continue; }
    } else if (s.alive) {
      s.fade = Math.min(1, s.fade + openRate * realDt);
    } else {
      // Ruptured: the light goes out fast, and it goes out WHITE-HOT rather
      // than dimming green, because the burst it just threw is the event and a
      // spot that faded politely would read as having been switched off.
      s.fade = Math.max(0, s.fade - closeRate * realDt);
      if (s.fade <= 0) {
        slots[i] = null;
        moodAttr.array[i * 4] = 0;
        const owner = s.owner;
        if (owner) {
          const at = owner.spots.indexOf(s);
          if (at >= 0) owner.spots.splice(at, 1);
        }
        continue;
      }
    }

    if (!shapeLocalToWorld(s.shape, s.index, s.lx, s.ly, s.lz, _p)) { s.dead = true; continue; }
    s.wx = _p.x;
    s.wy = _p.y;
    s.wz = _p.z + (l.lift ?? 0.34);

    // The normal, carried through the same transform as the point and then
    // differenced, which is how a direction survives a matrix that includes a
    // translation. Cheaper than inverting anything, and it is right for a
    // scaled body — the seal's own effects get this wrong by transforming a
    // direction as if it were a point, and the tell is goo that fires toward
    // the world origin when the animal is far from it.
    if (shapeLocalToWorld(s.shape, s.index, s.lx + s.nx, s.ly + s.ny, s.lz, _p)) {
      const dx = _p.x - s.wx;
      const dy = _p.y - s.wy;
      const len = Math.hypot(dx, dy) || 1;
      s.wnx = dx / len;
      s.wny = dy / len;
    } else {
      s.wnx = s.nx;
      s.wny = s.ny;
    }

    s.flash = Math.max(0, s.flash - flashRate * realDt);

    const heat = s.alive
      ? Math.min(1, s.taken / Math.max(1, s.pool))
      : 1;

    spotAttr.array[i * 4] = s.wx;
    spotAttr.array[i * 4 + 1] = s.wy;
    spotAttr.array[i * 4 + 2] = s.wz;
    spotAttr.array[i * 4 + 3] = s.r;
    moodAttr.array[i * 4] = s.fade;
    // The rupture reads as one long flash rather than as a fade, which is
    // what makes the burst and the light going out look like one event.
    moodAttr.array[i * 4 + 1] = s.alive ? s.flash : 1;
    moodAttr.array[i * 4 + 2] = heat;
    moodAttr.array[i * 4 + 3] = s.seed;
  }

  spotAttr.needsUpdate = true;
  moodAttr.needsUpdate = true;
}

/** For the harness — how many lights are currently riding a body. */
export function liveHotSpotCount() {
  let n = 0;
  for (const s of slots) if (s && s.alive && !s.dead) n += 1;
  return n;
}
