import { CONFIG } from '../config.js';
import { setSfxRateScale } from './audio.js';
import { setMusicRateScale, hushMusic, releaseMusicHush, endBossMusic } from './music.js';
import { mark as crumb } from './crashLog.js';

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
  // 'punch' on the way down, 'hold' at the bottom, 'print' while the photo is
  // in flight, 'restore' on the way back.
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
  // WHERE THE FRAME IS POINTED, in world units. Was the seal's own position,
  // read straight off the player by main.js; it is now a point BETWEEN the
  // seal and the body it just killed, and the zoom above is pulled back
  // whenever the push-in would crop one of them out. See applyFraming.
  //
  // A plain object rather than a Vector3 because world.focusCamera only ever
  // reads .x and .y, and this is rewritten every frame of a shot.
  cam: { x: 0, y: 0 },
  // Whether `cam` has been worked out yet for THIS shot. A boss dies partway
  // through a frame — after the camera work, in systems/boss.js — so the shot
  // is already `active` for the rest of that frame with nothing but the last
  // one's framing in it. One frame pointed at where the previous seal stood is
  // a visible jump on the killing blow, which is the worst frame in the run to
  // put one on.
  framed: false,
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

/**
 * When the shutter goes, in WALL seconds after the kill.
 *
 * The one derivation of this number in the game: the ramp down, then a
 * fraction of the way into the beat. systems/celebrate.js times the seal's
 * pose off it, systems/bossCorpse.js times how long the body is kept whole
 * off it, and ui/snapshotPrint.js is handed the picture on it — retune the
 * shot and all three follow, because none of them holds a copy.
 */
export function snapshotMoment() {
  const k = CONFIG.boss?.kill ?? {};
  const dilate = Math.max(0.01, k.dilateTime ?? 0.12);
  const beat = Math.max(0, k.beatTime ?? 1.5);
  return dilate + beat * (k.snapshot?.at ?? 0.6);
}

/**
 * How long the world stays slow AFTER the beat, while the print is in the air.
 *
 * Derived from the print's own timings rather than typed next to them, for the
 * same reason the pose is: the phase exists to cover the animation, and a hand
 * -typed length is a second description of it that goes stale the first time
 * the print is retuned. What is left of the BEAT after the shutter already
 * covers part of the flight, so only the remainder is bought here — a print
 * short enough to finish inside the beat adds no phase at all.
 */
export function printPhaseSeconds() {
  const k = CONFIG.boss?.kill ?? {};
  const p = k.print ?? {};
  if (p.enabled === false || k.snapshot?.enabled === false) return 0;
  // The print stands still for whichever is longer, the beat or the artboard's
  // write-on — they are the same stillness, so this is a max and not a sum
  // (see CONFIG.boss.kill.print.writeOnMs). The world must not come back while
  // the artboard is still drawing itself, which is what puts writeOnMs in here
  // at all.
  //
  // Counted even though only the Rive print HAS a write-on: this is answered
  // before any print exists, and a phase length that depended on whether a
  // 1.7MB WASM file had finished loading would make the held beat after a boss
  // dies a different length from run to run.
  const still = Math.max(p.holdMs ?? 620, p.writeOnMs ?? 800);
  const flight = ((p.ejectMs ?? 260) + still + (p.parkMs ?? 520)) / 1000;
  const beat = Math.max(0, k.beatTime ?? 1.5);
  const leftOfBeat = beat * (1 - Math.max(0, Math.min(1, k.snapshot?.at ?? 0.6)));
  return Math.max(0, flight - leftOfBeat);
}

// WHAT THE SHOT IS LOOKING AT. Written once a frame by main.js, which is the
// only place that knows both where the seal is and how big the frame is; read
// by applyFraming below. Kept as loose numbers rather than as the caller's own
// objects so nothing here can hold a reference to a creature that is about to
// go back to the pool.
const framing = {
  px: 0, py: 0,
  sx: 0, sy: 0, sr: 0,
  hasSubject: false,
  halfW: 0, halfH: 0,
};

/**
 * @param playerPos the seal.
 * @param subject   { x, y, r } — the body, or null when there isn't one to
 *                  frame (the shot then behaves exactly as it used to).
 * @param half      { w, h } the visible half-frame in world units at zoom 1.
 */
export function setBossKillFraming(playerPos, subject, half) {
  framing.px = playerPos?.x ?? 0;
  framing.py = playerPos?.y ?? 0;
  framing.halfW = half?.w ?? 0;
  framing.halfH = half?.h ?? 0;
  framing.hasSubject = !!subject;
  if (subject) {
    framing.sx = subject.x ?? 0;
    framing.sy = subject.y ?? 0;
    framing.sr = Math.max(0, subject.r ?? 0);
  }
}

