#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:impact
//
// WHAT A STRIKE DOES WHEN IT LANDS, now that landing is no longer mostly about
// damage. A base strike is a SHOVE, a MARK, a scattering of small fish and a
// small BLAST where the button came up — never a wound on whatever it clipped.
// Every one of those is a claim about motion or about state over time, which is
// exactly what a screenshot cannot answer and what the browser preview cannot
// even run — it suspends requestAnimationFrame, so the loop is frozen there.
//
// Five things worth failing over:
//
//   BURST       that a ram itself takes nothing off what it hits, that the
//               damage instead goes off at the point of RELEASE, and that the
//               strike line adds real bite to it. This is the whole rebalance,
//               and it is one saved tuning value away from silently reverting —
//               `strike.damage` is in imported-tuning.json and the burst's own
//               damage field is not.
//
//   SHOVE       that the knock actually MOVES a body, in the dash's direction,
//               against every kind of steering there is. This is the one that
//               would have broken quietly: a turn-limited hunter assigns its
//               velocity outright every frame, so the obvious implementation
//               (add to e.vx) moves a flocking fish and does nothing at all to
//               a shark — and nothing throws.
//
//               ...and that the shove is BIG ENOUGH TO SEE, which is a second
//               claim entirely and the one that shipped broken: the seal is
//               travelling at dashSpeed when it connects and the camera rides
//               the seal, so a shove slower than the dash is displacement
//               moving the wrong way on screen. Measured against an identical
//               unhit shark AND against the seal's own motion.
//
//   MARK        that a ram paints big bodies and not minnows, that the paint
//               expires, that it survives being re-rammed, and that it drops
//               the moment the target leaves the scene. A mark holds a strong
//               reference to a creature; one that outlived its body would be a
//               leak with a reticle drawn on it.
//
//   PULL        that a marked target actually wins a target-picker's "nearest"
//               comparison against a closer unmarked one — the entire point of
//               marking something the seal cannot hurt.
//
//   SCATTER     that a school moves AWAY from a wound-up strike, and that a
//               dash frightens harder than a wind-up.
//
// What it cannot tell you: whether the shove feels heavy, or whether six
// seconds is the right length for a lock. Those are a controller in your hands.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { baseStats } from '../path/src/stats.js';
import {
  enemies, spawnNamed, updateEnemies, resetEnemies, applyKnockback, setStrikeThreat,
} from '../path/src/entities/enemies.js';
import {
  strikeState, resetStrike, updateStrike, strikeBurst,
} from '../path/src/systems/strike.js';
import {
  markTarget, markable, isMarked, markWeight, updateMarks, resetMarks, __ringShader,
} from '../path/src/systems/marks.js';
import { jostleBoat } from '../path/src/systems/boats.js';
import { bossArchetypes, forceBoss, resetBoss } from '../path/src/systems/boss.js';
import { RigidBody } from '../path/src/systems/rigidBody.js';

const scene = new THREE.Scene();
const dt = 1 / 60;

// The animation controller warns once per state per creature for clips a
// procedural stand-in does not have, which in Node is all of them.
const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[animation]') || msg.startsWith('[assets]'))) return;
  realWarn(msg, ...rest);
};

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
const section = (s) => console.log(`\n${s}`);

const stats = baseStats();
const playerPos = new THREE.Vector3(0, -20, 0);

// A dash, declared directly. tryStrike() is the real entry point and is tested
// by test:strike and test:meter; what matters here is the state the hit loop
// reads.
//
// `sweet` is part of that state and not an optional extra: a strike released
// outside the sweet spot does no damage at all, so a dash armed without the
// stamp measures the timing gate rather than the impact this file is about.
// Exposed as an argument so the gate itself can be checked here too — see the
// off-beat section at the end.
function armDash(power = 1, dir = { x: 1, y: 0 }, sweet = true) {
  resetStrike();
  strikeState.active = true;
  strikeState.power = power;
  strikeState.sweetStrike = sweet;
  strikeState.dashTimeLeft = 1;
  strikeState.dashDuration = 1;
  strikeState.dashDir = { x: dir.x, y: dir.y };
}

function spawnAt(type, x, y) {
  const e = spawnNamed(scene, type, 0, { x, y }, { ignoreCaps: true });
  if (!e) throw new Error(`could not spawn ${type}`);
  // Spawned creatures may still be "entering" from off the wings, which skips
  // the horizontal clamp and some of the steering. Everything here is a body
  // already in the arena.
  e.entering = false;
  return e;
}

// ----------------------------------------------------------------- the burst

section('BURST — the strike spends its damage where the button came up');

check('the strike damage stat is the BURST, not the nominal strike',
  stats.strikeDamage === CONFIG.strike.burst.damage,
  `stat ${stats.strikeDamage}, burst.damage ${CONFIG.strike.burst.damage}`);

// The trap this exists for: `strike.damage` is saved in imported-tuning.json,
// so a base damage kept there would be whatever the tuner last wrote — 40, at
// the time of writing. The burst's number has to be one the tuning file does
// not already own, or this rebalance silently does not happen in the real game.
check('...which is a different field from the one the tuner writes',
  CONFIG.strike.burst.damage < CONFIG.strike.damage,
  `${CONFIG.strike.burst.damage} vs ${CONFIG.strike.damage}`);

