import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createVisual } from '../assets.js';
import { bounds } from '../arena.js';
import { removeEnemy } from '../entities/enemies.js';

// Bakalar's Boat — a friendly trawler that sails the surface on a timer,
// dragging a net behind it. Anything the net sweeps through is caught, hauled
// up, and gone when the net reaches the hull.
//
// It's the beluga's trap read from the other direction: the bubble comes to
// the fish and holds it where it is, the net comes down from the sky and takes
// it away. That makes this the one ability in the game that removes enemies
// without dealing a point of damage — the reward is the XP orb the haul drops,
// so a boat sailing through a school is a clear AND a payday, and the tension
// is that you don't choose when it sails.
//
// The net is a rectangle hanging under the boat: `netWidth` across, from the
// surface down to `netDepth`. Enemies inside it are frozen with `trapTimer`
// (topped up every frame, so they can't wriggle free mid-haul) and their
// position is driven directly by this system.

const caught = []; // { enemy, offsetX } — offsetX keeps the catch spread across the net
let boat = null;
let visual = null;
let spawnTimer = 0;
let sailing = false;
let dir = 1;
let clock = 0;
let netMesh = null;

function randomBetween(a, b) {
  return a + Math.random() * Math.max(0, b - a);
}

function buildBoat() {
  const root = new THREE.Group();
  visual = createVisual('bakalarBoat');
  root.add(visual);
  return root;
}

