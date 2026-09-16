#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:goalblast
//
// THE GOAL EXPLOSION, AND THE KICKOFF AFTER IT — the three ways a blast can
// wreck the animal it throws, and the one way a kickoff can put it back wrong.
//
// None of this is visible to tools/versus-test.mjs, and that is not an
// oversight in it — it is the reason all four of these shipped. That harness
// poses the seals with a two-line stand-in (poseFromSwim) and never calls
// updatePlayer or poseBody at all, so the mirror, the jolt springs and the
// speed clamp are simply not running while it watches. Everything below drives
// the REAL updatePlayer, and the skeleton section drives the real furseal.glb.
//
//   THE SEAL STANDS ON ITS BACK   A kickoff hard-sets mesh.rotation.z and then
//                            cleared `mirrored` so poseBody would work the side
//                            -view half-roll out afresh. poseBody cannot:
//                            it resolves the mirror inside its
//                            `dirLen > minTurn` branch, and holdKickoff zeroes
//                            every velocity on every frame of the count. So a
//                            seal whose spot faces the other way from the play
//                            it just came out of stood BELLY-UP through "3, 2,
//                            1" and past the whistle. On the opening kickoff it
//                            was whichever side faces left, every match.
//
//   THE RAGDOLL OUTLIVES THE GOAL  The blast fires on the frame the ball goes
//                            in — which is the one frame the match drops to
//                            CONFIG.versus.clock.freezeScale, four percent, for
//                            the shutter and the whole replay. A tumble
//                            spending the water's seconds there ran a 1.6
//                            second ragdoll over FORTY wall seconds: the seals
//                            were still limp and still turning when the replay
//                            opened over them, and nothing ever ended it but
//                            the kickoff snapping the bodies onto their marks.
//                            It reads as the skeleton breaking on the goal and
//                            carrying into the replay. Measured in WALL
//                            seconds here, because that is the only clock the
//                            claim is true or false on.
//
//   A BIG SHOVE TEARS THE MESH  Every rate a blast hands the body was
//                            unbounded and scaled straight off `push`. Asked
//                            for the thing this change is FOR — a huge
//                            impulse — the same number that throws the body
//                            further also spins it faster, and past a few turns
//                            a second the loose chains are chasing a pose that
//                            jumps most of a circle between frames. Checked by
//                            asking for numbers nobody would ever tune to.
//
//   THE THROW GOES NOWHERE   ...and the thing that made raising `push` tempting
//                            in the first place: it did not move anybody. Both
//                            halves of a jostle saturate — the velocity share
//                            is clipped by the seal's own top speed on the
//                            frame it lands, the knock offset is capped and
//                            decays — so forty times the shipped `push` moved a
//                            seal the same 46 units twice the shipped `push`
//                            did, peaked at the same 33 u/s, and never reached
//                            a wall. `launch` is the throw that does, and it is
//                            checked to actually cross the pitch and bounce.
//
// What it cannot tell you is whether any of it looks good.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import './dom-stub.mjs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CONFIG } from '../path/src/config.js';
import { enableVersus } from '../path/src/systems/versusFlag.js';
import { bounds, updateBounds, midWater } from '../path/src/arena.js';
import {
  player, initPlayer, resetPlayer, rebuildShipBody, updatePlayer, tumbleSeal, flingSeal,
  faceSeal, setJoltWallDt, setJoltPaused,
} from '../path/src/entities/player.js';
import { strikeState, resetStrike } from '../path/src/systems/strike.js';
import { initParticles } from '../path/src/entities/particles.js';
import {
  versusState, startVersus, resetVersus, updateVersus, updateVersusClock, enterKickoff,
  matchSeals, seatOf, goalBlast, replayState, ball, p2, resetBall, ballContactReach,
  solveBallSurface, replayHoldsInput,
} from '../path/src/systems/versus.js';
import { rockX, mouthY, tunnelDepth } from '../path/src/systems/versusGoal.js';
import { ASSETS, installModel } from '../path/src/assets.js';

// The controller warns for every state the procedural stand-in has no clip for,
// and the name tables warn about their own rows. Neither is this file's news.
const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && /^\[(animation|sealNames|jaw)\]/.test(msg)) return;
  realWarn(msg, ...rest);
};

let failures = 0;
function section(name) { console.log(`\n${name}`); }
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}
function note(text) { console.log(`        ${text}`); }

const DT = 1 / 60;
const V = () => CONFIG.versus;
const BLAST = () => V().goalJet.blast;
const JOLT = () => CONFIG.player.jolt;

enableVersus(true);
updateBounds(16 / 9);
const scene = new THREE.Scene();
initPlayer(scene);
initParticles(scene);

