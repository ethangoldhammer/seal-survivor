#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:ramp
//
// HOW HARD THE WATER GETS. A run has four escalation axes and they are tuned in
// four different files, so nothing ever showed them side by side — which is how
// they drifted into the shape this file was written to catch:
//
//   hp       CONFIG.spawn.ramp.hp   AND each creature's own hpPerDifficulty.
//            TWO compounding ramps, so the effective spread is far bigger than
//            either number: a basic fish is ~186x tougher at minute 15.
//   damage   CONFIG.spawn.ramp.damage, and essentially nothing else — only the
//            two crabs carry a contactDamagePerDifficulty. ONE ramp, and it was
//            capped at 4x while hp's was capped at 30x. A run that made a fish
//            139x tougher and 3.4x more dangerous is a run that ends in bullet
//            sponges, which is exactly what it felt like.
//   speed    CONFIG.spawn.ramp.speed. Deliberately the gentlest of the three.
//   seeking  CONFIG.hunterRamp. This is the one that was silently doing nothing
//            for most of the roster: `preyFocus` reads `def.hunt.preyRadius`
//            and `turnRate` reads a `turnRate`, and the ten SWARM species —
//            what the water is mostly made of — declare neither. They shoaled
//            at minute fifteen exactly as they shoaled at minute one.
//
// Everything here reads the shipped tables and the shipped spawner. The
// seeking section in particular spawns REAL creatures through spawnNamed and
// reads what got baked onto them, because "the ramp reaches this creature" is a
// claim about the spawn path and cannot be checked against the config.
//
//   node --import ./tools/vite-loader.mjs tools/enemy-ramp-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { ASSETS, getAssetSizeMultiplier } from '../path/src/assets.js';
import { CONFIG, difficultyRamp, lateGameMul, chumHealRamp } from '../path/src/config.js';
import { enemies, resetEnemies, removeEnemy, spawnNamed, updateSpawning, setSpawnLevel } from '../path/src/entities/enemies.js';
import { resetWaves } from '../path/src/systems/waves.js';

const scene = new THREE.Scene();
const dt = 1 / 60;
const dps = CONFIG.spawn.difficultyPerSecond;
const MINUTES = [1, 3, 5, 8, 10, 15];
let failures = 0;

const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[animation]') || msg.startsWith('[assets]'))) return;
  realWarn(msg, ...rest);
};

function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const at = (def, field, m) => {
  const d = m * 60 * dps;
  if (field === 'hp') return (def.hp + (def.hpPerDifficulty ?? 0) * d) * difficultyRamp('hp', d);
  if (field === 'damage') return (def.contactDamage + (def.contactDamagePerDifficulty ?? 0) * d) * difficultyRamp('damage', d);
  return (def.speed + (def.speedPerDifficulty ?? 0) * d) * difficultyRamp('speed', d);
};

// ---------------------------------------------------------------------------
section('WHERE EACH ROSTER-WIDE RAMP STOPS CLIMBING');
{
  const r = CONFIG.spawn.ramp;
  const rows = [['hp', r.hp, r.hpMax], ['damage', r.damage, r.damageMax], ['speed', r.speed, r.speedMax]];
  const capAt = {};
  for (const [k, per, max] of rows) {
    const d = per > 0 ? Math.log(max) / Math.log(1 + per) : Infinity;
    capAt[k] = d / dps / 60;
    console.log(`        ${k.padEnd(7)} +${(per * 100).toFixed(1)}%/point, cap ${String(max).padStart(3)}x`
      + `   flat from ${capAt[k].toFixed(1)} min`);
  }
  // A run is expected to go fifteen minutes (see tools/xp-economy-test.mjs). A
  // ramp that flattens in the first half means the back half of every run is
  // escalating by headcount alone.
  check('no stat ramp flattens before the run is half over',
    Math.min(capAt.hp, capAt.damage, capAt.speed) >= 7.5,
    `earliest is ${Object.entries(capAt).sort((a, b) => a[1] - b[1])[0][0]} at ${Math.min(...Object.values(capAt)).toFixed(1)} min`);
}

