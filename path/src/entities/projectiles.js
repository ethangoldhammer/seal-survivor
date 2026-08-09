import * as THREE from 'three';
import { createVisual } from '../assets.js';
import { bounds } from '../arena.js';
import { createAnimationController } from '../systems/animation.js';
import { updateTumble } from '../systems/rocks.js';

// One list for both sides — `faction` decides who a bullet can hurt. Two
// optional behaviors layer on top of the base fly-in-a-straight-line bullet:
//   homing — re-aims toward the nearest live enemy, turn-rate limited
//   bounce — reflects off the arena walls instead of flying past them,
//            consuming one of a limited number of bounces each time
//   chain  — survives hitting an enemy and ricochets on to the next one,
//            spending a bounce per body (see chainToEnemy)
export const projectiles = [];

export function spawnProjectile(scene, {
  origin, dir, faction, damage, speed, life, radius, pierce = 0, asset, source = null,
  homing = false, turnRate = 4, acquireRadius = Infinity, targetType = null, homingDelay = 0,
  bounce = false, maxBounces = 0, restitution = 1,
  chain = false, chainRange = 0, chainLock = 0, chainSpeedGain = 1,
  spin = 0, scale = 1, splashDamage = 0, splashRadius = 0, orient = false,
}) {
  const mesh = createVisual(asset ?? (faction === 'player' ? 'bullet' : 'enemyBullet'));
  mesh.position.copy(origin);
  if (scale !== 1) mesh.scale.setScalar(scale);
  scene.add(mesh);

  // A projectile whose model has real animation (currently: the seagull
  // bomb's flapping wings) gets the same idle/swim/boost controller every
  // creature uses, just always driven in the 'swim' state — there's no
  // speed-tiering concept for a bullet in flight, but the controller still
  // needs a state name to know what to play.
  const hasAnimSource = mesh.userData?.clips?.length || mesh.userData?.rig;
  const anim = hasAnimSource ? createAnimationController(mesh) : null;

  projectiles.push({
    mesh,
    anim,
    dir: dir.clone().normalize(),
    faction,
    // Who fired this, for the playtest recorder — an ability key ('missile',
    // 'starfish') on player shots, the creature's type on enemy ones. Carried
    // on the projectile because the hit lands in combat.js, which by then has
    // no idea what launched it. Null on anything that didn't say.
    source,
    damage,
    speed,
    life,
    radius,
    pierce,
    hits: new Set(), // enemies already pierced, so each takes damage once
    homing,
    // Seconds of straight flight before the seeker engages. Lets a launch be
    // its own beat — the shell visibly leaves the flipper on the heading it
    // was thrown at, THEN turns — instead of curving onto the target from the
    // first frame and hiding the throw.
    homingDelay,
    turnRate,
    acquireRadius,
    targetType, // e.g. 'walkingCrab' — restricts homing to only that enemy type
    target: null,
    bounce,
    bouncesLeft: maxBounces,
    restitution,
    chain,
    chainRange,
    chainLock,
    chainSpeedGain,
    hitLock: 0, // brief post-ricochet immunity so one chain isn't spent in a frame
    bounceCombo: 0, // consecutive ricochets, drives the rising pitch and spray

    spin, // radians/sec, purely visual
    orient, // face the direction of travel each frame
    splashDamage, // AoE dealt to OTHER nearby enemies on the first hit (see main.js)
    splashRadius,
  });
}

function updateHoming(p, dt, enemiesList) {
  if (!p.target || p.target.hp <= 0) {
    let best = null;
    let bestD = p.acquireRadius;
    for (const e of enemiesList) {
      if (p.targetType && e.type !== p.targetType) continue;
      const dx = e.mesh.position.x - p.mesh.position.x;
      const dy = e.mesh.position.y - p.mesh.position.y;
      const d = Math.hypot(dx, dy);
      if (d < bestD) { bestD = d; best = e; }
    }
    p.target = best;
  }
  if (!p.target) return;

  const dx = p.target.mesh.position.x - p.mesh.position.x;
  const dy = p.target.mesh.position.y - p.mesh.position.y;
  const desired = Math.atan2(dy, dx);
  const current = Math.atan2(p.dir.y, p.dir.x);
  let diff = desired - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const maxTurn = p.turnRate * dt;
  const step = Math.max(-maxTurn, Math.min(maxTurn, diff));
  const angle = current + step;
  p.dir.set(Math.cos(angle), Math.sin(angle));
}

