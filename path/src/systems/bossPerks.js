import * as THREE from 'three';
import { CONFIG } from '../config.js';
import {
  makeOrganicRing, placeOrganicRing, updateOrganicRing, disposeOrganicRing,
  isOrganicRing,
} from './organicRing.js';
import { spawnBeam } from './beams.js';
import { spawnProjectile, projectiles } from '../entities/projectiles.js';
import { enemies, spawnNamed } from '../entities/enemies.js';
import { emit } from '../entities/particles.js';
import { isDazed } from './control.js';
import { applyBossLook, clearBossLook, bossSparkColor } from './bossLook.js';

// ===========================================================================
// BOSS PERKS — the one special thing a boss can do.
// ===========================================================================
// bossPerks.csv decides WHICH perks exist and what their numbers are;
// bossPerkTable.js rolls one onto each boss after the first; this file is the
// only thing that makes one happen. Four of them, and they are deliberately
// four different ANSWERS to the same player behaviour rather than four damage
// numbers — the player's whole toolkit against a boss is distance, and each
// perk takes a different bite out of it:
//
//   lunge      closes distance on a tell   — punishes not watching
//   electric   makes close distance cost    — punishes standing on it
//   teleport   refuses to let you keep it   — punishes pure kiting
//   phase      takes away the information   — punishes tracking by sight
//
// Seven more, in three groups, and the groups are the point. Distance was the
// only axis the first four moved along, which meant every fight was the same
// conversation at a different volume.
//
//   THE BODY — nothing to react to, everything to plan around. `giant` and
//   `swift` fire no ability and have no tell: they change what the animal IS,
//   and the player finds out by trying to swim past it. A perk with no timing
//   in it is a deliberate rest in the rotation — not every boss should be a
//   thing you are waiting for.
//
//   REACH — `eyebeam`, `barrels`, `spitfish`, `finfish`. The first four perks
//   all assumed the boss had to come to you, so the correct play against every
//   one of them was the same: be somewhere else. These answer back across the
//   gap, and each does it with a different projectile — a beam you dodge by
//   not being on the line, barrels you dodge by not being where they land,
//   fish you dodge by moving at all, and a fin volley you cannot dodge in one
//   direction because it comes in a fan.
//
//   COMPANY — `turtles`. The only one that adds bodies. A screen of sea
//   turtles between you and the boss, and turtles cannot be killed (hp 1e9 in
//   enemies.csv, which is a decision that long predates this) — so they are
//   not a health bar in front of a health bar, they are a WALL, and the answer
//   is to move until you have a clean line rather than to shoot through it.
//
// WHY THE SHOOTERS SHARE ONE FUNCTION. All four are the same state machine —
// cooldown, a windup you can read, a volley — differing only in where the shot
// leaves the body and what it is. Four copies of that machine would be four
// places for the windup to drift out of agreement with the tell that sells it.
// See fireVolley.
//
// ONE AT A TIME, ALWAYS. There is exactly one boss and it has exactly one
// perk, so this module holds one instance of state rather than a map keyed by
// enemy. That is not a shortcut: a Map keyed on a creature leaks every corpse
// until the run ends (the same reason elements.js keeps its status on the
// enemy), and there is no second boss to key it for.
//
// HOW A PERK MOVES THE BOSS. It doesn't, directly. Behaviours in
// entities/enemies.js own `e.vx`/`e.vy` and the integrator steps the position
// from them, so a perk that wrote a position would be fighting the steering
// every frame and losing half of them. Instead the boss raises `e.perkDrive`,
// which makes updateEnemies skip its behaviour entirely for that frame — the
// same door `e.leaving` already goes through — and this file writes the
// velocity the integrator then uses. Teleport is the one exception, because a
// blink is a position and not a velocity.
//
// WHY THE VFX ARE BUILT HERE AND NOT PULLED FROM THE ASSET POOL. Model clones
// share their materials by reference (see createVisual), so anything that
// fades, tints or hides a pooled visual does it to every creature using that
// model — including the player's own orca pod, which uses the same body as the
// orca boss. Everything below owns its own materials outright.
// ===========================================================================

// One live perk, or null. `phase` here is the state machine's phase, not the
// perk named `phase` — the perk id lives in `.id`.
let active = null;

// The boss's own contact damage, saved before the lunge multiplies it so it
// can be put back exactly. Saved rather than recomputed because spawnOne rolls
// it against difficulty at spawn time and the def no longer knows the answer.
let baseContactDamage = 0;

// Everything this module has put in the scene, so a reset can take it all out
// without each effect having to be remembered separately.
const owned = [];

function track(scene, obj) {
  scene.add(obj);
  owned.push(obj);
  return obj;
}

// A tell. `inner` and `outer` are fractions of 1, scaled to world units by the
// caller — every effect here is sized off the boss's radius, which changes with
// sizeMul and with the size roll, so nothing is measured in hand-typed world
// units.
//
// These are the shared organic ring (systems/organicRing.js) now, not
// RingGeometry: same sizes, same placement, but the edge is broken up by the
// world noise field and the ring arrives and leaves through a sweep rather than
// an opacity ramp. `type` names an entry in CONFIG.fx.attackTypes and decides
// both the colour and the edge dialect — which is why `color` is still taken
// separately, for the two callers that hold a colour from a pattern row rather
// than a threat type.
//
// The half-width conversion is exact rather than approximate: a RingGeometry
// spanning inner..1 has its centre at (1+inner)/2, and the shader centres its
// band at 1 - thickness, so thickness = (1 - inner)/2 puts the band in the same
// place. `outer` is 1 at every call site here — the outer edge of a tell IS the
// reach it is telling you about — and is asserted rather than handled, because
// an outer under 1 would silently move the boundary the player is reading.
function makeRing(color, inner = 0.82, outer = 1, segments = 64, type = null) {
  const thickness = (outer - inner) / 2;
  const mesh = makeOrganicRing({
    type: type ?? 'kinetic',
    // A named type carries its own colour from the shared palette; an explicit
    // one wins, for the boat patterns that pick their own.
    color: type && color == null ? null : color,
    thickness,
    renderOrder: 5,
  });
  mesh.visible = false;
  return mesh;
}

// WHICH THREAT THIS TELL IS ANNOUNCING. The perk row's `attack` column decides
// it, and when the cell is filled the shared palette (CONFIG.fx.attackTypes)
// owns both the colour and the edge dialect — an electric boss's ring is the
// same cyan as the player's Voltaic shots because both read one number, and it
// crackles because the palette says electric edges crackle.
//
// An EMPTY cell falls back to the colour that perk has always had in
// CONFIG.boss.perkFx, with the plain dialect. That is the escape hatch rather
// than an oversight: a tell whose colour was deliberately tuned away from its
// type can keep it by clearing the column, and the fallback is what every perk
// looked like before the palette existed.
function tellRing(scene, perk, legacyColor, inner, outer, segments, fallbackType) {
  const atk = perk?.attack;
  return track(scene, makeRing(atk ? null : legacyColor, inner, outer, segments,
    atk || fallbackType));
}

function disposeObj(obj) {
  // The organic rings share one quad between every ring in the game, so the
  // generic path below would free it out from under the others. See the note on
  // `userData.organicRing`.
  if (isOrganicRing(obj)) { disposeOrganicRing(obj); return; }
  obj.parent?.remove(obj);
  obj.geometry?.dispose();
  const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
  for (const m of mats) m?.dispose?.();
}

/** Put everything back. Called on run reset and whenever a boss leaves. */
export function resetBossPerks() {
  releaseBoss();
  for (const obj of owned) disposeObj(obj);
  owned.length = 0;
  // The rings were just disposed, so the list has to go with them or
  // updateBlasts would keep scaling a material that no longer exists.
  blasts.length = 0;
  // Fuses die with the fight. The barrels themselves are projectiles and are
  // cleared by resetProjectiles; dropping the watch list here is what stops a
  // fuse from a dead boss going off under the next one.
  ordnance.length = 0;
  active = null;
}

// Undo everything a perk did TO THE CREATURE, as opposed to what it put on
// screen. Every field written below is written back, and that list is the
// contract: a boss that dies mid-lunge must not leave a corpse-shaped hole in
// the next boss's contact damage, and `perkDrive` left raised on a creature
// that survives (the boss toggle being switched off mid-fight, say) is an
// animal that never steers again.
function releaseBoss() {
  // THE ESCORTS GO FIRST, and they are released even if the boss itself is
  // already gone — `active.enemy` is null the moment a boss dies mid-fight,
  // and turtles left holding `perkDrive` would be three animals frozen in the
  // water for the rest of the run with nothing left alive to drive them.
  for (const t of active?.escorts ?? []) {
    t.perkDrive = false;
    // Sent home rather than deleted: the same exit the clear-out uses, so they
    // swim off under their own power and no one is credited with a kill.
    t.leaving = true;
  }
  if (active?.escorts) active.escorts.length = 0;

  // The paint comes off FIRST, and unconditionally — before the `!e` bail
  // below, because a boss that died mid-fight has already had `active.enemy`
  // nulled and its body is on its way back to the pool still wearing the look.
  // See the note at the top of systems/bossLook.js: nothing else takes it off.
  clearBossLook();

  const e = active?.enemy;
  if (!e) return;
  e.perkDrive = false;
  e.invuln = 0;
  if (baseContactDamage > 0) e.contactDamage = baseContactDamage;
  e.ramming = false;
  if (e.visual) e.visual.visible = true;
  baseContactDamage = 0;
}

