import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';
import { player } from '../entities/player.js';
import { stateForSpeed } from './animation.js';
import { feedback } from './feedback.js';
import { setSfxRateScale, openBusFilter } from './audio.js';
import { setMusicRateScale } from './music.js';
import { setAmbientRateScale } from './ambient.js';

// The run doesn't end on the frame you die — it ends on the seabed.
//
// Dying hands the seal over to this module, which owns three things until the
// score screen appears:
//
//   1. THE CLOCK. update() returns the time scale the WHOLE frame runs at —
//      main.js multiplies its raw delta by it before anything else reads a
//      delta, so gameplay, particles, the mixer, the water and the camera all
//      crawl together. Dilating only gameplay would leave the seal sinking
//      through spray and a grid still moving at full speed, which reads as a
//      frame-rate problem rather than as slow motion. The scale dips hard on
//      the moment of death and then eases back toward a drift, because a
//      descent held at the deepest dilation takes the better part of a minute.
//   2. THE BODY. No controller, no clamp, no aim — just momentum, gravity and
//      drag, with a tumble that damps out and a barrel roll to go with it. The
//      fins and head go limp because main.js stops feeding the rig an aim (see
//      the death branch there); the tail keeps its spring, so it trails and
//      flops off the body's own motion for free.
//
//      AND THE SKELETON GOES WITH IT. A beat after the killing blow the mixer
//      is cut off entirely (anim.setLimp) and the seal's five ragdoll chains —
//      both front flippers, both rear flippers, the neck — are woken for the
//      first and only time in the run. Gravity and the water going past are fed
//      into them every frame, so the limbs hang and stream instead of holding a
//      pose. Same machinery, same reasoning and mostly the same numbers as
//      systems/bossRagdoll.js, which does this for a dead boss; CONFIG.death
//      .flop carries the seal's copy.
//
//      THE SEABED IS NOT THE END OF IT EITHER. The body bounces — restitution
//      spent contact by contact, a skid and a tumble kick off each one, a shove
//      into the limbs and the tail, and its own lighter piece of feedback every
//      time it comes down. The score card waits for the body to be genuinely
//      DOWN rather than for a fixed pause from the first contact.
//   3. THE SOUND. The audio rate follows the time scale — the music drags down
//      like a tape stop and one-shots play back long and low with it. Slow
//      motion you can only see is half the effect.
//
// The pause that follows the seabed hit is wall-clock, not dilated: it's there
// so the corpse visibly comes to rest — and is watched lying there for a beat —
// before the name box takes the keyboard, and a couple of seconds of slow
// motion would be most of a minute of waiting.
//
// The way OUT is this module's job too. "Try again" doesn't cut straight into
// the next run: beginRestartTransition glides the clock, the pitch, the
// muffling and the push-in back to normal, and only then starts it.

const TAU = Math.PI * 2;
const DOWN = new THREE.Vector3(0, -1, 0);
const _tailDir = new THREE.Vector3();
const _blow = new THREE.Vector3();
const _flow = new THREE.Vector3();
const _rollQ = new THREE.Quaternion();
const _craneQ = new THREE.Quaternion();
const _yAxis = new THREE.Vector3(0, 1, 0); // the art's forward — the roll axis
const _xAxis = new THREE.Vector3(1, 0, 0); // the crane axis, as in updatePlayer

export const deathState = {
  active: false,
  // 'sink' until the seabed, 'settle' for the wall-clock pause on the floor,
  // 'done' once the score screen has been handed the run, 'restart' while
  // everything glides back to normal for the next one. Stays `active` through
  // 'done' so the scene behind the game-over card keeps its slow drift instead
  // of snapping back to full speed under the menu.
  phase: 'none',
  // Wall-clock seconds since the killing blow. Published for the cinematic
  // camera, which splits the 'sink' phase into its own two beats — the hit and
  // the fall — and needs a clock to do it on. Nothing here reads it back;
  // `elapsed` below is still the authority.
  elapsed: 0,
  timeScale: 1,
  // The lens. Published rather than applied here, because the camera belongs
  // to world.js and this module has no business reaching into it — main.js
  // hands these to world.focusCamera each frame. `camZoom` is the push-in
  // multiplier and `camWeight` is how much of the framing it owns, both
  // easing on the WALL clock: the push is meant to read as a steady, separate
  // movement over the top of the dilation, not to crawl with it.
  camZoom: 1,
  camWeight: 0,
};

