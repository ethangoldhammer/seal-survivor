import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { spawnProjectile } from '../entities/projectiles.js';
import { player } from '../entities/player.js';
import { projectileCount } from '../stats.js';

// MUSSEL BARRAGE — the whole flight of homing mussels thrown at once, on a
// strike released at or above CONFIG.musselVolley.chargeThreshold.
//
// This is not a weapon with a cooldown, and deliberately has no update() at
// all: it is a thing a FULL CHARGE does, fired from the release site on the
// frame the dash launches. Its cost is the wind-up that was already spent, so
// a cooldown here would be charging twice for the same commitment.
//
// The shape is the Hades multishot bow. You do not get a stream, you get one
// loud moment, and the fan is wide enough (`arc`, ~120 degrees) that it is an
// area answer rather than an aimed one — the homing is what turns that spread
// back into hits. Below the threshold nothing happens at all, which is what
// stops it becoming the thing you spam: a flick strike is still just a dash.
//
// Aimed along the dash heading rather than the cursor, so the barrage and the
// seal go the same way and the shells lead the dash into whatever it is diving
// at. Commit, and everything leaves at once in the direction you committed.

/** How many shells a barrage at this level throws. */
export function barrageCount(level) {
  const c = CONFIG.musselVolley;
  return Math.max(1, Math.round(c.count + c.countPerLevel * (Math.max(1, level) - 1)));
}

/** What one shell hits for at this level. */
export function barrageDamage(level) {
  const c = CONFIG.musselVolley;
  return c.damage + c.damagePerLevel * (Math.max(1, level) - 1);
}

/**
 * Does a strike released with this much banked power earn a barrage?
 *
 * Split out because two places need the same answer and they must not be able
 * to disagree: this system, and anything that wants to TELL the player it is
 * coming (the charge ring going hot at the threshold).
 */
export function barrageReady(power, level) {
  const c = CONFIG.musselVolley;
  return !!c?.enabled && level > 0 && power >= c.chargeThreshold;
}

/**
 * Throw the barrage. Returns how many shells actually left, so the caller can
 * skip its own bookkeeping when the release didn't qualify.
 *
 * @param scene    where the projectiles go
 * @param power    the banked power the dash was bought with, 0..1. NOT the
 *                 meter — tryStrike has already zeroed that by release time.
 * @param level    stats.musselVolleyLevel
 * @param dashDir  { x, y } the dash heading, already normalized
 * @param originFor (index, dirX, dirY) -> THREE.Vector3-ish launch point. A
 *                 callback rather than a point, because the emit points walk
 *                 across the seal's flippers and only main.js owns that rig.
 * @param hooks    { onLaunch(index, x, y, dirX, dirY, speed) }
 */
export function fireMusselBarrage(scene, power, level, dashDir, originFor, hooks = {}) {
  if (!barrageReady(power, level)) return 0;

  const c = CONFIG.musselVolley;
  // Clone Warz is applied HERE rather than inside barrageCount, which stays a
  // pure level -> shells function for the card text and the tuner readout. The
  // barrage is already gated on being owned by barrageReady above.
  const count = projectileCount(barrageCount(level), player.stats);
  const damage = barrageDamage(level);
  const heading = Math.atan2(dashDir.y, dashDir.x);

  for (let i = 0; i < count; i++) {
    // Evenly across the arc, centred on the heading — a lone shell sits dead
    // centre rather than at one edge of the fan. Random jitter on top so two
    // barrages never trace the same eight curves.
    const lane = count > 1 ? (i / (count - 1)) * 2 - 1 : 0;
    const angle = heading + lane * c.arc * 0.5 + (Math.random() * 2 - 1) * c.spread;
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    const speed = c.speed * (1 + (Math.random() * 2 - 1) * c.speedJitter);
    const origin = originFor(i, dirX, dirY);

    hooks.onLaunch?.(i, origin.x, origin.y, dirX, dirY, speed);

    spawnProjectile(scene, {
      origin,
      dir: new THREE.Vector2(dirX, dirY),
      faction: 'player',
      damage,
      speed,
      life: c.life,
      radius: c.radius,
      pierce: 0,
      asset: 'missile',
      // Its own source tag, not 'missile': the playtest report has to be able
      // to say whether the barrage earned its pick, and folding it into the
      // missile's numbers would hide that behind a weapon most runs also have.
      source: 'musselVolley',
      orient: true,
      homing: true,
      // Longer delay than a standard missile, for a different reason: eight
      // shells leaving one point at once need to visibly BE a volley before
      // the seekers pull them apart. Homing that engages instantly collapses
      // the fan into a single stream within a few frames of launch.
      homingDelay: c.homingDelay,
      turnRate: c.turnRate,
      acquireRadius: c.acquireRadius,
    });
  }
  return count;
}
