import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { applyChainToPoint, smoothstep, tipWorld } from './ikChain.js';
import { createPoseRig } from './poseRig.js';
import { celebrationState } from './celebrate.js';
import { clapState } from './clap.js';
import { feedback } from './feedback.js';

// ============================================================================
// THE FLIP — a circle drawn with the aim hand, answered with a somersault and
// a tail slap.
//
// The gesture is input.circleFlick (see readCircle in input.js): the aim
// device's own movement, already collected for the dash flick, summed as a
// SIGNED TURN instead of as a direction. Counter-clockwise is a backflip,
// clockwise a forward flip — one input, two moves, and which one you get is
// the way your hand went round.
//
// It runs in both games and means the same thing in each. In Survivor the
// slap throws bodies (applyKnockback, at `knockGain` — the "extra" this move
// is for). In Blubberball it throws the ball and anybody standing in it. The
// geometry below is shared by both and knows about neither: it answers "where
// is the tail this frame and which way is it travelling", and each game's own
// file spends that answer on the things it has.
//
// ---------------------------------------------------------------------------
// WHY THIS IS NOT A CELEBRATION VARIANT, even though `flip` is one.
// ---------------------------------------------------------------------------
// systems/celebrate.js already somersaults the seal, and reaching for it was
// the first thing tried. It is wrong here for exactly the three reasons
// systems/clap.js gives for not using it either — it is a PERFORMANCE (over a
// second, with a voice and an echo bus), it CANNOT BE RE-FIRED, and it
// ANTICIPATES — plus a fourth that is this move's alone: a celebration has no
// hitbox and no moment. The whole point of this one is that a specific slice
// of the turn hits things.
//
// What it does borrow is the celebration's one real insight about rotation:
// THE SPIN IS NOT ENVELOPED. It eases monotonically to a whole number of
// turns, which is the identity, so the pose blends out by ARRIVING. An
// enveloped rotation would visibly unwind the somersault — spinning the seal
// backwards through the turn it just did — and there is no version of that
// which reads as anything but a bug.
//
// ---------------------------------------------------------------------------
// FOUR STATES, AND THE ONE THAT MATTERS IS THE THIRD
// ---------------------------------------------------------------------------
//
//   windup    the body gathers and counter-rotates a little. Anticipation,
//             which systems/clap.js refuses on purpose and this one needs: a
//             somersault with no gather reads weightless. It is also the only
//             part the player can feel as latency, so it is short and the
//             sound fires at the TRIGGER, not here.
//   spin      the turn itself, eased to `turns` whole revolutions.
//   slap      a WINDOW INSIDE THE SPIN, not a state after it — see below.
//             `slapAt` is a phase of the spin, so retuning the spin's length
//             keeps the slap on the same part of the arc.
//   recover   the tuck lets go. The rotation is already at identity, so this
//             state has nothing to undo and exists only for the pose.
//
// The slap is a window rather than a phase of its own because the tail does
// not stop to hit something. It is the part of the arc where the fluke is
// travelling fastest and is furthest from the body, and both of those are
// facts about the SPIN — expressing it as its own state would mean a second
// clock that has to be kept in step with the first, and the first thing to
// drift when the spin is retuned in the lab.
//
// ONE HIT PER BODY PER FLIP. The window is open for a tenth of a second and
// the test runs every frame inside it; without the ledger a double flip would
// hit the same shark six times and the knockback would read as a magnet.
//
// ---------------------------------------------------------------------------
// THE SLAP IS SPRINGY BECAUSE NOTHING HERE ANIMATES THE TAIL.
// ---------------------------------------------------------------------------
// The tail's motion is systems/boneSpring.js, hanging off the aim rig
// (tailImpulse in systems/aimRig.js) — a damped chain that chases whatever
// pose is already on it. So the slap does not pose the tail at all: it shoves
// the spring once, hard, at the top of the window, and the whip, the overshoot
// and the settle are the solver's. That is the same trick every hit reaction
// in this game uses, and it is why the slap looks like a tail and not like a
// bone rotating on a curve.
//
// ---------------------------------------------------------------------------
// THE CLOCK IS WALL TIME, like the clap and the victory lap. A hit-stop must
// not stretch a move the player is mid-gesture on — and this one can fire a
// hit-stop of its own, which would otherwise make the back half of a flip run
// at a quarter speed for having landed.
// ============================================================================

const _target = new THREE.Vector3();
const _tip = new THREE.Vector3();
const _dir = new THREE.Vector3();

