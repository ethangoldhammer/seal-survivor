import { CONFIG } from '../config.js';

// THE LAST SLIVER OF THE HEALTH BAR, as a picture.
//
// Damage already has a per-HIT channel — systems/playerDamageFx.js fires the
// rim flash, the red eyes, the shake and the grunt on the frame each bite
// lands. That channel is about the EVENT, and it is silent about the STATE:
// the frame after a hit that took you to 4% looks exactly like the frame after
// a hit that took you to 80%. Nothing on screen is ever about how close you
// are to the end of the run, which is the one thing the player most needs to
// know while their eyes are on the ocean rather than on the gauge.
//
// So this is a second channel, and it runs on the OPPOSITE clock. The rim
// flash is a spike that decays in under half a second; this eases in over
// about a third of a second and then STAYS until the seal is out of trouble.
// A player mid-fight reads the state one without ever looking at it, because
// it is the whole frame rather than a mark inside it.
//
// All of it hangs off ONE value, `lowHealthFxState.strain` — the same shape as
// oxygenFxState.strain, deliberately, because they are the same kind of thing
// and they will very often be running at the same time:
//
//   strain 0   health at or above CONFIG.fx.lowHealth.threshold (15% of the
//              bar). Nothing runs at all — no shader work, no beat.
//   strain 1   the bar is empty.
//
// Strain is EASED rather than read straight off the bar. A health pickup and
// a Blubber level are both instant, and without the ease the frame would snap
// from bloody to clean in a single frame — which reads as a rendering glitch,
// not as relief. It is also what makes the crossing survive a bar that is
// oscillating around the threshold while something chews on you: the picture
// settles at whatever the average is instead of strobing.
//
// A FRACTION OF THE BAR, NOT A DAMAGE NUMBER — the whole reason this is worth
// having. Max HP moves a long way over a run (Blubber stacks), so 20 health
// left is an emergency on wave one and a scratch at level 20. The gauge the
// player is looking at is a fraction, and so is this.

export const lowHealthFxState = {
  // 0..1, eased. What every downstream number is scaled by.
  strain: 0,
  // Where the heart is in its current cycle, 0..1, wrapping. Kept rather than
  // derived from a clock so the beat can never jump when the RATE changes —
  // the interval shortens as the strain rises, and a beat computed as
  // `now / interval` would teleport the heart mid-thump every time it did.
  beatPhase: 0,
  // ...and this cycle's value, 0..1. Written here rather than returned so the
  // vignette and anything else that wants to move on the beat are reading the
  // same number on the same frame.
  beat: 0,
};

// Below this, strain is treated as fully clear — well under the point where
// the vignette is distinguishable from an unlit corner. Same value and same
// job as SETTLED in systems/oxygenFx.js.
const SETTLED = 0.002;

export function resetLowHealthFx() {
  lowHealthFxState.strain = 0;
  lowHealthFxState.beatPhase = 0;
  lowHealthFxState.beat = 0;
}

/**
 * The shape of one heartbeat, 0..1, as a function of where we are in the
 * cycle. Exported so a harness can step the curve rather than infer it from
 * the frames it happens to land on.
 *
 * TWO THUMPS, NOT ONE. A single pulse per cycle reads as a blinking light —
 * it has a rate but no character, and at the fast end it is indistinguishable
 * from a strobe. The lub-dub pair is what makes it read as a heart at any
 * rate, including the panicked one.
 *
 * The wrap-around copy of the first spike is not a flourish. The lub sits at
 * phase 0, so half of it lives at the END of the previous cycle; without the
 * copy at 1.0 the sharpest part of the beat would be sliced flat every cycle,
 * and the beat would read as a sawtooth that snaps rather than as a thump.
 */
export function heartbeat(phase) {
  const p = phase - Math.floor(phase);
  const spike = (at, w) => Math.exp(-(((p - at) / w) ** 2));
  return Math.min(1, spike(0, 0.05) + spike(1, 0.05) + 0.55 * spike(0.26, 0.075));
}

/**
 * @param {number} dt      REAL seconds. This is presentation, and a hit-stop —
 *                         which player damage itself fires — must not stall the
 *                         ease or stretch the beat. It is a parameter rather
 *                         than a clock read in here so a harness can step it.
 * @param {object} player  needs .hp and .stats.maxHp
 * @param {boolean} active false while paused, on a menu, or after death. The
 *                         strain eases back to 0 rather than freezing, so the
 *                         score card is not served under a bloody frame.
 */
