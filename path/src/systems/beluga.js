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
// In flight, from the drone to whatever it was aimed at.
const bubbles = []; // { mesh, dirX, dirY, radius, life }
// Landed: one per creature currently held, wrapped around it for as long as
// the trap lasts. This is the ability — a fish in a bubble, visibly — and the
// projectile above is only how it gets there.
const shells = []; // { mesh, enemy, age, fit, from, phase, flickerPhase }

// The sphere the trapBubble asset is authored at (assets.js). Every scale here
// is expressed against it, so what it CATCHES and what is DRAWN are one
// number — see the catch radius in the fire block.
const ART_RADIUS = 0.35;
// Reused rather than allocated per shell per frame.
const liveEnemies = new Set();

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
  for (const s of shells) scene.remove(s.mesh);
  shells.length = 0;
}

// Splash Zone widens the bubble. The bubble is a catch radius that happens to
// be drawn, so this is the rare case where "how big is the effect" and "how
// big is the picture" are literally the same number — see the catch radius in
// the spawn below, which is measured off the mesh to keep them that way.
function currentBubbleRadius(level) {
  return aoe(CONFIG.beluga.baseBubbleRadius + CONFIG.beluga.radiusPerLevel * (level - 1));
}

// How long a catch holds, at this stack. Every other companion buys something
// per level and this one only widened, so a second bubble at level 8 was worth
// no more than the first — see beluga.durationPerLevel in weapons.csv.
export function trapSeconds(level) {
  return CONFIG.beluga.trapDuration + (CONFIG.beluga.durationPerLevel ?? 0) * Math.max(0, level - 1);
}

// The world radius a shell wants, to sit around this creature with a little
// air. e.radius is the creature's own scale-corrected radius (def.radius times
// its spawn scale), which is what "how big is this thing" means everywhere
// else in the game.
function fitRadius(enemy) {
  return Math.max(0.15, enemy.radius * (CONFIG.beluga.fitPad ?? 1.5));
}

// A bubble that has caught something doesn't disappear on the frame it touched
// — it closes around the creature and stays there for the whole hold, which is
// the only thing on screen that says that fish is out of the fight. It then
// warns before it lets go, and bursts.
//
// The strobe is `mesh.visible`, NOT material opacity. Every trap bubble shares
// one material (see createVisual — primitives don't clone theirs), so fading
// one would fade all of them, including the ones still travelling. `visible`
// is per-object and free.
//
// Returns true when the shell is spent and the caller should drop it.
function updateShell(s, dt, scene, hooks) {
  const cfg = CONFIG.beluga;
  s.age += dt;

  // Gone, or let go. Both end the same way — the bubble bursts where it was.
  // The membership test is what makes holding an enemy reference safe: a dead
  // creature's mesh goes back to the visual pool and is handed to the next
  // spawn, so a shell still following one would ride a completely different
  // animal.
  const held = liveEnemies.has(s.enemy) && s.enemy.trapTimer > 0;
  if (!held) {
    scene.remove(s.mesh);
    hooks.onPop?.(s.mesh.position.x, s.mesh.position.y);
    return true;
  }

  s.mesh.position.copy(s.enemy.mesh.position);

  // Closing. The shell arrives at the size the projectile was and contracts (or
  // opens out, on something bigger than itself) onto the creature, bulging
  // once on the way — a bubble sealing rather than a sphere being resized.
  const sealTime = Math.max(0.0001, cfg.sealTime ?? 0.18);
  const k = Math.min(1, s.age / sealTime);
  const ease = 1 - (1 - k) * (1 - k) * (1 - k);
  const radius = s.from + (s.fit - s.from) * ease;
  const bulge = 1 + ((cfg.sealSwell ?? 1.35) - 1) * Math.sin(Math.PI * k);
  // ...and once settled, breathes. A held bubble that is perfectly still stops
  // being a bubble within about a second of looking at it.
  const breath = 1 + (cfg.wobble ?? 0.05) * Math.sin(s.age * (cfg.wobbleHz ?? 1.6) * Math.PI * 2 + s.phase);
  // setScalar, which DISCARDS the asset's Size multiplier — deliberately, and
  // this is the one place in the file where that is right. Size is an art
  // scale and it still owns the shot (see the spawn); a shell is a FIT to the
  // creature it is wrapped around, so a 5x slider here would put a bubble five
  // times the width of the fish it is supposed to be holding. `fitPad` is the
  // knob for this one.
  s.mesh.scale.setScalar((radius * bulge * breath) / ART_RADIUS);

  // THE WARNING. The last stretch before the hold expires, strobing faster as
  // it goes, so "this one is about to come back at you" is readable across the
  // arena rather than being a surprise. Phase-accumulated instead of derived
  // from the timer, or ramping the rate would step the strobe backwards.
  const warn = cfg.warnFlicker ?? 0;
  if (warn > 0 && s.enemy.trapTimer < warn) {
    const urgency = 0.6 + 1.0 * (1 - s.enemy.trapTimer / warn);
    s.flickerPhase += (cfg.flickerHz ?? 24) * urgency * dt;
    s.mesh.visible = Math.floor(s.flickerPhase * 2) % 2 === 0;
  } else {
    s.mesh.visible = true;
  }
  return false;
}

