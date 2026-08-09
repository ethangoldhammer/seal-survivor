import * as THREE from 'three';

// Damped-spring secondary motion for a bone chain — the shared implementation
// behind the seal's tail and the flopping of any creature whose model shipped
// without animation.
//
// It is NOT IK. Nothing here aims at a target. Each bone's direction is handed
// to a spring that chases wherever the pose already put it, so the chain
// declines to keep up: a turn leaves it behind for a moment and it overshoots
// slightly settling back. Whatever wrote the pose first — an AnimationMixer
// clip, a procedural sine wave, or nothing at all — is the spring's target, so
// the same solver adds lag to an authored animation and supplies the entire
// motion for a model that has none.
//
// Three details make it flow rather than wobble:
//
//   - Bones solve root-to-tip and each measures its target AFTER its parent
//     has already been displaced, so lag accumulates into a travelling wave
//     down the chain instead of every bone lagging the same amount.
//   - `tipLooseness` softens the spring toward the tip so the far end trails
//     furthest. Damping is scaled by the square root of the same factor,
//     which holds the damping RATIO constant — otherwise the loose end rings
//     like a struck spring while the stiff base sits dead.
//   - `maxLag` caps how far a bone may travel from its target pose, eased
//     into via `softness` rather than clamped, so nothing snaps taut.
//
// An impulse (see `impulse`) is injected straight into the spring velocities.
// That's the whole trick behind hit reactions: there's no separate flinch
// system, a hit just shoves the chain and the existing spring carries the
// shove down the body and settles it.

const _bonePos = new THREE.Vector3();
const _tipPos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _accel = new THREE.Vector3();
const _perp = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qc = new THREE.Quaternion();
const _bw = new THREE.Quaternion();
const _pwInv = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _pm = new THREE.Matrix4();
const IDENTITY = new THREE.Quaternion();

// Same soft knee the IK chains use for their bend limits: linear below
// `soft` of the cap, then compressed onto an exponential that approaches the
// cap without reaching it. Value and slope match at the knee, so there's no
// kink where the easing starts.
function softClamp(theta, max, soft) {
  if (theta <= 0 || max <= 0) return 0;
  if (soft >= 1) return Math.min(theta, max);
  const knee = max * soft;
  if (theta <= knee) return theta;
  const span = max - knee;
  return max - span * Math.exp(-(theta - knee) / span);
}

/**
 * @param bones  the chain, root first. Needs at least 2.
 * @param opts   tipAxis / tipLength describe where the LAST bone points when
 *               it has no child to aim at (most rigs end on a leaf bone).
 */