// The size step, for `giant`. A deliberate twin of applyBossScale in
// systems/boss.js rather than a call to it: that module imports this one, and
// the four lines are not worth a circular import to share. Both must move
// together if the set of fields that mean "how big is this creature" ever
// changes — the visual, the hitbox, and the two numbers physics and feedback
// read for mass.
//
// multiplyScalar, never setScalar: the scale already on the visual is the
// model's own fit times the tuner's Size slider, and setting it would silently
// drop both. Safe against the visual POOL — resetVisual restores every node's
// birth transform when the body is handed back, so a giant boss cannot leave a
// half-size-again shark in the pool for the next spawn.
function applyPerkScale(e, mul) {
  if (!e || !(mul > 0) || mul === 1) return;
  e.visual.scale.multiplyScalar(mul);
  e.spawnScale *= mul;
  e.sizeMul *= mul;
  e.radius *= mul;
}

/**
 * Give this boss its perk. `perk` is a row from bossPerks.csv, or null for the
 * first boss of the run, which has none.
 */
export function attachBossPerk(scene, enemy, perk) {
  resetBossPerks();
  if (!enemy || !perk || !scene) return null;

  baseContactDamage = enemy.contactDamage ?? enemy.def?.contactDamage ?? 0;
  active = {
    id: perk.id,
    perk,
    enemy,
    // Every perk starts on cooldown rather than firing on arrival. The player
    // has just watched a two-second entrance and is reading a name; a lunge on
    // the first frame of control is a hit they were given no chance to avoid.
    timer: perk.cooldown ?? 0,
    stage: 'ready',
    dirX: 0,
    dirY: 0,
    flicker: 0,
    clock: 0,
    // Live sea turtles, for `turtles`. Held here rather than found by scanning
    // the roster for turtles: the water can contain turtles this perk did not
    // put there (they are an ordinary spawn), and driving those would be
    // taking someone else's animal.
    escorts: [],
    // Whose turn it is to fire, for the perks with more than one origin — see
    // fireVolley. Kept on the perk rather than derived from the clock so a
    // volley always alternates evenly however the cooldown is tuned.
    muzzle: 0,
    // Fractional lobes of aura fill owed from the last frame, so a rate below
    // one per frame still averages out instead of being rounded to nothing.
    fillCarry: 0,
  };

  const fx = CONFIG.boss?.perkFx ?? {};

  // THE BODY WEARS THE PERK. Stamped before anything is drawn, so the animal
  // that finishes rising out of the dark is already the colour of what it
  // does — the arrival is the one moment the player looks at the boss and
  // nothing else, and it is wasted on a grey shark whose name says otherwise.
  // A no-op for a perk with no row in bossLooks.csv. See systems/bossLook.js.
  applyBossLook(enemy, perk);

  // THE BODY PERKS ARE APPLIED HERE AND NEVER TICK AGAIN. There is no state
  // machine, no cooldown and nothing to draw: the boss is simply bigger, or
  // simply faster, from the frame it arrives. attachBossPerk runs after
  // applyBossScale in systems/boss.js, so `giant` compounds with the
  // archetype's own sizeMul rather than replacing it — which is what makes a
  // giant orca (1.7 x 1.5) read as a different order of animal from a giant
  // shark (1.6 x 1.5).
  if (perk.id === 'giant') {
    applyPerkScale(enemy, perk.mul ?? 1.5);
  } else if (perk.id === 'swift') {
    const mul = perk.mul ?? 1.35;
    enemy.speed *= mul;
    // The turn rate too, and this is the half that matters. A boss that
    // sprints but corners like a barge is EASIER — you beat it by turning
    // inside it, which is what the player is already doing. Per-instance
    // (`e.turnRate` is baked at spawn); `e.def.turnRate` is shared by every
    // creature of the species and must never be written.
    if (enemy.turnRate) enemy.turnRate *= mul;
  } else if (perk.id === 'lunge') {
    active.flare = tellRing(scene, perk, fx.lunge?.flareColor ?? 0xffe07a, 0.7, 1, 64, 'kinetic');
  } else if (perk.id === 'electric') {
    active.ring = tellRing(scene, perk, fx.electric?.color ?? 0x8fe6ff, 0.9, 1, 96, 'electric');
    active.ring.visible = true;
    // The arcs: one LineSegments whose vertices are rewritten every frame.
    // A pool of meshes would be the obvious shape and is strictly worse —
    // every arc lives for a twelfth of a second, and a single buffer draws all
    // of them in one call with no allocation.
    //
    // EACH ARC IS A JAGGED SPLINE, not a chord. A straight segment struck
    // across the rim reads as a laser or as a dropped polygon; electricity is
    // recognisable almost entirely by the KINK, and by the kink being
    // different every time it re-strikes. See jagArc for the displacement.
    // The buffer is sized for the segments rather than the arcs, which is the
    // only cost of it: `arcSegments` at 5 is five times the vertices for the
    // same twelve strikes, and still one draw call and still no allocation.
    const arcGeo = new THREE.BufferGeometry();
    active.arcCount = 12;
    active.arcSegs = Math.max(1, Math.round(fx.electric?.arcSegments ?? 5));
    active.arcPositions = new Float32Array(active.arcCount * active.arcSegs * 6);
    active.arcLife = new Float32Array(active.arcCount);
    arcGeo.setAttribute('position', new THREE.BufferAttribute(active.arcPositions, 3));
    const arcMat = new THREE.LineBasicMaterial({
      // THE SPARKS ARE THE RING'S COLOUR. Not a slider of their own and not a
      // constant: bossSparkColor resolves the perk's `attack` type through the
      // same palette the aura ring above was built from, so the boundary and
      // the thing crossing it are one number. bossLooks.csv can override it
      // per perk; nothing else may. (This retires
      // CONFIG.boss.perkFx.electric.coreColor, which was that constant.)
      color: bossSparkColor(perk),
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    active.arcs = track(scene, new THREE.LineSegments(arcGeo, arcMat));
    active.arcs.renderOrder = 6;
    active.arcs.frustumCulled = false; // the vertices move every frame
  } else if (perk.id === 'teleport') {
    active.flashOut = tellRing(scene, perk, fx.teleport?.color ?? 0xc9a2ff, 0.6, 1, 64, 'void');
    active.flashIn = tellRing(scene, perk, fx.teleport?.color ?? 0xc9a2ff, 0.6, 1, 64, 'void');
    active.flashOutLife = 0;
    active.flashInLife = 0;
  } else if (perk.id === 'phase') {
    active.marker = tellRing(scene, perk, fx.phase?.markerColor ?? 0x9fd8ff, 0.72, 1, 64, 'void');
  } else if (GUNS[perk.id]) {
    // THE TELL IS A RING AT THE MUZZLE, not on the body. Where the shot is
    // coming FROM is the information the player needs — eyes and fins are at
    // opposite ends of the animal, and a charge glow on the mass of the boss
    // would tell you a volley is coming without telling you what to swim out
    // of. One ring per origin, sized and placed in updateGun.
    active.charges = [];
    const color = fx[perk.id]?.chargeColor ?? GUNS[perk.id].color;
    for (let i = 0; i < GUNS[perk.id].origins; i++) {
      active.charges.push(tellRing(scene, perk, color, 0.2, 1, 24, GUNS[perk.id].attack ?? 'kinetic'));
    }
  }

  return active;
}

/**
 * Which perk is live, for the HUD and the harness. Null when none.
 *
 * `enemy` is the body it belongs to. Exported because systems/bossEyes.js has
 * to light the eyes of the boss that is winding up and NOT of any other boss
 * on screen — without it, a second body would telegraph an attack it is not
 * making, which is worse than no tell at all.
 */
export function activeBossPerk() {
  return active
    ? { id: active.id, stage: active.stage, timer: active.timer, enemy: active.enemy }
    : null;
}

// The size everything here is drawn against. `e.radius` is the hitbox and is
// exactly what the aura's reach should be measured from — see the note in
// CONFIG.boss.perkFx.electric about art that is smaller than reach.
function place(obj, e, worldRadius) {
  // placeOrganicRing rather than a scale write: the shader's edge amplitude is
  // a WORLD distance divided by the ring's radius, so the scale and `uRadius`
  // are a pair. Setting one without the other leaves the wobble computed
  // against whatever size the ring was last frame, which on a growing tell is
  // an edge that visibly settles a frame late.
  placeOrganicRing(obj, e.mesh.position.x, e.mesh.position.y, worldRadius,
    e.mesh.position.z);
}

// The rings all run one clock, ticked once per frame from updateBossPerks. Held
// here rather than each effect advancing its own uTime, because the effects
// switch on and off through their state machines and a ring whose clock only
// runs while it is visible restarts its crackle every time it reappears.
function tickRings(dt) {
  for (const obj of owned) {
    if (isOrganicRing(obj)) obj.material.uniforms.uTime.value += dt;
  }
}

// Opacity is a uniform now, not a material property. A bare
// `mesh.material.opacity = x` still ASSIGNS on a ShaderMaterial and is silently
// ignored by the program, so every one of those writes goes through here.
function ringAlpha(obj, v) {
  obj.material.uniforms.uOpacity.value = v;
}

// Where the hand is, and how hard the edge is crackling. `inT` draws the ring
// on, `outT` chases it round eating it away, and `charge` escalates the
// dialects that have somewhere to escalate to.
function ringSweep(obj, inT, outT = 0, charge = null) {
  const u = obj.material.uniforms;
  u.uSweepIn.value = Math.min(1, Math.max(0, inT));
  u.uSweepOut.value = Math.min(1, Math.max(0, outT));
  if (charge != null) u.uCharge.value = Math.min(1, Math.max(0, charge));
}

// HOW FAR PAST ITS OWN CENTRE AN AURA LOBE CAN REACH, in world units: half the
// width it draws, plus everything its own motion can add over its whole life.
//
// The aura fill is the one goo in the game placed against a line it must not
// cross, and both halves of that are easy to get wrong in the same way. A goo
// particle draws `size x the group's radius` across, which is several times the
// sprite it would otherwise be — and it then MOVES, so where it is born is not
// where it ends up. The drift is solved with the closed form the vertex shader
// uses (velocity under linear drag, at t = infinity, which is speed/drag) so
// this cannot drift from what is actually drawn.
//
// Read out of config rather than written down, so retuning the emitter or the
// group moves the margin with it instead of quietly invalidating it. The
// LARGEST values the emitter can roll, because the rule has to hold for every
// lobe rather than for the average one.
function auraLobeReach() {
  const def = CONFIG.emitters?.auraField;
  if (!def) return 0;
  const size = Array.isArray(def.size) ? def.size[1] : (def.size ?? 0.5);
  const goo = CONFIG.fx?.goo;
  const half = (goo && goo.enabled !== false)
    ? size * (goo.groups?.[def.goo]?.radius ?? goo.radius ?? 3) * 0.5
    : size * 0.5;
  const speed = Array.isArray(def.speed) ? def.speed[1] : (def.speed ?? 1);
  const drift = speed * (CONFIG.boss?.perkFx?.electric?.fillDrift ?? 1.1)
    / Math.max(0.05, def.drag ?? 3);
  // ...plus what the current can add. The global turbulence pushes every
  // particle by `strength x the emitter's own share x its age`, and the longest
  // life this emitter rolls is the most of it any lobe can collect.
  const tb = CONFIG.fx?.turbulence;
  const life = Array.isArray(def.life) ? def.life[1] : (def.life ?? 1);
  // 1.5 is the field's peak per axis (a sine plus a half-amplitude harmonic),
  // and both axes can peak at once, so the worst-case RADIAL push is that times
  // root two. Over-estimating here costs a few tenths of a unit of unused zone;
  // under-estimating puts goo on the boundary.
  const push = (tb && tb.enabled !== false)
    ? (tb.strength ?? 0) * (def.turbulence ?? 1) * life * 1.5 * Math.SQRT2
    : 0;
  return half + drift + push;
}

// HOW FAR A LOBE FALLS BEHIND A MOVING BOSS over its whole life, in world units.
//
// The ring is drawn on the animal every frame; the field is not, because a
// particle here cannot be parented to anything — its path is a closed form
// solved from where it was born (see entities/particles.js). So a boss that
// swims away from its own aura leaves lobes sitting outside the ring, which is
// the exact failure the inset exists to prevent, arriving half a second late
// and only ever while the boss is moving.
//
// `inherit: 1` on the emitter is most of the answer: each lobe leaves at the
// boss's own velocity and keeps station until drag bleeds that off. This is
// what drag leaves unpaid — the boss's travel over the lobe's life, minus the
// distance the lobe was carried after it, both under the same closed form.
//
// At high speed it can exceed the whole usable radius, and then no lobes are
// emitted at all: a boss sprinting has no field, the same way a hull holding
// station has no keel wake (systems/boatWake.js). Degrading to nothing is
// always available and is never wrong.
function auraLobeLag(speed) {
  const def = CONFIG.emitters?.auraField;
  if (!def || !(speed > 0)) return 0;
  const life = Array.isArray(def.life) ? def.life[1] : (def.life ?? 1);
  const k = Math.max(0.05, def.drag ?? 3);
  const carried = (def.inherit ?? 0) * speed * (1 - Math.exp(-k * life)) / k;
  return Math.max(0, speed * life - carried);
}

/**
 * One tick. Call it AFTER updateBoss and BEFORE updateEnemies — the velocity
 * this writes is what the integrator in updateEnemies steps, so writing it
 * afterwards would have every lunge take effect a frame late and, worse, be
 * overwritten by the boss's own steering before it ever moved anything.
 *
 * `hooks.onPlayerHit(damage, dir, source)` is main.js's, the same one
 * resolveCombat is handed — so a shock from the aura goes through the same
 * i-frames, the same screen shake and the same playtest accounting as a bite.
 */
export function updateBossPerks(dt, scene, playerPos, hooks = {}) {
  // ABOVE THE `active` GATE, and all three of these have to be. Ordnance
  // outlives the perk that threw it and belongs to the boat as much as to a
  // perk, so a frame with no perk on it is still a frame in which barrels are
  // falling and rings are expanding. Wired below the gate, a boat boss that
  // rolled no perk would throw barrels that never went off.
  field.hooks = hooks;
  field.playerPos = playerPos;
  updateOrdnance(dt, scene);
  updateBlasts(dt);
  tickRings(dt);

  if (!active) return;
  const e = active.enemy;

  // The boss left — killed, cleared, or the toggle went off. Nothing here owns
  // the creature's lifetime, so this is the only place that notices.
  if (!e || !e.mesh || e.hp <= 0) { resetBossPerks(); return; }

  active.clock += dt;
  // Everything is drawn and measured against the boss's ACTUAL size, which is
  // its row's radius times the archetype's sizeMul times its own size roll.
  const r = e.radius;

  // Stashed for the effects that go off on their own schedule rather than on
  // this call's stack — a barrel's fuse ends between frames and has to be able
  // to reach the player and the damage hook from there. Refreshed every frame
  // rather than captured at attach: `hooks` is rebuilt by main.js per frame and
  // `playerPos` is a live vector, and holding either from two seconds ago is
  // how a blast lands on where the player used to be.
  active.hooks = hooks;
  active.playerPos = playerPos;

  // Blast rings, ticked above the arrival gate below: a barrel thrown on the
  // last frame before something made the boss invulnerable would otherwise
  // leave its ring frozen at full size on the water. (A boss that DIES takes
  // its blasts with it — the early return above has already run resetBossPerks
  // by then, which disposes every ring this module owns.)
  // A boss still making its entrance is not doing anything yet. The ceremony
  // is a promise that nothing is happening, and a lunge out of it would be the
  // one hit in the run the player genuinely could not have played around.
  if (e.invuln > 0) {
    if (active.ring) active.ring.visible = false;
    // Handed back rather than merely left alone. Not reachable today — the
    // entrance is over before any perk has fired — but a `perkDrive` raised on
    // a creature nothing is driving is an animal that never steers again, and
    // that is too quiet a way to fail to leave to the ordering staying put.
    e.perkDrive = false;
    return;
  }
  if (active.ring) active.ring.visible = true;

  // DAZED. The tell it was building is cancelled and no new one starts while
  // it is reeling — but anything it has already COMMITTED to (a lunge in
  // flight, a blink half-taken, a fade half-finished) runs to the end. That
  // split is the whole rule: a wind-up is a promise the boss has not kept yet,
  // and a committed attack is one it has. Freezing a body mid-tell is what
  // control.js's original refusal existed to prevent, and it would still be
  // wrong if the thing doing the freezing were called a daze.
  if (isDazed(e) && interruptBossPerk(e)) return;
  if (isDazed(e) && active.stage === 'ready') return;

  const dx = playerPos.x - e.mesh.position.x;
  const dy = playerPos.y - e.mesh.position.y;
  const dist = Math.hypot(dx, dy) || 0.0001;

  if (active.id === 'lunge') updateLunge(dt, e, r, dx / dist, dy / dist);
  else if (active.id === 'electric') updateElectric(dt, e, r, playerPos, dist, dx, dy, hooks);
  else if (active.id === 'teleport') updateTeleport(dt, e, r, playerPos);
  else if (active.id === 'phase') updatePhase(dt, e, r);
  else if (active.id === 'turtles') updateTurtles(dt, scene, e, r, playerPos, dx / dist, dy / dist);
  else if (GUNS[active.id]) updateGun(dt, scene, e, r, dist, dx / dist, dy / dist);
  // `giant` and `swift` are absent on purpose — they did everything they do in
  // attachBossPerk and have nothing to tick. A perk that changed the body and
  // then also ran every frame would be two perks.
}

// The stages a perk can be talked out of: the ones where the boss has told you
// what it is about to do and has not done it yet. Everything else — 'dash',
// 'gone', 'fadeIn' — is already spent and plays out.
//
// A SET OF STAGE NAMES, not a per-perk flag, because that is what the state
// machines actually share: four of them independently call their tell 'windup'
// and phase calls its 'fadeOut'. A fifth perk written tomorrow inherits the
// interrupt by naming its tell the same thing everyone else does, and if it
// invents a new name the failure is the safe direction — the tell finishes.
const INTERRUPTIBLE = new Set(['windup', 'fadeOut']);

/**
 * Cancel a tell this boss has not committed to yet, and hand the body back.
 *
 * Returns whether anything was actually cancelled — the caller uses it to
 * decide whether the perk still gets its frame. Everything a wind-up can have
 * done to the creature or to the screen is undone here: the drive, the ring,
 * the flare, the charge halos and the flicker phase's half-hidden body. Missing
 * one of those is not a visual bug, it is a boss stuck invisible or an animal
 * that never steers again — the same contract releaseBoss() keeps.
 *
 * The perk goes back to `ready` on a SHORT timer rather than a full cooldown.
 * The player bought a window, not a denial: it re-telegraphs a beat after the
 * daze lets go, so landing control on a wind-up is worth a reposition and not
 * worth deleting the perk from the fight.
 */
export function interruptBossPerk(e) {
  if (!active || active.enemy !== e) return false;
  if (!INTERRUPTIBLE.has(active.stage)) return false;

  e.perkDrive = false;
  // The lunge multiplies contact damage at the END of its wind-up, so this is
  // belt and braces — but a cancelled perk that left the multiplier standing
  // would be a boss quietly hitting for double for the rest of the fight.
  if (baseContactDamage > 0) e.contactDamage = baseContactDamage;
  e.ramming = false;
  if (e.visual) e.visual.visible = true;
  if (active.flare) active.flare.visible = false;
  if (active.marker) active.marker.visible = false;
  for (const ring of active.charges ?? []) ring.visible = false;
  active.flicker = 0;

  active.stage = 'ready';
  active.timer = Math.max(0.2, (e.dazeTimer ?? 0) + (CONFIG.boss?.control?.daze?.perkRecovery ?? 0.6));
  return true;
}

// ---------------------------------------------------------------------------
// SPEED LUNGE
// ---------------------------------------------------------------------------
// Three stages, and the middle one is the entire perk. `ready` is ordinary
// hunting; `windup` is the boss stopping dead, turning to face you and
// flaring; `dash` is it travelling in a straight line at several times its
// swimming speed, hitting far harder on contact.
//
// THE LINE IS LOCKED AT THE END OF THE WIND-UP, not steered during the dash.
// A homing lunge is unavoidable, and an unavoidable attack on a creature with
// this much health is not a fight, it is a damage race with extra steps. The
// counterplay has to be a real one: read the tell, move sideways, watch three
// tonnes of animal commit to where you were.
function updateLunge(dt, e, r, dirX, dirY) {
  const p = active.perk;
  const fx = CONFIG.boss?.perkFx?.lunge ?? {};
  active.timer -= dt;

  if (active.stage === 'ready') {
    if (active.timer > 0) return;
    active.stage = 'windup';
    active.timer = p.windup ?? 0.7;
    return;
  }

  if (active.stage === 'windup') {
    // Held in place, but NOT frozen: a creeping velocity toward the player is
    // what turns the body to face them, because `faceMotion` reads the
    // direction of travel and a boss with zero velocity keeps whatever heading
    // it happened to have. So the tell includes it visibly aiming — which is
    // the half of the telegraph that says WHERE, not just WHEN.
    e.perkDrive = true;
    e.vx = dirX * 0.6;
    e.vy = dirY * 0.6;

    // The flare grows over the wind-up rather than blinking on, so the tell
    // has a direction in time: it is not "something is happening", it is
    // "something is about to finish happening".
    const t = 1 - Math.max(0, active.timer) / Math.max(0.01, p.windup ?? 0.7);
    active.flare.visible = true;
    place(active.flare, e, r * (fx.flareScale ?? 1.35) * (0.85 + t * 0.5));
    ringAlpha(active.flare, 0.15 + t * 0.75);
    // THE HAND IS THE WIND-UP. The flare is not revealed by a fade; the sweep
    // draws it round the circle over exactly the wind-up, so it closes on the
    // frame the dash launches. That is the whole reason the transition is
    // angular — the player is not being told "soon", they are being shown how
    // much time is left, and there is no second number to keep in step with
    // because it is the same `t` the size and opacity already ride.
    ringSweep(active.flare, t, 0, t);

    if (active.timer <= 0) {
      active.stage = 'dash';
      active.timer = p.duration ?? 0.9;
      active.dirX = dirX;
      active.dirY = dirY;
      // Contact damage is multiplied for the dash only, and restored below.
      // Read off the saved base rather than compounding, so a lunge that was
      // interrupted and re-entered can't stack the multiplier.
      e.contactDamage = baseContactDamage * (p.damage ?? 2);
      // ...and the body counts as the attack while it is doing this — see
      // `ramming` in entities/enemies.js.
      e.ramming = true;
    }
    return;
  }

  // dash
  e.perkDrive = true;
  e.vx = active.dirX * (p.speed ?? 34);
  e.vy = active.dirY * (p.speed ?? 34);

  // The afterimage, sized off how much dash is left so it thins out as the
  // boss slows into the recovery rather than snapping off.
  const left = Math.max(0, active.timer) / Math.max(0.01, p.duration ?? 0.9);
  active.flare.visible = true;
  place(active.flare, e, r * 1.15);
  ringAlpha(active.flare, 0.55 * left);
  // Whole while the dash is live, then eaten away by the trailing edge as it
  // runs out — the same hand continuing round rather than the afterimage
  // dimming in place.
  ringSweep(active.flare, 1, 1 - left, 1);

  if (active.timer <= 0) {
    e.perkDrive = false;
    e.contactDamage = baseContactDamage;
    e.ramming = false;
    active.flare.visible = false;
    active.stage = 'ready';
    active.timer = p.cooldown ?? 5.5;
  }
}

// ---------------------------------------------------------------------------
// A jagged spline from (x0,y0) to (x1,y1), written into `out` as `segs`
// LineSegments pairs starting at `o`.
//
// The displacement is PERPENDICULAR to the chord and HALVES toward both ends,
// which is the whole recipe — the same one systems/eel.js uses for a chain
// lightning hop, deliberately reimplemented in six lines rather than shared:
// that one branches, carries the eel's own config and returns an allocated
// point list, and none of those are things a rim spark wants.
//
// TAPERED TO ZERO AT BOTH ENDS on purpose. The endpoints are the contract —
// one of them sits exactly on the aura boundary, which is the hitbox — and a
// displaced end would be a spark that visibly starts outside the circle the
// player is being asked to trust.
function jagArc(out, o, segs, x0, y0, x1, y1, z, jag) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  // The unit normal. Scaled by the chord length so the kink is a fraction of
  // the strike rather than a world constant — a short spark and a long one
  // read as the same phenomenon at different sizes.
  const nx = -dy / len;
  const ny = dx / len;
  const amp = len * jag;

  let px = x0;
  let py = y0;
  for (let s = 1; s <= segs; s++) {
    const t = s / segs;
    // sin(pi*t) is the taper: zero at both ends, widest in the middle.
    const d = s === segs ? 0 : (Math.random() - 0.5) * 2 * amp * Math.sin(Math.PI * t);
    const cx = x0 + dx * t + nx * d;
    const cy = y0 + dy * t + ny * d;
    const i = o + (s - 1) * 6;
    out[i + 0] = px; out[i + 1] = py; out[i + 2] = z;
    out[i + 3] = cx; out[i + 4] = cy; out[i + 5] = z;
    px = cx;
    py = cy;
  }
}

// ELECTRIC AURA
// ---------------------------------------------------------------------------
// The only perk with no state machine: it is simply always on, and that is the
// point. A field you have to stay out of is a rule about the whole fight
// rather than an event inside it — the boss doesn't do anything, the space
// around it is just no longer free.
//
// Damage is per second and applied per frame, exactly like contact damage, so
// clipping the edge of it costs a sliver and sitting in it costs the stated
// rate. A burst on entry would make brushing past it identical to living in
// it, which is the opposite of what a zone is for.
function updateElectric(dt, e, r, playerPos, dist, dx, dy, hooks) {
  const p = active.perk;
  const fx = CONFIG.boss?.perkFx?.electric ?? {};
  const reach = r + (p.radius ?? 9);

  // The ring breathes, but only between `pulse` and 1 — never down to nothing,
  // because the ring IS the hitbox and a boundary that visibly moves is one
  // the player will (correctly) not trust.
  const pulse = 1 - (fx.pulse ?? 0.22) * 0.5 * (1 + Math.sin(active.clock * Math.PI * 2 * (fx.pulseHz ?? 3.5)));
  place(active.ring, e, reach);
  ringAlpha(active.ring, 0.28 + 0.3 * pulse);
  // Always whole — this perk has no wind-up and the ring IS the hitbox, so
  // there is never a moment where part of the boundary is not drawn. What rides
  // the breath instead is the CHARGE, which drives how hard and how fast the
  // jagged splines re-roll: the field visibly tightens on the beat rather than
  // crackling at one flat rate.
  ringSweep(active.ring, 1, 0, 0.45 + 0.55 * pulse);

  // Arcs. Each is a jagged spline struck across the rim, alive for a fraction
  // of a second — the buffer is written in place and the whole set is one draw.
  //
  // The strike is re-rolled from scratch every time it comes back rather than
  // being animated: a bolt that moved would be a rope, and what electricity
  // does is EXIST somewhere else. `pulse` rides the amplitude so the jags bite
  // harder on the beat the ring tightens on, which is the field visibly
  // charging rather than crackling at one flat rate.
  const rate = fx.arcRate ?? 14;
  const life = fx.arcSeconds ?? 0.09;
  const jag = (fx.arcJag ?? 0.22) * pulse;
  const stride = active.arcSegs * 6;
  for (let i = 0; i < active.arcCount; i++) {
    active.arcLife[i] -= dt;
    if (active.arcLife[i] > 0) continue;
    // Spread the respawns rather than restriking them all on the same frame:
    // an even cadence reads as a machine, and a random one reads as static.
    if (Math.random() > rate * dt / active.arcCount) continue;
    active.arcLife[i] = life * (0.5 + Math.random());
    const a0 = Math.random() * Math.PI * 2;
    const a1 = a0 + (Math.random() - 0.5) * 1.2;
    const r1 = reach * (0.55 + Math.random() * 0.4);
    jagArc(
      active.arcPositions, i * stride, active.arcSegs,
      e.mesh.position.x + Math.cos(a0) * reach,
      e.mesh.position.y + Math.sin(a0) * reach,
      e.mesh.position.x + Math.cos(a1) * r1,
      e.mesh.position.y + Math.sin(a1) * r1,
      e.mesh.position.z, jag,
    );
  }
  // Dead arcs are collapsed to a point rather than removed — a zero-length
  // segment draws nothing, and rebuilding the buffer to omit them would cost
  // more than the pixels it saves.
  for (let i = 0; i < active.arcCount; i++) {
    if (active.arcLife[i] > 0) continue;
    const o = i * stride;
    for (let k = 0; k < stride; k++) active.arcPositions[o + k] = 0;
  }
  active.arcs.geometry.attributes.position.needsUpdate = true;

  // --- THE FIELD INSIDE THE RING --------------------------------------------
  // Lobes of charged water filling the zone, so it reads as a space rather than
  // as a circle. They FUSE — see the `aura` group in CONFIG.fx.goo — which is
  // what makes a handful of particles look like a medium instead of like a
  // handful of particles.
  //
  // WHY THIS IS NOT ALLOWED TO BE THE EDGE. The ring is the hitbox, and the
  // note on `pulse` above says why its boundary is never permitted to move by
  // more than it breathes: a damage boundary the player cannot trust is worse
  // than no art at all. A thresholded density field has a wobbling edge by
  // construction. So the fill is held INSIDE, by a margin that accounts for how
  // wide a lobe actually draws — `auraLobeReach()` — and the ring goes on being
  // the only thing that says where the damage stops.
  if (fx.fillEnabled !== false) {
    active.fillCarry += (fx.fillPerSecond ?? 9) * dt;
    let lobes = Math.floor(active.fillCarry);
    active.fillCarry -= lobes;
    // The same hitch guard the wake's churn has: one long frame must not empty
    // a second of the field into a single spot.
    lobes = Math.min(lobes, 3);
    // How far from the centre a lobe may be BORN so that its outer edge, after
    // it has drifted as far as it can, still stops short of the rim.
    const inset = Math.min(0.98, Math.max(0, fx.inset ?? 0.82));
    const speed = Math.hypot(e.vx ?? 0, e.vy ?? 0);
    const usable = reach * inset - auraLobeReach() - auraLobeLag(speed);
    for (let i = 0; i < lobes && usable > 0; i++) {
      // Area-uniform rather than radius-uniform (sqrt of the roll): spread
      // evenly along the radius, a ring's worth of lobes piles up in the middle
      // and the field reads as a lump on the boss rather than as a zone.
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.random()) * usable;
      emit('auraField', e.mesh.position.x + Math.cos(a) * rr, e.mesh.position.y + Math.sin(a) * rr, {
        // Drift is INWARD-ish and slow — outward drift would walk the field at
        // the boundary it is not allowed to touch.
        dirX: -Math.cos(a),
        dirY: -Math.sin(a),
        speedMul: fx.fillDrift ?? 1.1,
        // The boss's own velocity, taken whole (`inherit: 1`), so the field
        // travels with the animal instead of being left in the water behind it.
        vx: e.vx ?? 0,
        vy: e.vy ?? 0,
      });
    }
  }

  if (dist < reach && hooks.onPlayerHit) {
    // Away from the boss, like every other contact shove — being shocked
    // should push you out of the thing shocking you, not into it.
    hooks.onPlayerHit((p.damage ?? 16) * dt, { x: -dx, y: -dy }, 'bossShock');
  }
}

