// WHAT A LEVEL ACTUALLY BUYS — the numbers behind `+1 bakalar level`.
//
// THE HOLE THIS FILLS. `measure()` in upgradeText.js works by replaying an
// upgrade's own apply() and reporting what moved in the STAT BLOCK, which is
// exact and self-maintaining for every card that changes a stat. Half the
// roster does not:
//
//   apply: (s) => { s.bakalarLevel = (s.bakalarLevel ?? 0) + 1; }
//
// One number, and everything the card is actually about — the bomb's damage,
// how wide it goes off, how deep the net hangs, how often the boat comes round
// — is derived from that number inside systems/bakalar.js against CONFIG. So
// the most measurement anything could honestly say was "+1 bakalar level",
// which is true and tells a player nothing, and the gap was papered over with
// a hand-typed desc: "Trawler drags a net that hauls fish away: +net size,
// +sailings".
//
// THAT DESC IS ALREADY WRONG, which is the argument for this file in one line.
// The net's WIDTH does not scale with level at all (netGeometry multiplies the
// hull, not the stack); only its depth does. And the two biggest things a level
// buys — 22 more bomb damage and 1.1 more blast radius, per stack — are not
// mentioned. Nobody lied; the card was written once and the tuning moved, which
// is exactly what a typed number does and exactly what measuring stops.
//
// SO: one pure function per levelled ability, from a level to the quantities
// that level decides. The tip calls it at the level you hold and at the level
// you would hold, and subtracts — the same shape as measure(), against a
// different source of truth.
//
// TWO RULES MAKE IT HONEST:
//
//   THE SYSTEM USES THIS TOO. systems/bakalar.js imports these functions rather
//   than keeping its own copy, so the number on the tip is the number the bomb
//   goes off with, by construction. A readout that merely agreed with the
//   system today would disagree with it the first time either was retuned, and
//   the disagreement would be invisible — the whole failure this replaces.
//
//   THE STAT BLOCK IS PASSED IN, never read off the live player. Big Rigz
//   multiplies companion damage and Splash Zone widens blasts, and the tip's
//   question is "what will I have AFTER this pick" — which is a different block
//   from the current one. systems/scaling.js reads `player.stats` directly and
//   therefore cannot answer that; these take the block explicitly and the
//   callers hand over whichever one they mean.
//
// A LEAF, like stats.js and ease.js: CONFIG and nothing else. The tip's import
// graph reaches this, and systems/bakalar.js pulls in three.js, the arena and
// half the entity layer — routing the tip through that would drag the whole
// render layer into a tooltip and into every harness that builds one.
import { CONFIG, barDivisions, barRungIndex } from './config.js';

// The two multipliers a companion's numbers ride on, read off a PASSED block.
// Same expressions systems/scaling.js uses; it reads the live player, and these
// have to be answerable for a hypothetical one.
const companionDamage = (n, s) => n * (s?.companionDamageMul ?? 1);
const blastRadius = (n, s) => n * (s?.aoeMul ?? 1);
// The seal's own damage scaling — Maneater and Iron Lung — which rides
// everything the player deals rather than only what a companion does.
const abilityDamageOf = (n, s) => n * (s?.abilityDamageMul ?? 1);

// A level below 1 is not held at all. Clamped here rather than at each formula
// so a readout asked about stack 0 — which the tip does, for the card you have
// never taken — returns the shape of the answer rather than a negative one.
const lv = (level) => Math.max(1, level);

/**
 * BAKALAR'S BOAT, per level.
 *
 * `room` is how much water there is between the surface and the seabed, which
 * clamps the net's depth — the water column is finite and a maxed stack asks
 * for most of it (see netGeometry in systems/bakalar.js, which owns the
 * measurement). Left at Infinity the depth is what the card GRANTS rather than
 * what the arena allows, which is the right answer for a tip on a screen where
 * the arena may not exist yet, and the wrong one for the net itself.
 */
export function bakalarLevelStats(level, s = {}, room = Infinity) {
  const c = CONFIG.bakalar ?? {};
  const b = c.bomb ?? {};
  const k = c.catch ?? {};
  const n = lv(level);
  return {
    // The bomb — the moment you watch.
    bakalarBombDamage: companionDamage((b.damage ?? 0) + (b.damagePerLevel ?? 0) * (n - 1), s),
    bakalarBlast: blastRadius((b.radius ?? 0) + (b.radiusPerLevel ?? 0) * (n - 1), s),
    bakalarBombGap: Math.max(b.dropIntervalFloor ?? 0,
      (b.dropInterval ?? 0) - (b.dropIntervalPerLevel ?? 0) * (n - 1)),
    // The net — the quiet half, which is what the boat is FOR.
    bakalarNetDepth: Math.min(room, (c.netDepth ?? 0) + (c.netDepthPerLevel ?? 0) * (n - 1)),
    bakalarGrip: Math.max(0.01, (k.power ?? 0) + (k.powerPerLevel ?? 0) * (n - 1)),
    // How often the boat comes round at all. The NEAR EDGE of the window rather
    // than its middle: both ends slide by the same amount per level, so they
    // move together and the near one is what a player feels.
    bakalarSailGap: bakalarSailWindow(level).min,
  };
}

/**
 * The gap between sailings, as the window it is actually rolled from.
 *
 * SEPARATE FROM THE READOUT ABOVE because the two ends are not two facts. A tip
 * listing both would be reporting the spread of a random roll as though it were
 * something the pick had bought, and only the near edge is a promise — so the
 * readout carries `min` alone while the boat, which has to roll the number,
 * gets both from here rather than computing the far end itself.
 */
export function bakalarSailWindow(level) {
  const c = CONFIG.bakalar ?? {};
  const drop = (c.spawnFasterPerLevel ?? 0) * (lv(level) - 1);
  const min = Math.max(c.spawnMinFloor ?? 0, (c.spawnMin ?? 0) - drop);
  return { min, max: Math.max(min, (c.spawnMax ?? 0) - drop) };
}

/**
 * SEAGULL BOMB, per level.
 *
 * A level used to buy one thing — a faster gull, multiplicatively — so the most
 * honest readout it could ever have had was a single row saying the bird comes
 * round more often. It now buys the bomb as well: the direct hit, the blast and
 * the blast's reach all climb, which is what a card called Seagull BOMB should
 * have been selling all along.
 *
 * THE FIRE RATE IS NOT IN HERE, and that is the one asymmetry. It is a RATIO
 * (`base * pow(perLevel, n-1)`), and levelChanges reports every quantity as an
 * addition — so listing it would print "-0.35s" for something that is really
 * "x0.85". Left out until the readout can say which of its numbers are ratios;
 * the three that ARE additive are the three worth reading anyway.
 */
