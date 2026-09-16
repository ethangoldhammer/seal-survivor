#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:balltrail
//
// THE BLUBBERBALL'S TRAIL — systems/ballTrail.js, which is the seal's trail
// (systems/breachTrail.js) running on the shared engine in
// systems/ribbonTrail.js with three things of its own: the shed points, the
// bubbles, and a colour split driven by the possession ledger.
//
// WHAT IS ACTUALLY WORTH TESTING HERE is the third one, because every way it
// can be wrong is silent:
//
//   THE SPLIT STOPS READING THE LEDGER. The two colours and their weights are
//   rebuilt every frame from systems/ballLook.js. If that read breaks — a
//   renamed field, a `share` taken from the wrong end — the trail still draws,
//   still splits, and still looks like a two-colour trail. It just stops being
//   ABOUT anything, and no frame of it looks wrong.
//
//   IT WRITES ITS COLOURS ONTO CONFIG. The engine takes a settings block, and
//   the obvious way to hand it this frame's colours is to put them on the
//   block — which is CONFIG.versus.ball.trail itself. That would write whichever
//   team last held the ball into the tuning file, permanently, and the symptom
//   is a ball trail that comes up green on a fresh session for reasons nobody
//   can find. (The seal's wind-up has the identical trap; see withCharge.)
//
//   THE DOMINANCE TERMS ARE NOT CENTRED. `splitThrow` and `splitBias` are
//   supposed to do NOTHING on a ball held 50/50 — the even split is what the
//   static knobs above them describe. Off-centre by a little and every ball in
//   every match is quietly biased toward whoever touched it second.
//
//   THE TWO PROFILES BLEED. Air and water share every function in the engine,
//   and this is the second pair of rigs to run through it. Anything left at
//   module scope there is a thing four clouds now fight over.
//
// Everything expected is read from CONFIG. imported-tuning.json is merged at
// import and wins over config.js, so a literal here would test the tuning file.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { bounds, updateBounds } from '../path/src/arena.js';
import {
  noteBallMomentum, claimBall, resetBallLook, updateBallLook, ballCredit, teamColor, ballEvent,
  heldColor, starterColor,
} from '../path/src/systems/ballLook.js';
import {
  updateBallTrail, clearBallTrail, ballTrailStats, ballTrailSplit, ballTrailProfile, burstBallBubbles,
} from '../path/src/systems/ballTrail.js';

const scene = new THREE.Scene();
const dt = 1 / 60;
let failures = 0;

function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}
const hex = (n) => '#' + ((n >>> 0) & 0xffffff).toString(16).padStart(6, '0');

updateBounds(16 / 9);

const T = CONFIG.versus.ball.trail;
const W = { ...T, ...(T.water ?? {}) };
const DEPTH = bounds.surfaceY - 10;
const SKY = bounds.surfaceY + 8;

// The ball, as the trail reads it: five numbers and a live flag. Hand-built
// rather than driven through versus.js so that speed, depth and possession are
// each controllable on their own — which is the whole point, since the thing
// under test is a function of all three.
const ball = { x: 0, y: DEPTH, vx: 0, vy: 0, r: 2.8, live: true };
const radiusAt = () => 2.8;

function reset() {
  clearBallTrail(scene);
  resetBallLook();
  ball.x = 0;
  ball.y = DEPTH;
  ball.vx = 0;
  ball.vy = 0;
  ball.live = true;
}

/** Roll at `speed` for `frames`, at whatever depth is asked for. */
function roll(speed, frames, { y = DEPTH, dirY = 0 } = {}) {
  for (let i = 0; i < frames; i++) {
    ball.vx = speed;
    ball.vy = speed * dirY;
    ball.x += ball.vx * dt;
    ball.y = y;
    updateBallLook(dt);
    updateBallTrail(dt, scene, ball, { radiusAt });
  }
}

/** Let it sit — the gate shuts and the cloud is left to drift and die. */
function coast(frames) {
  for (let i = 0; i < frames; i++) {
    ball.vx = 0;
    ball.vy = 0;
    updateBallLook(dt);
    updateBallTrail(dt, scene, ball, { radiusAt });
  }
}

