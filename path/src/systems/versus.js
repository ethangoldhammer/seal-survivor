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
// COPY. The whistle's line is `versusGo`, in uiText.csv — the score and the
// countdown are numerals, which are not prose. The END state's line is no
// longer read here at all: `versusWinner` and `versusDraw` moved onto the
// stats page with the champion block, and ui/statsCopy.js is what reads them
// now (championLabel).
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds, midWater, clampToArena } from '../arena.js';
import { createVisual } from '../assets.js';
import { playCelebration, celebrationSpin, resetCelebration, updateCelebration, celebrationState } from './celebrate.js';
import { cineLens } from './cineCamera.js';
import { poolState, resetPool, stopPool, updatePool } from './replayCams.js';
import {
  player, snarePlayer, updatePlayer, createSealState, buildSealBody, disposeSealBody, resetSealBody, poseBody,
  joltSeal, tumbleSeal, weighSeal, flingSeal, faceSeal, syncSealRagdoll,
} from '../entities/player.js';
import { tickGoalGlow, setGoalSwimmers, setGoalBall, goalGlowImpulse, flashGoalScored, clearGoalScored, resetGoalStir } from './wallRocks.js';
import { syncRosterCast, seatAccessory, seatName, rosterNames, rosterKit } from './rosterCast.js';
// ...and what the two SIDES are called, which is built out of the kit colour
// and the seals wearing it and so can only be cast once both are settled — see
// systems/teamNameCast.js for why that is the whistle and not the team select.
import { castTeamNames, teamName } from './teamNameCast.js';
// Where a multi-word adjective ends, for the short form a tag shows — see tagText.
import { splitPlayerName } from './randomName.js';
import { matchResult, isTimed, matchSeconds } from './matchRules.js';
import { dressBody } from './accessories.js';
import { isAssetLoaded } from '../assets.js';
import { worldToScreen } from '../ui/project.js';
import {
  strikeState, restoreCharge, addCharge, pipValue, cancelDash, strikeEnglish,
  createStrikeState, resetStrike, updateCharge, tryStrike, updateStrike, strikeDirection, perfectCrossed,
  chargeThrustMul, updateTurbo, comboSpeedMul, feedChum, consumeChainLinks,
} from './strike.js';
import { createStrikeRingInstance } from './strikeRing.js';
import { stateForSpeed } from './animation.js';
import { initBallSpin, disposeBallSpin, updateBallSpin, renderBallSpin, recordBallSpin, poseBallSpin, SPIN_REC } from './ballSpin.js';
import { overlayScene } from './post.js';
import { gulpPickups, bubbleOrbs, spawnBubbleOrb, pickups } from '../entities/pickups.js';
import { foodReach, foodPull, foodDistance } from './chumMagnet.js';
import { bubbleBirthPoint } from './oxygenBubble.js';
import { applyPlayerKnockback } from '../entities/player.js';
import { spawnBaitBall, devBaitBallSpec, enemies, removeEnemy, applyKnockback } from '../entities/enemies.js';
import { boats, hitsBoat, jostleBoat, damageBoat } from './boats.js';
import { baitBalls } from './baitBall.js';
import {
  claimDriven, releaseDriven, writeDriven, flushDriven, gooGroupIndex, keepGooAlive, clearLooseParticles,
} from '../entities/particles.js';
import { clearImpactFlashes } from './impactFlash.js';
import { feedback, onFeedback } from './feedback.js';
import { versusGoalScored, setMusicRateScale, musicRateScale } from './music.js';
import { setSfxRateScale } from './audio.js';
import { setAmbientRateScale } from './ambient.js';
import { uiText } from '../uiTextTable.js';
import { pollPads } from '../ui/padPoll.js';
// The HUD's stylesheet is filed UNDER the Text panel's role sheet — see
// ensureVersusStyle, and installStyleBelowRoles for why order is the whole
// mechanism.
import { installStyleBelowRoles } from '../ui/typography.js';
import { versusActive, captainPad, versusLocalMultiplayer, versusLocalTeam } from './versusFlag.js';
import { spendAirJump, airRamp } from './airborne.js';
import { updateBot, botWanted, botState, resetBot, resetBotBrains } from './versusBot.js';
// The ball's drawn edge and the seal's body — THE two shapes a contact is
// made of. See the header of ballShape.js for why they live outside this file.
import {
  solveBallSurface as solveSurface,
  ballHitRadiusAt as hitRadiusAt,
  ballHitRadius as hitRadiusMax,
  ballContactReach as contactReachAt,
  sealSpine, contactHeading, sealHeading, ballSplats, splatSize,
} from './ballShape.js';
import { features, actions, recordImitation, flushImitation, resetImitation, imitationState } from './imitation.js';
// Each seal's rim in its side's colour, and its own cut of the mottling — see
// the notes at buildSeat.
import { attachSealOutline, releaseSealOutline, setPlayerOutlineTint } from './outlines.js';
import { instanceNoise } from './noiseShader.js';
import { rosterSize, teamOfSeat, seatsOfTeam, sameTeam, seatIsCpu, seatPad, seatFormation, resetRoster, setRosterSize, rosterPerSide, MAX_PER_SIDE } from './sealRoster.js';
import { resetTally, noteTallyGoal, noteTallySave, accrueTallyPossession, tallySnapshot } from './versusTally.js';
import { goalColors, ballEvent, setBallDrive, setBallBody, noteBallMomentum, claimBall, teamColor, updateBallLook, resetBallLook, ballLookState, ballTint, ballOwner, recordBallLook, poseBallLook, LOOK_REC } from './ballLook.js';
import { updateBallTrail, clearBallTrail } from './ballTrail.js';
import { spitBallBubbles, resetBallSpit } from './ballSpit.js';
import { updateBallGrid, resetBallGrid } from './ballGrid.js';
import { fireGoalJet, goalJetOrigin, resetGoalJets } from './goalJet.js';
import { fireHeroLight, bossLightState, resetBossLight } from './bossLight.js';
import {
  installGoalHoles, nearestOnBlocks, tunnelDepth, goalLineX, cameraReach, rockX, mouthY, mouthHalfHeight, keeperLineDepth,
} from './versusGoal.js';
import {
  reelState, resetReel, requestClip, harvestClips, buildPlaylist, nextClip, kindCfg,
} from './versusReel.js';

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
  introduced: false,      // the two sides have been named on a kickoff card this match
  // THE RECENTRE BEFORE THE COUNT. A kickoff is called from wherever the goal
  // was — the frame is punched into a mouth at the far end of the pitch — and
  // the count used to start on that same frame, so "3" and "2" were read over
  // a camera still flying back up the arena. `settled` is false from
  // enterKickoff until the shot has arrived at the kickoff framing (or
  // `settleMax` has run out, so a camera that never converges cannot hang a
  // match); the count's clock does not start until it is true.
  settled: true,
  settleT: 0,             // wall seconds spent recentring
  // THE GATHER — the same idea one beat earlier, for the BODIES rather than
  // the frame. A goal throws every seal in the mouth across the pitch
  // (goalBlast) and the kickoff used to teleport them from wherever that left
  // them onto their marks in one frame, mid-tumble. `gathered` is false from
  // the goal's kickoff until every body has been eased onto its spot over
  // `kickoff.gather` wall seconds; like `settled`, the count's clock does not
  // start until it is true. True on every other way into a kickoff — see the
  // `gather` argument to enterKickoff.
  gathered: true,
  gatherT: 0,             // wall seconds into the ease
  wallDt: 0,              // the raw delta updateVersusClock was last handed
  kickoffs: 0,            // how many kickoffs this session, for the harness
  // THE MATCH'S SEED for where the two formations stand each kickoff. Rolled
  // once, in startVersus, and spent by kickoffScatter as a pure function of
  // the kickoff's number — so every caller asking where seat 3 starts gets the
  // same answer, and a harness that wants a repeatable match pins this.
  kickoffSeed: 0,
  goT: 0,                 // wall seconds the whistle's line has left on screen
  lastPost: null,         // { side, nx, ny, x, y } of the last post/lip hit, for the harness
  lastImpact: null,       // the payload of the ball's last impact event, for the harness
  lastTouch: null,        // { t, who, kind, x, y } — the last seal to touch the ball, for the replay
  touches: [],            // the last few touches, oldest first — the assist is read off these
  names: ['', ''],        // each seal's name for the goal card, rolled at startVersus
  lastCross: null,        // { dir, t } of the ball's last pass through the surface, for the harness
  lastJostle: null,       // the last seal-on-seal shove, for the harness
  lastBlast: null,        // { side, x, y, caught } — the last goal's shockwave, for the harness
  lastBlock: null,        // the last body put in front of a moving ball, for the harness
  lastSave: null,         // ...and the last one that was a shot on target, for the harness
  replayPending: false,   // this goal has a replay coming once the freeze has had its beat
  replays: 0,             // replays played this session, for the harness
  clock: 0,               // gameplay seconds this match, for the impact fx gaps
  scorer: -1,             // who scored the goal the shutter is showing
  // WHO WON, once the match is over — and -1 with `draw` for a timed match
  // that ran out level, which is the one result a first-to cannot produce.
  // Kept apart from `scorer`: the last goal of a timed match is very often not
  // the winning side's, and reading the result off it would crown the wrong
  // team on the commonest ending there is.
  winner: -1,
  draw: false,
  timeScale: 1,           // what updateVersusClock last returned
  flown: false,           // the big number has left for the HUD this phase
  respawned: false,       // the ball is back for this phase
  chumTimer: 0,
  // PER SEAT, and grown to the roster at startVersus — see growSeatState. They
  // are indexed by SEAT, which stopped being the same number as the team the
  // moment a side had two of them in it.
  regenT: [0, 0],         // seconds until each seal's next free pip
  bubbleT: 0,             // seconds until the next bubble
  checked: [false, false], // this dash of seal i has already body-checked
  dead: [0, 0],           // seconds until seal i respawns; 0 = alive
  invuln: [0, 0],         // seconds of grace after a respawn
  bursts: 0,              // how many seals have burst this session, for the harness
  goals: 0,               // total goals this session, for the harness
  lastGoal: null,         // { side, scorer, x, y } of the last goal
  lastPierce: null,       // the ball's last contest win over a seal, for the harness
  lastSpike: null,        // the last shot driven downward — see spikeStrength
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
  // The DRAWN edge at each rim sample — the goo isoline, solved once a frame
  // from the same splats renderBall writes. This is the hitbox; see the note
  // above ballSplats for why there is no second radius.
  surf: new Float32Array(0),
  // one flag per seal: a single dash shoves the ball once, like hitThisDash
  dashHit: [false, false],
  // HOW MUCH OF A SPIKE THE SHOT IT IS ON WAS — see spikeStrength. 0 for a
  // ball nobody drove downward, 1 for a flat-down strike, up to `diveGain`
  // for one struck by a seal falling out of a breach. It belongs to the
  // FLIGHT rather than to the strike, because the thing that reads it is a
  // defender the ball meets some distance later (pierceSeal), so it is
  // cleared by whatever ends that flight and not by the next frame.
  spike: 0,
  above: false,           // which side of the surface it was on last frame (stepBall)
  // THE PINCH — see CONFIG.versus.ball.pinch. `squeeze` is 0..1 of the
  // radius given up; the two contacts that make a pinch are noted per frame.
  squeeze: 0,
  pinchAngle: 0,
  pinchHold: 0,           // seconds the pinch still counts after the contacts part
  frame: 0,
  pinch: { seal: null, wall: null },
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
/**
 * A SEAT'S BODY. createSealState() is the per-body half of `player`
 * (entities/player.js); `strike` is its own strike state, `ring` its own
 * circle HUD, `input` the shape input.js fills for player 1. The getters are
 * the vocabulary the rest of this file, the bot, the imitation logger and the
 * harness already speak (pos, vel, charge, active, power...) — one object, two
 * names for each thing, and the strike-state ones write through.
 *
 * A FACTORY rather than one object, because a match is a roster now (see
 * systems/sealRoster.js). Seat 0 is `player` and every other seat is one of
 * these, built and driven identically — which is the whole point: "player 2"
 * was an index, a team, a colour and the other end of a collision all at once,
 * and none of those had to be the same number.
 */
function makeSeal(seat) {
  const s = createSealState();
  s.seat = seat;
  s.strike = createStrikeState();
  s.ring = null;
  s.input = {
    move: new THREE.Vector2(), aim: new THREE.Vector2(1, 0), aimLive: false, aimMoved: false,
    strike: false, strikeHeld: false, strikeRelease: false, connected: false,
  };
  s.heldPrev = false;
  s.pressPrev = false;
  s.hapticT = 0;
  const parked = new THREE.Vector3();
  Object.defineProperties(s, {
    // The run's stats — the same block player 1 swims on. No upgrades in a match.
    stats: { get: () => player.stats, set() {} },
    pos: { get: () => (s.mesh ? s.mesh.position : parked) },
    vel: { get: () => s.velocity },
    root: { get: () => s.mesh },
    visual: { get: () => s.body },
    culled: { get: () => s.strike.hits },
    charge: { get: () => s.strike.charge, set: (v) => { s.strike.charge = v; } },
    pending: { get: () => s.strike.pending, set: (v) => { s.strike.pending = v; } },
    charging: { get: () => s.strike.charging, set: (v) => { s.strike.charging = v; } },
    active: { get: () => s.strike.active, set: (v) => { s.strike.active = v; } },
    power: { get: () => s.strike.power, set: (v) => { s.strike.power = v; } },
    english: { get: () => s.strike.english, set: (v) => { s.strike.english = v; } },
    dashDir: { get: () => s.strike.dashDir, set: (v) => { s.strike.dashDir = v; } },
    dashTimeLeft: { get: () => s.strike.dashTimeLeft, set: (v) => { s.strike.dashTimeLeft = v; } },
    dashDuration: { get: () => s.strike.dashDuration, set: (v) => { s.strike.dashDuration = v; } },
  });
  return s;
}

// SEAT 1, and still called p2 everywhere — it is the second captain, the one
// this mode was built around, and renaming it would be a hundred and seventy
// edits that say nothing. The seats past it are `extraSeals`.
export const p2 = makeSeal(1);

// Seats 2..n, built by the same factory and driven by the same loops. Empty in
// a 1v1, which is every match until the roster row is turned up.
const extraSeals = [];

/**
 * EVERY SEAL ON THE PITCH, in seat order: player 1 first, then p2, then the
 * rest. THE list — every rule in this file loops it rather than naming the two
 * bodies it used to be able to name, which is what makes "same rules for
 * everything" a fact about the code and not a promise in a comment.
 *
 * Rebuilt in place: this is read several times a frame and has no business
 * allocating. Seats past the ones that exist are simply not in it, so a roster
 * of four with two bodies built is a two-seal match rather than a crash.
 */
const _seals = [];
export function matchSeals() {
  _seals.length = 0;
  if (player.mesh) _seals.push(player);
  if (p2.mesh) _seals.push(p2);
  for (const s of extraSeals) if (s.mesh) _seals.push(s);
  return _seals;
}

/**
 * WHERE A SEAL IS, whichever kind it is. `player` is the run's own body and
 * carries its position on the mesh; every seat this file builds has a `pos`
 * getter for exactly that reason. One accessor, so a loop over the roster does
 * not have to keep asking which of the two it is holding.
 */
export function sealPos(seal) {
  return seal.pos ?? seal.mesh.position;
}

/** The seal in seat `i`, or null when that seat has no body. */
export function sealAt(i) {
  if (i === 0) return player.mesh ? player : null;
  if (i === 1) return p2.mesh ? p2 : null;
  const s = extraSeals[i - 2];
  return s && s.mesh ? s : null;
}

/**
 * CHANGE THE ROSTER MID-SESSION. The count is a live control (the team select's
 * roster row) rather than a constant, because whether eight seals on a pitch
 * tuned for two is a scramble or a mess cannot be answered by reading
 * anything — see the note in systems/sealRoster.js.
 *
 * Takes effect on the next match: bodies are built at startVersus, and growing
 * a roster mid-play would drop seals into the water in the middle of a rally.
 * Returns what the roster actually became.
 */
export function setMatchRoster(perSide) {
  return setRosterSize(perSide);
}

export function matchRoster() {
  return rosterPerSide();
}

/** Which seat a seal object is in — the index every per-seal array is keyed on. */
export function seatOf(seal) {
  return seal === player ? 0 : (seal?.seat ?? -1);
}

/**
 * The per-seat arrays, sized to the roster. They opened as pairs because the
 * match was a pair; every one of them is indexed by SEAT, so growing the
 * roster grows them and nothing else has to know they used to be two long.
 * Extra entries are cleared rather than left, or a seat that existed in the
 * last match arrives dead in this one.
 */
function growSeatState() {
  const n = rosterSize();
  const st = versusState;
  for (const key of ['regenT', 'dead', 'invuln']) {
    while (st[key].length < n) st[key].push(0);
    for (let i = 0; i < st[key].length; i++) st[key][i] = 0;
  }
  while (st.checked.length < n) st.checked.push(false);
  for (let i = 0; i < st.checked.length; i++) st.checked[i] = false;
  while (st.names.length < n) st.names.push('');
}

let scene = null;
// What main.js lends the match: the run's own kill path, so a fish player 2
// dashes through dies exactly as one player 1 dashes through does — the
// ledger, the feedback and the chum orb all come from there. Null in a
// harness, where the fish simply leaves the list.
// `onMainMenu` is the prompt's second button — main.js's route off a match and
// back to the bust, the same one the score card uses.
// `onBoatDestroyed` is the run's own — the ball can sink a hull now (ballHits),
// and a boat sunk by the ball has to score and ring the grid exactly like one
// sunk by a ram.
export const versusHooks = {
  onKill: null, onMainMenu: null, onBoatDestroyed: null,
  // THE POP AND THE SWALLOW, both main.js's to fire. A strike's damage goes
  // through that file's splash queue and a mouthful through its collector, and
  // neither is reachable from here — so a match asks for them the same way it
  // asks for a kill. Without these a CPU seal's strike did no damage, shoved
  // nothing, and ate nothing but what it happened to be swimming over.
  onStrikeBurst: null, onReleaseGulp: null,
  // AND ONE SEAL'S AIR TIME — the ramp, the arrival window, the slam and the
  // splash. Blubberball is a game about breaching and a CPU seal simply fell
  // back into the water: no landing, no blast, no window, nothing. See
  // stepSealAir in main.js.
  onSealAir: null,
};
const markers = [];
const _dir = { x: 0, y: 0 };
const _rgb = new THREE.Color();

// ---------------------------------------------------------------------------
// LIFECYCLE
// ---------------------------------------------------------------------------

/**
 * EVERYTHING THAT BELONGS TO ONE MATCH, back to nothing.
 *
 * Split out of startVersus because a REMATCH is a new match and has to clear
 * exactly the same things — and for a long while it cleared only the scores.
 * The clock was the one that showed: a timed match's second leg opened with
 * the first leg's sixty seconds still spent, so the whistle went on the first
 * frame of play and the match ended 0–0 before anybody had touched the ball.
 *
 * EVERY TIMESTAMP IN HERE IS MEASURED AGAINST `clock`, which is why they are
 * cleared alongside it rather than left to age out: the last touch, the last
 * cross, the save watch and the recorder's whole tape are all stamped with a
 * time that a rewound clock puts in the future.
 *
 * WHAT IS NOT HERE is anything about who is playing — the roster, the cast,
 * the team names and the kit colours all belong to the SETUP and survive a
 * rematch, which is what makes it a rematch. `kickoffs` stays too: it is what
 * rotates the formation, and a rematch turning it is the point.
 */
function resetMatchState() {
  const st = versusState;
  st.scores[0] = 0;
  st.scores[1] = 0;
  st.scorer = -1;
  st.winner = -1;
  st.draw = false;
  st.flown = false;
  st.respawned = false;
  st.gathered = true;
  st.gatherT = 0;
  st.chumTimer = 0;
  st.goals = 0;
  st.lastGoal = null;
  // The per-seat ledger — goals, assists, saves, seconds of the ball. Wiped
  // here so a rematch is not scored on top of the match before it.
  resetTally();
  // Nobody has been announced yet — see the matchup card at the kickoff.
  st.introduced = false;
  st.goT = 0;
  st.lastPost = null;
  st.lastImpact = null;
  st.lastTouch = null;
  st.touches.length = 0;
  st.lastCross = null;
  st.lastJostle = null;
  st.lastBlast = null;
  st.lastBlock = null;
  st.lastSave = null;
  st.lastPierce = null;
  st.lastSpike = null;
  st.lastCollide = null;
  st.touching = false;
  st.replayPending = false;
  st.replays = 0;
  // THE MATCH CLOCK. Zero here is what a timed match is played against
  // (timeLeft), and it is the stamp on everything cleared above.
  st.clock = 0;
  fxLast.clear();
  clearSaveWatch();
  // The tape is stamped in match seconds too — see recordFrame. Left alone, a
  // rematch's first replay would be cut from the previous match's footage.
  resetRecorder();
}

// A seed to use instead of rolling one, or null to roll. See setKickoffSeed.
let pinnedSeed = null;

/**
 * PIN WHERE EVERY KICKOFF OF THE NEXT MATCH STANDS — for the harnesses and the
 * labs, and for nothing the player ever touches.
 *
 * versusState.kickoffSeed can be written directly once a match is running, but
 * not for the OPENING kickoff: startVersus rolls the seed and then places the
 * seals, so by the time a caller has the state to write to, the first kickoff
 * has already happened on the old seed. This is the same value, set early
 * enough to matter.
 *
 * `null` puts it back to rolling, which is what a real match does.
 */
export function setKickoffSeed(seed) {
  pinnedSeed = seed == null ? null : (seed >>> 0);
}

export function startVersus(worldScene) {
  scene = worldScene;
  // The streaks draw OVER the goo, so they live in the post chain's overlay
  // scene and not in the world — see overlayScene in systems/post.js.
  initBallSpin(overlayScene);
  versusState.active = true;
  // The roster as the team select left it, or CONFIG's default on a fresh
  // session — resetRoster only re-reads CONFIG when nothing has chosen.
  resetRoster();
  growSeatState();
  resetBotBrains();
  resetMatchState();
  versusState.phase = 'play';
  versusState.phaseT = 0;
  versusState.timeScale = 1;
  versusState.count = 0;
  versusState.kickoffs = 0;
  // ...AND A NEW ROLL OF WHERE THE KICKOFFS STAND. Here rather than in
  // resetMatchState, alongside the count it is spent with: `kickoffs` survives
  // a rematch on purpose (a rematch turning the formation is the point), so a
  // rematch keeps counting up through fresh spots on this same seed, and it is
  // starting a match from the menu — where the count goes back to zero — that
  // needs a new one, or every session would open on the same two marks.
  //
  // BEFORE THE KICKOFF BELOW, and that is the whole reason this line is where
  // it is: enterKickoff places every seal, so a seed written after it would
  // leave the OPENING kickoff on whatever the last match rolled. A harness
  // setting versusState.kickoffSeed after startVersus hits the same wall,
  // which is what setKickoffSeed is for.
  versusState.kickoffSeed = pinnedSeed ?? ((Math.random() * 0x100000000) >>> 0);
  // THE CAST, as the team select left it — see systems/rosterCast.js. Seat 0
  // wears the name off the splash (the one this player already chose for
  // themselves tonight) and every other seat was rolled and re-rollable on the
  // screen before the whistle. It used to be rolled HERE, at kickoff, which
  // meant the player's own name was thrown away every match and the goal card
  // was the first place any of these names had ever appeared.
  //
  // Every SEAT gets one, not just the two captains — a teammate's pass is an
  // assist, and the card names the seal that gave it.
  versusState.names.length = 0;
  versusState.names.push(...syncRosterCast());
  // ...AND WHAT THE TWO SIDES ARE CALLED, which needs both of the above: a team
  // name is built out of the kit its captain settled on and the seals in its
  // seats. teamColor and not goalColors — a side is named after what it is
  // WEARING, and goalColors can be overridden by a look without the kits
  // changing at all.
  castTeamNames([teamColor(0), teamColor(1)]);
  resetReel();
  startRecordingEvents();
  endReplay(false);
  installSkipListeners();
  camState.seeded = false;
  // Every seat's clock, not the two captains' — see regenPips.
  versusState.regenT.fill(cfg().regen?.pipEvery ?? 3);
  versusState.bubbleT = 0;
  versusState.checked[0] = versusState.checked[1] = false;
  versusState.dead[0] = versusState.dead[1] = 0;
  versusState.invuln[0] = versusState.invuln[1] = 0;
  resetBot();
  resetImitation();

  // P1 ONTO ITS KICKOFF SPOT, the same one every other seat is placed on. It
  // used to be put at `spawnSide` of the half-width — a second, different
  // description of where a seal starts, which meant the seal holding the frame
  // was the one seal on the pitch not standing in the formation. enterKickoff
  // moves everybody onto the spots a moment later anyway, so the old number
  // bought nothing but a jump on the first frame of a match.
  //
  // Both meters open FULL: the bar normally opens dead and is filled by food,
  // but a match that starts with two seals unable to strike is a match that
  // starts with nothing happening.
  if (player.mesh) {
    const spot = kickoffSpot(0);
    player.mesh.position.set(spot.x, spot.y, 0);
    player.velocity.set(0, 0);
  }
  restoreCharge(player.stats);

  buildRoster();
  buildBall();
  // The mouths, for the seals: arena.clampToArena reads them from here on.
  installGoalHoles(true);
  mountUi();
  resetBall();
  enterKickoff();
}

// ---------------------------------------------------------------------------
// THE TEAM SELECT'S PITCH — the roster, stood up in the arena with no match
// around it.
//
// The team select used to be a panel over the MAIN MENU: a bust of one seal in
// a crop of water, while the screen underneath it was about two teams. So the
// one thing the screen is for — who is on the pitch, in what colour, wearing
// what — was the one thing you could not see until you had pressed Start.
//
// IT IS THE MATCH'S OWN ROSTER BUILDER, not a copy of it. buildRoster is what
// a match runs, so the seals here are cut from the same noise, rimmed in the
// same team colours and dressed out of the same cast (systems/rosterCast.js) as
// the ones the whistle starts — and when Start does come, nothing is rebuilt:
// startVersus walks into a pitch that is already standing.
//
// WHAT IT IS NOT is a match. `versusState.active` stays false, so the clock,
// the bot, the input, the HUD, the ball and the bait all stay where they are —
// every one of them asks that question first. What this owns is the bodies and
// where they stand.
//
// STILL WATER, DELIBERATELY. The seals idle (updateRosterPreview poses them on
// the wall clock) and nothing else moves: no ball, no kickoff count, no camera
// claim. The camera is simply the arena's own framing, which in a match's arena
// IS the pitch — which is why this needs no shot of its own.
// ---------------------------------------------------------------------------

let previewOn = false;

// THE NEXT MATCH OPENS BY BLENDING, not by cutting — set when the team select
// hands its pitch over, spent by the first frame of the match's camera. A
// one-shot rather than a mode: it describes a handover that has just happened,
// and a flag that stayed on would blend a rematch in from wherever the goal
// celebration had left the shot.
let camHandover = false;

/** Is the team select's pitch up? */
export function rosterPreviewOn() {
  return previewOn;
}

/**
 * Stand the roster up in the arena. The caller has already flipped the world
 * into a match's arena and taken the main menu's claim off the body — seat 0
 * is `player`, and a seal held in a bust pose cannot also stand on a pitch.
 */
export function showRosterPreview(worldScene) {
  scene = worldScene;
  previewOn = true;
  resetRoster();
  growSeatState();
  // The cast the screen is about to show, filled for whatever the roster is.
  syncRosterCast();
  versusState.names.length = 0;
  versusState.names.push(...rosterNames());
  // The mouths, so the pitch is the pitch and not a plain arena — and so the
  // goal lights burn in the colours the captains have picked.
  installGoalHoles(true);
  buildRoster();
  placePreview();
  previewSig = rosterSignature();
  previewFromModel = isAssetLoaded('ship');
}

// What the pitch was showing the last time it was built, so a refresh can tell
// WHICH of the four things changed. A `|`-joined string rather than a bag of
// fields: this is compared and never read apart.
let previewSig = '';

function rosterSignature() {
  return [rosterSize(), teamColor(0), teamColor(1), ...rosterKit()].join('|');
}

/**
 * Something on the screen changed — a seat added, a colour picked, a name
 * rolled, a hat cycled.
 *
 * TARGETED, AND THAT IS NOT AN OPTIMISATION FOR ITS OWN SAKE. The team select
 * calls this from render(), and render() runs on every press: a captain
 * thumbing the colour wheel steps it several times a second. A full rebuild is
 * eight GLB clones, eight rim shells and eight cuts of the mottling, so doing
 * one per press is a stutter on the one screen whose whole job is to feel
 * immediate — and it would also re-cut every seal's hide, which is seeded off
 * the seat and would visibly re-roll nothing while looking like it had.
 *
 * So: the ROSTER's size is the only thing that rebuilds. A colour is repainted,
 * a hat is swapped on its bone, and a name touches the bodies not at all —
 * names are read off the cards, not the water.
 *
 * RETURNS true when the roster's SIZE changed, which is the caller's cue to
 * re-carve the shore: the goal mouths grow with the roster (goalBand.js) and
 * the rock is cut at build, so the hole the screen is showing is a size behind
 * until somebody merges it again. The light follows on its own (refreshGoalGlow
 * reads the mouth live) — it is only the rock that has to be told, and only
 * this module knows a seat actually moved.
 */
export function refreshRosterPreview() {
  if (!previewOn || !scene) return false;
  const was = previewSig;
  syncRosterCast();
  versusState.names.length = 0;
  versusState.names.push(...rosterNames());
  const now = rosterSignature();
  if (now === was) return false;
  previewSig = now;
  const parts = was.split('|');
  if (Number(parts[0]) !== rosterSize()) {
    disposeRoster();
    growSeatState();
    installGoalHoles(true);
    buildRoster();
    placePreview();
    return true;
  }
  // The mouths are built in the team colours, so a captain stepping round the
  // wheel has just changed the light burning in each goal.
  installGoalHoles(true);
  paintRosterColors();
  // ...AND THE HATS ONLY WHEN A HAT CHANGED. Re-dressing a seat is a mesh
  // clone per seal, which was fine when the only thing that reached here was a
  // button press — an unpicked side's colour now walks the ring on the QUARTER
  // NOTE, so this runs about three times a second for as long as the screen is
  // open. Rebuilding eight hats at that rate to repaint a rim is work done to
  // arrive at the same hats.
  const kitWas = parts.slice(3).join('|');
  if (kitWas !== rosterKit().join('|')) {
    for (const seal of matchSeals()) {
      const seat = seatOf(seal);
      if (seat > 0) wearSeat(seal, seat);
    }
  }
  return false;
}

/**
 * THE SIDES' COLOUR, on everything that carries it — each seal's rim and each
 * seal's marker. Split out of buildRoster because a colour can change without
 * a body changing, which is exactly what the team select's wheel does.
 */
function paintRosterColors() {
  const colors = goalColors();
  for (const seal of matchSeals()) {
    const seat = seatOf(seal);
    // PLAYER 1 IS ON A SIDE TOO. Its rim is the run's singleton (systems/
    // outlines.js keeps one, because the wind-up throb and the damage flash
    // all live on it), so the mode TINTS that rather than building a second
    // one — and hands it back at disposeRoster.
    // ...AND THE ONE YOU ARE DRIVING WEARS A HOTTER ONE. Multipliers over
    // CONFIG.playerOutline (see CONFIG.versus.you), so the run's own rim is
    // still the one description of what a seal's outline is and this is only
    // more of it: further past the HDR bright-pass, off a wider line.
    if (seat === 0) {
      const you = cfg().you ?? {};
      const base = CONFIG.playerOutline ?? {};
      setPlayerOutlineTint(colors[teamOfSeat(0)], {
        glow: (base.glow ?? 2) * Math.max(0, you.glow ?? 1),
        thickness: (base.thickness ?? 0.14) * Math.max(0, you.thickness ?? 1),
      });
      continue;
    }
    releaseSealOutline(seal.outline);
    seal.outline = attachSealOutline(seal.body, colors[teamOfSeat(seat)]);
  }
  markers.forEach((ring, i) => {
    ring.material?.color?.set(colors[teamOfSeat(i)]);
    // ...AND IN A MATCH, ONLY UNDER A SEAL SOMEBODY IS IN. The band's job is
    // "here you are" — a thing to find in a scramble — and a bot has nobody
    // looking for it. Under every seal it was the opposite of a mark: six
    // identical circles, which is the same as none. A bot's side is on its
    // rim, two lines up, and that is the whole of a CPU seal's UI now.
    //
    // THE TEAM SELECT'S PITCH DRAWS THEM ALL. Nothing is being played there
    // and the seats are not filled in until Start (writeSetup in
    // ui/teamSelect.js), so the question has no answer yet — and that screen's
    // whole job is to show the roster, which is every seal in its side's
    // colour. Five of six marks blinking out as it opens would be a bug.
    //
    // HERE rather than in placeMarkers, because this is the hook for "the
    // roster changed without the bodies changing", and it is the one that
    // fires as a match starts.
    ring.visible = previewOn || seatIsDriven(i);
  });
}

/**
 * Take it back down.
 *
 * `keep` is Start: the match's own teardown (resetArena → resetVersus) is about
 * to run and will dispose the roster, so this only drops the flag. Doing it
 * here as well is the same work twice.
 */
export function hideRosterPreview({ keep = false } = {}) {
  if (!previewOn) return;
  previewOn = false;
  previewSig = '';
  // Start: the camera is already standing on this pitch, so the match's first
  // frame blends out of it instead of cutting. See camHandover.
  camHandover = !!keep;
  if (keep) return;   // Start: the match is about to build on top of this
  disposeRoster();
  installGoalHoles(false);
}


// Was the roster built from the real model, or from the stand-in createVisual
// hands back before the file has decoded? See rebuildLateBodies.
let previewFromModel = true;

/**
 * THE SEAL ARRIVES LATE, sometimes — and the stand-in it arrives as is a CONE
 * OF RADIUS 0.7 (see ASSETS.ship's `shape`), which next to a marker ring three
 * units across reads as a ring with nothing in it. That is the bug this is
 * here for: "the CPU seal renders with only the UI rings and no seal model".
 *
 * WHY IT IS NEW. A match used to be reached from inside a run, by which time
 * furseal.glb had long since decoded. The team select builds its roster the
 * moment the screen opens — straight off the main menu, and on a cold session
 * that can be before the file has landed. createVisual is right to hand back
 * something visible rather than nothing, and nothing in buildSeat would ever
 * ask again.
 *
 * REBUILT ONCE, the frame the model turns up, and then never: `previewFromModel`
 * latches true and this is a boolean test per frame after that. The same shape
 * as redressLate above, for the same reason — a one-off build has nothing that
 * would notice the world changing under it.
 */
function rebuildLateBodies() {
  if (previewFromModel || !scene) return;
  if (!isAssetLoaded('ship')) return;
  disposeRoster();
  growSeatState();
  installGoalHoles(true);
  buildRoster();
  placePreview();
  previewSig = rosterSignature();
}

/** Everybody onto their kickoff spot, facing the ball, including seat 0. */
function placePreview() {
  for (let i = 0; i < rosterSize(); i++) kickoffSpot(i);
  for (const seal of matchSeals()) {
    const seat = seatOf(seal);
    const spot = _start[seat] ?? _start[0];
    const pos = seat === 0 ? player.mesh?.position : sealPos(seal);
    pos?.set(spot.x, spot.y, 0);
    seal.velocity?.set(0, 0);
    // Heading AND mirror together — see faceSeal. `mirrored = null` was here,
    // asking poseBody to work the roll out from the seal's motion, and a seal
    // standing on a mark in a team-select preview has no motion to read.
    faceSeal(seal, kickoffFacing(spot));
  }
  // ...AND THE MARKS UNDER THEM. Nothing else moves a marker while the team
  // select is up — updateRosterPreview poses the bodies and touches nothing
  // in the scene — so without this every ring stays where it was made, which
  // is the origin. That is a stack of coloured circles at the waterline on
  // the one screen whose whole job is to show you which seal is yours.
  placeMarkers();
}

/**
 * One frame of the pitch while the team select is up — the seals breathing and
 * swimming on the spot, and nothing else.
 *
 * THE WALL CLOCK, because there is no run to dilate: `gameState.running` is
 * false while this is up, so main.js is not stepping the world at all and the
 * gameplay delta this would otherwise be handed is zero.
 */
export function updateRosterPreview(dt) {
  if (!previewOn) return;
  rebuildLateBodies();
  for (const seal of matchSeals()) {
    // The idle clip and the breath, exactly as the replay poses a body it is
    // not simulating (poseReplay below) — a seal frozen on frame one of a swim
    // cycle reads as the screen having crashed.
    seal.anim?.update(dt, stateForSpeed(0, false, 0), false);
    seal.breathe?.update(dt, 0);
    // Zero direction: poseBody HOLDS the facing under minTurn rather than
    // spinning on it, so this is the mirror and the roll settling, not a turn.
    poseBody(seal, dt, 0, 0);
  }
}

export function resetVersus() {
  if (!versusState.active && !ball.slots.length && !p2.root) return;
  flushImitation('reset');
  stopReel();
  resetReel();
  clearSaveWatch();
  endReplay(false);
  removeSkipListeners();
  stopRecordingEvents();
  versusState.active = false;
  versusState.phase = 'play';
  versusState.timeScale = 1;
  resetBallLook();
  if (scene) clearBallTrail(scene);
  resetBallSpit();
  // ...and the dents in the backdrop. Nothing publishes them once the match is
  // off, so the lattice clears on its own — this is so a match started again
  // does not inherit the last one's chain on its first frame.
  resetBallGrid();
  resetGoalJets();
  disposeBallSpin();
  for (const s of ball.slots) releaseDriven(s);
  ball.slots.length = 0;
  ball.live = false;
  disposeRoster();
  installGoalHoles(false);
  resetGoalStir();
  // The scorer's light, if one is still standing. Only ours: a boss kill's is
  // not this module's to take down, and the two cannot both be up anyway.
  if (bossLightState.mode === 'goal') resetBossLight();
  for (const b of _burst) { b.was = false; b.cool = 0; }
  // The markers went with disposeRoster above — it owns them now, along with
  // the bodies and rings they sit under.
  hideUi();
}

/**
 * ONE SEAT'S BODY, built exactly as initPlayer builds player 1's (less the
 * outline — see buildSealBody), with its own strike state and its own ring.
 * Every seat past 0 comes through here, so a teammate and an opponent are the
 * same animal built the same way and differ only in where they start and which
 * colour their marker is.
 */
function buildSeat(seal, x, y, facing) {
  const seat = seal.seat;
  // `facing` is a world heading in RADIANS — where the ball is from this spot,
  // not a left/right sign. It was a sign, which is the same thing only for the
  // two seats that stand on the centre lane.
  const fx = Math.cos(facing);
  const fy = Math.sin(facing);
  buildSealBody(seal, scene, { name: `seal${seat}`, celebrateTag: seat === 1 ? 'p2' : `seal${seat}` });
  resetSealBody(seal);
  resetStrike(seal.strike);
  seal.mesh.position.set(x, y, 0);
  // Heading and mirror in one call — see faceSeal. This used to write
  // rotation.z alone, which left a seal whose spot faces LEFT standing belly-up
  // from the frame it was built: resetSealBody above opens the mirror at 0 and
  // nothing on a held body ever resolves it.
  faceSeal(seal, facing);
  seal.strike.charge = 1;
  seal.hp = player.stats?.maxHp ?? seal.hp;
  seal.oxygen = Math.max(1, player.stats?.maxOxygen ?? CONFIG.oxygen?.max ?? 100);
  seal.input.aim.set(fx, fy);
  seal.input.move.set(0, 0);
  seal.input.aimLive = false;
  seal.input.strike = false;
  seal.input.strikeHeld = false;
  seal.input.strikeRelease = false;
  seal.heldPrev = false;
  seal.pressPrev = false;
  seal.hapticT = 0;
  seal.ring = createStrikeRingInstance();
  scene.add(seal.ring.mesh);
  // ITS SIDE'S COLOUR, ROUND ITS OWN BODY. Four seals in a dark frame are four
  // identical animals; the rim is what says which of them is yours before you
  // have worked out which of them is yours.
  releaseSealOutline(seal.outline);
  seal.outline = attachSealOutline(seal.body, goalColors()[teamOfSeat(seat)]);
  // ...and re-tinted, never rebuilt, when a captain steps round the wheel —
  // see paintRosterColors.
  // ...AND ITS OWN CUT OF THE MOTTLING. A GLB clone shares its template's
  // material, so without this the roster is one seal drawn four times, freckle
  // for freckle. Seeded off the SEAT rather than at random, so a seal looks
  // the same every time you play it and a screenshot is reproducible.
  instanceNoise(seal.body, sealNoiseSeed(seat));
  // ...AND WHATEVER IT WAS DRESSED IN ON THE TEAM SELECT. Seat 0 is not here:
  // the player's hat is the run's own, placed and re-placed every frame by
  // main.js's updateAccessories, and a second one hung off the same bone would
  // be two hats. See systems/rosterCast.js for why seat 0's is a pointer at
  // that one slot rather than a copy of it.
  wearSeat(seal, seat);
}

// One dressing handle per seat past 0 — kept, because taking a hat off means
// removing the mesh from the bone that holds it and nothing else will.
const _dressed = new Map();

/** Put seat `i`'s accessory on `seal`, taking off whatever was there. */
function wearSeat(seal, i) {
  const was = _dressed.get(i);
  if (was) { was.remove(); _dressed.delete(i); }
  if (!seal?.body) return;
  const key = seatAccessory(i);
  if (!key) return;
  const worn = dressBody(seal.body, key);
  if (worn) _dressed.set(i, worn);
}

/**
 * THE HAT ARRIVES LATE, sometimes. dressBody places ONCE, and before
 * preloadAssets has landed the model createVisual hands back the stand-in
 * primitive — correct to place against, and permanent, since a one-off
 * placement has nothing that would ever ask again. So the roster is re-dressed
 * on the frame the real model turns up, once per seat, and then never again.
 *
 * Cheap enough to run every frame: it is a Map lookup and a boolean per seat
 * until something actually changes, and it stops entirely once every handle
 * says it came from a model.
 */
function redressLate() {
  for (const [i, worn] of _dressed) {
    if (worn.fromModel) continue;
    const seal = sealAt(i);
    if (seal?.body) wearSeat(seal, i);
  }
}

/** Every hat off, on the way out of a match. */
function undressRoster() {
  for (const worn of _dressed.values()) worn.remove();
  _dressed.clear();
}

// Where in the noise field a seat's hide is cut from. Hashed off the seat so
// it is stable across matches and across runs — the alternative is a seal that
// is a different animal every kickoff, which reads as a bug rather than as
// variety. The numbers are model units and deliberately not round: a seed on a
// lattice would put two seats on the same feature of the field.
const _seedVec = new THREE.Vector3();
function sealNoiseSeed(seat) {
  const n = seat + 1;
  return _seedVec.set(
    Math.sin(n * 12.9898) * 43.758 % 17.3,
    Math.sin(n * 78.233) * 12.9898 % 13.7,
    Math.sin(n * 39.425) * 27.183 % 19.1,
  );
}

/**
 * THE WHOLE ROSTER. Seat 0 is `player`, already in the water; every other seat
 * gets a body here, and a marker ring under each in its own side's colour —
 * the rigs are all the same animal and the water is wide.
 */
function buildRoster() {
  for (let i = extraSeals.length; i < MAX_PER_SIDE * 2; i++) extraSeals.push(makeSeal(i + 2));
  const n = rosterSize();
  for (let i = 1; i < n; i++) {
    const seal = i === 1 ? p2 : extraSeals[i - 2];
    // EACH SEAT'S OWN SLOT of _start, not a shared scratch object. This used to
    // hand kickoffSpot `_start[0]` to write into, so building a roster left
    // seat 0's remembered spot holding the LAST seat's — harmless only because
    // enterKickoff happens to rewrite every one of them a few lines later.
    const spot = kickoffSpot(i);
    // Facing the ball, which for a seat off the centre lane is not the same as
    // facing straight across — see kickoffFacing.
    buildSeat(seal, spot.x, spot.y, kickoffFacing(spot));
  }
  instanceNoise(player.body, sealNoiseSeed(0));
  // One marker per seal. Built white and coloured by paintRosterColors below,
  // so the colour is written in ONE place — the team select's wheel changes it
  // without rebuilding a thing, and a second description of "which colour is
  // this seat" is a second thing to keep in step.
  //
  // CLEARED FIRST, and that omission is what put a stray ring over the water.
  // This function is called three times (a match starting, the team select's
  // pitch going up, and that pitch REBUILDING when the roster size changes)
  // and it only ever pushed. disposeRoster — the other half of the rebuild
  // pair — took down the bodies and the seal rings and never touched these, so
  // every step of the "per side" stepper left its markers in the scene for
  // good. They kept their team colour and, never being moved again (see
  // placeMarkers), sat at the world origin: a thin coloured circle at the
  // waterline with no seal in it.
  clearMarkers();
  const mk = cfg().marker ?? {};
  for (let i = 0; i < n; i++) {
    // ONE BAND FOR EVERYBODY, seat 0 included. A fatter ring under the seal you
    // drive drew straight over the strike ring already under it, so the one
    // seal with a live HUD was the one whose HUD you could not read. Which seal
    // is yours is said on the ANIMAL now — see the outline boost below.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(mk.inner ?? 2.7, mk.outer ?? 3.1, 48),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, depthWrite: false,
        opacity: mk.opacity ?? 0.55,
      }),
    );
    ring.position.z = -2.5;
    ring.renderOrder = 1;
    scene.add(ring);
    markers.push(ring);
  }
  paintRosterColors();
}

/**
 * THE SEAT MARKERS, out of the scene and freed. buildRoster is the only thing
 * that makes them, so it and disposeRoster are the only two that take them
 * away — one owner, and the rebuild pair is symmetric. Geometry and material
 * are disposed rather than dropped: the ring is a fresh THREE.Mesh per seat
 * per build, so leaking them leaks GPU buffers as well as circles.
 */
function clearMarkers() {
  for (const m of markers) {
    scene?.remove(m);
    m.geometry?.dispose();
    m.material?.dispose();
  }
  markers.length = 0;
}

/**
 * IS A PERSON IN THIS SEAT? The one question the on-seal HUD is asked — the
 * fuel ring, the banked-power core, the air band and the mark under the body
 * all draw for a seat somebody is playing and for no other.
 *
 * THE TEAM SELECT'S ANSWER, which is the only one there is: writeSetup
 * (ui/teamSelect.js) puts a `{kind}` on each captain on the way into every
 * match, and a seat past the two captains is nobody's unless it was claimed.
 * Asked here rather than at each of the three draw sites, so a bot cannot end
 * up wearing half an instrument — which is what it did while only the air
 * band knew about this.
 *
 * Seat 0 is the seal the frame belongs to and is never in question.
 */
function seatIsDriven(seat) {
  return seat <= 0 || !seatIsCpu(seat);
}

/**
 * EVERY MARKER UNDER ITS OWN SEAL, every frame.
 *
 * It used to be two lines guarded by `markers.length === 2` — written when a
 * match was a pair, and silently doing nothing from the day the roster could
 * be any other size. Three a side is six markers, the guard is false, and not
 * one of them is ever moved: they stay at the origin, which is a row of
 * coloured circles floating at the waterline rather than a mark under each
 * animal. Indexed by SEAT, like every other per-seat array in this file.
 *
 * WHETHER a mark is drawn at all is paintRosterColors's — see the note there.
 * This only moves them, including the hidden ones: a marker parked at the
 * origin is one bug away from being visible at the origin.
 */
function placeMarkers() {
  for (const seal of matchSeals()) {
    const m = markers[seatOf(seal)];
    if (!m) continue;
    const p = sealPos(seal);
    m.position.x = p.x;
    m.position.y = p.y;
  }
}


// ---------------------------------------------------------------------------
// THE NAME OVER EACH SEAL.
//
// Four identical animals in dark water is four identical animals: the rim and
// the marker say which SIDE each is on, and until now nothing said which one is
// which. The names already existed — the cast is rolled on the team select and
// the goal card spends it (systems/rosterCast.js) — they were simply never on
// the seal they belong to.
//
// DOM OVER THE CANVAS, projected, rather than a sprite in the scene. A label
// has to stay the same size and stay legible whatever the camera is doing, and
// the camera here punches in and out by a factor of four through a goal; a
// world-space label is either unreadable at the wide end or enormous at the
// close one. worldToScreen is the same projection the toasts and the seal's own
// floating bars already use — one description of where a world point lands.
//
// ONE ELEMENT PER SEAT, built once and moved, never rebuilt: this runs every
// frame, and eight labels torn down and recreated at 60Hz is a layout thrash
// for a thing whose text changes about once a match.
// ---------------------------------------------------------------------------

const _tagAt = { x: 0, y: 0 };

/**
 * WHAT A TAG SAYS — initials and the last name by default ("Phat Carney
 * Barker" is "P.C. Barker"), the whole of it on request.
 *
 * Four labels over four animals is a lot of type on a pitch, and a tag is
 * read at a glance while the ball is somewhere else. Initials are shorter than
 * the words they stand for but they are not nothing: two seals who share a
 * last name still read apart, which dropping the front of the name outright
 * would have lost. See CONFIG.versus.nameTags.show for the full one.
 *
 * MOSTLY POSITIONAL: every word but the last becomes an initial, wherever it
 * came from. The C in "P.C. Barker" is the front of a NICKNAME half ("Carney
 * Barker" is one row of sealNames.csv), so a split into adjective and nickname
 * cannot produce this on its own. It also means a name typed on the splash is
 * abbreviated like a rolled one, which is the point: the tag is a label on a
 * seal, not a reading of the table.
 *
 * EXCEPT THAT AN ADJECTIVE IS ONE INITIAL however many words it is. Four rows
 * in the table are phrases — "The One and Only", "Prime Minister" — and
 * counting words there gives "T.O.A.O. Osbourne", which is a licence plate.
 * The adjective is one idea and gets one letter: "T. Osbourne". This is the
 * one thing the position of a word cannot tell us, so it is the one thing the
 * table is asked, and only the FRONT of the name is asked about.
 *
 * THE OTHER THING POSITION GETS WRONG is a name ending in something that isn't
 * a name. "Fat Tony II" is a lineage (see randomName.js) and "Clammy Davis
 * Jr." is a hand-written row; the last word of each is a suffix, and
 * initialling what comes before it gives "F.T. II", which says less than
 * nothing. LINEAGE peels one off and carries it along, so the seal stays the
 * second of his name — before the split, since the table has no row with a
 * numeral on it.
 *
 * A single word — a bare nickname, or a one-word name from the splash — has no
 * front to abbreviate and comes back whole.
 */
// Case-SENSITIVE on purpose: "Xi" is a nickname row in sealNames.csv and a
// case-blind roman-numeral test reads it as a lineage, which would cost "Phat
// Xi" its initial. A numeral is generated uppercase and "Jr." is written the
// one way, so the case is the whole difference between a suffix and a word.
const LINEAGE = /^(?:[IVX]+|[JS]r\.?)$/;

// Array.from, not [0]: a name typed on the splash can start with an emoji, and
// half a surrogate pair renders as the replacement glyph.
const initial = (word) => Array.from(word)[0].toUpperCase();

export function tagText(name) {
  const whole = String(name ?? '').trim();
  if ((cfg().nameTags?.show ?? 'short') === 'full') return whole;
  const words = whole.split(/\s+/).filter(Boolean);
  const tail = words.length > 1 && LINEAGE.test(words[words.length - 1]) ? ` ${words.pop()}` : '';
  if (words.length < 2) return whole;
  const { adjective, nickname } = splitPlayerName(words.join(' '));
  const rest = nickname.split(/\s+/).filter(Boolean);
  const last = rest.pop();
  const heads = adjective ? [adjective, ...rest] : rest;
  return `${heads.map(initial).join('.')}. ${last}${tail}`;
}



/**
 * Move every name over its seal. `camera` is the one the frame was drawn
 * through — the match's, or a replay's, so the tags follow a swung shot
 * rather than sliding off the seals it is looking at.
 */
export function updateNameTags(camera) {
  if (!ui?.tags || !camera) return;
  const on = (versusState.active || previewOn) && (cfg().nameTags?.enabled ?? true) !== false;
  ui.tagLayer.hidden = !on;
  if (!on) return;
  const c = cfg().nameTags ?? {};
  const lift = c.lift ?? 5.2;
  const colors = goalColors();
  const seen = new Set();
  for (const seal of matchSeals()) {
    const seat = seatOf(seal);
    const tag = ui.tags[seat];
    if (!tag) continue;
    seen.add(seat);
    // DEAD SEALS HAVE NO NAME OVER THEM. A seal that burst is not in the water
    // — its tag would sit over the spot it died at until it respawned.
    const name = tagText(versusState.names[seat] ?? '');
    if (!name || versusState.dead[seat]) { tag.hidden = true; continue; }
    const p = sealPos(seal);
    // Over the animal, not on it: `lift` is in world units so the gap closes as
    // the camera pulls out, which is what keeps the label attached to the seal
    // rather than floating a fixed number of pixels above a shrinking one.
    worldToScreen(camera, p.x, p.y + lift, _tagAt);
    tag.hidden = false;
    tag.textContent = name;
    tag.style.color = cssColor(colors[teamOfSeat(seat)] ?? 0xffffff);
    tag.style.transform = `translate(${_tagAt.x.toFixed(1)}px, ${_tagAt.y.toFixed(1)}px) translate(-50%, -100%)`;
    // THE ONE YOU ARE DRIVING says so. Seat 0 is input.js's, and on a pitch of
    // four identical animals in two colours the tag is the only thing that can
    // name it without a second colour nobody has been taught.
    tag.classList.toggle('sv-versus-tag-you', seat === 0);
  }
  // Anything the roster no longer has — a side stepped down between matches.
  for (let i = 0; i < ui.tags.length; i++) if (!seen.has(i) && ui.tags[i]) ui.tags[i].hidden = true;
}

/** Take every seat past 0 back out of the water. */
function disposeRoster() {
  undressRoster();
  clearMarkers();
  for (const seal of [p2, ...extraSeals]) {
    if (seal.ring) { scene?.remove(seal.ring.mesh); seal.ring.dispose(); seal.ring = null; }
    releaseSealOutline(seal.outline);
    seal.outline = null;
    if (seal.root) disposeSealBody(seal, scene);
  }
  // Player 1's rim back to the one CONFIG carries — a run is not a side.
  setPlayerOutlineTint(null);
}

function buildBall() {
  const c = cfg().ball ?? {};
  const n = Math.max(6, Math.round(c.soft?.points ?? 24));
  ball.r = c.radius ?? 2.4;
  ball.rim = new Float32Array(n);
  ball.rimV = new Float32Array(n);
  ball.surf = new Float32Array(n);
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
  // `fill`, not two seats by name: these are one flag PER SEAL and a match
  // has been up to MAX_PER_SIDE x 2 of them since the roster grew, so writing
  // [0] and [1] left every other seat's flag standing through a kickoff.
  ball.dashHit.fill(false);
  ball.pierced.fill(false);
  ball.spike = 0;
  ball.above = ball.y > bounds.surfaceY;
  ball.squeeze = 0;
  ball.pinchHold = 0;
  ball.pinch.seal = null;
  ball.pinch.wall = null;
  ball.live = true;
  // The drawn edge, before anything asks for it. A hitbox of zero for one
  // frame is a ball that starts the kickoff inside both seals.
  solveBallSurface();
}

// ---------------------------------------------------------------------------
// THE BALL'S SHAPE — systems/ballShape.js does the arithmetic; these are the
// match's own bindings of it, so every call site here reads one argument
// shorter. The long note on why the drawn edge IS the hitbox is over there.
// ---------------------------------------------------------------------------

/** Re-solve the drawn edge at every rim sample. Once a frame, before anything collides. */
export function solveBallSurface() {
  return solveSurface(ball, rimRadius, rimAngle);
}

/** The radius the ball collides at toward a WORLD angle — the drawn edge, that way. */
export function ballHitRadiusAt(angle) {
  return hitRadiusAt(ball, angle);
}

/** The widest the drawn body reaches, for a broad phase. */
export function ballHitRadius() {
  return hitRadiusMax(ball);
}

/** How far from the ball's centre a seal arriving along `angle` first touches it. */
export function ballContactReach(angle = 0) {
  return contactReachAt(ball, angle);
}

/** The drawn edge of an undented, unstretched ball — its size at rest, in world units. */
export { ballRestRadius, ballMaxRadius } from './ballShape.js';

const _spine = { x: 0, y: 0, r: 0 };

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
  // Pinched: flattened along the pinch's axis, bulging across it — the same
  // cos(2θ) mode the squash uses, held rather than kicked, so it reads for
  // as long as the ball is being squeezed and lets go with it.
  const pinch = ball.squeeze > 0 ? ball.squeeze * (cfg().ball?.pinch?.squash ?? 1.1) * ball.r * Math.cos(2 * (a - ball.pinchAngle)) : 0;
  return ball.r + ball.rim[i] + stretch - pinch;
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
  const spinCap = im.spinCap ?? im.spinMax ?? 28;
  if (Math.abs(ball.spin) > spinCap) ball.spin = Math.sign(ball.spin) * spinCap;
  const magnus = (im.curve ?? im.magnus ?? 0.045) * (airborne ? (im.curveAir ?? im.magnusAir ?? 0.3) : 1);
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

  // THROUGH THE SURFACE, either way: the seal's breach and re-entry, as the
  // ball's own events (CONFIG.feedback.versusBallBreach / Reentry).
  const above = ball.y > bounds.surfaceY;
  if (above !== ball.above) {
    ball.above = above;
    crossSurface(above ? 1 : -1);
  }

  const rest = c.restitution ?? 0.85;
  // The radius it collides at, PER WALL: the drawn edge in that wall's own
  // direction. A dented or pinched ball is not round, and one number for the
  // whole body would put the flat side of it through the floor.
  const rDown = ballHitRadiusAt(-Math.PI / 2);
  const rUp = ballHitRadiusAt(Math.PI / 2);
  const rLeft = ballHitRadiusAt(Math.PI);
  const rRight = ballHitRadiusAt(0);

  // Floor and ceiling. The wall's normal points INTO the water.
  if (ball.y < bounds.bottom + rDown) {
    ball.y = bounds.bottom + rDown;
    notePinchWall(0, 1);
    if (ball.vy < 0) { const v = -ball.vy; ball.vy = v * rest; bounce(0, 1, v, rest); }
  } else if (ball.y > bounds.top - rUp) {
    ball.y = bounds.top - rUp;
    if (ball.vy > 0) { const v = ball.vy; ball.vy = -v * rest; bounce(0, -1, v, rest); }
  }

  // The side walls. Plain walls in the lab; in a match each has a mouth cut
  // in it, and the ball meets the rock either side of the mouth, its posts
  // and its lips — see collideMouth — before the goal line is asked.
  if (!goals) {
    if (ball.x < bounds.left + rLeft) {
      ball.x = bounds.left + rLeft;
      notePinchWall(1, 0);
      if (ball.vx < 0) { const v = -ball.vx; ball.vx = v * rest; bounce(1, 0, v, rest); }
    } else if (ball.x > bounds.right - rRight) {
      ball.x = bounds.right - rRight;
      notePinchWall(-1, 0);
      if (ball.vx > 0) { const v = ball.vx; ball.vx = -v * rest; bounce(-1, 0, v, rest); }
    }
    return;
  }
  if (ball.x - rLeft < bounds.left) { if (collideMouth(-1, rest)) return; }
  else if (ball.x + rRight > bounds.right) { if (collideMouth(1, rest)) return; }
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
  // The broad phase only. Every answer below is re-measured toward the
  // contact it is actually about, because a body that is not round has a
  // different radius for the post than for the lip beside it.
  const rMax = ballHitRadius();
  // The drawn face, not the wall's line — see rockX.
  const wallX = rockX(side);
  nearestOnBlocks(side, ball.x, ball.y, _blocks);
  for (const b of _blocks) {
    let dx = ball.x - b.qx;
    let dy = ball.y - b.qy;
    let d = Math.hypot(dx, dy);
    if (d >= rMax) continue;
    if (d < 1e-6) {
      // The centre is inside the rock (a fast frame through a corner): out
      // along the wall's own normal, into the water.
      dx = -side; dy = 0; d = 1;
    }
    const nx = dx / d;
    const ny = dy / d;
    // The drawn edge on the side facing this block, which is where the rock
    // is actually touching it.
    const r = ballHitRadiusAt(Math.atan2(-ny, -nx));
    if (d >= r) continue;
    ball.x = b.qx + nx * r;
    ball.y = b.qy + ny * r;
    notePinchWall(nx, ny);
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
  const rBack = ballHitRadiusAt(side < 0 ? Math.PI : 0);
  if (side < 0 ? ball.x - rBack < backX : ball.x + rBack > backX) {
    ball.x = backX - side * rBack;
    if (side < 0 ? ball.vx < 0 : ball.vx > 0) { const v = Math.abs(ball.vx); ball.vx = -side * v * rest; bounce(-side, 0, v, rest, true); }
  }
  // THE LINE: the ball's near side past goal.line, inside the tunnel and on
  // screen — see versusGoal.goalLineX.
  const line = goalLineX(side);
  // The ball's NEAR side to the line, which is its trailing edge going in.
  const rLine = ballHitRadiusAt(side < 0 ? 0 : Math.PI);
  if (side < 0 ? ball.x + rLine < line : ball.x - rLine > line) { goal(side < 0 ? 'left' : 'right'); return true; }
  return false;
}

/**
 * THE BALL THROUGH THE SURFACE. `dir` is +1 leaving the water, -1 coming
 * back in. The seal's own two crossings (CONFIG.feedback.breach / reentry)
 * as the ball's events, scaled by the vertical speed against the impact
 * model's speedRef, fired AT THE WATERLINE rather than on the ball's rim —
 * the water is what is being broken — with the ball's own colour on them.
 */
function crossSurface(dir) {
  const c = cfg().ball ?? {};
  const ref = Math.max(1, c.impact?.speedRef ?? 30);
  const t = Math.min(1, Math.abs(ball.vy) / ref);
  const event = dir > 0 ? 'versusBallBreach' : 'versusBallReentry';
  // The normal is the way the ball is going: the spray goes with it.
  ballImpactFx(event, 0, dir, t, null, 0.08, { x: ball.x, y: bounds.surfaceY });
  // A small dent on the side that met the water, and the look's kick.
  impactDent(dir > 0 ? -Math.PI / 2 : Math.PI / 2, 0.1 * t, Math.abs(ball.vy));
  ballEvent('bounce', { force: t * 0.6 });
  versusState.lastCross = { dir, t, vy: ball.vy, x: ball.x, t0: versusState.clock };
}

// ---------------------------------------------------------------------------
// THE PINCH — see CONFIG.versus.ball.pinch.
//
// A pinch is a seal on one side of the ball and rock on the other in the same
// frame, pushing against each other. Each contact notes itself with its
// normal (notePinchWall from the walls, the floor, the posts and the lips;
// sealContact for the seal); updatePinch reads the two at the end of the
// frame and, when they oppose, ramps `squeeze`. The squeeze takes radius off
// the ball's COLLISIONS — against the rock and the seal both — so a ball
// caught in a gap narrower than itself gets through, and squirts it along
// the rock the way the seal is shoving.
// ---------------------------------------------------------------------------

function notePinchWall(nx, ny) {
  ball.pinch.wall = { nx, ny, frame: ball.frame };
}

function notePinchSeal(nx, ny, who) {
  ball.pinch.seal = { nx, ny, who, frame: ball.frame };
}

export function updatePinch(dt) {
  const pc = cfg().ball?.pinch ?? {};
  const w = ball.pinch.wall;
  const sl = ball.pinch.seal;
  const met = pc.enabled !== false && w && sl && w.frame === ball.frame && sl.frame === ball.frame
    && (w.nx * sl.nx + w.ny * sl.ny) < -0.3;
  // The hold: a ball squeezed small enough to clear the seal stops touching
  // it for a frame or two while the seal is still pressing — the pinch is
  // still on. It lets go only once the contacts have been apart for `hold`.
  if (met) ball.pinchHold = pc.hold ?? 0.15;
  else ball.pinchHold = Math.max(0, ball.pinchHold - dt);
  const pinched = met || (ball.pinchHold > 0 && ball.squeeze > 0);
  if (pinched) {
    ball.squeeze = Math.min(pc.max ?? 0.5, ball.squeeze + (pc.rate ?? 5) * dt);
    ball.pinchAngle = Math.atan2(w.ny, w.nx);
    // THE SQUIRT: along the rock, the way the seal's shove points. The
    // tangent is the wall's normal turned a quarter; the seal's normal
    // (seal → ball) decides the sign.
    const tx = -w.ny;
    const ty = w.nx;
    const along = sl.nx * tx + sl.ny * ty;
    if (Math.abs(along) > 0.05) {
      const sgn = Math.sign(along);
      const want = (pc.squirt ?? 16) * ball.squeeze;
      const vt = ball.vx * tx + ball.vy * ty;
      if (sgn * vt < want) {
        const add = want - sgn * vt;
        ball.vx += tx * sgn * add;
        ball.vy += ty * sgn * add;
      }
    }
  } else if (ball.squeeze > 0) {
    ball.squeeze = Math.max(0, ball.squeeze - (pc.release ?? 6) * dt);
  }
  ball.frame++;
  return pinched;
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

/**
 * WHAT THIS HIT SOUNDS LIKE — the band it falls in and the shape of it.
 *
 * Returns { event, sfxOpts, skid }: which row to fire instead of `event`, the
 * per-instance pitch and ring to hand playSfx, and whether the contact also
 * dragged. See the `voice` block in CONFIG.versus.ball.fx for the argument
 * behind each number; this is only the arithmetic.
 *
 * READ OFF THE BALL AT THE MOMENT OF CONTACT, not passed in, because every
 * caller already has a different idea of what it is describing (an impulse
 * against the hardest strike, a closing speed against maxSpeed, a share of a
 * nudge) and only `k` survives that as a common currency. Spin and which side
 * of the surface it is on are facts about the BALL and are the same however
 * the hit was measured.
 */
/**
 * THE BALL'S ORDINARY TOUCH, all three weights of it — softest first.
 *
 * Exported and named because the split made "versusBallHit" stop meaning "the
 * ball was touched" and start meaning "the ball was touched, about averagely".
 * Three rows in CONFIG.feedback now cover what one used to (see ballVoice), and
 * everything that reasons about the ordinary touch has to reason about all
 * three: `versusSpike`, `versusBlock` and `versusSave` are each documented as
 * firing OVER it, and each of those claims is now about the family rather than
 * about a name.
 *
 * Spelled out at each site instead, the failure is silent in the worst way —
 * a check for the base event under a spike simply stops finding one on exactly
 * the hard shots that spike, which is to say on all of them.
 *
 * systems/online/protocol.js keeps its own literal copy on purpose: it is a
 * leaf module with no imports at all, and its test cross-checks the two.
 */
export const BALL_TOUCH_EVENTS = ['versusBallTap', 'versusBallHit', 'versusBallSmash'];

/**
 * The band-and-shape resolver, for tools/blubberball-sfx-test.mjs.
 *
 * Exposed rather than reached through the module's internals, for the reason
 * systems/audio.js exposes its bus nodes: the thing worth asserting is the
 * MAPPING — that force picks the right row and moves pitch the right way, that
 * spin lengthens rather than raises, that the two sides of the surface differ —
 * and every one of those needs a `k` and a spin set exactly, which driving real
 * collisions cannot give you. The integration (a skid firing over a bounce, the
 * throttle surviving an alternating scramble) is driven for real in the same
 * file; this is the arithmetic underneath it.
 */
export const __ballVoice = (event, k) => ballVoice(event, k);

function ballVoice(event, k) {
  const v = cfg().ball?.fx?.voice ?? {};
  if (v.enabled === false) return { event, sfxOpts: null, skid: false };

  // --- the band -------------------------------------------------------------
  // Only the body contact splits. A wall, a post, a block, a pierce and a
  // spike are already their own moments with their own voices.
  let out = event;
  if (event === 'versusBallHit') {
    if (k < (v.tapBelow ?? 0.26)) out = 'versusBallTap';
    else if (k > (v.smashAbove ?? 0.68)) out = 'versusBallSmash';
  }

  // --- how hard -------------------------------------------------------------
  // Down with force, up with a light touch. See the note in config.
  let pitch = lerp(v.pitchSoft ?? 1.2, v.pitchHard ?? 0.82, k);
  let ring = lerp(v.decaySoft ?? 0.75, v.decayHard ?? 1.4, k);

  // --- how much spin --------------------------------------------------------
  // ABSOLUTE, because a ball spinning the other way scrapes exactly as much.
  // Against the same cap the physics clamps at, so "fully spinning" means one
  // thing in both places.
  const spin = Math.min(1, Math.abs(ball.spin) / Math.max(0.01, v.spinRef ?? 28));
  pitch *= 1 + (v.spinPitch ?? 0.07) * spin;
  ring *= 1 + (v.spinRing ?? 0.55) * spin;

  // --- which side of the surface -------------------------------------------
  // `ball.above` is maintained by stepBall and is the same flag the breach and
  // reentry events are raised off, so the sound and the splash cannot disagree
  // about which medium the ball is in.
  if (ball.above) {
    pitch *= v.airPitch ?? 1.06;
    ring *= v.airRing ?? 0.85;
  } else {
    pitch *= v.waterPitch ?? 0.88;
    ring *= v.waterRing ?? 1.2;
  }

  const lo = v.pitchMin ?? 0.6, hi = v.pitchMax ?? 1.5;
  const rlo = v.ringMin ?? 0.5, rhi = v.ringMax ?? 2.2;
  return {
    event: out,
    sfxOpts: {
      pitch: Math.min(hi, Math.max(lo, pitch)),
      decayMul: Math.min(rhi, Math.max(rlo, ring)),
    },
    // A SKID IS A WALL CONTACT THAT WAS ALSO SLIDING. Both tests, because a
    // ball spinning on the spot against a wall it is barely touching is not
    // dragging along anything.
    skid: event === 'versusBallWall'
      && spin >= (v.skidSpin ?? 0.5)
      && k >= (v.skidForce ?? 0.12),
    spin,
  };
}

/**
 * WHOSE TOUCH THE SPIT IS IN. `team` on an impact payload is a SEAT (that is
 * what every caller passes and what the older readers expect), so it goes
 * through teamOfSeat rather than being used as a team index — off by one seat
 * and the spray comes out in the defending colour on every strike.
 *
 * Null for anything with no seat behind it: a wall, a post, a hull, a fish.
 */
function spitColor(seat) {
  if (seat == null || seat < 0) return null;
  return teamColor(teamOfSeat(seat));
}

function ballImpactFx(event, nx, ny, t, extra = null, gap = null, origin = null, imp = null) {
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
  // ON THE SURFACE, which is the drawn edge and not `radius`: a splash from
  // the rigid circle fired two units inside the visible body, so a bounce off
  // the floor threw its goo from the middle of the ball.
  const edge = ballHitRadiusAt(Math.atan2(-ny, -nx));
  const at = {
    x: origin ? origin.x : ball.x - nx * edge,
    y: origin ? origin.y : ball.y - ny * edge,
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
  // WHICH ROW, AND SHAPED HOW. Resolved after the throttle above and not
  // before it, which is the ordering that matters: `fxLast` is keyed on the
  // event this was CALLED with, so the one-splash-per-moment gate stays the
  // gate it always was. Keyed on the band instead, a scramble alternating taps
  // and smashes would open a fresh window per band and the ball would go back
  // to squirting goo every frame — the exact thing the gate exists to stop.
  const shaped = ballVoice(event, k);
  at.sfxOpts = { ...at.sfxOpts, ...shaped.sfxOpts };
  feedback(shaped.event, at);
  // THE DRAG, over the bounce. Its own event because it is its own sound, and
  // its `scale` is the SPIN rather than the impact — a ball creeping along a
  // wall with the spin still on it is a loud skid and a quiet bounce. No
  // picture (see the row in CONFIG.feedback), so it takes the contact point
  // and nothing else from the splash above.
  if (shaped.skid) {
    feedback('versusBallSkid', {
      x: at.x, y: at.y, dirX: nx, dirY: ny,
      scale: shaped.spin,
      sfxOpts: shaped.sfxOpts,
    });
  }
  // THE BALL'S OWN WATER, over the event's burst. Every touch comes through
  // here — a strike, a block, a pierce, a wall, a post, a hull, a fish — so
  // this is the one place that can say "the ball was hit" without each of the
  // seven callers remembering to. `k` is how hard, already clamped.
  //
  // OUT OF THE CONTACT PATCH, not off the back of the ball. This used to be a
  // burst paid through the WAKE (burstBallBubbles), which sheds from a point
  // dead astern of the heading — a point that can say how fast the ball is
  // going and nothing else. systems/ballSpit.js fires from `at`, which is the
  // drawn edge at the bearing it was actually struck, along the line it leaves
  // on, in the striker's colour: where it was hit, which way the impulse went,
  // and by whom. See CONFIG.versus.ball.spit.
  //
  // `imp` is that line when the caller knows it — the strike does, because
  // `grip` swings it off the contact normal toward the dash. Everything else
  // passes none and gets the normal, which for a wall is exact (the rock's
  // impulse IS its inward normal) and for a body is within the grip of it.
  spitBallBubbles({
    x: at.x, y: at.y,
    nx, ny,
    impX: imp?.x ?? null,
    impY: imp?.y ?? null,
    force: k,
    vx: ball.vx, vy: ball.vy,
    r: edge,
    // THE SOURCE'S COLOUR AND NOT THE BALL'S. Everything else in this function
    // is made of the ball — the splash, the goo, the trail — because it is the
    // ball coming apart. The spit is the one part of the event that is about
    // the thing that HIT it, so a wall passes nothing and comes out plain.
    color: spitColor(at.team),
  });
  // BOTH NAMES. `event` stays what the caller CALLED this with — the kind of
  // contact it was, which is the stable thing every existing reader is asking
  // about and must not start changing with how hard the hit happened to be.
  // `voice` is the row that actually fired, which is the new fact and the only
  // way anything downstream can see that the band worked.
  versusState.lastImpact = { event, voice: shaped.event, skid: shaped.skid, ...at };
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
  // THE SHOT IS OVER. A spike is a thing the BALL is carrying down a line, and
  // rock is where that line ends — everything past this bounce is a ball
  // ricocheting, not a ball being driven at somebody.
  ball.spike = 0;
  // How hard it arrived, as a share of the fastest it can go: the wall's
  // event and the post's (the F panel's Blubberball section) both ride it, goo
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
 *
 * TWO SHAPES, BOTH MEASURED. The ball is its drawn edge (ballHitRadiusAt) and
 * the seal is its own body — a capsule down the spine from tail to nose, see
 * CONFIG.versus.ball.body — so the touch is the two silhouettes meeting. It
 * used to be a circle of `contactRadius` around the seal's middle against a
 * circle of `radius` around the ball's, and both circles were wrong in the
 * same direction: a nose arriving head-on had to travel most of a body
 * length INTO the drawn ball before either circle noticed.
 *
 * `heading` is which way the nose points, in world radians — sealHeading(seal)
 * off the mesh. Null falls back to the way it is swimming; see contactHeading.
 */
export function sealContact(who, pos, vel, dashing, dashDir, power, english = 0, heading = null) {
  const c = cfg().ball ?? {};
  // The point on the seal's spine nearest the ball, and the half-thickness
  // around it — the animal, not a circle standing in for one.
  sealSpine(pos, contactHeading(ball, pos, vel, heading), ball.x, ball.y, _spine);
  const dx = ball.x - _spine.x;
  const dy = ball.y - _spine.y;
  const dist = Math.hypot(dx, dy) || 0.0001;
  const nx = dx / dist;
  const ny = dy / dist;
  const minD = ballHitRadiusAt(Math.atan2(-ny, -nx)) + _spine.r;
  if (!dashing) ball.dashHit[who] = false;
  if (dist >= minD) { ball.pierced[who] = false; return false; }

  const push = minD - dist;
  // The velocity this touch is about to change, for the possession ledger —
  // see noteBallMomentum. Taken here, once, so every branch below (a pierce, a
  // strike, a swimming nudge) is booked the same way and none of them has to
  // remember to.
  const v0x = ball.vx;
  const v0y = ball.vy;
  notePinchSeal(nx, ny, who);
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
  // A ball already going through this seal: THROUGH — no separation, no
  // second knock, nothing more until they have come apart. The knock was
  // paid on the frame it won; a knock a frame would launch the seal, and a
  // push-apart would have the ball plough the seal ahead of it for the
  // length of the pass instead of leaving it behind.
  //
  // A FRESH STRIKE IS THE ONE THING THAT BREAKS IT, and this used to sit
  // above the `strike` line rather than below it, which meant a dash into a
  // ball that was already inside you did nothing at all — not a nudge, not a
  // failed strike, nothing — for the whole length of the pass. That reads as
  // the game ignoring the button. It is worst exactly where it is least
  // deserved: a ball that won by a hair crawls through at walking pace, so
  // the dead window is seconds long rather than the two frames a real shot
  // spends inside a body. A dash re-contests it below, wins it back or is
  // broken on it, and either way is spent (ball.dashHit) — so this is one
  // more contest per dash, not one a frame.
  if (ball.pierced[who] && !strike) return true;

  // THE DEADBAND — contest.hold. The contest is a raw speed comparison with
  // ballWeight and mass both 1 for a swimming seal, so WITHOUT this any ball
  // drifting at you faster than you happen to be closing on it wins: a ball
  // rolling at 5 goes clean through a seal standing still. Under `hold` the
  // seal holds and the nudge below stops the ball, which is what a body in
  // the water should do to something barely moving.
  //
  // The margin is spent NET of the deadband, so the knock, the slow and the
  // pierce burst all ease up from nothing at the threshold instead of
  // arriving at full size the moment it is crossed.
  const won = margin - Math.max(0, contestCfg().hold ?? 0);

  if (won > 0) {
    // THE BALL WINS. It goes through the seal — the bodies overlap for the
    // few frames of the pass — slowed, and the seal is knocked back by the
    // margin. A dash that met it is a strike that failed: broken on the
    // spot, and this dash does not get another go.
    pierceSeal(who, nx, ny, contactAngle, closing, won, dashing, vel, v0x, v0y);
    noteBallMomentum(teamOfSeat(who), v0x, v0y, ball.vx, ball.vy, contactAngle);
    return true;
  }
  // Out of the seal, whatever else happens: the seal held, so the ball gives.
  // Including a seal that has just won back a ball that was going through it
  // — the pierce is over, and leaving the flag up would have the next frame
  // wave the ball through again.
  ball.pierced[who] = false;
  ball.x += nx * push;
  ball.y += ny * push;

  if (strike) {
    ball.dashHit[who] = true;
    // The strike's report (impulse, glance, spin, dent) — truthy, for callers
    // that only ask whether it landed. The cap it may leave at rises with
    // the speed it came in at: the counter-strike's return.
    const hit = strikeBall(nx, ny, contactAngle, closing, vel, dashDir, power, who, english, speedIn);
    noteBallMomentum(teamOfSeat(who), v0x, v0y, ball.vx, ball.vy, contactAngle);
    return hit;
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
    // A BODY THAT HELD IT ENDS THE SPIKE, the way the wall does: whatever the
    // ball does from here it is doing off a seal that stopped it, and the next
    // defender down the pitch is not standing in a spike's path any more.
    ball.spike = 0;
    noteBallMomentum(teamOfSeat(who), v0x, v0y, ball.vx, ball.vy, contactAngle);
    noteTouch(who, 'bump', v0x, v0y);
    // A nudge is a hit too, a small one — but a seal resting against the
    // ball closes at nothing and must not squirt goo every frame it touches.
    const f = c.fx ?? {};
    if (closing >= (f.bumpMin ?? 3)) {
      ballImpactFx('versusBallHit', nx, ny, (f.bumpShare ?? 0.35) * Math.min(1, closing / Math.max(1, c.impact?.speedRef ?? 30)), { team: who }, f.bumpGap ?? 0.35);
    }
    // ...AND A BODY IN THE WAY IS A BLOCK. Measured on the speed the BALL was
    // carrying into the seal (speedIn), not on `closing` — a seal swimming at
    // a stationary ball closes fast and has blocked nothing, and the two are
    // the same number until you separate them. See CONFIG.versus.ball.fx.
    noteBlock(who, nx, ny, contactAngle, speedIn);
  }
  return true;
}

/**
 * A SEAL WINNING THE CONTEST AGAINST A BALL THAT WAS REALLY MOVING — see the
 * Blubberball block in CONFIG.feedback. Fires OVER versusBallHit rather than
 * instead of it: the slap is what the touch sounded like and this is what it
 * was, the same way a goal's cheer sits over its bang.
 *
 * `speedIn` is the ball's speed along the contact normal BEFORE the touch.
 */
function noteBlock(who, nx, ny, contactAngle, speedIn) {
  const f = cfg().ball?.fx ?? {};
  const min = f.blockMin ?? 16;
  if (!(speedIn >= min)) return;
  const t = clamp01((speedIn - min) / Math.max(1, (f.blockRef ?? 46) - min));
  versusState.lastBlock = { who, speedIn, t, x: ball.x, y: ball.y };
  feedback('versusBlock', {
    x: ball.x - nx * ball.r, y: ball.y - ny * ball.r,
    dirX: -nx, dirY: -ny,
    scale: lerp(f.scaleMin ?? 0.35, f.scaleMax ?? 1.6, t),
    sizeMul: lerp(f.sizeMin ?? 0.6, f.sizeMax ?? 1.5, t),
    speedMul: lerp(f.speedMin ?? 0.45, f.speedMax ?? 1.9, t),
    team: who,
  });
}

// ---------------------------------------------------------------------------
// THE BALL AGAINST EVERYTHING THAT IS NOT A SEAL — see CONFIG.versus.ball.hit.
//
// A match is played in the ocean, with boats sailing over it and bait balls
// dropped into it on a clock, and until now the ball passed through every one
// of them: it was a thing only two seals could touch. It is the heaviest,
// fastest object in the water and it should behave like one.
//
// TWO DIFFERENT COLLISIONS, because a fish and a hull are not the same kind of
// obstacle:
//
//   FISH  the ball PLOUGHS THROUGH. Damage priced off how fast it was going,
//         the shove along its own heading (applyKnockback, the strike's own
//         curve, so a minnow cartwheels and a shark leans), and a kill goes
//         through the run's kill path — versusHooks.onKill is main.js's
//         onEnemyKilledFeedback — so the burst, the sound and the DROPPED CHUM
//         are the ones every other kill in the game produces. The ball keeps
//         going, `drag` slower for each body it went through.
//
//   BOATS the ball BOUNCES. A hull is solid: the nearest point on its box
//         gives the normal, the ball leaves at `restitution`, and the impulse
//         is spent as a jostle (the same torque a ram applies, so hitting an
//         end spins it) plus damage. A hull sunk by the ball scores and rings
//         the grid like one sunk by anything else — versusHooks.onBoatDestroyed.
//
// ONE HIT PER BODY PER `gap` SECONDS, stamped on the body itself. A ball at
// forty units a second crosses a shark in two frames, and without the stamp
// that is two kills' worth of damage, two shoves and two bursts on one pass.
// ---------------------------------------------------------------------------

const _ballHooks = {
  onBoatDestroyed: (b, chum) => versusHooks.onBoatDestroyed?.(b, chum),
};

function ballHits() {
  const h = cfg().ball?.hit ?? {};
  if (h.enabled === false || !ball.live || !scene) return 0;
  const speed = Math.hypot(ball.vx, ball.vy);
  if (speed < (h.minSpeed ?? 8)) return 0;
  const ref = Math.max(1, cfg().ball?.impact?.speedRef ?? 30);
  // How hard this pass is, 0..1. Capped, so a volley past the reference speed
  // does not scale without limit.
  const force = Math.min(1, speed / ref);
  const nx = ball.vx / speed;
  const ny = ball.vy / speed;
  // The broad phase: the widest the drawn body reaches. Each contact below
  // re-measures the edge toward the body it is actually touching.
  const rMax = ballHitRadius();
  const gap = Math.max(0, h.gap ?? 0.3);
  const now = versusState.clock;
  let landed = 0;

  // --- the boats, first: a bounce changes the heading the fish are hit along.
  for (let i = boats.length - 1; i >= 0; i--) {
    const b = boats[i];
    // A hull already at zero is on its way out of the list; hitting it again
    // would sink it twice.
    if (!b?.mesh || !(b.hp > 0)) continue;
    if (!hitsBoat(b, ball.x, ball.y, rMax)) continue;
    // The nearest point on the hull's box, which is the contact and the normal
    // both — the same box hitsBoat just tested against.
    const hx = b.mesh.position.x + (b.offsetX ?? 0);
    const hy = b.mesh.position.y + (b.offsetY ?? 0);
    const hl = b.halfLength ?? CONFIG.boats.radius;
    const hh = b.halfHeight ?? CONFIG.boats.radius;
    const qx = Math.max(hx - hl, Math.min(ball.x, hx + hl));
    const qy = Math.max(hy - hh, Math.min(ball.y, hy + hh));
    let ox = ball.x - qx;
    let oy = ball.y - qy;
    let d = Math.hypot(ox, oy);
    // Dead centre inside the hull (a frame that stepped clean through it):
    // out the way it came, so the ball never ends up parked in the boat.
    if (d < 1e-6) { ox = -nx; oy = -ny; d = 1; }
    const ux = ox / d;
    const uy = oy / d;
    // The narrow phase: the DRAWN edge on the side facing this hull, which is
    // shorter than the broad phase's max wherever the body is dented. Before
    // the stamp and the count, or a pass that only grazed the box would spend
    // the hull's `gap` on a hit that never happened.
    const r = ballHitRadiusAt(Math.atan2(-uy, -ux));
    if (d >= r) continue;
    // `now >= ` too: the match clock restarts, and a hull object reused from
    // an earlier match with a stamp in the future would be skipped forever.
    if (b.ballHitT != null && now >= b.ballHitT && now - b.ballHitT < gap) continue;
    b.ballHitT = now;
    landed++;
    const closing = -(ball.vx * ux + ball.vy * uy);
    jostleBoat(b, nx, ny, Math.min(1, force * (h.boatPower ?? 1.2)), { x: qx, y: qy });
    // `recoil: false` — the jostle above IS the shove, and letting damageBoat
    // add its own would count the one collision twice.
    damageBoat(scene, i, (h.boatDamage ?? 55) * force, _ballHooks, { x: nx, y: ny }, { x: qx, y: qy }, false);
    if (closing > 0) {
      const rest = h.restitution ?? (cfg().ball?.restitution ?? 0.85);
      ball.x = qx + ux * r;
      ball.y = qy + uy * r;
      ball.vx += ux * closing * (1 + rest);
      ball.vy += uy * closing * (1 + rest);
      // The wall's event, not the post's: a post is the goal's own furniture
      // and has its own sound.
      bounce(ux, uy, closing, rest, false);
    }
  }

  // --- the fish, along whatever heading the ball is on now.
  const sp2 = Math.hypot(ball.vx, ball.vy);
  const dx = sp2 > 1e-6 ? ball.vx / sp2 : nx;
  const dy = sp2 > 1e-6 ? ball.vy / sp2 : ny;
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    // A numeric, positive hp or there is nothing here to damage — and
    // subtracting from an undefined one would leave it NaN, which never dies.
    if (!e?.mesh || !(e.hp > 0)) continue;
    const ex = e.mesh.position.x;
    const ey = e.mesh.position.y;
    const gx = ex - ball.x;
    const gy = ey - ball.y;
    const gap2 = gx * gx + gy * gy;
    const own = e.radius ?? e.def?.radius ?? 0.5;
    if (gap2 > (rMax + own) ** 2) continue;
    // The drawn edge toward THIS body, so a fish sitting in a dent is not
    // ploughed by a rim that has been pushed away from it.
    const reach = ballHitRadiusAt(Math.atan2(gy, gx)) + own;
    if (gap2 > reach * reach) continue;
    if (e.ballHitT != null && now >= e.ballHitT && now - e.ballHitT < gap) continue;
    e.ballHitT = now;
    landed++;
    const dmg = (h.damage ?? 40) * force;
    if (dmg > 0) e.hp -= dmg;
    e.flash = CONFIG.fx.hitFlash;
    e.hitThisFrame = true;
    applyKnockback(e, dx, dy, Math.min(1, force * (h.power ?? 1.1)));
    // The impact, at the body rather than at the ball's centre, in the ball's
    // own colour like every other thing the ball does.
    ballImpactFx('versusBallHit', dx, dy, force, null, h.fxGap ?? 0.12, { x: ex, y: ey });
    if (e.hp <= 0) {
      // The run's kill path: the burst, the sound, the ledger and the CHUM.
      versusHooks.onKill?.(e);
      removeEnemy(scene, i);
    }
    // AND IT DOES NOT SLOW DOWN. A shot through a school is a shot through a
    // school: the ball is `mass` seals heavy and a baitfish is a few pounds of
    // it, so a body it goes through costs it nothing worth modelling. What the
    // pass costs the FISH is its life, and what it leaves behind is the chum
    // the kill path drops (versusHooks.onKill, above).
    //
    // There used to be a `hit.drag` here, and it was a units bug rather than a
    // taste: the code spent it as a SHARE of the ball's speed per body, the
    // block above it in config.js was `drag: 0.994` meaning a per-frame
    // MULTIPLIER, and the same number got typed under the same name into this
    // one. `keep = 1 - 0.994` is 0.6%, so a ball that so much as clipped one
    // minnow did not arrive slower — it stopped dead, in the water, on the
    // spot. Deleted rather than zeroed, so the stale 0.994 goes out of the
    // saved snapshot with it.
  }
  if (landed) ballEvent('bounce', { force });
  return landed;
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
 * Positive is the ball winning — but only by more than contest.hold does it
 * actually go through; see the deadband in sealContact, which is where that
 * is decided. This is the raw physics number and stays raw: the bot reads it
 * to judge how badly it is losing a ball, not just whether it is. Exported
 * for the harness and the bot.
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
 *
 * `margin` here is the margin NET of contest.hold — what the ball won by
 * over the deadband, not its raw contestMargin — so everything priced off it
 * starts at nothing where the pierce starts.
 */
function pierceSeal(who, nx, ny, contactAngle, closing, margin, dashing, vel, v0x = ball.vx, v0y = ball.vy) {
  const c = cfg().ball ?? {};
  const k = c.contest ?? {};
  const mass = Math.max(0.01, c.mass ?? 3);
  const nudgeShare = (c.bumpGain ?? 1.1) * 2 / (1 + mass);
  const t = clamp01(margin / Math.max(0.01, k.blend ?? 15));
  const slow = lerp(nudgeShare, k.pierceSlow ?? 0.3, t) * closing;
  ball.vx += nx * slow;
  ball.vy += ny * slow;
  // A DEFENDER IN A SPIKE'S PATH. The margin already rises with the ball's
  // speed and a spike is fast, so some of this is paid automatically — but not
  // enough, and not in the right shape. Standing in front of a driven ball is
  // the most committed thing a defender does and it should look like it went
  // badly: the knock is multiplied outright, and it is delivered through
  // `jostle` rather than as a bare position offset, which is what gives it the
  // velocity share (so gravity has something to act on), the heavy fall, and
  // the ragdoll. See CONFIG.versus.ball.spike.knockMul and the limp in jostle.
  const spike = Math.max(0, ball.spike ?? 0);
  const spikeKnock = 1 + spike * ((cfg().ball?.spike?.knockMul ?? 2.2) - 1);
  const knock = Math.min((k.knockMax ?? 80) * spikeKnock, (k.knockGain ?? 1.2) * margin * spikeKnock);
  // The cap moves with the multiplier too — a spike that knocked exactly as
  // far as an ordinary shot because both arrived at `knockMax` would be the
  // same bug the speed cap had.
  if (spike > 0) jostle(who, -nx, -ny, knock, 1);
  else shoveSeal(who, -nx, -ny, knock);
  if (dashing) {
    ball.dashHit[who] = true;
    if (who === 0) { if (strikeState.active) cancelDash(); player.dashTimer = 0; }
    else if (who === 1) { cancelDash(p2.strike); p2.dashTimer = 0; }
  }
  impactDent(contactAngle, 0.14 * Math.min(1, closing / 20), closing);
  noteTouch(who, 'bump', v0x, v0y);
  const f = c.fx ?? {};
  if (closing >= (f.bumpMin ?? 3)) {
    ballImpactFx('versusBallHit', nx, ny, (f.bumpShare ?? 0.35) * Math.min(1, closing / Math.max(1, c.impact?.speedRef ?? 30)), { team: who }, f.bumpGap ?? 0.35);
  }
  ballEvent('bounce', { force: Math.min(1, margin / 40), team: teamOfSeat(who) });
  ball.pierced[who] = true;
  versusState.lastPierce = { who, margin, knock, slow, dashing: !!dashing, speed: Math.hypot(ball.vx, ball.vy) };
  // THE BLOCK'S OPPOSITE, and the reason it is an event of its own: this is
  // the one contact in the match where a seal put itself in front of the ball
  // and the ball did not care. `scale` is the margin it won by.
  const pf = c.fx ?? {};
  const pMin = pf.pierceMin ?? 6;
  if (margin >= pMin) {
    const pt = clamp01((margin - pMin) / Math.max(1, (pf.pierceRef ?? 34) - pMin));
    feedback('versusPierce', {
      x: ball.x, y: ball.y,
      dirX: nx, dirY: ny,
      scale: lerp(pf.scaleMin ?? 0.35, pf.scaleMax ?? 1.6, pt),
      sizeMul: lerp(pf.sizeMin ?? 0.6, pf.sizeMax ?? 1.5, pt),
      speedMul: lerp(pf.speedMin ?? 0.45, pf.speedMax ?? 1.9, pt),
      team: who,
    });
  }
}


/**
 * A SEAL SHOVED BY A SEAL — see CONFIG.versus.bodyCheck. `push` is the
 * shove in u/s along (dx, dy); `share` is 1 for the loser of the contest and
 * winnerShare for the winner's recoil. Delivered three ways at once:
 * `velShare` of it as REAL velocity (which gravity acts on — a seal knocked
 * over the surface goes up and comes down), the rest as the decaying knock
 * offset every shove in the game uses, and a jolt on the skeleton (joltSeal:
 * a tumble in the screen plane, signed by the shove's direction, and a roll
 * about the spine). The fall is made heavy for a while (weighSeal).
 */
/**
 * HOW LONG A SHOVE OF `push` u/s leaves the body limp, in seconds — 0 for one
 * too small to be worth taking control away for. Exported so the harness and
 * the goal blast price the same shove the same way; see the note in jostle.
 */
export function limpFor(push, j = cfg().bodyCheck?.jolt ?? {}) {
  const at = j.limpAt ?? 14;
  if (!(push >= at)) return 0;
  const full = Math.max(at + 0.01, j.limpFull ?? 62);
  const t = clamp01((push - at) / (full - at));
  return lerp(j.limpMin ?? 0.3, j.limpMax ?? 1.2, t);
}

export function jostle(who, dx, dy, push, share = 1) {
  const c = cfg().bodyCheck ?? {};
  const p = push * share;
  if (!(p > 0.01)) return 0;
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l;
  const uy = dy / l;
  // THE SEAT, through sealAt. Written `who === 0 ? player : p2` when a match
  // was a pair, which quietly gave seat 4's shove to seat 1 the moment the
  // roster grew — and a body check is one of the few things in here that
  // names a seat rather than looping the roster.
  const seal = sealAt(who);
  if (!seal) return 0;
  const vs = clamp01(c.velShare ?? 0.55);
  seal.velocity.x += ux * p * vs;
  seal.velocity.y += uy * p * vs;
  shoveSeal(who, ux, uy, p * (1 - vs));
  weighSeal(seal, c.fallMul ?? 2.4, c.heavyFor ?? 1.4);
  const j = c.jolt ?? {};
  // A shove to the right tumbles the body clockwise, the way a hit on the
  // left flank of an animal in profile would; the roll follows the vertical.
  const spinSign = ux >= 0 ? -1 : 1;
  const rollSign = uy >= 0 ? 1 : -1;
  const spin = spinSign * (j.spin ?? 0.09) * p;
  const roll = rollSign * (j.roll ?? 0.14) * p;
  // A WOBBLE OR A RAGDOLL, and which one is how hard it was.
  //
  // Every shove used to be a jolt — the spring-loaded wobble, which is right
  // for a shoulder in a rally and wrong for everything above it. A seal that
  // has just been body-checked at speed, or knocked aside by a driven ball,
  // should go LIMP for a moment and swim out of it: the spring is switched off
  // (tumbleSeal), the body keeps turning at the rate it was thrown at, and the
  // skeleton hangs while it does (syncJoltLimp in entities/player.js, which
  // reads the same `free` clock this sets).
  //
  // The window is scaled by the shove, so the two ends of the range are a
  // graze that is over before it is noticed and a hit that takes a second of
  // the match away from whoever took it. Under `limpAt` there is no ragdoll at
  // all and the old wobble is what happens — losing that would make a scramble
  // in front of the mouth into eight animals with no control, which is not a
  // scramble, it is a bug.
  const limp = limpFor(p, j);
  if (limp > 0) tumbleSeal(seal, spin, roll, limp, ux, uy, Math.min(j.kickMax ?? 14, (j.kickGain ?? 0.22) * p));
  else joltSeal(seal, spin, roll);
  versusState.lastJostle = { who, push: p, share, vel: p * vs, knock: p * (1 - vs), ux, uy, limp };
  return p;
}

/** Push seal `who` (0 = player 1, 1 = player 2) along (dx, dy) at `speed`, as a decaying shove. */
function shoveSeal(who, dx, dy, speed) {
  if (!(speed > 0.01)) return;
  if (who === 0) { applyPlayerKnockback(dx, dy, speed); return; }
  // ANY other seat, not only seat 1 — see the note in jostle. p2 used to be
  // the whole of "not the player".
  const seal = sealAt(who);
  if (!seal) return;
  const l = Math.hypot(dx, dy) || 1;
  const push = Math.min(speed, CONFIG.playerKnockback?.maxSpeed ?? 60);
  seal.knockX += (dx / l) * push;
  seal.knockY += (dy / l) * push;
}

// Where the last goal went off, reused — this runs once per goal.
const _blastAt = { x: 0, y: 0 };

/**
 * THE GOAL'S SHOCKWAVE — every seal near the bang thrown away from it and
 * left tumbling. See CONFIG.versus.goalJet.blast.
 *
 * WHERE THE BANG IS is goalJetOrigin: the point the jet's lobes are born
 * from, deep inside the tunnel. Not the mouth, and not the ball — the mouth
 * would give a keeper on its own line and a striker out in the water the
 * same shove, which is the one thing a goal's explosion must not do, and the
 * ball is already off the edge of the screen when this is called. Taking it
 * off the jet means retuning where the goo comes from moves the shove with
 * it, rather than leaving two explosions in two places.
 *
 * DELIVERED THROUGH JOSTLE, the same call a body check makes: a share as
 * real velocity that gravity then acts on, the rest as the decaying knock
 * offset, a heavy fall for a beat and a small jolt on the skeleton. A blast
 * is a shove, and there is one description in this file of what a shoved
 * seal does. What it adds on top is the RAGDOLL — tumbleSeal, which switches
 * the righting spring off for `tumbleFor` seconds so the body goes end over
 * end instead of wobbling back to true on the next frame.
 *
 * ON THE LIVE GOAL, replay or no replay, which is why it is not gated the way
 * the jet and the celebration are. Those are SHOTS and the replay stages its
 * own; this is the water moving. The replay poses every seal from the record
 * (poseFrame) and could not show a throw if it wanted to, so one deferred to
 * the replay's bang would land after the footage had already handed the pitch
 * back — a seal launching itself off a whistle that blew two seconds ago.
 *
 * Returns how many seals it caught, for the harness.
 */
export function goalBlast(side, y = mouthY()) {
  const c = cfg().goalJet?.blast ?? {};
  if (c.enabled === false) return 0;
  const push = Math.max(0, c.push ?? 78);
  const radius = Math.max(0, c.radius ?? 46);
  if (!(push > 0) || !(radius > 0)) return 0;
  const src = goalJetOrigin(side, y, _blastAt);
  const face = rockX(side);
  const fall = Math.max(0.05, c.falloff ?? 1.6);
  const spinK = c.spin ?? 0.2;
  const rollK = c.roll ?? 0.26;
  const limp = Math.max(0, c.tumbleFor ?? 1.6);
  // THE THROW — see the note at the jostle below. Scaled by the same falloff
  // everything else here is, so the seal on the line is fired across the pitch
  // and the one at the rim is nudged.
  const launch = Math.max(0, c.launch ?? 0);
  const ceilMul = Math.max(1, c.launchCeiling ?? 1);
  const ceilFor = Math.max(0, c.launchFor ?? 0);
  let caught = 0;
  for (const seal of matchSeals()) {
    const seat = seatOf(seal);
    if (seat < 0 || versusState.dead[seat]) continue;
    const p = sealPos(seal);
    let dx = p.x - src.x;
    const dy = p.y - src.y;
    // INSIDE THE CORRIDOR THERE IS ONE WAY OUT. A keeper may stand all the
    // way back to the rock (keeperReachDepth), which is DEEPER than the band
    // the jet is born across — so the honest radial line from the bang would
    // shove the one seal that was closest to it straight into the tunnel's
    // back wall, where it would sit out the whole blast pinned against the
    // stone. In the tunnel the horizontal is the corridor's, whichever side
    // of the bang the body is on; the vertical is left alone, so a keeper
    // still comes out of the mouth rising or falling.
    const inside = side < 0 ? p.x < face : p.x > face;
    if (inside) dx = Math.abs(dx) * -side;
    const d = Math.hypot(dx, dy);
    if (d > radius) continue;
    // Dead on the source is not reachable — it is inside the rock — but a
    // divide by zero here would be a NaN on the seal's velocity, which is an
    // animal that never comes back. Out through the mouth.
    const ux = d > 1e-4 ? dx / d : -side;
    const uy = d > 1e-4 ? dy / d : 0;
    const mag = push * Math.pow(1 - d / radius, fall);
    if (!(mag > 0.01)) continue;
    caught++;
    jostle(seat, ux, uy, mag, 1);
    // ...AND THE THROW ITSELF, which jostle cannot deliver.
    //
    // jostle splits a shove two ways and BOTH of them saturate. Its velocity
    // share is clipped to the seal's own top speed by the clamp in
    // updatePlayer on the frame it lands; its knock offset is clamped to
    // CONFIG.playerKnockback.maxSpeed and decays out. That is correct for a
    // body check — a rally must not fire anybody across the pitch — and it is
    // why the goal explosion never went anywhere. Measured before this
    // existed: forty times the shipped `push` moved a seal the same 46 units
    // twice the shipped `push` did, peaked at the same 33 u/s, and did not
    // reach a wall once. The only thing the knob still moved was how fast the
    // bodies SPUN, which is the one axis that can break a skeleton and the one
    // that cannot move a body.
    //
    // `launch` is therefore its own number and its own delivery: real velocity
    // with the speed ceiling lifted while the seal flies (flingSeal), so the
    // arena's own walls bounce it at `wallRestitution` and the water's drag
    // brings it down. Nothing here writes a position or a rotation — the seal
    // is thrown and the existing integrator does the rest, which is what keeps
    // a huge shove from being able to snap anything.
    if (launch > 0) {
      flingSeal(seal, ux, uy, launch * (mag / push), ceilMul, ceilFor * (mag / push));
    }
    // The tumble follows the shove's own signs, the way jostle's jolt does —
    // blown right is thrown clockwise — so the two rotations compose instead
    // of arguing. Scaled by the shove, so the rim gets a wobble and the line
    // gets a somersault, and the limp is scaled with it: a seal that barely
    // felt it is back in control in a fraction of the time.
    const spinSign = ux >= 0 ? -1 : 1;
    const rollSign = uy >= 0 ? 1 : -1;
    // jostle above has already tumbled whatever it shoved hard enough to
    // (limpFor); this is the BLAST's own on top — longer, and along the line
    // out of the mouth rather than the line between two bodies. The kick goes
    // into the skeleton with it, which is what the goal explosion was missing:
    // the arc was always right and the animal inside it was rigid.
    const jb = cfg().bodyCheck?.jolt ?? {};
    tumbleSeal(seal, spinSign * spinK * mag, rollSign * rollK * mag, limp * (mag / push),
      ux, uy, Math.min(jb.kickMax ?? 14, (c.kick ?? jb.kickGain ?? 0.26) * mag));
  }
  versusState.lastBlast = { side, x: src.x, y: src.y, caught, push, radius };
  return caught;
}

/** The striker thrown off the ball: its velocity becomes the recoil, and the dash ends. */
function strikerRecoil(who, dx, dy, speed, stopDash) {
  if (who === 0) {
    if (stopDash && strikeState.active) { cancelDash(); player.dashTimer = 0; }
    player.velocity.set(dx * speed, dy * speed);
    return;
  }
  // Any other seat — a teammate's strike throws it off the ball the same way.
  const seal = sealAt(who);
  if (!seal) return;
  if (stopDash) { cancelDash(seal.strike); seal.dashTimer = 0; }
  seal.velocity.set(dx * speed, dy * speed);
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
/**
 * HOW MUCH OF A SPIKE THIS SHOT IS — 0 for anything struck along the water,
 * 1 for one driven straight down by a swimming seal, and up to `diveGain` for
 * one driven down by an animal falling out of a breach. See
 * CONFIG.versus.ball.spike.
 *
 * TWO INGREDIENTS, AND THE SECOND NEEDS THE FIRST. The angle alone is the
 * spike: `iy` is the line the ball leaves on, and a shot has to be sent more
 * steeply down than `minDown` before any of this applies at all — a level
 * clearance and a spike must not be the same shot with a different number on
 * it. The DIVE is then a multiplier on that, and it is two facts about the
 * striker rather than one:
 *
 *   IT IS FALLING      `vel.y` under zero, against `diveRef`. This is the
 *                      gravity in "come back down out of a breach with
 *                      gravity" — the seal's own weight in the swing.
 *   IT HAS AIR BEHIND IT  `airPeak` (systems/airborne.js) is the high-water
 *                      mark of the ramp for THIS breach, set on the way up and
 *                      held all the way down until the next upward crossing.
 *                      So it is still there at the bottom of the dive, which
 *                      is exactly where the spike is struck and exactly why
 *                      `aboveSurface` would not have done: by the time the
 *                      nose reaches a ball worth hitting, the animal is back
 *                      in the water.
 *
 * Both, multiplied — a seal that merely swam downward fast has no breach to
 * its name, and one that breached and then levelled off is not falling. The
 * shot this describes is the one that looks like it: up, over, and down onto
 * the ball on the way through.
 *
 * `who` is the seat; a striker with no seat (the lab's pointer) gets the
 * angle's half and no dive, which is the right answer for a body that has no
 * arc to have flown.
 */
export function spikeStrength(iy, vel, who) {
  const sp = cfg().ball?.spike ?? {};
  if (sp.enabled === false) return 0;
  const minDown = clamp01(sp.minDown ?? 0.45);
  const down = -iy;
  if (!(down > minDown)) return 0;
  const angle = clamp01((down - minDown) / Math.max(1e-3, 1 - minDown));
  const seal = who >= 0 ? sealAt(who) : null;
  const fall = Math.max(0, -(vel?.y ?? 0));
  const peak = Math.max(0, seal?.airPeak ?? 0);
  const dive = clamp01(fall / Math.max(0.01, sp.diveRef ?? 26))
             * clamp01(peak / Math.max(0.01, sp.peakRef ?? 0.6));
  return angle * lerp(1, sp.diveGain ?? 2.2, dive);
}

// The line the strike's impulse went out on, for ballImpactFx. Preallocated —
// a strike allocates nothing, and this is written once per call just before it
// is read.
const _impLine = { x: 1, y: 0 };

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

  // THE SPIKE — see CONFIG.versus.ball.spike, and spikeStrength for what the
  // number means. A shot sent DOWNWARD is worth more than the same shot sent
  // along the water, and one sent downward by an animal that is itself coming
  // down out of a breach is worth more again: that is the only shot in the
  // game where the seal's own weight is part of the swing.
  const spike = spikeStrength(iy, vel, who);
  const spikeMul = 1 + spike * (((c.spike ?? {}).speedMul ?? 1.4) - 1);
  // WHAT THE BALL IS CARRYING, for everything downstream of the strike: the
  // defenders in its path read it (pierceSeal), and it is cleared by whatever
  // ends the shot — a wall, a body that holds it, the next touch. Written
  // before the impulse so a spike that strikes nothing still reads as one.
  ball.spike = spike;

  const carry = c.carry ?? 0.35;
  const keep = c.keep ?? 0.25;
  const imp = (base + closing * carry) * spikeMul;
  const oldVx = ball.vx;
  const oldVy = ball.vy;
  ball.vx = ix * imp + ball.vx * keep;
  ball.vy = iy * imp + ball.vy * keep;
  // Capped here as well as in the step: the strike lands after the frame's
  // cap has run. maxSpeed for a strike on a slow ball; a counter-strike on
  // a fast one may send it back faster (returnCap), and no slower than
  // returnFloor — the volley climbs. `speedIn` is how fast it was coming.
  //
  // THE SPIKE LIFTS THE CAP WITH THE IMPULSE, or it buys nothing: a full
  // wind-up already lands at the ceiling, and a multiplier under a clamp that
  // did not move is a multiplier that does nothing at exactly the moment it
  // was meant to matter. `ballSpeedCap` still binds over the top of it — that
  // one is a physics limit rather than a balance number (the tunnel and the
  // seals' reach are both wider than a frame at it), and a ball through a wall
  // is not a better spike.
  const max = Math.min(ballSpeedCap(), returnCap(speedIn) * spikeMul);
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
  const sweep = eng.enabled === false ? 0 : (eng.slip ?? eng.sweep ?? 44) * Math.max(-1, Math.min(1, english || 0));
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
  const spinCap = im.spinCap ?? im.spinMax ?? 28;
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
  // (ix, iy) is where the ball WENT — the normal turned toward the dash by
  // `grip`. The contact normal is where the seal happened to touch it, which
  // is the other half of the story and is passed separately; the spit needs
  // both, and the spike's smear already makes the same distinction.
  _impLine.x = ix;
  _impLine.y = iy;
  ballImpactFx('versusBallHit', nx, ny, imp / Math.max(1, hardest), { team: who }, 0, null, _impLine);
  // A SEAL touched it, so this is where possession changes hands — `p` is how
  // hard, which is the same number the dent is sized from. The spike rides this
  // channel too: the look is what carries "something happened to the ball" to
  // the backdrop and the trail, neither of which may import the match.
  ballEvent('bounce', { force: p, team: teamOfSeat(who), spike });
  // ...AND THE SPIKE IS ITS OWN EVENT, over versusBallHit rather than instead
  // of it — the slap is what the touch sounded like and this is what it WAS,
  // the same arrangement versusBlock has over a nudge. It brings the freeze,
  // the smear and the voice; `scale` is how much of a spike it was, which is
  // the number the freeze's own LENGTH is taken from (`hitstopScales`).
  //
  // The smear is thrown along the line the ball LEAVES on (ix, iy) rather than
  // along the contact normal: what a spike should paint on the water is where
  // the ball went, and the normal is where the seal happened to touch it.
  if (spike > 0) {
    const sf = c.spike ?? {};
    const t = Math.min(spike, sf.max ?? 2.2) / Math.max(0.01, sf.max ?? 2.2);
    feedback('versusSpike', {
      x: ball.x - ix * ball.r, y: ball.y - iy * ball.r,
      dirX: ix, dirY: iy,
      vx: ball.vx, vy: ball.vy,
      scale: lerp(sf.fxScaleMin ?? 0.5, sf.fxScaleMax ?? 1.8, t),
      sizeMul: lerp(sf.fxSizeMin ?? 0.8, sf.fxSizeMax ?? 1.9, t),
      speedMul: lerp(sf.fxSpeedMin ?? 0.9, sf.fxSpeedMax ?? 2.2, t),
      color: ballTint().getHex(),
      team: who,
    });
    versusState.lastSpike = { who, spike, speed: Math.hypot(ball.vx, ball.vy), x: ball.x, y: ball.y, dirX: ix, dirY: iy };
  }
  // THE RAM MEETS THE CANNONBALL: the striker takes the ball's change of
  // velocity back, times the mass, and its dash is over. A seal that hit a
  // three-seal ball at full stretch is thrown backwards off it.
  let recoil = 0;
  if (who >= 0) {
    const dvx = ball.vx - oldVx;
    const dvy = ball.vy - oldVy;
    const dv = Math.hypot(dvx, dvy);
    recoil = Math.min(im.recoilMax ?? 40, dv * Math.max(0, c.mass ?? 3) * (im.recoil ?? 0.35));
    if (recoil > 0 && dv > 1e-6) strikerRecoil(who, -dvx / dv, -dvy / dv, recoil, im.stopDash !== false);
    noteTouch(who, 'strike', oldVx, oldVy);
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

/**
 * ONE SEAT'S PAD, or none. Seat 1 keeps the old by-index fallback for a match
 * nobody set up; every seat past it is only ever driven by a pad the team
 * select actually put there, and is the computer's otherwise — a seat with a
 * pad guessed for it would steal the stick out of somebody else's hands.
 */
export function readSeatInput(seat, pads = null, out = p2.input) {
  if (seat === 1) return readP2Input(pads, out);
  const want = seatPad(seat);
  if (want === null || want === undefined) {
    out.connected = false;
    out.move.set(0, 0);
    out.strike = false;
    out.strikeHeld = false;
    out.strikeRelease = false;
    out.aimLive = false;
    out.aimMoved = false;
    return out;
  }
  return readP2Input(pads, out, want);
}

export function readP2Input(pads = null, out = p2.input, forcePad = undefined) {
  const dz = cfg().p2?.deadzone ?? 0.18;
  let list = pads;
  if (!list) {
    try { list = navigator.getGamepads?.() ?? []; } catch { list = []; }
  }
  const pad = forcePad === undefined
    ? p2Pad(list)
    : ((list ?? []).find((p) => p?.connected && p.index === forcePad) ?? null);
  out.strikeRelease = false;
  out.strike = false;
  out.aimLive = false;
  out.aimMoved = false;
  if (!pad) {
    out.connected = false;
    out.move.set(0, 0);
    if (out.heldPrev) { out.strikeRelease = true; }
    out.strikeHeld = false;
    out.heldPrev = false;
    return out;
  }
  out.connected = true;
  const lx = deadzone(pad.axes[0] ?? 0, dz);
  const ly = -deadzone(pad.axes[1] ?? 0, dz);
  out.move.set(lx, ly);
  if (out.move.lengthSq() > 1) out.move.normalize();
  const rx = deadzone(pad.axes[2] ?? 0, dz);
  const ry = -deadzone(pad.axes[3] ?? 0, dz);
  // `aimLive` and `aimMoved` as input.js means them: a pushed right stick is
  // a hand on the aim AND the gesture, since a stick is a direction and
  // cannot flip on its own — which is what lets it steer a dash mid-flight
  // (holdAim in systems/strike.js).
  if (rx || ry) { out.aim.set(rx, ry).normalize(); out.aimLive = true; out.aimMoved = true; }
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
export function releaseP2(dir, english = 0, seal = p2) {
  // ANY SEAT'S, not only seat 1's: stepSeat runs every seat past the human
  // through here, and a release that always fired p2's dash left a teammate
  // wound up and never launching while the second captain lurched instead.
  const s = seal.strike;
  const stats = player.stats;
  const pos = seal.pos;
  if (!dir || (dir.x === 0 && dir.y === 0)) return false;
  const releaseVx = seal.velocity.x;
  const releaseVy = seal.velocity.y;
  if (!tryStrike(dir, stats, english, s)) {
    // THE MID-AIR RELAUNCH, on the release that fired nothing — which is almost
    // always "not enough banked to reach minFire". It is the second half of a
    // breach (CONFIG.airborne.jumps): the strike IS the seal's launch, and a
    // fumbled one in the air spends an air jump instead. canAirJump reads
    // `aboveSurface` and `airJumps`, both of which every seal carries, so this
    // needed nothing but the call — and without it a CPU seal fell out of every
    // breach it did not convert while the person beside it flew on.
    const jump = spendAirJump(seal, dir, false); // `false`: the ramp singleton is the run's own seal
    if (!jump) return false;
    seal.velocity.set(jump.vx, jump.vy);
    // The dash's own ceiling for a moment, for exactly the reason the strike
    // impulse needs it: updatePlayer clamps to maxSpeed before the position
    // ever integrates. Short — this is an impulse, not a dash.
    seal.dashTimer = Math.max(seal.dashTimer, 0.12);
    seal.anim?.trigger('strike');
    feedback('airJump', {
      x: pos.x, y: pos.y,
      dirX: -jump.vx, dirY: -jump.vy,
      // Later jumps in the same breach are worth more, so they read louder —
      // the sound is the readout of a resource being spent down.
      scale: 0.7 + seal.airJumps * 0.25,
      sfxOpts: { pitch: 1.15 + seal.airJumps * 0.12 },
    });
    return false;
  }
  const dashSpeed = stats.strikeDashSpeed * seal.comboSpeedMul;
  seal.velocity.set(s.dashDir.x * dashSpeed, s.dashDir.y * dashSpeed);
  seal.dashTimer = s.dashDuration;
  // The barrel roll — whole turns bought with banked power, continuing from
  // wherever the last one had got to. See main.js.
  const rollCfg = CONFIG.strike.roll;
  const turns = rollCfg?.enabled ? Math.round((rollCfg.turnsAtFull ?? 0) * s.power) : 0;
  if (turns > 0) {
    const TURN = Math.PI * 2;
    const from = seal.rollAngle;
    const sign = seal.mirrorAngle ? -1 : 1;
    const completed = sign > 0 ? Math.ceil(from / TURN) : Math.floor(from / TURN);
    seal.rollFrom = from;
    seal.rollTo = (completed + sign * turns) * TURN;
    seal.rollDuration = s.dashDuration * (rollCfg.durationMul ?? 1);
    seal.rollElapsed = 0;
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
  seal.anim?.trigger('strike');
  // THE POP — the strike's damage, all of it, at the point the stick came up.
  // main.js's, because the splash queue is; see versusHooks.onStrikeBurst.
  versusHooks.onStrikeBurst?.(pos, stats, s, airRamp(seal));
  // ...AND THE SWALLOW. A fired release hoovers the chum around the seal at
  // its gulp radius — the mouthful is the strike's payoff, not the hold's, and
  // it is how the food chain is fed. Every seal but this one's was eating only
  // what it swam over.
  versusHooks.onReleaseGulp?.(pos, stats);
  return true;
}

/**
 * PLAYER 2'S FRAME — main.js's order for player 1, on player 2's state: the
 * body (updatePlayer: thrust, dash steering, ceiling, drag, the shove, the
 * walls, air, facing, the clip, breath, jaw, aim rig), then the wind-up, then
 * the release, then the dash's hits. Every number is read off the same
 * CONFIG and the same stats player 1 reads.
 */
function stepSeat(seal, dt) {
  const inp = seal.input;
  const s = seal.strike;
  const stats = player.stats;
  const pos = seal.mesh.position;

  // A STOCKED BAR MAKES THE SEAL GET MOVING QUICKER — thrust only, up to 15%
  // (CONFIG.strike.chargeThrustPerPip). main.js pushes this onto `player` as a
  // plain field every frame and nothing pushed it onto anybody else, so in a
  // match the seal in seat 0 accelerated harder than the other seven for the
  // whole game. Before updatePlayer, which reads it on the line it thrusts —
  // the same ordering requirement main.js has.
  seal.chargeThrustMul = chargeThrustMul(stats, s);
  // ...AND A LIVE FOOD CHAIN MAKES IT FASTER STILL — thrust, top speed, the
  // dash and the dash's turn rate, up to CONFIG.strike.comboSpeedMax. Same
  // plain-field push main.js does for player 1, same ordering requirement:
  // updatePlayer reads it on the line below.
  seal.comboSpeedMul = comboSpeedMul(stats, s);

  updatePlayer(dt, inp, seal, s);
  seal.celebrate?.update(dt);

  // The wind-up: burn fuel into power (updateCharge), the coil pose, the
  // sealed mouth, the tremble's rumble and the perfect charge's pop — as
  // main.js does for player 1, line for line.
  updateCharge(dt, inp.strikeHeld, stats, s);
  // TURBO — the faster swim of a wind-up held with the stick pushed. Missing
  // here for the same reason the bonus above was: it is a plain field main.js
  // set on one seal. After updateCharge, which is what decides whether this
  // seal is charging at all, and read by updatePlayer on the NEXT frame —
  // which is exactly where player 1's sits in main.js's order too.
  seal.turbo = updateTurbo(dt, inp.move.length(), s);
  seal.chargePose = s.charging ? s.pending : 0;
  seal.chumSealed = CONFIG.strike.enabled && inp.strikeHeld && CONFIG.strike.charge.gulp?.blockEating !== false;
  if (s.charging) {
    seal.hapticT -= dt;
    if (seal.hapticT <= 0) {
      seal.hapticT = CONFIG.strike.charge.hapticInterval;
      feedback('strikeCharging', { x: pos.x, y: pos.y, scale: 0.35 + s.pending * 1.1 });
    }
  } else {
    seal.hapticT = 0;
  }
  if (perfectCrossed(s)) feedback('strikePerfect', { x: pos.x, y: pos.y });

  // The release: the same launch, between the swim and the aim.
  if (inp.strikeRelease) {
    const dir = strikeDirection(inp.move, inp.aim);
    // English off the two sticks disagreeing, as player 1's is — but not for
    // the bot, whose aim is the ball and whose swim is wherever it is going
    // next; it would put spin on every shot and mean none of it.
    releaseP2(dir, botState.driving ? 0 : strikeEnglish(inp.move, inp.aim), seal);
  }

  // THE DASH'S HITS — the run's own loop, on player 2's state: the prey cull
  // (every dash culls in a match, see updateStrike), the shove, the ram's
  // event, and the kill through the hook above so a P2 kill is a kill like
  // any other. hits are per state, so the two seals never share a dash.
  updateStrike(dt, scene, pos, stats, enemies, p2Hooks, s);

  // AIR TIME — the ramp, the arrival window, the slam under a landing and the
  // splash. main.js's, because the splash queue is; see versusHooks.onSealAir.
  // After updatePlayer, which has just integrated the arc and set `breachDir`,
  // and after the dash's hits, which is main.js's order for player 1.
  versusHooks.onSealAir?.(seal, stats, s);

  // Air: updatePlayer spent or refilled it; empty is a burst.
  if (CONFIG.oxygen?.enabled !== false && seal.oxygen <= 0) versusOutOfAir(seatOf(seal));

  // THE MAGNET. It used to belong to the player outright — entities/pickups.js
  // is handed one seal and reaches for food with it, so in a match one mouth
  // hoovered chum out of the water at `foodReach` and every other seal had to
  // swim onto it. That is the widest felt gap there was between a person's
  // seal and the computer's, and it feeds the food chain besides.
  //
  // A CLAIM, so the two magnets are never on one orb. An orb this seal has
  // claimed carries its seat, and the player's own loop leaves those alone
  // (see `claimedBy` in updatePickups); the claim is dropped the moment the
  // seal is out of reach of it, so nothing is held hostage by a seal that
  // swam away. The SWALLOW is not moved: this only pulls, and the gulp below
  // is still what eats — which is what keeps a CPU seal's mouthful out of the
  // player's meter.
  if (scene) magnetiseChum(seal, stats, dt, seal.chumSealed);

  // Chum. The pickup system's magnet belongs to the player; P2 just eats what
  // its mouth is over, a pip a mouthful, the same rate as P1's bar — and not
  // while a wind-up has the mouth sealed, as P1's is.
  //
  // THROUGH feedChum, WHICH IS THE FOOD CHAIN'S DOOR. It was addCharge, which
  // is the bar and only the bar — so every seal but player 1 ate for fuel and
  // could never chain, while player 1's mouthfuls went through main.js's own
  // collector and did. feedChum fills the same pip and books it against THIS
  // seal's chain (see chainAllowed for the match-wide switch); the link it
  // scores is announced below.
  if (scene && !seal.chumSealed) {
    const reach = cfg().p2?.reach ?? 3;
    gulpPickups(scene, pos.x, pos.y, reach, () => {
      feedChum(stats, s);
      // The links are READ rather than thrown away, so they cannot sit in
      // this seal's state and be replayed on the next orb — the same contract
      // main.js keeps. It is not announced with `strikeChain`: that event
      // shakes the screen, and seven seals chaining would shake it constantly.
      // A CPU seal's chain shows on its own ring, whose arc wears the chain's
      // colour now, and in how much faster the animal is moving.
      consumeChainLinks(s);
    });
  }
}

/**
 * ONE MATCH SEAL'S REACH FOR THE FOOD AROUND IT — the magnet, for a seal that
 * is not the one entities/pickups.js was handed.
 *
 * Same two numbers the player's own magnet uses (foodReach, foodPull in
 * systems/chumMagnet.js), so a CPU seal reaches exactly as far and pulls
 * exactly as hard, and a live food chain widens its sweep the same way.
 *
 * THE CLAIM IS WHAT KEEPS THE TWO MAGNETS APART. An orb inside this seal's
 * reach is stamped with its seat; the player's loop skips anything stamped for
 * somebody else, so an orb is only ever being pulled by one mouth. Out of
 * reach, the stamp comes off — a claim is a reach, not a hold, and an orb
 * abandoned mid-water because the seal that claimed it swam away is the bug
 * the latch over there exists to stop.
 *
 * A SEALED MOUTH keeps what it has claimed and pulls nothing — the same rule
 * the player's magnet follows. The release of an out-of-reach claim is not
 * gated on it: a wind-up that stranded every orb the seal had reached for
 * would leave them unpullable by anybody, since the player's loop skips
 * anything claimed.
 *
 * Seat 0 never gets here: the player's own loop is its magnet.
 */
function magnetiseChum(seal, stats, dt, sealed = false) {
  const seat = seatOf(seal);
  if (seat <= 0) return;
  const at = sealPos(seal);
  const speed = seal.velocity.length();
  const reach = foodReach(stats, speed);
  const pull = foodPull(speed);
  for (const p of pickups) {
    const ox = p.mesh.position.x;
    const oy = p.mesh.position.y;
    const d = foodDistance(at.x, at.y, ox, oy, speed);
    if (d > reach) {
      if (p.claimedBy === seat) p.claimedBy = null;
      continue;
    }
    // First claim wins, and it is checked before the pull so two seals in one
    // pile do not each drag the same orb half a step.
    if (p.claimedBy != null && p.claimedBy !== seat) continue;
    p.claimedBy = seat;
    // A SEALED MOUTH KEEPS ITS CLAIM AND STOPS PULLING, exactly as the
    // player's does: nothing is dragged into a mouth that cannot swallow, and
    // an orb advertising "the release is going to take me" has to still be
    // there when the release comes. The RELEASE of a claim above is
    // unconditional, though — a wind-up must not strand every orb the seal had
    // reached for, because the player's own loop leaves claimed orbs alone.
    if (sealed) continue;
    const dx = at.x - ox;
    const dy = at.y - oy;
    const gap = Math.hypot(dx, dy) || 1e-4;
    // Clamped to the gap, for the reason the player's is: an unclamped pull
    // that outruns the seal overshoots the mouth and the orb flicks through it
    // frame after frame without ever being close enough to take.
    const step = Math.min(pull * dt, gap);
    p.mesh.position.x += (dx / gap) * step;
    p.mesh.position.y += (dy / gap) * step;
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
  // ITS OWN GOAL, whichever side that is — a seat's side, not its number.
  const team = teamOfSeat(who);
  const f = seatFormation(who);
  const half = (bounds.top - bounds.bottom) * 0.5;
  return {
    x: team === 0 ? bounds.left + inset : bounds.right - inset,
    // Spread down the mouth so a side respawning together does not come back
    // stacked on one point.
    y: midWater() + f.lane * half * 0.35,
  };
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
  const seal = sealAt(who);
  if (seal) {
    sealPos(seal).set(at.x, at.y, 0);
    seal.velocity.set(0, 0);
    seal.oxygen = maxO2;
    seal.hp = player.stats?.maxHp ?? seal.hp;
    if (seal.mesh) seal.mesh.visible = true;
  }
  versusState.invuln[who] = r.invuln ?? 0.8;
  // Its own event now. It fired `bubblePop` — a PICKUP sound — so a seal
  // rejoining the match was indistinguishable from one eating a bubble.
  feedback('versusRespawn', { x: at.x, y: at.y, scale: 1.4, team: who });
}

/** The clocks: the wait, then the grace. A dead seal is parked on its spawn point meanwhile. */
function updateRespawns(dt) {
  for (let who = 0; who < rosterSize(); who++) {
    if (versusState.invuln[who] > 0) versusState.invuln[who] = Math.max(0, versusState.invuln[who] - dt);
    if (!versusState.dead[who]) continue;
    // Parked out of play while gone — anything that reads the position finds
    // it in the goal, nowhere near the ball.
    const at = spawnPoint(who);
    const seal = sealAt(who);
    if (seal) {
      sealPos(seal).set(at.x, at.y, 0);
      seal.velocity.set(0, 0);
      if (who === 0 && seal.mesh) seal.mesh.visible = false;
    }
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
  // A REPLAY POSES THE WORLD instead of stepping it. Here, after main.js has
  // run updatePlayer for the frame (which would otherwise re-pose player 1's
  // body from its own live state on top of the replay's).
  if (replayState.active) { poseReplay(replayState.t); updateReplayCams(); paintClock(); return; }
  versusState.clock += dt;
  // A hat placed before its model had landed is a stand-in; swap it for the
  // real thing on the frame that arrives. Free once every seat is dressed from
  // a model, which is within a second of a match starting.
  redressLate();
  // THE CONTINUOUS HALF of the ball's look, pushed before anything moves so it
  // describes the frame the player is looking at. `speedRef` is the same
  // number the impact model normalises against, so "fast" means one thing.
  const ref = Math.max(1, cfg().ball?.impact?.speedRef ?? 30);
  setBallDrive({
    speed01: Math.hypot(ball.vx, ball.vy) / ref,
    // The hardest wind-up ON THE PITCH, not player 2's — with four seals in
    // the water the one that is charging is usually not the one this line
    // used to name.
    charge01: matchSeals().reduce(
      (m, seal) => Math.max(m, seal !== player && seal.strike.charging ? seal.strike.pending : 0),
      humanInput?.charge ?? 0,
    ),
  });
  // EVERY SEAT PAST 0, driven identically: read its pad, or let a bot fill the
  // same input the pad would, then step it. Seat 0 is the person holding the
  // frame and main.js drives that one.
  const pitch = pitchView();
  for (const seal of matchSeals()) {
    const seat = seatOf(seal);
    if (seat <= 0) continue;
    readSeatInput(seat, pads, seal.input);
    if (botWanted(seal.input.connected, seat)) {
      updateBot(dt, seal, ball, opponentOf(seat), seal.input, seat, pitch);
      // The bot's aim is always a hand on the stick, so its dashes steer.
      seal.input.aimLive = true;
      seal.input.aimMoved = true;
      seal.input.strike = seal.input.strikeHeld && !seal.pressPrev;
    } else if (seat === 1) {
      botState.driving = false;
    }
    seal.pressPrev = seal.input.strikeHeld;
  }
  updateRespawns(dt);
  for (const seal of matchSeals()) {
    const seat = seatOf(seal);
    if (seat > 0 && !versusState.dead[seat]) stepSeat(seal, dt);
  }
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
    for (const seal of matchSeals()) {
      const seat = seatOf(seal);
      if (seat > 0 && !versusState.dead[seat]) eatBubbles(seal);
    }
    sealCollide(bodyCheck());
  }

  if (ball.live) {
    stepSoftBody(dt);
    // The silhouette this frame will draw, solved before anything collides
    // with it — the hitbox and the picture are the same shape by ORDER as
    // well as by construction.
    solveBallSurface();
    stepBall(dt);
    updateBallSpin(ball.live ? ball.spin : 0, dt);
    // A goal just went in: this frame — the ball at the line — is the
    // replay's last, so it is recorded before the early out.
    if (!ball.live) { recordFrame(); paintClock(); return; }
    // Everything in the water that is not a seal — the boats it bounces off
    // and the fish it goes through. Before the seals' own contact, so a ball
    // deflected off a hull meets a seal on the heading it actually leaves on.
    ballHits();
    // EVERY SEAL AGAINST THE BALL, same call, same rules — a teammate's touch
    // is an opponent's touch and the contest does not ask whose side anybody
    // is on. Seat 0's strike lives in main.js's own state; the rest carry
    // theirs on the seal.
    for (const seal of matchSeals()) {
      const seat = seatOf(seal);
      if (versusState.dead[seat]) continue;
      if (seat === 0) {
        sealContact(0, player.mesh.position, player.velocity,
          !!strikeState.active, strikeState.dashDir, strikeState.power ?? 0, strikeState.english ?? 0,
          sealHeading(player));
      } else {
        sealContact(seat, sealPos(seal), seal.velocity, seal.active, seal.dashDir, seal.power, seal.english, sealHeading(seal));
      }
    }
    updatePinch(dt);
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

  // The markers ride under their seals — all of them, see placeMarkers.
  placeMarkers();
  // The recorder: every frame of play, and the frame the goal was called on
  // (the ball at the line), so a replay has its last frame.
  if (versusState.phase === 'play' || versusState.lastGoal?.t === versusState.clock) recordFrame();
  // AFTER the frame is in the ring, both of them. The save watch reads the
  // ball where this frame left it, and a clip harvested a frame early is a
  // clip one frame short of the moment it was asked for.
  updateSaveWatch();
  // POSSESSION IS TIME. Whoever touched the ball last is holding it, which is
  // how the momentum ledger above already thinks about it — asked once a frame
  // of play rather than answered a second way. dt is the match's, so the
  // shutter's freeze does not pay possession to whoever was last on the ball.
  if (versusState.phase === 'play') accrueTallyPossession(dt, versusState.lastTouch?.who ?? -1);
  harvestClips(versusState.clock, snapshotSpan);
  paintClock();
}

// EVERYONE ON THE PITCH, for the bots — where each seat is, which way it is
// going, whose side it is on and whether a person is in it. The bot used to
// see one opponent and nothing else, which is all a 1v1 has; a TEAMMATE has
// to know where its captain is to pass to it, and where the other side is to
// know the lane is open. Built once per frame and shared by every bot on it
// (versusBot.js reads it, never writes it), and rebuilt in place — this runs
// every frame and has no business allocating.
const _roster = [];
function pitchView() {
  let n = 0;
  for (const seal of matchSeals()) {
    const seat = seatOf(seal);
    const at = sealPos(seal);
    const v = _roster[n] ?? (_roster[n] = { seat: 0, team: 0, x: 0, y: 0, vx: 0, vy: 0, human: false, dead: false, charge: 0 });
    v.seat = seat;
    v.team = teamOfSeat(seat);
    v.x = at.x; v.y = at.y;
    v.vx = seal.velocity.x; v.vy = seal.velocity.y;
    v.human = !seatIsCpu(seat);
    v.dead = !!versusState.dead[seat];
    v.charge = seal === player ? (strikeState.charge ?? 0) : (seal.strike?.charge ?? 0);
    n++;
  }
  _roster.length = n;
  return _roster;
}

const _opp = { x: 0, y: 0, vx: 0, vy: 0 };
/** The OTHER seal's position and velocity, as seen by seal `who`. */
function opponentOf(who) {
  // THE NEAREST SEAL ON THE OTHER SIDE. It was "the other one", which is the
  // same thing while there are two — with four in the water the bot has to
  // steer against somebody in particular, and the one closest to it is the one
  // it is actually contesting.
  let best = null;
  let bestD = Infinity;
  for (const seal of matchSeals()) {
    const seat = seatOf(seal);
    if (seat === who || sameTeam(seat, who) || versusState.dead[seat]) continue;
    const me = sealAt(who);
    const mine = me ? sealPos(me) : null;
    const dx = sealPos(seal).x - (mine?.x ?? 0);
    const dy = sealPos(seal).y - (mine?.y ?? 0);
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = seal; }
  }
  if (!best) { _opp.x = 0; _opp.y = 0; _opp.vx = 0; _opp.vy = 0; return _opp; }
  _opp.x = sealPos(best).x; _opp.y = sealPos(best).y;
  _opp.vx = best.velocity.x; _opp.vy = best.velocity.y;
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

/**
 * A free pip for each seal every `regen.pipEvery` seconds.
 *
 * EVERY SEAT, not the two captains. This was written as a pair — `t[0]` for
 * player 1 and `t[1]` for player 2 — and stayed a pair when the roster grew, so
 * every seal past the second was the only one in the water with no clock on its
 * meter at all. Its whole bar came from food, which is a rule nobody wrote and
 * nothing says. `growSeatState` already sizes `regenT` to the roster; this is
 * the loop that was missing.
 */
function regenPips(dt) {
  const every = cfg().regen?.pipEvery ?? 0;
  if (!(every > 0)) return;
  const t = versusState.regenT;
  for (const seal of matchSeals()) {
    const seat = seatOf(seal);
    if (seat < 0 || versusState.dead[seat]) continue;
    t[seat] -= dt;
    if (t[seat] > 0) continue;
    t[seat] += every;
    // Player 1's meter is the run's own (strikeState, through addCharge, so a
    // completed pip is heard); every other seat carries its own.
    if (seal === player) addCharge(pipValue(player.stats), player.stats);
    else seal.charge = Math.min(1, seal.charge + (CONFIG.strike.charge?.chumRefill ?? 0.2));
  }
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
function eatBubbles(seal) {
  if (!scene || !seal?.mesh) return;
  const reach = (cfg().bubbles?.reach ?? 3);
  for (let i = bubbleOrbs.length - 1; i >= 0; i--) {
    const orb = bubbleOrbs[i];
    const r = orb.assetRadius ?? 0.5;
    const d = Math.hypot(orb.mesh.position.x - sealPos(seal).x, orb.mesh.position.y - sealPos(seal).y);
    if (d >= reach + r) continue;
    seal.charge = Math.min(1, seal.charge + versusBubblePips());
    seal.oxygen = Math.min(Math.max(1, player.stats?.maxOxygen ?? CONFIG.oxygen?.max ?? 100), seal.oxygen + (CONFIG.oxygen?.bubbleRefillAmount ?? 30));
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
/**
 * A DASH INTO ANOTHER SEAL, for ONE PAIR of seats. It was written for the only
 * pair there was — player 1 and player 2 — and every "1" and "2" in it was
 * doing double duty as a seat, a side and an end of the collision. `a` and `b`
 * are seats now and nothing here asks whose side either is on: a teammate
 * shoves you exactly as an opponent does, which is what makes a scramble in
 * front of the goal a scramble.
 */
function bodyCheckPair(a, b) {
  const c = cfg().bodyCheck ?? {};
  const sa = sealAt(a);
  const sb = sealAt(b);
  if (!sa || !sb || versusState.dead[a] || versusState.dead[b]) return false;
  const p1 = sealPos(sa);
  const pb = sealPos(sb);
  const dx = pb.x - p1.x;
  const dy = pb.y - p1.y;
  const dist = Math.hypot(dx, dy) || 0.0001;
  const cr = c.contactRadius ?? 2.2;
  const strikeA = a === 0 ? strikeState : sa.strike;
  const strikeB = b === 0 ? strikeState : sb.strike;
  const d1 = !!strikeA.active;
  const d2 = !!strikeB.active;
  if (!d1) versusState.checked[a] = false;
  if (!d2) versusState.checked[b] = false;
  if (dist >= cr * 2) return false;
  const nx = dx / dist; // from P1 toward P2
  const ny = dy / dist;
  const can1 = d1 && !versusState.checked[a];
  const can2 = d2 && !versusState.checked[b];
  if (!can1 && !can2) return false;
  const both = can1 && can2;
  const share = both ? (c.both ?? 0.6) : 1;
  const knock = c.knock ?? 22;
  const knockMax = c.knockMax ?? 52;
  const carry = c.carry ?? 0.4;
  // WHO WINS: the ball's contest between the two bodies — speed toward the
  // other times mass. Positive is player 1. A dasher into a swimmer wins it
  // unless the swimmer is coming the other way faster than the dash counts
  // for; head-on it is whoever committed more.
  const u1 = Math.max(0, sa.velocity.x * nx + sa.velocity.y * ny);
  const u2 = Math.max(0, -(sb.velocity.x * nx + sb.velocity.y * ny));
  const margin = u1 * contestMass(d1, strikeA.power ?? 0) - u2 * contestMass(d2, strikeB.power ?? 0);
  let strongest = 0;
  const breakA = () => { if (a === 0) cancelDash(); else { cancelDash(sa.strike); sa.dashTimer = 0; } };
  const breakB = () => { if (b === 0) cancelDash(); else { cancelDash(sb.strike); sb.dashTimer = 0; } };
  if (can1) {
    versusState.checked[a] = true;
    const closing = Math.max(0, (sa.velocity.x - sb.velocity.x) * nx + (sa.velocity.y - sb.velocity.y) * ny);
    strongest = Math.max(strongest, (lerp(knock, knockMax, clamp01(strikeA.power ?? 0)) + closing * carry) * share);
    if (c.breakDash !== false && d2 && !both) breakB();
  }
  if (can2) {
    versusState.checked[b] = true;
    const closing = Math.max(0, (sb.velocity.x - sa.velocity.x) * -nx + (sb.velocity.y - sa.velocity.y) * -ny);
    strongest = Math.max(strongest, (lerp(knock, knockMax, clamp01(strikeB.power ?? 0)) + closing * carry) * share);
    if (c.breakDash !== false && d1 && !both) breakA();
  }
  if (both && c.breakDash !== false) { breakA(); breakB(); }
  // The loser takes the shove away from the winner; the winner takes its
  // recoil. A dead heat (both to the frame) is split as two losers.
  const loser = Math.abs(margin) < 1e-6 ? -1 : (margin > 0 ? b : a);
  if (loser === -1) {
    jostle(b, nx, ny, strongest, 1);
    jostle(a, -nx, -ny, strongest, 1);
  } else {
    const sgn = loser === b ? 1 : -1;
    jostle(loser, nx * sgn, ny * sgn, strongest, 1);
    jostle(loser === b ? a : b, -nx * sgn, -ny * sgn, strongest, c.winnerShare ?? 0.3);
  }
  // The event, scaled by the shove: a tap at the low end, a full-power ram
  // into a seal closing head-on at the top.
  const t = clamp01((strongest - knock * 0.5) / Math.max(1, knockMax * 1.3 - knock * 0.5));
  const scale = lerp(c.scaleMin ?? 0.5, c.scaleMax ?? 1.8, t);
  const mx = (p1.x + pb.x) * 0.5;
  const my = (p1.y + pb.y) * 0.5;
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
  versusState.lastCheck = { push: strongest, scale, both, x: mx, y: my, margin, loser };
  // A ram, not a brush: the archive takes the top of the shove's range only.
  // `loser` of -1 is a head-on, and either body will do as the one it landed
  // on — the frame holds both.
  noteCheckClip(strongest, loser === a ? b : a, loser === -1 ? b : loser, mx, my);
  return true;
}

/**
 * EVERY PAIR ON THE PITCH, teammates included. A dash is a dash whoever it
 * lands on — there is no "friendly fire" switch here on purpose, because the
 * thing that makes a crowd in front of a goal read as a crowd is that being in
 * one is dangerous. Returns true if any pair checked this frame, which is what
 * sealCollide reads to know a shove has already been paid.
 */
export function bodyCheck() {
  if ((cfg().bodyCheck ?? {}).enabled === false || !player.mesh) return false;
  const n = rosterSize();
  let any = false;
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) if (bodyCheckPair(a, b)) any = true;
  }
  return any;
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
/**
 * TWO SEALS CANNOT OVERLAP, for one pair of seats — and this one is deliberate
 * about teammates too. A side that could stand inside itself would let two
 * seals share a hitbox in front of the goal, which is a way of defending the
 * mouth that no rule in this file would ever have to answer.
 *
 * `touching` is per PAIR now (it was one flag when there was one pair): the
 * "met this frame" edge is what pays the shove, and one shared flag would let
 * a pair that had been touching for a second cancel a fresh meeting somewhere
 * else on the pitch.
 */
function sealCollidePair(a, b, checked = false) {
  const c = cfg().sealCollide ?? {};
  const sa = sealAt(a);
  const sb = sealAt(b);
  if (!sa || !sb || versusState.dead[a] || versusState.dead[b]) return null;
  const cr = cfg().bodyCheck?.contactRadius ?? 2.2;
  const p1 = sealPos(sa);
  const pb = sealPos(sb);
  const dx = pb.x - p1.x;
  const dy = pb.y - p1.y;
  const dist = Math.hypot(dx, dy) || 0.0001;
  const minD = cr * 2;
  const key = a * 16 + b;
  if (dist >= minD) { touchingPairs.delete(key); return null; }
  const nx = dx / dist; // from P1 toward P2
  const ny = dy / dist;
  // Apart, half each.
  const push = (minD - dist) * 0.5;
  p1.x -= nx * push; p1.y -= ny * push;
  pb.x += nx * push; pb.y += ny * push;
  const met = !touchingPairs.has(key);
  touchingPairs.add(key);
  const strikeA = a === 0 ? strikeState : sa.strike;
  const strikeB = b === 0 ? strikeState : sb.strike;
  const d1 = !!strikeA.active;
  const d2 = !!strikeB.active;
  const u1 = Math.max(0, sa.velocity.x * nx + sa.velocity.y * ny);
  const u2 = Math.max(0, -(sb.velocity.x * nx + sb.velocity.y * ny));
  const m1 = contestMass(d1, strikeA.power ?? 0);
  const m2 = contestMass(d2, strikeB.power ?? 0);
  const margin = u1 * m1 - u2 * m2; // positive: P1 wins
  let knock = 0;
  let loser = -1;
  if (met && !checked && !d1 && !d2 && Math.abs(margin) > 0.01) {
    loser = margin > 0 ? b : a;
    if (sealVulnerable(loser)) {
      knock = Math.min(c.knockMax ?? 60, (c.knockGain ?? 1.2) * Math.abs(margin));
      const sgn = loser === b ? 1 : -1;
      jostle(loser, nx * sgn, ny * sgn, knock, 1);
      jostle(loser === b ? a : b, -nx * sgn, -ny * sgn, knock, cfg().bodyCheck?.winnerShare ?? 0.3);
      if (knock > 0.5) {
        feedback('bodyCheck', {
          x: (p1.x + pb.x) * 0.5, y: (p1.y + pb.y) * 0.5,
          scale: 0.5 + 0.6 * clamp01(knock / (c.knockMax ?? 60)),
          dirX: nx * sgn, dirY: ny * sgn, vx: nx * sgn * knock, vy: ny * sgn * knock,
          sizeMul: 0.6, speedMul: 0.6, headOn: false,
        });
      }
    }
  }
  versusState.lastCollide = { met, margin, loser, knock, push, a, b };
  return versusState.lastCollide;
}

// Which pairs are pressed together right now, keyed a*16+b. See the note on
// `met` above: the EDGE is what pays the shove.
const touchingPairs = new Set();

/** Every pair on the pitch, teammates included. */
export function sealCollide(checked = false) {
  if ((cfg().sealCollide ?? {}).enabled === false || !player.mesh) {
    touchingPairs.clear();
    versusState.touching = false;
    return null;
  }
  const n = rosterSize();
  let last = null;
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const r = sealCollidePair(a, b, checked);
      if (r) last = r;
    }
  }
  // The old single flag, kept for the readout and the harness: is ANY pair
  // pressed together this frame.
  versusState.touching = touchingPairs.size > 0;
  return last;
}

/**
 * The goal's shutter, on the WALL clock. Returns the scale main.js folds into
 * realDt. Runs every frame, run or no run, so a match never sticks frozen.
 */
/**
 * @param pads  a navigator.getGamepads() list, or null to poll it — the
 *              prompt after a match reads every pad through it. Harnesses
 *              hand their fakes in here the way they do to updateVersus.
 */
// ---------------------------------------------------------------------------
// THE SEALS IN THE GOAL LIGHTS — see CONFIG.versus.goal.swim.
//
// The noise that breaks each mouth's light up is sampled in WORLD units, so a
// seal is already somewhere in it; this is what tells the shader where. Two
// separate things, and they read as two things on screen:
//
//   the DISTORTION is continuous — the field is shoved, curled and smeared
//   around whichever seal is near enough, and boils harder the faster it is
//   going. Handed over every frame as four numbers a seal.
//
//   the IMPULSE is an event — a seal crossing `burst` units/s near a mouth
//   throws a ring, once, on the frame it crosses. An EDGE, not a level: held
//   above the threshold it throws one ring and then nothing, which is what a
//   dash is. (A level test here would throw sixty a second for as long as the
//   dash lasted and the field would just sit bright.)
//
// It lives in versus.js rather than wallRocks.js because this is the module
// that knows a seal exists — the shore has to stay a leaf, or it cannot be
// built before a match starts.
// ---------------------------------------------------------------------------

const _stir = [
  { x: 0, y: 0, vx: 0, vy: 0, color: 0, tint: 0, defend: 0 },
  { x: 0, y: 0, vx: 0, vy: 0, color: 0, tint: 0, defend: 0 },
];
// Per seal: was it above the burst threshold last frame, and how long until it
// may throw another ring. Reset with the match.
const _burst = [{ was: false, cool: 0 }, { was: false, cool: 0 }];

export function stirGoalLights(dt) {
  const s = cfg().goal?.swim ?? {};
  if (s.enabled === false) { setGoalSwimmers([]); return 0; }
  const seals = [player, p2];
  const live = [];
  let fired = 0;
  for (let i = 0; i < 2; i++) {
    const seal = seals[i];
    const pos = i === 0 ? seal.mesh?.position : (seal.mesh ? seal.pos : null);
    const b = _burst[i];
    b.cool = Math.max(0, b.cool - dt);
    // A dead seal is not in the water: its slot parks rather than holding the
    // last place it was seen, which would leave a permanent dent in the field.
    if (!pos || versusState.dead[i]) { live[i] = null; b.was = false; continue; }
    const v = seal.velocity;
    const e = _stir[i];
    e.x = pos.x; e.y = pos.y; e.vx = v?.x ?? 0; e.vy = v?.y ?? 0;
    // THE COLOUR IT BRINGS WITH IT. Seal 0 attacks the RIGHT mouth and seal 1
    // the left (a ball in the left goal is seal 1's point — see goal()), and
    // the mix is only ever on the goal a seal is ATTACKING: its own is
    // already its colour, so tinting that would do nothing you could see and
    // would make a keeper look like it was scoring. Ramped on how deep it is
    // past its opponent's wall — bleeding in over `tintLead` before the line
    // and full by the goal line itself — so swimming in is what takes the
    // light over rather than merely being near it. The line and not the
    // corridor's back: a seal may swim the whole tunnel now, and a takeover
    // that only completed against the back rock would leave an attacker
    // standing on the line in a light still mostly the keeper's.
    e.color = teamColor(i);
    const attackX = i === 0 ? bounds.right : bounds.left;
    const depth = i === 0 ? e.x - attackX : attackX - e.x;
    const lead = Math.max(0, s.tintLead ?? 5);
    const full = Math.max(0.5, keeperLineDepth() + lead);
    e.tint = Math.max(0, Math.min(1, (depth + lead) / full));
    live[i] = e;
    const speed = Math.hypot(e.vx, e.vy);
    const over = speed >= Math.max(1, s.burst ?? 46);
    // Near enough a mouth to be worth a ring — measured off the nearer drawn
    // face, so the check is the same distance the light itself is drawn from.
    const side = e.x < 0 ? -1 : 1;
    const near = Math.abs(e.x - rockX(side)) <= Math.max(0, s.range ?? 46);
    if (over && !b.was && b.cool <= 0 && near) {
      goalGlowImpulse(e.x, e.y, Math.max(0, s.strength ?? 1));
      b.cool = Math.max(0, s.cooldown ?? 0.3);
      fired++;
    }
    b.was = over;
  }
  // THE KEEPER'S CONTEST, before the swimmers are handed over: it needs the
  // ball's take-over, and the seal it belongs to is one of the entries above.
  const shot = ballInLight();
  contestGoal(live, shot);
  setGoalSwimmers(live);
  setGoalBall(shot);
  return fired;
}

/**
 * THE KEEPER PUSHES BACK. A shot coming in paints the goal in the SHOOTER'S
 * colour (see ballInLight) — and the seal standing in that goal gets to argue
 * with it: its own colour and its own churn go into the field alongside the
 * shot's, additively, so the mouth is contested rather than simply taken.
 *
 * Only the keeper of the mouth being shot at, only while it is actually
 * INSIDE that mouth, and only in proportion to how far the shot has got. A
 * keeper out in open water is not defending anything, and with no shot coming
 * there is nothing to push back against — which is what keeps this off in
 * ordinary play and stops a seal parked in its own net from strobing.
 */
function contestGoal(live, shot) {
  for (const e of live) if (e) e.defend = 0;
  const s = cfg().goal?.swim ?? {};
  if (!shot || !(shot.tint > 0) || (s.enabled === false)) return 0;
  // Seal 0 keeps the LEFT mouth and seal 1 the right — the mirror of who
  // attacks which, above.
  const keeper = shot.side < 0 ? 0 : 1;
  const e = live[keeper];
  if (!e) return 0;
  const wall = keeper === 0 ? bounds.left : bounds.right;
  const depth = keeper === 0 ? wall - e.x : e.x - wall;
  if (depth <= 0) return 0;
  // ...and all the way in is all the way contesting. keeperLineDepth is how
  // far in it may legally get, so the ramp is over the ground it can cover
  // rather than over a number the walls would not let it reach.
  const inGoal = Math.max(0, Math.min(1, depth / Math.max(0.5, keeperLineDepth())));
  e.defend = inGoal * shot.tint;
  e.color = teamColor(keeper);
  e.tint = e.defend * Math.max(0, Math.min(1, s.defend ?? 0.9));
  return e.defend;
}

const _ballStir = { x: 0, y: 0, side: -1, amount: 0, tint: 0, color: 0xffffff };

/**
 * HOW MUCH OF THE BALL IS IN A GOAL'S LIGHT — 0 out in the water, 1 once it
 * is through the mouth. The same shape the light itself is drawn with (see
 * GOAL_FALLOFF_GLSL in wallRocks.js): the light reaches `spill` in front of
 * the drawn face and `spill` past each lip, and the ball is inside it by
 * however far it is into that.
 *
 * Worked out HERE rather than in the shader, which has the same numbers,
 * because the ball's own RADIUS belongs in it: what should light the goal up
 * is the ball ARRIVING, and a ball whose near edge is over the face is
 * already in the mouth whatever its centre says. The shader gets one number
 * and never has to know what a ball is.
 */
function ballInLight() {
  const g = cfg().goal ?? {};
  const b = g.ball ?? {};
  if ((b.enabled ?? true) === false) return null;
  const spill = Math.max(0.001, g.spill ?? 6);
  const side = ball.x < 0 ? -1 : 1;
  const r = ballHitRadius();
  // Past the drawn face, measured off the ball's NEAR edge.
  const inward = (ball.x + side * r - rockX(side)) * side;
  const along = Math.max(0, Math.min(1, (inward + spill) / spill));
  // ...and inside the band, fading over the same spill past each lip. Shared
  // by both numbers below: a shot flying at the rock above the lip is not
  // arriving at this goal whatever else is true of it.
  const pastLip = Math.max(0, Math.abs(ball.y - mouthY()) - mouthHalfHeight());
  const across = Math.max(0, Math.min(1, 1 - pastLip / spill));
  // THE SHOOTER'S COLOUR, coming in ahead of the shot. Ramped on the distance
  // left to the GOAL LINE — the trigger, not the face — so it is a read on
  // how close this shot is to being a goal rather than on where the ball is.
  // It starts `tintLead` out, which is well out in the water, and is full on
  // the line; the shader spreads it from a disc round the ball to the whole
  // mouth as it comes on.
  const owner = ballOwner();
  const lead = Math.max(0.001, b.tintLead ?? 45);
  const toLine = (ball.x + side * r - goalLineX(side)) * -side;
  const tint = owner < 0 ? 0
    : Math.max(0, Math.min(1, 1 - toLine / lead)) * across * Math.max(0, Math.min(1, b.tint ?? 0.85));
  if (along * across <= 0 && tint <= 0) return null;
  _ballStir.x = ball.x;
  _ballStir.y = ball.y;
  _ballStir.side = side;
  _ballStir.amount = along * across;
  _ballStir.tint = tint;
  if (owner >= 0) _ballStir.color = teamColor(owner);
  return _ballStir;
}

/**
 * THE CIRCLE HUD, ON EVERY SEAL A PERSON IS DRIVING — the fuel pips, the
 * banked-power core and the air band (CONFIG.strike.ring.air, and the bands in
 * systems/strikeRing.js).
 *
 * A match is two or more people on ONE SCREEN, and the HUD's air gauge is one
 * gauge attached to seat 0. Everybody else had no reading of their own lungs
 * anywhere in the game, and seat 0's was in a corner nobody looks at while
 * contesting a ball — so drowning arrived as a burst with no warning for three
 * of the four players. The strip at the top of the screen carries both sides'
 * air as bars, which is the read you take BETWEEN plays; this is the one you
 * take without moving your eyes off the ball.
 *
 * A CPU SEAT GETS NO RING AT ALL — not the air band, not the fuel, not the
 * core. It is an instrument for a decision nobody is making, and four of them
 * on a crowded pitch is four more circles over the water competing with the
 * one you actually have to read. It was only the AIR band that was withheld,
 * which left the bots wearing the loudest two thirds of the meter. A bot's
 * fuel, charge and air are all still simulated — the chain still scores, the
 * lungs still burst — it is only the readout that is a human's.
 *
 * WHICH SEAL IS WHOSE IS SAID ON THE ANIMAL. The rim (attachSealOutline in
 * buildSeat) carries the side's colour on every seal, bot or not, so nothing
 * is lost by taking the circles off the ones nobody is driving.
 *
 * HIDDEN, NOT UNBUILT: a seat's kind changes while the team select is open —
 * a person joining seat 2 turns a bot into a player without rebuilding a body
 * — so the ring exists for every seat and this is the one place that decides
 * whether it draws.
 *
 * SEAT 0's RING IS MAIN.JS'S — the run's own instrument, `ring0`, which is
 * already being driven every frame there. It is handed its air at that call
 * site rather than here, so this loop starts at seat 1 and there is exactly
 * one writer per ring.
 */
function updateSeatRings(rawDt) {
  const live = versusState.active;
  for (const seal of matchSeals()) {
    const seat = seatOf(seal);
    if (seat <= 0 || !seal.ring || !seal.mesh) continue;
    if (!seatIsDriven(seat)) { seal.ring.mesh.visible = false; continue; }
    seal.ring.update(
      rawDt, sealPos(seal), seal.strike, live && !versusState.dead[seat], player.stats,
      sealAir(seal),
    );
  }
}

/** One seal's lungs, in the shape the ring's air band wants. */
function sealAir(seal) {
  const max = Math.max(1, player.stats?.maxOxygen ?? CONFIG.oxygen?.max ?? 100);
  return { oxygen: seal?.oxygen ?? max, max };
}

/**
 * SEAT 0's AIR, for main.js — which owns that ring and drives it every frame
 * whether a match is on or not. Null outside a match, which is what leaves the
 * band off in an ordinary run: the HUD's own gauge is the reading there, and a
 * second one on the animal would be the same number twice.
 */
export function versusPlayerAir() {
  if (!versusState.active || seatIsCpu(0)) return null;
  return sealAir(player);
}

export function updateVersusClock(rawDt, pads = null) {
  if (!versusState.active) { versusState.timeScale = 1; return 1; }
  // The wall delta, kept for updateVersusCamera: main.js hands that the
  // DILATED clock, and there are two phases where the camera has to keep
  // moving at wall speed under a world that has stopped. See camDt there.
  versusState.wallDt = rawDt;
  // THE LOOK RUNS ON THE WALL CLOCK, and this is the only place that has it.
  // The goal shutter drops the world to a near stop for a third of a second
  // with the camera punched all the way in on the ball — exactly when it is
  // most looked at. A warp advanced on the dilated clock would freeze there
  // and read as the effect having broken.
  updateBallLook(rawDt);
  // THE TRAIL IS ON THE WALL CLOCK TOO, and for the same reason plus one more:
  // the cloud is weather. It belongs to the water it was left in rather than to
  // the ball that left it, so it has to keep drifting and dying through a goal
  // shutter, a kickoff freeze and a hit-stop — all of which stop the ball.
  updateBallTrail(rawDt, scene, ball, { radiusAt: ballHitRadiusAt });
  // ...AND SO IS THE BACKDROP'S CHAIN OF DENTS, for exactly the same two
  // reasons: the water the ball has been through is weather, and a dent frozen
  // mid-swing with the goal camera punched all the way in on it reads as the
  // effect having broken. The grid is PUBLISHED to from main.js, where every
  // other body denting the water publishes; this is only the advance.
  updateBallGrid(rawDt);
  driveOutline();
  // The goal lights' noise churns on the wall clock too (wallRocks.js) — and
  // the seals stir it, which is what stirGoalLights hands over first so the
  // tick that follows writes this frame's positions rather than last frame's.
  stirGoalLights(rawDt);
  tickGoalGlow(rawDt);
  // EVERY SEAT'S CIRCLE HUD, on real time like player 1's (main.js hands
  // updateStrikeRing realDt): a hit-stop must not stall the readout.
  updateSeatRings(rawDt);
  // ...and the one-shots ride whatever the replay is doing to the tape. Here
  // with the rest of the wall-clock work, because a dilation measured on a
  // clock the dilation itself has stopped never finishes.
  followSoundDrag();
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
    // THE RECENTRE, before a numeral is shown. The phase clock is held at
    // zero while the shot flies back from the goal it was punched into, so
    // the count reads over a settled frame rather than over a camera still
    // travelling. Timed out rather than trusted: a framing that never
    // converges (a seal wedged in a mouth, a zoom on its clamp) must not be
    // able to stop the match.
    // ...AND THE BODIES, the same rule about the same frame. The goal threw
    // them and the kickoff is easing them onto their marks (the gather, see
    // holdKickoff); "3" goes up when they are standing there, not while they
    // are still travelling. Bounded by the ease itself rather than by a
    // timeout, because unlike the camera this one cannot fail to converge: it
    // is a residual spent against a curve that reaches 1.
    //
    // BOTH CLOCKS RUN TOGETHER and the count waits on the later of them. In
    // series they would be two waits — and they are the same wait seen from
    // two ends: the shot is chasing a box drawn round the ball and the seals
    // (versusCameraGoal), so it cannot arrive until the bodies have.
    if (!st.settled) {
      st.settleT += rawDt;
      if (cameraRecentred() || st.settleT >= (ko.settleMax ?? 1.6)) st.settled = true;
    }
    if (!st.gathered) {
      st.gatherT += rawDt;
      if (st.gatherT >= Math.max(0, ko.gather ?? 0)) st.gathered = true;
    }
    if (!st.settled || !st.gathered) {
      st.phaseT = 0;
      st.timeScale = scale;
      return scale;
    }
    const tick = Math.max(0.05, ko.tick ?? 0.8);
    const from = Math.max(1, Math.round(ko.count ?? 3));
    // Which numeral is due: `from` at t=0, one fewer every tick, 0 = whistle.
    const due = Math.max(0, from - Math.floor(st.phaseT / tick));
    if (due !== st.count) {
      st.count = due;
      if (due > 0) {
        showCount(String(due));
        // ...AND WHO IS PLAYING, ONCE PER MATCH. A flag rather than a test on
        // `kickoffs`, for two reasons: a rematch is a new match and has to be
        // announced again (it reuses the kickoff count, so the number is past
        // 1 by then), and this fires on every numeral — 3, 2 and 1 — so a
        // condition that stayed true would re-pop the card three times.
        if (!st.introduced) { st.introduced = true; showTeams(); }
        feedback('versusCountdown', { x: ball.x, y: ball.y, scale: 1 + 0.15 * (from - due) });
      } else {
        whistle();
      }
    }
    if (st.phase === 'kickoff' && due === 0) { st.phase = 'play'; st.phaseT = 0; scale = 1; }
  } else if (st.phase === 'play') {
    // THE WHISTLE. A timed match ends when the clock reaches zero and the side
    // ahead wins; level is a draw, which is the one result a first-to cannot
    // produce. Only in 'play': the clock is the MATCH's (see timeLeft), so it
    // is already crawling through a goal's shutter and stopped under a replay,
    // and asking here rather than everywhere is what keeps "the whistle goes
    // while the ball is live" true without a single extra flag.
    if (isTimed() && timeLeft() <= 0) {
      const result = matchResult(st.scores, 0);
      ballEvent('goal');
      // THE KICKOFF'S OWN WHISTLE, not an event of its own. It is the same
      // sound doing the same job at the other end of the match, and a second
      // name would be a second row in CONFIG.feedback to keep in step with it
      // for no difference anybody can hear.
      feedback('versusKickoff', { x: ball.x, y: ball.y, scale: 1 });
      endMatch(result.winner, result.draw);
      st.replayPending = false;
      scale = k.freezeScale ?? 0.04;
    }
  } else if (st.phase === 'replay') {
    // The world stays frozen under the replay; the shutter's own clock is
    // parked and resumes where it left off when the replay ends (endReplay).
    scale = k.freezeScale ?? 0.04;
    updateReplay(rawDt, pads);
  } else if (st.phase === 'scored') {
    const freeze = k.freeze ?? 0.35;
    const ramp = k.ramp ?? 0.45;
    const floor = k.freezeScale ?? 0.04;
    // The freeze has had its beat with the number up: now the replay, and the
    // rest of the shutter waits for it.
    if (st.replayPending && st.phaseT >= freeze) { startReplay('scored'); st.timeScale = floor; return floor; }
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
      landScore(st.scorer);
      // THE ONE KICKOFF THAT GATHERS — see enterKickoff. A goal is the only
      // way into a kickoff with bodies still flying from a shockwave.
      enterKickoff(true);
    }
  } else if (st.phase === 'won') {
    scale = k.freezeScale ?? 0.04;
    if (st.replayPending && st.phaseT >= (k.freeze ?? 0.35)) { startReplay('won'); st.timeScale = scale; return scale; }
    // The winner's number has had its hold; now the question. The water
    // stays frozen under it — a prompt over a match that has quietly kicked
    // off again is a prompt nobody reads.
    if (st.phaseT >= (k.wonHold ?? 3.5)) {
      st.phase = 'over';
      st.phaseT = 0;
      // THE REEL, UNDER THE PROMPT. Started before showOver so the first clip
      // is already posed on the frame the buttons come up: a prompt that
      // appears over frozen water and only then starts moving reads as two
      // events, and the water going from stopped to a hard cut reads as a
      // crash.
      startReel();
      showOver();
    }
  } else if (st.phase === 'over') {
    scale = k.freezeScale ?? 0.04;
    // The reel plays on the WALL clock — it is footage, not the match, and
    // the match under it is frozen at four percent.
    updateReel(rawDt);
    updateOver(pads);
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
  // THE FOOTAGE FIRST. A reel left running poses the seals from a clip every
  // frame, so a kickoff called under it puts everyone on their spot and the
  // next posed frame puts them straight back in the middle of a goal.
  stopReel();
  // ...and the archive with it: a rematch is a new match, and the last one's
  // highlights are not this one's.
  resetReel();
  // A REMATCH IS A NEW MATCH — the same reset the whistle's match opened on,
  // and not a shorter one. It used to zero the two scores and nothing else,
  // which left the MATCH CLOCK where the last match had spent it: a timed
  // rematch opened with no time on it and blew the whistle on its first frame
  // of play, 0–0, a draw nobody had played. The scores, the ledger the stats
  // page reads, the last goal, the recorder's tape and the clock they are all
  // stamped against go back together, in one place, so the next thing added to
  // a match cannot be cleared for one of the two ways in and not the other.
  //
  // The sides are announced again as part of it (`introduced`) — the same two
  // names, because the cast belongs to the match setup and neither the colours
  // nor the roster have moved. See showTeams.
  resetMatchState();
  hideOver();
  hideCard();
  paintScores();
  enterKickoff();
}

function chooseOver(i) {
  if (versusState.phase !== 'over') return;
  overCursor = i;
  paintOver();
  if (i === 0) rematch();
  else { stopReel(); hideOver(); versusHooks.onMainMenu?.(); }
}

function updateOver(pads = null) {
  // Polled whether or not the DOM is there: the prompt is a STATE of the
  // match and the panel is only its face, so a harness with no document can
  // still answer it — and a page where the panel failed to mount is not a
  // match nobody can leave.
  for (const p of pollPads(overPads, pads)) {
    if (p.press.left || p.press.up) { overCursor = 0; paintOver(); }
    else if (p.press.right || p.press.down) { overCursor = 1; paintOver(); }
    else if (p.press.a || p.press.start) { chooseOver(overCursor); return; }
  }
  // THE POINTER'S ANSWER, drained from the artboard on the same frame the pads
  // are read — one place the prompt is answered, whichever of the three inputs
  // did it. `takePick` clears as it reads, so a click is acted on once.
  const picked = statsCard?.takePick?.() ?? 0;
  if (picked) { chooseOver(picked - 1); return; }
  // The artboard's own hover listeners move `overCursor` too, so read it back:
  // a pointer resting on a button has to leave the pad's next press starting
  // from what is actually lit.
  const lit = statsCard?.readCursor?.();
  if (lit === 0 || lit === 1) overCursor = lit;
  paintOver();
}

function onOverKey(e) {
  if (versusState.phase !== 'over') return;
  switch (e.key) {
    case 'ArrowLeft': case 'ArrowUp': case 'a': case 'w': overCursor = 0; paintOver(); break;
    case 'ArrowRight': case 'ArrowDown': case 'd': case 's': overCursor = 1; paintOver(); break;
    case 'Enter': case ' ': chooseOver(overCursor); break;
    default: return;
  }
  e.preventDefault();
  e.stopPropagation();
}

/**
 * The selection, onto the page. Safe before the artboard has loaded: the card
 * is re-painted on every pad poll, so the first frame after it mounts carries
 * the cursor whatever happened while it was still loading.
 */
function paintOver() {
  statsCard?.setOver(versusState.phase === 'over', overCursor);
}

let statsCard = null;
let statsWanted = false;

/**
 * THE STATS PAGE, as a Blubberball match leaves it — ui/statsCard.js draws it
 * from rive/blubberball.
 *
 * SEATS GO OUT IN COLUMN ORDER, NOT SEAT ORDER. Seats alternate sides
 * (teamOfSeat is `i % TEAMS`), and the page's players tab is two columns of
 * four — so handing it seats 0..7 as they come would deal one side's seals
 * down both columns. seatsOfTeam is the mapping, and the reason it exists.
 *
 * NO LABELS ARE PASSED, and that is not an omission. ui/statsCopy.js writes
 * every word on the page from uiText.csv on every paint, so a caller cannot
 * forget one — this hands over the match's NUMBERS and nothing a player reads
 * as a sentence.
 */
function statsCardData() {
  const st = versusState;
  const snap = tallySnapshot();
  const colors = goalColors();
  const order = [...seatsOfTeam(0), ...seatsOfTeam(1)];
  const bySeat = new Map(snap.seats.map((s) => [s.seat, s]));
  return {
    scores: [st.scores[0], st.scores[1]],
    colors,
    // The winner's colour lights the record badge. A draw leaves the
    // artboard's own accent alone rather than picking a side. The hover glows
    // are NOT this: they are keyframed in the .rml, and a bind on a property a
    // timeline also writes is a fight the timeline wins.
    accent: st.winner >= 0 ? colors[st.winner] : null,
    teams: [0, 1].map((t) => ({ name: teamName(t), ...snap.teams[t] })),
    seats: order.map((i) => ({ name: seatName(i), ...(bySeat.get(i) ?? {}) })),
    // Rows per column, so a one-a-side match shows one line a side rather than
    // four, three of them empty.
    seatsPerSide: rosterPerSide(),
    isRecord: false,
    // THE RESULT, which the page reports rather than a box floating over it.
    // The SIDE, not the seal that scored the last goal — that one animal is
    // credited on the goal card, where it belongs, and this is the answer to
    // who won. A draw has no name and says so through `draw`.
    draw: st.winner < 0,
    championName: st.winner >= 0 ? teamName(st.winner) : '',
  };
}

/**
 * IMPORTED WHEN A MATCH ENDS, not when this module loads. ui/statsCard.js
 * pulls in blubberball.riv, which is 430KB no match needs until the whistle —
 * and which a Node harness cannot load at all, so a static import here would
 * take tools/versus-test.mjs down with it.
 *
 * `statsWanted` is the guard: the prompt can be gone by the time the import
 * lands (a rematch pressed on the first frame it was up), and a card mounted
 * after that would have nothing to sit on and nothing to take it down.
 */
function showStats() {
  // GATED ON THE ROOT IT MOUNTS IN, and nothing else. It used to ask for
  // `ui.over` — the DOM prompt this page REPLACED — and that element stopped
  // being built the day the page took over from it, so the guard was never
  // true again and the score screen silently stopped appearing at the end of
  // every match. A guard naming something the mount does not build is a guard
  // that can only ever be wrong; this one names the thing it needs.
  if (!ui?.root || statsCard || statsWanted) return;
  statsWanted = true;
  import('../ui/statsCard.js')
    .then(({ mountStatsCard }) => {
      if (!statsWanted || !ui?.root || statsCard) return;
      statsCard = mountStatsCard({ parent: ui.root, data: statsCardData() });
    })
    .catch((err) => {
      console.warn(`[versus] the stats page did not load — ${err?.message ?? err}`);
    })
    .finally(() => { statsWanted = false; });
}

function hideStats() {
  statsWanted = false;
  statsCard?.destroy();
  statsCard = null;
}

function showOver() {
  overCursor = 0;
  overPads.clear();
  if (!ui?.root) return;
  // THE GOAL CARD LEAVES BEFORE THE PAGE ARRIVES, and it leaves FIRST in this
  // function on purpose — dismissCard drops the card's opacity out on this
  // frame, and showStats cannot paint a pixel for at least a dynamic import
  // and a .riv decode, so there is no frame with both on screen even if the
  // module is already warm from an earlier match.
  //
  // It used to stay. The card rose to 26% (a rule in the sheet below, now
  // gone) and sat there over the top of the stats page for as long as the
  // prompt was up: the last goal's caption and the match's whole ledger, two
  // surfaces answering at once, with the caption the smaller and nearer one.
  // The card is a caption on a MOMENT and the moment is over — the page is
  // what the screen is for now, and the scorer it named is on it, in the row
  // that credits them.
  dismissCard();
  // ...AND THE SCORE STRIP WITH IT, for the reason in the sheet below: the
  // page carries both numbers and the clock, so the strip is a second, smaller
  // answer laid over the full one. Set here and cleared in hideOver, which is
  // the one pair of doors the end state has — a rematch comes back through it
  // and gets its strip back.
  ui.hud?.classList.add('sv-versus-hud-gone');
  // THE PROMPT IS THE STATS PAGE. It used to be a DOM panel at the centre of
  // the screen with this card mounted on top of it — the prompt was behind the
  // artboard, and the only way to answer it was the keyboard or a pad.
  showStats();
  paintOver();
  if (!overKey && typeof window !== 'undefined') {
    overKey = onOverKey;
    window.addEventListener('keydown', overKey, true);
  }
}

function hideOver() {
  statsCard?.setOver(false, overCursor);
  hideStats();
  // THE STRIP COMES BACK — and unconditionally, not only on a rematch. The
  // HUD is HIDDEN between matches rather than rebuilt (hideUi sets
  // root.hidden; mountUi keeps the `ui` it already has), so this element
  // outlives the match that faded it. Clearing it on only one of the two ways
  // out would leave the next match's strip at opacity 0: a score that is not
  // there at all, on a screen where everything else is, which reads as a bug
  // in the match rather than as a class nobody took off.
  // Every exit is through here — the rematch, the main menu, hideUi and the
  // text panel's preview all call it — which is why it is the one place.
  ui?.hud?.classList.remove('sv-versus-hud-gone');
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
  // THE STRIP TAKES IT NOW, on the frame the goal registers. It used to wait
  // for `respawn` — and the shutter's clock is PARKED under the replay, so in
  // practice the score sat unchanged through the freeze, the whole replay and
  // the ramp back, and only moved once the ball was already on its way to the
  // centre spot. The number is the one piece of a match that is not a look:
  // it is the state of the game, and a scoreboard that lags the goal by five
  // seconds reads as the goal not having counted.
  popScore(scorer);
  st.lastGoal = { side, scorer, x: ball.x, y: ball.y, t: st.clock, credit: creditGoal(scorer) };
  // The same credit the goal card reads, booked to the seats that earned it.
  noteTallyGoal(st.lastGoal.credit);
  // THE ARCHIVE'S COPY, taken now — before the ring rolls over the shot. The
  // instant replay below plays out of the ring itself; the reel at the end of
  // the match needs this goal three minutes from now, when the ring has
  // forgotten it twenty times over. See systems/versusReel.js.
  noteGoalClip(st.lastGoal);
  // The danger this goal ended was not a save.
  clearSaveWatch();
  ball.live = false;
  ball.vx = ball.vy = 0;
  st.phaseT = 0;
  st.flown = false;
  st.respawned = false;
  // THE GOAL'S OWN EVENTS, at the mouth rather than where the ball is — the
  // ball is off the edge of the screen by definition when this is called.
  // The spray is thrown back out of the hole into the water (dirX). Two
  // events, as a boss blow is: the impact and the cheer, tuned side by side
  // in the F panel's Blubberball section.
  const mouthX = side === 'left' ? bounds.left : bounds.right;
  const out = side === 'left' ? 1 : -1;
  // THE SCORER'S COLOUR, on all of it. The ball fills with it on the way in
  // (claimBall — the share marches to a full takeover from the last touch),
  // and the blow out of the mouth is the same colour rather than the ball's
  // own: a goal is scored BY somebody, and this is the moment that reads
  // loudest. The jet below and the replay's own explosion take it too.
  claimBall(scorer, Math.atan2(0, out));
  const at = { x: mouthX, y: ball.y, dirX: out, dirY: 0, vx: out * 20, vy: 0, scale: 1, color: teamColor(scorer) };
  // THE MOUTH CHANGES HANDS. A goal goes into the light of the team that just
  // conceded it, so for the length of the envelope (CONFIG.versus.goal.scored)
  // that light is the SCORER'S colour instead — and the corridor, the spill
  // into the water and the bloom over all of it go with it, because they are
  // all one quad. Handed back by tickGoalGlow, on the wall clock, so it plays
  // out across the shutter's freeze and the replay rather than stalling.
  flashGoalScored(side === 'left' ? -1 : 1, scorer);
  feedback('versusGoal', at);
  feedback('versusGoalCheer', at);
  // ...AND THE MUSIC MOVES ON A STEP. The match bank is gated on goals — the
  // loop that is playing repeats until somebody scores — so this is the whole
  // of what drives the cycle. It does not cut the music: the switch is booked
  // for the end of the loop the ball went in over. See the match rotation in
  // systems/music.js. Called here rather than off the `versusGoal` feedback
  // event, which the replay fires a second time on its explosion beat.
  versusGoalScored();
  // ...and the jet: the ball's substance fired back out of the corridor from
  // off screen, driven off the lips. systems/goalJet.js; stepped by main.js
  // on the wall clock so it runs through the shutter's freeze. NOT when a
  // replay is coming: the replay's last beat is this explosion, framed, and
  // it fires the jet there — see startReplay.
  // IS THAT THE MATCH? In a first-to it is the goal that asks; in a timed match
  // the goal never ends anything and the whistle does. One function answers
  // both (systems/matchRules.js), so there is no branch here that has to know
  // which kind of match this is.
  const result = matchResult(st.scores, timeLeft());
  const won = result.over;
  st.replayPending = replayWanted(won);
  // THE SHOCKWAVE, on this frame whether or not a replay is coming — see
  // goalBlast. The jet below is a shot the replay restages; this is the water
  // moving, and the replay poses the seals from the record, so a throw held
  // back for the replay's bang would go off after the footage had handed the
  // pitch back. The seals are thrown when the goal goes in.
  goalBlast(side === 'left' ? -1 : 1, ball.y);
  if (!st.replayPending) {
    fireGoalJet(side === 'left' ? -1 : 1, ball.y, scorer);
    // ...and the light on whoever scored, a beat behind the bang. With a
    // replay coming it waits for the replay's own explosion beat, so the
    // light lands on the same frame the goo does either way.
    spotlightScorer(scorer);
  }
  // POSSESSION SURVIVES THE GOAL, all the way to the kickoff. This used to
  // clear the ball's look here — and the replay that opens a beat later then
  // played the whole shot back with a white ball, because the tint had already
  // decayed off the goo group. The ball is not back at centre yet; the thing
  // that puts it there is enterKickoff, and that is where it stops belonging
  // to the seal that scored (it calls resetBallLook itself).
  // ...AND THE POSE WAITS FOR THE REPLAY TOO. The same gate as the jet above,
  // for a stronger reason: a celebration runs on the WALL clock — main.js
  // ticks updateCelebration and player.celebrate every frame whatever the
  // phase is — so one started here was already most of the way through by the
  // time the replay opened, and what the replay opened on was the scorer
  // mid-somersault over footage from a second BEFORE the goal. The replay
  // stages its own on the celebration beat, which is the frame the replay says
  // the goal happened.
  if (!st.replayPending) celebrateGoal(scorer);
  flushImitation('goal');
  if (won) {
    endMatch(result.winner, result.draw, { onGoal: true });
  } else {
    st.phase = 'scored';
    // The biggest kick the ball gets, and it lands on the frame the shutter
    // starts — so the warp is already blooming as the camera punches in.
    ballEvent('goal');
    showCard(scorer, false);
  }
}


/**
 * THE MATCH IS OVER — from the goal that won it, or from the clock running out.
 *
 * One function because the two endings are the same ending: the water freezes,
 * every seal hears its own side's result, and the card says who. What differs
 * is only that a timed match can end with nobody ahead, which a first-to cannot
 * do by construction.
 *
 * @param winner  0, 1, or -1 for a draw
 * @param draw    true when the clock ran out level
 */
function endMatch(winner, draw = false, { onGoal = false } = {}) {
  const st = versusState;
  st.phase = 'won';
  st.phaseT = 0;
  st.winner = winner;
  st.draw = !!draw;
  // ONE RESULT, HEARD TWICE — at each seal, so the rumble in the winner's hands
  // is not the rumble in the loser's. Over the goal's own bang and cheer: this
  // is what that goal MEANT. Every seat, not just the two captains, because a
  // side is a side.
  //
  // A DRAW IS NEITHER, and giving everybody the winner's rumble because there
  // was no loser is the one reading that is wrong for both of them.
  for (const seal of matchSeals()) {
    const seat = seatOf(seal);
    const p = sealPos(seal);
    if (draw) continue;
    feedback(teamOfSeat(seat) === winner ? 'versusWin' : 'versusLose', { x: p.x, y: p.y, team: seat });
  }
  // WHICH CARD depends on what ended it, not on who won.
  //
  // A first-to ends ON a goal, and that goal's scorer IS the winner — so the
  // card it already shows (the name, the assist, the clock) is the result, and
  // showing anything else would throw away the one moment the match was about.
  //
  // A timed match ends on the WHISTLE, and the last goal before it is very
  // often the losing side's. Naming that scorer on the result card would read
  // as crowning them.
  if (onGoal && !draw) showCard(winner, true);
  else showResultCard(winner, draw);
}

/**
 * THE CARD FOR A RESULT NOBODY SCORED — the whistle in a timed match, and the
 * draw that only a timed match can produce.
 *
 * No name and no assist: those belong to a goal, and what happened here is the
 * clock. The side's colour carries who, which is the same thing the strip above
 * it is already saying.
 */
function showResultCard(winner, draw) {
  if (!ui) return;
  // NOTHING LEFT FOR THIS CARD TO SAY. It carried the result — the line, and
  // the winning side's name under it — and both are on the stats page now
  // (ui/statsCard.js, off `championName`/`draw` in statsCardData). A card that
  // repeated them would be a second answer to the same question, floating over
  // the page giving the first one.
  //
  // So the whistle takes the goal card DOWN and the page is the result. The
  // colour of the pane said who won and the page says it in the accent and in
  // the name, which is more than the pane ever did.
  hideCard();
  paintScores();
}

/**
 * SECONDS LEFT ON THE MATCH CLOCK, or Infinity when the match is not timed —
 * which is the value that makes matchResult's "has it run out" test read the
 * same for both kinds of match rather than needing a branch.
 */
export function timeLeft() {
  if (!isTimed()) return Infinity;
  return Math.max(0, matchSeconds() - versusState.clock);
}

// ---------------------------------------------------------------------------
// THE KICKOFF — everyone to their end, a full wheel, food in the way, and a
// count. See CONFIG.versus.kickoff.
// ---------------------------------------------------------------------------

const _start = Array.from({ length: MAX_PER_SIDE * 2 }, () => ({ x: 0, y: 0 }));

/**
 * WHICH ROTATION OF THE FORMATION THIS KICKOFF IS — the first one is 0.
 *
 * `versusState.kickoffs` is a COUNT and the first kickoff has already stepped
 * it to one by the time anything is placed, so spending it raw would rotate the
 * opening kickoff and put neither captain on its own front line. One off, in
 * one place, rather than at each of the three call sites that would otherwise
 * each have to remember it.
 */
export function kickoffTurn() {
  return Math.max(0, versusState.kickoffs - 1);
}

/**
 * Where seal `who` stands for a kickoff: its side's anchor, `inset` of the
 * pitch in from its own wall, plus the formation spot its side's rotation gives
 * it this time round — and the whole of that swung and stretched by this
 * kickoff's own roll (kickoffScatter).
 *
 * `turn` is which kickoff this is, and BOTH of the things that vary read it:
 * the spots ROTATE within a side, the way a kickoff rotates in Rocket League,
 * so the seal that took the front spot last time takes the one behind it now
 * (see formationSlot in systems/sealRoster.js) — and the roll is a pure
 * function of it. Defaulted to the match's own count so nothing that only wants
 * "where does this seat start" has to know about it, and passable so the labs
 * and the harness can ask for a particular kickoff.
 *
 * PURE IN (who, turn), which is load bearing rather than tidy: this is asked
 * several times per kickoff — once per seat as the roster is built, again as
 * everyone is placed, again by the bots — and a roll made HERE would hand a
 * different mark to each of them.
 */
export function kickoffSpot(who, out = _start[who] ?? { x: 0, y: 0 }, turn = kickoffTurn()) {
  const width = bounds.right - bounds.left;
  const half = (bounds.top - bounds.bottom) * 0.5;
  const team = teamOfSeat(who);
  // A SIDE IS A FORMATION, not a queue. The captain of each side stands on its
  // side's anchor; the seats behind it start further back from the middle and
  // fan above and below the water's centre — see seatFormation, which returns
  // shares because the arena is rebuilt at a different width for a match and
  // this is the only place holding the bounds.
  const f = seatFormation(who, turn);
  // ...AND THE WHOLE FORMATION IS SOMEWHERE SLIGHTLY DIFFERENT EACH TIME. The
  // anchor swings and moves in or out; the shape hanging off it does not
  // change. See kickoffScatter.
  const sc = kickoffScatter(turn, _scatter);
  // IN THE SIDE'S OWN FRAME, and that is what makes the two sides mirror
  // images rather than two sums that happen to agree. `u` is distance from the
  // centre spot toward this side's OWN wall and `v` is height in the water;
  // both are computed once, without asking which team this is, and only the
  // last line spends the side. Written as two branches — one adding `inset`
  // to bounds.left and one subtracting it from bounds.right — it was two
  // chances to get one arrangement right, and a scatter would have been a
  // third and a fourth.
  //
  // UP THE PITCH, not back down it. The anchor is already most of the way into
  // its own half — `inset` is a sixth of the width from the wall — so the room
  // a formation has is in FRONT of it, toward the middle. Fanning the other
  // way put the fourth seat of a full roster inside the rock.
  let u = anchorOut() + sc.du - f.back * width * 0.5;
  const v = sc.dv + f.lane * half * 0.5;
  // Halfway is the ceiling: a seat may line up level with the ball at a push
  // and never in the other side's half, which is not a rule about fairness but
  // about the kickoff reading as two sides facing each other.
  u = Math.max(1, u);
  const mid = (bounds.left + bounds.right) * 0.5;
  out.x = team === 0 ? mid - u : mid + u;
  // ...and inside the water, whatever the lane asked for.
  out.y = Math.max(bounds.bottom + 4, Math.min(bounds.surfaceY - 4, midWater() + v));
  return out;
}

/** A SIDE'S ANCHOR, as a distance from the centre spot toward its own wall:
 *  where its captain stands before any scatter. The one number both sides are
 *  built out of, so neither can drift from the other. */
function anchorOut() {
  const width = bounds.right - bounds.left;
  return width * 0.5 - clamp01(cfg().kickoff?.inset ?? 0.16) * width;
}

/**
 * HOW FAR A SIDE'S FORMATION ALREADY REACHES off its anchor — the most any
 * seat of one side is fanned up or down the water, and the furthest forward
 * any of them stands. World units.
 *
 * This is the room the scatter is NOT allowed to spend. A 1v1 has one seat on
 * the anchor and reaches nowhere, so it may swing the whole way; a full roster
 * already fills most of the water it is allowed and may barely move. That is
 * the honest rule rather than a per-roster table of amounts: the scatter gets
 * what the formation leaves, and a roster size nobody has tried yet is handled
 * by the same sentence.
 *
 * Turn 0 is enough — the rotation is a PERMUTATION of the same spots, so every
 * turn reaches exactly as far as every other one.
 */
function formationReach() {
  const width = bounds.right - bounds.left;
  const half = (bounds.top - bounds.bottom) * 0.5;
  let lane = 0;
  let back = 0;
  // One side's seats, off the mapping that owns which they are — seats
  // alternate, and "every other one" written out here would be a second copy
  // of that fact.
  for (const i of seatsOfTeam(0)) {
    const f = seatFormation(i, 0);
    lane = Math.max(lane, Math.abs(f.lane) * half * 0.5);
    back = Math.max(back, f.back * width * 0.5);
  }
  return { lane, back };
}

// The kickoff's roll, in world units: how far the anchor moves out toward its
// own wall (`du`, negative is toward the ball) and up the water (`dv`). One
// object, refilled — kickoffSpot asks once per seat and reads it immediately.
const _scatter = { du: 0, dv: 0, angle: 0, scale: 1 };

// How close to the halfway line the FRONT seat may be pushed, and how close to
// its own wall the anchor may be pushed. Both in world units, and both are the
// clamps that already existed in spirit: `1` is the halfway gap kickoffSpot has
// always held, and `4` is the margin the water clamp uses at the surface and
// the seabed, spent here on the wall.
const SCATTER_MID_GAP = 1;
const SCATTER_WALL_GAP = 4;

/**
 * THE KICKOFF'S OWN ROLL — where the two formations stand THIS time.
 *
 * A 1v1 has one formation spot per side, so formationSlot's rotation — the
 * thing that keeps a bigger roster moving between kickoffs — is the identity
 * for it, and the two seals opened every kickoff of the match on the same two
 * marks. This is what varies it.
 *
 * SYMMETRIC, AND BY CONSTRUCTION RATHER THAN BY ARITHMETIC. One roll is made
 * and both sides are placed from it in their own frame (see kickoffSpot), so
 * the two spots are mirror images across the halfway line: same distance from
 * the ball, same height in the water, opposite halves. There is no roll for
 * side 1 that could come out different.
 *
 * MIRRORED IN X AND NOT ROTATED THROUGH 180°, which is the other symmetry this
 * could have had and is not fair: up and down are not the same in this arena.
 * One seal at the surface with air over it and the other on the seabed is a
 * point-symmetric kickoff and an uneven one.
 *
 * SEEDED, NOT ROLLED WHERE IT IS READ. kickoffSpot is asked several times per
 * kickoff — once per seat as the roster is built, again as everyone is placed,
 * again by the bots and the labs — and a Math.random() in here would hand a
 * different answer to each of them, which is a seal placed somewhere nothing
 * else agrees it is. So the roll is a hash of the kickoff's number and the
 * match's seed: a pure function of `turn`, the same for every caller, and
 * replayable by pinning versusState.kickoffSeed.
 *
 * `out` is filled and returned. Angle and scale are the raw roll, kept for the
 * harness and the labs; `du`/`dv` are what was actually spent after the room
 * the formation leaves is taken out of it.
 */
export function kickoffScatter(turn = kickoffTurn(), out = _scatter) {
  const c = cfg().kickoff?.scatter ?? {};
  const maxAngle = Math.max(0, c.angle ?? 0);
  const range = clamp01(c.distance ?? 0);
  const base = anchorOut();
  out.angle = 0;
  out.scale = 1;
  out.du = 0;
  out.dv = 0;
  if (base <= 0 || (maxAngle <= 0 && range <= 0)) return out;

  const seed = (Math.imul(Math.round(turn) + 1, 0x9e3779b1) ^ (versusState.kickoffSeed | 0)) >>> 0;
  const angle = (hash01(seed) * 2 - 1) * maxAngle;
  const scale = 1 + (hash01(seed ^ 0x5bf03635) * 2 - 1) * range;

  // THE ROOM LEFT OVER, per axis and per direction — out toward the wall, in
  // toward the ball, and up or down the water are three different distances.
  //
  // `distance` IS MEASURED ON THE FRONT SEAT, not on the anchor. The anchor of
  // a full roster stands with three seats in front of it, and a share of the
  // ANCHOR's standoff is most of the FRONT seat's — a fifteen percent nudge of
  // the formation would have walked the frontmost seal most of the way to the
  // halfway line and handed it every kickoff. Taking the share off the seat
  // that is closest to the ball is the same sentence the lane limit below
  // says: the tighter the formation already is, the less there is to spend.
  const reach = formationReach();
  const front = Math.max(0, base - reach.back);
  const laneRoom = Math.max(0, Math.min(bounds.surfaceY - 4 - midWater(), midWater() - (bounds.bottom + 4)) - reach.lane);
  const inRoom = Math.min(front * range, Math.max(0, base - reach.back - SCATTER_MID_GAP));
  const outRoom = Math.min(base * range, Math.max(0, (bounds.right - bounds.left) * 0.5 - SCATTER_WALL_GAP - base));

  const du = base * scale * Math.cos(angle) - base;
  const dv = base * scale * Math.sin(angle);
  out.angle = angle;
  out.scale = scale;
  out.du = Math.max(-inRoom, Math.min(outRoom, du));
  out.dv = Math.max(-laneRoom, Math.min(laneRoom, dv));
  return out;
}

/** One 32-bit integer to one number in [0, 1). A hash and not a generator:
 *  there is no stream here to advance, only "what did kickoff n roll". */
function hash01(n) {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * WHICH WAY A SEAL FACES ON ITS KICKOFF SPOT: at the ball, in world radians.
 *
 * Not "inward". Every seal used to be turned to a flat ±90° — straight across
 * the pitch — which is the right answer for exactly the two seats that stand
 * on the centre lane and wrong for every other spot in a formation: a seal
 * parked a third of the way up the water looked at the far wall while the ball
 * it is about to race for sat below and to the side of it. The count is spent
 * looking at the thing you are counting down to.
 *
 * The ball's kickoff position rather than `ball` itself, because this is read
 * while the ball is still being put back (enterKickoff calls resetBall first,
 * but buildRoster asks before there IS a ball).
 */
function kickoffFacing(spot) {
  const cx = (bounds.left + bounds.right) * 0.5;
  const cy = midWater();
  const dx = cx - spot.x;
  const dy = cy - spot.y;
  // A seal standing ON the centre spot has no direction to face. Give it its
  // side's, which is the answer the flat rule always gave.
  if (Math.hypot(dx, dy) < 1e-3) return 0;
  return Math.atan2(dy, dx);
}

/**
 * Put the match at a kickoff. The ball is at centre, the seals are on their
 * spots facing the ball with a full wheel each, bait balls are dropped along
 * each seal's line to the ball, and the countdown starts — the world is held at
 * freezeScale from here until the whistle (updateVersusClock).
 */
export function enterKickoff(gather = false) {
  const st = versusState;
  const ko = cfg().kickoff ?? {};
  st.phase = 'kickoff';
  st.phaseT = 0;
  st.count = -1;      // so the first numeral is due on the next clock tick
  // ...but not until the frame is back on the pitch — see `settled`.
  st.settled = (cfg().kickoff?.settle ?? true) === false;
  st.settleT = 0;
  st.kickoffs += 1;
  for (let i = 0; i < st.checked.length; i++) st.checked[i] = false;
  resetBall();
  ballEvent('reset');
  resetBallLook();
  // The trail goes with it. The ball teleports from the back of a goal to the
  // centre spot, and a cloud that survived that would be joined to the new one
  // by a ribbon drawn straight across the pitch.
  if (scene) clearBallTrail(scene);
  resetBallSpit();
  // The backdrop's dents too, and for the same reason read the other way: they
  // are marks on the WATER rather than on the ball, so they would not follow it
  // to the centre spot — they would sit in a line pointing into the goal it
  // just went in, springing, under a kickoff.
  resetBallGrid();
  // The spots for THIS kickoff — st.kickoffs has already been stepped above, so
  // the formation has rotated by the time anything is placed on it.
  for (let i = 0; i < rosterSize(); i++) kickoffSpot(i);
  // THE GATHER, ARMED BEFORE ANY BODY IS PUT BACK — see armGather. Only a
  // kickoff called by a GOAL gathers: it is the one that follows a shockwave,
  // and it is the only one with a pose worth blending out of. A match opening
  // has already built its roster standing on the marks, and a rematch is
  // called out of a highlight reel that was posing the seals from recorded
  // frames — easing out of either is easing out of nothing.
  st.gathered = true;
  st.gatherT = 0;
  _gatherS = 0;
  if (gather && ko.enabled !== false && (ko.gather ?? 0) > 0) st.gathered = !armGather();
  holdKickoff();
  // AT THE BALL, and the mirror resolved afresh from that facing (poseBody).
  // EVERY seat, seat 0 included: the player used to be the one seal this loop
  // skipped, so the seal holding the frame was the only one on the pitch still
  // pointing wherever it happened to die facing.
  //
  // THE AIM AND THE DASH ONLY while a gather is running — holdKickoff is what
  // turns the body, over the ease rather than in one frame. These two are the
  // seal's INTENT rather than its pose, and there is nothing to blend about
  // "which way am I about to swim": they are written now either way, so a bot
  // reading its own aim on the first frame of the count reads the kickoff's.
  for (const seal of matchSeals()) {
    const seat = seatOf(seal);
    const spot = _start[seat] ?? _start[0];
    const face = kickoffFacing(spot);
    const fx = Math.cos(face);
    const fy = Math.sin(face);
    if (seat === 0) {
      strikeState.dashDir.x = fx; strikeState.dashDir.y = fy;
    } else {
      seal.strike.dashDir.x = fx; seal.strike.dashDir.y = fy;
      seal.input.aim.set(fx, fy);
    }
  }
  if (ko.enabled === false) {
    // No count: straight to play, the way the mode ran before it had one.
    st.phase = 'play';
    st.count = 0;
    return;
  }
  dropKickoffBait();
}

// ---------------------------------------------------------------------------
// THE GATHER — from wherever the goal left a body to where the kickoff wants
// it, over `kickoff.gather` wall seconds.
//
// A goal fires a shockwave out of the mouth (goalBlast) that throws every seal
// near it across the pitch, end over end and limp. That is the point of it,
// and the kickoff used to undo it in a single frame: `holdKickoff` wrote every
// position, every heading and every tumble angle outright, so the last thing a
// goal did was teleport four somersaulting animals onto four marks. The bang
// and the count read as two clips spliced together.
//
// So the placement is EASED instead. The marks, the facings and the roll are
// exactly what they always were — nothing about where a kickoff stands has
// changed — but the bodies travel to them over a beat, and the count does not
// start until they have arrived (versusState.gathered, read in
// updateVersusClock alongside `settled`).
//
// WALL SECONDS, like everything else in this shutter. The world is at
// freezeScale — four percent — from the frame the kickoff is called, so an
// ease stepped on the water's clock would take half a minute to cross the
// pitch with the countdown running at full speed over the top of it.
// ---------------------------------------------------------------------------

// Where each body was when the gather was armed, and the roll it is rolling
// TO. Position and heading need no `from` — the ease below is written as a
// residual (see `pull`), so it reads them off the body every frame and cannot
// fight whatever else is still moving it. The mirror does: its target is the
// nearest half turn of the right parity to where the angle stood when the
// gather opened, and re-deriving that from a moving angle would walk it.
const _gatherTo = Array.from({ length: MAX_PER_SIDE * 2 }, () => ({ mirror: 0, from: 0, has: false }));
// The eased progress the last frame spent, so this frame can spend only the
// difference. See `pull`.
let _gatherS = 0;

/**
 * Open a gather: record each body's roll target, and say whether anything
 * actually has to move.
 *
 * FALSE WHEN NOBODY IS OUT OF PLACE, which is not an optimisation. A kickoff
 * whose bodies are already standing on their marks with the right heading has
 * nothing to ease, and a gather armed over it would still hold the count for
 * `gather` seconds — a beat of nothing, on every kickoff of a match where the
 * goal caught nobody.
 */
function armGather() {
  let move = false;
  const near = 0.05;          // world units, and radians: below this it is the same pose
  for (const seal of matchSeals()) {
    const seat = seatOf(seal);
    const spot = _start[seat] ?? _start[0];
    const face = kickoffFacing(spot);
    const p = sealPos(seal);
    const to = _gatherTo[seat];
    if (!to) continue;
    to.has = true;
    to.from = seal.mirrorAngle;
    to.mirror = mirrorFor(seal, face);
    // The roll is driven here rather than by poseBody's own turnaround: that
    // one is stepped on the frame's dilated dt and would take twenty-five
    // times the beat it was authored for under the freeze. Settled so the
    // ease block in poseBody stays out of the way, and `mirrored` moved to
    // the side the seal is rolling TO so nothing starts a second turnaround
    // on top of this one.
    seal.mirrorT = 1;
    seal.mirrorFrom = seal.mirrorTo = seal.mirrorAngle;
    if (CONFIG.view === 'side') seal.mirrored = Math.cos(face) < 0;
    if (Math.hypot(p.x - spot.x, p.y - spot.y) > near) move = true;
    if (Math.abs(shortArc(face - Math.PI / 2 - seal.mesh.rotation.z)) > near) move = true;
    if (Math.abs(to.mirror - seal.mirrorAngle) > near) move = true;
    const j = seal.jolt;
    if (j && (Math.abs(j.spin) > near || Math.abs(j.roll) > near)) move = true;
  }
  return move;
}

/** WHICH HALF TURN THE BELLY ROLLS TO for a seal about to face `face`: the
 *  nearest one that leaves it the right way up. The same parity walk poseBody
 *  makes on a turnaround — the angle climbs through whole half turns over a
 *  run, so "0 or PI" is the wrong answer to it, and rolling the SHORT way is
 *  what keeps a gather from unwinding a corkscrew it never made. */
function mirrorFor(seal, face) {
  if (CONFIG.view !== 'side') return seal.mirrorAngle;
  const HALF = Math.PI;
  const want = Math.cos(face) < 0 ? 1 : 0;
  let half = Math.round(seal.mirrorAngle / HALF);
  if (((half % 2) + 2) % 2 !== want) half += seal.mirrorAngle >= half * HALF ? 1 : -1;
  return half * HALF;
}

/** An angle wrapped into (-pi, pi]. */
function shortArc(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * HOW MUCH OF THE REMAINING DISTANCE THIS FRAME SPENDS.
 *
 * The ease is written as a residual rather than as a lerp from a remembered
 * start, because a lerp from a remembered start is a body that has stopped
 * being simulated: the goal's throw would be over on the frame the gather
 * opened, and the seal would glide to its mark on rails. Held as a residual,
 * whatever else moves the body — the last of the shove, the tumble righting
 * itself — keeps moving it, and the pull only takes a share of whatever gap
 * is left.
 *
 * `(s - prev) / (1 - prev)` is what makes that share add up to the curve. A
 * per-frame lerp by the eased progress itself compounds — sixty frames of
 * "move a tenth of the way" is not a tenth of the way — so what is spent each
 * frame is the FRACTION OF THE REMAINDER the curve has crossed since the last
 * one. The residual is then exactly `1 - s` of what it started as, however
 * many frames that took, and `s = 1` spends all of it: the last frame of the
 * gather lands the body on its mark to the float.
 */
function gatherPull() {
  const st = versusState;
  if (st.gathered) return 1;
  const dur = Math.max(1e-3, cfg().kickoff?.gather ?? 0.5);
  const t = clamp01(st.gatherT / dur);
  const s = t * t * (3 - 2 * t);
  const prev = _gatherS;
  _gatherS = s;
  if (prev >= 1) return 1;
  return clamp01((s - prev) / (1 - prev));
}

/**
 * Hold both seals on their spots with a full wheel, and the ball at centre.
 * Every frame of the count — and, while a gather is running (enterKickoff),
 * EASE them onto those spots rather than writing them.
 */
function holdKickoff() {
  const w = gatherPull();
  const gathering = w < 1;
  for (const seal of matchSeals()) {
    const seat = seatOf(seal);
    const spot = _start[seat] ?? _start[0];
    const pos = seat === 0 ? player.mesh.position : sealPos(seal);
    if (gathering) {
      pos.x += (spot.x - pos.x) * w;
      pos.y += (spot.y - pos.y) * w;
      pos.z = 0;
    } else {
      pos.set(spot.x, spot.y, 0);
    }
    if (seat === 0) {
      if (strikeState.active) { cancelDash(); player.dashTimer = 0; }
      strikeState.charge = 1;
      strikeState.pending = 0;
    } else {
      if (seal.strike.active) { cancelDash(seal.strike); seal.dashTimer = 0; }
      seal.strike.charge = 1;
      seal.strike.pending = 0;
    }
    seal.velocity.set(0, 0);
    seal.knockX = seal.knockY = 0;
    // ...AND THE BLAST WINDOW. The goal that called this kickoff threw these
    // bodies (goalBlast), and the lifted speed ceiling that let them travel
    // (flingSeal) has no business still being open on a seal standing on its
    // mark — it would hand whoever is holding the pad several times their top
    // speed on the whistle.
    seal.flingT = 0;
    seal.flingMul = 1;
    // ...AND THE TUMBLE. The goal's blast leaves the loser ragdolling
    // (goalBlast), and the count needs every body on its mark with a full
    // wheel — a seal still turning from it would spin on the mark through
    // "3, 2, 1" and be facing the wrong way at the whistle.
    //
    // THE RATES AND THE RAGDOLL GO NOW; THE ANGLE IS EASED OUT. Those are two
    // different things and only one of them is a pose. `free`, `limp` and the
    // two velocities are the tumble still HAPPENING — control taken away from
    // a player on a body that is about to be stood on a mark — and a kickoff
    // takes them back on the frame it is called, which is what it always did.
    // `spin` and `roll` are where the tumble has GOT to, and zeroing those is
    // the somersault ending in a cut. Under a gather they come out over the
    // ease with everything else; without one, this is the snap it always was.
    const j = seal.jolt;
    if (j) {
      j.spinV = j.rollV = 0;
      j.free = 0;
      j.kick = j.kickX = j.kickY = j.kickAt = 0;
      if (gathering) {
        j.spin -= j.spin * w;
        j.roll -= j.roll * w;
      } else {
        j.spin = j.roll = 0;
      }
      // The skeleton comes back with the wheel. `free` going to zero would
      // hand it back on the next pose anyway, but the kickoff snaps the body
      // onto its spot THIS frame and a seal that arrived there limp would hold
      // the pose it was blown out of through the whole count.
      if (j.limp) { j.limp = false; seal.anim?.setLimp?.(null); }
    }
    // WHICH WAY IT POINTS. Settled outright once the gather is done (or when
    // there never was one) — see faceSeal, which writes the heading AND the
    // half roll that keeps the belly down, because writing one without the
    // other is a seal standing on its back through the count. Under a gather
    // the same two fields are eased, in step, so the turn and the roll finish
    // together.
    const face = kickoffFacing(spot);
    if (!gathering) {
      faceSeal(seal, face);
      continue;
    }
    if (!seal.mesh) continue;
    seal.mesh.rotation.z += shortArc(face - Math.PI / 2 - seal.mesh.rotation.z) * w;
    const to = _gatherTo[seat];
    if (to?.has && CONFIG.view === 'side') {
      seal.mirrorAngle += (to.mirror - seal.mirrorAngle) * w;
      // A GATHER THAT ROLLS THE BELLY *IS* A TURNAROUND, and says so. Halfway
      // through one the nose has crossed the vertical and the roll has not
      // caught up — which is what a turnaround looks like from the outside at
      // every speed, in play as much as here, and `mirrorT < 1` is the field
      // that already means "do not read this pose as settled". Left at 1 it
      // would advertise a seal mid-roll as a seal swimming on its back.
      //
      // The endpoints are the real ones so the claim is readable, and poseBody
      // steps this on the DILATED clock — a thousandth of the gather per frame
      // under the freeze — so the write below is what actually moves it. It
      // runs after poseBody (holdKickoff is the last hand on these bodies), so
      // there is no argument about which of the two wins.
      seal.mirrorFrom = to.from;
      seal.mirrorTo = to.mirror;
      seal.mirrorT = Math.abs(to.mirror - to.from) > 1e-6 ? Math.min(0.999, _gatherS) : 1;
    }
  }
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
  for (let who = 0; who < rosterSize(); who++) {
    const sx = (_start[who] ?? _start[0]).x;
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
// THE INSTANT REPLAY — the shot that scored, played back slow.
//
// A RECORDER runs under every frame of play: the ball (position, velocity,
// spin, the rim's dents) and both seals (position, heading, the body's
// composed transform, visibility) go into a ring buffer stamped with the
// match clock, `replay.buffer` seconds deep. Every seal-on-ball contact
// notes itself as the last touch (noteTouch). When a goal is called and the
// shutter's freeze has had its beat with the number up, the replay opens on
// the frame `lead` seconds before that touch and PLAYS THE BUFFER BACK: each
// frame the world is posed from it (poseReplay — the ball's fields and the
// seals' transforms written outright, after updatePlayer has run so nothing
// re-poses them), at `speed` x real time, while the water stays frozen.
//
// TWO SHOTS, FOUR BEATS (replayCameraGoal, and the cut in updateVersusCamera):
//   impact     a HARD CUT to a frame as tight as it goes on the ball and the
//              seal about to hit it, from `lead` before the touch until
//              `impactHold` after it — the collision, filling the screen.
//   wide       the frame opens out (a blend at the wide shot's own slower
//              rates, or a cut) to hold the mouth the ball is heading for,
//              the ball and the scorer, and follows the ball in.
//   explosion  the same wide frame. Neither the goal's jet nor the scorer's
//              pose was fired at the live goal when a replay was coming (see
//              goal()); the jet fires here, with the goal's own event and the
//              mouth changing hands. Held `explode` wall seconds.
//   celebration a CUT to the scorer, and the pose starts on that cut — not at
//              the explosion, where it spent most of its 1.7 seconds behind a
//              frame pointed at the mouth. Held `celebrateHold` wall seconds,
//              then the shutter resumes where it was parked (endReplay): the
//              number flies and the kickoff comes.
//
// The order lives in ONE place, advanceBeats, which a match and the replay lab
// both run. See tools/looks/replay-lab.js.
//
// HOLD ANY BUTTON TO SKIP — a key, a pointer or any button on any pad, held
// for `skipSeconds` (anyButtonHeld). A hold rather than a press: the
// shot was just thrown with a button, and press-to-skip would eat replays
// off the release of the very shot being replayed. See CONFIG.versus.replay.
// ---------------------------------------------------------------------------

export const replayState = {
  active: false,
  then: null,          // the phase to resume: 'scored' | 'won'
  resumeT: 0,          // ...and its clock, where it was parked
  t: 0,                // the recorded time being shown
  startT: 0,
  touchT: 0,
  goalT: 0,
  side: -1,            // which mouth the ball went into
  who: -1,             // the striker
  // WHAT KIND OF MOMENT this is — 'goal' for the instant replay and for a
  // reel's goal clip, 'save' or 'check' for the other two the highlight reel
  // plays (systems/versusReel.js). It decides the beats below and, through
  // them, which shots in the camera pool are eligible.
  kind: 'goal',
  clip: null,          // the reel clip being played, or null for a live replay
  goal: null,          // THIS replay's goal, not versusState's — see openSpan
  pivotT: 0,           // the recorded second the beats turn on: the touch, the save, the check
  endT: 0,             // ...and the last recorded second there is footage for
  impactX: 0, impactY: 0, // where the moment happened, for the `impact` target
  // The two beats played on the RECORDED clock, either side of `pivotT`...
  timeline: ['impact', 'wide'],
  // ...and the beats held on the WALL clock after the footage runs out, in
  // order, as [name, seconds]. A goal has two (the explosion and the
  // celebration); a save and a check have one short hold on their last frame.
  holds: [],
  beat: 'impact',      // 'impact' | 'wide' | 'explosion' | 'celebration' | 'save' | 'check'
  cutPending: false,   // the next camera frame is a CUT onto the goal frame, not a blend
  speed: 0.45,
  hold: 0,             // wall seconds into the explosion
  skipT: 0,            // wall seconds any button has been held
  skipArmed: false,    // ...and whether that hold counts yet — see updateReplay
  wall: 0,             // wall seconds of this replay so far
  forceHold: false,    // the harness's finger on a button
  frames: [],          // the buffer in time order, taken at startReplay
  // THE EVENT TRACK for this replay, and how far through it the clock is —
  // see the note above the recorder. Fired by playEvents as `t` passes them.
  events: [],
  eventAt: 0,
  // The striker's pose and the ball's recorded velocity this frame, for the camera.
  strikerX: 0, strikerY: 0,
  ballVx: 0, ballVy: 0,
  // THE POOL'S CONTEXT: the wall dt of the frame (updateReplay has it, the
  // posing in updateVersus does not), the canvas aspect (updateVersusCamera
  // reads it off the world's frustum), the points of interest posed this
  // frame, and whether the lens is currently ours to give back.
  wallDt: 0,
  aspect: 16 / 9,
  pois: null,
  lensForced: false,
};

// The ring. Frames are reused objects, so recording allocates nothing after
// the first `buffer` seconds. 720 frames is `buffer` 8s at 90fps.
const REC_CAP = 720;
const rec = { frames: [], head: 0, count: 0, events: [] };

// ---------------------------------------------------------------------------
// THE EVENT TRACK — every effect the match fired, with the second it fired on.
//
// The recorder above stores TRANSFORMS: where the ball and the two seals were,
// and what shape the ball's skin was in. That is enough to pose the shot and
// it is not enough to SHOW it, because none of what a player actually watches
// during a strike is a transform. The spray off the contact, the goo thrown
// out of the ball, the ripple through the lattice, the breach at the water
// line, the burst off a fish the shot went through — all of it fired live,
// once, seconds before the replay opens, and by the time the camera cut back
// to the moment there was nothing there. The replay was a silent diagram of a
// hit rather than the hit.
//
// So every positioned event is kept with its timestamp, and the replay fires
// them again as its own clock passes them (`playEvents`). They come back
// through feedback() with `replay: true`, which is the picture without the
// sound, the shake, the hit-stop or the rumble — see the note there.
//
// POSITIONED ONLY, and that is the filter that keeps the UI out of it. A
// countdown numeral, a menu click and an unlock toast are all feedback events
// with no place in the water; re-firing them a second later would put a
// three-two-one over the replay. An event that says WHERE it happened is one
// that happened in the arena.
// ---------------------------------------------------------------------------

const EVENT_CAP = 512;
let recording = null;

/** Start keeping the event track. Idempotent; dropped by stopRecordingEvents. */
function startRecordingEvents() {
  if (recording) return;
  rec.events.length = 0;
  recording = onFeedback((name, at) => {
    // Not a playback, and not a frame of one: the replay fires the track back
    // through feedback() and the listeners see it like anything else, so the
    // flag is what stops the track recording itself.
    if (at?.replay || !versusState.active || replayState.active) return;
    // No position, no place in the water — see the note above.
    if (at?.x == null || at?.y == null) return;
    // A shallow copy: the callers reuse their `at` objects between firings
    // (ballImpactFx has one, so does the strike), so keeping the reference
    // would leave the whole track pointing at whatever the last event was.
    rec.events.push({ t: versusState.clock, name, at: { ...at } });
    if (rec.events.length > EVENT_CAP) rec.events.splice(0, rec.events.length - EVENT_CAP);
  });
}

function stopRecordingEvents() {
  recording?.();
  recording = null;
  rec.events.length = 0;
}

function makeFrame() {
  const spin = new Float32Array(SPIN_REC);
  spin[0] = -1;
  return {
    t: 0, bx: 0, by: 0, bvx: 0, bvy: 0, bang: 0, bspin: 0, rim: new Float32Array(64),
    // THE BALL'S LOOK AND ITS SPIN STROKES, as the two modules record them —
    // see recordBallLook and recordBallSpin. Both carry an "unrecorded" mark
    // (look[0] of 0, spin[0] of -1) so a frame a lab filled by hand, which
    // never wrote either, poses neither and the live machines stand in.
    look: new Float32Array(LOOK_REC),
    spin,
    // ONE PER SEAT, at the roster's ceiling rather than at the roster — a
    // frame recorded before the roster grew would otherwise be short two
    // bodies and the replay would pose them at the origin.
    seals: Array.from({ length: MAX_PER_SIDE * 2 }, () => (
      { x: 0, y: 0, rz: 0, q: new THREE.Quaternion(), vis: true }
    )),
  };
}

function resetRecorder() {
  rec.head = 0;
  rec.count = 0;
  rec.events.length = 0;
}

function recordFrame() {
  if (rec.frames.length < REC_CAP) rec.frames.push(makeFrame());
  const f = rec.frames[rec.head];
  rec.head = (rec.head + 1) % REC_CAP;
  if (rec.count < REC_CAP) rec.count++;
  f.t = versusState.clock;
  f.bx = ball.x; f.by = ball.y; f.bvx = ball.vx; f.bvy = ball.vy;
  f.bang = ball.angle; f.bspin = ball.spin;
  const n = Math.min(ball.rim.length, f.rim.length);
  for (let i = 0; i < n; i++) f.rim[i] = ball.rim[i];
  // What the ball LOOKED like this frame, not only where it was: whose colour
  // it carried and how far round, and the strokes its spin had drawn. Without
  // these the replay showed the goal's final state — a ball already wholly
  // the scorer's, its strokes frozen mid-fade — over a shot in which neither
  // was true yet.
  recordBallLook(f.look);
  recordBallSpin(f.spin);
  for (let i = 0; i < f.seals.length; i++) {
    const b = sealAt(i);
    const o = f.seals[i];
    if (!b?.mesh) { o.vis = false; continue; }
    o.x = b.mesh.position.x; o.y = b.mesh.position.y;
    o.rz = b.mesh.rotation.z;
    if (b.body) o.q.copy(b.body.quaternion);
    o.vis = b.mesh.visible !== false;
  }
  // Older than `buffer` seconds is dropped from the front, so the ring holds
  // that many seconds and no more whatever the frame rate.
  const keep = cfg().replay?.buffer ?? 8;
  while (rec.count > 2 && versusState.clock - recordedFrom() > keep) rec.count--;
  // The event track ages out on the same clock as the frames it belongs to.
  const cutoff = versusState.clock - keep;
  let drop = 0;
  while (drop < rec.events.length && rec.events[drop].t < cutoff) drop++;
  if (drop) rec.events.splice(0, drop);
}

/** The oldest recorded time, or Infinity with nothing recorded. */
function recordedFrom() {
  if (!rec.count) return Infinity;
  return rec.frames[((rec.head - rec.count) % REC_CAP + REC_CAP) % REC_CAP].t;
}

/**
 * A DEEP COPY of one recorded frame. The ring reuses its frame objects, so a
 * clip that kept references would be overwritten by the next eight seconds of
 * play and play back as whatever happened after it — the archive's whole
 * problem in one sentence. See systems/versusReel.js.
 */
function copyFrame(f) {
  return {
    t: f.t, bx: f.bx, by: f.by, bvx: f.bvx, bvy: f.bvy, bang: f.bang, bspin: f.bspin,
    rim: Float32Array.from(f.rim),
    look: f.look ? Float32Array.from(f.look) : undefined,
    spin: f.spin ? Float32Array.from(f.spin) : undefined,
    seals: f.seals.map((o) => ({ x: o.x, y: o.y, rz: o.rz, q: o.q.clone(), vis: o.vis })),
  };
}

/**
 * Everything the recorder holds between two match times, copied out — the
 * frames in time order and the effects that fired over them. What the
 * highlight archive is handed; see harvestClips.
 */
function snapshotSpan(fromT, toT) {
  const frames = [];
  const first = ((rec.head - rec.count) % REC_CAP + REC_CAP) % REC_CAP;
  for (let i = 0; i < rec.count; i++) {
    const f = rec.frames[(first + i) % REC_CAP];
    if (f.t >= fromT && f.t <= toT) frames.push(copyFrame(f));
  }
  const events = rec.events
    .filter((e) => e.t >= fromT && e.t < toT)
    .map((e) => ({ t: e.t, name: e.name, at: { ...e.at } }));
  return { frames, events };
}

// ---------------------------------------------------------------------------
// WHAT GOES IN THE REEL — the three moments versus.js files with the archive.
//
// A goal files itself as the ball crosses (noteGoalClip, from goal()). The
// other two are noticed rather than announced: a SAVE has no event of its own
// anywhere in the physics, and a BODY CHECK has one but fires far more often
// than a highlight should. Both are read off state the match already keeps.
// ---------------------------------------------------------------------------

/**
 * THE SAVE WATCH. There is no such thing as a save in the ball's code — a
 * seal touches the ball and the ball changes direction, which is the same
 * event whether it was heading for the mouth or for open water. So a save is
 * read off the ball's TRAJECTORY: while a live ball is inside `zone` of a
 * mouth, travelling into it above `speed`, and would cross the line inside
 * the mouth (`aim` of its half-height), the ball is ON TARGET and this holds
 * the danger open. The danger ends one of three ways — the ball goes in (a
 * goal, and goal() clears the watch), it drifts off target on its own, or a
 * seal of the DEFENDING side touched it, which is the save.
 *
 * The peak speed while the danger was open is what the clip is ranked by: a
 * tap pushed goalward by a bounce and a full-power strike are both saves and
 * only one of them is worth thirty seconds of anybody's attention.
 */
const saveWatch = { side: 0, t0: 0, peak: 0 };

function clearSaveWatch() { saveWatch.side = 0; saveWatch.t0 = 0; saveWatch.peak = 0; }

/**
 * Which mouth the ball is on target for right now, and how fast — or null.
 * `out` is filled rather than allocated: this runs every frame of play.
 */
const _onTarget = { side: 0, speed: 0 };
function ballOnTarget() {
  const r = cfg().reel?.save ?? {};
  if (!ball.live) return null;
  const minSpeed = r.speed ?? 20;
  const side = ball.vx < -minSpeed ? -1 : (ball.vx > minSpeed ? 1 : 0);
  if (!side) return null;
  const face = rockX(side);
  // Inside the danger zone of THAT mouth, and still on the water side of it.
  if (Math.abs(ball.x - face) > (r.zone ?? 34)) return null;
  const line = goalLineX(side);
  const dx = line - ball.x;
  if (Math.sign(dx) !== side) return null;
  // Where it would cross, if nothing touched it. A ball with no horizontal
  // speed cannot get here — `side` is zero above.
  const ty = ball.y + ball.vy * (dx / ball.vx);
  if (Math.abs(ty - mouthY()) > mouthHalfHeight() * (r.aim ?? 1.15)) return null;
  _onTarget.side = side;
  _onTarget.speed = Math.hypot(ball.vx, ball.vy);
  return _onTarget;
}

function updateSaveWatch() {
  const st = versusState;
  const r = cfg().reel?.save ?? {};
  if (st.phase !== 'play' || !ball.live) { clearSaveWatch(); return; }
  const on = ballOnTarget();
  if (on) {
    if (saveWatch.side !== on.side) { saveWatch.side = on.side; saveWatch.t0 = st.clock; saveWatch.peak = 0; }
    saveWatch.peak = Math.max(saveWatch.peak, on.speed);
    return;
  }
  const side = saveWatch.side;
  if (!side) return;
  const t0 = saveWatch.t0;
  const peak = saveWatch.peak;
  clearSaveWatch();
  // WHO ENDED IT. The touch has to be recent enough to be the reason the
  // danger is over — `grace` covers the frame or two between the contact
  // resolving and the ball's heading actually turning — and it has to be a
  // seal of the side that owns this mouth. An attacker's own second touch
  // taking the shot off target is a miss, not a save.
  const touch = st.lastTouch;
  if (!touch || touch.t < t0 - (r.grace ?? 0.35)) return;
  const defending = side < 0 ? 0 : 1;
  if (teamOfSeat(touch.who) !== defending) return;
  const at = touch.t;
  const strength = clamp01(peak / Math.max(1, r.speedRef ?? 52));
  // THE SOUND OF IT, on top of whatever touch cleared the ball — a block, a
  // strike, a nudge. A layer, not a replacement: see the Blubberball block in
  // CONFIG.feedback. Fired at the TOUCH rather than at the ball, which by now
  // is a frame or two down the pitch.
  versusState.lastSave = { who: touch.who, side, peak, t: at, x: touch.x, y: touch.y };
  noteTallySave(touch.who);
  feedback('versusSave', { x: touch.x, y: touch.y, scale: 0.6 + strength, team: touch.who });
  requestClip('save', {
    at,
    fromT: at - (r.lead ?? 1.2),
    toT: at + (r.tail ?? 1.3),
    who: touch.who,
    side,
    x: touch.x, y: touch.y,
    strength,
  });
}

/** The goal just called, filed with the archive. See goal(). */
function noteGoalClip(goal) {
  const r = cfg().reel?.goal ?? {};
  const touch = versusState.lastTouch;
  if (!touch) return;
  requestClip('goal', {
    at: touch.t,
    fromT: touch.t - (r.lead ?? 1.1),
    toT: goal.t,
    who: touch.who,
    side: goal.side === 'left' ? -1 : 1,
    x: goal.x, y: goal.y,
    goal,
    // Every goal is worth showing; what separates them is how far the shot
    // that scored travelled, which is the one thing on the clip that says
    // "screamer" rather than "tap-in" without watching it.
    strength: clamp01(Math.hypot(goal.x - touch.x, goal.y - touch.y) / Math.max(1, (bounds.right - bounds.left) * 0.5)),
  });
}

/** A shove big enough to be a highlight, filed with the archive. */
function noteCheckClip(push, winner, loser, x, y) {
  const r = cfg().reel?.check ?? {};
  if (versusState.phase !== 'play') return;
  if (push < (r.push ?? 34)) return;
  const at = versusState.clock;
  const clip = requestClip('check', {
    at,
    fromT: at - (r.lead ?? 0.9),
    toT: at + (r.tail ?? 1.1),
    who: winner,
    // The way the shove points, so the pool's yaw ("toward the goal the ball
    // is heading for") turns the camera the way the bodies are going.
    side: x < (bounds.left + bounds.right) * 0.5 ? -1 : 1,
    x, y,
    strength: clamp01(push / Math.max(1, r.pushRef ?? 70)),
  });
  // The seal it landed on: the `defender` target, and the flat camera's
  // second body. gatherPois has no other way to know which of eight it was.
  if (clip) clip.victim = loser;
}

/**
 * A SEAL TOUCHED THE BALL — for the replay, and for the ledger the goal card
 * is read off.
 *
 * `v0x, v0y` is the velocity the ball was carrying INTO the touch, taken
 * before the contact was resolved; the velocity it leaves with is read off
 * the ball here, so every touch records what it did to the ball rather than
 * only where it happened. That difference is the whole of creditGoal below:
 * a graze and a strike are the same entry until you know how much either one
 * moved the ball.
 */
function noteTouch(who, kind, v0x = ball.vx, v0y = ball.vy) {
  // Every seat — a teammate's pass is the touch an assist is read off.
  if (!(who >= 0)) return;
  const touch = {
    t: versusState.clock, who, kind, x: ball.x, y: ball.y,
    vx0: v0x, vy0: v0y, vx1: ball.vx, vy1: ball.vy,
  };
  versusState.lastTouch = touch;
  // The history the assist is read off: a run of touches by one seal is one
  // touch (a dribble is not six assists to itself). Collapsed, the entry keeps
  // the velocity the FIRST of those touches inherited and the velocity the
  // LAST one left — a dribble's net effect on the ball, which is what a run of
  // touches by one seal did.
  const hist = versusState.touches;
  const prev = hist.length ? hist[hist.length - 1] : null;
  if (prev && prev.who === who) {
    touch.vx0 = prev.vx0;
    touch.vy0 = prev.vy0;
    hist[hist.length - 1] = touch;
  } else { hist.push(touch); if (hist.length > 12) hist.shift(); }
}

/**
 * EVERY SEAL IN THE MATCH, AS A BODY — where its spine is and which way it
 * points, for anything that has to get out of an animal's way. Player 1 is IN
 * this one, which is the difference between it and versusSeals below: the
 * grid's wake is drawn under a seal and player 1 has its own; a lump of goo
 * arriving at the pitch does not care whose frame it is.
 *
 * The heading is the mesh's, so the body is the capsule down the animal rather
 * than a circle around its middle — see sealSpine in systems/ballShape.js,
 * which is the shape the ball already collides with.
 *
 * Read-only and allocation-free, exactly like versusSeals: the array and its
 * entries are reused and a caller has to spend them before the next frame.
 */
const _capsules = [];
export function matchBodies() {
  _capsules.length = 0;
  if (!versusState.active) return _capsules;
  for (const seal of matchSeals()) {
    const seat = seatOf(seal);
    if (seat >= 0 && versusState.dead[seat]) continue;
    const p = sealPos(seal);
    _capsules.push({ x: p.x, y: p.y, heading: sealHeading(seal), who: seat });
  }
  return _capsules;
}

/**
 * EVERY SEAL IN THE MATCH THAT IS NOT PLAYER 1 — the bodies in the water, for
 * anything that treats a player as a thing displacing the ocean rather than as
 * an input. The grid's wake is the first caller (systems/grid.js): player 1 is
 * the seal the frame belongs to and holds slot 0, and these are the rest.
 *
 * A LIST rather than a p2 accessor, because "the rest" is the part that grows.
 * A third and fourth seal on the pitch is a change to what this returns and to
 * nothing that reads it.
 *
 * Read-only and allocation-free: the array and its entries are reused, so a
 * caller has to spend them before the next frame.
 */
const _bodies = [];
export function versusSeals() {
  _bodies.length = 0;
  if (!versusState.active) return _bodies;
  // Dead seals are out of the water until they respawn — a body left in the
  // list would hold its dent open at the spot it burst.
  for (const seal of matchSeals()) {
    const seat = seatOf(seal);
    if (seat <= 0 || versusState.dead[seat]) continue;
    _bodies.push({ x: sealPos(seal).x, y: sealPos(seal).y, who: seat });
  }
  return _bodies;
}

/** Which team seal `who` plays for: its own side, in a two-seal match. */
// A seat's side. It WAS the seat's own number, which is true of exactly the
// first two seats — see teamOfSeat in systems/sealRoster.js.
function teamOf(who) { return teamOfSeat(who); }

/**
 * WHICH WAY IS INTO THE GOAL TEAM `t` IS SHOOTING AT, as a sign on x. Team 0
 * defends the left mouth (spawnPoint), so team 1 scores by sending the ball
 * left. The pitch's goals are mouths in the side walls, so the x component IS
 * the goalward one: a ball crosses the line on x and misses on y.
 */
function goalwardX(t) { return t === 1 ? -1 : 1; }

/**
 * HOW MUCH GOALWARD SPEED A TOUCH PUT ON THE BALL, in u/s — the velocity the
 * ball left with, less the velocity it arrived with, along the line into the
 * goal. This is the number the card is read off, and it is a DIFFERENCE on
 * purpose: it is the one measure that separates a seal that sent the ball at
 * the net from a seal the ball happened to brush on its way there. A graze
 * scores a couple of u/s; a strike scores thirty.
 */
function goalwardGain(touch, dirX) {
  if (!touch || !(typeof touch.vx1 === 'number')) return 0;
  return dirX * ((touch.vx1 ?? 0) - (touch.vx0 ?? 0));
}

/**
 * WHO THE GOAL CARD NAMES — read off the touch ledger when the goal is called.
 *
 * THE SCORER IS THE SEAL THAT MOVED THE BALL GOALWARD THE HARDEST, not the
 * last seal to touch it. Those are the same seal on almost every goal, and
 * the times they differ are exactly the times "last touch" gets it wrong: a
 * shot that clips a defender on its way in was struck by the attacker and
 * touched last by the defender, and the defender did not score it. Every
 * touch inside `creditWindow` is scored by goalwardGain above and the biggest
 * claim on the credited side takes it.
 *
 * AN OWN GOAL IS A DIRECTION, NOT A TEAM. It is not "the last seal to touch it
 * plays for the other side" — under that rule every deflection off a defender
 * is an own goal, and a defender who gets a fin to a shot and slows it is
 * booked for the goal they nearly stopped. It is the defender having KNOCKED
 * THE BALL BACKWARDS into their own net: the ball was not on its way in before
 * the touch (`wasLeaving`, so a ball already flying at the mouth can only be
 * grazed, never conceded) and it is travelling in properly after (`minSpeed`).
 * Both, and only on the LAST touch — a defender's mistake that an attacker
 * then hits is the attacker's goal.
 *
 * The assist is the last earlier touch by a DIFFERENT seal of the scorer's
 * team inside `assistWindow` seconds — which a one-a-side match can never
 * have, and a team match will.
 */
export function creditGoal(scorerTeam, now = versusState.clock) {
  const hist = versusState.touches;
  const c = cfg().card ?? {};
  const window = c.assistWindow ?? 6;
  const dirX = goalwardX(scorerTeam);
  const credit = { team: scorerTeam, who: scorerTeam, ownGoal: false, assist: -1, gain: 0, t: now };
  const last = hist.length ? hist[hist.length - 1] : null;

  // THE OWN GOAL TEST, first, because it is the one case where the ball's own
  // side is not the side that scored and nothing else in here applies.
  const og = c.ownGoal ?? {};
  if (last && teamOf(last.who) !== scorerTeam) {
    const before = dirX * (last.vx0 ?? 0);
    const after = dirX * (last.vx1 ?? 0);
    if (before <= (og.wasLeaving ?? 2) && after >= (og.minSpeed ?? 6)) {
      credit.who = last.who;
      credit.ownGoal = true;
      credit.gain = goalwardGain(last, dirX);
      return nameCredit(credit, now);
    }
  }

  // THE BIGGEST CLAIM ON THE CREDITED SIDE, inside the window.
  const since = now - (c.creditWindow ?? window);
  let best = -1;
  let bestGain = -Infinity;
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i];
    if (h.t < since) break;
    if (teamOf(h.who) !== scorerTeam) continue;
    const g = goalwardGain(h, dirX);
    // Ties go to the later touch: `>` with the loop running backwards.
    if (g > bestGain) { bestGain = g; best = i; }
  }
  // Nobody on this side touched it inside the window — a goal off a wall long
  // after the last contact, or a deflection nobody may be blamed for. The card
  // still names the seal whose touch is nearest to it rather than going blank.
  if (best < 0) {
    for (let i = hist.length - 1; i >= 0; i--) if (teamOf(hist[i].who) === scorerTeam) { best = i; bestGain = goalwardGain(hist[i], dirX); break; }
  }
  if (best >= 0) {
    credit.who = hist[best].who;
    credit.gain = bestGain;
    for (let i = best - 1; i >= 0; i--) {
      const h = hist[i];
      if (now - h.t > window) break;
      if (h.who !== credit.who && teamOf(h.who) === scorerTeam) { credit.assist = h.who; break; }
    }
  } else if (last) {
    credit.who = last.who;
  }
  return nameCredit(credit, now);
}

/** The names and the clock on a finished credit. */
function nameCredit(credit, now) {
  credit.name = versusState.names[credit.who] ?? '';
  credit.assistName = credit.assist >= 0 ? (versusState.names[credit.assist] ?? '') : '';
  credit.time = formatClock(now);
  return credit;
}

/** m:ss of the match clock. */
export function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Is there a replay to show for the goal just called? */
function replayWanted(won) {
  const r = cfg().replay ?? {};
  if (r.enabled === false) return false;
  if (r.onlyWinner && !won) return false;
  const touch = versusState.lastTouch;
  if (!touch) return false;
  // A touch older than the buffer has no frames to play; one too recent to
  // have its full lead is fine (the replay opens on the oldest frame it has).
  return touch.t >= recordedFrom() && rec.count > 2;
}

/**
 * THE BEATS ONE KIND OF CLIP IS MADE OF — see the section note above, and
 * CONFIG.versus.reel for the two the highlight reel adds.
 *
 *   timeline  the two beats played on the RECORDED clock, before and after
 *             the moment itself. The first is always `impact`: a wind-up is
 *             a wind-up whether what follows is a shot, a save or a ram.
 *   holds     beats held on the WALL clock once the footage runs out, in
 *             order. A goal has the explosion and the celebration; nothing
 *             else has anything to blow up, so the clip sits on its last
 *             frame for `reel.hold` instead (advanceBeats' tail hold).
 */
function beatsFor(kind) {
  const r = cfg().replay ?? {};
  const reel = cfg().reel ?? {};
  if (kind === 'save') return { timeline: ['impact', 'save'], holds: [], cutInto: (reel.save?.cut ?? true) !== false };
  if (kind === 'check') return { timeline: ['impact', 'check'], holds: [], cutInto: (reel.check?.cut ?? true) !== false };
  return {
    timeline: ['impact', 'wide'],
    holds: [['explosion', r.explode ?? 1.3], ['celebration', r.celebrateHold ?? 1.7]],
    cutInto: !!r.wide?.cut,
  };
}

/**
 * OPEN A SPAN OF RECORDED FOOTAGE AND START PLAYING IT — the one place the
 * replay's state is built, and the reason a goal's instant replay, a
 * highlight off the reel and the lab's staged shot cannot drift apart.
 *
 * Three callers: startReplay (the ring, at a goal), openReelClip (a clip the
 * archive copied out of the ring, at the end of the match) and stageReplay
 * (frames a lab made up). What differs between them is the FOOTAGE and what
 * the moment was; everything downstream — the beats, the speed, the pool, the
 * posing — is the same code from here.
 *
 * `goal` is THIS span's goal rather than versusState.lastGoal. The reel plays
 * the second goal of the match half a minute after the fifth was scored, and
 * every beat that reads "the goal" off the match state would have blown out
 * the wrong mouth in the wrong colour.
 */
function openSpan({
  kind = 'goal', frames, events = [], fromT, toT, pivotT,
  who = 0, side = -1, goal = null, impactX = 0, impactY = 0, clip = null,
  speed = null, maxWall = null, tailHold = 0,
}) {
  const rs = replayState;
  const r = cfg().replay ?? {};
  if (!frames || frames.length < 2) return false;
  // ASSIGNED, never emptied in place: a reel clip owns its frames and lives
  // for the rest of the session, and endReplay used to truncate whatever
  // array it was handed — which emptied the archive one clip at a time.
  rs.frames = frames;
  rs.events = [...events].sort((a1, b1) => a1.t - b1.t);
  rs.eventAt = 0;
  rs.kind = kind;
  rs.clip = clip;
  rs.goal = goal;
  rs.who = who;
  rs.side = side;
  rs.impactX = impactX;
  rs.impactY = impactY;
  rs.startT = Math.max(frames[0].t, fromT);
  rs.t = rs.startT;
  rs.pivotT = pivotT;
  rs.endT = Math.min(frames[frames.length - 1].t, toT);
  // The two names the rest of the file still reads a goal replay by.
  rs.touchT = pivotT;
  rs.goalT = rs.endT;
  const beats = beatsFor(kind);
  rs.timeline = beats.timeline;
  rs.holds = beats.holds;
  rs.cutInto = beats.cutInto;
  rs.tailHold = tailHold;
  rs.beat = rs.timeline[0];
  // THE MOUTH IS NOT LIT YET. goal() flashed it the instant the ball crossed,
  // and that envelope has been running on the wall clock through the shutter's
  // freeze ever since — so the replay opened with the goal light already
  // blazing over footage from a second BEFORE the goal, and had run out by the
  // time the ball actually went in. It is put back to its own team's colour
  // here and flashed again at the explosion beat, which is where the replay
  // says the goal happens.
  clearGoalScored();
  // ...AND NOBODY IS CELEBRATING YET, for the same reason. goal() no longer
  // starts one when a replay is coming, but a kill or a level-up from the
  // seconds before the goal can still be running, and its clock is the wall
  // clock this replay is about to spend five seconds of. The pose belongs to
  // the celebration beat and to nothing earlier. (The reel needs this between
  // every pair of clips as well: a somersault left running from the last one
  // is a seal celebrating a body check.)
  resetCelebration();
  resetGoalJets();
  // ...AND THE AIR IS CLEAR. The replay rewinds the picture to `lead` seconds
  // before the touch, so anything still in flight is from a future the footage
  // has not reached: the goal's own burst, the spray off the shot being
  // replayed, a wall thump's flash. All of it hung there for the whole replay
  // as well, because the loose particles age on the dilated clock and the
  // shutter's freeze holds that at four percent — a 0.4s spray takes ten
  // seconds of wall time to die. Cleared once, here, and the event track
  // re-fires whatever belongs to the span being shown.
  clearLooseParticles();
  clearImpactFlashes();
  // Slow, but never so slow the whole thing outlasts `maxWall`.
  const span = Math.max(0.01, rs.endT - rs.startT);
  const want = speed ?? r.speed ?? 0.45;
  const cap = Math.max(0.5, maxWall ?? r.maxWall ?? 5);
  rs.speed = Math.min(1, Math.max(want, span / cap));
  rs.cutPending = kind === 'goal' ? (r.impact?.cut ?? true) !== false : true;
  rs.hold = 0;
  rs.skipT = 0;
  rs.skipArmed = false;
  rs.wall = 0;
  rs.active = true;
  poseReplay(rs.t);
  // The pool starts directing on the first posed frame.
  if ((cfg().replay?.cams?.enabled ?? true) !== false) { resetPool(rs.aspect); rs.wallDt = 1 / 60; updateReplayCams(); }
  else stopPool();
  return true;
}

// ---------------------------------------------------------------------------
// THE REPLAY'S DRAG ON THE SOUND — CONFIG.versus.replay.audio.
// ---------------------------------------------------------------------------
// The tape sags for the replay and is back at full speed before the kickoff.
// Why it is a named rate rather than a `follow` off the world's scale, and why
// `restore` is clamped, are on the config block; what is here is the two things
// that cannot live in config.
//
// TWO SCHEDULED MOVES, NOT A PER-FRAME CHASE. setMusicRateScale and
// setAmbientRateScale both schedule an exponential approach on the audio thread
// (setTargetAtTime, tau = the glide), so this is one call when the replay opens
// and one when it ends. Passed as a third of the wall seconds the move is meant
// to take, which is the conversion restMusic makes and lands ~95% of the way in
// that time. A rate re-issued every frame toward a moving target is a curve
// chasing a value, and it arrives late or not at all.
//
// THE ONE-SHOTS FOLLOW THE MUSIC'S OWN MOVE (musicRateScale), which is the only
// per-frame part: setSfxRateScale is a plain multiplier read when a sound
// starts, not an AudioParam, so writing it every frame costs nothing and there
// is no second copy of the curve to drift.
//
// A REEL CLIP MUST NOT TOUCH IT. The highlight reel plays under the rematch
// prompt with replayState.active true, which is why the hold is taken here — in
// startReplay, the instant replay's own door — rather than off that flag.

const soundDrag = {
  // The replay is holding the tape down. Cleared the moment it hands back.
  held: false,
  // ...and we are still WRITING a rate, which outlives `held` for the length of
  // the ramp home. Two flags because the release is a move and not an edit: a
  // reset landing mid-ramp has to snap the one-shots back itself, and a guard
  // on `held` alone would have already stopped looking.
  writing: false,
};

function replayAudioCfg() {
  return cfg().replay?.audio ?? {};
}

/** The replay is open: take the tape down. */
function dragSoundForReplay() {
  const a = replayAudioCfg();
  if (a.enabled === false) return;
  const rate = Math.max(0.05, Math.min(1, a.rate ?? 0.78));
  const tau = Math.max(0.01, (a.glide ?? 0.45) / 3);
  setMusicRateScale(rate, tau);
  setAmbientRateScale(rate, tau);
  soundDrag.held = true;
  soundDrag.writing = true;
}

/**
 * The replay has handed back: bring it home.
 *
 * @param snap  no ramp — the match is being torn down (a reset, the menu, a
 *              rematch). Whatever comes next sets its own rate on the frame
 *              after this one (startMusicAtRest's half speed, play()'s full
 *              speed), and a glide still in flight would land on top of it.
 */
function releaseSoundAfterReplay(snap = false) {
  if (!soundDrag.writing) return;
  soundDrag.held = false;
  if (snap) {
    soundDrag.writing = false;
    setMusicRateScale(1, 0);
    setAmbientRateScale(1, 0);
    setSfxRateScale(1);
    return;
  }
  const seconds = replayRestoreSeconds();
  const tau = seconds > 0 ? Math.max(0.01, seconds / 3) : 0;
  setMusicRateScale(1, tau);
  setAmbientRateScale(1, tau);
}

/**
 * HOW LONG THE RAMP HOME GETS — `restore`, clamped to the window the shutter
 * actually has.
 *
 * The shutter resumes where it was parked (endReplay) and calls the kickoff at
 * `clock.respawn`, so `respawn - freeze` is everything there is between the
 * replay handing back and the countdown's first numeral. Clamped rather than
 * trusted: a `restore` tuned past that window — or dragged past it on the
 * slider — would put the count over music still climbing, which is the one
 * thing this move exists to avoid.
 *
 * Exported because it is the assertion: the ramp itself is scheduled on the
 * audio thread and a harness with no audio context cannot time it.
 */
export function replayRestoreSeconds() {
  const a = replayAudioCfg();
  const k = cfg().clock ?? {};
  const window = Math.max(0.05, (k.respawn ?? 1.3) - (k.freeze ?? 0.35));
  return Math.min(Math.max(0, a.restore ?? 0.75), window);
}

/**
 * One frame of the one-shots following the tape. From updateVersusClock, on the
 * wall clock — the only clock there is under a replay.
 */
function followSoundDrag() {
  if (!soundDrag.writing) return;
  const a = replayAudioCfg();
  const follow = Math.max(0, Math.min(1, a.sfxFollow ?? 1));
  const scale = 1 + (musicRateScale() - 1) * follow;
  setSfxRateScale(scale);
  // Home, with nothing holding it down: stop writing. A module that went on
  // setting a rate of 1 every frame for the rest of the match would quietly
  // own a channel three other systems also write (a level, a death, a kill).
  if (!soundDrag.held && Math.abs(scale - 1) < 0.002) {
    soundDrag.writing = false;
    setSfxRateScale(1);
  }
}

function startReplay(then) {
  const st = versusState;
  const r = cfg().replay ?? {};
  const rs = replayState;
  const touch = st.lastTouch;
  st.replayPending = false;
  if (!touch || !st.lastGoal) return;
  // The buffer, in time order, ending on the goal's frame. REFERENCES, not
  // copies: an instant replay is over long before the ring rolls round, and
  // it is the archive (systems/versusReel.js) that needs its own copies.
  const frames = [];
  const first = ((rec.head - rec.count) % REC_CAP + REC_CAP) % REC_CAP;
  for (let i = 0; i < rec.count; i++) {
    const f = rec.frames[(first + i) % REC_CAP];
    if (f.t <= st.lastGoal.t) frames.push(f);
  }
  if (frames.length < 2) return;
  const fromT = Math.max(frames[0].t, touch.t - (r.lead ?? 0.9));
  // The effects that fired over the span being replayed, in time order.
  // Copied rather than referenced: the match goes on recording into
  // rec.events the moment the replay ends. UP TO the goal, not including it:
  // everything that fires ON the goal's own frame belongs to explodeReplay,
  // which stages that beat deliberately — the event at the mouth, the jet,
  // the mouth changing hands and the scorer's pose. Taking the goal's frame
  // into the track as well fired the same explosion twice, a frame apart.
  const events = rec.events.filter((e) => e.t >= fromT && e.t < st.lastGoal.t);
  const ok = openSpan({
    kind: 'goal', frames, events,
    fromT, toT: st.lastGoal.t, pivotT: touch.t,
    who: touch.who, side: st.lastGoal.side === 'left' ? -1 : 1,
    goal: st.lastGoal, impactX: touch.x, impactY: touch.y,
  });
  if (!ok) return;
  rs.then = then;
  rs.resumeT = st.phaseT;
  st.phase = 'replay';
  st.replays++;
  // ...AND THE TAPE SAGS WITH THE PICTURE. See the drag above; the ramp back
  // is endReplay's, whichever way this ends.
  dragSoundForReplay();
  // THE CARD STAYS UP OVER THE REPLAY. It used to be taken down here and put
  // back when the replay ended, which meant the one piece of the screen that
  // says WHO SCORED was missing for the whole of the shot that shows them
  // doing it. The replay is footage; the card is the caption on it.
  showReplayUi(true);
}

function updateReplay(rawDt, pads) {
  const rs = replayState;
  const r = cfg().replay ?? {};
  if (!rs.active) { endReplay(true); return; }
  rs.wall += rawDt;
  rs.wallDt = rawDt;
  // THE SKIP. A hold that lets go bleeds back rather than snapping to zero,
  // so a thumb that slipped for a frame does not start over.
  //
  // ARMED BY A RELEASE FIRST. The goal was scored by a button, and in a match
  // that button is usually still down when the replay opens a beat later — so
  // the hold was already most of the way through its own timer before the
  // player had seen a single frame, and the replay went past in a blink with
  // the prompt and its bar flashing up and away. Nothing counts until every
  // button, key and finger has been off once; from there the bar fills the way
  // the prompt says it does.
  const held = anyButtonHeld(pads);
  if (!rs.skipArmed && !held) rs.skipArmed = true;
  const skipHold = Math.max(0.05, r.skipSeconds ?? 1);
  rs.skipT = (held && rs.skipArmed) ? rs.skipT + rawDt : Math.max(0, rs.skipT - rawDt * 2);
  paintSkip(rs.skipT / skipHold);
  if (rs.skipT >= skipHold) { endReplay(true); return; }

  if (!advanceBeats(rawDt)) { endReplay(true); return; }
  // Player 2's celebration driver ticks in stepP2, which a replay does not
  // run; the wall clock is what a celebration wants anyway (main.js ticks
  // player 1's on rawDt).
  p2.celebrate?.update(rawDt);
}

/**
 * THE BEATS, IN ORDER, on one wall frame. The ONE copy of that order: a match
 * runs it from updateReplay, the highlight reel from updateReel, the lab from
 * stepStagedReplay, and there is nothing for the three to drift apart on.
 * Which beats a clip has is beatsFor(kind) — a goal's are:
 *
 *   impact → wide   on the RECORDED clock at `speed`, up to the goal's frame
 *   explosion       the goal's frame, held `explode` wall seconds — the jet,
 *                   the event at the mouth, the mouth changing hands
 *   celebration     held `celebrateHold` wall seconds — the scorer's pose,
 *                   started HERE and nowhere earlier
 *
 * The explosion and the celebration are two beats and not one because they
 * want two different frames: the bang belongs at the mouth and the pose
 * belongs on the seal, and a single beat can only be filmed one way. It is
 * also the only way to make the order true — a celebration fired at the
 * explosion is already ending by the time a camera could cut to it.
 *
 * A SAVE OR A CHECK has no held beats at all: nothing explodes and nobody
 * celebrates, so the second timeline beat plays out to the end of the footage
 * and the last frame is held `reel.hold` wall seconds.
 *
 * Returns false when the last beat has been held its time and the replay is
 * over. `fire` off stages the beats without their effects, for a diagram.
 */
function advanceBeats(rawDt, { fire = true } = {}) {
  const rs = replayState;
  const hi = rs.holds.findIndex((h) => h[0] === rs.beat);
  if (hi >= 0) {
    rs.hold += rawDt;
    if (rs.hold < rs.holds[hi][1]) return true;
    const next = rs.holds[hi + 1];
    if (!next) return false;
    // A CUT, not a blend. The pose is on the seal and the bang was at the
    // mouth; easing between them is a camera wandering off the climax.
    rs.beat = next[0];
    rs.hold = 0;
    rs.cutPending = true;
    if (fire) fireBeat(next[0]);
    return true;
  }
  rs.t += rawDt * rs.speed;
  if (rs.t >= rs.endT) {
    rs.t = rs.endT;
    const first = rs.holds[0];
    if (first) {
      rs.beat = first[0];
      rs.hold = 0;
      if (fire) fireBeat(first[0]);
      return true;
    }
    // NOTHING TO BLOW UP — a save or a body check. The clip sits on its last
    // frame for `reel.hold` wall seconds rather than cutting on the frame the
    // footage runs out, which reads as a dropped connection.
    rs.hold += rawDt;
    return rs.hold < rs.tailHold;
  }
  const beat = beatAt(rs.t);
  // Opening out: a cut if this kind of clip asks for one, else the blend at
  // its own rates (updateVersusCamera reads the beat).
  if (beat !== rs.beat && beat === rs.timeline[1] && rs.cutInto) rs.cutPending = true;
  rs.beat = beat;
  return true;
}

/**
 * THE LIGHT ON THE SCORER — the boss kill's hero shaft, lent to a goal.
 *
 * The same cone, the same pool, the same lift on the hide (systems/bossLight.js
 * — see fireHeroLight there for why it is borrowed rather than copied). What a
 * goal changes is the TIMING and the SUBJECT: it comes up AFTER the explosion
 * rather than racing ahead of a shutter, it stands on whichever seal scored,
 * and it is gone by the time the celebration is.
 *
 * THE HOLD IS DERIVED, not typed. The point of the light is to be on the seal
 * for the performance and off it by the end, and the performance's length is
 * celebrationState.duration — a hand-typed hold would be right on the day it
 * was written and wrong the next time a pose was retuned. Where the
 * celebration is shorter than the delay and the two ramps, the hold simply
 * goes to zero and the light is a brief flare, which is right rather than
 * broken.
 */
export function spotlightScorer(scorer) {
  const c = cfg().goal?.spotlight ?? {};
  if (c.enabled === false) return false;
  let delay = Math.max(0, c.delay ?? 0.35);
  let rise = Math.max(0.01, c.rise ?? 0.7);
  let fall = Math.max(0.01, c.fall ?? 1.1);
  // What is left of the celebration from THIS frame — it was started by
  // celebrateGoal a moment ago, so a little of it has already run.
  const left = Math.max(0, (celebrationState.duration ?? 0) - (celebrationState.clock ?? 0));
  let hold = 0;
  if (left > 0) {
    // SCALED, NOT CLAMPED. At the shipped tuning the three ramps come to 2.15
    // seconds against a celebration of 1.70, so there is no hold to shorten —
    // and clamping the hold at zero leaves a light that is still fading half a
    // second after the seal has gone back to swimming, which is the one thing
    // "off by the time the celebration is" was supposed to prevent. Squeezing
    // all three in proportion keeps the SHAPE of the beat (a wait, a rise, a
    // long fade) at whatever length the performance turns out to be, which is
    // the same argument the boss entrance's staggered voices make.
    const ramps = delay + rise + fall;
    if (ramps > left) {
      const k = left / ramps;
      delay *= k; rise *= k; fall *= k;
    } else {
      hold = left - ramps;
    }
  }
  return fireHeroLight({
    delay,
    rise,
    hold,
    fall,
    breathe: c.breathe ?? 0.16,
    wander: c.wander ?? 1.4,
    wanderSpeed: c.wanderSpeed ?? 0.5,
    lift: c.lift ?? 1,
    // A GETTER, not a body: the seal is swimming, and player 2's visual is a
    // different object after a body swap. Resolved every frame in bossLight.
    follow: () => (scorer === 1
      ? { pos: p2.mesh?.position ?? null, root: p2.body ?? null }
      : { pos: player.mesh?.position ?? null, root: player.body ?? null }),
  });
}

/** The effects a held beat stages. The only two beats that stage any. */
function fireBeat(name) {
  if (name === 'explosion') explodeReplay();
  else if (name === 'celebration') celebrateReplay();
}

/** The explosion beat: the jet and the goal's own event, at the mouth, now. */
function explodeReplay() {
  const rs = replayState;
  // THIS SPAN'S goal, not the match's last — the reel replays the second goal
  // of the match a minute after the fifth was scored, and reading the match
  // state here blew out the wrong mouth in the wrong colour.
  const g = rs.goal;
  if (!g) return;
  const mouthX = rs.side < 0 ? bounds.left : bounds.right;
  const out = -rs.side;
  // The same payload goal() fires, the ball's live colour on it — see the
  // note there and on CONFIG.feedback.versusGoal.
  // The scorer's colour, as the live goal fires it — and the ball fills with
  // it here too, so the replay's own climax matches the one it is replaying.
  claimBall(g.scorer, Math.atan2(0, out));
  const at = { x: mouthX, y: g.y, dirX: out, dirY: 0, vx: out * 20, vy: 0, scale: 1, color: teamColor(g.scorer) };
  feedback('versusGoal', at);
  // THE MOUTH CHANGES HANDS, again and on this clock. startReplay put the
  // light back to its own team's colour so the rewound footage was honest;
  // this is the frame the replay says the ball went in, so this is where it
  // blazes. Without it the replay's climax was the one moment in the whole
  // sequence with no goal light at all.
  flashGoalScored(rs.side, g.scorer);
  fireGoalJet(rs.side, g.y, g.scorer);
  spotlightScorer(g.scorer ?? rs.who);
  // THE CROWD, AND THE BALL'S OWN KICK — the two halves of the climax that were
  // only ever fired at the live goal. They played over the shutter's freeze and
  // had decayed to nothing by the time the replay rewound to a second before
  // the shot, so the frame the replay calls the goal had no cheer on it and a
  // ball with no warp in it. Everything else here is already fired twice, once
  // for the freeze and once for the replay; these two were simply missed.
  feedback('versusGoalCheer', at);
  ballEvent('goal');
}

/**
 * The celebration beat: the scorer's victory pose, started HERE — a beat after
 * the bang, on the frame the camera cuts to the seal.
 *
 * It used to fire from explodeReplay, which put it a whole `explode` too early:
 * the pose runs 1.7 seconds and the explosion holds 1.3 of them, so by the time
 * anything framed the scorer it was easing back into the swim cycle. Worse, the
 * live goal fired one as well (see goal()), so what the replay's lead-up
 * actually showed was a seal celebrating a goal it had not scored yet.
 */
function celebrateReplay() {
  const g = replayState.goal;
  if (!g) return;
  if ((cfg().replay?.celebrate ?? true) === false) return;
  celebrateGoal(g.scorer);
}

/** Close the replay and hand the shutter back where it was parked. */
function endReplay(resume) {
  const rs = replayState;
  const was = rs.active;
  rs.active = false;
  // A NEW ARRAY, never a truncation. A reel clip HANDS IN its own frames and
  // keeps them for the rest of the session; emptying the array in place threw
  // the archive away one clip at a time, and the reel went blank after a lap.
  rs.frames = [];
  rs.clip = null;
  rs.skipT = 0;
  showReplayUi(false);
  stopPool();
  releaseReplayLens();
  if (!was) return;
  // THE TAPE COMES BACK UP whichever way the replay ended — run out, skipped,
  // or dropped by a reset — and only the first of those has anywhere to ramp
  // into. See releaseSoundAfterReplay.
  releaseSoundAfterReplay(!resume);
  if (!resume) return;
  const st = versusState;
  st.phase = rs.then ?? 'scored';
  st.phaseT = rs.resumeT;
  // The card was never taken down (it played over the replay), so this is a
  // REPAINT and not an entrance: `pop` false, or the thing that has been
  // sitting there for five seconds would spring in again as the replay ends.
  showCard(st.scorer, st.phase === 'won', false);
}

// ---------------------------------------------------------------------------
// THE HIGHLIGHT REEL — the archive, played back under the rematch prompt.
//
// systems/versusReel.js keeps the clips; this plays them. A clip is a span of
// copied footage and openSpan already knows how to open one, so the reel is
// barely more than "open the next one when the last one ends, and wrap".
//
// IT IS A REPLAY as far as the rest of the game is concerned: replayState is
// active, so main.js holds the player's input, drives the effect systems on
// the replay's own rate and renders through the camera pool — the same three
// things that make an instant replay look like footage rather than like the
// game with the seals teleporting. What it is NOT is a phase: the match stays
// in `over` underneath, because the prompt over the top is the point and a
// prompt nobody can answer is not a prompt.
// ---------------------------------------------------------------------------

/** Open the reel's next clip. False when there is nothing to play. */
function openReelClip() {
  const reel = cfg().reel ?? {};
  const clip = nextClip();
  if (!clip) { reelState.playing = false; return false; }
  const goalSpeed = clip.kind === 'goal';
  const ok = openSpan({
    kind: clip.kind,
    frames: clip.frames,
    events: clip.events,
    fromT: clip.fromT,
    toT: clip.toT,
    pivotT: clip.at,
    who: clip.who,
    side: clip.side,
    goal: clip.goal,
    impactX: clip.x,
    impactY: clip.y,
    clip,
    // A goal keeps the instant replay's own rate — it is the same footage the
    // same shot would have been shown at. A save and a check get the reel's,
    // which is a touch quicker: they have no explosion to build to and a reel
    // that dwells is a reel nobody watches twice.
    speed: goalSpeed ? null : (reel.speed ?? 0.55),
    maxWall: goalSpeed ? null : (reel.maxWall ?? 4.5),
    tailHold: reel.hold ?? 0.5,
  });
  if (!ok) { reelState.playing = false; return false; }
  showReelUi(clip);
  return true;
}

/**
 * Start the reel. Returns false when the match left nothing worth showing —
 * a match ended on the first kickoff, or a `reel.enabled` of false — and the
 * end of the match stays as it was, frozen water under the prompt.
 */
export function startReel() {
  if ((cfg().reel?.enabled ?? true) === false) return false;
  const order = buildPlaylist();
  if (!order.length) return false;
  reelState.playing = true;
  if (!openReelClip()) { showReelUi(null); return false; }
  return true;
}

/** One wall frame of the reel. */
function updateReel(rawDt) {
  const rs = replayState;
  if (!reelState.playing) return;
  if (!rs.active && !openReelClip()) { showReelUi(null); return; }
  rs.wall += rawDt;
  rs.wallDt = rawDt;
  if (!advanceBeats(rawDt)) {
    // ...AND STRAIGHT INTO THE NEXT ONE. endReplay(false) rather than a plain
    // deactivate: it stops the pool and hands the lens back, so the clip that
    // follows opens with the director choosing afresh rather than blending
    // out of an angle on footage that is gone.
    endReplay(false);
    if (!openReelClip()) showReelUi(null);
    return;
  }
  // Player 2's celebration driver ticks in stepP2, which a replay does not
  // run; the wall clock is what a celebration wants anyway.
  p2.celebrate?.update(rawDt);
}

/** Stop the reel and give the world back: a rematch, the menu, a reset. */
export function stopReel() {
  reelState.playing = false;
  showReelUi(null);
  endReplay(false);
}

// Interpolation scratch.
const _qa = new THREE.Quaternion();
const _spinQ = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);

/** Pose the ball and both seals from the buffer at recorded time `t`. */
/**
 * Fire every recorded effect the replay's clock has now reached. `at.replay`
 * is what makes it the picture and nothing else — no sound over a shot that
 * already happened, no shake on the camera the replay is directing, no
 * hit-stop on a clock the replay owns. See feedback().
 *
 * A CURSOR, not a window. The replay's clock runs at `speed` and a frame of it
 * covers a fraction of a second of the match, so a "fired in the last dt" test
 * would drop any event that landed between two samples; walking a sorted list
 * fires each one exactly once and never loses one to the arithmetic.
 */
function playEvents(t) {
  const rs = replayState;
  while (rs.eventAt < rs.events.length && rs.events[rs.eventAt].t <= t) {
    const e = rs.events[rs.eventAt++];
    feedback(e.name, { ...e.at, replay: true });
  }
}

/** Back to the top of the track — a rewind, or a replay being staged fresh. */
function rewindEvents(t) {
  const rs = replayState;
  let i = 0;
  while (i < rs.events.length && rs.events[i].t < t) i++;
  rs.eventAt = i;
}

function poseReplay(t) {
  const rs = replayState;
  const F = rs.frames;
  if (F.length < 2) return;
  playEvents(t);
  // The frame pair round `t` (the frames are in time order).
  let i = 1;
  while (i < F.length - 1 && F[i].t < t) i++;
  const a = F[i - 1];
  const b = F[i];
  const span = b.t - a.t;
  const u = span > 1e-9 ? clamp01((t - a.t) / span) : 1;
  ball.x = lerp(a.bx, b.bx, u);
  ball.y = lerp(a.by, b.by, u);
  ball.angle = lerp(a.bang, b.bang, u);
  ball.spin = lerp(a.bspin, b.bspin, u);
  rs.ballVx = lerp(a.bvx, b.bvx, u);
  rs.ballVy = lerp(a.bvy, b.bvy, u);
  // The recorded velocity onto the ball itself as well: renderBall pushes
  // ball.vx/vy into the look's field (setBallBody) and the slosh is the lag
  // against THAT, so a replayed ball left at zero had its contents drift the
  // wrong way. The ball is dead through a replay, so nothing steps it.
  ball.vx = rs.ballVx;
  ball.vy = rs.ballVy;
  const n = ball.rim.length;
  for (let k = 0; k < n; k++) ball.rim[k] = lerp(a.rim[k], b.rim[k], u);
  ball.rimV.fill(0);
  for (let k = 0; k < a.seals.length; k++) {
    const body = sealAt(k);
    if (!body) continue;
    const pa = a.seals[k];
    const pb = b.seals[k];
    if (!body.mesh) continue;
    body.mesh.position.x = lerp(pa.x, pb.x, u);
    body.mesh.position.y = lerp(pa.y, pb.y, u);
    // Heading the short way round.
    let d = pb.rz - pa.rz;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    body.mesh.rotation.z = pa.rz + d * u;
    if (body.body) {
      // The recorded transform, with the celebration's somersault composed
      // on the end of it the way poseBody composes it — so a victory pose
      // re-run in the replay turns the body the record never saw turn.
      body.body.quaternion.copy(_qa.slerpQuaternions(pa.q, pb.q, u));
      const spin = celebrationSpin(k === 0 ? null : (k === 1 ? 'p2' : `seal${k}`));
      if (spin) body.body.quaternion.multiply(_spinQ.setFromAxisAngle(_zAxis, spin));
    }
    body.mesh.visible = pa.vis;
    // ...AND IT IS NOT RAGDOLLING. A replay opens `replay.lead` seconds BEFORE
    // the touch that scored, so every frame of its footage is from before the
    // goal — before the blast, and before anything went limp. The ragdoll is
    // live state on the seal though, and the `anim.update` below takes its LIMP
    // branch on a limp controller: it ignores the swim state worked out from
    // the record and hangs the skeleton off the pose the seal was blown out of.
    // The replay showed every animal ragdolling through a shot of them
    // swimming.
    //
    // main.js parks the jolt for the length of a replay (setJoltPaused), and
    // this is what makes that reach the bodies: updateVersus returns early
    // while a replay is up, so seats 1..7 never see stepSeat and their own
    // syncJoltLimp — the only thing that hands a skeleton back — is not called
    // at all. This loop is the one that covers every body. Before the mixer
    // runs, so the clip asked for below is the clip that ships.
    syncSealRagdoll(body);
    // THE ANIMAL IS STILL SWIMMING. The recorder stores the body's transform,
    // not its skeleton, and the two things that would normally advance the
    // mixer are both gone during a replay: player 2's stepP2 is not called at
    // all, and player 1's updatePlayer is running on a world dilated to four
    // percent. So the seals slid through the frame as mannequins. The clip is
    // chosen from the speed the RECORD moved at — not the seal's live
    // velocity, which is whatever the frozen match left on it — and advanced
    // on the replay's own clock: wall seconds at the replay's speed, so the
    // stroke plays back as slowly as the shot does. Last, after main.js's
    // updatePlayer, for the same reason the posing above is.
    if (CONFIG.animation?.enabled && body.anim && rs.wallDt > 0) {
      const sp = span > 1e-9 ? Math.hypot(pb.x - pa.x, pb.y - pa.y) / span : 0;
      const adt = rs.wallDt * rs.speed;
      body.anim.update(adt, stateForSpeed(sp, body.mesh.position.y > bounds.surfaceY, 0), false);
      body.breathe?.update(adt, 0);
    }
    if (k === rs.who) { rs.strikerX = body.mesh.position.x; rs.strikerY = body.mesh.position.y; }
  }
  // THE LOOK AND THE STROKES, FROM THE RECORD — while there is footage. The
  // ball's colour is what it was on that frame of the match: the takeover
  // marching out of the contact, the warp kicked by the hit, the strokes its
  // spin had drawn at the time. Once the footage runs out (the held beats:
  // the explosion, the celebration) the live machines carry on from the
  // last frame restored, so explodeReplay's claimBall marches the scorer's
  // colour over the body the way the live goal did, and a dead ball's
  // strokes fade the way they did under the shutter.
  //
  // A frame with NO record (a lab's, built by hand) poses neither: the warp
  // rides the recorded velocity and the strokes are simulated off the
  // recorded spin, which is what this did for every frame before there was
  // a record.
  const footage = t < rs.endT;
  const replayDt = Math.max(0, rs.wallDt) * rs.speed;
  if (footage && poseBallLook(a.look, b.look, u)) {
    // The group's uniforms are written by updateBallLook, which the wall
    // clock ran BEFORE this frame was posed; re-derive them now from the
    // restored state (a zero step advances nothing) so what draws this frame
    // is this frame's record and not last frame's advanced by a tick.
    updateBallLook(0);
  } else {
    setBallDrive({ speed01: Math.hypot(rs.ballVx, rs.ballVy) / Math.max(1, cfg().ball?.impact?.speedRef ?? 30) });
  }
  if (!(footage && poseBallSpin(ball.spin, a.spin, b.spin, u))) updateBallSpin(footage ? ball.spin : 0, replayDt);
  // The markers follow the posed bodies through a replay too.
  placeMarkers();
}

/** The replay's framing, by beat — see the section note. */
function replayCameraGoal(frame, out) {
  const rs = replayState;
  const r = cfg().replay ?? {};
  let shot;
  if (rs.beat === 'impact') {
    // THE IMPACT: the ball and the striker, nothing else, as tight as the
    // shot's ceiling allows.
    shot = r.impact ?? {};
    boxInclude(ball.x - ball.r, ball.y - ball.r, true);
    boxInclude(ball.x + ball.r, ball.y + ball.r, false);
    boxInclude(rs.strikerX, rs.strikerY, false);
  } else if (rs.beat === 'check') {
    // A BODY CHECK: the two bodies and the point they met. No ball — the
    // ball is often nowhere near a check, and boxing it in opens the frame
    // out until the collision is two dots.
    shot = r.impact ?? {};
    const a = sealAt(rs.who);
    const b = sealAt(rs.clip?.victim ?? -1);
    boxInclude(rs.impactX, rs.impactY, true);
    if (a?.mesh) boxInclude(a.mesh.position.x, a.mesh.position.y, false);
    if (b?.mesh) boxInclude(b.mesh.position.x, b.mesh.position.y, false);
  } else if (rs.beat === 'save') {
    // A SAVE: the mouth that was not scored in, the ball leaving it, and the
    // seal that got in the way.
    shot = r.wide ?? {};
    const show = Math.max(0, cfg().camera?.mouthShow ?? 4);
    const face = rockX(rs.side);
    const gy = mouthY();
    const h = mouthHalfHeight();
    boxInclude(face + rs.side * show, gy - h, true);
    boxInclude(face, gy + h, false);
    boxInclude(ball.x - ball.r, ball.y - ball.r, false);
    boxInclude(ball.x + ball.r, ball.y + ball.r, false);
    boxInclude(rs.strikerX, rs.strikerY, false);
  } else {
    // THE WIDE: the mouth the ball is heading for — its face, what shows of
    // the tunnel, the band's full height — the ball, and the scorer, so the
    // flight, the bang and the celebration are all in the one frame.
    shot = r.wide ?? {};
    const show = Math.max(0, cfg().camera?.mouthShow ?? 4);
    const face = rockX(rs.side);
    const gy = mouthY();
    const h = mouthHalfHeight();
    boxInclude(face + rs.side * show, gy - h, true);
    boxInclude(face, gy + h, false);
    boxInclude(ball.x - ball.r, ball.y - ball.r, false);
    boxInclude(ball.x + ball.r, ball.y + ball.r, false);
    const scorer = rs.goal?.scorer ?? rs.who;
    const seal = sealAt(scorer);
    if (seal?.mesh) boxInclude(seal.mesh.position.x, seal.mesh.position.y, false);
  }
  const pad = shot.pad ?? 4;
  const cap = Math.max(1, shot.zoom ?? 2);
  const w = (_box.maxX - _box.minX) + pad * 2;
  const h = (_box.maxY - _box.minY) + pad * 2;
  out.zoom = Math.max(1, Math.min(cap, frame.w / Math.max(1e-6, w), frame.h / Math.max(1e-6, h)));
  out.x = (_box.minX + _box.maxX) * 0.5;
  out.y = (_box.minY + _box.maxY) * 0.5;
  return out;
}

// --- the camera pool ---------------------------------------------------------
//
// THE POINTS OF INTEREST the pool's shots weight between, from the world as
// poseReplay just left it. Faces are the nose end of each seal: its centre
// plus `noseLength` along its heading (the art's forward is +Y, a quarter
// turn from rotation.z). Everything is on the z = 0 plane the game plays on.

const _pois = {
  ball: { x: 0, y: 0, z: 0 }, striker: { x: 0, y: 0, z: 0 }, strikerFace: { x: 0, y: 0, z: 0 },
  scorer: { x: 0, y: 0, z: 0 }, scorerFace: { x: 0, y: 0, z: 0 }, defender: { x: 0, y: 0, z: 0 },
  mouth: { x: 0, y: 0, z: 0 }, impact: { x: 0, y: 0, z: 0 },
};

function faceOf(seal, out) {
  const m = seal.mesh;
  if (!m) { out.x = 0; out.y = 0; return out; }
  const nose = cfg().replay?.cams?.noseLength ?? 2.2;
  const a = m.rotation.z + Math.PI / 2;
  out.x = m.position.x + Math.cos(a) * nose;
  out.y = m.position.y + Math.sin(a) * nose;
  return out;
}

function gatherPois() {
  const rs = replayState;
  const p = _pois;
  // The ball — and once it is in the tunnel, the ENTRANCE: the frame never
  // looks past the face (systems/replayCams.js), so a ball down the hole is
  // framed as the hole it went down.
  //
  // EASED ONTO THE FACE, NOT CLAMPED TO IT. A hard Math.max here is a wall the
  // tracking hits: the camera followed the ball across the pitch at two units a
  // frame and then, on the frame it crossed, the thing it was following stopped
  // dead while the ball carried on into the goal in plain view. That reads as
  // the camera sticking — and it is the loudest of the replay's stepping,
  // because it lands on the one moment every eye in the frame is on.
  //
  // A softplus instead: the tracked point follows the ball unit for unit while
  // it is well clear of the face, eases off over the last `mouthSoften` units,
  // and settles just short of the face rather than on it. The rule the clamp
  // was there to keep is kept — the frame still never looks past the face —
  // and the deceleration is now something the eye reads as the camera arriving
  // rather than as a dropped frame.
  const inset = cfg().replay?.cams?.mouthInset ?? 2;
  const faceIn = rockX(rs.side) - rs.side * inset;
  const soften = Math.max(0.01, cfg().replay?.cams?.mouthSoften ?? 4);
  // How far the ball still has to go to reach the face: positive in front of
  // it, negative once it is past.
  const toFace = rs.side < 0 ? ball.x - faceIn : faceIn - ball.x;
  const u = toFace / soften;
  const eased = u > 20 ? toFace : soften * Math.log(1 + Math.exp(u));
  p.ball.x = faceIn + (rs.side < 0 ? eased : -eased);
  p.ball.y = ball.y;
  // THE STRIKER is whoever the clip is about: the seal that shot, the seal
  // that saved, the seal that threw the check. THE DEFENDER is the one it
  // happened to — the seal that conceded, the seal whose shot was saved, the
  // seal that got rammed. A save and a check have no scorer, so the scorer
  // targets fall back to the striker rather than framing an empty patch of
  // water; the shots for those beats do not ask for them.
  const striker = sealAt(rs.who) ?? player;
  const scorerWho = rs.goal?.scorer ?? rs.who;
  const scorer = sealAt(scorerWho) ?? striker;
  const other = rs.clip?.victim ?? (rs.kind === 'goal' ? opposingSeat(scorerWho) : opposingSeat(rs.who));
  const defender = sealAt(other) ?? scorer;
  const at = (seal, out) => { const m = seal?.mesh?.position; out.x = m?.x ?? ball.x; out.y = m?.y ?? ball.y; };
  at(striker, p.striker);
  faceOf(striker, p.strikerFace);
  at(scorer, p.scorer);
  faceOf(scorer, p.scorerFace);
  at(defender, p.defender);
  // The ENTRANCE — the face, not a point down the tunnel: shots aim at the
  // hole, never into it.
  p.mouth.x = rockX(rs.side) - rs.side * (cfg().replay?.cams?.mouthInset ?? 2); p.mouth.y = mouthY();
  // WHERE THE MOMENT HAPPENED, carried on the span rather than read off
  // versusState.lastTouch: the reel plays a check from two minutes ago, and
  // the match's last touch is somewhere else entirely by then.
  p.impact.x = rs.impactX; p.impact.y = rs.impactY;
  rs.pois = p;
  return p;
}

/** The nearest seal on the other side to seat `who`, or -1 in an empty match. */
function opposingSeat(who) {
  const me = sealAt(who);
  const mine = me ? sealPos(me) : null;
  let best = -1;
  let bestD = Infinity;
  for (const seal of matchSeals()) {
    const seat = seatOf(seal);
    if (seat === who || sameTeam(seat, who)) continue;
    const dx = sealPos(seal).x - (mine?.x ?? 0);
    const dy = sealPos(seal).y - (mine?.y ?? 0);
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = seat; }
  }
  return best;
}

/** The director's frame, on the wall clock updateReplay recorded for it. */
function updateReplayCams() {
  const rs = replayState;
  if (!rs.active || !poolState.active) return;
  updatePool({
    beat: rs.beat, side: rs.side, pois: gatherPois(), bounds,
    aspect: rs.aspect, dt: rs.wallDt,
  });
}

/**
 * Which timeline beat a recorded time falls in: the wind-up until
 * `impactHold` past the moment itself, and this kind of clip's second beat
 * from there. updateReplay's, the reel's, and the lab's.
 */
function beatAt(t) {
  const r = cfg().replay ?? {};
  const rs = replayState;
  return t < rs.pivotT + (r.impactHold ?? 0.2) ? rs.timeline[0] : rs.timeline[1];
}

// --- the replay lab's way in -------------------------------------------------
//
// tools/looks/replay-lab.js — `npm run looks:replaylab`. A shot in the pool
// cannot be judged without seeing it, and the only way to see one was to play
// a match to a goal and watch six seconds go past. The lab stages a canned
// goal instead and loops it.
//
// It hands in a BUFFER, in the recorder's own frame shape, and then drives the
// replay's clock. Everything downstream of that is the shipping path with
// nothing swapped for a stand-in: poseReplay poses the ball and both seals,
// gatherPois reads the points of interest off them, updatePool scores and cuts
// between the shots, replayRenderCamera hands back the camera and writes the
// lens. What the lab replaces is only what a match would have supplied — the
// recorder, and the phase machine that decides a replay is due.
//
// None of this runs in a match. startReplay builds the same state from the
// real ring buffer and never calls any of it.

/** An empty frame in the recorder's shape, for a lab to fill. */
export function makeReplayFrame() {
  return makeFrame();
}

/**
 * Stage a replay from frames a lab built. `frames` is in time order and ends
 * on the goal; the rest is what startReplay reads off the match — who struck
 * it, when, which mouth it went into — and is what gatherPois and the beat
 * machine need. Poses the first frame and starts the pool directing.
 */
export function stageReplay({ frames, touchT, goalT, side = -1, who = 0, scorer = who, aspect = 16 / 9, events = [], kind = 'goal' }) {
  const rs = replayState;
  const r = cfg().replay ?? {};
  if (!frames || frames.length < 2) return false;
  rs.aspect = aspect;
  // What gatherPois reads: the goal that was scored and the touch that scored
  // it. The impact target IS that touch's position, so a lab that leaves this
  // null frames the impact on wherever the ball happens to be.
  const last = frames[frames.length - 1];
  const touchFrame = frames.find((one) => one.t >= touchT) ?? last;
  const goal = { t: goalT, side: side < 0 ? 'left' : 'right', y: last.by, scorer };
  // A staged replay's effects are whatever the lab hands over — an empty
  // track is a silent diagram, which is what this was before there was one.
  const ok = openSpan({
    kind, frames, events,
    fromT: touchT - (r.lead ?? 0.9), toT: goalT, pivotT: touchT,
    who, side, goal, impactX: touchFrame.bx, impactY: touchFrame.by,
    tailHold: cfg().reel?.hold ?? 0.5,
  });
  if (!ok) return false;
  // THE MATCH STATE THE LAB HAS NONE OF. openSpan carries the goal on the
  // span itself, but the goal card and the harness still read versusState,
  // and a lab with a null lastGoal reads as a match that has never scored.
  versusState.lastGoal = goal;
  versusState.lastTouch = { t: touchT, who, kind: 'strike', x: touchFrame.bx, y: touchFrame.by };
  rs.wallDt = 1 / 60;
  return true;
}

/**
 * One wall frame of a staged replay — advanceBeats, the same one a match runs,
 * with the skip and the phase hand-back left out since a lab has neither.
 * Returns false once the last beat has been held its time, which is where a
 * match would end the replay and a lab loops.
 *
 * `explode` off stages the beats with none of their effects fired.
 */
export function stepStagedReplay(rawDt, { explode = true } = {}) {
  const rs = replayState;
  if (!rs.active) return false;
  rs.wall += rawDt;
  rs.wallDt = rawDt;
  const alive = advanceBeats(rawDt, { fire: explode });
  poseReplay(rs.t);
  updateReplayCams();
  // BOTH DRIVERS, AND THE CLOCK, because a lab has no main.js. In a match the
  // celebration's own clock and player 1's driver are ticked by main.js every
  // frame whatever the phase, and only player 2's is versus.js's to tick — see
  // updateReplay. Off that loop, nothing advanced updateCelebration at all, so
  // a staged celebration never reached its duration, never reset, and posed
  // the seal for ever: it was still going in the next pass's lead-up, which
  // looked exactly like the camera bug it was mistaken for.
  //
  // AFTER poseReplay, never before. poseReplay runs the animation controller,
  // which writes an absolute pose every frame — a driver run first is simply
  // overwritten and appears to do nothing.
  updateCelebration(rawDt);
  player.celebrate?.update(rawDt);
  p2.celebrate?.update(rawDt);
  return alive;
}

/**
 * Jump a staged replay to recorded time `t` — the scrub. Past the goal there
 * is no recorded time left, so `t - goalT` is read as wall seconds into the
 * two held beats in their order — the explosion's `explode`, then the
 * celebration's `celebrateHold` — and one slider covers the whole thing.
 * The pool is stepped by `wallDt` at the new position rather than reset, so
 * scrubbing shows the director choosing.
 */
export function seekStagedReplay(t, wallDt = 1 / 60) {
  const rs = replayState;
  if (!rs.active) return;
  rs.wallDt = wallDt;
  let past = t - rs.endT;
  if (past >= 0) {
    rs.t = rs.endT;
    // WALK THE HOLDS THIS KIND OF CLIP HAS, in their order, rather than
    // naming the goal's two: a save and a check have none, and one slider
    // still has to cover the whole thing.
    rs.beat = rs.timeline[1];
    rs.hold = Math.min(past, rs.tailHold);
    for (const [name, dur] of rs.holds) {
      rs.beat = name;
      rs.hold = past;
      if (past < dur) break;
      past -= dur;
    }
  } else {
    rs.t = Math.max(rs.startT, t);
    rs.hold = 0;
    rs.beat = beatAt(rs.t);
  }
  // A SCRUB GOES BACKWARDS. The event cursor only ever walks forward, so
  // dragging the lab's timeline back would otherwise leave it parked past the
  // effects being scrubbed over and the second pass would be silent.
  rewindEvents(rs.t);
  poseReplay(rs.t);
  updateReplayCams();
}

/**
 * Is a replay on screen? Asked by main.js, which otherwise has no idea — the
 * goal's shutter only dilates the clock, so every gameplay system kept running
 * on live input at four percent. Nothing that reads the player's hands may act
 * while this is true; see holdInput in input.js.
 */
/**
 * The rate a replay is playing its footage back at, or 0 when none is running.
 * main.js drives the EFFECT systems on this instead of the dilated gameplay
 * clock: the shutter holds that at four percent for the whole replay, so every
 * burst the event track re-fired hung in the air as a static blob — a 0.4s
 * spray taking ten seconds to die, over footage moving at half speed.
 *
 * The replay's own rate is the honest answer rather than 1: the picture is in
 * slow motion, so the smoke in it should be too.
 */
export function replaySpeed() {
  return replayState.active ? replayState.speed : 0;
}

export function replayHoldsInput() {
  return replayState.active;
}

/** Drop a staged replay: the pool stops directing and the lens goes back. */
export function endStagedReplay() {
  endReplay(false);
}

/**
 * THE CAMERA TO RENDER THROUGH THIS FRAME, or null for the world's own — asked
 * by main.js right before post.render. While the pool is directing, this is
 * its perspective camera, and the lens is written for the composite (post.js
 * reads cineLens; `forced` lets it through with the cinematic camera off).
 */
export function replayRenderCamera() {
  const rs = replayState;
  if (!rs.active || !poolState.active || poolState.shot < 0) {
    if (rs.lensForced) releaseReplayLens();
    return null;
  }
  const c = cfg().replay?.cams ?? {};
  cineLens.forced = true;
  cineLens.active = true;
  cineLens.defocus = poolState.lens.defocus;
  cineLens.focusX = poolState.focusUv.x;
  cineLens.focusY = poolState.focusUv.y;
  cineLens.focusRadius = poolState.lens.focusRadius;
  cineLens.focusFeather = poolState.lens.focusFeather;
  cineLens.flare = c.lens?.flare ?? 0;
  cineLens.vignette = c.lens?.vignette ?? 0;
  rs.lensForced = true;
  return poolState.camera;
}

function releaseReplayLens() {
  const rs = replayState;
  if (!rs.lensForced) return;
  rs.lensForced = false;
  cineLens.forced = false;
  // What the replay wrote goes back to nothing. With the cinematic camera on
  // it rewrites these every frame anyway; off, nobody else would, and the
  // frame after the replay must not keep the replay's blur.
  cineLens.defocus = 0;
  cineLens.flare = 0;
  cineLens.vignette = 0;
  if (!CONFIG.cinecam?.enabled) cineLens.active = false;
}

// --- any button, held ------------------------------------------------------
const heldKeys = new Set();
let pointersDown = 0;
let skipListening = false;
const onSkipKeyDown = (e) => { if (e && !e.repeat) heldKeys.add(e.code ?? e.key ?? 'key'); };
const onSkipKeyUp = (e) => { heldKeys.delete(e.code ?? e.key ?? 'key'); };
const onSkipPointerDown = () => { pointersDown++; };
const onSkipPointerUp = () => { pointersDown = Math.max(0, pointersDown - 1); };
const onSkipBlur = () => { heldKeys.clear(); pointersDown = 0; };

function installSkipListeners() {
  if (skipListening || typeof window === 'undefined' || !window.addEventListener) return;
  window.addEventListener('keydown', onSkipKeyDown);
  window.addEventListener('keyup', onSkipKeyUp);
  window.addEventListener('pointerdown', onSkipPointerDown);
  window.addEventListener('pointerup', onSkipPointerUp);
  window.addEventListener('pointercancel', onSkipPointerUp);
  window.addEventListener('blur', onSkipBlur);
  skipListening = true;
}

function removeSkipListeners() {
  if (!skipListening) return;
  window.removeEventListener('keydown', onSkipKeyDown);
  window.removeEventListener('keyup', onSkipKeyUp);
  window.removeEventListener('pointerdown', onSkipPointerDown);
  window.removeEventListener('pointerup', onSkipPointerUp);
  window.removeEventListener('pointercancel', onSkipPointerUp);
  window.removeEventListener('blur', onSkipBlur);
  skipListening = false;
  onSkipBlur();
}

/** Is anything down — a key, a pointer, any button on any pad? */
export function anyButtonHeld(pads = null) {
  if (replayState.forceHold) return true;
  if (heldKeys.size || pointersDown > 0) return true;
  let list = pads;
  if (!list) {
    try { list = navigator.getGamepads?.() ?? []; } catch { list = []; }
  }
  for (const pad of list ?? []) {
    if (!pad?.connected) continue;
    for (const b of pad.buttons ?? []) if (b && (b.pressed || (b.value ?? 0) > 0.5)) return true;
  }
  return false;
}

function showReplayUi(on) {
  if (!ui?.replay) return;
  ui.replay.classList.remove('sv-versus-reel');
  ui.replay.hidden = !on;
  if (!on) return;
  ui.replayTag.textContent = uiText('versusReplay');
  ui.replaySkip.textContent = uiText('versusReplaySkip');
  paintSkip(0);
  glassTint(ui.replay, goalColors()[versusState.scorer]);
}

/**
 * THE REEL'S TAG — the same corner the replay's tag uses, saying which kind of
 * moment is on screen and in the colour of the seal it belongs to. No skip
 * prompt and no bar: the reel is not something to get past, it is what the
 * screen is for until somebody answers the prompt over it.
 *
 * `clip` of null takes the corner down — the reel has run out of clips.
 */
function showReelUi(clip) {
  if (!ui?.replay) return;
  ui.replay.classList.toggle('sv-versus-reel', !!clip);
  ui.replay.hidden = !clip;
  if (!clip) return;
  ui.replayTag.textContent = reelTag(clip.kind);
  ui.replaySkip.textContent = '';
  paintSkip(0);
  // WHOSE MOMENT IT IS, not whose goal: a save belongs to the seal that made
  // it and a check to the seal that threw it, and both of those are the team
  // the goal-coloured version of this line would have got wrong.
  glassTint(ui.replay, goalColors()[teamOfSeat(clip.who)]);
}

/**
 * The line naming each kind of highlight, for the tag above. WRITTEN OUT,
 * one uiText call per id, rather than a kind → id map: the id has to be a
 * literal at the call for `npm run test:uitext` to be able to see the read at
 * all, and a table join it cannot see is a join that can go stale in silence.
 */
function reelTag(kind) {
  if (kind === 'save') return uiText('versusReelSave');
  if (kind === 'check') return uiText('versusReelCheck');
  return uiText('versusReelGoal');
}

/**
 * The hold bar under the skip prompt, 0..1. The prompt itself brightens with
 * it: the bar is four pixels tall in a corner, and on a busy frame it is the
 * line of text going from a hint to a statement that says the hold is
 * registering at all.
 */
function paintSkip(t) {
  if (!ui?.replayBar) return;
  const k = clamp01(t);
  ui.replayBar.style.width = `${(k * 100).toFixed(1)}%`;
  ui.replaySkip.style.opacity = String(0.7 + 0.3 * k);
}

// ---------------------------------------------------------------------------
// THE CAMERA — a box round the subjects, and the tightest frame that holds it.
//
// ONE RULE, AND IT IS NOT NEGOTIABLE: THE PLAYER AND THE BALL ARE IN FRAME.
// Everything else here — the mode, the padding, the lead, the bias, the goal
// widening — is a preference about a shot that already obeys it. Nothing may
// clamp the zoom in a direction that leaves a subject outside the frame, which
// is why there is no zoom FLOOR any more: a floor is a promise to cut somebody
// out on the day the box gets bigger than it. `zoomMax` is the only clamp left
// and it can only punch in on a box that already fits.
//
// WHO IS IN THE BOX is the one thing that varies, and it is a question about
// how many people are in the room rather than about the device:
//
//   A  the ball and BOTH seals — local multiplayer, two people on one screen,
//      and neither of them may be left off it.
//   B  the ball and ONE seal, the one the person here is driving. A match
//      against the computer, an online match (the other seal is on someone
//      else's screen), and anything on a phone, which can only be one of
//      those. The CPU's seal is not a subject and does not widen the shot.
//
// WHAT THE RULE COSTS ON A NARROW SCREEN, because it is a real cost and the
// number is not small. The frame's HEIGHT is 52 world units at zoom 1 on every
// device — viewHeight is a constant, and the window's aspect only moves the
// WIDTH (updateBounds in arena.js) — so the shape of the frame is the shape of
// the glass, and holding two things 143 units apart on a 9:19.5 phone means a
// frame 198 wide, which is 429 tall. The pitch is then a sixth of the screen's
// height with sky and seabed over and under it. That is not a bug in the fit:
// it is what "both in frame" means on a screen that shape, and the only ways
// out of it are a shorter pitch or a letterboxed viewport, neither of which
// the camera can decide for itself. The BACKDROP is built for it (see
// versusZoomFloor in systems/backdropFit.js, which measures the same worst box
// this camera can be handed) so the widest shot still lands on sky and seabed
// rather than on bare background.
//
// THE PADDING AND THE BIAS both live inside the rule. `pad` is air round the
// box and is part of what the fit holds, so it is never spent to keep a
// subject in — it cannot be, because it is inside the thing being fitted.
// `bias` moves the centre towards the person's own seal, and may only spend
// SLACK: the frame is tight on exactly one axis (the one whose fit won), and
// the other has room between the box's edge and the frame's. Zero on the tight
// axis, by construction, so the bias can never be the thing that breaks this.
//
// The centre is led a little by where the ball is going, and world.clampFocus
// keeps it inside the walls — plus `camera.reach` past them, into the goals
// (versusGoal.cameraReach) — at whatever zoom the frame ended up at. That
// clamp cannot break the rule either: it only ever moves a frame that was
// hanging PAST the arena back towards it, and every subject is inside the
// arena and its reach. Smoothed here, claimed at full weight every frame the
// way the dev stage parks its shot.
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
 * WHOSE SEAL THE FRAME IS ON: null for everybody (mode A), or the seat index
 * of the one seal it is biased towards (mode B).
 *
 * 'auto' asks the roster rather than the device (see versusLocalMultiplayer in
 * systems/versusFlag.js): two people on one screen is A, one person is B on
 * their own seal. A phone can only ever be the second of those, which is why
 * there is no touch test here — the count already answers it, and a
 * user-agent sniff would answer it worse.
 *
 * An explicit 'A' or 'B' forces that framing, with `camera.subject` picking
 * B's seal. That is the tuner's and the harness's way of looking at either one
 * without a roster, and it is what the shipped config used to say.
 */
function camSubject(c) {
  const m = (c.mode ?? 'auto').toUpperCase();
  if (m === 'A') return null;
  if (m === 'B') return (c.subject ?? 0) === 1 ? 1 : 0;
  return versusLocalMultiplayer() ? null : versusLocalTeam();
}

/**
 * The frame the camera is aiming for, unsmoothed: { x, y, zoom }. `frame` is
 * the frustum at zoom 1 in world units — { w, h } — which is what the world's
 * orthographic camera's right-left and top-bottom are.
 */
export function versusCameraGoal(frame, out = { x: 0, y: 0, zoom: 1 }) {
  if (replayState.active) return replayCameraGoal(frame, out);
  const c = cfg().camera ?? {};
  const subject = camSubject(c);
  const pad = c.pad ?? 9;
  const lead = c.lead ?? 0.22;
  const bx = ball.x + ball.vx * lead;
  const by = ball.y + ball.vy * lead;
  boxInclude(bx, by, true);
  boxInclude(bx - ball.r, by - ball.r, false);
  boxInclude(bx + ball.r, by + ball.r, false);
  const p1 = player.mesh?.position;
  const subjectPos = subject === 1 ? p2.pos : p1;
  const seals = subject == null ? [p1, p2.pos] : [subjectPos];
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
      const show = Math.max(0, Math.min(c.mouthShow ?? 10, cameraReach()));
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
  // THE RULE: the box is held on BOTH axes, whatever that costs. The tighter
  // of the two fits is the widest frame either axis needs, and there is NO
  // floor under it — a floor is a promise to cut somebody out, which is the
  // one thing this camera may not do. zoomMax is the only clamp, and it can
  // only ever punch IN on a box that already fits.
  const zoomMax = Math.max(0.01, c.zoomMax ?? 2);
  out.zoom = Math.min(zoomMax, fitW, fitH);
  out.x = (_box.minX + _box.maxX) * 0.5;
  out.y = (_box.minY + _box.maxY) * 0.5;
  // ...AND THE BIAS, WHICH SPENDS SLACK AND NOTHING ELSE. The frame is only
  // ever tight on ONE axis — the one whose fit won — so the other has room
  // between the box's edge and the frame's, and that room is what the bias may
  // move the centre by. Measured against the zoom this frame actually ended up
  // at, so it is right at every aspect and through every punch-in; zero when
  // the axis is the tight one, which is why the rule above survives it.
  if (subject != null && subjectPos) {
    const bias = clamp01(c.bias ?? 0.5);
    const slackX = Math.max(0, frame.w / (2 * out.zoom) - w * 0.5);
    const slackY = Math.max(0, frame.h / (2 * out.zoom) - h * 0.5);
    const wantX = out.x + (subjectPos.x - out.x) * bias;
    const wantY = out.y + (subjectPos.y - out.y) * bias;
    out.x = Math.max(out.x - slackX, Math.min(out.x + slackX, wantX));
    out.y = Math.max(out.y - slackY, Math.min(out.y + slackY, wantY));
  }
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

/**
 * HOW DEEP THE MIX IS — the world Y the music's low-pass and the SFX bus's
 * follow during a match.
 *
 * THE BALL, not a seal. In a run those are the same question asked once: there
 * is one animal, the camera is on it, and the water closing over the mix as it
 * dives is the player hearing their own depth. A match has two seals in
 * different places and a camera that is on NEITHER of them — it is on the ball
 * (see versusCameraGoal) — so "the player's depth" stops meaning anything.
 * Player 1's Y would muffle the mix for both players from one side of a
 * two-player screen, and would do it while the picture was somewhere else.
 *
 * The ball is the thing the shot is on and the thing both players are watching,
 * so it is the thing the water should be heard closing over. It also swims a
 * narrower range than a seal does — it is rarely out of the water and rarely on
 * the floor — which makes the match's mix steadier than a run's. That is the
 * mode, not a loss: a run's muffling is a thing you do to yourself, and a
 * match's is the depth the play is at.
 *
 * `ball.y` is written on every path a match can be in — stepBall while it is
 * live, resetBall at a kickoff, poseReplay from the recorded frames during a
 * goal replay — so this needs no phase test. Only main.js's `versusActive()`
 * gate stands between it and a torn-down match.
 */
export function versusMixDepth() {
  return ball.y;
}

/** Where a fixed shot would sit: the arena's centre. The seed for the smoothing. */
export function versusFocus(out = { x: 0, y: 0 }) {
  out.x = (bounds.left + bounds.right) * 0.5;
  out.y = bounds.bottom + (CONFIG.arena.viewHeight ?? 52) * 0.5;
  return out;
}

const _goal = { x: 0, y: 0, zoom: 1 };
// The frame the camera was last CHASING, kept so cameraRecentred can ask how
// far it still has to go without a frustum of its own.
const camWant = { x: 0, y: 0, zoom: 1, has: false };

/**
 * Is the shot on the frame it is chasing? The kickoff's count waits on this.
 * True with nothing to compare against, so a harness that never ran a camera
 * frame cannot deadlock a match.
 */
export function cameraRecentred() {
  if (!camWant.has || !camState.seeded) return true;
  const ko = cfg().kickoff ?? {};
  const tol = ko.settleTol ?? 1.5;
  const ztol = ko.settleZoomTol ?? 0.03;
  return Math.hypot(camWant.x - camState.x, camWant.y - camState.y) <= tol
    && Math.abs(camWant.zoom - camState.zoom) <= ztol * Math.max(0.01, camWant.zoom);
}

/**
 * Chase the goal frame and claim it. `world` is the game world (its camera's
 * frustum is the frame); `dt` is the real clock.
 */
export function updateVersusCamera(world, dt) {
  if (!versusState.active || !world?.camera) return;
  const cam = world.camera;
  const frame = { w: cam.right - cam.left, h: cam.top - cam.bottom };
  if (frame.h > 0) replayState.aspect = frame.w / frame.h;
  versusCameraGoal(frame, _goal);
  const c = cfg().camera ?? {};
  if (!camState.seeded) {
    if (camHandover) {
      // BLENDED IN FROM THE TEAM SELECT'S PITCH. That screen leaves the camera
      // on the arena's own framing with the roster standing on it, which is
      // already most of the kickoff shot — so the match opens by PUSHING IN
      // from it over the same lerp every other move uses, and the whistle is
      // not a cut.
      //
      // Seeded off the live frustum rather than off a remembered number: the
      // focus point is the camera's position plus the centre of its own
      // asymmetric frustum (see viewCentre in world.js), and anything else is
      // a second description of where the shot is that would be a few units
      // out on exactly the frame it matters.
      camState.x = cam.position.x + (cam.left + cam.right) * 0.5;
      camState.y = cam.position.y + (cam.top + cam.bottom) * 0.5;
      camState.zoom = cam.zoom;
    } else {
      // A CUT, and it stays one for every other way in. A rematch off the
      // score card, a `?versus` boot: the camera is wherever the last thing
      // left it and there is nothing on screen for a move to open out of, so
      // seeding on the goal makes the first frame already the right one.
      camState.x = _goal.x;
      camState.y = _goal.y;
      camState.zoom = _goal.zoom;
    }
    camHandover = false;
    camState.seeded = true;
  }
  camWant.x = _goal.x; camWant.y = _goal.y; camWant.zoom = _goal.zoom; camWant.has = true;
  // THE CAMERA IS NOT PART OF THE WORLD. main.js hands this the dilated
  // delta, and through a kickoff and a replay the world is at freezeScale —
  // four percent — so a shot asked to travel the length of the pitch back to
  // centre would take half a minute of wall time to do it, with the countdown
  // running at full speed over the top. Those two phases move on the wall
  // clock; everything else keeps the water's, so a hit-stop still holds the
  // frame the way it holds everything else.
  const wall = versusState.wallDt || dt;
  if (versusState.phase === 'kickoff' || replayState.active) dt = wall;
  // A replay's shots: a CUT lands the frame outright; otherwise each shot
  // chases at its own rates (the impact quick, the wide a slow opening-out).
  let rate = c.lerp ?? 5;
  let zoomRate = c.zoomLerp ?? 3;
  if (replayState.active) {
    const r = cfg().replay ?? {};
    const shot = replayState.beat === 'impact' ? (r.impact ?? {}) : (r.wide ?? {});
    rate = shot.lerp ?? rate;
    zoomRate = shot.zoomLerp ?? zoomRate;
    if (replayState.cutPending) {
      replayState.cutPending = false;
      camState.x = _goal.x;
      camState.y = _goal.y;
      camState.zoom = _goal.zoom;
      replayState.cuts = (replayState.cuts ?? 0) + 1;
    }
  }
  const k = 1 - Math.exp(-rate * dt);
  const kz = 1 - Math.exp(-zoomRate * dt);
  camState.x += (_goal.x - camState.x) * k;
  camState.y += (_goal.y - camState.y) * k;
  camState.zoom += (_goal.zoom - camState.zoom) * kz;
  world.focusCamera(camState, camState.zoom, 1);
}

export function versusCameraState() { return camState; }

/**
 * The seat markers, for tests — the thin ring drawn under each seal. Both bugs
 * they have had are invisible from anywhere else: a build that pushed without
 * clearing left circles in the scene forever, and a follow loop that ran only
 * for a roster of two left every other size sitting at the origin. Neither
 * throws, and both look from the outside like one stray circle over the water.
 */
export function seatMarkers() { return markers; }

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
  _rgb.set(look.color ?? 0xffd166).multiplyScalar(look.glow ?? 1.5);
  const group = ball.group;
  let k = 0;
  const slots = ball.slots;
  if (!ball.live && !replayState.active) {
    // Gone into the goal: park every slot dead until the respawn.
    for (const s of slots) writeDriven(s, ball.x, ball.y, 1e6, 1, 0, _rgb, group);
    flushDriven();
    keepGooAlive('ball', 0.25);
    renderBallSpin(ball, rimRadiusAt);
    return;
  }
  // THE SAME ARRANGEMENT THE HITBOX IS SOLVED THROUGH — ballSplats is the one
  // description of this body, and this loop is the half of it that draws.
  // Centre, then the inner ring (which rides the rim's offsets at a fraction,
  // so a dent reads through the body rather than only on the skin), then the
  // rim itself; all in the ball's frame, so they turn with the spin.
  const splats = ballSplats(ball, rimRadius, rimAngle);
  for (let i = 0; i < splats.length && k < slots.length; i++) {
    const p = splats[i];
    writeDriven(slots[k++], ball.x + p.x, ball.y + p.y, 0, 1, splatSize(p.r), _rgb, group);
  }
  flushDriven();
  // WHERE THE BODY IS, for the two-colour possession field — in world units,
  // because the goo pass is the thing holding the camera it will be rendered
  // through and it does the projection itself (see post.js). The radius is the
  // DRAWN one, so the field covers the ball a player can see.
  //
  // HERE rather than in updateVersus, and that is the whole reason it works
  // outside a match: this function is what every path that draws the ball goes
  // through — the match, the ball lab, the replay lab — and a field pushed
  // from the match loop alone would be switched off in both labs, which is
  // where it is actually tuned.
  setBallBody({
    x: ball.x, y: ball.y, r: ballHitRadius(),
    speed: Math.hypot(ball.vx, ball.vy), vx: ball.vx, vy: ball.vy,
  });
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
  solveBallSurface();
  stepBall(dt, false);
  updateBallSpin(ball.spin, dt);
}

/**
 * A strike from a point outside the ball. `at` is where the striker is,
 * `dir` the dash's line, `speed` how fast it arrives and `power` the wind-up.
 * The striker is moved onto the ball's contact circle along its own line
 * first, so any press near the ball lands a hit.
 */
export function strikeBallFrom(at, dir, speed, power, english = 0, who = 0) {
  const body = cfg().ball?.body ?? {};
  const thick = Math.max(0.01, body.thickness ?? 0.69);
  const noseSeg = Math.max(0, (body.nose ?? 3.31) - thick);
  const dl = Math.hypot(dir.x, dir.y) || 1;
  const dx = dir.x / dl;
  const dy = dir.y / dl;
  // WHERE THE NOSE HAS TO BE, not where a circle round the seal's middle
  // would have to be: the striker is a capsule pointed along its own dash,
  // so the thing that meets the ball is the end of it. The body is then hung
  // back off that point along the dash.
  const ox = at.x - ball.x;
  const oy = at.y - ball.y;
  // The ball, in the dash line's own frame: `perp` is how far off the line it
  // sits, and perpX/perpY is the closest the line ever comes to it.
  const along = ox * dx + oy * dy;
  const perpX = ox - dx * along;
  const perpY = oy - dy * along;
  const perp = Math.hypot(perpX, perpY);
  // The drawn edge on the side the press is coming from, plus the body's own
  // half-thickness, a shade inside so the press always lands rather than
  // sitting exactly on the edge.
  const side = perp > 1e-6 ? Math.atan2(perpY, perpX) : Math.atan2(oy, ox);
  const minD = Math.max(0.1, ballHitRadiusAt(side) + thick - 0.3);
  let nx;
  let ny;
  if (perp < minD) {
    // The line does run through the body: the nose stops the moment it
    // crosses, which is `back` short of the ball's closest point on the line.
    const back = Math.sqrt(minD * minD - perp * perp);
    nx = ball.x + perpX - dx * back;
    ny = ball.y + perpY - dy * back;
  } else {
    // The line misses it outright: the nose on the edge nearest `at`, which
    // is the closest this press could ever have come.
    const ol = Math.hypot(ox, oy) || 1;
    nx = ball.x + (ox / ol) * minD;
    ny = ball.y + (oy / ol) * minD;
  }
  const sx = nx - dx * noseSeg;
  const sy = ny - dy * noseSeg;
  const vel = { x: dx * speed, y: dy * speed };
  // WHICH SEAL IS SWINGING, and it is not always player 1. It was hard-wired
  // to 0, which is invisible until possession stops being decoration: the ball
  // lab's P1/P2 buttons set the colour an EVENT fires in, so both of them
  // struck as player 1 and the two-colour field could not be driven from the
  // one page it is meant to be tuned on.
  ball.dashHit[who] = false;
  return sealContact(who, { x: sx, y: sy }, vel, true, { x: dx, y: dy }, power, english, Math.atan2(dy, dx));
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
/* PREVIEWED FROM THE TEXT PANEL, over the start menu. The HUD lives at 7 —
   under .sv-ui's 10 — because in a match the menus are down and the toast
   layer (6) is what it has to clear. Previewed from the title screen the
   splash is still up in .sv-ui, and the whole HUD was invisible behind it:
   styled, measured, correct, and behind a picture. Lifted just past the menu
   layer for the preview only; the retro overlay (25) and the panel (31) stay
   above it. See previewVersusUi. */
.sv-versus.sv-versus-preview { z-index: 11; }
/* THE STRIP IS SCALED TO FIT, and the scale is measured rather than written.
   Every other line in Blubberball is sized in vmin with a px floor; the score
   and the clock are the two that are not (see vsScore/vsClock in
   textRoles.js), so the strip is a FIXED ~437px on every screen there is —
   which is 62px wider than an iPhone SE and 6px wider than a Pro Max. It hung
   off both sides of every phone in the game.

   RETUNING THE TYPE IS NOT THE FIX. Those sizes are the Text panel's and are
   tuned (52px of Orbitron on the clock is a decision, not a default), and
   min-width: 5ch on the clock is what actually reserves the 249px — a match
   can run past ten minutes and the strip must not shuffle sideways when it
   does. So the composition is kept exactly as authored and the whole thing is
   made smaller, which is what a phone wants anyway.

   --sv-vs-fit is written by fitStrip(). transform-origin is the top centre
   so the scale happens about the point left:50% + translateX(-50%) already
   puts the strip at — the centre stays on the centre line and the top stays at
   top, at any scale. The order matters: the translate must come first, or the
   -50% is itself scaled and the strip drifts off centre as it shrinks. */
/* THE BAND THE STRIP IS CENTRED IN — the top of the screen minus whatever the
   device keeps for itself. The page draws edge to edge (viewport-fit=cover in
   index.html), so the top of the viewport is the top of the GLASS and not the
   top of the usable screen, and the strip's left:50% was the middle of the
   glass rather than the middle of what a player can see.

   BOTH AXES, because the Dynamic Island is in a different place in each
   orientation and the strip is in the wrong one both times. Upright the pill
   is at the top centre — exactly where the clock sits between the two scores,
   which is the one part of this readout that changes every second. On its
   side the inset moves to the leading edge instead (~59px), the top inset
   goes to 0, and the strip is then centred in a frame 59px of which is not
   there: the fit below would scale it to a width that runs under the pill.

   A WRAPPER RATHER THAN A CALC ON THE STRIP, unlike the run's HUD in
   ui/ui.js, and for one reason: fitStrip() needs the room in PIXELS and env()
   is a CSS function with no JS reading. An element the browser has already
   resolved the insets on hands it over as clientWidth, which is exact,
   free, and cannot drift from the rule that placed the strip. Zero-height, so
   it takes no space and nothing below it moves. */
.sv-versus-band { position: absolute; top: 0; height: 0; pointer-events: none;
  left: env(safe-area-inset-left, 0px); right: env(safe-area-inset-right, 0px); }
/* THE STRIP IS SCALED TO FIT — see the note above the band. The top inset is
   ADDED to the tuned 12px rather than swapped in for it: the 12px is how far
   under the top edge the strip hangs, the inset is where the top edge
   actually is, and it is 0 on every screen without a notch. The same rule the
   boss bar keeps (ui/ui.js, ui/bossBarRive.js). */
.sv-versus-hud { position: absolute; top: calc(12px + env(safe-area-inset-top, 0px)); left: 50%;
  transform: translateX(-50%) scale(var(--sv-vs-fit, 1)); transform-origin: 50% 0;
  display: flex; align-items: center; gap: 22px;
  transition: opacity .34s ease; }
/* THE STRIP IS A GAMEPLAY READOUT AND THE MATCH IS OVER. Both scores and the
   clock are on the stats page, bigger, beside the names they belong to and
   with the goals, assists, saves and possession that explain them — so the
   strip left at the top is the same two numbers a second time, smaller, over
   the page giving the fuller answer. It is what you check WHILE you are
   playing, and there is nothing left to check.
   A TRANSITION RATHER THAN A KEYFRAME, unlike the goal card's exit below.
   This one has to come BACK — a rematch puts the strip up again — and a
   transition reverses itself when the class comes off, where an animation
   would need a second one and a second duration to keep in step with. And
   nothing waits on this one, so there is no timer to agree with either. */
.sv-versus-hud.sv-versus-hud-gone { opacity: 0; }
.sv-versus-side { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.sv-versus-score { font-size: 34px; font-weight: 700; line-height: 1; min-width: 1.2ch; text-align: center; transition: transform .25s cubic-bezier(.2,.8,.2,1); }
.sv-versus-score.sv-versus-pop { transform: scale(1.35); }
.sv-versus-sep { width: 3px; height: 30px; border-radius: 2px; background: rgba(232,236,243,0.35); }
/* THE MATCH CLOCK, between the two scores where the separator is — a timed
   match only, hidden outright otherwise so a first-to looks exactly as it
   always did. Tabular figures, or the whole strip shuffles sideways every
   second as the digits change width. */
/* TYPE IS THE TEXT PANEL'S. Every font-size, weight, spacing, colour and
   shadow on a line of text in this sheet is a FALLBACK: the same selector is
   a role in textRoles.js and ui/typography.js restates it from
   CONFIG.textStyles, in a sheet that comes after this one (ensureVersusStyle
   files this sheet underneath it). The numbers here are what the panel's
   Reset snaps back to, transcribed; change them THERE. No "opacity" on a
   roled line, because the role's alpha is in its colour and the two would
   multiply. */
.sv-versus-clock { font-size: 22px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums;
  letter-spacing: .02em; min-width: 5ch; text-align: center; }
.sv-versus-clock[hidden] { display: none !important; }
/* THE LAST TEN SECONDS. It pulses rather than turns red: the strip is already
   two team colours and a third would be a third team. */
.sv-versus-clock.sv-versus-urgent { animation: svVersusTick 1s steps(1, end) infinite; }
@keyframes svVersusTick { 0%, 49% { opacity: 1; } 50%, 100% { opacity: .45; } }
/* THE RUN'S OWN HUD, OFF: the XP track, the level, the score and the clock
   are dead numbers in a match, and the player bars (health, air, fuel — the
   column in the corner or beside the seal) go with them: the strip above
   carries each seal's wheel and air, side by side, and nothing else. */
.sv-versus-mode .sv-xptop, .sv-versus-mode #svCorner, .sv-versus-mode #svPlayerBars { display: none !important; }
/* THE GOAL CARD — no big number. Small type in the lower third, in the
   scoring team's colour: who scored, the assist or the own goal if there
   was one, and the match clock at the goal; the winner's line above it at
   the end. The replay plays over it; the strip takes the score when the
   ball comes back (landScore). */
/* WIDTH: max-content, and it is a fix rather than a tidy. The card is placed
   at left: 50% with no width, so the space a shrink-to-fit box had to lay out
   in was the RIGHT HALF of the screen — the translate that centres it happens
   after layout and buys the line nothing. A name wider than half the viewport
   wrapped, and on a phone held upright that is most of them. Capped at 92vw so
   the widest name still has a margin to sit in. */
/* ---------------------------------------------------------------------------
   THE GLASS — one treatment, worn by the goal card and the highlight tag.
   
   THE TEAM COLOUR MOVED OFF THE TEXT AND ONTO THE PANEL, and that is the whole
   point of it rather than a side effect. Both of these surfaces are composited
   over the moment they are describing: the card comes up ON the goal, which
   blows the scoring team's own colour out of the mouth at full bloom, and the
   highlight tag sits over footage of the same. So the one hue the text could
   not be read against was the team's — the text and the field behind it were
   the same colour, at the same moment, by construction.
   
   Now the panel carries the colour (a wash and a rim) and the text is BLACK.
   Black rather than a dark grey: the glass is a LIGHT panel, so black is the
   most contrast available on it, and unlike any tinted ink it stays exactly as
   readable whatever the wash underneath is doing.
   
   WHY IT IS GLASS AND NOT A CARD. A flat panel over the water is a sticker; it
   hides the thing it is captioning, which on a goal is the only frame worth
   looking at. Refraction keeps the explosion visible THROUGH the label — the
   backdrop is blurred and saturated rather than covered, so the colour of the
   moment still reaches the eye and the words sit on top of it.
   
   THE RGBA COMES FROM JS, not from color-mix(). The team's hex is written onto
   the element as a custom property along with a pre-multiplied wash, so nothing
   here depends on a colour function's browser support in an Electron build and
   a phone browser at once. See cssColor / glassTint.
--------------------------------------------------------------------------- */
.sv-glass {
  position: relative;
  isolation: isolate;
  border-radius: var(--sv-glass-radius, 1.6vmin);
  /* THE ORDER OF THESE TWO IS THE WHOLE RECIPE, and both of them are load
     bearing against a different failure.
     
     THE WHITE IS FIRST-PRINCIPLES A FLOOR, not a veil. A pane that takes its
     lightness from the backdrop is a pane that is only light where the backdrop
     is: over the goal's explosion it read beautifully and over deep water it
     resolved to a muddy (93,71,46) — black type on brown, which is the exact
     failure this was asked to fix, moved rather than fixed. At this alpha the
     THE WEAKEST STOP OF THE GRADIENT IS THE FLOOR, not the average: the pane
     is only as readable as its dimmest corner, and a gradient authored 0.68 /
     0.50 / 0.58 is a 6.5:1 pane wherever that 0.50 lands. At 0.60 the black
     type holds 8.4:1 over the darkest water the pitch has (#06121d) and 15.9:1
     over the goal's own explosion. tools/versus-test.mjs computes both.
     
     THE TINT SITS ON TOP OF THE WHITE, not under it. Under, a frost heavy
     enough to be a floor washes the team's colour out of its own label — the
     pane goes grey and the only thing naming the side is the rim. Over, the
     colour survives the frost and the frost still decides the lightness.
     
     BOTH LAYERS ARE IMAGES, and the tint is a one-stop gradient rather than a
     colour. The background shorthand accepts a colour only as its LAST layer,
     so writing the tint as a colour on top voids the whole declaration and
     leaves a pane with no fill at all — silently, and it looks exactly like a
     pane that was meant to be that faint. As a gradient it can sit in any
     layer and the order below means what it says. */
  background-image:
    linear-gradient(var(--sv-team-wash, transparent), var(--sv-team-wash, transparent)),
    linear-gradient(160deg,
      rgba(255,255,255,var(--sv-glass-frost-lit, .68)),
      rgba(255,255,255,var(--sv-glass-frost, .60)) 46%,
      rgba(255,255,255,var(--sv-glass-frost-far, .65)));
  /* The saturate is what keeps the moment's own colour coming THROUGH a pane
     this frosted: blur alone over a warm explosion is a beige smear, and the
     point of glass over a goal is that you can still tell what colour the goal
     was. */
  /* EVERY NUMBER IN THIS RULE IS A CUSTOM PROPERTY WITH THE SHIPPED VALUE AS
     ITS FALLBACK. CONFIG.glass is the design (see the block there); this sheet
     is injected once at boot and a slider has to move a pane that is already on
     screen, so applyGlassStyle writes the properties onto the document rather
     than rebuilding this rule. The fallbacks are what the pane looks like
     before that runs, and on any surface mounted without it. */
  -webkit-backdrop-filter: blur(var(--sv-glass-blur, 16px)) saturate(var(--sv-glass-sat, 1.9)) brightness(var(--sv-glass-bright, 1.08));
  backdrop-filter: blur(var(--sv-glass-blur, 16px)) saturate(var(--sv-glass-sat, 1.9)) brightness(var(--sv-glass-bright, 1.08));
  border: 1px solid rgba(255,255,255,.42);
  /* The specular edge. A bright lip along the top and a dimmer one under it is
     what makes a pane read as having THICKNESS rather than as a rectangle of
     blur; the outer shadow is what lifts it off the water. */
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.72),
    inset 0 -1px 0 rgba(255,255,255,.20),
    inset 0 0 0 1px var(--sv-team-rim, rgba(255,255,255,.16)),
    0 1.2vmin 3vmin rgba(4,8,14,.42);
}
/* THE LIQUID. A soft highlight travelling across the pane — the one thing that
   separates glass from frosted plastic is that the light on it MOVES. Slow and
   wide on purpose: a fast sheen is a loading spinner, and this is a label that
   is up for two seconds.
   Clipped to the pane's own radius and behind the text (z-index), so it can
   never wash out the words it is under. */
.sv-glass::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  pointer-events: none;
  background: linear-gradient(105deg,
    transparent 30%, rgba(255,255,255,var(--sv-glass-sheen-peak, .30)) 46%, rgba(255,255,255,.06) 60%, transparent 72%);
  background-size: 260% 100%;
  animation: svGlassSheen var(--sv-glass-sheen, 5.5s) ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) { .sv-glass::after { animation: none; } }
@keyframes svGlassSheen { from { background-position: 130% 0; } to { background-position: -30% 0; } }

.sv-versus-card { position: absolute; left: 50%; top: 72%; transform: translate(-50%, -50%); width: max-content; max-width: 92vw; text-align: center; opacity: 0; letter-spacing: .02em;
  --sv-glass-radius: 2vmin; padding: 1.6vmin 2.8vmin; color: #05070a; }
/* A NAME IS ONE THING. It has a space in it, and a space is where a line
   breaks — so the assist line's one legal break was through the middle of the
   seal it was crediting. See paintLine. */
.sv-versus-name { white-space: nowrap; }
.sv-versus-card.sv-versus-in { animation: svVersusPop .32s cubic-bezier(.2,.9,.2,1.2) forwards; }
/* THE CARD LEAVING AT THE WHISTLE. See dismissCard for why this one exit gets
   a curve and the rest of them cut.
   IT SINKS RATHER THAN RISING, and that is the opposite of what the card used
   to do here (it climbed to 26% and stayed). Up is where the stats page is
   about to come from; a card drifting up into it is two things moving into the
   same space. Down and slightly smaller reads as the caption settling out of
   the way of what comes next. Keep .34s in step with CARD_OUT_MS. */
.sv-versus-card.sv-versus-out { animation: svVersusCardOut .34s cubic-bezier(.4,0,.55,1) forwards; }
/* NO DARK TEXT-SHADOW ON ANY OF THESE. The shadows were what made light text
   survive on open water; on a light pane they are a smudge under black type,
   and they were the first thing to read as dirt rather than as depth. */
.sv-versus-card-name { font-size: 3.6vmin; font-weight: 700; line-height: 1.2; white-space: nowrap; }
/* SET BACK, BUT NOT MUCH. These were dimmed against a light-on-water card;
   black on a light pane is already quiet, and the same fractions took the
   clock under the contrast the pane was built to guarantee. */
.sv-versus-card-line { font-size: 2.4vmin; font-weight: 600; margin-top: .4vmin; }
.sv-versus-card-time { font-size: 2.4vmin; font-weight: 600; margin-top: .4vmin; font-variant-numeric: tabular-nums; }
.sv-versus-card-line:empty { display: none; }
/* THE NAMES OVER THE SEALS. A layer of absolutely placed labels, each moved by
   a transform rather than by top/left — a transform is composited and does not
   put the label through layout, which matters when eight of them move every
   frame. Deaf to the pointer: this is a caption on the water, not a control. */
.sv-versus-tags { position: absolute; inset: 0; pointer-events: none; }
.sv-versus-tags[hidden] { display: none !important; }
.sv-versus-tag { position: absolute; left: 0; top: 0; white-space: nowrap;
  font-size: max(9px, 1.1vmin); font-weight: 700; letter-spacing: .02em;
  text-shadow: 0 0 6px rgba(0,0,0,.9), 0 1px 3px rgba(0,0,0,.8); }
.sv-versus-tag[hidden] { display: none !important; }
/* THE ONE YOU ARE DRIVING. Not a different colour — the two colours on this
   screen are the two sides, and a third would read as a third team. A shade
   larger and brighter, with the caret that says it out loud; the rim on the
   animal itself is the louder half of the same statement. */
.sv-versus-tag-you { font-size: max(10px, 1.3vmin); filter: brightness(1.35); }
.sv-versus-tag-you::before { content: '\u25B8'; margin-right: .3em; opacity: .9; }
.sv-versus-count { position: absolute; left: 50%; top: 42%; transform: translate(-50%, -50%); text-align: center; opacity: 0; font-size: 26vmin; font-weight: 800; line-height: 1; text-shadow: 0 0 24px rgba(0,0,0,.45); }
.sv-versus-count.sv-versus-go { font-size: 16vmin; }
/* THE PROMPT after a match is NOT HERE ANY MORE. It was a centred panel of
   two buttons with a scrim of its own, at this layer's only pointer-taking
   element — and the Blubberball stats page (ui/statsCard.js) then mounted on
   top of it, so the thing being asked was behind an artboard. The prompt is
   drawn by that artboard now; all this rule set did by the end was style a
   panel nobody could reach.
   AND THE CARD DOES NOT LIFT OUT OF ITS WAY ANY MORE, because it is not there
   to be in the way: a rule here moved it to 26% and left it parked over the
   page. It is dismissed at the whistle now (showOver, dismissCard). */
/* THE MATCHUP, under the kickoff count — both sides by name, each in its own
   kit colour, for the three seconds before the whistle of the OPENING kickoff.
   It is the one moment in a match with nothing else happening in it: the world
   is held at a crawl, the seals are on their marks, and the only thing on
   screen is a numeral. See showTeams.

   A COLUMN, NOT A ROW, and that is a phone decision rather than a taste one. A
   team name is up to 34 characters (MAX_TEAM_NAME_LEN) and two of them side by
   side with a word between them is 70 characters of nowrap type: measured at
   375px it left the screen by a hundred pixels in each direction. Stacked, the
   card is as wide as its widest single name and cannot overflow whatever the
   table is rolling.

   UNDER THE NUMERAL RATHER THAN OVER IT. The strip is at the top of the screen
   and the count is at 42%; the room between the count and the goal card's 72%
   is the only band on this screen with nothing in it at kickoff. Above it, at
   the sizes a phone held sideways gives, the card and the score strip were
   drawing over each other. */
.sv-versus-teams { position: absolute; left: 50%; top: 68%; transform: translate(-50%, -50%);
  display: flex; flex-direction: column; align-items: center; gap: .6vmin;
  max-width: 92vw; text-align: center; pointer-events: none; opacity: 0; }
.sv-versus-teams[hidden] { display: none !important; }
.sv-versus-teams.sv-versus-in { animation: svVersusPop .42s cubic-bezier(.2,.9,.2,1.2) forwards; }
/* Each name is one line and is CUT rather than wrapped: the card is a caption,
   and a name that wrapped would push the other side's off its own line. */
.sv-versus-teams-name { font-size: max(15px, 3.4vmin); font-weight: 800; line-height: 1.15; letter-spacing: .02em;
  max-width: 92vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  text-shadow: 0 0 14px rgba(0,0,0,.75), 0 2px 8px rgba(0,0,0,.6); }
/* The word between them, and it is deliberately the quiet part: the names are
   what is being announced. */
/* NO opacity DECLARATION HERE — the alpha is in the colour, for the reason the
   note at
   top of this sheet gives: this selector is a role (vsTeamVs), and a role that
   writes its own alpha would multiply with an opacity set here. */
.sv-versus-teams-vs { font-size: max(11px, 2vmin); font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
  color: rgba(232,236,243,.8); text-shadow: 0 0 12px rgba(0,0,0,.7); }
.sv-versus-count.sv-versus-in { animation: svVersusCount .5s cubic-bezier(.2,.9,.2,1.2) forwards; }
/* THE REPLAY'S TAG, top left, with the skip prompt and its hold bar under it. */
.sv-versus-replay { position: absolute; top: 14px; left: 16px; display: flex; flex-direction: column; gap: 6px;
  --sv-glass-radius: 10px; padding: 8px 14px; color: #05070a; }
.sv-versus-replay[hidden] { display: none !important; }
.sv-versus-replay-tag { font-size: 18px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
/* No opacity here: paintSkip writes it per frame (0.7 → 1 as the hold lands). */
.sv-versus-replay-skip { font-size: 12px; font-weight: 600; }
/* The reel's version of that corner: the tag alone. There is nothing to skip
   — the reel IS the screen until the prompt over it is answered. */
.sv-versus-reel .sv-versus-replay-skip, .sv-versus-reel .sv-versus-replay-bar { display: none; }
.sv-versus-reel .sv-versus-replay-tag { font-size: max(13px, 1.6vmin); }
.sv-versus-replay-bar { width: 96px; height: 4px; border-radius: 2px; background: rgba(5,7,10,0.22); overflow: hidden; }
/* THE TEAM COLOUR, not currentColor. The text on this pane is black now, and a
   fill that followed it would be a black bar in a black groove. */
.sv-versus-replay-bar > i { display: block; height: 100%; width: 0; border-radius: 2px; background: var(--sv-team, currentColor); }
@keyframes svVersusCount { from { opacity: 0; transform: translate(-50%, -50%) scale(1.6); } 30% { opacity: 1; transform: translate(-50%, -50%) scale(1); } to { opacity: 1; transform: translate(-50%, -50%) scale(.92); } }
@keyframes svVersusPop { from { opacity: 0; transform: translate(-50%, -50%) scale(.4); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
@keyframes svVersusCardOut { from { opacity: 1; transform: translate(-50%, -50%) scale(1); } to { opacity: 0; transform: translate(-50%, -34%) scale(.92); } }
`;

function cssColor(n) { return '#' + (n >>> 0).toString(16).padStart(6, '0'); }

/**
 * DRESS ONE PANE IN A TEAM'S COLOUR — see the .sv-glass block in the stylesheet.
 *
 * The colour goes on the GLASS, not on the text: both of these surfaces are
 * composited over the moment they describe, and the goal blows the scoring
 * team's own colour out of the mouth at full bloom, so team-coloured type sat
 * on a field of the same hue by construction. The words are black on the pane
 * and the pane is the team's.
 *
 * WRITTEN AS rgba() RATHER THAN LEFT TO color-mix(). This ships to an Electron
 * build, a desktop browser and a phone at once, and a colour function that is
 * missing in any one of them is a label with no tint at all — which looks
 * exactly like a team having no colour rather than like a feature not landing.
 *
 * `null` takes the dressing off, for a pane with no team to wear.
 */
function glassTint(el, hex) {
  if (!el?.style) return;
  if (hex == null) {
    el.style.removeProperty('--sv-team');
    el.style.removeProperty('--sv-team-wash');
    el.style.removeProperty('--sv-team-rim');
    return;
  }
  const n = hex >>> 0;
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  el.style.setProperty('--sv-team', `rgb(${r},${g},${b})`);
  // The WASH is what the pane is tinted with and the RIM is the inner line
  // round it. The rim is the stronger of the two on purpose: a tint heavy
  // enough to name a side is a tint heavy enough to start competing with the
  // black type on it, and an edge says the same thing without touching the
  // middle of the pane at all.
  // The two alphas are CONFIG.glass's — the same block the frost and the blur
  // come from — because "how much of the team's colour is on the pane" is a
  // question about the glass, not about the team. They are written per ELEMENT
  // rather than on the root like the rest: the hue is this pane's, and two
  // panes can be up in two different colours at once (the card and the replay
  // tag, after a goal at the far end).
  const glass = CONFIG.glass ?? {};
  el.style.setProperty('--sv-team-wash', `rgba(${r},${g},${b},${clamp01(glass.wash ?? 0.26)})`);
  el.style.setProperty('--sv-team-rim', `rgba(${r},${g},${b},${clamp01(glass.rim ?? 0.55)})`);
}

function mountUi() {
  if (typeof document === 'undefined' || !document.body?.appendChild) return;
  const colors = (goalColors()).map(cssColor);
  if (!ui) {
    ensureVersusStyle();
    const root = document.createElement('div');
    root.className = 'sv-versus';
    root.innerHTML = `
      <div class="sv-versus-band">
        <div class="sv-versus-hud">
          <div class="sv-versus-side" style="color:${colors[0]}"><div class="sv-versus-score" data-p="0">0</div></div>
          <div class="sv-versus-clock" hidden></div>
          <div class="sv-versus-sep"></div>
          <div class="sv-versus-side" style="color:${colors[1]}"><div class="sv-versus-score" data-p="1">0</div></div>
        </div>
      </div>
      <div class="sv-versus-card sv-glass"><div class="sv-versus-card-name"></div><div class="sv-versus-card-line"></div><div class="sv-versus-card-time"></div></div>
      <div class="sv-versus-tags" hidden></div>
      <div class="sv-versus-count"></div>
      <div class="sv-versus-teams" hidden><div class="sv-versus-teams-name" data-t="0"></div><div class="sv-versus-teams-vs"></div><div class="sv-versus-teams-name" data-t="1"></div></div>
      <div class="sv-versus-replay sv-glass" hidden><div class="sv-versus-replay-tag"></div><div class="sv-versus-replay-skip"></div><div class="sv-versus-replay-bar"><i></i></div></div>
`;
    document.body.appendChild(root);
    ui = {
      root,
      band: root.querySelector('.sv-versus-band'),
      hud: root.querySelector('.sv-versus-hud'),
      sides: [...root.querySelectorAll('.sv-versus-side')],
      clock: root.querySelector('.sv-versus-clock'),
      scores: [...root.querySelectorAll('.sv-versus-score')],
      card: root.querySelector('.sv-versus-card'),
      cardName: root.querySelector('.sv-versus-card-name'),
      cardLine: root.querySelector('.sv-versus-card-line'),
      cardTime: root.querySelector('.sv-versus-card-time'),
      count: root.querySelector('.sv-versus-count'),
      teams: root.querySelector('.sv-versus-teams'),
      teamNames: [...root.querySelectorAll('.sv-versus-teams-name')],
      teamsVs: root.querySelector('.sv-versus-teams-vs'),
      tagLayer: root.querySelector('.sv-versus-tags'),
      // One per SEAT, built once and moved — see updateNameTags. MAX_PER_SIDE
      // a side, so a roster grown mid-session never has to build one mid-frame.
      tags: Array.from({ length: MAX_PER_SIDE * 2 }, () => {
        const t = document.createElement('div');
        t.className = 'sv-versus-tag';
        t.hidden = true;
        return t;
      }),
      replay: root.querySelector('.sv-versus-replay'),
      replayTag: root.querySelector('.sv-versus-replay-tag'),
      replaySkip: root.querySelector('.sv-versus-replay-skip'),
      replayBar: root.querySelector('.sv-versus-replay-bar > i'),
      colors,
    };
    for (const t of ui.tags) ui.tagLayer.appendChild(t);

    // THE TWO THINGS THAT CHANGE THE FIT WITHOUT CHANGING THE STRIP.
    //
    // Inside the `if (!ui)` block, so they are bound once for the life of the
    // page: this element is built on the first match and reused by every one
    // after it, and a listener added per mount is a listener added per rematch.
    //
    // A rotation crosses the whole question in one event — a strip that fits a
    // phone held sideways is 62px too wide the moment it is stood up — and
    // nothing else was going to re-ask, because paintClock's key only sees the
    // window through the band's room and a first-to match never ticks a clock
    // at all.
    window.addEventListener('resize', fitStrip);
    // ...AND THE FONT LANDING. The strip is measured in whatever face is
    // loaded, and the roled one (Orbitron, see textRoles.js) arrives after the
    // first paint — so a fit computed in the fallback is a fit for type that is
    // not on the screen. Both hooks for the reason ui.js gives at fitLabels:
    // `fonts.ready` settles for the faces the document was asking for at the
    // time, and initTypography may request this one after that has resolved.
    //
    // The key has to be cleared by hand: nothing in it moved, and without this
    // the guard would refuse the one re-measure that matters.
    const refit = () => { stripFitKey = ''; fitStrip(); };
    document.fonts?.ready?.then(refit);
    document.fonts?.addEventListener?.('loadingdone', refit);
  }
  // THE COLOURS ARE THIS MATCH'S, not the first match's: the team select
  // picks them (versusSetup, read through goalColors), and a HUD strip that
  // kept the colours it was born with would call the green team red.
  ui.colors = colors;
  ui.sides.forEach((node, i) => { node.style.color = colors[i]; });
  ui.root.hidden = false;
  document.body.classList.add('sv-versus-mode');
  hideCard();
  paintScores();
}

function hideUi() {
  if (typeof document !== 'undefined' && document.body?.classList) document.body.classList.remove('sv-versus-mode');
  hideOver();
  showReelUi(null);
  if (!ui) return;
  ui.root.hidden = true;
  hideCard();
  hideCount();
  if (ui.replay) ui.replay.hidden = true;
}

/**
 * THE HUD'S STYLESHEET, in the head — once, by id, and filed UNDER the Text
 * panel's role sheet rather than appended after it.
 *
 * Appended, it landed after the role sheet (the HUD mounts on the first
 * match, the role sheet at boot), and a rule here of the same specificity as
 * a role's beat the role's for the same selector: the panel wrote a size for
 * the countdown, saved it to disk, and every match kept drawing 26vmin. See
 * installStyleBelowRoles.
 *
 * Exported for the Text panel's specimen, which wears `.sv-glass` to show the
 * goal card's black type on the pane it is read on — and needs this sheet in
 * the head before any match has been played.
 */
export function ensureVersusStyle() {
  if (typeof document === 'undefined' || !document.head) return;
  installStyleBelowRoles('svVersusStyle', STYLE);
  // The glass's own numbers, with the sheet. Here rather than at the card's
  // mount because the first pane on screen is usually not the card: main.js
  // calls this at boot so the Text panel's specimen can wear the real rule, and
  // a specimen with no properties written would be showing the fallbacks.
  applyGlassStyle();
}

/**
 * THE LIQUID GLASS, from CONFIG.glass onto the document.
 *
 * AS CUSTOM PROPERTIES, NOT AS A REBUILT RULE. The stylesheet goes into the
 * head once; every pane wearing .sv-glass is already laid out by the time a
 * slider moves, and rewriting the sheet under them would restart the sheen on
 * every step of the drag. Properties on the root element are inherited by
 * panes that exist and panes that do not exist yet, which is exactly the two
 * cases there are.
 *
 * THE STOPS ARE DERIVED FROM ONE NUMBER. `frost` is the WEAKEST stop — the
 * dimmest corner, the one that decides whether black type is readable on the
 * pane — and the other two are it plus a lift. So the slider that matters moves
 * the whole fill and keeps the modelling, rather than lighting one corner and
 * leaving the readable floor where it was.
 *
 * Called at boot (ensureVersusStyle) and from main.js on any `glass` edit.
 */
export function applyGlassStyle() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!root?.style) return;
  const g = CONFIG.glass ?? {};
  const frost = clamp01(g.frost ?? 0.6);
  const set = (name, value) => root.style.setProperty(name, value);
  set('--sv-glass-blur', `${Math.max(0, g.blur ?? 16)}px`);
  set('--sv-glass-sat', String(Math.max(0, g.saturate ?? 1.9)));
  set('--sv-glass-bright', String(Math.max(0, g.brightness ?? 1.08)));
  set('--sv-glass-frost', frost.toFixed(3));
  set('--sv-glass-frost-lit', clamp01(frost + (g.frostLift ?? 0.08)).toFixed(3));
  set('--sv-glass-frost-far', clamp01(frost + (g.frostTail ?? 0.05)).toFixed(3));
  set('--sv-glass-sheen', `${Math.max(0.1, g.sheen ?? 5.5)}s`);
  set('--sv-glass-sheen-peak', clamp01(g.sheenPeak ?? 0.3).toFixed(3));
}

// ---------------------------------------------------------------------------
// PREVIEWING THE MATCH'S SURFACES — dev only, for the Text panel (Y).
//
// Type is judged in place or not at all, and every line of this mode's UI
// is up for two seconds at a moment you cannot arrange while your other
// hand is on a slider: the countdown lasts three seconds, the goal card
// needs a goal, the prompt needs a match to have ended. So the panel can put
// each of them up with invented state and hold it there.
//
// NONE OF THIS TOUCHES THE MATCH. It writes the DOM the real paint functions
// write and nothing in versusState — no scores, no clock, no goal credit —
// and it refuses to run over a live match at all, because a HUD showing 2-1
// while the game thinks it is 0-0 is a lie with the pointer on it.
//
// `name` is one of PREVIEW_MATCH_SCREENS. The words on every surface are the
// real uiText rows; the NAMES are the roster's cast (rosterCast), so what
// appears is what a goal card would actually say.
// ---------------------------------------------------------------------------
export const PREVIEW_MATCH_SCREENS = ['match HUD', 'goal card', 'match over'];

export function previewVersusUi(name) {
  if (versusState.active) return false;
  mountUi();
  if (!ui) return false;
  ui.root.classList.add('sv-versus-preview');
  hideOver();
  showReelUi(null);
  hideCard();
  hideCount();
  ui.replay.hidden = true;
  ui.clock.hidden = false;
  ui.clock.textContent = '2:47';
  ui.clock.classList.remove('sv-versus-urgent');
  ui.scores[0].textContent = '2';
  ui.scores[1].textContent = '1';
  // WRITTEN BY HAND HERE, so the painters that normally call fitStrip never
  // run — and a preview measured at full size on a phone tile is exactly the
  // overhang this fit exists to remove, reported by `npm run layout` against a
  // screen the game itself would have fitted.
  fitStrip();
  // The cast the match would use, so the card shows a real roster name.
  syncRosterCast();
  const scorer = seatName(0);
  const assist = seatName(2) || seatName(1);
  if (name === 'match HUD') {
    // The kickoff numeral, held. A real count pops "3", "2", "1" and the
    // whistle in turn; here it is the numeral alone so its size can be read
    // against the strip above it.
    showCount('3');
    // ...and the matchup under it, which is the other half of what this screen
    // shows at kickoff. Cast here for the same reason the match-over preview
    // casts: there is no match, so nothing has named the sides yet.
    castTeamNames([teamColor(0), teamColor(1)]);
    showTeams();
  } else if (name === 'goal card') {
    glassTint(ui.card, goalColors()[0]);
    ui.cardName.textContent = scorer;
    paintLine(ui.cardLine, uiText('versusAssist'), assist);
    ui.cardTime.textContent = '1:52';
    ui.card.classList.add('sv-versus-in');
    // The replay's own corner, with the hold bar part-filled so the skip
    // line is at the brightness it has while a button is down.
    glassTint(ui.replay, goalColors()[0]);
    ui.replay.classList.remove('sv-versus-reel');
    ui.replay.hidden = false;
    ui.replayTag.textContent = uiText('versusReplay');
    ui.replaySkip.textContent = uiText('versusReplaySkip');
    paintSkip(0.45);
  } else if (name === 'match over') {
    // NO GOAL CARD HERE. It used to be shown at the height it rose to at the
    // whistle — and it does not rise any more, it is dismissed (showOver,
    // dismissCard), so a preview that drew it would be showing a screen the
    // match cannot produce. The card's own words have their screen already:
    // it is 'goal card' above, which is where a goal's caption is read. The
    // hideCard at the top of this function is what leaves it down.
    // THE PROMPT IS THE STATS PAGE and the stats page is a match's, so there
    // is none here: this preview exists to look at the CARD's words, and the
    // page has its own (ui/statsCopy.js) written from the same table. What
    // used to be on this line was `ui.over.hidden = false` — a DOM prompt that
    // no longer exists, so the preview threw before it drew anything.
    // The reel's tag, as it sits under the prompt while a highlight loops.
    glassTint(ui.replay, goalColors()[1]);
    ui.replay.classList.add('sv-versus-reel');
    ui.replay.hidden = false;
    ui.replayTag.textContent = uiText('versusReelCheck');
    ui.replaySkip.textContent = '';
  }
  return true;
}

/** Take a preview down. A no-op over a live match, like the preview itself. */
export function hideVersusPreview() {
  if (versusState.active || !ui) return;
  ui.root.classList.remove('sv-versus-preview');
  hideUi();
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
  // The matchup goes with the numerals it was announcing — hideCount runs when
  // the whistle's line finishes, so the card is up for the whole countdown and
  // the "Go!" that ends it, and is gone the frame play is live on its own.
  hideTeams();
}

/**
 * THE MATCHUP, announced under the kickoff count — both sides by the names
 * cast at the whistle (systems/teamNameCast.js), each in its kit colour.
 *
 * THE OPENING KICKOFF ONLY, and the caller is what decides that rather than a
 * check in here: every kickoff after a goal is a restart of a match already
 * introduced, and a card that re-announced the same two teams four times would
 * be the screen repeating itself at the one moment a player is waiting to move.
 *
 * A SIDE WITH NO NAME TAKES THE WHOLE CARD DOWN, both of them — a table that
 * can build nothing (see teamNameTable.js) should leave the kickoff exactly as
 * it was, not put up half an announcement.
 */
function showTeams() {
  if (!ui) return;
  const names = [teamName(0), teamName(1)];
  if (!names[0] || !names[1]) { hideTeams(); return; }
  const colors = goalColors();
  ui.teamNames.forEach((node, i) => {
    node.textContent = names[i];
    // INLINE, like the score above it: the colour is this match's pick and the
    // stylesheet's job here is the size and the weight. See the vsTeamName role
    // in textRoles.js, which is `inlineColor` for the same reason.
    node.style.color = cssColor(colors[i]);
  });
  ui.teamsVs.textContent = uiText('versusKickoffVs');
  ui.teams.hidden = false;
  ui.teams.classList.remove('sv-versus-in');
  void ui.teams.offsetWidth;
  ui.teams.classList.add('sv-versus-in');
}

function hideTeams() {
  if (!ui) return;
  ui.teams.classList.remove('sv-versus-in');
  ui.teams.hidden = true;
}

/**
 * THE CLOCK ON THE STRIP. Ticked every frame while a timed match is on, and
 * hidden outright otherwise — a first-to has no clock and an empty slot where
 * one would be is a thing players look for.
 *
 * The floor, not the round: a clock reading 1:00 with half a second left is
 * lying about the half second that is still playable, and the number every
 * player is watching for is 0:00 arriving exactly when the whistle does.
 */
function paintClock() {
  if (!ui?.clock) return;
  const on = versusState.active && isTimed();
  ui.clock.hidden = !on;
  if (!on) return;
  const left = Math.max(0, timeLeft());
  const whole = Math.floor(left);
  const mm = Math.floor(whole / 60);
  const ss = whole % 60;
  ui.clock.textContent = `${mm}:${String(ss).padStart(2, '0')}`;
  ui.clock.classList.toggle('sv-versus-urgent', left <= 10 && left > 0);
  // Free unless the strip's shape or the window actually changed — see the key.
  fitStrip();
}

// ---------------------------------------------------------------------------
// THE STRIP, FITTED TO THE SCREEN.
//
// MEASURED, BECAUSE CSS CANNOT ASK THE QUESTION. "Is this row wider than the
// window" needs a layout engine, and there is no media query for it — the width
// depends on the tuned type, the font that actually loaded, and how many digits
// are currently on the clock. The same answer ui.js reaches for in fitLabels and
// fitNameField, for the same reason.
//
// offsetWidth, NOT getBoundingClientRect(). The rect is the box AFTER the
// transform, so reading it would measure the strip at whatever scale it is
// already wearing and converge on a strip that shrinks a little more every time
// anything resizes. offsetWidth is the layout width and is blind to the
// transform, which is exactly what has to be divided into the room available.
//
// AIR EITHER SIDE OF THE STRIP, AND NOTHING ELSE. The safe area used to be in
// this number: `env()` is not readable from script, so it was 20px standing in
// for a landscape notch as well, which was a guess and the wrong one — the
// inset on an iPhone held sideways is about 59px, so the strip was fitted to a
// width that ran under the Dynamic Island and then centred in it. The band the
// strip now sits in carries the real insets (see .sv-versus-band in the sheet)
// and hands them over as a layout read, so this is back to being what it says:
// a margin, so the strip does not touch the edge of what is visible.
const STRIP_GUTTER = 20;

// What the answer depends on. Recomputed only when one of these moves, because
// paintClock runs every frame and a layout read per frame on a phone is the
// kind of cost that does not show up until the thing is already shipped.
// The ROOM is in the key so a resize really does re-ask — and it is the band's
// room rather than the window's, so a rotation that moves the notch from the
// top edge to the side re-asks as well, on a window whose width alone would
// have said the same thing twice. The glyph COUNTS rather than the text,
// because the clock is tabular-nums and 3:07 is exactly as wide as 2:47 — it
// is 12:07 gaining a digit that moves anything.
let stripFitKey = '';

function fitStrip() {
  if (!ui?.hud) return;
  // THE ROOM IS THE BAND'S, NOT THE WINDOW'S. On a phone with a Dynamic
  // Island held on its side, ~59px of the window is behind the pill, and a
  // strip fitted to the window is a strip fitted to a width that includes it.
  // The band is the window minus the insets (see the sheet) and the browser
  // has already resolved them, so this is a plain layout read.
  const room = Math.max(1, (ui.band?.clientWidth || window.innerWidth) - STRIP_GUTTER * 2);
  const key = `${room}|${ui.clock.hidden ? '' : ui.clock.textContent.length}`
    + `|${ui.scores[0].textContent.length}|${ui.scores[1].textContent.length}`;
  if (key === stripFitKey) return;
  stripFitKey = key;
  // Cleared before measuring, or the natural width is being read off a strip
  // that is already scaled — see the offsetWidth note above. offsetWidth itself
  // ignores the transform, but the property is cleared anyway so that a strip
  // that somehow ended up display:none-adjacent, or whose children scale, can
  // never feed its own output back in.
  ui.hud.style.removeProperty('--sv-vs-fit');
  const natural = ui.hud.offsetWidth;
  // A strip with no width has not been laid out yet — it is hidden, or the
  // roled font has not landed. Leaving it at 1 is the right way to be wrong:
  // full size and possibly overhanging beats a strip scaled to nothing by a
  // measurement taken before there was anything to measure.
  if (natural < 1) return;
  const fit = Math.min(1, room / natural);
  // Only when it actually has to shrink. Writing 1 would put a transform on the
  // strip on every desktop for no reason, and a scaled layer is a layer the
  // compositor rasterises separately.
  if (fit < 0.999) ui.hud.style.setProperty('--sv-vs-fit', fit.toFixed(4));
}

function paintScores() {
  if (!ui) return;
  ui.scores[0].textContent = String(versusState.scores[0]);
  ui.scores[1].textContent = String(versusState.scores[1]);
  // A tenth goal is a second digit on that side, which is the one thing besides
  // the clock and the window that can widen the strip.
  fitStrip();
}

// THE STRIP CARRIED TWO BARS PER SIDE, AND THEY ARE GONE.
//
// Under each score sat a fuel bar and a thinner air bar. Both were true when a
// match was one seal against one seal; neither survived the roster.
//
//   THEY READ TWO SEALS OUT OF EIGHT. The fuel came from strikeState (seat 0)
//   and p2.charge (seat 1) and the air from player.oxygen and p2.oxygen —
//   seat 0 and seat 1, always. Four a side and the bar over the orange score
//   was one orange seal's lungs presented as the side's, which is worse than
//   no reading: it is a reading you can act on and be wrong.
//
//   AND EVERY SEAL ALREADY WEARS BOTH. The fuel is the ring of pips around
//   the animal and the air is the band inside it (systems/strikeRing.js,
//   updateSeatRings above) — on every seat a person is driving, where the eye
//   already is. The strip was the same two numbers a second time, smaller,
//   further away, and for two of the players only.
//
// The clock and the two scores stay: those ARE the side's, and there is one
// of each. Everything in the strip is now a fact about the match rather than
// about whoever happens to be sitting in the first seat of a team.


/**
 * A CARD LINE WITH A NAME IN IT — the copy row, with {name} filled by a piece
 * that CANNOT BREAK.
 *
 * A name is two words with a space in it ("Chubby Brathwaite"), and a space is
 * exactly where a browser breaks a line. So the one place the assist line was
 * allowed to wrap was through the middle of the seal being credited, which
 * reads as two seals. The sentence around it may still wrap if it has to; the
 * name is one thing and is laid out as one.
 *
 * BUILT AS NODES, not as innerHTML with a span in it. Names reach here from
 * sealNames.csv and from the field on the splash, and while both are sanitised
 * (systems/playerName.js) the sanitiser is the LEADERBOARD's rule and not a
 * promise about markup — a name is text, so it is written as text.
 */
function paintLine(el, template, name) {
  el.textContent = '';
  const parts = String(template ?? '').split('{name}');
  parts.forEach((part, i) => {
    if (i > 0) {
      const tag = document.createElement('span');
      tag.className = 'sv-versus-name';
      tag.textContent = name || '';
      el.appendChild(tag);
    }
    if (part) el.appendChild(document.createTextNode(part));
  });
}

/**
 * The goal card: the scorer's name, the assist or own goal if there was one,
 * the clock — and the winner's line at the end. The lines are copy rows
 * (uiText: versusAssist and versusOwnGoal take {name}); the name and the
 * clock are data.
 */
function showCard(scorer, won, pop = true) {
  if (!ui) return;
  const el = ui.card;
  const credit = versusState.lastGoal?.credit ?? creditGoal(scorer);
  // The team's colour dresses the PANE; the text on it stays black. See
  // glassTint and the .sv-glass block.
  glassTint(el, goalColors()[scorer]);
  // THIS CARD NAMES THE SEAL, ALWAYS — including the goal that wins the match.
  //
  // It used to turn into the champion card on that last goal: the winning
  // SIDE's name in place of the scorer's, and the assist line cleared because
  // "Assisted by Pete" under a team name credits a pass to nobody. Who won is
  // the stats page's line now (the champion block, ui/statsCard.js), so this
  // card is free to go on being what it is — and the match-winning goal keeps
  // the caption every other goal got, which is the one goal that most deserves
  // it. The result and the moment are two things, and they are on two surfaces
  // instead of fighting over one.
  ui.cardName.textContent = credit.name || '';
  if (credit.ownGoal) paintLine(ui.cardLine, uiText('versusOwnGoal'), credit.name);
  else if (credit.assist >= 0) paintLine(ui.cardLine, uiText('versusAssist'), credit.assistName);
  else ui.cardLine.textContent = '';
  ui.cardTime.textContent = credit.time ?? '';
  if (pop) {
    el.classList.remove('sv-versus-in');
    void el.offsetWidth; // restart the pop
    el.classList.add('sv-versus-in');
  } else if (!el.classList.contains('sv-versus-in')) {
    // Asked not to pop, but nothing is on screen to repaint — a skip that
    // landed before the card ever went up. Show it rather than leaving the
    // goal uncaptioned.
    el.classList.add('sv-versus-in');
  }
  // The end state paints the strip too, so the score agrees with the card.
  if (won) paintScores();
}

function hideCard() {
  if (!ui) return;
  clearTimeout(cardOut);
  cardOut = null;
  ui.card.classList.remove('sv-versus-in', 'sv-versus-out');
  ui.card.style.opacity = '0';
}

// The pending end of a dismissal, so a card taken down another way mid-fade
// (a rematch pressed while it is still going) does not get put back at
// opacity 0 by a timer that outlived it — hideCard clears this.
let cardOut = null;

/** How long .sv-versus-out runs, in step with the sheet below. */
const CARD_OUT_MS = 340;

/**
 * THE CARD, DISMISSED — the same end as hideCard, reached over a third of a
 * second instead of between two frames.
 *
 * WHY THIS ONE FADES AND THE OTHERS CUT. Every other time the card goes, the
 * match is moving: the ball is back at centre, the count is on screen, the
 * water is up to speed, and a cut is invisible under all of it. The whistle is
 * the one exit with nothing else happening — the world is held at four percent
 * and the card is the only thing on screen that is about to change. A cut
 * there is a frame of the card and then a frame without it, which reads as a
 * dropped frame rather than as an ending.
 *
 * NOT PLAYED OVER A CARD THAT IS NOT UP. An animation that starts from
 * `opacity: 1` on a hidden element FADES IT IN and leaves it there at the end
 * of the hold — the card would appear at the whistle of a timed match, which
 * is the one match that has no card to dismiss. So the state is checked and
 * the plain cut is the answer when there is nothing to take out.
 */
function dismissCard() {
  if (!ui) return;
  const el = ui.card;
  if (!el.classList.contains('sv-versus-in')) { hideCard(); return; }
  clearTimeout(cardOut);
  el.classList.remove('sv-versus-in');
  void el.offsetWidth; // the pop's `forwards` fill has to be dropped first
  el.classList.add('sv-versus-out');
  cardOut = setTimeout(() => { cardOut = null; hideCard(); }, CARD_OUT_MS);
}

/**
 * THE NUMBER CHANGES, WITH A POP. Called from goal() on the frame the goal
 * registers — not at the end of the shutter, and emphatically not after the
 * replay, whose whole duration the shutter's clock is parked for.
 */
function popScore(scorer) {
  if (!ui) return;
  paintScores();
  const el = ui.scores[scorer];
  if (!el) return;
  el.classList.remove('sv-versus-pop');
  void el.offsetWidth;
  el.classList.add('sv-versus-pop');
  setTimeout(() => el.classList.remove('sv-versus-pop'), 260);
}

/**
 * THE CARD GOES as the ball comes back and the match returns to a kickoff.
 * The score is not this function's business any more — it went up with the
 * goal (see popScore) — but the repaint is left in as the belt to that brace:
 * it is idempotent, and a strip that somehow missed the goal's own paint would
 * otherwise stay wrong for the rest of the match.
 */
function landScore(scorer) {
  if (!ui) return;
  hideCard();
  paintScores();
  void scorer;
}
