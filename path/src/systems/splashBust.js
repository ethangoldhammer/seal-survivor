import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { setOutlineThicknessOn } from '../assets.js';

// THE BUST — an alternate title treatment: the seal held UPRIGHT and cropped at
// the waist, filling the frame like a character portrait, with the head and the
// front flippers the only things that move.
//
// It is deliberately not systems/titleSeal.js. That shot is the run's camera
// pushed in on the run's seal, swimming in the run's ocean, and the whole
// animal turns to face the cursor. This one is a PORTRAIT: the animal is
// planted, the frame never moves, and the performance is the neck and the
// flippers alone.
//
// WHAT IT REUSES, and it is nearly everything. The rig is systems/aimRig.js —
// the same neck and flipper IK, the same cone gate, the same peek toward the
// viewer when the cursor goes somewhere a neck cannot follow. The mixer still
// plays `water_idle` over the top, so the chest still breathes. This file adds
// only two things:
//
//   1. THE PIN. Everything from the waist bone down is written back to the pose
//      the model was authored in, every frame, after the rig has run. The tail
//      does not swing, the hind flippers do not paddle, and the whole-body bob
//      in the clip does not slide the animal around inside a frame this tight.
//      See pinBust below for why it is after the rig and not before.
//   2. THE CROP. `measureBust` measures where the upper body actually is by
//      SKINNING it — not by reading bone positions, which say nothing about
//      where the silhouette ends — and fitBustCamera composes an orthographic
//      frame on that box.
//
// UPRIGHT IS THE DEFAULT ORIENTATION, not a rotation this file applies.
// createVisual leaves a side-view creature pointing world +Y with its flank to
// the camera (see orientationQuaternion in assets.js), which is exactly a seal
// standing up in profile. The game's `faceMotion` is what normally spins that
// to a heading; a bust simply never does. `lean` is the only cant, and it is
// applied by the caller to the holder, not here.
//
// NOTHING IN HERE TOUCHES THE PLAYER. It takes an instance and poses it, so it
// works equally on the run's seal and on a throwaway one built for a menu — and
// so tools/looks/splash-bust.js can drive it with no game running at all.

const _v = new THREE.Vector3();
const _skinned = new THREE.Vector3();
// Scratch for the world-space pin — see apply().
const _want = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _inv = new THREE.Matrix4();

/**
 * Build the pin for one seal instance.
 *
 * `pinFrom` is the bone the bottom half hangs off — `tail00_019` on the
 * furseal, which is the first child of `chest_04` going aft, so its subtree is
 * the tail and both hind flippers and nothing else. Everything in that subtree
 * is captured HERE, before any mixer has run, which is the only moment the
 * authored pose is on the bones (buildChain in systems/ikChain.js captures its
 * rest quaternions at the same moment and for the same reason).
 *
 * Returns null when the bone does not resolve, and warns — a model with no
 * waist is a model this treatment does not apply to, not a crash inside a
 * frame loop.
 */
