#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:impact
//
// WHAT A STRIKE DOES WHEN IT LANDS, now that landing is no longer mostly about
// damage. A base strike is a SHOVE, a MARK, a scattering of small fish and a
// small BLAST where the button came up — never a wound on whatever it clipped.
// Every one of those is a claim about motion or about state over time, which is
// exactly what a screenshot cannot answer and what the browser preview cannot
// even run — it suspends requestAnimationFrame, so the loop is frozen there.
//
// Five things worth failing over:
//
//   BURST       that a ram itself takes nothing off what it hits, that the
//               damage instead goes off at the point of RELEASE, and that the
//               strike line adds real bite to it. This is the whole rebalance,
//               and it is one saved tuning value away from silently reverting —
//               `strike.damage` is in imported-tuning.json and the burst's own
//               damage field is not.
//
//   SHOVE       that the knock actually MOVES a body, in the dash's direction,
//               against every kind of steering there is. This is the one that
//               would have broken quietly: a turn-limited hunter assigns its
//               velocity outright every frame, so the obvious implementation
//               (add to e.vx) moves a flocking fish and does nothing at all to
//               a shark — and nothing throws.
//
//   MARK        that a ram paints big bodies and not minnows, that the paint
//               expires, that it survives being re-rammed, and that it drops
//               the moment the target leaves the scene. A mark holds a strong
//               reference to a creature; one that outlived its body would be a
//               leak with a reticle drawn on it.
//
//   PULL        that a marked target actually wins a target-picker's "nearest"
//               comparison against a closer unmarked one — the entire point of
//               marking something the seal cannot hurt.
//
//   SCATTER     that a school moves AWAY from a wound-up strike, and that a
//               dash frightens harder than a wind-up.
//
// What it cannot tell you: whether the shove feels heavy, or whether six
// seconds is the right length for a lock. Those are a controller in your hands.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { baseStats } from '../path/src/stats.js';
import {
  enemies, spawnNamed, updateEnemies, resetEnemies, applyKnockback, setStrikeThreat,
} from '../path/src/entities/enemies.js';
import {
  strikeState, resetStrike, updateStrike, strikeBurst,
} from '../path/src/systems/strike.js';
import {
  markTarget, markable, isMarked, markWeight, updateMarks, resetMarks, __ringShader,
} from '../path/src/systems/marks.js';
import { jostleBoat } from '../path/src/systems/boats.js';
import { RigidBody } from '../path/src/systems/rigidBody.js';

const scene = new THREE.Scene();
const dt = 1 / 60;

// The animation controller warns once per state per creature for clips a
// procedural stand-in does not have, which in Node is all of them.
const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[animation]') || msg.startsWith('[assets]'))) return;
  realWarn(msg, ...rest);
};

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
const section = (s) => console.log(`\n${s}`);

const stats = baseStats();
const playerPos = new THREE.Vector3(0, -20, 0);

// A dash, declared directly. tryStrike() is the real entry point and is tested
// by test:strike; what matters here is the state the hit loop reads.
function armDash(power = 1, dir = { x: 1, y: 0 }) {
  resetStrike();
  strikeState.active = true;
  strikeState.power = power;
  strikeState.dashTimeLeft = 1;
  strikeState.dashDuration = 1;
  strikeState.dashDir = { x: dir.x, y: dir.y };
}

function spawnAt(type, x, y) {
  const e = spawnNamed(scene, type, 0, { x, y }, { ignoreCaps: true });
  if (!e) throw new Error(`could not spawn ${type}`);
  // Spawned creatures may still be "entering" from off the wings, which skips
  // the horizontal clamp and some of the steering. Everything here is a body
  // already in the arena.
  e.entering = false;
  return e;
}

// ----------------------------------------------------------------- the burst

section('BURST — the strike spends its damage where the button came up');

check('the strike damage stat is the BURST, not the nominal strike',
  stats.strikeDamage === CONFIG.strike.burst.damage,
  `stat ${stats.strikeDamage}, burst.damage ${CONFIG.strike.burst.damage}`);

