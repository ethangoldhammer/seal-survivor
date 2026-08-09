import { CONFIG } from '../config.js';
import { getActivePad } from '../input.js';

// Controller rumble.
//
// This used to be a call to navigator.vibrate(). That's the Vibration API — it
// only exists on mobile browsers, and even where it exists it buzzes the PHONE.
// It has never had any connection to a gamepad, so on desktop the optional call
// silently evaluated to undefined and every haptic in CONFIG.feedback did
// nothing at all. Controllers are driven through the pad's own
// vibrationActuator instead.

let warnedUnsupported = false;
let warnedRejected = false;

// Live counters, shown in the G overlay. "Rumble available" and "rumble actually
// being sent" are different claims, and only the second one distinguishes a
// silent config from silent hardware.
export const hapticStatus = { sent: 0, lastMagnitude: 0, lastError: '' };

export function initHaptics() {
  // Alt-tabbing away mid-explosion would otherwise leave a motor spinning until
  // the effect's duration ran out in the background — or indefinitely, if the
  // pad drops while an effect is live.
  window.addEventListener('blur', stopHaptics);
}

// playEffect REPLACES whatever is currently playing rather than queueing, so a
// stray bullet tick landing mid-explosion would cut the explosion short. Track
// what's live and let a weaker effect yield to a stronger one still running.
let activeUntil = 0;
let activeMagnitude = 0;
// { id, magnitude } per scheduled pulse, NOT bare timer ids. See cancelWeaker.
let pendingPulses = [];

function actuator() {
  const pad = getActivePad();
  // dual-rumble is the effect every mainstream pad supports. Xbox pads also
  // expose trigger-rumble, but it's Windows-only in practice, so it isn't worth
  // a separate code path.
  const act = pad?.vibrationActuator;
  if (!act?.playEffect) {
    if (pad && !warnedUnsupported) {
      warnedUnsupported = true;
      console.info(`[haptics] "${pad.id}" exposes no vibrationActuator — no rumble available for this pad.`);
    }
    return null;
  }
  return act;
}

// Normalises the two shapes CONFIG.feedback[*].haptic can take.
//
// Legacy, and what saved tuning holds: a Vibration-API millisecond pattern —
// [18] or [30, 25, 45], where odd positions are silent gaps.
//
// Richer, for designing a specific feel:
//   haptic: { duration: 45, magnitude: 0.8, delay: 0 }
//   haptic: [{ duration: 30, magnitude: 1 }, { duration: 45, magnitude: 0.5, delay: 25 }]
function toPulses(spec) {
  if (typeof spec === 'number') return [{ duration: spec, magnitude: null, delay: 0 }];

  if (!Array.isArray(spec)) {
    if (!spec || typeof spec !== 'object') return [];
    return [
      {
        duration: spec.duration ?? 40,
        magnitude: spec.magnitude ?? null,
        delay: spec.delay ?? 0,
      },
    ];
  }

  if (spec.length && typeof spec[0] === 'object') {
    let cursor = 0;
    return spec.map((p) => {
      const delay = cursor + (p.delay ?? 0);
      cursor = delay + (p.duration ?? 40);
      return { duration: p.duration ?? 40, magnitude: p.magnitude ?? null, delay };
    });
  }

  // Millisecond on/off pattern.
  const pulses = [];
  let cursor = 0;
  spec.forEach((ms, i) => {
    if (i % 2 === 0 && ms > 0) pulses.push({ duration: ms, magnitude: null, delay: cursor });
    cursor += ms;
  });
  return pulses;
}

// A millisecond pattern carries no intensity, so it has to come from somewhere.
// The authored pulse LENGTH is that somewhere: the existing table already runs a
// clean scale of importance from a 6ms muzzle tick up to a 45ms hit taken, which
// is exactly the ordering rumble wants.
//
// Deliberately NOT derived from the event's `shake`. Shake and rumble are
// separate channels a designer will want to move independently — feedback.kill
// in the saved tuning sits at shake 0 precisely because the screen shouldn't
// jump on every kill, and that must not also mean kills stop being felt in the
// hands.
export function magnitudeFromDuration(ms) {
  const h = CONFIG.haptics;
  const floor = h.floor ?? 0.15;
  const norm = Math.min(1, Math.max(0, ms / (h.fullAtMs ?? 45)));
  return floor + (1 - floor) * Math.pow(norm, h.curve ?? 0.6);
}

