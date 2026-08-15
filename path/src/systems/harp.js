import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createVisual } from '../assets.js';
import { spawnProjectile } from '../entities/projectiles.js';
import { removeEnemy } from '../entities/enemies.js';
import { orbitTarget } from './orbit.js';
import { aoe, targeting, abilityDamage, companionScale } from './scaling.js';
import { canHold } from './control.js';

// ===========================================================================
// HARP SEAL — the pun, and the ability that grew out of it.
//
// A harp rides a ring around the seal and plucks a music note at the BIGGEST
// creature near you. The note hurts a little; what it is really carrying is a
// CHARM, and a charmed body sprouts a ring of notes that grinds everything
// standing next to it.
//
// THE TARGETING IS THE CARD. Every other seeking ability here takes the
// nearest thing, because the nearest thing is the one about to bite you. This
// one takes the largest, and that is not a tuning choice — the payload is an
// aura, and an aura is worth what the body carrying it is worth being next to.
// A charmed minnow is a minnow that has stopped. A charmed shark is a grinder
// parked in the middle of the school that was swimming behind it. See the long
// note on CONFIG.harp.
//
// TWO TIMERS ON THE CREATURE, and they are not the same effect:
//
//   charmTimer  the SHARED field (systems/control.js). Pacification: it stops
//               chasing and stops dealing contact damage, enforced in
//               combat.js and enemies.js exactly as the dumbo's charm is. Going
//               through charmEnemy() is what buys the boss immunity and the
//               no-clobber latch for free.
//   harpAura    this ability's own. How long the note ring keeps hurting.
//
// They are started together and never again assumed to agree, for the same
// reason charm is not trapTimer: a dumbo charm must not grow an aura, and an
// aura must not be cut short because somebody else's charm expired first. The
// aura is also given the LONGER default life on purpose — the ring is still
// spinning as the creature shakes the daze off and turns back on you, and that
// overlap is both the best and the most dangerous second of the card.
//
// The whole thing lives in one file because the three halves are one loop's
// worth of work and they share the target list. Splitting the note ring into
// its own system would mean a second walk of the enemy array every frame to
// find the bodies this one already has in hand.
// ===========================================================================

// The harp, and the pool of note meshes the auras are drawn with. One group so
// main.js adds and forgets, exactly like the shrimp ring.
let group = null;
let harpMesh = null;
// Grown on demand and never shrunk — a note mesh costs nothing parked at
// visible:false, and a stack that peaks at four charmed bodies would otherwise
// churn meshes every time one wore off.
let notePool = [];
let fireTimer = 0;
let clock = 0;

// Reused so the per-frame work allocates nothing. Rebuilt each frame rather
// than held across frames: a host can die, and a stale reference to a corpse
// would keep drawing a ring around empty water.
const hosts = [];

export function createHarpVisual() {
  group = new THREE.Group();
  harpMesh = createVisual('harp');
  group.add(harpMesh);
  return group;
}

// Same shape as rebuildDumboOcto: the harp is a singleton built once at boot,
// so a model uploaded from the T panel needs an explicit swap or it wouldn't
// appear until a full reload. The note pool goes with it — those are clones of
// a second asset that may have been re-uploaded in the same breath.
export function rebuildHarp() {
  if (!group) return;
  if (harpMesh) group.remove(harpMesh);
  for (const n of notePool) group.remove(n);
  notePool = [];
  harpMesh = createVisual('harp');
  group.add(harpMesh);
}

export function resetHarp() {
  fireTimer = 0;
  clock = 0;
  hosts.length = 0;
  for (const n of notePool) n.visible = false;
  if (group) group.visible = false;
}

/** Everything the ability's numbers do with a level, in one place. */
export function currentHarpStats(level) {
  const c = CONFIG.harp;
  const lv = Math.max(1, level) - 1;
  return {
    interval: Math.max(c.intervalFloor, c.interval - c.intervalPerLevel * lv),
    // `targeting`, not `aoe` — this is how far the harp LOOKS for something to
    // play at, and Splash Zone has no business doubling an acquisition radius.
    // See the split in systems/scaling.js.
    range: targeting(c.range + c.rangePerLevel * lv),
    damage: c.damage + c.damagePerLevel * lv,
    charmDuration: c.charmDuration + c.charmDurationPerLevel * lv,
    auraDuration: c.auraDuration + c.auraDurationPerLevel * lv,
    // The aura IS a blast radius, so this one does take Splash Zone.
    auraRadius: aoe(c.auraRadius + c.auraRadiusPerLevel * lv),
    auraDamage: c.auraDamage + c.auraDamagePerLevel * lv,
  };
}

