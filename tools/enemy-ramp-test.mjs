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
import { CONFIG, difficultyRamp } from '../path/src/config.js';
import { enemies, resetEnemies, removeEnemy, spawnNamed, updateSpawning } from '../path/src/entities/enemies.js';
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
        let agg = 0, tot = 0, samples = 0;
        for (let i = 0; i < 60 / dt; i++) {
          t += dt;
          gameState.difficulty = t * dps;
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
            for (const e of enemies) if (AGGRO.has(e.type)) agg += 1;
          }
        }
        out.push({ agg: agg / samples, tot: tot / samples });
      }
    } finally { Math.random = orig; }
    return out;
  }

  const runs = [1, 2, 3].map(populationRun);
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
  check('the water keeps turning more aggressive after the mid-game',
    late >= mid, `${(mid * 100).toFixed(0)}% at level ${LEVEL_AT[4]} → ${(late * 100).toFixed(0)}% at level ${LEVEL_AT[11]}`);

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
}

// ---------------------------------------------------------------------------
console.log(`\n${failures ? `${failures} FAILED` : 'all good'}\n`);
process.exit(failures ? 1 : 0);
