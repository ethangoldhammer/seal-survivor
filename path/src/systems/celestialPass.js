import { CONFIG } from '../config.js';
import { celestialFrame, flareCelestial, clearCelestialFlares } from './celestial.js';

// ============================================================================
// FLYING THROUGH THE SUN.
//
// A trigger zone inside each celestial body, and the state machine that decides
// when the seal has been through one. That is all this file does — what a pass
// is WORTH is main.js's business, because the payout reaches into the strike
// meter, the element and the chum in the water, and a sky system that imported
// those three would wire half the game into the backdrop.
//
// WHERE THE ZONE IS. `celestialFrame`, which systems/celestial.js publishes
// after the drift and the frame fit — the DRAWN position, not the orbit's. The
// two differ by a few units and they differ by MORE the further the camera has
// panned, so a zone measured off dayState would be a hitbox that misses the
// thing on screen by exactly as much as the sky is meant to feel far away.
//
// WHY IT IS A STATE MACHINE rather than a distance test. Three separate things
// have to be true for a pass to read as an event:
//
//   ENTRY, not presence. A seal parked inside the sun at the top of a jump is
//     inside it for thirty frames; that is one pass, not thirty.
//   HYSTERESIS. It then has to get properly back out before the zone re-arms,
//     or an apex that hovers on the boundary strobes the whole thing.
//   COOLDOWN. And then it has to wait. This is the one that makes a pass an
//     event instead of a rotation — the sky has moved by the time it re-arms,
//     so the second one is a different jump rather than the same one repeated.
//
// The cooldown runs on REAL time, like the flare it drives: freezing the game
// for a hit-stop should not extend how long the sun stays dark.
// ============================================================================

export const passState = {
  sun: { inside: false, cooldown: 0, passes: 0 },
  moon: { inside: false, cooldown: 0, passes: 0 },
};

/** Back to a cold sky: nothing armed, nothing lit. Called on a run reset. */
export function resetCelestialPass() {
  for (const s of Object.values(passState)) {
    s.inside = false;
    s.cooldown = 0;
    s.passes = 0;
  }
  // The flare envelopes belong to the rig, but they are only ever raised from
  // here, so this is the one place that can honestly promise a reset clears
  // them. A run restarted mid-flare would otherwise open on a flickering sun.
  clearCelestialFlares();
}

/**
 * @param dt    REAL seconds — see the note on the cooldown above.
 * @param at    the seal: { x, y, speed }. `speed` only scales how big the event
 *              reads; a stationary pass still counts.
 * @param hooks { onPass(which, { x, y, scale, zone }) } — fired once, on entry.
 */
export function updateCelestialPass(dt, at, hooks = {}) {
  const cfg = CONFIG.dayNight?.pass;
  const live = !!cfg?.enabled && !!CONFIG.dayNight?.enabled;

  for (const which of ['sun', 'moon']) {
    const state = passState[which];
    if (state.cooldown > 0) state.cooldown = Math.max(0, state.cooldown - dt);

    const zone = celestialFrame[which];
    // A body under the water line is drawn by nothing and covered by the fill,
    // so there is no light to fly through — and the seal swims through that
    // patch of sea constantly. Disarmed rather than merely out of range, so
    // surfacing back into a risen sun counts as a fresh entry.
    if (!live || !zone.visible || !(zone.trigger > 0)) {
      state.inside = false;
      continue;
    }

    const dx = at.x - zone.x;
    const dy = at.y - zone.y;
    const dist = Math.hypot(dx, dy);

    if (state.inside) {
      // Leaving. Measured against the WIDER radius, which is the whole job of
      // the hysteresis — an exit at exactly the entry radius re-arms on the
      // same frame's worth of jitter that fired it.
      if (dist > zone.trigger * Math.max(1, cfg.hysteresis ?? 1.35)) state.inside = false;
      continue;
    }

    if (dist > zone.trigger) continue;
    state.inside = true;
    // Inside, but still cooling down: the entry is recorded (so the seal has to
    // leave and come back rather than being credited the moment the timer runs
    // out while it is sitting in there) and nothing fires.
    if (state.cooldown > 0) continue;

    state.cooldown = Math.max(0, cfg.cooldown ?? 0);
    state.passes += 1;

    // How big it reads. Speed rather than how central the crossing was: entry
    // is by definition at the rim, so "how deep" is 0 on every pass and would
    // be a scale that never varied. Speed is also the thing the player is
    // actually spending — a dash through the middle of the sun is a stunt, and
    // drifting into it at the top of a lazy arc is not.
    const ss = cfg.speedScale ?? {};
    const scale = Math.min(
      ss.max ?? 1.6,
      (ss.base ?? 0.75) + (at.speed ?? 0) / Math.max(1, ss.per ?? 34),
    );

    flareCelestial(which, (cfg[which]?.flare ?? 1) * scale);
    hooks.onPass?.(which, { x: at.x, y: at.y, scale, zone });
  }
}
