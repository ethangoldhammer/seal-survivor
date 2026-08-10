import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createVisual } from '../assets.js';
import { removeEnemy } from '../entities/enemies.js';
import { bounds } from '../arena.js';
import { createAnimationController, stateForSpeed } from './animation.js';
import { orbitTarget, springFollow } from './orbit.js';
import { setBiolumSkinVariant } from './biolumSkin.js';
import { spawnProjectile } from '../entities/projectiles.js';
import { player } from '../entities/player.js';

// Seal Team — escort seals that swim the same tilted 3D ring the beluga drone
// uses, spread evenly around it, ram anything that gets close, and break
// formation to charge a target in reach before falling back into the ring.
//
// Each level adds a seal (up to `maxSeals`), so the upgrade reads as "more
// friends" rather than a number going up invisibly. They're damage on a timer
// per target, not per frame, or a seal parked inside a shark would delete it
// instantly.
//
// At CONFIG.sealTeam.evolveLevel the squad also opens fire while orbiting —
// the same bullets the player shoots, so their damage rides along with every
// weapon upgrade taken since.
//
// Structure mirrors the beluga drone: an OUTER object owns position and the
// heading rotation on Z, an INNER one owns the left/right mirror on Y. They
// can't share an object — the heading would invert the moment a seal swims
// left.

const team = []; // { root, visual, anim, pos, vel, cooldowns, lungeTarget, ... }
let clock = 0;
// Shared across the squad so only one seal is ever out of formation at a time.
let teamLungeGate = 0;

// One escort's body. `slot` is its index in the squad, and it is what picks
// the seal's procedural skin — see CONFIG.sealTeam.skin. By index rather than
// at random so a seal's identity is stable across a run: the third member is
// always the purple one, which is the entire point of telling them apart.
//
// createVisual has already given this clone its OWN material (assets.js calls
// instantiateBiolumSkin for any asset carrying `biolumSkin`), so stamping a
// variant here paints this seal and no other. Doing it before that clone
// exists would write onto the shared template and repaint the whole squad.
function buildSeal(slot) {
  const root = new THREE.Group();
  const visual = createVisual('sealTeam');
  root.add(visual);
  const skin = CONFIG.sealTeam.skin;
  if (skin?.enabled !== false && skin?.variants?.length) {
    setBiolumSkinVariant(visual, skin.variants[slot % skin.variants.length]);
  }
  const anim = CONFIG.animation.enabled ? createAnimationController(visual) : null;
  return { root, visual, anim };
}

// One squad member. Built in two places (a new level, and a model swap), so
// the per-seal state lives here rather than being spelled out twice and
// drifting apart the next time a field is added.
function newMember(root, visual, anim, pos, vel) {
  return {
    root, visual, anim, pos, vel,
    cooldowns: new Map(), // enemy -> seconds until this seal can ram it again
    lungeTarget: null, // enemy being charged, or null while in formation
    lungeTimer: 0, // seconds left before it gives up on the charge
    lungeRest: 0, // seconds until this seal may lunge again
    fireCooldown: Math.random() * 0.5, // staggered so an evolved squad doesn't volley in lockstep
  };
}

// Grow or shrink the squad to match `count`. Called every frame, but only does
// work when the count actually changed — picking the upgrade mid-run adds a
// seal without disturbing the ones already swimming.
function resize(scene, count, playerPos) {
  while (team.length < count) {
    const { root, visual, anim } = buildSeal(team.length);
    // Spawn on the player so a newly-earned seal swims OUT to its slot rather
    // than popping into position.
    const pos = new THREE.Vector3(playerPos.x, playerPos.y, 0);
    root.position.copy(pos);
    scene.add(root);
    team.push(newMember(root, visual, anim, pos, new THREE.Vector3()));
  }
  while (team.length > count) {
    const t = team.pop();
    scene.remove(t.root);
  }
}

export function resetSealTeam(scene) {
  for (const t of team) scene.remove(t.root);
  team.length = 0;
  clock = 0;
  teamLungeGate = 0;
}

// Swap every seal's model in place — the T-menu upload path, matching how the
// beluga drone and eel companion rebuild.
export function rebuildSealTeam(scene) {
  const saved = team.map((t) => ({ pos: t.pos.clone(), vel: t.vel.clone() }));
  const count = team.length;
  for (const t of team) scene.remove(t.root);
  team.length = 0;
  for (let i = 0; i < count; i++) {
    // Same slot as before the swap, so a re-uploaded model doesn't reshuffle
    // which seal wears which skin.
    const { root, visual, anim } = buildSeal(i);
    root.position.copy(saved[i].pos);
    scene.add(root);
    team.push(newMember(root, visual, anim, saved[i].pos, saved[i].vel));
  }
}

