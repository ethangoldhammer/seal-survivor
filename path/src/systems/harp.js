import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createVisual } from '../assets.js';
import { spawnProjectile } from '../entities/projectiles.js';
import { removeEnemy } from '../entities/enemies.js';
import { orbitTarget } from './orbit.js';
import { aoe, targeting, abilityDamage, companionScale } from './scaling.js';
import { canHold, canControl, charmEnemy } from './control.js';
import { createNoteField, rollNoteColor } from './noteStorm.js';
import { stoke, cool, glowLevel, damageGlowCfg } from './damageGlow.js';
import { harpLevelStats } from '../levelStats.js';
import { player } from '../entities/player.js';

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
//               through charmEnemy() is what buys the no-clobber latch and the
//               BOSS CONVERSION for free — a note that lands on a boss dazes it
//               (heavy slow, weaving heading, next tell cancelled) instead of
//               charming it, and grows no aura. That is the whole of the harp's
//               boss-fight value and this file does not implement a line of it.
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

// The harp itself. One group so main.js adds and forgets, exactly like the
// shrimp ring.
let group = null;
// EVERY HARP ON THE RING, not one. Entourage adds instruments, so what used to
// be a singleton is a list of { mesh, fireTimer } sharing one ring — spaced by
// slot, each plucking on its own clock so two harps are two players rather
// than one played twice.
//
// The TIMER is per harp and the aura state is not, deliberately: a note is a
// note whoever plucked it, and the rings it starts belong to the bodies
// wearing them. Only the act of playing is per instrument.
let harps = [];
// Every note that is not the harp — the rings around charmed bodies and the
// storms thrown when a note lands — lives in one instanced field instead of in
// this group. See systems/noteStorm.js: the notes are eight glyphs sharing one
// material, so the only per-note colour that exists is instanceColor, and that
// is what lets each charmed body wear a hue of its own.
//
// Built on the first update rather than in createHarpVisual because the pool
// needs the scene, and createHarpVisual is handed nothing.
let notes = null;
let clock = 0;

// Reused so the per-frame work allocates nothing. Rebuilt each frame rather
// than held across frames: a host can die, and a stale reference to a corpse
// would keep drawing a ring around empty water.
const hosts = [];

export function createHarpVisual() {
  group = new THREE.Group();
  harps = [];
  return group;
}

// Grow or shrink the ring to match `count`. Called every frame and cheap when
// nothing changed, the same shape sealTeam's resize has — an Entourage pick
// mid-run has to add an instrument on the frame it lands, and there is no
// other point where a level-up could reach this.
//
// A NEW HARP STARTS ON A STAGGERED TIMER rather than at zero. Built at zero,
// every instrument the card ever adds plucks in unison with the first one from
// then on, which is one loud note instead of a run of them — and the ability
// would appear to fire less often than it does.
function syncHarps(count) {
  while (harps.length < count) {
    const mesh = createVisual('harp');
    group.add(mesh);
    const c = CONFIG.harp;
    harps.push({ mesh, fireTimer: (harps.length / Math.max(1, count)) * (c.interval ?? 1) });
  }
  while (harps.length > count) {
    const gone = harps.pop();
    group.remove(gone.mesh);
  }
}

// Same shape as rebuildDumboOcto: the harp is a singleton built once at boot,
// so a model uploaded from the T panel needs an explicit swap or it wouldn't
// appear until a full reload. The note field is NOT rebuilt with it — the notes
// are geometry loaded once from musicnotes.glb rather than an asset entry, so
// nothing the T panel can do to `harp` reaches them.
export function rebuildHarp() {
  if (!group) return;
  // Swap every mesh, keep every timer. The instruments' clocks are the
  // ability's rhythm and have nothing to do with which model is on the ring —
  // rebuilding the entries would restart the whole ring in unison.
  for (const h of harps) {
    group.remove(h.mesh);
    h.mesh = createVisual('harp');
    group.add(h.mesh);
  }
}

