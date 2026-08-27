import { CONFIG } from '../config.js';
import { isInvulnerable } from './strike.js';
import { boats, damageBoat, hitsBoat } from './boats.js';
import { damageDebris } from './boatDebris.js';
import { damageCrew } from './crew.js';
import { enemies, removeEnemy, applyKnockback } from '../entities/enemies.js';
import { projectiles, despawn, chainToEnemy, deflectProjectile } from '../entities/projectiles.js';
import { player } from '../entities/player.js';
import { applyElementalHit, chillEnemy, activeElement } from './elements.js';
import { applyHarpCharm } from './harp.js';
import { hitCreature } from './hitShape.js';
import { hotSpotDamage } from './bossHotSpots.js';
import { pinchReach, clawSetting } from './crabClaw.js';

// Where the last hit landed on the body, refilled by every hitCreature call
// that passes. One shared object rather than one per test: this is the hottest
// loop in the game and the value is consumed before the next test overwrites
// it. Read it immediately or copy it.
const contact = { x: 0, y: 0, nx: 0, ny: 0, depth: 0, sphere: null, index: -1 };

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
      // A boss still making its entrance. Not `b.hits.add(e)` and not a
      // despawn either: the shot passes through and keeps going, so a player
      // who fired into the ceremony gets their pellet back rather than having
      // it eaten by an invisible wall. See tickArrival in systems/boss.js for
      // why this guard exists here as well as in the per-frame hp restore —
      // this is the one damage source big enough to kill in a single frame.
      if (e.invuln > 0) continue;

      // Against the CREATURE, which for most of the roster is the circle it
      // has always been and for a boss is a shape fitted to its own bones.
      // Both answer through the same call so there is one hit test in the game
      // and not two that can drift apart.
      if (!hitCreature(e, b.mesh.position.x, b.mesh.position.y, b.radius, contact)) continue;

      // A WEAK SPOT, IF THE SHOT FOUND ONE. Returns the damage unchanged for
      // every hit on every creature in the game that is not a boss wearing
      // one, so this is one lookup rather than a branch — and it has to happen
      // HERE, before the subtraction, because everything downstream (the death
      // check, the feedback hook, the playtest ledger) has to agree about what
      // this shot was worth. `b.damage` itself is left alone: it is the
      // pellet's own damage and is read again by the chain and the pierce.
      // The PELLET's position as well as the contact — see hotSpotDamage. The
      // contact is on the collision hull and can be attributed to a different
      // part of the animal entirely; the bullet is where the shot was.
      const dealt = hotSpotDamage(e, contact, b.damage, b.mesh.position);

      e.hp -= dealt;
      b.hits.add(e);
      e.flash = CONFIG.fx.hitFlash;
      e.hitThisFrame = true;
      // WHERE IT LANDED, not where the bullet was. A shot moving 40 units a
      // second is most of a metre inside the animal by the time the test that
      // caught it returns, so passing its own position drew every impact
      // buried in the body — and on a boss, several metres off the surface it
      // supposedly struck. `contact` is the point on the skin, and everything
      // downstream (the flash, the sparks, the splash, the ripple) has always
      // taken this argument as "the impact" and simply been given a worse one.
      hooks.onEnemyDamaged?.(e, dealt, contact.x, contact.y, b.dir, b, contact);

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
        // `b` rides along so the element can tell WHICH pellet landed — the
        // contagion's motes orbit the shot and are handed to the fish here.
        applyElementalHit(scene, e, b.damage, enemies, hooks, 1, b);

        // ...AND THE FLIPPER'S OWN ELEMENT, if the fin this pellet left is
        // carrying one. A SECOND packet beside the run's rather than a
        // replacement for it — Flippers Up! puts an element on a fin, and a card
        // must not be able to overwrite the element the player is already
        // playing (the same rule `b.chill` below is written under).
        //
        // Skipped when the fin rolled the run's own element, and that is not an
        // optimisation: levelOf() already folded the fin's depth into the single
        // application above, so landing it twice would pay one element two
        // packets for having come from two places.
        if (b.finElement && b.finElement !== activeElement()) {
          applyElementalHit(scene, e, b.damage, enemies, hooks, 1, b, { element: b.finElement });
        }
      }

      // A shot that carries ice (the ice club's thrown variant). Its own
      // channel rather than a second element: the run's element is a thing you
      // rolled and this is a thing you built, and a card should not be able to
      // overwrite the element the player is already playing. Before the death
      // check, so a club that finishes a fish still reads as having frozen it.
      if (b.chill) {
        chillEnemy(e, b.chill.slow, b.chill.duration, b.chill.freezeFor, hooks,
          e.mesh.position.x, e.mesh.position.y);
      }

      // A shot that SHOVES (the thrown club). Same payload arrangement as the
      // chill above and for the same reason — the shot describes what it is
      // carrying and entities/enemies.js owns what a knockback is. Along the
      // bullet's own heading, so a body leaves the way the thing that hit it
      // was travelling, and before the death check so a shot that finishes a
      // fish still throws the corpse rather than dropping it on the spot.
      if (b.knockback > 0) applyKnockback(e, b.dir.x, b.dir.y, b.knockback);

      // A note from the harp. Also before the death check, and for a reason
      // that is not cosmetic here: a note that KILLS what it charmed has to
      // report the charm anyway or the sting and the corpse disagree about
      // what just happened. `applyHarpCharm` reports whether the note did
      // anything at all — on a boss that is a DAZE rather than a charm, which
      // is a real event and says so, and it is false only when even that was
      // refused (a boss still inside its daze recovery), where the note was
      // worth its damage and nothing more.
      if (b.charm && applyHarpCharm(e, b.charm)) {
        hooks.onCharmed?.(e, contact.x, contact.y);
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

    // Third argument is who did it, for the playtest recorder: the shot
    // carries its firer's type (see spawnProjectile's `source`).
    //
    // 'strike' is the I-FRAME CHANNEL — a discrete blow, refused outright if
    // another one landed inside CONFIG.player.hitIFrames, and arming that
    // window itself when it lands. It used to be spelled out here as a
    // player.invuln test and a write, which is why it covered shots and nothing
    // else: a crab's pinch, a shark's bite and a trap's snap are all the same
    // kind of event and none of them had it. onPlayerHit owns the whole rule
    // now, in one place, and every burst asks for it by naming the channel.
    if (!isInvulnerable()) {
      hooks.onPlayerHit(b.damage, b.dir, b.source ?? 'enemy shot', 'strike');
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
    // A boss arriving is harmless for exactly as long as it is untouchable —
    // see CONFIG.boss.arrival. One without the other turns the entrance into a
    // punishment for watching it.
    // ...AND AN ANIMAL THAT ALREADY HAS YOU IN ITS MOUTH does not also charge
    // you for touching it. A grab bills its own chewing on its own clock (see
    // systems/bossGrab.js), and the seal is pinned INSIDE the body for the whole
    // two seconds — so without this the one attack that holds you still would
    // collect the full contact drain the entire time it held you, which is the
    // same attack paid twice and the exact shape the damage ceilings exist to
    // refuse.
    if (e.trapTimer > 0 || e.charmTimer > 0 || e.invuln > 0 || e.grabbing) continue;

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
          // 'strike': a burst timed to an attack animation is exactly the kind
          // of hit the i-frame window exists for — see the note on the shot
          // above.
          hooks.onPlayerHit(
            e.contactDamage ?? e.def.contactDamage, { x: -dx, y: -dy }, e.type, 'strike',
          );
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
      const px = e.mesh.position.x - pPos.x;
      const py = e.mesh.position.y - pPos.y;
      // Scaled by the crab's own ARM — the reach the IK solver actually aims
      // by, measured off this individual's skeleton, so a crab that grew over
      // a long run reaches proportionally further. It was scaled by `e.radius`
      // instead, which is a 0.2-unit hitbox on a six-unit animal; see
      // pinchReach for how that quietly shrank the whole mechanic to nothing.
      // Shared with the COMMIT gate in entities/enemies.js rather than restated:
      // the two are one mechanic measured twice, and the last time they were
      // written separately only this one added `pRadius`, which silently killed
      // the pinch the moment the crab's hitbox was retuned.
      // ...and through clawSetting, so a creature carrying its own claw block
      // (the king crab does) is measured by the same numbers its commit gate
      // used. Restating CONFIG.crabClaw here is exactly how the two halves came
      // apart the first time.
      const reachSq = pinchReach(e.claw?.reach() ?? 0, pRadius,
        clawSetting(e.def, 'range') ?? 0.65) ** 2;
      if (px * px + py * py <= reachSq && !isInvulnerable()) {
        const base = e.contactDamage ?? e.def.contactDamage;
        const knock = clawSetting(e.def, 'knockback') ?? 1.4;
        hooks.onPlayerHit(
          base * (clawSetting(e.def, 'damageMul') ?? 0.75),
          // Shoved harder than an ordinary contact, and away from the crab.
          { x: -px * knock, y: -py * knock },
          e.type,
          // 'strike', AND THIS IS THE ONE THAT MADE THE CHANNEL NECESSARY. Nine
          // crabs on a chum pile shut their claws inside a few frames of each
          // other, and every one of them billed. The pinch is a much bigger
          // number than it used to be (contact is 0 now — see below), so a
          // swarm landing together was half the bar between two frames with one
          // flash to show for it. One pinch per window is paid; the rest of the
          // swarm still swings, still connects visually, and still gets its
          // turn as soon as the window is up.
          'strike',
        );
      }
    }

    // THE SAME SHAPE THAT DECIDES WHETHER YOU CAN HIT IT decides whether it
    // can hit you. Splitting those two was never on the table: a boss you can
    // swim past but that still damages you from a body-width away is the
    // exact complaint the circle produced, in the direction that costs the
    // player health.
    if (!hitCreature(e, pPos.x, pPos.y, pRadius, contact)) continue;
    const dx = e.mesh.position.x - pPos.x;
    const dy = e.mesh.position.y - pPos.y;
    if (!isInvulnerable()) {
      // The shove still comes from the creature's CENTRE and not from the
      // contact point. A contact-point normal on a long body points sideways
      // out of the flank, which would slide the player along a shark rather
      // than pushing them off it — and being pushed along the animal you are
      // touching keeps you touching it.
      //
      // THE ONE PLACE THE 'contact' CHANNEL IS DECLARED. It is what holds a
      // boss's overlap to CONFIG.boss.damageCap.contactPerSecond instead of
      // letting it eat the whole fight's budget every frame you are inside the
      // body — see capBossDamage in systems/boss.js for what that was doing.
      // Ordinary wildlife ignores the channel entirely; a school chewing
      // through your bar is the fight working.
      //
      // ...unless the animal is RAMMING, which is the kraken's crush, the
      // anglerfish's strike and the lunge perk. Those three multiply this same
      // number for a committed run, so for as long as one is live the body is
      // the attack and is billed as one.
      // ...AND A CRAB CHARGES NOTHING FOR IT. `contactMul` is 0 for anything
      // carrying a claw driver (which is the two crabs and the king crab, and
      // nothing else in the roster — createClawDriver returns null for every
      // model with no clawRig, so this cannot quietly defang anything).
      //
      // A crab is a thing that PINCHES you. It spent years as a walking contact
      // hitbox with a telegraphed gesture painted on top, and the gesture was
      // the smaller of the two — which made the 0.42s rear-up a warning about
      // the less important thing the animal was doing. Its whole damage budget
      // goes through the claw now (see the pinch branch above and
      // CONFIG.crabClaw.contactMul), so the tell is the attack and swimming
      // through a crab that has not swung is genuinely free.
      //
      // Asked through clawSetting so a creature with its own claw block gets
      // its own answer, exactly like both halves of the pinch.
      const contactMul = e.claw ? (clawSetting(e.def, 'contactMul') ?? 0) : 1;
      if (!(contactMul > 0)) continue;
      hooks.onPlayerHit(
        (e.contactDamage ?? e.def.contactDamage) * contactMul * dt, // per second on contact
        { x: -dx, y: -dy },
        e.type,
        e.ramming ? 'attack' : 'contact',
      );
    }
  }
}
