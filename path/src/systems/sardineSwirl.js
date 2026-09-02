import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createVisual, getAssetSizeMultiplier } from '../assets.js';
import { removeEnemy } from '../entities/enemies.js';
import { attractorDeriv, stepAttractor } from './attractors.js';
import { sardineSwirlLevelStats } from '../levelStats.js';
import { hitCreature } from './hitShape.js';
import { attachDamageGlow, stoke, cool, glowLevel } from './damageGlow.js';
import { startJetBed, releaseJetBed } from './jetBed.js';

// ===========================================================================
// SARDINE SWIRL — the echo storm, owned by the player.
// ===========================================================================
// systems/attractorStorm.js's `echo` study is a boss attack: a Lorenz field
// anchored on the animal, firing bullets that arrive in PAIRS seeded a hair
// apart, travel as one thing for a few seconds and then end up on opposite
// wings. Same equations here, same paired seeding, same clamp — see
// systems/attractors.js, which is where the three systems live precisely so
// that a second caller is the equations again and not a second Lorenz.
//
// Three things make this an ability rather than a hazard, and each of them is
// a deliberate departure from what the storm does:
//
//   THE FIELD RIDES THE SEAL. The anchor is the player's position every frame,
//   so what the player steers is not the school but where the school IS. That
//   is the only thing that makes a chaotic field playable from the inside: you
//   cannot aim it, you can only put it over something.
//
//   THE BODIES PERSIST. A storm's cubes are shots — born, spent, culled by a
//   life clock. These are a school. A sardine that leaves the attractor's
//   basin is RESEEDED rather than retired, so the count on the card is the
//   count in the water at every moment of the run, and a swirl that had been
//   running for four minutes is the same swirl as one that just opened.
//
//   IT BITES ON CONTACT, per sardine per creature, on the shrimp ring's own
//   cooldown. This is not a detail: the ability has bodies passing through
//   fish for the whole run, so a field that hit every frame would be the
//   highest DPS in the game by two orders of magnitude, and one that despawned
//   on contact would empty itself into the first school it crossed.
//
// WHY THESE ARE MESHES AND NOT PROJECTILES. The storm's cubes go through
// spawnProjectile because they are enemy BULLETS and the projectile list is
// already exactly that — one i-frame rule, one arena cull, one death-of-the-run
// cleanup. None of that is what a persistent orbiting body wants: it must not
// expire, must not be culled at the arena edge, and must not be consumed by the
// thing it touches. systems/shrimpRing.js is the shape this actually is, so
// this file is that file with a strange attractor where the circle was.
// ===========================================================================

/** What this system builds. Named so systems/levelUpWarmup.js can pay for the
 *  upload while the cards are up rather than on the frame the run comes back —
 *  see the same list in systems/shrimpRing.js for why it lives here and not in
 *  the warm-up. */
export const SARDINE_SWIRL_ASSETS = ['sardineBlade'];

// See the note on combat.js's `contact` — shared, and read before the next test
// can overwrite it.
const swirlContact = { x: 0, y: 0, nx: 0, ny: 0, depth: 0, sphere: null, index: -1 };

// Scratch for the integrator, module level for the usual reason: this runs per
// sardine per substep.
const _deriv = { x: 0, y: 0, z: 0 };

// THE FIELD, and none of it is a setting.
//
// `lorenz` on the `xz` plane with the picture pulled down by 25 is the echo
// row in attractorStorms.csv, and its notes say why: Lorenz's attractor lives
// around z 25, so taking that off the projection is what puts the butterfly on
// the seal instead of far above it. These are not balance choices, they are
// which picture this is — a swirl on a different attractor would be a different
// ability with the same name.
const SHAPE = 'lorenz';
const CENTRE = 25;

// ...AND THE PARAMS, which are canonical Lorenz with the RECENTRING TURNED OFF.
//
// systems/attractors.js defaults Lorenz to `lift: 25` so a caller that wants
// the shape sitting on the origin gets it for free. Every storm pins that to 0
// instead and shifts the PICTURE by `centre`, and this does the same — not for
// the storm's reason (its scaffold is a promise about where cubes will go) but
// because the seed below is the storm's seed, and a seed written for canonical
// z ≈ 25 handed to a field already recentred puts every body on the repelling
// fixed point. The two have to agree, and nothing but this pairing says so.
const PARAMS = { lift: 0 };

