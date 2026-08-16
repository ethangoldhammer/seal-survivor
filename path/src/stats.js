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
    // THE STRIKE'S DAMAGE — spent as one small blast at the point of release
    // (see CONFIG.strike.burst), and only trickled onto contact if
    // `contactShare` is dialled up. Starts small and climbs with every card in
    // the strike family.
    //
    // Deliberately NOT seeded from CONFIG.strike.damage: that one is the
    // nominal strike the riders (Bone Shrapnel, Glow Up!) measure themselves
    // against, it is the number the tuner has always written, and sharing it
    // would put a slider in a fight with this.
    strikeDamage: CONFIG.strike.burst.damage,
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

    // Damage dealt by THROWN and LAUNCHED abilities — mussels, scallops,
    // starfish, ricochets, the shrimp ring, the mussel barrage, oyster pearls.
    // Their damage lives in CONFIG.<ability> rather than here, because each is
    // that ability's own number rather than a property of the seal; this is the
    // one run-scoped multiplier over the top of all of them.
    //
    // It exists because of rarity. Most of those upgrades add a COUNT, and a
    // count can't take a 1.25x — so a high-rarity Scallop Squirter pays into
    // this instead of into a fractional shell (see systems/rarity.js). Nothing
    // else writes it today, which is why it is 1 in every run that never sees a
    // rare projectile card.
    abilityDamageMul: 1,

    // --- the two damage-scaling cards ----------------------------------------
    // Neither of these grants an ability either, and neither is spent inside
    // apply(): what they are worth depends on something apply() cannot see. So
    // apply() only counts the stacks, and applyDamageScaling() below spends
    // them once the rest of the block is built. See the note there.
    maneaterLevel: 0,
    ironLungLevel: 0,

    // Upgrade-gated systems — 0/false until the matching upgrade is taken.
    homingShotLevel: 0,
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
    laserEyesLevel: 0,
    starfishLevel: 0,
    seagullLevel: 0,
    belugaLevel: 0,
    sealTeamLevel: 0,
    bakalarLevel: 0,
    calamariLevel: 0,
    dumboLevel: 0,
    harpLevel: 0,
    scallopCount: 0,
    oysterLevel: 0,
    octoGrabLevel: 0,
    orcaLevel: 0,
    musselVolleyLevel: 0,
    clubLevel: 0,
    clubThrowLevel: 0,
    clubBoomLevel: 0,
    clubIceLevel: 0,
  };
}

// ============================================================================
// WHICH STATS ARE WHOLE NUMBERS.
//
// Every field here is a COUNT or a LEVEL INDEX: how many shrimp are in the
// ring, how many stacks of Sea Garlic you have. A fractional one is either
// meaningless or actively broken — `sealTeamLevel: 2.4` resolves to two seals
// and silently throws the 0.4 away, and `multishot: 1.2` fires one pellet.
//
// The rarity system is the only thing that reads this, and it reads it to know
// what NOT to touch: a high-rarity card amplifies the continuous half of what
// its apply() did and pays the rest out somewhere else entirely. See
// systems/rarity.js.
//
// Listed explicitly rather than sniffed from the value, because the test is
// "is this field conceptually a count", not "does it happen to hold an integer
// right now" — `pierce` is 0 in a fresh block and so is `regenPerSec`, and
// exactly one of them may take a fraction.
// ============================================================================
export const INTEGER_STATS = new Set([
  'multishot', 'pierce', 'missileCount', 'shrapnelCount', 'shrimpCount',
  'scallopCount', 'bounceMaxBounces', 'projectileBonus',
  'breachChainLevel', 'garlicLevel', 'bounceLevel', 'eelLevel', 'laserEyesLevel', 'starfishLevel',
  'maneaterLevel', 'ironLungLevel', 'homingShotLevel',
  'seagullLevel', 'belugaLevel', 'sealTeamLevel', 'bakalarLevel', 'calamariLevel',
  'dumboLevel', 'harpLevel', 'oysterLevel', 'octoGrabLevel', 'orcaLevel', 'musselVolleyLevel',
  'biolumLevel', 'clubLevel', 'clubThrowLevel', 'clubBoomLevel', 'clubIceLevel',
]);

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

