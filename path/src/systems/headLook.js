import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { buildChain, applyChain, coneGate, smoothstep } from './ikChain.js';

// Head-look for the hunters — the same CCD chain the seal aims its neck with
// (systems/ikChain.js), pointed at whatever the creature is currently chasing
// instead of at the player's cursor.
//
// It exists because `faceMotion` alone reads as a decoy on a string. A shark
// steers with `turnRate`, so on a wide arc the whole body swings as one rigid
// piece and nothing about it says the animal has SEEN anything. Letting the
// head lead the turn by a few degrees is the entire tell: the head commits
// first and the body follows, which is the difference between a fish being
// dragged toward you and a fish that has decided to eat you.
//
// Deliberately weaker than the seal's rig, on every axis that matters:
//
//   - It is capped far tighter (CONFIG.enemyLook.maxBend, ~10 degrees a bone
//     against the seal's ~18). These chains run through the SPINE on most of
//     these models — there is no neck on a shark — so a bend that would look
//     fine on a seal's neck folds a shark's whole front third.
//   - It has one weight, not the seal's engaged/idle pair. Nothing here is
//     "firing"; a hunter either has something to look at or it doesn't.
//   - It gives up on range as well as angle. The seal's cursor is always
//     worth looking at; a shark forty units away staring across the arena
//     just looks possessed.
//
// Runs AFTER the animation controller has written the frame — the mixer clip,
// the procedural wag and the bone springs have all had their say, and this
// layers on top of whatever they left. The head bones and the spring chains
// are disjoint by construction (springs are tails and fins; this is the head),
// so the two never write the same bone.

const _aim = new THREE.Vector3();
const _root = new THREE.Vector3();

/**
 * @param instance  the posed model; reads `userData.lookRig`.
 * @returns null when this model declares no look rig or the bones don't
 *   resolve, which every caller treats as "this creature doesn't look".
 */
export function createHeadLook(instance) {
  const def = instance?.userData?.lookRig;
  if (!def?.head) return null;

  // minBones 1, unlike the seal's limbs. A shark rig is frequently a skull
  // parented straight onto the spine with nothing between — mightymeg's whole
  // "neck" is one bone — and rotating that single bone IS the look. For a
  // flipper a one-bone chain means someone mistyped the list; here it's the
  // rig being honest about having no neck.
  const head = buildChain(instance, def.head, def.tipAxis ?? '+Y', 'headLook head chain', 1);
  if (!head) return null;

  let weight = 0;

  // Anti-ratchet. The bend cap in applyChain is measured against whatever is
  // in the bone when it starts — which is meant to be "the pose the animation
  // wrote this frame". That holds for the seal, whose mixer overwrites its
  // neck bones every single frame, so the cap reads as an absolute limit.
  //
  // It does NOT hold here. shark.glb ships no clips at all, and even the
  // rigged creatures only have tracks for the bones their animator happened
  // to key. A bone nothing else writes still holds LAST frame's IK output, so
  // the "limit" becomes a per-frame budget measured from our own previous
  // answer, and the head walks a further maxBend round every frame until it
  // is looking clean through its own body. Measured before this guard: the
  // shark's head reached 31 degrees against a 10 degree cap, and climbing.
  //
  // Same failure the bone springs hit — see the note in systems/animation.js
  // about the spring chasing its own output — and the same shape of fix:
  // give the solver a stable reference instead of its own last answer. Here
  // that means putting back the pose we were handed, but only for bones that
  // still hold exactly what we wrote, since anything else means a clip (or
  // the procedural wag) has since overwritten it and that new value is the
  // honest reference.
  const n = head.bones.length;
  const givenQ = Array.from({ length: n }, () => new THREE.Quaternion());
  const wroteQ = Array.from({ length: n }, () => new THREE.Quaternion());
  let hasWritten = false;

  function restoreReference() {
    if (!hasWritten) return;
    for (let i = 0; i < n; i++) {
      // Exact equality is the right test, not a tolerance: a mixer writing
      // this bone produces its own value, and an untouched bone still holds
      // the exact float we stored. (A clip that happened to key a bone to
      // precisely our last output would be restored one frame stale — which
      // is the same value it already held, so nothing moves.)
      if (head.bones[i].quaternion.equals(wroteQ[i])) head.bones[i].quaternion.copy(givenQ[i]);
    }
  }

  return {
    head,

    /**
     * @param target  world-space point to look at, or null to release. The
     *   caller passes whatever the creature is actually steering toward, so
     *   the head tracks its real quarry rather than always the player.
     * @param suppressed  hand the bones straight back to the clip (a death or
     *   other one-shot owns the pose).
     */
    update(dt, target, { suppressed = false } = {}) {
      const cfg = CONFIG.enemyLook;
      let gate = 0;

      // Before anything reads these bones: put back the pre-IK pose wherever
      // nothing else has written since, then record what we were handed.
      restoreReference();
      for (let i = 0; i < n; i++) givenQ[i].copy(head.bones[i].quaternion);

      if (cfg.enabled && target && !suppressed) {
        // Aim from the chain's own root, matching how the seal's chains each
        // aim from where they're attached rather than from the body centre.
        head.bones[0].updateWorldMatrix(true, false);
        head.bones[0].getWorldPosition(_root);
        _aim.set(target.x - _root.x, target.y - _root.y, 0);
        const dist = _aim.length();
        if (dist > 1e-4) {
          _aim.divideScalar(dist);
          // Two independent reasons to stop caring, multiplied: too far away
          // to plausibly be tracking it, and too far round the body to reach
          // without folding the spine through itself. Both fade rather than
          // switch, so the head eases off instead of dropping the pose.
          const ranged = 1 - smoothstep(cfg.fadeRange, cfg.maxRange, dist);
          gate = ranged * coneGate(head, cfg, _aim);
        }
      }

      const want = gate * cfg.weight;
      weight += (want - weight) * (1 - Math.exp(-cfg.weightLerp * dt));

      // Called unconditionally, even at zero weight: applyChain's released
      // branch is what drops the smoothing history, so skipping it would
      // leave the chain primed with a stale pose to ease out of next time
      // this creature found a target.
      applyChain(head, dt, cfg, weight, 1, _aim);

      for (let i = 0; i < n; i++) wroteQ[i].copy(head.bones[i].quaternion);
      hasWritten = true;
    },

    // New run / recycled instance: forget the pose entirely rather than
    // easing out of one that belonged to a different creature.
    reset() {
      weight = 0;
      head.primed = false;
      hasWritten = false;
    },

    get weight() { return weight; },
  };
}
