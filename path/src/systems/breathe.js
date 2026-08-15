import * as THREE from 'three';
import { CONFIG } from '../config.js';

// ============================================================================
// BREATHING — what the seal does when it stops.
//
// A seal that swims up, stops at the surface and simply holds still reads as a
// paused game. This is the thing that says it is alive while nothing is
// happening: a slow rise and fall through the chest, quick in and long out.
//
// -----------------------------------------------------------------------
// WHY IT IS PROCEDURAL, WHEN THERE IS AN IDLE CLIP
//
// Because the idle clip does not breathe. Measured over its whole 6.00s, the
// chest travels 0.000 units — all of its motion is a head turn (0.231) and a
// mouth yawn (0.483). It is a look-around, not a resting animal. Nothing in
// furseal.glb rises and falls: `sleep` is deader still (everything under
// 0.016).
//
// -----------------------------------------------------------------------
// THE RIG HAS NO RIBCAGE, so this cannot be anatomical.
//
// There is one trunk bone — chest_04 — and the head, both flippers and the
// whole tail hang directly off it. There is no spine to arch and no ribs to
// expand, so a real inflate is not available at any amplitude. Measured, by
// rotating each bone and watching where the skin goes:
//
//   chest_04 about its own X    mouth -0.190, shoulders -0.052, tail +0.081
//                               (per +0.15 rad — the whole animal see-saws
//                               about the chest, front down / tail up)
//   neck01_05 about its own X   mouth -0.112 and nothing else moves — a nod
//
// So a breath here is a small see-saw with the nod partly taken back out: the
// body's midsection lifts, and the neck gives some of that back so the head
// stays roughly level instead of the animal appearing to bow. At the size the
// seal is on screen that reads as breathing, which is the honest limit of what
// this skeleton can say.
//
// -----------------------------------------------------------------------
// WHICH BONES, AND WHY NOT THE OBVIOUS ONE
//
// chest_04 and neck02_06 — both because they are the right joints AND because
// the mixer owns them in every locomotion clip (chest keys 30 times even in
// `swim`, the sparsest). That is what lets this be a plain additive rotation
// with no bookkeeping: the clip lays down an absolute pose every frame, so a
// delta applied on top is gone again the moment this stops writing.
//
// neck01_05 is the joint you would reach for first and it is a TRAP: `swim`
// keys it exactly ONCE. A single-keyframe track is a constant, and three.js
// stops writing a value that has not changed — so a delta added there would
// compound every frame and never come back. See trackCoverage in
// systems/animation.js, which is where that rule is written down, and
// systems/celebrate.js, which pays the full price of it.
// ============================================================================

const AXES = { x: 'x', y: 'y', z: 'z' };
const _q = new THREE.Quaternion();
const _axis = new THREE.Vector3();

/**
 * The breath curve, 0..1. Not a sine: a resting animal fills quickly and
 * empties slowly, and the asymmetry is most of what separates "breathing"
 * from "pulsing". Same reasoning as the two eases in systems/jaw.js.
 *
 * @param u 0..1 through one breath.
 */
function breathCurve(u, inhale) {
  const inh = Math.min(0.9, Math.max(0.05, inhale));
  if (u < inh) {
    const t = u / inh; // fill
    return t * t * (3 - 2 * t);
  }
  const t = (u - inh) / (1 - inh); // empty, over the longer remainder
  return 1 - t * t * (3 - 2 * t);
}

/**
 * Build the breather for one model instance.
 *
 * @returns null when the model declares no `breathRig`, which every caller
 *   treats as "this creature doesn't breathe".
 */
