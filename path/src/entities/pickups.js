import * as THREE from 'three';
import { CONFIG, chumValueRamp } from '../config.js';
import { createVisual, ASSETS, getAssetSizeMultiplier } from '../assets.js';
import { bounds } from '../arena.js';
import { updateTumble } from '../systems/rocks.js';
import { createInstancedPool } from '../systems/instancedPool.js';
// The general magnet (magnetRadius/Speed/Distance) is what EVERY pickup gets;
// the food one (foodReach/Pull/Distance) is the same thing tiered by whether a
// FOOD CHAIN is running, and only chum and chunks answer to it. Both imported
// on purpose — the blue orb, the bubble and the morsel are not what the chain
// is made of and must keep the full magnet at all times.
import {
  magnetRadius, magnetSpeed, magnetDistance,
  foodReach, foodPull, foodDistance,
} from '../systems/chumMagnet.js';
import { telegraphMul } from '../systems/telegraph.js';
import { initBubble, updateBubblePhysics, bubbleRadius, bubbleBirthPoint, growthOf } from '../systems/oxygenBubble.js';
import { createCoralOrb, updateCoralOrb, disposeCoralOrb } from '../systems/coralOrb.js';
import { createLevelOrb, updateLevelOrb, disposeLevelOrb, setLevelOrbScale } from '../systems/levelOrb.js';

export { bubbleBirthPoint, bubbleRadius };

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
// The one pickup that changes the BUILD — see systems/levelOrb.js.
export const levelOrbs = [];
export const chumChunks = [];

export function resetPickups(scene) {
  orbPool?.reset();
  pickups.length = 0;
  orbClock = 0;
  runDifficulty = 0;
  for (const o of strikeOrbs) scene.remove(o.mesh);
  strikeOrbs.length = 0;
  for (const o of bubbleOrbs) scene.remove(o.mesh);
  bubbleOrbs.length = 0;
  for (const o of rapidFireOrbs) {
    scene.remove(o.mesh);
    disposeCoralOrb(o.mesh);
  }
  rapidFireOrbs.length = 0;
  for (const o of levelOrbs) {
    scene.remove(o.mesh);
    disposeLevelOrb(o.mesh);
  }
  levelOrbs.length = 0;
  for (const c of chumChunks) removeChunk(scene, c);
  chumChunks.length = 0;
}

function tierFor(radius) {
  for (const t of CONFIG.pickups.tiers) if (radius <= t.maxRadius) return t;
  return CONFIG.pickups.tiers[CONFIG.pickups.tiers.length - 1];
}

/**
 * The radius a creature's DROP is sized and priced off — its own, unless
 * enemies.csv gave it a `chumRadius` because the two are different facts.
 *
 * `radius` is a hitbox, and for one creature that hitbox is doing a second job:
 * a crawler's centre is parked at `bounds.bottom + radius`, so the king crab's
 * 0.5 is its resting height off the sand rather than its size. Everything the
 * drop reads keys on this number — the orb tier, the mass ramp, the heal, the
 * orb's own scale — so at 0.5 the biggest body in the game dropped a minnow's
 * orb, worth 44 xp against the boss shark's 410 off a row asking for MORE xp
 * than the shark's.
 *
 * Exported because the fallback has to be in ONE place. It was written out at
 * the call site in main.js and again in tools/xp-economy-test.mjs, which is how
 * a harness comes to measure a creature the game no longer ships.
 */
export function chumRadiusOf(def) {
  return def?.chumRadius ?? def?.radius ?? 0.5;
}

/**
 * How much bigger a drop is than the top tier already makes it, for a source of
 * `radius` — see CONFIG.pickups.mass. `{ value, size }`, both 1 at or below the
 * ramp's start, so every creature the three tiers already separated is
 * untouched and only the crowd they lumped together comes apart.
 *
 * Two multipliers rather than one because they are two different promises: the
 * value is what the orb PAYS and the size is what it SAYS, and a chum orb that
 * grew as fast as its value would be a boulder. Returned together, and pure, so
 * tools/xp-economy-test.mjs can walk the roster through it — "does a megalodon
 * actually drop more than a shark" is a question about this function and
 * nothing else.
 */
export function chumMassMul(radius) {
  const m = CONFIG.pickups?.mass;
  if (!m || m.enabled === false) return { value: 1, size: 1 };
  const from = m.from ?? 1;
  if (!(from > 0) || !(radius > from)) return { value: 1, size: 1 };
  const over = radius / from;
  const cap = m.max ?? Infinity;
  return {
    value: Math.min(cap, over ** (m.exponent ?? 1)),
    // Capped against the SAME ceiling raised to the size exponent, not against
    // `max` directly — otherwise the size ramp would keep growing after the
    // value ramp had stopped, and the biggest orbs in the game would all be
    // telling the player they were worth more than they are.
    size: Math.min(cap ** (m.sizeExponent ?? 1), over ** ((m.exponent ?? 1) * (m.sizeExponent ?? 1))),
  };
}

