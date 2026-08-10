import { CONFIG } from '../config.js';
import { removeEnemy } from '../entities/enemies.js';

// The strike is a CHARGE-UP. Holding the button fills a single meter (about a
// second from empty); releasing spends it and gives the ship a strong
// velocity impulse toward the aim direction; any enemy touched during the
// short dash window takes damage and extends the "chain" — landing another
// strike within `chainWindow` of the last hit keeps the chain going and
// scales damage up further. How hard you charged sets both the damage and the
// dash's REACH, so a full-charge strike travels far enough to plough through
// what it just killed.
//
// That reach is the point, because the meter refills by EATING: every chum
// swallowed inside the combo window puts some back, and the moment it crosses
// to full again that scores a FOOD CHAIN link and leaves you charged for the
// next strike. Charge -> strike -> eat -> strike is a cycle that powers
// itself for as long as there is food in the water.
//
// EACH LINK COSTS MORE THAN THE LAST. A mouthful is worth less the deeper the
// chain already is (see chumRefillMul), so holding a long combo means finding
// progressively more food inside each window rather than the same amount over
// and over. That is the whole gate on the chain: it is not a timer you outrun,
// it is an appetite that grows.
//
// The chain also survives on things that aren't dash hits — emptying a school,
// breaching the surface with Porpoising taken; see chainStrike() and
// CONFIG.strike.chainOn. Blue orbs fill the meter outright, and their spawn is
// just a timer here; the caller (main.js) owns actually spawning them, since
// that needs the scene and the pickup system.

export const strikeState = {
  charge: 1,       // 0..1 — the FUEL bar. Burned by holding, refilled by food.
  pending: 0,      // power banked so far for the strike being wound up, 0..1
  charging: false, // holding AND there is fuel left to burn
  power: 0,        // the banked power the CURRENT dash was launched with, 0..1
  flash: 0,        // >0 = the bar is flashing, just spent (see strikeRing.js)
  active: false,
  dashTimeLeft: 0,
  dashDuration: 0, // what this dash's length was set to, for the i-frames
  dashDir: { x: 1, y: 0 },
  chainCount: 0,
  chainTimer: 0,
  invulnTimer: 0, // >0 = contact damage is ignored (see combat.js)
};