export function seagullLevelStats(level, s = {}) {
  const c = CONFIG.seagullBomb ?? {};
  const n = lv(level);
  return {
    seagullHit: companionDamage((c.damage ?? 0) + (c.damagePerLevel ?? 0) * (n - 1), s),
    seagullSplash: companionDamage((c.splashDamage ?? 0) + (c.splashDamagePerLevel ?? 0) * (n - 1), s),
    seagullSplashRadius: blastRadius((c.splashRadius ?? 0) + (c.splashRadiusPerLevel ?? 0) * (n - 1), s),
  };
}

/**
 * SEA GARLIC, per level.
 *
 * The checklist had this one down to skip — a level bought reach and nothing
 * else, so a readout would have been a table with a single row in it, saying
 * what the card's own name already said. It buys a harder bite now as well,
 * which is exactly the change that makes the row worth printing: two numbers,
 * and a player choosing between another stack and something else can see that
 * the aura is getting stronger and not just larger.
 */
export function garlicLevelStats(level, s = {}) {
  const c = CONFIG.garlic ?? {};
  const n = lv(level);
  return {
    // PER SECOND, not per tick. `damagePerTick` at a 0.25s interval is a
    // quarter of what a creature standing in the cloud actually takes, and the
    // tick is an implementation detail nobody outside this file should have to
    // hold. A DPS is the number a player is comparing against every other
    // ability they might take instead.
    garlicDps: abilityDamageOf(
      ((c.damagePerTick ?? 0) + (c.damagePerLevel ?? 0) * (n - 1))
      / Math.max(0.001, c.tickInterval ?? 0.25), s),
    garlicRadius: blastRadius((c.baseRadius ?? 0) + (c.radiusPerLevel ?? 1.2) * n, s),
  };
}

/**
 * THE FIVE COUNT-ONLY WEAPONS, per level.
 *
 * Multishot, Homing Mussels, Shrimp Ring, Scallop Squirter and Ricochet Rounds
 * all used to buy BODIES and nothing else — a fifteenth mussel doing exactly
 * what the first one did. That is the shape the note on CONFIG.garlic calls
 * out: an ability that gets bigger without getting stronger, which scales
 * worst against precisely the thing more bodies are for, since a crowd you are
 * failing to kill just gets more shells bouncing off it.
 *
 * So each stack now also buys a little damage and a little size. Small on
 * purpose — the count IS still the card, and these curves are the floor under
 * it, not a second ability bolted on.
 *
 * THESE FIVE ARE NOT IN LEVEL_STATS, and that is deliberate. Registering an
 * ability there replaces its tip's measured rows outright — see the note on
 * `derived` in ui/upgradeTip.js, "NO `next` ROW AND NO `total` ROW alongside
 * it" — which is right for an ability whose apply() moves one level counter
 * and wrong for these. Their apply() already measures the thing the card is
 * about: "+1 orbiting shrimp", and for Ricochet Rounds the fire rate, lifespan
 * and bounce budget as well. A table built from the two functions below would
 * report the damage and the size and DROP all of that.
 *
 * Reporting both needs the tip to merge a measured set with a derived one,
 * which it cannot do today. Until it can, these curves are real in the water
 * and unquoted on the card — which is the honest half-step, since the
 * alternative is a tip that says less than it did before.
 *
 * WHY THE TWO TERMS HAVE DIFFERENT SHAPES. Damage is absolute, because the
 * base is a weapons.csv number that means the same thing all run. Size is a
 * FRACTION of the base, because every one of these radii is a live tuner
 * slider — a flat `+0.06 a stack` is a seventh of the shipped shrimp and a
 * twenty-eighth of a tuned one, and a per-stack curve that means two different
 * things in two sessions is not a curve. See CONFIG.shrimpRing.sizePerLevel.
 */

/**
 * MULTISHOT. The odd one of the five, and both its terms are fractions.
 *
 * The other four read a damage straight off CONFIG, so an absolute step means
 * the same thing at level 3 and level 30. The basic shot's damage is `s.damage`
 * — it grows with every level and every gun card — so a flat bonus there would
 * be decisive early and rounding error late. A percentage keeps the share it
 * bought, which is the same argument applyLevelGrowth makes for maxHp.
 *
 * AND IT STOPS CLIMBING. `maxStacks` is 99, meaning "as many as you find",
 * which is a fine promise about pellets and a terrible one about a compounding
 * multiplier. `multishotScalingStacks` spends the curve by the tenth stack;
 * everything past it is pellets, which is what the card always sold.
 */
export function multishotLevelStats(level, s = {}) {
  const c = CONFIG.weapon ?? {};
  const n = Math.min(lv(level), c.multishotScalingStacks ?? Infinity);
  return {
    multishotDamage: (s.damage ?? c.damage ?? 0)
      * (1 + (c.damagePerMultishot ?? 0) * (n - 1)),
    multishotSize: (s.radius ?? c.radius ?? 0)
      * (1 + (c.radiusPerMultishot ?? 0) * (n - 1)),
  };
}

/** HOMING MUSSELS, per level. */
export function missileLevelStats(level, s = {}) {
  const c = CONFIG.missile ?? {};
  const n = lv(level);
  return {
    missileDamage: abilityDamageOf((c.damage ?? 0) + (c.damagePerLevel ?? 0) * (n - 1), s),
    missileSize: (c.radius ?? 0) * (1 + (c.sizePerLevel ?? 0) * (n - 1)),
  };
}

/**
 * SHRIMP RING, per level.
 *
 * `size` is not decoration here: the contact reach in systems/shrimpRing.js is
 * derived from the drawn scale, so a bigger shrimp is a shrimp that connects
 * from further out. That is the whole reason the size term is worth having on
 * this one — the picture and the hitbox are the same number, the way the
 * garlic cloud's are.
 */
export function shrimpRingLevelStats(level, s = {}) {
  const c = CONFIG.shrimpRing ?? {};
  const n = lv(level);
  return {
    shrimpDamage: abilityDamageOf((c.contactDamage ?? 0) + (c.damagePerLevel ?? 0) * (n - 1), s),
    shrimpSize: (c.scale ?? 0) * (1 + (c.sizePerLevel ?? 0) * (n - 1)),
  };
}

