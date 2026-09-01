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

// The axis weights, read once. Every proportion below is stated against these
// rather than against a constant, so a retune shows up as a changed printout
// instead of as a failing suite.
const W = CONFIG.pace.axes ?? {};

// ---------------------------------------------------------------------------
section('THE DIALS THEMSELVES');
{
  // PIN THE DIAL. These three checks name a dial value in their own titles and
  // used to read whatever was live instead — so on a tree where the tuner had
  // been dragged to 1.5 they measured 1.5^weight, reported `hp 1.2000165`, and
  // called a correctly-tuned game a broken identity. The dials are saved
  // tuning: `path/src/imported-tuning.json` holds enemy 1.5 and xp 0.85 today
  // and will hold something else tomorrow, and neither is this suite's to have
  // an opinion about. What IS this suite's business is that the code is an
  // identity when the dial says 1, so it sets the dial and asks.
  check('every axis is an identity at enemy = 1',
    atPace({ enemy: 1 }, () => ['hp', 'damage', 'speed', 'seek'].every((k) => enemyPaceMul(k) === 1)),
    atPace({ enemy: 1 }, () => ['hp', 'damage', 'speed', 'seek'].map((k) => `${k} ${enemyPaceMul(k)}`).join(', ')));

  check('...whatever the weights hold', atPace({ enemy: 1, axes: { hp: 1.5, speed: 0.9 } }, () =>
    ['hp', 'damage', 'speed', 'seek'].every((k) => enemyPaceMul(k) === 1)));

  check('the levelling dial is an identity at 1', atPace({ xp: 1 }, () => xpPaceMul() === 1));

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
  console.log(`        weights: ${['hp', 'damage', 'speed', 'seek'].map((k) => `${k} ${W[k]}`).join(', ')}`
    + `  — ordering: ${['hp', 'damage', 'speed', 'seek'].slice().sort((a, b) => W[b] - W[a]).join(' > ')}`);

  // ASSERT THE MECHANISM, NOT A REMEMBERED NUMBER. This used to demand
  // `speed < hp * 0.75` and `speed < seek < hp`, both of which were true of the
  // weights on the day it was written and neither of which is a fact about the
  // code. `seek` has since been tuned 0.5 -> 0.15, which moved aggression from
  // between speed and health to below both — a real design change, and the
  // suite reported it as a bug in four lines that named none of it. A weight is
  // a knob; a knob's value is not a test's to hold.
  //
  // What does not move with tuning: each axis is exactly `dial ** weight`, so
  // that is what is checked, and the ordering above is PRINTED so a retune is
  // visible in the log rather than fatal.
  for (const k of ['hp', 'damage', 'speed', 'seek']) {
    check(`${k} moves as the dial raised to its own weight`,
      Math.abs(at2[k] - 2 ** W[k]) < 1e-12,
      `x${at2[k].toFixed(4)} against 2^${W[k]} = ${(2 ** W[k]).toFixed(4)}`);
  }
  // The one claim that is design rather than tuning, and the reason `axes`
  // exists at all: health must outrun speed, or a harder game is just a faster
  // one and the arena stops having anywhere to go.
  check('health outruns speed — a harder game is not merely a faster one',
    W.speed < W.hp && at2.speed < at2.hp,
    `speed weight ${W.speed} vs hp ${W.hp} — x${at2.speed.toFixed(2)} against x${at2.hp.toFixed(2)}`);
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
      // At pace 1 — the claim is about the code, not about today's tuning.
      const withDials = atPace({ enemy: 1, xp: 1 }, () => born(key, D, L));
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
      // BOTH ENDS PINNED. `a` used to be an unpinned spawn, so on a tree with
      // the dial tuned to 1.5 this measured 2^w / 1.5^w and called it "1 -> 2".
      const a = atPace({ enemy: 1 }, () => born(key, D, L));
      const b = atPace({ enemy: 2 }, () => born(key, D, L));
      console.log(`        ${key.padEnd(11)}${label.padEnd(17)}`
        + `x${(b.hp / a.hp).toFixed(2)} / x${(b.damage / a.damage).toFixed(2)} / `
        + `x${(b.speed / a.speed).toFixed(2)}`);
      // Against the axis weights, not against remembered numbers: "health
      // doubles" was only ever true while hp was weighted 1, and it is 0.45
      // today. What has to hold is that the dial reaches the spawner and
      // arrives raised to that axis's own weight.
      check(`${key}, ${label}: health carries the dial at its weight`,
        Math.abs(b.hp / a.hp - 2 ** W.hp) < 1e-9,
        `x${(b.hp / a.hp).toFixed(4)} against 2^${W.hp}`);
      check(`${key}, ${label}: damage carries the dial at its weight`,
        !(a.damage > 0) || Math.abs(b.damage / a.damage - 2 ** W.damage) < 1e-9,
        `x${(b.damage / a.damage).toFixed(4)} against 2^${W.damage}`);
      // The jitter rides outside the ramped term on purpose, so the ratio is
      // slightly under the exponent rather than equal to it. Bounded on both
      // sides: the point is that speed moved and moved LESS than health.
      check(`${key}, ${label}: speed moves, and by less than health`,
        b.speed > a.speed && b.speed / a.speed <= 2 ** W.speed + 1e-9,
        `x${(b.speed / a.speed).toFixed(3)} against a ceiling of 2^${W.speed}`);
    }
  }
}