/**
 * A contact by `team` that adds `speed` along +x. The same call versus.js makes
 * from every path that moves the ball, so what the split reads is the shipping
 * ledger rather than a number this file invented.
 */
function strike(team, speed = 40) {
  const v0x = ball.vx;
  const v0y = ball.vy;
  ball.vx = speed;
  ball.vy = 0;
  noteBallMomentum(team, v0x, v0y, ball.vx, ball.vy, 0);
}

const airRoot = () => scene.getObjectByName('ballTrailAir');
const waterRoot = () => scene.getObjectByName('ballTrailWater');

// Every live particle in a rig's plumes, as [x, y] — the SIMULATION's opinion.
// The drawn geometry is a curve resampled far more densely than the particles,
// so reading vertices would measure the spline instead. (The same argument as
// breachTrailNodes; see the note there.)
function nodesOf(root) {
  const out = [];
  root?.traverse((o) => {
    if (!o.isMesh) return;
    const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) out.push([p.getX(i), p.getY(i)]);
  });
  return out;
}

// ---------------------------------------------------------------------------
section('THE SPLIT IS THE LEDGER — two colours, weighted by who is winning');
{
  reset();
  // NOBODY HAS TOUCHED IT. One ribbon, in the ball's own colour — the same
  // answer the swim trail gives, and it needs no special case downstream
  // because the engine reads its channel count off the length of this list.
  const none = ballTrailSplit();
  check('an untouched ball draws ONE channel', none.colors.length === 1,
    `${none.colors.length} colour(s)`);
  // The ball's colour AT ITS GLOW — what renderBall actually writes into the
  // splats, and so the colour the untaken part of the body is wearing. Not
  // look.color raw: mixing that in at tintMix would DIM the ball on the frame
  // somebody first touched it. See starterColor.
  check('...in the ball\'s own colour',
    none.colors[0] === starterColor(), hex(none.colors[0]));

  // A CONTACT. Two channels — and the second is NOT the other team's colour.
  // Until the other side has actually held this ball there is nothing of
  // theirs on it: what green is taking over is the STARTER, which is what the
  // first touch of a kickoff looks like.
  strike(0, 40);
  roll(40, 30);
  const one = ballTrailSplit();
  check('a struck ball draws TWO', one.colors.length === 2,
    one.colors.map(hex).join(' / '));
  check('...the striker\'s colour, taking over the starter',
    one.colors[1] === teamColor(0) && one.colors[0] === starterColor(),
    `${hex(one.colors[0])} \u2190 ${hex(one.colors[1])}`);
  check('...and NOT the colour of a side that has not touched it',
    !one.colors.includes(teamColor(1)), hex(teamColor(1)));

  // THE MARCH, AND THE FLIP IT REPLACED. The first contact of a match used to
  // hand the striker the WHOLE ball on the frame it landed: the hand-over
  // re-read the share from the incoming colour's end (`1 - share`), which is
  // right between two teams and is `1 - 0` out of nobody. So the spread never
  // ran — the ball flipped. It has to arrive somewhere between the two.
  const led = ballCredit();
  const lead = led.newest;
  const beaten = lead === 1 ? 0 : 1;
  check('the ledger says team 0 is taking it', lead === 0 && led.share > 0.5 && led.share < 0.95,
    `newest ${lead}, share ${led.share.toFixed(3)} after half a second`);
  // ONCE THE OTHER SIDE HAS HELD IT, the pair IS the two teams' colours — that
  // is the question heldColor asks, and the starter is only the answer while
  // nobody has taken anything off anybody.
  {
    strike(1, 60);
    const two = ballTrailSplit();
    check('...and once the other side has held it, the pair is the two teams',
      two.colors.includes(teamColor(0)) && two.colors.includes(teamColor(1)),
      two.colors.map(hex).join(' / '));
    check('heldColor says so directly', heldColor(1) === teamColor(0), hex(heldColor(1)));
  }
  {
    // ON THE CONTACT FRAME ITSELF there is barely any of the new colour yet —
    // the check that would have caught the flip on its own. A full reset, not
    // just the look's: `strike` books the speed a contact ADDED, and a strike
    // to 40 on a ball already doing 40 adds nothing and is ignored.
    reset();
    strike(0, 40);
    updateBallLook(dt);
    check('...and owned almost none of it on the frame of the touch',
      ballCredit().share < 0.1, `share ${ballCredit().share.toFixed(3)} on frame one`);
    // Back to a ball only team 0 has touched, for the weight checks below.
    reset();
    strike(0, 40);
    roll(40, 30);
  }

  const s = ballTrailSplit();
  // Channel 1 is always the NEWEST colour — the same order ballLook writes into
  // the body's own two-colour field, so the trail and the ball agree.
  check('the winning colour burns brighter', s.gain[1] > s.gain[0],
    `x${s.gain[1].toFixed(2)} vs x${s.gain[0].toFixed(2)}`);
  check('...and sits nearer the spine', Math.abs(s.lean[1]) < Math.abs(s.lean[0]),
    `lean ${s.lean[1].toFixed(2)} vs ${s.lean[0].toFixed(2)}`);
  check('the losing colour is thrown clear of the band',
    Math.abs(s.lean[0]) > 0.5,
    `${Math.abs(s.lean[0]).toFixed(2)} against the 0.50 an even ball draws`);
  check('the winner is the team that struck it', s.colors[1] === teamColor(lead),
    `${hex(s.colors[1])} is team ${lead}`);
  check('...and the loser is what it is taking over', s.colors[0] === heldColor(lead),
    `${hex(s.colors[0])}, team ${beaten} having never touched it`);
}

