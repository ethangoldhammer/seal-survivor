#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:attack
//
// TWO THINGS, and they are in one file because they are one bug report: "boss
// lunging and attacking is fundamentally broken", which turned out to be a
// missing instrument and a missing number.
//
//   1. THE INSTRUMENT — systems/attackTrace.js, the V panel's ledger. A
//      diagnostic that lies is worse than no diagnostic, because it certifies
//      the wrong fix. So this drives real lunges through the real state machine
//      and asserts that what comes out of the ledger is what actually happened:
//      the gate that was really shut, counted in SECONDS HELD rather than in
//      frames, logged on its edges rather than sixty times a second, and a
//      committed run scored on its closest approach rather than on its launch.
//
//   2. THE REACH FLOOR — CONFIG.enemyShot. A hostile shot's flight was
//      `speed x life`, both typed per gun, with nothing holding either against
//      the RANGE its gun opens up at. The boat's fish tier came out at 33 units
//      of flight against a 30-unit gun, so a shot fired at anything past point
//      blank chased a 9 u/s seal at two units a second and ran out of fuse
//      before it arrived. That is what "the boss shots die early" was.
//
// The shot's hp is here too, because it is the other half of the same change:
// a shot that can no longer be outrun has to be answerable some other way.
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { CONFIG } from '../path/src/config.js';
import { enemies, spawnNamed, updateEnemies, resetEnemies } from '../path/src/entities/enemies.js';
import { projectiles, resetProjectiles, spawnProjectile } from '../path/src/entities/projectiles.js';
import { fireBossShot } from '../path/src/systems/bossPerks.js';
import { resolveCombat } from '../path/src/systems/combat.js';
import { player, initPlayer, resetPlayer } from '../path/src/entities/player.js';
import {
  setAttackTrace, attackTraceOn, attackTraceReport, resetAttackTrace, GATES, attackStudy,
} from '../path/src/systems/attackTrace.js';

const scene = new THREE.Scene();
const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && /^\[(animation|assets|feedback|projectiles)\]/.test(msg)) return;
  realWarn(msg, ...rest);
};

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};
const section = (t) => console.log(`\n${t}`);

const dt = 1 / 60;
const MID = -20;

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** One hunter, one seal, the trace on, nothing else in the water. */
function trace(type, seed, { seconds = 40, from = { x: -14, y: MID }, at = () => ({ x: 0, y: MID }) } = {}) {
  const orig = Math.random;
  Math.random = seeded(seed);
  try {
    resetEnemies(scene);
    setAttackTrace(false);
    setAttackTrace(true);
    const e = spawnNamed(scene, type, 0, from, { ignoreCaps: true });
    if (!e) throw new Error(`could not spawn ${type}`);
    const pos = new THREE.Vector3();
    const steps = Math.round(seconds / dt);
    for (let i = 0; i < steps; i++) {
      const p = at(i * dt, e);
      pos.set(p.x, p.y, 0);
      // The trace's own clock is main.js's to advance; a harness driving
      // updateEnemies directly has to do the same or every dwell figure is zero
      // and the whole ledger reads as empty. Imported from the module rather
      // than faked, so a change to how the clock works fails here.
      tick(dt);
      updateEnemies(dt, scene, pos, () => {}, () => {});
      if (!enemies.includes(e)) break;
    }
    return { e, report: attackTraceReport() };
  } finally {
    Math.random = orig;
    setAttackTrace(false);
  }
}

const { tickAttackTrace: tick } = await import('../path/src/systems/attackTrace.js');

// The seal has to exist before resolveCombat can be driven — every pass in that
// file measures against player.mesh.position, and a null one throws before the
// first check rather than failing it.
initPlayer(scene);
resetPlayer();

// ---------------------------------------------------------------------------
section('1. OFF IS FREE, AND OFF IS THE DEFAULT');
// ---------------------------------------------------------------------------
check('nothing is recorded until something asks for it', !attackTraceOn());
{
  // Every hook returns on its first line when the trace is off. Driven rather
  // than asserted on the source: the property that matters is that a fight runs
  // with an empty ledger, not that each function happens to start with a guard.
  resetAttackTrace();
  const before = attackTraceReport();
  const orig = Math.random;
  Math.random = seeded(9);
  resetEnemies(scene);
  const e = spawnNamed(scene, 'bossShark', 0, { x: -14, y: MID }, { ignoreCaps: true });
  const pos = new THREE.Vector3(0, MID, 0);
  for (let i = 0; i < 600 && enemies.includes(e); i++) updateEnemies(dt, scene, pos, () => {}, () => {});
  Math.random = orig;
  const after = attackTraceReport();
  check('...and a whole fight with it off leaves the ledger empty',
    after.events.length === 0 && after.gates.length === 0 && after.tally.winds === 0,
    `${after.events.length} events, ${after.gates.length} gates, ${after.tally.winds} wind-ups`);
  check('...including the clock, which only main.js advances', after.clock === before.clock);
}

