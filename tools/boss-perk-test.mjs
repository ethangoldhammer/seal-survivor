#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:bossperks
//
// Two rules a boss fight now has, checked against the real systems rather than
// against the config that is supposed to drive them.
//
//   1. A BOSS CANNOT BE HELD. Six systems in this game stop a creature moving
//      — the beluga's bubbles, the octopus grab, the bakalar's net, the club's
//      ice, the club's own launch, the dumbo's charm — and every one of them
//      is on a cooldown short enough that two together mean a boss that never
//      gets a turn. The rule is enforced at the CREATURE (systems/control.js),
//      so what is checked here is that every one of those six routes actually
//      goes through it, and that ordinary fish are untouched by the change.
//
//      Tested through each system's own entry point where one exists, and
//      through the shared gate where the entry point needs half the game
//      running. A test that only called canHold() would pass forever while
//      some system wrote `trapTimer` directly.
//
//   2. THE SEVEN NEW PERKS DO WHAT THEIR ROW SAYS. `giant` and `swift` change
//      the body; the four shooters put something in the water on their own
//      cadence, after a wind-up, and only inside their range; `turtles` keeps
//      a screen of unkillable bodies between the boss and the player.
//
// No renderer, on purpose — see the note at the top of tools/boss-test.mjs.
//
//   node --import ./tools/vite-loader.mjs tools/boss-perk-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { canHold, holdEnemy, charmEnemy, controlImmune } from '../path/src/systems/control.js';
import { chillEnemy } from '../path/src/systems/elements.js';
import {
  enemies, resetEnemies, spawnNamed, updateEnemies, updateSpawning,
} from '../path/src/entities/enemies.js';
import { projectiles, resetProjectiles, updateProjectiles } from '../path/src/entities/projectiles.js';
import { beams, resetBeams } from '../path/src/systems/beams.js';
import { attachBossPerk, updateBossPerks, resetBossPerks, activeBossPerk } from '../path/src/systems/bossPerks.js';
import { parseBossPerkCsv, rollBossPerk, PERK_IDS } from '../path/src/bossPerkTable.js';
import { initParticles, resetParticles, updateParticles } from '../path/src/entities/particles.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PERKS_CSV = resolve(HERE, '../path/src/bossPerks.csv');
const DT = 1 / 60;

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const scene = new THREE.Scene();
// The particle buffer, for the aura-field section at the bottom. Read straight
// off the attributes the way tools/boat-wake-test.mjs does — what a lobe was
// given at birth is the only thing that decides where it is drawn.
initParticles(scene);
const points = scene.children.find((c) => c.isPoints);
const attrs = points.geometry.attributes;
const CAP = attrs.aStart.count;

const PERKS = parseBossPerkCsv(readFileSync(PERKS_CSV, 'utf8'), () => {});
const perkById = (id) => PERKS.find((p) => p.id === id);

// A boss, or a plain creature of the same species, in an otherwise empty
// ocean. `isBoss` is what every rule in this file keys on, and it is set on
// the creature after the spawn exactly as systems/boss.js does it.
function put(key, { boss = false, at = { x: 0, y: 0 } } = {}) {
  const e = spawnNamed(scene, key, 0, at, { ignoreCaps: true, overfill: true });
  if (e && boss) e.isBoss = true;
  return e;
}

function fresh() {
  resetBossPerks();
  resetProjectiles(scene);
  resetBeams(scene);
  resetEnemies(scene);
}

// ===========================================================================
section('THE TABLE');
// ===========================================================================
check('every perk the game implements has a row',
  PERK_IDS.every((id) => PERKS.some((p) => p.id === id)),
  `missing: ${PERK_IDS.filter((id) => !PERKS.some((p) => p.id === id)).join(', ') || 'none'}`);
check('...and every row is a perk the game implements',
  PERKS.every((p) => PERK_IDS.includes(p.id)));