/**
 * The pulse list a spec resolves to, for the Haptics tab — same normalisation
 * the playback path uses, so what the panel edits is what actually fires.
 *
 * `magnitude: null` on a pulse means "derived from length", which is what
 * every legacy ms pattern still in saved tuning reports; the tab shows that
 * derived number greyed until you move the slider, and moving it rewrites the
 * event in explicit-pulse form.
 *
 * Two different delay fields, because the two forms disagree and conflating
 * them is a live bug rather than a nicety:
 *   delay  ABSOLUTE ms from the start of the pattern. What the timers in
 *          playHaptic need, and what a UI would draw.
 *   gap    RELATIVE to the end of the previous pulse. What the AUTHORED form
 *          in CONFIG holds, and therefore the only one safe to write back.
 * Writing `delay` back as if it were authored re-adds the previous pulse's
 * duration on every edit, walking the tail later and later each time a slider
 * moves.
 */
export function describeHaptic(spec) {
  let prevEnd = 0;
  return toPulses(spec).map((p, i) => {
    const gap = i === 0 ? p.delay : p.delay - prevEnd;
    prevEnd = p.delay + p.duration;
    return {
      duration: p.duration,
      magnitude: p.magnitude,
      delay: p.delay,
      gap: Math.max(0, gap),
      resolved: p.magnitude ?? magnitudeFromDuration(p.duration),
    };
  });
}

// ===========================================================================
// THE MIXER — why this exists.
//
// `playEffect` REPLACES whatever is currently playing. There is no additive
// mode on the Gamepad API and no second channel to put things on, so with one
// effect in flight at a time the loudest event simply erases everything else:
// a kill landing mid-volley wiped the shooting rumble instead of punching
// through it, and the shooting rumble came back afterwards as if nothing had
// happened. All the yield-to-stronger and cancel-the-weaker logic in this file
// existed to make that erasure pick the least-bad victim.
//
// So the summing happens HERE instead. Every pulse becomes a VOICE with an
// envelope; each tick sums the live voices and sends ONE effect carrying the
// total. The pad still only ever has one effect in flight — it just now
// represents the whole mix rather than the most recent event.
//
// Two consequences worth knowing:
//   - Repeated events fuse into a bed. At a fast fire rate the shot voices
//     overlap and stop reading as separate taps, which is the "steady pulse"
//     this was built for; `release` is the knob that decides how fused.
//   - Yielding and cancelling become meaningless and are gone in this path.
//     Nothing can truncate anything else any more, because nothing is
//     competing for the one slot.
// ===========================================================================

// { mag, start, end, release } — all times in performance.now() ms.
let voices = [];
let tickTimer = null;
let lastSent = -1;

/** One voice's contribution at time `t`: flat while it holds, then a linear
 *  fall over `release`. The release tail is the whole reason a burst of short
 *  taps can add up to something continuous — with a rectangular envelope, two
 *  20ms pulses 100ms apart never overlap and never sum. */
export function voiceLevel(v, t) {
  if (t < v.start || t >= v.end + v.release) return 0;
  if (t <= v.end) return v.mag;
  return v.mag * (1 - (t - v.end) / v.release);
}

/**
 * Sum a set of levels into one magnitude. Pure, and exported, because the mix
 * law is the part worth testing and the part worth arguing about.
 *
 *   soft    1 - Π(1 - level). Two 0.5s make 0.75, three make 0.875, and it can
 *           never exceed 1 no matter how many voices pile on. Loud voices
 *           dominate quiet ones without erasing them — a 0.95 kill over a 0.4
 *           shooting bed reads as 0.97, i.e. the kill, which is exactly the
 *           behaviour asked for. This is the default.
 *   linear  plain sum, clamped. Honest, but pins at 1 almost immediately once
 *           more than two things are running, and everything above the clamp
 *           is indistinguishable.
 *   max     the loudest voice wins. Reproduces the OLD replace-based feel, so
 *           it's the A/B control for judging whether mixing is an improvement.
 */
export function sumLevels(levels, mode = 'soft') {
  if (!levels.length) return 0;
  if (mode === 'max') return Math.max(...levels);
  if (mode === 'linear') return Math.min(1, levels.reduce((a, b) => a + b, 0));
  let remaining = 1;
  for (const l of levels) remaining *= 1 - Math.min(1, Math.max(0, l));
  return 1 - remaining;
}

/** The mix at time `t`, and a prune of anything that has fully decayed. */
function mixAt(t) {
  const m = CONFIG.haptics.mixing ?? {};
  const levels = [];
  let alive = 0;
  for (const v of voices) {
    const level = voiceLevel(v, t);
    if (t < v.end + v.release) voices[alive++] = v; // keep
    if (level > 0) levels.push(level);
  }
  voices.length = alive;
  return Math.min(m.ceiling ?? 1, sumLevels(levels, m.sumMode ?? 'soft'));
}

