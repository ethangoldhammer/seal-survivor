// ---------------------------------------------------------------------------
// VERSUS — two seals push a ball into each other's goal.
//
// Reached from Seal sports on the main menu (systems/versusFlag.js is the
// flag main.js's `enterMode` sets, and the reason it is a flag and not a
// CONFIG override). Everything the mode is
// lives here: the second seal and its gamepad, the ball and its soft body,
// the goals, the score and the shutter that follows a goal.
//
// TWO SEALS, ONE BODY OF CODE. Player 1 is the ordinary player — the real
// `player`, the real strikeState, the real ring. Player 2 is the SAME animal
// run through the SAME functions: entities/player.js's updatePlayer, poseBody
// and updateAimRig take the seal as a trailing argument, systems/strike.js's
// updateCharge / tryStrike / updateStrike / cancelDash take the strike state,
// and systems/strikeRing.js hands out a second ring instance. So player 2 has
// the same thrust, ceiling, mid-dash steering and follow-through, the same
// wind-up, sweet spot, perfect charge and verdict, the same facing, mirror
// roll, barrel roll, crane and tremble, the same clip state machine, breath,
// jaw and aim rig, and the same circle HUD — because it is literally the same
// code reading a second state. `p2` below is that state: createSealState()
// plus createStrikeState() plus a pad, with getters for the names the rest of
// this file, the bot and the harness address it by. A retune of either seal
// is a retune of both, by construction.
//
// THE BALL IS A SOFT BODY, faked. `points` rim samples each carry a radial
// offset and a radial velocity; every frame each one is pulled back to rest
// by a spring, damped, and coupled to its two neighbours, so a dent put in at
// one angle runs round the rim in both directions and rings down. The mean
// offset is removed each frame, which is the cheapest volume rule there is:
// pushing one side in bulges the far side out. The centre of mass is a plain
// circle of the rest radius for every collision — the rim is a LOOK, and a
// hit box that wobbled would be a hit box that lied.
//
// It draws through the goo pass: a centre splat, an inner ring and the rim
// ring written as DRIVEN particle slots (entities/particles.js) into the
// `ball` group, so the ring fuses into one mass with a soft edge and a dark
// rim, and the composite's own thresholding is what turns 33 circles into a
// blob. Positions are world XY, the same as the seal's. The group's surface
// is CONFIG.fx.goo.groups.ball; the size of the ball is CONFIG.versus.ball
// (radius, and look.*Size for the splats) — never the group's radius or iso,
// which describe how the splats relate to each other, not how big they are.
//
// THE GOALS ARE HOLES IN THE ROCK. systems/versusGoal.js is the geometry —
// a band of each wall, goalY ± halfHeight, opened into a tunnel — and it is
// read by three things that must agree: wallRocks.js carves the shore to it,
// arena.clampToArena lets a seal into it, and stepBall below bounces the
// ball off its lips and posts. A goal is called only once the ball is CLEAR
// OF THE EDGE OF THE SCREEN (the furthest the camera can ever reach past the
// wall, see screenEdgeX), so the ball is seen to go all the way in and a
// ball rattling in the entrance is still in play.
//
// THE GOAL'S SHUTTER, on the wall clock. The ball crosses the line → the
// world drops to `freezeScale` for `freeze` seconds while the new score pops
// huge at centre screen → ramps back to full speed → and at `respawn` the
// match goes to a KICKOFF: the number flies up to its slot in the HUD, both
// seals are put back at their own ends with a full wheel, the ball is at
// centre, bait fish are dropped in each seal's way, and a countdown runs on
// the wall clock with the water frozen under it. The whistle releases the
// world in one frame. A match opens the same way. `updateVersusClock(rawDt)`
// owns all of that and returns the scale main.js multiplies into realDt
// beside the death dive's and the kill shot's.
//
// COPY. The end state's line is `versusWinner` and the whistle's is
// `versusGo`, both in uiText.csv, staged as [DRAFT] — the score and the
// countdown are numerals, which are not prose.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds, midWater, clampToArena } from '../arena.js';
import { createVisual } from '../assets.js';
import { playCelebration } from './celebrate.js';
import {
  player, snarePlayer, updatePlayer, createSealState, buildSealBody, disposeSealBody, resetSealBody,
} from '../entities/player.js';
import {
  strikeState, restoreCharge, addCharge, pipValue, cancelDash, strikeEnglish,
  createStrikeState, resetStrike, updateCharge, tryStrike, updateStrike, strikeDirection, perfectCrossed,
} from './strike.js';
import { createStrikeRingInstance } from './strikeRing.js';
import { initBallSpin, disposeBallSpin, updateBallSpin, renderBallSpin } from './ballSpin.js';
import { overlayScene } from './post.js';
import { gulpPickups, bubbleOrbs, spawnBubbleOrb } from '../entities/pickups.js';
import { bubbleBirthPoint } from './oxygenBubble.js';
import { applyPlayerKnockback } from '../entities/player.js';
import { spawnBaitBall, devBaitBallSpec, enemies, removeEnemy } from '../entities/enemies.js';
import { baitBalls } from './baitBall.js';
import {
  claimDriven, releaseDriven, writeDriven, flushDriven, gooGroupIndex, keepGooAlive,
} from '../entities/particles.js';
import { feedback } from './feedback.js';
import { uiText } from '../uiTextTable.js';
import { pollPads } from '../ui/padPoll.js';
import { versusActive, captainPad } from './versusFlag.js';
import { updateBot, botWanted, botState, resetBot } from './versusBot.js';
import { features, actions, recordImitation, flushImitation, resetImitation, imitationState } from './imitation.js';
import { goalColors, ballEvent, setBallDrive, updateBallLook, resetBallLook, ballLookState, ballTint } from './ballLook.js';
import { fireGoalJet, resetGoalJets } from './goalJet.js';
import {
  installGoalHoles, nearestOnBlocks, tunnelDepth, screenEdgeX, rockX, mouthY, mouthHalfHeight,
} from './versusGoal.js';
import { shoreOverscan } from './wallRocks.js';

export { versusActive, enableVersus } from './versusFlag.js';

const cfg = () => CONFIG.versus ?? {};
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------

export const versusState = {
  active: false,          // a versus run is live (set by startVersus)
  scores: [0, 0],         // [P1, P2] — P1 defends the LEFT goal and scores in the right
  phase: 'play',          // 'kickoff' | 'play' | 'scored' | 'won' | 'over'
  phaseT: 0,              // wall seconds into the phase
  count: 0,               // the countdown numeral showing, 0 once the whistle has gone
  kickoffs: 0,            // how many kickoffs this session, for the harness
  goT: 0,                 // wall seconds the whistle's line has left on screen
  lastPost: null,         // { side, nx, ny, x, y } of the last post/lip hit, for the harness
  lastImpact: null,       // the payload of the ball's last impact event, for the harness
  clock: 0,               // gameplay seconds this match, for the impact fx gaps
  scorer: -1,             // who scored the goal the shutter is showing
  timeScale: 1,           // what updateVersusClock last returned
  flown: false,           // the big number has left for the HUD this phase
  respawned: false,       // the ball is back for this phase
  chumTimer: 0,
  regenT: [0, 0],         // seconds until each seal's next free pip
  bubbleT: 0,             // seconds until the next bubble
  checked: [false, false], // this dash of seal i has already body-checked
  dead: [0, 0],           // seconds until seal i respawns; 0 = alive
  invuln: [0, 0],         // seconds of grace after a respawn
  bursts: 0,              // how many seals have burst this session, for the harness
  goals: 0,               // total goals this session, for the harness
  lastGoal: null,         // { side, scorer, x, y } of the last goal
  lastPierce: null,       // the ball's last contest win over a seal, for the harness
  lastCollide: null,      // the seals' last meeting, for the harness
  touching: false,        // the seals are pressed together (sealCollide)
};

// The ball. `rim`/`rimV` are the soft body; x/y/vx/vy the rigid circle.
// `spin` is rad/s about the view axis and `angle` is where that spin has
// carried the rim to — the rim's samples live in the BALL'S frame, so a dent
// put in at the front rides round as the ball turns, which is what makes the
// spin readable at all. The surface has no other marking.
export const ball = {
  live: false,
  x: 0, y: 0, vx: 0, vy: 0,
  spin: 0, angle: 0,
  r: 2.4,
  rim: new Float32Array(0),
  rimV: new Float32Array(0),
  // one flag per seal: a single dash shoves the ball once, like hitThisDash
  dashHit: [false, false],
  // one per seal: the ball has won the contest against this seal and is
  // going through it — no second knock until they have come apart
  pierced: [false, false],
  slots: [],              // driven particle slots
  group: 0,
};

// PLAYER 2 — the same seal as player 1, as a second state. createSealState()
// is the per-body half of `player` (entities/player.js); `strike` is its own
// strike state; `ring` its own circle HUD; `input` the shape input.js fills
// for player 1, filled here from the second pad or the bot. The getters are
// the vocabulary the rest of this file, the bot, the imitation logger and the
// harness already speak (pos, vel, charge, active, power...) — one object,
// two names for each thing, and the strike-state ones write through.
export const p2 = createSealState();
p2.strike = createStrikeState();
p2.ring = null;
p2.input = {
  move: new THREE.Vector2(), aim: new THREE.Vector2(1, 0), aimLive: false,
  strike: false, strikeHeld: false, strikeRelease: false, connected: false,
};
p2.heldPrev = false;
p2.pressPrev = false;
p2.hapticT = 0;
const _p2Parked = new THREE.Vector3();
Object.defineProperties(p2, {
  // The run's stats — the same block player 1 swims on. No upgrades in a match.
  stats: { get: () => player.stats, set() {} },
  pos: { get: () => (p2.mesh ? p2.mesh.position : _p2Parked) },
  vel: { get: () => p2.velocity },
  root: { get: () => p2.mesh },
  visual: { get: () => p2.body },
  culled: { get: () => p2.strike.hits },
  charge: { get: () => p2.strike.charge, set: (v) => { p2.strike.charge = v; } },
  pending: { get: () => p2.strike.pending, set: (v) => { p2.strike.pending = v; } },
  charging: { get: () => p2.strike.charging, set: (v) => { p2.strike.charging = v; } },
  active: { get: () => p2.strike.active, set: (v) => { p2.strike.active = v; } },
  power: { get: () => p2.strike.power, set: (v) => { p2.strike.power = v; } },
  english: { get: () => p2.strike.english, set: (v) => { p2.strike.english = v; } },
  dashDir: { get: () => p2.strike.dashDir, set: (v) => { p2.strike.dashDir = v; } },
  dashTimeLeft: { get: () => p2.strike.dashTimeLeft, set: (v) => { p2.strike.dashTimeLeft = v; } },
  dashDuration: { get: () => p2.strike.dashDuration, set: (v) => { p2.strike.dashDuration = v; } },
});

let scene = null;
// What main.js lends the match: the run's own kill path, so a fish player 2
// dashes through dies exactly as one player 1 dashes through does — the
// ledger, the feedback and the chum orb all come from there. Null in a
// harness, where the fish simply leaves the list.
// `onMainMenu` is the prompt's second button — main.js's route off a match and
// back to the bust, the same one the score card uses.
export const versusHooks = { onKill: null, onMainMenu: null };
const markers = [];
const _dir = { x: 0, y: 0 };
const _rgb = new THREE.Color();

// ---------------------------------------------------------------------------
// LIFECYCLE
// ---------------------------------------------------------------------------

export function startVersus(worldScene) {
  scene = worldScene;
  // The streaks draw OVER the goo, so they live in the post chain's overlay
  // scene and not in the world — see overlayScene in systems/post.js.
  initBallSpin(overlayScene);
  versusState.active = true;
  versusState.scores[0] = 0;
  versusState.scores[1] = 0;
  versusState.phase = 'play';
  versusState.phaseT = 0;
  versusState.scorer = -1;
  versusState.timeScale = 1;
  versusState.flown = false;
  versusState.respawned = false;
  versusState.chumTimer = 0;
  versusState.goals = 0;
  versusState.lastGoal = null;
  versusState.count = 0;
  versusState.kickoffs = 0;
  versusState.goT = 0;
  versusState.lastPost = null;
  versusState.lastImpact = null;
  versusState.lastPierce = null;
  versusState.lastCollide = null;
  versusState.touching = false;
  versusState.clock = 0;
  fxLast.clear();
  camState.seeded = false;
  versusState.regenT[0] = versusState.regenT[1] = cfg().regen?.pipEvery ?? 3;
  versusState.bubbleT = 0;
  versusState.checked[0] = versusState.checked[1] = false;
  versusState.dead[0] = versusState.dead[1] = 0;
  versusState.invuln[0] = versusState.invuln[1] = 0;
  resetBot();
  resetImitation();

  const c = cfg();
  const half = (bounds.right - bounds.left) * 0.5;
  const side = half * (c.spawnSide ?? 0.25);
  const y = midWater();

  // P1 to the left half, facing in. Both meters open FULL: the bar normally
  // opens dead and is filled by food, but a match that starts with two seals
  // unable to strike is a match that starts with nothing happening.
  if (player.mesh) {
    player.mesh.position.set(-side, y, 0);
    player.velocity.set(0, 0);
  }
  restoreCharge(player.stats);

  buildP2(side, y);
  buildBall();
  // The mouths, for the seals: arena.clampToArena reads them from here on.
  installGoalHoles(true);
  mountUi();
  resetBall();
  enterKickoff();
}

export function resetVersus() {
  if (!versusState.active && !ball.slots.length && !p2.root) return;
  flushImitation('reset');
  versusState.active = false;
  versusState.phase = 'play';
  versusState.timeScale = 1;
  resetBallLook();
  resetGoalJets();
  disposeBallSpin();
  for (const s of ball.slots) releaseDriven(s);
  ball.slots.length = 0;
  ball.live = false;
  if (p2.ring) { scene?.remove(p2.ring.mesh); p2.ring.dispose(); p2.ring = null; }
  disposeSealBody(p2, scene);
  installGoalHoles(false);
  for (const m of markers) scene?.remove(m);
  markers.length = 0;
  hideUi();
}

