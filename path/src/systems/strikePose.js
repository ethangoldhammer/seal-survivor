import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { applyChainToPoint, smoothstep } from './ikChain.js';
import { createPoseRig } from './poseRig.js';
import { celebrationState } from './celebrate.js';
import { clapState, invSmoothstep } from './clap.js';

// ============================================================================
// THE COIL — the seal winds up when the wind-up is loaded, and lets go when
// the player does.
//
// "STRIKE NOW!" was words and a meter and nothing else. Both of those live at
// the edge of the frame while the player is looking at the water in front of
// the animal, so the one moment in this game with a timing window on it was
// the one moment the ANIMAL had nothing to say about. This is the animal's
// half: at the instant the bar can hold no more, the seal draws its flippers
// back along its flanks, tucks its head and cocks its fluke — and it stays
// there, visibly loaded, until the button comes up.
//
// -----------------------------------------------------------------------
// IT IS A STATE, NOT A GESTURE, and that is the whole difference from
// systems/clap.js.
//
// A clap is fired and forgotten: one envelope, played out, re-enterable. The
// coil is read off `strikeLoaded() && held` every frame and has to be able to
// stand there for as long as a player keeps the button down — which can be a
// long time, because holding past the sweet spot is a legal (if wasteful)
// thing to do. So there is a hold in the middle of the envelope with no
// timeout on it, and the pose comes off when the STATE goes away rather than
// when a clock runs out.
//
// That is also why it syncs rather than restoring every frame — see
// systems/poseRig.js. A pose held for ten seconds against an entry snapshot
// is a seal pinned to a swim frame from ten seconds ago; `sync` puts the
// animation back under the pose per bone, per frame, so the animal goes on
// swimming, turning and aiming while it is coiled.
//
// -----------------------------------------------------------------------
// THE SNAP. The point of this is to be SEEN ARRIVING — it is the reading of
// an instant, so it has to land like an accent rather than fade up. The
// envelope is a fast rise that overshoots the pose and settles back into it,
// which is the oldest trick there is for making a hold look struck rather
// than switched on. `overshoot: 1` retires it without touching anything else.
//
// The overshoot is applied to the TARGETS and not to the blend weight: past
// 1 the weight is clamped, so the accent is the limbs reaching further, never
// the pose being more than fully on. A weight above 1 means nothing to
// applyChainToPoint and would only be a way to write a number that does
// nothing.
//
// -----------------------------------------------------------------------
// THE CLOCK IS WALL TIME, like every other hand-posed thing in this game
// (systems/clap.js, systems/celebrate.js). The wind-up itself burns on the
// water's dilated clock, which is correct for the mechanic and wrong for the
// gesture that announces it: a hit-stop landing on the same frame the bar
// tops out would stretch the snap into the freeze and the accent would be
// gone. What keeps the two in step is that the pose is driven by the STATE,
// not by a clock of its own — dilate the world all you like and the coil is
// still up exactly while the strike is loaded.
//
// -----------------------------------------------------------------------
// WHO WINS. A clap or a victory lap takes the flippers outright: both are
// performances the player asked for by name, both are brief, and both are
// already the last writers in the frame. The coil stands down for either the
// moment it starts — which is the honest version of what would happen anyway,
// since the drivers run after this one — and it comes back on its own if the
// wind-up is still loaded when they finish.
// ============================================================================

const _target = new THREE.Vector3();

export const strikePoseState = {
  // Is there anything to pose this frame.
  active: false,
  // 0..1 (and briefly past 1 on the snap) — how coiled. Drives the target
  // distances; `min(1, t)` is the blend weight.
  t: 0,
  // 'off' | 'snap' | 'settle' | 'hold' | 'ease'
  phase: 'off',
  // WALL seconds into the current phase.
  clock: 0,
  // Where `t` was when the ease-out began, so the fall is continuous from
  // wherever the coil had got to rather than from a full one. A player who
  // lets go 30ms into the snap should see the pose fall from a third of the
  // way in, not drop from the top of a pose it never reached.
  from: 0,
  // How many times the coil has snapped in. A readout for the lab and the
  // tests — "did the accent fire once per wind-up" is the question this
  // feature exists to answer, and an envelope that re-triggers every frame
  // would look almost right on screen.
  hits: 0,
};

function cfg() {
  return CONFIG.strikePose ?? {};
}