export const flipState = {
  // Is a flip running. The pose, the spin and the window all hang off this.
  active: false,
  // +1 counter-clockwise (backflip), -1 clockwise (forward flip). This is the
  // BODY's sign — the mirror that keeps a left-swimming seal belly-down also
  // reverses what a local-Z turn looks like, so triggerFlip folds the facing
  // in and everything downstream is in the animal's own frame.
  dir: 1,
  // WALL seconds since the flip started. The clock is no longer the only thing
  // that moves the turn — see `u` below — but it is still what guarantees the
  // move finishes, and what the lab scrubs.
  clock: 0,
  // HOW FAR ROUND THE TURN IS, 0..1, and this is the field the animation
  // actually hangs off now.
  //
  // It is the MAXIMUM of two things: what the hand has drawn (the
  // follow-through, live) and what the clock has counted (eased). Monotonic,
  // because a turn that went backwards would be the seal unwinding under a
  // hand that merely slowed down.
  //
  // THAT MAX IS THE WHOLE CONTROL MODEL. Keep drawing and the hand leads —
  // the somersault goes exactly as fast as the circle you are making, which is
  // the difference between driving a move and setting one off. Stop, and the
  // clock catches up and finishes it: a flip can never stall half-rotated,
  // because there is no pose at 0.6 of a turn that the game could hand back to
  // ordinary swimming.
  u: 0,
  // The clock's own share, kept as an accumulation rather than derived from
  // `clock` — see the note in updateSealFlip on why a rate cannot jump when
  // the spin's length is retuned mid-flip and a position can.
  clockU: 0,
  // WHEN THE TURN LANDED, in the flip's own seconds. The recover is measured
  // from here rather than from a fixed point in the clock, because a turn the
  // hand brought round early has to be allowed to finish early.
  landedAt: 0,
  // HOW LOADED THE BODY IS BEFORE ANY FLIP EXISTS, 0..1, from the hand winding
  // through the first half of the circle (input.circleLoad). The gather is the
  // player's now: the seal coils as the semicircle is drawn, and the move
  // starts from wherever that got to.
  gather: 0,
  // Which way it is winding, +1/-1, or 0. The coil leans into the turn it is
  // about to become.
  gatherDir: 0,
  // ...and how loaded it was on the frame the move committed, which is what
  // the remaining wind-up is measured against. Held for the length of the
  // flip: `gather` itself stops being written the moment one starts.
  gatherAtTrigger: 0,
  // Which of the four the clock is in, as a name — for the readouts, the lab
  // and the harness. Nothing about the motion is gated on the string.
  phase: 'idle',
  // The slap window: open this frame, and whether its impulse has been spent.
  slapLive: false,
  slapFired: false,
  // THE LAUNCH — the frame the wind-up ends and the body throws itself, which
  // is where the two directions stop being the same move. A forward flip
  // spends it on momentum (flingSeal) and a backflip on a wall of goo; see
  // CONFIG.sealFlip.forward and .back, and the note below.
  //
  // THE FOLLOW-THROUGH, 0..1 — how much of the circle the hand carried on
  // drawing after the half turn that started this flip.
  //
  // Read LIVE while the body is still gathering and LOCKED at the launch, and
  // that window is the whole reason the wind-up exists: the gather is the
  // moment the player is still finishing the gesture, and what they finish it
  // with is what the somersault comes out as. After the launch the body has
  // committed and the hand cannot change it.
  //
  // It only ever goes UP within one flip (see noteFlipCommit): a hand that
  // stops halfway keeps what it earned rather than having it taken back, which
  // is the difference between a follow-through and a thing you have to hold.
  commit: 0,
  // Two fields because they answer two questions: `launched` is the latch
  // ("has this flip thrown yet"), and `launchEdge` is the direction it threw
  // in on exactly the frame it did — 0 on every other frame. One boolean
  // cannot do both, and a caller that polled the latch would spend the
  // momentum on every frame of the spin.
  launched: false,
  launchEdge: 0,
  // Every body this flip has already thrown. Cleared on the next trigger, not
  // at the window's close, so a long slap cannot double-count.
  hits: new Set(),
  // How far round the animal is, in radians, this frame. Held rather than
  // recomputed by each reader: the pose, the hit test and the body quaternion
  // all want it and they must not disagree.
  angle: 0,
  // ...AND HOW MUCH OF THAT TURN HAPPENED ON THIS FRAME. Signed, in radians.
  //
  // It is what lets a flip STEER A DASH (flipSteerDelta below): the dash's
  // held heading is turned by a share of it, so the line the seal is flying
  // curves at exactly the rate the animal is rolling. Kept as a delta rather
  // than derived by the caller because two readers differencing the same angle
  // on different frames is two readers disagreeing about the curve.
  turnDelta: 0,
  // Seconds until another flip may start, and seconds since the last one
  // began. `since` runs whether or not anything is flipping.
  cool: 0,
  since: Infinity,
  // WHOSE FLIP IT IS — the tag flipSpin() answers for, so an escort does not
  // somersault in sympathy with the player. Null outside a flip.
  only: null,
  // Tallies, for the readouts and the tests.
  flips: 0,
  slaps: 0,
  connected: 0,
  // The last slap that landed: { x, y, dirX, dirY, count } — what the debug
  // draw marks and what `npm run test:sealflip` reads.
  last: null,
};

function cfg() {
  return CONFIG.sealFlip ?? {};
}

/**
 * HOW SHARP THIS FLIP IS, 0..1 — the follow-through, or 1 when the feature is
 * off so nothing downstream has to branch on it.
 */
export function flipCommit() {
  const k = cfg().commit ?? {};
  if (k.enabled === false) return 1;
  return Math.max(0, Math.min(1, flipState.commit));
}

/** Lerp, because this file has three of them now. */
const mix = (a, b, t) => a + (b - a) * t;

/**
 * THE FOLLOW-THROUGH, FROM THE HAND. Called every frame while a flip is
 * gathering, with input.circleCommit.
 *
 * MONOTONIC WITHIN ONE FLIP, and that is the design rather than a guard: the
 * accumulator in input.js drops to 0 the moment the hand pauses or reverses,
 * and a commit that followed it down would mean a player who completed the
 * circle and then stopped moving got the LAZY flip — punished for having
 * finished the gesture. Taking the high-water mark means the back half of the
 * circle is banked as it is drawn.
 *
 * IT IS NOT LOCKED ANY MORE, and that is the point of the control model: the
 * follow-through DRIVES the turn (see `u` in flipState), so a hand still
 * circling is still pushing the somersault round. It was locked at the launch
 * when the turn ran on a clock and the commit only chose that clock's length —
 * a curve that could change shape under itself had to be frozen. Nothing
 * changes shape now; the hand simply gets further round.
 */
export function noteFlipCommit(v) {
  if (!flipState.active) return;
  const k = cfg().commit ?? {};
  if (k.enabled === false) return;
  const n = Math.max(0, Math.min(1, v ?? 0));
  if (n > flipState.commit) flipState.commit = n;
}

/**
 * The three parts of the turn, clamped away from zero so nothing divides by it.
 *
 * THE SPIN'S LENGTH IS THE FOLLOW-THROUGH'S, which is what "sharpness" means
 * here: the same whole turn, taken faster. A fully committed circle spins in
 * `spinFast` of the authored time and a half-drawn one takes `spinSlow` of it,
 * so the animation reads as a whip or as a roll and the player chose which
 * with their hand.
 *
 * SHORTENING THE CLOCK RATHER THAN STEEPENING THE EASE, on purpose. The angle
 * has to arrive at a whole number of turns (that is what lets the move end
 * with no unwind), and a curve reshaped mid-flight would move the animal
 * without time passing. A shorter clock keeps the same eased shape and simply
 * runs it sooner — and because `commit` is locked at the launch, the length
 * cannot change once the spin has started.
 */
function timings() {
  const c = cfg();
  const k = c.commit ?? {};
  const t = flipCommit();
  const spinMul = k.enabled === false ? 1 : mix(k.spinSlow ?? 1.45, k.spinFast ?? 0.8, t);
  return {
    // WHAT IS LEFT OF THE GATHER AFTER THE HAND'S OWN.
    //
    // The wind-up used to be the game's: the circle finished, and THEN the
    // seal spent a tenth of a second coiling. Two wind-ups, one of them the
    // player's and invisible, and the second one read as lag on the input.
    //
    // Now the semicircle before the engage coils the body live
    // (noteFlipGather), so this is only the remainder — a hand that drew the
    // whole half circle arrives fully loaded and the move goes on the frame it
    // commits. What is left covers the cases the hand cannot: a stick rolled
    // round its gate, a gesture completed faster than the body could follow.
    windup: Math.max(0, (c.windup ?? 0.09) * (1 - Math.min(1, flipState.gatherAtTrigger))),
    spin: Math.max(0.01, (c.spin ?? 0.46) * spinMul),
    recover: Math.max(0.001, c.recover ?? 0.2),
  };
}

