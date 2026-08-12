import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { removeEnemy } from '../entities/enemies.js';
import { player } from '../entities/player.js';
import { skyLight } from './daylight.js';
import { setNoiseGlow, setNoiseGlowPulse, clearNoiseGlow } from './noiseShader.js';
import { advanceCycles } from './beatSync.js';

// ============================================================================
// GLOW UP! — the seal's bioluminescence, and the only ELEMENT in the game.
//
// Every other upgrade adds something to the water. This one changes what the
// attacks you already have ARE: the basic shot and the strike start carrying a
// second damage packet with a status attached, in a colour the seal wears on
// its own skin.
//
// FOUR ELEMENTS, ONE ROLLED PER RUN. Which one is decided on the card and
// shown before the pick (see rollElementFor), so it's a variant you accept
// rather than a surprise. Every later stack deepens the one you already have.
// They are deliberately four different ANSWERS to a crowd rather than four
// damage numbers:
//
//   shock      picks a second target      — reaches past the one you aimed at
//   venom      rewards staying on one     — the focus-fire element
//   chill      buys space                 — the defensive one
//   infection  turns the crowd on itself  — the one that scales with density
//
// WHERE THE STATE LIVES. On the enemy, in fields seeded by spawnOne (see
// entities/enemies.js). Not in a Map keyed by enemy: enemies are spliced out of
// their array constantly and a Map would leak every corpse until the run ended.
// The fields are seeded rather than created on demand for the same reason
// stats.js seeds everything — `undefined - dt` is NaN, and a NaN timer never
// expires.
//
// WHERE THE TICK LIVES. One updateElements() call per frame from main.js,
// after combat has resolved. It is NOT inside combat.js's loops: applying
// damage there could remove enemies from the array being iterated, which is the
// same hazard main.js's `pendingSplashes` queue already exists to avoid.
//
// THE NIGHT RAMP is the reason this ability is bioluminescence and not
// "elemental damage" — see nightFactor().
// ============================================================================

// The active element for this run, or null before the first Glow Up! is taken.
// Module state rather than a stat, because it is an IDENTITY and not a number:
// recomputeStats() rebuilds the stat block from scratch on every level-up and
// every tuner nudge, which would re-roll the element several times a minute.
let element = null;

// Pending contagion bursts from hosts that died this frame. Drained by
// updateElements, for the array-mutation reason in the header.
const pendingBursts = [];

// --- mote pool --------------------------------------------------------------
// The little lights that orbit an infected fish and visibly TRAVEL to the next
// one when it spreads. Pooled to a hard ceiling: a maxed infection in a dense
// school would otherwise allocate a mesh per host per frame.
const motes = []; // { mesh, host, angle, phase, travel, tx, ty }
let moteGeo = null;
let moteMat = null;

const _v = new THREE.Vector3();

function cfg() {
  return CONFIG.biolum ?? {};
}

function elementCfg(id = element) {
  return cfg().elements?.[id] ?? null;
}

export function activeElement() {
  return element;
}

export function elementColor(id = element) {
  return elementCfg(id)?.color ?? 0xffffff;
}

// ---------------------------------------------------------------------------
// THE NIGHT RAMP
//
// `skyLight.night` already runs 0 by day to 1 in full dark, and a game day is
// twelve real minutes, so any run past the early levels crosses at least one
// dusk. Twilight counts for a share of it, so the ability visibly wakes up AT
// sunset rather than an hour after it.
//
// The damage bonus is deliberately small and the DURATION bonus is not. Twenty
// percent more damage is a number nobody can feel; a venom that ticks half
// again as long, or an infection with half again as long to find its next
// host, changes how the fight goes.
// ---------------------------------------------------------------------------
export function nightFactor() {
  const n = cfg().night;
  if (!n?.enabled || !CONFIG.dayNight?.enabled) return 0;
  const dark = skyLight.night ?? 0;
  const dusk = (skyLight.twilight ?? 0) * (n.twilightBoost ?? 0);
  return Math.min(1, dark + dusk);
}

/**
 * HOW AWAKE THE ELEMENT IS RIGHT NOW, 0..1. The one number both halves of the
 * ability read: what it does (applyElementalHit) and what it looks like
 * (updateElementSkin), so they can never disagree about whether the seal is
 * glowing while it is also poisoning things.
 *
 * WHY IT EXISTS. Bioluminescence at noon is a contradiction — the whole
 * conceit is light the deep sea makes for itself, and a seal blazing away
 * under a midday sun reads as a bug in the shader rather than as a power.
 * `nightStrengthMul` only ever made the glow BRIGHTER after dark; it never
 * turned it off, so the daytime seal was a permanently-lit animal with a
 * modest night bonus.
 *
 * A FADE, NOT A SWITCH. `nightFactor` already ramps through dusk (twilight
 * counts most of the way to night for this ability), so this rides it and the
 * ability wakes up across the sunset instead of popping on at a threshold.
 * `blendGamma` shapes that: above 1 holds it off until it is properly dark.
 *
 * Returns 1 — fully awake, always — when there is no clock to wait out.
 * Anything else would delete the ability outright from a run with the day
 * cycle switched off, and there would be no message saying why. Same failure
 * and the same answer as the nightlife spawn gate in entities/enemies.js.
 */