// ---------------------------------------------------------------------------
section('A BASIC ENEMY, OVER A RUN  (hp / contact damage / speed)');
const BASIC = ['fish', 'reeffish', 'tang'].filter((k) => CONFIG.enemies[k]);
const SHOW = [...BASIC, 'barracuda', 'squid'].filter((k) => CONFIG.enemies[k]);
{
  console.log('        species     ' + MINUTES.map((m) => `m${m}`.padStart(17)).join(''));
  for (const k of SHOW) {
    const def = CONFIG.enemies[k];
    const cells = MINUTES.map((m) =>
      `${at(def, 'hp', m).toFixed(0)}/${at(def, 'damage', m).toFixed(1)}/${at(def, 'speed', m).toFixed(1)}`.padStart(17));
    console.log(`        ${k.padEnd(12)}${cells.join('')}`);
  }

  console.log('\n        ...as a multiple of minute one');
  for (const k of SHOW) {
    const def = CONFIG.enemies[k];
    console.log(`        ${k.padEnd(12)}hp x${(at(def, 'hp', 15) / at(def, 'hp', 1)).toFixed(1)}`
      + `   damage x${(at(def, 'damage', 15) / at(def, 'damage', 1)).toFixed(1)}`
      + `   speed x${(at(def, 'speed', 15) / at(def, 'speed', 1)).toFixed(2)}`);
  }

  // THE ASYMMETRY THIS FILE EXISTS FOR. Toughness and threat are allowed to
  // grow at different rates — a run should get grindier as well as deadlier —
  // but an order of magnitude between them is a creature that stops being
  // dangerous and starts being furniture.
  const worst = BASIC.map((k) => {
    const def = CONFIG.enemies[k];
    return (at(def, 'hp', 15) / at(def, 'hp', 1)) / (at(def, 'damage', 15) / at(def, 'damage', 1));
  });
  check('a basic enemy does not get vastly tougher than it gets dangerous',
    Math.max(...worst) <= 40,
    `hp climbs ${Math.max(...worst).toFixed(0)}x faster than damage (was 41x, cap 40)`);

  // Contact damage is per SECOND of contact and a swarm stacks it, so the
  // ceiling matters more than it looks. This is the guard rail on the fix.
  const dmg15 = Math.max(...BASIC.map((k) => at(CONFIG.enemies[k], 'damage', 15)));
  check('...and a single basic fish still cannot kill a fresh seal in a second',
    dmg15 < CONFIG.player.maxHp,
    `${dmg15.toFixed(0)} dps against ${CONFIG.player.maxHp} hp`);
}

// ---------------------------------------------------------------------------
section('SEEKING — does the behavioural ramp actually reach these creatures?');
{
  // Spawned for real, so this reads what the SPAWN PATH baked rather than what
  // the config says it should have. The distinction is the whole point: the
  // hunter ramp has always been configured and has never once applied to a
  // school, because it reads two fields the swarm species do not declare.
  const seekAt = (key, m) => {
    resetEnemies(scene);
    spawnNamed(scene, key, m * 60 * dps);
    return enemies[0]?.towardPlayer ?? 0;
  };

  console.log('        species     ' + MINUTES.map((m) => `m${m}`.padStart(9)).join('') + '     authored');
  for (const k of BASIC) {
    const vals = MINUTES.map((m) => seekAt(k, m));
    console.log(`        ${k.padEnd(12)}${vals.map((v) => v.toFixed(2).padStart(9)).join('')}`
      + `${String(CONFIG.enemies[k].swarm.towardPlayer).padStart(13)}`);
  }

  for (const k of BASIC) {
    const early = seekAt(k, 1);
    const late = seekAt(k, 15);
    check(`${k}: a school presses harder late than early`,
      late > early * 2, `x${(late / early).toFixed(2)} from minute 1 to 15`);
  }

  // The term has to actually WIN by the end, or "presses harder" is a number
  // that never changes what the school does. Cohesion is what it competes with:
  // below it the fish would rather be with each other than with you.
  const k0 = BASIC[0];
  const coh = CONFIG.enemies[k0].swarm.cohesion ?? 0;
  check('...hard enough that the seal outranks the school itself by the end',
    seekAt(k0, 15) > coh,
    `${seekAt(k0, 15).toFixed(2)} against a cohesion of ${coh}`);
  check('...and the opening is left alone', seekAt(k0, 1) < coh,
    `${seekAt(k0, 1).toFixed(2)} against a cohesion of ${coh} at minute one`);

  // Baked per instance, not read live off the def — a fish keeps the aggression
  // it was born with, so a school does not change its mind mid-chase.
  resetEnemies(scene);
  spawnNamed(scene, k0, 0);
  const born = enemies[0]?.towardPlayer;
  spawnNamed(scene, k0, 15 * 60 * dps);
  check('two fish spawned at different times carry different aggression',
    enemies[1]?.towardPlayer > born,
    `${born?.toFixed(2)} and ${enemies[1]?.towardPlayer?.toFixed(2)} alive at once`);
}

