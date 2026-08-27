#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:damagecards
//
// The three cards whose worth is decided OUTSIDE their apply(), which is
// exactly the ground `npm run test:upgrades` cannot cover. That harness
// replays apply() against a synthetic stat block and diffs it — and all three
// of these apply()s do one thing, `level += 1`, so it would sign off on a
// completely dead card:
//
//   MANEATER    is paid per human eaten, a running total the stat block is
//               rebuilt against (systems: main.js counts, player.js reseeds).
//   IRON LUNG   is paid per point of the oxygen the seal is HOLDING, which
//               moves every frame of a dive, and whose ceiling OTHER cards
//               move — so its value depends on the rest of the build, on where
//               in the breath you are, and NOT on the order the cards were
//               picked in.
//   SONAR TEETH is paid in target selection, inside the projectile loop.
//
// Sections 1-4 exercise stats.js directly. Section 5 drives the real
// updateProjectiles(), so the acquisition rule under test is the shipped code
// rather than a copy of it in this file — a transcribed rule is a test of the
// transcription.
//
// No renderer: three.js Object3D is plain data and nothing here draws. Same
// reason as tools/ability-smoke.mjs — the browser preview suspends
// requestAnimationFrame, so a screenshot of this game proves nothing about
// whether its loop works.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import {
  baseStats, applyLevelGrowth, applyDamageScaling, applyIronLung, maneaterMul, ironLungMul,
} from '../path/src/stats.js';
import { spawnProjectile, updateProjectiles, projectiles } from '../path/src/entities/projectiles.js';
import { markTarget, resetMarks } from '../path/src/systems/marks.js';

