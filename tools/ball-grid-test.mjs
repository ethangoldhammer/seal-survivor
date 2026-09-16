#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:ballgrid
//
// The ball, and the hex lattice behind it. Three layers, one shot:
//
//   THE LEDGER   systems/ballLook.js — every contact stamps an IMPULSE (the
//                change in the ball's velocity) and pushes an event pulse. Both
//                already existed for other reasons; this channel reads them
//                rather than growing a second opinion about what a hit is.
//   THE CHAIN    systems/ballGrid.js — the ball's own dent, pinned under it,
//                plus the echoes it leaves behind, each springing out on its
//                own clock and retiring on its own.
//   THE LATTICE  systems/grid.js — turns that list into uniforms: a signed
//                amplitude the vertex shader drags the nodes with, and a glow
//                the fragment shader lights them by.
//
// WHAT ONLY A HARNESS CAN SEE. Three of these are invisible in a screenshot and
// wrong in a way that still looks like an effect:
//
//   THE DRAG ARRIVES LATE. The lattice is pulled along a LAGGED copy of the
//   ball's heading, so a ball that turns keeps being dragged the old way for a
//   moment and comes round over the next few dents. A drag that has finished
//   swinging and one that never lagged at all draw the identical still frame —
//   the only way to tell them apart is to read the angle between the heading
//   and the flight while the turn is happening, which is what this does.
//
//   A CONTACT IS AN EDGE. It is an instant, so anything counting frames in
//   which some number is large counts one strike as hundreds. (This game has
//   made that mistake before: see the frozen timer that counted a single event
//   182 times.)
//
//   THE SPRING IS SOLVED ON THE CPU. It has to be: the shader has no clock that
//   agrees with the one the echoes are RETIRED on, and a dent drawn at one age
//   and retired at another vanishes mid-swing.
//
// Everything expected is derived from CONFIG rather than typed in — saved
// tuning beats config.js at import, so a hardcoded 2.6 here would be testing
// imported-tuning.json rather than the code.
//
// What it cannot tell you: whether the thing looks good behind a real match.
// That is npm run looks:ball, and a match.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import {
  resetBallLook, updateBallLook, setBallBody, setBallDrive,
  noteBallMomentum, ballEvent, ballTeams, ballContacts, ballLookState,
} from '../path/src/systems/ballLook.js';
import {
  updateBallGrid, publishBallGrid, resetBallGrid, ballGridState, springAt,
} from '../path/src/systems/ballGrid.js';
import { createGrid } from '../path/src/systems/grid.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

const G = CONFIG.versus.ball.grid;
const R = 2.5;            // a plausible ball radius; the real one is solved
const DT = 1 / 60;

console.log('Merged CONFIG.versus.ball.grid (saved tuning wins over config.js defaults):');
console.log(`  amount ${G.amount}  base ${G.base}  bySpeed ${G.bySpeed}  byPulse ${G.byPulse}  hitScale ${G.hitScale}`);
console.log(`  radial ${G.radial}  drive ${G.drive}  swirl ${G.swirl}  stretch ${G.stretch}`);
console.log(`  headingLag ${G.headingLag}/s  springHz ${G.springHz}  damp ${G.damp}  life ${G.life}s  spacing ${G.spacing} radii`);
console.log(`  reach ${G.reach}  echoReach ${G.echoReach}  gain ${G.gain}  alpha ${G.alpha}`);

// --- driving the ball -------------------------------------------------------
// The two calls the match makes, in the order it makes them. `place` is one
// frame of a ball sitting where it is told with the velocity it is told.
function place(x, y, vx, vy) {
  const speed = Math.hypot(vx, vy);
  setBallDrive({ speed01: Math.min(1, speed / 30) });
  setBallBody({ x, y, r: R, speed, vx, vy });
  updateBallLook(DT);
}
function frame(x, y, vx, vy, dt = DT) {
  place(x, y, vx, vy);
  updateBallGrid(dt);
}
function fresh() {
  resetBallLook();
  resetBallGrid();
  // Two frames of settling: the first is the chain's FIRST SIGHT of the ball,
  // which deliberately drops nothing (see `firstSight`).
  frame(0, 0, 0, 0);
  frame(0, 0, 0, 0);
}