// THE REAL ANIMAL, FOR THE WHOLE FILE. The procedural stand-in has no bones at
// all, so `setLimp` returns false on it and `jolt.limp` never goes up — every
// claim below about the ragdoll being taken and handed back would pass by
// never happening. Loaded here rather than in the last section for that
// reason: the sections that only need numbers do not mind, and the ones that
// need a skeleton cannot be written without one.
const MODEL = fileURLToPath(new URL('../public/models/furseal.glb', import.meta.url));
const haveModel = existsSync(MODEL);
if (haveModel) {
  const buf = readFileSync(MODEL);
  const gltf = await new GLTFLoader().parseAsync(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
  );
  installModel('ship', gltf.scene, gltf.animations);
  rebuildShipBody();
}
resetPlayer();
resetStrike();

const noPads = [];
const idle = { move: new THREE.Vector2(0, 0), aim: new THREE.Vector2(1, 0), strikeHeld: false, dash: false };
const swim = (x, y) => ({ move: new THREE.Vector2(x, y), aim: new THREE.Vector2(x, y), strikeHeld: false, dash: false });

/** One whole frame the way main.js runs one: the wall clock, then the world on the dilated one. */
function frame(input = idle) {
  setJoltWallDt(DT);
  const scale = updateVersusClock(DT, noPads);
  // main.js's order, and its two published facts: the wall clock above, and
  // whether a replay is holding the live world off the bodies. Both are read
  // by entities/player.js and neither has a default that is right — a harness
  // that skips them is testing a game nobody plays.
  setJoltPaused(replayHoldsInput());
  updatePlayer(DT * scale, input);
  updateVersus(DT * scale, noPads);
  return scale;
}
function toPlay(limit = 12) {
  for (let t = 0; t < limit && versusState.phase !== 'play'; t += DT) frame();
  return versusState.phase === 'play';
}

/**
 * IS THIS SEAL ON ITS BACK? The two fields that between them say which way up
 * an animal in side view is: where its nose points, and the half-roll that is
 * supposed to keep its belly down while it points there. They agree or the
 * seal is upside down; there is no third answer.
 */
function bellyUp(seal) {
  if (CONFIG.view !== 'side') return false;
  const facingX = Math.cos(seal.mesh.rotation.z + Math.PI / 2);
  const wantMirror = facingX < 0;
  // Wrapped, because the mirror angle walks up through whole half turns.
  const rolled = Math.abs(Math.atan2(Math.sin(seal.mirrorAngle), Math.cos(seal.mirrorAngle))) > Math.PI / 2;
  return wantMirror !== rolled;
}
const upsideDown = () => [...matchSeals()].filter(bellyUp).map(seatOf);

// ---------------------------------------------------------------------------
section('EVERY SEAL IS THE RIGHT WAY UP ON A KICKOFF — and stays up through the count');
{
  startVersus(scene);
  check('the match opens on a kickoff', versusState.phase === 'kickoff', `phase ${versusState.phase}`);
  // Before a single frame: the placement itself has to be right, because the
  // count holds the bodies still and nothing later gets a chance to fix it.
  check('...with nobody on their back on the frame the seals are placed',
    upsideDown().length === 0, `seats ${JSON.stringify(upsideDown())}`);
  for (let i = 0; i < 20; i++) frame();
  check('...still nobody, twenty frames into the count', upsideDown().length === 0, `seats ${JSON.stringify(upsideDown())}`);
  check('the count runs out into play', toPlay(), `phase ${versusState.phase}`);
  check('...and nobody came out of the whistle inverted', upsideDown().length === 0, `seats ${JSON.stringify(upsideDown())}`);

  // THE ONE THAT ACTUALLY BROKE. A kickoff called after a play that left a
  // seal facing the OTHER way — which is every kickoff after a goal at one end
  // — puts it on a spot facing back the way it came.
  for (let i = 0; i < 180; i++) frame(swim(-1, 0));
  const turned = [...matchSeals()].filter((s) => Math.cos(s.mesh.rotation.z + Math.PI / 2) < 0).length;
  note(`${turned} of ${[...matchSeals()].length} seals ended the play facing left`);
  check('a play that turns the seals round leaves them upright', upsideDown().length === 0, `seats ${JSON.stringify(upsideDown())}`);
  enterKickoff();
  check('...and the kickoff it calls does too, on the frame it is called',
    upsideDown().length === 0, `seats ${JSON.stringify(upsideDown())}`);
  for (let i = 0; i < 60; i++) frame();
  check('...a second into the count, with the bodies held on their marks',
    upsideDown().length === 0, `seats ${JSON.stringify(upsideDown())}`);
  check('...and at the whistle', toPlay() && upsideDown().length === 0, `seats ${JSON.stringify(upsideDown())}`);

  // The mechanism, on its own. A hard placement writes BOTH fields or it has
  // not placed the seal — this is the one call that is allowed to do it.
  faceSeal(player, Math.PI);              // straight at the left wall
  check('faceSeal points the nose where it was asked',
    Math.abs(Math.cos(player.mesh.rotation.z + Math.PI / 2) + 1) < 1e-6);
  check('...and rolls the belly down to match', !bellyUp(player), `mirrorAngle ${player.mirrorAngle.toFixed(2)}`);
  faceSeal(player, 0);                    // and back
  check('...both ways round', !bellyUp(player), `mirrorAngle ${player.mirrorAngle.toFixed(2)}`);
  check('...settled rather than mid-turn, so it cannot roll on the spot', player.mirrorT === 1);
}

