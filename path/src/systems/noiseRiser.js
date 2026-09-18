// ---------------------------------------------------------------------------
// A BANK OF SWEPT NOISE BANDS — the engine under every riser in the game.
// ---------------------------------------------------------------------------
// One looping noise source per band, each through its own resonant bandpass
// climbing its own range across a known span, mixed by level into one shared
// envelope. The MIX between them is the sound design; the code does not care
// how many there are.
//
// This was systems/cardRiser.js's private machinery until the chum chunk's
// vacuum wanted the same bank with a different envelope on it. What was worth
// sharing is exactly this much — the noise, the sweep and the bank — and what
// was NOT is the shape: a card riser is climb-and-be-cut, a vacuum is
// climb-arrive-settle, and those are two different gestures that happen to be
// made of the same material. So the ENVELOPE stays with each caller, which is
// the part either of them would ever want to change.
//
// NO TONE ANYWHERE IN HERE, and that is a decision rather than an omission: a
// riser made of pitched material is a NOTE that gets brighter, because the ear
// locks onto the fundamental and hears the filter as timbre. Noise gives it
// nothing to lock onto, so the same sweep reads as MOVEMENT — which is the
// only thing a riser has to say, and it keeps it off the pitched sounds it is
// building toward (the tier stings under a card, the pip ladder under a
// chunk).
// ---------------------------------------------------------------------------

// ONE SECOND OF WHITE NOISE, generated once and looped by every band.
//
// Cached against the context rather than the module: audio.js can hand back a
// new context after a reset, and a buffer from a dead one throws on connect.
// Generated rather than loaded because a second of noise is a second of noise —
// there is nothing to author, and a sample would be 170KB of it. Shared across
// bands and across voices; a BufferSource is a cheap read head over it, not a
// copy.
let noiseCache = null;
export function loopNoise(ctx) {
  if (noiseCache?.ctx === ctx) return noiseCache.buf;
  const frames = Math.max(1, Math.floor(ctx.sampleRate));
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  noiseCache = { ctx, buf };
  return buf;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * THE SWEEP, WITH ITS CURVE AND ITS WOBBLE, scheduled up front.
 *
 * All three of these could be nodes — an LFO into the filter's frequency, a
 * second LFO onto its rate — and they are one scheduled curve instead for a
 * reason worth keeping: an accelerating wobble needs its PHASE integrated, and
 * an oscillator whose frequency is being ramped does not do that (it jumps).
 * Written as points, the phase is a running sum and the acceleration is exact.
 * It is also the only shape that can be asserted in a test without a real
 * audio graph, and everything below is scheduled once with no per-frame work.
 *
 * `steps` is resolution, not shape. It has to clear a couple of points per
 * wobble cycle or the wobble aliases into a wrong, slower one.
 */
export function scheduleSweep(param, from, to, dur, now, mod) {
  const steps = clamp(Math.round(mod.steps ?? 48), 2, 512);
  // THE SKEW. 1 is the plain exponential — even in octaves, which is even to
  // the ear. Under 1 the sweep opens early and hangs at the top; over 1 it
  // holds low and rushes the last third, which is the one that reads as an
  // approach rather than as a slide.
  const curve = Math.max(0.05, mod.curve ?? 1);
  const depth = Math.max(0, mod.wobbleDepth ?? 0);
  const rFrom = Math.max(0, mod.wobbleFrom ?? 0);
  const rTo = Math.max(0, mod.wobbleTo ?? rFrom);

  param.setValueAtTime(from, now);
  const ratio = to / from;
  let phase = 0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const prev = (i - 1) / steps;
    let f = from * ratio ** (t ** curve);
    if (depth > 0) {
      // Rate at the midpoint of the step, integrated into a running phase, so
      // a wobble that speeds up stays continuous instead of clicking.
      const rate = rFrom + (rTo - rFrom) * ((t + prev) / 2);
      phase += rate * (t - prev) * dur * Math.PI * 2;
      // ...under a sine window, zero at both ends. A wobble still going at the
      // landing leaves the band somewhere other than where it was aimed, and
      // arriving exactly on the beat is the whole point of scheduling this.
      // Most unstable in the middle, clean into the hit.
      f *= 2 ** ((depth * Math.sin(phase) * Math.sin(Math.PI * t)) / 12);
    }
    param.linearRampToValueAtTime(Math.max(20, f), now + t * dur);
  }
}

