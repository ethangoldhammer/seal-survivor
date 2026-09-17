#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:ricochet
//
// THE PUNTED CRAB. A crab the seal has hit is a thrown object, and this file
// measures the whole chain that makes that true — because every link in it
// fails silently, and three of them did.
//
//   1. THE THROW      A crab's authored radius is 0.2 (a stance, not a
//                     silhouette — see the note on CONFIG.enemies.walkingCrab
//                     .radius), which put it under `heavy.minRadius` and gave
//                     it the ordinary knock: 34 u/s decaying at 12, or 2.8
//                     units of travel against a body four units wide. The
//                     shove existed, was correct, and could not move a crab
//                     out of its own footprint.
//   2. THE CONTACT    resolveCrabCollisions measured closing speed off `vx/vy`
//                     alone, which is what a crab is WALKING at. A shove lives
//                     in `knockX/knockY`. So a crab travelling a hundred units
//                     a second was resolved as one walking at three, and
//                     passed through the heap it should have scattered.
//   3. THE DAMAGE     ...and nothing was ever billed for it.
//
// Everything here comes from ticking the same updateEnemies main.js ticks. No
// renderer: the browser preview suspends requestAnimationFrame, so a
// screenshot of this game proves nothing about whether its loop works.
//
//   node --import ./tools/vite-loader.mjs tools/crab-ricochet-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { bounds } from '../path/src/arena.js';
import {
  enemies, spawnNamed, updateEnemies, resetEnemies, applyKnockback, drainCrabRicochets,
} from '../path/src/entities/enemies.js';
import { deathState } from '../path/src/systems/deathDive.js';
import { feedback, onFeedback } from '../path/src/systems/feedback.js';
import { readFileSync } from 'node:fs';

// SEEDED, and for the reason tools/crab-crowd-test.mjs spells out: a crab's
// spawn scale, its depth lane, its rest angle and which way it wanders are all
// dice, and every one of them decides whether two bodies meet. Unseeded, the
// same scenario alternately lands a direct hit and misses by a lane — which
// reads as a flaky mechanic rather than as a flaky harness. Installed before
// anything spawns.
let seed = 0x0c4ab0ff;
Math.random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const SEED = seed;
const reseed = () => { seed = SEED; };

const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[animation]') || msg.startsWith('[assets]'))) return;
  realWarn(msg, ...rest);
};

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const scene = new THREE.Scene();
const DT = 1 / 60;
const FLOOR = bounds.bottom;

// Far above the seabed, so nothing in here is ever a crab noticing the player.
// `crawl` has a rush band a dozen units off the floor and it would turn every
// measurement below into a chase.
const player = { mesh: new THREE.Object3D(), stats: { pickupRadius: 0.0001, chumGulpRadius: 0, hitRadius: 1.2 } };
player.mesh.position.set(0, bounds.top - 2, 0);

// RESEEDED LAST, AFTER the teardown, which is not a detail. `resetEnemies`
// hands every live creature's visual back to the pool, and that path draws —
// so a scenario torn down with two crabs in the water leaves the generator in
// a different place from one torn down with one, and the "identical" setup
// that follows spawns different bodies at different depths. Two blocks of the
// same code disagreed by exactly that, which reads as the mechanic being
// unreliable rather than the harness.
function reset() {
  resetEnemies(scene);
  drainCrabRicochets(null); // anything a previous scenario left behind
  deathState.active = false;
  reseed();
}

// ONE LANE AND ONE HEIGHT. The depth spread is a real feature (a third of
// random pairs pass through each other on purpose — see test:crabs) and it is
// exactly what must not be under test here: a miss caused by a lane is
// indistinguishable, in a number, from a ricochet that does not work.
function crabAt(x, y, id = 'walkingCrab') {
  const e = spawnNamed(scene, id, 0, { x, y }, { ignoreCaps: true });
  e.entering = false;
  e.mesh.position.z = 0;
  e.laneZ = 0;
  return e;
}
function hold(list) {
  for (const e of list) { e.mesh.position.z = 0; e.laneZ = 0; }
}

// Ticks the real loop and collects what the collision pass queued, which is
// exactly what main.js's processCrabRicochets drains.
// A SHOVE HAS TO BE MEASURED WHILE IT IS HAPPENING. `knockX` decays to
// nothing in about a second, so reading it after the loop always answers zero
// — which looks exactly like a shove that was never handed on. The peak per
// crab is recorded as the frames go by, and `hits` carries the same list
// main.js's processCrabRicochets drains.
function run(list, frames, onHit = null) {
  const hits = [];
  const peak = new Map(list.map((e) => [e, 0]));
  for (let f = 0; f < frames; f++) {
    updateEnemies(DT, scene, player.mesh.position, () => {}, () => {});
    drainCrabRicochets((h) => { hits.push({ ...h, frame: f }); onHit?.(h); });
    hold(list);
    for (const e of list) peak.set(e, Math.max(peak.get(e) ?? 0, Math.hypot(e.knockX ?? 0, e.knockY ?? 0)));
  }
  hits.peak = (e) => peak.get(e) ?? 0;
  return hits;
}