export function createBustPin(instance, { pinFrom, holdRoot } = {}) {
  const cfg = CONFIG.splashBust ?? {};
  const rootName = pinFrom ?? cfg.pinFrom ?? 'tail00_019';
  const holdName = holdRoot ?? cfg.holdRoot ?? 'all_ctrl_02';

  const pinRoot = instance.getObjectByName(rootName);
  if (!pinRoot) {
    console.warn(`[splashBust] no bone "${rootName}" on this model — nothing pinned.`);
    return null;
  }

  // The subtree, captured whole. `traverse` rather than a hand-listed set of
  // bone names: the point of pinning from a joint is that whatever hangs off it
  // is held too, and a rig that grows a bone should not need this file edited.
  //
  // The ROOT of it is captured differently from the rest, and that difference
  // is the whole feature. Holding a bone's LOCAL transform stops it moving
  // relative to its parent — which is not what "planted" means when the parent
  // is `chest_04`, a bone the idle clip rotates every frame. Held locally, the
  // tail stopped swinging on its own and then swung anyway, carried by the
  // chest, by about a twentieth of the animal's height: forty-odd pixels at
  // this crop, at the bottom edge, where it reads as the whole body rocking.
  //
  // So the root is held in the INSTANCE's frame instead. Relative to the model
  // rather than to the world, because the holder carries the plumb and the lean
  // — a world-space matrix captured here would fight both the moment either one
  // was changed.
  instance.updateMatrixWorld(true);
  _inv.copy(instance.matrixWorld).invert();
  const rootRest = _inv.multiply(pinRoot.matrixWorld).clone();

  const pinned = [];
  pinRoot.traverse((b) => {
    if (b === pinRoot) return;
    pinned.push({
      bone: b,
      position: b.position.clone(),
      quaternion: b.quaternion.clone(),
      scale: b.scale.clone(),
    });
  });

  // The whole-body bob, held by its TRANSLATION only. `water_idle` keys
  // `all_ctrl_02` with nothing but a translation track — it is the float, the
  // one channel that moves every other bone at once. At the run's framing it is
  // a few pixels; at a bust crop it is the animal wandering out of the frame,
  // so a portrait holds it and lets `chest_04` (which the clip also keys, and
  // which this does not touch) carry the breathing instead.
  const hold = holdName ? instance.getObjectByName(holdName) : null;
  if (holdName && !hold) console.warn(`[splashBust] no bone "${holdName}" to hold the float on.`);
  const holdPos = hold ? hold.position.clone() : null;

  return {
    root: pinRoot,
    // The whole held half, root included — measureBust treats this as the set
    // that is NOT the bust, so leaving the root out of it would let the waist
    // itself back into the crop.
    bones: [pinRoot, ...pinned.map((p) => p.bone)],

    /**
     * Write the pinned half back to the authored pose.
     *
     * AFTER the rig, not before. The aim rig's tail chain is a damped spring
     * that writes `tail00_019` and its two children every frame (CONFIG.tail),
     * so a pin applied before it would be overwritten by the lag it exists to
     * remove. Head and flipper chains contain none of these bones, so nothing
     * that IS meant to move is undone by running last.
     */
    apply() {
      // The root, back to where it sits in the model — expressed as the local
      // transform that puts it there given wherever its parent has wandered to
      // this frame. `updateWorldMatrix(true, false)` walks up from the parent
      // and not down, so it costs a handful of multiplies and cannot undo the
      // pose the rig just wrote into the chains below.
      const parent = pinRoot.parent;
      if (parent) {
        parent.updateWorldMatrix(true, false);
        instance.updateWorldMatrix(true, false);
        _want.multiplyMatrices(instance.matrixWorld, rootRest);
        _local.copy(parent.matrixWorld).invert().multiply(_want);
        _local.decompose(pinRoot.position, pinRoot.quaternion, pinRoot.scale);
      }

      // ...and everything under it back to the authored pose, which is a local
      // question again: below the waist nothing is meant to move relative to
      // anything else.
      for (const p of pinned) {
        p.bone.position.copy(p.position);
        p.bone.quaternion.copy(p.quaternion);
        p.bone.scale.copy(p.scale);
      }
      if (hold) hold.position.copy(holdPos);
    },

    /**
     * Hand the bones back to the mixer.
     *
     * Restores the reference pose once rather than simply stopping: the mixer
     * skips writing a track whose value has not changed since the last frame,
     * so bones released mid-clip would otherwise sit at whatever the pin left
     * until the next keyframe that actually differs. Same trap restoreReference
     * in systems/ikChain.js exists for.
     */
    release() {
      this.apply();
    },
  };
}

/**
 * WHERE THE UPPER BODY ACTUALLY IS, in world units — the box the frame is
 * composed on.
 *
 * Measured by skinning, because bone positions do not describe a silhouette:
 * the seal's neck bones run up the middle of a head that is much wider than
 * they are, and the flippers' skin reaches well past `hand_*`. So every vertex
 * is transformed by the skeleton exactly as the vertex shader would, and a
 * vertex counts as upper body when most of its weight is on a bone that is NOT
 * pinned. The crop line therefore lands on the skin at the waist rather than on
 * a joint somewhere inside the animal.
 *
 * Call it once, on a settled pose. A box re-measured every frame breathes with
 * the clip, and a frame fitted to a breathing box is a frame that pumps.
 *
 * @param instance   the posed model (its world matrices must be current)
 * @param pin        the pin from createBustPin — its bones are the excluded set
 * @param threshold  how much of a vertex must belong to the upper body, 0..1
 */
