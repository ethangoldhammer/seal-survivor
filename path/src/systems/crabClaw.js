import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { boneRun, buildChain, applyChainToPoint, measureReach } from './ikChain.js';

// ============================================================================
// CRAB CLAW — a telegraphed pinch, layered over a walk cycle that never stops.
//
// THE RIG DOES NOT HAVE A PINCER. This is the fact the whole file is shaped
// around, so it is worth stating before anything else. Every arm chain in
// crabwalking.glb ends at a `...ArmPalm` bone, and every one of those is a
// LEAF — there is nothing below it to hinge. The claw head is one solid closed
// lump of 424 vertices, split sequentially across Arm3 (forearm) and Palm
// (head); a histogram of that lump along each of its own three axes shows no
// interior gap on any of them. It is modelled as a shut fist, not as two jaws
// resting together. tools/crab-claw-probe.mjs prints every one of those
// numbers, and it is the tool to re-run if the model is ever re-exported.
//
// So there is no pinch to play. What there is:
//
//   THE ARM IS REAL. Five bones a side (collarbone through palm) and about 70
//   model units of reach, which is more than enough to lift a claw off the
//   seabed and hold it over the player. That gets CCD IK, the same solver the
//   octopus's tentacles and the sharks' snouts use.
//
//   THE PINCH IS A SCISSOR. The whole claw head swings about the Palm's local
//   z — measured at 0.938 (L) and 0.925 (R) alignment with the head's THIN
//   axis, i.e. the one that moves it inside its own flat plane, which is the
//   plane a real pincer would open in. The forearm under it counter-rotates by
//   a fraction of the same angle, so the two halves shear past each other
//   rather than the whole arm waving. At gameplay distance that reads as a
//   claw snapping; up close it reads as a claw that does not open, which is
//   the honest limit of what this file can do without new geometry.
//
// WHY NOTHING HERE RESTORES A POSE. applyChainToPoint treats whatever is
// already in a bone as the clip's pose and blends away from it, so it drifts
// on any bone nobody else writes. That is safe here because the walk clip keys
// ROTATION on 41 of the rig's 42 joints — every bone this file touches
// included — so the mixer lays down an absolute pose each frame before we run.
// The scissor still carries the anti-ratchet guard from systems/jaw.js anyway:
// it costs two comparisons, and it is the difference between "a re-export
// dropped a keyframe track" showing up as a stiff claw and showing up as an
// arm that winds itself inside-out over ten seconds.
//
// ORDER MATTERS. This must run AFTER the animation controller's update() for
// the same frame. That call resets every spring bone to its rest pose, writes
// the clip, then layers the impact springs — and the claw is the last word on
// top of all three. Running it first means the mixer overwrites the pinch and
// nothing appears to happen at all.
// ============================================================================

const AXES = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

// The two halves of a snap, deliberately not one symmetrical curve — same
// reasoning as the jaw's gape, and for the same reason it is the timing rather
// than the angle that sells it. The claw rears open slowly enough to be READ
// as a warning, and shuts fast enough to feel like it cost the player
// something.
function gaping(u) {
  return u * (2 - u); // ease-out: most of the opening travel happens early
}
function slamming(u) {
  return u * u; // ease-in: hangs at the top of the gape, then goes
}

const _target = new THREE.Vector3();
const _root = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();

// Hand the solver a clean base pose. See the `chainGiven` note in the arm
// record for why this cannot be skipped on a rig whose chain is unkeyed.
function restoreChain(arm) {
  const b = arm.chain.bones;
  for (let i = 0; i < b.length; i++) {
    if (arm.chainWritten && b[i].quaternion.equals(arm.chainWrote[i])) {
      b[i].quaternion.copy(arm.chainGiven[i]);
    }
    arm.chainGiven[i].copy(b[i].quaternion);
  }
}

function rememberChain(arm) {
  const b = arm.chain.bones;
  for (let i = 0; i < b.length; i++) arm.chainWrote[i].copy(b[i].quaternion);
  arm.chainWritten = true;
}

/**
 * @param instance the posed model; reads `userData.clawRig`.
 * @returns null when the model declares no claw rig or no arm resolves, which
 *   every caller treats as "this creature doesn't pinch".
 */
