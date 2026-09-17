#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:tenacity
//
// A BOSS DOES NOT ANSWER TO BEING SHOT AT — CONFIG.boss.tenacity, and the one
// exception to it, CONFIG.strike.weakSpot.stagger.
//
// WHAT THIS FILE IS GUARDING. The hit reaction in this game was written for
// wildlife and reached a boss by accident, through three channels that nobody
// authored as a boss rule:
//
//   the SKELETON   every damage source shoves the bone springs along its own
//                  travel (onEnemyDamagedFeedback in main.js), scaled by the
//                  damage. On a shark that IS the hit reaction. On a boss under
//                  a stream of pellets it is a body that never stops buckling.
//   the TWITCH     `hitThisFrame` pulses the head and tail bones for every
//                  landed shot (CONFIG.animation.hit).
//   the SHOVE      everything that calls applyKnockback moved it — a thrown
//                  club, a headstone, a release burst, a pickup blast — each one
//                  small, all of them constant.
//
// The cost was the fight rather than the picture: a flinching boss is a boss
// that is not lunging, so the answer to a wind-up was to shoot harder instead
// of to move. What replaces it is one rule with two named exceptions (the
// seal's own body and the animal's weak spot bursting) and exactly one thing
// that may STAGGER a boss — a perfect strike into a lit spot.
//
// WHY IT NEEDS A HARNESS. Every failure this can have is a quiet one:
//
//   - a new weapon ships, nobody names its source, and it either shoves a boss
//     (if the rule were an allow-list) or silently stops working. The rule is
//     deny-by-default precisely so the failure lands on the new thing rather
//     than on the boss, and that is asserted here.
//   - the tenacity gate is added in front of the SHOVE and forgotten in front
//     of the FLINCH, which leaves a boss that is not pushed around but still
//     visibly buckles under fire. Two channels, one number — checked.
//   - `committed` regresses and a stream of pellets bends a run again. Nothing
//     warns; the lunges simply start missing.
//   - the stagger's slow never reaches the water. `staggerTimer` ticks, the
//     numbers all look right, and the boss swims through it at full speed.
//     Measured against a control run rather than asserted off the field.
//
// None of it is visible by playing: the browser preview suspends
// requestAnimationFrame, and "did that run miss because I dodged or because I
// was shooting it" is not a question an eye can answer.
//
//   node --import ./tools/vite-loader.mjs tools/boss-tenacity-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../path/src/config.js';
import { updateBounds } from '../path/src/arena.js';
import {
  enemies, spawnNamed, resetEnemies, updateEnemies,
  applyKnockback, hitReactionMul, staggerBoss, isCommittedRun, isAttacking,
} from '../path/src/entities/enemies.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DT = 1 / 60;
const noop = () => {};

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const scene = new THREE.Scene();
updateBounds();

// A boss, or a plain creature of the same species, in an otherwise empty
// ocean — `isBoss` set after the spawn exactly as systems/boss.js does it.
function put(key, { boss = false, at = { x: 0, y: 0 } } = {}) {
  const e = spawnNamed(scene, key, 0, at, { ignoreCaps: true, overfill: true, boss });
  if (e && boss) e.isBoss = true;
  return e;
}
const fresh = () => resetEnemies(scene);

// How far one shove moved a body, read off the knock the integrator will spend
// rather than off a position — the position is also being written by the
// animal's own swimming, and a shove smaller than one stroke is invisible in it.
const knockOf = (e) => Math.hypot(e.knockX ?? 0, e.knockY ?? 0);
function shove(e, opts = null) {
  e.knockX = 0;
  e.knockY = 0;
  applyKnockback(e, 1, 0, 1, opts);
  return knockOf(e);
}

const TEN = CONFIG.boss.tenacity;
const WS = CONFIG.strike.weakSpot.stagger;

