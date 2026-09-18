#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:finflick
//
// THE FIN FLICK — a swipe of the aim across a ball in flight, and the spin it
// leaves on it. See systems/finFlick.js for the gesture and the geometry and
// finFlickBall in systems/versus.js for the friction.
//
// WHY A HARNESS AND NOT A PLAYTEST. Every one of the four things that can be
// wrong here is invisible from inside a match:
//
//   THE REACH   `reach` and `sweep` are world units against a flipper that
//               moves every frame. A hitbox that is too small reads exactly
//               like a mechanic that does not work, and a hitbox that is far
//               too big reads like nothing at all until somebody notices they
//               are bending shots they never went near.
//   THE SIGN    a drag that spins the ball the wrong way still spins it. The
//               curve is a second-long effect on a ball already travelling, so
//               nobody watching a match can tell "it curved" from "it curved
//               the way I swiped".
//   THE ONCE    one connect per window. Two fins both landing, or one fin
//               landing on six consecutive frames, is a mechanic that looks
//               fine and is six times as strong as it reads.
//   THE ECONOMY a flick must not move the ball. If `squirt` can add speed it
//               is a free strike with no wind-up, which is the whole economy
//               of a match gone.
//
// THE SEAL HAS NO FLIPPERS IN NODE. No GLB loads here, so player.aimRig is a
// stand-in with no muzzles — see the memory note about a harness measuring the
// stand-in. So the rig is built by hand: two Vector3 muzzles placed where the
// test wants them, which is also the only way to ask the reach question at all
// (a real rig's fins are wherever the animation clip left them).
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enableVersus } from '../path/src/systems/versusFlag.js';
import { bounds, updateBounds, midWater } from '../path/src/arena.js';
import { player, initPlayer, resetPlayer } from '../path/src/entities/player.js';
import { initParticles } from '../path/src/entities/particles.js';
import { onFeedback } from '../path/src/systems/feedback.js';
import {
  versusState, ball, startVersus, resetVersus, updateVersus, updateVersusClock,
  resetBall, matchSeals, seatOf, sealPos, finFlickBall, ballHitRadiusAt, solveBallSurface,
} from '../path/src/systems/versus.js';
import {
  finFlickState, resetFinFlick, openFinFlick, updateFinFlick, finFlickNearest,
} from '../path/src/systems/finFlick.js';

const scene = new THREE.Scene();
const dt = 1 / 60;
let failures = 0;
let seed = 0x5ea15ea1;
Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && /^\[(animation|assets|uiText)\]/.test(msg)) return;
  realWarn(msg, ...rest);
};
console.info = () => {};

function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}
function note(text) { console.log(`        ${text}`); }

const F = CONFIG.versus.ball.finFlick;
CONFIG.versus.bot.enabled = false;

// A rig with flippers, since Node has none. `kicked` records what the twitch
// was asked for: the swipe's own kick is half the feedback and is invisible to
// everything else here.
function rigAt(points) {
  const kicked = [];
  return {
    muzzles: points.map((p) => new THREE.Vector3(p[0], p[1], 0)),
    kickFin: (i, s) => kicked.push([i, s]),
    kicked,
  };
}

const fired = new Map();
onFeedback((name) => fired.set(name, (fired.get(name) ?? 0) + 1));
const count = (name) => fired.get(name) ?? 0;

enableVersus(true);
updateBounds(16 / 9);
// THE SEAL HAS TO EXIST. The swipe's own voice is gated on how far the ball is
// from `player.mesh.position` (see `swipeNear`), and without this that is null
// — the harness would throw on the first window opened inside a real frame.
initPlayer(scene);
initParticles(scene);
resetPlayer();
startVersus(scene);
for (let t = 0; t < 14 && versusState.phase !== 'play'; t += dt) {
  const scale = updateVersusClock(dt, []);
  updateVersus(dt * scale, []);
}
// Out of everyone's way: a seal drifting into the ball would nudge it and the
// velocity assertions below would be measuring a body check.
for (const seal of matchSeals()) {
  sealPos(seal).set(-400 - seatOf(seal) * 12, midWater() - 60, 0);
  seal.velocity.set(0, 0);
}

// The ball, parked where the test puts it, with a clean slate every time.
function park(x, y, vx = 0, vy = 0, spin = 0) {
  resetBall();
  ball.live = true;
  ball.x = x; ball.y = y;
  ball.vx = vx; ball.vy = vy;
  ball.spin = spin;
  solveBallSurface();
}