function buildP2(side, y) {
  // The body, exactly as initPlayer builds player 1's (less the outline —
  // see buildSealBody), its own strike state and its own ring.
  buildSealBody(p2, scene, { name: 'player2', celebrateTag: 'p2' });
  resetSealBody(p2);
  resetStrike(p2.strike);
  p2.mesh.position.set(side, y, 0);
  p2.mesh.rotation.z = Math.PI / 2; // facing in: the art's forward is +Y, a quarter turn from -x
  p2.strike.charge = 1;
  p2.hp = player.stats?.maxHp ?? p2.hp;
  p2.oxygen = Math.max(1, player.stats?.maxOxygen ?? CONFIG.oxygen?.max ?? 100);
  p2.input.aim.set(-1, 0);
  p2.input.move.set(0, 0);
  p2.input.aimLive = false;
  p2.input.strike = false;
  p2.input.strikeHeld = false;
  p2.input.strikeRelease = false;
  p2.heldPrev = false;
  p2.pressPrev = false;
  p2.hapticT = 0;
  p2.ring = createStrikeRingInstance();
  scene.add(p2.ring.mesh);

  // A ring under each seal in that seal's goal colour — the two rigs are the
  // same animal and the water is wide.
  const colors = goalColors();
  for (let i = 0; i < 2; i++) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(2.7, 3.1, 40),
      new THREE.MeshBasicMaterial({ color: colors[i], transparent: true, opacity: 0.55, depthWrite: false }),
    );
    ring.position.z = -2.5;
    ring.renderOrder = 1;
    scene.add(ring);
    markers.push(ring);
  }
}

function buildBall() {
  const c = cfg().ball ?? {};
  const n = Math.max(6, Math.round(c.soft?.points ?? 24));
  ball.r = c.radius ?? 2.4;
  ball.rim = new Float32Array(n);
  ball.rimV = new Float32Array(n);
  // centre + inner ring (a third of the rim's count) + the rim
  const inner = Math.max(4, Math.round(n / 3));
  const want = 1 + inner + n;
  for (const s of ball.slots) releaseDriven(s);
  ball.slots = claimDriven(want);
  ball.group = gooGroupIndex('ball');
}

// ---------------------------------------------------------------------------
// THE BALL
// ---------------------------------------------------------------------------

export function resetBall() {
  ball.x = (bounds.left + bounds.right) * 0.5;
  ball.y = midWater();
  ball.vx = 0;
  ball.vy = 0;
  ball.spin = 0;
  ball.angle = 0;
  ball.rim.fill(0);
  ball.rimV.fill(0);
  ball.dashHit[0] = ball.dashHit[1] = false;
  ball.pierced[0] = ball.pierced[1] = false;
  ball.live = true;
}

/** The world angle of rim sample i, with the ball's turn included. */
export function rimAngle(i) {
  return (i / ball.rim.length) * Math.PI * 2 + ball.angle;
}

/**
 * Push the rim in at `angle` (radians, WORLD, from the ball's centre) by
 * `depth` of the radius, over a gaussian `width` radians wide (the config's
 * dentWidth when omitted).
 */
export function dentBall(angle, depth, width = null) {
  const s = cfg().ball?.soft ?? {};
  const n = ball.rim.length;
  if (!n) return;
  const w0 = width ?? s.dentWidth ?? 0.8;
  const amount = depth * ball.r;
  for (let i = 0; i < n; i++) {
    let d = rimAngle(i) - angle;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const w = Math.exp(-(d * d) / (w0 * w0));
    ball.rim[i] -= amount * w;
    ball.rimV[i] -= amount * 6 * w;
  }
}

/**
 * Flatten the whole body along the axis through `angle`: in on both sides of
 * that axis, out at right angles to it — the cos(2θ) mode, which sums to zero
 * on its own so the volume rule has nothing to correct. What a hard hit does
 * to the ball as a whole, over and above the local dent.
 */
export function squashBall(angle, depth) {
  const n = ball.rim.length;
  if (!n || depth <= 0) return;
  const amount = depth * ball.r;
  for (let i = 0; i < n; i++) {
    const c = Math.cos(2 * (rimAngle(i) - angle));
    ball.rim[i] -= amount * c;
    ball.rimV[i] -= amount * 4 * c;
  }
}

/**
 * A hit on the ball at `contactAngle` (world, the side the striker is on) by
 * something closing at `closing` u/s. Depth and width both follow the speed —
 * a fast hit is a deeper, narrower hole and a flatter ball — see
 * CONFIG.versus.ball.impact.
 */
export function impactDent(contactAngle, baseDepth, closing) {
  const im = cfg().ball?.impact ?? {};
  const s = cfg().ball?.soft ?? {};
  const hard = Math.max(0, Math.min(1.5, closing / Math.max(1, im.speedRef ?? 30)));
  const depth = baseDepth * (1 + (im.dentBySpeed ?? 0.6) * hard);
  const width = (s.dentWidth ?? 0.8) / (1 + (im.narrowBySpeed ?? 0.5) * hard);
  dentBall(contactAngle, depth, width);
  squashBall(contactAngle, depth * (im.squash ?? 0.35));
  return { depth, width, hard };
}

// The rim's own clock. A ripple that crosses a quarter of the rim in a
// quarter second needs a neighbour coupling of several hundred, and explicit
// Euler on that is only stable while dt * sqrt(4 * couple) < 2 — which a
// 60fps frame clears and the 0.05s frame cap does not. So the rim is stepped
// in fixed sub-steps whatever the frame is doing; twenty-four points make it
// nothing.
const SOFT_STEP = 1 / 240;
const _prevRim = new Float32Array(64);

function stepSoftBody(dt) {
  const s = cfg().ball?.soft ?? {};
  const rim = ball.rim;
  const rv = ball.rimV;
  const n = rim.length;
  if (!n) return;
  const spring = s.spring ?? 90;
  const damping = s.damping ?? 4;
  const couple = s.couple ?? 600;
  const cap = (s.maxDeform ?? 0.55) * ball.r;
  const prev = _prevRim.length >= n ? _prevRim : new Float32Array(n);
  let left = dt;
  while (left > 1e-9) {
    const h = Math.min(SOFT_STEP, left);
    left -= h;
    // The neighbour term reads the offsets from the start of the step for
    // every point, so the ripple runs at the same speed in both directions.
    for (let i = 0; i < n; i++) prev[i] = rim[i];
    let mean = 0;
    for (let i = 0; i < n; i++) {
      const l = prev[(i + n - 1) % n];
      const r = prev[(i + 1) % n];
      const a = -spring * prev[i] - damping * rv[i] + couple * (l + r - 2 * prev[i]);
      rv[i] += a * h;
      rim[i] = prev[i] + rv[i] * h;
      mean += rim[i];
    }
    // The volume rule: what goes in on one side comes out everywhere else.
    mean /= n;
    for (let i = 0; i < n; i++) {
      rim[i] -= mean;
      if (rim[i] > cap) { rim[i] = cap; if (rv[i] > 0) rv[i] = 0; }
      else if (rim[i] < -cap) { rim[i] = -cap; if (rv[i] < 0) rv[i] = 0; }
    }
  }
}

/** The rim's drawn radius at sample i, rest + dent + the velocity stretch. */
export function rimRadius(i) {
  const s = cfg().ball?.soft ?? {};
  const a = rimAngle(i);
  const speed = Math.hypot(ball.vx, ball.vy);
  const max = cfg().ball?.maxSpeed ?? 64;
  const phi = speed > 0.01 ? Math.atan2(ball.vy, ball.vx) : 0;
  const stretch = (s.stretch ?? 0.14) * ball.r * Math.min(1, speed / max) * Math.cos(2 * (a - phi));
  return ball.r + ball.rim[i] + stretch;
}

/** The soft body's radius at a WORLD angle, between samples — what a stroke wrapped round the rim sits on. */
export function rimRadiusAt(angle) {
  const n = ball.rim.length;
  if (!n) return ball.r;
  const TAU = Math.PI * 2;
  let u = ((angle - ball.angle) / TAU) * n;
  u = ((u % n) + n) % n;
  const i0 = Math.floor(u);
  const i1 = (i0 + 1) % n;
  const f = u - i0;
  return rimRadius(i0) * (1 - f) + rimRadius(i1) * f;
}

/**
 * The rigid body: gravity above the surface, drag, the speed cap, the
 * Magnus curve off its spin, the walls — and the goals, unless `goals` is
 * off (the lab bounces off every wall instead).
 */
function stepBall(dt, goals = true) {
  const c = cfg().ball ?? {};
  const g = cfg().goal ?? {};
  const im = c.impact ?? {};
  ball.r = c.radius ?? ball.r;
  const airborne = ball.y > bounds.surfaceY;
  if (airborne) {
    // Pulled down HARD out of the water: the world's gravity times the
    // ball's own multiplier. Heavy is a feel, and the feel is the drop.
    if (CONFIG.arena.gravity > 0) ball.vy -= CONFIG.arena.gravity * (c.air?.gravityMul ?? 2.2) * dt;
  } else {
    // A slight lift, only once it is slow — see CONFIG.versus.ball.water.
    const w = c.water ?? {};
    const lift = w.buoyancy ?? 5;
    const below = Math.max(0.01, w.buoyancyBelow ?? 10);
    if (lift) {
      const sp = Math.hypot(ball.vx, ball.vy);
      const share = Math.max(0, 1 - sp / below);
      ball.vy += lift * share * dt;
    }
  }

  // SPIN. It curves the flight (a sideways push proportional to spin x
  // speed, at right angles to the velocity — the Magnus effect, in the only
  // form a 2D ball can show it), turns the rim so the dents ride round, and
  // bleeds off on its own clock.
  //
  // F = S (w x v): the push is at right angles to the flight, proportional
  // to spin and speed both, and it is the WATER doing it — in the air the
  // same spin gets `magnusAir` of the coefficient, and the spin itself
  // bleeds off far slower up there (viscous torque scales with the fluid).
  const spinCap = im.spinMax ?? 18;
  if (Math.abs(ball.spin) > spinCap) ball.spin = Math.sign(ball.spin) * spinCap;
  const magnus = (im.magnus ?? 0.018) * (airborne ? (im.magnusAir ?? 0.15) : 1);
  if (ball.spin && magnus) {
    const ax = -ball.vy * magnus * ball.spin;
    const ay = ball.vx * magnus * ball.spin;
    ball.vx += ax * dt;
    ball.vy += ay * dt;
  }
  ball.angle += ball.spin * dt;
  const decay = airborne ? (im.spinDecayAir ?? 0.12) : (im.spinDecay ?? 0.5);
  ball.spin *= Math.exp(-decay * dt);
  if (Math.abs(ball.spin) < 0.01) ball.spin = 0;

  // The hard cap is the contest's speedCap, above maxSpeed: a volley is
  // allowed to climb past what "fast" means to the looks. See ballSpeedCap.
  const max = ballSpeedCap();
  const speed = Math.hypot(ball.vx, ball.vy);
  if (speed > max) { ball.vx *= max / speed; ball.vy *= max / speed; }
  const drag = airborne ? (CONFIG.arena.airDrag ?? 0.999) : (c.drag ?? 0.994);
  const k = Math.pow(drag, dt * 60);
  ball.vx *= k;
  ball.vy *= k;

  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  const rest = c.restitution ?? 0.85;
  const r = ball.r;

  // Floor and ceiling. The wall's normal points INTO the water.
  if (ball.y < bounds.bottom + r) {
    ball.y = bounds.bottom + r;
    if (ball.vy < 0) { const v = -ball.vy; ball.vy = v * rest; bounce(0, 1, v, rest); }
  } else if (ball.y > bounds.top - r) {
    ball.y = bounds.top - r;
    if (ball.vy > 0) { const v = ball.vy; ball.vy = -v * rest; bounce(0, -1, v, rest); }
  }

  // The side walls. Plain walls in the lab; in a match each has a mouth cut
  // in it, and the ball meets the rock either side of the mouth, its posts
  // and its lips — see collideMouth — before the goal line is asked.
  if (!goals) {
    if (ball.x < bounds.left + r) {
      ball.x = bounds.left + r;
      if (ball.vx < 0) { const v = -ball.vx; ball.vx = v * rest; bounce(1, 0, v, rest); }
    } else if (ball.x > bounds.right - r) {
      ball.x = bounds.right - r;
      if (ball.vx > 0) { const v = ball.vx; ball.vx = -v * rest; bounce(-1, 0, v, rest); }
    }
    return;
  }
  if (ball.x - r < bounds.left) { if (collideMouth(-1, rest)) return; }
  else if (ball.x + r > bounds.right) { if (collideMouth(1, rest)) return; }
}

const _blocks = [{ qx: 0, qy: 0 }, { qx: 0, qy: 0 }];

/**
 * The ball against one wall's two rock blocks, the tunnel's back, and the
 * goal line. Returns true when a goal was called (the ball is dead).
 *
 * Each block is a quarter-plane — solid rock outward of the wall and beyond
 * the lip — and the ball is a circle against its nearest point, which is what
 * makes the mouth's corners POSTS: on the flat of the wall the nearest point
 * is straight across and the normal is (±1, 0), as it always was; on a lip
 * inside the tunnel it is straight up or down; and at the corner it is the
 * corner itself, so the normal runs from the post to the ball's centre and a
 * ball that clips it leaves at an angle. One test, three answers.
 */
function collideMouth(side, rest) {
  const r = ball.r;
  // The drawn face, not the wall's line — see rockX.
  const wallX = rockX(side);
  nearestOnBlocks(side, ball.x, ball.y, _blocks);
  for (const b of _blocks) {
    let dx = ball.x - b.qx;
    let dy = ball.y - b.qy;
    let d = Math.hypot(dx, dy);
    if (d >= r) continue;
    if (d < 1e-6) {
      // The centre is inside the rock (a fast frame through a corner): out
      // along the wall's own normal, into the water.
      dx = -side; dy = 0; d = 1;
    }
    const nx = dx / d;
    const ny = dy / d;
    ball.x = b.qx + nx * r;
    ball.y = b.qy + ny * r;
    const closing = -(ball.vx * nx + ball.vy * ny);
    if (closing > 0) {
      ball.vx += nx * closing * (1 + rest);
      ball.vy += ny * closing * (1 + rest);
      // A flat wall is the wall; anything with a vertical component is the
      // goal's furniture — a post or a lip — and rattles.
      const post = Math.abs(ny) > 0.05;
      bounce(nx, ny, closing, rest, post);
      if (post) versusState.lastPost = { side, nx, ny, x: ball.x, y: ball.y };
    }
  }
  // The tunnel's back. A goal is normally called long before the ball gets
  // here (the line is a screen's overscan in; the tunnel is far deeper), so
  // this only ever binds in a harness with no shore — but a live ball must
  // never leave the world.
  const backX = wallX + side * tunnelDepth();
  if (side < 0 ? ball.x - r < backX : ball.x + r > backX) {
    ball.x = backX - side * r;
    if (side < 0 ? ball.vx < 0 : ball.vx > 0) { const v = Math.abs(ball.vx); ball.vx = -side * v * rest; bounce(-side, 0, v, rest, true); }
  }
  // THE LINE: the ball's near side clear of the furthest the frame can reach.
  const edge = screenEdgeX(side);
  if (side < 0 ? ball.x + r < edge : ball.x - r > edge) { goal(side < 0 ? 'left' : 'right'); return true; }
  return false;
}