/**
 * How BIG a creature is, for the purpose of picking one.
 *
 * The species' authored radius times the run's growth — NOT `e.radius`, which
 * folds in a per-spawn scale roll and would have the harp preferring a
 * fortunate mackerel over a shark. This is the figure everything that means
 * "mass" in this codebase reads; see the note in entities/enemies.js.
 */
function bulk(e) {
  return (e.def?.radius ?? e.radius ?? 0) * (e.sizeMul ?? 1);
}

/**
 * Put the harp's charm AND its aura on a creature, as one act.
 *
 * Exported because the note lands in combat.js, which by then knows only that
 * it is holding a projectile with a `charm` payload — the same arrangement
 * `chill` and `burst` already have. Returns whether it took, so the caller can
 * skip the event: a note that hit a boss did damage and nothing else, and
 * playing the charm sting over it would be a lie about what happened.
 */
export function applyHarpCharm(e, payload) {
  if (!e || !payload) return false;
  // The shared gate. A boss is never charmed — and because the aura is set
  // below this line rather than beside it, a boss never grows one either.
  if (!canHold(e)) return false;
  e.charmTimer = Math.max(e.charmTimer ?? 0, payload.duration);
  e.harpAura = Math.max(e.harpAura ?? 0, payload.auraDuration);
  e.harpAuraRadius = payload.auraRadius;
  e.harpAuraDamage = payload.auraDamage;
  // Fires on the frame it lands rather than after a full interval, so a note
  // arriving in a crowd does something immediately instead of charming a fish
  // that then stands there for half a second doing nothing.
  e.harpAuraTick = 0;
  return true;
}

// Scale an ability mesh without throwing away what createVisual built it at.
// The root carries the asset's Size multiplier from assets.csv (`fit` lives on
// a grandchild), so a bare setScalar here would silently drop that column for
// this one ability — the exact bug the beluga's bubble had. Stash the built
// scale once, and every frame after is that base times the live multipliers.
function scaleTo(obj, mul) {
  if (obj.userData.harpBaseScale == null) obj.userData.harpBaseScale = obj.scale.x;
  obj.scale.setScalar(obj.userData.harpBaseScale * mul);
}

function noteAt(index) {
  while (notePool.length <= index) {
    const n = createVisual('musicNote');
    n.visible = false;
    group.add(n);
    notePool.push(n);
  }
  return notePool[index];
}

/**
 * Draw the ring of notes around one charmed body.
 *
 * Placed on the MEASURED aura radius, not on a decorative one, so the picture
 * cannot disagree with what is being hurt. Sized by scale only and never by
 * opacity: every clone of `musicNote` shares one material (see the note in
 * assets.js), so fading one note would fade every note in the game including
 * the ones in flight.
 *
 * The group is at the origin, so these take world positions directly.
 */
function drawAuraNotes(e, radius, slot) {
  const c = CONFIG.harp;
  const count = Math.max(0, Math.round(c.auraNotes));
  const fade = Math.min(1, e.harpAura / 0.35); // shrink away over the last beat
  for (let i = 0; i < count; i++) {
    const n = noteAt(slot + i);
    const angle = clock * c.auraNoteSpin + (i / count) * Math.PI * 2;
    n.visible = true;
    n.position.set(
      e.mesh.position.x + Math.cos(angle) * radius,
      e.mesh.position.y + Math.sin(angle) * radius * 0.6
        + Math.sin(clock * 2.6 + i) * c.auraNoteBob,
      e.mesh.position.z + Math.sin(angle) * radius * c.auraNoteTilt,
    );
    // Tumbling on its own axis rather than facing anywhere — a note is a glyph,
    // and one pointing carefully at something reads as a projectile.
    n.rotation.z = angle * 0.5;
    scaleTo(n, c.auraNoteScale * companionScale() * fade);
  }
  return count;
}