// The damage half, as main.js applies it — kept here rather than imported
// because importing main.js means importing the renderer. The arithmetic is
// the same three lines (`hp -= damage`, and the pair is billed once each).
function applyDamage(hits) {
  for (const h of hits) for (const [e, dmg] of [[h.a, h.damageA], [h.b, h.damageB]]) {
    if (e.isBoss || e.invincible) continue;
    e.hp -= Math.min(dmg, Math.max(0, e.hp));
  }
}

// ===========================================================================
section('THE THROW — a ram moves a crab further than its own body');
// ===========================================================================
reset();
{
  const one = crabAt(0, FLOOR + 1);
  const start = one.mesh.position.x;
  applyKnockback(one, 1, 0, 1, { source: 'ram' });
  const launch = one.knockX;
  run([one], 90);
  const travel = one.mesh.position.x - start;

  // The number the old build produced, kept as the bar rather than as a note:
  // 2.8 units, against a crab that draws about 4 wide. Anything at or under
  // its own body is a shove nobody can see.
  const body = one.radius * 2;
  check('a full-charge ram launches it properly', launch > 90, `${launch.toFixed(0)} u/s`);
  check('...on the shell class rather than the ordinary knock',
    Math.abs(one.knockDecay - CONFIG.crabPhysics.knock.decay) < 1e-9,
    `decay ${one.knockDecay} (ordinary is ${CONFIG.strike.knockback.decay})`);
  check('...and it travels several body-lengths', travel > body * 4,
    `${travel.toFixed(1)} units, body ${body.toFixed(1)}`);
  check('...without leaving the arena', one.mesh.position.x < bounds.right,
    `ends at x ${one.mesh.position.x.toFixed(1)}`);
  check('...and it tumbles on the way', Math.abs(one.tumble) > 1e-3 || Math.abs(one.tumbleVel) > 1e-3);
}

// ===========================================================================
section('THE CONTACT — the crowd can see a thrown crab coming');
// ===========================================================================
reset();
{
  const a = crabAt(-6, FLOOR + 1);
  const b = crabAt(0, FLOOR + 1);
  applyKnockback(a, 1, 0, 1, { source: 'ram' });
  const hits = run([a, b], 120);

  check('the pair ricochets', hits.length > 0, `${hits.length} hit(s)`);
  check('...at a speed the walk could never reach',
    hits.length > 0 && hits[0].speed > CONFIG.enemies.walkingCrab.speed * 3,
    hits.length ? `${hits[0].speed.toFixed(0)} u/s against a walk of ${CONFIG.enemies.walkingCrab.speed}` : '');
  check('...once, not once per frame of contact', hits.length <= 2, `${hits.length} over 2 seconds`);
  check('...and the shove is HANDED ON to what it hit',
    hits.peak(b) > 5, `the struck crab leaves at ${hits.peak(b).toFixed(0)} u/s`);
  check('...carrying the thrower\'s falloff, not the ordinary one',
    b.knockDecay <= CONFIG.crabPhysics.knock.decay + 1e-9,
    `decay ${b.knockDecay}`);
}

// ===========================================================================
section('THE DAMAGE — and what it costs the crowd');
// ===========================================================================
reset();
{
  const a = crabAt(-6, FLOOR + 1);
  const b = crabAt(0, FLOOR + 1);
  const bHp = b.hp;
  const hits = run([a, b], 120);
  check('...(control) two crabs that were never hit ricochet at all', hits.length === 0,
    `${hits.length} hit(s) from a crowd walking at ${CONFIG.enemies.walkingCrab.speed}`);
  check('...(control) and neither loses a point of health', b.hp === bHp);
}

reset();
{
  const a = crabAt(-6, FLOOR + 1);
  const b = crabAt(0, FLOOR + 1);
  const bHp = b.hp;
  applyKnockback(a, 1, 0, 1, { source: 'ram' });
  const hits = run([a, b], 120);
  applyDamage(hits);
  const dealt = bHp - b.hp;
  check('a punted crab hurts what it lands on', dealt > 0, `${dealt.toFixed(1)} of ${bHp.toFixed(0)} hp`);
  // MOST of a crab, not necessarily all of it — where in the throw the contact
  // happens is geometry, and at two body-lengths out the shove has already
  // decayed. Point blank takes the cap; this is the honest middle of the curve.
  check('...for most of its health', dealt > bHp * 0.5, `${((dealt / bHp) * 100).toFixed(0)}% of its bar`);
  check('...and never more than the ceiling',
    dealt <= CONFIG.crabPhysics.ricochet.maxDamage + 1e-9,
    `cap ${CONFIG.crabPhysics.ricochet.maxDamage}`);
  check('...the thrower takes it too — a shell meeting a shell hurts both',
    a.hp < a.maxHp, `${(a.maxHp - a.hp).toFixed(1)} back on the crab that was thrown`);
  // ...but LESS, so it ploughs on. A pair that destroyed each other on contact
  // would make a punt worth exactly one crab, which is the mechanic without
  // the part worth watching.
  check('...but less than it dealt, so it carries on through',
    (a.maxHp - a.hp) < dealt - 1e-9,
    `${(a.maxHp - a.hp).toFixed(1)} against ${dealt.toFixed(1)}`);
  check('...and survives its first contact', a.hp > 0, `${a.hp.toFixed(1)} hp left`);
}

