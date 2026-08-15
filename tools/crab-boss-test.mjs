#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:crabboss
//
// The king crab — the one boss that walks. Everything it does differently from
// the other four is a consequence of `behavior: 'crawl'`, and every one of
// those consequences is a quiet failure rather than an error:
//
//   1. REACH     A crawler is clamped to `bounds.bottom + crawl.groundHeight`.
//                At the swarm crab's 2.5 the boss could be beaten by treading
//                water above it — a boss that cannot touch you is a boss you
//                ignore, and nothing anywhere says so. So: it climbs, it gets
//                to a player hanging mid-water, and it is still held under its
//                own ceiling.
//   2. PRESSURE  It rushes from anywhere in the column rather than only when
//                the player comes near the sand (`floorRushHeight`), which is
//                the difference between a boss and seabed scenery.
//   3. FAMILY    It must NOT be filed in spawnGroup 'crab' — systems/
//                crabSpawner.js summons whatever is in that group, so a chum
//                pile would call up a second king crab mid-fight.
//   4. FOCUS     No `crawl.feed`: a boss does not stop to eat the chum the
//                player needs. An orb left in front of it survives.
//   5. THE EYES  Its stalks reach the bake, and its preset actually lights
//                them — the pair that shipped dark for weeks (see
//                tools/biolum-skin-test.mjs).
//
// No renderer: three.js Object3D/Scene are plain data and nothing here draws.
// The browser preview suspends requestAnimationFrame, so a screenshot proves
// nothing about whether the loop works; every number below comes from ticking
// the functions main.js ticks.
//
//   node --import ./tools/vite-loader.mjs tools/crab-boss-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { ASSETS } from '../path/src/assets.js';
import { bounds } from '../path/src/arena.js';
import { enemies, spawnNamed, updateEnemies, resetEnemies } from '../path/src/entities/enemies.js';
import { pickups, spawnXpOrb, updatePickups, resetPickups } from '../path/src/entities/pickups.js';
import { pickCrab, resetCrabSpawner } from '../path/src/systems/crabSpawner.js';
import { parseBossCsv } from '../path/src/bossTable.js';
import bossesCsv from '../path/src/bosses.csv?raw';

const scene = new THREE.Scene();
const dt = 1 / 60;
let failures = 0;

// The animation controller warns once per state per creature for clips a
// procedural stand-in doesn't have, which in Node is all of them.
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

const FLOOR = bounds.bottom;
const DEF = CONFIG.enemies.bossCrab;
const ARCH = parseBossCsv(bossesCsv, CONFIG.enemies, () => {}).find((b) => b.id === 'bossCrab');

// The archetype's size step, applied the way systems/boss.js applies it. Not
// imported from there: this file wants a crab in the water without the arrival
// ceremony, the perk roll and the clear-out that a real arrival brings.
function spawnKingCrab(at) {
  const e = spawnNamed(scene, 'bossCrab', 0, at, { ignoreCaps: true, overfill: true });
  if (!e) return null;
  const mul = ARCH?.sizeMul ?? 1;
  e.visual.scale.multiplyScalar(mul);
  e.spawnScale *= mul;
  e.sizeMul *= mul;
  e.radius *= mul;
  e.isBoss = true;
  return e;
}

// ---------------------------------------------------------------------------
section('THE ROSTER ROW');
// ---------------------------------------------------------------------------
check('bosses.csv carries a king crab', !!ARCH, ARCH ? `sizeMul ${ARCH.sizeMul}, from level ${ARCH.minLevel}` : 'no row');
check('...pointing at a creature that exists', !!DEF, ARCH?.enemy);
check('...which is never in a run\'s first fight', (ARCH?.minLevel ?? 0) > 0,
  `minLevel ${ARCH?.minLevel}`);
check('...and walks rather than swims', DEF?.behavior === 'crawl', DEF?.behavior);
check('its body is its own asset, not the swarm\'s',
  DEF?.asset === 'enemyBossCrab' && !!ASSETS[DEF.asset],
  `${DEF?.asset} — a shared key would repaint every crab on the seabed`);