/**
 * hooks: {
 *   onPluck(x, y, dirX, dirY)   a note leaving the harp
 *   onEnemyDamaged(e, dmg), onEnemyKilled(e)   the shared damage contract
 *   onAuraTick(x, y, count)     ONE call per tick with everything it caught,
 *                               not one per creature — same reason as garlic's
 * }
 * The charm event is fired from main.js's projectile-impact path instead: the
 * charm lands where the NOTE lands, and this system has already moved on by
 * several frames by then.
 */
export function updateHarp(dt, scene, playerPos, level, enemiesList, hooks = {}) {
  if (!group) return;

  const active = level > 0;
  group.visible = active;
  if (!active) {
    // Anything still carrying a ring when the ability goes away (a tuner reset
    // mid-run) stops being drawn, or the notes would hang in the water.
    for (const n of notePool) n.visible = false;
    return;
  }

  const c = CONFIG.harp;
  const s = currentHarpStats(level);
  clock += dt;

  // --- the harp on its ring ------------------------------------------------
  // Pinned to the orbit point rather than spring-chasing it like a companion
  // does. A harp is an object being carried around you, not an animal swimming
  // alongside; the lag that makes the dumbo read as alive would just make this
  // look loosely attached.
  harpMesh.position.copy(orbitTarget(clock, playerPos, c));
  // Turned so its back is to the seal as it comes round, by `faceOut`. At 0 it
  // stays upright the whole way, which is the readable extreme; at 1 it leans
  // fully into the ring, which is the pretty one.
  harpMesh.rotation.z = (clock * (c.orbitSpeed ?? 1) - Math.PI / 2) * c.faceOut;
  scaleTo(harpMesh, c.harpScale * companionScale());

  // --- pluck a note at the biggest thing near you --------------------------
  fireTimer -= dt;
  if (fireTimer <= 0) {
    fireTimer = s.interval;
    const target = pickTarget(playerPos, s.range, enemiesList);
    if (target) pluck(scene, target, s, hooks);
  }

  // --- the note rings ------------------------------------------------------
  tickAuras(dt, scene, enemiesList, hooks);
}

/**
 * The largest creature within range of the PLAYER — not of the harp. The harp
 * is swinging through a three-metre circle, and measuring from it would mean
 * the same fish drifting in and out of range twice a second depending on where
 * the ring happened to have carried the instrument.
 *
 * Charmable bodies win outright, even over something bigger that cannot be
 * held: a note spent on a boss buys damage, and a note spent on the shark
 * beside it buys damage AND the aura, which is the entire ability. But a boss
 * with nothing else in the water is still worth playing at — that is the
 * fallback, and it is why this is two tiers rather than the dumbo's flat
 * "skip what you cannot hold".
 */
function pickTarget(playerPos, range, enemiesList) {
  const r2 = range * range;
  let best = null;
  let bestBulk = -Infinity;
  let fallback = null;
  let fallbackBulk = -Infinity;

  for (const e of enemiesList) {
    if (e.hp <= 0 || e.invuln > 0) continue;
    // Already carrying a ring. Re-charming it would refresh a timer and waste
    // the note that could have started a second grinder somewhere else.
    if (e.harpAura > 0) continue;
    const dx = e.mesh.position.x - playerPos.x;
    const dy = e.mesh.position.y - playerPos.y;
    if (dx * dx + dy * dy > r2) continue;

    const size = bulk(e);
    if (canHold(e)) {
      if (size > bestBulk) { bestBulk = size; best = e; }
    } else if (size > fallbackBulk) {
      fallbackBulk = size; fallback = e;
    }
  }
  return best ?? fallback;
}

