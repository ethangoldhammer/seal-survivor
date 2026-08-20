#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:ledger
//
// The playtest recorder's guard against SENTINEL HP — a creature whose health
// is a placeholder for "this does not break" rather than a number anyone is
// expected to chew through.
//
// This exists because one got through. `seaTurtle` carries hp 1000000000 in
// enemies.csv, and the turtle is not actually invulnerable in code: any splash
// with `lethal: true` asks for exactly the health remaining, so a weather
// lightning bolt kills one and books a billion damage against the sky. Eight
// turtles in a single 346-second run put 8.1e9 in `dealtBySource` and took
// every other ability in that difficulty band to a 0% share and a 0.00x
// return. The spawn side was quieter and worse: `recordSpawn` is the
// denominator of the clear rate, so an arriving turtle made that minute look
// like the arena had flooded with a billion hp nobody touched.
//
// The line that got it wrong was already commented as guarding this exact
// failure — it tested for `Infinity`, and a billion is not infinity. Hence a
// test rather than a second comment.
//
// The first version of the fix CLAMPED both figures at 100k instead of
// dropping them, and this file is why it doesn't any more: the HEADROOM
// section failed on the spot. A ceiling has to sit above the biggest
// legitimate hit, and with spawning.csv at `ramp.hpMax` 30 a bossShark is 82k
// at ten minutes — so a cap high enough to let that through still books more
// per turtle than a real ability manages in a whole run. There is no honest
// number to record for killing a placeholder, so nothing is recorded.
//
// Four things worth failing over:
//
//   DROPPED    that both record functions refuse a placeholder, on the damage
//              side and the spawn side. One-sided is the state the bug
//              shipped in, and the spawn side was the worse half.
//
//   HEADROOM   that the line still sits clear of the biggest REAL creature in
//              enemies.csv, and by how long a run. This is the half that
//              rots: the line is a fixed number and creature hp is a ramp, so
//              a new boss or a bigger `hpPerDifficulty` eventually walks a
//              legitimate hit over it and it stops being recorded at all.
//              Derived from the CSV and the live spawn ramp, never hardcoded,
//              so adding that boss fails here instead of silently deleting
//              its damage from every report afterwards.
//
//   SENTINEL   that anything using huge hp to mean "indestructible" stays far
//              on the other side, and that nothing is parked ambiguously near
//              the line — the gap is what makes the two populations
//              distinguishable at a glance rather than by arithmetic.
//
//   HONEST     that the guard is instrumentation and nothing else: spawn
//              COUNTS, kill credit and the run's own bookkeeping come through
//              untouched. A guard that quietly ate a spawn would corrupt the
//              same curve it was added to protect.
//
// What it cannot tell you: whether dropping is the right call for reading a
// report, as opposed to reporting placeholders on their own line so a run
// that spent itself on turtles is visible rather than merely absent.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../path/src/config.js';
import * as playtest from '../path/src/systems/playtest.js';
import { SENTINEL_HP } from '../path/src/systems/playtest.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENEMIES = path.join(HERE, '../path/src/enemies.csv');

// endRun tries to persist, which is a browser concern. Stubbed rather than
// tolerated so a real failure isn't buried under a warning every run.
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// A run needs a tick on the clock before endRun will keep its bucket — an
// empty bucket is dropped on purpose, so recording without one measures
// nothing and passes everything.
const runWith = (record) => {
  playtest.beginRun({ playerMaxHp: 100 });
  playtest.tick(1, { time: 1, level: 1, score: 0, hp: 100, maxHp: 100, alive: 1 });
  record();
  return playtest.endRun('death').buckets[0];
};

// ------------------------------------------------------------------ the CSV

const rows = (() => {
  const [head, ...lines] = fs.readFileSync(ENEMIES, 'utf8').trim().split('\n');
  const cols = head.split(',');
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
})();

const num = (v) => (v === '' || v == null ? 0 : Number(v));
// What a species is worth at difficulty D, through the same two curves spawnOne
// applies: its own linear hpPerDifficulty, then the run-wide compounding ramp,
// which is capped at hpMax.
const hpAt = (row, d) => {
  const ramp = CONFIG.spawn.ramp;
  const mul = Math.min(Math.pow(1 + ramp.hp, d), ramp.hpMax);
  return (num(row.hp) + num(row.hpPerDifficulty) * d) * mul;
};

// The line between the two populations. Anything under this is a creature;
// anything over it is somebody typing "unbreakable" in a number column.
const SENTINEL_FLOOR = SENTINEL_HP;
const real = rows.filter((r) => num(r.hp) < SENTINEL_FLOOR);
const sentinels = rows.filter((r) => num(r.hp) >= SENTINEL_FLOOR);

section('DROPPED — neither side of the ledger books a placeholder');

