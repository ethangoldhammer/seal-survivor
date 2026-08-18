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
//
// THE SALUTE is a fourth thing, bolted onto the beat at the bottom: the beat
// is LENGTHENED (CONFIG.levelUp.salute.beat), the frame snaps in on the seal,
// and the seal throws both flippers up. This module owns the first two of
// those; the pose is systems/celebrate.js, fired by main.js on the same frame
// this starts, because a module that decides how fast the water moves has no
// business importing an IK solver.
//
// The camera here works exactly like the death dive's and the kill shot's: two
// numbers published on the state (`camZoom`, `camWeight`) and claimed per
// frame by main.js through world.focusCamera. It is NOT the dilated clock —
// the whole point of a snap zoom is that it lands in three or four frames of
// WALL time, and running it on a clock that is itself easing to half speed
// would smear it into the very slow push it is meant to be the opposite of.

export const levelUpState = {
  active: false,
  // 'dilate' on the way down (and through the beat at the bottom before the
  // cards), 'hold' while the menu is up, 'restore' on the way back to normal.
  phase: 'none',
  timeScale: 1,
  // Wall-clock seconds into the current phase. Published for anything that
  // wants to stage itself against the ramp; nothing reads it back in here.
  elapsed: 0,
  // THE SALUTE'S FRAME, on the same terms as bossKillState's and
  // deathState's: `camZoom` is the push-in and `camWeight` is how much of the
  // framing it owns, both consumed by main.js via world.focusCamera and both
  // back at 1/0 whenever nothing is claiming.
  camZoom: 1,
  camWeight: 0,
};

let clock = 0; // wall-clock into the current phase
// Wall-clock since the LEVEL, across every phase. The camera envelope is a
// pure function of this, which is what lets it survive the phase changes
// underneath it: `clock` restarts at each one (and again on the pick), and a
// push driven off that would jump back to full strength the moment the player
// chose a card.
let saluteClock = 0;
let saluting = false;
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

function saluteCfg() {
  return cfg().salute ?? {};
}

export function saluteEnabled() {
  return saluteCfg().enabled !== false;
}

/**
 * The extra beat the salute buys, in wall seconds — nothing at all when it is
 * switched off, so the cards arrive exactly when they always did.
 */
export function saluteBeat() {
  return saluteEnabled() ? Math.max(0, saluteCfg().beat ?? 0.5) : 0;
}

/**
 * WHEN THE CARDS ARRIVE, in wall seconds after the level. The one derivation
 * of this number: systems/celebrate.js is handed a peak timed against it (see
 * main.js) and the camera below releases on it, so retuning any of the three
 * parts moves all of them together instead of leaving the seal saluting into a
 * menu that already covered it.
 */
export function cardsArriveAt() {
  const c = cfg();
  return Math.max(0.01, c.dilateTime ?? 0.45) + (c.menuDelay ?? 0) + saluteBeat();
}

/**
 * The push-in, 0..1, as a pure function of wall time since the level.
 *
 * IN fast, HOLD through the beat, OUT under the cards. The attack is the whole
 * effect — at the default 0.06 it is three or four frames, which is a cut with
 * just enough travel in it to read as a lens rather than as a dropped frame.
 * Anything above about a fifth of a second stops being a snap and becomes the
 * slow push the death dive already does.
 *
 * The release starts ON the cards rather than before them, so the frame is
 * still tight on the seal as they begin to dither in and opens out underneath
 * them — the shot hands over to the menu instead of ending and then being
 * replaced.
 */
function saluteEnvelope(t) {
  const s = saluteCfg();
  const punchIn = Math.max(0.001, s.punchIn ?? 0.06);
  const release = Math.max(0.001, s.release ?? 0.4);
  const inT = smoothstep(t / punchIn);
  const outT = 1 - smoothstep((t - cardsArriveAt()) / release);
  return Math.max(0, Math.min(inT, outT));
}

function applySalute() {
  if (!saluting) {
    levelUpState.camZoom = 1;
    levelUpState.camWeight = 0;
    return;
  }
  const s = saluteCfg();
  const env = saluteEnvelope(saluteClock);
  levelUpState.camZoom = 1 + ((s.zoom ?? 1.85) - 1) * env;
  levelUpState.camWeight = (s.weight ?? 1) * env;
  // Stop claiming the frame once the push has fully let go, rather than
  // claiming a weight of 0 for as long as the player takes to read three
  // cards. A live claim at zero weight is very nearly a no-op — but only very
  // nearly: world.focusCamera's zoom is applied whatever the weight, so a
  // claim left standing pins the cinematic rig's own zoom out of the frame
  // (see the handover in world.js updateCamera) for the whole menu.
  if (env <= 0 && saluteClock > cardsArriveAt()) saluting = false;
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
  saluteClock = 0;
  saluting = saluteEnabled();
  applySalute();
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
  saluteClock += rawDt;
  levelUpState.elapsed = clock;
  applySalute();
  const hold = holdScale();

  if (levelUpState.phase === 'dilate') {
    const dilate = Math.max(0.01, c.dilateTime ?? 0.45);
    const scale = apply(fromScale + (hold - fromScale) * smoothstep(clock / dilate));
    // `menuDelay` is a beat at the BOTTOM of the ramp, held at `hold` by the
    // clamp in smoothstep: the slow motion wants a moment to be read as slow
    // motion before the interface lands on top of it. The salute's own beat is
    // added to it — that is the half second the seal is given to react in, and
    // cardsArriveAt() is where the sum lives so the pose and the camera can be
    // timed against the same number.
    if (clock >= cardsArriveAt()) {
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
  levelUpState.camZoom = 1;
  levelUpState.camWeight = 0;
  clock = 0;
  saluteClock = 0;
  saluting = false;
  fromScale = 1;
  onReady = null;
  onRestored = null;
  setMusicRateScale(1, 0);
  setSfxRateScale(1);
}