export function elementPower() {
  const n = cfg().night;
  if (!n?.enabled || !CONFIG.dayNight?.enabled) return 1;
  const floor = Math.min(1, Math.max(0, n.dayPower ?? 0));
  const t = Math.pow(nightFactor(), Math.max(0.05, n.blendGamma ?? 1));
  // A MAX, not a sum: the surge below is "the element is fully awake", and
  // adding it to a night that is already awake would push past 1 and quietly
  // make every status stronger after dark than the tuning says. At midnight a
  // surge is worth nothing, which is correct — it is a way of borrowing the
  // night, not of doubling it.
  return Math.max(floor + (1 - floor) * t, surge);
}

// ---------------------------------------------------------------------------
// BORROWED NIGHT — the moon's half of CONFIG.dayNight.pass.
//
// Fly through the moon and the seal comes out lit: for a few seconds the
// element runs at full dark-hour power whatever the clock says. This is the
// whole synergy, and it is deliberately worth exactly nothing to a run that
// never took Glow Up! — every reader of `elementPower` is already gated on
// there being an element at all.
//
// Module state for the same reason `element` is: recomputeStats() rebuilds the
// stat block on every level-up and every tuner nudge, and a surge living there
// would be cancelled by opening the upgrade screen.
//
// A CEILING rather than a stack. Two passes inside seven seconds extend the
// window; they do not make a brighter-than-night element, because there is no
// such thing — see the max in elementPower above.
let surge = 0; // 0..1, how awake the sky has made it
let surgeLeft = 0; // seconds remaining at full, before the fade
let surgeFade = 0; // ...and how long the fade itself takes

/**
 * @param seconds how long to hold it fully awake. The fade out is a quarter of
 *   that again on top, because an element that snapped off would read as the
 *   ability breaking rather than as the light going.
 */
export function surgeElement(seconds) {
  if (!(seconds > 0)) return false;
  // Nothing to wake up. Reported rather than silently held, so a caller can
  // skip the juice for a synergy the player hasn't got.
  if (!element || !cfg().enabled) return false;
  surge = 1;
  surgeLeft = Math.max(surgeLeft, seconds);
  surgeFade = Math.max(surgeFade, seconds * 0.25);
  return true;
}

/** How awake the sky has made the element, 0..1. For the readouts. */
export function elementSurge() {
  return surge;
}

function fadeSurge(dt) {
  if (surge <= 0) return;
  if (surgeLeft > 0) {
    surgeLeft = Math.max(0, surgeLeft - dt);
    return;
  }
  surge = Math.max(0, surge - dt / Math.max(0.05, surgeFade));
  if (surge <= 0) surgeFade = 0;
}

function nightDamageMul() {
  const n = cfg().night;
  return 1 + ((n?.damageMul ?? 1) - 1) * nightFactor();
}

function nightDurationMul() {
  const n = cfg().night;
  return 1 + ((n?.durationMul ?? 1) - 1) * nightFactor();
}

/** How far the element has been levelled — 0 when Glow Up! was never taken. */
function level() {
  return player.stats?.biolumLevel ?? 0;
}

/**
 * The CONFIG.feedback key for one element's impact — 'shock' -> 'elementHitShock'.
 *
 * Built rather than passed so the four entries stay a naming convention with
 * one rule, instead of a lookup table that a fifth element could be added to
 * without anyone noticing it was missing. `npm run test:upgrades` checks every
 * key fired anywhere in the source against CONFIG.feedback, and the harness in
 * tools/elements-test.mjs asserts that every configured element resolves to a
 * real one — so a new element with no juice fails the build rather than
 * shipping silent.
 */
export function elementHitEvent(id = element) {
  if (!id) return 'elementHitShock';
  return `elementHit${id[0].toUpperCase()}${id.slice(1)}`;
}

// ---------------------------------------------------------------------------
// THE ROLL
//
// Called by ui.js at DRAW time, once per card, so the card can name the element
// it is offering. Returns the element already carried if there is one — the
// roll happens on the first Glow Up! of a run and never again, which is what
// makes later stacks read as deepening rather than as a slot machine.
//
// `random` is injectable for the same reason drawUpgrades takes one: so the
// distribution can be checked without running the game.
// ---------------------------------------------------------------------------
export function rollElementFor(random = Math.random) {
  if (element) return element;
  const ids = Object.keys(cfg().elements ?? {});
  if (!ids.length) return null;
  return ids[Math.min(ids.length - 1, Math.floor(random() * ids.length))];
}