export function createClawDriver(instance) {
  const def = instance?.userData?.clawRig;
  if (!def?.arms?.length) return null;

  // TWO WAYS TO PINCH, and which one a model gets is a fact about its rig
  // rather than a preference.
  //
  //   'jaw'      the rig has a real pincer: the wrist forks into two finger
  //              chains driving separate geometry, so ONE of them rotates and
  //              the claw genuinely opens. Declared as `jaw` on each arm.
  //   'scissor'  the rig has no pincer at all. The whole claw head swings on
  //              the last bone and the forearm shears the other way under it.
  //              It reads as a snap at gameplay distance and never opens.
  //
  // Chosen per arm by what the spec names, so a roster can hold both — which
  // it does today, and the fallback matters: an asset that declares no `jaw`
  // gets the scissor rather than nothing.
  const axis = AXES[def.scissorAxis] ?? AXES.z;
  const arms = [];

  def.arms.forEach((spec, i) => {
    const names = boneRun(instance, spec.root, spec.tip, `claw ${i}`);
    if (!names) return;
    const chain = buildChain(instance, {
      bones: names,
      name: `claw${i}`,
      tipAxis: def.tipAxis,
      tipLength: def.tipLength ?? 0,
    }, def.tipAxis, `claw ${i}`);
    if (!chain) return;

    // The movable finger, when there is one. Rotating it is the entire pinch:
    // the other prong stays where the clip put it, so the claw opens instead
    // of the head swinging.
    const jaw = spec.jaw ? instance.getObjectByName(spec.jaw) ?? null : null;
    if (spec.jaw && !jaw) {
      console.warn(`[crabClaw] claw ${i} names jaw bone "${spec.jaw}", which this model does not have `
        + '— falling back to the scissor, which does not open.');
    }

    arms.push({
      chain,
      jaw,
      // Per-arm sign. A mirrored rig needs opposite rotations on the two sides
      // to shut both claws (measured on crabpincer.glb: the left jaw closes on
      // -x and the right on +x). A rig whose bone orientations already mirror
      // — crabwalking.glb is one — leaves this at 1 on both arms and the
      // single configured angle serves them both.
      sign: spec.sign ?? 1,
      // The claw head, and the forearm it shears against. Only used on the
      // scissor path; `counter` is optional even there, and without it the
      // scissor degrades to the whole head swinging, which still reads at
      // distance.
      scissor: instance.getObjectByName(spec.tip) ?? null,
      counter: spec.counter ? instance.getObjectByName(spec.counter) ?? null : null,
      // Anti-ratchet state, one set per bone we post-multiply onto.
      given: new THREE.Quaternion(),
      wrote: new THREE.Quaternion(),
      givenC: new THREE.Quaternion(),
      wroteC: new THREE.Quaternion(),
      hasWritten: false,
      // The same anti-ratchet, one pair per CHAIN bone. applyChainToPoint
      // treats whatever is in a bone as the clip's pose and blends away from
      // it, which is safe only where something else writes that bone first.
      // crabpincer.glb keys rotation on 50 of its 126 bones and the shoulder
      // is not among them, so without this the arm would creep further from
      // its rest pose on every pinch and never come back.
      //
      // Works whether or not the mixer is involved, which is why it is not
      // conditional on a keyed-bone list the asset would have to maintain: if
      // the mixer wrote the bone, it no longer holds what we left and we take
      // the mixer's pose as the base; if nothing wrote it, it still holds ours
      // and we put the previous base back.
      chainGiven: chain.bones.map(() => new THREE.Quaternion()),
      chainWrote: chain.bones.map(() => new THREE.Quaternion()),
      chainWritten: false,
      weight: 0,
      // Seconds this arm lags the other. Two claws arriving on exactly the
      // same frame reads as one animation played twice, which is the tell that
      // gives a procedural gesture away faster than anything else it does.
      lag: i * (CONFIG.crabClaw?.armLag ?? 0.06),
    });
  });

  if (!arms.length) return null;

  // -1 = idle. Anything >= 0 is elapsed seconds into a pinch.
  let t = -1;
  let connected = false; // true on exactly the frame the claws meet
  let spent = false; // this pinch has already paid out its one hit
  let reach = 0; // measured lazily: the skeleton has to be posed first

  // The longest any arm lags the clock, so the pinch stays alive until the
  // LAST claw has finished recovering. Ending it on the leading arm's schedule
  // cuts the trailing one off mid-recover, which shows up as a claw that snaps
  // back to the walk cycle a frame after it lands.
  const maxLag = arms.reduce((m, a) => Math.max(m, a.lag), 0);

  function phase(cfg, elapsed) {
    if (elapsed < 0) return null;
    const windup = Math.max(0.01, cfg.windup);
    const strike = Math.max(0.01, cfg.strike);
    const recover = Math.max(0.01, cfg.recover);
    if (elapsed < windup) return { name: 'windup', u: elapsed / windup };
    if (elapsed < windup + strike) return { name: 'strike', u: (elapsed - windup) / strike };
    if (elapsed < windup + strike + recover) {
      return { name: 'recover', u: (elapsed - windup - strike) / recover };
    }
    return { name: 'done', u: 1 };
  }

  function totalTime(cfg) {
    return Math.max(0.01, cfg.windup) + Math.max(0.01, cfg.strike) + Math.max(0.01, cfg.recover);
  }

  return {
    // Begin a pinch. Re-firing mid-pinch is ignored rather than restarting —
    // the opposite of the jaw's behaviour, and deliberately so: the caller
    // rate-limits a bite, but a crab's strike is driven by proximity, and a
    // player standing still would otherwise pin the claw at frame 0 of the
    // windup forever and never actually get hit.
    strike() {
      if (t >= 0) return false;
      t = 0;
      spent = false;
      return true;
    },

    isStriking() {
      return t >= 0;
    },

    // True for exactly one frame, on the frame the claws shut. This is the
    // moment damage is owed — see the crab branch in systems/combat.js.
    didConnect() {
      return connected;
    },

    /**
     * @param dt      seconds.
     * @param aim     world-space point to pinch at, or null to stand down. The
     *                caller owns "is the player in range"; this only owns what
     *                the arm does about it.
     */
    update(dt, aim) {
      connected = false;
      const cfg = CONFIG.crabClaw;
      if (!cfg?.enabled) return;

      if (t >= 0) {
        t += dt;
        // Every arm runs the same schedule on its own delayed clock, so the
        // pinch is over only once the last of them has finished recovering.
        if (t > totalTime(cfg) + maxLag) t = -1;
      }

      for (const arm of arms) {
        const { chain } = arm;
        // This arm's own position in the pinch. Null whenever it is idle,
        // which covers both "no pinch running" and "this arm hasn't started
        // yet" — a lagging claw stays on the walk cycle until its turn.
        const p = t >= 0 ? phase(cfg, t - arm.lag) : null;
        const busy = p != null && p.name !== 'done';

        // How much of the arm the IK owns, eased. This ramp IS the reach: the
        // claw visibly leaves the walk cycle and extends rather than snapping
        // to a solved pose on one frame. Out is slower than in — letting an
        // arm down is lazier than throwing it up.
        const want = busy && aim ? cfg.reachWeight : 0;
        const rate = want > 0 ? cfg.weightLerpIn : cfg.weightLerpOut;
        arm.weight += (want - arm.weight) * (1 - Math.exp(-rate * dt));

        if (arm.weight > 0.001 && aim) {
          if (!reach) reach = measureReach(chain, 1);
          chain.bones[0].getWorldPosition(_root);
          _toTarget.copy(aim).sub(_root);
          const dist = _toTarget.length() || 1;
          _toTarget.divideScalar(dist);

          // Clamped to what the arm can actually cover. A target past the end
          // of the chain doesn't extend it — it just straightens the arm and
          // holds it there, which is a stick pointing at the player rather
          // than a claw reaching for them.
          const span = Math.min(dist, reach * (cfg.reachStretch ?? 1));
          _target.copy(_toTarget).multiplyScalar(span).add(_root);

          // The windup pulls UP and BACK off the aim line, which is the whole
          // telegraph: the claw has to be somewhere the player can see it
          // before it arrives. Both offsets are multiples of the arm's own
          // reach, so a crab that has grown over a long run rears up further
          // in proportion rather than making the same small gesture at four
          // times the size.
          if (p?.name === 'windup') {
            const g = gaping(p.u);
            _target.addScaledVector(_up, reach * cfg.rise * g);
            _target.addScaledVector(_toTarget, -reach * cfg.draw * g);
          }

          restoreChain(arm);
          applyChainToPoint(chain, dt, cfg.ik, arm.weight, 1, _target);
          rememberChain(arm);
        } else {
          restoreChain(arm);
          applyChainToPoint(chain, dt, cfg.ik, 0, 1, _target);
          rememberChain(arm);
        }

        // --- the scissor ----------------------------------------------------
        // Gape open through the windup, slam shut through the strike, and
        // overshoot slightly past rest at the end of the slam so the claw
        // arrives with a bite instead of easing into place.
        let angle = 0;
        if (p?.name === 'windup') {
          angle = cfg.gape * gaping(p.u);
        } else if (p?.name === 'strike') {
          const s = slamming(p.u);
          angle = cfg.gape * (1 - s) - cfg.snap * s;
          // The frame the claws meet. `spent` is per PINCH, not per arm: the
          // two claws shut a few hundredths apart, so a per-arm guard would
          // let the trailing one bill the player a second time on a later
          // frame — `connected` is cleared at the top of every update and
          // could not catch it.
          if (p.u >= (cfg.connectAt ?? 0.85) && !spent) {
            connected = true;
            spent = true;
          }
        } else if (p?.name === 'recover') {
          angle = -cfg.snap * (1 - p.u); // unclench back to the walk cycle
        }

        // A real pincer opens on ONE bone; a rig without one swings the whole
        // head and shears the forearm. `jawAxis` is separate from
        // `scissorAxis` because they are different joints on different models
        // and there is no reason they would agree.
        const hinge = arm.jaw ?? arm.scissor;
        const hingeAxis = arm.jaw ? (AXES[def.jawAxis] ?? axis) : axis;
        // A REAL JAW NEVER CLOSES PAST REST. `snap` carries the scissor a
        // little beyond its rest angle so the swing lands with a bite — which
        // is free on a claw that is one solid lump, because there is nothing
        // for it to hit. On a pincer the rest pose IS shut (measured: the tips
        // sit at 9% of finger length apart), so the same overshoot drives the
        // movable finger straight through the fixed one. Clamped to opening
        // only; the bite comes from how fast it shuts instead.
        const shaped = arm.jaw ? Math.max(0, angle) : angle;
        const swing = shaped * arm.sign * (arm.jaw ? (cfg.jawScale ?? 1) : 1);

        if (hinge) {
          // Anti-ratchet: put back the pose we were handed, but only where the
          // bone still holds exactly what we left.
          //
          // On crabwalking.glb this is belt-and-braces, because the clip keys
          // all 41 bones and the mixer overwrites us anyway. On crabpincer.glb
          // it is LOAD-BEARING: that clip keys only 50 of its 126 bones and the
          // finger bones are not among them, so nothing else writes the jaw and
          // a plain post-multiply would wind it open a little further every
          // frame until the claw turned inside out.
          if (arm.hasWritten && hinge.quaternion.equals(arm.wrote)) {
            hinge.quaternion.copy(arm.given);
          }
          arm.given.copy(hinge.quaternion);
          // The forearm shear belongs to the scissor alone — on a real jaw
          // there is nothing to counter-rotate, and doing it anyway would drag
          // the whole claw backwards as it opened.
          const counter = arm.jaw ? null : arm.counter;
          if (counter) {
            if (arm.hasWritten && counter.quaternion.equals(arm.wroteC)) {
              counter.quaternion.copy(arm.givenC);
            }
            arm.givenC.copy(counter.quaternion);
          }

          if (Math.abs(swing) > 0.0001) {
            // Post-multiply, so this hinges about the bone's OWN axis on top of
            // whatever the clip put it in. Pre-multiplying would swing it about
            // the parent's roll and tumble the claw out of its plane.
            hinge.quaternion.multiply(_q.setFromAxisAngle(hingeAxis, swing));
            if (counter) {
              counter.quaternion.multiply(
                _q.setFromAxisAngle(hingeAxis, -swing * (cfg.counterRotation ?? 0)),
              );
            }
          }

          arm.wrote.copy(hinge.quaternion);
          if (counter) arm.wroteC.copy(counter.quaternion);
          arm.hasWritten = true;
        }
      }
    },

    // New run, or a recycled instance. Drops the pinch and forgets the
    // reference pose rather than restoring one that belonged to another crab.
    reset() {
      t = -1;
      connected = false;
      reach = 0;
      spent = false;
      for (const arm of arms) {
        arm.weight = 0;
        arm.hasWritten = false;
        arm.chainWritten = false;
        arm.chain.primed = false;
      }
    },
  };
}