// The trap this exists for: `strike.damage` is saved in imported-tuning.json,
// so a base damage kept there would be whatever the tuner last wrote — 40, at
// the time of writing. The burst's number has to be one the tuning file does
// not already own, or this rebalance silently does not happen in the real game.
check('...which is a different field from the one the tuner writes',
  CONFIG.strike.burst.damage < CONFIG.strike.damage,
  `${CONFIG.strike.burst.damage} vs ${CONFIG.strike.damage}`);

// A RAM ITSELF DEALS NOTHING. The whole point of moving the damage to the
// release: a dash is a shove, and the damage is one readable event where the
// player pressed the button.
{
  resetEnemies(scene);
  resetStrike();
  const bystander = spawnAt('shark', 0.2, -20);
  const hp = bystander.hp;
  armDash(1, { x: 1, y: 0 });
  let damaged = 0;
  updateStrike(dt, scene, playerPos, stats, enemies, { onEnemyDamaged: () => { damaged++; } });
  check('a ram takes no health off what it hits', bystander.hp === hp,
    `${bystander.hp.toFixed(1)} of ${hp.toFixed(1)} hp`);
  check('...and reports no damage rather than a zero-point hit', damaged === 0);
  check('...but it still shoves', Math.abs(bystander.knockX) > 0,
    `${bystander.knockX.toFixed(1)} u/s`);
}

// The burst itself scales on both axes, and both come off the one function the
// release calls — a second copy of this arithmetic in the test would pass
// while the game did something else.
armDash(1);
const full = strikeBurst(stats);
armDash(0.35);
const flick = strikeBurst(stats);
check('a full charge hits harder than a flick', full.damage > flick.damage * 1.5,
  `${full.damage.toFixed(1)} vs ${flick.damage.toFixed(1)}`);
check('...and reaches further', full.radius > flick.radius,
  `${full.radius.toFixed(2)} vs ${flick.radius.toFixed(2)} units`);
check('a flick still goes off at all', flick.damage > 0 && flick.radius > 0);

armDash(1);
const shark = CONFIG.enemies.shark;
check('a full-charge burst is small against a shark',
  full.damage < shark.hp * 0.35, `${full.damage.toFixed(1)} vs ${shark.hp} hp`);
check('...but clears a school of minnows', full.damage >= CONFIG.enemies.fish.hp,
  `${full.damage.toFixed(1)} vs ${CONFIG.enemies.fish.hp} hp`);
// "Small" measured against the dash it belongs to: a full-charge dash travels
// dashSpeed x dashDuration x reachMulMax, and a blast approaching that is not a
// pop at the release point, it is the whole corridor going off at once.
const dashReach = CONFIG.strike.dashSpeed * CONFIG.strike.dashDuration
  * CONFIG.strike.charge.reachMulMax;
check('the blast is a pop, not the whole dash corridor going off',
  full.radius < dashReach * 0.25,
  `${full.radius.toFixed(2)} units vs a ${dashReach.toFixed(1)}-unit dash`);

// Splash Zone widens the blast, and must not also inflate the damage — that
// separation is what `aoeMul` has always meant.
{
  const wide = { ...stats, aoeMul: 1.5 };
  const w = strikeBurst(wide);
  check('Splash Zone widens the burst', w.radius > full.radius * 1.4,
    `${w.radius.toFixed(2)} vs ${full.radius.toFixed(2)}`);
  check('...and leaves its damage alone', w.damage === full.damage);
}

// Turned off, nothing goes off — the switch has to reach the arithmetic, not
// just the call site.
{
  CONFIG.strike.burst.enabled = false;
  const off = strikeBurst(stats);
  check('the burst switch reaches the damage', off.damage === 0 && off.radius === 0);
  CONFIG.strike.burst.enabled = true;
}

// And contactShare is a real dial: turned up, the ram bites again.
{
  CONFIG.strike.contactShare = 0.5;
  resetEnemies(scene);
  resetStrike();
  const victim = spawnAt('shark', 0.2, -20);
  const hp = victim.hp;
  armDash(1, { x: 1, y: 0 });
  updateStrike(dt, scene, playerPos, stats, enemies, {});
  check('dialling contactShare up puts damage back on the ram', victim.hp < hp,
    `${(hp - victim.hp).toFixed(1)} dealt`);
  CONFIG.strike.contactShare = 0;
}

