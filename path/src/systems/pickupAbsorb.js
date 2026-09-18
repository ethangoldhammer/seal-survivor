// ===========================================================================
// ABSORBING A PICKUP — a big one goes down in pieces, not in one swallow.
// ===========================================================================
// The chum chunk is the largest single payout in the game: up to three
// quarters of a health bar, or a fistful of boost pips off a weak spot. It
// used to land on the frame the seal touched it — one flash, one gulp, and the
// bar was simply somewhere else than it had been. The size of it was a number
// that had already happened by the time the eye got there.
//
// So it comes apart instead. The swallow's goo is fired as a SUCK burst
// (systems/gooSuck.js) carrying the payout as its cargo, a share per blob, and
// each blob pays its share on the frame it reaches the body. The bar climbs as
// the goo arrives. A fat chunk throws more pieces than a lean one — the piece
// count rides the same `scale` the burst already took from the roll — so how
// long the vacuum lasts is itself the tell about how big the thing was.
//
// AND THE FLIGHT ITSELF SOUNDS. A riser under the haul (systems/absorbRiser.js),
// loudest on the frame the first piece reaches the seal and then settling to a
// wash under the ladder below. It is started here and not inside the burst
// because what it scores is the PAYOUT arriving: a burst nobody is paying out
// of is a splat, and a splat does not get a vacuum.
//
// AND EACH ARRIVAL SOUNDS, A LITTLE HIGHER THAN THE LAST. One quiet blip per
// piece, climbing from `pitchFrom` to `pitchTo` across the bunch, so the run
// of them resolves on the last piece rather than stopping. A ladder that
// arrives somewhere is the difference between "that was absorbed" and "that
// was a rattle"; the top note IS the receipt.
//
// WHAT THIS MODULE OWNS is the pieces, the ladder and the promise. WHAT IT DOES
// NOT own is the currency: the caller passes a `pay` function and this calls it
// with a SHARE (1/count) each time. Health, pips, anything later — none of it
// is known here, which is what keeps a second pickup wanting this from having
// to add a branch to it.
//
// THE PROMISE: `pay` is called exactly `count` times and the total of the
// shares is exactly 1. A piece whose goo melts unclaimed still pays (see
// systems/gooSuck.js), and a burst that could not be sucked at all pays once,
// whole, which is precisely the old behaviour. Nothing is ever silently lost —
// a pickup that hands over less than it promised because a particle reserve
// was full would be a bug nobody could ever reproduce.
//
// Numbers: CONFIG.pickups.absorb.
// ===========================================================================

import { CONFIG } from '../config.js';
import { feedback } from './feedback.js';
import { startAbsorbRiser, arriveAbsorbRiser, stopAbsorbRiser } from './absorbRiser.js';

const cfg = () => CONFIG.pickups?.absorb ?? {};

// One id per bunch, so two chunks absorbing at once each drive their own riser.
// A counter rather than the event name: the same event fires for every chunk,
// and keying on it would have the second one's arrival settling the first one's
// vacuum.
let nextBunch = 1;

/**
 * The pitch for arrival `taken` of `count`, 1-based.
 *
 * Pure, and exported because the ladder is the whole feature and it is the one
 * part of it that can be wrong in a way no screenshot would show. A single
 * piece takes `pitchFrom` — the bottom of the ladder, not the top: a chunk
 * that split into one piece is not a chunk that finished absorbing, it is a
 * chunk that never split, and it should sound like the start of a run rather
 * than the end of one.
 *
 * `curve` bends where the climb happens. Above 1 the early pieces are close
 * together and the last few open out, which is what makes a long bunch resolve
 * rather than glissando past you.
 */
export function absorbPitch(taken, count, c = cfg()) {
  const from = c.pitchFrom ?? 1;
  const to = c.pitchTo ?? 1.5;
  if (!(count > 1)) return from;
  const i = Math.max(1, Math.min(count, taken));
  const t = (i - 1) / (count - 1);
  return from + (to - from) * Math.pow(t, Math.max(0.05, c.curve ?? 1));
}

/**
 * HOW LONG THE FIRST PIECE IS EXPECTED TO TAKE, in seconds — the hold before
 * anything moves, the pull ramping on, and a guess at the flight itself.
 *
 * Exported and pure because it is the riser's whole schedule and it is read
 * off four numbers that live in two different config blocks: this pickup's own
 * timing where it has any (CONFIG.pickups.absorb.orb), the shared look
 * otherwise (CONFIG.fx.gooSuck). Written at the call site it would be the place
 * the two quietly stopped agreeing.
 *
 * It is a GUESS and is meant to be — the real arrival moves the peak (see
 * arriveAbsorbRiser). What it has to be is the right size, not right.
 */
export function absorbApproach(c = cfg()) {
  const suck = CONFIG.fx?.gooSuck ?? {};
  const hold = c.hold ?? suck.holdAt ?? 0.4;
  const ramp = c.ramp ?? suck.rampTime ?? 0.15;
  const travel = c.riser?.travel ?? 0.3;
  return Math.max(0.05, hold + ramp + travel);
}

