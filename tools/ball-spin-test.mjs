#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:spin
//
// The versus ball's SPIN, headless: english off the two sticks disagreeing
// (strike.js strikeEnglish), the contact friction that turns the slide into
// spin and a sideways kick (versus.js strikeBall), the Magnus curve at right
// angles to the flight and its air/water split, the frictional wall bounce
// that trades spin for a skid, and the streaks that draw it all
// (systems/ballSpin.js) — spawned as the spin crosses the threshold, trimmed
// by its rate, travelling its way, gone when it stops.
//
// A Browser pane cannot film any of this (rAF is suspended there), and the
// lab is a look, not a check. This is the check.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enableVersus } from '../path/src/systems/versusFlag.js';
import { bounds, updateBounds, midWater } from '../path/src/arena.js';
import { initPlayer } from '../path/src/entities/player.js';
import { initParticles } from '../path/src/entities/particles.js';
import { strikeEnglish, strikeState, tryStrike, resetStrike } from '../path/src/systems/strike.js';
import {
  ball, initBallAlone, stepBallAlone, strikeBallFrom, resetBall, renderBall, rimRadiusAt, releaseP2, p2,
} from '../path/src/systems/versus.js';
import { streaks, arcFor, updateBallSpin, renderBallSpin, ballSpinState, initBallSpin } from '../path/src/systems/ballSpin.js';
import { overlayScene } from '../path/src/systems/post.js';

const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[animation]') || msg.startsWith('[assets]') || msg.startsWith('[uiText]'))) return;
  realWarn(msg, ...rest);
};
console.info = () => {};

let failures = 0;
function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}
// Seeded: the streaks pick a random start angle.
let seed = 0x5b1a5e11;
Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

const scene = new THREE.Scene();
const dt = 1 / 60;
enableVersus(true);
updateBounds(16 / 9);
initPlayer(scene);
initParticles(scene);
initBallAlone();

const B = CONFIG.versus.ball;
const im = B.impact;
const SS = B.spinStrokes;
const f2 = (v) => Number(v).toFixed(2);

// Put the ball at rest in open water, mid-pitch.
function still() {
  resetBall();
  ball.x = (bounds.left + bounds.right) / 2;
  ball.y = midWater();
  ball.vx = ball.vy = 0;
  ball.spin = 0;
  streaks.length = 0;
}
// A square hit from the left, dash +x, at the given english.
function squareHit(english, power = 1, speed = 46) {
  still();
  return strikeBallFrom({ x: ball.x - ball.r - 3, y: ball.y }, { x: 1, y: 0 }, speed, power, english);
}

// ---------------------------------------------------------------------------
section('the old knobs are gone');
check('impact.spin (rad/s per u/s) no longer exists', im.spin === undefined);
check('impact.spinKick no longer exists', im.spinKick === undefined);
check('impact.friction, squirt, spinMax, spinDecayAir, magnusAir, wallFriction do',
  ['friction', 'squirt', 'spinMax', 'spinDecayAir', 'magnusAir', 'wallFriction'].every((k) => typeof im[k] === 'number'));

// ---------------------------------------------------------------------------
section('english is the sticks disagreeing');
const E = B.english;
check('no swim, no english', strikeEnglish({ x: 0, y: 0 }, { x: 1, y: 0 }) === 0);
check('no aim, no english', strikeEnglish({ x: 1, y: 0 }, { x: 0, y: 0 }) === 0);
check('swimming at the cursor is square', strikeEnglish({ x: 1, y: 0 }, { x: 1, y: 0 }) === 0);
const up = strikeEnglish({ x: 0, y: 1 }, { x: 1, y: 0 });
check('swim anticlockwise of the aim is positive, all the way', up === 1, `${f2(up)}`);
const down = strikeEnglish({ x: 0, y: -1 }, { x: 1, y: 0 });
check('...clockwise is negative', down === -1, `${f2(down)}`);
check('it is the SAME either way round the compass', strikeEnglish({ x: 1, y: 0 }, { x: 0, y: -1 }) === 1 && strikeEnglish({ x: -1, y: 0 }, { x: 0, y: -1 }) === -1);
const dz = E.deadzone;
const inside = strikeEnglish({ x: Math.cos(Math.asin(dz * 0.8)), y: Math.sin(Math.asin(dz * 0.8)) }, { x: 1, y: 0 });
check('inside the deadzone is nothing', inside === 0, `sin=${f2(dz * 0.8)} → ${f2(inside)}`);
const justOut = strikeEnglish({ x: Math.cos(Math.asin(Math.min(0.99, dz + 0.05))), y: Math.sin(Math.asin(Math.min(0.99, dz + 0.05))) }, { x: 1, y: 0 });
check('just past it ramps from zero, not a step', justOut > 0 && justOut < 0.2, `${f2(justOut)}`);
const half = strikeEnglish({ x: 0, y: 0.5 }, { x: 1, y: 0 });
check('a half-pushed stick is half the english', half > 0.3 && half < 0.7, `${f2(half)}`);
E.enabled = false;
check('switched off it reads zero', strikeEnglish({ x: 0, y: 1 }, { x: 1, y: 0 }) === 0);
E.enabled = true;