// ---------------------------------------------------------------------------
section('THE SPRING — a dent is born shoved, rings through its own centre, dies');
{
  const omega = G.springHz * Math.PI * 2;
  const at0 = springAt(0, omega, G.damp);
  check('born at full shove, not at zero', near(at0.amp, 1) && near(at0.glow, 1),
    `amp ${at0.amp.toFixed(3)}`);
  // Half a period of the cosine puts it on the far side of its own centre.
  const half = springAt(0.5 / G.springHz, omega, G.damp);
  check('...and swings back THROUGH the centre, not just down to it',
    half.amp < 0, `amp ${half.amp.toFixed(3)} at ${(0.5 / G.springHz).toFixed(3)}s`);
  check('...with the glow never going negative, so the light cannot strobe',
    half.glow > 0 && springAt(1, omega, G.damp).glow > 0,
    `glow ${half.glow.toFixed(3)}`);
  const late = springAt(G.life, omega, G.damp);
  check('...and is all but invisible by the time it is retired',
    Math.abs(late.glow) < 0.15, `glow ${late.glow.toFixed(4)} at life ${G.life}s`);
}

// ---------------------------------------------------------------------------
section('NO BALL, NO DENTS — the channel is off outside a match');
{
  resetBallLook();
  resetBallGrid();
  updateBallGrid(DT);
  const st = ballGridState();
  check('nothing is published before a ball exists', st.spec.dents === 0 && !st.spec.field);
  const scene = new THREE.Scene();
  const grid = createGrid(scene);
  publishBallGrid(grid);
  check('...and the lattice is told so, rather than left holding the last frame',
    grid.ballState().on === 0);
  check('...with every slot at zero amplitude, which costs its loop and nothing else',
    grid.ballState().dents.every((d) => d.amp === 0 && d.glow === 0));
  grid.dispose();
}

// ---------------------------------------------------------------------------
section('THE HEAD — the ball holds its own dent open under itself');
{
  fresh();
  // A ball only has a possession field once somebody has touched it (ballTeams
  // is null until then), which is also when it first dents anything.
  noteBallMomentum(0, 0, 0, 12, 0, 0);
  frame(0, 0, 12, 0);
  const st = ballGridState();
  const head = st.dents[0];
  check('the ball has a dent', head.live && head.amp0 > 0, `amp0 ${head.amp0.toFixed(3)}`);
  check('...sized in ball radii, not in world units', near(head.radius, R * G.reach),
    `${head.radius.toFixed(2)} = ${R} x ${G.reach}`);
  check('...and re-stamped every frame, so its spring never leaves full shove',
    (() => { for (let i = 0; i < 30; i++) frame(0, 0, 12, 0); return near(ballGridState().dents[0].age, 0); })(),
    `age ${ballGridState().dents[0].age}`);
}

