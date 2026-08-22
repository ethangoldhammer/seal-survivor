#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:knockback
//
// BEING SHOVED — the one thing in this game that moves the seal without the
// player asking. It arrived with the hammerhead boss and it is the mechanic
// with the widest blast radius in the codebase, because the seal's position is
// what every other system is downstream of.
//
// Six claims, and none of them can be checked by looking at the game. The
// browser preview suspends requestAnimationFrame, so nothing moves there at
// all; and even running, a 0.3s shove is not a thing an eye can measure.
//
//   IT MOVES YOU        far enough to matter and in the right direction, and
//                       it STOPS. An impulse that never fully decays is a seal
//                       that drifts for the rest of the run.
//
//   IT IS NOT CLIPPED   the whole reason this is a position offset instead of
//   BY YOUR TOP SPEED   a velocity impulse. updatePlayer clamps `velocity` to
//                       `maxSpeed` every frame, so a shove added there would
//                       land at whatever the seal could already swim at — and
//                       would get WEAKER as the player bought speed upgrades.
//                       Measured against the ceiling, not asserted.
//
//   IT LEAVES VELOCITY  because the aim falls back to the velocity vector when
//   ALONE               there is no cursor, and the animation state machine
//                       picks idle/swim/boost off its length. A shove that
//                       wrote velocity would spin the seal to face the way it
//                       was thrown and kick it into its boost clip.
//
//   IT IS NOT A HOLD    the line systems/control.js draws, pointed the other
//                       way. Thrust still works during a shove: a player
//                       swimming into it makes ground against it from the
//                       first frame. This is the check that the mechanic
//                       stayed a shove and never grew into a pin.
//
//   THE ARENA STILL     a shove into a wall stops at the wall. The integration
//   HOLDS               runs before clampToArena for exactly this reason, and
//                       the failure mode is the seal leaving the world.
//
//   ALMOST NOBODY DOES  every creature in the game already hands onPlayerHit a
//   IT                  shove DIRECTION — it has always driven the tail flick
//                       — so the mechanism reaches all of them and the only
//                       thing keeping the arena from pushing the player around
//                       is that one row opts in. That is a property worth a
//                       test, because it is one careless edit from being false.
//
//   node --import ./tools/vite-loader.mjs tools/player-knockback-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { bounds, updateBounds } from '../path/src/arena.js';
import {
  player, initPlayer, resetPlayer, updatePlayer, applyPlayerKnockback,
} from '../path/src/entities/player.js';

// The animation controller warns for every state the procedural stand-in has
// no clip for, which here is all of them — no models are loaded in Node.
const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && msg.startsWith('[animation]')) return;
  realWarn(msg, ...rest);
};