export function updateLowHealthFx(dt, player, active) {
  const fx = CONFIG.fx?.lowHealth ?? {};
  // The PER-RUN max, not CONFIG's. Blubber stacks raise the bar, and a curve
  // dividing by the base value would have the screen going red at a bar that
  // is still a third full.
  const max = Math.max(1, player?.stats?.maxHp ?? CONFIG.player?.maxHp ?? 1);
  const frac = Math.max(0, Math.min(1, (player?.hp ?? max) / max));
  const on = active && fx.enabled !== false;

  const threshold = Math.max(0.001, fx.threshold ?? 0.15);
  // 0 at the threshold, 1 at empty. Above the threshold this is negative and
  // clamps to 0, so the whole system is dormant for most of every run.
  const raw = on ? Math.max(0, Math.min(1, (threshold - frac) / threshold)) : 0;

  // Exponential approach with separate rise and fall constants.
  // 1 - e^(-dt/tau) is the frame-rate-independent form — a plain `* 0.9` per
  // frame would ease twice as fast on a 144Hz monitor as on a 60Hz one.
  //
  // The fall is the slower of the two on purpose, and it is the asymmetry
  // rather than either number that matters: arriving in trouble should be
  // quicker than leaving it. A symmetric ease makes a heal read as an undo.
  const tau = Math.max(0.01, raw > lowHealthFxState.strain ? (fx.attack ?? 0.35) : (fx.release ?? 0.9));
  lowHealthFxState.strain += (raw - lowHealthFxState.strain) * (1 - Math.exp(-dt / tau));
  // Snap the tail to a true zero. An exponential approach never actually
  // arrives, and a strain of 0.0009 still counts as "the effect is running" —
  // which would leave the post pipeline switched on for the rest of a run that
  // recovered ages ago, on a machine that may well have had bloom turned off
  // precisely to avoid paying for it.
  if (raw === 0 && lowHealthFxState.strain <= SETTLED) lowHealthFxState.strain = 0;
  const strain = lowHealthFxState.strain;

  // --- the heart ------------------------------------------------------------
  if (strain <= SETTLED) {
    // Parked rather than left to run down while dormant, so the first beat of
    // the next emergency lands on the thump instead of wherever a stale phase
    // happened to be. Phase 0 IS the lub, so crossing the threshold arrives on
    // a beat rather than up to a second after one.
    lowHealthFxState.beatPhase = 0;
    lowHealthFxState.beat = 0;
    return;
  }
  const far = fx.beatFar ?? 1.05;
  const near = fx.beatNear ?? 0.42;
  const interval = Math.max(0.08, far + (near - far) * strain);
  lowHealthFxState.beatPhase = (lowHealthFxState.beatPhase + dt / interval) % 1;
  lowHealthFxState.beat = heartbeat(lowHealthFxState.beatPhase);
}

/**
 * How hard the frame is closing in right now, 0..1 — the eased strain put
 * through `rampCurve`, or 0 when the effect is dormant.
 *
 * Returned as the ramped SCALAR rather than as finished uniform values, for
 * the same reason suffocationCrt() is: the numbers that turn it into a picture
 * live next to the rest of the screen filter, in systems/post.js. See
 * `applyLowHealthVignette` there.
 *
 * The default curve is BELOW 1, which is the opposite of drowning's 1.8, and
 * the difference is the point. Suffocation holds itself back early and saves
 * the worst for the last breath, because the oxygen bar is a countdown you can
 * watch and the effect is the punchline. Health is not a countdown — you can
 * be taken from 60% to 8% by one bite — so the crossing itself has to be the
 * moment you notice, not something that creeps up over the following seconds.
 * Front-loading it means 15% is immediately visible and 0% is still worse.
 */
export function lowHealthVignette() {
  const strain = lowHealthFxState.strain;
  if (strain <= SETTLED) return 0;
  const fx = CONFIG.fx?.lowHealth ?? {};
  if (fx.enabled === false) return 0;
  return Math.pow(strain, Math.max(0.1, fx.rampCurve ?? 0.7));
}