/** SCALLOP SQUIRTER, per level. */
export function scallopLevelStats(level, s = {}) {
  const c = CONFIG.scallop ?? {};
  const n = lv(level);
  return {
    scallopDamage: abilityDamageOf((c.damage ?? 0) + (c.damagePerLevel ?? 0) * (n - 1), s),
    scallopSize: (c.radius ?? 0) * (1 + (c.sizePerLevel ?? 0) * (n - 1)),
  };
}

/**
 * RICOCHET ROUNDS, per level.
 *
 * ONLY THE TWO NEW NUMBERS. The fire rate, lifespan and bounce budget this card
 * also buys are mutated straight onto the stat block by its apply(), so
 * measure() already reports them exactly — listing them here as well would put
 * every one of them on the tip twice, from two sources that can disagree.
 */
export function bounceLevelStats(level, s = {}) {
  const c = CONFIG.bounce ?? {};
  const n = lv(level);
  return {
    bounceDamage: abilityDamageOf((c.damage ?? 0) + (c.damagePerLevel ?? 0) * (n - 1), s),
    bounceSize: (c.radius ?? 0) * (1 + (c.sizePerLevel ?? 0) * (n - 1)),
  };
}

/**
 * ELECTRIC EEL, per level. Three numbers, all additive, all things a player
 * weighs against another card — the cleanest shape on the whole roster.
 */
export function eelLevelStats(level, s = {}) {
  const c = CONFIG.eel ?? {};
  const n = lv(level);
  return {
    eelDamage: abilityDamageOf((c.baseDamage ?? 0) + (c.damagePerLevel ?? 0) * (n - 1), s),
    eelChain: Math.round((c.baseMaxChain ?? 0) + (c.chainPerLevel ?? 0) * (n - 1)),
    eelChainRadius: blastRadius((c.baseChainRadius ?? 0) + (c.radiusPerLevel ?? 0) * (n - 1), s),
  };
}

/** CALAMARI RING, per level. */
export function calamariLevelStats(level, s = {}) {
  const c = CONFIG.calamari ?? {};
  const n = lv(level);
  return {
    calamariDamage: abilityDamageOf((c.damage ?? 0) + (c.damagePerLevel ?? 0) * (n - 1), s),
    calamariRadius: blastRadius((c.baseRadius ?? 0) + (c.radiusPerLevel ?? 0) * (n - 1), s),
    // Reaches its floor inside the cap, so it drops off the tip on late picks.
    calamariGap: Math.max(c.intervalFloor ?? 0,
      (c.interval ?? 0) - (c.intervalPerLevel ?? 0) * (n - 1)),
  };
}

/**
 * ORCA FAMILY, per level.
 *
 * Charge speed is deliberately last: it is real, and beside two numbers that
 * decide the fight it reads as flavour — so with the four-row cap it is the
 * one that gives way.
 */
export function orcaLevelStats(level, s = {}) {
  const c = CONFIG.orca ?? {};
  const n = lv(level);
  return {
    // THE COUNT IS THE LEVEL, capped at `count` — one whale per stack until the
    // family is complete. First in the readout because it is what the card
    // buys: the pod used to arrive whole and this row would have read 3, 3, 3.
    // podSize() in systems/orca.js is the same expression and the pod itself is
    // sized by it, so the number on the card is the number in the water.
    orcaCount: Math.min(n, c.count ?? n),
    orcaDamage: companionDamage((c.damage ?? 0) + (c.damagePerLevel ?? 0) * (n - 1), s),
    orcaGap: Math.max(c.attackIntervalFloor ?? 0,
      (c.attackInterval ?? 0) - (c.attackIntervalPerLevel ?? 0) * (n - 1)),
    orcaChargeSpeed: (c.chargeSpeed ?? 0) + (c.chargeSpeedPerLevel ?? 0) * (n - 1),
  };
}

/**
 * BABY BELUGA, per level.
 *
 * Deals no damage at all — a trapped fish is its entire output — so before this
 * its tip could only ever say "+1 beluga level" beside a count of bubbles
 * popped. Two numbers, and both are what you are actually buying.
 */
export function belugaLevelStats(level, s = {}) {
  const c = CONFIG.beluga ?? {};
  const n = lv(level);
  return {
    belugaBubble: blastRadius((c.baseBubbleRadius ?? 0) + (c.radiusPerLevel ?? 0) * (n - 1), s),
    belugaTrap: (c.trapDuration ?? 0) + (c.durationPerLevel ?? 0) * (n - 1),
  };
}

/**
 * DUMBO OCTOPUS, per level.
 *
 * Deals no damage whatsoever — a charmed fish is the entire output — so its tip
 * could only ever say "+1 dumbo octopus level" beside a count of charms. Its
 * targets step on a floor, which is the rounded case: at a fractional rate the
 * count only ticks every second or third level, and the flat rule keeps the row
 * visible on the picks in between.
 */
export function dumboLevelStats(level, s = {}) {
  const c = CONFIG.dumbo ?? {};
  const n = lv(level);
  return {
    dumboTargets: (c.targets ?? 0) + Math.floor((n - 1) * (c.targetsPerLevel ?? 0)),
    dumboCharm: (c.duration ?? 0) + (c.durationPerLevel ?? 0) * (n - 1),
    dumboGap: Math.max(c.intervalFloor ?? 0,
      (c.interval ?? 0) - (c.intervalPerLevel ?? 0) * (n - 1)),
    dumboRange: blastRadius((c.range ?? 0) + (c.rangePerLevel ?? 0) * (n - 1), s),
  };
}

/**
 * OCTOPUS GRABBER, per level. The other damageless card whose tip said nothing.
 * Arms is a rounded step like the dumbo's targets.
 */
export function octoGrabLevelStats(level, s = {}) {
  const c = CONFIG.octoGrab ?? {};
  const n = lv(level);
  return {
    octoArms: (c.arms ?? 0) + (c.armsPerLevel ?? 0) * (n - 1),
    octoReach: (c.reach ?? 0) + (c.reachPerLevel ?? 0) * (n - 1),
    octoReel: (c.reelSpeed ?? 0) + (c.reelSpeedPerLevel ?? 0) * (n - 1),
  };
}