/**
 * BUILD THE BANK and hang it off `out`.
 *
 * @param ctx   the audio context
 * @param opts  {
 *   bands:     the fader rows — { level, q, from, to, at }. A row at level 0 is
 *              a deliberate silence and is expected to be filtered out by the
 *              caller before it gets here.
 *   dur:       the span every sweep is scheduled across. This is the number
 *              that makes a riser land ON something rather than after a decay
 *              somebody typed.
 *   now:       the audio clock at the trigger
 *   out:       the shared envelope gain every band mixes into
 *   mod:       { steps, curve, wobbleDepth, wobbleFrom, wobbleTo } — shared,
 *              because the bank has to read as ONE gesture. Bands sweeping on
 *              different curves is three risers, not one.
 *   transpose: the whole bank moved together, as a frequency ratio
 *   spread:    how far each END of each band is nudged on top of that, as a
 *              fraction rolled per end. This is what stops the bands moving in
 *              lockstep — it varies how far each one TRAVELS and not just
 *              where it sits.
 *   reverse:   flip every band end for end. A riser that falls is a real
 *              gesture and the opposite feeling.
 *   stopAt:    the audio time every source is stopped at. A LOOPING buffer is
 *              the one node here that genuinely never ends on its own, so this
 *              is the backstop, not the shape.
 * }
 *
 * Returns { sources, filters } — the sources so they can be stopped, the
 * filters because what a band was actually aimed at is the one thing a test of
 * a riser can check without ears.
 */
export function buildBank(ctx, {
  bands, dur, now, out, mod = {}, transpose = 1, spread = 0, reverse = false, stopAt,
}) {
  const buf = loopNoise(ctx);
  const sources = [];
  const filters = [];
  const jitter = () => 1 + (Math.random() * 2 - 1) * Math.max(0, spread);

  for (const b of bands) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    // Q is per band and has to be: a wide low wash and a narrow top whistle are
    // the same node with two very different numbers in it, and that difference
    // is most of what distinguishes them.
    band.Q.value = Math.max(0.0001, b.q ?? 4);
    // NO CLAMP FORCING `to` ABOVE `from`. There was one, and it quietly made a
    // descending band impossible while the panel's own tooltip claimed you
    // could have one. A band that falls under two that climb is a real sound,
    // and `reverse` is the whole bank doing it at once.
    let from = (b.from ?? 140) * transpose * jitter();
    let to = (b.to ?? 5200) * transpose * jitter();
    if (reverse) { const t = from; from = to; to = t; }
    // Audible range only. A transpose that pushed the top band past Nyquist
    // would not throw — it would silently drop that band out of the mix, which
    // reads as the variation "sometimes not working".
    from = clamp(from, 20, 18000);
    to = clamp(to, 20, 18000);
    scheduleSweep(band.frequency, from, to, dur, now, mod);

    // THE FADER, and its entry. `at` is a fraction of the span — a band that
    // comes in late is the cheapest way to make a short riser feel like it has
    // stages, and it costs nothing but a scheduled point.
    const lvl = ctx.createGain();
    const at = clamp(b.at ?? 0, 0, 0.95) * dur;
    const level = Math.max(0, b.level ?? 1);
    if (at > 0) {
      lvl.gain.setValueAtTime(0, now);
      lvl.gain.setValueAtTime(0, now + at);
      lvl.gain.linearRampToValueAtTime(level, now + at + Math.min(0.06, (dur - at) * 0.4));
    } else {
      lvl.gain.value = level;
    }

    src.connect(band).connect(lvl).connect(out);
    // A random read offset into the loop, so the bands are decorrelated — three
    // bands reading the same noise at the same offset is one noise heard
    // through three filters, which correlates them and thins the bank out.
    src.start(now, Math.random() * 0.5);
    src.stop(stopAt);
    sources.push(src);
    filters.push(band);
  }

  return { sources, filters };
}

/**
 * Take a voice down: fade the shared envelope and stop every looping source
 * behind it.
 *
 * `setValueAtTime` before the ramp, always: without it the ramp starts from
 * whatever value was last *scheduled* rather than from what is actually
 * sounding, so a riser cut mid-swell jumps to its peak for the length of the
 * fade — which on an impact-timed choke is the one frame you would hear it.
 */
export function tearDownBank({ ctx, gain, sources }, fade) {
  try {
    const now = ctx.currentTime;
    const out = Math.max(0.005, fade);
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + out);
    // Every band is a LOOPING buffer, so these are the nodes that genuinely
    // never end on their own. Forgetting them is silent rather than loud — the
    // shared gain has already closed — which is how a leak like this survives
    // to forty of them.
    for (const s of sources) s.stop(now + out + 0.02);
  } catch {
    // A context that went away underneath us (tab suspended, audio reset).
    // Nothing to clean up the GC won't take, and throwing here would take the
    // thing being scored down with it.
  }
}
