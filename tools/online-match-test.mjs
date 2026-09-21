#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE TWO ENDS OF A MATCH, joined in one process.
//
// systems/online/protocol.js already has a harness for the CODEC — that the
// bytes round-trip. This is the layer above it: that the host's live match
// state goes into those bytes, that the guest's world comes back out of them,
// and that the two things a machine must decide FOR ITSELF rather than copy
// (which seat is its own, and whether a button was pressed this frame) are
// decided the same way on both sides.
//
// NO NETWORK AND NO SOCKET. Both ends are module state in this one process, so
// "send" is handing a buffer to the other module's receive. That is exactly
// what the relay does — server/room/live-check.mjs proves the relay carries
// bytes unchanged — and it keeps this a ship gate, which runs with no TTY and
// no network.
//
// THE TRAP THIS IS BUILT AROUND: every one of these failures is silent. A pad
// index left on a remote seat is two people on one seal. An edge derived from
// the wrong `heldPrev` is a dash that fires twice or not at all. A rim copied
// index-for-index is correct until a tuning slider moves. None of them throw,
// and all of them look like lag.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};
const section = (name) => console.log(`\n${name}`);
const near = (a, b, eps) => Math.abs(a - b) <= eps;

const { versusSetup, KEYBOARD, resetVersusSetup } = await import('../path/src/systems/versusFlag.js');
const session = await import('../path/src/systems/online/session.js');
const { setRosterSize, rosterPerSide } = await import('../path/src/systems/sealRoster.js');
const rules = await import('../path/src/systems/matchRules.js');
const cast = await import('../path/src/systems/rosterCast.js');
const teamCast = await import('../path/src/systems/teamNameCast.js');
const { captureMatch, applyMatch, claimRemoteSeat } = await import('../path/src/systems/online/matchStart.js');
const netInput = await import('../path/src/systems/online/netInput.js');
const { versusState, ball } = await import('../path/src/systems/versus.js');
const netSnap = await import('../path/src/systems/online/netSnapshot.js');

// ---------------------------------------------------------------------------
section('the match start — one host decision, two identical matches');

// The host's screen: 2 a side, first to 7, blue against orange, with a CPU
// teammate each. This is exactly what writeSetup leaves behind.
session.endSession();
setRosterSize(2);
rules.setTimed(false);
rules.setGoalsToWin(7);
resetVersusSetup();
versusSetup.teams[0].color = 0x3366ff;
versusSetup.teams[0].members.push({ kind: 'human', pad: KEYBOARD }, { kind: 'cpu', pad: null });
versusSetup.teams[1].color = 0xff8833;
versusSetup.teams[1].members.push({ kind: 'human', pad: 3 }, { kind: 'cpu', pad: null });
cast.resetRosterCast();
cast.syncRosterCast();
teamCast.resetTeamNames();
teamCast.applyTeamNames(['the Floes', 'the Kelpers']);

session.beginLobby('host');
claimRemoteSeat();
check('the host hands seat 1 to the wire, not to its own controller',
  versusSetup.teams[1].members[0].pad === session.REMOTE,
  String(versusSetup.teams[1].members[0].pad));
check('...and keeps its own seat local', versusSetup.teams[0].members[0].pad === KEYBOARD);

const payload = captureMatch();
const hostNames = cast.rosterNames().slice();
const hostTeams = teamCast.teamNames();
check('no pad index rides on the wire',
  JSON.stringify(payload).includes('"pad"') === false, JSON.stringify(payload.teams));

// Now become the guest, with everything local deliberately DIFFERENT, so a
// field that is silently kept rather than applied shows up as the local value.
session.endSession();
setRosterSize(1);
rules.setTimed(true);
rules.setGoalsToWin(3);
resetVersusSetup();
cast.resetRosterCast();
teamCast.resetTeamNames();
teamCast.applyTeamNames(['the Wrong Ones', 'the Others']);
session.beginLobby('guest');

check('the payload applies', applyMatch(payload) === true);
check('the roster size crossed', rosterPerSide() === 2, String(rosterPerSide()));
check('the rules crossed', rules.isTimed() === false && rules.goalsToWin() === 7,
  `timed=${rules.isTimed()} goals=${rules.goalsToWin()}`);
