// ============================================================================
// STAT BLOCK — the run's numbers, seeded from CONFIG before any upgrade runs.
//
// This was inline in recomputeStats(). It lives here because it has to be
// readable WITHOUT the game: tools/upgrade-test.mjs replays every upgrade's
// apply() against this seed to check the math, and it can't import player.js
// to get it — that file pulls in three.js, the animation controller and the
// aim rig, none of which exist in Node.
//
// The alternative was for the test to keep its own copy of the seed, which
// would have made it a test of a stale duplicate rather than of the game. So:
// one seed, imported by both. This file imports CONFIG and nothing else, the
// same rule that lets playtestAnalysis.js run in the terminal.
// ============================================================================

import { CONFIG } from './config.js';

// A fresh stat block at level 1 with no upgrades taken.
export function baseStats() {
  return {
    maxHp: CONFIG.player.maxHp,
    thrust: CONFIG.player.thrust,
    friction: CONFIG.player.friction,
    maxSpeed: CONFIG.player.maxSpeed,
    hitRadius: CONFIG.player.hitRadius,
    pickupRadius: CONFIG.player.pickupRadius,
    regenPerSec: CONFIG.player.regenPerSec,
    invulnAfterHit: CONFIG.player.invulnAfterHit,

    fireRate: CONFIG.weapon.fireRate,
    damage: CONFIG.weapon.damage,
    speed: CONFIG.weapon.speed,
    life: CONFIG.weapon.life,
    radius: CONFIG.weapon.radius,
    multishot: CONFIG.weapon.multishot,
    spread: CONFIG.weapon.spread,
    pierce: CONFIG.weapon.pierce,
    recoil: CONFIG.weapon.recoil,

    // Strike (the dash attack). Seeded from CONFIG the same way the bounce
    // fields below are, so the tuner sliders keep acting as the BASE value and
    // upgrades scale on top. Before this existed every strike number was read
    // straight off CONFIG at the point of use, which is why nothing in a
    // level-up could touch the dash. The charge meter's thresholds and
    // multipliers (minFire, damageMul*, reachMul*) deliberately stay on CONFIG
    // — they define what the mechanic IS, and an upgrade that moved them would
    // change the shape of the curve rather than the player's place on it.
    strikeDamage: CONFIG.strike.damage,
    strikeChainMul: CONFIG.strike.chainDamageMul,
    strikeDashSpeed: CONFIG.strike.dashSpeed,
    strikeDashDuration: CONFIG.strike.dashDuration,
    // How long the charge meter takes to fill by hand, and how much each chum
    // puts back mid-combo. Both are per-run so upgrades can tighten the
    // rhythm loop — a faster wind-up and a fatter bite per orb.
    strikeChargeTime: CONFIG.strike.charge.time,
    strikeChumRefill: CONFIG.strike.charge.chumRefill,
    // How wide the release gulp reaches (see CONFIG.strike.charge.gulp). Per-run
    // rather than read off CONFIG at the point of use, because Attractor scales
    // it — it's the mouth's reach, and the mouth is upgradeable.
    chumGulpRadius: CONFIG.strike.charge.gulp?.radius ?? 0,

    // Oxygen. Same reason: the bar, the suffocation FX and the refill all read
    // these now instead of CONFIG.oxygen, so they can't disagree about the cap.
    maxOxygen: CONFIG.oxygen.max,
    oxygenRefillRate: CONFIG.oxygen.refillRateSurface,

    // --- the four cross-cutting upgrades ------------------------------------
    // These four don't own an ability of their own; they scale abilities the
    // OTHER cards granted. That makes them the only stats in the block read
    // from a dozen call sites rather than one, so each is deliberately a plain
    // number with a neutral identity value — a run that never takes the card
    // multiplies by 1 or adds 0, and every consuming site can stay unconditional.

    // Clone Warz. Flat +N to every projectile count the player actually owns.
    // Applied at the point of use rather than in apply(), because apply() runs
    // in PICK ORDER: Clone Warz taken before Shrimp Ring would have nothing to
    // add to. See projectileCount() below, which is the only way this should
    // ever be read.
    projectileBonus: 0,
    // Splash Zone. Multiplies blast/aura/wave radii. `targetingMul` is the
    // gentler half — how far abilities LOOK for something, as opposed to how
    // far they reach once they've found it. Split because a card that widened
    // acquisition as hard as it widens explosions turns every companion into a
    // whole-arena sniper.
    aoeMul: 1,
    targetingMul: 1,
    // Big Rigz. Companion body scale (visual AND hitbox, so the size is real)
    // and the damage they do with it.
    companionScale: 1,
    companionDamageMul: 1,
    // Glow Up!. Which element the seal is wearing is NOT here — it's a run
    // identity rolled once on the card, and it lives on player.biolumElement.
    // This is only how far the element has been levelled.
    biolumLevel: 0,

    // Upgrade-gated systems — 0/false until the matching upgrade is taken.
    missileCount: 0,
    shrapnelCount: 0,
    breachChainLevel: 0,
    garlicLevel: 0,
    shrimpCount: 0,
    bounceLevel: 0,
    bounceFireRate: CONFIG.bounce.fireRate,
    bounceLife: CONFIG.bounce.life,
    bounceMaxBounces: CONFIG.bounce.maxBounces,
    eelLevel: 0,
    starfishLevel: 0,
    seagullLevel: 0,
    belugaLevel: 0,
    sealTeamLevel: 0,
    bakalarLevel: 0,
    calamariLevel: 0,
    dumboLevel: 0,
    scallopCount: 0,
    oysterLevel: 0,
    octoGrabLevel: 0,
    orcaLevel: 0,
    musselVolleyLevel: 0,
  };
}

// THE ONE WAY TO READ `projectileBonus`. Every site that spawns a countable
// number of somethings routes its count through here.
//
// The gate on `base > 0` is the whole point and the reason this is a function
// rather than an addition written out a dozen times: Clone Warz adds a shell
// to weapons you HAVE. An ability you never picked has a base of 0 and stays
// at 0, or one card would silently hand you a shrimp ring, a scallop and a
// mussel barrage you never took — each of which would then start firing with
// no model loaded and no feedback entry warmed.
//
// The basic shot is the one caller that can't be switched off, which is
// correct: you always have the gun.
export function projectileCount(base, s) {
  if (!(base > 0)) return 0;
  return base + (s?.projectileBonus ?? 0);
}

// Baseline growth, applied AFTER upgrades so the basic shot keeps pace as you
// level even on a run where you never picked a damage upgrade. Extra pellets
// arrive on a fixed cadence (every `levelsPerExtraShot`) on top of whatever
// Multishot added. Mutates `s` and returns it.
export function applyLevelGrowth(s, level) {
  const lvl = Math.max(1, level ?? 1);
  s.damage += CONFIG.weapon.damagePerLevel * (lvl - 1);
  s.speed += CONFIG.weapon.speedPerLevel * (lvl - 1);
  s.multishot += Math.floor((lvl - 1) / CONFIG.weapon.levelsPerExtraShot);
  return s;
}