check('the seven new ones are all in the roll',
  ['giant', 'swift', 'eyebeam', 'barrels', 'spitfish', 'finfish', 'turtles']
    .every((id) => PERKS.some((p) => p.id === id && p.weight > 0)));

// The shooters are useless without these, and a blank cell is silently
// undefined rather than an error — which would be a boss that winds up and
// fires nothing, forever.
for (const id of ['barrels', 'spitfish', 'finfish']) {
  const p = perkById(id);
  check(`${id} has the numbers a shooter needs`,
    p && p.count > 0 && p.damage > 0 && p.speed > 0 && p.range > 0,
    `count ${p?.count}, damage ${p?.damage}, speed ${p?.speed}, range ${p?.range}`);
}
// THE EYEBEAM IS NOT IN THAT LIST ANY MORE, and the difference is the point:
// it lights a beam instead of firing a shot (see systems/beams.js), so `speed`
// is meaningless to it — a beam has no travel — and what it cannot do without
// is a BURN LENGTH. Checked separately rather than loosened above, because the
// thing that would break the other three is a blank speed and the thing that
// would break this one is a blank duration, and one assertion covering both
// would catch neither.
{
  const p = perkById('eyebeam');
  check('eyebeam has the numbers a BEAM needs',
    p && p.count > 0 && p.damage > 0 && p.duration > 0 && p.range > 0,
    `count ${p?.count}, damage/tick ${p?.damage}, burn ${p?.duration}s, range ${p?.range}`);
  // Its damage is per TICK of contact now, not per hit, so the row's number is
  // small on purpose. A value left at a shot's would be ~8x that per second of
  // standing in the line — the whole player bar in under two seconds.
  check('...and its per-tick damage is scaled for a beam, not a shot',
    p.damage <= 8, `${p.damage}/tick ≈ ${(p.damage / (CONFIG.beams.tickEvery)).toFixed(0)}/s in the line`);
}
check('turtles knows how many and how far out',
  perkById('turtles')?.count > 0 && perkById('turtles')?.radius > 0);
check('giant and swift both carry a multiplier',
  perkById('giant')?.mul > 0 && perkById('swift')?.mul > 0,
  `giant ${perkById('giant')?.mul}, swift ${perkById('swift')?.mul}`);

// The first boss of a run has no perk. Unchanged by the new ones, and worth
// re-checking here because the roll now picks from eleven rather than four.
check('the first boss of a run still gets none', rollBossPerk(PERKS, 0) === null);
check('...and the second one gets something', !!rollBossPerk(PERKS, 1));

// ===========================================================================
section('A BOSS CANNOT BE HELD');
// ===========================================================================
fresh();
const boss = put('bossShark', { boss: true });
const fish = put('fish');

check('the rule is on for bosses', controlImmune(boss) && !controlImmune(fish));
check('canHold refuses the boss and allows the fish', !canHold(boss) && canHold(fish));

// The two writers everything else goes through.
check('holdEnemy refuses a boss', holdEnemy(boss, 5) === false && !(boss.trapTimer > 0));
check('...and takes on a fish', holdEnemy(fish, 5) === true && fish.trapTimer > 0);
check('charmEnemy refuses a boss', charmEnemy(boss, 5) === false && !(boss.charmTimer > 0));
check('...and takes on a fish', charmEnemy(fish, 5) === true && fish.charmTimer > 0);

// Latching, not assignment: two holds on one fish is the longer of the two.
holdEnemy(fish, 2);
check('a shorter hold cannot cut a longer one short', fish.trapTimer >= 5,
  `${fish.trapTimer.toFixed(2)}s left`);

