import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createVisual } from '../assets.js';
import { removeEnemy } from '../entities/enemies.js';
import { boats, damageBoat, hitsBoat } from './boats.js';
import { nearestFloatingCrew, crewPosition, crewRadius, eatCrew } from './crew.js';
import { createAnimationController, stateForSpeed } from './animation.js';
import { targeting, companionDamage, applyCompanionScale } from './scaling.js';
import { markWeight } from './marks.js';
import { player } from '../entities/player.js';

// Orca Family — a pod of three that swims with the seal and peels off, one at
// a time, to hit the BIG things: surface boats first, then large fish.
//
// Boats are the threat the rest of the arsenal handles worst. They sit up at
// the waterline, out of the way of the fight the seal is actually in, and chip
// away while you're busy below; dealing with one means breaking off, swimming
// up, and spending time where the fish aren't. Every other companion targets
// whatever is nearest, which in practice always means fish.
//
// So this pod deliberately looks PAST fish. Boat first, every time, out to
// `huntRange`; fish only when there is no boat left to hunt, and even then
// only fish above `fallbackMinRadius`, so it never degenerates into a third
// seal team mopping up minnows.
//
// The pod is fixed at `count` and stacks make them hit harder and hunt more
// often, rather than adding orcas. Splitting three across three levels would
// mean the first card bought one lone orca — and a lone orca is not the thing
// the card is promising.
//
// THE THREE-STATE LOOP, and why it is three states and not two.
//
// The pod used to be `cruise` and `charge` with nothing in between, and it read
// as a swarm circling the seal rather than a family swimming with it. Three
// separate things caused that, and all three had to go:
//
//   1. STATION-KEEPING WAS A TUG-OF-WAR. Cruise was a spring toward a point
//      pinned to the player, with the orca's own speed capped at `cruiseSpeed`
//      — a third of the seal's top speed. A pod that physically cannot match
//      the animal it is escorting is always being dragged, so it never sat in
//      formation; it trailed, caught up, overshot and swung past. The spring is
//      solved in the SEAL'S FRAME now: the pod inherits the player's velocity
//      outright and `cruiseSpeed` limits only the closing speed on top of it,
//      which is what "swimming with you" actually is.
//   2. A CHARGE COULD NEVER END IN A MISS. The only way out of `charge` was
//      landing the hit or the target dying, and the run is turn-rate limited —
//      at `chargeSpeed` over `turnRate` the tightest circle an orca can fly was
//      wider than `hitRadius`. An orca that arrived even slightly off-line
//      therefore ORBITED its target, permanently, at exactly the radius it
//      could not close. That is the vortex, and it is why a charge now carries
//      a clock, an overshoot test and a leash back to the seal.
//   3. ALL THREE HUNTED AT ONCE. Nothing coordinated them, so the pod left as a
//      cloud. `maxAttackers` and `breakStagger` make it a rotation: one animal
//      leaves, the others hold the line.
//
// `overrun` is the third state and the one that makes a strike read as a pass
// rather than a stop. A charge — hit or miss — ends by carrying THROUGH at
// speed and easing back to the seal's pace, so the orca finishes somewhere
// past its target and swims home, which is what breaks the orbit visually as
// well as mechanically.

const pod = []; // { root, visual, anim, pos, vel, state, target, cooldown, slot }
let clock = 0;
// Only one orca is out of the line at a time (`maxAttackers`), and this is the
// gap enforced BETWEEN break-offs on top of that — without it the next animal
// leaves on the frame the last one lands, and the rotation reads as a queue
// rather than as a pod taking turns.
let breakTimer = 0;
// The direction the seal is travelling, eased. The formation hangs off this
// rather than off world axes, so the pod sits BEHIND and beside the seal
// whichever way it is swimming. Eased slowly and gated on speed: a formation
// that snapped around on every flick of the stick would be its own vortex.
let leadAngle = 0;

const TAU = Math.PI * 2;
const _to = new THREE.Vector3();
const _vel = new THREE.Vector2();

