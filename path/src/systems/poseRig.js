import * as THREE from 'three';
import { buildChain, measureReach } from './ikChain.js';
import { trackCoverage } from './animation.js';

// ============================================================================
// POSING THE SEAL BY HAND — the parts every hand-posed performance needs, and
// nothing about any particular performance.
//
// Two systems pose this animal procedurally rather than playing a clip:
// systems/celebrate.js (the boss-kill victory lap) and systems/clap.js (the
// clap button). They are completely different in timing and intent — one is a
// second-and-a-half performance on the wall clock, the other a 0.3s gesture
// that can be re-fired on top of itself — and they need exactly the same four
// things underneath:
//
//   1. THE CHAINS, built off the aim rig's own descriptors, with each flipper's
//      side taken from where the bone actually is.
//   2. THE BODY'S AXES in world space, re-read every frame because the animal
//      turns.
//   3. A TARGET measured in the chain's OWN reach rather than in world units.
//   4. THE ANTI-RATCHET — a snapshot of the bones the mixer will not put back,
//      and the discipline of restoring it before posing.
//
// Every one of those has a trap in it that this project has already paid for
// once (see the long notes below and in systems/celebrate.js). Written twice
// they would be two things to keep right, and the second copy would rot the
// first time the model is re-exported — which is exactly what
// [[paired reaches must measure alike]] is about. So they live here once, and
// each performance brings only its own clock and its own shapes.
// ============================================================================

// Scratch, module-level so posing allocates nothing per frame.
const _root = new THREE.Vector3();
const _lat = new THREE.Vector3();

/**
 * A POSE TARGET, in the chain's own units.
 *
 * Every target is built from the chain's OWN root and its OWN measured reach,
 * in the instance's own frame — never in hand-typed world units. Two reasons,
 * both of which have bitten this project before: the seal carries a size
 * multiplier that a literal offset would ignore, and the two flippers do not
 * even have the same reach (1.818 left, 2.037 right — the rig is not
 * symmetric). A target written as "0.8 of the way up this limb's own length"
 * is right on both flippers and stays right if the model is ever re-exported.
 *
 * `up` and `fore` are measured from the limb's OWN root, because how high a
 * flipper is held is a question about that shoulder. `lateral` is measured
 * from the BODY'S CENTRELINE instead, because how far out to the side a
 * flipper is held is a question about the animal.
 *
 * That distinction is the difference between a clap and a shrug, and it is
 * worth spelling out because the first version got it wrong in a way that
 * still looked plausible: anchored at the shoulder, `close: 0.08` asked each
 * flipper to come 8% of its reach toward the midline FROM A SHOULDER THAT IS
 * ALREADY 0.24 OUT, so the two hands stopped 0.84 apart — a measurable closing
 * motion that never touches. Measured from the centreline it means what it
 * says.
 *
 * `side` is -1 for the left flipper and +1 for the right, matching the
 * measured rest positions (left at z=-0.71, right at z=+0.74).
 */
export function poseTarget(chain, out, basis, side, up, fore, lateral) {
  chain.bones[0].updateWorldMatrix(true, true);
  chain.bones[0].getWorldPosition(_root);
  const reach = measureReach(chain, 1);
  const latRoot = _lat.copy(_root).sub(basis.origin).dot(basis.lat);
  out.copy(_root)
    .addScaledVector(basis.up, up * reach)
    .addScaledVector(basis.fore, fore * reach)
    .addScaledVector(basis.lat, side * lateral * reach - latRoot);
  return out;
}

/**
 * Build the shared posing surface for one model instance.
 *
 * REUSES THE AIM RIG'S CHAIN DESCRIPTORS rather than declaring its own. Those
 * bone lists and tip lengths were measured onto this exact model (see the
 * notes on ASSETS.ship.aimRig — the fin tips are measured onto the outermost
 * skinned vertex, the head chain deliberately stops short of the jaw so the
 * seal doesn't gape). A second copy of that would be a second thing to keep
 * right, and it would silently rot the first time the model is re-exported.
 *
 * @param instance the posed model (a createVisual wrapper)
 * @param label    what to call this rig in a warning, e.g. 'celebrate'
 * @returns null for a model with no aim rig, which every caller treats as
 *   "this creature doesn't do this".
 */