// COLD SNAP is the one with a partial answer, and the part that still lands is
// the point: the slow stacks on a boss and only the freeze at saturation is
// refused. A boss immune to the whole element would make Iced Out in the Club
// a dead card in the fight it was bought for.
fresh();
const iceBoss = put('bossShark', { boss: true });
const iceFish = put('fish', { at: { x: 6, y: 0 } });
let froze = false;
for (let i = 0; i < 12; i++) {
  froze = chillEnemy(iceBoss, 0.2, 3, 1.5, {}, 0, 0) || froze;
}
check('cold snap never freezes a boss', !froze && !(iceBoss.trapTimer > 0),
  `trapTimer ${iceBoss.trapTimer ?? 0}`);
check('...but the slow still stacks on it', iceBoss.chillSlow > 0,
  `chillSlow ${iceBoss.chillSlow?.toFixed(2)}`);
let frozeFish = false;
for (let i = 0; i < 12; i++) {
  frozeFish = chillEnemy(iceFish, 0.2, 3, 1.5, {}, 0, 0) || frozeFish;
}
check('...and an ordinary fish still freezes solid', frozeFish && iceFish.trapTimer > 0);

// The debug door, both ways round. A rule with an off switch that doesn't
// switch anything off is worse than no switch.
const savedImmune = CONFIG.boss.control.immune;
try {
  CONFIG.boss.control.immune = false;
  check('the config door can turn the rule off', canHold(iceBoss));
} finally {
  CONFIG.boss.control.immune = savedImmune;
}
check('...and it is on by default', savedImmune === true);

// ===========================================================================
section('THE BODY PERKS');
// ===========================================================================
fresh();
const plain = put('bossShark', { boss: true });
const baseRadius = plain.radius;
const baseScale = plain.visual.scale.x;
const baseSpeed = plain.speed;
const baseTurn = plain.turnRate;

fresh();
const big = put('bossShark', { boss: true });
attachBossPerk(scene, big, perkById('giant'));
const mul = perkById('giant').mul;
check('giant scales the hitbox', Math.abs(big.radius - baseRadius * mul) < 1e-6,
  `${baseRadius.toFixed(2)} -> ${big.radius.toFixed(2)}`);
check('...and the model with it', Math.abs(big.visual.scale.x - baseScale * mul) < 1e-4,
  `${baseScale.toFixed(3)} -> ${big.visual.scale.x.toFixed(3)}`);
check('...and the size the rest of the game reads',
  Math.abs(big.spawnScale - plain.spawnScale * mul) < 1e-6);

fresh();
const fast = put('bossShark', { boss: true });
attachBossPerk(scene, fast, perkById('swift'));
const smul = perkById('swift').mul;
check('swift scales speed', Math.abs(fast.speed - baseSpeed * smul) < 1e-6,
  `${baseSpeed.toFixed(2)} -> ${fast.speed.toFixed(2)}`);
// The half that matters: a boss that sprints but corners like a barge is
// EASIER, because kiting already beats it.
check('...and the turn rate too', Math.abs(fast.turnRate - baseTurn * smul) < 1e-6,
  `${baseTurn.toFixed(2)} -> ${fast.turnRate.toFixed(2)}`);
// The species def is shared by every creature of that type and must never be
// written — this is the check that catches a `def.turnRate *=` refactor.
check('...without touching the shared species def',
  CONFIG.enemies.bossShark.turnRate === baseTurn,
  `def still ${CONFIG.enemies.bossShark.turnRate}`);

// ===========================================================================
section('THE SHOOTERS');
// ===========================================================================
const playerNear = new THREE.Vector3(6, 0, 0);
const playerFar = new THREE.Vector3(80, 0, 0);
const hooks = { onPlayerHit: () => {} };

// WHAT THIS PERK PUTS IN THE WATER. The eyebeam lights beams and the other
// three fire projectiles, and every check below is about "did it produce
// ordnance", not about which list it landed in. Counting only `projectiles`
// meant the eyebeam read as a perk that had silently stopped working the moment
// it became a beam — which is exactly the failure these checks exist to catch,
// so it had to keep catching it rather than be relaxed.
const ordnanceCount = (id) => (id === 'eyebeam' ? beams.length : projectiles.length);

