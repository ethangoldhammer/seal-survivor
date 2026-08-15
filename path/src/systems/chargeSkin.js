import { CONFIG } from '../config.js';
import { setNoiseChargeGlow, setNoiseChargePulse } from './noiseShader.js';
import { advanceCycles } from './beatSync.js';

// ============================================================================
// THE SEAL READS ITS OWN METER.
//
// The charge ring says how much boost there is. This says the same thing on
// the ANIMAL, so it can be read without looking away from what you are about
// to hit — which is the whole reason the meter is drawn around the seal in the
// first place rather than in a corner.
//
// Four states, and they are deliberately the four the player has to act on:
//
//   EMPTY reads dark.   The markings go inert and desaturated. A hungry seal
//                       is visibly a hungry seal, before you check anything.
//   FILLING saturates.  Brightness rides the bar, so the trend is legible in
//                       peripheral vision.
//   FULL breathes.      A slow, steady, bright pulse that HOLDS. Not a flash —
//                       "loaded, and still loaded" has to survive being looked
//                       at ten seconds later.
//   CROSSING flashes.   One wave head to tail on the frame the bar fills.
//
// The crossing wave is doing double duty on purpose. Filling the meter inside
// a live combo is also what scores a FOOD CHAIN link, so one animation teaches
// the entire eat-strike-eat loop: the thing that lights up the seal is the
// same thing that extends the chain, and the player learns that by watching
// rather than by being told.
//
// WHY THIS IS NOT PART OF systems/elements.js, which already lights the same
// markings: because the element early-outs at level 0, and most runs never
// take Glow Up!. Routing the charge through that layer would give the meter a
// body read on some runs and not others. The two glows are separate uniform
// sets added independently in the same shader hook — see the long note on
// setNoiseChargeGlow in systems/noiseShader.js.
//
// THE RIM IS NOT THIS. CONFIG.strike.charge.outline already throbs the seal's
// outline while a strike is being WOUND UP, accelerating 2.2 -> 7.5 Hz with
// banked power. That channel owns "I am loading a strike". This one owns "I
// have the fuel for one". Two questions, two answers, and keeping them apart
// is what stops the seal from being one undifferentiated pulsing blob.
//
// IT IS NOT DAY-GATED, unlike Glow Up! next door, and that is deliberate: this
// is a readout, not an ability. Gating it on darkness took the eat-strike-eat
// loop's body feedback away for the whole first half of every run, which is a
// lot of run to spend saying nothing. What it IS gated on is `armed` below.
// ============================================================================

// Bucketed like updateElementSkin's key, and for the same reason: the stamp is
// a traverse over every material on the body, and the fuel level moves
// continuously. 24 buckets restamps about once per pip at the default five,
// which is smooth and costs nothing when the bar is parked.
let skinnedBody = null;
let skinKey = '';
let breathCycle = 0;
let waveT = -1;

// ---------------------------------------------------------------------------
// THE SEAL STARTS EVERY RUN DARK. Whatever the sky is doing, whatever the
// meter says.
//
// `strikeState.charge` starts at 1, so the "loaded" read was true from the
// first frame of every run — the seal spawned covered in glowing mint patches
// before the player had touched anything. A body read that is already on when
// you arrive is not telling you about a state, it is just what the animal
// looks like, and the one thing this layer must never become is the seal's
// default appearance.
//
// A DAYLIGHT GATE DOES NOT FIX THIS, which is worth writing down because it
// was the first answer and it was wrong. It only hid the symptom in the
// morning: `dayNight.startFromSystemClock` seeds the opening hour from the
// player's own clock, so a run begun after dark opened exactly as lit as
// before. The rule is about the START of a run, not the time of day.
//
// So the layer is ASLEEP until the meter first MOVES, and the first move can
// only ever be the player spending it. From then on it behaves as described
// above for the rest of the run. That also makes the glow mean something
// sharper than "the bar is full": it means you filled it.
let armed = false;
let openingFuel = null;

/** Force the next update to restamp — after a model swap from the T panel. */
export function invalidateChargeSkin() {
  skinnedBody = null;
  skinKey = '';
}

export function resetChargeSkin() {
  invalidateChargeSkin();
  breathCycle = 0;
  waveT = -1;
  // Per RUN, not per boot: startGame() calls this, and a second run started
  // from the score screen has to open as dark as the first one did.
  armed = false;
  openingFuel = null;
}

/**
 * Fire the head-to-tail crossing flash. Called when the bar reaches full.
 *
 * Idempotent within a wave: a second crossing while one is still running
 * RESTARTS it rather than stacking, because two overlapping bands travelling
 * the same body at different offsets reads as a glitch rather than as two
 * events.
 */