// Is a combo live? The dash itself plus the window that follows it. This gates
// the CHAIN LINK a refill can score — never the refill itself. A dash that
// connects with nothing opens no window, and gating refills on it would strand
// the player with a bar they had no way to fill.
export function isFeeding() {
  return strikeState.active || strikeState.chainTimer > 0;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Damage multiplier from how hard the live dash was charged. */
export function powerDamageMul() {
  const c = CONFIG.strike.charge;
  return lerp(c.damageMulMin, c.damageMulMax, strikeState.power);
}

export function isInvulnerable() {
  return strikeState.invulnTimer > 0;
}

const TAU = Math.PI * 2;

/**
 * Where a strike released right now would GO — the one rule, so the corridor
 * the lens draws and the impulse the dash gets can never disagree.
 *
 * Neither the swim direction nor the aim on its own was right. Launching along
 * movement alone ignored the cursor entirely, so a strike could only ever go
 * where you were already swimming; launching along aim alone fought the
 * momentum you had committed to. The dash now splits the difference: the
 * heading is the point HALFWAY between the two, so both hands steer it and
 * neither one wins outright. Pull the stick and the cursor together and they
 * agree; spread them and the dash goes between them, which is also the only
 * reading a player can predict from what's on screen.
 *
 * Interpolated as an ANGLE rather than by normalising move + aim. The vector
 * sum collapses to zero when the two are exactly opposed — the one case a
 * player WILL hit, swimming away from what they're shooting at — and would
 * hand back a NaN heading. Wrapping the delta into (-pi, pi] picks a side
 * deterministically instead. It also makes the halfway an angular halfway
 * regardless of how far the movement stick is pushed: a half-tilted stick
 * steers the dash exactly as much as a full one, since it is only ever asked
 * for a direction.
 *
 * A missing input hands the whole heading to the other: no movement means a
 * strike from a standstill still goes at the cursor, and no aim leaves it
 * along the swim. Both missing returns the zero vector — the caller checks it
 * and doesn't fire.
 *
 * @param move  input.move — NOT normalized (analog magnitude survives).
 * @param aim   input.aim — normalized in every path that writes it.
 * @param out   optional target, so the per-frame prediction allocates nothing.
 */
export function strikeDirection(move, aim, out = { x: 0, y: 0 }) {
  const mx = move?.x ?? 0, my = move?.y ?? 0;
  const ax = aim?.x ?? 0, ay = aim?.y ?? 0;
  const mLen = Math.hypot(mx, my);
  const aLen = Math.hypot(ax, ay);

  if (mLen <= 0.001) {
    out.x = aLen > 0.001 ? ax / aLen : 0;
    out.y = aLen > 0.001 ? ay / aLen : 0;
    return out;
  }
  if (aLen <= 0.001) {
    out.x = mx / mLen;
    out.y = my / mLen;
    return out;
  }

  const blend = Math.min(1, Math.max(0, CONFIG.strike.aimBlend ?? 0.5));
  const swim = Math.atan2(my, mx);
  // Wrapped into (-pi, pi] so the blend always takes the SHORT way round —
  // without it, aim at 179 deg and swim at -179 deg would sweep the dash the
  // long way through 358 deg and launch it backwards.
  let delta = Math.atan2(ay, ax) - swim;
  delta = ((delta + Math.PI) % TAU + TAU) % TAU - Math.PI;
  const heading = swim + delta * blend;
  out.x = Math.cos(heading);
  out.y = Math.sin(heading);
  return out;
}

// How much faster everything the player does gets while a chain is live —
// dash speed, top speed and thrust all read this, and so does the dash's own
// turn rate, so a fast combo curves just as tightly as a slow one.
// 1 when no chain is running.
export function comboSpeedMul() {
  if (strikeState.chainCount < 1 || strikeState.chainTimer <= 0) return 1;
  return Math.min(
    CONFIG.strike.comboSpeedMax,
    1 + CONFIG.strike.comboSpeedPerLevel * strikeState.chainCount,
  );
}

let orbTimer = 0;
const hitThisDash = new Set();
// source name -> seconds until that source may add another link. A chain
// source can arrive in bursts — a magnet sweep collects six orbs inside one
// frame — and without a floor between links that alone would hold a chain
// open indefinitely. Same reasoning as feedback.js's `sfxGaps`: a rate limit
// on the channel that can't take the pile-up.
const chainGaps = new Map();

function randomBetween(a, b) {
  return a + Math.random() * Math.max(0, b - a);
}

export function resetStrike() {
  // Starts full: the run opens with one strike ready rather than a second of
  // holding before anything can happen.
  strikeState.charge = 1;
  strikeState.pending = 0;
  strikeState.charging = false;
  strikeState.power = 0;
  strikeState.flash = 0;
  strikeState.active = false;
  strikeState.dashTimeLeft = 0;
  strikeState.dashDuration = 0;
  strikeState.chainCount = 0;
  strikeState.chainTimer = 0;
  strikeState.invulnTimer = 0;
  hitThisDash.clear();
  chainGaps.clear();
  orbTimer = randomBetween(CONFIG.strike.orbSpawnMin, CONFIG.strike.orbSpawnMax);
}

/**
 * Burn fuel into banked power. Called every frame from main.js with whether
 * any strike input is currently down.
 *
 * Holding drains the bar and banks exactly what it drained, so `pending` can
 * never exceed the fuel that was actually there — a nearly-empty bar buys a
 * nearly-powerless strike no matter how long the button is held down. The bar
 * running dry is the natural end of a wind-up.
 *
 * `pending` deliberately survives a release that didn't fire: letting go a
 * fraction under `minFire` and pressing again continues the same wind-up
 * instead of throwing the fuel already spent on it away.
 */
export function updateCharge(dt, held, stats) {
  if (!CONFIG.strike.enabled) return;

  strikeState.charging = !!held && strikeState.charge > 0;
  if (strikeState.charging) {
    // Never more than is in the tank, so the two always move together.
    const burn = Math.min(strikeState.charge, dt / Math.max(0.05, stats.strikeChargeTime));
    strikeState.charge -= burn;
    strikeState.pending = Math.min(1, strikeState.pending + burn);
  }
  if (strikeState.flash > 0) strikeState.flash = Math.max(0, strikeState.flash - dt);
}

/**
 * Spend the banked power. Called on RELEASE of the strike button. Returns true
 * if a dash launched, so the caller can apply the velocity impulse.
 *
 * There is no input buffer any more, and there is nothing left for one to do:
 * power is only ever banked while the button is held, so a release under the
 * threshold cannot become fireable later by waiting. Holding covers the case
 * the buffer used to — keep the button down on an empty bar and the wind-up
 * resumes by itself the moment food refills it.
 */
export function tryStrike(aimDir, stats) {
  if (!CONFIG.strike.enabled) return false;
  const c = CONFIG.strike.charge;

  // Not enough banked. `pending` is kept, not cleared: the fuel is already
  // spent, and confiscating the progress as well would punish a fumble twice.
  if (strikeState.pending < c.minFire) return false;

  // Snapshot what this dash was bought with. Damage and reach both read it for
  // the whole dash, so clearing `pending` on the next line can't retroactively
  // weaken a strike already in flight.
  strikeState.power = strikeState.pending;
  strikeState.pending = 0;
  strikeState.charging = false;
  // The bar flashing as the fuel becomes a strike.
  strikeState.flash = c.flashTime ?? 0.28;

  // Reach scales the dash's DURATION at constant speed, so the seal's velocity
  // stays readable and a big charge simply travels for longer.
  const duration = stats.strikeDashDuration * lerp(c.reachMulMin, c.reachMulMax, strikeState.power);
  strikeState.active = true;
  strikeState.dashTimeLeft = duration;
  strikeState.dashDuration = duration;
  strikeState.dashDir = { x: aimDir.x, y: aimDir.y };
  // i-frames cover this dash's own length plus a tail, rather than a fixed
  // total — a full-charge dash outlasts the old flat 0.45s, and would have
  // been the one strike in the game that ended with you exposed.
  strikeState.invulnTimer = duration + CONFIG.strike.invulnTail;
  hitThisDash.clear();
  return true;
}

/**
 * Put fuel back in the bar. Returns true when this fill CROSSED it to full
 * inside a live combo — i.e. when it earned a FOOD CHAIN link.
 *
 * The fill itself is never gated on the combo; only the link is. See the note
 * on CONFIG.strike.charge for why that separation is load-bearing.
 *
 * Crossing is what counts, not merely being full: topping up an already-full
 * bar is not an achievement, and without the `wasFull` guard a single orb
 * arriving every frame against a full bar would score a link every frame.
 */
function fillMeter(amount) {
  const wasFull = strikeState.charge >= 1;
  strikeState.charge = Math.min(1, strikeState.charge + amount);
  return isFeeding() && !wasFull && strikeState.charge >= 1;
}

/**
 * What one chum is worth RIGHT NOW, as a multiplier on stats.strikeChumRefill.
 *
 * Every link already on the chain makes the next mouthful count for less, so
 * each successive link takes more chum than the one before it — link one is
 * five chum at the default refill, link two about six, link three about seven.
 * Floored, or a deep chain ends up needing a bar's worth of food that isn't in
 * the water and dies to arithmetic instead of to anything the player did.
 *
 * Reads the LIVE chain: `chainCount` is left standing until the window expires
 * (see updateStrike), so an expired chain has to be discounted here or the
 * first mouthful of the next combo would still be paying the last one's price.
 *
 * Exported so the HUD and the tuner can show the same number the meter uses.
 */
export function chumRefillMul() {
  const c = CONFIG.strike.charge;
  const falloff = c.chainRefillFalloff ?? 1;
  if (falloff >= 1) return 1;
  const depth = strikeState.chainTimer > 0 ? strikeState.chainCount : 0;
  return Math.max(c.chainRefillFloor ?? 0, Math.pow(falloff, depth));
}

/**
 * A chum orb swallowed. ALWAYS puts fuel back — food is the bar's only source,
 * so gating this on anything would be a way to strand the player with an empty
 * bar. Returns true only when it topped the bar off inside a live combo, which
 * is the case the caller turns into a FOOD CHAIN link.
 */
export function feedChum(stats) {
  if (!CONFIG.strike.enabled) return false;
  return fillMeter(stats.strikeChumRefill * chumRefillMul());
}

// One link of the FOOD CHAIN. Starts a chain if none is running, extends the
// one that is, and refreshes the window either way. The single place the chain
// counter moves — every source below routes through here so a link means the
// same thing whatever caused it.
function extendChain() {
  const chaining = strikeState.chainTimer > 0;
  strikeState.chainCount = chaining ? strikeState.chainCount + 1 : 1;
  strikeState.chainTimer = CONFIG.strike.chainWindow;
  return strikeState.chainCount;
}

/**
 * Extend the chain from something that ISN'T a dash landing on an enemy —
 * collecting an orb, emptying a school, breaching the surface. Each source is
 * switchable and rate-limited independently (see
 * CONFIG.strike.chainOn), so one that fires every frame can't run the counter
 * away while the others stay honest.
 *
 * @param {string} source key in CONFIG.strike.chainOn
 * @param {number} links  how many links to add at once (Porpoising stacks)
 * @returns {number} the chain count after the links land, or 0 if the source
 *   is switched off, still cooling down, or the strike system is disabled —
 *   so the caller can treat 0 as "nothing happened, show nothing".
 */
export function chainStrike(source, links = 1) {
  if (!CONFIG.strike.enabled) return 0;
  const on = CONFIG.strike.chainOn;
  if (!on?.[source]) return 0;
  if (chainGaps.has(source)) return 0;

  const gap = on.cooldowns?.[source] ?? 0;
  if (gap > 0) chainGaps.set(source, gap);

  let chain = 0;
  for (let i = 0; i < Math.max(1, links); i++) chain = extendChain();
  return chain;
}

/**
 * A blue charge orb. Fills the meter outright — that IS the orb's identity,
 * and under the charge model "skip the second of winding up" is a far bigger
 * favour than the spare charge it used to hand over.
 *
 * Returns true when it filled the meter inside a live combo, exactly like
 * feedChum: it reached the chain through the meter, which is the only route
 * orbs have now.
 */
export function restoreCharge() {
  const filled = fillMeter(1);
  // An orb caught mid-dash is meant to read as "go again, right now" — so it
  // also refreshes the chain window. Without this you could grab the pickup
  // that lets you keep going and still watch the combo lapse while the dash
  // you're already in played out. Deliberately only while a dash is live: a
  // charge picked up cruising around shouldn't hold an old combo open.
  if (strikeState.active && strikeState.chainCount > 0) {
    strikeState.chainTimer = CONFIG.strike.chainWindow;
  }
  return filled;
}

// hooks: { onEnemyDamaged(e, dmg), onEnemyKilled(e), onChainHit(chainCount) }
// Returns { spawnOrb } — true on the frame the orb timer fires, so the caller
// can do the actual spawning.
//
// Takes the whole `stats` block rather than just the hit radius it used to:
// damage and the chain multiplier are per-run values now (see recomputeStats),
// so the upgrades can scale them.
export function updateStrike(dt, scene, playerPos, stats, enemiesList, hooks) {
  // No recharge tick any more — the meter has no passive regeneration at all.
  // It fills by holding the button or by eating, and nothing else, which is
  // what makes food the resource rather than time.
  if (strikeState.chainTimer > 0) {
    strikeState.chainTimer -= dt;
    if (strikeState.chainTimer <= 0) strikeState.chainCount = 0;
  }
  // Run down the per-source chain throttles. Deleting the entry is what
  // re-arms the source, so an idle one costs nothing until it next fires.
  for (const [source, left] of chainGaps) {
    const next = left - dt;
    if (next <= 0) chainGaps.delete(source);
    else chainGaps.set(source, next);
  }
  if (strikeState.invulnTimer > 0) strikeState.invulnTimer = Math.max(0, strikeState.invulnTimer - dt);

  if (strikeState.active) {
    strikeState.dashTimeLeft -= dt;
    if (strikeState.dashTimeLeft <= 0) strikeState.active = false;

    for (let i = enemiesList.length - 1; i >= 0; i--) {
      const e = enemiesList[i];
      if (hitThisDash.has(e)) continue;
      const dx = e.mesh.position.x - playerPos.x;
      const dy = e.mesh.position.y - playerPos.y;
      const reach = stats.hitRadius + e.radius + 0.3;
      if (dx * dx + dy * dy > reach * reach) continue;

      // A dash landing on an enemy is the original chain source and needs no
      // switch or cooldown — `hitThisDash` already caps it at one link per
      // creature per dash.
      extendChain();

      // Two independent multipliers, and they are meant to compound: how hard
      // you charged THIS strike, and how deep the chain already is. That
      // product is the whole reward curve — a full-charge strike landing on
      // link six is worth several times either one alone.
      const mul = Math.pow(stats.strikeChainMul, strikeState.chainCount - 1);
      const dmg = stats.strikeDamage * powerDamageMul() * mul;

      e.hp -= dmg;
      e.flash = CONFIG.fx.hitFlash;
      e.hitThisFrame = true;
      hitThisDash.add(e);
      hooks.onEnemyDamaged?.(e, dmg);
      hooks.onChainHit?.(strikeState.chainCount);

      if (e.hp <= 0) {
        hooks.onEnemyKilled?.(e);
        removeEnemy(scene, i);
      }
    }
  }

  orbTimer -= dt;
  let spawnOrb = false;
  if (orbTimer <= 0) {
    orbTimer = randomBetween(CONFIG.strike.orbSpawnMin, CONFIG.strike.orbSpawnMax);
    spawnOrb = true;
  }

  return { spawnOrb };
}