// One swipe, resolved: opens a window in (gx, gy) and runs the contact once.
function swipe(rig, gx, gy) {
  resetFinFlick();
  const opened = openFinFlick(gx, gy, rig);
  const hit = opened ? finFlickBall(0, rig) : false;
  return { opened, hit };
}

// ---------------------------------------------------------------------------
section('The window: a swipe opens one, and a hand that keeps moving does not open six');
{
  resetFinFlick();
  const rig = rigAt([[0, 0], [0, 0]]);
  const input = { aimMoved: true, aimGesture: new THREE.Vector2(0, 1) };
  updateFinFlick(dt, input, rig);
  check('a gesture opens a window', finFlickState.live > 0 && finFlickState.opened === 1,
    `live ${finFlickState.live.toFixed(3)}, opened ${finFlickState.opened}`);
  check('...and both flippers twitch on the swipe itself', rig.kicked.length === 2, JSON.stringify(rig.kicked));

  // The hand keeps moving for a full second. aimMoved is true on every one of
  // those frames — the gate is the cooldown, not an edge on the flag.
  for (let t = 0; t < 1; t += dt) updateFinFlick(dt, input, rig);
  const want = Math.floor(1 / F.cooldown) + 1;
  check('a continuous sweep is one flick per cooldown, not one per frame',
    finFlickState.opened >= want - 1 && finFlickState.opened <= want + 1,
    `${finFlickState.opened} in 1 s at cooldown ${F.cooldown} (expected ~${want})`);

  resetFinFlick();
  updateFinFlick(dt, { aimMoved: false, aimGesture: new THREE.Vector2(0, 1) }, rig);
  check('a still hand opens nothing', finFlickState.opened === 0 && finFlickState.live === 0);

  resetFinFlick();
  updateFinFlick(dt, { aimMoved: true, aimGesture: new THREE.Vector2(0, 0) }, rig);
  check('...and neither does a gesture with no direction in it', finFlickState.opened === 0);

  // The window outlives the hand: a swipe is committed to by the time it is read.
  resetFinFlick();
  openFinFlick(0, 1, rig);
  updateFinFlick(dt, { aimMoved: false, aimGesture: new THREE.Vector2(0, 0) }, rig);
  check('the window stays open after the hand stops', finFlickState.live > 0,
    `${finFlickState.live.toFixed(3)} s left`);
  for (let t = 0; t < F.duration + dt * 2; t += dt) {
    updateFinFlick(dt, { aimMoved: false, aimGesture: new THREE.Vector2(0, 0) }, rig);
  }
  check('...and closes after `duration`', finFlickState.live === 0);
}

// ---------------------------------------------------------------------------
section('The hitbox is bigger than the fin, and only while the window is open');
{
  const edge = ballHitRadiusAt(0);
  park(0, midWater(), 0, 0);
  // The fin sits `reach + edge` short of the ball along -x, so the ball is
  // exactly at the limit; the swipe runs +y, across it.
  const rig = rigAt([[-(F.reach + edge) * 0.8, midWater()], [-999, -999]]);
  check('a ball inside the reach connects', swipe(rig, 0, 1).hit);

  park(0, midWater());
  const far = rigAt([[-(F.reach + edge) * 1.35, midWater()], [-999, -999]]);
  check('...and one past it does not', !swipe(far, 0, 1).hit);

  // THE SWEEP is the arc the fin travels, and it is what lets a swipe that
  // STARTS short of the ball still reach it. Asked of the geometry rather than
  // of the connect, because a ball dead ahead down the swipe is a swipe at its
  // CENTRE and has no drag in it whichever way the capsule reaches — see the
  // `bite` check in the next section. Both halves are real and they are
  // different questions.
  park(0, midWater());
  const finBelow = midWater() - (F.sweep + (F.reach + edge) * 0.8);
  const down = rigAt([[0, finBelow], [-999, -999]]);
  resetFinFlick();
  openFinFlick(0, 1, down);
  const near = finFlickNearest(down, ball.x, ball.y);
  check('the swept capsule reaches a ball the fin itself is nowhere near',
    !!near && near.dist < F.reach + edge,
    `fin ${(midWater() - finBelow).toFixed(2)} u away, capsule spine ${near?.dist.toFixed(2)} (reach ${F.reach} + edge ${edge.toFixed(2)})`);

  // ...and the same fin with the swipe pointing the other way cannot see it,
  // which is what makes the capsule a capsule and not a bigger circle.
  resetFinFlick();
  openFinFlick(0, -1, down);
  const behind = finFlickNearest(down, ball.x, ball.y);
  check('...and cannot when the swipe goes the other way',
    !behind || behind.dist >= F.reach + edge, `spine ${behind?.dist.toFixed(2)}`);

  // The one that matters in a match: a ball OFF the swipe's line, so the wipe
  // crosses its face. Reached by the sweep and struck with english.
  park(F.reach * 0.6, midWater());
  const past = rigAt([[0, midWater() - (F.sweep + edge) * 0.7], [-999, -999]]);
  check('a ball off to the side of a long swipe connects', swipe(past, 0, 1).hit,
    `ball ${(F.reach * 0.6).toFixed(2)} u off the line, fin ${(midWater() - past.muzzles[0].y).toFixed(2)} u back`);

  // No window, no hitbox.
  park(0, midWater());
  resetFinFlick();
  check('a fin on top of the ball with no window open is not a hitbox',
    finFlickNearest(rigAt([[0, midWater()]]), ball.x, ball.y) === null);
}