/** Lock in the element a card was offering. Called when the card is picked. */
export function commitElement(id) {
  if (!element && id) element = id;
}

/** What the card is called for a given roll — "Glow Up! 2: Venom". */
export function elementCardName(baseName, id, stack) {
  const label = elementCfg(id)?.label;
  if (!label) return `${baseName} ${stack}`;
  return `${baseName} ${stack}: ${label}`;
}

/** What the card says. First pick announces the element; later ones deepen it. */
export function elementCardDesc(id, stack) {
  const e = elementCfg(id);
  if (!e) return null;
  if (stack <= 1) return `${e.desc}. Stronger at night.`;
  return `${e.label}: +damage, +duration. Stronger at night.`;
}

// ===========================================================================
// APPLYING A HIT
// ===========================================================================

/**
 * Land the element on one enemy.
 *
 * Called from combat.js for gun pellets and from the strike's hit handler.
 * `share` is the fraction of the elemental packet this source carries — the
 * strike passes CONFIG.biolum.strikeFraction, because a dash through six fish
 * would otherwise apply six full-strength statuses on one frame and make the
 * gun, which the card is nominally about, irrelevant.
 *
 * Returns the bonus damage dealt, so the caller can attribute it.
 */
export function applyElementalHit(scene, enemy, baseDamage, enemiesList, hooks = {}, share = 1) {
  if (!element || !cfg().enabled || !enemy) return 0;
  const lv = level();
  if (lv <= 0) return 0;

  // Asleep in daylight. Folded into `share` rather than tested per effect
  // because `share` is already the "how much of a full hit is this" scalar
  // every element downstream honours — the shock's proc chance, the venom and
  // infection durations, the chill's slow — so one multiply fades the whole
  // ability together instead of four that can drift apart.
  //
  // Only APPLICATION is gated. A venom applied at midnight keeps ticking into
  // the morning: cancelling live statuses at sunrise would read as the poison
  // being cured by daylight, which is a different (and much stranger) rule
  // than the one this is implementing.
  const power = elementPower();
  if (power <= 0) return 0;
  share *= power;

  const c = cfg();
  const frac = (c.damageFraction ?? 0) + (c.damageFractionPerLevel ?? 0) * (lv - 1);
  const bonus = baseDamage * frac * share * nightDamageMul();

  enemy.hp -= bonus;
  const e = elementCfg();
  const x = enemy.mesh.position.x;
  const y = enemy.mesh.position.y;

  switch (element) {
    case 'shock': applyShock(scene, enemy, bonus, enemiesList, hooks, share); break;
    case 'venom': applyVenom(enemy, share); break;
    case 'chill': applyChill(enemy, share, hooks, x, y); break;
    case 'infection': applyInfection(enemy, share, 0); break;
    default: break;
  }

  hooks.onElementHit?.(x, y, element, e?.color ?? 0xffffff);
  return bonus;
}

// --- shock ------------------------------------------------------------------
// One extra body, sometimes. Everything about it resolves within the frame,
// which is why it needs no per-enemy state at all.
function applyShock(scene, from, packet, enemiesList, hooks, share) {
  const e = elementCfg('shock');
  if (!e || !enemiesList) return;
  const lv = level();
  const chance = Math.min(e.chanceMax ?? 1, (e.chance ?? 0) + (e.chancePerLevel ?? 0) * (lv - 1));
  if (Math.random() > chance * share) return;

  const hops = Math.max(1, Math.floor((e.arcs ?? 1) + (e.arcsPerLevel ?? 0) * (lv - 1)));
  const range2 = (e.arcRange ?? 6) ** 2;
  const damage = packet * (e.arcDamage ?? 0.7);

  let source = from;
  const struck = new Set([from]);
  for (let hop = 0; hop < hops; hop++) {
    let best = null;
    let bestD = range2;
    for (const other of enemiesList) {
      if (struck.has(other)) continue;
      const dx = other.mesh.position.x - source.mesh.position.x;
      const dy = other.mesh.position.y - source.mesh.position.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD) { bestD = d2; best = other; }
    }
    if (!best) break;

    struck.add(best);
    hooks.onArc?.(
      source.mesh.position.x, source.mesh.position.y,
      best.mesh.position.x, best.mesh.position.y,
    );
    best.hp -= damage;
    best.flash = CONFIG.fx.hitFlash;
    best.hitThisFrame = true;
    hooks.onEnemyDamaged?.(best, damage, best.mesh.position.x, best.mesh.position.y);
    if (best.hp <= 0) {
      const idx = enemiesList.indexOf(best);
      hooks.onEnemyKilled?.(best);
      if (idx >= 0) removeEnemy(scene, idx);
      break; // the chain died with its victim; don't hop off a corpse
    }
    source = best;
  }
}