// Every card in the family pays in. Measured by running the real apply()s.
const strikeCards = CONFIG.upgrades.filter((u) => u.family === 'strike');
check('the whole strike family is present', strikeCards.length >= 5,
  `${strikeCards.length} card(s)`);
for (const card of strikeCards) {
  const s = baseStats();
  card.apply(s);
  check(`${card.id} adds bite`, s.strikeDamage > stats.strikeDamage,
    `${stats.strikeDamage} -> ${s.strikeDamage}`);
}

// And the line as a whole gets somewhere worth going.
const maxed = baseStats();
for (const card of strikeCards) {
  for (let i = 0; i < (card.maxStacks ?? 1); i++) card.apply(maxed);
}
check('a fully-invested strike line is a real weapon again',
  maxed.strikeDamage > CONFIG.strike.damage,
  `${maxed.strikeDamage} vs the nominal ${CONFIG.strike.damage}`);

// ----------------------------------------------------------------- the shove

section('SHOVE — the knock moves a body whatever steers it');

// Measured against a CONTROL run of the same creature, not against where it
// started. A shark cruises at 7 units/sec under its own power, so half a
// second of its own swimming is several times the shove and swamps any
// before/after reading — the first version of this test "failed" on a shark
// that had been thrown perfectly well and had then simply turned round.
//
// Both runs are driven off a seeded RNG so the pair really is the same fish
// twice: spawn rolls a heading, a phase and a speed within its variance, and
// the behaviours roll again every frame. Reseeding is what makes the
// difference between the two runs attributable to the knock and nothing else.
const realRandom = Math.random;
function seedRandom(seed = 12345) {
  let s = seed >>> 0;
  Math.random = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// The knock is applied MID-RUN, after an identical warm-up, and measured over
// a short window. Both halves of that matter:
//
//   the WARM-UP because a creature spawns on a random heading and the shared
//   crowd systems (apexCrowd) carry state between calls — so a run measured
//   from the spawn frame is really measuring "which way was it pointed", and
//   the answer changed when unrelated checks were added above this one.
//
//   the SHORT WINDOW because the shove is over in about a fifth of a second at
//   the shipped decay, while a shark swims 7 units/sec forever. Measuring
//   longer just adds steering to both sides of a subtraction.
function travel(type, { knocked, seed = 12345, warmup = 0.5, seconds = 0.2 }) {
  seedRandom(seed);
  resetEnemies(scene);
  const e = spawnAt(type, 0, -20);
  for (let i = 0; i < Math.round(warmup / dt); i++) {
    updateEnemies(dt, scene, playerPos, () => {}, () => {});
  }
  const startX = e.mesh.position.x;
  const push = knocked ? applyKnockback(e, 1, 0, 1) : 0;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    updateEnemies(dt, scene, playerPos, () => {}, () => {});
  }
  const out = { push, moved: e.mesh.position.x - startX, residual: e.knockX };
  Math.random = realRandom;
  return out;
}

// One creature per KIND of steering, because they own e.vx in three different
// ways: `swarm` blends toward a boids sum, `chase`/hunt with a turnRate
// ASSIGNS it outright every frame, and `crawl` has gravity added to it. The
// third case is why the knock is integrated separately — a shove written into
// vx is erased before it moves a shark an inch, and nothing throws.
playerPos.set(0, 8, 0);
for (const type of ['fish', 'shark', 'walkingCrab']) {
  const hit = travel(type, { knocked: true });
  const control = travel(type, { knocked: false });
  const gained = hit.moved - control.moved;
  check(`${type}: the knock is a real impulse`, hit.push > 0, `${hit.push.toFixed(1)} u/s`);
  check(`${type}: it travelled further along the dash than the same body unhit`,
    gained > 0.4, `${gained.toFixed(2)} units of daylight`);
  // Most of the throw should be spent by the end of that window — a shove that
  // is still going is a launch, and the difference is whether a rammed body
  // comes back at you or sails out of the fight.
  check(`${type}: and the shove bled off rather than launching it`,
    Math.abs(hit.residual) < hit.push * 0.15,
    `residual ${hit.residual.toFixed(2)} of ${hit.push.toFixed(1)}`);
}
playerPos.set(0, -20, 0);

