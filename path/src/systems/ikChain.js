import * as THREE from 'three';

// CCD bone-chain IK — the solver, with no opinion about what is doing the
// aiming or why.
//
// Lifted wholesale out of systems/aimRig.js when the creatures needed the same
// head-look the seal already had. Nothing here changed in the move: aimRig
// still drives the seal's flippers and neck through these exact functions, and
// systems/headLook.js points shark and orca snouts with them. The comments
// below are the original ones, because they are still the reasons.
//
// The solver is CCD (cyclic coordinate descent): walk a chain from tip to
// root, and at each joint rotate so the tip swings onto the target. A few
// passes is plenty for a 3-bone chain. The target is deliberately placed
// further out than the chain can possibly reach (`reach`), which turns "put
// the tip on that point" into "straighten along the aim" — which is what
// pointing a flipper (or a snout) at something actually means.
//
// Three things keep that from tearing the skeleton apart:
//   maxBend  caps how far any ONE bone may travel from the keyframe it was
//            given. CCD left alone will happily fold a joint through the
//            body to shave off the last few degrees; this is the stop. It's
//            also what keeps the swim cycle visible in the fins instead of
//            freezing them into a rigid pointer, and on the neck it's the
//            difference between a creature looking somewhere and a creature
//            with a broken neck.
//   rootInfluence  scales how much of each pass the bones nearest the root
//            are allowed to take. Mathematically the root is the cheapest
//            place to move the tip a long way, but that reads as a shoulder
//            dislocating, so the work is pushed out toward the tip.
//   maxFold / maxTwist  where a bone may END UP, rather than how far it may
//            travel to get there. Both of the above are relative to this
//            frame's keyframe, and a clip that has already folded a joint most
//            of the way leaves the solver free to close it the rest of the way
//            — which is what pinches the skin over the joint. See the block
//            above limitJoint.
//
// Everything is then slerped: the solved pose is smoothed frame to frame
// (`smoothing`), and blended against the clip by a weight that itself eases
// in and out (`weightLerp`). There is no frame on which a bone jumps.

const AXES = {
  '+X': [1, 0, 0], '-X': [-1, 0, 0],
  '+Y': [0, 1, 0], '-Y': [0, -1, 0],
  '+Z': [0, 0, 1], '-Z': [0, 0, -1],
};

const IDENTITY = new THREE.Quaternion();

// Scratch. The solver runs every frame for every chain, several iterations
// deep — allocating in there would hand the GC a steady drip of garbage.
const _bonePos = new THREE.Vector3();
const _tipPos = new THREE.Vector3();
const _toTip = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _target = new THREE.Vector3();
const _rest = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _bw = new THREE.Quaternion();
const _pw = new THREE.Quaternion();
const _rel = new THREE.Quaternion();
const _twist = new THREE.Quaternion();
const _swing = new THREE.Quaternion();
const _clipTwist = new THREE.Quaternion();
const _clipSwing = new THREE.Quaternion();
const _clipRel = new THREE.Quaternion();
const _inv = new THREE.Quaternion();

export function axisVec(name, fallback = '+Y') {
  return new THREE.Vector3().fromArray(AXES[name] ?? AXES[fallback]);
}

// A hard clamp at `max` means a bone travels at full speed right up to the
// limit and then stops dead — on a neck that reads as the head hitting a
// wall, and it holds there rigidly for as long as the target stays out of
// range. This eases into the stop instead: below `soft` of the limit nothing
// changes at all, and past that the remaining travel is compressed onto an
// exponential that approaches `max` without ever reaching it.
//
// The two pieces meet with matching value AND matching slope at the knee, so
// there's no visible kink where the easing starts — it just quietly runs out
// of room. `soft >= 1` degenerates to the plain clamp.
export function softClamp(theta, max, soft) {
  if (theta <= 0 || max <= 0) return 0;
  if (soft >= 1) return Math.min(theta, max);
  const knee = max * soft;
  if (theta <= knee) return theta;
  const span = max - knee;
  return max - span * Math.exp(-(theta - knee) / span);
}

