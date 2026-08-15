import * as THREE from 'three';
import { CONFIG, difficultyRamp } from '../config.js';
import { createVisual, hasModel } from '../assets.js';
import { bounds } from '../arena.js';
import { pickups, spawnXpOrb } from '../entities/pickups.js';
import { recordSpawn } from './playtest.js';
import { primeBoatDebris, spawnBoatDebris, updateBoatDebris, resetBoatDebris, blastDebris } from './boatDebris.js';
import { spawnCrewFor, updateCrew, resetCrew, releaseCrew, blastCrew, clearDeckCache } from './crew.js';
import { snapSide } from './facing.js';
import { RigidBody, addBody, removeBody, blastBodies } from './rigidBody.js';
import { updateHullWake } from './boatWake.js';

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
  for (const b of boats) {
    if (b.body) removeBody(b.body);
    scene.remove(b.mesh);
  }
  boats.length = 0;
  for (const o of attractorOrbs) scene.remove(o.mesh);
  attractorOrbs.length = 0;
  resetBoatDebris(scene);
  resetCrew(scene);
  // The measured deck is a fact about the MODEL, so it survives a run — but
  // not a model swapped underneath it from the T panel.
  clearDeckCache();
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
  // SNAPPED, not turned — a boat sails in from off-screen already pointed the
  // way it is going, and watching it rotate into its heading as it arrives
  // would be a boat that spawned backwards. Routed through systems/facing.js
  // anyway so the heading is owned in one place: an ordinary boat holds `dir`
  // for its whole life and never comes about, but if one ever does, it turns
  // the way the boat boss does rather than flipping.
  snapSide(mesh, dir);
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

  const boat = {
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
    phase: Math.random() * Math.PI * 2,
    flash: 0,
    // The hull is a simulated body now — see systems/rigidBody.js. Its
    // position, its roll and its recoil all live in there, which is what lets
    // a turtle punted into it move it for real instead of playing a flinch at
    // it. What stays here is everything a hull is that a body is not: hp, a
    // catch, a crew, a heading it is trying to hold.
    body: null,
  };
  boats.push(boat);

  const p = CONFIG.physics?.boat ?? {};
  boat.body = addBody(new RigidBody({
    kind: 'boat',
    shape: 'box',
    owner: boat,
    object: mesh,
    halfLength,
    halfHeight,
    offsetX: boat.offsetX,
    offsetY,
    // The trawler is heavier as well as tougher, so the same turtle that
    // launches a rowboat only leans on it.
    mass: (p.mass ?? 14) * (isTrawler ? (p.trawlerMass ?? 2.4) : 1),
    // No linear drag: horizontal motion is `thrust` chasing the sailing speed
    // and vertical is the buoyancy spring, both applied every frame in
    // updateBoats. A drag term on top would only fight them.
    drag: p.drag ?? 0,
    angularDrag: p.angularDrag ?? 2.2,
    righting: p.righting ?? 42,
    rightingDamping: p.rightingDamping ?? 5,
    spin: p.spin ?? 2.6,
    restitution: p.restitution ?? null,
    // NO CAPSIZE WHILE IT FLOATS: going over is what SINKING looks like, and a
    // hull that is still alive has not earned it. See damageBoat.
    maxAngle: CONFIG.boats.hitReaction.maxRoll ?? 0.55,
    // Sails straight through the arena walls — leaving is how a boat despawns.
    walls: false,
  }));
  boat.body.place(x, bounds.surfaceY);
  boat.body.vx = dir * boat.speed;

  // Someone has to be sailing it. They ride the deck from here and get off it
  // themselves once the hull is in trouble — see systems/crew.js.
  spawnCrewFor(scene, boat);
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

  const phys = CONFIG.physics?.boat ?? {};

  for (let i = boats.length - 1; i >= 0; i--) {
    const b = boats[i];

    // THRUST. A hull under way is not on a rail any more: it holds its sailing
    // speed by accelerating toward it, so anything that shoves it costs it
    // real ground — a punted boat coasts backwards, slows, and gets back under
    // way — while a hull nothing has touched still crosses the arena at
    // exactly the speed it always did.
    b.body.addAcceleration((b.dir * b.speed - b.body.vx) * (phys.thrust ?? 0.9), 0);

    // BUOYANCY. The bob is the rest height, and the hull is sprung to it
    // rather than pinned at it, so a boat driven down into the water surges
    // back up through the line and rocks it off. Damped, or it never stops.
    const rest = bounds.surfaceY
      + Math.sin(clock * CONFIG.boats.bobSpeed + b.phase) * CONFIG.boats.bobAmount;
    b.body.addAcceleration(0, (rest - b.body.y) * (phys.buoyancy ?? 30)
      - b.body.vy * (phys.buoyancyDamping ?? 4.2));

    // The gentle roll of a boat on the water. This is the body's REST angle;
    // whatever the physics has done to it is laid on top by the step itself
    // (see RigidBody.writeBack), which is why nothing here touches rotation.
    b.body.restAngle = Math.sin(clock * CONFIG.boats.bobSpeed * 0.7 + b.phase) * 0.08;

    if (b.flash > 0) {
      b.flash = Math.max(0, b.flash - dt);
      const t = b.flash / Math.max(CONFIG.fx.hitFlash, 0.0001);
      // Relative to the scale the hull was built at, so the pop reads the same
      // on a rowboat and on a trawler and never resizes either one for good.
      b.mesh.scale.setScalar(b.spawnScale * (1 + CONFIG.fx.hitPop * t));
    }

    // THE WATER IT IS PUSHING. Off the body rather than off the course it was
    // given, so a hull that has been punted, blasted or shoved by a turtle
    // sheds a wake for what it is ACTUALLY doing — a boat knocked backwards
    // churns as it coasts, and one held still against its thrust barely does.
    // `dir` stays the heading it is drawn at (the hull is spun to face it at
    // spawn and never turns again), which is what keeps the stern the stern
    // through a shove that has reversed its velocity.
    updateHullWake(dt, b, {
      // THE BOX CENTRE, not the mesh origin. prepareModel anchors a hull on its
      // centre of mass — about a third of the way up from the keel and not the
      // middle of the boat lengthwise either — so `offsetX` is the difference,
      // and measuring the transom off the origin instead puts the wake inside
      // the stern. Already mirrored for a boat sailing the other way (see the
      // spawn), which is why it is added rather than signed here.
      x: b.body.x + (b.offsetX ?? 0),
      halfLength: b.halfLength,
      // The bottom of the hull, so the wake knows what "under the boat" means.
      keelY: b.body.y + (b.offsetY ?? 0) - (b.halfHeight ?? 0),
      dir: b.dir,
      speed: Math.abs(b.body.vx),
      vx: b.body.vx,
    });

    // Sailed off the far side — despawn quietly, no reward. Its crew goes with
    // it: they're still standing on a boat that just left the arena. Measured
    // off the body rather than off a course it was following, so a hull that
    // was punted out of the arena counts as gone the same way one that sailed
    // out does.
    const margin = b.radius + 5;
    if (b.body.x < bounds.left - margin || b.body.x > bounds.right + margin) {
      releaseCrew(scene, b, false);
      removeBody(b.body);
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

/**
 * THE SEAL HITS THE HULL. A shove, not a shot — so it deliberately does not go
 * through damageBoat's damage-scaled recoil: a ram deals almost nothing at base
 * (see CONFIG.strike.contactDamage) and would produce a nudge, while what it
 * should produce is the boat visibly jumping.
 *
 * Damage, if any, is the caller's business; this is purely the reaction, so a
 * strike can jostle a hull it cannot yet hurt. The roll comes from where the
 * seal actually hit — bow, stern or amidships — through the same torque
 * formula bullets use, which is what makes hitting an end spin it and hitting
 * the middle bounce it.
 *
 * @param boat   the hull
 * @param dirX,dirY  the dash's heading
 * @param power  banked charge of the strike, 0..1
 * @param at     where the contact happened, for the lever arm
 */
export function jostleBoat(boat, dirX, dirY, power = 1, at = null) {
  if (!boat?.body) return;
  const len = Math.hypot(dirX, dirY) || 1;
  // Scaled by charge the same way everything else the strike does is. The
  // trawler's extra weight is in its MASS now rather than in a resist factor,
  // so one number does that job for every impulse a hull can take — a ram, a
  // shot, a blast, a turtle — instead of each source remembering to divide.
  const punch = (CONFIG.physics?.boat?.strikeImpulse ?? 130)
    * Math.min(1, Math.max(0, power));
  boat.body.applyImpulse(
    (dirX / len) * punch,
    (dirY / len) * punch,
    at ? at.x : null,
    at ? at.y : null,
  );
  boat.flash = CONFIG.fx.hitFlash;
}

/**
 * SOMETHING HIT THE HULL — a real body, at a real speed, resolved by the
 * physics step rather than aimed by anything. The impulse is already spent by
 * the time this runs (the solver bounced both of them); what this adds is the
 * damage, priced off the impact speed the solver measured.
 *
 * A hull is dangerous to hit and cheap to be hit BY, so this deliberately
 * runs only for a boat: a turtle that lands on a rowboat wrecks it, and the
 * rowboat does nothing back to the turtle, which cannot be hurt anyway.
 *
 * @param body   the hull's body (whichever side of the collision it was)
 * @param hit    the solver's report: { speed, impulse, x, y }
 * @returns the damage dealt, or 0 for a bump
 */
export function impactBoat(scene, body, hit, hooks = {}) {
  const boat = body?.owner;
  const index = boats.indexOf(boat);
  if (index < 0) return 0;

  const imp = CONFIG.physics?.impact ?? {};
  boat.flash = CONFIG.fx.hitFlash;
  // WHETHER it hurts is a speed question — a turtle drifting into a hull is a
  // bump however heavy it is. HOW MUCH is an impulse question, because that is
  // the one that knows the difference between the runt and the boulder: with
  // scaleVariance on the turtle those differ by an order of magnitude in mass,
  // and a damage priced on speed alone would charge them the same.
  if (hit.speed <= (imp.minSpeed ?? 6)) return 0;

  const at = { x: hit.x, y: hit.y };
  const damage = Math.min(imp.maxDamage ?? 120, hit.impulse * (imp.damagePerImpulse ?? 0.5));
  // `recoil: false` — the shove has already been applied by the solver, and
  // letting damageBoat add its own on top would count one collision twice:
  // the hull would leap away from a hit it has already reacted to.
  damageBoat(scene, index, damage, hooks, null, at, false);
  return damage;
}

// Called from combat when a bullet hits a boat. `dir` is the shot's travel
// direction, so the recoil goes the way the bullet was going — without it the
// hull would pop in place with no sense of where the hit came from.
// `recoil` is how a caller says "the shove has already happened" — see
// impactBoat, where the physics solver has bounced the hull before the damage
// is even worked out.
export function damageBoat(scene, index, amount, hooks = {}, dir = null, at = null, recoil = true) {
  const b = boats[index];
  if (!b) return false;
  b.hp -= amount;
  b.flash = CONFIG.fx.hitFlash;

  // Damage-scaled and capped, the same way the creatures' hit impulse is: a
  // chip of splash nudges the hull, a big hit visibly staggers it. The hull's
  // own mass is what makes a trawler move less for the same hit, and the lever
  // arm from `at` is what makes a shot to the bow roll it differently from one
  // to the stern — both now the body's job (see RigidBody.applyImpulse), which
  // is the same arithmetic this used to do by hand.
  const phys = CONFIG.physics?.boat ?? {};
  if (recoil) {
    const punch = Math.min(phys.maxDamageImpulse ?? 26, amount * (phys.damageImpulse ?? 1.1));
    const len = dir ? (Math.hypot(dir.x, dir.y) || 1) : 1;
    b.body?.applyImpulse(
      dir ? (dir.x / len) * punch : 0,
      dir ? (dir.y / len) * punch : punch,
      at ? at.x : null,
      at ? at.y : null,
    );
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
  blastCrew(scene, b.mesh.position.x, b.mesh.position.y, radius, strength);
  // AND EVERYTHING ELSE THAT FLOATS. The same impulse the wreckage and the
  // crew take, handed to the physics world: the turtle that was drifting past
  // is thrown clear, and any hull inside the radius is rocked and shoved —
  // which is a chain, because that hull can now reach a third one.
  //
  // Excluding this boat's own body is not optional: it is still registered
  // for the two lines it takes to remove it, and a body blasted from a point
  // exactly at its own centre gets a zero-length direction.
  blastBodies(b.mesh.position.x, b.mesh.position.y, radius, strength, b.body);

  if (b.body) removeBody(b.body);
  scene.remove(b.mesh);
  boats.splice(index, 1);
  return true;
}