/**
 * THE BALL'S IMPACT FX — one shape for every hit it takes. `event` is the
 * row in CONFIG.feedback; (nx, ny) the contact normal pointing from the
 * thing that hit it INTO the ball, so the goo squirts out of the contact
 * point along the line the ball leaves on; `t` is the hit's strength, 0..1,
 * which every channel rides: the burst's count and the voice's gain through
 * `scale`, and the spray's throw and size through speedMul/sizeMul — the
 * ranges are CONFIG.versus.ball.fx. The ball's own velocity comes along as
 * the `inherit` term, so the splash trails the ball rather than hanging
 * where it was struck.
 *
 * Fired at the RIM, not the centre: the goo is the ball's substance and it
 * has to come off the surface that was hit.
 */
const fxLast = new Map();
export { ballTint };

function ballImpactFx(event, nx, ny, t, extra = null, gap = null) {
  const f = cfg().ball?.fx ?? {};
  const k = clamp01(t);
  // ONE SPLASH PER MOMENT. A seal dribbling the ball closes on it every
  // frame, and a ball settling against the floor touches it every frame:
  // without a gap each of those is sixty squirts of goo a second into the
  // ball's own group, and the ball stops being a ball. The gap is on the
  // whole event, not the sound (sfxMinGap already does that): a hit that
  // lands inside it is the same hit still happening.
  const minGap = gap ?? f.gap ?? 0.12;
  const now = versusState.clock;
  const last = fxLast.get(event);
  if (last != null && now - last < minGap) return null;
  fxLast.set(event, now);
  const at = {
    x: ball.x - nx * ball.r,
    y: ball.y - ny * ball.r,
    dirX: nx, dirY: ny,
    vx: ball.vx, vy: ball.vy,
    scale: lerp(f.scaleMin ?? 0.35, f.scaleMax ?? 1.6, k),
    sizeMul: lerp(f.sizeMin ?? 0.6, f.sizeMax ?? 1.5, k),
    speedMul: lerp(f.speedMin ?? 0.45, f.speedMax ?? 1.9, k),
    strength: k,
    // The splash and the goo are the ball's substance, in the ball's colour.
    color: ballTint().getHex(),
  };
  if (extra) Object.assign(at, extra);
  feedback(event, at);
  versusState.lastImpact = { event, ...at };
  return at;
}

/**
 * Off a wall whose inward normal is (nx, ny), having arrived at `closing`
 * u/s. The dent is on the wall's side and follows the speed; a spinning ball
 * skids — it picks up a kick along the wall from its spin and loses some of
 * that spin to the wall.
 */
function bounce(nx, ny, closing, rest, post = false) {
  const c = cfg().ball ?? {};
  const im = c.impact ?? {};
  const max = c.maxSpeed ?? 64;
  const depth = (c.soft?.wallDent ?? 0.2) * Math.min(1, closing / max);
  // The wall is on the side OPPOSITE the inward normal.
  const contactAngle = Math.atan2(-ny, -nx);
  if (depth > 0.01) impactDent(contactAngle, depth, closing);
  // FRICTION AGAINST THE ROCK. t is the inward normal turned a quarter turn
  // anticlockwise; the contact point is at -n r, so the ball's surface there
  // moves at -w r along t and the slip is v_t - w r. The impulse that would
  // stop the slip is 2/7 of it (a solid sphere), Coulomb-capped at
  // wallFriction x the normal impulse; it lands 1 : 2.5 on the flight and
  // the spin. A spinning ball SKIDS off the wall — a kick along it, spin
  // given up — and a ball rolling along the floor stays rolling.
  const mu = im.wallFriction ?? 0.45;
  if (mu > 0) {
    const tx = -ny;
    const ty = nx;
    const vt = ball.vx * tx + ball.vy * ty;
    const slip = vt - ball.spin * ball.r;
    if (Math.abs(slip) > 1e-4) {
      const jn = closing * (1 + rest);
      const jt = -Math.sign(slip) * Math.min(mu * jn, (2 / 7) * Math.abs(slip));
      ball.vx += tx * jt;
      ball.vy += ty * jt;
      ball.spin += -2.5 * jt / Math.max(0.01, ball.r);
    }
  }
  // How hard it arrived, as a share of the fastest it can go: the wall's
  // event and the post's (the F panel's Versus section) both ride it, goo
  // out of the contact point along the inward normal.
  const force = Math.min(1, closing / max);
  // A ball settling onto the floor under its own buoyancy arrives at nothing
  // and makes no splash; a ball THROWN at the floor does.
  if (closing >= (c.fx?.bumpMin ?? 3)) {
    if (post) ballImpactFx('versusPost', nx, ny, force);
    else ballImpactFx('versusBallWall', nx, ny, force);
  }
  // The look's own kick. Scaled by how fast it was going, so a tap off the
  // wall and a full-speed slam are not the same event. No owner: a wall is
  // nobody's.
  ballEvent('bounce', { force });
}

/**
 * A seal against the ball. `who` is 0 (P1) or 1 (P2); `dashing` with
 * `dashDir`/`power` is the strike in flight, and a dash shoves the ball ONCE,
 * like hitThisDash — a dash that stayed in contact for its whole length would
 * otherwise keep re-striking a ball it is already carrying.
 */
export function sealContact(who, pos, vel, dashing, dashDir, power, english = 0) {
  const c = cfg().ball ?? {};
  const cr = c.contactRadius ?? 2.2;
  const dx = ball.x - pos.x;
  const dy = ball.y - pos.y;
  const dist = Math.hypot(dx, dy) || 0.0001;
  const minD = ball.r + cr;
  if (!dashing) ball.dashHit[who] = false;
  if (dist >= minD) { ball.pierced[who] = false; return false; }

  const nx = dx / dist;
  const ny = dy / dist;
  const push = minD - dist;
  // A ball already going through this seal: THROUGH — no separation, no
  // second knock, nothing more until they have come apart. The knock was
  // paid on the frame it won; a knock a frame would launch the seal, and a
  // push-apart would have the ball plough the seal ahead of it for the
  // length of the pass instead of leaving it behind.
  if (ball.pierced[who]) return true;
  // The side of the ball the seal is on.
  const contactAngle = Math.atan2(-ny, -nx);
  // How fast the seal is closing on the ball along the line between them.
  const closing = Math.max(0, (vel.x - ball.vx) * nx + (vel.y - ball.vy) * ny);
  // THE CONTEST — see CONFIG.versus.ball.contest and contestMargin: the
  // ball's speed toward the seal against the seal's toward the ball, each
  // times its weight. Positive is the ball winning. A dash that has already
  // struck this ball counts as a swim from here: its shove is spent.
  const strike = dashing && !ball.dashHit[who];
  const speedIn = ballSpeedBefore(nx, ny);
  const margin = contestMargin(nx, ny, vel, dashing, power);

  if (margin > 0) {
    // THE BALL WINS. It goes through the seal — the bodies overlap for the
    // few frames of the pass — slowed, and the seal is knocked back by the
    // margin. A dash that met it is a strike that failed: broken on the
    // spot, and this dash does not get another go.
    pierceSeal(who, nx, ny, contactAngle, closing, margin, dashing, vel);
    return true;
  }
  // Out of the seal, whatever else happens: the seal held, so the ball gives.
  ball.x += nx * push;
  ball.y += ny * push;

  if (strike) {
    ball.dashHit[who] = true;
    // The strike's report (impulse, glance, spin, dent) — truthy, for callers
    // that only ask whether it landed. The cap it may leave at rises with
    // the speed it came in at: the counter-strike's return.
    return strikeBall(nx, ny, contactAngle, closing, vel, dashDir, power, who, english, speedIn);
  }

  // A swimming seal nudges it: only the closing speed along the normal, and
  // only the seal's share of it — the ball is `mass` seals heavy, so it
  // takes 2/(1+mass) of the closing speed. The seal held the contest, so it
  // holds its ground: no shove back.
  if (closing > 0) {
    const gain = c.bumpGain ?? 1.1;
    const carry = c.carry ?? 0.35;
    const mass = Math.max(0.01, c.mass ?? 3);
    const ballShare = 2 / (1 + mass);
    ball.vx += (nx * closing * gain + vel.x * carry * 0.2) * ballShare;
    ball.vy += (ny * closing * gain + vel.y * carry * 0.2) * ballShare;
    // The bump runs AFTER the frame's cap, and a gain over 1 adds energy: a
    // ball ricocheting off a seal that is just sitting there must not leave
    // faster than anything else in the water may go — but a nudge never
    // slows a ball that was already past that.
    const max = Math.max(c.maxSpeed ?? 64, speedIn);
    const sp = Math.hypot(ball.vx, ball.vy);
    if (sp > max) { ball.vx *= max / sp; ball.vy *= max / sp; }
    impactDent(contactAngle, 0.14 * Math.min(1, closing / 20), closing);
    // A nudge is a hit too, a small one — but a seal resting against the
    // ball closes at nothing and must not squirt goo every frame it touches.
    const f = c.fx ?? {};
    if (closing >= (f.bumpMin ?? 3)) {
      ballImpactFx('versusBallHit', nx, ny, (f.bumpShare ?? 0.35) * Math.min(1, closing / Math.max(1, c.impact?.speedRef ?? 30)), { team: who }, f.bumpGap ?? 0.35);
    }
  }
  return true;
}

const contestCfg = () => cfg().ball?.contest ?? {};

/** The most the ball ever goes: contest.speedCap, never under maxSpeed. */
export function ballSpeedCap() {
  const c = cfg().ball ?? {};
  return Math.max(c.maxSpeed ?? 64, c.contest?.speedCap ?? c.maxSpeed ?? 64);
}

/** The ball's speed TOWARD a seal whose line to the ball is (nx, ny): 0 if it is moving away. */
function ballSpeedBefore(nx, ny) {
  return Math.max(0, -(ball.vx * nx + ball.vy * ny));
}

/** What a seal weighs in the contest: 1 swimming, contest.dashMass lerped on power dashing. */
export function contestMass(dashing, power) {
  if (!dashing) return 1;
  const dm = contestCfg().dashMass ?? [1, 2.8];
  const lo = Array.isArray(dm) ? dm[0] : dm;
  const hi = Array.isArray(dm) ? dm[1] : dm;
  return lerp(lo ?? 1, hi ?? lo ?? 1, clamp01(power ?? 0));
}

/**
 * THE CONTEST'S MARGIN, in u/s, for a seal at velocity `vel` whose line to
 * the ball's centre is (nx, ny): the ball's speed toward the seal times
 * ballWeight, less the seal's speed toward the ball times its mass.
 * Positive is the ball winning — the seal is knocked back and the ball goes
 * through. Zero or under is the seal holding its ground. Exported for the
 * harness and the bot.
 */
export function contestMargin(nx, ny, vel, dashing, power) {
  const k = contestCfg();
  const ub = ballSpeedBefore(nx, ny);
  const us = Math.max(0, (vel?.x ?? 0) * nx + (vel?.y ?? 0) * ny);
  return ub * (k.ballWeight ?? 1) - us * contestMass(dashing, power);
}

/** The most a strike may send the ball out at: maxSpeed, or returnMax x the speed it came in at, under speedCap. */
export function returnCap(speedIn) {
  const c = cfg().ball ?? {};
  const k = c.contest ?? {};
  return Math.min(ballSpeedCap(), Math.max(c.maxSpeed ?? 64, (speedIn ?? 0) * (k.returnMax ?? 1)));
}

/** The least a strike that holds sends the ball back at: returnGain x the speed it came in at, under the cap. */
export function returnFloor(speedIn) {
  const k = contestCfg();
  return Math.min(returnCap(speedIn), (speedIn ?? 0) * (k.returnGain ?? 0));
}

/**
 * THE BALL WINS THE CONTEST: it goes through seal `who`, slowed by a share
 * of the closing speed that eases from the nudge's own share at a draw to
 * `pierceSlow` once the margin is `blend` u/s clear, and the seal is
 * knocked back along the ball's line at knockGain x margin. A dash that
 * lost is broken and marked as spent on this ball.
 */
function pierceSeal(who, nx, ny, contactAngle, closing, margin, dashing, vel) {
  const c = cfg().ball ?? {};
  const k = c.contest ?? {};
  const mass = Math.max(0.01, c.mass ?? 3);
  const nudgeShare = (c.bumpGain ?? 1.1) * 2 / (1 + mass);
  const t = clamp01(margin / Math.max(0.01, k.blend ?? 15));
  const slow = lerp(nudgeShare, k.pierceSlow ?? 0.3, t) * closing;
  ball.vx += nx * slow;
  ball.vy += ny * slow;
  const knock = Math.min(k.knockMax ?? 80, (k.knockGain ?? 1.2) * margin);
  shoveSeal(who, -nx, -ny, knock);
  if (dashing) {
    ball.dashHit[who] = true;
    if (who === 0) { if (strikeState.active) cancelDash(); player.dashTimer = 0; }
    else if (who === 1) { cancelDash(p2.strike); p2.dashTimer = 0; }
  }
  impactDent(contactAngle, 0.14 * Math.min(1, closing / 20), closing);
  const f = c.fx ?? {};
  if (closing >= (f.bumpMin ?? 3)) {
    ballImpactFx('versusBallHit', nx, ny, (f.bumpShare ?? 0.35) * Math.min(1, closing / Math.max(1, c.impact?.speedRef ?? 30)), { team: who }, f.bumpGap ?? 0.35);
  }
  ballEvent('bounce', { force: Math.min(1, margin / 40), team: who });
  ball.pierced[who] = true;
  versusState.lastPierce = { who, margin, knock, slow, dashing: !!dashing, speed: Math.hypot(ball.vx, ball.vy) };
}