// --- joint limits ----------------------------------------------------------
//
// maxBend caps how far a bone may travel from its keyframe, which stops the
// solver from tearing a chain apart but says nothing about where the bone
// ENDS UP. A joint the clip has already folded to 90 degrees is one the solver
// may still push to 100 without breaking any limit it knows about, and at that
// angle the skin over the joint stops being a surface: the flipper's armpit
// closes and the mesh pinches. Measured, not guessed — tools/seal-rig-test.mjs
// skins the seal in software and reads the triangle areas.
//
// So this is an ABSOLUTE limit, in two parts, both measured from the bone's
// authored rest pose rather than from the identity (one of the seal's forearm
// bones sits at 165 degrees of twist at rest — a rig's axis convention is not
// a joint angle):
//
//   fold    how far the bone has swung off the axis it rests on.
//   twist   how far it has spun about that axis. This is the one that has no
//           business existing at all: rotating a bone about its own length
//           barely moves the tip, so it buys the solver almost nothing, and it
//           is exactly the rotation that wrings the skin out like a cloth.
//
// The rule is `never further than the animation already goes`:
//
//     out = min(in, max(clip, softClamp(in, limit)))
//
// Under the limit, nothing happens — the solver is free. Over it, the pose is
// held at whatever the CLIP does, so the guard can only ever remove something
// the solver added. It can't fight the animation, and it can't pull a bone off
// a keyframe the artist chose. A rig with no limits configured is left alone.
function angleOf(q) {
  // 2*atan2 rather than 2*acos(w): near zero rotation acos loses most of its
  // precision, and this runs on poses that are usually nearly identity.
  const s = Math.hypot(q.x, q.y, q.z);
  return 2 * Math.atan2(s, Math.abs(q.w));
}

// q = swing * twist, with twist about `axis`. Both come back normalised.
function swingTwist(q, axis, swing, twist) {
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  twist.set(axis.x * d, axis.y * d, axis.z * d, q.w);
  const l = Math.hypot(twist.x, twist.y, twist.z, twist.w);
  // A half turn perpendicular to the axis leaves no twist to speak of.
  if (l < 1e-8) twist.identity();
  else twist.set(twist.x / l, twist.y / l, twist.z / l, twist.w / l);
  swing.copy(q).multiply(_inv.copy(twist).invert());
}

// Scale a rotation's angle to `want`, keeping its axis and its direction.
function setAngle(q, want) {
  const s = Math.hypot(q.x, q.y, q.z);
  if (s < 1e-9) return; // no axis to speak of; it is already the identity
  const half = want * 0.5;
  const k = Math.sin(half) / s * (q.w < 0 ? -1 : 1);
  q.set(q.x * k, q.y * k, q.z * k, Math.cos(half));
}

// The knee is fixed rather than exposed: `softness` is a look control on how
// maxBend feels, and this is a safety stop. 0.9 keeps it out of the way until
// the pose is nearly at the limit, then eases into it over the last tenth.
const LIMIT_KNEE = 0.9;

function limitOne(angle, clipAngle, max) {
  if (max == null || max <= 0) return angle;
  return Math.min(angle, Math.max(clipAngle, softClamp(angle, max, LIMIT_KNEE)));
}

/**
 * Pull one bone's pose back inside the rig's joint limits, in place.
 *
 * `q` is the pose about to be written; `clipQ` is what the animation wrote for
 * the same bone this frame, and sets the floor — see the note above.
 */
