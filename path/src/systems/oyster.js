import { CONFIG } from '../config.js';
import { createVisual } from '../assets.js';
import { removeEnemy } from '../entities/enemies.js';
import { spawnProjectile } from '../entities/projectiles.js';
import { player } from '../entities/player.js';
import { projectileCount } from '../stats.js';
import { emit } from '../entities/particles.js';
import { bounds } from '../arena.js';
import { aoe, abilityDamage } from './scaling.js';
import { oysterLevelStats } from '../levelStats.js';

// Oyster Blaster — a slow, heavy, bright pearl whose value is almost entirely
// in what happens when it stops. On impact it cracks into glowing bomblets
// that fly outward and detonate individually a moment later.
//
// The pearl itself is an ordinary projectile: it's spawned through
// spawnProjectile so it inherits the collision, piercing and despawn handling
// every other bullet gets, and it carries a `burst` payload that main.js hands
// back here when it lands.
//
// The BOMBLETS are not projectiles, and that's deliberate. A projectile hurts
// what it touches; a bomblet has to detonate on a fuse whether or not it ever
// touches anything, and has to blast an area when it does. Expressing that
// through the projectile list would have meant a life-expiry callback, an
// area-damage flag and a "don't damage on contact, damage on death" mode —
// three new concepts in a file that currently describes bullets very cleanly.
// They live here instead, as their own short list with their own rules.

const bomblets = []; // { mesh, vx, vy, life, damage, blastRadius }

export function currentOysterStats(level) {
  const c = CONFIG.oyster;
  const lv = Math.max(1, level);
  const O = oysterLevelStats(level, player.stats);
  return {
    // levelStats.js owns the curve — shared with the tip.
    fireRate: O.oysterGap,
    damage: O.oysterDamage,
    bomblets: O.oysterBomblets,
    bombletDamage: O.oysterBombletDamage,
    blastRadius: O.oysterBlast,
  };
}

// Launch one pearl. The `burst` payload rides along so the impact site doesn't
// have to re-derive the player's level — by the time it lands, the stat block
// may have changed under it.
export function firePearl(scene, origin, dir, level) {
  const c = CONFIG.oyster;
  const s = currentOysterStats(level);

  spawnProjectile(scene, {
    origin,
    dir,
    faction: 'player',
    damage: abilityDamage(s.damage),
    speed: c.speed,
    life: c.life,
    radius: c.radius,
    asset: 'pearl',
    source: 'oyster',
    // Spun fast off the muzzle and let down by the water. About the tilted
    // Y axis, NOT the default z: z is the axis the camera looks down, and no
    // amount of turning a sphere about it moves a single pixel. See the
    // `spinAxis` note in entities/projectiles.js.
    spin: c.pearlSpin,
    spinAxis: 'y',
    spinDrag: c.pearlSpinDrag,
    tilt: c.pearlTilt,
    // Clone Warz buys bomblets, not pearls — the pearl is one heavy shot by
    // design, and the card's promise ("+1 of everything you fire") is answered
    // by the burst, which is where this weapon's projectiles actually are.
    // Applied here rather than in currentOysterStats so that helper stays a
    // pure level -> numbers function.
    burst: {
      count: projectileCount(s.bomblets, player.stats),
      damage: abilityDamage(s.bombletDamage),
      // Splash Zone widens each bomblet's blast. Applied here with the count
      // rather than in currentOysterStats, which stays a pure helper.
      blastRadius: aoe(s.blastRadius),
    },
  });
}

// Crack a pearl open. Called from main.js when a projectile carrying a `burst`
// payload lands — including when it expires in open water, so a missed pearl
// still pays something rather than blinking out.
export function burstPearl(scene, x, y, burst) {
  const c = CONFIG.oyster;
  const count = Math.max(1, Math.round(burst?.count ?? c.bomblets));

  // The shell coming apart, in the same white the bomblets will go off in a
  // moment later — the whole ability is one colour from the crack to the last
  // detonation. Emitted straight rather than through `feedback` on purpose:
  // the sound, shake and ripple of an oyster blast belong to the bomblets,
  // and firing the event here would play all of it twice.
  emit('pearlBurst', x, y, { scale: 1.5 });

  for (let i = 0; i < count; i++) {
    const mesh = createVisual('pearlBomblet');
    mesh.position.set(x, y, 0);
    scene.add(mesh);

    // Evenly spaced around the circle with jitter, rather than `count` fully
    // random angles: pure random clusters visibly, and a shattering pearl
    // that throws four bomblets into the same quadrant reads as a bug.
    const base = (i / count) * Math.PI * 2;
    const angle = base + (Math.random() * 2 - 1) * (Math.PI / count) * 0.6;
    const [vMin, vMax] = c.bombletSpeed;
    const speed = vMin + Math.random() * Math.max(0, vMax - vMin);
    const [lMin, lMax] = c.bombletLife;

    bomblets.push({
      mesh,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: lMin + Math.random() * Math.max(0, lMax - lMin),
      damage: burst?.damage ?? c.bombletDamage,
      blastRadius: burst?.blastRadius ?? c.bombletBlastRadius,
    });
  }
}

function detonate(scene, b, enemiesList, hooks) {
  const x = b.mesh.position.x;
  const y = b.mesh.position.y;
  const r2 = b.blastRadius * b.blastRadius;

  hooks.onBlast?.(x, y, b.blastRadius);

  for (let j = enemiesList.length - 1; j >= 0; j--) {
    const e = enemiesList[j];
    const dx = e.mesh.position.x - x;
    const dy = e.mesh.position.y - y;
    if (dx * dx + dy * dy > r2) continue;

    e.hp -= b.damage;
    e.flash = CONFIG.fx.hitFlash;
    e.hitThisFrame = true;
    hooks.onEnemyDamaged?.(e, b.damage, x, y);
    if (e.hp <= 0) {
      hooks.onEnemyKilled?.(e);
      removeEnemy(scene, j);
    }
  }
}

// hooks: { onEnemyDamaged(e, dmg, x, y), onEnemyKilled(e), onBlast(x, y, r) }
export function updateOyster(dt, scene, enemiesList, hooks = {}) {
  const c = CONFIG.oyster;

  for (let i = bomblets.length - 1; i >= 0; i--) {
    const b = bomblets[i];

    // Coast outward, slowing. The drag matters: without it a bomblet is still
    // travelling at launch speed when its fuse runs out, so the burst lands as
    // a wide thin ring instead of a cluster around the impact.
    const decay = Math.exp(-c.bombletDrag * dt);
    b.vx *= decay;
    b.vy *= decay;
    b.mesh.position.x += b.vx * dt;
    b.mesh.position.y += b.vy * dt;
    b.life -= dt;

    const pos = b.mesh.position;
    const outside =
      pos.x < bounds.left - 2 || pos.x > bounds.right + 2 ||
      pos.y < bounds.bottom - 2 || pos.y > bounds.top + 2;

    // A bomblet that leaves the arena is discarded WITHOUT detonating —
    // blasting offscreen would deal damage the player can neither see nor
    // have aimed, which is the kind of invisible output that makes an ability
    // impossible to read.
    if (outside) {
      scene.remove(b.mesh);
      bomblets.splice(i, 1);
      continue;
    }

    if (b.life <= 0) {
      detonate(scene, b, enemiesList, hooks);
      scene.remove(b.mesh);
      bomblets.splice(i, 1);
    }
  }
}

export function resetOyster(scene) {
  for (const b of bomblets) scene.remove(b.mesh);
  bomblets.length = 0;
}