// ---------------------------------------------------------------------------
section("THE RAGDOLL RUNS ON ITS OWN CLOCK — a goal's tumble ends inside the goal");
{
  const want = BLAST().tumbleFor;
  const freeze = V().clock.freezeScale;
  // How long a tumble of `want` GAME seconds actually lasts, in WALL seconds,
  // with the world running at `scale`. The goal blast only ever fires at the
  // second one.
  function wallSecondsOfRagdoll(scale) {
    resetPlayer();
    for (let i = 0; i < 30; i++) { setJoltWallDt(DT); updatePlayer(DT * scale, idle); }
    tumbleSeal(player, -BLAST().spin * BLAST().push, BLAST().roll * BLAST().push, want, 1, 0, 8);
    let wall = 0;
    while (player.jolt.free > 0 && wall < 300) {
      setJoltWallDt(DT);
      updatePlayer(DT * scale, idle);
      wall += DT;
    }
    return wall;
  }
  const live = wallSecondsOfRagdoll(1);
  const frozen = wallSecondsOfRagdoll(freeze);
  note(`a ${want}s tumble: ${live.toFixed(2)} wall s in live play, ${frozen.toFixed(2)} wall s under the shutter (was ${(want / freeze).toFixed(0)})`);
  check('in live play a tumble lasts about what it asked for',
    Math.abs(live - want) < 0.1, `${live.toFixed(2)}s vs ${want}s`);
  // The claim with teeth: the goal's shutter and the replay it opens are a
  // handful of WALL seconds, and the ragdoll has to be over inside them.
  const replayLength = (V().clock.freeze ?? 0.35)
    + (V().replay?.explode ?? 1.3) + (V().replay?.celebrateHold ?? 1.7);
  check('...and under the goal shutter it is not stretched past the goal itself',
    frozen < replayLength, `${frozen.toFixed(2)} wall s against ${replayLength.toFixed(2)}s of shutter and replay`);
  check('...which is the whole point: it used to outlast them many times over',
    frozen < want / freeze * 0.2, `${frozen.toFixed(2)}s, where the water's clock gave ${(want / freeze).toFixed(0)}s`);
  check('the mix is short of the wall clock, so the tumble still slows with the water',
    (JOLT().clock ?? 0.85) < 1 && frozen > live, `clock ${JOLT().clock}, ${frozen.toFixed(2)}s vs ${live.toFixed(2)}s`);
  // With nobody publishing a wall clock — every harness, look page and title
  // screen — the water's clock is all there is and nothing may change.
  setJoltWallDt(-1);
  const unpublished = wallSecondsOfRagdoll(1);
  check('with no wall clock published, the water\'s is used and the tumble is unchanged',
    Math.abs(unpublished - want) < 0.1, `${unpublished.toFixed(2)}s`);
}

// ---------------------------------------------------------------------------
section('NO SHOVE MAY BREAK THE ANIMAL — the ceilings, asked for numbers nobody would tune');
{
  const j = JOLT();
  for (const mag of [1e3, 1e5, 1e9]) {
    resetPlayer();
    // Every rate a blast computes, at a `push` that far off the scale.
    tumbleSeal(player, -BLAST().spin * mag, BLAST().roll * mag, BLAST().tumbleFor * mag, 1, 0, BLAST().kick * mag);
    const jj = player.jolt;
    check(`a shove of ${mag.toExponential(0)} cannot spin the body past spinMax`,
      Math.abs(jj.spinV) <= (j.spinMax ?? 26) + 1e-6, `${Math.abs(jj.spinV).toFixed(1)} vs ${j.spinMax}`);
    check(`...nor roll it past rollMax`,
      Math.abs(jj.rollV) <= (j.rollMax ?? 34) + 1e-6, `${Math.abs(jj.rollV).toFixed(1)} vs ${j.rollMax}`);
    check(`...nor take control away for longer than freeMax`,
      jj.free <= (j.freeMax ?? 2.5) + 1e-6, `${jj.free.toFixed(2)}s vs ${j.freeMax}s`);
    check(`...nor kick the skeleton harder than the limp's own ceiling`,
      jj.kick <= (j.limp?.kickMax ?? 16) + 1e-6, `${jj.kick.toFixed(1)} vs ${j.limp?.kickMax}`);
  }
  // A NaN reaching the jolt is a body quaternion of NaN, which is an animal
  // that renders nothing and never comes back — and the arithmetic that
  // produces one (a divide by a zero distance) is exactly what a blast does.
  resetPlayer();
  tumbleSeal(player, NaN, NaN, NaN, NaN, NaN, NaN);
  const clean = Object.entries(player.jolt).every(([, v]) => typeof v !== 'number' || Number.isFinite(v));
  check('a shove of NaN is refused rather than stored', clean, JSON.stringify(player.jolt));
  resetPlayer();
  const gave = flingSeal(player, 0, 0, 500, 4, 1);
  check('a throw with no direction is refused rather than dividing by zero',
    gave === 0 && Number.isFinite(player.velocity.length()) && player.velocity.length() === 0);
  resetPlayer();
  const capped = flingSeal(player, 1, 0, 1e6, 4, 1);
  check('a throw cannot exceed flingMax, whatever it is asked for',
    capped <= (j.flingMax ?? 240) + 1e-6, `${capped.toFixed(0)} u/s vs ${j.flingMax}`);
  // ...and the LIFTED CEILING is bounded by the same number, not by a second
  // one. A clamp opened wider than the throw is allowed to be would let the
  // seal accelerate past the speed the line above just capped.
  resetPlayer();
  flingSeal(player, 1, 0, 10, 1e6, 1);
  const top = player.stats.maxSpeed;
  check('...and the lifted ceiling is bounded by the same flingMax, not a second number',
    (player.flingMul ?? 1) * top <= (j.flingMax ?? 240) + 1e-6,
    `${(player.flingMul ?? 1).toFixed(2)}x of ${top} = ${((player.flingMul ?? 1) * top).toFixed(0)} u/s vs ${j.flingMax}`);
}