/** MUSSEL BARRAGE, per level. Count and damage are the whole card. */
export function musselLevelStats(level, s = {}) {
  const c = CONFIG.musselVolley ?? {};
  const n = lv(level);
  return {
    musselCount: Math.max(1, Math.round((c.count ?? 0) + (c.countPerLevel ?? 0) * (n - 1))),
    musselDamage: abilityDamageOf((c.damage ?? 0) + (c.damagePerLevel ?? 0) * (n - 1), s),
    // A fraction of the hit, and last in the order — the four-row cap drops it
    // before it drops either of the two above.
    //
    // `(n - 1)` like every other formula here. The system spelled the same
    // curve as `* lv` with `lv = max(1, level) - 1` a few lines earlier, which
    // is the same number said differently — and reading it as `* n` while
    // wiring this up added a whole step to the splash at every level.
    musselSplash: abilityDamageOf(
      (c.splashDamage ?? 0) + (c.splashDamagePerLevel ?? 0) * (n - 1), s),
  };
}

// --- THE CLUB LINE ---------------------------------------------------------
//
// FOUR CARDS, AND THEY CROSS IN EXACTLY ONE PLACE. Worth writing down because
// two wrong versions of this were believed first.
//
// The checklist claimed a Driftwood pick quietly improved Boom Boom and Cold
// Snap. It does not: clubBlast takes clubBoomLevel and clubIce takes
// clubIceLevel, and neither looks at clubLevel at all.
//
// But "four independent levels" was wrong too, in the other direction. What a
// THROWN club hits for on its carom is read inside updateFlights, whose `level`
// comes from updateClub's `lv.club` — the DRIFTWOOD level. So Hurler's own
// level buys how MANY clubs go out and nothing about what they do, and every
// point of their damage is bought by the card next to it.
//
// That is why the carom sits in the Driftwood readout below rather than in
// Hurler's: a row on Hurler keyed to Hurler's level would show a number moving
// on a pick that does not move it, which is the precise failure this whole file
// exists to stop.
//
// `clubPower()` — the Bouncer's `clubDamageMul` — multiplies all four, and is a
// stat-block multiplier that measure() has always been able to see. It is
// folded into each readout because the tip's question is what YOUR club does.

/** DRIFTWOOD CLUB, per level. */
export function clubLevelStats(level, s = {}) {
  const c = CONFIG.club ?? {};
  const n = lv(level);
  const power = s?.clubDamageMul ?? 1;
  return {
    clubDamage: abilityDamageOf(((c.damage ?? 0) + (c.damagePerLevel ?? 0) * (n - 1)) * power, s),
    // The shaft, and with it the arc the swing draws. The Bouncer does not
    // reach this — reach is its own card's stat.
    clubReach: ((c.length ?? 0) + (c.lengthPerLevel ?? 0) * (n - 1)) * (s?.clubReachMul ?? 1),
    // THE THROWN CLUB'S CAROM, bought here and spent by Hurler. See above.
    clubCarom: abilityDamageOf(
      ((c.ricochetDamage ?? 0) + (c.ricochetDamagePerLevel ?? 0) * (n - 1)) * power, s),
    clubBounces: Math.floor((c.maxBounces ?? 0) + (c.bouncesPerLevel ?? 0) * (n - 1)),
  };
}

/** BOOM BOOM CLUB, per level. Independent of the Driftwood level. */
export function clubBoomLevelStats(level, s = {}) {
  const c = CONFIG.clubBoom ?? {};
  const n = lv(level);
  return {
    clubBoomDamage: abilityDamageOf(
      ((c.damage ?? 0) + (c.damagePerLevel ?? 0) * (n - 1)) * (s?.clubDamageMul ?? 1), s),
    // Splash Zone widens it; the Bouncer deliberately does not — how far an
    // explosion reaches is Splash Zone's stat, and a club card quietly widening
    // blasts would be one card doing another's job.
    clubBoomRadius: blastRadius((c.radius ?? 0) + (c.radiusPerLevel ?? 0) * (n - 1), s),
  };
}

/** COLD SNAP, per level. No damage at all — a freeze is the whole output. */
export function clubIceLevelStats(level) {
  const c = CONFIG.clubIce ?? {};
  const n = lv(level);
  return {
    clubIceFreeze: (c.freezeFor ?? 0) + (c.freezeForPerLevel ?? 0) * (n - 1),
    clubIceSlow: (c.slowPerHit ?? 0) + (c.slowPerHitPerLevel ?? 0) * (n - 1),
  };
}

/**
 * ZAPPY CLUB, per level — the chain a club hit throws.
 *
 * THE ONE READOUT IN THIS FILE THAT READS ANOTHER CARD'S LEVEL, and it has to.
 * The packet is a SHARE of what the swing hit for (see CONFIG.clubZap), so
 * every point of it is bought by the Driftwood level, a `damage` roll and the
 * Bouncer — none of which this card's own level touches. Reading them here is
 * what makes `clubZapDamage` the number the player will actually see rather
 * than a share of a hypothetical club.
 *
 * `Math.max(1, ...)` on that level for the same reason updateClub floors it:
 * a rider taken without the base card still swings a level-1 club, and a
 * readout that said 0 would be describing a weapon that is on screen.
 *
 * systems/club.js calls THIS for the packet it actually deals, rather than
 * recomputing the share beside it — the tip and the damage are one function,
 * which is the only arrangement in which they cannot drift apart.
 */
export function clubZapLevelStats(level, s = {}) {
  const c = CONFIG.clubZap ?? {};
  const n = lv(level);
  const share = (c.share ?? 0) + (c.sharePerLevel ?? 0) * (n - 1);
  const swing = clubLevelStats(Math.max(1, Math.floor(s?.clubLevel ?? 0)), s).clubDamage;
  return {
    // What the FIRST body down the chain takes. abilityDamageOf for the same
    // reason the blast gets it: the damage lands on a crowd rather than on the
    // body the club touched, so it is ability damage and a high-tier roll pays
    // into it.
    clubZapDamage: abilityDamageOf(swing * share, s),
    // Floored, so a fractional step is a hop every other stack rather than a
    // hop that half-exists — and the tip shows it dimmed and unchanged on the
    // picks where it does not tick.
    clubZapArcs: Math.max(1, Math.floor((c.arcs ?? 1) + (c.arcsPerLevel ?? 0) * (n - 1))),
    clubZapRange: (c.arcRange ?? 0) + (c.arcRangePerLevel ?? 0) * (n - 1),
  };
}