// `sourceRadius` is the dropping enemy's def.radius — small fish drop small,
// dim orbs worth less xp/heal; a shark or squid drops a big bright one.
// `vel` is an optional {x, y} throw, for a source that scatters its drop
// rather than placing it (a boat coming apart) — see the toss in updatePickups.
export function spawnXpOrb(scene, pos, value, sourceRadius = 0.5, vel = null) {
  const tier = tierFor(sourceRadius);
  // Past the top tier the drop keeps growing with the body it came out of, in
  // both what it pays and what it looks like — see CONFIG.pickups.mass.
  const mass = chumMassMul(sourceRadius);
  const mesh = createVisual('xpOrb');
  mesh.position.copy(pos);
  mesh.scale.setScalar(tier.scale * mass.size);
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
    //
    // `mass.value` and CONFIG.xp.chumMul join it here, at the drop, for the same
    // reason the holdback is here: an orb is worth what it was worth when it hit
    // the water, no matter how long it sits on the seabed before anything eats
    // it. Only the heal and the charge refill are left on the tier alone.
    value: value * tier.xpMul * mass.value * (CONFIG.xp?.chumMul ?? 1) * chumValueRamp(runDifficulty),
    healMul: tier.healMul,
    vx: vel?.x ?? 0,
    vy: vel?.y ?? 0,
  });

  // Orbs settle on the seabed and would otherwise pile up all run.
  //
  // The oldest one that is NOT already flying to the mouth: the cap exists to
  // clear forgotten piles off the seabed, and an orb the magnet has claimed is
  // the opposite of forgotten. Deleting one mid-flight is indistinguishable
  // from the magnet dropping it, and it happens exactly when the water is
  // busiest. Falls back to the plain oldest if every orb alive is claimed, so
  // the cap is still a cap.
  while (pickups.length > CONFIG.pickups.maxAlive) {
    let k = pickups.findIndex((p) => !p.magnetLatch);
    if (k === -1) k = 0;
    const [oldest] = pickups.splice(k, 1);
    orbPool?.release(oldest.mesh);
  }
}

export function spawnStrikeOrb(scene, pos) {
  const mesh = createVisual('strikeOrb');
  mesh.position.copy(pos);
  scene.add(mesh);
  strikeOrbs.push({ mesh, life: CONFIG.strike.orbLifetime, bodyRadius: assetBodyRadius('strikeOrb') });
}

// `pos` is where the bubble seeps out of, and the caller is expected to hand
// over a point ON THE SEABED — see bubbleBirthPoint in systems/oxygenBubble.js.
// Nothing here enforces that, because the boat-debris path drops one wherever
// the hull came apart and that is a bubble too.
export function spawnBubbleOrb(scene, pos) {
  const mesh = createVisual('bubbleOrb');
  mesh.position.copy(pos);
  scene.add(mesh);
  const orb = { mesh, life: CONFIG.oxygen.bubbleLifetime };
  // The asset's authored radius, carried on the orb so the collect test and
  // the collision loop size themselves off the same number the art uses. Read
  // off the table rather than typed here — a bubble whose hitbox and whose
  // drawn skin disagree is a pickup that refuses to be taken from the place it
  // looks like it should be, and nothing about that reports itself.
  orb.assetRadius = ASSETS.bubbleOrb?.radius ?? 0.44;
  initBubble(orb);
  bubbleOrbs.push(orb);
  return orb;
}

// A GROWN CORAL, not a createVisual. Its geometry is rolled per spawn and its
// pulse phase lives in a uniform, so both the geometry and the material are its
// own — see systems/coralOrb.js. The `rapidFireOrb` asset entry stays in the
// table as the Look panel's handle on the TINT it reads, and as the row
// assets.csv sizes it from. Its glow is deliberately not read — see the note in
// createCoralOrb.
export function spawnRapidFireOrb(scene, pos) {
  const mesh = createCoralOrb();
  mesh.position.copy(pos);
  // The asset's size multiplier, which createVisual would have applied. Read
  // here because this path does not go through it, and a coral that ignored
  // assets.csv would be the one pickup in the game the Size column cannot
  // reach.
  const sizeMul = getAssetSizeMultiplier('rapidFireOrb');
  if (sizeMul) mesh.scale.multiplyScalar(sizeMul);
  scene.add(mesh);
  // MEASURED off the coral it actually grew, not derived from the asset's
  // authored radius: this is the one pickup whose body is a different shape
  // every time, and `ASSETS.rapidFireOrb.radius` describes the rock it
  // replaced. Measured once here rather than per frame — the geometry never
  // changes after it is grown.
  rapidFireOrbs.push({ mesh, life: CONFIG.rapidFirePickup.lifetime, bodyRadius: measuredBodyRadius(mesh) });
}

// A GROWN BLOB, not a createVisual, for exactly the two reasons the coral is
// not one: the geometry is rolled per spawn and the colour lives in uniforms
// that a shared material would beat in lockstep. The `levelOrb` asset entry
// stays in the table as the row assets.csv sizes it from — see the note there.
export function spawnLevelOrb(scene, pos) {
  const mesh = createLevelOrb();
  mesh.position.copy(pos);
  // The asset's size multiplier, which createVisual would have applied. Handed
  // to the module rather than written straight onto the mesh, because the blob
  // SWELLS on every note and a scale it did not know about would be overwritten
  // by the first kick — the same trap a setScalar after createVisual falls
  // into. See setLevelOrbScale.
  setLevelOrbScale(mesh, getAssetSizeMultiplier('levelOrb') || 1);
  scene.add(mesh);
  // MEASURED, like the coral's: this is the other pickup whose body is a
  // different shape every time, so the authored radius in ASSETS describes a
  // sphere the blob only approximately is.
  levelOrbs.push({ mesh, life: CONFIG.levelPickup.lifetime, bodyRadius: measuredBodyRadius(mesh) });
}

// Half the widest side of whatever this object actually occupies, in world
// units. `Box3` rather than a bounding sphere: a sphere around a branching
// coral is mostly empty air, and a pickup that could be taken from a unit
// clear of its own tips would read as sloppy in the other direction.
const _bodyBox = new THREE.Box3();
const _bodySize = new THREE.Vector3();
function measuredBodyRadius(obj) {
  _bodyBox.setFromObject(obj);
  if (!Number.isFinite(_bodyBox.min.x)) return 0;
  _bodyBox.getSize(_bodySize);
  return Math.max(_bodySize.x, _bodySize.y) / 2;
}

// The same question for an asset that is always the same shape, answered off
// the table so it costs nothing at spawn.
function assetBodyRadius(key) {
  return (ASSETS[key]?.radius ?? 0) * (getAssetSizeMultiplier(key) || 1);
}