// ---------------------------------------------------------------------------
section('THE ECHOES — dropped by TRAVEL, so the chain is even at any speed');
{
  fresh();
  noteBallMomentum(0, 0, 0, 30, 0, 0);
  // The frame a struck ball first appears leaves ONE mark where it was struck.
  frame(0, 0, 30, 0);
  const struck = ballGridState().live;
  check('a contact leaves its mark on the frame it lands', struck === 2,
    `${struck} dent(s)`);
  // Sat still after it: moving in the ledger's eyes, but going nowhere.
  for (let i = 0; i < 40; i++) frame(0, 0, 30, 0);
  check('...and a ball that has not moved since lays no more chain',
    ballGridState().live === struck, `${ballGridState().live} dent(s)`);

  fresh();
  noteBallMomentum(0, 0, 0, 30, 0, 0);
  let x = 0;
  const step = R * G.spacing;
  for (let i = 0; i < 4; i++) { x += step * 1.01; frame(x, 0, 30, 0); }
  const st = ballGridState();
  // The head, plus one echo per spacing of travel. The first of the four is
  // also the mark left where it was struck — one drop, not two: the frame a
  // contact lands on is a frame the ball has travelled on too.
  check('...and one that has drops one echo per spacing of travel',
    st.live === 5, `${st.live} dent(s) after 4 x ${step.toFixed(2)}u`);
  const gaps = [];
  for (let i = 1; i < 4; i++) gaps.push(Math.hypot(st.dents[i].x - st.dents[i + 1].x, st.dents[i].y - st.dents[i + 1].y));
  check('...evenly spaced, oldest last', gaps.every((g) => near(g, step * 1.01, 1e-3)),
    gaps.map((g) => g.toFixed(2)).join(', '));
  check('...and the newest echo is the youngest', st.dents[1].age < st.dents[4].age,
    `${st.dents[1].age.toFixed(3)}s vs ${st.dents[4].age.toFixed(3)}s`);
  check(`...each smaller than the ball's own dent, because it is settling`,
    st.dents[1].radius < st.dents[0].radius,
    `${st.dents[1].radius.toFixed(2)} vs ${st.dents[0].radius.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
section('RETIREMENT — a dent dies on its own, and the chain does not grow forever');
{
  fresh();
  noteBallMomentum(0, 0, 0, 30, 0, 0);
  let x = 0;
  const step = R * G.spacing * 1.01;
  for (let i = 0; i < 200; i++) { x += step; frame(x, 0, 30, 0); }
  const st = ballGridState();
  check('the chain is capped by the lattice band, not by how far the ball went',
    st.live <= 8, `${st.live} live of ${st.dents.length} slots`);
  // Park the ball: the head stops being re-stamped only when the ball leaves,
  // so age the echoes out by the life of one.
  const before = ballGridState().live;
  for (let i = 0; i < Math.ceil(G.life / DT) + 4; i++) frame(x, 0, 0, 0);
  check('...and one left in still water is retired, not left hanging',
    ballGridState().live < before, `${before} -> ${ballGridState().live}`);
}

// ---------------------------------------------------------------------------
section('THE DRAG — the flight, arriving late');
{
  fresh();
  // Running right at 30, then clipped upward: the new flight is up-and-right.
  noteBallMomentum(0, 0, 0, 30, 0, 0);
  let x = 0;
  const step = R * G.spacing * 1.01;
  for (let i = 0; i < 3; i++) { x += step; frame(x, 0, 30, 0); }
  const cruising = ballGridState();
  check('cruising, the lattice is dragged along the flight',
    near(cruising.dents[0].dirX, 1, 1e-3) && near(cruising.dents[0].dirY, 0, 1e-3),
    `(${cruising.dents[0].dirX.toFixed(2)}, ${cruising.dents[0].dirY.toFixed(2)})`);

  // The turn. The flight is now 45 degrees up from where it was.
  frame(x, 0, 30, 30);
  const turned = ballGridState();
  const angleTo = (d, vx, vy) => {
    const sp = Math.hypot(vx, vy);
    return Math.acos(Math.max(-1, Math.min(1, (d.dirX * vx + d.dirY * vy) / sp))) * 180 / Math.PI;
  };
  const lagged = angleTo(turned.dents[0], 30, 30);
  check('the frame of the turn, the drag has NOT arrived at the new flight',
    lagged > 20, `${lagged.toFixed(1)}° behind it`);
  check('...but it has started to swing, rather than sitting on the old line',
    lagged < 45 - 0.5, `${lagged.toFixed(1)}° of the 45° turn left`);

  // ...and it gets there. Six time constants of the LIVE headingLag, not a
  // hardcoded count of frames: the whole point of this knob is that it moves,
  // and a test that assumed half a second would start failing the moment
  // anybody tuned the lag slower.
  const settle = Math.ceil(6 / Math.max(0.2, G.headingLag) / DT);
  for (let i = 0; i < settle; i++) frame((x += step), 0, 30, 30);
  const arrived = angleTo(ballGridState().dents[0], 30, 30);
  check(`...and ${(settle * DT).toFixed(2)}s later it is on the new line`,
    arrived < 1, `${arrived.toFixed(2)}° behind it`);

  // THE CHAIN IS THE PATH. Every dent keeps the heading it was born with, so
  // the echoes left during the swing are a record of the turn rather than all
  // of them snapping to wherever the ball ended up.
  fresh();
  noteBallMomentum(0, 0, 0, 30, 0, 0);
  x = 0;
  for (let i = 0; i < 3; i++) { x += step; frame(x, 0, 30, 0); }
  for (let i = 0; i < 3; i++) { x += step; frame(x, 0, 30, 30); }
  const chain = ballGridState().dents.filter((d) => d.live).map((d) => d.dirY);
  const rising = chain.every((v, i) => i === 0 || v <= chain[i - 1] + 1e-9);
  check('the chain keeps the headings it was born with, newest most turned',
    rising && chain[0] > chain[chain.length - 1], chain.map((v) => v.toFixed(2)).join(' > '));

  // A DEAD REVERSAL — a wall bounce straight back, and the one case a lerp
  // between the two vectors cannot do at all: it only ever shortens the old
  // heading along its own line, and a renormalise puts it back to full length
  // still pointing the wrong way. It never turns, it stays a unit vector, and
  // every check that is not this one passes.
  fresh();
  noteBallMomentum(0, 0, 0, 30, 0, 0);
  x = 0;
  for (let i = 0; i < 3; i++) { x += step; frame(x, 0, 30, 0); }
  const reverse = Math.ceil(6 / Math.max(0.2, G.headingLag) / DT);
  for (let i = 0; i < reverse; i++) { x -= step; frame(x, 0, -30, 0); }
  const hd = ballGridState().heading;
  check('a straight-back wall bounce leaves the heading a unit vector',
    Number.isFinite(hd.x) && Number.isFinite(hd.y)
      && near(Math.hypot(hd.x, hd.y), 1, 1e-6),
    `(${hd.x.toFixed(3)}, ${hd.y.toFixed(3)}) len ${Math.hypot(hd.x, hd.y).toFixed(6)}`);
  check('...and actually comes round to the way the ball is now going',
    hd.x < -0.99, `x ${hd.x.toFixed(3)}`);

  // A BALL AT A DEAD STOP has no heading to chase. The last one is held rather
  // than decayed toward nothing, or a ball trapped against a wall would have
  // its dent quietly rotate to whatever was left in the accumulator.
  const held = { ...ballGridState().heading };
  for (let i = 0; i < 20; i++) frame(x, 0, 0, 0);
  const after = ballGridState().heading;
  check('a ball at a dead stop holds the heading it arrived on',
    near(after.x, held.x, 1e-9) && near(after.y, held.y, 1e-9));
}

// ---------------------------------------------------------------------------
section('A CONTACT — counted on the edge, and amplified');
{
  fresh();
  noteBallMomentum(0, 0, 0, 30, 0, 0);
  let x = 0;
  const step = R * G.spacing * 1.01;
  for (let i = 0; i < 3; i++) { x += step; frame(x, 0, 30, 0); }
  const cruise = ballGridState().dents[0];

  const seq0 = ballContacts();
  noteBallMomentum(1, 30, 0, 30, 30, Math.PI / 2);
  ballEvent('bounce', { force: 1, team: 1 });
  check('the ledger counted the contact, once', ballContacts() === seq0 + 1,
    `${seq0} -> ${ballContacts()}`);

  const liveBefore = ballGridState().live;
  frame(x, 0, 30, 30);                       // the frame the contact lands on
  const st = ballGridState();
  check('a mark is left AT the contact even though the ball barely moved',
    st.live === liveBefore + 1, `${liveBefore} -> ${st.live}`);
  check('...bigger than an ordinary one, by hitScale x the pulse the event fired',
    st.dents[1].amp0 > cruise.amp0 * G.hitScale,
    `${st.dents[1].amp0.toFixed(3)} vs cruise ${cruise.amp0.toFixed(3)}`);

  // THE EDGE. The count sits at the same value for every frame after the
  // contact; a window rather than an edge would drop a mark on all of them.
  const after = ballGridState().live;
  for (let i = 0; i < 6; i++) frame(x, 0, 30, 30);
  check('...and the contact is counted ONCE, not on every frame since',
    ballGridState().live === after, `${after} -> ${ballGridState().live}`);
}

// ---------------------------------------------------------------------------
section('A SPIKE GOUGES IT — deeper, wider, and the echoes closer together');
// ---------------------------------------------------------------------------
// The pulse channel cannot say "spike" on its own: a spike raises `pulse` only
// through the speed it leaves at, and speed is already the `bySpeed` term — so
// without this a spike read as "a fast shot" and nothing more. Three things at
// once, and the third is the one that reads from across the pitch.
{
  const SK = G.spike;
  // The same flight twice, at the same speed, with and without a spike ringing.
  // The ONLY difference between the two runs is ballEvent's `spike`, so
  // anything that moves is this and nothing else.
  // A FIELD FIRST. The chain publishes nothing until somebody has touched the
  // ball (`live` in updateBallGrid reads ballTeams()), so a run that skipped
  // this would measure two identical sets of dents that were never stamped —
  // which is a pass-shaped way of measuring nothing at all.
  const run = (spike) => {
    fresh();
    noteBallMomentum(1, 0, 0, 30, 0, 0);
    ballEvent('bounce', { force: 1, team: 1, spike });
    let x = 0;
    const marks = [];
    // Three ordinary spacings of travel. Short on purpose: the pool holds eight
    // dents, and a flight long enough to fill it would measure the CEILING
    // rather than how close together they were laid.
    const travel = R * G.spacing * 3;
    const steps = 40;
    for (let i = 0; i < steps; i++) {
      x += travel / steps;
      frame(x, 0, 30, 0);
      if (i === 0) { const st = ballGridState(); marks.push(st.dents[0].amp0, st.dents[0].radius, ballLookState().spike); }
    }
    return { amp: marks[0], radius: marks[1], hot: marks[2], drops: ballGridState().live };
  };
  const plain = run(0);
  const spiked = run(1);
  check('a spike is carried on the look, where the backdrop can read it',
    spiked.hot > 0.5 && plain.hot === 0, `${spiked.hot.toFixed(2)} against ${plain.hot}`);
  check('...and the dent under the ball is driven harder for it',
    spiked.amp > plain.amp * 1.1, `${plain.amp.toFixed(3)} → ${spiked.amp.toFixed(3)} (amount x${SK.amount})`);
  check('...and reaches further', spiked.radius > plain.radius * 1.05,
    `${plain.radius.toFixed(2)} → ${spiked.radius.toFixed(2)} (reach x${SK.reach})`);
  // THE FURROW. Echoes are dropped every `spacing` ball-radii of travel; a
  // spike shortens the spacing, so the SAME distance of flight leaves more
  // marks in it. This is the one of the three that turns a string of separate
  // dents into something continuous, and it is the one a reader sees first.
  check('...and lays its echoes closer together over the same flight',
    spiked.drops > plain.drops, `${plain.drops} live dent(s) against ${spiked.drops} over the same three spacings`);

  // IT RINGS DOWN. What the water should show is the MOMENT the ball was
  // driven — held open for the whole flight it would say only that a spike
  // happened somewhere, which the speed already says louder.
  fresh();
  noteBallMomentum(1, 0, 0, 30, 0, 0);
  ballEvent('bounce', { force: 1, team: 1, spike: 1 });
  const hot = ballLookState().spike;
  for (let i = 0; i < 60; i++) frame(i * 0.5, 0, 30, 0);
  check('a spike rings down rather than latching for the flight',
    ballLookState().spike < hot * 0.2, `${hot.toFixed(2)} → ${ballLookState().spike.toFixed(3)} after a second`);

  // AND IT IS CAPPED, so a diveGain raised for balance cannot tear the
  // backdrop open — the grid reads `max` and not whatever it is handed.
  fresh();
  noteBallMomentum(1, 0, 0, 30, 0, 0);
  ballEvent('bounce', { force: 1, team: 1, spike: 50 });
  frame(0, 0, 30, 0);
  const wild = ballGridState().dents[0].amp0;
  fresh();
  noteBallMomentum(1, 0, 0, 30, 0, 0);
  // BOTH well over the cap, not one AT it: the look decays a little between
  // ballEvent and the grid reading it, so a spike authored exactly at `max`
  // arrives just under and would differ for an honest reason that has nothing
  // to do with the clamp.
  ballEvent('bounce', { force: 1, team: 1, spike: SK.max * 5 });
  frame(0, 0, 30, 0);
  check('...and two spikes past the cap land identically — the clamp binds',
    near(wild, ballGridState().dents[0].amp0, 1e-6),
    `${wild.toFixed(3)} at 50 against ${ballGridState().dents[0].amp0.toFixed(3)} at ${(SK.max * 5).toFixed(1)}, cap ${SK.max}`);
}

// ---------------------------------------------------------------------------
section('THE COLOUR — the dents are lit by the same field the ball is painted with');
{
  fresh();
  noteBallMomentum(0, 0, 0, 20, 0, 0);
  frame(R, 0, 20, 0);
  const scene = new THREE.Scene();
  const grid = createGrid(scene);
  publishBallGrid(grid);
  const st = grid.ballState();
  const teams = ballTeams();
  check('the lattice is switched on', st.on === 1);
  check('...and handed the possession field itself, not a copy of it',
    teams !== null && st.field.a === teams.a && st.field.b === teams.b
      && near(st.field.share, teams.share) && near(st.field.seed, teams.seed),
    `a #${st.field.a.toString(16)} b #${st.field.b.toString(16)} share ${st.field.share.toFixed(3)}`);
  check(`...with the drop's own shape, so the dents hold the same substance`,
    st.field.lobes === teams.lobes && near(st.field.lobeSize, teams.lobeSize)
      && near(st.field.wobble, teams.wobble) && near(st.field.spin, teams.spin),
    `${st.field.lobes} lobes`);
  check('...and the slosh, so a struck ball drags its colours the same way',
    near(st.field.driftX, teams.driftX) && near(st.field.driftY, teams.driftY));
  check('the shape knobs reach the shader as CONFIG has them',
    near(st.warp.radial, G.radial) && near(st.warp.drive, G.drive)
      && near(st.warp.swirl, G.swirl) && near(st.warp.stretch, G.stretch));
  check('...and so do the two gains', near(st.gain.color, G.gain) && near(st.gain.alpha, G.alpha));
  // THE GLOW IS THE ENVELOPE. A slot lit by the signed amplitude goes black
  // every time its spring crosses zero — a strobe, not water settling.
  check('every published slot carries a non-negative glow',
    st.dents.every((d) => d.glow >= 0));
  check(`...and the ball's own dent is lit at all`, st.dents[0].glow > 0,
    `glow ${st.dents[0].glow.toFixed(3)}`);
  grid.dispose();
}

// ---------------------------------------------------------------------------
section('A RESET — the chain does not survive a kickoff, or a match ending');
{
  fresh();
  noteBallMomentum(0, 0, 0, 30, 0, 0);
  let x = 0;
  for (let i = 0; i < 6; i++) { x += R * G.spacing * 1.01; frame(x, 0, 30, 0); }
  check('there is a chain to clear', ballGridState().live > 1);
  resetBallGrid();
  check('...and it is gone, not left springing across the centre spot',
    ballGridState().live === 0);
  const scene = new THREE.Scene();
  const grid = createGrid(scene);
  publishBallGrid(grid);
  check('...including in the lattice', grid.ballState().on === 0);
  grid.dispose();
}

// ---------------------------------------------------------------------------
section('THE SWITCH — CONFIG.versus.ball.grid.enabled false is genuinely off');
{
  const was = G.enabled;
  fresh();
  noteBallMomentum(0, 0, 0, 30, 0, 0);
  frame(R, 0, 30, 0);
  check('on, there is something to publish', ballGridState().live > 0);
  G.enabled = false;
  updateBallGrid(DT);
  check('off, there is not', ballGridState().live === 0);
  G.enabled = was;
}

console.log(failures === 0 ? '\nall passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