export function podStats(level) {
  const c = CONFIG.orca;
  const lv = Math.max(1, level);
  return {
    damage: companionDamage(c.damage + c.damagePerLevel * (lv - 1)),
    interval: Math.max(c.attackIntervalFloor, c.attackInterval - c.attackIntervalPerLevel * (lv - 1)),
    chargeSpeed: c.chargeSpeed + c.chargeSpeedPerLevel * (lv - 1),
  };
}

// A FAMILY, WHICH IS WHAT THE CARD IS CALLED. The pod used to be three copies
// of one body; it is three different animals now — the bull with the tall
// straight dorsal, the cow, and a calf noticeably smaller than either. Same
// three the boss orca is cut from (tools/orca-split.mjs), wearing the friendly
// outline.
//
// KEYED BY SLOT and not rolled, so the pod is stable: the same card always
// buys the same animals in the same order, and a player who has learned that
// the little one is the calf is not told otherwise on the next run. Slots past
// the third repeat the adults — the card stacks to six, and a pod of six
// calves would be a different joke than the one intended.
const POD_BODIES = ['orcaFriendBull', 'orcaFriendCow', 'orcaFriendCalf'];
function podAsset(slot) {
  return POD_BODIES[slot] ?? POD_BODIES[slot % 2]; // bull, cow, bull, cow, ...
}

function buildOrca(slot) {
  // Outer object owns position and heading; inner owns the left/right mirror.
  // They can't be the same object — the heading rotation would invert the
  // moment an orca swims left. Same arrangement as the seal team and the
  // beluga drone, and for the same reason.
  const root = new THREE.Group();
  const visual = createVisual(podAsset(slot));
  root.add(visual);
  const anim = CONFIG.animation.enabled ? createAnimationController(visual) : null;
  return { root, visual, anim };
}

function newMember(root, visual, anim, slot, pos) {
  return {
    root, visual, anim, slot,
    pos: pos.clone(),
    vel: new THREE.Vector3(),
    state: 'cruise', // 'cruise' | 'charge' | 'overrun'
    target: null, // { kind: 'human' | 'boat' | 'fish', ref }
    // Staggered from the start so all three don't breach the same hull on the
    // same frame — the pod should read as taking turns, not as a volley.
    cooldown: slot * 0.45,
    // --- the charge, and its three ways of ending badly ------------------------
    chargeTimer: 0, // seconds left before it gives up on this run
    // Closest this run has ever been to its target. A charge that starts
    // getting FURTHER away by more than `overshootSlack` has missed — which is
    // a thing the old two-state loop could not represent, so it kept turning.
    closest: Infinity,
    overrun: 0, // seconds left of the follow-through after a run ends
    // --- facing (see faceTravel) ---
    heading: 0,      // the EASED heading, which is what root.rotation.z shows
    mirrored: null,  // which side it is on; null until the first frame resolves it
    mirrorAngle: 0,  // the live roll, composited onto visual.rotation.y
    mirrorFrom: 0,
    mirrorTo: 0,
    mirrorT: 1,      // 1 = settled
    mirrorWantT: 0,  // how long it has wanted the other side
  };
}

function resize(scene, count, playerPos) {
  while (pod.length < count) {
    const { root, visual, anim } = buildOrca(pod.length);
    const start = new THREE.Vector3(playerPos.x, playerPos.y, 0);
    scene.add(root);
    const m = newMember(root, visual, anim, pod.length, start);
    pod.push(m);
    // Placed by the same function that holds it there, once the member exists
    // — the station is relative to the seal's HEADING now, so an orca dropped
    // at a world-axis offset would start out of line and swim sideways into
    // formation the moment the card is picked.
    formationPoint(m, playerPos, m.pos);
    root.position.copy(m.pos);
  }
  while (pod.length > count) {
    const m = pod.pop();
    scene.remove(m.root);
  }
}

/**
 * What the pod is doing right now, for tools/orca-pod-test.mjs. Read-only, and
 * derived from the live members rather than kept alongside them — a parallel
 * record is a record that can disagree with the pod it describes.
 *
 * The states are the whole thing worth asserting about this system and none of
 * them are visible from the outside: an orca circling its target forever and an
 * orca making a clean run look identical frame by frame, and only differ in how
 * long `charge` lasts and whether anything ever ends it.
 */