/** The three parts of the envelope, clamped away from zero. */
function timings() {
  const c = cfg();
  return {
    snap: Math.max(0.001, c.snap ?? 0.07),
    settle: Math.max(0.001, c.settle ?? 0.11),
    release: Math.max(0.001, c.release ?? 0.16),
  };
}

function peak() {
  return Math.max(1, cfg().overshoot ?? 1.12);
}

function enter(phase) {
  strikePoseState.phase = phase;
  strikePoseState.clock = 0;
}

function endCoil() {
  if (strikePoseState.phase === 'off' && !strikePoseState.active) return;
  strikePoseState.active = false;
  strikePoseState.phase = 'off';
  strikePoseState.clock = 0;
  strikePoseState.t = 0;
  strikePoseState.from = 0;
}

/**
 * THE MOMENT, HELD.
 *
 * @param rawDt UNSCALED seconds — see the header.
 * @param armed is the wind-up loaded AND the button still down. The caller
 *   passes the same expression the "STRIKE NOW!" prompt is drawn from
 *   (main.js), so the pose and the words cannot end up describing different
 *   instants — which is the one failure this feature could have that nobody
 *   would ever see as a bug, only as the animation being vaguely off.
 */
export function updateStrikePose(rawDt, armed) {
  const s = strikePoseState;
  const dt = Math.max(0, rawDt ?? 0);

  // Handed over, rather than fought for. See the header.
  if (cfg().enabled === false || clapState.active || celebrationState.active) {
    endCoil();
    return;
  }

  if (armed) {
    // The EDGE, and the reason `ease` is included in it: a player who let go
    // and grabbed the button again inside the same wind-up is asking for the
    // moment a second time, and the accent is the answer to the asking.
    if (s.phase === 'off' || s.phase === 'ease') {
      const resuming = s.phase === 'ease' && s.t > 0;
      enter('snap');
      // RE-ENTERED, NOT RESTARTED, when the coil was still on its way out —
      // the same trick and the same reason as a clap pressed mid-stroke (see
      // invSmoothstep in systems/clap.js). Starting the snap's clock at zero
      // would drop `t` from wherever the ease had got to back to nothing on
      // the frame the player grabbed the button again: a visible flick of the
      // fluke the wrong way, on an input that is meant to feel immediate.
      //
      // The clock lands on the point of the attack curve whose value matches
      // the `t` already showing, so the pose carries on from where it is and
      // the rest of the snap runs at full speed.
      if (resuming) {
        s.clock = timings().snap * invSmoothstep(Math.min(1, s.t / peak()));
      }
      s.active = true;
      s.hits++;
    }
  } else if (s.phase !== 'off' && s.phase !== 'ease') {
    s.from = s.t;
    enter('ease');
  }

  if (s.phase === 'off') { s.t = 0; s.active = false; return; }

  s.clock += dt;
  const { snap, settle, release } = timings();
  const top = peak();

  if (s.phase === 'snap') {
    if (s.clock >= snap) enter('settle');
    else { s.t = top * smoothstep(0, 1, s.clock / snap); return; }
  }
  if (s.phase === 'settle') {
    if (s.clock >= settle) enter('hold');
    else { s.t = top + (1 - top) * smoothstep(0, 1, s.clock / settle); return; }
  }
  if (s.phase === 'hold') { s.t = 1; return; }

  // 'ease' — the let-go. Runs to zero and then the pose is simply gone; the
  // dash's own roll clip (player.anim.trigger('strike')) is what the limbs
  // are handed back to.
  const out = s.clock / release;
  if (out >= 1) { endCoil(); return; }
  s.t = s.from * (1 - smoothstep(0, 1, out));
}

/** A new run, or a rebuilt model. */
export function resetStrikePose() {
  endCoil();
  strikePoseState.hits = 0;
}

/**
 * Build the poser for one model instance.
 *
 * @returns null for a model with no aim rig, which every caller treats as
 *   "this creature doesn't coil".
 */