/** How long a whole flip lasts, trigger to swimming. */
export function flipDuration() {
  const { windup, spin, recover } = timings();
  return windup + spin + recover;
}

/**
 * WHICH PART OF THE MOVE A CLOCK IS IN. Exported for the lab's state readout
 * and for the harness, both of which want to assert on the state machine
 * rather than on the numbers it produces.
 */
export function flipPhaseAt(clock) {
  const { windup } = timings();
  if (clock < windup) return 'windup';
  if (flipState.u < 1) return 'spin';
  return 'recover';
}

/**
 * HOW FAR ROUND THE ANIMAL IS, in radians about its own lateral axis, at a
 * given point on the clock. Pure, so the lab can ask for any phase and the
 * harness can sweep the whole curve without running a frame loop.
 *
 * The wind-up turns the SHORT way BACKWARDS (`gather` of a turn, negative),
 * and the spin then eases from there to `dir * turns * 2PI` — a whole number
 * of turns, which is the identity. Nothing after `windup + spin` moves: the
 * recover is the pose letting go, and by then the rotation is already home.
 */
export function flipAngleAt(u, dir = flipState.dir) {
  const c = cfg();
  const turns = Math.max(0, c.turns ?? 1);
  // WHERE THE TURN STARTS: the crouch the hand already wound the body into.
  // Not a canned gather any more — `gatherAngle` is whatever the player's own
  // semicircle loaded before the move committed, so the first frame of the
  // spin continues the motion instead of restarting it.
  const from = gatherAngle();
  const to = dir * Math.PI * 2 * turns;
  return from + (to - from) * Math.min(1, Math.max(0, u));
}

/**
 * HOW FAR THE BODY IS WOUND BACK RIGHT NOW, in radians — the player's own
 * wind-up, before any flip exists.
 *
 * `gather` is how far through the first semicircle the hand has got and
 * `gatherDir` which way it is going, so the body counter-rotates INTO the turn
 * it is about to make. Draw half a circle slowly and you can watch the seal
 * coil; stop, and it unwinds.
 *
 * This is also the angle a flip starts from (flipAngleAt above), which is what
 * makes the commit seamless: there is no jump between "winding" and "turning",
 * because the turn begins exactly where the winding got to.
 */
export function gatherAngle() {
  const c = cfg();
  const dir = flipState.active ? flipState.dir : flipState.gatherDir;
  if (!dir) return 0;
  return -dir * Math.PI * 2 * (c.gather ?? 0.045) * Math.min(1, Math.max(0, flipState.gather));
}

/**
 * THE HAND WINDING UP, before there is anything to call a flip.
 *
 * Called every frame with input.circleLoad and input.circleDir. Eased toward
 * the hand rather than snapped to it, because the accumulator in input.js
 * drops to zero the instant a hand pauses — a body that followed that exactly
 * would flick straight out of its crouch on any stutter in the mouse.
 *
 * DOES NOTHING WHILE A FLIP IS RUNNING: from the engage onward the same hand
 * means the follow-through instead (noteFlipCommit), and the gather is frozen
 * at whatever it reached so the turn can start from it.
 */
export function noteFlipGather(load, dir, rawDt) {
  const c = cfg();
  const g = c.gatherFeel ?? {};
  if (c.enabled === false || flipState.active) return;
  const want = Math.max(0, Math.min(1, load ?? 0));
  if (want > 0 && dir) flipState.gatherDir = dir;
  // Toward the hand quickly and away from it slowly: winding is the player
  // doing something and unwinding is them stopping, and the second should read
  // as the body relaxing rather than as the input being dropped.
  const rate = want > flipState.gather ? (g.windIn ?? 22) : (g.windOut ?? 6);
  const k = 1 - Math.exp(-Math.max(0.01, rate) * Math.max(0, rawDt ?? 0));
  flipState.gather += (want - flipState.gather) * k;
  if (flipState.gather < 1e-3 && want === 0) { flipState.gather = 0; flipState.gatherDir = 0; }
}

/**
 * HOW TUCKED, 0..1 — the pose's shape AND its blend weight, the same
 * arrangement systems/clap.js uses and for the same reason: at 0 the pose
 * contributes literally nothing and there is no seam to hide.
 *
 * Up over the wind-up, held through the spin, out over the recover. Anything
 * that means to rotate fast tucks, and it has to be fully tucked BEFORE the
 * turn starts or the flippers trail through the first quarter of it.
 */
export function flipTuckAt(clock) {
  const { windup, recover } = timings();
  // IN WITH THE WIND-UP, which the hand has usually already done — a body that
  // was coiled by the player arrives at the commit most of the way tucked, and
  // `windup` is only the remainder (see effectiveWindup).
  if (clock < windup) {
    const w = Math.max(1e-4, windup);
    return Math.max(flipState.gather, smoothstep(0, 1, clock / w));
  }
  // HELD FOR THE WHOLE TURN, however fast the hand takes it round: the tuck is
  // "the animal is committed", and the thing that ends it is arriving, not a
  // clock running out.
  if (flipState.u < 1) return 1;
  // ...and out over the recover, which starts when the turn LANDS.
  const out = (clock - flipState.landedAt) / recover;
  return out >= 1 ? 0 : 1 - smoothstep(0, 1, out);
}

/**
 * THE SLAP WINDOW, as two points on the clock. `slapAt` is a PHASE OF THE
 * SPIN (0..1) rather than a time, so moving the spin's length keeps the slap
 * on the same part of the arc — see the header.
 */
export function flipSlapWindow() {
  const c = cfg();
  const at = Math.min(1, Math.max(0, c.slapAt ?? 0.42));
  const span = Math.max(0.02, c.slapSpan ?? 0.18);
  return { open: at, close: Math.min(1.0001, at + span) };
}

/**
 * RADIANS ABOUT THE BODY'S LOCAL Z, for entities/player.js to fold into the
 * body quaternion alongside the celebration's somersault and the jolt.
 *
 * Asked, not pushed — the same contract celebrationSpin has, and for the same
 * reason: one transform, one writer, and a pure function of the shared clock
 * cannot accumulate a spin into the seal on a frame where the caller happens
 * not to run.
 *
 * `tag` is the seal asking. A flip belongs to the player that gestured, so an
 * escort does not somersault in sympathy.
 */
