#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:invincible
//
// `invincible` on an enemy row means the creature CANNOT BE KILLED — scenery
// the player swims past, not an opponent. This asserts the three things that
// have to hold for that to be true, and the two that have to hold for it to
// stay honest in the balance report.
//
// WHY THIS TEST EXISTS AT ALL. Invincibility used to be spelled as hp
// 1000000000 on the seaTurtle row, which worked as gameplay and was a disaster
// as data: a lethal hazard asks a creature for the health it has left, so one
// bolt filed a BILLION damage against `lightning`. One run did 8.1e9, which was
// 99.87% of all damage ever recorded across 151 runs and took every real
// ability in the pooled table to a 0% share.
//
// The replacement is a seal on the `hp` property rather than a check at each
// hit — eighteen systems own the line `e.hp -= something`, so a flag consulted
// at each of them works until the nineteenth ability is written and then fails
// silently. THAT is what the "every weapon" case below is really testing: not
// that one weapon is handled, but that the mechanism is the kind that cannot be
// forgotten.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { readFile } from 'node:fs/promises';
import { CONFIG } from '../path/src/config.js';
import { enemies, spawnNamed, resetEnemies } from '../path/src/entities/enemies.js';
import { parseEnemyCsv, ENEMY_TABLE_FIELDS } from '../path/src/enemyTable.js';
import * as playtest from '../path/src/systems/playtest.js';
import { SENTINEL_HP } from '../path/src/systems/playtest.js';

const scene = new THREE.Scene();
let failures = 0;

const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[animation]') || msg.startsWith('[assets]'))) return;
  realWarn(msg, ...rest);
};

function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
section('The table says it with a flag, not with a number');

const csv = await readFile(new URL('../path/src/enemies.csv', import.meta.url), 'utf8');
const rows = parseEnemyCsv(csv, () => {});

check('enemies.csv has an `invincible` column', ENEMY_TABLE_FIELDS.includes('invincible'));
check('seaTurtle carries the flag', CONFIG.enemies.seaTurtle?.invincible === true,
  `invincible=${CONFIG.enemies.seaTurtle?.invincible}`);

// The whole point of the change: no row expresses "unkillable" as arithmetic.
// A future row that did would re-open the exact hole this closed, and it would
// do it silently — which is why this is an assertion and not a comment.
const placeholders = [...rows.entries()]
  .map(([id]) => [id, CONFIG.enemies[id]?.hp ?? 0])
  .filter(([, hp]) => hp >= SENTINEL_HP);
check('no row spells invincibility as enormous hp', placeholders.length === 0,
  placeholders.map(([id, hp]) => `${id}=${hp}`).join(', ') || 'none');

// A sanity floor: the turtle should now carry an ordinary number, because the
// number no longer has to mean anything.
const turtleHp = CONFIG.enemies.seaTurtle?.hp ?? 0;
check('seaTurtle hp is an ordinary quantity', turtleHp > 0 && turtleHp < 10000, `hp=${turtleHp}`);

// ---------------------------------------------------------------------------
section('It survives everything, however the damage is written');

resetEnemies(scene);
const turtle = spawnNamed(scene, 'seaTurtle', 1, { x: 0, y: -5 });
check('a turtle spawned', !!turtle || enemies.length > 0);

const t = enemies[enemies.length - 1];
const startHp = t.hp;

// Each of these is a real line from a different system, written the way that
// system writes it. They are deliberately NOT routed through one helper —
// there is no such helper in the game, and inventing one here would test a
// shape the game does not have.
t.hp -= 50;                       // systems/combat.js
t.hp -= 999999;                   // a very large hit
t.hp = 0;                         // an outright assignment
t.hp = -1;                        // and a negative one
t.hp -= Number.POSITIVE_INFINITY; // systems/elements.js worst case
check('hp never moves', t.hp === startHp, `${startHp} -> ${t.hp}`);
check('never reads as dead', !(t.hp <= 0), `hp=${t.hp}`);

// The lethal-splash arm is the specific path that filed a billion damage: it
// asks the creature for the health it has left. It must now decline to touch
// scenery at all.
check('the marker the splash arm reads is set', t.invincible === true);

// hp has to stay an ordinary enumerable number to everything that isn't
// trying to subtract from it — a health bar reading it, a serialiser walking
// the object. A non-enumerable or getter-only-looking field would break those
// in ways that have nothing to do with damage.
check('hp is still enumerable', Object.keys(t).includes('hp'));
check('hp still reads as a number', typeof t.hp === 'number' && Number.isFinite(t.hp));

// ---------------------------------------------------------------------------
section('The ledger refuses to credit work that did nothing');

playtest.beginRun({ playerMaxHp: 100 });
// A bucket is only kept if time passed in it — endRun drops an empty one, so
// without this the assertions below read an undefined bucket rather than a
// clean one.
playtest.tick(1, { time: 1, level: 1, score: 0, hp: 100, maxHp: 100, alive: 1 });

// An ability swings at scenery. It is entitled to think it dealt damage — the
// hp write is absorbed downstream of it — so it calls in the figure it tried
// to deal. Booking that would rank whichever weapon swings near turtles most.
playtest.recordDamage('lightning', 1_000_000, { invincible: true });
playtest.recordDamage('garlic', 40, { invincible: true });

// ...and a normal creature in the same breath, so this can tell "the guard
// works" from "recording is broken".
playtest.recordDamage('gun', 30, { invincible: false });

const bucket = playtest.endRun('death').buckets[0];
const dealt = bucket.dealtBySource;

check('nothing credited for hitting scenery', !dealt.lightning && !dealt.garlic,
  `lightning=${dealt.lightning ?? 0} garlic=${dealt.garlic ?? 0}`);
check('a real hit still records', dealt.gun === 30, `gun=${dealt.gun ?? 0}`);

// ---------------------------------------------------------------------------
section('Scenery is not counted as pressure to clear');

// recordSpawn is the denominator of the clear rate. An unkillable creature
// arriving is not hp the player is expected to work through, and counting it
// made one turtle read as 628 million hp/sec of incoming pressure.
playtest.beginRun({ playerMaxHp: 100 });
playtest.tick(1, { time: 1, level: 1, score: 0, hp: 100, maxHp: 100, alive: 1 });
resetEnemies(scene);
spawnNamed(scene, 'seaTurtle', 1, { x: 0, y: -5 });
const after = playtest.endRun('death').buckets[0];
check('a turtle spawn adds no pressure', (after?.spawnHp ?? 0) === 0, `spawnHp=${after?.spawnHp ?? 0}`);

// ---------------------------------------------------------------------------
console.log(failures ? `\n${failures} FAILED\n` : '\nAll passed.\n');
process.exit(failures ? 1 : 0);
