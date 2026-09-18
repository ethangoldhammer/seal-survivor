import { CONFIG } from '../config.js';
import { getAudioContext, getSfxBus, isAudioLive } from './audio.js';
import { buildBank, tearDownBank } from './noiseRiser.js';

// ---------------------------------------------------------------------------
// THE VACUUM — the sound of a big pickup being drawn into the seal.
// ---------------------------------------------------------------------------
// A chum chunk does not go down in one swallow any more: it bursts, hangs, and
// is hauled home a piece at a time (systems/pickupAbsorb.js, systems/gooSuck.js).
// Until now the only thing the ear got was the swallow's one-shot and then the
// pip ladder — a bang, a gap the length of the flight, and a run of blips. The
// part with the goo actually MOVING in it was silent, which is the one stretch
// where the eye is watching something travel.
//
// So: a riser under the flight. The shape is three moments and they are all
// the same sound:
//
//   THE DRAW      it climbs from the burst — the bands opening as the mass
//                 comes off the wall and starts moving.
//   THE ARRIVAL   loudest at the seal, on the frame the first piece lands. This
//                 is the point of the whole thing: the peak is WHERE THE GOO
//                 IS, so the swell is the distance closing rather than a
//                 crescendo somebody typed.
//   THE SETTLE    down to a wash under the pip ladder while the rest of the
//                 pieces arrive, and gone on the last one. The ladder is the
//                 receipt (see absorbPitch) and it has to be heard over this,
//                 not through it.
//
// WHY IT IS NOT A CONFIG.sfx VOICE, the same reason systems/cardRiser.js and
// systems/jetBed.js are not: everything in that table is a one-shot that knows
// its length when it is triggered, and this one does not. How long the flight
// takes is a property of the goo — the hold, the ramp, where the blobs ended up
// after the burst, and whether the seal swam toward or away from its own splat.
// A fixed decay would be a sound that peaks a quarter of a second before or
// after the thing it is scoring, which is worse than no sound at all: it says
// the goo arrived and the goo has not.
//
// SO IT IS SCHEDULED AND THEN CORRECTED. `startAbsorbRiser` takes a GUESS at
// the flight (hold + ramp + travel) and schedules the whole envelope across it,
// arrival and settle and all — so a burst whose pieces never report back still
// resolves instead of droning. `arriveAbsorbRiser` is then called by the first
// piece that actually lands and re-aims the peak from wherever the swell had
// got to. Early or late, the loudest moment is the real arrival; the estimate
// only decides how much of the climb you hear before it.
//
// NO TONE — see systems/noiseRiser.js. Here it matters twice over: the pip
// ladder this settles under IS pitched, and a riser with a fundamental in it
// would be a second, unrelated melody underneath a run of blips that is trying
// to resolve.
// ---------------------------------------------------------------------------

const cfg = () => CONFIG.pickups?.absorb?.riser ?? {};

// key -> voice. Keyed like the card riser's and for the same reason: two
// chunks can be in the water at once (a boss ejection landing on top of an
// ambient one), and "stop the newest" is the wrong answer to a piece arriving
// from the older burst.
const voices = new Map();

// The backstop. A chunk's vacuum is a second and a half and there are rarely
// two, so anything past this is a leak — and a leaked voice here is a LOOPING
// source, which is not a glitch but a sound that never stops.
const MAX_VOICES = 4;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Take one vacuum down. `key` is whatever was passed to start. Safe for a key
 * that never had one, which is the common case — the fallback path pays
 * without a burst and never starts a riser at all.
 */
export function stopAbsorbRiser(key, fade) {
  const v = voices.get(key);
  if (!v) return false;
  voices.delete(key);
  // The voice's OWN fade-out, not the table's: a pickup absorbed under an
  // overlay (CONFIG.pickups.absorb.orb) is entitled to its own numbers, and
  // reading the shared block here is how the one number that ends the sound
  // stops being the one the rest of it was built from.
  tearDownBank(v, fade ?? v.out);
  return true;
}

/** Every vacuum down. A run ending or restarting — see resetGooSuck, which
 *  drops the payloads these were scoring. */