export function limitJoint(q, clipQ, restQ, axis, cfg) {
  if (cfg.maxFold == null && cfg.maxTwist == null) return q;

  _rel.copy(restQ).invert().multiply(q);
  swingTwist(_rel, axis, _swing, _twist);
  _clipRel.copy(restQ).invert().multiply(clipQ);
  swingTwist(_clipRel, axis, _clipSwing, _clipTwist);

  const fold = angleOf(_swing);
  const twist = angleOf(_twist);
  // A degenerate solve (a zero-length axis surviving a normalise, a bone
  // scaled to nothing) reaches here as NaN, and NaN written to a bone collapses
  // every vertex weighted to it into the origin — the worst pinch of all, and
  // one no angle limit would catch, since every comparison against NaN is
  // false. The clip's own pose is always a good pose; fall back to it.
  if (!Number.isFinite(fold) || !Number.isFinite(twist)) return q.copy(clipQ);

  const foldOut = limitOne(fold, angleOf(_clipSwing), cfg.maxFold);
  const twistOut = limitOne(twist, angleOf(_clipTwist), cfg.maxTwist);
  if (foldOut === fold && twistOut === twist) return q;

  setAngle(_swing, foldOut);
  setAngle(_twist, twistOut);
  return q.copy(restQ).multiply(_swing).multiply(_twist).normalize();
}