export function flipSpin(tag = null) {
  // THE COIL SHOWS BEFORE THE FLIP DOES. While the hand is drawing the first
  // semicircle there is no flip yet, and the body is already winding back into
  // it (gatherAngle) — that is the half of this gesture the player could not
  // see before, and it is what makes the commit read as a continuation rather
  // than as a move starting.
  //
  // Answered for the run's own seal (tag null) only, like the flip itself: an
  // escort does not coil because the player is drawing a circle.
  if (!flipState.active) return tag === null ? gatherAngle() : 0;
  if ((flipState.only ?? null) !== tag) return 0;
  return flipState.angle;
}

/**
 * FLIP NOW.
 *
 * @param dir   +1 counter-clockwise on screen, -1 clockwise — the sign of the
 *              turn the hand drew (input.circleFlick).
 * @param at    { x, y } for the sound and the water. The caller's, because
 *              this module has no business reaching into entities/player.js.
 * @param facingLeft  is the animal mirrored. The mirror that keeps a
 *              left-swimming seal belly-down also reverses what a local-Z
 *              turn looks like on screen, so it is folded in HERE, once,
 *              rather than left for the pose and the hit test to each get
 *              right separately. With `mirrorWithFacing` off the sign is
 *              taken as the body's and a backflip is a backflip whichever way
 *              the seal is pointing — which is the more literal reading of
 *              the move's name and the less literal reading of the gesture.
 * @param only  the seal this flip belongs to; flipSpin(tag) answers for it
 *              alone.
 * @returns true if a flip started, false if it was refused.
 */
export function triggerFlip(dir, at = {}, facingLeft = false, only = null) {
  const c = cfg();
  if (c.enabled === false) return false;
  // COMMITTED, UNLIKE A CLAP. The clap re-enters itself because it is a
  // rhythm; this is a move with a hitbox in it, and a flip that could be
  // re-triggered mid-turn would be a slap window the player could hold open
  // by drawing circles. A second circle during one is simply not a second
  // flip.
  if (flipState.active) return false;
  if (flipState.cool > 0) return false;
  // The victory lap owns the whole animal and is posing for a photograph; the
  // clap owns the flippers. Both would be overwritten anyway (their drivers
  // run after this one), so refusing here is the honest version of what would
  // happen regardless.
  if (celebrationState.active) return false;

  const sign = dir >= 0 ? 1 : -1;
  flipState.dir = (c.mirrorWithFacing === false || !facingLeft) ? sign : -sign;
  flipState.clock = 0;
  flipState.u = 0;
  flipState.clockU = 0;
  flipState.landedAt = 0;
  flipState.landedAt = 0;
  flipState.active = true;
  flipState.phase = 'windup';
  flipState.angle = 0;
  flipState.turnDelta = 0;
  flipState.slapLive = false;
  flipState.slapFired = false;
  flipState.launched = false;
  flipState.launchEdge = 0;
  flipState.commit = 0;
  flipState.hits.clear();
  flipState.only = only;
  // HOW MUCH OF THE GATHER THE PLAYER ALREADY DID, frozen here — the wind-up
  // left to run is the remainder. A hand that drew the full semicircle has
  // none left and the body throws itself on this very frame.
  flipState.gatherAtTrigger = Math.min(1, Math.max(0, flipState.gather));
  flipState.since = 0;
  flipState.cool = Math.max(flipDuration(), c.cooldown ?? 0.55);
  flipState.flips++;

  // ON THE TRIGGER, not on the wind-up's end — the same rule triggerClap
  // follows. The player's ear puts the move where their hand finished the
  // circle, and a voice delayed to the first frame of the turn is late by
  // exactly the anticipation this move deliberately has.
  feedback('sealFlip', at);
  return true;
}

/**
 * One frame of the move.
 *
 * @param rawDt UNSCALED seconds — see the header. A dilated delta stretches
 *              the gesture through a hit-stop the slap itself may have caused.
 * @param rig   the seal's aim rig, for the tail impulse. Optional: the harness
 *              has no bones and the move still runs.
 * @returns true on the frame the slap window OPENS, so the caller can fire the
 *          water and the sound exactly once. Reported rather than left to the
 *          caller to spot, because `slapLive` is true for the whole window and
 *          a caller comparing it frame to frame would fire on the frame it
 *          CLOSED as readily as on the one it opened.
 */