// ---------------------------------------------------------------------------
// TELEPORT
// ---------------------------------------------------------------------------
// The answer to a player who has solved the fight by simply swimming away from
// it forever. It does not chase faster — it stops the distance from meaning
// anything, on a cooldown slow enough that kiting is still the right idea and
// just no longer a free one.
//
// It lands NEAR the player at `radius`, never on top of them: a blink into
// contact is a hit with no frame of warning, and the flash-in exists to be
// reacted to. The angle is random, so the correct response is to move rather
// than to pre-aim.
function updateTeleport(dt, e, r, playerPos) {
  const p = active.perk;
  const fx = CONFIG.boss?.perkFx?.teleport ?? {};
  active.timer -= dt;

  // Both flashes are on their own clocks and outlive the stage that spawned
  // them, so the one where it LEFT is still fading while the boss is already
  // somewhere else — which is what makes the two read as one movement.
  for (const [key, mesh] of [['flashOutLife', active.flashOut], ['flashInLife', active.flashIn]]) {
    if (active[key] <= 0) { mesh.visible = false; continue; }
    active[key] -= dt;
    const t = 1 - Math.max(0, active[key]) / Math.max(0.01, fx.flashSeconds ?? 0.22);
    mesh.visible = true;
    // A flash arrives WHOLE — there is nothing to count down to, the boss has
    // already gone — and is then eaten away as it expands. So the leading edge
    // is pinned at 1 and only the trailing one runs.
    placeOrganicRing(mesh, mesh.position.x, mesh.position.y,
      r * (fx.flashScale ?? 1.6) * (0.4 + t * 1.1), mesh.position.z);
    ringAlpha(mesh, 1 - t);
    ringSweep(mesh, 1, t);
  }

  if (active.stage === 'ready') {
    if (active.timer > 0) return;
    active.stage = 'windup';
    active.timer = p.windup ?? 0.45;
    return;
  }

  if (active.stage === 'windup') {
    // Held still through the wind-up. Without it the boss is mid-swim when it
    // vanishes and the flash is left behind a body that was already elsewhere,
    // which reads as a rendering glitch rather than as a departure.
    e.perkDrive = true;
    e.vx = 0;
    e.vy = 0;
    if (active.timer <= 0) {
      active.flashOut.position.copy(e.mesh.position);
      active.flashOutLife = fx.flashSeconds ?? 0.22;
      e.visual.visible = false;
      active.stage = 'gone';
      active.timer = p.duration ?? 0.35;
    }
    return;
  }

  if (active.stage === 'gone') {
    e.perkDrive = true;
    e.vx = 0;
    e.vy = 0;
    if (active.timer > 0) return;

    const a = Math.random() * Math.PI * 2;
    const reach = p.radius ?? 13;
    e.mesh.position.x = playerPos.x + Math.cos(a) * reach;
    e.mesh.position.y = playerPos.y + Math.sin(a) * reach;
    // A simulated body carries its own position and would drag the mesh
    // straight back to where it was on the next physics step, so the blink has
    // to be told to it as well. Without this the boss reappears exactly where
    // it left, once per cooldown, forever.
    e.body?.place(e.mesh.position.x, e.mesh.position.y);

    e.visual.visible = true;
    active.flashIn.position.copy(e.mesh.position);
    active.flashInLife = fx.flashSeconds ?? 0.22;
    e.perkDrive = false;
    active.stage = 'ready';
    active.timer = p.cooldown ?? 7;
  }
}