// ---------------------------------------------------------------------------
section('What it does to the ball: spin, the right way round, and nothing else');
{
  const edge = ballHitRadiusAt(0);
  const finX = -(F.reach + edge) * 0.6;
  // The fin is to the LEFT of the ball, so the contact normal points +x and
  // the tangent (-ny, nx) points +y. A swipe along +y is a positive slip,
  // which strikeBall's convention turns into a CLOCKWISE (negative) spin.
  park(0, midWater());
  const up = swipe(rigAt([[finX, midWater()]]), 0, 1);
  const spinUp = ball.spin;
  check('a crosswise swipe puts spin on', up.hit && Math.abs(spinUp) > 1, `${spinUp.toFixed(2)} rad/s`);
  check('...clockwise for a swipe along the tangent, as strikeBall reads it', spinUp < 0);

  park(0, midWater());
  swipe(rigAt([[finX, midWater()]]), 0, -1);
  check('...and the other way for the opposite swipe', ball.spin > 0, `${ball.spin.toFixed(2)} rad/s`);
  check('...by the same amount', Math.abs(Math.abs(ball.spin) - Math.abs(spinUp)) < 1e-6);

  // A swipe straight into the centre has no drag in it, so it is refused
  // rather than connecting and doing nothing.
  park(0, midWater());
  const square = swipe(rigAt([[finX, midWater()]]), 1, 0);
  check('a swipe straight at the centre does not count as a connect', !square.hit);
  check('...and leaves the ball alone', ball.spin === 0 && ball.vx === 0 && ball.vy === 0);

  // THE ECONOMY. A ball travelling at a match's pace, flicked: the spin moves
  // and the speed barely does.
  park(0, midWater(), 40, 0);
  const before = Math.hypot(ball.vx, ball.vy);
  const fast = swipe(rigAt([[finX, midWater()]]), 0, 1);
  const after = Math.hypot(ball.vx, ball.vy);
  check('a flick on a moving ball connects', fast.hit);
  check('...and does not speed it up', after <= before + 0.5, `${before.toFixed(1)} → ${after.toFixed(1)} u/s`);
  note(`the line turned ${(Math.abs(Math.atan2(ball.vy, ball.vx)) * 180 / Math.PI).toFixed(1)}°, spin ${ball.spin.toFixed(1)} rad/s`);

  // The cap the physics clamps at is the cap a flick respects.
  const spinCap = CONFIG.versus.ball.impact.spinCap ?? 28;
  park(0, midWater(), 0, 0, -spinCap * 0.98);
  swipe(rigAt([[finX, midWater()]]), 0, 1);
  check('a ball already at the spin cap is not spun past it', Math.abs(ball.spin) <= spinCap + 1e-6,
    `${ball.spin.toFixed(2)} vs cap ${spinCap}`);
  // THE DRAG IS SELF-LIMITING, which is what stops a swirling mouse loading a
  // ball to the cap and holding it there: the face's own surface speed is
  // subtracted from the wipe, so each flick along a spin already on the ball
  // buys less than the one before it, and the third buys almost nothing.
  park(0, midWater());
  const steps = [];
  for (let i = 0; i < 3; i++) {
    const was = ball.spin;
    swipe(rigAt([[finX, midWater()]]), 0, 1);
    steps.push(ball.spin - was);
  }
  check('each flick along an existing spin buys less than the last',
    Math.abs(steps[1]) <= Math.abs(steps[0]) + 1e-6 && Math.abs(steps[2]) < Math.abs(steps[1]),
    steps.map((v) => v.toFixed(2)).join(' → '));
  check('...and three of them cannot pass the cap', Math.abs(ball.spin) <= spinCap + 1e-6,
    `${ball.spin.toFixed(2)} vs cap ${spinCap}`);
}

