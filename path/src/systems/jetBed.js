import { CONFIG } from '../config.js';
import { getAudioContext, getSfxBus, isAudioLive, sampleBuffer } from './audio.js';

// ---------------------------------------------------------------------------
// THE JET'S SOUND BED — one voice that ramps up and then HOLDS.
// ---------------------------------------------------------------------------
// Every sound in CONFIG.sfx is a one-shot: a source, an envelope, a decay,
// gone. That table cannot describe this, and not because of a missing field —
// because of a missing QUESTION. A one-shot knows how long it lasts at the
// moment it is triggered. This one does not: the stream is held open for as
// long as the seal is pointed at something, so the sound has to be told when to
// stop by whatever is making the noise rather than by a number typed next to
// it. systems/cardRiser.js left CONFIG.sfx for the same reason from the other
// direction — its length is known and is not a constant — and this file is its
// twin: START, HOLD FOREVER, RELEASE.
//
// THE SHAPE, which is the whole brief and is worth saying in one place:
//
//   RAMP     the filter opens and the level climbs. This is the spool — the
//            thing winding up to a pitch, and the only part with any movement
//            in it.
//   HOLD     flat, and flat is the point. A sustained sound that keeps
//            developing is a sound that never arrives; the ear reads the
//            arrival as the moment the change stops. It breathes on a slow LFO
//            so it is not DEAD, but it goes nowhere.
//   RELEASE  down, fast. The stream is cut, not faded out — AND THE TAIL IS
//            THE BUS'S, not this file's. A bed lands on the shared sfx bus
//            like every other sound in the game, and that bus has a reverb
//            send on it (systems/audio.js) — so whatever room the game is in,
//            a released bed is already in it, decaying alongside everything
//            else rather than in a private space of its own.
//
//            THERE WAS A PER-BED CONVOLVER HERE AND IT IS GONE. It was built
//            to make a release "land somewhere", and what it actually did was
//            put one sound in a different room from the rest of the mix and
//            keep ringing after the gesture that made it had ended. A driven
//            bed in particular has to be gone the moment its driver stops —
//            see CUT_FADE — and a half-second private tail is the one thing
//            that can outlive a hard cut.
//
// WHY A MOOG AND NOT NOISE. The riser under a card is noise, deliberately, and
// its file says why: pitched material makes a riser into a note that gets
// brighter, and the ear locks onto the fundamental. That is exactly the wrong
// call HERE and exactly the right one there, because these two sounds are
// asked for opposite things. A riser has to be MOVEMENT with no identity, so
// it can be taken away. This one has to be an IDENTITY that holds — a thing
// with a note in it that you can point at and that stays pointed at while it
// burns. Noise held flat for four seconds is a hiss you stop hearing; a
// saturated stack of saws held flat for four seconds is a machine running.
//
// THE OVERDRIVE IS NOT A VOLUME. It is a waveshaper BEFORE the filter, which is
// the ordering that makes it sound like a Moog rather than like a loud synth:
// drive first generates the harmonics, and the resonant lowpass then decides
// which of them you hear. Distorting after the filter just fuzzes whatever
// survived and cannot be swept. See buildDrive.
//
// A SAMPLE CAN REPLACE THE OSCILLATORS AND KEEP EVERYTHING ELSE. If
// `bed.sample` names a loaded CONFIG.sfx voice, it is looped in place of the
// stack and runs through the same drive, the same filter sweep and the same
// envelope — so an uploaded bed inherits the ramp and the hold rather than
// being a second, unrelated implementation of them. That is the whole reason
// the source is the only swappable part of this graph.

// key -> voice. A Map for the same reason cardRiser's is one: the stage panel
// can hold a bed open while a run holds its own, and "stop the newest" is the
// wrong answer to both.
const voices = new Map();

