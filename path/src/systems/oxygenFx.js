import { CONFIG } from '../config.js';
import { feedback } from './feedback.js';
import { setBandpass } from './music.js';

// Everything that happens as the seal runs out of air: the warning beep, the
// gasping when it surfaces to refill, and the blackout — the screen
// pixelating and the score narrowing into a band as it fades.
//
// All of it hangs off ONE value, `oxygenFxState.strain`:
//
//   strain 0   oxygen at or above CONFIG.oxygen.fx.threshold (1/8 of the bar).
//              Nothing runs at all — no beep, no filter, no shader work.
//   strain 1   oxygen empty.
//
// One shared value rather than each effect deciding for itself when it starts
// is what keeps the beep, the pixels and the filter arriving as a single
// event instead of three independent ones that happen to overlap. It's also
// what makes easing out honest: recovering past the threshold walks the same
// number back down, so the screen and the mix clear together.
//
// Strain is EASED, not read straight off the oxygen bar. Grabbing a bubble
// orb is instant, and without the ease the screen would snap from heavily
// pixelated to clean in a single frame — which reads as a rendering glitch,
// not as relief.

export const oxygenFxState = {
  strain: 0,
};

// Below this, strain is treated as fully clear. Well under the point where
// any of the three effects is audible or visible — the pixel ramp is still a
// shader no-op here, and the band-pass crossfade is inaudible.
const SETTLED = 0.002;

let beepTimer = 0;
let lastOxygen = 0;
// Whether the seal has taken a breath it has not yet let back out. The exhale
// is the close of a pair, so it can only fire after an inhale — without this a
// run that begins at the surface would blow out air it never took in.
let breathHeld = false;
// Skip the per-frame audio scheduling once everything has settled back to
// zero, so a run spent above the threshold costs nothing.
let bandSettled = true;

export function resetOxygenFx() {
  oxygenFxState.strain = 0;
  beepTimer = 0;
  breathHeld = false;
  lastOxygen = CONFIG.oxygen.max; // pre-run: no stat block exists yet
  bandSettled = false; // force one push, so a new run can't start band-passed
}

/**
 * @param {number} dt      REAL seconds — this is presentation, and a hit-stop
 *                         shouldn't stall the beep or freeze the blackout.
 * @param {object} player  needs .oxygen and .aboveSurface
 * @param {boolean} active false while paused, on a menu, or after death —
 *                         strain eases back to 0 and nothing new fires.
 */