// ---------------------------------------------------------------------------
section('AGGRESSION — the branch that had no ramp to ride');
{
  // The three seek fields at difficulty 0, where `rampOn` is false. Every one
  // of them used to ignore the dial entirely here.
  for (const key of SUBJECTS) {
    const a = atPace({ enemy: 1 }, () => born(key, 0));
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
  // Pinned, like every other baseline here: an unpinned control is whatever the
  // tuner happens to hold, and this comparison only means anything against 1.
  const base = atPace({ enemy: 1 }, () => born(SUBJECTS[0], 30));
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
section('THE FILE OWNS THEM — behaviour.csv, and no slider beside it');
{
  // THE DIALS MOVED OUT OF THE TUNER, and this section moved with them.
  //
  // It used to assert the opposite: that a group existed in TUNER_SCHEMA and
  // that no CSV owned a pace path. That was the right guard for a slider, and
  // it was guarding the wrong arrangement. A tuner-only number has no readable
  // source — config.js said `seek: 0.5` while the game ran 0.15, and editing
  // that line did nothing, because a saved snapshot beats a config default and
  // the live value existed only inside a JSON blob that never appears in a
  // diff. A difficulty curve is read across a whole playtest, not judged in the
  // second it happens, so it belongs in a file with a min, a max and a note.
  //
  // Both halves are still checked, just pointed the other way.
  const { readFileSync, readdirSync } = await import('node:fs');
  const owned = new Map();
  for (const f of readdirSync('path/src').filter((f) => f.endsWith('.csv'))) {
    for (const line of readFileSync(`path/src/${f}`, 'utf8').split('\n')) {
      const id = line.split(',')[0];
      if (id.startsWith('pace.')) owned.set(id, f);
    }
  }

  // 1. EVERY pace path is in a table. A key config.js declares and no row
  // covers is one a saved snapshot can still shadow, which is the whole bug.
  const declared = [];
  (function walk(o, prefix) {
    for (const [k, v] of Object.entries(o ?? {})) {
      if (v && typeof v === 'object') walk(v, `${prefix}${k}.`);
      else if (typeof v === 'number') declared.push(`${prefix}${k}`);
    }
  }(CONFIG.pace, 'pace.'));
  const uncovered = declared.filter((p) => !owned.has(p));
  check('every pace path config.js declares has a behaviour.csv row',
    declared.length > 0 && uncovered.length === 0,
    uncovered.length ? `no row for ${uncovered.join(' ')}` : `${declared.length} paths, all covered`);

  check('...and they are all in the same file, so there is one place to look',
    new Set(owned.values()).size === 1, [...new Set(owned.values())].join(' '));

  // 2. THE DEAD-SLIDER BUG, unchanged in substance: a slider pointed at a path
  // a table owns is put back at every boot and moves nothing. Now that the
  // table owns them, the failure is a leftover row rather than a missing one.
  const sliders = TUNER_SCHEMA.flatMap((g) => (g.items ?? []).map((i) => i.path))
    .filter((p) => typeof p === 'string' && p.startsWith('pace.'));
  check('no slider still points at a pace path', sliders.length === 0, sliders.join(' '));

  // 3. ...AND THE FILE ACTUALLY REACHES CONFIG. The point of the move: a table
  // path is stripped from the saved snapshot, so the row is what the game runs.
  // Asserted against the real merged CONFIG rather than against the CSV text.
  check('every row resolves to a number in CONFIG', [...owned.keys()].every((p) => {
    let v = CONFIG;
    for (const k of p.split('.')) v = v?.[k];
    return typeof v === 'number';
  }), [...owned.keys()].join(' '));
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