// ---------------------------------------------------------------------------
section('...AND THE THROW ACTUALLY THROWS — across the pitch, off the walls, inside them');
{
  // A seal is allowed into its own goal's corridor: a keeper stands there and
  // the blast fires bodies out through the mouth. Past that is the arena wall
  // and nothing may ever be on the far side of it.
  const tunnel = tunnelDepth();

  function blasted(dx, dy, seconds = 8) {
    resetPlayer();
    player.mesh.position.set(rockX(-1) + dx, mouthY() + dy, 0);
    for (let i = 0; i < 60; i++) { setJoltWallDt(DT); updatePlayer(DT, idle); }
    const x0 = player.mesh.position.x;
    const y0 = player.mesh.position.y;
    const caught = goalBlast(-1, mouthY());
    let far = 0, peak = 0, bounces = 0, past = 0, bad = 0;
    let pvx = player.velocity.x, pvy = player.velocity.y;
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      setJoltWallDt(DT);
      updatePlayer(DT, idle);
      const p = player.mesh.position;
      // A reversal of a real speed is a wall (or the surface) turning it round.
      if (Math.sign(player.velocity.x) !== Math.sign(pvx) && Math.abs(pvx) > 10) bounces++;
      if (Math.sign(player.velocity.y) !== Math.sign(pvy) && Math.abs(pvy) > 10) bounces++;
      pvx = player.velocity.x; pvy = player.velocity.y;
      far = Math.max(far, Math.hypot(p.x - x0, p.y - y0));
      peak = Math.max(peak, player.velocity.length());
      past = Math.max(past, bounds.left - p.x, p.x - bounds.right, bounds.bottom - p.y, p.y - bounds.top);
      if (!Number.isFinite(p.x + p.y + player.velocity.length())) bad++;
    }
    return { caught, far, peak, bounces, past, bad, endSpeed: player.velocity.length(), mul: player.flingMul ?? 1 };
  }

  const line = blasted(4, 0);
  note(`a seal on the goal line: ${line.far.toFixed(0)}u of travel, peak ${line.peak.toFixed(0)} u/s, ${line.bounces} reversal(s)`);
  check('a seal caught by the bang is thrown a real share of the pitch',
    line.far > bounds.width * 0.5, `${line.far.toFixed(0)}u of a ${bounds.width.toFixed(0)}u pitch`);
  check('...well past what it could ever swim',
    line.peak > player.stats.maxSpeed * 2, `${line.peak.toFixed(0)} u/s against a top speed of ${player.stats.maxSpeed}`);
  check('...and it comes off something on the way — the ping-pong',
    line.bounces >= 1, `${line.bounces} reversal(s)`);
  check('...without ever leaving the arena (its own goal corridor aside)',
    line.past <= tunnel + 0.5 && line.bad === 0, `${line.past.toFixed(1)}u past the wall, tunnel is ${tunnel}u deep`);
  check('...and it is back under its own top speed when it settles',
    line.endSpeed <= player.stats.maxSpeed + 1e-3 && line.mul === 1,
    `${line.endSpeed.toFixed(1)} u/s, ceiling ${line.mul.toFixed(2)}x`);

  // THE FALLOFF IS THE POINT. The blast rewards being near the hole; a seal
  // out in the pitch must not be fired across it for a goal at the other end.
  const far = blasted(40, 6);
  const rim = blasted(BLAST().radius + 10, 0);
  note(`mid-pitch: ${far.far.toFixed(0)}u. Outside the radius: caught ${rim.caught}.`);
  check('a seal out in the pitch is barely moved', far.far < line.far * 0.3, `${far.far.toFixed(0)}u vs ${line.far.toFixed(0)}u`);
  check('one outside the radius is not caught at all', rim.caught === 0 && rim.far < 2, `caught ${rim.caught}, ${rim.far.toFixed(1)}u`);

  // AND THE LIFTED CEILING CANNOT LEAK INTO PLAY. It exists to stop the clamp
  // confiscating the impulse on the frame it lands, and a player who kept it
  // would be swimming at several times their own top speed after every goal.
  resetPlayer();
  player.mesh.position.set(rockX(-1) + 4, mouthY(), 0);
  goalBlast(-1, mouthY());
  check('the throw opens the speed ceiling', (player.flingMul ?? 1) > 1, `${(player.flingMul ?? 1).toFixed(1)}x`);
  let held = 0;
  for (let i = 0; i < 60 * 10; i++) { setJoltWallDt(DT); updatePlayer(DT, idle); if ((player.flingMul ?? 1) > 1) held += DT; }
  check('...and closes it again once the seal is done flying',
    (player.flingMul ?? 1) === 1 && held < 4, `held ${held.toFixed(2)}s`);
  // The same, under the clock the blast actually fires on.
  resetPlayer();
  player.mesh.position.set(rockX(-1) + 4, mouthY(), 0);
  goalBlast(-1, mouthY());
  let heldFrozen = 0;
  for (let i = 0; i < 60 * 20; i++) {
    setJoltWallDt(DT);
    updatePlayer(DT * V().clock.freezeScale, idle);
    if ((player.flingMul ?? 1) > 1) heldFrozen += DT;
  }
  check('...in WALL seconds, even under the goal shutter that fired it',
    (player.flingMul ?? 1) === 1 && heldFrozen < 6, `held ${heldFrozen.toFixed(2)} wall s`);

  // A KICKOFF TAKES IT BACK. Whatever the blast left on a body, the count puts
  // every seal on its mark with nothing running.
  resetPlayer();
  startVersus(scene);
  toPlay();
  goalBlast(-1, mouthY());
  enterKickoff();
  const leftovers = [...matchSeals()].filter((s) => (s.flingMul ?? 1) > 1 || (s.jolt?.free ?? 0) > 0 || s.jolt?.limp);
  check('a kickoff hands every thrown seal back whole',
    leftovers.length === 0, `${leftovers.length} seal(s) still flying or limp`);
}