export function orcaPodDebug() {
  return pod.map((m) => ({
    slot: m.slot,
    state: m.state,
    target: m.target?.kind ?? null,
    x: m.pos.x,
    y: m.pos.y,
    speed: Math.hypot(m.vel.x, m.vel.y),
  }));
}

// Rebuilt on a model swap from the T panel, same as every other companion.
export function rebuildOrcaPod(scene) {
  for (const m of pod) {
    scene.remove(m.root);
    // WITH ITS SLOT. Called bare, `podAsset(undefined)` resolves to nothing and
    // every orca comes back as an empty visual — a model swap from the T panel
    // deleted the pod rather than reskinning it, silently.
    const { root, visual, anim } = buildOrca(m.slot);
    root.position.copy(m.pos);
    m.root = root;
    m.visual = visual;
    m.anim = anim;
    scene.add(root);
  }
}

// The seal's heading, eased, and the axis the whole formation is built on.
//
// Gated on speed rather than smoothed alone: at a standstill the velocity's
// direction is noise, and a formation that rotated with it would spin the pod
// around a stationary seal. Below `leadMinSpeed` the pod simply holds the last
// heading it had, which is a pod waiting rather than a pod circling.
function updateLead(dt) {
  const c = CONFIG.orca;
  const vx = player.velocity?.x ?? 0;
  const vy = player.velocity?.y ?? 0;
  if (Math.hypot(vx, vy) <= (c.leadMinSpeed ?? 3)) return;
  const want = Math.atan2(vy, vx);
  let delta = want - leadAngle;
  while (delta > Math.PI) delta -= TAU;
  while (delta < -Math.PI) delta += TAU;
  leadAngle += delta * (1 - Math.exp(-(c.leadLerp ?? 2.2) * dt));
}

// Where an idle orca sits: a loose line abreast trailing the seal.
//
// In the SEAL'S frame, not the world's — `formationOffset` is [along, across]
// relative to `leadAngle`, so the first number is how far back the line sits
// and the second is which side of the wake it favours. Written in world axes
// this was a fixed offset up and to the left, which meant the pod was behind
// the seal swimming one way and directly in its path swimming the other.
function formationPoint(m, playerPos, out) {
  const c = CONFIG.orca;
  const lane = m.slot - (pod.length - 1) / 2;
  const fx = Math.cos(leadAngle);
  const fy = Math.sin(leadAngle);
  const along = c.formationOffset[0] + Math.sin(clock * 0.6 + m.slot) * 0.5;
  const across = c.formationOffset[1] + lane * c.formationSpacing
    + Math.sin(clock * 0.9 + m.slot * 1.7) * 0.35;
  return out.set(
    playerPos.x + fx * along - fy * across,
    playerPos.y + fy * along + fx * across,
    0,
  );
}

// How fast the thing being charged is itself moving, so the run can be aimed
// where it is GOING. A turn-rate-limited charge that steers at a target's
// current position is always steering at where it was, which is the input that
// makes an orca curve in behind a moving fish and then have to come round
// again. Zeroes for anything that does not carry a velocity — a floating body
// drifts slowly enough that leading it is noise.
function targetVelocity(target, out) {
  const ref = target.ref;
  if (target.kind === 'boat') return out.set(ref.body?.vx ?? 0, ref.body?.vy ?? 0);
  if (target.kind === 'fish') return out.set(ref.vx ?? 0, ref.vy ?? 0);
  return out.set(0, 0);
}

// How many of the pod are out of the line right now. Counted rather than kept
// as a flag: a member can leave formation, be removed by a resize, or have its
// target die, and a counter would drift out of step with the pod on any of
// those.
function attackers() {
  let n = 0;
  for (const m of pod) if (m.state !== 'cruise') n++;
  return n;
}

// A run is over — hit, miss or timeout. The velocity is deliberately KEPT: the
// follow-through is what turns a strike into a pass, and it is also what
// carries the orca clear of a target it just failed to hit, so the next
// acquisition starts from outside rather than from inside its own turn circle.
function enterOverrun(m) {
  const c = CONFIG.orca;
  m.state = 'overrun';
  m.overrun = c.overrunTime ?? 0.6;
  m.target = null;
  m.closest = Infinity;
  m.chargeTimer = 0;
}