export function measureBust(instance, pin, threshold = 0.5) {
  const box = new THREE.Box3().makeEmpty();
  const pinnedBones = new Set(pin?.bones ?? []);

  instance.updateMatrixWorld(true);
  instance.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const pos = o.geometry.attributes.position;
    const skinIndex = o.geometry.attributes.skinIndex;
    const skinWeight = o.geometry.attributes.skinWeight;
    if (!pos || !skinIndex || !skinWeight) return;
    // The skeleton's bone matrices are what applyBoneTransform reads, and they
    // are only current if the bones' world matrices are — done above.
    o.skeleton.update();

    for (let i = 0; i < pos.count; i++) {
      // How much of this vertex belongs to the half that still moves.
      let upper = 0;
      for (let k = 0; k < 4; k++) {
        const w = skinWeight.getComponent(i, k);
        if (w <= 0) continue;
        const bone = o.skeleton.bones[skinIndex.getComponent(i, k)];
        if (bone && !pinnedBones.has(bone)) upper += w;
      }
      if (upper < threshold) continue;

      // The same transform the shader does — bind matrix, bone matrices, bind
      // inverse — and then the mesh's own place in the world, which carries the
      // asset's fit scale. Skipping the second half measures the model in its
      // own units and quietly frames the camera on a seal a third the size.
      o.applyBoneTransform(i, _skinned.fromBufferAttribute(pos, i));
      box.expandByPoint(_v.copy(_skinned).applyMatrix4(o.matrixWorld));
    }
  });

  return box;
}

/**
 * Compose the portrait: fit `camera` (orthographic) around the measured box.
 *
 * ANCHORED ON THE HEAD, not on the centre of the box. A portrait is composed
 * from the top down — the air above the skull is the thing being judged, and
 * the waist is wherever the bottom edge happens to land. So `headroom` places
 * the crown and `fill` decides how much of the frame the animal is; a `fill`
 * past 1 crops INTO the body, which is what "framed big" means once the whole
 * bust already fits.
 *
 * Both are fractions of the frame height, so the composition survives a window
 * resize — only the aspect changes what is beside the animal.
 */
export function fitBustCamera(camera, box, aspect, cfg = CONFIG.splashBust ?? {}) {
  const size = box.getSize(_v);
  const bustH = Math.max(1e-4, size.y);
  const frameH = bustH / Math.max(0.05, cfg.fill ?? 1);
  const frameW = frameH * Math.max(0.05, aspect);

  const top = box.max.y + (cfg.headroom ?? 0.08) * frameH;
  const bottom = top - frameH;
  const cx = (box.min.x + box.max.x) / 2 + (cfg.offsetX ?? 0) * frameW;

  camera.left = cx - frameW / 2;
  camera.right = cx + frameW / 2;
  camera.top = top;
  camera.bottom = bottom;
  // Generous and symmetric: the animal sits at the world origin with its flank
  // to the lens, so half of it is behind z=0 and a near plane at 0 would slice
  // the far flipper off.
  camera.near = -100;
  camera.far = 200;
  camera.updateProjectionMatrix();
  return camera;
}

/**
 * HOW FAR OFF PLUMB THE ANIMAL IS, in radians — add it to the holder's z and
 * the seal stands up.
 *
 * Needed because "upright" is not a property of the model. The authored idle
 * curls the spine, and the waist-to-crown axis of a seal in `water_idle` sits
 * some twenty degrees off vertical — enough that the portrait reads as an
 * animal swimming diagonally across the frame rather than as one standing in
 * it. Rather than guessing a correction, this measures the axis the crop is
 * built on and returns exactly the angle that makes it vertical; `lean` is
 * then a cant applied to a known plumb, instead of a fudge on top of an
 * unknown one.
 *
 * MEASURE IT ONCE, on a settled pose, and keep it. Called every frame it would
 * be a body that counter-rotates whenever the neck turns, which is the exact
 * motion this file exists to remove.
 */
export function bustPlumb(pin, rig) {
  const waist = pin?.root;
  const crown = rig?.anchors?.mouth ?? rig?.head?.point ?? null;
  if (!waist || !crown) return 0;
  waist.getWorldPosition(_v);
  const angle = Math.atan2(crown.y - _v.y, crown.x - _v.x);
  // The axis points up the screen when it is at +PI/2, so the correction is
  // whatever is left over.
  return Math.PI / 2 - angle;
}

/**
 * THE RIM, at portrait scale.
 *
 * CONFIG.playerOutline.thickness is in WORLD units and is tuned for the frame
 * the game is actually played in — about 20 screen pixels per world unit, where
 * 0.14 units is a 3px line around a 120px seal. A bust crop is twenty times
 * that density, so the same number is a 60px slab that swallows the face and
 * shows every place an inverted hull turns itself inside out. Scaling it by the
 * treatment's own zoom is not a fix for the game's rim; the two framings simply
 * do not want the same number.
 *
 * Both shells are scaled by ONE factor, from their own authored widths, so the
 * ink line keeps its proportion inside the glow — the difference between the
 * two IS the lit fringe (see CONFIG.playerOutline.inner), and rescaling them
 * independently would quietly retune that.
 */