// ===========================================================================
section('THE RULE — what an ordinary hit may do to a boss');
// ===========================================================================
{
  fresh();
  const boss = put('bossShark', { boss: true });
  const wild = put('bossShark', { at: { x: 30, y: 0 } });

  check('the block is on', TEN.enabled !== false && TEN.flinch === 0 && TEN.shove === 0,
    `flinch ${TEN.flinch}, shove ${TEN.shove}`);

  // THE SHOVE. An unnamed source is everything that is not the ram or the
  // rupture: the thrown club, the headstone, the release burst, the pickup
  // blast, a versus hit.
  const anon = shove(boss);
  check('an unnamed shove does nothing to a boss', anon === 0, `${anon.toFixed(3)} u/s`);

  // ...AND THE SAME CALL STILL MOVES THE WILDLIFE. The identical body, spawned
  // through the ordinary door — so this is the boss rule and not a knockback
  // that quietly stopped working for everybody.
  const onWild = shove(wild);
  check('...and the identical body that is NOT a boss is shoved as it always was',
    onWild > 0, `${onWild.toFixed(2)} u/s on the wildlife megalodon`);

  // THE TWO THAT ARE ALLOWED.
  const ram = shove(boss, { source: 'ram' });
  check('the seal\'s own body still moves it', ram > 0, `${ram.toFixed(2)} u/s`);
  const burst = shove(boss, { source: 'rupture', gain: 1.6 });
  check('...and so does its own weak spot bursting', burst > 0, `${burst.toFixed(2)} u/s`);

  // DENY BY DEFAULT. The rule has to fail onto the NEW thing: a weapon that
  // ships without naming itself is refused, rather than an allow-list quietly
  // growing a hole the day somebody forgets to add a line to it.
  const madeUp = shove(boss, { source: 'harpoonThatDoesNotExistYet' });
  check('a source the rule has never heard of is refused, not waved through',
    madeUp === 0, `${madeUp.toFixed(3)} u/s`);
}

// ===========================================================================
section('THE FLINCH — both channels, one number');
// ===========================================================================
{
  fresh();
  const boss = put('bossShark', { boss: true });
  const fish = put('fish', { at: { x: 20, y: 0 } });

  check('a fish takes the whole hit reaction', hitReactionMul(fish) === 1);
  check('...and a boss takes none of it', hitReactionMul(boss) === 0);

  // NOT A BOOLEAN. "A pellet is a shiver on three tonnes of animal" is a real
  // picture someone may want, and the dial has to be able to express it.
  const shipped = TEN.flinch;
  TEN.flinch = 0.15;
  check('...but the dial is a fraction and not a switch', hitReactionMul(boss) === 0.15,
    `at flinch 0.15 a boss takes ${hitReactionMul(boss)} of it`);
  TEN.flinch = shipped;

  // OFF PUTS IT BACK. The honest comparison — a boss on the wildlife contract,
  // flinching and shoved exactly as it did before this block existed.
  TEN.enabled = false;
  const back = shove(boss);
  check('switching the block off puts a boss back on the wildlife contract',
    hitReactionMul(boss) === 1 && back > 0, `flinch x1, shove ${back.toFixed(2)} u/s`);
  TEN.enabled = true;
}

// ===========================================================================
section('COMMITTED MEANS COMMITTED');
// ===========================================================================
// The half the player feels. A run is the moment a boss is most shot at — it is
// coming straight at you — and the moment a nudge is worth the most, because a
// body already travelling at several times its cruise carries one a long way
// off its line.
{
  fresh();
  const boss = put('bossShark', { boss: true });

  boss.lungeStage = 'strike';
  check('mid-run it takes nothing, even from the ram',
    shove(boss, { source: 'ram' }) === 0 && hitReactionMul(boss) === 0);
  boss.lungeStage = 'rest';
  check('...and out of the run it answers to the ram again',
    shove(boss, { source: 'ram' }) > 0);

  boss.perkDrive = true;
  check('a perk driving the body is the same rule',
    shove(boss, { source: 'rupture' }) === 0 && hitReactionMul(boss) === 0);
  boss.perkDrive = false;

  // ALL FIVE WAYS A BOSS COMMITS, not just the one the shark uses. Four of the
  // ten archetypes carry the shared lunge; the kraken, the anglerfish and the
  // lunge perk raise `ramming` instead, and a rule that only knew about
  // `lungeStage` would leave the other three interruptible with nothing to say
  // so — their runs would simply start missing.
  boss.ramming = true;
  check('...and so is the `ramming` flag the kraken, the angler and the perk raise',
    isCommittedRun(boss) && shove(boss, { source: 'ram' }) === 0 && hitReactionMul(boss) === 0);
  boss.ramming = false;
  check('a boss doing neither is not committed', !isCommittedRun(boss));

  // ONE REACH, ASKED TWICE. systems/dodge.js pays the player for a committed
  // run that ended in empty water and this refuses to let one be nudged off
  // its line — the same moment, and a second copy of the test is one retune
  // away from the payout and the rule disagreeing about what a run is.
  const dodgeSrc = readFileSync(resolve(HERE, '../path/src/systems/dodge.js'), 'utf8');
  check('...and the dodge payout reads the same predicate rather than its own copy',
    /return isCommittedRun\(e\);/.test(dodgeSrc)
      && !/e\.ramming === true \|\| e\.lungeStage/.test(dodgeSrc));

  // The dial, so the old behaviour is reachable and the flag is doing the work
  // rather than something else in the chain.
  TEN.committed = false;
  boss.lungeStage = 'strike';
  check('...and the flag is what does it', shove(boss, { source: 'ram' }) > 0);
  TEN.committed = true;
  boss.lungeStage = 'rest';
}