// A BODY IN THE WATER first, then a boat, then a fish.
//
// The order is the whole behaviour: sink a hull and the pod that sank it turns
// around to eat the people who were on it, which is a better answer to "what
// happens next" than going straight back to cruising.
function acquire(m, enemiesList) {
  const c = CONFIG.orca;
  // Splash Zone's gentle half: how far the pod will travel to find a boat.
  const range2 = targeting(c.huntRange) ** 2;
  let best = null;
  let bestD2 = range2;

  const body = nearestFloatingCrew(m.pos.x, m.pos.y, c.huntRange);
  if (body) return { kind: 'human', ref: body };

  // A hull the seal has RAMMED is the one the pod goes for, even with a nearer
  // boat in reach — the mark is the player pointing (see systems/marks.js), and
  // the pod is the heaviest thing they can point at. Weighted rather than
  // sorted into its own pass so an unmarked boat right on top of an orca can
  // still win, which is what stops the pod swimming past a hull to reach a
  // mark on the far side of the arena.
  for (const b of boats) {
    const dx = b.mesh.position.x - m.pos.x;
    const dy = b.mesh.position.y - m.pos.y;
    const w = markWeight(b);
    const d2 = (dx * dx + dy * dy) * w * w;
    if (d2 < bestD2) { bestD2 = d2; best = { kind: 'boat', ref: b }; }
  }
  if (best) return best;

  for (const e of enemiesList) {
    if (e.radius < c.fallbackMinRadius) continue;
    const dx = e.mesh.position.x - m.pos.x;
    const dy = e.mesh.position.y - m.pos.y;
    const w = markWeight(e);
    const d2 = (dx * dx + dy * dy) * w * w;
    if (d2 < bestD2) { bestD2 = d2; best = { kind: 'fish', ref: e }; }
  }
  return best;
}

// Is this target still something worth swimming at? A boat sunk or a fish
// killed by something else mid-charge has to drop the orca back to cruising,
// or it charges a hole in the water.
function targetAlive(target, enemiesList) {
  if (!target) return false;
  if (target.kind === 'boat') return boats.includes(target.ref);
  // A body somebody else already ate — or one that has dissolved out — takes
  // the pod straight back to cruising.
  if (target.kind === 'human') return !!nearestFloatingCrew(
    crewPosition(target.ref).x, crewPosition(target.ref).y, 0.01);
  return enemiesList.includes(target.ref);
}