// Returns true if the projectile hit a wall and had no bounces left (caller
// should despawn it) — otherwise reflects it in place and consumes a bounce.
function updateBounce(p, onBounce) {
  const pos = p.mesh.position;
  const r = p.radius;
  let hit = false;

  if (pos.x < bounds.left + r) { pos.x = bounds.left + r; if (p.dir.x < 0) { p.dir.x = -p.dir.x; hit = true; } }
  else if (pos.x > bounds.right - r) { pos.x = bounds.right - r; if (p.dir.x > 0) { p.dir.x = -p.dir.x; hit = true; } }

  if (pos.y < bounds.bottom + r) { pos.y = bounds.bottom + r; if (p.dir.y < 0) { p.dir.y = -p.dir.y; hit = true; } }
  else if (pos.y > bounds.top - r) { pos.y = bounds.top - r; if (p.dir.y > 0) { p.dir.y = -p.dir.y; hit = true; } }

  if (!hit) return false;
  if (p.bouncesLeft <= 0) return true; // out of bounces — caller despawns

  p.bouncesLeft -= 1;
  p.bounceCombo += 1;
  p.speed *= p.restitution;
  // Coming off a wall is a fresh run at the crowd — a chaining shot gets to
  // hit the same bodies again on the way back in.
  if (p.chain) p.hits.clear();
  onBounce?.(pos.x, pos.y, p);
  return false;
}

// Redirects a chaining shot at its next victim. Prefers the nearest live enemy
// inside chainRange that this shot hasn't already hit; if everything in range
// is already on its list, the list is wiped so a pair of enemies can volley the
// shot back and forth rather than the combo dead-ending at two. Returns false
// when there's nobody nearby at all, leaving the caller to deflect or despawn.
export function chainToEnemy(p, enemiesList, exclude = null) {
  const pos = p.mesh.position;
  const rangeSq = p.chainRange * p.chainRange;
  let fresh = null;
  let freshD = Infinity;
  let repeat = null;
  let repeatD = Infinity;

  for (const e of enemiesList) {
    if (e === exclude || e.hp <= 0) continue;
    const dx = e.mesh.position.x - pos.x;
    const dy = e.mesh.position.y - pos.y;
    const d = dx * dx + dy * dy;
    if (d > rangeSq) continue;
    if (p.hits.has(e)) {
      if (d < repeatD) { repeatD = d; repeat = e; }
    } else if (d < freshD) {
      freshD = d; fresh = e;
    }
  }

  const target = fresh ?? repeat;
  if (!target) return false;
  if (!fresh) p.hits.clear(); // everyone nearby has been hit — open them back up

  const dx = target.mesh.position.x - pos.x;
  const dy = target.mesh.position.y - pos.y;
  const len = Math.hypot(dx, dy) || 1;
  p.dir.set(dx / len, dy / len);
  return true;
}

// No chain target in range: kick the shot back the way it came with a bit of
// scatter, so it keeps living off the walls instead of stopping dead in the
// middle of the arena.
export function deflectProjectile(p) {
  const angle = Math.atan2(p.dir.y, p.dir.x) + Math.PI + (Math.random() - 0.5) * 1.2;
  p.dir.set(Math.cos(angle), Math.sin(angle));
}

export function updateProjectiles(dt, scene, enemiesList = [], onBounce = null) {
  const m = 3;
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];

    if (p.homingDelay > 0) p.homingDelay -= dt;
    if (p.homing && p.homingDelay <= 0) updateHoming(p, dt, enemiesList);

    p.mesh.position.x += p.dir.x * p.speed * dt;
    p.mesh.position.y += p.dir.y * p.speed * dt;

    // Point along the direction of travel. Matters most for homing missiles
    // and the seagull, which curve constantly — without this they slide
    // sideways through their own arc. Skipped for spinners (starfish), whose
    // whole look is tumbling rather than pointing.
    if (p.orient && !p.spin) {
      // Art forward is +Y, hence the quarter turn.
      p.mesh.rotation.z = Math.atan2(p.dir.y, p.dir.x) - Math.PI / 2;
      // Mirror instead of rolling belly-up when travelling leftward.
      p.mesh.rotation.y = p.dir.x < 0 ? Math.PI : 0;
    }
    if (p.spin) p.mesh.rotation.z += p.spin * dt;
    // Rock ammo tumbles about its own arbitrary axis. Only when nothing else
    // is driving the orientation: `orient` and `spin` both write Euler angles
    // straight onto the mesh each frame, which would wipe out the quaternion
    // this composes onto.
    else if (!p.orient) updateTumble(p.mesh, dt);
    if (p.anim) p.anim.update(dt, 'swim', false);
    if (p.hitLock > 0) p.hitLock -= dt;
    p.life -= dt;

    if (p.bounce) {
      const exhausted = updateBounce(p, onBounce);
      if (exhausted) { despawn(scene, i); continue; }
    }

    const pos = p.mesh.position;
    const outside =
      pos.x < bounds.left - m || pos.x > bounds.right + m ||
      pos.y < bounds.bottom - m || pos.y > bounds.top + m;

    if (p.life <= 0 || outside) despawn(scene, i);
  }
}

export function despawn(scene, index) {
  const p = projectiles[index];
  if (!p) return;
  scene.remove(p.mesh);
  projectiles.splice(index, 1);
}

export function resetProjectiles(scene) {
  for (const p of projectiles) scene.remove(p.mesh);
  projectiles.length = 0;
}