/**
 * HURLER, per level — HOW MANY, and nothing else.
 *
 * What a thrown club DOES is the Driftwood card's (see clubCarom above), so
 * there is one honest row here. The count also reads the strike's banked power,
 * which is not a level at all: `countAtMin + (countAtFull - countAtMin) * power`
 * before the level term. Answered at FULL charge — a card can promise what a
 * committed release throws, and quoting the floor would undersell every throw
 * anyone actually makes.
 */
export function clubThrowLevelStats(level) {
  const c = CONFIG.clubThrow ?? {};
  const n = lv(level);
  return {
    clubThrowCount: Math.max(1, Math.round((c.countAtFull ?? 1) + (c.countPerLevel ?? 0) * (n - 1))),
  };
}

/**
 * HARP SEAL, per level.
 *
 * TWO HALVES THAT READ AS TWO ABILITIES — the note that charms a body, and the
 * aura that body then drags around. Seven quantities and four rows, so the
 * order is one damage and one duration from each half: neither half can vanish
 * off the bottom, which is what a straight ranking would have done (the ledger
 * has the aura at seven eighths of this card's output, so it would have taken
 * every slot and the notes would never be mentioned).
 *
 * `lv` here is `max(1, level) - 1` — the system spells the same curve that way.
 */
export function harpLevelStats(level, s = {}) {
  const c = CONFIG.harp ?? {};
  const n = lv(level) - 1;
  return {
    harpDamage: abilityDamageOf((c.damage ?? 0) + (c.damagePerLevel ?? 0) * n, s),
    harpCharm: (c.charmDuration ?? 0) + (c.charmDurationPerLevel ?? 0) * n,
    harpAuraDamage: abilityDamageOf((c.auraDamage ?? 0) + (c.auraDamagePerLevel ?? 0) * n, s),
    harpAuraRadius: blastRadius((c.auraRadius ?? 0) + (c.auraRadiusPerLevel ?? 0) * n, s),
    // Below the cap — real, and the four above are the ones that decide a pick.
    harpGap: Math.max(c.intervalFloor ?? 0, (c.interval ?? 0) - (c.intervalPerLevel ?? 0) * n),
    harpAuraLength: (c.auraDuration ?? 0) + (c.auraDurationPerLevel ?? 0) * n,
  };
}

/**
 * LASER EYES, per level.
 *
 * `beams` is the rounded step this whole flat-row rule was written for: it
 * ticks at 0.34 a level, so the second beam lands at stack four and nothing
 * moves on the three picks either side.
 *
 * BURN IS LAST. Five quantities into four rows, and the small rider is the one
 * that gives way — the cadence stays, because how often the beam cuts is what a
 * player feels moment to moment.
 */
// THE LASER'S CADENCE, as a rung on the music's bar ladder.
//
// Counted in RUNGS rather than curved in seconds, because a curve in seconds
// does not survive the snap: against a 2.265s bar the old linear slide put six
// consecutive levels on bar/1 and the last four on bar/2, so most of the card's
// stacks bought no change a player could hear and one of them bought a silent
// gear change. A rung index has exactly as many values as there are audible
// cadences, which is the only count worth levelling.
//
// The ladder is barDivisions' — powers of two AND their triplets — so a stack
// can move the beam from a bar to a half to a dotted-triplet feel against a
// basic shot still playing sixteenths. Same ladder Rapid Fire counts on, and
// the same one snapToBarGrid rounds onto, so nothing here can name a cadence
// the shot grid would then move.
//
// Read off CONFIG.music.barSeconds directly rather than through music.js: this
// is asked by the card-text probes as well as by the water, and the readout for
// an upgrade should not drag the audio module in behind it.
function laserRungGap(c, n) {
  const bar = Math.max(0.05, CONFIG.music?.barSeconds ?? 2.265);
  const divs = barDivisions(Math.max(1, c.maxDivision ?? 4));
  const start = barRungIndex(divs, Math.max(1, c.barDivision ?? 1));
  const step = Math.floor((n - 1) / Math.max(1, c.levelsPerRung ?? 3));
  return bar / divs[Math.min(divs.length - 1, start + step)];
}

export function laserEyesLevelStats(level, s = {}) {
  const c = CONFIG.laserEyes ?? {};
  const n = lv(level);
  const gap = laserRungGap(c, n);
  // UPTIME, and the burn derived FROM it rather than beside it. Both were
  // independent curves and they crossed at the seventh stack — the beam lit for
  // longer than its own cooldown, permanently on, and no card showed the ratio
  // that would have said so. A duty cycle cannot cross what it is a fraction
  // of, and it is also what makes the rung above free: moving the laser to a
  // finer division chops the same lit second into more pieces instead of
  // handing the weapon more of them.
  const duty = Math.min(c.burnDutyMax ?? 0.9,
    (c.burnDuty ?? 0.22) + (c.burnDutyPerLevel ?? 0.078) * (n - 1));
  return {
    laserDamage: abilityDamageOf((c.damage ?? 7) + (c.damagePerLevel ?? 2.4) * (n - 1), s),
    // BOTH CLAMPS LIVE HERE. The system applied a `beamsMax` ceiling and a
    // `fireEveryMin` floor on top of these curves, and a readout without them
    // would promise a fifth beam and a cadence the water never delivers —
    // exactly the over-promise this whole file exists to stop. FLOORED for the
    // reason the system gives: a count creeping up by 0.34 would spawn two
    // beams for three levels and then silently three, with nothing able to say
    // when.
    laserBeams: Math.min(c.beamsMax ?? 4,
      Math.max(1, Math.floor((c.beams ?? 2) + (c.beamsPerLevel ?? 0.34) * (n - 1)))),
    laserReach: (c.reach ?? 26) + (c.reachPerLevel ?? 3.2) * (n - 1),
    laserGap: gap,
    laserBurn: gap * duty,
  };
}

/**
 * BUBBLE JET STREAM, per level.
 *
 * THE HOLD AND THE COOL ARE THE CARD. Damage and reach are the rows a player
 * reads first and they are the least of what a stack buys: a sustained weapon
 * is worth its UPTIME, and the two rows that move it are how long the stream
 * stays open and how long the seal spends venting between. At level 1 it is
 * open for well under half the cycle and reads as a burst; by the cap it is
 * barely off, which is the moment the upgrade becomes what its name says.
 *
 * That is also why the cool has a floor and the hold has none: a cool that
 * curves to zero is a permanent stream, which is a damage aura with a shape and
 * the one thing this weapon must not become. See `coolMin`.
 */