// ---------------------------------------------------------------------------
// PHASE — going unseen
// ---------------------------------------------------------------------------
// A FLICKER, NOT A FADE, and that is a constraint rather than a style choice.
// Every clone of a model shares its material by reference (see createVisual),
// so turning the boss's opacity down turns down every creature built from the
// same body — for the orca boss that is the player's own Orca Family pod, mid
// fight. Cloning the material to get around it is worse: Material.clone()
// silently drops onBeforeCompile, so the clone loses every injected shader the
// creature had while its userData still claims they are attached.
//
// So visibility is toggled, at a rate that ramps from a slow blink to a stutter
// and then stops on "off". It costs nothing, it touches no shared state, and a
// body strobing faster and faster before it goes reads as something losing its
// grip on being there — which is the right feeling anyway.
//
// THE MARKER IS THE FAIRNESS. A boss you cannot see and cannot locate is not a
// mechanic, it is the fight being taken away. The ring on the water says where
// it is; it does not say which way it is pointing or how fast it is closing,
// which is the information the perk is actually taking.
function updatePhase(dt, e, r) {
  const p = active.perk;
  const fx = CONFIG.boss?.perkFx?.phase ?? {};
  active.timer -= dt;

  const from = fx.flickerFromHz ?? 6;
  const to = fx.flickerToHz ?? 26;

  // `t` is how far through the current flicker ramp we are, 0..1.
  const flickerAt = (t) => {
    active.flicker += dt * (from + (to - from) * t);
    return active.flicker % 1 < 0.5;
  };

  if (active.stage === 'ready') {
    active.marker.visible = false;
    if (active.timer > 0) return;
    active.stage = 'fadeOut';
    active.timer = p.windup ?? 0.5;
    active.flicker = 0;
    return;
  }

  if (active.stage === 'fadeOut') {
    const t = 1 - Math.max(0, active.timer) / Math.max(0.01, p.windup ?? 0.5);
    e.visual.visible = flickerAt(t);
    if (active.timer <= 0) {
      e.visual.visible = false;
      active.stage = 'gone';
      active.timer = p.duration ?? 3.5;
    }
    return;
  }

  if (active.stage === 'gone') {
    e.visual.visible = false;
    active.marker.visible = true;
    place(active.marker, e, r * (fx.markerScale ?? 0.55));
    // Breathes slowly, so it is legible as a live tracker rather than as a
    // decal someone forgot to remove.
    ringAlpha(active.marker, (fx.markerOpacity ?? 0.4)
      * (0.7 + 0.3 * Math.sin(active.clock * 4)));
    // A tracker, not a countdown: it says where the boss IS, and nothing about
    // when it comes back. Whole for as long as it is up.
    ringSweep(active.marker, 1, 0);
    if (active.timer <= 0) {
      active.stage = 'fadeIn';
      active.timer = p.windup ?? 0.5;
      active.flicker = 0;
    }
    return;
  }

  // fadeIn — the ramp run backwards, so it stutters back into existence.
  active.marker.visible = false;
  const t = Math.max(0, active.timer) / Math.max(0.01, p.windup ?? 0.5);
  e.visual.visible = flickerAt(t);
  if (active.timer <= 0) {
    e.visual.visible = true;
    active.stage = 'ready';
    active.timer = p.cooldown ?? 9;
  }
}

