import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createVisual } from '../assets.js';
import { bounds } from '../arena.js';
import { updateTumble } from '../systems/rocks.js';

export const pickups = [];
export const strikeOrbs = [];
export const bubbleOrbs = [];
export const rapidFireOrbs = [];

export function resetPickups(scene) {
  for (const p of pickups) scene.remove(p.mesh);
  pickups.length = 0;
  for (const o of strikeOrbs) scene.remove(o.mesh);
  strikeOrbs.length = 0;
  for (const o of bubbleOrbs) scene.remove(o.mesh);
  bubbleOrbs.length = 0;
  for (const o of rapidFireOrbs) scene.remove(o.mesh);
  rapidFireOrbs.length = 0;
}

function tierFor(radius) {
  for (const t of CONFIG.pickups.tiers) if (radius <= t.maxRadius) return t;
  return CONFIG.pickups.tiers[CONFIG.pickups.tiers.length - 1];
}

// `sourceRadius` is the dropping enemy's def.radius — small fish drop small,
// dim orbs worth less xp/heal; a shark or squid drops a big bright one.
export function spawnXpOrb(scene, pos, value, sourceRadius = 0.5) {
  const tier = tierFor(sourceRadius);
  const mesh = createVisual('xpOrb');
  mesh.position.copy(pos);
  mesh.scale.setScalar(tier.scale);
  // Materials are shared across every instance of an asset (see assets.js),
  // so writing tier colour here writes it GLOBALLY — which would stomp any
  // tint set in the texture panel a frame later. Only apply the tier colour
  // when the player hasn't picked their own.
  const userTint = CONFIG.assetLooks?.xpOrb?.tint;
  if (mesh.material?.color && userTint == null) mesh.material.color.set(tier.color);
  scene.add(mesh);
  pickups.push({ mesh, value: value * tier.xpMul, healMul: tier.healMul });

  // Orbs settle on the seabed and would otherwise pile up all run.
  while (pickups.length > CONFIG.pickups.maxAlive) {
    const oldest = pickups.shift();
    scene.remove(oldest.mesh);
  }
}

export function spawnStrikeOrb(scene, pos) {
  const mesh = createVisual('strikeOrb');
  mesh.position.copy(pos);
  scene.add(mesh);
  strikeOrbs.push({ mesh, life: CONFIG.strike.orbLifetime });
}

export function spawnBubbleOrb(scene, pos) {
  const mesh = createVisual('bubbleOrb');
  mesh.position.copy(pos);
  scene.add(mesh);
  bubbleOrbs.push({ mesh, life: CONFIG.oxygen.bubbleLifetime });
}

export function spawnRapidFireOrb(scene, pos) {
  const mesh = createVisual('rapidFireOrb');
  mesh.position.copy(pos);
  scene.add(mesh);
  rapidFireOrbs.push({ mesh, life: CONFIG.rapidFirePickup.lifetime });
}

// Shared float/magnet/lifespan/collect logic for the simple orb types below
// (xp orbs are handled separately above since they also sink and tier).
// `driftSpeed` is world units/sec, positive = rises (bubbles), 0 = stationary
// until magnetised (strike/rapid-fire orbs). Returns 'collected', 'expired',
// or null so the caller knows whether to splice the array.
function updateFloatingOrb(dt, player, orb, driftSpeed, onCollect) {
  orb.life -= dt;
  updateTumble(orb.mesh, dt);

  if (driftSpeed) {
    orb.mesh.position.y += driftSpeed * dt;
    const ceiling = bounds.surfaceY - 0.3;
    if (orb.mesh.position.y > ceiling) orb.mesh.position.y = ceiling;
  }

  const dx = player.mesh.position.x - orb.mesh.position.x;
  const dy = player.mesh.position.y - orb.mesh.position.y;
  const dist = Math.hypot(dx, dy) || 0.0001;

  if (dist < player.stats.pickupRadius) {
    orb.mesh.position.x += (dx / dist) * CONFIG.pickups.magnetSpeed * dt;
    orb.mesh.position.y += (dy / dist) * CONFIG.pickups.magnetSpeed * dt;
  }

  if (dist < CONFIG.pickups.collectRadius) {
    onCollect(orb.mesh.position.x, orb.mesh.position.y);
    return 'collected';
  }
  if (orb.life <= 0) return 'expired';
  return null;
}

function updateOrbArray(dt, scene, player, arr, driftSpeed, onCollect) {
  for (let i = arr.length - 1; i >= 0; i--) {
    const result = updateFloatingOrb(dt, player, arr[i], driftSpeed, onCollect);
    if (result) {
      scene.remove(arr[i].mesh);
      arr.splice(i, 1);
    }
  }
}

// onCollect(xpValue, x, y, healMul) — main.js applies both xp and heal from
// one callback so the two always travel together.
export function updatePickups(dt, scene, player, onCollect, onStrikeOrb, onBubbleOrb, onRapidFireOrb) {
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    // Chum keeps turning after it settles — a still pile on the seabed is the
    // easiest thing on screen to stop noticing.
    updateTumble(p.mesh, dt);
    const dx = player.mesh.position.x - p.mesh.position.x;
    const dy = player.mesh.position.y - p.mesh.position.y;
    const dist = Math.hypot(dx, dy) || 0.0001;

    if (dist < player.stats.pickupRadius) {
      p.mesh.position.x += (dx / dist) * CONFIG.pickups.magnetSpeed * dt;
      p.mesh.position.y += (dy / dist) * CONFIG.pickups.magnetSpeed * dt;
    } else {
      // Out of range, orbs sink through the water and settle on the seabed.
      p.mesh.position.y -= CONFIG.pickups.sinkSpeed * dt;
      const floor = bounds.bottom + 0.8;
      if (p.mesh.position.y < floor) p.mesh.position.y = floor;
    }

    if (dist < CONFIG.pickups.collectRadius) {
      onCollect(p.value, p.mesh.position.x, p.mesh.position.y, p.healMul);
      scene.remove(p.mesh);
      pickups.splice(i, 1);
    }
  }

  if (onStrikeOrb) updateOrbArray(dt, scene, player, strikeOrbs, 0, onStrikeOrb);
  if (onBubbleOrb) updateOrbArray(dt, scene, player, bubbleOrbs, CONFIG.oxygen.bubbleRiseSpeed, onBubbleOrb);
  if (onRapidFireOrb) updateOrbArray(dt, scene, player, rapidFireOrbs, 0, onRapidFireOrb);
}