// ---------------------------------------------------------------------------
section('One connect per window, whichever fin gets there');
{
  const edge = ballHitRadiusAt(0);
  const finX = -(F.reach + edge) * 0.6;
  park(0, midWater());
  // BOTH fins on the ball. One swipe is one event.
  const rig = rigAt([[finX, midWater()], [finX, midWater() + 0.3]]);
  resetFinFlick();
  openFinFlick(0, 1, rig);
  const first = finFlickBall(0, rig);
  const spin1 = ball.spin;
  const again = finFlickBall(0, rig);
  check('the first fin connects', first && Math.abs(spin1) > 1);
  check('...and the second does not double the spin', !again && ball.spin === spin1,
    `${ball.spin.toFixed(2)} rad/s`);
  // Nor does holding still inside the window for the rest of its frames.
  for (let t = 0; t < F.duration; t += dt) finFlickBall(0, rig);
  check('...and neither do the rest of the window\'s frames', ball.spin === spin1);
  check('the connect is counted once', finFlickState.connected === 1, `${finFlickState.connected}`);
  check('...and remembered, for the debug mark', !!finFlickState.last && finFlickState.last.fin === 0);
}

// ---------------------------------------------------------------------------
section('It says so when it lands');
{
  const edge = ballHitRadiusAt(0);
  const finX = -(F.reach + edge) * 0.6;
  const def = CONFIG.feedback.versusFinFlick;
  check('the connect is a row in CONFIG.feedback', !!def);
  check('...with a voice that exists', !!def?.sfx && !!CONFIG.sfx[def.sfx], `sfx ${def?.sfx}`);
  check('...and a picture', !!def?.emit || !!def?.goo);
  // NO FREEZE. A flick is not a collision, and somebody else's shot may still
  // be in the air when one lands.
  check('...and no hit-stop at all', (def?.hitstop ?? 0) === 0, `hitstop ${def?.hitstop}`);

  const before = count('versusFinFlick');
  park(0, midWater());
  const rig = rigAt([[finX, midWater()]]);
  const landed = swipe(rig, 0, 1);
  check('a connect fires it', landed.hit && count('versusFinFlick') === before + 1,
    `${count('versusFinFlick') - before} fired`);
  check('...and the fin that landed twitches again over the swipe\'s own kick',
    rig.kicked.length >= 2 && rig.kicked[rig.kicked.length - 1][0] === 0,
    JSON.stringify(rig.kicked));

  const missBefore = count('versusFinFlick');
  park(0, midWater());
  swipe(rigAt([[-999, -999]]), 0, 1);
  check('a swipe that reaches nothing fires nothing', count('versusFinFlick') === missBefore);

  // The possession ledger saw it: a ball bent into a goal must not credit
  // whoever last struck it.
  park(0, midWater(), 40, 0);
  swipe(rigAt([[finX, midWater()]]), 0, 1);
  const touch = versusState.lastTouch;
  check('a connect is booked as a touch', !!touch && touch.who === 0 && touch.kind === 'flick',
    JSON.stringify(touch && { who: touch.who, kind: touch.kind }));
}