const vel = new THREE.Vector2();
let spin = 0; // z tumble, rad/s of DILATED time
let roll = 0; // barrel roll about the seal's own forward axis, same clock
let elapsed = 0; // wall-clock since death — drives the dilation ramp
let settleClock = 0; // wall-clock since the seabed hit
let swayClock = 0;
let onFinish = null;
// How much faster this particular body falls, from how far it has to fall.
// Baked once at death — see startDeathDive.
let sinkScale = 1;
// The way back out. `restartClock` is wall-clock into the transition and
// `restartFrom` is the state it started from, captured so the glide runs from
// wherever the sequence actually was rather than from a value we assumed.
let restartClock = 0;
let restartFrom = { scale: 1, zoom: 1, weight: 0 };
// Set once the score card is up: from there on the dive no longer owns the
// music's playback rate. Without it, the ramp back out on "try again" would
// grab the track that has been sitting at pitch and yank it down to `minRate`
// again before letting it go.
let musicReleased = false;
// --- the flop ---------------------------------------------------------------
// Contacts with the seabed so far, and whether the body is down for good. The
// settle pause counts from `resting`, not from the first contact: a corpse
// still pattering across the sand when the score card fades up is the whole
// effect happening behind a menu.
let bounces = 0;
let resting = false;
// Wall-clock since the FIRST contact, against CONFIG.death.flop.settleMax. The
// ceiling that guarantees the card arrives even if the numbers are tuned into a
// body that never stops.
let bounceClock = 0;
// The skeleton. 'waiting' until limpDelay is up, then 'live' if this body
// actually had chains to cut loose and 'none' if it did not — a model with no
// rig (or a Node harness with no model at all) must not be asked again every
// frame for the rest of the descent.
let limpState = 'waiting';
// Dilated seconds since death, driving the loll — and the last loll angle
// written, since it is applied to rotation.z as a DELTA. That angle is
// accumulated by the tumble, so a sine written straight onto it would be the
// two of them fighting over one number.
let flopClock = 0;
let lollPrev = 0;

