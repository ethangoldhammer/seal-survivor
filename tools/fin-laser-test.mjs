#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:finlaser
//
// The fin laser loadout: the roll, the two gun cards that fork on it, the reach
// ramp, and — the reason this file exists at all — the BOUND on Lattice
// Sealant.
//
// WHY THE BOUND IS THE POINT. Every knob in CONFIG.finLaser.lattice looks
// individually reasonable, and their product does not: children^generations at
// four wide and three deep is 64 bolts off one pellet, several times a second.
// Three independent guards hold it down (see the header of
// systems/finLaser.js), and the failure mode of all three is the same — nothing
// throws, nothing looks wrong in the file, and the frame rate falls off a cliff
// in a fight nobody can reproduce on demand. So this asserts the arithmetic
// rather than the look, and it asserts it against the budget the game actually
// ships with rather than against a number typed in here.
//
// WHY IT SEEDS `loadout` EXPLICITLY. Both forked cards read `s.loadout`, and a
// synthetic stat block has it defaulted to 'pebbles' — so a harness that
// replayed apply() the ordinary way would exercise the pebble branch twice and
// report green while the laser branch had never run. That is exactly the trap
// in [[upgrade-harness-hides-first-pick-branches]], and the fix is the same:
// build the block for the loadout under test and say so.
//
// No renderer and no GL: everything asserted here lives in path/src/loadout.js,
// which imports CONFIG and nothing else. The one thing that does need a scene —
// trySplit — is exercised with an INJECTED spawner, so what is being counted is
// the real branching rather than a re-implementation of it.
//
//   node --import ./tools/vite-loader.mjs tools/fin-laser-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { baseStats, applyLaserReach, INTEGER_STATS } from '../path/src/stats.js';
import {
  DEFAULT_LOADOUT, loadoutRoster, rollLoadout, isLaser,
  laserReachSteps, laserReachMul,
  childrenAt, latticeGenerations, latticePayload, latticeWorstCase,
  latticeLiveChildren, latticeHasRoom, acquireLatticeChild, releaseLatticeChild, resetLattice,
} from '../path/src/loadout.js';
import {
  trySplit, applyBoltLook, updateBoltGlow, boltGlowGain, boltTipOffset, LASER_ASSET,
} from '../path/src/systems/finLaser.js';
import { createVisual } from '../path/src/assets.js';
import { spawnProjectile, updateProjectiles, projectiles, resetProjectiles } from '../path/src/entities/projectiles.js';
import { bounds } from '../path/src/arena.js';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

const upgradeById = (id) => CONFIG.upgrades.find((u) => u.id === id);

/** A stat block for `loadout` with `picks` replayed onto it, in order. */
function blockFor(loadout, picks = []) {
  const s = baseStats(loadout);
  for (const id of picks) upgradeById(id)?.apply(s);
  return s;
}

// ---------------------------------------------------------------------------
console.log('\nTHE ROLL');
// ---------------------------------------------------------------------------
{
  const roster = loadoutRoster();
  check('the roster has both loadouts', roster.length >= 2,
    roster.map((r) => `${r.id}:${r.weight}`).join(' '));
  check('pebbles is still in it', roster.some((r) => r.id === DEFAULT_LOADOUT));
  check('the laser is in it', roster.some((r) => r.id === 'laser'));

  // A SEEDED ROLL, not a Monte Carlo one. The distribution is a property of the
  // weights and the arithmetic is three lines; sampling it would be a slow way
  // of testing Math.random, and a flake waiting to happen the first time
  // somebody retunes a weight. See [[seeded-rng-in-spawn-harnesses]].
  const at = (t) => rollLoadout(() => t);
  const first = roster[0].id;
  check('a roll at 0 takes the first entry', at(0.0) === first, at(0.0));
  check('a roll just under the boundary is still the first', at(0.49) === first, at(0.49));
  check('a roll past it crosses to the second', at(0.75) === roster[1].id, at(0.75));

  // An empty roster is the bad-merge case: it must land on a real loadout
  // rather than on undefined, which would present as a gun that fires nothing.
  const empty = loadoutRoster({});
  check('an empty roster falls back to pebbles rather than to nothing',
    empty.length === 1 && empty[0].id === DEFAULT_LOADOUT);

  check('isLaser only says yes to the laser',
    isLaser('laser') && !isLaser('pebbles') && !isLaser(undefined));
}