// hooks: { onTrap(enemy), onPop(x, y) } — for feedback only, no damage/kill
// involved. onTrap is the catch, onPop the shell bursting when the hold ends
// (or when whatever it was wrapped around dies inside it).
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
        mesh.scale.multiplyScalar(radius / ART_RADIUS);
        mesh.position.copy(drone.position);
        scene.add(mesh);
        // WHAT IT CATCHES IS WHAT IS DRAWN — measured off the mesh, after every
        // multiplier, rather than being `radius`. Those two used to be the same
        // number and the Size slider quietly separated them: at a 5x Size the
        // bubble on screen was five times the width of the thing that actually
        // caught fish, so most of the ball was decoration and shots that
        // visibly enveloped a fish went through it. Reading the drawn size back
        // means the slider scales the picture and the effect together, which is
        // what the comment above always claimed.
        bubbles.push({
          mesh, dirX: dx / len, dirY: dy / len,
          radius: ART_RADIUS * mesh.scale.x,
          life: CONFIG.beluga.life,
        });
      }
    }
  }

  const hold = trapSeconds(level);
  // How many creatures one bubble may seal. A bubble drawn wide enough to
  // cover three fish and sealing only the first of them reads as a miss on the
  // other two — see beluga.maxCatch in weapons.csv.
  const maxCatch = Math.max(1, Math.round(CONFIG.beluga.maxCatch ?? 1));

  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i];

    b.mesh.position.x += b.dirX * CONFIG.beluga.speed * dt;
    b.mesh.position.y += b.dirY * CONFIG.beluga.speed * dt;
    b.life -= dt;

    let caught = 0;
    for (const e of enemiesList) {
      if (caught >= maxCatch) break;
      if (e.trapTimer > 0) continue;
      const dx = e.mesh.position.x - b.mesh.position.x;
      const dy = e.mesh.position.y - b.mesh.position.y;
      const reach = b.radius + e.radius;
      if (dx * dx + dy * dy > reach * reach) continue;
      e.trapTimer = hold;
      hooks.onTrap?.(e);
      // One shell per creature rather than one per bubble: two fish sealed by
      // the same shot are two fish in two bubbles, which is the only version
      // that still reads once they drift apart.
      addShell(scene, e, b, caught === 0);
      caught += 1;
    }

    // The projectile is spent either way — its mesh has become the first shell
    // on a hit (nothing to remove), and on a timeout it just runs out of air.
    if (caught > 0) {
      bubbles.splice(i, 1);
    } else if (b.life <= 0) {
      scene.remove(b.mesh);
      bubbles.splice(i, 1);
    }
  }

  // Rebuilt each frame rather than maintained: enemies are spliced out of the
  // list by index from a dozen places (kills, hauls, despawns), and none of
  // them can be expected to tell this system about it. Only paid for while
  // something is actually held.
  if (shells.length) {
    liveEnemies.clear();
    for (const e of enemiesList) liveEnemies.add(e);
    for (let i = shells.length - 1; i >= 0; i--) {
      if (updateShell(shells[i], dt, scene, hooks)) shells.splice(i, 1);
    }
  }
}

// `reuse` hands the projectile's own mesh to the first creature it caught, so
// the bubble that arrived is the bubble that closes — no pop-out and back in
// on the frame of the catch. Anything else caught by the same shot gets a
// fresh one.
function addShell(scene, enemy, bubble, reuse) {
  const mesh = reuse ? bubble.mesh : createVisual('trapBubble');
  if (!reuse) scene.add(mesh);
  mesh.position.copy(enemy.mesh.position);
  shells.push({
    mesh,
    enemy,
    age: 0,
    from: bubble.radius,      // the size it arrived at
    fit: fitRadius(enemy),    // ...and the size it closes to
    // Per-shell so a crowd of held fish doesn't breathe in lockstep, which
    // reads as one object rather than several.
    phase: Math.random() * Math.PI * 2,
    flickerPhase: 0,
  });
}