export function updateSealFlip(rawDt, rig = null) {
  if (Number.isFinite(flipState.since)) flipState.since += rawDt;
  if (flipState.cool > 0) flipState.cool = Math.max(0, flipState.cool - rawDt);
  if (!flipState.active) return false;

  // The lap takes the animal back mid-turn rather than fighting for it.
  // Dropping out here (rather than leaving the driver to notice) is what lets
  // the pose be put back before the celebration captures its own entry pose
  // out of our tuck.
  if (celebrationState.active) { endFlip(); return false; }

  const wasLive = flipState.slapLive;
  flipState.clock += rawDt;
  // THE MOVE ENDS WHEN THE TURN HAS LANDED AND THE POSE HAS LET GO, not at a
  // fixed duration — the hand can bring the turn round in half the time the
  // clock would have taken, and a flip held open for the rest of it would be a
  // seal standing in a finished somersault.
  if (flipState.u >= 1
    && flipState.clock - flipState.landedAt >= timings().recover) { endFlip(); return false; }
  // ...and a hard ceiling, for the case nothing else covers: a spin whose
  // fallback clock has been tuned to something enormous, with a hand that
  // stopped drawing on the first frame.
  if (flipState.clock >= flipDuration() * 2) { endFlip(); return false; }

  // THE LAUNCH — and it is usually the FIRST frame now, because the wind-up is
  // the player's. `effectiveWindup` is what is LEFT of the canned gather after
  // the hand's own semicircle: draw the full half circle and the body is
  // already coiled, so the move goes immediately and the "slight delay" is
  // gone. Let go early, or arrive on a stick that cannot wind, and the animal
  // spends the remainder coiling on its own.
  flipState.launchEdge = 0;
  if (!flipState.launched && flipState.clock >= timings().windup) {
    flipState.launched = true;
    flipState.launchEdge = flipState.dir;
  }

  // ---- HOW FAR ROUND: the hand, or the clock, whichever is further ----------
  //
  // The hand LEADS while it is drawing — `commit` is the follow-through, live,
  // so the somersault turns exactly as fast as the circle being made. The
  // clock is the floor under it, eased, and it is what finishes a flip whose
  // player has moved on: there is no pose at 0.6 of a turn that the game could
  // hand back to ordinary swimming.
  //
  // THE CLOCK IS ACCUMULATED AS A RATE, not derived as a position. `spin` is
  // shortened by the same follow-through that is driving the hand's share, so
  // a position computed from the clock would jump forward every time the
  // player drew a little more. A rate changes speed instead, which is what a
  // player pushing a body round actually feels.
  if (flipState.launched) {
    const { spin } = timings();
    flipState.clockU = Math.min(1, flipState.clockU + rawDt / Math.max(0.01, spin));
    // THE HAND MAY LEAD, BUT IT MAY NOT TELEPORT. The follow-through is a
    // position (how far round the circle the hand is) and `u` is a body, so
    // without a rate the two are the same thing and a player whose hand is
    // already three quarters round when the move commits snaps the seal
    // through three quarters of a somersault in one frame.
    //
    // That is not only ugly. `turnDelta` is the fluke's velocity, which throws
    // the goo and sizes the slap, so one snapped frame reports a tail moving
    // at 650 u/s and flings the wall's mass clean off its own hitbox — which
    // is how this was found (`npm run test:sealflip` measures the coast).
    //
    // `handRate` is a ceiling in TURNS PER SECOND. High enough that a real
    // hand never touches it — a circle drawn in a third of a second is three
    // turns a second — and low enough that a jump becomes a fast sweep.
    const k = cfg().commit ?? {};
    const cap = flipState.u + Math.max(0.1, k.handRate ?? 4) * rawDt;
    const handU = Math.min(flipCommit(), cap);
    const next = Math.max(flipState.u, smoothstep(0, 1, flipState.clockU), handU);
    if (next >= 1 && flipState.u < 1) flipState.landedAt = flipState.clock;
    flipState.u = Math.min(1, next);
  }

  flipState.phase = flipPhaseAt(flipState.clock);
  const wasAngle = flipState.angle;
  flipState.angle = flipAngleAt(flipState.u, flipState.dir);
  flipState.turnDelta = flipState.angle - wasAngle;

  // THE SLAP IS A SLICE OF THE TURN, not of the clock. Whip the circle round
  // and the tail connects sooner, because it has physically got there sooner —
  // which is the whole of what "the hand drives it" has to mean once anything
  // in the move can hit something.
  const { open, close } = flipSlapWindow();
  flipState.slapLive = flipState.launched && flipState.u >= open && flipState.u < close;
  const opened = flipState.slapLive && !wasLive && !flipState.slapFired;

  if (opened) {
    flipState.slapFired = true;
    flipState.slaps++;
    // THE TAIL IS SHOVED, NOT POSED — see the header. One impulse, at the top
    // of the window, along the way the fluke is already travelling; the whip
    // and the settle are systems/boneSpring.js's.
    if (rig?.tailImpulse) {
      const c = cfg();
      const a = flipState.angle;
      // The tangent of the turn at this instant, in the body's own frame: the
      // direction the tip is MOVING, which is what a slap is. Turned into the
      // rig's world axes by the caller's own basis would be a second place to
      // get the mirror right, so it goes through the same local Z the spin
      // does and the instance's matrix carries it.
      _dir.set(-Math.sin(a) * flipState.dir, Math.cos(a) * flipState.dir, 0);
      rig.tailImpulse(_dir, c.tailImpulse ?? 18);
    }
  }
  return opened;
}

function endFlip() {
  flipState.active = false;
  flipState.clock = 0;
  flipState.u = 0;
  flipState.clockU = 0;
  flipState.phase = 'idle';
  flipState.angle = 0;
  flipState.turnDelta = 0;
  flipState.slapLive = false;
  flipState.slapFired = false;
  flipState.launched = false;
  flipState.launchEdge = 0;
  flipState.commit = 0;
  flipState.only = null;
}

/** A new run, or a rebuilt model. Everything back to nothing. */
export function resetSealFlip() {
  endFlip();
  flipState.gather = 0;
  flipState.gatherDir = 0;
  flipState.gatherAtTrigger = 0;
  flipState.hits.clear();
  flipState.cool = 0;
  flipState.since = Infinity;
  flipState.flips = 0;
  flipState.slaps = 0;
  flipState.connected = 0;
  flipState.last = null;
}

// --- the hitbox -------------------------------------------------------------
//
// A SEGMENT, NOT A CIRCLE, and this is the one geometric decision in the file.
//
// A radius around the seal would hit everything level with it, which is not
// what a tail slap is: the fluke is on ONE SIDE of the animal at any instant,
// and being on the other side of a flipping seal has to be safe or there is
// nothing to read and nothing to dodge. So the test is the tail's own line —
// from the body out to the tip, thickened by `thick` — swept over the window.
//
// The tail's direction is the spin's angle plus a half turn, because the tail
// is behind the head: at angle 0 a seal swimming +X has its fluke at -X.

/** Held, because this runs per enemy per frame inside an open window. */
const _slap = { ax: 0, ay: 0, bx: 0, by: 0, dirX: 0, dirY: 0 };

/** Held for the same reason — the wall asks for this every frame it is laid. */
const _tail = { x: 0, y: 0, angle: 0, vx: 0, vy: 0, speed: 0 };

/**
 * WHERE THE FLUKE IS RIGHT NOW, in world space — at any point in the flip, not
 * only while the slap window is open.
 *
 * The backflip's wall is emitted off this (systems/gooWall.js), one node per
 * frame as the tail sweeps, so the mass lands along the arc the tail actually
 * cut rather than in a bar somebody typed.
 *
 * THE SAME TWO TERMS flipSlapSegment uses, and that is the point: the goo the
 * player sees and the hitbox it becomes are the same curve by construction. A
 * wall painted off the real BONE and collided against a computed arc would be
 * two answers to one question, and the bone is not there at all in Node
 * ([[a harness measures the stand-in, not the model]]).
 *
 * ...AND HOW FAST IT IS GOING, which is what the goo inherits. The fluke is
 * the fastest thing on the animal by a distance — a whole turn of a five-unit
 * tail in a fifth of a second is the tip covering 33 units, around 80 u/s —
 * and goo thrown off it should leave along that, not drop out of it. Derived
 * from the turn the body actually made this frame (`turnDelta`) rather than
 * differenced from the last position by the caller, so there is one answer.
 *
 * @param dt  the frame's seconds, for the velocity. Omit it (or pass 0) and
 *   the position is still right and the velocity comes back zero, which is
 *   what a caller that only wants a point should get.
 * @returns a held { x, y, angle, vx, vy, speed } — the fluke's position, the
 *   world angle of the tail (what an emitter throws along), and its motion.
 */
export function flipTailPoint(x, y, heading, dt = 0) {
  const c = cfg();
  const a = heading + flipState.angle + Math.PI;
  const reach = Math.max(0.1, c.reach ?? 5.2);
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  _tail.angle = a;
  _tail.x = x + ca * reach;
  _tail.y = y + sa * reach;
  // TANGENTIAL, because the tail is swinging about the body rather than
  // travelling: at a point on a turning radius the velocity is perpendicular
  // to the radius, at angular speed times the reach. The sign falls out of
  // `turnDelta` on its own, so a forward flip throws its goo the other way
  // round without a branch.
  const w = dt > 0 ? flipState.turnDelta / dt : 0;
  _tail.vx = -sa * w * reach;
  _tail.vy = ca * w * reach;
  _tail.speed = Math.abs(w) * reach;
  return _tail;
}