// ---------------------------------------------------------------------------
// CHUM CHUNKS — one big piece of catch, worth a real bite of health.
//
// Everything about a chunk is decided at SPAWN and then visible: the heal it
// will pay is rolled once, and the size and colour it wears are that roll. So
// "is it worth crossing the arena for this one" is a question the player can
// answer by looking, which is the entire reason this pickup exists in a
// separate array instead of as a fourth entry in CONFIG.pickups.tiers.
//
// See CONFIG.chumChunk for the numbers and for who puts one in the water.
// ---------------------------------------------------------------------------

// The roll, 0..1, where 0 is the smallest chunk and 1 the largest. Pure and
// exported because the DISTRIBUTION is the balance decision, not the endpoints:
// `healMax` on its own says nothing about how often anyone sees a big one, and
// the only honest way to check "bigger is rarer" is to run this a few thousand
// times and look at the histogram — which is what tools/chum-chunk-test.mjs
// does. `rand` is injected for the same reason: the test seeds it.
//
// `floor` raises the BOTTOM of the range (the pity chunk's whole trick), and it
// is applied to the rolled position rather than to the heal, so the size the
// player sees still matches what they get.
export function rollChunkT(rand = Math.random, bias = 1, floor = 0) {
  const t = Math.pow(Math.max(0, Math.min(1, rand())), Math.max(0.01, bias));
  return Math.max(0, Math.min(1, floor + t * (1 - floor)));
}

// The heal, as a fraction of max HP, for a roll of `t`. Linear between the two
// ends — all of the rarity lives in rollChunkT above, and splitting the curve
// across both would make neither of them readable.
export function chunkHealFrac(t) {
  const c = CONFIG.chumChunk ?? {};
  const lo = c.healMin ?? 0.1;
  const hi = c.healMax ?? 0.75;
  return lo + (hi - lo) * Math.max(0, Math.min(1, t));
}

const chunkColor = new THREE.Color();
const chunkBox = new THREE.Box3();
const chunkSize = new THREE.Vector3();

/**
 * Put a chunk in the water.
 *
 * `opts.t` is a roll from rollChunkT; omit it and one is taken at the ambient
 * bias. `opts.vel` is a {x, y} throw for a chunk being kicked out of something
 * (a boss), which runs through the same toss physics chum from a broken hull
 * does. Returns the chunk, so the caller can announce it at the size it rolled.
 */
export function spawnChumChunk(scene, pos, opts = {}) {
  const c = CONFIG.chumChunk ?? {};
  const t = opts.t ?? rollChunkT(Math.random, c.healBias ?? 1);
  const mesh = createVisual('chumChunk');
  mesh.position.copy(pos);
  // multiplyScalar, NOT setScalar: the asset carries its own size from
  // assets.csv and assigning over it would silently delete that row's effect.
  // This is a multiple of however big a chunk is authored to be.
  mesh.scale.multiplyScalar((c.scaleMin ?? 1) + ((c.scaleMax ?? 2.4) - (c.scaleMin ?? 1)) * t);

  // ITS OWN MATERIAL. Primitive assets share one material across every
  // instance, so writing tint or glow to the shared one would repaint every
  // chunk in the water to match whichever spawned last — and the tint IS the
  // tell here, so that is not a cosmetic problem but a lie about the heal.
  // Safe to clone because this asset is a plain unlit material with no
  // injected shader; an asset with `shell` or a bioluminescent skin would lose
  // it in the clone.
  if (mesh.material) {
    mesh.material = mesh.material.clone();
    mesh.userData.ownMaterial = true;
  }
  const base = chunkColor.set(c.tintMin ?? 0xff6a4a).clone()
    .lerp(new THREE.Color(c.tintMax ?? 0xffd166), t);

  // MEASURED, not assumed. A chunk's size is the asset's authored radius times
  // its assets.csv row times the roll above, and any of those three can move —
  // so the radius the seal has to swim inside to take one is read off the mesh
  // that actually exists rather than typed here in world units. Once, at spawn:
  // nothing scales a chunk after this.
  //
  // Before scene.add on purpose: setFromObject only refreshes this object's own
  // world matrix, so measuring it while parented to a scene whose matrices are
  // a frame stale would fold that staleness into the size.
  chunkBox.setFromObject(mesh);
  chunkBox.getSize(chunkSize);
  scene.add(mesh);
  const chunk = {
    mesh,
    // Half the larger horizontal extent — a chunk is a lumpy rock, and the
    // generous end of that is the one that matches what the player sees.
    radius: Math.max(chunkSize.x, chunkSize.y) * 0.5,
    t,
    healFrac: chunkHealFrac(t),
    base,
    life: c.lifetime ?? 34,
    // Counts DOWN from the arrival flash; see the brightness in updateChunk.
    flash: c.flash?.enabled === false ? 0 : (c.flash?.seconds ?? 0),
    vx: opts.vel?.x ?? 0,
    vy: opts.vel?.y ?? 0,
    phase: Math.random() * Math.PI * 2,
  };
  chumChunks.push(chunk);
  return chunk;
}

function removeChunk(scene, chunk) {
  scene.remove(chunk.mesh);
  // The clone above is this chunk's alone, so nothing else is still drawing
  // with it. Cloned materials share their compiled program, so this frees the
  // uniforms and not the shader.
  if (chunk.mesh.userData.ownMaterial) chunk.mesh.material?.dispose?.();
}

// How bright a chunk should be right now, as a multiplier on the colour it
// rolled. Exported and pure for the same reason chumGlowAt is: the arrival
// flash has to be plainly brighter than the resting glow and has to actually
// reach it, and both of those are visible in the numbers alone.
export function chunkBrightness(flashLeft, clock, phase = 0) {
  const c = CONFIG.chumChunk ?? {};
  const glow = c.glow ?? 1.5;
  const pulse = 1 + (c.pulseDepth ?? 0) * Math.sin(clock * (c.pulseHz ?? 0.8) * Math.PI * 2 + phase);
  let mul = glow * pulse;
  const seconds = c.flash?.seconds ?? 0;
  if (flashLeft > 0 && seconds > 0) {
    // Exponential, so the afterglow drops off fast enough to still read as a
    // flash but never hits the resting value with a visible corner on it.
    const k = Math.max(0, Math.min(1, flashLeft / seconds));
    mul += (c.flash?.boost ?? 0) * k * k;
  }
  return Math.max(0, mul);
}

