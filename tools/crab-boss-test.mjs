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
import { parseBossPerkCsv, rollBossPerk } from '../path/src/bossPerkTable.js';
import { STORM_PERKS } from '../path/src/systems/bossPerks.js';
import { bossLookFor } from '../path/src/systems/bossLook.js';
import bossesCsv from '../path/src/bosses.csv?raw';
import bossPerksCsv from '../path/src/bossPerks.csv?raw';

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
// NOT AN ASSERTION ANY MORE, on purpose. This used to require minLevel > 0 —
// "never a run's first fight" — and the roster now ships it at 0 deliberately,
// so the crab can be reached without playing up to it. Held as a printed fact
// rather than deleted: the number is load-bearing for pacing and worth having
// in the log of every run of this file, and a check that encodes a preference
// somebody has since overruled is a check that gets edited to whatever the data
// says, which is no check at all.
console.log(`  ----  it can open a run — minLevel ${ARCH?.minLevel}`);
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
  // THE BOSS IS THE DIMMER OF THE TWO NOW, and that is a decision rather than a
  // regression. This asked for kingCrab > emberClaw on the reasoning that the
  // lone boss should out-burn the swarm; the shipped tuning puts the swarm at 6
  // and the boss at 0.75, because a screen of ember crabs is read as a mass and
  // the boss is read as a silhouette, and a boss whose eyes out-glare thirty of
  // them loses its outline in its own bloom.
  //
  // What is still worth guarding is the thing that made the comparison tempting:
  // the boss's eyes must LIGHT, which is the check above, and they must not be
  // so far under the swarm's that they read as unlit next to one. An order of
  // magnitude is the line — 0.75 against 6 is 8x and deliberate; 0.75 against
  // 60 would be the boss's eyes going out and nobody noticing.
  const swarmEyes = CONFIG.biolumSkin.presets.emberClaw?.eyeStrength ?? 0;
  check('...and not lost against the swarm crabs beside it',
    (preset?.eyeStrength ?? 0) * 10 >= swarmEyes,
    `${preset?.eyeStrength} against the ember crab's ${swarmEyes}`);
  // The beams a gun perk fires come out of the eyeball joints, not the sockets
  // — on a stalked animal those are a body-length apart.
  // RENAMED from `eyeNodes` — the old key was pinned in saved tuning holding
  // stale names, so correcting config.js alone changed nothing. See the note
  // there, and tools/boss-eye-test.mjs, which checks every name against the
  // model rather than only the crab's against the stalk list.
  const nodes = CONFIG.boss?.perkFx?.eyeSockets?.bossCrab ?? [];
  check('a perk\'s beams fire from the eyeballs', nodes.length === 2
    && nodes.every((n) => asset.eyeStalks.some((s) => s.includes(n))),
    nodes.join(', ') || 'none declared');
}

// ---------------------------------------------------------------------------
// FROM LEVEL 5 IT LEANS ON THE ATTRACTORS
//
// bosses.csv `perkBias` names the perks this archetype wants and
// `perkBiasLevel` says from when. The crab leans on the four attractor studies,
// because a boss that walks the seabed is the body in the roster a field
// opened AROUND it changes most — everything else can simply swim out of its
// own storm, and this one is standing in the middle of it on legs.
//
// A LEAN AND NOT A LOCK, which is the part worth asserting: a bias that always
// won would be an archetype with a fixed perk, and the whole reason a boss
// rolls one is that two crab fights should not be the same fight. The chance
// is checked as a RATE over seeded draws rather than as a single roll, for the
// reason every Monte Carlo check in this project is: one draw proves nothing,
// and a threshold lowered to make a flake go away proves less.
// ---------------------------------------------------------------------------
{
  section('THE PERK IT LEANS ON');
  const PERKS = parseBossPerkCsv(bossPerksCsv, () => {});
  const bias = ARCH?.perkBias ?? [];

  check('the crab names a perk bias', bias.length > 0, bias.join(' ') || 'none');
  check('...from level 5', ARCH?.perkBiasLevel === 5, String(ARCH?.perkBiasLevel));
  check('...with a strong chance rather than a certainty',
    ARCH?.perkBiasChance >= 0.5 && ARCH?.perkBiasChance < 1,
    `${ARCH?.perkBiasChance} — a lean, not a lock`);
  check('...and every perk it names is a real, enabled row',
    bias.every((id) => PERKS.some((p) => p.id === id)),
    bias.filter((id) => !PERKS.some((p) => p.id === id)).join(', ') || 'all present');
  check('...and every one of them is a strange attractor',
    bias.every((id) => STORM_PERKS.has(id)),
    bias.filter((id) => !STORM_PERKS.has(id)).join(', ') || 'four studies');

  // The paint is half of what the bias buys. A boss that leans on a perk with
  // no bossLooks.csv row leans on a fight the player cannot see coming on the
  // ANIMAL — see systems/bossLook.js.
  check('...and every one of them paints the body',
    bias.every((id) => !!bossLookFor(id)),
    bias.filter((id) => !bossLookFor(id)).join(', ') || 'four looks');

  // Seeded, so this measures the roll and not the day. mulberry32.
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function rate(opts) {
    const r = rng(20260828);
    let hits = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const perk = rollBossPerk(PERKS, 1, r, opts);
      if (perk && bias.includes(perk.id)) hits++;
    }
    return hits / N;
  }

  const leaned = rate({ bias, chance: ARCH?.perkBiasChance });
  const flat = rate({});
  // The floor is the chance itself: the lean lands that often, and the
  // remaining flat roll can land on one of the same four again.
  check('a crab past the level meets an attractor most of the time',
    leaned >= ARCH.perkBiasChance && leaned <= ARCH.perkBiasChance + 0.2,
    `${(leaned * 100).toFixed(1)}% of 4000 rolls, against a ${ARCH.perkBiasChance} chance`);
  check('...but not every time — it is still a roll', leaned < 0.95,
    `${(100 - leaned * 100).toFixed(1)}% of crabs still arrive with something else`);
  check('a crab BELOW the level rolls flat, like every other boss',
    flat < leaned - 0.2,
    `${(flat * 100).toFixed(1)}% against ${(leaned * 100).toFixed(1)}% — spawnBoss passes no bias under perkBiasLevel`);
  check('...and the bias never produces a boss with NO perk',
    rollBossPerk(PERKS, 1, rng(7), { bias: ['saddle'], chance: 1 }) != null,
    'an empty intersection falls through to the ordinary roll');
  check('...nor overrides the first boss of a run having none',
    rollBossPerk(PERKS, 0, rng(7), { bias, chance: 1 }) === null);
}

console.log(failures ? `\n${failures} FAILED` : '\nPASS — all checks');
process.exit(failures ? 1 : 0);
