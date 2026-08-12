import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createVisual } from '../assets.js';
import { orbitTarget, springFollow } from './orbit.js';
import { aoe, applyCompanionScale } from './scaling.js';

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
const bubbles = []; // { mesh, dir, life, popLeft, baseScale }

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

// Splash Zone widens the bubble. The bubble is a catch radius that happens to
// be drawn, so this is the rare case where "how big is the effect" and "how
// big is the picture" are literally the same number — see the scale note in
// the spawn below, which keeps them that way.
function currentBubbleRadius(level) {
  return aoe(CONFIG.beluga.baseBubbleRadius + CONFIG.beluga.radiusPerLevel * (level - 1));
}

// A bubble that has caught something doesn't disappear on the frame it
// touched — it holds on the creature, strobes, swells and then bursts. The
// catch is the one event in this ability, and it used to be told entirely by
// the absence of the thing that told it.
//
// The strobe is `mesh.visible`, NOT material opacity. Every trap bubble in
// flight is a clone sharing one material (see createVisual — primitives don't
// clone theirs), so fading one would fade all of them, including the ones
// still travelling. `visible` is per-object and free.
function updatePop(b, dt, scene, hooks) {
  const cfg = CONFIG.beluga;
  b.popLeft -= dt;

  if (b.popLeft <= 0) {
    scene.remove(b.mesh);
    // Reported at the bubble's position rather than the creature's: by now
    // they are the same point, and this way the burst can't chase a body that
    // was killed or hauled away during the hold.
    hooks.onPop?.(b.mesh.position.x, b.mesh.position.y);
    return true; // done — caller drops it
  }

  const hold = Math.max(0.0001, cfg.popFlicker);
  const t = 1 - b.popLeft / hold; // 0 at the catch, 1 at the burst
  const swell = 1 + (cfg.popSwell - 1) * t * t; // slow, then a rush at the end
  b.mesh.scale.copy(b.baseScale).multiplyScalar(swell);
  // Floor of the elapsed time in half-cycles: on, off, on, off. Driven off
  // elapsed time rather than a per-frame toggle so the rate is the authored
  // one at any framerate.
  b.mesh.visible = Math.floor(t * hold * cfg.popFlickerHz * 2) % 2 === 0;
  return false;
}

// hooks: { onTrap(enemy), onPop(x, y) } — for feedback only, no damage/kill
// involved. onTrap is the moment of the catch, onPop the bubble bursting a
// beat later; see CONFIG.beluga.popFlicker.
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
    applyCompanionScale(visual);

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
        // multiplyScalar, NOT setScalar. createVisual has just written the
        // asset's per-model Size multiplier (the T-panel slider) into this
        // scale; setScalar threw it away, so dragging the bubble's Size did
        // nothing at all and the only way to make one bigger was to edit
        // baseBubbleRadius. Multiplying keeps the slider live and still lands
        // the gameplay radius on `radius` at a multiplier of 1.
        mesh.scale.multiplyScalar(radius / 0.35); // asset's authored radius is 0.35
        mesh.position.copy(drone.position);
        scene.add(mesh);
        bubbles.push({
          mesh, dirX: dx / len, dirY: dy / len, radius, life: CONFIG.beluga.life,
          // Null until it catches something. The authored scale is kept as it
          // was at spawn because the swell multiplies it — reading it back off
          // the mesh mid-flicker would compound frame on frame.
          popLeft: null,
          baseScale: mesh.scale.clone(),
        });
      }
    }
  }

  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i];

    // A bubble that has already caught something is inert: it stops travelling
    // and stops catching. Without the second half, a bubble sitting on a fish
    // for its whole flicker keeps sweeping the crowd and can seal a second one
    // it never touched.
    if (b.popLeft !== null) {
      if (updatePop(b, dt, scene, hooks)) bubbles.splice(i, 1);
      continue;
    }

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
      // Snapped onto the creature so the flicker — and the burst at the end of
      // it — happen ON the fish that was caught, not at the point of contact,
      // which for anything bigger than the bubble is off to one side of it.
      b.mesh.position.copy(e.mesh.position);
      b.mesh.position.z = 0;
      b.popLeft = Math.max(0, CONFIG.beluga.popFlicker ?? 0);
      hit = true;
      break;
    }

    // A catch starts the flicker; running out of air just ends it. Only the
    // second one is removed here — see the pop branch at the top of the loop.
    if (hit) {
      // A hold of zero is the old instant vanish, and it still has to burst
      // rather than being deleted in silence.
      if (updatePop(b, 0, scene, hooks)) bubbles.splice(i, 1);
    } else if (b.life <= 0) {
      scene.remove(b.mesh);
      bubbles.splice(i, 1);
    }
  }
}