function updateChunk(dt, scene, player, chunk, onCollect) {
  chunk.life -= dt;
  if (chunk.flash > 0) chunk.flash -= dt;
  updateTumble(chunk.mesh, dt);

  const dx = player.mesh.position.x - chunk.mesh.position.x;
  const dy = player.mesh.position.y - chunk.mesh.position.y;
  const dist = Math.hypot(dx, dy) || 0.0001;

  const speed = player.velocity?.length?.() ?? 0;
  // THE FOOD MAGNET, not the general one: a chunk is what the FOOD CHAIN is
  // made of, so a live chain sweeps for it and a cruising seal merely drifts it
  // in. Both collect — see foodReach in systems/chumMagnet.js.
  const reach = foodDistance(
    player.mesh.position.x, player.mesh.position.y,
    chunk.mesh.position.x, chunk.mesh.position.y, speed,
  );
  // Latched, exactly as chum is: coming into reach CLAIMS the chunk, and a
  // claimed chunk travels to the mouth until it is swallowed. The reach behind
  // it can close — chain over, dash over, seal turned away — without stranding
  // it, which matters more here than anywhere: this is the rarest pickup in
  // the game to lose in mid water.
  const magnetised = reach < foodReach(player.stats, speed) || chunk.magnetLatch;
  if (magnetised) chunk.magnetLatch = true;

  if (magnetised) {
    // Same precedence chum uses: the magnet outranks a throw still in flight,
    // and cancels it, so a chunk the seal has claimed stops arcing away.
    chunk.vx = 0;
    chunk.vy = 0;
    // Clamped to what is left of the gap for the same reason chum's is: the
    // last step has to land on the seal, not past it.
    const step = Math.min(foodPull(speed) * dt, dist);
    chunk.mesh.position.x += (dx / dist) * step;
    chunk.mesh.position.y += (dy / dist) * step;
  } else if (chunk.vx || chunk.vy) {
    // Kicked out of something. The same toss model chum spilling from a hull
    // uses — drag below the water line, gravity above it — so a chunk thrown
    // clear of a boss travels like every other piece of catch in the game.
    const toss = CONFIG.pickups.toss ?? {};
    const underwater = chunk.mesh.position.y < bounds.surfaceY;
    if (!underwater) chunk.vy -= CONFIG.arena.gravity * dt;
    const drag = Math.exp(-(underwater ? (toss.waterDrag ?? 4.5) : (toss.airDrag ?? 1.2)) * dt);
    chunk.vx *= drag;
    chunk.vy *= drag;
    chunk.mesh.position.x += chunk.vx * dt;
    chunk.mesh.position.y += chunk.vy * dt;
    if (chunk.vx * chunk.vx + chunk.vy * chunk.vy < 0.09) { chunk.vx = 0; chunk.vy = 0; }
  } else {
    chunk.mesh.position.y -= (CONFIG.chumChunk?.sinkSpeed ?? 0.9) * dt;
  }

  // Never above the water and never through the seabed, whichever path moved
  // it — a chunk hanging in the sky or buried in the floor is unreachable, and
  // this is the game's rarest pickup to lose that way.
  const ceiling = bounds.surfaceY - 0.15;
  if (chunk.mesh.position.y > ceiling) {
    chunk.mesh.position.y = ceiling;
    chunk.vy = Math.min(chunk.vy, 0);
  }
  const floor = bounds.bottom + 0.8;
  if (chunk.mesh.position.y < floor) {
    chunk.mesh.position.y = floor;
    chunk.vy = 0;
  }

  if (chunk.mesh.material?.color) {
    // The coach's highlight rides the same multiply, for the same reason the
    // orbs' does: this is the chunk's one colour writer, and the tip about a
    // chunk is spoken while it is doing its own arrival flash and its own
    // resting pulse. Multiplying keeps all three legible — a chunk that rolled
    // dark red still goes bright RED rather than being repainted.
    chunk.mesh.material.color.copy(chunk.base)
      .multiplyScalar(chunkBrightness(chunk.flash, orbClock, chunk.phase) * telegraphMul(chunk.mesh));
  }

  // The seal's own reach PLUS the chunk's body — a big chunk is taken from
  // further out than a small one, because it is a bigger thing to swim into.
  // Using the bare collectRadius would have the largest chunks needing the
  // seal's centre to reach a point well inside them.
  //
  // Gated on there BEING a handler: without one the chunk is left in the water
  // to sink and expire normally, rather than being swum through and deleted
  // with nothing paid out.
  if (onCollect && dist < CONFIG.pickups.collectRadius + chunk.radius) {
    onCollect(chunk);
    return 'collected';
  }
  // A claimed chunk does not time out on the way in. The lifespan is there so
  // a chunk nobody came for eventually leaves the water; one that is a tenth
  // of a second from the mouth is not that, and blinking out in flight is the
  // same broken promise the latch above exists to stop.
  if (chunk.life <= 0 && !chunk.magnetLatch) return 'expired';
  return null;
}