export function bubbleJetLevelStats(level, s = {}) {
  const c = CONFIG.bubbleJet ?? {};
  const n = lv(level);
  return {
    // Per TICK of contact, not per hit — CONFIG.bubbleJet.tickEvery decides how
    // often that is, so the number is small next to a bullet's.
    jetDamage: abilityDamageOf((c.damage ?? 9) + (c.damagePerLevel ?? 2.6) * (n - 1), s),
    jetReach: (c.reach ?? 22) + (c.reachPerLevel ?? 2.4) * (n - 1),
    jetHold: (c.hold ?? 0.9) + (c.holdPerLevel ?? 0.22) * (n - 1),
    // THE FLOOR LIVES HERE, not in the system. The laser learned this the hard
    // way: a clamp applied where the weapon fires and not where the card is
    // measured makes the hover tip promise a cadence the water never delivers.
    jetCool: Math.max(c.coolMin ?? 0.5,
      (c.cool ?? 1.9) + (c.coolPerLevel ?? -0.16) * (n - 1)),
    // The stream gets FATTER with stacks, which is both the read and a real
    // increase in what one sweep can touch — the hit test is a distance to the
    // polyline against half this.
    jetWidth: (c.width ?? 1.1) + (c.widthPerLevel ?? 0.09) * (n - 1),
  };
}

/**
 * OYSTER BLASTER, per level.
 *
 * Same shape as the laser: `bomblets` is a rounded step, and the small rider —
 * the bomblet's own damage — is the fifth row that gives way.
 */
export function oysterLevelStats(level, s = {}) {
  const c = CONFIG.oyster ?? {};
  const n = lv(level);
  return {
    oysterDamage: abilityDamageOf((c.damage ?? 0) + (c.damagePerLevel ?? 0) * (n - 1), s),
    oysterBomblets: Math.round((c.bomblets ?? 0) + (c.bombletsPerLevel ?? 0) * (n - 1)),
    oysterBlast: blastRadius(
      (c.bombletBlastRadius ?? 0) + (c.bombletBlastRadiusPerLevel ?? 0) * (n - 1), s),
    oysterGap: Math.max(c.fireRateFloor ?? 0,
      (c.fireRate ?? 0) - (c.fireRatePerLevel ?? 0) * (n - 1)),
    oysterBombletDamage: abilityDamageOf(
      (c.bombletDamage ?? 0) + (c.bombletDamagePerLevel ?? 0) * (n - 1), s),
  };
}

/**
 * SEAL TEAM, per level.
 *
 * THE COUNT IS THE LEVEL, capped at `maxSeals` — which the checklist said could
 * not be found and which is simply `sealTeamSize` in systems/sealTeam.js. So
 * the card that is numbered per stack ("Seal Team 2") really is buying a seal
 * each time, right up to the cap, and then only damage after that. Both facts
 * are worth a row and neither was visible.
 *
 * Entourage's extra escorts are deliberately NOT in here: that is a different
 * card's stat, and folding it in would have this one claiming its work.
 */
export function sealTeamLevelStats(level, s = {}) {
  const c = CONFIG.sealTeam ?? {};
  const n = lv(level);
  return {
    sealTeamCount: Math.min(n, c.maxSeals ?? n),
    sealTeamDamage: companionDamage(
      (c.contactDamage ?? 0) + (c.damagePerLevel ?? 0) * (n - 1), s),
  };
}

/**
 * RAZOR CLAMS, per level. The first readout with a RATIO in it.
 *
 * `fireRate` is `base * pow(perLevel, n - 1)` and not a sum, which is why
 * RATIO_STATS names it: reported as an addition it prints "-0.08s" for what is
 * really "x0.88", and two levels of data cannot tell the two apart.
 */
export function razorClamLevelStats(level, s = {}) {
  const c = CONFIG.razorClam ?? {};
  const n = lv(level);
  return {
    razorDamage: abilityDamageOf((c.damage ?? 0) + (c.damagePerLevel ?? 0) * (n - 1), s),
    razorCount: Math.max(1, Math.round((c.count ?? 0) + (c.countPerLevel ?? 0) * (n - 1))),
    razorGap: (c.fireRate ?? 0) * Math.pow(c.fireRatePerLevel ?? 1, n - 1),
    // CAPPED, like the laser's beams. The system applies `pierceMax` on top of
    // the curve and a readout without it would promise a tenth body the blade
    // never reaches.
    razorPierce: Math.min(c.pierceMax ?? 9,
      Math.max(0, Math.floor((c.basePierce ?? 0) + (c.piercePerLevel ?? 0) * (n - 1)))),
  };
}

/**
 * STARFISH SHURIKEN, per level.
 *
 * Its numbers lived in main.js, in a helper beside the frame loop — the only
 * ability on the roster whose curve had no home of its own. Lifted here for the
 * same reason as everything else in this file: a tip cannot reach into the game
 * loop, and a second copy of the formula would drift.
 *
 * `fireRate` is a ratio, like the razor clam's.
 */
export function starfishLevelStats(level, s = {}) {
  const c = CONFIG.starfish ?? {};
  const n = lv(level);
  return {
    starfishDamage: abilityDamageOf((c.damage ?? 0) + (c.damagePerLevel ?? 0) * (n - 1), s),
    starfishGap: (c.baseFireRate ?? 0) * Math.pow(c.fireRatePerLevel ?? 1, n - 1),
    starfishSize: (c.baseRadius ?? 0) + (c.radiusPerLevel ?? 0) * (n - 1),
    starfishPierce: Math.min(c.pierceMax ?? 4,
      Math.max(0, Math.floor((c.basePierce ?? 0) + (c.piercePerLevel ?? 0) * (n - 1)))),
  };
}

/**
 * HOMING PEBBLES, per level — ONE ROW, deliberately.
 *
 * A level moves three things: the turn rate, the acquisition radius and a size
 * bias toward bigger targets. Two of the three are facts about the simulation
 * rather than about the pebbles — "turn rate 4.2 -> 4.8" tells a player nothing
 * they could act on — so only the reach is here, which is the one with a
 * meaning outside the code: how far a pebble will look for something to bend
 * toward.
 */
export function homingShotLevelStats(level, s = {}) {
  const c = CONFIG.homingShot ?? {};
  const n = lv(level);
  return {
    homingReach: ((c.acquireRadius ?? 0) + (c.acquireRadiusPerLevel ?? 0) * (n - 1))
      * (s?.targetingMul ?? 1),
  };
}