// ---------------------------------------------------------------------------
section('...AND IT DOES NOTHING AT ALL ON AN EVEN BALL');
{
  // THE CENTRING TEST. `splitThrow` and `splitBias` describe how dominance
  // CHANGES the split; at 50/50 there is no dominance and both must fall out
  // exactly, leaving the static pair (channelTrail/channelSpread) to describe
  // what you see. Off-centre by a hair and every ball in every match leans
  // toward whoever touched it second, which no single frame would show.
  reset();
  strike(0, 40);
  roll(40, 4);
  // A CONTACT THAT SPLITS THE BOOKS EXACTLY. The ledger credits a contact with
  // the speed it ADDED and scales what was already there by how much of the old
  // momentum survives along the new line — so pushing a 40 u/s ball to 64.72
  // along its own line credits team 1 with 24.72 and leaves team 0 holding
  // 40 x 40/64.72, which is the same number. Solved rather than guessed at:
  // a = (-40 + sqrt(40^2 + 4x40^2)) / 2. Any pair of strikes that merely
  // reverses the ball hands it wholly over, which is what an alternating loop
  // of identical strikes quietly does.
  {
    const v1 = 64.7213595;
    noteBallMomentum(1, ball.vx, 0, v1, 0, 0);
    ball.vx = v1;
  }
  // ...and then let the march arrive. The share is smoothed on purpose (a trail
  // that changed hands on the contact frame reads as a glitch), so parity is
  // something it reaches rather than something a touch sets.
  for (let i = 0; i < 120; i++) updateBallLook(dt);
  const led = ballCredit();
  const even = Math.abs(led.share - 0.5) < 0.08;
  const s = ballTrailSplit();
  check('a contested ball settles near an even share', even, `share ${led.share.toFixed(3)}`);
  check('both channels are at exactly 1 when it is even',
    Math.abs(s.gain[0] - 1) < 0.2 && Math.abs(s.gain[1] - 1) < 0.2,
    `x${s.gain[0].toFixed(2)} / x${s.gain[1].toFixed(2)}`);
  check('...and both sit at the engine\'s own symmetric ±0.5',
    Math.abs(Math.abs(s.lean[0]) - 0.5) < 0.1 && Math.abs(Math.abs(s.lean[1]) - 0.5) < 0.1,
    `${s.lean[0].toFixed(2)} / ${s.lean[1].toFixed(2)}`);
  check('...and they lean opposite ways', Math.sign(s.lean[0]) !== Math.sign(s.lean[1]));
}