// A RAM ITSELF DEALS NOTHING. The whole point of moving the damage to the
// release: a dash is a shove, and the damage is one readable event where the
// player pressed the button.
{
  resetEnemies(scene);
  resetStrike();
  const bystander = spawnAt('shark', 0.2, -20);
  const hp = bystander.hp;
  armDash(1, { x: 1, y: 0 });
  let damaged = 0;
  updateStrike(dt, scene, playerPos, stats, enemies, { onEnemyDamaged: () => { damaged++; } });
  check('a ram takes no health off what it hits', bystander.hp === hp,
    `${bystander.hp.toFixed(1)} of ${hp.toFixed(1)} hp`);
  check('...and reports no damage rather than a zero-point hit', damaged === 0);
  check('...but it still shoves', Math.abs(bystander.knockX) > 0,
    `${bystander.knockX.toFixed(1)} u/s`);
}

// The burst itself scales on both axes, and both come off the one function the
// release calls — a second copy of this arithmetic in the test would pass
// while the game did something else.
armDash(1);
const full = strikeBurst(stats);
armDash(0.35);
const flick = strikeBurst(stats);
check('a full charge hits harder than a flick', full.damage > flick.damage * 1.5,
  `${full.damage.toFixed(1)} vs ${flick.damage.toFixed(1)}`);
check('...and reaches further', full.radius > flick.radius,
  `${full.radius.toFixed(2)} vs ${flick.radius.toFixed(2)} units`);
check('a flick still goes off at all', flick.damage > 0 && flick.radius > 0);

armDash(1);
const shark = CONFIG.enemies.shark;
check('a full-charge burst is small against a shark',
  full.damage < shark.hp * 0.35, `${full.damage.toFixed(1)} vs ${shark.hp} hp`);
check('...but clears a school of minnows', full.damage >= CONFIG.enemies.fish.hp,
  `${full.damage.toFixed(1)} vs ${CONFIG.enemies.fish.hp} hp`);
// "Small" measured against the dash it belongs to: a full-charge dash travels
// dashSpeed x dashDuration x reachMulMax, and a blast approaching that is not a
// pop at the release point, it is the whole corridor going off at once.
const dashReach = CONFIG.strike.dashSpeed * CONFIG.strike.dashDuration
  * CONFIG.strike.charge.reachMulMax;
check('the blast is a pop, not the whole dash corridor going off',
  full.radius < dashReach * 0.25,
  `${full.radius.toFixed(2)} units vs a ${dashReach.toFixed(1)}-unit dash`);

// Splash Zone widens the blast, and must not also inflate the damage — that
// separation is what `aoeMul` has always meant.
{
  const wide = { ...stats, aoeMul: 1.5 };
  const w = strikeBurst(wide);
  check('Splash Zone widens the burst', w.radius > full.radius * 1.4,
    `${w.radius.toFixed(2)} vs ${full.radius.toFixed(2)}`);
  check('...and leaves its damage alone', w.damage === full.damage);
}

// Turned off, nothing goes off — the switch has to reach the arithmetic, not
// just the call site.
{
  CONFIG.strike.burst.enabled = false;
  const off = strikeBurst(stats);
  check('the burst switch reaches the damage', off.damage === 0 && off.radius === 0);
  CONFIG.strike.burst.enabled = true;
}

// And contactShare is a real dial: turned up, the ram bites again.
{
  CONFIG.strike.contactShare = 0.5;
  resetEnemies(scene);
  resetStrike();
  const victim = spawnAt('shark', 0.2, -20);
  const hp = victim.hp;
  armDash(1, { x: 1, y: 0 });
  updateStrike(dt, scene, playerPos, stats, enemies, {});
  check('dialling contactShare up puts damage back on the ram', victim.hp < hp,
    `${(hp - victim.hp).toFixed(1)} dealt`);
  CONFIG.strike.contactShare = 0;
}

// Every card in the family pays in. Measured by running the real apply()s.
const strikeCards = CONFIG.upgrades.filter((u) => u.family === 'strike');
check('the whole strike family is present', strikeCards.length >= 5,
  `${strikeCards.length} card(s)`);
for (const card of strikeCards) {
  const s = baseStats();
  card.apply(s);
  check(`${card.id} adds bite`, s.strikeDamage > stats.strikeDamage,
    `${stats.strikeDamage} -> ${s.strikeDamage}`);
}

// And the line as a whole gets somewhere worth going.
const maxed = baseStats();
for (const card of strikeCards) {
  for (let i = 0; i < (card.maxStacks ?? 1); i++) card.apply(maxed);
}
check('a fully-invested strike line is a real weapon again',
  maxed.strikeDamage > CONFIG.strike.damage,
  `${maxed.strikeDamage} vs the nominal ${CONFIG.strike.damage}`);

// ----------------------------------------------------------------- the shove

section('SHOVE — the knock moves a body whatever steers it');

