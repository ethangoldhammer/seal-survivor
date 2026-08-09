import * as THREE from 'three';
import { CONFIG, difficultyRamp } from '../config.js';
import { createVisual, hasModel } from '../assets.js';
import { bounds } from '../arena.js';
import { pickups, spawnXpOrb } from '../entities/pickups.js';
import { recordSpawn } from './playtest.js';
import { primeBoatDebris, spawnBoatDebris, updateBoatDebris, resetBoatDebris, blastDebris } from './boatDebris.js';
import { spawnCrewFor, updateCrew, resetCrew, releaseCrew, blastCrew } from './crew.js';

// Boats sail along the water line. They don't chase or attack — they're
// targets floating above the fight, and shooting one showers the water with
// chum. A TRAWLER (bigger, tougher) also drops an attractor orb, which drags
// every chum bit that's settled on the sea floor up to the player. That makes
// a big seabed pile worth deliberately farming, and it plays against the
// crab-spawning system, which punishes exactly the same pile.

export const boats = [];
export const attractorOrbs = [];

let spawnTimer = 0;
let clock = 0;

function randomBetween(a, b) {
  return a + Math.random() * Math.max(0, b - a);
}

export function resetBoats(scene) {
  for (const b of boats) scene.remove(b.mesh);
  boats.length = 0;
  for (const o of attractorOrbs) scene.remove(o.mesh);
  attractorOrbs.length = 0;
  resetBoatDebris(scene);
  resetCrew(scene);
  spawnTimer = randomBetween(CONFIG.boats.spawnMin, CONFIG.boats.spawnMax);
  clock = 0;
}

// A hull is long and flat — roughly 6 world units of boat and barely one of
// freeboard — so a single circle can't describe it. A circle wide enough to
// cover the bow and stern swallows a huge patch of empty sky above the deck;
// one tight enough to hug the deck lets shots pass straight through both ends.
// Measuring the visual and testing against that box instead means the hitbox
// is whatever the boat actually looks like, including the trawler's extra
// scale and anything the tuner's Size slider does to it.
function hullExtents(mesh, assetKey, fallbackRadius) {
  // Only the real model is worth measuring. The procedural stand-in is a unit
  // cube (the `box` shape reads `size`, which the boat entries don't set), so
  // measuring THAT would quietly shrink the hitbox to a third of what it used
  // to be on exactly the path that only runs when something has already gone
  // wrong. Keep the authored radius there instead — same behaviour as before.
  const fallback = { halfLength: fallbackRadius, halfHeight: fallbackRadius, offsetX: 0, offsetY: 0 };
  if (!hasModel(assetKey)) return fallback;

  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  if (box.isEmpty()) return fallback;
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(centre);
  // The hull's centre is NOT the mesh's origin: prepareModel anchors these on
  // their centre of mass, which for the fishing boat sits about a third of the
  // way up from the keel. A box centred on mesh.position would therefore hang
  // half below the waterline and stop short of the mast. Store where the box
  // actually sits relative to the origin and offset the test by it.
  //
  // Measured before the heading flip below: a 180° spin about the vertical
  // leaves the extents alone and mirrors offsetX, which is handled at spawn.
  return {
    halfLength: Math.max(size.x, 1e-3) / 2,
    halfHeight: Math.max(size.y, 1e-3) / 2,
    offsetX: centre.x - mesh.position.x,
    offsetY: centre.y - mesh.position.y,
  };
}

// True when a circle of radius r at (x, y) touches the hull box.
// Defaulted rather than assumed: a missing extent would make every comparison
// below NaN, and NaN <= r is false — so a boat built without these fields would
// silently become invulnerable rather than failing in any visible way.
export function hitsBoat(boat, x, y, r) {
  const halfLength = boat.halfLength ?? CONFIG.boats.radius;
  const halfHeight = boat.halfHeight ?? CONFIG.boats.radius;
  const dx = Math.abs(x - (boat.mesh.position.x + (boat.offsetX ?? 0))) - halfLength;
  const dy = Math.abs(y - (boat.mesh.position.y + (boat.offsetY ?? 0))) - halfHeight;
  if (dx <= 0 && dy <= 0) return true; // inside the hull
  // Outside on at least one axis — nearest-point distance, so the corners
  // stay rounded instead of catching shots that visibly miss the boat.
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return ox * ox + oy * oy <= r * r;
}

