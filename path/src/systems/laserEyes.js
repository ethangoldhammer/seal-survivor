import { CONFIG } from '../config.js';
import { spawnBeam } from './beams.js';

// LASER EYES — the seal's pair, and the boss's own trick pointed back at it.
//
// Deliberately the same object the eyebeam perk lights (systems/beams.js): the
// sweep, the per-target tick, the bloom floor and the flash on contact are all
// that file's, and this one only decides WHEN a beam exists and what it is
// worth. Two implementations would have been two of every bug in there, and —
// more to the point — the player learning to read the boss's beam should be the
// same lesson as learning to use their own.
//
// WHAT MAKES IT A LASER RATHER THAN A GUN. Every other weapon the seal owns
// fires a thing that travels; the counterplay to all of them is distance. This
// one is instant along its whole length and then STAYS, so its skill is not
// leading a target — it is holding a line across a shoal while the line is lit,
// and its cost is that it commits your aim for most of a second.
//
// The beams are welded to the seal's head (see `follow` below), so they sweep
// as you turn. That is the entire feel of the upgrade and it is one callback.

const state = {
  cooldown: 0,
};

function cfg() {
  return CONFIG.laserEyes ?? {};
}

/** Everything level `n` is worth, in one place so the card and the water agree. */
export function laserEyeStats(level = 0) {
  const c = cfg();
  const n = Math.max(0, level);
  return {
    fireEvery: Math.max(
      c.fireEveryMin ?? 1.2,
      (c.fireEvery ?? 2.6) + (c.fireEveryPerLevel ?? -0.18) * (n - 1),
    ),
    burn: (c.burn ?? 0.85) + (c.burnPerLevel ?? 0.09) * (n - 1),
    damage: (c.damage ?? 7) + (c.damagePerLevel ?? 2.4) * (n - 1),
    reach: (c.reach ?? 26) + (c.reachPerLevel ?? 3.2) * (n - 1),
    // FLOORED, so a new beam arrives on a specific stack rather than a fraction
    // of one arriving every stack. A count that crept up by 0.34 would spawn
    // two beams for three levels and then silently three, with nothing on the
    // card able to say when.
    beams: Math.min(
      c.beamsMax ?? 4,
      Math.max(1, Math.floor((c.beams ?? 2) + (c.beamsPerLevel ?? 0.34) * (n - 1))),
    ),
  };
}

/**
 * One frame.
 *
 * @param aim normalised direction the seal is looking. May be zero-length — a
 *            player who has not moved the mouse yet still has eyes.
 */
export function updateLaserEyes(dt, scene, playerPos, level, aim) {
  if (!(level > 0)) return;
  state.cooldown -= dt;
  if (state.cooldown > 0) return;

  const c = cfg();
  const s = laserEyeStats(level);
  state.cooldown = s.fireEvery;

  // A zero-length aim would give a beam with no direction, which normalises to
  // NaN and draws nothing. Default to facing right, the same fallback the
  // aiming rig uses on the first frame of a run.
  let ax = aim?.x ?? 0;
  let ay = aim?.y ?? 0;
  const len = Math.hypot(ax, ay);
  if (len < 1e-4) { ax = 1; ay = 0; } else { ax /= len; ay /= len; }

  for (let i = 0; i < s.beams; i++) {
    // The fan, centred on the aim: with two beams they straddle it by an eye's
    // width and read as a stare; past two they spread into a cone.
    const half = (s.beams - 1) / 2;
    const angle = s.beams > 2 ? (i - half) * (c.spread ?? 0.17) : 0;
    // Which eye this one comes out of, and therefore which side of the axis.
    const side = (i % 2 === 0 ? 1 : -1) * (c.eyeSide ?? 0.28);

    spawnBeam(scene, {
      x: playerPos.x, y: playerPos.y, dirX: ax, dirY: ay,
      length: s.reach,
      life: s.burn,
      damage: s.damage,
      color: c.color ?? 0x64f0ff,
      hitsEnemies: true,
      source: 'laserEyes',
      // WELDED TO THE HEAD. Re-read every frame by beams.js, so the line stays
      // on the eye it came from and sweeps with the seal — which is why this
      // captures `angle` and `side` rather than a finished origin. A beam that
      // took its position once would hang in the water where the seal used to
      // be, and at the speed a boosting seal moves that is most of the burn.
      follow: () => {
        const a = liveAim();
        const c2 = Math.cos(angle);
        const s2 = Math.sin(angle);
        const dx = a.x * c2 - a.y * s2;
        const dy = a.x * s2 + a.y * c2;
        return {
          // Out to the side of the aim axis (its perpendicular), then forward.
          x: playerPos.x + -a.y * side + dx * (c.eyeForward ?? 0.55),
          y: playerPos.y + a.x * side + dy * (c.eyeForward ?? 0.55),
          dirX: dx,
          dirY: dy,
        };
      },
    });
  }
}

// The aim, as of THIS frame rather than the one the beam was lit on. Held in a
// module-level pair that update() refreshes, so the follow callbacks above
// close over a function rather than over a Vector that main.js is free to
// recycle between frames.
const _aim = { x: 1, y: 0 };
function liveAim() { return _aim; }

/** Called by main.js every frame, before update — see `_aim`. */
export function setLaserAim(aim) {
  const x = aim?.x ?? 0;
  const y = aim?.y ?? 0;
  const len = Math.hypot(x, y);
  if (len < 1e-4) return; // keep the last real direction rather than snapping
  _aim.x = x / len;
  _aim.y = y / len;
}

/** A new run starts with the eyes cold. */
export function resetLaserEyes() {
  state.cooldown = 0;
}