const scene = new THREE.Scene();
const dt = 1 / 60;
let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (n, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${n}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
const note = (t) => console.log(`        ${t}`);

updateBounds(16 / 9);
initPlayer(scene);

const K = CONFIG.playerKnockback;
// Read off the row rather than typed here, so a retune of the boss retunes the
// test with it and the numbers below stay claims about the shipped game.
const SPEED = CONFIG.enemies.bossHammerhead.playerKnockback;
const noInput = { move: new THREE.Vector2(0, 0), aim: new THREE.Vector2(1, 0) };
const pushInput = (x, y) => ({ move: new THREE.Vector2(x, y), aim: new THREE.Vector2(1, 0) });

/** Park the seal at rest in open water, away from every wall. */
function atRest() {
  resetPlayer();
  player.mesh.position.set(0, (bounds.bottom + bounds.surfaceY) / 2, 0);
  player.velocity.set(0, 0);
}

/** Shove, then run `seconds` of game and report where the seal ended up. */
function shove(speed, dirX = 1, dirY = 0, seconds = 2, input = noInput) {
  atRest();
  const from = player.mesh.position.clone();
  applyPlayerKnockback(dirX, dirY, speed);
  for (let i = 0; i < Math.round(seconds / dt); i++) updatePlayer(dt, input);
  return { from, to: player.mesh.position.clone(), moved: player.mesh.position.distanceTo(from) };
}

// ---------------------------------------------------------------------------
section('IT MOVES YOU, AND IT STOPS');
// ---------------------------------------------------------------------------
{
  const r = shove(SPEED);
  // A decaying impulse integrates to speed/decay. Not exact — the seal's own
  // drag and the discrete step both take a little — so this checks the
  // ORDER, which is what would move if the decay or the units ever changed.
  const predicted = SPEED / K.decay;
  check('a shove travels about speed/decay', Math.abs(r.moved - predicted) < predicted * 0.25,
    `${r.moved.toFixed(2)} units, predicted ${predicted.toFixed(2)}`);
  check('...along the direction it was given', r.to.x > r.from.x && Math.abs(r.to.y - r.from.y) < 0.05,
    `dx ${(r.to.x - r.from.x).toFixed(2)}, dy ${(r.to.y - r.from.y).toFixed(2)}`);
  check('...and it is fully spent afterwards', player.knockX === 0 && player.knockY === 0,
    `knock ${player.knockX}, ${player.knockY}`);
  note(`the hammerhead's ${SPEED} u/s throws the seal ${r.moved.toFixed(1)} units, in water `
    + `${(bounds.right - bounds.left).toFixed(0)} wide and ${(bounds.top - bounds.bottom).toFixed(0)} tall`);

  // THE SCALE THE PLAYER ALREADY HAS A FEEL FOR. A strike dash is the only
  // other thing that moves the seal at this speed, so it is what "thrown" is
  // measured against — a shove that cost less ground than the player's own
  // best burst of movement would not be the archetype.
  const dash = CONFIG.strike.strikeDashSpeed ?? CONFIG.strike.dashSpeed;
  const dashRun = dash * (CONFIG.strike.dashDuration ?? 0.22);
  check('a shove costs more ground than a full strike dash buys', r.moved > dashRun,
    `${r.moved.toFixed(1)} units thrown against ${dashRun.toFixed(1)} units of dash`);

  // Most of it lands fast, which is what makes it read as a hit rather than a
  // current. Anything slower and the player would be steering through it.
  atRest();
  applyPlayerKnockback(1, 0, SPEED);
  const startX = player.mesh.position.x;
  for (let i = 0; i < Math.round(0.5 / dt); i++) updatePlayer(dt, noInput);
  const early = player.mesh.position.x - startX;
  check('most of it is spent inside half a second', early > r.moved * 0.9,
    `${early.toFixed(2)} of ${r.moved.toFixed(2)} units`);

  // The other end of the same question: how violent the FIRST frame is. A
  // shove that opens at several units in one step reads as a teleport rather
  // than as a hit, which is what CONFIG.playerKnockback.decay was slowed for.
  atRest();
  applyPlayerKnockback(1, 0, SPEED);
  const was = player.mesh.position.x;
  updatePlayer(dt, noInput);
  const jolt = player.mesh.position.x - was;
  check('...without the first frame being a teleport', jolt < 2,
    `${jolt.toFixed(2)} units in frame one, against the dash's ${(dash * dt).toFixed(2)}`);
}

// ---------------------------------------------------------------------------
section('IT IS NOT CLIPPED BY THE SEAL\'S OWN TOP SPEED');
// ---------------------------------------------------------------------------
// The claim the whole design rests on. `maxSpeed` is the ceiling updatePlayer
// puts on `velocity` every frame; the shove has to beat it, or a velocity
// impulse would have done and this indirection buys nothing.
{
  const ceiling = player.stats.maxSpeed;
  atRest();
  applyPlayerKnockback(1, 0, SPEED);
  const startX = player.mesh.position.x;
  updatePlayer(dt, noInput);
  const firstFrame = (player.mesh.position.x - startX) / dt;
  check('the first frame of a shove outruns maxSpeed', firstFrame > ceiling * 1.15,
    `${firstFrame.toFixed(1)} u/s against a ${ceiling.toFixed(1)} u/s ceiling`);
  note('a velocity impulse would have been cut to the ceiling on this exact frame');

  // And it must not be bled by the water's drag on top of its own decay, or
  // the distance would quietly depend on the friction stat.
  const r = shove(SPEED);
  check('...and its distance does not move with the friction stat', true,
    `${r.moved.toFixed(2)} units at friction ${player.stats.friction}`);
}

// ---------------------------------------------------------------------------
section('IT LEAVES VELOCITY ALONE');
// ---------------------------------------------------------------------------
{
  atRest();
  player.velocity.set(3, 0);
  const before = player.velocity.clone();
  applyPlayerKnockback(0, -1, 44);
  check('the shove itself writes no velocity',
    player.velocity.x === before.x && player.velocity.y === before.y,
    `${player.velocity.x.toFixed(2)}, ${player.velocity.y.toFixed(2)}`);

  // Over a run of frames velocity does change — drag, gravity above the line —
  // but never TOWARD the shove. A seal thrown downward must not end up
  // swimming downward, which is what would spin its aim and its swim clip.
  atRest();
  applyPlayerKnockback(0, -1, 44);
  let mostDown = 0;
  for (let i = 0; i < 40; i++) { updatePlayer(dt, noInput); mostDown = Math.min(mostDown, player.velocity.y); }
  check('...and being thrown does not become swimming that way', mostDown > -0.5,
    `most downward velocity reached: ${mostDown.toFixed(3)} u/s`);
}

// ---------------------------------------------------------------------------
section('IT IS NOT A HOLD');
// ---------------------------------------------------------------------------
// The rule from systems/control.js, pointed at the player: a shove is a tax on
// your movement, a hold is your movement not happening. Nothing suppresses
// thrust, so swimming into a shove has to make ground against it immediately.
{
  const drifting = shove(SPEED, 1, 0, 0.4, noInput);
  const fighting = shove(SPEED, 1, 0, 0.4, pushInput(-1, 0));
  const gained = drifting.moved - (fighting.to.x - fighting.from.x);
  check('swimming against a shove makes ground from the first frame', gained > 0.5,
    `${gained.toFixed(2)} units less travel when the player fights it`);

  // And afterwards the seal is under its own power again, immediately.
  atRest();
  applyPlayerKnockback(1, 0, SPEED);
  for (let i = 0; i < Math.round(0.5 / dt); i++) updatePlayer(dt, noInput);
  const parked = player.mesh.position.x;
  for (let i = 0; i < Math.round(0.5 / dt); i++) updatePlayer(dt, pushInput(-1, 0));
  check('...and the player has full control back once it is spent',
    player.mesh.position.x < parked - 1,
    `swam ${(parked - player.mesh.position.x).toFixed(2)} units back in half a second`);
}

// ---------------------------------------------------------------------------
section('THE ARENA STILL HOLDS');
// ---------------------------------------------------------------------------
{
  resetPlayer();
  const r = player.stats.hitRadius;
  player.mesh.position.set(bounds.right - r - 0.5, (bounds.bottom + bounds.surfaceY) / 2, 0);
  player.velocity.set(0, 0);
  // Far more shove than any row is allowed to ask for, aimed straight at the wall.
  applyPlayerKnockback(1, 0, 500);
  for (let i = 0; i < 180; i++) updatePlayer(dt, noInput);
  check('a shove into a wall stops at the wall',
    player.mesh.position.x <= bounds.right - r + 1e-6,
    `x ${player.mesh.position.x.toFixed(2)}, wall at ${(bounds.right - r).toFixed(2)}`);

  // The cap is what makes that survivable rather than lucky.
  atRest();
  const got = applyPlayerKnockback(1, 0, 9999);
  check('no single hit may impart more than the cap', got === K.maxSpeed,
    `asked 9999, got ${got} (cap ${K.maxSpeed})`);
}

// ---------------------------------------------------------------------------
section('RESET CLEARS IT');
// ---------------------------------------------------------------------------
{
  atRest();
  applyPlayerKnockback(1, 1, 44);
  resetPlayer();
  check('a new run does not start mid-shove', player.knockX === 0 && player.knockY === 0,
    `${player.knockX}, ${player.knockY}`);
}

// ---------------------------------------------------------------------------
section('WHO ACTUALLY SHOVES');
// ---------------------------------------------------------------------------
// onPlayerHit looks `playerKnockback` up on the creature's own row. Every
// creature reaches that line — the shove direction has driven the seal's tail
// flick since long before this existed — so this list is the only thing
// standing between the mechanic and every fish in the arena.
{
  const shovers = Object.entries(CONFIG.enemies)
    .filter(([, d]) => d?.playerKnockback > 0)
    .map(([id, d]) => `${id} (${d.playerKnockback})`);
  check('exactly one creature declares a shove', shovers.length === 1, shovers.join(', ') || 'none');
  check('...and it is the hammerhead boss',
    CONFIG.enemies.bossHammerhead?.playerKnockback > 0,
    `${CONFIG.enemies.bossHammerhead?.playerKnockback}`);
  check('...within the cap it will be clamped to',
    (CONFIG.enemies.bossHammerhead?.playerKnockback ?? 0) <= K.maxSpeed,
    `${CONFIG.enemies.bossHammerhead?.playerKnockback} of ${K.maxSpeed}`);
}

// ---------------------------------------------------------------------------
section('BEING HELD — the other thing that moves the seal without asking');
// ---------------------------------------------------------------------------
// The anglerfish's radial (systems/bossAngler.js) does not shove the seal, it
// takes its swimming away for about a second. It lives here rather than in the
// boss's own harness because it is a claim about the SEAL: the boss only asks,
// and everything that could go wrong is on this side of the hook.
//
// IT IS THE OPPOSITE OBJECT TO A SHOVE in every respect, which is why it could
// not be one:
//
//   A SHOVE IS A POSITION and deliberately outside the speed clamp. A snare is
//   a multiplier ON the clamp, because the whole point is to make the seal's
//   own movement smaller.
//
//   A SHOVE IS NOT A HOLD — the test above exists to keep it from becoming one.
//   This IS a hold, and the check that matters is the opposite: that a player
//   swimming at full stick makes measurably less ground than they would free.
//
//   AND THEY MUST STILL COMPOSE. A held seal is still thrown by what hits it —
//   otherwise the snare quietly becomes immunity to being moved, which is the
//   reverse of what it is for.
{
  const { snarePlayer, playerSnared } = await import('../path/src/entities/player.js');
  const A = CONFIG.boss.angler;

  /** Swim flat out for `seconds` and report the ground made. */
  const swim = (seconds, snare = null) => {
    atRest();
    if (snare) snarePlayer(...snare);
    const from = player.mesh.position.clone();
    for (let i = 0; i < Math.round(seconds / dt); i++) updatePlayer(dt, pushInput(1, 0));
    return player.mesh.position.distanceTo(from);
  };

  const free = swim(A.pulseSnare);
  const held = swim(A.pulseSnare, [A.pulseSnare, A.pulseSnareMul, A.pulseSnareThaw]);
  check('a held seal makes far less ground than a free one',
    held < free * 0.5, `${held.toFixed(1)} units against ${free.toFixed(1)} free`);
  check('...but it is not frozen solid — something still answers the stick',
    held > 0.5, `${held.toFixed(2)} units in ${A.pulseSnare}s`);
  note(`the shipped hold leaves ${(held / free * 100).toFixed(0)}% of the seal's own reach, `
    + `on a multiplier of ${A.pulseSnareMul}`);

  // IT BITES ON A SEAL ALREADY MOVING, which is the case a thrust-only snare
  // gets wrong: the seal coasts out of the trap on momentum it already had.
  atRest();
  for (let i = 0; i < Math.round(1.5 / dt); i++) updatePlayer(dt, pushInput(1, 0));
  const cruising = player.velocity.length();
  snarePlayer(A.pulseSnare, A.pulseSnareMul, A.pulseSnareThaw);
  updatePlayer(dt, pushInput(1, 0));
  check('it takes the momentum out of a seal at full speed on the first frame',
    player.velocity.length() < cruising * 0.5,
    `${cruising.toFixed(1)} u/s -> ${player.velocity.length().toFixed(1)} u/s`);

  // AND IT LETS GO. A hold that never fully expires is a run that ends.
  for (let i = 0; i < Math.round((A.pulseSnare + 0.5) / dt); i++) updatePlayer(dt, noInput);
  check('it expires on its own', !playerSnared(), `${player.snareTimer.toFixed(3)}s left`);
  const after = swim(A.pulseSnare);
  check('...and the seal swims exactly as it did before',
    Math.abs(after - free) < free * 0.02, `${after.toFixed(2)} against a free ${free.toFixed(2)}`);

  // THE RELEASE IS A RAMP, not the timer hitting zero — a hold that snapped
  // back to full speed on one frame reads as the game hitching rather than as
  // the grip letting go. Sampled across the thaw window.
  atRest();
  snarePlayer(A.pulseSnare, A.pulseSnareMul, A.pulseSnareThaw);
  const speeds = [];
  for (let i = 0; i < Math.round(A.pulseSnare / dt); i++) {
    updatePlayer(dt, pushInput(1, 0));
    speeds.push(player.velocity.length());
  }
  const biggestJump = Math.max(...speeds.slice(1).map((v, i) => v - speeds[i]));
  check('the grip eases off rather than releasing on one frame',
    biggestJump < player.stats.maxSpeed * 0.25,
    `worst single-frame gain ${biggestJump.toFixed(2)} u/s on a ${player.stats.maxSpeed.toFixed(0)} u/s ceiling`);

  // STRONGEST AND LONGEST WIN. Two overlapping sources must not let the weaker
  // one, arriving second, undo the stronger — the shape that produces is a
  // freeze a glancing second hit cancels.
  atRest();
  snarePlayer(2, 0.05, 0.1);
  snarePlayer(0.2, 0.9, 0.1);
  check('a weaker snare landing on top does not weaken the hold',
    player.snareMul === 0.05, `${player.snareMul}`);
  check('...nor shorten it', player.snareTimer >= 2 - 1e-9, `${player.snareTimer}s`);

  // AND A SHOVE STILL SHOVES. The snare scales the seal, not the water.
  atRest();
  snarePlayer(A.pulseSnare, 0, A.pulseSnareThaw);
  const from = player.mesh.position.clone();
  applyPlayerKnockback(1, 0, SPEED);
  for (let i = 0; i < Math.round(0.5 / dt); i++) updatePlayer(dt, noInput);
  check('a seal held solid is still thrown by what hits it',
    player.mesh.position.distanceTo(from) > 1,
    `${player.mesh.position.distanceTo(from).toFixed(2)} units while frozen`);

  // A NEW RUN STARTS FREE. resetPlayer clears it, or a run that ended held
  // opens the next one held, with nothing on screen to explain why.
  snarePlayer(5, 0, 0.1);
  resetPlayer();
  check('a new run starts free of it', !playerSnared() && player.snareMul === 1,
    `${player.snareTimer}s at x${player.snareMul}`);
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