// Measured against a CONTROL run of the same creature, not against where it
// started. A shark cruises at 7 units/sec under its own power, so half a
// second of its own swimming is several times the shove and swamps any
// before/after reading — the first version of this test "failed" on a shark
// that had been thrown perfectly well and had then simply turned round.
//
// Both runs are driven off a seeded RNG so the pair really is the same fish
// twice: spawn rolls a heading, a phase and a speed within its variance, and
// the behaviours roll again every frame. Reseeding is what makes the
// difference between the two runs attributable to the knock and nothing else.
const realRandom = Math.random;
function seedRandom(seed = 12345) {
  let s = seed >>> 0;
  Math.random = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// The knock is applied MID-RUN, after an identical warm-up, and measured over
// a short window. Both halves of that matter:
//
//   the WARM-UP because a creature spawns on a random heading and the shared
//   crowd systems (apexCrowd) carry state between calls — so a run measured
//   from the spawn frame is really measuring "which way was it pointed", and
//   the answer changed when unrelated checks were added above this one.
//
//   the SHORT WINDOW because the shove is over in about a fifth of a second at
//   the shipped decay, while a shark swims 7 units/sec forever. Measuring
//   longer just adds steering to both sides of a subtraction.
function travel(type, { knocked, seed = 12345, warmup = 0.5, seconds = 0.2 }) {
  seedRandom(seed);
  resetEnemies(scene);
  const e = spawnAt(type, 0, -20);
  for (let i = 0; i < Math.round(warmup / dt); i++) {
    updateEnemies(dt, scene, playerPos, () => {}, () => {});
  }
  const startX = e.mesh.position.x;
  const push = knocked ? applyKnockback(e, 1, 0, 1) : 0;
  // The falloff THIS body took, which is no longer one number for the whole
  // roster: a big animal that survives the ram is shoved harder and its shove
  // bleeds off slower (CONFIG.strike.knockback.heavy). Both halves are read
  // off the creature rather than out of CONFIG, so the numbers below describe
  // the hit that actually landed.
  const decay = e.knockDecay || CONFIG.strike.knockback.decay;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    updateEnemies(dt, scene, playerPos, () => {}, () => {});
  }
  const moved = e.mesh.position.x - startX;
  // ...and then run on to three time constants of that decay before reading
  // what is left of the shove. A fixed window would ask a heavy knock to be
  // as far spent as a light one at the same moment, which is precisely the
  // thing that is meant to be different about it — and the check below is
  // about whether the shove ENDS, not about how quickly.
  for (let i = 0; i < Math.round(Math.max(0, 3 / decay - seconds) / dt); i++) {
    updateEnemies(dt, scene, playerPos, () => {}, () => {});
  }
  const out = {
    push,
    decay,
    // How far the shove is worth in units: a velocity decaying exponentially
    // integrates to speed/decay. THE comparable number between two bodies,
    // now that they do not share a falloff.
    reach: knocked ? push / decay : 0,
    moved,
    residual: e.knockX,
  };
  Math.random = realRandom;
  return out;
}

// One creature per KIND of steering, because they own e.vx in three different
// ways: `swarm` blends toward a boids sum, `chase`/hunt with a turnRate
// ASSIGNS it outright every frame, and `crawl` has gravity added to it. The
// third case is why the knock is integrated separately — a shove written into
// vx is erased before it moves a shark an inch, and nothing throws.
playerPos.set(0, 8, 0);
for (const type of ['fish', 'shark', 'walkingCrab']) {
  const hit = travel(type, { knocked: true });
  const control = travel(type, { knocked: false });
  const gained = hit.moved - control.moved;
  check(`${type}: the knock is a real impulse`, hit.push > 0, `${hit.push.toFixed(1)} u/s`);
  check(`${type}: it travelled further along the dash than the same body unhit`,
    gained > 0.4, `${gained.toFixed(2)} units of daylight`);
  // Most of the throw should be spent by the end of that window — a shove that
  // is still going is a launch, and the difference is whether a rammed body
  // comes back at you or sails out of the fight.
  check(`${type}: and the shove bled off rather than launching it`,
    Math.abs(hit.residual) < hit.push * 0.1,
    `residual ${hit.residual.toFixed(2)} of ${hit.push.toFixed(1)} at decay ${hit.decay}`);
}
playerPos.set(0, -20, 0);

// SIZE RESISTS — among the bodies that are actually knocked around, which is
// the comparison worth making. A minnow is NOT one of them: the dash EATS
// anything under `preyCull.maxRadius`, so a fish handed a shove is a corpse
// being shoved, and it takes the light knock by the `hp > 0` test rather than
// by its size. Comparing it against a megalodon compares two different rules.
//
// Compared as DISTANCES rather than as launch speeds, because the two classes
// do not share a falloff and a speed comparison across them means nothing.
// Distance is speed/decay.
resetEnemies(scene);
const heavyOne = spawnAt('shark', 0, -20);
const meg = spawnAt('megalodon', 6, -20);
const bigReach = applyKnockback(heavyOne, 1, 0, 1) / (heavyOne.knockDecay || 1);
const megReach = applyKnockback(meg, 1, 0, 1) / (meg.knockDecay || 1);
check('a shark is thrown further than a megalodon by the same ram',
  bigReach > megReach * 1.5,
  `${bigReach.toFixed(2)} units vs ${megReach.toFixed(2)}`);

// ...and the line between the two classes is the CULL's line, so there is no
// band of fish too big to swallow and too small to be shoved properly.
resetEnemies(scene);
const minnow = spawnAt('fish', 0, -20);
applyKnockback(minnow, 1, 0, 1);
check('the heavy knock starts exactly where the dash stops eating',
  CONFIG.strike.knockback.heavy.minRadius === CONFIG.strike.preyCull.maxRadius,
  `heavy ${CONFIG.strike.knockback.heavy.minRadius}, cull ${CONFIG.strike.preyCull.maxRadius}`);
check('...so a fish the seal swallows takes the light knock',
  minnow.knockDecay === CONFIG.strike.knockback.decay && minnow.staggerTimer === 0);

// Charge scales it.
resetEnemies(scene);
const a = spawnAt('shark', 0, -20);
const b = spawnAt('shark', 8, -20);
check('a full charge shoves harder than a flick',
  applyKnockback(a, 1, 0, 1) > applyKnockback(b, 1, 0, 0.1) * 1.5);