// ---------------------------------------------------------------------------
console.log('\nWHAT A LOADOUT SEEDS');
// ---------------------------------------------------------------------------
{
  const peb = baseStats('pebbles');
  const las = baseStats('laser');
  check('the block carries the loadout', peb.loadout === 'pebbles' && las.loadout === 'laser');
  check('a block built with no argument is the pebble gun', baseStats().loadout === DEFAULT_LOADOUT);

  // The one non-number in the block. Every consumer that walks the fields
  // guards on typeof, and this is the assertion that says so out loud — a
  // string that started being scaled would produce NaN in a stat nobody is
  // looking at.
  const strings = Object.entries(las).filter(([, v]) => typeof v === 'string').map(([k]) => k);
  check('the loadout is the only non-numeric field', strings.length === 1 && strings[0] === 'loadout',
    strings.join(', '));

  check('the two blocks are otherwise identical',
    Object.keys(peb).every((k) => k === 'loadout' || peb[k] === las[k]));

  check('the lattice counts are integer stats',
    INTEGER_STATS.has('latticeAmount') && INTEGER_STATS.has('andreStacks'));
}

// ---------------------------------------------------------------------------
console.log('\nPOCKET FULL OF STONES — bolts, then splits');
// ---------------------------------------------------------------------------
{
  const boltStacks = CONFIG.finLaser.latticeBoltStacks ?? 1;
  const basePellets = baseStats('laser').multishot;

  // On pebbles it is the card it has always been, at every stack.
  const peb = blockFor('pebbles', Array(4).fill('multishot'));
  check('on pebbles every stack still buys a pellet',
    peb.multishot === basePellets + 4 && (peb.latticeAmount ?? 0) === 0,
    `multishot ${peb.multishot}, lattice ${peb.latticeAmount ?? 0}`);

  // On the laser the first stack still hands over a bolt — the card has to read
  // as the card the player knows the first time it is offered.
  const one = blockFor('laser', ['multishot']);
  check('on the laser the first stack still buys a bolt',
    one.multishot === basePellets + boltStacks && (one.latticeAmount ?? 0) === 0,
    `multishot ${one.multishot}, lattice ${one.latticeAmount ?? 0}`);

  // ...and the stacks after it convert, up to the width ceiling.
  const amountMax = CONFIG.finLaser.lattice.amountMax;
  const filled = blockFor('laser', Array(boltStacks + amountMax).fill('multishot'));
  check('the stacks after it buy splits',
    filled.multishot === basePellets + boltStacks && filled.latticeAmount === amountMax,
    `multishot ${filled.multishot}, lattice ${filled.latticeAmount}`);

  // ...AND THE ONE PAST THE CEILING GOES BACK TO BUYING BOLTS. Not nothing: a
  // pick the game keeps offering that pays nothing is a dead card, and this is
  // the assertion that stops the width cap turning Pocket Full of Stones into
  // one on a laser run.
  const over = blockFor('laser', Array(boltStacks + amountMax + 2).fill('multishot'));
  check('a stack past the width ceiling goes back to buying bolts',
    over.latticeAmount === amountMax && over.multishot === basePellets + boltStacks + 2,
    `multishot ${over.multishot}, lattice ${over.latticeAmount}`);

  check('the stack COUNT is the same on both loadouts',
    blockFor('laser', Array(4).fill('multishot')).multishotLevel === peb.multishotLevel
      && peb.multishotLevel === 4,
    `${peb.multishotLevel}`);
}

// ---------------------------------------------------------------------------
console.log('\nANDRÉ 3000 — alternating pierce and spread');
// ---------------------------------------------------------------------------
{
  const card = upgradeById('projectileLife');
  check('the card is enabled', card?.enabled !== false);
  check('it is still a gun card', card?.family === 'gun');

  // On pebbles it is unchanged: lifespan, and nothing else.
  const peb = blockFor('pebbles', Array(4).fill('projectileLife'));
  check('on pebbles it is still lifespan and only lifespan',
    Math.abs(peb.projectileLifeMul - 1.25 ** 4) < 1e-9
      && peb.pierce === baseStats().pierce && peb.finSpreadMul === 1,
    `lifeMul ${peb.projectileLifeMul.toFixed(3)}`);

  // On the laser the parity decides, and the two halves must not bleed into
  // each other — an odd stack that also widened the fan would be the card
  // paying twice, which is the bug the alternation exists to avoid.
  const basePierce = baseStats().pierce;
  const seq = [];
  for (let n = 1; n <= 4; n++) {
    const s = blockFor('laser', Array(n).fill('projectileLife'));
    seq.push({ n, pierce: s.pierce - basePierce, spread: s.finSpreadMul });
  }
  check('stack 1 buys pierce and no spread',
    seq[0].pierce === 1 && seq[0].spread === 1, JSON.stringify(seq[0]));
  check('stack 2 buys spread and no more pierce',
    seq[1].pierce === 1 && seq[1].spread > 1, JSON.stringify(seq[1]));
  check('stack 3 buys pierce again',
    seq[2].pierce === 2 && seq[2].spread === seq[1].spread, JSON.stringify(seq[2]));
  check('stack 4 buys spread again',
    seq[3].pierce === 2 && seq[3].spread > seq[1].spread, JSON.stringify(seq[3]));
  check('lifespan is untouched on the laser', seq.every(() => true)
    && blockFor('laser', ['projectileLife']).projectileLifeMul === 1);
}