export function createBustOutline(instance) {
  const shells = [];
  instance.traverse((o) => {
    if (!/__outline/.test(o.name ?? '')) return;
    const u = o.material?.userData?.__outlineThickness;
    if (u) shells.push({ material: o.material, base: u.value });
  });

  return {
    count: shells.length,
    /** @param pxPerUnit  screen pixels per world unit in the composed frame. */
    fit(pxPerUnit, px = CONFIG.splashBust?.outlinePx ?? 6) {
      if (!shells.length || !(pxPerUnit > 0)) return;
      // The widest shell is the one the pixel figure is about; the thinner ink
      // rides in at its own share of it.
      const widest = shells.reduce((m, s) => Math.max(m, s.base), 0) || 1;
      const want = px / pxPerUnit;
      for (const s of shells) setOutlineThicknessOn(s.material, (s.base / widest) * want);

      // ...and the colour, when the treatment asks for one. The game's rim is a
      // cyan glow with a black ink line inside it, authored to be found against
      // a dark ocean; put the same seal on a pale title card and the glow is
      // gone and the animal reads as a cutout pasted on. Both are left alone by
      // default, so the standalone bust is exactly the seal the game draws.
      const cfg = CONFIG.splashBust ?? {};
      if (cfg.outlineColor == null && cfg.outlineInk == null) return;
      for (const s of shells) {
        const c = s.base >= widest ? cfg.outlineColor : (cfg.outlineInk ?? cfg.outlineColor);
        if (c != null) s.material.color.set(c);
      }
    },
  };
}

/**
 * WHERE THE CURSOR IS, as an aim direction the rig understands.
 *
 * `input.aim` in a run is the direction from the seal to the pointer, and the
 * rig's cone gate is measured against it — so a portrait has to hand it the
 * same KIND of vector or the head reads as aiming at a point off in space. The
 * origin is the head rather than the body centre: at this crop the two are half
 * a screen apart, and using the body's would leave the neck consistently
 * undershooting the pointer by that much.
 *
 * `spread` IS THE PART THAT IS SPECIFIC TO A BUST, and without it this screen
 * barely moves. CONFIG.head's cone is authored for a seal swimming along its
 * own forward: it tracks within about 52 degrees of the neck's rest direction
 * and has given up entirely by 97 (`frontCone` / `backCone`). Stand the animal
 * up and that cone points at the sky — so a pointer anywhere out to the side,
 * which is most of a wide window, is 90 degrees off and lands in the peek: the
 * head turns to the viewer and then stops answering. Asking for a FRACTION of
 * the offset keeps the whole screen inside the neck's range, so the head reads
 * as following the cursor everywhere instead of tracking a wedge above itself
 * and staring blankly through the rest.
 *
 * It is not a cheat on the rig's limits — the rig still applies every one of
 * them to what it is handed. It is the difference between pointing AT something
 * and looking TOWARD it, and a portrait wants the second.
 *
 * @param forward  the direction the body's own forward points, in radians —
 *                 PI/2 for a seal standing plumb, plus whatever cant it carries.
 *
 * Returns `out` unchanged (holding the last good aim) when the pointer is on
 * top of the head — a zero-length direction normalises to NaN and takes the
 * whole chain with it.
 */
export function bustAim(rig, cursorWorld, out, forward = Math.PI / 2, spread = CONFIG.splashBust?.aimSpread ?? 1) {
  const head = rig?.anchors?.mouth ?? rig?.head?.point ?? null;
  const ox = head ? head.x : 0;
  const oy = head ? head.y : 0;
  const dx = cursorWorld.x - ox;
  const dy = cursorWorld.y - oy;
  if (dx * dx + dy * dy < 1e-8) return out;
  if (spread >= 0.999) return out.set(dx, dy).normalize();

  // Wrapped the short way round, or a pointer that crosses behind the animal
  // sends the requested angle the long way and the head sweeps through the
  // floor to get there.
  let off = Math.atan2(dy, dx) - forward;
  while (off > Math.PI) off -= Math.PI * 2;
  while (off < -Math.PI) off += Math.PI * 2;
  const want = forward + off * spread;
  return out.set(Math.cos(want), Math.sin(want));
}
