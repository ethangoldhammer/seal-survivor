import * as THREE from 'three';
import { nearestFloatingCrew, crewPosition } from '../systems/crew.js';
import { CONFIG, difficultyRamp } from '../config.js';
import { createVisual } from '../assets.js';
import { spawnProjectile } from './projectiles.js';
import { bounds, clampBelowSurface } from '../arena.js';
import { nearestFloorPickup, bestChumTarget, refreshChumPiles, pickupAlive, bitePickup } from './pickups.js';
import { deathState } from '../systems/deathDive.js';
import { skyLight } from '../systems/daylight.js';
import { createAnimationController, stateForSpeed } from '../systems/animation.js';
import { createHeadLook } from '../systems/headLook.js';
import { recordSpawn } from '../systems/playtest.js';
import { approachVector, assignFeedingSlots, crowdAvoid, pickStandoff } from '../systems/apexCrowd.js';
import { updateWaves, waveSpawn, resetWaves, lullEligible } from '../systems/waves.js';

// Above this, a creature's hp means "invincible scenery" rather than a real
// pool anyone is meant to chew through (the sea turtle ships 1e9). Only the
// playtest pressure metric cares; combat treats it as an ordinary number.
const UNKILLABLE_HP = 1e6;
import { createJawDriver } from '../systems/jaw.js';
import { createClawDriver } from '../systems/crabClaw.js';
import { player } from './player.js';

export const enemies = [];

let spawnTimer = 0;
let nextSchoolId = 1;

export function resetEnemies(scene) {
  for (const e of enemies) scene.remove(e.mesh);
  enemies.length = 0;
  spawnTimer = 0;
  nextSchoolId = 1;
  // The wave clock is spawner state like the timer above it, and resets with
  // it for the same reason: a new run has to open on its own first surge
  // rather than partway through the last one's.
  resetWaves();
}

// ---------------------------------------------------------------------------
// Behaviors — each writes a desired velocity into e.vx / e.vy. Shared code
// below integrates, clamps and orients, so a new behavior is just a function.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Crab-vs-crab collisions.
//
// `separates` (further down) is a soft, continuous shove that keeps big
// bodies from stacking — good for sharks drifting past each other, far too
// polite for a seabed crowded with crabs shouldering toward the same pile.
// This is a real collision instead: an impulse along the contact normal,
// scaled by mass and restitution, applied once per pair per frame.
//
// The visible knock-around is three things landing together:
//   1. velocity   — the impulse, so they actually bounce apart
//   2. tumble     — angular kick on the body, which springs back upright
//   3. skeleton   — anim.impulse() shoves the bone springs, and because the
//                   spring's target is whatever the walk cycle wrote, it
//                   settles back INTO the loop on its own. That is the whole
//                   "gently maintain the anim loop" behaviour; there is no
//                   separate recovery animation, the spring just stops
//                   fighting the clip once the energy is gone.
//
// Mass goes as radius squared (area, since this is a 2D playfield), so a
// grown late-run crab shrugs off a fresh one rather than both bouncing
// equally.
//
// This pass owns the CROWD as well as the collision. Two things ride along
// with the contact test, both explained at CONFIG.crabPhysics:
//
//   depth   Bodies too far apart in z simply don't touch. Crabs spawn across
//           a spread of depth lanes, so the ones in different lanes walk in
//           front of and behind each other instead of everything queueing up
//           on one line.
//   stacks  Part of each contact's positional correction is redirected
//           UPWARD for whichever body is already higher, and any pair
//           overlapping horizontally records a support height for the upper
//           one. Together with the gravity in updateEnemies that is the whole
//           climbing behaviour — a crowd shoving toward the same pile of chum
//           piles UP, and comes back down as soon as it stops shoving.
function resolveCrabCollisions(dt, list) {
  const c = CONFIG.crabPhysics;
  if (!c?.enabled) return;

  // Support is recomputed from scratch every frame — a crab whose neighbour
  // walked out from under it has to fall, and a stale height would leave it
  // standing on nothing.
  for (const e of list) if (e.def.collides) e.supportY = -Infinity;

  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.def.collides) continue;
    if (a.bumpCooldown > 0) a.bumpCooldown -= dt;

    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (!b.def.collides) continue;
      // Held creatures are inert — being frozen in a bubble shouldn't turn
      // a crab into a billiard ball.
      if (a.trapTimer > 0 || a.charmTimer > 0 || b.trapTimer > 0 || b.charmTimer > 0) continue;

      const dx = b.mesh.position.x - a.mesh.position.x;
      const dy = b.mesh.position.y - a.mesh.position.y;
      const dz = b.mesh.position.z - a.mesh.position.z;
      const sum = a.radius + b.radius;
      // Different depth lanes: they overlap on screen and pass through each
      // other, which is exactly the read we want — one crab in front of
      // another rather than two crabs refusing to share a spot.
      if (Math.abs(dz) > sum * (c.depthContact ?? 1)) continue;

      // Standing on it. Recorded for ANY horizontally-overlapping pair, not
      // just touching ones, so a crab that has climbed clear of the contact
      // radius is still held up by the one underneath. The `dy` gate is what
      // stops two crabs at the same height each claiming to be on top of the
      // other and both being launched: a body has to have genuinely got above
      // the other (the climb bias below is what carries it that far) before
      // the support is real.
      const stackRise = sum * (c.stackHeight ?? 0.6);
      if (Math.abs(dx) < sum * (c.supportSpan ?? 0.85) && Math.abs(dy) > stackRise * 0.5) {
        if (dy > 0) b.supportY = Math.max(b.supportY, a.mesh.position.y + stackRise);
        else a.supportY = Math.max(a.supportY, b.mesh.position.y + stackRise);
      }

      const want = sum * (c.contactScale ?? 1);
      const d2 = dx * dx + dy * dy;
      if (d2 > want * want || d2 < 1e-9) continue;

      const d = Math.sqrt(d2);
      const nx = dx / d;
      const ny = dy / d;

      // Positional correction first, so bodies never settle overlapped and
      // then jitter as the impulse fires every frame on the same pair.
      const overlap = want - d;
      const ma = a.radius * a.radius;
      const mb = b.radius * b.radius;
      const total = ma + mb;
      const pushA = (mb / total) * overlap * (c.positionCorrection ?? 0.5);
      const pushB = (ma / total) * overlap * (c.positionCorrection ?? 0.5);

      // Which one climbs: whichever is already higher, and on a dead heat the
      // lighter one — a stable tiebreak, so a pair at identical height doesn't
      // swap climber every frame and vibrate in place.
      const climberIsB = Math.abs(dy) > 1e-4 ? dy > 0 : b.radius < a.radius;
      const climb = c.climbBias ?? 0;
      // The climber's share of the correction is steered from "straight away
      // from the other body" toward "straight up". The other body still takes
      // the plain sideways shove, which is what it is being climbed off.
      if (climberIsB) {
        a.mesh.position.x -= nx * pushA;
        a.mesh.position.y -= ny * pushA;
        b.mesh.position.x += nx * (1 - climb) * pushB;
        b.mesh.position.y += (ny * (1 - climb) + climb) * pushB;
      } else {
        a.mesh.position.x -= nx * (1 - climb) * pushA;
        a.mesh.position.y += (-ny * (1 - climb) + climb) * pushA;
        b.mesh.position.x += nx * pushB;
        b.mesh.position.y += ny * pushB;
      }

      // Closing speed along the normal. Only resolve if they're actually
      // approaching — separating pairs would otherwise get yanked back.
      const rvx = b.vx - a.vx;
      const rvy = b.vy - a.vy;
      const along = rvx * nx + rvy * ny;
      if (along > 0) continue;

      const restitution = c.restitution ?? 0.45;
      const impulse = (-(1 + restitution) * along) / total;
      a.vx -= impulse * mb * nx;
      a.vy -= impulse * mb * ny;
      b.vx += impulse * ma * nx;
      b.vy += impulse * ma * ny;

      // Only dress the hit up when it's a real knock, not the constant
      // grazing of a dense crowd — otherwise a pile of crabs would tumble
      // and flail permanently.
      const force = Math.abs(along);
      if (force < (c.minImpactSpeed ?? 1.2)) continue;

      const strength = Math.min(c.maxTumble ?? 6, force * (c.tumblePerSpeed ?? 0.5));
      // Spin each away from the contact, so they roll apart rather than both
      // rolling the same way.
      const spin = (Math.random() * 0.5 + 0.75) * strength;
      a.tumbleVel -= spin * (mb / total);
      b.tumbleVel += spin * (ma / total);

      if (a.bumpCooldown <= 0 && b.bumpCooldown <= 0) {
        a.bumpCooldown = c.bumpCooldown ?? 0.15;
        b.bumpCooldown = c.bumpCooldown ?? 0.15;
        const boneKick = Math.min(c.maxBoneImpulse ?? 3, force * (c.boneImpulsePerSpeed ?? 0.4));
        _bump.set(-nx, -ny, 0);
        a.anim?.impulse?.(_bump, boneKick);
        _bump.set(nx, ny, 0);
        b.anim?.impulse?.(_bump, boneKick);
      }
    }
  }
}

const _bump = new THREE.Vector3();

// Surface and seabed only — no side walls. Used for creatures still walking
// in from off the edge of the arena.
function clampVertical(pos, radius) {
  const ceiling = bounds.surfaceY - radius;
  if (pos.y > ceiling) pos.y = ceiling;
  if (pos.y < bounds.bottom + radius) pos.y = bounds.bottom + radius;
}

// Blend toward a desired velocity instead of snapping to it.
function steerTo(e, dx, dy, dt, responsiveness = 6, speedMul = 1) {
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const tvx = (dx / len) * e.speed * speedMul;
  const tvy = (dy / len) * e.speed * speedMul;

  // e.turnRate is the per-instance value baked at spawn (the species' own
  // turnRate times whatever CONFIG.hunterRamp has added by then); e.def is the
  // fallback for creatures spawned before that field existed.
  const turnRate = e.turnRate ?? e.def.turnRate;
  if (turnRate) {
    // Turn-limited: arc toward the target rather than pivoting on the spot.
    const want = Math.atan2(tvy, tvx);
    let diff = want - e.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const step = Math.min(Math.abs(diff), turnRate * dt) * Math.sign(diff);
    e.heading += step;
    // speedMul applies here too. It did NOT before, and nothing noticed:
    // the only caller passing one was the crabs' seabed rush, and crabs have
    // no turnRate, so the multiplier was silently dropped on exactly the
    // creatures that do have one. The lunge (see updateEnemies) is a
    // turn-limited hunter asking to go faster, so it would have done nothing
    // at all on this branch.
    e.vx = Math.cos(e.heading) * e.speed * speedMul;
    e.vy = Math.sin(e.heading) * e.speed * speedMul;
    return;
  }

  const t = Math.min(1, responsiveness * dt);
  e.vx += (tvx - e.vx) * t;
  e.vy += (tvy - e.vy) * t;
}

// Everything that eats chum off the floor reads its numbers from one of two
// blocks — a crab's sit-down meal (`crawl.feed`) or a hunter's gulp on the
// pass (`hunt.scavenge`). They carry the same fields, so the chewing and the
// hoovering are one code path; only the values differ.
function feedConfig(e) {
  return e.def.crawl?.feed ?? e.def.hunt?.scavenge ?? null;
}