// A CROWD IS SCATTERED, not just the one body in front. This is the whole
// point of handing the shove on, and the thing that cannot be measured on a
// pair.
reset();
{
  const line = [];
  for (let i = 0; i < 6; i++) line.push(crabAt(-4 + i * 1.6, FLOOR + 1));
  const thrown = crabAt(-14, FLOOR + 1);
  const all = [thrown, ...line];
  const beforeX = line.map((e) => e.mesh.position.x);
  applyKnockback(thrown, 1, 0, 1, { source: 'ram' });
  const hits = run(all, 150);
  applyDamage(hits);
  const moved = line.filter((e, i) => e.mesh.position.x - beforeX[i] > 2).length;
  const hurt = line.filter((e) => e.hp < e.maxHp).length;
  check('one punt reaches more than the first body in the line', hits.length >= 2,
    `${hits.length} ricochet(s) through a line of 6`);
  check('...the crowd is visibly scattered', moved >= 2, `${moved} of 6 shoved 2+ units downrange`);
  check('...and more than one of them is hurt', hurt >= 2, `${hurt} of 6 took damage`);
  check('...but it does not clear the seabed', hurt < line.length,
    `${line.length - hurt} of 6 untouched`);
}

// ===========================================================================
section('WHAT MAY NEVER BILL A POINT OF IT');
// ===========================================================================
// A heap under `gravity` reaches ten units a second on its own, which is
// comfortably past what a crab walks at — so a gate written against the WHOLE
// closing speed would have made a tower quietly lethal to itself. The gate is
// on the knock's share alone.
reset();
{
  const bottom = crabAt(0, FLOOR + 1);
  const dropped = crabAt(0.2, FLOOR + 9);
  const hits = run([bottom, dropped], 180);
  check('a crab falling off a stack onto another does no damage', hits.length === 0,
    `fell ${(FLOOR + 9 - dropped.mesh.position.y).toFixed(1)} units, ${hits.length} ricochet(s)`);
  check('...and the pair is undamaged', bottom.hp === bottom.maxHp && dropped.hp === dropped.maxHp);
}

// The pile-on is the last thing the player watches, not a mechanic — and a
// kill booked here would be filed against a run that has already been scored.
reset();
{
  deathState.active = true;
  const a = crabAt(-6, FLOOR + 1);
  const b = crabAt(0, FLOOR + 1);
  applyKnockback(a, 1, 0, 1, { source: 'ram' });
  const hits = run([a, b], 120);
  check('nothing ricochets while the seal is dead', hits.length === 0, `${hits.length} hit(s)`);
  deathState.active = false;
}

// The king crab shoulders the swarm around; the swarm does not chip it down.
reset();
{
  const boss = crabAt(0, FLOOR + 1, 'bossCrab');
  boss.isBoss = true;
  const thrown = crabAt(-7, FLOOR + 1);
  const bossHp = boss.hp;
  applyKnockback(thrown, 1, 0, 1, { source: 'ram' });
  const hits = run([boss, thrown], 120);
  applyDamage(hits);
  check('a crab punted into the king crab does not damage it', boss.hp === bossHp,
    `${hits.length} contact(s), boss on ${boss.hp.toFixed(0)} hp`);
  check('...but the crab that hit it takes the hit', hits.length === 0 || thrown.hp < thrown.maxHp);
}

// The switch, because a mechanic you cannot turn off cannot be A/B'd.
reset();
{
  const was = CONFIG.crabPhysics.ricochet.enabled;
  CONFIG.crabPhysics.ricochet.enabled = false;
  const a = crabAt(-6, FLOOR + 1);
  const b = crabAt(0, FLOOR + 1);
  applyKnockback(a, 1, 0, 1, { source: 'ram' });
  const hits = run([a, b], 120);
  CONFIG.crabPhysics.ricochet.enabled = was;
  check('the toggle switches the damage off', hits.length === 0, `${hits.length} hit(s)`);
  check('...and the shove still lands — it is the DAMAGE that is optional',
    hits.peak(b) > 1, `the struck crab carries ${hits.peak(b).toFixed(1)} u/s`);
}