function spawnBoat(scene, difficulty) {
  const isTrawler = Math.random() < CONFIG.boats.trawlerChance;
  const mesh = createVisual(isTrawler ? 'trawler' : 'boat');
  if (isTrawler) mesh.scale.multiplyScalar(CONFIG.boats.trawlerScale);
  // The scale the hull was actually built at — the trawler multiplier plus
  // whatever the tuner's Size slider contributed. The hit reaction scales
  // relative to this so a pop never snaps the boat to some other size.
  const spawnScale = mesh.scale.x || 1;

  // Enter from whichever side, sail across.
  const fromLeft = Math.random() < 0.5;
  const x = fromLeft ? bounds.left - 3 : bounds.right + 3;
  const dir = fromLeft ? 1 : -1;
  mesh.position.set(x, bounds.surfaceY, 0);
  const assetKey = isTrawler ? 'trawler' : 'boat';
  const { halfLength, halfHeight, offsetX, offsetY } = hullExtents(mesh, assetKey, CONFIG.boats.radius * spawnScale);
  // Face the way it's sailing. The hull is modelled along +X, so a boat
  // heading left is the same boat spun 180° about the vertical — which keeps
  // it in profile either way rather than showing its stern to the camera.
  mesh.rotation.y = dir > 0 ? 0 : Math.PI;
  scene.add(mesh);

  // Cut the wreck now rather than when it's needed — see primeBoatDebris.
  primeBoatDebris(mesh, assetKey);

  // Same two-layer run scaling the creatures get (see spawnOne): the linear
  // per-difficulty term, then the roster-wide compounding ramp, so a boat
  // late in a run doesn't melt to a build that a ten-minute shark survives.
  // Only hp — a boat's threat is the chum it denies, not contact damage
  // (which is 0), and speeding hulls up just makes them harder to farm.
  const hp = (CONFIG.boats.hp + CONFIG.boats.hpPerDifficulty * difficulty)
    * (isTrawler ? CONFIG.boats.trawlerHpMul : 1)
    * difficultyRamp('hp', difficulty);

  // A hull is hp the player has to chew through like any other, so it counts
  // toward the arriving-pressure curve the playtest report measures clear
  // rate against.
  recordSpawn(hp);

  boats.push({
    mesh,
    isTrawler,
    assetKey,
    hp,
    maxHp: hp,
    dir,
    speed: CONFIG.boats.speed + Math.random() * CONFIG.boats.speedVariance,
    // The hull box, and a circle that encloses it for the broad checks
    // (despawn margin) that don't need the exact shape.
    halfLength,
    halfHeight,
    // Mirrored along with the hull when it sails the other way.
    offsetX: dir > 0 ? offsetX : -offsetX,
    offsetY,
    radius: Math.hypot(halfLength, halfHeight) + Math.hypot(offsetX, offsetY),
    spawnScale,
    // Where the boat has sailed to, kept apart from mesh.position so the hit
    // recoil below can offset the rendered hull without the sailing motion
    // integrating the recoil back into its own course.
    sailX: x,
    phase: Math.random() * Math.PI * 2,
    flash: 0,
    // Hit reaction state — see updateBoats.
    knockX: 0,
    knockY: 0,
    rock: 0,
    rockVel: 0,
  });

  // Someone has to be sailing it. They ride the deck from here and get off it
  // themselves once the hull is in trouble — see systems/crew.js.
  spawnCrewFor(scene, boats[boats.length - 1]);
}

export function spawnAttractorOrb(scene, pos) {
  const mesh = createVisual('attractorOrb');
  mesh.scale.setScalar(CONFIG.attractorOrb.scale);
  if (mesh.material?.color) {
    mesh.material.color.set(CONFIG.attractorOrb.color).multiplyScalar(CONFIG.attractorOrb.glow);
  }
  mesh.position.copy(pos);
  scene.add(mesh);
  attractorOrbs.push({ mesh, life: CONFIG.attractorOrb.lifetime });
}