// Where this creature's mouth is, in world space. Both offsets are MULTIPLES
// OF ITS RADIUS, never world units: `radius` is derived from the scale the
// visual actually spawned at (see spawnOne), so it already carries the asset's
// size multiplier and whatever the run's growth has added. A hand-typed offset
// here would be wrong by that factor and would silently re-break the next time
// anyone touched the Look panel's size slider.
const _mouth = { x: 0, y: 0 };
// Reused every frame by every crab — see the pinch block in updateEnemies.
const _clawAim = new THREE.Vector3();
function mouthPoint(e, cfg, out) {
  let fx;
  let fy;
  if (e.def.faceCamera) {
    // A crab is pinned broadside and walks sideways, so "forward" is only ever
    // along screen X — and while it is parked and chewing (vx damped toward
    // nothing) the last direction it walked is the honest answer.
    //
    // `gaitDir` is sign(vx) * gaitTravel, i.e. a PLAYBACK direction, not a
    // heading — and this crab ships gaitTravel -1, so using it raw would put
    // the mouth on the wrong side of the body. Multiplying the travel sign
    // back out recovers the direction it was actually walking.
    fx = Math.sign(e.vx) || Math.sign((e.gaitDir ?? 0) * (e.def.gaitTravel ?? 1)) || 1;
    fy = 0;
  } else {
    const s = Math.hypot(e.vx, e.vy);
    if (s > 1e-3) { fx = e.vx / s; fy = e.vy / s; } else { fx = Math.cos(e.heading); fy = Math.sin(e.heading); }
  }
  out.x = e.mesh.position.x + fx * e.radius * (cfg.mouthForward ?? 0);
  out.y = e.mesh.position.y + fy * e.radius * (cfg.mouthForward ?? 0) + e.radius * (cfg.mouthRise ?? 0);
  return out;
}

// Where this creature is looking, in world space. Stored on a reused vector
// rather than a fresh one — every hunter writes this every frame, and there
// can be `groupMaxAlive.apex` of them plus whatever else takes a target.
// `null` means "nothing in mind", which the head-look reads as "release".
function setLookTarget(e, x, y) {
  if (!e.lookAt) e.lookAt = new THREE.Vector3();
  e.lookAt.set(x, y, 0);
  e.lookTarget = e.lookAt;
}

// ---------------------------------------------------------------------------
// SHARK CRUISE — see CONFIG.enemies.<key>.hunt.lateral, and `null` there (or a
// missing block) opts a creature out entirely, which is how the dolphin, orca
// and otter keep the free movement their behaviour is built on.
//
// A hunter used to steer straight at whatever it wanted, in whatever direction
// that happened to be. On a side-on camera that reads badly: `steerTo` drives
// the body at FULL speed along its heading, so a target overhead means a shark
// climbing vertically like a lift, and the wander branch picked a uniformly
// random angle — as likely to swim straight up as along the reef.
//
// Two things fix it, and neither is a new movement system:
//
//   VERTICAL AUTHORITY IS EARNED. `dy` is scaled by a gain that is near zero at
//   range and reaches 1 only as the creature closes. Because steerTo normalises
//   what it is given, flattening `dy` does not slow the shark down — it turns a
//   dive into a long horizontal approach that only tips upward near the end.
//   The gain is eased over time rather than switched, which is what keeps it
//   from snapping the moment the player crosses a radius.
//
//   THE HEAD LEADS. The weave is applied to the LOOK TARGET first and only
//   bleeds into the steering by `weaveBody`. systems/headLook.js aims the snout
//   at that point and the bone springs (systems/boneSpring.js) drag the body
//   after it, so the sinuous shape comes out of rigging that already exists
//   rather than being animated into the path.
//
// The weave runs in the creature's VERTICAL plane, which is the same call
// assets.js already makes for the procedural body wag (`axis: 'x'` on
// enemyShark): a real shark bends side to side, and side to side is straight
// into this camera and invisible.
// ---------------------------------------------------------------------------

// Hermite smoothstep between two distances, 1 when near and 0 when far.
function closeness(dist, far, near) {
  if (!(far > near)) return dist <= near ? 1 : 0;
  const t = Math.min(1, Math.max(0, (far - dist) / (far - near)));
  return t * t * (3 - 2 * t);
}

// Advances the per-creature cruise state. `gap` is the distance to whatever it
// is pursuing; pass null when it is pursuing nothing, which holds vertical
// authority at the floor.
//
// WHICH distance is per-branch, and the distinction matters more than it looks:
//
//   The PLAYER approach and the idle cruise pass the HORIZONTAL gap. Gating
//   those on the straight-line distance deadlocks — a shark directly below the
//   player is far away, so it is flattened, so it swims sideways, so it never
//   closes, because the only direction that would close the gap is the one it
//   is forbidden. Measured: a shark 36 units under the player circled at its
//   own depth indefinitely. The horizontal gap makes the rule "come up once you
//   are underneath", which is also the shape a real attack has — run in flat
//   and level, get beneath, then rise into it.
//
//   Going after a specific piece of FOOD passes the straight-line distance, so
//   the creature may commit to a dive as soon as it is near in any direction.
//   These are deliberate acts on a fixed point rather than the drifting the
//   flattening exists to stop, and gating them horizontally breaks them: chum
//   sits on the seabed, so a shark that had to be almost directly above it
//   before it could descend would overshoot on a turning circle wider than the
//   window it had, circle, and try again. Measured as a 1-in-12 failure of
//   tools/crab-crowd-test.mjs, where a shark abandoned 182 chases in 20s.
function updateSwim(e, dt, gap, cfg) {
  if (!cfg) return;
  const floor = cfg.climbFloor ?? 0.1;
  const want = gap == null
    ? floor
    : Math.max(floor, closeness(gap, cfg.climbRange ?? 14, cfg.climbFull ?? 6));
  // Exponential ease, written frame-rate independently — a plain lerp by
  // `rate * dt` changes how abrupt this looks with the frame rate, and "not
  // abrupt" is the entire requirement.
  const k = 1 - Math.exp(-(cfg.climbEase ?? 0.9) * dt);
  e.climbGain = (e.climbGain ?? floor) + (want - (e.climbGain ?? floor)) * k;

  const period = cfg.weavePeriod ?? 5.5;
  // Seeded per creature at spawn so a pack does not weave in lockstep.
  e.weavePhase = ((e.weavePhase ?? 0) + (dt / Math.max(0.05, period))) % 1;
}

// Flattens a desired direction against the current vertical authority.
function shapeSwim(e, dx, dy, cfg) {
  if (!cfg) return { x: dx, y: dy };
  const gain = e.climbGain ?? 1;
  let x = dx;
  let y = dy * gain;

  // Scaling `dy` alone is not enough, and the case it misses is the common one.
  // What "swims laterally" means is a bound on the SLOPE of the path, and a
  // slope is a ratio — so a target almost directly overhead (`dx` small but not
  // zero, which is most of the orbit around a player) still comes out near
  // vertical no matter how far `dy` is scaled down. Measured before this: a
  // shark approaching a player straight above it, well outside its climb range,
  // still travelled 140% as far vertically as horizontally.
  //
  // So the gain buys SLOPE rather than scale. Flat at range, free up close, and
  // any steeper request is answered by lengthening the horizontal run instead
  // of by refusing to climb — which is what turns a dive into a pass.
  const flat = cfg.flatSlope ?? 0.35;   // ~19 degrees off horizontal
  const free = cfg.climbSlope ?? 8;     // effectively unconstrained
  // GEOMETRIC between the two, not linear. A slope is a ratio, and interpolating
  // a ratio linearly spends almost all of the range immediately: from 0.35 to 8,
  // a gain of just 0.12 already buys 1.27 — a 52-degree climb, at the floor,
  // which is the setting that is supposed to mean "flat". Geometrically the same
  // 0.12 gives 0.50, and the curve stays gentle until the creature is genuinely
  // close.
  const slope = flat * Math.pow(free / flat, gain);
  const minX = Math.abs(y) / slope;
  if (Math.abs(x) < minX) {
    // Keep whatever horizontal intent it had; falling back to the way it is
    // already pointing when there is none, so it commits to a side rather than
    // stalling head-on.
    const dir = Math.abs(x) > 1e-6 ? Math.sign(x) : (Math.cos(e.heading ?? 0) >= 0 ? 1 : -1);
    x = dir * minX;
  }
  // The weave, at the fraction of it that reaches the body.
  //
  // PROPORTIONAL to the vector, not an absolute nudge. The flattening above
  // deliberately leaves a short vector (a shark at range hands steerTo
  // something of length ~0.04), so a fixed-size perpendicular offset does not
  // bend that path — it replaces it. Measured with an absolute 0.1: a shark
  // whose shaped direction was 26 degrees off horizontal came out of the weave
  // at 93 degrees, i.e. straight up, and the whole flattening was undone one
  // line after it was applied.
  //
  // Scaling by the vector's own length makes this a rotation of about
  // atan(body) whatever the magnitude, which is what "a fraction of the weave
  // reaches the body" was always supposed to mean.
  const body = cfg.weaveBody ?? 0;
  if (body > 0) {
    const s = Math.sin((e.weavePhase ?? 0) * Math.PI * 2);
    // Both components read the PRE-weave vector: updating x first and feeding
    // it into y would rotate by a different amount each frame and drift.
    const ox = x;
    const oy = y;
    x += -oy * s * body;
    y += ox * s * body;
  }
  return { x, y };
}

// Offsets a look point sideways so the snout leads the weave. Perpendicular to
// the heading, because that is the direction the body is actually travelling.
function weaveLook(e, x, y, cfg) {
  if (!cfg) return { x, y };
  const amp = cfg.weaveAmp ?? 0;
  if (amp <= 0) return { x, y };
  const s = Math.sin((e.weavePhase ?? 0) * Math.PI * 2);
  const h = e.heading ?? 0;
  return { x: x + -Math.sin(h) * amp * s, y: y + Math.cos(h) * amp * s };
}

// apexCrowd works on plain { x, y, radius } so it can be tested without a
// scene. Each creature OWNS its view (`e.crowdView`) rather than the adapter
// handing out one shared object: the view is what goes into the crowd list, so
// it has to be identity-equal to the thing the avoidance skips — with a single
// shared instance every hunter would find a body at distance zero (itself) and
// flee from it. Owned views also mean no per-frame allocation.
function crowdSelf(e) {
  let v = e.crowdView;
  if (!v) {
    v = e.crowdView = {
      x: 0, y: 0, radius: 1, feeding: false, orbitDir: 1, standoffDist: null, feedTimer: 0, e,
      // Only the tagged bodies queue for a feeding slot. Everything else that
      // hunts (the otter) still steers around them, but closes as it always did.
      inCrowd: e.def.spawnGroup === 'apex',
    };
  }
  v.x = e.mesh.position.x;
  v.y = e.mesh.position.y;
  v.radius = e.radius;
  v.feeding = e.feeding === true;
  v.orbitDir = e.orbitDir;
  v.standoffDist = e.standoffDist;
  v.feedTimer = e.feedTimer ?? 0;
  return v;
}

// The apex bodies on screen this frame, as crowd views. Rebuilt in place each
// frame; `assignFeedingSlots` sorts it, which is why it's ours and not shared.
const apexViews = [];

function refreshApexCrowd(dt, playerPos) {
  apexViews.length = 0;
  for (const e of enemies) {
    // The tag is the contract: `spawnGroup: 'apex'` is already what the
    // population cap uses to mean "big body competing for the same screen",
    // and it's the same set that should be competing for the same player.
    if (e.def.spawnGroup !== 'apex') continue;
    if (e.trapTimer > 0 || e.charmTimer > 0) continue; // held: not in the running
    apexViews.push(crowdSelf(e));
  }
  assignFeedingSlots(apexViews, playerPos, dt, CONFIG.apexCrowd);
  // Slots decided on the views; the creatures are what the behaviors read.
  for (const v of apexViews) {
    v.e.feeding = v.feeding;
    v.e.feedTimer = v.feedTimer;
  }
}