// Shared float/magnet/lifespan/collect logic for the simple orb types below
// (xp orbs are handled separately above since they also sink and tier).
// `driftSpeed` is world units/sec, positive = rises (bubbles), 0 = stationary
// until magnetised (strike/rapid-fire orbs). Returns 'collected', 'expired',
// or null so the caller knows whether to splice the array.
function updateFloatingOrb(dt, player, orb, driftSpeed, onCollect, tick, rawDt) {
  orb.life -= dt;
  // A tumble is what a ROCK does, and only the strike orb still is one. An orb
  // with a `tick` of its own owns its whole motion — the coral turns on one
  // axis and nods (see systems/coralOrb.js) — and layering a three-axis tumble
  // under that would fight it for the same rotation every frame.
  if (tick) tick(orb.mesh, dt, rawDt);
  else updateTumble(orb.mesh, dt);

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

  // TAKEN BY TOUCHING ITS BODY, not its centre. `collectRadius` is one number
  // for every pickup in the game and it is measured to a POINT, which was fine
  // while all three of these were the same half-unit ball. They are not any
  // more — the coral is a branching thing over a unit and a half tall — and a
  // pickup drawn wider than the circle that takes it is one you visibly swim
  // through. The magnet normally hides this by dragging the orb the last half
  // unit in a single frame, which is exactly why it went unnoticed: turn the
  // magnet off and every one of them was being collected from inside its own
  // body. Same widening the chunk and the bubble already do.
  if (dist < CONFIG.pickups.collectRadius + (orb.bodyRadius ?? 0)) {
    // The ENTRY as a third argument, which the three older handlers ignore. It
    // is here for the level blob, whose burst takes the colour it happened to
    // be wearing on the frame it was swallowed — there is no `assetBaseColor`
    // answer for a thing that changes colour four times a bar. Handed over
    // while the orb is still in its array (the splice is the caller's, one
    // frame later in updateOrbArray), so the mesh is still live.
    onCollect(orb.mesh.position.x, orb.mesh.position.y, orb);
    return 'collected';
  }
  if (orb.life <= 0) return 'expired';
  return null;
}

// ---------------------------------------------------------------------------
// THE BUBBLES. Their own loop rather than updateOrbArray's, because almost
// nothing they do is what a floating orb does: they swell, they carry velocity,
// they are pushed around by the creatures that swim into them, and they can be
// destroyed by something other than the seal reaching them.
//
// `opts.bodies` is the enemy list. Optional on purpose — every existing harness
// calls updatePickups without it, and a bubble rising through empty water is a
// perfectly valid thing to test. `opts.onBubblePop` is the burst; it is NOT the
// collect callback and it pays no air, which is the whole risk the pickup now
// carries.
// ---------------------------------------------------------------------------
function updateBubbleOrbs(dt, scene, player, onCollect, opts) {
  const bodies = opts?.bodies ?? null;
  const onPop = opts?.onBubblePop ?? null;
  for (let i = bubbleOrbs.length - 1; i >= 0; i--) {
    const orb = bubbleOrbs[i];
    orb.life -= dt;

    const popped = updateBubblePhysics(dt, orb, bodies);
    // AFTER the physics, because the physics is what grew it. Reading the
    // radius first costs a frame of swell on the collect test below, which is
    // the kind of one-frame lie that only ever shows up as a pickup that
    // occasionally refuses to be taken.
    const r = bubbleRadius(orb);

    // MEASURED AFTER THE PHYSICS, so a bubble shoved into the seal on the same
    // frame is taken rather than being tested against where it used to be.
    const dx = player.mesh.position.x - orb.mesh.position.x;
    const dy = player.mesh.position.y - orb.mesh.position.y;
    const dist = Math.hypot(dx, dy) || 0.0001;

    // The magnet still applies — a bubble is a pickup — but it pulls the
    // bubble's VELOCITY rather than teleporting its position, or the drift and
    // the magnet would fight each frame and the loser would be whichever ran
    // last. It also does not reach a bubble that has not finished swelling:
    // something still attached to the floor is not loose in the water yet.
    const speed = player.velocity?.length?.() ?? 0;
    const reach = magnetDistance(
      player.mesh.position.x, player.mesh.position.y,
      orb.mesh.position.x, orb.mesh.position.y, speed,
    );
    if ((orb.grow ?? 1) >= 1 && reach < magnetRadius(player.stats, speed)) {
      const pull = magnetSpeed(speed);
      orb.vx += ((dx / dist) * pull - orb.vx) * Math.min(1, 6 * dt);
      orb.vy += ((dy / dist) * pull - orb.vy) * Math.min(1, 6 * dt);
      // Tells the physics to stand down for this frame — see the note on
      // `magnetHold`. Set AFTER the pull, and read on the NEXT frame's
      // updateBubblePhysics, which is the frame it has to survive.
      orb.magnetHold = true;
    }

    // Taken by touching its SKIN, not its centre. A 1.25-unit bubble collected
    // on the bare collectRadius would need the seal's nose most of the way
    // inside it, which reads as the pickup ignoring a hit.
    if (onCollect && dist < CONFIG.pickups.collectRadius + r) {
      onCollect(orb.mesh.position.x, orb.mesh.position.y);
      scene.remove(orb.mesh);
      bubbleOrbs.splice(i, 1);
      continue;
    }
    // Burst, or simply gone. Both remove it; only the burst gets a sound, and
    // an expiry deliberately does not — a timer running out in open water
    // several screens away is not an event.
    if (popped) {
      // How far it had SWELLED, not its radius: the caller wants to know how
      // much of a bubble came apart, and that is a fraction, not a length.
      onPop?.(orb.mesh.position.x, orb.mesh.position.y, growthOf(orb));
      scene.remove(orb.mesh);
      bubbleOrbs.splice(i, 1);
      continue;
    }
    if (orb.life <= 0) {
      scene.remove(orb.mesh);
      bubbleOrbs.splice(i, 1);
    }
  }
}

function updateOrbArray(dt, scene, player, arr, driftSpeed, onCollect, opts = null) {
  for (let i = arr.length - 1; i >= 0; i--) {
    const result = updateFloatingOrb(dt, player, arr[i], driftSpeed, onCollect, opts?.tick, opts?.rawDt ?? dt);
    if (result) {
      scene.remove(arr[i].mesh);
      // An orb that built its own geometry and material has to give them back
      // — nothing else holds a reference, and WebGL does not free on JS
      // garbage collection.
      opts?.dispose?.(arr[i].mesh);
      arr.splice(i, 1);
    }
  }
}