// THE PLACEHOLDER IS SYNTHETIC NOW, and that is the point of this block rather
// than a weakening of it.
//
// This used to read seaTurtle's hp straight out of enemies.csv, because the
// turtle WAS the sentinel — it carried hp 1000000000 to mean "cannot be
// killed". That is no longer how the table says it: `invincible` is a flag on
// the row, the turtle carries an ordinary 250, and no species is a placeholder
// any more (see `no table row is a placeholder` below, and
// tools/invincible-test.mjs).
//
// The guard still has to work. It is what stands between a future row typed in
// haste and a month of poisoned reports, and a test that sourced its input from
// the table would have quietly stopped exercising it the moment the table was
// cleaned — passing with nothing to guard against, which is the failure mode
// worth avoiding here. So the value is written down.
const PLACEHOLDER = 1e9;
check('the guard is set below a placeholder-scale number', PLACEHOLDER >= SENTINEL_FLOOR,
  `${PLACEHOLDER.toExponential(0)} vs floor ${SENTINEL_FLOOR.toExponential(0)}`);

// And the migration itself: the table no longer expresses invincibility as
// arithmetic. Asserted here as well as in the invincibility test, because this
// is the file that explains what went wrong when it did.
check('no table row is a placeholder any more', sentinels.length === 0,
  sentinels.map((r) => `${r.id} ${num(r.hp).toExponential(0)}`).join(', ') || 'none');

// The failing run, in miniature: eight turtles struck by lightning alongside
// one ability doing real work. This is the shape of the run that filed 8.1e9
// against `lightning` and took every other ability to a 0% share.
let b = runWith(() => {
  for (let i = 0; i < 8; i++) playtest.recordDamage('lightning', PLACEHOLDER, { id: `turtle${i}` });
  playtest.recordDamage('missile', 268617, { id: 'shark' });
});
check('damage side books nothing for a placeholder', b.dealtBySource.lightning === undefined,
  `raw would have been ${(8 * PLACEHOLDER).toExponential(2)}`);
check('the real ability is the whole table again', b.dealtBySource.missile === 268617,
  `missile at 100% share, was 0%`);

b = runWith(() => {
  playtest.recordSpawn(PLACEHOLDER);
  for (let i = 0; i < 78; i++) playtest.recordSpawn(7.9);
});
check('spawn side books nothing for it either', Math.round(b.spawnHp) === Math.round(78 * 7.9),
  `spawnHp ${Math.round(b.spawnHp)}, the 78 fish alone`);

// ------------------------------------------------------------------ headroom

section('HEADROOM — every real creature stays under the line');

// Far past any run in the logs; the point is margin, not realism.
const HORIZON_MIN = 30;
const D = (HORIZON_MIN * 60) * CONFIG.spawn.difficultyPerSecond;

let worst = { id: null, hp: 0 };
for (const r of real) {
  const hp = hpAt(r, D);
  if (hp > worst.hp) worst = { id: r.id, hp };
}
check(`the biggest real creature is under the line at ${HORIZON_MIN} minutes`,
  worst.hp < SENTINEL_HP,
  `${worst.id} at ${Math.round(worst.hp)} vs ${SENTINEL_HP.toExponential(0)}`);
// The margin stated as a RUN LENGTH, which is the only form of it anyone can
// judge. A fixed ratio here would be two arbitrary numbers stacked — a horizon
// picked out of the air and a percentage picked out of the air — whereas "the
// biggest creature in the game does not cross the line until hour two" is a
// claim that can be read and disagreed with. Fails when a roster change brings
// that hour inside a plausible run.
const SAFE_MIN = 60;
const crossesAt = (() => {
  const step = 5; // seconds; fine enough to state the answer in minutes
  for (let t = step; t <= 60 * 60 * 6; t += step) {
    const d = t * CONFIG.spawn.difficultyPerSecond;
    if (real.some((r) => hpAt(r, d) >= SENTINEL_HP)) return t / 60;
  }
  return Infinity;
})();
check(`no real creature reaches the line inside ${SAFE_MIN} minutes`,
  crossesAt > SAFE_MIN,
  crossesAt === Infinity
    ? 'none within six hours'
    : `first crossing at ${crossesAt.toFixed(0)} min of run time`);

// Belt and braces: prove the biggest real creature really does pass through
// the recorder unchanged, rather than trusting the arithmetic above.
b = runWith(() => {
  playtest.recordSpawn(worst.hp);
  playtest.recordDamage('strike', worst.hp, { id: worst.id });
});
check('and passes through the recorder untouched',
  b.spawnHp === worst.hp && b.dealtBySource.strike === worst.hp,
  `${worst.id} at ${Math.round(worst.hp)}`);

// ------------------------------------------------------------------ sentinel

section('SENTINEL — the two populations stay far apart');

check('every placeholder is orders above the line, not just over it',
  sentinels.every((r) => num(r.hp) > SENTINEL_HP * 100),
  sentinels.map((r) => `${r.id} ${num(r.hp).toExponential(0)}`).join(', ') || 'none');
check('nothing is parked ambiguously near the line',
  !rows.some((r) => num(r.hp) > SENTINEL_HP * 0.1 && num(r.hp) < SENTINEL_HP * 100),
  `no species between ${(SENTINEL_HP * 0.1).toExponential(0)} and ${(SENTINEL_HP * 100).toExponential(0)}`);

// -------------------------------------------------------------------- honest