const BEHAVIORS = {
  chase(e, dt, ctx) {
    steerTo(e, ctx.dirX, ctx.dirY, dt, 10);
  },

  keepDistance(e, dt, ctx) {
    const want = e.def.keepDistance ?? 9;
    const dead = e.def.deadzone ?? 1;
    if (ctx.dist > want + dead) steerTo(e, ctx.dirX, ctx.dirY, dt, 10);
    else if (ctx.dist < want - dead) steerTo(e, -ctx.dirX, -ctx.dirY, dt, 10);
    else { e.vx *= 0.9; e.vy *= 0.9; }
  },

  orbit(e, dt, ctx) {
    const want = e.def.orbitDistance ?? 6;
    const radial = ctx.dist > want ? 1 : -1;
    const tx = -ctx.dirY * e.orbitDir;
    const ty = ctx.dirX * e.orbitDir;
    steerTo(e, ctx.dirX * radial + tx, ctx.dirY * radial + ty, dt, 8);
  },

  // Boids: cohesion, separation, alignment — plus a drift at the player and a
  // panic response to any predator that gets close.
  swarm(e, dt, ctx) {
    const sw = e.def.swarm ?? {};
    const mates = ctx.schools.get(e.schoolId);
    const px = e.mesh.position.x;
    const py = e.mesh.position.y;
    let ax = 0;
    let ay = 0;

    if (mates && mates.length > 1) {
      let cx = 0, cy = 0, avx = 0, avy = 0, n = 0;
      let sx = 0, sy = 0;
      for (const m of mates) {
        if (m === e) continue;
        cx += m.mesh.position.x; cy += m.mesh.position.y;
        avx += m.vx; avy += m.vy;
        n += 1;
        const dx = px - m.mesh.position.x;
        const dy = py - m.mesh.position.y;
        const d = Math.hypot(dx, dy);
        const near = sw.separationDist ?? 1.4;
        if (d > 1e-4 && d < near) {
          const push = 1 - d / near;
          sx += (dx / d) * push;
          sy += (dy / d) * push;
        }
      }
      if (n > 0) {
        cx /= n; cy /= n;
        const cd = Math.hypot(cx - px, cy - py);
        if (cd > 1e-4) {
          ax += ((cx - px) / cd) * (sw.cohesion ?? 0);
          ay += ((cy - py) / cd) * (sw.cohesion ?? 0);
        }
        const al = Math.hypot(avx, avy);
        if (al > 1e-4) {
          ax += (avx / al) * (sw.alignment ?? 0);
          ay += (avy / al) * (sw.alignment ?? 0);
        }
      }
      ax += sx * (sw.separation ?? 0);
      ay += sy * (sw.separation ?? 0);
    }

    ax += ctx.dirX * (sw.towardPlayer ?? 0);
    ay += ctx.dirY * (sw.towardPlayer ?? 0);

    // Flee anything that eats fish.
    const fleeR = sw.fleeRadius ?? 0;
    if (fleeR > 0) {
      for (const p of ctx.predators) {
        const dx = px - p.mesh.position.x;
        const dy = py - p.mesh.position.y;
        const d = Math.hypot(dx, dy);
        if (d > 1e-4 && d < fleeR) {
          const panic = (1 - d / fleeR) * (sw.fleeFromPredators ?? 0);
          ax += (dx / d) * panic;
          ay += (dy / d) * panic;
        }
      }
    }

    const w = sw.wander ?? 0;
    if (w > 0) {
      ax += Math.cos(ctx.time * 1.7 + e.phase) * w;
      ay += Math.sin(ctx.time * 2.3 + e.phase) * w;
    }

    steerTo(e, ax, ay, dt, sw.responsiveness ?? 4);
  },

  // Stays near the seabed rather than swimming freely — chases the player
  // when close, scavenges the pickup pile when not, otherwise ambles along
  // the bottom. Never rises more than `groundHeight` above the floor
  // regardless of what it's steering toward.
  crawl(e, dt, ctx) {
    const g = e.def.crawl ?? {};

    // THE PILE-ON. The seal is dead and sinking; everything else about a crab
    // stops mattering. They drop the chum, ignore the wander, come from
    // wherever they are and climb onto the body — the stacking in
    // resolveCrabCollisions is what turns "everyone arrives" into a heap
    // rather than a ring. See CONFIG.enemies.walkingCrab.crawl.corpse.
    //
    // They stop STEERING at `settleRange` and coast: past that point the
    // contacts own the arrangement, and crabs still driving at a single point
    // underneath each other would fight the collision response forever.
    if (g.corpse && deathState.active) {
      e.chumTarget = null;
      e.eating = false;
      if (ctx.dist > e.radius * (g.corpse.settleRange ?? 1.6)) {
        steerTo(e, ctx.dirX, ctx.dirY, dt, 8, g.corpse.speedMul ?? 2);
      } else {
        e.vx *= 0.85;
        e.vy *= 0.85;
      }
      return;
    }

    // The player getting close to the seabed is a distinct trigger from
    // ordinary proximity — crabs "rush" with a wider aggro radius and a
    // burst of speed, rather than just noticing you a little sooner.
    const rushing = ctx.playerPos.y < bounds.bottom + (g.floorRushHeight ?? 6);
    const aggro = rushing ? (g.rushAggroRadius ?? 999) : (g.aggroRadius ?? 14);
    const speedMul = rushing ? (g.rushSpeedMul ?? 1.8) : 1;

    if (ctx.dist < aggro) {
      // You outrank the food. The orb keeps whatever damage it has taken —
      // an interrupted pile stays visibly chewed rather than healing back.
      e.chumTarget = null;
      e.eating = false;
      steerTo(e, ctx.dirX, ctx.dirY * (rushing ? 0.7 : 0.3), dt, rushing ? 10 : 6, speedMul);
      return;
    }

    // --- scavenging -------------------------------------------------------
    const f = g.feed;
    if (f) {
      // Re-pick on a timer rather than every frame: with a full pile this is
      // crabs x orbs distance checks, and a crab changing its mind 60 times a
      // second jitters in place instead of committing to a walk.
      e.chumTimer = (e.chumTimer ?? 0) - dt;
      if (e.chumTarget && !pickupAlive(e.chumTarget)) {
        e.chumTarget = null; // eaten by another crab, or the player got it
        e.eating = false;
      }
      if (!e.chumTarget && e.chumTimer <= 0) {
        e.chumTimer = f.reacquire ?? 0.4;
        // Biggest pile wins, discounted by travel — not simply the nearest
        // orb. Pile sizes were computed once for the whole frame in
        // updateEnemies, so this is a single pass however many crabs ask.
        e.chumTarget = bestChumTarget(
          e.mesh.position.x, e.mesh.position.y,
          f.seekRadius ?? 20,
          f.distanceBias ?? 18
        );
      }

      if (e.chumTarget) {
        const tx = e.chumTarget.mesh.position.x - e.mesh.position.x;
        const ty = e.chumTarget.mesh.position.y - e.mesh.position.y;
        const d = Math.hypot(tx, ty);
        if (d <= (f.eatRange ?? 1)) {
          // Parked on it and chewing. Held still so the crab reads as busy —
          // and so a feeding cluster doesn't drift off the pile it's eating.
          e.vx *= 0.8;
          e.vy *= 0.8;
          e.eating = true;
          return;
        }
        e.eating = false;
        steerTo(e, tx, ty * 0.5, dt, 5);
        return;
      }
    }

    e.eating = false;

    // Still off the side of the arena with nothing to head for: walk IN.
    // Wandering out here means wandering back out to sea and never returning,
    // since `entering` suppresses the wall that would otherwise turn it back.
    if (e.entering) {
      steerTo(e, e.mesh.position.x < 0 ? 1 : -1, 0, dt, 5);
      return;
    }

    e.wanderTimer -= dt;
    if (e.wanderTimer <= 0) {
      e.wanderTimer = g.wanderChange ?? 2.5;
      e.wanderAngle = Math.random() * Math.PI * 2;
    }
    steerTo(e, Math.cos(e.wanderAngle), Math.sin(e.wanderAngle) * 0.2, dt, 4);
  },

  // Anchored in place — never moves. Bites in a fixed radius on a cooldown
  // when the player is close. Its attack animation is driven directly in
  // updateEnemies (a one-shot trigger, not the idle/swim/boost loop).
  trap(e, dt, ctx) {
    e.vx = 0;
    e.vy = 0;
  },

  // Roams alone, breaks off to chase fish, otherwise comes for the player.
  hunt(e, dt, ctx) {
    const h = e.def.hunt ?? {};
    const px = e.mesh.position.x;
    const py = e.mesh.position.y;
    // Cruise shaping — see shapeSwim. `lat` is null on anything that has not
    // opted in, and every call below is then a pass-through.
    //
    // It shapes TWO of the five branches: the idle cruise and the approach to
    // the player. The three that chase a specific piece of food — a floating
    // body, a fish, chum on the seabed — steer at it exactly as they always
    // did, because a dive onto a fixed point is a deliberate act rather than
    // the aimless vertical drifting this exists to stop, and flattening it
    // breaks the chase outright: a shark that has to be nearly above a scrap of
    // seabed chum before it may descend overshoots on a turning circle wider
    // than the window, circles, and tries again. That showed up as a 1-in-8
    // failure of tools/crab-crowd-test.mjs (182 abandoned chases in 20s)
    // against 0 in 15 runs without the shaping.
    //
    // They still call updateSwim, so the gain keeps tracking while a shark is
    // busy and is already correct for where it is the moment it goes back to
    // cruising.
    const lat = h.lateral ?? null;

    // Mid-lunge everything moves faster — the burst that carries the last
    // stretch into a bite. See triggerBite / CONFIG.bite.lunge.
    const speedMul = e.lungeTimer > 0 ? (CONFIG.bite.lunge.speedMul ?? 1) : 1;

    // A BODY IN THE WATER OUTRANKS EVERYTHING. A hunter that can see one
    // breaks off the player, the fish and whatever else it was doing — which
    // is the point of sinking a boat: for a few seconds afterwards the sea
    // stops being about you. Checked before the fish search rather than folded
    // into it because it is not a tie-break, it is a priority.
    const food = CONFIG.boats.crew?.food ?? {};
    const body = nearestFloatingCrew(px, py, (food.huntRadius ?? 16) * e.spawnScale);
    if (body) {
      const at = crewPosition(body);
      e.hunting = true;
      e.preyTarget = null; // not an enemy — predation.js reads `humanTarget`
      e.humanTarget = body;
      const dx = at.x - px;
      const dy = at.y - py;
      const d = Math.hypot(dx, dy) || 1;
      const avoid = crowdAvoid(crowdSelf(e), ctx.apex, CONFIG.apexCrowd);
      updateSwim(e, dt, d, lat);
      setLookTarget(e, at.x, at.y);
      steerTo(e, dx / d + avoid.x, dy / d + avoid.y, dt, 6, speedMul);
      return;
    }
    e.humanTarget = null;

    // e.preyRadius is per-instance and shrinks with the run (CONFIG
    // .hunterRamp.preyFocus), which is most of what "gets more aggressive over
    // time" means here: the fish stop being enough of a distraction to keep
    // this thing off you.
    let target = null;
    let best = (e.preyRadius ?? h.preyRadius ?? 0) ** 2;
    for (const p of ctx.prey) {
      const dx = p.mesh.position.x - px;
      const dy = p.mesh.position.y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) { best = d2; target = p; }
    }

    if (target) {
      e.hunting = true;
      // Remember WHAT it settled on, not just that it settled on something.
      // The head-look (systems/headLook.js) points the snout at this, so a
      // shark that has broken off to chase a fish looks at the fish rather
      // than staying locked on the player. Cleared on the wander branch below
      // so a creature with nothing in mind isn't left staring at a stale
      // point — see setLookTarget.
      //
      // The bite reads the same field, and gets the target's radius from
      // `preyTarget` alongside it — a snap has to fire at the distance the
      // MEAL is, and prey species differ in radius.
      e.preyTarget = target;
      // Normalised BEFORE the crowd term is added — steerTo normalises the
      // sum, so handing it a 20-unit target vector plus a 1-unit avoidance
      // would make the avoidance vanish at range and only bite at point
      // blank, which is exactly where it's too late to steer around anything.
      const pd = Math.sqrt(best) || 1;
      const avoid = crowdAvoid(crowdSelf(e), ctx.apex, CONFIG.apexCrowd);
      updateSwim(e, dt, pd, lat);
      setLookTarget(e, target.mesh.position.x, target.mesh.position.y);
      steerTo(
        e,
        (target.mesh.position.x - px) / pd + avoid.x,
        (target.mesh.position.y - py) / pd + avoid.y,
        dt, 6, speedMul,
      );
      return;
    }

    e.preyTarget = null;
    e.humanTarget = null;

    // --- scavenging: chum it is already on top of ---------------------------
    //
    // Ranked below live fish and above the player, which is the order an
    // opportunist actually works in: it won't cross the arena for a scrap, but
    // it will break off you for one under its nose. `seekRadius` is what keeps
    // that honest — it is small, unlike the crab's arena-wide one.
    //
    // A shark does NOT park and chew. It swims through the pile with its jaw
    // open, the orb is hoovered in on the pass (see the chew block in
    // updateEnemies), and `cooldown` then puts it back on the hunt. `maxChase`
    // is the safety valve: a turn-limited body can orbit an orb it cannot
    // quite line up on forever, and a shark doing laps around one scrap of
    // chum is worse than one that never scavenged at all.
    const sc = h.scavenge;
    if (sc) {
      e.scavengeCooldown = Math.max(0, (e.scavengeCooldown ?? 0) - dt);
      if (e.chumTarget && !pickupAlive(e.chumTarget)) {
        e.chumTarget = null;
        e.eating = false;
      }
      if (e.chumTarget) {
        e.chumChase = (e.chumChase ?? 0) + dt;
        if (e.chumChase > (sc.maxChase ?? 5)) {
          e.chumTarget = null;
          e.eating = false;
          e.scavengeCooldown = sc.cooldown ?? 4;
        }
      }
      e.chumTimer = (e.chumTimer ?? 0) - dt;
      if (!e.chumTarget && e.chumTimer <= 0 && e.scavengeCooldown <= 0) {
        e.chumTimer = sc.reacquire ?? 0.5;
        e.chumTarget = bestChumTarget(px, py, sc.seekRadius ?? 16, sc.distanceBias ?? 10);
        e.chumChase = 0;
      }

      if (e.chumTarget) {
        const ox = e.chumTarget.mesh.position.x;
        const oy = e.chumTarget.mesh.position.y;
        // `hunting` means "busy with something that isn't you" — it is what
        // keeps a shark hoovering chum beside the player from also snapping at
        // the player on the same frame.
        e.hunting = true;
        const cd = Math.hypot(ox - px, oy - py);
        updateSwim(e, dt, cd, lat);
        setLookTarget(e, ox, oy);
        e.eating = cd <= (sc.eatRange ?? 2.6);
        // Swims straight through it either way — the gulp happens in passing.
        steerTo(e, ox - px, oy - py, dt, 6, speedMul);
        return;
      }
    }

    e.hunting = false;
    const aggro = h.playerAggroRadius ?? Infinity;
    if (ctx.dist < aggro) {
      // Still LOOKS at the player even while circling — a shark holding the
      // ring with its head turned in is stalking; one facing along its own
      // arc is just swimming past, and the difference is the whole read.
      updateSwim(e, dt, Math.abs(ctx.dirX * ctx.dist), lat);
      const look = weaveLook(e, px + ctx.dirX * ctx.dist, py + ctx.dirY * ctx.dist, lat);
      setLookTarget(e, look.x, look.y);
      if (e.standoffDist == null) e.standoffDist = pickStandoff(CONFIG.apexCrowd);
      const want = approachVector(crowdSelf(e), ctx, ctx.apex, CONFIG.apexCrowd);
      const go = shapeSwim(e, want.x, want.y, lat);
      steerTo(e, go.x, go.y, dt, 6, speedMul);
      return;
    }

    // Cruising with nothing in mind. The uniformly random angle this used to
    // pick is the single biggest source of vertical wandering in the game: a
    // shark was as likely to head straight up as along the reef, and since
    // steerTo drives at full speed along the heading, "up" meant a body-length
    // a second of climb for no reason at all.
    //
    // `wanderPitch` keeps the same wander but confines it to a shallow cone
    // either side of horizontal, so the direction is still a real choice — it
    // just stops being a vertical one.
    e.wanderTimer -= dt;
    if (e.wanderTimer <= 0) {
      e.wanderTimer = h.wanderChange ?? 2;
      if (lat) {
        const pitch = lat.wanderPitch ?? 0.22;
        const side = Math.random() < 0.5 ? 0 : Math.PI;
        e.wanderAngle = side + (Math.random() * 2 - 1) * pitch;
      } else {
        e.wanderAngle = Math.random() * Math.PI * 2;
      }
    }
    updateSwim(e, dt, null, lat);
    if (lat) {
      // A cruising shark still LOOKS somewhere: down its own path, swinging
      // slowly to each side. That look point is the whole of the idle weave —
      // headLook aims the snout at it and the spring chain trails the body
      // after it, so an unengaged shark reads as swimming rather than as being
      // towed. Cleared only when it has opted out of this block.
      const ahead = lat.weaveLead ?? 6;
      const look = weaveLook(
        e,
        px + Math.cos(e.wanderAngle) * ahead,
        py + Math.sin(e.wanderAngle) * ahead,
        lat,
      );
      setLookTarget(e, look.x, look.y);
    } else {
      e.lookTarget = null;
    }
    const go = shapeSwim(e, Math.cos(e.wanderAngle), Math.sin(e.wanderAngle), lat);
    steerTo(e, go.x, go.y, dt);
  },

  // A shark that periodically leaves the water. Between arcs it hunts exactly
  // like `hunt`; when the timer fires it aims up and, once airborne, gravity
  // alone shapes the arc — so the jump traces a real ballistic curve instead
  // of a scripted path, and where it re-enters depends on how fast it was
  // travelling. Needs `canBreach` on the def, or the shared surface clamp
  // below would pin it under the water line mid-jump.
  porpoise(e, dt, ctx) {
    const p = e.def.porpoise ?? {};
    const airborne = e.mesh.position.y > bounds.surfaceY;

    if (airborne) {
      // Ballistic: no steering at all, just gravity. Killing thrust here is
      // what makes the arc read as a committed leap rather than swimming
      // through the sky.
      e.vy -= (p.gravity ?? 26) * dt;
      return;
    }

    e.jumpTimer = (e.jumpTimer ?? p.interval ?? 6) - dt;
    const nearSurface = e.mesh.position.y > bounds.surfaceY - (p.launchDepth ?? 6);
    if (e.jumpTimer <= 0 && nearSurface) {
      e.jumpTimer = (p.interval ?? 6) * (0.7 + Math.random() * 0.6);
      // Launch up and along current heading, so the arc carries it across the
      // arena rather than straight up and back down on the spot.
      const dir = Math.sign(e.vx) || (Math.random() < 0.5 ? -1 : 1);
      e.vx = dir * (p.launchSpeedX ?? 9);
      e.vy = p.launchSpeedY ?? 17;
      return;
    }

    // Below the surface it behaves as a hunter, so it still works the food
    // chain between jumps.
    BEHAVIORS.hunt(e, dt, ctx);
  },

  // Cruises a band above the seabed, crossing the arena rather than chasing.
  // Rays are scenery with a hitbox: they read as traffic you have to swim
  // around while you're down farming the floor.
  glide(e, dt, ctx) {
    const g = e.def.glide ?? {};
    const band = g.height ?? 8;
    const spread = g.bandSpread ?? 3;
    // Each ray keeps its own cruising altitude inside the band, so a group
    // doesn't converge into a single line.
    if (e.glideY == null) e.glideY = bounds.bottom + band + (Math.random() - 0.5) * spread * 2;
    if (e.glideDir == null) e.glideDir = Math.random() < 0.5 ? -1 : 1;

    // Turn around at the walls instead of pressing into them.
    const margin = e.radius + 2;
    if (e.mesh.position.x < bounds.left + margin) e.glideDir = 1;
    else if (e.mesh.position.x > bounds.right - margin) e.glideDir = -1;

    const dy = e.glideY - e.mesh.position.y;
    steerTo(e, e.glideDir, Math.max(-1, Math.min(1, dy * 0.5)), dt, 3);
  },

  // Slow, aimless drift. Used by the sea turtle, which exists to be in the
  // way — it never seeks the player, so any collision is the player's own
  // doing rather than the turtle hunting them down.
  drift(e, dt, ctx) {
    const d = e.def.drift ?? {};
    e.wanderTimer -= dt;
    if (e.wanderTimer <= 0) {
      e.wanderTimer = d.wanderChange ?? 4;
      e.wanderAngle = Math.random() * Math.PI * 2;
    }
    steerTo(e, Math.cos(e.wanderAngle), Math.sin(e.wanderAngle) * 0.4, dt, 1.5);
  },
};

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

