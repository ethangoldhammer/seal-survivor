import { CONFIG } from '../config.js';
import { spawnBeam } from './beams.js';
import { eyeSocket, flashEyeLightsLaser } from './eyeLights.js';
import { player } from '../entities/player.js';
import { laserEyesLevelStats } from '../levelStats.js';

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
//
// WHERE THEY COME OUT. The seal's eye sockets, read live off the aim rig —
// the same two points the glowing orbs sit in (systems/eyeLights.js), so the
// line always leaves the thing that is lit. They were a hand-typed offset from
// the body centre until the orbs existed to disagree with them: `eyeForward`
// was 0.55 world units ahead of the seal's ORIGIN, and the sockets are 2.6
// ahead of it. The beams were starting inside the animal's ribcage, which
// nobody could see until something was drawn at the eyes.
//
// The offset survives as the fallback for a model with no eye bones (anything
// swapped in through the workbench), which is why this file still knows about
// it at all.

const state = {
  cooldown: 0,
};

function cfg() {
  return CONFIG.laserEyes ?? {};
}

/** Everything level `n` is worth, in one place so the card and the water agree. */
export function laserEyeStats(level = 0) {
  // levelStats.js owns every one of these curves AND both of their clamps —
  // the `fireEveryMin` floor and the `beamsMax` ceiling moved in with them, so
  // the hover tip cannot promise a fifth beam or a cadence the water will not
  // deliver. See laserEyesLevelStats.
  const L = laserEyesLevelStats(level, player.stats);
  return {
    fireEvery: L.laserGap,
    burn: L.laserBurn,
    damage: L.laserDamage,
    reach: L.laserReach,
    beams: L.laserBeams,
  };
}

/**
 * One frame.
 *
 * @param aim normalised direction the seal is looking. May be zero-length — a
 *            player who has not moved the mouse yet still has eyes.
 */
export function updateLaserEyes(dt, scene, playerPos, level, aim, rig = null) {
  setLaserRig(rig);
  if (!(level > 0)) return;
  state.cooldown -= dt;
  if (state.cooldown > 0) return;

  const c = cfg();
  const s = laserEyeStats(level);
  state.cooldown = s.fireEvery;
  // THE MUZZLE. The eyes are black at rest, so without this a line of light
  // leaves an unlit socket and reads as a beam with no source. Fired once per
  // VOLLEY rather than once per beam — four beams is still one blink, and
  // stacking four flares would make a high stack visibly brighter at the face
  // for no reason a player could name.
  flashEyeLightsLaser(1);

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
    // The socket index, kept separate from the beam index: a fan of four is
    // still two eyes, so beams 2 and 3 leave the same sockets as 0 and 1.
    const socket = i % 2;

    const o0 = originFor(socket, side, ax, ay, playerPos);
    spawnBeam(scene, {
      x: o0.x, y: o0.y, dirX: ax, dirY: ay,
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
        const o = originFor(socket, side, a.x, a.y, playerPos);
        return { x: o.x, y: o.y, dirX: dx, dirY: dy };
      },
    });
  }
}

// WHERE ONE BEAM STARTS, in the play plane.
//
// The socket carries real camera depth — the two eyes are at world z ±0.21, on
// opposite sides of a head this camera only sees side-on — and a beam has to
// lie in the plane everything else is resolved in. So the z is dropped, which
// is exactly what emitPoint's `flattenZ` does to the two flipper muzzles for
// the same reason. Both eyes therefore flatten onto ONE point.
//
// `side` is what keeps two beams legible after that flattening: a small
// straddle across the aim axis, so a pair reads as a stare rather than as one
// thick line. It is now measured from the SOCKET rather than from the middle
// of the seal — set CONFIG.laserEyes.eyeSide to 0 and both beams leave the lit
// eye exactly, which is a real look and a slider away.
const _origin = { x: 0, y: 0 };
function originFor(socket, side, ax, ay, playerPos) {
  const c = cfg();
  const p = eyeSocket(_rig, socket, null);
  if (p) {
    _origin.x = p.x + -ay * side;
    _origin.y = p.y + ax * side;
  } else {
    // No eye bones on this model. The old body-relative offset, unchanged.
    _origin.x = playerPos.x + -ay * side + ax * (c.eyeForward ?? 0.55);
    _origin.y = playerPos.y + ax * side + ay * (c.eyeForward ?? 0.55);
  }
  return _origin;
}

// The rig, as of THIS frame. Held module-level for the same reason `_aim` is:
// a `follow` closure must not capture the rig object, because swapping the
// player's model mid-run (the workbench) builds a NEW rig with new anchor
// vectors and every beam still burning would go on reading the old seal's
// head.
let _rig = null;

/** Called by updateLaserEyes; separate so a harness can drive it directly. */
export function setLaserRig(rig) {
  _rig = rig ?? null;
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
  _rig = null;
}
