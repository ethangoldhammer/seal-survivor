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
//
// THE FLOOR (optional, `update`'s fourth argument) is a world-space horizontal
// plane no bone tip may pass through. It exists for a ragdoll lying on the
// seabed: gravity is fed to a limp chain as a downward impulse every frame and
// with nothing to stop it the limbs hang straight through the sand — and then
// whatever rests the BODY on its lowest vertex stands the corpse up on those
// limbs. The clamp is a contact, not a spring: the tip is rotated up to the
// plane about its root, the velocity into the plane is dropped so the next
// frame's gravity does not accumulate, and the velocity along it is bled by
// `friction` so a limb lying on sand comes to rest instead of skating. It is
// applied to the spring's own state (so its memory lies on the floor) AND to
// the direction finally written after `maxLag` (so a frozen pose that points
// into the sand cannot pull the bone back under through the lag cap).
//
// A BONE HAS FLESH ON IT. A floor that stops the bone's tip stops nothing the
// player can see: the seal's head is a unit of skull around a bone tip that
// sits a third of a unit above the sand while the chin is under it — and the
// body, resting on its lowest VERTEX, then stood up on its own head. So each
// bone carries a radius (see measureRadii): the furthest any vertex it skins
// sits from the bone's own segment, as a ratio of the bone's length so it
// survives whatever the model is scaled by. The tip is held that far above the
// plane, which puts the skin on the sand rather than the bone.

const _bonePos = new THREE.Vector3();
const _tipPos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _fin = new THREE.Vector3();
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

