import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';
import { countFloorPickups, bestChumTarget } from '../entities/pickups.js';
import { enemies, spawnNamed } from '../entities/enemies.js';

let timer = 0;

export function resetCrabSpawner() {
  timer = CONFIG.crabSpawn.checkInterval;
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