// ---------------------------------------------- can the player SEE it happen
//
// The check this section was missing, and the reason a shove that measured
// fine read as nothing in the game: the seal is travelling at `dashSpeed` when
// it connects, AND THE CAMERA RIDES THE SEAL. A shark shoved along the dash
// slower than the dash is a shark the seal overtakes — real displacement,
// moving the wrong way on screen, indistinguishable from swimming past it.
//
// So this drives the REAL dash: the hit loop in updateStrike, with the player
// advancing at dashSpeed for the dash's own duration, measured against an
// identical unhit shark on the same seed.
{
  const dashSpeed = CONFIG.strike.dashSpeed;
  const c = CONFIG.strike.charge;

  function rammed({ knocked, power, seconds, seed = 99 }) {
    seedRandom(seed);
    resetEnemies(scene);
    resetStrike();
    const seal = new THREE.Vector3(-6, -20, 0);
    const e = spawnAt('shark', 0, -20);
    e.hp = 1e6; // it SURVIVES — that is the case being measured
    for (let i = 0; i < 30; i++) updateEnemies(dt, scene, seal, () => {}, () => {});

    const duration = stats.strikeDashDuration
      * (c.reachMulMin + (c.reachMulMax - c.reachMulMin) * power);
    if (knocked) armDash(power, { x: 1, y: 0 });
    let rams = 0;
    let overtaken = false;
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      const t = i * dt;
      if (knocked) {
        if (t < duration) seal.x += dashSpeed * dt;
        updateStrike(dt, scene, seal, stats, enemies, { onRam: () => { rams++; } });
        // Only while the dash is still running: afterwards the seal coasts and
        // being level with it means nothing.
        if (rams > 0 && t < duration && e.mesh.position.x < seal.x) overtaken = true;
      }
      updateEnemies(dt, scene, seal, () => {}, () => {});
    }
    Math.random = realRandom;
    return { x: e.mesh.position.x, rams, overtaken };
  }

  const seeds = [11, 99, 4242, 777, 31337];
  const gained = (power, seconds) => seeds.reduce((sum, seed) => {
    const hit = rammed({ knocked: true, power, seconds, seed });
    const ctl = rammed({ knocked: false, power, seconds, seed });
    return sum + (hit.x - ctl.x);
  }, 0) / seeds.length;

  check('the dash actually reaches a shark through the real hit loop',
    rammed({ knocked: true, power: 0.35, seconds: 0.5 }).rams === 1);

  // A shark's body is about six world units end to end. Anything under a
  // fraction of that is a shove nobody can pick out of the animal's own
  // swimming, which is exactly what shipped first.
  const normal = gained(0.35, 0.5);
  const full = gained(1, 0.5);
  check('a normal-charge ram visibly moves a shark that survives it',
    normal > 3, `${normal.toFixed(1)} units on an identical unhit shark, half a second in`);
  check('...and a full-charge one moves it further still',
    full > normal, `${full.toFixed(1)} vs ${normal.toFixed(1)} units`);

  // The one that catches the invisible version: the shove has to be worth more
  // than the dash carrying the seal through it.
  resetEnemies(scene);
  const launched = applyKnockback(spawnAt('shark', 0, -20), 1, 0, 1);
  check('a full-charge shove leaves faster than the seal is dashing',
    launched > dashSpeed,
    `${launched.toFixed(0)} u/s against a ${dashSpeed} u/s dash`);
  check('...so the seal never overtakes what it just rammed',
    !rammed({ knocked: true, power: 1, seconds: 0.5 }).overtaken);
}

// ------------------------------------------------ the ones that survive it
//
// A ram on a shark used to be a couple of units of shove laid on top of an
// animal swimming seven units a second straight back at you: the physics was
// there and it was invisible. CONFIG.strike.knockback.heavy is the answer —
// a harder shove that carries, and the animal knocked off its own stroke
// while it travels. All three parts are checked here, because each one alone
// reads as "nothing happened" (the shove is swum through) or as a bug (a
// shark that stops dead, a shark that never recovers).

resetEnemies(scene);
{
  const shark = spawnAt('shark', 0, -20);
  const minnow = spawnAt('fish', 6, -20);
  applyKnockback(shark, 1, 0, 1);
  applyKnockback(minnow, 1, 0, 1);
  check('a shark that survives the ram is knocked off its stroke',
    shark.staggerTimer > 0, `${shark.staggerTimer.toFixed(2)}s`);
  check('...and its shove carries further than an ordinary one',
    shark.knockDecay < CONFIG.strike.knockback.decay,
    `decay ${shark.knockDecay} vs ${CONFIG.strike.knockback.decay}`);
  check('a minnow is not staggered, it is simply thrown',
    minnow.staggerTimer === 0 && minnow.knockDecay === CONFIG.strike.knockback.decay);

  // It recovers. A stagger that never expired would be a stun-lock bought with
  // a mechanic that deals no damage.
  for (let i = 0; i < Math.ceil((CONFIG.strike.knockback.heavy.stagger + 0.2) / dt); i++) {
    updateEnemies(dt, scene, playerPos, () => {}, () => {});
  }
  check('...and it is swimming again a moment later', shark.staggerTimer === 0,
    'the stagger is a beat, not a hold');
}