// The backstop. One jet in a run, one swirl, and one of each in the workbench,
// so anything past a handful is a leak — and a leaked LOOPING voice is not a
// glitch, it is a sound that never stops.
const MAX_VOICES = 6;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Aim an AudioParam at `value`, arriving in `glide` seconds, CANCELLABLY.
 *
 * WHY NOT setTargetAtTime, which is the obvious primitive for a continuously
 * driven param and is what this used to be. A setTargetAtTime has no end time
 * — it approaches its target forever — and `cancelScheduledValues(t)` only
 * removes events scheduled AT OR AFTER t. One that started before the cancel
 * is therefore still running afterwards, and it goes on pulling the param
 * toward its last target underneath whatever you schedule next.
 *
 * That is not a subtle mistuning, it is a bed that cannot be switched off: the
 * release ramp to 0 spends its whole length being fought back up, the gain
 * never arrives, and then `source.stop()` cuts a still-sounding oscillator
 * stack dead — a click, at full amplitude, straight onto the bus. It read as
 * the sound not cutting AND as a short metallic ring, which sounds like two
 * bugs and was this one.
 *
 * A LINEAR RAMP ENDS, so cancelScheduledValues really does clear it. Re-aimed
 * every frame from the live value, it is the same glide with none of that —
 * and it is the shape applyGate and cardRiser already use here.
 *
 * (cancelAndHoldAtTime would also fix it and is not used: it is absent on older
 * WebKit under its standard name, and the fallback there is exactly this.)
 */
function glideParam(param, value, now, glide) {
  param.cancelScheduledValues(now);
  // From the LIVE value, so re-aiming mid-glide is continuous rather than a
  // jump back to wherever the last ramp was headed.
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(value, now + Math.max(0.005, glide));
}

// ---------------------------------------------------------------------------
// THE MENU GATE
// ---------------------------------------------------------------------------
// A bed is the one kind of sound in this game that a paused frame cannot stop.
// Everything else is a one-shot fired from an update that is inside the pause
// gate, so a level-up simply means nothing new starts. This holds by design and
// is released by whatever is making the noise — and `updateJets` is inside that
// gate, so a stream held when the cards came up went on droning under the menu
// for as long as the menu was open. systems/projectileVoices.js has the same
// shape and already takes an `active` flag for exactly this reason.
//
// MUTED WHERE IT STANDS, not released. The stream is still there — the jet
// object survives the menu and the player is still holding the trigger — so
// tearing the voice down would mean coming back to a visible stream with no
// sound until the next re-trigger, and re-triggering is precisely what
// startJetBed refuses to do. The gate rides on its OWN node between the
// envelope and the bus, so muting cannot fight the spool ramp: a bed paused
// mid-spool resumes to the level its envelope has climbed to in the meantime,
// which is where it would have been anyway.
let muted = false;

/**
 * Silence every open bed, or let them back.
 *
 * Called every frame from main.js with `running && !paused`, next to the
 * projectile voices and for the same reason — a transition-only call would
 * miss a bed opened WHILE the menu is up (the workbench can do it) and leave
 * one voice ungated.
 */
export function setJetBedsMuted(on) {
  const want = !!on;
  if (want === muted) {
    // Still applied to any voice that has opened since the last change: the
    // flag is the state, and a bed born during a menu has to arrive gated.
    for (const v of voices.values()) applyGate(v, want, true);
    return;
  }
  muted = want;
  for (const v of voices.values()) applyGate(v, want, false);
}

/** Whether the beds are gated. For the panel and the harness. */
export function jetBedsMuted() {
  return muted;
}

// Seconds. Short enough to be under the menu rather than part of it, long
// enough not to click — a bed cut in one frame pops, and a pop is the one
// thing a mute is supposed to avoid.
const GATE_FADE = 0.06;

// A DRIVEN BED DOES NOT FADE, IT STOPS — and this is the only fade it gets:
// long enough to declick a saturated oscillator stack, short enough that
// nothing is left of the sound by the next frame at 60fps.
//
// WHY IT IS NOT `release`. A spooled bed is a stream that ENDS, and a release
// fade is the right shape for one: the jet's 0.12s is the stream tapering off.
// A driven bed has no shape of its own — something outside is handing it a
// level, and when that something stops handing, the sound is over at that
// instant. The strike's wind-up is the case that made this explicit: the sound
// has to be gone on the frame the button comes up, because what happens on the
// NEXT frame is the dash launching, and a wind-up still tapering across its own
// release reads as the charge outliving the strike it became.
//
// A CONSTANT AND NOT A TUNABLE, deliberately. There is no taste in it — above
// about 20ms it is an audible tail on a gesture that has ended, and below about
// 5ms it is the click the fade exists to avoid. A slider here would only offer
// the two ways of being wrong.
const CUT_FADE = 0.012;