// Is this creature's FAMILY already full? A second ceiling above the species'
// own `maxConcurrent`, so a roster of individually-rare big predators can't
// stack into a crowd on the technicality that none of them is individually
// over its limit. See CONFIG.spawn.groupMaxAlive.
//
// `counts` is the headcount pickType already built while walking the enemy
// list; pass null and this counts for itself, which is what the one-off
// spawnNamed path does rather than make every caller keep a tally.
function groupAtCap(def, counts = null) {
  const group = def.spawnGroup;
  if (group == null) return false;
  const cap = CONFIG.spawn.groupMaxAlive?.[group];
  if (cap == null) return false;
  let n = counts?.get(group) ?? 0;
  if (!counts) {
    n = 0;
    for (const e of enemies) if (e.def?.spawnGroup === group) n += 1;
  }
  return n >= cap;
}

// How welcome a creature is right now, as a multiplier on its spawn weight.
// `glowing` picks which of the two curves in CONFIG.spawn.nightlife to walk:
// the tagged roster fades IN as it gets dark, everything else fades OUT. The
// two together are what turn sunset into a change of cast rather than a change
// of lighting with the same fish under it.
//
// Reads skyLight.night rather than dayState.phase because a label can't be
// ramped against — 'dusk' is either true or it isn't, and the whole point is
// that the swap happens over the minute the sun spends going down.
//
// With the day/night cycle switched off the bus publishes night = 0 forever.
// Walking the curves against that would hold the glowing roster at its daytime
// weight (0 — deleted from the game) and the daylight roster at its own (1),
// so a world with no night would be a permanent noon. Both curves stand down
// to 1 instead: no clock means no changeover, and every species spawns at the
// weight its row asks for.
//
// Returning each curve's `night` end here instead is the tempting version and
// is worse in both directions — it would pin the daylight roster at 0.08
// forever, quietly deleting most of the roster from any run with the cycle
// off, and there'd be no message saying why.
export function nightlifeWeight(glowing) {
  const cfg = CONFIG.spawn.nightlife;
  if (!cfg?.enabled) return 1;
  if (!CONFIG.dayNight?.enabled) return 1;
  const curve = (glowing ? cfg.glowing : cfg.daylight) ?? {};
  const day = curve.day ?? (glowing ? 0 : 1);
  const night = curve.night ?? 1;
  const dusk = cfg.dusk ?? 0;
  const dark = Math.max(dusk + 1e-4, cfg.dark ?? 1);
  const t = Math.min(1, Math.max(0, (skyLight.night - dusk) / (dark - dusk)));
  return day + (night - day) * t;
}

// `lull` is the wave clock's quiet stretch (see systems/waves.js): a fourth
// kind of "not yet", alongside minDifficulty, minPlayerLevel and the nightlife
// gate. Unlike those three it asks nothing about the creature's place in the
// run — only whether the water is meant to be calm right now — so it sits
// ahead of the weight maths rather than scaling it.
function pickType(difficulty, playerLevel = 1, lull = false) {
  // Per-type headcount, so `maxConcurrent` can keep any one species in check,
  // and the same walk tallies each `spawnGroup` for the family-wide cap.
  const alive = new Map();
  const aliveGroup = new Map();
  for (const e of enemies) {
    alive.set(e.type, (alive.get(e.type) ?? 0) + 1);
    const group = e.def?.spawnGroup;
    if (group != null) aliveGroup.set(group, (aliveGroup.get(group) ?? 0) + 1);
  }

  // Both curves worked out once for the whole walk rather than per creature:
  // there are only two answers and they read the clock.
  const glowMul = nightlifeWeight(true);
  const dayMul = nightlifeWeight(false);

  const pool = [];
  let total = 0;
  for (const [key, def] of Object.entries(CONFIG.enemies)) {
    if (difficulty < (def.minDifficulty ?? 0)) continue;
    // Hard level gate, independent of the time-based difficulty curve: a
    // creature with minPlayerLevel simply cannot appear until the player
    // reaches that level, however long the run has gone on.
    if (playerLevel < (def.minPlayerLevel ?? 0)) continue;
    // Between waves, only the small fry. An empty pool is a legitimate answer
    // here — a lull with every little fish already at its cap is simply quiet,
    // and the caller treats "nothing to send" as nothing to send.
    if (lull && !lullEligible(def)) continue;
    if (def.maxConcurrent != null && (alive.get(key) ?? 0) >= def.maxConcurrent) continue;
    if (groupAtCap(def, aliveGroup)) continue;
    // spawnRateMul is the per-creature tuning knob: 0 disables a creature
    // outright, 2 makes it twice as likely as its weight would suggest.
    let w = ((def.weight ?? 0) + (def.weightPerDifficulty ?? 0) * difficulty) * (def.spawnRateMul ?? 1);
    if (def.maxWeight != null) w = Math.min(w, def.maxWeight);
    // After the cap, not before: `maxWeight` is a ceiling on how common a
    // species gets over a long run, and the changeover is meant to scale the
    // result of that curve rather than be clipped by it.
    w *= def.bioluminescent ? glowMul : dayMul;
    if (w <= 0) continue;
    total += w;
    pool.push({ key, def, w });
  }
  if (pool.length === 0) return null; // everything is at its cap right now
  let roll = Math.random() * total;
  for (const entry of pool) {
    roll -= entry.w;
    if (roll <= 0) return entry;
  }
  return pool[pool.length - 1];
}

