import { CONFIG } from '../config.js';
import { ease } from '../ease.js';
import { player, poseBody } from '../entities/player.js';
import { input } from '../input.js';

// THE TITLE SHOT — the seal held up against the lens while the Rive card is on
// screen, turning to follow the cursor.
//
// The idea is that the first thing the game does is put the animal you are
// about to play in your face and let you move it. Nothing here is a menu
// behaviour bolted onto a model: every part of the seal that moves during this
// shot is the SAME system that moves it in a run, pointed at the same cursor —
// the neck and flipper IK (systems/aimRig.js), the mixer's idle clip, the
// breath, the tail spring. What this file adds is only the three things that
// are specific to a title screen:
//
//   1. THE FRAMING. A claim on world.focusCamera each frame, exactly the way
//      the death dive and the boss kill shot claim it, easing in from the
//      run's framing and back out again when the card is dismissed.
//   2. THE BODY. During a run the seal's heading comes from where it is
//      SWIMMING (see the facing block in entities/player.js). On the title
//      screen it isn't swimming, so nothing turns it and the head IK spends
//      the whole shot at the edge of its cone with the cursor behind the
//      animal. Here the heading follows the cursor directly.
//   3. THE COMMITMENT. The aim rig runs `engaged` — full weight, not
//      `idleWeight` — so the flippers actually point rather than keeping most
//      of the swim clip. Nobody is shooting, but the whole shot IS the aim.
//
// "UP CLOSE TO THE CAMERA" IS A ZOOM AND NOTHING ELSE. The game's camera is
// orthographic (world.js), so there is no perspective to push into and moving
// the seal toward the lens on Z would change literally nothing about how big
// it is. The push-in is `camera.zoom`, and the seal stays exactly where the
// run will find it — which is also why this file never writes
// player.mesh.position: resetPlayer would only put it back.
//
// ---------------------------------------------------------------------------
// PROTOTYPE STATUS, and the one thing outside this file that decides whether
// any of it is visible: ui/riveSplash.js paints an opaque background behind
// the artboard, and the artboard is fitted `Contain` on top of it. This system
// is drawn on the game canvas UNDERNEATH both. ui.js now passes the wrapper's
// background from CONFIG.titleSeal.scrim so it can be dialled from solid down
// to a thin tint, but if the splash ARTBOARD itself carries a full-bleed
// background rectangle then no value here can reveal the seal — that is a
// change in the .riv, not in the code.
// ---------------------------------------------------------------------------

// One live shot at a time, and it holds its own clock rather than reading the
// run's: the whole point is that it runs while there is no run.
const shot = {
  // 'off' | 'in' | 'held' | 'out'. `held` is the steady state while the player
  // is typing their name; `out` is the release, which keeps ticking after the
  // run has already started so the frame glides back instead of cutting.
  phase: 'off',
  // Seconds spent in the current phase.
  elapsed: 0,
  // 0..1, how much of the frame the shot owns. Eased from `elapsed`, and held
  // separately because the release has to start from wherever the push-in had
  // got to — dismissing the card half a second in must not jump to 1 first.
  weight: 0,
  // Where `weight` was when the release began. See above.
  releaseFrom: 0,
};

/**
 * `?title` — SHOW THE SHOT WITH NO CARD OVER IT.
 *
 * A prototype affordance, and it exists because of something the probe page
 * found (npm run looks:splash): the `Splash Screen` artboard paints its own
 * full-bleed background, so as things stand the seal is behind an opaque card
 * and nothing in this file can be seen at all. Until that changes in Rive, this
 * is the only way to look at what is being tuned.
 *
 * The dev gate is folded in here rather than left to the caller — it is the
 * same rule DEV_UI uses in main.js (a dev build, or `?tune` on a deployed one),
 * and ui.js has no copy of it. `?title` on the live site does nothing.
 *
 * See showStartMenu in ui/ui.js, which on this path skips mounting the card
 * entirely and starts the run on the first press instead.
 */
export function titlePreviewRequested() {
  try {
    const q = new URLSearchParams(window.location.search);
    if (!q.has('title')) return false;
    return !!import.meta.env?.DEV || q.has('tune');
  } catch {
    // No location at all (the harness).
    return false;
  }
}

/** True while the shot has any claim on the frame at all — including the release. */
export function titleSealActive() {
  return shot.phase !== 'off';
}

/**
 * True only while the card is actually up. This is the aim rig's `engaged`
 * flag, and it is deliberately NOT `titleSealActive()`: the release runs over
 * a run that has already begun, and updatePlayer owns the rig from that point
 * on. See the call site in main.js.
 */
export function titleSealEngaged() {
  return shot.phase === 'in' || shot.phase === 'held';
}

/** The card is up. Called from ui.js's splash mount, via main.js. */
export function beginTitleSeal() {
  if (!CONFIG.titleSeal?.enabled) return;
  shot.phase = 'in';
  shot.elapsed = 0;
  shot.weight = 0;
  shot.releaseFrom = 0;
}

/**
 * The card has been dismissed and the run is starting. Begins the release
 * rather than dropping the claim: a cut from a 2.8x push-in to the run's
 * framing on the frame the player presses Start is the one moment of the game
 * where they are definitely looking at the screen.
 */