// A body that DIED to the same hit takes the ordinary knock. `hp` is already
// spent by the time the shove is applied (see the hit loop in strike.js), so
// this is the branch that decides which of the two a corpse gets — and a
// corpse being staggered would slow the gore down.
resetEnemies(scene);
{
  const doomed = spawnAt('shark', 0, -20);
  doomed.hp = 0;
  applyKnockback(doomed, 1, 0, 1);
  check('a shark that died to the ram is not staggered by it',
    doomed.staggerTimer === 0 && doomed.knockDecay === CONFIG.strike.knockback.decay);
}

// And a boss is never held by it. A boss owns what crowd control does to it
// (CONFIG.boss.control.daze); a ram is not allowed to open that door round the
// back, so the guard is on the knock itself rather than on the caller.
resetEnemies(scene);
{
  const impostor = spawnAt('shark', 0, -20);
  impostor.isBoss = true;
  applyKnockback(impostor, 1, 0, 1);
  check('a boss is shoved but never staggered',
    impostor.staggerTimer === 0 && impostor.knockX > 0,
    `knock ${impostor.knockX.toFixed(1)} u/s`);
}

// ------------------------------------------------------------------ the boss

section('BOSS — a ram moves one, and less the bigger it is');

// EVERY ARCHETYPE, through forceBoss, because the number that decides how far
// a boss is shoved is assembled from two files: `radius` in enemies.csv and
// `sizeMul` in bosses.csv (applyBossScale multiplies the second into
// `sizeMul`, which is exactly what applyKnockback divides by). A test that
// spawned the creature and set `isBoss` by hand — the impostor above — would
// measure a boss shark at 1.6x less mass than the fight has, and would keep
// passing if the size step were dropped from the arrival entirely.
//
// Perk-less on purpose: a perk that DRIVES the body (`perkDrive`) is the one
// state where the boss's own motion is scripted, and rolling one would make
// which boss got which perk part of the measurement.
function bossTravel(id, { knocked, seconds = 0.5, seed = 2468 }) {
  seedRandom(seed);
  resetEnemies(scene);
  resetBoss();
  const e = forceBoss(scene, { difficulty: 0, level: 12, running: true }, { boss: id, perk: null });
  if (!e) throw new Error(`forceBoss could not spawn ${id}`);
  e.entering = false;
  // MOVED INTO OPEN WATER, and this is not tidiness. A boss arrives at the
  // WALL it swam in from — a boat boss arrives on station and is held against
  // the horizontal clamp — and a body clamped at the boundary absorbs a shove
  // aimed at the wall completely: the first version of this section measured
  // the arena's edge and reported that four archetypes could not be moved at
  // all. The knock does not read position, so where the body starts is the
  // one thing here that is free to be chosen.
  e.mesh.position.set(-12, -20, 0);
  e.knockX = 0;
  e.knockY = 0;
  // Same warm-up as `travel` above, and for the same reason: a body measured
  // from its spawn frame is really being asked which way it was pointed.
  for (let i = 0; i < 30; i++) updateEnemies(dt, scene, playerPos, () => {}, () => {});
  const startX = e.mesh.position.x;
  const push = knocked ? applyKnockback(e, 1, 0, 1) : 0;
  const decay = e.knockDecay || CONFIG.strike.knockback.decay;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    updateEnemies(dt, scene, playerPos, () => {}, () => {});
  }
  const out = {
    id,
    push,
    decay,
    reach: knocked ? push / decay : 0,
    moved: e.mesh.position.x - startX,
    // What the divisor actually read — authored radius times the boss scale,
    // NOT the hitbox. Printed with every row because it is the whole ordering.
    size: (e.def?.radius ?? e.radius) * (e.sizeMul ?? 1),
    bodyR: e.radius,
    stagger: e.staggerTimer ?? 0,
    heading: e.heading,
  };
  Math.random = realRandom;
  return out;
}

const bossRows = [];
for (const arch of bossArchetypes()) {
  const hit = bossTravel(arch.id, { knocked: true });
  const control = bossTravel(arch.id, { knocked: false });
  const gained = hit.moved - control.moved;
  bossRows.push({ ...hit, gained });
  // A TENTH OF ITS OWN BODY, measured against the same boss unhit. Written
  // against `radius` rather than as a flat distance because that is the claim
  // that failed before this existed: the shove was real in the physics and
  // under a tenth of a body radius for every archetype in the roster, which on
  // screen is a seal bouncing off a boss that did not react.
  check(`${arch.id}: a ram moves it`,
    gained > hit.bodyR * 0.1,
    `${gained.toFixed(2)} units against a ${hit.bodyR.toFixed(1)}-unit body`);
}

// INVERSE IN SIZE, across the whole roster at once. Ranking rather than a
// pair, because a pair can be satisfied by a special case: this is the claim
// that ONE rule is doing it, and it fails the moment a boss is given a shove
// of its own that does not answer to the divisor.
{
  const bySize = [...bossRows].sort((a, b) => a.size - b.size);
  let ordered = true;
  for (let i = 1; i < bySize.length; i++) {
    if (bySize[i].reach > bySize[i - 1].reach + 1e-6) ordered = false;
  }
  check('the bigger the boss, the less it is moved — every one of them',
    ordered,
    bySize.map((r) => `${r.id.replace('boss', '')} ${r.size.toFixed(1)}→${r.reach.toFixed(1)}u`).join(', '));
  // ...and the spread is worth having. Two bosses four times apart in size
  // that both travel the same distance would pass the ranking above on ties.
  const small = bySize[0];
  const big = bySize[bySize.length - 1];
  check('...and the smallest is moved several times as far as the largest',
    small.reach > big.reach * 2,
    `${small.id} ${small.reach.toFixed(2)}u vs ${big.id} ${big.reach.toFixed(2)}u`);
}

