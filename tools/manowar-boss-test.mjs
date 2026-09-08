#!/usr/bin/env node
// The man o' war boss — the fight you have to leave the water for.
//
//   npm run test:manowarboss
//
// Three claims, and each of them is the kind that passes a code review while
// being false on screen.
//
//   IT CAN ONLY BE HURT FROM ABOVE. Enforced by absorbing the `hp` write (see
//        armDamageFromAbove in entities/enemies.js), because eighteen systems
//        own the line `e.hp -= something` and a test that only fires the gun
//        would certify a gate the club walks straight through. So this hits it
//        the way those systems do — by writing `hp` directly — from below and
//        from above, and checks the two answers differ.
//   IT RIDES THE SURFACE, on a body 2.6x the wave animal. The pin is in world
//        units and the body is not, so "it works at 1.9" is not evidence that
//        it works at 2.6.
//   ITS PERKS LEAN ON THE PROJECTILES. A bias is a dice roll, so this rolls it
//        a thousand times and reads the rate — against the FLAT rate from the
//        same table, because "70% were projectiles" means nothing until you
//        know what an unbiased table would have given.
import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { ASSET_ROWS } from '../path/src/assetTable.js';
import { enemies, resetEnemies, updateEnemies } from '../path/src/entities/enemies.js';
import { resetBoss, bossState, forceBoss, bossArchetypes } from '../path/src/systems/boss.js';
import { parseBossPerkCsv, rollBossPerk } from '../path/src/bossPerkTable.js';
import { player } from '../path/src/entities/player.js';
import { hotSpotZoneBonus } from '../path/src/systems/damageZones.js';
import { bounds, surfaceHeightAt } from '../path/src/arena.js';
import { readFileSync } from 'node:fs';

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
Math.random = seeded(0x5EA1);

const scene = new THREE.Scene();
const DT = 1 / 60;
let fail = 0;
const check = (n, ok, d = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? ` — ${d}` : ''}`);
  if (!ok) fail++;
};

console.log('\nTHE ARCHETYPE');
const arch = bossArchetypes().find((b) => b.id === 'bossManOWar');
// Its assets.csv size, read rather than typed — every span below multiplies it.
const bsize = Number(ASSET_ROWS.get('bossManOWar').size);
function bdefEarly() { return CONFIG.enemies.bossManOWar; }
check('bosses.csv carries the archetype', !!arch);
check('...pointing at its own body', arch?.enemy === 'bossManOWar', arch?.enemy);
check('...and it is NOT an opener', !arch?.opener,
  'a first boss the player cannot hurt with what they have been doing is a wall');

resetEnemies(scene); resetBoss(scene);
const gs = { difficulty: 10, level: 12, running: true };
const boss = forceBoss(scene, gs, { boss: 'bossManOWar', perk: 'spitfish' });
check('it spawns', !!boss, boss?.type);
if (!boss) process.exit(1);

// Through the entrance, exactly as the boat harness does — nothing moves a
// creature but updateEnemies, so a loop that skips it measures a boss that is
// still off the edge of the picture.
const below = { x: 0, y: bounds.bottom + 6, z: 0 };
let n = 0;
while ((bossState.approaching || bossState.arriving) && n++ < 3000) {
  updateEnemies(DT, scene, below, () => {}, () => {});
}
for (let i = 0; i < 120; i++) updateEnemies(DT, scene, below, () => {}, () => {});

console.log('\nIT RIDES THE SURFACE AT BOSS SIZE');
const rel = boss.mesh.position.y - surfaceHeightAt(boss.mesh.position.x);
console.log(`  radius ${boss.radius.toFixed(2)} (the wave body is 0.95)`);
console.log(`  sitting ${rel.toFixed(3)} from the local water height`);
check('it holds the waterline', Math.abs(rel - CONFIG.enemies.bossManOWar.surface.lift) < 0.4,
  rel.toFixed(3));
// Against the WAVE ANIMAL'S OWN radius rather than a typed number — the two
// bodies are the same model and the whole claim is a ratio between them, so a
// hardcoded threshold here is a number that goes stale the moment either row
// is retuned. (It already did: this read `> 2` while the radius was
// accidentally 6.76, and sizing the hitbox to the float correctly is what
// "broke" it.)
const waveRadius = CONFIG.enemies.manowar.radius
  * Number(ASSET_ROWS.get('enemyManOWar').size);
check('...and it is bigger than the wave animal', boss.radius > waveRadius * 1.8,
  `${boss.radius.toFixed(2)} vs ${waveRadius.toFixed(2)} — ${(boss.radius / waveRadius).toFixed(1)}x`);
// The hitbox is the float; the ANIMAL is the thing the player sees, and it is
// the ratio of the two long axes that makes this read as a monstrous version
// rather than a slightly large one. fit x size x sizeMul, both bodies.
const waveSpan = 2 * Number(ASSET_ROWS.get('enemyManOWar').size);
const bossSpan = 2 * bsize * arch.sizeMul;
check('...and the animal itself is far bigger than its hitbox suggests',
  bossSpan > waveSpan * 2.5,
  `${bossSpan.toFixed(1)} world units long vs the wave body's ${waveSpan.toFixed(1)}`);