// ===========================================================================
section('MID-ATTACK IS WIDER THAN MID-RUN — and it is every boss');
// ===========================================================================
// `isCommittedRun` answers where the body ENDS UP and is right for that: a run
// already crossing the water you were standing in cannot be nudged out of it
// without deleting the dodge. It is the wrong question for the FLINCH, and
// that is the bug this section exists to hold shut — the first pass at the
// rule used it for both, so a boss was still being whipped through the
// half-second wind-up that is its entire tell. On the hammerhead that
// half-second is the skull coming round to face you, and it is the only
// warning the shove ever gives.
//
// EVERY MOVE A BOSS HAS, because "a boss" is five different animals: the
// lunge's own stages, the `ramming` flag, the grab, the crab's pinch and a
// perk driving the body. A body whose attack is a CLIP resolves this in
// trigger() (ATTACK_STATES in systems/animation.js). These are the ones whose
// attack is a state on the creature instead, and they had no way to say so.
{
  fresh();
  const boss = put('bossShark', { boss: true });
  const clear = () => {
    boss.lungeStage = null;
    boss.ramming = false;
    boss.grabbing = false;
    boss.perkDrive = false;
    boss.claw = null;
  };

  const moves = {
    'a wind-up': () => { boss.lungeStage = 'wind'; },
    'the run itself': () => { boss.lungeStage = 'strike'; },
    'the re-aim inside a double': () => { boss.lungeStage = 'reaim'; },
    'a ram — the perk, the kraken, the angler, the crab': () => { boss.ramming = true; },
    'a grab': () => { boss.grabbing = true; },
    'the crab\'s pinch': () => { boss.claw = { isStriking: () => true }; },
    'a perk driving the body': () => { boss.perkDrive = true; },
  };
  for (const [what, arm] of Object.entries(moves)) {
    clear();
    arm();
    check(`${what} counts as attacking`, isAttacking(boss) === true);
  }

  // ...AND THE THINGS THAT ARE NOT AN ATTACK still are not. A rule that
  // caught the cruise would be a boss that never flinches at all, which
  // passes every check above and is a different bug wearing this one's
  // passing test.
  for (const [what, stage] of Object.entries({ 'doing nothing': null, resting: 'rest', cruising: 'cruise' })) {
    clear();
    boss.lungeStage = stage;
    check(`...and ${what} does not`, isAttacking(boss) === false);
  }

  // THE FLINCH ASKS THE WIDER QUESTION. Proved against a non-zero `flinch`
  // rather than against the shipped 0: at 0 this returns zero for every boss
  // in every state, so the check would pass with the gate deleted.
  {
    const was = TEN.flinch;
    TEN.flinch = 0.5;
    clear();
    boss.lungeStage = 'cruise';
    const cruising = hitReactionMul(boss);
    boss.lungeStage = 'wind';
    const winding = hitReactionMul(boss);
    TEN.flinch = was;
    check('the flinch is refused during the wind-up', winding === 0);
    check('...and allowed when the animal is only swimming', cruising === 0.5,
      `${cruising} of a configured 0.5`);
  }

  // ...AND THE SHOVE DOES NOT, DELIBERATELY. The two halves of a hit answer
  // two different questions and are refused on different terms — a ram may
  // still lean on a boss that is standing still winding up, because that is
  // the seal's own body arriving and the boss has not committed to anywhere
  // yet. What it may not do is whip the skeleton while it does.
  {
    const kicks = [];
    const realAnim = boss.anim;
    boss.anim = { impulse: (dir, strength) => kicks.push(strength) };
    clear();
    boss.lungeStage = 'wind';
    const moved = shove(boss, { source: 'ram' });
    check('a ram still moves a boss that is winding up', moved > 0, `${moved.toFixed(2)} u/s`);
    check('...but delivers it no flinch', kicks.length === 0, `${kicks.length} bone kicks`);

    kicks.length = 0;
    clear();
    boss.lungeStage = 'cruise';
    const cruising = shove(boss, { source: 'ram' });
    check('...and a cruising one takes both', cruising > 0 && kicks.length === 1,
      `${cruising.toFixed(2)} u/s and ${kicks.length} bone kick`);

    kicks.length = 0;
    clear();
    boss.lungeStage = 'strike';
    const running = shove(boss, { source: 'ram' });
    check('...and a committed one takes neither', running === 0 && kicks.length === 0);
    boss.anim = realAnim;
    clear();
  }

  // ONE REACH, ASKED FOUR TIMES. The same rule the dodge payout is held to
  // above: a fifth kind of boss attack has to be a line in `isAttacking` and
  // nothing else, and a channel that grew its own copy of the test is one
  // retune away from disagreeing with the other three about what an attack is.
  {
    const spots = readFileSync(resolve(HERE, '../path/src/systems/bossHotSpots.js'), 'utf8');
    check('the weak spot\'s jostle reads the shared predicate', /isAttacking\(e\)/.test(spots)
      && !/lungeStage === 'wind'/.test(spots));
  }
}