// FACING, and the reason it is this much machinery.
//
// Both halves of this used to be written absolutely, every frame, from the
// instantaneous velocity: the heading was assigned outright and the left/right
// mirror was a hard swap on the sign of vel.x. In a charge that is fine — the
// velocity is a committed run. In CRUISE it is not: the velocity there is a
// spring toward a formation point that moves with the seal, so swimming
// circles around the pod swings each orca's drift direction through every
// angle there is, repeatedly across vertical, at almost no speed. The pod
// answered by snapping end to end several times a second.
//
// Three things fix it, and all three are needed:
//
//   the heading EASES toward the travel direction instead of being assigned,
//   so a change of direction is a turn;
//   the mirror only even gets considered once the facing is clear of a dead
//   zone either side of vertical, so drift that merely wobbles across the
//   vertical never asks for a side swap at all;
//   and a side swap has to be WANTED continuously for `mirrorHold` before it
//   commits, then ROLLS across over `mirrorDuration` — the same eased half
//   turn about the model's own axis the seal uses (see entities/player.js),
//   which is a turnaround rather than a pop.
//
// An orca is still free to rotate and spin all it likes; what it can no longer
// do is arrive somewhere instantly.
function faceTravel(m, dt) {
  const c = CONFIG.orca;
  const speed = Math.hypot(m.vel.x, m.vel.y);

  if (speed > (c.minSpeedToTurn ?? 0.4)) {
    const target = Math.atan2(m.vel.y, m.vel.x);
    // The short way round, so crossing the -pi/pi seam doesn't send it the
    // long way about.
    let delta = target - m.heading;
    while (delta > Math.PI) delta -= TAU;
    while (delta < -Math.PI) delta += TAU;
    m.heading += delta * (1 - Math.exp(-(c.faceLerp ?? 6) * dt));

    // Which way the model needs to be facing, decided off the SMOOTHED
    // heading rather than off the raw velocity — the smoothing is what makes
    // the question stable enough to answer.
    const facingX = Math.cos(m.heading);
    const band = c.mirrorDeadZone ?? 0.3;
    let want = m.mirrored;
    if (facingX < -band) want = true;
    else if (facingX > band) want = false;

    if (m.mirrored == null) {
      // First frame of this orca's life — there is no previous side to ease
      // from, so it simply starts on the right one.
      m.mirrored = !!want;
      m.mirrorAngle = want ? Math.PI : 0;
      m.mirrorT = 1;
      m.mirrorWantT = 0;
    } else if (want !== m.mirrored) {
      // Wanting the other side is not enough; it has to keep wanting it. There
      // are only two sides, so the disagreement itself is the whole intent —
      // this timer is only ever counting one thing.
      m.mirrorWantT += dt;
      if (m.mirrorWantT >= (c.mirrorHold ?? 0.3)) {
        m.mirrored = want;
        m.mirrorWantT = 0;
        // Always rolls onward rather than unwinding the way it came, and from
        // the CURRENT angle, so a reversal arriving mid-roll extends the turn
        // already happening instead of fighting it.
        m.mirrorFrom = m.mirrorAngle;
        m.mirrorTo = m.mirrorAngle + Math.PI;
        m.mirrorT = 0;
      }
    } else {
      m.mirrorWantT = 0;
    }
  }

  // Smoothstep, like the seal's: a linear sweep starts and stops abruptly,
  // which is the same pop wearing a longer coat.
  if (m.mirrorT < 1) {
    m.mirrorT = Math.min(1, m.mirrorT + dt / Math.max(0.01, c.mirrorDuration ?? 0.5));
    const e = m.mirrorT * m.mirrorT * (3 - 2 * m.mirrorT);
    m.mirrorAngle = m.mirrorFrom + (m.mirrorTo - m.mirrorFrom) * e;
    // Wrapped once settled, or a long run of reversals walks the angle up
    // forever and bleeds float precision.
    if (m.mirrorT >= 1) m.mirrorAngle = ((m.mirrorTo % TAU) + TAU) % TAU;
  }

  m.root.rotation.z = m.heading;
  m.visual.rotation.y = m.mirrorAngle;
  if (m.anim) m.anim.update(dt, stateForSpeed(speed), false);
}

/**
 * hooks: {
 *   onBoatHit(boat, dmg, x, y), onBoatDestroyed(boat, chum),
 *   onEnemyDamaged(e, dmg, x, y), onEnemyKilled(e),
 *   onStrike(x, y),
 * }
 */
