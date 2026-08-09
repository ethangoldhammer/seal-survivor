import { CONFIG } from '../config.js';
import { getAudioContext, getSfxBus, isAudioLive, isMuted } from './audio.js';

// The sound a mussel makes WHILE it's in the air.
//
// Everything else in the game is a one-shot: playSfx builds a little graph,
// starts it, and it decays on its own schedule with nothing steering it. That
// model can't describe a shell in flight, because the interesting part isn't
// how it starts — it's how it changes over four seconds of travel. So a mussel
// gets a *voice* instead: a small synth built at launch, rewritten every frame
// from the projectile's own state, and torn down when the shell dies. It fills
// the gap between the launch thump and the impact, which was previously silent
// — a volley left the flippers loudly and then five shells crossed the arena
// making no sound at all.
//
// The graph, per shell:
//
//   noise(loop) -> bandpass -> noiseGain --\
//   saw         -> lowpass  -> toneGain ----+-> voiceGain -> panner -> SFX bus
//   sine (sub)              -> subGain  ---/
//   warbleLfo -> warbleDepth -> (saw.detune, sub.detune)
//
// and what drives each parameter:
//
//   speed      tone pitch, both filter cutoffs, and how much hiss there is —
//              a shell accelerating out of the launch spools audibly up
//   velocity   Doppler, from the component of travel aimed at the player, so
//              a mussel thrown away from you falls in pitch and one curving
//              back toward you rises
//   direction  the pan position (where it is across the screen) and, via the
//              rate of CHANGE of heading, the warble — a shell hunting hard
//              through a turn wobbles, a shell on rails runs clean. This is
//              the seeker being audible, which is the whole character of the
//              weapon
//   lifetime   the attack it fades in over, a slow pitch climb across the
//              whole flight as the fuel burns off, and the burnout fade as it
//              runs out of life
//   distance   plain gain rolloff, so five shells hunting across the arena
//              don't sit louder in the mix than the fight in front of you
//
// All of it is per-frame CONFIG reads, so the tuner drives a mussel that's
// already in the air.

const voices = new Map(); // projectile -> voice record