// --- venom ------------------------------------------------------------------
function applyVenom(enemy, share) {
  const e = elementCfg('venom');
  if (!e) return;
  enemy.venomStacks = Math.min(e.maxStacks ?? 5, (enemy.venomStacks ?? 0) + 1);
  // A fresh hit refreshes the WHOLE duration rather than each stack keeping its
  // own clock. One timer per enemy, and a fight you are actually in keeps its
  // own poison alive — which is the behaviour that makes venom feel like
  // pressure rather than bookkeeping.
  if (e.refreshes !== false || enemy.venomTimer <= 0) {
    enemy.venomTimer = (e.duration ?? 3) * nightDurationMul() * share;
  }
}

// --- chill ------------------------------------------------------------------

/**
 * PUT ICE ON A BODY. The one implementation of what chill IS — slow that
 * accumulates, saturates, and locks the thing solid when it does.
 *
 * Exported because chill is no longer only an element. The ice club applies
 * the same status from a completely different system (systems/club.js), and
 * the alternative was a second set of fields that meant "slowed" — which the
 * enemy integrator, the crab collider and every targeting scan would each have
 * had to learn about separately.
 *
 * The SHAPE stays here (how far slow may stack, where it saturates, that a
 * freeze spends it) while the AMOUNTS come from the caller, because those are
 * the caller's balance: an element scales on its own level, a club on the
 * club's.
 *
 * @param enemy
 * @param amount   slow to add, 0..1
 * @param duration seconds the slow lasts before it thaws
 * @param freezeFor seconds a saturating hit locks the body for
 * @param hooks    { onFreeze(x, y) }
 * @returns true if THIS hit saturated and froze the body. Cold Snap has no
 *   damage of its own, so a freeze is the only output it has — the caller
 *   records it as a control event, which is the whole reason this returns.
 */
export function chillEnemy(enemy, amount, duration, freezeFor, hooks, x, y) {
  const e = elementCfg('chill') ?? {};
  const max = e.maxSlow ?? 0.7;
  enemy.chillSlow = Math.min(max, (enemy.chillSlow ?? 0) + amount);
  enemy.chillTimer = Math.max(enemy.chillTimer ?? 0, duration);

  // Saturation locks it outright, reusing `trapTimer` — the beluga's field.
  // Reused on purpose: "held, inert, harmless" is a concept every system in the
  // game already agrees about, and a second one that meant the same thing would
  // be a second thing for the crab collider, the predation pass and the
  // targeting scans to each learn about separately.
  if (enemy.chillSlow >= max * (e.freezeAt ?? 0.98)) {
    enemy.trapTimer = Math.max(enemy.trapTimer ?? 0, freezeFor);
    // Spent. Without this the fish thaws straight back into the frozen state on
    // the next pellet and never moves again, which is a stun-lock rather than
    // an element.
    if (e.freezeResets !== false) {
      enemy.chillSlow = 0;
      enemy.chillTimer = 0;
    }
    hooks?.onFreeze?.(x, y);
    return true;
  }
  return false;
}

function applyChill(enemy, share, hooks, x, y) {
  const e = elementCfg('chill');
  if (!e) return;
  const lv = level();
  const per = ((e.slowPerHit ?? 0.16) + (e.slowPerHitPerLevel ?? 0) * (lv - 1)) * share;
  const dur = (e.freezeDuration ?? 0.9) + (e.freezeDurationPerLevel ?? 0) * (lv - 1);
  chillEnemy(enemy, per, (e.duration ?? 2.5) * nightDurationMul(),
    dur * nightDurationMul(), hooks, x, y);
}

/**
 * Thaw everything that is carrying chill.
 *
 * ITS OWN PASS, ahead of every gate in updateElements, and that is the whole
 * point of it: chill can now be put on a body by something that has nothing to
 * do with the run's element (the ice club), and the decay used to sit inside a
 * loop that is skipped outright when no element was rolled. A body chilled on
 * an elementless run would have stayed slowed for the rest of the run — the
 * slow is read as `chillTimer > 0`, so nothing else would ever have cleared it.
 */
export function thawChilled(dt, enemiesList) {
  for (const e of enemiesList) {
    if (!(e.chillTimer > 0)) continue;
    e.chillTimer -= dt;
    // Thaw gradually rather than snapping back to full speed: the slow decays
    // with its own timer so a fish that has stopped being shot visibly picks
    // its speed back up.
    if (e.chillTimer <= 0) { e.chillTimer = 0; e.chillSlow = 0; }
  }
}

