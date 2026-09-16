#!/usr/bin/env node
// THE DECK GUNS — boats and trawlers shoot fish at a seal under the water,
// and an artillery trawler shoots homing mussels and a gull at a seal above it.
// See CONFIG.boats.guns and systems/boats.js (armBoat / updateBoatGun).

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG, difficultyRamp, enemyPaceMul } from '../path/src/config.js';
import { bounds } from '../path/src/arena.js';
import {
  boats, resetBoats, updateBoats, boatGunTier, armBoat, gunRamp, shotCeiling,
} from '../path/src/systems/boats.js';
import { projectiles, resetProjectiles, updateProjectiles } from '../path/src/entities/projectiles.js';
import { stepBodies } from '../path/src/systems/rigidBody.js';
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
// Captured before anything in this file touches them — spawnOne pins the window
// at 999s and does not put it back. See the DPS section.
const SPAWN_MIN = CONFIG.boats.spawnMin;
const SPAWN_MAX = CONFIG.boats.spawnMax;

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

// THE ROWS IN behaviour.csv ARE POSITIONAL, because `tiers` is an array and a
// path table is keyed by a dotted path — `boats.guns.tiers.1.damage` is the
// trout because the trout is second, and nothing in the spreadsheet says so.
// Reorder the array and every row silently retunes a different gun, which is a
// change that would look like no change at all. This is the check that makes
// the CSV's notes true.
section('the tier order the CSV rows are written against');
{
  const want = ['fish', 'trout', 'sailfish'];
  want.forEach((id, i) => {
    check(g.tiers[i]?.id === id, `tiers[${i}] is still the ${id} tier`,
      `${g.tiers[i]?.id} — behaviour.csv's boats.guns.tiers.${i}.* rows tune whatever is here`);
  });
  check(g.tiers.length === want.length, 'and there are no tiers the CSV has never heard of',
    `${g.tiers.length} tiers, ${want.length} named`);
}