// ---------------------------------------------------------------------------
// THE SHOOTERS — eyebeam, barrels, spitfish, finfish
// ---------------------------------------------------------------------------
// One state machine, four loadouts. `ready` counts the cooldown down; `windup`
// holds a charge ring at each muzzle for exactly as long as the row's `windup`
// says; `fire` spends the volley and drops back to ready.
//
// THE WINDUP IS NOT DECORATION. Every one of these fires along a line through
// where the player IS, and a shot with no tell against a player already
// dodging a three-tonne animal is damage that arrives out of nowhere. The ring
// sits at the muzzle rather than on the body so the tell says WHERE FROM: an
// eyebeam charging at the head and a fin volley charging at the flanks are the
// same half-second of warning about two completely different things to swim
// out of.
//
// AIMED AT THE PLAYER, NOT LED. No prediction, deliberately: a boss that
// aimed where you were going to be would make moving worse than standing
// still, which inverts the one instinct every other creature in this game has
// spent the run training.
// ---------------------------------------------------------------------------
// ORDNANCE — barrels in flight and the blasts they leave
// ---------------------------------------------------------------------------
// Module-level rather than hung off `active`, and that is not tidiness: this is
// the machinery the boat boss shares (see systems/bossBoat.js), and a boat's
// bombardment is not a perk. Both throwers put barrels in the same list, one
// ticker watches every fuse, and one blast list draws every ring.
//
// It also fixed a real hole. The fuse watcher used to read `active.barrels`, so
// a boss killed with barrels in the air had them silently deleted mid-flight —
// the shot that killed it cancelled ordnance that was already committed, which
// is the one moment a player has every right to expect the water to still go
// up. Now the list outlives the perk and only a reset clears it.
const ordnance = [];   // { p, x, y, radius, damage, source } — barrels with fuses
const blasts = [];     // expanding rings, with the damage already dealt