export function createBakalarBoat(scene) {
  boat = buildBoat();
  boat.visible = false;
  scene.add(boat);

  // The net itself is a flat translucent panel rather than modelled mesh — at
  // this camera distance a real net reads as noise, and a soft rectangle reads
  // instantly as "this volume is dangerous", which is the only thing the
  // player needs from it.
  const geo = new THREE.PlaneGeometry(1, 1);
  const mat = new THREE.MeshBasicMaterial({
    color: CONFIG.bakalar.netColor,
    transparent: true,
    opacity: CONFIG.bakalar.netOpacity,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  netMesh = new THREE.Mesh(geo, mat);
  netMesh.position.z = -0.15;
  netMesh.visible = false;
  scene.add(netMesh);

  return boat;
}

// Singleton, same as the beluga drone — a model uploaded from the T panel
// wouldn't appear until a reload without an explicit swap.
export function rebuildBakalarBoat(scene) {
  if (!boat) return;
  const { position, visible } = boat;
  scene.remove(boat);
  boat = buildBoat();
  boat.position.copy(position);
  boat.visible = visible;
  scene.add(boat);
}

export function resetBakalar() {
  // Anything still in the net when a run ends is simply released — the enemy
  // array is about to be cleared by resetEnemies anyway, so removing them here
  // would just be fighting over the same indices.
  caught.length = 0;
  sailing = false;
  clock = 0;
  if (boat) boat.visible = false;
  if (netMesh) netMesh.visible = false;
  spawnTimer = randomBetween(CONFIG.bakalar.spawnMin, CONFIG.bakalar.spawnMax);
}

function netGeometry(level) {
  const c = CONFIG.bakalar;
  return {
    halfWidth: (c.netWidth + c.netWidthPerLevel * (level - 1)) * 0.5,
    depth: c.netDepth + c.netDepthPerLevel * (level - 1),
  };
}

function launch(level) {
  const c = CONFIG.bakalar;
  sailing = true;
  dir = Math.random() < 0.5 ? 1 : -1;
  const { halfWidth } = netGeometry(level);
  // Start far enough out that the whole net is offscreen, so fish don't
  // materialise mid-haul at the arena edge.
  const margin = halfWidth + c.hullRadius + 2;
  boat.position.set(dir > 0 ? bounds.left - margin : bounds.right + margin, bounds.surfaceY, 0);
  // Hull is modelled along +X, same convention as systems/boats.js.
  boat.rotation.y = dir > 0 ? 0 : Math.PI;
  boat.visible = true;
  netMesh.visible = true;
}

// Release everything without collecting it — used when the boat leaves with
// fish still being hauled, so nothing is left frozen forever offscreen.
function releaseAll() {
  for (const c of caught) c.enemy.trapTimer = 0;
  caught.length = 0;
}

// hooks: { onHauled(enemy) } — called just before the enemy is removed, so the
// caller can run its normal kill handling (score, XP orb) on it.
export function updateBakalar(dt, scene, level, enemiesList, hooks = {}) {
  if (!boat) return;

  const active = level > 0 && CONFIG.bakalar.enabled;
  if (!active) {
    if (sailing) { releaseAll(); sailing = false; boat.visible = false; netMesh.visible = false; }
    return;
  }

  const c = CONFIG.bakalar;
  clock += dt;

  if (!sailing) {
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      // More levels = the boat comes around more often. Clamped so a maxed
      // stack still leaves gaps you have to fight through on your own.
      const interval = Math.max(c.spawnMinFloor, c.spawnMin - c.spawnFasterPerLevel * (level - 1));
      spawnTimer = randomBetween(interval, Math.max(interval, c.spawnMax - c.spawnFasterPerLevel * (level - 1)));
      launch(level);
    }
    return;
  }

  const { halfWidth, depth } = netGeometry(level);

  boat.position.x += dir * c.speed * dt;
  boat.position.y = bounds.surfaceY + Math.sin(clock * c.bobSpeed) * c.bobAmount;
  boat.rotation.z = Math.sin(clock * c.bobSpeed * 0.7) * 0.06;

  // The net hangs straight down from the hull, trailing slightly behind it so
  // it looks dragged rather than carried.
  const netCenterX = boat.position.x - dir * c.netTrail;
  const netTop = boat.position.y;
  const netBottom = netTop - depth;
  netMesh.position.set(netCenterX, (netTop + netBottom) * 0.5, -0.15);
  netMesh.scale.set(halfWidth * 2, depth, 1);
  netMesh.material.color.set(c.netColor);
  netMesh.material.opacity = c.netOpacity;

  // --- catch: anything inside the net volume that isn't already held --------
  for (const e of enemiesList) {
    if (caught.some((h) => h.enemy === e)) continue;
    const ex = e.mesh.position.x;
    const ey = e.mesh.position.y;
    if (Math.abs(ex - netCenterX) > halfWidth + e.radius) continue;
    if (ey > netTop + e.radius || ey < netBottom - e.radius) continue;
    caught.push({ enemy: e, offsetX: ex - netCenterX });
  }

  // --- haul: drag every catch up toward the hull ----------------------------
  for (let i = caught.length - 1; i >= 0; i--) {
    const h = caught[i];
    const e = h.enemy;

    // The enemy may have been killed by something else mid-haul; enemiesList is
    // the authority on what still exists.
    if (!enemiesList.includes(e)) {
      caught.splice(i, 1);
      continue;
    }

    // Topped up rather than set once: enemies.js decrements it every frame, so
    // a long haul would otherwise let the fish start swimming again halfway up.
    e.trapTimer = Math.max(e.trapTimer, 0.5);
    // Ride along with the boat and climb toward it. Position is written
    // directly because enemies.js has already zeroed this creature's velocity
    // and integrated for the frame — this must run after updateEnemies.
    e.mesh.position.x = netCenterX + h.offsetX;
    e.mesh.position.y = Math.min(netTop, e.mesh.position.y + c.haulSpeed * dt);

    // Reached the hull: hauled out of the water and gone.
    if (e.mesh.position.y >= netTop - c.haulCatchGap) {
      const index = enemiesList.indexOf(e);
      if (index >= 0) {
        hooks.onHauled?.(e);
        removeEnemy(scene, index);
      }
      caught.splice(i, 1);
    }
  }

  // --- sailed off the far side ---------------------------------------------
  const margin = halfWidth + c.hullRadius + 3;
  if (boat.position.x < bounds.left - margin || boat.position.x > bounds.right + margin) {
    releaseAll();
    sailing = false;
    boat.visible = false;
    netMesh.visible = false;
    spawnTimer = randomBetween(c.spawnMin, c.spawnMax);
  }
}