// ---------------------------------------------------------------------------
section('THE COLOURS COME FROM THE TEAMS, LIVE');
{
  // A captain picking a colour on the team select has to change the trail, and
  // the only way to be sure is to change one and look. A trail that had baked
  // the colours at load would pass every test above and fail this one.
  reset();
  const was = CONFIG.versus.teams[0].color;
  CONFIG.versus.teams[0].color = 0x4d7bff;
  claimBall(0);
  for (let i = 0; i < 60; i++) updateBallLook(dt);
  const s = ballTrailSplit();
  check('a team colour change reaches the trail', s.colors.includes(0x4d7bff),
    s.colors.map(hex).join(' / '));
  CONFIG.versus.teams[0].color = was;
}

// ---------------------------------------------------------------------------
section('NOTHING IS WRITTEN BACK ONTO CONFIG');
{
  // The trap in the header. The engine takes a flat settings block and the
  // block IS CONFIG.versus.ball.trail; a resolve that assigned this frame's
  // colours onto it would put the last team to hold the ball into the tuning
  // file for good.
  reset();
  strike(1, 45);
  roll(45, 30);
  const air = CONFIG.versus.ball.trail;
  const water = CONFIG.versus.ball.trail.water;
  check('the air block has no colours of its own', !('colors' in air));
  check('...no lean and no gain', !('channelLean' in air) && !('channelGain' in air));
  check('the water block is clean too',
    !('colors' in water) && !('channelLean' in water) && !('channelGain' in water));
}

// ---------------------------------------------------------------------------
section('THE GATE — speed, and which side of the line it is on');
{
  reset();
  roll(Math.max(0.5, W.minSpeed - 2), 40);
  check('a ball under the gate leaves nothing', ballTrailStats('water').count === 0,
    `${W.minSpeed} u/s gate`);

  reset();
  roll(W.fullSpeed, 40);
  const under = ballTrailStats('water');
  check('a ball at pace draws underwater', under.count > 0, `${under.count} particles`);
  check('...and nothing in the air at the same time',
    ballTrailStats('air').count === 0);
  // ONE cloud, and it is worth asserting rather than assuming: the engine
  // builds a plume per source and tears down the surplus, so a shed point that
  // came back would draw a second trail beside the first and nothing would say
  // so — a twin reads as one trail rendered twice rather than as a bug.
  check('it sheds from one point and one only', under.plumes === 1,
    `${under.plumes} plume(s)`);

  reset();
  roll(T.fullSpeed, 40, { y: SKY });
  const over = ballTrailStats('air');
  check('a lobbed ball draws in the air', over.count > 0, `${over.count} particles`);
  check('...and nothing underwater at the same time',
    ballTrailStats('water').count === 0);

  // A DEAD BALL — one that has gone into a goal — must seal its strand rather
  // than keep laying particles down while it is parked off the pitch.
  reset();
  roll(W.fullSpeed, 20);
  const alive = ballTrailStats('water').count;
  ball.live = false;
  roll(W.fullSpeed, 10);
  check('a ball in the goal stops laying trail',
    ballTrailStats('water').count <= alive, `${alive} -> ${ballTrailStats('water').count}`);
}

// ---------------------------------------------------------------------------
section('IT SHEDS ASTERN, OFF THE DRAWN EDGE');
{
  reset();
  roll(W.fullSpeed, 30);
  const pts = [];
  for (const p of waterRoot()?.children ?? []) {
    // The plume group's own first ribbon vertex is the head of the spine, which
    // is the newest particle — i.e. where the ball is shedding right now.
    const geo = p.children?.[0]?.geometry;
    if (geo) pts.push([geo.attributes.position.getX(0), geo.attributes.position.getY(0)]);
  }
  check('the trail is drawn from one place', pts.length === 1,
    `${pts.length} plume head(s)`);
  check('...astern of the ball', pts[0][0] < ball.x, `ball at x ${ball.x.toFixed(1)}`);
  // DEAD astern, not off a shoulder: the shed point is on the line the ball
  // came in on, so the head of the trail is where the body just was.
  check('...and on the heading rather than off a shoulder',
    Math.abs(pts[0][1] - ball.y) < 0.5, `${(pts[0][1] - ball.y).toFixed(2)}u across it`);
  const reach = Math.hypot(pts[0][0] - ball.x, pts[0][1] - ball.y);
  check('...on the drawn edge rather than at the centre',
    reach > 2.8 * T.atRadius * 0.6, `${reach.toFixed(2)}u out of a 2.80u body`);
}