export function updateOrcaPod(dt, scene, playerPos, level, enemiesList, hooks = {}) {
  const active = level > 0;
  if (!active) {
    if (pod.length) resize(scene, 0, playerPos);
    return;
  }

  const c = CONFIG.orca;
  const s = podStats(level);
  clock += dt;
  if (breakTimer > 0) breakTimer -= dt;
  updateLead(dt);

  resize(scene, c.count, playerPos);

  const point = new THREE.Vector3();
  // The seal's own velocity, which the pod matches while cruising. Read once
  // per frame rather than per orca — every member is station-keeping against
  // the same animal.
  const pvx = player.velocity?.x ?? 0;
  const pvy = player.velocity?.y ?? 0;

  for (const m of pod) {
    if (m.cooldown > 0) m.cooldown -= dt;
    // A target that died, sank or was eaten mid-run drops the orca into the
    // follow-through rather than straight back into the line: the run already
    // happened, and cutting the velocity dead at the moment something else
    // killed the target is the snap this state exists to remove.
    if (m.state === 'charge' && !targetAlive(m.target, enemiesList)) enterOverrun(m);

    if (m.state === 'cruise') {
      formationPoint(m, playerPos, point);
      // Spring back into the line rather than steering to it, so a pod
      // returning from a kill drifts home instead of snapping.
      //
      // Solved in the SEAL'S FRAME: `vel - playerVel` is the only part the
      // spring touches, and `cruiseSpeed` caps that CLOSING speed rather than
      // the orca's speed through the water. A pod escorting a seal at 30 is
      // doing 30 plus whatever it needs to hold station — capping the total at
      // `cruiseSpeed` is what left them permanently trailing and catching up.
      const damping = Math.exp(-(c.formationDamping ?? 6) * dt);
      let rvx = (m.vel.x - pvx + (point.x - m.pos.x) * c.formationFollow * dt) * damping;
      let rvy = (m.vel.y - pvy + (point.y - m.pos.y) * c.formationFollow * dt) * damping;
      const rs = Math.hypot(rvx, rvy);
      if (rs > c.cruiseSpeed) { rvx *= c.cruiseSpeed / rs; rvy *= c.cruiseSpeed / rs; }
      m.vel.x = pvx + rvx;
      m.vel.y = pvy + rvy;

      // A ceiling on the total anyway, so a seal that gets launched (a strike,
      // a breach) doesn't hand the pod a speed no animal should swim at.
      const sp = Math.hypot(m.vel.x, m.vel.y);
      const cap = c.maxFollowSpeed ?? 40;
      if (sp > cap) { m.vel.x *= cap / sp; m.vel.y *= cap / sp; }

      // ONE AT A TIME. Both gates are the point of the card: the family swims
      // with you, and an individual peels off. Three orcas leaving together is
      // the swarm this replaced.
      if (m.cooldown <= 0 && breakTimer <= 0 && attackers() < (c.maxAttackers ?? 1)) {
        const found = acquire(m, enemiesList);
        if (found) {
          m.target = found;
          m.state = 'charge';
          m.chargeTimer = c.chargeMaxTime ?? 2.6;
          m.closest = Infinity;
          breakTimer = c.breakStagger ?? 1.4;
          hooks.onBreakOff?.(m.pos.x, m.pos.y);
        }
      }
    } else if (m.state === 'overrun') {
      // Carry through, then settle back to the seal's pace. Easing toward the
      // PLAYER's velocity rather than toward zero is what makes the return read
      // as rejoining rather than as braking in open water — by the time cruise
      // takes over, the orca is already moving with the pod again.
      const k = 1 - Math.exp(-(c.overrunDrag ?? 2.4) * dt);
      m.vel.x += (pvx - m.vel.x) * k;
      m.vel.y += (pvy - m.vel.y) * k;
      m.overrun -= dt;
      if (m.overrun <= 0) m.state = 'cruise';
    } else if (m.state === 'charge') {
      const tp = m.target.kind === 'human'
        ? crewPosition(m.target.ref)
        : m.target.ref.mesh.position;
      const dist = Math.hypot(tp.x - m.pos.x, tp.y - m.pos.y) || 1e-4;

      // AIM WHERE IT IS GOING, not where it is. `leadFactor` scales the full
      // intercept so the run still visibly chases rather than solving the
      // problem perfectly — an orca that leads a fish exactly reads as a guided
      // missile, which is the eel's job, not this one.
      targetVelocity(m.target, _vel);
      const eta = dist / Math.max(1, s.chargeSpeed);
      const lead = c.leadFactor ?? 0.6;
      _to.set(
        tp.x + _vel.x * eta * lead - m.pos.x,
        tp.y + _vel.y * eta * lead - m.pos.y,
        0,
      ).normalize();

      // Turn-rate limited rather than steering instantly, so a charge reads as
      // a committed run the target could in principle swim out of.
      const want = Math.atan2(_to.y, _to.x);
      const have = Math.atan2(m.vel.y, m.vel.x);
      const delta = Math.atan2(Math.sin(want - have), Math.cos(want - have));
      const turn = Math.max(-c.turnRate * dt, Math.min(c.turnRate * dt, delta));
      const heading = (Math.hypot(m.vel.x, m.vel.y) > 0.2 ? have : want) + turn;
      m.vel.x = Math.cos(heading) * s.chargeSpeed;
      m.vel.y = Math.sin(heading) * s.chargeSpeed;

      const landed = m.target.kind === 'boat'
        ? hitsBoat(m.target.ref, m.pos.x, m.pos.y, c.hitRadius)
        : dist <= c.hitRadius + (m.target.kind === 'human'
          ? crewRadius(m.target.ref)
          : m.target.ref.radius);

      if (landed) {
        hooks.onStrike?.(m.pos.x, m.pos.y);

        if (m.target.kind === 'human') {
          const meal = eatCrew(scene, m.target.ref, { vx: m.vel.x, vy: m.vel.y });
          if (meal) hooks.onCrewEaten?.(meal.x, meal.y);
        } else if (m.target.kind === 'boat') {
          const index = boats.indexOf(m.target.ref);
          if (index >= 0) {
            const boat = m.target.ref;
            damageBoat(scene, index, s.damage, {
              onBoatDestroyed: (bt, chum) => hooks.onBoatDestroyed?.(bt, chum),
            }, { x: m.vel.x, y: m.vel.y }, { x: m.pos.x, y: m.pos.y });
            hooks.onBoatHit?.(boat, s.damage, m.pos.x, m.pos.y);
          }
        } else {
          const e = m.target.ref;
          e.hp -= s.damage;
          e.flash = CONFIG.fx.hitFlash;
          e.hitThisFrame = true;
          const len = Math.hypot(m.vel.x, m.vel.y) || 1;
          e.vx += (m.vel.x / len) * c.knockback;
          e.vy += (m.vel.y / len) * c.knockback;
          hooks.onEnemyDamaged?.(e, s.damage, e.mesh.position.x, e.mesh.position.y);
          if (e.hp <= 0) {
            const index = enemiesList.indexOf(e);
            hooks.onEnemyKilled?.(e);
            if (index >= 0) removeEnemy(scene, index);
          }
        }

        // THE BREACH, which `breachChance` has described in the config since
        // the pod shipped without anything ever reading it. A hull is at the
        // waterline, so a run that connects with one is already travelling up
        // — this just commits the follow-through to carrying clear of the
        // surface on some of them, which is the shot the animal is famous for.
        if (m.target?.kind === 'boat' && Math.random() < (c.breachChance ?? 0)) {
          m.vel.y = Math.max(m.vel.y, s.chargeSpeed * 0.75);
        }

        m.cooldown = s.interval;
        enterOverrun(m);
      } else {
        // THE THREE WAYS A RUN ENDS WITHOUT A HIT. Any of them is what stops an
        // orca circling — see the header. All three drop into the same
        // follow-through, which carries it clear of whatever it just failed to
        // catch before it is allowed to look for a target again.
        m.chargeTimer -= dt;
        if (dist < m.closest) m.closest = dist;
        const overshot = dist > m.closest + (c.overshootSlack ?? 1.4);
        // The leash is measured to the SEAL, not to the target: a pod is an
        // escort, and a chase that drags one of them across the arena has
        // stopped being one whatever the target is doing.
        const strayed = Math.hypot(m.pos.x - playerPos.x, m.pos.y - playerPos.y)
          > (c.leash ?? 30);
        if (m.chargeTimer <= 0 || overshot || strayed) {
          m.cooldown = Math.max(m.cooldown, c.abortCooldown ?? 1.2);
          enterOverrun(m);
        }
      }
    }

    m.pos.x += m.vel.x * dt;
    m.pos.y += m.vel.y * dt;
    m.root.position.copy(m.pos);
    applyCompanionScale(m.visual);
    faceTravel(m, dt);
  }
}

export function resetOrcaPod(scene, playerPos) {
  for (const m of pod) scene.remove(m.root);
  pod.length = 0;
  clock = 0;
  // Both of these outlive the pod otherwise: a run that started mid-charge
  // would begin with the break-off gate still counting down, and the formation
  // would be built around the heading the LAST run ended on.
  breakTimer = 0;
  leadAngle = 0;
}