// --- infection --------------------------------------------------------------
function applyInfection(enemy, share, generation) {
  const e = elementCfg('infection');
  if (!e) return;
  const lv = level();
  const falloff = (e.hopFalloff ?? 0.8) ** Math.max(0, generation);
  const dps = ((e.dps ?? 3.5) + (e.dpsPerLevel ?? 0) * (lv - 1)) * share * falloff * nightDamageMul();

  // Re-infecting an already-sick fish takes the STRONGER of the two rather
  // than stacking. Without that, a contagion that loops back on itself
  // compounds without limit and the whole school evaporates.
  if (enemy.infectTimer > 0 && enemy.infectDps >= dps) {
    enemy.infectTimer = Math.max(enemy.infectTimer, (e.duration ?? 5) * nightDurationMul());
    return;
  }
  enemy.infectDps = dps;
  enemy.infectGen = generation;
  enemy.infectTimer = (e.duration ?? 5) * nightDurationMul();
  enemy.infectSpreadTimer = e.spreadInterval ?? 1.2;
}

function infectedCount(enemiesList) {
  let n = 0;
  for (const e of enemiesList) if (e.infectTimer > 0) n += 1;
  return n;
}

/**
 * An infected host died — queue its burst.
 *
 * Called from main.js's single kill funnel. The burst is QUEUED rather than
 * applied here because this fires from inside combat.js's own iteration over
 * `enemies`; removing other entries on this frame would shift the array under
 * the running loop. Same hazard, same answer, as `pendingSplashes`.
 */
export function onEnemyKilled(enemy) {
  if (element !== 'infection' || !enemy || enemy.infectTimer <= 0) return;
  pendingBursts.push({
    x: enemy.mesh.position.x,
    y: enemy.mesh.position.y,
    generation: enemy.infectGen ?? 0,
  });
}

// ===========================================================================
// THE PER-FRAME TICK
// ===========================================================================

/**
 * hooks: { onEnemyDamaged(e, dmg, x, y), onEnemyKilled(e), onBurst(x, y, r),
 *          onSpread(fromX, fromY, toX, toY) }
 */
export function updateElements(dt, scene, enemiesList, hooks = {}) {
  // BEFORE both gates. Chill is not only an element any more — see thawChilled.
  thawChilled(dt, enemiesList);
  // Also before the gates, and for a related reason: a surge left burning by a
  // config switched off mid-run would never run down, and would still be there
  // multiplying the element the moment it came back on.
  fadeSurge(dt);

  if (!cfg().enabled) return;

  updateMotes(dt, scene);
  if (!element) return;

  if (element === 'infection') drainBursts(scene, enemiesList, hooks);

  for (let i = enemiesList.length - 1; i >= 0; i--) {
    const e = enemiesList[i];
    let dead = false;

    // (chill thaws in thawChilled, at the top of this function)

    if (e.venomTimer > 0) {
      e.venomTimer -= dt;
      e.venomTick -= dt;
      const c = elementCfg('venom');
      if (e.venomTick <= 0) {
        e.venomTick = c?.tick ?? 0.35;
        const lv = level();
        const dps = ((c?.dps ?? 4) + (c?.dpsPerLevel ?? 0) * (lv - 1)) * (e.venomStacks ?? 1);
        dead = damageOverTime(scene, enemiesList, i, e, dps * (c?.tick ?? 0.35) * nightDamageMul(), hooks);
      }
      if (!dead && e.venomTimer <= 0) { e.venomTimer = 0; e.venomStacks = 0; }
    }

    if (!dead && e.infectTimer > 0) {
      e.infectTimer -= dt;
      e.infectTick -= dt;
      const c = elementCfg('infection');
      if (e.infectTick <= 0) {
        e.infectTick = c?.tick ?? 0.4;
        dead = damageOverTime(scene, enemiesList, i, e, e.infectDps * (c?.tick ?? 0.4), hooks);
      }
      if (!dead) {
        creep(dt, e, enemiesList, hooks);
        if (e.infectTimer <= 0) { e.infectTimer = 0; e.infectDps = 0; }
      }
    }

    if (!dead && e.infectTimer > 0) ensureMotes(scene, e);
  }
}

// Shared by venom and infection: apply a tick, and handle the kill. Returns
// whether the enemy died, so the caller stops touching a spliced-out entry.
function damageOverTime(scene, enemiesList, index, e, amount, hooks) {
  if (!(amount > 0)) return false;
  e.hp -= amount;
  e.hitThisFrame = true;
  hooks.onEnemyDamaged?.(e, amount, e.mesh.position.x, e.mesh.position.y);
  if (e.hp > 0) return false;
  hooks.onEnemyKilled?.(e);
  removeEnemy(scene, index);
  return true;
}