// ---------------------------------------------------------------------------
console.log('\nTHE REACH RAMP');
// ---------------------------------------------------------------------------
{
  const per = CONFIG.finLaser.reachPerGunStacks;
  const max = CONFIG.finLaser.reachStepsMax;
  const gunIds = CONFIG.upgrades.filter((u) => u.family === 'gun').map((u) => u.id);
  check('there are gun cards to count', gunIds.length > 0, `${gunIds.length}`);

  const picks = (n) => Array.from({ length: n }, (_, i) => ({ id: gunIds[i % gunIds.length] }));

  // THE GATE. This is the assertion that would have caught a ramp wired to the
  // stacks alone — which reads perfectly well in the file and hands a fresh run
  // the whole payout for free.
  check('no reach before a boss is down, however many stacks',
    laserReachSteps(picks(per * max * 2), 0) === 0);
  check('one boss pays out every step already earned',
    laserReachSteps(picks(per * 3), 1) === 3, `${laserReachSteps(picks(per * 3), 1)}`);
  check('a step short of the next one does not round up',
    laserReachSteps(picks(per * 3 - 1), 1) === 2);
  check('the cap holds', laserReachSteps(picks(per * (max + 5)), 9) === max);

  // A pick nothing recognises must not count as a gun card.
  check('an unknown pick counts for nothing',
    laserReachSteps(Array(per * 2).fill({ id: 'notAnUpgrade' }), 1) === 0);
  // ...and neither does a card from another family.
  const util = CONFIG.upgrades.find((u) => u.family === 'utility');
  check('a card from another family counts for nothing',
    laserReachSteps(Array(per * 2).fill({ id: util.id }), 1) === 0, util.id);

  // It reaches `life` and only `life` — see the note on applyLaserReach for why
  // lengthening the flight is the honest half of range x speed.
  const before = baseStats('laser');
  const after = applyLaserReach(baseStats('laser'), 2);
  check('the ramp doubles the flight time', Math.abs(after.life - before.life * 2) < 1e-9,
    `${before.life} → ${after.life}`);
  check('...and moves nothing else',
    Object.keys(before).every((k) => k === 'life' || before[k] === after[k]));
  const peb = applyLaserReach(baseStats('pebbles'), 2);
  check('a pebble run is untouched by it', peb.life === baseStats('pebbles').life);
  check('a run that earned no steps is untouched',
    applyLaserReach(baseStats('laser'), laserReachMul([], 0)).life === before.life);
}

// ---------------------------------------------------------------------------
console.log('\nLATTICE SEALANT — the shape');
// ---------------------------------------------------------------------------
{
  const l = CONFIG.finLaser.lattice;

  check('the first split is the configured width', childrenAt(0, 0) === l.children,
    `${childrenAt(0, 0)}`);
  check('each generation is narrower than the last',
    childrenAt(1, 2) < childrenAt(0, 2), `${childrenAt(0, 2)} → ${childrenAt(1, 2)}`);
  // Floored at 1 rather than at 0: a split that produced nothing would still
  // fire the sound and the flash and then delete the shot.
  check('it never thins to nothing', childrenAt(50, 0) >= 1, `${childrenAt(50, 0)}`);
  check('Pocket Full of Stones widens it', childrenAt(0, 1) === childrenAt(0, 0) + 1);
  // ...UP TO THE CEILING, and asked of childrenAt directly rather than through
  // the card, because this is the clamp that actually holds the bound — see the
  // note there about the other routes into `latticeAmount`.
  check('...but only up to the width ceiling',
    childrenAt(0, 999) === childrenAt(0, l.amountMax),
    `${childrenAt(0, 999)} at any amount, ceiling ${l.amountMax}`);

  check('depth starts at the base', latticeGenerations(0) === l.generationsBase);
  check('pierce buys depth slowly',
    latticeGenerations(l.pierceStacksPerGeneration) === l.generationsBase + 1);
  check('...and the cap holds', latticeGenerations(999) === l.generationsMax);

  const pay = latticePayload(baseStats('laser'));
  check('a fresh bolt carries a payload', !!pay && pay.generation === 0, JSON.stringify(pay));
}

