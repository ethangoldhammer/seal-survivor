import { CONFIG } from '../config.js';
import { setSfxRateScale } from './audio.js';
import { setMusicRateScale } from './music.js';

// A level doesn't stop the game, it slows it down.
//
// The cards used to appear on the frame the XP bar filled, which meant the
// last thing you saw of the fight was a screenshot of it. This module puts a
// beat in between: the ocean leans into slow motion, settles at half speed,
// and only then do the cards dither in over the top of it.
//
// Three things move here, and everything else is main.js's job:
//
//   1. THE CLOCK. update() returns the time scale for the WHOLE frame, exactly
//      like systems/deathDive.js — main.js folds it into the delta every
//      system reads, so the water, the particles, the mixers and the camera
//      all ease down together. Dilating some of them would read as a stutter
//      rather than as a held moment.
//   2. THE SOUND. The playback rates follow the dilation part of the way down
//      (see CONFIG.levelUp.audio.follow), so the mix sags with the picture.
//      This is separate from the filter duck the upgrade screen already does
//      — that's music.js's duckForUpgrade, and the two stack.
//   3. WHEN THE CARDS ARRIVE. `onReady` fires at the bottom of the ramp, not
//      at the top of it, so the menu never covers the moment it's reacting to.
//
// The FREEZE is not here. Bodies stop because main.js pauses the run on the
// same frame this starts (gameState.paused), which skips every steering,
// combat and spawning pass; the mixers keep ticking on the dilated clock, so
// creatures go on breathing where they stand. Nothing in this file touches an
// entity.
//
// Coming back out is one ramp the other way, and gameplay is live for all of
// it: the pick re-engages the run immediately and the world accelerates back
// to full speed underneath it, rather than snapping.

export const levelUpState = {
  active: false,
  // 'dilate' on the way down (and through the beat at the bottom before the
  // cards), 'hold' while the menu is up, 'restore' on the way back to normal.
  phase: 'none',
  timeScale: 1,
  // Wall-clock seconds into the current phase. Published for anything that
  // wants to stage itself against the ramp; nothing reads it back in here.
  elapsed: 0,
};

let clock = 0; // wall-clock into the current phase
// The scale a ramp started from, captured rather than assumed — a second card
// in the same batch, or a pick taken mid-ramp, starts from wherever the
// sequence actually was.
let fromScale = 1;
let onReady = null;
let onRestored = null;

function cfg() {
  return CONFIG.levelUp ?? {};
}

function smoothstep(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function holdScale() {
  return Math.max(0.02, Math.min(1, cfg().hold ?? 0.5));
}

// Same shape as the death dive's: `follow` is how much of the dilation the
// sound takes (1 = it slows exactly as far as the picture does) and `minRate`
// is the floor. Deliberately gentler than death by default — the upgrade loop
// still has to sound like music, not like a tape stop.
function setAudioRate(scale) {
  const c = cfg();
  if (c.audio?.enabled === false) return;
  const follow = c.audio?.follow ?? 0.5;
  const rate = Math.max(c.audio?.minRate ?? 0.5, 1 + (scale - 1) * follow);
  setMusicRateScale(rate, c.audio?.glide ?? 0.2);
  setSfxRateScale(rate);
}

function apply(scale) {
  levelUpState.timeScale = scale;
  setAudioRate(scale);
  return scale;
}

/**
 * Begin the ramp down. The run should be paused on the same frame — see the
 * note above about where the freeze actually comes from.
 *
 * @param ready called once, at the bottom of the ramp. This is what puts the
 *              cards up.
 * @returns true if a ramp was started. False means the dilation is switched
 *          off — `ready` has already been called and the caller has nothing
 *          to wait for.
 */
export function startLevelUpTime(ready) {
  if (cfg().enabled === false) {
    ready?.();
    return false;
  }
  levelUpState.active = true;
  levelUpState.phase = 'dilate';
  levelUpState.elapsed = 0;
  clock = 0;
  fromScale = levelUpState.timeScale;
  onReady = ready ?? null;
  return true;
}

/**
 * @param rawDt UNSCALED seconds. Like the death dive, this runs on the wall
 *              clock because it's what decides the clock everything else runs
 *              on — a ramp measured in its own dilated time would take longer
 *              the further it got.
 * @returns the time scale for the rest of the frame. 1 when no level is open.
 */
export function updateLevelUpTime(rawDt) {
  if (!levelUpState.active) return 1;
  const c = cfg();
  clock += rawDt;
  levelUpState.elapsed = clock;
  const hold = holdScale();

  if (levelUpState.phase === 'dilate') {
    const dilate = Math.max(0.01, c.dilateTime ?? 0.45);
    const scale = apply(fromScale + (hold - fromScale) * smoothstep(clock / dilate));
    // `menuDelay` is a beat at the BOTTOM of the ramp, held at `hold` by the
    // clamp in smoothstep: the slow motion wants a moment to be read as slow
    // motion before the interface lands on top of it.
    if (clock >= dilate + (c.menuDelay ?? 0)) {
      levelUpState.phase = 'hold';
      const ready = onReady;
      onReady = null;
      ready?.();
    }
    return scale;
  }

  if (levelUpState.phase === 'hold') return apply(hold);

  // Restoring. Gameplay is already live again by now — this is only the world
  // catching back up to full speed.
  const t = smoothstep(clock / Math.max(0.01, c.restoreTime ?? 0.5));
  const scale = apply(fromScale + (1 - fromScale) * t);
  if (t >= 1) {
    const done = onRestored;
    onRestored = null;
    // Cleared BEFORE the callback for the same reason the death dive does it:
    // whatever runs next is entitled to set up its own state without this
    // landing on top of it afterwards.
    resetLevelUpTime();
    done?.();
    return 1;
  }
  return scale;
}

/**
 * Start the ramp back to normal speed, from wherever the sequence is now.
 *
 * @param done called once the world is back at full speed. Optional — the run
 *             itself is re-engaged by the caller on the frame the pick lands,
 *             not here.
 * @returns false if there was nothing dilated to come back from (`done` has
 *          already been called).
 */
export function endLevelUpTime(done) {
  if (!levelUpState.active) {
    done?.();
    return false;
  }
  levelUpState.phase = 'restore';
  clock = 0;
  fromScale = levelUpState.timeScale;
  onRestored = done ?? null;
  return true;
}

// Back to a live clock and a live mix. Called from startGame, so a run begun
// while a level-up was somehow still open doesn't inherit its dilation.
export function resetLevelUpTime() {
  levelUpState.active = false;
  levelUpState.phase = 'none';
  levelUpState.timeScale = 1;
  levelUpState.elapsed = 0;
  clock = 0;
  fromScale = 1;
  onReady = null;
  onRestored = null;
  setMusicRateScale(1, 0);
  setSfxRateScale(1);
}