export function createStrikePoseDriver(instance) {
  const rig = createPoseRig(instance, 'strikePose');
  if (!rig) return null;

  // Is any of our pose sitting in the bones. The bones this rig restores are
  // the ones nothing else writes absolutely (systems/poseRig.js), so leftovers
  // do not clean themselves up.
  let dirty = false;

  return {
    /**
     * Pose this frame. MUST run after the animation controller and after the
     * aim rig — both write an absolute pose every frame, so anything before
     * them is simply overwritten — and BEFORE the clap and celebration
     * drivers, which are the two things allowed to overrule a coil.
     *
     * @param rawDt UNSCALED seconds.
     */
    update(rawDt) {
      if (!strikePoseState.active) {
        // Ended, or taken away mid-coil. HANDED BACK, NOT PUT BACK — `sync`
        // and not `restore`, which is the opposite of what the clap does and
        // is the difference between a gesture and a state.
        //
        // restore() writes the snapshot taken when the pose BEGAN. For a 0.3s
        // clap that is a pose a fifth of a second old and near enough to now;
        // for a coil the player has been holding for several seconds it is a
        // swim frame from several seconds ago, stamped onto the animal on the
        // way out — and on this rig that does not wash out. Measured in the
        // coil lab against a seal that never coiled: the hands sat 0.20 and
        // 0.45 world units off and were still there ten seconds later,
        // because the aim rig solves from wherever the bone already is and
        // inherits the error rather than correcting it. That is the ratchet
        // systems/poseRig.js exists to prevent, arriving through the one door
        // it leaves open.
        //
        // sync() hands each bone back to the last value that came from
        // somewhere else — this frame's swim clip and aim — and leaves alone
        // anything another system has already written. Nothing stale is ever
        // stamped on the animal.
        if (dirty) { rig.sync(); rig.unprime(); dirty = false; }
        return;
      }

      // The entry snapshot is taken on the first posed frame and held for the
      // whole coil; every frame after it is a `sync`, which is what lets the
      // animal go on swimming and aiming underneath a pose that may be held
      // for seconds. See systems/poseRig.js.
      if (!dirty) rig.capture();
      else rig.sync();

      const t = strikePoseState.t;
      const c = cfg();
      const weight = Math.min(1, t) * (c.weight ?? 1);
      if (weight <= 0.001) { rig.note(); dirty = true; return; }

      const p = c.pose ?? {};
      const ik = c.ik ?? {};
      rig.refreshBasis();

      // THE TWO DORSAL/FORE OFFSETS TRAVEL WITH `t` AND THE REST DO NOT, and
      // the split is not arbitrary: `up` and `fore` are what the coil is —
      // swept back, fluke raised — so they are the thing that grows in and
      // reaches past itself on the overshoot. `spread` (how far off the
      // centreline the flippers sit), `headFore` and `tailFore` are the frame
      // the shape happens in, near enough to rest that they can sit still; a
      // `spread` scaled by `t` would ask the flippers to start from inside the
      // animal's own body.
      const fw = weight * (p.finWeight ?? 1);
      if (fw > 0.001) {
        for (const { chain, side } of rig.fins) {
          rig.target(chain, _target, side, (p.up ?? 0) * t, (p.fore ?? 0) * t, p.spread ?? 0.3);
          applyChainToPoint(chain, rawDt, ik, fw, 1, _target);
        }
      }

      // The head tucks back at its own share of the weight — under 1 so the
      // seal keeps tracking what it is pointed at while it loads, which is the
      // whole reason it is holding the button.
      if (rig.head) {
        const hw = weight * (p.headWeight ?? 0.55);
        if (hw > 0.001) {
          rig.target(rig.head, _target, 1, (p.headUp ?? 0) * t, p.headFore ?? 0.5, 0);
          applyChainToPoint(rig.head, rawDt, ik, hw, 1, _target);
        }
      }

      // ...AND THE FLUKE COCKS. The tail is the half of this that reads at the
      // size the seal actually is on screen: the flippers are a few pixels and
      // the tail swings through a tenth of the body's length. It is also the
      // part that pays off on the release, since the dash's roll clip throws
      // it the other way.
      if (rig.tail) {
        const tw = weight * (p.tailWeight ?? 0.85);
        if (tw > 0.001) {
          rig.target(rig.tail, _target, 1, (p.tailUp ?? 0) * t, p.tailFore ?? -0.85, 0);
          applyChainToPoint(rig.tail, rawDt, ik, tw, 1, _target);
        }
      }

      rig.note();
      dirty = true;
    },

    /**
     * Drop the pose. The IK chains keep a smoothed pose across frames, so a
     * driver that isn't unprimed between runs would begin the next game
     * finishing the last one's coil.
     */
    reset() {
      rig.unprime();
      dirty = false;
    },

    finCount: rig.finCount,
    hasHead: rig.hasHead,
    hasTail: rig.hasTail,
  };
}