// Sea creatures enter from the sides or from the deep — never from the sky.
//
// A CRAWLER IS THE EXCEPTION and has to be asked for by passing its def. The
// generic point picks a random DEPTH, which for a swimmer is the whole idea
// and for a crab means arriving in mid-water and falling to the seabed — and
// arriving INSIDE the arena, where the wall clamp grabs it on frame one so it
// pops into place instead of walking on. Crabs get the same wing entrance the
// chum-pile summoner gives them (systems/crabSpawner.js edgeFloorPoint), which
// is the only reason they read as walking on from off-screen.
function edgeSpawnPoint(def = null) {
  const margin = 1.5;
  if (def?.behavior === 'crawl') {
    // OUTSIDE the arena on purpose: spawnOne only skips the horizontal clamp
    // while a body is still beyond the wall, and that is what buys the walk-on.
    const m = CONFIG.crabSpawn?.spawnMargin ?? 3;
    return {
      x: Math.random() < 0.5 ? bounds.left - m : bounds.right + m,
      y: bounds.bottom + (CONFIG.crabSpawn?.floorHeight ?? 2.5) * 0.5,
    };
  }
  const r = Math.random();
  const depth = bounds.bottom + margin + Math.random() * (bounds.surfaceY - bounds.bottom - margin * 2);
  if (r < 0.45) return { x: bounds.left + margin, y: depth };
  if (r < 0.9) return { x: bounds.right - margin, y: depth };
  return { x: bounds.left + Math.random() * bounds.width, y: bounds.bottom + margin };
}

// `opts.schoolId` groups a school for the boids; `opts.xpMul` scales what this
// individual's chum will be worth when it dies (the lull between waves pays a
// fraction — see CONFIG.spawn.waves.lull).
function spawnOne(scene, key, def, difficulty, at, opts = {}) {
  const { schoolId = null, xpMul = 1 } = opts;
  const container = new THREE.Group();
  const visual = createVisual(def.asset ?? key);
  container.add(visual);

  // Creatures that grow over a run: later spawns come in bigger than the
  // ones at the start. Capped by `maxGrowth`, or a long run ends up with
  // crabs the size of the arena — and because the hitbox is derived from the
  // visual scale below, an uncapped multiplier would inflate the hitbox too.
  const growth = Math.min(
    def.maxGrowth ?? Infinity,
    1 + (def.scalePerDifficulty ?? 0) * difficulty
  );
  // Per-individual size jitter on top of the run's growth. A crowd of one
  // species at one size reads as a repeated sprite, and since the hitbox is
  // derived from the visual scale below, this makes a big crab a genuinely
  // bigger target — and a heavier one, because CONFIG.crabPhysics takes mass
  // from the radius. Clamped away from zero so a bad roll can't produce an
  // inside-out model with a negative hitbox.
  const variance = Math.max(0.2, 1 + (Math.random() * 2 - 1) * (def.scaleVariance ?? 0));
  const sizeMul = growth * variance;
  if (sizeMul !== 1) visual.scale.multiplyScalar(sizeMul);

  // The scale createVisual actually built this instance at, times whatever
  // growth the run has added. The asset's own `fit` is already baked into the
  // template, so what's left is the tuner's per-asset Size multiplier — and
  // reading it off the visual rather than asking the tuner means the hitbox
  // is derived from the body that exists, whatever put the scale there.
  const spawnScale = visual.scale.x || 1;
  // config `radius` describes the creature at its authored size, so scaling
  // the model has to scale the hitbox with it or a creature the tuner made
  // 2.66x bigger keeps a hitbox for an animal a third of its size. Every
  // collision test reads e.radius, never def.radius, for this reason.
  const radius = def.radius * spawnScale;

  // Depth lane. The camera is orthographic, so z costs nothing in perspective
  // — it only decides what draws in front of what, and (via `depthContact` in
  // resolveCrabCollisions) which bodies are close enough to touch. That is
  // what turns a converging swarm into a crowd with a front row and a back one
  // instead of a single flat rank.
  //
  // Scaled by the radius this instance actually spawned at, so it is the same
  // spread relative to the body at any size multiplier — see the note on
  // enemies.walkingCrab.depthSpread for what a hand-typed value costs here.
  const z = (Math.random() * 2 - 1) * (def.depthSpread ?? 0) * radius;
  container.position.set(at.x, at.y, z);
  // Seabed dwellers ignore the edge spawn point's Y and settle on the floor,
  // so they appear where they belong rather than swimming down to it.
  if (def.floorSpawn) container.position.y = bounds.bottom + radius;

  // Spawned off the side of the arena — crabs walk on from the wings. The
  // shared clamp would yank it inside on the very first frame, leaving
  // nothing to walk in FROM, so while `entering` is set only the vertical
  // limits apply. Cleared the moment it is fully inside (see updateEnemies),
  // after which it is walled in like everything else.
  const entering = at.x < bounds.left + radius || at.x > bounds.right - radius;
  if (entering) clampVertical(container.position, radius);
  else clampBelowSurface(container.position, radius);
  scene.add(container);

  // Two layers of run scaling, in this order: the species' own linear
  // per-difficulty term, then the roster-wide compounding ramp from
  // CONFIG.spawn.ramp. The linear term keeps each creature's authored
  // character (a shark gains far more hp per minute than a reef fish); the
  // ramp is what makes minute ten hurt no matter which creature it sends.
  const hp = (def.hp + def.hpPerDifficulty * difficulty) * difficultyRamp('hp', difficulty);
  // Damage and speed ramp with the run the same way hp always has. All three
  // are baked per-instance at spawn rather than read from the shared def
  // every frame: `def` is one object for the whole species, so scaling it in
  // place would retroactively buff everything already on screen.
  const contactDamage = (def.contactDamage + (def.contactDamagePerDifficulty ?? 0) * difficulty)
    * difficultyRamp('damage', difficulty);
  // Ranged attackers scale with the same damage curve as contact — otherwise
  // anything with a `shoot` block falls behind over a long run. updateEnemies
  // fires with e.shotDamage, not def.shoot.damage, for the same
  // per-instance reason as above.
  const shotDamage = def.shoot ? def.shoot.damage * difficultyRamp('damage', difficulty) : 0;
  // Speed variance stays outside the ramp: it's the per-individual jitter
  // that keeps a school from moving as one body, not part of the threat
  // curve, and multiplying it up would spread a late-run school apart.
  const speed = (def.speed + (def.speedPerDifficulty ?? 0) * difficulty)
    * difficultyRamp('speed', difficulty)
    + Math.random() * (def.speedVariance ?? 0);
  const heading = Math.random() * Math.PI * 2;

  // The pressure side of the balance ledger: hp entering the arena. Recorded
  // at spawn rather than counted at death on purpose — the creatures a
  // flooding arena is made of are exactly the ones that never get killed, and
  // a kill-based tally would be blind to them.
  //
  // Scenery is excluded. The sea turtle carries hp 1e9 to mean "cannot be
  // killed", and counting that as hp the player is expected to clear made one
  // turtle spawn read as 628 MILLION hp/sec of pressure — which silently
  // pinned that whole window's clear rate at zero and would have had every
  // report blaming the difficulty ramp for a turtle. Hp this large is a flag,
  // not a quantity.
  if (hp < UNKILLABLE_HP) recordSpawn(hp);

  // Any model with clips or a procedural rig gets a controller; static
  // shapes and unrigged models (e.g. the reef fish) simply don't.
  // Trap enemies use their own one-shot attack mixer below instead of the
  // continuous idle/swim/boost controller (they don't have those states).
  const hasAnimSource = def.behavior !== 'trap' && (visual.userData?.clips?.length || visual.userData?.rig);
  const anim = hasAnimSource ? createAnimationController(visual) : null;

  // Head-look, for the models that declare a chain for it (the sharks and the
  // orca). Null for everything else, and every call site tolerates that.
  const look = def.behavior !== 'trap' ? createHeadLook(visual) : null;

  // Procedural jaw, for the hunters whose file ships no bite clip — which is
  // all of them except megalodon. Skipped when the controller already has a
  // real `bite` action, so the authored clip owns the jaw rather than getting
  // a second rotation piled on top of the one it is already writing.
  const jaw = anim?.clipCoverage?.bite ? null : createJawDriver(visual);

  // The crab's telegraphed pinch. Null for everything that declares no
  // clawRig, which is every creature but the two crabs — see systems/
  // crabClaw.js for why the gesture has to be manufactured rather than played.
  const claw = createClawDriver(visual);

  // Behavioural difficulty ramp, baked per instance for the same reason
  // hp/damage/speed above are: `def` is one object shared by every member of
  // the species. See CONFIG.hunterRamp.
  const ramp = CONFIG.hunterRamp;
  const rampOn = ramp?.enabled && difficulty > 0;
  // Prey distraction decays toward a floor: each difficulty point sheds
  // `preyFocus` of what is LEFT above the floor, so it falls off quickly at
  // first and then flattens instead of crossing zero.
  const preyBase = def.hunt?.preyRadius ?? 0;
  const preyFloor = preyBase * (ramp?.preyFocusMin ?? 1);
  const preyRadius = rampOn
    ? preyFloor + (preyBase - preyFloor) * (1 - (ramp.preyFocus ?? 0)) ** difficulty
    : preyBase;
  // ...and turning tightens, compounding and capped, like the spawn ramps.
  const turnRate = def.turnRate
    ? def.turnRate * (rampOn
      ? Math.min(ramp.turnRateMax ?? Infinity, (1 + (ramp.turnRate ?? 0)) ** difficulty)
      : 1)
    : def.turnRate;

  // Trap-type enemies play a one-shot attack clip on their own timer rather
  // than the continuous idle/swim/boost loop, so they get a tiny dedicated
  // mixer instead of the shared controller.
  let attackMixer = null;
  let attackAction = null;
  if (def.behavior === 'trap' && visual.userData?.clips?.length) {
    const clipName = def.animations?.attack;
    const clip = clipName ? THREE.AnimationClip.findByName(visual.userData.clips, clipName) : null;
    if (clip) {
      attackMixer = new THREE.AnimationMixer(visual);
      attackAction = attackMixer.clipAction(clip);
      attackAction.loop = THREE.LoopOnce;
      attackAction.clampWhenFinished = true;
    }
  }

  enemies.push({
    type: key,
    def,
    mesh: container,
    visual,
    hp,
    maxHp: hp,
    spawnHp: hp,
    // What this individual's chum is worth. Baked at spawn like hp, damage and
    // speed above, and for the same reason: `def` is one object shared by the
    // whole species, so a creature has to carry the value it was born with. A
    // fish that drifted in during a lull stays a low-value fish even if the
    // next surge has started by the time anything kills it.
    //
    // Score is not scaled with this — systems/scoring.js reads def.xp on
    // purpose, so a quiet-water kill still banks full points. See
    // CONFIG.spawn.waves.lull.
    xp: (def.xp ?? 0) * xpMul,
    speed,
    // Per-instance, so a crab that spawned at minute one keeps hitting for
    // what it was worth then. combat.js reads e.contactDamage, not the def.
    contactDamage,
    shotDamage,
    vx: Math.cos(heading) * speed * 0.5,
    vy: Math.sin(heading) * speed * 0.5,
    heading,
    fireTimer: Math.random() * (def.shoot?.interval ?? 1),
    orbitDir: Math.random() < 0.5 ? -1 : 1,
    wanderTimer: Math.random() * 2,
    wanderAngle: heading,
    phase: Math.random() * Math.PI * 2,
    schoolId,
    biteTimer: 0,
    meals: 0,
    hunting: false,
    // Which prey this hunter has settled on this frame, or null. Written by
    // BEHAVIORS.hunt; read by the bite so a snap fires at the distance the
    // actual meal is rather than at a fixed radius.
    preyTarget: null,
    humanTarget: null,
    // Per-instance aggression, baked at spawn — see CONFIG.hunterRamp.
    preyRadius,
    turnRate,
    // Jaw state. `biteCooldown` rate-limits the snap; `lungeTimer` is the
    // burst of speed that carries it in. Both tick in updateEnemies.
    jaw,
    claw,
    // Seconds until this crab may start another pinch. Per instance, so a
    // crowd does not snap in unison — seeded short and random so the first
    // crab to reach you does not have to serve a full cooldown before it may
    // do anything at all.
    pinchTimer: Math.random() * (CONFIG.crabClaw?.cooldown ?? 2.6),
    // Set for exactly one frame, on the frame the claws meet. systems/
    // combat.js reads it and bills the damage; nothing else may write it.
    justPinched: false,
    biteCooldown: 0,
    lungeTimer: 0,
    look,
    // What the head is pointed at this frame, or null for "nothing in mind".
    // Written by the behaviors via setLookTarget; `lookAt` is the reused
    // vector behind it.
    lookTarget: null,
    lookAt: null,
    // Cruise state — see shapeSwim. The phase is randomised per individual so
    // a pack that spawned together does not weave in unison, which reads as a
    // shoal rather than as several predators.
    weavePhase: Math.random(),
    // Starts flat: a shark that has just spawned has not earned any vertical
    // authority yet, so it enters the arena swimming rather than climbing.
    climbGain: 0,
    flash: 0,
    // The scale the visual spawned at, and the growth multiplier layered on
    // top of it (predation bumps baseScale as a predator feeds). Kept apart
    // so neither one can silently erase the other: the hit-pop used to
    // setScalar(baseScale) outright, which threw away spawnScale and made a
    // tuner-enlarged creature snap down to its authored size the first time
    // anything touched it.
    spawnScale,
    baseScale: 1,
    radius,
    anim,
    hitThisFrame: false,
    trapTimer: 0,
    // Kept separate from trapTimer rather than reusing it: the two sources
    // have different durations and different looks, and sharing one field
    // meant a beluga bubble landing on a charmed fish would cut the charm
    // short (or extend it) depending on which fired last.
    charmTimer: 0,
    // --- elemental status (Glow Up!, systems/elements.js) --------------------
    // Seeded here rather than created on first application, for the reason
    // every stat field is seeded in stats.js: `undefined - dt` is NaN, and a
    // NaN timer never expires, so a fish would carry a status forever with
    // nothing on screen to say why. All four elements share this block; only
    // one of them can be live in a run, since the element is rolled once.
    venomTimer: 0,
    venomStacks: 0,
    venomTick: 0,
    // How much of its speed is currently taken. Read by the integrator below,
    // NOT by the behaviours — a chilled fish still decides to chase, it just
    // can't get there, which is what makes chill feel like the water thickening
    // rather than like the fish losing interest.
    chillTimer: 0,
    chillSlow: 0,
    infectTimer: 0,
    infectDps: 0,
    infectTick: 0,
    // Hops from the fish that was actually shot. Capped so a contagion crosses
    // a school without crossing the arena — see CONFIG.biolum.elements.infection.
    infectGen: 0,
    infectSpreadTimer: 0,
    attackMixer,
    attackAction,
    attackTimer: Math.random() * (def.trap?.cooldown ?? 2),
    // Scavenging state (crawl + feed). Staggered so a wave that spawns
    // together doesn't re-target in lockstep on the same frame.
    chumTarget: null,
    chumTimer: Math.random() * (def.crawl?.feed?.reacquire ?? 0.4),
    eating: false,
    entering,
    // Body-level knockback state (crab-vs-crab collisions). `tumble` is a
    // roll offset laid over the locked broadside heading; `tumbleVel` is its
    // angular velocity. Both spring back to zero — see the collision block.
    tumble: 0,
    tumbleVel: 0,
    bumpCooldown: 0,
    // Rest pose, rolled once per individual (see the crowd-variation block on
    // enemies.walkingCrab). `restLean` is the angle the locked broadside
    // heading actually settles at, so the tumble spring rights the crab back
    // to ITS own crooked stance rather than to a shared perfect vertical;
    // `restYaw` turns it a little off-camera. A whole wave arriving at
    // identical angles is most of what made them read as one repeated object.
    restLean: (Math.random() * 2 - 1) * (def.restLean ?? 0),
    restYaw: (Math.random() * 2 - 1) * (def.restYaw ?? 0),
    // How high whatever this body is standing on holds it, or -Infinity for
    // "nothing but the seabed". Rewritten every frame by resolveCrabCollisions.
    supportY: -Infinity,
  });
}