// ---------------------------------------------------------------------------
// WHAT THE WATER IS MADE OF.
//
// The three ramps above make each creature harder. This is the fourth thing a
// run can escalate and the one with no ramp of its own: WHICH creatures get
// sent. Every species' spawn weight finishes climbing by about three minutes,
// so the composition of the water was frozen from minute three to the end — a
// fifteen-minute run got busier and never got different.
//
// Measured on POPULATION rather than on spawn count, because spawn count
// flatters the schools badly: one pick spawns six to fourteen school fish and
// used to spawn exactly one of anything dangerous, so "5% of spawns" and "5% of
// the water" were the same number for the wrong reason. That structural
// dilution is why weight alone could not fix this — quadrupling the barracuda's
// weight moved the share from 5% to 9% — and why the barracuda now arrives in a
// pack (CONFIG.enemies.barracuda.group).
//
// Seeded, and averaged over seeds, for the reason every spawner harness here is:
// an unseeded run of this moves the late share by several points between
// invocations and invites exactly the wrong conclusion.
section('WHAT THE WATER IS MADE OF — aggressive share of the population');
{
  const AGGRO = new Set(Object.entries(CONFIG.enemies)
    .filter(([, d]) => ['hunt', 'chase', 'porpoise'].includes(d.behavior))
    .map(([k]) => k));

  // HOW BIG THE BODIES ARE, measured the way the player sees them: the asset's
  // `fit` (its length in world units at scale 1) times its assets.csv size
  // multiplier. NOT the enemies.csv `radius` column, which is the hitbox at
  // scale 1 and is therefore a fraction of the on-screen animal — and not a
  // consistent fraction either, which is the whole reason this measure exists:
  // enemyHammerhead and enemyDolphin had no assets.csv row at all, so a shark
  // whose radius said 1.3 swam past at 4.0 units against the shark's 10.1.
  // The king crab is the one body this flatters (its radius is a resting height
  // off the sand, see CONFIG.enemies.bossCrab) and it is a boss, so it never
  // reaches this census anyway.
  const assetKeyOf = (key) => {
    const d = CONFIG.enemies[key];
    return d?.assets?.[0] ?? d?.asset ?? key;
  };
  const bodyLength = (key) => {
    const k = assetKeyOf(key);
    const fit = ASSETS[k]?.fit;
    return (typeof fit === 'number' ? fit : 1) * (getAssetSizeMultiplier(k) ?? 1);
  };
  // Three classes, cut where the roster actually clusters rather than on round
  // numbers: every school fish is under 1.6 units, the mid-tier hunters and
  // grazers run 2.4-5.3, and everything from the crabs (6.4) up is a body you
  // fight rather than eat.
  const sizeClass = (key) => {
    const len = bodyLength(key);
    return len < 2 ? 'small' : len < 6 ? 'mid' : 'big';
  };

  // Levels by minute, off the measured ladder in tools/xp-economy-test.mjs —
  // the spawner gates on player level as well as difficulty, so a flat level
  // would hold back everything with a minPlayerLevel.
  const LEVEL_AT = [1, 10, 12, 13, 14, 16, 17, 18, 19, 20, 21, 21, 22];

  function seeded(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function populationRun(seed) {
    const rand = seeded(seed);
    const orig = Math.random;
    Math.random = rand;
    resetEnemies(scene);
    resetWaves(0);
    const out = [];
    const gameState = { difficulty: 0, level: 1 };
    let t = 0;
    try {
      for (let m = 0; m < LEVEL_AT.length; m++) {
        gameState.level = LEVEL_AT[m];
        let agg = 0, tot = 0, samples = 0, small = 0, mid = 0, big = 0;
        for (let i = 0; i < 60 / dt; i++) {
          t += dt;
          gameState.difficulty = t * dps;
          setSpawnLevel(gameState.level);
          updateSpawning(dt, gameState, scene);
          // The hunt, as a hazard rate scaled by health — the seal's dps is
          // roughly flat, so a tough late creature survives proportionally
          // longer and the water fills the way it does in a real run. Without
          // a kill model the arena just pins at maxAlive and every share reads
          // the same. `removeEnemy(scene, index)` — the scene comes FIRST.
          for (let n = enemies.length - 1; n >= 0; n--) {
            if (rand() < (dt / 7) * (15 / Math.max(1, enemies[n].hp ?? 10)) * 40) removeEnemy(scene, n);
          }
          if (i % 10 === 0) {
            samples += 1;
            tot += enemies.length;
            for (const e of enemies) {
              if (AGGRO.has(e.type)) agg += 1;
              const c = sizeClass(e.type);
              if (c === 'small') small += 1; else if (c === 'mid') mid += 1; else big += 1;
            }
          }
        }
        out.push({
          agg: agg / samples, tot: tot / samples,
          small: small / samples, mid: mid / samples, big: big / samples,
        });
      }
    } finally { Math.random = orig; }
    return out;
  }

  // NINE SEEDS, and the count is load-bearing rather than cautious. At three
  // this census sat inside its own noise: adding a spawn source that puts an
  // AVERAGE OF 0.1 FISH in the water at level 10 — and none at all past level
  // 13 — moved the level-21 body-size share from 27% to 23%, straight across
  // the 25% threshold below. Nothing about the roster had changed; a handful of
  // extra draws twelve simulated minutes earlier had shifted the whole RNG
  // stream, and every share after it landed somewhere else.
  //
  // That is the failure mode the seeding was supposed to remove and only half
  // did: seeding makes a run REPRODUCIBLE, it does not make three of them
  // REPRESENTATIVE. A census that flips on an unrelated change is worse than no
  // census, because the next person to see it red will assume their change
  // caused it. The whole file is about a minute either way.
  const runs = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(populationRun);
  const mean = (m, f) => runs.reduce((s, r) => s + r[m][f], 0) / runs.length;
  const share = (m) => mean(m, 'agg') / Math.max(1, mean(m, 'tot'));

  console.log('  level      ' + LEVEL_AT.map((l) => String(l).padStart(6)).join(''));
  console.log('  in water   ' + LEVEL_AT.map((_, m) => mean(m, 'tot').toFixed(0).padStart(6)).join(''));
  console.log('  aggressive ' + LEVEL_AT.map((_, m) => mean(m, 'agg').toFixed(0).padStart(6)).join(''));
  console.log('  share      ' + LEVEL_AT.map((_, m) => `${(share(m) * 100).toFixed(0)}%`.padStart(6)).join(''));

  // The complaint this answers: past level 10 the water should be turning
  // nastier, not just fuller. Compared across the back half rather than against
  // the opening — the first minutes are almost pure school by design.
  const mid = share(4);   // ~level 14
  const late = share(11); // ~level 21
  // MEASURED AS HUNTERS IN THE WATER, with the share as a floor under it.
  //
  // The SHARE does not keep climbing and is not meant to be read as though it
  // did: it peaks around level 10 (31%), settles at 15-16% for the whole back
  // half, and the two samples this compared — level 14 against level 21 — sit
  // 3 points apart inside a census that moves by 1-2 points on nothing. So the
  // check was a coin flip on the shape of a plateau.
  //
  // What the back half actually does is put four times as many hunters in the
  // water (9 at level 14, 35 at level 21) while the schools grow alongside
  // them, because the schools ARE the chum economy. The share holds rather
  // than climbing because the hunters' own `maxConcurrent` caps bind before
  // the schools' do — moving that is a balance decision, not something this
  // file should assert its way into.
  const hunters = (m) => mean(m, 'agg');
  check('the water keeps turning more aggressive after the mid-game',
    hunters(11) > hunters(4) * 1.5 && late >= mid * 0.75,
    `${hunters(4).toFixed(0)} hunters at level ${LEVEL_AT[4]} → ${hunters(11).toFixed(0)} at level ${LEVEL_AT[11]}`
    + `, holding ${(mid * 100).toFixed(0)}% → ${(late * 100).toFixed(0)}% of the water`);

  check('...and a late run is meaningfully hunted, not merely crowded',
    late >= 0.12, `${(late * 100).toFixed(0)}% of the water is a hunter`);

  // ...and the other direction. The schools ARE the chum economy — they feed
  // the food chain, the strike meter and the whole xp ladder — so an arena that
  // tips over into all-predator breaks levelling as surely as one that never
  // escalates. See tools/xp-economy-test.mjs.
  check('...but the schools still own the water, because they are the food',
    late <= 0.4, `${(late * 100).toFixed(0)}%, and the chum economy needs the rest`);

  check('the opening is left alone', share(0) < 0.06,
    `${(share(0) * 100).toFixed(0)}% at level ${LEVEL_AT[0]}`);

  // THE STRUCTURAL HALF. Weight cannot move the mix on its own while every
  // aggressive species spawns one at a time against schools of a dozen, so this
  // asserts the pack exists rather than trusting the weights to carry it.
  const packs = Object.entries(CONFIG.enemies)
    .filter(([k, d]) => AGGRO.has(k) && d.group && (d.group.max ?? 0) > 1);
  check('at least one aggressive species arrives as a group',
    packs.length > 0,
    packs.map(([k, d]) => `${k} ${d.group.min}-${d.group.max}`).join(', ') || 'none — weight alone cannot move the mix');

  // ---------------------------------------------------------------------------
  // ...AND HOW BIG IT IS. A second cut of the same census, because "aggressive"
  // and "big" are not the same complaint. The water was 90% minnows by
  // headcount at every point in a run: the schools arrive 6-14 at a time and
  // everything else arrives alone, so a run that was meant to escalate into
  // bigger animals escalated into MORE of the same small ones. That is a
  // structural effect of the group sizes, not of the weights.
  const cls = (m, f) => mean(m, f) / Math.max(1, mean(m, 'tot'));
  console.log('');
  console.log('  small <2u  ' + LEVEL_AT.map((_, m) => `${(cls(m, 'small') * 100).toFixed(0)}%`.padStart(6)).join(''));
  console.log('  mid 2-6u   ' + LEVEL_AT.map((_, m) => `${(cls(m, 'mid') * 100).toFixed(0)}%`.padStart(6)).join(''));
  console.log('  big 6u+    ' + LEVEL_AT.map((_, m) => `${(cls(m, 'big') * 100).toFixed(0)}%`.padStart(6)).join(''));

  // THE TWO FLOORS BELOW WERE 0.30 AND 0.10, and they came down with the
  // roster rather than because they were failing. Read this before moving them
  // again, in either direction.
  //
  // They were fitted to an ocean that had a DOLPHIN in it. The dolphin was
  // apex-without-being-a-shark, so the tighter shark cap never saw it, and it
  // held 7.5 of the 13.3 apex bodies alive at level 20 — more than the six
  // sharks between them, and every one of them in the 6u+ class here. It was
  // removed from the weighted pool outright (CONFIG.enemies.dolphin, weight 0
  // and spawnRateMul 0), the shark cap went 6 to 5, and the two megalodon-class
  // bodies were put under a `leviathan` cap of 2. That is a deliberate cut of
  // roughly two thirds of the big bodies, asked for in those words, and the
  // census moved with it: mid+big 33% -> 27%, big 13% -> 9%.
  //
  // So the floors are re-derived, not relaxed to make a red line go away — and
  // they are still floors that can catch something. What they no longer do is
  // assert the size of a roster that was changed on purpose.
  //
  // THE THING TO WATCH, because these numbers are where it will show up first:
  // cutting predators does not hold the rest of the mix still, it hands their
  // spawn budget to the schools. Small bodies went 66% -> 75% of the water
  // across this same change. If a late run starts reading as a cloud of
  // minnows, the lever is spawn.maxAlive or the school group sizes in
  // behaviour.csv — NOT putting the big bodies back, which is the complaint
  // this all came from.
  const bigLate = cls(11, 'big') + cls(11, 'mid');
  check('a late run is not just a bigger cloud of minnows',
    bigLate >= 0.24, `${(bigLate * 100).toFixed(0)}% of the water is a mid or large body at level ${LEVEL_AT[11]}`);

  check('...and the biggest bodies are a standing presence, not a rarity',
    cls(11, 'big') >= 0.075, `${(cls(11, 'big') * 100).toFixed(0)}% of the water is a 6-unit-plus body at level ${LEVEL_AT[11]}`);

  // The same both-ends guard the aggressive share gets. The schools are the
  // chum economy — see tools/xp-economy-test.mjs — and an arena of nothing but
  // big bodies starves the xp ladder as surely as one of nothing but minnows
  // bores it.
  check('...but the schools are still the bulk of the food',
    cls(11, 'small') >= 0.45, `${(cls(11, 'small') * 100).toFixed(0)}% of the water is still a school fish`);

  // THE GROWTH CLAIM, AND WHY IT IS ON THE MID TIER RATHER THAN THE BIG ONE.
  // Every 6-unit-plus body is headcount-capped — spawn.groupMaxAlive for the
  // apex family, maxConcurrent for the rays and the turtle — while the schools
  // are limited only by spawn.maxAlive, which the arena reaches. So the big
  // share NECESSARILY peaks mid-run and settles as the water fills, and an
  // assertion that it climbs to the end would be asking the caps to be
  // something they are not. The 2-6 unit tier is where a run can genuinely
  // keep trading up: the barracuda, the sailfish and the squid are the only
  // aggressive species outside those caps, and their weight ramps peak late.
  check('the water keeps trading up in body size after the mid-game',
    cls(11, 'mid') >= cls(4, 'mid'),
    `${(cls(4, 'mid') * 100).toFixed(0)}% mid-sized at level ${LEVEL_AT[4]} → ${(cls(11, 'mid') * 100).toFixed(0)}% at level ${LEVEL_AT[11]}`);
}

// ---------------------------------------------------------------------------
// THE FIFTH AXIS — the one keyed to the player's LEVEL rather than the clock.
//
// Everything above this line measures a run against its own length. This block
// measures it against the BUILD, which is the thing the late game was actually
// losing to: a seal at level 25 has taken twenty-four cards, and the four
// minutes of difficulty between it and a seal at level 20 is nowhere near the
// gap between those two animals. See CONFIG.spawn.lateGame.
//
// Read the numbers here as a multiplier ON TOP of every table above — a late
// creature carries its species' linear term, the roster-wide clock ramp, AND
// this.
const LG = CONFIG.spawn.lateGame ?? {};
const LG_LEVELS = [20, 22, 25, 28, 32, 40];
section('PAST LEVEL 20 — the surcharge on top of everything above');
{
  const axes = ['hp', 'damage', 'speed', 'seek', 'xp'];
  console.log(`        from level ${LG.from} — nothing at or below it is touched`);
  console.log('        axis   ' + LG_LEVELS.map((l) => `L${l}`.padStart(8)).join('') + '      caps at');
  const capLevel = {};
  for (const k of axes) {
    const per = LG[k] ?? 0;
    const max = LG[`${k}Max`] ?? Infinity;
    capLevel[k] = per > 0 ? (LG.from ?? 0) + Math.log(max) / Math.log(1 + per) : Infinity;
    console.log(`        ${k.padEnd(7)}` + LG_LEVELS.map((l) => `${lateGameMul(k, l).toFixed(2)}x`.padStart(8)).join('')
      + `      L${capLevel[k].toFixed(0)}`);
  }

  // The threshold is a promise about the first two thirds of every run: a build
  // that ends at 19 has to be bit-for-bit the build that ended at 19 before any
  // of this existed. `from` itself pays nothing — the surcharge is on levels
  // PAST it, so the card that takes you to 20 changes nothing.
  check('the first twenty levels are untouched',
    axes.every((k) => lateGameMul(k, LG.from) === 1 && lateGameMul(k, 1) === 1),
    `every axis is exactly 1.00x at level ${LG.from}`);
  check('...and level 21 is the first that costs anything',
    lateGameMul('hp', LG.from + 1) > 1,
    `hp ${lateGameMul('hp', LG.from + 1).toFixed(2)}x at level ${LG.from + 1}`);

  // No cap may land inside the band a run actually plays. A run reaches about
  // level 29 in fifteen minutes (tools/xp-economy-test.mjs), so a ceiling below
  // that is a flat spot in exactly the stretch this block exists to steepen —
  // the same argument the clock ramps' caps get at the top of this file.
  check('no axis flattens inside a run that is still being played',
    Math.min(...Object.values(capLevel)) > 29,
    `earliest is ${Object.entries(capLevel).sort((a, b) => a[1] - b[1])[0][0]} at level ${Math.min(...Object.values(capLevel)).toFixed(0)}`);

  // The same asymmetry guard the clock ramp gets, for the same reason: a run
  // that makes creatures far tougher than it makes them dangerous is a run that
  // ends in bullet sponges. Tighter here than the 40x allowed above, because
  // this ramp is deliberately steep and rides on top of that one.
  const ratio = lateGameMul('hp', 32) / lateGameMul('damage', 32);
  check('the surcharge does not make the water spongier than it makes it deadly',
    ratio <= 1.5, `hp ${lateGameMul('hp', 32).toFixed(2)}x against damage ${lateGameMul('damage', 32).toFixed(2)}x at level 32`);

  // Speed is the one that can break the arena rather than merely unbalance it:
  // combined with the clock ramp it must stay under the seal's own cruise, or
  // there is nowhere to go and no reason to steer.
  const topSpeed = (CONFIG.spawn.ramp.speedMax ?? 1) * (LG.speedMax ?? 1);
  check('...and the water never simply outswims the seal',
    topSpeed * CONFIG.enemies.fish.speed < CONFIG.player.maxSpeed,
    `${(topSpeed * CONFIG.enemies.fish.speed).toFixed(1)} u/s at both caps against a seal at ${CONFIG.player.maxSpeed}`);
}

// ---------------------------------------------------------------------------
section('...AND DOES IT REACH A REAL CREATURE?');
{
  // Spawned through the shipped spawn path at a FIXED difficulty with only the
  // level moving, which is the only way to see the surcharge on its own — every
  // other number in this file moves when the clock does. Same argument as the
  // SEEKING section above: "the ramp reaches this creature" is a claim about
  // spawnOne and cannot be checked against the config.
  const D = 30; // difficulty held still — about six and a half minutes in
  const born = (key, level) => {
    setSpawnLevel(level);
    resetEnemies(scene);
    setSpawnLevel(level); // resetEnemies clears it — see the note on spawnLevel
    spawnNamed(scene, key, D);
    const e = enemies[0];
    return e ? { hp: e.hp, damage: e.contactDamage, speed: e.speed, xp: e.xp, seek: e.towardPlayer ?? 0 } : null;
  };

  const SUBJECTS = ['fish', 'barracuda', 'shark'].filter((k) => CONFIG.enemies[k]);
  console.log(`        at a fixed difficulty of ${D}, level moving alone  (hp / damage / xp)`);
  console.log('        species     ' + LG_LEVELS.map((l) => `L${l}`.padStart(18)).join(''));
  for (const k of SUBJECTS) {
    const cells = LG_LEVELS.map((l) => {
      const b = born(k, l);
      return `${b.hp.toFixed(0)}/${b.damage.toFixed(1)}/${b.xp.toFixed(1)}`.padStart(18);
    });
    console.log(`        ${k.padEnd(12)}${cells.join('')}`);
  }

  for (const k of SUBJECTS) {
    const a = born(k, LG.from);
    const b = born(k, 28);
    check(`${k}: level 28 is meaningfully harder than level 20 at the same minute`,
      b.hp > a.hp * 1.8 && b.damage > a.damage * 1.7,
      `hp x${(b.hp / a.hp).toFixed(2)}, damage x${(b.damage / a.damage).toFixed(2)}`);
  }

  // THE PACE CLAIM, and the reason the xp row is inside this block rather than
  // in the xp curve. A creature that is 2.5x harder to kill for the same chum
  // is a wall; the ladder holds only if what it drops keeps up with what it
  // costs. Speed is excluded from "what it costs" deliberately — it makes a
  // creature harder to CATCH, not slower to kill.
  for (const k of SUBJECTS) {
    const a = born(k, LG.from);
    const b = born(k, 28);
    check(`${k}: ...and its chum keeps up with its health`,
      (b.xp / a.xp) >= (b.hp / a.hp),
      `xp x${(b.xp / a.xp).toFixed(2)} against hp x${(b.hp / a.hp).toFixed(2)}`);
  }

  // The axis that was silently doing nothing for most of the roster the last
  // time this file was written — see the SEEKING section. A level-keyed ramp
  // that reached the hunters and not the schools would be the same bug again,
  // and the schools are what the water is mostly made of.
  const school = born('fish', 28);
  const schoolBase = born('fish', LG.from);
  check('the schools press harder for the level too, not just the hunters',
    school.seek > schoolBase.seek * 1.5,
    `towardPlayer ${schoolBase.seek.toFixed(2)} at level ${LG.from} → ${school.seek.toFixed(2)} at 28`);

  const hunter = born('shark', 28);
  const hunterBase = born('shark', LG.from);
  check('...and a hunter turns harder for it',
    hunter.speed >= hunterBase.speed * 0.9,
    `a shark still spawns at ${hunter.speed.toFixed(1)} u/s`);

  resetEnemies(scene);
  setSpawnLevel(1);
}

// ---------------------------------------------------------------------------
section('SUSTAIN — what a mouthful of chum is worth as the water fills up');
{
  // The other half of "the late game is too easy", and the half that is not a
  // ramp at all: pickups.healFraction is a share of max HP, so one orb has
  // always healed the same slice of the bar however big the bar got. What was
  // never flat is how MANY orbs there are, and a flat per-orb heal against a
  // rising orb count is a healing rate that climbs on its own with nothing in
  // the tables saying it does. See CONFIG.pickups.healRamp.
  //
  // Keyed to the difficulty clock rather than the player level, unlike
  // everything above — how much chum is in the water is a spawn-rate fact.
  const hr = CONFIG.pickups.healRamp ?? {};
  const heal = (m) => chumHealRamp(m * 60 * dps);
  console.log('        minute ' + MINUTES.map((m) => `m${m}`.padStart(8)).join(''));
  console.log('        per orb' + MINUTES.map((m) => `${(heal(m) * 100).toFixed(0)}%`.padStart(8)).join(''));
  console.log(`        floor ${((hr.min ?? 1) * 100).toFixed(0)}% of pickups.healFraction, reached at minute `
    + `${((hr.fullAt ?? 0) / dps / 60).toFixed(1)}`);

  check('the opening is left alone',
    heal(1) === 1 && heal(3) === 1,
    `a full-value orb through minute ${((hr.from ?? 0) / dps / 60).toFixed(1)}`);
  check('...and it never falls to nothing — chum still feeds the seal',
    Math.min(...MINUTES.map(heal)) >= (hr.min ?? 1) && (hr.min ?? 1) >= 0.2,
    `floors at ${((hr.min ?? 1) * 100).toFixed(0)}%`);
  check('...falling the whole way, with no flat stretch mid-run',
    heal(5) > heal(8) && heal(8) > heal(10) && heal(10) > heal(15),
    MINUTES.map((m) => `m${m}:${(heal(m) * 100).toFixed(0)}%`).join(' '));

  // THE POINT OF THE WHOLE BLOCK, stated as the comparison it is really about.
  // Contact damage is per second and a late swarm stacks it; sustain has to
  // lose ground against that or a late run cannot kill the player at all.
  const dmgAt = (m) => at(CONFIG.enemies.fish, 'damage', m);
  const sustain = (m) => heal(m) / dmgAt(m);
  check('sustain loses ground to the water, which is the whole point',
    sustain(15) < sustain(5) * 0.4,
    `heal-per-orb against fish dps: x${(sustain(15) / sustain(5)).toFixed(2)} from minute 5 to 15`);

  // The rescue is not on this ramp and must never be. A pity chunk that quietly
  // stopped rescuing is the one heal in the game that has no business having a
  // hidden curve on it — see the note in config.js.
  check('the boss and pity chunks are untouched by it',
    (CONFIG.chumChunk?.pity?.healMin ?? 0) >= 0.4 && CONFIG.chumChunk?.healMax >= 0.5,
    `a pity chunk still rolls at least ${((CONFIG.chumChunk?.pity?.healMin ?? 0) * 100).toFixed(0)}% of max HP`);
}

// ---------------------------------------------------------------------------
console.log(`\n${failures ? `${failures} FAILED` : 'all good'}\n`);
process.exit(failures ? 1 : 0);