/** Push seal `who` (0 = player 1, 1 = player 2) along (dx, dy) at `speed`, as a decaying shove. */
function shoveSeal(who, dx, dy, speed) {
  if (!(speed > 0.01)) return;
  if (who === 0) applyPlayerKnockback(dx, dy, speed);
  else if (who === 1) {
    const l = Math.hypot(dx, dy) || 1;
    const push = Math.min(speed, CONFIG.playerKnockback?.maxSpeed ?? 60);
    p2.knockX += (dx / l) * push;
    p2.knockY += (dy / l) * push;
  }
}

/** The striker thrown off the ball: its velocity becomes the recoil, and the dash ends. */
function strikerRecoil(who, dx, dy, speed, stopDash) {
  if (who === 0) {
    if (stopDash && strikeState.active) { cancelDash(); player.dashTimer = 0; }
    player.velocity.set(dx * speed, dy * speed);
  } else if (who === 1) {
    if (stopDash) { cancelDash(p2.strike); p2.dashTimer = 0; }
    p2.velocity.set(dx * speed, dy * speed);
  }
}

/**
 * THE STRIKE ITSELF, given the geometry: (nx, ny) is the unit line from the
 * striker to the ball's centre, `contactAngle` the world angle of the point
 * hit, `closing` how fast the striker was arriving, `vel` its velocity,
 * `dashDir` the dash's line and `power` the wind-up behind it, 0..1.
 *
 * WHERE IT IS HIT decides where it goes. A dash whose line runs through the
 * centre (dashDir along the normal) sends the ball straight down that line.
 * The further off centre, the more the ball leaves along the NORMAL instead —
 * `grip` is how much of the dash's sideways component it takes with it (a
 * frictionless ball takes none) — and the sideways part that is not taken
 * becomes SPIN, signed by which side of centre the hit was. The spin is what
 * a glancing blow LOOKS like: the ball curves, and the dent it was given
 * rides round its rim.
 *
 * HOW HARD decides the shape. Impulse is the strike's banked power plus a
 * share of the closing speed; the dent deepens and narrows with that speed
 * and a hard hit flattens the whole body for a beat. See impactDent.
 *
 * Exported bare so the lab can strike the ball with a pointer.
 */
export function strikeBall(nx, ny, contactAngle, closing, vel, dashDir, power, who = -1, english = 0, speedIn = 0) {
  const c = cfg().ball ?? {};
  const im = c.impact ?? {};
  const p = clamp01(power);
  const base = lerp(c.strikeImpulse ?? 34, c.strikeImpulseMax ?? 62, p);
  let dx = dashDir?.x ?? nx;
  let dy = dashDir?.y ?? ny;
  const dl = Math.hypot(dx, dy) || 1;
  dx /= dl; dy /= dl;
  // A dash not going INTO the ball at all shoves straight out from the contact.
  const dn = dx * nx + dy * ny;
  if (dn <= 0.15) { dx = nx; dy = ny; }
  // Signed glance: +1 when the dash runs anticlockwise of the normal.
  const off = nx * dy - ny * dx;
  // The line it leaves on: the normal at grip 0, the dash's own line at 1.
  const grip = clamp01(im.grip ?? 0.35);
  let ix = nx * (1 - grip) + dx * grip;
  let iy = ny * (1 - grip) + dy * grip;
  const il = Math.hypot(ix, iy) || 1;
  ix /= il; iy /= il;

  const carry = c.carry ?? 0.35;
  const keep = c.keep ?? 0.25;
  const imp = base + closing * carry;
  const oldVx = ball.vx;
  const oldVy = ball.vy;
  ball.vx = ix * imp + ball.vx * keep;
  ball.vy = iy * imp + ball.vy * keep;
  // Capped here as well as in the step: the strike lands after the frame's
  // cap has run. maxSpeed for a strike on a slow ball; a counter-strike on
  // a fast one may send it back faster (returnCap), and no slower than
  // returnFloor — the volley climbs. `speedIn` is how fast it was coming.
  const max = returnCap(speedIn);
  const floor = returnFloor(speedIn);
  const sp = Math.hypot(ball.vx, ball.vy);
  if (sp > max) { ball.vx *= max / sp; ball.vy *= max / sp; }
  else if (floor > 0 && sp > 1e-6 && sp < floor) { ball.vx *= floor / sp; ball.vy *= floor / sp; }
  // SPIN IS FRICTION — see CONFIG.versus.ball.impact. t is the normal turned
  // a quarter turn anticlockwise; the contact point sits at -n r on the ball,
  // where its surface moves at -w r along t. The striker's face slides across
  // it at the tangential closing speed (a glancing dash) plus whatever
  // english it meant (`sweep` x english, the seal swimming across its own
  // shot), less that surface speed: that is the slip. The impulse that would
  // stop it outright is 2/7 of it for a solid sphere, capped by Coulomb at
  // `friction` x the normal impulse, and it lands as spin (2.5 J / r, turning
  // the face the way the striker dragged it — positive slip along t is a
  // clockwise turn) and as `squirt` of a sideways kick to the flight.
  const tx = -ny;
  const ty = nx;
  const eng = cfg().ball?.english ?? {};
  const sweep = eng.enabled === false ? 0 : (eng.sweep ?? 28) * Math.max(-1, Math.min(1, english || 0));
  const relT = ((vel?.x ?? 0) - oldVx) * tx + ((vel?.y ?? 0) - oldVy) * ty;
  const slip = relT + sweep + ball.spin * ball.r;
  const mu = im.friction ?? 0.6;
  let jt = 0;
  if (mu > 0 && Math.abs(slip) > 1e-4) {
    jt = Math.sign(slip) * Math.min(mu * imp, (2 / 7) * Math.abs(slip));
    const squirt = Math.max(0, Math.min(1, im.squirt ?? 0.5));
    ball.vx += tx * jt * squirt;
    ball.vy += ty * jt * squirt;
    ball.spin += -2.5 * jt / Math.max(0.01, ball.r);
  }
  const spinCap = im.spinMax ?? 18;
  if (Math.abs(ball.spin) > spinCap) ball.spin = Math.sign(ball.spin) * spinCap;
  {
    const sp2 = Math.hypot(ball.vx, ball.vy);
    if (sp2 > max) { ball.vx *= max / sp2; ball.vy *= max / sp2; }
  }

  const dent = impactDent(contactAngle, (c.soft?.dentDepth ?? 0.42) * (0.6 + 0.4 * p), Math.max(closing, base * 0.5));
  // THE HIT'S OWN EVENT, out of the contact point along the strike, scaled
  // by the impulse against the hardest strike there is — so a limp tap and
  // a full wind-up into a ball coming the other way are not the same splash.
  const hardest = (c.strikeImpulseMax ?? 62) + (c.maxSpeed ?? 64) * carry;
  ballImpactFx('versusBallHit', nx, ny, imp / Math.max(1, hardest), { team: who }, 0);
  // A SEAL touched it, so this is where possession changes hands — `p` is how
  // hard, which is the same number the dent is sized from.
  ballEvent('bounce', { force: p, team: who });
  // THE RAM MEETS THE CANNONBALL: the striker takes the ball's change of
  // velocity back, times the mass, and its dash is over. A seal that hit a
  // three-seal ball at full stretch is thrown backwards off it.
  let recoil = 0;
  if (who === 0 || who === 1) {
    const dvx = ball.vx - oldVx;
    const dvy = ball.vy - oldVy;
    const dv = Math.hypot(dvx, dvy);
    recoil = Math.min(im.recoilMax ?? 40, dv * Math.max(0, c.mass ?? 3) * (im.recoil ?? 0.35));
    if (recoil > 0 && dv > 1e-6) strikerRecoil(who, -dvx / dv, -dvy / dv, recoil, im.stopDash !== false);
  }
  return { imp, off, spin: ball.spin, dent, recoil, slip, jt, english };
}

// ---------------------------------------------------------------------------
// PLAYER 2
// ---------------------------------------------------------------------------

const STRIKE_BUTTONS = [4, 5, 6, 7];

function deadzone(v, dz) {
  const a = Math.abs(v);
  if (a <= dz) return 0;
  return Math.sign(v) * ((a - dz) / (1 - dz));
}

/**
 * Which pad is P2's. With two or more connected, the second by index (input.js
 * gives P1 the first while versus is on); with one, that one — P1 is on the
 * keyboard then, and input.js ignores the pad so the two never share it.
 */
export function p2Pad(pads) {
  const connected = [];
  for (const p of pads ?? []) if (p?.connected) connected.push(p);
  connected.sort((a, b) => a.index - b.index);
  // The team select's answer first (versusSetup): the right captain's own pad,
  // or none for a CPU. Only an un-set-up match uses the by-index rule below.
  const want = captainPad(1);
  if (want !== undefined) return want === null ? null : (connected.find((p) => p.index === want) ?? null);
  if (!connected.length) return null;
  return connected.length >= 2 ? connected[1] : connected[0];
}

export function readP2Input(pads = null, out = p2.input) {
  const dz = cfg().p2?.deadzone ?? 0.18;
  let list = pads;
  if (!list) {
    try { list = navigator.getGamepads?.() ?? []; } catch { list = []; }
  }
  const pad = p2Pad(list);
  out.strikeRelease = false;
  out.strike = false;
  out.aimLive = false;
  if (!pad) {
    out.connected = false;
    out.move.set(0, 0);
    if (p2.heldPrev) { out.strikeRelease = true; }
    out.strikeHeld = false;
    p2.heldPrev = false;
    return out;
  }
  out.connected = true;
  const lx = deadzone(pad.axes[0] ?? 0, dz);
  const ly = -deadzone(pad.axes[1] ?? 0, dz);
  out.move.set(lx, ly);
  if (out.move.lengthSq() > 1) out.move.normalize();
  const rx = deadzone(pad.axes[2] ?? 0, dz);
  const ry = -deadzone(pad.axes[3] ?? 0, dz);
  // `aimLive` as input.js means it: a hand is ON the aim this frame (the right
  // stick pushed), which is what lets the aim steer a dash mid-flight.
  if (rx || ry) { out.aim.set(rx, ry).normalize(); out.aimLive = true; }
  else if (lx || ly) out.aim.set(lx, ly).normalize();
  let held = false;
  for (const b of STRIKE_BUTTONS) {
    const btn = pad.buttons[b];
    if (btn && (btn.pressed || (btn.value ?? 0) > 0.5)) { held = true; break; }
  }
  out.strikeHeld = held;
  out.strike = held && !p2.heldPrev;
  out.strikeRelease = p2.heldPrev && !held;
  p2.heldPrev = held;
  return out;
}

// What player 2's dash reports back — the kill path the run lends the match
// (versusHooks), and the ram's own event, as main.js fires it for player 1.
const p2Hooks = {
  onEnemyKilled: (e) => versusHooks.onKill?.(e),
  onRam: (e, power, at) => {
    feedback('strikeRam', {
      x: at?.x ?? e.mesh.position.x,
      y: at?.y ?? e.mesh.position.y,
      scale: 0.7 + power * 0.7,
    });
  },
};

/**
 * PLAYER 2'S RELEASE — what main.js does for player 1 on the frame the button
 * comes up: tryStrike on player 2's state, the dash impulse and its ceiling,
 * the barrel roll, the strike's event, the vent and the roll clip. Returns
 * whether a dash launched. Exported for the harnesses.
 */
export function releaseP2(dir, english = 0) {
  const s = p2.strike;
  const stats = player.stats;
  const pos = p2.pos;
  if (!dir || (dir.x === 0 && dir.y === 0)) return false;
  const releaseVx = p2.velocity.x;
  const releaseVy = p2.velocity.y;
  if (!tryStrike(dir, stats, english, s)) return false;
  const dashSpeed = stats.strikeDashSpeed * p2.comboSpeedMul;
  p2.velocity.set(s.dashDir.x * dashSpeed, s.dashDir.y * dashSpeed);
  p2.dashTimer = s.dashDuration;
  // The barrel roll — whole turns bought with banked power, continuing from
  // wherever the last one had got to. See main.js.
  const rollCfg = CONFIG.strike.roll;
  const turns = rollCfg?.enabled ? Math.round((rollCfg.turnsAtFull ?? 0) * s.power) : 0;
  if (turns > 0) {
    const TURN = Math.PI * 2;
    const from = p2.rollAngle;
    const sign = p2.mirrorAngle ? -1 : 1;
    const completed = sign > 0 ? Math.ceil(from / TURN) : Math.floor(from / TURN);
    p2.rollFrom = from;
    p2.rollTo = (completed + sign * turns) * TURN;
    p2.rollDuration = s.dashDuration * (rollCfg.durationMul ?? 1);
    p2.rollElapsed = 0;
  }
  feedback('strike', {
    x: pos.x, y: pos.y,
    dirX: s.dashDir.x, dirY: s.dashDir.y,
    scale: 0.7 + s.power * 0.8,
    sfxOpts: { pitch: 1.18 - s.power * 0.3 },
  });
  feedback('strikeVent', {
    x: pos.x, y: pos.y,
    vx: releaseVx, vy: releaseVy,
    scale: 0.5 + s.power * 0.9,
  });
  p2.anim?.trigger('strike');
  return true;
}

/**
 * PLAYER 2'S FRAME — main.js's order for player 1, on player 2's state: the
 * body (updatePlayer: thrust, dash steering, ceiling, drag, the shove, the
 * walls, air, facing, the clip, breath, jaw, aim rig), then the wind-up, then
 * the release, then the dash's hits. Every number is read off the same
 * CONFIG and the same stats player 1 reads.
 */