// ---------------------------------------------------------------------------
section('THE BUBBLES — the water profile\'s other half');
{
  reset();
  roll(W.fullSpeed, 60);
  const wet = ballTrailStats('water').bubbles;
  check('a ball at pace boils bubbles off', wet > 0, `${wet} burst(s) in 1s`);
  // Rate x drive, so half the drive is about half the bubbles. Checked as a
  // BAND rather than a number: the debt counter carries a fraction across
  // frames, so an exact figure would be a test of the rounding.
  reset();
  const mid = W.minSpeed + (W.fullSpeed - W.minSpeed) * 0.5;
  roll(mid, 60);
  const half = ballTrailStats('water').bubbles;
  check('...fewer of them at half the drive', half > 0 && half < wet,
    `${half} against ${wet}`);

  reset();
  roll(T.fullSpeed, 60, { y: SKY });
  check('a ball in the air boils none', ballTrailStats('air').bubbles === 0,
    'there is no water up there to boil');

  reset();
  roll(Math.max(0.5, W.minSpeed - 2), 60);
  check('...and neither does one under the gate',
    ballTrailStats('water').bubbles === 0);

  // A HIT BOILS IT — burstBallBubbles, fired from ballImpactFx so every touch
  // the ball has pays it. The point of the test is the case the continuous
  // shedding above cannot cover: a ball sitting STILL, smacked. Under the
  // drive gate it boils nothing at all, so a burst that went through the same
  // gate would be silently dropped on exactly the hit that most wants it.
  reset();
  roll(Math.max(0.5, W.minSpeed - 2), 30);
  const before = ballTrailStats('water').bubbles;
  burstBallBubbles(1);
  roll(Math.max(0.5, W.minSpeed - 2), 2);
  const after = ballTrailStats('water').bubbles;
  check('a hit boils bubbles off a ball too slow to shed any', after - before >= Math.floor(W.bubbles.burst) - 1,
    `${after - before} against a burst of ${W.bubbles.burst}`);
  const settled = ballTrailStats('water').bubbles;
  roll(Math.max(0.5, W.minSpeed - 2), 30);
  check('...paid once rather than every frame after', ballTrailStats('water').bubbles === settled,
    `${ballTrailStats('water').bubbles} against ${settled}`);

  // Scaled by how hard: a dribble puffs a couple, a spike detonates.
  reset();
  roll(Math.max(0.5, W.minSpeed - 2), 30);
  const soft0 = ballTrailStats('water').bubbles;
  burstBallBubbles(0.2);
  roll(Math.max(0.5, W.minSpeed - 2), 2);
  const soft = ballTrailStats('water').bubbles - soft0;
  check('a gentle touch puffs fewer than a hard one', soft > 0 && soft < after - before,
    `${soft} at a fifth force against ${after - before} at full`);

  // ...AND NOTHING IS BANKED IN THE AIR. A burst owed up there is forgotten
  // rather than paid on splashdown, which would put a volley's worth of foam
  // on a frame that already has its own event.
  reset();
  burstBallBubbles(1);
  roll(T.fullSpeed, 10, { y: SKY });
  reset();
  roll(W.fullSpeed, 2);
  const carried = ballTrailStats('water').bubbles;
  roll(W.fullSpeed, 2);
  check('a burst owed in the air is forgotten, not banked',
    ballTrailStats('water').bubbles - carried <= Math.ceil(W.bubbles.perSecond / 60) + 1,
    `${ballTrailStats('water').bubbles - carried} in two frames`);
}