// onCollect(xpValue, x, y, healMul) — main.js applies both xp and heal from
// one callback so the two always travel together.
export function updatePickups(dt, scene, player, onCollect, onStrikeOrb, onBubbleOrb, onRapidFireOrb, onChunk, opts = null) {
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
  // THE FOOD REACH, not the general magnet's: chum is what the chain is made
  // of, so a live chain reaches for it twice as far and pulls it faster than
  // the seal is travelling, and a cruising seal gets the base radius at the
  // base speed. Both collect — the chain buys the SWEEP, never the right to
  // eat. See foodReach in systems/chumMagnet.js.
  //
  // The halo below rides this same number, which is the point of reading it
  // once: its whole job is "this is in reach", so it has to widen and narrow
  // with whatever the reach actually is.
  const reachNow = foodReach(player.stats, sealSpeed);
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
    // DISTANCE TO THE MOUTH, which is the corridor while sweeping mid-dash.
    // Hoisted rather than measured inside the branch below because the halo at
    // the bottom of the loop is about the same reach, and two answers to "how
    // far is this orb" is how food ends up occasionally refusing to be taken.
    const reach = foodDistance(
      player.mesh.position.x, player.mesh.position.y,
      p.mesh.position.x, p.mesh.position.y, sealSpeed,
    );
    // Inside a sealed mouth's reach: about to be swallowed, but not yet.
    const waiting = sealed && dist < tellRadius;

    // ONCE CLAIMED, ALWAYS CLAIMED — the reach is a FIRST TOUCH, not a hold.
    //
    // An orb that has started travelling to the mouth keeps travelling until
    // it is swallowed, whatever happens to the reach behind it: the chain
    // window closing and taking the sweep with it, a dash ending and taking
    // its corridor, the seal turning away, or a crab getting a claw on it.
    // All of those used to strand food in mid water with no explanation the
    // player can see — the orb was flying at them, and then it simply stopped
    // and sank. The claim is the promise; this latch is what keeps it.
    const claimed = !sealed && (reach < reachNow || p.magnetLatch);
    if (claimed) p.magnetLatch = true;

    // Chum keeps turning after it settles — a still pile on the seabed is the
    // easiest thing on screen to stop noticing — and turns FASTER while it
    // waits on a release, which is half the telegraph.
    updateTumble(p.mesh, dt * (waiting ? (tell.spinMul ?? 1) : 1));

    if (waiting || (sealed && p.magnetLatch)) {
      // HELD: not pulled, and not sinking either. An orb advertising "the
      // release is going to take me" has to still be inside the gulp when the
      // release comes, and at the default sink speed a wind-up only a few
      // seconds long drops a mid-water pile clean out of the radius it was
      // telegraphing. Anything already resting on the seabed was going nowhere
      // anyway, so this only ever holds the ones in open water.
      //
      // A CLAIMED ORB WAITS OUT THE WIND-UP TOO, wherever it is. Nothing is
      // dragged into a sealed mouth — that is the whole reason the gate exists
      // — but it does not go back to sinking either: the claim outlives the
      // wind-up, and the pull picks up again the moment the mouth opens, if
      // the release's own gulp has not already taken it.
    } else if (claimed) {
      // The magnet outranks any throw still in flight, and cancels it — an orb
      // the player swam away from should go back to sinking, not pick its old
      // arc back up.
      p.vx = 0;
      p.vy = 0;
      // Pulled at the state's own speed. While dashing that is deliberately
      // FASTER THAN THE DASH: at the flat 14 against a 46 u/s dash an orb not
      // directly ahead falls behind at 32 u/s and can never arrive, so a wider
      // striking radius on its own would have collected nothing extra.
      //
      // Clamped to the distance left, so the last step lands ON the seal
      // rather than throwing the orb out the far side: at a pull that outruns
      // a dash the overshoot is bigger than the collect radius, and an orb can
      // sit flicking through the seal frame after frame without ever being
      // measured close enough to swallow. The clamp is what turns "pulled at"
      // into "arrives".
      const step = Math.min(foodPull(sealSpeed) * dt, dist);
      p.mesh.position.x += (dx / dist) * step;
      p.mesh.position.y += (dy / dist) * step;
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

    // HAS THIS ORB EVER BEEN ON THE SEABED? Latched on the orb, and the latch
    // is the whole point: the first-run tip about loose chum ("out come the
    // crabs") is answered by going down and RETRIEVING a piece, and by the time
    // the seal's mouth closes on one the magnet has usually dragged it half way
    // up the arena. Asking where the orb was when it was swallowed answers "mid
    // water" for exactly the mouthful the tip asked for.
    //
    // The same line countFloorPickups draws, so "on the floor" means one thing
    // to the tip, to the crab spawner and to the orb itself. Never cleared: an
    // orb that sank and was then magnetised back up is still one the player had
    // to go down for.
    if (!p.sank && p.mesh.position.y <= bounds.bottom + CONFIG.crabSpawn.floorHeight) p.sank = true;

    // Nothing goes down while the mouth is sealed; the release gulps the lot
    // instead (see gulpPickups and CONFIG.strike.charge.gulp).
    if (!sealed && dist < CONFIG.pickups.collectRadius) {
      onCollect(p.value, p.mesh.position.x, p.mesh.position.y, p.healMul, p.sank);
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
    //
    // ...TIMES WHATEVER THE FIRST-RUN COACH IS DOING TO IT. Folded in here
    // rather than written by systems/telegraph.js, because this line is the
    // orb's one writer: a second one would win on some frames and lose on
    // others depending on which system ran first, and the symptom would be a
    // highlight that flickers only while the seal is close enough for the halo
    // to be doing anything.
    orbPool?.setGlow(p.mesh, chumGlowAt(
      dist, reachNow, orbClock,
      (p.glowPhase ??= Math.random() * Math.PI * 2),
    ) * telegraphMul(p.mesh));

    // Consumed, not latched: whatever is eating this orb re-raises the flag
    // every frame it is still eating (updateEnemies runs first), so an animal
    // that dies, is bubbled, or simply changes its mind hands the orb straight
    // back to gravity on the next frame rather than leaving it stuck in mid
    // water where a mouth used to be.
    p.hoover = false;
  }

  if (onStrikeOrb) updateOrbArray(dt, scene, player, strikeOrbs, 0, onStrikeOrb);
  // The bubble runs UNGATED, unlike the two orbs either side of it, and for
  // the same reason the chunks below do: it is a physical object now. An
  // unconsumed bubble still has to swell, still has to rise, and still has to
  // be shoved around by whatever swims into it — a caller with no handler
  // leaving one frozen half-grown inside the seabed would be far worse than it
  // simply not paying out. Only the COLLECT is gated.
  updateBubbleOrbs(dt, scene, player, onBubbleOrb, opts);
  if (onRapidFireOrb) {
    updateOrbArray(dt, scene, player, rapidFireOrbs, 0, onRapidFireOrb, {
      tick: updateCoralOrb,
      dispose: disposeCoralOrb,
      // The coral's pulse is beat-synced, so it wants the undilated clock.
      rawDt: opts?.rawDt ?? dt,
    });
  }
  // The level blob, on the same terms — its colour is on the musical grid, so a
  // hit-stop must not hold a note.
  if (opts?.onLevelOrb) {
    updateOrbArray(dt, scene, player, levelOrbs, 0, opts.onLevelOrb, {
      tick: updateLevelOrb,
      dispose: disposeLevelOrb,
      rawDt: opts?.rawDt ?? dt,
    });
  }

  // Chunks run whether or not a callback was passed, unlike the three above:
  // an unconsumed chunk still has to sink, still has to expire and still has to
  // stop glowing, and a caller with no handler leaving one frozen mid-water and
  // lit forever would be far worse than it simply not paying out. Only the
  // COLLECT is gated.
  for (let i = chumChunks.length - 1; i >= 0; i--) {
    const chunk = chumChunks[i];
    const result = updateChunk(dt, scene, player, chunk, onChunk);
    if (result) {
      removeChunk(scene, chunk);
      chumChunks.splice(i, 1);
    }
  }
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
    // `p.sank` rides along here too — a release gulp that hoovers a settled
    // pile off the seabed is one of the three ways of answering the loose-chum
    // tip, and the most likely one. See the latch in updatePickups.
    onCollect(p.value, p.mesh.position.x, p.mesh.position.y, p.healMul, p.sank);
    orbPool?.release(p.mesh);
    pickups.splice(i, 1);
    n++;
  }
  return n;
}