// ===========================================================================
section('THE CROWD IS UNCHANGED — nothing here may retune a heap');
// ===========================================================================
// The exchange is split by how much of the closing speed was a KNOCK, so a
// crowd with no knock in it passes zero and lands entirely in `vx/vy`, exactly
// as it did before any of this existed. Measured rather than argued: a heap
// that quietly stopped stacking would pass every check above.
reset();
{
  const heap = [];
  for (let i = 0; i < 8; i++) heap.push(crabAt(-1.5 + i * 0.4, FLOOR + 1));
  run(heap, 120);
  const above = heap.filter((e) => e.mesh.position.y > FLOOR + e.radius + 0.4).length;
  check('a crowd shoved into one spot still climbs', above >= 2,
    `${above} of 8 riding above floor height`);
  const anyKnock = heap.some((e) => Math.abs(e.knockX ?? 0) > 0.01 || Math.abs(e.knockY ?? 0) > 0.01);
  check('...and none of it leaks into the knock channel', !anyKnock);
}

// ===========================================================================
section('THE SHELL HAS A VOICE');
// ===========================================================================
// playSfx returns quietly for a name it does not know, so a voice that was
// never written is not an error — it is a crab that dies in silence. Every
// route is walked: def -> event -> CONFIG.sfx entry -> something that can
// actually make a noise. The same check tools/boss-voice-test.mjs makes for
// the three material classes.
{
  const crabs = ['walkingCrab', 'emberCrab', 'dancingcrab'];
  for (const id of crabs) {
    const def = CONFIG.enemies[id];
    check(`${id} declares a voice`, !!(def?.voice?.hit && def?.voice?.die),
      def?.voice ? `${def.voice.hit} / ${def.voice.die}` : 'none');
  }
  for (const name of ['crabHit', 'crabDie']) {
    const ev = CONFIG.feedback[name];
    check(`feedback.${name} exists and names a sound`, !!ev && !!ev.sfx, ev?.sfx ?? 'missing');
    const voice = ev?.sfx ? CONFIG.sfx[ev.sfx] : null;
    check(`...and sfx.${ev?.sfx ?? name} can actually sound`,
      !!voice && (voice.type != null || voice.src != null || (voice.srcs?.length > 0)),
      voice ? `type ${voice.type}, gain ${voice.gain}` : 'no entry');
    // The boss's shell is a different body. Sharing the entry would mean
    // retuning a king crab every time the swarm got too loud.
    check(`...and it is not just bossHit/DieShell under another name`,
      ev?.sfx !== 'bossHitShell' && ev?.sfx !== 'bossDieShell');
  }
  // Quieter and shorter than the boss's, which is the entire argument for
  // having a second pair: nine of these land in a second.
  check('the swarm shell is quieter than the boss shell',
    CONFIG.sfx.crabHit.gain < CONFIG.sfx.bossHitShell.gain,
    `${CONFIG.sfx.crabHit.gain} vs ${CONFIG.sfx.bossHitShell.gain}`);
  check('...and shorter', CONFIG.sfx.crabHit.decay < CONFIG.sfx.bossHitShell.decay,
    `${CONFIG.sfx.crabHit.decay}s vs ${CONFIG.sfx.bossHitShell.decay}s`);
  // A boss must never take the swarm's voice: it has its own, and firing both
  // would be two impact sounds on one frame.
  check('the king crab does not carry the swarm voice', !CONFIG.enemies.bossCrab.voice);

  // ...AND THE EVENT IS NOT MUTE. A saved null in imported-tuning.json beats
  // the literal in config.js, so an entry can exist, be reached, and do
  // nothing — the failure mode that looks exactly like working code.
  const heard = [];
  const stop = onFeedback((event) => heard.push(event));
  feedback('crabHit', { x: 0, y: 0 });
  feedback('crabDie', { x: 0, y: 0 });
  stop();
  check('both voices actually fire', heard.includes('crabHit') && heard.includes('crabDie'),
    heard.join(', ') || 'nothing');

  // THE LINK THIS HARNESS CANNOT TICK. main.js is where `voice` is read, and
  // importing it means importing the renderer — so the branch is checked by
  // reading it. It is two lines and it is the whole wiring: delete it and
  // every check above still passes while no crab makes a sound.
  const mainSrc = readFileSync(new URL('../path/src/main.js', import.meta.url), 'utf8');
  check('main.js fires a creature\'s hit voice', /voice\?\.hit/.test(mainSrc));
  check('main.js fires a creature\'s die voice', /voice\?\.die/.test(mainSrc));
  check('...and drains the ricochet queue', /drainCrabRicochets\(/.test(mainSrc));
}

console.log(failures === 0 ? '\nPASS — all checks' : `\nFAIL — ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