check('both colours crossed',
  versusSetup.teams[0].color === 0x3366ff && versusSetup.teams[1].color === 0xff8833);
check('the cast crossed intact', JSON.stringify(cast.rosterNames()) === JSON.stringify(hostNames),
  `${cast.rosterNames()} vs ${hostNames}`);
check('the team names crossed', JSON.stringify(teamCast.teamNames()) === JSON.stringify(hostTeams),
  teamCast.teamNames().join(' / '));

// THE ONE THING THAT MUST NOT BE COPIED. Seat 1 is this machine's on the
// guest and the wire's on the host; a payload that carried `pad` verbatim
// would put the host's controller index 3 on the guest's own seal.
check('the guest drives its own side locally', versusSetup.teams[1].members[0].pad === KEYBOARD,
  String(versusSetup.teams[1].members[0].pad));
check('...and the host’s side is remote here', versusSetup.teams[0].members[0].pad === session.REMOTE,
  String(versusSetup.teams[0].members[0].pad));
check('the CPU teammates stayed CPU on both sides',
  versusSetup.teams[0].members[1].kind === 'cpu' && versusSetup.teams[1].members[1].kind === 'cpu');

// A GUEST DOES NOT RE-LOCALISE SEAT 0. syncRosterCast runs on both ends at
// startVersus, and its first line is `names[0] = playerName()` — which on a
// guest would rename the HOST's seal to the person at this keyboard.
const seat0 = cast.seatName(0);
cast.syncRosterCast();
check('syncRosterCast leaves an adopted seat 0 alone', cast.seatName(0) === seat0,
  `${cast.seatName(0)} was ${seat0}`);
// ...and the same for the team names, whose writer is castTeamNames.
teamCast.castTeamNames([0x3366ff, 0xff8833]);
check('castTeamNames leaves an adopted pair alone',
  JSON.stringify(teamCast.teamNames()) === JSON.stringify(hostTeams), teamCast.teamNames().join(' / '));

check('a payload from a future version is refused rather than half-applied',
  applyMatch({ ...payload, v: payload.v + 1 }) === false);

// ---------------------------------------------------------------------------
section('the guest’s hands — a level on the wire, edges at the far end');

netInput.resetNetInput();
const out = { move: new THREE.Vector2(), aim: new THREE.Vector2(), connected: false };

// NOTHING HAS ARRIVED YET is not the same as a stick at rest: botWanted reads
// `connected`, so the wrong answer here is a seal standing still in the water
// instead of a bot playing the seat.
netInput.readRemoteInput(out);
check('before the first packet the seat reads as unplugged', out.connected === false);

const send = (o) => netInput.receiveInput(netInput.captureInput(o));
send({ move: { x: 1, y: 0 }, aim: { x: 1, y: 0 }, strikeHeld: false, connected: true });
netInput.readRemoteInput(out);
check('the stick crossed', near(out.move.x, 1, 0.02) && near(out.move.y, 0, 0.02),
  `${out.move.x},${out.move.y}`);
check('a button not held is not a press', out.strike === false && out.strikeHeld === false);

// THE PRESS. `strike` is true for exactly the frame the level went up.
send({ move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, strikeHeld: true, connected: true });
netInput.readRemoteInput(out);
check('the frame the button goes down is a press', out.strike === true && out.strikeHeld === true);

// HELD ACROSS A FRAME WITH NO NEW PACKET — the commonest case, since input
// goes at 30 Hz and the host steps at 60. It must NOT read as a second press.
netInput.readRemoteInput(out);
check('holding is not pressing again', out.strike === false && out.strikeHeld === true);

send({ move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, strikeHeld: false, connected: true });
netInput.readRemoteInput(out);
check('the frame it comes up is a release', out.strikeRelease === true && out.strikeHeld === false);
netInput.readRemoteInput(out);
check('...and only that frame', out.strikeRelease === false);