function smoothstep(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function cfg() {
  return CONFIG.death ?? {};
}

function flop() {
  return CONFIG.death?.flop ?? {};
}

// The spring the loose chains solve with while the body is limp. Rebuilt only
// when the tuner has actually moved one of them — this is read once a frame and
// the values are global, so the whole thing is one shared object between
// rebuilds. Same arrangement as limpSpring in systems/bossRagdoll.js and
// springCfgFor in systems/animation.js.
let limpCfg = null;
let limpStamp = '';
function limpSpring() {
  const f = flop();
  const stamp = `${f.stiffness}|${f.damping}|${f.tipLooseness}|${f.maxLag}|${f.softness}|${f.snapAngle}`;
  if (limpStamp !== stamp) {
    limpStamp = stamp;
    limpCfg = {
      stiffness: f.stiffness ?? 7,
      damping: f.damping ?? 2.6,
      tipLooseness: Math.min(0.98, f.tipLooseness ?? 0.9),
      maxLag: f.maxLag ?? 1.7,
      softness: f.softness ?? 0.5,
      snapAngle: f.snapAngle ?? 3.0,
    };
  }
  return limpCfg;
}

// Where the body comes to rest. The same hitRadius clampToArena uses, so the
// corpse settles exactly as deep as a living seal is allowed to swim.
function floorY() {
  return bounds.bottom + (player.stats?.hitRadius ?? 1);
}

/**
 * @param finish called once, after the seabed hit and the settle pause — this
 *               is what puts the score screen up.
 */
export function startDeathDive(finish) {
  onFinish = finish ?? null;
  deathState.active = true;
  deathState.phase = 'sink';
  deathState.timeScale = 1;
  deathState.camZoom = 1;
  deathState.camWeight = 0;
  deathState.elapsed = 0;
  elapsed = 0;
  settleClock = 0;
  swayClock = 0;
  musicReleased = false;
  bounces = 0;
  resting = false;
  bounceClock = 0;
  limpState = 'waiting';
  flopClock = 0;
  lollPrev = 0;

  const c = cfg();
  const f = flop();
  // Whatever the seal was doing carries on, damped — a death mid-dash should
  // still travel. The upward kick is what sells the limpness: the body rises
  // a moment against its own momentum before the water takes it down.
  vel.copy(player.velocity).multiplyScalar(c.launch ?? 0.5);
  vel.y += c.kickUp ?? 5;

  // A death at the surface has the whole arena to fall through and one at the
  // seabed has none, so a single sink rate makes the sequence twice as long
  // for the deaths that happen high up — and those are the ones where you're
  // already waiting. The further it has to fall, the faster it falls: gravity
  // and terminal velocity scale together, so the body still reaches its
  // terminal speed in the same moment, it's just a higher one.
  // Measured against the FRAME's ceiling, not the arena's. This is a pacing
  // curve tuned on the fall from the water line, and dividing by a raised
  // ceiling (arena.airScale) silently flattens it — a surface death loses
  // about 14% of its sink rate for air nothing usually dies in. A death up
  // in that air just pins the ratio at 1, which is the right answer anyway.
  const span = Math.max(1, bounds.frameTop - floorY());
  const drop = Math.max(0, player.mesh.position.y - floorY());
  sinkScale = 1 + ((c.depthBoost ?? 2.2) - 1) * Math.min(1, drop / span);

  // Tumble scaled by how fast it was going, so a seal killed at a standstill
  // rolls over gently and one killed mid-strike cartwheels.
  const speed = player.velocity.length();
  const heat = Math.min(1, speed / Math.max(1, player.stats?.maxSpeed ?? 30));
  const dir = Math.random() < 0.5 ? -1 : 1;
  // The multipliers are the flop's, and they are multipliers rather than new
  // absolutes so the two sliders that were already tuned still mean what they
  // meant — this loosens what is there instead of replacing it.
  spin = dir * (c.spin ?? 2.4) * (0.35 + heat) * (f.spinMul ?? 1);
  roll = dir * (c.bodyRoll ?? 1.6) * (0.35 + heat) * (f.rollMul ?? 1);

  // One shove into the tail spring on the way out. It has nothing driving it
  // any more — no swim cycle, no aim — so without a kick to carry it starts
  // the dive already settled, which is the one thing a limp tail shouldn't be.
  _tailDir.set(-Math.sign(spin) || 1, -1, 0).normalize();
  player.aimRig?.tailImpulse(_tailDir, c.tailKick ?? 9);

  // A death mid-wind-up hands over a body still offset by the tremble's
  // positional buzz (see updatePlayer). Nothing eases it out from here —
  // updatePlayer stops running the moment the dive owns the seal — so the
  // corpse would sink a few hundredths off its own container for the whole
  // sequence. Cleared here rather than in the dive's own transform, which is
  // about rotation and has no business writing this every frame.
  player.body.position.set(0, 0, 0);

  setAudioRate(1);
}

// Music and one-shots both ride the dilation. `follow` is how much of it they
// take (1 = the sound slows exactly as far as the picture does) and `minRate`
// is the floor — the deepest part of the dilation is slow enough to turn a
// loop into an unrecognisable rumble, and the drop is the effect, not the mud
// at the bottom of it.
//
// Music only until the score card goes up — see releaseMusic. The one-shots
// and the bed stay dilated the whole way, because they belong to the seabed
// the body is still lying on.
function setAudioRate(scale) {
  const c = cfg();
  if (c.audio?.enabled === false) return;
  const follow = c.audio?.follow ?? 1;
  const rate = Math.max(c.audio?.minRate ?? 0.3, 1 + (scale - 1) * follow);
  if (!musicReleased) setMusicRateScale(rate, c.audio?.glide ?? 0.25);
  setSfxRateScale(rate);
  // The bed drags too. It's the slowest-moving thing in the mix, so it's
  // where the tape running down reads most clearly.
  setAmbientRateScale(rate, c.audio?.glide ?? 0.25);
}

// The tape winds back up to speed under the score card, over its own time
// rather than the dive's — the drag-down was the last thing the run did, and
// this is the first thing the screen after it does. Left as a plain glide with
// no quantising: it's a pitch change, not a track change, and the loop
// underneath it never stops.
function releaseMusic() {
  if (musicReleased) return;
  musicReleased = true;
  const c = cfg();
  if (c.audio?.enabled === false) return;
  // /3 because the glide is an exponential-approach time constant and a
  // constant is ~95% of the way there after three of them — `restoreTime` is
  // the number of seconds you actually wait to hear it back at pitch.
  setMusicRateScale(1, Math.max(0, (c.audio?.restoreTime ?? 2.6) / 3));
}

/**
 * @param rawDt UNSCALED seconds — this is the one thing in the game that still
 *              runs on the wall clock, because it's what decides the scale
 *              everything else runs at.
 * @returns the time scale for the rest of the frame. 1 whenever no one is dying.
 */
export function updateDeathDive(rawDt) {
  if (!deathState.active) return 1;
  const c = cfg();

  // Coming back. Everything the death bent unwinds together over one wall-clock
  // window, and the run starts on the far side of it — nothing about the body
  // is simulated any more, it's just the clock, the mix and the lens letting
  // go. Ahead of the dilation below because this OWNS the scale while it runs.
  if (deathState.phase === 'restart') {
    restartClock += rawDt;
    const t = smoothstep(restartClock / Math.max(0.01, c.restart?.time ?? 0.9));
    const scale = restartFrom.scale + (1 - restartFrom.scale) * t;
    deathState.timeScale = scale;
    setAudioRate(scale);
    deathState.camZoom = restartFrom.zoom + (1 - restartFrom.zoom) * t;
    deathState.camWeight = restartFrom.weight * (1 - t);
    if (t >= 1) {
      const finish = onFinish;
      onFinish = null;
      // Cleared BEFORE the callback, not after: it's startGame, which calls
      // resetDeathDive itself — landing back in here afterwards to tidy up
      // would undo the fresh run's state.
      resetDeathDive();
      finish?.();
      return 1;
    }
    return scale;
  }

  elapsed += rawDt;
  deathState.elapsed = elapsed;
  // Two eases, one after the other: down into the dilation on the moment of
  // death, then back out toward a drift so the descent stays watchable. The
  // second one starts where the first ended rather than from 1, or the
  // recovery would undo the dip it's meant to be relaxing from.
  const dip = smoothstep(elapsed / Math.max(0.01, c.dilateTime ?? 0.4));
  const back = smoothstep((elapsed - (c.dilateTime ?? 0.4)) / Math.max(0.01, c.driftTime ?? 1.5));
  const deep = 1 + ((c.slowMo ?? 0.12) - 1) * dip;
  const scale = deep + ((c.driftScale ?? 0.32) - deep) * back;
  deathState.timeScale = scale;
  setAudioRate(scale);

  // The lens leaning in. Wall-clock and its own ease, so it keeps moving
  // through the deepest part of the dilation — a push that ran on dilated time
  // would be almost stationary for the first second, which is exactly the
  // second it's there for. It never finishes early on purpose: on a long fall
  // the frame is still closing in as the body lands.
  const cam = c.camera ?? {};
  if (cam.enabled === false) {
    deathState.camZoom = 1;
    deathState.camWeight = 0;
  } else {
    const push = smoothstep(elapsed / Math.max(0.01, cam.pushTime ?? 3));
    deathState.camZoom = 1 + ((cam.zoom ?? 1.8) - 1) * push;
    // Reaches the corpse-centred framing sooner than the zoom finishes, or the
    // seal drifts around a frame that hasn't committed to it yet.
    deathState.camWeight = smoothstep(elapsed / Math.max(0.01, cam.frameTime ?? 1.2));
  }

  // The skeleton, on its own clock — and ahead of the 'done' return, so the
  // limbs go on settling under the score card rather than freezing on the frame
  // it appears. main.js hands the controller over for the whole dive: see the
  // note beside its own anim.update call.
  updateRagdoll(rawDt, rawDt * scale);

  if (deathState.phase === 'done') return scale;

  const dt = rawDt * scale;
  flopClock += dt;
  const f = flop();
  const rest = floorY();
  const pos = player.mesh.position;

  if (deathState.phase === 'sink') {
    vel.y -= (c.sinkGravity ?? 24) * sinkScale * dt;
    // A lazy side-to-side drift on the way down, so the descent isn't a
    // plumb line. Its own clock, on dilated time, so it reads as water
    // moving the body rather than as a wobble bolted onto the fall.
    swayClock += dt;
    vel.x += Math.sin(swayClock * (c.swayHz ?? 0.4) * TAU) * (c.sway ?? 5) * dt;
    vel.multiplyScalar(Math.pow(c.drag ?? 0.96, dt * 60));
    const sinkMax = (c.sinkSpeedMax ?? 20) * sinkScale;
    if (vel.y < -sinkMax) vel.y = -sinkMax;

    pos.x += vel.x * dt;
    pos.y += vel.y * dt;

    // Walls only. The surface is deliberately not a lid — a seal killed
    // mid-breach falls back through it, and the splash it makes on the way
    // down is the last thing it does above water.
    const radius = player.stats?.hitRadius ?? 1;
    if (pos.x < bounds.left + radius) { pos.x = bounds.left + radius; vel.x = Math.abs(vel.x) * 0.4; }
    if (pos.x > bounds.right - radius) { pos.x = bounds.right - radius; vel.x = -Math.abs(vel.x) * 0.4; }

    if (pos.y <= rest) {
      pos.y = rest;
      land(Math.abs(vel.y));
    }
  } else {
    // Settling — which is now several contacts rather than one. The clock that
    // ends the run is still the wall one; see the note at the top.
    bounceClock += rawDt;
    // AND IT COUNTS FROM THE MOMENT THE BODY IS DOWN, not from the first
    // contact. A pause started at the landing is spent watching the bouncing it
    // was meant to follow, and the card then fades up over a corpse still
    // moving. `settleMax` below is the ceiling that keeps this honest.
    if (resting) settleClock += rawDt;
    // Gravity still applies, or the bounce off the floor would carry the body
    // up and leave it hanging there — a corpse that has to come to rest has to
    // come back DOWN first. Same depth-scaled gravity as the fall, so a body
    // that arrived fast doesn't hang at the top of its bounce.
    vel.y -= (c.sinkGravity ?? 24) * sinkScale * dt;
    // THE WATER BETWEEN CONTACTS, THE SAND ONCE IT IS DOWN. `settleDrag` is
    // 0.86 per 1/60s, which over a single dilated second is a factor of 1e-4:
    // it eats a bounce whole, and it is the reason the old restitution had to
    // stay tiny to read as anything at all. It still ends the movement once the
    // body is resting, which is what it is good at.
    vel.multiplyScalar(Math.pow(resting ? (c.settleDrag ?? 0.86) : (f.bounceDrag ?? 0.985), dt * 60));
    pos.x += vel.x * dt;
    pos.y += vel.y * dt;
    // The walls apply down here too now: a skid off a contact can carry the
    // body into one, and a corpse halfway inside a boulder reads as a bug
    // rather than as a joke.
    const radius = player.stats?.hitRadius ?? 1;
    if (pos.x < bounds.left + radius) { pos.x = bounds.left + radius; vel.x = Math.abs(vel.x) * 0.4; }
    if (pos.x > bounds.right - radius) { pos.x = bounds.right - radius; vel.x = -Math.abs(vel.x) * 0.4; }
    if (pos.y <= rest) {
      pos.y = rest;
      // ONCE IT IS DOWN, THE FLOOR IS JUST THE FLOOR. Gravity still runs while
      // the body lies there — it has to, or a corpse would hang at the top of
      // its last bounce — so without this every frame of the settle pause is
      // another contact: another silt puff, another thud, another spin kick.
      // Count the EDGE, not the frames the body spends touching the sand.
      if (resting) { if (vel.y < 0) vel.y = 0; }
      else contact(Math.abs(vel.y));
    }
    // ...and the ceiling. Wall-clock, counted from the first contact: whatever
    // the restitution is tuned to, the body is put down after this and the
    // pause that ends the run starts.
    if (!resting && bounceClock >= (f.settleMax ?? 6)) {
      resting = true;
      vel.y = 0;
    }
    // Roll the body flat, ONCE IT IS DOWN. The art's forward is +Y, so a seal
    // lying on the floor is a quarter turn either way — whichever it's already
    // nearest, so it slumps the short way instead of rotating through upright.
    // Gated on `resting` because a body still bouncing is meant to be tumbling:
    // running this through the bounces turns the flop into a corpse gliding
    // politely into position between hops.
    if (resting) {
      const z = player.mesh.rotation.z;
      const quarter = Math.PI / 2;
      const target = Math.round((z - quarter) / Math.PI) * Math.PI + quarter;
      player.mesh.rotation.z += (target - z) * (1 - Math.exp(-(c.settleTurn ?? 5) * dt));
    }

    if (resting && settleClock >= (c.settle ?? 0.5)) {
      deathState.phase = 'done';
      // The track is still playing — it isn't stopped by the death any more —
      // so hand its rate back before the card appears, or it sits at `minRate`
      // under the score screen for as long as the player takes to type a name.
      releaseMusic();
      const finish = onFinish;
      onFinish = null;
      finish?.();
      return scale;
    }
  }

  // Tumble and barrel roll, both damping out. The roll is composed on its own
  // rather than through updatePlayer's transform: the crane and the wind-up
  // shudder are poses a live seal holds, and a dead one holds nothing.
  //
  // The tumble carries on through the BOUNCING as well as the fall — each
  // contact kicks it (see contact()), and a body that stopped turning the
  // moment it first touched the sand would take those kicks and sit on them.
  if (deathState.phase === 'sink' || !resting) player.mesh.rotation.z += spin * dt;

  // THE LOLL. A limp body does not turn at one rate: it swings about the axis
  // it is falling along and the swing dies out. Applied as the DELTA of a
  // decaying sine rather than as an angle, because rotation.z is accumulated by
  // the tumble above and two writers on one number is two writers on one
  // number. `lollPrev` is updated even on the frames the delta is not applied,
  // so coming to rest cannot leave a step in the angle.
  const lollAmp = (f.wobble ?? 0) * Math.exp(-(f.wobbleDamp ?? 0.35) * flopClock);
  const loll = lollAmp * Math.sin(flopClock * (f.wobbleHz ?? 0.55) * TAU);
  if (!resting) player.mesh.rotation.z += loll - lollPrev;
  lollPrev = loll;

  spin *= Math.exp(-(c.spinDamp ?? 0.7) * dt);
  roll *= Math.exp(-(c.rollDamp ?? 0.5) * dt);
  player.rollAngle += roll * dt;
  // Same composition updatePlayer uses, minus the wind-up shudder — a dead
  // seal isn't bracing for anything. The crane is decayed rather than dropped:
  // a seal killed while twisting to look behind itself is holding a real
  // angle, and zeroing it on the frame of death is a visible snap.
  player.craneAngle *= Math.exp(-(c.craneRelax ?? 3) * dt);
  _rollQ.setFromAxisAngle(_yAxis, player.mirrorAngle + player.rollAngle);
  _craneQ.setFromAxisAngle(_xAxis, player.craneAngle);
  player.body.quaternion.copy(_craneQ).multiply(_rollQ);

  // Publish the drift back onto the player. Nothing reads it for control any
  // more, but the grid's wake still pulls on it — left at whatever the seal
  // was doing when it died, the water would keep sucking in around a body
  // that has been lying still on the seabed for a minute.
  player.velocity.copy(vel);

  return scale;
}

function land(impactSpeed) {
  deathState.phase = 'settle';
  settleClock = 0;
  bounceClock = 0;
  contact(impactSpeed);
}

/**
 * ONE CONTACT WITH THE SEABED — the arrival and every bounce after it, through
 * the same code, because they are the same event with a different amount of
 * energy left in it.
 *
 * Everything here scales by how hard this particular contact was, so a corpse
 * that fell from the surface arrives heavy and leaves in a heap while one that
 * died a metre off the floor barely stirs the silt.
 *
 * @param impactSpeed downward speed at the moment of contact, world units/s.
 */
function contact(impactSpeed) {
  const c = cfg();
  const f = flop();
  const first = bounces === 0;
  bounces++;

  // Restitution, spent contact by contact. The decay is what turns a bounce
  // into a patter: without it a body either bounces forever at one height or
  // stops dead on the second one.
  const decay = Math.pow(f.bounceDecay ?? 0.75, bounces - 1);
  const back = impactSpeed * (f.restitution ?? 0.5) * decay;
  // Down for good — out of bounces, or the next one is a hop nobody can see.
  // Letting a sub-visible hop run leaves the body resting a hair off the floor
  // when the card appears, which was true of the old settle too.
  const spent = f.enabled === false
    || bounces > (f.maxBounces ?? 5)
    || back < (f.bounceMin ?? 2);
  vel.y = spent ? 0 : back;
  if (spent) resting = true;

  // How hard, as a fraction of the fastest this body could have been going. The
  // one number every kick below is scaled by.
  const hard = Math.min(1.5, impactSpeed / Math.max(1, (c.sinkSpeedMax ?? 20) * sinkScale));
  const kick = spent ? 0.3 : 1;

  // THE SKID. Along whatever way it was already drifting, so the body scoots
  // rather than hopping on the spot — and it keeps most of the drift it had, or
  // a contact would read as the sand grabbing it.
  const way = Math.sign(vel.x) || (Math.random() < 0.5 ? -1 : 1);
  vel.x = vel.x * 0.6 + way * impactSpeed * (f.skid ?? 0.45) * kick;

  // THE TUMBLE, alternating, so the body rocks over its contacts instead of
  // winding up in one direction like a wheel.
  const turn = bounces % 2 ? 1 : -1;
  spin += turn * (f.spinKick ?? 3.2) * hard * kick;
  roll += turn * (f.rollKick ?? 2.4) * hard * kick;

  // THE LIMBS. The floor pushing back up through them — the tail through the
  // aim rig's own spring, which is the one chain that keeps solving through the
  // dive, and everything else through the chains the ragdoll woke. Both are
  // silent no-ops on a body that has no rig, so neither needs a guard.
  _tailDir.set(0, 1, 0);
  player.aimRig?.tailImpulse(_tailDir, (f.tailKick ?? 7) * (0.6 + hard));
  if (limpState === 'live') {
    _blow.set(0, 1, 0);
    player.anim?.impulse?.(_blow, (f.limbKick ?? 7) * (0.6 + hard), f.tipBias ?? 0.5);
  }

  // AND THE FX, EVERY TIME. The first contact is the body ARRIVING and keeps
  // the event it always had; the rest are it failing to stay put, and get their
  // own lighter one — pitched up and shortened a little further on each, so a
  // run of them reads as one thing losing energy rather than as four thuds.
  const at = {
    x: player.mesh.position.x,
    y: player.mesh.position.y,
    scale: Math.min(1.6, 0.5 + impactSpeed / Math.max(1, c.sinkSpeedMax ?? 20)),
  };
  if (first) {
    feedback('seabedImpact', at);
  } else {
    at.scale *= decay;
    at.sfxOpts = { pitch: 1 + 0.12 * (bounces - 1), decayMul: decay };
    feedback('seabedBounce', at);
  }
}

/**
 * THE SKELETON, on a clock of its own.
 *
 * Three things, in order: cut the chains loose once the delay is up, feed them
 * gravity and the water going past, and advance the controller. That last call
 * is normally main.js's — it hands it over for the length of the dive (see the
 * note beside it), because the mix between the wall clock and the water's is
 * the whole reason this exists and main.js has only one of the two.
 *
 * At CONFIG.death.slowMo the water runs at a ninth of real time, and a chain
 * solved on that clock has barely moved by the time the body is on the seabed —
 * the ragdoll would be perfect, and absent from every death anyone watched.
 * Straight wall-clock is the other failure: limbs whipping at full speed under
 * a body falling in slow motion. `flop.clock` is the mix, and the same argument
 * is spelled out at length in systems/bossRagdoll.js.
 *
 * @param rawDt     wall seconds.
 * @param dilatedDt the water's seconds.
 */
function updateRagdoll(rawDt, dilatedDt) {
  const anim = player.anim;
  if (!anim) return;
  const f = flop();
  const mix = Math.max(0, Math.min(1, f.clock ?? 0.75));
  const rdt = dilatedDt + (rawDt - dilatedDt) * mix;

  if (limpState === 'waiting' && f.enabled !== false && elapsed >= (f.limpDelay ?? 0.45)) {
    // setLimp freezes the pose the seal is holding RIGHT NOW as the only thing
    // its springs are pulled back toward, and stops the mixer. The delay is so
    // that pose is the death clip's slump rather than the stroke it was
    // mid-way through when it was killed.
    //
    // It returns false for a body with no chains to go limp with — which is
    // every model that isn't the seal, and the seal itself in any headless
    // harness, where no GLB is ever loaded. Recorded rather than retried: the
    // dive still runs, it simply has no skeleton in it.
    limpState = anim.setLimp?.(limpSpring()) ? 'live' : 'none';
    if (limpState === 'live') {
      // The blow that killed it, into the chains, along the way the body is
      // travelling — one shove, on the frame they come loose.
      const sp = vel.length();
      if (sp > 1e-3) {
        _blow.set(vel.x / sp, vel.y / sp, 0);
        anim.impulse(_blow, f.blow ?? 9, f.tipBias ?? 0.5);
      }
    }
  }

  if (limpState === 'live') {
    // GRAVITY, every frame, as an impulse rather than as a force in the solver:
    // the spring only knows about velocities, and this is the whole of what a
    // hanging chain needs. Tips first — a chain that sags evenly reads as a
    // banana and one that sags hardest at the far end reads as weight.
    anim.impulse(DOWN, (f.sag ?? 16) * rdt, f.sagBias ?? 0.3);
    // ...and the water going past, which is what makes the limbs stream while
    // the body is falling and let go when it stops. The strength IS the body's
    // speed, so this costs nothing to switch off — it does that itself.
    const sp = vel.length();
    if (sp > 0.05) {
      _flow.set(-vel.x / sp, -vel.y / sp, 0);
      anim.impulse(_flow, (f.flow ?? 1.4) * sp * rdt, f.tipBias ?? 0.5);
    }
  }

  // State and hit are ignored while limp — see setLimp in systems/animation.js.
  // Before it goes limp this is what advances the death clip, which is the same
  // call main.js was making, with the same state.
  anim.update(rdt, stateForSpeed(0, player.aboveSurface), false);
}

/**
 * Start the glide back to normal, and call `onReady` when it's finished — that
 * callback is what actually starts the next run.
 *
 * Everything bent by the death unwinds over CONFIG.death.restart.time: the
 * clock back to full speed, the music and one-shot playback rates back to
 * pitch, the SFX bus swept back open from however muffled the body's last
 * depth left it, and the lens back out to the wide arena view. The screen is
 * covered while this happens (see ui.js showRestartTransition).
 *
 * @returns true if a transition was started. False means there was nothing
 *          dilated to come back from — `onReady` has already been called, and
 *          the caller should not wait for anything.
 */
export function beginRestartTransition(onReady) {
  if (!deathState.active) {
    onReady?.();
    return false;
  }
  const c = cfg();
  deathState.phase = 'restart';
  restartClock = 0;
  restartFrom = {
    scale: deathState.timeScale,
    zoom: deathState.camZoom,
    weight: deathState.camWeight,
  };
  onFinish = onReady ?? null;
  // One sweep set going here rather than re-targeted every frame: the filter
  // gets its own exponential glide in the audio graph, which is smoother than
  // anything driven off a frame delta and doesn't care if the frame rate
  // stutters on the way into a new run.
  openBusFilter((c.restart?.time ?? 0.9) * (c.restart?.filterGlide ?? 0.33));
  return true;
}

// Back to a live clock and a live mix. Called from startGame, so a run that's
// restarted from the score screen doesn't inherit the last one's dilation.
export function resetDeathDive() {
  // THE SKELETON GOES BACK FIRST. The controller is reused across runs, and a
  // body left limp would ignore the mixer for the whole of the next one — the
  // same leak systems/bossRagdoll.js guards against on a pooled boss. Handing it
  // back also puts the `asleep` chains (FLOP_ROLE) back to sleep, so the next
  // seal swims with the flippers it has always had.
  player.anim?.setLimp?.(null);
  deathState.active = false;
  deathState.phase = 'none';
  deathState.elapsed = 0;
  deathState.timeScale = 1;
  deathState.camZoom = 1;
  deathState.camWeight = 0;
  vel.set(0, 0);
  spin = 0;
  roll = 0;
  sinkScale = 1;
  elapsed = 0;
  settleClock = 0;
  swayClock = 0;
  restartClock = 0;
  onFinish = null;
  musicReleased = false;
  bounces = 0;
  resting = false;
  bounceClock = 0;
  limpState = 'waiting';
  flopClock = 0;
  lollPrev = 0;
  setMusicRateScale(1, 0);
  setSfxRateScale(1);
  setAmbientRateScale(1, 0);
}
