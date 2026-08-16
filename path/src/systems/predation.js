import { CONFIG } from '../config.js';
import { enemies, removeEnemy, triggerBite } from '../entities/enemies.js';
import { crewPosition, crewRadius, eatCrew } from './crew.js';

// Sharks feed on fish on their own, with no involvement from the player. This
// is the one place enemies interact with each other, so the whole food chain
// is tunable from here plus the `hunt` block in config.
//
// The tactical consequence: leave a school alive and the sharks in it get
// steadily tougher, so clearing fish early is a real decision rather than
// just easy XP.
export function resolvePredation(dt, scene, hooks) {
  const predators = [];
  // Who is still alive as of this call. `preyTarget` is written back in
  // updateEnemies, and half a dozen systems (garlic, the eel, the seal team,
  // Bakalar's net) get to kill things in between — so a hunter can arrive here
  // still holding a fish that no longer exists. Without this the lunge pass
  // below would snap at the last position of something already despawned.
  const live = new Set(enemies);
  for (const e of enemies) if (e.def.hunt) predators.push(e);
  if (predators.length === 0) return;

  // Open the mouth on the way IN.
  //
  // Eating is instantaneous — the loop below deletes the fish the frame it
  // comes inside `biteRange` — so a jaw fired on the eat would gape at an
  // empty patch of water a moment after the meal had already vanished. This
  // pass runs first, at CONFIG.bite.lead times the same reach, off the target
  // the hunter is already steering at (BEHAVIORS.hunt wrote `preyTarget`). By
  // the time the fish crosses biteRange the jaws are wide and closing.
  //
  // Deliberately NOT its own proximity search: reusing the steering target
  // means the shark only ever snaps at the fish it actually committed to,
  // instead of at whatever happens to drift past its face.
  if (CONFIG.bite?.enabled) {
    for (const pred of predators) {
      const prey = pred.preyTarget;
      if (!prey || !live.has(prey) || pred.biteCooldown > 0) continue;
      const range = (pred.def.hunt.biteRange ?? 1.5) * pred.spawnScale + prey.radius;
      const reach = range * (CONFIG.bite.lead ?? 1);
      const dx = prey.mesh.position.x - pred.mesh.position.x;
      const dy = prey.mesh.position.y - pred.mesh.position.y;
      if (dx * dx + dy * dy <= reach * reach) triggerBite(pred);
    }
  }

  // --- bodies in the water --------------------------------------------------
  // The hunt behaviour steers at one (see BEHAVIORS.hunt); this is where the
  // mouth closes. Its own pass, before the fish, because a hunter that has
  // committed to a body should not be distracted by a minnow drifting past on
  // the way in.
  const food = CONFIG.boats.crew?.food ?? {};
  for (const pred of predators) {
    const body = pred.humanTarget;
    if (!body) continue;
    const at = crewPosition(body);
    const reach = (food.biteRange ?? 1.4) * pred.spawnScale + crewRadius(body);
    const dx = at.x - pred.mesh.position.x;
    const dy = at.y - pred.mesh.position.y;
    if (dx * dx + dy * dy > reach * reach) {
      // Still on the way. Open the jaws at the same lead the fish get.
      if (CONFIG.bite?.enabled && pred.biteCooldown <= 0
        && dx * dx + dy * dy <= (reach * (CONFIG.bite.lead ?? 1)) ** 2) triggerBite(pred);
      continue;
    }
    const meal = eatCrew(scene, body, { vx: pred.vx, vy: pred.vy });
    pred.humanTarget = null;
    if (!meal) continue; // somebody else got there first
    triggerBite(pred);
    hooks.onCrewEaten?.(meal.x, meal.y, pred);
  }

  for (const pred of predators) {
    if (pred.biteTimer > 0) continue;
    const h = pred.def.hunt;
    const range = h.biteRange ?? 1.5;

    // Iterate backwards: eating removes an enemy mid-loop.
    for (let i = enemies.length - 1; i >= 0; i--) {
      const target = enemies[i];
      if (!target.def.prey || target === pred) continue;

      const dx = target.mesh.position.x - pred.mesh.position.x;
      const dy = target.mesh.position.y - pred.mesh.position.y;
      const reach = range * pred.spawnScale + target.radius;
      if (dx * dx + dy * dy > reach * reach) continue;

      // Eat it.
      hooks?.onFishEaten?.(target, pred);
      removeEnemy(scene, i);

      pred.meals += 1;
      pred.biteTimer = h.biteCooldown ?? 0.8;

      const ceiling = pred.spawnHp * (h.maxOverheal ?? 2);
      pred.hp = Math.min(ceiling, pred.hp + (h.healPerMeal ?? 0));
      pred.maxHp = Math.max(pred.maxHp, pred.hp);

      const grow = h.growPerMeal ?? 0;
      if (grow > 0) {
        // baseScale is the growth multiplier ON TOP of the scale this
        // predator spawned at, not an absolute scale — setting the absolute
        // scale here discarded spawnScale and shrank a tuner-enlarged shark
        // back to its authored size the first time it ate.
        const s = Math.min(h.maxGrow ?? 1.5, 1 + pred.meals * grow);
        pred.baseScale = s;
        pred.visual.scale.setScalar(pred.spawnScale * s);
        // A predator that has visibly grown hits and gets hit at its new size.
        pred.radius = pred.def.radius * pred.spawnScale * s;
      }
      break; // one bite per cooldown
    }
  }
}
