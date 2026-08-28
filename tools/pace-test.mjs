#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:pace
//
// THE TWO MASTER DIALS — CONFIG.pace.enemy and CONFIG.pace.xp.
//
// They are the only balance numbers in the game that live on sliders rather
// than in a table, and the whole argument for that is one claim: at 1 they are
// an identity. Not "close enough", not "within a percent" — the tuned run has
// to come out of the spawner bit for bit, or the dials have quietly become a
// second source of truth for numbers spawning.csv owns.
//
// That claim is not checkable against the config, because it is a claim about
// spawnOne — so everything below spawns REAL creatures through spawnNamed and
// reads what got baked onto them, the same way tools/enemy-ramp-test.mjs does.
//
// Four things it is here to catch:
//
//   1. THE IDENTITY. Every stat at pace 1 equals the same stat with the block
//      deleted outright, at difficulty 0 and mid-run, across the roster.
//   2. THE AGGRESSION BRANCH. `seekMul` used to be applied only inside the
//      `rampOn` arm of three ternaries, which is right for a ramp read off the
//      run clock and wrong for a dial meant to hold all run. At difficulty 0
//      there is no ramp — so if the dial does nothing there, that rewrite has
//      been undone and nothing else in the suite would say so.
//   3. THE WEIGHTS. `enemy` moves four stats by four different exponents on
//      purpose. A change that made them all move together would read as a
//      harder game and pass every other test in the repo.
//   4. THE COLLISION. A slider pointed at a path some CSV owns is put back at
//      every boot and moves nothing — the dead `spawnRateMul` bug. `pace` must
//      not be under any path table's roots, and every schema row must resolve.
//
//   node --import ./tools/vite-loader.mjs tools/pace-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG, TUNER_SCHEMA, enemyPaceMul, xpPaceMul } from '../path/src/config.js';
import { enemies, resetEnemies, spawnNamed, setSpawnLevel } from '../path/src/entities/enemies.js';

const scene = new THREE.Scene();
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

// Every stat the dial is supposed to reach, off one real spawn.
//
// Math.random is pinned for the duration: `speed` carries a per-individual
// jitter that is deliberately OUTSIDE the threat curve, and an unpinned draw
// would put noise on exactly the number this file compares to twelve decimal
// places. Pinned at 0.5 rather than 0 so the jitter is present and can still
// be seen to be unscaled.
function born(key, difficulty, level = 1) {
  const rand = Math.random;
  Math.random = () => 0.5;
  try {
    setSpawnLevel(level);
    resetEnemies(scene);
    setSpawnLevel(level); // resetEnemies clears it — see the note on spawnLevel
    spawnNamed(scene, key, difficulty);
    const e = enemies[0];
    if (!e) return null;
    return {
      hp: e.hp,
      damage: e.contactDamage,
      speed: e.speed,
      turnRate: e.turnRate ?? 0,
      towardPlayer: e.towardPlayer ?? 0,
      preyRadius: e.preyRadius ?? 0,
      xp: e.xp,
    };
  } finally {
    Math.random = rand;
  }
}

// Run `fn` with the dials set to `pace`, then put back exactly what was there.
function atPace(pace, fn) {
  const saved = JSON.parse(JSON.stringify(CONFIG.pace));
  Object.assign(CONFIG.pace, pace);
  if (pace.axes) CONFIG.pace.axes = { ...saved.axes, ...pace.axes };
  try { return fn(); } finally { CONFIG.pace = saved; }
}

// A creature that hunts, one that shoals, and one of each size — between them
// they cover all three of the seek lines (preyRadius and turnRate are hunter
// fields; towardPlayer is a swarm field, and no creature declares both).
const SUBJECTS = ['fish', 'barracuda', 'shark'].filter((k) => CONFIG.enemies[k]);
// Difficulty 0 is not a rounding case here — it is the one moment `rampOn` is
// false, which is the branch check 2 above exists for.
const MOMENTS = [['at difficulty 0', 0, 1], ['mid-run', 30, 1], ['late, level 28', 30, 28]];