// Rotate a unit direction up about its root until a tip `len` along it sits on
// the plane y = floorY, if it was under. Returns true if it had to. The
// horizontal heading is kept, so a limb pushed up by the sand lies along the
// way it was already pointing rather than swinging round; a root that is
// itself under the plane (`minY >= 1`, nowhere to point but up) gets straight
// up, which is the only direction that does not go deeper.
function floorDir(d, rootY, len, floorY) {
  const minY = (floorY - rootY) / len;
  if (d.y >= minY) return false;
  if (minY >= 1) {
    d.set(0, 1, 0);
    return true;
  }
  const h = Math.sqrt(1 - minY * minY);
  const flat = Math.hypot(d.x, d.z);
  if (flat < 1e-6) d.set(h, minY, 0);
  else d.set((d.x / flat) * h, minY, (d.z / flat) * h);
  return true;
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
  // Flesh per bone, as a ratio of the bone's length — null until measured, and
  // a chain nobody has measured is held by its bare tips. See measureRadii.
  let radii = null;

  return {
    bones,

    reset() {
      primed = false;
      for (const v of vel) v.set(0, 0, 0);
    },

    /**
     * HOW MUCH FLESH IS ON EACH BONE, read off the skin — see the floor note
     * at the top. For every vertex of the given skinned meshes whose heaviest
     * weight is one of this chain's bones (or, for the last bone, the end
     * reference it points at), the distance from the vertex to that bone's
     * segment; the furthest one is the bone's radius. Measured in whatever
     * pose the mesh is holding, in world space, and stored as a ratio of the
     * bone's length in the same space, so it is right at any scale.
     *
     * A hundred-odd vertices times a handful of bones, once per body — cheap,
     * but not free per frame, which is why it is a call and not part of
     * update(). Idempotent: call it when a floor is first needed.
     *
     * @param meshes SkinnedMeshes over this skeleton. Anything else is skipped.
     * @returns the ratios, one per driven bone — for the harness.
     */
    measureRadii(meshes) {
      const out = new Float32Array(n);
      const root = bones[0];
      let top = root;
      while (top.parent) top = top.parent;
      top.updateMatrixWorld(true);
      // Bone index in each skeleton → position in this chain, or -1.
      const rootP = Array.from({ length: n }, () => new THREE.Vector3());
      const tipP = Array.from({ length: n }, () => new THREE.Vector3());
      const lenW = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        rootP[i].setFromMatrixPosition(bones[i].matrixWorld);
        if (i < n - 1) tipP[i].copy(bones[i + 1].position).applyMatrix4(bones[i].matrixWorld);
        else if (tipChild) tipP[i].copy(tipChild.position).applyMatrix4(bones[i].matrixWorld);
        else tipP[i].copy(tipAxis).multiplyScalar(tipLength).applyMatrix4(bones[i].matrixWorld);
        lenW[i] = rootP[i].distanceTo(tipP[i]);
      }
      const v = new THREE.Vector3();
      const seg = new THREE.Vector3();
      const rel = new THREE.Vector3();
      for (const mesh of meshes ?? []) {
        if (!mesh?.isSkinnedMesh || !mesh.skeleton) continue;
        const slot = mesh.skeleton.bones.map((b) => {
          const at = bones.indexOf(b);
          if (at >= 0) return at;
          return tipChild && b === tipChild ? n - 1 : -1;
        });
        if (!slot.some((s) => s >= 0)) continue;
        const si = mesh.geometry.attributes.skinIndex;
        const sw = mesh.geometry.attributes.skinWeight;
        const count = mesh.geometry.attributes.position.count;
        if (!si || !sw) continue;
        for (let k = 0; k < count; k++) {
          let best = -1;
          let bw = 0;
          for (let c = 0; c < 4; c++) {
            const w = sw.getComponent(k, c);
            if (w > bw) { bw = w; best = si.getComponent(k, c); }
          }
          const i = best >= 0 ? slot[best] : -1;
          if (i < 0 || !(lenW[i] > 1e-6)) continue;
          mesh.getVertexPosition(k, v).applyMatrix4(mesh.matrixWorld);
          // Distance to the segment root..tip.
          seg.subVectors(tipP[i], rootP[i]);
          rel.subVectors(v, rootP[i]);
          const t = Math.max(0, Math.min(1, rel.dot(seg) / seg.lengthSq()));
          const d = rel.addScaledVector(seg, -t).length();
          if (d > out[i]) out[i] = d;
        }
      }
      for (let i = 0; i < n; i++) out[i] = lenW[i] > 1e-6 ? out[i] / lenW[i] : 0;
      radii = out;
      return out;
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
     * @param floor  optional { y, friction } — a world-space plane no bone tip
     *               may pass below (see the note at the top). `friction` is
     *               e-folds per second taken off the velocity ALONG the plane
     *               while a bone is on it. Null, the default, is open water.
     */
    // Hot path: this runs per creature per frame, and CONFIG.spawn.maxAlive is
    // in the hundreds. It maintains its OWN running world transform down the
    // chain (`_pm`/`_pq`) rather than leaning on Object3D's helpers, because
    // those are quadratic here — getWorldPosition/getWorldQuaternion each
    // re-walk all 13 levels of ancestors, and updateMatrixWorld(true) recurses
    // the whole subtree, which on a 40-bone shark means re-solving every fin
    // branch once per spine bone. As written it measures ~7.6us per shark,
    // 1.8% of a 60fps frame at 40 of them.
    update(dt, cfg, weight, floor = null) {
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

        // THE FLOOR, on the spring's own memory: the tip is held on the plane
        // and the velocity that was carrying it through is dropped, or the
        // gravity impulse fed in every frame piles up under the sand and the
        // limb is a coiled spring the moment anything lifts it.
        // The plane is lifted by the flesh on this bone, so the skin meets it.
        const floorY = floor ? floor.y + (radii ? radii[i] * len : 0) : 0;
        if (floor && floorDir(state, _bonePos.y, len, floorY)) {
          if (v.y < 0) v.y = 0;
          if (floor.friction > 0) {
            const keep = Math.exp(-floor.friction * dt);
            v.x *= keep;
            v.z *= keep;
          }
        }

        const lag = _dir.angleTo(state);
        _q.setFromUnitVectors(_dir, state);
        _qc.copy(IDENTITY).rotateTowards(_q, softClamp(lag, cfg.maxLag, soft));
        // ...and on what is actually written. `maxLag` is measured from the
        // pose the chain is pulled toward, and a corpse's frozen pose can point
        // a limb straight into the seabed: the cap would then hold the bone
        // partway back under the plane the clamp above just lifted it out of.
        // The sand wins over the lag cap, because the sand is solid.
        if (floor) {
          _fin.copy(_dir).applyQuaternion(_qc);
          if (floorDir(_fin, _bonePos.y, len, floorY)) _qc.setFromUnitVectors(_dir, _fin);
        }

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