// The two things a fuse ending needs and cannot ask for, refreshed every frame
// by updateBossPerks: where the player is, and how to hurt them. A barrel goes
// off BETWEEN frames as far as its thrower is concerned, so it cannot reach
// either from the stack that threw it.
const field = { hooks: null, playerPos: null };

// `attack` is the DEFAULT threat type for this gun's charge ring — the colour
// and edge dialect the muzzle tell wears when the perk's row leaves the
// `attack` column blank. A filled cell always wins; this is here so a gun added
// without touching the CSV still announces itself as the right kind of harm
// rather than as generic amber.
const GUNS = {
  eyebeam: {
    origins: 2, // one per eye
    color: 0xff6a4a,
    attack: 'beam',
    asset: 'bossBeam',
    // NOT A SHOT. This one lights a line and holds it — see systems/beams.js.
    // It was a pair of fast projectiles, which is a different attack wearing
    // the same name: a shot is dodged by not being where it is going, and the
    // whole point of eyes is that they FOLLOW you. As a beam anchored to the
    // head, the line sweeps as the boss turns, so it is not aimed at you, it is
    // dragged through you — and the counterplay is to break the line rather
    // than to sidestep once.
    beam: true,
    // Long enough to cross the arena from anywhere in it (the arena is ~92
    // across), so the beam always ends at the wall rather than in open water —
    // a laser that stops in the middle of the sea reads as a rendering bug.
    beamLength: 120,
    // Where each origin sits, in units of the boss's own radius: down the
    // body axis, then out to the side. Never hand-typed world units — a giant
    // orca is more than twice the size of a plain shark and the eyes have to
    // move with it. See the note in CONFIG.boss.perkFx.
    forward: 0.72,
    side: 0.17,
    life: 2.2,
    radius: 0.3,
    scale: 1,
    orient: true,
    spread: 0, // both beams on the same line: two eyes, one stare
  },
  barrels: {
    origins: 1,
    color: 0xffb347,
    attack: 'blast',
    asset: 'bossBarrel',
    forward: 0.8,
    side: 0,
    life: 2.2, // overwritten by the row's `duration` — the fuse
    radius: 0.55,
    scale: 1,
    orient: false,
    spread: 0.22,
    fuse: true,
  },
  // THE SEEKER. The only shot in the game that follows the seal — every other
  // volley here is fired at where you were and beaten by moving. This one is
  // beaten by OUT-TURNING it: `turnRate` in the row is the whole counterplay,
  // and a missile that turns as hard as the seal does is an unavoidable hit
  // with a long fuse. See CONFIG.bossBoat for the numbers the boat uses.
  missiles: {
    origins: 2, // launchers to either side
    color: 0xffd27a,
    attack: 'blast',
    asset: 'bossMissile',
    forward: 0.35,
    side: 0.55,
    life: 4.5,
    radius: 0.4,
    scale: 1,
    orient: true,   // it points where it is going, which is how you read its turn
    spread: 0.5,    // fired WIDE and allowed to come back, so the launch reads
    homing: true,
  },
  spitfish: {
    attack: 'kinetic',
    origins: 1, // the mouth
    color: 0x9fe8a0,
    asset: 'enemyFish',
    forward: 0.85,
    side: 0,
    life: 3,
    radius: 0.42,
    scale: 0.85,
    orient: true,
    spread: 0.14,
  },
  finfish: {
    attack: 'kinetic',
    origins: 2, // one per flank
    color: 0x9fe8a0,
    asset: 'enemyFish',
    // Back along the body and well out to the sides — the fins are not the
    // face, and a fin volley that came out of the nose would be spitfish with
    // a different name.
    forward: -0.1,
    side: 0.5,
    life: 3,
    radius: 0.42,
    scale: 0.8,
    orient: true,
    // The fan. Wider than spitfish because it is the whole identity of this
    // one: you cannot sidestep four shots that arrive spread out, you have to
    // pick a side and commit before they leave.
    spread: 0.4,
  },
};

// Which way the body is pointing, as a unit vector. Velocity first and the
// baked heading as the fallback, matching mouthPoint in entities/enemies.js —
// a boss holding still at the top of a wind-up still has a heading, and its
// eyes are still on the front of it.
function bodyFacing(e, out) {
  const s = Math.hypot(e.vx ?? 0, e.vy ?? 0);
  if (s > 1e-3) out.set(e.vx / s, e.vy / s, 0);
  else out.set(Math.cos(e.heading ?? 0), Math.sin(e.heading ?? 0), 0);
  return out;
}

const _fwd = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _shotDir = new THREE.Vector3();

// World position of origin `i`, written into `out`. Measured in the BODY's
// frame — down its own axis and out to its own side — because that is where
// eyes and fins are. What the shot is aimed at is a separate question,
// answered in fireVolley.
function muzzleAt(out, e, r, gun, i) {
  bodyFacing(e, _fwd);
  // Two origins straddle the axis; one sits on it.
  const sign = gun.origins > 1 ? (i === 0 ? 1 : -1) : 0;
  out.copy(e.mesh.position);
  out.x += _fwd.x * gun.forward * r + -_fwd.y * gun.side * r * sign;
  out.y += _fwd.y * gun.forward * r + _fwd.x * gun.side * r * sign;
  // Flat, like every other emit point in the game: the arena is a plane and a
  // projectile born even slightly off it sorts behind the water.
  out.z = e.mesh.position.z;
  return out;
}

// ONE EYE, LIT. Anchored to the head rather than fired from it: `follow` is
// re-read every frame by systems/beams.js, so the line stays welded to the eye
// it came out of and sweeps as the body turns. A beam that took its direction
// once at ignition would be a very slow projectile — the same attack the shot
// version already was.
//
// The muzzle is recomputed rather than captured for the same reason: a boss
// this size moves several units during a burn, and a line still starting from
// where its head USED to be is the single most obvious way to make an effect
// look detached from the animal.
const _beamFwd = new THREE.Vector3();
const _beamAt = new THREE.Vector3();

// THE EYE ITSELF, if the model has one under a name we were given.
//
// The fallback below (a body-frame offset, `forward` and `side` in units of the
// boss's radius) is a good guess at where a face is and nothing more — it is
// the same guess for a shark, an orca and a squid, three bodies with the eyes
// in three different places. A model that names its eyes can do better, and all
// three of ours do:
//
//   megalodon   `eye`            a MESH, not a joint
//   orca        `eye_L_014` / `eye_R_00`   real joints, one per side
//   giantsquid  `eyes.R.001_56` ...        a chain of them
//
// ...which is exactly why the name is config (CONFIG.boss.perkFx.eyeSockets) and
// not a rule: there is no naming convention across three files from three
// sources, and any pattern-match clever enough to catch all three would catch
// the wrong thing on the fourth. Run `npm run bones -- <model.glb> eye` to see
// what a model actually calls them.
//
// Cached per creature, because a name lookup walks the whole subtree and this
// is asked once per beam. A miss caches `null` and falls back forever, so a
// model with no such node costs one traversal per boss rather than one per shot.
function eyeNodeFor(e, index) {
  if (e.__eyeNodes === undefined) {
    const names = CONFIG.boss?.perkFx?.eyeSockets?.[e.type];
    e.__eyeNodes = null;
    if (names?.length && e.visual) {
      const found = names
        .map((n) => e.visual.getObjectByName(n))
        .filter(Boolean);
      if (found.length) e.__eyeNodes = found;
    }
  }
  if (!e.__eyeNodes) return null;
  return e.__eyeNodes[index % e.__eyeNodes.length];
}