// The contagion creeping to a neighbour while its host is still alive.
function creep(dt, host, enemiesList, hooks) {
  const c = elementCfg('infection');
  if (!c) return;
  host.infectSpreadTimer -= dt;
  if (host.infectSpreadTimer > 0) return;
  host.infectSpreadTimer = c.spreadInterval ?? 1.2;

  const nextGen = (host.infectGen ?? 0) + 1;
  if (nextGen > (c.generations ?? 4)) return;
  if (infectedCount(enemiesList) >= (c.maxHosts ?? 14)) return;

  const lv = level();
  const range = (c.spreadRange ?? 3.4) + (c.spreadRangePerLevel ?? 0) * (lv - 1);
  const range2 = range * range;

  let taken = 0;
  for (const other of enemiesList) {
    if (taken >= (c.spreadPerHop ?? 1)) break;
    if (other === host || other.infectTimer > 0) continue;
    const dx = other.mesh.position.x - host.mesh.position.x;
    const dy = other.mesh.position.y - host.mesh.position.y;
    if (dx * dx + dy * dy > range2) continue;
    applyInfection(other, 1, nextGen);
    // The mote makes the jump visible. Without it the second fish simply turns
    // green somewhere else on screen and the contagion reads as coincidence
    // rather than as something that travelled.
    sendMote(host, other);
    hooks.onSpread?.(
      host.mesh.position.x, host.mesh.position.y,
      other.mesh.position.x, other.mesh.position.y,
    );
    taken += 1;
  }
}

// The burst a dead host leaves: straight damage to everything close, plus fresh
// infections in whatever survives it.
function drainBursts(scene, enemiesList, hooks) {
  if (!pendingBursts.length) return;
  const c = elementCfg('infection');
  const lv = level();
  const radius = (c?.burstRange ?? 4.5) + (c?.burstRangePerLevel ?? 0) * (lv - 1);
  const damage = ((c?.burstDamage ?? 9) + (c?.burstDamagePerLevel ?? 0) * (lv - 1)) * nightDamageMul();
  const r2 = radius * radius;

  for (const b of pendingBursts) {
    hooks.onBurst?.(b.x, b.y, radius);
    const nextGen = b.generation + 1;
    const canSpread = nextGen <= (c?.generations ?? 4);
    let taken = 0;

    for (let i = enemiesList.length - 1; i >= 0; i--) {
      const e = enemiesList[i];
      const dx = e.mesh.position.x - b.x;
      const dy = e.mesh.position.y - b.y;
      if (dx * dx + dy * dy > r2) continue;

      if (damageOverTime(scene, enemiesList, i, e, damage, hooks)) continue;
      if (!canSpread || taken >= (c?.burstTargets ?? 3)) continue;
      if (e.infectTimer > 0) continue;
      if (infectedCount(enemiesList) >= (c?.maxHosts ?? 14)) break;
      applyInfection(e, 1, nextGen);
      taken += 1;
    }
  }
  pendingBursts.length = 0;
}

// ===========================================================================
// THE MOTES — the little lights that orbit a host and travel when it spreads.
// ===========================================================================

function moteMaterial() {
  if (!moteMat) {
    const c = elementCfg('infection');
    moteMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(c?.color ?? 0x66ff9e),
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }
  return moteMat;
}

function moteGeometry(size) {
  // One shared geometry for every mote. A plane rather than a sphere: these are
  // meant to read as points of light, and at this size a sphere is the same
  // pixels for eight times the vertices.
  if (!moteGeo) moteGeo = new THREE.PlaneGeometry(size, size);
  return moteGeo;
}

function moteConfig() {
  return elementCfg('infection')?.motes ?? {};
}

// Give a host its full complement of motes, if the pool has room.
function ensureMotes(scene, host) {
  const m = moteConfig();
  if (m.enabled === false) return;
  let mine = 0;
  for (const mo of motes) if (mo.host === host) mine += 1;
  const want = m.perHost ?? 5;
  if (mine >= want) return;
  if (motes.length >= (m.maxAlive ?? 90)) return;

  const mesh = new THREE.Mesh(moteGeometry(m.size ?? 0.09), moteMaterial());
  mesh.position.copy(host.mesh.position);
  scene.add(mesh);
  motes.push({
    mesh,
    host,
    angle: Math.random() * Math.PI * 2,
    phase: Math.random() * Math.PI * 2,
    travel: 0,
    tx: 0,
    ty: 0,
    target: null,
  });
}

// Peel one of the host's motes off and send it to the fish being infected.
function sendMote(host, target) {
  for (const mo of motes) {
    if (mo.host !== host || mo.travel > 0) continue;
    mo.travel = 1;
    mo.target = target;
    return;
  }
}