// A WIRE THAT GOES AWAY MID-PRESS must not leave the dash button stuck down.
send({ move: { x: 0, y: 0 }, aim: { x: 0, y: 1 }, strikeHeld: true, connected: true });
netInput.readRemoteInput(out);
send({ move: { x: 0, y: 0 }, aim: { x: 0, y: 1 }, strikeHeld: false, connected: false });
netInput.readRemoteInput(out);
check('a dropped guest releases the button rather than holding it down',
  out.strikeHeld === false && out.connected === false && out.strikeRelease === true);

check('a snapshot handed to the input decoder is refused, not half-read',
  netInput.receiveInput(new ArrayBuffer(94)) === false);

// ---------------------------------------------------------------------------
section('the frame — the host’s match, posed at the other end');

// A match the host is in the middle of. Only the fields the snapshot carries
// are set; everything else is whatever resetVersus left.
versusState.active = true;
versusState.phase = 'play';
versusState.scores[0] = 2;
versusState.scores[1] = 5;
versusState.count = -1;
versusState.phaseT = 1.25;
versusState.timeScale = 1;
versusState.winner = -1;
versusState.draw = false;
versusState.clock = 61.5;
ball.x = -17.25; ball.y = 8.5; ball.vx = 12.5; ball.vy = -3.25;
ball.angle = 1.1; ball.spin = 2.5;

// THE RIM AT A LENGTH THE WIRE DOES NOT HAVE. 24 is only the DEFAULT of
// CONFIG.versus.ball.soft.points; it is a slider, and an index-for-index copy
// is correct right up until somebody moves it.
ball.rim = new Float32Array(18);
for (let i = 0; i < ball.rim.length; i += 1) ball.rim[i] = Math.sin(i) * 0.5;
const sent = ball.rim.slice();

netSnap.resetNetSnapshot();
const frame = netSnap.captureSnapshot();
check('the host builds a frame', !!frame);

// Move the world AWAY from what was captured, so anything the pose fails to
// write stays visibly wrong rather than accidentally right.
ball.x = 0; ball.y = 0; ball.vx = 0; ball.vy = 0; ball.angle = 0; ball.spin = 0;
ball.rim.fill(0);
versusState.scores[0] = 0;
versusState.scores[1] = 0;
versusState.phase = 'kickoff';
versusState.clock = 0;

check('the guest takes the frame', netSnap.receiveSnapshot(frame) === true);
check('...and poses it', netSnap.poseSnapshot() === true);

check('the ball is where the host had it', near(ball.x, -17.25, 0.01) && near(ball.y, 8.5, 0.01),
  `${ball.x},${ball.y}`);
check('...moving how the host had it', near(ball.vx, 12.5, 0.02) && near(ball.vy, -3.25, 0.02),
  `${ball.vx},${ball.vy}`);
check('...and spinning', near(ball.angle, 1.1, 0.01) && near(ball.spin, 2.5, 0.05));
check('the score crossed', versusState.scores[0] === 2 && versusState.scores[1] === 5,
  versusState.scores.join('-'));
check('the phase crossed', versusState.phase === 'play', versusState.phase);
check('the match clock crossed', near(versusState.clock, 61.5, 0.01), String(versusState.clock));

check('the rim kept its LOCAL length, not the wire’s', ball.rim.length === 18,
  String(ball.rim.length));
// Through 18 -> 24 -> 18 with a byte of quantisation in the middle, so this is
// a shape check and not an equality one. A rim copied index-for-index would be
// rotated by a quarter of the ball, which is what the tolerance here catches.
let worst = 0;
for (let i = 0; i < 18; i += 1) worst = Math.max(worst, Math.abs(ball.rim[i] - sent[i]));
check('...and the dents came back in the right places', worst < 0.2, `worst off by ${worst.toFixed(3)}`);

check('a frame that is not a snapshot is refused', netSnap.receiveSnapshot(new ArrayBuffer(12)) === false);

// A GUEST WITH NOTHING YET holds its last frame rather than erroring.
netSnap.resetNetSnapshot();
check('nothing to pose says so rather than throwing', netSnap.poseSnapshot() === false);

versusState.active = false;
session.endSession();

// ---------------------------------------------------------------------------
section('a guest\u2019s whole frame — through updateVersus, not around it');