// Size resists. Same shove, two very different bodies.
resetEnemies(scene);
const minnow = spawnAt('fish', 0, -20);
const meg = spawnAt('megalodon', 6, -20);
const minnowPush = applyKnockback(minnow, 1, 0, 1);
const megPush = applyKnockback(meg, 1, 0, 1);
check('a minnow is thrown further than a megalodon by the same ram',
  minnowPush > megPush * 1.5, `${minnowPush.toFixed(1)} vs ${megPush.toFixed(1)}`);

// Charge scales it.
resetEnemies(scene);
const a = spawnAt('shark', 0, -20);
const b = spawnAt('shark', 8, -20);
check('a full charge shoves harder than a flick',
  applyKnockback(a, 1, 0, 1) > applyKnockback(b, 1, 0, 0.1) * 1.5);

// ------------------------------------------------------------------ the mark

section('MARK — the ram paints what it cannot hurt');

resetEnemies(scene);
resetMarks();
const bigOne = spawnAt('shark', 2, -20);
const smallOne = spawnAt('fish', 2.5, -20);

check('a shark is worth painting', markable(bigOne));
check('a minnow is not', !markable(smallOne));

check('marking a shark takes', markTarget(bigOne) === true);
check('...and it reads back as marked', isMarked(bigOne));
check('re-ramming the same body does not double-mark it',
  markTarget(bigOne) === false);
check('a minnow is refused outright',
  markTarget(smallOne) === false && !isMarked(smallOne));

// It expires. Driven a whole second past the configured duration so a mark
// that merely fades but never clears is caught.
for (let i = 0; i < Math.ceil((CONFIG.strike.mark.duration + 1) / dt); i++) updateMarks(dt);
check('the paint wears off', !isMarked(bigOne));

// A dead body drops its mark on the next tick, whatever its timer said. This
// is the leak: `marks` holds a strong reference to the creature.
resetMarks();
const doomed = spawnAt('shark', 4, -20);
markTarget(doomed);
check('a fresh mark holds', isMarked(doomed));
scene.remove(doomed.mesh); // what removeEnemy does
updateMarks(dt);
check('...and is dropped the moment the body leaves the scene', !isMarked(doomed));

// Boats. They have no `radius` in the creature sense, so they pass on being a
// hull rather than on size.
resetMarks();
const hull = { mesh: new THREE.Object3D(), hp: 60, halfLength: 3, halfHeight: 0.8, isTrawler: false,
  knockX: 0, knockY: 0, rock: 0, rockVel: 0, flash: 0 };
scene.add(hull.mesh);
check('a hull is markable', markable(hull, true));
check('...and takes the paint', markTarget(hull, { isBoat: true, radius: hull.halfLength }));

// ----------------------------------------------------------------- the wiring