console.log('\nWHERE YOU HIT IT FROM IS WHAT IT IS WORTH');
const Z = bdefEarly().damageZones;
check('the grade armed itself', boss.damageZones === true);

// The grade reads `player.mesh`, and in a terminal nothing has built one — so
// it has to be stood up here or every hit is ungraded (which is the right
// default in the game, and useless as a test of a grade).
player.mesh = player.mesh ?? new THREE.Object3D();

// Written the way the eighteen systems write it, because that is the only
// interception point and therefore the only honest way to test it.
function hitFrom(dyRadii, amount = 1000) {
  player.mesh.position.set(boss.mesh.position.x, boss.mesh.position.y + dyRadii * boss.radius, 0);
  const before = boss.hp;
  boss.hp -= amount;
  return (before - boss.hp) / amount;
}
const atBelow = hitFrom(-3);
const atLevel = hitFrom(0);
const atAbove = hitFrom(3);
console.log(`  from below ${(atBelow * 100).toFixed(0)}%   level ${(atLevel * 100).toFixed(0)}%   from above ${(atAbove * 100).toFixed(0)}%`);
check('from underneath it is minimal', Math.abs(atBelow - Z.below) < 1e-6, `${atBelow}`);
check('level with it — the water surface — is medium', Math.abs(atLevel - Z.side) < 1e-6, `${atLevel}`);
check('from above is full', Math.abs(atAbove - Z.above) < 1e-6, `${atAbove}`);
// THE ORDER IS THE MECHANIC. Checked as a chain rather than three constants so
// a future retune cannot quietly invert it and still pass.
check('...and the three are strictly ordered', atBelow < atLevel && atLevel < atAbove,
  `${atBelow} < ${atLevel} < ${atAbove}`);
check('nothing is a total refusal — a dead hit reads as a broken weapon',
  atBelow > 0, `${atBelow}`);

// The bands are in RADII, so the boundary must sit clear of the float or "from
// above" is reachable without leaving the water and the mechanic is decorative.
const barY = boss.mesh.position.y + Z.aboveGap * boss.radius;
check('the top band starts above the water', barY > surfaceHeightAt(boss.mesh.position.x),
  `bar ${barY.toFixed(2)} vs water ${surfaceHeightAt(boss.mesh.position.x).toFixed(2)}`);

// An increment is not an attack.
player.mesh.position.set(boss.mesh.position.x, boss.mesh.position.y - 30, 0);
const healFrom = boss.hp;
boss.hp = healFrom + 50;
check('healing is never graded', boss.hp === healFrom + 50, `${healFrom} -> ${boss.hp}`);

console.log('\nA WEAK SPOT STRUCK FROM ABOVE PAYS MORE STILL');
check('the bonus is its own number, not folded into `above`',
  Z.hotSpotAbove > 1 && Z.hotSpotAbove !== Z.above, `${Z.hotSpotAbove}`);
player.mesh.position.set(boss.mesh.position.x, boss.mesh.position.y + 3 * boss.radius, 0);
check('...and it applies only from above', hotSpotZoneBonus(boss) === Z.hotSpotAbove,
  `${hotSpotZoneBonus(boss)}`);
player.mesh.position.set(boss.mesh.position.x, boss.mesh.position.y - 3 * boss.radius, 0);
check('...and is 1 from anywhere else', hotSpotZoneBonus(boss) === 1, `${hotSpotZoneBonus(boss)}`);

console.log('\nSHOVED UNDER, IT FLOATS BACK UP');
player.mesh.position.set(0, -100, 0); // out of the way of the grade
const line0 = surfaceHeightAt(boss.mesh.position.x);
boss.mesh.position.y = line0 - 9;
boss.vy = -4;
let backUp = null;
let overshoot = -Infinity;
for (let i = 0; i < 60 * 10; i++) {
  updateEnemies(DT, scene, below, () => {}, () => {});
  const rel2 = boss.mesh.position.y - surfaceHeightAt(boss.mesh.position.x);
  if (backUp == null && rel2 >= bdefEarly().surface.lift - 0.2) backUp = (i + 1) * DT;
  if (backUp != null) overshoot = Math.max(overshoot, rel2);
}
console.log(`  dunked 9 units under: back at the line in ${backUp?.toFixed(2)}s, peaked ${overshoot.toFixed(2)}`);
check('it comes back up on its own', backUp != null && backUp < 4, `${backUp?.toFixed(2)}s`);
// FASTER THAN THE SPRING COULD, which is the whole reason buoyancy is not just
// a bigger `rise`: winching 9 units at the bob speed would take 3s flat.
check('...buoyantly, not winched at the bob speed',
  backUp != null && backUp < 9 / bdefEarly().surface.rise,
  `${backUp?.toFixed(2)}s vs ${(9 / bdefEarly().surface.rise).toFixed(2)}s winched`);