// THE ATTRACTOR'S OWN WIDTH, in attractor units — its x extent, measured by
// integrating it for three minutes of field time and taking the range (-19.05
// to 18.19). This is what turns CONFIG.sardineSwirl.span, which is a distance a
// person can picture, into the projection multiplier the field is actually
// drawn at. Measured rather than guessed because the whole point of authoring
// the span is that the number means something: a wrong constant here makes
// every "how wide is the school" reading on the card a lie by a fixed factor,
// and there is nothing on screen that would say so.
const LORENZ_WIDTH = 37.24;

// Integration substeps a frame. The storm's number for Lorenz, and it is a
// quality knob rather than a balance one: the wing rims run fast enough that a
// coarse step throws a body off the attractor entirely and the shape stops
// being the shape.
const SUBSTEPS = 6;

// How far a state may get before it is written off and reseeded. Lorenz has a
// cubic term, so a state that leaves the basin does not wander, it diverges.
const DOMAIN = 90;

// A wing, one side or the other. A body seeded near the origin sits on the
// repelling fixed point and takes seconds to fall onto the shape — which on a
// persistent school would read as sardines that briefly stop existing.
function seed(rand = Math.random) {
  const lobe = rand() < 0.5 ? -1 : 1;
  return {
    x: lobe * (4 + rand() * 7),
    y: lobe * (4 + rand() * 7),
    z: 18 + rand() * 16,
  };
}

// One entry per sardine:
// { mesh, state, roll, cooldowns: Map<enemy, secondsLeft>, heat, glow }
//
// `heat` and `glow` are this body's own, exactly as the shrimp ring's are: the
// one that connected is the only one with anything to say, and a school-wide
// flare would be the least informative version of the same light.
let instances = [];
let group = null;
// The key the sound bed is held by. An object rather than a string so it cannot
// collide with the jet's, which holds itself by its own jet object.
const bedKey = {};
let bedOpen = false;

export function createSardineSwirlVisual() {
  group = new THREE.Group();
  return group;
}

/** The art multiplier from assets.csv — the only place a spawn size lives. */
export function sardineSize() {
  return getAssetSizeMultiplier(SARDINE_SWIRL_ASSETS[0]) || 1;
}

/**
 * One sardine's collision radius, in world units.
 *
 * `CONFIG.sardineSwirl.radius` is the reach of a body drawn at size 1, so this
 * is the same PROPORTION of the shell whatever the art is scaled to — the same
 * construction razorClamRadius uses, and for the reason that one documents: a
 * body drawn at four times its stated reach is an ability that visibly passes
 * through fish, and nothing reports it.
 */
export function sardineReach() {
  return (CONFIG.sardineSwirl?.radius ?? 0.26) * sardineSize();
}

/**
 * How fast one sardine whips about its own long axis, radians a second.
 *
 * SIGNED PER BODY, the razor clam's trick and for the same reason — a school
 * where every shell rolls the same way reads as one rigid object being turned,
 * and every chrome flash in it lands on the same frame.
 */
export function sardineRoll(rand = Math.random) {
  const c = CONFIG.sardineSwirl ?? {};
  const base = c.roll ?? 0;
  const vary = c.rollJitter ?? 0;
  return base * (1 + (rand() * 2 - 1) * vary) * (rand() < 0.5 ? -1 : 1);
}

// PAIRS, and this is the mechanic rather than a spawning detail. The second of
// a pair is seeded `separation` off the first, which at the swirl's scale is
// under a hundredth of a world unit: the two read as ONE sardine for their
// first few seconds together and are on opposite wings by the end of it. A body
// added alone has nothing to diverge from and the card's whole promise is gone.
function addPair(rand = Math.random) {
  const c = CONFIG.sardineSwirl ?? {};
  const sep = c.separation ?? 0.03;
  const st = seed(rand);
  addOne(st, rand);
  addOne({ x: st.x + sep, y: st.y, z: st.z }, rand);
}