// ===========================================================================
section('THE ONE STAGGER — a perfect strike into a lit weak spot');
// ===========================================================================
{
  fresh();
  const boss = put('bossShark', { boss: true });
  boss.staggerTimer = 0;
  boss.staggerCool = 0;

  check('it lands', staggerBoss(boss) === true);
  check('...for the seconds it is authored at', Math.abs(boss.staggerTimer - WS.seconds) < 1e-9,
    `${boss.staggerTimer.toFixed(2)}s`);
  check('...at its own depth, not the heavy knock\'s',
    boss.staggerSlow === WS.slow
      && WS.slow !== (CONFIG.strike.knockback.heavy.staggerSlow ?? 0.85),
    `${boss.staggerSlow} against the heavy knock's ${CONFIG.strike.knockback.heavy.staggerSlow}`);

  // THE ANTI-LOCK GUARANTEE. A player who can perform this reliably still
  // cannot hold a boss still with it: the gap runs from the END of the stagger.
  check('a second one inside the window is refused', staggerBoss(boss) === false);
  check('...and the gap is measured from the end of the first',
    Math.abs(boss.staggerCool - (WS.seconds + WS.cooldown)) < 1e-9,
    `${boss.staggerCool.toFixed(2)}s of ${WS.seconds} + ${WS.cooldown}`);

  // IT BREAKS THE RUN. The whole point of the mechanic — the answer to a lunge
  // is a perfectly timed strike into the spot, and the run ends where the seal
  // hit it.
  fresh();
  const runner = put('bossShark', { boss: true });
  runner.lungeStage = 'strike';
  runner.lungeClock = 9;
  runner.lungePlan = [{ stage: 'strike', time: 9 }];
  staggerBoss(runner);
  check('it ends a run already under way', runner.lungeStage === 'rest' && runner.lungePlan === null,
    `stage ${runner.lungeStage}`);

  // ...BUT NOT A SCRIPTED ONE. A perk writes the body's position itself and
  // nothing here steers it, so breaking one would desync the perk rather than
  // stop the boss.
  fresh();
  const driven = put('bossShark', { boss: true });
  driven.perkDrive = true;
  driven.lungeStage = 'strike';
  staggerBoss(driven);
  check('...and leaves a perk-driven body alone', driven.lungeStage === 'strike');
  driven.perkDrive = false;
}