function applyGate(v, on, onlyIfUnset) {
  if (!v?.gate) return;
  const target = on ? 0 : 1;
  if (onlyIfUnset && Math.abs(v.gateTarget - target) < 1e-6) return;
  v.gateTarget = target;
  try {
    const now = v.ctx.currentTime;
    v.gate.gain.cancelScheduledValues(now);
    // From the LIVE value, not the last scheduled one — the same trap tearDown
    // and cardRiser both document: an interrupted fade would otherwise jump to
    // the target it never reached before ramping back.
    v.gate.gain.setValueAtTime(v.gate.gain.value, now);
    v.gate.gain.linearRampToValueAtTime(target, now + GATE_FADE);
  } catch { /* dead context — nothing here is worth taking the frame down for */ }
}

// THE JET'S OWN BED, and the DEFAULT for a caller that names no other. This
// module started as one sound and is now the game's only sustained-voice
// engine: systems/sardineSwirl.js holds one open too, on CONFIG.sardineSwirl
// .bed, and there will be more. The settings are therefore passed in and
// REMEMBERED ON THE VOICE rather than re-read from one fixed path — a release
// that read the jet's `release` while letting go of the swirl's would fade the
// wrong sound at the wrong speed, and nothing about that failure is audible as
// a bug rather than as a taste.
function bedCfg() {
  return CONFIG.bubbleJet?.bed ?? {};
}

// ---------------------------------------------------------------------------
// THE DRIVE CURVE
// ---------------------------------------------------------------------------
// tanh, normalised so the curve still reaches ±1 at its ends. Without that
// normalise, turning the drive up makes the sound QUIETER as well as dirtier —
// the shaper compresses toward its own asymptote — and the fader and the drive
// knob end up fighting each other, which is indistinguishable from the drive
// "not doing very much".
//
// Cached on the quantised amount: a WaveShaper curve is 2048 floats and the
// panel drags this slider, so rebuilding one per frame of a drag is 120 arrays
// a second for a sound that already exists.
const curveCache = new Map();
function driveCurve(amount) {
  const k = Math.round(clamp(amount, 0.01, 40) * 4) / 4;
  const hit = curveCache.get(k);
  if (hit) return hit;
  const N = 2048;
  const curve = new Float32Array(N);
  const norm = Math.tanh(k) || 1;
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  // Bounded, so a long tuning session does not accumulate an array per quarter
  // step across the whole range. 64 is the whole slider at this quantisation.
  if (curveCache.size > 64) curveCache.clear();
  curveCache.set(k, curve);
  return curve;
}

/**
 * The ladder, as two cascaded lowpasses.
 *
 * ONE BIQUAD IS 12dB/OCT AND A MOOG IS 24. That difference is not subtle at
 * high resonance: a single pole pair leaves so much above the cutoff that a
 * swept filter reads as a tone control rather than as the filter being the
 * instrument. Two in series is the cheapest honest approximation, and the
 * resonance is put on the SECOND one only — stacking Q in both stages peaks
 * twice and screams.
 */
function buildLadder(ctx, q) {
  const a = ctx.createBiquadFilter();
  const b = ctx.createBiquadFilter();
  a.type = b.type = 'lowpass';
  a.Q.value = 0.0001;
  b.Q.value = Math.max(0.0001, q);
  a.connect(b);
  return { input: a, output: b, freqs: [a.frequency, b.frequency] };
}

function tearDown(v, fade) {
  const { ctx, gain, sources } = v;
  try {
    const now = ctx.currentTime;
    const out = Math.max(0.005, fade);
    gain.gain.cancelScheduledValues(now);
    // setValueAtTime from the LIVE value, not from the last scheduled one —
    // the same trap cardRiser documents. A bed cut in the middle of its ramp
    // would otherwise jump to its held level for the length of the fade, which
    // is the one moment you would hear it.
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + out);
    for (const s of sources) { try { s.stop(now + out + 0.02); } catch { /* already stopped */ } }
    v.lfo?.stop(now + out + 0.02);
  } catch {
    // The context went away underneath us — a tab suspend, an audio reset.
    // Nothing here is worth taking the frame down for.
  }
}