function updateMotes(dt, scene) {
  const m = moteConfig();

  for (let i = motes.length - 1; i >= 0; i--) {
    const mo = motes[i];
    const host = mo.travel > 0 ? mo.target : mo.host;

    // Host gone, or cured. The mote goes with it — a light orbiting nothing is
    // the clearest possible sign of a leak.
    if (!host || !host.mesh || host.mesh.parent == null
      || (mo.travel <= 0 && host.infectTimer <= 0)) {
      scene.remove(mo.mesh);
      motes.splice(i, 1);
      continue;
    }

    mo.angle += (m.orbitSpeed ?? 2.2) * dt;
    mo.phase += (m.pulseSpeed ?? 5.5) * dt;

    const r = (host.radius ?? 0.5) * (m.orbitRadius ?? 0.65);
    _v.set(
      host.mesh.position.x + Math.cos(mo.angle) * r,
      host.mesh.position.y + Math.sin(mo.angle) * r * 0.7,
      host.mesh.position.z + 0.15,
    );

    if (mo.travel > 0) {
      // In flight between two fish. Eased toward the new host and then handed
      // over, so the jump is something you watch cross the gap.
      const step = (m.travelSpeed ?? 9) * dt;
      const d = mo.mesh.position.distanceTo(_v);
      if (d <= step) {
        mo.mesh.position.copy(_v);
        mo.host = mo.target;
        mo.target = null;
        mo.travel = 0;
      } else {
        mo.mesh.position.lerp(_v, Math.min(1, step / d));
      }
    } else {
      mo.mesh.position.copy(_v);
    }

    // Pulse and bloom. The amplitude rides above 1 so the bright pass catches
    // the peak — post.js renders to a HalfFloat target, so this blooms instead
    // of clipping to white.
    const pulse = 1 + Math.sin(mo.phase) * (m.pulseAmp ?? 0.6);
    // The material is SHARED across every mote, so only per-object properties
    // can carry the variation — scale and opacity. Colour is written once when
    // the material is built, not here: sixty writes a second of an identical
    // hex value is the same picture for the cost of a uniform upload per mote.
    mo.mesh.scale.setScalar(Math.max(0.05, pulse));
    mo.mesh.material.opacity = Math.min(1, 0.35 + 0.65 * pulse);
  }
}

// ===========================================================================
// THE SEAL'S OWN GLOW
//
// The element has to be visible on the PLAYER, not only on what the player
// shoots. Otherwise the one thing the card actually changed — the identity of
// your run — is invisible except in the damage numbers, and you have to
// remember which element you rolled.
//
// IT LIGHTS THE MARKINGS THE SEAL ALREADY HAS. furseal.glb ships no texture,
// so the seal's whole surface is the procedural mottling in
// systems/noiseShader.js (CONFIG.sealShader) — that pattern IS the animal, and
// the player has been looking at it since the first frame of the run.
// setNoiseGlow makes its BRIGHT patches emit in the element's colour and
// leaves everything else exactly where it was, so a glowing seal is
// recognisably the same seal.
//
// WHAT THIS REPLACED, and why, because the alternative is the obvious one:
// this used to attach a `biolumSkin` — the system built for glowing creatures
// — to the player and stamp the escort preset onto it. Three things were
// wrong with that, and all three were visible:
//
//   1. A SECOND PATTERN. The skin generates its own field ('veins'), unrelated
//      to the mottling underneath, so the light ran in shapes the seal did not
//      have. It read as a decal rather than as the animal lighting up.
//   2. THE BODY WENT DARK. A biolum skin multiplies the base colour down
//      (`bodyDarken`) so light reads as light. On a seal already mottled
//      near-black by its own noise, at night, against dark water, that is a
//      seal you cannot find.
//   3. IT COULD NOT BE UNDONE. instantiateBiolumSkin clones the material per
//      individual, and Material.clone() copies neither onBeforeCompile nor the
//      live uniform objects — so the clone silently LOST the noise shader
//      (permanently: the JSON-copied userData still claimed it was attached),
//      and every following run inherited the clone.
//
// Restamped only when something about the look actually changed — the night
// level is bucketed, because it moves continuously all run and repainting on
// every imperceptible change is the same picture for the cost of a sweep.
// ===========================================================================

// The body the glow is currently written onto, NOT a boolean. The seal's mesh
// is swapped in place whenever its model or Size changes from the T panel
// (rebuildShipBody), and a flag would say "already lit" about a body that no
// longer exists — the new seal would come back dark and stay that way for the
// rest of the run, which is indistinguishable from the element having stopped
// working.
let skinnedBody = null;
let skinKey = '';
// The breath, in cycles. Derived through advanceCycles so `pulseSync` can lock
// it to the music the same way every other glow in the game does — see
// systems/beatSync.js.
let glowCycle = 0;

