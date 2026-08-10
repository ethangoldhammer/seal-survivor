import { CONFIG } from '../config.js';
import { isInvulnerable } from './strike.js';
import { boats, damageBoat, hitsBoat } from './boats.js';
import { damageDebris } from './boatDebris.js';
import { damageCrew } from './crew.js';
import { enemies, removeEnemy } from '../entities/enemies.js';
import { projectiles, despawn, chainToEnemy, deflectProjectile } from '../entities/projectiles.js';
import { player } from '../entities/player.js';
import { applyElementalHit } from './elements.js';

// A chaining shot (the bounce weapon) spends one of its bounces to ricochet off
// whatever it just hit and carry on, instead of being consumed by the impact.
// Returns false once its bounces are gone, which is the caller's cue to despawn
// it the way an ordinary bullet would.
function tryChain(b, enemyList, justHit, hooks) {
  if (!b.chain || b.bouncesLeft <= 0) return false;
  b.bouncesLeft -= 1;
  b.bounceCombo += 1;
  b.hitLock = b.chainLock;
  b.speed *= b.chainSpeedGain;
  if (!chainToEnemy(b, enemyList, justHit)) deflectProjectile(b);
  hooks.onProjectileChained?.(b, b.mesh.position.x, b.mesh.position.y);
  return true;
}