// ===========================================================================
section('...AND IT REACHES THE WATER — measured against a control run');
// ===========================================================================
// The failure this catches is the quiet one: every field above reads correctly,
// `staggerTimer` counts down, and the boss swims through it at full speed
// because the integrator never spends the number.
//
// SEEDED, and the same seeds on both sides. A boss picks its heading, its
// weave phase and its standoff from Math.random, so an unseeded pair measures
// the dice as much as the rule — and the standard "fix" for a flake like that
// is to widen the threshold until it stops, which deletes the assertion.
{
  const mulberry32 = (seed) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // How far it travels in the second after the stagger lands. Distance
  // TRAVELLED rather than ground closed on the seal: a boss holds a standoff
  // (systems/apexCrowd.js), so "closed" can be zero on a perfectly healthy run
  // and would make this measure the standoff instead of the stagger.
  const travelRun = (staggered) => {
    fresh();
    const b = put('bossShark', { boss: true, at: { x: 24, y: 0 } });
    const to = { x: 0, y: 0, z: 0 };
    // Settle into the approach first, or the first frames measure a standing
    // start rather than a boss under way.
    for (let i = 0; i < 60; i++) updateEnemies(DT, scene, to, noop, noop, noop);
    if (staggered) staggerBoss(b);
    const x0 = b.mesh.position.x;
    const y0 = b.mesh.position.y;
    let travelled = 0;
    let px = x0;
    let py = y0;
    for (let i = 0; i < 60; i++) {
      updateEnemies(DT, scene, to, noop, noop, noop);
      travelled += Math.hypot(b.mesh.position.x - px, b.mesh.position.y - py);
      px = b.mesh.position.x;
      py = b.mesh.position.y;
    }
    return travelled;
  };
  const run = (staggered, seed) => {
    const real = Math.random;
    Math.random = mulberry32(seed);
    try { return travelRun(staggered); } finally { Math.random = real; }
  };
  const avg = (staggered, n = 12) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += run(staggered, 0x5EA1 + i);
    return sum / n;
  };

  const free = avg(false);
  const held = avg(true);
  check('a staggered boss covers far less water in the second it is held',
    held < free * 0.6, `${held.toFixed(2)}u against ${free.toFixed(2)}u`);
  check('...but it is still moving — this is a stagger, not a stop',
    held > 0, `${held.toFixed(2)}u`);
  check('...and it has its swimming back afterwards',
    Math.abs(avg(false) - free) < 1e-9, 'the control is repeatable');
}

// ===========================================================================
section('THE RUN LANDS WHERE IT WAS AIMED — under fire, measured');
// ===========================================================================
// The whole point of the block, asked the way a player would feel it: a boss
// committed to a run, shot at every frame of it, and how far off its line the
// shooting pushed it. With the rule on that number is zero; with it off it is
// the old game, where the answer to a wind-up was to shoot harder.
//
// Perpendicular to the run on purpose. A shove along the line only makes the
// pass early or late; a shove ACROSS it is what turns a hit into a miss, which
// is the thing the player was buying for free.
{
  const drift = (tenacious) => {
    const was = TEN.enabled;
    TEN.enabled = tenacious;
    fresh();
    const b = put('bossShark', { boss: true, at: { x: 26, y: -20 } });
    const to = { x: 0, y: -20, z: 0 };
    // Straight into a committed run, rather than waiting for the cadence to
    // roll one: the lunge's own timing is tools/boss-dodge-test.mjs's subject
    // and would only add a wait here.
    b.lungeStage = 'strike';
    b.lungeClock = 1;
    b.lungeStageTime = 1;
    b.lungePlan = [{ stage: 'strike', time: 1 }];
    b.lungeStep = 0;
    b.heading = Math.PI;              // pointed at the seal, west
    const lane = b.mesh.position.y;   // the line the run was committed on
    let worst = 0;
    for (let i = 0; i < 40; i++) {
      // A pellet a frame, across the run. `shot` is the name every projectile
      // in the game gives itself.
      applyKnockback(b, 0, 1, 1, { source: 'shot' });
      updateEnemies(DT, scene, to, noop, noop, noop);
      worst = Math.max(worst, Math.abs(b.mesh.position.y - lane));
    }
    TEN.enabled = was;
    return worst;
  };

  const held = drift(true);
  const pushed = drift(false);
  check('a boss under fire holds the line it committed to',
    held < 0.05, `${held.toFixed(2)}u off its lane across the run`);
  check('...and with the rule off, the same shooting walks it off that line',
    pushed > held * 10 && pushed > 1,
    `${pushed.toFixed(2)}u — this is the game before the block`);
}