// ============================================================================
// THE TWO CARDS THAT SCALE EVERYTHING, spent here rather than in their apply().
//
// Maneater and Iron Lung both promise "+damage to everything", and neither one
// can be written as arithmetic inside apply():
//
//   MANEATER is paid per HUMAN EATEN, which is a running total that climbs
//   mid-level. apply() runs in recomputeStats() and is replayed from scratch
//   every time — it has no access to the run, and it must not have any: the
//   card-text prober and tools/upgrade-test.mjs both replay apply() against a
//   synthetic stat block, and an apply() that read live run state would report
//   whatever the last run happened to be doing.
//
//   IRON LUNG is paid per point of MAX OXYGEN, which is a stat OTHER cards
//   move. apply() runs in PICK ORDER — the same reason Clone Warz is spent at
//   the point of use (see projectileBonus above) — so an Iron Lung taken
//   before Deep Lungs would be measured against a tank that had not grown yet,
//   and taking the same two cards in the other order would be a different run.
//
// So apply() only COUNTS the stacks and this spends them, once, after every
// upgrade has been replayed and after applyLevelGrowth. Both are pure
// functions of the block plus one number the caller supplies, which keeps the
// whole thing replayable in Node.
//
// WHAT "ALL DAMAGE" REACHES. The multiplier lands on the four stats every
// damage number in the game is eventually derived from: the gun (`damage`,
// which the eel also fires at), the dash (`strikeDamage`, and the strike
// family rides on top of it), everything thrown or launched
// (`abilityDamageMul`, spent through scaling.abilityDamage) and every escort
// (`companionDamageMul`, spent through scaling.companionDamage). A handful of
// auras and beams still read their damage straight off CONFIG and are NOT
// scaled by this — see the note on abilityDamageMul above for why those
// numbers live where they do.
//
// Mutates `s` and returns it.
// ============================================================================

/** The accumulated Maneater bonus as a multiplier — 1 for a run without it. */
export function maneaterMul(s, humansEaten = 0) {
  const c = CONFIG.maneater ?? {};
  const level = s.maneaterLevel ?? 0;
  if (!c.enabled || level <= 0) return 1;
  const meals = Math.max(0, humansEaten);
  const bonus = (c.damagePerMeal ?? 0) * level * meals;
  return 1 + Math.min(bonus, c.maxBonus ?? Infinity);
}

/**
 * WHAT MANEATER IS WORTH SO FAR, as the line printed on its proc toast — the
 * accumulated bonus to all damage, and whether it has stopped climbing.
 *
 * Derived from maneaterMul rather than re-multiplying `damagePerMeal` here, for
 * the same reason an upgrade card's description is measured instead of typed:
 * two copies of the arithmetic drift the moment one of them is retuned, and the
 * copy that drifted would be the one the player is reading. The cap in
 * particular is the number the card is silently ABOUT — once it is reached,
 * every further body is worth nothing, and a readout that kept saying "+150%"
 * without saying that would be telling the truth and lying at the same time.
 */
export function maneaterReadout(s, humansEaten = 0) {
  const bonus = maneaterMul(s, humansEaten) - 1;
  const pct = `+${Math.round(bonus * 100)}%`;
  const max = CONFIG.maneater?.maxBonus ?? Infinity;
  return bonus >= max ? `${pct} MAX` : pct;
}

/**
 * The Iron Lung bonus as a multiplier — 1 for a run without it.
 *
 * Read off `s.maxOxygen`, which is the whole point of the card: every stack of
 * Deep Lungs, and anything else that ever widens the tank, is a damage upgrade
 * for as long as this is held.
 */
export function ironLungMul(s) {
  const c = CONFIG.ironLung ?? {};
  const level = s.ironLungLevel ?? 0;
  if (!c.enabled || level <= 0) return 1;
  const bonus = (c.damagePerOxygen ?? 0) * level * Math.max(0, s.maxOxygen ?? 0);
  return 1 + Math.min(bonus, c.maxBonus ?? Infinity);
}

export function applyDamageScaling(s, humansEaten = 0) {
  const mul = maneaterMul(s, humansEaten) * ironLungMul(s);
  if (mul === 1) return s;
  s.damage *= mul;
  s.strikeDamage *= mul;
  s.abilityDamageMul *= mul;
  s.companionDamageMul *= mul;
  return s;
}