/**
 * IS THE TAIL LAYING GOO THIS FRAME — the span of the spin a backflip smears
 * its wall across, as a phase of the spin (0 at the launch, 1 at the end).
 *
 * NOT THE WHOLE TURN, on purpose. The fluke sweeps a full circle around the
 * animal, and goo laid along all of it is a RING with the seal in the middle —
 * which is a bubble to stand in rather than a wall to retreat behind. A span
 * cuts one arc out of that circle, and `emitFrom`/`emitTo` are where the swipe
 * starts and stops.
 */
export function flipTailLaying() {
  const b = cfg().back ?? {};
  if (b.enabled === false || !flipState.active || flipState.dir < 0) return false;
  if (!flipState.launched) return false;
  // ON THE TURN, not on the clock — the wall is the arc the tail cut, so the
  // span it is laid across has to be measured in arc. A hand that whips the
  // circle round lays the same wall in less time rather than a shorter one.
  return flipState.u >= (b.emitFrom ?? 0.08) && flipState.u <= (b.emitTo ?? 0.62);
}

/**
 * HAS THE TAIL FINISHED LAYING — past the end of the span, as opposed to not
 * having reached the start of it yet.
 *
 * The two are the same answer from flipTailLaying and they must not be the
 * same answer to the caller: "not yet" means keep the wall open and "finished"
 * means seal it. Told apart by the clock alone, and the failure of conflating
 * them is silent and total — the wall is sealed on the frame it is opened,
 * before a single blob has been laid, and the move does nothing at all while
 * every test of the wall itself still passes.
 */
export function flipTailSpent() {
  const b = cfg().back ?? {};
  if (!flipState.active) return true;
  return flipState.launched && flipState.u > (b.emitTo ?? 0.62);
}

/**
 * WHERE THE TAIL IS, in world space, for a seal at (x, y) heading `heading`
 * radians, on the flip's current frame.
 *
 * Returns a held { ax, ay, bx, by, dirX, dirY } — the segment from the body to
 * the fluke, and the unit direction the tip is travelling — or null when no
 * window is open. `reach` is in world units and wants to be about the animal's
 * own length; the seal is not scaled per-run, so a literal is honest here in a
 * way it would not be on a creature ([[assets carry a size multiplier]]).
 *
 * Pure apart from the module state it reads, so tools/seal-flip-test.mjs can
 * sweep the whole arc with no bones, no scene and no three.js.
 */
export function flipSlapSegment(x, y, heading) {
  if (!flipState.slapLive) return null;
  const c = cfg();
  const reach = Math.max(0.1, c.reach ?? 5.2);
  // The tail's world angle: the heading, plus the flip's turn, plus the half
  // turn that puts the fluke behind the head.
  const a = heading + flipState.angle + Math.PI;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  _slap.ax = x + ux * (c.inner ?? 0.8);
  _slap.ay = y + uy * (c.inner ?? 0.8);
  _slap.bx = x + ux * reach;
  _slap.by = y + uy * reach;
  // WHICH WAY THE SLAP THROWS: mostly the way the tip is travelling (the
  // tangent, a quarter turn ahead of the radius in the spin's direction) and
  // partly straight out from the body. Pure tangent threw bodies across the
  // seal's own path, which reads as the water moving rather than as a hit;
  // pure radial is a blast and has no handedness at all, so the two flips
  // became the same move.
  const tx = -uy * flipState.dir;
  const ty = ux * flipState.dir;
  const mix = Math.min(1, Math.max(0, c.tangentMix ?? 0.72));
  const dx = tx * mix + ux * (1 - mix);
  const dy = ty * mix + uy * (1 - mix);
  const len = Math.hypot(dx, dy) || 1;
  _slap.dirX = dx / len;
  _slap.dirY = dy / len;
  return _slap;
}

/**
 * HOW FAR A POINT IS FROM THE TAIL'S LINE — the SEGMENT distance, so a body
 * anywhere along the tail counts and not just one sitting on the fluke. The
 * caller adds its own radius to whatever this returns, which is what lets
 * Blubberball test the ball's DRAWN edge rather than a circle.
 *
 * @returns the distance, or Infinity when no window is open.
 */
export function flipSlapDistance(x, y, heading, px, py) {
  const s = flipSlapSegment(x, y, heading);
  if (!s) return Infinity;
  const ex = s.bx - s.ax;
  const ey = s.by - s.ay;
  const len2 = ex * ex + ey * ey;
  const t = len2 > 1e-9
    ? Math.max(0, Math.min(1, ((px - s.ax) * ex + (py - s.ay) * ey) / len2))
    : 0;
  return Math.hypot(px - (s.ax + ex * t), py - (s.ay + ey * t));
}

/**
 * Has this flip already thrown `key`, and book it if not. One hit per body per
 * flip — see the header. The key is the entity itself; the Set is cleared on
 * the next trigger rather than at the window's close, so a body hit at the top
 * of the window cannot be hit again at the bottom of it.
 */
export function claimFlipHit(key) {
  if (!key || flipState.hits.has(key)) return false;
  flipState.hits.add(key);
  return true;
}

/** Book a landed slap, for the readouts and the debug draw. */
export function noteFlipConnect(hit = null) {
  flipState.connected++;
  flipState.last = hit;
}

/**
 * THE LIT WEAK SPOT THE TAIL IS LYING ACROSS, or null.
 *
 * The same segment test the bodies go through, run against each spot's own
 * centre and radius — so a slap connects with a weak spot on exactly the terms
 * it connects with anything else, and there is no second opinion about where
 * the tail is ([[paired reaches must measure alike]] is about precisely this
 * going wrong).
 *
 * THE SPOTS ARE PASSED IN rather than looked up, and that is deliberate twice
 * over: this file has no business importing the boss's systems, and a harness
 * can hand it three plain `{ x, y, r }` objects and measure the rule without a
 * boss, a scene or a GLB.
 *
 * `spots` is whatever systems/bossHotSpots.js calls lit — hotSpotPoint() shape.
 * NEAREST WINS, because a tail long enough to cross two of them is a tail that
 * hit the animal once.
 */
export function flipWeakSpot(x, y, heading, spots) {
  if (!flipState.slapLive || !spots?.length) return null;
  const c = cfg();
  const thick = Math.max(0, c.thick ?? 1.6);
  let best = null;
  let bestD = Infinity;
  for (const s of spots) {
    if (!s) continue;
    const d = flipSlapDistance(x, y, heading, s.x, s.y);
    if (d > thick + (s.r ?? 0) || d >= bestD) continue;
    bestD = d;
    best = s;
  }
  return best;
}

