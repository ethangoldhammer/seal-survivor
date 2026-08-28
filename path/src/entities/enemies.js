import * as THREE from 'three';
import { nearestFloatingCrew, crewPosition } from '../systems/crew.js';
import { CONFIG, difficultyRamp, xpToughnessMul, lateGameMul, enemyPaceMul } from '../config.js';
import { acquireVisual, releaseVisual } from '../assets.js';
import { spawnProjectile } from './projectiles.js';
import { bounds, clampBelowSurface, seabedTopY, SEABED_Z, WATER_FILL_Z } from '../arena.js';
import { shore, shoreOverscan } from '../systems/wallRocks.js';
import { nearestFloorPickup, bestChumTarget, refreshChumPiles, pickupAlive, bitePickup } from './pickups.js';
import { deathState } from '../systems/deathDive.js';
import { graveKeepOut, graveHasLanded } from '../systems/gravesite.js';
import { skyLight } from '../systems/daylight.js';
import { createAnimationController, stateForSpeed } from '../systems/animation.js';
import { createHeadLook } from '../systems/headLook.js';
import { faceSide } from '../systems/facing.js';
import { recordSpawn, SENTINEL_HP } from '../systems/playtest.js';
import { approachVector, assignFeedingSlots, crowdAvoid, pickStandoff } from '../systems/apexCrowd.js';
import { updateWaves, waveSpawn, resetWaves, lullEligible } from '../systems/waves.js';
import { inSpawnGroup, spawnGroupsOf } from '../enemyTable.js';
import { RigidBody, addBody, removeBody, wrapAngle } from '../systems/rigidBody.js';
import { attachHitShape, releaseHitShape } from '../systems/hitShape.js';
import {
  baitBalls, resetBaitBalls, updateBaitBallClock, openBaitBall, baitBallFor,
  updateBaitBalls, baitFlock, baitSeed, baitBallLedger,
} from '../systems/baitBall.js';
import { attachBaitShimmer, updateBaitShimmer, resetBaitShimmer } from '../systems/baitShimmer.js';

// Above this, a creature's hp means "invincible scenery" rather than a real
// pool anyone is meant to chew through (the sea turtle ships 1e9). Only the
// playtest pressure metric cares; combat treats it as an ordinary number.
//
// IMPORTED, not declared. This was its own `const UNKILLABLE_HP = 1e6` sitting
// alongside playtest.js's identical `SENTINEL_HP` — two constants for one line,
// which is one constant more than a line can have. They are the two halves of
// the same rule (this one drops the SPAWN, playtest.js drops the DAMAGE), so a
// change to either alone gives a creature that is scenery to the numerator and
// a real animal to the denominator, and every clear rate in the report comes
// out wrong with nothing to say why.
import { createJawDriver } from '../systems/jaw.js';
import { createClawDriver, pinchReach, clawSetting } from '../systems/crabClaw.js';
import { rollBiolumSkinVariant } from '../systems/biolumSkin.js';
import { setOutlineVariant } from '../systems/outlines.js';
import { tickDaze, dazeSpeedMul, dazeVeer } from '../systems/control.js';
import { player } from './player.js';

export const enemies = [];

let spawnTimer = 0;
let nextSchoolId = 1;

// THE HELD BREATH. Seconds for which nothing new may arrive, from any source.
// systems/boss.js sets this in the moments before a boss enters — the water
// going quiet is the loudest thing the game can do, and it is what turns the
// arrival from a spawn into an entrance.
//
// A COUNTDOWN AND NOT A FLAG, on purpose. A boolean would need something to
// remember to clear it, and the one thing in this file that reads it is the
// thing that empties the ocean: a hold left latched by a code path nobody
// thought about (a run reset mid-hush, a boss disabled in the tuner, an
// exception between the set and the clear) is a sea that quietly never refills
// again, with nothing on screen to say why. This expires on its own, and
// boss.js re-arms it every frame for as long as it actually wants it.
let spawnHold = 0;

// ---------------------------------------------------------------------------
// THE STRIKE, as the rest of the roster experiences it
// ---------------------------------------------------------------------------
//
// Two halves, and both live here rather than in systems/strike.js because both
// are things a CREATURE does: big bodies get shoved (applyKnockback), and small
// ones get out of the way (the fright term in `swarm`).
//
// Written in by main.js every frame instead of imported from the strike system,
// which would wire a cycle — strike.js already imports removeEnemy from this
// file. A plain setter also keeps the whole behaviour testable from Node: a
// harness can declare a strike anywhere it likes without a player, an input
// stack or a frame.
const strikeThreat = { active: false, x: 0, y: 0, dirX: 1, dirY: 0, power: 0, dashing: false };

/**
 * Tell the roster where the seal's strike is.
 *
 * @param t {active, x, y, dirX, dirY, power, dashing} — `power` is banked
 *   charge 0..1, `dashing` distinguishes a strike in flight from one being
 *   wound up (a wind-up frightens at `scare.chargeShare` of full strength).
 *   Pass nothing to clear it.
 */
export function setStrikeThreat(t = null) {
  strikeThreat.active = !!t?.active;
  if (!strikeThreat.active) return;
  strikeThreat.x = t.x ?? 0;
  strikeThreat.y = t.y ?? 0;
  strikeThreat.dirX = t.dirX ?? 0;
  strikeThreat.dirY = t.dirY ?? 0;
  strikeThreat.power = Math.min(1, Math.max(0, t.power ?? 0));
  strikeThreat.dashing = !!t.dashing;
}

/**
 * Shove a body. This is what a strike does instead of damage: an impulse held
 * SEPARATE from the creature's own velocity, because vx/vy is not a shared
 * channel — a turn-limited hunter assigns it outright every frame (see
 * steerTo), a flocking fish blends toward a boids sum, and a crab has gravity
 * added to it. Anything written into vx/vy is therefore erased before it can
 * move a shark an inch, which is exactly the bug this avoids: the knock is
 * added at the integrator instead, so it lands identically on all three.
 *
 * Divided by size, so the same ram that sends a minnow tumbling only leans on
 * a megalodon. `pivotRadius` is the body that takes it unmodified.
 *
 * @param e      the creature
 * @param dirX,dirY  unit direction to push along (the dash's heading)
 * @param power  banked charge of the strike, 0..1
 */
export function applyKnockback(e, dirX, dirY, power = 1) {
  const k = CONFIG.strike?.knockback ?? {};
  if (k.enabled === false || !e) return 0;

  const len = Math.hypot(dirX, dirY);
  if (len < 1e-6) return 0;

  const p = Math.min(1, Math.max(0, power));
  const scale = (k.powerMin ?? 0.45) + ((k.powerMax ?? 1.3) - (k.powerMin ?? 0.45)) * p;
  const pivot = Math.max(0.05, k.pivotRadius ?? 0.8);
  // HOW BIG THE ANIMAL IS, not how big its model was scaled to. Emphatically
  // NOT `e.radius`: that is the hitbox, and the hitbox deliberately carries the
  // tuner's per-asset Size slider (see spawnOne — a shark's asset alone is
  // 2.66x). Dividing by it made an art decision the loudest term in the
  // physics, and the giveaway is the hammerhead: authored BIGGER than the
  // shark (1.3 vs 1.2) but with no Size multiplier on its asset, so it was
  // shoved 2.4x FURTHER than the smaller animal. Nothing in the fiction or the
  // tuning asked for that.
  //
  // The authored radius times `sizeMul` instead — the run's growth times this
  // individual's own size roll, with the asset's scale factored out — so a
  // late-run shark and a big roll still resist more than a runt. That is the
  // same "is this a big one for its species" rule a rigid body's mass already
  // uses (see attachRigidBody), and `pivotRadius` is a number in that same
  // authored scale. Both being radii is what kept the mismatch invisible.
  const size = (e.def?.radius ?? e.radius ?? pivot) * (e.sizeMul ?? 1);
  const bk = k.boss ?? {};
  const onBoss = e.isBoss === true;
  // A BOSS MAY RESIST ON ITS OWN CURVE. The roster's authored sizes span 2.08
  // (a hammerhead) to 8.28 (a yacht), so at the shared exponent the lightest
  // boss is shoved exactly 4x the heaviest — inverse-linear in size, which is
  // the rule the whole function already runs on. A steeper exponent here is
  // how you widen that spread without touching what a ram does to a shark,
  // and it is the only thing in the boss block that changes the SHAPE of the
  // size response rather than its scale.
  const massExp = (onBoss ? bk.massExp : null) ?? k.massExp ?? 1;
  // Below pivot size everything takes the full shove — a minnow is not thrown
  // twice as far as a slightly bigger minnow, it is simply thrown.
  const mass = Math.max(1, size / pivot) ** massExp;
  const push = ((k.speed ?? 26) * scale) / mass;

  // A body takes it as a REAL impulse instead: it keeps the velocity (rather
  // than the decaying position offset below), it tumbles, it bounces off the
  // walls, and it can hand what it hits an impulse of its own. That is the
  // whole difference between a shark being shoved off its line and a turtle
  // being fired across the arena.
  //
  // It also gets its OWN launch speed rather than the size-divided push above.
  // That divisor exists to stop big creatures being thrown around, and this is
  // a big creature that is entirely meant to be — run through the same formula
  // a turtle would come off a full-charge strike at walking pace.
  if (e.body) {
    const profile = CONFIG.physics?.[e.body.kind] ?? {};
    const launch = (profile.strikeImpulse ?? 30) * scale;
    // WHERE ALONG THE SHELL IT CAUGHT. The impulse itself is along the dash,
    // so a contact point on that same line has no lever arm and produces no
    // roll at all — the turtle would fly dead flat. The seal does not arrive
    // perfectly on centre, so the contact is offset across the shell, and how
    // far off-centre it caught is what decides which way and how hard it goes
    // end over end.
    const r = e.body.radius;
    const off = (Math.random() * 2 - 1) * r;
    // A fixed impulse rather than a fixed speed, so SIZE RESISTS: `launch` is
    // what a nominal one leaves at, and a boulder of a turtle leaves at less
    // in proportion to its mass. Capped at the nominal mass on the way down
    // for the same reason the creature knock has a `pivotRadius` — below the
    // standard size a body is simply thrown, rather than a runt being fired
    // off at six times the speed of anything else in the ocean.
    const impulse = launch * Math.min(e.body.mass, profile.mass ?? e.body.mass);
    e.body.applyImpulse(
      (dirX / len) * impulse,
      (dirY / len) * impulse,
      e.mesh.position.x - (dirX / len) * r - (dirY / len) * off,
      e.mesh.position.y - (dirY / len) * r + (dirX / len) * off,
    );
    if (e.anim?.impulse) {
      const kick = (k.boneImpulse ?? 2.6) * scale;
      if (kick > 0) {
        _bump.set(dirX / len, dirY / len, 0);
        e.anim.impulse(_bump, kick);
      }
    }
    return launch;
  }

  // IT LIVED, AND IT IS BIG. See CONFIG.strike.knockback.heavy: the size
  // divisor above is written for the schools, and on a shark it left a shove
  // smaller than one stroke of the animal's own swimming. A body over the
  // pivot that is still alive gets the hit at its proper scale instead —
  // harder, carrying further, and staggered so its own propulsion stops
  // erasing it. `e.hp` is already down to what the strike left it at by the
  // time this is called, which is what makes "survived" answerable here.
  //
  // Not a boss: a boss is shoved on its own terms one branch down, because the
  // half of this that matters there is the DISPLACEMENT and not the stagger —
  // a boss owns what a hold does to it (CONFIG.boss.control.daze) and a ram is
  // not allowed to open that door round the back.
  const hv = k.heavy ?? {};
  const heavy = hv.enabled !== false
    && e.hp > 0
    && !onBoss
    && size >= (hv.minRadius ?? pivot);

  // A BOSS IS MOVED BY A RAM. See CONFIG.strike.knockback.boss. The size
  // divisor alone left every boss with a shove under one part in ten of its
  // own body radius — a yacht travelled a quarter of a unit at full charge —
  // which is a rule that technically applied and could not be seen, and it
  // read in the fight as the one creature in the water the seal bounces off.
  //
  // Its own multiplier rather than the heavy one, because the two are aiming
  // at different pictures: a rammed shark is THROWN off its line, and a
  // rammed boss is leaned on. It keeps the size divisor above either way, so
  // this stays inverse in size across the whole roster — the hammerhead gives
  // ground and the yacht barely notices.
  //
  // No stagger and no heading kick by default (see the block below): those are
  // the parts of the heavy knock that cost a body its TURN, and on a boss that
  // is the daze's job, on the daze's budget and behind the daze's cooldown.
  const bossKnock = onBoss && bk.enabled !== false && e.hp > 0;

  const boost = bossKnock ? (bk.speedMul ?? 2.5) : heavy ? (hv.speedMul ?? 1.7) : 1;
  e.knockX = (e.knockX ?? 0) + (dirX / len) * push * boost;
  e.knockY = (e.knockY ?? 0) + (dirY / len) * push * boost;
  // Per-body, because the decays are different journeys: an ordinary knock is
  // over in a fifth of a second and a heavy one is a throw. Read by the
  // integrator, so the last hit a body took owns its falloff.
  e.knockDecay = bossKnock ? (bk.decay ?? 6) : heavy ? (hv.decay ?? 9) : (k.decay ?? 12);

  if (bossKnock) {
    // BOTH OFF BY DEFAULT, and kept as dials rather than deleted because
    // "a ram staggers a boss a little" is a legitimate thing to want to try —
    // but it must be tried deliberately, at a number someone chose, and never
    // arrive as a side effect of the shove being turned on.
    //
    // The stagger is skipped outright while a perk is DRIVING the body, the
    // same exemption dazeSpeedMul makes: a scripted charge that can be damped
    // by ramming it is a wind-up the player can refuse for free, which is the
    // exact thing the daze's cooldown exists to prevent.
    const secs = (bk.stagger ?? 0) * scale;
    if (secs > 0 && !e.perkDrive && secs > (e.staggerTimer ?? 0)) {
      e.staggerTimer = secs;
      e.staggerFor = secs;
    }
    const kick = (bk.headingKick ?? 0) * scale;
    if (kick > 0 && e.heading != null) {
      const want = Math.atan2(dirY / len, dirX / len);
      const off = wrapAngle(want - e.heading);
      e.heading += Math.max(-kick, Math.min(kick, off));
    }
  } else if (heavy) {
    // Scaled by charge like everything else the strike does, and taken as the
    // LONGER of what it already had rather than added: two dashes through the
    // same shark stagger it twice, they do not hold it still for a second.
    const secs = (hv.stagger ?? 0.45) * scale;
    if (secs > (e.staggerTimer ?? 0)) {
      e.staggerTimer = secs;
      e.staggerFor = secs;
    }
    // AND ITS AIM. A turn-limited hunter re-derives vx/vy from `heading` every
    // frame, so a shove that only moved it arrived with the animal still
    // pointed exactly where it was — see steerTo. Pushing the heading toward
    // the dash costs it the line it was on, and its own turnRate is what buys
    // that back, which is the tug of war the daze already uses.
    const kick = (hv.headingKick ?? 0) * scale;
    if (kick > 0 && e.heading != null) {
      const want = Math.atan2(dirY / len, dirX / len);
      const off = wrapAngle(want - e.heading);
      e.heading += Math.max(-kick, Math.min(kick, off));
    }
  }

  // The two dressings a body already has for being hit: the skeleton flinch
  // every creature carries, and the tumble that only bodies which roll (crabs)
  // do anything with. Both scaled by the same shove, so a flick and a
  // full-commitment ram don't look alike.
  const kick = (k.boneImpulse ?? 2.6) * scale;
  if (kick > 0 && e.anim?.impulse) {
    _bump.set(dirX / len, dirY / len, 0);
    e.anim.impulse(_bump, kick);
  }
  // Only bodies that ROLL. `tumble` is read exactly once, under `faceCamera`
  // (the crabs) — everything else has its rotation assigned from its velocity
  // every frame, so spinning a shark here would accumulate a number that is
  // overwritten before it can be seen and never spent.
  if (e.def?.faceCamera) {
    e.tumbleVel = (e.tumbleVel ?? 0) + (k.spin ?? 5) * scale * (Math.random() < 0.5 ? -1 : 1);
  }
  // What was actually imparted, boost and all — callers price feedback off it.
  return push * boost;
}

// The speed above which a simulated creature counts as LAUNCHED rather than
// swimming. Read off its own profile so a heavier body could be given a lower
// bar without the integrator knowing which creature it is holding.
function launchSpeed(e) {
  return CONFIG.physics?.[e.body.kind]?.launchSpeed ?? 4;
}

/**
 * A flying body barging through a crowd. Every creature it passes takes the
 * turtle's own heading as a shove and nothing else — no damage, ever, so a
 * punt can never turn into a stealth weapon that the upgrade balance has not
 * accounted for.
 *
 * Once per victim per launch, tracked in a WeakSet on the flying body: the
 * alternative is an impulse every frame of contact, which at 60fps stacks into
 * a shove an order of magnitude larger than the one that started it. The set
 * is dropped when the body settles, so the next punt hits the same crowd
 * again.
 */
function plowThrough(e, dt) {
  const power = CONFIG.physics?.[e.body.kind]?.plow ?? 0;
  if (power <= 0) return;
  const speed = e.body.speed();
  if (speed < 1e-3) return;
  const dx = e.body.vx / speed;
  const dy = e.body.vy / speed;
  const hit = e.plowed ?? (e.plowed = new WeakSet());

  for (const other of enemies) {
    // Never another simulated body: those meet properly in the solver, with
    // both masses and a real bounce, and shoving one here as well would count
    // the same collision twice.
    if (other === e || other.body) continue;
    if (hit.has(other)) continue;
    const sum = e.radius + other.radius;
    const ox = other.mesh.position.x - e.mesh.position.x;
    const oy = other.mesh.position.y - e.mesh.position.y;
    if (ox * ox + oy * oy > sum * sum) continue;
    hit.add(other);
    applyKnockback(other, dx, dy, power);
  }
}