function addOne(state, rand = Math.random) {
  const mesh = createVisual(SARDINE_SWIRL_ASSETS[0]);
  group.add(mesh);
  instances.push({
    mesh,
    state,
    roll: sardineRoll(rand),
    cooldowns: new Map(),
    heat: 0,
    // Its own materials, so the body that bit can light up without lighting the
    // other eleven. Null on a build where the primitive stand-in has nothing to
    // brighten — every call below is optional-chained for exactly that.
    glow: attachDamageGlow(mesh),
  });
}

function removeOne() {
  const inst = instances.pop();
  if (!inst) return;
  inst.glow?.release();
  group?.remove(inst.mesh);
}

// WHOLE PAIRS ONLY, in both directions. A school trimmed to an odd number would
// leave one body with no twin, which is a sardine on a trajectory that never
// splits — invisible as a bug and the exact thing this ability is.
function syncCount(pairs) {
  const want = Math.max(0, Math.floor(pairs)) * 2;
  while (instances.length < want) addPair();
  while (instances.length > want) removeOne();
}

// One body's frame through the field.
//
// THE CLAMP SHORTENS THE INTEGRATION STEP, not the move — the storm's rule, and
// the reason it matters is the same here: Lorenz runs about forty times faster
// at a wing rim than at the saddle, and clamping the MOVE would take a body off
// the trajectory it is meant to be on. `speedCap` is world units a second, so
// dividing by the projection scale turns it into attractor units.
//
// Returns false when the state has diverged or left the basin, which the caller
// answers by reseeding rather than by deleting: the school is the ability.
function advance(inst, dt, rate, capPerSub) {
  const st = inst.state;
  const h = (rate * dt) / SUBSTEPS;
  for (let i = 0; i < SUBSTEPS; i++) {
    attractorDeriv(SHAPE, st.x, st.y, st.z, PARAMS, _deriv);
    const m = Math.hypot(_deriv.x, _deriv.y, _deriv.z);
    // A zero derivative is a fixed point: a body is allowed to sit on one, and
    // dividing by it is the one thing that would put a NaN in the list.
    const hEff = m > 1e-6 ? Math.min(h, capPerSub / m) : h;
    if (!stepAttractor(SHAPE, st, hEff, PARAMS)) return false;
  }
  return Math.hypot(st.x, st.y, st.z) <= DOMAIN;
}

/**
 * Drive the school.
 *
 * hooks: { onEnemyDamaged(e, dmg, x, y, ...), onEnemyKilled(e), onContact(x, y) }
 * onContact is per sardine per creature, gated by that body's own cooldown — a
 * school crossing a shoal can fire several on one frame, which is what the
 * event's `sfxMinGap` is sized for.
 */