/**
 * IRON LUNG, per level — THE MULTIPLIER YOU ACTUALLY HAVE.
 *
 * This one lands in the stat block already, so measure() has always seen it and
 * the tip has always said something true. What it could not say is the SIZE of
 * it: the bonus is `damagePerOxygen * level * oxygen`, so it scales with the
 * tank — every Yoga makes Iron Lung stronger — and measure() replays against a
 * synthetic seal whose oxygen is the base value. On a real build carrying Yoga
 * the card was quietly under-reporting itself.
 *
 * MEASURED AT A FULL BREATH, deliberately, even though the live bonus follows
 * the bar down (see ironLungMul in stats.js). A tip whose number fell while
 * you read it would be unreadable, and the question a card answers is what it
 * is worth to own, which is the top of its range — the same reading a weapon's
 * damage gives you without promising every shot lands.
 *
 * Read off the passed block, so the figure is the one the run has.
 */
export function ironLungLevelStats(level, s = {}) {
  const c = CONFIG.ironLung ?? {};
  const n = lv(level);
  if (c.enabled === false) return { ironLungBonus: 0 };
  const bonus = (c.damagePerOxygen ?? 0) * n * Math.max(0, s?.maxOxygen ?? 0);
  return { ironLungBonus: Math.min(bonus, c.maxBonus ?? Infinity) };
}

// --- GLOW UP, ×4 -----------------------------------------------------------
//
// ONE SHAPE, THREE SLOTS, FOUR ELEMENTS. The four cards read in the same order
// so they can be compared at a glance:
//
//   1  how often it lands
//   2  what it does when it does
//   3  how long it lasts, or how far it carries
//
// WHAT THE SLOTS ARE NOT is three shared row LABELS. The elements are four
// different answers to a crowd and the data says so: only shock has a proc
// chance at all (the other three apply on every hit), chill deals no damage
// whatsoever, and "duration" on venom is a flat number a level never touches.
// Forcing one vocabulary over that would have three of the four cards carrying
// rows that never move and one calling a freeze a duration — so each element
// keeps its own words, in the shared order.
//
// SEVERAL SLOTS COME OUT EMPTY, and that is the honest result rather than a
// gap: the "only what moved" rule drops them. Venom ends up a ONE-ROW card,
// because a venom level buys damage over time and genuinely nothing else —
// which is worth knowing about the balance, and was invisible before.

/** VOLTAIC — the arc. Chance to fire, and how many bodies it reaches. */
export function biolumShockLevelStats(level) {
  const e = CONFIG.biolum?.elements?.shock ?? {};
  const n = lv(level);
  return {
    biolumShockChance: Math.min(e.chanceMax ?? 1,
      (e.chance ?? 0) + (e.chancePerLevel ?? 0) * (n - 1)),
    // A rounded step, so it shows flat on the picks between arcs.
    biolumShockArcs: Math.max(1, Math.floor((e.arcs ?? 1) + (e.arcsPerLevel ?? 0) * (n - 1))),
  };
}

/** VENOM — poison over time, and that is the whole of it. */
export function biolumVenomLevelStats(level, s = {}) {
  const e = CONFIG.biolum?.elements?.venom ?? {};
  const n = lv(level);
  return {
    biolumVenomDps: abilityDamageOf((e.dps ?? 0) + (e.dpsPerLevel ?? 0) * (n - 1), s),
  };
}

/** CHILL — the slow each hit lays on, and the freeze enough of them buy. */
export function biolumChillLevelStats(level) {
  const e = CONFIG.biolum?.elements?.chill ?? {};
  const n = lv(level);
  return {
    biolumChillSlow: Math.min(e.maxSlow ?? 1,
      (e.slowPerHit ?? 0) + (e.slowPerHitPerLevel ?? 0) * (n - 1)),
    biolumChillFreeze: (e.freezeDuration ?? 0) + (e.freezeDurationPerLevel ?? 0) * (n - 1),
  };
}

/** INFECTION — damage over time, how far it jumps, and what a host's death does. */
export function biolumInfectionLevelStats(level, s = {}) {
  const e = CONFIG.biolum?.elements?.infection ?? {};
  const n = lv(level);
  return {
    biolumInfectDps: abilityDamageOf((e.dps ?? 0) + (e.dpsPerLevel ?? 0) * (n - 1), s),
    biolumInfectSpread: (e.spreadRange ?? 0) + (e.spreadRangePerLevel ?? 0) * (n - 1),
    biolumInfectBurst: abilityDamageOf(
      (e.burstDamage ?? 0) + (e.burstDamagePerLevel ?? 0) * (n - 1), s),
  };
}

/**
 * EVERY LEVELLED ABILITY THAT HAS A READOUT, by upgrade id.
 *
 * Absent means "no readout yet", which is the honest state for most of the
 * roster and is handled everywhere by falling back to the bare level phrase —
 * `+1 dumbo octopus level`, which is what every one of these said before this
 * file existed. Adding an ability is one entry here, its formulas moved out of
 * its system, and a statText.csv row per quantity so the numbers have names.
 *
 * TWENTY-FIVE STATS IN statText.csv CARRY `kind: level`, so that is roughly the
 * size of the job. They are not equally worth doing: an ability whose level
 * moves one number is well enough described by its own name, and the ones worth
 * the work are the ones like this boat, where a single level quietly moves five
 * things in three different systems.
 */
export const LEVEL_STATS = {
  bakalar: bakalarLevelStats,
  seagullBomb: seagullLevelStats,
  seaGarlic: garlicLevelStats,
  electricEel: eelLevelStats,
  calamari: calamariLevelStats,
  orcaFamily: orcaLevelStats,
  beluga: belugaLevelStats,
  dumbo: dumboLevelStats,
  octoGrab: octoGrabLevelStats,
  musselVolley: musselLevelStats,
  club: clubLevelStats,
  clubBoom: clubBoomLevelStats,
  clubIce: clubIceLevelStats,
  clubZap: clubZapLevelStats,
  clubThrow: clubThrowLevelStats,
  harp: harpLevelStats,
  laserEyes: laserEyesLevelStats,
  bubbleJet: bubbleJetLevelStats,
  oysterBlaster: oysterLevelStats,
  sealTeam: sealTeamLevelStats,
  razorClam: razorClamLevelStats,
  starfish: starfishLevelStats,
  homingShot: homingShotLevelStats,
  ironLung: ironLungLevelStats,
  biolumShock: biolumShockLevelStats,
  biolumVenom: biolumVenomLevelStats,
  biolumChill: biolumChillLevelStats,
  biolumInfection: biolumInfectionLevelStats,
};

