#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:tables
//
// The path-keyed CSVs — spawning, weapons, behaviour — own the game's balance
// numbers. Every failure they can have is SILENT: the game boots, nothing
// throws, and a number you edited simply does not take.
//
//   * a path that matches nothing in config.js (a typo) writing a key nobody
//     reads, so the file looks set and the setting stays default
//   * a saved snapshot beating the file, which is what the old tuner sliders
//     did and the entire reason these tables exist
//   * TWO HOMES for one number. Fifty tuner sliders once pointed at
//     `enemies.*.spawnRateMul` and `minPlayerLevel`, which enemies.csv owns and
//     overwrites on every apply — they looked live and moved nothing. That is
//     the class of bug the whole design is built against, so it is checked
//     three ways: no path is in two CSVs, no path is also a tuner row, and no
//     path collides with a column enemies.csv owns.
//   * a boolean arriving as the number 1 and staying 1, so `enabled` is truthy
//     by accident rather than true on purpose
//   * a blank cell reading as 0 and switching a system off
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, TUNER_SCHEMA } from '../path/src/config.js';
import { ENEMY_TABLE_FIELDS } from '../path/src/enemyTable.js';
import { createPathTable, stripAllTables } from '../path/src/pathTable.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(resolve(HERE, `../path/src/${f}`), 'utf8');

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
const quiet = () => {};
const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

// Mirrors the manifest in config.js. Kept in step by the "every path resolves"
// check below — a root missing here shows up as a skipped row.
const TABLES = [
  createPathTable({ label: 'spawning', file: 'spawning.csv', roots: ['spawn', 'crabSpawn', 'xp'], text: read('spawning.csv') }, quiet),
  createPathTable({ label: 'weapons', file: 'weapons.csv', roots: ['weapon', 'missile', 'bounce'], text: read('weapons.csv') }, quiet),
  createPathTable({ label: 'behaviour', file: 'behaviour.csv', roots: ['bite', 'hunterRamp', 'apexCrowd', 'enemies'], text: read('behaviour.csv') }, quiet),
];

// --- the files reach the config ---------------------------------------------
section('THE TABLES ARE LIVE');
let all = 0;
for (const t of TABLES) {
  all += t.rows.size;
  const orphans = t.ids().filter((id) => get(CONFIG, id) === undefined);
  check(`${t.file}: every row points at a real setting`, orphans.length === 0,
    orphans.length ? `orphaned: ${orphans.join(', ')}` : `${t.rows.size} paths resolve`);

  const wrong = [];
  for (const [id, row] of t.rows) {
    const want = String(row.value).trim();
    const live = get(CONFIG, id);
    const same = typeof live === 'boolean'
      ? live === (want === '1' || want.toLowerCase() === 'yes' || want.toLowerCase() === 'true')
      : Math.abs(Number(want) - live) < 1e-9;
    if (!same) wrong.push(`${id}: file ${want} vs live ${JSON.stringify(live)}`);
  }
  check(`${t.file}: the live config matches the file`, wrong.length === 0,
    wrong.length ? wrong.slice(0, 3).join(' | ') : `${t.rows.size} values agree`);
}
check('all three tables carry rows', all > 100, `${all} balance numbers now live in CSVs`);

// --- one home per number -----------------------------------------------------
section('ONE HOME, NOT TWO');
{
  const seen = new Map();
  const twice = [];
  for (const t of TABLES) {
    for (const id of t.ids()) {
      if (seen.has(id)) twice.push(`${id} (${seen.get(id)} + ${t.file})`);
      else seen.set(id, t.file);
    }
  }
  check('no path appears in two CSVs', twice.length === 0, twice.join(', '));

  const still = [];
  for (const g of TUNER_SCHEMA) {
    for (const it of g.items ?? []) {
      if (it.path && seen.has(it.path)) still.push(`${g.group}/${it.path}`);
    }
  }
  check('no CSV-owned number is still a tuner slider', still.length === 0,
    still.length ? still.slice(0, 5).join(', ') : 'the tuner and the tables cannot disagree');

  // The 50-slider bug, checked at its root rather than by name: no tuner row
  // may point at a flat per-creature field that enemies.csv owns, because
  // applyEnemyTable overwrites those on every apply.
  const dupes = [];
  for (const g of TUNER_SCHEMA) {
    for (const it of g.items ?? []) {
      const m = it.path && /^enemies\.[A-Za-z0-9_]+\.([A-Za-z0-9_]+)$/.exec(it.path);
      if (m && ENEMY_TABLE_FIELDS.includes(m[1])) dupes.push(it.path);
    }
  }
  check('no tuner row points at a column enemies.csv owns', dupes.length === 0,
    dupes.length ? `${dupes.length}: ${dupes.slice(0, 3).join(', ')}...` : 'nothing shadows the creature table');

  // ...and neither may a CSV row, which is what the `forbid` guard is for.
  const behaviour = TABLES.find((t) => t.file === 'behaviour.csv');
  const collide = behaviour.ids().filter((id) => {
    const m = /^enemies\.[A-Za-z0-9_]+\.([A-Za-z0-9_]+)$/.exec(id);
    return m && ENEMY_TABLE_FIELDS.includes(m[1]);
  });
  check('and no behaviour row collides with the creature table', collide.length === 0, collide.join(', '));

  const empty = TUNER_SCHEMA.filter((g) => !(g.items ?? []).length).map((g) => g.group);
  check('pulling them left no empty tuner groups', empty.length === 0, empty.join(', '));
}