export function updateSardineSwirl(dt, scene, playerPos, level, stats, enemiesList, hooks = {}) {
  if (!group) return;
  const c = CONFIG.sardineSwirl ?? {};
  const per = sardineSwirlLevelStats(level, stats);
  syncCount(level > 0 ? per.sardinePairs : 0);

  // THE BED, opened when there is a school and released when there is not. Held
  // by this module rather than started per frame at the call site for the
  // reason startJetBed's own doc gives: re-triggering a sustained voice sixty
  // times a second is sixty attacks and no hold at all. The menu gate is
  // main.js's (setJetBedsMuted), shared with the jet, so a swirl running under
  // the level-up cards goes quiet without being torn down.
  if (instances.length && !bedOpen) bedOpen = startJetBed(bedKey, c.bed);
  else if (!instances.length && bedOpen) { releaseJetBed(bedKey); bedOpen = false; }
  if (!instances.length) return;

  // THE ANCHOR IS THE SEAL, every frame. A field that stayed where the player
  // used to be is not their ability, it is a thing that happened near them.
  group.position.x = playerPos.x;
  group.position.y = playerPos.y;

  // The projection, back down from the distance the card quotes. See
  // LORENZ_WIDTH — this division is the only place the two representations
  // meet, so the tip and the field cannot disagree about how big the swirl is.
  const scale = per.sardineSpan / LORENZ_WIDTH;
  const rate = c.rate ?? 1.08;
  const capPerSub = ((c.speedCap ?? 26) / Math.max(1e-4, scale)) * dt / SUBSTEPS;
  const size = sardineSize();
  const reach = sardineReach();
  const cooldown = c.contactCooldown ?? 0.4;
  const pop = c.hitPop ?? 0.3;

  for (const inst of instances) {
    // A body that diverged is put back on a wing rather than removed. It keeps
    // its mesh, its glow and its cooldown map, so nothing about the school's
    // size or its heat flickers on the frame one of them wraps.
    if (!advance(inst, dt, rate, capPerSub)) inst.state = seed();

    const st = inst.state;
    inst.mesh.position.set(st.x * scale, (st.z - CENTRE) * scale, -0.05);
    // Nosed along the flow. The body is built long on +Y (art forward
    // everywhere in assets.js), so a sardine whose heading is not written flies
    // broadside and the school reads as a drift of floating tiles.
    attractorDeriv(SHAPE, st.x, st.y, st.z, PARAMS, _deriv);
    const vx = _deriv.x;
    const vy = _deriv.z;
    if (vx * vx + vy * vy > 1e-9) inst.mesh.rotation.z = Math.atan2(vy, vx) - Math.PI / 2;
    // THE WHIP, about the body's own long axis. Not `rotation.z` — that is the
    // angle above, and the second one to run would win. This is what makes the
    // chrome: CONFIG.chromeBlade is a view-space horizon with one tight key
    // lobe, an environment a body has to TURN THROUGH before it shows anything.
    inst.mesh.rotation.y += inst.roll * dt;

    // HOT WHILE IT IS BITING — stoked on contact below, carried to now and
    // spent here on the model's own glow and on a scale punch. The punch is the
    // per-instance channel a hit on a creature uses, and it is the half of the
    // read that survives a screenshot.
    inst.heat = cool(inst.heat, 'sardineSwirl', dt);
    const heat = glowLevel(inst.heat, 'sardineSwirl');
    inst.glow?.set(heat, 'sardineSwirl');
    // Against the ASSET's own multiplier rather than setScalar(1) — the root's
    // scale is the assets.csv size and nothing else (the model's fit lives
    // further down the graph), so writing a bare number here would silently
    // throw away the one place a spawn size is allowed to live.
    inst.mesh.scale.setScalar(size * (1 + pop * heat));

    for (const [enemy, t] of inst.cooldowns) {
      const left = t - dt;
      if (left <= 0) inst.cooldowns.delete(enemy);
      else inst.cooldowns.set(enemy, left);
    }

    const worldX = group.position.x + inst.mesh.position.x;
    const worldY = group.position.y + inst.mesh.position.y;

    for (let i = enemiesList.length - 1; i >= 0; i--) {
      // Shrink-safe: a kill inside this loop can take several creatures out of
      // the list at once. See the note in systems/club.js.
      const e = enemiesList[i];
      if (!e) continue;
      if (inst.cooldowns.has(e)) continue;
      // Against the measured body where there is one, so a sardine crossing a
      // boss's flank connects with the flank and not with a circle drawn round
      // its middle. See systems/hitShape.js.
      if (!hitCreature(e, worldX, worldY, reach, swirlContact)) continue;

      // Read once, so the hit and the number reported to the feedback layer
      // cannot disagree about how hard the sardine hit.
      const dmg = per.sardineDamage;
      e.hp -= dmg;
      e.flash = CONFIG.fx.hitFlash;
      e.hitThisFrame = true;
      inst.cooldowns.set(e, cooldown);
      inst.heat = stoke(inst.heat, 'sardineSwirl');
      hooks.onEnemyDamaged?.(e, dmg, swirlContact.x, swirlContact.y, null, null, swirlContact);
      // At the sardine rather than at the creature: the school is the read, and
      // where on the field a contact happened is the information.
      hooks.onContact?.(worldX, worldY);
      if (e.hp <= 0) {
        hooks.onEnemyKilled?.(e);
        removeEnemy(scene, i);
      }
    }
  }
}

/** How many bodies are in the water. For the harness and the debug panel. */
export function sardineCount() {
  return instances.length;
}

/** Whether the bed is being held open. Same two readers. */
export function sardineBedOpen() {
  return bedOpen;
}

export function resetSardineSwirl() {
  for (const inst of instances) {
    inst.glow?.release();
    group?.remove(inst.mesh);
  }
  instances = [];
  // A LOOPING VOICE OUTLIVES A RUN unless something lets it go — the failure
  // this file could most easily ship, because it is silent in every screenshot
  // and deafening in the menu.
  if (bedOpen) { releaseJetBed(bedKey); bedOpen = false; }
}