// `wave` is this tick's answer from systems/waves.js — which roster is open,
// how big a school it may send, and what the chum is worth. Defaulted so any
// caller that doesn't care about pacing gets the unmodified spawn.
const FLAT_WAVE = { rateMul: 1, lull: false, groupMul: 1, xpMul: 1 };

function spawnPicked(scene, difficulty, playerLevel = 1, wave = FLAT_WAVE) {
  const picked = pickType(difficulty, playerLevel, wave.lull);
  if (!picked) return 0;
  const { key, def } = picked;

  if (def.group) {
    const anchor = edgeSpawnPoint(def);
    let n = def.group.min + Math.floor(Math.random() * (def.group.max - def.group.min + 1));
    // A quiet stretch sends a few fish, not a shoal. Floored at one so the
    // multiplier can thin a school without ever cancelling the spawn outright
    // — a pick that produced nothing would just spend the guard budget and
    // leave the water emptier than the calm was asking for.
    if (wave.groupMul !== 1) n = Math.max(1, Math.round(n * wave.groupMul));
    const id = nextSchoolId++;
    const spread = def.group.spread ?? 3;
    let made = 0;
    for (let i = 0; i < n; i++) {
      if (enemies.length >= CONFIG.spawn.maxAlive) break;
      // The family cap re-checked per BODY, not just once for the pick.
      // pickType tests it before choosing, so a pick made with a family nearly
      // full was free to overshoot it by most of a group — measured at a cap of
      // ten fielding twelve, back when the crabs briefly spawned in groups.
      // Nothing capped spawns in groups today; this keeps that from being a
      // silent trap for whatever does next.
      if (groupAtCap(def)) break;
      spawnOne(scene, key, def, difficulty, {
        x: anchor.x + (Math.random() - 0.5) * spread * 2,
        y: anchor.y + (Math.random() - 0.5) * spread * 2,
      }, { schoolId: id, xpMul: wave.xpMul });
      made += 1;
    }
    return made;
  }

  spawnOne(scene, key, def, difficulty, edgeSpawnPoint(def), { xpMul: wave.xpMul });
  return 1;
}

// Direct, non-weighted spawn — for a one-off special spawn on its own trigger
// that shouldn't compete in the normal random pool.
//
// Currently UNCALLED: its only user was the glowing shark's spawn timer, which
// is gone. Kept because it is the general primitive for "put this exact
// creature in the water", caps and all, and rewriting it is the tax on the
// next marquee spawn.
// `opts.ignoreCaps` skips the population limits but NOT the maxAlive ceiling.
// One caller uses it: the crabs piling onto the corpse (systems/crabSpawner.js).
// The caps below exist to keep a fight readable, and once the run is over
// there is no fight — but maxAlive is a memory bound and binds regardless.
export function spawnNamed(scene, key, difficulty, at = edgeSpawnPoint(CONFIG.enemies[key]), opts = {}) {
  const def = CONFIG.enemies[key];
  if (!def) {
    console.warn(`[enemies] spawnNamed: unknown enemy key "${key}"`);
    return null;
  }
  // Unlike the weighted random pool (pickType), a direct spawn like this
  // bypasses population limits by default — enforce them here so no caller
  // has to remember to, since a good enough trigger condition (e.g. a big
  // pickup pile, or just an unlucky spawn timer) can otherwise fire every
  // check with nothing capping the total.
  if (enemies.length >= CONFIG.spawn.maxAlive) return null;
  if (!opts.ignoreCaps) {
    if (def.maxConcurrent != null) {
      const current = enemies.filter((e) => e.type === key).length;
      if (current >= def.maxConcurrent) return null;
    }
    // The family-wide cap binds here too, for the same reason: a marquee spawn
    // arriving through this path and ignoring the apex allowance would be
    // exactly the crowd the cap exists to prevent.
    if (groupAtCap(def)) return null;
  }
  spawnOne(scene, key, def, difficulty, at);
  return enemies[enemies.length - 1];
}

export function updateSpawning(dt, gameState, scene) {
  const d = gameState.difficulty;

  // The wave clock rides this function's own dt rather than main.js's frame
  // loop, so it advances in lockstep with the spawn timer below and cannot
  // drift from the thing it paces — and so anything that stops spawning (the
  // level-up cards, the death dive, the score screen) stops the wave with it.
  // It has to tick every frame, above the timer's early return, or a slow
  // stretch of the cycle would also slow down the cycle itself.
  updateWaves(dt, d);
  const wave = waveSpawn();

  spawnTimer -= dt;
  if (spawnTimer > 0) return;

  // Both halves of the spawn rate take the wave multiplier, because neither
  // one carries it alone: the interval stops responding once a long run has
  // pinned it at `minInterval`, and the count budget is too coarse early on,
  // when it is still flooring to a single creature.
  //
  // The multiplier goes INSIDE the clamp so `minInterval` stays the absolute
  // floor it has always been — a crest asks for more by spending a bigger
  // budget per tick, not by ticking faster than the spawner is meant to.
  spawnTimer = Math.max(
    CONFIG.spawn.minInterval,
    (CONFIG.spawn.baseInterval - d * CONFIG.spawn.intervalPerDifficulty) / wave.rateMul
  );

  // Budget is in creatures, not spawn events: a school of 12 costs 12, so
  // schooling species can't quietly multiply the intended spawn rate.
  let budget = 1 + Math.floor(d * CONFIG.spawn.countPerDifficulty);
  // Applied after the floor rather than folded into it, so waves switched off
  // (rateMul 1) leaves the original arithmetic bit-for-bit intact.
  if (wave.rateMul !== 1) budget = Math.max(1, Math.round(budget * wave.rateMul));
  let guard = 12;
  while (budget > 0 && guard-- > 0 && enemies.length < CONFIG.spawn.maxAlive) {
    const made = spawnPicked(scene, d, gameState.level ?? 1, wave);
    if (made === 0) break;
    budget -= made;
  }
}

// ---------------------------------------------------------------------------
// Biting
// ---------------------------------------------------------------------------