export function createPoseRig(instance, label = 'pose') {
  const def = instance?.userData?.aimRig;
  if (!def) return null;

  const tipAxis = def.tipAxis ?? '+Y';
  const fins = (def.fins ?? [])
    .map((d) => {
      const chain = buildChain(instance, d, tipAxis, `${label} fin "${d.name ?? '?'}"`);
      if (!chain) return null;
      // Which side of the body this flipper is on, taken from where the bone
      // ACTUALLY IS rather than from its name — `left`/`right` in the asset
      // are labels, and a mirrored re-export would swap the geometry without
      // touching them. Measured at build time, once.
      chain.bones[0].updateWorldMatrix(true, true);
      chain.bones[0].getWorldPosition(_root);
      instance.worldToLocal(_root);
      return { chain, side: _root.z < 0 ? -1 : 1 };
    })
    .filter(Boolean);
  const head = def.head ? buildChain(instance, def.head, tipAxis, `${label} head chain`) : null;
  const tail = def.tail ? buildChain(instance, def.tail, tipAxis, `${label} tail chain`) : null;
  if (!fins.length && !head && !tail) return null;

  const basis = {
    up: new THREE.Vector3(), fore: new THREE.Vector3(), lat: new THREE.Vector3(),
    origin: new THREE.Vector3(), // the body's centreline, which `lateral` is measured from
  };

  // THE POSE THE SEAL WAS IN WHEN THIS PERFORMANCE STARTED, captured by the
  // caller and restored at the top of every frame after it.
  //
  // This is not tidiness, it is the only thing standing between a hand-posed
  // performance and a permanent ratchet — and the reason is a property of the
  // model, not of any one system. THE `swim` CLIP DOES NOT KEY THE FRONT
  // FLIPPERS: it writes 19 of the rig's nodes and shoulder_L_011, uparm_L_012,
  // arm_L_013, hand_L_014 and shoulder_R_015 are not among them (every other
  // clip in the file keys 23 and covers them all).
  //
  // So while the seal is swimming, NOTHING lays an absolute pose on those
  // bones each frame. applyChainToPoint blends from whatever is already in a
  // bone toward its solution, which means on an unkeyed bone it blends from
  // its own previous output — the weight easing back to 0 hands the flipper
  // back to the posed position rather than to the swim cycle, and the seal
  // finishes every boss fight a little further into a wave it never lowers.
  // Measured before this existed: 0.54 out of position after eight kills,
  // against a control seal that never celebrated.
  //
  // Restoring an entry snapshot rather than the bind pose keeps the blend
  // honest at both ends: the pose grows out of exactly where the animal was
  // and returns to exactly there, with nothing to pop at either edge.
  // ...but ONLY on the bones that actually need it, which is the other half of
  // this and was found the same way (measured, against a control seal).
  //
  // Restoring a bone the mixer IS driving does not merely waste work, it
  // breaks the mixer: three.js's PropertyMixer skips its write whenever the
  // value it computes equals the one it last wrote, on the reasonable
  // assumption that nobody else touched the bone in between. Overwrite one and
  // that cache is stale, so the clip stops restoring it — the right flipper
  // finished 13.8 degrees out and STAYED there, while the unkeyed left one was
  // perfect. Exactly backwards from what the fix was supposed to do.
  //
  // So a bone is restored only when the mixer cannot be relied on to take it
  // back, and is otherwise left alone to be overwritten by the clip as the
  // weight comes off.
  //
  // "Cannot be relied on" is NOT the same as "unkeyed", and the difference is
  // the whole trap. A track with a SINGLE keyframe is a constant: the mixer
  // computes the same value every frame, its value-unchanged check fires, and
  // it stops writing after the first one — so a constant-keyed bone is exactly
  // as unrecoverable as an unkeyed bone, while looking keyed to any check that
  // only asks whether a track exists. On this model the swim cycle keys
  // uparm_R_016, arm_R_017, hand_R_018 and neck01_05 with one keyframe each,
  // against 31 for head_07 and tail01_020 — so the flipper that LOOKED safe
  // was the one that stuck 74 degrees out of place.
  // The test itself lives in systems/animation.js, shared with the state
  // inspector (ui/animDebug.js) — one answer to "will the clip put this bone
  // back", so the panel cannot tell you something different from what the
  // posing systems act on.
  const coverage = trackCoverage(instance);
  const mixerOwns = (bone) => coverage.get(bone.name)?.owned === true;

  const posedBones = [...new Set([
    ...fins.flatMap(({ chain }) => chain.bones),
    ...(head?.bones ?? []),
    ...(tail?.bones ?? []),
  ])].filter((b) => !mixerOwns(b));
  const entryQ = posedBones.map((b) => b.quaternion.clone());

  return {
    fins,
    head,
    tail,
    basis,

    /**
     * The seal's own axes, in world space. Re-read every frame because the
     * body turns: `up` is dorsal (-X), `fore` is the nose (+Y) and `lat` runs
     * left-to-right through the flippers (+Z). Normalised, so the size
     * multiplier on the instance can't scale the pose targets twice.
     */
    refreshBasis() {
      instance.updateWorldMatrix(true, false);
      instance.matrixWorld.extractBasis(basis.up, basis.fore, basis.lat);
      basis.up.normalize().multiplyScalar(-1);
      basis.fore.normalize();
      basis.lat.normalize();
      instance.getWorldPosition(basis.origin);
    },

    /** A target for one chain, in that chain's own reach. See poseTarget. */
    target(chain, out, side, up, fore, lateral) {
      return poseTarget(chain, out, basis, side, up, fore, lateral);
    },

    /** Remember where the animal is, as the pose's zero. */
    capture() {
      for (let i = 0; i < posedBones.length; i++) entryQ[i].copy(posedBones[i].quaternion);
    },

    /** Put it back there. Call before posing, every frame. */
    restore() {
      for (let i = 0; i < posedBones.length; i++) posedBones[i].quaternion.copy(entryQ[i]);
    },

    /**
     * Drop the smoothing history. The IK chains keep a smoothed pose across
     * frames, so a driver that isn't unprimed between performances would blend
     * the last one's flipper position into the first frames of the next —
     * most visibly on a restart, where the seal would begin its run finishing
     * a clap for a boss that died in the previous game.
     */
    unprime() {
      for (const { chain } of fins) chain.primed = false;
      if (head) head.primed = false;
      if (tail) tail.primed = false;
    },

    // What actually resolved, for the tests: bone lookup drops names that miss
    // silently, so this is the only way to tell "two flippers" from "two
    // declared, one survived".
    finCount: fins.length,
    hasHead: !!head,
    hasTail: !!tail,
    // How many bones this rig has to put back by hand. 0 would mean the
    // anti-ratchet above is doing nothing, which on this model is a bug rather
    // than a saving — see the note on trackCoverage.
    restoredBones: posedBones.length,
  };
}