/**
 * @param body   the seal's visual root
 * @param rawDt  unscaled seconds. Raw, not the hitstop-scaled dt: the seal's
 *               own light doesn't hold its breath because the game froze for
 *               60ms on a hit.
 */
export function updateElementSkin(body, rawDt = 0) {
  const s = cfg().skin;
  if (!body || !element || s?.enabled === false || !cfg().enabled) return;
  const lv = level();
  if (lv <= 0) return;

  // Every frame, and deliberately ahead of the early-out below: the breath is
  // the one part of this that is never idle. One uniform write.
  glowCycle = advanceCycles(glowCycle, s?.pulseSync, (s?.pulseSpeed ?? 1.6) / (Math.PI * 2), rawDt, 1);
  setNoiseGlowPulse(body, 1 + (s?.pulseAmp ?? 0.3) * Math.sin(glowCycle * Math.PI * 2));

  // Bucketed so a continuously-moving sun doesn't restamp every frame — see
  // the note above. 32 rather than 8 because this drives a FADE and not just a
  // brightness: at 8 the dusk hand-over is nine visible steps over about forty
  // seconds of real time, which reads as the glow stuttering on. At 32 it
  // restamps a bit under once a second through the transition and is smooth,
  // and still costs nothing at noon or midnight where the value is pinned.
  const power = Math.round(elementPower() * 32) / 32;
  const night = Math.round(nightFactor() * 8) / 8;
  const key = `${element}:${lv}:${night}:${power}`;
  // The body check is what survives a model swap from the tuner: same element,
  // same level, same sky, different materials underneath.
  if (key === skinKey && skinnedBody === body) return;
  skinKey = key;
  skinnedBody = body;

  const strength = ((s?.strength ?? 1.4) + (s?.strengthPerLevel ?? 0) * (lv - 1))
    * (1 + ((s?.nightStrengthMul ?? 1) - 1) * night)
    // ...and all the way to nothing in daylight. At power 0 the shader's own
    // branch drops out and the seal is an ordinary mottled animal again —
    // which is the whole crossfade, with nothing left over to undo.
    * power;

  setNoiseGlow(body, {
    color: elementColor(),
    // A near-white core on the hottest patches, so the light reads as light
    // coming out of the seal rather than as a coloured wash over it.
    tipColor: s?.tipColor ?? 0xffffff,
    white: s?.white ?? 0.35,
    coverage: s?.coverage ?? 0.3,
    contrast: s?.contrast ?? 2.2,
    // `patchScale`, not `scale` — see the note in CONFIG.biolum.skin. The
    // obvious name still holds a stale value from the pattern this replaced.
    scale: s?.patchScale ?? 5,
    strength,
  });
}

/**
 * Force the next updateElementSkin to restamp.
 *
 * For the tuner: the stamp is skipped unless the element, the level or the sky
 * moved, and none of those move when someone drags 'seal glow'. Without this
 * the sliders under Glow Up! appear dead until the next sunset.
 */
export function invalidateElementSkin() {
  skinKey = '';
}

// ===========================================================================
// LIFECYCLE
// ===========================================================================

export function resetElements(scene) {
  element = null;
  // THE GLOW COMES OFF THE SEAL, not just out of this module's bookkeeping.
  // Nothing rebuilds the body between runs and nothing rebuilds the ship
  // asset's materials at all, so the uniforms written last run are still on
  // the GPU: without this a run that ended lit up green opens lit up green,
  // keeps the last run's night brightness, and stays that way until the new
  // run happens to roll Glow Up! again. Clearing here rather than waiting for
  // updateElementSkin is the point — that function returns immediately while
  // `element` is null, so it is exactly the path that cannot fix this.
  clearNoiseGlow();
  skinnedBody = null;
  skinKey = '';
  glowCycle = 0;
  surge = 0;
  surgeLeft = 0;
  surgeFade = 0;
  pendingBursts.length = 0;
  for (const mo of motes) scene?.remove(mo.mesh);
  motes.length = 0;
}

/**
 * Clear the element off every enemy still in the water.
 *
 * Needed because the statuses outlive the thing that applied them: a run
 * restart rebuilds the stat block and re-rolls the element, but any creature
 * carried over would keep ticking with the old one's numbers.
 */
export function clearStatuses(enemiesList) {
  for (const e of enemiesList) {
    e.venomTimer = 0;
    e.venomStacks = 0;
    e.chillTimer = 0;
    e.chillSlow = 0;
    e.infectTimer = 0;
    e.infectDps = 0;
    e.infectGen = 0;
  }
}