function stepP2(dt) {
  const inp = p2.input;
  const s = p2.strike;
  const stats = player.stats;
  const pos = p2.mesh.position;

  updatePlayer(dt, inp, p2, s);
  p2.celebrate?.update(dt);

  // The wind-up: burn fuel into power (updateCharge), the coil pose, the
  // sealed mouth, the tremble's rumble and the perfect charge's pop — as
  // main.js does for player 1, line for line.
  updateCharge(dt, inp.strikeHeld, stats, s);
  p2.chargePose = s.charging ? s.pending : 0;
  p2.chumSealed = CONFIG.strike.enabled && inp.strikeHeld && CONFIG.strike.charge.gulp?.blockEating !== false;
  if (s.charging) {
    p2.hapticT -= dt;
    if (p2.hapticT <= 0) {
      p2.hapticT = CONFIG.strike.charge.hapticInterval;
      feedback('strikeCharging', { x: pos.x, y: pos.y, scale: 0.35 + s.pending * 1.1 });
    }
  } else {
    p2.hapticT = 0;
  }
  if (perfectCrossed(s)) feedback('strikePerfect', { x: pos.x, y: pos.y });

  // The release: the same launch, between the swim and the aim.
  if (inp.strikeRelease) {
    const dir = strikeDirection(inp.move, inp.aim);
    // English off the two sticks disagreeing, as player 1's is — but not for
    // the bot, whose aim is the ball and whose swim is wherever it is going
    // next; it would put spin on every shot and mean none of it.
    releaseP2(dir, botState.driving ? 0 : strikeEnglish(inp.move, inp.aim));
  }

  // THE DASH'S HITS — the run's own loop, on player 2's state: the prey cull
  // (every dash culls in a match, see updateStrike), the shove, the ram's
  // event, and the kill through the hook above so a P2 kill is a kill like
  // any other. hits are per state, so the two seals never share a dash.
  updateStrike(dt, scene, pos, stats, enemies, p2Hooks, s);

  // Air: updatePlayer spent or refilled it; empty is a burst.
  if (CONFIG.oxygen?.enabled !== false && p2.oxygen <= 0) versusOutOfAir(1);

  // Chum. The pickup system's magnet belongs to the player; P2 just eats what
  // its mouth is over, a pip a mouthful, the same rate as P1's bar — and not
  // while a wind-up has the mouth sealed, as P1's is.
  if (scene && !p2.chumSealed) {
    const reach = cfg().p2?.reach ?? 3;
    const pip = CONFIG.strike.charge?.chumRefill ?? 0.2;
    gulpPickups(scene, pos.x, pos.y, reach, () => { addCharge(pip, stats, s); });
  }
}

/**
 * The outline's boil off the ball-look state — see CONFIG.versus.ball.outline.
 * Written onto the goo group every frame, where renderGooGroup reads it; the
 * group's own boilAmp/boilHz are the rest values the gains build on.
 */
export function driveOutline(look = ballLookState()) {
  const group = CONFIG.fx?.goo?.groups?.ball;
  const o = cfg().ball?.outline;
  if (!group?.outline || !o) return null;
  const spin01 = Math.min(1, Math.abs(ball.spin) / 10);
  const pulse = Math.max(0, look.pulse ?? 0);
  const amp = Math.min(o.ampMax ?? 9, (o.ampRest ?? group.outline.boilAmp ?? 0)
    + (o.ampByPulse ?? 0) * pulse
    + (o.ampBySpeed ?? 0) * (look.speed01 ?? 0)
    + (o.ampBySpin ?? 0) * spin01
    + (o.ampByCharge ?? 0) * (look.charge01 ?? 0));
  const hz = Math.min(o.hzMax ?? 24, (o.hzRest ?? group.outline.boilHz ?? 6)
    + (o.hzByPulse ?? 0) * pulse
    + (o.hzBySpeed ?? 0) * (look.speed01 ?? 0));
  group.outline.boilAmp = amp;
  group.outline.boilHz = hz;
  return { amp, hz };
}

// ---------------------------------------------------------------------------
// OUT OF AIR — the burst, and the way back.
// ---------------------------------------------------------------------------

/** Where seal `who` comes back: its own goal mouth, `inset` in from the wall. */
function spawnPoint(who) {
  const inset = cfg().respawn?.inset ?? 8;
  return { x: who === 0 ? bounds.left + inset : bounds.right - inset, y: midWater() };
}

/**
 * Seal `who` bursts: out of air, or out of health by any other means (main.js
 * routes killPlayer here in a match). Gone for `respawn.delay` seconds — no
 * body to hit, no ball to push — then back in its goal with full air and
 * health and a little grace. Exported for main.js and the harness.
 */
export function versusOutOfAir(who) {
  if (!versusState.active || versusState.dead[who]) return false;
  const r = cfg().respawn ?? {};
  const at = who === 0 ? player.mesh?.position : p2.pos;
  versusState.dead[who] = Math.max(0.05, r.delay ?? 1);
  versusState.bursts++;
  if (at) feedback('sealBurst', { x: at.x, y: at.y, scale: 1.6, sizeMul: 2.2, speedMul: 1.6 });
  if (who === 0) {
    if (strikeState.active) cancelDash();
    player.dashTimer = 0;
    player.velocity.set(0, 0);
    player.knockX = player.knockY = 0;
    if (player.mesh) player.mesh.visible = false;
    // Held still for the whole of it, so the stick does nothing to a seal
    // that is not there. The thaw lands as the respawn does.
    snarePlayer(versusState.dead[0] + 0.05, 0, 0.1);
  } else {
    cancelDash(p2.strike);
    p2.dashTimer = 0;
    p2.velocity.set(0, 0);
    p2.knockX = p2.knockY = 0;
    p2.strike.pending = 0;
    if (p2.mesh) p2.mesh.visible = false;
    snarePlayer(versusState.dead[1] + 0.05, 0, 0.1, p2);
  }
  ball.dashHit[who] = false;
  return true;
}

function respawn(who) {
  const r = cfg().respawn ?? {};
  const at = spawnPoint(who);
  const maxO2 = Math.max(1, player.stats?.maxOxygen ?? CONFIG.oxygen?.max ?? 100);
  if (who === 0) {
    if (player.mesh) { player.mesh.position.set(at.x, at.y, 0); player.mesh.visible = true; }
    player.velocity.set(0, 0);
    player.oxygen = maxO2;
    player.hp = player.stats?.maxHp ?? player.hp;
  } else {
    p2.pos.set(at.x, at.y, 0);
    p2.velocity.set(0, 0);
    p2.oxygen = maxO2;
    p2.hp = player.stats?.maxHp ?? p2.hp;
    if (p2.mesh) p2.mesh.visible = true;
  }
  versusState.invuln[who] = r.invuln ?? 0.8;
  feedback('bubblePop', { x: at.x, y: at.y, scale: 1.4 });
}

/** The clocks: the wait, then the grace. A dead seal is parked on its spawn point meanwhile. */
function updateRespawns(dt) {
  for (let who = 0; who < 2; who++) {
    if (versusState.invuln[who] > 0) versusState.invuln[who] = Math.max(0, versusState.invuln[who] - dt);
    if (!versusState.dead[who]) continue;
    // Parked out of play while gone — anything that reads the position finds
    // it in the goal, nowhere near the ball.
    const at = spawnPoint(who);
    if (who === 0 && player.mesh) { player.mesh.position.set(at.x, at.y, 0); player.velocity.set(0, 0); player.mesh.visible = false; }
    if (who === 1) { p2.pos.set(at.x, at.y, 0); p2.vel.set(0, 0); }
    versusState.dead[who] = Math.max(0, versusState.dead[who] - dt);
    if (versusState.dead[who] === 0) respawn(who);
  }
}

/** Whether seal `who` may be hit right now: alive and out of its grace. */
export function sealVulnerable(who) {
  return !versusState.dead[who] && !(versusState.invuln[who] > 0);
}

// ---------------------------------------------------------------------------
// THE FRAME
// ---------------------------------------------------------------------------

/**
 * Gameplay, on the gameplay clock. Called from main.js inside the run gate,
 * after updatePlayer has moved P1 for the frame.
 */
export function updateVersus(dt, pads = null, humanInput = null) {
  if (!versusState.active) return;
  versusState.clock += dt;
  // THE CONTINUOUS HALF of the ball's look, pushed before anything moves so it
  // describes the frame the player is looking at. `speedRef` is the same
  // number the impact model normalises against, so "fast" means one thing.
  const ref = Math.max(1, cfg().impact?.speedRef ?? 30);
  setBallDrive({
    speed01: Math.hypot(ball.vx, ball.vy) / ref,
    charge01: Math.max(p2.strike.charging ? p2.strike.pending : 0, humanInput?.charge ?? 0),
  });
  readP2Input(pads);
  // Nobody on player 2's pad: the bot fills the same input the pad would.
  if (botWanted(p2.input.connected)) {
    updateBot(dt, p2, ball, opponentOf(1), p2.input);
    // The bot's aim is always a hand on the stick, so its dashes steer.
    p2.input.aimLive = true;
    p2.input.strike = p2.input.strikeHeld && !p2.pressPrev;
  } else {
    botState.driving = false;
  }
  p2.pressPrev = p2.input.strikeHeld;
  updateRespawns(dt);
  if (!versusState.dead[1] && p2.mesh) stepP2(dt);
  logImitation(dt, humanInput);
  // The countdown: everyone stays put, with a full wheel, until the whistle.
  // The world is at freezeScale under this (updateVersusClock), so nothing
  // would move far anyway — but a seal that could creep during the count
  // would be a seal that learned to creep, and the wheel would leak into a
  // wind-up nobody could release.
  if (versusState.phase === 'kickoff') holdKickoff();
  if (versusState.phase === 'play') {
    regenPips(dt);
    keepBubbles(dt);
    if (!versusState.dead[1]) eatBubblesP2();
    if (!versusState.dead[0] && !versusState.dead[1]) sealCollide(bodyCheck());
  }

  if (ball.live) {
    stepSoftBody(dt);
    stepBall(dt);
    updateBallSpin(ball.live ? ball.spin : 0, dt);
    if (!ball.live) return; // a goal just went in
    if (player.mesh && !versusState.dead[0]) {
      sealContact(0, player.mesh.position, player.velocity,
        !!strikeState.active, strikeState.dashDir, strikeState.power ?? 0, strikeState.english ?? 0);
    }
    sealContact(1, p2.pos, p2.vel, p2.active, p2.dashDir, p2.power, p2.english);
  } else {
    updateBallSpin(0, dt);
  }

  // Food: docile bait balls on a clock, since the spawner's tap is off.
  if (scene) {
    versusState.chumTimer -= dt;
    const ch = cfg().chum ?? {};
    if (versusState.chumTimer <= 0) {
      versusState.chumTimer = ch.ballInterval ?? 9;
      if (baitBalls.size < (ch.maxBalls ?? 5)) {
        const spec = devBaitBallSpec();
        spec.docile = true;
        spawnBaitBall(scene, 0, 1, spec);
      }
    }
  }

  // The markers ride under their seals.
  if (markers.length === 2) {
    if (player.mesh) { markers[0].position.x = player.mesh.position.x; markers[0].position.y = player.mesh.position.y; }
    markers[1].position.x = p2.pos.x;
    markers[1].position.y = p2.pos.y;
  }
  updateMeters();
}

const _opp = { x: 0, y: 0, vx: 0, vy: 0 };
/** The OTHER seal's position and velocity, as seen by seal `who`. */
function opponentOf(who) {
  if (who === 1) {
    const p = player.mesh?.position;
    _opp.x = p?.x ?? 0; _opp.y = p?.y ?? 0;
    _opp.vx = player.velocity?.x ?? 0; _opp.vy = player.velocity?.y ?? 0;
  } else {
    _opp.x = p2.pos.x; _opp.y = p2.pos.y;
    _opp.vx = p2.vel.x; _opp.vy = p2.vel.y;
  }
  return _opp;
}

const _feat = new Float32Array(14);
const _act = new Float32Array(5);
const _pitch = { left: 0, right: 0, bottom: 0, surface: 0 };
/**
 * File what each HUMAN did this frame — player 1 always, player 2 when a
 * pad is on it — in play only: a frozen goal and a match reset are not
 * moments anyone is playing. See systems/imitation.js.
 */
function logImitation(dt, humanInput) {
  if (versusState.phase !== 'play' || !ball.live) return;
  if (CONFIG.versus?.imitation?.enabled === false) return;
  _pitch.left = bounds.left; _pitch.right = bounds.right;
  _pitch.bottom = bounds.bottom; _pitch.surface = bounds.surfaceY;
  const ballMax = cfg().ball?.maxSpeed ?? 64;
  const swimMax = player.stats?.maxSpeed ?? CONFIG.player.maxSpeed;
  // One clock for both seals: recordImitation rate-limits on its own clock,
  // so the two rows of a frame are filed together or not at all.
  let filed = false;
  if (humanInput && player.mesh) {
    features(
      { x: player.mesh.position.x, y: player.mesh.position.y, vx: player.velocity.x, vy: player.velocity.y },
      opponentOf(0), ball,
      { charge: strikeState.charge, pending: strikeState.pending, dashing: strikeState.active },
      false, _pitch, ballMax, swimMax, _feat,
    );
    actions(humanInput, false, _act);
    filed = recordImitation(dt, 0, _feat, _act);
  }
  if (p2.input.connected && !botState.driving) {
    features(
      { x: p2.pos.x, y: p2.pos.y, vx: p2.vel.x, vy: p2.vel.y },
      opponentOf(1), ball,
      { charge: p2.charge, pending: p2.pending, dashing: p2.active },
      true, _pitch, ballMax, swimMax, _feat,
    );
    actions(p2.input, true, _act);
    // Same tick as player 1's row: only file when that one filed (or when
    // there is no player 1 row this frame, on the logger's own clock).
    if (filed) { imitationState.clock += 1; recordImitation(0, 1, _feat, _act); imitationState.clock -= 1; }
    else if (!humanInput) recordImitation(dt, 1, _feat, _act);
  }
}

// ---------------------------------------------------------------------------
// THE METER'S OTHER SOURCES, AND THE BODY CHECK
// ---------------------------------------------------------------------------

/** A free pip for each seal every `regen.pipEvery` seconds. */
function regenPips(dt) {
  const every = cfg().regen?.pipEvery ?? 0;
  if (!(every > 0)) return;
  const t = versusState.regenT;
  t[0] -= dt;
  if (t[0] <= 0) { t[0] += every; addCharge(pipValue(player.stats), player.stats); }
  t[1] -= dt;
  if (t[1] <= 0) { t[1] += every; p2.charge = Math.min(1, p2.charge + (CONFIG.strike.charge?.chumRefill ?? 0.2)); }
}

/** What one bubble pays the meter in a match, as a share of the bar. */
export function versusBubblePips() {
  return (cfg().bubbles?.pips ?? 1) * (CONFIG.strike.charge?.chumRefill ?? 0.2);
}

/**
 * The match's bubble headcount: never fewer than `minAlive` (refilled at
 * once), one more every `every` seconds up to `maxAlive`, out of the seabed
 * like the run's. main.js hands its own spawner off while the flag is on.
 */