// --- types come from config.js, not from the file ---------------------------
section('TYPE SAFETY');
{
  const bools = [];
  for (const t of TABLES) for (const id of t.ids()) if (typeof get(CONFIG, id) === 'boolean') bools.push(id);
  // Truthiness is not enough: `enabled: 1` passes an `if` and fails `=== true`,
  // and code testing `!== false` behaves differently again.
  check('on/off settings are real booleans, not 1',
    bools.length > 0 && bools.every((id) => typeof get(CONFIG, id) === 'boolean'),
    `${bools.length}: ${bools.join(', ')}`);

  const mk = (text, roots, forbid) => createPathTable({ label: 't', file: 't.csv', roots, forbid, text }, quiet);

  const cfg = { spawn: { baseInterval: 1.4, nightlife: { enabled: true } } };
  const t1 = mk('id,value\nspawn.baseInterval,banana\nspawn.nightlife.enabled,banana\n', ['spawn']);
  t1.apply(cfg, t1.captureBase(cfg));
  check('a non-numeric value keeps the built-in number', cfg.spawn.baseInterval === 1.4,
    `stayed ${cfg.spawn.baseInterval}`);
  check('...and a nonsense boolean stays a boolean', typeof cfg.spawn.nightlife.enabled === 'boolean');

  const blank = { crabSpawn: { pileThreshold: 6, enabled: true } };
  const t2 = mk('id,value\ncrabSpawn.pileThreshold,\ncrabSpawn.enabled,\n', ['crabSpawn']);
  t2.apply(blank, t2.captureBase(blank));
  check('a blank cell keeps the built-in rather than reading as 0',
    blank.crabSpawn.pileThreshold === 6 && blank.crabSpawn.enabled === true,
    `threshold ${blank.crabSpawn.pileThreshold}, enabled ${blank.crabSpawn.enabled}`);

  const odd = { spawn: { baseInterval: 1.4 } };
  const t3 = mk('id,value\nspawn.nope.deeper,5\nplayer.speed,99\n', ['spawn']);
  t3.apply(odd, new Map());
  check('an unknown path is skipped, not created', odd.spawn.nope === undefined);
  check('and a path outside the declared roots is refused', odd.player === undefined);

  // The guard that stops behaviour.csv regrowing the 50-slider bug.
  const enemy = { enemies: { shark: { spawnRateMul: 1, hunt: { preyRadius: 10 } } } };
  const t4 = mk('id,value\nenemies.shark.spawnRateMul,0.5\nenemies.shark.hunt.preyRadius,20\n',
    ['enemies'], (id) => (/^enemies\.[A-Za-z0-9_]+\.spawnRateMul$/.test(id) ? 'enemies.csv owns it' : null));
  t4.apply(enemy, t4.captureBase(enemy));
  check('a forbidden path is refused while its siblings apply',
    enemy.enemies.shark.spawnRateMul === 1 && enemy.enemies.shark.hunt.preyRadius === 20,
    `spawnRateMul ${enemy.enemies.shark.spawnRateMul}, preyRadius ${enemy.enemies.shark.hunt.preyRadius}`);
}

// --- the files beat a saved snapshot ----------------------------------------
section('THE FILES WIN');
{
  const snapshot = {
    spawn: { baseInterval: 999, maxAlive: 999, nightlife: { enabled: false } },
    crabSpawn: { pileThreshold: 999 },
    xp: { first: 999 },
    missile: { damage: 999 },
    bounce: { chainRange: 999 },
    bite: { cooldown: 999 },
    player: { speed: 12 },
  };
  const cleaned = stripAllTables(snapshot, TABLES);
  const left = [];
  for (const t of TABLES) for (const id of t.ids()) if (get(cleaned, id) !== undefined) left.push(id);
  check('every table-owned path is stripped from a snapshot', left.length === 0,
    left.length ? left.join(', ') : `${all} paths removed`);
  check('...and everything else in it is untouched', cleaned.player?.speed === 12);
  check('...without mutating what it was handed', snapshot.crabSpawn.pileThreshold === 999,
    'the save path passes the LIVE config in');
  check('parents left empty are pruned',
    cleaned.spawn === undefined && cleaned.crabSpawn === undefined && cleaned.xp === undefined,
    `spawn=${JSON.stringify(cleaned.spawn)} xp=${JSON.stringify(cleaned.xp)}`);
}

console.log(`\n${failures === 0 ? 'all good' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
