#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:bot
//
// The versus bot (systems/versusBot.js) and the imitation pipeline
// (systems/imitation.js, tools/imitate-train.mjs), headless.
//
// The bot half asks the only questions that matter about a scripted
// opponent: does it take over player 2 when no pad is on it, does it score
// against a seal that does nothing, and does it go and eat when its meter
// runs dry. The imitation half closes the loop WITHOUT a human: the script
// plays, its rows are filed the way a player's would be, the trainer fits a
// policy to them, and the policy then drives player 2 in its place — so the
// whole path from a row in the log to a seal moving on it is proven before
// anyone has recorded a single match.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enableVersus } from '../path/src/systems/versusFlag.js';
import { bounds, updateBounds, midWater } from '../path/src/arena.js';
import { player, initPlayer, resetPlayer } from '../path/src/entities/player.js';
import { strikeState, resetStrike } from '../path/src/systems/strike.js';
import { initParticles } from '../path/src/entities/particles.js';
import { spawnXpOrb, resetPickups } from '../path/src/entities/pickups.js';
import {
  versusState, ball, p2, startVersus, updateVersus, updateVersusClock, resetBall, resetVersus, rematch,
} from '../path/src/systems/versus.js';
import { botState, botWanted, setBotPolicy, botPolicy } from '../path/src/systems/versusBot.js';
import {
  features, actions, recordImitation, imitationState, resetImitation, N_FEATURES, N_ACTIONS, policyUsable, policyAction,
} from '../path/src/systems/imitation.js';
import { train, evaluate, clearsFloors } from './imitate-train.mjs';

const scene = new THREE.Scene();
const dt = 1 / 60;
let failures = 0;
const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[animation]') || msg.startsWith('[assets]') || msg.startsWith('[uiText]'))) return;
  realWarn(msg, ...rest);
};
console.info = () => {};
function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

// Seeded, so a bot that scores in 30 seconds today scores in 30 seconds tomorrow.
let seed = 0x5ea1b0;
Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

const stillHuman = { move: new THREE.Vector2(0, 0), aim: new THREE.Vector2(1, 0), strikeHeld: false, strikeRelease: false };
function frame(humanInput = stillHuman) {
  const scale = updateVersusClock(dt);
  updateVersus(dt * scale, null, humanInput);
  return scale;
}
function run(seconds, humanInput = stillHuman) {
  for (let t = 0; t < seconds; t += dt) frame(humanInput);
}
// Frame until the match is in play — through a kickoff's count, or a goal's
// shutter and the kickoff after it. Bounded, so a phase that never closes is
// a failure and not a hang.
function toPlay(limit = 12) {
  for (let t = 0; t < limit && versusState.phase !== 'play'; t += dt) frame();
}

enableVersus(true);
updateBounds(16 / 9);
initPlayer(scene);
initParticles(scene);
resetPlayer();
resetStrike();
const B = CONFIG.versus.bot;
const savedMode = B.brain;
B.brain = 'scripted';
CONFIG.celebrate.enabled = false;

// ---------------------------------------------------------------------------
section('The bot takes player 2 when nobody has the pad');
{
  check("'auto' means: the bot when no pad is on P2", botWanted(false) === true && botWanted(true) === false);
  startVersus(scene);
  // A match opens on a kickoff (the count, everyone held): ride it out, so
  // the bot below is judged on live play.
  toPlay();
  // Park player 1 in its own goal mouth, out of the way and not a target.
  player.mesh.position.set(bounds.left + 8, midWater() + 12, 0);
  player.velocity.set(0, 0);
  strikeState.active = false;
  run(0.5);
  check('the bot is driving', botState.driving && botState.mode === 'scripted', `mode ${botState.mode}`);
  check('it pushes the stick', p2.input.move.lengthSq() > 0.01, `move=(${p2.input.move.x.toFixed(2)},${p2.input.move.y.toFixed(2)})`);
  check('it aims at the ball', (p2.input.aim.x * (ball.x - p2.pos.x) + p2.input.aim.y * (ball.y - p2.pos.y)) > 0);
  check('the seal moved', p2.vel.length() > 1, `speed ${p2.vel.length().toFixed(1)}`);
}