// ---------------------------------------------------------------------------
section('A SPIKE BLOWS THE TRAIL OPEN — a flare at the strike, not for the flight');
// ---------------------------------------------------------------------------
// Off the LOOK's decaying `spike` (systems/ballLook.js), not the ball's latched
// one: what the trail is for here is saying WHERE it was hit. Held open for the
// length of the flight it would only say that a spike happened somewhere, which
// the ball's speed already says louder.
{
  const SK = W.spike ?? CONFIG.versus.ball.trail.spike;
  const laid = (spike) => {
    reset();
    if (spike > 0) ballEvent('bounce', { force: 1, team: 0, spike });
    roll(W.fullSpeed, 12);
    return ballTrailStats('water').count;
  };
  const plain = laid(0);
  const spiked = laid(1);
  check('a spike lays down a denser head of cloud', spiked > plain,
    `${plain} particles against ${spiked} over the same fifth of a second (emit x${SK.emit})`);

  // AND IT RINGS DOWN. The same flight, measured a second later: whatever the
  // spike bought has bled off and the trail is the trail again.
  reset();
  ballEvent('bounce', { force: 1, team: 0, spike: 1 });
  roll(W.fullSpeed, 60);
  const settled = ballTrailStats('water').count;
  reset();
  roll(W.fullSpeed, 60);
  const control = ballTrailStats('water').count;
  check('...and a second later it is laying down what it always did',
    settled < control * (1 + (SK.emit - 1) * 0.35),
    `${control} against ${settled} over a whole second`);

  // IT REACHES BOTH PROFILES. A ball spiked out of the air and one spiked under
  // it flare the same way — the boost is applied to the resolved copy of
  // whichever profile is live, which is the one path the two already share.
  reset();
  ballEvent('bounce', { force: 1, team: 0, spike: 1 });
  roll(T.fullSpeed, 12, { y: SKY });
  const airSpiked = ballTrailStats('air').count;
  reset();
  roll(T.fullSpeed, 12, { y: SKY });
  check('...and the air trail flares too, not only the water one',
    airSpiked > ballTrailStats('air').count,
    `${ballTrailStats('air').count} against ${airSpiked}`);

  // AND THE AUTHORED NUMBERS ARE UNTOUCHED. `resolve` writes onto a copy that
  // is rebuilt from the config every frame; a boost that reached CONFIG would
  // put a permanently blown-open trail into the tuning file.
  const before = CONFIG.versus.ball.trail.width;
  reset();
  ballEvent('bounce', { force: 1, team: 0, spike: 2 });
  roll(W.fullSpeed, 6);
  check('...and the boost never reaches the authored width',
    CONFIG.versus.ball.trail.width === before, `${before} -> ${CONFIG.versus.ball.trail.width}`);
  resetBallLook();
}

// ---------------------------------------------------------------------------
section('THE BREACH DOES NOT RESTYLE THE TRAIL');
{
  // The ball crosses the surface several times a second, and both rigs are on
  // screen at once. If the water override could reach a DRAWN key the same
  // unbroken trail would change width, brightness and core at the water line
  // every time — the thing that reads as the effect breaking rather than as the
  // ball entering water. What the water is allowed to change is how the
  // particles shed from that moment on MOVE.
  const DRAWN = [
    'width', 'growth', 'fade', 'glow', 'minIntensity',
    'coreWidth', 'coreGain', 'haloGain', 'softness',
    'samples', 'curveSmooth', 'headTaper', 'tailTaper', 'sealTaperMul',
    'channelTrail', 'channelSpread', 'splitThrow', 'splitBias',
  ];
  const MOVED = ['emitPerSecond', 'life', 'maxNodes', 'blowOut', 'turbulence', 'turbSpeed', 'drag', 'inherit'];

  const air = ballTrailProfile('air');
  const water = ballTrailProfile('water');
  const differ = DRAWN.filter((k) => air[k] !== water[k]);
  check('the band is drawn the same on both sides of the line',
    differ.length === 0, differ.length ? `differ: ${differ.join(', ')}` : `${DRAWN.length} drawn keys agree`);

  // ...and it is not agreeing because the override is empty. A water block that
  // changes nothing at all would pass the check above and mean nothing.
  const moves = MOVED.filter((k) => air[k] !== water[k]);
  check('...while the medium still changes how they move',
    moves.length > 0, `${moves.length} of ${MOVED.length} differ: ${moves.join(', ')}`);

  // The guard itself, not just today's config: set a drawn key on the override
  // and the profile must still ignore it.
  const block = CONFIG.versus.ball.trail.water;
  const had = Object.prototype.hasOwnProperty.call(block, 'width') ? block.width : undefined;
  block.width = 99;
  check('...and a drawn key set on the override is dropped',
    ballTrailProfile('water').width === ballTrailProfile('air').width,
    `width stayed ${ballTrailProfile('water').width}`);
  if (had === undefined) delete block.width; else block.width = had;
}