// ---------------------------------------------------------------------------
console.log('\nLATTICE SEALANT — the bound');
// ---------------------------------------------------------------------------
{
  const l = CONFIG.finLaser.lattice;

  // THE ASSERTION THIS FILE IS FOR. The worst case is every roll succeeding all
  // the way down, at the widest a run can buy — and it has to fit under the
  // budget, or the budget is the only guard actually holding and the shatter
  // silently starts refusing itself mid-fight.
  //
  // "The widest a run can buy" is `amountMax` and NOT Pocket Full of Stones'
  // maxStacks, and the difference is the whole reason the cap exists: the card
  // ships with `maxStacks: 99` in upgrades.csv, so deriving the width from the
  // card puts the worst case at 980,200 shards and leaves the live budget as
  // the only guard holding. This assertion is what said so.
  //
  // Asked of childrenAt with a deliberately over-large amount, so it is testing
  // the clamp rather than trusting it — a ceiling enforced only in the card's
  // apply() would leak through any other route into `latticeAmount`.
  const maxAmount = (CONFIG.finLaser.lattice.amountMax ?? 0) + 50;
  const worst = latticeWorstCase(maxAmount, l.generationsMax);
  check('the worst case fits under the live budget', worst <= l.budget,
    `${worst} shards at ${childrenAt(0, maxAmount)} wide × ${l.generationsMax} deep, budget ${l.budget}`);

  // ...and it is bounded at all, which is the thing the thinning buys. Without
  // the decay this is children^generations and the number below explodes.
  const undecayed = (childrenAt(0, maxAmount)) ** l.generationsMax;
  check('the thinning is what bounds it', worst < undecayed,
    `${worst} against ${undecayed} with no decay`);

  // A shard is worth less than what made it, on every axis, or a deep shatter
  // is a second gun rather than a fading one.
  check('a shard is weaker, slower, shorter-lived and smaller than its parent',
    l.childDamageMul < 1 && l.childSpeedMul < 1 && l.childLifeMul < 1 && l.childSizeMul < 1);
}

// ---------------------------------------------------------------------------
console.log('\nLATTICE SEALANT — splitting for real');
// ---------------------------------------------------------------------------
{
  resetLattice();

  // A stand-in bolt, shaped exactly the way combat.js hands one over.
  const bolt = (over = {}) => ({
    mesh: { position: new THREE.Vector3(1, 2, 0), scale: { x: 1 } },
    dir: new THREE.Vector2(1, 0),
    damage: 10, speed: 40, life: 0.7, radius: 0.18,
    finElement: 'shock', finSide: 'left',
    hits: new Set(['the fish it just hit']),
    lattice: latticePayload({ ...baseStats('laser'), ...over }),
    ...over.bolt,
  });

  // The injected spawner: records what WOULD be fired, and hands back an object
  // shaped like a projectile so trySplit's own bookkeeping runs for real.
  const fired = [];
  const spawn = (scene, opts) => {
    fired.push(opts);
    return { ...opts, mesh: null, hits: new Set(), hitLock: 0 };
  };

  const always = () => 0;   // every roll succeeds
  const never = () => 1;    // every roll fails

  fired.length = 0;
  const b1 = bolt();
  check('a failed roll does not split', trySplit(null, b1, null, spawn, never) === false
    && fired.length === 0);

  fired.length = 0;
  check('a successful roll splits', trySplit(null, b1, { x: 5, y: 6 }, spawn, always) === true);
  check('...into the configured number of shards', fired.length === childrenAt(0, 0),
    `${fired.length}`);
  check('...from the contact point, not the bolt',
    fired.every((f) => f.origin.x === 5 && f.origin.y === 6));
  check('...carrying the fin\'s element down with them',
    fired.every((f) => f.finElement === 'shock' && f.finSide === 'left'));
  check('...still booked to the gun', fired.every((f) => f.source === 'gun'));
  check('...weaker and shorter-lived than the parent',
    fired.every((f) => f.damage < b1.damage && f.life < b1.life));
  check('...fanned about the parent\'s own heading',
    fired.every((f) => f.dir.x > 0), fired.map((f) => f.dir.x.toFixed(2)).join(' '));
  check('...one generation deeper', fired.every((f) => f.lattice.generation === 1));

  // A projectile with no payload — every other shot in the game — must fall
  // straight through, untouched.
  check('a shot carrying no lattice is refused before anything else',
    trySplit(null, { lattice: null }, null, spawn, always) === false);

  // THE DEPTH LIMIT, exercised through the real call rather than through the
  // arithmetic: a shard at the limit must not split again however the roll goes.
  const spent = bolt();
  spent.lattice = { ...spent.lattice, generation: spent.lattice.generations };
  fired.length = 0;
  check('a shard at the generation limit cannot split again',
    trySplit(null, spent, null, spawn, always) === false && fired.length === 0);

  // THE BUDGET, exercised the same way. Filled to one short of the cap, a split
  // wider than the gap is refused WHOLE — not trimmed to what fits.
  resetLattice();
  const budget = CONFIG.finLaser.lattice.budget;
  for (let i = 0; i < budget - 1; i++) acquireLatticeChild();
  check('the counter tracks what has been taken', latticeLiveChildren() === budget - 1);
  check('there is no room for a full split', !latticeHasRoom(childrenAt(0, 0)));
  fired.length = 0;
  check('a split that would cross the budget is refused whole',
    trySplit(null, bolt(), null, spawn, always) === false && fired.length === 0);

  // ...and the slots come back. This is the leak that would present as the
  // shatter quietly switching itself off partway through a run.
  releaseLatticeChild({ latticeChild: true });
  check('releasing gives a slot back', latticeLiveChildren() === budget - 2);
  releaseLatticeChild({ latticeChild: false });
  check('releasing an ordinary shot is a no-op', latticeLiveChildren() === budget - 2);
  resetLattice();
  check('the reset zeroes it', latticeLiveChildren() === 0);
}

