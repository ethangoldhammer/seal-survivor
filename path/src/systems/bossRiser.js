import { CONFIG } from '../config.js';
import { getAudioContext, getSfxBus, isAudioLive } from './audio.js';

// ---------------------------------------------------------------------------
// THE BOSS RISER — the two seconds of filter sweep under an arriving boss.
// ---------------------------------------------------------------------------
// A continuous voice, which is why it is not a CONFIG.sfx entry. Everything in
// that table is a one-shot: a buffer or an oscillator, an envelope, a decay,
// and it is gone. This is a pad that has to stay up for as long as the health
// bar takes to fill and be REWRITTEN while it does — the filter tracks the
// bar, so a bar that is 40% full sounds 40% of the way up. Expressed as a
// one-shot it could only be a fixed-length sample that drifted out of sync
// with the thing it is scoring the moment either changed.
//
// The mussel's flight voice is the same shape and the reason getSfxBus()
// exists: hanging off `master` rather than ctx.destination keeps this inside
// the shared filter and reverb send, so a riser ducks underwater with
// everything else instead of sitting oddly dry on top of the mix.
//
// ONE VOICE, EVER. `stop()` before `start()` in every path below, because two
// bosses arriving inside two seconds of each other is not impossible (a level
// gap of 8 is a handful of seconds to a build that is eating well) and two
// detuned saws playing the same sweep at different offsets is not "louder", it
// is a beating dissonance that sounds like a bug.

let voice = null;

/** Tear the graph down. Safe at any time, including when nothing is playing. */
export function stopBossRiser(fade = true) {
  if (!voice) return;
  const { ctx, gain, oscA, oscB } = voice;
  voice = null;
  try {
    const now = ctx.currentTime;
    const out = fade ? Math.max(0.01, CONFIG.boss?.arrival?.riser?.fadeOut ?? 0.12) : 0.01;
    gain.gain.cancelScheduledValues(now);
    // setValueAtTime first: without it the ramp starts from whatever value was
    // last *scheduled* rather than from what is actually sounding, and a pad
    // cut off mid-sweep jumps to full gain for the length of the fade.
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + out);
    oscA.stop(now + out + 0.02);
    oscB.stop(now + out + 0.02);
  } catch {
    // A context that went away underneath us (tab suspended, audio reset).
    // Nothing to clean up that the GC won't take, and throwing here would
    // take the boss's arrival down with it.
  }
}

/**
 * Start the sweep. `seconds` is how long the arrival will take — the filter is
 * scheduled across exactly that, so it lands open at the same moment the bar
 * fills, with no per-frame work in the common case.
 *
 * Returns true if a voice is actually sounding, which the caller does not need
 * but a test does.
 */
export function startBossRiser(seconds) {
  stopBossRiser(false);

  const cfg = CONFIG.boss?.arrival?.riser ?? {};
  if (cfg.enabled === false) return false;
  // Not an error and not worth a warning: audio is locked until the player's
  // first gesture, and a boss can in principle arrive before one. The arrival
  // still runs, silently.
  if (!isAudioLive()) return false;

  const ctx = getAudioContext();
  const master = getSfxBus();
  if (!ctx || !master) return false;

  const now = ctx.currentTime;
  const dur = Math.max(0.1, seconds ?? 2);

  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  const oscA = ctx.createOscillator();
  const oscB = ctx.createOscillator();

  const hz = Math.max(20, cfg.hz ?? 55);
  oscA.type = 'sawtooth';
  oscB.type = 'sawtooth';
  oscA.frequency.value = hz;
  oscB.frequency.value = hz;
  // The detune is the whole body of the sound. Split either side of centre so
  // the pair beats against each other rather than against the fundamental.
  const detune = cfg.detune ?? 9;
  oscA.detune.value = -detune;
  oscB.detune.value = detune;

  filter.type = 'lowpass';
  filter.Q.value = Math.max(0.0001, cfg.resonance ?? 7);
  const from = Math.max(20, cfg.cutoffFrom ?? 180);
  const to = Math.max(from, cfg.cutoffTo ?? 2600);
  filter.frequency.setValueAtTime(from, now);
  // Exponential, not linear: pitch and brightness are both logarithmic to the
  // ear, and a linear sweep spends its first half inaudibly low and its second
  // half arriving all at once.
  filter.frequency.exponentialRampToValueAtTime(to, now + dur);

  const peak = Math.max(0, cfg.gain ?? 0.16);
  const fadeIn = Math.max(0.01, cfg.fadeIn ?? 0.35);
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(peak, now + Math.min(fadeIn, dur));

  oscA.connect(filter);
  oscB.connect(filter);
  filter.connect(gain).connect(master);
  oscA.start(now);
  oscB.start(now);
  // A hard backstop on the voice's life. Every path that starts one also stops
  // it, but "every path" includes a run reset in the middle of an arrival, and
  // an oscillator with nothing left holding a reference to it plays forever.
  oscA.stop(now + dur + 1);
  oscB.stop(now + dur + 1);

  voice = { ctx, gain, filter, oscA, oscB };
  return true;
}

/** True while a riser is sounding. For the harness, and for a HUD that wants
 *  to know whether the ceremony is actually running. */
export function bossRiserActive() {
  return !!voice;
}