export function resetAbsorbRisers(fade) {
  const all = [...voices.keys()];
  for (const k of all) stopAbsorbRiser(k, fade ?? 0.05);
  return all.length;
}

/**
 * Start the draw.
 *
 * @param key       the bunch this belongs to
 * @param approach  seconds the first piece is EXPECTED to take. The bands are
 *                  swept across exactly this and the peak is scheduled at the
 *                  end of it — then moved by `arriveAbsorbRiser` when the real
 *                  arrival happens.
 * @param spread    seconds the rest of the pieces are expected to land over.
 *                  The settle runs across it, so the wash is gone about when
 *                  the ladder tops out.
 *
 * Returns true if a voice is actually sounding, which no caller needs and the
 * harness does.
 */
export function startAbsorbRiser(key, approach, spread, tune) {
  stopAbsorbRiser(key, 0.005);

  // THIS PICKUP'S OWN NUMBERS WHERE IT HAS ANY. absorbInPieces overlays the
  // shared block with the pickup's (CONFIG.pickups.absorb.orb), and the riser
  // has to be handed the overlaid one — read back off CONFIG here, the blue
  // orb's `riser: { enabled: false }` would be silently ignored and the one
  // pickup that must not have a vacuum would get the chunk's.
  const c = tune ?? cfg();
  if (c.enabled === false) return false;
  // Not an error and not worth a warning: audio is locked until the player's
  // first gesture. The chunk still goes down, silently.
  if (!isAudioLive()) return false;

  const ctx = getAudioContext();
  const master = getSfxBus();
  if (!ctx || !master) return false;

  const bands = (c.bands ?? []).filter((b) => b && (b.level ?? 0) > 0);
  // Every fader down is a deliberate silence, not a broken riser.
  if (!bands.length) return false;

  // Oldest first, so the backstop drops the vacuum that has been running
  // longest rather than the one that just started.
  while (voices.size >= MAX_VOICES) stopAbsorbRiser(voices.keys().next().value, 0.02);

  const now = ctx.currentTime;
  const dur = Math.max(0.05, approach ?? 0.8);
  const span = Math.max(0.02, spread ?? 0.5);

  // --- WHAT MAKES THIS CHUNK DIFFERENT FROM THE LAST ONE --------------------
  // Rolled once and shared down the bank, exactly as the card riser does it: a
  // bank whose members each wandered off independently is a different, worse
  // sound every time instead of the same sound in a different mood. A chunk is
  // rarer than a card, so this wants less than the card's variation — but not
  // none, because a run eats a dozen of them.
  //
  // NOTHING HERE TOUCHES THE TIMING. The length is the flight.
  const vary = c.vary ?? {};
  const jitter = (amt) => 1 + (Math.random() * 2 - 1) * Math.max(0, amt ?? 0);
  const transpose = 2 ** (((Math.random() * 2 - 1) * Math.max(0, vary.pitch ?? 0)) / 12);
  // One factor for BOTH wobble rates, so a bank that varies its speed keeps its
  // acceleration. Two rolls would sometimes invert it.
  const wobbleMul = jitter(vary.wobble);

  const mod = {
    steps: c.steps, curve: c.curve,
    wobbleDepth: c.wobbleDepth,
    wobbleFrom: (c.wobbleFrom ?? 0) * wobbleMul,
    wobbleTo: (c.wobbleTo ?? 0) * wobbleMul,
  };

  // --- THE ENVELOPE, WHICH IS THE WHOLE DIFFERENCE FROM A CARD RISER --------
  // A card's climbs and is CUT. This one climbs, ARRIVES, and then gets out of
  // the way of the ladder — so the settle is part of the gesture rather than a
  // teardown, and it is scheduled here rather than waiting on a callback.
  const gain = ctx.createGain();
  const base = Math.max(0, (c.gain ?? 0.1) * jitter(vary.level));
  // How much louder the arrival is than the top of the attack. This is the
  // number that makes the approach read as an approach.
  const swell = Math.max(0, c.swell ?? 1.8);
  const top = base * swell;
  // A SHARE OF THE FLIGHT, not seconds — the same unit the card riser's attack
  // is in and for the same reason: a fixed attack that is right for a chunk's
  // one-second haul never gets off the floor inside the blue orb's quarter of
  // one, and a share keeps its shape when either is retuned.
  const attack = clamp(c.fadeIn ?? 0.25, 0.005, 0.95) * dur;
  // Where it lands while the rest of the pieces come in, as a share of the
  // peak. Not zero: the vacuum is still running — there is still goo in the
  // water — and a wash under the ladder is what says so.
  const tail = clamp(c.tail ?? 0.3, 0, 1);
  const out = Math.max(0.01, c.fadeOut ?? 0.12);

  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(base, now + attack);
  gain.gain.linearRampToValueAtTime(top, now + dur);
  gain.gain.linearRampToValueAtTime(Math.max(0.0001, top * tail), now + dur + span);
  // THE BACKSTOP, and the reason this is scheduled rather than driven: a burst
  // whose pieces never report — the reserve came back empty, the run ended
  // under it — still ends. Every path that starts one of these also stops it,
  // and "every path" is exactly the claim that is wrong the first time a new
  // caller forgets.
  gain.gain.linearRampToValueAtTime(0, now + dur + span + out);
  gain.connect(master);

  const { sources, filters } = buildBank(ctx, {
    bands, dur, now, out: gain, mod, transpose,
    spread: vary.spread ?? 0,
    reverse: c.reverse === true,
    stopAt: now + dur + span + out + 0.1,
  });

  voices.set(key, {
    ctx, gain, sources, filters,
    dur, span, top, tail, out,
    // The correction's length travels WITH the voice for the same reason the
    // fade-out does: it is this pickup's number, and the arrival that reads it
    // happens a second after the config that chose it was overlaid.
    snap: Math.max(0.005, c.snap ?? 0.035),
    startedAt: now, arrivedAt: null,
  });
  return true;
}