export function resetHarp() {
  for (const h of harps) group?.remove(h.mesh);
  harps = [];
  clock = 0;
  hosts.length = 0;
  notes?.reset();
  if (group) group.visible = false;
}

/**
 * Live notes — rings and storms together. Diagnostics and harnesses: it is the
 * only way to see the field from outside, since it deliberately isn't in
 * `group` (an InstancedMesh spanning the arena has to sit at the origin).
 */
export function harpNoteCount() {
  return notes?.count ?? 0;
}

/** Everything the ability's numbers do with a level, in one place. */
export function currentHarpStats(level) {
  const c = CONFIG.harp;
  const lv = Math.max(1, level) - 1;
  const h = harpLevelStats(level, player.stats);
  return {
    // levelStats.js owns the curve — shared with the tip that quotes it.
    interval: h.harpGap,
    // `targeting`, not `aoe` — this is how far the harp LOOKS for something to
    // play at, and Splash Zone has no business doubling an acquisition radius.
    // See the split in systems/scaling.js.
    range: targeting(c.range + c.rangePerLevel * lv),
    damage: h.harpDamage,
    charmDuration: h.harpCharm,
    auraDuration: h.harpAuraLength,
    // The aura IS a blast radius, so this one does take Splash Zone.
    auraRadius: h.harpAuraRadius,
    auraDamage: h.harpAuraDamage,
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
  // The shared verb, which is also the shared gate. On a boss this lands as a
  // DAZE instead of a charm and returns true — the note DID something, and the
  // caller should say so. See systems/control.js.
  if (!charmEnemy(e, payload.duration)) return false;
  // ...but only a genuinely charmed body grows a ring. A boss is not fighting
  // for you and has no crowd around it to grind; a note ring spinning on three
  // tonnes of animal that is about to eat you would read as the ability having
  // done far more than it did.
  if (!canHold(e)) return true;
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

/**
 * Roll the colour this body's notes will wear, once, when the charm lands.
 *
 * PER HOST, not per note: a charmed body is a grinder parked in a crowd, and
 * two of them near each other have to stay countable. One hue each does that;
 * a hue each per NOTE would be forty pieces of confetti saying nothing.
 *
 * The wheel is restricted to CONFIG.harp.hues rather than open, and that is a
 * bloom decision, not a taste one — see rollNoteColor. Stamped on the creature
 * so it survives everything that happens to the ring afterwards, including the
 * host being re-charmed before the aura wore off.
 */
function colorFor(e) {
  const c = CONFIG.harp;
  if (!e.harpColor) {
    e.harpColor = rollNoteColor(Math.random, { hues: [c.hueFrom, c.hueTo], glow: c.noteGlow });
  }
  return e.harpColor;
}

/**
 * The ring, built from CONFIG every time it is attached rather than held as a
 * constant, so the tuner rows that already exist for it keep working. `squash`
 * is the one number with no slider: a ring lying flat, seen side-on, is an
 * ellipse, and 0.6 is what it has always been drawn at.
 */
function ringPreset() {
  const c = CONFIG.harp;
  return {
    kind: 'ring', spin: c.auraNoteSpin, tilt: c.auraNoteTilt, squash: 0.6, bob: c.auraNoteBob,
  };
}

/**
 * Everything that happens the first frame a body is seen carrying an aura: the
 * ring goes on, and the storm goes off.
 *
 * TWO BURSTS, not one. `bloom` throws a ring outward and stops it hard, which
 * is the moment landing; `updraft` sends a slower column up out of the animal
 * that is still climbing after the first has gone. Fired together they are one
 * event with a fast half and a slow half — either alone reads as either a pop
 * with no tail or a tail with no pop.
 *
 * Placed on the MEASURED aura radius, so the picture cannot disagree with what
 * is being hurt.
 */
function startNotes(e) {
  const c = CONFIG.harp;
  const color = colorFor(e);
  const p = e.mesh.position;
  notes.attach(e, {
    count: Math.max(0, Math.round(c.auraNotes)),
    color,
    preset: ringPreset(),
    scale: c.auraNoteScale * companionScale(),
    radius: e.harpAuraRadius ?? 0,
  });
  notes.burst(p.x, p.y, p.z, {
    count: Math.max(0, Math.round(c.stormNotes)),
    color,
    preset: 'bloom',
    scale: c.stormScale * companionScale(),
    radius: (e.def?.radius ?? e.radius ?? 1) * (e.sizeMul ?? 1) * 0.7,
  });
  notes.burst(p.x, p.y, p.z, {
    count: Math.max(0, Math.round(c.stormRiseNotes)),
    color,
    preset: 'updraft',
    scale: c.stormScale * companionScale(),
    radius: (e.def?.radius ?? e.radius ?? 1) * (e.sizeMul ?? 1) * 0.5,
  });
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
/**
 * @param count how many instruments are on the ring — Entourage. Defaults to
 *              one, which is what every caller passed before the card existed
 *              and what every harness still wants.
 */
export function updateHarp(dt, scene, playerPos, level, enemiesList, hooks = {}, count = 1) {
  if (!group) return;
  // The field lives in the scene rather than in `group`, because an
  // InstancedMesh spanning the arena has to be at the origin — its instances
  // carry world transforms. Built here rather than in createHarpVisual, which
  // is not handed a scene.
  if (!notes) notes = createNoteField(scene, { max: CONFIG.harp.maxNotes });

  const active = level > 0;
  group.visible = active;
  if (!active) {
    // Anything still carrying a ring when the ability goes away (a tuner reset
    // mid-run) drops it, or the notes would hang in the water.
    notes.reset();
    if (harps.length) syncHarps(0);
    return;
  }
  syncHarps(Math.max(1, Math.floor(count)));

  const c = CONFIG.harp;
  const s = currentHarpStats(level);
  clock += dt;

  // --- the harps on their ring ---------------------------------------------
  // Pinned to the orbit point rather than spring-chasing it like a companion
  // does. A harp is an object being carried around you, not an animal swimming
  // alongside; the lag that makes the dumbo read as alive would just make this
  // look loosely attached.
  //
  // Slotted, so a ring of them is spread rather than stacked at one point —
  // the same argument the club ring and Seal Team both make.
  for (let i = 0; i < harps.length; i++) {
    const h = harps[i];
    h.mesh.position.copy(orbitTarget(clock, playerPos, c, i, harps.length));
    // Turned so its back is to the seal as it comes round, by `faceOut`. At 0
    // it stays upright the whole way, which is the readable extreme; at 1 it
    // leans fully into the ring, which is the pretty one. The slot's phase is
    // in the angle too, or a ring of harps all face the same way and reads as
    // one object drawn several times.
    const phase = harps.length > 1 ? (i / harps.length) * Math.PI * 2 : 0;
    h.mesh.rotation.z = (clock * (c.orbitSpeed ?? 1) + phase - Math.PI / 2) * c.faceOut;
    scaleTo(h.mesh, c.harpScale * companionScale());

    // --- pluck a note at the biggest thing near you ------------------------
    // PER INSTRUMENT, and each one picks its own target. Sharing a target
    // would waste the whole ring on one shark — and pickTarget already skips
    // anything wearing a ring, so a second harp naturally goes to the next
    // body worth playing at rather than doubling up.
    h.fireTimer -= dt;
    if (h.fireTimer <= 0) {
      h.fireTimer = s.interval;
      const target = pickTarget(playerPos, s.range, enemiesList);
      if (target) pluck(scene, target, s, hooks, h.mesh.position);
    }
  }

  // --- the note rings ------------------------------------------------------
  tickAuras(dt, scene, enemiesList, hooks);

  // Late, after tickAuras has aged every timer and started any new ring. The
  // predicate is what drops a host's notes: a body whose aura ran out, or that
  // died, releases its instances on the same frame rather than on a callback
  // from whatever killed it.
  notes.update(dt, (e) => e.harpAura > 0 && e.hp > 0);
}

/**
 * The largest creature within range of the PLAYER — not of the harp. The harp
 * is swinging through a three-metre circle, and measuring from it would mean
 * the same fish drifting in and out of range twice a second depending on where
 * the ring happened to have carried the instrument.
 *
 * Bodies a note can put a STATUS on win outright, even over something bigger
 * that cannot take one: a note spent on a creature already reeling buys damage,
 * and a note spent on the shark beside it buys damage AND the aura. A boss is
 * in that first tier whenever it is dazeable, which is what makes the harp
 * genuinely worth having in a boss fight — and it drops out of it while the
 * daze and its recovery run, so the notes go back to the forage school instead
 * of hammering a creature that cannot take another status yet. The second tier
 * is what keeps a note worth playing at all when nothing in range can be
 * touched: damage is damage.
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
    if (canControl(e)) {
      if (size > bestBulk) { bestBulk = size; best = e; }
    } else if (size > fallbackBulk) {
      fallbackBulk = size; fallback = e;
    }
  }
  return best ?? fallback;
}

function pluck(scene, target, s, hooks, at) {
  const c = CONFIG.harp;
  // WHICH instrument played it. Passed in rather than read off a module
  // singleton, which is the whole reason a ring of harps is possible: the note
  // has to leave the one that plucked it, and every note leaving the same
  // point would make a ring of five look like scenery around one real harp.
  const from = at;
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
    if (e.harpAura > 0) { hosts.push(e); continue; }
    // Wearing off clears BOTH marks. The colour has to go with the flag: an
    // enemy object outliving its aura and being charmed again — or a recycled
    // one — would otherwise wear the dead ring's hue and never fire a storm,
    // which looks like the second charm did nothing.
    e.harpNotesOn = false;
    e.harpColor = null;
    e.harpAuraHeat = 0;
  }

  let caught = 0;
  let lastX = 0;
  let lastY = 0;

  for (const host of hosts) {
    // A host that died to something else this frame — its own ring included —
    // is already out of the scene, and a ring drawn around it would sit over
    // empty water for the rest of its duration.
    if (host.hp <= 0 || !host.mesh?.parent) continue;

    const radius = host.harpAuraRadius ?? 0;
    // The first frame this body is seen carrying a ring is when the ring goes
    // on and the storm goes off. Keyed on a flag rather than on the timer being
    // full, because a body re-charmed while its aura was still running must not
    // fire a second storm — that is the same no-clobber intent as charmTimer's.
    if (!host.harpNotesOn) {
      host.harpNotesOn = true;
      startNotes(host);
    } else {
      // Shrink the ring away over its last beat. Scale rather than opacity:
      // every note shares one material, so a fade would fade the whole field —
      // and would take the notes still in flight from other hosts with it.
      const fade = Math.min(1, host.harpAura / 0.35);
      notes.scaleHost(host, CONFIG.harp.auraNoteScale * companionScale() * fade);
    }

    // HOT WHILE IT IS GRINDING. Per host, so two charmed bodies in one fight
    // are two separately hot rings rather than one shared brightness — the
    // whole card is about WHICH body is carrying the ring, and a field that
    // lit up everywhere would throw that away. Carried every frame; stoked
    // below by a tick that caught something.
    host.harpAuraHeat = cool(host.harpAuraHeat, 'harp', dt);
    notes.heatHost(host, 1 + damageGlowCfg('harp').peak * glowLevel(host.harpAuraHeat, 'harp'));

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
      host.harpAuraHeat = stoke(host.harpAuraHeat, 'harp');
      lastX = e.mesh.position.x;
      lastY = e.mesh.position.y;
      hooks.onEnemyDamaged?.(e, dmg);
      if (e.hp <= 0) {
        hooks.onEnemyKilled?.(e);
        removeEnemy(scene, i);
      }
    }
  }

  // One event for the whole frame's worth of ticking, with the count. A tick
  // that caught nothing is not an event: a charmed fish drifting alone in open
  // water would otherwise chime in your hands at the tick rate until it wore
  // off.
  if (caught) hooks.onAuraTick?.(lastX, lastY, caught);
}