// How many xp orbs are on (or nearly on) the seabed — the crab-spawn system's
// trigger signal.
//
// `height` is how far above bounds.bottom still counts, and the caller passes
// crabSpawn.summonHeight rather than floorHeight: the crabs walk in from off
// the side of the arena, so counting only what has already landed spends the
// whole walk with the pile sitting there untouched. Defaults to floorHeight so
// a caller that means "settled" gets settled.
export function countFloorPickups(height = CONFIG.crabSpawn.floorHeight) {
  const floorY = bounds.bottom + height;
  let n = 0;
  for (const p of pickups) if (p.mesh.position.y <= floorY) n++;
  return n;
}

// Mean x of the chum within `height` of the seabed, or null if there is none.
//
// Which edge a summoned wave walks on from is decided by where the food is,
// and the summon now fires while the pile is still falling — but bestChumTarget
// below only sees orbs that have LANDED (it reads `onFloor`), so on its own it
// answers "nowhere" for exactly the pile that just called the wave, and the
// crabs pick their side on a coin flip. The mean is enough for a left/right
// decision and costs one pass.
export function arrivingChumX(height = CONFIG.crabSpawn.floorHeight) {
  const floorY = bounds.bottom + height;
  let sum = 0;
  let n = 0;
  for (const p of pickups) {
    if (p.mesh.position.y > floorY) continue;
    sum += p.mesh.position.x;
    n++;
  }
  return n ? sum / n : null;
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
    // Already claimed by the seal's magnet. The floor test used to be the
    // whole of that rule — an orb on its way up is off the floor within a
    // frame or two — but a claim made while the orb is still resting on the
    // seabed is a claim, and sending a crab after food that is leaving is how
    // a crab ends up walking to nothing.
    if (p.magnetLatch) continue;
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
    // Spoken for — same rule as nearestFloorPickup above.
    if (p.magnetLatch) continue;
    const dx = p.mesh.position.x - x;
    const dy = p.mesh.position.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 > maxD2) continue;
    const score = (p.pileSize ?? 1) / (1 + Math.sqrt(d2) / Math.max(0.01, distanceBias));
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

/**
 * The nearest bite to (x, y), as a plain { x, y } or null — what the first-run
 * arrow points at (see ui/callout.js).
 *
 * NOT bestChumTarget above, which is a crab's question and answers it with the
 * biggest PILE. A player being shown chum for the first time wants the closest
 * one thing, because the point of the arrow is "there, go and eat it" and a
 * heap across the arena is a longer errand than the tip is on screen for.
 *
 * Chunks count and outrank orbs at equal distance: a chunk is the single most
 * valuable thing in the water, and the one worth learning to chase.
 *
 * Returns a copy rather than the pickup itself so a caller cannot hold a
 * reference to an orb that gets eaten a frame later.
 */