/**
 * WHAT THE SLAP MULTIPLIES A SHOVE BY — the "extra" in "extra knockback",
 * falling off along the tail.
 *
 * The fluke is moving several times faster than the base of the tail and
 * carries the water with it, so a body caught at the tip is thrown hardest.
 * Measured on the fraction of `reach` the contact sat at, which is the only
 * term in this file that is about the slap being a LEVER rather than a shape.
 *
 * @param along 0 at the body, 1 at the fluke.
 * @param onWeakSpot did the tail cross a lit weak spot (flipWeakSpot).
 */
export function flipKnockGain(along = 1, onWeakSpot = false) {
  const c = cfg();
  const k = c.commit ?? {};
  const base = c.knockGain ?? 2.2;
  const root = c.knockGainRoot ?? 0.55;
  const lever = (root * base + (1 - root) * base * Math.min(1, Math.max(0, along)))
    // ...AND WHAT THE HAND FINISHED. A tail travelling faster hits harder, so
    // the same follow-through that sharpens the spin is what the slap is worth
    // — one gesture, one number, two things it buys. `hitSlow` is what half a
    // circle is worth against a full one.
    * (k.enabled === false ? 1 : mix(k.hitSlow ?? 0.6, k.hitFast ?? 1.15, flipCommit()));
  // THE WEAK SPOT MULTIPLIES THE LEVER RATHER THAN REPLACING IT, so a spot
  // caught on the fluke still beats one grazed with the base of the tail —
  // the two things the move asks the player to get right compose instead of
  // one of them deleting the other.
  return onWeakSpot ? lever * Math.max(0, c.weakSpotMul ?? 1) : lever;
}

// --- the pose ---------------------------------------------------------------

/**
 * Build the poser for one model instance.
 *
 * @returns null for a model with no aim rig, which every caller treats as
 *   "this creature doesn't flip".
 */