function keepBubbles(dt) {
  if (!scene) return;
  const b = cfg().bubbles ?? {};
  const min = b.minAlive ?? 4;
  const max = Math.max(min, b.maxAlive ?? 7);
  const alive = bubbleOrbs.length;
  if (alive >= max) { versusState.bubbleT = b.every ?? 2.5; return; }
  versusState.bubbleT -= dt;
  if (alive < min || versusState.bubbleT <= 0) {
    versusState.bubbleT = b.every ?? 2.5;
    spawnBubbleOrb(scene, bubbleBirthPoint());
  }
}

/** Player 2 takes a bubble by touching its skin, as player 1 does; it pays the meter. */
function eatBubblesP2() {
  if (!scene) return;
  const reach = (cfg().bubbles?.reach ?? 3);
  for (let i = bubbleOrbs.length - 1; i >= 0; i--) {
    const orb = bubbleOrbs[i];
    const r = orb.assetRadius ?? 0.5;
    const d = Math.hypot(orb.mesh.position.x - p2.pos.x, orb.mesh.position.y - p2.pos.y);
    if (d >= reach + r) continue;
    p2.charge = Math.min(1, p2.charge + versusBubblePips());
    p2.oxygen = Math.min(Math.max(1, player.stats?.maxOxygen ?? CONFIG.oxygen?.max ?? 100), p2.oxygen + (CONFIG.oxygen?.bubbleRefillAmount ?? 30));
    feedback('bubblePop', { x: orb.mesh.position.x, y: orb.mesh.position.y, scale: 0.9 });
    scene.remove(orb.mesh);
    bubbleOrbs.splice(i, 1);
  }
}

/**
 * A DASH INTO THE OTHER SEAL. Whoever is dashing shoves the other; when both
 * are, it is a collision and each takes the other's shove. The shove is a
 * SPEED off the striker's banked power plus a share of how fast it was
 * closing, delivered as the same decaying position offset a creature's
 * knockback gives the player, so the swim ceiling cannot clip it. The
 * victim's dash is broken. Once per dash per striker. The event's `scale`
 * is the shove's speed against the range the block declares, so the burst,
 * the shake, the ripple and the voice all grow with it.
 */
function bodyCheck() {
  const c = cfg().bodyCheck ?? {};
  if (c.enabled === false || !player.mesh) return false;
  const p1 = player.mesh.position;
  const dx = p2.pos.x - p1.x;
  const dy = p2.pos.y - p1.y;
  const dist = Math.hypot(dx, dy) || 0.0001;
  const cr = c.contactRadius ?? 2.2;
  const d1 = !!strikeState.active;
  const d2 = !!p2.active;
  if (!d1) versusState.checked[0] = false;
  if (!d2) versusState.checked[1] = false;
  if (dist >= cr * 2) return false;
  const nx = dx / dist; // from P1 toward P2
  const ny = dy / dist;
  const can1 = d1 && !versusState.checked[0];
  const can2 = d2 && !versusState.checked[1];
  if (!can1 && !can2) return false;
  const both = can1 && can2;
  const share = both ? (c.both ?? 0.6) : 1;
  const knock = c.knock ?? 22;
  const knockMax = c.knockMax ?? 52;
  const carry = c.carry ?? 0.4;
  let strongest = 0;
  if (can1) {
    versusState.checked[0] = true;
    const closing = Math.max(0, (player.velocity.x - p2.vel.x) * nx + (player.velocity.y - p2.vel.y) * ny);
    const push = (lerp(knock, knockMax, clamp01(strikeState.power ?? 0)) + closing * carry) * share;
    p2.knockX += nx * push;
    p2.knockY += ny * push;
    if (c.breakDash !== false && d2 && !both) { cancelDash(p2.strike); p2.dashTimer = 0; }
    strongest = Math.max(strongest, push);
  }
  if (can2) {
    versusState.checked[1] = true;
    const closing = Math.max(0, (p2.vel.x - player.velocity.x) * -nx + (p2.vel.y - player.velocity.y) * -ny);
    const push = (lerp(knock, knockMax, clamp01(p2.power)) + closing * carry) * share;
    applyPlayerKnockback(-nx, -ny, push);
    if (c.breakDash !== false && d1 && !both) cancelDash();
    strongest = Math.max(strongest, push);
  }
  if (both && c.breakDash !== false) { cancelDash(); cancelDash(p2.strike); p2.dashTimer = 0; }
  // The event, scaled by the shove: a tap at the low end, a full-power ram
  // into a seal closing head-on at the top.
  const t = clamp01((strongest - knock * 0.5) / Math.max(1, knockMax * 1.3 - knock * 0.5));
  const scale = lerp(c.scaleMin ?? 0.5, c.scaleMax ?? 1.8, t);
  const mx = (p1.x + p2.pos.x) * 0.5;
  const my = (p1.y + p2.pos.y) * 0.5;
  // The goo goes out along the shove (dirX/dirY): from the striker through
  // the seal it hit. Both dashing is a head-on, and it goes both ways.
  const sgn = can1 ? 1 : -1;
  feedback('bodyCheck', {
    x: mx, y: my, scale,
    dirX: nx * sgn, dirY: ny * sgn,
    vx: nx * strongest * sgn, vy: ny * strongest * sgn,
    sizeMul: 0.7 + 0.6 * t, speedMul: 0.7 + 0.8 * t,
    headOn: both,
  });
  versusState.lastCheck = { push: strongest, scale, both, x: mx, y: my };
  return true;
}

/**
 * SEAL AGAINST SEAL — two bodies that cannot overlap. Every frame they are
 * pressed together they are pushed apart, half each; on the frame they MEET
 * the ball's contest is run between them (contestMass: 1 swimming, dashMass
 * dashing) — each seal's speed toward the other times its mass — and the
 * loser is knocked back along the line at knockGain x the margin, the
 * winner holding its line. A dash's own shove is bodyCheck's, so the knock
 * here is only for two swimmers; a dash that meets a swimmer is bodyCheck's
 * event and this one's push-apart — `checked` is bodyCheck's word that it
 * fired this frame, which also covers the head-on that has just broken both
 * dashes and would otherwise read here as two swimmers meeting. See
 * CONFIG.versus.sealCollide.
 */
export function sealCollide(checked = false) {
  const c = cfg().sealCollide ?? {};
  if (c.enabled === false || !player.mesh) { versusState.touching = false; return null; }
  const cr = cfg().bodyCheck?.contactRadius ?? 2.2;
  const p1 = player.mesh.position;
  const dx = p2.pos.x - p1.x;
  const dy = p2.pos.y - p1.y;
  const dist = Math.hypot(dx, dy) || 0.0001;
  const minD = cr * 2;
  if (dist >= minD) { versusState.touching = false; return null; }
  const nx = dx / dist; // from P1 toward P2
  const ny = dy / dist;
  // Apart, half each.
  const push = (minD - dist) * 0.5;
  p1.x -= nx * push; p1.y -= ny * push;
  p2.pos.x += nx * push; p2.pos.y += ny * push;
  const met = !versusState.touching;
  versusState.touching = true;
  const d1 = !!strikeState.active;
  const d2 = !!p2.active;
  const u1 = Math.max(0, player.velocity.x * nx + player.velocity.y * ny);
  const u2 = Math.max(0, -(p2.vel.x * nx + p2.vel.y * ny));
  const m1 = contestMass(d1, strikeState.power ?? 0);
  const m2 = contestMass(d2, p2.power);
  const margin = u1 * m1 - u2 * m2; // positive: P1 wins
  let knock = 0;
  let loser = -1;
  if (met && !checked && !d1 && !d2 && Math.abs(margin) > 0.01) {
    loser = margin > 0 ? 1 : 0;
    if (sealVulnerable(loser)) {
      knock = Math.min(c.knockMax ?? 60, (c.knockGain ?? 1.2) * Math.abs(margin));
      const sgn = loser === 1 ? 1 : -1;
      shoveSeal(loser, nx * sgn, ny * sgn, knock);
      if (knock > 0.5) {
        feedback('bodyCheck', {
          x: (p1.x + p2.pos.x) * 0.5, y: (p1.y + p2.pos.y) * 0.5,
          scale: 0.5 + 0.6 * clamp01(knock / (c.knockMax ?? 60)),
          dirX: nx * sgn, dirY: ny * sgn, vx: nx * sgn * knock, vy: ny * sgn * knock,
          sizeMul: 0.6, speedMul: 0.6, headOn: false,
        });
      }
    }
  }
  versusState.lastCollide = { met, margin, loser, knock, push };
  return versusState.lastCollide;
}

/**
 * The goal's shutter, on the WALL clock. Returns the scale main.js folds into
 * realDt. Runs every frame, run or no run, so a match never sticks frozen.
 */
export function updateVersusClock(rawDt) {
  if (!versusState.active) { versusState.timeScale = 1; return 1; }
  // THE LOOK RUNS ON THE WALL CLOCK, and this is the only place that has it.
  // The goal shutter drops the world to a near stop for a third of a second
  // with the camera punched all the way in on the ball — exactly when it is
  // most looked at. A warp advanced on the dilated clock would freeze there
  // and read as the effect having broken.
  updateBallLook(rawDt);
  driveOutline();
  // Player 2's circle HUD, on real time like player 1's (main.js hands
  // updateStrikeRing realDt): a hit-stop must not stall the readout.
  if (p2.ring && p2.mesh) p2.ring.update(rawDt, p2.mesh.position, p2.strike, versusState.active && !versusState.dead[1], player.stats);
  const k = cfg().clock ?? {};
  const st = versusState;
  st.phaseT += rawDt;
  let scale = 1;
  if (st.goT > 0) {
    st.goT -= rawDt;
    if (st.goT <= 0) { st.goT = 0; hideCount(); }
  }
  if (st.phase === 'kickoff') {
    const ko = cfg().kickoff ?? {};
    scale = k.freezeScale ?? 0.04;
    const tick = Math.max(0.05, ko.tick ?? 0.8);
    const from = Math.max(1, Math.round(ko.count ?? 3));
    // Which numeral is due: `from` at t=0, one fewer every tick, 0 = whistle.
    const due = Math.max(0, from - Math.floor(st.phaseT / tick));
    if (due !== st.count) {
      st.count = due;
      if (due > 0) {
        showCount(String(due));
        feedback('versusCountdown', { x: ball.x, y: ball.y, scale: 1 + 0.15 * (from - due) });
      } else {
        whistle();
      }
    }
    if (st.phase === 'kickoff' && due === 0) { st.phase = 'play'; st.phaseT = 0; scale = 1; }
  } else if (st.phase === 'scored') {
    const freeze = k.freeze ?? 0.35;
    const ramp = k.ramp ?? 0.45;
    const floor = k.freezeScale ?? 0.04;
    if (st.phaseT < freeze) scale = floor;
    else if (st.phaseT < freeze + ramp) {
      const t = (st.phaseT - freeze) / ramp;
      scale = lerp(floor, 1, t * t * (3 - 2 * t));
    }
    // The ball comes back and the match goes to a kickoff; the number flies
    // up to the strip over the countdown's first beat.
    if (!st.respawned && st.phaseT >= (k.respawn ?? 1.3)) {
      st.respawned = true;
      st.flown = true;
      flyNumber(st.scorer);
      enterKickoff();
    }
  } else if (st.phase === 'won') {
    scale = k.freezeScale ?? 0.04;
    // The winner's number has had its hold; now the question. The water
    // stays frozen under it — a prompt over a match that has quietly kicked
    // off again is a prompt nobody reads.
    if (st.phaseT >= (k.wonHold ?? 3.5)) {
      st.phase = 'over';
      st.phaseT = 0;
      showOver();
    }
  } else if (st.phase === 'over') {
    scale = k.freezeScale ?? 0.04;
    updateOver();
  }
  st.timeScale = scale;
  return scale;
}

// ---------------------------------------------------------------------------
// AFTER THE MATCH — rematch, or the main menu.
//
// Two buttons over the frozen water, and any pad in the room may answer them
// (ui/padPoll.js — input.js only reads player 1's pad, and the loser is as
// entitled to ask for another go). Left/right or the stick moves between
// them, A or Enter chooses, and a click does what a click does.
//
// A REMATCH IS THE OLD RESET: the same sides, the same colours, the scores
// back to nothing and a kickoff — exactly what the end state used to do on
// its own after the hold. The main menu is main.js's route (versusHooks.
// onMainMenu), the same one the score card takes, so it goes through the
// death transition rather than cutting.
// ---------------------------------------------------------------------------

const overPads = new Map();
let overCursor = 0;
let overKey = null;

export function rematch() {
  const st = versusState;
  if (!st.active) return;
  st.scores[0] = 0;
  st.scores[1] = 0;
  hideOver();
  hideBig();
  paintScores();
  enterKickoff();
}

function chooseOver(i) {
  overCursor = i;
  paintOver();
  if (i === 0) rematch();
  else { hideOver(); versusHooks.onMainMenu?.(); }
}

function updateOver() {
  if (!ui?.over) return;
  for (const p of pollPads(overPads)) {
    if (p.press.left || p.press.up) { overCursor = 0; paintOver(); }
    else if (p.press.right || p.press.down) { overCursor = 1; paintOver(); }
    else if (p.press.a || p.press.start) { chooseOver(overCursor); return; }
  }
}

function onOverKey(e) {
  if (!ui?.over || ui.over.hidden) return;
  switch (e.key) {
    case 'ArrowLeft': case 'ArrowUp': case 'a': case 'w': overCursor = 0; paintOver(); break;
    case 'ArrowRight': case 'ArrowDown': case 'd': case 's': overCursor = 1; paintOver(); break;
    case 'Enter': case ' ': chooseOver(overCursor); break;
    default: return;
  }
  e.preventDefault();
  e.stopPropagation();
}

function paintOver() {
  if (!ui?.over) return;
  ui.overButtons.forEach((b, i) => b.classList.toggle('sv-nav-sel', i === overCursor));
}

function showOver() {
  if (!ui?.over) return;
  overCursor = 0;
  overPads.clear();
  ui.over.hidden = false;
  paintOver();
  if (!overKey && typeof window !== 'undefined') {
    overKey = onOverKey;
    window.addEventListener('keydown', overKey, true);
  }
}