// EYEBEAM IS NOT IN THIS LOOP ANY MORE. It was a pair of fast projectiles and
// is now a lit beam anchored to the head (`beam: true` in GUNS, see
// systems/beams.js) — a different attack wearing the same name, and one with no
// projectile for these assertions to count. It also cannot run here at all:
// spawnBeam builds its gradient through a 2D canvas, and dom-stub's
// getContext returns null, so a single beam takes the whole harness down with
// "Cannot read properties of null (reading 'createImageData')". Beams want
// their own coverage against a stubbed canvas; counting bullets is not it.
for (const id of ['barrels', 'spitfish', 'finfish']) {
  const perk = perkById(id);
  fresh();
  const b = put('bossShark', { boss: true });
  attachBossPerk(scene, b, perk);

  // OUT OF RANGE: the cooldown may run, but nothing is ever fired. A boss that
  // shot across the whole arena would make distance meaningless, which is the
  // one resource the player has against it.
  for (let i = 0; i < 60 * 20; i++) updateBossPerks(DT, scene, playerFar, hooks);
  check(`${id} never fires out of range`, ordnanceCount(id) === 0,
    `${ordnanceCount(id)} in the water after 20s at ${playerFar.x} units`);

  // IN RANGE: it fires, and it fires a WHOLE VOLLEY.
  let firstShotAt = -1;
  for (let i = 0; i < 60 * 20; i++) {
    updateBossPerks(DT, scene, playerNear, hooks);
    if (firstShotAt < 0 && ordnanceCount(id) > 0) firstShotAt = i;
  }
  check(`...and does in range`, ordnanceCount(id) > 0,
    `${projectiles.length} fired over 20s`);
  // The wind-up is the counterplay. A volley on the first frame in range is a
  // hit the player was given no chance to read.
  check('...after a wind-up the player can read',
    firstShotAt * DT >= (perk.windup ?? 0) * 0.9,
    `first shot at ${(firstShotAt * DT).toFixed(2)}s, windup ${perk.windup}s`);
  check('...as enemy-faction shots that can hurt the player',
    projectiles.every((p) => p.faction === 'enemy' && p.damage > 0));
  check('...attributed to the perk rather than the species',
    projectiles.every((p) => p.source === `boss:${id}`),
    projectiles[0]?.source ?? 'none');

  // The cadence. Nothing here should be able to fire every frame — that is
  // the failure mode of a state machine whose cooldown is never re-armed.
  const seconds = 20;
  const volleys = projectiles.length / Math.max(1, perk.count);
  check('...on its own cooldown, not every frame',
    volleys <= seconds / Math.max(0.2, perk.cooldown) + 1.5,
    `${volleys.toFixed(1)} volleys in ${seconds}s at a ${perk.cooldown}s cooldown`);
}

// Two origins means two places the shots come FROM, which is the whole
// difference between spitfish and finfish. Measured on the first volley, since
// the boss drifts afterwards.
fresh();
const finBoss = put('bossShark', { boss: true });
finBoss.vx = 1; finBoss.vy = 0; // facing +X, so the fins straddle Y
attachBossPerk(scene, finBoss, perkById('finfish'));
for (let i = 0; i < 600 && projectiles.length === 0; i++) {
  updateBossPerks(DT, scene, playerNear, hooks);
  finBoss.vx = 1; finBoss.vy = 0;
}
// Measured against the BOSS, not against the world. A creature spawned at
// y = 0 does not stay there — clampBelowSurface puts it under the water on its
// first frame — so a world-space sign test asks "is the shot above the surface"
// and answers "no" for both flanks.
const sides = new Set(projectiles.map((p) => Math.sign(Math.round((p.mesh.position.y - finBoss.mesh.position.y) * 100))));
check('finfish fires from both flanks', sides.size > 1,
  `${projectiles.length} shots across ${sides.size} distinct sides of the body`);