// The one place an effect actually reaches the pad. Both paths end here.
function send(magnitude, duration) {
  const act = actuator();
  if (!act) return;
  const h = CONFIG.haptics;
  try {
    const result = act.playEffect('dual-rumble', {
      startDelay: 0,
      duration,
      // Two motors: the heavy low-frequency one carries the weight of a hit,
      // the light high-frequency one gives it an edge. Splitting one magnitude
      // across both keeps a single authored number in charge of "how big".
      strongMagnitude: magnitude * (h.strongRatio ?? 1),
      weakMagnitude: magnitude * (h.weakRatio ?? 0.45),
    });
    hapticStatus.sent += 1;
    hapticStatus.lastMagnitude = magnitude;
    // playEffect REJECTS as well as throwing — "preempted" when a later effect
    // replaces this one, or an error if the pad can't take it. Without a catch
    // those surface as unhandled rejections, which both spam the console and
    // hide a genuine "this pad refuses the effect" behind noise. In mixing mode
    // EVERY tick preempts the last on purpose, so this is the common path.
    result?.catch?.((err) => {
      const reason = err?.message ?? String(err);
      if (reason.includes('preempted')) return; // expected whenever we retarget
      hapticStatus.lastError = reason;
      if (!warnedRejected) {
        warnedRejected = true;
        console.warn(`[haptics] the pad rejected a rumble effect — ${reason}`);
      }
    });
  } catch (err) {
    hapticStatus.lastError = err?.message ?? String(err);
  }
}

// How long a pulse holds at full before its release begins. The floor is the
// same reasoning the old path used: a 6ms effect never spins a motor up far
// enough to be felt, so short-and-sharp has to read as lighter through
// magnitude rather than through a genuinely shorter buzz.
function heldDuration(pulse) {
  const h = CONFIG.haptics;
  return Math.min(h.maxDuration ?? 1000, Math.max(h.minDuration ?? 20, pulse.duration));
}

function magnitudeOf(pulse, scale) {
  const h = CONFIG.haptics;
  const authored = pulse.magnitude ?? magnitudeFromDuration(pulse.duration);
  return Math.min(1, Math.max(0, authored * scale * (h.intensity ?? 1)));
}

// --- mixing path -----------------------------------------------------------

function addVoice(pulse, scale) {
  const magnitude = magnitudeOf(pulse, scale);
  if (magnitude <= 0.005) return;
  const m = CONFIG.haptics.mixing ?? {};
  const t = performance.now();
  const held = heldDuration(pulse);
  voices.push({ mag: magnitude, start: t, end: t + held, release: m.release ?? 70 });

  // Don't wait up to a whole tick to let a hit be felt. `tickMs` is a
  // refresh rate for the SUM, not a quantisation grid for onsets — sitting on
  // a kill for 40ms is exactly the latency that makes rumble feel detached
  // from what's on screen.
  tick();
  startTicking();
}

function startTicking() {
  if (tickTimer != null) return;
  const m = CONFIG.haptics.mixing ?? {};
  tickTimer = setInterval(tick, Math.max(10, m.tickMs ?? 40));
}

function stopTicking() {
  if (tickTimer == null) return;
  clearInterval(tickTimer);
  tickTimer = null;
}

function tick() {
  const m = CONFIG.haptics.mixing ?? {};
  const t = performance.now();
  const magnitude = mixAt(t);

  if (magnitude <= 0.005) {
    // Nothing live. Stop the timer so an idle game isn't calling playEffect
    // sixty times a second forever, and reset the pad once.
    stopTicking();
    if (lastSent > 0) {
      lastSent = 0;
      try { actuator()?.reset?.(); } catch { /* nothing playing */ }
    }
    return;
  }

  // Skip sends that wouldn't change anything perceptible. Motors have far less
  // resolution than a float, and every send is a preempt the browser has to
  // process.
  if (Math.abs(magnitude - lastSent) < (m.minStep ?? 0.02)) return;
  lastSent = magnitude;

  // Longer than the tick so consecutive effects OVERLAP. If an effect expired
  // before its replacement arrived the motor would drop to zero in the gap,
  // and a sustained bed would buzz at the tick rate instead of holding.
  const tickMs = Math.max(10, m.tickMs ?? 40);
  send(magnitude, Math.round(tickMs * (m.overlap ?? 2.5)));
}