// ===========================================================================
section('THE ATTACKS STILL HAPPEN — a whole fight under fire, counted');
// ===========================================================================
// The complaint this answers, in the words it arrived in: the damage reaction
// cancels out any lunge that needs to happen. Everything above measures one
// run held on its line; this measures whether the runs COME AT ALL, over a
// fight long enough for the cadence to matter, against an identical boss
// nobody is shooting.
//
// SAME SEED ON BOTH SIDES. A boss rolls its stagger, its plan and its veer off
// Math.random, so an unseeded pair measures the dice rather than the rule —
// and the standard fix for a flake like that is to widen the threshold until
// it stops, which is the assertion deleting itself. Identical seeds mean the
// two fights are the same fight, and the only difference is the shooting.
//
// EVERY CHANNEL A PELLET HAS, fired every frame: the damage, the flinch flag
// the animation reads, and the shove. Not the weak spot's jostle — that is a
// skeleton impulse, and its refusal is measured on the actual bones in
// tools/boss-hotspot-test.mjs section 5h, where a rig is loaded and there is
// something to measure. What is asserted here is the half that decides the
// fight: how many attacks the animal got to make.
{
  const seeded = (seed) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let x = Math.imul(a ^ (a >>> 15), 1 | a);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  };

  // One fight. Returns how many runs the boss committed to and how many of
  // them it finished, which are different questions: a run that is started and
  // then broken is exactly the failure being hunted, and counting only starts
  // would have missed it.
  //
  // `stagger` is a frame to fire the one legal interrupt on, and `leftRunOn`
  // reports whether the animal actually came out of its run on that frame —
  // the other half of the rule, which has to be driven rather than read off a
  // field, or the block above is satisfied by a boss nothing can stop at all.
  function fight(key, seed, { fire = false, stagger = -1 } = {}) {
    const real = Math.random;
    Math.random = seeded(seed);
    try {
      fresh();
      const b = put(key, { boss: true, at: { x: -30, y: -20 } });
      b.hp = 1e9;                      // the fight is the subject, not the kill
      const to = { x: 0, y: -20, z: 0 };
      let started = 0;
      let finished = 0;
      let prev = null;
      let broken = 0;
      let firstRunAt = -1;
      let leftRunOn = false;
      for (let i = 0; i < 60 * 60; i++) {
        if (fire) {
          b.hp -= 3;
          b.hitThisFrame = true;
          applyKnockback(b, 0, 1, 1, { source: 'shot' });
        }
        // The one thing that is allowed to end a run, fired once, mid-run.
        if (i === stagger && b.lungeStage === 'strike') { staggerBoss(b); leftRunOn = b.lungeStage !== 'strike'; }
        if (firstRunAt < 0 && b.lungeStage === 'strike') firstRunAt = i;
        updateEnemies(DT, scene, to, noop, noop, noop);
        if (b.lungeStage !== prev) {
          if (b.lungeStage === 'strike') started++;
          // A run that ends in `rest` ran its course; one that ends anywhere
          // else was cut short. `reaim` is the middle of a two-part plan and
          // is neither.
          if (prev === 'strike' && b.lungeStage === 'rest') finished++;
          if (prev === 'strike' && b.lungeStage !== 'rest' && b.lungeStage !== 'reaim') broken++;
          prev = b.lungeStage;
        }
      }
      return { started, finished, broken, firstRunAt, leftRunOn };
    } finally { Math.random = real; }
  }

  // A THROWAWAY FIGHT PER BODY FIRST, and it is not a wart. resetEnemies clears
  // the water but not every clock this module and the crowd keep across a run,
  // so the FIRST fight with a given species carries state the next one does
  // not — the control and the probe would differ by a run before either of
  // them was shot at, and the honest reading of that number is "warm-up", not
  // "the rule". Warmed, the two fights below are bit-identical frame for
  // frame, and an exact comparison is the only one worth making: a tolerance
  // here is a licence the next regression gets to spend.
  const warm = (key, seed) => { fight(key, seed, {}); };

  // THE HAMMERHEAD FIRST, because it is the body the complaint was made about
  // and the one that shows it worst: the smallest boss in the water, the
  // longest spring chain in the roster, and a tell that is entirely the head
  // coming round to face you.
  for (const key of ['bossHammerhead', 'bossShark', 'bossOrca', 'bossMosasaur']) {
    warm(key, 7);
    const calm = fight(key, 7, {});
    const shot = fight(key, 7, { fire: true });
    check(`${key} attacks under fire exactly as often as one nobody is shooting`,
      shot.started === calm.started && shot.finished === calm.finished,
      `${shot.started}/${shot.finished} runs started/finished against ${calm.started}/${calm.finished}`);
    check('...and it finishes every one it starts', shot.broken === 0
      && shot.finished > 0, `${shot.broken} cut short of ${shot.started}`);
  }

  // ...AND THE ONE THING THAT MAY STOP ONE STILL DOES. Driven on the same
  // fight rather than asserted off the field: without this the block above is
  // satisfied by a boss nothing can interrupt at all, which is a different bug
  // wearing this one's passing test.
  {
    warm('bossHammerhead', 7);
    const under = fight('bossHammerhead', 7, { fire: true });
    const rammed = fight('bossHammerhead', 7, { fire: true, stagger: under.firstRunAt });
    check('a perfect ram into a lit spot still ends a run under way',
      under.firstRunAt >= 0 && rammed.leftRunOn,
      `rammed on frame ${under.firstRunAt}, the run's first`);
    // ...ON A RUN THE SHOOTING ALONE WAS NOT GOING TO END. Without this the
    // check above passes on a run that was finishing anyway, which reads
    // exactly like the mechanic working and exactly like it not existing.
    const early = fight('bossHammerhead', 7, { fire: true, stagger: under.firstRunAt - 1 });
    check('...and a frame earlier, outside the run, it does nothing',
      !early.leftRunOn && early.started === under.started,
      `${early.started} runs either way`);
  }
}