// ---------------------------------------------------------------------------
console.log('\nTHE VOLLEY LOOP — a shadowed loop binding');
// ---------------------------------------------------------------------------
//
// A SOURCE CHECK, and the only one in this file, because the bug it is for
// cannot be reached from Node and is invisible to everything else we run.
//
// WHAT HAPPENED. spawnProjectile grew a return value so the laser could dress
// the bolt it had just fired, and the handle was named `shot` — inside
// `for (const shot of salvo)`. A `const` in the loop BODY puts that name in the
// temporal dead zone for the whole body, so `(i - (shot.n - 1) / 2)` on the
// line above it threw ReferenceError on the first pellet of every volley, on
// BOTH loadouts. The seal fired nothing at all.
//
// WHY NOTHING CAUGHT IT. It is legal JavaScript, so `vite build` is clean and
// `node --check` is clean. It only throws when the line runs, and the line runs
// inside the rAF loop — which the browser preview suspends (see
// [[browser-pane-suspends-raf]]), so even loading the built game would not have
// shown it. And the smoke test that "proved" the laser worked called
// spawnProjectile directly and never went near fire(), which is exactly the
// trap in [[harness-tests-bypass-the-asset-pipeline]]: the harness built its
// subject by hand and so agreed with a caller that was dead.
//
// So: read the source. Narrow on purpose — one function, one rule — because a
// general shadowing lint is a project and this is the specific mistake that
// shipped a gun that could not fire.
{
  const src = await readFile(new URL('../path/src/main.js', import.meta.url), 'utf8');
  const at = src.indexOf('\nfunction fire() {');
  check('fire() is still where the check expects it', at >= 0);

  if (at >= 0) {
    // Brace-match to the end of the function, so this reads fire() and not
    // whatever follows it.
    let depth = 0, end = at;
    for (let i = src.indexOf('{', at); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { end = i; break; }
    }
    const body = src.slice(at, end);

    const loopVars = [...body.matchAll(/for\s*\(\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s+of\s/g)]
      .map((m) => m[1]);
    check('the volley loop still binds a name this can check', loopVars.length > 0,
      loopVars.join(', '));

    const shadowed = loopVars.filter((v) =>
      new RegExp(`(?:const|let)\\s+${v}\\s*=`).test(body));
    check('nothing in fire() redeclares a name its own for...of loop binds',
      shadowed.length === 0,
      shadowed.length
        ? `${shadowed.join(', ')} — the reads above the declaration are in the temporal dead zone and throw`
        : `${loopVars.length} loop binding(s) clear`);
  }
}

// ---------------------------------------------------------------------------
// THE FLASH ON WHAT A BOLT HITS — systems/burnGlow.js `zap`.
// ---------------------------------------------------------------------------
// A laser is light, so the thing it lands on going momentarily hot IS the hit.
// `e.flash`, which every pellet in the game already sets, is a SCALE pop and
// touches brightness not at all — so combat.js gates a second, brighter channel
// on this weapon alone.
//
// The gate it uses is `b.asset`, and that is the join worth failing over: it is
// one string agreed between two files, matching nothing else in the game, and
// if the bolt ever stops carrying it the flash stops happening with nothing
// thrown and nothing on screen to say so — the same shape of silent break as
// [[paired-reaches-must-measure-alike]]. Read from the source rather than
// asserted against a literal here, because a copy of the string in this file
// would go stale in exactly the same way.
{
  const combat = await readFile(new URL('../path/src/systems/combat.js', import.meta.url), 'utf8');
  check('combat.js flashes what a laser bolt hits',
    /\bzap\(/.test(combat) && /b\.asset === LASER_ASSET/.test(combat),
    'the bolt half of the beam glow');
  // THROUGH THE SHARED CONSTANT, not a copy of its value. A literal here would
  // survive finLaser.js renaming the asset and quietly stop matching any bolt.
  check('...gated on finLaser.js’s own constant',
    /import\s*\{[^}]*\bLASER_ASSET\b[^}]*\}\s*from\s*'\.\/finLaser\.js'/.test(combat));

  const laser = await readFile(new URL('../path/src/systems/finLaser.js', import.meta.url), 'utf8');
  check('...and a bolt is still stamped with it when it is fired',
    /asset:\s*LASER_ASSET/.test(laser));

  // AND THE BEAM HALF, which is the same feature pointed at the other shape of
  // laser: a held beam sears rather than flashing, because forty flashes over
  // four seconds is a strobe. Both weapons go through burnGlow, so a body being
  // shot and beamed at once is one set of instanced materials.
  const beams = await readFile(new URL('../path/src/systems/beams.js', import.meta.url), 'utf8');
  check('a beam sears the bodies it cuts', /\bsear\(e\)/.test(beams));
  check('...and lets go on the frame they die', /releaseBurn\(e\)/.test(beams),
    'the kill light takes the same per-instance materials over on that frame');
}