section('THE TWO PROFILES DO NOT BLEED');
{
  reset();
  roll(T.fullSpeed, 45, { y: SKY });
  const air = ballTrailStats('air');
  ball.y = DEPTH;
  roll(W.fullSpeed, 45);
  const water = ballTrailStats('water');
  check('each cloud obeys its own ceiling',
    water.count <= W.maxNodes * water.plumes && air.count <= T.maxNodes * air.plumes,
    `${water.count} under a ceiling of ${W.maxNodes} x ${water.plumes}, ${air.count} under ${T.maxNodes} x ${air.plumes}`);
  check('the two trails are separate scene nodes',
    !!airRoot() && !!waterRoot() && airRoot() !== waterRoot());

  // A STRAND BREAK, not a stripe. Crossing the surface closes one profile's
  // strand and opens the other's; a cloud that carried on would be joined to
  // the next burst by a ribbon drawn straight across the pitch.
  const lit = nodesOf(waterRoot()).length;
  check('...and both are drawn', lit > 0 && nodesOf(airRoot()).length > 0);

  clearBallTrail(scene);
  check('clearing takes both', !airRoot() && !waterRoot());
  check('...and the counts with them',
    ballTrailStats('air').count === 0 && ballTrailStats('water').count === 0);
}

// ---------------------------------------------------------------------------
section('THE CLOUD OUTLIVES THE BALL');
{
  // The point of a particle spine: the trail belongs to the water it was left
  // in, not to the ball that left it. It has to go on drifting and dying while
  // the ball is parked in a goal and the world is held for a kickoff.
  reset();
  roll(W.fullSpeed, 30);
  const born = ballTrailStats('water').count;
  coast(6);
  const after = ballTrailStats('water').count;
  check('a ball that stops keeps its trail', after > 0 && after <= born,
    `${born} -> ${after} particles`);
  const before = ballTrailStats('water').meanSpeed;
  coast(6);
  check('...and it is still moving', ballTrailStats('water').meanSpeed > 0,
    `${before.toFixed(2)} -> ${ballTrailStats('water').meanSpeed.toFixed(2)} u/s`);
  coast(Math.ceil((W.life * (1 + W.lifeVary) + 0.2) / dt));
  check('...until its own lifetime is up', ballTrailStats('water').count === 0,
    `life ${W.life}s +/- ${Math.round(W.lifeVary * 100)}%`);
}

// ---------------------------------------------------------------------------
section('SWITCHED OFF');
{
  reset();
  const was = CONFIG.versus.ball.trail.enabled;
  CONFIG.versus.ball.trail.enabled = false;
  roll(W.fullSpeed, 30);
  check('the master switch draws nothing',
    ballTrailStats('water').count === 0 && !waterRoot());
  CONFIG.versus.ball.trail.enabled = was;

  reset();
  const wasW = CONFIG.versus.ball.trail.water.enabled;
  CONFIG.versus.ball.trail.water.enabled = false;
  roll(W.fullSpeed, 30);
  check('water.enabled = false leaves the water alone',
    ballTrailStats('water').count === 0);
  CONFIG.versus.ball.trail.water.enabled = wasW;
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