// ===========================================================================
section('THE DOOR IS THIS NARROW — one caller, and it is the perfect ram');
// ===========================================================================
// A source scan, because the claim is about the whole codebase rather than
// about one call: "only a perfect strike into a weak spot staggers a boss" is
// false the moment a second system reaches for staggerBoss, and nothing else
// in this file would notice.
{
  const src = readFileSync(resolve(HERE, '../path/src/systems/strike.js'), 'utf8');
  const callers = [];
  for (const f of ['main.js', 'entities/enemies.js', 'systems/strike.js', 'systems/club.js',
    'systems/combat.js', 'systems/bossPerks.js', 'systems/bossHotSpots.js', 'systems/control.js']) {
    const text = readFileSync(resolve(HERE, '../path/src', f), 'utf8');
    // The definition and the import line are not calls.
    const hits = text.split('\n').filter((l) => /\bstaggerBoss\s*\(/.test(l)
      && !/export function staggerBoss/.test(l) && !/^\s*import\b/.test(l));
    if (hits.length) callers.push(`${f} x${hits.length}`);
  }
  check('exactly one system reaches for it', callers.length === 1 && callers[0] === 'systems/strike.js x1',
    callers.join(', ') || 'none');
  check('...and the call is gated on BOTH halves — a lit spot and a perfect release',
    /if \(weakRam && s\.perfectStrike\) staggerBoss\(e\);/.test(src));

  // AND THE THREE ALLOWED SHOVES STILL SAY WHAT THEY ARE. An `opts.source`
  // dropped from one of these calls does not throw and does not fail any test
  // that weapon owns — it just quietly stops moving a boss, which is a change
  // nobody would attribute to the line that caused it. The stand-in calls in
  // tools/strike-impact-test.mjs pass `ram` themselves, so this is the check
  // that the REAL one does too.
  check('the ram still names itself', /source: 'ram'/.test(src));
  // Comment lines stripped first: the note ABOVE a call mentions the source
  // too, and counting those would let a call that lost its argument hide
  // behind the sentence explaining why it needs one.
  const clubSrc = readFileSync(resolve(HERE, '../path/src/systems/club.js'), 'utf8')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const clubCalls = clubSrc.split('applyKnockback(').length - 1;
  const clubNamed = clubSrc.split("source: 'club'").length - 1;
  check('...and every club shove does', clubCalls > 0 && clubNamed === clubCalls,
    `${clubNamed} named of ${clubCalls}`);
  const burstSrc = readFileSync(resolve(HERE, '../path/src/main.js'), 'utf8');
  check('...and the rupture does', /source: 'rupture'/.test(burstSrc));
  // The projectile path names itself too — as `shot`, which is NOT on the
  // list. It is named anyway so that the refusal is a decision in the config
  // rather than an omission at the call site.
  const combatSrc = readFileSync(resolve(HERE, '../path/src/systems/combat.js'), 'utf8');
  check('...and a projectile says it is one, even though the list refuses it',
    /source: 'shot'/.test(combatSrc) && !TEN.sources.includes('shot'),
    `sources: ${TEN.sources.join(', ')}`);
}

console.log(failures ? `\nFAIL — ${failures} check(s)` : '\nall good');
process.exit(failures ? 1 : 0);
