import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createVisual } from '../assets.js';
import { removeEnemy } from '../entities/enemies.js';
import { shrimpRingLevelStats } from '../levelStats.js';
import { hitCreature } from './hitShape.js';
import { attachDamageGlow, stoke, cool, glowLevel } from './damageGlow.js';

// See the note on combat.js's `contact` — shared, and read before the next
// test can overwrite it.
const ringContact = { x: 0, y: 0, nx: 0, ny: 0, depth: 0, sphere: null, index: -1 };

// One entry per orbiting instance:
// { mesh, angleOffset, cooldowns: Map<enemy, secondsLeft>, heat, glow }
//
// `heat` and `glow` are this shrimp's own — see systems/damageGlow.js. Per
// instance rather than per ring because the ring is a circle of individuals
// and the one that connected is the only one with anything to say; a ring-wide
// flare would be the least informative version of the same light.
let instances = [];
let group = null;
let clock = 0;

export function createShrimpRingVisual() {
  group = new THREE.Group();
  return group;
}

function addInstance() {
  const mesh = createVisual('shrimp');
  group.add(mesh);
  // Its own materials, so this shrimp can light up without lighting the other
  // seven. Null on a build where the model never loaded and the primitive
  // stand-in has nothing to brighten — every call below is optional-chained
  // for exactly that.
  instances.push({ mesh, angleOffset: 0, cooldowns: new Map(), heat: 0, glow: attachDamageGlow(mesh) });
  redistributeAngles();
}

function removeInstance() {
  const inst = instances.pop();
  if (inst) {
    inst.glow?.release();
    group.remove(inst.mesh);
  }
  redistributeAngles();
}

// Spread evenly whenever the count changes, so adding a shrimp doesn't leave
// an awkward gap.
function redistributeAngles() {
  const n = instances.length;
  for (let i = 0; i < n; i++) instances[i].angleOffset = (i / n) * Math.PI * 2;
}

function syncCount(desired) {
  while (instances.length < desired) addInstance();
  while (instances.length > desired) removeInstance();
}

// hooks: { onEnemyDamaged(e, dmg), onEnemyKilled(e), onContact(x, y) }
// onContact is per shrimp per enemy, gated by that shrimp's own contact
// cooldown — a full ring sweeping a school can fire several on one frame,
// which is what the event's `sfxMinGap` is sized for.
export function updateShrimpRing(dt, scene, playerPos, shrimpCount, shrimpLevel, stats, enemiesList, hooks) {
  if (!group) return;
  syncCount(Math.max(0, Math.floor(shrimpCount)));
  clock += dt;

  const radius = CONFIG.shrimpRing.radius;
  // WHAT A SHRIMP IS AT THIS STACK — through levelStats.js, like the garlic
  // cloud above it, so the size the tip quotes is the size the ring is drawn
  // at AND the reach it bites with. `reach` below is derived from this exact
  // number, which is what stops the picture and the hitbox disagreeing.
  //
  // The COUNT is a separate argument on purpose: Clone Warz and Entourage both
  // add shrimp, and neither of them is a stack of this card.
  const per = shrimpRingLevelStats(shrimpLevel, stats);
  const scale = per.shrimpSize;
  const speed = CONFIG.shrimpRing.orbitSpeed;

  group.position.x = playerPos.x;
  group.position.y = playerPos.y;

  for (const inst of instances) {
    const angle = clock * speed + inst.angleOffset;
    inst.mesh.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius, -0.05);
    inst.mesh.rotation.z = angle + Math.PI / 2;
    // ASSETS.shrimp.fit is the model's size at scale 1, so the slider is a
    // plain multiplier on it — same arithmetic the procedural fallback needs,
    // hence no branch. (It used to be model-only-when-not-uploaded, which left
    // the slider doing nothing at all once a model was in.)
    // HOT WHILE IT IS BITING. The heat is stoked below, on contact; here it is
    // only carried to now and spent — on the model's own glow (which the bloom
    // pass then haloes) and on a scale punch, which is the same per-instance
    // channel a hit on an enemy uses, for the same reason: it is the one that
    // survives a shared material.
    inst.heat = cool(inst.heat, 'shrimpRing', dt);
    const heat = glowLevel(inst.heat, 'shrimpRing');
    inst.glow?.set(heat, 'shrimpRing');
    inst.mesh.scale.setScalar(scale * (1 + (CONFIG.shrimpRing.hitPop ?? 0.25) * heat));

    // Tick down this shrimp's per-enemy cooldowns.
    for (const [enemy, t] of inst.cooldowns) {
      const left = t - dt;
      if (left <= 0) inst.cooldowns.delete(enemy);
      else inst.cooldowns.set(enemy, left);
    }

    const worldX = group.position.x + inst.mesh.position.x;
    const worldY = group.position.y + inst.mesh.position.y;
    const reach = scale + 0.5; // rough contact radius for the cloned instance

    for (let i = enemiesList.length - 1; i >= 0; i--) {
      // Shrink-safe: a kill inside this loop can take several creatures out of
      // the list at once. See the note in systems/club.js.
      const e = enemiesList[i];
      if (!e) continue;
      if (inst.cooldowns.has(e)) continue;
      // Against the measured body where there is one, so a shrimp brushing a
      // boss's flank connects with the flank and not with a circle drawn
      // around its middle. Everything else in the water is still the circle it
      // has always been — see systems/hitShape.js.
      if (!hitCreature(e, worldX, worldY, reach, ringContact)) continue;

      // Read once, so the hit and the number reported to the feedback layer
      // cannot disagree about how hard the shrimp hit.
      const dmg = per.shrimpDamage;
      e.hp -= dmg;
      e.flash = CONFIG.fx.hitFlash;
      e.hitThisFrame = true;
      inst.cooldowns.set(e, CONFIG.shrimpRing.contactCooldown);
      // Stoked on the frame it lands, and read on the NEXT frame's carry —
      // which is the frame the flare is wanted on, since the contact and the
      // damage number both happen on this one.
      inst.heat = stoke(inst.heat, 'shrimpRing');
      hooks.onEnemyDamaged?.(e, dmg, ringContact.x, ringContact.y, null, null, ringContact);
      // At the shrimp, not the enemy — the ring is a fixed radius around the
      // player, so contacts happening out on that circle is the read.
      hooks.onContact?.(worldX, worldY);
      if (e.hp <= 0) {
        hooks.onEnemyKilled?.(e);
        removeEnemy(scene, i);
      }
    }
  }
}

export function resetShrimpRing() {
  for (const inst of instances) {
    inst.glow?.release();
    group?.remove(inst.mesh);
  }
  instances = [];
  clock = 0;
}
