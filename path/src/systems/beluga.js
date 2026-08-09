import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createVisual } from '../assets.js';
import { orbitTarget, springFollow } from './orbit.js';

// A drone that orbits the ship and periodically fires a bubble at the
// nearest enemy. Unlike every other weapon in the game, a hit doesn't deal
// damage — it traps the target (frozen, harmless) for a fixed duration, so
// this runs its own small collision check rather than going through
// combat.js, which is damage-only.

// Two nested objects, matching the convention every other creature uses
// (enemies split e.mesh / e.visual, the player splits mesh / body):
//   drone  — outer, owns position and the heading rotation on Z
//   visual — inner, owns ONLY the left/right mirror on Y
// They must stay separate. Setting rotation.y = PI on the same object that
// carries rotation.z re-orients the axis that Z then turns about, so the
// heading comes out inverted the moment the drone swims left — which is
// exactly what "orientation is wrong" looked like.
let drone = null;
let visual = null;
let fireTimer = 0;
const dronePos = new THREE.Vector3();
const droneVel = new THREE.Vector3();
const bubbles = []; // { mesh, dir, life }

function buildDrone() {
  const root = new THREE.Group();
  visual = createVisual('belugaDrone');
  root.add(visual);
  return root;
}

export function createBelugaDrone() {
  drone = buildDrone();
  return drone;
}

// The drone is a singleton created once at boot, not repeatedly cloned like
// an enemy or a shrimp-ring instance — a size multiplier set afterward
// wouldn't show up until a full reload without this. Swaps the mesh in
// place (same parent, same position) so it's seamless from the T-menu.
export function rebuildBelugaDrone(scene) {
  if (!drone) return;
  const { position, visible } = drone;
  scene.remove(drone);
  drone = buildDrone();
  drone.position.copy(position);
  drone.visible = visible;
  scene.add(drone);
}

export function resetBeluga(scene, playerPos) {
  fireTimer = 0;
  dronePos.set(playerPos?.x ?? 0, playerPos?.y ?? 0, 0);
  droneVel.set(0, 0, 0);
  for (const b of bubbles) scene.remove(b.mesh);
  bubbles.length = 0;
}

function currentBubbleRadius(level) {
  return CONFIG.beluga.baseBubbleRadius + CONFIG.beluga.radiusPerLevel * (level - 1);
}

// hooks: { onTrap(enemy) } — for feedback only, no damage/kill involved.
export function updateBeluga(dt, scene, playerPos, level, enemiesList, clock, hooks) {
  if (!drone) return;

  const active = level > 0;
  drone.visible = active;

  if (active) {
    // The drone used to be pinned to an exact orbit position every frame,
    // which read as a rigid attachment rather than an animal swimming
    // alongside you. Now the orbit point is only a TARGET, and the drone
    // spring-follows it (same damped-spring approach as the eel companion)
    // — so it lags on turns, overshoots slightly, and
    // generally swims rather than being welded to a circle.
    // The tilted 3D ring and the spring-follow both live in systems/orbit.js
    // now, shared with Seal Team so the two companion abilities move alike and
    // read from the same offset controls.
    const to = orbitTarget(clock, playerPos, CONFIG.beluga);
    springFollow(dronePos, droneVel, to, dt, CONFIG.beluga.followSpring, CONFIG.beluga.followDamping);
    drone.position.copy(dronePos);

    // Heading on the OUTER object, mirror on the INNER one — see the note by
    // the declarations for why these can't share an object. Heading uses only
    // the screen-plane velocity, so swinging through depth doesn't tip the
    // model over.
    const spd = Math.hypot(droneVel.x, droneVel.y);
    if (spd > 0.3) {
      drone.rotation.z = Math.atan2(droneVel.y, droneVel.x) - Math.PI / 2;
      visual.rotation.y = droneVel.x < 0 ? Math.PI : 0;
    }

    fireTimer -= dt;
    if (fireTimer <= 0) {
      fireTimer = CONFIG.beluga.fireRate;
      let target = null;
      let bestD = Infinity;
      for (const e of enemiesList) {
        if (e.trapTimer > 0) continue; // already trapped, leave it be
        const d = e.mesh.position.distanceTo(drone.position);
        if (d < bestD) { bestD = d; target = e; }
      }
      if (target) {
        const dx = target.mesh.position.x - drone.position.x;
        const dy = target.mesh.position.y - drone.position.y;
        const len = Math.hypot(dx, dy) || 1;
        const mesh = createVisual('trapBubble');
        const radius = currentBubbleRadius(level);
        mesh.scale.setScalar(radius / 0.35); // asset's base radius is 0.35
        mesh.position.copy(drone.position);
        scene.add(mesh);
        bubbles.push({ mesh, dirX: dx / len, dirY: dy / len, radius, life: CONFIG.beluga.life });
      }
    }
  }

  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i];
    b.mesh.position.x += b.dirX * CONFIG.beluga.speed * dt;
    b.mesh.position.y += b.dirY * CONFIG.beluga.speed * dt;
    b.life -= dt;

    let hit = false;
    for (const e of enemiesList) {
      if (e.trapTimer > 0) continue;
      const dx = e.mesh.position.x - b.mesh.position.x;
      const dy = e.mesh.position.y - b.mesh.position.y;
      const reach = b.radius + e.radius;
      if (dx * dx + dy * dy > reach * reach) continue;
      e.trapTimer = CONFIG.beluga.trapDuration;
      hooks.onTrap?.(e);
      hit = true;
      break;
    }

    if (hit || b.life <= 0) {
      scene.remove(b.mesh);
      bubbles.splice(i, 1);
    }
  }
}
