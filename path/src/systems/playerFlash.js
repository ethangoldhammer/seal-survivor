import { CONFIG } from '../config.js';
import { ease } from '../ease.js';
import { attachDamageGlow } from './damageGlow.js';

// ---------------------------------------------------------------------------
// FLASHING THE SEAL'S OWN BODY.
//
// The game already had two places to say "that hit you": the rim
// (flashPlayerOutlineDamage) and the eyes (flashEyeLightsDamage). Both are
// around the animal rather than on it — the rim is a silhouette and the eyes
// are two pixels — so a hit that lands while the camera is wide has nothing on
// the seal itself. This is the third: the body goes hot for a fifth of a second.
//
// WHY IT IS A MODULE AND NOT FOUR LINES IN THE CALLER. Writing a seal's
// material is the single most-trapped thing in this codebase:
//
//   - the seal's GLB material is SHARED with every other body using that model,
//     including the escort pod and the menu bust, so writing it directly lights
//     all of them ([[primitive-assets-share-one-material]] in the notes, and the
//     same bug has shipped twice);
//   - a plain Material.clone() silently drops the injected onBeforeCompile the
//     seal's skin depends on;
//   - the visual root is REPLACED on a body swap, so a handle captured once is
//     a handle onto a seal nobody is playing.
//
// attachDamageGlow solves all three and is the game's one answer to "make this
// body brighter" — see the note beside `killLightHero` in CONFIG.damageGlow.
// This file is the envelope over it and the registration that survives a swap.
//
// ONE OTHER SYSTEM WRITES THE SAME LAYER: systems/bossLight.js lifts the seal
// while a boss-kill light is up. That is a couple of seconds after a boss dies,
// which is not a window in which the player is being hit by anything — and if
// the two ever do overlap, the kill light wins, because it runs later in the
// frame. Named here rather than defended against, because a priority fight
// between two things that cannot co-occur is machinery for nothing.
// ---------------------------------------------------------------------------

function cfg() {
  return CONFIG.fx?.playerFlash ?? {};
}

// The visual root this is currently attached to, and the handle onto its
// per-instance materials. Both replaced together when the body changes.
let root = null;
let glow = null;
// Seconds of flash left, and how hard this one started. Held rather than
// recomputed so a second hit inside the window RAISES the flash instead of
// restarting a weaker one — being zapped twice should not look dimmer than
// being zapped once.
let left = 0;
let span = 0;
let peak = 0;
// The `source` row in CONFIG.damageGlow.sources the current flash is wearing,
// so a shock can be yellow and a bite white without either inventing a colour.
let source = null;

/**
 * Point the flash at the seal that is being played. Safe to call every frame —
 * it only does work when the root has actually changed, which is a body swap or
 * the first frame of a run.
 */
export function setPlayerFlashTarget(next) {
  if (next === root) return;
  // The old body hands its materials back to cold first. Without this a seal
  // swapped out mid-flash keeps the heat for as long as it exists, and on the
  // menu bust that is forever.
  glow?.release();
  root = next ?? null;
  glow = root ? attachDamageGlow(root) : null;
  left = 0;
  span = 0;
}

export function resetPlayerFlash() {
  glow?.release();
  left = 0;
  span = 0;
  peak = 0;
  source = null;
}

/**
 * The seal was hit. Light it up.
 *
 * @param strength 0..1 how hard, scaled by the row's own `peak`.
 * @param src      a row in CONFIG.damageGlow.sources; the colour comes from it.
 */
export function flashPlayer(strength = 1, src = 'playerZap') {
  if (cfg().enabled === false || !glow) return;
  const power = Math.max(0, Math.min(1, strength));
  if (power <= 0) return;
  const secs = Math.max(0.01, cfg().seconds ?? 0.18);
  // RAISED, not restarted. A weaker hit arriving inside a stronger one's tail
  // would otherwise dim the flash on the frame the second hit lands, which
  // reads as the second hit being the thing that stopped it.
  //
  // The remaining time is raised too, so the pair reads as one longer flash
  // rather than the first one being cut off — but the PEAK is what decides
  // which source's colour is worn, so a small tick inside a big flash cannot
  // repaint it.
  if (power >= peak || left <= 0) {
    peak = power;
    source = src;
  }
  left = Math.max(left, secs);
  span = Math.max(span, secs);
}

/**
 * Run the envelope down. REAL seconds — a flash fired by a hit that also caused
 * a hit-stop must not be frozen by the freeze it caused, exactly as
 * updatePlayerDamageFx is.
 */
export function updatePlayerFlash(realDt) {
  if (!glow) return;
  if (left <= 0) return;
  left = Math.max(0, left - realDt);
  // 1 at the moment of the hit, 0 at the end. `curve` shapes the fall; the
  // default snaps off fast, which is what a flash is — a slow one is a glow.
  const t = span > 0 ? left / span : 0;
  const level = peak * ease(cfg().curve ?? 'inCubic', t);
  glow.set(level, source);
  if (left <= 0) {
    peak = 0;
    source = null;
  }
}

/** For the harness: what the body is wearing right now. */
export function playerFlashLevel() {
  if (!glow || left <= 0 || span <= 0) return 0;
  return peak * ease(cfg().curve ?? 'inCubic', left / span);
}

/** For the harness: whether a body is attached at all. */
export function playerFlashAttached() {
  return !!glow;
}