// One buffer of noise, shared by every voice as a looping source. Generating
// a couple of seconds of random floats per shell would be a real cost on a
// five-shell volley, and there is nothing to gain from each one having its
// own — they start at different times and run through different filters, so
// they don't phase together anyway.
let noiseBuf = null;
function sharedNoise(ctx) {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
  const frames = Math.floor(ctx.sampleRate * 2);
  noiseBuf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

// Which flight-voice preset a projectile uses, by its asset key — same lookup
// the ribbon trails use, so adding a voice to another projectile is a config
// entry and nothing else.
function presetFor(p) {
  const key = p.mesh?.name;
  if (!key) return null;
  const def = CONFIG.flightSfx?.[key];
  return def && def.enabled !== false ? def : null;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Read a [low, high] pair tolerantly — a tuner slider can leave one of these
// as a bare number, and a voice that throws mid-flight would take the whole
// frame's update with it.
function range(pair, fallbackLo, fallbackHi) {
  if (typeof pair === 'number') return [pair, pair];
  if (!Array.isArray(pair)) return [fallbackLo, fallbackHi];
  return [pair[0] ?? fallbackLo, pair[1] ?? fallbackHi];
}

function makeVoice(ctx, bus, p, cfg) {
  const now = ctx.currentTime;

  const voiceGain = ctx.createGain();
  voiceGain.gain.value = 0.0001; // the lifetime envelope opens it on frame one

  const panner = ctx.createStereoPanner();
  voiceGain.connect(panner).connect(bus);

  // The burn: a saw through a lowpass. The saw's harmonics are what make the
  // pitch climb audible at all — a sine sweeping the same range mostly moves
  // energy the small speakers this gets played on can't reproduce.
  const tone = ctx.createOscillator();
  tone.type = cfg.toneWave ?? 'sawtooth';
  const toneFilter = ctx.createBiquadFilter();
  toneFilter.type = 'lowpass';
  toneFilter.Q.value = cfg.toneQ ?? 3;
  const toneGain = ctx.createGain();
  toneGain.gain.value = cfg.toneGain ?? 0.5;
  tone.connect(toneFilter).connect(toneGain).connect(voiceGain);

  // The weight underneath it. Fixed ratio below the tone rather than its own
  // frequency, so the two move together and the voice reads as one object.
  const sub = ctx.createOscillator();
  sub.type = 'sine';
  const subGain = ctx.createGain();
  subGain.gain.value = cfg.subGain ?? 0.35;
  sub.connect(subGain).connect(voiceGain);

  // The water it's travelling through: looping noise through a bandpass that
  // opens with speed.
  const noise = ctx.createBufferSource();
  noise.buffer = sharedNoise(ctx);
  noise.loop = true;
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  noiseFilter.Q.value = cfg.noiseQ ?? 1.2;
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = cfg.noiseGain ?? 0.4;
  noise.connect(noiseFilter).connect(noiseGain).connect(voiceGain);

  // The seeker. Detune rather than frequency so it rides on top of whatever
  // the speed/Doppler terms have set, instead of fighting them for the same
  // AudioParam.
  const warble = ctx.createOscillator();
  warble.type = 'sine';
  const warbleDepth = ctx.createGain();
  warbleDepth.gain.value = 0;
  warble.connect(warbleDepth);
  warbleDepth.connect(tone.detune);
  warbleDepth.connect(sub.detune);

  // A per-shell offset on everything pitched, so a volley is five voices
  // rather than one voice five times as loud. Same reasoning as `pitchVary`
  // on the one-shots, except here it has to persist for the whole flight.
  const detune = (Math.random() * 2 - 1) * (cfg.spreadCents ?? 60);

  tone.start(now);
  sub.start(now);
  noise.start(now, Math.random() * (noise.buffer.duration - 0.05));
  warble.start(now);

  return {
    voiceGain, panner, tone, toneFilter, toneGain, sub, subGain,
    noise, noiseFilter, noiseGain, warble, warbleDepth,
    detune,
    age: 0,
    // Captured rather than read from CONFIG.missile.life, because the voice
    // has to survive that value being dragged in the tuner mid-flight — the
    // lifetime fraction it derives has to stay monotonic or the shell audibly
    // jumps back to full throttle.
    maxLife: Math.max(0.05, p.life),
    heading: Math.atan2(p.dir.y, p.dir.x),
    turn: 0, // smoothed |angular velocity|, rad/s
    dist: null, // previous distance to the listener, for the Doppler term
    releasing: false,
  };
}

// Fade out and stop. The ramp matters: cutting a running oscillator dead
// leaves a step in the output, which is a click on every single impact.
function releaseVoice(ctx, v, cfg) {
  if (v.releasing) return;
  v.releasing = true;
  const now = ctx.currentTime;
  const release = Math.max(0.01, cfg?.release ?? 0.08);
  const g = v.voiceGain.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(Math.max(0.0001, g.value), now);
  g.exponentialRampToValueAtTime(0.0001, now + release);
  const stopAt = now + release + 0.02;
  for (const node of [v.tone, v.sub, v.noise, v.warble]) {
    try { node.stop(stopAt); } catch { /* already stopped */ }
  }
}

/**
 * @param {number} dt        real seconds since the last frame
 * @param {Array} projectileList  the live projectile list
 * @param {{x:number,y:number}} listener  the player — pan and distance are
 *        relative to the seal, not the camera, since the camera lags behind it
 * @param {boolean} active   false while paused, on a menu, or after death
 */
export function updateProjectileVoices(dt, projectileList, listener, active = true) {
  const root = CONFIG.flightSfx;
  // A voice is driven by the shell's motion, so a shell that has stopped
  // moving — the level-up screen, the game-over card — would otherwise hold
  // one frozen note underneath the menu for as long as you left it there.
  if (!active || !root?.enabled || !isAudioLive()) {
    if (voices.size) clearProjectileVoices();
    return;
  }
  const ctx = getAudioContext();
  const bus = getSfxBus();
  if (!ctx || !bus) return;

  const now = ctx.currentTime;
  // Every parameter write glides rather than steps. At 60fps a setValueAtTime
  // per frame per shell is a stairstep the ear hears as zipper noise on
  // exactly the sweeps this system exists to produce.
  const glide = Math.max(0.005, root.smoothing ?? 0.03);
  // Mute silences the voices where they stand instead of stopping them, so
  // un-muting mid-flight picks the shell back up rather than leaving it
  // silent for the rest of its life.
  const masterScale = isMuted() ? 0 : (root.gain ?? 1);

  const live = new Set();

  for (const p of projectileList) {
    const cfg = presetFor(p);
    if (!cfg) continue;

    let v = voices.get(p);
    if (!v) {
      // Cap the choir. A five-shell volley plus whatever is already in the
      // air is a lot of continuous sound competing with the fight, and past
      // a handful the extra voices only add level, not information.
      if (voices.size >= (root.maxVoices ?? 6)) continue;
      v = makeVoice(ctx, bus, p, cfg);
      voices.set(p, v);
    }
    live.add(p);
    v.age += dt;

    // --- what the shell is doing ------------------------------------------
    const speed = p.speed;
    const [speedLo, speedHi] = range(cfg.speedRange, 6, 26);
    const sp = clamp01((speed - speedLo) / Math.max(0.001, speedHi - speedLo));

    // Heading change per second, smoothed. Raw frame-to-frame turn is spiky
    // — homing re-aims in discrete steps and the target can swap outright —
    // and an unsmoothed value makes the warble stutter rather than swell.
    const heading = Math.atan2(p.dir.y, p.dir.x);
    let dh = heading - v.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    v.heading = heading;
    const rawTurn = dt > 0 ? Math.abs(dh) / dt : 0;
    const k = 1 - Math.exp(-dt / Math.max(0.01, cfg.turnSmoothing ?? 0.12));
    v.turn += (rawTurn - v.turn) * k;
    const turn = clamp01(v.turn / Math.max(0.01, cfg.turnRef ?? 4.5));

    const lx = listener?.x ?? 0;
    const ly = listener?.y ?? 0;
    const dx = p.mesh.position.x - lx;
    const dy = p.mesh.position.y - ly;
    const dist = Math.hypot(dx, dy);

    // Doppler from the actual rate of closure, measured rather than derived:
    // taking it from the distance between frames folds in the player's own
    // movement for free, so strafing past a shell in flight shifts it the way
    // moving past a real source would.
    let closing = 0;
    if (v.dist != null && dt > 0) closing = (v.dist - dist) / dt;
    v.dist = dist;
    const doppler = 1 + clamp01(Math.abs(closing) / Math.max(1, cfg.dopplerRef ?? 40))
      * Math.sign(closing) * (cfg.doppler ?? 0.18);

    // Lifetime, 0 at launch and 1 at burnout.
    const t = clamp01(1 - p.life / v.maxLife);

    // --- map it onto the synth --------------------------------------------
    const [toneLo, toneHi] = range(cfg.toneHz, 120, 460);
    const lifeRise = 1 + (cfg.lifeRise ?? 0.25) * t;
    const toneHz = Math.max(20, lerp(toneLo, toneHi, sp) * lifeRise * doppler);
    v.tone.frequency.setTargetAtTime(toneHz, now, glide);
    v.sub.frequency.setTargetAtTime(Math.max(20, toneHz * (cfg.subRatio ?? 0.5)), now, glide);
    v.tone.detune.setTargetAtTime(v.detune, now, glide);
    v.sub.detune.setTargetAtTime(v.detune, now, glide);

    const [tfLo, tfHi] = range(cfg.toneFilterHz, 500, 3200);
    v.toneFilter.frequency.setTargetAtTime(Math.max(60, lerp(tfLo, tfHi, sp)), now, glide);

    const [nfLo, nfHi] = range(cfg.noiseHz, 400, 2400);
    v.noiseFilter.frequency.setTargetAtTime(Math.max(60, lerp(nfLo, nfHi, sp) * doppler), now, glide);
    // Hiss tracks speed on its own, on top of the filter opening — a fast
    // shell is both brighter and wetter, which is what sells it as moving
    // through water rather than just being a rising tone.
    v.noiseGain.gain.setTargetAtTime(
      (cfg.noiseGain ?? 0.4) * lerp(cfg.noiseAtRest ?? 0.35, 1, sp), now, glide,
    );

    // The seeker: both the rate and the depth of the wobble come from how
    // hard it's turning, so a locked-on shell running straight is nearly
    // clean and one carving after a target is unmistakable.
    const [wLo, wHi] = range(cfg.warbleHz, 3, 17);
    const [dLo, dHi] = range(cfg.warbleCents, 0, 90);
    v.warble.frequency.setTargetAtTime(lerp(wLo, wHi, turn), now, glide);
    v.warbleDepth.gain.setTargetAtTime(lerp(dLo, dHi, turn), now, glide);

    // Pan by where it is across the screen, relative to the seal.
    const pan = Math.max(-1, Math.min(1, dx / Math.max(1, cfg.panWidth ?? 18)));
    v.panner.pan.setTargetAtTime(pan * (cfg.panAmount ?? 0.8), now, glide);

    // Level: fade in over `attack`, roll off with distance, and burn out over
    // the last `lifeFade` seconds so a shell that times out dies away instead
    // of being cut off mid-note.
    const attack = clamp01(v.age / Math.max(0.001, cfg.attack ?? 0.12));
    const burnout = clamp01(p.life / Math.max(0.001, cfg.lifeFade ?? 0.5));
    const rolloff = 1 / (1 + dist / Math.max(0.5, cfg.falloff ?? 14));
    const level = (cfg.gain ?? 0.12) * masterScale * attack * burnout * rolloff;
    v.voiceGain.gain.setTargetAtTime(Math.max(0.0001, level), now, glide);
  }

  // Anything whose shell is gone — hit something, timed out, left the arena.
  for (const [p, v] of voices) {
    if (live.has(p)) continue;
    releaseVoice(ctx, v, presetFor(p) ?? CONFIG.flightSfx?.missile);
    voices.delete(p);
  }
}

export function clearProjectileVoices() {
  if (!voices.size) return;
  const ctx = getAudioContext();
  for (const [p, v] of voices) {
    if (ctx) releaseVoice(ctx, v, presetFor(p) ?? CONFIG.flightSfx?.missile);
  }
  voices.clear();
}

// Shown in the tuner's meta line alongside the particle count, so "why is the
// mix suddenly busy" has an answer you can see.
export function flightVoiceCount() {
  return voices.size;
}