function pluck(scene, target, s, hooks) {
  const c = CONFIG.harp;
  const from = harpMesh.position;
  const dx = target.mesh.position.x - from.x;
  const dy = target.mesh.position.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const dirX = dx / len;
  const dirY = dy / len;

  spawnProjectile(scene, {
    origin: from,
    dir: new THREE.Vector2(dirX, dirY),
    faction: 'player',
    damage: abilityDamage(s.damage),
    speed: c.speed,
    life: c.life,
    radius: c.noteRadius,
    pierce: 0,
    asset: 'musicNote',
    source: 'harp',
    orient: true,
    // Homing, and NOT because the note would otherwise miss. The harp is on a
    // moving ring around a moving seal, so a note thrown at where the shark was
    // would lead in a different direction every pluck — the seeker is what
    // makes "it plays at the big one" true rather than approximately true.
    homing: true,
    homingDelay: c.homingDelay,
    turnRate: c.turnRate,
    // The pluck already chose; the acquire radius only matters if that choice
    // dies mid-flight, and then the nearest thing is the right answer.
    acquireRadius: s.range,
    // The payload, in the same shape and the same place as `chill` and `burst`:
    // a description the projectile carries and never acts on. combat.js hands
    // it back to applyHarpCharm above when the note lands.
    charm: {
      duration: s.charmDuration,
      auraDuration: s.auraDuration,
      auraRadius: s.auraRadius,
      auraDamage: s.auraDamage,
    },
  });

  hooks.onPluck?.(from.x, from.y, dirX, dirY);
}

/**
 * Age every ring, hurt what they are standing over, and draw them.
 *
 * The radius and damage a ring uses are the ones stamped on the creature when
 * the note landed, not today's — a level-up mid-charm must not silently grow
 * a ring that is already on screen, and a creature outliving the card being
 * reset must not read a config block that is no longer there.
 */
function tickAuras(dt, scene, enemiesList, hooks) {
  hosts.length = 0;
  for (const e of enemiesList) {
    if (!(e.harpAura > 0)) continue;
    e.harpAura = Math.max(0, e.harpAura - dt);
    if (e.harpAura > 0) hosts.push(e);
  }

  let slot = 0;
  let caught = 0;
  let lastX = 0;
  let lastY = 0;

  for (const host of hosts) {
    // A host that died to something else this frame — its own ring included —
    // is already out of the scene, and a ring drawn around it would sit over
    // empty water for the rest of its duration.
    if (host.hp <= 0 || !host.mesh?.parent) continue;

    const radius = host.harpAuraRadius ?? 0;
    slot += drawAuraNotes(host, radius, slot);

    host.harpAuraTick = (host.harpAuraTick ?? 0) - dt;
    if (host.harpAuraTick > 0) continue;
    host.harpAuraTick = CONFIG.harp.auraTick;

    const dmg = abilityDamage(host.harpAuraDamage ?? 0);
    const r2 = radius * radius;
    // Backwards, because a kill splices the list — see removeEnemy, which
    // takes an INDEX and silently does nothing if handed the creature.
    for (let i = enemiesList.length - 1; i >= 0; i--) {
      const e = enemiesList[i];
      // Never the body carrying it. The creature is fighting for you: a ring
      // that ground down its own host would kill the thing whose only value is
      // being alive in the middle of the crowd.
      if (e === host) continue;
      if (e.invuln > 0) continue;
      // And never another charmed body. Two charmed sharks standing together
      // would otherwise saw each other in half in about a second, which loses
      // both grinders and looks like a bug.
      if (e.harpAura > 0) continue;
      const dx = e.mesh.position.x - host.mesh.position.x;
      const dy = e.mesh.position.y - host.mesh.position.y;
      if (dx * dx + dy * dy > r2) continue;

      e.hp -= dmg;
      e.flash = CONFIG.fx.hitFlash;
      e.hitThisFrame = true;
      caught += 1;
      lastX = e.mesh.position.x;
      lastY = e.mesh.position.y;
      hooks.onEnemyDamaged?.(e, dmg);
      if (e.hp <= 0) {
        hooks.onEnemyKilled?.(e);
        removeEnemy(scene, i);
      }
    }
  }

  // Everything the rings didn't need this frame goes dark. Parked rather than
  // removed — see the note on the pool.
  for (let i = slot; i < notePool.length; i++) notePool[i].visible = false;

  // One event for the whole frame's worth of ticking, with the count. A tick
  // that caught nothing is not an event: a charmed fish drifting alone in open
  // water would otherwise chime in your hands at the tick rate until it wore
  // off.
  if (caught) hooks.onAuraTick?.(lastX, lastY, caught);
}