export function nearestChum(x, y, maxDist = Infinity) {
  let best = null;
  let bestD2 = maxDist * maxDist;
  const consider = (pos, bias) => {
    const dx = pos.x - x;
    const dy = pos.y - y;
    const d2 = (dx * dx + dy * dy) * bias;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = { x: pos.x, y: pos.y };
    }
  };
  for (const p of pickups) consider(p.mesh.position, 1);
  // 0.25 = a chunk wins from twice as far away as an orb.
  for (const c of chumChunks) consider(c.mesh.position, 0.25);
  return best;
}

// ---------------------------------------------------------------------------
// ASKING ABOUT ONE KIND OF PICKUP AT A TIME
//
// The first-run coach has a tip PER PICKUP TYPE, because they do four
// completely unrelated things — a blue orb is the boost meter, a bubble is air,
// the yellow one is fire rate, a chunk is health — and one sentence covering
// all of them ("that is a power-up") teaches the player nothing they could not
// see. So both questions below take the kind: is there one in the water, and
// where is the nearest.
//
// KEYED BY THE SAME NAME assets.js gives the mesh, which is also the callouts
// row id and the tutorial step id. One name end to end rather than a mapping
// table per hop: the failure a mapping invites is a tip that fires for the
// wrong orb, and that reads as a bug in the pickup rather than in a lookup.
//
// An unknown kind answers "no" and "nowhere" rather than throwing. This is
// reached from a CSV row's arrow column, so the bad input is a typo in a
// spreadsheet — and a first-run tip is not worth taking a run down for.
// ---------------------------------------------------------------------------
function listFor(kind) {
  if (kind === 'strikeOrb') return strikeOrbs;
  if (kind === 'bubbleOrb') return bubbleOrbs;
  if (kind === 'rapidFireOrb') return rapidFireOrbs;
  if (kind === 'levelOrb') return levelOrbs;
  if (kind === 'chumChunk') return chumChunks;
  return null;
}

/** Is there one of `kind` in the water right now? A first-run tip's cue. */
export function pickupTypeInWater(kind) {
  return (listFor(kind)?.length ?? 0) > 0;
}

/**
 * The nearest pickup of `kind`, as a plain { x, y } or null — what the arrow
 * under a pickup tip points at.
 *
 * Deliberately NOT nearestChum with a filter. Chum outnumbers these by roughly
 * a hundred to one, so an arrow that could fall back to it would point at a
 * chum orb under a line about power-ups nearly every time it mattered, and
 * would look right in almost every screenshot.
 *
 * A copy, for the same reason nearestChum returns one: the orb it describes can
 * be swallowed a frame later.
 */
export function nearestPickup(x, y, kind, maxDist = Infinity) {
  const list = listFor(kind);
  if (!list) return null;
  let best = null;
  let bestD2 = maxDist * maxDist;
  for (const o of list) {
    const dx = o.mesh.position.x - x;
    const dy = o.mesh.position.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = { x: o.mesh.position.x, y: o.mesh.position.y };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// ONE SPECIFIC ORB, HELD ACROSS FRAMES
//
// The first-run coach now stands its tip BESIDE the thing it is about and keeps
// it there until that thing is gone, which is a different question from the two
// above: not "where is the nearest bubble" but "is THIS bubble still here".
// nearestPickup deliberately returns a copy of a position, and a copy cannot
// answer that — the tip would silently re-target to the next bubble along and
// then to the one after, and would never end.
//
// So these two hand out the entry itself and take it back. Both are keyed by
// the same `kind` string as everything else on this path (see listFor), and
// both answer harmlessly for a kind this module has never owned — the attractor
// belongs to systems/boats.js, and main.js is the one place that has both.
// ---------------------------------------------------------------------------

/** The nearest pickup of `kind` as the LIVE entry, for something that will hold it. */
export function pickupEntry(kind, x, y, maxDist = Infinity) {
  const list = listFor(kind);
  if (!list) return null;
  let best = null;
  let bestD2 = maxDist * maxDist;
  for (const o of list) {
    const dx = o.mesh.position.x - x;
    const dy = o.mesh.position.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = o; }
  }
  return best;
}

/** Is that exact entry still in the water? */
export function pickupEntryAlive(kind, entry) {
  const list = listFor(kind);
  return !!entry && !!list && list.indexOf(entry) !== -1;
}

/**
 * The nearest bite as the live entry — a chum orb or a chunk, whichever is
 * nearer under the same bias nearestChum uses.
 *
 * Returns which array it came from as well, because the two are separate lists
 * and "is it still there" has to ask the right one.
 */
export function chumEntry(x, y) {
  let best = null;
  let bestD2 = Infinity;
  const consider = (entry, list, bias) => {
    const dx = entry.mesh.position.x - x;
    const dy = entry.mesh.position.y - y;
    const d2 = (dx * dx + dy * dy) * bias;
    if (d2 < bestD2) { bestD2 = d2; best = { entry, list }; }
  };
  for (const p of pickups) consider(p, pickups, 1);
  // 0.25 = a chunk wins from twice as far away as an orb, exactly as in
  // nearestChum. The same number twice is on purpose and would be worth
  // sharing if a third caller ever wanted it; two is not yet a rule.
  for (const c of chumChunks) consider(c, chumChunks, 0.25);
  return best;
}

/** Still in play? For a handle from chumEntry, which carries its own list. */
export function chumEntryAlive(handle) {
  return !!handle?.list && handle.list.indexOf(handle.entry) !== -1;
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
  // SPOKEN FOR. An orb the player's magnet has claimed is on its way to the
  // seal and cannot be eaten out from under them — the same precedence the
  // magnet branch in updatePickups already uses when it outranks `hoover`,
  // carried through to the part that actually consumes the orb. Without it an
  // animal chewing fast enough deletes food mid-flight, which is the one way
  // left for a claimed orb to fail to arrive. The animal keeps mouthing at it
  // until the seal takes it, which is a fraction of a second at magnet speed.
  if (p.magnetLatch) return false;
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