// LEANED ON, NOT THROWN. The heavy knock is sized to clear a shark out of a
// dash the camera is riding; a boss taking that number would read as
// weightless, which is the failure mode on the other side of the one this
// section is about.
{
  resetEnemies(scene);
  const loose = spawnAt('shark', 0, -20);
  const sharkReach = applyKnockback(loose, 1, 0, 1) / (loose.knockDecay || 1);
  const bossShark = bossRows.find((r) => r.id === 'bossShark');
  check('a boss shark is shoved less than a loose one',
    bossShark && bossShark.reach < sharkReach * 0.5,
    `${bossShark?.reach.toFixed(2)}u vs ${sharkReach.toFixed(2)}u`);
}

// AND IT KEEPS ITS TURN. The daze is the only thing in the game allowed to
// take a boss's propulsion or its aim away, on one budget and behind a
// cooldown (CONFIG.boss.control.daze) — a ram is charged every few seconds and
// has neither, so the two dials that would do it ship at zero.
{
  const held = bossRows.filter((r) => r.stagger > 0);
  check('no archetype is staggered by the shove', held.length === 0,
    held.map((r) => r.id).join(', ') || 'none');
  check('...and the dials that would do it are off by default',
    (CONFIG.strike.knockback.boss.stagger ?? 0) === 0
      && (CONFIG.strike.knockback.boss.headingKick ?? 0) === 0);
}

{
  resetEnemies(scene);
  resetBoss();
  const e = forceBoss(scene, { difficulty: 0, level: 12, running: true },
    { boss: 'bossHammerhead', perk: null });
  e.entering = false;
  const before = e.heading;
  // Rammed from BEHIND, the direction with the most heading to steal: a kick
  // toward the dash would swing a boss facing the seal all the way round.
  applyKnockback(e, -Math.cos(before), -Math.sin(before), 1);
  check('a ram does not turn a boss off its aim', e.heading === before,
    `heading ${before?.toFixed(2)} → ${e.heading?.toFixed(2)}`);
}
resetEnemies(scene);
resetBoss();

// ------------------------------------------------------------------ the mark

section('MARK — the ram paints what it cannot hurt');

resetEnemies(scene);
resetMarks();
const bigOne = spawnAt('shark', 2, -20);
const smallOne = spawnAt('fish', 2.5, -20);

check('a shark is worth painting', markable(bigOne));
check('a minnow is not', !markable(smallOne));

check('marking a shark takes', markTarget(bigOne) === true);
check('...and it reads back as marked', isMarked(bigOne));
check('re-ramming the same body does not double-mark it',
  markTarget(bigOne) === false);
check('a minnow is refused outright',
  markTarget(smallOne) === false && !isMarked(smallOne));

// It expires. Driven a whole second past the configured duration so a mark
// that merely fades but never clears is caught.
for (let i = 0; i < Math.ceil((CONFIG.strike.mark.duration + 1) / dt); i++) updateMarks(dt);
check('the paint wears off', !isMarked(bigOne));

// A dead body drops its mark on the next tick, whatever its timer said. This
// is the leak: `marks` holds a strong reference to the creature.
resetMarks();
const doomed = spawnAt('shark', 4, -20);
markTarget(doomed);
check('a fresh mark holds', isMarked(doomed));
scene.remove(doomed.mesh); // what removeEnemy does
updateMarks(dt);
check('...and is dropped the moment the body leaves the scene', !isMarked(doomed));

// Boats. They have no `radius` in the creature sense, so they pass on being a
// hull rather than on size.
resetMarks();
const hull = { mesh: new THREE.Object3D(), hp: 60, halfLength: 3, halfHeight: 0.8, isTrawler: false,
  knockX: 0, knockY: 0, rock: 0, rockVel: 0, flash: 0 };
scene.add(hull.mesh);
check('a hull is markable', markable(hull, true));
check('...and takes the paint', markTarget(hull, { isBoat: true, radius: hull.halfLength }));

// ----------------------------------------------------------------- the wiring