export function createBreathDriver(instance) {
  const def = instance?.userData?.breathRig;
  if (!def?.chest) return null;
  const chest = instance.getObjectByName(def.chest);
  if (!chest) return null;
  const neck = def.neck ? instance.getObjectByName(def.neck) : null;
  const chestAxis = AXES[def.axis] ?? 'x';
  const neckAxis = AXES[def.neckAxis ?? def.axis] ?? 'x';
  // Which way is IN. The measurement above is for a POSITIVE rotation, which
  // drops the front of the animal — so a breath in is the negative direction
  // unless a model says otherwise.
  const sign = def.sign ?? -1;

  let clock = 0;

  // WHY THIS KEEPS ITS OWN BOOKS instead of just adding a rotation each frame.
  //
  // Adding to whatever is in the bone assumes the mixer laid down a fresh pose
  // first. It usually does — but three.js's PropertyMixer SKIPS its write
  // whenever the value it computes is identical to the one it last wrote, and
  // that happens more often than "the clip keys this bone" suggests: any two
  // equal keyframes make a constant SEGMENT, and a clip held on one frame (a
  // paused mixer, a scrubbed pose) is constant everywhere. On a skipped frame
  // the "current" pose is this file's own output from last frame, so a delta
  // added on top compounds — measured at 1.90 units of snout travel across one
  // breath before this existed, against the 0.05 it is supposed to be.
  //
  // Choosing well-keyed bones (see the header) is necessary and not
  // sufficient. So each bone remembers two things: the pose the mixer gave us
  // to build on, and exactly what we wrote. If the bone still holds what we
  // wrote, the mixer stayed silent this frame and the stored base is the real
  // pose; if it holds anything else, the mixer spoke and that IS the new base.
  // Either way what gets written is base * delta — an absolute pose, never an
  // accumulation.
  const tracked = [chest, neck].filter(Boolean).map((bone) => ({
    bone,
    base: bone.quaternion.clone(),
    written: bone.quaternion.clone(),
    fresh: true,
  }));

  function baseFor(entry) {
    // `fresh` covers the first frame, where nothing has been written yet and
    // the bone's own pose is the base by definition.
    if (!entry.fresh && entry.bone.quaternion.equals(entry.written)) return entry.base;
    entry.base.copy(entry.bone.quaternion);
    return entry.base;
  }

  return {
    /**
     * @param dt      seconds; the game clock, so breathing slows with the
     *                world and stops with a pause rather than carrying on
     *                behind a menu.
     * @param amount  0..1, how relaxed the animal is — entities/player.js
     *                ramps this up once the seal has settled at the surface
     *                and drops it the moment it moves. At 0 this writes
     *                nothing at all.
     *
     * MUST run after the animation controller, like every other pose layer
     * here: the mixer writes an absolute pose each frame, so anything adding
     * to it beforehand is simply overwritten.
     */
    update(dt, amount) {
      const cfg = CONFIG.surfaceRest?.breath ?? {};
      if (cfg.enabled === false || !(amount > 0.001)) {
        // Stop OWNING the bones the moment the breath is off, so the next
        // frame's mixer pose is taken at face value rather than compared
        // against something written seconds ago.
        for (const e of tracked) e.fresh = true;
        return;
      }
      const period = Math.max(0.2, cfg.period ?? 3.6);
      clock = (clock + dt / period) % 1;

      // Centred on zero rather than running 0..1, so the rest pose sits in the
      // MIDDLE of the breath. Driving it one-sided would park the seal at the
      // bottom of an exhale and make every breath a bulge upward from a pose
      // the animator never authored.
      const swell = (breathCurve(clock, cfg.inhale ?? 0.35) - 0.5) * 2;
      const depth = (cfg.depth ?? 0.035) * amount * sign;

      // The neck gives part of the see-saw back, so the head holds its line
      // while the body works. Without it the whole animal nods, which reads as
      // a bow rather than as a breath.
      const angles = [swell * depth, -swell * depth * (cfg.neckCounter ?? 0.55)];
      const axes = [chestAxis, neckAxis];
      for (let i = 0; i < tracked.length; i++) {
        const e = tracked[i];
        const ax = axes[i];
        _axis.set(ax === 'x' ? 1 : 0, ax === 'y' ? 1 : 0, ax === 'z' ? 1 : 0);
        e.bone.quaternion.copy(baseFor(e)).multiply(_q.setFromAxisAngle(_axis, angles[i]));
        e.written.copy(e.bone.quaternion);
        e.fresh = false;
      }
    },

    /** Start the next rest on a fresh breath rather than mid-exhale. */
    reset() {
      clock = 0;
      for (const e of tracked) e.fresh = true;
    },

    // For the tests and the state inspector.
    bones: neck ? [chest.name, neck.name] : [chest.name],
  };
}