export function createFlipDriver(instance, tag = null) {
  const rig = createPoseRig(instance, 'sealFlip');
  if (!rig) return null;

  // Is any of our pose currently sitting in the bones. The bones this rig has
  // to restore are the ones nothing else writes absolutely (systems/poseRig.js),
  // so leftovers do not clean themselves up.
  let dirty = false;

  return {
    /**
     * Pose this frame. MUST run after the animation controller and after the
     * aim rig — those write an absolute pose every frame — and BEFORE the
     * celebration driver, which is allowed to overrule anything.
     *
     * The ROTATION is not written here: entities/player.js folds flipSpin()
     * into the body quaternion, for the same "one transform, one writer"
     * reason the somersault is asked for rather than pushed.
     *
     * @param rawDt UNSCALED seconds.
     */
    update(rawDt) {
      // WHOSE FLIP IT IS, asked here and not only by flipSpin — the driver is
      // the half that poses BONES, and a flip belongs to the seal that drew
      // the circle. Only the player has a driver today, so this changes
      // nothing in the game; it changed a harness, where a control seal built
      // the same way tucked in sympathy and measured identical to the animal
      // under test, which is a passing test that proves nothing.
      //
      // The same contract createCelebrationDriver's tag has, and it is worth
      // having for the same reason: in Blubberball a second seat will one day
      // get one of these, and the failure would be four seals somersaulting
      // together rather than anything that looks like a bug.
      const mine = flipState.active && (flipState.only ?? null) === tag;
      const t = mine ? flipTuckAt(flipState.clock) : 0;

      if (!mine) {
        // Torn down mid-turn (a celebration started, or the run ended). Put
        // the bones back exactly once, then go back to tracking the aim.
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

      // TUCKED, the way anything that means to rotate fast tucks: flippers in
      // against the body and slightly back, head down. Every number is a
      // fraction of that limb's OWN reach (systems/poseRig.js), so it is right
      // on both flippers despite the rig not being symmetric.
      for (const { chain, side } of rig.fins) {
        rig.target(chain, _target, side, p.tuckUp ?? 0.06, p.tuckFore ?? -0.22, p.tuck ?? 0.3);
        applyChainToPoint(chain, rawDt, ik, weight, 1, _target);
      }

      if (rig.head) {
        const hw = weight * (p.headWeight ?? 0.7);
        if (hw > 0.001) {
          rig.target(rig.head, _target, 1, p.headUp ?? -0.3, p.headFore ?? 0.45, 0);
          applyChainToPoint(rig.head, rawDt, ik, hw, 1, _target);
        }
      }

      dirty = true;
    },

    /**
     * WHERE THE FLUKE ACTUALLY IS, in world space — for the debug draw and for
     * the lab, which marks it. The hit test does NOT use this: it runs in
     * Node, where there are no bones, and a hitbox that only exists when a GLB
     * has loaded is a hitbox no harness can measure
     * ([[a harness measures the stand-in, not the model]]).
     */
    tip(out = _tip) {
      if (!rig.tail) return null;
      return tipWorld(rig.tail, out);
    },

    /**
     * Drop the pose. The IK chains keep a smoothed pose across frames, so a
     * driver that isn't unprimed between runs would begin the next game
     * finishing the last one's flip.
     */
    reset() {
      rig.unprime();
      dirty = false;
    },

    hasTail: rig.hasTail,
    finCount: rig.finCount,
  };
}

/**
 * DID THE BODY THROW ITSELF ON THIS FRAME — the one moment the two directions
 * stop being the same move.
 *
 * A FORWARD FLIP IS A COMMITMENT. It fires `flingSeal` down the line the seal
 * is already swimming: real velocity with the speed ceiling lifted, which is
 * the one call in this game that may put a seal above its own top speed. That
 * is deliberately the same mechanism a goal explosion uses, because it is the
 * same physical claim — the animal is thrown, and everything downstream (the
 * water's drag, the arena's walls, gravity on the vertical share) then acts on
 * it. It is also why a flip into a ball hits harder without a line of code
 * about balls: sealContact reads `player.velocity`, and the fling is IN it.
 *
 * A BACKFLIP IS THE OPPOSITE GESTURE and leaves a wall (systems/gooWall.js).
 *
 * AT THE END OF THE WIND-UP, not at the slap and not at the trigger. The
 * gather is the anticipation — the body loading — and the throw is what it was
 * loading for; firing at the trigger would be a shove with no tell, and firing
 * at the slap would put the momentum a third of a second after the gesture.
 *
 * WHO SPENDS IT: entities/main.js, because the momentum belongs to the player
 * and the wall belongs to the scene, and this module knows about neither.
 *
 * @returns +1 on the frame a backflip launches, -1 for a forward flip, 0 on
 *   every other frame. The sign is `flipState.dir`, so a caller switches on it
 *   the same way everything else in this file does. Safe to ask more than once
 *   in a frame — it is a field, not a consumed edge.
 */
export function flipLaunch() {
  return flipState.active ? flipState.launchEdge : 0;
}

// --- flipping out of a dash ------------------------------------------------
//
// A FLIP MAY BE THROWN MID-STRIKE, and the two compose rather than one
// cancelling the other. That is not a special case bolted on: it is the whole
// reason this move is a gesture and not a button.
//
// THE PROBLEM IT SOLVES. A dash is steered by the aim hand's MOVEMENT
// (holdAim in systems/strike.js — a flick up steers up), and a circle is a
// hand moving continuously in every direction. Read as steering, a circle
// drawn mid-dash corkscrewed the seal: the held aim chased the hand round the
// loop and the line came apart. The gesture and the steering were reading the
// same motion and answering different questions with it.
//
// SO THE FLIP TAKES THE WHEEL. While one is turning, the dash stops reading
// the hand at all and its heading is turned by a share of the SOMERSAULT
// instead — `steer` of the angle the body actually rolled this frame. The
// curve is then exactly as fast as the animal is spinning, which is why it
// reads as one move rather than as two: the seal is not being pushed round a
// corner, it is rolling and going where it rolls.
//
// WHAT THE PLAYER GETS. A dash is a straight line the moment it launches; a
// dash with a flip in it is an ARC whose direction is the direction of the
// circle they drew and whose radius is theirs to time. Thrown early the whole
// dash curves; thrown late it hooks at the end. Both flips are available out
// of any dash, so the same launch can be bent either way after it has left.

/**
 * HOW FAR TO TURN A DASH'S HELD AIM THIS FRAME, in radians. 0 when nothing is
 * flipping or when the feature is off.
 *
 * Read once per frame by holdAim (systems/strike.js) and by nothing else. It
 * is a DELTA, so a frame this is not read on is a frame of curve the dash
 * simply does not get — the alternative is a stored target that a dropped
 * frame turns into a lurch.
 */
export function flipSteerDelta() {
  const d = cfg().duringStrike ?? {};
  if (d.enabled === false || !flipState.active) return 0;
  return flipState.turnDelta * (d.steer ?? 0.35);
}

/**
 * WHAT A SLAP THROWN OUT OF A DASH IS WORTH, as a multiplier on the knockback
 * and as a share of the dash's own direction to throw along.
 *
 * A tail swung from a standstill throws a body along the swing; a tail swung
 * off the back of a dash throws it along the swing PLUS wherever the seal was
 * already going, and harder, because the animal is carrying momentum into it.
 * Both halves are the same "extra agency" the steering is: the player chooses
 * the arc with the circle and the launch line with the dash, and the body
 * leaves along the sum.
 *
 * @param dashing  is a strike live this frame (strikeState.active)
 * @param power    0..1, what the dash was bought with — a flick out of a
 *                 one-pip release should not hit like a full commitment.
 * @returns { gain, carry } — both 1 and 0 when no dash is running.
 */
export function flipDashBoost(dashing, power = 1) {
  const d = cfg().duringStrike ?? {};
  if (d.enabled === false || !dashing) return { gain: 1, carry: 0 };
  const p = Math.min(1, Math.max(0, power));
  return {
    gain: 1 + ((d.knockMul ?? 1.6) - 1) * p,
    carry: (d.carry ?? 0.45) * p,
  };
}

// Held: this is read once a frame and handed straight to the solver.
const _tailMods = { lag: 1, stiffness: 1, damping: 1, tipLooseness: 1 };

/**
 * WHAT THE TAIL SPRING DOES DIFFERENTLY WHILE THE ANIMAL IS FLIPPING — four
 * multipliers over CONFIG.tail, or null when nothing is flipping.
 *
 * ---------------------------------------------------------------------------
 * "LOOSER" IS NOT "SNAPPIER", AND THE FIRST VERSION OF THIS GOT IT BACKWARDS
 * ---------------------------------------------------------------------------
 * It was one number that divided the stiffness and took the damping down by
 * the square root of the same figure — the arrangement a dead seal's flop
 * uses, which holds the damping RATIO constant on purpose. That is the correct
 * way to make a chain hang, and hanging is precisely the wrong thing here: the
 * tail got slower to return and no more willing to overshoot, so it trailed
 * the somersault around and arrived late. Limp, not snappy.
 *
 * A WHIP IS THREE DIFFERENT AXES, and they have to move independently:
 *
 *   `lag`      how far the chain may trail its target (maxLag, and the tip's
 *              own softness). This is the LOAD — the tail falling behind the
 *              body as the turn starts is what there is to whip.
 *   `stiffness` how hard it comes back. UP, not down: the return is the snap,
 *              and a soft spring cannot snap however far it has been pulled.
 *   `damping`  how much it resists. DOWN, and this is the one that matters —
 *              it is what lets the tip overshoot the pose and come back, which
 *              is the difference between a tail arriving and a tail CRACKING.
 *
 * SO THE DAMPING RATIO IS DELIBERATELY BROKEN HERE, and it is the only place
 * in the file that does that. Everywhere else — the flop, the per-bone
 * softening in systems/boneSpring.js — the damping follows the square root of
 * the stiffness so a looser chain does not also become an undamped one. This
 * wants the undamped one. At the shipped numbers the ratio goes from 0.64
 * (barely any overshoot, a tail that settles onto the pose) to about 0.22,
 * which is a couple of visible swings inside the length of one flip.
 *
 * EASED IN AND OUT ON THE TUCK'S ENVELOPE, so no term changes in a single
 * frame — a spring whose constants jump is a chain that twitches.
 */
export function flipTailSpring() {
  const t = cfg().tail ?? {};
  if (t.enabled === false || !flipState.active) return null;
  const w = flipTuckAt(flipState.clock);
  if (w <= 0.001) return null;
  _tailMods.lag = mix(1, t.lag ?? 1, w);
  _tailMods.stiffness = mix(1, t.stiffness ?? 1, w);
  _tailMods.damping = mix(1, t.damping ?? 1, w);
  _tailMods.tipLooseness = mix(1, t.tipLooseness ?? 1, w);
  return _tailMods;
}

/**
 * IS ANYTHING ELSE POSING THE ANIMAL — for the caller that has to decide
 * whether a circle should be read at all. A flip drawn while the flippers are
 * mid-clap would take them off the beat, and the clap is the one gesture in
 * this game that is played to music.
 */
export function flipBlocked() {
  return celebrationState.active || clapState.active;
}