// ---------------------------------------------------------------------------
console.log('\nTHE HALO — where it sits');
// ---------------------------------------------------------------------------
// A point of light at the NOSE, not a glow around the middle. The offset is
// measured off the body rather than typed, and this is the check that the
// measurement is the body's and not something else's: it builds the bolt with
// the game's own createVisual — not a sphere assembled here, which is exactly
// the trap in [[harness-tests-bypass-the-asset-pipeline]] — dresses it, and
// asks where the nose came out.
//
// THE OFFSET IS IN PRE-SCALE UNITS, and that is the property worth failing
// over. `look.length` is a scale on the root, so a tip written in world units
// would drift off the end the moment the slider moved. Dressing the same bolt
// at two very different lengths has to give the SAME local offset, and the same
// offset once the scale is applied has to still be the nose.
{
  const lk = CONFIG.finLaser?.look ?? {};
  const was = lk.length;

  const bolt = (length) => {
    lk.length = length;
    const mesh = createVisual(LASER_ASSET);
    const p = { mesh, life: 1, asset: LASER_ASSET };
    applyBoltLook(p, null);
    return { mesh, offset: boltTipOffset(mesh) };
  };

  const short = bolt(1);
  const long = bolt(6);
  check('the nose is a local offset, not a world one',
    Math.abs(short.offset - long.offset) < 1e-6,
    `${short.offset.toFixed(4)} at length 1 vs ${long.offset.toFixed(4)} at length 6`);
  check('...and it is in front of the middle', short.offset > 0,
    short.offset.toFixed(4));

  // AND IT IS ACTUALLY THE END OF THE BODY. Ridden out by the root's own scale,
  // the offset has to land on the far edge of what the bolt draws — a number
  // that is merely positive would pass the two checks above while sitting a
  // third of the way along.
  for (const [name, b] of [['short', short], ['long', long]]) {
    const world = new THREE.Box3().setFromObject(b.mesh);
    const nose = b.offset * b.mesh.scale.y;
    check(`the ${name} bolt's halo lands on its far end`,
      Math.abs(nose - world.max.y) < 1e-4,
      `${nose.toFixed(4)} vs a body ending at ${world.max.y.toFixed(4)}`);
  }

  lk.length = was;
}