check('...and settles back on the line',
  Math.abs((boss.mesh.position.y - surfaceHeightAt(boss.mesh.position.x)) - bdefEarly().surface.lift) < 0.4,
  `${(boss.mesh.position.y - surfaceHeightAt(boss.mesh.position.x)).toFixed(3)}`);

console.log('\nTHE PERKS LEAN ON THE PROJECTILES');
// The three that put something in the air between the boss and the player.
const PROJECTILE = new Set(['spitfish', 'finfish', 'barrels']);
const PERKS = parseBossPerkCsv(readFileSync('path/src/bossPerks.csv', 'utf8'), () => {});
const ROLLS = 4000;
function rate(bias) {
  const rng = seeded(0xC0FFEE);
  let hits = 0;
  let rolled = 0;
  for (let i = 0; i < ROLLS; i++) {
    const p = rollBossPerk(PERKS, 3, rng, bias);
    if (!p) continue;
    rolled++;
    if (PROJECTILE.has(p.id)) hits++;
  }
  return rolled ? hits / rolled : 0;
}
const flat = rate({});
const biased = rate({ bias: arch.perkBias, chance: arch.perkBiasChance });
console.log(`  flat table            ${(flat * 100).toFixed(1)}% projectiles`);
console.log(`  with the man o' war's ${(biased * 100).toFixed(1)}%  (chance ${arch.perkBiasChance})`);
check('the bias names the projectile perks',
  arch.perkBias.every((p) => PROJECTILE.has(p)) && arch.perkBias.length === 3,
  arch.perkBias.join(' '));
check('...and it actually moves the roll', biased > flat + 0.2,
  `${(flat * 100).toFixed(1)}% -> ${(biased * 100).toFixed(1)}%`);
check('...without making it a certainty — a quarter still roll the flat table',
  biased < 0.95, `${(biased * 100).toFixed(1)}%`);
check('...and the lean waits for level 5', arch.perkBiasLevel === 5, String(arch.perkBiasLevel));

console.log('\nIT SAILS AND IT STINGS');
const bdef = CONFIG.enemies.bossManOWar;
check('no constant spin on the boss either', !bdef.spin && !bdef.spinAxis);
check('...it sails, and slower than the wave animal', 
  bdef.sail?.time > CONFIG.enemies.manowar.sail.time,
  `${bdef.sail?.time}s vs ${CONFIG.enemies.manowar.sail.time}s`);

// THE STING'S OWN MULTIPLES. The two bodies' radii were sized against
// different things — the wave animal's covers its bulk, this one's covers the
// float alone on a body 2.6x longer — so the same offset/radius pair cannot be
// right for both, and checking the boss against the WAVE animal's numbers is
// the mistake this guards.
const bscale = (2 / 5.735) * bsize * arch.sizeMul;
const bToFloatTop = 0.25 * 2 * bsize * arch.sizeMul;
const bToTip = 0.75 * 2 * bsize * arch.sizeMul;
const bToCrown = bToFloatTop - (2.81 - 0.512) * bscale;
const bStingY = -bdef.sting.offset * boss.radius;
const bStingR = bdef.sting.radius * boss.radius;
console.log(`  radius ${boss.radius.toFixed(2)}, filaments run ${(-bToCrown).toFixed(2)} to ${bToTip.toFixed(2)} below the origin`);
console.log(`  sting: radius ${bStingR.toFixed(2)} centred ${bStingY.toFixed(2)} below it`);
check('the boss sting reaches its own tips', bStingY + bStingR >= bToTip - 0.8,
  `reaches ${(bStingY + bStingR).toFixed(2)}, tips at ${bToTip.toFixed(2)}`);
check('...and clears its own float', bStingY - bStingR > -bToFloatTop,
  `${(bStingY - bStingR).toFixed(2)} vs float at ${(-bToFloatTop).toFixed(2)}`);
check('...and it is a LOW drain for a boss', bdef.contactDamage <= 20, `${bdef.contactDamage}/s`);
// The channel matters more here than anywhere: capBossDamage keys its
// per-second ceiling on the literal string 'contact', so a sting on a channel
// of its own would escape the one cap that holds a boss's overlap down.
check('the drain still rides the capped channel',
  /'contact',/.test(readFileSync('path/src/systems/combat.js', 'utf8').split('sting.feedback')[0].slice(-900)),
  'combat.js passes \'contact\' from the sting branch');

console.log('\nIT HAS A NAME');
check('the roll produced one', !!bossState.name, bossState.name);

console.log(`\n${fail ? `${fail} FAILED` : 'all checks passed'}\n`);
process.exit(fail ? 1 : 0);
