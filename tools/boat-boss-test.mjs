#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:boat
//
// THE BOAT BOSS — the one boss that never enters the water.
//
// Everything here is a thing that fails silently. A hull that sinks still
// fights; a pattern that never fires still looks like a boss holding station;
// a barrel wall with no gap in it is indistinguishable from a hard fight until
// you notice nobody can survive it. None of it throws, and none of it is
// visible in a screenshot of one frame.
//
// No renderer, on purpose — the browser preview suspends requestAnimationFrame,
// so a screenshot proves nothing about a pattern cycle. Every number below
// comes from ticking the same functions main.js ticks.
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enemies, resetEnemies, removeEnemy, updateEnemies } from '../path/src/entities/enemies.js';
import { projectiles, resetProjectiles, updateProjectiles } from '../path/src/entities/projectiles.js';
import { updateBoss, updateBossAbilities, resetBoss, bossState, forceBoss } from '../path/src/systems/boss.js';
import { boatState } from '../path/src/systems/bossBoat.js';
import { bounds } from '../path/src/arena.js';

// SEEDED, because most of what is checked below is a dice roll dressed as a
// bombardment: which pattern comes up, where in the arena a barrel wall leaves
// its gap, and whether any of it happens to land on a player who is standing
// still. The last of those is a knife edge — one or two hits over twenty-four
// seconds — so an unseeded run genuinely does come back with zero every so
// often, and a check that fails one run in twenty is worse than no check at
// all in a suite this file is one `&&` of. Fixed seed, same dice every time;
// change it only with the result in front of you.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
Math.random = seeded(0xB0A7);

const scene = new THREE.Scene();
const DT = 1/60;
let fail = 0;
const check = (n, ok, d='') => { console.log(`  ${ok?'ok  ':'FAIL'} ${n}${d?` — ${d}`:''}`); if(!ok) fail++; };

resetEnemies(scene); resetProjectiles(scene); resetBoss(scene);
const gs = { difficulty: 20, level: 20, running: true };
const boss = forceBoss(scene, gs, { boss: 'bossBoat', perk: 'lunge' });
check('the boat spawns', !!boss, boss?.type);
check('...and the boat system picked it up', boatState.boat === boss);
check('...and it rolled a perk on top', bossState.perk?.id === 'lunge', bossState.perk?.id);

// Through the entrance — BOTH beats of it. The boat is placed past the edge of
// the picture like every other spawn and sails in behind the rock face (see THE
// ENTRANCE in entities/enemies.js), and the ceremony only starts once it is
// clear of the wall. Nothing moves creatures but updateEnemies, so a loop that
// ticks updateBoss alone sits out the approach entirely and then measures a
// bombardment that spends its first four seconds arriving.
const pp = { x: 10, y: bounds.bottom + 8, z: 0 };
let n = 0;
while ((bossState.approaching || bossState.arriving) && n++ < 2000) {
  updateEnemies(DT, scene, pp, () => {}, () => {});
  updateBoss(DT, gs, scene);
}
check('...and it sailed in and finished its entrance',
  !bossState.approaching && !bossState.arriving, `${(n * DT).toFixed(2)}s`);
let hits = 0;
const hooks = { onPlayerHit: () => { hits++; } };

let minY = 1e9, maxY = -1e9, sawRain = false, sawSalvo = false, sawSpread = false;
const sources = new Set();
for (let i = 0; i < 60 * 24; i++) {
  updateBoss(DT, gs, scene);
  updateBossAbilities(DT, scene, pp, hooks);
  updateEnemies(DT, scene, pp, () => {}, () => {});
  // The shells have to actually FLY. Without this the barrels hang where they
  // were thrown, never leave the projectile list, and every fuse in the water
  // waits forever — which reads exactly like a boss that fires blanks.
  updateProjectiles(DT, scene, enemies, () => {}, () => {}, () => {});
  minY = Math.min(minY, boss.mesh.position.y);
  maxY = Math.max(maxY, boss.mesh.position.y);
  if (boatState.pattern === 'rain') sawRain = true;
  if (boatState.pattern === 'salvo') sawSalvo = true;
  if (boatState.pattern === 'spread') sawSpread = true;
  for (const p of projectiles) if (p.source?.startsWith('boss:boat')) sources.add(p.source);
}
check('the hull never leaves the waterline', Math.abs(minY - bounds.surfaceY) < 1 && Math.abs(maxY - bounds.surfaceY) < 1,
  `y ${minY.toFixed(2)}..${maxY.toFixed(2)} vs surface ${bounds.surfaceY.toFixed(2)}`);
check('...and it stayed inside the arena', boss.mesh.position.x > bounds.left && boss.mesh.position.x < bounds.right,
  `x ${boss.mesh.position.x.toFixed(1)} in ${bounds.left.toFixed(0)}..${bounds.right.toFixed(0)}`);
check('all three patterns ran', sawRain && sawSalvo && sawSpread,
  [sawRain&&'rain', sawSalvo&&'salvo', sawSpread&&'spread'].filter(Boolean).join(', '));
check('...and each one actually fired', sources.size === 3, [...sources].join(', '));
check('the ordnance reached the player', hits > 0, `${hits} hits taken`);

// the gap is real: a wall must always leave a way through
let gapless = 0;
for (let t = 0; t < 40; t++) {
  const span = bounds.right - bounds.left;
  const cols = CONFIG.bossBoat.patterns.rain.columns;
  const half = CONFIG.bossBoat.patterns.rain.gapWidth / 2;
  const gapX = bounds.left + span * (0.15 + Math.random() * 0.7);
  let skipped = 0;
  for (let i = 0; i < cols; i++) {
    const x = bounds.left + (span / cols) * (i + 0.5);
    if (Math.abs(x - gapX) < half) skipped++;
  }
  if (skipped === 0) gapless++;
}
check('every barrel wall has a hole in it', gapless === 0, `${gapless} of 40 walls were solid`);

// homing chases the seal, not the fish
const seeker = projectiles.find((p) => p.source === 'boss:boatSalvo');
check('the seekers chase the seal, never the roster', !seeker || (seeker.homing && !!seeker.chase));

removeEnemy(scene, enemies.indexOf(boss));
updateBoss(DT, gs, scene);
check('killing it lets the boat system go', boatState.boat === null);
console.log(fail ? `\n${fail} FAILED` : '\nPASS');
process.exit(fail ? 1 : 0);