// ---------------------------------------------------------------------------
console.log('\nTHE HALO — the charge');
// ---------------------------------------------------------------------------
// It rides up over the flight and is snuffed at the end of it. Asserted as a
// SHAPE rather than as numbers: every value in CONFIG.finLaser.look.ramp is an
// eye judgement and allowed to move, so what is nailed down is that it still
// starts low, peaks where the config says, and ends low.
{
  // AGAINST A RAMP WRITTEN DOWN HERE, not against the shipped one, and the
  // difference is the whole reliability of this block. CONFIG.finLaser.look is
  // F-menu tuning: it arrives merged with whatever is in imported-tuning.json,
  // which is Ethan's live taste and changes while he plays. A `from` he drags
  // to 0.8 because he wants the bolt lit most of the way is not a regression,
  // and a suite that goes red over it is a suite that teaches --no-verify. So
  // the numbers under test are this file's, and what is asserted is the shape
  // boltGlowGain owes any config it is handed.
  const FIXED = { from: 0.25, to: 0.1, peakAt: 0.55, rise: 'inExpo', fall: 'inExpo' };
  const at = (t) => boltGlowGain(t, FIXED);

  check('it starts dim', at(0) < 0.5, at(0).toFixed(3));
  check('it peaks in the middle of the flight', Math.abs(at(FIXED.peakAt) - 1) < 1e-6,
    `${at(FIXED.peakAt).toFixed(3)} at t=${FIXED.peakAt}`);
  check('it is dim again at the end', at(1) < 0.5, at(1).toFixed(3));

  // MONOTONIC EITHER SIDE OF THE PEAK, and this one is asserted over the LIVE
  // ramp as well as the fixed one — because it is not a taste question. A curve
  // that wobbles reads as a flicker whatever the numbers are, and the two legs
  // are separate expressions: an `out` curve dropped into `rise` by mistake
  // still rises, so what catches a swapped name is the peak below, not this.
  const monotone = (fn, peak) => {
    let rises = true; let falls = true;
    for (let i = 1; i <= 200; i++) {
      const a = (i - 1) / 200; const b = i / 200;
      if (b <= peak && fn(b) < fn(a) - 1e-9) rises = false;
      if (a >= peak && fn(b) > fn(a) + 1e-9) falls = false;
    }
    return { rises, falls };
  };
  const fixedShape = monotone(at, FIXED.peakAt);
  check('it only brightens on the way up', fixedShape.rises);
  check('it only dims on the way down', fixedShape.falls);

  // THE LIVE RAMP, held to only what must be true of any tuning of it: it tops
  // out at exactly the halo's own overdrive — the number the slider above it
  // shows — and it does not wobble getting there or away. Anything tighter is
  // this file having an opinion about how the game should look.
  const live = CONFIG.finLaser?.look?.ramp ?? {};
  const lp = Math.min(0.95, Math.max(0.05, live.peakAt ?? 0.55));
  const atLive = (t) => boltGlowGain(t, live);
  check('the shipped ramp still peaks at exactly the tuned overdrive',
    Math.abs(atLive(lp) - 1) < 1e-6, `${atLive(lp).toFixed(4)} at t=${lp}`);
  const liveShape = monotone(atLive, lp);
  check('...and does not wobble either side of it', liveShape.rises && liveShape.falls,
    `from ${atLive(0).toFixed(2)} to ${atLive(1).toFixed(2)}`);

  // OFF BOTH ENDS. `peakAt` is a slider in the F menu, and at 0 or 1 one leg is
  // a division by zero — a NaN gain rounds to a NaN step, which picks a NaN
  // overdrive, which renders as a black sprite: the halo silently deleted.
  for (const bad of [{ peakAt: 0 }, { peakAt: 1 }]) {
    const vals = [0, 0.5, 1].map((t) => boltGlowGain(t, { ...FIXED, ...bad }));
    check(`peakAt ${bad.peakAt} still gives real numbers`,
      vals.every((v) => Number.isFinite(v)), vals.map((v) => v.toFixed(2)).join(' '));
  }
}