// ---------------------------------------------------------------------------
section('it rides the dash');
resetStrike();
strikeState.pending = 1;
tryStrike({ x: 1, y: 0 }, { ...CONFIG.player, strikeDashDuration: 0.3, strikeDashSpeed: 46 }, 0.7);
check('player 1 snapshots english onto the dash', strikeState.english === 0.7, `${f2(strikeState.english)}`);
resetStrike();
strikeState.pending = 1;
tryStrike({ x: 1, y: 0 }, { ...CONFIG.player, strikeDashDuration: 0.3, strikeDashSpeed: 46 }, 3);
check('...clamped to ±1', strikeState.english === 1);
resetStrike();
strikeState.pending = 1;
tryStrike({ x: 1, y: 0 }, { ...CONFIG.player, strikeDashDuration: 0.3, strikeDashSpeed: 46 });
check('...and zero when nothing is passed', strikeState.english === 0);
p2.pending = 1;
releaseP2({ x: -1, y: 0 }, -0.4);
check('player 2 too', p2.english === -0.4, `${f2(p2.english)}`);
p2.active = false;

// ---------------------------------------------------------------------------
section('the contact: friction turns the slide into spin');
let r = squareHit(0);
check('a square hit with no english puts no spin on', Math.abs(ball.spin) < 0.05, `spin=${f2(ball.spin)}`);
check('...and flies straight', Math.abs(ball.vy) < 0.5 && ball.vx > 20, `v=(${f2(ball.vx)},${f2(ball.vy)})`);
r = squareHit(1);
const spinPos = ball.spin;
const kickPos = ball.vy;
check('english +1 (swim anticlockwise of the aim) spins it CLOCKWISE', spinPos < -1, `spin=${f2(spinPos)}`);
check('...the face dragged the way the striker swam: report says so', r.slip > 0 && r.jt > 0, `slip=${f2(r.slip)} jt=${f2(r.jt)}`);
check('...and squirts it a little the same way', kickPos > 0.5 && kickPos < ball.vx * 0.5, `vy=${f2(kickPos)} of vx=${f2(ball.vx)}`);
r = squareHit(-1);
check('english -1 mirrors: anticlockwise spin, the other kick', ball.spin > 1 && Math.abs(ball.spin + spinPos) < 0.05 && ball.vy < -0.5, `spin=${f2(ball.spin)} vy=${f2(ball.vy)}`);
r = squareHit(0.5);
check('half the english is less spin, same sign', ball.spin < 0 && Math.abs(ball.spin) < Math.abs(spinPos), `spin=${f2(ball.spin)}`);
check('never past the cap', Math.abs(spinPos) <= im.spinMax + 1e-9, `cap ${im.spinMax}`);

// The Coulomb cap: friction scales the most the face can grab.
const savedMu = im.friction;
im.friction = 0.02;
r = squareHit(1);
check('a slick ball takes far less spin from the same english', Math.abs(ball.spin) < Math.abs(spinPos) * 0.3, `spin=${f2(ball.spin)} vs ${f2(spinPos)}`);
check('...capped at mu x the normal impulse', Math.abs(r.jt) <= 0.02 * r.imp + 1e-6, `jt=${f2(r.jt)} muJ=${f2(0.02 * r.imp)}`);
im.friction = 0;
r = squareHit(1);
check('frictionless: no spin at all, whatever the english', Math.abs(ball.spin) < 1e-9);
im.friction = savedMu;
const savedSq = im.squirt;
im.squirt = 0;
r = squareHit(1);
check('squirt 0: all the spin, none of the kick', ball.spin < -1 && Math.abs(ball.vy) < 1e-6, `spin=${f2(ball.spin)} vy=${f2(ball.vy)}`);
im.squirt = savedSq;
E.sweep = 0;
r = squareHit(1);
check('sweep 0: english does nothing, a square hit is square', Math.abs(ball.spin) < 0.05);
E.sweep = 28;

