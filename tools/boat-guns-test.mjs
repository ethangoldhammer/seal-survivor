#!/usr/bin/env node
// THE DECK GUNS — boats and trawlers shoot fish at a seal under the water,
// and an artillery trawler shoots homing mussels and a gull at a seal above it.
// See CONFIG.boats.guns and systems/boats.js (armBoat / updateBoatGun).

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG, difficultyRamp, enemyPaceMul } from '../path/src/config.js';
import { bounds } from '../path/src/arena.js';
import {
  boats, resetBoats, updateBoats, boatGunTier, armBoat,
} from '../path/src/systems/boats.js';
import { projectiles, resetProjectiles, updateProjectiles } from '../path/src/entities/projectiles.js';
import { player } from '../path/src/entities/player.js';
import { causesOfDeath, primaryCause } from '../path/src/deathCauses.js';

let fails = 0;
const check = (ok, msg, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
};
const section = (s) => console.log(`\n${s}`);

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
Math.random = seeded(0xB0A75);

const scene = new THREE.Scene();
const DT = 1 / 60;
const g = CONFIG.boats.guns;

section('tier by difficulty');
check(boatGunTier(0)?.id === 'fish', 'a fresh run throws small fish', boatGunTier(0)?.id);
check(boatGunTier(g.tiers[1].minDifficulty)?.id === 'trout', 'the trout tier opens on its own threshold');
check(boatGunTier(g.tiers[2].minDifficulty + 5)?.id === 'sailfish', 'deep in the run it is sailfish');
check(boatGunTier(g.tiers[1].minDifficulty - 0.01)?.id === 'fish', 'a hair under the trout threshold is still fish');
{
  const was = g.enabled;
  g.enabled = false;
  check(boatGunTier(50) === null, 'guns off means no tier at all');
  g.enabled = was;
}

section('arming');
{
  const d = 20;
  const gun = armBoat(false, d);
  const expect = g.tiers[2].damage * difficultyRamp('damage', d) * enemyPaceMul('damage');
  check(Math.abs(gun.shot.damage - expect) < 1e-9, 'damage is priced on the enemy damage ramp at spawn',
    `${gun.shot.damage.toFixed(2)} vs ${expect.toFixed(2)}`);
  check(gun.artillery === null, 'an ordinary boat never carries artillery');
  const chance = g.artillery.chance;
  g.artillery.chance = 1;
  check(armBoat(true, d).artillery !== null, 'a trawler past the threshold does, on the roll');
  check(armBoat(true, g.artillery.minDifficulty - 1).artillery === null, '...but not before the threshold');
  g.artillery.chance = 0;
  check(armBoat(true, d).artillery === null, '...and not when the roll fails');
  g.artillery.chance = chance;
  const t = armBoat(true, 0);
  const b = armBoat(false, 0);
  check(t.rate < b.rate, 'a trawler reloads faster than a boat', `${t.rate} vs ${b.rate}`);
}

// Spawn one boat through the real path and return it.
function spawnOne(difficulty, { trawler = false, artillery = false } = {}) {
  resetProjectiles(scene);
  resetBoats(scene);
  const keep = {
    spawnMin: CONFIG.boats.spawnMin, spawnMax: CONFIG.boats.spawnMax,
    trawlerChance: CONFIG.boats.trawlerChance, aaChance: g.artillery.chance,
  };
  CONFIG.boats.spawnMin = CONFIG.boats.spawnMax = 0.01;
  CONFIG.boats.trawlerChance = trawler ? 1 : 0;
  g.artillery.chance = artillery ? 1 : 0;
  resetBoats(scene);
  updateBoats(0.05, scene, difficulty, { x: 0, y: -5 }, {});
  CONFIG.boats.spawnMin = keep.spawnMin;
  CONFIG.boats.spawnMax = keep.spawnMax;
  CONFIG.boats.trawlerChance = keep.trawlerChance;
  g.artillery.chance = keep.aaChance;
  CONFIG.boats.spawnMin = CONFIG.boats.spawnMax = 999; // no second hull mid-test
  return boats[0];
}

// Run `seconds` with the seal parked at `pos`, returning the boat shots seen by source.
function run(seconds, pos, difficulty = 0) {
  const seen = new Map();
  let first = null;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const before = projectiles.length;
    updateBoats(DT, scene, difficulty, pos, {});
    for (let k = before; k < projectiles.length; k++) {
      const p = projectiles[k];
      if (!p.source?.startsWith('boat:')) continue;
      seen.set(p.source, (seen.get(p.source) ?? 0) + 1);
      if (!first) first = { p, at: i * DT };
    }
    updateProjectiles(DT, scene, [], () => {}, () => {}, () => {});
  }
  return { seen, first };
}

