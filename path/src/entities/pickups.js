import * as THREE from 'three';
import { CONFIG, chumValueRamp } from '../config.js';
import { createVisual } from '../assets.js';
import { bounds } from '../arena.js';
import { updateTumble } from '../systems/rocks.js';
import { createInstancedPool } from '../systems/instancedPool.js';
import { magnetRadius, magnetSpeed, magnetDistance } from '../systems/chumMagnet.js';

// Chum is drawn as instances, not as 140 separate meshes — see
// systems/instancedPool.js. The orb objects themselves are unchanged: the pool
// hands back the same Mesh createVisual built, so every `p.mesh.position` and
// `p.mesh.scale` below reads exactly as it did when it was in the scene.
//
// Built lazily against whichever scene the first orb is spawned into, because
// this module is imported long before world.scene exists.
let orbPool = null;
function pool(scene) {
  if (!orbPool) orbPool = createInstancedPool(scene, 'chum');
  return orbPool;
}

// Once a frame, late — after gulps, bites, magnets and the sink have all had
// their turn at the positions. Nothing is drawn until this runs.
export function flushPickupInstances() {
  orbPool?.flush();
}

export const pickups = [];
// Drives the shiver on chum waiting inside a sealed mouth, and the shimmer on
// chum the seal is closing on. One shared clock rather than a per-orb one: the
// orbs are meant to buzz at a common frequency and are separated by phase, not
// by rate.
let orbClock = 0;
// How far into the run we are, for the early-chum holdback in CONFIG.xp.dropRamp.
// Pushed in once a frame rather than passed per drop: orbs are spawned from four
// places (a kill, an octopus pop, a bakalar bomb, a boat coming apart) and only
// some of them have the run's difficulty to hand.
let runDifficulty = 0;
export function setChumDifficulty(d) { runDifficulty = d; }

// How bright one orb should be at `dist` from the seal, as a multiplier on the
// colour it is already wearing — 1 leaves it exactly as it renders today. See
// CONFIG.pickups.glow for what each knob is for.
//
// `reach` is the player's CURRENT pickup radius, so the halo grows with the
// magnet. `clock` and `phase` drive the shimmer; pass 0 for both to read the
// steady value at a distance, which is what the test does.
//
// Pure, and exported, because the ramp is the whole design here: everything
// that can go wrong with it (a halo that reaches the far wall, a lift that
// arrives too late to turn for, a pulse that dips an orb DARKER than the ones
// around it) is visible in the numbers alone.
export function chumGlowAt(dist, reach, clock = 0, phase = 0) {
  const g = CONFIG.pickups?.glow;
  if (!g?.enabled) return 1;
  const near = g.near ?? 1;
  const far = g.far ?? 1;
  const outer = Math.max(0.01, (reach || 0) * (g.radius ?? 3));
  // 0 at the rim, 1 on top of the orb. Distances past the rim clamp to 0 and
  // cost nothing beyond the multiply.
  const t = Math.max(0, Math.min(1, 1 - dist / outer));
  const ramp = Math.pow(t, Math.max(0.01, g.curve ?? 1));
  let mul = far + (near - far) * ramp;
  const depth = g.pulse?.depth ?? 0;
  if (depth > 0) {
    // Scaled by the ramp as well as added to it: an orb out at the rim is
    // steady, and the shimmer arrives with the brightness rather than being a
    // separate thing that starts somewhere else.
    mul *= 1 + depth * ramp * Math.sin(clock * (g.pulse.hz ?? 1.6) * Math.PI * 2 + phase);
  }
  // Never below zero — a negative multiplier is a black orb, and `depth` is a
  // slider somebody will push.
  return Math.max(0, mul);
}

export const strikeOrbs = [];
export const bubbleOrbs = [];
export const rapidFireOrbs = [];