// ---------------------------------------------------------------------------
section('THE DIALS THEMSELVES');
{
  check('every axis is an identity at enemy = 1',
    ['hp', 'damage', 'speed', 'seek'].every((k) => enemyPaceMul(k) === 1),
    ['hp', 'damage', 'speed', 'seek'].map((k) => `${k} ${enemyPaceMul(k)}`).join(', '));

  check('...whatever the weights hold', atPace({ axes: { hp: 1.5, speed: 0.9 } }, () =>
    ['hp', 'damage', 'speed', 'seek'].every((k) => enemyPaceMul(k) === 1)));

  check('the levelling dial is an identity at 1', xpPaceMul() === 1);

  // A range input dragged to its floor is the likeliest way to arrive at 0, and
  // "every creature spawns with no health" is not a difficulty setting.
  check('a dial of 0 is refused rather than obeyed',
    atPace({ enemy: 0 }, () => enemyPaceMul('hp') === 1)
    && atPace({ xp: 0 }, () => xpPaceMul() === 1));
  check('...and so is a negative one',
    atPace({ enemy: -1 }, () => enemyPaceMul('hp') === 1)
    && atPace({ xp: -1 }, () => xpPaceMul() === 1));

  check('an axis weighted 0 is left alone at any dial',
    atPace({ enemy: 3, axes: { speed: 0 } }, () => enemyPaceMul('speed') === 1));

  // The proportions, stated as the numbers rather than as "different": four
  // axes moving together is the failure this is watching for.
  const at2 = atPace({ enemy: 2 }, () => ({
    hp: enemyPaceMul('hp'), damage: enemyPaceMul('damage'),
    speed: enemyPaceMul('speed'), seek: enemyPaceMul('seek'),
  }));
  console.log(`        at enemy 2: hp x${at2.hp.toFixed(2)}, damage x${at2.damage.toFixed(2)}, `
    + `speed x${at2.speed.toFixed(2)}, aggression x${at2.seek.toFixed(2)}`);
  check('doubling the dial does NOT double the speed — the arena stops having anywhere to go',
    at2.speed < at2.hp * 0.75, `speed x${at2.speed.toFixed(2)} against hp x${at2.hp.toFixed(2)}`);
  check('...nor the aggression, which is between the two',
    at2.seek > at2.speed && at2.seek < at2.hp,
    `aggression x${at2.seek.toFixed(2)}`);
  check('the dial is symmetric — halving undoes doubling',
    Math.abs(atPace({ enemy: 0.5 }, () => enemyPaceMul('hp')) * at2.hp - 1) < 1e-12);
}

// ---------------------------------------------------------------------------
section('THE IDENTITY — a real spawn at pace 1 is the run that shipped');
{
  // The control: the block removed outright, which is the game as it was before
  // these dials existed. `enemyPaceMul` and `xpPaceMul` both fall back to 1 on a
  // missing block, so this is the genuine before-picture and not a re-reading of
  // the same numbers.
  for (const [label, D, L] of MOMENTS) {
    for (const key of SUBJECTS) {
      const withDials = born(key, D, L);
      const control = atPace({}, () => {
        const saved = CONFIG.pace;
        delete CONFIG.pace;
        try { return born(key, D, L); } finally { CONFIG.pace = saved; }
      });
      const same = Object.keys(withDials).every((k) => withDials[k] === control[k]);
      const diff = Object.keys(withDials).filter((k) => withDials[k] !== control[k])
        .map((k) => `${k} ${control[k]} -> ${withDials[k]}`).join(', ');
      check(`${key}, ${label}: identical with the dials and without them`, same, diff);
    }
  }
}

// ---------------------------------------------------------------------------
section('...AND IT REACHES A REAL CREATURE');
{
  console.log('        enemy 1 -> 2, measured off the spawner  (hp / damage / speed)');
  for (const [label, D, L] of MOMENTS) {
    for (const key of SUBJECTS) {
      const a = born(key, D, L);
      const b = atPace({ enemy: 2 }, () => born(key, D, L));
      console.log(`        ${key.padEnd(11)}${label.padEnd(17)}`
        + `x${(b.hp / a.hp).toFixed(2)} / x${(b.damage / a.damage).toFixed(2)} / `
        + `x${(b.speed / a.speed).toFixed(2)}`);
      check(`${key}, ${label}: health doubles`, Math.abs(b.hp / a.hp - 2) < 1e-9);
      check(`${key}, ${label}: damage doubles`,
        !(a.damage > 0) || Math.abs(b.damage / a.damage - 2) < 1e-9);
      // The jitter rides outside the ramped term on purpose, so the ratio is
      // slightly under the exponent rather than equal to it. Bounded on both
      // sides: the point is that speed moved and moved LESS than health.
      check(`${key}, ${label}: speed moves, and by less than health`,
        b.speed > a.speed && b.speed / a.speed < 1.35,
        `x${(b.speed / a.speed).toFixed(3)}`);
    }
  }
}