// ---------------------------------------------------------------------------
section('It scores against a seal that does nothing');
{
  let t = 0;
  let strikes = 0;
  let prevCooldown = 0;
  while (versusState.scores[1] < 1 && t < 120) {
    frame();
    t += dt;
    // A release arms the cooldown; the dash itself can be over in the same
    // frame now that a ball this heavy throws the striker off it.
    if (botState.cooldown > prevCooldown) strikes++;
    prevCooldown = botState.cooldown;
    // Keep player 1 parked: updatePlayer is not running here, but the ball
    // can still shove nothing — only the position matters to the bot.
  }
  check('the bot put the ball in the left goal', versusState.scores[1] >= 1, `after ${t.toFixed(1)}s, ${strikes} strikes, ${versusState.scores.join('–')}`);
  check('...with strikes, not by swimming it in', strikes >= 1);
  check('and never into its own', versusState.scores[0] === 0);
}

// ---------------------------------------------------------------------------
section('It eats when the meter runs dry');
{
  // Ride the shutter and the kickoff after it out first, so play is live again.
  toPlay();
  resetPickups(scene);
  resetBall();
  ball.x = bounds.left + 20; // the ball is far away, the food is close
  p2.pos.set(20, midWater(), 0);
  p2.vel.set(0, 0);
  p2.charge = 0;
  p2.pending = 0;
  spawnXpOrb(scene, { x: 28, y: midWater() - 2, z: 0 }, 1, 0.5);
  spawnXpOrb(scene, { x: 29, y: midWater() + 1, z: 0 }, 1, 0.5);
  let t = 0;
  let sawEat = false;
  while (p2.charge <= 0 && t < 8) { frame(); t += dt; if (botState.intent === 'eat') sawEat = true; }
  check('the bot went for the chum', sawEat);
  check('...and ate it', p2.charge > 0, `charge ${p2.charge.toFixed(2)} after ${t.toFixed(1)}s`);
}

// ---------------------------------------------------------------------------
section('Rows are filed while a human plays, on the logger\'s clock');
{
  resetImitation();
  imitationState.total = 0;
  resetBall();
  versusState.phase = 'play';
  const pushing = { move: new THREE.Vector2(1, 0), aim: new THREE.Vector2(1, 0), strikeHeld: true, strikeRelease: false };
  run(2, pushing);
  check('about twenty rows a second for player 1', imitationState.total >= 35 && imitationState.total <= 45, `${imitationState.total} in 2s`);
  const row = imitationState.rows[imitationState.rows.length - 1];
  check('a row is features then actions', row.length === N_FEATURES + N_ACTIONS, `${row.length}`);
  check('...and player 1\'s stick and strike are in it', row[N_FEATURES] === 1 && row[N_FEATURES + 4] === 1, `moveX=${row[N_FEATURES]} strike=${row[N_FEATURES + 4]}`);
  check('nothing is filed for the bot', imitationState.side.every((s) => s === 0));
  const before = imitationState.total;
  versusState.phase = 'scored';
  versusState.phaseT = 0;
  versusState.respawned = true;
  versusState.flown = true;
  run(1, pushing);
  check('and nothing during the goal\'s shutter', imitationState.total === before);
  versusState.phase = 'play';
  resetImitation();
}