// Snap. Exported because the two things a hunter bites are resolved in two
// different places: the player here in updateEnemies, and fish over in
// systems/predation.js, which owns the whole predator/prey interaction.
//
// Rate-limited to the species' own eat cooldown, so the jaw work stays in
// step with how often this predator can actually take a meal — a shark that
// eats every 1.2s snaps about that often, an orca every 0.45s. Returns
// whether the bite actually fired, so a caller can put a sound or a puff on it.
export function triggerBite(e) {
  const cfg = CONFIG.bite;
  if (!cfg?.enabled) return false;
  if (e.biteCooldown > 0) return false;
  if (e.trapTimer > 0 || e.charmTimer > 0) return false; // held creatures are inert

  e.biteCooldown = e.def.hunt?.biteCooldown ?? cfg.cooldown ?? 1;

  // Authored clip first (megalodon is the only one that has one); the
  // procedural jaw is what everything else has instead. trigger() returns
  // false for a model with no clip for the state, so this needs no per-species
  // check — and `jaw` is null wherever a clip exists, so they can't both fire.
  const played = e.anim?.trigger('bite') ?? false;
  if (!played) e.jaw?.bite();

  if (cfg.lunge?.enabled) e.lungeTimer = cfg.lunge.duration ?? 0;
  return true;
}

// How close this hunter has to be to snap at the player. Contact reach, since
// the player is not prey and carries no `biteRange` for a predator to use.
function playerBiteReach(e) {
  return (e.radius + (player.stats?.hitRadius ?? 0.5)) * (CONFIG.bite.playerReach ?? 1);
}

// ---------------------------------------------------------------------------
// Per-frame update
// ---------------------------------------------------------------------------

let clock = 0;

// Frozen in place, still alive.
//
// The level-up pause stops the whole roster where it stands — main.js skips
// updateEnemies entirely while the cards are up, so nothing steers, hunts,
// bites or scavenges (see systems/levelUpTime.js). A creature that also stops
// MOVING reads as a paused game rather than as a held moment, so the mixers
// keep running on the dilated clock and everything goes on breathing on the
// spot.
//
// Deliberately only the pose: no velocity, no rotation, no chum, and the state
// is always the standing-still one, so a shark that was mid-charge idles
// rather than continuing to swim on the spot. A one-shot already playing
// (a bite that landed on the frame the level did) is allowed to finish — it's
// a clip playing out in slow motion, and cutting it dead is the snap this is
// here to avoid.
export function animateEnemiesIdle(dt) {
  if (!CONFIG.animation.enabled) return;
  for (const e of enemies) {
    e.anim?.update(dt, stateForSpeed(0), false);
    // Same reason as in the main loop: the driver's anti-ratchet needs to see
    // every frame, including the ones where nothing is biting.
    e.jaw?.update(dt);
    // No aim while the world is frozen — a crab mid-pinch lowers its claw
    // rather than holding it over a player who cannot be hit. Still driven,
    // for the same anti-ratchet reason as the jaw, and so the IK weight
    // actually eases out instead of freezing the arm mid-reach.
    e.claw?.update(dt, null);
  }
}