function lightEyeBeam(scene, e, r, gun, muzzleIndex, p) {
  const eye = muzzleIndex % gun.origins;
  spawnBeam(scene, {
    x: 0, y: 0, dirX: 1, dirY: 0, // placed by the first follow(), below
    length: gun.beamLength ?? 120,
    life: Math.max(0.2, p.duration ?? 1.4),
    damage: p.damage ?? 6,
    color: gun.color,
    hitsPlayer: true,
    source: `boss:${active.id}`,
    follow: () => {
      // The boss can die mid-burn. Returning null leaves the beam exactly where
      // it was for the rest of its life rather than following a corpse to the
      // origin — and it still fades out on its own clock, so the last thing the
      // player sees is the beam dying down rather than snapping off.
      if (!e || e.hp <= 0) return null;
      bodyFacing(e, _beamFwd);
      const node = eyeNodeFor(e, eye);
      if (node) {
        // WORLD POSITION, so the animation is included. The eye is somewhere
        // under a rig that is being posed every frame — reading its local
        // offset would put the beam where the eye is in the REST pose, which on
        // a swimming body is nowhere near where it currently is.
        node.getWorldPosition(_beamAt);
        // Flat: the arena is a plane, and a beam born off it sorts behind the
        // water. The eye is genuinely off-plane on every one of these models.
        _beamAt.z = e.mesh.position.z;
      } else {
        muzzleAt(_beamAt, e, r, gun, eye);
      }
      return { x: _beamAt.x, y: _beamAt.y, dirX: _beamFwd.x, dirY: _beamFwd.y };
    },
  });
}

// One volley. `count` shots, alternating between the origins so a two-muzzle
// perk fires left, right, left rather than emptying one side.
function fireVolley(scene, e, r, dirX, dirY, dist) {
  const p = active.perk;
  const gun = GUNS[active.id];
  const count = Math.max(1, p.count ?? 1);

  // A BARREL IS THROWN TO A PLACE, not fired at a person. Its fuse is cut to
  // roughly the flight time to where the player was standing when the volley
  // left, so it arrives there and goes off there.
  //
  // Without this the fuse was a flat 2.2 seconds and the barrel simply kept
  // going: at 12 units a second that is 26 units of travel in an arena about
  // 92 across, so a barrel thrown at a player 6 units away detonated twenty
  // units behind them, every time, and the perk was a firework display.
  // `duration` stays the ceiling — a barrel thrown at maximum range still has
  // a fuse rather than an unlimited flight — and the floor stops a
  // point-blank throw going off inside the boss's own nose.
  // Measured from the MUZZLE, not from the body's centre — the barrel leaves
  // the boss's nose, which on an animal this size is four units closer to the
  // player than the boss is, and a fuse cut from the centre overshoots by
  // exactly that. Recomputed per shot inside the loop; `dist` is the fallback
  // for the frame the player position hasn't been published yet.
  const pp = active.playerPos;
  const fuseFor = (origin) => {
    if (!gun.fuse) return gun.life;
    const travel = pp ? Math.hypot(pp.x - origin.x, pp.y - origin.y) : dist;
    return Math.min(p.duration ?? gun.life, Math.max(0.35, travel / Math.max(1, p.speed ?? 12)));
  };

  for (let i = 0; i < count; i++) {
    const origin = muzzleAt(_muzzle, e, r, gun, active.muzzle % gun.origins);
    active.muzzle += 1;

    // The fan, centred on the aim: shot 0 of 3 goes left, 1 straight, 2 right.
    // A single shot takes no offset at all rather than the middle of a fan of
    // one, which would be the same thing but would read as luck.
    const half = (count - 1) / 2;
    const angle = count > 1 ? (i - half) * gun.spread : 0;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    _shotDir.set(dirX * c - dirY * s, dirX * s + dirY * c, 0);

    // A BEAM IS LIT, NOT LAUNCHED, so it never reaches fireBossShot — there is
    // no projectile to give a speed or a life to. What it takes from the row is
    // the same vocabulary every other perk uses: `duration` is how long it
    // burns and `damage` is what a TICK of it costs (see beams.tickEvery),
    // which is why the number in the CSV is small next to a shot's.
    if (gun.beam) {
      lightEyeBeam(scene, e, r, gun, active.muzzle - 1, p);
      continue;
    }

    fireBossShot(scene, {
      gun,
      origin,
      dirX: _shotDir.x,
      dirY: _shotDir.y,
      damage: p.damage ?? 10,
      speed: p.speed ?? 16,
      life: fuseFor(origin),
      blastRadius: p.radius ?? 3.4,
      turnRate: p.mul ?? undefined,
      // Filed against the perk, not the species, so a playtest report can say
      // "the eyebeam boss killed you" rather than "a bossShark did".
      source: `boss:${active.id}`,
    });
  }
}

/**
 * A row of the GUNS table, for a caller outside this file. The boat's
 * bombardment fires the same barrel and the same seeker the perks do, and this
 * is how it gets at their look without a second copy of the table.
 */
export function bossGun(id) {
  return GUNS[id];
}

/**
 * ONE SHOT, from whatever is doing the shooting.
 *
 * The single place an enemy projectile is born in this file, so a barrel thrown
 * by the `barrels` perk and a barrel thrown by the boat's bombardment are the
 * same object with the same fuse, the same blast and the same playtest filing.
 * `gun` is a row of the GUNS table above — what it looks like and how it flies;
 * everything else is what this particular shot is worth.
 *
 * @param chase the thing a homing shot follows. Only meaningful on a gun with
 *              `homing`, and REQUIRED there: without it the seeker walks the
 *              enemy list and chases the boss's own escorts.
 */
export function fireBossShot(scene, {
  gun, origin, dirX, dirY, damage, speed, life, blastRadius = 0, turnRate, chase = null, source,
}) {
  _shotDir.set(dirX, dirY, 0);
  spawnProjectile(scene, {
    origin,
    dir: _shotDir,
    faction: 'enemy',
    damage,
    speed,
    life,
    radius: gun.radius,
    asset: gun.asset,
    scale: gun.scale,
    orient: gun.orient,
    // END OVER END, for a shot whose body is worth watching turn. Nothing in
    // the GUNS table above sets it — a barrel and a beam both want to lie
    // still on their heading — but a gun handed in by a boss's `ordnance`
    // override can, and the yacht's rolls of cash do.
    //
    // It is exclusive with `orient` rather than layered over it, and that is
    // entities/projectiles.js's rule, not one made here: both write Euler
    // angles onto the same mesh, so a shot that spins does not also point.
    spin: gun.spin ?? 0,
    // The cant. See the note on `tilt` in entities/projectiles.js for why a
    // side-view game needs one at all — in short, a cylinder flown flat in the
    // screen plane is a rectangle for its whole flight.
    tilt: gun.tilt ?? 0,
    homing: !!gun.homing,
    turnRate: turnRate ?? 1.6,
    // The seal, and nothing else, ever. See the note on `chase` in
    // entities/projectiles.js.
    chase: gun.homing ? chase : null,
    source,
    // No gravity: it is only applied above the surface anyway (see
    // updateProjectiles), and a barrel that floats is a barrel the player can
    // still be standing under.
    gravityScale: 0,
  });

  // Fused shots are watched after launch so the blast goes off where the barrel
  // actually IS rather than where it was aimed. See updateOrdnance.
  if (!gun.fuse) return;
  const live = projectiles[projectiles.length - 1];
  // `burst` and `blastColor` ride on the RECORD rather than being looked up in
  // boom(), because by the time a fuse ends the gun that lit it is long out of
  // scope — the projectile has left the list and all boom() has is a position.
  // A gun that names neither gets the ring and nothing else, which is what
  // every barrel in the game did before the yacht wanted its money back.
  if (live) {
    ordnance.push({
      p: live, x: origin.x, y: origin.y, radius: blastRadius, damage, source,
      burst: gun.blastEmitter ?? null,
      blastColor: gun.blastColor ?? null,
    });
  }
}

// The shooter state machine.
function updateGun(dt, scene, e, r, dist, dirX, dirY) {
  const p = active.perk;
  const gun = GUNS[active.id];
  active.timer -= dt;


  const inRange = dist <= (p.range ?? Infinity);

  if (active.stage === 'ready') {
    for (const ring of active.charges) ring.visible = false;
    // THE COOLDOWN RUNS WHEREVER YOU ARE, but the volley only starts once you
    // are in range. Otherwise kiting out past `range` would bank a shot that
    // fires the instant you come back, and the range would be teaching the
    // player a lie about when it is safe to approach.
    if (active.timer > 0 || !inRange) return;
    active.stage = 'windup';
    active.timer = Math.max(0.05, p.windup ?? 0.4);
    return;
  }

  if (active.stage === 'windup') {
    // The charge rings ride the muzzles for the whole tell, so a boss that
    // turns during its wind-up drags the warning round with it.
    const t = 1 - Math.max(0, active.timer) / Math.max(0.05, p.windup ?? 0.4);
    for (let i = 0; i < active.charges.length; i++) {
      const ring = active.charges[i];
      ring.visible = true;
      muzzleAt(_muzzle, e, r, gun, i);
      ring.position.copy(_muzzle);
      // Tightens as it charges rather than swelling: a shrinking ring reads as
      // something gathering, a growing one as something already released.
      placeOrganicRing(ring, _muzzle.x, _muzzle.y,
        r * (0.5 - 0.3 * t) * (CONFIG.boss?.perkFx?.[active.id]?.chargeScale ?? 1),
        _muzzle.z);
      ringAlpha(ring, 0.35 + 0.65 * t);
      // The hand closes exactly as the volley fires. Two tells in one ring: how
      // long you have (the sweep) and how hard it is winding up (the charge,
      // which on an electric muzzle is what makes the jags escalate).
      ringSweep(ring, t, 0, t);
    }
    if (active.timer > 0) return;
    // COMMITTED. The volley is fired even if the player has since swum out of
    // range — the wind-up was the warning and the shot is the consequence,
    // and a tell that can be cancelled by backing off is not a tell.
    fireVolley(scene, e, r, dirX, dirY, dist);
    active.stage = 'ready';
    active.timer = Math.max(0.2, p.cooldown ?? 3);
    for (const ring of active.charges) ring.visible = false;
  }
}