export function endTitleSeal() {
  if (shot.phase === 'off' || shot.phase === 'out') return;
  shot.phase = 'out';
  shot.elapsed = 0;
  shot.releaseFrom = shot.weight;
}

/** Drop the shot outright, with no release. Nothing calls it yet; `?sandbox` will. */
export function resetTitleSeal() {
  shot.phase = 'off';
  shot.elapsed = 0;
  shot.weight = 0;
  shot.releaseFrom = 0;
}

/**
 * One call per frame, from animate(), on the REAL delta.
 *
 * Real time and not the gameplay delta because none of this is gameplay: there
 * is no run to dilate, and the release deliberately overlaps the first second
 * of one — a hit-stop from the first kill must not stall the camera easing
 * back out.
 *
 * Does three things in the order they depend on each other: turn the body
 * toward the cursor, then claim the frame around wherever that left the seal.
 * The aim rig is NOT solved here — it runs from its own call in main.js, one
 * step earlier in the frame, so it is solving against the body orientation
 * this call last wrote. That is a frame of lag on the cone gate and it is the
 * same frame of lag the body crane already accepts by design (see the note on
 * `wantCrane` in entities/player.js); every value involved is heavily eased,
 * and the alternative is posing the body twice.
 */
export function updateTitleSeal(dt, world) {
  if (shot.phase === 'off') return;
  // Nothing to frame yet. initPlayer runs well before the card is mounted, so
  // this only fires if boot order ever changes — and a hero shot of a seal that
  // does not exist should be nothing, not a throw inside the frame loop.
  if (!player.mesh) return;
  const cfg = CONFIG.titleSeal ?? {};

  // A mid-shot `enabled: false` from the tuner releases rather than vanishing,
  // so the switch can be flicked while looking at it without the frame cutting.
  if (!cfg.enabled && shot.phase !== 'out') endTitleSeal();

  shot.elapsed += dt;

  if (shot.phase === 'in') {
    const t = Math.min(1, shot.elapsed / Math.max(0.01, cfg.inTime ?? 1.4));
    shot.weight = ease(cfg.inEase ?? 'outCubic', t);
    if (t >= 1) { shot.phase = 'held'; shot.elapsed = 0; }
  } else if (shot.phase === 'held') {
    shot.weight = 1;
  } else {
    const t = Math.min(1, shot.elapsed / Math.max(0.01, cfg.outTime ?? 0.7));
    shot.weight = shot.releaseFrom * (1 - ease(cfg.outEase ?? 'inOutCubic', t));
    if (t >= 1) { resetTitleSeal(); return; }
  }

  // --- the body -------------------------------------------------------------
  // Only while the card is up. Once the release starts, updatePlayer is running
  // again and owns this transform — two writers of player.body.quaternion in
  // the same frame is the last one winning, and it should be the run.
  if (titleSealEngaged()) {
    poseBody(dt, input.aim.x, input.aim.y, {
      // No threshold worth speaking of: `input.aim` is a unit vector that
      // always names a direction (see the comment on it in input.js), unlike
      // the velocity the run turns on, which spends most of a drift near zero.
      minTurn: 0.0001,
      // Slower than the run's `player.turnLerp`. In a run the seal is turning
      // because you asked it to go somewhere and any lag reads as sludge; here
      // it is turning because it noticed you, and the lag IS the performance.
      lerpRate: cfg.turnLerp ?? 2.6,
      // ...and the same reasoning for the half-roll it does when the cursor
      // crosses behind it. Longer than either of the run's two durations.
      turnDuration: cfg.turnAround ?? 0.6,
    });
  }

  // --- the frame ------------------------------------------------------------
  // `zoom` is what "up close" means here (see the note at the top). Eased from
  // 1 rather than from the camera's current zoom: the punch channel multiplies
  // on top of whatever this asks for (see updatePunch in world.js), so reading
  // the live zoom back would compound the shot with itself every frame.
  const zoom = 1 + ((cfg.zoom ?? 2.8) - 1) * shot.weight;

  // `offset` is where the SEAL sits in the frame, in world units from the
  // centre — so the focus point, which is what lands in the middle, is the
  // seal MINUS it. Stated this way round because the number that gets tuned is
  // "leave room for the title above the animal", not "put the camera here".
  //
  // Faded with the weight for the same reason the zoom is: at weight 0 this
  // has to be exactly the framing the run would have chosen, or dismissing the
  // card would end with a sideways slide into place.
  const off = cfg.offset ?? {};
  _focus.x = player.mesh.position.x - (off.x ?? 0) * shot.weight;
  _focus.y = player.mesh.position.y - (off.y ?? 0) * shot.weight;

  // The same three-argument claim the death dive and the kill shot make, and
  // it is consumed and cleared by world.updateCamera later in this frame.
  // Nothing has to remember to release it — a shot that stops claiming simply
  // stops being framed.
  world.focusCamera(_focus, zoom, shot.weight);
}

// Reused rather than allocated: this runs every frame of the title screen and
// focusCamera only reads .x/.y off it.
const _focus = { x: 0, y: 0 };
