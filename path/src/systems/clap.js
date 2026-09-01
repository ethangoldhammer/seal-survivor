import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { applyChainToPoint, smoothstep } from './ikChain.js';
import { createPoseRig } from './poseRig.js';
import { celebrationState } from './celebrate.js';
import { feedback } from './feedback.js';

// ============================================================================
// THE CLAP — a button that brings the seal's flippers together, on the frame
// it is pressed.
//
// It does nothing to the fight. No damage, no push, no meter: it is a thing
// the animal does because the player wanted it to, and the whole design brief
// is that it can be played to a beat. That single requirement is what makes it
// different from every other pose in this game, and it rules out the obvious
// implementation.
//
// -----------------------------------------------------------------------
// WHY NOT `playCelebration({ variant: 'clap' })`
//
// systems/celebrate.js already has a clap, and reaching for it was the first
// thing tried. It is wrong here for three reasons, all of them about time:
//
//   1. IT IS A PERFORMANCE, not a gesture. peak + hold + release is over a
//      second, and it fires a `celebrate` voice and opens the echo bus while
//      it runs. Pressed twice in a bar that is two celebrations overlapping.
//   2. IT CANNOT BE RE-FIRED. Each start bumps `seq`, and the entry snapshot
//      is re-captured on a `seq` change — so a second press mid-clap would
//      snapshot the CLAPPED pose as the thing to return to, which is the exact
//      ratchet systems/poseRig.js exists to prevent.
//   3. IT ANTICIPATES. The celebration's clap swings the flippers out and up
//      before closing them, because it is posing for a photograph and needs a
//      silhouette to watch the contact happen in. Anticipation is latency: a
//      wind-up is time between the button and the beat, and on a rhythm the
//      player is trying to hit it reads as the input being late.
//
// -----------------------------------------------------------------------
// ONE VALUE, AND WHY IT IS RE-ENTERED RATHER THAN RESTARTED
//
// The whole animation is a single number, `t`: 0 is "the flippers belong to
// the aim rig", 1 is "up, forward and touching". It drives the pose shape AND
// the blend weight, so at t=0 the clap contributes literally nothing and there
// is no seam to hide.
//
// `t` follows a one-shot envelope — a fast rise, a short hold at contact, a
// slower fall — and the interesting part is what a press does while one is
// already running. Restarting the clock would snap `t` back to 0 and the
// flippers would jump apart before closing again: a visible hitch, on exactly
// the input that has to feel immediate.
//
// So a press does not restart the envelope, it RE-ENTERS IT at the phase whose
// value matches the one already showing. `t` is therefore continuous across a
// re-trigger, and the attack runs at full speed from wherever it is — press
// again at 70% closed and the flippers finish closing in the remaining 30% of
// the attack rather than travelling the whole way again. That is the "cancel
// out of the tail" behaviour: no wasted travel, no wind-up, and the faster you
// clap the tighter the flutter gets, which is what clapping fast looks like.
//
// The re-entry needs the attack curve's INVERSE, which is why the attack is a
// smoothstep and not one of the named curves in ease.js: smoothstep is the
// useful ease with a closed-form inverse (see invSmoothstep). A curve picked
// from a pill list would have to be inverted by search, and a bisection in the
// input path is a strange thing to have to explain.
//
// -----------------------------------------------------------------------
// THE CLOCK IS WALL TIME, like systems/celebrate.js and for a sharper version
// of the same reason: a hit-stop or a kill shot must not stretch a gesture the
// player is timing against music. Music does not slow down.
// ============================================================================

const _target = new THREE.Vector3();

export const clapState = {
  // Is anything to be posed this frame.
  active: false,
  // 0..1 clapness — 0 is open and owned by the aim rig, 1 is contact. The one
  // number the pose reads, and the blend weight as well.
  t: 0,
  // WALL seconds into the current stroke. Re-entered, not reset — see above.
  clock: 0,
  // Every press that actually fired one, for the readouts and the tests.
  presses: 0,
  // Wall seconds between the last two presses, or Infinity before the second.
  // Purely a readout: nothing below reads it. It is here because "am I hitting
  // the beat" is the only question this feature exists to answer, and the
  // interval is the answer.
  gap: Infinity,
  // Wall seconds since the last press. Runs while nothing is clapping, which
  // is what the minimum-gap throttle measures against.
  since: Infinity,
};

function cfg() {
  return CONFIG.clap ?? {};
}