// Source-level, because the alternative is a GL context and a real frame:
// main.js pulls in the renderer, the audio graph and the input stack, none of
// which exist in Node. Same approach as the WIRING block in test:strike.
section('WIRING — the release really is what spends the damage');
{
  const main = readFileSync(new URL('../path/src/main.js', import.meta.url), 'utf8');
  check('main.js asks strikeBurst for the numbers', main.includes('strikeBurst(player.stats)'));
  check('...and queues it through the shared splash path, tagged as the strike',
    /pendingSplashes\.push\(\{[^}]*source: 'strike'/s.test(main));
  check('...with its own feedback rather than the splash queue\'s big bang',
    main.includes("feedback('strikeBurst'"));
  // The one that would go silently missing: with the ram dealing no damage,
  // the strike's kills all happen in the burst, so the school-wipe chain link
  // has to be claimable from there or that source is dead.
  check('a school emptied by the burst can still score its chain link',
    /schoolWipe && s\.source === 'strike'/.test(main));
}

// ---------------------------------------------------------------- the reticle

section('RETICLE — the thing that tells the player a mark exists');
{
  const { vertexShader, fragmentShader, makeRing } = __ringShader;
  const mat = makeRing().material;
  const declared = Object.keys(mat.uniforms);
  const missing = declared.filter((u) => !fragmentShader.includes(u) && !vertexShader.includes(u));
  check('every uniform the material declares is read by the shader',
    missing.length === 0, missing.length ? missing.join(', ') : `${declared.length} uniforms`);
  const used = [...fragmentShader.matchAll(/uniform\s+\w+\s+(\w+)/g)].map((m) => m[1]);
  const unsupplied = used.filter((u) => !declared.includes(u));
  check('...and every uniform the shader reads is supplied',
    unsupplied.length === 0, unsupplied.length ? unsupplied.join(', ') : `${used.length} read`);
  check('the reticle is additive and does not write depth, so a body cannot clip it',
    mat.blending === THREE.AdditiveBlending && mat.depthWrite === false && mat.depthTest === false);
  mat.dispose();
}

// ------------------------------------------------------------------ the pull

section('PULL — a mark wins the "nearest" comparison');

resetMarks();
resetEnemies(scene);
const near = spawnAt('fish', 1, -20);
const far = spawnAt('shark', 3, -20);
markTarget(far);
check('an unmarked body is weighted at face value', markWeight(near) === 1);
check('a marked one looks closer than it is', markWeight(far) < 1,
  `x${markWeight(far)}`);
// The comparison every picker actually makes.
const dNear = 1 * markWeight(near);
const dFar = 3 * markWeight(far);
check('so a picker takes the marked shark over the nearer minnow', dFar < dNear,
  `${dFar.toFixed(2)} vs ${dNear.toFixed(2)}`);

// ...but not from across the arena. A mark is a preference, not a leash.
const dVeryFar = 40 * markWeight(far);
check('a mark on the far side of the arena still loses to what is on top of you',
  dVeryFar > dNear, `${dVeryFar.toFixed(2)} vs ${dNear.toFixed(2)}`);

// --------------------------------------------------------------- the scatter

section('SCATTER — small fish break away from a strike');

// A school sitting still, with the player far below so `towardPlayer` is not
// what moves them. Measured as distance from the point the strike is centred
// on, which is what "getting out of the way" means.
function schoolDrift({ dashing, power, seconds = 0.6 }) {
  resetEnemies(scene);
  const fish = [];
  for (let i = 0; i < 8; i++) fish.push(spawnAt('fish', -1 + i * 0.35, -20 + (i % 3) * 0.3));
  playerPos.set(0, -20, 0);
  const focus = { x: playerPos.x, y: playerPos.y };
  const before = fish.map((f) => Math.hypot(f.mesh.position.x - focus.x, f.mesh.position.y - focus.y));
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    setStrikeThreat({ active: true, x: playerPos.x, y: playerPos.y, dirX: 1, dirY: 0, power, dashing });
    updateEnemies(dt, scene, playerPos, () => {}, () => {});
  }
  const after = fish.map((f) => Math.hypot(f.mesh.position.x - focus.x, f.mesh.position.y - focus.y));
  setStrikeThreat(null);
  const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
  return mean(after) - mean(before);
}

const calm = schoolDrift({ dashing: false, power: 0, seconds: 0.6 });
const winding = schoolDrift({ dashing: false, power: 1, seconds: 0.6 });
const dashing = schoolDrift({ dashing: true, power: 1, seconds: 0.6 });

check('a wound-up strike pushes a school away', winding > calm + 0.2,
  `${winding.toFixed(2)} vs ${calm.toFixed(2)} at rest`);
check('a dash in flight frightens harder than a wind-up', dashing > winding,
  `${dashing.toFixed(2)} vs ${winding.toFixed(2)}`);

// ------------------------------------------------------------------- the hull

section('HULL — a ram jostles a boat without rolling it over');

