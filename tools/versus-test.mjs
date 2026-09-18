#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:versus
//
// The two-seal ball game (systems/versus.js), driven headless. Nothing here is
// a look — what it asserts is that the mode's MECHANICS hold: the pitch is
// CONFIG.versus.widthScale wide while the flag is on, the camera boxes its subjects, a dash shoves the ball once and only once,
// a dent runs round the rim and rings down, the walls bounce outside the
// mouth and the mouth's posts and lips bounce inside it, a goal is called
// only once the ball is clear of the screen's edge, the goal's shutter
// freezes and releases on the wall clock into a kickoff — everyone held on
// their spot with a full wheel, bait in the way, a count, a whistle — first
// to `toWin` ends the match and resets it, the shore is carved to the same
// mouth the ball scores through, and player 2's pad is the one player 1 is
// not on.
//
// A Browser pane cannot film any of this (rAF is suspended there), and a real
// browser tab on a dev server writes the tuning file — so this is the check.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';

// THE REPLAY CAMERA THIS FILE IS ABOUT.
//
// A goal replay now ships filmed with the FLAT orthographic lens
// (CONFIG.versus.replay.cams.projection, default 'flat'), because the backdrop
// is a picture at one depth and only a camera with parallel rays can treat it
// as one — see the note on `projection` in config.js.
//
// The replay-camera block below is about the OTHER one: the pool of perspective
// shots swung off the plane, their angle, their z offset and their fov push.
// Those are still the contract that lens has to keep whenever it is the one
// fitted, so they are asserted against it directly rather than deleted. Set
// HERE, before anything steps a replay, because the camera is posed inside
// updatePool — flipping it mid-block leaves `poolState.rendered` holding the
// lens the previous frame was drawn with.
//
// The flat lens has its own tests in tools/replay-lens-test.mjs, and the
// framing checks in this file (targets in frame, no seam past a goal's face)
// pass under either.
CONFIG.versus.replay.cams.projection = 'perspective';
import { enableVersus, versusActive, versusDrops, versusSetup } from '../path/src/systems/versusFlag.js';
import { beginLobby, endSession, REMOTE } from '../path/src/systems/online/session.js';
import { versusZoomFloor, matchMargins } from '../path/src/systems/backdropFit.js';
import { bounds, updateBounds, midWater, seabedTopY } from '../path/src/arena.js';
import { player, initPlayer, resetPlayer, poseBody } from '../path/src/entities/player.js';
import { strikeState, resetStrike, cancelDash } from '../path/src/systems/strike.js';
import { initParticles, resetParticles, drivenCapacity } from '../path/src/entities/particles.js';
import { spawnXpOrb, pickups, resetPickups } from '../path/src/entities/pickups.js';
import { resetEnemies, spawnNamed, enemies } from '../path/src/entities/enemies.js';
import { updateStrike } from '../path/src/systems/strike.js';
import { versusHooks, BALL_TOUCH_EVENTS } from '../path/src/systems/versus.js';
import {
  versusState, ball, p2, startVersus, resetVersus, updateVersus, updateVersusClock, stirGoalLights, spotlightScorer,
  renderVersus, resetBall, dentBall, sealContact, p2Pad, readP2Input, versusFocus, rimRadius, rimAngle, solveBallSurface,
  versusCameraGoal, updateVersusCamera, strikeBallFrom, impactDent, versusBubblePips, driveOutline, timeLeft,
  versusOutOfAir, sealVulnerable,
  kickoffSpot, kickoffScatter, enterKickoff,
  ballHitRadius, ballHitRadiusAt, ballContactReach, ballRestRadius, versusSeals, updatePinch,
  matchSeals, sealAt, seatOf, sealPos, setMatchRoster, matchRoster, bodyCheck, creditGoal, formatClock, jostle, rimRadiusAt, releaseP2,
  updateNameTags, tagText,
  goalBlast,
  replayHoldsInput, replaySpeed,
  contestMargin, contestMass, returnCap, returnFloor, ballSpeedCap, sealCollide, limpFor, spikeStrength,
  replayState, anyButtonHeld, versusCameraState, replayRenderCamera, cameraRecentred,
  versusPlayerAir,
  versusMixDepth, makeReplayFrame, stageReplay, stepStagedReplay, endStagedReplay,
  replayRestoreSeconds, rematch,
} from '../path/src/systems/versus.js';
import { tallySnapshot } from '../path/src/systems/versusTally.js';
import { readFileSync } from 'node:fs';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ASSETS, isAssetLoaded } from '../path/src/assets.js';
import { ASSET_ROWS } from '../path/src/assetTable.js';
import { poolState, targetsInFrame } from '../path/src/systems/replayCams.js';
import {
  bossLightState, bossLightSeconds, bossLightEnvelope, bossLightMeshes, bossLightSubject,
  bossLightShape, updateBossLight, resetBossLight, initBossLight,
} from '../path/src/systems/bossLight.js';
import { goalScoredMix } from '../path/src/systems/wallRocks.js';
import { musicRateScale } from '../path/src/systems/music.js';
import { sfxRateScale } from '../path/src/systems/audio.js';
import { teamOfSeat, sameTeam, seatIsCpu, MAX_PER_SIDE as ROSTER_MAX } from '../path/src/systems/sealRoster.js';
import {
  isTimed, setTimed, goalsToWin, setGoalsToWin, matchSeconds, setMatchSeconds,
  matchResult, forgetMatchRules,
} from '../path/src/systems/matchRules.js';
import { goalColors } from '../path/src/systems/ballLook.js';
import { streaks as spinStreaks, updateBallSpin, recordBallSpin } from '../path/src/systems/ballSpin.js';
import {
  showRosterPreview, refreshRosterPreview, hideRosterPreview, rosterPreviewOn, updateRosterPreview,
  seatMarkers,
} from '../path/src/systems/versus.js';
import { ballSplats, gooDensity } from '../path/src/systems/ballShape.js';
import { cineLens } from '../path/src/systems/cineCamera.js';
import { screenEdgeX, mouthHalfHeight, tunnelDepth, goalHolesInstalled, rockX, mouthY, goalLineX, goalLineDepth, cameraReach, keeperLineDepth } from '../path/src/systems/versusGoal.js';
import { maxHalfHeight } from '../path/src/systems/goalBand.js';
import { clampToArena } from '../path/src/arena.js';
import { cutoffForDepth } from '../path/src/systems/music.js';
import { baitBalls } from '../path/src/systems/baitBall.js';
import {
  createWallRocks, shore, refreshGoalGlow, flashGoalScored, clearGoalScored,
  tickGoalGlow, goalGlowState, setGoalSwimmers, goalGlowImpulse, resetGoalStir,
} from '../path/src/systems/wallRocks.js';
import { boats } from '../path/src/systems/boats.js';
import { updateBot, botState, resetBot, intoOwnGoal } from '../path/src/systems/versusBot.js';
import { fireGoalJet, goalJetOrigin, updateGoalJets, resetGoalJets, goalJetState, goalJets } from '../path/src/systems/goalJet.js';
import { drivenCapacity as drivenCap } from '../path/src/entities/particles.js';
import { celebrationState, celebrationSpin, resetCelebration } from '../path/src/systems/celebrate.js';
import { onFeedback, feedbackState, feedback, hitstopAllowed, initFeedback } from '../path/src/systems/feedback.js';
import { bubbleOrbs, spawnBubbleOrb } from '../path/src/entities/pickups.js';
import { pipValue, pipCount, linkPips, linkCost, liveChain, comboSpeedMul, feedChum } from '../path/src/systems/strike.js';
import { airState, airRamp } from '../path/src/systems/airborne.js';
import { foodReach, foodDistance } from '../path/src/systems/chumMagnet.js';
import { uiText } from '../path/src/uiTextTable.js';
import { ballTint, ballLookState, ballCredit, resetBallLook, setBallBody, updateBallLook, claimBall, heldColor, starterColor, teamColor } from '../path/src/systems/ballLook.js';

const scene = new THREE.Scene();
const dt = 1 / 60;
let failures = 0;
// Seeded: bait balls, jitter and bubble births all draw on it, and an
// unseeded harness answers differently every run.
let seed = 0x5ea1ba11;
Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[animation]') || msg.startsWith('[assets]') || msg.startsWith('[uiText]'))) return;
  realWarn(msg, ...rest);
};
const realInfo = console.info;
console.info = () => {};

function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}
function note(text) { console.log(`        ${text}`); }
/**
 * IS THIS POINT IN THE SHOT — the one question the match's camera answers, and
 * the thing every check below is really asking. `goal` is what
 * versusCameraGoal handed back, `frame` the frustum at zoom 1; `r` is the
 * subject's own radius, so a ball is asked about as a circle rather than as a
 * centre that happens to be inside while half of it hangs over the edge.
 */
function inFrame(goal, frame, x, y, r = 0) {
  return Math.abs(x - goal.x) + r <= frame.w / (2 * goal.zoom) + 1e-9
    && Math.abs(y - goal.y) + r <= frame.h / (2 * goal.zoom) + 1e-9;
}
const V = CONFIG.versus;
// The bot is tools/versus-bot-test.mjs's business. Here player 2 is a body
// the tests place by hand, and a bot swimming it into the ball mid-check
// would make every physics answer below a matter of luck.
V.bot.enabled = false;
// The instant replay parks the goal's shutter while it plays; the shutter's
// own timing is measured below with it off, and it gets a section of its own.
V.replay.enabled = false;
const noPads = [];

// Fake pads in the shape navigator.getGamepads() hands back.
function pad(index, { lx = 0, ly = 0, rx = 0, ry = 0, strike = false } = {}) {
  const buttons = Array.from({ length: 12 }, () => ({ pressed: false, value: 0 }));
  if (strike) buttons[5] = { pressed: true, value: 1 };
  return { index, connected: true, id: `pad ${index}`, mapping: 'standard', axes: [lx, ly, rx, ry], buttons };
}

// Step the whole frame the way main.js does: the shutter on the wall clock,
// gameplay on the scaled one.
// A SEAL IN THE WATER IS POINTED WHERE IT IS GOING, and the ball's contact
// asks the body which way its nose is (sealHeading, off mesh.rotation.z). In
// the game entities/player.js's poseBody writes that every frame; here
// nothing does, so a harness seal sat at rotation 0 — which the art's +Y
// forward makes NOSE-UP — and every head-on test in this file measured a
// flank. Same convention as poseBody: forward is +Y, so subtract a quarter
// turn from the heading.
function poseFromSwim(seal) {
  const v = seal?.velocity;
  if (!seal?.mesh || !v) return;
  if (Math.hypot(v.x, v.y) < 1e-4) return;
  seal.mesh.rotation.z = Math.atan2(v.y, v.x) - Math.PI / 2;
}

// HOW FAR OFF THE BALL A SEAL FIRST TOUCHES IT, asked for at the moment of
// each placement rather than cached at the top of a block. It MOVES during a
// test now: the drawn edge is the hitbox and the edge dents where it was last
// struck, so a rest-value reach put the second press of a sequence just out
// of contact. Default angle is the ball's left, the side most of this file
// swims in from.
// ...RE-SOLVED FIRST. The drawn edge is only recomputed inside a frame, so a
// test that has just set ball.vx by hand is still holding the surface of the
// ball as it was MOVING — the velocity stretch is part of the silhouette, and
// a stopped ball measured off a stale solve reads a unit and a half too wide.
const ballReach = (angle = Math.PI) => { solveBallSurface(); return ballContactReach(angle); };

function frame(pads = noPads, raw = dt) {
  poseFromSwim(player);
  poseFromSwim(p2);
  const scale = updateVersusClock(raw, pads);
  updateVersus(raw * scale, pads);
  return scale;
}
function settle(seconds, pads = noPads) {
  for (let t = 0; t < seconds; t += dt) frame(pads);
}
// Frame until the match is in play — through a kickoff's count, or a goal's
// shutter and the kickoff after it. Bounded, so a phase that never closes is
// a failure and not a hang.
function toPlay(limit = 12, pads = noPads) {
  for (let t = 0; t < limit && versusState.phase !== 'play'; t += dt) frame(pads);
  return versusState.phase === 'play';
}
const KO = V.kickoff;
const COUNT_LEN = KO.count * KO.tick;
// Every feedback event fired, by name, for the sections that count them.
const fired = new Map();
onFeedback((name) => fired.set(name, (fired.get(name) ?? 0) + 1));
const firedCount = (name) => fired.get(name) ?? 0;
// THE BALL'S ORDINARY TOUCH IS THREE ROWS. ballImpactFx picks one by how hard
// the hit was, so a count of `versusBallHit` alone answers 0 for a dribble
// (all taps) and 0 for a cannon (all smashes) — which reads as "the event
// never fired" on precisely the two cases worth testing. Anything asking "was
// the ball touched" has to ask the family. See BALL_TOUCH_EVENTS.
const touchCount = () => BALL_TOUCH_EVENTS.reduce((n, e) => n + firedCount(e), 0);

// ---------------------------------------------------------------------------
section('The pitch has its own width while the flag is on');
{
  enableVersus(false);
  updateBounds(16 / 9);
  const wide = bounds.right;
  enableVersus(true);
  updateBounds(16 / 9);
  const flush = bounds.right;
  const want = (52 * 16 / 9) / 2 * Math.max(1, V.widthScale ?? 1);
  check('versus walls sit at CONFIG.versus.widthScale frames', Math.abs(flush - want) < 0.01, `right=${flush.toFixed(2)} (want ${want.toFixed(2)})`);
  check('...and the ordinary game keeps arena.widthScale', Math.abs(wide - (52 * 16 / 9) / 2 * CONFIG.arena.widthScale) < 0.01, `right=${wide.toFixed(2)}`);
  check('the focus is the arena\'s centre', Math.abs(versusFocus().x) < 1e-9);
}

initPlayer(scene);
initParticles(scene);
resetPlayer();
resetStrike();

// ---------------------------------------------------------------------------
section('A match opens on a kickoff, with everything in its place');
{
  startVersus(scene);
  const half = bounds.right;
  check('the match opens in the kickoff', versusState.phase === 'kickoff' && versusState.kickoffs === 1, `phase ${versusState.phase}`);
  check('the ball is live at centre', ball.live && Math.abs(ball.x) < 1e-6 && Math.abs(ball.y - midWater()) < 1e-6);
  check('P1 is in the left half', player.mesh.position.x < -half * 0.1, `x=${player.mesh.position.x.toFixed(1)}`);
  check('P2 is in the right half', p2.pos.x > half * 0.1, `x=${p2.pos.x.toFixed(1)}`);
  const s0 = kickoffSpot(0, {}); const s1 = kickoffSpot(1, {});
  check('each seal is on its own kickoff spot', Math.abs(player.mesh.position.x - s0.x) < 1e-6 && Math.abs(p2.pos.x - s1.x) < 1e-6, `p1 ${s0.x.toFixed(1)} p2 ${s1.x.toFixed(1)}`);
  // `inset` FROM ITS OWN WALL, times whatever this kickoff rolled. It used to
  // be that distance exactly — the spot was the same two marks every kickoff of
  // the match, which at 1v1 is what kickoffScatter exists to stop.
  {
    const anchor = bounds.width * 0.5 - KO.inset * bounds.width;
    const sc = kickoffScatter(undefined, {});
    const r = Math.hypot(s0.x, s0.y - midWater());
    check('...at `inset` in from its own wall, swung and stretched by this kickoff\'s roll',
      Math.abs(r - anchor * sc.scale) < 1e-6, `${r.toFixed(2)} against ${anchor.toFixed(2)} x ${sc.scale.toFixed(3)}`);
  }
  // MIRRORED ACROSS THE HALFWAY LINE — the same distance from the ball and the
  // same height in the water, in opposite halves. NOT `s0.y === midWater()`,
  // which is what it used to say: the lane is rolled now, and the thing worth
  // asserting was never that it was zero but that both sides get the same one.
  check('...mirrored about the ball', Math.abs(s0.x + s1.x) < 1e-6 && Math.abs(s0.y - s1.y) < 1e-6,
    `${s0.x.toFixed(2)},${s0.y.toFixed(2)} vs ${s1.x.toFixed(2)},${s1.y.toFixed(2)}`);
  check('both meters open full', strikeState.charge >= 0.999 && p2.charge >= 0.999, `p1=${strikeState.charge.toFixed(2)} p2=${p2.charge.toFixed(2)}`);
  check('scores are 0–0', versusState.scores[0] === 0 && versusState.scores[1] === 0);
  check('the goal mouths are installed in the arena', goalHolesInstalled());
  check(`bait balls are dropped in the way, ${KO.bait.perSide} a side`, baitBalls.size >= KO.bait.perSide * 2, `${baitBalls.size} balls`);
  let inLane = 0;
  for (const b of baitBalls.values()) {
    const t = Math.abs(b.stationX) / Math.abs(s0.x);
    if (t >= 1 - KO.bait.to - 1e-6 && t <= 1 - KO.bait.from + 1e-6 && Math.abs(b.stationY - midWater()) <= KO.bait.spread + 1e-6) inLane++;
  }
  check('...between each seal and the ball, on station', inLane >= KO.bait.perSide * 2, `${inLane} of ${baitBalls.size} in a lane`);
  let awake = 0; let asleep = 0;
  for (const b of baitBalls.values()) { if (b.arriving) asleep++; else awake++; }
  check('...and awake, not swimming in from off screen', asleep === 0, `${awake} awake, ${asleep} arriving`);
  const want = 1 + Math.round(V.ball.soft.points / 3) + V.ball.soft.points;
  check('the ball holds its goo slots', ball.slots.length === want, `${ball.slots.length}/${want}, reserve ${JSON.stringify(drivenCapacity())}`);
  check('the goo group resolved', ball.group > 0, `index ${ball.group}`);
  renderVersus();
  check('renderVersus runs on a live ball', true);
}

// ---------------------------------------------------------------------------
section('The kickoff: a count on the wall clock, everyone held, then the whistle');
{
  fired.clear();
  const k = V.clock;
  let scale = frame();
  check('the water is frozen under the count', scale <= k.freezeScale + 1e-9, `scale=${scale}`);
  check('the first numeral is up on the first frame', versusState.count === KO.count && firedCount('versusCountdown') === 1, `count ${versusState.count}, ${firedCount('versusCountdown')} tick(s)`);
  // Shove both seals and the ball mid-count: the hold puts them back.
  player.mesh.position.x += 10; player.velocity.set(30, 0);
  p2.pos.x -= 10; p2.vel.set(-30, 0);
  ball.x = 15; ball.vx = 40;
  strikeState.charge = 0.2; p2.charge = 0.3;
  frame();
  const s0 = kickoffSpot(0, {}); const s1 = kickoffSpot(1, {});
  check('a seal shoved during the count is held on its spot', Math.abs(player.mesh.position.x - s0.x) < 1e-6 && Math.abs(p2.pos.x - s1.x) < 1e-6 && player.velocity.length() === 0 && p2.vel.length() === 0);
  check('...and the ball at centre', ball.x === 0 && ball.vx === 0);
  check('...with the wheel kept full', strikeState.charge === 1 && p2.charge === 1);
  let minScale = 1; let ticks = 0; let lastCount = versusState.count; let t = versusState.phaseT;
  let whistleAt = -1;
  while (versusState.phase === 'kickoff' && t < COUNT_LEN + 1) {
    scale = frame();
    t += dt; // the phase clock resets to zero on the whistle's frame
    if (scale < 0.999) minScale = Math.min(minScale, scale);
    if (versusState.count !== lastCount) { ticks++; lastCount = versusState.count; }
  }
  whistleAt = t;
  check('held at freezeScale for the whole count', minScale <= k.freezeScale + 1e-9, `min ${minScale}`);
  check(`the numerals run ${KO.count}..1 a tick apart`, firedCount('versusCountdown') === KO.count, `${firedCount('versusCountdown')} ticks`);
  check('the whistle goes at count x tick', versusState.phase === 'play' && Math.abs(whistleAt - COUNT_LEN) < dt * 2, `play at ${whistleAt.toFixed(2)}s (want ${COUNT_LEN.toFixed(2)})`);
  check('...once', firedCount('versusKickoff') === 1, `${firedCount('versusKickoff')}`);
  check('the world is back at full speed on the whistle\'s frame', updateVersusClock(dt) === 1);
  check('the whistle\'s line is on the wall clock and goes away', versusState.goT > 0 && (settle(KO.goHold + 0.1), versusState.goT === 0));
  check('the count is over', versusState.count === 0);
  // Off: straight to play, no count.
  KO.enabled = false;
  enterKickoff();
  check('with the kickoff off, a match goes straight to play', versusState.phase === 'play' && versusState.count === 0);
  KO.enabled = true;
  versusState.phase = 'play';
}

// ---------------------------------------------------------------------------
// BOTH TANKS OVER THE COUNT. The meter used to snap full on the frame the
// kickoff was called — which is behind the recentre and the gather, so the
// refill happened before a numeral was on screen — and the lungs were not
// refilled at all, so a seal that scored on its last breath kicked off still
// gasping. See CONFIG.versus.kickoff.fill.
section('The count fills the air and boost tanks, full exactly on the whistle');
{
  const maxO2 = Math.max(1, player.stats?.maxOxygen ?? CONFIG.oxygen?.max ?? 100);
  strikeState.charge = 0.15;
  p2.charge = 0.4;
  player.oxygen = maxO2 * 0.2;
  p2.oxygen = maxO2 * 0.55;
  enterKickoff();
  check('neither tank is filled on the frame the kickoff is called',
    strikeState.charge < 0.999 && player.oxygen < maxO2 * 0.999,
    `charge ${strikeState.charge.toFixed(3)} air ${(player.oxygen / maxO2).toFixed(3)}`);
  // STEPPED BY HAND rather than through frame(), so the whistle's own frame can
  // be read BETWEEN the clock and the step. Play opens on that frame — the
  // seals start breathing again the moment it does — so a reading taken after
  // updateVersus is a reading one frame of drain late, and "full on the
  // whistle" would fail by exactly that much.
  let backwards = 0; let earlyFull = 0; let lastC = strikeState.charge; let lastO = player.oxygen;
  let midC = 0;
  let onWhistle = null;
  for (let i = 0; i < 600 && versusState.phase === 'kickoff'; i++) {
    poseFromSwim(player);
    poseFromSwim(p2);
    const scale = updateVersusClock(dt, noPads);
    if (versusState.phase !== 'kickoff') {
      onWhistle = { c: strikeState.charge, o: player.oxygen, pc: p2.charge, po: p2.oxygen };
    } else {
      if (strikeState.charge < lastC - 1e-9 || player.oxygen < lastO - 1e-9) backwards++;
      // Full while there is still more than a frame of count left. The last
      // frame is allowed to read 1: the curve and the numerals divide the same
      // phase clock and disagree by a float sliver at the very end, which is
      // not an early arrival and is not worth a second clock to avoid.
      if (strikeState.charge >= 1 - 1e-9 && versusState.phaseT < COUNT_LEN - dt) earlyFull++;
      if (versusState.count === 2 && !midC) midC = strikeState.charge;
      lastC = strikeState.charge; lastO = player.oxygen;
    }
    updateVersus(dt * scale, noPads);
  }
  check('the fill only ever climbs', backwards === 0, `${backwards} frames went down`);
  check('...and is not full before the whistle', earlyFull === 0, `${earlyFull} frames full early`);
  check('...so the middle of the count is genuinely mid-fill', midC > 0.15 && midC < 1 - 1e-9, `${midC.toFixed(3)} at "2"`);
  // THE PROMISE. Exact, not "close": fillTanks lerps to an endpoint of 1 and
  // whistle() spends the last frame on it, so a tolerance here would be hiding
  // the one frame the phase flip used to eat.
  check('the boost meter is exactly full on the whistle', onWhistle?.c === 1, `${onWhistle?.c}`);
  check('...and so are the lungs', onWhistle?.o === maxO2, `${onWhistle?.o} of ${maxO2}`);
  // P2's tanks started higher and land in the same place on the same frame:
  // the blend is per seat and its endpoint is not.
  check('every seat lands together, whatever it started on', onWhistle?.pc === 1 && onWhistle?.po === maxO2,
    `p2 charge ${onWhistle?.pc} air ${onWhistle?.po}`);
  check('...on the frame play opens, not after it', versusState.phase === 'play', versusState.phase);
  // A seal carrying MORE than the run's max — a bubble taken on the stroke
  // that scored — is not eased down to it over the count.
  strikeState.charge = 0.3;
  player.oxygen = maxO2 * 1.4;
  enterKickoff();
  let dipped = false;
  for (let i = 0; i < 600 && versusState.phase === 'kickoff'; i++) { frame(); if (player.oxygen < maxO2 - 1e-9) dipped = true; }
  check('an over-full tank is never eased DOWN to the cap', !dipped, `air ${player.oxygen}`);
  // Off: the old snap, on the frame the kickoff is called.
  V.kickoff.fill.enabled = false;
  strikeState.charge = 0.1;
  enterKickoff();
  check('with the fill off the meter is left alone', strikeState.charge === 0.1, `${strikeState.charge}`);
  V.kickoff.fill.enabled = true;
  toPlay();
  versusState.phase = 'play';
}

// ---------------------------------------------------------------------------
section('A dash shoves the ball once, along the dash');
{
  resetBall();
  player.mesh.position.set(ball.x - ballReach() + 0.4, ball.y, 0);
  player.velocity.set(20, 0);
  strikeState.active = true;
  strikeState.dashDir.x = 1;
  strikeState.dashDir.y = 0;
  strikeState.power = 1;
  frame();
  const v1 = ball.vx;
  check('the ball takes off along +x', v1 > V.ball.strikeImpulse, `vx=${v1.toFixed(1)}`);
  check('at full power it is the max impulse plus the carry, under the cap', v1 >= Math.min(V.ball.strikeImpulseMax * 0.9, V.ball.maxSpeed) - 0.05 && v1 <= V.ball.maxSpeed + 0.05, `vx=${v1.toFixed(1)} (cap ${V.ball.maxSpeed})`);
  check('it did not go sideways', Math.abs(ball.vy) < 1, `vy=${ball.vy.toFixed(2)}`);
  // Keep the seal on it, still dashing: no second shove.
  player.mesh.position.set(ball.x - ballReach() + 0.4, ball.y, 0);
  frame();
  check('the same dash does not shove twice', ball.vx <= v1, `vx ${v1.toFixed(1)} → ${ball.vx.toFixed(1)}`);
  strikeState.active = false;
  // OFF IT AND LET THE RIM RING DOWN before the next press. The drawn edge is
  // the hitbox, so a body still wobbling from the last strike is half a unit
  // narrower on the side the seal is placed against — and a placement
  // measured off a rest radius then lands just outside contact.
  player.mesh.position.set(-30, midWater(), 0);
  player.velocity.set(0, 0);
  settle(0.6);
  strikeState.active = true;
  // ...and swimming its dash again. The strike above recoiled the seal to
  // -40 u/s and a dash is what its velocity SAYS it is: the body points where
  // it is going (poseBody), so a seal left travelling backwards would meet the
  // ball tail-first — a real answer to an unreal state.
  player.velocity.set(20, 0);
  ball.vx = 0; // still, so the ball is where the seal is put on the frame of contact
  ball.vy = 0;
  player.mesh.position.set(ball.x - ballReach() + 0.4, ball.y, 0);
  const before = ball.vx;
  frame();
  check('a new dash shoves again', ball.vx > before + 30, `vx ${before.toFixed(1)} → ${ball.vx.toFixed(1)}`);
  strikeState.active = false;
  player.mesh.position.set(-30, midWater(), 0);
  player.velocity.set(0, 0);
}

// ---------------------------------------------------------------------------
section('The rim dents where it is hit, ripples round, and rings down');
{
  // The MECHANISM, on numbers that show it. The live soft-body numbers are
  // Ethan's (the ball lab writes them straight into config.js and the
  // tuner shadows them), and a stiff, heavily damped rim is allowed to have
  // no visible ripple — that is a taste, not a bug. Pinned here, restored after.
  const softSaved = { ...V.ball.soft };
  Object.assign(V.ball.soft, { spring: 90, damping: 4, couple: 600, dentDepth: 0.42, dentWidth: 0.8, maxDeform: 0.55 });
  resetBall();
  ball.vx = ball.vy = 0;
  const n = ball.rim.length;
  const hitAt = Math.PI; // the left side of the ball
  dentBall(hitAt, V.ball.soft.dentDepth);
  const left = n / 2;
  const top = n / 4;
  check('the struck side goes in', ball.rim[left] < -0.2 * ball.r, `rim=${ball.rim[left].toFixed(2)}`);
  check('the top is all but untouched on the frame of the hit', Math.abs(ball.rim[top]) < 0.03 * ball.r, `rim=${ball.rim[top].toFixed(3)}`);
  frame();
  check('the far side bulges on the next step (volume)', ball.rim[0] > 0, `rim=${ball.rim[0].toFixed(3)}`);
  // Run the soft body alone — the ball is still, so stepBall does nothing to
  // it. The volume rule lifts the whole rim at once, so the ripple is read as
  // the TOP going IN later: the dent arriving, against the uniform bulge.
  let arrived = -1;
  let deepest = 0;
  for (let i = 0; i < 90; i++) {
    frame();
    const t = ball.rim[top];
    if (t < deepest) deepest = t;
    if (arrived < 0 && t < -0.04 * ball.r) arrived = i;
  }
  check('the dent reaches the top as a ripple', arrived > 0 && arrived < 40, `frame ${arrived}, deepest ${deepest.toFixed(2)}`);
  settle(4);
  let worst = 0;
  for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(ball.rim[i]));
  check('and it rings down', worst < 0.03 * ball.r, `max |rim| ${worst.toFixed(3)} after 4s`);
  check('rimRadius is the rest radius at rest', Math.abs(rimRadius(0) - ball.r) < 0.05 * ball.r, `${rimRadius(0).toFixed(2)} vs ${ball.r}`);
  let ok = true;
  for (let i = 0; i < n; i++) if (!Number.isFinite(ball.rim[i]) || !Number.isFinite(ball.rimV[i])) ok = false;
  check('nothing went NaN', ok);
  Object.assign(V.ball.soft, softSaved);
}

// ---------------------------------------------------------------------------
section('A swimming seal nudges it; a wall bounces it; the mouth lets it through');
{
  resetBall();
  sealContact(1, { x: ball.x - ballReach() + 0.3, y: ball.y }, { x: 12, y: 0 }, false, null, 0);
  check('a bump moves the ball along the closing speed', ball.vx > 5 && ball.vx < 30, `vx=${ball.vx.toFixed(1)}`);
  check('the ball is pushed out of the seal', ball.x > 0.2, `x=${ball.x.toFixed(2)}`);

  // Above the mouth, heading for the left wall.
  resetBall();
  ball.x = bounds.left + 12;
  ball.y = midWater() + mouthHalfHeight() + 4;
  ball.vx = -30;
  settle(1.2);
  check('outside the mouth the wall bounces it back', ball.vx > 0 && ball.x >= bounds.left + ball.r - 1e-6, `vx=${ball.vx.toFixed(1)} x=${ball.x.toFixed(1)}`);
  check('the match is still in play', versusState.phase === 'play');

  // Floor.
  resetBall();
  ball.y = bounds.bottom + 6;
  ball.vy = -30;
  settle(0.6);
  check('the floor bounces it up', ball.vy > 0 && ball.y >= bounds.bottom + ball.r - 1e-6, `vy=${ball.vy.toFixed(1)}`);

  // THE POSTS. A ball into the top corner of the mouth, from the water: it
  // comes off at an angle, not straight back, and it is the post's event.
  fired.clear();
  resetBall();
  const gy = midWater();
  const h = mouthHalfHeight();
  ball.x = bounds.left + 10;
  ball.y = gy + h - ball.r * 0.4; // its upper half will meet the corner from below
  ball.vx = -40; ball.vy = 0;
  versusState.lastPost = null;
  for (let i = 0; i < 30 && !versusState.lastPost; i++) frame();
  const post = versusState.lastPost;
  check('a ball into the corner hits the post', !!post && post.side === -1, post ? `n=(${post.nx.toFixed(2)},${post.ny.toFixed(2)}) at (${post.x.toFixed(1)},${post.y.toFixed(1)})` : 'no post hit');
  check('...and comes off it at an angle — down into the mouth, not straight back', !!post && post.nx > 0.2 && post.ny < -0.2 && ball.vy < -2, `v=(${ball.vx.toFixed(1)},${ball.vy.toFixed(1)})`);
  // ...and a ball whose centre is above the lip meets the flat of the wall.
  fired.clear();
  resetBall();
  ball.x = bounds.left + 10; ball.y = gy + h + ball.r; ball.vx = -40; ball.vy = 0;
  settle(0.5);
  check('a ball above the lip meets the flat wall, and that is the wall\'s event', ball.vx > 0 && Math.abs(ball.vy) < 0.5 && firedCount('versusBallWall') >= 1 && firedCount('versusPost') === 0, `v=(${ball.vx.toFixed(1)},${ball.vy.toFixed(1)}), wall ${firedCount('versusBallWall')}`);
  fired.clear();
  resetBall();
  ball.x = bounds.left + 10; ball.y = gy + h - ball.r * 0.4; ball.vx = -40; ball.vy = 0;
  for (let i = 0; i < 30 && !firedCount('versusPost'); i++) frame();
  check('...as the post\'s own event, not the wall\'s', firedCount('versusPost') >= 1 && firedCount('versusBallWall') === 0, `post ${firedCount('versusPost')}, wall ${firedCount('versusBallWall')}`);
  check('it is still in play', ball.live && versusState.phase === 'play');

  // THE LIPS. Inside the tunnel, moving up: it rattles off the top lip and
  // stays in the band.
  fired.clear();
  resetBall();
  ball.x = bounds.left - 1;
  ball.y = gy;
  ball.vx = 0; ball.vy = 30;
  let top = -Infinity;
  for (let i = 0; i < 40 && !firedCount('versusPost'); i++) { frame(); top = Math.max(top, ball.y + ball.r); if (!ball.live) break; }
  check('inside the entrance the top lip holds the ball', top <= gy + h + 1e-6 && ball.vy < 0, `top ${top.toFixed(2)} vs lip ${(gy + h).toFixed(2)}, vy=${ball.vy.toFixed(1)}`);
  check('...as a rattle', firedCount('versusPost') >= 1);
  check('...and a ball in the entrance is not a goal', ball.live && versusState.phase === 'play');
  // It can leave again.
  ball.vx = 25; ball.vy = 0;
  settle(0.5);
  check('a ball in the entrance can come back out', ball.live && ball.x > bounds.left + ball.r, `x=${ball.x.toFixed(1)}`);

  // THE SEALS' HOLE. Player 1 may swim into the mouth and down the whole
  // corridor; outside the band the wall holds it as it always did.
  const pos = { x: bounds.left + 0.5, y: gy };
  const vel = { x: -20, y: 0 };
  let hit = false;
  for (let i = 0; i < 90; i++) { pos.x += vel.x * dt; if (clampToArena(pos, vel, 1, 0)) hit = true; }
  check('a seal swims into the mouth', pos.x < bounds.left - 1, `x=${pos.x.toFixed(2)} (wall ${bounds.left.toFixed(2)})`);
  // ...ALL THE WAY TO THE ROCK AT THE BACK, its own edge on it. Both numbers
  // as a depth past the WALL, which is the frame clampToArena works in: the
  // tunnel is cut past the rock FACE, which sits shore.face past the wall.
  // It used to stop at keeperReach — 7 past the wall, no rock there, a third
  // of the way down a tunnel the seal could see the rest of.
  const lineFromWall = shore.face + goalLineDepth();
  const back = shore.face + tunnelDepth();
  check('...through the line and on to the tunnel\'s back, stopped by the rock and nothing sooner', Math.abs(pos.x - (bounds.left - (back - 1))) < 1e-6 && hit && back - 1 > lineFromWall, `x=${pos.x.toFixed(2)}, stopped ${(bounds.left - pos.x).toFixed(2)} past the wall (radius 1), rock at ${back.toFixed(2)}, line ${lineFromWall.toFixed(2)}`);
  check('...which the frame can follow: the camera reaches the back of the corridor', cameraReach() >= back - 1, `reach ${cameraReach().toFixed(2)} past the wall vs a seal at ${(back - 1).toFixed(2)}`);
  pos.y = gy + h + 0.5; pos.x = bounds.left + 0.5; vel.x = -20;
  for (let i = 0; i < 10; i++) { pos.x += vel.x * dt; clampToArena(pos, vel, 1, 0); }
  check('...but outside the band the wall holds', Math.abs(pos.x - (bounds.left + 1)) < 1e-6, `x=${pos.x.toFixed(2)}`);
  pos.x = bounds.left - 1; pos.y = gy; vel.x = 0; vel.y = 20;
  for (let i = 0; i < 40; i++) { pos.y += vel.y * dt; clampToArena(pos, vel, 1, 0); }
  check('...and inside it the lip holds a seal too', Math.abs(pos.y - (gy + h - 1)) < 1e-6, `y=${pos.y.toFixed(2)}`);

  // Inside the mouth, heading for the left wall: P2's goal.
  resetBall();
  ball.x = bounds.left + 12;
  ball.y = midWater();
  ball.vx = -30;
  let frames = 0;
  let atWall = null;
  while (versusState.phase === 'play' && frames < 240) {
    frame(); frames++;
    if (atWall === null && ball.x < bounds.left) atWall = { live: ball.live, phase: versusState.phase };
  }
  check('inside the mouth it goes in', versusState.phase === 'scored', `after ${frames} frames, phase ${versusState.phase}`);
  check('the ball in the LEFT goal is P2\'s point', versusState.scores[1] === 1 && versusState.scores[0] === 0, `${versusState.scores.join('–')}`);
  check('the ball is taken out of play', !ball.live);
  check('crossing the wall\'s line was NOT yet the goal', atWall && atWall.live && atWall.phase === 'play');
  const line = goalLineX(-1);
  check('the goal was called once the ball\'s near side was past the line', versusState.lastGoal && versusState.lastGoal.x + ballRestRadius() <= line + 1e-6, `x=${versusState.lastGoal?.x.toFixed(2)}, near side ${(versusState.lastGoal?.x + ballRestRadius()).toFixed(2)} vs line ${line.toFixed(2)}`);
  check('...and not before it', versusState.lastGoal && versusState.lastGoal.x + ballRestRadius() > line - ballRestRadius(), `near side ${(versusState.lastGoal?.x + ballRestRadius()).toFixed(2)} vs line ${line.toFixed(2)}`);
  check('the line is ON SCREEN: inside the camera\'s reach into the goal', goalLineDepth() + ballRestRadius() < cameraReach() && cameraReach() <= shore.face + tunnelDepth(), `line ${goalLineDepth().toFixed(1)} + ball ${ballRestRadius().toFixed(2)} vs reach ${cameraReach().toFixed(1)} of tunnel ${tunnelDepth()} past a ${shore.face.toFixed(2)} face`);
  check('the whole ball fits between the line and the tunnel\'s back', goalLineDepth() + ball.r * 2 < tunnelDepth(), `line ${goalLineDepth().toFixed(1)} + ${(ball.r * 2).toFixed(1)} vs tunnel ${tunnelDepth()}`);
  check('the goal fired its impact and its cheer, at the mouth', firedCount('versusGoal') === 1 && firedCount('versusGoalCheer') === 1);
}

// ---------------------------------------------------------------------------
section('The shutter: freeze, ramp, then the number flies into a kickoff');
{
  const k = V.clock;
  const kickoffsBefore = versusState.kickoffs;
  // phaseT is already a frame or so in from the loop above.
  let scale = frame();
  check('the world is frozen on the frame after the goal', scale <= k.freezeScale + 1e-9, `scale=${scale}`);
  let t = versusState.phaseT;
  let minDuringFreeze = 1;
  let firstFull = -1;
  let respawnedAt = -1;
  let stillAtRespawn = false;
  let flownAt = -1;
  while (versusState.phase === 'scored' && t < 5) {
    scale = frame();
    t += dt; // the phase clock resets to zero when the kickoff opens
    if (t < k.freeze) minDuringFreeze = Math.min(minDuringFreeze, scale);
    if (firstFull < 0 && scale >= 0.999) firstFull = t;
    if (respawnedAt < 0 && ball.live) { respawnedAt = t; stillAtRespawn = Math.abs(ball.x) < 1e-6 && ball.vx === 0 && Math.abs(ball.vy) < 0.5; }
    if (flownAt < 0 && versusState.flown) flownAt = t;
  }
  check('held at freezeScale through the freeze', minDuringFreeze <= k.freezeScale + 1e-9);
  check('back to full speed after freeze + ramp', firstFull > 0 && Math.abs(firstFull - (k.freeze + k.ramp)) < 0.05, `at ${firstFull.toFixed(2)}s (want ${(k.freeze + k.ramp).toFixed(2)})`);
  check('the ball is back at `respawn`', respawnedAt > 0 && Math.abs(respawnedAt - k.respawn) < 0.05, `at ${respawnedAt.toFixed(2)}s`);
  check('...at centre, still', ball.live && stillAtRespawn);
  check('the number flies as the ball comes back', flownAt > 0 && Math.abs(flownAt - respawnedAt) < dt * 2, `flew at ${flownAt.toFixed(2)}s`);
  check('and the shutter closes into a kickoff', versusState.phase === 'kickoff' && versusState.kickoffs === kickoffsBefore + 1, `phase ${versusState.phase} at ${t.toFixed(2)}s`);
  const s0 = kickoffSpot(0, {}); const s1 = kickoffSpot(1, {});
  // THE SEALS ARRIVE, THEY ARE NOT PLACED — see the gather in versus.js. A
  // goal throws every body near the mouth across the pitch and this kickoff
  // eases them onto their marks over `kickoff.gather` wall seconds instead of
  // writing them there on the frame it opens. So the claim is about where they
  // END UP and when: on their spots, exactly, before the first numeral.
  check('...with the seals still gathering rather than teleported',
    !versusState.gathered || (Math.abs(player.mesh.position.x - s0.x) < 1e-6 && Math.abs(p2.pos.x - s1.x) < 1e-6),
    `gathered ${versusState.gathered}, p1 ${player.mesh.position.x.toFixed(1)} vs ${s0.x.toFixed(1)}`);
  {
    let waited = 0;
    let numeral = false;
    while (!versusState.gathered && waited < (KO.gather ?? 0) + 0.5) {
      // Read BEFORE the frame that lands them: the count is allowed to open on
      // the frame the gather finishes, and is not allowed to open before it.
      if (versusState.count !== -1) numeral = true;
      frame();
      waited += dt;
    }
    check('...and on their spots to the float once the gather is done',
      versusState.gathered && Math.abs(player.mesh.position.x - s0.x) < 1e-6 && Math.abs(p2.pos.x - s1.x) < 1e-6,
      `after ${waited.toFixed(2)}s: p1 ${player.mesh.position.x.toFixed(3)} vs ${s0.x.toFixed(3)}, p2 ${p2.pos.x.toFixed(3)} vs ${s1.x.toFixed(3)}`);
    check('...over the beat it is given, with no numeral up while they travelled',
      !numeral && Math.abs(waited - (KO.gather ?? 0)) < dt * 2, `${waited.toFixed(2)}s of ${KO.gather}, numeral ${numeral}`);
  }
  check('...and the water frozen again under the count', updateVersusClock(dt) <= k.freezeScale + 1e-9);
  check('the count runs out into play', toPlay(), `phase ${versusState.phase}`);
  check('a live match runs at full speed', updateVersusClock(dt) === 1);
}

// ---------------------------------------------------------------------------
section('First to toWin ends the match, holds, and asks');
{
  versusState.scores[0] = V.toWin - 1;
  versusState.scores[1] = 2;
  resetBall();
  ball.x = bounds.right - 12;
  ball.y = midWater();
  ball.vx = 30;
  let frames = 0;
  while (versusState.phase === 'play' && frames < 240) { frame(); frames++; }
  check('the ball in the RIGHT goal is P1\'s point', versusState.scores[0] === V.toWin, `${versusState.scores.join('–')}`);
  check('reaching toWin is the end state', versusState.phase === 'won');
  const scale = frame();
  check('the end state freezes the water', scale <= V.clock.freezeScale + 1e-9, `scale=${scale}`);
  settle(V.clock.wonHold + 0.2);
  // The hold ends on a PROMPT, not a kickoff: rematch or the main menu, with
  // the water still frozen and the score still up. See rematch() in versus.js.
  check('after the hold the match asks rather than resetting', versusState.phase === 'over', versusState.phase);
  check('...with the score still standing', versusState.scores[0] === V.toWin, `${versusState.scores.join('–')}`);
  check('...and the water still frozen', frame() <= V.clock.freezeScale + 1e-9);
  settle(2);
  check('and it waits — no kickoff on its own', versusState.phase === 'over', versusState.phase);
  // Any pad may answer. Pad 2 (not player 1's, not player 2's) presses A on
  // the first button, which is the rematch.
  {
    const p = pad(2);
    p.buttons[0] = { pressed: true, value: 1 };
    frame([p]);
    p.buttons[0] = { pressed: false, value: 0 };
    frame([p]);
  }
  check('a rematch is the old reset, on a kickoff', versusState.phase === 'kickoff' && versusState.scores[0] === 0 && versusState.scores[1] === 0, `${versusState.phase} ${versusState.scores.join('–')}`);
  check('the ball is back', ball.live && Math.abs(ball.x) < 1e-6);
  check('the seals are back in their halves', player.mesh.position.x < 0 && p2.pos.x > 0);
  toPlay();
}

// ---------------------------------------------------------------------------
section('Player 2\'s pad is the one player 1 is not on');
{
  const two = [pad(0), pad(1, { lx: 1, strike: true })];
  check('with two pads P2 takes the second by index', p2Pad(two)?.index === 1);
  check('with one pad P2 takes it (P1 is on the keyboard)', p2Pad([pad(3)])?.index === 3);
  check('with none there is no pad', p2Pad([null, undefined]) === null);
  readP2Input(two);
  check('the left stick is the move', p2.input.move.x === 1 && p2.input.move.y === 0 && p2.input.connected);
  check('a shoulder is the strike, held', p2.input.strikeHeld && !p2.input.strikeRelease);
  readP2Input([pad(0), pad(1, { lx: 1 })]);
  check('letting go is a one-frame release', p2.input.strikeRelease && !p2.input.strikeHeld);
  readP2Input([pad(0), pad(1, { lx: 1 })]);
  check('...one frame only', !p2.input.strikeRelease);
  readP2Input([pad(0), pad(1, { ly: -1 })]);
  check('stick up is world up', p2.input.move.y > 0.99, `y=${p2.input.move.y.toFixed(2)}`);
  readP2Input([pad(0), pad(1, { rx: 0, ry: 1 })]);
  check('the right stick aims (down)', p2.input.aim.y < -0.99, `aim=(${p2.input.aim.x.toFixed(2)},${p2.input.aim.y.toFixed(2)})`);
}

// ---------------------------------------------------------------------------
section('Player 2 winds up, releases, dashes, and eats');
{
  resetBall();
  ball.x = bounds.right - 8; // out of the dash's way: a ball in it would recoil the seal
  ball.y = bounds.bottom + 6;
  p2.pos.set(20, midWater(), 0);
  p2.vel.set(0, 0);
  p2.charge = 1;
  p2.pending = 0;
  // No free pip inside the hold: the regen clock's phase depends on how long
  // every section above ran, and a pip landing mid-hold reads as a bar that
  // did not burn.
  versusState.regenT[1] = 10;
  const hold = [pad(0), pad(1, { lx: -1, strike: true })];
  settle(1.2, hold);
  check('holding burns the bar into the wind-up', p2.pending > 0.9 && p2.charge < 0.1, `pending=${p2.pending.toFixed(2)} charge=${p2.charge.toFixed(2)}`);
  const before = p2.pos.x;
  frame([pad(0), pad(1, { lx: -1 })]);
  check('the release launches a dash', p2.active && p2.dashTimer > 0, `dashTimer=${p2.dashTimer.toFixed(2)}`);
  const c = CONFIG.strike.charge;
  const wantDur = CONFIG.strike.dashDuration * c.reachMulMax;
  check('a full wind-up buys the full reach', Math.abs(p2.dashDuration - wantDur) < 0.02, `${p2.dashDuration.toFixed(3)} vs ${wantDur.toFixed(3)}`);
  check('at the strike\'s own speed, toward the stick', p2.vel.x < -CONFIG.strike.dashSpeed * 0.8, `vx=${p2.vel.x.toFixed(1)}`);
  settle(0.6, [pad(0), pad(1)]);
  check('and it travels', p2.pos.x < before - 5, `x ${before.toFixed(1)} → ${p2.pos.x.toFixed(1)}`);
  check('the dash ends', !p2.active);

  // A tap: player 1's rule, now that player 2 runs player 1's wind-up. Under
  // minFire nothing fires, and the frame's burn stays BANKED in `pending`
  // rather than refunded — the next hold resumes the same wind-up.
  p2.charge = 1; p2.pending = 0;
  frame([pad(0), pad(1, { lx: -1, strike: true })]);
  frame([pad(0), pad(1, { lx: -1 })]);
  check('a tap fires nothing, and its burn stays banked for the next hold', !p2.active && p2.pending > 0 && Math.abs(p2.charge + p2.pending - 1) < 1e-6, `charge=${p2.charge.toFixed(3)} pending=${p2.pending.toFixed(3)}`);
  check('...the same wind-up player 1 runs: one state, one rule', p2.strike !== strikeState && typeof p2.strike.loaded === 'boolean' && typeof p2.strike.sinceLoaded === 'number');
  p2.pending = 0;

  // Chum.
  resetPickups(scene);
  p2.charge = 0.5;
  p2.vel.set(0, 0);
  spawnXpOrb(scene, { x: p2.pos.x + 1, y: p2.pos.y, z: 0 }, 1, 0.5);
  const orbs = pickups.length;
  frame([pad(0), pad(1)]);
  check('P2 eats the chum under its mouth', pickups.length === orbs - 1, `${orbs} → ${pickups.length}`);
  check('...for one pip of the bar', Math.abs(p2.charge - (0.5 + CONFIG.strike.charge.chumRefill)) < 1e-6, `charge=${p2.charge.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
section('Player 2 IS player 1: the same body, strike, ring and pose code on a second state');
{
  // A PERSON ON THE SECOND PAD, said the way the team select says it. This
  // section drives seat 1 by pad throughout, and the circle HUD is now drawn
  // only on a seat somebody is in (seatIsDriven in versus.js) — a setup that
  // never named the seat's occupant is a setup describing a bot, whatever is
  // plugged in.
  versusSetup.teams[1].members[0] = { kind: 'human', pad: 1 };
  const idle = [pad(0), pad(1)];
  const y = midWater();
  resetBall();
  ball.x = bounds.right - 8; ball.y = bounds.bottom + 6;
  // One state each, never shared.
  check('player 2 has a strike state of its own', p2.strike && p2.strike !== strikeState && p2.strike.hits !== strikeState.hits);
  check('...and a body built the way player 1\'s is', !!p2.mesh && !!p2.body && p2.mesh.parent === scene && p2.celebrateTag === 'p2' && (!CONFIG.animation.enabled || !!p2.anim), `anim ${!!p2.anim}, rig ${!!p2.aimRig}`);
  check('...and a circle HUD of its own, in the scene', !!p2.ring && p2.ring.mesh.parent === scene, `ring ${!!p2.ring}`);
  check('its stats are the run\'s', p2.stats === player.stats);

  // THE RING FOLLOWS IT and is cut into the same pips.
  p2.pos.set(10, y, 0); p2.vel.set(0, 0);
  frame(idle);
  const ringCfg = CONFIG.strike.ring;
  check('the ring rides on player 2', Math.abs(p2.ring.mesh.position.x - (p2.pos.x + (ringCfg.offsetX ?? 0))) < 1e-6 && p2.ring.mesh.visible, `ring x ${p2.ring.mesh.position.x.toFixed(1)} vs seal ${p2.pos.x.toFixed(1)}`);
  check('...cut into the run\'s pip count', p2.ring.pipAnim().count === pipCount(player.stats), `${p2.ring.pipAnim().count} vs ${pipCount(player.stats)}`);

  // THE PERFECT CHARGE lands on player 2's state, and only there.
  p2.charge = 1; p2.pending = 0;
  versusState.regenT[1] = 10;
  strikeState.loaded = false; strikeState.perfect = false;
  settle(1.4, [pad(0), pad(1, { lx: -1, strike: true })]);
  check('a full hold loads player 2\'s wind-up: the STRIKE NOW moment', p2.strike.loaded === true && p2.strike.perfect === true, `loaded ${p2.strike.loaded}, perfect ${p2.strike.perfect}`);
  check('...and not player 1\'s', strikeState.loaded === false && strikeState.perfect === false);
  // The release: the dash IS STEERED. Let go toward -x, then push the stick
  // straight up: the heading bends toward it while the dash is still live
  // (dashSteer in updatePlayer), which the old flat dash never did.
  frame([pad(0), pad(1, { lx: -1 })]);
  check('the release launches along the stick', p2.active && p2.vel.x < -30 && Math.abs(p2.vel.y) < 5, `v=(${p2.vel.x.toFixed(1)},${p2.vel.y.toFixed(1)})`);
  const v0y = p2.vel.y;
  for (let i = 0; i < 6 && p2.active; i++) frame([pad(0), pad(1, { ly: -1 })]); // ly is inverted on a pad: -1 is up
  check('a stick pushed across a live dash bends it', p2.active && p2.vel.y > v0y + 8, `vy ${v0y.toFixed(1)} → ${p2.vel.y.toFixed(1)} while dashing`);
  const speedMid = p2.vel.length();
  check('...at the dash\'s speed, not the swim\'s', speedMid > CONFIG.player.maxSpeed, `${speedMid.toFixed(1)} > ${CONFIG.player.maxSpeed}`);
  // Let it run out: the follow-through hands the wheel back over a window.
  for (let i = 0; i < 60 && p2.active; i++) frame(idle);
  check('the dash ends on its own clock', !p2.active);
  check('...into player 1\'s follow-through window', (CONFIG.strike.dashControl?.followThrough ?? 0) <= 0 || p2.strike.steerGrace > 0, `steerGrace ${p2.strike.steerGrace.toFixed(2)}`);

  // FACING AND THE MIRROR ROLL — poseBody on the second body. Swim left,
  // then right: the container turns and the side-view mirror flips through
  // the same eased roll.
  p2.vel.set(0, 0); p2.pos.set(0, y, 0);
  settle(1.5, [pad(0), pad(1, { lx: -1 })]);
  const facingLeft = Math.cos(p2.mesh.rotation.z + Math.PI / 2);
  check('swimming left, the body faces left', facingLeft < -0.9 && (CONFIG.view !== 'side' || p2.mirrored === true), `facing x ${facingLeft.toFixed(2)}, mirrored ${p2.mirrored}`);
  // Long enough to reverse out of a 15 u/s swim AND roll the whole half turn
  // (CONFIG.player.turnAroundDuration, tuned near a second).
  settle(1.5 + 2 * (CONFIG.player.turnAroundDuration ?? 0.35), [pad(0), pad(1, { lx: 1 })]);
  const facingRight = Math.cos(p2.mesh.rotation.z + Math.PI / 2);
  check('...and right when it turns round, the mirror rolled with it', facingRight > 0.9 && (CONFIG.view !== 'side' || (p2.mirrored === false && Math.abs(p2.mirrorAngle) < 1e-6)), `facing x ${facingRight.toFixed(2)}, mirrored ${p2.mirrored}, angle ${p2.mirrorAngle.toFixed(2)}`);
  check('the body transform is player 1\'s composition', p2.body.quaternion.lengthSq() > 0.99);
  // The clip state machine reads its speed like player 1's.
  if (p2.anim) {
    check('the clip controller ticks on player 2', typeof p2.anim.update === 'function' && typeof p2.anim.isPlayingOneShot === 'function');
  }
  p2.vel.set(0, 0);
  p2.pos.set(30, y, 0);
  settle(0.3, idle);
  // ...and the seat handed back, so the sections after this one open on the
  // setup they were written against: nobody named, which is a bot.
  versusSetup.teams[1].members.length = 0;
}

// ---------------------------------------------------------------------------
section('A bot winds up in silence: the charge sound is the listener\'s own thumb');
{
  // THE PICTURE IS EVERY SEAL'S, THE SOUND IS THE PLAYER'S. A wind-up rumbles,
  // glows and coils on any seal, bot or not — that is what a seal charging
  // looks like. The voice is different: it is a readout of a button somebody is
  // holding, and a roster of bots laid seven risers and seven perfect-charge
  // stings over the one the player could act on. `sfxSkip` carries that (see
  // systems/feedback.js): the event still fires, the voice does not.
  const events = [];
  const off = onFeedback((name, at) => {
    if (name === 'strikeCharging' || name === 'strikePerfect') events.push({ name, ...at });
  });
  const holdSeat1 = [pad(0), pad(1, { strike: true })];
  const windUp = () => {
    events.length = 0;
    p2.charge = 1; p2.pending = 0;
    p2.strike.loaded = false; p2.strike.perfect = false;
    versusState.regenT[1] = 10;
    p2.pos.set(30, midWater(), 0); p2.vel.set(0, 0);
    settle(1.4, holdSeat1);
    settle(0.2, [pad(0), pad(1)]);
  };

  // Nobody named in seat 1 is a bot — the default this file opens on.
  versusSetup.teams[1].members.length = 0;
  windUp();
  const botHeld = events.filter((e) => e.name === 'strikeCharging');
  const botPerfect = events.filter((e) => e.name === 'strikePerfect');
  check('a bot\'s wind-up still fires its rumble', botHeld.length > 0, `${botHeld.length} pulses`);
  check('...and still reaches the perfect charge', botPerfect.length === 1, `${botPerfect.length}`);
  check('...but every pulse is muted', botHeld.every((e) => e.sfxSkip === true));
  check('...and so is the perfect-charge sting', botPerfect.every((e) => e.sfxSkip === true));
  check('...while the rumble keeps its strength — sfxSkip is the voice, not the event',
    botHeld.some((e) => (e.scale ?? 0) > 0.35), `top scale ${Math.max(0, ...botHeld.map((e) => e.scale ?? 0)).toFixed(2)}`);

  // A PERSON on the same seat, said the way the team select says it.
  versusSetup.teams[1].members[0] = { kind: 'human', pad: 1 };
  windUp();
  const humanHeld = events.filter((e) => e.name === 'strikeCharging');
  const humanPerfect = events.filter((e) => e.name === 'strikePerfect');
  check('a person on seat 1 hears their own wind-up', humanHeld.length > 0 && humanHeld.every((e) => !e.sfxSkip), `${humanHeld.length} pulses`);
  check('...and their perfect charge', humanPerfect.length === 1 && humanPerfect.every((e) => !e.sfxSkip), `${humanPerfect.length}`);
  versusSetup.teams[1].members.length = 0;

  off();
  p2.charge = 1; p2.pending = 0;
  settle(0.2, [pad(0), pad(1)]);
}

// ---------------------------------------------------------------------------
section('P2 rams the ball too, and the ball stays in the arena');
{
  resetBall();
  p2.pos.set(ball.x + ballReach() - 0.4, ball.y, 0);
  p2.vel.set(-20, 0);
  p2.active = true; p2.dashTimer = 0.3; p2.dashTimeLeft = 0.3; p2.power = 0.5;
  p2.dashDir.x = -1; p2.dashDir.y = 0;
  frame([pad(0), pad(1)]);
  check('P2\'s dash shoves the ball the other way', ball.vx < -V.ball.strikeImpulse * 0.8, `vx=${ball.vx.toFixed(1)}`);
  // Let it fly about for a while at speed: never out, never NaN, never faster than max.
  resetBall();
  ball.vx = 60; ball.vy = 45;
  let ok = true;
  let fastest = 0;
  for (let i = 0; i < 600 && versusState.phase === 'play'; i++) {
    frame([pad(0), pad(1)]);
    const s = Math.hypot(ball.vx, ball.vy);
    fastest = Math.max(fastest, s);
    if (!Number.isFinite(ball.x + ball.y + s)) { ok = false; break; }
    if (ball.live && (ball.y < bounds.bottom + ball.r - 0.01 || ball.y > bounds.top - ball.r + 0.01)) { ok = false; break; }
  }
  check('ten seconds of ricochet stay finite and inside the water column', ok, `fastest ${fastest.toFixed(1)}`);
  check('the speed cap holds', fastest <= ballSpeedCap() + 1e-6, `${fastest.toFixed(1)} ≤ ${ballSpeedCap()} (maxSpeed ${V.ball.maxSpeed} is the looks' "fast", contest.speedCap the ball's ceiling)`);
}

// ---------------------------------------------------------------------------
section('The ball through the surface: its own breach and re-entry');
{
  toPlay();
  fired.clear();
  resetBall();
  player.mesh.position.set(-40, midWater(), 0); player.velocity.set(0, 0); strikeState.active = false;
  p2.pos.set(40, midWater(), 0); p2.vel.set(0, 0);
  ball.x = 0; ball.y = bounds.surfaceY - 6; ball.vx = 0; ball.vy = 40;
  versusState.lastCross = null;
  let up = null;
  for (let i = 0; i < 60 && !up; i++) { frame(); if (versusState.lastCross) up = { ...versusState.lastCross }; }
  check('leaving the water is the ball\'s breach', !!up && up.dir === 1 && firedCount('versusBallBreach') === 1, up ? `dir ${up.dir}, strength ${up.t.toFixed(2)}` : 'no crossing');
  check('...fired at the waterline, not on the rim', !!versusState.lastImpact && Math.abs(versusState.lastImpact.y - bounds.surfaceY) < 1e-6 && versusState.lastImpact.event === 'versusBallBreach', `y=${versusState.lastImpact?.y?.toFixed(2)} vs surface ${bounds.surfaceY}`);
  check('...in the ball\'s colour', versusState.lastImpact?.color === ballTint().getHex());
  let down = null;
  for (let i = 0; i < 240 && !down; i++) { frame(); if (versusState.lastCross && versusState.lastCross.dir === -1) down = { ...versusState.lastCross }; }
  check('coming back is its re-entry, once', !!down && firedCount('versusBallReentry') === 1, `breach ${firedCount('versusBallBreach')}, re-entry ${firedCount('versusBallReentry')}`);
  check('the events are rows in CONFIG.feedback with the seal\'s voices', !!CONFIG.feedback.versusBallBreach?.sfx && !!CONFIG.feedback.versusBallReentry?.sfx && CONFIG.feedback.versusBallBreach.emit === 'splash' && CONFIG.feedback.versusBallReentry.emit === 'reentry');
  // A ball rolling under the surface never crosses.
  fired.clear(); resetBall(); ball.y = bounds.surfaceY - 8; ball.vx = 20; ball.vy = 0;
  settle(0.5);
  check('a ball staying under fires neither', firedCount('versusBallBreach') === 0 && firedCount('versusBallReentry') === 0);
}

// ---------------------------------------------------------------------------
section('The mix follows the BALL down, not a seal');
{
  // In a run the music's low-pass and the SFX bus track the player's depth, and
  // that is the player hearing the water close over their own head. A match has
  // two seals in two places and the camera on NEITHER of them — it is on the
  // ball — so player 1's Y would muffle both players' mix from one side of a
  // shared screen while the picture was somewhere else. main.js reads
  // versusMixDepth() while the flag is on; this is what it has to answer.
  toPlay();
  resetBall();
  // Pulled as far apart as the arena allows: the ball on the floor, player 1
  // out of the water, player 2 at midwater. With the three anywhere near each
  // other every assertion below would pass on the version that reads a seal.
  ball.x = 0; ball.y = bounds.bottom + 4; ball.vx = 0; ball.vy = 0;
  player.mesh.position.set(-30, bounds.surfaceY + 3, 0); player.velocity.set(0, 0);
  p2.pos.set(30, midWater(), 0); p2.vel.set(0, 0);
  frame();
  check('the mix sits at the ball', Math.abs(versusMixDepth() - ball.y) < 1e-9,
    `mix ${versusMixDepth().toFixed(2)}, ball ${ball.y.toFixed(2)}`);
  // ...and it is not either seal, which is the whole bug. Asserted through the
  // cutoff rather than only on the Y, because the cutoff is what a player
  // actually hears and it is where a depth that never reached the filter would
  // still look right.
  const deep = cutoffForDepth(versusMixDepth());
  check('...and that is audibly not player 1, who is in the air',
    deep < cutoffForDepth(player.mesh.position.y) * 0.9,
    `${Math.round(deep)}Hz at the ball vs ${Math.round(cutoffForDepth(player.mesh.position.y))}Hz at the breaching seal`);
  check('...nor player 2, who is at midwater',
    deep < cutoffForDepth(p2.pos.y) * 0.95,
    `${Math.round(deep)}Hz vs ${Math.round(cutoffForDepth(p2.pos.y))}Hz`);
  // It MOVES with the ball rather than being read once. A ball driven up
  // through the water opens the lid on the way.
  ball.y = bounds.bottom + 4; ball.vy = 60;
  const shut = cutoffForDepth(versusMixDepth());
  settle(0.4);
  check('the lid opens as the ball rises', cutoffForDepth(versusMixDepth()) > shut * 1.05 && versusMixDepth() > bounds.bottom + 4,
    `${Math.round(shut)}Hz → ${Math.round(cutoffForDepth(versusMixDepth()))}Hz, ball y ${versusMixDepth().toFixed(1)}`);

  // EVERY PHASE, not just live play. versusMixDepth has no phase test in it —
  // it reads ball.y and trusts that a match always writes it — so the three
  // paths that write it are the thing to pin down. Frozen in any one of them,
  // the mix would sit at whatever depth the last live frame left behind, which
  // is the kind of fault nobody hears as a bug.
  //
  // A KICKOFF: the ball is put back at the centre spot by resetBall.
  const beforeKick = versusMixDepth();
  enterKickoff();
  frame();
  check('a kickoff moves it with the ball to the centre spot',
    Math.abs(versusMixDepth() - ball.y) < 1e-9 && Math.abs(versusMixDepth() - midWater()) < 3
      && Math.abs(versusMixDepth() - beforeKick) > 1,
    `${beforeKick.toFixed(1)} → ${versusMixDepth().toFixed(1)} (midwater ${midWater().toFixed(1)})`);

  // A REPLAY: ball.y is driven off the recorded frames by poseReplay, so the
  // mix follows the SHOT being played back rather than parking where the live
  // ball was abandoned when the goal was called.
  //
  // stageReplay writes versusState.lastGoal and lastTouch — it has to, since a
  // lab has no match to read them off — and the goal card's section further
  // down asks the real ones for their credit. Put back below, or a staged clip
  // here fails an assertion two hundred checks away with nothing to connect
  // the two.
  const savedGoal = versusState.lastGoal;
  const savedTouch = versusState.lastTouch;
  toPlay();
  resetBall();
  ball.x = 0; ball.y = midWater(); ball.vx = 30; ball.vy = -55;
  // makeReplayFrame() is the EMPTY frame the ring buffer is made of, not a
  // snapshot — a lab fills it, which is what it is exported for.
  const clip = [];
  let clipT = 0;
  for (let i = 0; i < 40; i++) {
    frame();
    clipT += dt;
    const f = makeReplayFrame();
    f.t = clipT; f.bx = ball.x; f.by = ball.y; f.bang = ball.angle; f.bspin = ball.spin;
    for (let k = 0; k < f.rim.length && k < ball.rim.length; k++) f.rim[k] = ball.rim[k];
    // Strokes on the ball, recorded the way the match recorder does it —
    // a spin the square-on flight above never had, so the posed set can
    // only have come from the record. One clean set: frame() fed the live
    // strokes a spin of ~0 and marked them dying, so they are cleared
    // rather than left to pile up a set a frame.
    spinStreaks.length = 0;
    updateBallSpin(9, dt);
    recordBallSpin(f.spin);
    clip.push(f);
  }
  const liveStrokes = clip.map((f) => f.spin[0]);
  spinStreaks.length = 0;
  const climbed = clip.map((f) => f.by);
  const staged = stageReplay({
    frames: clip, touchT: clip[2].t, goalT: clip[clip.length - 1].t, side: -1, who: 0,
  });
  check('a clip stages', staged === true && replayState.active === true);
  if (staged) {
    const seen = new Set();
    for (let i = 0; i < 40 && replayState.active; i++) {
      stepStagedReplay(dt, { explode: false });
      seen.add(Math.round(versusMixDepth() * 100));
      if (Math.abs(versusMixDepth() - ball.y) > 1e-9) seen.add('adrift');
    }
    check('...and the mix rides the replayed ball, not the frozen one',
      seen.size > 3 && !seen.has('adrift'),
      `${seen.size} depths over the playback, recorded range ${Math.min(...climbed).toFixed(1)}..${Math.max(...climbed).toFixed(1)}`);
    // THE STROKES ARE THE RECORD'S: the set on the ball is the set the frame
    // pair round the replay's clock recorded, lerped — not a set simulated
    // off the posed spin (which is ~0 here) and not the goal's leftovers.
    const rt = replayState.t;
    let j = 1;
    while (j < clip.length - 1 && clip[j].t < rt) j++;
    const fa = clip[j - 1]; const fb = clip[j];
    const uu = Math.max(0, Math.min(1, (rt - fa.t) / Math.max(1e-9, fb.t - fa.t)));
    const wantN = fa.spin[0];
    const wantPhase = fa.spin[1] + (fb.spin[1] - fa.spin[1]) * uu;
    check('a staged replay poses the strokes the frames recorded', wantN > 0 && spinStreaks.length === wantN && Math.abs(spinStreaks[0].phase - wantPhase) < 1e-5, `${spinStreaks.length} stroke(s) (recorded ${liveStrokes.join('')}), phase ${spinStreaks[0]?.phase.toFixed(3)} vs record ${wantPhase.toFixed(3)} at t ${rt.toFixed(3)}`);
    endStagedReplay();
  }
  versusState.lastGoal = savedGoal;
  versusState.lastTouch = savedTouch;
}

// ---------------------------------------------------------------------------
section('Pinched against the rock, the ball squeezes and squirts along it');
{
  toPlay();
  resetEnemies(scene);
  resetBall();
  const P = V.ball.pinch;
  const gy = midWater();
  const h = mouthHalfHeight();
  p2.pos.set(40, gy, 0); p2.vel.set(0, 0);
  // On the floor, a seal above it pressing down and a little to the right:
  // rock under it, seal on top. (The floor rather than a wall so the squirt
  // has nowhere to fall — a wall's squirt runs the ball down into the mouth.)
  const rest = ballRestRadius();
  ball.x = 0; ball.y = bounds.bottom + rest + 0.1; ball.vx = 0; ball.vy = -4;
  const press = () => {
    // Down and a little to the right, on the ball's own drawn edge in that
    // direction — the reach is not one number any more.
    const r = ballContactReach(Math.atan2(0.94, 0.34)) - 0.7;
    player.mesh.position.set(ball.x + r * 0.34, ball.y + r * 0.94, 0);
    player.velocity.set(-5, -14);
  };
  strikeState.active = false;
  const x0 = ball.x;
  // TWENTY FRAMES, NOT FORTY. The squeeze is at its max inside ten (rate 5/s
  // to a cap of 0.5) and the ball is squirting along the floor the whole
  // time. It used to shrink out of the seal's reach and stop being bumped;
  // now it FLATTENS instead, stays in contact, and is still being shoved —
  // so by forty frames it has crossed the arena and bounced off the far
  // wall, and every measurement below is of a ball on the rebound.
  for (let i = 0; i < 20; i++) { press(); frame(); }
  check('the squeeze builds under the pinch', ball.squeeze > 0.3, `squeeze ${ball.squeeze.toFixed(2)} (max ${P.max})`);
  // IT FLATTENS RATHER THAN SHRINKING, and it collides as the shape it draws:
  // the pinch's squash is a cos(2θ) mode, so the body gives along the axis it
  // is squeezed on and swells across it. The hitbox is the drawn edge, so
  // this is one measurement of one shape rather than a look and a radius that
  // have to be checked against each other.
  const hitUp = ballHitRadiusAt(Math.PI / 2);
  const hitAcross = ballHitRadiusAt(0);
  check('...and it collides FLATTER, not smaller — the drawn shape exactly',
    hitUp < rest - 0.5 && hitAcross > rest + 0.3 && ball.y < bounds.bottom + rest * 0.9,
    `hit up ${hitUp.toFixed(2)}, across ${hitAcross.toFixed(2)}, rest ${rest.toFixed(2)}; y ${ball.y.toFixed(2)} vs floor ${bounds.bottom.toFixed(2)} (a round ball sits at ${(bounds.bottom + rest).toFixed(2)})`);
  // By WORLD angle: the rim's samples ride round with the spin the seal's
  // friction put on it, so sample n/4 is not the top.
  const up = rimRadiusAt(Math.PI / 2); const across = rimRadiusAt(0);
  check('...flattened along the pinch in the look', up < ball.r - 0.15 && across > ball.r + 0.12 && across - up > 0.3, `rim up ${up.toFixed(2)}, across ${across.toFixed(2)}`);
  check('...and it squirts along the rock, away from the side the seal is on', ball.x < x0 - 2 && ball.vx < -3, `x ${x0.toFixed(1)} → ${ball.x.toFixed(1)}, vx ${ball.vx.toFixed(1)}`);
  // Let go: the seal away, the ball fills back out.
  player.mesh.position.set(-30, gy, 0); player.velocity.set(0, 0);
  // AND STOPPED. The drawn edge carries the velocity stretch as well as the
  // pinch, so a ball still squirting at speed is an ellipse for an honest
  // reason and would answer this question about the wrong thing.
  ball.x = 0; ball.y = gy; ball.vx = 0; ball.vy = 0; ball.spin = 0;
  settle(1.2);
  check('released, it is round again',
    ball.squeeze === 0
      && Math.abs(ballHitRadiusAt(Math.PI / 2) - rest) < rest * 0.06
      && Math.abs(ballHitRadiusAt(0) - rest) < rest * 0.06,
    `squeeze ${ball.squeeze.toFixed(3)}, up ${ballHitRadiusAt(Math.PI / 2).toFixed(2)} vs across ${ballHitRadiusAt(0).toFixed(2)} (rest ${rest.toFixed(2)})`);
  // A seal alone, or rock alone, is not a pinch.
  resetBall(); ball.x = 0; ball.y = gy;
  press(); frame(); press(); frame();
  check('a seal alone does not squeeze it', ball.squeeze === 0);
  resetBall(); ball.x = 0; ball.y = bounds.bottom + rest + 0.5; ball.vy = -30;
  settle(0.3);
  check('the rock alone does not squeeze it', ball.squeeze === 0);
  player.mesh.position.set(-30, gy, 0);
}

// ---------------------------------------------------------------------------
section('A shove is a jostle: the loser is thrown and falls hard, the winner recoils');
{
  toPlay();
  resetBall(); ball.x = bounds.right - 10; ball.y = bounds.bottom + 6;
  const y = midWater();
  const cr = V.bodyCheck.contactRadius;
  const B = V.bodyCheck;
  // P1 dashing +x at full power into P2 sitting still: P1 wins the contest.
  player.mesh.position.set(0, y, 0); player.velocity.set(40, 0); player.knockX = player.knockY = 0;
  player.jolt.spin = player.jolt.spinV = player.jolt.roll = player.jolt.rollV = 0; player.heavyT = 0;
  p2.pos.set(cr * 2 - 0.5, y, 0); p2.vel.set(0, 0); p2.knockX = p2.knockY = 0;
  p2.jolt.spin = p2.jolt.spinV = p2.jolt.roll = p2.jolt.rollV = 0; p2.heavyT = 0;
  cancelDash(p2.strike); p2.dashTimer = 0;
  strikeState.active = true; strikeState.power = 1; strikeState.dashDir.x = 1; strikeState.dashDir.y = 0;
  versusState.checked[0] = versusState.checked[1] = false;
  frame();
  strikeState.active = false;
  const chk = versusState.lastCheck;
  check('the dasher wins the contest and the other seal is the loser', !!chk && chk.loser === 1 && chk.margin > 0, chk ? `margin ${chk.margin.toFixed(1)}, loser ${chk.loser}` : 'no check');
  check('the loser takes part of the shove as real velocity', p2.vel.x > B.knock * B.velShare * 0.5, `vx ${p2.vel.x.toFixed(1)}`);
  check('...and the rest as the knock', p2.knockX > 0, `knock ${p2.knockX.toFixed(1)}`);
  check('...and its skeleton is jolted — a tumble and a roll', (Math.abs(p2.jolt.spin) + Math.abs(p2.jolt.spinV)) > 0.2 && (Math.abs(p2.jolt.roll) + Math.abs(p2.jolt.rollV)) > 0.2, `spin ${p2.jolt.spin.toFixed(3)} (${p2.jolt.spinV.toFixed(2)}/s), roll ${p2.jolt.roll.toFixed(3)} (${p2.jolt.rollV.toFixed(2)}/s)`);
  check('...and it will fall hard for a while', p2.heavyT > 0 && p2.heavyMul >= B.fallMul, `heavy ${p2.heavyT.toFixed(2)}s x${p2.heavyMul}`);
  check('the winner recoils, smaller', Math.abs(player.jolt.spinV) > 0 && Math.abs(player.jolt.spinV) < (Math.abs(p2.jolt.spinV) + Math.abs(p2.jolt.spin) * 10) * 0.6 && player.velocity.x < 40, `winner spin impulse ${player.jolt.spinV.toFixed(2)} vs loser ${p2.jolt.spinV.toFixed(2)}; vx ${player.velocity.x.toFixed(1)}`);
  // THE RINGS. A body check is two animals colliding, and what that should do
  // to the backdrop is a set of rings LEAVING the point of impact — not one
  // expanding circle, which is the only shape a single ripple can make. Counted
  // through a stub grid rather than asserted off the config row: `rings` is
  // spent in systems/feedback.js and a number nothing consumed would sit in the
  // table looking correct forever.
  {
    const rip = CONFIG.feedback.bodyCheck.ripple;
    const seen = [];
    initFeedback({ ripple: (x, y, strength, radius) => seen.push({ x, y, strength, radius }) });
    feedback('bodyCheck', { x: 7, y: -3, scale: 1 });
    initFeedback(null);
    check('a body check puts more than one ring in the water', seen.length === rip.rings,
      `${seen.length} ring(s), row says ${rip.rings}`);
    check('...all of them at the point of impact', seen.every((r) => r.x === 7 && r.y === -3));
    check('...each wider than the last', seen.every((r, i) => i === 0 || r.radius > seen[i - 1].radius),
      seen.map((r) => r.radius.toFixed(1)).join(' → '));
    check('...and weaker for it, so the tight one is still the loudest',
      seen.every((r, i) => i === 0 || r.strength < seen[i - 1].strength),
      seen.map((r) => r.strength.toFixed(2)).join(' → '));
    check('...and the outermost reaches well past a single ripple',
      seen[seen.length - 1].radius > rip.radius * 2,
      `${seen[seen.length - 1].radius.toFixed(1)} against a base of ${rip.radius}`);
    // A row with no `rings` is one ripple, exactly as it always was.
    const one = [];
    initFeedback({ ripple: (x, y, strength, radius) => one.push({ strength, radius }) });
    feedback('versusRespawn', { x: 0, y: 0, scale: 1 });
    initFeedback(null);
    check('...while a row that asks for none still fires exactly one', one.length === 1);
  }

  // ...AND IT IS A RAGDOLL, not a wobble. A check at this speed is well over
  // `limpAt`, so the righting spring is switched off for a window sized by how
  // hard it was — see limpFor and the note in jostle.
  check('a hard check leaves the loser limp, not merely wobbling', p2.jolt.free > 0, `free ${p2.jolt.free.toFixed(2)}s`);
  check('...for a window inside the authored range', p2.jolt.free >= B.jolt.limpMin && p2.jolt.free <= B.jolt.limpMax,
    `${p2.jolt.free.toFixed(2)}s (${B.jolt.limpMin}..${B.jolt.limpMax})`);
  // LONGER FOR A BIGGER HIT, which is the whole reason the window is a curve
  // rather than a constant. Measured on limpFor rather than by staging two
  // more collisions: the function IS the rule, and both callers (jostle and
  // the goal blast) go through it.
  check('...and a bigger shove buys a longer one', limpFor(B.jolt.limpFull) > limpFor(B.jolt.limpAt + 8) && limpFor(B.jolt.limpAt + 8) > limpFor(B.jolt.limpAt + 1),
    `${limpFor(B.jolt.limpAt + 1).toFixed(2)}s → ${limpFor(B.jolt.limpAt + 8).toFixed(2)}s → ${limpFor(B.jolt.limpFull).toFixed(2)}s`);
  check('...and it never runs past limpMax however hard the hit', limpFor(1e4) === B.jolt.limpMax);
  check('...and a shove under limpAt is still the old wobble', limpFor(B.jolt.limpAt - 1) === 0 && limpFor(B.jolt.limpAt + 0.1) > 0);
  check('...and the skeleton is handed a shove to hang off', p2.jolt.kick > 0, `kick ${p2.jolt.kick.toFixed(1)}`);
  // The jolt rights itself. Longer than it used to need: the limp window above
  // is time the spring is not running, and the free tumble hands it a bigger
  // angle to come back from than a sprung jolt ever reached.
  p2.pos.set(30, y, 0); p2.vel.set(0, 0); p2.knockX = p2.knockY = 0;
  settle(4.5, [pad(0), pad(1)]);
  check('the jolt springs back to true', Math.abs(p2.jolt.spin) < 0.02 && Math.abs(p2.jolt.roll) < 0.02, `spin ${p2.jolt.spin.toFixed(3)} roll ${p2.jolt.roll.toFixed(3)}`);
  check('...and the ragdoll window is over with it', p2.jolt.free === 0);
  // HEAVY: the same seal out of the water, with and without the weight.
  const fall = (heavy) => {
    p2.pos.set(30, bounds.surfaceY + 6, 0); p2.vel.set(0, 0); p2.knockX = p2.knockY = 0;
    p2.heavyT = heavy ? 1 : 0; p2.heavyMul = heavy ? B.fallMul : 1;
    for (let i = 0; i < 6; i++) frame([pad(0), pad(1)]);
    return -p2.vel.y;
  };
  const plain = fall(false);
  const hard = fall(true);
  check(`knocked into the air it falls ${B.fallMul}x harder`, hard > plain * (B.fallMul * 0.8) && plain > 0, `${hard.toFixed(1)} vs ${plain.toFixed(1)} u/s after six frames`);
  p2.heavyT = 0; p2.heavyMul = 1;
  player.jolt.spin = player.jolt.spinV = player.jolt.roll = player.jolt.rollV = 0;
  player.velocity.set(0, 0); player.knockX = player.knockY = 0; player.heavyT = 0;
  p2.pos.set(40, y, 0);
}

// ---------------------------------------------------------------------------
section('English bends the flight, hard');
{
  toPlay();
  resetEnemies(scene); // a clear lane: the ball loses speed through every fish (ballHits)
  const gy = midWater();
  player.mesh.position.set(-40, gy, 0); player.velocity.set(0, 0); strikeState.active = false;
  p2.pos.set(40, gy + 15, 0); p2.vel.set(0, 0);
  const flight = (english) => {
    resetBall(); ball.x = -20; ball.y = gy;
    strikeBallFrom({ x: ball.x - 6, y: ball.y }, { x: 1, y: 0 }, 46, 1, english);
    const spin0 = ball.spin;
    // Clear of the striker before the frames run, so the seal does not touch it again.
    player.mesh.position.set(-60, gy - 20, 0);
    for (let i = 0; i < 45; i++) frame();
    return { dy: ball.y - gy, dx: ball.x + 20, spin0 };
  };
  const straight = flight(0);
  const hooked = flight(1);
  const im = V.ball.impact;
  check('a square shot flies straight', Math.abs(straight.dy) < 1.5, `dy ${straight.dy.toFixed(2)} over ${straight.dx.toFixed(1)}`);
  check('full english puts the spin near its cap', Math.abs(hooked.spin0) > im.spinCap * 0.6, `spin ${hooked.spin0.toFixed(1)} of cap ${im.spinCap}`);
  check('...and the flight bends by several body lengths inside a second', Math.abs(hooked.dy) > 8 && Math.abs(hooked.dy) > Math.abs(straight.dy) * 4, `dy ${hooked.dy.toFixed(1)} over ${hooked.dx.toFixed(1)} (curve ${im.curve})`);
  check('the curve is the renamed key: the snapshot\'s magnus no longer binds', typeof im.curve === 'number' && im.curve >= 0.03 && im.spinCap >= 24 && (V.ball.english.slip ?? 0) >= 40, `curve ${im.curve}, cap ${im.spinCap}, slip ${V.ball.english.slip}`);
  player.mesh.position.set(-40, gy, 0);
}

// ---------------------------------------------------------------------------
section('The goal card: a name and the clock, no number');
{
  check('each seal has a name off the table', versusState.names[0] && versusState.names[1] && versusState.names[0] !== versusState.names[1], versusState.names.join(' / '));
  check('the clock formats as m:ss', formatClock(0) === '0:00' && formatClock(65.9) === '1:05' && formatClock(600) === '10:00');
  const savedTouches = versusState.touches.slice();
  // A touch, with what it did to the ball: `vx0` in, `vx1` out. Team 1 scores
  // by sending the ball LEFT (team 0 defends the left mouth), so a shot at
  // team 0's goal is a negative vx.
  const touch = (t, who, vx0, vx1) => ({ t, who, kind: 'strike', x: 0, y: 0, vx0, vy0: 0, vx1, vy1: 0 });
  const only = (...ts) => { versusState.touches.length = 0; versusState.touches.push(...ts); };

  only(touch(10, 1, 0, -30));
  let c = creditGoal(1, 12);
  check('the seal that struck it is the scorer, by name', c.who === 1 && c.name === versusState.names[1] && !c.ownGoal && c.assist === -1 && c.time === '0:12', JSON.stringify(c));
  check('a one-a-side match never has an assist', c.assist === -1 && c.assistName === '');

  // THE GRAZE. Seal 1 blasts it at team 0's goal; it clips seal 0 on the way
  // in, which barely moves it. The goal is seal 1's and it is not an own goal.
  only(touch(10, 1, 0, -40), touch(11.6, 0, -40, -38));
  c = creditGoal(1, 12);
  check('a graze on a defender is not an own goal', !c.ownGoal, JSON.stringify(c));
  check('...it is credited to the seal that struck it', c.who === 1, `named ${c.who}, gain ${c.gain.toFixed(1)}`);

  // A block that slows the ball and goes in anyway: still not the defender's.
  only(touch(10, 1, 0, -50), touch(11.7, 0, -50, -22));
  c = creditGoal(1, 12);
  check('a defender who only slowed it does not concede it', !c.ownGoal && c.who === 1, JSON.stringify(c));

  // THE REAL OWN GOAL. The ball is heading AWAY from team 0's mouth and seal 0
  // knocks it backwards in.
  only(touch(10, 1, 0, 12), touch(11.8, 0, 12, -26));
  c = creditGoal(1, 12);
  check('knocking it backwards into your own net is an own goal', c.ownGoal && c.who === 0, JSON.stringify(c));

  // ...and a defender's mistake an attacker then hits is the attacker's goal.
  only(touch(10, 1, 0, 12), touch(11, 0, 12, -26), touch(11.5, 1, -26, -44));
  c = creditGoal(1, 12);
  check('an attacker touching it last takes it back off the defender', !c.ownGoal && c.who === 1, JSON.stringify(c));

  // THE ASSIST: the pass before the strike, by a different seal of the side.
  setMatchRoster(2);
  only(touch(9, 3, 0, -8), touch(10, 1, -8, -40));
  c = creditGoal(1, 12);
  check('the pass before the shot is the assist', c.who === 1 && c.assist === 3, JSON.stringify(c));
  // ...and the biggest claim wins even when a teammate touched it last: a
  // team-mate's fin on a shot already going in is a deflection, not a goal
  // and not an assist either (an assist is a touch BEFORE the shot).
  only(touch(10, 1, 0, -46), touch(11.5, 3, -46, -47));
  c = creditGoal(1, 12);
  check('the hardest touch takes the goal, not the last one', c.who === 1 && c.assist === -1, JSON.stringify(c));
  setMatchRoster(1);

  versusState.touches.length = 0; versusState.touches.push(...savedTouches);
  check('the card\'s lines are copy rows, staged for Ethan', uiText('versusAssist') !== 'versusAssist' && uiText('versusOwnGoal') !== 'versusOwnGoal' && /\{name\}/.test(uiText('versusAssist')));
  const lg = versusState.lastGoal;
  check('the last goal carries its credit', !!lg?.credit && typeof lg.credit.time === 'string' && typeof lg.credit.name === 'string', lg ? JSON.stringify(lg.credit) : 'no goal yet');
}

// ---------------------------------------------------------------------------
section('Where it is hit, and how hard');
{
  // The ricochet above may have ended in a goal: back to live play, or every
  // frame here runs on the shutter's 4% clock.
  versusState.phase = 'play'; versusState.phaseT = 0;
  const im = V.ball.impact;
  const R = ballContactReach(Math.PI) - 0.3;
  const hitFrom = (angle, dir, speed, power) => {
    resetBall();
    ball.vx = ball.vy = 0;
    const at = { x: ball.x + Math.cos(angle) * (R + 4), y: ball.y + Math.sin(angle) * (R + 4) };
    return { hit: strikeBallFrom(at, dir, speed, power), at };
  };
  // Square: from the left, dashing +x.
  let r = hitFrom(Math.PI, { x: 1, y: 0 }, 46, 1);
  check('a square hit lands', !!r.hit && typeof r.hit === 'object', JSON.stringify(r.hit && { imp: +r.hit.imp.toFixed(1), off: +r.hit.off.toFixed(2) }));
  check('...and goes straight along the dash', ball.vx > 40 && Math.abs(ball.vy) < 0.5, `v=(${ball.vx.toFixed(1)},${ball.vy.toFixed(1)})`);
  check('...with no spin', Math.abs(ball.spin) < 1e-6, `spin=${ball.spin.toFixed(3)}`);
  const squareV = Math.hypot(ball.vx, ball.vy);

  // Glancing: contact on the ball's upper-left, dash straight +x.
  r = hitFrom(Math.PI * 0.75, { x: 1, y: 0 }, 46, 1);
  check('a glancing hit leaves between the normal and the dash', ball.vx > 10 && ball.vy < -5, `v=(${ball.vx.toFixed(1)},${ball.vy.toFixed(1)})`);
  const glanceSpin = ball.spin;
  check('...and spins it', Math.abs(glanceSpin) > 0.5, `spin=${glanceSpin.toFixed(2)}`);
  // The mirror image spins the other way.
  r = hitFrom(-Math.PI * 0.75, { x: 1, y: 0 }, 46, 1);
  check('the mirror hit spins the other way', Math.sign(ball.spin) === -Math.sign(glanceSpin) && Math.abs(ball.spin) > 0.5, `spin=${ball.spin.toFixed(2)}`);

  // Grip 0 → purely along the normal; grip 1 → along the dash. Spin is
  // FRICTION now (impact.friction, tools/ball-spin-test.mjs), a separate knob
  // from grip: a frictionless ball is grip 0 AND friction 0, and takes no
  // spin and no sideways kick from any hit.
  const savedGrip = im.grip;
  const savedMu = im.friction;
  im.grip = 0;
  im.friction = 0;
  r = hitFrom(Math.PI * 0.75, { x: 1, y: 0 }, 46, 1);
  const n = { x: Math.cos(-Math.PI * 0.25), y: Math.sin(-Math.PI * 0.25) };
  const along = (ball.vx * n.x + ball.vy * n.y) / Math.hypot(ball.vx, ball.vy);
  check('grip 0, friction 0: a frictionless ball leaves along the normal', along > 0.999, `cos=${along.toFixed(4)}`);
  check('...and takes no spin', Math.abs(ball.spin) < 1e-6, `spin=${ball.spin.toFixed(3)}`);
  im.grip = 1;
  r = hitFrom(Math.PI * 0.75, { x: 1, y: 0 }, 46, 1);
  check('grip 1: it takes the dash\'s line', ball.vx > 0 && Math.abs(ball.vy) / ball.vx < 0.05, `v=(${ball.vx.toFixed(1)},${ball.vy.toFixed(1)})`);
  im.friction = savedMu;
  r = hitFrom(Math.PI * 0.75, { x: 1, y: 0 }, 46, 1);
  check('grip 1 with friction: the glancing face still spins it', Math.abs(ball.spin) > 0.5, `spin=${ball.spin.toFixed(3)}`);
  im.grip = savedGrip;

  // Spin curves the flight and bleeds off. Both seals out of its way — and
  // the kickoff's bait, which the ball now ploughs through (ballHits) at a
  // cost in speed per fish.
  resetEnemies(scene);
  resetBall();
  p2.pos.set(bounds.right - 5, bounds.bottom + 5, 0);
  player.mesh.position.set(bounds.left + 5, bounds.bottom + 5, 0);
  ball.vx = 30; ball.vy = 0; ball.spin = 8;
  const spin0 = ball.spin;
  settle(0.5);
  check('a spinning ball curves', Math.abs(ball.vy) > 1, `vy=${ball.vy.toFixed(2)} after 0.5s`);
  check('...and the spin decays', Math.abs(ball.spin) < spin0, `spin ${spin0} → ${ball.spin.toFixed(2)}`);
  check('...turning the rim with it', ball.angle !== 0, `angle=${ball.angle.toFixed(2)}`);

  // Harder = deeper and narrower.
  r = hitFrom(Math.PI, { x: 1, y: 0 }, 10, 0.2);
  const soft = r.hit.dent;
  r = hitFrom(Math.PI, { x: 1, y: 0 }, 70, 1);
  const hard = r.hit.dent;
  check('a harder hit dents deeper', hard.depth > soft.depth * 1.3, `${soft.depth.toFixed(2)} → ${hard.depth.toFixed(2)}`);
  check('...and narrower', hard.width < soft.width, `${soft.width.toFixed(2)} → ${hard.width.toFixed(2)}`);
  // ...and flattens the whole body: the rim at right angles to the hit bulges
  // on the frame of the hit, before the volume rule has run.
  resetBall();
  const top = ball.rim.length / 4;
  dentBall(Math.PI, 0.2);
  const dentOnly = ball.rim[top];
  resetBall();
  impactDent(Math.PI, 0.2, 70);
  check('a hard hit flattens the body (squash bulges the sides)', ball.rim[top] > dentOnly + 0.02, `top ${dentOnly.toFixed(3)} → ${ball.rim[top].toFixed(3)}`);

  // The lab's press: a line that misses still lands on the nearest point.
  resetBall();
  r = hitFrom(Math.PI, { x: 0, y: 1 }, 46, 1);
  check('a press whose line misses the ball still strikes it', !!r.hit && Math.hypot(ball.vx, ball.vy) > 10);
}

// ---------------------------------------------------------------------------
section('Every hit squirts goo from the contact point, scaled by how hard');
{
  versusState.phase = 'play'; versusState.phaseT = 0;
  const F = V.ball.fx;
  const R = ballContactReach(Math.PI) - 0.3;
  const hitFrom = (speed, power) => {
    resetBall(); ball.vx = ball.vy = 0;
    fired.clear(); versusState.lastImpact = null;
    strikeBallFrom({ x: ball.x - (R + 4), y: ball.y }, { x: 1, y: 0 }, speed, power);
    return versusState.lastImpact;
  };
  const soft = hitFrom(8, 0.05);
  check('a strike fires the ball\'s hit event', soft && soft.event === 'versusBallHit' && firedCount('versusBallHit') === 1, soft?.event);
  check('...from the rim on the side it was struck', soft && Math.abs(soft.x - (ball.x - ballHitRadiusAt(Math.PI))) < 1.5 && Math.abs(soft.y - ball.y) < 0.5, soft ? `at (${soft.x.toFixed(1)},${soft.y.toFixed(1)}), ball (${ball.x.toFixed(1)},${ball.y.toFixed(1)})` : '');
  check('...along the line the ball leaves on', soft && soft.dirX > 0.99 && Math.abs(soft.dirY) < 0.05, soft ? `dir (${soft.dirX.toFixed(2)},${soft.dirY.toFixed(2)})` : '');
  check('...carrying the ball\'s velocity', soft && soft.vx === ball.vx && soft.vy === ball.vy);
  const hard = hitFrom(70, 1);
  check('a harder strike is a bigger event', hard && hard.scale > soft.scale + 0.3 && hard.strength > soft.strength, `scale ${soft?.scale.toFixed(2)} → ${hard?.scale.toFixed(2)}`);
  check('...thrown faster', hard && hard.speedMul > soft.speedMul, `speedMul ${soft?.speedMul.toFixed(2)} → ${hard?.speedMul.toFixed(2)}`);
  check('...and bigger', hard && hard.sizeMul > soft.sizeMul, `sizeMul ${soft?.sizeMul.toFixed(2)} → ${hard?.sizeMul.toFixed(2)}`);
  check('both inside the ranges CONFIG.versus.ball.fx declares', [soft, hard].every((a) => a.scale >= F.scaleMin - 1e-9 && a.scale <= F.scaleMax + 1e-9 && a.speedMul >= F.speedMin - 1e-9 && a.speedMul <= F.speedMax + 1e-9 && a.sizeMul >= F.sizeMin - 1e-9 && a.sizeMul <= F.sizeMax + 1e-9));
  check('the voice rides the same scale', CONFIG.feedback.versusBallHit.sfx && CONFIG.sfx[CONFIG.feedback.versusBallHit.sfx] && CONFIG.feedback.versusBallHit.goo, `sfx ${CONFIG.feedback.versusBallHit.sfx}, goo ${CONFIG.feedback.versusBallHit.goo}`);

  // A swimming nudge: a small one, and none at all from a seal resting on it.
  // Past the hit event's own gap first — the strike above fired it on this
  // same frame, and a nudge inside the gap is the same hit still happening.
  // (With the ball stopped first: struck at full power it would cross the
  // pitch and nudge player 2 during the wait, which is itself a hit.)
  resetBall(); ball.vx = ball.vy = 0;
  player.mesh.position.set(-30, midWater(), 0); p2.pos.set(30, midWater(), 0);
  settle(F.bumpGap + 0.1);
  resetBall(); ball.vx = ball.vy = 0; fired.clear(); versusState.lastImpact = null;
  sealContact(1, { x: ball.x - ballReach() + 0.3, y: ball.y }, { x: 12, y: 0 }, false, null, 0);
  const bump = versusState.lastImpact;
  check('a swimming nudge is a small hit', bump && bump.event === 'versusBallHit' && bump.scale < hard.scale * 0.5, bump ? `scale ${bump.scale.toFixed(2)}` : 'no event');
  resetBall(); ball.vx = ball.vy = 0; fired.clear();
  sealContact(1, { x: ball.x - ballReach() + 0.3, y: ball.y }, { x: 0.5, y: 0 }, false, null, 0);
  check('...and a seal resting against it fires nothing', firedCount('versusBallHit') === 0);
  // ...and a seal DRIBBLING it is one splash every bumpGap, not one a frame.
  resetBall(); fired.clear();
  for (let i = 0; i < 120; i++) { player.mesh.position.set(ball.x - ballReach() + 0.5, ball.y, 0); player.velocity.set(12, 0); frame(); }
  player.mesh.position.set(-30, midWater(), 0); player.velocity.set(0, 0);
  check('a seal dribbling the ball for two seconds splashes a few times, not a hundred', touchCount() >= 1 && touchCount() <= Math.ceil(2 / F.bumpGap) + 1, `${touchCount()} in 2s (gap ${F.bumpGap}s)`);
  // ...AND A DRIBBLE IS A TAP. The band is the whole point of the split: if a
  // shepherding nudge came out as the middle row, the three voices would exist
  // and nothing would ever reach the outer two.
  check('...and a dribble is the soft row, not the ordinary one', firedCount('versusBallTap') === touchCount() && touchCount() > 0,
    `${firedCount('versusBallTap')} tap(s) of ${touchCount()} touch(es)`);
  // A ball settling onto the floor under its own buoyancy makes no splash.
  resetBall(); fired.clear();
  ball.y = bounds.bottom + ballRestRadius() + 0.01; ball.vy = -1; ball.vx = 0;
  settle(2);
  check('a ball settling on the floor is silent', firedCount('versusBallWall') === 0, `${firedCount('versusBallWall')} wall events`);

  // The wall: from the contact point, out along the wall's normal.
  resetBall(); fired.clear(); versusState.lastImpact = null;
  ball.y = bounds.bottom + 6; ball.vy = -40; ball.vx = 0;
  for (let i = 0; i < 60 && !versusState.lastImpact; i++) frame();
  const wall = versusState.lastImpact;
  check('the floor fires the wall event', wall && wall.event === 'versusBallWall' && firedCount('bounce') === 0, wall?.event);
  check('...from the point of contact, out along the normal', wall && Math.abs(wall.y - bounds.bottom) < 0.05 && wall.dirY > 0.99, wall ? `at y=${wall.y.toFixed(2)} (floor ${bounds.bottom.toFixed(2)}), dir (${wall.dirX.toFixed(2)},${wall.dirY.toFixed(2)})` : '');
  const wallHard = wall;
  resetBall(); fired.clear(); versusState.lastImpact = null;
  ball.y = bounds.bottom + 6; ball.vy = -8; ball.vx = 0;
  for (let i = 0; i < 120 && !versusState.lastImpact; i++) frame();
  check('...and a slow one is a smaller event', versusState.lastImpact && versusState.lastImpact.scale < wallHard.scale, `scale ${versusState.lastImpact?.scale.toFixed(2)} vs ${wallHard.scale.toFixed(2)}`);
  resetBall();
}

// ---------------------------------------------------------------------------
section('The scorer celebrates, and only the scorer');
{
  resetBall();
  versusState.scores[0] = 0; versusState.scores[1] = 0;
  versusState.phase = 'play';
  const saved = CONFIG.celebrate.enabled;
  CONFIG.celebrate.enabled = true;
  ball.x = bounds.left + 12; ball.y = midWater(); ball.vx = -30;
  let frames = 0;
  while (versusState.phase === 'play' && frames < 240) { frame(); frames++; }
  check('P2 scored', versusState.scorer === 1);
  check('a celebration started', celebrationState.active, `variant ${celebrationState.variant}`);
  check('...tagged for P2 alone', celebrationState.only === 'p2');
  check('the player\'s somersault is not P2\'s', celebrationSpin() === 0);
  // Let the shutter and the kickoff after it run out.
  toPlay();
  resetCelebration();
  versusState.scores[0] = 0; versusState.scores[1] = 0;
  resetBall();
  ball.x = bounds.right - 12; ball.y = midWater(); ball.vx = 30;
  frames = 0;
  while (versusState.phase === 'play' && frames < 240) { frame(); frames++; }
  check('P1 scored', versusState.scorer === 0);
  check('...and the celebration is the player\'s (untagged)', celebrationState.active && celebrationState.only === null);
  toPlay();
  resetCelebration();
  CONFIG.celebrate.enabled = saved;
  versusState.scores[0] = 0; versusState.scores[1] = 0;
}

// ---------------------------------------------------------------------------
section('The meter comes back on its own, and out of the air');
{
  versusState.phase = 'play';
  resetBall();
  const every = V.regen.pipEvery;
  const idle = [pad(0), pad(1)]; // pads present and untouched: no bot, no wind-up
  // NOBODY DROWNS IN THE MIDDLE OF IT. regenPips skips a seat that is out of
  // the water, and a burst costs a full second of respawn — so a seal that
  // runs out of air partway through this window silently loses a pip and the
  // meter takes the blame. Which seal that is depends on how long it has been
  // under: this used to pass only because the goal shutter above happened to
  // end before player 2's air did, and lengthening `clock.respawn` by a second
  // was enough to sink it. Both seals start with a full lungful, and the air
  // is what the section below is for.
  const fullO2 = Math.max(1, player.stats?.maxOxygen ?? CONFIG.oxygen?.max ?? 100);
  player.oxygen = fullO2; p2.oxygen = fullO2;
  settle(Math.max(0, ...versusState.dead) + 0.1, idle);
  strikeState.charge = 0; strikeState.pending = 0;
  p2.charge = 0; p2.pending = 0;
  versusState.regenT[0] = versusState.regenT[1] = every;
  settle(every - 0.2, idle);
  check('nothing before the pip is due', strikeState.charge < 1e-6 && p2.charge < 1e-6, `p1 ${strikeState.charge.toFixed(3)} p2 ${p2.charge.toFixed(3)}`);
  settle(0.4, idle);
  const pip = pipValue(player.stats);
  check(`a pip for player 1 at ${every}s`, Math.abs(strikeState.charge - pip) < 1e-6, `charge ${strikeState.charge.toFixed(3)} (pip ${pip.toFixed(3)})`);
  check('...and one for player 2', Math.abs(p2.charge - CONFIG.strike.charge.chumRefill) < 1e-6, `charge ${p2.charge.toFixed(3)}`);
  settle(every * 2, idle);
  check('and they keep coming', strikeState.charge >= pip * 2.99 && p2.charge >= 0.59, `p1 ${strikeState.charge.toFixed(2)} p2 ${p2.charge.toFixed(2)}`);

  // EVERY SEAT, not the two captains. regenPips was written as a pair — t[0]
  // for player 1, t[1] for player 2 — and stayed a pair when the roster grew,
  // so every seal past the second was the only thing in the water with no
  // clock on its meter at all. Its whole bar came from food, which is a rule
  // nobody wrote and nothing said.
  {
    const was = matchRoster();
    setMatchRoster(2);
    resetVersus(); resetPlayer(); startVersus(scene);
    toPlay();
    versusState.phase = 'play';
    for (const seal of matchSeals()) { if (seal !== player) { seal.charge = 0; seal.pending = 0; } }
    strikeState.charge = 0; strikeState.pending = 0;
    versusState.regenT.fill(every);
    settle(every + 0.2, idle);
    let fed = 0;
    let seats = 0;
    for (const seal of matchSeals()) {
      seats++;
      const bar = seal === player ? strikeState.charge : seal.charge;
      if (bar > 1e-6) fed++;
    }
    check('the free pip reaches every seat on the pitch', fed === seats, `${fed} of ${seats} seals`);
    setMatchRoster(was);
    resetVersus(); resetPlayer(); startVersus(scene);
    toPlay();
    versusState.phase = 'play';
  }

  // Bubbles: the match keeps its own headcount.
  while (bubbleOrbs.length) { scene.remove(bubbleOrbs[0].mesh); bubbleOrbs.shift(); }
  versusState.bubbleT = 0;
  settle(0.2, idle);
  check(`the water is refilled to minAlive at once`, bubbleOrbs.length >= V.bubbles.minAlive, `${bubbleOrbs.length} bubbles`);
  settle(V.bubbles.every * V.bubbles.maxAlive + 1, idle);
  check('...and climbs to maxAlive, no further', bubbleOrbs.length === V.bubbles.maxAlive, `${bubbleOrbs.length}`);
  // And a bubble pays the bar: player 2 by touching it.
  p2.charge = 0.2;
  p2.pos.set(20, midWater(), 0);
  p2.vel.set(0, 0);
  const n = bubbleOrbs.length;
  spawnBubbleOrb(scene, { x: 21, y: midWater(), z: 0 });
  frame(idle);
  check('player 2 takes a bubble by touching it', bubbleOrbs.length === n, `${n + 1} → ${bubbleOrbs.length}`);
  check(`...for ${V.bubbles.pips} pip(s)`, Math.abs(p2.charge - (0.2 + versusBubblePips())) < 1e-6, `charge ${p2.charge.toFixed(2)}`);
  check('a versus bubble is worth more than a run\'s quarter bar', versusBubblePips() > (CONFIG.strike.orbPipRefill?.bubble ?? 0.25), `${versusBubblePips().toFixed(2)} of the bar`);
}

// ---------------------------------------------------------------------------
// EVERY SEAL HAS A FOOD CHAIN — see chainAllowed in systems/strike.js.
//
// The chain is the run's central loop and nothing ever switched it off in a
// match, so it ran there by accident and on one seal: player 1's chum went
// through main.js's own collector and built a chain, and every other seal's
// went straight into its meter through addCharge and built nothing. At
// comboSpeedMax that is 1.75x on thrust, top speed, the dash and the dash's
// turn rate — for the one seal in the water that could earn it.
// ---------------------------------------------------------------------------
section('Every seal in a match has its own food chain, and one switch turns them all off');
{
  const idle = [pad(0), pad(1)];
  versusState.phase = 'play';
  resetBall();
  ball.x = bounds.right - 10;        // out of the way of both seals
  resetPickups(scene);

  // ARM A SEAL'S STRIKE without playing a whole rally at it: the chain wants a
  // charged release behind it (`armed`), a bar's worth of budget, and the
  // mouthfuls the first link costs. Every one of those is a field on the
  // seal's OWN state, which is the thing under test.
  const arm = (st) => {
    st.armed = true;
    st.pipBudget = pipCount(player.stats);
    st.pipsSinceStrike = linkPips();
    st.chainTimer = CONFIG.strike.chainWindow;
    st.chainCount = 0;
    st.chainPips = 0;
    st.linkCredit = 0;
    st.charge = 0;
    st.lastChain = 0;
  };
  // Orbs on the seal's nose, eaten by versus.js's own gulp — the real path, so
  // this is a test of the wiring and not of feedChum in isolation.
  const feed = (seal, n) => {
    for (let i = 0; i < n; i++) {
      spawnXpOrb(scene, { x: sealPos(seal).x, y: sealPos(seal).y, z: 0 }, 1, 0.5);
      frame(idle);
    }
  };

  p2.pos.set(-20, midWater(), 0);
  p2.vel.set(0, 0);
  player.mesh.position.set(30, midWater(), 0);
  player.velocity.set(0, 0);
  arm(p2.strike);
  arm(strikeState);
  const links = Math.max(2, linkCost(0) + linkCost(1));
  feed(p2, links);
  check('player 2 chains off its own mouthfuls', liveChain(p2.strike) > 0, `x${liveChain(p2.strike)}`);
  check('...and it is ITS chain, not the run\'s', liveChain(strikeState) === 0, `p1 x${liveChain(strikeState)}`);
  check('...which makes it faster', comboSpeedMul(player.stats, p2.strike) > 1,
    `${comboSpeedMul(player.stats, p2.strike).toFixed(3)}x, cap ${CONFIG.strike.comboSpeedMax}`);
  check('...and the seal is carrying that multiplier', p2.comboSpeedMul > 1, `${(p2.comboSpeedMul ?? 1).toFixed(3)}x`);
  // The throttle is per seal too: it was one module map, ticked only for the
  // run's own state, so a CPU seal's first link would have shut `chumEaten`
  // off for every seal for the rest of the match.
  check('the chain throttle is the seal\'s own', p2.strike.chainGaps !== strikeState.chainGaps);

  // THE SWITCH, and the one thing it must never be is one-sided.
  const was = V.chain.enabled;
  V.chain.enabled = false;
  resetPickups(scene);
  arm(p2.strike);
  arm(strikeState);
  feed(p2, links);
  check('with the switch off player 2 chains nothing', liveChain(p2.strike) === 0, `x${liveChain(p2.strike)}`);
  check('...and eats for fuel alone', p2.charge > 0, `charge ${p2.charge.toFixed(2)}`);
  // Player 1's food goes through main.js's collector, which this harness does
  // not run — so the switch is asked of the FUNCTION every link comes through
  // rather than of a seat, and that is what this checks.
  arm(strikeState);
  feedChum(player.stats);
  check('...and neither does player 1', liveChain(strikeState) === 0, `p1 x${liveChain(strikeState)}`);
  V.chain.enabled = was;
  arm(strikeState);
  feedChum(player.stats);
  check('...and back on, player 1 chains again', liveChain(strikeState) > 0, `p1 x${liveChain(strikeState)}`);
  resetStrike();
  resetStrike(p2.strike);
  resetPickups(scene);
}

// ---------------------------------------------------------------------------
// PARITY — what a CPU seal's release does. Three things main.js did for the
// seal it drives and nothing did for anybody else: the POP (the strike's whole
// damage, at the point the stick came up), the SWALLOW (a fired release hoovers
// the chum around it), and the MID-AIR RELAUNCH (a release that fired nothing,
// in the air, spends an air jump instead). See releaseP2 and versusHooks.
// ---------------------------------------------------------------------------
section('A match seal\'s release pops, swallows, and relaunches it in mid air');
{
  const seen = { burst: 0, gulp: 0 };
  const wasBurst = versusHooks.onStrikeBurst;
  const wasGulp = versusHooks.onReleaseGulp;
  versusHooks.onStrikeBurst = () => { seen.burst++; };
  versusHooks.onReleaseGulp = () => { seen.gulp++; };

  versusState.phase = 'play';
  resetBall();
  ball.x = bounds.right - 10;
  p2.pos.set(0, midWater(), 0);
  p2.vel.set(0, 0);
  p2.strike.charge = 1;
  p2.strike.pending = 1;
  p2.aboveSurface = false;
  const fired = releaseP2({ x: 1, y: 0 }, 0, p2);
  check('the release fires', fired);
  check('...and the strike pops', seen.burst === 1, `${seen.burst} burst(s)`);
  check('...and the seal swallows what is around it', seen.gulp === 1, `${seen.gulp} gulp(s)`);

  // THE MID-AIR RELAUNCH. Airborne with nothing banked: the strike fires
  // nothing, and that is exactly when an air jump is worth spending.
  const jumps = CONFIG.airborne?.jumps ?? {};
  const wasEnabled = CONFIG.airborne.enabled;
  CONFIG.airborne.enabled = true;
  p2.pos.set(0, bounds.surfaceY + 4, 0);
  p2.vel.set(0, 0);
  p2.aboveSurface = true;
  p2.airJumps = 0;
  p2.airTime = 0.2;
  p2.strike.charge = 0;
  p2.strike.pending = 0;
  const before = p2.airJumps;
  const jumped = releaseP2({ x: 0, y: 1 }, 0, p2);
  check('a release with nothing banked fires no strike', !jumped);
  check('...and spends an air jump instead', p2.airJumps === before + 1,
    `${before} → ${p2.airJumps} of ${jumps.max ?? 0}`);
  check('...which launches the seal', p2.vel.length() > 1, `speed ${p2.vel.length().toFixed(1)}`);
  // ...and the ramp it just earned is the SEAL'S, not the run's. airState is
  // the singleton every multiplier falls back to, and it belongs to the person
  // playing — a match seal writing into it would hand the player whichever
  // seal breached last. See spendAirJump's `cache`.
  check('...without touching the run\'s own air ramp', airState.ramp === 0,
    `run ramp ${airState.ramp.toFixed(2)}, this seal's ${airRamp(p2).toFixed(2)}`);
  check('...which it does have', airRamp(p2) > 0, `${airRamp(p2).toFixed(2)}`);

  CONFIG.airborne.enabled = wasEnabled;
  versusHooks.onStrikeBurst = wasBurst;
  versusHooks.onReleaseGulp = wasGulp;
  p2.aboveSurface = false;
  p2.airJumps = 0;
  p2.airTime = 0;
  p2.vel.set(0, 0);
  resetStrike(p2.strike);
}

// ---------------------------------------------------------------------------
section('A match seal reaches for the food around it, and claims what it reaches');
{
  const idle = [pad(0), pad(1)];
  versusState.phase = 'play';
  resetBall();
  ball.x = bounds.right - 10;
  resetPickups(scene);
  p2.pos.set(-30, midWater(), 0);
  p2.vel.set(0, 0);
  p2.chumSealed = false;
  player.mesh.position.set(40, midWater(), 0);
  player.velocity.set(0, 0);

  // An orb a few units off player 2's nose, well inside its food reach and
  // nowhere near player 1's.
  const reach = foodReach(player.stats, 0);
  spawnXpOrb(scene, { x: p2.pos.x - reach * 0.5, y: midWater(), z: 0 }, 1, 0.5);
  const orb = pickups[pickups.length - 1];
  const before = Math.hypot(orb.mesh.position.x - p2.pos.x, orb.mesh.position.y - p2.pos.y);
  frame(idle);
  check('the orb is claimed by the seal that can reach it', orb.claimedBy === 1, `claimedBy ${orb.claimedBy}`);
  for (let i = 0; i < 20; i++) frame(idle);
  const survivor = pickups.find((p) => p === orb);
  const after = survivor
    ? Math.hypot(orb.mesh.position.x - p2.pos.x, orb.mesh.position.y - p2.pos.y)
    : 0;
  check('...and is pulled to it', after < before, `${before.toFixed(1)} → ${after.toFixed(1)}${survivor ? '' : ' (swallowed)'}`);
  check('...and eaten by that seal, not the player', p2.charge > 0 && strikeState.charge === 0,
    `p2 ${p2.charge.toFixed(2)}, p1 ${strikeState.charge.toFixed(2)}`);

  // AND THE CLAIM IS A REACH, NOT A HOLD. Swim away and the orb is free again,
  // or a seal that lost interest would strand it mid-water for everybody —
  // the player's own loop leaves anything claimed alone.
  //
  // The mouth is closed for this one (`p2.reach` 0): the point is the claim,
  // and an orb swallowed on the frame it is claimed has nothing left to
  // release. Put back below.
  const wasReach = V.p2.reach;
  V.p2.reach = 0;
  resetPickups(scene);
  p2.pos.set(-30, midWater(), 0);
  spawnXpOrb(scene, { x: p2.pos.x - reach * 0.5, y: midWater(), z: 0 }, 1, 0.5);
  const orb2 = pickups[pickups.length - 1];
  frame(idle);
  check('a second orb is claimed too', orb2.claimedBy === 1, `claimedBy ${orb2.claimedBy}`);
  p2.pos.set(-30 + reach * 6, midWater(), 0);
  frame(idle);
  check('...and released when the seal swims out of reach', orb2.claimedBy == null, `claimedBy ${orb2.claimedBy}`);
  V.p2.reach = wasReach;

  resetPickups(scene);
  strikeState.charge = 0; p2.charge = 0;
}

// ---------------------------------------------------------------------------
section('A dash into the other seal is a body check');
{
  const events = [];
  const off = onFeedback((name, at) => { if (name === 'bodyCheck') events.push({ ...at }); });
  const cr = V.bodyCheck.contactRadius;
  resetBall();
  ball.x = bounds.right - 10; // out of the way
  // P1 dashing +x into P2 sitting just ahead of it.
  const y = midWater();
  player.mesh.position.set(0, y, 0);
  player.velocity.set(40, 0);
  player.knockX = player.knockY = 0;
  p2.pos.set(cr * 2 - 0.5, y, 0);
  p2.vel.set(0, 0);
  p2.knockX = p2.knockY = 0;
  p2.active = false; p2.dashTimer = 0;
  strikeState.active = true; strikeState.power = 1;
  strikeState.dashDir.x = 1; strikeState.dashDir.y = 0;
  frame();
  check('the event fired', events.length === 1, `${events.length}`);
  check('player 2 is shoved along the dash', p2.knockX > V.bodyCheck.knock, `knockX ${p2.knockX.toFixed(1)}`);
  const strong = events[0]?.scale ?? 0;
  check('the event scales with the shove', strong > 1, `scale ${strong.toFixed(2)}`);
  check('...and carries its direction for the burst', (events[0]?.vx ?? 0) > 0);
  check('...and the shove\'s line for the goo\'s cone', (events[0]?.dirX ?? 0) > 0.99 && Math.abs(events[0]?.dirY ?? 1) < 0.05, `dir (${events[0]?.dirX?.toFixed(2)},${events[0]?.dirY?.toFixed(2)})`);
  check('the body check throws goo', !!CONFIG.feedback.bodyCheck.goo && !!CONFIG.emitters[CONFIG.feedback.bodyCheck.goo]?.goo, `goo ${CONFIG.feedback.bodyCheck.goo} → ${CONFIG.emitters[CONFIG.feedback.bodyCheck.goo]?.goo}`);
  const before = p2.pos.x;
  settle(0.5);
  check('the shove moved the seal', p2.pos.x > before + 1.5, `${before.toFixed(1)} → ${p2.pos.x.toFixed(1)}`);
  // Still dashing, still touching: no second check.
  p2.pos.set(player.mesh.position.x + cr * 2 - 0.5, y, 0);
  frame();
  check('one check per dash', events.length === 1);
  strikeState.active = false;
  frame();

  // A weak tap scales low.
  strikeState.active = true; strikeState.power = 0;
  player.velocity.set(2, 0);
  p2.knockX = p2.knockY = 0;
  player.mesh.position.set(0, y, 0);
  p2.pos.set(cr * 2 - 0.5, y, 0);
  frame();
  const weak = events[events.length - 1]?.scale ?? 9;
  check('a limp tap is a smaller event', weak < strong && weak <= 0.8, `scale ${weak.toFixed(2)} vs ${strong.toFixed(2)}`);
  strikeState.active = false;
  frame();

  // Both dashing: both shoved, both dashes broken.
  events.length = 0;
  player.mesh.position.set(0, y, 0);
  player.velocity.set(40, 0);
  player.knockX = player.knockY = 0;
  p2.pos.set(cr * 2 - 0.5, y, 0);
  p2.vel.set(-40, 0);
  p2.knockX = p2.knockY = 0;
  p2.active = true; p2.dashTimer = 0.4; p2.dashTimeLeft = 0.4; p2.power = 1;
  strikeState.active = true; strikeState.power = 1;
  frame();
  check('head-on: player 2 is shoved back', p2.knockX > 0, `knockX ${p2.knockX.toFixed(1)}`);
  check('...and player 1 too', player.knockX < 0, `knockX ${player.knockX.toFixed(1)}`);
  check('...and both dashes are broken', !p2.active && !strikeState.active);
  check('as one event', events.length === 1 && events[0].scale > 1, `${events.length}, scale ${events[0]?.scale.toFixed(2)}`);
  off?.();
  player.knockX = player.knockY = 0;
  p2.knockX = p2.knockY = 0;
  player.velocity.set(0, 0);
  p2.vel.set(0, 0);
}

// ---------------------------------------------------------------------------
section('A cannonball: heavy, pulled down hard out of the water, slow to float');
{
  const idle = [pad(0), pad(1)];
  const away = () => {
    p2.pos.set(bounds.right - 5, bounds.bottom + 5, 0); p2.vel.set(0, 0); p2.active = false; p2.dashTimer = 0;
    player.mesh.position.set(bounds.left + 5, bounds.bottom + 5, 0); player.velocity.set(0, 0); strikeState.active = false;
  };
  versusState.phase = 'play';
  away();

  // Buoyancy: a still ball drifts up.
  resetBall();
  settle(1, idle);
  check('a still ball drifts up', ball.vy > 0.5 && ball.y > midWater() + 0.2, `vy=${ball.vy.toFixed(2)} y=${(ball.y - midWater()).toFixed(2)} above where it started`);
  const slowLift = ball.vy;

  // ...but not a ball driven down: it keeps its line until drag slows it.
  resetBall();
  ball.vy = -40;
  settle(0.3, idle);
  check('driven down, it keeps going down', ball.vy < -25, `vy=${ball.vy.toFixed(1)} after 0.3s`);
  let turned = -1;
  for (let t = 0; t < 12; t += dt) { frame(idle); if (ball.vy > 0) { turned = t; break; } if (ball.y <= bounds.bottom + ball.r + 0.01) break; }
  check('...and only turns up once drag has taken the pace off (or it hits the floor)', turned > 0.8 || ball.y <= bounds.bottom + ballHitRadiusAt(-Math.PI / 2) + 0.01, `turned at ${turned.toFixed(2)}s`);
  // Buoyancy off = no drift.
  const savedLift = V.ball.water.buoyancy;
  V.ball.water.buoyancy = 0;
  resetBall();
  settle(1, idle);
  check('with buoyancy 0 it sits', Math.abs(ball.vy) < 1e-6, `vy=${ball.vy.toFixed(3)}`);
  V.ball.water.buoyancy = savedLift;

  // Air: gravity times the multiplier. Launch straight up from the surface and time the hang.
  const hang = (mul) => {
    const saved = V.ball.air.gravityMul;
    V.ball.air.gravityMul = mul;
    resetBall();
    ball.y = bounds.surfaceY + 0.01; ball.vy = 30;
    let t = 0;
    for (; t < 6; t += dt) { frame(idle); if (ball.y <= bounds.surfaceY) break; }
    V.ball.air.gravityMul = saved;
    return t;
  };
  const h1 = hang(1);
  const hx = hang(V.ball.air.gravityMul);
  check('out of the water it falls harder than the world does', hx < h1 * 0.8, `hang ${hx.toFixed(2)}s vs ${h1.toFixed(2)}s at x1`);

  // Mass: a swimming seal barely moves it — and holds its ground: it won the
  // contest (the ball was still), so nothing shoves it back. See the contest
  // section for the ball winning.
  resetBall();
  p2.pos.set(ball.x - ballReach() + 0.3, ball.y, 0);
  p2.vel.set(12, 0);
  p2.knockX = p2.knockY = 0;
  frame(idle);
  const share = 2 / (1 + V.ball.mass);
  check('a swim bump moves the ball by the seal\'s share of the closing speed', ball.vx > 0 && ball.vx < 12 * V.ball.bumpGain * share + 3, `vx=${ball.vx.toFixed(1)} (share ${share.toFixed(2)})`);
  check('...and the seal holds its ground against a still ball — no shove back', p2.knockX === 0 && p2.knockY === 0, `knock (${p2.knockX.toFixed(1)}, ${p2.knockY.toFixed(1)})`);
  away();

  // Recoil: a full strike throws the striker off the ball and ends its dash.
  resetBall();
  player.mesh.position.set(ball.x - ballReach() + 0.4, ball.y, 0);
  player.velocity.set(46, 0);
  player.knockX = player.knockY = 0;
  strikeState.active = true; strikeState.power = 1;
  strikeState.dashDir.x = 1; strikeState.dashDir.y = 0;
  frame(idle);
  check('the ball takes the hit', ball.vx > 40, `ball vx=${ball.vx.toFixed(1)}`);
  check('the striker is thrown back', player.velocity.x < -5, `seal vx=${player.velocity.x.toFixed(1)}`);
  check('...and its dash is over', !strikeState.active);
  check('the recoil is capped', -player.velocity.x <= V.ball.impact.recoilMax + 1e-6, `${(-player.velocity.x).toFixed(1)} ≤ ${V.ball.impact.recoilMax}`);
  away();
  resetBall();
}

// ---------------------------------------------------------------------------
section('A dash through bait fish kills them, for either seal, on any release');
{
  const idle = [pad(0), pad(1)];
  versusState.phase = 'play';
  resetBall();
  ball.x = bounds.right - 8; ball.y = bounds.bottom + 6;
  const y = midWater();
  const fish = () => enemies.filter((e) => e.def?.prey);
  // Player 2: a dash straight through a school.
  resetEnemies(scene);
  for (let i = 0; i < 4; i++) spawnNamed(scene, 'fish', 0, { x: 14 + i * 0.6, y: y + (i - 1.5) * 0.4 }, { docile: true });
  const before = fish().length;
  check('a school is in the water', before === 4, `${before}`);
  const killed = [];
  versusHooks.onKill = (e) => killed.push(e);
  p2.pos.set(8, y, 0);
  p2.vel.set(46, 0);
  p2.active = true; p2.dashTimer = 0.4; p2.dashTimeLeft = 0.4; p2.power = 1;
  p2.dashDir.x = 1; p2.dashDir.y = 0;
  settle(0.4, idle);
  check('player 2\'s dash kills what it passes through', fish().length < before, `${before} → ${fish().length}`);
  check('...through the run\'s kill path', killed.length === before - fish().length && killed.length > 0, `${killed.length} kills reported`);
  versusHooks.onKill = null;

  // Player 1: the strike system's own cull, armed on ANY release in versus.
  resetEnemies(scene);
  spawnNamed(scene, 'fish', 0, { x: 0, y: y }, { docile: true });
  const f = fish()[0];
  player.mesh.position.set(-0.5, y, 0);
  strikeState.active = true; strikeState.dashDuration = 0.3; strikeState.dashTimeLeft = 0.3;
  strikeState.sweetStrike = false; strikeState.armingStrike = false; strikeState.power = 1;
  strikeState.dashDir.x = 1; strikeState.dashDir.y = 0;
  updateStrike(dt, scene, player.mesh.position, player.stats, enemies, {});
  check('player 1\'s dash culls the fish without the sweet spot', !enemies.includes(f) || f.hp <= 0, `hp ${f.hp}`);
  // ...and the ordinary game keeps its timing window.
  resetEnemies(scene);
  enableVersus(false);
  spawnNamed(scene, 'fish', 0, { x: 0, y: y }, { docile: true });
  const g = fish()[0];
  const hp0 = g.hp;
  strikeState.active = true; strikeState.dashTimeLeft = 0.3; strikeState.sweetStrike = false;
  updateStrike(dt, scene, player.mesh.position, player.stats, enemies, {});
  check('outside versus a missed window is still just a shove', enemies.includes(g) && g.hp === hp0, `hp ${g.hp} of ${hp0}`);
  enableVersus(true);
  strikeState.active = false;
  resetEnemies(scene);
  player.mesh.position.set(-30, y, 0);
  resetBall();
}

// ---------------------------------------------------------------------------
section('The outline boils harder the harder the ball is hit');
{
  // The MECHANISM, on numbers that show it: the live gains are Ethan's (the
  // tuner shadows them) and a rest amplitude tuned up against the ceiling is
  // allowed to leave an impact nowhere to go — that is a taste, not a bug.
  // Pinned here, restored after, the way the rim section pins the springs.
  const outlineSaved = { ...V.ball.outline };
  Object.assign(V.ball.outline, { ampRest: 0.6, ampByPulse: 5, ampBySpeed: 2.2, ampBySpin: 1.6, ampByCharge: 1, ampMax: 9, hzRest: 6, hzByPulse: 10, hzBySpeed: 6, hzMax: 24 });
  const o = V.ball.outline;
  const group = CONFIG.fx.goo.groups.ball;
  check('the ball group declares an outline', !!group.outline && group.outline.strength > 0);
  ball.spin = 0;
  const calm = driveOutline({ pulse: 0, speed01: 0, charge01: 0 });
  check('a calm ball rests at ampRest / hzRest', calm && Math.abs(calm.amp - o.ampRest) < 1e-9 && Math.abs(calm.hz - o.hzRest) < 1e-9, `${calm?.amp} texels @ ${calm?.hz} Hz`);
  const hit = driveOutline({ pulse: 1, speed01: 0, charge01: 0 });
  check('an impact raises both', hit.amp > calm.amp + 1 && hit.hz > calm.hz + 1, `${hit.amp.toFixed(1)} texels @ ${hit.hz.toFixed(1)} Hz`);
  const fast = driveOutline({ pulse: 0, speed01: 1, charge01: 0 });
  check('so does speed', fast.amp > calm.amp && fast.hz > calm.hz, `${fast.amp.toFixed(1)} @ ${fast.hz.toFixed(1)}`);
  ball.spin = 10;
  const spun = driveOutline({ pulse: 0, speed01: 0, charge01: 0 });
  check('and spin, on the amplitude', spun.amp > calm.amp && Math.abs(spun.hz - calm.hz) < 1e-9, `${spun.amp.toFixed(1)}`);
  ball.spin = 0;
  const everything = driveOutline({ pulse: 3, speed01: 1, charge01: 1 });
  check('the ceilings hold', everything.amp <= o.ampMax + 1e-9 && everything.hz <= o.hzMax + 1e-9, `${everything.amp.toFixed(1)} ≤ ${o.ampMax}, ${everything.hz.toFixed(1)} ≤ ${o.hzMax}`);
  check('...and the group carries the answer for the shader', group.outline.boilAmp === everything.amp && group.outline.boilHz === everything.hz);
  Object.assign(V.ball.outline, outlineSaved);
}

// ---------------------------------------------------------------------------
section('Out of air: a seal bursts and is back in its goal a second later');
{
  const idle = [pad(0), pad(1)];
  const r = V.respawn;
  const bursts = [];
  const off = onFeedback((name, at) => { if (name === 'sealBurst') bursts.push(at); });
  versusState.phase = 'play';
  resetBall();
  ball.x = bounds.right - 8; ball.y = bounds.bottom + 6;

  // Player 2 runs out of air under water.
  p2.pos.set(10, midWater(), 0);
  p2.vel.set(0, 0);
  p2.oxygen = 0.02;
  frame(idle);
  check('player 2 bursts when its air runs out', versusState.dead[1] > 0 && bursts.length === 1, `dead ${versusState.dead[1].toFixed(2)}s, ${bursts.length} burst`);
  check('...and is out of play', !sealVulnerable(1) && p2.root?.visible === false);
  // Nothing can hit it or be hit by it meanwhile.
  player.mesh.position.set(p2.pos.x - 1, p2.pos.y, 0);
  player.velocity.set(40, 0);
  strikeState.active = true; strikeState.power = 1; strikeState.dashDir.x = 1; strikeState.dashDir.y = 0;
  const kx = p2.knockX;
  frame(idle);
  check('a dash through the gap finds nothing', p2.knockX === kx, `knockX ${p2.knockX}`);
  strikeState.active = false;
  player.mesh.position.set(-30, midWater(), 0);
  player.velocity.set(0, 0);
  settle(r.delay + 0.1, idle);
  const sp = { x: bounds.right - r.inset, y: midWater() };
  check(`it is back after ${r.delay}s, in its own goal mouth`, versusState.dead[1] === 0 && Math.abs(p2.pos.x - sp.x) < 0.5 && Math.abs(p2.pos.y - sp.y) < 0.5, `at (${p2.pos.x.toFixed(1)}, ${p2.pos.y.toFixed(1)})`);
  check('...with full air, visible, and a moment of grace', p2.oxygen > 50 && p2.root?.visible === true && versusState.invuln[1] > 0, `air ${p2.oxygen.toFixed(0)}, grace ${versusState.invuln[1].toFixed(2)}`);
  settle(r.invuln + 0.1, idle);
  check('the grace runs out', sealVulnerable(1));

  // Player 1 goes the same way, by main.js\'s hand (killPlayer / the drain).
  bursts.length = 0;
  player.mesh.position.set(0, midWater(), 0);
  player.mesh.visible = true;
  check('player 1 bursts on demand', versusOutOfAir(0) === true && bursts.length === 1 && versusState.dead[0] > 0);
  check('...and is hidden and parked', player.mesh.visible === false);
  check('bursting twice is once', versusOutOfAir(0) === false);
  settle(r.delay + 0.1, idle);
  check('player 1 is back in the LEFT goal mouth', versusState.dead[0] === 0 && Math.abs(player.mesh.position.x - (bounds.left + r.inset)) < 0.5 && player.mesh.visible === true, `x=${player.mesh.position.x.toFixed(1)}`);
  check('...with full air', player.oxygen >= (player.stats.maxOxygen ?? 1) - 1e-6);
  off?.();
  settle(r.invuln + 0.2, idle);
  player.mesh.position.set(-30, midWater(), 0);
  p2.pos.set(30, midWater(), 0);
  p2.oxygen = CONFIG.oxygen.max;
}

// ---------------------------------------------------------------------------
section('The camera frames the ball and the seals');
{
  const frame = { w: 52 * 16 / 9, h: 52 };
  const cam = V.camera;
  const savedMode = cam.mode;
  const savedSubject = cam.subject;
  resetBall();
  ball.vx = ball.vy = 0;

  // A: everyone spread across the pitch — the widest the frame goes is zoom 1.
  cam.mode = 'A';
  player.mesh.position.set(bounds.left + 10, midWater(), 0);
  p2.pos.set(bounds.right - 10, midWater(), 0);
  let g = versusCameraGoal(frame);
  check('A: subjects a pitch apart → the frame zooms OUT to hold both, however far that is', g.zoom < 1 && (p2.pos.x - player.mesh.position.x + 2 * cam.pad) * g.zoom <= frame.w + 1e-6, `zoom=${g.zoom.toFixed(3)}`);
  check('A: centred on the box', Math.abs(g.x - (player.mesh.position.x + p2.pos.x) / 2) < 1e-6 && Math.abs(g.y - midWater()) < 1e-6, `x=${g.x.toFixed(1)} y=${g.y.toFixed(1)}`);

  // A: everyone on the ball — as tight as it is allowed to go.
  player.mesh.position.set(ball.x - 4, ball.y, 0);
  p2.pos.set(ball.x + 4, ball.y, 0);
  g = versusCameraGoal(frame);
  check('A: subjects together → zoomMax', Math.abs(g.zoom - cam.zoomMax) < 1e-6, `zoom=${g.zoom.toFixed(2)}`);

  // A: two apart, the third off to the side — the box is all three.
  player.mesh.position.set(ball.x - 12, ball.y, 0);
  p2.pos.set(ball.x + 12, ball.y + 14, 0);
  g = versusCameraGoal(frame);
  const wantZoom = Math.min(cam.zoomMax, frame.w / (24 + 2 * cam.pad), frame.h / (14 + ball.r + 2 * cam.pad));
  check('A: the zoom is the tighter axis\'s fit of the padded box', Math.abs(g.zoom - wantZoom) < 1e-6, `zoom=${g.zoom.toFixed(3)} want ${wantZoom.toFixed(3)}`);
  check('A: P2 pulls the centre up', g.y > ball.y + 3, `y=${g.y.toFixed(1)} vs ball ${ball.y.toFixed(1)}`);

  // B: the same layout ignores P2.
  cam.mode = 'B';
  cam.subject = 0;
  const gb = versusCameraGoal(frame);
  check('B: frames P1 and the ball only', gb.zoom > g.zoom && Math.abs(gb.y - ball.y) < 1e-6, `zoom ${gb.zoom.toFixed(2)} > ${g.zoom.toFixed(2)}, y=${gb.y.toFixed(1)}`);
  cam.subject = 1;
  const gb2 = versusCameraGoal(frame);
  check('B: subject 1 frames P2 and the ball', gb2.y > ball.y + 3, `y=${gb2.y.toFixed(1)}`);

  // The lead: a moving ball pulls the centre ahead of it.
  cam.mode = 'A';
  player.mesh.position.set(ball.x - 4, ball.y, 0);
  p2.pos.set(ball.x + 4, ball.y, 0);
  ball.vx = 40;
  const led = versusCameraGoal(frame);
  check('the centre leads a moving ball', led.x > ball.x + 2, `x=${led.x.toFixed(1)} vs ball ${ball.x.toFixed(1)}`);
  ball.vx = 0;

  // Smoothing and the claim: a fake world records what was asked of it.
  const claims = [];
  const world = {
    camera: { left: -frame.w / 2, right: frame.w / 2, top: 10.4, bottom: -41.6 },
    focusCamera(pos, zoom, weight) { claims.push({ x: pos.x, y: pos.y, zoom, weight }); },
  };
  updateVersusCamera(world, dt);
  check('the first frame claims the shot at full weight', claims.length === 1 && claims[0].weight === 1, JSON.stringify(claims[0]));
  const first = claims[0];
  for (let i = 0; i < 180; i++) updateVersusCamera(world, dt);
  const last = claims[claims.length - 1];
  const goal = versusCameraGoal(frame);
  check('...and settles on the goal within three seconds', Math.abs(last.x - goal.x) < 0.2 && Math.abs(last.zoom - goal.zoom) < 0.02, `zoom ${first.zoom.toFixed(2)} → ${last.zoom.toFixed(2)} (goal ${goal.zoom.toFixed(2)})`);
  check('the first frame is a CUT onto the goal, not a blend from the menu', Math.abs(first.zoom - goal.zoom) < 1e-6 && Math.abs(first.x - goal.x) < 1e-6, `first ${first.zoom.toFixed(2)} = goal ${goal.zoom.toFixed(2)}`);
  check('every claim is a zoom that holds the box it was asked for', claims.every((c) => c.zoom > 0 && c.zoom <= cam.zoomMax + 1e-9));
  cam.mode = savedMode;
  cam.subject = savedSubject;
}

// ---------------------------------------------------------------------------
section('One person playing: the ball and THEIR seal, and nobody else\'s');
{
  // WHO IS IN THE BOX — the only thing the framing varies, since the rule
  // above holds whatever is in it. 'auto' is the shipped mode and asks the
  // ROSTER, not the device: two people on one screen means both seals are
  // subjects, one person means the computer's seal is not one and does not
  // widen the shot. Both frames are real ones — a 16:9 laptop and a phone held
  // upright, which sees 24 world units of a 143-unit pitch.
  const wide = { w: 52 * 16 / 9, h: 52 };
  const tall = { w: 52 * 9 / 19.5, h: 52 };
  const cam = V.camera;
  const savedMode = cam.mode;
  const savedSubject = cam.subject;
  const savedBias = cam.bias;
  const savedTeams = versusSetup.teams.map((t) => ({ color: t.color, members: [...t.members] }));
  const roster = (a, b) => {
    versusSetup.teams[0].members.length = 0;
    versusSetup.teams[1].members.length = 0;
    if (a) versusSetup.teams[0].members.push(a);
    if (b) versusSetup.teams[1].members.push(b);
  };
  const HUMAN = { kind: 'human', pad: 'keyboard' };
  const PAD = { kind: 'human', pad: 1 };
  const CPU = { kind: 'cpu', pad: null };
  cam.mode = 'auto';
  resetBall();
  ball.vx = ball.vy = 0;
  const bx = ball.x;
  const by = ball.y;

  // WHO IS IN THE ROOM picks the framing.
  roster(null, null);
  player.mesh.position.set(bx - 30, by, 0);
  p2.pos.set(bx + 30, by, 0);
  const empty = versusCameraGoal(wide, {});
  cam.mode = 'A';
  const forcedA = versusCameraGoal(wide, {});
  cam.mode = 'auto';
  check('a match nobody set up frames everybody — the pad fallback can still put two people on the pitch',
    Math.abs(empty.zoom - forcedA.zoom) < 1e-9 && Math.abs(empty.x - forcedA.x) < 1e-9, `zoom ${empty.zoom.toFixed(3)} vs ${forcedA.zoom.toFixed(3)}`);

  roster(HUMAN, PAD);
  const twoUp = versusCameraGoal(wide, {});
  check('two people on one screen frames everybody', Math.abs(twoUp.zoom - forcedA.zoom) < 1e-9, `zoom ${twoUp.zoom.toFixed(3)}`);

  roster(HUMAN, CPU);
  const oneUp = versusCameraGoal(wide, {});
  check('one person against the computer does NOT — the CPU seal is not framed', oneUp.zoom > forcedA.zoom, `zoom ${oneUp.zoom.toFixed(2)} vs ${forcedA.zoom.toFixed(2)}`);
  p2.pos.set(bx + 30, by + 40, 0);
  const cpuMoved = versusCameraGoal(wide, {});
  check('...and moving it clean off the pitch moves nothing', Math.abs(cpuMoved.y - oneUp.y) < 1e-9 && Math.abs(cpuMoved.zoom - oneUp.zoom) < 1e-9, `y ${cpuMoved.y.toFixed(1)} zoom ${cpuMoved.zoom.toFixed(2)}`);

  // THE OTHER PERSON IS IN ANOTHER COUNTRY. Two humans on the roster, but one
  // of them is driven down a wire and has a screen and a camera of their own —
  // the case mode B was written for before a phone needed it.
  roster(HUMAN, { kind: 'human', pad: REMOTE });
  p2.pos.set(bx + 30, by + 40, 0);
  const remote = versusCameraGoal(wide, {});
  check('an online opponent is a person but not one on THIS screen', Math.abs(remote.zoom - oneUp.zoom) < 1e-9 && Math.abs(remote.y - oneUp.y) < 1e-9, `zoom ${remote.zoom.toFixed(2)}`);
  beginLobby('guest');
  const asGuest = versusCameraGoal(wide, {});
  check('...and the guest frames the seal IT drives, which is the right-hand one', asGuest.y > by + 3, `y=${asGuest.y.toFixed(1)} vs ball ${by.toFixed(1)}`);
  roster(HUMAN, PAD);
  const netTwo = versusCameraGoal(wide, {});
  check('a session in a room is never local play, whatever the roster says', Math.abs(netTwo.zoom - asGuest.zoom) < 1e-9, `zoom ${netTwo.zoom.toFixed(2)}`);
  endSession();

  // The one person can be the side on the RIGHT — a pad captain picked there
  // in the team select — and the frame follows their seal, not seat 0's.
  roster(CPU, PAD);
  p2.pos.set(bx + 6, by + 20, 0);
  player.mesh.position.set(bx - 6, by, 0);
  const right = versusCameraGoal(wide, {});
  check('the seal it biases to is the HUMAN captain, whichever side that is', right.y > by + 3, `y=${right.y.toFixed(1)} vs ball ${by.toFixed(1)}`);

  // THE PHONE. One person by construction, and the frame is a quarter as wide
  // as the one the pitch was composed for.
  roster(HUMAN, CPU);
  // A scramble at one end with the seal upfield, which is an ordinary shape
  // for a match and a hopeless one for a 24-unit frame. The rule does not
  // care: the shot opens out until it holds them, and what it costs is the
  // note above versusCameraGoal.
  player.mesh.position.set(bx - 80, by, 0);
  p2.pos.set(bx + 10, by, 0);
  const phone = versusCameraGoal(tall, {});
  check('upright, a seal 80 units off the ball still holds both...', inFrame(phone, tall, bx, by, ball.r) && inFrame(phone, tall, bx - 80, by), `zoom=${phone.zoom.toFixed(3)}, frame ${(tall.w / phone.zoom).toFixed(0)}x${(tall.h / phone.zoom).toFixed(0)}`);
  check('...by going far wider than the old 0.55 floor, which could not have', phone.zoom < 0.55, `zoom=${phone.zoom.toFixed(3)}`);
  check('...and it is the WIDTH that costs it, on a frame this shape', Math.abs(phone.zoom - tall.w / (80 + ball.r + 2 * cam.pad)) < 1e-9, `zoom=${phone.zoom.toFixed(3)}`);

  // ...and the same on the other axis: a seal deep under the ball opens the
  // frame downward rather than being left out of it.
  player.mesh.position.set(bx - 6, by - 26, 0);
  const deep = versusCameraGoal(tall, {});
  check('a seal deep below the ball opens the frame out', deep.zoom < 2 - 1e-6, `zoom ${deep.zoom.toFixed(3)}`);
  check('...and both are inside it', inFrame(deep, tall, bx, by, ball.r) && inFrame(deep, tall, bx - 6, by - 26), `y=${deep.y.toFixed(1)}`);

  // THE BIAS, on the axis the frame pans. On a wide screen there is slack for
  // it, so it is the whole of the difference between the two ends.
  // The seal is DEEP as well as wide: its depth is what opens the frame out
  // far enough for there to be slack to spend. Nose to nose with the ball the
  // shot is already at zoomMax and the clamp eats the bias whole.
  player.mesh.position.set(bx - 22, by - 20, 0);
  p2.pos.set(bx + 40, by, 0);
  cam.bias = 0;
  const none = versusCameraGoal(wide, {});
  cam.bias = 1;
  const full = versusCameraGoal(wide, {});
  check('bias 0 is the box\'s own centre', Math.abs(none.x - ((bx - 22) + (bx + ball.r)) / 2) < 1e-9, `x=${none.x.toFixed(2)}`);
  check('bias 1 puts the seal dead centre when there is slack for it', Math.abs(full.x - (bx - 22)) < 1e-9, `x=${full.x.toFixed(2)}`);
  check('...and both subjects are still in frame at either end',
    inFrame(none, wide, bx, by, ball.r) && inFrame(none, wide, bx - 22, by - 20)
    && inFrame(full, wide, bx, by, ball.r) && inFrame(full, wide, bx - 22, by - 20));
  // AND IT CANNOT SPEND WHAT IS NOT THERE. On the axis whose fit won, the box
  // touches both edges — so however hard the bias is asked to pull, the frame
  // does not move and nobody is pushed out.
  const clamped = versusCameraGoal(tall, {});
  check('bias 1 on the tight axis moves the frame not at all', Math.abs(clamped.x - none.x) < 1e-9 && inFrame(clamped, tall, bx, by, ball.r) && inFrame(clamped, tall, bx - 22, by - 20), `x=${clamped.x.toFixed(2)} vs ${none.x.toFixed(2)}`);

  cam.bias = savedBias;
  cam.mode = savedMode;
  cam.subject = savedSubject;
  for (let i = 0; i < versusSetup.teams.length; i++) {
    versusSetup.teams[i].color = savedTeams[i].color;
    versusSetup.teams[i].members.length = 0;
    versusSetup.teams[i].members.push(...savedTeams[i].members);
  }
}

// ---------------------------------------------------------------------------
section('THE RULE: the player and the ball are in frame, on every screen there is');
{
  // The one non-negotiable thing the match's camera does, swept rather than
  // spot-checked: every shape of screen the game ships on, against every
  // placement of a seal and a ball that a match can produce — both goalmouths,
  // the back of both tunnels, the ceiling, the floor, and the far corners
  // crossed against each other.
  //
  // IT IS SWEPT BECAUSE THE BUG IT IS FOR WAS INVISIBLE FROM 16:9. The floor
  // under the zoom was 0.55, typed against a laptop, and it held the pitch
  // there and nowhere else — the frame's height is a constant and its width is
  // the window's, so the zoom that holds a pitch-wide box is a different number
  // on every shape of glass. On a phone held upright 0.55 is four times too
  // tight, and the shot simply stopped opening and left the ball outside it.
  const cam = V.camera;
  const savedMode = cam.mode;
  const savedAspect = 16 / 9;
  cam.mode = 'B';
  cam.subject = 0;
  resetBall();
  ball.vx = ball.vy = 0;

  const screens = [
    ['laptop 16:9', 16 / 9],
    ['phone sideways 19.5:9', 19.5 / 9],
    ['tablet 4:3', 4 / 3],
    ['phone upright 9:16', 9 / 16],
    ['phone upright 9:19.5', 9 / 19.5],
  ];
  let worstZoom = Infinity;
  let worstWhere = '';
  for (const [name, aspect] of screens) {
    updateBounds(aspect);
    const frame = { w: bounds.frameWidth, h: bounds.frameTop - bounds.frameBottom };
    const floor = versusZoomFloor();
    // The extremes of the pitch, including the reach into both tunnels that a
    // keeper may swim to the back of (cameraReach).
    const reach = cameraReach();
    const xs = [bounds.left - reach, bounds.left + 1, 0, bounds.right - 1, bounds.right + reach];
    const ys = [bounds.bottom + 1, midWater(), bounds.top - 1];
    let held = 0;
    let tried = 0;
    let tightest = Infinity;
    for (const px of xs) for (const py of ys) for (const bxx of xs) for (const byy of ys) {
      ball.x = bxx; ball.y = byy;
      player.mesh.position.set(px, py, 0);
      const g = versusCameraGoal(frame, {});
      tried++;
      if (inFrame(g, frame, bxx, byy, ball.r) && inFrame(g, frame, px, py)) held++;
      if (g.zoom < tightest) tightest = g.zoom;
      if (g.zoom < worstZoom) { worstZoom = g.zoom; worstWhere = name; }
    }
    check(`${name}: both in frame in all ${tried} placements`, held === tried, `${tried - held} lost the ball or the seal`);
    // ...AND THE BACKDROP IS BUILT FOR THE WIDEST OF THEM. The camera has no
    // floor; versusZoomFloor is the same arithmetic run the other way round, so
    // it has to bound every shot the sweep just produced or the widest frame
    // lands on bare background.
    check(`${name}: the backdrop's floor ${floor.toFixed(3)} bounds the widest shot ${tightest.toFixed(3)}`, floor <= tightest + 1e-9);
  }
  note(`widest shot anywhere: zoom ${worstZoom.toFixed(3)} on ${worstWhere}`);

  // And the pair that made the rule: a phone upright, the ball at one goal and
  // the seal at the other. This is the shot the note above versusCameraGoal
  // costs out, and it is held.
  updateBounds(9 / 19.5);
  const tallFrame = { w: bounds.frameWidth, h: bounds.frameTop - bounds.frameBottom };
  ball.x = bounds.right - 2; ball.y = midWater();
  player.mesh.position.set(bounds.left + 2, midWater(), 0);
  const worst = versusCameraGoal(tallFrame, {});
  check('upright, ball at one goal and the seal at the other: both in frame',
    inFrame(worst, tallFrame, ball.x, ball.y, ball.r) && inFrame(worst, tallFrame, bounds.left + 2, midWater()),
    `zoom ${worst.zoom.toFixed(3)} — a frame ${(tallFrame.w / worst.zoom).toFixed(0)} x ${(tallFrame.h / worst.zoom).toFixed(0)} world units`);
  note(`the pitch is ${bounds.width.toFixed(0)} x ${(bounds.top - bounds.bottom).toFixed(0)}, so the play is ${((bounds.top - bounds.bottom) / (tallFrame.h / worst.zoom) * 100).toFixed(0)}% of that frame's height`);

  updateBounds(savedAspect);
  cam.mode = savedMode;
  resetBall();
}

// ---------------------------------------------------------------------------
section('The goal\'s jet: born off screen, squeezed out of the corridor, tumbling after');
{
  resetGoalJets();
  const J = V.goalJet;
  const gy = midWater();
  const h = mouthHalfHeight();
  const face = rockX(-1);
  const edge = screenEdgeX(-1);
  const before = drivenCap();
  // THE SAME DRAWS EVERY RUN, the way the collide and spread comparisons
  // further down already reseed for themselves. A jet's birth points and
  // speeds are random, and everything measured off THIS one — how long the
  // last lobe takes to clear the mouth, how fast they leave — was therefore a
  // function of how many Math.random calls the two thousand lines above
  // happened to make. Adding an event that throws particles anywhere earlier
  // in this file moved the exit time by a tenth of a second and failed a
  // check about the goal jet, which is a test measuring the harness rather
  // than the game.
  seed = 0x5ea1ba11;
  const jet = fireGoalJet(-1, gy + 2);
  check('a jet fires and claims driven slots', !!jet && jet.parts.length === J.count && drivenCap().free < before.free, `${jet?.parts.length} lobes, reserve ${JSON.stringify(drivenCap())}`);
  // BORN BEHIND BOTH LINES — the goal line, so no goo is in the corridor
  // before the ball has scored, and the screen's edge, so no lobe pops into
  // view. Both derived: neither can be left behind by a retune.
  const trigger = goalLineX(-1);
  const nearest = Math.max(...jet.parts.map((p) => p.x));
  const deepest = Math.min(...jet.parts.map((p) => p.x));
  const where = `x from ${nearest.toFixed(1)} to ${deepest.toFixed(1)} (line ${trigger.toFixed(1)}, screen edge ${edge.toFixed(1)}, face ${face.toFixed(1)}, back ${(face - tunnelDepth()).toFixed(1)})`;
  check('every lobe is born past the goal line AND off the screen', nearest <= trigger + 1e-6 && nearest <= edge + 1e-6, where);
  check('...and none of them inside the tunnel\'s back wall', deepest >= face - tunnelDepth() - 1e-6, where);
  // The band is as deep as it was asked for, or as deep as the tunnel had
  // room for — and it says which, so a slider that has stopped moving
  // anything is visible rather than merely disappointing.
  const bandWant = Math.min(J.bornSpan, goalJetState.born.room);
  check('...across the band the tunnel had room for', nearest - deepest > bandWant * 0.6 - 1e-6,
    `${(nearest - deepest).toFixed(1)} deep; asked for ${J.bornSpan}, the tunnel had ${goalJetState.born.room.toFixed(1)}${goalJetState.born.squeezed ? ' (squeezed)' : ''}`);
  // A LOBE'S RADIUS IS NOT `size`. `size` is a multiple of the ball goo
  // group's splat radius, so a lobe of 0.4 is a couple of world units across
  // — measure the corridor against the body, the way the lips do.
  const lobeR = (q) => Math.min(h * 0.9, q.size * (CONFIG.fx.goo.groups.ball.radius ?? CONFIG.fx.goo.radius) * (J.bodyRadius ?? 1));
  check('...inside the corridor\'s height, as bodies and not as splat centres', jet.parts.every((p) => p.y - lobeR(p) >= gy - h - 1e-6 && p.y + lobeR(p) <= gy + h + 1e-6), `widest lobe ${Math.max(...jet.parts.map(lobeR)).toFixed(2)} units in a ${h} half-height`);
  check('...aimed at the water', jet.parts.every((p) => p.vx > 0), `${jet.parts.filter((p) => p.vx <= 0).map((p) => p.vx.toFixed(1)).join(', ') || 'all outward'}`);
  check('...and released over the stagger, not at once', jet.parts.some((p) => p.age < -0.05) && jet.parts.every((p) => p.age > -J.stagger - 1e-6));
  // Step it on the wall clock and watch every lobe come out of the mouth.
  let lipBreach = 0; let outAt = new Map(); let fastest = 0; let t = 0; let peakLive = 0;
  while (goalJets().length && t < 5) {
    updateGoalJets(dt); t += dt;
    peakLive = Math.max(peakLive, goalJetState.live);
    for (const p of jet.parts) {
      if (p.slot < 0 || p.age < 0) continue;
      if (p.x < face && (p.y + p.size > gy + h + 0.05 || p.y - p.size < gy - h - 0.05)) lipBreach++;
      if (p.x > face && !outAt.has(p)) { outAt.set(p, { t, speed: Math.hypot(p.vx, p.vy) }); }
      fastest = Math.max(fastest, Math.hypot(p.vx, p.vy));
    }
  }
  check('no lobe ever crosses a lip while inside the corridor', lipBreach === 0, `${lipBreach} breaches`);
  check('every lobe comes out of the mouth', outAt.size === jet.parts.length, `${outAt.size} of ${jet.parts.length}`);
  const exitSpeeds = [...outAt.values()].map((o) => o.speed);
  check('...at speed', Math.min(...exitSpeeds) > 20 && fastest > 40, `exit ${Math.min(...exitSpeeds).toFixed(0)}–${Math.max(...exitSpeeds).toFixed(0)} u/s, fastest ${fastest.toFixed(0)}`);
  // THE SQUEEZE. Colliding the lobes is what makes the mass jam at the
  // opening rather than passing through itself — so with it on the cloud is
  // measurably more spread as it arrives than with it off. Same seed, same
  // jet, one knob.
  // THE SQUEEZE. What "collide" buys is that the lobes stop occupying each
  // other: a cloud fired down a corridor narrower than itself has to sort
  // itself out to get through the opening. Measured as OVERLAP — pairs
  // nearer than their two bodies allow — because that is the thing the knob
  // does; the width of what comes out is downstream of it and moves with the
  // nozzle and the lips as well.
  //
  // THE SAME DRAWS BOTH TIMES. The harness's Math.random is seeded, so two
  // runs back to back get different birth points and different speeds and
  // the comparison is between two jets rather than between two settings.
  // Reset the seed and the only difference left is the knob.
  const overlapAt = (collide) => {
    resetGoalJets();
    seed = 0x5ea1ba11;
    J.collide = collide;
    const g2 = fireGoalJet(-1, gy);
    // The INTEGRAL, not the peak. The worst single frame is the one a batch
    // is released on, where nothing has had time to push anything anywhere —
    // it barely moves with the knob and reads as the knob not working. How
    // long they spend inside each other is the thing colliding them buys.
    let overFrames = 0;
    for (let k = 0; k < 240 && goalJets().length; k++) {
      updateGoalJets(dt);
      let over = 0;
      const on = g2.parts.filter((q) => q.slot >= 0 && q.age >= 0);
      for (let x = 0; x < on.length; x++) {
        for (let y = x + 1; y < on.length; y++) {
          const rr = lobeR(on[x]) + lobeR(on[y]);
          // IN THREE DIMENSIONS, because the lobes are (they are born across
          // the corridor's bore and flare in depth on the way out). Measured
          // as a flat projection this counts two lobes a body's width apart in
          // z as occupying each other, which is the one thing the knob is
          // supposed to have already fixed — the measurement has to be the
          // same shape as the thing it is measuring.
          const dz = (on[x].z ?? 0) - (on[y].z ?? 0);
          if (Math.hypot(on[x].x - on[y].x, on[x].y - on[y].y, dz) < rr) over++;
        }
      }
      overFrames += over;
    }
    resetGoalJets();
    return overFrames;
  };
  const parted = overlapAt(true);
  const through = overlapAt(false);
  J.collide = true;
  seed = 0x5ea1ba11;
  check('colliding the lobes stops them occupying each other', parted < through * 0.75, `${parted} overlapping pair-frames with them colliding vs ${through} passing through each other`);
  // ...and the lips hold the lobe's BODY back, not its splat centre: the goo
  // drawn round a splat is wider than the splat, and a clamp on the centre
  // lets the picture through the rock.
  {
    resetGoalJets();
    const g3 = fireGoalJet(-1, gy);
    let bodyBreach = 0;
    for (let k = 0; k < 300 && goalJets().length; k++) {
      updateGoalJets(dt);
      for (const q of g3.parts) {
        if (q.slot < 0 || q.age < 0 || q.x >= face) continue;
        const rad = lobeR(q);
        if (q.y + rad > gy + h + 1e-6 || q.y - rad < gy - h - 1e-6) bodyBreach++;
      }
    }
    check('...and the lips hold the lobe\'s whole body, not its centre', bodyBreach === 0, `${bodyBreach} body breach(es); a lobe is up to ${Math.max(...g3.parts.map(lobeR)).toFixed(2)} units, its splat number ${Math.max(...g3.parts.map((q) => q.size)).toFixed(2)}`);
    resetGoalJets();
  }
  // THE KICK OUT OF THE MOUTH is an edge: once per lobe, on the crossing.
  {
    resetGoalJets();
    const g4 = fireGoalJet(-1, gy);
    for (let k = 0; k < 300 && goalJets().length; k++) updateGoalJets(dt);
    check('every lobe was kicked on its way out, once', g4.parts.every((q) => q.kicked === true), `${g4.parts.filter((q) => q.kicked).length} of ${g4.parts.length}`);
    resetGoalJets();
  }
  // THE SOURCE IS A RECTANGLE, not a point: the depth band times the share of
  // the corridor's height, and `spread` is the second of those.
  {
    const savedSpread = J.spread;
    const heightAt = (spread) => {
      resetGoalJets(); seed = 0x5ea1ba11;
      J.spread = spread;
      const g5 = fireGoalJet(-1, gy);
      const ys = g5.parts.map((q) => q.y);
      resetGoalJets();
      return Math.max(...ys) - Math.min(...ys);
    };
    const wide = heightAt(1);
    const narrow = heightAt(0.3);
    check('the source is a rectangle the spread sizes, not a point', wide > narrow * 2, `${wide.toFixed(1)} units tall at spread 1 vs ${narrow.toFixed(1)} at 0.3`);
    J.spread = savedSpread; seed = 0x5ea1ba11;
  }
  // THE FLARE opens the cone AT THE MOUTH. Aim scatter at birth cannot: a
  // lobe aimed steeper than the corridor allows hits a lip on the way. So the
  // spread of what comes OUT has to move with this and not only with that.
  {
    const savedFlare = J.flare;
    const coneAt = (flare) => {
      resetGoalJets(); seed = 0x5ea1ba11;
      J.flare = flare;
      const g6 = fireGoalJet(-1, gy);
      let widest = 0;
      for (let k = 0; k < 240 && goalJets().length; k++) {
        updateGoalJets(dt);
        const out = g6.parts.filter((q) => q.slot >= 0 && q.age >= 0 && q.x > face + 12);
        if (out.length > 6) {
          const ys = out.map((q) => q.y);
          widest = Math.max(widest, Math.max(...ys) - Math.min(...ys));
        }
      }
      resetGoalJets();
      return widest;
    };
    const flared = coneAt(1.2);
    const straight = coneAt(0);
    check('the flare widens the cone the jet leaves by', flared > straight * 1.15, `${flared.toFixed(1)} units across clear of the mouth at flare 1.2 vs ${straight.toFixed(1)} at 0`);
    J.flare = savedFlare; seed = 0x5ea1ba11;
  }
  // ...AND WHILE THE SHUTTER IS STILL LOOKING AT THE MOUTH. It used to be a
  // bare "under a second", which was a comfortable bound on a jet that had
  // nothing in its way; colliding the lobes puts a queue at the opening and
  // the queue costs time, so the number this has to beat is the one that
  // decides whether anybody sees it — freeze plus ramp, after which the
  // camera goes back to the pitch.
  const shutter = (V.clock.freeze ?? 0.35) + (V.clock.ramp ?? 0.45);
  const lastOut = Math.max(...[...outAt.values()].map((o) => o.t));
  check('...and all of it out while the shutter still holds the mouth', lastOut < shutter, `last out at ${lastOut.toFixed(2)}s, shutter ${shutter.toFixed(2)}s`);
  check('the jet lives and dies on the wall clock', goalJets().length === 0 && t <= J.life[1] + J.stagger + 0.1, `gone at ${t.toFixed(2)}s`);
  check('...and hands every slot back', drivenCap().free === before.free, JSON.stringify(drivenCap()));
  check('it fired through the live count', peakLive > 0 && goalJetState.fired >= 1);
  // --- DEPTH, AND THE SEALS IN THE WAY ------------------------------------
  // The pitch is filmed flat, so none of this shows on the pitch. The instant
  // replay is not: its last beat is this explosion and it is filmed by a pool
  // of perspective cameras that swing right through the cloud, where a jet
  // pinned to one plane is a cut-out from every angle but dead on.
  //
  // TWO SEPARATE FAILURES, and each of them looks fine from the ortho camera:
  // the depth never being given (a flat cloud), and the depth being given but
  // spreading INSIDE THE ROCK, which is a jet that leaves the mouth already
  // the width of the wall it came through.
  {
    resetGoalJets(); seed = 0x5ea1ba11;
    const g7 = fireGoalJet(-1, gy);
    const boreR = (J.bore ?? 0.7) * h;
    let insideMax = 0;
    let outsideMax = 0;
    for (let k = 0; k < 240 && goalJets().length; k++) {
      updateGoalJets(dt);
      for (const q of g7.parts) {
        if (q.slot < 0 || q.age < 0) continue;
        if (q.x < face) insideMax = Math.max(insideMax, Math.abs(q.z));
        else outsideMax = Math.max(outsideMax, Math.abs(q.z));
      }
    }
    check('the cloud has a third axis at all', outsideMax > 1, `${outsideMax.toFixed(1)} units of depth clear of the mouth`);
    check('...which the rock holds in while it is still inside', insideMax <= boreR + 1e-6,
      `${insideMax.toFixed(2)} deep in a bore of ${boreR.toFixed(2)}`);
    check('...so what comes out is wider in depth than what went down the corridor',
      outsideMax > insideMax, `${outsideMax.toFixed(1)} out vs ${insideMax.toFixed(1)} in`);
    resetGoalJets(); seed = 0x5ea1ba11;
  }
  // THE SEALS. Goo thrown out of a mouth hits whoever is standing in it. The
  // body is the same capsule the ball collides with, in three dimensions —
  // which is the difference between goo that stops flat against a silhouette
  // and goo that goes over, under and round an animal.
  {
    const pad = J.sealPad ?? 0.6;
    const bodyR = (V.ball?.body?.thickness ?? 0.69);
    // Parked square in front of the mouth, nose along the pitch.
    const body = { x: face + 14, y: gy, heading: 0 };
    const insideCount = (bodies) => {
      resetGoalJets(); seed = 0x5ea1ba11;
      const g8 = fireGoalJet(-1, gy);
      let worst = 0;
      let breaches = 0;
      for (let k = 0; k < 240 && goalJets().length; k++) {
        updateGoalJets(dt, bodies);
        for (const q of g8.parts) {
          if (q.slot < 0 || q.age < 0 || q.x < face) continue;
          // The capsule is a segment down the spine; square-on and level with
          // the mouth the nearest point is the spine itself, clamped.
          const t2 = Math.max(-(V.ball.body.tail - bodyR), Math.min(V.ball.body.nose - bodyR, q.x - body.x));
          const d = Math.hypot(q.x - (body.x + t2), q.y - body.y, q.z ?? 0);
          const min = bodyR + pad + lobeR(q);
          if (d < min - 1e-3) { breaches++; worst = Math.max(worst, min - d); }
        }
      }
      resetGoalJets();
      return { breaches, worst };
    };
    const off = insideCount(null);
    const on = insideCount([body]);
    check('with nobody handed in, the goo goes straight through a seal',
      off.breaches > 0, `${off.breaches} lobe-frames inside the animal, worst ${off.worst.toFixed(2)} units in`);
    check('...and handed the bodies, none of it is ever inside one',
      on.breaches === 0, `${on.breaches} lobe-frames inside, worst ${on.worst.toFixed(3)} units`);
    // ...AND IT DOES NOT SIMPLY VANISH. A collision that killed the lobe, or
    // parked it on the surface, would pass the check above and look nothing
    // like goo wrapping an animal.
    resetGoalJets(); seed = 0x5ea1ba11;
    const g9 = fireGoalJet(-1, gy);
    let behind = 0;
    let offPlane = 0;
    for (let k = 0; k < 240 && goalJets().length; k++) {
      updateGoalJets(dt, [body]);
      for (const q of g9.parts) {
        if (q.slot < 0 || q.age < 0) continue;
        if (q.x > body.x + (V.ball.body.nose ?? 3.31)) behind++;
        if (Math.abs(q.z ?? 0) > bodyR + pad) offPlane++;
      }
    }
    check('...it gets PAST the seal rather than piling up against it', behind > 0, `${behind} lobe-frames beyond the nose`);
    check('...over and under and round it, not only against its face', offPlane > 0, `${offPlane} lobe-frames clear of the body in depth`);
    resetGoalJets(); seed = 0x5ea1ba11;
  }
  // A goal in a match fires it, on the frame the goal is called.
  fired.clear(); resetGoalJets();
  const firedBefore = goalJetState.fired;
  versusState.phase = 'play'; resetBall();
  ball.x = bounds.left + 12; ball.y = midWater(); ball.vx = -30;
  for (let i = 0; i < 240 && versusState.phase === 'play'; i++) frame();
  check('a goal in a match fires the jet', versusState.phase === 'scored' && goalJetState.fired === firedBefore + 1 && goalJets().length === 1);
  check('...out of the goal the ball went in', goalJets()[0]?.side === -1);
  resetGoalJets();
  toPlay();
}

// ---------------------------------------------------------------------------
section('...and the bang throws the seals: away from it, limp, and hardest on the line');
{
  const B = V.goalJet.blast;
  const gy = midWater();
  // Read fresh rather than reused from the jet's section above: the shore is
  // rebuilt between them, and rockX moves with it. A stale face puts every
  // placement in this block a rock's thickness off where it says it is.
  const face = rockX(-1);
  note(`the mouth is at x ${face.toFixed(1)}, the bang at ${goalJetOrigin(-1, gy).x.toFixed(1)} — ${(face - goalJetOrigin(-1, gy).x).toFixed(1)} deep in a ${tunnelDepth()}-unit tunnel`);
  // Straight in front of the left mouth: a KEEPER inside the corridor, a seal
  // out in the water, and one parked beyond the reach.
  const keeper = player;
  const outfield = p2;
  const place = (seal, x, y) => {
    sealPos(seal).set(x, y, 0);
    seal.velocity.set(0, 0);
    seal.knockX = 0; seal.knockY = 0;
    const j = seal.jolt;
    if (j) { j.spin = j.spinV = j.roll = j.rollV = 0; j.free = 0; }
  };
  // The shove as it is DELIVERED: jostle splits it between real velocity and
  // the decaying knock offset, and a test that read only one of them would
  // measure velShare rather than the blast.
  const shoveX = (seal) => seal.velocity.x + seal.knockX;

  place(keeper, face - 2, gy);
  place(outfield, face + 26, gy);
  let caught = goalBlast(-1, gy);
  check('a goal blast catches the seals in front of the mouth', caught === 2, `${caught} caught`);
  check('...and throws them OUT of the goal, not into it', shoveX(keeper) > 1 && shoveX(outfield) > 1,
    `keeper ${shoveX(keeper).toFixed(1)} u/s, outfield ${shoveX(outfield).toFixed(1)} u/s`);
  check('...hardest on the line', shoveX(keeper) > shoveX(outfield) * 1.5,
    `${shoveX(keeper).toFixed(1)} vs ${shoveX(outfield).toFixed(1)}`);
  check('...and it leaves them limp rather than sprung', (keeper.jolt?.free ?? 0) > 0 && Math.abs(keeper.jolt?.spinV ?? 0) > 1,
    `free ${(keeper.jolt?.free ?? 0).toFixed(2)}s at ${(keeper.jolt?.spinV ?? 0).toFixed(1)} rad/s`);

  // A SEAL BEHIND THE BANG. The keeper may stand all the way back to the rock,
  // which is deeper than the band the jet is born across — the radial line
  // from the bang would shove that one into the tunnel's back wall.
  place(keeper, face - tunnelDepth() + 1, gy + 1);
  place(outfield, face + 500, gy);
  goalBlast(-1, gy);
  check('a keeper BEHIND the bang is swept out of the goal, not into the rock',
    shoveX(keeper) > 1, `${shoveX(keeper).toFixed(1)} u/s outward at ${(face - sealPos(keeper).x).toFixed(1)} deep`);
  check('...and a seal past the reach is untouched', Math.abs(shoveX(outfield)) < 1e-9 && (outfield.jolt?.free ?? 0) === 0,
    `${shoveX(outfield).toFixed(3)} u/s`);

  // THE RAGDOLL ITSELF: the spring is what stops a jolt reading as an
  // explosion, and it is capped at CONFIG.player.jolt.max. A tumble has to get
  // past that cap or it is a wobble with a longer name.
  const cap = CONFIG.player.jolt.max ?? 2.6;
  place(keeper, face + 2, gy);
  goalBlast(-1, gy);
  let peak = 0;
  let turned = 0;
  let was = keeper.jolt.spin;
  for (let k = 0; k < 60 && keeper.jolt.free > 0; k++) {
    poseBody(keeper, dt, 1, 0);
    peak = Math.max(peak, Math.abs(keeper.jolt.spin));
    turned += Math.abs(keeper.jolt.spin - was); was = keeper.jolt.spin;
  }
  check('the body turns past the spring\'s cap — it is a tumble, not a wobble', peak > cap,
    `${peak.toFixed(2)} rad, cap ${cap}`);
  note(`a seal caught on the line goes ${(turned / (Math.PI * 2)).toFixed(2)} turns in the first second`);
  // ...and it comes back. The spring picks the body up from wherever the limp
  // left it and rights it the short way round.
  for (let k = 0; k < 60 * 6; k++) poseBody(keeper, dt, 1, 0);
  check('...and the seal is upright again once the limp runs out',
    (keeper.jolt.free ?? 0) === 0 && Math.abs(keeper.jolt.spin) < 0.05 && Math.abs(keeper.jolt.roll) < 0.05,
    `spin ${keeper.jolt.spin.toFixed(3)}, roll ${keeper.jolt.roll.toFixed(3)}`);

  // THE KICKOFF CLEARS IT. The count snaps every body onto its spot with a
  // full wheel; one still turning would be facing the wrong way at the whistle.
  place(keeper, face + 2, gy);
  goalBlast(-1, gy);
  enterKickoff();
  check('a kickoff takes the tumble off every body',
    matchSeals().every((s) => (s.jolt?.free ?? 0) === 0 && !s.jolt?.spinV),
    matchSeals().map((s) => (s.jolt?.free ?? 0).toFixed(2)).join(', '));

  // OFF IS OFF.
  const wasOn = B.enabled;
  B.enabled = false;
  place(keeper, face + 2, gy);
  caught = goalBlast(-1, gy);
  check('...and the whole thing can be switched off', caught === 0 && Math.abs(shoveX(keeper)) < 1e-9);
  B.enabled = wasOn;

  // A REAL GOAL fires it, replay or no replay — the seals are posed from the
  // record during a replay, so a throw held back for the replay's bang would
  // land after the footage had handed the pitch back.
  toPlay();
  versusState.lastBlast = null;
  versusState.phase = 'play'; resetBall();
  place(keeper, face + 6, gy);
  ball.x = bounds.left + 12; ball.y = gy; ball.vx = -30;
  for (let i = 0; i < 240 && versusState.phase === 'play'; i++) frame();
  check('a goal in a match sets the shockwave off', !!versusState.lastBlast && versusState.lastBlast.caught > 0,
    JSON.stringify(versusState.lastBlast));
  check('...from inside the tunnel the jet is born in, not at the mouth',
    !!versusState.lastBlast && versusState.lastBlast.x < face - 1,
    `x ${versusState.lastBlast?.x?.toFixed(1)} vs face ${face.toFixed(1)}`);
  resetGoalJets();
  toPlay();
}

// ---------------------------------------------------------------------------
// TWO WAYS TO END, AND THE SAME MATCH EITHER WAY. Nothing about the ball, the
// seals or the kickoff changes — the only difference is which question is asked
// when a goal goes in.
//
// It sits beside the first-to section rather than at the end of the file, and
// that is worth a line: it used to have to be last. Playing matches out to a
// whistle costs simulated seconds, and two sections below it were reading a
// snared or suffocated seal as a collision result (see park() and still()
// there). With those parked properly this can go where it belongs, and the
// same suite passes with it in either place — which is the actual test of
// whether that was fixed or merely stepped around.
// ---------------------------------------------------------------------------
section('A timed match ends on the whistle, and can end level');
{
  const wasReplay = V.replay.enabled;
  V.replay.enabled = false;
  forgetMatchRules();
  // FIRST TO, which is the default and the shape everything above was measured
  // in: the goal that reaches the number IS the end.
  check('the default is a first-to', !isTimed() && goalsToWin() === V.toWin, `first to ${goalsToWin()}`);
  check('...and the clock is not a thing in it', timeLeft() === Infinity, `${timeLeft()}`);

  setTimed(true);
  setMatchSeconds(60);
  check('timed is a live setting, not a CONFIG edit', isTimed() && matchSeconds() === 60
    && V.timed === false && V.matchSeconds === 180,
    `rules ${matchSeconds()}s, config still ${V.matchSeconds}s / timed ${V.timed}`);

  resetVersus(); resetPlayer(); startVersus(scene); toPlay();
  check('the clock opens on the full match', Math.abs(timeLeft() - 60) < 1, `${timeLeft().toFixed(1)}s left`);
  // A GOAL IN A TIMED MATCH IS JUST A GOAL. First to five would have ended it.
  versusState.scores[0] = 5;
  versusState.scores[1] = 0;
  const r5 = matchResult(versusState.scores, timeLeft());
  check('...and five goals does not end one', r5.over === false, JSON.stringify(r5));
  // THE WHISTLE. Wound to the end rather than played for a minute: what is
  // under test is the transition, and a minute of simulated match is a minute
  // of other things going wrong.
  versusState.clock = 60;
  frame();
  check('the clock running out ends it', versusState.phase === 'won', `phase ${versusState.phase}`);
  check('...with the side ahead the winner', versusState.winner === 0 && versusState.draw === false,
    `winner ${versusState.winner}, draw ${versusState.draw}`);
  check('...and the clock does not go negative on the strip', timeLeft() === 0, `${timeLeft()}`);
  // ...AND LEVEL IS A DRAW, which is the one result a first-to cannot produce.
  resetVersus(); resetPlayer(); startVersus(scene); toPlay();
  versusState.scores[0] = 3;
  versusState.scores[1] = 3;
  versusState.clock = 60;
  frame();
  check('level at the whistle is a draw', versusState.phase === 'won' && versusState.draw === true
    && versusState.winner === -1,
    `winner ${versusState.winner}, draw ${versusState.draw}`);
  // A DRAW IS NEITHER SIDE'S WIN. Handing everybody the winner's rumble because
  // there was no loser is the one reading that is wrong for both of them.
  {
    fired.clear();
    resetVersus(); resetPlayer(); startVersus(scene); toPlay();
    versusState.scores[0] = 2; versusState.scores[1] = 2;
    versusState.clock = 60;
    fired.clear();
    frame();
    check('...and nobody is told they won or lost', !fired.has('versusWin') && !fired.has('versusLose'),
      [...fired.keys()].filter((n) => n.startsWith('versus')).join(' '));
  }
  // A 0-0 MATCH IS STILL A MATCH. The commonest way to get a draw is for
  // nothing to happen at all, and an end condition that needs a goal to have
  // been scored would play on forever.
  resetVersus(); resetPlayer(); startVersus(scene); toPlay();
  versusState.clock = 60;
  frame();
  check('nil-nil ends too', versusState.phase === 'won' && versusState.draw, `phase ${versusState.phase}`);

  // A REMATCH IS A NEW MATCH, AND A NEW MATCH HAS A FULL CLOCK. This is the one
  // that shipped broken: `rematch` zeroed the two scores and left everything
  // else where the last match had spent it, so a timed rematch opened with no
  // time on it, blew the whistle on its first frame of play and called a 0-0
  // draw nobody had played. Run all the way through the hold and the prompt,
  // because the bug is only reachable from the end of a real match.
  {
    resetVersus(); resetPlayer(); startVersus(scene); toPlay();
    versusState.scores[0] = 2; versusState.scores[1] = 1;
    versusState.clock = 60;
    frame();
    for (let t = 0; t < 12 && versusState.phase !== 'over'; t += dt) frame();
    check('a timed match reaches the prompt', versusState.phase === 'over', `phase ${versusState.phase}`);
    rematch();
    check('...and the rematch opens on a full clock', Math.abs(timeLeft() - 60) < 1e-6, `${timeLeft().toFixed(1)}s left`);
    check('...with the ledger the stats page reads wiped', tallySnapshot().teams[0].goals === 0 && tallySnapshot().teams[1].goals === 0,
      `${tallySnapshot().teams[0].goals}-${tallySnapshot().teams[1].goals}`);
    toPlay();
    frame();
    check('...and does not blow the whistle on its first frame', versusState.phase === 'play' && !versusState.draw,
      `phase ${versusState.phase}, draw ${versusState.draw}`);
  }

  // BACK TO FIRST-TO, and the goal ends it exactly as it always did.
  forgetMatchRules();
  setGoalsToWin(2);
  resetVersus(); resetPlayer(); startVersus(scene); toPlay();
  check('the goals to win is a live setting too', goalsToWin() === 2 && V.toWin === 5,
    `to win ${goalsToWin()}, config still ${V.toWin}`);
  resetBall();
  versusState.scores[0] = 1;
  versusState.phase = 'play';
  ball.x = bounds.right - 12; ball.y = midWater(); ball.vx = 30;
  for (let i = 0; i < 240 && versusState.phase === 'play'; i++) frame();
  check('...and the goal that reaches it is the end', versusState.phase === 'won' && versusState.winner === 0,
    `phase ${versusState.phase}, winner ${versusState.winner}, ${versusState.scores.join('-')}`);

  // HAND BACK THE AIR THIS SPENT. Running matches to a whistle costs simulated
  // seconds, and air drains with the match clock — a seal left short of it
  // bursts in whatever section runs next and is respawned in its own goal,
  // which from there looks like a collision flinging it up the pitch. Sections
  // below measure contests, not breathing.
  forgetMatchRules();
  V.replay.enabled = wasReplay;
  resetVersus(); resetPlayer(); startVersus(scene); toPlay();
  const air = Math.max(1, player.stats?.maxOxygen ?? CONFIG.oxygen?.max ?? 100);
  for (const seal of matchSeals()) seal.oxygen = air;
  versusState.dead[0] = 0; versusState.dead[1] = 0;
}

// ---------------------------------------------------------------------------
section('The instant replay: the shot, the flight, the explosion — and a hold skips it');
{
  const R = V.replay;
  const k = V.clock;
  const camFrame = { w: 52 * 16 / 9, h: 52 };
  R.enabled = true;
  R.onlyWinner = false;
  toPlay();
  const scoresBefore = versusState.scores[0];
  // A recorded shot: player 1 dashes into a still ball 30 units short of the
  // right goal, full power, square on. Player 2 is parked out of the way.
  resetBall();
  ball.x = bounds.right - 30; ball.y = midWater();
  p2.pos.set(bounds.left + 10, midWater() - 15, 0); p2.vel.set(0, 0);
  const restX = ball.x - ballReach() - 12;
  player.mesh.position.set(restX, ball.y, 0);
  player.velocity.set(0, 0);
  settle(R.lead + 0.5); // history before the touch, so the lead has frames of THIS setup
  player.mesh.position.set(ball.x - ballReach() + 0.4, ball.y, 0);
  player.velocity.set(40, 0);
  // What the ball looked like the frame before the shot — the replay opens
  // before the touch and has to show THIS, not what the goal made of it.
  const gooBall = CONFIG.fx?.goo?.groups?.ball ?? {};
  const liveBefore = { owner: ballLookState().owner, mix: gooBall.tintMix ?? 0 };
  strikeState.active = true; strikeState.dashDir.x = 1; strikeState.dashDir.y = 0; strikeState.power = 1;
  ball.dashHit[0] = false;
  frame();
  strikeState.active = false;
  const touch = versusState.lastTouch;
  check('the strike is noted as the last touch', !!touch && touch.who === 0 && touch.kind === 'strike', JSON.stringify(touch));
  const strikeX = ball.x;
  const jetsBefore = goalJetState.fired;
  fired.clear();
  let frames = 0;
  while (versusState.phase === 'play' && frames < 400) { frame(); frames++; }
  check('the ball goes in', versusState.phase === 'scored' && versusState.scores[0] === scoresBefore + 1, `phase ${versusState.phase} after ${frames} frames`);
  check('a replay is pending, and the jet is held back for it', versusState.replayPending === true && goalJetState.fired === jetsBefore, `pending ${versusState.replayPending}, jets ${goalJetState.fired - jetsBefore}`);
  const goalX = ball.x;
  // A camera to cut: the live framing settles first, so the replay's first
  // frame is measurably a CUT and not the tail of a blend.
  const claims = [];
  const world = {
    camera: { left: -camFrame.w / 2, right: camFrame.w / 2, top: 10.4, bottom: -41.6 },
    focusCamera(pos, zoom, weight) { claims.push({ x: pos.x, y: pos.y, zoom, weight }); },
  };
  for (let i = 0; i < 90; i++) updateVersusCamera(world, dt);
  const liveCam = { ...versusCameraState() };
  replayState.cuts = 0;
  // The freeze has its beat with the number up, then the replay opens.
  let t = versusState.phaseT;
  for (let i = 0; i < 120 && versusState.phase !== 'replay'; i++) { frame(); updateVersusCamera(world, dt); t += dt; }
  check('the replay opens once the freeze has had its beat', versusState.phase === 'replay' && replayState.active && Math.abs(t - k.freeze) < dt * 3, `phase ${versusState.phase} at ${t.toFixed(2)}s (freeze ${k.freeze})`);
  check('...on the frame `lead` before the touch, with the ball back where it was', replayState.t <= touch.t - R.lead + dt && ball.x < strikeX && Math.abs(ball.x - (bounds.right - 30)) < 1, `t ${replayState.t.toFixed(2)} vs touch ${touch.t.toFixed(2)}, ball x ${ball.x.toFixed(1)} vs rest ${(bounds.right - 30).toFixed(1)}`);
  check('...counted', versusState.replays === 1);
  check('the world is frozen under it', updateVersusClock(dt) <= k.freezeScale + 1e-9);
  // ...AND SO IS THE TAPE. The move is scheduled on the audio thread, so with
  // no audio context the model lands on its target in one step and what is
  // under test here is the ENDPOINT and who is holding it — not the ramp,
  // which no harness can time. See replayRestoreSeconds for the other half.
  check('the sound sags with it', Math.abs(musicRateScale() - R.audio.rate) < 1e-6,
    `${musicRateScale().toFixed(3)} (want ${R.audio.rate})`);
  frame();
  check('...and the one-shots follow the tape, not a second copy of its curve',
    Math.abs(sfxRateScale() - (1 + (musicRateScale() - 1) * R.audio.sfxFollow)) < 1e-6,
    `sfx ${sfxRateScale().toFixed(3)} vs music ${musicRateScale().toFixed(3)} at follow ${R.audio.sfxFollow}`);
  // THE IMPACT SHOT: a hard cut to the ball and the striker, tight.
  const g = versusCameraGoal(camFrame, {});
  check('the impact beat opens on the ball and the striker, closer than play ever goes', replayState.beat === 'impact' && g.zoom > V.camera.zoomMax + 0.5 && Math.abs(g.x - (ball.x + player.mesh.position.x) / 2) < 3, `beat ${replayState.beat}, zoom ${g.zoom.toFixed(2)}, x ${g.x.toFixed(1)} (ball ${ball.x.toFixed(1)}, seal ${player.mesh.position.x.toFixed(1)})`);
  updateVersusCamera(world, dt);
  const cam1 = versusCameraState();
  check('...and the camera CUTS to it — on the frame, not a blend', replayState.cuts === 1 && Math.abs(cam1.zoom - g.zoom) < 1e-6 && Math.abs(cam1.x - g.x) < 1e-6 && Math.abs(cam1.zoom - liveCam.zoom) > 0.5, `cuts ${replayState.cuts}, zoom ${liveCam.zoom.toFixed(2)} → ${cam1.zoom.toFixed(2)} (goal ${g.zoom.toFixed(2)})`);

  // THE POOL: the replay is filmed through a perspective shot off the plane.
  const RC = R.cams;
  const rcam = replayRenderCamera();
  check('the replay renders through the pool\'s perspective camera', !!rcam && rcam.isPerspectiveCamera === true && poolState.shot >= 0, `shot ${poolState.shotName}`);
  const shot0 = RC.shots[poolState.shot];
  check('...a shot that serves the impact beat', !!shot0 && shot0.beats.includes('impact'), shot0?.name);
  check('...swung off the flat plane, in z space', !!rcam && (Math.abs(rcam.position.x - poolState.cur.at.x) > 1 || Math.abs(rcam.position.y - poolState.cur.at.y) > 1) && rcam.position.z > 0, rcam ? `cam (${rcam.position.x.toFixed(1)},${rcam.position.y.toFixed(1)},${rcam.position.z.toFixed(1)}) at (${poolState.cur.at.x.toFixed(1)},${poolState.cur.at.y.toFixed(1)})` : 'none');
  check('...with every target it weights in frame', !!rcam && targetsInFrame(shot0, replayState.pois, rcam));
  check('...kept in the water', !!rcam && rcam.position.x >= bounds.left + RC.wallInset - 1e-6 && rcam.position.x <= bounds.right - RC.wallInset + 1e-6 && rcam.position.y >= bounds.bottom + RC.floorInset - 1e-6, rcam ? `x ${rcam.position.x.toFixed(1)} y ${rcam.position.y.toFixed(1)}` : 'none');
  check('the lens is the replay\'s: forced on, focused on the primary target', cineLens.forced && cineLens.active && cineLens.focusX >= 0 && cineLens.focusX <= 1 && cineLens.focusY >= 0 && cineLens.focusY <= 1, `focus (${cineLens.focusX.toFixed(2)},${cineLens.focusY.toFixed(2)})`);
  const firstShot = poolState.shot;
  const fov0 = rcam?.fov ?? 0;
  check('...and player 1 is posed from the record, back where it was before the shot', Math.abs(player.mesh.position.x - restX) < 6, `seal x ${player.mesh.position.x.toFixed(1)} vs ${restX.toFixed(1)}`);
  // THE BALL LOOKS AS IT DID. The recorder keeps the look per frame and the
  // replay poses it back, so the opening frame — before the touch — shows the
  // ball exactly as the player saw it then, and NOT the goal's final state
  // (claimBall had handed the whole body to the scorer by then, and the old
  // replay played the whole shot in a colour the ball had not earned yet).
  // The scorer's colour arrives when the touch does; measured in the loop.
  check('the replay opens on the ball as it was before the shot, not as the goal left it', ballLookState().owner === liveBefore.owner && Math.abs((gooBall.tintMix ?? 0) - liveBefore.mix) < 0.02, `owner ${ballLookState().owner} (live ${liveBefore.owner}), mix ${(gooBall.tintMix ?? 0).toFixed(2)} (live ${liveBefore.mix.toFixed(2)})`);
  let ownedAtT = -1;          // the replay's recorded second the ball first read as the scorer's
  let ownedBeforeTouch = false;
  let tintWrongFrames = 0;    // frames the scorer owned it and the group's tint was not theirs
  let maxMixFootage = 0;
  // THE SEALS ARE STILL SWIMMING. Nothing else advances a mixer under a
  // replay: player 2's stepP2 is not called at all and player 1's updatePlayer
  // is running on a world dilated to four percent, so both bodies used to slide
  // through the frame frozen. poseReplay drives the clips itself, on the
  // replay's own clock.
  const savedAnim = p2.anim;
  const ticks = { n: 0, dt: 0, state: null };
  p2.anim = {
    update(adt, state) { ticks.n++; ticks.dt += adt; ticks.state = state; },
    reset() {}, trigger() {}, isPlayingOneShot() { return false; },
  };
  const wasEnabled = CONFIG.animation.enabled;
  CONFIG.animation.enabled = true;
  for (let i = 0; i < 6; i++) frame();
  check('player 2\'s clips are ticked through the replay, not frozen with the water', ticks.n >= 5, `${ticks.n} tick(s)`);
  check('...on the replay\'s clock — wall seconds at the replay\'s speed', ticks.n > 0 && Math.abs(ticks.dt / ticks.n - dt * replayState.speed) < 1e-6, `${(ticks.dt / Math.max(1, ticks.n)).toFixed(4)}s per tick vs ${(dt * replayState.speed).toFixed(4)}`);
  CONFIG.animation.enabled = wasEnabled;
  p2.anim = savedAnim;
  // Play it through: the beats in order, the ball flying to the line, the
  // explosion on the mouth with the jet, then the shutter resumes.
  const beats = [];
  let wideHoldsAll = true;   // the mouth, the ball and the scorer inside the wide frame, every frame of it
  let wideCapped = true;
  let wideZoomMonotone = true; // the opening-out is a BLEND: the camera's zoom walks down, never jumps
  let prevCamZoom = null;
  let impactMaxZoom = 0;     // the tightest the impact shot gets as the two close
  let maxBallX = -Infinity;
  let jetAt = -1;
  let wall = 0;
  let celebrateSeqAt = celebrationState.seq;
  let celebratedOn = null;
  let noCelebrationBefore = true;
  // The seam main.js hangs the input gate on. It did not exist: the frame loop
  // had no idea a replay was running, so updateInput → updatePlayer →
  // updateCharge → tryStrike all executed on live input at four percent, and a
  // released trigger banked a dash that fired the instant the replay ended.
  let heldEveryFrame = true;
  let heldFrames = 0;
  // The flat camera's hard cuts BEFORE the celebration beat. The celebration
  // is entered on a deliberate cut of its own (advanceBeats), so a bare total
  // no longer says anything about how the wide shot was opened out.
  let cutsBeforeCelebration = -1;
  // IS THE PICTURE SMOOTH? Sampled as JERK — how much the camera's per-frame
  // step changes from one frame to the next — within a single shot, with any
  // frame of a cut or a blend left out, since those are discontinuous by
  // design. A pose that is being corrected by a rule with a hard in/out test
  // shows up here and nowhere else: it looks like nothing in a still, reads as
  // a tick in motion, and every other assertion in this file passes straight
  // through it. The seam slide used to move the look-at in fixed 1.5-unit
  // steps and scored 1.5 here.
  const camTrack = [];
  // The pool through the replay: shots on their beats, targets in frame,
  // switches, the push-in, the defocus.
  const shotsUsed = new Set([poolState.shotName]);
  let offBeatFrames = 0;
  let lastBeat = replayState.beat;
  let sinceBeatChange = 99;
  let outOfFrameFrames = 0;
  let settledFrames = 0;
  let primaryOutFrames = 0;
  const outBy = new Map();
  let heavyOutFrames = 0;
  let pushedFov = fov0;
  let pushT = 0;
  let maxDefocus = 0;
  let explosionShotOk = false;
  // NO SEAMS: the frame's edge on the plane never reaches past a goal's face
  // by more than pastFace, the camera stays wallInset inside the walls, and
  // a shot whose look-at is on a wall looks at it square.
  let seamFrames = 0;
  let insetFrames = 0;
  let squareFrames = 0;
  const _pt = new THREE.Vector3();
  const parkedT = replayState.resumeT;
  const face = rockX(1);
  for (let i = 0; i < 60 * 12 && versusState.phase === 'replay'; i++) {
    frame(); wall += dt;
    updateVersusCamera(world, dt);
    if (replayState.active && replayState.t < replayState.endT) {
      const lk = ballLookState();
      if (lk.owner === 0) {
        if (ownedAtT < 0) ownedAtT = replayState.t;
        if (replayState.t < touch.t - dt) ownedBeforeTouch = true;
        if (gooBall.tint !== V.teams[0].color) tintWrongFrames++;
        maxMixFootage = Math.max(maxMixFootage, gooBall.tintMix ?? 0);
      }
    }
    const b = replayState.beat;
    if (!beats.length || beats[beats.length - 1] !== b) beats.push(b);
    maxBallX = Math.max(maxBallX, ball.x);
    if (b === 'impact') impactMaxZoom = Math.max(impactMaxZoom, versusCameraGoal(camFrame, {}).zoom);
    if (b !== 'impact') {
      const gg = versusCameraGoal(camFrame, {});
      const halfW = camFrame.w / (2 * gg.zoom);
      const halfH = camFrame.h / (2 * gg.zoom);
      const scorer = player.mesh.position;
      const inside = (x, y) => Math.abs(x - gg.x) <= halfW + 1e-6 && Math.abs(y - gg.y) <= halfH + 1e-6;
      if (!inside(face, mouthY()) || !inside(ball.x, ball.y) || !inside(scorer.x, scorer.y)) wideHoldsAll = false;
      if (gg.zoom > R.wide.zoom + 1e-9) wideCapped = false;
      const cz = versusCameraState().zoom;
      if (prevCamZoom != null && cz > prevCamZoom + 1e-6) wideZoomMonotone = false;
      prevCamZoom = cz;
    }
    if (jetAt < 0 && goalJetState.fired > jetsBefore) jetAt = b;
    if (!celebratedOn && celebrationState.seq !== celebrateSeqAt) celebratedOn = b;
    if (b !== 'celebration' && celebrationState.active) noCelebrationBefore = false;
    if (b === 'celebration' && cutsBeforeCelebration < 0) cutsBeforeCelebration = (replayState.cuts ?? 0) - 1;
    if (replayState.active && poolState.shot >= 0) {
      const _po = replayState.pois;
      camTrack.push({ shot: poolState.shot, name: poolState.shotName, beat: b, onShot: poolState.onShot, blend: poolState.blendT,
        bx: _po?.ball.x ?? 0, by: _po?.ball.y ?? 0, stx: _po?.striker.x ?? 0, sty: _po?.striker.y ?? 0,
        ax: poolState.cur.at.x, ay: poolState.cur.at.y,
        px: poolState.cur.pos.x, py: poolState.cur.pos.y, fov: poolState.cur.fov });
    }
    if (replayState.active) {
      heldFrames++;
      if (!replayHoldsInput() || !(replaySpeed() > 0)) heldEveryFrame = false;
    }
    // The pool this frame.
    const pc = replayRenderCamera();
    if (pc && poolState.shot >= 0) {
      const sh = RC.shots[poolState.shot];
      shotsUsed.add(sh.name);
      if (b !== lastBeat) { lastBeat = b; sinceBeatChange = 0; } else sinceBeatChange++;
      if (!sh.beats.includes(b) && sinceBeatChange > 4) offBeatFrames++;
      if (poolState.blendT >= 1) {
        settledFrames++;
        let heavyOut = false;
        if (!targetsInFrame(sh, replayState.pois, pc)) {
          outOfFrameFrames++;
          for (const [nm, w] of Object.entries(sh.targets)) {
            const q = replayState.pois[nm];
            _pt.set(q.x, q.y, 0).project(pc);
            // A light target (under 0.3) is a preference, not a promise: a face
            // push-in cannot also hold the goal, and does not claim to.
            if (w >= 0.3 && !(_pt.z < 1 && Math.abs(_pt.x) <= 1 && Math.abs(_pt.y) <= 1)) { const k = `${sh.name}:${nm}(${w})`; outBy.set(k, (outBy.get(k) ?? 0) + 1); heavyOut = true; }
          }
          if (heavyOut) heavyOutFrames++;
        }
        // The heaviest target is never out: that is what the shot is OF.
        let prim = null; let pw = -1;
        for (const [nm, w] of Object.entries(sh.targets)) if (w > pw) { pw = w; prim = replayState.pois[nm]; }
        if (prim) {
          _pt.set(prim.x, prim.y, 0).project(pc);
          if (!(_pt.z < 1 && Math.abs(_pt.x) <= 1 && Math.abs(_pt.y) <= 1)) primaryOutFrames++;
        }
      }
      if (poolState.shot === firstShot && poolState.onShot > 0.5 && pushT === 0) { pushedFov = pc.fov; pushT = poolState.onShot; }
      maxDefocus = Math.max(maxDefocus, cineLens.defocus);
      if (b === 'explosion' && sh.beats.includes('explosion')) explosionShotOk = true;
      if (poolState.blendT >= 1) {
        const at = poolState.cur.at;
        for (const sd of [-1, 1]) {
          _pt.set(rockX(sd) + sd * (RC.pastFace + 1.5), at.y, 0).project(pc);
          if (Math.abs(_pt.x) <= 1 && Math.abs(_pt.y) <= 1 && _pt.z < 1) seamFrames++;
        }
        if (pc.position.x < bounds.left + RC.wallInset - 1e-6 || pc.position.x > bounds.right - RC.wallInset + 1e-6) insetFrames++;
        const dWall = Math.min(at.x - bounds.left, bounds.right - at.x);
        if (dWall <= RC.nearWallMin && Math.abs(pc.position.x - at.x) > 0.5) squareFrames++;
      }
    }
  }
  check('no seams: the frame never reaches past a goal\'s face, on any settled frame', seamFrames === 0, `${seamFrames} frame-edge(s) past a face`);
  check('...the camera stays well inside the walls', insetFrames === 0, `${insetFrames} frame(s) inside the inset`);
  check('...and a shot on the mouth looks at it square', squareFrames === 0, `${squareFrames} angled frame(s) at the wall`);
  check('the pool keeps to shots that serve the beat, past a few frames of each change', offBeatFrames === 0, `${offBeatFrames} off-beat frame(s)`);
  check('...and a settled shot always has what it is a shot OF in frame', primaryOutFrames === 0, `${primaryOutFrames} frame(s) with the primary target out`);
  check('...and every target it promises (weight 0.3 and up) in frame nearly always', heavyOutFrames <= Math.max(3, settledFrames * 0.05), `${heavyOutFrames} of ${settledFrames} settled frame(s) with a promised target out — ${[...outBy].map(([k, n]) => `${k} x${n}`).join(', ') || 'none'}`);
  check('it changed angle at least twice across the three beats', poolState.cuts + poolState.blends >= 2 && shotsUsed.size >= 2, `${poolState.cuts} cut(s), ${poolState.blends} blend(s), shots: ${[...shotsUsed].join(', ')}`);
  check('...and an explosion shot covers the bang', explosionShotOk);
  check('a shot pushes in slowly while it holds', (RC.shots[firstShot].push ?? 99) >= (RC.shots[firstShot].fov ?? 0) || (pushT > 0 && pushedFov < fov0 - 0.5), `fov ${fov0.toFixed(1)} → ${pushedFov.toFixed(1)} after ${pushT.toFixed(2)}s on ${RC.shots[firstShot].name}`);
  check('the defocus comes up round the target', maxDefocus > 0.2, `max ${maxDefocus.toFixed(2)}`);
  check('after the replay the world\'s own camera and lens are back', replayRenderCamera() === null && !cineLens.forced && cineLens.defocus === 0 && !poolState.active, `camera ${replayRenderCamera() === null ? 'world' : 'pool'}, forced ${cineLens.forced}, defocus ${cineLens.defocus}, pool ${poolState.active}, phase ${versusState.phase}`);
  check('the beats run impact → wide → explosion → celebration', beats.join(',') === 'impact,wide,explosion,celebration', beats.join(','));
  check('the impact shot tightens to its ceiling as the two collide', impactMaxZoom >= Math.min(R.impact.zoom, 4) - 1e-6, `tightest ${impactMaxZoom.toFixed(2)} (ceiling ${R.impact.zoom})`);
  check('the wide shot holds the mouth, the ball and the scorer, all of it', wideHoldsAll && wideCapped, `all in ${wideHoldsAll}, capped ${wideCapped}`);
  check('...opened out as a BLEND from the impact shot, no second cut', cutsBeforeCelebration === 1 && wideZoomMonotone, `cuts before the celebration ${cutsBeforeCelebration}, monotone ${wideZoomMonotone}`);
  check('...and the celebration beat is entered on a CUT', (replayState.cuts ?? 0) === cutsBeforeCelebration + 1, `${replayState.cuts} cut(s) in all, ${cutsBeforeCelebration} before the celebration`);
  check('the replay carries the ball all the way to the line', Math.abs(maxBallX - goalX) < 0.5, `${maxBallX.toFixed(1)} vs ${goalX.toFixed(1)}`);
  check('the scorer\'s colour arrives on the touch, as it did live — not a second early', ownedAtT >= 0 && !ownedBeforeTouch && ownedAtT <= touch.t + dt * 4, `owned from t ${ownedAtT.toFixed(2)} (touch ${touch.t.toFixed(2)}), early ${ownedBeforeTouch}`);
  check('...in the scorer\'s colour, marching in over the flight', tintWrongFrames === 0 && maxMixFootage > 0.05, `${tintWrongFrames} wrong-tint frame(s), mix up to ${maxMixFootage.toFixed(2)}`);
  check('the jet fires on the explosion beat, with the goal\'s own event', jetAt === 'explosion' && firedCount('versusGoal') === 2, `jet at ${jetAt}, versusGoal x${firedCount('versusGoal')}`);
  // THE POSE IS THE LAST BEAT'S, AND ONLY THE LAST BEAT'S. It used to fire
  // twice — once at the live goal and again at the explosion — and the first
  // of those ran on the wall clock right through the shutter's freeze and the
  // replay's lead-up, so the replay opened on a seal celebrating a goal it had
  // not scored yet. `noCelebrationBefore` is the assertion that would have
  // caught it: nothing may start one until the beat named after it.
  check('...and the scorer celebrates on the CELEBRATION beat, not before', celebratedOn === 'celebration', `celebrated on ${celebratedOn}`);
  check('...with nothing celebrating over the lead-up', noCelebrationBefore, 'a pose was running before the celebration beat');
  check('the controls are held for every frame of it', heldEveryFrame && heldFrames > 60, `${heldFrames} frame(s) sampled, all holding ${heldEveryFrame}`);
  check('...and handed back the moment it ends', !replayHoldsInput() && replaySpeed() === 0, `holding ${replayHoldsInput()}, speed ${replaySpeed()}`);
  {
    // A SUBJECT THAT JUMPS IS NOT THE CAMERA'S FAULT. No rig hides a teleport,
    // and this harness moves its seals about directly. The camera is DAMPED, so
    // a subject's jolt keeps showing in the picture for as long as the follow
    // takes to settle — the window below, not just the frame it landed on.
    // What is left is the honest claim: where the things being filmed moved
    // smoothly, the picture did too. That is exactly the property the seam
    // slide broke, and it broke it with the subjects standing perfectly still.
    const settle = Math.ceil(0.35 / dt);
    const dirty = new Array(camTrack.length).fill(false);
    for (let i = 2; i < camTrack.length; i++) {
      let jump = 0;
      for (const k of ['bx', 'by', 'stx', 'sty']) {
        jump = Math.max(jump, Math.abs((camTrack[i][k] - camTrack[i - 1][k]) - (camTrack[i - 1][k] - camTrack[i - 2][k])));
      }
      if (jump > 0.5) for (let j = i; j < Math.min(camTrack.length, i + settle); j++) dirty[j] = true;
    }
    let worst = 0; let worstKey = ''; let n = 0; let worstAt = null;
    for (let i = 2; i < camTrack.length; i++) {
      const a2 = camTrack[i]; const a1 = camTrack[i - 1]; const a0 = camTrack[i - 2];
      if (a2.shot !== a1.shot || a1.shot !== a0.shot) continue;   // a cut is meant to jump
      if (a2.blend < 1 || a1.blend < 1) continue;                 // so is a blend, on its way
      if (dirty[i]) continue;
      n++;
      for (const k of ['ax', 'ay', 'px', 'py', 'fov']) {
        const j = Math.abs((a2[k] - a1[k]) - (a1[k] - a0[k]));
        if (j > worst) { worst = j; worstKey = k; worstAt = a2; }
      }
    }
    // A tenth of a world unit (or a tenth of a degree) between two frames of
    // one shot. The smooth motion itself measures a fiftieth of that, so this
    // is loose enough not to chase tuning and tight enough that a stepped
    // correction cannot hide under it.
    check('the camera holds still between frames of one shot — no stepping', worst < 0.1 && n > 60,
      `worst jerk ${worst.toFixed(4)} on ${worstKey || 'nothing'}`
      + (worstAt ? ` during ${worstAt.name} (${worstAt.beat}, ${worstAt.onShot.toFixed(2)}s in)` : '')
      + `, over ${n} steady frame(s)`);

  }
  check('played slow', replayState.speed >= R.speed - 1e-9 && replayState.speed <= 1, `speed ${replayState.speed.toFixed(2)}`);
  check('...and no longer than maxWall plus the two held beats', wall <= R.maxWall + R.explode + (R.celebrateHold ?? 1.7) + 0.2, `${wall.toFixed(2)}s`);
  // THE RAMP HOME IS THE SHUTTER'S TO FIT: the ball is back at centre
  // `respawn - freeze` after this, and the count goes up over it.
  check('the ramp back fits inside the shutter\'s own window',
    replayRestoreSeconds() <= (k.respawn - k.freeze) + 1e-9 && replayRestoreSeconds() > 0,
    `${replayRestoreSeconds().toFixed(2)}s of ${(k.respawn - k.freeze).toFixed(2)}s`);
  {
    // ...whatever is typed into it. The clamp is the guarantee, not the number.
    const was = R.audio.restore;
    R.audio.restore = 99;
    check('...however long the slider is dragged', replayRestoreSeconds() <= (k.respawn - k.freeze) + 1e-9,
      `${replayRestoreSeconds().toFixed(2)}s`);
    R.audio.restore = was;
  }
  // One frame, because the one-shots follow the music rather than being set
  // beside it: the ramp home is ordered as the replay closes and the sfx rate
  // is read off it on the next tick of updateVersusClock. In the game that
  // frame is 16ms in the middle of a 0.75s ramp; here, with no audio context,
  // it is the whole move.
  frame();
  check('the tape is back at full speed for the kickoff', Math.abs(musicRateScale() - 1) < 1e-6 && Math.abs(sfxRateScale() - 1) < 1e-6,
    `music ${musicRateScale().toFixed(3)}, sfx ${sfxRateScale().toFixed(3)}`);
  check('then the shutter resumes where it was parked', versusState.phase === 'scored' && Math.abs(versusState.phaseT - parkedT) < dt * 2 && !replayState.active, `phase ${versusState.phase}, phaseT ${versusState.phaseT.toFixed(2)} (parked ${parkedT.toFixed(2)})`);
  check('...and into a kickoff', toPlay(), versusState.phase);

  // THE SKIP: a second goal, and a button held through its replay.
  resetBall();
  ball.x = bounds.right - 30; ball.y = midWater();
  p2.pos.set(bounds.left + 10, midWater() - 15, 0); p2.vel.set(0, 0);
  player.mesh.position.set(ball.x - ballReach() + 0.4, ball.y, 0);
  player.velocity.set(40, 0);
  strikeState.active = true; strikeState.power = 1; strikeState.dashDir.x = 1; strikeState.dashDir.y = 0;
  ball.dashHit[0] = false;
  frame();
  strikeState.active = false;
  frames = 0;
  while (versusState.phase === 'play' && frames < 400) { frame(); frames++; }
  for (let i = 0; i < 120 && versusState.phase !== 'replay'; i++) frame();
  check('a second goal replays too', versusState.phase === 'replay' && versusState.replays === 2, `phase ${versusState.phase}, ${versusState.replays} replays`);
  // A BUTTON ALREADY DOWN DOES NOT COUNT. The goal was scored by a button and
  // in a match it is usually still held when the replay opens, so the hold used
  // to be most of the way through its timer before a frame had been seen.
  // Nothing counts until everything has been off once.
  replayState.forceHold = true;
  replayState.skipArmed = false;
  replayState.skipT = 0;
  settle(R.skipSeconds * 2);
  check('a button held from the first frame never skips', versusState.phase === 'replay' && replayState.skipT === 0 && !replayState.skipArmed, `phase ${versusState.phase}, skipT ${replayState.skipT.toFixed(2)}`);
  replayState.forceHold = false;
  frame();
  check('...and letting go is what arms it', replayState.skipArmed);
  // A tap does nothing; a hold skips at skipSeconds.
  replayState.forceHold = true;
  frame();
  replayState.forceHold = false;
  settle(0.3);
  check('a tap does not skip', versusState.phase === 'replay' && replayState.skipT === 0, `phase ${versusState.phase}, skipT ${replayState.skipT.toFixed(2)}`);
  replayState.forceHold = true;
  let held = 0;
  for (let i = 0; i < 120 && versusState.phase === 'replay'; i++) { frame(); held += dt; }
  replayState.forceHold = false;
  check('holding any button skips it at skipSeconds', versusState.phase !== 'replay' && Math.abs(held - R.skipSeconds) < dt * 2, `skipped after ${held.toFixed(2)}s (skipSeconds ${R.skipSeconds})`);
  check('...back into the shutter, and on to a kickoff', versusState.phase === 'scored' && toPlay(), versusState.phase);
  // A pad's button counts as a hold too.
  check('a pad button held reads as a hold; a pad at rest does not', anyButtonHeld([pad(0, { strike: true })]) && !anyButtonHeld([pad(0)]));

  // Off: the jet fires at the goal, and no replay comes.
  R.enabled = false;
  const jets2 = goalJetState.fired;
  resetBall();
  ball.x = bounds.right - 20; ball.y = midWater();
  p2.pos.set(bounds.left + 10, midWater() - 15, 0); p2.vel.set(0, 0);
  player.mesh.position.set(ball.x - ballReach() + 0.4, ball.y, 0);
  player.velocity.set(40, 0);
  strikeState.active = true; strikeState.power = 1; strikeState.dashDir.x = 1; strikeState.dashDir.y = 0;
  ball.dashHit[0] = false;
  frame();
  strikeState.active = false;
  frames = 0;
  while (versusState.phase === 'play' && frames < 400) { frame(); frames++; }
  check('with the replay off, the jet fires at the goal and no replay comes', versusState.phase === 'scored' && !versusState.replayPending && goalJetState.fired === jets2 + 1, `phase ${versusState.phase}, pending ${versusState.replayPending}, jets +${goalJetState.fired - jets2}`);
  toPlay();
  versusState.scores[0] = 0; versusState.scores[1] = 0;
}

// ---------------------------------------------------------------------------
section('The count waits for the frame to come home from the goal');
{
  // The kickoff is called from a shot punched into a mouth at the far end of
  // the pitch. The countdown's clock does not start until the camera has
  // travelled back to the kickoff framing — and it starts anyway, at
  // settleMax, if that framing never arrives.
  const KOf = { w: 52 * 16 / 9, h: 52 };
  const world = {
    camera: { left: -KOf.w / 2, right: KOf.w / 2, top: 10.4, bottom: -41.6 },
    focusCamera() {},
  };
  toPlay();
  // A frame parked on the right-hand mouth, then a kickoff called under it.
  player.mesh.position.set(bounds.right - 6, midWater(), 0);
  p2.pos.set(bounds.right - 10, midWater(), 0);
  ball.x = bounds.right - 4; ball.y = midWater(); ball.vx = ball.vy = 0;
  for (let i = 0; i < 240; i++) updateVersusCamera(world, dt);
  enterKickoff();
  updateVersusCamera(world, dt);
  check('a kickoff called from the goal starts un-settled', !versusState.settled && !cameraRecentred(), `settled ${versusState.settled}`);
  frame();
  check('...and no numeral is up while the shot travels', versusState.count === -1 && versusState.phaseT === 0, `count ${versusState.count}, phaseT ${versusState.phaseT.toFixed(2)}`);
  let waited = 0;
  for (let i = 0; i < 240 && !versusState.settled; i++) { frame(); updateVersusCamera(world, dt); waited += dt; }
  check('the frame comes home, and only then does the count start', versusState.settled && cameraRecentred() && waited > dt * 2 && waited <= (KO.settleMax ?? 1.6) + dt * 2, `settled after ${waited.toFixed(2)}s (max ${KO.settleMax})`);
  check('...on the pitch\'s centre, not the goal it came from', Math.abs(versusCameraState().x) < 6, `x ${versusCameraState().x.toFixed(1)}`);
  const after = versusState.count;
  frame();
  check('the numerals then run as they always did', versusState.count === KO.count || after === KO.count, `count ${versusState.count}`);
  // ...and a frame that never arrives cannot hang the match. A tolerance of
  // zero is a shot that can never be called home — an exponential ease never
  // arrives — so settleMax is what has to start the count.
  const savedTol = KO.settleTol;
  KO.settleTol = 0;
  enterKickoff();
  let capped = 0;
  for (let i = 0; i < 400 && !versusState.settled; i++) { frame(); updateVersusCamera(world, dt); capped += dt; }
  check('a shot that never converges gives up at settleMax', versusState.settled && Math.abs(capped - (KO.settleMax ?? 1.6)) < dt * 3, `${capped.toFixed(2)}s (max ${KO.settleMax})`);
  KO.settleTol = savedTol;
  toPlay(20);
}

// ---------------------------------------------------------------------------
section('The ball goes through fish and bounces off boats');
{
  const H = V.ball.hit;
  toPlay();
  resetEnemies(scene);
  boats.length = 0;
  // A fish parked in the ball's lane, and the ball thrown through it.
  const kills = [];
  const savedKill = versusHooks.onKill;
  versusHooks.onKill = (e) => kills.push(e);
  resetBall();
  ball.x = -20; ball.y = midWater(); ball.vx = 50; ball.vy = 0;
  const f = spawnNamed(scene, 'fish', 0, { x: -10, y: midWater() }, { docile: true });
  check('a fish is in the water', !!f && enemies.includes(f), `${enemies.length} enemies`);
  const hp0 = f.hp;
  const before = ball.vx;
  for (let i = 0; i < 40 && enemies.includes(f) && f.hp === hp0; i++) frame();
  check('the ball hurts it', f.hp < hp0 || !enemies.includes(f), `hp ${hp0} → ${f.hp}`);
  for (let i = 0; i < 60 && enemies.includes(f); i++) frame();
  check('...and a fast ball kills it outright', !enemies.includes(f) && kills.includes(f), `${kills.length} kill(s) reported`);
  check('the kill goes through the run\'s own path, which is what drops the chum', kills.length === 1);
  check('the ball went THROUGH — it is still travelling the way it was', ball.vx > 0, `vx ${before} → ${ball.vx.toFixed(1)}`);

  // AND IT TEARS THROUGH A SCHOOL WITHOUT SLOWING. Against a CONTROL RUN down
  // an empty lane over the same frames, because the ball is under the water's
  // own drag the whole way and a bare "it is still fast" would pass while the
  // fish quietly took a third of it. A `hit.drag` here once spent a SHARE of
  // the ball's speed per body while carrying the 0.994 of a per-frame
  // multiplier, so one minnow left the ball with 0.6% of its shot: it did not
  // arrive slower, it stopped dead in the water.
  const lane = (fish) => {
    resetEnemies(scene);
    resetBall();
    ball.x = -40; ball.y = midWater(); ball.vx = 60; ball.vy = 0;
    const school = [];
    for (let i = 0; i < fish; i++) {
      school.push(spawnNamed(scene, 'fish', 0, { x: -24 + i * 5, y: midWater() }, { docile: true }));
    }
    kills.length = 0;
    for (let i = 0; i < 90; i++) { ball.vy = 0; ball.y = midWater(); frame(); }
    return { speed: ball.vx, dead: school.filter((e) => !enemies.includes(e)).length, fed: kills.length };
  };
  const clear = lane(0);
  const school = lane(8);
  check('a shot through a school kills every fish in the lane', school.dead === 8, `${school.dead} of 8`);
  check('...and every one of them goes through the chum path', school.fed === school.dead, `${school.fed} kill(s) reported for ${school.dead} dead`);
  check('...and the ball arrives no slower than it would down an empty lane',
    school.speed > clear.speed * 0.98,
    `${school.speed.toFixed(1)} through eight fish vs ${clear.speed.toFixed(1)} down a clear lane`);
  resetEnemies(scene);
  versusHooks.onKill = savedKill;

  // A hull in the lane: the ball bounces off it and hurts it.
  resetEnemies(scene);
  resetBall();
  const hull = {
    mesh: new THREE.Object3D(), hp: 1000, halfLength: 4, halfHeight: 1.2,
    offsetX: 0, offsetY: 0, isTrawler: false, assetKey: 'boat', scars: [],
    dir: 1, speed: 0, flash: 0,
    body: { applyImpulse() { hull.jostled += 1; } },
    jostled: 0,
  };
  hull.mesh.position.set(6, midWater(), 0);
  boats.push(hull);
  ball.x = -6; ball.y = midWater(); ball.vx = 50; ball.vy = 0;
  const hullHp = hull.hp;
  for (let i = 0; i < 60 && ball.vx > 0; i++) frame();
  check('a hull takes the hit', hull.hp < hullHp, `hp ${hullHp} → ${hull.hp.toFixed(0)}`);
  check('...and is shoved by it, at the point it was struck', hull.jostled > 0, `${hull.jostled} impulse(s)`);
  check('the ball comes OFF a hull rather than through it', ball.vx < 0, `vx ${ball.vx.toFixed(1)}`);
  check('...at the restitution the hit asks for, not the full speed back', Math.abs(ball.vx) < 50, `vx ${ball.vx.toFixed(1)} vs 50 in`);
  // One hit per body per `gap`: the same hull cannot be charged twice in the
  // frames the ball is still inside it.
  const hits0 = hull.jostled;
  ball.x = hull.mesh.position.x; ball.y = midWater(); ball.vx = 50;
  frame(); frame(); frame();
  check('a body is hit once per gap, not once per frame', hull.jostled <= hits0 + 1, `${hull.jostled - hits0} extra`);
  boats.length = 0;
  // Off, the ball passes through everything, as it used to.
  H.enabled = false;
  resetBall();
  resetEnemies(scene);
  const g2 = spawnNamed(scene, 'fish', 0, { x: 4, y: midWater() }, { docile: true });
  ball.x = -6; ball.y = midWater(); ball.vx = 50;
  const gh = g2.hp;
  for (let i = 0; i < 30; i++) frame();
  check('with the hit off the ball passes straight through', enemies.includes(g2) && g2.hp === gh, `hp ${g2.hp} of ${gh}`);
  H.enabled = true;
  resetEnemies(scene);
  resetBall();
  toPlay(20);
}

// ---------------------------------------------------------------------------
section('The bot never puts the ball in the goal it defends');
{
  // Player 2 defends the RIGHT. The veto is on the INPUT, after whichever
  // brain filled it, so it holds for the script and the policy alike — and
  // the test drives updateBot rather than either of them for that reason.
  const B = V.bot;
  const gy = midWater();
  const out = { move: new THREE.Vector2(), aim: new THREE.Vector2(), strikeHeld: false, strikeRelease: false, strike: false, aimLive: true, aimMoved: true, connected: false };
  const me = { pos: new THREE.Vector3(), vel: new THREE.Vector2(), charge: 1, pending: 1, active: false };
  const opp = { x: 0, y: gy, vx: 0, vy: 0 };
  const shot = (dx, dy) => intoOwnGoal({ x: 0, y: gy, r: ball.r }, dx, dy);
  check('a ball driven at the right mouth is read as an own goal', shot(1, 0));
  check('...and one driven at the mouth it attacks is not', !shot(-1, 0));
  check('...nor one driven across the pitch, wide of its own band', !shot(0.2, 1) && !shot(0, 1));
  check('...nor one leaning at its own wall by a degree or two', !shot(0.05, 1));

  // THE SETUP THAT USED TO SCORE: the bot on the attacking side of the ball,
  // both of them lined up on the right mouth — so the seal's line THROUGH the
  // ball is a shot at its own net. Run under BOTH brains: the script's own
  // alignment test reads the frame it decides on and releases tenths of a
  // second later, and the shipped policy has no notion of a goal at all.
  const savedMode = B.brain;
  const run = (frames, dropIn) => {
    resetBot();
    resetBall();
    ball.x = 10; ball.y = gy; ball.vx = ball.vy = 0;
    me.pos.copy(dropIn);
    me.charge = 1; me.pending = 1; me.active = false;
    let launched = 0; let vetoed = 0; let towardOwn = 0;
    for (let i = 0; i < frames; i++) {
      updateBot(dt, me, ball, opp, out);
      if (out.strikeRelease) launched++;
      if (botState.veto) vetoed++;
      // The stick must never point down the line at its own goal either — a
      // seal out-swimming a slow ball pushes it (the contest in versus.js),
      // so leaning on it is the same mistake more slowly.
      const bx = ball.x - me.pos.x;
      const by = ball.y - me.pos.y;
      const bl = Math.hypot(bx, by) || 1;
      if (out.move.x * (bx / bl) + out.move.y * (by / bl) > 0.9) towardOwn++;
      me.pending = 1; me.charge = 1;   // the meter is the body's job, not the bot's
    }
    return { launched, vetoed, towardOwn };
  };
  // Inside strikeRange of the ball, so the script's own decision is live and
  // the veto is what the test is measuring rather than the bot being too far
  // away to have decided anything.
  const onOwn = new THREE.Vector3(10 - (B.strikeRange ?? 7) + 2, gy, 0);
  for (const mode of ['scripted', 'policy']) {
    B.brain = mode;
    const r = run(240, onOwn);
    check(`${mode}: lined up on its own mouth, it never releases a strike`, r.launched === 0, `${r.launched} release(s) in 240 frames`);
    check(`${mode}: ...and the stick goes ACROSS the line, not down it`, r.towardOwn === 0, `${r.towardOwn} frame(s) pushing at its own goal`);
    check(`${mode}: ...the veto is what stopped it`, r.vetoed > 200, `${r.vetoed} vetoed frame(s)`);
  }

  // THE ONE THAT WAS ACTUALLY SCORING, and no static frame shows it: a loose
  // ball in the bot's own half, the bot somewhere around it, played out. A
  // seal out-swimming a slow ball holds its ground and pushes it (the contest
  // above), so a bot on the attacking side of it at contact range DRIBBLES it
  // home a few units a second for seconds at a time — no strike, no ray at
  // its own mouth, nothing a test of the shot could see. Seeded, and run
  // under both brains, because the offence is the CONTACT and not the
  // decision that led to it.
  const looseBalls = (trials) => {
    let rng = 12345;
    const rnd = () => (rng = (rng * 1664525 + 1013904223) >>> 0) / 4294967296;
    const gyy = mouthY();
    let own = 0; let cleared = 0;
    for (let k = 0; k < trials; k++) {
      versusState.lastGoal = null;
      versusState.phase = 'play';
      resetBot();
      resetBall();
      ball.live = true;
      // In front of the mouth it defends, with the bot already on the WRONG
      // side of it — the attacking side, at contact range. That is the
      // dribble as it happens in a match; scattering the bot at random round
      // the ball reproduces it about once in seventy, which is a test that
      // passes by luck more often than by correctness.
      ball.x = bounds.right - 12 - rnd() * 10;
      ball.y = gyy + (rnd() * 2 - 1) * mouthHalfHeight() * 0.6;
      ball.vx = 2 + rnd() * 4; ball.vy = (rnd() * 2 - 1) * 3; ball.spin = 0;
      p2.pos.set(ball.x - ballContactReach(Math.PI) * 0.9, ball.y + (rnd() * 2 - 1) * 1.5, 0);
      p2.vel.set(0, 0);
      p2.strike.charge = 1; p2.strike.pending = 0; p2.strike.active = false;
      player.mesh.position.set(bounds.left + 10, gyy, 0);
      player.velocity.set(0, 0);
      for (let i = 0; i < 60 * 5; i++) {
        frame();
        if (!ball.live || versusState.phase !== 'play') break;
        if (ball.x < 0) break;   // cleared into the half it is attacking
      }
      if (versusState.lastGoal?.side === 'right') own++;
      else if (ball.x < 0) cleared++;
    }
    versusState.lastGoal = null;
    versusState.phase = 'play';
    return { own, cleared };
  };
  const TRIALS = 40;
  for (const mode of ['scripted', 'policy']) {
    B.brain = mode;
    const r = looseBalls(TRIALS);
    check(`${mode}: a loose ball in its own half never ends in its own net`, r.own === 0, `${r.own} own goal(s) of ${TRIALS}, ${r.cleared} cleared upfield`);
  }
  // ...and the control, at the INPUT rather than at the outcome. A goal is an
  // emergent thing — the dribble scores about once in seventy loose balls, so
  // "the ball went in with the veto off" is a coin the test would flip rather
  // than a fact it would establish. What IS deterministic is the offence
  // itself: with the guard off, the bot in that geometry leans on the ball
  // frame after frame; with it on, never. That is the contract, and it is
  // what the two checks above rest on.
  const leaning = (on) => {
    const savedOn = B.ownGoalVeto;
    B.ownGoalVeto = on;
    resetBot();
    resetBall();
    const gyy = mouthY();
    ball.x = bounds.right - 16; ball.y = gyy; ball.vx = 3; ball.vy = 0;
    me.pos.set(ball.x - ballContactReach(Math.PI) * 0.9, gyy, 0);
    me.charge = 1; me.pending = 0; me.active = false;
    let pushed = 0;
    for (let i = 0; i < 120; i++) {
      updateBot(dt, me, ball, opp, out);
      const bx = ball.x - me.pos.x;
      const by = ball.y - me.pos.y;
      const bl = Math.hypot(bx, by) || 1;
      if (out.move.x * (bx / bl) + out.move.y * (by / bl) > 0.3) pushed++;
      me.charge = 1;
    }
    B.ownGoalVeto = savedOn;
    return pushed;
  };
  B.brain = 'policy';
  const guarded = leaning(true);
  const unguarded = leaning(false);
  check('at contact range on the wrong side, the guard stops it leaning on the ball', guarded === 0, `${guarded} pushing frame(s) of 120`);
  check('...and with the guard off it leans, which is what walked it in', unguarded > 0, `${unguarded} pushing frame(s) of 120 unguarded`);

  // And the mirror: behind the ball the same line is a shot at the goal it
  // ATTACKS, and the veto must not touch it. The script, because this is the
  // script's decision — the policy's is its own business.
  B.brain = 'scripted';
  const behind = run(240, new THREE.Vector3(10 + (B.strikeRange ?? 7) - 2, gy, 0));
  check('behind the ball, with the shot on, it still strikes', behind.launched > 0 && behind.vetoed === 0, `${behind.launched} release(s), ${behind.vetoed} veto(es)`);
  B.brain = savedMode;
  resetBot();
  resetBall();
}

// ---------------------------------------------------------------------------
section('The shore is carved to the same mouth the ball scores through');
{
  // Every triangle of the built stack, against the band: with the flag on
  // there is no rock in goalY ± halfHeight anywhere across the stack's depth,
  // and the shore's cover is still measured off the rock either side of it
  // rather than reading the hole as a gap. Off, the band is rock like any
  // other height.
  const rocks = createWallRocks(scene);
  const gy = midWater();
  const h = mouthHalfHeight();
  // The corridor: from the drawn face to the tunnel's back. NOTHING stands in
  // the band at any depth — the corridor is open all the way through, and what
  // closes its far end is the light plane, not rock. `deep` counts rock in the
  // corridor's x-range above and below the band (the tunnel's roof and floor)
  // and `back` rock in the band beyond it, which must now be none.
  const scan = (mesh) => {
    const pos = mesh.geometry.attributes.position;
    const face = shore.built ? bounds.right + shore.face : bounds.right;
    const backAt = face + tunnelDepth();
    let inBand = 0; let lipTop = Infinity; let lipBottom = -Infinity; let total = 0;
    let deepTop = 0; let deepBottom = 0; let back = 0; let corridorLipTop = Infinity; let corridorLipBottom = -Infinity;
    for (let t = 0; t + 2 < pos.count; t += 3) {
      let lo = Infinity; let hi = -Infinity; let ax = 0;
      for (let k = 0; k < 3; k++) {
        const y = pos.getY(t + k); const x = pos.getX(t + k);
        lo = Math.min(lo, y); hi = Math.max(hi, y);
        ax += Math.abs(x) / 3;
      }
      total++;
      const inBandY = hi > gy - h + 1e-6 && lo < gy + h - 1e-6;
      const inCorridor = ax > face - 1e-6 && ax < backAt - 1e-6;
      if (inBandY && ax < backAt - 1e-6) inBand++;
      if (inBandY && ax >= backAt - 1e-6) back++;
      if (lo >= gy + h - 1e-6) { lipTop = Math.min(lipTop, lo); if (inCorridor && ax > face + 2) { deepTop++; corridorLipTop = Math.min(corridorLipTop, lo); } }
      if (hi <= gy - h + 1e-6) { lipBottom = Math.max(lipBottom, hi); if (inCorridor && ax > face + 2) { deepBottom++; corridorLipBottom = Math.max(corridorLipBottom, hi); } }
    }
    return { inBand, total, lipTop, lipBottom, deepTop, deepBottom, back, corridorLipTop, corridorLipBottom };
  };
  rocks.build();
  check('the stack is built', !!rocks.mesh && shore.built, `${rocks.mesh?.geometry.attributes.position.count ?? 0} verts`);
  const on = scan(rocks.mesh);
  check('with the flag on, no rock stands in the mouth\'s band anywhere in the corridor', on.inBand === 0, `${on.inBand} of ${on.total} triangles in goalY ± ${h} short of the back`);
  // THE TUNNEL IS BUILT: a roof and a floor of rock along the corridor, on
  // the lips — and NOTHING across the band at its end, so a camera reaching
  // into the goal looks down an open corridor at the light.
  check('the tunnel has a roof and a floor of rock past the face', on.deepTop > 20 && on.deepBottom > 20, `${on.deepTop} triangles above, ${on.deepBottom} below, in the corridor`);
  check('...that meet the lips along the corridor', on.corridorLipTop - (gy + h) < 0.05 && (gy - h) - on.corridorLipBottom < 0.05, `top ${on.corridorLipTop.toFixed(2)} vs ${(gy + h).toFixed(2)}, bottom ${on.corridorLipBottom.toFixed(2)} vs ${(gy - h).toFixed(2)}`);
  check('...and no rock capping the corridor at the tunnel\'s end', on.back === 0, `${on.back} triangles in the band past ${tunnelDepth()} deep`);
  check('the camera\'s reach into the goal is past the line and inside the tunnel', cameraReach() > shore.face + goalLineDepth() && cameraReach() < shore.face + tunnelDepth(), `reach ${cameraReach().toFixed(1)} past the wall, line ${(shore.face + goalLineDepth()).toFixed(1)}, back ${(shore.face + tunnelDepth()).toFixed(1)}`);
  check('...and rock meets the lips on both sides', on.lipTop - (gy + h) < 0.05 && (gy - h) - on.lipBottom < 0.05, `top lip ${on.lipTop.toFixed(2)} vs ${(gy + h).toFixed(2)}, bottom ${on.lipBottom.toFixed(2)} vs ${(gy - h).toFixed(2)}`);
  check('the cover is measured off the rock beside the hole, not the hole', shore.cover > 0.5, `cover ${shore.cover.toFixed(2)}`);
  check('the screen\'s edge is then past the wall', screenEdgeX(-1) < bounds.left, `edge ${screenEdgeX(-1).toFixed(2)} vs wall ${bounds.left.toFixed(2)}`);
  // Two things stand in each mouth now: the additive LIGHT quad, and behind it
  // the slab that stops the open corridor being a window onto the backdrop.
  // Both are shader quads on the SAME rectangle, and each says which it is.
  const drawn = rocks.mesh.parent.children.filter((c) => c !== rocks.mesh);
  const holes = drawn.filter((c) => c.userData.goalPart === 'light');
  const backs = drawn.filter((c) => c.userData.goalPart === 'back');
  const spill = V.goal.spill;
  // THE OUTWARD REACH IS ITS OWN NUMBER. The fade past the lips is into rock
  // the boulders are drawing over; the throw into the water has the whole
  // pitch, and one number for both capped the second at the first.
  const out = V.goal.spillOut ?? spill;
  const reach = V.camera.reach;
  // THE LIGHT RUNS OFF THE FRAME. Its rectangle starts `spillOut` in front of
  // the drawn face and ends a whole camera reach past the TUNNEL'S BACK —
  // further out than any frame edge can be (screenEdgeX), so a camera pushed
  // into the goal never sees the light stop. The alpha is zero at all four
  // rims (GOAL_FALLOFF_GLSL), so there is no edge to see there either.
  const spanOf = (p) => {
    const side = p.position.x < 0 ? -1 : 1;
    const half = p.geometry.parameters.width / 2;
    return { side, near: p.position.x - side * half, far: p.position.x + side * half };
  };
  const spans = (p) => {
    const { side, near, far } = spanOf(p);
    return Math.abs(near - (rockX(side) - side * out)) < 1e-6
      && Math.abs(far - (rockX(side) + side * (tunnelDepth() + reach + spill))) < 1e-6
      && Math.abs(p.position.y - gy) < 1e-6
      && Math.abs(p.geometry.parameters.height - (h * 2 + spill * 2)) < 1e-6;
  };
  check('each open corridor is backed by a slab of the team\'s colour', backs.length === 2 && backs.every((p) => !p.material.depthWrite && p.material.transparent && spans(p)), `${backs.length} slab(s)`);
  // ...and it is NOT opaque any more. It used to stop dead at the drawn face,
  // and that hard vertical edge was visible in the water from inside the goal.
  // It carries the light's own falloff instead, so the two fade out together.
  check('...on the light\'s own rectangle and falloff, so the pair cannot show a seam', backs.every((p) => /goalFalloff/.test(p.material.fragmentShader) && p.material.uniforms.uSpill.value === spill), backs.map((p) => `spill ${p.material.uniforms?.uSpill?.value}`).join('; '));
  check('each mouth is lit by a quad the hole\'s size plus the spill', holes.length === 2 && holes.every(spans), `${holes.length} quad(s)`);
  // AND THE SLAB IS NOT CARRIED OUT WITH THE LIGHT. It is the team's colour at
  // backShade and its whole job is to stop the open corridor being a window
  // onto the seabed; thrown as far into the water as the light, it is a dark
  // wash standing in the open in front of every goal. Same quad — the light's
  // — so it has slack out there it never paints.
  check('...while the slab behind it keeps the short reach',
    backs.every((p) => p.material.uniforms.uOut.value === spill)
    && holes.every((p) => p.material.uniforms.uOut.value === out),
    `slab ${backs.map((p) => p.material.uniforms.uOut.value).join('/')} vs light ${holes.map((p) => p.material.uniforms.uOut.value).join('/')}`);
  check('...ending further out than the frame\'s edge can reach', holes.every((p) => {
    const { side, far } = spanOf(p);
    return (far - screenEdgeX(side)) * side > 0;
  }), holes.map((p) => { const { side, far } = spanOf(p); return `far ${far.toFixed(1)} vs screen edge ${screenEdgeX(side).toFixed(1)}`; }).join('; '));
  // The falloff is measured off the MOUTH, never off the quad — which is the
  // whole reason the quad can be lengthened without changing how it looks.
  check('...and the falloff is anchored on the face, the lips and that far end', holes.every((p) => {
    const { side, far } = spanOf(p);
    const u = p.material.uniforms;
    return u.uSide.value === side && Math.abs(u.uFaceX.value - rockX(side)) < 1e-6
      && Math.abs(u.uEndX.value - far) < 1e-6 && Math.abs(u.uMidY.value - gy) < 1e-6
      && Math.abs(u.uHalfH.value - h) < 1e-6;
  }), holes.map((p) => `face ${p.material.uniforms.uFaceX.value.toFixed(1)}, end ${p.material.uniforms.uEndX.value.toFixed(1)}, half ${p.material.uniforms.uHalfH.value}`).join('; '));
  // ...a LIGHT, not a slab: additive, soft-edged, in its team's colour (the
  // left hole is team 0's), overdriven past 1 so the bloom takes it, and
  // untonemapped so the overdrive survives.
  const teamOf = (p) => new THREE.Color(V.teams[p.position.x < 0 ? 0 : 1].color);
  const litRight = holes.every((p) => {
    const want = teamOf(p);
    const c = p.material.uniforms?.uColor?.value;
    return c && Math.abs(c.r - want.r) < 1e-6 && Math.abs(c.g - want.g) < 1e-6 && Math.abs(c.b - want.b) < 1e-6
      && p.material.uniforms.uGlow.value === V.goal.glow && V.goal.glow > 1;
  });
  check('...in its own team\'s colour, overdriven by goal.glow', litRight, holes.map((p) => `x ${p.position.x.toFixed(0)}: ${p.material.uniforms?.uColor?.value?.getHexString()} x${p.material.uniforms?.uGlow?.value}`).join('; '));
  check('...additive, transparent, untonemapped, and feathered to nothing at its rim', holes.every((p) => p.material.blending === THREE.AdditiveBlending && p.material.transparent && p.material.toneMapped === false && p.material.depthWrite === false && p.material.uniforms.uFeather.value > 0 && /smoothstep/.test(p.material.fragmentShader)));
  // The drawn face sits past the wall's line (the seal's nose, see wallRocks),
  // and that is where the ball's posts are and where the dark begins.
  check('the shore publishes how far past the wall its face sits', shore.face > 1 && Math.abs(rockX(-1) - (bounds.left - shore.face)) < 1e-9, `face ${shore.face.toFixed(2)} past the wall`);
  // THE KEEPER'S DEPTH IS IN THE WALL'S FRAME, and with a shore built that is
  // where it differs: the drawn face sits shore.face past the wall, so the
  // line a keeper defends is that much further out than goalLineDepth alone.
  // Clamped against goalLineDepth — which is measured past the FACE — the
  // keeper was held a whole rock face short of its own line.
  check('a keeper\'s reach counts the rock face, not just the line past it',
    Math.abs(keeperLineDepth() - (shore.face + goalLineDepth() - 0.5)) < 1e-9 && keeperLineDepth() > goalLineDepth(),
    `${keeperLineDepth().toFixed(2)} past the wall vs the ${(goalLineDepth() - 0.5).toFixed(2)} the old clamp gave, with a ${shore.face.toFixed(2)} face`);
  const leftPlane = holes.find((p) => p.position.x < 0);
  // The light's INNER end is measured off the drawn face, not the wall's line:
  // the spill into the water starts where the rock the player sees starts.
  const nearX = leftPlane ? leftPlane.position.x + leftPlane.geometry.parameters.width / 2 : NaN;
  check('...and the light\'s spill starts at the face, not the wall\'s line', Math.abs(nearX - (rockX(-1) + out)) < 1e-6, `near end ${nearX.toFixed(2)} vs rock ${rockX(-1).toFixed(2)} + spillOut ${out}`);
  check('the ball\'s posts are on the rock: a ball into the corner stops short of the wall\'s line', (() => {
    resetBall(); versusState.phase = 'play';
    ball.x = bounds.left + 10; ball.y = gy + h - ball.r * 0.4; ball.vx = -40; ball.vy = 0;
    versusState.lastPost = null;
    for (let i = 0; i < 30 && !versusState.lastPost; i++) frame();
    const R = ballRestRadius();
    return !!versusState.lastPost && versusState.lastPost.x + R > rockX(-1) - 1e-6 && versusState.lastPost.x - R < bounds.left;
  })(), versusState.lastPost ? `hit at x=${versusState.lastPost.x.toFixed(2)}, rock ${rockX(-1).toFixed(2)}, wall ${bounds.left.toFixed(2)}` : 'no post hit');
  resetBall();
  // The F panel moves the light in place.
  const savedGlow = V.goal.glow; const savedSpill = V.goal.spill; const savedOut = V.goal.spillOut;
  V.goal.glow = savedGlow + 1; V.goal.spill = savedSpill + 2; V.goal.spillOut = (savedOut ?? savedSpill) + 3;
  const moved = refreshGoalGlow();
  check('the panel can move the light without a rebuild', moved === 2 && holes.every((p) => p.material.uniforms.uGlow.value === savedGlow + 1 && p.material.uniforms.uSpill.value === savedSpill + 2 && p.material.uniforms.uOut.value === (savedOut ?? savedSpill) + 3 && Math.abs(p.geometry.parameters.width - (tunnelDepth() + reach + (savedSpill + 2) + (savedOut ?? savedSpill) + 3)) < 1e-6), `${moved} quad(s) refreshed`);
  // ...and the slab behind it follows, or the two would end in different
  // places and the step between them would be a seam in the water.
  check('...and the slab behind it moves with it', backs.every((p) => Math.abs(p.geometry.parameters.width - (tunnelDepth() + reach + (savedSpill + 2) + (savedOut ?? savedSpill) + 3)) < 1e-6 && p.material.uniforms.uSpill.value === savedSpill + 2), backs.map((p) => `${p.geometry.parameters.width.toFixed(1)} wide`).join('; '));
  V.goal.glow = savedGlow; V.goal.spill = savedSpill; V.goal.spillOut = savedOut; refreshGoalGlow();

  // THE SCORED MOUTH CHANGES HANDS. A goal goes into the light of the team
  // that conceded it; for the length of the envelope that light is the
  // SCORER'S colour and blazes, then it is handed back. On the wall clock.
  const lightOn = (side) => holes.find((p) => (p.position.x < 0 ? -1 : 1) === side);
  const colourOf = (p) => p.material.uniforms.uColor.value.getHexString();
  const ownHex = (side) => new THREE.Color(V.teams[side < 0 ? 0 : 1].color).getHexString();
  // A uniform's rgb as a hex string — the shooter's colour and an attacker's
  // both arrive as vec4s and both get read against a team's own colour.
  const hexOf = (v) => new THREE.Color(v.x, v.y, v.z).getHexString();
  // A swimmer's colour-and-weight, and how hard it is contesting a shot.
  const uTint = (i, side = -1) => lightOn(side).material.uniforms.uSwimTint.value[i];
  const scorerHex = new THREE.Color(V.teams[1].color).getHexString();
  const restGlow = lightOn(-1).material.uniforms.uGlow.value;
  flashGoalScored(-1, 1);
  tickGoalGlow(V.goal.scored.rise + 1e-3);
  check('a goal turns the mouth it went into the scorer\'s colour',
    colourOf(lightOn(-1)) === scorerHex && ownHex(-1) !== scorerHex,
    `left mouth ${colourOf(lightOn(-1))}, its own ${ownHex(-1)}, the scorer's ${scorerHex}`);
  check('...and blazes past its resting overdrive',
    lightOn(-1).material.uniforms.uGlow.value > restGlow * 1.2,
    `glow ${lightOn(-1).material.uniforms.uGlow.value.toFixed(2)} vs ${restGlow.toFixed(2)}`);
  check('...while the other mouth is untouched', colourOf(lightOn(1)) === ownHex(1) && lightOn(1).material.uniforms.uGlow.value === restGlow);
  // The slab behind it goes with it, or the corridor's far end would be the
  // conceding team's colour with the scorer's light blazing in front of it.
  check('...and the slab behind it takes the colour too',
    backs.find((p) => p.position.x < 0).material.uniforms.uColor.value.getHexString() !== backs.find((p) => p.position.x > 0).material.uniforms.uColor.value.getHexString());
  const held = colourOf(lightOn(-1));
  tickGoalGlow(V.goal.scored.hold * 0.5);
  check('...held for the hold', colourOf(lightOn(-1)) === held);
  tickGoalGlow(V.goal.scored.hold + V.goal.scored.fall + 0.1);
  check('...then handed back to the goal\'s own team',
    colourOf(lightOn(-1)) === ownHex(-1) && Math.abs(lightOn(-1).material.uniforms.uGlow.value - restGlow) < 1e-6 && goalGlowState.scored.team < 0,
    `back to ${colourOf(lightOn(-1))} at ${lightOn(-1).material.uniforms.uGlow.value.toFixed(2)}`);
  // A SLIDER MOVED MID-FLASH must not hand the mouth back early: the colour
  // lives in one painter that both the refresh and the tick call.
  flashGoalScored(-1, 1);
  tickGoalGlow(V.goal.scored.rise + 1e-3);
  refreshGoalGlow();
  check('...and the F panel cannot take the flash off mid-goal', colourOf(lightOn(-1)) === scorerHex, colourOf(lightOn(-1)));
  clearGoalScored();
  check('...cleared, every mouth is its own team\'s again', colourOf(lightOn(-1)) === ownHex(-1) && colourOf(lightOn(1)) === ownHex(1));

  // THE SEALS STIR THE FIELD. Where they are and how fast, onto every light.
  const swim = V.goal.swim;
  const uSwim = (i) => lightOn(-1).material.uniforms.uSwim.value[i];
  resetGoalStir();
  player.mesh.position.set(rockX(-1) + 4, gy, 0); player.velocity.set(0, 0);
  p2.pos.set(bounds.right - 20, gy, 0); p2.velocity.set(0, 0);
  versusState.dead[0] = false; versusState.dead[1] = false;
  stirGoalLights(dt); tickGoalGlow(dt);
  check('both seals are written into the light\'s field',
    Math.abs(uSwim(0).x - player.mesh.position.x) < 1e-6 && Math.abs(uSwim(1).x - p2.pos.x) < 1e-6
      && uSwim(0).z === swim.reach && uSwim(1).z === swim.reach,
    `p1 at ${uSwim(0).x.toFixed(1)} reach ${uSwim(0).z}, p2 at ${uSwim(1).x.toFixed(1)} reach ${uSwim(1).z}`);
  check('...the shader knows how fast, not just where', uSwim(0).w === 0, `still seal stirs ${uSwim(0).w}`);
  player.velocity.set(-swim.burst, 0);
  stirGoalLights(dt); tickGoalGlow(dt);
  check('...and a moving one boils the field under it', uSwim(0).w > 0.9 && lightOn(-1).material.uniforms.uSwimVel.value[0].x < 0, `stir ${uSwim(0).w.toFixed(2)}`);
  // A DEAD SEAL IS NOT IN THE WATER — its slot parks rather than leaving a
  // permanent dent where it was last seen.
  versusState.dead[0] = true;
  stirGoalLights(dt); tickGoalGlow(dt);
  check('...a dead seal stops stirring it', uSwim(0).z === 0, `reach ${uSwim(0).z}`);
  versusState.dead[0] = false;

  // THE BALL IN THE LIGHT. Not a swimmer: it brings no colour and curls
  // nothing — it overdrives and boils where it overlaps, and how much it
  // overlaps is measured off its NEAR edge so the goal is already lighting up
  // as the ball crosses the face rather than once its centre has.
  const uBall = (side = -1) => lightOn(side).material.uniforms.uBall.value;
  const savedBallX = ball.x; const savedBallY = ball.y;
  ball.x = 0; ball.y = gy;
  stirGoalLights(dt); tickGoalGlow(dt);
  check('a ball out in the water leaves the lights alone', uBall(-1).w === 0 && uBall(-1).z === 0, `amount ${uBall(-1).w}`);
  ball.x = rockX(-1) - 3; ball.y = gy;
  stirGoalLights(dt); tickGoalGlow(dt);
  check('a ball through the mouth overdrives the light it is in',
    uBall(-1).w > 0.95 && uBall(-1).z === V.goal.ball.reach && Math.abs(uBall(-1).x - ball.x) < 1e-6,
    `amount ${uBall(-1).w.toFixed(2)}, reach ${uBall(-1).z} at x ${uBall(-1).x.toFixed(1)}`);
  // ...and it comes on across the spill in front of the face, not all at once.
  // Placed by the ball's NEAR EDGE, because that is what the measurement
  // reads — its centre is most of a ball further out than that.
  const ballR = ballHitRadius();
  const edgeAt = (out) => { ball.x = rockX(-1) + out + ballR; stirGoalLights(dt); tickGoalGlow(dt); return uBall(-1).w; };
  const arriving = edgeAt(V.goal.spill * 0.6);
  check('...coming on as it arrives, over the light\'s own spill', arriving > 0 && arriving < 1, `amount ${arriving.toFixed(2)} with its near edge ${(V.goal.spill * 0.6).toFixed(1)} short of the face`);
  check('...further in is further on', edgeAt(V.goal.spill * 0.2) > arriving + 0.2, `${edgeAt(V.goal.spill * 0.2).toFixed(2)} at 0.2 spill vs ${arriving.toFixed(2)} at 0.6`);
  // THE BALL'S RADIUS IS IN IT: the same centre counts for more than a point
  // would, because what should light the goal up is the ball ARRIVING.
  ball.x = rockX(-1) + V.goal.spill * 0.6 + ballR;
  stirGoalLights(dt); tickGoalGlow(dt);
  // The same centre as a POINT: its own x is that much out in the water, so
  // the light's spill has to reach the whole way to it.
  const asPoint = Math.max(0, Math.min(1, (V.goal.spill - (V.goal.spill * 0.6 + ballR)) / V.goal.spill));
  check('...measured off the ball\'s near edge, not its centre', uBall(-1).w > asPoint + 0.1 && ballR > 1,
    `amount ${uBall(-1).w.toFixed(2)} vs ${asPoint.toFixed(2)} for a point at the same place (ball radius ${ballR.toFixed(1)})`);
  // ...and a ball level with the rock above the lip is outside the band.
  ball.x = rockX(-1) - 3; ball.y = gy + h + V.goal.spill + 1;
  stirGoalLights(dt); tickGoalGlow(dt);
  check('...and nothing for a ball buried in the rock past the lip', uBall(-1).w === 0, `amount ${uBall(-1).w}`);

  // THE SHOOTER'S COLOUR COMES IN AHEAD OF THE SHOT — ramped on the distance
  // left to the GOAL LINE, not on where the ball is, so it reads as how close
  // this shot is to being a goal.
  const uBallTint = (side = -1) => lightOn(side).material.uniforms.uBallTint.value;
  const B = V.goal.ball;
  claimBall(1);
  const lineX = goalLineX(-1);
  const atLine = (short) => { ball.x = lineX + short + ballR; ball.y = gy; stirGoalLights(dt); tickGoalGlow(dt); return uBallTint(-1).w; };
  const far = atLine(B.tintLead + 10);
  check('a shot still miles out tints nothing', far === 0, `tint ${far}`);
  const coming = atLine(B.tintLead * 0.5);
  check('...it comes on as the shot nears the goal line', coming > 0 && coming < B.tint, `tint ${coming.toFixed(2)} half a lead short of the line`);
  const onLine = atLine(0);
  check('...and is full on the line', Math.abs(onLine - B.tint) < 1e-6, `tint ${onLine.toFixed(2)} of ceiling ${B.tint}`);
  check('...in the SHOOTER\'s colour, not the goal\'s',
    hexOf(uBallTint(-1)) === new THREE.Color(V.teams[1].color).getHexString() && ownHex(-1) !== new THREE.Color(V.teams[1].color).getHexString(),
    `${hexOf(uBallTint(-1))} vs this goal's own ${ownHex(-1)}`);
  // ONE MOUTH AT A TIME: the take-over widens to the whole light as the ball
  // closes, so a light at the far end of the pitch must be handed a parked
  // slot rather than left to a falloff that is no longer doing the work.
  check('...and only at the mouth the shot is coming into', uBallTint(1).w === 0 && lightOn(1).material.uniforms.uBall.value.z === 0,
    `far mouth tint ${uBallTint(1).w}, reach ${lightOn(1).material.uniforms.uBall.value.z}`);
  // A ball nobody has hit is nobody's colour — a kickoff must not tint.
  resetBallLook();
  stirGoalLights(dt); tickGoalGlow(dt);
  check('...and a ball nobody has hit yet tints nothing', uBallTint(-1).w === 0, `tint ${uBallTint(-1).w} with owner ${ballLookState().owner}`);
  claimBall(1);
  // ...and a shot flying at the rock above the lip is not arriving here.
  ball.x = lineX + B.tintLead * 0.2 + ballR; ball.y = gy + h + V.goal.spill + 1;
  stirGoalLights(dt); tickGoalGlow(dt);
  check('...nor one flying at the rock above the lip', uBallTint(-1).w === 0, `tint ${uBallTint(-1).w}`);


  // THE KEEPER PUSHES BACK. A shot into the left mouth paints it in team 1's
  // colour; seal 0, standing in that mouth, argues with it — its own colour
  // and its own churn go into the same sums, additively, so the mouth is
  // CONTESTED rather than handed over.
  const uDefend = (i, side = -1) => lightOn(side).material.uniforms.uSwimDefend.value[i];
  claimBall(1);
  ball.x = lineX + 2 + ballR; ball.y = gy;
  // The keeper out in open water first: nothing to defend from out there.
  player.mesh.position.set(bounds.left + 20, gy, 0); player.velocity.set(0, 0);
  stirGoalLights(dt); tickGoalGlow(dt);
  check('a keeper out in the water is not contesting anything', uDefend(0) === 0 && uTint(0, -1).w === 0, `defend ${uDefend(0)}, tint ${uTint(0, -1).w}`);
  // ...and now inside its own goal, with the shot on top of it.
  player.mesh.position.set(bounds.left - keeperLineDepth(), gy, 0);
  stirGoalLights(dt); tickGoalGlow(dt);
  check('a keeper in its own goal pushes back on the shot', uDefend(0) > 0.5, `defend ${uDefend(0).toFixed(2)} with the shot at ${uBallTint(-1).w.toFixed(2)}`);
  check('...in its OWN colour, against the shooter\'s', uTint(0, -1).w > 0 && hexOf(uTint(0, -1)) === ownHex(-1) && hexOf(uTint(0, -1)) !== hexOf(uBallTint(-1)),
    `keeper ${hexOf(uTint(0, -1))} at ${uTint(0, -1).w.toFixed(2)} vs shooter ${hexOf(uBallTint(-1))} at ${uBallTint(-1).w.toFixed(2)}`);
  // BOTH IN THE MIX. The shader takes a weighted mean of every colour in the
  // field, so a contested mouth is the two of them and not whichever was
  // written last — the check that matters is that neither weight is zero.
  check('...contested, not replaced: both colours are still in the field', uTint(0, -1).w > 0 && uBallTint(-1).w > 0);
  // ...and it argues harder the further in it is.
  player.mesh.position.set(bounds.left - keeperLineDepth() * 0.3, gy, 0);
  stirGoalLights(dt); tickGoalGlow(dt);
  const shallowDefend = uDefend(0);
  player.mesh.position.set(bounds.left - keeperLineDepth(), gy, 0);
  stirGoalLights(dt); tickGoalGlow(dt);
  check('...and harder the deeper into its own goal it stands', uDefend(0) > shallowDefend + 0.2, `${shallowDefend.toFixed(2)} a third of the way in vs ${uDefend(0).toFixed(2)} on the line`);
  // NO SHOT, NO CONTEST — or a seal parked in its own net would strobe.
  ball.x = 0; ball.y = gy;
  stirGoalLights(dt); tickGoalGlow(dt);
  check('...but with no shot coming it is just a seal in a goal', uDefend(0) === 0 && uTint(0, -1).w === 0, `defend ${uDefend(0)}, tint ${uTint(0, -1).w}`);

  ball.x = savedBallX; ball.y = savedBallY;
  player.mesh.position.set(rockX(-1) + 4, gy, 0);
  resetBallLook();
  stirGoalLights(dt); tickGoalGlow(dt);

  // THE THROW DOWN THE TUNNEL is the LIGHT'S and not the slab's: the slab is
  // the only thing stopping the open corridor being a window onto the seabed,
  // and an exponential on its alpha would open that window at the mouth.
  check('the light throws down the tunnel from a source behind the mouth',
    holes.every((p) => /goalThrow/.test(p.material.fragmentShader)
      && Math.abs(p.material.uniforms.uThrowFrom.value - (rockX(p.position.x < 0 ? -1 : 1) + (p.position.x < 0 ? -1 : 1) * tunnelDepth())) < 1e-6),
    holes.map((p) => `source at ${p.material.uniforms.uThrowFrom.value.toFixed(1)}`).join('; '));
  check('...and the slab behind it does not, so the corridor stays closed',
    backs.every((p) => !/goalThrow/.test(p.material.fragmentShader) && !p.material.uniforms.uThrow));
  // THE TRIM is the power the falloff is raised to (uTail), and it is the
  // light's alone for the same reason the throw is: the slab has to hold its
  // alpha flat across the corridor. The mapping is the thing worth pinning —
  // the panel moves a REACH and the shader wants an exponent, so the two are
  // one division apart and a division is easy to invert by accident.
  {
    const savedTrim = V.goal.trim;
    // 1 has to be 2 exactly: that is the hard-coded square this replaced, and a
    // default that is not a no-op silently retunes a light somebody has tuned.
    V.goal.trim = 1; refreshGoalGlow();
    check('trim 1 is the square the light always did', holes.every((p) => p.material.uniforms.uTail.value === 2),
      holes.map((p) => p.material.uniforms.uTail.value).join(', '));
    delete V.goal.trim; refreshGoalGlow();
    check('...and so is no trim at all', holes.every((p) => p.material.uniforms.uTail.value === 2));
    // Down is a BIGGER power and a shorter light. The slider reads as distance;
    // if this ever inverts, every value a person types does the opposite thing
    // and the light still renders perfectly.
    V.goal.trim = 0.5; refreshGoalGlow();
    check('...half the reach is twice the power', holes.every((p) => p.material.uniforms.uTail.value === 4),
      holes.map((p) => p.material.uniforms.uTail.value).join(', '));
    V.goal.trim = 2; refreshGoalGlow();
    check('...and 2 takes the square off entirely, which is the longest it goes',
      holes.every((p) => p.material.uniforms.uTail.value === 1));
    // A zero here is a pow of infinity and a light that renders as nothing at
    // all, which is a plausible thing to type into a panel asking for a reach.
    V.goal.trim = 0; refreshGoalGlow();
    check('...and 0 is clamped rather than dividing by it',
      holes.every((p) => Number.isFinite(p.material.uniforms.uTail.value) && p.material.uniforms.uTail.value > 0),
      holes.map((p) => p.material.uniforms.uTail.value).join(', '));
    check('the slab is not shaped this way at all', backs.every((p) => !p.material.uniforms.uTail));
    if (savedTrim == null) delete V.goal.trim; else V.goal.trim = savedTrim;
    refreshGoalGlow();
  }
  // The source is the tunnel's BACK, not the quad's far end — spend the decay
  // over the quad and most of it happens off the frame.
  check('...anchored on the corridor, not on the quad that runs past it',
    holes.every((p) => Math.abs(p.material.uniforms.uThrowFrom.value) < Math.abs(p.material.uniforms.uEndX.value)),
    holes.map((p) => `source ${p.material.uniforms.uThrowFrom.value.toFixed(1)} vs quad end ${p.material.uniforms.uEndX.value.toFixed(1)}`).join('; '));

  // THE COLOUR CHANGES HANDS as an attacker swims in. Seal 0 attacks the
  // RIGHT mouth; the light there is seal 1's team colour until seal 0 is in it.
  const deep = keeperLineDepth();
  player.velocity.set(0, 0); p2.velocity.set(0, 0);
  player.mesh.position.set(bounds.right + deep, gy, 0);
  p2.pos.set(0, gy, 0);
  stirGoalLights(dt); tickGoalGlow(dt);
  check('a seal deep in the goal it attacks brings its own colour in',
    uTint(0, 1).w > 0.8 * V.goal.swim.tint && hexOf(uTint(0, 1)) === new THREE.Color(V.teams[0].color).getHexString(),
    `tint ${uTint(0, 1).w.toFixed(2)} of ceiling ${V.goal.swim.tint}, colour ${hexOf(uTint(0, 1))}`);
  // ...and it comes on as it swims in, rather than the moment it is near.
  player.mesh.position.set(bounds.right - V.goal.swim.tintLead * 0.5, gy, 0);
  stirGoalLights(dt); tickGoalGlow(dt);
  const shallow = uTint(0, 1).w;
  check('...part way in, part way over', shallow > 0 && shallow < V.goal.swim.tint * 0.8, `tint ${shallow.toFixed(2)} short of the line`);
  // ITS OWN GOAL IS ALREADY ITS COLOUR — a keeper stirs the field without
  // repainting it, or standing in your own net would look like scoring.
  player.mesh.position.set(bounds.left - deep, gy, 0);
  stirGoalLights(dt); tickGoalGlow(dt);
  check('...but a keeper in its own goal changes no colour at all',
    uTint(0, -1).w === 0 && uSwim(0).z === V.goal.swim.reach,
    `tint ${uTint(0, -1).w}, still stirring at reach ${uSwim(0).z}`);
  // ...and out in open water there is nothing to take over.
  player.mesh.position.set(0, gy, 0);
  stirGoalLights(dt); tickGoalGlow(dt);
  check('...and none out in the water', uTint(0, 1).w === 0, `tint ${uTint(0, 1).w}`);
  player.velocity.set(0, 0);

  // THE BURST IS AN EDGE. A seal crossing the threshold near a mouth throws
  // ONE ring; held above it, it throws no more until the cooldown is up.
  resetGoalStir();
  const live = () => goalGlowState.pulses.filter((q) => q.strength > 0).length;
  // Below the threshold for long enough to clear both the edge and the
  // cooldown the checks above left running — a ring that does not fire
  // because the last one is still cooling is not the bug this is watching.
  player.velocity.set(0, 0);
  stirGoalLights(swim.cooldown + dt);
  const before = live();
  player.mesh.position.set(rockX(-1) + 6, gy, 0);
  player.velocity.set(-(swim.burst + 10), 0);
  const firstFire = stirGoalLights(dt);
  check('a seal bursting at the mouth throws a ring into the field', firstFire === 1 && live() === before + 1, `${firstFire} ring(s), ${live()} live`);
  const heldFires = stirGoalLights(dt) + stirGoalLights(dt) + stirGoalLights(dt);
  check('...once, on the crossing — not every frame it is held', heldFires === 0, `${heldFires} more while held`);
  // ...and out in midfield there is no light for a ring to break up.
  player.velocity.set(0, 0); stirGoalLights(dt);
  player.mesh.position.set(0, gy, 0);
  player.velocity.set(swim.burst + 10, 0);
  const midfield = stirGoalLights(swim.cooldown + dt);
  check('...and a burst out in midfield throws none', midfield === 0, `x ${player.mesh.position.x.toFixed(0)}, range ${swim.range} of the face`);
  // The ring reaches the shader with the clock it was born on, so the shader
  // can age it: a birth time in the future or long past is a dead ring.
  resetGoalStir();
  goalGlowImpulse(rockX(-1), gy, 1);
  tickGoalGlow(dt);
  const pulse = lightOn(-1).material.uniforms.uPulse.value[0];
  check('...and a ring reaches the light as a place, a birth time and a strength',
    Math.abs(pulse.x - rockX(-1)) < 1e-6 && pulse.w === 1 && Math.abs(pulse.z - (goalGlowState.clock - dt)) < 1e-3,
    `at ${pulse.x.toFixed(1)}, born ${pulse.z.toFixed(3)} of ${goalGlowState.clock.toFixed(3)}`);
  // Two lights, two arrays: one shared uniform array would make the pair one
  // light and the right mouth would answer for the left seal.
  check('...each mouth carries its own copy of the field\'s state',
    lightOn(-1).material.uniforms.uSwim.value !== lightOn(1).material.uniforms.uSwim.value
      && lightOn(-1).material.uniforms.uPulse.value !== lightOn(1).material.uniforms.uPulse.value);
  resetGoalStir();
  setGoalSwimmers([]);
  enableVersus(false);
  rocks.build();
  const off = scan(rocks.mesh);
  check('with the flag off, the band is rock like any other height', off.inBand > 0, `${off.inBand} triangles in the band`);
  check('...and no hole or light is drawn', rocks.mesh.parent.children.length === 1);
  enableVersus(true);
  rocks.dispose();
}

// ---------------------------------------------------------------------------
section('The contest: a fast ball knocks a slow seal aside; a seal that matches it holds');
{
  const K = V.ball.contest;
  const dash = CONFIG.strike.dashSpeed;
  // ...AND NOT SNARED, AND BREATHING — for the reasons park() in the next
  // section spells out. A snared seal has its movement multiplied by zero and
  // arrives at the contest with no velocity at all; a seal out of air bursts
  // and is put back in its own goal, which from here reads as the ball having
  // flung it up the pitch. Both are functions of how long the sections above
  // ran, and neither is what this section is about.
  const still = () => {
    p2.vel.set(0, 0); p2.knockX = p2.knockY = 0; p2.active = false; p2.dashTimer = 0; p2.power = 0;
    p2.snareTimer = 0; p2.snareMul = 1;
    p2.oxygen = Math.max(1, player.stats?.maxOxygen ?? CONFIG.oxygen?.max ?? 100);
    versusState.dead[1] = 0;
  };
  // The contest is the ball against a SEAL. Empty water for it: the ball goes
  // through fish now too (ballHits), and a bait ball left in its lane would
  // take a bite out of every speed measured below.
  resetEnemies(scene);
  // The ball flying +x at 40 into player 2 sitting in its path.
  resetBall();
  ball.vx = 40;
  p2.pos.set(ball.x + ballReach() - 0.3, ball.y, 0);
  still();
  const m = contestMargin(-1, 0, { x: 0, y: 0 }, false, 0);
  check('a still seal loses to a moving ball by the ball\'s whole speed', Math.abs(m - 40 * K.ballWeight) < 1e-9, `margin ${m.toFixed(1)}`);
  sealContact(1, p2.pos, p2.vel, false, null, 0);
  check('the seal is knocked back along the ball\'s line', p2.knockX > 20, `knockX ${p2.knockX.toFixed(1)} (gain ${K.knockGain} x ${m.toFixed(0)}, cap ${K.knockMax})`);
  check('...and the ball goes THROUGH it, slowed but not stopped', ball.vx > 40 * 0.5 && ball.vx < 40, `vx 40 → ${ball.vx.toFixed(1)}`);
  check('the harness can read the pierce', versusState.lastPierce?.who === 1 && versusState.lastPierce.margin > 0 && !versusState.lastPierce.dashing);

  // The knock is paid ONCE. A ball at the cap into a still seal, frame after
  // frame through the overlap: the seal is carried out of its way, not
  // launched by a fresh knock every frame it is still inside it.
  resetBall();
  ball.vx = ballSpeedCap();
  p2.pos.set(ball.x + ballReach() - 0.3, ball.y, 0);
  still();
  let worstKnock = 0;
  // Sixteen frames, not twelve: a ball at the cap is STRETCHED along its
  // flight, so its trailing edge is half as long again as at rest and it
  // takes a few more frames to be clear of the seal it went through.
  for (let i = 0; i < 16; i++) { frame(); worstKnock = Math.max(worstKnock, p2.knockX); }
  check('the knock is paid once per pass, never a frame at a time', worstKnock <= K.knockMax + 1e-6, `peak knockX ${worstKnock.toFixed(1)} (cap ${K.knockMax})`);
  check('...and the ball keeps most of its speed through the seal', ball.vx > ballSpeedCap() * 0.5, `vx ${ball.vx.toFixed(1)}`);
  check('it went THROUGH — the ball is past the seal and the pass is over', ball.x - p2.pos.x > ballReach() && ball.pierced[1] === false, `ball ${ball.x.toFixed(1)}, seal ${p2.pos.x.toFixed(1)}`);

  // A well struck shot through a slow defender: a seal drifting toward it
  // at a swim, the ball at a strike's speed.
  resetBall();
  ball.vx = -V.ball.maxSpeed;
  p2.pos.set(ball.x - ballReach() + 0.3, ball.y, 0);
  still();
  p2.vel.set(10, 0);
  sealContact(1, p2.pos, p2.vel, false, null, 0);
  check('a full-speed shot goes through a defender swimming at it', ball.vx < -V.ball.maxSpeed * 0.45 && p2.knockX < -20, `vx ${ball.vx.toFixed(1)}, knockX ${p2.knockX.toFixed(1)}`);

  // Equal and opposite: the seal holds its ground and the ball is stopped.
  resetBall();
  ball.vx = -20;
  p2.pos.set(ball.x - ballReach() + 0.3, ball.y, 0);
  still();
  p2.vel.set(20 / K.ballWeight, 0);
  const m0 = contestMargin(1, 0, p2.vel, false, 0);
  sealContact(1, p2.pos, p2.vel, false, null, 0);
  check('equal and opposite is a draw', Math.abs(m0) < 1e-9, `margin ${m0.toFixed(2)}`);
  check('...the seal holds its ground: no knock', p2.knockX === 0 && p2.knockY === 0, `knock (${p2.knockX.toFixed(1)}, ${p2.knockY.toFixed(1)})`);
  check('...and the ball is stopped or sent back, not through', ball.vx >= -1, `vx -20 → ${ball.vx.toFixed(1)}`);

  // The seal faster than the ball: it wins, the ball is pushed, no knock.
  resetBall();
  ball.vx = -10;
  p2.pos.set(ball.x - ballReach() + 0.3, ball.y, 0);
  still();
  p2.vel.set(30, 0);
  sealContact(1, p2.pos, p2.vel, false, null, 0);
  check('a seal out-swimming the ball pushes it and takes no knock', ball.vx > 0 && p2.knockX === 0, `vx ${ball.vx.toFixed(1)}, knockX ${p2.knockX.toFixed(1)}`);

  // THE DEADBAND — contest.hold. A ball drifting at a standing seal used to
  // WIN, because the contest was a bare speed comparison and any number over
  // zero is over zero. It looked exactly like the collision had failed: the
  // body slid through the ball, and under fx.pierceMin it drew nothing while
  // it did. Under `hold` the seal simply has the body.
  const band = K.hold ?? 0;
  check('the deadband is the margin below which a pierce would draw nothing anyway', band === (V.ball.fx?.pierceMin ?? band), `hold ${band}, pierceMin ${V.ball.fx?.pierceMin}`);
  resetBall();
  ball.vx = -(band - 1);
  p2.pos.set(ball.x - ballReach() + 0.3, ball.y, 0);
  still();
  const mDrift = contestMargin(1, 0, p2.vel, false, 0);
  check('a drifting ball is winning the raw contest', mDrift > 0 && mDrift < band, `margin ${mDrift.toFixed(1)} against a deadband of ${band}`);
  sealContact(1, p2.pos, p2.vel, false, null, 0);
  check('...and the seal holds it anyway: no pierce, no knock', !ball.pierced[1] && p2.knockX === 0 && p2.knockY === 0, `knock (${p2.knockX.toFixed(1)}, ${p2.knockY.toFixed(1)})`);
  check('...and it is the ball that gives, not the seal', ball.vx > -(band - 1), `vx ${(-(band - 1)).toFixed(1)} → ${ball.vx.toFixed(1)}`);
  // A few frames of the same and it is dead in the water against the body.
  for (let i = 0; i < 8; i++) { ball.x += ball.vx * dt; sealContact(1, p2.pos, p2.vel, false, null, 0); }
  check('...and a second later it is stopped, not through', Math.abs(ball.vx) < 0.5 && !ball.pierced[1], `vx ${ball.vx.toFixed(2)}`);

  // ...AND THE DEADBAND IS NOT A SHIELD. A real shot still goes through: the
  // seal tops out at CONFIG.player.maxSpeed and the ball at nearly twice it.
  resetBall();
  ball.vx = -V.ball.maxSpeed;
  p2.pos.set(ball.x - ballReach() + 0.3, ball.y, 0);
  still();
  p2.vel.set(CONFIG.player.maxSpeed, 0);
  sealContact(1, p2.pos, p2.vel, false, null, 0);
  check('a full-speed shot still beats a seal swimming flat out at it', ball.pierced[1] && p2.knockX < 0, `knockX ${p2.knockX.toFixed(1)}`);

  // A STRIKE BREAKS A PIERCE. The `pierced` flag waves the ball through the
  // rest of the pass so it is not knocked a frame — but it used to be read
  // BEFORE the dash was considered, so a strike into a ball already inside
  // you did nothing at all: not a nudge, not a failed strike, nothing. At the
  // slow end that dead window is seconds long, because a ball that won by a
  // hair crawls through at walking pace.
  resetBall();
  ball.vx = -(band + 20);
  p2.pos.set(ball.x - ballReach() + 0.3, ball.y, 0);
  still();
  sealContact(1, p2.pos, p2.vel, false, null, 0);
  check('a shot pierces and the flag goes up', ball.pierced[1] === true);
  const carried = ball.vx;
  sealContact(1, p2.pos, p2.vel, false, null, 0);
  check('...and a swim against it while it is through does nothing, as before', ball.vx === carried, `vx ${ball.vx.toFixed(1)}`);
  p2.vel.set(dash, 0); p2.active = true; p2.dashTimer = 0.3; p2.dashTimeLeft = 0.3; p2.power = 1;
  p2.dashDir.x = 1; p2.dashDir.y = 0;
  ball.dashHit[1] = false;
  sealContact(1, p2.pos, p2.vel, p2.active, p2.dashDir, p2.power);
  check('...but a dash re-contests it, wins it back and sends it away', ball.vx > 0 && !ball.pierced[1], `vx ${carried.toFixed(1)} → ${ball.vx.toFixed(1)}`);
  check('...and that dash is spent on it, one contest not one a frame', ball.dashHit[1] === true);

  // -------------------------------------------------------------------------
  // THE SPIKE — a shot driven DOWNWARD, and worth more again when the seal
  // driving it is falling out of a breach. See CONFIG.versus.ball.spike.
  // -------------------------------------------------------------------------
  {
    const S = V.ball.spike;
    const swim = { x: 0, y: -20 };
    // The angle's half, measured through the exported rule rather than by
    // staging a strike: `iy` is the line the ball LEAVES on, so this is the one
    // place the gate can be read without the glance and the grip in the way.
    check('a level shot is not a spike', spikeStrength(0, swim, -1) === 0);
    check('...nor is one sent gently down', spikeStrength(-(S.minDown - 0.05), swim, -1) === 0, `${(S.minDown - 0.05).toFixed(2)} down, under minDown ${S.minDown}`);
    check('a shot driven straight down is a full spike', Math.abs(spikeStrength(-1, { x: 0, y: 0 }, -1) - 1) < 1e-9);
    // THE DIVE needs BOTH halves. A seal swimming down hard has no breach to
    // its name; one that breached and levelled off is not falling.
    p2.airPeak = 0; p2.vel.set(0, -S.diveRef);
    check('falling without a breach behind it is just a spike', Math.abs(spikeStrength(-1, p2.vel, 1) - 1) < 1e-9);
    p2.airPeak = S.peakRef; p2.vel.set(0, 0);
    check('a breach with no fall left in it is just a spike', Math.abs(spikeStrength(-1, p2.vel, 1) - 1) < 1e-9);
    p2.vel.set(0, -S.diveRef);
    const full = spikeStrength(-1, p2.vel, 1);
    check('a full dive onto the ball is worth diveGain', Math.abs(full - S.diveGain) < 1e-9, `${full.toFixed(2)} against diveGain ${S.diveGain}`);

    // ...AND WHAT IT DOES TO THE BALL. The same strike twice, level and down.
    const strikeAt = (dy) => {
      resetBall(); ball.vx = ball.vy = 0;
      const len = Math.hypot(1, dy) || 1;
      p2.pos.set(ball.x - ballReach() * (1 / len) + 0.3 * (1 / len), ball.y - ballReach() * (dy / len), 0);
      still();
      p2.airPeak = 0;
      p2.vel.set(dash / len, dash * dy / len);
      p2.active = true; p2.dashTimer = 0.3; p2.dashTimeLeft = 0.3; p2.power = 1;
      p2.dashDir.x = 1 / len; p2.dashDir.y = dy / len;
      ball.dashHit[1] = false; ball.pierced[1] = false;
      sealContact(1, p2.pos, p2.vel, p2.active, p2.dashDir, p2.power);
      return { speed: Math.hypot(ball.vx, ball.vy), spike: ball.spike };
    };
    const level = strikeAt(0);
    const down = strikeAt(-4);
    check('a spiked ball leaves faster than a level shot of the same power', down.speed > level.speed * 1.15, `${level.speed.toFixed(1)} level → ${down.speed.toFixed(1)} spiked`);
    check('...and the cap moved with it, or the multiplier would buy nothing', down.speed > V.ball.maxSpeed, `${down.speed.toFixed(1)} against a maxSpeed of ${V.ball.maxSpeed}`);
    check('...but never past the physics ceiling', down.speed <= ballSpeedCap() + 1e-6, `${down.speed.toFixed(1)} ≤ ${ballSpeedCap()}`);
    check('a level shot leaves no spike on the ball', level.spike === 0);
    check('...and a spiked one does', down.spike > 0, `spike ${down.spike.toFixed(2)}`);

    // A DEFENDER IN THE WAY. The same ball at the same speed into the same
    // still seal, with and without the spike on it — so the only thing that
    // differs between the two is the flag.
    const pierceKnock = (spike) => {
      resetBall();
      ball.vx = -50;
      p2.pos.set(ball.x - ballReach() + 0.3, ball.y, 0);
      still();
      p2.jolt.spin = p2.jolt.spinV = p2.jolt.roll = p2.jolt.rollV = 0; p2.jolt.free = 0;
      ball.spike = spike;
      sealContact(1, p2.pos, p2.vel, false, null, 0);
      return { knock: Math.hypot(p2.knockX, p2.knockY) + Math.hypot(p2.vel.x, p2.vel.y), free: p2.jolt.free };
    };
    const plain = pierceKnock(0);
    const spiked = pierceKnock(1);
    check('a defender hit by a spike is knocked harder than by the same ball unspiked', spiked.knock > plain.knock * 1.5, `${plain.knock.toFixed(1)} → ${spiked.knock.toFixed(1)} u/s`);
    check('...and ragdolls with it', spiked.free > 0, `limp ${spiked.free.toFixed(2)}s`);
    // AND THE SPIKE IS SPENT ON THE BODY THAT HELD IT. A seal that wins the
    // contest ends the shot; the next defender down the pitch is not standing
    // in a spike's path any more.
    resetBall(); ball.vx = -4; ball.spike = 1;
    p2.pos.set(ball.x - ballReach() + 0.3, ball.y, 0);
    still();
    sealContact(1, p2.pos, p2.vel, false, null, 0);
    check('a seal that holds the ball ends the spike', ball.spike === 0);
    resetBall(); ball.spike = 1;
    ball.y = bounds.bottom + ballRestRadius() + 0.05; ball.vy = -30; ball.vx = 0;
    settle(0.4);
    check('...and so does the rock', ball.spike === 0);
    p2.airPeak = 0;
  }

  // -------------------------------------------------------------------------
  // WHAT A SPIKE LOOKS AND SOUNDS LIKE — the freeze, the smear, the voice.
  // -------------------------------------------------------------------------
  {
    const SP = V.ball.spike;
    const def = CONFIG.feedback.versusSpike;
    check('a spike has an event of its own', !!def);
    check('...with a voice of its own', !!CONFIG.sfx[def.sfx], def.sfx);
    check('...a smear emitter of its own', !!CONFIG.emitters[def.emit], def.emit);
    // It rides OVER versusBallHit, the way a block rides over a nudge — the
    // slap is what the touch sounded like and this is what it was. Two voices
    // that fired instead of each other would make a spike QUIETER than an
    // ordinary strike, which is the opposite of the point.
    check('...and it is a different voice from the ordinary strike',
      def.sfx !== CONFIG.feedback.versusBallHit.sfx);

    // THE FREEZE. It is the only thing in the game with a hit-stop of its own
    // shape: the length rides `scale` and the depth overrides the global.
    check('it is on the hit-stop guest list', hitstopAllowed('versusSpike'));
    check('...and an ordinary strike still is not', !hitstopAllowed('versusBallHit'));
    check('...its freeze is deeper than everything else\'s',
      def.hitstopScale != null && def.hitstopScale < CONFIG.fx.hitstopScale,
      `${def.hitstopScale} against the global ${CONFIG.fx.hitstopScale}`);
    check('...and its LENGTH rides how much of a spike it was', def.hitstopScales === true);

    // Measured through feedback() rather than read off the row: a `hitstopScales`
    // nothing consumed would sit in the table looking correct forever.
    const wasEnabled = CONFIG.fx.hitstopEnabled;
    CONFIG.fx.hitstopEnabled = true;
    const stopFor = (scale) => {
      initFeedback(null);
      feedback('versusSpike', { x: 0, y: 0, scale });
      return feedbackState.hitstop;
    };
    const weak = stopFor(0.5);
    const hard = stopFor(1.8);
    check('a glancing spike freezes the game for less than a full one', hard > weak * 1.5,
      `${weak.toFixed(3)}s at scale 0.5, ${hard.toFixed(3)}s at 1.8`);
    CONFIG.fx.hitstopEnabled = wasEnabled;
    initFeedback(null);

    // AND IT ACTUALLY FIRES, off a real strike rather than by hand. The one
    // thing none of the rows above can tell you.
    resetBall(); ball.vx = ball.vy = 0; fired.clear();
    const dy = -4;
    const len = Math.hypot(1, dy);
    p2.pos.set(ball.x - ballReach() / len + 0.3 / len, ball.y - ballReach() * dy / len, 0);
    still();
    p2.airPeak = 0;
    p2.vel.set(dash / len, dash * dy / len);
    p2.active = true; p2.dashTimer = 0.3; p2.dashTimeLeft = 0.3; p2.power = 1;
    p2.dashDir.x = 1 / len; p2.dashDir.y = dy / len;
    ball.dashHit[1] = false; ball.pierced[1] = false;
    sealContact(1, p2.pos, p2.vel, p2.active, p2.dashDir, p2.power);
    check('a real downward strike fires it', firedCount('versusSpike') === 1, `${firedCount('versusSpike')}`);
    check('...over the ordinary strike rather than instead of it', touchCount() >= 1, `${touchCount()} touch(es)`);
    // A full-power downward strike is the hard end by construction, so this is
    // also where the smash row has to show up — the spike rides OVER it.
    check('...and that strike is the hard row', firedCount('versusBallSmash') >= 1, `${firedCount('versusBallSmash')} smash(es)`);
    check('...and the harness can read what it was',
      versusState.lastSpike?.spike > 0 && versusState.lastSpike.who === 1,
      JSON.stringify(versusState.lastSpike));
    // THE SMEAR GOES THE WAY THE BALL WENT, not the way the seal touched it:
    // what a spike should paint on the water is where the shot is heading.
    const going = Math.hypot(ball.vx, ball.vy) || 1;
    const along = (versusState.lastSpike.dirX * ball.vx + versusState.lastSpike.dirY * ball.vy) / going;
    check('...and the smear is thrown along the shot, not along the contact normal',
      along > 0.95, `cos ${along.toFixed(3)} between the smear and the ball's flight`);

    // A level strike of the same power fires nothing.
    resetBall(); ball.vx = ball.vy = 0; fired.clear();
    p2.pos.set(ball.x - ballReach() + 0.3, ball.y, 0);
    still();
    p2.vel.set(dash, 0);
    p2.active = true; p2.dashTimer = 0.3; p2.dashTimeLeft = 0.3; p2.power = 1;
    p2.dashDir.x = 1; p2.dashDir.y = 0;
    ball.dashHit[1] = false; ball.pierced[1] = false;
    sealContact(1, p2.pos, p2.vel, p2.active, p2.dashDir, p2.power);
    check('a level strike fires nothing', firedCount('versusSpike') === 0);
    still();
  }

  // THE COUNTER-STRIKE. The ball coming in at maxSpeed; a full wind-up dash
  // meets it: the strike holds (dashMass x dash speed beats the ball) and
  // sends it back FASTER than maxSpeed — up to returnMax x what came in.
  resetBall();
  ball.vx = V.ball.maxSpeed;
  p2.pos.set(ball.x + ballReach() - 0.3, ball.y, 0);
  still();
  p2.vel.set(-dash, 0);
  p2.active = true; p2.dashTimer = 0.3; p2.dashTimeLeft = 0.3; p2.power = 1;
  p2.dashDir.x = -1; p2.dashDir.y = 0;
  ball.dashHit[1] = false;
  const mFull = contestMargin(-1, 0, p2.vel, true, 1);
  check('a full dash out-weighs a maxSpeed ball', mFull < 0, `margin ${mFull.toFixed(1)} (mass ${contestMass(true, 1).toFixed(2)} x ${dash})`);
  const cap = returnCap(V.ball.maxSpeed);
  check('the return cap rises with the incoming speed', cap > V.ball.maxSpeed && Math.abs(cap - Math.min(K.speedCap, V.ball.maxSpeed * K.returnMax)) < 1e-9, `cap ${cap.toFixed(1)}`);
  sealContact(1, p2.pos, p2.vel, p2.active, p2.dashDir, p2.power);
  check('the counter-strike sends it back faster than a strike on a still ball can', ball.vx < -V.ball.maxSpeed && Math.abs(ball.vx) <= cap + 1e-6, `vx ${V.ball.maxSpeed} → ${ball.vx.toFixed(1)} (cap ${cap.toFixed(1)})`);
  check('...and no slower than returnGain x what came in', Math.abs(ball.vx) >= returnFloor(V.ball.maxSpeed) - 1e-6, `${Math.abs(ball.vx).toFixed(1)} ≥ ${returnFloor(V.ball.maxSpeed).toFixed(1)}`);
  check('...and the striker took no knock — it won', p2.knockX === 0, `knockX ${p2.knockX.toFixed(1)}`);

  // A limp dash into the same ball loses: the dash breaks and the ball
  // keeps coming.
  resetBall();
  ball.vx = V.ball.maxSpeed;
  p2.pos.set(ball.x + ballReach() - 0.3, ball.y, 0);
  still();
  p2.vel.set(-dash, 0);
  p2.active = true; p2.dashTimer = 0.3; p2.dashTimeLeft = 0.3; p2.power = 0;
  ball.dashHit[1] = false;
  const mLimp = contestMargin(-1, 0, p2.vel, true, 0);
  check('a zero-power dash does not out-weigh it', mLimp > 0, `margin ${mLimp.toFixed(1)}`);
  sealContact(1, p2.pos, p2.vel, p2.active, p2.dashDir, p2.power);
  check('...so the ball goes through and the dash is broken', ball.vx > 0 && !p2.active && p2.knockX > 0, `vx ${ball.vx.toFixed(1)}, active ${p2.active}, knockX ${p2.knockX.toFixed(1)}`);
  check('...and that dash gets no second go at it', ball.dashHit[1] === true);

  // THE VOLLEY. Full-power counter-strikes traded back and forth from a
  // standing start: each return is faster than the last up to the cap, and
  // a full wind-up can keep answering at the cap — what loses is a swing
  // with less than a full wind-up behind it, which at the cap's speed is
  // every swing a player had no time for. Both seals through sealContact
  // with a fresh dash each time, on the same line.
  resetBall();
  const speeds = [];
  let pierced = -1;
  const swing = (who, dir, power = 1) => {
    const pos = who === 0 ? player.mesh.position : p2.pos;
    const vel = who === 0 ? player.velocity : p2.vel;
    // A CLEAN SKIN EACH SWING. This drives sealContact directly with no frame
    // between the swings, so stepSoftBody never runs and each strike's dent
    // lands on the last one's: ten of them and the rim is pinned at maxDeform
    // all the way round, which through the goo isoline is a ball half again
    // as wide as it should be. What is being measured here is the CONTEST —
    // who moves whom — so the body is put back to a sphere and the placement
    // below means what it says. The velocity stretch is left alone: that one
    // is honest at any moment.
    ball.rim.fill(0);
    ball.rimV.fill(0);
    pos.set(ball.x - dir * (ballReach() - 0.3), ball.y, 0);
    vel.set(dir * dash, 0);
    ball.dashHit[who] = false;
    if (who === 0) { strikeState.active = true; strikeState.power = power; strikeState.dashDir.x = dir; strikeState.dashDir.y = 0; player.knockX = player.knockY = 0; }
    else { p2.active = true; p2.dashTimer = 0.3; p2.dashTimeLeft = 0.3; p2.power = power; p2.dashDir.x = dir; p2.dashDir.y = 0; p2.knockX = p2.knockY = 0; }
    const before = versusState.lastPierce;
    sealContact(who, pos, vel, true, who === 0 ? strikeState.dashDir : p2.dashDir, power);
    return versusState.lastPierce !== before;
  };
  const N = 10;
  for (let i = 0; i < N; i++) {
    const who = i % 2;           // P1 hits it +x, P2 hits it back -x
    const dir = who === 0 ? 1 : -1;
    if (swing(who, dir)) { pierced = i; break; }
    speeds.push(Math.abs(ball.vx));
  }
  const top = ballSpeedCap();
  const capped = speeds.findIndex((v) => v >= top - 1e-6);
  const climb = capped < 0 ? speeds : speeds.slice(0, capped + 1);
  const rising = climb.every((v, i) => i === 0 || v > climb[i - 1] + 0.5);
  const hold = contestMass(true, 1) * dash / K.ballWeight;
  note(`volley at full power: ${speeds.map((v) => v.toFixed(0)).join(' → ')}${pierced >= 0 ? ` → through on swing ${pierced + 1}` : ''} (top ${top}, a full dash holds up to ${hold.toFixed(0)} u/s)`);
  check('the first strike is capped at maxSpeed', speeds.length && Math.abs(speeds[0] - V.ball.maxSpeed) < 1e-6, `${speeds[0]?.toFixed(1)}`);
  check('every return is faster than the last, up to the top', climb.length >= 3 && rising, climb.map((v) => v.toFixed(0)).join(' → '));
  check('the volley climbs past maxSpeed', speeds.some((v) => v > V.ball.maxSpeed + 5));
  check('...and reaches the top', capped >= 0 && capped <= 4, `swing ${capped + 1}`);
  check('a full wind-up can keep answering at the top', pierced < 0 && speeds.length === N && hold >= top - 1e-6, `${N} swings, hold ${hold.toFixed(0)} vs top ${top}`);
  check('nothing ever went past speedCap', speeds.every((v) => v <= top + 1e-6));
  // The ball at the top, and the next swing only half wound: the contest is
  // lost, the ball goes through and the seal is knocked out of its way.
  const halfHold = contestMass(true, 0.5) * dash / K.ballWeight;
  const who = N % 2;
  const lost = swing(who, who === 0 ? 1 : -1, 0.5);
  check('a half-charged swing at a ball at the top loses', lost && halfHold < top, `holds ${halfHold.toFixed(0)} vs ${top}`);
  check('...the ball goes through and the dash is broken', versusState.lastPierce?.dashing && versusState.lastPierce.who === who && (who === 0 ? !strikeState.active : !p2.active), `who ${versusState.lastPierce?.who}`);
  check('...and the loser is knocked back', versusState.lastPierce?.knock > 10 && (who === 0 ? Math.abs(player.knockX) : Math.abs(p2.knockX)) > 10, `knock ${versusState.lastPierce?.knock?.toFixed(1)}`);
  check('the hold a dash has grows with its wind-up', contestMass(true, 0) < contestMass(true, 0.5) && contestMass(true, 0.5) < contestMass(true, 1) && contestMass(false, 1) === 1);
  strikeState.active = false;
  p2.active = false;
  // A stray dash flag would leak into the sections after this one.
  player.velocity.set(0, 0); p2.vel.set(0, 0);
  player.knockX = player.knockY = 0; p2.knockX = p2.knockY = 0;
  player.mesh.position.set(-30, midWater(), 0); p2.pos.set(30, midWater(), 0);
  resetBall();
}

// ---------------------------------------------------------------------------
section('Two seals cannot overlap, and the faster swimmer knocks the slower aside');
{
  const events = [];
  const off = onFeedback((name, at) => { if (name === 'bodyCheck') events.push({ ...at }); });
  const cr = V.bodyCheck.contactRadius;
  const y = midWater();
  resetBall();
  ball.x = bounds.right - 10;
  // PARKED MEANS PARKED — and two of the things that had to be put back are
  // not positions, which is why this section used to answer differently
  // depending on what ran ABOVE it.
  //
  // THE SNARE is the one that actually bit. A seal caught in one has
  // `snareMul` 0 and stepSeat multiplies its movement by it, so a snared p2
  // arrives at the collision with its velocity wiped — and "equal and
  // opposite" then measures p1 at 20 against a seal at 0 and reports a margin
  // of exactly 20 where it wanted 0. Whether the snare had worn off by the
  // time this section ran was a function of how many seconds the sections
  // above happened to simulate, so adding one anywhere upstream silently
  // changed what this one measured.
  //
  // THE AIR is the same shape of problem: it drains with the match clock, and
  // a seal that runs out bursts and is put back in its own goal a second later
  // (versusOutOfAir) — which from here looks like the collision having flung
  // it sixty units up the pitch, except that a seal in that second is not
  // being driven at all, so the checks were reading a body nothing was moving.
  //
  // Both are cleared here rather than in the sections that leave them, because
  // this is the function whose whole job is "put the two of them back".
  const park = () => {
    strikeState.active = false; p2.active = false; p2.dashTimer = 0;
    player.velocity.set(0, 0); p2.vel.set(0, 0);
    player.knockX = player.knockY = 0; p2.knockX = p2.knockY = 0;
    player.snareTimer = 0; player.snareMul = 1;
    p2.snareTimer = 0; p2.snareMul = 1;
    const air = Math.max(1, player.stats?.maxOxygen ?? CONFIG.oxygen?.max ?? 100);
    player.oxygen = air; p2.oxygen = air;
    versusState.dead[0] = 0; versusState.dead[1] = 0;
    player.mesh.position.set(-30, y, 0); p2.pos.set(30, y, 0);
    frame();
    events.length = 0;
  };
  park();
  // P1 swimming +x into P2 sitting still, overlapping by a unit.
  player.mesh.position.set(0, y, 0);
  player.velocity.set(30, 0);
  p2.pos.set(cr * 2 - 1, y, 0);
  frame();
  const gap = p2.pos.x - player.mesh.position.x;
  check('they are pushed apart to touching', gap >= cr * 2 - 1e-6, `gap ${gap.toFixed(2)} (want ${(cr * 2).toFixed(2)})`);
  // The shove is a jostle now (CONFIG.versus.bodyCheck): velShare of it as
  // velocity, the rest as the knock; the winner takes winnerShare as recoil.
  const BC = V.bodyCheck;
  check('the still seal is knocked back', p2.knockX > 10 * (1 - BC.velShare) && p2.vel.x > 0, `knockX ${p2.knockX.toFixed(1)}, vx ${p2.vel.x.toFixed(1)}`);
  check('...and the swimmer takes only its recoil share', Math.abs(player.knockX) <= p2.knockX * BC.winnerShare + 1e-6, `knockX ${player.knockX.toFixed(1)} vs ${p2.knockX.toFixed(1)} x ${BC.winnerShare}`);
  check('one event, a soft one', events.length === 1 && events[0].scale <= 1.2, `${events.length}, scale ${events[0]?.scale?.toFixed(2)}`);
  check('the harness can read it', versusState.lastCollide?.met && versusState.lastCollide.loser === 1 && versusState.lastCollide.margin > 0);
  // Still pressed together the next frames: apart, but no second knock.
  const k1 = p2.knockX;
  p2.knockX = 0;
  p2.pos.x = player.mesh.position.x + cr * 2 - 0.5;
  frame();
  frame();
  check('staying pressed together is the push-apart only, no second knock', p2.knockX === 0 && (p2.pos.x - player.mesh.position.x) >= cr * 2 - 1e-6, `knockX ${p2.knockX.toFixed(1)} after ${k1.toFixed(1)}`);
  check('...and no second event', events.length === 1, `${events.length}`);
  // Apart, then together again: a new meeting.
  p2.pos.set(30, y, 0);
  frame();
  check('once apart they are no longer touching', versusState.touching === false);
  p2.pos.set(player.mesh.position.x + cr * 2 - 0.5, y, 0);
  frame();
  check('meeting again is a new knock', p2.knockX > 10 && events.length === 2, `knockX ${p2.knockX.toFixed(1)}, ${events.length} events`);

  // Equal and opposite swimmers: apart, nobody knocked.
  park();
  player.mesh.position.set(0, y, 0); player.velocity.set(20, 0);
  p2.pos.set(cr * 2 - 1, y, 0); p2.vel.set(-20, 0);
  frame();
  // (P2 takes the frame's friction in stepP2 and P1 does not move here at
  // all, so the draw is within a u/s of even — a knock of a fraction, not
  // nothing, and no event above the burst's own floor.)
  check('equal and opposite: pushed apart, nobody knocked', (p2.pos.x - player.mesh.position.x) >= cr * 2 - 1e-6 && Math.abs(p2.knockX) < 2 && Math.abs(player.knockX) < 2, `gap ${(p2.pos.x - player.mesh.position.x).toFixed(2)}, knocks ${player.knockX.toFixed(1)} / ${p2.knockX.toFixed(1)}, margin ${versusState.lastCollide?.margin?.toFixed(2)}`);
  check('...and no event', events.length === 0);

  // The slower swimmer loses: P2 swimming at P1 harder than P1 swims at it.
  park();
  player.mesh.position.set(0, y, 0); player.velocity.set(10, 0);
  p2.pos.set(cr * 2 - 1, y, 0); p2.vel.set(-30, 0);
  frame();
  check('the slower swimmer is the one knocked', player.knockX < -10 * (1 - V.bodyCheck.velShare) && p2.knockX <= Math.abs(player.knockX) * V.bodyCheck.winnerShare + 1e-6, `knocks ${player.knockX.toFixed(1)} / ${p2.knockX.toFixed(1)}`);
  const lc = versusState.lastCollide;
  const knockWant = Math.min(V.sealCollide.knockMax, V.sealCollide.knockGain * Math.abs(lc?.margin ?? 0)) * (1 - V.bodyCheck.velShare);
  check('...by the margin, not the closing speed', !!lc && Math.abs(Math.abs(player.knockX) - knockWant) < 1e-6 && Math.abs(lc.margin) < 25, `knockX ${player.knockX.toFixed(1)} = gain x |${lc?.margin?.toFixed(1)}| x (1 - velShare) (closing was ~40)`);

  // A seal in its respawn grace is a body but takes no knock.
  park();
  versusState.invuln[1] = 1;
  player.mesh.position.set(0, y, 0); player.velocity.set(30, 0);
  p2.pos.set(cr * 2 - 1, y, 0);
  frame();
  check('a seal in its grace is pushed apart but not knocked', (p2.pos.x - player.mesh.position.x) >= cr * 2 - 1e-6 && p2.knockX === 0, `knockX ${p2.knockX.toFixed(1)}`);
  versusState.invuln[1] = 0;

  // Off: nothing at all.
  park();
  V.sealCollide.enabled = false;
  player.mesh.position.set(0, y, 0); player.velocity.set(30, 0);
  p2.pos.set(cr * 2 - 1, y, 0);
  frame();
  check('with it off the seals pass through each other as before', (p2.pos.x - player.mesh.position.x) < cr * 2 - 0.5 && p2.knockX === 0);
  V.sealCollide.enabled = true;
  off?.();
  park();
}

// ---------------------------------------------------------------------------
section('The goal is in frame while the ball is in its zone');
{
  const frame = { w: 52 * 16 / 9, h: 52 };
  const cam = V.camera;
  const savedMode = cam.mode;
  const savedZone = cam.goalZone;
  cam.mode = 'A';
  resetBall();
  ball.vx = ball.vy = 0;
  const gy = mouthY();
  const h = mouthHalfHeight();
  // The frame a goal describes: its edges at that zoom.
  const edges = (g) => ({ left: g.x - frame.w / 2 / g.zoom, right: g.x + frame.w / 2 / g.zoom, top: g.y + frame.h / 2 / g.zoom, bottom: g.y - frame.h / 2 / g.zoom });
  // The ball near the left goal with both seals inboard of it — a frame that,
  // left to the seals, is punched in past the wall.
  ball.x = bounds.left + 20; ball.y = gy + 6;
  player.mesh.position.set(bounds.left + 30, gy + 4, 0);
  p2.pos.set(bounds.left + 40, gy + 8, 0);
  cam.goalZone = 0;
  const bare = edges(versusCameraGoal(frame));
  check('without the zone the mouth is out of frame', bare.left > rockX(-1) + 1, `left edge ${bare.left.toFixed(1)} vs wall ${rockX(-1).toFixed(1)}`);
  cam.goalZone = savedZone;
  const withZone = versusCameraGoal(frame);
  const e = edges(withZone);
  check('with the ball in the zone the frame reaches the wall', e.left <= rockX(-1) + 1e-6, `left edge ${e.left.toFixed(1)} vs wall ${rockX(-1).toFixed(1)}`);
  check('...and the whole band, top to bottom', e.top >= gy + h - 1e-6 && e.bottom <= gy - h + 1e-6, `frame y ${e.bottom.toFixed(1)}..${e.top.toFixed(1)}, band ${(gy - h).toFixed(1)}..${(gy + h).toFixed(1)}`);
  check('the zoom came out, not the centre only', withZone.zoom < 1 / (bare.right - bare.left) * frame.w - 1e-6, `zoom ${withZone.zoom.toFixed(2)}`);
  // Out of the zone: nothing changes.
  ball.x = bounds.left + savedZone + ball.r + 2;
  player.mesh.position.set(ball.x + 10, gy, 0);
  p2.pos.set(ball.x + 20, gy, 0);
  cam.goalZone = 0;
  const far0 = versusCameraGoal(frame, {});
  cam.goalZone = savedZone;
  const far1 = versusCameraGoal(frame, {});
  check('outside the zone the goal changes nothing', Math.abs(far0.x - far1.x) < 1e-9 && Math.abs(far0.zoom - far1.zoom) < 1e-9, `x ${far0.x.toFixed(2)} vs ${far1.x.toFixed(2)}`);
  // Across the blend: the frame widens step by step, never in a jump.
  // CONTINUITY, not steepness: the worst step over the zone's edge at a
  // half-unit stride, and again at a quarter — a blend halves with the
  // stride, a jump does not. (The ball is left 6 units above the mouth's
  // centre from the check above, which is the steeper case: the far lip
  // enters the box as it blends in.)
  const sweep = (stride) => {
    let worst = 0;
    let prev = null;
    for (let d = savedZone + 1; d >= 0; d -= stride) {
      ball.x = bounds.left + ball.r + d;
      player.mesh.position.set(ball.x + 10, gy, 0);
      p2.pos.set(ball.x + 20, gy, 0);
      const g = versusCameraGoal(frame, {});
      if (prev) worst = Math.max(worst, Math.abs(g.x - prev.x) + Math.abs(g.zoom - prev.zoom) * 20);
      prev = g;
    }
    return worst;
  };
  const worstHalf = sweep(0.5);
  const worstQuarter = sweep(0.25);
  check('the mouth blends in as the ball closes — no jump across the zone\'s edge', worstQuarter < worstHalf * 0.65 + 0.05 && worstHalf < 6, `worst step ${worstHalf.toFixed(2)} per half unit, ${worstQuarter.toFixed(2)} per quarter`);
  // The right goal, the same way.
  ball.x = bounds.right - 20; ball.y = gy - 6;
  player.mesh.position.set(bounds.right - 30, gy, 0);
  p2.pos.set(bounds.right - 40, gy - 4, 0);
  const r = edges(versusCameraGoal(frame));
  check('the right goal too', r.right >= rockX(1) - 1e-6 && r.top >= gy + h - 1e-6 && r.bottom <= gy - h + 1e-6, `right edge ${r.right.toFixed(1)} vs wall ${rockX(1).toFixed(1)}`);
  // Mode B: the same rule.
  cam.mode = 'B';
  const rb = edges(versusCameraGoal(frame));
  check('mode B frames it as well', rb.right >= rockX(1) - 1e-6, `right edge ${rb.right.toFixed(1)}`);
  // The tunnel shown never exceeds what the camera may drift past the wall.
  check('the tunnel it shows is within the camera\'s drift past the wall', (cam.mouthShow ?? 0) <= CONFIG.camera.edgeDrift, `mouthShow ${cam.mouthShow} ≤ edgeDrift ${CONFIG.camera.edgeDrift}`);
  cam.mode = savedMode;
  cam.goalZone = savedZone;
  player.mesh.position.set(-30, gy, 0); p2.pos.set(30, gy, 0);
  resetBall();
}



// An orthographic camera in the shape world.js builds one, parked on a given
// focus point at a given zoom — so a camera check can say where the shot IS
// without standing up a renderer. The focus point is the position plus the
// centre of the frustum, which is the same arithmetic world.js's viewCentre
// does and the same one updateVersusCamera reads it back with.
function fakeCam(frame, at) {
  return {
    left: -frame.w / 2, right: frame.w / 2,
    top: frame.h / 2, bottom: -frame.h / 2,
    zoom: at.zoom,
    position: { x: at.x, y: at.y },
  };
}

// WHICH TEAM'S COLOUR A RIM IS WEARING. The outline shells carry colour x glow,
// so this compares by HUE rather than by equality against a hex the glow has
// already scaled — the same argument as the `nearest` in the roster section.
function nearestTeam(hex) {
  const c = new THREE.Color(hex);
  const norm = (q) => { const t = q.r + q.g + q.b || 1e-6; return [q.r / t, q.g / t]; };
  const [cr, cg] = norm(c);
  let best = -1; let bestD = Infinity;
  goalColors().forEach((tc, i) => {
    const [qr, qg] = norm(new THREE.Color(tc));
    const d = (cr - qr) ** 2 + (cg - qg) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

// ---------------------------------------------------------------------------
// THE TEAM SELECT'S PITCH. The screen used to sit over the MAIN MENU — a bust
// of one seal in a crop of water, while the panel in front of it was about two
// teams. So the thing it is for was the one thing it could not show.
// ---------------------------------------------------------------------------
section('The team select stands the roster up in the arena, with no match around it');
{
  const before = matchRoster();
  resetVersus();
  resetPlayer();
  setMatchRoster(2);
  showRosterPreview(scene);
  check('the pitch is up', rosterPreviewOn());
  // ...AND IT IS NOT A MATCH. Every system that asks "is a match on" asks this
  // one flag, so a preview that set it would start the clock, the bot, the
  // HUD and the ball along with the seals.
  check('...but no match is running', versusState.active === false);
  check('...and no ball is in the water', ball.live === false && ball.slots.length === 0);
  check('the mouths are cut, so it is a pitch and not an arena', goalHolesInstalled());
  check('every seat is standing in it', matchSeals().length === 4, `${matchSeals().length} bodies`);
  {
    const off = [0, 1, 2, 3].map((i) => {
      const spot = kickoffSpot(i, { x: 0, y: 0 });
      const p = sealPos(sealAt(i));
      return Math.hypot(p.x - spot.x, p.y - spot.y);
    });
    check('...on its own kickoff spot, the player included', off.every((d) => d < 1e-6), off.map((d) => d.toFixed(2)).join(' '));
    check('...facing the ball', [0, 1, 2, 3].every((i) => {
      const p = sealPos(sealAt(i));
      const want = Math.atan2(midWater() - p.y, 0 - p.x);
      const face = sealAt(i).mesh.rotation.z + Math.PI / 2;
      return Math.abs(((face - want + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI) < 1e-6;
    }));
  }
  // A SEAT ADDED IS A SEAL IN THE WATER, which is the whole point of the
  // screen having a pitch behind it.
  setMatchRoster(3);
  refreshRosterPreview();
  check('a seat added puts a seal in the water', matchSeals().length === 6, `${matchSeals().length} bodies`);
  check('...and a marker under it', seatMarkers().length === 6, `${seatMarkers().length} markers`);
  setMatchRoster(1);
  refreshRosterPreview();
  check('...and a seat taken away takes one out', matchSeals().length === 2, `${matchSeals().length} bodies`);

  check('...and leaves no marker behind in the scene',
    seatMarkers().length === 2 && seatMarkers().every((m) => m.parent === scene),
    `${seatMarkers().length} markers`);

  // THE STRAY CIRCLE, half one. buildRoster only ever PUSHED markers, so
  // OPENING THE SCREEN A SECOND TIME — Back out of Blubberball and in again,
  // which is one press each way — left the first visit's set in the water for
  // good. They kept their team colour and, never being moved again, sat at the
  // world origin: a thin coloured ring at the waterline with no seal in it, on
  // the one screen whose whole job is to show you the seals.
  //
  // showRosterPreview twice, because that is the path: refreshRosterPreview
  // disposes before it rebuilds and could never leak, so a test written around
  // the stepper passes with the bug fully present.
  //
  // Counted against the SCENE as well as the array — an array trimmed while
  // the old meshes are still parented is the same bug with a tidier bookkeeper.
  {
    showRosterPreview(scene);
    const live = new Set(seatMarkers());
    const rings = scene.children.filter((c) => c.geometry?.type === 'RingGeometry');
    check('reopening the screen builds one set of markers, not two',
      seatMarkers().length === 2, `${seatMarkers().length} markers`);
    check('...and leaves no orphaned ring in the water',
      rings.length === live.size && rings.every((m) => live.has(m)),
      `${rings.length} ring mesh(es) for ${live.size} marker(s)`);
  }

  // EVERY MARKER UNDER ITS OWN SEAL, AT EVERY ROSTER SIZE. The follow loop was
  // `if (markers.length === 2)` — written when a match was a pair, and from
  // the day the roster could be anything else it did nothing at all: six
  // markers, none of them ever moved, all six stacked at the origin. One
  // circle, at the waterline, apparently unattached to anything.
  //
  // Three a side rather than one, because a roster of two is the one size the
  // old guard happened to get right — testing at that size is testing the
  // case that already worked.
  setMatchRoster(3);
  refreshRosterPreview();
  {
    const off = matchSeals().map((seal) => {
      const m = seatMarkers()[seatOf(seal)];
      const p = sealPos(seal);
      return m ? Math.hypot(m.position.x - p.x, m.position.y - p.y) : Infinity;
    });
    check('every marker sits under its own seal on the pitch', off.every((d) => d < 1e-6),
      off.map((d) => d.toFixed(2)).join(' '));
    // ...and none of them is at the origin, which is where an unplaced one
    // sits and is also a legal place for a seal to be. Checked against the
    // SEALS being away from it, so this cannot pass by coincidence.
    const atOrigin = seatMarkers().filter((m) => Math.hypot(m.position.x, m.position.y) < 1e-6).length;
    check('...and none is parked at the origin', atOrigin === 0, `${atOrigin} at (0,0)`);
  }
  // AND THE SELECT'S PITCH DRAWS EVERY ONE OF THEM, whoever ends up in the
  // seat. A match hides the mark under a bot (see the match section below),
  // and the seats are not filled in until Start — so the rule that belongs to
  // a match must not reach back onto the screen whose job is to show you the
  // whole roster in its two colours.
  check('...and every mark is drawn on the select\'s pitch',
    seatMarkers().every((m) => m.visible),
    `${seatMarkers().filter((m) => m.visible).length}/6 drawn`);
  setMatchRoster(1);
  refreshRosterPreview();
  // A COLOUR IS REPAINTED, NOT REBUILT. render() fires this on every press and
  // a captain thumbs the wheel several times a second: eight GLB clones per
  // press is a stutter on the one screen whose job is to feel immediate.
  {
    setMatchRoster(2);
    refreshRosterPreview();
    const bodies = [0, 1, 2, 3].map((i) => sealAt(i).body);
    const wheel = V.wheel;
    const was = versusSetup.teams[0].color;
    versusSetup.teams[0].color = wheel.find((c) => c !== teamColor(0) && c !== teamColor(1)) ?? wheel[0];
    refreshRosterPreview();
    check('a colour change keeps the same bodies', [0, 1, 2, 3].every((i) => sealAt(i).body === bodies[i]));
    const rim = [];
    sealAt(2).body.traverse((o) => { if (o.userData?.__isOutline && o.material?.color) rim.push(o.material.color.getHex()); });
    check('...and repaints the rims to the new one', rim.length > 0 && nearestTeam(rim[0]) === 0,
      rim.length ? `#${rim[0].toString(16)} nearest team ${nearestTeam(rim[0])}` : 'no rim found');
    versusSetup.teams[0].color = was;
    refreshRosterPreview();
  }
  // NOTHING CHANGED IS NOTHING DONE. render() calls this on every keypress the
  // screen sees, including the ones that move nothing.
  {
    const bodies = [0, 1, 2, 3].map((i) => sealAt(i).body);
    refreshRosterPreview();
    refreshRosterPreview();
    check('a refresh that changes nothing rebuilds nothing', [0, 1, 2, 3].every((i) => sealAt(i).body === bodies[i]));
  }
  // THE SEAL ARRIVES LATE, SOMETIMES. createVisual hands back a stand-in until
  // the model has decoded, and ASSETS.ship's stand-in is a cone of radius 0.7 —
  // which inside a marker ring three units across reads as a ring with nothing
  // in it. A match used to be reached from inside a run, where the file had
  // long since landed; this screen builds its roster straight off the main menu.
  {
    const shipLoaded = isAssetLoaded('ship');
    check('the harness has no model, which is the case this is about', !shipLoaded, `${shipLoaded}`);
    const bodies = () => [0, 1, 2, 3].map((i) => sealAt(i)?.body).filter(Boolean);
    const was = bodies();
    // Nothing to swap to, so nothing is rebuilt — the check is that it does NOT
    // churn the roster on every frame while the file is still missing.
    updateRosterPreview(1 / 60);
    updateRosterPreview(1 / 60);
    check('...and with no model it rebuilds nothing, frame after frame',
      bodies().every((b, i) => b === was[i]), 'the roster was rebuilt with nothing to rebuild it from');
    // Read off the source: the harness can never load a GLB (see the note at
    // the top of this file), so the swap itself is not reachable from here.
    // What is checked is that the swap EXISTS and is gated on the model — a
    // preview that never asked again is exactly the bug.
    const fs3 = await import('node:fs');
    const vsrc = fs3.readFileSync(new URL('../path/src/systems/versus.js', import.meta.url), 'utf8');
    const fn = vsrc.slice(vsrc.indexOf('function rebuildLateBodies'), vsrc.indexOf('\n}', vsrc.indexOf('function rebuildLateBodies')));
    check('...but the swap is there, gated on the model landing',
      /isAssetLoaded\('ship'\)/.test(fn) && /buildRoster\(\)/.test(fn), fn.replace(/\s+/g, ' ').slice(0, 80));
    check('...and the preview ticks it every frame',
      /rebuildLateBodies\(\);/.test(vsrc.slice(vsrc.indexOf('export function updateRosterPreview'), vsrc.indexOf('export function resetVersus'))));
  }

  // AND IT COMES DOWN. Back out of the screen: no seals, no mouths.
  hideRosterPreview();
  check('taking it down empties the water', !rosterPreviewOn() && matchSeals().length === 1, `${matchSeals().length} bodies (the player alone)`);
  check('...and takes the mouths back out of the shore', !goalHolesInstalled());
  // Start hands the teardown to the match instead — resetArena runs
  // resetVersus, which disposes the roster, so doing it here as well is the
  // same work twice.
  showRosterPreview(scene);
  hideRosterPreview({ keep: true });
  check('Start leaves the bodies standing for the match to take down', matchSeals().length === 4, `${matchSeals().length} bodies`);
  check('...and the flag is down either way', !rosterPreviewOn());
  // ...AND THE MATCH OPENS BY BLENDING OUT OF THAT SHOT. The camera is already
  // standing on this pitch, so seeding the match's own framing as a CUT throws
  // away the one thing the screen was for.
  //
  // MEASURED OFF THE CALL updateVersusCamera MAKES, not off its own state: what
  // a shot IS is what it hands world.focusCamera, and a check against an
  // internal number would pass a version that had stopped handing it over.
  {
    const frame = { w: 52 * 16 / 9, h: 52 };
    const shot = { at: null };
    const stand = (at) => ({
      camera: fakeCam(frame, at),
      focusCamera: (pos, zoom) => { shot.at = { x: pos.x, y: pos.y, zoom }; },
    });
    // The pitch handed over, and the camera a long way off the kickoff framing.
    hideRosterPreview({ keep: true });
    startVersus(scene);
    const goal = versusCameraGoal(frame, { x: 0, y: 0, zoom: 1 });
    const from = { x: goal.x + 40, y: goal.y + 18, zoom: Math.max(0.2, goal.zoom * 0.6) };
    updateVersusCamera(stand(from), 1 / 60);
    const after = Math.hypot(shot.at.x - goal.x, shot.at.y - goal.y);
    const span = Math.hypot(from.x - goal.x, from.y - goal.y);
    check('Start blends to the kickoff camera rather than cutting to it',
      after > 1, `${after.toFixed(1)} units short of the goal on the first frame`);
    check('...and is on its way there, not sitting still', after < span - 1e-6,
      `${after.toFixed(1)} of a ${span.toFixed(1)} unit move`);
    // EVERY OTHER WAY IN STILL CUTS. A rematch off the score card has the
    // camera wherever the celebration left it and nothing to open out of, and
    // the handover is a ONE-SHOT — a flag left on would blend that too.
    startVersus(scene);
    const goal2 = versusCameraGoal(frame, { x: 0, y: 0, zoom: 1 });
    updateVersusCamera(stand({ x: goal2.x + 40, y: goal2.y + 18, zoom: Math.max(0.2, goal2.zoom * 0.6) }), 1 / 60);
    check('...while a cold route still cuts', Math.hypot(shot.at.x - goal2.x, shot.at.y - goal2.y) < 1,
      `${Math.hypot(shot.at.x - goal2.x, shot.at.y - goal2.y).toFixed(2)} units off`);
    resetVersus();
  }
  resetVersus();
  setMatchRoster(before);
  resetPlayer();
  startVersus(scene);
  toPlay();
}

// ---------------------------------------------------------------------------
// FOUR IDENTICAL ANIMALS IN DARK WATER. The rim and the mark say which SIDE a
// seal is on; nothing said which one is WHICH, and nothing said which one you
// are driving — two different questions, and the second is the one you ask in
// a scramble.
// ---------------------------------------------------------------------------
section('Every seal carries its name, and yours carries a louder mark');
{
  const before = matchRoster();
  setMatchRoster(2);
  resetVersus(); resetPlayer(); startVersus(scene); toPlay();
  // THE MARK IS THE SAME UNDER EVERY SEAL, seat 0 included. It used to be
  // fatter and paler under yours — and drew straight over the strike ring that
  // is already under that seal, so the one seal with a live HUD was the one
  // whose HUD you could not read.
  const marks = seatMarkers();
  check('there is a mark under every seat', marks.length === 4, `${marks.length}`);
  // ...AND IT IS DRAWN ONLY UNDER A SEAL SOMEBODY IS IN. A bot has nobody
  // looking for it in a scramble, and four identical circles are the same as
  // none; its side is on its rim instead, which is the whole of a CPU seal's
  // UI now. Seats 2 and 3 are nobody's — the team select fills in the two
  // captains and no more — so this roster is two people and two bots.
  {
    const wasP2 = versusSetup.teams[1].members[0];
    versusSetup.teams[1].members[0] = { kind: 'human', pad: 1 };
    startVersus(scene); toPlay();
    let shown = seatMarkers().map((m, i) => (m.visible ? i : -1)).filter((i) => i >= 0);
    check('...under the two people playing, and not under the bots', shown.join(',') === '0,1',
      `marks under seats ${shown.join(',') || 'none'}`);
    // AND THE CAPTAIN'S GOES TOO when that side is the computer's — the same
    // question asked of every seat, not a rule about the seats past the pair.
    versusSetup.teams[1].members[0] = { kind: 'cpu', pad: null };
    startVersus(scene); toPlay();
    shown = seatMarkers().map((m, i) => (m.visible ? i : -1)).filter((i) => i >= 0);
    check('...and a computer captain has no mark either', shown.join(',') === '0',
      `marks under seats ${shown.join(',') || 'none'}`);
    versusSetup.teams[1].members[0] = wasP2;
    startVersus(scene); toPlay();
  }
  {
    const band = (r) => r.geometry.parameters.outerRadius - r.geometry.parameters.innerRadius;
    check('...and nothing is drawn fatter over the HUD under yours',
      marks.every((r) => Math.abs(band(r) - band(marks[1])) < 1e-6)
      && marks.every((r) => r.material.opacity === marks[1].material.opacity),
      marks.map((r) => band(r).toFixed(2)).join(' '));
    check('...each in its own side\'s colour and nothing else',
      marks.every((r, i) => nearestTeam(r.material.color.getHex()) === teamOfSeat(i))
      && marks[0].material.color.getHex() === marks[2].material.color.getHex(),
      marks.map((r) => '#' + r.material.color.getHexString()).join(' '));
  }
  // WHICH ONE IS YOURS IS SAID ON THE ANIMAL — a hotter rim, which is on the
  // body and therefore cannot cover anything. Multipliers over the run's own
  // outline rather than a second description of what a rim is.
  {
    const you = V.you ?? {};
    const base = CONFIG.playerOutline ?? {};
    check('the boost is a multiple of the run\'s own rim, not a replacement for it',
      (you.glow ?? 0) > 1 && (you.thickness ?? 0) > 1, `glow x${you.glow}, thickness x${you.thickness}`);
    const shells = [];
    player.body?.traverse((o) => { if (o.userData?.__isOutline && o.material?.color) shells.push(o.material); });
    check('...and player 1 is actually wearing it', shells.length > 0
      && shells.some((m) => Math.max(m.color.r, m.color.g, m.color.b) > (base.glow ?? 2) * 0.9),
      shells.length ? `peak channel ${Math.max(...shells.map((m) => Math.max(m.color.r, m.color.g, m.color.b))).toFixed(2)}` : 'no rim found');
  }
  // THE NAMES. Read off the source, for the reason the score strip's checks
  // are: this harness has no DOM (tools/dom-stub.mjs gives three.js's loaders a
  // document with no body, so mountUi no-ops and `ui` is null), and the tags
  // are DOM labels. What belongs here is the WIRING — that the label is moved
  // to where its animal is, that it is the cast's name and not one invented at
  // the tag, that a burst seal loses it, and that exactly one is marked yours.
  {
    const fs4 = await import('node:fs');
    const vsrc = fs4.readFileSync(new URL('../path/src/systems/versus.js', import.meta.url), 'utf8');
    const fn = vsrc.slice(vsrc.indexOf('export function updateNameTags'), vsrc.indexOf('\n}', vsrc.indexOf('export function updateNameTags')));
    const placed = /worldToScreen\(camera, p\.x, p\.y \+ lift/.test(fn);
    check('the tag is placed where its seal is', placed, placed ? '' : 'the label is not projected onto the animal');
    check('...through the camera the frame was DRAWN with, so a replay keeps them on its seals',
      /updateNameTags\(replayRenderCamera\(\) \?\? world\.camera\)/.test(
        fs4.readFileSync(new URL('../path/src/main.js', import.meta.url), 'utf8')));
    check('...saying the cast\'s name, not one invented here', /versusState\.names\[seat\]/.test(fn));
    check('...and a seal that burst loses it until it is back', /versusState\.dead\[seat\]/.test(fn));
    check('exactly one tag is marked as the seal you drive', /sv-versus-tag-you', seat === 0/.test(fn));
    // A LIFT IN WORLD UNITS, not pixels: the camera punches in and out by a
    // factor of four through a goal, and a fixed pixel gap would leave the
    // label floating further and further off a shrinking seal.
    check('...and it rides a world-space gap above the animal, not a pixel one',
      /const lift = c\.lift/.test(fn) && /p\.y \+ lift/.test(fn));
  }
  // WHAT A TAG SAYS. Four labels over four animals is a lot of type, so the
  // default is initials and the last name — short enough to read while the
  // ball is elsewhere, and still enough of the front of the name that two
  // seals sharing a last name read apart.
  {
    const was = V.nameTags.show;
    V.nameTags.show = 'short';
    check('a tag initials the front of the name', tagText('Phat Tony') === 'P. Tony', tagText('Phat Tony'));
    // POSITIONAL, not off the name table: "Carney Barker" is one nickname row,
    // so the C here is the front of a HALF. A split into adjective and
    // nickname cannot produce this answer.
    check('...initialling every word but the last, wherever the words came from',
      tagText('Phat Carney Barker') === 'P.C. Barker', tagText('Phat Carney Barker'));
    // ...EXCEPT the adjective, which is one idea and gets one letter however
    // many words the table spends on it. Counting words here reads
    // "T.O.A.O. Osbourne", which is a licence plate.
    check('...but a multi-word adjective collapses to a single initial',
      tagText('The One and Only Osbourne') === 'T. Osbourne', tagText('The One and Only Osbourne'));
    check('...and still initials the nickname behind it',
      tagText('The Honorable Carney Barker') === 'T.C. Barker', tagText('The Honorable Carney Barker'));
    // The one thing position gets wrong: the last word of a lineage, or of
    // "Clammy Davis Jr.", is not a name. Initialling what comes before it
    // would give "F.T. II".
    check('...carrying a lineage numeral along rather than initialling the name under it',
      tagText('Phat Tony II') === 'P. Tony II', tagText('Phat Tony II'));
    check('...and a written suffix with it',
      tagText('Clammy Davis Jr.') === 'C. Davis Jr.', tagText('Clammy Davis Jr.'));
    // "Xi" is a nickname row. A case-blind numeral test reads it as a lineage
    // and costs the name its initial.
    check('...but a nickname that only looks like a numeral keeps its initial',
      tagText('Phat Xi') === 'P. Xi', tagText('Phat Xi'));
    // One word has no front to abbreviate. Both the bare nickname and the
    // name you typed on the splash land here.
    check('...a single word comes back whole', tagText('Rumpshaker') === 'Rumpshaker', tagText('Rumpshaker'));
    check('...as does a bare nickname carrying a numeral',
      tagText('Rumpshaker II') === 'Rumpshaker II', tagText('Rumpshaker II'));
    check('...and an empty name stays empty rather than becoming something', tagText('') === '');
    // A typed name is abbreviated the same way as a rolled one — the tag is a
    // label on a seal, not a reading of the table.
    check('...and a name the table never built is initialled like any other',
      tagText('Bartholomew Fitzwilliamson') === 'B. Fitzwilliamson', tagText('Bartholomew Fitzwilliamson'));
    V.nameTags.show = 'full';
    check('the full option says all of it', tagText('Phat Tony') === 'Phat Tony', tagText('Phat Tony'));
    V.nameTags.show = was;
  }
  setMatchRoster(before);
  resetVersus(); resetPlayer(); startVersus(scene); toPlay();
}

// ---------------------------------------------------------------------------
section('A match shows no run HUD and no tutorial text');
{
  // Read off the source: the mode's stylesheet and main.js's gates are the
  // only places these live, and a silent revert of either is what this is for.
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../path/src/systems/versus.js', import.meta.url), 'utf8');
  const main = fs.readFileSync(new URL('../path/src/main.js', import.meta.url), 'utf8');
  const rule = src.match(/\.sv-versus-mode[^\n]*display: none/)?.[0] ?? '';
  check('the mode hides the xp strip, the corner and the player bars (health, air, fuel)', rule.includes('.sv-xptop') && rule.includes('#svCorner') && rule.includes('#svPlayerBars'), rule);
  // ...AND PUTS NOTHING BACK IN THEIR PLACE ON THE STRIP. This used to require
  // an `.sv-versus-o2` bar per side, which was the right answer while a match
  // was one seal against one seal. Those bars read seat 0 and seat 1 only, so
  // four a side turned each of them into one animal's lungs labelled as a
  // team's — and every seat a person drives already wears its own fuel ring
  // and air band on the animal (updateSeatRings). The strip is the match's
  // facts now: two scores and one clock.
  check('...and puts no per-side fuel or air bar back on the strip',
    !src.includes('sv-versus-o2') && !src.includes('sv-versus-meter'),
    'a duplicate of the ring is back in the corner');
  check('...while the seats still carry their own', src.includes('function updateSeatRings'));
  const tutAt = main.indexOf('updateTutorial(realDt');
  const tut = main.slice(tutAt, main.indexOf('WHATEVER THE TIP IS ABOUT', tutAt));
  const tutGate = tut.match(/\}, bandLive[^\n]*\);/)?.[0] ?? '';
  check('the tutorial is gated off in a match', tutGate.includes('!versusActive()'), tutGate || 'no gate found');
  const callouts = main.slice(main.indexOf('updateCallouts(realDt'), main.indexOf('updateGreeting(realDt'));
  check('...as the coach\'s band and the hello already are', callouts.includes('!versusActive()') && main.slice(main.indexOf('updateGreeting(realDt'), main.indexOf('updateGreeting(realDt') + 200).includes('!versusActive()'));

  // THE AIM BEAM IS NOT IN THE FOOTAGE. A replay poses both seals from the
  // tape, but input.aim keeps answering the cursor underneath, so a beam left
  // running is a live interface element drawn over a piece of film — and it is
  // the only thing in the shot that moves with the mouse. Read off the source
  // because this harness never runs main.js's frame loop.
  const aimAt = main.indexOf('updateAimIndicator(');
  const aimCall = main.slice(main.lastIndexOf('\n', main.indexOf('NOT OVER A REPLAY')), main.indexOf(');', aimAt) + 2);
  check('no aim beam over a replay', /replayHoldsInput\(\)/.test(aimCall), aimCall.replace(/\s+/g, ' ').slice(-120) || 'no gate found');
  // ...CUT, NOT FADED. The gate inside the indicator eases `alpha` toward its
  // target over aimIndicator.fade, and a replay opens on a hard camera cut, so
  // routing this through `running: false` would leave a tenth of a second of
  // beam dissolving over the first frames of the shot.
  check('...and it is cut rather than faded out, because the replay opens on a cut',
    /\)\s*\{\s*resetAimIndicator\(\);/.test(aimCall),
    aimCall.replace(/\s+/g, ' ').slice(-120));
  // ...NOR OVER A MATCH AT ALL, which is the same argument one step further
  // out: the beam is a readout of where the GUN points and a match has no gun
  // (autofire is off for the whole of one). What the aim still does here is
  // point the flippers and decide which way a fin flick wipes the ball, and
  // both of those are read off the animal. Its own flag rather than
  // `aimIndicator.enabled`, because that one is a look the player tunes for a
  // RUN and the saved snapshot has it on — see CONFIG.aimIndicator.inVersus.
  check('no aim beam over a match either',
    /versusActive\(\)\s*&&\s*!CONFIG\.aimIndicator\.inVersus/.test(aimCall),
    aimCall.replace(/\s+/g, ' ').slice(-160) || 'no gate found');
  check('...and the flag is off by default', CONFIG.aimIndicator.inVersus === false);

  // THE STRIP, THE CARD AND THE REPLAY — read off the source for the same
  // reason as the rules above: this harness has no DOM (tools/dom-stub.mjs
  // gives three.js's loaders a document with no `body`, so mountUi no-ops),
  // and every one of these three is a silent revert if it goes back.
  const goalFn = src.slice(src.indexOf('function goal(side) {'), src.indexOf('\n// ---', src.indexOf('function goal(side) {')));
  check('the score goes up on the frame the goal registers, not at the end of the shutter',
    /st\.scores\[scorer\] \+= 1;[\s\S]{0,900}?popScore\(scorer\)/.test(goalFn),
    goalFn.includes('popScore(scorer)') ? 'popScore is in goal()' : 'goal() never paints the strip');
  // ...and it does not go up TWICE. The old code popped the number at
  // `respawn`; leaving that in beside the new one is a second bounce a second
  // after the first, which reads as a second goal.
  const landFn = src.slice(src.indexOf('function landScore(scorer) {'), src.indexOf('\n}', src.indexOf('function landScore(scorer) {')));
  check('...and the ball coming back does not pop it a second time',
    !landFn.includes('sv-versus-pop'), landFn.replace(/\s+/g, ' ').slice(0, 90));
  // THE CARD PLAYS OVER THE REPLAY. It used to be taken down as the replay
  // opened and put back when it ended, which took the one thing naming the
  // scorer off the screen for the whole of the shot that shows them scoring.
  const startFn = src.slice(src.indexOf('rs.then = then;'), src.indexOf('function updateReplay'));
  check('the goal card is not taken down when the replay opens',
    !startFn.includes('hideCard()'), startFn.replace(/\s+/g, ' ').slice(0, 120));
  check('...and comes back at the end as a repaint rather than a second entrance',
    /showCard\(st\.scorer, st\.phase === 'won', false\)/.test(src));
  // A NAME IS ONE THING. It has a space in it and a space is where a line
  // breaks, so the card's name lines have to say so — and the card itself
  // needs a width, because at left: 50% with none it shrink-to-fits inside the
  // RIGHT HALF of the screen and a name wider than that wrapped.
  check('the card is laid out at its content\'s width, not the half screen left of it',
    /\.sv-versus-card \{[^}]*width: max-content/.test(src));
  check('...and neither the scorer\'s name nor the assist\'s may break across lines',
    /\.sv-versus-card-name \{[^}]*white-space: nowrap/.test(src) && /\.sv-versus-name \{[^}]*white-space: nowrap/.test(src));

  // ...AND IT GOES AT THE WHISTLE, before the stats page. The card used to be
  // lifted to 26% and left there, so the last goal's caption sat over the top
  // of the ledger for as long as the prompt was up. Two facts to hold: the
  // dismissal is IN showOver (the card cannot outlive the match's last
  // screen), and it is AHEAD of showStats in it — the order is what guarantees
  // no frame carries both, since the page cannot paint before an import that
  // has not been asked for yet.
  const overFn = src.slice(src.indexOf('function showOver() {'), src.indexOf('function hideOver() {'));
  check('the goal card is dismissed when the match-over screen comes up',
    overFn.includes('dismissCard()'), overFn.replace(/\s+/g, ' ').slice(0, 120));
  check('...before the stats page is asked for, not after it',
    overFn.indexOf('dismissCard()') >= 0 && overFn.indexOf('dismissCard()') < overFn.indexOf('showStats()'),
    `dismissCard at ${overFn.indexOf('dismissCard()')}, showStats at ${overFn.indexOf('showStats()')}`);
  // The rule that parked it up there — `.sv-versus-ending .sv-versus-card`,
  // top: 26% — and the class that switched it on. Both gone: the class had one
  // rule and nothing else ever read it, so leaving it would be a state flag on
  // the root that styles nothing and invites a rule back. Named here so
  // neither returns as a tidy-up that "restores" the card's old place.
  check('...and no rule moves the card over the page instead of taking it down',
    !src.includes('sv-versus-ending'));
  // THE FADE IS NOT PLAYED ON A CARD THAT IS NOT UP. A timed match ends on the
  // whistle with the card already down (showResultCard), and an animation from
  // `opacity: 1` on a hidden element fades it IN and holds it there — the one
  // match with no card to dismiss would grow one.
  const dismissFn = src.slice(src.indexOf('function dismissCard() {'), src.indexOf('\n}', src.indexOf('function dismissCard() {')));
  check('...and a card that is not on screen is cut, not animated out',
    /classList\.contains\('sv-versus-in'\)[\s\S]{0,60}hideCard\(\); return;/.test(dismissFn),
    dismissFn.replace(/\s+/g, ' ').slice(0, 140));
  // The exit's own curve, and the two numbers that have to agree: the sheet
  // runs the animation and JS times the hide off it, so a duration changed in
  // one place and not the other either cuts the fade off or leaves the card at
  // zero opacity holding the animation's fill.
  const outMs = Number(src.match(/const CARD_OUT_MS = (\d+);/)?.[1] ?? 0);
  const outCss = Number(src.match(/\.sv-versus-card\.sv-versus-out \{ animation: svVersusCardOut ([\d.]+)s/)?.[1] ?? 0);
  check('the exit animation and the timer that follows it are the same length',
    outMs > 0 && Math.abs(outMs / 1000 - outCss) < 1e-6, `CARD_OUT_MS ${outMs}ms, sheet ${outCss}s`);
  // THE SCORE STRIP GOES WITH IT. Both numbers and the clock are on the stats
  // page, so a strip left at the top is the same answer a second time, smaller,
  // over the top of the fuller one — and it is a readout for a match that is
  // still being played.
  check('the gameplay score strip is taken down for the stats page',
    overFn.includes("hud?.classList.add('sv-versus-hud-gone')"), overFn.replace(/\s+/g, ' ').slice(0, 160));
  check('...by a rule that only changes its opacity, so the layout under it does not move',
    /\.sv-versus-hud\.sv-versus-hud-gone \{ opacity: 0; \}/.test(src) &&
    /\.sv-versus-hud \{[^}]*transition: opacity/.test(src));
  // ...AND COMES BACK. The HUD is hidden between matches, not rebuilt, so a
  // class left on it is a strip that is missing for the rest of the session.
  const hideOverFn = src.slice(src.indexOf('function hideOver() {'), src.indexOf('function goal(side) {'));
  check('...and comes back on every way out of the end screen, not just the rematch',
    hideOverFn.includes("hud?.classList.remove('sv-versus-hud-gone')"), hideOverFn.replace(/\s+/g, ' ').slice(0, 160));
  // The four ways out, each read to its own closing brace rather than through a
  // fixed window — rematch() carries a dozen lines of comment before its call,
  // and a window short enough to miss it would fail a function that is correct.
  const bodyOf = (from) => {
    const at = src.indexOf(from);
    return at < 0 ? '' : src.slice(at, src.indexOf('\n}', at));
  };
  const ways = ['export function rematch()', 'function chooseOver(', 'function hideUi()', 'export function previewVersusUi'];
  const missed = ways.filter((w) => !bodyOf(w).includes('hideOver()'));
  check('...which is the one function the rematch, the menu, hideUi and the preview all go through',
    missed.length === 0, missed.join(', ') || `${ways.length} routes, all through hideOver`);
  // DOWN, NOT UP. Up is where the stats page arrives from.
  check('...and the card sinks out rather than climbing into the page',
    /@keyframes svVersusCardOut \{[^}]*\}[^}]*to \{ opacity: 0; transform: translate\(-50%, -3[0-9]%\)/.test(src),
    src.match(/@keyframes svVersusCardOut \{[\s\S]*?\n/)?.[0]?.trim()?.slice(0, 160) ?? 'no svVersusCardOut keyframes');
}

// ---------------------------------------------------------------------------
// THE TWO SHAPES A CONTACT IS MADE OF, against the things they claim to be:
// the ball's against its own drawing, the seal's against the shipped model.
// Both used to be numbers typed beside a picture nobody re-measured.
// ---------------------------------------------------------------------------
// The replay was a silent diagram: it posed the bodies and the ball's skin and
// re-fired nothing, so the one thing a player actually watches during a strike
// — the spray off the contact, the goo out of the ball, the breach at the
// water line — had happened live, seconds earlier, and was gone. And the goal
// light had already blazed and run out on the wall clock before the replay
// reached the goal.
// ---------------------------------------------------------------------------
section('The ball carries both colours, in the proportion each team owns it');
{
  toPlay();
  resetEnemies(scene);
  resetBall();
  resetBallLook();
  const L = V.ball.look;
  const dash = CONFIG.strike.dashSpeed ?? 46;
  const hit = (who, dir, power = 1) => {
    const pos = who === 0 ? player.mesh.position : p2.pos;
    const vel = who === 0 ? player.velocity : p2.vel;
    ball.rim.fill(0); ball.rimV.fill(0);
    pos.set(ball.x - dir * (ballReach() - 0.3), ball.y, 0);
    vel.set(dir * dash, 0);
    ball.dashHit[who] = false;
    if (who === 0) { strikeState.active = true; strikeState.power = power; strikeState.dashDir.x = dir; strikeState.dashDir.y = 0; }
    else { p2.active = true; p2.dashTimeLeft = 0.3; p2.power = power; p2.dashDir.x = dir; p2.dashDir.y = 0; }
    sealContact(who, pos, vel, true, who === 0 ? strikeState.dashDir : p2.dashDir, power);
    if (who === 0) strikeState.active = false; else p2.active = false;
  };
  // The ball's own module pushes this every frame in a match; here the section
  // drives updateBallLook by hand, so it has to hand over the same thing.
  const pushBody = () => setBallBody({ x: ball.x, y: ball.y, r: ballHitRadius(), speed: Math.hypot(ball.vx, ball.vy) });
  const settleLook = (secs) => { for (let i = 0; i < Math.round(secs * 60); i++) { pushBody(); updateBallLook(1 / 60); } };

  check('an untouched ball belongs to nobody', ballCredit().newest === -1 && ballCredit().share === 0);
  // ONE SEAL, ONE COLOUR. A shot into a still ball is entirely that seal's.
  ball.vx = 0; ball.vy = 0;
  hit(0, 1);
  const one = ballCredit();
  check('a strike into a still ball is wholly the striker\'s', one.newest === 0 && one.credit[0] > 10 && one.credit[1] === 0, `credit ${one.credit.map((c) => c.toFixed(1)).join(' / ')}`);
  // THE FIRST TOUCH FILLS IN. It used to FLIP: the hand-over re-read the share
  // from the incoming colour's end (`1 - share`), which is the right picture
  // between two teams and is `1 - 0` out of nobody — so the very first contact
  // of every match handed the striker the whole ball on the frame it landed
  // and the march never ran at all. Both halves of the bug are here: the share
  // on frame one, and what the untaken part of the body is wearing.
  settleLook(1 / 60);
  {
    const first = ballLookState();
    const tm0 = CONFIG.fx.goo.groups.ball.teams;
    check('...starting from nothing, not from the whole ball',
      first.share < 0.1, `share ${first.share.toFixed(3)} one frame after the touch`);
    check('...taking over the ball\'s OWN colour, not the other side\'s',
      tm0.a === starterColor() && tm0.a !== teamColor(1),
      `taking ${tm0.a.toString(16)} (starter ${starterColor().toString(16)}, team 1 ${teamColor(1).toString(16)})`);
  }
  settleLook(3);
  const solid = ballLookState();
  check('...and its colour takes the whole body', solid.share > 0.95, `share ${solid.share.toFixed(3)}`);
  check('...marching there rather than arriving — the share is lerped', L.shareRate > 0 && L.shareRate < 60, `shareRate ${L.shareRate}/s`);
  // TWO SEALS, TWO COLOURS. The other seal swims into its flank rather than
  // meeting it head on: the shot it was carrying is still most of where it is
  // going, and what P2 put in is the bend. Both own it, in that proportion.
  const p2At = { x: ball.x, y: ball.y - ballContactReach(-Math.PI / 2) + 0.4 };
  p2.pos.set(p2At.x, p2At.y, 0);
  p2.vel.set(0, 26);
  sealContact(1, p2.pos, p2.vel, false, null, 0);
  settleLook(3);
  const two = ballCredit();
  const both = two.credit[0] > 0.5 && two.credit[1] > 0.5;
  check('a ball bent by the other seal is owned by both', both, `credit ${two.credit.map((c) => c.toFixed(1)).join(' / ')}`);
  check('...with the bend the smaller share of it, because that is what it added',
    two.newest === 1 && ballLookState().share > 0.02 && ballLookState().share < 0.5,
    `share ${ballLookState().share.toFixed(3)} to team ${two.newest}`);
  // ...AND A HEAD-ON TURNAROUND HANDS THE WHOLE THING OVER, because none of
  // the momentum it was carrying survives the reversal. This is the case the
  // ledger has to get right or a counter-strike reads as a shared ball.
  ball.vx = 60; ball.vy = 0;
  hit(1, -1, 1);
  settleLook(3);
  const back = ballCredit();
  check('a shot sent back the way it came belongs wholly to whoever turned it',
    back.newest === 1 && back.credit[0] < 0.5 && ballLookState().share > 0.95,
    `credit ${back.credit.map((c) => c.toFixed(1)).join(' / ')}, share ${ballLookState().share.toFixed(3)}`);
  // THE LEDGER IS ABOUT THE CURRENT VELOCITY, so it sums to the speed the ball
  // is actually travelling at rather than to everything that ever hit it.
  pushBody();
  updateBallLook(1 / 60);
  const total = ballCredit().credit[0] + ballCredit().credit[1];
  check('...and the two of them add up to the speed it is going at now',
    Math.abs(total - Math.hypot(ball.vx, ball.vy)) < 0.5,
    `${total.toFixed(1)} on the books vs ${Math.hypot(ball.vx, ball.vy).toFixed(1)} u/s`);
  // The field the shader reads: both colours, the seed, and a radius that is
  // the DRAWN ball rather than the collision circle it used to be.
  setBallBody({ x: ball.x, y: ball.y, r: ballHitRadius(), speed: Math.hypot(ball.vx, ball.vy) });
  updateBallLook(1 / 60);
  const tm = CONFIG.fx.goo.groups.ball.teams;
  check('the goo group is handed both team colours and where to seed them',
    tm && tm.a !== tm.b && tm.wr > ball.r && Number.isFinite(tm.seed),
    tm ? `a ${tm.a.toString(16)}, b ${tm.b.toString(16)}, r ${tm.wr.toFixed(1)}, seed ${tm.seed.toFixed(2)}` : 'no teams block');
  check('...as the boost meter\'s drop: lobes on a rolling ring that grow and fuse',
    (tm?.lobes ?? 0) >= 1 && (tm?.lobeSize ?? 0) > 0 && (tm?.wobble ?? -1) >= 0 && Number.isFinite(tm?.spin),
    `${tm?.lobes} lobes at ${tm?.lobeSize}x, thrown ${tm?.wobble}, ring rolling ${tm?.spin} rad/s`);
  // A ball nobody has touched hands the shader a radius of zero, which is the
  // switch back to the single tint every other goo group uses.
  resetBallLook();
  setBallBody({ x: 0, y: 0, r: 0, speed: 0 });
  updateBallLook(1 / 60);
  check('an unowned ball switches the two-colour field off outright', CONFIG.fx.goo.groups.ball.teams.wr === 0);
  // ...BUT IT STILL HAS A BODY. The frame the ball's own substance is drawn in
  // (the goo pass's mottle, systems/post.js) is a different fact from whose
  // ball it is: a ball has one from the kickoff and an owner only once
  // somebody has hit it. They were the same block, and the cost was a ball
  // whose interior was flat until the first contact — which also changes its
  // colour, so the two moved together and neither was visible on its own.
  setBallBody({ x: 3, y: -2, r: 5, speed: 0, spin: 4 });
  updateBallLook(1 / 60);
  {
    const bd = CONFIG.fx.goo.groups.ball.body;
    check('...while still handing over WHERE it is, which is not the same question',
      bd && bd.wr === 5 && bd.wx === 3 && bd.wy === -2 && CONFIG.fx.goo.groups.ball.teams.wr === 0,
      bd ? `body r ${bd.wr} at ${bd.wx},${bd.wy} with no owner` : 'no body block');
    // THE ROLL IS AN ANGLE, integrated here because this is the half of the
    // look that has a dt. A rate handed to the shader instead would turn the
    // mass by the same amount every frame and never get anywhere.
    const before = bd.roll;
    for (let i = 0; i < 30; i++) updateBallLook(1 / 60);
    check('...and integrates the spin into an angle for the body to turn through',
      bd.roll > before && Math.abs(bd.roll - (before + 4 * 0.5)) < 0.05,
      `${before.toFixed(3)} -> ${bd.roll.toFixed(3)} rad on 4 rad/s for half a second`);
    resetBallLook();
    check('...and both go dark when the ball leaves the pitch',
      CONFIG.fx.goo.groups.ball.body.wr === 0 && CONFIG.fx.goo.groups.ball.body.roll === 0);
  }
  strikeState.active = false; p2.active = false;
  player.mesh.position.set(-30, midWater(), 0); player.velocity.set(0, 0);
  p2.pos.set(30, midWater(), 0); p2.vel.set(0, 0);
  resetBall();
  resetBallLook();
  toPlay(20);
}

// ---------------------------------------------------------------------------
// Blubberball was two seals, and every rule was written as a pair. "Player 2"
// was a seat, a side, a colour and the far end of a collision all at once, and
// those are four things that only look like one number while there are two of
// them. This is the roster the pair became.
// ---------------------------------------------------------------------------
section('A roster, not a pair: teammates and opponents under the same rules');
{
  const before = matchRoster();
  // TWO A SIDE: the human, a CPU teammate, and two CPU opponents.
  check('the roster is a live control, not a constant', setMatchRoster(2) === 2, `${matchRoster()} a side`);
  resetVersus();
  resetPlayer();
  startVersus(scene);
  toPlay();
  // A PICK SURVIVES THE MATCH STARTING. startVersus opens on the roster, and
  // "open on the default" undid the team select's row on the way in — the row
  // moved, the number on it moved, and the match was a 1v1 anyway.
  check('the roster the team select picked is the one the match opens on', matchRoster() === 2, `${matchRoster()} a side after startVersus`);
  const seals = matchSeals();
  check('four seals are in the water', seals.length === 4, `${seals.length} bodies`);
  check('...and every one of them has a body of its own', seals.every((s2) => s2.mesh && s2.mesh !== seals[0].mesh || s2 === seals[0]));
  // SIDES ALTERNATE, so the first two seats are still the two captains and a
  // 1v1 is this match with two seats empty rather than a different mode.
  const teams = seals.map((s2) => teamOfSeat(seatOf(s2)));
  check('sides alternate, so seats 0 and 1 are still the two captains', teams.join(',') === '0,1,0,1', teams.join(','));
  check('...which puts two on each side', teams.filter((t) => t === 0).length === 2 && teams.filter((t) => t === 1).length === 2);
  check('the human is seat 0 and nothing else is', !seals.some((s2, i) => i > 0 && seatOf(s2) === 0));
  check('every seat past the human is the computer\'s, since nobody sat in it',
    [1, 2, 3].every((i) => seatIsCpu(i)) && !seatIsCpu(0));

  // THEY START AS A FORMATION, not a queue: a side's captain on its own line
  // and the rest bracketed off the middle of the water.
  const spots = [0, 1, 2, 3].map((i) => ({ ...kickoffSpot(i, { x: 0, y: 0 }) }));
  // ...AND EVERY SEAL IS ACTUALLY ON ONE. Player 1 used to be put at
  // `spawnSide` of the half-width — a second, different description of where a
  // seal starts — so the seal holding the frame was the one seal on the pitch
  // not standing in the formation.
  {
    const off = [0, 1, 2, 3].map((i) => Math.hypot(sealPos(sealAt(i)).x - spots[i].x, sealPos(sealAt(i)).y - spots[i].y));
    check('every seal is standing on its own kickoff spot, the player included',
      off.every((d) => d < 1e-6), off.map((d) => d.toFixed(2)).join(' '));
  }
  // FACING THE BALL. Every seal used to be turned to a flat quarter-turn —
  // straight across the pitch — which is right for the two seats on the centre
  // lane and wrong for every other spot in a formation. And seat 0 was skipped
  // outright, so the player faced wherever it happened to be pointing.
  {
    let worst = 0;
    let worstSeat = -1;
    for (let i = 0; i < 4; i++) {
      const p = sealPos(sealAt(i));
      // The art's forward is +Y, so the heading is rotation.z + a quarter turn.
      const facing = sealAt(i).mesh.rotation.z + Math.PI / 2;
      const want = Math.atan2(midWater() - p.y, 0 - p.x);
      let d = Math.abs(((facing - want + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI);
      if (d > worst) { worst = d; worstSeat = i; }
    }
    check('...and every one of them is looking at the ball', worst < 1e-6,
      `worst ${(worst * 180 / Math.PI).toFixed(1)}\u00b0 off, at seat ${worstSeat}`);
    // The off-lane seats are the ones this is ABOUT: if they all happened to be
    // on the centre line the check above would pass on the old flat rule too.
    const offLane = [0, 1, 2, 3].filter((i) => Math.abs(spots[i].y - midWater()) > 1e-3);
    check('...which is a different angle from straight across, for the seats off the lane',
      offLane.length > 0 && offLane.every((i) => Math.abs(Math.abs(sealAt(i).mesh.rotation.z) - Math.PI / 2) > 1e-3),
      `${offLane.length} seats off the centre lane`);
  }
  // THE FORMATION ROTATES, kickoff by kickoff, the way a kickoff rotates in
  // Rocket League. Without it the same seal is the striker at every kickoff of
  // the match and the rest are permanently its escort.
  {
    // WITH THE SCATTER HELD STILL. kickoffScatter moves the whole formation
    // every kickoff, so a spot compared raw would differ between two turns
    // whether or not the rotation did anything — the check would pass on a
    // rotation that had been deleted. Zeroed here so what moves is the
    // rotation and only the rotation, and put back below: the scatter has its
    // own section, and the two are different claims about the same spot.
    const sc = CONFIG.versus.kickoff.scatter;
    const wasAngle = sc.angle; const wasDistance = sc.distance;
    sc.angle = 0; sc.distance = 0;
    const seen = [new Set(), new Set()];
    const first = [0, 1].map((i) => { const p = kickoffSpot(i, { x: 0, y: 0 }); return `${p.x.toFixed(3)},${p.y.toFixed(3)}`; });
    const perSide = matchRoster();
    for (let k = 0; k < perSide; k++) {
      enterKickoff();
      for (const i of [0, 1]) {
        const p = kickoffSpot(i, { x: 0, y: 0 });
        seen[i].add(`${p.x.toFixed(3)},${p.y.toFixed(3)}`);
      }
    }
    check('a seat takes a different spot at the next kickoff',
      seen[0].size === perSide && seen[1].size === perSide,
      `seat 0 visited ${seen[0].size} of ${perSide} spots, seat 1 ${seen[1].size}`);
    // ...AND COMES BACK ROUND. A rotation that drifted — an index that grew
    // without wrapping into the side's own count — would pass the check above
    // and put a seal somewhere nobody authored. Sampled right here, with no
    // further kickoff: the loop above has already turned the formation a full
    // `perSide` times, so this IS the wrap.
    const back = [0, 1].map((i) => { const p = kickoffSpot(i, { x: 0, y: 0 }); return `${p.x.toFixed(3)},${p.y.toFixed(3)}`; });
    check('...and comes back to where it started after a full turn',
      back[0] === first[0] && back[1] === first[1], `${back[0]} vs ${first[0]}`);
    sc.angle = wasAngle; sc.distance = wasDistance;
    // Two sides never stand on top of each other, whatever the rotation — and
    // the scatter is LIVE for this one, because a shifted formation is exactly
    // when two seals might be put on the same mark.
    for (let k = 0; k < perSide; k++) {
      enterKickoff();
      const all = [0, 1, 2, 3].map((i) => kickoffSpot(i, { x: 0, y: 0 })).map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`);
      if (new Set(all).size !== 4) { check(`no two seals share a spot at kickoff ${k}`, false, all.join(' ')); break; }
      if (k === perSide - 1) check('no two seals ever share a spot, at any rotation', true, `${perSide} rotations checked`);
    }
  }
  check('each side starts in its own half', spots[0].x < 0 && spots[2].x < 0 && spots[1].x > 0 && spots[3].x > 0,
    spots.map((p) => p.x.toFixed(0)).join(' '));
  check('...and no two seals start on the same spot',
    new Set(spots.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`)).size === 4,
    spots.map((p) => `(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(' '));

  // EVERY SEAL PLAYS THE BALL, under the one contact path. The whole point of
  // "same rules for everything" is that this is a loop and not four branches.
  resetBall();
  ball.vx = 0; ball.vy = 0;
  let touched = 0;
  for (let i = 0; i < 4; i++) {
    const seal = sealAt(i);
    resetBall();
    ball.vx = 0; ball.vy = 0;
    const at = { x: ball.x - ballReach() + 0.4, y: ball.y };
    if (sealContact(i, at, { x: 14, y: 0 }, false, null, 0, 0, 0)) touched++;
  }
  check('every seat can play the ball, through the one contact path', touched === 4, `${touched} of 4`);

  // EVERY SEAT WEARS WHAT THE TEAM SELECT DRESSED IT IN — nothing put a hat on
  // any seal but the player's until this, so a roster the player had just spent
  // a minute dressing turned up bare.
  //
  // READ OFF THE SOURCE, and not because it is easier: this harness's seal has
  // no rig (createVisual hands back the stand-in primitive with no bones — the
  // "[jaw] biteRig names bone mouth_08, which this model doesn't have" warnings
  // above are the same fact), so there is no head_07 here for a hat to hang
  // off and an attach check would fail on the model rather than on the code.
  // The attach itself is measured against the real GLB in
  // tools/accessory-test.mjs; what belongs here is the WIRING.
  {
    const fs2 = await import('node:fs');
    const vsrc = fs2.readFileSync(new URL('../path/src/systems/versus.js', import.meta.url), 'utf8');
    const seatFn = vsrc.slice(vsrc.indexOf('function buildSeat('), vsrc.indexOf('// One dressing handle per seat'));
    const dresses = /wearSeat\(seal, seat\)/.test(seatFn);
    check('building a seat dresses it', dresses, dresses ? '' : 'buildSeat never asks for the hat');
    const wear = vsrc.slice(vsrc.indexOf('function wearSeat('), vsrc.indexOf('\n}', vsrc.indexOf('function wearSeat(')));
    check('...in ITS OWN accessory, not the one slot on CONFIG',
      wear.includes('seatAccessory(i)') && /dressBody\(seal\.body, key\)/.test(wear),
      wear.replace(/\s+/g, ' ').slice(0, 100));
    check('...taking off whatever was there first, so a change is a swap and not a stack',
      /was\.remove\(\)/.test(wear));
    // Seat 0 is the run's own hat, placed every frame by main.js — a second one
    // hung off the same bone by the roster would be two hats on one head.
    check('...and the player is left to the run\'s own hat', /if \(!\(i > 0\)\) return wornAccessory\(\);/.test(
      fs2.readFileSync(new URL('../path/src/systems/rosterCast.js', import.meta.url), 'utf8')));
    // A hat placed before its model landed is the stand-in for good, since a
    // one-off placement has nothing that would ever ask again.
    check('...and a hat that arrived as a stand-in is swapped when the model lands',
      /redressLate\(\);/.test(vsrc.slice(vsrc.indexOf('export function updateVersus'), vsrc.indexOf('function pitchView'))));
    check('...and a match handed back takes every hat off with it',
      /undressRoster\(\);/.test(vsrc.slice(vsrc.indexOf('function disposeRoster'), vsrc.indexOf('function buildBall'))));
  }

  // TEAMMATES COLLIDE. Two seals on the same side cannot stand inside each
  // other, and a dash into one shoves it — there is no friendly-fire switch,
  // because a crowd in front of a goal only reads as a crowd if being in one
  // is dangerous.
  const mate = sealAt(2);
  const me = sealAt(0);
  check('seats 0 and 2 are teammates', sameTeam(0, 2));
  me.mesh.position.set(0, midWater(), 0);
  me.velocity.set(0, 0);
  sealPos(mate).set(0.5, midWater(), 0);
  mate.velocity.set(0, 0);
  const gap0 = Math.abs(sealPos(mate).x - me.mesh.position.x);
  sealCollide(false);
  const gap1 = Math.abs(sealPos(mate).x - me.mesh.position.x);
  check('...and they are pushed apart rather than standing inside each other', gap1 > gap0 + 0.5, `${gap0.toFixed(2)} → ${gap1.toFixed(2)} apart`);
  // ...and a dash into a teammate lands the same shove an opponent's does.
  me.mesh.position.set(0, midWater(), 0);
  sealPos(mate).set(2.0, midWater(), 0);
  me.velocity.set(30, 0);
  mate.velocity.set(0, 0);
  strikeState.active = true; strikeState.power = 1;
  versusState.checked.fill(false);
  versusState.lastCheck = null;
  bodyCheck();
  strikeState.active = false;
  check('a dash into a TEAMMATE lands, exactly as one into an opponent does',
    !!versusState.lastCheck && versusState.lastCheck.push > 0,
    versusState.lastCheck ? `shove ${versusState.lastCheck.push.toFixed(1)}` : 'nothing landed');

  // EACH SEAL WEARS ITS SIDE. Four identical animals in a dark frame is four
  // identical animals; the rim is what says which of them is yours before you
  // have worked out which of them is yours.
  const colors = goalColors();
  const rims = [0, 1, 2, 3].map((i) => {
    const body = sealAt(i)?.body;
    const found = [];
    body?.traverse((o) => { if (o.userData?.__isOutline && o.material?.color) found.push(o.material.color.getHex()); });
    return found;
  });
  check('every seal is outlined', rims.every((r) => r.length > 0), rims.map((r) => r.length).join(','));
  // The shells carry colour x glow, so the TEST is which team's colour it is
  // nearest — not an equality against a hex the glow has already scaled.
  const nearest = (hex) => {
    const c = new THREE.Color(hex);
    let best = -1; let bestD = Infinity;
    colors.forEach((tc, t) => {
      const q = new THREE.Color(tc);
      const d = (c.r / Math.max(c.r + c.g + c.b, 1e-6) - q.r / Math.max(q.r + q.g + q.b, 1e-6)) ** 2
        + (c.g / Math.max(c.r + c.g + c.b, 1e-6) - q.g / Math.max(q.r + q.g + q.b, 1e-6)) ** 2;
      if (d < bestD) { bestD = d; best = t; }
    });
    return best;
  };
  const sides = rims.map((r) => nearest(r[0]));
  check('...in its own side\'s colour, not the run\'s white rim',
    sides.every((t, i) => t === teamOfSeat(i)), `seats read as teams ${sides.join(',')}`);

  // ...AND EACH IS ITS OWN ANIMAL. A GLB clone shares its template's material,
  // so without a per-body cut of the noise field the roster is one seal drawn
  // four times, freckle for freckle.
  const seeds = [0, 1, 2, 3].map((i) => {
    let v = null;
    sealAt(i)?.body?.traverse((o) => {
      if (v || !o.isMesh || o.userData?.__isOutline) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      v = m?.userData?.__noiseUniforms?.uNoiseSeed?.value ?? null;
    });
    return v;
  });
  check('every seal has its own material, not the template\'s',
    new Set(seeds).size === 4 && seeds.every(Boolean), `${new Set(seeds).size} distinct`);
  check('...cut from a different piece of the mottling',
    new Set(seeds.map((v) => `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`)).size === 4,
    seeds.map((v) => `${v.x.toFixed(1)},${v.y.toFixed(1)}`).join(' | '));
  // A CLONE DROPS onBeforeCompile — silently, with userData still claiming the
  // shader is attached — so this is the check that the hide is still SHADED
  // rather than merely instanced.
  const shaded = [0, 1, 2, 3].every((i) => {
    let ok = false;
    sealAt(i)?.body?.traverse((o) => {
      if (!o.isMesh || o.userData?.__isOutline) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (typeof m?.onBeforeCompile === 'function') ok = true;
    });
    return ok;
  });
  check('...and every one of them still has its shader injected', shaded);

  // Back to a pair, so everything after this section is the match it was.
  setMatchRoster(before);
  resetVersus();
  resetPlayer();
  startVersus(scene);
  toPlay();
  check('and it goes back to a pair on request', matchSeals().length === 2, `${matchSeals().length} bodies`);
}

// ---------------------------------------------------------------------------
// NOBODY OPENS TWO KICKOFFS ON THE SAME MARK — and neither side is ever handed
// a better one than the other. A 1v1 has ONE formation spot per side, so the
// rotation above is the identity for it and the two seals used to start every
// kickoff of the match on exactly the same two marks.
//
// Everything here is swept over seeds rather than asserted on the roll this
// match happened to make: a single roll can look symmetric by luck, and the
// claim is about the construction.
// ---------------------------------------------------------------------------
section('Where the two sides stand is rolled, and rolled the same for both');
{
  const KO2 = CONFIG.versus.kickoff;
  const SEEDS = 200;
  const TURNS = 12;

  for (const perSide of [1, 2, 3, 4]) {
    setMatchRoster(perSide);
    const seats = perSide * 2;
    let mirror = 0;          // the worst a pair of opposite seats disagreed
    let shared = 0;          // two seals on one mark
    let wrongHalf = 0;
    let outside = 0;
    let closest = Infinity;  // ...any seat ever got to the halfway line
    const marks = new Set();

    for (let seed = 0; seed < SEEDS; seed++) {
      versusState.kickoffSeed = (seed * 2654435761) >>> 0;
      for (let t = 0; t < TURNS; t++) {
        const p = [];
        for (let i = 0; i < seats; i++) p.push({ ...kickoffSpot(i, { x: 0, y: 0 }, t) });
        if (new Set(p.map((q) => `${q.x.toFixed(3)},${q.y.toFixed(3)}`)).size !== seats) shared++;
        for (let i = 0; i < seats; i++) {
          const q = p[i];
          // Seats alternate: even is the left side, odd is the right.
          if (i % 2 === 0 ? q.x >= 0 : q.x <= 0) wrongHalf++;
          if (q.y < bounds.bottom + 4 - 1e-9 || q.y > bounds.surfaceY - 4 + 1e-9) outside++;
          if (q.x <= bounds.left || q.x >= bounds.right) outside++;
          closest = Math.min(closest, Math.abs(q.x));
        }
        // A SEAT AND ITS OPPOSITE NUMBER: same distance out, same height.
        for (let i = 0; i < seats; i += 2) {
          mirror = Math.max(mirror, Math.abs(p[i].x + p[i + 1].x), Math.abs(p[i].y - p[i + 1].y));
        }
        marks.add(`${p[0].x.toFixed(2)},${p[0].y.toFixed(2)}`);
      }
    }

    const samples = SEEDS * TURNS;
    // EXACTLY MIRRORED, not nearly. One roll is made and both sides are placed
    // from it in their own frame, so this is 0 and not "small" — a tolerance
    // here would hide the two-branch arrangement this replaced, where each
    // side was its own sum and the two could drift apart.
    check(`${perSide}v${perSide}: the two sides are exact mirrors of each other`, mirror === 0, mirror.toExponential(2));
    check('...with nobody in the wrong half', wrongHalf === 0, `${wrongHalf} of ${samples * seats}`);
    check('...nobody outside the water', outside === 0, `${outside} of ${samples * seats}`);
    check('...and no two seals on one mark', shared === 0, `${shared} of ${samples}`);
    // HOW FAR BACK THE FORWARD-MOST SEAL STANDS, against the same seal's
    // standoff with the scatter off. Measured ACROSS the pitch and not as a
    // distance from the ball, because those are two different claims and only
    // this one is a promise: a seal swung onto the centre lane is nearer the
    // ball than it was — it gave up its lane offset for it — and that is the
    // scatter working rather than a seal stealing a march.
    //
    // `distance` is taken off the FRONT seat (see kickoffScatter), so a full
    // roster's striker cannot be walked up to the halfway line: a share of the
    // ANCHOR's standoff would have been most of the striker's.
    {
      const was = [KO2.scatter.angle, KO2.scatter.distance];
      KO2.scatter.angle = 0; KO2.scatter.distance = 0;
      let flat = Infinity;
      for (let i = 0; i < seats; i++) flat = Math.min(flat, Math.abs(kickoffSpot(i, { x: 0, y: 0 }, 0).x));
      [KO2.scatter.angle, KO2.scatter.distance] = was;
      const floor = flat * (1 - KO2.scatter.distance);
      check('...and the front seal is never walked closer in than `distance` allows',
        closest >= floor - 1e-6, `closest ${closest.toFixed(2)}, floor ${floor.toFixed(2)} (flat ${flat.toFixed(2)})`);
    }
    // ...AND IT ACTUALLY MOVES. The whole point at 1v1, where the rotation is
    // the identity and this is the only thing that varies the kickoff.
    check('...and the spots are different ones, kickoff to kickoff', marks.size > samples * 0.5,
      `${marks.size} distinct marks in ${samples} kickoffs`);
  }

  setMatchRoster(1);
  versusState.kickoffSeed = 0x1234abcd;
  // PURE IN ITS ARGUMENTS. kickoffSpot is asked several times per kickoff — as
  // the roster is built, as everyone is placed, by the bots and by the labs —
  // and a Math.random() inside it would hand each of them a different mark for
  // the same seal. Which is a bug that shows up as a seal standing somewhere
  // nothing else agrees it is, on some frames, at some kickoffs.
  {
    const a = kickoffSpot(0, { x: 0, y: 0 }, 5);
    const b = kickoffSpot(0, { x: 0, y: 0 }, 5);
    const c = kickoffSpot(0, { x: 0, y: 0 }, 5);
    check('asking twice for the same kickoff gives the same mark',
      a.x === b.x && a.y === b.y && b.x === c.x && b.y === c.y, `${a.x.toFixed(3)} ${b.x.toFixed(3)} ${c.x.toFixed(3)}`);
    const other = kickoffSpot(0, { x: 0, y: 0 }, 6);
    check('...and the next kickoff is somewhere else', other.x !== a.x || other.y !== a.y,
      `${a.x.toFixed(2)},${a.y.toFixed(2)} then ${other.x.toFixed(2)},${other.y.toFixed(2)}`);
  }
  // A MATCH IS REPLAYABLE. The seed is the only thing between two identical
  // matches, which is what makes the harness above able to sweep at all.
  {
    versusState.kickoffSeed = 99;
    const a = kickoffSpot(0, { x: 0, y: 0 }, 3);
    versusState.kickoffSeed = 100;
    const b = kickoffSpot(0, { x: 0, y: 0 }, 3);
    versusState.kickoffSeed = 99;
    const c = kickoffSpot(0, { x: 0, y: 0 }, 3);
    check('the same seed replays the same kickoff', a.x === c.x && a.y === c.y);
    check('...and a different one does not', a.x !== b.x || a.y !== b.y);
  }
  // OFF IS OFF. Both dials at zero is the kickoff exactly as it was before any
  // of this — the anchor at `inset`, on the centre lane.
  {
    const was = [KO2.scatter.angle, KO2.scatter.distance];
    KO2.scatter.angle = 0; KO2.scatter.distance = 0;
    const p0 = kickoffSpot(0, { x: 0, y: 0 }, 7);
    const p1 = kickoffSpot(1, { x: 0, y: 0 }, 7);
    check('with both dials at zero the kickoff is the one it always was',
      Math.abs(p0.x - (bounds.left + KO2.inset * bounds.width)) < 1e-9 && p0.y === midWater() &&
      Math.abs(p1.x - (bounds.right - KO2.inset * bounds.width)) < 1e-9 && p1.y === midWater(),
      `${p0.x.toFixed(3)},${p0.y.toFixed(3)} | ${p1.x.toFixed(3)},${p1.y.toFixed(3)}`);
    [KO2.scatter.angle, KO2.scatter.distance] = was;
  }
  setMatchRoster(1);
}

// ---------------------------------------------------------------------------
section('The goal grows with the roster');
{
  const before = matchRoster();
  const base = CONFIG.versus.goal.halfHeight;
  const widest = CONFIG.versus.goal.roster?.widest ?? 1.35;

  setMatchRoster(1);
  const oneASide = mouthHalfHeight();
  check('a 1v1 is played at the authored mouth, exactly as it always was',
    Math.abs(oneASide - base) < 1e-9, `${oneASide.toFixed(2)} against an authored ${base}`);

  const heights = [];
  for (let n = 1; n <= ROSTER_MAX; n++) { setMatchRoster(n); heights.push(mouthHalfHeight()); }
  // ...UNTIL THE WALL STOPS IT, which is the same clamp the next check blesses
  // in as many words. `widest` is 1.8 now, so the ramp asks for 22.5 against an
  // arena that allows 16.10 and saturates two seats early — the strict version
  // of this was true only while `widest` was low enough to fit, and it went red
  // for a tuning change while its own neighbour was asserting the clamp.
  //
  // So: every seat opens it further right up to the cap, and no seat ever
  // narrows it. That still fails a ramp pointing the wrong way, or one that
  // stalls before the wall is anywhere near.
  const cap = maxHalfHeight();
  const grew = heights.every((h2, i) => i === 0
    || h2 > heights[i - 1] + 1e-6
    || Math.abs(heights[i - 1] - cap) < 1e-6);
  check('...and every seat added opens it further, until the wall stops it',
    grew && heights.every((h2, i) => i === 0 || h2 >= heights[i - 1] - 1e-9),
    `${heights.map((h2) => h2.toFixed(2)).join(' → ')} against a ${cap.toFixed(2)} wall`);
  check(`${ROSTER_MAX} a side is the widest goal in the game`,
    heights[heights.length - 1] === Math.max(...heights), `${heights[heights.length - 1].toFixed(2)} half height`);

  // THE RAMP IS STRAIGHT-LINE and lands on what was asked for — unless the
  // wall stopped it, which is the clamp's job and is checked below.
  const want = base * widest;
  check('...at `widest` times the authored one, or whatever the wall allows',
    Math.abs(heights[heights.length - 1] - Math.min(want, maxHalfHeight())) < 1e-9,
    `${heights[heights.length - 1].toFixed(2)}, asked ${want.toFixed(2)}, cap ${maxHalfHeight().toFixed(2)}`);

  // THE LIPS SURVIVE. The band is centred on midwater and the wall runs out at
  // the surface above and the seabed below — a mouth that reached either is a
  // goal with no post on one side, which is the failure the clamp exists for.
  {
    setMatchRoster(ROSTER_MAX);
    const gy = midWater();
    const h2 = mouthHalfHeight();
    check('the widest mouth still leaves rock above it and below it',
      gy + h2 < bounds.surfaceY && gy - h2 > seabedTopY(),
      `top ${(gy + h2).toFixed(1)} under ${bounds.surfaceY}, bottom ${(gy - h2).toFixed(1)} over ${seabedTopY().toFixed(1)}`);
    // ...AND A TUNED-UP MOUTH IS CLAMPED RATHER THAN OPENED INTO THE SKY.
    const was = CONFIG.versus.goal.halfHeight;
    CONFIG.versus.goal.halfHeight = 40;
    const capped = mouthHalfHeight();
    check('...however tall the authored mouth is asked to be',
      Math.abs(capped - maxHalfHeight()) < 1e-9 && gy + capped < bounds.surfaceY,
      `${capped.toFixed(2)} against a cap of ${maxHalfHeight().toFixed(2)}`);
    CONFIG.versus.goal.halfHeight = was;
  }

  // ONE MOUTH, NOT TWO. systems/wallRocks.js carves the hole and cannot import
  // systems/versusGoal.js (that module reads the built shore out of it), so it
  // used to read `goal.halfHeight` itself. That was survivable while the mouth
  // was a constant; now that it is a formula, a second copy is a 4-a-side goal
  // drawn one size and played another — see the paired-reach failures this
  // file already carries. Both go through systems/goalBand.js, and this is the
  // check that says so.
  {
    const rocks = readFileSync(new URL('../path/src/systems/wallRocks.js', import.meta.url), 'utf8');
    const mouthFn = rocks.slice(rocks.indexOf('function goalMouth()'), rocks.indexOf('function goalQuad('));
    check('the carve asks goalBand for the mouth rather than reading config itself',
      /mouthHalfHeight\(\)/.test(mouthFn) && !/halfHeight\s*\?\?/.test(mouthFn),
      mouthFn.match(/const h = .*/)?.[0] ?? 'no h');
    check('...out of the same module versusGoal publishes it from',
      /from '\.\/goalBand\.js'/.test(rocks));
  }

  setMatchRoster(before);
  check('and the mouth goes back with the roster', Math.abs(mouthHalfHeight() - oneASide) < 1e-9, `${mouthHalfHeight().toFixed(2)}`);
}

// ---------------------------------------------------------------------------
section('Every player on the pitch is a body in the water');
{
  // The lattice bulges around a seal in it (systems/grid.js), and the only
  // body that counted was the one holding the frame — so on the one screen
  // with two seals on it, the other one swam through a flat grid. main.js
  // publishes a wake for each of these; this is the list it reads.
  toPlay();
  const seals = versusSeals();
  check('the match names its other players as bodies in the water', seals.length === 1, `${seals.length} besides player 1`);
  check('...at player 2\'s own position, not a stale copy of it',
    Math.abs(seals[0].x - p2.pos.x) < 1e-9 && Math.abs(seals[0].y - p2.pos.y) < 1e-9,
    `(${seals[0]?.x.toFixed(1)}, ${seals[0]?.y.toFixed(1)}) vs (${p2.pos.x.toFixed(1)}, ${p2.pos.y.toFixed(1)})`);
  check('...and player 1 is NOT in it — that one is the frame\'s own seal, slot 0',
    !seals.some((b) => b.who === 0));
  // A burst seal is out of the water until it respawns; a body left in the list
  // would hold its dent open at the spot it died.
  const wasDead = versusState.dead[1];
  versusState.dead[1] = 2;
  check('a burst seal stops denting the water', versusSeals().length === 0);
  versusState.dead[1] = wasDead;
  check('...and dents it again when it is back', versusSeals().length === 1);
  // Off-mode there is nobody but the player, so a run pays nothing for this.
  const wasActive = versusState.active;
  versusState.active = false;
  check('a run has no other players, and no slots are spent on them', versusSeals().length === 0);
  versusState.active = wasActive;
}

// ---------------------------------------------------------------------------
section('A goal is the scorer\'s colour — the ball, the blow and the jet');
{
  const R = V.replay;
  const wasReplay = R.enabled;
  R.enabled = false;   // the live path: no replay holding the jet back
  toPlay();
  resetEnemies(scene);
  resetBall();
  resetBallLook();
  fired.clear();
  const jets0 = goalJetState.fired;
  // The goal's own blow is a plain feedback() call rather than one of the
  // ball's impacts, so versusState.lastImpact never sees it — the payload has
  // to be caught off the channel.
  let blow = null;
  const stopBlow = onFeedback((name, at) => { if (name === 'versusGoal') blow = { ...at }; });
  // Into the RIGHT goal, which is player 1's point.
  ball.x = bounds.right - 6; ball.y = midWater(); ball.vx = 70; ball.vy = 0;
  for (let i = 0; i < 240 && versusState.phase === 'play'; i++) frame();
  stopBlow();
  check('the goal is called', versusState.phase === 'scored' && versusState.scorer === 0, `phase ${versusState.phase}, scorer ${versusState.scorer}`);
  const scorer = versusState.scorer;
  // THE BALL FILLS WITH IT. The ball is dead and off the edge of the screen by
  // now, so nothing will credit it again — claimBall is what hands the books
  // over, and the share marches to a full takeover on its own clock.
  const claimed = ballCredit();
  check('the ball is handed wholly to the scorer as it goes in',
    claimed.newest === scorer && claimed.credit[scorer] > 0 && claimed.credit[scorer === 1 ? 0 : 1] === 0,
    `credit ${claimed.credit.map((c) => c.toFixed(1)).join(' / ')} to team ${claimed.newest}`);
  for (let i = 0; i < 120; i++) { setBallBody({ x: ball.x, y: ball.y, r: 5, speed: 0 }); updateBallLook(1 / 60); }
  check('...and fills with that colour outright, not part of the way',
    ballLookState().share > 0.95 && CONFIG.fx.goo.groups.ball.teams.b === V.teams[scorer].color,
    `share ${ballLookState().share.toFixed(3)}, colour ${CONFIG.fx.goo.groups.ball.teams.b.toString(16)}`);
  // THE BLOW OUT OF THE MOUTH takes it too — it used to come out in the ball's
  // own colour, which is the one moment the ball is most obviously owned.
  check('the goal\'s own blow is the scorer\'s colour, not the ball\'s',
    !!blow && blow.color === V.teams[scorer].color && blow.color !== ballTint().getHex(),
    `versusGoal in ${(blow?.color ?? 0).toString(16)} (team ${(V.teams[scorer].color).toString(16)}, ball ${ballTint().getHex().toString(16)})`);
  check('...and the jet out of the corridor fired with it', goalJetState.fired > jets0, `${goalJetState.fired - jets0} jet(s)`);
  R.enabled = wasReplay;
  resetBall();
  resetBallLook();
  toPlay(20);
}

// ---------------------------------------------------------------------------
section('The replay plays the effects back, not just the poses');
{
  const R = V.replay;
  R.enabled = true;
  R.onlyWinner = false;
  toPlay();
  resetEnemies(scene);
  // A shot into the right goal, with the contact and the flight both inside
  // the replay's lead, so the track has real events in it.
  resetBall();
  ball.x = bounds.right - 52; ball.y = midWater();
  // Three fish in the lane, so the shot leaves a trail of bursts behind it and
  // the track under test is a track rather than a single entry. Spaced twelve
  // apart, which at the speed a full strike leaves at is comfortably more than
  // the impact fx's own `fxGap` — closer together and the throttle collapses
  // the three of them into one burst, which is what it is for.
  for (let i = 0; i < 3; i++) spawnNamed(scene, 'fish', 0, { x: ball.x + 12 + i * 12, y: midWater() }, { docile: true });
  p2.pos.set(bounds.left + 10, midWater() - 15, 0); p2.vel.set(0, 0);
  player.mesh.position.set(ball.x - ballReach() - 14, ball.y, 0);
  player.velocity.set(0, 0);
  settle(R.lead + 0.5);
  player.mesh.position.set(ball.x - ballReach() + 0.4, ball.y, 0);
  player.velocity.set(40, 0);
  strikeState.active = true; strikeState.dashDir.x = 1; strikeState.dashDir.y = 0; strikeState.power = 1;
  ball.dashHit[0] = false;
  frame();
  strikeState.active = false;
  // Every event fired from here on, with the flag it carried — the listener
  // sees playbacks too, which is how a replayed effect can be told from a
  // live one at all.
  const seen = [];
  const stop = onFeedback((name, at) => seen.push({ name, replay: !!at?.replay }));
  let frames = 0;
  while (versusState.phase === 'play' && frames < 400) { frame(); frames++; }
  check('the ball goes in', versusState.phase === 'scored', `phase ${versusState.phase}`);
  const live = seen.length;
  check('the shot itself fired effects, live', live > 0 && seen.every((e) => !e.replay), `${live} event(s)`);
  // Into the replay.
  for (let i = 0; i < 200 && versusState.phase !== 'replay'; i++) frame();
  check('the replay opens', versusState.phase === 'replay', versusState.phase);
  // Fewer than the shot fired, and both differences are on purpose: the goal's
  // own frame belongs to explodeReplay, and CONFIG.versus.ball.fx.gap collapses
  // a run of impacts into one burst whether they are being recorded or not.
  check('...and the track it will play has the shot\'s own effects on it', replayState.events.length >= 2, `${replayState.events.length} event(s) recorded over the replayed span, of ${live} fired`);
  check('...in time order, and none of them the goal\'s own frame', replayState.events.every((e, i) => (i === 0 || e.t >= replayState.events[i - 1].t) && e.t < replayState.goalT));
  // THE MOUTH IS NOT LIT YET: the goal has not happened in the footage being
  // shown, so the light it blazed live is put back to its own team's colour.
  check('the goal light is handed back for the rewound footage', goalScoredMix(replayState.side) === 0, `mix ${goalScoredMix(replayState.side).toFixed(2)}`);
  const played = [];
  const stopPlay = onFeedback((name, at) => { if (at?.replay) played.push(name); });
  const wanted = replayState.events.length;
  let lit = 0;
  for (let i = 0; i < 900 && versusState.phase === 'replay'; i++) {
    frame();
    lit = Math.max(lit, goalScoredMix(replayState.side));
  }
  stop();
  stopPlay();
  check('every effect on the track is played back', played.length === wanted, `${played.length} of ${wanted}`);
  check('...once each, in the order they happened', played.length === wanted);
  check('...and marked as a playback, so nothing records it a second time', seen.filter((e) => e.replay).length === played.length);
  check('...and none of them shook the camera or stopped the clock', feedbackState.hitstop === 0, `hitstop ${feedbackState.hitstop}`);
  // ...and the mouth blazes when the replay says the ball went in.
  check('the goal light lights up again at the explosion beat', lit > 0.5, `peak mix ${lit.toFixed(2)}`);
  resetEnemies(scene);
  toPlay(20);
}

// ---------------------------------------------------------------------------
section('The hitbox IS the drawing, and the seal IS the animal');
{
  toPlay();
  resetBall();
  settle(0.5);
  const B = V.ball;
  const rest = ballRestRadius();

  // --- the ball: the solve and the splats renderBall writes are one thing ---
  // Sum the goo field at the solved edge and a hair inside it: the isoline
  // has to be exactly where the density crosses the group's own iso, or the
  // hitbox is agreeing with an arrangement the renderer is not drawing.
  const splats = ballSplats(ball, rimRadius, rimAngle);
  const iso = CONFIG.fx.goo.groups.ball.iso;
  // AT A SAMPLE, not at an interpolated angle: solveBallSurface answers
  // exactly on the rim's own directions and reads between them the way
  // rimRadiusAt does, so this asks it where it actually solved.
  const a0 = rimAngle(0);
  const edge0 = ballHitRadiusAt(a0);
  const onEdge = gooDensity(splats, edge0 * Math.cos(a0), edge0 * Math.sin(a0));
  const inside = gooDensity(splats, edge0 * 0.9 * Math.cos(a0), edge0 * 0.9 * Math.sin(a0));
  check('the drawn edge is where the goo pass puts its isoline', Math.abs(onEdge - iso) < iso * 0.02 && inside > iso, `density ${onEdge.toFixed(4)} at the edge vs iso ${iso}, ${inside.toFixed(3)} inside it`);
  check('...and it is a good deal wider than the soft body\'s own radius', rest > ball.r * 1.5, `${rest.toFixed(2)} drawn vs ${ball.r} rest radius`);

  // A dent moves the drawn edge, and the hitbox with it — one number, so it
  // cannot do one and not the other. This is what the old arrangement could
  // not do: a centre splat wider than the surface held the outline rigid.
  const before = ballHitRadiusAt(Math.PI);
  dentBall(Math.PI, 0.35);
  solveBallSurface();
  const after = ballHitRadiusAt(Math.PI);
  check('a dent takes the hitbox in with the picture', after < before - 0.5, `${before.toFixed(2)} → ${after.toFixed(2)} on the dented side`);
  check('...and only on the side it was dented', Math.abs(ballHitRadiusAt(0) - before) < 0.15, `far side ${ballHitRadiusAt(0).toFixed(2)} vs ${before.toFixed(2)}`);
  resetBall(); settle(0.6);

  // --- the seal: the capsule against the model it is drawn from ------------
  //
  // MEASURED, NOT COPIED. These three numbers describe furseal.glb through
  // assets.js's `fit` and assets.csv's size, and nothing in the file itself
  // stops them drifting the day either of those is retuned — so the model is
  // opened and re-measured here, exactly as prepareModel places it: the
  // area-weighted centroid it re-centres on, the bbox for the extents, and
  // the same axis map (forward +Z, and in the side view the model's UP is the
  // screen's in-plane perpendicular, so the thickness is dorsal-ventral and
  // the flipper span points at the lens).
  {
    const buf = readFileSync(new URL('../public/models/furseal.glb', import.meta.url));
    const gltf = await new Promise((res, rej) => new GLTFLoader().parse(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));
    const root = gltf.scene;
    root.updateMatrixWorld(true);
    const meshes = [];
    root.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) meshes.push(o); });
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const va = new THREE.Vector3(); const vb = new THREE.Vector3(); const vc = new THREE.Vector3();
    const tc = new THREE.Vector3(); const sum = new THREE.Vector3();
    let area = 0;
    for (const m of meshes) {
      const pos = m.geometry.attributes.position; const idx = m.geometry.index;
      const count = idx ? idx.count : pos.count;
      for (let i = 0; i < count; i += 3) {
        const ia = idx ? idx.getX(i) : i; const ib = idx ? idx.getX(i + 1) : i + 1; const ic = idx ? idx.getX(i + 2) : i + 2;
        va.fromBufferAttribute(pos, ia).applyMatrix4(m.matrixWorld);
        vb.fromBufferAttribute(pos, ib).applyMatrix4(m.matrixWorld);
        vc.fromBufferAttribute(pos, ic).applyMatrix4(m.matrixWorld);
        const w = new THREE.Vector3().subVectors(vb, va).cross(new THREE.Vector3().subVectors(vc, va)).length() * 0.5;
        if (w < 1e-12) continue;
        tc.copy(va).add(vb).add(vc).divideScalar(3);
        sum.addScaledVector(tc, w); area += w;
      }
    }
    const ctr = sum.divideScalar(area);
    const def = ASSETS.ship;
    const scale = (def.fit / Math.max(size.x, size.y, size.z)) * Number(ASSET_ROWS.get('ship').size);
    const nose = (box.max.z - ctr.z) * scale;
    const tail = (ctr.z - box.min.z) * scale;
    const thick = (size.y / 2) * scale;
    const near = (a, b) => Math.abs(a - b) < 0.06;
    check('the seal\'s body is the shipped model\'s, still',
      near(B.body.nose, nose) && near(B.body.tail, tail) && near(B.body.thickness, thick),
      `config ${B.body.nose}/${B.body.tail}/${B.body.thickness} vs furseal.glb ${nose.toFixed(2)}/${tail.toFixed(2)}/${thick.toFixed(2)} (nose/tail/half-thickness)`);
  }

  const body = B.body;
  check('the seal reaches further nose-on than flank-on, as an animal does', body.nose > body.thickness * 3, `nose ${body.nose}, thickness ${body.thickness}`);
  const noseOn = ballContactReach(Math.PI);
  const flank = rest + body.thickness;
  check('...so the contact distance is not one number', noseOn > flank + 2, `nose-on ${noseOn.toFixed(2)} vs flank ${flank.toFixed(2)}`);

  // THE NOSE STARTS IT. A seal swimming at the ball, walked in a step at a
  // time: nothing happens while the nose is clear of the drawn edge, and the
  // first frame it crosses is the frame the ball is shoved AND dented.
  resetBall(); settle(0.4);
  ball.vx = 0; ball.vy = 0;
  const edge = ballHitRadiusAt(Math.PI);
  const gap = (d) => {
    // The seal's nose `d` past the ball's drawn edge, swimming at it.
    resetBall();
    ball.x = 0; ball.y = midWater(); ball.vx = 0; ball.vy = 0;
    solveBallSurface();
    player.mesh.position.set(ball.x - ballHitRadiusAt(Math.PI) - body.nose + d, ball.y, 0);
    player.mesh.rotation.z = -Math.PI / 2; // nose at +x, the way it swims
    player.velocity.set(14, 0);
    strikeState.active = false;
    const rim0 = ball.rim[0];
    sealContact(0, player.mesh.position, player.velocity, false, null, 0, 0, 0);
    return { vx: ball.vx, dent: ball.rim.reduce((a, r) => a + Math.abs(r), 0) };
  };
  const clear = gap(-0.4);
  const touching = gap(0.3);
  check('a nose short of the drawn edge does nothing at all', clear.vx === 0 && clear.dent === 0, `vx ${clear.vx.toFixed(2)}, |rim| ${clear.dent.toFixed(3)}`);
  check('...and the frame it crosses is the shove AND the dent', touching.vx > 1 && touching.dent > 0.05, `vx ${touching.vx.toFixed(2)}, |rim| ${touching.dent.toFixed(3)}`);
  resetBall();
  player.mesh.position.set(-30, midWater(), 0);
  player.velocity.set(0, 0);
}

// ---------------------------------------------------------------------------
// A survivor run pours pickups into the water on their own clocks, and most of
// them pay out in a currency a match does not keep. CONFIG.versus.drop is the
// list; this is the check that the list is actually READ, at every tap that
// could put one of them on the pitch.
//
// SOURCE-GREPPED rather than simulated, because the taps live in main.js's
// frame loop, which no headless harness runs. What that buys is the thing that
// actually breaks: someone adding a fifth pickup spawner and not gating it.
// So the last check here is the inverse — every spawn call in that block has a
// gate beside it — and it is the one that will fail on the day it matters.
section('A match does without the survivor pickups');
{
  const src = readFileSync(new URL('../path/src/main.js', import.meta.url), 'utf8');
  const drop = CONFIG.versus.drop ?? {};
  check('the list exists, and is switched on', drop.rapidFire === true && drop.score === true && drop.level === true && drop.crateDrops === true);

  // Off-mode the question is always no, so a spawner can ask it unconditionally.
  enableVersus(false);
  check('...and asks nothing of an ordinary run', !versusDrops('rapidFire') && !versusDrops('score'));
  enableVersus(true);
  check('...and everything of a match', versusDrops('rapidFire') && versusDrops('score') && versusDrops('level'));
  check('a key nobody declared drops nothing', !versusDrops('somethingElse'));

  check('the fire-rate coral is gated', /rapidFireSpawnTimer <= 0[^)]*!versusDrops\('rapidFire'\)/.test(src));
  check('the score coral is gated', /scoreOrbSpawnTimer <= 0[^)]*!versusDrops\('score'\)/.test(src));
  check('the level blob is gated', /levelOrbSpawnTimer <= 0[^)]*!versusDrops\('level'\)/.test(src));

  // The side door: a shot-open crate rolls off its own table.
  const debris = readFileSync(new URL('../path/src/systems/boatDebris.js', import.meta.url), 'utf8');
  check('...and a crate cannot smuggle one in', /'rapidFire',[^\]]*!versusDrops\('rapidFire'\)/.test(debris));

  // EVERY tap in that block, not just the three above. The spawner section of
  // main.js is bounded by the ambient-bubble block and the chum chunks.
  const block = src.slice(src.indexOf('rapidFireSpawnTimer -= dt;'), src.indexOf('updateChumChunkSpawns(dt);'));
  const taps = block.match(/spawn[A-Za-z]*Orb\(/g) ?? [];
  check('every pickup tap in the block is gated', taps.length === (block.match(/!versusDrops\(/g) ?? []).length,
    `${taps.length} taps, ${(block.match(/!versusDrops\(/g) ?? []).length} gates`);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
section('The light on the scorer: the kill shaft, lent to a goal');
{
  const SP = V.goal.spotlight;
  // The light needs a scene to build its blades into; main.js hands it one at
  // startup and nothing else in this harness does.
  initBossLight(scene);
  resetBossLight();
  const gy = midWater();
  V.replay.enabled = false;
  toPlay();
  // Score one at the left mouth: that is player 2's point, so the light must
  // stand on player 2 and not on the player-1 body updateBossLight is handed.
  resetBall();
  versusState.phase = 'play';
  p2.pos.set(bounds.right - 30, gy - 10, 0);
  player.mesh.position.set(bounds.left + 30, gy + 8, 0);
  ball.x = bounds.left + 12; ball.y = gy; ball.vx = -30;
  for (let i = 0; i < 240 && versusState.phase === 'play'; i++) frame();
  check('a goal raises the hero light', versusState.phase === 'scored' && bossLightState.t >= 0 && bossLightState.mode === 'goal', `phase ${versusState.phase}, mode ${bossLightState.mode}, t ${bossLightState.t.toFixed(2)}`);
  check('...with no subject: there is no boss in a ball game', bossLightState.subject === false && bossLightSubject().live === false);
  // IT WAITS FOR THE BANG. The explosion is the event and the light is what
  // answers it, so it is still dark through the delay.
  // THE SHAPE THAT IS ACTUALLY RUNNING, which is not the tuning: at the
  // shipped numbers the three ramps come to more than the celebration lasts,
  // so they are squeezed in proportion to fit it (see spotlightScorer).
  const sh = bossLightShape();
  check('...dark through the delay', sh.delay > 0 && bossLightEnvelope(sh.delay * 0.5) === 0, `level ${bossLightEnvelope(sh.delay * 0.5)} at ${(sh.delay * 0.5).toFixed(2)}s`);
  check('...and up by the end of the rise', bossLightEnvelope(sh.delay + sh.rise) > 0.99, `level ${bossLightEnvelope(sh.delay + sh.rise).toFixed(3)}`);
  check('...and the ramps were squeezed to fit, keeping their proportions', sh.borrowed && sh.hold === 0
    && Math.abs(sh.delay / sh.fall - SP.delay / SP.fall) < 1e-6 && sh.rise < SP.rise,
    `delay ${sh.delay.toFixed(2)} rise ${sh.rise.toFixed(2)} fall ${sh.fall.toFixed(2)} of a tuned ${SP.delay}/${SP.rise}/${SP.fall}`);
  // ...AND OUT WITH THE CELEBRATION. Derived from the pose's own length, so
  // the light ends when the performance does rather than at a number typed
  // beside it that goes stale the next time a pose is retuned.
  const whole = bossLightSeconds();
  check('the light is gone by the time the celebration is', Math.abs(whole - celebrationState.duration) < 0.1,
    `light ${whole.toFixed(2)}s vs celebration ${celebrationState.duration.toFixed(2)}s`);
  // A TOLERANCE AND NOT `=== 0`: the end of the envelope is the sum of four
  // tuned floats, so u lands a whisker under 1 and the fall's square leaves
  // about 1e-14 behind. The light is torn down on the same comparison, so
  // that residue never reaches a frame.
  check('...and it is out at the end of it', bossLightEnvelope(whole) < 1e-6 && bossLightEnvelope(whole - sh.fall * 0.5) > 0,
    `${bossLightEnvelope(whole).toFixed(3)} at the end, ${bossLightEnvelope(whole - sh.fall * 0.5).toFixed(3)} half a fall before it`);
  // IT STANDS ON THE SCORER. Ticked the way main.js does — handed player 1 —
  // and it must still land on player 2, because the follow getter overrides.
  const settleTo = (t) => { while (bossLightState.t >= 0 && bossLightState.t < t) updateBossLight(dt, player.mesh?.position, player.body); };
  settleTo(sh.delay + sh.rise + 0.02);
  const blades = bossLightMeshes();
  check('the shaft is in the scene and lit', blades.length > 1 && blades.some((m) => m.material.opacity > 0.01), `${blades.length} mesh(es), brightest ${Math.max(...blades.map((m) => m.material.opacity)).toFixed(3)}`);
  // IT STANDS ON THE SCORER, and the state says where without anything having
  // to read a mesh — which is the only way to ask it here, because baking the
  // cone needs a 2D canvas the stub does not have.
  const near = (x, p) => Math.abs(x - p.x) < V.goal.spotlight.wander + 6;
  check('...standing on the SCORER, not on the body main.js hands it',
    near(bossLightState.atX, p2.pos) && !near(bossLightState.atX, player.mesh.position),
    `light at ${bossLightState.atX.toFixed(1)}, p2 at ${p2.pos.x.toFixed(1)}, p1 at ${player.mesh.position.x.toFixed(1)}`);
  // ORGANIC: neither the level nor the landing sits still while it is up. Both
  // sampled ACROSS THE HOLD, where the envelope is flat by construction — over
  // a rise or a fall any of this would move whether it breathed or not.
  //
  // AGAINST THE ENVELOPE, not against itself. The ramps are squeezed to fit
  // the celebration, so at the shipped tuning there is no flat hold anywhere
  // to sample: a level that moves proves nothing, because the envelope is
  // moving too. What breathing IS, exactly, is `lit` departing from `level` —
  // and the landing's wander is `atX` departing from the seal.
  // ACROSS THE WHOLE LIFE, from the frame it was raised. Sampling only the
  // tail measures a fraction of one period and can report a light that never
  // moves as one that does — which is how a wander whose two sines cancelled
  // each other for the light's entire life passed a check by a hundredth of a
  // unit.
  p2.vel.set(0, 0);
  resetBossLight();
  spotlightScorer(1);
  const breaths = []; const offs = [];
  for (let i = 0; i < 200; i++) {
    updateBossLight(dt, player.mesh?.position, player.body);
    if (bossLightState.t < 0) break;
    offs.push(bossLightState.atX - p2.pos.x);
    if (bossLightState.level < 0.05) continue;
    breaths.push(bossLightState.lit / bossLightState.level);
  }
  const deepest = Math.min(...breaths);
  const drift = Math.max(...offs) - Math.min(...offs);
  check('the light breathes rather than sitting on its envelope', deepest < 0.995 && breaths.length > 10,
    `dimmest breath ${deepest.toFixed(3)} of the envelope over ${breaths.length} frames`);
  // ...and only ever DOWN: a light that overshoots its own envelope pops on
  // the frame the hold begins.
  check('...and never brighter than the envelope it is on', Math.max(...breaths) <= 1.0001, `peak ${Math.max(...breaths).toFixed(4)}`);
  check('...and the landing drifts rather than being welded to the seal',
    drift > SP.wander * 0.25 && Math.max(...offs.map(Math.abs)) < SP.wander + 1e-6,
    `landing swept ${drift.toFixed(2)} units over the light's whole life, furthest ${Math.max(...offs.map(Math.abs)).toFixed(2)} of a ${SP.wander} wander`);
  check('...starting on the seal rather than beside it', Math.abs(offs[0]) < 0.05, `first frame ${offs[0].toFixed(3)} off the seal`);
  // A MATCH RESET TAKES IT DOWN — it is ours, and only ours.
  // ...and leave one standing, because the section after this one resets the
  // match and is where "a reset takes it down with it" is asserted — the
  // claim belongs beside the reset rather than beside a second one of its own.
  spotlightScorer(1);
  check('the light is up going into the reset', bossLightState.mode === 'goal', `mode ${bossLightState.mode}`);
}


section('Reset hands everything back');
{
  const slotsBefore = ball.slots.length;
  const lightBefore = bossLightState.mode;
  resetVersus();
  resetParticles();
  // The scorer's light is the match's, and goes down with it. Only ours: a
  // boss kill's is not versus.js's to take down.
  check('a match reset takes the scorer\'s light down with it', lightBefore === 'goal' && bossLightState.t < 0 && bossLightState.mode === null, `was ${lightBefore}, now ${bossLightState.mode} at t ${bossLightState.t}`);
  check('the ball\'s slots are released', ball.slots.length === 0 && slotsBefore > 0);
  check('the mode is off', !versusState.active && !ball.live);
  check('the arena\'s mouths are taken back', !goalHolesInstalled());
  check('a clock tick off-mode is a no-op', updateVersusClock(dt) === 1);
  resetEnemies(scene);
  enableVersus(false);
  check('the flag can be dropped again', !versusActive());
}


// ---------------------------------------------------------------------------
// THE AIR RING — CONFIG.strike.ring.air, drawn as the outermost band on each
// seal a PERSON is driving.
//
// A match is two or more people on one screen and the HUD's air gauge is one
// gauge, attached to seat 0: everybody else had no reading of their own lungs
// anywhere in the game, so drowning arrived with no warning for three of the
// four players. The band's look is measured in `npm run looks:core`, which is
// the only place the shader compiles; what is asserted here is the GATE, and
// every way it can be wrong is silent — a band on a bot is an instrument for a
// decision nobody is making, and a band missing from a human is a warning that
// never comes.
//
// LAST IN THE FILE, deliberately. It seats a second person, which changes the
// roster, and every measurement above this line is taken against the default
// one.
section('The circle HUD is drawn on people, not on bots');
{
  enableVersus(true);
  updateBounds(16 / 9);
  const airOf = (seat) => sealAt(seat)?.ring?.mesh?.material?.uniforms?.uAirGlow?.value;

  // A BOT IN SEAT 1 — the side handed to the computer on the team select.
  // `{kind:'cpu'}` rather than a null member, because those are two different
  // seats: an unclaimed captain's seat goes to whoever is on the stick (see
  // botWanted), so a null one with a pad plugged in is a PERSON'S.
  versusSetup.teams[1].members[0] = { kind: 'cpu' };
  startVersus(scene);
  toPlay();
  settle(0.2);
  // NOT ONE BAND OF IT. It used to be only the air that was withheld, which
  // left a bot wearing the fuel pips and the power core — an instrument for a
  // decision nobody is making, four of them over a crowded pitch. The ring
  // object still exists (a person can take the seat mid-match); it is not
  // drawn.
  check('a bot seat wears no ring at all', sealAt(1)?.ring != null && sealAt(1).ring.mesh.visible === false,
    `visible ${sealAt(1)?.ring?.mesh?.visible}`);
  check('...while the seal you are driving still wears its own',
    player.ring ? player.ring.mesh.visible !== false : true);

  // ...AND A PERSON IN IT.
  resetVersus();
  versusSetup.teams[1].members[0] = { kind: 'human', pad: 1 };
  startVersus(scene);
  toPlay();
  check('a person in seat 1 gets the band', airOf(1) > 0, `uAirGlow ${airOf(1)}`);

  // IT READS THAT SEAL'S OWN LUNGS, not seat 0's — the whole point, and the
  // one thing a shared gauge could never do.
  const seal = sealAt(1);
  const maxO2 = Math.max(1, player.stats?.maxOxygen ?? CONFIG.oxygen.max);
  seal.oxygen = maxO2 * 0.5;
  settle(0.2);
  const u = seal.ring.mesh.material.uniforms;
  check('...filled from that seal\'s own air', Math.abs(u.uAirLeft.value - 0.5) < 0.05,
    `uAirLeft ${u.uAirLeft.value.toFixed(3)} at half a bar`);
  check('...with no strain at half a bar', u.uAirStrain.value === 0, `strain ${u.uAirStrain.value}`);

  // THE STRAIN CROSSES WHERE THE SCREEN AND THE MIX DO. One threshold, so the
  // ring goes red on the same frame the picture tears — three warnings
  // arriving as one event rather than as three.
  const threshold = CONFIG.oxygen.fx.threshold;
  seal.oxygen = maxO2 * threshold * 0.5;
  settle(0.2);
  // AGAINST THE AIR THE SEAL ACTUALLY HAS, not against what it was set to: it
  // goes on breathing through the settle above, and a test that assumes the
  // value it wrote is a test measuring its own arithmetic.
  const left = seal.oxygen / maxO2;
  const want = 1 - left / threshold;
  check('...and the strain is the crossing of CONFIG.oxygen.fx.threshold',
    Math.abs(u.uAirStrain.value - want) < 0.03,
    `strain ${u.uAirStrain.value.toFixed(3)} against ${want.toFixed(3)} at ${(left * 100).toFixed(1)}% of a bar, threshold ${(threshold * 100).toFixed(1)}%`);

  // SEAT 0's RING IS MAIN.JS'S, and it is handed its air through this door.
  // Null outside a match is what leaves the band off in an ordinary run, where
  // the HUD's own gauge is the reading.
  check('seat 0\'s air is offered to main.js while a match is on', versusPlayerAir()?.max === maxO2,
    JSON.stringify(versusPlayerAir()));
  resetVersus();
  check('...and withdrawn when it is not', versusPlayerAir() === null);
  versusSetup.teams[1].members[0] = null;
  enableVersus(false);
}

// ---------------------------------------------------------------------------
// THE GLASS — the goal card and the highlight tag, and the one thing about
// them that is not a taste call.
//
// The team's colour moved OFF the text and onto the pane, because both of
// these surfaces are composited over the moment they describe: a goal blows
// the scoring team's own colour out of the mouth at full bloom, so
// team-coloured type sat on a field of the same hue by construction. The words
// are black now, and black on a pane is only as readable as the pane is light.
//
// WHICH MAKES IT ARITHMETIC. The pane's lightness is a white fill over
// whatever is behind it, so "can you read this" is a contrast ratio between
// black and that composite — computable here, and the only part of a glass
// treatment that has a right answer rather than a preference.
//
// IT READS CONFIG NOW, NOT THE STYLESHEET. The numbers moved into CONFIG.glass
// and onto sliders, which is what this check exists for: a rule scraped out of
// the source would be measuring a FALLBACK while the pane on screen wore
// whatever the last drag left in imported-tuning.json. CONFIG here is the
// merged value — saved tuning included — so this is a statement about the pane
// Ethan is actually looking at.
//
// THE WEAKEST STOP OF THE GRADIENT IS THE FLOOR. The fill is authored as a
// gradient and the pane is only as readable as its dimmest corner: a middle
// stop of 0.50 is a 6.5:1 pane wherever that corner lands, however handsome
// the average is. `frost` IS that corner — the other two stops are it plus a
// lift — so it is the one number this reads, and the one somebody lowers for
// looks.
section('The glass keeps black text readable over anything the pitch does');
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../path/src/systems/versus.js', import.meta.url), 'utf8');
  const rule = src.slice(src.indexOf('.sv-glass {'), src.indexOf('.sv-glass::after'));
  const g = CONFIG.glass ?? {};

  const srgbLin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, gg, b]) => 0.2126 * srgbLin(r) + 0.7152 * srgbLin(gg) + 0.0722 * srgbLin(b);
  const over = (fg, a, bg) => fg.map((c, i) => c * a + bg[i] * (1 - a));
  // THE TWO ENDS OF THE GAME'S RANGE: the darkest water the pitch is drawn on,
  // and the goal's own explosion at full bloom. The label has to hold on both,
  // and the first is the one the old fill failed.
  const contrastOn = (bg, team, frost, wash) => {
    const pane = over([255, 255, 255], frost, bg);
    const L = lum(over(team, wash, pane));
    return (L + 0.05) / 0.05;   // against black type
  };
  const worst = (frost, wash) => Math.min(
    contrastOn([6, 18, 29], [255, 155, 46], frost, wash),
    contrastOn([255, 205, 130], [255, 155, 46], frost, wash),
  );

  const frost = Number(g.frost);
  const wash = Number(g.wash);
  check('CONFIG.glass declares a frost and a wash', Number.isFinite(frost) && Number.isFinite(wash), `frost ${g.frost}, wash ${g.wash}`);
  const deep = contrastOn([6, 18, 29], [255, 155, 46], frost, wash);
  const blown = contrastOn([255, 205, 130], [255, 155, 46], frost, wash);
  check('black type holds over the darkest water', deep >= 7, `${deep.toFixed(1)}:1 at frost ${frost}`);
  check('...and over the goal it is sitting on', blown >= 7, `${blown.toFixed(1)}:1`);

  // ...AND THE PANE IS STILL GLASS. A fill taken high enough to be safe on any
  // backdrop stops refracting and becomes a sticker over the one frame of the
  // match worth looking at — the failure in the other direction, and why the
  // floor is a floor rather than "make it white".
  check('...without the fill going opaque', frost <= 0.75, `frost ${frost}`);
  check('and it refracts rather than covering', Number(g.blur) > 0 && /backdrop-filter: blur\(var\(--sv-glass-blur/.test(rule),
    `blur ${g.blur} — ${rule.match(/[^-]backdrop-filter: [^;]+/)?.[0]?.trim() ?? 'NO backdrop-filter, and a pane that does not sample what is behind it is a card'}`);

  // THE SLIDER CANNOT REACH AN UNREADABLE PANE. The check above is about the
  // value saved today; this one is about every value the panel can produce,
  // which is the risk that arrived with the numbers becoming tunable. Measured
  // rather than restated: the floor is wherever 7:1 actually breaks, swept at
  // the least forgiving wash the wash slider can reach.
  const { TUNER_SCHEMA } = await import('../path/src/config.js');
  const rows = TUNER_SCHEMA.flatMap((grp) => grp.items ?? []);
  const row = (path) => rows.find((r) => r.path === path);
  const frostRow = row('glass.frost');
  const washRow = row('glass.wash');
  check('the glass is on the tuner', !!frostRow && !!washRow, frostRow && washRow ? 'frost + wash' : 'missing a row');
  if (frostRow && washRow) {
    let floor = null;
    for (let f = 0.4; f <= 0.9; f += 0.01) {
      let ok = true;
      for (let w = washRow.min; w <= washRow.max + 1e-9; w += (washRow.step ?? 0.01)) {
        if (worst(f, w) < 7) { ok = false; break; }
      }
      if (ok) { floor = Math.round(f * 100) / 100; break; }
    }
    check('...and its frost slider cannot be dragged under the readable floor',
      floor != null && frostRow.min >= floor - 1e-9, `slider min ${frostRow.min}, measured floor ${floor}`);
    check('...while still reaching a pane that is glass', frostRow.max <= 0.75, `slider max ${frostRow.max}`);
  }

  // THE TWO FILES HAVE TO AGREE ON THE PROPERTY NAMES. The sheet reads
  // --sv-glass-* and applyGlassStyle writes them, and a rename in one of them
  // is completely silent: every var() falls back to the shipped number, so the
  // pane looks right and the panel does nothing. Paired, so a moved name fails
  // here rather than in a drag nobody is watching.
  const style = src.slice(src.indexOf('const STYLE = `'), src.indexOf('\n`;', src.indexOf('const STYLE = `')));
  const read = [...new Set([...style.matchAll(/var\((--sv-glass-[a-z-]+)/g)].map((m) => m[1]))];
  const apply = src.slice(src.indexOf('export function applyGlassStyle'), src.indexOf('\n}', src.indexOf('export function applyGlassStyle')));
  const written = [...new Set([...apply.matchAll(/'(--sv-glass-[a-z-]+)'/g)].map((m) => m[1]))];
  check('the sheet reads the glass properties', read.length >= 6, read.join(' '));
  const unwritten = read.filter((n) => !written.includes(n) && n !== '--sv-glass-radius');
  check('...and applyGlassStyle writes every one it reads', unwritten.length === 0, unwritten.join(' ') || `${written.length} written`);
  const unread = written.filter((n) => !read.includes(n));
  check('...and writes nothing the sheet ignores', unread.length === 0, unread.join(' '));

  // THE TEAM'S COLOUR IS THE GLASS'S NUMBER TOO. glassTint is the one place the
  // wash and the rim are set, and it used to hold them as literals — which
  // would leave two of the ten rows on the panel moving nothing.
  const tint = src.slice(src.indexOf('function glassTint'), src.indexOf('\n}', src.indexOf('function glassTint')));
  check('glassTint spends CONFIG.glass rather than its own numbers',
    /glass\.wash/.test(tint) && /glass\.rim/.test(tint) && !/,0\.26\)/.test(tint),
    tint.match(/--sv-team-wash[^;]+/)?.[0] ?? 'no wash written');

  // THE TEXT IS ACTUALLY BLACK. The contrast above is arithmetic about a
  // colour nothing has checked is in use: the card set its text to the team's
  // colour for as long as it existed, and leaving that line in place would
  // make every number above a statement about a pane nobody is reading black
  // text on.
  const cardRule = src.slice(src.indexOf('.sv-versus-card {'), src.indexOf('.sv-versus-card.sv-versus-in'));
  check('the card sets black ink', /color: #0[0-9a-f]{5}/.test(cardRule), cardRule.match(/color: [^;]+/)?.[0] ?? 'none');
  check('...and nothing paints the team colour back onto it',
    !/\.style\.color = ui\.colors/.test(src),
    'a style.color write is still putting team-coloured type on the pane');

  // BACKTICKS. The stylesheet is a template literal, and one inside it ends
  // the string — the SyntaxError points at a CSS comment, which is the last
  // place anybody looks. Cheap to check, and this file has paid for it twice.
  check('no backtick inside the stylesheet literal', (style.match(/`/g) ?? []).length === 1,
    `${(style.match(/`/g) ?? []).length - 1} stray backtick(s)`);
}

// ---------------------------------------------------------------------------
section('Every ui.* the match reaches for is one mountUi builds');
{
  // THIS IS THE BUG THAT COST THE SCORE SCREEN. `showStats` was gated on
  // `ui.over` — the DOM prompt the stats page REPLACED — and mountUi had
  // stopped building that node the day the page took over from it. A guard on
  // an element that is never built is never true, so the score screen silently
  // stopped appearing at the end of every match, and the text panel's "match
  // over" preview threw on the same dead name before it drew anything.
  //
  // Nothing shouts when that happens: `ui.over` is `undefined`, `!ui?.over` is
  // simply true, and the only symptom is a screen that does not come up. So it
  // is checked from the SOURCE rather than from a live DOM — the harness has no
  // document.body to mount into, and waiting for a browser to notice is how
  // this got out in the first place.
  const src = readFileSync(new URL('../path/src/systems/versus.js', import.meta.url), 'utf8');
  const lit = src.slice(src.indexOf('    ui = {'), src.indexOf('\n    };', src.indexOf('    ui = {')));
  const built = new Set([...lit.matchAll(/^      ([A-Za-z][A-Za-z0-9]*)[:,]/gm)].map((m) => m[1]));
  check('mountUi builds the pieces of the HUD', built.size >= 15, `${built.size} keys`);
  // COMMENTS ARE NOT READS. This very section is described in versus.js in
  // prose that names the dead key, and counting that would make the check fail
  // on its own explanation of itself.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const used = new Set([...code.matchAll(/\bui\??\.([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]));
  const dead = [...used].filter((k) => !built.has(k));
  check('...and every ui.* read is one of them', dead.length === 0,
    dead.length ? `ui.${dead.join(', ui.')} — read but never built` : `${used.size} names, all built`);
}

section('The strip fits the phone it is on');
{
  // THE STRIP IS THE ONE PART OF BLUBBERBALL SIZED IN PX. Every other line is
  // vmin with a px floor; the score and the clock are tuned px in the Text
  // panel (52px of Orbitron on the clock, plus min-width: 5ch so a match past
  // ten minutes does not shuffle the row sideways), which made the strip a
  // fixed ~437px on every screen there is. That is 62px wider than an iPhone SE
  // and 6px wider than a Pro Max, and it hung off BOTH sides of every phone in
  // the game — `npm run layout` reported it at three viewports x three match
  // surfaces, 54 findings, for as long as the strip existed.
  //
  // FROM THE SOURCE, like the section above it and for the same reason: this
  // harness has no layout engine, and the thing being protected is a shape
  // rather than a number. The NUMBER is `npm run layout`'s job, and it now
  // measures 0 where it measured 54 — what can quietly come back here is the
  // wiring, and every piece of it fails silently.
  const src = readFileSync(new URL('../path/src/systems/versus.js', import.meta.url), 'utf8');

  check('the strip carries a fit scale at all',
    /--sv-vs-fit/.test(src) && /transform:\s*translateX\(-50%\)\s*scale\(var\(--sv-vs-fit/.test(src),
    'without it the row is a fixed 437px on a 375px phone');
  // ORDER, and it is not style: `scale() translateX(-50%)` scales the -50% too,
  // so the strip slides off centre as it shrinks — which looks like a centring
  // bug in a file that has nothing to do with centring.
  check('the translate comes before the scale',
    src.indexOf('translateX(-50%) scale(var(--sv-vs-fit') > -1
    && !/scale\(var\(--sv-vs-fit[^;]*\)\s*translateX\(-50%\)/.test(src),
    'scaling the -50% walks the strip off centre');
  check('...about the top centre, so the scale does not move it',
    /transform-origin:\s*50%\s*0/.test(src));

  // offsetWidth, NOT getBoundingClientRect. The rect is the box AFTER the
  // transform, so a fit measured through it reads the strip at the scale it is
  // already wearing and shrinks a little more on every resize until it
  // disappears. This is the single line that turns the fix into a slow bug.
  const fit = src.slice(src.indexOf('function fitStrip('), src.indexOf('\nfunction paintScores'));
  check('the natural width is measured with offsetWidth', /\.offsetWidth/.test(fit),
    'a rect read would feed the scale back into itself');
  check('...and never through getBoundingClientRect', !/getBoundingClientRect/.test(fit),
    'that is the transformed box — see the note in fitStrip');
  check('a strip with no layout yet is left alone rather than scaled to nothing',
    /natural < 1/.test(fit), 'measured before the roled font lands');

  // THE FOUR THINGS THAT CHANGE THE ANSWER. A fit computed once is a fit for
  // one screen, one font and one scoreline, and each of these fails by leaving
  // the strip at a scale that WAS right.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const calls = [...code.matchAll(/fitStrip/g)].length;
  check('it is re-asked from more than one place', calls >= 5, `${calls} mentions`);
  check('a rotation re-asks it', /addEventListener\('resize', fitStrip\)/.test(code),
    'a strip that fits sideways is 62px too wide stood up');
  check('the font landing re-asks it', /document\.fonts/.test(code) && /stripFitKey = ''/.test(code),
    'a fit measured in the fallback face is a fit for type that is not on screen');
  check('the clock and the score both re-ask it',
    /paintClock[\s\S]{0,600}?fitStrip\(\)/.test(code) && /paintScores[\s\S]{0,400}?fitStrip\(\)/.test(code));
  check('and the Text panel preview, which writes the readouts by hand',
    /previewVersusUi[\s\S]{0,1200}?fitStrip\(\)/.test(code),
    'the painters never run there, so the preview would measure full size');
  // The guard is what makes a call from paintClock free — that runs every frame.
  check('a per-frame call is free unless something moved', /if \(key === stripFitKey\) return/.test(fit),
    'paintClock ticks every frame; a layout read per frame on a phone is the cost that shows up late');
  check('...and the room is part of what "moved" means', /const key = `\$\{room\}/.test(fit),
    'without it a resize changes nothing the key can see');

  // THE DYNAMIC ISLAND. The page draws edge to edge (viewport-fit=cover in
  // index.html), so the top of the viewport is the top of the GLASS: upright,
  // the pill sits over the middle of the strip, which is where the clock is;
  // on its side the inset moves to the leading edge and about 59px of the
  // window is behind it.
  check('the strip hangs below the top inset, not below the top of the glass',
    /\.sv-versus-hud \{ position: absolute; top: calc\(12px \+ env\(safe-area-inset-top, 0px\)\)/.test(src),
    'upright, the Dynamic Island sits exactly over the clock between the two scores');
  check('...and is centred in a band inset by the side insets',
    /\.sv-versus-band \{[^}]*left: env\(safe-area-inset-left, 0px\); right: env\(safe-area-inset-right, 0px\)/.test(src),
    'held sideways the pill takes one edge, and a strip centred on the glass is off centre on the screen');
  check('...which is a real element, so the fit can read the insets in pixels',
    /<div class="sv-versus-band">/.test(src) && /band: root\.querySelector\('\.sv-versus-band'\)/.test(src),
    'env() is a CSS function with no JS reading — this is how fitStrip gets the number');
  check('the fit measures the band and not the window',
    /ui\.band\?\.clientWidth \|\| window\.innerWidth/.test(fit),
    'fitting to the window fits to a width that is behind the pill');
  check('...and the band takes no space of its own',
    /\.sv-versus-band \{[^}]*height: 0/.test(src));
}

section('The stats page fits the screen it is on');
{
  // THE ONE SCREEN IN THE MODE WITH NOTHING ELSE ON IT, and the one you could
  // get stuck on. The page is a Rive artboard 900 x 760 — taller than it is
  // wide — and the canvas was sized `width: min(92vw, 900px)` with
  // `height: auto`: a rule with no opinion about height. On a phone on its
  // side there is barely any, so 92vw of an iPhone 15 landscape made the page
  // 662px tall in a 393px viewport, centred, with a third of it off the top
  // and a third off the bottom. Rematch and Main Menu are in the bottom
  // third, and they are inside the artboard rather than in the DOM, so
  // nothing else in this repo could see them go.
  //
  // MEASURED, ONCE, IN A BROWSER: at 874x402 with a Dynamic Island phone's
  // insets the page came out 724x611 and now comes out 413x349, inside the
  // viewport and inside the safe area. What is protected here is the wiring
  // that produced that, because every part of it fails silently.
  const src = readFileSync(new URL('../path/src/ui/statsCard.js', import.meta.url), 'utf8');
  // The two absence checks read the CODE only: both comments quote the rule
  // they replaced, which is the point of them, and a check that cannot tell a
  // rule from a note about one fails the day somebody explains themselves.
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  check('the page is not sized by width alone any more',
    !/min\(92vw, 900px\)/.test(code),
    'a width-only rule has no opinion about a landscape phone');
  check('the width takes the smaller of the authored size, the room across and the room down',
    /min\(900px, calc\(100vw - \$\{pad\.l\} - \$\{pad\.r\}\),/.test(src)
    && /calc\(\(100\$\{vh\} - \$\{pad\.t\} - \$\{pad\.b\}\) \* \$\{STATS_ASPECT/.test(src),
    'the room down expressed as the width that fits in it');
  check('...spelled out rather than left to max-width plus max-height',
    !/max-height:\s*100%/.test(code),
    'measured in Chromium at 874x402 the height constraint did not apply and the page still overflowed');
  check('the box and the width subtract the SAME four margins',
    /const pad = \{/.test(src) && /padding:\$\{pad\.t\} \$\{pad\.r\} \$\{pad\.b\} \$\{pad\.l\}/.test(src),
    'centred in one box and sized against another is centred wrong');
  for (const side of ['top', 'right', 'bottom', 'left']) {
    check(`...and the ${side} margin carries the device inset`,
      new RegExp(`4vmin \\+ env\\(safe-area-inset-${side}, 0px\\)`).test(src),
      'the page draws edge to edge, so the window is not what can be seen');
  }
  check('the page is laid out against the SMALL viewport',
    /height:100vh; height:100svh;/.test(src) && /room\('vh'\)/.test(src) && /room\('svh'\)/.test(src),
    'a browser bar is not a safe-area inset and reports 0 — svh is what keeps the buttons off it');
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