// THE BUG THIS SECTION EXISTS FOR. The first version of the guest gate posed
// the world and returned, which skipped every line of updateVersus that is
// about how the match LOOKS rather than where it is: the stand-in swap, the
// ball's drive and spin, and placeMarkers. Nothing threw; the pitch just came
// up half dressed with the marker rings nowhere near the seals. So this drives
// the REAL entry point rather than poseSnapshot directly, and then asserts on
// something only the PRESENTATION pass writes. Checking the posed positions
// alone is not enough — the broken build posed them perfectly and was still
// unplayable.
const { initPlayer, resetPlayer } = await import('../path/src/entities/player.js');
const { initParticles } = await import('../path/src/entities/particles.js');
const { resetStrike } = await import('../path/src/systems/strike.js');
const versus = await import('../path/src/systems/versus.js');
const { recordBallLook, LOOK_REC } = await import('../path/src/systems/ballLook.js');

const scene = new THREE.Scene();
initPlayer(scene);
initParticles(scene);
resetPlayer();
resetStrike();
versus.resetVersus();
resetPlayer();
versus.startVersus(scene);
check('a match is up with seals in it', versus.matchSeals().length >= 2,
  String(versus.matchSeals().length));

// Build a frame as the HOST would, with both seals somewhere unmistakable.
session.endSession();
const seals = versus.matchSeals();
seals[0].mesh.position.set(-31.5, 4.25, 0);
seals[1].mesh.position.set(26.75, -6.5, 0);
ball.x = 9.5; ball.y = 2.25; ball.vx = -8; ball.vy = 1.5; ball.spin = 1.75;
versusState.active = true;
netSnap.resetNetSnapshot();
const hostFrame = netSnap.captureSnapshot();

// ...then move everything away and become the guest.
seals[0].mesh.position.set(0, 0, 0);
seals[1].mesh.position.set(0, 0, 0);
ball.x = 0; ball.y = 0; ball.vx = 0; ball.vy = 0; ball.spin = 0;
session.beginLobby('guest');
netSnap.receiveSnapshot(hostFrame);

let threw = '';
try { versus.updateVersus(1 / 60, [], null); } catch (err) { threw = String(err); }
check('a guest frame runs without throwing', threw === '', threw);
check('...and the seals landed where the host had them',
  near(seals[0].mesh.position.x, -31.5, 0.02) && near(seals[1].mesh.position.x, 26.75, 0.02),
  `${seals[0].mesh.position.x} / ${seals[1].mesh.position.x}`);
check('...and so did the ball', near(ball.x, 9.5, 0.02) && near(ball.y, 2.25, 0.02),
  `${ball.x},${ball.y}`);

// THE TWO METERS, which shipped reading the wrong fields entirely.
//
// OXYGEN came from versusState.fillAir, which is NOT a meter: captureTanks
// writes it once per kickoff as the value the countdown's refill blends FROM,
// so the guest's bar held a frozen number from the last whistle and jumped at
// the next one. And the BOOST bar was not sent at all — only `pending`, the
// current wind-up, which is zero except while somebody is holding the button.
// Both looked like "the meters aren't really working" and neither threw.
{
  const { strikeState } = await import('../path/src/systems/strike.js');
  const { sealAt } = await import('../path/src/systems/versus.js');
  const { player } = await import('../path/src/entities/player.js');
  const maxO2 = Math.max(1, player.stats?.maxOxygen ?? CONFIG.oxygen?.max ?? 100);

  const a = sealAt(0);
  const b = sealAt(1);
  if (a && b) {
    versusState.active = true;
    a.oxygen = maxO2 * 0.4;
    b.oxygen = maxO2 * 0.9;
    strikeState.charge = 0.25;
    if (b.strike) b.strike.charge = 0.75;
    // The stale field set to something that would be WRONG if it were read, so
    // a regression to fillAir fails loudly rather than coincidentally passing.
    versusState.fillAir[0] = maxO2;
    versusState.fillAir[1] = maxO2;

    netSnap.resetNetSnapshot();
    const meterFrame = netSnap.captureSnapshot();
    a.oxygen = maxO2; b.oxygen = maxO2;
    strikeState.charge = 1;
    if (b.strike) b.strike.charge = 1;

    netSnap.receiveSnapshot(meterFrame);
    netSnap.poseSnapshot();
    check('the live tank crossed, not the kickoff capture',
      near(a.oxygen / maxO2, 0.4, 0.01) && near(b.oxygen / maxO2, 0.9, 0.01),
      `${(a.oxygen / maxO2).toFixed(3)} / ${(b.oxygen / maxO2).toFixed(3)}`);
    check('the stocked boost crossed for seat 0 (strikeState, not the seal)',
      near(strikeState.charge, 0.25, 0.01), String(strikeState.charge));
    check('...and for seat 1 (the seal, not strikeState)',
      near(b.strike?.charge ?? -1, 0.75, 0.01), String(b.strike?.charge));
    versusState.active = false;
  } else {
    check('two seats exist to meter', false, 'sealAt(0)/sealAt(1) missing');
  }
}

