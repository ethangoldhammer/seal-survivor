import * as THREE from 'three';

// Shared 3D orbit used by the companion abilities (beluga drone, Seal Team).
//
// The ring is TILTED rather than drawn flat on the play plane: Z swings a
// quarter-turn out of phase with X, so a companion passes in front of the seal
// on one half of the circle and behind it on the other. Y is squashed relative
// to X so the whole thing reads as a ring seen at an angle instead of a circle
// painted on the screen.
//
// `offset` shifts the centre of the ring off the player — so a companion can
// ride above and slightly ahead rather than being centred on the seal.
//
// `slot`/`count` spread multiple companions evenly around the same ring, which
// is what keeps a Seal Team from stacking on top of each other.

const target = new THREE.Vector3();

/**
 * @param {number} clock       seconds, monotonically increasing
 * @param {THREE.Vector3} playerPos
 * @param {object} cfg  { orbitRadius, orbitSpeed, orbitDepth, bobAmount,
 *                        offsetX, offsetY, offsetZ }
 * @param {number} slot   which companion this is (0-based)
 * @param {number} count  how many share the ring
 * @returns {THREE.Vector3} reused vector — copy it if you need to keep it
 */
export function orbitTarget(clock, playerPos, cfg, slot = 0, count = 1) {
  const phase = count > 1 ? (slot / count) * Math.PI * 2 : 0;
  const angle = clock * (cfg.orbitSpeed ?? 1) + phase;
  const r = cfg.orbitRadius ?? 2;

  target.set(
    playerPos.x + Math.cos(angle) * r + (cfg.offsetX ?? 0),
    playerPos.y + Math.sin(angle) * r * 0.55
      // Bob is per-slot too, or a whole team bobs in lockstep like one object.
      + Math.sin(clock * 1.7 + phase) * (cfg.bobAmount ?? 0)
      + (cfg.offsetY ?? 0),
    Math.sin(angle) * (cfg.orbitDepth ?? 0) + (cfg.offsetZ ?? 0),
  );
  return target;
}

// Damped-spring follow toward `to`. Companions TRACK their orbit point rather
// than being pinned to it, so they lag on turns and overshoot slightly — the
// difference between an animal swimming alongside you and a prop welded to a
// circle. Mutates `pos` and `vel` in place.
export function springFollow(pos, vel, to, dt, spring, damp) {
  const damping = Math.exp(-damp * dt);
  vel.x = (vel.x + (to.x - pos.x) * spring * dt) * damping;
  vel.y = (vel.y + (to.y - pos.y) * spring * dt) * damping;
  vel.z = (vel.z + (to.z - pos.z) * spring * dt) * damping;
  pos.x += vel.x * dt;
  pos.y += vel.y * dt;
  pos.z += vel.z * dt;
}
