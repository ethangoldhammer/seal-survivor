import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';
import { emit } from '../entities/particles.js';
import { createRig, runRibbon, clearRig, rigStats } from './ribbonTrail.js';
import { ballCredit, teamColor } from './ballLook.js';

// ============================================================================
// THE BALL TRAIL — what the Blubberball drags behind it, in the two colours
// that are fighting over it.
//
// IT IS THE SEAL'S TRAIL. systems/ribbonTrail.js is the engine and this file is
// a second caller of it beside systems/breachTrail.js: the same particle spine,
// the same divergence-free turbulence, the same centripetal spline, the same
// shaded cross-section, the same two profiles for above and below the water
// line. Read the header of breachTrail.js first; everything it says about how a
// trail is built is true here.
//
// WHAT IS THE BALL'S OWN, and it is only these three things:
//
//   THE COLOURS ARE THE POSSESSION. The seal's air trail splits into pure
//   R/G/B — a photograph of a highlight too bright for a sensor. The ball
//   splits into the TWO TEAM COLOURS, and how the split is weighted is the
//   ledger in systems/ballLook.js: the same `share` that decides how much of
//   the body each colour has taken decides how much of the trail it has. A ball
//   somebody has just hammered upfield draws a trail almost entirely in their
//   colour with the other one a thin fringe thrown clear of it; a ball being
//   fought over draws an even two-colour split. Nothing here decides anything
//   about possession — it reads the ledger and describes it.
//
//   IT COMES OFF THE TRAILING EDGE. A seal has two hind flippers and sheds off
//   both. A ball has no flippers, so the shed points are placed astern of the
//   heading, on the drawn edge — one or two of them (`sources`), thrown apart
//   by `shoulder`. Two is the default because two clouds braiding around each
//   other read as a ball turning over, which is what the thing is doing.
//
//   IT BUBBLES UNDERWATER. The swim trail is a filament, and a filament alone
//   is a thin thing for an object with that much mass to leave. So the water
//   profile also sheds bubbles from the same two points at the same drive —
//   the `ballWake` emitter, tinted toward whoever owns the ball.
//
// WHY NOT A THIRD PROFILE INSIDE breachTrail.js. Its two profiles are one
// animal above and below the line; a ball is a different body with a different
// gate, a different shed point and a colour that changes hands. Folding it in
// would mean every seal knob growing an "unless it is the ball" clause. The
// engine is the shared thing, and it is shared properly.
// ============================================================================

const profiles = {
  air: createRig('air', 'ballTrailAir'),
  water: createRig('water', 'ballTrailWater'),
};
const PROFILE_LIST = [profiles.air, profiles.water];

// The water profile's numbers, rebuilt in place each frame — the air block with
// `trail.water` laid over it, exactly as the swim trail is assembled over the
// breach trail. Live rather than cached, because every value in it is a slider
// in the ball lab and a cache would freeze the water trail at load.
const _water = {};

function cfg(key = 'air') {
  const base = CONFIG.versus?.ball?.trail ?? {};
  if (key !== 'water') return base;
  return Object.assign(_water, base, base.water ?? {});
}

// The resolved settings handed to the engine: the profile block with this
// frame's colours, leans and gains written over it. A COPY per profile, never
// the CONFIG block itself — writing `colors` onto CONFIG would put whichever
// team last held the ball into the tuning file.
const _resolved = { air: {}, water: {} };

// Where the shed points are this frame. Two point objects and the two lists
// that can be handed to the engine, all preallocated — a frame of trail
// allocates nothing, and a `slice` here would allocate one array per profile
// per frame for the life of a match.
const _pt = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
const _sourceLists = [[_pt[0]], [_pt[0], _pt[1]]];
// The last heading worth having. A ball at rest has no direction of travel, and
// falling back to +x would swing every shed point to the same side of the body
// the moment it stopped rolling.
let dirX = 1;
let dirY = 0;

const _tint = new THREE.Color();
const _teamCol = new THREE.Color();

/**
 * THE SPLIT, as this frame's ledger describes it.
 *
 * Returns the channel list and the two weightings the engine takes:
 *
 *   colors        one entry per ribbon. TWO while somebody owns the ball, ONE
 *                 (the ball's own colour) before anyone has touched it — and
 *                 that single case needs no special handling downstream,
 *                 because the engine reads its channel count off this list and
 *                 the split arithmetic collapses to zero on its own.
 *   channelLean   where each colour sits across the band, in the units the
 *                 engine's symmetric default uses (±0.5 for two). The dominant
 *                 colour is pulled toward the spine and the losing one is
 *                 thrown clear, so the trail says who is winning by WHERE the
 *                 colours are as well as by how bright they are.
 *   channelGain   ...and how bright. Dominance times `splitBias`, centred so
 *                 that a 50/50 ball draws both channels at exactly 1 and the
 *                 whole mechanism is invisible until somebody is winning.
 *
 * `share` is the SMOOTHED march out of systems/ballLook.js rather than the raw
 * credit, deliberately: it is the same number the body's own two-colour field
 * is using this frame, so the trail and the ball it comes off agree about who
 * has it. Reading the credit directly would make the trail jump on the frame of
 * a touch while the body was still crossfading.
 */