// Glancing hits spin the ball from their own geometry, no english needed.
still();
strikeBallFrom({ x: ball.x - ball.r - 2, y: ball.y + ball.r * 0.8 }, { x: 1, y: 0 }, 46, 1, 0);
check('a glancing dash spins it on its own', Math.abs(ball.spin) > 0.5, `spin=${f2(ball.spin)}`);

// ---------------------------------------------------------------------------
section('the curve: Magnus at right angles to the flight');
function fly(spin, seconds, airborne = false) {
  still();
  if (airborne) ball.y = bounds.surfaceY + 8;
  ball.vx = 40;
  ball.vy = 0;
  ball.spin = spin;
  const g = CONFIG.arena.gravity;
  CONFIG.arena.gravity = 0;
  const x0 = ball.x;
  const y0 = ball.y;
  for (let t = 0; t < seconds; t += dt) stepBallAlone(dt);
  CONFIG.arena.gravity = g;
  return { dx: ball.x - x0, dy: ball.y - y0, vy: ball.vy, spin: ball.spin };
}
// The coefficient is whatever the live tuning says (imported-tuning.json
// shadows config.js), so the checks are about SHAPE — sign, symmetry,
// linearity in the coefficient — not a number.
const ccw = fly(8, 0.5);
check('anticlockwise spin on a +x flight lifts it (w x v)', ccw.dy > 0.3, `dy=${f2(ccw.dy)} over dx=${f2(ccw.dx)} at magnus ${im.magnus}`);
const cw = fly(-8, 0.5);
check('clockwise bends it down by the same amount', cw.dy < -0.3 && Math.abs(cw.dy + ccw.dy) < 0.05, `dy=${f2(cw.dy)}`);
{
  const saved = im.magnus;
  im.magnus = saved * 2;
  const twice = fly(8, 0.5);
  im.magnus = saved;
  check('twice the coefficient is (about) twice the curve', twice.dy / ccw.dy > 1.8 && twice.dy / ccw.dy < 2.2, `x${f2(twice.dy / ccw.dy)}`);
}
const none = fly(0, 0.5);
check('no spin, no curve', Math.abs(none.dy) < 1e-6);
const air = fly(8, 0.5, true);
check('the same spin barely bends it in the air', air.dy > 0 && air.dy < ccw.dy * 0.4, `air dy=${f2(air.dy)} vs water ${f2(ccw.dy)}`);
check('...and holds its spin up there', air.spin > ccw.spin * 1.1, `air ${f2(air.spin)} vs water ${f2(ccw.spin)} after 0.5s`);
const expWater = 8 * Math.exp(-im.spinDecay * 0.5);
check('water bleeds spin on impact.spinDecay', Math.abs(ccw.spin - expWater) < 0.1, `${f2(ccw.spin)} vs ${f2(expWater)}`);
const expAir = 8 * Math.exp(-im.spinDecayAir * 0.5);
check('air on impact.spinDecayAir', Math.abs(air.spin - expAir) < 0.1, `${f2(air.spin)} vs ${f2(expAir)}`);
const savedMag = im.magnus;
im.magnus = 0;
const flat = fly(8, 0.5);
check('magnus 0 is a straight ball however it spins', Math.abs(flat.dy) < 1e-6);
im.magnus = savedMag;

// ---------------------------------------------------------------------------
section('the walls: friction against the rock');
// Magnus off for these, so the only thing moving the ball sideways is the floor.
function drop(spin, vx = 0, vy = -30) {
  still();
  ball.y = bounds.bottom + ball.r + 0.5;
  ball.vx = vx;
  ball.vy = vy;
  ball.spin = spin;
  const saved = im.magnus;
  im.magnus = 0;
  for (let i = 0; i < 4; i++) stepBallAlone(dt);
  im.magnus = saved;
  return { vx: ball.vx, vy: ball.vy, spin: ball.spin };
}
const rollL = drop(10);
check('anticlockwise spin onto the floor rolls it LEFT', rollL.vx < -1, `vx=${f2(rollL.vx)}`);
check('...and costs spin', rollL.spin < 10 * 0.9, `spin ${f2(rollL.spin)} from 10`);
const slipAfter = -rollL.vx - rollL.spin * ball.r; // v_t - w r with t = (-1, 0)
check('...to the point of rolling: the slip at the contact is (nearly) gone', Math.abs(slipAfter) < 1.5, `slip=${f2(slipAfter)}`);
const rollR = drop(-10);
check('clockwise rolls it right, mirror for mirror', rollR.vx > 1 && Math.abs(rollR.vx + rollL.vx) < 0.05, `vx=${f2(rollR.vx)}`);
check('the bounce itself is untouched', Math.abs(rollR.vy - rollL.vy) < 1e-6 && rollR.vy > 0);
const savedWmu = im.wallFriction;
im.wallFriction = 0;
const slick = drop(10);
check('wallFriction 0: no skid, spin kept', Math.abs(slick.vx) < 1e-6 && Math.abs(slick.spin - 10 * Math.exp(-im.spinDecay * dt * 4)) < 0.05, `vx=${f2(slick.vx)} spin=${f2(slick.spin)}`);
im.wallFriction = 0.05;
const light = drop(10);
check('a little friction is a little skid, capped at mu x the normal impulse', light.vx < 0 && Math.abs(light.vx) < Math.abs(rollL.vx) && Math.abs(light.vx) <= 0.05 * 30 * (1 + B.restitution) + 1e-6, `vx=${f2(light.vx)}`);
im.wallFriction = savedWmu;
// A ball already rolling true takes no kick.
{
  still();
  const w = 6;
  ball.y = bounds.bottom + ball.r + 0.5;
  ball.vx = -w * ball.r; // v_t = -vx along t=(-1,0) → v_t = w r → slip 0
  ball.vy = -30;
  ball.spin = w;
  const vx0 = ball.vx;
  const savedM = im.magnus;
  im.magnus = 0;
  for (let i = 0; i < 4; i++) stepBallAlone(dt);
  im.magnus = savedM;
  const dvx = ball.vx - vx0 * Math.pow(B.drag, 4);
  check('a ball rolling true bounces with no sideways kick', Math.abs(dvx) < 0.3, `dvx=${f2(dvx)}`);
}