function hideOver() {
  if (ui?.over) ui.over.hidden = true;
  if (overKey && typeof window !== 'undefined') {
    window.removeEventListener('keydown', overKey, true);
    overKey = null;
  }
}

function goal(side) {
  const st = versusState;
  // The ball in the LEFT goal is P2's point.
  const scorer = side === 'left' ? 1 : 0;
  st.scores[scorer] += 1;
  st.goals += 1;
  st.scorer = scorer;
  st.lastGoal = { side, scorer, x: ball.x, y: ball.y };
  ball.live = false;
  ball.vx = ball.vy = 0;
  st.phaseT = 0;
  st.flown = false;
  st.respawned = false;
  // THE GOAL'S OWN EVENTS, at the mouth rather than where the ball is — the
  // ball is off the edge of the screen by definition when this is called.
  // The spray is thrown back out of the hole into the water (dirX). Two
  // events, as a boss blow is: the impact and the cheer, tuned side by side
  // in the F panel's Versus section.
  const mouthX = side === 'left' ? bounds.left : bounds.right;
  const out = side === 'left' ? 1 : -1;
  const at = { x: mouthX, y: ball.y, dirX: out, dirY: 0, vx: out * 20, vy: 0, scale: 1, color: ballTint().getHex() };
  feedback('versusGoal', at);
  feedback('versusGoalCheer', at);
  // ...and the jet: the ball's substance fired back out of the corridor from
  // off screen, driven off the lips. systems/goalJet.js; stepped by main.js
  // on the wall clock so it runs through the shutter's freeze.
  fireGoalJet(side === 'left' ? -1 : 1, ball.y);
  // The ball is back at centre and belongs to nobody again.
  ballEvent('reset');
  resetBallLook();
  celebrateGoal(scorer);
  flushImitation('goal');
  const toWin = cfg().toWin ?? 5;
  if (st.scores[scorer] >= toWin) {
    st.phase = 'won';
    showBig(scorer, true);
  } else {
    st.phase = 'scored';
    // The biggest kick the ball gets, and it lands on the frame the shutter
    // starts — so the warp is already blooming as the camera punches in.
    ballEvent('goal');
    showBig(scorer, false);
  }
}

// ---------------------------------------------------------------------------
// THE KICKOFF — everyone to their end, a full wheel, food in the way, and a
// count. See CONFIG.versus.kickoff.
// ---------------------------------------------------------------------------

const _start = [{ x: 0, y: 0 }, { x: 0, y: 0 }];

/** Where seal `who` stands for a kickoff: `inset` of the pitch in from its own wall, at midwater. */
export function kickoffSpot(who, out = _start[who]) {
  const ko = cfg().kickoff ?? {};
  const inset = clamp01(ko.inset ?? 0.16) * (bounds.right - bounds.left);
  out.x = who === 0 ? bounds.left + inset : bounds.right - inset;
  out.y = midWater();
  return out;
}

/**
 * Put the match at a kickoff. The ball is at centre, the seals are on their
 * spots facing in with a full wheel each, bait balls are dropped along each
 * seal's line to the ball, and the countdown starts — the world is held at
 * freezeScale from here until the whistle (updateVersusClock).
 */
export function enterKickoff() {
  const st = versusState;
  const ko = cfg().kickoff ?? {};
  st.phase = 'kickoff';
  st.phaseT = 0;
  st.count = -1;      // so the first numeral is due on the next clock tick
  st.kickoffs += 1;
  st.checked[0] = st.checked[1] = false;
  resetBall();
  ballEvent('reset');
  resetBallLook();
  kickoffSpot(0);
  kickoffSpot(1);
  holdKickoff();
  // Facing in, and the mirror resolved afresh from that facing (poseBody).
  if (p2.mesh) p2.mesh.rotation.z = Math.PI / 2;
  p2.mirrored = null;
  p2.strike.dashDir.x = -1; p2.strike.dashDir.y = 0;
  p2.input.aim.set(-1, 0);
  if (ko.enabled === false) {
    // No count: straight to play, the way the mode ran before it had one.
    st.phase = 'play';
    st.count = 0;
    return;
  }
  dropKickoffBait();
}

/** Hold both seals on their spots with a full wheel, and the ball at centre. Every frame of the count. */
function holdKickoff() {
  if (player.mesh) {
    player.mesh.position.set(_start[0].x, _start[0].y, 0);
    player.velocity.set(0, 0);
    player.knockX = player.knockY = 0;
    if (strikeState.active) { cancelDash(); player.dashTimer = 0; }
    strikeState.charge = 1;
    strikeState.pending = 0;
  }
  p2.pos.set(_start[1].x, _start[1].y, 0);
  p2.velocity.set(0, 0);
  p2.knockX = p2.knockY = 0;
  if (p2.strike.active) { cancelDash(p2.strike); p2.dashTimer = 0; }
  p2.strike.charge = 1;
  p2.strike.pending = 0;
  ball.x = (bounds.left + bounds.right) * 0.5;
  ball.y = midWater();
  ball.vx = ball.vy = 0;
  ball.spin = 0;
}

/**
 * Bait balls in each seal's way: `perSide` of them along the line from the
 * seal's spot to the ball, between `from` and `to` of the way along it,
 * scattered `spread` units up and down. Docile, on station, and awake — the
 * arriving flag would otherwise have them swim in from off screen, and
 * these are supposed to be sitting there when the count starts. A dash
 * through them culls the lot for chum, which is the race's second prize.
 */
function dropKickoffBait() {
  if (!scene) return;
  const b = cfg().kickoff?.bait ?? {};
  const per = Math.max(0, Math.round(b.perSide ?? 2));
  if (!per) return;
  // A long match with two seals who never eat would otherwise stack four
  // more balls onto the pitch every goal.
  const cap = b.maxAlive ?? 8;
  const from = clamp01(b.from ?? 0.35);
  const to = Math.max(from, clamp01(b.to ?? 0.75));
  const spread = Math.max(0, b.spread ?? 5);
  const cx = (bounds.left + bounds.right) * 0.5;
  for (let who = 0; who < 2; who++) {
    const sx = _start[who].x;
    for (let i = 0; i < per; i++) {
      if (baitBalls.size >= cap) return;
      const t = per === 1 ? (from + to) * 0.5 : from + ((to - from) * i) / (per - 1);
      const x = sx + (cx - sx) * t;
      const y = midWater() + (Math.random() - 0.5) * 2 * spread;
      const spec = devBaitBallSpec(x, y);
      spec.docile = true;
      const made = spawnBaitBall(scene, 0, 1, spec);
      if (!made) continue;
      made.arriving = false;
      for (const en of enemies) if (en.schoolId === made.id) en.entering = false;
    }
  }
}

/** The whistle: the count is over, play is live from this frame. */
function whistle() {
  const ko = cfg().kickoff ?? {};
  versusState.goT = Math.max(0, ko.goHold ?? 0.6);
  showCount(uiText('versusGo'), true);
  feedback('versusKickoff', { x: ball.x, y: ball.y, scale: 1 });
}

// ---------------------------------------------------------------------------
// THE CAMERA — a box round the subjects, and the tightest frame that holds it.
//
// Mode A boxes the ball and both seals (one screen, local play); mode B boxes
// the ball and one seal (online play — the other seal is on another screen).
// Either way: the box is padded, the zoom is the tighter of the two axes'
// fits, clamped to [1, zoomMax] — 1 because the frame at zoom 1 is already
// the water's full depth, and any wider shows the bare background past the
// scenery; zoomMax so two seals nose to nose on the ball are not a close-up
// of three noses. The centre is the box's, led a little by where the ball is
// going, and world.clampFocus keeps it inside the walls at whatever zoom the
// frame ended up at. Smoothed here, claimed at full weight every frame the way
// the dev stage parks its shot.
// ---------------------------------------------------------------------------

const camState = { x: 0, y: 0, zoom: 1, seeded: false };
const _box = { minX: 0, maxX: 0, minY: 0, maxY: 0 };

function boxInclude(x, y, first) {
  if (first) { _box.minX = _box.maxX = x; _box.minY = _box.maxY = y; return; }
  if (x < _box.minX) _box.minX = x;
  if (x > _box.maxX) _box.maxX = x;
  if (y < _box.minY) _box.minY = y;
  if (y > _box.maxY) _box.maxY = y;
}

/**
 * The frame the camera is aiming for, unsmoothed: { x, y, zoom }. `frame` is
 * the frustum at zoom 1 in world units — { w, h } — which is what the world's
 * orthographic camera's right-left and top-bottom are.
 */
export function versusCameraGoal(frame, out = { x: 0, y: 0, zoom: 1 }) {
  const c = cfg().camera ?? {};
  const mode = (c.mode ?? 'A').toUpperCase();
  const pad = c.pad ?? 9;
  const lead = c.lead ?? 0.22;
  const bx = ball.x + ball.vx * lead;
  const by = ball.y + ball.vy * lead;
  boxInclude(bx, by, true);
  boxInclude(bx - ball.r, by - ball.r, false);
  boxInclude(bx + ball.r, by + ball.r, false);
  const p1 = player.mesh?.position;
  const seals = mode === 'B'
    ? [(c.subject ?? 0) === 1 ? p2.pos : p1]
    : [p1, p2.pos];
  for (const s of seals) if (s) boxInclude(s.x, s.y, false);
  // THE GOAL, once the ball is in its zone: the mouth's face and a little of
  // the tunnel, the full band tall, blended in from the ball's own edge over
  // the zone's outer `goalZoneBlend` so the frame widens rather than jumps.
  const zone = c.goalZone ?? 0;
  if (zone > 0) {
    const side = ball.x < (bounds.left + bounds.right) * 0.5 ? -1 : 1;
    const wall = side < 0 ? bounds.left : bounds.right;
    const d = Math.max(0, side < 0 ? ball.x - ball.r - wall : wall - (ball.x + ball.r));
    if (d < zone) {
      const blend = Math.max(0.01, c.goalZoneBlend ?? 8);
      const w = clamp01((zone - d) / blend);
      const show = Math.max(0, Math.min(c.mouthShow ?? 4, shoreOverscan()));
      const mx = rockX(side) + side * show;
      const gy = mouthY();
      const h = mouthHalfHeight();
      const fromX = bx + side * ball.r;
      boxInclude(lerp(fromX, mx, w), lerp(by, gy + h, w), false);
      boxInclude(lerp(fromX, mx, w), lerp(by, gy - h, w), false);
    }
  }

  const w = (_box.maxX - _box.minX) + pad * 2;
  const h = (_box.maxY - _box.minY) + pad * 2;
  const fitW = frame.w / Math.max(1e-6, w);
  const fitH = frame.h / Math.max(1e-6, h);
  const zoomMax = Math.max(1, c.zoomMax ?? 2);
  out.zoom = Math.max(1, Math.min(zoomMax, fitW, fitH));
  out.x = (_box.minX + _box.maxX) * 0.5;
  out.y = (_box.minY + _box.maxY) * 0.5;
  return out;
}

/**
 * The scorer's victory pose — the boss kill's roster, on one seal only. P1 is
 * the untagged player driver; P2's driver is tagged 'p2' (buildP2). Wall
 * seconds, with the peak inside the goal's freeze so the frozen frame is the
 * pose at full stretch.
 */
export function celebrateGoal(scorer) {
  const c = cfg().celebrate ?? {};
  if (c.enabled === false) return null;
  const at = scorer === 1 ? p2.pos : player.mesh?.position;
  return playCelebration({
    weights: c.poses ?? CONFIG.celebrate?.weights ?? {},
    peakAt: c.peakAt ?? 0.3,
    hold: c.hold ?? 0.9,
    release: c.release ?? 0.5,
    escorts: false,
    at: at ? { x: at.x, y: at.y } : null,
    only: scorer === 1 ? 'p2' : null,
  });
}

/** Where a fixed shot would sit: the arena's centre. The seed for the smoothing. */
export function versusFocus(out = { x: 0, y: 0 }) {
  out.x = (bounds.left + bounds.right) * 0.5;
  out.y = bounds.bottom + (CONFIG.arena.viewHeight ?? 52) * 0.5;
  return out;
}

const _goal = { x: 0, y: 0, zoom: 1 };

/**
 * Chase the goal frame and claim it. `world` is the game world (its camera's
 * frustum is the frame); `dt` is the real clock, so the shot keeps moving
 * through the goal's freeze.
 */
export function updateVersusCamera(world, dt) {
  if (!versusState.active || !world?.camera) return;
  const cam = world.camera;
  const frame = { w: cam.right - cam.left, h: cam.top - cam.bottom };
  versusCameraGoal(frame, _goal);
  const c = cfg().camera ?? {};
  if (!camState.seeded) {
    // A CUT, not a blend: the match opens on its own framing, wherever the
    // menu's shot left the camera. Seeded on the goal rather than the
    // centre so the first frame is already the right one.
    camState.x = _goal.x;
    camState.y = _goal.y;
    camState.zoom = _goal.zoom;
    camState.seeded = true;
  }
  const k = 1 - Math.exp(-(c.lerp ?? 5) * dt);
  const kz = 1 - Math.exp(-(c.zoomLerp ?? 3) * dt);
  camState.x += (_goal.x - camState.x) * k;
  camState.y += (_goal.y - camState.y) * k;
  camState.zoom += (_goal.zoom - camState.zoom) * kz;
  world.focusCamera(camState, camState.zoom, 1);
}

export function versusCameraState() { return camState; }

// ---------------------------------------------------------------------------
// DRAWING THE BALL — driven goo splats, on the particle clock.
// ---------------------------------------------------------------------------

export function renderVersus() {
  if (!versusState.active) return;
  renderBall();
}