section('HONEST — the guard is instrumentation, not gameplay');

b = runWith(() => {
  playtest.recordSpawn(PLACEHOLDER);
  for (let i = 0; i < 78; i++) playtest.recordSpawn(7.9);
});
check('a dropped spawn is still COUNTED as a spawn', b.spawns === 79, `got ${b.spawns}`);

b = runWith(() => {
  playtest.recordDamage('lightning', PLACEHOLDER, { id: 'turtle' });
  playtest.recordKill({ id: 'turtle' }, 'lightning');
});
check('a dropped hit still credits its kill', b.killsBySource.lightning === 1);

// Zero and negative are the recorder's own guard, older than this one, but
// they share a function with it now and reordering those two early returns is
// exactly the kind of edit that lets one of them through.
b = runWith(() => {
  playtest.recordDamage('gun', -5, { id: 'x' });
  playtest.recordDamage('gun', 0, { id: 'x' });
  playtest.recordDamage('gun', 12, { id: 'x' });
});
check('non-positive damage is still refused', b.dealtBySource.gun === 12,
  `got ${b.dealtBySource.gun}`);

// ===========================================================================
// THE CAPTION'S OWN QUESTION — what actually killed this body?
//
// Separate from the kill LEDGER on purpose, and these checks are the line
// between them: recordKill credits the last damager (cheap, right over a run,
// and what the balance report wants), while damageCreditFor answers what the
// polaroid asks, which is what the fight was actually WON with.
// ===========================================================================

{
  const { sourceFamily } = await import('../path/src/systems/playtestAnalysis.js');

  playtest.beginRun({ playerMaxHp: 100 });
  const boss = { id: 'boss' };
  // Ninety seconds of clubbing, split four ways the way a real club build
  // books it — no single club tag beats the pellets, and together they bury
  // them.
  playtest.recordDamage('club', 400, boss);
  playtest.recordDamage('clubBoom', 300, boss);
  playtest.recordDamage('clubIce', 100, boss);
  playtest.recordDamage('clubThrow', 250, boss);
  playtest.recordDamage('gun', 500, boss);
  // ...and the pellet that happened to land last.
  playtest.recordDamage('gun', 1, boss);

  const credit = playtest.damageCreditFor(boss);
  check('the club line beats the weapon that out-damaged each of its tags',
    sourceFamily(credit) === 'club', `credited ${credit}`);
  // ...and it names the LOUDEST club, so the caption is specific rather than
  // just "a club".
  check('...and names the loudest club in it', credit === 'club', `credited ${credit}`);

  // THE FAMILY IS DECIDED BEFORE ANY MEMBER WINS. Picking the loudest single
  // source and then asking what family it is in is the exact bug this exists
  // to fix: `gun` is bigger than any one club tag here.
  const solo = { id: 'solo' };
  playtest.recordDamage('gun', 500, solo);
  playtest.recordDamage('club', 400, solo);
  check('a genuinely bigger weapon still wins', playtest.damageCreditFor(solo) === 'gun',
    `credited ${playtest.damageCreditFor(solo)}`);

  // LAST HIT IS NOT THE ANSWER any more, and this is the case that used to be
  // captioned wrong: a boss worn down by one thing and finished by an aura
  // tick.
  const worn = { id: 'worn' };
  playtest.recordDamage('club', 900, worn);
  playtest.recordDamage('garlic', 3, worn);
  check('the last tick does not steal the caption',
    playtest.damageCreditFor(worn) === 'club', `credited ${playtest.damageCreditFor(worn)}`);

  // A KILL WITH NO DAMAGE BEHIND IT still has a killer — the net haul. Falls
  // back to the last damager rather than to null, or a print that should say
  // "Bakalar's Boat" says nothing at all.
  const netted = { id: 'netted' };
  check('a body with no tally at all credits nobody', playtest.damageCreditFor(netted) === null,
    String(playtest.damageCreditFor(netted)));

  // SCENERY NEVER ENTERS THE TALLY. The claim is not that an invincible body
  // credits nobody — `lastDamager` moves for a placeholder on purpose, and the
  // note on recordDamage says why — it is that the figure a weapon *tried* to
  // deal cannot out-total a real one. Asserted by giving the scenery a huge
  // swing and a small real hit from something else: if the swing were tallied
  // it would win by two hundred to one, and the fallback cannot produce that
  // answer because the fallback is the LAST damager.
  const turtle = { id: 'turtle', invincible: true };
  playtest.recordDamage('club', 9999, turtle);
  playtest.recordDamage('gun', 1, turtle);
  check('a swing at scenery cannot out-total a real weapon',
    playtest.damageCreditFor(turtle) === 'gun',
    `credited ${playtest.damageCreditFor(turtle)}`);
  const sentinel = { id: 'sentinel' };
  playtest.recordDamage('club', PLACEHOLDER, sentinel);
  playtest.recordDamage('gun', 5, sentinel);
  check('...and neither does a sentinel-hp figure',
    playtest.damageCreditFor(sentinel) === 'gun', String(playtest.damageCreditFor(sentinel)));
}

console.log(failures === 0 ? '\nAll ledger checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