// --- legacy replace path ---------------------------------------------------

function fire(pulse, scale) {
  if (!actuator()) return;
  const magnitude = magnitudeOf(pulse, scale);
  if (magnitude <= 0.01) return;
  const duration = heldDuration(pulse);

  const now = performance.now();
  // Yield to a stronger effect that hasn't finished yet.
  if (now < activeUntil && magnitude < activeMagnitude) return;
  activeUntil = now + duration;
  activeMagnitude = magnitude;
  send(magnitude, duration);
}

/**
 * @param spec  a CONFIG.feedback[*].haptic value (ms pattern, or pulse objects)
 * @param scale per-instance multiplier the caller already computed (bigger
 *              enemies hit harder), matching how playSfx is scaled
 */
export function playHaptic(spec, scale = 1) {
  if (!spec || !CONFIG.haptics.enabled) return;

  const pulses = toPulses(spec);
  if (!pulses.length) return;

  // Mixing path: every pulse becomes a voice and the tick sums them. No
  // yielding, no cancelling, no special case for a lone pulse — nothing here
  // can erase anything else, so there is nothing to arbitrate.
  if (CONFIG.haptics.mixing?.enabled) {
    for (const pulse of pulses) {
      if (!pulse.delay) addVoice(pulse, scale);
      else pendingPulses.push({ id: setTimeout(() => addVoice(pulse, scale), pulse.delay), magnitude: 0 });
    }
    return;
  }

  // A single pulse is the common case — don't put a timer on the hot path.
  // It still has to clear weaker pending tails, or a light tick landing
  // between two halves of a heavy pattern would leave the tail to fire on its
  // own after the tick had already retargeted the motor.
  if (pulses.length === 1 && !pulses[0].delay) {
    cancelWeaker(pulses[0].magnitude ?? magnitudeFromDuration(pulses[0].duration));
    fire(pulses[0], scale);
    return;
  }

  // Multi-pulse patterns need real timers: playEffect's own startDelay would
  // have each later pulse cancel the one before it, since a second call
  // replaces the current effect outright.
  //
  // Only pulses WEAKER than what's arriving are dropped. This used to clear
  // every pending pulse unconditionally, which was survivable when two events
  // in the table had multi-pulse patterns and is not now: a garlic tick, an
  // eel link or a shrimp clack landing in the 18ms between the two halves of
  // a strike or a calamari pulse would delete the tail of the biggest thing
  // in the game, so the heavy events got quietly truncated exactly when the
  // screen was busy enough to trigger them.
  const peak = pulses.reduce(
    (m, p) => Math.max(m, p.magnitude ?? magnitudeFromDuration(p.duration)),
    0,
  );
  cancelWeaker(peak);
  for (const pulse of pulses) {
    const magnitude = pulse.magnitude ?? magnitudeFromDuration(pulse.duration);
    if (!pulse.delay) fire(pulse, scale);
    else pendingPulses.push({ id: setTimeout(() => fire(pulse, scale), pulse.delay), magnitude });
  }
}

// Drop scheduled pulses that a louder incoming effect would drown anyway.
// Anything at or above `magnitude` is left alone to finish.
function cancelWeaker(magnitude) {
  const kept = [];
  for (const p of pendingPulses) {
    if (p.magnitude >= magnitude) kept.push(p);
    else clearTimeout(p.id);
  }
  pendingPulses = kept;
}

function cancelPending() {
  for (const p of pendingPulses) clearTimeout(p.id);
  pendingPulses = [];
}

/** Kills any rumble in flight — a run ending or the window losing focus should
 *  never leave a motor spinning. */
export function stopHaptics() {
  cancelPending();
  voices.length = 0;
  stopTicking();
  lastSent = -1;
  activeUntil = 0;
  activeMagnitude = 0;
  try {
    getActivePad()?.vibrationActuator?.reset?.();
  } catch {
    /* nothing playing, or no actuator */
  }
}

/** Whether the live pad can actually rumble — surfaced in the G overlay so
 *  "I feel nothing" is answerable without guesswork. */
export function hapticsAvailable() {
  return !!getActivePad()?.vibrationActuator?.playEffect;
}

/** One clear buzz, for tuning by feel rather than by number. */
export function testHaptic() {
  stopHaptics();
  playHaptic([90], 1);
}

/** Fire one event's authored pattern on demand — the Haptics tab's Test
 *  button. Stops whatever is playing first so you're feeling the pattern you
 *  just edited and not the tail of the last one. */
export function previewHaptic(spec) {
  stopHaptics();
  playHaptic(spec, 1);
}