/**
 * smoothstep's inverse over 0..1, exactly.
 *
 * smoothstep is y = x^2(3 - 2x), a depressed cubic whose one root in [0,1] is
 * x = 1/2 - sin(asin(1 - 2y)/3). Exact in real arithmetic and good to about
 * 1e-14 in floating point over the whole range — `npm run test:clap` sweeps
 * the round trip, because a NEAR-inverse would put a jump of a few thousandths
 * into every re-trigger and read as the animation being crunchy rather than as
 * a wrong formula.
 *
 * This is the whole reason the attack curve is a smoothstep rather than
 * something chosen from ease.js — see the header.
 */
export function invSmoothstep(y) {
  // Clamped on the way IN and not on the way out: asin's domain is the only
  // place this can be handed something it cannot answer, and the identity
  // above never leaves 0..1 once the input is inside it. At the ends it comes
  // back 5.6e-17 off rather than exactly 0 or 1, which is a clock 3e-18
  // seconds into the attack — worth knowing about, not worth a branch.
  const c = Math.min(1, Math.max(0, y));
  return 0.5 - Math.sin(Math.asin(1 - 2 * c) / 3);
}

/** The stroke's three parts, clamped away from zero so nothing divides by it. */
function timings() {
  const c = cfg();
  return {
    attack: Math.max(0.001, c.attack ?? 0.06),
    hold: Math.max(0, c.hold ?? 0.04),
    release: Math.max(0.001, c.release ?? 0.22),
  };
}

/** `t` at a given point in the stroke. */
function envelopeAt(clock) {
  const { attack, hold, release } = timings();
  if (clock <= 0) return 0;
  if (clock < attack) return smoothstep(0, 1, clock / attack);
  if (clock < attack + hold) return 1;
  const out = (clock - attack - hold) / release;
  return out >= 1 ? 0 : 1 - smoothstep(0, 1, out);
}

/** How long a whole stroke lasts, from a press that starts one to fully open. */
export function clapDuration() {
  const { attack, hold, release } = timings();
  return attack + hold + release;
}

/**
 * CLAP NOW.
 *
 * Fires the feedback event on this very call rather than at the moment of
 * contact, and that is deliberate: the player's ear puts the clap where the
 * button went down, not where the flippers meet. A sound delayed to the
 * contact frame is a sound that is late against the music by exactly the
 * attack time, which is the one error this feature cannot afford. The attack
 * is short enough (60ms, four frames) that the picture catches up inside the
 * time it takes to notice.
 *
 * @param at  { x, y } for the sound and the burst — the caller's, because this
 *            module has no business reaching into entities/player.js. Pass the
 *            midpoint of the two flipper muzzles if you have it; that is where
 *            the hands are about to meet.
 * @returns true if a clap started or was re-entered, false if it was refused.
 */
export function triggerClap(at = {}) {
  const c = cfg();
  if (c.enabled === false) return false;
  // The victory lap owns the flippers outright, and it is posing for a
  // photograph. A clap fired into it would be overwritten anyway (the
  // celebration driver runs after this one), so refusing here is the honest
  // version of what would happen regardless — and it keeps the entry snapshots
  // of the two systems from being taken over each other's poses.
  if (celebrationState.active) return false;

  // A rate limit, not a cooldown: it exists so a held key's auto-repeat or a
  // mashed button cannot fire sixty sounds a second, and it is well under any
  // interval a person can actually play. Nothing about the pose is gated on
  // it — a refused press simply never happened.
  const minGap = c.minGap ?? 0.05;
  if (clapState.since < minGap) return false;

  clapState.gap = clapState.since;
  clapState.since = 0;
  clapState.presses++;

  // RE-ENTRY, not restart. Land on the point of the attack that already reads
  // as the `t` currently showing, so the flippers carry on from where they are
  // instead of jumping open first. See the header.
  const { attack } = timings();
  clapState.clock = clapState.active ? attack * invSmoothstep(clapState.t) : 0;
  clapState.active = true;
  clapState.t = envelopeAt(clapState.clock);

  feedback('clap', at);
  return true;
}

/**
 * @param rawDt UNSCALED seconds. Handing this a dilated delta stretches the
 *              gesture through a hit-stop, which is the one thing a beat
 *              cannot survive — see the header.
 */
export function updateClap(rawDt) {
  if (Number.isFinite(clapState.since)) clapState.since += rawDt;
  if (!clapState.active) return;
  // The celebration takes the flippers back mid-stroke rather than fighting
  // for them. Dropping `active` here (instead of leaving the driver to notice)
  // is what lets the driver put the bones back before the celebration captures
  // its own entry pose out of them.
  if (celebrationState.active) { endClap(); return; }
  clapState.clock += rawDt;
  if (clapState.clock >= clapDuration()) { endClap(); return; }
  clapState.t = envelopeAt(clapState.clock);
}

