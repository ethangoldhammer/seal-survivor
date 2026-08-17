import * as THREE from 'three';
import { CONFIG } from '../config.js';

// Procedural jaw, for the predators whose files ship no bite clip.
//
// Of the seven hunters in the roster exactly ONE has an authored bite —
// megalodon.glb's "metarig|Bite" (1.30s) and "metarig|Tear" (2.93s). Everything
// else is a swim cycle and nothing more:
//
//   shark.glb        0 clips at all (it doesn't even swim on its own — see the
//                    procedural wag notes in systems/animation.js)
//   mightymeg.glb    1 clip, "Take 001"
//   orca.glb         5 clips: idle / swim / rushbeach / two jump POSES
//   dolphin.glb      2 clips: "move" and a T-pose
//   greatwhite.glb   3 clips — and one of them is called "Bite", which is a
//                    trap. It has duration 0 and 13 single-key tracks whose
//                    values are the REST pose (several are the q/-q negation
//                    of it, which is the same rotation). It keys no jaw bone
//                    and moves nothing. It is a marker somebody left in the
//                    file, not an animation.
//
// What they all DO have is a jaw bone, because these are real anatomical rigs:
// head_jaw_022, mouth_030, Jaw_018, mouth_015, mouth_010, jaw_00, and on the
// great white an unnamed one (its rig names carry no meaning — see the notes
// in assets.js). So the bite is one bone rotating about one axis, on a curve.
//
// Not IK. IK solves for "put this tip at that point", and a jaw has nowhere to
// reach — it opens by an amount and shuts. A CCD chain here would be strictly
// more machinery for strictly less control over the timing, which is the part
// that actually sells a bite: a fast gape and a faster snap.
//
// ASSETS.<key>.biteRig names the bone, the local axis it hinges about, and the
// SIGNED angle that opens it. All three were measured per model rather than
// guessed — see the note on ASSETS.enemyShark.biteRig for the method.

const AXES = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

// Gape fast, snap faster. Two different eases rather than one symmetrical
// curve: the mouth flying open is what you notice, the shut is what lands.
function opening(u) {
  return u * (2 - u); // ease-out — most of the travel in the first half
}
function closing(u) {
  return (1 - u) * (1 - u); // ease-in — hangs open, then slams
}

/**
 * @param instance  the posed model; reads `userData.biteRig`.
 * @returns null when this model declares no bite rig or the bone doesn't
 *   resolve, which every caller treats as "this creature doesn't bite".
 */
export function createJawDriver(instance) {
  const def = instance?.userData?.biteRig;
  if (!def?.bone) return null;

  const bone = instance.getObjectByName(def.bone);
  if (!bone) {
    console.warn(`[jaw] biteRig names bone "${def.bone}", which this model doesn't have — it will not bite.`);
    return null;
  }

  const axis = AXES[def.axis] ?? AXES.x;
  // Signed: the sign IS the measurement (which way this particular rig's jaw
  // swings down), so it lives in the asset, not here.
  const openAngle = def.openAngle ?? 0.5;

  // -1 = shut and idle. Anything >= 0 is elapsed seconds into a bite.
  let t = -1;

  // Anti-ratchet, exactly as in systems/headLook.js — see the long note there.
  // Same trap for the same reason: on shark.glb NOTHING else writes this bone,
  // so a plain `quaternion.multiply(open)` compounds on last frame's output and
  // the jaw winds open a further openAngle every frame until the head is
  // inside-out. Restoring the pose we were handed — but only where the bone
  // still holds exactly what we left — keeps this additive over a clip that
  // does key the jaw (mightymeg, orca and the dolphin all do) while staying
  // stable on the ones that don't.
  const given = new THREE.Quaternion();
  const wrote = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  let hasWritten = false;

  return {
    // Start a bite. Re-firing mid-bite restarts it rather than being ignored:
    // the caller already rate-limits this (see triggerBite in entities/
    // enemies.js), so a second call means a genuinely new snap.
    bite() {
      t = 0;
    },

    isBiting() {
      return t >= 0;
    },

    update(dt) {
      if (hasWritten && bone.quaternion.equals(wrote)) bone.quaternion.copy(given);
      given.copy(bone.quaternion);

      let open = 0;
      if (t >= 0) {
        const cfg = CONFIG.bite.jaw;
        t += dt;
        const openTime = Math.max(0.01, cfg.openTime);
        const holdEnd = openTime + cfg.holdTime;
        const shutEnd = holdEnd + Math.max(0.01, cfg.closeTime);
        if (t < openTime) open = opening(t / openTime);
        else if (t < holdEnd) open = 1;
        else if (t < shutEnd) open = closing((t - holdEnd) / (shutEnd - holdEnd));
        else t = -1;
      }

      if (open > 0.001) {
        q.setFromAxisAngle(axis, openAngle * open);
        // Post-multiply: rotate about the bone's OWN axis, on top of whatever
        // pose it is already in. Pre-multiplying would hinge it about the
        // parent's axis, which on these rigs is the head's roll.
        bone.quaternion.multiply(q);
      }

      wrote.copy(bone.quaternion);
      hasWritten = true;
    },

    // New run / recycled instance: shut the mouth and forget the reference
    // pose, rather than restoring one that belonged to a different creature.
    reset() {
      t = -1;
      hasWritten = false;
    },
  };
}
