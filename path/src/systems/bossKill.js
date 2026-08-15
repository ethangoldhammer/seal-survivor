import { CONFIG } from '../config.js';
import { setSfxRateScale } from './audio.js';
import { setMusicRateScale, hushMusic, releaseMusicHush } from './music.js';

// THE KILL SHOT — the two seconds after a boss dies.
//
// A boss used to end the way a mackerel does: the body is removed, the health
// bar disappears, and the next fish arrives. The biggest thing the run can
// produce had no punctuation at all — you found out you had won by noticing
// the bar was gone.
//
// So the ocean drops into slow motion the instant the last hit lands, the
// frame pushes in hard on the seal in whatever pose it happened to be in, the
// score cuts out from under both, and then all three let go together and the
// water comes back.
//
// THE SHAPE IS DOWN FAST, HOLD, UP FAST. The drop is almost a cut — it is the
// impact. The beat in the middle is the only part that is allowed to be long,
// because it is the only part the player is meant to LOOK at: the boss is
// coming apart into a few hundred chunks (systems/bossGibs.js) that hang in
// the dilated water while the frame holds on the seal, and a beat that ends
// before the wreckage has spread is a photograph of an explosion starting. The
// return is then deliberately quicker than the beat, so the moment ends
// decisively instead of sagging back into play — the water is already
// refilling by the time the frame opens out (see bossCycleRelief).
//
// It is still SHORT in the sense that matters: a run that reaches level 40
// sees eight of these, and the eighth has to be worth watching.
//
// THE SILENCE IS THE OTHER HALF OF IT. The music is cut on the same frame and
// the last moment of it is thrown into a long reverb that rings out across the
// whole beat, with nothing else playing under it — see hushMusic in
// systems/music.js. Cutting the score is what turns a slow-motion frame into a
// held one; the tail is what stops the cut sounding like the audio dropped
// out.
//
// THE POSE IS NOT FROZEN, and this is why there is no code here that touches
// the player. The mixers run on the dilated clock like everything else (see
// main.js, which folds this module's scale into the delta every system reads),
// so at `hold` the seal is moving at a tenth of its speed — near enough still
// to read as a snapshot, but with the tail and the fins still drifting through
// the pose rather than stopping dead in it. A real freeze reads as a dropped
// frame; this reads as a camera.
//
// It is modelled on systems/levelUpTime.js and shares its shape on purpose —
// the ramp down, the beat at the bottom, the ramp back — because the two are
// the same idea at different lengths and a player should not be able to tell
// they are different code. What it does NOT share is the pause: gameplay stays
// live for all of it. There is nothing left in the water to be killed by (the
// boss emptied it on arrival, and the wave clock is holding the next one back
// — see bossCycleRelief), and a pause here would be a second interruption
// stacked on the fight that just ended.

export const bossKillState = {
  active: false,
  // 'punch' on the way down, 'hold' at the bottom, 'restore' on the way back.
  phase: 'none',
  timeScale: 1,
  elapsed: 0,
  // What main.js hands world.focusCamera each frame, exactly as the death dive
  // publishes its own two numbers (see systems/deathDive.js). `camZoom` is the
  // push-in and `camWeight` is how much of the framing this owns — both eased
  // on the WALL clock, so the push is a steady movement over the top of the
  // dilation rather than something that crawls with it.
  camZoom: 1,
  camWeight: 0,
};

// THE FRAME WORTH KEEPING. Raised for exactly one frame, partway through the
// hold, and read by main.js immediately after it renders — see
// systems/bossShot.js for why the grab cannot happen anywhere else.
//
// Partway rather than at the start: the push-in is a spring settling into the
// seal, and the first frames of the hold are still travelling. By 60% of the
// way through, the frame has arrived and the pose has barely moved.
let shotDue = false;
let shotTaken = false;

/**
 * Is this the frame to keep? Self-clearing — asking consumes it, so a caller
 * that asks twice in one frame cannot take two pictures, and a frame that
 * nobody asks about is simply missed rather than queued.
 */
export function bossKillShotDue() {
  if (!shotDue) return false;
  shotDue = false;
  return true;
}