const _split = { colors: [0xffffff], channelLean: [0, 0], channelGain: [1, 1] };

function splitFor(c) {
  const led = ballCredit();
  if (led.newest < 0) {
    // Nobody has touched it. One ribbon, in the ball's own colour — see the
    // swim trail, which is the same idea for the same reason.
    _split.colors.length = 1;
    _split.colors[0] = CONFIG.versus?.ball?.look?.color ?? 0xffd166;
    _split.channelLean.length = 1;
    _split.channelLean[0] = 0;
    _split.channelGain.length = 1;
    _split.channelGain[0] = 1;
    return _split;
  }
  const other = led.newest === 1 ? 0 : 1;
  const wB = Math.max(0, Math.min(1, led.share));
  const wA = 1 - wB;
  const throwBy = Math.max(0, c.splitThrow ?? 1);
  const bias = Math.max(0, c.splitBias ?? 0.6);

  _split.colors.length = 2;
  _split.colors[0] = teamColor(other);
  _split.colors[1] = teamColor(led.newest);
  _split.channelLean.length = 2;
  // ±0.5 at parity — the engine's own symmetric spacing — opening to the full
  // width for a colour that has been beaten back to nothing.
  _split.channelLean[0] = -(0.5 + throwBy * (0.5 - wA));
  _split.channelLean[1] = 0.5 + throwBy * (0.5 - wB);
  _split.channelGain.length = 2;
  _split.channelGain[0] = Math.max(0, 1 + bias * (2 * wA - 1));
  _split.channelGain[1] = Math.max(0, 1 + bias * (2 * wB - 1));
  return _split;
}

/** The profile block plus this frame's split, in a copy CONFIG never sees. */
function resolve(key, c, split) {
  const o = Object.assign(_resolved[key], c);
  o.colors = split.colors;
  o.channelLean = split.channelLean;
  o.channelGain = split.channelGain;
  return o;
}

/**
 * WHERE IT SHEDS FROM: astern, on the drawn edge.
 *
 * `radiusAt` is the ball's own hit radius toward a world angle — the DRAWN
 * edge, which on a dented or stretched ball is not a circle. Passing it in
 * rather than reading a radius off the ball keeps the trail on the skin a
 * player can see, exactly as the goo splats and the hitbox are (ballShape.js).
 * Without one, `r` is used as a plain radius.
 */
function shedPoints(ball, c, radiusAt) {
  const n = Math.max(1, Math.min(2, Math.round(c.sources ?? 2)));
  const back = Math.atan2(-dirY, -dirX);
  const half = n > 1 ? (c.shoulder ?? 0.5) : 0;
  const at = Math.max(0, c.atRadius ?? 0.9);
  for (let i = 0; i < n; i++) {
    const a = back + (n > 1 ? (i === 0 ? -half : half) : 0);
    const r = (radiusAt ? radiusAt(a) : (ball.r ?? 2.4)) * at;
    _pt[i].x = ball.x + Math.cos(a) * r;
    _pt[i].y = ball.y + Math.sin(a) * r;
  }
  return _sourceLists[n - 1];
}

/**
 * THE BUBBLES — the water profile's second half.
 *
 * Shed from the same points at the same drive, so they belong to the trail
 * rather than sitting beside it, and thrown ASTERN (`dirX/dirY` is the emitter
 * cone's axis) so they leave the ball instead of climbing through it. The
 * ball's own velocity is passed for the emitter's inherit term.
 *
 * TINTED FROM THE CALL SITE, like a death burst and for the same reason: which
 * team is dragging the ball is the information, so it is what the colour should
 * carry. `tint` is a MIX rather than a replacement — at 1 the bubbles are pure
 * team colour, which reads as coloured water; a little of it is enough to say
 * whose ball it is while they stay bubbles.
 */
let bubbleDebt = 0;
// How many bursts have been shed since the last clear. For the harness and the
// lab readout — `emit` is a no-op with no particle system initialised, which is
// exactly the case a Node harness runs in, so counting the CALL is the only way
// to prove the bubbles are being asked for at all.
let bubblesFired = 0;