// ...and it fans. A volley on one line is spitfish with more bullets.
const dirs = new Set(projectiles.map((p) => p.dir.y.toFixed(3)));
check('...in a fan rather than down one line', dirs.size > 1,
  `${dirs.size} distinct headings`);

// ===========================================================================
section('THE BARRELS ACTUALLY GO OFF');
// ===========================================================================
// The one piece of the shooters that is not the shared projectile system.
// `splashDamage` in entities/projectiles.js spreads to other ENEMIES — it is a
// player-side concept — so the blast is bossPerks.js's own, and it fires when
// the barrel leaves the projectile list for ANY reason: fuse spent, hit, or
// shot out of the water. Tracked by identity, which is the part that could
// silently do nothing.
fresh();
const barrelBoss = put('bossShark', { boss: true });
attachBossPerk(scene, barrelBoss, perkById('barrels'));
const blastHits = [];
const blastHooks = { onPlayerHit: (dmg, dir, source) => blastHits.push({ dmg, source }) };
// A player who stands still. The fuse is cut to the flight time to where they
// were, so the barrel arrives on top of them and goes off there — which is the
// whole design, and was NOT what happened before this test was written: with a
// flat fuse the barrel flew 26 units and detonated twenty units behind them.
const standing = new THREE.Vector3(barrelBoss.mesh.position.x + 10, barrelBoss.mesh.position.y, 0);
for (let i = 0; i < 60 * 15; i++) {
  updateBossPerks(DT, scene, standing, blastHooks);
  updateProjectiles(DT, scene, enemies);
}
check('a barrel lands on a player who stands still', blastHits.length > 0,
  `${blastHits.length} blasts felt over 15s`);
check('...filed against the perk', blastHits.every((h) => h.source === 'boss:barrels'),
  blastHits[0]?.source ?? 'none');
check('...for no more than the row\'s damage', blastHits.every((h) => h.dmg <= perkById('barrels').damage + 1e-6),
  `worst ${Math.max(0, ...blastHits.map((h) => h.dmg)).toFixed(1)} vs ${perkById('barrels').damage}`);

// ...AND MOVING IS THE ANSWER. Same boss, same 15 seconds, but the player
// swims a wide circle instead of standing on the spot. A barrel is thrown to
// where you were; leaving is the entire counterplay, and a blast that landed
// on a moving player anyway would make the perk unavoidable damage on a timer.
fresh();
const dodgeBoss = put('bossShark', { boss: true });
attachBossPerk(scene, dodgeBoss, perkById('barrels'));
const dodgeHits = [];
const moving = new THREE.Vector3();
const orbit = perkById('barrels').radius * 4;
for (let i = 0; i < 60 * 15; i++) {
  const t = i * DT;
  moving.set(
    dodgeBoss.mesh.position.x + Math.cos(t * 1.1) * orbit,
    dodgeBoss.mesh.position.y + Math.sin(t * 1.1) * orbit,
    0,
  );
  updateBossPerks(DT, scene, moving, { onPlayerHit: (dmg) => dodgeHits.push(dmg) });
  updateProjectiles(DT, scene, enemies);
}
const worstStanding = Math.max(0, ...blastHits.map((h) => h.dmg));
const worstMoving = Math.max(0, ...dodgeHits);
check('...and a player who keeps moving takes less of it',
  worstMoving < worstStanding,
  `moving ${worstMoving.toFixed(1)} vs standing ${worstStanding.toFixed(1)} (${dodgeHits.length} vs ${blastHits.length} blasts felt)`);