// Source-level, because the alternative is a GL context and a real frame:
// main.js pulls in the renderer, the audio graph and the input stack, none of
// which exist in Node. Same approach as the WIRING block in test:strike.
section('WIRING — the release really is what spends the damage');
{
  const main = readFileSync(new URL('../path/src/main.js', import.meta.url), 'utf8');
  check('main.js asks strikeBurst for the numbers', main.includes('strikeBurst(player.stats)'));
  check('...and queues it through the shared splash path, tagged as the strike',
    /pendingSplashes\.push\(\{[^}]*source: 'strike'/s.test(main));
  check('...with its own feedback rather than the splash queue\'s big bang',
    main.includes("feedback('strikeBurst'"));
  // The one that would go silently missing: with the ram dealing no damage,
  // the strike's kills all happen in the burst, so the school-wipe chain link
  // has to be claimable from there or that source is dead.
  check('a school emptied by the burst can still score its chain link',
    /schoolWipe && s\.source === 'strike'/.test(main));
}

// ---------------------------------------------------------------- the reticle

section('RETICLE — the thing that tells the player a mark exists');
{
  const { vertexShader, fragmentShader, makeRing } = __ringShader;
  const mat = makeRing().material;
  const declared = Object.keys(mat.uniforms);
  const missing = declared.filter((u) => !fragmentShader.includes(u) && !vertexShader.includes(u));
  check('every uniform the material declares is read by the shader',
    missing.length === 0, missing.length ? missing.join(', ') : `${declared.length} uniforms`);
  const used = [...fragmentShader.matchAll(/uniform\s+\w+\s+(\w+)/g)].map((m) => m[1]);
  const unsupplied = used.filter((u) => !declared.includes(u));
  check('...and every uniform the shader reads is supplied',
    unsupplied.length === 0, unsupplied.length ? unsupplied.join(', ') : `${used.length} read`);
  check('the reticle is additive and does not write depth, so a body cannot clip it',
    mat.blending === THREE.AdditiveBlending && mat.depthWrite === false && mat.depthTest === false);
  mat.dispose();
}

// ------------------------------------------------------------------ the pull

section('PULL — a mark wins the "nearest" comparison');

resetMarks();
resetEnemies(scene);
const near = spawnAt('fish', 1, -20);
const far = spawnAt('shark', 3, -20);
markTarget(far);
check('an unmarked body is weighted at face value', markWeight(near) === 1);
check('a marked one looks closer than it is', markWeight(far) < 1,
  `x${markWeight(far)}`);
// The comparison every picker actually makes.
const dNear = 1 * markWeight(near);
const dFar = 3 * markWeight(far);
check('so a picker takes the marked shark over the nearer minnow', dFar < dNear,
  `${dFar.toFixed(2)} vs ${dNear.toFixed(2)}`);

// ...but not from across the arena. A mark is a preference, not a leash.
const dVeryFar = 40 * markWeight(far);
check('a mark on the far side of the arena still loses to what is on top of you',
  dVeryFar > dNear, `${dVeryFar.toFixed(2)} vs ${dNear.toFixed(2)}`);

// --------------------------------------------------------------- the scatter

section('SCATTER — small fish break away from a strike');

// A school sitting still, with the player far below so `towardPlayer` is not
// what moves them. Measured as distance from the point the strike is centred
// on, which is what "getting out of the way" means.
function schoolDrift({ dashing, power, seconds = 0.6, seed = 4242 }) {
  // Seeded, for the reason `travel` above is: every fish rolls a heading and a
  // speed at spawn and the boids roll again every frame, so three unseeded
  // runs are three different schools and the comparison between them is a
  // coin flip decided by which way they happened to be pointed. The margins
  // here are tenths of a unit — this failed about one run in fifteen before,
  // and it fails on whatever ran BEFORE it, which makes it look like the last
  // thing anyone added.
  seedRandom(seed);
  resetEnemies(scene);
  const fish = [];
  for (let i = 0; i < 8; i++) fish.push(spawnAt('fish', -1 + i * 0.35, -20 + (i % 3) * 0.3));
  playerPos.set(0, -20, 0);
  const focus = { x: playerPos.x, y: playerPos.y };
  const before = fish.map((f) => Math.hypot(f.mesh.position.x - focus.x, f.mesh.position.y - focus.y));
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    setStrikeThreat({ active: true, x: playerPos.x, y: playerPos.y, dirX: 1, dirY: 0, power, dashing });
    updateEnemies(dt, scene, playerPos, () => {}, () => {});
  }
  const after = fish.map((f) => Math.hypot(f.mesh.position.x - focus.x, f.mesh.position.y - focus.y));
  setStrikeThreat(null);
  Math.random = realRandom;
  const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
  return mean(after) - mean(before);
}

const calm = schoolDrift({ dashing: false, power: 0, seconds: 0.6 });
const winding = schoolDrift({ dashing: false, power: 1, seconds: 0.6 });
const dashing = schoolDrift({ dashing: true, power: 1, seconds: 0.6 });

check('a wound-up strike pushes a school away', winding > calm + 0.2,
  `${winding.toFixed(2)} vs ${calm.toFixed(2)} at rest`);
check('a dash in flight frightens harder than a wind-up', dashing > winding,
  `${dashing.toFixed(2)} vs ${winding.toFixed(2)}`);

// ------------------------------------------------------------------- the hull

section('HULL — a ram jostles a boat without rolling it over');

// A hull is a simulated body now (see systems/rigidBody.js and test:physics,
// which owns the physics itself). What this still has to check is the STRIKE's
// half of it: that a ram reaches the hull at all, along the dash, with the
// weight of the boat in it.
const react = CONFIG.boats.hitReaction;
const makeHull = (isTrawler = false) => {
  const mesh = new THREE.Object3D();
  const b = { mesh, hp: 60, isTrawler, halfLength: 3, halfHeight: 0.8, flash: 0 };
  b.body = new RigidBody({
    kind: 'boat', shape: 'box', owner: b, object: mesh, halfLength: 3, halfHeight: 0.8,
    mass: CONFIG.physics.boat.mass * (isTrawler ? CONFIG.physics.boat.trawlerMass : 1),
    drag: 0, angularDrag: CONFIG.physics.boat.angularDrag,
    righting: CONFIG.physics.boat.righting, rightingDamping: CONFIG.physics.boat.rightingDamping,
    spin: CONFIG.physics.boat.spin, maxAngle: react.maxRoll ?? 0.55,
  });
  return b;
};

const boat = makeHull();
jostleBoat(boat, 1, 0, 1, { x: 2.5, y: 0.4 });
check('the hull takes a shove', Math.abs(boat.body.vx) > 0, `${boat.body.vx.toFixed(2)} u/s`);
check('...along the dash, not upward', boat.body.vx > Math.abs(boat.body.vy));
check('...and it rolls from where the seal hit it', Math.abs(boat.body.angVel) > 0,
  `${boat.body.angVel.toFixed(2)} rad/s`);