// A hull is a simulated body now (see systems/rigidBody.js and test:physics,
// which owns the physics itself). What this still has to check is the STRIKE's
// half of it: that a ram reaches the hull at all, along the dash, with the
// weight of the boat in it.
const react = CONFIG.boats.hitReaction;
const makeHull = (isTrawler = false) => {
  const mesh = new THREE.Object3D();
  const b = { mesh, hp: 60, isTrawler, halfLength: 3, halfHeight: 0.8, flash: 0 };
  b.body = new RigidBody({
    kind: 'boat', shape: 'box', owner: b, object: mesh, halfLength: 3, halfHeight: 0.8,
    mass: CONFIG.physics.boat.mass * (isTrawler ? CONFIG.physics.boat.trawlerMass : 1),
    drag: 0, angularDrag: CONFIG.physics.boat.angularDrag,
    righting: CONFIG.physics.boat.righting, rightingDamping: CONFIG.physics.boat.rightingDamping,
    spin: CONFIG.physics.boat.spin, maxAngle: react.maxRoll ?? 0.55,
  });
  return b;
};

const boat = makeHull();
jostleBoat(boat, 1, 0, 1, { x: 2.5, y: 0.4 });
check('the hull takes a shove', Math.abs(boat.body.vx) > 0, `${boat.body.vx.toFixed(2)} u/s`);
check('...along the dash, not upward', boat.body.vx > Math.abs(boat.body.vy));
check('...and it rolls from where the seal hit it', Math.abs(boat.body.angVel) > 0,
  `${boat.body.angVel.toFixed(2)} rad/s`);

// A trawler is heavier — carried by its mass now rather than by a resist
// factor, so one number covers every impulse a hull can take.
const trawler = makeHull(true);
jostleBoat(trawler, 1, 0, 1, { x: 2.5, y: 0.4 });
check('a trawler barely flinches next to a rowboat', trawler.body.vx < boat.body.vx,
  `${trawler.body.vx.toFixed(2)} vs ${boat.body.vx.toFixed(2)} u/s`);

// NO CAPSIZE. Ten full-charge rams in a row on the same spot, integrated
// through the real roll spring — the hull may lean hard and it may keep
// rocking, but it must never go over while it is still afloat.
const rammed = makeHull();
let worst = 0;
for (let hit = 0; hit < 10; hit++) {
  jostleBoat(rammed, 1, 0, 1, { x: 2.9, y: 0.8 });
  for (let i = 0; i < 12; i++) {
    rammed.body.integrate(dt);
    worst = Math.max(worst, Math.abs(rammed.body.angle));
  }
}
check('a hull rammed ten times still never goes past its lean limit',
  worst <= (react.maxRoll ?? 0.55) + 1e-6,
  `worst ${worst.toFixed(3)} rad, limit ${react.maxRoll}`);
check('...and the limit is well short of capsizing', (react.maxRoll ?? 0.55) < Math.PI / 4,
  `${react.maxRoll} rad`);

// ------------------------------------------------------------------ the chain

section('CHAIN — a shove is not a meal');

resetEnemies(scene);
resetMarks();
resetStrike();
const victim = spawnAt('shark', 0.2, -20);
armDash(1, { x: 1, y: 0 });
playerPos.set(0, -20, 0);
let chained = 0;
updateStrike(dt, scene, playerPos, stats, enemies, {
  onChainHit: () => { chained++; },
});
// Connection is no longer measurable as damage — that is the point. A ram
// announces itself by the hit flash, the shove and the paint.
check('the ram connected', victim.flash > 0 && victim.hitThisFrame === true);
check('...and it scored no FOOD CHAIN link', chained === 0);
check('...but it did paint the shark', isMarked(victim));
check('...and shoved it', Math.abs(victim.knockX) > 0, `${victim.knockX.toFixed(1)} u/s`);

// The switch is a switch: turned on, the same hit chains.
CONFIG.strike.chainOn.strikeHit = true;
resetEnemies(scene);
resetStrike();
const victim2 = spawnAt('shark', 0.2, -20);
armDash(1, { x: 1, y: 0 });
chained = 0;
updateStrike(dt, scene, playerPos, stats, enemies, { onChainHit: () => { chained++; } });
check('flipping chainOn.strikeHit brings the old behaviour back', chained === 1);
CONFIG.strike.chainOn.strikeHit = false;
void victim2;

// ---------------------------------------------------------------------------
console.log(failures === 0 ? '\nAll strike-impact checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