// ---------------------------------------------------------------------------
section('the streaks: spawned, trimmed, travelling, gone');
still();
updateBallSpin(0, dt);
check('a still ball has no strokes', streaks.length === 0);
check('arcFor: nothing under spinMin', arcFor(SS.spinMin * 0.9) === 0);
check('arcFor: arcMin at spinMin', Math.abs(arcFor(SS.spinMin) - SS.arcMin) < 1e-9);
check('arcFor: arcMax at spinFull and beyond', Math.abs(arcFor(SS.spinFull) - SS.arcMax) < 1e-9 && arcFor(SS.spinFull * 3) === SS.arcMax);
const mid = arcFor((SS.spinMin + SS.spinFull) / 2);
check('...monotonic between', mid > SS.arcMin && mid < SS.arcMax, `${f2(mid)}`);
check('...sign blind', arcFor(-10) === arcFor(10));

updateBallSpin(10, dt);
check(`spin crossing spinMin spawns ${SS.count} strokes at once`, streaks.length === SS.count, `${streaks.length}`);
const spacing = Math.abs(((streaks[1].phase - streaks[0].phase) % (Math.PI * 2)));
check('...spaced evenly round the ball', Math.abs(spacing - (Math.PI * 2) / SS.count) < 1e-6, `${f2(spacing)} rad`);
check('...each on its own lane', new Set(streaks.map((s) => s.lane)).size === SS.count);
const ph0 = streaks[0].phase;
for (let i = 0; i < 60; i++) updateBallSpin(10, dt);
check('a second in, the arcs have chased the target', Math.abs(streaks[0].arc - arcFor(10)) < 0.05, `${f2(streaks[0].arc)} vs ${f2(arcFor(10))}`);
const travelled = streaks[0].phase - ph0;
check('and travelled round with the spin, its way, at travel x the rim', Math.abs(travelled - SS.travel * 10 * 1.0) < 0.2, `${f2(travelled)} rad vs ${f2(SS.travel * 10)}`);
check('...faded in', streaks.every((s) => s.fade === 1));
const before = streaks[0].phase;
updateBallSpin(-10, dt);
check('spin the other way, they travel the other way', streaks[0].phase < before);