export function updateOxygenFx(dt, player, active) {
  const fx = CONFIG.oxygen.fx ?? {};
  // The per-run cap, not CONFIG's: a Deep Lungs pick raises the tank, and if
  // the strain curve kept dividing by the base value the suffocation FX would
  // start screaming at a bar that's still a third full.
  const max = Math.max(1, player.stats?.maxOxygen ?? CONFIG.oxygen.max);
  const frac = Math.max(0, Math.min(1, player.oxygen / max));
  const on = active && CONFIG.oxygen.enabled && fx.enabled !== false;

  // --- strain ---------------------------------------------------------------
  const threshold = Math.max(0.001, fx.threshold ?? 0.125);
  // 0 at the threshold, 1 at empty. Above the threshold this is negative, so
  // it clamps to 0 and the whole system is dormant.
  const raw = on ? Math.max(0, Math.min(1, (threshold - frac) / threshold)) : 0;

  // Exponential approach with separate rise and fall constants. 1 - e^(-dt/τ)
  // is the frame-rate-independent form — a plain `* 0.9` per frame would ease
  // faster on a 144Hz monitor than a 60Hz one.
  const tau = Math.max(0.01, raw > oxygenFxState.strain ? (fx.attack ?? 0.5) : (fx.release ?? 0.7));
  oxygenFxState.strain += (raw - oxygenFxState.strain) * (1 - Math.exp(-dt / tau));
  // Snap the tail to a true zero. An exponential approach never actually
  // arrives, and a strain of 0.0009 still counts as "the effect is running" —
  // which would leave the post pipeline switched on and the band-pass a hair
  // wet for the rest of a run that recovered ages ago.
  if (raw === 0 && oxygenFxState.strain <= SETTLED) oxygenFxState.strain = 0;
  const strain = oxygenFxState.strain;

  // --- music band-pass ------------------------------------------------------
  // Pushed even at 0 on the frame it first settles, so the crossfade is
  // returned to a true bypass rather than left a hair wet.
  if (strain > 0 || !bandSettled) {
    setBandpass(strain);
    bandSettled = strain === 0;
  }

  // --- warning beep ---------------------------------------------------------
  // Fires off `strain` rather than the raw fraction so it starts with the
  // rest of the effect and, more importantly, STOPS as the effect eases out
  // instead of cutting dead the instant you cross back over the threshold.
  if (on && strain > 0.02 && fx.beepEnabled !== false) {
    beepTimer -= dt;
    if (beepTimer <= 0) {
      const far = fx.beepIntervalFar ?? 1.1;
      const near = fx.beepIntervalNear ?? 0.22;
      beepTimer = Math.max(0.03, far + (near - far) * strain);
      // Climbing pitch and rising volume: how close you are to drowning is
      // readable without looking at the bar above the seal.
      // Through feedback() rather than playSfx, so the beep rumbles as well
      // as sounds — `scale` is the same 0.6..1 ramp that drives the volume,
      // so the warning gets more insistent in your hands on exactly the curve
      // it gets more insistent in your ears.
      feedback('oxygenWarn', {
        x: player.mesh.position.x,
        y: player.mesh.position.y,
        scale: 0.6 + 0.4 * strain,
        sfxOpts: { pitch: 1 + strain * (fx.beepPitchRise ?? 0.6) },
      });
    }
  } else {
    // Reset rather than let it run down while dormant, so the first beep of
    // the next emergency lands immediately instead of on a stale timer.
    beepTimer = 0;
  }

  // --- the gasp -------------------------------------------------------------
  // ONE breath per surfacing, taken on the EDGE where oxygen starts coming
  // back — not one every `breathInterval` for as long as the bar is filling.
  //
  // The timer version was wrong about what a breath is. Refilling from empty
  // takes several seconds, so it gasped four or five times on the way up: a
  // seal panting, not a seal taking a breath. It also could not survive the
  // takes getting longer than the interval, which the recorded inhales are —
  // past 0.5s apiece the repeats simply play over each other.
  //
  // The edge covers both ways air arrives without either being special-cased.
  // Surfacing refills continuously (oxygenRefillRate in entities/player.js);
  // an oxygen bubble pays its whole refill out in a single frame (main.js).
  // Both are "the bar started going up", and both are exactly one gasp.
  //
  // No `frac < 1` guard any more, and that is deliberate: it existed to stop
  // the timer firing again on the frame the bar topped up, but it also
  // swallowed the gasp for a bubble grabbed on an almost-full bar — which is
  // a pop the player very much did just make happen.
  //
  // `breathHeld` is the latch, shared with the exhale below: a breath cannot
  // be taken twice before it is let out. That is what makes this robust to the
  // bar wobbling by a float epsilon at the surface, where a bare rising-edge
  // test would count every wobble as another breath.
  const gaining = player.oxygen > lastOxygen + 1e-4;
  if (on && fx.breathEnabled !== false && gaining && !breathHeld) {
    breathHeld = true;
    // Louder and lower when you surface desperate, tailing off to a light sip
    // when there was barely anything to top up.
    feedback('breathIn', {
      x: player.mesh.position.x,
      y: player.mesh.position.y,
      scale: 0.55 + 0.45 * (1 - frac),
      sfxOpts: { pitch: 0.9 + 0.3 * frac },
    });
  }

  // --- the exhale -----------------------------------------------------------
  // The other half of the gasp, fired once as the seal goes back under.
  //
  // NOT gated on the bar topping up, which is the obvious test and the wrong
  // one: `gaining` also goes false when the bar simply hits full, and a seal
  // can float at the surface on a full bar for as long as it likes. Blowing
  // out there would put the exhale a breath early and often nowhere near the
  // water going over its head.
  //
  // Oxygen starting to FALL again is the unambiguous tell for submerged, and
  // it is the same signal `gaining` is read off, so the pair can never
  // disagree about which way the bar is moving.
  const losing = player.oxygen < lastOxygen - 1e-4;
  if (on && fx.breathEnabled !== false && breathHeld && losing) {
    breathHeld = false;
    feedback('breathOut', {
      x: player.mesh.position.x,
      y: player.mesh.position.y,
      // How full the lungs are going down, so a seal that dives on a snatched
      // half-breath lets out less than one that waited for the whole bar.
      scale: 0.5 + 0.5 * frac,
      sfxOpts: { pitch: 1.05 - 0.15 * frac },
    });
  }

  lastOxygen = player.oxygen;
}

// Block size, in device pixels, the post stack should pixelate to right now.
// Returns 0 when the effect is dormant — the shader's own `uPixel > 1.0` gate
// means anything at or below 1 is already a no-op, so the ramp starts AT 1
// and grows from there rather than easing up through a dead zone where
// nothing visibly happens.
export function suffocationPixelSize() {
  const strain = oxygenFxState.strain;
  if (strain <= SETTLED) return 0;
  const fx = CONFIG.oxygen.fx ?? {};
  const curved = Math.pow(strain, Math.max(0.1, fx.pixelCurve ?? 1.8));
  return 1 + curved * Math.max(0, (fx.pixelMax ?? 18) - 1);
}