// ---------------------------------------------------------------------------
section('The mirror: a row from the right-hand seal reads like one from the left');
{
  const pitch = { left: -50, right: 50, bottom: -40, surface: 0 };
  const me = { x: 30, y: -20, vx: 10, vy: 3 };
  const opp = { x: -30, y: -20, vx: -5, vy: 0 };
  const b = { x: 0, y: -20, vx: 20, vy: 0, spin: 4 };
  const meter = { charge: 0.7, pending: 0, dashing: false };
  const left = features({ ...me, x: -30, vx: -10 }, { ...opp, x: 30, vx: 5 }, { ...b, vx: -20, spin: -4 }, meter, false, pitch);
  const right = features(me, opp, b, meter, true, pitch);
  let same = true;
  for (let i = 0; i < N_FEATURES; i++) if (Math.abs(left[i] - right[i]) > 1e-6) same = false;
  check('the mirrored right-hand view equals the left-hand one', same, `${Array.from(right).map((v) => v.toFixed(2)).join(' ')}`);
  const a = actions({ move: { x: -1, y: 0.5 }, aim: { x: -1, y: 0 }, strikeHeld: true }, true);
  check('and the stick flips with it', a[0] === 1 && a[1] === 0.5 && a[2] === 1 && a[4] === 1);
}

// ---------------------------------------------------------------------------
section('The script plays, the trainer learns it, the policy plays it back');
{
  // Log the SCRIPT as if it were a human on player 2's pad: sixty seconds of
  // play against a parked player 1, ball reset whenever a goal goes in.
  resetImitation();
  const rows = [];
  const pitch = { left: bounds.left, right: bounds.right, bottom: bounds.bottom, surface: bounds.surfaceY };
  const feat = new Float32Array(N_FEATURES);
  const act = new Float32Array(N_ACTIONS);
  player.mesh.position.set(bounds.left + 8, midWater() + 12, 0);
  resetBall();
  versusState.phase = 'play';
  versusState.scores[0] = versusState.scores[1] = 0;
  let clock = 0;
  for (let t = 0; t < 90; t += dt) {
    frame();
    if (versusState.phase !== 'play') { toPlay(); resetBall(); versusState.phase = 'play'; versusState.scores[1] = 0; continue; }
    clock += dt;
    if (clock >= 1 / 20) {
      clock -= 1 / 20;
      features({ x: p2.pos.x, y: p2.pos.y, vx: p2.vel.x, vy: p2.vel.y },
        { x: player.mesh.position.x, y: player.mesh.position.y, vx: 0, vy: 0 }, ball,
        { charge: p2.charge, pending: p2.pending, dashing: p2.active }, true, pitch, 64, 34, feat);
      actions(p2.input, true, act);
      rows.push([...Array.from(feat), ...Array.from(act)]);
    }
  }
  const held = rows.filter((r) => r[N_FEATURES + 4] > 0.5).length;
  check('ninety seconds of the script gives a training set', rows.length > 1000, `${rows.length} rows, ${held} with the strike held`);

  const { model, report } = train(rows, { epochs: 30, hidden: 24, seed: 3 });
  check('the policy is in the game\'s shape', policyUsable(model), `${model.layers.length} layers`);
  check('held-out stick agreement is high', report.stickAgreement > 0.7, `cos ${report.stickAgreement.toFixed(3)} on ${report.holdRows} rows`);
  check('held-out strike accuracy is high', report.strikeAccuracy > 0.9, `${(report.strikeAccuracy * 100).toFixed(1)}%`);
  check('...and the floors agree', clearsFloors(report));
  const untrained = evaluate({ trained: true, inputs: N_FEATURES, layers: model.layers.map((L) => ({ ...L, w: L.w.map(() => 0), b: L.b.map(() => 0) })) }, rows.slice(0, 200));
  check('a zero policy would not have cleared them', !clearsFloors(untrained), `cos ${untrained.stickAgreement.toFixed(2)}`);

  // Now the policy drives player 2.
  setBotPolicy(model);
  B.brain = 'policy';
  resetBall();
  versusState.phase = 'play';
  p2.pos.set(bounds.right - 12, midWater() - 10, 0);
  p2.vel.set(0, 0);
  p2.charge = 1;
  const d0 = Math.hypot(ball.x - p2.pos.x, ball.y - p2.pos.y);
  run(0.1);
  check('the bot is on the policy', botState.mode === 'policy', botState.mode);
  let closest = d0;
  let moved = 0;
  for (let t = 0; t < 4; t += dt) {
    frame();
    const d = Math.hypot(ball.x - p2.pos.x, ball.y - p2.pos.y);
    closest = Math.min(closest, d);
    moved = Math.max(moved, p2.vel.length());
  }
  check('the learned seal swims', moved > 5, `top speed ${moved.toFixed(1)}`);
  check('...toward the ball, like the script it watched', closest < d0 * 0.6, `${d0.toFixed(1)} → ${closest.toFixed(1)}`);
  B.brain = savedMode;
  setBotPolicy(botPolicy());
}