function endLunge(t, cfg) {
  t.lungeTarget = null;
  t.lungeTimer = 0;
  t.lungeRest = cfg.lunge.cooldown;
}

// Nearest live enemy within `range` of a point, or null. Shared by the lunge
// (which wants something to charge) and the evolved shot (which wants
// something to shoot at) — same question, different radius.
function nearestEnemy(enemies, pos, range) {
  let best = null;
  let bestD = range * range;
  for (const e of enemies) {
    if (e.hp <= 0) continue;
    const dx = e.mesh.position.x - pos.x;
    const dy = e.mesh.position.y - pos.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

// Start, continue or abandon a charge. Movement itself is in the main loop —
// this only owns the decision and the timers.
function updateLunge(t, dt, cfg, enemies, hooks) {
  if (!cfg.lunge.enabled) {
    // Toggled off mid-run: anything mid-charge falls straight back into the
    // ring rather than hanging at its last target forever.
    if (t.lungeTarget) endLunge(t, cfg);
    return;
  }

  if (t.lungeTarget) {
    t.lungeTimer -= dt;
    // Target died, was removed from the array, or the charge timed out.
    const gone = t.lungeTarget.hp <= 0 || !enemies.includes(t.lungeTarget);
    if (gone || t.lungeTimer <= 0) endLunge(t, cfg);
    return;
  }

  if (t.lungeRest > 0 || teamLungeGate > 0) return;
  const target = nearestEnemy(enemies, t.pos, cfg.lunge.range);
  if (!target) return;

  t.lungeTarget = target;
  t.lungeTimer = cfg.lunge.maxDuration;
  teamLungeGate = cfg.lunge.teamCooldown;
  // The wind-up, at the seal breaking formation rather than at its target —
  // this is the moment the squad reads as reacting to something, and it was
  // completely silent.
  hooks.onLunge?.(t.pos.x, t.pos.y);
}

// The evolution: escorts shoot the player's own bullet, scaled. Reading the
// live player stats rather than a fixed number is the point — every damage,
// speed and pierce upgrade taken since carries into the squad's fire.
function updateEvolvedFire(t, dt, cfg, enemies, scene, hooks) {
  t.fireCooldown -= dt;
  if (t.fireCooldown > 0) return;

  const target = nearestEnemy(enemies, t.pos, cfg.evolved.range);
  if (!target) return;

  const dx = target.mesh.position.x - t.pos.x;
  const dy = target.mesh.position.y - t.pos.y;
  const len = Math.hypot(dx, dy) || 1;

  const s = player.stats;
  t.fireCooldown = cfg.evolved.fireRate;
  spawnProjectile(scene, {
    origin: new THREE.Vector3(t.pos.x, t.pos.y, 0),
    dir: new THREE.Vector2(dx / len, dy / len),
    faction: 'player',
    damage: s.damage * cfg.evolved.damageMul,
    speed: s.speed * cfg.evolved.speedMul,
    life: s.life,
    radius: s.radius,
    pierce: 0,
    asset: 'bullet',
    // Squad fire is the seal team's damage, not the player's gun — without
    // this tag the playtest report credits every escort's shot to the
    // peashooter and the evolution looks like it does nothing.
    source: 'sealTeam',
  });
  // Aimed along the shot, so the muzzle flash throws forward off the seal
  // that fired rather than blooming symmetrically around it.
  hooks.onSquadFire?.(t.pos.x, t.pos.y, dx / len, dy / len);
}

// hooks: { onEnemyDamaged(e, dmg), onEnemyKilled(e),
//          onLunge(x, y), onRam(x, y), onSquadFire(x, y, dirX, dirY) }
//
// The first two are the same shape as combat.js. The last three are the
// squad's own voice, which it had none of — rams landed carrying only the
// generic damage feedback, and the three things that make this read as a
// SQUAD rather than a damage aura (breaking formation, connecting, and the
// evolved volley) were all silent. Separate hooks because each wants a
// different weight: the lunge is a wind-up, the ram is the hit, and the
// volley repeats forever.
export function updateSealTeam(dt, scene, playerPos, level, enemies, hooks = {}) {
  clock += dt;

  const want = level > 0 ? Math.min(level, CONFIG.sealTeam.maxSeals) : 0;
  resize(scene, want, playerPos);
  if (want === 0) return;

  const cfg = CONFIG.sealTeam;
  const damage = cfg.contactDamage + cfg.damagePerLevel * Math.max(0, level - 1);
  const evolved = level >= cfg.evolveLevel;
  if (teamLungeGate > 0) teamLungeGate -= dt;

  for (let i = 0; i < team.length; i++) {
    const t = team[i];

    if (t.lungeRest > 0) t.lungeRest -= dt;
    updateLunge(t, dt, cfg, enemies, hooks);

    if (t.lungeTarget) {
      // Charging: drive straight at the target instead of tracking the ring.
      // Velocity is written rather than integrated so the spring picks up a
      // sane value the moment the lunge ends — and so the heading below,
      // which reads velocity, points where the seal is actually going.
      const dx = t.lungeTarget.mesh.position.x - t.pos.x;
      const dy = t.lungeTarget.mesh.position.y - t.pos.y;
      const dz = -t.pos.z; // come back into the play plane to connect
      const len = Math.hypot(dx, dy) || 1;
      // Stop short of the centre; the ram lands from contactRadius anyway.
      const closing = Math.max(0, len - cfg.lunge.standoff) / len;
      t.vel.set(dx * closing, dy * closing, dz).normalize().multiplyScalar(cfg.lunge.speed);
      t.pos.addScaledVector(t.vel, dt);
    } else {
      const to = orbitTarget(clock, playerPos, cfg, i, team.length);
      springFollow(t.pos, t.vel, to, dt, cfg.followSpring, cfg.followDamping);
    }
    t.root.position.copy(t.pos);

    if (evolved) updateEvolvedFire(t, dt, cfg, enemies, scene, hooks);

    // Heading from screen-plane velocity only, so swinging through depth
    // doesn't tip the seal onto its back.
    const spd = Math.hypot(t.vel.x, t.vel.y);
    if (spd > 0.3) {
      t.root.rotation.z = Math.atan2(t.vel.y, t.vel.x) - Math.PI / 2;
      t.visual.rotation.y = t.vel.x < 0 ? Math.PI : 0;
    }

    // aboveSurface picks the land clips over the water ones, same rule the
    // player follows — an escort that has breached shouldn't swim-cycle
    // through the air.
    if (t.anim) t.anim.update(dt, stateForSpeed(spd, t.pos.y > bounds.surfaceY), false);

    // Ram anything in reach. Per-enemy cooldowns rather than one global timer,
    // so a seal sitting in a crowd hits each of them on its own schedule
    // instead of only ever damaging whichever one was checked first.
    //
    // Backwards by index because a kill splices the array — same contract as
    // garlic and combat: whoever lands the killing blow calls onEnemyKilled
    // AND removeEnemy. Skipping the removal would leave the enemy sitting at
    // zero HP to be "killed" again on the next cooldown, farming score.
    for (let j = enemies.length - 1; j >= 0; j--) {
      const e = enemies[j];
      const dx = e.mesh.position.x - t.pos.x;
      const dy = e.mesh.position.y - t.pos.y;
      const reach = cfg.contactRadius + (e.radius ?? 0.5);
      if (dx * dx + dy * dy > reach * reach) continue;

      if ((t.cooldowns.get(e) ?? 0) > 0) continue;
      t.cooldowns.set(e, cfg.contactCooldown);

      // Fired at the point of contact rather than at either body, and BEFORE
      // the kill below, which splices the enemy out and takes its mesh
      // position with it.
      hooks.onRam?.((t.pos.x + e.mesh.position.x) * 0.5, (t.pos.y + e.mesh.position.y) * 0.5);

      e.hp -= damage;
      if (e.hp <= 0) {
        hooks.onEnemyKilled?.(e);
        removeEnemy(scene, j);
        // Every seal's cooldown map may hold this enemy; the sweep below
        // drops stale keys, but clear ours now so it can't be re-hit this
        // frame by a later index.
        t.cooldowns.delete(e);
      } else {
        hooks.onEnemyDamaged?.(e, damage);
      }

      // A charge that connects is over — the hit IS the lunge. Without this
      // the seal would sit on top of its target ramming it on the contact
      // cooldown until the timer ran out, which is a completely different
      // (and much stronger) move than a hit-and-run.
      if (e === t.lungeTarget) endLunge(t, cfg);
    }

    // Tick cooldowns down and drop entries for enemies that are gone, or the
    // map grows for the whole run and keeps dead enemies referenced.
    for (const [enemy, left] of t.cooldowns) {
      const next = left - dt;
      if (next <= 0 || !enemies.includes(enemy)) t.cooldowns.delete(enemy);
      else t.cooldowns.set(enemy, next);
    }
  }
}