/**
 * The quantities `id` has at `level`, or null when it has no readout.
 *
 * @param s  the stat block the multipliers should be read from.
 */
export function levelStats(id, level, s = {}) {
  const fn = LEVEL_STATS[id];
  return fn ? fn(level, s) : null;
}

/**
 * WHERE `id` ENDED UP, as rows in levelChanges' shape.
 *
 * For the score screen, where there is no next pick. A tip that answers "and
 * what would ANOTHER one do" is asking about a run that is over — the question
 * on that screen is what the build you actually played was worth, so every
 * quantity is printed at the level it finished on and nothing is subtracted.
 *
 * `how: 'held'` renders the same way an unlock does — a bare value, no arrow —
 * because they are the same sentence at two ends of a run: this is what it
 * does. Kept as its own name rather than folded into 'unlock' so the renderer
 * and any future caller can still tell "you are being offered this" from "this
 * is what you had".
 */
export function levelValues(id, level, s = {}) {
  const at = levelStats(id, level, s);
  if (!at) return null;
  return Object.keys(at)
    .filter((stat) => Number.isFinite(at[stat]))
    .map((stat) => ({ stat, how: 'held', amount: 0, from: null, to: at[stat] }));
}

/**
 * What one more level of `id` MOVES, in the shape measure() returns — so the
 * caller can hand it straight to phraseAll and get the game's own wording,
 * units and lower-is-better handling for free.
 *
 * @param from   the level held now, and the block that goes with it
 * @param to     the level after the pick, and the block that goes with THAT
 * @returns [{ stat, how, amount|ratio, from, to }] or null
 *
 * ONLY WHAT MOVED. A level that leaves a quantity alone must not list it: the
 * boat's net WIDTH is the same at stack one and stack eight, and a row saying
 * "+0 net width" would be the card claiming credit for something it does not
 * do — which is the failure the typed desc already had, arriving by a new road.
 */
export function levelChanges(id, from, to, fromStats = {}, toStats = {}, cap = 0) {
  const a = levelStats(id, from, fromStats);
  const b = levelStats(id, to, toStats);
  if (!a || !b) return null;
  // WHAT THIS ABILITY LOOKS LIKE AT ITS CAP, for the flat rule below. Measured
  // against the block the NEXT stack would be taken with, because the question
  // is only ever "can this still move from here".
  const top = cap > to ? levelStats(id, cap, toStats) : null;
  const ratios = RATIO_STATS[id] ?? EMPTY;
  const out = [];

  // THE FIRST PICK IS NOT A DELTA, IT IS AN UNLOCK — and getting this wrong was
  // the bug that made the whole feature look broken on the screen it matters
  // most.
  //
  // A card you do not already hold is measured from level 0, and `lv()` clamps
  // that to 1 because there is no such thing as level 0 of an ability. So both
  // sides of the subtraction were level 1, every quantity came out unmoved, and
  // the flat rule below then KEPT them all — because they will all move on a
  // later pick. The result was a table reading "bomb damage 61 -> 61, blast 11
  // -> 11, net depth 14.5 -> 14.5" on every card in the deal you had not taken
  // yet, which early in a run is nearly all of them.
  //
  // What the player is being offered is the whole ability, so the answer is
  // simply what it does at level one: a value, no arrow, nothing to subtract.
  // `how: 'unlock'` says so, and `from` is null because there is no before.
  if (from < 1) {
    for (const stat of Object.keys(b)) {
      const y = b[stat];
      if (!Number.isFinite(y)) continue;
      out.push({ stat, how: 'unlock', amount: 0, from: null, to: y });
    }
    return out;
  }
  for (const stat of Object.keys(b)) {
    const x = a[stat];
    const y = b[stat];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

    // A hair of float noise is not a change. The formulas are sums of tuned
    // decimals, so a quantity that is genuinely flat can differ in the
    // fifteenth place and would otherwise render as "+0".
    const moved = Math.abs(y - x) > Math.abs(y || 1) * 1e-9;

    if (!moved) {
      // TWO KINDS OF STANDING STILL, and the tip should not treat them alike.
      //
      //   AT ITS CEILING   the boat's sailing gap has hit spawnMinFloor and
      //                    will never move again. A row for it would be the
      //                    card claiming credit for something it cannot do.
      //   MID-STEP         Laser Eyes' beams tick on a rounded 0.34 a level, so
      //                    the second beam lands on stack four and NOTHING
      //                    moves on the three picks either side. Hidden, the
      //                    most important thing that card does is invisible on
      //                    four of its six stacks, and the tip changes shape
      //                    between picks with nothing saying why.
      //
      // So: hide what has stopped for good, and show what is still coming as a
      // flat row. `how: 'none'` — the caller renders it as an unchanged value
      // rather than as "+0", which is the shape that reads as a bug.
      const willMove = top && Number.isFinite(top[stat])
        && Math.abs(top[stat] - y) > Math.abs(y || 1) * 1e-9;
      if (willMove) out.push({ stat, how: 'none', amount: 0, from: x, to: y });
      continue;
    }

    // MOST OF THESE FORMULAS ARE `base + perLevel * (n - 1)` under a clamp, so
    // the step is a difference. A few are not — the starfish's and the gull's
    // fire rates are `base * pow(perLevel, n - 1)` — and reporting one of those
    // as an addition prints "-0.08s" for what is really "x0.88". Which is which
    // is DECLARED (see RATIO_STATS) rather than guessed: two points cannot tell
    // a sum from a product, and a wrong guess is a plausible wrong number.
    if (ratios.has(stat) && x !== 0) out.push({ stat, how: 'mul', ratio: y / x, from: x, to: y });
    else out.push({ stat, how: 'add', amount: y - x, from: x, to: y });
  }
  return out;
}

const EMPTY = new Set();

/**
 * The quantities that scale MULTIPLICATIVELY, per ability.
 *
 * Declared because it cannot be measured: two levels give two points, and two
 * points fit a sum and a product equally well. Everything absent is additive,
 * which is the overwhelming majority and the safe default — an additive reading
 * of a ratio is visibly wrong ("-0.08s" for a rate), where the reverse would
 * silently print a plausible multiplier.
 */
export const RATIO_STATS = {
  // The two cadences in the game that COMPOUND rather than step. The gull's is
  // the third and is deliberately absent from its readout — see
  // seagullLevelStats.
  razorClam: new Set(['razorGap']),
  starfish: new Set(['starfishGap']),
};