// ---------------------------------------------------------------------------
section('IT IS NOT ONE OF THE SWARM');
// ---------------------------------------------------------------------------
// crabSpawner summons whatever enemies.csv files under spawnGroup 'crab'. A
// boss in that family is a second king crab walking on because the player
// dropped six orbs.
resetCrabSpawner();
// Asked, not reasoned about: pickCrab is the function the pile actually calls,
// and it reads the family off enemies.csv's spawnGroup column. Sampled across
// the difficulty range because the day/night split changes which rows are
// eligible, and a boss leaking into either half is the same bug.
const summoned = new Set();
for (let d = 0; d < 40; d += 0.5) for (let i = 0; i < 20; i++) summoned.add(pickCrab(d));
check('the chum spawner cannot summon it', !summoned.has('bossCrab'),
  `pile summons: ${[...summoned].filter(Boolean).join(', ')}`);
check('...because it is filed outside the crab family', DEF?.spawnGroup !== 'crab',
  `spawnGroup ${DEF?.spawnGroup}`);
check('it never comes out of the weighted pool',
  (DEF?.weight ?? 0) === 0 && (DEF?.spawnRateMul ?? 1) === 0,
  `weight ${DEF?.weight}, spawnRateMul ${DEF?.spawnRateMul}`);

// ---------------------------------------------------------------------------
section('IT WALKS ON, THE WAY A CRAB DOES');
// ---------------------------------------------------------------------------
{
  resetEnemies(scene);
  const e = spawnKingCrab();
  check('a king crab spawns', !!e, e ? `radius ${e.radius.toFixed(2)}` : 'none');
  check('...from outside the wall, so the walk-on is visible',
    Math.abs(e.mesh.position.x) > bounds.right,
    `x ${e.mesh.position.x.toFixed(1)} against a wall at ${bounds.right.toFixed(1)}`);
  check('...at seabed height rather than mid-water',
    e.mesh.position.y - FLOOR < 6,
    `${(e.mesh.position.y - FLOOR).toFixed(2)} above the floor`);

  // Ten seconds with the player standing in the middle: it should be inside
  // the arena and heading in.
  const player = new THREE.Vector3(0, FLOOR + 3, 0);
  for (let i = 0; i < 10 * 60; i++) updateEnemies(dt, scene, player, () => {}, () => {});
  check('ten seconds later it is in the arena',
    Math.abs(e.mesh.position.x) < bounds.right,
    `x ${e.mesh.position.x.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
section('IT COMES UP THE WATER COLUMN AT YOU');
// ---------------------------------------------------------------------------
// THE FIGHT'S WHOLE PREMISE. The swarm crab notices the player only inside
// `floorRushHeight` of the sand and is pinned under `groundHeight`; a boss
// built from those numbers is beaten by swimming up and waiting.
{
  const ceiling = FLOOR + (DEF.crawl?.groundHeight ?? 2.5);
  check('its ceiling is well clear of the swarm\'s',
    (DEF.crawl?.groundHeight ?? 0) > (CONFIG.enemies.walkingCrab.crawl?.groundHeight ?? 2.5) * 3,
    `${DEF.crawl?.groundHeight} against the swarm's ${CONFIG.enemies.walkingCrab.crawl?.groundHeight}`);
  check('and it rushes from anywhere in the column',
    (DEF.crawl?.floorRushHeight ?? 0) >= bounds.surfaceY - FLOOR,
    `floorRushHeight ${DEF.crawl?.floorRushHeight} against a ${(bounds.surfaceY - FLOOR).toFixed(1)}-deep column`);

  resetEnemies(scene);
  const e = spawnKingCrab({ x: -20, y: FLOOR + 1 });
  e.entering = false; // already walked on; this section is about the climb

  // The seal hangs eight units up — out of a swarm crab's reach entirely.
  const player = new THREE.Vector3(0, FLOOR + 8, 0);
  let peak = -Infinity;
  let closest = Infinity;
  for (let i = 0; i < 20 * 60; i++) {
    updateEnemies(dt, scene, player, () => {}, () => {});
    peak = Math.max(peak, e.mesh.position.y - FLOOR);
    closest = Math.min(closest, e.mesh.position.distanceTo(player));
  }
  check('it climbs off the seabed after a player who will not come down',
    peak > (CONFIG.enemies.walkingCrab.crawl?.groundHeight ?? 2.5),
    `reached ${peak.toFixed(1)} above the floor`);
  check('...and gets to them', closest < e.radius + 2,
    `closest approach ${closest.toFixed(2)} against a ${e.radius.toFixed(2)} radius`);
  check('...without leaving the layer it belongs to',
    e.mesh.position.y <= ceiling + 0.01,
    `held under ${(ceiling - FLOOR).toFixed(1)} above the floor`);

  // ...and the surface is still an escape. A boss that could follow the seal
  // to the waterline would not be a floor boss at all.
  const high = new THREE.Vector3(0, bounds.surfaceY - 4, 0);
  for (let i = 0; i < 20 * 60; i++) updateEnemies(dt, scene, high, () => {}, () => {});
  check('a seal that runs for the surface is out of reach',
    high.y - e.mesh.position.y > 10,
    `${(high.y - e.mesh.position.y).toFixed(1)} below the player`);
}

// ---------------------------------------------------------------------------
section('IT DOES NOT STOP FOR CHUM');
// ---------------------------------------------------------------------------
// The swarm eats the pile; that is what makes diving down a decision. A boss
// parked on the biggest heap would deny the arena's only reason to go there.
{
  check('it declares no feeding behaviour at all', !DEF.crawl?.feed,
    DEF.crawl?.feed ? 'it has a feed block' : 'no crawl.feed');

  resetEnemies(scene);
  resetPickups(scene);
  const e = spawnKingCrab({ x: 0, y: FLOOR + 1 });
  e.entering = false;
  for (let i = 0; i < 6; i++) spawnXpOrb(scene, { x: 2 + i * 0.6, y: FLOOR + 0.8, z: 0 }, 1);
  const before = pickups.length;
  // The player is far away and high up, so nothing here is the player's doing.
  const player = { mesh: { position: new THREE.Vector3(bounds.right - 4, bounds.surfaceY - 4, 0) },
    chumSealed: false, stats: { pickupRadius: 0.0001, chumGulpRadius: 0, hitRadius: 1.2 } };
  for (let i = 0; i < 20 * 60; i++) {
    updateEnemies(dt, scene, player.mesh.position, () => {}, () => {});
    updatePickups(dt, scene, player, () => {});
  }
  check('the chum in front of it is untouched', pickups.length === before,
    `${pickups.length} of ${before} orbs left`);
  check('...and it is not chewing', !e.eating);
}

// ---------------------------------------------------------------------------
section('THE EYES');
// ---------------------------------------------------------------------------
// The stalk names are checked against the skeleton in tools/biolum-skin-test.mjs
// (which also guards the pipeline forwarding them). What is checked here is the
// half that is this boss's own: it declares them, and its preset lights them.
{
  const asset = ASSETS[DEF.asset] ?? {};
  const preset = CONFIG.biolumSkin?.presets?.[asset.biolumSkin] ?? null;
  check('the body declares its eye stalks', asset.eyeStalks?.length === 2,
    asset.eyeStalks ? asset.eyeStalks.map((s) => s[0]).join(', ') : 'none');
  check('...and shares them with the rest of the family, by reference',
    asset.eyeStalks === ASSETS.enemyWalkingCrab.eyeStalks,
    'one binary, one set of bone names');
  check('its preset exists', !!preset, asset.biolumSkin);
  check('...and actually lights the eyes', (preset?.eyeStrength ?? 0) > 0,
    `eyeStrength ${preset?.eyeStrength}`);
  check('...brighter than the swarm crabs, since there is only ever one',
    (preset?.eyeStrength ?? 0) > (CONFIG.biolumSkin.presets.emberClaw?.eyeStrength ?? 0),
    `${preset?.eyeStrength} against the ember crab's ${CONFIG.biolumSkin.presets.emberClaw?.eyeStrength}`);
  // The beams a gun perk fires come out of the eyeball joints, not the sockets
  // — on a stalked animal those are a body-length apart.
  const nodes = CONFIG.boss?.perkFx?.eyeNodes?.bossCrab ?? [];
  check('a perk\'s beams fire from the eyeballs', nodes.length === 2
    && nodes.every((n) => asset.eyeStalks.some((s) => s.includes(n))),
    nodes.join(', ') || 'none declared');
}

console.log(failures ? `\n${failures} FAILED` : '\nPASS — all checks');
process.exit(failures ? 1 : 0);