/**
 * THE FIRST PIECE LANDED. Peak here, wherever the swell had got to, and start
 * the settle.
 *
 * `spread` is how long the REST of the pieces are expected to take, which the
 * caller knows and this does not (it is the stagger). Omitted, the one the
 * riser was started with is used.
 *
 * Re-aimed from the LIVE value rather than from the peak: a flight that came
 * in early is still mid-climb, and jumping it to full for the length of a snap
 * ramp is an audible step exactly where the sound is supposed to be smoothest.
 */
export function arriveAbsorbRiser(key, spread) {
  const v = voices.get(key);
  if (!v) return false;
  // Once. Every piece after the first lands during the settle, and re-peaking
  // on each of them would turn the wash into a pumping that tracks the ladder
  // — the ladder already says how many there are.
  if (v.arrivedAt != null) return false;

  try {
    const now = v.ctx.currentTime;
    const span = Math.max(0.02, spread ?? v.span);
    const snap = v.snap;
    const g = v.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(v.top, now + snap);
    g.linearRampToValueAtTime(Math.max(0.0001, v.top * v.tail), now + snap + span);
    g.linearRampToValueAtTime(0, now + snap + span + v.out);
    // The sources' backstop moves with it. `stop` called again supersedes the
    // last call, so a flight that ran long past the estimate does not get cut
    // off at the estimate — which would silence the settle and leave the ladder
    // running over nothing.
    for (const s of v.sources) s.stop(now + snap + span + v.out + 0.1);
    v.arrivedAt = now;
  } catch {
    // A context that went away underneath us. The bar still fills; that is the
    // part that matters, and it is not this file's.
    return false;
  }
  return true;
}

/** How many vacuums are sounding. For the harness, and for a panel that wants
 *  to know whether the thing it is tuning is actually running. */
export function absorbRiserCount() {
  return voices.size;
}

/** What one live vacuum was aimed at. For a test that wants to assert the
 *  sweep was scheduled across the flight rather than across a typed decay. */
export function absorbRiserSpan(key) {
  const v = voices.get(key);
  if (!v) return null;
  return {
    dur: v.dur, span: v.span, bands: v.filters.length,
    startedAt: v.startedAt, arrivedAt: v.arrivedAt,
    top: v.top, tail: v.tail,
  };
}