export function resetPickups(scene) {
  orbPool?.reset();
  pickups.length = 0;
  orbClock = 0;
  runDifficulty = 0;
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
// `vel` is an optional {x, y} throw, for a source that scatters its drop
// rather than placing it (a boat coming apart) — see the toss in updatePickups.
export function spawnXpOrb(scene, pos, value, sourceRadius = 0.5, vel = null) {
  const tier = tierFor(sourceRadius);
  const mesh = createVisual('xpOrb');
  mesh.position.copy(pos);
  mesh.scale.setScalar(tier.scale);
  // Materials are shared across every instance of an asset (see assets.js),
  // so writing tier colour here writes it GLOBALLY — which would stomp any
  // tint set in the texture panel a frame later. Only apply the tier colour
  // when the player hasn't picked their own.
  //
  // Instancing does not change this and deliberately doesn't fix it: the
  // InstancedMesh draws with that same shared material, so this line reaches
  // every orb exactly as it did when each was its own mesh. Per-orb tier
  // colours are now POSSIBLE for the first time — see setColor in
  // systems/instancedPool.js — but they would be a change of look, not of
  // performance, and this pass is the latter.
  const userTint = CONFIG.assetLooks?.xpOrb?.tint;
  if (mesh.material?.color && userTint == null) mesh.material.color.set(tier.color);
  pool(scene).acquire(mesh);
  // Lit from its first frame rather than from its first update. The group takes
  // a DIFFERENT shader program the moment any instance colour exists, so an orb
  // that spawns after updatePickups has already run for the frame would render
  // once through a program the game then compiles again and never uses — a
  // link stall mid-fight, for a frame nobody sees. Starting at the resting
  // value costs one write and means the pool is only ever asked for the one.
  orbPool.setGlow(mesh, CONFIG.pickups.glow?.far ?? 1);
  pickups.push({
    mesh,
    // The holdback scales the xp only — the orb, its size, its heal and its
    // refill of the charge meter are all untouched, so an early run is fed
    // exactly as well as before and just levels slower. See CONFIG.xp.dropRamp.
    value: value * tier.xpMul * chumValueRamp(runDifficulty),
    healMul: tier.healMul,
    vx: vel?.x ?? 0,
    vy: vel?.y ?? 0,
  });

  // Orbs settle on the seabed and would otherwise pile up all run.
  while (pickups.length > CONFIG.pickups.maxAlive) {
    const oldest = pickups.shift();
    orbPool?.release(oldest.mesh);
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

  // The RANGE test uses the corridor distance while dashing; the PULL still
  // aims at the seal itself. Those are two different questions — "is this in
  // reach" and "which way is the mouth" — and conflating them would drag orbs
  // toward a point on the dash line rather than toward the animal.
  const speed = player.velocity?.length?.() ?? 0;
  const reach = magnetDistance(
    player.mesh.position.x, player.mesh.position.y,
    orb.mesh.position.x, orb.mesh.position.y, speed,
  );
  if (reach < magnetRadius(player.stats, speed)) {
    const pull = magnetSpeed(speed) * dt;
    orb.mesh.position.x += (dx / dist) * pull;
    orb.mesh.position.y += (dy / dist) * pull;
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
  // A sealed mouth doesn't just refuse to swallow — it doesn't REACH either.
  // The magnet is off for the whole wind-up, so chum stays exactly where it is.
  // Leaving the magnet on looked far worse than no gate at all: every orb in
  // range was dragged inside the seal's body and sat there hidden, which reads
  // as having been collected, while the gate quietly refused to collect it.
  const sealed = !!player.chumSealed;
  const tell = CONFIG.strike.charge.gulp?.tell ?? {};
  // What the release would take if it fired right now — that is the radius
  // worth telegraphing, not the magnet's.
  const tellRadius = sealed ? (player.stats.chumGulpRadius ?? 0) : 0;
  // Hoisted: the magnet state is a property of the SEAL, not of each orb, and
  // resolving it per orb would ask the same question 140 times a frame.
  const sealSpeed = player.velocity?.length?.() ?? 0;
  const reachNow = magnetRadius(player.stats, sealSpeed);
  orbClock += dt;

  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];

    // Last frame's shiver comes off before anything reads the position. The
    // mesh has to hold the orb's REAL position everywhere else — the gulp, the
    // pile grid and the crabs all measure straight off it — and an offset left
    // on would integrate into a visible drift across a long hold.
    if (p.shiverX || p.shiverY) {
      p.mesh.position.x -= p.shiverX;
      p.mesh.position.y -= p.shiverY;
      p.shiverX = 0;
      p.shiverY = 0;
    }

    const dx = player.mesh.position.x - p.mesh.position.x;
    const dy = player.mesh.position.y - p.mesh.position.y;
    const dist = Math.hypot(dx, dy) || 0.0001;
    // Inside a sealed mouth's reach: about to be swallowed, but not yet.
    const waiting = sealed && dist < tellRadius;

    // Chum keeps turning after it settles — a still pile on the seabed is the
    // easiest thing on screen to stop noticing — and turns FASTER while it
    // waits on a release, which is half the telegraph.
    updateTumble(p.mesh, dt * (waiting ? (tell.spinMul ?? 1) : 1));

    if (waiting) {
      // HELD: not pulled, and not sinking either. An orb advertising "the
      // release is going to take me" has to still be inside the gulp when the
      // release comes, and at the default sink speed a wind-up only a few
      // seconds long drops a mid-water pile clean out of the radius it was
      // telegraphing. Anything already resting on the seabed was going nowhere
      // anyway, so this only ever holds the ones in open water.
    } else if (!sealed && magnetDistance(
      player.mesh.position.x, player.mesh.position.y,
      p.mesh.position.x, p.mesh.position.y, sealSpeed,
    ) < reachNow) {
      // The magnet outranks any throw still in flight, and cancels it — an orb
      // the player swam away from should go back to sinking, not pick its old
      // arc back up.
      p.vx = 0;
      p.vy = 0;
      // Pulled at the state's own speed. While dashing that is deliberately
      // FASTER THAN THE DASH: at the flat 14 against a 46 u/s dash an orb not
      // directly ahead falls behind at 32 u/s and can never arrive, so a wider
      // striking radius on its own would have collected nothing extra.
      const pull = magnetSpeed(sealSpeed) * dt;
      p.mesh.position.x += (dx / dist) * pull;
      p.mesh.position.y += (dy / dist) * pull;
    } else if (p.hoover) {
      // IN A MOUTH: already moved this frame by whatever is eating it (see
      // bitePickup), and neither sinking nor drifting on its own until it lets
      // go. Ranked below the magnet on purpose — the player swimming over a
      // crab's dinner takes it, which is the same precedence the crab's own
      // aggro already uses when it drops the food to come for you.
    } else if (p.vx || p.vy) {
      // Still carrying a throw (boat chum, spilling out of a hull). Gravity
      // only applies in the air — below the water line it's drag alone, which
      // is what hands the orb over to the ordinary sink below within about a
      // second instead of letting the throw run on into a fall.
      const toss = CONFIG.pickups.toss ?? {};
      const underwater = p.mesh.position.y < bounds.surfaceY;
      if (!underwater) p.vy -= CONFIG.arena.gravity * dt;
      const drag = Math.exp(-(underwater ? (toss.waterDrag ?? 4.5) : (toss.airDrag ?? 1.2)) * dt);
      p.vx *= drag;
      p.vy *= drag;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      // Chum belongs in the water: a throw never lifts an orb out of it, or a
      // boat kill would leave bits of catch hanging in the sky.
      const ceiling = bounds.surfaceY - 0.15;
      if (p.mesh.position.y > ceiling) {
        p.mesh.position.y = ceiling;
        p.vy = Math.min(p.vy, 0);
      }
      const floor = bounds.bottom + 0.8;
      if (p.mesh.position.y < floor) {
        p.mesh.position.y = floor;
        p.vy = 0;
      }
      if (p.vx * p.vx + p.vy * p.vy < 0.09) { p.vx = 0; p.vy = 0; }
    } else {
      // Out of magnet range — or held out of it by a wind-up — orbs sink
      // through the water and settle on the seabed.
      p.mesh.position.y -= CONFIG.pickups.sinkSpeed * dt;
      const floor = bounds.bottom + 0.8;
      if (p.mesh.position.y < floor) p.mesh.position.y = floor;
    }

    // Nothing goes down while the mouth is sealed; the release gulps the lot
    // instead (see gulpPickups and CONFIG.strike.charge.gulp).
    if (!sealed && dist < CONFIG.pickups.collectRadius) {
      onCollect(p.value, p.mesh.position.x, p.mesh.position.y, p.healMul);
      orbPool?.release(p.mesh);
      pickups.splice(i, 1);
      continue;
    }

    // The other half of the telegraph: a shiver in place. Geometric because a
    // buzz is what "spoken for" looks like — and, until the per-instance glow
    // below existed, because it had to be: orb materials are SHARED across
    // every instance (see spawnXpOrb), so a flash written to the material's
    // colour lights every orb in the arena rather than the ones about to be
    // eaten. A tell written through setGlow is now possible; this isn't it.
    //
    // Per-orb phase, or a pile shivers in lockstep and reads as one object
    // wobbling instead of a dozen loose bits rattling.
    if (waiting && (tell.shiver ?? 0) > 0) {
      const phase = (p.shiverPhase ??= Math.random() * Math.PI * 2);
      // Same Nyquist limit the wind-up tremble lives under (see
      // CONFIG.strike.charge.tremble): past ~20Hz at 60fps this aliases into a
      // slow wobble, which reads as broken rather than as urgent.
      const w = orbClock * (tell.hz ?? 18) * Math.PI * 2 + phase;
      p.shiverX = Math.cos(w) * tell.shiver;
      // Beaten against a different multiple so it buzzes in a little figure
      // rather than sliding back and forth along one line.
      p.shiverY = Math.sin(w * 1.7) * tell.shiver;
      p.mesh.position.x += p.shiverX;
      p.mesh.position.y += p.shiverY;
    }

    // THE PULL: brighter the closer the seal is, so a scattered pile lights up
    // as it comes into reach instead of waiting to be noticed. Written to the
    // orb's own instance rather than to the material every orb shares — that
    // is the whole reason this can exist at all (see CONFIG.pickups.glow and
    // setGlow in systems/instancedPool.js).
    //
    // `dist` is this frame's distance, measured before the magnet moved either
    // of them; at magnet speed that is under a quarter of a unit of lag on a
    // 12-unit halo, and using it costs nothing where re-measuring would cost a
    // second hypot per orb per frame.
    //
    // Separate phase from the shiver's: they run at rates an order of
    // magnitude apart, and sharing one would tie a 1.6Hz shimmer's starting
    // point to an 18Hz buzz's.
    // `reachNow`, not the base radius: the halo's whole job is "this is in
    // reach", so it has to widen with the reach. A halo pinned to the base
    // while a dash reaches twice as far would light up a fraction of the food
    // the dash is actually about to take.
    orbPool?.setGlow(p.mesh, chumGlowAt(
      dist, reachNow, orbClock,
      (p.glowPhase ??= Math.random() * Math.PI * 2),
    ));

    // Consumed, not latched: whatever is eating this orb re-raises the flag
    // every frame it is still eating (updateEnemies runs first), so an animal
    // that dies, is bubbled, or simply changes its mind hands the orb straight
    // back to gravity on the next frame rather than leaving it stuck in mid
    // water where a mouth used to be.
    p.hoover = false;
  }

  if (onStrikeOrb) updateOrbArray(dt, scene, player, strikeOrbs, 0, onStrikeOrb);
  if (onBubbleOrb) updateOrbArray(dt, scene, player, bubbleOrbs, CONFIG.oxygen.bubbleRiseSpeed, onBubbleOrb);
  if (onRapidFireOrb) updateOrbArray(dt, scene, player, rapidFireOrbs, 0, onRapidFireOrb);
}

// Swallow every chum orb within `radius` of (x, y) on this frame — the release
// half of the charge gulp, and the payoff for the mouth being sealed through
// the wind-up.
//
// Each orb goes through the SAME onCollect the swim-over path uses rather than
// a cut-down version, so xp, healing, the charge meter and the food chain all
// land exactly as if the seal had crossed them one at a time. That matters
// beyond tidiness: the gate stops the meter refilling during a hold, and this
// is the call that gives it back, so anything this path skipped would be a
// resource the gate quietly deleted.
//
// Returns how many went down, so the caller can stay silent on an empty gulp.
export function gulpPickups(scene, x, y, radius, onCollect) {
  if (!(radius > 0)) return 0;
  const r2 = radius * radius;
  let n = 0;
  // Backwards, like every other loop here that splices as it goes.
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    const dx = p.mesh.position.x - x;
    const dy = p.mesh.position.y - y;
    if (dx * dx + dy * dy > r2) continue;
    onCollect(p.value, p.mesh.position.x, p.mesh.position.y, p.healMul);
    orbPool?.release(p.mesh);
    pickups.splice(i, 1);
    n++;
  }
  return n;
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
//
// `suck` is the visible half: { x, y, rate, dt } drags the orb toward a mouth
// for as long as it is being eaten. Optional, and the shrink works exactly as
// before without it — but with it the orb travels INTO the animal instead of
// dwindling where it lies, which is the difference between "an orb vanished"
// and "that crab took it". The pull is exponential on dt, so it is the same
// motion at any framerate and never overshoots the mouth.
//
// It also raises `p.hoover` for the frame, which updatePickups reads as "not
// yours to sink" — otherwise the orb's own settle would drag it straight back
// down out of a shark's jaw on the same frame it was pulled up into it.
export function bitePickup(scene, p, amount, suck = null) {
  const i = pickups.indexOf(p);
  if (i === -1) return false;
  if (suck) {
    const k = 1 - Math.exp(-(suck.rate ?? 6) * suck.dt);
    p.mesh.position.x += (suck.x - p.mesh.position.x) * k;
    p.mesh.position.y += (suck.y - p.mesh.position.y) * k;
    // Depth too, or the last of the meal is wrong: creatures sit in their own
    // depth lane, and an orb left on the play plane while the animal eating it
    // is in front of that plane hangs visibly outside the mouth. Matching z
    // puts the orb INSIDE the body, where an opaque mesh that writes depth
    // occludes it — which is what "swallowed" looks like.
    p.mesh.position.z += (suck.z - p.mesh.position.z) * k;
    p.hoover = true;
    // A throw still in flight would keep adding to the position underneath
    // the pull and drag the orb back out of the mouth. Being eaten ends it.
    p.vx = 0;
    p.vy = 0;
  }
  p.eaten = (p.eaten ?? 0) + amount;
  if (p.eaten < 1) {
    // Shrink toward a third of its size rather than to nothing — an orb that
    // dwindles to a speck before it pops is hard to see coming.
    const t = 1 - p.eaten * 0.66;
    p.mesh.scale.setScalar((p.baseScale ??= p.mesh.scale.x) * t);
    return false;
  }
  orbPool?.release(p.mesh);
  pickups.splice(i, 1);
  return true;
}
