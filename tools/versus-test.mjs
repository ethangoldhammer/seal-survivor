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
import { enableVersus, versusActive } from '../path/src/systems/versusFlag.js';
import { bounds, updateBounds, midWater } from '../path/src/arena.js';
import { player, initPlayer, resetPlayer } from '../path/src/entities/player.js';
import { strikeState, resetStrike, cancelDash } from '../path/src/systems/strike.js';
import { initParticles, resetParticles, drivenCapacity } from '../path/src/entities/particles.js';
import { spawnXpOrb, pickups, resetPickups } from '../path/src/entities/pickups.js';
import { resetEnemies, spawnNamed, enemies } from '../path/src/entities/enemies.js';
import { updateStrike } from '../path/src/systems/strike.js';
import { versusHooks } from '../path/src/systems/versus.js';
import {
  versusState, ball, p2, startVersus, resetVersus, updateVersus, updateVersusClock, stirGoalLights,
  renderVersus, resetBall, dentBall, sealContact, p2Pad, readP2Input, versusFocus, rimRadius,
  versusCameraGoal, updateVersusCamera, strikeBallFrom, impactDent, versusBubblePips, driveOutline,
  versusOutOfAir, sealVulnerable,
  kickoffSpot, enterKickoff,
  ballHitRadius, updatePinch, creditGoal, formatClock, jostle, rimRadiusAt,
  contestMargin, contestMass, returnCap, returnFloor, ballSpeedCap, sealCollide,
  replayState, anyButtonHeld, versusCameraState, replayRenderCamera, cameraRecentred,
} from '../path/src/systems/versus.js';
import { poolState, targetsInFrame } from '../path/src/systems/replayCams.js';
import { cineLens } from '../path/src/systems/cineCamera.js';
import { screenEdgeX, mouthHalfHeight, tunnelDepth, goalHolesInstalled, rockX, mouthY, goalLineX, goalLineDepth, cameraReach } from '../path/src/systems/versusGoal.js';
import { clampToArena } from '../path/src/arena.js';
import { baitBalls } from '../path/src/systems/baitBall.js';
import {
  createWallRocks, shore, refreshGoalGlow, flashGoalScored, clearGoalScored,
  tickGoalGlow, goalGlowState, setGoalSwimmers, goalGlowImpulse, resetGoalStir,
} from '../path/src/systems/wallRocks.js';
import { boats } from '../path/src/systems/boats.js';
import { updateBot, botState, resetBot, intoOwnGoal } from '../path/src/systems/versusBot.js';
import { fireGoalJet, updateGoalJets, resetGoalJets, goalJetState, goalJets } from '../path/src/systems/goalJet.js';
import { drivenCapacity as drivenCap } from '../path/src/entities/particles.js';
import { celebrationState, celebrationSpin, resetCelebration } from '../path/src/systems/celebrate.js';
import { onFeedback } from '../path/src/systems/feedback.js';
import { bubbleOrbs, spawnBubbleOrb } from '../path/src/entities/pickups.js';
import { pipValue, pipCount } from '../path/src/systems/strike.js';
import { uiText } from '../path/src/uiTextTable.js';
import { ballTint, ballLookState } from '../path/src/systems/ballLook.js';

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
function frame(pads = noPads, raw = dt) {
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
  check('each seal is on its own kickoff spot, `inset` in from its own wall', Math.abs(player.mesh.position.x - s0.x) < 1e-6 && Math.abs(p2.pos.x - s1.x) < 1e-6 && Math.abs(s0.x - (bounds.left + KO.inset * bounds.width)) < 1e-6, `p1 ${s0.x.toFixed(1)} p2 ${s1.x.toFixed(1)}`);
  check('...mirrored about the ball', Math.abs(s0.x + s1.x) < 1e-6 && s0.y === midWater());
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
section('A dash shoves the ball once, along the dash');
{
  resetBall();
  const reach = ball.r + V.ball.contactRadius;
  player.mesh.position.set(ball.x - reach + 0.4, ball.y, 0);
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
  player.mesh.position.set(ball.x - reach + 0.4, ball.y, 0);
  frame();
  check('the same dash does not shove twice', ball.vx <= v1, `vx ${v1.toFixed(1)} → ${ball.vx.toFixed(1)}`);
  strikeState.active = false;
  frame();
  strikeState.active = true;
  ball.vx = 0; // still, so the ball is where the seal is put on the frame of contact
  player.mesh.position.set(ball.x - reach + 0.4, ball.y, 0);
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
  const reach = ball.r + V.ball.contactRadius;
  sealContact(1, { x: ball.x - reach + 0.3, y: ball.y }, { x: 12, y: 0 }, false, null, 0);
  check('a bump moves the ball along the closing speed', ball.vx > 5 && ball.vx < 30, `vx=${ball.vx.toFixed(1)}`);
  check('the ball is pushed out of the seal', ball.x > 0.2, `x=${ball.x.toFixed(2)}`);

  // Above the mouth, heading for the left wall.
  resetBall();
  ball.x = bounds.left + 12;
  ball.y = midWater() + V.goal.halfHeight + 4;
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

  // THE SEALS' HOLE. Player 1 may swim into the mouth, keeperDepth and no
  // further; outside the band the wall holds it as it always did.
  const pos = { x: bounds.left + 0.5, y: gy };
  const vel = { x: -20, y: 0 };
  let hit = false;
  for (let i = 0; i < 30; i++) { pos.x += vel.x * dt; if (clampToArena(pos, vel, 1, 0)) hit = true; }
  check('a seal swims into the mouth', pos.x < bounds.left - 1, `x=${pos.x.toFixed(2)} (wall ${bounds.left.toFixed(2)})`);
  const keeper = Math.min(V.goal.keeperReach, goalLineDepth() - 0.5);
  check(`...to keeperReach (${V.goal.keeperReach}), short of the line, and no further`, Math.abs(pos.x - (bounds.left - keeper)) < 1e-6 && hit && keeper < goalLineDepth(), `x=${pos.x.toFixed(2)}, line ${goalLineDepth().toFixed(1)} in`);
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
  check('the goal was called once the ball\'s near side was past the line', versusState.lastGoal && versusState.lastGoal.x + ball.r <= line + 1e-6, `x=${versusState.lastGoal?.x.toFixed(2)}, near side ${(versusState.lastGoal?.x + ball.r).toFixed(2)} vs line ${line.toFixed(2)}`);
  check('...and not before it', versusState.lastGoal && versusState.lastGoal.x + ball.r > line - ball.r, `near side ${(versusState.lastGoal?.x + ball.r).toFixed(2)} vs line ${line.toFixed(2)}`);
  check('the line is ON SCREEN: inside the camera\'s reach into the goal', goalLineDepth() + ball.r < cameraReach() && cameraReach() <= tunnelDepth(), `line ${goalLineDepth().toFixed(1)} + ball ${ball.r} vs reach ${cameraReach().toFixed(1)} of tunnel ${tunnelDepth()}`);
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
  check('...with both seals back on their spots', Math.abs(player.mesh.position.x - s0.x) < 1e-6 && Math.abs(p2.pos.x - s1.x) < 1e-6);
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
}

// ---------------------------------------------------------------------------
section('P2 rams the ball too, and the ball stays in the arena');
{
  resetBall();
  const reach = ball.r + V.ball.contactRadius;
  p2.pos.set(ball.x + reach - 0.4, ball.y, 0);
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
  ball.x = 0; ball.y = bounds.bottom + ball.r + 0.1; ball.vx = 0; ball.vy = -4;
  const reach = ball.r + V.ball.contactRadius;
  const press = () => { player.mesh.position.set(ball.x + (reach - 0.7) * 0.34, ball.y + (reach - 0.7) * 0.94, 0); player.velocity.set(-5, -14); };
  strikeState.active = false;
  const x0 = ball.x;
  for (let i = 0; i < 40; i++) { press(); frame(); }
  const n4 = Math.round(ball.rim.length / 4);
  check('the squeeze builds under the pinch', ball.squeeze > 0.3, `squeeze ${ball.squeeze.toFixed(2)} (max ${P.max})`);
  check('...and the ball collides SMALLER than it is drawn', ballHitRadius() < ball.r * 0.75 && ball.y < bounds.bottom + ball.r * 0.8, `hit radius ${ballHitRadius().toFixed(2)} of ${ball.r}, y ${ball.y.toFixed(2)} vs floor ${bounds.bottom.toFixed(2)} (a round ball sits at ${(bounds.bottom + ball.r).toFixed(2)})`);
  // By WORLD angle: the rim's samples ride round with the spin the seal's
  // friction put on it, so sample n/4 is not the top.
  const up = rimRadiusAt(Math.PI / 2); const across = rimRadiusAt(0);
  check('...flattened along the pinch in the look', up < ball.r - 0.15 && across > ball.r + 0.12 && across - up > 0.3, `rim up ${up.toFixed(2)}, across ${across.toFixed(2)}`);
  check('...and it squirts along the rock, away from the side the seal is on', ball.x < x0 - 2 && ball.vx < -3, `x ${x0.toFixed(1)} → ${ball.x.toFixed(1)}, vx ${ball.vx.toFixed(1)}`);
  // Let go: the seal away, the ball fills back out.
  player.mesh.position.set(-30, gy, 0); player.velocity.set(0, 0);
  settle(0.6);
  check('released, it is round again', ball.squeeze === 0 && ballHitRadius() === ball.r, `squeeze ${ball.squeeze.toFixed(3)}`);
  // A seal alone, or rock alone, is not a pinch.
  resetBall(); ball.x = 0; ball.y = gy;
  press(); frame(); press(); frame();
  check('a seal alone does not squeeze it', ball.squeeze === 0);
  resetBall(); ball.x = 0; ball.y = bounds.bottom + ball.r + 0.5; ball.vy = -30;
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
  // The jolt rights itself.
  p2.pos.set(30, y, 0); p2.vel.set(0, 0); p2.knockX = p2.knockY = 0;
  settle(2.5, [pad(0), pad(1)]);
  check('the jolt springs back to true', Math.abs(p2.jolt.spin) < 0.02 && Math.abs(p2.jolt.roll) < 0.02, `spin ${p2.jolt.spin.toFixed(3)} roll ${p2.jolt.roll.toFixed(3)}`);
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
  versusState.touches.length = 0;
  versusState.touches.push({ t: 10, who: 1, kind: 'strike' });
  let c = creditGoal(1, 12);
  check('the last toucher is the scorer, by name', c.who === 1 && c.name === versusState.names[1] && !c.ownGoal && c.assist === -1 && c.time === '0:12', JSON.stringify(c));
  c = creditGoal(0, 12);
  check('...and an own goal when the credited team is the other one', c.ownGoal && c.who === 1, JSON.stringify(c));
  check('a two-seal match never has an assist', c.assist === -1 && c.assistName === '');
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
  const R = ball.r + V.ball.contactRadius - 0.3;
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
  const R = ball.r + V.ball.contactRadius - 0.3;
  const hitFrom = (speed, power) => {
    resetBall(); ball.vx = ball.vy = 0;
    fired.clear(); versusState.lastImpact = null;
    strikeBallFrom({ x: ball.x - (R + 4), y: ball.y }, { x: 1, y: 0 }, speed, power);
    return versusState.lastImpact;
  };
  const soft = hitFrom(8, 0.05);
  check('a strike fires the ball\'s hit event', soft && soft.event === 'versusBallHit' && firedCount('versusBallHit') === 1, soft?.event);
  check('...from the rim on the side it was struck', soft && Math.abs(soft.x - (ball.x - ball.r)) < 1.5 && Math.abs(soft.y - ball.y) < 0.5, soft ? `at (${soft.x.toFixed(1)},${soft.y.toFixed(1)}), ball (${ball.x.toFixed(1)},${ball.y.toFixed(1)})` : '');
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
  const reach = ball.r + V.ball.contactRadius;
  sealContact(1, { x: ball.x - reach + 0.3, y: ball.y }, { x: 12, y: 0 }, false, null, 0);
  const bump = versusState.lastImpact;
  check('a swimming nudge is a small hit', bump && bump.event === 'versusBallHit' && bump.scale < hard.scale * 0.5, bump ? `scale ${bump.scale.toFixed(2)}` : 'no event');
  resetBall(); ball.vx = ball.vy = 0; fired.clear();
  sealContact(1, { x: ball.x - reach + 0.3, y: ball.y }, { x: 0.5, y: 0 }, false, null, 0);
  check('...and a seal resting against it fires nothing', firedCount('versusBallHit') === 0);
  // ...and a seal DRIBBLING it is one splash every bumpGap, not one a frame.
  resetBall(); fired.clear();
  for (let i = 0; i < 120; i++) { player.mesh.position.set(ball.x - reach + 0.5, ball.y, 0); player.velocity.set(12, 0); frame(); }
  player.mesh.position.set(-30, midWater(), 0); player.velocity.set(0, 0);
  check('a seal dribbling the ball for two seconds splashes a few times, not a hundred', firedCount('versusBallHit') >= 1 && firedCount('versusBallHit') <= Math.ceil(2 / F.bumpGap) + 1, `${firedCount('versusBallHit')} in 2s (gap ${F.bumpGap}s)`);
  // A ball settling onto the floor under its own buoyancy makes no splash.
  resetBall(); fired.clear();
  ball.y = bounds.bottom + ball.r + 0.01; ball.vy = -1; ball.vx = 0;
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
  strikeState.charge = 0; strikeState.pending = 0;
  p2.charge = 0; p2.pending = 0;
  versusState.regenT[0] = versusState.regenT[1] = every;
  const idle = [pad(0), pad(1)]; // pads present and untouched: no bot, no wind-up
  settle(every - 0.2, idle);
  check('nothing before the pip is due', strikeState.charge < 1e-6 && p2.charge < 1e-6, `p1 ${strikeState.charge.toFixed(3)} p2 ${p2.charge.toFixed(3)}`);
  settle(0.4, idle);
  const pip = pipValue(player.stats);
  check(`a pip for player 1 at ${every}s`, Math.abs(strikeState.charge - pip) < 1e-6, `charge ${strikeState.charge.toFixed(3)} (pip ${pip.toFixed(3)})`);
  check('...and one for player 2', Math.abs(p2.charge - CONFIG.strike.charge.chumRefill) < 1e-6, `charge ${p2.charge.toFixed(3)}`);
  settle(every * 2, idle);
  check('and they keep coming', strikeState.charge >= pip * 2.99 && p2.charge >= 0.59, `p1 ${strikeState.charge.toFixed(2)} p2 ${p2.charge.toFixed(2)}`);

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
  check('...and only turns up once drag has taken the pace off (or it hits the floor)', turned > 0.8 || ball.y <= bounds.bottom + ball.r + 0.01, `turned at ${turned.toFixed(2)}s`);
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
  const reach = ball.r + V.ball.contactRadius;
  p2.pos.set(ball.x - reach + 0.3, ball.y, 0);
  p2.vel.set(12, 0);
  p2.knockX = p2.knockY = 0;
  frame(idle);
  const share = 2 / (1 + V.ball.mass);
  check('a swim bump moves the ball by the seal\'s share of the closing speed', ball.vx > 0 && ball.vx < 12 * V.ball.bumpGain * share + 3, `vx=${ball.vx.toFixed(1)} (share ${share.toFixed(2)})`);
  check('...and the seal holds its ground against a still ball — no shove back', p2.knockX === 0 && p2.knockY === 0, `knock (${p2.knockX.toFixed(1)}, ${p2.knockY.toFixed(1)})`);
  away();

  // Recoil: a full strike throws the striker off the ball and ends its dash.
  resetBall();
  player.mesh.position.set(ball.x - reach + 0.4, ball.y, 0);
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
  const zoomMin = cam.zoomMin ?? 0.55;
  check('A: subjects a pitch apart → the frame zooms OUT to hold both, never under zoomMin', g.zoom < 1 && g.zoom >= zoomMin - 1e-9 && (p2.pos.x - player.mesh.position.x + 2 * cam.pad) * g.zoom <= frame.w + 1e-6, `zoom=${g.zoom.toFixed(3)} (floor ${zoomMin})`);
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
  check('the claim is never wider than zoomMin', claims.every((c) => c.zoom >= (cam.zoomMin ?? 0.55) - 1e-9));
  cam.mode = savedMode;
  cam.subject = savedSubject;
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
  const jet = fireGoalJet(-1, gy + 2);
  check('a jet fires and claims driven slots', !!jet && jet.parts.length === J.count && drivenCap().free < before.free, `${jet?.parts.length} lobes, reserve ${JSON.stringify(drivenCap())}`);
  check('every lobe is born inside the tunnel, behind the face', jet.parts.every((p) => p.x <= face - J.born[0] + 1e-6 && p.x >= face - tunnelDepth() - 1e-6), `x from ${Math.max(...jet.parts.map((p) => p.x)).toFixed(1)} to ${Math.min(...jet.parts.map((p) => p.x)).toFixed(1)} (screen edge ${edge.toFixed(1)}, face ${face.toFixed(1)})`);
  check('...inside the corridor\'s height', jet.parts.every((p) => p.y - p.size >= gy - h - 1e-6 && p.y + p.size <= gy + h + 1e-6));
  check('...aimed at the water', jet.parts.every((p) => p.vx > 0));
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
  check('...within a second of firing', Math.max(...[...outAt.values()].map((o) => o.t)) < 1, `last out at ${Math.max(...[...outAt.values()].map((o) => o.t)).toFixed(2)}s`);
  check('the jet lives and dies on the wall clock', goalJets().length === 0 && t <= J.life[1] + J.stagger + 0.1, `gone at ${t.toFixed(2)}s`);
  check('...and hands every slot back', drivenCap().free === before.free, JSON.stringify(drivenCap()));
  check('it fired through the live count', peakLive > 0 && goalJetState.fired >= 1);
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
  const reach = ball.r + V.ball.contactRadius;
  const restX = ball.x - reach - 12;
  player.mesh.position.set(restX, ball.y, 0);
  player.velocity.set(0, 0);
  settle(R.lead + 0.5); // history before the touch, so the lead has frames of THIS setup
  player.mesh.position.set(ball.x - reach + 0.4, ball.y, 0);
  player.velocity.set(40, 0);
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
  // THE BALL IS STILL THE SCORER'S. goal() used to clear the possession, so
  // the replay played the whole shot back with a white ball; the colour is
  // only given up at the kickoff, which is when the ball actually comes back.
  const gooBall = CONFIG.fx?.goo?.groups?.ball ?? {};
  check('the replay plays back in the scorer\'s colour, not white', ballLookState().owner === 0 && gooBall.tintMix > 0.05 && gooBall.tint === V.teams[0].color, `owner ${ballLookState().owner}, mix ${(gooBall.tintMix ?? 0).toFixed(2)}, tint ${(gooBall.tint ?? 0).toString(16)}`);
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
  check('the beats run impact → wide → explosion', beats.join(',') === 'impact,wide,explosion', beats.join(','));
  check('the impact shot tightens to its ceiling as the two collide', impactMaxZoom >= Math.min(R.impact.zoom, 4) - 1e-6, `tightest ${impactMaxZoom.toFixed(2)} (ceiling ${R.impact.zoom})`);
  check('the wide shot holds the mouth, the ball and the scorer, all of it', wideHoldsAll && wideCapped, `all in ${wideHoldsAll}, capped ${wideCapped}`);
  check('...opened out as a BLEND from the impact shot, no second cut', replayState.cuts === 1 && wideZoomMonotone, `cuts ${replayState.cuts}, monotone ${wideZoomMonotone}`);
  check('the replay carries the ball all the way to the line', Math.abs(maxBallX - goalX) < 0.5, `${maxBallX.toFixed(1)} vs ${goalX.toFixed(1)}`);
  check('the jet fires on the explosion beat, with the goal\'s own event', jetAt === 'explosion' && firedCount('versusGoal') === 2, `jet at ${jetAt}, versusGoal x${firedCount('versusGoal')}`);
  check('...and the scorer celebrates again, in frame', celebratedOn === 'explosion', `celebrated on ${celebratedOn}`);
  check('played slow', replayState.speed >= R.speed - 1e-9 && replayState.speed <= 1, `speed ${replayState.speed.toFixed(2)}`);
  check('...and no longer than maxWall plus the explosion', wall <= R.maxWall + R.explode + 0.2, `${wall.toFixed(2)}s`);
  check('then the shutter resumes where it was parked', versusState.phase === 'scored' && Math.abs(versusState.phaseT - parkedT) < dt * 2 && !replayState.active, `phase ${versusState.phase}, phaseT ${versusState.phaseT.toFixed(2)} (parked ${parkedT.toFixed(2)})`);
  check('...and into a kickoff', toPlay(), versusState.phase);

  // THE SKIP: a second goal, and a button held through its replay.
  resetBall();
  ball.x = bounds.right - 30; ball.y = midWater();
  p2.pos.set(bounds.left + 10, midWater() - 15, 0); p2.vel.set(0, 0);
  player.mesh.position.set(ball.x - reach + 0.4, ball.y, 0);
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
  player.mesh.position.set(ball.x - reach + 0.4, ball.y, 0);
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
  check('the ball went THROUGH — it is still travelling the way it was', ball.vx > 0 && ball.vx < before, `vx ${before} → ${ball.vx.toFixed(1)}`);
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
  const out = { move: new THREE.Vector2(), aim: new THREE.Vector2(), strikeHeld: false, strikeRelease: false, strike: false, aimLive: true, connected: false };
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
      p2.pos.set(ball.x - (ball.r + (V.ball.contactRadius ?? 2.2)) * 0.9, ball.y + (rnd() * 2 - 1) * 1.5, 0);
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
    me.pos.set(ball.x - (ball.r + (V.ball.contactRadius ?? 2.2)) * 0.9, gyy, 0);
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
  check('the camera\'s reach into the goal is past the line and inside the tunnel', cameraReach() > goalLineDepth() && cameraReach() < tunnelDepth(), `reach ${cameraReach().toFixed(1)}, line ${goalLineDepth().toFixed(1)}, tunnel ${tunnelDepth()}`);
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
  const reach = V.camera.reach;
  // THE LIGHT RUNS OFF THE FRAME. Its rectangle starts `spill` in front of the
  // drawn face and ends a whole camera reach past the TUNNEL'S BACK — further
  // out than any frame edge can be (screenEdgeX), so a camera pushed into the
  // goal never sees the light stop. The alpha is zero at all four rims
  // (GOAL_FALLOFF_GLSL), so there is no edge to see there either.
  const spanOf = (p) => {
    const side = p.position.x < 0 ? -1 : 1;
    const half = p.geometry.parameters.width / 2;
    return { side, near: p.position.x - side * half, far: p.position.x + side * half };
  };
  const spans = (p) => {
    const { side, near, far } = spanOf(p);
    return Math.abs(near - (rockX(side) - side * spill)) < 1e-6
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
  const leftPlane = holes.find((p) => p.position.x < 0);
  // The light's INNER end is measured off the drawn face, not the wall's line:
  // the spill into the water starts where the rock the player sees starts.
  const nearX = leftPlane ? leftPlane.position.x + leftPlane.geometry.parameters.width / 2 : NaN;
  check('...and the light\'s spill starts at the face, not the wall\'s line', Math.abs(nearX - (rockX(-1) + spill)) < 1e-6, `near end ${nearX.toFixed(2)} vs rock ${rockX(-1).toFixed(2)} + spill ${spill}`);
  check('the ball\'s posts are on the rock: a ball into the corner stops short of the wall\'s line', (() => {
    resetBall(); versusState.phase = 'play';
    ball.x = bounds.left + 10; ball.y = gy + h - ball.r * 0.4; ball.vx = -40; ball.vy = 0;
    versusState.lastPost = null;
    for (let i = 0; i < 30 && !versusState.lastPost; i++) frame();
    return !!versusState.lastPost && versusState.lastPost.x + ball.r > rockX(-1) - 1e-6 && versusState.lastPost.x - ball.r < bounds.left;
  })(), versusState.lastPost ? `hit at x=${versusState.lastPost.x.toFixed(2)}, rock ${rockX(-1).toFixed(2)}, wall ${bounds.left.toFixed(2)}` : 'no post hit');
  resetBall();
  // The F panel moves the light in place.
  const savedGlow = V.goal.glow; const savedSpill = V.goal.spill;
  V.goal.glow = savedGlow + 1; V.goal.spill = savedSpill + 2;
  const moved = refreshGoalGlow();
  check('the panel can move the light without a rebuild', moved === 2 && holes.every((p) => p.material.uniforms.uGlow.value === savedGlow + 1 && p.material.uniforms.uSpill.value === savedSpill + 2 && Math.abs(p.geometry.parameters.width - (tunnelDepth() + reach + (savedSpill + 2) * 2)) < 1e-6), `${moved} quad(s) refreshed`);
  // ...and the slab behind it follows, or the two would end in different
  // places and the step between them would be a seam in the water.
  check('...and the slab behind it moves with it', backs.every((p) => Math.abs(p.geometry.parameters.width - (tunnelDepth() + reach + (savedSpill + 2) * 2)) < 1e-6 && p.material.uniforms.uSpill.value === savedSpill + 2), backs.map((p) => `${p.geometry.parameters.width.toFixed(1)} wide`).join('; '));
  V.goal.glow = savedGlow; V.goal.spill = savedSpill; refreshGoalGlow();

  // THE SCORED MOUTH CHANGES HANDS. A goal goes into the light of the team
  // that conceded it; for the length of the envelope that light is the
  // SCORER'S colour and blazes, then it is handed back. On the wall clock.
  const lightOn = (side) => holes.find((p) => (p.position.x < 0 ? -1 : 1) === side);
  const colourOf = (p) => p.material.uniforms.uColor.value.getHexString();
  const ownHex = (side) => new THREE.Color(V.teams[side < 0 ? 0 : 1].color).getHexString();
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
  const reach = ball.r + V.ball.contactRadius;
  const still = () => { p2.vel.set(0, 0); p2.knockX = p2.knockY = 0; p2.active = false; p2.dashTimer = 0; p2.power = 0; };
  // The contest is the ball against a SEAL. Empty water for it: the ball goes
  // through fish now too (ballHits), and a bait ball left in its lane would
  // take a bite out of every speed measured below.
  resetEnemies(scene);
  // The ball flying +x at 40 into player 2 sitting in its path.
  resetBall();
  ball.vx = 40;
  p2.pos.set(ball.x + reach - 0.3, ball.y, 0);
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
  p2.pos.set(ball.x + reach - 0.3, ball.y, 0);
  still();
  let worstKnock = 0;
  for (let i = 0; i < 12; i++) { frame(); worstKnock = Math.max(worstKnock, p2.knockX); }
  check('the knock is paid once per pass, never a frame at a time', worstKnock <= K.knockMax + 1e-6, `peak knockX ${worstKnock.toFixed(1)} (cap ${K.knockMax})`);
  check('...and the ball keeps most of its speed through the seal', ball.vx > ballSpeedCap() * 0.5, `vx ${ball.vx.toFixed(1)}`);
  check('it went THROUGH — the ball is past the seal and the pass is over', ball.x - p2.pos.x > reach && ball.pierced[1] === false, `ball ${ball.x.toFixed(1)}, seal ${p2.pos.x.toFixed(1)}`);

  // A well struck shot through a slow defender: a seal drifting toward it
  // at a swim, the ball at a strike's speed.
  resetBall();
  ball.vx = -V.ball.maxSpeed;
  p2.pos.set(ball.x - reach + 0.3, ball.y, 0);
  still();
  p2.vel.set(10, 0);
  sealContact(1, p2.pos, p2.vel, false, null, 0);
  check('a full-speed shot goes through a defender swimming at it', ball.vx < -V.ball.maxSpeed * 0.45 && p2.knockX < -20, `vx ${ball.vx.toFixed(1)}, knockX ${p2.knockX.toFixed(1)}`);

  // Equal and opposite: the seal holds its ground and the ball is stopped.
  resetBall();
  ball.vx = -20;
  p2.pos.set(ball.x - reach + 0.3, ball.y, 0);
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
  p2.pos.set(ball.x - reach + 0.3, ball.y, 0);
  still();
  p2.vel.set(30, 0);
  sealContact(1, p2.pos, p2.vel, false, null, 0);
  check('a seal out-swimming the ball pushes it and takes no knock', ball.vx > 0 && p2.knockX === 0, `vx ${ball.vx.toFixed(1)}, knockX ${p2.knockX.toFixed(1)}`);

  // THE COUNTER-STRIKE. The ball coming in at maxSpeed; a full wind-up dash
  // meets it: the strike holds (dashMass x dash speed beats the ball) and
  // sends it back FASTER than maxSpeed — up to returnMax x what came in.
  resetBall();
  ball.vx = V.ball.maxSpeed;
  p2.pos.set(ball.x + reach - 0.3, ball.y, 0);
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
  p2.pos.set(ball.x + reach - 0.3, ball.y, 0);
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
    pos.set(ball.x - dir * (reach - 0.3), ball.y, 0);
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
  const park = () => {
    strikeState.active = false; p2.active = false; p2.dashTimer = 0;
    player.velocity.set(0, 0); p2.vel.set(0, 0);
    player.knockX = player.knockY = 0; p2.knockX = p2.knockY = 0;
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
  check('...and carries an air meter for each seal in their place', (src.match(/sv-versus-o2/g) ?? []).length >= 3);
  const tutAt = main.indexOf('updateTutorial(realDt');
  const tut = main.slice(tutAt, main.indexOf('WHATEVER THE TIP IS ABOUT', tutAt));
  const tutGate = tut.match(/\}, bandLive[^\n]*\);/)?.[0] ?? '';
  check('the tutorial is gated off in a match', tutGate.includes('!versusActive()'), tutGate || 'no gate found');
  const callouts = main.slice(main.indexOf('updateCallouts(realDt'), main.indexOf('updateGreeting(realDt'));
  check('...as the coach\'s band and the hello already are', callouts.includes('!versusActive()') && main.slice(main.indexOf('updateGreeting(realDt'), main.indexOf('updateGreeting(realDt') + 200).includes('!versusActive()'));
}

// ---------------------------------------------------------------------------
section('Reset hands everything back');
{
  const slotsBefore = ball.slots.length;
  resetVersus();
  resetParticles();
  check('the ball\'s slots are released', ball.slots.length === 0 && slotsBefore > 0);
  check('the mode is off', !versusState.active && !ball.live);
  check('the arena\'s mouths are taken back', !goalHolesInstalled());
  check('a clock tick off-mode is a no-op', updateVersusClock(dt) === 1);
  resetEnemies(scene);
  enableVersus(false);
  check('the flag can be dropped again', !versusActive());
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