// ---------------------------------------------------------------------------
section('The swipe has a voice of its own, and it is not a metronome');
{
  const def = CONFIG.feedback.versusFinSwipe;
  check('the swipe is a row in CONFIG.feedback', !!def);
  check('...with a voice that exists', !!def?.sfx && !!CONFIG.sfx[def.sfx], `sfx ${def?.sfx}`);
  // SOUND ONLY. The picture is already on the animal — both flippers twitch on
  // every swipe — and particles off a seal that touched nothing would be the
  // game reporting a hit that did not happen.
  check('...and no picture, because a miss must not look like a hit',
    !def?.emit && !def?.goo && !(def?.glow > 0),
    `emit ${def?.emit}, goo ${def?.goo}, glow ${def?.glow}`);

  // ...and the connect no longer borrows the ball's splash.
  const hitDef = CONFIG.feedback.versusFinFlick;
  check('the connect has a picture of its own', hitDef.emit === 'finFlickWipe', `emit ${hitDef.emit}`);
  const wipe = CONFIG.emitters.finFlickWipe;
  check('...which is a real emitter', !!wipe);
  // The shape is the whole point: a fan along the wipe, not a burst and not a
  // streak. Measured against the two it sits between rather than asserted as
  // numbers, so a retune of any of the three keeps the relationship honest.
  check('...narrower than the ball\'s splash and wider than the spike\'s smear',
    wipe.cone < CONFIG.emitters.ballSplash.cone && wipe.cone > CONFIG.emitters.spikeSmear.cone,
    `smear ${CONFIG.emitters.spikeSmear.cone} < wipe ${wipe.cone} < splash ${CONFIG.emitters.ballSplash.cone}`);
  // It belongs to the FIN, so it stays where the flipper was. The smear
  // belongs to the ball and leaves with it — the opposite end of `inherit`,
  // and that difference is the read.
  check('...and it stays with the fin rather than leaving with the ball',
    wipe.inherit < CONFIG.emitters.spikeSmear.inherit,
    `wipe ${wipe.inherit} vs smear ${CONFIG.emitters.spikeSmear.inherit}`);

  // Driven through updateVersus, because the distance gate is a fact about a
  // match and lives there rather than in finFlick.js.
  const gesture = { aimMoved: true, aimGesture: new THREE.Vector2(0, 1) };
  const swipes = () => count('versusFinSwipe');
  function drive(ballAt) {
    resetFinFlick();
    park(ballAt.x, ballAt.y);
    const before = swipes();
    const scale = updateVersusClock(dt, []);
    updateVersus(dt * scale, [], gesture);
    return swipes() - before;
  }
  player.mesh.position.set(0, midWater(), 0);
  player.velocity.set(0, 0);
  const near = CONFIG.versus.ball.finFlick.swipeNear;
  check('a swipe near the ball is heard even when it reaches nothing',
    drive({ x: near * 0.5, y: midWater() }) === 1, `${near * 0.5} u away, gate ${near}`);
  check('...and one at the other end of the pitch is not',
    drive({ x: near * 2.5, y: midWater() }) === 0, `${near * 2.5} u away, gate ${near}`);
  // The gate is the DISTANCE and not the cooldown: a hand held still opens no
  // window, so it makes no sound however close the ball is.
  resetFinFlick();
  park(near * 0.5, midWater());
  const still = swipes();
  const sc = updateVersusClock(dt, []);
  updateVersus(dt * sc, [], { aimMoved: false, aimGesture: new THREE.Vector2(0, 0) });
  check('a still hand next to the ball is silent', swipes() === still);
}

// ---------------------------------------------------------------------------
section('The switches');
{
  const edge = ballHitRadiusAt(0);
  const finX = -(F.reach + edge) * 0.6;
  const was = F.enabled;
  F.enabled = false;
  park(0, midWater());
  const rig = rigAt([[finX, midWater()]]);
  resetFinFlick();
  check('off means no window opens', !openFinFlick(0, 1, rig));
  check('...and nothing touches the ball', !finFlickBall(0, rig) && ball.spin === 0);
  F.enabled = was;

  resetFinFlick();
  openFinFlick(0, 1, rig);
  resetFinFlick();
  check('a reset closes the window', finFlickState.live === 0 && finFlickState.opened === 0);

  // THE AIM LINE IS OFF IN A MATCH. Two halves, and the second is the one that
  // matters: the flag defaults off, and main.js actually reads it. Asserted
  // against the source because the call it gates is inside the render loop.
  check('the aim indicator is off in a match by default', CONFIG.aimIndicator.inVersus === false);
  const mainSrc = await import('node:fs').then((fs) => fs.promises.readFile('path/src/main.js', 'utf8'));
  check('...and main.js gates the indicator on it',
    /versusActive\(\)\s*&&\s*!CONFIG\.aimIndicator\.inVersus/.test(mainSrc));
}

resetVersus();
console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
