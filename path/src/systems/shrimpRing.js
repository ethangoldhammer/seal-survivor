import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createVisual } from '../assets.js';
import { removeEnemy } from '../entities/enemies.js';

// One entry per orbiting instance: { mesh, angleOffset, cooldowns: Map<enemy, secondsLeft> }
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
  instances.push({ mesh, angleOffset: 0, cooldowns: new Map() });
  redistributeAngles();
}

function removeInstance() {
  const inst = instances.pop();
  if (inst) group.remove(inst.mesh);
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
export function updateShrimpRing(dt, scene, playerPos, shrimpCount, enemiesList, hooks) {
  if (!group) return;
  syncCount(Math.max(0, Math.floor(shrimpCount)));
  clock += dt;

  const radius = CONFIG.shrimpRing.radius;
  const scale = CONFIG.shrimpRing.scale;
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
    inst.mesh.scale.setScalar(scale);

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
      const e = enemiesList[i];
      if (inst.cooldowns.has(e)) continue;
      const dx = e.mesh.position.x - worldX;
      const dy = e.mesh.position.y - worldY;
      const combined = reach + e.radius;
      if (dx * dx + dy * dy > combined * combined) continue;

      e.hp -= CONFIG.shrimpRing.contactDamage;
      e.flash = CONFIG.fx.hitFlash;
      e.hitThisFrame = true;
      inst.cooldowns.set(e, CONFIG.shrimpRing.contactCooldown);
      hooks.onEnemyDamaged?.(e, CONFIG.shrimpRing.contactDamage);
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
  for (const inst of instances) group?.remove(inst.mesh);
  instances = [];
  clock = 0;
}