// ---------------------------------------------------------------------------
// BARRELS — the fuse
// ---------------------------------------------------------------------------
// A barrel is an ordinary enemy projectile for its whole flight: it is drawn,
// moved and collided by entities/projectiles.js, it hits the player through
// the same path a fisherman's shot does, and the player can shoot it out of
// the water. What it is NOT, on its own, is explosive — `splashDamage` is a
// player-side concept (it spreads to other ENEMIES), so the blast is here.
//
// Each launched barrel is tracked by identity and its last known position is
// copied every frame. When it leaves the projectile list — fuse expired, hit
// the player, shot down — it goes off at wherever it was standing. That is the
// whole mechanic: barrels are not aimed, they are PLACED, and a barrel shot
// down at close range still catches you.
// Every fuse in the water, whoever lit it. A barrel leaves the list the frame
// its projectile does — by fuse, by hitting the seal, by leaving the arena —
// and goes off wherever it had got to.
function updateOrdnance(dt, scene) {
  if (!ordnance.length) return;
  const fx = CONFIG.boss?.perkFx?.barrels ?? {};
  for (let i = ordnance.length - 1; i >= 0; i--) {
    const b = ordnance[i];
    if (projectiles.includes(b.p)) {
      // Still flying: remember where, because once it is gone its mesh has
      // already been taken out of the scene and its position is unreadable.
      b.x = b.p.mesh.position.x;
      b.y = b.p.mesh.position.y;
      continue;
    }
    ordnance.splice(i, 1);
    boom(scene, b.x, b.y, b.radius, fx, b.damage, b.source, b);
  }
}

// The blast. Damage is dealt through the same hook a bite goes through, so it
// respects i-frames, shakes the screen and is filed in the playtest log like
// every other hit — see updateBossPerks.
function boom(scene, x, y, radius, fx, damage = 20, source = 'boss:barrels', shot = null) {
  // A pattern row may name its own blast colour (CONFIG.bossBoat.patterns), and
  // that wins over the palette — it is a deliberate per-shot choice rather than
  // a threat category. Without one, `blast` is what this is.
  const ring = track(scene, makeRing(shot?.blastColor ?? fx.blastColor ?? null,
    0.55, 1, 48, 'blast'));
  // Sized here as well as in updateBlasts: the tick that grows it may not run
  // until the next frame, and a ring left at its birth radius of 1 is a
  // one-frame speck where an explosion should be.
  placeOrganicRing(ring, x, y, radius * 0.35);
  ring.visible = true;
  blasts.push({ ring, life: fx.blastSeconds ?? 0.35, max: fx.blastSeconds ?? 0.35, radius });

  // WHAT THE BLAST THROWS, for a shot that named something. Scaled by the
  // radius the blast actually has rather than emitted flat, because that radius
  // is a pattern's number (CONFIG.bossBoat.patterns) and varies by nearly a
  // metre between `rain` and `spread` — a fixed count would make the small one
  // look like the big one and take the reach reading away from the player.
  // Divided by 3 so the mid-sized blast is the emitter's own count, which is
  // what it was tuned at.
  if (shot?.burst) emit(shot.burst, x, y, { scale: Math.max(0.5, radius / 3) });

  const hooks = field.hooks;
  const pp = field.playerPos;
  if (!hooks?.onPlayerHit || !pp) return;
  const dx = pp.x - x;
  const dy = pp.y - y;
  const d = Math.hypot(dx, dy);
  if (d > radius) return;
  // Full damage at the centre, easing to nothing at the rim. A flat blast the
  // width of the arena's fifth would make the edge of it indistinguishable
  // from the middle, and the whole counterplay is "get further away".
  const falloff = 1 - (d / Math.max(0.01, radius)) ** 2;
  const dir = d > 1e-4 ? { x: dx / d, y: dy / d } : { x: 0, y: 1 };
  hooks.onPlayerHit(damage * falloff, dir, source);
}

// The expanding rings left by boom(). Ticked from updateBossPerks so they run
// on the same clock as everything else here, and disposed when they finish.
function updateBlasts(dt) {
  const list = blasts;
  if (!list.length) return;
  for (let i = list.length - 1; i >= 0; i--) {
    const b = list[i];
    b.life -= dt;
    const t = 1 - Math.max(0, b.life) / Math.max(0.01, b.max);
    placeOrganicRing(b.ring, b.ring.position.x, b.ring.position.y,
      b.radius * (0.35 + 0.65 * t), b.ring.position.z);
    ringAlpha(b.ring, 1 - t);
    // Already gone off, so it arrives whole and is eaten as it opens. The
    // world-fixed noise field is doing the real work here: the ring sweeps
    // OUTWARD through stationary noise, so it churns as it grows instead of
    // scaling up one frozen pattern.
    ringSweep(b.ring, 1, t);
    if (b.life > 0) continue;
    disposeObj(b.ring);
    const at = owned.indexOf(b.ring);
    if (at >= 0) owned.splice(at, 1);
    list.splice(i, 1);
  }
}

// ---------------------------------------------------------------------------
// TURTLES — the screen
// ---------------------------------------------------------------------------
// Sea turtles cannot be killed. That is not a decision made for this perk —
// seaTurtle has an hp of one billion in enemies.csv and has had since long
// before bosses existed — but it is what makes the perk work: a body the
// player cannot remove is a WALL, and the answer to a wall is to swim until it
// isn't between you and what you are shooting at.
//
// The turtles hold station on the line between the boss and the player, spread
// across it, and they are driven directly (`perkDrive`) rather than steered by
// their own behaviour: a drifting turtle wanders off the line within a second
// and the screen stops being a screen.
//
// EACH ONE HAS A LIFESPAN. Without it, a long fight ends up with a permanent
// wall and the player has no window at all — the perk would be a damage
// reduction wearing an animal costume. They expire, they swim away, and the
// boss calls up another: the fight has gaps in it, and the gaps are when you
// shoot.
function updateTurtles(dt, scene, e, r, playerPos, dirX, dirY) {
  const p = active.perk;
  const want = Math.max(1, p.count ?? 3);
  const hold = (p.radius ?? 5);
  const speed = p.speed ?? 3;

  // Retire the dead and the expired. `enemies.includes` is the authority on
  // what still exists — a turtle can leave the water by routes this module
  // never hears about (a new boss's clear-out, a run reset).
  for (let i = active.escorts.length - 1; i >= 0; i--) {
    const t = active.escorts[i];
    t.escortLife -= dt;
    const gone = !enemies.includes(t) || t.hp <= 0;
    if (gone) { active.escorts.splice(i, 1); continue; }
    if (t.escortLife > 0) continue;
    // Time served. Handed back to its own steering and sent home, rather than
    // deleted — a turtle that vanished mid-screen would look like a bug in the
    // one perk whose whole job is being visibly in the way.
    t.perkDrive = false;
    t.leaving = true;
    active.escorts.splice(i, 1);
  }

  active.timer -= dt;
  if (active.escorts.length < want && active.timer <= 0) {
    active.timer = Math.max(0.5, p.cooldown ?? 6);
    // Spawned AT the boss and told to swim out to the line, so a new turtle
    // visibly arrives from the animal that called it rather than appearing in
    // front of the player.
    const t = spawnNamed(scene, 'seaTurtle', 0, {
      x: e.mesh.position.x + dirX * r * 0.6,
      y: e.mesh.position.y + dirY * r * 0.6,
    }, { ignoreCaps: true });
    if (t) {
      t.escortLife = p.duration ?? 14;
      t.perkDrive = true;
      active.escorts.push(t);
    }
  }

  // Station-keeping. Spread along the perpendicular to the boss-player line so
  // three turtles are a fence rather than a column.
  const n = active.escorts.length;
  for (let i = 0; i < n; i++) {
    const t = active.escorts[i];
    const offset = n > 1 ? (i - (n - 1) / 2) * (t.radius * 2.6) : 0;
    const wantX = e.mesh.position.x + dirX * hold + -dirY * offset;
    const wantY = e.mesh.position.y + dirY * hold + dirX * offset;
    const dx = wantX - t.mesh.position.x;
    const dy = wantY - t.mesh.position.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.15) { t.vx = 0; t.vy = 0; continue; }
    // Eased into rather than driven at full speed, so a turtle arriving at its
    // post settles instead of oscillating across it.
    const v = Math.min(speed, d * 3);
    t.vx = (dx / d) * v;
    t.vy = (dy / d) * v;
    // Face the way it is going, like every other creature — the integrator in
    // updateEnemies does not do this for a body it isn't steering.
    t.heading = Math.atan2(t.vy, t.vx);
  }
}