export function createBoneSpring(bones, { tipAxis = new THREE.Vector3(0, 1, 0), tipLength = 0 } = {}) {
  if (!bones || bones.length < 2) return null;
  const n = bones.length;
  // A trailing "_end" bone is a direction reference, not something to rotate:
  // the last DRIVEN bone still needs to know which way it points.
  const tipChild = bones[n - 1].children.find((c) => c.isBone) ?? null;

  const animQ = Array.from({ length: n }, () => new THREE.Quaternion());
  const dir = Array.from({ length: n }, () => new THREE.Vector3());
  const vel = Array.from({ length: n }, () => new THREE.Vector3());
  let primed = false;

  return {
    bones,

    reset() {
      primed = false;
      for (const v of vel) v.set(0, 0, 0);
    },

    /**
     * Shove the chain. `dirWorld` is the direction the hit came FROM travelling
     * toward the body; the chain is kicked along it. Strength ramps toward the
     * tip, because that's the end with the least inertia holding it in place —
     * and because a body whose nose whips as hard as its tail reads as a
     * cardboard cutout being shaken.
     */
    impulse(dirWorld, strength, tipBias = 1) {
      if (!(strength > 0)) return;
      for (let i = 0; i < n; i++) {
        const t = n > 1 ? i / (n - 1) : 1;
        const ramp = 1 - tipBias + tipBias * t;
        // Only the component perpendicular to the bone can bend it; pushing
        // along its own length just compresses a rigid segment and does
        // nothing, so projecting it out keeps `strength` meaning the same
        // thing regardless of which way the creature happens to be facing.
        _perp.copy(dirWorld).addScaledVector(dir[i], -dirWorld.dot(dir[i]));
        if (_perp.lengthSq() < 1e-8) continue;
        vel[i].addScaledVector(_perp.normalize(), strength * ramp);
      }
    },

    /**
     * @param cfg    { stiffness, damping, tipLooseness, maxLag, softness, snapAngle }
     * @param weight 0..1 blend of the lagged pose over whatever wrote the pose
     */
    // Hot path: this runs per creature per frame, and CONFIG.spawn.maxAlive is
    // in the hundreds. It maintains its OWN running world transform down the
    // chain (`_pm`/`_pq`) rather than leaning on Object3D's helpers, because
    // those are quadratic here — getWorldPosition/getWorldQuaternion each
    // re-walk all 13 levels of ancestors, and updateMatrixWorld(true) recurses
    // the whole subtree, which on a 40-bone shark means re-solving every fin
    // branch once per spine bone. As written it measures ~7.6us per shark,
    // 1.8% of a 60fps frame at 40 of them.
    update(dt, cfg, weight) {
      const chainParent = bones[0].parent;
      if (chainParent) chainParent.updateWorldMatrix(true, false);

      if (weight <= 0.001 || dt <= 0) {
        primed = false;
        return;
      }

      for (let i = 0; i < n; i++) animQ[i].copy(bones[i].quaternion);

      const soft = cfg.softness ?? 1;
      const snapDot = Math.cos(cfg.snapAngle ?? Math.PI);

      // Running parent transform, advanced one bone at a time.
      if (chainParent) {
        _pm.copy(chainParent.matrixWorld);
        chainParent.getWorldQuaternion(_pq);
      } else {
        _pm.identity();
        _pq.identity();
      }

      for (let i = 0; i < n; i++) {
        const bone = bones[i];
        bone.updateMatrix();
        bone.matrixWorld.multiplyMatrices(_pm, bone.matrix);

        _bonePos.setFromMatrixPosition(bone.matrixWorld);
        // Where this bone points: at its child, or — on the last one — at the
        // tip offset. Either way it's a LOCAL offset pushed through the world
        // matrix we just built, so no extra tree work.
        if (i < n - 1) _tipPos.copy(bones[i + 1].position).applyMatrix4(bone.matrixWorld);
        else if (tipChild) _tipPos.copy(tipChild.position).applyMatrix4(bone.matrixWorld);
        else _tipPos.copy(tipAxis).multiplyScalar(tipLength).applyMatrix4(bone.matrixWorld);

        _dir.subVectors(_tipPos, _bonePos);
        const len = _dir.length();
        if (len < 1e-6) {
          _pq.multiply(bone.quaternion);
          _pm.copy(bone.matrixWorld);
          continue;
        }
        _dir.divideScalar(len);

        const state = dir[i];
        const v = vel[i];
        if (!primed || state.dot(_dir) < snapDot) {
          // First frame, or the creature teleported / flipped its facing.
          // There's no sensible spring path across a jump that large, so snap
          // rather than sling the whole body round through itself.
          state.copy(_dir);
          v.set(0, 0, 0);
        }

        const t = n > 1 ? i / (n - 1) : 0;
        const k = cfg.stiffness * (1 - cfg.tipLooseness * t);
        const c = cfg.damping * Math.sqrt(Math.max(0.05, k / cfg.stiffness));

        _accel.subVectors(_dir, state).multiplyScalar(k).addScaledVector(v, -c);
        v.addScaledVector(_accel, dt);
        state.addScaledVector(v, dt).normalize();

        const lag = _dir.angleTo(state);
        _q.setFromUnitVectors(_dir, state);
        _qc.copy(IDENTITY).rotateTowards(_q, softClamp(lag, cfg.maxLag, soft));

        // World-space delta -> this bone's local space, using the running
        // parent quaternion instead of another ancestor walk.
        _bw.copy(_pq).multiply(bone.quaternion);
        _qc.multiply(_bw);
        _pwInv.copy(_pq).invert();
        _qc.premultiply(_pwInv).normalize();
        bone.quaternion.copy(animQ[i]).slerp(_qc, weight);

        // Advance the running transform onto the pose we just wrote, so the
        // next bone measures against it. That's what turns per-bone lag into a
        // wave travelling along the body.
        bone.updateMatrix();
        bone.matrixWorld.multiplyMatrices(_pm, bone.matrix);
        _pm.copy(bone.matrixWorld);
        _pq.multiply(bone.quaternion);
      }

      primed = true;
    },
  };
}
