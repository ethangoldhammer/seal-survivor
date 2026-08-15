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

// A BOSS LOOKS AT YOU. Always, from anywhere in the arena, and it turns its
// head to keep doing it rather than snapping onto you when you cross a line.
//
// Three things in the ordinary hunter profile are wrong for a boss, and each
// of them produces its own kind of snap:
//
//   THE RANGE FADE. `fadeRange`/`maxRange` exist because a shark staring
//   across the whole arena looks possessed. A boss staring across the whole
//   arena is the point — it is hunting one animal and there is nothing else in
//   the water. Left on, the head releases every time the player kites out past
//   maxRange and re-acquires on the way back in, which is a snap on a body
//   this size rather than the subtle re-aim it is on a minnow.
//
//   THE UNPRIME. applyChain drops its smoothing history whenever the weight
//   falls under 0.001, so the next solve starts AT the solved pose instead of
//   easing into it. Every full release is therefore a guaranteed pop on
//   re-acquisition. `minGate` keeps a boss's weight off the floor so the chain
//   stays primed for the whole fight, and the smoothing it holds is what
//   carries the head round.
//
//   THE INSTANT AIM. `weightLerp` and `smoothing` ease the POSE, but the
//   direction being solved for was recomputed from scratch every frame, so a
//   boss that turns around hands the solver a target that jumped 180 degrees
//   between two frames. The pose smoothing then races along the shortest arc
//   to catch up, which is fast, straight, and reads as the head being teleported
//   rather than turned. `turnRate` fixes it upstream: the direction ITSELF is
//   slewed toward where the player is, capped in radians per second, so a
//   reversal sweeps through every angle between the two instead of skipping
//   them. Undefined (the hunter default) means no cap and the old behaviour
//   exactly.
const _want = new THREE.Vector3();

// Rotate `dir` toward `want` by at most `maxStep` radians, both in the XY
// plane. Vector2-style rather than a quaternion slerp: these directions are
// flat by construction (headLook zeroes z when it builds the aim), and the
// signed angle between two 2D vectors is one atan2 rather than a quaternion
// per frame per boss.
function slewDir(dir, want, maxStep) {
  const cross = dir.x * want.y - dir.y * want.x;
  const dot = dir.x * want.x + dir.y * want.y;
  const delta = Math.atan2(cross, dot);
  if (Math.abs(delta) <= maxStep) { dir.copy(want); return; }
  const step = delta > 0 ? maxStep : -maxStep;
  const c = Math.cos(step);
  const s = Math.sin(step);
  const x = dir.x * c - dir.y * s;
  const y = dir.x * s + dir.y * c;
  dir.set(x, y, 0);
  const len = Math.hypot(x, y);
  if (len > 1e-6) dir.divideScalar(len);
}

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
  // The direction actually being solved for, which lags the true bearing to
  // the target by however long `turnRate` takes to cover the difference. Held
  // across frames — it is the whole of the anti-snap — and re-seeded rather
  // than slewed the first time a rig takes a target, so a creature does not
  // open its life sweeping its head round from +X.
  const dir = new THREE.Vector3(1, 0, 0);
  let dirPrimed = false;

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
     * @param boss  use the boss profile — CONFIG.enemyLook.boss laid over the
     *   hunter numbers. Passed per FRAME rather than fixed when the rig is
     *   built, because `isBoss` is set on the creature after it spawns and
     *   because bodies are recycled: the megalodon that was a boss last fight
     *   is an ordinary megalodon in this one, wearing the same visual.
     */
    update(dt, target, { suppressed = false, boss = false } = {}) {
      const base = CONFIG.enemyLook;
      // Spread only for the boss, so the ten hunters in the water every frame
      // keep reading the config object itself and allocate nothing.
      const cfg = boss && base.boss ? { ...base, ...base.boss } : base;
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
        _want.set(target.x - _root.x, target.y - _root.y, 0);
        const dist = _want.length();
        if (dist > 1e-4) {
          _want.divideScalar(dist);

          // THE SLEW. `dir` is what actually gets solved for; it chases the
          // true bearing at a capped rate instead of being it. Seeded outright
          // the first time (and after any reset), or a fresh boss would open
          // the fight sweeping its head round from wherever the vector
          // happened to start.
          const rate = cfg.turnRate;
          if (!dirPrimed || !(rate > 0) || !Number.isFinite(rate)) {
            dir.copy(_want);
            dirPrimed = true;
          } else {
            slewDir(dir, _want, rate * dt);
          }
          _aim.copy(dir);

          // Two independent reasons to stop caring, multiplied: too far away
          // to plausibly be tracking it, and too far round the body to reach
          // without folding the spine through itself. Both fade rather than
          // switch, so the head eases off instead of dropping the pose.
          //
          // An infinite maxRange is how the boss profile says "distance is
          // never a reason to stop looking" — smoothstep would hand back NaN
          // for it, and a NaN weight writes NaN quaternions into the skeleton,
          // which renders as the model vanishing rather than as anything that
          // looks like a bug in a look-at.
          const ranged = Number.isFinite(cfg.maxRange)
            ? 1 - smoothstep(cfg.fadeRange, cfg.maxRange, dist)
            : 1;
          // The cone gate is measured against the SLEWED direction, not the
          // true one, so the gate opens and closes at the same rate the head
          // is actually turning. Feeding it the true bearing would swing the
          // gate to 0 on the frame the player crosses behind the body while
          // the head was still pointing forward — the weight would collapse
          // out from under a pose that had not moved.
          gate = ranged * coneGate(head, cfg, _aim);
        }
      }

      // A FLOOR UNDER THE GATE, for the boss profile only (minGate is absent
      // from the hunter numbers, and 0 there is the behaviour that shipped).
      // Two jobs, and the second is the important one: it keeps the head
      // partially committed to the player even when they are directly behind —
      // the body is turning and will bring it round — and it keeps `weight`
      // off applyChain's 0.001 release threshold, which is what would drop the
      // smoothing history and guarantee a pop the next time the boss faced you.
      if (cfg.minGate > 0 && cfg.enabled && target && !suppressed) {
        gate = Math.max(gate, cfg.minGate);
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
    // easing out of one that belonged to a different creature. `dirPrimed` is
    // part of that — a recycled body must re-seed its aim direction rather
    // than slew out of the heading the last creature died on, which on the
    // boss profile's turn rate would be a visible swing on the frame it spawns.
    reset() {
      weight = 0;
      head.primed = false;
      hasWritten = false;
      dirPrimed = false;
    },

    get weight() { return weight; },

    // The direction actually being solved for — the slewed one, not the true
    // bearing to the target. Exposed for tools/boss-rig-test.mjs, and it is
    // the only place the anti-snap is measurable: the POSE cannot show it,
    // because maxBend caps the whole chain at about ten degrees a bone, so a
    // solver handed a target that jumped 180 degrees and a solver handed one
    // that swept there both produce a tip that moves a fraction of a degree
    // per frame. The jump is real and it is here.
    //
    // Live, not a copy: a test reading it every frame should not allocate, and
    // nothing in the game reads it at all.
    get aim() { return dir; },
  };
}