// hooks: { onBoatDestroyed(boat), onChumSpawned(n) }
export function updateBoats(dt, scene, difficulty, playerPos, hooks = {}) {
  clock += dt;

  if (CONFIG.boats.enabled) {
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawnTimer = randomBetween(CONFIG.boats.spawnMin, CONFIG.boats.spawnMax);
      if (boats.length < CONFIG.boats.maxAlive) spawnBoat(scene, difficulty);
    }
  }

  const react = CONFIG.boats.hitReaction;

  for (let i = boats.length - 1; i >= 0; i--) {
    const b = boats[i];
    b.sailX += b.dir * b.speed * dt;

    // Hit reaction. Boats have no skeleton and no clips, so the spring-driven
    // flinch the creatures get isn't available to them — this is the
    // equivalent, built from the only things a rigid hull has: it gets shoved
    // along the shot, rolls from the impact, and pops in scale. Recoil decays
    // exponentially back to zero, and the roll is a damped spring so the hull
    // rocks and settles rather than snapping back level.
    if (b.knockX !== 0 || b.knockY !== 0) {
      const decay = Math.exp(-react.knockDecay * dt);
      b.knockX *= decay;
      b.knockY *= decay;
      if (Math.abs(b.knockX) < 1e-4) b.knockX = 0;
      if (Math.abs(b.knockY) < 1e-4) b.knockY = 0;
    }
    if (b.rock !== 0 || b.rockVel !== 0) {
      b.rockVel += (-react.rockStiffness * b.rock - react.rockDamping * b.rockVel) * dt;
      b.rock += b.rockVel * dt;
      if (Math.abs(b.rock) < 1e-4 && Math.abs(b.rockVel) < 1e-4) { b.rock = 0; b.rockVel = 0; }
    }

    b.mesh.position.x = b.sailX + b.knockX;
    // Ride the surface with a gentle bob rather than sitting on a flat line.
    b.mesh.position.y = bounds.surfaceY
      + Math.sin(clock * CONFIG.boats.bobSpeed + b.phase) * CONFIG.boats.bobAmount
      + b.knockY;
    b.mesh.rotation.z = Math.sin(clock * CONFIG.boats.bobSpeed * 0.7 + b.phase) * 0.08 + b.rock;

    if (b.flash > 0) {
      b.flash = Math.max(0, b.flash - dt);
      const t = b.flash / Math.max(CONFIG.fx.hitFlash, 0.0001);
      // Relative to the scale the hull was built at, so the pop reads the same
      // on a rowboat and on a trawler and never resizes either one for good.
      b.mesh.scale.setScalar(b.spawnScale * (1 + CONFIG.fx.hitPop * t));
    }

    // Sailed off the far side — despawn quietly, no reward. Its crew goes with
    // it: they're still standing on a boat that just left the arena.
    const margin = b.radius + 5;
    if (b.sailX < bounds.left - margin || b.sailX > bounds.right + margin) {
      releaseCrew(scene, b, false);
      scene.remove(b.mesh);
      boats.splice(i, 1);
    }
  }

  // The wreckage of anything destroyed above, arcing and sinking on its own
  // clock long after the boat it came from left the list — and the people, who
  // outlive their boat by even longer.
  updateBoatDebris(dt, scene);
  updateCrew(dt, scene);

  // Attractor orbs: rise slowly and drag every settled chum bit toward the
  // player. This deliberately ignores the normal pickup magnet radius —
  // reaching the whole arena is the entire point.
  for (let i = attractorOrbs.length - 1; i >= 0; i--) {
    const o = attractorOrbs[i];
    o.life -= dt;
    o.mesh.position.y += CONFIG.attractorOrb.riseSpeed * dt;
    o.mesh.rotation.z += dt * 3;

    for (const p of pickups) {
      const dx = playerPos.x - p.mesh.position.x;
      const dy = playerPos.y - p.mesh.position.y;
      const d = Math.hypot(dx, dy) || 0.0001;
      p.mesh.position.x += (dx / d) * CONFIG.attractorOrb.pullStrength * dt;
      p.mesh.position.y += (dy / d) * CONFIG.attractorOrb.pullStrength * dt;
    }

    if (o.life <= 0) {
      scene.remove(o.mesh);
      attractorOrbs.splice(i, 1);
    }
  }
}