// A trawler is heavier — carried by its mass now rather than by a resist
// factor, so one number covers every impulse a hull can take.
const trawler = makeHull(true);
jostleBoat(trawler, 1, 0, 1, { x: 2.5, y: 0.4 });
check('a trawler barely flinches next to a rowboat', trawler.body.vx < boat.body.vx,
  `${trawler.body.vx.toFixed(2)} vs ${boat.body.vx.toFixed(2)} u/s`);

// NO CAPSIZE. Ten full-charge rams in a row on the same spot, integrated
// through the real roll spring — the hull may lean hard and it may keep
// rocking, but it must never go over while it is still afloat.
const rammed = makeHull();
let worst = 0;
for (let hit = 0; hit < 10; hit++) {
  jostleBoat(rammed, 1, 0, 1, { x: 2.9, y: 0.8 });
  for (let i = 0; i < 12; i++) {
    rammed.body.integrate(dt);
    worst = Math.max(worst, Math.abs(rammed.body.angle));
  }
}
check('a hull rammed ten times still never goes past its lean limit',
  worst <= (react.maxRoll ?? 0.55) + 1e-6,
  `worst ${worst.toFixed(3)} rad, limit ${react.maxRoll}`);
check('...and the limit is well short of capsizing', (react.maxRoll ?? 0.55) < Math.PI / 4,
  `${react.maxRoll} rad`);

// ------------------------------------------------------------------ the chain

section('CHAIN — a shove is not a meal');

resetEnemies(scene);
resetMarks();
resetStrike();
const victim = spawnAt('shark', 0.2, -20);
armDash(1, { x: 1, y: 0 });
playerPos.set(0, -20, 0);
let chained = 0;
updateStrike(dt, scene, playerPos, stats, enemies, {
  onChainHit: () => { chained++; },
});
// Connection is no longer measurable as damage — that is the point. A ram
// announces itself by the hit flash, the shove and the paint.
check('the ram connected', victim.flash > 0 && victim.hitThisFrame === true);
check('...and it scored no FOOD CHAIN link', chained === 0);
check('...but it did paint the shark', isMarked(victim));
check('...and shoved it', Math.abs(victim.knockX) > 0, `${victim.knockX.toFixed(1)} u/s`);

// The switch is a switch: turned on, the same hit chains.
CONFIG.strike.chainOn.strikeHit = true;
resetEnemies(scene);
resetStrike();
const victim2 = spawnAt('shark', 0.2, -20);
armDash(1, { x: 1, y: 0 });
chained = 0;
updateStrike(dt, scene, playerPos, stats, enemies, { onChainHit: () => { chained++; } });
check('flipping chainOn.strikeHit brings the old behaviour back', chained === 1);
CONFIG.strike.chainOn.strikeHit = false;
void victim2;

// ------------------------------------------------------------------ off beat

section('OFF THE BEAT — the dash is a shove and nothing else');

// A dash released outside the sweet spot still HAPPENS: it travels, it
// connects, it throws bodies off their line and it paints the big ones for the
// homing weapons. What it does not do is take anything off them. Checked here
// rather than only in test:meter because the burst is easy to gate and the
// CONTACT path is the one with two separate ways through it — the ram's own
// share, and the prey cull that ignores hp entirely.

resetEnemies(scene);
resetMarks();
const wasShare = CONFIG.strike.contactShare;
CONFIG.strike.contactShare = 1;                 // so the ram has damage to lose
const spared = spawnAt('shark', 0.2, -20);
const sparedHp = spared.hp;
armDash(1, { x: 1, y: 0 }, false);
playerPos.set(0, -20, 0);
let damaged = 0;
updateStrike(dt, scene, playerPos, stats, enemies, { onEnemyDamaged: () => { damaged++; } });
check('a mistimed ram takes nothing off the shark', spared.hp === sparedHp,
  `${spared.hp.toFixed(1)} of ${sparedHp.toFixed(1)}`);
check('...and files no damage against the strike', damaged === 0);
check('...but still shoves it', Math.abs(spared.knockX) > 0, `${spared.knockX.toFixed(1)} u/s`);
check('...and still paints it — a ram is a ram', isMarked(spared));
CONFIG.strike.contactShare = wasShare;

// The cull is the other half, and it is the one that would survive a
// damage-only gate: it kills outright rather than by hp, precisely so the
// difficulty ramp cannot scale a minnow out of reach.
resetEnemies(scene);
resetStrike();
const school = [];
for (let i = 0; i < 4; i++) school.push(spawnAt('fish', 0.2 + i * 0.05, -20));
armDash(1, { x: 1, y: 0 }, false);
let killed = 0;
updateStrike(dt, scene, playerPos, stats, enemies, { onEnemyKilled: () => { killed++; } });
check('a mistimed dash swims straight through a school', killed === 0,
  `${killed} of ${school.length} eaten`);
// ...and on the beat the same dash empties it, or the check above is passing
// because sardines are out of reach rather than because the gate works.
resetEnemies(scene);
resetStrike();
for (let i = 0; i < 4; i++) spawnAt('fish', 0.2 + i * 0.05, -20);
armDash(1, { x: 1, y: 0 }, true);
killed = 0;
updateStrike(dt, scene, playerPos, stats, enemies, { onEnemyKilled: () => { killed++; } });
check('...where an on-beat one eats it', killed > 0, `${killed} eaten`);

// ---------------------------------------------------------------------------
console.log(failures === 0 ? '\nAll strike-impact checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