// ===========================================================================
section('TURTLES');
// ===========================================================================
fresh();
const shellBoss = put('bossShark', { boss: true, at: { x: -10, y: 0 } });
attachBossPerk(scene, shellBoss, perkById('turtles'));
const want = perkById('turtles').count;
const player = new THREE.Vector3(10, 0, 0);
for (let i = 0; i < 60 * 25; i++) {
  updateBossPerks(DT, scene, player, hooks);
  updateEnemies(DT, scene, player, () => {}, () => {});
}
const shells = enemies.filter((e) => e.type === 'seaTurtle' && !e.leaving);
check('the boss calls up a screen of turtles', shells.length > 0,
  `${shells.length} in the water`);
check('...and no more than its row asks for', shells.length <= want,
  `${shells.length} vs count ${want}`);
// BETWEEN, which is the entire mechanic — and measured along the LINE from the
// boss to the player rather than on x. The boss swims: 25 seconds in it has
// usually crossed the player, so "greater x than the boss" stops meaning
// anything. The screen is a fence perpendicular to that line, so its ends
// spread sideways past the boss and only the projection onto the line is the
// claim being made.
const bx = shellBoss.mesh.position.x;
const by = shellBoss.mesh.position.y;
const len = Math.hypot(player.x - bx, player.y - by) || 1;
const ux = (player.x - bx) / len;
const uy = (player.y - by) / len;
const ahead = shells.filter((t) => (t.mesh.position.x - bx) * ux + (t.mesh.position.y - by) * uy > 0);
check('...held between the boss and the player', shells.length === 0 || ahead.length === shells.length,
  `${ahead.length}/${shells.length} on the player's side of the boss`);
// They are furniture, not a health bar: a turtle cannot be killed, which is
// what makes the answer "move" rather than "shoot through it".
//
// ASSERTED ON THE PROPERTY, NOT ON A BIG NUMBER. This used to read `hp > 1000`,
// which was true only because the turtle carried hp 1e9 to mean "unkillable" —
// a proxy that passed for the right reason by accident and would have gone on
// passing if the turtle had merely become very tough. Invincibility is a flag
// on the row now (`invincible` in enemies.csv), so the test can make the claim
// directly: shoot one and see that it does not die.
check('...and they carry the invincible flag', shells.every((t) => t.invincible === true),
  `invincible=${shells[0]?.invincible}`);
if (shells.length) {
  const t = shells[0];
  const before = t.hp;
  t.hp -= 1e6;
  check('...and they cannot be killed', t.hp === before && t.hp > 0,
    `hp ${before} -> ${t.hp} after a 1,000,000 hit`);
}