section('the fish gun');
{
  const b = spawnOne(0);
  check(!!b && b.gun?.tier === 'fish', 'a difficulty-0 boat spawned with the fish tier', b?.gun?.tier);
  const under = { x: b.mesh.position.x + 6, y: -6 };
  const { seen, first } = run(12, under);
  check((seen.get('boat:fish') ?? 0) > 0, 'it throws fish at a seal under the water', `${seen.get('boat:fish') ?? 0} in 12s`);
  const p = first?.p;
  check(p?.faction === 'enemy', 'the fish is an enemy shot', p?.faction);
  check(p?.asset === 'enemyFish', '...wearing the fish model', p?.asset);
  check(!!p && p.dir.y < 0, '...thrown DOWN into the water', p ? p.dir.y.toFixed(2) : '');
  check(!!p && !p.homing, '...and it does not home', String(p?.homing));
  check(first.at >= g.openingDelay, 'the first shot waits for the opening delay', `${first.at.toFixed(2)}s`);
  check(![...seen.keys()].some((k) => k !== 'boat:fish'), 'nothing but fish from a plain boat', [...seen.keys()].join(', '));
}
{
  const b = spawnOne(0);
  const air = { x: b.mesh.position.x + 6, y: bounds.surfaceY + 3 };
  const { seen } = run(12, air);
  check(seen.size === 0, 'a plain boat holds fire at a seal in the air', [...seen.keys()].join(', '));
  const far = { x: b.mesh.position.x + g.range + 20, y: -6 };
  const out = run(12, far);
  check(out.seen.size === 0, '...and at a seal out of range', [...out.seen.keys()].join(', '));
}

section('later tiers');
{
  const d = g.tiers[2].minDifficulty + 2;
  const b = spawnOne(d);
  check(b.gun.tier === 'sailfish', 'a deep-run boat carries the sailfish', b.gun.tier);
  const { seen, first } = run(12, { x: b.mesh.position.x - 5, y: -7 }, d);
  check((seen.get('boat:sailfish') ?? 0) > 0, 'it throws sailfish', [...seen.keys()].join(', '));
  check(first?.p.asset === 'enemySailfish', '...wearing the sailfish model', first?.p.asset);
}

section('the artillery trawler');
{
  const d = g.artillery.minDifficulty + 2;
  const b = spawnOne(d, { trawler: true, artillery: true });
  check(b.isTrawler && b.isArtillery, 'a qualifying trawler spawned with artillery', `${b.isTrawler}/${b.isArtillery}`);
  const plain = spawnOne(d, { trawler: true, artillery: false });
  const armed = spawnOne(d, { trawler: true, artillery: true });
  check(armed.spawnScale > plain.spawnScale * 1.05, 'it is the bigger hull',
    `${armed.spawnScale.toFixed(2)} vs a plain trawler's ${plain.spawnScale.toFixed(2)}`);
  const air = { x: armed.mesh.position.x + 5, y: bounds.surfaceY + 4 };
  const { seen, first } = run(14, air, d);
  check((seen.get('boat:mussel') ?? 0) > 0, 'it fires mussels at a seal in the air', `${seen.get('boat:mussel') ?? 0}`);
  check((seen.get('boat:gull') ?? 0) > 0, '...and a gull', `${seen.get('boat:gull') ?? 0}`);
  check(!seen.has('boat:trout') && !seen.has('boat:sailfish') && !seen.has('boat:fish'),
    '...and no fish while the seal is up there', [...seen.keys()].join(', '));
  const p = first?.p;
  check(p?.homing === true && p?.chase === player, 'the mussel homes on the seal', `${p?.homing} chase=${p?.chase === player}`);
  check(p?.asset === 'missile', '...wearing the mussel', p?.asset);
  check(p?.turnRate === g.artillery.mussel.turnRate, '...on the row\'s turn rate', String(p?.turnRate));
  check(seen.get('boat:mussel') % g.artillery.mussel.count === 0, 'mussels come in the row\'s volleys', `${seen.get('boat:mussel')} / ${g.artillery.mussel.count}`);

  const under = run(14, { x: armed.mesh.position.x + 5, y: -6 }, d);
  const fishKey = `boat:${armed.gun.tier}`;
  check((under.seen.get(fishKey) ?? 0) > 0, 'underwater it throws its tier\'s fish like any boat', `${fishKey}: ${under.seen.get(fishKey) ?? 0}`);
  check(!under.seen.has('boat:mussel') && !under.seen.has('boat:gull'), '...and no anti-air', [...under.seen.keys()].join(', '));
}
{
  // A windup begun at an airborne seal is abandoned when it dives.
  const d = g.artillery.minDifficulty + 2;
  const b = spawnOne(d, { trawler: true, artillery: true });
  b.gun.aaTimer = 0;
  b.gun.timer = 999;
  const air = { x: b.mesh.position.x + 5, y: bounds.surfaceY + 4 };
  updateBoats(DT, scene, d, air, {});
  check(b.gun.stage === 'windup' && b.gun.pending !== 'fish', 'anti-air winds up on an airborne seal', `${b.gun.stage}/${b.gun.pending}`);
  const before = projectiles.length;
  for (let i = 0; i < 120; i++) updateBoats(DT, scene, d, { x: air.x, y: -6 }, {});
  check(projectiles.length === before && b.gun.stage === 'ready', '...and lets it go when the seal dives first', `${projectiles.length - before} shots`);
}

section('death credit');
check(causesOfDeath('boat:fish').has('shot') && !causesOfDeath('boat:fish').has('boat'),
  'a thrown fish files under enemy fire, not under the boss hulls');
check(primaryCause('boat:gull')?.id === 'shot', 'so does the gull', primaryCause('boat:gull')?.id);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