// ---------------------------------------------------------------------------
section('A REPLAY IS NOT PLAY — and a ragdoll is not footage');
{
  const R = V().replay;
  R.enabled = true;
  R.onlyWinner = false;

  // A recorded shot that goes in, with both seals parked in the goalmouth so
  // the blast is certain to catch them. Set up the way tools/versus-test.mjs
  // sets up its replay section: a full-power dash into a still ball short of
  // the right goal, so there is a `lastTouch` for replayWanted to find.
  resetVersus(); resetPlayer(); startVersus(scene);
  check('the match is in play before the shot', toPlay(), `phase ${versusState.phase}`);
  resetBall();
  ball.x = bounds.right - 30; ball.y = midWater();
  solveBallSurface();
  const reach = ballContactReach(Math.PI);
  player.mesh.position.set(ball.x - reach - 12, ball.y, 0);
  player.velocity.set(0, 0);
  p2.pos.set(bounds.left + 10, midWater() - 15, 0); p2.vel.set(0, 0);
  for (let i = 0; i < Math.round(((R.lead ?? 1) + 0.5) / DT); i++) frame();   // footage to rewind into
  player.mesh.position.set(ball.x - reach + 0.4, ball.y, 0);
  player.velocity.set(40, 0);
  strikeState.active = true;
  strikeState.dashDir.x = 1; strikeState.dashDir.y = 0; strikeState.power = 1;
  ball.dashHit[0] = false;
  frame();
  strikeState.active = false;
  check('the strike is noted as the last touch', versusState.lastTouch?.who === 0, JSON.stringify(versusState.lastTouch));
  // ...and the striker follows it in, out of the ball's lane. The strike's own
  // recoil throws the seal BACKWARDS (strikerRecoil), which left it 69 units
  // from the bang — outside `blast.radius`, so the goal threw nobody and the
  // whole section below was watching two seals it had never touched.
  player.mesh.position.set(bounds.right - 5, midWater() - 9, 0);
  player.velocity.set(0, 0);

  // The ball runs in. The striker is left where it struck — about 35 units off
  // the jet's birth point, well inside `blast.radius` — so the shockwave takes
  // it without anything being teleported into the ball's lane. A replay over
  // seals nobody threw would prove nothing.
  let n = 0;
  while (versusState.phase === 'play' && n < 900) { frame(); n++; }
  check('the ball goes in', versusState.phase === 'scored', `phase ${versusState.phase} after ${n} frames`);
  check('...and a replay is pending', versusState.replayPending === true);
  note(`the bang caught ${versusState.lastBlast?.caught} seal(s) at ${versusState.lastBlast?.x.toFixed(0)},${versusState.lastBlast?.y.toFixed(0)}`);
  const thrown = [...matchSeals()].filter((s) => (s.jolt?.free ?? 0) > 0).map(seatOf);
  check('...with the blast still tumbling somebody when it opens',
    thrown.length > 0, `seats ${JSON.stringify(thrown)}`);

  // Through the shutter and into the replay, watching every body every frame.
  let replayFrames = 0, limpFrames = 0, advanced = 0, wall = 0;
  let freeAtOpen = null, spinAtOpen = null;
  let sawReplay = false;
  for (let i = 0; i < 60 * 40 && versusState.phase !== 'kickoff'; i++) {
    frame();
    wall += DT;
    if (versusState.phase !== 'replay') continue;
    sawReplay = true;
    replayFrames++;
    const frees = [...matchSeals()].map((s) => s.jolt?.free ?? 0);
    const spins = [...matchSeals()].map((s) => s.jolt?.spin ?? 0);
    if (freeAtOpen === null) { freeAtOpen = frees; spinAtOpen = spins; }
    // NOBODY MAY BE LIMP WHILE FOOTAGE IS ON SCREEN.
    limpFrames += [...matchSeals()].filter((s) => s.jolt?.limp || s.anim?.isLimp?.()).length;
    // ...AND THE TUMBLE MAY NOT SPEND ITSELF against a tape that has not
    // reached the goal yet. Parked, not cancelled.
    for (let k = 0; k < frees.length; k++) {
      if (Math.abs(frees[k] - freeAtOpen[k]) > 1e-6 || Math.abs(spins[k] - spinAtOpen[k]) > 1e-6) advanced++;
    }
  }
  check('the replay actually played', sawReplay && replayFrames > 30, `${replayFrames} frames`);
  check('no seal is ragdolling while the footage is on screen',
    limpFrames === 0, `${limpFrames} limp seal-frames of ${replayFrames}`);
  check('...and the goal\'s tumble is PARKED under it, not spent',
    advanced === 0, `${advanced} seal-frames of drift`);
  // A REAL window, not a few frames of one: the claim above is that a parked
  // tumble does not drift, and a tumble that was nearly over when the footage
  // opened cannot tell a parked clock from a running one.
  check('...it is held rather than cancelled, so a real tumble is still owed when the pitch comes back',
    Math.max(...freeAtOpen) > 0.4, `free ${freeAtOpen.map((f) => f.toFixed(2)).join(', ')}`);
  check('the match reaches its kickoff', versusState.phase === 'kickoff', `phase ${versusState.phase} after ${wall.toFixed(1)} wall s`);
  const stuck = [...matchSeals()].filter((s) => s.jolt?.limp || (s.jolt?.free ?? 0) > 0 || (s.flingMul ?? 1) > 1).map(seatOf);
  check('...with nobody still limp, flying or owed a tumble', stuck.length === 0, `seats ${JSON.stringify(stuck)}`);
  check('...and nobody on their back', upsideDown().length === 0, `seats ${JSON.stringify(upsideDown())}`);

  // THE HANDBACK ITSELF. A tumble parked mid-flight has to come back as a
  // ragdoll and not as a rigid model: setLimp freezes whatever pose it finds,
  // and without the kick re-shoved the springs have nothing to chase.
  resetPlayer();
  for (let i = 0; i < 60; i++) { setJoltWallDt(DT); setJoltPaused(false); updatePlayer(DT, idle); }
  tumbleSeal(player, -8, 10, 2, 1, 0, 9);
  setJoltWallDt(DT); updatePlayer(DT, idle);
  check('a tumble arms the ragdoll and spends its kick', player.jolt.limp && player.jolt.kick === 0 && player.jolt.kickAt > 0,
    `limp ${player.jolt.limp}, kickAt ${player.jolt.kickAt.toFixed(1)}`);
  const owed = player.jolt.free;
  setJoltPaused(true);
  for (let i = 0; i < 120; i++) { setJoltWallDt(DT); updatePlayer(DT, idle); }
  check('parking hands the skeleton back to the mixer', !player.jolt.limp && player.anim.isLimp?.() !== true);
  check('...and does not spend the tumble', Math.abs(player.jolt.free - owed) < 1e-6, `${player.jolt.free.toFixed(3)} vs ${owed.toFixed(3)}`);
  setJoltPaused(false);
  setJoltWallDt(DT); updatePlayer(DT, idle);
  check('un-parking takes the ragdoll back', player.jolt.limp === true);
  check('...and re-shoves the chains, so the body is not limp and perfectly still',
    player.jolt.kick === 0 && player.jolt.kickAt > 0, `kickAt ${player.jolt.kickAt.toFixed(1)}`);
  // The bank is for a pause, not for the next blast.
  for (let i = 0; i < 60 * 5; i++) { setJoltWallDt(DT); updatePlayer(DT, idle); }
  check('...and the banked kick goes with the tumble it belonged to',
    player.jolt.free === 0 && player.jolt.kickAt === 0, `free ${player.jolt.free}, kickAt ${player.jolt.kickAt}`);
  setJoltPaused(false);
}