let clock = 0;
// The scale the current ramp started from, captured rather than assumed: a
// second boss killed while the last shot is still restoring (reachable with
// the debug spawner, and with two bosses in the water it would be reachable in
// a run) starts its ramp from wherever this one actually got to.
let fromScale = 1;
let fromZoom = 1;
let fromWeight = 0;

function cfg() {
  return CONFIG.boss?.kill ?? {};
}

function smoothstep(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function holdScale() {
  return Math.max(0.02, Math.min(1, cfg().hold ?? 0.12));
}

// The mix sags with the picture, the same way it does for a level and for a
// death. `follow` is how much of the dilation the sound takes and `minRate` is
// the floor — deeper than the level-up's, because this one is meant to be felt
// as a lurch rather than as a lean.
function setAudioRate(scale) {
  const c = cfg();
  if (c.audio?.enabled === false) return;
  const follow = c.audio?.follow ?? 0.7;
  const rate = Math.max(c.audio?.minRate ?? 0.4, 1 + (scale - 1) * follow);
  setMusicRateScale(rate, c.audio?.glide ?? 0.12);
  setSfxRateScale(rate);
}

function apply(scale) {
  bossKillState.timeScale = scale;
  setAudioRate(scale);
  return scale;
}

/**
 * The boss is dead. Start the shot.
 *
 * Called from systems/boss.js on the frame it notices the creature has left
 * the enemy list — that is the only place in the codebase that knows a boss
 * died, and it deliberately doesn't know what a camera is.
 *
 * @returns true if a shot was started. False means it is switched off, and
 *          the caller has nothing to wait for.
 */
export function startBossKill() {
  if (cfg().enabled === false) return false;
  bossKillState.active = true;
  bossKillState.phase = 'punch';
  bossKillState.elapsed = 0;
  // A picture per boss, and one only. Armed here rather than cleared on the
  // way out, so a shot interrupted before its hold — by a death, by a restart —
  // cannot leave the cue armed into the next fight.
  shotTaken = false;
  shotDue = false;
  clock = 0;
  fromScale = bossKillState.timeScale;
  fromZoom = bossKillState.camZoom;
  fromWeight = bossKillState.camWeight;
  // The score stops here rather than at the bottom of the ramp. The cut has to
  // land ON the killing blow — a mute that arrives a tenth of a second later
  // reads as the audio breaking, where one on the frame of the hit reads as
  // the hit doing it.
  const m = cfg().music ?? {};
  if (m.enabled !== false) {
    hushMusic({
      cut: m.cut,
      feed: m.feed,
      seconds: m.tailSeconds,
      decay: m.tailDecay,
      level: m.tailLevel,
      send: m.send,
    });
  }
  return true;
}

// The push-in, worked out from the wall clock rather than stored, so the shot
// has one description of where it is instead of two that can disagree.
function pushCamera(t, releasing) {
  const cam = cfg().cam ?? {};
  if (cam.enabled === false) {
    bossKillState.camZoom = 1;
    bossKillState.camWeight = 0;
    return;
  }
  if (releasing) {
    // Letting go is slower than taking hold. A frame that snapped back to the
    // wide shot the moment the slow motion ended would undo the whole thing —
    // the release IS the return to play, and it should arrive under the
    // player's own next input rather than ahead of it.
    const u = smoothstep(t / Math.max(0.01, cam.releaseTime ?? 0.5));
    bossKillState.camZoom = fromZoom + (1 - fromZoom) * u;
    bossKillState.camWeight = fromWeight * (1 - u);
    return;
  }
  const zoom = cam.zoom ?? 2.2;
  bossKillState.camZoom = fromZoom + (zoom - fromZoom) * smoothstep(t / Math.max(0.01, cam.pushTime ?? 0.3));
  // Reaches the seal-centred framing sooner than the zoom finishes, for the
  // same reason the death dive does: a zoom that commits before the frame does
  // pushes into whatever the wide shot happened to be centred on.
  bossKillState.camWeight = fromWeight
    + ((cam.weight ?? 0.9) - fromWeight) * smoothstep(t / Math.max(0.01, cam.frameTime ?? 0.2));
}

/**
 * @param rawDt UNSCALED seconds. Like the death dive and the level-up ramp,
 *              this runs on the wall clock because it is what decides the
 *              clock everything else runs on — a shot measured in its own
 *              dilated time would take longer the further into it you got.
 * @returns the time scale for the rest of the frame. 1 when no shot is up.
 */
export function updateBossKill(rawDt) {
  if (!bossKillState.active) return 1;
  const c = cfg();
  clock += rawDt;
  bossKillState.elapsed = clock;
  const hold = holdScale();

  if (bossKillState.phase === 'punch') {
    const into = Math.max(0.01, c.dilateTime ?? 0.12);
    const scale = apply(fromScale + (hold - fromScale) * smoothstep(clock / into));
    pushCamera(clock, false);
    if (clock >= into) {
      bossKillState.phase = 'hold';
      clock = 0;
      // The push keeps its own start points across the phase change: the
      // camera is one continuous movement from the kill to the release, and
      // re-capturing here would restart it from wherever it had reached and
      // stall the last part of the push.
    }
    return scale;
  }

  if (bossKillState.phase === 'hold') {
    // `pushCamera` is fed the time since the punch began, not since the hold
    // did, so a push longer than the dilation carries on through the beat.
    pushCamera(clock + Math.max(0.01, c.dilateTime ?? 0.12), false);
    // NOT `hold` — that is the time SCALE, and it is already in scope. A local
    // called the same thing shadowed it and the whole hold ran at 0.55x instead
    // of 0.12x: the slow motion quietly stopped being slow, with nothing
    // failing anywhere. `npm run test:bossshot` is what noticed.
    const holdFor = Math.max(0, c.beatTime ?? 1.5);
    if (!shotTaken && clock >= holdFor * (c.snapshot?.at ?? 0.6)) {
      shotTaken = true;
      shotDue = c.snapshot?.enabled !== false;
    }
    if (clock >= holdFor) {
      bossKillState.phase = 'restore';
      clock = 0;
      fromScale = bossKillState.timeScale;
      fromZoom = bossKillState.camZoom;
      fromWeight = bossKillState.camWeight;
      // The music comes back WITH the water, not after it. Both are the same
      // event — the moment ending — and a score that waited for the frame to
      // finish opening out would leave a second of live, silent gameplay in
      // between, which reads as the game having lost its music rather than as
      // the beat being over.
      const m = c.music ?? {};
      if (m.enabled !== false) releaseMusicHush(m.returnFade ?? 0.35);
    }
    return apply(hold);
  }

  // Restoring. The ocean accelerates back to full speed and the frame lets go
  // of the seal, both on their own curves — the camera's is longer, so the
  // last thing to finish is the frame opening back out, which is what makes
  // the return read as the shot ending rather than as the game resuming.
  const t = clock / Math.max(0.01, c.returnTime ?? 0.4);
  const scale = apply(fromScale + (1 - fromScale) * smoothstep(t));
  pushCamera(clock, true);
  const camDone = clock >= Math.max(0.01, cfg().cam?.releaseTime ?? 0.5);
  if (t >= 1 && camDone) {
    resetBossKill();
    return 1;
  }
  return scale;
}

/** Back to a live clock, a live mix and an unclaimed frame. */
export function resetBossKill() {
  const wasActive = bossKillState.active;
  bossKillState.active = false;
  bossKillState.phase = 'none';
  bossKillState.timeScale = 1;
  bossKillState.elapsed = 0;
  bossKillState.camZoom = 1;
  bossKillState.camWeight = 0;
  clock = 0;
  fromScale = 1;
  fromZoom = 1;
  fromWeight = 0;
  shotDue = false;
  shotTaken = false;
  // Only if this module had actually taken them. Called from startGame as
  // well, where writing the rates unconditionally would stamp on whatever the
  // death dive's own restore was in the middle of handing back.
  if (wasActive) {
    setMusicRateScale(1, 0);
    setSfxRateScale(1);
    // And the mute, with no fade. This is the interrupted case — a restart, a
    // death, the tuner switching the shot off mid-beat — and every one of them
    // ends with a score that must simply be back, not one easing up out of a
    // moment that is no longer happening. Harmless if the beat was already
    // over: the release is a no-op once the hush has been let go.
    releaseMusicHush(0);
  }
}