// ---------------------------------------------------------------------------
section('2. THE GATE NAMES ARE THE ONES THE BEHAVIOUR USES');
// ---------------------------------------------------------------------------
// Asserted against the SOURCE, because this is the one thing a driven test
// cannot catch: a gate renamed in enemies.js and not in GATES reports under a
// name the panel has no explanation for, and the row renders blank rather than
// failing. See lungeChase.
{
  const src = readFileSync(new URL('../path/src/entities/enemies.js', import.meta.url), 'utf8');
  // Scoped to the two functions that decide a gate, so a quoted word anywhere
  // else in a five-thousand-line file cannot be mistaken for one. Everything
  // quoted in that region is either a gate or one of the lunge machine's own
  // stage names, and those are named here rather than pattern-matched: a stage
  // that turns into a gate should fail this, loudly.
  const from = src.indexOf('function lungeLineGate');
  const to = src.indexOf('const BEHAVIORS = {');
  check('the gate functions are still where this reads them', from > 0 && to > from);
  const region = src.slice(from, to);
  const STAGES = new Set(['strike', 'reaim', 'rest', 'wind', 'cruise', 'boost', 'swim', 'pass', 'double', 'feint']);
  const named = new Set();
  for (const m of region.matchAll(/'([a-z][a-zA-Z]*)'/g)) {
    if (!STAGES.has(m[1])) named.add(m[1]);
  }
  // No exemptions. attackTraceReport builds its table by mapping over GATES, so
  // a gate the behaviour reports and this list does not name is DROPPED from the
  // panel entirely — it does not render wrong, it renders absent, which is the
  // worst failure an instrument has. `budget` was exactly that for one commit.
  const missing = [...named].filter((g) => !GATES.includes(g));
  check('every gate the behaviour can report has a name in GATES',
    missing.length === 0, missing.length ? `not in GATES: ${missing.join(', ')}` : `${named.size} found: ${[...named].join(', ')}`);
  // ...and the other way round, which catches the rename rather than the
  // addition: a gate renamed in enemies.js leaves a dead row in GATES that can
  // never fire, and a panel row that is always 0% reads as "this never happens".
  const orphans = GATES.filter((g) => !named.has(g));
  check('...and every name in GATES is one the behaviour still uses',
    orphans.length === 0, orphans.length ? `nothing reports: ${orphans.join(', ')}` : 'none dead');

  const panel = readFileSync(new URL('../path/src/ui/attackDebug.js', import.meta.url), 'utf8');
  const explained = new Set([...panel.matchAll(/^ {2}([a-zA-Z]+): '/gm)].map((m) => m[1]));
  const unexplained = GATES.filter((g) => !explained.has(g));
  check('...and a line in the panel saying what it means',
    unexplained.length === 0, unexplained.length ? `no note for: ${unexplained.join(', ')}` : 'all of them');
}

// ---------------------------------------------------------------------------
section('3. DWELL IS SECONDS, AND EDGES ARE EVENTS');
// ---------------------------------------------------------------------------
// The two rules that make the ledger readable rather than a wall. A shark held
// off for nine seconds is ONE decision the panel has to be able to name, not
// 540 log lines that bury the one refusal you are hunting.
{
  // A seal parked far outside the range: the gate is `range` and never moves.
  const { report } = trace('bossShark', 3, {
    seconds: 6, from: { x: -60, y: MID }, at: () => ({ x: 60, y: MID }),
  });
  const range = report.gates.find((g) => g.gate === 'range');
  // The property is that it is a CLOCK, not a count: 360 frames of refusal
  // would report 360 if this were a tally. The dwell is short of the full six
  // seconds because the boss spends its arrival `entering`, which is before the
  // lunge machine runs at all — that is the ledger being honest about when the
  // fight actually started.
  check('a gate that never opens is reported in seconds, not frames',
    range != null && range.seconds > 1 && range.seconds <= 6.02,
    range ? `${range.seconds.toFixed(1)}s of a 6s run, over 360 frames` : 'no `range` dwell at all');
  const gateEvents = report.events.filter((e) => e.kind === 'gate');
  check('...and logged once, on its edge',
    gateEvents.length <= 2, `${gateEvents.length} gate events over 360 frames`);
  check('...and it is the whole of the fight',
    range != null && range.share > 0.98, range ? `${Math.round(range.share * 100)}%` : '—');
}

// ---------------------------------------------------------------------------
section('4. A RUN IS SCORED ON WHERE IT GOT TO');
// ---------------------------------------------------------------------------
{
  // A seal sitting still inside the window: the boss commits, and the run
  // should end up ON it. This is the measurement "is it aiming at me" needs —
  // the launch angle proves nothing, because the whole pass is a turn.
  const { report } = trace('bossShark', 7, {
    seconds: 45, from: { x: -18, y: MID }, at: () => ({ x: 0, y: MID }),
  });
  const runs = report.events.filter((e) => e.kind === 'run');
  check('the boss committed at all', report.tally.commits > 0,
    `${report.tally.winds} wind-ups, ${report.tally.commits} runs`);
  check('...and every finished run reported a closest approach',
    runs.length > 0 && runs.every((r) => typeof r.extra?.closest === 'number'),
    `${runs.length} runs scored`);
  const best = Math.min(...runs.map((r) => r.extra.closest));
  check('...and at least one of them got to the seal',
    Number.isFinite(best) && best < 8, `closest run came within ${best.toFixed(1)}u`);
  check('a plan is counted once and its strikes separately',
    report.tally.plans > 0 && report.tally.commits >= report.tally.plans,
    `${report.tally.plans} plans, ${report.tally.commits} runs`);
}

// ---------------------------------------------------------------------------
section('4b. A BOSS DOES NOT QUEUE BEHIND ITS OWN ESCORTS');
// ---------------------------------------------------------------------------
// THE BUG THE LEDGER FOUND, and the reason it needed finding rather than
// reasoning about. The feeding ring (systems/apexCrowd.js) ranks apex bodies on
// pure distance and seats the nearest two; a lunging boss deliberately holds
// the ring OUTSIDE its own minRange so it can open the gap a run needs, so it
// was systematically the furthest body in the water and lost the slot to its
// own escorts. `npm run gates -- --escorts 5` measured it at 75-85% of the
// fight refused on `crowd`, with the run rate roughly halved.
//
// Driven with escorts present, because with an empty arena the gate reports 0%
// however broken it is — a solo boss always held a slot, which is exactly what
// the comment in lungeChase claimed and exactly why it went unnoticed.
{
  const orig = Math.random;
  const withEscorts = (type, seed, escorts) => {
    Math.random = seeded(seed);
    try {
      resetEnemies(scene);
      setAttackTrace(false);
      setAttackTrace(true);
      const e = spawnNamed(scene, type, 6, { x: -20, y: MID }, { ignoreCaps: true });
      // The flag the ring seats on. Written by hand here for the same reason
      // tools/boss-dodge-test.mjs writes it: forceBoss runs a three-second
      // arrival ceremony that a batch of fights cannot afford, and being a boss
      // is what is under test.
      e.isBoss = true;
      for (let k = 0; k < escorts; k++) {
        const a = (k / Math.max(1, escorts)) * Math.PI * 2;
        spawnNamed(scene, 'shark', 6, { x: Math.cos(a) * 12, y: MID + Math.sin(a) * 6 }, { ignoreCaps: true });
      }
      const pos = new THREE.Vector3();
      for (let i = 0; i < Math.round(60 / dt) && enemies.includes(e); i++) {
        const t = i * dt;
        pos.set(Math.cos(t * 0.6) * 13, MID + Math.sin(t * 0.9) * 6, 0);
        tick(dt);
        updateEnemies(dt, scene, pos, () => {}, () => {});
      }
      return attackTraceReport(e);
    } finally {
      Math.random = orig;
      setAttackTrace(false);
    }
  };

  let crowdShare = 0;
  let commits = 0;
  let seconds = 0;
  for (const seed of [11, 12, 13, 14]) {
    const rep = withEscorts('bossShark', seed, 5);
    crowdShare += rep.gates.find((g) => g.gate === 'crowd')?.share ?? 0;
    commits += rep.tally.commits;
    seconds += rep.clock;
  }
  crowdShare /= 4;
  check('a boss with five escorts is never held off by the feeding ring',
    crowdShare < 0.01, `${Math.round(crowdShare * 100)}% of the fight on \`crowd\` (was 76%)`);
  check('...and it still commits at a real rate with a crowd around it',
    (commits / seconds) * 60 > 3.5, `${((commits / seconds) * 60).toFixed(1)} runs a minute (was 3.0)`);
  // The escorts are NOT seated — the ring still rotates for everything that is
  // not the fight, which is the whole point of the mechanism.
  const src = readFileSync(new URL('../path/src/systems/apexCrowd.js', import.meta.url), 'utf8');
  check('...and it is seated rather than exempted, so the escorts still avoid it',
    /e\.boss === true/.test(src) && !/if \(e\.boss\) continue/.test(src));
  const enemiesSrc = readFileSync(new URL('../path/src/entities/enemies.js', import.meta.url), 'utf8');
  check('...on a flag read live off the body, not baked at spawn',
    /v\.boss = e\.isBoss === true;/.test(enemiesSrc));
}

// ---------------------------------------------------------------------------
section('5. THE STUDY SWITCHES BELONG TO THE PANEL, NOT TO THE FIGHT');
// ---------------------------------------------------------------------------
{
  attackStudy.noDamage = true;
  attackStudy.soloBoss = true;
  resetAttackTrace();
  check('a new fight does not clear them — a restart mid-study keeps the study',
    attackStudy.noDamage === true && attackStudy.soloBoss === true);
  setAttackTrace(true);
  setAttackTrace(false);
  check('...and closing the panel does, so nothing is left invincible',
    attackStudy.noDamage === false && attackStudy.soloBoss === false);
  const src = readFileSync(new URL('../path/src/main.js', import.meta.url), 'utf8');
  check('main.js still swallows damage on the flag, above the i-frame window',
    /if \(attackStudy\.noDamage\) return 0;/.test(src)
    && src.indexOf('attackStudy.noDamage') < src.indexOf("if (channel === 'strike')"));
}

// ---------------------------------------------------------------------------
section('6. EVERY GUN CAN REACH THE RANGE IT FIRES FROM');
// ---------------------------------------------------------------------------
// The regression that started this. Measured through the real fireBossShot
// rather than from the numbers, so a change to how the floor is applied fails
// here instead of reading as tuned.
{
  const es = CONFIG.enemyShot;
  const origin = new THREE.Vector3(0, MID, 0);
  const fire = (gun, { speed, life, range, damage = 5, difficulty = 0 }) => {
    resetProjectiles(scene);
    fireBossShot(scene, {
      gun, origin, dirX: 1, dirY: 0, damage, speed, life, range, difficulty, source: 'test',
    });
    return projectiles[projectiles.length - 1];
  };

  const plain = { radius: 0.4, asset: 'enemyFish', scale: 1 };
  const g = CONFIG.boats.guns;
  const tiers = g.tiers ?? [];
  for (const tier of tiers) {
    const p = fire(plain, { speed: tier.speed, life: tier.life, range: g.range });
    const flew = p.life * p.speed;
    check(`the deck gun's ${tier.id} tier out-flies the gun's own range`,
      flew >= g.range * es.reachMul - 0.01,
      `${flew.toFixed(0)}u of flight against a ${g.range}u gun (x${(flew / g.range).toFixed(1)})`);
  }
  check('...which is the fix: the fish tier used to fly 1.1x its own range',
    (tiers[0].speed * tiers[0].life) / g.range < 1.2,
    `authored ${(tiers[0].speed * tiers[0].life).toFixed(0)}u against ${g.range}u`);

  // A fused shot keeps its fuse. A barrel is thrown to a PLACE.
  const fused = { ...plain, fuse: true };
  const p = fire(fused, { speed: 12, life: 1.1, range: 22 });
  check('a fused shot is exempt — a barrel still goes off where it was thrown',
    Math.abs(p.life - 1.1) < 1e-6, `${p.life.toFixed(2)}s, unchanged`);

  // A gun with no range at all is untouched.
  const noRange = fire(plain, { speed: 10, life: 2, range: 0 });
  check('...and so is a shot fired from a gun with no range', Math.abs(noRange.life - 2) < 1e-6);

  // The authored life still wins where it is the longer of the two.
  const generous = fire(plain, { speed: 10, life: 99, range: 10 });
  check('an already-generous life is never shortened', Math.abs(generous.life - 99) < 1e-6);
}

// ---------------------------------------------------------------------------
section('7. AND THEY CAN BE SHOT OUT OF THE AIR');
// ---------------------------------------------------------------------------
{
  // THE WATER HAS TO BE EMPTY FIRST. Section 4b leaves a boss and five escorts
  // in it, and `resolveCombat` runs player-bullets-vs-ENEMIES before it gets to
  // player-bullets-vs-shots — so a body that happens to be under the muzzle
  // eats the pellet and this section reports the shot as unclearable. It stayed
  // green for as long as those six bodies happened to drift elsewhere, and
  // started failing on a boss retune that changed nothing about projectiles:
  // the classic shared-fixture failure, where the section that breaks is not
  // the section that changed.
  resetEnemies(scene);
  const es = CONFIG.enemyShot;
  const origin = new THREE.Vector3(0, MID, 0);
  const gun = { radius: 0.4, asset: 'enemyFish', scale: 1 };
  const fireOne = (damage, difficulty) => {
    resetProjectiles(scene);
    fireBossShot(scene, {
      gun, origin, dirX: 1, dirY: 0, damage, speed: 10, life: 3, range: 20, difficulty, source: 'test',
    });
    return projectiles[projectiles.length - 1];
  };

  const easy = fireOne(5, 0);
  const late = fireOne(5, 10);
  const heavy = fireOne(30, 0);
  check('a hostile shot carries hp', easy.hp > 0, `${easy.hp.toFixed(1)} at difficulty 0`);
  check('...that ramps with the run', late.hp > easy.hp * 1.5,
    `${easy.hp.toFixed(1)} at difficulty 0, ${late.hp.toFixed(1)} at 10`);
  check('...and with what the shot is worth', heavy.hp > easy.hp,
    `a 5-damage shot is ${easy.hp.toFixed(1)}, a 30-damage one ${heavy.hp.toFixed(1)}`);
  check('...and hpMax is kept beside it, for anything drawing how broken it is',
    easy.hpMax === easy.hp);

  // The combat pass. A pellet placed on top of a hostile shot clears it.
  resetProjectiles(scene);
  player.mesh.position.set(0, MID - 40, 0);
  fireBossShot(scene, {
    gun, origin, dirX: 1, dirY: 0, damage: 5, speed: 10, life: 3, range: 20, difficulty: 0, source: 'test',
  });
  const target = projectiles[0];
  spawnProjectile(scene, {
    origin, dir: new THREE.Vector3(1, 0, 0), faction: 'player',
    damage: target.hp + 1, speed: 0, life: 5, radius: 0.5, source: 'test',
  });
  const before = projectiles.length;
  resolveCombat(dt, scene, {
    onEnemyDamaged: () => {}, onEnemyKilled: () => {}, onPlayerHit: () => 0,
  });
  check('a player pellet clears a hostile shot', !projectiles.includes(target),
    `${before} projectiles before, ${projectiles.length} after`);
  check('...and is spent doing it', projectiles.length === 0,
    `${projectiles.length} left`);

  // A pellet with pierce to spend carries on through.
  resetProjectiles(scene);
  for (let i = 0; i < 3; i++) {
    fireBossShot(scene, {
      gun, origin, dirX: 1, dirY: 0, damage: 5, speed: 0, life: 3, range: 20, difficulty: 0, source: 'test',
    });
  }
  const shots = projectiles.length;
  spawnProjectile(scene, {
    origin, dir: new THREE.Vector3(1, 0, 0), faction: 'player',
    damage: 999, speed: 0, life: 5, radius: 0.5, pierce: 2, source: 'test',
  });
  resolveCombat(dt, scene, {
    onEnemyDamaged: () => {}, onEnemyKilled: () => {}, onPlayerHit: () => 0,
  });
  const left = projectiles.filter((p) => p.faction === 'enemy').length;
  check('a piercing pellet clears more than one, and no more than it paid for',
    shots === 3 && left === 0, `${shots} stacked, ${left} left`);

  // ...and switching it off puts every gun back the way it was.
  const wasDestructible = es.destructible;
  es.destructible = false;
  resetProjectiles(scene);
  fireBossShot(scene, {
    gun, origin, dirX: 1, dirY: 0, damage: 5, speed: 10, life: 3, range: 20, difficulty: 0, source: 'test',
  });
  check('switched off, a hostile shot carries no hp and no pass touches it',
    projectiles[0].hp === 0);
  es.destructible = wasDestructible;
  resetProjectiles(scene);
}

// ---------------------------------------------------------------------------
section('8. THE LEDGER COUNTS WHAT A SHOT DID, NOT JUST THAT IT WENT AWAY');
// ---------------------------------------------------------------------------
// "The shots vanish" is four different bugs — a fuse too short, a volley aimed
// past the wall, a hit, a swat — and they want four different fixes. Filing all
// four under one counter is what made the first of them invisible.
{
  const t = attackTraceReport().tally;
  const keys = ['shotsFired', 'shotsExpired', 'shotsLeft', 'shotsHitPlayer', 'shotsKilled'];
  check('the four ways a shot ends are counted apart',
    keys.every((k) => k in t), keys.join(', '));
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