// ---------------------------------------------------------------------------
section('ON THE REAL SEAL — the skeleton comes back, measured against a control run');
{
  // The bones themselves, which nothing above looks at: the sections above ask
  // whether the ragdoll is taken, parked and handed back, and this one asks
  // where the bones actually END UP.
  if (!haveModel) {
    check('furseal.glb is where the game expects it', false, MODEL);
  } else {
    // The five ragdoll chains, by the names assets.js declares.
    const NAMES = [
      'uparm_L_012', 'arm_L_013', 'hand_L_014',
      'uparm_R_016', 'arm_R_017', 'hand_R_018',
      'leg_L_021', 'foot_L_022', 'leg_R_024', 'foot_R_025',
      'neck01_05', 'neck02_06', 'head_07',
    ];
    const bones = NAMES.map((n) => [n, player.body.getObjectByName(n)]).filter(([, b]) => b);
    check('every ragdoll bone resolved on the rebuilt body', bones.length === NAMES.length, `${bones.length}/${NAMES.length}`);

    const WARM = 180;
    const AFTER = 600;
    // AGAINST A CONTROL RUN, AND ONE THAT DIFFERS BY EXACTLY ONE THING. Two
    // traps live in this measurement and each of them invents a broken seal:
    //
    //   the clip is a LOOP, so "how far is this bone from where it was
    //   thirteen seconds ago" is a question about the clip's phase. Measured
    //   against the pose before the blast it reads as eleven shattered bones on
    //   a perfectly healthy animal. So both runs end on the same frame.
    //
    //   ...and the THROW is in the blast too, and the throw moves the seal.
    //   Three of these five chains are the aim rig's, and a seal that is
    //   somewhere else is aiming somewhere else — a legitimate difference that
    //   reads exactly like a limb that never came home. So the control is
    //   thrown as well, and the ragdoll is the only thing between them.
    //
    // See the same shape in tools/strike-impact-test.mjs and the control-run
    // note in tools/seal-flop-test.mjs.
    function run(mag) {
      resetPlayer();
      player.anim.reset();
      const input = { move: new THREE.Vector2(1, 0), aim: new THREE.Vector2(1, 0), strikeHeld: false, dash: false };
      for (let i = 0; i < WARM; i++) { setJoltWallDt(DT); updatePlayer(DT, input); }
      // The throw, on BOTH runs — see above.
      flingSeal(player, 1, 0, BLAST().launch, BLAST().launchCeiling, BLAST().launchFor);
      if (mag > 0) {
        tumbleSeal(player, -BLAST().spin * mag, BLAST().roll * mag, BLAST().tumbleFor * mag, 1, 0, BLAST().kick * mag);
      }
      let bad = 0;
      let limpSeen = false;
      for (let i = 0; i < Math.round((JOLT().freeMax ?? 2.5) / DT) + AFTER; i++) {
        setJoltWallDt(DT);
        updatePlayer(DT, input);
        if (player.jolt.limp) limpSeen = true;
        for (const [, b] of bones) {
          const q = b.quaternion;
          if (!Number.isFinite(q.x + q.y + q.z + q.w)) bad++;
        }
        const bq = player.body.quaternion;
        if (!Number.isFinite(bq.x + bq.y + bq.z + bq.w)) bad++;
        if (!Number.isFinite(player.mesh.position.x + player.mesh.position.y)) bad++;
      }
      return { q: bones.map(([, b]) => b.quaternion.clone()), bad, limpSeen };
    }

    // ---------------------------------------------------------------------
    // HOW FAR THE ANIMAL ACTUALLY FOLDS. The NaN check below says the numbers
    // are finite; this says the SHAPE is one a seal can hold.
    //
    // The quantity is each bone's rotation relative to its OWN PARENT, because
    // that is what deforms skin. A bone's world direction also moves when
    // anything above it moves — the body is tumbling, and the aim rig keeps
    // solving through a limp — and neither of those bends a joint. Measured in
    // world space the flippers read 3.0 rad here with nothing wrong at all.
    //
    // `maxLag` does NOT bound this and never did: it is measured from the
    // direction each bone is pulled toward, and on every bone but the first
    // that direction has already been displaced by its parent, so the
    // deviations compound. CONFIG.player.jolt.limp.chainMax is the cap that
    // bounds the limb. `npm run looks:rig` draws the same blast frame by frame
    // if the number below ever needs arguing with.
    {
      const chains = ASSETS.ship.rig?.springChains ?? [];
      const watch = chains.map((c) => (Array.isArray(c.bones) ? c.bones : c.names ?? [])
        .map((n) => [n, player.body.getObjectByName(n)]).filter(([, b]) => b));
      check('the ragdoll chains resolved for the fold check',
        watch.length === chains.length && watch.every((c) => c.length), `${watch.flat().length} bones`);
      resetPlayer();
      player.anim.reset();
      const input = { move: new THREE.Vector2(1, 0), aim: new THREE.Vector2(1, 0), strikeHeld: false, dash: false };
      for (let i = 0; i < WARM; i++) { setJoltWallDt(DT); updatePlayer(DT, input); }
      const held = watch.map((c) => c.map(([, b]) => b.quaternion.clone()));
      // The hardest thing the mode can do to a body: dead centre of the bang.
      tumbleSeal(player, -BLAST().spin * BLAST().push, BLAST().roll * BLAST().push,
        BLAST().tumbleFor, 1, 0, BLAST().kick * BLAST().push);
      const peak = watch.map((c) => c.map(() => 0));
      for (let i = 0; i < Math.round(((JOLT().freeMax ?? 2.5) + 0.5) / DT); i++) {
        setJoltWallDt(DT);
        updatePlayer(DT, input);
        watch.forEach((c, ci) => c.forEach(([, b], bi) => {
          const a = held[ci][bi].angleTo(b.quaternion);
          if (a > peak[ci][bi]) peak[ci][bi] = a;
        }));
      }
      // A joint past about 80 degrees from the pose it was cut loose in is
      // where the skin around it stops reading as slack and starts reading as
      // folded — and these are not small bones: uparm_L_012 is the heaviest
      // influence on 294 of the seal's 4122 vertices, head_07 on 1224.
      const FOLD = 1.45;
      const worstBone = watch.flatMap((c, ci) => c.map(([n], bi) => [n, peak[ci][bi]]))
        .reduce((m, x) => (x[1] > m[1] ? x : m), ['', 0]);
      check('no joint folds past what the skin around it can take',
        worstBone[1] <= FOLD, `worst ${worstBone[0]} at ${worstBone[1].toFixed(2)} rad (${(worstBone[1] * 180 / Math.PI).toFixed(0)}\u00b0), limit ${FOLD}`);
      // ...and the limb as a whole, which is the number the budget is about.
      const totals = peak.map((c) => c.reduce((t, a) => t + a, 0));
      check('...nor does a whole limb fold back through the animal',
        Math.max(...totals) <= 4.0, `worst limb ${Math.max(...totals).toFixed(2)} rad (${(Math.max(...totals) * 180 / Math.PI).toFixed(0)}\u00b0)`);
      // THE CAP IS WHAT IS DOING IT, not luck. Uncapped is the control.
      const capped = Math.max(...totals);
      const shipped = CONFIG.player.jolt.limp.chainMax;
      CONFIG.player.jolt.limp.chainMax = 0;   // 0 is "no budget" — see boneSpring
      resetPlayer();
      player.anim.reset();
      for (let i = 0; i < WARM; i++) { setJoltWallDt(DT); updatePlayer(DT, input); }
      const held2 = watch.map((c) => c.map(([, b]) => b.quaternion.clone()));
      tumbleSeal(player, -BLAST().spin * BLAST().push, BLAST().roll * BLAST().push,
        BLAST().tumbleFor, 1, 0, BLAST().kick * BLAST().push);
      const loose = watch.map((c) => c.map(() => 0));
      for (let i = 0; i < Math.round(((JOLT().freeMax ?? 2.5) + 0.5) / DT); i++) {
        setJoltWallDt(DT);
        updatePlayer(DT, input);
        watch.forEach((c, ci) => c.forEach(([, b], bi) => {
          const a = held2[ci][bi].angleTo(b.quaternion);
          if (a > loose[ci][bi]) loose[ci][bi] = a;
        }));
      }
      const uncapped = Math.max(...loose.map((c) => c.reduce((t, a) => t + a, 0)));
      CONFIG.player.jolt.limp.chainMax = shipped;
      check('...and it is the chain budget doing that, not luck',
        uncapped > capped * 1.15, `${uncapped.toFixed(2)} rad uncapped against ${capped.toFixed(2)} capped`);
    }

    const control = run(0);
    check('the control run — thrown, but never cut loose — is clean', control.bad === 0);
    for (const mag of [BLAST().push, BLAST().push * 25, 1e6]) {
      const hit = run(mag);
      const strays = bones
        .map(([n], k) => [n, control.q[k].angleTo(hit.q[k])])
        .filter(([, off]) => off > 0.05);
      if (mag === BLAST().push) {
        check('the blast really does cut the skeleton loose', hit.limpSeen);
      }
      check(`a blast of ${mag === 1e6 ? 'a million' : mag.toFixed(0)} leaves no NaN anywhere on the body`,
        hit.bad === 0, `${hit.bad} bad frame(s)`);
      check('...and every ragdoll bone comes back to what the un-blasted seal is doing',
        strays.length === 0,
        strays.length ? strays.map(([n, o]) => `${n} ${o.toFixed(2)} rad`).join(', ') : `${bones.length} bones home`);
    }
  }
}

console.log(`\n${failures ? `${failures} check(s) FAILED.` : 'All checks passed.'}`);
process.exit(failures ? 1 : 0);