// ---------------------------------------------------------------------------
section('AGGRESSION — the branch that had no ramp to ride');
{
  // The three seek fields at difficulty 0, where `rampOn` is false. Every one
  // of them used to ignore the dial entirely here.
  for (const key of SUBJECTS) {
    const a = born(key, 0);
    const b = atPace({ enemy: 2 }, () => born(key, 0));
    const fields = [
      ['turns harder', 'turnRate', (x, y) => y > x],
      ['sheds prey distraction', 'preyRadius', (x, y) => y < x],
      ['a school presses harder', 'towardPlayer', (x, y) => y > x],
    ];
    for (const [what, field, moved] of fields) {
      // Only the creatures that declare the field — no species declares all
      // three, and a 0 that stays 0 is the roster, not a regression.
      if (!(a[field] > 0)) continue;
      check(`${key} ${what} at difficulty 0`, moved(a[field], b[field]),
        `${a[field].toFixed(3)} -> ${b[field].toFixed(3)}`);
    }
  }

  // ...and the aggression axis must not be reaching hp/damage/speed by accident
  // — the three lines it rewrote sit right beside them.
  const only = atPace({ enemy: 2, axes: { hp: 0, damage: 0, speed: 0 } }, () => born(SUBJECTS[0], 30));
  const base = born(SUBJECTS[0], 30);
  check('turning the other three axes off leaves hp, damage and speed alone',
    only.hp === base.hp && only.damage === base.damage && only.speed === base.speed,
    `hp ${base.hp.toFixed(1)} -> ${only.hp.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
section('THE LEVELLING DIAL');
{
  // Measured on a real orb rather than on the function, because the whole
  // question is whether it landed at the drop with chumMul or somewhere the
  // holdback and the tier multiplier never see.
  const { spawnXpOrb, pickups, resetPickups, setChumDifficulty } = await import('../path/src/entities/pickups.js');
  const orb = (mul, d = 10) => {
    resetPickups(scene);
    setChumDifficulty(d);
    return atPace({ xp: mul }, () => {
      spawnXpOrb(scene, { x: 0, y: 0 }, 10, 1);
      const p = pickups[pickups.length - 1];
      return { value: p.value, healMul: p.healMul };
    });
  };

  const one = orb(1);
  const half = orb(0.5);
  const twice = orb(2);
  console.log(`        one orb: x0.5 -> ${half.value.toFixed(3)}, `
    + `x1 -> ${one.value.toFixed(3)}, x2 -> ${twice.value.toFixed(3)}`);
  check('the dial scales an orb linearly', Math.abs(twice.value / one.value - 2) < 1e-9
    && Math.abs(half.value / one.value - 0.5) < 1e-9);
  check('...and reaches an orb dropped in the opening, where the holdback is deepest',
    Math.abs(orb(2, 0).value / orb(1, 0).value - 2) < 1e-9);
  check('the xp only — the heal is untouched, like every other scale on this orb',
    half.healMul === one.healMul && twice.healMul === one.healMul);
}

// ---------------------------------------------------------------------------
section('THE SLIDERS ARE REACHABLE — no table owns these paths');
{
  const group = TUNER_SCHEMA.find((g) => g.group === 'Difficulty & pace');
  check('the group is in the schema', !!group);
  const paths = group ? group.items.map((i) => i.path) : [];
  check('...and every row resolves to a number in CONFIG', paths.length > 0 && paths.every((p) => {
    let v = CONFIG;
    for (const k of p.split('.')) v = v?.[k];
    return typeof v === 'number';
  }), paths.join(' '));

  // The dead-slider bug: a table row for any of these would be silently
  // reapplied at every boot and on every CSV change, and the slider would move
  // nothing. Read out of the shipped CSVs rather than out of the roots lists,
  // so a table that widened its roots is caught too.
  const { readFileSync, readdirSync } = await import('node:fs');
  const owned = [];
  for (const f of readdirSync('path/src').filter((f) => f.endsWith('.csv'))) {
    for (const line of readFileSync(`path/src/${f}`, 'utf8').split('\n')) {
      const id = line.split(',')[0];
      if (id.startsWith('pace.')) owned.push(`${f}:${id}`);
    }
  }
  check('no CSV owns a pace.* path', owned.length === 0, owned.join(' '));
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