// Called from combat when a bullet hits a boat. `dir` is the shot's travel
// direction, so the recoil goes the way the bullet was going — without it the
// hull would pop in place with no sense of where the hit came from.
export function damageBoat(scene, index, amount, hooks = {}, dir = null, at = null) {
  const b = boats[index];
  if (!b) return false;
  b.hp -= amount;
  b.flash = CONFIG.fx.hitFlash;

  const react = CONFIG.boats.hitReaction;
  // Damage-scaled and capped, the same way the creatures' hit impulse is: a
  // chip of splash nudges the hull, a big hit visibly staggers it. Heavier
  // boats move less for the same hit.
  const punch = Math.min(react.max, amount * react.perDamage) / (b.isTrawler ? react.trawlerResist : 1);
  const len = dir ? (Math.hypot(dir.x, dir.y) || 1) : 1;
  const fx = dir ? (dir.x / len) * punch : 0;
  const fy = dir ? (dir.y / len) * punch : punch;
  b.knockX += fx;
  b.knockY += fy;

  // Roll is the torque of that impulse about the hull's centre — the 2D cross
  // product of the lever arm with the force. Deriving it from where the shot
  // actually landed is what makes shooting the bow rock the boat differently
  // from shooting the stern, and it works for a flat horizontal shot too,
  // which a formula reading only the shot's vertical component does not.
  // Divided by the hull's half-length so a long trawler doesn't spin further
  // than a rowboat purely for having a longer lever arm.
  if (at) {
    const rx = at.x - b.mesh.position.x;
    const ry = at.y - b.mesh.position.y;
    const torque = rx * fy - ry * fx;
    b.rockVel += (torque / Math.max(b.halfLength, 1e-3)) * react.rockPerHit;
  } else {
    b.rockVel += punch * react.rockPerHit;
  }

  if (b.hp > 0) return false;

  // Destroyed: dump the chum. Unlike the hull, which is thrown UP (see
  // spawnBoatDebris), the catch spills out of the boat and goes straight down
  // — it's the heavy half of the wreck, and the pile it leaves on the seabed
  // is the thing the player is actually here for.
  const base = randomBetween(CONFIG.boats.chumMin, CONFIG.boats.chumMax);
  const count = Math.round(base * (b.isTrawler ? CONFIG.boats.trawlerChumMul : 1));
  const toss = CONFIG.boats.chumToss ?? {};
  for (let i = 0; i < count; i++) {
    const offset = (Math.random() - 0.5) * CONFIG.boats.chumSpread * 2;
    const pos = new THREE.Vector3(
      b.mesh.position.x + offset,
      // Under the water line, always: the hull rides the surface on a bob, so
      // a drop measured straight off it can start fractionally in the air.
      Math.min(b.mesh.position.y, bounds.surfaceY - 0.15) - Math.random() * 1.5,
      0
    );
    // Scattered outward from the hull rather than appearing already spread:
    // the orbs burst out, the water stops them within a second or so, and
    // from there the ordinary sink carries them down (see updatePickups).
    const spread = Math.max(CONFIG.boats.chumSpread, 1e-3);
    const vel = {
      x: (offset / spread) * (toss.out ?? 4) + b.dir * b.speed * (toss.carry ?? 0.3),
      y: (toss.up ?? 1.6) * (Math.random() - 0.35),
    };
    // Mid-tier chum: worth more than a minnow drop, less than a shark's.
    spawnXpOrb(scene, pos, CONFIG.boats.chumXp, 0.8, vel);
  }

  if (b.isTrawler) spawnAttractorOrb(scene, b.mesh.position.clone());

  hooks.onBoatDestroyed?.(b, count);

  // THE BLAST. Order matters here: the wreckage and the crew have to exist
  // before the explosion looks for something to throw. The crew is released
  // first so anyone still standing on the deck is already a ragdoll by the
  // time the impulse arrives.
  releaseCrew(scene, b, true);
  spawnBoatDebris(scene, b);
  const blast = CONFIG.boats.blast ?? {};
  const radius = (blast.radius ?? 9) * (b.isTrawler ? (blast.trawlerMul ?? 1.4) : 1);
  const strength = (blast.strength ?? 11) * (b.isTrawler ? (blast.trawlerMul ?? 1.4) : 1);
  blastDebris(b.mesh.position.x, b.mesh.position.y, radius, strength);
  blastCrew(b.mesh.position.x, b.mesh.position.y, radius, strength);

  scene.remove(b.mesh);
  boats.splice(index, 1);
  return true;
}
