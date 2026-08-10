import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';
import { countFloorPickups, bestChumTarget } from '../entities/pickups.js';
import { enemies, spawnNamed } from '../entities/enemies.js';

let timer = 0;
// The death pile-on: how many crabs are still owed, and when the next one is
// due. Both wall off from the ordinary pile check above — see summonDeathPile.
let pileLeft = 0;
let pileTimer = 0;
let pileGap = 0;

export function resetCrabSpawner() {
  timer = CONFIG.crabSpawn.checkInterval;
  pileLeft = 0;
  pileTimer = 0;
}

// Crabs walk on from off the side of the arena rather than appearing in the
// middle of the seabed. Which side is decided by where the chum actually is —
// they come from whichever edge is further from the pile, so the arrival is a
// visible scuttle across the floor instead of a pop-in next to the food.
function edgeFloorPoint() {
  const margin = CONFIG.crabSpawn.spawnMargin ?? 3;
  const pile = bestChumTarget(0, bounds.bottom, Infinity, CONFIG.crabSpawn.clusterRadius ?? 6);
  const pileX = pile ? pile.mesh.position.x : 0;
  const mid = (bounds.left + bounds.right) * 0.5;
  // Further edge, with a little randomness so a wave doesn't file in from one
  // side in a perfectly straight line.
  const fromLeft = pileX > mid ? Math.random() < 0.85 : Math.random() < 0.15;
  return {
    x: fromLeft ? bounds.left - margin : bounds.right + margin,
    y: bounds.bottom + CONFIG.crabSpawn.floorHeight * 0.5,
  };
}

// The same walk-on, but aimed at a point instead of at the chum: the crabs
// come from whichever edge is NEARER, because the pile-on has only the length
// of a death dive to form and a crab starting from the far wing never arrives.
function edgePointNear(x) {
  const margin = CONFIG.crabSpawn.spawnMargin ?? 3;
  const mid = (bounds.left + bounds.right) * 0.5;
  const fromLeft = x < mid ? Math.random() < 0.85 : Math.random() < 0.15;
  return {
    x: fromLeft ? bounds.left - margin : bounds.right + margin,
    y: bounds.bottom + CONFIG.crabSpawn.floorHeight * 0.5,
  };
}

// THE PILE-ON — armed the moment the seal dies, drained by updateDeathPile.
//
// Only queues the wave; nothing spawns on this call. A dozen crabs appearing
// on the frame of death reads as a spawn, whereas a straggling line walking in
// over the next second and a half reads as the seabed noticing.
export function summonDeathPile() {
  const cfg = CONFIG.crabSpawn.deathPile;
  if (!cfg?.enabled) return;
  const already = enemies.filter((e) => e.type === 'walkingCrab').length;
  pileLeft = Math.max(0, Math.min(cfg.count ?? 0, (cfg.maxCrabs ?? 20) - already));
  // Spread across the window, with the first one immediately.
  pileGap = (cfg.spawnWindow ?? 1.5) / Math.max(1, pileLeft);
  pileTimer = 0;
}

// Drained from main.js's death branch, on the same dilated clock as everything
// else in the descent, so the arrivals slow down with the rest of the scene
// rather than marching in at full speed under a slow-motion corpse.
//
// Bypasses the normal caps on purpose: `maxConcurrent` and the pile-threshold
// maths exist to keep a FIGHT readable, and there is no fight left. It still
// respects CONFIG.spawn.maxAlive, which is a memory ceiling, not a design one.
export function updateDeathPile(dt, scene, difficulty, at) {
  if (pileLeft <= 0) return;
  pileTimer -= dt;
  if (pileTimer > 0) return;
  pileTimer = pileGap;
  pileLeft--;
  if (enemies.length >= CONFIG.spawn.maxAlive) return;
  spawnNamed(scene, 'walkingCrab', difficulty, edgePointNear(at?.x ?? 0), { ignoreCaps: true });
}

// Checked on its own timer (not every frame — counting the pickup pile is
// cheap but there's no reason to do it 60 times a second).
export function updateCrabSpawner(dt, scene, difficulty) {
  if (!CONFIG.crabSpawn.enabled) return;
  timer -= dt;
  if (timer > 0) return;
  timer = CONFIG.crabSpawn.checkInterval;

  const floorCount = countFloorPickups();
  if (floorCount < CONFIG.crabSpawn.pileThreshold) return;

  const over = floorCount - CONFIG.crabSpawn.pileThreshold;
  const desired = Math.min(CONFIG.crabSpawn.maxCrabsPerWave, 1 + Math.floor(over / CONFIG.crabSpawn.orbsPerCrab));

  const maxConcurrent = CONFIG.enemies.walkingCrab.maxConcurrent ?? Infinity;
  const currentCrabs = enemies.filter((e) => e.type === 'walkingCrab').length;
  const n = Math.min(desired, maxConcurrent - currentCrabs, CONFIG.spawn.maxAlive - enemies.length);
  if (n <= 0) return;

  // spawnNamed also enforces both caps itself now, so this loop can't
  // overshoot even if `n`'s estimate above is stale by the time it runs.
  for (let i = 0; i < n; i++) {
    spawnNamed(scene, 'walkingCrab', difficulty, edgeFloorPoint());
  }
}