// Drawn: hugging the soft body, outside the rim.
ball.spin = 10;
renderBall();
const drawn = renderBallSpin(ball, rimRadiusAt);
check('renderBallSpin draws every live stroke', drawn === SS.count, `${drawn}`);
const st = ballSpinState();
check('the mesh is in the post chain\'s OVERLAY scene, over the goo, not in the world', overlayScene.getObjectByName('ballSpinStreaks') != null && scene.getObjectByName('ballSpinStreaks') == null);
{
  const mesh = overlayScene.getObjectByName('ballSpinStreaks');
  const pos = mesh.geometry.attributes.position;
  const n = mesh.geometry.drawRange.count;
  check('the draw range covers exactly the live strokes', n === SS.count * SS.segments * 6, `${n}`);
  let minR = 1e9; let maxR = 0;
  for (let i = 0; i < SS.count * (SS.segments + 1) * 2; i++) {
    const d = Math.hypot(pos.getX(i) - ball.x, pos.getY(i) - ball.y);
    minR = Math.min(minR, d); maxR = Math.max(maxR, d);
  }
  check('every vertex sits outside the rim, within the lanes (plus the tail flare)', minR > ball.r * (SS.hug - 0.01) - SS.width && maxR < ball.r * (SS.hug + SS.lift * SS.count + (SS.flare ?? 0) + 0.01) + SS.width, `r ∈ [${f2(minR)}, ${f2(maxR)}] on a ${f2(ball.r)} ball`);
  const col = mesh.geometry.attributes.color;
  let peak = 0; let ends = 0;
  for (let s = 0; s < SS.count; s++) {
    const base = s * (SS.segments + 1) * 2;
    ends += col.getX(base) + col.getX(base + SS.segments * 2);
    for (let i = 0; i <= SS.segments; i++) peak = Math.max(peak, col.getX(base + i * 2));
  }
  check('the band tapers to nothing at both ends and is bright in the middle', ends < 1e-6 && peak > 0.5, `ends=${f2(ends)} peak=${f2(peak)}`);
  check('additive, no depth write', mesh.material.blending === THREE.AdditiveBlending && mesh.material.depthWrite === false);
  // The strip's winding follows the spin's sign; a one-sided material culls
  // every clockwise stroke and nothing else in the harness can see that.
  check('double-sided, so a clockwise ball keeps its strokes', mesh.material.side === THREE.DoubleSide);
  {
    // And prove the winding really does flip: the signed area of the first
    // triangle changes sign with the spin.
    // A triangle from the MIDDLE of the strip: at the ends the taper closes
    // the band to a line and the area is zero whichever way it winds.
    const area = () => {
      const p = mesh.geometry.attributes.position;
      const a = Math.floor(SS.segments / 2) * 2;
      const ax = p.getX(a), ay = p.getY(a), bx = p.getX(a + 1), by = p.getY(a + 1), cx = p.getX(a + 2), cy = p.getY(a + 2);
      return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    };
    updateBallSpin(10, dt); renderBallSpin(ball, rimRadiusAt);
    const plus = area();
    updateBallSpin(-10, dt); renderBallSpin(ball, rimRadiusAt);
    const minus = area();
    check('...because the winding flips with the spin', Math.sign(plus) !== Math.sign(minus) && plus !== 0 && minus !== 0, `${plus.toExponential(2)} vs ${minus.toExponential(2)}`);
    updateBallSpin(10, dt); renderBallSpin(ball, rimRadiusAt);
  }
}
void st;

// A dent bends the stroke with the skin: the hugged radius follows rimRadiusAt.
{
  const a = streaks[0].phase;
  const before = rimRadiusAt(a);
  ball.rim.fill(0);
  const n = ball.rim.length;
  // dent the sample nearest that angle
  const j = Math.round((((a - ball.angle) / (Math.PI * 2)) * n) % n + n) % n;
  ball.rim[j] = -0.5;
  const after = rimRadiusAt(a);
  check('rimRadiusAt follows a dent between samples', after < before - 0.2, `${f2(before)} → ${f2(after)}`);
  ball.rim.fill(0);
}

// Gone: spin below the threshold trims them away and they leave.
for (let i = 0; i < 120; i++) updateBallSpin(0, dt);
check('spin gone: the strokes trim and fade out', streaks.length === 0, `${streaks.length} left`);
check('...and nothing is drawn', renderBallSpin(ball, rimRadiusAt) === 0);
updateBallSpin(SS.spinMin * 1.2, dt);
check('spin back: a fresh set', streaks.length === SS.count);
for (let i = 0; i < 90; i++) updateBallSpin(SS.spinMin * 1.2, dt);
check('a light spin is a short tick', streaks[0].arc < arcFor(SS.spinFull) * 0.35, `${f2(streaks[0].arc)} rad`);
const savedEn = SS.enabled;
SS.enabled = false;
updateBallSpin(10, dt);
check('switched off: no strokes', streaks.length === 0 && renderBallSpin(ball, rimRadiusAt) === 0);
SS.enabled = savedEn;

// The lab door: stepBallAlone drives the strokes off the ball's own spin.
still();
ball.spin = 12;
for (let i = 0; i < 10; i++) stepBallAlone(dt);
check('stepBallAlone feeds them (the lab needs no extra call)', streaks.length === SS.count && streaks[0].arc > 0.1);
initBallSpin(overlayScene);
check('re-init keeps one mesh', overlayScene.children.filter((c) => c.name === 'ballSpinStreaks').length === 1);

// ---------------------------------------------------------------------------
console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll spin checks passed.');
process.exit(failures ? 1 : 0);