// ---------------------------------------------------------------------------
// 3. THE ELECTRIC AURA'S FIELD STAYS INSIDE ITS OWN RING
// ---------------------------------------------------------------------------
// The aura is the one zone in the game whose art IS its hitbox: the ring is
// drawn at the radius the row gives it, and updateElectric's own note explains
// why its boundary is never allowed to move by more than it breathes. A boundary
// the player stops trusting is worse than no art at all.
//
// The field inside it (goo group `aura`) is a thresholded density surface, which
// wobbles by construction — so it is held clear of the rim, and this is the
// check that says so. Two ways it could fail, and only one of them is visible
// in a still frame:
//
//   TOO BIG    a lobe draws `size x the group's radius`, several times the
//              sprite it would otherwise be, so a lobe whose CENTRE is legal
//              can still paint itself across the ring.
//   LEFT BEHIND  the ring is redrawn on the animal every frame and a particle
//              cannot be: its path is solved from where it was born. A boss
//              swimming away from its own field leaves lobes outside the ring
//              a fraction of a second later, which is the same lie arriving
//              late — and it is invisible unless the boss is MOVING in the test.
{
  const fx = CONFIG.boss?.perkFx?.electric ?? {};
  const perk = perkById('electric');
  const goo = CONFIG.fx?.goo;
  const def = CONFIG.emitters.auraField;
  const groupRadius = goo?.groups?.[def.goo]?.radius ?? goo?.radius ?? 3;

  // Switched on for the duration. The fill ships OFF — the job it was built for
  // is now done by the hit marker in systems/bossImpact.js — but the guarantee
  // it makes is the reason the mechanism can be switched back on at all, so it
  // is still measured rather than left to rot behind a false boolean.
  const shippedFill = fx.fillEnabled;
  fx.fillEnabled = true;

  for (const [label, speed] of [['holding station', 0], ['cruising', 3], ['sprinting', 9]]) {
    fresh();
    resetParticles();
    const b = put('bossShark', { boss: true });
    attachBossPerk(scene, b, perk);
    const reach = (b.def.radius ?? 1) * (b.sizeMul ?? 1) + (perk.radius ?? 9);

    const seen = new Map();
    const lobes = [];
    // The boss is driven by hand rather than through updateEnemies: what is
    // being tested is the geometry of the field against a moving centre, and a
    // steered animal would wander out of the straight line that makes the lag
    // worst.
    for (let f = 0; f < 60 * 4; f++) {
      b.vx = speed;
      b.vy = 0;
      b.mesh.position.x += speed * DT;
      updateBossPerks(DT, scene, playerFar, hooks);
      for (let i = 0; i < CAP; i++) {
        const start = attrs.aStart.array[i];
        if (start < -1e8 || seen.get(i) === start || attrs.aGoo.array[i] === 0) continue;
        seen.set(i, start);
        lobes.push({
          x: attrs.position.array[i * 3], y: attrs.position.array[i * 3 + 1],
          vx: attrs.aVelocity.array[i * 3], vy: attrs.aVelocity.array[i * 3 + 1],
          drag: attrs.aDrag.array[i], life: attrs.aLife.array[i],
          size: attrs.aSize.array[i],
          // Where the boss was when this lobe was born, and when — enough to
          // put the ring where it will be at any point in the lobe's flight.
          bx: b.mesh.position.x, by: b.mesh.position.y, at: f * DT,
        });
      }
      updateParticles(DT);
    }

    // Walked over each lobe's whole life against a ring that is moving with the
    // boss. Sampling the birth frame alone would pass on every one of these.
    let outside = 0;
    let worst = 0;
    for (const p of lobes) {
      const half = p.size * groupRadius * 0.5;
      const steps = 30;
      for (let s = 0; s <= steps; s++) {
        const age = (p.life * s) / steps;
        const k = Math.max(p.drag, 1e-4);
        const f = (1 - Math.exp(-k * age)) / k;
        const x = p.x + p.vx * f;
        const y = p.y + p.vy * f;
        // The ring's centre at that moment: where the boss will have got to.
        const cx = p.bx + speed * age;
        const edge = Math.hypot(x - cx, y - p.by) + half;
        worst = Math.max(worst, edge / reach);
        if (edge > reach) outside += 1;
      }
    }
    check(`the aura field never crosses its own ring — ${label}`, outside === 0,
      `worst lobe edge reached ${(worst * 100).toFixed(0)}% of the ${reach.toFixed(1)}u reach`);
    // ...and the check must not be passing because the field is empty. At a
    // sprint it legitimately can be — the lag eats the whole usable radius, and
    // going quiet is the designed degradation — so that case asserts the rule
    // rather than the population.
    if (speed <= 3) {
      check(`  ...with a field to check — ${label}`, lobes.length > 0, `${lobes.length} lobes`);
    } else {
      check(`  ...a sprinting boss simply has no field — ${label}`,
        lobes.length === 0 || worst <= 1,
        `${lobes.length} lobes emitted`);
    }
  }
  fx.fillEnabled = shippedFill;
}

// The cleanup. A perk that left `perkDrive` raised on three animals would
// leave them frozen in the water for the rest of the run.
resetBossPerks();
check('releasing the perk hands the turtles back',
  shells.every((t) => !t.perkDrive && t.leaving));
check('...and forgets the perk entirely', activeBossPerk() === null);

fresh();
console.log(failures ? `\n${failures} FAILED\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