/**
 * Swallow something in pieces.
 *
 * @param {string} event  the swallow's own feedback event — the flash, the
 *                        shake and the sound of the pickup going down. It must
 *                        name a `goo` emitter or there is nothing to carry the
 *                        payout, and this asks that burst to be sucked.
 * @param {object} at     what feedback() would have been given: x, y, scale,
 *                        color, sfxOpts. `scale` is doing double duty — it is
 *                        already how big the burst is, and it is now also how
 *                        many pieces the payout is cut into. `pieces` overrides
 *                        that count outright, for a payout whose pieces are
 *                        COUNTABLE — one pip each — rather than shares of
 *                        something continuous. `tune` is this pickup's own
 *                        numbers over the shared ones — the keys of
 *                        CONFIG.pickups.absorb it disagrees about, and nothing
 *                        else.
 * @param {function} pay  called once per piece as pay(share, taken, count,
 *                        x, y, last). `share` sums to exactly 1.
 *
 * Switched off (`enabled: false`), the event fires as it always did and `pay`
 * is called once with the whole share — so this can be turned off in the tuner
 * and the pickup still works, which is the only honest way to A/B it.
 */
export function absorbInPieces(event, at = {}, pay = null) {
  // THE BASE NUMBERS, WITH THIS PICKUP'S OWN OVER THEM. An overlay rather than
  // a second config block: a pickup that wants a quicker vacuum says only the
  // keys it disagrees about, and everything it is silent on keeps following
  // the shared tuning. See CONFIG.pickups.absorb.orb.
  const c = at.tune ? { ...cfg(), ...at.tune } : cfg();
  if (typeof pay !== 'function') { feedback(event, at); return; }
  if (c.enabled === false) {
    feedback(event, at);
    pay(1, 1, 1, at.x ?? 0, at.y ?? 0, true);
    return;
  }

  // THE VACUUM (systems/absorbRiser.js) — the flight, scored. Started here
  // rather than inside the burst because what it is scoring is the PAYOUT
  // arriving, and the payout is this module's: a burst nobody is paying out of
  // is a splat, and a splat does not get a riser.
  //
  // Scheduled on an estimate and corrected by the first piece to land, so a
  // burst that is never captured — the reserve came back empty, the run ended
  // over it — still resolves on its own clock instead of hanging.
  const bunch = nextBunch++;
  const stagger = Math.max(0, c.stagger ?? 0.5);
  // The riser block is overlaid the same way the block around it is, KEY BY
  // KEY. The outer spread replaces it wholesale, so a pickup that wanted a
  // quieter vacuum and said only `{ gain: 0.04 }` would lose the bands, the
  // sweep and the envelope along with the loudness — which is a silence that
  // looks like a level.
  const riser = at.tune?.riser
    ? { ...(cfg().riser ?? {}), ...at.tune.riser }
    : c.riser;
  startAbsorbRiser(bunch, absorbApproach({ ...c, riser }), stagger, riser);
  feedback(event, {
    ...at,
    // The event's own `goo`, drawn home instead of thrown away. `gooSuck` on
    // the FIRING rather than on the def, so an event can be absorbed here and
    // still burst ballistically everywhere else it is used.
    gooSuck: true,
    holdStagger: stagger,
    // THE BEAT BEFORE ANY OF IT MOVES, and how hard the pull comes on after
    // it, when this pickup names them. Undefined leaves the shared look
    // numbers (CONFIG.fx.gooSuck.holdAt / rampTime) exactly as they were,
    // which is every caller that has not asked.
    holdAt: c.hold,
    rampTime: c.ramp,
    // The piece count is the ladder's length, so it is clamped here rather
    // than left entirely to the look tuning — see CONFIG.pickups.absorb.pieces.
    //
    // ...UNLESS THE CALLER IS PAYING IN WHOLE UNITS. `at.pieces` pins the count
    // exactly, above and below, and that is not a violation of the clamp's
    // reason for existing — it is the case the clamp was never about. A share
    // of a heal can be any size, so the look owns how many there are; a PIP is
    // a countable thing on the bar, and a blue orb that lit five containers in
    // eleven blips would be counting something the player cannot see. Where the
    // piece count IS the payout, the payout names it.
    countClamp: at.pieces > 0 ? [at.pieces, at.pieces] : c.pieces,
    onCapture: (taken, count, x, y, last) => {
      pay(1 / count, taken, count, x, y, last);
      // THE VACUUM'S TWO MOMENTS. The first piece is the arrival — it peaks the
      // riser where the goo actually got here rather than where the estimate
      // said it would — and the last one takes it away under the top of the
      // ladder. Every piece between them lands inside the settle, which is what
      // the settle is for.
      //
      // `last` and `taken === 1` are both true for a one-piece bunch, and the
      // order is right: it arrives, then it is taken away.
      //
      // The settle runs across the STAGGER, because that is how long the rest
      // of the pieces will take: the burst spreads their starts from 0 to the
      // full stagger, so the first one home is the one that waited nothing.
      if (taken === 1) arriveAbsorbRiser(bunch, stagger);
      if (last) stopAbsorbRiser(bunch);
      // The piece landing. Its own event so it can be silenced, retuned or
      // given a different spray without touching the swallow above it — and
      // the pitch is per arrival, which is the only reason it is passed here
      // rather than sitting in the table.
      const tick = c.event;
      if (tick && CONFIG.feedback?.[tick]) {
        feedback(tick, {
          x, y,
          color: at.color,
          scale: last ? (c.lastScale ?? 1.6) : 1,
          sfxOpts: { pitch: absorbPitch(taken, count, c) },
        });
      }
    },
  });
}