// Every hit test in the game lives here, so tuning feel (hitbox generosity,
// pierce, i-frames) means editing one file.
export function resolveCombat(dt, scene, hooks) {
  const pPos = player.mesh.position;
  const pRadius = player.stats.hitRadius;

  // --- player bullets vs enemies -------------------------------------------
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const b = projectiles[i];
    if (b.faction !== 'player') continue;
    if (b.hitLock > 0) continue; // just ricocheted — let it clear the body first

    for (let j = enemies.length - 1; j >= 0; j--) {
      const e = enemies[j];
      if (b.hits.has(e)) continue;

      const reach = b.radius + e.radius;
      const dx = b.mesh.position.x - e.mesh.position.x;
      const dy = b.mesh.position.y - e.mesh.position.y;
      if (dx * dx + dy * dy > reach * reach) continue;

      e.hp -= b.damage;
      b.hits.add(e);
      e.flash = CONFIG.fx.hitFlash;
      e.hitThisFrame = true;
      hooks.onEnemyDamaged?.(e, b.damage, b.mesh.position.x, b.mesh.position.y, b.dir, b);

      // Glow Up! rides the BASIC SHOT and nothing else here. Gated on the
      // source rather than on the faction because every ability in the game
      // spawns its projectiles through this same list — un-gated, one card
      // would put an element on mussels, scallops, starfish, ricochets, pearls
      // and shrapnel at once, which is a different (and much larger) upgrade
      // than the one on the card.
      //
      // Applied BEFORE the death check below, so a pellet that finishes a fish
      // with its elemental half still counts as the kill.
      if (b.source === 'gun') {
        applyElementalHit(scene, e, b.damage, enemies, hooks);
      }

      if (e.hp <= 0) {
        hooks.onEnemyKilled(e);
        removeEnemy(scene, j);
      }

      if (b.pierce > 0) {
        b.pierce -= 1;
      } else if (tryChain(b, enemies, e, hooks)) {
        break; // still alive, now aimed at its next target
      } else {
        despawn(scene, i);
        break;
      }
    }
  }

  // --- enemy bullets vs player ---------------------------------------------
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const b = projectiles[i];
    if (b.faction !== 'enemy') continue;

    const reach = b.radius + pRadius;
    const dx = b.mesh.position.x - pPos.x;
    const dy = b.mesh.position.y - pPos.y;
    if (dx * dx + dy * dy > reach * reach) continue;

    if (player.invuln <= 0) {
      // Third argument is who did it, for the playtest recorder: the shot
      // carries its firer's type (see spawnProjectile's `source`).
      if (!isInvulnerable()) hooks.onPlayerHit(b.damage, b.dir, b.source ?? 'enemy shot');
      player.invuln = player.stats.invulnAfterHit;
    }
    despawn(scene, i);
  }

  // --- player bullets vs boats -------------------------------------------
  // Boats sit above the water line and aren't in the `enemies` array, so
  // they need their own pass. Same pierce rules apply.
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const b = projectiles[i];
    if (b.faction !== 'player') continue;
    if (b.hitLock > 0) continue;
    for (let j = boats.length - 1; j >= 0; j--) {
      const boat = boats[j];
      if (b.hits.has(boat)) continue;
      // A hull is a long, flat box, not a circle — see hitsBoat.
      if (!hitsBoat(boat, b.mesh.position.x, b.mesh.position.y, b.radius)) continue;
      b.hits.add(boat);
      const destroyed = damageBoat(scene, j, b.damage, {
        onBoatDestroyed: (bt, chum) => hooks.onBoatDestroyed?.(bt, chum),
      }, b.dir, b.mesh.position);
      // The projectile rides along so the caller can tell WHAT hit the hull —
      // a mussel detonating on a trawler should look like a mussel detonating,
      // the same as it does on a body, not like a pellet ricocheting off it.
      hooks.onBoatHit?.(boat, b.damage, b.mesh.position.x, b.mesh.position.y, b);
      if (b.pierce <= 0) {
        // A bounce shot ricochets off a hull the same way it does off a body.
        if (!tryChain(b, enemies, null, hooks)) despawn(scene, i);
        break;
      }
      b.pierce -= 1;
      if (destroyed) break;
    }
  }

  // --- player bullets vs the crew ------------------------------------------
  // A man standing on a deck is not cover: the shot carries on to the hull
  // behind him (this pass consumes nothing), it just takes him with it.
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const b = projectiles[i];
    if (b.faction !== 'player') continue;
    damageCrew(scene, b.mesh.position.x, b.mesh.position.y, b.radius, {
      dirX: b.dir?.x,
      dirY: b.dir?.y,
      onCrewHit: (x, y) => hooks.onCrewHit?.(x, y),
    });
  }

  // --- player bullets vs floating wreckage ---------------------------------
  // The chunks a sunk boat leaves are targets in their own right: they take
  // damage, break up, and sometimes have something in them. Kept as its own
  // pass rather than folded into the hull loop above because wreckage has no
  // faction, no hp bar and no death hook — it's scenery you can shoot.
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const b = projectiles[i];
    if (b.faction !== 'player') continue;
    if (b.hitLock > 0) continue;
    const hit = damageDebris(scene, b.mesh.position.x, b.mesh.position.y, b.radius, b.damage, {
      // One pellet, one chunk — the blast paths (splashes, the dash) are the
      // ones that take everything they cover.
      single: true,
      onDebrisHit: (x, y) => hooks.onDebrisHit?.(x, y),
      onDebrisBroken: (x, y) => hooks.onDebrisBroken?.(x, y),
    });
    if (!hit) continue;
    // Spent on the wreckage unless it pierces, exactly like a hull.
    if (b.pierce > 0) b.pierce -= 1;
    else if (!tryChain(b, enemies, null, hooks)) despawn(scene, i);
  }

  // --- enemy contact damage ------------------------------------------------
  for (const e of enemies) {
    // Held or charmed creatures can't hurt you. enemies.js has described a
    // bubbled enemy as "frozen, harmless" since the beluga shipped, but nothing
    // here ever checked it — so a trapped fish you swam into still chewed
    // through your health while sitting motionless inside a bubble. The charm
    // from the dumbo octopus is pacification and nothing else, so it has to
    // gate the same thing.
    if (e.trapTimer > 0 || e.charmTimer > 0) continue;

    // Trap enemies deal damage as a burst timed with their attack animation,
    // not continuous per-second contact — they're usually not even touching
    // the player when the claw closes on them.
    if (e.def.behavior === 'trap') {
      if (e.justAttacked) {
        const dx = e.mesh.position.x - pPos.x;
        const dy = e.mesh.position.y - pPos.y;
        const reach = (e.def.trap?.range ?? 3) * e.spawnScale + pRadius;
        // Contact has no projectile to take a direction from, so the shove
        // comes from wherever the attacker is standing.
        if (dx * dx + dy * dy <= reach * reach && !isInvulnerable()) {
          hooks.onPlayerHit(e.contactDamage ?? e.def.contactDamage, { x: -dx, y: -dy }, e.type);
        }
      }
      continue;
    }

    // The crab's pinch. A burst on the frame the claws meet, at a longer reach
    // than touching — the crab told you it was coming (systems/crabClaw.js
    // spends 0.42s rearing up first), so this is the price of not reading it.
    //
    // Deliberately IN ADDITION to the contact damage below rather than instead
    // of it: touching a crab still hurts, and the pinch is what stops standing
    // just outside touching distance from being free. `damageMul` is what keeps
    // that from being a straight buff — see CONFIG.crabClaw.
    //
    // Both are charged the same frame if the player is close enough for both,
    // which is correct: they walked into a crab that was already swinging.
    if (e.justPinched) {
      const pc = CONFIG.crabClaw;
      const px = e.mesh.position.x - pPos.x;
      const py = e.mesh.position.y - pPos.y;
      // Scaled by the crab's own radius, so a crab that has grown over a long
      // run reaches proportionally further — the same rule the driver aims by.
      const pinchReach = e.radius * (pc.range ?? 2.4) + pRadius;
      if (px * px + py * py <= pinchReach * pinchReach && !isInvulnerable()) {
        const base = e.contactDamage ?? e.def.contactDamage;
        hooks.onPlayerHit(
          base * (pc.damageMul ?? 0.75),
          // Shoved harder than an ordinary contact, and away from the crab.
          { x: -px * (pc.knockback ?? 1.4), y: -py * (pc.knockback ?? 1.4) },
          e.type,
        );
      }
    }

    const reach = e.radius + pRadius;
    const dx = e.mesh.position.x - pPos.x;
    const dy = e.mesh.position.y - pPos.y;
    if (dx * dx + dy * dy > reach * reach) continue;
    if (!isInvulnerable()) hooks.onPlayerHit((e.contactDamage ?? e.def.contactDamage) * dt, { x: -dx, y: -dy }, e.type); // damage-per-second on contact
  }
}