// `onChumEaten(x, y, enemy)` fires the moment a crab finishes an orb, so
// main.js can put a puff and a sound on it — the player needs to notice
// resources leaving, not just find fewer orbs than they remembered.
//
// `onChumHoover(x, y, enemy)` fires REPEATEDLY while an orb is being sucked in,
// at each feeder's own crumb rate — the "it is happening" to the other's "it
// happened". Kept as a callback like its neighbour rather than reaching for
// feedback() in here: this module owns creatures, and every sound, particle
// and screen shake in the game is main.js's to place.
export function updateEnemies(dt, scene, playerPos, onChumEaten, onChumHoover) {
  clock += dt;

  // Pile sizes for the whole frame, so every scavenging crab reads one shared
  // answer instead of each rebuilding it.
  refreshChumPiles(CONFIG.crabSpawn.clusterRadius ?? 6);

  // Rigid-body pass before the behaviors, so a crab that got shoved this
  // frame steers from where it actually ended up.
  resolveCrabCollisions(dt, enemies);

  // Group pass: schools for the boids, and the predator/prey lists that both
  // the fleeing and the hunting behaviors read.
  const schools = new Map();
  const prey = [];
  const predators = [];
  for (const e of enemies) {
    if (e.schoolId != null) {
      let arr = schools.get(e.schoolId);
      if (!arr) { arr = []; schools.set(e.schoolId, arr); }
      arr.push(e);
    }
    if (e.def.prey) prey.push(e);
    if (e.def.hunt) predators.push(e);
  }

  // Who gets to press the player this frame, and who holds the ring. Must run
  // before the behavior loop below — every hunter's steering reads the answer.
  refreshApexCrowd(dt, playerPos);

  for (const e of enemies) {
    const dx = playerPos.x - e.mesh.position.x;
    const dy = playerPos.y - e.mesh.position.y;
    const dist = Math.hypot(dx, dy) || 0.0001;
    const ctx = {
      dist, dirX: dx / dist, dirY: dy / dist,
      playerPos, schools, prey, predators, apex: apexViews, time: clock,
    };

    // Big creatures shoulder each other apart so predators don't stack into
    // one indistinguishable blob. Only applies between enemies that BOTH
    // opt in via `separates` (set on hunters/large bodies) — schooling fish
    // already have their own flocking separation and shouldn't pay for a
    // second O(n^2) pass on top of it.
    // `collides` bodies resolve contact for real (resolveCrabCollisions) and
    // must not also take the soft shove — it acts at a wider radius than the
    // collision does, so it would hold them apart and the collision would
    // never fire.
    if (e.def.separates && !e.def.collides && e.trapTimer <= 0 && e.charmTimer <= 0) {
      const minGap = CONFIG.enemySeparation.gap;
      for (const other of enemies) {
        if (other === e || !other.def.separates) continue;
        const sx = e.mesh.position.x - other.mesh.position.x;
        const sy = e.mesh.position.y - other.mesh.position.y;
        const want = (e.radius + other.radius) * minGap;
        const d2 = sx * sx + sy * sy;
        if (d2 > want * want || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = (want - d) / want * CONFIG.enemySeparation.strength;
        e.vx += (sx / d) * push * dt * 60;
        e.vy += (sy / d) * push * dt * 60;
      }
    }

    // Trapped (the beluga's bubble, Bakalar's net) or charmed (the dumbo
    // octopus) — frozen in place, harmless, skips its normal behavior entirely
    // until the timer runs out. Both timers tick every frame regardless of
    // which one is holding it, so overlapping sources each expire on their own
    // schedule instead of one masking the other.
    if (e.charmTimer > 0) e.charmTimer = Math.max(0, e.charmTimer - dt);
    if (e.trapTimer > 0 || e.charmTimer > 0) {
      if (e.trapTimer > 0) e.trapTimer = Math.max(0, e.trapTimer - dt);
      e.vx = 0;
      e.vy = 0;
    } else {
      (BEHAVIORS[e.def.behavior] ?? BEHAVIORS.chase)(e, dt, ctx);
      // Crawlers fall. Nothing else in the game does — everything else swims,
      // and a swimmer's steering IS its vertical position. A crab's isn't: it
      // can now be shoved up onto another crab's back (see
      // resolveCrabCollisions), and without a pull back down it would simply
      // stay up there in open water. Gravity is what makes a stack a stack
      // rather than a set of floating bodies: it collapses the moment the
      // thing underneath moves out.
      //
      // Applied after the behavior so it adds to whatever the steering asked
      // for, and integrated by the shared step below like any other velocity.
      if (e.def.behavior === 'crawl') e.vy -= (CONFIG.crabPhysics?.gravity ?? 0) * dt;
    }

    // Snap at the player. Runs AFTER the behavior so `e.hunting` is this
    // frame's answer — a hunter that has broken off for a fish bites the
    // fish (systems/predation.js handles that half) rather than snapping at
    // a player it isn't even facing.
    //
    // This is presentation and pressure, not a new damage source: contact
    // damage stays the per-second drain resolveCombat has always applied.
    // Without it there is nothing on screen that distinguishes an animal
    // eating you from one drifting through you.
    if (e.def.hunt && !e.hunting && e.biteCooldown <= 0) {
      const reach = playerBiteReach(e) * (CONFIG.bite.lead ?? 1);
      if (ctx.dist < reach) triggerBite(e);
    }

    // CHILL scales the STEP, not the steering. Applied at the integrator so it
    // reaches every behaviour at once — chase, flock, crawl, porpoise — without
    // each having to know the element exists, and so a chilled hunter still
    // turns to face you at full rate while crawling toward you at a fraction of
    // its speed. Slowing the steering instead would read as a fish that had
    // lost interest, which is a different feeling entirely.
    const chill = e.chillTimer > 0 ? 1 - e.chillSlow : 1;
    e.mesh.position.x += e.vx * chill * dt;
    e.mesh.position.y += e.vy * chill * dt;
    // `canBreach` creatures are allowed above the water line — the porpoise
    // arc IS the jump, and clamping here would flatten it against the
    // surface. They still get the horizontal/floor limits below.
    if (e.entering) {
      // Still walking on from the wings: vertical limits only. Once it is
      // fully inside the walls it becomes a normal, boxed-in creature — and
      // because the flag only ever clears, it can't slip back out later.
      clampVertical(e.mesh.position, e.radius);
      if (e.mesh.position.x > bounds.left + e.radius && e.mesh.position.x < bounds.right - e.radius) {
        e.entering = false;
      }
    } else if (e.def.canBreach) {
      const r = e.radius;
      if (e.mesh.position.y < bounds.bottom + r) e.mesh.position.y = bounds.bottom + r;
      if (e.mesh.position.x < bounds.left + r) e.mesh.position.x = bounds.left + r;
      if (e.mesh.position.x > bounds.right - r) e.mesh.position.x = bounds.right - r;
    } else {
      clampBelowSurface(e.mesh.position, e.radius);
    }

    // Seabed dwellers never rise more than a short hop above the floor,
    // regardless of how the chase steering above pulled them — UNLESS they are
    // standing on something. `groundHeight` is a limit on how high a crab may
    // walk under its own power; it was never meant to cap how high one can be
    // carried, and applied blindly it flattened every stack back into the
    // amble band the moment it formed.
    if (e.def.behavior === 'crawl') {
      const cp = CONFIG.crabPhysics ?? {};
      // What is holding this one up: another crab (written by
      // resolveCrabCollisions), the dead seal, or the sand.
      let support = Math.max(bounds.bottom + e.radius, e.supportY ?? -Infinity);
      // The corpse is a surface too. Only while the run is actually over —
      // during play the seal is something crabs walk INTO, not onto, and
      // standing on a swimming player would look like a bug in the collision.
      if (deathState.active && e.def.crawl?.corpse) {
        const sum = e.radius + (player.stats?.hitRadius ?? 0.5);
        const above = e.mesh.position.y - playerPos.y;
        if (Math.abs(e.mesh.position.x - playerPos.x) < sum * (cp.supportSpan ?? 0.85)
          && above > sum * (cp.corpseStackHeight ?? 0.45) * 0.5) {
          support = Math.max(support, playerPos.y + sum * (cp.corpseStackHeight ?? 0.45));
        }
      }

      const maxY = Math.max(bounds.bottom + (e.def.crawl?.groundHeight ?? 2.5), support);
      if (e.mesh.position.y > maxY) e.mesh.position.y = maxY;

      if (e.mesh.position.y < support) {
        // Climbed onto, rather than teleported onto. A support can appear a
        // half-body above a crab in one frame (the animal underneath walked
        // in), and snapping to it reads as a pop; easing up reads as scrambling
        // over. Falling is NOT eased — that half is gravity's job above.
        const rise = 1 - Math.exp(-(cp.supportRise ?? 9) * dt);
        e.mesh.position.y += (support - e.mesh.position.y) * rise;
        if (e.vy < 0) e.vy = 0; // landed: stop accumulating fall speed
      }
    }

    // Broadside to the camera, walking sideways — the crab treatment.
    //
    // A crab can't use faceMotion. Its walk cycle strides along the model's X
    // (measured: the walking crab's feet swing 16.2 along X against 4.8 along
    // Z) while its claws and face point along +Z. Getting the stride axis onto
    // the screen horizontal AND the face toward the camera would need the map
    // (+X,+Y,+Z) -> (-X,+Y,+Z), which is a reflection, not a rotation — so no
    // orientation exists that does both. Crab rigs in the wild tend to ship a
    // separate clip per direction for exactly this reason rather than expecting
    // one to be mirrored.
    //
    // So the body is pinned at a fixed heading — upright, front to camera,
    // never rolling — and the direction it walks is carried by the gait's
    // playback direction instead. `gaitTravel` is which way along model X the
    // authored cycle carries it, so multiplying by the sign of vx gives the
    // playback direction that makes the legs push the way the crab is going.
    if (e.def.faceCamera) {
      // Tumble from collisions rides ON TOP of the locked heading, springing
      // back to zero rather than being cleared. The crab is knocked askew and
      // rights itself over the next moment, which is what sells the hit —
      // snapping straight back would look like nothing happened.
      const cp = CONFIG.crabPhysics;
      if (e.tumble !== 0 || e.tumbleVel !== 0) {
        e.tumbleVel += -e.tumble * (cp?.rightingStiffness ?? 40) * dt;
        e.tumbleVel *= 1 - Math.min(1, (cp?.rightingDamping ?? 6) * dt);
        e.tumble += e.tumbleVel * dt;
        const maxLean = cp?.maxLean ?? 1.1;
        if (e.tumble > maxLean) { e.tumble = maxLean; e.tumbleVel = 0; }
        if (e.tumble < -maxLean) { e.tumble = -maxLean; e.tumbleVel = 0; }
        // Park it once the wobble is spent, so the spring stops costing
        // anything for the rest of the crab's life.
        if (Math.abs(e.tumble) < 1e-4 && Math.abs(e.tumbleVel) < 1e-3) {
          e.tumble = 0;
          e.tumbleVel = 0;
        }
      }
      // -90 degrees puts model +X on world +X, +Y up and +Z at the camera —
      // i.e. the identity pose — given the asset's forward:'+X', up:'+Y'.
      //
      // `restLean` and `restYaw` are this individual's own crooked stance,
      // rolled at spawn. The lean is added INSIDE the tumble spring's rest
      // point rather than after it, so a knock rights the crab back to its own
      // angle instead of to a shared vertical — a wave of crabs all snapping
      // to the exact same pose after a bump was half of why they read as one
      // repeated object.
      e.mesh.rotation.z = -Math.PI / 2 + (e.restLean ?? 0) + e.tumble;
      e.visual.rotation.y = e.restYaw ?? 0;
      if (Math.abs(e.vx) > 0.05) {
        e.gaitDir = Math.sign(e.vx) * (e.def.gaitTravel ?? 1);
        e.anim?.setPlaybackDirection(e.gaitDir);
      }
    } else if (e.def.faceMotion) {
      if (Math.hypot(e.vx, e.vy) > 0.05) {
        e.mesh.rotation.z = Math.atan2(e.vy, e.vx) - Math.PI / 2;
        if (CONFIG.view === 'side') e.visual.rotation.y = e.vx < 0 ? Math.PI : 0;
      }
    } else if (e.def.spin) {
      e.visual.rotation.z += dt * e.def.spin;
    }

    // Continuous idle/swim/boost state machine for anything that has one.
    if (CONFIG.animation.enabled && e.anim) {
      const speed = Math.hypot(e.vx, e.vy);

      // March to the music. One walk cycle spans a whole number of beats, so
      // the footfalls land on the grid the loop player already uses.
      //
      // A single fixed beat count would mean the legs cycle at one tempo no
      // matter how fast the crab is actually travelling — fine while it
      // ambles, obvious foot-sliding the moment it rushes at 2.5x. So the
      // beat count is chosen from the current speed and then QUANTISED to
      // musical subdivisions: a rushing crab double-times to half as many
      // beats per cycle, which is still exactly on the beat. Comparison is
      // done on log ratio because tempo distance is multiplicative — 1 vs 2
      // beats is the same musical jump as 2 vs 4.
      // Tuned in beats per STRIDE, not per clip loop, because clips disagree
      // wildly on how much walking they contain: the walking crab's 3.33s take
      // holds 5 strides, the animated crab's 0.83s clip holds 1 (both
      // measured off the foot bones). Syncing the loop itself would have put
      // one crab at 2.5 steps per beat and the other at one step every two
      // beats. `strides` converts to the per-loop figure the controller wants.
      const bs = e.def.beatSync;
      if (bs) {
        const per = bs.beatsPerStride ?? 1;
        const ref = bs.refSpeed ?? e.def.speed ?? 1;
        const want = per * (ref / Math.max(0.05, speed));
        const options = bs.subdivisions ?? [per * 2, per, per / 2, per / 4];
        let best = options[0];
        for (const o of options) {
          if (Math.abs(Math.log(o / want)) < Math.abs(Math.log(best / want))) best = o;
        }
        e.anim.setBeatSync(best * (bs.strides ?? 1));
        e.beatsPerStride = best;
      }

      e.anim.update(dt, stateForSpeed(speed), e.hitThisFrame);
      e.hitThisFrame = false;
    }

    // Head-look last, so it layers over the finished pose — the mixer clip,
    // the procedural wag and the bone springs have all written by now, and
    // this leans the head off whatever they left. It only ever touches the
    // bones in lookRig.head, which are disjoint from every spring chain (those
    // are tails and fins), so the two never fight over a bone.
    //
    // Suppressed while a one-shot is playing for the same reason the seal's
    // neck is: a death animation should play as authored, not with the corpse
    // still tracking its lunch.
    if (e.look) {
      e.look.update(dt, e.lookTarget, { suppressed: e.anim?.isPlayingOneShot() ?? false });
    }

    // Jaw last of all. It writes ONE bone, which is a child of the head chain
    // the look just posed and disjoint from every spring chain (those are
    // tails and fins), so nothing else this frame touches it. Called every
    // frame rather than only mid-bite: the driver's anti-ratchet needs to see
    // an untouched frame to know what pose it was handed. See systems/jaw.js.
    e.jaw?.update(dt);

    // --- the crab's pinch ---------------------------------------------------
    // After the animation controller, the head-look and the jaw, because it is
    // the last word on the arm: anim.update() resets the spring bones, writes
    // the walk clip and layers the impact springs, and the claw blends on top
    // of whatever that produced. Running it earlier means the mixer overwrites
    // the reach and nothing visible happens.
    //
    // Driven every frame rather than only mid-pinch — the IK weight has to
    // ease back OUT after a strike, and a driver that only ran while striking
    // would drop the arm on the frame the pinch ended.
    if (e.claw) {
      const pc = CONFIG.crabClaw;
      if (e.pinchTimer > 0) e.pinchTimer -= dt;

      // A crab does not pinch at a corpse. The death pile-on is the last thing
      // you watch, and a heap of crabs snapping at a body that cannot react
      // reads as them eating it — which is what the pile already says, more
      // quietly. Also skipped while trapped or charmed, for the same reason
      // combat.js skips those: a bubbled crab is frozen, harmless.
      const canPinch = !!pc?.enabled
        && !deathState.active
        && e.trapTimer <= 0
        && e.charmTimer <= 0;

      // COMMIT range is deliberately tighter than the range the pinch reaches
      // at. A crab that starts a windup at the exact edge plays the whole
      // 0.9s gesture at a player who has already drifted out of it.
      if (canPinch && e.pinchTimer <= 0 && !e.claw.isStriking()
        && ctx.dist < e.radius * (pc.commitRange ?? 2.1)) {
        if (e.claw.strike()) e.pinchTimer = pc.cooldown ?? 2.6;
      }

      // Aim at the player in the PLAY PLANE, not at their exact position: the
      // crab sits at its own depth (enemies.walkingCrab.depthSpread scatters
      // them in z) and reaching to that z would have the claw swipe in front
      // of or behind the seal rather than at it.
      _clawAim.set(playerPos.x, playerPos.y, 0);
      e.claw.update(dt, canPinch ? _clawAim : null);
      e.justPinched = e.claw.didConnect();
    }

    // Chewing. Applied here rather than inside the behavior so the actual
    // mutation of the pickups array happens once per crab per frame, at a
    // known point in the update, instead of from inside a steering function.
    //
    // One block for both feeders: a crab parked on an orb (`crawl.feed`) and a
    // shark swallowing one on the pass (`hunt.scavenge`) differ only in their
    // numbers, so they share the code and the config shape. See feedConfig.
    if (e.eating && e.chumTarget) {
      const f = feedConfig(e);
      const eatTime = Math.max(0.05, f?.eatTime ?? 2);
      // THE HOOVER. The orb is dragged into the mouth for the whole meal
      // instead of shrinking where it lies — without this, an animal eating
      // your chum looked exactly like chum despawning on its own. The mouth is
      // measured off the eater's radius, which already carries whatever size
      // multiplier the asset was built at, so this is right at any scale.
      const hv = f?.hoover;
      let suck = null;
      if (hv) {
        mouthPoint(e, hv, _mouth);
        suck = { x: _mouth.x, y: _mouth.y, z: e.mesh.position.z, rate: hv.pull ?? 6, dt };
      }
      const finished = bitePickup(scene, e.chumTarget, dt / eatTime, suck);
      if (hv && !finished) {
        // Crumbs coming off it, on a per-animal rate rather than per frame:
        // the emitter is tiny by design and a burst every frame from every
        // feeding crab is a haze, not a trickle.
        e.crumbTimer = (e.crumbTimer ?? 0) - dt;
        if (e.crumbTimer <= 0) {
          e.crumbTimer = 1 / Math.max(0.1, hv.crumbRate ?? 4);
          onChumHoover?.(e.chumTarget.mesh.position.x, e.chumTarget.mesh.position.y, e);
        }
      }
      if (finished) {
        onChumEaten?.(e.chumTarget.mesh.position.x, e.chumTarget.mesh.position.y, e);
        e.chumTarget = null;
        e.eating = false;
        e.chumTimer = 0; // free to pick the next orb immediately
        // A shark goes back on the hunt after a mouthful; a crab (no
        // `cooldown` in its feed block) carries straight on to the next orb.
        if (f?.cooldown) e.scavengeCooldown = f.cooldown;
      }
    }

    // Trap enemies: stationary, bite on a cooldown when the player is close,
    // playing their one-shot attack clip (if any) in sync with the hit.
    if (e.def.behavior === 'trap') {
      e.attackTimer -= dt;
      const t = e.def.trap ?? {};
      if (e.attackTimer <= 0 && ctx.dist < (t.range ?? 3)) {
        e.attackTimer = t.cooldown ?? 2;
        e.justAttacked = true;
        e.attackAction?.reset().play();
      } else {
        e.justAttacked = false;
      }
      e.attackMixer?.update(dt);
    }

    if (e.biteTimer > 0) e.biteTimer -= dt;
    // biteTimer above is the EAT cooldown (how soon this predator may swallow
    // another fish); biteCooldown is how soon it may open its mouth again.
    // Kept apart because a snap that misses still costs the animal a moment,
    // while an eat only happens on contact.
    if (e.biteCooldown > 0) e.biteCooldown -= dt;
    if (e.lungeTimer > 0) e.lungeTimer -= dt;

    // Hit pop: a quick scale punch so damage reads even in a crowd. Scales
    // the size the creature actually IS (spawn scale x however much it has
    // grown), so the punch is a relative bump rather than a jump to a fixed
    // absolute scale.
    if (e.flash > 0) {
      e.flash = Math.max(0, e.flash - dt);
      const t = e.flash / Math.max(CONFIG.fx.hitFlash, 0.0001);
      e.visual.scale.setScalar(e.spawnScale * e.baseScale * (1 + CONFIG.fx.hitPop * t));
    }

    const shoot = e.def.shoot;
    if (shoot) {
      e.fireTimer -= dt;
      if (e.fireTimer <= 0 && dist < shoot.range) {
        e.fireTimer = shoot.interval;
        spawnProjectile(scene, {
          origin: e.mesh.position,
          dir: new THREE.Vector2(ctx.dirX, ctx.dirY),
          faction: 'enemy',
          damage: e.shotDamage ?? shoot.damage,
          speed: shoot.speed,
          life: shoot.life,
          radius: shoot.radius,
          asset: shoot.asset,
          // The creature that fired it, so a hit on the player is filed
          // against the species rather than against "something shot me".
          source: e.type,
        });
      }
    }
  }
}

export function removeEnemy(scene, index) {
  const e = enemies[index];
  if (!e) return;
  scene.remove(e.mesh);
  enemies.splice(index, 1);
}