/**
 * HAND A DRIVEN BED ITS LEVEL — `t` is 0..1, and it is the whole envelope.
 *
 * Called every frame by whatever owns the sound (main.js, off the strike
 * meter's banked power). A bed opened without `envelope` ignores this: it has
 * a spool of its own and two authorities on one AudioParam is not a blend, it
 * is both of them happening.
 *
 * SMOOTHED, AND IT HAS TO BE. Writing `gain.value` once a frame is a staircase
 * at the frame rate, and a staircase on a gain is zipper noise — the one
 * artefact that makes a synthesised sound instantly read as broken rather than
 * as cheap. A short linear ramp re-aimed every frame is the shape for this —
 * see glideParam, which also says why the obvious primitive (setTargetAtTime)
 * is the wrong one here and what it costs: a bed that cannot be switched off.
 *
 * `smooth` is how long the glide takes. Small enough that the meter feels connected
 * to the ear (a wind-up is about a second end to end, so anything over ~50ms
 * starts lagging the bar you are watching) and large enough to swallow the
 * step. It is NOT the attack: a bed still opens from 0 because that is where
 * startJetBed left it, so the first frames glide up rather than clicking on.
 *
 * THE FILTER RIDES IT TOO, exponentially — a sweep is heard in octaves, and a
 * cutoff moved linearly with power spends the whole top half of the bar in the
 * top octave and reads as having stopped. The level climbing WITH the filter
 * is the same thing that makes the spooled version read as gaining power; here
 * it is gaining the power the player is actually banking.
 *
 * Returns false for a key that is not open or not driven, so a caller can tell
 * "I am driving nothing" from "I am driving it to zero".
 */
export function driveJetBed(key, t) {
  const v = voices.get(key);
  if (!v?.driven) return false;
  const k = clamp(Number.isFinite(t) ? t : 0, 0, 1);
  v.level = k;
  try {
    const now = v.ctx.currentTime;
    const smooth = Math.max(0.005, v.cfg?.envelopeSmooth ?? 0.04);
    glideParam(v.gain.gain, v.peak * k, now, smooth);
    // Exponential in the cutoff, which is why this is a ratio raised to `k`
    // rather than a lerp. Guarded above zero because an exponential through 0
    // is not a number and a cutoff of 0 is a filter that has closed entirely.
    const lo = Math.max(20, v.from), hi = Math.max(20, v.to);
    const cut = lo * Math.pow(hi / lo, k);
    for (const f of v.freqs) glideParam(f, cut, now, smooth);
  } catch { /* dead context — nothing here is worth taking the frame down for */ }
  return true;
}

/** Is this key's bed sounding? */
export function jetBedPlaying(key) {
  return voices.has(key);
}

/** How many beds are open. For the harness and for the F panel's readout. */
export function jetBedCount() {
  return voices.size;
}

/**
 * Let one go. `fade` overrides the configured release, which the panel uses to
 * audition the cut on its own.
 */
export function releaseJetBed(key, fade) {
  const v = voices.get(key);
  if (!v) return false;
  voices.delete(key);
  // The settings this voice was OPENED with — see bedCfg. A bed released
  // against a different block's numbers is a fade at the wrong speed onto the
  // wrong cutoff, on a sound the caller has already stopped watching.
  const c = v.cfg ?? bedCfg();
  // A DRIVEN BED CUTS; a spooled one fades. See CUT_FADE for the argument.
  // An explicit `fade` still wins either way — that is the panel auditioning
  // the cut on its own, and a caller that has asked for a length has a reason.
  const rel = fade ?? (v.driven ? CUT_FADE : (c.release ?? 0.12));
  try {
    const now = v.ctx.currentTime;
    // THE FILTER CLOSES WITH THE LEVEL. A bed whose gain alone fell read as
    // someone turning a volume knob down; the cutoff coming back with it is
    // what makes it read as the thing switching off.
    for (const f of v.freqs) {
      f.cancelScheduledValues(now);
      f.setValueAtTime(f.value, now);
      f.linearRampToValueAtTime(Math.max(20, (c.releaseTo ?? c.from ?? 180)), now + rel);
    }
  } catch { /* dead context — tearDown deals with it */ }
  tearDown(v, rel);
  return true;
}