export function resetEnemies(scene) {
  spawnLevel = 1;
  for (const e of enemies) {
    if (e.body) removeBody(e.body);
    // Same as removeEnemy: a run ending is the biggest single handover there
    // is, and the next run opens by spawning the same species back out again.
    releaseVisual(e.visual);
    scene.remove(e.mesh);
  }
  enemies.length = 0;
  spawnTimer = 0;
  nextSchoolId = 1;
  spawnHold = 0;
  // Spawner state like the two above it: a new run's first boss should get the
  // full `firstDelay` before its water starts filling, not whatever was left
  // on the clock when the last run ended.
  bossSchoolTimer = 0;
  // Same again for the bait balls: their clock, and the anchors of anything
  // still swirling when the run ended. Nothing here removes a fish — the loop
  // above already emptied the enemy list — this is only the geometry those
  // fish were orbiting, which would otherwise be handed to the next run's
  // first school to reuse by schoolId.
  resetBaitBalls();
  resetBaitShimmer();
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
//
// `turnLimit` is an optional ceiling BELOW the creature's own turnRate, for a
// caller that wants a gentler correction than the body is capable of — see the
// cruise-hunt block below. Null means "spend whatever you have".
function steerTo(e, dx, dy, dt, responsiveness = 6, speedMul = 1, turnLimit = null) {
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const tvx = (dx / len) * e.speed * speedMul;
  const tvy = (dy / len) * e.speed * speedMul;

  // e.turnRate is the per-instance value baked at spawn (the species' own
  // turnRate times whatever CONFIG.hunterRamp has added by then); e.def is the
  // fallback for creatures spawned before that field existed.
  let turnRate = e.turnRate ?? e.def.turnRate;
  // A budget INSIDE turnRate, never a way around it: a creature with no turn
  // limit of its own keeps the velocity-lerp branch below, because giving it
  // one here would silently change how every non-shark steers.
  if (turnRate && turnLimit != null) turnRate = Math.min(turnRate, turnLimit);
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
// missing block) opts a creature out entirely, which is how the dolphin keeps
// the free movement its behaviour is built on. It is also the flag CONFIG
// .cruiseHunt reads to decide who is a cruise hunter — see trackTurn.
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

/**
 * THE IDLE CRUISE: swim on, weave, and pick a new shallow heading now and then.
 *
 * Its own function rather than the tail of `hunt` because it is now reached
 * two ways. A hunter with nothing in mind falls in here as it always did — and
 * so does a CRUISE HUNTER that wants something outside its cone (see
 * trackTurn), which is the whole trick: instead of pivoting after a fish that
 * has slipped past its flank, the shark holds its line, keeps its weave, and
 * comes back round on its own arc.
 *
 * The wander angle used to be uniformly random, and that was the single
 * biggest source of vertical wandering in the game: a shark was as likely to
 * head straight up as along the reef, and steerTo drives at full speed along
 * the heading, so "up" meant a body-length a second of climb for no reason.
 * `wanderPitch` keeps the choice and confines it to a shallow cone either side
 * of horizontal.
 *
 * @param opts.look false leaves the look target alone, so a shark cruising past
 *                  something it decided not to turn for is still watching it —
 *                  the head-look and the jaw are unchanged by any of this.
 * @param opts.swim false skips updateSwim, for a caller that has already ticked
 *                  the climb gain against a real target this frame. Ticking it
 *                  twice would hand the second call `null` and drag the gain
 *                  back to the floor while the shark is still engaged.
 *
 * `speedMul` DEFAULTS TO 1 and the idle caller leaves it there on purpose. It
 * is the lunge burst (CONFIG.bite.lunge), and the idle cruise has never carried
 * it — a shark with nothing in mind is not mid-bite, whatever its lunge timer
 * still says. Passing it here by accident during the extraction moved the
 * megalodon's approach shape enough to fail tools/shark-swim-test.mjs about
 * one run in three, which is what that flake was. The fall-through callers DO
 * pass it: they are inside a pursuit branch that always applied it.
 */
function cruiseOn(e, dt, h, lat, speedMul = 1, opts = {}) {
  const px = e.mesh.position.x;
  const py = e.mesh.position.y;

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

  if (opts.swim !== false) updateSwim(e, dt, null, lat);

  if (opts.look !== false) {
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
  }

  const go = shapeSwim(e, Math.cos(e.wanderAngle), Math.sin(e.wanderAngle), lat);
  steerTo(e, go.x, go.y, dt, 6, speedMul);
}

// ---------------------------------------------------------------------------
// CRUISE HUNT — a shark does not chase. See CONFIG.cruiseHunt for the whole
// argument; this is the mechanism.
//
// Two functions. `cruiseHunter` decides whether a creature is one of these at
// all, and `trackTurn` answers the only question the behaviour asks per frame:
// how much of my turning is this thing worth right now?
// ---------------------------------------------------------------------------

// The wildlife sharks. They opt in by declaring `hunt.lateral` — the same
// block that gates the rest of the cruise shaping, and the same set — and a
// boss opts back out with `lateral.cruise: false`, because a boss that made
// lazy passes would be a fight you could ignore.
//
// The DECLARATION is what decides, not `e.isBoss`, which is a live flag set
// after spawn by systems/boss.js and cleared again in windows where a boss
// body is still in the water (see the note on isBossDef there). isBoss is kept
// as the second half of the test anyway: it is the net under a new boss whose
// author forgot the flag, and the two can only disagree in those windows,
// where the answer does not matter. Asking boss.js directly is not an option —
// it imports this module.
function cruiseHunter(e) {
  const lat = e.def.hunt?.lateral;
  return CONFIG.cruiseHunt?.enabled === true
    && lat != null
    && lat.cruise !== false
    && e.isBoss !== true;
}

/**
 * The turn rate this hunter may spend steering at (dx, dy) this frame.
 *
 *   null  no limit — not a cruise hunter, steer as hunters always did.
 *   >0    turn, but only this fast.
 *   0     don't turn for it at all: it is outside the forward cone, so the
 *         caller should keep cruising and come back round on its own arc.
 *
 * `player` picks the looser of the two budgets — see CONFIG.cruiseHunt for why
 * the seal is worth more of a shark's attention than a minnow is.
 */
function trackTurn(e, dx, dy, player = false) {
  if (!cruiseHunter(e)) return null;
  const cfg = CONFIG.cruiseHunt;
  const rate = (player ? cfg.playerTrackRate : cfg.trackRate) ?? 0.5;
  const cone = (player ? cfg.playerTrackCone : cfg.trackCone) ?? 1.15;
  // Measured off `heading`, which is the field the turn-limited branch of
  // steerTo actually integrates — reading it off the velocity instead would
  // disagree with it by a frame mid-lunge and make the cone flicker.
  let diff = Math.atan2(dy, dx) - (e.heading ?? 0);
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return Math.abs(diff) > cone ? 0 : rate;
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
    };
  }
  // Only the tagged bodies queue for a feeding slot. Everything else that
  // hunts still steers around them, but closes as it always did — and so does
  // a cruise hunter, which opts out of the ring on purpose (CONFIG.cruiseHunt
  // .standoffRing): its correction is already too small to converge on a
  // point, so the ring only ever added a second circle to something already
  // circling. The crowd AVOIDANCE, which is what actually keeps bodies apart,
  // is a separate term and is unaffected either way.
  //
  // Recomputed every frame rather than baked into the view above, for the same
  // reason spawnGroupsOf refuses to cache: both inputs are LIVE. `spawnGroup`
  // is rewritten in place whenever enemies.csv is re-applied, and the cruise
  // gate reads a CONFIG block with sliders on it — a value cached at spawn
  // would leave every creature already in the water answering for the previous
  // file, which is the worst possible behaviour for a knob you tune by feel
  // while the game is running. Two property reads and a string compare with a
  // fast path, for at most `groupMaxAlive.apex` bodies.
  v.inCrowd = inSpawnGroup(e.def, 'apex')
    && !(cruiseHunter(e) && CONFIG.cruiseHunt?.standoffRing === false);
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
    // The tag is the contract: `spawnGroup` carrying 'apex' is already what
    // the population cap uses to mean "big body competing for the same
    // screen", and it's the same set that should be competing for the same
    // player. A creature may carry more than one group (the sharks are
    // "apex shark"), so this asks for membership rather than equality.
    if (!inSpawnGroup(e.def, 'apex')) continue;
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

// ---------------------------------------------------------------------------
// THE BURST CHASE — a slow cruise punctuated by one committed run.
//
// A modifier on `chase` rather than a `behavior` of its own, and that is a
// deliberate choice about WHERE THE SWITCH LIVES. `behavior` is a string in
// config.js, and config.js is merged UNDER imported-tuning.json — every
// snapshot ever saved carries `enemies.sailfish.behavior: 'chase'`, so a new
// name typed here would be silently overwritten on every load and the creature
// would go on plain-chasing while the code said otherwise. A nested block the
// snapshots have never seen cannot be shadowed: a def carrying `lunge` bursts,
// one without it chases exactly as before.
//
// The shape is the anglerfish's (systems/bossAngler.js), scaled down from an
// ambush to a pass and made per-instance:
//
//   cruise   Slow — the whole point. It closes at a speed the seal can simply
//            swim away from, which is what makes the burst mean anything.
//   wind     Inside `range`, it gathers: throttles back and turns hard onto
//            you. This is the tell, and the only warning there is.
//   strike   The line LOCKS at the end of the wind-up and it commits, at
//            `speedMul` times cruise with `strikeTurnRate` of correction —
//            enough to punish standing still, nowhere near enough to follow a
//            player who moved. A homing lunge is not a lunge, it is a fast
//            chase with extra steps.
//   rest     It carries the overshoot, veering off the side the player ISN'T
//            on, and cannot strike again for `cooldown`. The gap is the
//            creature: without it a burst chase is just a chase whose speed
//            flickers.
//
// The exit from `strike` is a CLOCK, never "hit or died" — a turn-limited body
// aimed at a moving target orbits it forever otherwise, which is the trap
// documented on `turnRate` in the roster.
//
// `e.lungeStage` / `e.lungeClock` are rolled on first update rather than at
// spawn, like `glideY` above. `e.lungeTimer` is a DIFFERENT and unrelated
// thing — the jaws' burst window in CONFIG.bite.lunge.
//
// ---------------------------------------------------------------------------
// TWO CALLERS, AND `ownCruise` IS WHICH ONE.
// ---------------------------------------------------------------------------
// `chase` (the sailfish) has nothing else to do, so the lunge is its ENTIRE
// behaviour: it steers on every frame, including the slow closing cruise and
// the backing-off when it finds itself too close to have a wind-up left. That
// is `ownCruise: true`, which is the default and is exactly what shipped.
//
// `hunt` (the sharks and the four chasing bosses) already has five branches, a
// standoff distance, crowd avoidance, a vertical-authority ramp and a weave —
// none of which the lunge knows about or should. So it is called there as an
// OVERLAY with `ownCruise: false`, and the contract is the return value: TRUE
// means this call has written the velocity for this frame and the caller must
// not, FALSE means nothing was written and the host behaviour steers as it
// always did.
//
// Only the two COMMITTED stages ever return true under the overlay. The
// wind-up and the strike are the lunge; the cruise and the rest are a clock
// ticking, and a hunter that handed those over as well would lose its cruise
// shaping for two thirds of every cycle — which is most of what a shark looks
// like.
//
// @param ownCruise  false to run as an overlay; see above.
// @returns whether this call owns the creature's velocity this frame.
function lungeChase(e, dt, ctx, ownCruise = true) {
  const c = e.def.lunge ?? {};

  if (e.lungeStage == null) {
    // Staggered, not zeroed. These arrive in twos and threes from the same
    // spawn tick, so a shared clock would have the whole group wind up on the
    // same frame for the rest of its life — one animal with two bodies. A
    // random part of a cooldown spent before the first strike is the cheapest
    // way to make them individuals.
    e.lungeStage = 'rest';
    e.lungeClock = (c.cooldown ?? 3.2) * Math.random();
  }
  e.lungeClock = Math.max(0, (e.lungeClock ?? 0) - dt);

  // --- STRIKE ---------------------------------------------------------------
  // Velocity written from the heading rather than through steerTo, because
  // steerTo's turn limit is a MINIMUM against the creature's own turnRate and
  // collapses to the unlimited velocity-lerp branch on a def that has none.
  // The commitment is the whole effect, so it does not get to depend on a
  // field the CSV can blank.
  if (e.lungeStage === 'strike') {
    e.animState = 'boost';
    let diff = Math.atan2(ctx.dirY, ctx.dirX) - e.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const rate = c.strikeTurnRate ?? 0.5;
    e.heading += Math.min(Math.abs(diff), rate * dt) * Math.sign(diff);
    // e.heading, not just vx/vy: every steerTo the moment this ends re-derives
    // the velocity from it, so a heading left where the wind-up put it would
    // teleport the fish's course back a second into the past.
    const speed = e.speed * (c.speedMul ?? 3.6);
    e.vx = Math.cos(e.heading) * speed;
    e.vy = Math.sin(e.heading) * speed;
    if (e.lungeClock <= 0) {
      e.lungeStage = 'rest';
      e.lungeClock = c.cooldown ?? 3.2;
      // Off the side the player is NOT on, so the pass opens a gap whether it
      // connected or whiffed. Steered toward rather than snapped to — the arc
      // out is as much of the shape as the arc in.
      e.lungeVeer = e.heading - Math.sign(diff || 1) * (c.veerSwing ?? 0.9);
    }
    return true;
  }

  // --- WIND-UP --------------------------------------------------------------
  if (e.lungeStage === 'wind') {
    // Throttled back but NOT stopped. `faceMotion` takes this creature's
    // facing from its velocity and gives up below 0.05, so a billfish that
    // hovered would hold whatever heading it arrived on and then launch along
    // a line it never visibly aimed — the tell has to be a turn you can watch.
    //
    // `animState` is written rather than left to stateForSpeed for the same
    // reason it exists at all: the throttled speed lands a hair either side of
    // animation.moveThreshold depending on this individual's speedVariance
    // roll, and a wind-up that flickers between the swim and idle takes is the
    // one second of this creature the player has to be able to read.
    e.animState = 'swim';
    steerTo(e, ctx.dirX, ctx.dirY, dt, 6, c.windSpeedMul ?? 0.4);
    if (e.lungeClock <= 0) {
      e.lungeStage = 'strike';
      e.lungeClock = c.strikeTime ?? 0.8;
      e.animState = 'boost';
    }
    return true;
  }

  e.animState = null;

  // --- REST -----------------------------------------------------------------
  if (e.lungeStage === 'rest') {
    // The peel-off is the sailfish's to steer and the hunter's to ignore: a
    // shark coming out of a pass already has a cruise, a standoff and a crowd
    // to swim around, and overriding all three with a fixed heading for three
    // seconds would put the whole point of `hunt` on a timer.
    if (ownCruise) {
      if (e.lungeVeer != null) steerTo(e, Math.cos(e.lungeVeer), Math.sin(e.lungeVeer), dt, 6);
      else steerTo(e, ctx.dirX, ctx.dirY, dt, 10);
    }
    if (e.lungeClock <= 0) {
      e.lungeStage = 'cruise';
      e.lungeVeer = null;
    }
    return ownCruise;
  }

  // --- CRUISE ---------------------------------------------------------------
  //
  // `minRange` is not a taste knob: the wind-up is the only warning there is,
  // and one that starts from inside the length of the strike is one the player
  // cannot use. So the gate has a floor as well as a ceiling — and a fish that
  // finds itself under the floor MAKES ROOM rather than milling around inside
  // it. Without that half a turn-limited body that keeps steering at something
  // it is already on top of orbits it at its own turning circle forever, and
  // the gate never opens again.
  const range = c.range ?? 12;
  if (ctx.dist < (c.minRange ?? 6)) {
    // A hunter does NOT back off here, and does not need to: `hunt` already
    // holds a standoff distance of its own (see pickStandoff / approachVector),
    // so the gap this floor is waiting for opens by itself. Backing off as well
    // would be two systems steering the same body apart on the same frame.
    if (!ownCruise) return false;
    steerTo(e, -ctx.dirX, -ctx.dirY, dt, 6);
    return true;
  }
  if (ownCruise) steerTo(e, ctx.dirX, ctx.dirY, dt, 10);
  if (ctx.dist <= range) {
    e.lungeStage = 'wind';
    e.lungeClock = c.windup ?? 0.45;
  }
  // The wind-up starts on the NEXT frame either way. That matters to the
  // overlay: returning true here would hand back a frame in which nothing was
  // written, and the creature would coast through it.
  return ownCruise;
}

const BEHAVIORS = {
  chase(e, dt, ctx) {
    // A def carrying a `lunge` block chases in bursts instead — see
    // lungeChase, and the note there for why this is a block on the def
    // rather than a `behavior` of its own.
    if (e.def.lunge) { lungeChase(e, dt, ctx); return; }
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
      // A BAIT BALL SKIPS COHESION AND ALIGNMENT, and takes only the
      // separation below. Both of those terms are already being done better by
      // the ball itself: the shell spring is cohesion aimed at a RING instead
      // of a point, and the swirl aligns every fish in the knot by
      // construction. Left in, they fight it — cohesion pulls toward the
      // centroid the shell is pushing away from, and the two settle at a
      // radius neither number describes, which is a ball that quietly ignores
      // its own `radius` setting.
      if (n > 0 && !e.baitBall) {
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
      // NO SEPARATION INSIDE A BALL. Its fish are on evenly-spaced slots
      // around the column (see baitSlot), so the spacing is solved before the
      // frame starts — and a repulsion term on top of a solved spacing does
      // not tidy it, it fights it: every fish is pushed off the slot it was
      // placed on, the ring swells past the `radius` it is supposed to hold,
      // and the even wall the formation depends on develops the gaps it exists
      // to prevent. Measured at the schools' own value, a dozen fish settled
      // 65% wide of the configured shell.
      if (!e.baitBall) {
        ax += sx * (sw.separation ?? 0);
        ay += sy * (sw.separation ?? 0);
      }
    }

    // Per instance, not off the def: this is the one term in the boids that
    // points at the seal, and it grows with the run so a late school hunts
    // rather than mills. `e.towardPlayer` is baked at spawn — see spawnOne and
    // CONFIG.hunterRamp.swarmSeek. The `??` keeps a hand-built fish (the
    // harnesses in tools/ make them) steering the way it always did.
    // A BAIT BALL DOES NOT COME FOR YOU, and that is the entire difference
    // between it and every other school in the game. An ordinary shoal drifts
    // at the seal (and drifts harder as the run goes on — see
    // CONFIG.hunterRamp.swarmSeek), which makes it food that delivers itself.
    // A ball mills where it is, so it is food you have to go and get, and
    // going to get it is the decision the whole feature is built on.
    //
    // Falls back to the ordinary seek if the ball has ended under it — the
    // survivors of a dispersed ball are ordinary fish again, and this is the
    // frame they find out. (updateBaitBalls clears `baitBall` on those fish
    // too; this is the belt to that braces.)
    const ball = e.baitBall ? baitBallFor(e.schoolId) : null;
    let ballSpeed = 0;
    let ballFlat = 1;
    if (ball && ball.views) {
      // THE FLOCK, IN THREE DIMENSIONS. Separation, alignment and cohesion
      // among ballmates, plus a vortex about the vertical and a soft wall — see
      // baitFlock, which owns all of it and none of this module's types.
      //
      // The views are built once per ball per frame in updateEnemies, not here:
      // this runs per FISH, and each one needs every other one's position, so
      // rebuilding the list inside the loop is the same O(n²) work done n times
      // over.
      //
      // The heading comes back as a unit vector in x/y/z. Its horizontal part
      // is fed to steerTo like any other behaviour — which is what keeps the
      // facing, the animation state and the flee and strike-panic terms below
      // all working exactly as they do for an ordinary school — and its
      // vertical-to-camera part is integrated separately, just below.
      e.ballView.x = px;
      e.ballView.y = py;
      e.ballView.z = e.mesh.position.z - (e.laneZ ?? 0);
      e.ballView.vx = e.vx;
      e.ballView.vy = e.vy;
      e.ballView.vz = e.vz;
      const f = baitFlock(e.ballView, ball.views, ball);
      ax += f.x * (sw.responsiveness ?? 4);
      ay += f.y * (sw.responsiveness ?? 4);
      // Depth is the one axis nothing else in the game steers on, so it is
      // integrated here rather than routed through steerTo. Same lerp shape, so
      // a fish turns through depth at the same rate it turns across the screen.
      const wantVz = f.z * f.speed;
      e.vz += (wantVz - e.vz) * Math.min(1, (sw.responsiveness ?? 4) * dt);
      // The depth cue, stored rather than applied — the scale write in
      // updateEnemies folds it in beside the hit-pop's, because two systems
      // each calling setScalar with their own idea of the total delete each
      // other's work every other frame.
      e.depthScale = f.scale;
      ballSpeed = f.speed;
      // How much of the heading is across the screen rather than through
      // depth. steerTo normalises whatever pair it is handed, so without this
      // the horizontal speed is the FULL swim speed no matter how much of the
      // motion was meant to be going into the picture — a fish crossing the
      // near face would move at up to 1.4x what was asked for, and it lands
      // hardest on exactly the fish the eye is following.
      ballFlat = Math.hypot(f.x, f.y);
    } else {
      const seek = e.towardPlayer ?? sw.towardPlayer ?? 0;
      ax += ctx.dirX * seek;
      ay += ctx.dirY * seek;
    }

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

    // AND FLEE THE STRIKE. A school that held station while a seal wound one
    // up was free food; this is what turns a strike into something you have to
    // aim AHEAD of a school rather than at it.
    //
    // Centred `lead` units up the corridor rather than on the seal, so the
    // fish clear the line the dash is about to travel instead of merely
    // stepping away from where it started — the same reading the wind-up lens
    // is already painting for the player.
    //
    // Deliberately another term in the boids sum rather than a shove: they
    // break and re-form as a school, which is what makes a strike through a
    // scattering shoal feel like fish and not like billiards.
    const sc = CONFIG.strike?.scare;
    let bolt = 0;
    if (sc?.enabled !== false && strikeThreat.active && (sc?.strength ?? 0) > 0) {
      const lead = sc.lead ?? 2.5;
      const tx = strikeThreat.x + strikeThreat.dirX * lead;
      const ty = strikeThreat.y + strikeThreat.dirY * lead;
      const dx = px - tx;
      const dy = py - ty;
      const d = Math.hypot(dx, dy);
      const reach = sc.radius ?? 7;
      if (d > 1e-4 && d < reach) {
        // A wind-up is a threat in proportion to how much of it has been
        // banked; a dash in flight is the whole thing.
        const commit = strikeThreat.dashing
          ? 1
          : (sc.chargeShare ?? 0.7) * strikeThreat.power;
        const fright = (1 - d / reach) * commit;
        ax += (dx / d) * fright * (sc.strength ?? 12);
        ay += (dy / d) * fright * (sc.strength ?? 12);
        // The panic weight above only buys a HEADING — steerTo normalises the
        // sum it is handed, so a fish pointed away from a strike still swims
        // away at its cruising speed. This is the bolt: fright is worth real
        // speed, so a school actually clears the corridor instead of ambling
        // out of it. See CONFIG.strike.scare.speedMul.
        bolt = fright * (sc.speedMul ?? 0.9);
      }
    }

    const w = sw.wander ?? 0;
    if (w > 0) {
      ax += Math.cos(ctx.time * 1.7 + e.phase) * w;
      ay += Math.sin(ctx.time * 2.3 + e.phase) * w;
    }

    // A BALL SWIMS AT THE SPEED ITS OWN ROTATION IMPLIES, whatever species is
    // in it.
    //
    // The speed comes out of the geometry rather than off the fish, and it has
    // to: `spinRate` says the formation turns once every five seconds, so a
    // fish out at the shell is travelling at radius x spinRate and one swimming
    // at any other speed cannot hold the rotation. The roster's small fry run
    // from 4.6 to 7.6 units a second — as a fraction of their own speed, a ball
    // of tuna would turn half again as fast as a ball of clownfish off the same
    // setting, which is a formation whose rotation is decided by a spawn roll.
    //
    // SCALED BY THE HORIZONTAL SHARE of the heading, because the heading is a
    // 3D unit vector and steerTo normalises whatever pair it is handed. Without
    // this a fish diving through depth would also swim its full speed across
    // the screen, so its true speed would be up to 1.4x what was asked for —
    // and that overshoot lands hardest on exactly the fish that are moving
    // through the near and far faces, which is where the eye is.
    //
    // Capped at the fish's own speed, so this can never make one swim faster
    // than it is able to; a slow species in a fast ball simply lags, which
    // reads as a straggler rather than as a glitch.
    //
    // ADDED to `bolt` rather than multiplied by it, so panic restores the
    // fish's OWN full speed: a ball with a strike coming through it should
    // scatter at a bolt, not at a saunter.
    const mill = ball
      ? Math.min(1, ballSpeed / Math.max(0.1, e.speed)) * ballFlat
      : 1;
    steerTo(e, ax, ay, dt, sw.responsiveness ?? 4, mill + bolt);
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
    // ...UNTIL THE STONE IS DOWN. A headstone lands on exactly the spot they
    // are heaped on (systems/gravesite.js), throws them off it, and the last
    // thing the player watches is the name being cut — which was being cut
    // behind a crab that had walked straight back on. The pile is the death;
    // the grave is what comes after it, and they do not overlap.
    if (g.corpse && deathState.active && !graveHasLanded()) {
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

    // KEEP OFF THE GRAVE. Above the wander and the feeding and below the
    // player: a crab with nothing to do walks out of the stone's footprint and
    // stays out, and a crab coming for YOU ignores it — see the note on
    // CONFIG.gravesite.keepOut for why that asymmetry is deliberate rather than
    // an oversight. Nothing here reads the death dive: a stone stands on this
    // floor for every run after the one that earned it, and this is as true on
    // minute one of the next run as it is thirty seconds after a death.
    // TWO RADII, and the wider one is not decoration. With a single edge a crab
    // walks out, is released the moment it crosses it, wanders half a step back
    // in on its next roll and is pushed out again — it paces the boundary of
    // the exclusion for as long as it is down there, which reads worse than the
    // heap it replaced. Once it is leaving it keeps going until it is `clear`
    // of the stone, and only then goes back to being a crab.
    const ko = CONFIG.gravesite?.keepOut ?? {};
    const shy = ko.radius ?? 5;
    const off = ko.enabled === false
      ? null
      : graveKeepOut(e.mesh.position.x, e.graveShy ? shy * (ko.clear ?? 1.5) : shy);
    e.graveShy = off != null;

    // The player getting close to the seabed is a distinct trigger from
    // ordinary proximity — crabs "rush" with a wider aggro radius and a
    // burst of speed, rather than just noticing you a little sooner.
    const rushing = ctx.playerPos.y < bounds.bottom + (g.floorRushHeight ?? 6);
    const aggro = rushing ? (g.rushAggroRadius ?? 999) : (g.aggroRadius ?? 14);
    const speedMul = rushing ? (g.rushSpeedMul ?? 1.8) : 1;

    // OUT FROM UNDER THE STONE. Above the feeding and the wander, and above the
    // player too — but only a DEAD one. A living player outranks a headstone:
    // otherwise someone stood on a grave could not be reached and a decoration
    // would have quietly become a mechanic. A corpse is not something to come
    // for, and by this point it has a stone standing on it.
    //
    // The shortest way off, and a crab standing exactly on the middle picks a
    // side rather than freezing — the sign of nothing is not a direction.
    // WHETHER THE SEAL IS STILL WORTH WALKING AT. A living one inside the aggro
    // radius always is. A dead one stops being one the moment its headstone is
    // on the bed: the pile is over (see the corpse branch above), and without
    // this the crabs walk out of the keep-out, are picked straight back up by
    // the corpse's own aggro — which is arena-wide while the body is on the
    // floor — and pace the boundary of the exclusion for the rest of the
    // sequence, which reads worse than the heap did.
    const chasing = ctx.dist < aggro
      && !(deathState.active && !!g.corpse && graveHasLanded());

    if (off != null && !chasing) {
      e.chumTarget = null;
      e.eating = false;
      const away = off === 0 ? (e.orbitDir ?? 1) : Math.sign(off);
      steerTo(e, away, 0, dt, 6, ko.speedMul ?? 1.5);
      return;
    }

    if (chasing) {
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
      // A body in the water rates the PLAYER budget, not a minnow's: it is the
      // one thing in the game a hunter is supposed to abandon everything for,
      // and it only exists for a few seconds after a boat goes down.
      const turn = trackTurn(e, dx, dy, true);
      if (turn === 0) cruiseOn(e, dt, h, lat, speedMul, { look: false, swim: false });
      else steerTo(e, dx / d + avoid.x, dy / d + avoid.y, dt, 6, speedMul, turn);
      return;
    }
    e.humanTarget = null;

    // e.preyRadius is per-instance and shrinks with the run (CONFIG
    // .hunterRamp.preyFocus), which is most of what "gets more aggressive over
    // time" means here: the fish stop being enough of a distraction to keep
    // this thing off you.
    let target = null;
    const preyR = e.preyRadius ?? h.preyRadius ?? 0;
    // A BAIT BALL IS SEEN FROM MUCH FURTHER OFF than one fish, and it has to
    // be, or the mechanic does not happen at all.
    //
    // Measured before this existed: a shark dropped five units from a ball made
    // ONE pass, took one fish, carried on past on its cruise (see
    // CONFIG.cruiseHunt — a hunter spends only a fraction of its turn rate on
    // prey), and at thirty units away was outside its own 15-unit preyRadius
    // with nothing to bring it back. It then cruised in open water for the
    // remaining forty seconds of the ball's life. One mouthful per ball is not
    // a tug of war; it is a shark that happened to swim through some fish.
    //
    // The wider radius is what makes it come back round, and it is the truest
    // thing in this whole file: a ball of fish is a loud, visible, thrashing
    // mass, and real predators converge on one from a long way out. That it
    // also fixes the geometry is a bonus rather than the reason.
    const ballR = preyR * (CONFIG.baitBall?.pull ?? 2.5);
    let best = Infinity;
    for (const p of ctx.prey) {
      const dx = p.mesh.position.x - px;
      const dy = p.mesh.position.y - py;
      const d2 = dx * dx + dy * dy;
      // Per-target reach, then NEAREST among what is eligible. Ranking on the
      // normalised distance instead would have a ball at its far edge outrank a
      // minnow at arm's length, and a hunter that swims past food it is already
      // on top of reads as broken rather than as focused.
      const reach = p.baitBall ? ballR : preyR;
      if (d2 > reach * reach) continue;
      if (d2 < best) { best = d2; target = p; }
    }
    if (!target) best = 0;

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
      // THE BRANCH THE SPINNING CAME OUT OF. A shark is in here almost
      // permanently — preyRadius is 18-24 units and most of the water is
      // school fish — and the nearest fish changes every few frames as a
      // school scatters, so at full turnRate this was a body with a 2.5-unit
      // turning circle whipping between targets. `trackTurn` makes it a small
      // correction, and a fish already past its flank gets none at all: the
      // shark cruises on, still watching it, and eats whatever it happens to
      // swim through (resolvePredation is on INTERSECTION, not on target).
      const turn = trackTurn(e, target.mesh.position.x - px, target.mesh.position.y - py);
      if (turn === 0) {
        cruiseOn(e, dt, h, lat, speedMul, { look: false, swim: false });
      } else {
        steerTo(
          e,
          (target.mesh.position.x - px) / pd + avoid.x,
          (target.mesh.position.y - py) / pd + avoid.y,
          dt, 6, speedMul, turn,
        );
      }
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
          // AND THE CLOCK GOES BACK TO ZERO. It reads "how long have I been
          // after THIS orb", and there is no longer a this orb — leaving it
          // pinned at maxChase through the whole `cooldown` is stale state
          // that outlives what it describes. It is also read from outside:
          // tools/crab-crowd-test.mjs counts a give-up by watching this cross
          // the threshold, and a value frozen ON the threshold for 180 frames
          // turned one abandoned orb into 182 of them. Re-acquiring already
          // set it to 0 below, which is why nothing had noticed.
          e.chumChase = 0;
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
        //
        // FULL turnRate, and the ONE branch of the five that keeps it. The
        // cruise budget was tried here and it is wrong twice over. It is wrong
        // in principle for the same reason the vertical flattening skips this
        // branch (see the note at the top of `hunt`): a scrap of chum is a
        // fixed point on the seabed, and going to get it is a deliberate act,
        // not the drifting after a moving target that CONFIG.cruiseHunt exists
        // to stop. And it is wrong in fact — measured, it took shark
        // scavenging from 182 successful gulps in 20s to 1 swallowed against
        // 182 abandoned, because an orb sits still and a shark on a 13-unit
        // pursuit circle cannot get back to one inside `maxChase`. That is
        // tools/crab-crowd-test.mjs's "it connects more often than it whiffs",
        // and it is the reason that check exists.
        //
        // The spinning this was all for is a FISH problem: the chum orbiting
        // it could cause was already bounded by `maxChase` and `cooldown`
        // above, which is a shark giving up on a scrap rather than a shark
        // circling one forever.
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

      // --- THE COMMITTED PASS ---------------------------------------------
      // A def carrying a `lunge` block spends part of its approach winding up
      // and then bursts down a locked line — see lungeChase, and the note there
      // on `ownCruise` for why this is an overlay rather than a behaviour. It
      // returns true only on the frames it has actually written the velocity;
      // every other frame falls straight through to the cruise below, which is
      // therefore untouched by any of this.
      //
      // ABOVE the standoff, deliberately. The crowd logic exists to stop apex
      // bodies stacking on the player, and it works by refusing to close — so
      // running it first would hold a shark at arm's length exactly when it has
      // decided to commit, and the lunge would never leave the wind-up.
      //
      // The head goes with it. `weaveLook` below is the IDLE weave, which is
      // the wrong thing entirely mid-strike: an animal that has committed to a
      // line is looking down that line, and a snout still sweeping side to side
      // says it has not decided yet.
      if (e.def.lunge && lungeChase(e, dt, ctx, false)) {
        setLookTarget(e, px + ctx.dirX * ctx.dist, py + ctx.dirY * ctx.dist);
        return;
      }

      const look = weaveLook(e, px + ctx.dirX * ctx.dist, py + ctx.dirY * ctx.dist, lat);
      setLookTarget(e, look.x, look.y);
      if (e.standoffDist == null) e.standoffDist = pickStandoff(CONFIG.apexCrowd);
      const want = approachVector(crowdSelf(e), ctx, ctx.apex, CONFIG.apexCrowd);
      const go = shapeSwim(e, want.x, want.y, lat);
      // Same budget as the fish branch, on the looser player numbers. Measured
      // off `want` rather than off the raw direction to the seal, because the
      // crowd avoidance is already folded into it and steering at a heading you
      // then refuse to turn toward is how a hunter ends up stuck against a
      // neighbour it is trying to swim around.
      const turn = trackTurn(e, go.x, go.y, true);
      if (turn === 0) cruiseOn(e, dt, h, lat, speedMul, { look: false, swim: false });
      else steerTo(e, go.x, go.y, dt, 6, speedMul, turn);
      return;
    }

    // Cruising with nothing in mind. No `speedMul` — see cruiseOn.
    cruiseOn(e, dt, h, lat);
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
      // Ballistic: no steering at all, just gravity — arena.gravity, the same
      // one the seal and every shot in the air answer to, so a dolphin's leap
      // and a breach are visibly the same arc. Killing thrust here is what
      // makes it read as a committed leap rather than swimming through the sky.
      e.vy -= CONFIG.arena.gravity * dt;
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

    // IT WAS ONLY PASSING THROUGH. A turtle cannot be killed, so without this
    // it is not a visitor at all — every one that ever wandered in is still
    // there at minute ten, holding a slot in the population budget forever and
    // slowly filling the ocean with furniture. So it stays a while and then
    // makes for open water, which is also the only exit a creature nothing in
    // the game can hurt is ever going to take.
    //
    // The clock does NOT run while the body is flying: a turtle in mid-punt is
    // the thing the player is currently using, and having it decide to leave
    // halfway across the arena reads as the game deleting your toy.
    if (!e.leaving && e.stayTimer < Infinity) {
      if (!(e.body && e.body.speed() > (CONFIG.physics?.[e.body.kind]?.launchSpeed ?? 4))) {
        e.stayTimer -= dt;
      }
      if (e.stayTimer <= 0) e.leaving = true;
    }

    // The `leaving` steer itself is no longer here — it is at the behaviour
    // dispatch in updateEnemies, so that EVERY creature can be sent away and
    // not just the one behaviour that invented the idea. See steerOut.

    e.wanderTimer -= dt;
    if (e.wanderTimer <= 0) {
      e.wanderTimer = d.wanderChange ?? 4;
      e.wanderAngle = Math.random() * Math.PI * 2;
    }
    steerTo(e, Math.cos(e.wanderAngle), Math.sin(e.wanderAngle) * 0.4, dt, 1.5);
  },
};

// Out the nearest side, and no more of whatever it was doing. `exitSpeed`
// because a turtle's drift speed of 1.6 would take the better part of half a
// minute to cross the water it has left — leaving has to look like a decision.
//
// The per-creature `drift.exitSpeed` still wins where it is set, so the turtle
// keeps the pace it was tuned at; the boss clear-out's own speed is the
// fallback for the ten species that never had one.
function steerOut(e, dt) {
  const out = e.mesh.position.x < 0 ? -1 : 1;
  const speed = e.def.drift?.exitSpeed ?? CONFIG.boss?.clearOut?.exitSpeed ?? 3;
  steerTo(e, out, 0, dt, 2, speed);
}

// ---------------------------------------------------------------------------
// Boss fights clear the water
// ---------------------------------------------------------------------------
// Asked of the LIVE ROSTER rather than of systems/boss.js, which is what keeps
// this file from importing that one — boss.js already imports this one, and
// the pair would be a cycle. It is also the more honest question: what matters
// to spawning is whether there is a boss IN THE WATER, and the roster is the
// only thing that knows for certain. A boss leaves the list by being killed,
// by a run reset, or by anything else that removes a creature, and none of
// those routes owes anyone a callback.
function bossInWater() {
  for (const e of enemies) if (e.isBoss) return true;
  return false;
}

// The boss itself, for the things that need to know WHERE it is rather than
// merely that it exists — the forage's placement, mostly. Same scan and the
// same reasoning as bossInWater above: the live roster is the only thing that
// knows for certain, and asking systems/boss.js would be an import cycle.
function liveBoss() {
  for (const e of enemies) if (e.isBoss) return e;
  return null;
}

/**
 * Hold every spawn in the game for `seconds`.
 *
 * A CLAIM, re-made every frame, exactly like world.focusCamera's hold on the
 * frame and the sustained shake channel: the caller says how long it still
 * wants, and letting go is simply not asking again. Zero is therefore a
 * release and not a no-op — a max() latch would have meant the last frame of a
 * hush could not cancel the hold it had itself set on the frame before, and
 * the lockout would outlive the thing it was covering for by a frame or two.
 *
 * The countdown in updateSpawning is what drains a claim nobody renewed.
 */
export function holdSpawns(seconds = 0) {
  spawnHold = Math.max(0, seconds);
}

/** Seconds of held breath left, for anything that wants to stage against it. */
export function spawnHoldLeft() {
  return spawnHold;
}

/**
 * Is the ocean currently under a boss's spawn lockout?
 *
 * Two ways in, and they are different states wearing one name because every
 * caller wants the same answer from both: the seconds BEFORE an arrival, when
 * the water is deliberately emptying, and the whole fight after it. The one
 * thing that differs is what may still come — during the fight the weighted
 * pool is narrowed to escorts (see pickType), while a hold sends nothing at
 * all, which updateSpawning enforces by returning before the pool is built.
 */
export function bossLockout() {
  if (spawnHold > 0) return true;
  return CONFIG.boss?.clearOut?.enabled !== false && bossInWater();
}

/**
 * Send everything that is not part of this fight away. Called once, by
 * systems/boss.js, on the frame a boss arrives.
 *
 * Nothing is deleted here and nothing dies: each creature is marked `leaving`,
 * turns for the nearest wall under its own power, and is removed by the sweep
 * at the end of updateEnemies as it crosses the edge. No chum, no xp, no kill
 * credit — the ocean got out of the way, the player did not clear it.
 *
 * @returns how many were sent away, for the caller's log.
 */
export function clearForBoss(boss = null) {
  const cfg = CONFIG.boss?.clearOut ?? {};
  if (cfg.enabled === false) return 0;
  let sent = 0;
  for (const e of enemies) {
    if (e === boss || e.isBoss) continue;
    if (e.leaving) continue; // already on its way; don't re-count it
    if (cfg.keepMinions !== false && e.def?.bossMinion) continue;
    // ANYTHING THAT CANNOT SWIM IS NOT ASKED TO. The oyster's speed is 0 — it
    // is a shellfish on the seabed, scenery with a hitbox — and steerTo scales
    // by the species speed, so marking it would produce a creature that is
    // flagged as leaving, never moves, and is therefore never removed by the
    // sweep: a permanent occupant that also suppresses nothing and helps
    // nobody. Giving it a shove instead would be worse, because an oyster
    // gliding sideways out of the arena at five units a second reads as a
    // physics bug rather than as an animal getting out of the way.
    //
    // A handful of oysters sitting still through a boss fight is the correct
    // picture: they are not the crowd the clear-out is about.
    if (!(e.speed > 0.01)) continue;
    // The sea turtle DOES go, and it is the one that most needs to: it cannot
    // be killed, so left behind it is a permanent obstacle in a fight nobody
    // chose to have it in. It already knows how to leave — this only brings
    // its exit forward.
    e.leaving = true;
    // ...and it stops arriving. The two flags pull in opposite directions —
    // the entrance drives a body in under its own floor speed and holds it
    // behind the scenery, the exit needs it to turn round and go — so a fish
    // caught mid-entrance by the hush would have swum in against its own
    // steering, still hidden behind the cliff, for as long as the wall's
    // width. It leaves from where it is.
    // Its z is left where it is rather than snapped home: the ease back into
    // the lane runs the moment these clear (see updateEnemies), and a body
    // still over the rock face would otherwise step out from behind it on a
    // single frame, which is the pop this all exists to remove.
    e.entering = false;
    e.deep = false;
    sent += 1;
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

// Is any of this creature's FAMILIES already full? A second ceiling above the
// species' own `maxConcurrent`, so a roster of individually-rare big predators
// can't stack into a crowd on the technicality that none of them is
// individually over its limit. See CONFIG.spawn.groupMaxAlive.
//
// A creature may belong to several families at once (the sharks are
// "apex shark": big rigged bodies AND sharks), and EVERY cap it names binds —
// the tightest one is what actually decides. That is the whole point of the
// second tag: the apex allowance is about how much screen the big bodies take
// between them, and the shark allowance is about how many SHARKS a fight is
// meant to be, which is a much smaller number.
//
// `counts` is the headcount pickType already built while walking the enemy
// list; pass null and this counts for itself, which is what the one-off
// spawnNamed path does rather than make every caller keep a tally.
function groupAtCap(def, counts = null) {
  const groups = spawnGroupsOf(def);
  for (const group of groups) {
    const cap = CONFIG.spawn.groupMaxAlive?.[group];
    if (cap == null) continue;
    let n = counts?.get(group) ?? 0;
    if (!counts) {
      n = 0;
      for (const e of enemies) if (inSpawnGroup(e.def, group)) n += 1;
    }
    if (n >= cap) return true;
  }
  return false;
}

// IS THERE A CHANGEOVER AT ALL? Two switches, either of which turns the whole
// day/night cast swap off: the clock itself, and the nightlife curves over it.
//
// Its own function because the answer has a second caller now — the boss
// roster's `nightOnly` gate (see bosses.csv and bossMoment in systems/boss.js)
// — and "is there a night in this game" answered in two places is a pair that
// can drift. The distinction matters most where it is least visible: with the
// cycle off, `wearsNightForm()` is false FOREVER, so a night-gated archetype
// asking only that question would be deleted from the game by a toggle that
// says nothing about bosses. A world with no night is a permanent noon, and
// every gate that hangs off darkness stands down rather than latching shut.
export function nightCycleRuns() {
  return !!CONFIG.spawn?.nightlife?.enabled && !!CONFIG.dayNight?.enabled;
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
  if (!nightCycleRuns()) return 1;
  const curve = (glowing ? cfg.glowing : cfg.daylight) ?? {};
  const day = curve.day ?? (glowing ? 0 : 1);
  const night = curve.night ?? 1;
  const dusk = cfg.dusk ?? 0;
  const dark = Math.max(dusk + 1e-4, cfg.dark ?? 1);
  const t = Math.min(1, Math.max(0, (skyLight.night - dusk) / (dark - dusk)));
  return day + (night - day) * t;
}

// Is the water dark enough that a creature with two forms should be wearing
// its night one?
//
// DERIVED FROM THE CURVES rather than from a threshold of its own, and that is
// the whole point: this returns true at exactly the moment the glowing roster
// becomes more welcome than the daylight one, so the cast swap and the costume
// swap are the same event by construction. A separate `if (night > 0.3)` here
// would be a second changeover to keep in sync with the first, and it would
// drift the first time anyone dragged `dusk`.
//
// With the cycle off both curves stand down to 1 and this is false — a world
// with no night is a permanent noon, and every dual species wears its day
// clothes, which is the same answer nightlifeWeight gives.
//
// Read at SPAWN only. A fish already in the water keeps the body it was born
// with, exactly as the day roster lingers at 8% after sunset instead of
// blinking out — the ocean changes over a sunset, it does not cut.
export function wearsNightForm() {
  return nightlifeWeight(true) > nightlifeWeight(false);
}

// `lull` is the wave clock's quiet stretch (see systems/waves.js): a fourth
// kind of "not yet", alongside minDifficulty, minPlayerLevel and the nightlife
// gate. Unlike those three it asks nothing about the creature's place in the
// run — only whether the water is meant to be calm right now — so it sits
// ahead of the weight maths rather than scaling it.
function pickType(difficulty, playerLevel = 1, lull = false) {
  // Per-type headcount, so `maxConcurrent` can keep any one species in check,
  // and the same walk tallies each `spawnGroup` for the family-wide cap. A
  // creature in two families counts once against each of them.
  const alive = new Map();
  const aliveGroup = new Map();
  for (const e of enemies) {
    alive.set(e.type, (alive.get(e.type) ?? 0) + 1);
    for (const group of spawnGroupsOf(e.def)) {
      aliveGroup.set(group, (aliveGroup.get(group) ?? 0) + 1);
    }
  }

  // Both curves worked out once for the whole walk rather than per creature:
  // there are only two answers and they read the clock.
  const glowMul = nightlifeWeight(true);
  const dayMul = nightlifeWeight(false);

  // While a boss is in the water only its minions are sent. Worked out once
  // for the whole walk rather than per creature — it is a scan of the roster.
  //
  // An empty pool is a legitimate answer, the same way a lull's is: with
  // nothing tagged `bossMinion` in enemies.csv a boss fight is a duel, which
  // is the default and the thing this was asked for. The caller already treats
  // "nothing to send" as nothing to send.
  const lockout = bossLockout();

  const pool = [];
  let total = 0;
  for (const [key, def] of Object.entries(CONFIG.enemies)) {
    // THE FOOD DOES NOT STOP. A boss fight used to lock the pool to escorts,
    // which meant the one fight in the game where you most need a full strike
    // meter was also the only stretch with nothing in the water to eat — the
    // player went in with whatever they had and finished on an empty bar.
    //
    // So the small fry keep coming. Not the roster — a boss fight is still not
    // a shiver, and everything with teeth is still held back — just the things
    // that are food, at the rate the lull sends them (see waveSpawn's
    // `bossFoodMul`, which is what stops this becoming a free farm).
    if (lockout && !def.bossMinion && !(CONFIG.boss?.clearOut?.keepFood !== false && lullEligible(def))) continue;
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
    // THREE KINDS OF CREATURE, not two. `bioluminescent` is a species that
    // only exists after dark and `nightAsset` is one that exists all run and
    // CHANGES CLOTHES at dusk — so the second must not walk either curve
    // alone. The glowing curve would delete it from the daylight ocean (its
    // `day` end is 0) and the daylight curve would throttle it to 8% at night,
    // which is the whole roster going quiet exactly when its night form was
    // supposed to be the thing you were looking at.
    //
    // `max` rather than a third tunable curve: the two ends it needs are 1 and
    // 1, and both already exist as the OTHER curve's live end. A dual species
    // therefore tracks whichever roster is currently in season, which is what
    // "it is always in season" means when the two curves are complementary.
    w *= def.bioluminescent ? glowMul : (def.nightAsset ? Math.max(dayMul, glowMul) : dayMul);
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

// ---------------------------------------------------------------------------
// THE ENTRANCE
// ---------------------------------------------------------------------------
// Nothing appears in open water. Every creature in the game is placed OUTSIDE
// the picture and swims in — through the rock face at either wall, or up out
// of the seabed — and for the stretch of that journey where it is over drawn
// scenery it sits BEHIND the scenery in z.
//
// That last part is free, and it is free for one specific reason: the camera
// is orthographic. Moving a body in z does not move it, resize it or shift it
// on screen by a pixel; all it changes is what draws in front of what. So a
// creature can be tucked behind the cliff for the whole crossing and eased
// back into its swimming lane afterwards with nothing visible happening — the
// eye sees an animal come out from behind a rock, which is what it is.
//
// The alternative, and what this replaced: spawn a body a margin INSIDE the
// wall and let it fade in over a beat. That is pop-in with a curve on it. The
// wall is already drawn, already opaque and already exactly where the frame
// stops; the only thing missing was arriving on the far side of it.
function entranceCfg() {
  return CONFIG.spawn?.entrance ?? {};
}

// The first x, on either side, that no frame can reach. The frame may drift
// `shoreOverscan()` units past the wall (see clampFocus in world.js), so that
// is where the picture actually ends — plus the body's own reach, because a
// creature is placed by its CENTRE and it is the nose that gives it away.
function offscreenX(radius = 0) {
  return bounds.right + shoreOverscan() + radius + (entranceCfg().margin ?? 1.5);
}

// ...and the same line for the floor. Below the seabed's top edge the strip is
// an opaque plane spanning the whole arena, so a body under it and behind it
// is hidden twice over: by the floor it is under and by the bottom of the
// frame, which never travels below bounds.bottom outside a death.
function offscreenY(radius = 0) {
  return Math.min(bounds.bottom, seabedTopY()) - radius - (entranceCfg().margin ?? 1.5);
}

// Sea creatures enter from the sides or from the deep — never from the sky.
//
// A CRAWLER IS THE EXCEPTION and has to be asked for by passing its def. The
// generic point picks a random DEPTH, which for a swimmer is the whole idea
// and for a crab means arriving in mid-water and falling to the seabed. Crabs
// get the same wing entrance the chum-pile summoner gives them
// (systems/crabSpawner.js edgeFloorPoint), which is why they read as walking
// on rather than appearing.
function edgeSpawnPoint(def = null) {
  const margin = 1.5;
  if (def?.behavior === 'crawl') {
    // OUTSIDE the arena on purpose: spawnOne only skips the horizontal clamp
    // while a body is still beyond the wall, and that is what buys the walk-on.
    // Its own margin is a FLOOR under the shared one rather than a replacement
    // — the crab tuning predates the drawn shore and is a smaller number than
    // the shore now needs, and spawnOne pushes every body out to the line in
    // any case.
    const m = Math.max(CONFIG.crabSpawn?.spawnMargin ?? 3, shoreOverscan() + margin);
    const side = Math.random() < 0.5 ? -1 : 1;
    return {
      x: side * m,
      y: bounds.bottom + (CONFIG.crabSpawn?.floorHeight ?? 2.5) * 0.5,
      side,
    };
  }
  const r = Math.random();
  const depth = bounds.bottom + margin + Math.random() * (bounds.surfaceY - bounds.bottom - margin * 2);
  const out = offscreenX();
  // ALWAYS FROM THE DEEP, for a creature whose whole proposition is that it
  // came up out of the dark. `deepSpawn` is asked for on the def rather than
  // rolled, so an anglerfish cannot arrive by swimming in along the surface
  // past the player it is supposed to be waiting under — a third of its
  // arrivals did, and an ambusher that announces itself from the wings has
  // given away the only thing it had. Checked before the roll below, which is
  // the same deep entrance offered to everything at 1 in 10.
  if (def?.deepSpawn && !def?.floorSpawn) {
    return { x: bounds.left + Math.random() * bounds.width, y: bounds.bottom, deep: true };
  }
  // `side` and `deep` are the ENTRANCE, carried alongside the position rather
  // than left to be inferred from it. A school is this point plus a random
  // scatter (see spawnPicked) and the scatter is wider than the margin, so one
  // fish in a shoal reliably lands a unit INSIDE the wall — where a spawner
  // reading only the coordinates sees an ordinary creature in open water and
  // pops it into existence at the edge of frame. Which entrance a spawn is
  // making is a decision, and decisions survive being scattered.
  if (r < 0.45) return { x: -out, y: depth, side: -1 };
  if (r < 0.9) return { x: out, y: depth, side: 1 };
  // FROM THE DEEP, which is now literally that: the body starts under the
  // seabed and climbs out of it. `deep` is a request rather than a position —
  // how far under it has to start depends on how big it is, and that is not
  // resolved until spawnOne has built the model.
  //
  // NOT FOR A CREATURE THAT LIVES ON THE FLOOR. `floorSpawn` puts a body at
  // bounds.bottom + its radius, which for an oyster is INSIDE the drawn seabed
  // strip — half buried, which is the pose. A deep entrance hides a body
  // behind that strip and lets go when it is clear of it, and this one is
  // never clear of it: it would rise out of the sand it is supposed to be
  // sitting in, or hold its hiding depth at rest and simply never be seen
  // again. It comes in from a wing instead, along the floor.
  if (def?.floorSpawn) {
    const side = Math.random() < 0.5 ? -1 : 1;
    return { x: side * out, y: depth, side };
  }
  return { x: bounds.left + Math.random() * bounds.width, y: bounds.bottom, deep: true };
}

/**
 * The entrance picker, for tools/boss-angler-test.mjs.
 *
 * Exported because `deepSpawn` is the difference between an ambush predator
 * that comes up out of the dark and one that swims in past you from the side of
 * the screen, and there is no other way to see which: the roll is random, the
 * un-flagged path already takes the deep branch one time in ten, and a spawn
 * that has already happened has thrown away which door it came through. The
 * only honest check is many rolls of the picker itself.
 */
export function __spawnPointForTest(def) {
  return edgeSpawnPoint(def);
}

// `opts.schoolId` groups a school for the boids; `opts.xpMul` scales what this
// individual's chum will be worth when it dies (the lull between waves pays a
// fraction — see CONFIG.spawn.waves.lull).
function spawnOne(scene, key, def, difficulty, at, opts = {}) {
  const { schoolId = null, xpMul = 1 } = opts;
  const container = new THREE.Group();
  // Recycled where possible — see acquireVisual in assets.js. A creature's body
  // is the single most expensive thing a spawn allocates (a cloned bone
  // hierarchy, a Skeleton and its bone texture), and at two to four kills a
  // second the churn was costing more in collection pauses than the spawn ever
  // cost to build.
  // `assets` (plural) IS A LIST OF BODIES and one is rolled per spawn. That is
  // how the boss orca arrives as either a bull or a cow off a single set of
  // stats: one enemies.csv row, one name pool, one health bar, two animals. The
  // alternative — a second archetype for the second model — would have meant
  // tuning the same fight in two places and hoping they stayed level.
  //
  // A NEW KEY RATHER THAN A LIST IN `asset`, and that is the only way this
  // could actually work. Saved tuning beats config.js in the merge, and every
  // imported-tuning.json ever written carries `enemies.bossOrca.asset` as the
  // string it used to be — so a list written into `asset` would be overwritten
  // by the snapshot on load, for everybody who has ever opened the tuner, and
  // the boss would spawn as an empty Object3D. Same move `everyLevels` made
  // over `everyLevelsMin`/`Max`, for the same reason. `asset` still works and
  // is still what every other creature uses.
  //
  // Resolved to a single key HERE and carried on the creature, because
  // everything downstream that asks what this individual is made of (the
  // hitbox, the recycler, the look) has to get the same answer as the body
  // that was actually built. Reading the list again later would re-roll it.
  // `nightAsset` wins over both, and is checked FIRST rather than folded into
  // the list above: a species with two forms has one body per form, not a bag
  // of interchangeable ones, so rolling it in with `assets` would let a dual
  // species come up in its day clothes at midnight one spawn in two.
  //
  // A SECOND ASSET KEY IS THE ONLY WAY TO DO THIS. The glow is injected into
  // the material by onBeforeCompile and materials are shared per asset key
  // (instantiateParsedModel), so one key cannot be lit at noon and luminous at
  // midnight — and Material.clone() drops the injected shader, so cloning per
  // instance loses the glow silently. What this DOESN'T need is a second
  // enemy id: the balance row, the ramp and the caps are properties of the
  // species, not of what it is wearing.
  const choices = Array.isArray(def.assets) ? def.assets.filter(Boolean) : null;
  const assetKey = (def.nightAsset && wearsNightForm())
    ? def.nightAsset
    : choices?.length
      ? choices[(Math.random() * choices.length) | 0]
      : (def.asset ?? key);
  const visual = acquireVisual(assetKey);
  // This individual's own palette, from skins.csv — a heap of crabs is nine
  // shells rather than one repeated. Rolled here rather than inside
  // acquireVisual because a RECYCLED body arrives still wearing the skin it
  // died in; see rollBiolumSkinVariant. A no-op for every creature whose
  // preset has no skins listed, which is all of them but the crabs.
  // ...and the edge that goes with it. A look is the body and its rim together
  // (skins.csv `rim`), so the two are rolled from one row and applied as a
  // pair. Null for every row that says nothing about the rim, which puts the
  // body back on its species' shared material — not a no-op on a RECYCLED
  // body, which is still wearing whatever the last roll gave it.
  setOutlineVariant(visual, assetKey, rollBiolumSkinVariant(visual)?.__rim ?? null);
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
  const laneZ = (Math.random() * 2 - 1) * (def.depthSpread ?? 0) * radius;
  container.position.set(at.x, at.y, laneZ);
  // Seabed dwellers ignore the edge spawn point's Y and settle on the floor,
  // so they appear where they belong rather than swimming down to it.
  if (def.floorSpawn) container.position.y = bounds.bottom + radius;

  // Spawned off the side of the arena — crabs walk on from the wings, and so
  // does everything else now. The shared clamp would yank it inside on the
  // very first frame, leaving nothing to walk in FROM, so while `entering` is
  // set only the vertical limits apply. Cleared the moment it is fully inside
  // (see updateEnemies), after which it is walled in like everything else.
  //
  // MAKING AN ENTRANCE, or merely placed. `side` and `deep` are a spawn saying
  // which way it is coming in (see edgeSpawnPoint); a spawn that says neither
  // is one somebody put somewhere on purpose — the debug spawner's row in
  // front of the player, a perk's escort summoned at the boss's flank — and
  // those are left exactly where they were asked for. Pushing one out to the
  // line because it happened to land near a wall would teleport a summoned
  // turtle off screen, which is the arrival mechanism doing damage to a
  // deliberate placement.
  const deep = !!at.deep;
  const arriving = !deep && at.side != null;
  // The geometric test is the FALLBACK, for a placement that declared nothing
  // and simply happens to be past a wall. A declared entrance outranks it, and
  // has to: the deep entrance rolls its x anywhere across the arena, so one
  // spawn in fifty landed within a body's width of a wall, was read as a side
  // entrance by the measurement, lost its `deep` flag to it, and appeared
  // standing on the seabed in plain sight. Two ways in, and which one a spawn
  // is taking is not something to deduce from where it starts.
  let entering = arriving || (!deep && (at.x < bounds.left + radius || at.x > bounds.right - radius));
  // PUSHED OUT TO THE LINE HERE rather than trusted from the caller, and that
  // is the whole guarantee. A school is placed as an anchor plus a random
  // scatter (see spawnPicked), and a scatter of three units either way will
  // reliably drop one fish inside the frame; every other caller carries its
  // own margin from its own era. One clamp, at the single point every spawn
  // passes through, is the difference between "the entrance is off screen"
  // being a property of the system and being a property of six call sites.
  //
  // Outward ONLY: a body already further out keeps its distance, so the shape
  // of an arriving school is preserved and only its innermost are moved.
  if (arriving) {
    container.position.x = at.side * Math.max(Math.abs(container.position.x), offscreenX(radius));
  }
  if (deep) container.position.y = Math.min(container.position.y, offscreenY(radius));
  if (entering) clampVertical(container.position, radius);
  else if (!deep) clampBelowSurface(container.position, radius);
  // BEHIND THE SCENERY, for as long as the crossing takes. Two hiding places,
  // one per direction of travel: the rock face at the walls and the seabed
  // strip under the floor. Both are measured rather than typed — see `shore`
  // in systems/wallRocks.js and SEABED_Z in arena.js — because both are drawn
  // by code that is free to move them, and a hiding place that has drifted in
  // front of what it was hiding is a creature swimming through a cliff.
  //
  // Not applied when there is no shore built (the tuner can switch the rock
  // off): with nothing drawn out there, there is nothing to hide behind, and
  // the entrance is then simply off-screen, which is what it was before.
  //
  // SCALED A LITTLE BY THE BODY, because the measured depth is the depth of a
  // SURFACE and a creature has thickness. `shore.hideZ` puts a body's CENTRE
  // behind the shallowest rock face on the wall; a megalodon whose flank
  // stands two units proud of its centre would still have its near side in
  // front of it. Measured off the rock front profile: the face sits around
  // z = 0.2 at a typical height and reaches back to -1.55 at its meanest, so
  // the biggest bodies in the game need most of this and a reef fish needs
  // none of it. Capped, because everything back here has to stay in front of
  // the water fill at -5.4.
  const bodyHide = Math.min(radius * (entranceCfg().hideBySize ?? 0.3), entranceCfg().hideDepthMax ?? 1.5);
  // ...and never past the sea itself. The floor's hiding place starts a long
  // way back already (the seabed strip is drawn at -4 against a fill at -5.4),
  // so the biggest bodies were the ones that ran out of room: measured, a boss
  // wanted -5.9, which is BEHIND the water. Nothing is visible back there, and
  // "nothing is visible" is not the same as hidden — it appears out of the
  // empty column the moment it eases forward again.
  const floorZ = WATER_FILL_Z + (entranceCfg().fillClearance ?? 0.2);
  if (deep) {
    container.position.z = Math.min(laneZ,
      Math.max(SEABED_Z - (entranceCfg().hideMargin ?? 0.4) - bodyHide, floorZ));
  } else if (arriving && shore.built) {
    container.position.z = Math.min(laneZ, Math.max(shore.hideZ - bodyHide, floorZ));
  }
  scene.add(container);

  // Two layers of run scaling, in this order: the species' own linear
  // per-difficulty term, then the roster-wide compounding ramp from
  // CONFIG.spawn.ramp. The linear term keeps each creature's authored
  // character (a shark gains far more hp per minute than a reef fish); the
  // ramp is what makes minute ten hurt no matter which creature it sends.
  //
  // ...and on top of BOTH of those, the level surcharge: past CONFIG.spawn
  // .lateGame.from the water scales against how strong the seal has got as well
  // as against how long the run has been going. It is a third multiplier rather
  // than a bigger `ramp`, because it has to be able to leave the first twenty
  // levels of a run untouched — see the block in config.js.
  //
  // ...and on top of all THREE, the master dial from CONFIG.pace — one number
  // for how hard the water is, exactly 1 in the tuned game, so the two ramps
  // above are what a run actually rides and this only scales them.
  const hp = (def.hp + def.hpPerDifficulty * difficulty) * difficultyRamp('hp', difficulty)
    * lateGameMul('hp', spawnLevel) * enemyPaceMul('hp');
  // Damage and speed ramp with the run the same way hp always has. All three
  // are baked per-instance at spawn rather than read from the shared def
  // every frame: `def` is one object for the whole species, so scaling it in
  // place would retroactively buff everything already on screen.
  const damageMul = difficultyRamp('damage', difficulty) * lateGameMul('damage', spawnLevel)
    * enemyPaceMul('damage');
  const contactDamage = (def.contactDamage + (def.contactDamagePerDifficulty ?? 0) * difficulty)
    * damageMul;
  // Ranged attackers scale with the same damage curve as contact — otherwise
  // anything with a `shoot` block falls behind over a long run. updateEnemies
  // fires with e.shotDamage, not def.shoot.damage, for the same
  // per-instance reason as above.
  const shotDamage = def.shoot ? def.shoot.damage * damageMul : 0;
  // ...and so does the BITE, on the same curve and baked at spawn for the same
  // reason. Zero for everything that leaves `biteDamage` blank in enemies.csv,
  // which is every wildlife row: their snap stays what it always was, a sound
  // and a pose over a contact drain that never stops. The bosses that chase
  // fill it in, and it is the whole of what their jaws are worth — see the
  // hook in main.js and the cut to their contactDamage next to it.
  const biteDamage = (def.biteDamage ?? 0) * damageMul;
  // Speed variance stays outside the ramp: it's the per-individual jitter
  // that keeps a school from moving as one body, not part of the threat
  // curve, and multiplying it up would spread a late-run school apart.
  //
  // The master dial sits inside the ramped term for the same reason: it is a
  // scale on the threat curve, and the jitter is not part of that curve.
  const speed = (def.speed + (def.speedPerDifficulty ?? 0) * difficulty)
    * difficultyRamp('speed', difficulty) * lateGameMul('speed', spawnLevel)
    * enemyPaceMul('speed')
    + Math.random() * (def.speedVariance ?? 0);
  const heading = Math.random() * Math.PI * 2;

  // The pressure side of the balance ledger: hp entering the arena. Recorded
  // at spawn rather than counted at death on purpose — the creatures a
  // flooding arena is made of are exactly the ones that never get killed, and
  // a kill-based tally would be blind to them.
  //
  // Scenery is excluded, and it says so with `invincible` now rather than with
  // an enormous hp. Counting an unkillable creature as hp the player is
  // expected to clear made one turtle spawn read as 628 MILLION hp/sec of
  // pressure — which silently pinned that whole window's clear rate at zero
  // and would have had every report blaming the difficulty ramp for a turtle.
  //
  // The SENTINEL_HP arm stays as a backstop. Nothing in the table needs it any
  // more, but it costs one comparison and it is the difference between a
  // future placeholder being a nuisance and it poisoning a month of reports
  // before anyone notices. Belt and braces, deliberately.
  if (!def.invincible && hp < SENTINEL_HP) recordSpawn(hp);

  // Any model with clips or a procedural rig gets a controller; static
  // THE DRIVERS RIDE WITH THE BODY. Each of these binds to a specific bone
  // hierarchy, so a recycled body can keep the ones it was built with instead
  // of the spawn allocating a fresh mixer, an action per state and three rig
  // solvers every time a creature arrives.
  //
  // That is the other half of the pooling. With the bodies recycled, the
  // remaining spikes in a measured run all fell inside one seven-second window
  // — the busiest stretch of the game, 469 spawns and 299 kills in thirty
  // seconds — and these were what was still being built fifteen times a second
  // in it.
  //
  // Cached on the visual rather than in a map keyed by it: they are only ever
  // valid for that exact hierarchy, so anything that can hand out a body has to
  // hand out its drivers too, and a field makes that impossible to get wrong.
  // clearVisualPool drops both together for the same reason.
  const rigs = visual.userData.__rigs ??= {};

  // shapes and unrigged models (e.g. the reef fish) simply don't.
  // Trap enemies use their own one-shot attack mixer below instead of the
  // continuous idle/swim/boost controller (they don't have those states).
  const hasAnimSource = def.behavior !== 'trap' && (visual.userData?.clips?.length || visual.userData?.rig);
  if (hasAnimSource && !rigs.anim) rigs.anim = createAnimationController(visual);
  const anim = hasAnimSource ? rigs.anim : null;
  // Back to clean idle locomotion. Without it a recycled body keeps the pose it
  // died in — 'death' clamps on its last frame and never expires on its own —
  // so the next creature would spawn already dead. This reset exists for the
  // seal's restart and does exactly the same job here.
  anim?.reset();

  // Head-look, for the models that declare a chain for it (the sharks and the
  // orca). Null for everything else, and every call site tolerates that.
  if (def.behavior !== 'trap' && rigs.look === undefined) rigs.look = createHeadLook(visual);
  const look = def.behavior !== 'trap' ? rigs.look : null;
  look?.reset();

  // Procedural jaw, for the hunters whose file ships no bite clip — which is
  // all of them except megalodon. Skipped when the controller already has a
  // real `bite` action, so the authored clip owns the jaw rather than getting
  // a second rotation piled on top of the one it is already writing.
  // Whether a jaw is WANTED is decided per spawn; only the driver is cached.
  // One asset can back several roster entries, and they need not agree — a
  // `trap` entry has no animation controller at all, so it always wants the
  // procedural jaw, while a sibling entry with a real bite action must not have
  // one. Caching the decision rather than the driver would give whichever
  // spawned first the casting vote, and the loser would either lose its jaw or
  // get a second rotation piled on the clip already writing that bone.
  const wantJaw = !anim?.clipCoverage?.bite;
  if (wantJaw && rigs.jaw === undefined) rigs.jaw = createJawDriver(visual);
  const jaw = wantJaw ? (rigs.jaw ?? null) : null;
  jaw?.reset();

  // The crab's telegraphed pinch. Null for everything that declares no
  // clawRig, which is every creature but the two crabs — see systems/
  // crabClaw.js for why the gesture has to be manufactured rather than played.
  if (rigs.claw === undefined) rigs.claw = createClawDriver(visual);
  const claw = rigs.claw;
  claw?.reset();

  // Behavioural difficulty ramp, baked per instance for the same reason
  // hp/damage/speed above are: `def` is one object shared by every member of
  // the species. See CONFIG.hunterRamp.
  const ramp = CONFIG.hunterRamp;
  const rampOn = ramp?.enabled && difficulty > 0;
  // The level surcharge on all three axes below, as ONE number — see
  // CONFIG.spawn.lateGame.seek for why they are not three rows. 1 for the whole
  // first twenty levels, so everything under `rampOn` reads exactly as it did.
  //
  // ...times the master difficulty dial's aggression axis, which is the only
  // one of the four that needs its own note: the three lines below used to
  // apply `seekMul` only inside their `rampOn` branch, which is correct for a
  // ramp read off the run clock (there is no ramp at difficulty 0) and wrong
  // for a dial that is meant to hold all run. Each is restated below as
  // `<base> * <ramp, or 1> * seekMul` — the same value it always produced at
  // seekMul 1, and now a value at difficulty 0 as well.
  const seekMul = lateGameMul('seek', spawnLevel) * enemyPaceMul('seek');
  // Prey distraction decays toward a floor: each difficulty point sheds
  // `preyFocus` of what is LEFT above the floor, so it falls off quickly at
  // first and then flattens instead of crossing zero.
  const preyBase = def.hunt?.preyRadius ?? 0;
  const preyFloor = preyBase * (ramp?.preyFocusMin ?? 1);
  //
  // The surcharge DIVIDES what is left above the floor rather than steepening
  // the exponent: at seekMul 2 a late shark keeps half the distraction the run
  // clock had left it, whatever that was. Steepening the exponent instead would
  // have made the surcharge's size depend on how far into the run the level
  // happened to land, which is the one thing this ramp exists not to do.
  // `preyFocusMin` is still the floor — a shark that ignored fish entirely
  // would switch the whole food chain off. See the note on it in config.js.
  const preyDecay = rampOn ? ((1 - (ramp.preyFocus ?? 0)) ** difficulty) : 1;
  const preyRadius = preyFloor + (preyBase - preyFloor) * preyDecay / seekMul;
  // ...and turning tightens, compounding and capped, like the spawn ramps.
  const turnRamp = rampOn
    ? Math.min(ramp.turnRateMax ?? Infinity, (1 + (ramp.turnRate ?? 0)) ** difficulty)
    : 1;
  const turnRate = def.turnRate ? def.turnRate * turnRamp * seekMul : def.turnRate;
  // ...and a SCHOOL presses harder, which is the only line here that reaches a
  // basic fish — the two above read a preyRadius and a turnRate that the swarm
  // species do not declare. Same compounding-and-capped shape; see
  // CONFIG.hunterRamp.swarmSeek for why the schools needed their own.
  const swarmRamp = rampOn
    ? Math.min(ramp.swarmSeekMax ?? Infinity, (1 + (ramp.swarmSeek ?? 0)) ** difficulty)
    : 1;
  const towardPlayer = def.swarm ? (def.swarm.towardPlayer ?? 0) * swarmRamp * seekMul : 0;

  // Trap-type enemies play a one-shot attack clip on their own timer rather
  // than the continuous idle/swim/boost loop, so they get a tiny dedicated
  // mixer instead of the shared controller.
  let attackMixer = null;
  let attackAction = null;
  if (def.behavior === 'trap' && visual.userData?.clips?.length) {
    const clipName = def.animations?.attack;
    const clip = clipName ? THREE.AnimationClip.findByName(visual.userData.clips, clipName) : null;
    if (clip) {
      // Cached on the body like the drivers above, and keyed by CLIP NAME —
      // two roster entries can share an asset and trap with different
      // animations, and a mixer built for one clip would silently play that
      // clip for the other.
      const cached = rigs.attack;
      if (cached && cached.name === clipName) {
        ({ mixer: attackMixer, action: attackAction } = cached);
        // clampWhenFinished holds the last frame, so a recycled trap would
        // spawn mid-snap with its jaws already shut.
        attackAction.stop();
      } else {
        attackMixer = new THREE.AnimationMixer(visual);
        attackAction = attackMixer.clipAction(clip);
        attackAction.loop = THREE.LoopOnce;
        attackAction.clampWhenFinished = true;
        rigs.attack = { name: clipName, mixer: attackMixer, action: attackAction };
      }
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
    //
    // ...AND THE SAME GOES FOR THE TOUGHNESS THIS ONE WAS BORN WITH. `hp` above
    // is already the fully ramped figure, so a creature the run has made
    // twenty-five times harder to kill drops chum worth more than the one that
    // spawned in the first minute — see CONFIG.xp.toughness for why the ladder
    // needs that. Read here, off the same `hp` the creature is about to carry,
    // so the two can never disagree about how hard this individual was.
    //
    // ...and the level surcharge pays for its own half of that, TWICE OVER, and
    // deliberately. `hp` above already carries lateGameMul('hp'), so
    // xpToughnessMul is already paying for this ramp — and then the explicit
    // term goes on top, which is why a level-28 spawn's chum is worth about 5x
    // a level-20 one's against only 2.5x the health.
    //
    // That gap is the whole tuning, not an oversight. Paying back exactly what
    // the ramp costs holds INCOME PER KILL level, and a kill is not what the
    // ladder is denominated in — a level is, and the level cost compounds at
    // CONFIG.xp.endMul (1.42) on every one of them. Measured on the real
    // spawner (npm run test:xp), a payback that only matched hp still left
    // levels 22-26 stretching to 65s apiece; this is the rate that holds them
    // flat at about 42s, which is the pace the band below them runs at.
    xp: (def.xp ?? 0) * xpMul * xpToughnessMul(hp, def.hp) * lateGameMul('xp', spawnLevel),
    speed,
    // Per-instance, so a crab that spawned at minute one keeps hitting for
    // what it was worth then. combat.js reads e.contactDamage, not the def.
    contactDamage,
    biteDamage,
    shotDamage,
    vx: Math.cos(heading) * speed * 0.5,
    vy: Math.sin(heading) * speed * 0.5,
    heading,
    fireTimer: Math.random() * (def.shoot?.interval ?? 1),
    orbitDir: Math.random() < 0.5 ? -1 : 1,
    wanderTimer: Math.random() * 2,
    wanderAngle: heading,
    // How long this one is staying, and whether it has already turned for open
    // water. Infinity for everything without a `stay` — the rest of the roster
    // leaves the arena by dying. See BEHAVIORS.drift.
    stayTimer: def.drift?.stay != null
      ? def.drift.stay + (Math.random() * 2 - 1) * (def.drift.stayJitter ?? 0)
      : Infinity,
    leaving: false,
    phase: Math.random() * Math.PI * 2,
    schoolId,
    // BAIT BALL STATE, inert on everything else. `baitBall` is the flag the
    // swarm behaviour branches on and spawnBaitBall sets it straight after this
    // returns.
    //
    // Declared here rather than only on the bait path so the shape of a
    // creature is one shape. A field that exists on some fish and not others is
    // a field every reader has to test for, and the first reader that forgets
    // gets `undefined` arithmetic and a body at NaN.
    baitBall: false,
    // Speed through DEPTH. Every other creature in the game has none — the two
    // axes it steers on are the two you can see — and a bait fish is the one
    // thing that swims into and out of the picture. Declared on every creature
    // so the shape of one is one shape; the flock is the only writer.
    vz: 0,
    // This fish as baitFlock sees it, reused every frame. See the view pass in
    // updateEnemies for why it lives on the creature rather than being built
    // there.
    ballView: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
    // The depth cue, 1 on anything that is not in a ball. Multiplied into every
    // scale write so the hit-pop and the column cannot overwrite each other.
    depthScale: 1,
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
    // How hard this individual steers at the seal — see the bake above. Read by
    // the swarm behavior in place of def.swarm.towardPlayer.
    towardPlayer,
    // Jaw state. `biteCooldown` rate-limits the snap; `lungeTimer` is the
    // burst of speed that carries it in. Both tick in updateEnemies.
    jaw,
    claw,
    // Seconds until this crab may start another pinch. Per instance, so a
    // crowd does not snap in unison — seeded short and random so the first
    // crab to reach you does not have to serve a full cooldown before it may
    // do anything at all.
    pinchTimer: Math.random() * (clawSetting(def, 'cooldown') ?? 2.6),
    // Set for exactly one frame, on the frame the claws meet. systems/
    // combat.js reads it and bills the damage; nothing else may write it.
    justPinched: false,
    // THE SEAL IS IN THIS ANIMAL'S MOUTH. Owned entirely by systems/bossGrab.js
    // — true for the length of a grab and false the rest of the time. Read by
    // systems/combat.js, which suppresses this creature's contact damage while
    // it holds you: the grab is already billing its own chewing on its own
    // clock, and charging the body drain on top would be the same attack
    // collecting twice for the same two seconds.
    //
    // Declared here rather than only on the three bosses that can do it, for
    // the reason every other flag in this record is: the shape of a creature is
    // one shape, and a field that exists on some of them is a field the first
    // reader to forget it turns into `undefined`.
    grabbing: false,
    // ...and the dead time afterwards, ticked down in the main update beside
    // every other per-creature clock. Seeded at 0 so a boss may take hold the
    // first time it lands a clean bite rather than having to serve a cooldown
    // for something it has not done yet.
    grabCooldown: 0,
    // A BODY BEING USED AS A WEAPON. Set by the three systems that multiply a
    // boss's contact damage for a committed run — the perk lunge, the kraken's
    // crush and the anglerfish's strike — and cleared when each restores it.
    //
    // systems/combat.js reads it to decide which of the boss damage ceilings
    // the overlap draws on. While it is false, touching the animal is chip and
    // is held to CONFIG.boss.damageCap.contactPerSecond; while it is true the
    // touch IS the attack the boss committed to, and it draws on the fight's
    // budget like a bite or a shell does. Without the flag a x3.2 crush is
    // clipped to the same quarter-bar-per-second as drifting into a tail fin,
    // which is the whole reason the multiplier stopped meaning anything.
    ramming: false,
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
    // How big this individual is RELATIVE to its species — the run's growth
    // times its own size roll, with the asset's own scale factored out. That
    // distinction matters: spawnScale is an absolute number that includes the
    // model's fit and the tuner's Size slider (the turtle's asset alone is
    // 3.08x), so anything wanting "is this a big one for a turtle" has to read
    // this instead. A rigid body's mass does — see attachRigidBody.
    sizeMul,
    radius,
    anim,
    hitThisFrame: false,
    trapTimer: 0,
    // Kept separate from trapTimer rather than reusing it: the two sources
    // have different durations and different looks, and sharing one field
    // meant a beluga bubble landing on a charmed fish would cut the charm
    // short (or extend it) depending on which fired last.
    charmTimer: 0,
    // The harp's note ring, and the same argument one more time: this is the
    // DAMAGE half of a harp charm and charmTimer is the pacify half, so a dumbo
    // charm landing on this body must not grow a ring and the ring must not end
    // early because the pacify wore off first. The radius and per-tick damage
    // are stamped on alongside it (systems/harp.js), so a level-up mid-charm
    // cannot resize a ring that is already on screen.
    harpAura: 0,
    harpAuraTick: 0,
    harpAuraRadius: 0,
    harpAuraDamage: 0,
    // --- the boss's own two fields (systems/boss.js, systems/bossPerks.js) ---
    // Seconds of "cannot be hurt and cannot hurt you" left. Only ever non-zero
    // on a boss making its entrance, but seeded on every creature for the same
    // reason every timer here is: `undefined - dt` is NaN and a NaN timer never
    // expires, so the one creature it is ever set on would become permanently
    // untouchable if it were merely assumed to exist.
    invuln: 0,
    // Raised while a boss perk is driving the body directly. The behaviour
    // dispatch below skips a creature carrying it — the perk owns vx/vy that
    // frame — which is the same door `leaving` goes through.
    perkDrive: false,
    // Set by a system that owns this body's locomotion state — see the
    // anim.update call below. null means "derive it from my speed".
    animState: null,
    // --- the daze (systems/control.js) ---------------------------------------
    // What a hold becomes when it lands on something that cannot be held. Only
    // ever non-zero on a boss, and seeded on everything for exactly the reason
    // `invuln` above is: an unseeded timer is a NaN timer, and a NaN timer
    // never expires. `dazeCooldown` is the recovery that runs AFTER it, which
    // is the whole no-stacking guarantee — see CONFIG.boss.control.daze.
    dazeTimer: 0,
    dazeCooldown: 0,
    dazePhase: 0,
    dazeSign: 1,
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
    // Climbing out of the seabed — the vertical twin of `entering`, and it
    // opens the FLOOR the way that one opens the walls. Separate flags rather
    // than one "arriving" because they suppress opposite clamps, and a body
    // that got both would be free to leave the arena in any direction.
    deep,
    // The depth lane this individual was rolled into, kept so the entrance has
    // somewhere to ease back TO. Read only while the body is still hiding; the
    // moment it is home this is what its z holds anyway.
    laneZ,
    // Does the entrance clamp this one to the water while it comes in? False
    // for a body that is pinned somewhere by its own system — the boat boss
    // rides the waterline, and clampVertical would hold its hull a full radius
    // under it for the whole approach (see attachBossBoat).
    enterClampY: true,
    // Body-level knockback state (crab-vs-crab collisions). `tumble` is a
    // roll offset laid over the locked broadside heading; `tumbleVel` is its
    // angular velocity. Both spring back to zero — see the collision block.
    tumble: 0,
    tumbleVel: 0,
    // The seal's shove, kept apart from vx/vy so no behaviour can overwrite it
    // before it has moved the body. See applyKnockback.
    knockX: 0,
    knockY: 0,
    // How fast that shove bleeds off, and how long this body is knocked off
    // its own stroke for. Both are stamped on by the hit rather than read from
    // CONFIG at integration time, because a heavy knock and an ordinary one
    // are different journeys and a body may be carrying either. Seeded here
    // for the reason every timer in this record is: `undefined - dt` is NaN,
    // and a NaN timer never expires — a fish would be permanently staggered
    // with nothing on screen to say why.
    knockDecay: 0,
    staggerTimer: 0,
    staggerFor: 0,
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
    // A simulated body, for the handful of creatures that get knocked around
    // instead of killed. Null for everything else, and every read of it is
    // guarded — see attachRigidBody.
    body: null,
    // A hitbox fitted to the flesh rather than to `radius`, for the handful of
    // creatures big enough for the difference to be the fight. Null for
    // everything else, and combat falls back to the circle — see
    // systems/hitShape.js and `hitShape` on the def.
    // The asset this individual was actually built from — see `assetKey` in
    // spawnOne. Not `def.asset`, which may be a list.
    assetKey,
    hitShape: def.hitShape ? attachHitShape(visual, assetKey) : null,
  });

  if (def.invincible) makeInvincible(enemies[enemies.length - 1]);
  if (def.rigidBody) attachRigidBody(enemies[enemies.length - 1], def.rigidBody);
}

/**
 * Make a creature genuinely unkillable — the seagrass-and-scenery kind, not the
 * boss's `invuln` timer.
 *
 * DONE BY SEALING `hp` RATHER THAN BY CHECKING A FLAG AT EVERY HIT, because
 * there is no single place a hit goes through. Eighteen systems own the line
 * `e.hp -= something` (combat, club, beams, garlic, elements, shrimpRing,
 * strike, orca, calamari, sealTeam, eel, seagull, …) and a dozen more decide
 * death with `hp <= 0`. A flag consulted at each of them would work exactly
 * until the nineteenth ability was written, and would fail silently then — the
 * turtle would simply start dying to the one weapon nobody remembered.
 *
 * `invuln` is not the mechanism to reuse here either, for the same reason
 * turned inside out: only five systems honour it. Garlic and the club go
 * straight through it, so a turtle wearing `invuln` would still die.
 *
 * Absorbing the WRITE is the one intervention every path already runs through,
 * whatever it is called and whoever writes it next. `e.hp -= 40` reads the
 * floor, subtracts, and writes a smaller number that never lands; `hp <= 0` is
 * never true; nothing dies. The property stays enumerable so anything that
 * spreads or serialises a creature still sees an ordinary number.
 */
function makeInvincible(e) {
  const sealed = e.hp;
  Object.defineProperty(e, 'hp', {
    get: () => sealed,
    set: () => { /* absorbed — that is the whole point */ },
    configurable: true,
    enumerable: true,
  });
  // A plain marker alongside it, so the few places that SHOULD know — the
  // damage ledger, the lethal-splash arm — can ask without probing the
  // property descriptor.
  e.invincible = true;
}

// Give a creature a real body. `profile` names the block under CONFIG.physics
// the numbers come from, so a second creature can be made throwable by adding
// a profile and one field on its def rather than by touching this file.
function attachRigidBody(e, profile) {
  const p = CONFIG.physics?.[profile] ?? {};
  e.body = addBody(new RigidBody({
    kind: profile,
    shape: 'circle',
    owner: e,
    object: e.mesh,
    radius: e.radius,
    // MASS GOES WITH THE SHELL. `mass` is what a nominal one weighs; a body
    // that spawned half again as big is heavier by the square of that, the
    // same rule the crab crowd uses (CONFIG.crabPhysics reads mass off the
    // radius). Without it a scaleVariance of 0.6 would be a paint job: every
    // turtle from the runt to the boulder would take the same punt, fly the
    // same distance and hit a hull for the same damage.
    mass: (p.mass ?? 3) * Math.pow(e.sizeMul ?? 1, p.massExp ?? 2),
    drag: p.drag ?? 0.6,
    angularDrag: p.angularDrag ?? 0.8,
    righting: p.righting ?? 4.5,
    rightingDamping: p.rightingDamping ?? 2.2,
    spin: p.spin ?? 1.6,
    restitution: p.restitution ?? null,
    // It stays in the ocean, and it BOUNCES off the edges of it rather than
    // being clamped: the clamps in the integrator are skipped for bodies
    // precisely so this can own that job.
    walls: true,
    wallRestitution: p.wallRestitution ?? 0.55,
    // A full turn is upright — see wrapAngle. This is what lets it cartwheel
    // and still settle the short way round.
    wrap: true,
    // It rights itself once it has STOPPED, not while it is still flying:
    // the same speed that means "launched" to the integrator means "leave the
    // spring off" to the body.
    rightingSpeed: p.launchSpeed ?? 4,
  }));
  e.body.place(e.mesh.position.x, e.mesh.position.y);
  e.body.restAngle = e.mesh.rotation.z;
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
    // AWAY FROM THE BOSS, while there is one. The pool above deliberately keeps
    // sending food through a boss fight; this is where that food LANDS, and the
    // far wall is the whole difference between a decision and a free top-up.
    // Feeding has to cost you the swim out, the swim back, and a boss whose
    // head never stops tracking you following you the whole way — a school
    // that arrived on top of the fight would just be chum with extra steps.
    const anchor = liveBoss() ? forageSpawnPoint(liveBoss()) : edgeSpawnPoint(def);
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
        // The anchor's ENTRANCE, not just its position — see edgeSpawnPoint.
        // Dropping these was a school that scattered its way back inside the
        // wall, and a deep one that forgot it was supposed to be buried and
        // appeared in mid-water at the height of the seabed.
        side: anchor.side,
        deep: anchor.deep,
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
/**
 * Put a body back outside the picture, for a caller that has just made it
 * bigger.
 *
 * The entrance is sized against the radius, and there is exactly one thing in
 * the game that changes a radius AFTER the spawn: the boss's `sizeMul` (see
 * applyBossScale in systems/boss.js), which multiplies the model and the
 * hitbox together and can nearly double both. So the one creature in the game
 * whose entrance is a moment rather than a detail was the one placed for a
 * body a third of its final size — measured, the shark boss's nose sat two
 * units inside the frame on the spawn frame, which is the pop-in this whole
 * mechanism exists to remove appearing on the only spawn anybody watches.
 *
 * A no-op on a creature that has already come in, so it is safe to call after
 * any resize rather than only after one that happens to be early.
 */
export function pushOffPicture(e) {
  if (!e?.mesh) return;
  if (e.entering) {
    const side = e.mesh.position.x < 0 ? -1 : 1;
    e.mesh.position.x = side * Math.max(Math.abs(e.mesh.position.x), offscreenX(e.radius));
  }
  // Both axes, because the entrance is ROLLED: two spawns in three come
  // through a wall and the third comes up out of the seabed, and a boss that
  // grew after being buried is a boss whose back is sticking out of the floor.
  if (e.deep) e.mesh.position.y = Math.min(e.mesh.position.y, offscreenY(e.radius));
}

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
  // `overfill` is the one door through maxAlive, and exactly one caller has a
  // right to it: the boss.
  //
  // maxAlive is a memory bound rather than a design one, so a single body over
  // it costs nothing — and refusing here costs the entire feature. A boss
  // arrives when the LEVEL says so, in an ocean that is at its most crowded
  // precisely because the player has been farming their way to that level; the
  // arrival then silently does not happen, the retry finds the arena just as
  // full on the next frame, and the marquee spawn of the run is skipped
  // altogether. It is also self-correcting the moment it is used: the first
  // thing a boss does is send everything else home (see clearForBoss), so the
  // overshoot lasts a few seconds and ends well under the cap.
  if (enemies.length >= CONFIG.spawn.maxAlive && !opts.overfill) return null;
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

// ---------------------------------------------------------------------------
// THE FORAGE — small schools during a boss fight
// ---------------------------------------------------------------------------
// A boss fight used to be a closed room. clearForBoss empties the water and
// bossLockout keeps it empty, which is the right frame for the arrival and the
// wrong one for the next ninety seconds: a boss has forty times the health of
// anything else, the player's damage scales off chum, and there is no chum in
// an empty ocean. The fight became a fixed-length dps check you could not
// affect, and every upgrade that reads the water — the magnet, the scavengers,
// the elements that need bodies to chain through — was dead for the duration.
//
// So the water gets a TRICKLE. Not the ordinary spawner turned back on, and
// not escorts: a few small fish at a time, arriving on the far side of the
// arena from the boss, which the player has to decide to go and get.
//
// THE DECISION IS THE FEATURE. The school is placed away from the boss on
// purpose — leaving the fight to feed costs you the distance twice and a boss
// with a head that never stops tracking you follows you the whole way (see
// CONFIG.enemyLook.boss). Placing the fish AT the fight would have been a free
// resource pickup inside the fight, which is the thing that had been missing
// only in the sense that a slot machine is missing a lever.
//
// Separate from updateSpawning's own tap rather than a special case inside it:
// this runs on its own cadence, at its own cap, while the ordinary spawner is
// still fully locked out. Sharing the timer would have meant the trickle
// speeding up with the difficulty curve, and a boss fight at difficulty 30
// filling with fish faster than the player could clear them.
let bossSchoolTimer = 0;

// Which small fry may be sent, as a weighted pool. `lullEligible` is the
// existing rule for "small enough to be a respite rather than a threat" (prey,
// under a radius cap), reused rather than restated so a new little fish added
// to enemies.csv joins the boss forage for free and a new shark can never
// wander into it.
function forageCandidates(difficulty, playerLevel) {
  const pool = [];
  for (const [key, def] of Object.entries(CONFIG.enemies)) {
    if (!lullEligible(def)) continue;
    if (difficulty < (def.minDifficulty ?? 0)) continue;
    if (playerLevel < (def.minPlayerLevel ?? 0)) continue;
    const w = (def.weight ?? 0) * (def.spawnRateMul ?? 1);
    if (w <= 0) continue;
    pool.push({ key, def, w });
  }
  return pool;
}

// A point on the far side of the arena from the boss, at a random depth.
//
// The SIDE is chosen from where the boss is rather than from where the player
// is: the fish should be somewhere the fight is not, and the player is
// (usually) at the fight. Depth stays random so the forage isn't a queue
// arriving at one height.
function forageSpawnPoint(boss) {
  const margin = 1.5;
  const depth = bounds.bottom + margin
    + Math.random() * (bounds.surfaceY - bounds.bottom - margin * 2);
  const bossX = boss?.mesh?.position?.x ?? 0;
  const mid = (bounds.left + bounds.right) * 0.5;
  // Strictly the opposite wall, not the further one by distance — a boss sat
  // exactly on the midline would otherwise flip the answer frame to frame.
  // Past the wall rather than a margin inside it, like every other entrance:
  // the forage is the one spawn the player is most likely to be watching for,
  // and a school that blinks into existence at the far wall is the pop-in this
  // whole mechanism exists to remove.
  const out = offscreenX();
  const side = bossX >= mid ? -1 : 1;
  return { x: side * out, y: depth, side };
}

/**
 * One tick of the forage. Does nothing at all unless a boss is in the water
 * and past its entrance.
 *
 * Ticked from updateSpawning so it stops with everything that stops spawning
 * (the level-up cards, the death dive) and rides the same dt — a trickle that
 * kept running behind an upgrade screen would have the player dismiss a card
 * into a fresh school.
 */
function updateBossForage(dt, scene, difficulty, playerLevel) {
  const cfg = CONFIG.boss?.schools ?? {};
  if (cfg.enabled === false) return;

  // TWO WAYS TO FEED A BOSS FIGHT, AND ONLY ONE OF THEM RUNS.
  //
  // `clearOut.keepFood` keeps the small fry in the ordinary spawner's pool for
  // the whole fight (see pickType), which is the simpler answer and reuses the
  // wave pacing wholesale. This function is the other one: its own cadence, its
  // own cap, deliberately sparse. Both were built, independently, and with both
  // live the water filled to fifteen fish during a fight that was supposed to
  // hold nine — each system spending its budget as if it were the only one.
  //
  // So the pool version wins while it is on, because it is the one the roster
  // gate already routes through, and this one stands down rather than topping
  // it up. The placement rule — away from the boss — was moved into
  // spawnPicked so it applies whichever of the two is feeding, since that is
  // the part that makes the food a decision instead of a handout.
  //
  // Set `keepFood: false` to hand the job back to this function.
  if (CONFIG.boss?.clearOut?.keepFood !== false) return;

  let boss = null;
  let others = 0;
  for (const e of enemies) {
    if (e.isBoss) { boss = e; continue; }
    // Anything on its way out is not company — the clear-out's stragglers are
    // still in the list for a few seconds and would otherwise hold the cap
    // shut for exactly as long as the fight took to start.
    if (!e.leaving) others += 1;
  }

  // No boss: hold the timer at the ready so the first school of the NEXT fight
  // arrives on `firstDelay` rather than instantly, however long the run has
  // been going. A free-running timer would have a school waiting in the wings
  // the moment a boss appeared.
  if (!boss) { bossSchoolTimer = cfg.firstDelay ?? 6; return; }

  // The entrance is a promise that nothing is happening. Fish swimming in
  // under a boss's arrival ceremony reads as the water not having been cleared
  // at all, which is the one beat this whole sequence is built to sell.
  if (boss.invuln > 0) { bossSchoolTimer = cfg.firstDelay ?? 6; return; }

  bossSchoolTimer -= dt;
  if (bossSchoolTimer > 0) return;
  bossSchoolTimer = Math.max(1, cfg.interval ?? 9);

  if (others >= (cfg.maxAlive ?? 10)) return;
  if (enemies.length >= CONFIG.spawn.maxAlive) return;

  const pool = forageCandidates(difficulty, playerLevel);
  if (!pool.length) return;
  let total = 0;
  for (const p of pool) total += p.w;
  let roll = Math.random() * total;
  let picked = pool[pool.length - 1];
  for (const p of pool) { roll -= p.w; if (roll <= 0) { picked = p; break; } }

  const { key, def } = picked;
  const anchor = forageSpawnPoint(boss);
  // A SCHOOL, not a fish — even for a species that normally arrives alone.
  // The point of the trickle is a pocket of chum worth swimming to; one
  // minnow on the far wall is a trip that doesn't pay for itself.
  const min = cfg.minSize ?? 3;
  const max = Math.max(min, cfg.maxSize ?? 5);
  let n = min + Math.floor(Math.random() * (max - min + 1));
  n = Math.min(n, (cfg.maxAlive ?? 10) - others, CONFIG.spawn.maxAlive - enemies.length);
  if (n <= 0) return;

  const id = nextSchoolId++;
  const spread = def.group?.spread ?? (cfg.spread ?? 2.5);
  for (let i = 0; i < n; i++) {
    spawnOne(scene, key, def, difficulty, {
      x: anchor.x + (Math.random() - 0.5) * spread * 2,
      y: anchor.y + (Math.random() - 0.5) * spread * 2,
    }, { schoolId: id, xpMul: cfg.xpMul ?? 1 });
  }
}

// ---------------------------------------------------------------------------
// THE BAIT BALL — putting one in the water
// ---------------------------------------------------------------------------
// systems/baitBall.js decides WHETHER and WHERE; this is the half that needs
// the scene, the roster and the enemy list, and it is deliberately the smaller
// half. See that file for what a bait ball is and why it is a boss-fight
// feature without anything in it naming a boss.
//
// The fish are ORDINARY SMALL FRY — `forageCandidates` again, the same
// weighted pool the boss forage draws from, which is `lullEligible` (prey,
// under a radius cap) filtered by the difficulty and level gates. Nothing about
// a bait ball is a species: it is a state a school is in, which is why a new
// little fish added to enemies.csv joins one for free and a new shark can never
// wander into one.
function updateBaitBallSpawn(dt, scene, difficulty, playerLevel) {
  const boss = liveBoss();

  // How full the water is, bosses excluded and leavers excluded. Both
  // exclusions matter and for the same reason the forage's do: a boss is one
  // body that is never company, and the clear-out's stragglers are still in
  // the list for a few seconds after a fight starts — counting them would hold
  // the emptiness test shut for exactly as long as the arena took to empty,
  // which is the window this is supposed to open in.
  let alive = 0;
  for (const e of enemies) {
    if (e.isBoss || e.leaving) continue;
    alive += 1;
  }

  const spec = updateBaitBallClock(dt, {
    level: playerLevel,
    difficulty,
    // Its ENTRANCE, not just its presence: a ball forming under a boss's
    // arrival ceremony reads as the water not having been cleared at all,
    // which is the one beat that whole sequence is built to sell. Passing null
    // holds the clock rather than spawning without the boss's influence on
    // placement, which is what a bare `invuln` check here would have done.
    boss: boss && boss.invuln <= 0
      ? { x: boss.mesh.position.x, y: boss.mesh.position.y }
      : null,
    // ...and while that boss is still ARRIVING, hold the clock outright. A
    // boss mid-entrance goes in above as `boss: null` — its position is not
    // where it will fight from, so it must not decide which wall the food
    // comes through — and calm water is exactly what the clock would then
    // think it was looking at.
    hold: !!boss && boss.invuln > 0,
    aliveNonBoss: alive,
    maxAlive: CONFIG.spawn.maxAlive,
    bounds,
    offscreenX: offscreenX(),
    player: player.mesh?.position,
  });
  if (!spec) return;
  spawnBaitBall(scene, difficulty, playerLevel, spec);
}

/**
 * Put one ball in the water at `spec`, with no clock and no gates.
 *
 * Split out of the tick above so the dev key can call it (Shift+B in main.js).
 * Waiting for the real thing means a level, a boss, and an arena that happens
 * to be empty — three conditions that only line up minutes apart, which is not
 * a loop anybody can tune a swirl in.
 *
 * @returns the ball, or null if nothing could be spawned.
 */
export function spawnBaitBall(scene, difficulty, playerLevel, spec) {
  const pool = forageCandidates(difficulty, playerLevel);
  if (!pool.length) return null;
  let total = 0;
  for (const p of pool) total += p.w;
  let roll = Math.random() * total;
  let picked = pool[pool.length - 1];
  for (const p of pool) { roll -= p.w; if (roll <= 0) { picked = p; break; } }

  const { key, def } = picked;
  const c = CONFIG.baitBall ?? {};
  // maxAlive is a memory bound and binds here like everywhere else. A ball
  // that arrives half-sized is still a ball; one that overruns the ceiling is
  // a leak with a nice explanation attached.
  const n = Math.min(spec.count, CONFIG.spawn.maxAlive - enemies.length);
  if (n <= (c.disperseAt ?? 3)) return null;

  const id = nextSchoolId++;
  const ball = openBaitBall(id, { ...spec, count: n });

  for (let i = 0; i < n; i++) {
    // SEEDED THROUGH THE COLUMN'S VOLUME. The ball is opened before the fish
    // so baitSeed can scatter them inside the solid the flock is about to hold
    // — dropped in a box and left to sort themselves out, a ball spends its
    // first second visibly assembling, and that second is the one the player
    // is watching it arrive in.
    const at = baitSeed(i, n, ball);
    // NO `side`. Declaring an entrance makes spawnOne push the body out to
    // `offscreenX` on its own (see the `arriving` block there), and that is
    // exactly wrong for a ball: every fish gets pushed to the SAME x, so the
    // column it was just placed as is flattened into a vertical line against
    // the wall, and it then has to swim 16 units to reassemble. Measured — the
    // first two and a half seconds of every ball's life were spent sorting
    // itself out somewhere off screen.
    //
    // Not needed, either. The ordinary spawn already anchors past the wall, so
    // the slot positions are themselves offscreen and spawnOne's geometric
    // fallback sets `entering` from where the body actually is — which is the
    // whole point of that fallback. The forced ball (Shift+B) places on
    // station and correctly gets no entrance at all.
    spawnOne(scene, key, def, difficulty, {
      x: at.x,
      y: at.y,
    }, { schoolId: id, xpMul: c.xpMul ?? 1 });
    const fish = enemies[enemies.length - 1];
    if (!fish) continue;
    fish.baitBall = true;
    fish.mesh.position.z = (fish.laneZ ?? 0) + at.z;
    fish.vz = 0;
    // THE SHIMMER GOES ON THE MATERIAL, once. Every instance of a species
    // shares one, so this is idempotent after the first fish of the first ball
    // that species ever forms — and the shader is gated on distance to a live
    // anchor, so the loose fish of that species elsewhere in the arena, which
    // wear the same material, are untouched. See systems/baitShimmer.js.
    fish.mesh.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) attachBaitShimmer(m);
    });
    // The scale write below only fires on a frame something has changed, and a
    // fish spawning already on the near side of the column is exactly such a
    // frame — without this its first cue would wait for its first orbit.
    fish.__depthDirty = true;
  }

  return ball;
}

/**
 * Where a forced ball goes: the far side of the arena from the seal, on
 * station immediately rather than swimming in from the wall.
 *
 * NOT the ordinary placement, and the difference is the point. The real
 * entrance is a five-second swim from past the wall, which is the right thing
 * in a run and pure dead time when you are pressing the key for the ninth time
 * to look at the swirl. `arriving: false` is set by the caller.
 */
export function devBaitBallSpec(atX = null, atY = null) {
  const c = CONFIG.baitBall ?? {};
  const margin = c.margin ?? 6;
  const px = player.mesh?.position?.x ?? 0;
  const side = px >= (bounds.left + bounds.right) * 0.5 ? -1 : 1;
  const inset = c.stationInset ?? 0.42;
  const x = atX ?? (side < 0
    ? bounds.left + (bounds.right - bounds.left) * inset * 0.5
    : bounds.right - (bounds.right - bounds.left) * inset * 0.5);
  const y = atY ?? (bounds.bottom + margin
    + Math.random() * Math.max(1, (bounds.surfaceY - bounds.bottom) - margin * 2));
  const min = Math.max(1, Math.round(c.size?.min ?? 10));
  const max = Math.max(min, Math.round(c.size?.max ?? 18));
  return {
    count: min + Math.floor(Math.random() * (max - min + 1)),
    x, y, stationX: x, stationY: y, side,
    spin: Math.random() < 0.5 ? -1 : 1,
  };
}

// WHAT LEVEL THE SEAL IS, for CONFIG.spawn.lateGame. Pushed in once a frame
// rather than threaded through every spawn, the same shape and for the same
// reason as setChumDifficulty in entities/pickups.js: creatures arrive from six
// places (the ordinary tap, a boss escort, the boss forage, a bait ball, the
// death pile, a direct spawnNamed from a system) and only some of them have the
// game state to hand.
//
// Starts at 1 and is reset with the roster, so every Node harness that spawns
// without a run around it reads exactly the pre-lateGame numbers — the
// surcharge cannot silently colour a test that never opted into it.
let spawnLevel = 1;
export function setSpawnLevel(level) { spawnLevel = Math.max(1, Math.floor(level ?? 1)); }
export function currentSpawnLevel() { return spawnLevel; }

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

  // THE HELD BREATH, ticked here rather than on main.js's frame delta so it
  // stops with everything else this function stops with — a hush that ran
  // down behind a level-up card would be spent on a menu, and the water would
  // be filling again by the time the player was looking at it.
  //
  // Above the spawn timer, so the hold is not itself paused by a tick that
  // hasn't come due, and returning outright rather than narrowing the pool:
  // nothing arrives, not even the escorts a live boss allows.
  if (spawnHold > 0) {
    spawnHold = Math.max(0, spawnHold - dt);
    return;
  }

  // While a boss is in the water the spawner is throttled rather than stopped:
  // the pool above is already narrowed to escorts plus the small fry, and this
  // is what decides how much of that trickles in. A fight should have something
  // to eat in it without being the best farming window in the run.
  const bossFood = bossLockout() ? (CONFIG.boss?.clearOut?.foodRateMul ?? 0.45) : 1;
  // ...AND THE SCHOOLS ARRIVE THINNED, for the same reason a lull thins them:
  // a school spawns WHOLE regardless of how much room is left, so a single
  // unlucky pick puts fourteen fish in the water and blows straight through the
  // headcount below. The cap bounds the loop; this is what bounds one pick.
  if (bossFood !== 1) {
    wave.groupMul = Math.min(wave.groupMul, CONFIG.boss?.clearOut?.foodGroupMul ?? 0.25);
  }

  // The boss forage. Below the hush (the water is meant to be emptying, and a
  // school arriving into it would undo the clear-out in front of the player)
  // and above the spawn timer, because it keeps its own cadence and the
  // ordinary tap is locked out for the whole fight anyway.
  updateBossForage(dt, scene, d, gameState.level ?? 1);

  // The bait ball, on its own clock beside the forage's and for the same
  // reason: it is not paced by the difficulty curve and must not be. Below the
  // hush, so a ball cannot form into water that is still being emptied for a
  // boss, and above the spawn timer, because the ordinary tap is locked out
  // for the whole fight the ball mostly lives in.
  updateBaitBallSpawn(dt, scene, d, gameState.level ?? 1);

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
    (CONFIG.spawn.baseInterval - d * CONFIG.spawn.intervalPerDifficulty) / (wave.rateMul * bossFood)
  );

  // Budget is in creatures, not spawn events: a school of 12 costs 12, so
  // schooling species can't quietly multiply the intended spawn rate.
  let budget = 1 + Math.floor(d * CONFIG.spawn.countPerDifficulty);
  // Applied after the floor rather than folded into it, so waves switched off
  // (rateMul 1) leaves the original arithmetic bit-for-bit intact.
  if (wave.rateMul !== 1 || bossFood !== 1) budget = Math.max(1, Math.round(budget * wave.rateMul * bossFood));
  // How full the water is allowed to be right now. Under maxAlive for the
  // first stretch of a boss cycle and equal to it by the end — the wave is
  // meant to BUILD after a fight, and a rate limit alone only decides how fast
  // the same crowd assembles. See waveSpawn's aliveFrac.
  //
  // A ceiling on this tick's loop, not a cull: whatever is already in the
  // water stays, exactly as it does through a calm.
  let roomFor = wave.aliveFrac >= 1
    ? CONFIG.spawn.maxAlive
    : Math.min(CONFIG.spawn.maxAlive, Math.max(6, Math.round(CONFIG.spawn.maxAlive * wave.aliveFrac)));
  // A HARD HEADCOUNT DURING A FIGHT, and a rate throttle is not a substitute
  // for one: at 0.45x the water still fills, just more slowly, and a fight that
  // runs a minute ends up with two hundred fish in it — which is the crowd the
  // clear-out exists to remove, arriving through the back door. The cap is what
  // keeps "something to eat" from becoming "the arena refilled during the boss".
  if (bossFood !== 1) {
    roomFor = Math.min(roomFor, Math.max(1, Math.round(CONFIG.boss?.clearOut?.foodMaxAlive ?? 9)));
  }
  let guard = 12;
  while (budget > 0 && guard-- > 0 && enemies.length < roomFor) {
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
//
// `onPlayerBitten(x, y, enemy)` fires on the frame a hunter's jaws actually
// snap at the SEAL, and it is the reason the other two are callbacks: the
// chomp is now the sound of being bitten and nothing else (CONFIG.feedback
// .bite), so the one place that knows a snap was aimed at the player has to be
// able to say so. Optional, like its neighbours — a harness that passes four
// arguments simply gets no bite feedback.
// The animation LOD's counters — see the note at e.anim.update below.
// `animFrame` is the clock every stride is measured against; `phaseCursor`
// hands out slots within a stride, one running count per tier, which is what
// keeps a tier's members from all landing on the same frame.
let animFrame = 0;
const phaseCursor = [];
// The most time a single pose may be asked to advance. Matches the game loop's
// own clamp in main.js and for the same reason.
const MAX_ANIM_DT = 0.05;

// --- what a creature is steering at ----------------------------------------
//
// The player's position, until the player is dead.
//
// Every hunter, chaser, orbiter and school in the game aims at one point, and
// that point does not stop existing when the run ends: the whole death dive was
// watched through a knot of animals converging on the corpse and grinding
// against each other's separation radius.
//
// What relaxes is the TARGET, not the speed. As `deathState.pursuit` falls from
// 1 to 0 (systems/deathDive.js, CONFIG.death.disperse) each creature's aim
// slides off the body and onto a point `lead` units in front of its own nose,
// so it carries on the way it was already going and the knot opens out. Doing
// it here rather than in each behaviour is what makes it uniform: chase, orbit,
// keepDistance, swarm and hunt all steer at ctx.dirX/dirY, and every radius
// gate in them — aggro, orbit distance, the bite reach — releases on its own
// as the distance grows, with nothing to add to any of them.
//
// The BEARING is banked per creature on the frame it lets go, not recomputed:
// read live off the velocity it would curve as the body curves, which is a
// dog chasing its own tail rather than an animal losing interest.
const _quarry = new THREE.Vector3();
function quarryFor(e, playerPos) {
  const hold = deathState.active ? (deathState.pursuit ?? 1) : 1;
  if (hold >= 1) {
    // Cleared here rather than at spawn: this runs for every creature every
    // frame of a live run, so it is the one place guaranteed to see a body
    // that was recycled out of the pool carrying a stale bearing.
    if (e.disperseAngle != null) e.disperseAngle = null;
    return playerPos;
  }
  // The crabs' pile-on is authored and is the last thing you watch — see
  // BEHAVIORS.crawl and CONFIG.death.disperse.keepPile. The exemption lasts
  // exactly as long as the pile does: once the headstone is on the bed they
  // have no business on that spot either, and they let go with everything else.
  if (e.def.crawl?.corpse && (CONFIG.death.disperse?.keepPile ?? true) && !graveHasLanded()) return playerPos;

  if (e.disperseAngle == null) {
    // The way it happens to be going, or — for something barely moving —
    // straight away from the body, which is the only other honest answer.
    const sp = Math.hypot(e.vx, e.vy);
    let hx = sp > 0.05 ? e.vx / sp : 0;
    let hy = sp > 0.05 ? e.vy / sp : 0;
    // ...leaned outward. Half of these are pointed AT the seal at the moment
    // they let go — they were coming for it — and a bearing of "carry on"
    // sends them straight through the body and out the far side, which keeps
    // the knot for as long as it takes them to cross it. A share of the
    // outward radial peels those off without turning the whole thing into
    // twelve animals fleeing a corpse, which is a different (and much worse)
    // read: at 0.35 something already leaving barely bends.
    const ox = e.mesh.position.x - playerPos.x;
    const oy = e.mesh.position.y - playerPos.y;
    const od = Math.hypot(ox, oy) || 1;
    const out = CONFIG.death.disperse?.outward ?? 0.35;
    hx += (ox / od) * out;
    hy += (oy / od) * out;
    if (Math.hypot(hx, hy) < 1e-4) { hx = ox / od; hy = oy / od; }
    e.disperseAngle = Math.atan2(hy, hx);
  }
  const lead = (CONFIG.death.disperse?.lead ?? 44) * (1 - hold);
  _quarry.set(
    playerPos.x + (e.mesh.position.x + Math.cos(e.disperseAngle) * lead - playerPos.x) * (1 - hold),
    playerPos.y + (e.mesh.position.y + Math.sin(e.disperseAngle) * lead - playerPos.y) * (1 - hold),
    0,
  );
  return _quarry;
}

// Predators as plain { x, y } for systems/baitBall.js, which is deliberately
// free of THREE and of this module so its whole pacing can be simulated
// headlessly. Pooled rather than mapped: this runs every frame a ball is alive,
// and a fresh array of eight objects sixty times a second is exactly the kind
// of churn that shows up as a collection pause and nowhere else.
// The live anchors, reused every frame — see the shimmer call in updateEnemies.
const shimmerBalls = [];

const baitThreatPool = [];
function baitThreats(predators) {
  for (let i = 0; i < predators.length; i++) {
    let v = baitThreatPool[i];
    if (!v) { v = { x: 0, y: 0 }; baitThreatPool[i] = v; }
    v.x = predators[i].mesh.position.x;
    v.y = predators[i].mesh.position.y;
  }
  baitThreatPool.length = predators.length;
  return baitThreatPool;
}

export function updateEnemies(dt, scene, playerPos, onChumEaten, onChumHoover, onPlayerBitten) {
  // Advanced once per frame, and the phase every creature's animation stride
  // is measured against. See the LOD note further down.
  animFrame++;
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

  // Bait ball anchors, and they have to move BEFORE the behavior loop for the
  // same reason the crowd does: every fish in a ball steers at the anchor this
  // frame, and one advanced afterwards would have the whole knot chasing where
  // its centre used to be — a lag of exactly one frame, which reads as the
  // ball smearing rather than turning.
  //
  // Fed the school map built just above, so the ball's headcount and the boids'
  // membership can never disagree. Anything it ends comes back as an id, and
  // those fish drop the flag here — the ordinary swarm is what they were before
  // and what they go back to.
  if (baitBalls.size) {
    // EVERY BALL'S MEMBERS AS PLAIN { x, y, z, vx, vy, vz }, once per frame.
    // baitFlock is deliberately free of THREE and of this module's types so a
    // harness can run a whole ball headlessly, and this is the seam that costs.
    //
    // Built HERE rather than inside the behaviour loop because the flock is
    // O(n²) by nature — every fish reads every other — and rebuilding the list
    // per fish would make it O(n³). The view object is the creature's own
    // (`e.ballView`), so a ball of eighteen allocates nothing per frame.
    for (const ball of baitBalls.values()) {
      const mates = schools.get(ball.id);
      if (!mates) { ball.views = null; continue; }
      const views = ball.views && ball.views.length === mates.length ? ball.views : new Array(mates.length);
      for (let i = 0; i < mates.length; i++) {
        const m = mates[i];
        const v = m.ballView;
        v.x = m.mesh.position.x;
        v.y = m.mesh.position.y;
        v.z = m.mesh.position.z - (m.laneZ ?? 0);
        v.vx = m.vx;
        v.vy = m.vy;
        v.vz = m.vz;
        views[i] = v;
      }
      ball.views = views;
    }

    // THE SHIMMER'S UNIFORMS. Driven from here rather than from main.js's
    // render pass because this is the one place that already holds the live
    // anchors — and because it must stop with everything else updateEnemies
    // stops with. A field that kept drifting behind a level-up card would have
    // the water visibly moving in a frozen frame.
    shimmerBalls.length = 0;
    for (const ball of baitBalls.values()) shimmerBalls.push(ball);
    updateBaitShimmer(shimmerBalls, dt);

    const dispersed = updateBaitBalls(dt, {
      schools,
      predators: baitThreats(predators),
      player: playerPos,
      bounds,
    });
    for (const ball of dispersed) {
      const mates = schools.get(ball.id);
      if (mates) {
        for (const m of mates) {
          m.baitBall = false;
          m.vz = 0;
          // Forces one last scale write, which is what puts a survivor back to
          // its own size — see the depth-cue branch in updateEnemies.
          m.__depthDirty = true;
        }
      }
      // HOW THE EXCHANGE WENT, once, on the frame it is answerable. This is
      // the only readout of the mechanic there is: while a ball is alive the
      // split between the two sides is invisible — a boss eating four while
      // you take nine looks identical to the reverse — and a frame later the
      // fish are gone and the question cannot be asked at all. Dev only; see
      // CONFIG.baitBall.log.
      if (CONFIG.baitBall?.log) console.log(`[bait] ${baitBallLedger(ball)}`);
    }
  }

  // Who gets to press the player this frame, and who holds the ring. Must run
  // before the behavior loop below — every hunter's steering reads the answer.
  refreshApexCrowd(dt, playerPos);

  for (const e of enemies) {
    // Not `playerPos` while the water is letting go of a corpse — see quarryFor.
    // `ctx.playerPos` stays the REAL body: it is read by the things that want to
    // know where the seal actually is (the crabs' floor rush, the pile-on's own
    // branch), as against the things that want to know where to swim.
    const at = quarryFor(e, playerPos);
    const dx = at.x - e.mesh.position.x;
    const dy = at.y - e.mesh.position.y;
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
    if (e.trapTimer > 0) e.trapTimer = Math.max(0, e.trapTimer - dt);
    // ...and the boss's version of both. Ticked here beside them rather than in
    // a pass of its own, because it is a status on a body exactly as they are
    // and a second walk of the enemy list to age one number would be a walk for
    // nothing. It does NOT gate the behaviour below: a dazed boss keeps
    // steering — badly, and slowly — which is the whole difference between a
    // daze and a hold.
    tickDaze(e, dt);
    // LAUNCHED. A body travelling faster than it could ever swim is not
    // swimming — it is cargo, and it stops steering until it has slowed down
    // to something it could have done under its own power. Without this the
    // turtle paddles serenely along its wander heading while cartwheeling
    // across the arena, which reads as an animation playing on a moving
    // object rather than as an animal that has been hit by a truck.
    const launched = e.body ? e.body.speed() > launchSpeed(e) : false;
    if (launched) {
      // Its own swimming bleeds off rather than being zeroed, so the moment it
      // slows back down it is already moving the way it was pointed.
      const bleed = Math.exp(-2.5 * dt);
      e.vx *= bleed;
      e.vy *= bleed;
    } else if (e.trapTimer > 0 || e.charmTimer > 0) {
      e.vx = 0;
      e.vy = 0;
    } else {
      // Settled: forget who the last launch barged through, so the next punt
      // into the same school shoves it again.
      if (e.plowed) e.plowed = null;
      // LEAVING BEATS EVERY BEHAVIOUR. A creature on its way out has stopped
      // being a fish with a job — it is not hunting, wandering, orbiting or
      // holding a band any more, it is going. This used to live inside the
      // drift behaviour, which meant `leaving` did nothing at all for the
      // other nine: the sweep that removes a departed creature is global, so
      // marking a shark as leaving simply left it hunting you forever while
      // the code that was supposed to send it away looked like it existed.
      // A BOSS PERK BEATS EVEN LEAVING. `perkDrive` means systems/bossPerks.js
      // has already written this frame's velocity — a wind-up holding the body
      // still, or a dash committing it down a line — and running the creature's
      // own steering on top would overwrite both. It sits above `leaving`
      // rather than below it because the only creature that can carry it is
      // the boss, and a boss is never leaving.
      if (e.perkDrive) { /* velocity is the perk's this frame — see systems/bossPerks.js */ }
      else if (e.leaving) steerOut(e, dt);
      else (BEHAVIORS[e.def.behavior] ?? BEHAVIORS.chase)(e, dt, ctx);
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
    // `grabbing` is the fourth gate and the newest: an animal that already has
    // the seal in its mouth must not keep snapping at it. The jaws are shut —
    // that is what a grab IS — and a chomp playing over the top would both
    // re-open them on screen and offer main.js a second chance to bill the
    // bite. See systems/bossGrab.js.
    if (e.def.hunt && !e.hunting && !e.grabbing && e.biteCooldown <= 0) {
      const reach = playerBiteReach(e) * (CONFIG.bite.lead ?? 1);
      // triggerBite returns whether the snap actually fired (it is rate-limited
      // by the species' own eat cooldown), so the chomp lands on the frame the
      // jaws move rather than on every frame the seal is inside the reach.
      if (ctx.dist < reach && triggerBite(e)) {
        onPlayerBitten?.(e.mesh.position.x, e.mesh.position.y, e);
      }
    }

    // CHILL scales the STEP, not the steering. Applied at the integrator so it
    // reaches every behaviour at once — chase, flock, crawl, porpoise — without
    // each having to know the element exists, and so a chilled hunter still
    // turns to face you at full rate while crawling toward you at a fraction of
    // its speed. Slowing the steering instead would read as a fish that had
    // lost interest, which is a different feeling entirely.
    // THE DAZE'S WEAVE, applied to the VELOCITY rather than to the step below —
    // a body has to be pointed where it is going or the facing (which is read
    // off the direction of travel) says it is still tracking you while it
    // slides off sideways. A turn rate, so the heading wanders as the integral
    // of a slow swing and the creature's own steering can fight it back;
    // written into vx/vy for the same reason chill is NOT, which is that this
    // is a change of course and chill is a change of pace. Skipped entirely
    // while a perk is driving the body — see dazeSpeedMul.
    const veer = dazeVeer(e) * dt;
    if (veer !== 0) {
      // THE HEADING IS WHERE THIS HAS TO LAND, and it is the whole reason this
      // is three lines rather than one. Every shark and every boss is
      // TURN-LIMITED: steerTo re-derives vx/vy from `e.heading` on the next
      // frame (see the turnRate branch there), so a rotation applied only to
      // the velocity is overwritten before it has moved the animal anywhere —
      // measurably nothing, which is exactly how it read when it was written
      // that way. Pushing the heading instead makes the daze a tug of war with
      // the creature's own turn rate, which is the picture: it is trying to
      // come back onto you and only half managing it.
      if (e.heading != null) e.heading += veer;
      // ...and the velocity as well, so the frame already in flight veers too
      // rather than waiting a frame, and so creatures with no turn limit (the
      // lerp branch in steerTo) get the same treatment.
      const cos = Math.cos(veer);
      const sin = Math.sin(veer);
      const vx = e.vx * cos - e.vy * sin;
      e.vy = e.vx * sin + e.vy * cos;
      e.vx = vx;
    }

    const chill = e.chillTimer > 0 ? 1 - e.chillSlow : 1;
    // ...and the daze's slow, at the same place and for the same reason chill
    // is: a tax on the step, not on the decision.
    const daze = dazeSpeedMul(e);
    // ...and the ram's. A big body that has just been shoved is off its stroke
    // for a moment, ramping back in rather than switching on — see
    // CONFIG.strike.knockback.heavy. Without this the shove below is added to
    // an animal still swimming at full speed in the direction it chose, and
    // most of a ram on a shark is spent cancelling the shark.
    let stagger = 1;
    if (e.staggerTimer > 0) {
      e.staggerTimer = Math.max(0, e.staggerTimer - dt);
      const share = e.staggerFor > 0 ? e.staggerTimer / e.staggerFor : 0;
      stagger = 1 - (CONFIG.strike?.knockback?.heavy?.staggerSlow ?? 0.85) * share;
    }
    e.mesh.position.x += e.vx * chill * daze * stagger * dt;
    e.mesh.position.y += e.vy * chill * daze * stagger * dt;

    // THE SEAL'S SHOVE, integrated on top of whatever the steering asked for
    // and decaying exponentially back to nothing. Added here rather than into
    // vx/vy for the reason applyKnockback spells out: three different
    // behaviours own that field in three different ways, and two of them
    // assign it outright.
    //
    // NOT scaled by `chill`: the shove is the seal's momentum arriving, not
    // the creature's own swimming, and a frozen body should if anything slide
    // further. It is also what makes a chilled shark still visibly get hit.
    if (e.knockX || e.knockY) {
      e.mesh.position.x += e.knockX * dt;
      e.mesh.position.y += e.knockY * dt;
      // The falloff the hit that landed it chose, so a heavy throw carries and
      // an ordinary knock is over in a moment. Falls back to the shared decay
      // for a shove that arrived from somewhere that never stamped one on.
      const drop = Math.exp(-(e.knockDecay || CONFIG.strike?.knockback?.decay || 5.5) * dt);
      e.knockX *= drop;
      e.knockY *= drop;
      if (Math.abs(e.knockX) < 0.01) e.knockX = 0;
      if (Math.abs(e.knockY) < 0.01) e.knockY = 0;
    }
    // THE ENTRANCE, driven on the POSITION rather than on the velocity.
    //
    // A nudge into vx would not survive the frame: half the roster re-derives
    // its velocity from a heading every tick (see the turnRate branch in
    // steerTo), so a body told to swim in would be told to swim at the player
    // again before it had moved. And an entrance cannot be left to the
    // behaviours — a schooling fish placed outside the wall will happily boid
    // its way further out to sea, and `entering` has opened the wall that would
    // have turned it back.
    //
    // A FLOOR under its own swimming, not a replacement for it: anything
    // already coming in faster than this keeps its own speed, and the creature
    // that is doing nothing useful still arrives. That is also what bounds how
    // long an arrival can take, which is what the boss's entrance is timed
    // against (see systems/boss.js).
    //
    // `leaving` outranks both, and has to: the two pull in opposite directions,
    // and every clamp below reads them in a fixed order — a body told to go
    // that was still flagged as arriving would be walked back into the arena
    // it is trying to leave, and a `deep` one would be held under a floor it
    // had stopped climbing out of and never removed at all. Dropped here, once,
    // rather than guarded at each of the four sites that read them.
    if (e.leaving && (e.entering || e.deep)) {
      e.entering = false;
      e.deep = false;
    }
    if (e.entering || e.deep) {
      const drift = entranceCfg().driftSpeed ?? 7;
      const r = e.radius;
      if (e.entering) {
        const inward = e.mesh.position.x < 0 ? 1 : -1;
        const own = e.vx * inward;
        if (own < drift) e.mesh.position.x += inward * (drift - own) * dt;
        // ARRIVED, and the flag only ever clears, so it cannot slip back out
        // later. Decided HERE rather than down in the clamp chain, which is
        // where it used to live: that chain's first branch belongs to bodies
        // with their own physics, so a simulated creature — the sea turtle is
        // the one — never reached the test at all and stayed flagged as
        // arriving for the rest of its life, permanently exempt from the wall
        // it had long since swum through.
        if (e.mesh.position.x > bounds.left + r && e.mesh.position.x < bounds.right - r) {
          e.entering = false;
        }
      }
      if (e.deep) {
        if (e.vy < drift) e.mesh.position.y += (drift - e.vy) * dt;
        if (e.mesh.position.y > seabedTopY() + r) e.deep = false;
      }
    } else if (e.baitBall) {
      // SWIMMING THROUGH DEPTH. Integrated from the flock's own vz rather than
      // eased toward a lane: the easing below is speed-limited to
      // `emergeSpeed` and would smear a fish's whole orbit into a lag.
      //
      // Clamped to the ball, so a fish that has been shoved cannot end up
      // behind the seabed backdrop or in front of the camera. Left to the
      // easing on the frame the ball ends: `baitBall` goes false, this branch
      // stops matching, and the survivor glides home to its lane over the same
      // distance any other creature would.
      const reach = (CONFIG.baitBall?.radius ?? 1.7) * 2;
      const lane = e.laneZ ?? 0;
      e.mesh.position.z = Math.max(lane - reach, Math.min(lane + reach,
        e.mesh.position.z + e.vz * dt));
    } else if (e.laneZ != null && e.mesh.position.z !== e.laneZ) {
      // HOME, and easing back into its lane. Invisible while it happens — the
      // camera is orthographic, so this changes nothing but draw order — and
      // it happens over a distance rather than instantly so that the one thing
      // it CAN change, which creature sorts in front of which, does not
      // resolve as a snap on a single frame.
      const step = (entranceCfg().emergeSpeed ?? 6) * dt;
      const gap = e.laneZ - e.mesh.position.z;
      e.mesh.position.z = Math.abs(gap) <= step ? e.laneZ : e.mesh.position.z + Math.sign(gap) * step;
    }

    // A SIMULATED BODY takes over from here. Its own swimming has already been
    // integrated above, so this hands the result to the body as "where my
    // locomotion left me"; the physics step (systems/rigidBody.js, run once
    // per frame from the game loop) adds the shove, resolves what it hit,
    // bounces it off the arena and writes the position back onto the mesh.
    //
    // The clamps below are skipped for exactly that reason: they would fight
    // the body's own walls, and a clamp beats a bounce — the creature would be
    // parked against the surface with its velocity still pointing up.
    if (e.body) {
      e.body.place(e.mesh.position.x, e.mesh.position.y);
      // The walls open once it has turned for open water, and close again if
      // anything changes its mind — a body that could leave whenever it liked
      // would be one strike away from being punted out of the arena. They are
      // open on the way IN for the same reason: a body placed past the wall
      // with its own walls shut is one the physics step shoves into the arena
      // on frame one, which is the pop-in the entrance exists to remove
      // arriving through the one door that does not go through clampToArena.
      e.body.escaping = e.leaving || e.entering || e.deep;
      // BOWLING. A body travelling at speed shoves whatever it passes through
      // — no damage, so this can never quietly become a second damage source,
      // but a punted turtle scattering a school on its way to a hull is the
      // cheapest chain reaction in the game and the one that reads best.
      if (launched) plowThrough(e, dt);
    // `canBreach` creatures are allowed above the water line — the porpoise
    // arc IS the jump, and clamping here would flatten it against the
    // surface. They still get the horizontal/floor limits below.
    } else if (e.entering) {
      // Still walking on from the wings: vertical limits only. Once it is
      // fully inside the walls it becomes a normal, boxed-in creature — and
      // because the flag only ever clears, it can't slip back out later.
      //
      // `enterClampY` is off for a body that is pinned somewhere by its own
      // system. The boat boss rides the waterline, and this clamp holds a
      // creature a full radius BELOW it — on a hull four units across that is
      // the boat fighting its whole entrance from underwater, which is the
      // exact shape of a bug that looks like a design choice.
      if (e.enterClampY !== false) clampVertical(e.mesh.position, e.radius);
    } else if (e.deep) {
      // Climbing out of the seabed: the FLOOR is the limit that has to stay
      // open, and everything else still binds. Cleared once the whole body is
      // clear of the strip it was buried under, which is the same "fully out
      // of the scenery" test the walls use one branch up.
      const r = e.radius;
      const ceiling = bounds.surfaceY - r;
      if (e.mesh.position.y > ceiling) e.mesh.position.y = ceiling;
      if (e.mesh.position.x < bounds.left + r) e.mesh.position.x = bounds.left + r;
      if (e.mesh.position.x > bounds.right - r) e.mesh.position.x = bounds.right - r;
    } else if (e.leaving) {
      // ON ITS WAY OUT — the exact mirror of `entering`, and for the same
      // reason: the side walls have to open or there is nowhere to go.
      //
      // This is what the `leaving` flag was missing. The sweep that removes a
      // departed creature waits for it to cross the arena edge, and the wall
      // clamp here pins every swimmer a radius inside that edge — so a marked
      // creature swam into the wall and stayed there forever, alive and
      // unremovable. It looked like it worked, because the one creature that
      // ever used the flag (the sea turtle) has a rigid body, and a body opens
      // its own walls through `escaping` a few lines above.
      clampVertical(e.mesh.position, e.radius);
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
    // `faceLocked` is a system saying it is writing the heading itself this
    // frame — the same handoff `perkDrive` makes for the velocity, and needed
    // for the same reason. The speed gate below used to be the whole handoff,
    // which works only while "a system is driving" and "the body is moving" are
    // the same thing. They are not: systems/bossAngler.js holds the anglerfish
    // on the seabed and settles it there at several units a second, so both
    // writers were live on the same frames — one aiming the head at the seal,
    // this one aiming it at the fish's own descent — and the body snapped
    // between the two every frame.
    } else if (e.def.faceMotion && !e.faceLocked) {
      if (Math.hypot(e.vx, e.vy) > 0.05) {
        const heading = Math.atan2(e.vy, e.vx) - Math.PI / 2;
        // With a body, the heading is the REST pose the physics roll is laid
        // on top of (see RigidBody.restAngle) — assigning rotation.z here
        // instead would erase the tumble every frame, which is the one thing
        // that must survive. It is also frozen while the body is flying: a
        // turtle cartwheeling across the arena has no business snapping to
        // face its own drift, and the angle it holds is exactly what the
        // righting spring is visibly unwinding back to.
        if (e.body) {
          if (!launched) e.body.restAngle = heading;
        } else {
          e.mesh.rotation.z = heading;
        }
        // Turned, not flipped. This was `rotation.y = vx < 0 ? PI : 0`, which
        // is an animal swapping ends between two frames — barely visible on a
        // sprat and increasingly silly the bigger and slower the body is, which
        // is exactly backwards, because the big slow ones are what the player is
        // watching. See systems/facing.js; the deadzone in there is also what
        // stops a creature hovering near zero horizontal speed from flickering.
        if (CONFIG.view === 'side' && !launched) faceSide(e.visual, e.vx, dt);
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

      // `animState` is the locomotion equivalent of `perkDrive`: a system that
      // has taken the wheel says which state the body is IN, rather than having
      // it inferred from how fast the body happens to be moving. An ambushing
      // anglerfish is the case that needs it — it holds station at zero speed
      // while very much not idling, and stateForSpeed would put it in `idle`
      // during the lunge wind-up, which is the one frame the player must be
      // able to read. Nothing sets it by default, so every other creature
      // takes the speed-derived state exactly as before.
      // HOW OFTEN THIS BODY IS POSED.
      //
      // Every creature in the water used to be posed on every frame — mixer,
      // procedural wag and bone springs — regardless of how big it was on
      // screen. At a full house that is `spawn.maxAlive` (220) skeletons
      // solved sixty times a second, and the recorded runs say the cost of it
      // is real: frame rate falls with population on a phone at 1.4 megapixels
      // exactly as steeply as on a laptop at 6.0, which is only possible if
      // what grows is per-CREATURE and not per-pixel.
      //
      // The arena is 80 units across in an orthographic camera, so a reef fish
      // a unit wide is around 2% of the screen — thirty-odd pixels. Thirty
      // pixels does not need sixty poses a second, and this is the whole idea:
      // pose the small bodies less often and hand them the time that has
      // passed since they were last posed, so the clip still plays at its
      // authored SPEED and only its temporal resolution drops.
      //
      // Three things are exempt, and each of them is a moment the player is
      // meant to be reading:
      //   a BOSS         the thing the fight is about, and the only body on
      //                  screen big enough for 20Hz to be visible as stepping.
      //   a ONE-SHOT     a death, a bite, a flinch. A performance with a
      //                  beginning and an end reads as a glitch if it steps.
      //   a HIT          the frame a creature is struck. The flinch has to
      //                  start on the frame the pellet landed or the feedback
      //                  detaches from the shot that caused it.
      //
      // `e.radius` AND NOT `def.radius * sizeMul`, which is the trap here and
      // gets the answer backwards on exactly the bodies that matter.
      //
      // `sizeMul` is only the run's growth times this individual's size roll —
      // the asset's own fit is deliberately factored out of it (see the note
      // where it is stored). `spawnScale` is the one that carries the fit, and
      // some of those are large: the turtle's asset alone is 3.08x. Since
      // `e.radius` is `def.radius * spawnScale`, it is the only field that
      // describes how big this body actually IS on screen — which is why
      // every collision test in the file reads it too.
      //
      // Tiering on `def.radius * sizeMul` instead would have put the turtle at
      // about 1.0 rather than 3.08 and quietly dropped the pose rate on the
      // big, slow, highly readable animals while leaving the schooling fish
      // alone. Precisely the wrong way round.
      const lod = CONFIG.animation.lod;
      let stride = 1;
      if (lod?.enabled && !e.isBoss) {
        const size = e.radius ?? 0;
        if (size < (lod.tinyRadius ?? 0)) stride = lod.tinyStride ?? 1;
        else if (size < (lod.smallRadius ?? 0)) stride = lod.smallStride ?? 1;
      }

      // WHICH of a stride's frames this body takes, and the reason it is not
      // simply the spawn order.
      //
      // A running counter looks like it spreads the roster and does not: the
      // spawn index decides the SPECIES as well as the slot, so a tier whose
      // members happen to land on one residue class all pose on the same
      // frame. Three frames of nothing followed by one that poses the whole
      // school is the same total work delivered as a periodic 3x spike —
      // exactly the hitching this exists to remove, wearing the costume of a
      // fix. A round-robin PER TIER cannot alias that way: each tier hands out
      // its own slots in turn, so its members are spread evenly across its own
      // stride no matter what order they spawned in or what else spawned
      // alongside them.
      //
      // Keyed on the size tier and not on the stride actually used this frame,
      // because the exemptions below force the stride to 1 on scattered frames
      // and re-rolling the slot every time one fired would leave the schedule
      // permanently churning.
      if (e.animTier !== stride) {
        e.animTier = stride;
        e.animPhase = stride > 1 ? (phaseCursor[stride] = (phaseCursor[stride] ?? 0) + 1) % stride : 0;
      }

      const due = stride <= 1 || (animFrame + e.animPhase) % stride === 0;
      // The three exemptions, each of them a moment the player is reading. A
      // forced pose does NOT consume the scheduled one — the body simply gets
      // both, which costs a frame of work and keeps the stagger intact.
      const forced = e.hitThisFrame || e.anim.isPlayingOneShot();

      e.animDt = (e.animDt ?? 0) + dt;
      if (due || forced) {
        // Clamped exactly as the game loop clamps its own delta. The springs
        // are semi-implicit Euler and stable to about dt = 0.2s at the
        // stiffness they run at (90), so three frames is a wide margin — but a
        // tab returning from the background must not hand them half a second.
        e.anim.update(
          Math.min(e.animDt, MAX_ANIM_DT),
          e.animState ?? stateForSpeed(speed),
          e.hitThisFrame,
        );
        e.animDt = 0;
        // Only on a frame that actually posed, so a hit landing on a skipped
        // frame is still delivered on the next one — though `forced` above
        // means that frame is always this one.
        e.hitThisFrame = false;
      }
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
      // A BOSS LOOKS AT THE PLAYER, whatever it is steering at.
      //
      // For every other hunter those are the same thing and the look target is
      // the honest one: a shark that has decided to eat a mackerel should be
      // looking at the mackerel. A boss has no second quarry — the water was
      // emptied for it — and the moments it ISN'T steering at the player are
      // exactly the ones where the head must not wander: mid-lunge it is
      // committed to a line the player has already dodged out of, on a
      // standoff arc it is deliberately swimming past them, and during the
      // clear-out there is briefly nothing else in `lookTarget` at all. In all
      // three the head staying locked on is what says the fight is still about
      // you. See CONFIG.enemyLook.boss for the profile that carries it.
      // AND A HUNTER WITH NOTHING TO CHASE PEEKS AT YOU. `lookTarget` is what
      // the creature is steering at, which is null far more often than it
      // sounds — cruising, wandering, between meals — and a head that only
      // moves while something is being chased is a head that is still most of
      // the time. Falling back to the player is the peek: it costs nothing,
      // it is the most interesting thing on the screen to look at, and it is
      // the difference between a fish swimming past and a fish that has
      // noticed you swimming past.
      //
      // Safe to point at from anywhere because the rig gates itself on RANGE
      // as well as angle (see coneGate and the range fade in headLook.js) — a
      // shark forty units away does not turn its head, it just carries on,
      // which is exactly the "staring across the arena looks possessed" case
      // that gating exists for.
      const target = e.isBoss ? playerPos : (e.lookTarget ?? playerPos);
      e.look.update(dt, target, {
        suppressed: e.anim?.isPlayingOneShot() ?? false,
        boss: !!e.isBoss,
      });
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
      // Through clawSetting, so the king crab's own block (CONFIG.enemies
      // .bossCrab.claw) reaches this without the swarm's numbers moving — and
      // so that this gate and the damage check in systems/combat.js are still
      // reading one set of numbers between them.
      if (e.pinchTimer > 0) e.pinchTimer -= dt;

      // A crab does not pinch at a corpse. The death pile-on is the last thing
      // you watch, and a heap of crabs snapping at a body that cannot react
      // reads as them eating it — which is what the pile already says, more
      // quietly. Also skipped while trapped or charmed, for the same reason
      // combat.js skips those: a bubbled crab is frozen, harmless.
      const canPinch = !!clawSetting(e.def, 'enabled')
        && !deathState.active
        && e.trapTimer <= 0
        && e.charmTimer <= 0;

      // COMMIT range is deliberately tighter than the range the pinch reaches
      // at. A crab that starts a windup at the exact edge plays the whole
      // 0.9s gesture at a player who has already drifted out of it.
      //
      // Through pinchReach, so this measures the same way the damage half in
      // systems/combat.js does — see the note there. `ctx.dist` is centre to
      // centre, and the seal's body is a whole world unit of it; leaving that
      // out is what killed the mechanic the first time, when the crab's hitbox
      // shrank. The reach comes off the ARM rather than off `e.radius` — a
      // 0.2-unit hitbox on a six-unit crab put this gate 0.22 units outside
      // contact, which is the second way the same mechanic died. Asked of the
      // driver every frame rather than cached on the creature: it measures
      // once and returns the same number after, and a copy on `e` is one more
      // thing to go stale.
      // CONFIG.player.hitRadius rather than the live stat because stats.js
      // copies it through unmodified and no upgrade writes it — if one ever
      // does, this is the line that has to be handed player.stats instead.
      // The gate is measured inside the guard rather than beside it so the
      // short-circuit is kept: `reach()` warns loudly when it measures nothing,
      // and a crab that is dead, trapped or charmed would otherwise ask it
      // sixty times a second for an answer nobody is going to use.
      const pinchGate = canPinch && e.pinchTimer <= 0 && !e.claw.isStriking()
        ? pinchReach(e.claw.reach(), CONFIG.player.hitRadius,
          clawSetting(e.def, 'commitRange') ?? 0.55)
        : 0;
      if (pinchGate > 0 && ctx.dist < pinchGate) {
        // WANTING IT MORE THE CLOSER YOU ARE — see CONFIG.crabClaw.eager.
        //
        // The cooldown is the crab's authored one at the very edge of its reach
        // and a fraction of it once the seal is in among the legs. One flat
        // number could not be both, and the one that was here was tuned for the
        // far end, which made standing on top of a crab no worse per second
        // than standing beside it — on the one animal in the game whose entire
        // threat is how far its arms get.
        //
        // Measured against the SAME gate the commit was just tested on, so this
        // scales with the arm rather than with a world constant: a king crab
        // and a swarm crab both go eager at the same fraction of their own
        // reach, and a crab that has grown over a run brings its band with it.
        const eager = CONFIG.crabClaw?.eager;
        let mul = 1;
        if (eager?.enabled !== false) {
          const near = Math.min(0.999, Math.max(0, eager?.nearAt ?? 0.4));
          // 0 at the gate's edge, 1 at `nearAt` and everywhere inside it.
          const t = Math.min(1, Math.max(0, (1 - ctx.dist / pinchGate) / (1 - near)));
          mul = 1 + ((eager?.nearCooldownMul ?? 0.3) - 1) * t;
        }
        if (e.claw.strike()) e.pinchTimer = (clawSetting(e.def, 'cooldown') ?? 2.6) * mul;
      }

      // Aim at the player in the PLAY PLANE, not at their exact position: the
      // crab sits at its own depth (enemies.walkingCrab.depthSpread scatters
      // them in z) and reaching to that z would have the claw swipe in front
      // of or behind the seal rather than at it.
      _clawAim.set(playerPos.x, playerPos.y, 0);
      e.claw.update(dt, canPinch ? _clawAim : null);
      e.justPinched = e.claw.didConnect();

      // THE SWING OWNS THE ARM WHILE IT IS SWINGING, and the flinch gets it
      // back afterwards.
      //
      // Both cheliped chains carry a spring (CRAB_RIG's `claw` role) so that a
      // crab which gets shot shudders through its arms. Those are the same
      // bones the solver above just aimed, and under sustained fire the shove
      // is far larger than the gesture: measured on the king crab at 12 hits a
      // second, the claw tip sat 9.7 world units off the pinch's line on an arm
      // 7.9 units long. The pinch was running perfectly and read as flailing.
      //
      // This is the crab's version of an attack clip out-ranking a flinch clip
      // (see ATTACK_STATES in systems/animation.js) — the crab has no clips to
      // resolve it with, so the spring is muted instead. Set from the driver's
      // own answer rather than from a timer, so it covers exactly the windup,
      // the strike and the recover and not a frame more.
      e.anim?.muteSpring('claw', e.claw.isStriking());
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
    // The dead time between grabs — see systems/bossGrab.js. Ticked here beside
    // every other per-creature clock rather than inside that file, so it runs
    // whether or not anything is currently held and cannot get stuck full on a
    // boss whose grab ended for an odd reason.
    if (e.grabCooldown > 0) e.grabCooldown -= dt;

    // Hit pop: a quick scale punch so damage reads even in a crowd. Scales
    // the size the creature actually IS (spawn scale x however much it has
    // grown), so the punch is a relative bump rather than a jump to a fixed
    // absolute scale.
    if (e.flash > 0) {
      e.flash = Math.max(0, e.flash - dt);
      const t = e.flash / Math.max(CONFIG.fx.hitFlash, 0.0001);
      e.visual.scale.setScalar(e.spawnScale * e.baseScale * e.depthScale * (1 + CONFIG.fx.hitPop * t));
    } else if (e.depthScale !== 1 || e.__depthDirty) {
      // THE COLUMN'S DEPTH CUE. Written here, in the same place and off the
      // same three factors as the hit-pop above, because two systems each
      // calling setScalar with their own idea of the total is two systems
      // deleting each other's work every other frame — a fish in a ball would
      // have snapped to flat size for the length of every hit it took.
      //
      // The `!== 1` test is what returns a dispersed ball's survivors to their
      // proper size exactly once: baitFlock stops writing depthScale, the
      // reset below puts it back to 1, this fires on that frame and then never
      // again for that fish.
      // Cleared BEFORE the write, not after: on the frame a ball disperses the
      // scale still holds the last orbit's cue, and clearing afterwards would
      // write that stale value and then never fire again — leaving a survivor
      // permanently 28% too big or too small, with nothing on screen to say
      // why.
      if (!e.baitBall) e.depthScale = 1;
      e.visual.scale.setScalar(e.spawnScale * e.baseScale * e.depthScale);
      e.__depthDirty = false;
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

  // GONE. Anything that swam out under its own power, removed after the loop
  // above rather than from inside it: that loop is a for-of over this very
  // array, so splicing mid-pass would skip the creature standing behind the
  // one that left. No death, no chum, no kill credit — it did not die, it
  // went somewhere else.
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (!e.leaving) continue;
    const margin = e.radius + 4;
    if (e.mesh.position.x < bounds.left - margin || e.mesh.position.x > bounds.right + margin) {
      removeEnemy(scene, i);
    }
  }
}

export function removeEnemy(scene, index) {
  const e = enemies[index];
  if (!e) return;
  // The body outlives the creature otherwise: the physics world holds its own
  // reference, so a body left behind is an invisible obstacle in the water
  // that other bodies keep bouncing off.
  if (e.body) removeBody(e.body);
  // A BOSS BEING KEPT FOR THE PHOTOGRAPH. systems/bossCorpse.js has taken
  // ownership of the visual and the hitbox for the second or so the kill shot
  // needs a body in the frame, and it gives both back itself when the body
  // finally comes apart. Releasing them here would hand a pooled visual out to
  // the next creature while the corpse is still drawing with it — the boss
  // would turn into a mackerel mid-shot.
  //
  // It still leaves `enemies` on this frame, exactly like any other death: the
  // hold is about what is on screen, not about what is alive.
  if (e.corpseHeld) {
    enemies.splice(index, 1);
    return;
  }
  // The body goes back to the pool rather than to the garbage collector. This
  // is also where the leak was: scene.remove takes a mesh out of the graph, and
  // WebGL frees nothing on JS garbage collection, so every dead creature's bone
  // texture stayed resident for the life of the page — 1,466 of them by the end
  // of a nine-minute run. A pooled body is never disposed because it is never
  // thrown away; one past the cap is disposed properly on the way out.
  // The measured hitbox rides the body, so it goes back to the pool with it —
  // marked dead rather than dropped, because anything still holding a wound
  // anchored to one of its spheres has to be able to tell that the animal it
  // was stuck to is gone. See systems/hitShape.js.
  releaseHitShape(e.hitShape);
  releaseVisual(e.visual);
  scene.remove(e.mesh);
  enemies.splice(index, 1);
}
