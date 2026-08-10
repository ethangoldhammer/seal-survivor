import { CONFIG } from '../config.js';
import { emit } from '../entities/particles.js';
import { playSfx, vibrate, noteSfx } from './audio.js';
import { playHaptic } from './haptics.js';

// Every juicy thing in the game goes through here. One call site per event, and
// what that event does — particles, shake, hit-stop, grid ripple, sound, buzz —
// is entirely described by CONFIG.feedback, so tuning feel never means hunting
// through gameplay code.

export const feedbackState = {
  shake: 0,
  // A separate, NON-decaying shake channel for things that tremble for as long
  // as they last rather than jolting once — currently the strike wind-up. It
  // has to be its own channel: the impulse `shake` above decays every frame by
  // design, so a continuous effect written into it would either fade out while
  // still happening or, if topped up per frame, race the decay and land
  // somewhere framerate-dependent. Whoever is sustaining it re-asserts it each
  // frame and updateFeedback clears it, so it is exactly as loud as the
  // loudest live claim and vanishes the moment nothing is claiming it.
  sustainShake: 0,
  hitstop: 0,
  glowPulse: 0,
};

/**
 * Claim the sustained shake channel for THIS frame. Highest claim wins; call
 * it every frame for as long as the effect lasts.
 */
export function addSustainedShake(amount) {
  if (!(amount > 0)) return;
  feedbackState.sustainShake = Math.min(CONFIG.fx.maxShake, Math.max(feedbackState.sustainShake, amount));
}

let grid = null;
let hitstopCooldown = 0;

// event name -> seconds left before that event's SOUND may play again.
//
// An event's `sfxMinGap` throttles its sound and nothing else — the particles,
// shake, glow and ripple still fire on every single call. That split is the
// whole point: twelve pellets landing across a school should still throw
// twelve bursts of sparks, because sparks in twelve places read as twelve
// hits. Twelve copies of one impact sound inside the same frame don't read as
// anything; they just sum into a loud smear, and the sound gets thicker every
// time you take Multishot. Same reasoning as hitstopCooldown below — a rate
// limit on the one channel that can't take the pile-up.
const sfxGaps = new Map();

export function initFeedback(gridSystem) {
  grid = gridSystem;
  feedbackState.shake = 0;
  feedbackState.sustainShake = 0;
  feedbackState.hitstop = 0;
  feedbackState.glowPulse = 0;
  hitstopCooldown = 0;
  sfxGaps.clear();
}

/**
 * @param {string} event key in CONFIG.feedback
 * @param {object} at    { x, y, dirX, dirY, vx, vy, scale, color }
 */
export function feedback(event, at = {}) {
  const def = CONFIG.feedback[event];
  if (!def) {
    console.warn(`[feedback] unknown event "${event}"`);
    return;
  }

  const scale = at.scale ?? 1;
  const x = at.x ?? 0;
  const y = at.y ?? 0;

  if (def.emit) emit(def.emit, x, y, at);

  if (def.ripple && grid) {
    grid.ripple(x, y, def.ripple.strength * scale, def.ripple.radius);
  }

  if (def.shake) {
    // Clamped, or a busy fight pins the camera at maximum rattle forever.
    feedbackState.shake = Math.min(CONFIG.fx.maxShake, feedbackState.shake + def.shake * scale);
  }

  if (def.glow) {
    // Same clamp reasoning as shake — otherwise a busy fight pins the glow
    // at maximum and it stops reading as "pulsing" at all.
    feedbackState.glowPulse = Math.min(3, feedbackState.glowPulse + def.glow * scale);
  }

  // Hit-stop only lands if it has had time to breathe. Without this every
  // bullet impact chains one, and the game runs in permanent slow motion.
  if (def.hitstop && hitstopCooldown <= 0) {
    feedbackState.hitstop = Math.max(feedbackState.hitstop, def.hitstop);
    hitstopCooldown = CONFIG.fx.hitstopCooldown;
  }
  // opts.sfxOpts lets a caller shape the sound for this specific instance
  // (e.g. kills pitch down and ring longer for bigger enemies) without
  // needing a separate sound entry per creature.
  //
  // `sfxMinGap` collapses a burst of the same event into one sound. The first
  // call through plays immediately — the throttle never delays a hit, it only
  // drops the copies piling up behind it — and the loudest scale seen during
  // the window wins, so the one sound that does play is the one the biggest
  // hit in the burst would have made.
  if (def.sfx) {
    const gap = def.sfxMinGap ?? 0;
    if (gap > 0) {
      const pending = sfxGaps.get(event);
      if (pending) {
        pending.scale = Math.max(pending.scale, scale);
        // Swallowed by the throttle. Reported rather than dropped in silence,
        // because "I can only hear one of these" and "only one of these is
        // firing" are different bugs with the same symptom, and this is the
        // only place they can be told apart.
        noteSfx(def.sfx, 'gap', { text: event });
      } else {
        // Jittered rather than exact. A fixed gap turns a sustained burst into
        // a perfectly periodic click train, and a periodic train of identical
        // clicks is heard as a PITCH — which is exactly the "static" a hit
        // sound develops when it fires twenty times a second. Breaking the
        // phase lock costs nothing and turns the same density back into
        // texture. See CONFIG.audio.sfxGapJitter.
        const jitter = CONFIG.audio?.sfxGapJitter ?? 0;
        const wobble = jitter ? 1 + (Math.random() * 2 - 1) * Math.min(0.9, jitter) : 1;
        sfxGaps.set(event, { left: gap * wobble, scale });
        playSfx(def.sfx, Math.min(1.6, scale), at.sfxOpts);
      }
    } else {
      playSfx(def.sfx, Math.min(1.6, scale), at.sfxOpts);
    }
  }
  if (def.haptic) {
    // Controller rumble and phone buzz are different hardware reached through
    // different APIs — send the same authored pattern to both, and whichever
    // the player actually has responds.
    playHaptic(def.haptic, Math.min(1.6, scale));
    vibrate(def.haptic);
  }
}

/**
 * Advances shake and hit-stop on real (unscaled) time.
 * Returns the time scale gameplay should run at this frame.
 */
export function updateFeedback(realDt) {
  if (hitstopCooldown > 0) hitstopCooldown -= realDt;

  // Run down the per-event sound throttles. Deleting the entry is what re-arms
  // the event, so an idle one costs nothing until it next fires.
  for (const [event, gap] of sfxGaps) {
    gap.left -= realDt;
    if (gap.left <= 0) sfxGaps.delete(event);
  }
  feedbackState.shake *= Math.pow(CONFIG.fx.shakeDecay, realDt);
  if (feedbackState.shake < 0.001) feedbackState.shake = 0;

  // Cleared rather than decayed — see the note on the field. Anything still
  // trembling re-asserts it before the camera reads it next frame.
  feedbackState.sustainShake = 0;

  feedbackState.glowPulse *= Math.exp(-CONFIG.bloom.pulseDecay * realDt);
  if (feedbackState.glowPulse < 0.001) feedbackState.glowPulse = 0;

  if (feedbackState.hitstop > 0) {
    feedbackState.hitstop = Math.max(0, feedbackState.hitstop - realDt);
    return CONFIG.fx.hitstopScale;
  }
  return 1;
}