// How many xp orbs are currently settled on the seabed — the crab-spawn
// system's trigger signal.
export function countFloorPickups() {
  const floorY = bounds.bottom + CONFIG.crabSpawn.floorHeight;
  let n = 0;
  for (const p of pickups) if (p.mesh.position.y <= floorY) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Crab feeding — crabs walk to settled orbs and eat through them, so an
// uncollected pile is a resource actively draining rather than one sitting
// there safely. Kept here rather than in enemies.js because the `pickups`
// array is this module's to mutate; enemies.js only ever asks.
// ---------------------------------------------------------------------------

// Nearest settled orb to (x, y) within maxDist, or null. Only orbs already on
// the seabed are eligible — a crab shouldn't swim up for one still sinking,
// and one being magnetised toward the player is the player's to claim.
export function nearestFloorPickup(x, y, maxDist) {
  const floorY = bounds.bottom + CONFIG.crabSpawn.floorHeight;
  let best = null;
  let bestD2 = maxDist * maxDist;
  for (const p of pickups) {
    if (p.mesh.position.y > floorY) continue;
    const dx = p.mesh.position.x - x;
    const dy = p.mesh.position.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = p; }
  }
  return best;
}

// --- pile scoring ----------------------------------------------------------
//
// Crabs head for the BIGGEST pile, not merely the closest orb, so a fat heap
// across the arena pulls harder than one stray orb underfoot. Scoring every
// orb against every other would be O(orbs^2) per crab per re-target; instead
// the neighbour count is computed once a frame into a coarse grid and every
// crab reads it. Cell size is the cluster radius, so a cell plus its eight
// neighbours covers the search area.
let pileCell = 4;
const pileGrid = new Map();

function cellKey(cx, cy) {
  return cx * 73856093 ^ cy * 19349663;
}

// Rebuild the per-orb pile sizes. Called once per frame from updateEnemies,
// before any crab asks — cheap (one pass to bucket, one to count) and shared.
export function refreshChumPiles(clusterRadius = 6) {
  pileCell = Math.max(1, clusterRadius);
  pileGrid.clear();
  const floorY = bounds.bottom + CONFIG.crabSpawn.floorHeight;
  for (const p of pickups) {
    p.onFloor = p.mesh.position.y <= floorY;
    if (!p.onFloor) continue;
    const cx = Math.floor(p.mesh.position.x / pileCell);
    const cy = Math.floor(p.mesh.position.y / pileCell);
    const k = cellKey(cx, cy);
    let arr = pileGrid.get(k);
    if (!arr) { arr = []; pileGrid.set(k, arr); }
    arr.push(p);
    p.cell = [cx, cy];
  }
  const r2 = clusterRadius * clusterRadius;
  for (const [, arr] of pileGrid) {
    for (const p of arr) {
      let n = 0;
      const [cx, cy] = p.cell;
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const near = pileGrid.get(cellKey(cx + ox, cy + oy));
          if (!near) continue;
          for (const q of near) {
            const dx = q.mesh.position.x - p.mesh.position.x;
            const dy = q.mesh.position.y - p.mesh.position.y;
            if (dx * dx + dy * dy <= r2) n++;
          }
        }
      }
      p.pileSize = n;
    }
  }
}

// The orb a crab at (x, y) should walk to: the one whose pile is biggest,
// discounted by how far it has to travel. `distanceBias` in world units is
// the distance at which a pile's pull halves — small values make crabs
// parochial, large ones make them commit to the big heap across the map.
export function bestChumTarget(x, y, maxDist, distanceBias = 18) {
  let best = null;
  let bestScore = 0;
  const maxD2 = maxDist * maxDist;
  for (const p of pickups) {
    if (!p.onFloor) continue;
    const dx = p.mesh.position.x - x;
    const dy = p.mesh.position.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 > maxD2) continue;
    const score = (p.pileSize ?? 1) / (1 + Math.sqrt(d2) / Math.max(0.01, distanceBias));
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

// Still in play? A crab holds a reference across frames, and the player may
// have collected it (or the maxAlive recycler dropped it) in between.
export function pickupAlive(p) {
  return pickups.indexOf(p) !== -1;
}

// Chew progress, 0..1. The orb shrinks as it goes, so a pile being eaten
// reads at a glance instead of orbs just vanishing. Returns true once it's
// finished and the orb has been removed.
export function bitePickup(scene, p, amount) {
  const i = pickups.indexOf(p);
  if (i === -1) return false;
  p.eaten = (p.eaten ?? 0) + amount;
  if (p.eaten < 1) {
    // Shrink toward a third of its size rather than to nothing — an orb that
    // dwindles to a speck before it pops is hard to see coming.
    const t = 1 - p.eaten * 0.66;
    p.mesh.scale.setScalar((p.baseScale ??= p.mesh.scale.x) * t);
    return false;
  }
  scene.remove(p.mesh);
  pickups.splice(i, 1);
  return true;
}