/** The ball's splats, this frame. Bare of the mode gate so the lab can draw it. */
export function renderBall() {
  if (!ball.slots.length) return;
  const look = cfg().ball?.look ?? {};
  const n = ball.rim.length;
  const inner = Math.max(4, Math.round(n / 3));
  _rgb.set(look.color ?? 0xffd166).multiplyScalar(look.glow ?? 1.5);
  const group = ball.group;
  let k = 0;
  const slots = ball.slots;
  if (!ball.live) {
    // Gone into the goal: park every slot dead until the respawn.
    for (const s of slots) writeDriven(s, ball.x, ball.y, 1e6, 1, 0, _rgb, group);
    flushDriven();
    keepGooAlive('ball', 0.25);
    renderBallSpin(ball, rimRadiusAt);
    return;
  }
  // The centre.
  if (k < slots.length) writeDriven(slots[k++], ball.x, ball.y, 0, 1, look.coreSize ?? 1.0, _rgb, group);
  // The inner ring, riding the rim's offsets at a fraction so a dent reads
  // through the body rather than only on the skin. In the ball's frame like
  // the rim, so it turns with the spin.
  const innerAt = (look.innerAt ?? 0.42);
  for (let i = 0; i < inner && k < slots.length; i++) {
    const j = Math.round((i / inner) * n) % n;
    const a = rimAngle(j);
    const rad = (rimRadius(j) - ball.r) * 0.5 + ball.r * innerAt;
    writeDriven(slots[k++], ball.x + Math.cos(a) * rad, ball.y + Math.sin(a) * rad, 0, 1, look.innerSize ?? 0.8, _rgb, group);
  }
  // The rim.
  const inset = look.inset ?? 0.72;
  for (let i = 0; i < n && k < slots.length; i++) {
    const a = rimAngle(i);
    const rad = rimRadius(i) * inset;
    writeDriven(slots[k++], ball.x + Math.cos(a) * rad, ball.y + Math.sin(a) * rad, 0, 1, look.rimSize ?? 0.62, _rgb, group);
  }
  flushDriven();
  keepGooAlive('ball', 0.25);
  // The spin, as strokes round the rim — see systems/ballSpin.js.
  renderBallSpin(ball, rimRadiusAt);
}

// ---------------------------------------------------------------------------
// THE LAB'S DOOR — the ball on its own, no seals, no goals, no mode.
// tools/looks/ball-lab.js drives these; nothing in the run calls them.
// ---------------------------------------------------------------------------

/** Claim the ball's splats and put it at centre. Needs initParticles first. */
export function initBallAlone() {
  buildBall();
  resetBall();
  initBallSpin(overlayScene);
}

/** One gameplay step of the ball alone: the soft body, then the rigid body, walls all round. */
export function stepBallAlone(dt) {
  if (!ball.live) return;
  stepSoftBody(dt);
  stepBall(dt, false);
  updateBallSpin(ball.spin, dt);
}

/**
 * A strike from a point outside the ball. `at` is where the striker is,
 * `dir` the dash's line, `speed` how fast it arrives and `power` the wind-up.
 * The striker is moved onto the ball's contact circle along its own line
 * first, so any press near the ball lands a hit.
 */
export function strikeBallFrom(at, dir, speed, power, english = 0) {
  const c = cfg().ball ?? {};
  const cr = c.contactRadius ?? 2.2;
  const dl = Math.hypot(dir.x, dir.y) || 1;
  const dx = dir.x / dl;
  const dy = dir.y / dl;
  // The striker's line from `at` meets the contact circle where?
  const ox = at.x - ball.x;
  const oy = at.y - ball.y;
  const R = ball.r + cr - 0.3;
  const b = ox * dx + oy * dy;
  const cc = ox * ox + oy * oy - R * R;
  const disc = b * b - cc;
  let sx; let sy;
  if (cc <= 0) { sx = at.x; sy = at.y; } // already inside the circle
  else if (disc >= 0) { const t = -b - Math.sqrt(disc); sx = at.x + dx * t; sy = at.y + dy * t; }
  else {
    // The line misses: put the striker on the circle's nearest point to `at`.
    const ol = Math.hypot(ox, oy) || 1;
    sx = ball.x + (ox / ol) * R;
    sy = ball.y + (oy / ol) * R;
  }
  const vel = { x: dx * speed, y: dy * speed };
  ball.dashHit[0] = false;
  return sealContact(0, { x: sx, y: sy }, vel, true, { x: dx, y: dy }, power, english);
}

/** Release the ball's splats. */
export function disposeBallAlone() {
  for (const s of ball.slots) releaseDriven(s);
  ball.slots.length = 0;
  ball.live = false;
}

// ---------------------------------------------------------------------------
// THE SCORE — a strip of numerals at the top, and the big one at centre.
// ---------------------------------------------------------------------------

let ui = null;

const STYLE = `
.sv-versus { position: fixed; inset: 0; pointer-events: none; z-index: 7; font-family: var(--sv-font, system-ui, sans-serif); color: #e8ecf3; }
.sv-versus[hidden] { display: none !important; }
.sv-versus-hud { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 22px; }
.sv-versus-side { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.sv-versus-score { font-size: 34px; font-weight: 700; line-height: 1; min-width: 1.2ch; text-align: center; transition: transform .25s cubic-bezier(.2,.8,.2,1); }
.sv-versus-score.sv-versus-pop { transform: scale(1.35); }
.sv-versus-sep { width: 3px; height: 30px; border-radius: 2px; background: rgba(232,236,243,0.35); }
.sv-versus-meter { width: 64px; height: 5px; border-radius: 3px; background: rgba(232,236,243,0.18); overflow: hidden; }
.sv-versus-meter > i { display: block; height: 100%; width: 0; border-radius: 3px; background: currentColor; }
.sv-versus-o2 { height: 3px; margin-top: 3px; background: rgba(232,236,243,0.12); }
.sv-versus-o2 > i { background: #cfe9ff; }
/* THE RUN'S OWN HUD, OFF: the XP track, the level, the score and the clock
   are dead numbers in a match, and the player bars (health, air, fuel — the
   column in the corner or beside the seal) go with them: the strip above
   carries each seal's wheel and air, side by side, and nothing else. */
.sv-versus-mode .sv-xptop, .sv-versus-mode #svCorner, .sv-versus-mode #svPlayerBars { display: none !important; }
.sv-versus-big { position: absolute; left: 50%; top: 42%; transform: translate(-50%, -50%); transform-origin: 50% 50%; text-align: center; opacity: 0; }
.sv-versus-big.sv-versus-in { animation: svVersusPop .32s cubic-bezier(.2,.9,.2,1.2) forwards; }
.sv-versus-bignum { font-size: 22vmin; font-weight: 800; line-height: 1; text-shadow: 0 0 24px rgba(0,0,0,.45); }
.sv-versus-line { font-size: 4vmin; font-weight: 600; margin-top: 1vmin; opacity: .9; }
.sv-versus-line:empty { display: none; }
.sv-versus-count { position: absolute; left: 50%; top: 42%; transform: translate(-50%, -50%); text-align: center; opacity: 0; font-size: 26vmin; font-weight: 800; line-height: 1; text-shadow: 0 0 24px rgba(0,0,0,.45); }
.sv-versus-count.sv-versus-go { font-size: 16vmin; }
/* THE PROMPT after a match. The only part of this layer that takes the
   pointer; the rest is a HUD. Under the big number (top 42%) so the winner's
   score stays readable over it. */
.sv-versus-over { position: absolute; left: 50%; top: 68%; transform: translate(-50%, -50%); pointer-events: auto; display: flex; flex-direction: column; align-items: center; gap: 14px; }
.sv-versus-over[hidden] { display: none !important; }
.sv-versus-over-title { font-size: 3.2vmin; font-weight: 600; letter-spacing: .06em; opacity: .85; text-shadow: 0 0 16px rgba(0,0,0,.5); }
.sv-versus-over-row { display: flex; gap: 14px; }
.sv-versus-over .sv-btn { pointer-events: auto; }
.sv-versus-count.sv-versus-in { animation: svVersusCount .5s cubic-bezier(.2,.9,.2,1.2) forwards; }
@keyframes svVersusCount { from { opacity: 0; transform: translate(-50%, -50%) scale(1.6); } 30% { opacity: 1; transform: translate(-50%, -50%) scale(1); } to { opacity: 1; transform: translate(-50%, -50%) scale(.92); } }
@keyframes svVersusPop { from { opacity: 0; transform: translate(-50%, -50%) scale(.4); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
`;

function cssColor(n) { return '#' + (n >>> 0).toString(16).padStart(6, '0'); }

function mountUi() {
  if (typeof document === 'undefined' || !document.body?.appendChild) return;
  const colors = (goalColors()).map(cssColor);
  if (!ui) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);
    const root = document.createElement('div');
    root.className = 'sv-versus';
    root.innerHTML = `
      <div class="sv-versus-hud">
        <div class="sv-versus-side" style="color:${colors[0]}"><div class="sv-versus-score" data-p="0">0</div><div class="sv-versus-meter"><i></i></div><div class="sv-versus-meter sv-versus-o2"><i></i></div></div>
        <div class="sv-versus-sep"></div>
        <div class="sv-versus-side" style="color:${colors[1]}"><div class="sv-versus-score" data-p="1">0</div><div class="sv-versus-meter"><i></i></div><div class="sv-versus-meter sv-versus-o2"><i></i></div></div>
      </div>
      <div class="sv-versus-big"><div class="sv-versus-bignum">0</div><div class="sv-versus-line"></div></div>
      <div class="sv-versus-count"></div>
      <div class="sv-versus-over" hidden>
        <div class="sv-versus-over-title"></div>
        <div class="sv-versus-over-row">
          <button class="sv-btn" type="button" data-over="0"></button>
          <button class="sv-btn" type="button" data-over="1"></button>
        </div>
      </div>`;
    document.body.appendChild(root);
    ui = {
      root,
      sides: [...root.querySelectorAll('.sv-versus-side')],
      scores: [...root.querySelectorAll('.sv-versus-score')],
      meters: [...root.querySelectorAll('.sv-versus-meter:not(.sv-versus-o2) > i')],
      o2: [...root.querySelectorAll('.sv-versus-o2 > i')],
      big: root.querySelector('.sv-versus-big'),
      bigNum: root.querySelector('.sv-versus-bignum'),
      line: root.querySelector('.sv-versus-line'),
      count: root.querySelector('.sv-versus-count'),
      over: root.querySelector('.sv-versus-over'),
      overButtons: [...root.querySelectorAll('.sv-versus-over .sv-btn')],
      colors,
    };
    ui.big.addEventListener('transitionend', onFlightEnd);
    root.querySelector('.sv-versus-over-title').textContent = uiText('versusOverTitle');
    ui.overButtons[0].textContent = uiText('versusRematch');
    ui.overButtons[1].textContent = uiText('mainMenuButton');
    ui.overButtons.forEach((b, i) => b.addEventListener('click', () => chooseOver(i)));
  }
  // THE COLOURS ARE THIS MATCH'S, not the first match's: the team select
  // picks them (versusSetup, read through goalColors), and a HUD strip that
  // kept the colours it was born with would call the green team red.
  ui.colors = colors;
  ui.sides.forEach((node, i) => { node.style.color = colors[i]; });
  ui.root.hidden = false;
  document.body.classList.add('sv-versus-mode');
  hideBig();
  paintScores();
}

function hideUi() {
  if (typeof document !== 'undefined' && document.body?.classList) document.body.classList.remove('sv-versus-mode');
  hideOver();
  if (!ui) return;
  ui.root.hidden = true;
  hideBig();
  hideCount();
}

/** The countdown's numeral (or the whistle's line) popping at centre screen. */
function showCount(text, go = false) {
  if (!ui) return;
  const el = ui.count;
  el.textContent = text;
  el.classList.toggle('sv-versus-go', go);
  el.classList.remove('sv-versus-in');
  void el.offsetWidth;
  el.classList.add('sv-versus-in');
}

function hideCount() {
  if (!ui) return;
  ui.count.classList.remove('sv-versus-in');
  ui.count.textContent = '';
}

function paintScores() {
  if (!ui) return;
  ui.scores[0].textContent = String(versusState.scores[0]);
  ui.scores[1].textContent = String(versusState.scores[1]);
}

function updateMeters() {
  if (!ui) return;
  const p1 = clamp01(strikeState.charge ?? 0);
  ui.meters[0].style.width = `${Math.round(p1 * 100)}%`;
  ui.meters[1].style.width = `${Math.round(clamp01(p2.charge) * 100)}%`;
  const maxO2 = Math.max(1, player.stats?.maxOxygen ?? CONFIG.oxygen?.max ?? 100);
  if (ui.o2[0]) ui.o2[0].style.width = `${Math.round(clamp01((player.oxygen ?? maxO2) / maxO2) * 100)}%`;
  if (ui.o2[1]) ui.o2[1].style.width = `${Math.round(clamp01(p2.oxygen / maxO2) * 100)}%`;
}

function showBig(scorer, won) {
  if (!ui) return;
  const el = ui.big;
  el.style.transition = 'none';
  el.style.transform = '';
  el.style.opacity = '';
  el.style.color = ui.colors[scorer];
  ui.bigNum.textContent = String(versusState.scores[scorer]);
  ui.line.textContent = won ? uiText('versusWinner') : '';
  el.classList.remove('sv-versus-in');
  void el.offsetWidth; // restart the pop
  el.classList.add('sv-versus-in');
  if (won) {
    // The end state paints the strip too, so both numbers agree with the big one.
    paintScores();
  }
}

function hideBig() {
  if (!ui) return;
  ui.big.classList.remove('sv-versus-in');
  ui.big.style.transition = 'none';
  ui.big.style.transform = '';
  ui.big.style.opacity = '0';
}

/** Send the big number to its slot in the strip. Lands in onFlightEnd. */
function flyNumber(scorer) {
  if (!ui) return;
  const from = ui.big.getBoundingClientRect();
  const to = ui.scores[scorer].getBoundingClientRect();
  const k = cfg().clock ?? {};
  ui.big.classList.remove('sv-versus-in');
  ui.big.style.opacity = '1';
  ui.big.style.transform = 'translate(-50%, -50%) scale(1)';
  if (!from.width || !to.width) { onFlightEnd(); return; }
  const scale = to.height / (ui.bigNum.getBoundingClientRect().height || from.height);
  const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
  const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
  ui.flight = { scorer, dx, dy, scale };
  void ui.big.offsetWidth;
  ui.big.style.transition = `transform ${k.flyTime ?? 0.6}s cubic-bezier(.3,.7,.2,1), opacity .2s ${Math.max(0, (k.flyTime ?? 0.6) - 0.2)}s`;
  ui.big.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(${scale})`;
  ui.big.style.opacity = '0';
}

function onFlightEnd() {
  if (!ui) return;
  hideBig();
  paintScores();
  const who = versusState.scorer;
  const el = ui.scores[who];
  if (!el) return;
  el.classList.remove('sv-versus-pop');
  void el.offsetWidth;
  el.classList.add('sv-versus-pop');
  setTimeout(() => el.classList.remove('sv-versus-pop'), 260);
}