// TWO ANIMALS IN ONE FRAME.
//
// The push-in used to be aimed at the seal and zoomed to a fixed 2.2, which is
// the right shot for a seal on its own and the wrong one for a seal standing
// over something forty units long: at 2.2 the body is mostly outside the
// frame, and the picture that gets kept is a close-up of a celebration with no
// visible reason for it.
//
// So the frame is aimed BETWEEN them and the zoom is whatever actually fits.
// `subjectBias` is short of the midpoint on purpose — the seal is the subject
// and the boss is what it did, so the frame leans toward the animal that is
// still alive.
//
// The fit only ever pulls the zoom BACK (it is a min against the push, floored
// at 1), so this can widen a shot that would have cropped and can never invent
// a push-in the shot didn't ask for, nor open out past the ordinary frame.
function applyFraming() {
  const c = cfg().cam ?? {};
  bossKillState.cam.x = framing.px;
  bossKillState.cam.y = framing.py;
  bossKillState.framed = true;
  if (!framing.hasSubject || c.frameBoth === false || !(framing.halfW > 0)) return;

  const bias = Math.max(0, Math.min(1, c.subjectBias ?? 0.42));
  const minZoom = c.minZoom ?? 1;
  const pad = Math.max(0, c.framePad ?? 1.8);

  // THE PICTURE IS NOT THE FRAME, and fitting to the frame is what let the
  // polaroid come out with half a boss in it.
  //
  // What the player watches is the whole widescreen frame; what the print
  // keeps is a SQUARE cut out of the middle of it (see squareCrop in
  // systems/bossShot.js), which on a 16:9 screen throws away 44% of the width.
  // So a body that fits the shot with room to spare can sit comfortably
  // outside the photograph — and every check that ever went looking said the
  // framing was correct, because against the frame it was.
  //
  // The square's half-extent is min(halfW, halfH) on BOTH axes: the crop's side
  // is the short side of the canvas, and an orthographic frame has the same
  // world-units-per-pixel across and down. Fitting to that is what makes "in
  // the picture" mean the picture.
  const s = cfg().snapshot ?? {};
  const cropping = c.framePicture !== false && s.enabled !== false && framing.halfH > 0;
  const lim = cropping ? Math.min(framing.halfW, framing.halfH) : 0;
  const limW = cropping ? lim : framing.halfW;
  const limH = cropping ? lim : framing.halfH;

  // Both subjects have to be inside the half-frame measured FROM THE POINT THE
  // CAMERA IS ACTUALLY AIMED AT, which is not the midpoint between them — the
  // bias moved it. Measuring the fit off the separation instead is right at
  // bias 0.5 and quietly crops the far animal at every other value.
  const fitAt = (fx, fy) => {
    const needW = Math.max(
      Math.abs(framing.px - fx) + pad,
      Math.abs(framing.sx - fx) + framing.sr + pad,
    );
    const needH = Math.max(
      Math.abs(framing.py - fy) + pad,
      Math.abs(framing.sy - fy) + framing.sr + pad,
    );
    return Math.min(
      limW / Math.max(needW, 1e-3),
      limH / Math.max(needH, 1e-3),
    );
  };

  let fx = framing.px + (framing.sx - framing.px) * bias;
  let fy = framing.py + (framing.sy - framing.py) * bias;
  let fit = fitAt(fx, fy);

  // THE LEAN IS A LUXURY. Aiming short of the midpoint costs frame on the far
  // side, and across a whole arena — a seal at one wall, a megalodon dead at
  // the other — that cost is the difference between the boss being in the
  // picture and being an inch outside it. So when the biased frame cannot hold
  // both at the widest zoom allowed, the lean is given up and the pair is
  // centred, which is the framing that fits the most of them.
  //
  // Giving up the ZOOM instead is not an option: below minZoom the frame runs
  // off the water plane onto the bare scene background.
  if (fit < minZoom) {
    const loX = Math.min(framing.px, framing.sx - framing.sr);
    const hiX = Math.max(framing.px, framing.sx + framing.sr);
    const loY = Math.min(framing.py, framing.sy - framing.sr);
    const hiY = Math.max(framing.py, framing.sy + framing.sr);
    fx = (loX + hiX) / 2;
    fy = (loY + hiY) / 2;
    fit = fitAt(fx, fy);
  }

  const zoom = Math.max(minZoom, Math.min(bossKillState.camZoom, fit));
  bossKillState.camZoom = zoom;
  bossKillState.cam.x = fx;
  // AND THE CROP'S OWN OFFSET, handed back to the aim so the two agree.
  //
  // squareBiasY cuts the square high or low in the frame rather than through
  // the middle of it. Left out of here, the fit above would be measured about a
  // square that is not where the crop actually lands, and the correction would
  // be worth exactly the bias — the far animal clipped off the top of a print
  // biased downward. A no-op at the shipped 0, which is why it went unnoticed
  // while the bias was only ever moved in the tuner.
  const cropBias = Math.max(-1, Math.min(1, s.squareBiasY ?? 0));
  bossKillState.cam.y = cropping
    ? fy + (cropBias * (framing.halfH - lim)) / Math.max(zoom, 1e-3)
    : fy;
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
  crumb('kill:shot');
  bossKillState.active = true;
  bossKillState.phase = 'punch';
  // Unframed until the next frame works it out — see bossKillState.framed.
  bossKillState.framed = false;
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

// Into the ramp back, from wherever the moment actually got to. Shared by the
// two phases that can end it (a beat with no print behind it, and the print
// finishing) so the handover is written once — the music release in particular
// is easy to leave behind in one of two exits, and a hush that outlives its
// shot is a silent ocean with nothing wrong on screen to explain it.
function beginRestore(c) {
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
  // THE FIGHT'S MUSIC ENDS HERE, and it ends BEFORE the release — the order is
  // the whole reason this is two calls and not one.
  //
  // The hush has had the music gain at zero since the killing blow, so the boss
  // loop has been playing silently underneath the tail for the length of the
  // held beat. Swapping the transport back to the run's own loop while that is
  // still true is the one moment in the fight where a switch costs nothing:
  // there is no seam to hear, so it needs no boundary to land on, and the
  // ordinary music gets to come back from its own bar one.
  //
  // Then the release ramps the gain up, and what fades in is already the right
  // track. Reversed, the player would hear a second of boss music return before
  // it was cut a second time — the fight ending twice.
  endBossMusic();
  if (m.enabled !== false) releaseMusicHush(m.returnFade ?? 0.35);
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
    applyFraming();
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
    applyFraming();
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
      // Into the print if there is one to wait for, straight out if there
      // isn't — the phase buys time for an animation, so with the print
      // switched off it must not exist at all rather than be a beat of zero
      // length that still costs a frame of state.
      if (printPhaseSeconds() > 0) {
        bossKillState.phase = 'print';
        clock = 0;
      } else {
        beginRestore(c);
      }
    }
    return apply(hold);
  }

  // THE PRINT IS IN THE AIR. The world stays exactly where the beat left it —
  // this is the same held frame, extended — while the photo ejects, develops
  // and flies to the corner (see ui/snapshotPrint.js). It is a separate phase
  // rather than a longer `beatTime` because it is a different thing being
  // waited on: the beat is how long the wreckage is worth looking at, and this
  // is how long the print takes. Retuning either must not move the other.
  if (bossKillState.phase === 'print') {
    pushCamera(clock + Math.max(0.01, c.dilateTime ?? 0.12) + Math.max(0, c.beatTime ?? 1.5), false);
    applyFraming();
    if (clock >= printPhaseSeconds()) beginRestore(c);
    return apply(hold);
  }

  // Restoring. The ocean accelerates back to full speed and the frame lets go
  // of the seal, both on their own curves — the camera's is longer, so the
  // last thing to finish is the frame opening back out, which is what makes
  // the return read as the shot ending rather than as the game resuming.
  const t = clock / Math.max(0.01, c.returnTime ?? 0.4);
  const scale = apply(fromScale + (1 - fromScale) * smoothstep(t));
  pushCamera(clock, true);
  applyFraming();
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
  bossKillState.framed = false;
  // The subject goes with the shot. A stale body left in here would be framed
  // against by the NEXT kill for its first frame, which is a picture of two
  // bosses one of which is no longer in the water.
  framing.hasSubject = false;
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
    // The fight's music with it, and at a bar rather than instantly: this is
    // the path where the beat was CUT SHORT, so the hush has just been let go
    // and the boss loop is audible again. Without this the shot's normal exit
    // is the only thing that ever ends the rotation, and a beat interrupted
    // half way — the tuner switching the shot off, a restart landing inside
    // one — would leave boss music looping over an empty ocean for the rest of
    // the run. Harmless from startGame: play() re-picks the opening loop a
    // moment later either way.
    endBossMusic({ immediate: false });
  }
}