// ---------------------------------------------------------------------------
console.log('\nTHE HALO — what the charge costs');
// ---------------------------------------------------------------------------
// The whole reason the brightness is quantised: it rides the shared material
// cache instead of a clone per bolt per frame. THIS IS THE CHECK THAT MATTERS —
// the look is a look, but a per-frame clone here is the churn documented at
// length in systems/projectileTrails.js, and it would not show up as anything
// but a frame rate.
//
// The halo cannot be BUILT headless (glowSprite paints into a 2D canvas, which
// the dom-stub has none of), so the sprite is stood in for. What is being
// counted is updateBoltGlow's material bookkeeping, which is the part at risk.
{
  // THE 2D CANVAS, STOOD UP for the length of this block. The dom-stub returns
  // null from getContext (see [[dom-stub-has-no-2d-context]]), which is why the
  // halo cannot be built headless — and routing around glowMaterial to test the
  // bookkeeping would test a re-implementation of it. So the context is faked
  // and the real cache is exercised. Restored afterwards: leaving it up would
  // change what every check after this one is running against.
  const realCreate = document.createElement;
  const ctx2d = {
    createRadialGradient: () => ({ addColorStop() {} }),
    fillRect() {}, fillStyle: null,
  };
  document.createElement = (tag) => {
    const el = realCreate(tag);
    // Only the 2D context, and only here. Everything else the stub answers is
    // still the stub's — a wholesale fake canvas would be a second, quieter
    // dom-stub that the rest of the suite does not share.
    el.getContext = (kind) => (kind === '2d' ? ctx2d : null);
    return el;
  };

  const mats = new Set();
  const stub = () => {
    const holder = new THREE.Object3D();
    const sprite = new THREE.Object3D();
    sprite.name = 'finLaserGlow';
    sprite.material = null;
    holder.add(sprite);
    return holder;
  };

  const shots = [];
  for (let i = 0; i < 8; i++) {
    shots.push({ asset: LASER_ASSET, mesh: stub(), life: 1, boltLife: 1, glowStep: -1, finElement: null });
  }
  // Ten seconds of frames at 60, over eight bolts living one second each.
  let swaps = 0;
  for (let f = 0; f < 600; f++) {
    for (const p of shots) {
      p.life -= 1 / 60;
      if (p.life <= 0) p.life = 1;
    }
    const before = shots.map((p) => p.mesh.children[0].material);
    updateBoltGlow(shots);
    shots.forEach((p, i) => {
      const m = p.mesh.children[0].material;
      if (m) mats.add(m);
      if (m !== before[i]) swaps++;
    });
  }

  const steps = Math.round(CONFIG.finLaser?.look?.ramp?.steps ?? 12);
  check('the halo actually changes brightness', swaps > 100, `${swaps} swaps`);
  check('...out of a bounded set of materials', mats.size <= steps + 1,
    `${mats.size} distinct, ${steps} steps — a clone per bolt per frame would be ${swaps}`);

  // AND A BOLT WITH NO LAUNCH LIFE IS LEFT ALONE rather than dividing by zero.
  // Reachable from any spawn that skipped applyBoltLook, and the failure is a
  // NaN colour — a black sprite, which looks like the halo being deleted.
  const orphan = { asset: LASER_ASSET, mesh: stub(), life: 1, glowStep: -1 };
  updateBoltGlow([orphan]);
  check('a bolt with no launch life is left alone', orphan.mesh.children[0].material === null);

  document.createElement = realCreate;

  // AND WITH THE CANVAS GONE AGAIN the sweep must not take the frame down with
  // it. This is the guard in updateBoltGlow, and it is not hypothetical: every
  // headless harness that ever spawns a real bolt runs this loop.
  const after = { asset: LASER_ASSET, mesh: stub(), life: 1, boltLife: 1, glowStep: -1 };
  let threw = false;
  try { updateBoltGlow([after]); } catch { threw = true; }
  check('the sweep survives having no 2D canvas', !threw);
}


// ---------------------------------------------------------------------------
console.log('\nOUT OF THE WATER — light does not fall');
// ---------------------------------------------------------------------------
// Above the surface the sea is not holding a shot up any more, so every
// projectile in the game falls on the seal's own curve. That is the whole read
// of a thrown stone and it is exactly wrong for a bolt — and the sag is not
// merely a drop, because the fall goes out through `dir` and comes back as a
// heading (see updateProjectiles): the bolt TURNS to follow it, which is a beam
// of light bending downward on its way across the sky.
//
// MEASURED AGAINST A PEBBLE FIRED THE SAME WAY, not against zero, which is the
// [[measure-displacement-against-a-control-run]] point in a straight line: an
// assertion that the bolt "is roughly level" would pass just as well if
// CONFIG.arena.projectileGravity were retuned to nothing, and would then be
// certifying a setting rather than this exemption.
{
  resetProjectiles(new THREE.Group());
  const scene = new THREE.Group();
  const above = bounds.surfaceY + 6;

  const fire = (asset, extra) => spawnProjectile(scene, {
    origin: new THREE.Vector3(0, above, 0),
    dir: new THREE.Vector2(1, 0),
    faction: 'player',
    damage: 1, speed: 20, life: 5, radius: 0.2,
    asset, source: 'gun', ...extra,
  });

  const bolt = fire(LASER_ASSET, { orient: 'axis', gravityScale: 0 });
  const stone = fire('bullet', {});
  for (let f = 0; f < 30; f++) updateProjectiles(1 / 60, scene, []);

  const sagOf = (p) => above - p.mesh.position.y;
  const boltSag = sagOf(bolt);
  const stoneSag = sagOf(stone);
  check('a pebble still falls out of the water', stoneSag > 0.5,
    `${stoneSag.toFixed(2)} units in half a second`);
  check('a bolt does not', Math.abs(boltSag) < 1e-9,
    `${boltSag.toFixed(4)} against the pebble's ${stoneSag.toFixed(2)}`);
  // AND IT IS STILL AIMED WHERE IT WAS FIRED. The heading is the half that
  // reads as wrong on a 2.6:1 body — a bolt that dropped a little would be
  // arguable, one that is visibly nosing over is not.
  check('...and it has not nosed over', Math.abs(bolt.dir.y) < 1e-9,
    `dir.y ${bolt.dir.y.toFixed(6)} vs the pebble's ${stone.dir.y.toFixed(3)}`);

  resetProjectiles(scene);
}

console.log(failures ? `\nFAIL — ${failures} problem(s)` : '\nPASS — all checks');
process.exit(failures ? 1 : 0);