function shedBubbles(dt, sources, ball, c, drive, split) {
  const b = c.bubbles ?? {};
  if (b.enabled === false || !(drive > 0)) { bubbleDebt = 0; return; }
  bubbleDebt += (b.perSecond ?? 14) * drive * dt;
  let n = Math.floor(bubbleDebt);
  if (n <= 0) return;
  bubbleDebt -= n;
  n = Math.min(n, 6);

  const mix = Math.max(0, Math.min(1, b.tint ?? 0));
  let color = null;
  if (mix > 0 && split.colors.length > 1) {
    // The DOMINANT colour, not an average of the two: an average of green and
    // red is grey, which is the one thing a possession tint must not be.
    const lead = split.channelGain[1] >= split.channelGain[0] ? 1 : 0;
    _teamCol.set(split.colors[lead]);
    color = _tint.set(b.color ?? 0xdff6ff).lerp(_teamCol, mix).getHex();
  }
  for (let i = 0; i < n; i++) {
    // ALTERNATING ON THE RUNNING TOTAL, not on `i`. The debt counter hands back
    // one burst on most frames, so an index into this frame's batch is 0 nearly
    // every time and every bubble in a match comes off the same shoulder — a
    // wake down one side of the ball, which reads as a fault in the body rather
    // than as bubbles.
    const s = sources[bubblesFired % sources.length];
    bubblesFired++;
    emit(b.emitter ?? 'ballWake', s.x, s.y, {
      dirX: -dirX,
      dirY: -dirY,
      vx: ball.vx ?? 0,
      vy: ball.vy ?? 0,
      scale: b.scale ?? 1,
      sizeMul: b.sizeMul ?? 1,
      speedMul: b.speedMul ?? 1,
      color,
    });
  }
}

/**
 * One frame of the ball's trail.
 *
 * @param dt      REAL seconds. The goal shutter drops the world to a near stop
 *                with the camera punched in on the ball, and a cloud that froze
 *                with it would read as the effect having broken at exactly the
 *                moment it is most looked at — the same argument that puts
 *                updateBallLook on the wall clock (see updateVersusClock).
 * @param scene   where the ribbons hang. The WORLD scene: the trail comes out
 *                from under a goo body and belongs behind it.
 * @param ball    { x, y, vx, vy, r, live } — the match's ball, the lab's ball,
 *                or anything shaped like one.
 * @param opts    radiusAt  the drawn edge toward a world angle (ballHitRadiusAt)
 *                emitting  whether new particles may be laid down at all. The
 *                          cloud drifts and dies regardless.
 */
export function updateBallTrail(dt, scene, ball, opts = {}) {
  const base = CONFIG.versus?.ball?.trail ?? {};
  // A harness with no scene at all still calls this through updateVersusClock.
  // Bailing here rather than letting the engine try to hang a root off null:
  // the failure would be a crash in a test that has nothing to do with trails.
  if (!scene) return;
  if (base.enabled === false) {
    if (profiles.air.root || profiles.water.root) clearBallTrail(scene);
    return;
  }
  const emitting = opts.emitting !== false && ball.live !== false;
  const vx = ball.vx ?? 0;
  const vy = ball.vy ?? 0;
  const speed = Math.hypot(vx, vy);
  // Held from the last frame that had one — see dirX above.
  if (speed > 1e-3) { dirX = vx / speed; dirY = vy / speed; }

  const airborne = ball.y > bounds.surfaceY;
  const split = splitFor(base);

  // ONE RAMP FOR BOTH PROFILES, and it is the ball's speed. The seal's air
  // trail runs flat out for every airborne frame because being airborne is
  // already earned; a ball is in the air whenever somebody lobbed it, including
  // gently, so the air trail is ramped the same way the water one is. What
  // separates the two is what they LOOK like, which is the profile's job.
  const a = cfg('air');
  const w = cfg('water');
  const c = airborne ? a : w;
  const minSpeed = Math.max(0, c.minSpeed ?? 6);
  const full = Math.max(minSpeed + 0.01, c.fullSpeed ?? CONFIG.versus?.ball?.maxSpeed ?? 64);
  const drive = Math.min(1, Math.max(0, (speed - minSpeed) / (full - minSpeed)));

  const sources = shedPoints(ball, c, opts.radiusAt);

  runRibbon(profiles.air, dt, scene, sources, resolve('air', a, split), {
    active: a.enabled !== false && airborne && ball.live !== false && speed >= minSpeed,
    emitting,
    rate: drive,
    nodeRamp: drive,
    vx,
    vy,
  });
  runRibbon(profiles.water, dt, scene, sources, resolve('water', w, split), {
    // NOT `!airborne` alone: a ball rolling to a stop has to close its strand,
    // or the next strike is joined to this one by a ribbon drawn straight
    // across the pitch.
    active: w.enabled !== false && !airborne && ball.live !== false && speed >= minSpeed,
    emitting,
    rate: drive,
    nodeRamp: drive,
    vx,
    vy,
  });

  if (!airborne && emitting) shedBubbles(dt, sources, ball, w, drive, split);
  else bubbleDebt = 0;
}

/** Tear both trails down — kickoff, a goal, the end of a match, the lab's R. */
export function clearBallTrail(scene) {
  for (const profile of PROFILE_LIST) clearRig(profile, scene);
  bubbleDebt = 0;
  bubblesFired = 0;
  dirX = 1;
  dirY = 0;
}

/** For the harness and the lab: what one profile's cloud is doing. */
export function ballTrailStats(key = 'water') {
  const r = rigStats(profiles[key] ?? profiles.water);
  r.bubbles = bubblesFired;
  return r;
}

/** For the harness: this frame's resolved split, without drawing anything. */
export function ballTrailSplit() {
  const s = splitFor(cfg('air'));
  return {
    colors: [...s.colors],
    lean: [...s.channelLean],
    gain: [...s.channelGain],
  };
}