export function chargeCrossed() {
  if (CONFIG.sealCharge?.wave?.enabled === false) return;
  // Gated with the steady glow, not separately — an asleep layer is silent in
  // every channel it has, or "the seal starts dark" would still open with a
  // band of light crossing it. The event itself is not lost: the ring flashes
  // on the same frame.
  //
  // Unreachable while asleep in practice (a crossing needs the bar to have
  // left full, which is the move that wakes the layer up) and kept anyway,
  // because "asleep means silent" should not depend on that argument staying
  // true of some future refill.
  if (!armed) return;
  waveT = 0;
}

/**
 * @param body     the seal's visual root
 * @param charge   0..1, the live meter (strikeState.charge)
 * @param rawDt    UNSCALED seconds. Raw, not the hitstop-scaled dt: the seal's
 *                 own light doesn't hold its breath because the game froze for
 *                 60ms on a hit. Same argument as updateElementSkin.
 */
export function updateChargeSkin(body, charge, rawDt = 0) {
  const s = CONFIG.sealCharge ?? {};
  if (!body || s.enabled === false || !CONFIG.strike.enabled) return;

  const fuel = Math.max(0, Math.min(1, charge));
  const full = fuel >= 1;

  // Wake on the first MOVEMENT of the bar, not on a level or a threshold —
  // measured against whatever it opened at rather than against 1, so a run
  // that ever starts on a part-full meter still opens dark instead of at a
  // dimmer version of the same wrong thing. See the note by `armed`.
  if (!armed) {
    if (openingFuel == null) openingFuel = fuel;
    else if (Math.abs(fuel - openingFuel) > 1e-4) armed = true;
  }

  // Ahead of the early-out below, like the element's breath: these are the
  // parts that are never idle, and they are two uniform writes.
  breathCycle = advanceCycles(
    breathCycle,
    s.pulseSync,
    (full ? (s.fullPulseSpeed ?? 2.4) : (s.pulseSpeed ?? 1.1)) / (Math.PI * 2),
    rawDt,
    1,
  );
  if (waveT >= 0) {
    waveT += rawDt / Math.max(0.05, s.wave?.duration ?? 0.5);
    if (waveT > 1) waveT = -1;
  }
  // The breath only really opens up at full — below that it is a faint
  // shimmer, so "loaded" is a state change rather than the same animation
  // running brighter.
  const amp = full ? (s.fullPulseAmp ?? 0.30) : (s.pulseAmp ?? 0.08);
  setNoiseChargePulse(body, 1 + amp * Math.sin(breathCycle * Math.PI * 2), waveT);

  // EMPTY READS DARK. The exponent is what makes the bottom of the range
  // actually dark rather than merely dimmer — linear brightness against a bar
  // at 20% still looks lit, and "I cannot strike" has to be visible at a
  // glance.
  const lit = Math.pow(fuel, s.falloff ?? 1.35);
  // ...AND DAYLIGHT READS DARKER STILL. At noon this is 0 and the shader's own
  // branch drops out, so the seal is an ordinary mottled animal rather than a
  // dim glowing one — same crossfade, and the same "nothing left over to
  // undo", as updateElementSkin.
  //
  // ...AND A LAYER THAT HAS NOT WOKEN UP YET READS DARKEST OF ALL: zero until
  // the meter first moves, so the seal opens every run as an ordinary mottled
  // animal at any hour. A multiplier rather than an early-out, so the wake-up
  // goes through the same stamp as every other change to this layer.
  const power = armed ? 1 : 0;
  const strength = (s.strength ?? 0.9) * lit * (full ? (s.fullBoost ?? 1.25) : 1) * power;

  const bucket = Math.round(lit * 24) / 24;
  // `power` is in the key so the wake-up restamps: the fuel has not moved
  // enough to change the bucket on the frame the layer opens its eyes.
  const key = `${bucket}:${full ? 1 : 0}:${power}`;
  // The body check survives a model swap from the tuner: same fuel, same
  // state, different materials underneath. A bare flag would say "already
  // stamped" about a body that no longer exists.
  if (key === skinKey && skinnedBody === body) return;
  skinKey = key;
  skinnedBody = body;

  setNoiseChargeGlow(body, {
    // Colour tracks the ring: charging blue, ready mint. The meter and the
    // animal must never disagree about what state the run is in, so both read
    // the SAME two entries out of CONFIG.strike.ring.
    color: full ? CONFIG.strike.ring.readyColor : CONFIG.strike.ring.color,
    tipColor: s.tipColor ?? 0xffffff,
    white: s.white ?? 0.35,
    coverage: s.coverage ?? 0.3,
    contrast: s.contrast ?? 2.2,
    strength,
  });
}