section('arming');
{
  const d = 20;
  const gun = armBoat(false, d);
  const expect = Math.min(shotCeiling(), g.tiers[2].damage * gunRamp(d) * enemyPaceMul('damage'));
  check(Math.abs(gun.shot.damage - expect) < 1e-9, 'damage is priced on the deck guns\' share of the ramp at spawn',
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

// ---------------------------------------------------------------------------
// THE TWO THINGS THAT KEEP A DECK GUN FROM DELETING YOU
// ---------------------------------------------------------------------------
// Both are new, and both exist because the guns were measured throwing three to
// six times the incoming damage per second of anything else in the water, with
// a single late-run sailfish worth more than the seal's whole starting bar.
section('the ramp share');
{
  check(Math.abs(gunRamp(0) - 1) < 1e-9, 'difficulty 0 pays exactly the tier row', String(gunRamp(0)));
  const share = CONFIG.boats.guns.damageRampShare;
  for (const d of [5, 15, 30, 45]) {
    const full = difficultyRamp('damage', d);
    const mine = gunRamp(d);
    check(mine > 1 && mine < full, `a deck gun at difficulty ${d} still ramps, but under the roster's`,
      `${mine.toFixed(2)} vs ${full.toFixed(2)}`);
    check(Math.abs(mine - (1 + (full - 1) * share)) < 1e-9,
      '...by exactly the share the CSV names', `${share}`);
  }
  // The share is taken of the EXCESS over 1, not of the ramp. Multiplying the
  // whole ramp would price a difficulty-0 boat at 42% of its own tier row and
  // make every number in that table a lie.
  check(gunRamp(0) === 1, 'the share cannot move a difficulty-0 shot');
}

section('the per-shot ceiling');
{
  const cap = shotCeiling();
  check(Math.abs(cap - CONFIG.player.maxHp * CONFIG.boats.guns.maxShotShare) < 1e-9,
    'the ceiling is a share of the seal\'s BASE bar', `${cap.toFixed(1)} of ${CONFIG.player.maxHp}`);
  check(cap < CONFIG.player.maxHp * (CONFIG.player.damageCap?.perSecond ?? 0.9),
    '...and sits well under the rolling damage cap, so a boat alone can never reach it',
    `${cap.toFixed(1)} vs ${(CONFIG.player.maxHp * (CONFIG.player.damageCap?.perSecond ?? 0.9)).toFixed(1)}`);
  // Deep enough in the run that every row has run away from its own number.
  for (const d of [45, 80, 200]) {
    const gun = armBoat(true, d);
    check(gun.shot.damage <= cap + 1e-9, `no fish off a hull at difficulty ${d} passes the ceiling`,
      gun.shot.damage.toFixed(1));
    if (gun.artillery) {
      check((gun.artillery.mussel?.damage ?? 0) <= cap + 1e-9, '...nor a mussel', gun.artillery.mussel?.damage.toFixed(1));
      check((gun.artillery.gull?.damage ?? 0) <= cap + 1e-9, '...nor the gull', gun.artillery.gull?.damage.toFixed(1));
    }
  }
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
  resetBoats(scene); // arms the spawn timer from the 0.01s window above
  // Pushed out BEFORE the spawning frame, not after it: the timer for the NEXT
  // hull is rolled at the moment this one spawns, so setting it afterwards
  // left a 0.01s fuse on a second boat that sailed in on the next frame,
  // rolled against the RESTORED trawler chance. Every shot keyed by source
  // used to hide it — both hulls threw fish — but a shot signed 'trawler' from
  // a test that spawned a plain boat is exactly the thing this file checks.
  CONFIG.boats.spawnMin = CONFIG.boats.spawnMax = 999; // no second hull mid-test
  updateBoats(0.05, scene, difficulty, { x: 0, y: -5 }, {});
  CONFIG.boats.trawlerChance = keep.trawlerChance;
  g.artillery.chance = keep.aaChance;
  if (boats.length !== 1) check(false, 'spawnOne spawned exactly one hull', String(boats.length));
  return boats[0];
}

// Run `seconds` with the seal parked at `pos`, returning the boat shots seen,
// keyed by the ASSET thrown — every shot's `source` is the hull that fired it
// ('boat' / 'trawler', see volley in systems/boats.js), so the ammunition is
// only visible on the model it wears.
function run(seconds, pos, difficulty = 0) {
  const seen = new Map();
  let first = null;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const before = projectiles.length;
    updateBoats(DT, scene, difficulty, pos, {});
    for (let k = before; k < projectiles.length; k++) {
      const p = projectiles[k];
      if (p.faction !== 'enemy') continue;
      seen.set(p.asset, (seen.get(p.asset) ?? 0) + 1);
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
  check((seen.get('enemyFish') ?? 0) > 0, 'it throws fish at a seal under the water', `${seen.get('enemyFish') ?? 0} in 12s`);
  const p = first?.p;
  check(p?.faction === 'enemy', 'the fish is an enemy shot', p?.faction);
  check(p?.source === 'boat', '...signed by the hull that threw it, not the fish', p?.source);
  check(p?.asset === 'enemyFish', '...wearing the fish model', p?.asset);
  check(!!p && p.dir.y < 0, '...thrown DOWN into the water', p ? p.dir.y.toFixed(2) : '');
  check(!!p && !p.homing, '...and it does not home', String(p?.homing));
  check(first.at >= g.openingDelay, 'the first shot waits for the opening delay', `${first.at.toFixed(2)}s`);
  check(![...seen.keys()].some((k) => k !== 'enemyFish'), 'nothing but fish from a plain boat', [...seen.keys()].join(', '));
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
  check((seen.get('enemySailfish') ?? 0) > 0, 'it throws sailfish', [...seen.keys()].join(', '));
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
  check((seen.get('missile') ?? 0) > 0, 'it fires mussels at a seal in the air', `${seen.get('missile') ?? 0}`);
  check((seen.get('seagull') ?? 0) > 0, '...and a gull', `${seen.get('seagull') ?? 0}`);
  check(!seen.has('enemyTrout') && !seen.has('enemySailfish') && !seen.has('enemyFish'),
    '...and no fish while the seal is up there', [...seen.keys()].join(', '));
  const p = first?.p;
  check(p?.homing === true && p?.chase === player, 'the mussel homes on the seal', `${p?.homing} chase=${p?.chase === player}`);
  check(p?.asset === 'missile', '...wearing the mussel', p?.asset);
  check(p?.source === 'trawler', '...signed by the trawler, not the mussel', p?.source);
  check(p?.turnRate === g.artillery.mussel.turnRate, '...on the row\'s turn rate', String(p?.turnRate));
  check(seen.get('missile') % g.artillery.mussel.count === 0, 'mussels come in the row\'s volleys', `${seen.get('missile')} / ${g.artillery.mussel.count}`);

  const under = run(14, { x: armed.mesh.position.x + 5, y: -6 }, d);
  const fishKey = g.tiers.find((t) => t.id === armed.gun.tier).asset;
  check((under.seen.get(fishKey) ?? 0) > 0, 'underwater it throws its tier\'s fish like any boat', `${fishKey}: ${under.seen.get(fishKey) ?? 0}`);
  check(!under.seen.has('missile') && !under.seen.has('seagull'), '...and no anti-air', [...under.seen.keys()].join(', '));
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

// ---------------------------------------------------------------------------
// THE TELL AND THE MARK
// ---------------------------------------------------------------------------
// The lights themselves cannot be asserted here — systems/boatShotFx.js paints
// its falloff into a 2D canvas context and dom-stub has none, so every sprite
// in this file comes back null and the effects are inert. What IS testable
// headless is the bookkeeping around them, and the bookkeeping is where both of
// the real failure modes live: a wind-up whose length the tell measures itself
// against, and the mark combat.js reads to decide whose hit gets a pop.
section('the wind-up the tell is drawn against');
{
  const b = spawnOne(0);
  b.gun.timer = 0;
  const under = { x: b.mesh.position.x + 6, y: -6 };
  updateBoats(DT, scene, 0, under, {});
  check(b.gun.stage === 'windup', 'the fish gun winds up', b.gun.stage);
  check(b.gun.windupFull === g.windup, '...and records the length the tell ramps over',
    `${b.gun.windupFull} vs ${g.windup}`);
}
{
  const d = g.artillery.minDifficulty + 2;
  const b = spawnOne(d, { trawler: true, artillery: true });
  b.gun.aaTimer = 0;
  b.gun.timer = 999;
  updateBoats(DT, scene, d, { x: b.mesh.position.x + 5, y: bounds.surfaceY + 4 }, {});
  // The two batteries have DIFFERENT wind-ups. A tell that measured the
  // anti-air's against the fish gun's would run its blink at the wrong rate for
  // the whole of it — and would read as correct, because both are in seconds.
  check(b.gun.windupFull === g.artillery.windup, 'the anti-air records its own, longer wind-up',
    `${b.gun.windupFull} vs the fish gun's ${g.windup}`);
  check(g.artillery.windup > g.windup, '...and it IS longer — a seal in the air has the least control',
    `${g.artillery.windup} vs ${g.windup}`);
}
{
  const b = spawnOne(0);
  const { first } = run(14, { x: b.mesh.position.x + 6, y: -6 });
  // combat.js fires the impact pop on `boatShot` alone, so an unmarked shot is
  // a deck gun that lands invisibly — which is the whole complaint the pop was
  // added to answer.
  check(first?.p.boatShot === true, 'every shot off a deck is marked for the impact pop',
    String(first?.p.boatShot));
  check(CONFIG.boats.guns.fx?.enabled === true, 'and the lights are on', String(CONFIG.boats.guns.fx?.enabled));
  const tell = CONFIG.boats.guns.fx?.tell ?? {};
  check(tell.blinkTo > tell.blinkFrom, 'the tell ACCELERATES — the rate is the warning, not the brightness',
    `${tell.blinkFrom} -> ${tell.blinkTo} blinks/s`);
  check((tell.minAlpha ?? 0) > 0, '...and never goes fully out between blinks, which would read as two lights',
    String(tell.minAlpha));
}

// ---------------------------------------------------------------------------
// WHAT A RUN ACTUALLY TAKES FROM THE BOATS
// ---------------------------------------------------------------------------
// The arming checks above price ONE shot. This is the number that was the
// complaint: damage thrown per second at a seal that is just there, through the
// real spawn loop, with as many hulls in the water as the run allows and every
// one of them on its own reload.
//
// THE BODIES HAVE TO BE STEPPED or this measures nothing. A boat's position is
// a RigidBody's (see spawnBoat), and updateBoats only writes accelerations into
// it — without stepBodies every hull sits at the edge it spawned on, never
// closes to `range`, and the whole arena fires zero shots while every assertion
// about cadence passes. It is the exact shape of a harness that agrees with
// you: the number comes out 0.00 and 0 is under any ceiling you care to name.
//
// SEEDED AND AVERAGED. Reloads, the trawler roll and the artillery roll are all
// random, so one run is a coin toss — and the fix for a flaky threshold here is
// more seeds, never a lower bar.
section('incoming damage per second');
{
  const SECONDS = 240;
  const SEEDS = [1, 2, 3, 4, 5];
  // THE SPAWN WINDOW BACK. spawnOne above pins it at 999s so a second hull
  // cannot sail in mid-test and never puts it back — which is correct for every
  // check before this one and fatal for this one, because it is the only
  // section that wants the real spawn loop. Without this the arena stays empty,
  // every shot count is 0, and the ceiling below passes on a system that was
  // switched off. See the note at the top of this section.
  CONFIG.boats.spawnMin = SPAWN_MIN;
  CONFIG.boats.spawnMax = SPAWN_MAX;
  const measure = (difficulty) => {
    let total = 0;
    for (const seed of SEEDS) {
      Math.random = seeded(seed * 7919);
      resetProjectiles(scene);
      resetBoats(scene);
      let dmg = 0;
      const pos = { x: 0, y: -6 };
      for (let i = 0; i < Math.round(SECONDS / DT); i++) {
        const before = projectiles.length;
        stepBodies(DT);
        updateBoats(DT, scene, difficulty, pos, {});
        for (let k = before; k < projectiles.length; k++) {
          if (projectiles[k].faction === 'enemy') dmg += projectiles[k].damage;
        }
        updateProjectiles(DT, scene, [], () => {}, () => {}, () => {});
      }
      total += dmg / SECONDS;
    }
    return total / SEEDS.length;
  };

  const hp = CONFIG.player.maxHp;
  const rows = [0, 10, 30, 45].map((d) => [d, measure(d)]);
  for (const [d, dps] of rows) {
    console.log(`  difficulty ${String(d).padStart(2)}: ${dps.toFixed(2)} damage/s thrown `
      + `(${((dps / hp) * 100).toFixed(1)}% of a starting bar per second)`);
  }
  // A CEILING ON THE WHOLE SYSTEM, not on one gun. This is damage THROWN at a
  // stationary seal, so it is the worst case and not what a moving player takes
  // — but it is the number that has to stay bounded, because the counterplay is
  // swimming and the player is already swimming away from something else.
  //
  // A fifteenth of the bar a second is the bar in fifteen seconds with nothing
  // else in the water, which is a real threat and not a death sentence. It was
  // over a THIRD of the bar a second at difficulty 45 before this pass.
  const worst = Math.max(...rows.map(([, dps]) => dps));
  check(worst < hp * 0.067, 'the deck guns stay under a fifteenth of the starting bar per second',
    `worst ${worst.toFixed(2)}/s vs ${(hp * 0.067).toFixed(2)}`);
  // ...AND THEY ARE STILL A THREAT. The failure in the other direction is
  // silent: every ceiling above would also be satisfied by guns that had been
  // turned off, and nothing else in this file would notice.
  check(rows[0][1] > 0.2, 'a boat at minute one is still shooting at you', `${rows[0][1].toFixed(2)}/s`);
  check(rows[3][1] > rows[0][1] * 2, 'and a deep-run boat is meaningfully worse than a fresh one',
    `${rows[0][1].toFixed(2)}/s -> ${rows[3][1].toFixed(2)}/s`);
}

section('death credit');
// A shot is the boat that fired it: the hull's key lands on the boat cause,
// never on the generic 'shot' fallback and never as a boss.
check(primaryCause('boat')?.id === 'boat', 'a shot off a plain boat is a boat death', primaryCause('boat')?.id);
check(primaryCause('trawler')?.id === 'boat', 'a shot off a trawler is a boat death', primaryCause('trawler')?.id);
check(!causesOfDeath('trawler').has('boss') && !causesOfDeath('trawler').has('shot'),
  '...and neither a boss death nor unsigned enemy fire', [...causesOfDeath('trawler')].join(','));
check(primaryCause('enemy shot')?.id === 'shot', 'an unsigned shot still has a cause to land in', primaryCause('enemy shot')?.id);
check(!primaryCause('boat:fish'), 'nothing files the old ammunition keys any more', primaryCause('boat:fish')?.id);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