// ---------------------------------------------------------------------------
section('A masked input is invisible to the policy, in the game and in the trainer alike');
{
  // The trainer zeroes the masked columns in the data and writes their names
  // into the model; policyAction zeroes the same ones before the forward
  // pass. If either side forgot, the network would be answering a `pending`
  // it was never trained on, or trained on one it never sees.
  // Four hundred made-up rows: what they say does not matter, only that a
  // model comes out with the mask written into it.
  let seed = 11;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  const fake = Array.from({ length: 400 }, () => Array.from({ length: N_FEATURES + N_ACTIONS }, (_, i) => (i === N_FEATURES + 4 ? (rnd() > 0 ? 1 : 0) : rnd())));
  const { model } = train(fake, { epochs: 2, hidden: 8, seed: 1, mask: ['pending', 'charge'] });
  check('the model carries its mask', JSON.stringify(model.mask) === JSON.stringify(['pending', 'charge']), JSON.stringify(model.mask));
  const a = new Float32Array(N_FEATURES).fill(0.3);
  const b = Float32Array.from(a);
  b[6] = 0.9; b[7] = 0.9; // charge, pending
  const ya = policyAction(model, a);
  const yb = policyAction(model, b);
  check('changing a masked input changes nothing', Math.abs(ya.moveX - yb.moveX) < 1e-7 && Math.abs(ya.strike - yb.strike) < 1e-7);
  b[0] = -0.3;
  const yc = policyAction(model, b);
  check('...while an unmasked one still does', Math.abs(ya.moveX - yc.moveX) > 1e-4);
}

// ---------------------------------------------------------------------------
section('The SHIPPED policy plays: it swims, it strikes, it scores');
// The held-out score cannot see a policy that has learned to sit still —
// the first one trained on real rows scored 96.8% on it and then never left
// the kickoff line, because every leak in MASK makes the row after a held
// row easy. So the file the game ships is driven here, for three minutes
// against a parked seal, and has to do the three things a player does.
// Skipped, not failed, when nothing has been trained: the script plays then.
{
  const shipped = botPolicy();
  if (!policyUsable(shipped)) {
    console.log('  (no trained policy in versusPolicy.json — the script plays; nothing to measure)');
  } else {
    B.brain = 'policy';
    resetVersus(); resetPlayer(); startVersus(scene);
    let t = 0; let play = 0; let starts = 0; let prevHeld = false; let goals = 0; let own = 0; let top = 0;
    const seconds = 180;
    while (t < seconds) {
      frame(); t += dt;
      if (versusState.phase === 'over') { goals += versusState.scores[1]; own += versusState.scores[0]; rematch(); }
      if (versusState.phase !== 'play') continue;
      play += dt;
      top = Math.max(top, p2.vel.length());
      if (p2.input.strikeHeld && !prevHeld) starts++;
      prevHeld = p2.input.strikeHeld;
    }
    goals += versusState.scores[1]; own += versusState.scores[0];
    check('it is on the policy', botState.mode === 'policy', botState.mode);
    check('the learned seal swims at speed', top > 10, `top ${top.toFixed(1)}`);
    check('it strikes, as the player it watched does', starts >= 5, `${starts} hold starts in ${play.toFixed(0)}s of play`);
    check('it scores against a seal that does nothing', goals >= 1, `${goals} goals, ${own} own goals`);
    check('...and not into its own goal more than the other', own <= goals, `${own} own vs ${goals}`);
    B.brain = savedMode;
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