function endClap() {
  clapState.active = false;
  clapState.clock = 0;
  clapState.t = 0;
}

/** A new run, or a rebuilt model. Everything back to nothing. */
export function resetClap() {
  endClap();
  clapState.presses = 0;
  clapState.gap = Infinity;
  clapState.since = Infinity;
}

/**
 * Build the poser for one model instance.
 *
 * @returns null for a model with no aim rig, which every caller treats as
 *   "this creature doesn't clap".
 */
export function createClapDriver(instance) {
  const rig = createPoseRig(instance, 'clap');
  if (!rig) return null;

  // Is any of our pose currently sitting in the bones. The bones this rig has
  // to restore are the ones nothing else writes absolutely (see
  // systems/poseRig.js), so leftovers do not clean themselves up.
  let dirty = false;

  return {
    /**
     * Pose this frame. MUST run after the animation controller and after the
     * aim rig — those write an absolute pose every frame, so anything running
     * before them is simply overwritten — and BEFORE the celebration driver,
     * which is the one thing allowed to overrule a clap.
     *
     * @param rawDt UNSCALED seconds.
     */
    update(rawDt) {
      const t = clapState.active ? clapState.t : 0;

      // WHERE THE POSE'S ZERO COMES FROM, and this is the part that differs
      // from the victory lap.
      //
      // A celebration captures its entry pose once and holds it for the whole
      // performance, which is right for a second-and-a-half of authored
      // motion. A clap happens a hundred times a run, so a frozen zero would
      // mean the flippers snapping back to wherever the aim was on the press
      // of the FIRST clap, minutes ago.
      //
      // So the zero is re-taken every frame the flippers are fully open — at
      // which point the bones hold exactly what the aim rig just wrote, and
      // taking that as the reference costs nothing and keeps it following the
      // cursor. The moment the pose has anything in it, the reference is put
      // BACK instead, so the pose always grows out of one fixed thing and
      // cannot ratchet.
      //
      // The one case this does not refresh is a chain of claps so fast that
      // `t` never returns to 0 — above about three a second. The aim then
      // holds still for as long as the flutter lasts, which is the right
      // answer anyway: flippers going at that rate are not tracking a cursor.
      if (!clapState.active) {
        // Torn down mid-stroke (a celebration started, or the run ended). Put
        // the bones back exactly once, then go back to tracking.
        if (dirty) { rig.restore(); dirty = false; return; }
        rig.capture();
        return;
      }

      if (dirty) rig.restore();
      else rig.capture();

      if (t <= 0.001) return;

      const c = cfg();
      const p = c.pose ?? {};
      const ik = c.ik ?? {};
      const weight = Math.min(1, t * (c.weight ?? 1));
      if (weight <= 0.001) return;

      rig.refreshBasis();

      // The flippers come together as `t` rises; `bob` lifts the whole gesture
      // with it so the clap reads as the animal doing it rather than as two
      // limbs moving on their own.
      const bob = t * (p.bob ?? 0.1);
      const lateral = p.close ?? 0.06;
      for (const { chain, side } of rig.fins) {
        rig.target(chain, _target, side, (p.up ?? 0.3) + bob, p.fore ?? 0.55, lateral);
        applyChainToPoint(chain, rawDt, ik, weight, 1, _target);
      }

      // The head ducks toward them, at its own fraction of the weight — a seal
      // looks at its flippers when it claps, but not so far that it stops
      // tracking what it is pointed at. `headWeight: 0` retires the head from
      // the gesture entirely without touching the fins.
      if (rig.head) {
        const hw = weight * (p.headWeight ?? 0.6);
        if (hw > 0.001) {
          rig.target(rig.head, _target, 1, (p.headUp ?? 0.18) + bob, p.headFore ?? 0.85, 0);
          applyChainToPoint(rig.head, rawDt, ik, hw, 1, _target);
        }
      }

      dirty = true;
    },

    /**
     * Drop the pose. The IK chains keep a smoothed pose across frames, so a
     * driver that isn't unprimed between runs would begin the next game
     * finishing the last one's clap.
     */
    reset() {
      rig.unprime();
      dirty = false;
    },

    finCount: rig.finCount,
    hasHead: rig.hasHead,
  };
}