/** Every bed down. A run reset, the panel closing, the player dying mid-burn. */
export function releaseAllJetBeds(fade) {
  const all = [...voices.keys()];
  for (const k of all) releaseJetBed(k, fade);
  return all.length;
}

/**
 * Open one, and leave it open.
 *
 * `key` is whatever the caller wants to hold it by — the jet object in a run,
 * a bare `{}` in the workbench. Re-starting an already-open key is a no-op
 * rather than a restart: the stream is asked to keep burning every frame it
 * burns, and re-triggering the bed on each of those would be sixty attacks a
 * second and no hold at all. That is the single most important line in here.
 *
 * `cfg` is the settings block — CONFIG.bubbleJet.bed when it is left out, which
 * is every caller that predates the swirl. It is READ ONCE HERE and kept on the
 * voice, so a bed whose block is retuned mid-hold finishes on the numbers it
 * started with and the next one opens on the new ones.
 *
 * Returns true when a voice is actually sounding.
 */
export function startJetBed(key, cfg = null) {
  if (voices.has(key)) return true;

  const c = cfg ?? bedCfg();
  if (c.enabled === false) return false;
  // Audio is locked until the player's first gesture. Not an error and not
  // worth a warning — the stream still fires, silently.
  if (!isAudioLive()) return false;

  const ctx = getAudioContext();
  const master = getSfxBus();
  if (!ctx || !master) return false;

  // Oldest first, so the backstop drops the bed that has been running longest.
  while (voices.size >= MAX_VOICES) releaseJetBed(voices.keys().next().value, 0.02);

  const now = ctx.currentTime;
  const ramp = Math.max(0.01, c.ramp ?? 0.45);
  const peak = Math.max(0, c.gain ?? 0.22);

  // --- the envelope ---------------------------------------------------------
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, now);
  // DRIVEN OR SPOOLED — and it is one or the other, never both.
  //
  // A SPOOL is the jet's shape: a fixed ramp to a held level, scheduled once
  // here and then left alone. It is right for a stream, whose whole character
  // is that it winds up and then simply burns.
  //
  // A DRIVEN bed has no shape of its own. Something outside it hands it a
  // level every frame (see driveJetBed) and the bed is whatever that says —
  // which is what a CHARGE wants, because a wind-up is not a fixed ramp: it is
  // however much fuel there was. A hold begun on a half-full bar has to peter
  // out where the fuel runs out, and a scheduled ramp cannot know that.
  //
  // Nothing is scheduled in the driven case, deliberately. A ramp scheduled
  // here and then re-aimed by a per-frame glide is two authorities on one
  // param, and the driver's cancel would be throwing away a spool the bed
  // thinks it is still on — the envelope reads as ignored for the first `ramp`
  // seconds and then suddenly working.
  const driven = !!c.envelope;
  if (!driven) {
    // ATTACK IS A FRACTION OF THE RAMP, not a number of seconds — the same rule
    // cardRiser uses, for the same reason: retune the spool from 0.45 to 1.2 and
    // the shape survives instead of becoming a click followed by a long climb.
    const attack = clamp(c.attack ?? 0.35, 0.01, 1) * ramp;
    gain.gain.linearRampToValueAtTime(peak * (c.attackLevel ?? 0.55), now + attack);
    // ...and it keeps climbing to the held level across the rest of the ramp.
    // The level climbing WITH the filter is what makes the spool read as gaining
    // power rather than as a filter opening on a sound that was already there.
    gain.gain.linearRampToValueAtTime(peak, now + ramp);
  }
  // THE MENU GATE, its own node between the envelope and the bus — see the
  // note on setJetBedsMuted. It starts where the flag currently is, so a bed
  // opened while the cards are up arrives silent instead of announcing itself
  // over the menu and then being faded down a frame later.
  const gate = ctx.createGain();
  gate.gain.value = muted ? 0 : 1;
  gain.connect(gate).connect(master);

  const ladder = buildLadder(ctx, c.resonance ?? 9);
  const shaper = ctx.createWaveShaper();
  shaper.curve = driveCurve(c.drive ?? 6);
  // 4x, because a shaper folding a signal generates harmonics well above the
  // input's own — at '2x' or 'none' those alias back down as inharmonic grit
  // that no amount of filtering afterwards can remove, and it is worst on
  // exactly the held, saturated, low note this sound is.
  shaper.oversample = '4x';
  const pre = ctx.createGain();
  pre.gain.value = Math.max(0.01, c.preGain ?? 1.6);

  pre.connect(shaper).connect(ladder.input);
  ladder.output.connect(gain);

  // --- the sweep ------------------------------------------------------------
  const from = clamp(c.from ?? 180, 20, 18000);
  const to = clamp(c.to ?? 2600, 20, 18000);
  for (const f of ladder.freqs) {
    f.setValueAtTime(from, now);
    // Same split as the level above: a spooled bed sweeps on a clock, a driven
    // one is swept by whatever is driving it and must not also be sweeping
    // itself. EXPONENTIAL, because a filter sweep is heard in octaves — a
    // linear ramp from 180 to 2600 spends most of its time in the top octave
    // and reads as opening instantly and then sitting still.
    if (!driven) f.exponentialRampToValueAtTime(Math.max(20, to), now + ramp);
  }

  // --- the breath -----------------------------------------------------------
  // A slow LFO on the cutoff, and the whole reason the HOLD is not dead. It is
  // deliberately small and deliberately slow: anything you can follow is
  // development, and a held sound that develops never arrives. This is meant to
  // be felt as the thing idling rather than heard as modulation.
  //
  // Started at zero depth and ramped in across the spool, so it does not fight
  // the sweep it is riding on.
  let lfo = null;
  const depth = Math.max(0, c.breathDepth ?? 220);
  if (depth > 0) {
    lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = Math.max(0.01, c.breathRate ?? 0.7);
    const lfoGain = ctx.createGain();
    lfoGain.gain.setValueAtTime(0, now);
    lfoGain.gain.linearRampToValueAtTime(depth, now + ramp);
    lfo.connect(lfoGain);
    // Onto the SECOND pole only. Both would double the swing and, at high
    // resonance, walk the peak twice as far as the number says.
    lfoGain.connect(ladder.freqs[1]);
    lfo.start(now);
  }

  // --- the sources ----------------------------------------------------------
  // LAYERS AND THE STACK TOGETHER, which is the one thing this section used to
  // refuse to do. It was an either/or — name a sample and the oscillators were
  // not built at all — and that made the sample a REPLACEMENT for the bed
  // rather than a part of it. A recorded loop has the grain and the movement
  // no oscillator stack has; the stack has the low weight and the drive
  // response no 16kHz mp3 has. The sound wants both, so both are built and
  // summed into `pre` — ahead of the drive and the ladder, so the layers are
  // saturated and swept TOGETHER as one instrument rather than glued into a
  // pile of separate ones afterwards.
  //
  // `synthLevel` at 0 is the old sample-only behaviour; a `layers` list left
  // empty with no `sample` named is the old synth-only behaviour. Neither is
  // gone, they are just no longer the only two options.
  const sources = [];

  // Every mp3 layer, in one list. `sample` is the single-name shorthand and is
  // simply layer zero — it keeps the top-level loopStart/loopEnd/rate that
  // have always described it, so a bed set up before `layers` existed is
  // unchanged.
  const layers = [];
  if (c.sample) {
    layers.push({ sample: c.sample, level: c.sampleLevel ?? 1, rate: c.rate, loopStart: c.loopStart, loopEnd: c.loopEnd });
  }
  if (Array.isArray(c.layers)) {
    for (const l of c.layers) if (l?.sample) layers.push(l);
  }

  for (const l of layers) {
    // A LAYER THAT IS NOT LOADED IS SKIPPED, not fatal and not silent-by-
    // accident: sampleBuffer returns null for a voice whose file has not
    // decoded yet (or at all), and a bed that refused to open because one of
    // three layers was missing would be a weapon that lost its sound to a
    // 404. The rest of the bed still plays.
    //
    // NOTE it resolves through pickSample, so a voice holding SEVERAL takes
    // hands back a different one per burst. That is variation on a one-shot
    // and a character change on a bed — a layer voice wants exactly one file.
    const buf = sampleBuffer(l.sample);
    if (!buf) continue;
    const level = Math.max(0, l.level ?? 1);
    if (level <= 0) continue;
    // Looped, and through everything above rather than around it: the ramp,
    // the drive and the sweep are the sound design, and a sample that bypassed
    // them would be a second bed with none of the shape this module exists to
    // give it.
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    // LOOP POINTS IN SECONDS, not frames, so they survive a re-record at a
    // different rate. Left at 0/0 the whole file loops, which is what a bed
    // recorded as a bed wants — and is a click every pass on one that was not.
    const end = Math.max(0, l.loopEnd ?? 0);
    src.loopStart = clamp(l.loopStart ?? 0, 0, buf.duration);
    src.loopEnd = end > src.loopStart ? Math.min(end, buf.duration) : buf.duration;
    src.playbackRate.value = Math.max(0.05, l.rate ?? 1);
    // PER-LAYER GAIN, so the balance between two loops is set here rather than
    // by re-recording one of them quieter.
    const g = ctx.createGain();
    g.gain.value = level;
    src.connect(g).connect(pre);
    src.start(now);
    sources.push(src);
  }

  const synthLevel = Math.max(0, c.synthLevel ?? 1);
  if (synthLevel > 0) {
    // THE STACK. Three saws a few cents apart and a square an octave down.
    //
    // The detune is what makes it a stack rather than a chord: at a few cents
    // the three beat against each other slowly and are heard as ONE thick
    // voice, and past about thirty they separate into a detuned mess. The sub
    // carries the weight — the saws alone are all edge, and the edge is what
    // the drive is about to multiply.
    const note = Math.max(20, c.note ?? 55);
    const detune = c.detune ?? 11;
    const voicesN = clamp(Math.round(c.unison ?? 3), 1, 7);
    for (let i = 0; i < voicesN; i++) {
      const o = ctx.createOscillator();
      o.type = c.wave ?? 'sawtooth';
      o.frequency.value = note;
      // Spread symmetrically around the note: an odd count keeps one voice
      // dead centre, which is what stops the pitch itself drifting as the
      // spread is widened.
      o.detune.value = voicesN === 1 ? 0 : ((i / (voicesN - 1)) * 2 - 1) * detune;
      const g = ctx.createGain();
      // Divided by the voice count so widening the unison does not also make
      // the stack louder, then scaled by `synthLevel` — the layer balance.
      g.gain.value = (1 / voicesN) * synthLevel;
      o.connect(g).connect(pre);
      o.start(now);
      sources.push(o);
    }
    const subLevel = Math.max(0, c.sub ?? 0.7);
    if (subLevel > 0) {
      const sub = ctx.createOscillator();
      sub.type = c.subWave ?? 'square';
      sub.frequency.value = note * 0.5;
      const g = ctx.createGain();
      g.gain.value = subLevel * synthLevel;
      sub.connect(g).connect(pre);
      sub.start(now);
      sources.push(sub);
    }
  }

  voices.set(key, {
    ctx, gain, gate, gateTarget: muted ? 0 : 1, cfg: c,
    sources, lfo, freqs: ladder.freqs, startedAt: now, ramp,
    layers: layers.length, synth: synthLevel > 0,
    driven, peak, from, to, level: 0,
  });
  return true;
}

/**
 * What one open bed is doing. For the harness, and for the panel's readout —
 * a synth you are tuning by ear should still be able to tell you whether the
 * thing you are hearing is the sample or the stack.
 */
export function jetBedState(key) {
  const v = voices.get(key);
  if (!v) return null;
  return {
    ramp: v.ramp,
    startedAt: v.startedAt,
    sources: v.sources.length,
    // HOW MANY OF EACH, because the bed is no longer one or the other. The old
    // boolean `sampled` could not describe two loops over a stack and would
    // have answered `false` for a bed that is mostly sample, which is worse
    // than not answering — it is kept as "is there any sample in this at all"
    // so an existing reader is not silently inverted.
    layers: v.layers,
    synth: v.synth,
    sampled: v.layers > 0,
    muted: v.gateTarget === 0,
    breathing: !!v.lfo,
    // Whether this bed has a shape of its own or is being handed one. A driven
    // bed with nobody calling driveJetBed sits at 0 and is SILENT — which looks
    // exactly like a bed that failed to open, so the panel and the harness both
    // need to be able to tell the two apart.
    driven: !!v.driven,
    level: v.level ?? 0,
  };
}