const U = (id) => CONFIG.upgrades.find((u) => u.id === id);
let fails = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${msg}`); if (!cond) fails++; };
const r3 = (n) => Math.round(n * 1000) / 1000;

// A stat block built the way entities/player.js recomputeStats() builds one.
// Kept in step with that function by hand, deliberately: importing player.js
// would drag in three.js, the animation controller and the aim rig, which is
// the same reason stats.js exists as its own module at all.
function run({ picks = [], level = 1, humansEaten = 0, oxygen } = {}) {
  const s = baseStats();
  for (const id of picks) U(id).apply(s);
  applyLevelGrowth(s, level);
  applyDamageScaling(s, humansEaten, oxygen);
  return s;
}

console.log('\n1. a run holding neither card is byte-for-byte what it always was');
{
  const bare = run();
  const fed = run({ humansEaten: 40 });
  ok(bare.damage === fed.damage && bare.strikeDamage === fed.strikeDamage,
    'eating 40 humans with no Maneater changes nothing');
  ok(bare.abilityDamageMul === 1 && bare.companionDamageMul === 1,
    'and the cross-cutting multipliers keep their identity value of 1');
}

console.log('\n2. MANEATER — per meal, per stack, clamped');
{
  const c = CONFIG.maneater;
  const base = run();

  const one = run({ picks: ['maneater'], humansEaten: 10 });
  ok(r3(one.damage / base.damage) === r3(1 + c.damagePerMeal * 10),
    `1 stack x 10 meals -> x${r3(1 + c.damagePerMeal * 10)}`);

  const three = run({ picks: ['maneater', 'maneater', 'maneater'], humansEaten: 10 });
  ok(r3(three.damage / base.damage) === r3(1 + c.damagePerMeal * 30),
    `3 stacks x 10 meals -> x${r3(1 + c.damagePerMeal * 30)} — stacks buy the RATE`);

  ok(run({ picks: ['maneater'], humansEaten: 0 }).damage === base.damage,
    'the card before its first meal is worth exactly nothing');

  // The ceiling is the only thing standing between this and an arbitrary
  // number: the boats never stop coming.
  const capped = run({ picks: ['maneater'], humansEaten: 1e5 });
  ok(r3(capped.damage / base.damage) === r3(1 + c.maxBonus),
    `and it clamps at +${c.maxBonus * 100}% however long the run goes`);

  ok(r3(capped.strikeDamage / base.strikeDamage) === r3(1 + c.maxBonus)
    && r3(capped.abilityDamageMul) === r3(1 + c.maxBonus)
    && r3(capped.companionDamageMul) === r3(1 + c.maxBonus),
    'reaching the dash, everything thrown and every escort by the same factor');
}

console.log('\n3. IRON LUNG — scales with the tank, and Deep Lungs feeds it');
{
  const c = CONFIG.ironLung;
  const base = run();
  const lung = run({ picks: ['ironLung'] });
  ok(r3(lung.damage / base.damage) === r3(1 + c.damagePerOxygen * CONFIG.oxygen.max),
    `1 stack on the starting ${CONFIG.oxygen.max} tank -> x${r3(1 + c.damagePerOxygen * CONFIG.oxygen.max)}`);

  const O = ['oxygenMax', 'oxygenMax', 'oxygenMax', 'oxygenMax', 'oxygenMax'];
  const deep = run({ picks: ['ironLung', ...O] });
  const deepBase = run({ picks: O });
  ok(r3(deep.damage / deepBase.damage) === r3(1 + c.damagePerOxygen * deep.maxOxygen),
    `the same stack on a ${deep.maxOxygen} tank is x${r3(1 + c.damagePerOxygen * deep.maxOxygen)}`);
  ok(deep.damage / deepBase.damage > lung.damage / base.damage,
    'so widening the lungs really is a damage upgrade — the advertised synergy is live');

  // THE REASON THIS IS NOT IN apply(). apply() runs in pick order, so an
  // Iron Lung taken first would have been measured against a tank that had not
  // grown yet, and the same two cards in the other order would be a different
  // run for reasons no player could see.
  ok(run({ picks: ['ironLung', 'oxygenMax'] }).damage === run({ picks: ['oxygenMax', 'ironLung'] }).damage,
    'and pick ORDER cannot change what the pair is worth');
}

console.log('\n3b. IRON LUNG — and it drains with the bar');
{
  const c = CONFIG.ironLung;
  const base = run();
  const full = run({ picks: ['ironLung'] });
  const half = run({ picks: ['ironLung'], oxygen: CONFIG.oxygen.max / 2 });
  const empty = run({ picks: ['ironLung'], oxygen: 0 });

  ok(r3(half.damage / base.damage) === r3(1 + c.damagePerOxygen * CONFIG.oxygen.max / 2),
    'half a breath is worth half the bonus');
  ok(empty.damage === base.damage,
    'and a drowning seal is worth exactly what one without the card is');
  ok(full.damage > half.damage && half.damage > empty.damage,
    'so the bonus falls monotonically over a dive');
  ok(empty.strikeDamage === base.strikeDamage && empty.abilityDamageMul === base.abilityDamageMul
    && empty.companionDamageMul === base.companionDamageMul,
    'the dash, everything thrown and every escort all drain with it');

  // A NEGATIVE BAR AND AN OVERFILLED ONE. Neither should be reachable, and the
  // clamp is here because "should not be reachable" has never once held: the
  // surface refill adds before it clamps, and the drowning tick subtracts.
  ok(run({ picks: ['ironLung'], oxygen: -50 }).damage === base.damage,
    'a negative bar cannot make the card a PENALTY');
  ok(run({ picks: ['ironLung'], oxygen: CONFIG.oxygen.max * 10 }).damage === full.damage,
    'and an overfilled one is worth no more than a full breath');

  // THE BUG THIS WHOLE ARRANGEMENT EXISTS TO PREVENT. applyIronLung runs once
  // a frame, so if it multiplied the LIVE stat instead of re-deriving from the
  // stash it would compound sixty times a second — a seal that idled at the
  // surface for one second would be at the cap and would never come down.
  const live = run({ picks: ['ironLung'] });
  for (let i = 0; i < 300; i++) applyIronLung(live, CONFIG.oxygen.max);
  ok(live.damage === full.damage, '300 frames at a full tank is worth one frame — no compounding');
  applyIronLung(live, 0);
  ok(live.damage === base.damage, '...and it comes all the way back down when the air runs out');
  applyIronLung(live, CONFIG.oxygen.max);
  ok(live.damage === full.damage, '...and back up on the next breath, to the same number');

  // The tank is still the ceiling, so Deep Lungs is still the pairing — but on
  // a HALF-EMPTY bar, not just a notionally bigger one.
  const O = ['oxygenMax', 'oxygenMax', 'oxygenMax', 'oxygenMax', 'oxygenMax'];
  const deepHalf = run({ picks: ['ironLung', ...O], oxygen: CONFIG.oxygen.max / 2 });
  const deepHalfBase = run({ picks: O, oxygen: CONFIG.oxygen.max / 2 });
  ok(r3(deepHalf.damage / deepHalfBase.damage) === r3(half.damage / base.damage),
    'the same points of air are worth the same whatever the tank holds them');
  ok(run({ picks: ['ironLung', ...O], oxygen: run({ picks: O }).maxOxygen }).damage
     / run({ picks: O }).damage > full.damage / base.damage,
    'and a FULL bigger tank still beats a full small one — the synergy is the seconds it buys');
}

console.log('\n4. the two multiply, and touch nothing but damage');
{
  const base = run();
  const both = run({ picks: ['maneater', 'ironLung'], humansEaten: 25 });
  const expect = maneaterMul({ maneaterLevel: 1 }, 25)
    * ironLungMul({ ironLungLevel: 1, maxOxygen: CONFIG.oxygen.max });
  ok(r3(both.damage / base.damage) === r3(expect), `Maneater x Iron Lung -> x${r3(expect)}`);
  ok(both.maxHp === base.maxHp && both.maxSpeed === base.maxSpeed
    && both.fireRate === base.fireRate && both.maxOxygen === base.maxOxygen,
    'HP, speed, cadence and the tank itself are untouched');
}

console.log('\n5. SONAR TEETH — acquisition, through the real projectile loop');
{
  const c = CONFIG.homingShot;
  const scene = new THREE.Scene();
  const enemy = (name, x, y, radius) => {
    const mesh = new THREE.Mesh();
    mesh.position.set(x, y, 0);
    scene.add(mesh);
    return { name, type: name, mesh, radius, hp: 999 };
  };
  // The same object main.js's homingShotOpts() spreads into the spawn.
  const seek = (level = 1) => ({
    homing: true,
    orient: true,
    turnRate: c.turnRate + c.turnRatePerLevel * (level - 1),
    acquireRadius: c.acquireRadius + c.acquireRadiusPerLevel * (level - 1),
    homingDelay: c.homingDelay,
    sizeBias: c.sizeBias + c.sizeBiasPerLevel * (level - 1),
    sizeRefRadius: c.refRadius,
  });
  const shoot = (opts = {}) => {
    projectiles.length = 0;
    spawnProjectile(scene, {
      origin: new THREE.Vector3(0, 0, 0),
      dir: new THREE.Vector2(1, 0),
      faction: 'player', damage: 1, speed: 20, life: 5, radius: 0.1, asset: 'bullet',
      ...opts,
    });
    return projectiles[0];
  };
  // Two short frames: the first burns homingDelay, the second acquires.
  const acquire = (list, opts) => {
    const p = shoot(opts);
    updateProjectiles(0.05, scene, list, [], {});
    updateProjectiles(0.016, scene, list, [], {});
    return p.target?.name ?? null;
  };

  const fish = enemy('fish', 4, 0, 0.4);
  const shark = enemy('shark', 6, 0, 1.2);
  ok(acquire([fish, shark], seek(1)) === 'shark',
    'a shark 50% further out beats the fish directly in front of the muzzle');
  ok(acquire([fish, shark], { ...seek(1), sizeBias: 0 }) === 'fish',
    'and at sizeBias 0 the same pair picks the fish — the bias IS the card');

  ok(acquire([enemy('fish', 3, 0, 0.4), enemy('shark', 9.5, 0, 1.2)], seek(1)) === 'fish',
    'a shark far enough out still loses: size leans the choice, it does not decide it');

  ok(acquire([enemy('fish', 40, 0, 0.4)], seek(1)) === null,
    'nothing inside the acquire radius means no target and no crash');

  // The regression that matters most: every other seeker in the game passes no
  // sizeBias at all and must behave exactly as it did before this card existed.
  {
    const p = shoot();
    updateProjectiles(0.1, scene, [enemy('fish', 3, 2, 0.4)], [], {});
    ok(p.target === null && Math.abs(p.dir.y) < 1e-9,
      'an un-upgraded bullet flies dead straight and acquires nothing');
  }

  // Picking a target is not the same as reaching it.
  {
    const target = enemy('shark', 7, 5, 1.2);
    const p = shoot({ ...seek(1), speed: 8 });
    let closest = Infinity;
    for (let i = 0; i < 120 && projectiles.length; i++) {
      updateProjectiles(1 / 60, scene, [target], [], {});
      closest = Math.min(closest, p.mesh.position.distanceTo(target.mesh.position));
    }
    ok(closest < 1, `and the pellet curves onto it — closest approach ${r3(closest)}`);
  }

  // A maxed pellet must stay a bullet. Past the mussel's turn rate it stops
  // being a shot that can miss, which is the whole counterplay (see the note
  // on steerToward in entities/projectiles.js).
  const maxTurn = c.turnRate + c.turnRatePerLevel * (U('homingShot').maxStacks - 1);
  ok(maxTurn < CONFIG.missile.turnRate,
    `a fully stacked pellet still turns slower than a guided mussel (${r3(maxTurn)} < ${CONFIG.missile.turnRate})`);

  // -------------------------------------------------------------------------
  // THE RULE: NEVER A TURTLE AND NEVER A WHALE.
  //
  // Asserted against a body sitting where a seeker would otherwise be certain
  // to take it — directly in front of the muzzle, nearer than anything else on
  // the board — because "it did not pick the turtle" is worthless if nothing
  // in the arrangement ever offered it one.
  //
  // A sea turtle is a WALL: an hp of a billion in enemies.csv, and the boss's
  // `turtles` perk parks a screen of them between the player and the fight. A
  // seeker with no rule empties every volley into it for as long as the screen
  // is up. The def's `invincible` flag and the named list are both live rules
  // and both are checked, because they cover each other: an unnamed invincible
  // creature added later, and a named one that is merely worthless.
  // -------------------------------------------------------------------------
  {
    const turtle = enemy('seaTurtle', 2, 0, 1);
    const fish = enemy('fish', 8, 0, 0.4);
    ok(acquire([turtle, fish], seek(1)) === 'fish',
      'a sea turtle four times nearer than the fish is not chased — the fish is');
    ok(acquire([turtle], seek(1)) === null,
      'and a turtle alone leaves the shot flying straight rather than curving into a wall');

    // The named rule and the general one, separately. `invincible` is set on
    // the live body by makeInvincible(); the list is matched on `type`.
    const scenery = { ...enemy('lorem', 2, 0, 1), invincible: true };
    ok(acquire([scenery, fish], seek(1)) === 'fish',
      'anything invincible is refused by the general rule, named or not');
    const whale = enemy('whale', 2, 0, 3);
    ok(acquire([whale, fish], seek(1)) === 'fish',
      'and a whale is refused by name, however big and however near');
  }

  // -------------------------------------------------------------------------
  // A PAINTED TARGET IS A TIER, NOT A LEAN.
  //
  // The distinction is the whole change, and only an arrangement the old
  // weighting would have LOST can tell them apart: the mark's own pull is
  // 0.45, so a marked body more than ~2.2x further out than an unmarked one
  // used to lose. That is the case below.
  // -------------------------------------------------------------------------
  {
    const near = enemy('fish', 1.5, 0, 0.4);
    const far = enemy('shark', 9, 0, 1.2);
    ok(acquire([near, far], { ...seek(1), sizeBias: 0 }) === 'fish',
      'unmarked, the near fish wins — the control for the pair below');
    markTarget(far);
    ok(acquire([near, far], { ...seek(1), sizeBias: 0 }) === 'shark',
      'painted, the shark six times further out wins outright');
    // ...and the reticle still does not extend the gun. A mark is which target
    // in reach, never how far a shot can see.
    //
    // The board is cleared FIRST. `markedTargets()` is walked whatever is in
    // the enemy list handed to the loop — that is how a marked hull is reached
    // — so a mark left over from the pair above would be picked up here and
    // the case would pass for the wrong reason.
    resetMarks();
    // The distance is DERIVED, not typed. A mark counts as `homingPull` of its
    // real distance, which is a tuned number — pinning 60 units here would
    // make this case pass or fail on a slider nobody touched for its sake.
    // sizeBias 0 so the size curve is out of the arithmetic as well.
    const pull = CONFIG.strike.mark.homingPull;
    const out = enemy('distant', (seek(1).acquireRadius / pull) * 1.5, 0, 1.2);
    markTarget(out);
    ok(acquire([out], { ...seek(1), sizeBias: 0 }) === null,
      'but a marked body outside the acquire radius is still out of reach');
    resetMarks();
  }
}

console.log('\n6. all three are dealable');
{
  for (const id of ['homingShot', 'maneater', 'ironLung']) {
    const u = U(id);
    ok(!!u && typeof u.apply === 'function' && u.enabled !== false && u.name && u.desc,
      `${id}: "${u?.name}", cap ${u?.maxStacks}`);
  }
}

console.log(fails ? `\nFAIL — ${fails} problem(s)\n` : '\nall good\n');
process.exit(fails ? 1 : 0);