// THE PRESENTATION PASS RAN. `speed01` is written by setBallDrive and by
// nothing else, so a guest frame that posed and returned — which is exactly
// what shipped and came back as "the field only partially loaded" — leaves it
// at zero while the ball is visibly moving. Reading it through recordBallLook
// because the state itself is private to ballLook.js.
const L_SPEED01 = 13;
const look = new Float32Array(LOOK_REC);
recordBallLook(look);
check('the guest ran the look pass, not only the pose', look[L_SPEED01] > 0,
  `speed01=${look[L_SPEED01]} with the ball at ${ball.vx},${ball.vy}`);

// ---------------------------------------------------------------------------
// INTERPOLATION — the fix for "choppy", and the two ways it goes wrong.
//
// Snapshots land 20 times a second and the guest draws 60, so posing the
// newest frame directly holds each position for three frames and then jumps.
// The tell that this was a DRAWING problem and not a wire problem: the guest's
// input looked perfect on the host, which is the same bytes making the
// opposite trip.
{
  // NEVER OUTSIDE THE TWO FRAMES IT HOLDS. Extrapolation was the alternative
  // design and is the wrong one: running past the last known position means
  // inventing one, and every invention snaps back when the truth arrives — on
  // a ball reversing off a seal, at exactly the moment somebody is watching.
  netSnap.resetNetSnapshot();
  versusState.active = true;
  ball.x = -40; ball.y = 0; ball.vx = 0; ball.vy = 0; ball.rim = new Float32Array(24);
  const fA = netSnap.captureSnapshot();
  ball.x = 40;
  const fB = netSnap.captureSnapshot();
  netSnap.receiveSnapshot(fA);
  netSnap.receiveSnapshot(fB);
  netSnap.poseSnapshot();
  check('a pose never leaves the two frames it holds', ball.x >= -40.05 && ball.x <= 40.05,
    `x=${ball.x} between -40 and 40`);
  const a0 = netSnap.poseAlpha();
  check('...and the blend sits in 0..1', a0 >= 0 && a0 <= 1, String(a0));

  // A STALL HOLDS THE LAST FRAME rather than sailing through the wall. With no
  // new snapshot the blend pins at 1 and the world stops where it was told.
  //
  // THE ONLY WALL-CLOCK WAIT IN THIS FILE, and it is unavoidable: the blend is
  // a function of REAL elapsed time — that is the whole point of it, since the
  // guest draws on its own clock between frames that arrive on the host's — so
  // there is nothing to advance by hand. 140 ms is several snapshot gaps, far
  // enough past the clamp that a slow machine cannot land short of it.
  await new Promise((r) => setTimeout(r, 140));
  netSnap.poseSnapshot();
  check('a stalled wire holds the newest frame, it does not run on',
    near(ball.x, 40, 0.05), `x=${ball.x}`);
  check('...with the blend pinned at the end, not past it', netSnap.poseAlpha() === 1,
    String(netSnap.poseAlpha()));
  versusState.active = false;
}

// THE GUEST DOES NOT STEP. If any of the simulation below the gate ran, the
// ball would have moved off the posed position by its own velocity.
const wasX = ball.x;
versus.updateVersus(1 / 60, [], null);
check('a second frame with no new snapshot holds the pose rather than stepping it',
  near(ball.x, wasX, 1e-6), `${ball.x} was ${wasX}`);

session.endSession();
versusState.active = false;

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