export function smoothstep(edge0, edge1, x) {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// The tip is a point PAST the last bone, not the last bone's own origin —
// `hand_L_014` sits at the wrist, and a bullet born at the wrist looks like
// it's coming out of the seal's elbow. tipLength walks the rest of the way
// down the bone's own length axis to the end of the flipper. Same trick puts
// a head chain's effector out at the snout instead of inside the skull.
export function tipWorld(chain, out, lengthMul = 1) {
  out.copy(chain.tipAxis).multiplyScalar(chain.tipLength * lengthMul);
  return chain.tip.localToWorld(out);
}

/**
 * Resolve the bone NAMES between a root and a tip, inclusive.
 *
 * Walking a single-child run beats listing every bone in assets.js: the
 * octopus's six arms are 19 bones each, and 114 hand-typed names is 114
 * chances to typo one and get a chain that silently resolves short.
 *
 * Walks UP from the tip rather than down from the root: a bone has one parent
 * but may have several children, so the upward walk stays unambiguous even if
 * the rig later grows a branch. Returns null (having warned) when either end
 * is missing or the tip turns out not to be under the root at all — every
 * caller treats that as "this limb doesn't move".
 */
export function boneRun(instance, rootName, tipName, label) {
  const root = instance.getObjectByName(rootName);
  const tip = instance.getObjectByName(tipName);
  if (!root || !tip) {
    console.warn(`[ikChain] ${label}: could not find ${!root ? rootName : tipName} — this limb will not move.`);
    return null;
  }

  const names = [];
  let cur = tip;
  while (cur && cur !== root) {
    names.unshift(cur.name);
    cur = cur.parent;
    if (names.length > 64) break; // a cycle, or the tip isn't under this root
  }
  if (cur !== root) {
    console.warn(`[ikChain] ${label}: ${tipName} is not a descendant of ${rootName} — this limb will not move.`);
    return null;
  }
  names.unshift(root.name);
  return names;
}

/**
 * @param minBones  the shortest chain worth solving. Two for a limb: one bone
 *   is a hinge, there's nothing for CCD to distribute across, and a one-bone
 *   "chain" is almost certainly a typo in the bone list rather than a
 *   deliberate rig. A head-look passes 1 on purpose — plenty of creature rigs
 *   have a skull hanging straight off the spine with no neck between, and
 *   rotating that single bone IS the whole gesture.
 */
export function buildChain(instance, def, fallbackTipAxis, label, minBones = 2) {
  const bones = (def.bones ?? []).map((n) => instance.getObjectByName(n)).filter(Boolean);
  if (bones.length < minBones) {
    console.warn(`[ikChain] ${label} resolved ${bones.length} of ${def.bones?.length ?? 0} bones — skipping it.`);
    return null;
  }
  const n = bones.length;
  return {
    name: def.name ?? label,
    bones,
    tip: bones[n - 1],
    tipAxis: axisVec(def.tipAxis ?? fallbackTipAxis),
    tipLength: def.tipLength ?? 0,
    // The pose the model was authored in. Captured here because here is the
    // only moment it is on the bones: the chain is built straight after the
    // instance is cloned, before any mixer has run. Every joint limit is
    // measured from these — see limitJoint.
    restQ: bones.map((b) => b.quaternion.clone()),
    // Four parallel poses per bone: what the animation handed us this frame,
    // what the solver wants, the smoothed value actually applied, and the
    // value we wrote last frame (see restoreReference).
    animQ: Array.from({ length: n }, () => new THREE.Quaternion()),
    solvedQ: Array.from({ length: n }, () => new THREE.Quaternion()),
    smoothQ: Array.from({ length: n }, () => new THREE.Quaternion()),
    wroteQ: Array.from({ length: n }, () => new THREE.Quaternion()),
    hasWritten: false, // does wroteQ hold a real pose yet?
    primed: false, // does smoothQ hold a real pose yet?
    point: new THREE.Vector3(), // this chain's tip, in world space
  };
}

// A point somewhere ALONG a chain rather than at its tip: `s` is 0 at the root
// joint and 1 at the tip point tipWorld returns. For emitters that should trail
// a whole limb — the seal's tail wake — instead of firing out of one spot.
//
// Walked by ARC LENGTH, not by joint index. The seal's tail is one long bone
// into two short ones — measured at rest, the three segments run roughly
// 0.44 : 0.10 : 0.16 — so stepping per joint would put two thirds of an even
// spread inside the last quarter of the tail and leave the long root bone bare.
//
// Nothing is cached: bone world matrices are whatever the last pose left, which
// is the point — a lagging tail's samples lag with it.
const _nodeA = new THREE.Vector3();
const _nodeB = new THREE.Vector3();

// Node i of the chain's polyline: the bones' own origins, then the tip past the
// last one.
function chainNode(chain, i, out) {
  return i < chain.bones.length
    ? chain.bones[i].getWorldPosition(out)
    : tipWorld(chain, out, 1);
}

export function chainPoint(chain, s, out) {
  const n = chain.bones.length; // ...and n + 1 nodes, counting the tip

  let total = 0;
  chainNode(chain, 0, _nodeA);
  for (let i = 1; i <= n; i++) {
    total += _nodeA.distanceTo(chainNode(chain, i, _nodeB));
    _nodeA.copy(_nodeB);
  }
  if (total < 1e-6) return chainNode(chain, 0, out); // a chain collapsed to a point

  const want = Math.min(1, Math.max(0, s)) * total;
  let walked = 0;
  chainNode(chain, 0, _nodeA);
  for (let i = 1; i <= n; i++) {
    chainNode(chain, i, _nodeB);
    const len = _nodeA.distanceTo(_nodeB);
    // `i === n` catches the tip exactly, and covers float drift putting the
    // last segment's end a hair short of the total we measured a moment ago.
    if (walked + len >= want || i === n) {
      const t = len > 1e-6 ? (want - walked) / len : 0;
      return out.copy(_nodeA).lerp(_nodeB, Math.min(1, Math.max(0, t)));
    }
    walked += len;
    _nodeA.copy(_nodeB);
  }
  return out;
}

// Total length of a chain in world units, out to its tip point. Measured
// every frame rather than configured or cached: it survives the `fit` scale,
// the per-asset size slider, a model swap, and clips that animate bone
// translation (the seal's do — a cached first-frame measurement came out 33%
// different between the left and right flipper).
export function measureReach(chain, tipMul) {
  let total = 0;
  for (let i = 0; i < chain.bones.length - 1; i++) {
    chain.bones[i].getWorldPosition(_bonePos);
    chain.bones[i + 1].getWorldPosition(_tipPos);
    total += _bonePos.distanceTo(_tipPos);
  }
  chain.tip.getWorldPosition(_bonePos);
  return total + _bonePos.distanceTo(tipWorld(chain, _tipPos, tipMul));
}

export function solveChain(chain, target, cfg, tipMul) {
  const bones = chain.bones;
  const n = bones.length;
  const tolSq = (cfg.tolerance ?? 0.01) ** 2;

  for (let it = 0; it < cfg.iterations; it++) {
    // Tip-to-root: the joints nearest the tip do the fine aiming and the ones
    // nearer the shoulder only clean up what's left.
    for (let i = n - 1; i >= 0; i--) {
      const bone = bones[i];
      bone.getWorldPosition(_bonePos);
      tipWorld(chain, _tipPos, tipMul);
      _toTip.subVectors(_tipPos, _bonePos);
      _toTarget.subVectors(target, _bonePos);
      const lenTip = _toTip.length();
      const lenTarget = _toTarget.length();
      // A joint sitting exactly on the tip (or on the target) has no axis to
      // rotate about; skip it rather than feeding a zero vector into
      // setFromUnitVectors and getting a garbage quaternion back.
      if (lenTip < 1e-6 || lenTarget < 1e-6) continue;
      _toTip.divideScalar(lenTip);
      _toTarget.divideScalar(lenTarget);
      _q.setFromUnitVectors(_toTip, _toTarget);

      const influence = n > 1
        ? cfg.rootInfluence + (1 - cfg.rootInfluence) * (i / (n - 1))
        : 1;
      if (influence < 1) _q.slerp(IDENTITY, 1 - influence);

      // World-space delta -> this bone's local space, the only place we're
      // allowed to write.
      bone.getWorldQuaternion(_bw);
      _q.multiply(_bw);
      if (bone.parent) {
        bone.parent.getWorldQuaternion(_pw);
        _q.premultiply(_pw.invert());
      }
      bone.quaternion.copy(_q).normalize();
      // Descendants have to follow before the next joint measures the tip,
      // otherwise every iteration solves against a stale effector.
      bone.updateMatrixWorld(true);
    }
    if (tipWorld(chain, _tipPos, tipMul).distanceToSquared(target) < tolSq) break;
  }
}

// How much this chain is allowed to care about the aim, given where the aim
// is relative to the direction the chain naturally faces. 1 everywhere for a
// chain with no cone configured.
//
// This is the "don't reach around behind you" rule. A neck asked to point at
// something on the far side of the body has no good answer: CCD will happily
// fold it back through the shoulders, because that genuinely is the shortest
// path to the target, and the result is a head buried in its own chest. So
// past `frontCone` the chain progressively stops trying, and past `backCone`
// it has handed the pose back to the animation entirely — the creature simply
// doesn't look behind itself, which is also what a real one does. It turns
// its whole body instead, and the body is already turning, so the head picks
// the aim back up as the turn brings it round.
//
// Measured against the chain's PARENT, not against the chain itself. The
// parent is a bone this system never writes, so the reference direction can't
// drift with our own output — using the chain's current facing would ratchet:
// turn a little, decide "forward" is the new heading, turn a little more.
export function coneGate(chain, cfg, aim) {
  if (cfg.frontCone == null || cfg.backCone == null) return 1;
  const parent = chain.bones[0].parent;
  if (!parent) return 1;
  parent.updateWorldMatrix(true, false);
  parent.getWorldQuaternion(_pw);
  _rest.copy(chain.tipAxis).applyQuaternion(_pw);
  const len = Math.hypot(_rest.x, _rest.y);
  if (len < 1e-6) return 1; // facing straight at the camera: no side to be on
  const dot = (_rest.x * aim.x + _rest.y * aim.y) / len;
  const angle = Math.acos(Math.min(1, Math.max(-1, dot)));
  return 1 - smoothstep(cfg.frontCone, cfg.backCone, angle);
}

// ANTI-RATCHET. Put back the pose we were handed last frame, for any bone that
// still holds exactly what we wrote to it.
//
// Everything in applyChainToPoint is measured against "the pose the animation
// wrote this frame" — maxBend caps travel from it, limitJoint uses it as the
// floor, and the weight blends back toward it. That is only what is on the
// bone if the mixer actually wrote the bone. It very often does not:
//
//   - A track with ONE keyframe is a constant, and three.js stops writing a
//     value that has not changed. The seal's `swim` keys neck01_05 exactly
//     once (systems/breathe.js documents the same trap from the other side).
//   - So does a track whose keys HOLD. `water_idle` — the clip on the title
//     card and every moment the player stops — has 81 keys on head_07 of which
//     74 intervals repeat the previous value, in runs up to 13 keys long. The
//     mixer skips the write across every one of those runs, so it touches the
//     skull on 14% of frames.
//   - And a rig may ship no clips at all (shark.glb), which is the case
//     systems/headLook.js hit first.
//
// A bone nothing else writes still holds LAST frame's solver output, so the
// reference becomes our own previous answer and the chain walks. Measured on
// the seal before this guard: the head swung 10.9 degrees peak-to-peak in idle
// with the cursor dead still, in single-frame snaps of 10.7 degrees — a
// twitch, on the pose the player looks at while reading the title card.
//
// IT IS NOT THE BEND CAP THAT WALKS IT, which is worth knowing because the cap
// is the first thing anyone reaches for. maxBend and the joint limits are two
// of three things measured from the reference, and they are the two that
// barely matter: with the guard off, turning maxBend up to 10 radians AND
// maxFold/maxTwist off entirely moves the snap from 10.666 to 10.660 degrees,
// and halving maxBend moves it to 10.166. The joint limits were never even
// reached.
//
// The third consumer is the one that does the walking — the blend at the
// bottom of applyChainToPoint, `animQ.slerp(smoothQ, weight)`. At the seal's
// idleWeight of 0.5 HALF the written pose is the reference itself, so a stale
// reference means the bone moves halfway to the solved pose, that becomes next
// frame's reference, and it moves halfway again: a geometric creep that needs
// no clamp at all to exist. (Forcing weight to 1 cuts the snap to 7.8 degrees
// and no further — removing half the loop is not removing the loop.) So there
// is no tuning value that fixes this and none that hides it; the reference has
// to be right.
//
// Exact equality is the right test, not a tolerance: a mixer writing this bone
// produces its own value, and an untouched bone still holds the exact float we
// stored. A clip that happened to key a bone to precisely our last output
// would be restored one frame stale, which is the same value it already held,
// so nothing moves.
function restoreReference(chain) {
  if (!chain.hasWritten) return;
  const bones = chain.bones;
  for (let i = 0; i < bones.length; i++) {
    if (bones[i].quaternion.equals(chain.wroteQ[i])) bones[i].quaternion.copy(chain.animQ[i]);
  }
}

// Solve one chain and blend the result over the clip. `weight` is already
// eased by the caller; this only ever writes bones belonging to `chain`.
export function applyChain(chain, dt, cfg, weight, tipMul, dir) {
  // Each chain aims from its OWN root, not from the body's centre. A shared
  // target would drag both flippers onto one line through the body; from
  // their own roots they stay where they're attached and both point
  // downrange.
  chain.bones[0].updateWorldMatrix(true, true);
  chain.bones[0].getWorldPosition(_bonePos);
  _target.copy(dir).multiplyScalar(measureReach(chain, tipMul) * cfg.reach).add(_bonePos);
  applyChainToPoint(chain, dt, cfg, weight, tipMul, _target);
}

/**
 * Reach for an absolute world POINT rather than a direction at a fixed
 * distance. Same solve, same clamp, same smoothing — only where the target
 * comes from differs.
 *
 * The direction form above suits a fin: "point downrange", where downrange is
 * infinitely far away and the limb just straightens along it. A tentacle
 * grabbing a specific fish is the other problem — the target is a real place,
 * it is usually INSIDE the chain's reach rather than beyond it, and the arm
 * has to stop there rather than straightening through it. Expressing that as
 * a direction would mean recovering the distance the caller already knew and
 * throwing away the difference.
 *
 * `weight` is what makes this additive: 0 leaves the bones exactly as the clip
 * (or, on a rig with no clips, the bind pose) left them, 1 hands them fully to
 * the solver, and anything between blends the two. So an arm easing its weight
 * up from 0 visibly reaches out of its resting pose toward the target.
 */
export function applyChainToPoint(chain, dt, cfg, weight, tipMul, target) {
  const bones = chain.bones;
  const n = bones.length;

  // Everything below reads world transforms, and the mixer only wrote LOCAL
  // ones — without this the whole solve is a frame late, which on a
  // fast-turning body is a visibly lagging limb. Per chain, since the
  // flippers and the neck are sibling branches off the chest: refreshing one
  // leaves the others stale.
  bones[0].updateWorldMatrix(true, true);

  // ANTI-RATCHET, then the snapshot. Both before anything reads these bones.
  restoreReference(chain);
  // What the animation handed us: what we blend back toward, and the reference
  // maxBend is measured against.
  for (let i = 0; i < n; i++) chain.animQ[i].copy(bones[i].quaternion);

  if (weight > 0.001) {
    solveChain(chain, target, cfg, tipMul);

    const soft = cfg.softness ?? 1;
    for (let i = 0; i < n; i++) {
      // Per bone: how far the solver wants to move it, eased down to what
      // it's allowed. rotateTowards along the same arc, so the direction of
      // the correction is preserved and only its magnitude is limited.
      const wanted = chain.animQ[i].angleTo(bones[i].quaternion);
      const allowed = softClamp(wanted, cfg.maxBend, soft);
      chain.solvedQ[i].copy(chain.animQ[i]).rotateTowards(bones[i].quaternion, allowed);
      // ...and then back inside the joint's own limits, which maxBend knows
      // nothing about. Before the smoothing, so the pose eases into the stop
      // rather than arriving at it.
      limitJoint(chain.solvedQ[i], chain.animQ[i], chain.restQ[i], chain.tipAxis, cfg);
    }

    if (!chain.primed) {
      for (let i = 0; i < n; i++) chain.smoothQ[i].copy(chain.solvedQ[i]);
      chain.primed = true;
    } else {
      const t = 1 - Math.exp(-cfg.smoothing * dt);
      for (let i = 0; i < n; i++) chain.smoothQ[i].slerp(chain.solvedQ[i], t);
    }

    for (let i = 0; i < n; i++) {
      bones[i].quaternion.copy(chain.animQ[i]).slerp(chain.smoothQ[i], weight);
      // Again on the pose that is actually written. The two ends of that slerp
      // are both legal, so this almost never has anything to do — but "almost
      // never" is not the guarantee worth making about a mesh that pinches.
      limitJoint(bones[i].quaternion, chain.animQ[i], chain.restQ[i], chain.tipAxis, cfg);
    }
  } else {
    // Fully released: the clip owns these bones again, and the next solve
    // starts fresh rather than slerping out of a stale pose. The restore above
    // is what actually hands them back on a bone the mixer has stopped
    // writing — without it a released chain leaves its last solved pose on the
    // skeleton for good.
    chain.primed = false;
  }

  // What we are leaving on the bones, which is next frame's test for whether
  // anything else has had a say. Recorded even when released: at zero weight
  // that is the restored pose, so the comparison stays true and the restore
  // above keeps holding the bone at the animation's value rather than letting
  // our last output sit there.
  for (let i = 0; i < n; i++) chain.wroteQ[i].copy(bones[i].quaternion);
  chain.hasWritten = true;

  // The tip point tracks whatever pose won — with the IK off it simply
  // follows the animation, which is the honest answer to "where is the end of
  // this limb".
  bones[0].updateWorldMatrix(false, true);
  tipWorld(chain, chain.point, tipMul);
}
