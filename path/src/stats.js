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

/**
 * A fresh stat block at level 1 with no upgrades taken.
 *
 * @param loadout which gun this run started as — see systems/loadout roll in
 *                systems/finLaser.js. It is IN THE BLOCK rather than passed
 *                alongside it because several upgrades fork on it (Pocket Full
 *                of Stones, André 3000) and apply() takes exactly one argument.
 *                A block built with no loadout is the pebble gun, which is what
 *                every harness and the card-text prober get and want.
 */
export function baseStats(loadout = 'pebbles') {
  return {
    // THE ONLY NON-NUMBER IN THE BLOCK, which is safe and worth stating: every
    // consumer that walks these fields — the rarity amplifier, the card-text
    // measurement — guards on `typeof === 'number'`, so a string is skipped
    // rather than scaled into nonsense.
    loadout,
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
    // PER-FLIPPER PEBBLE SIZE. Multipliers on `radius` above, spent in fire()
    // against the emit point a pellet actually leaves from, so the seal can be
    // throwing a boulder out of one fin and a pebble out of the other. Two
    // scalars rather than a two-element array because upgradeText.js measures
    // NUMBERS — an array moves without anything being able to say what moved,
    // and the card would render blank. Both seed at 1, which is the un-upgraded
    // gun: every pellet is exactly `radius`, and Flippers Up! is the only thing
    // that ever moves either one.
    leftFinRadiusMul: 1,
    rightFinRadiusMul: 1,
    // HOW MANY STACKS OF FLIPPERS UP! HAVE BEEN SPENT. The card feeds one
    // flipper at a time and the SIDE is this counter's parity — stack 1 is the
    // left, 2 the right, and so on — so the alternation is stated once, as
    // arithmetic, rather than inferred twice from the two multipliers above.
    // See flipperSideForStack in levelStats.js, which is that one statement.
    flippersUpStacks: 0,
    // ...AND WHAT THAT FLIPPER IS CARRYING. Past `flipperElementStack` a stack
    // stops being only size and starts putting an ELEMENT on the fin it feeds:
    // this is how deep that fin's element is, on the same curve Glow Up! uses.
    //
    // The LEVEL is here because it is a number and the stat block is numbers.
    // WHICH element it is, is not: it is rolled once when the stack is taken
    // and stamped on the pick, so it survives the block being rebuilt from
    // scratch several times a minute. See finElements() in systems/elements.js,
    // which reads it back off the pick list the same way activeElement() reads
    // the run's element off the pick list.
    leftFinElementLevel: 0,
    rightFinElementLevel: 0,
    // LATTICE SEALANT'S WIDTH — how many EXTRA children a bolt's first split
    // throws, on top of CONFIG.finLaser.lattice.children. 0 on every pebble
    // run and on a laser run that has taken no Pocket Full of Stones, which is
    // the innate shatter the loadout ships with.
    //
    // A separate field from `multishot` and not a reinterpretation of it: the
    // card converts (see its apply()), so on a laser run the two are different
    // amounts of different things and a single counter could not say which
    // stack bought which.
    latticeAmount: 0,
    // HOW MANY STACKS OF ANDRÉ 3000, which the card's own parity reads to
    // decide whether this one is pierce or spread — the same arrangement
    // `flippersUpStacks` has, and for the same reason: the alternation is
    // stated once, as arithmetic, rather than inferred from the two things it
    // moves. Counted on every loadout even though only the laser forks on it,
    // so the number means "stacks taken" and not "stacks that did something".
    andreStacks: 0,
    // HOW MUCH WIDER THE VOLLEY FANS than the gun's own spread. The spread half
    // of the alternating card, as a multiplier so it composes with a fan that
    // is already per-fin (CONFIG.weapon.finSpread) or per-volley (`spread`)
    // depending on the rig — see fire().
    finSpreadMul: 1,
    multishot: CONFIG.weapon.multishot,
    // HOW MANY STACKS OF MULTISHOT, which is NOT `multishot`. Levelling adds
    // pellets on its own cadence (see applyLevelGrowth), so the pellet count is
    // the card's stacks plus the ladder's — and the card's per-stack curve must
    // not be paid out for pellets the card did not buy.
    multishotLevel: 0,
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
    // Entourage. Flat +N to every count that CIRCLES the seal — the shrimp
    // ring, the escort seals, the harps, the clubs on the club ring. Same
    // shape as `projectileBonus` above and applied at the point of use for the
    // same reason: apply() runs in PICK ORDER, so a run that took this before
    // Shrimp Ring would have had nothing to add to. See orbiterCount() below,
    // which is the only way this should ever be read.
    orbiterBonus: 0,
    // Splash Zone. Multiplies blast/aura/wave radii. `targetingMul` is the
    // gentler half — how far abilities LOOK for something, as opposed to how
    // far they reach once they've found it. Split because a card that widened
    // acquisition as hard as it widens explosions turns every companion into a
    // whole-arena sniper.
    aoeMul: 1,
    targetingMul: 1,
    // André 3000. How long EVERY projectile the seal fires stays in the water,
    // as a multiplier on whatever life its own spawn site asked for — the gun's
    // `life` above, CONFIG.missile.life, the scallop's, the ricochet's,
    // shrapnel, razor blades, thrown clubs.
    //
    // A multiplier applied at the point of use rather than to `life` here,
    // because `life` is the GUN'S number and every other projectile in the game
    // carries its own. One card that reached only the gun would be a fifth of
    // what it says on the tin, and thirteen apply() lines writing thirteen
    // different fields would be thirteen chances to miss one. See
    // projectileLife() in systems/scaling.js, which is the only way this should
    // ever be read, and spawnProjectile, which is the only place that calls it.
    //
    // Player shots only. An enemy torpedo is spawned through the same function
    // and must not inherit the seal's upgrades.
    projectileLifeMul: 1,
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
    // HOW MANY STACKS OF SHRIMP RING, which is NOT `shrimpCount`. The first
    // pick jumps the count straight to `baseCount` and later ones add one, so
    // the count is 3, 4, 5... for stacks 1, 2, 3 — and Clone Warz and Entourage
    // both add to it besides. A per-stack curve needs the stack number, so it
    // is counted here rather than reconstructed from a count that three other
    // things write to.
    shrimpLevel: 0,
    bounceLevel: 0,
    bounceFireRate: CONFIG.bounce.fireRate,
    bounceLife: CONFIG.bounce.life,
    bounceMaxBounces: CONFIG.bounce.maxBounces,
    eelLevel: 0,
    laserEyesLevel: 0,
    // BUBBLE JET STREAM — how many stacks. A level index like the rest of this
    // run: the stream's damage, reach, hold and cooldown are all curves off it
    // in levelStats.js, so nothing here is a quantity.
    bubbleJetLevel: 0,
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
    razorClamLevel: 0,
    // SARDINE SWIRL — how many stacks. A level index like the razor clam's:
    // the school's size, its reach and what one body hits for are all curves
    // off it in levelStats.js, so nothing here is a quantity.
    sardineSwirlLevel: 0,
    octoGrabLevel: 0,
    orcaLevel: 0,
    // STUBBED — the card that would raise this is disabled in upgrades.csv and
    // nothing reads it yet. Seeded anyway, because the seed is what stops the
    // first stack reading `undefined` and turning every later sum into NaN,
    // and a stub whose first real pick crashes is worse than no stub.
    dolphinPodLevel: 0,
    musselVolleyLevel: 0,
    // THE BOUNCER. Three multipliers on the whole club class at once — the
    // swing, the caroms, the blast, the ice, the shockwave, the ring and the
    // thrown one. Multipliers rather than levels because the card grants no
    // ability of its own: it is worth exactly as much club as the run already
    // has, which is what makes it a build card rather than a fifth weapon.
    //
    // Read live off here by systems/club.js in the shape systems/scaling.js
    // established, so a run without the card multiplies by 1 and every call
    // site can apply them unconditionally.
    // How many clubs the run's club cards have bought, total. THE COUNT, not a
    // bonus on top of one: every club in the water came from a pick that rolled
    // `amount` (see clubStackPerk in config.js), including the first pick of
    // each type, which is never rolled. Here so the card can MEASURE itself —
    // systems/club.js derives the same number from the same function when it
    // needs to know which type each club is.
    clubCount: 0,
    clubDamageMul: 1,
    clubKnockMul: 1,
    clubReachMul: 1,
    clubLevel: 0,
    clubThrowLevel: 0,
    clubBoomLevel: 0,
    clubIceLevel: 0,
    clubZapLevel: 0,
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
  'multishot', 'multishotLevel', 'pierce', 'missileCount', 'shrapnelCount', 'shrimpCount', 'shrimpLevel',
  'scallopCount', 'bounceMaxBounces', 'projectileBonus', 'orbiterBonus',
  'breachChainLevel', 'garlicLevel', 'bounceLevel', 'eelLevel', 'laserEyesLevel', 'bubbleJetLevel', 'starfishLevel',
  'maneaterLevel', 'ironLungLevel', 'homingShotLevel',
  'seagullLevel', 'belugaLevel', 'sealTeamLevel', 'bakalarLevel', 'calamariLevel',
  'dumboLevel', 'harpLevel', 'oysterLevel', 'razorClamLevel', 'sardineSwirlLevel', 'octoGrabLevel', 'orcaLevel', 'dolphinPodLevel',
  'musselVolleyLevel',
  'biolumLevel', 'clubLevel', 'clubThrowLevel', 'clubBoomLevel', 'clubIceLevel', 'clubZapLevel',
  // Flippers Up!. `flippersUpStacks` is a count whose PARITY decides which fin
  // a stack feeds, so a Rare pick scaling it to 1.25 would not merely be a
  // fractional level — it would put the next stack on the wrong flipper, and the
  // element rolled for that pick would land on the other one.
  'flippersUpStacks', 'leftFinElementLevel', 'rightFinElementLevel',
  // Lattice Sealant's two counts. `andreStacks` is a PARITY like
  // `flippersUpStacks` above — a rare pick scaling it to 1.25 would put the
  // next stack on the wrong side of the alternation — and `latticeAmount` is a
  // count of children, where +1.25 of a bolt is one bolt.
  'latticeAmount', 'andreStacks',
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

/**
 * THE ONE WAY TO READ `orbiterBonus` — Entourage.
 *
 * The same gate, and it is the same point: this adds a companion to a ring you
 * HAVE. An ability you never picked has a base of 0 and stays at 0, or one
 * card would hand you a shrimp, an escort seal and a harp you never took.
 *
 * Kept separate from projectileCount rather than folded into it, even though
 * the arithmetic is identical, because the two cards answer different
 * questions and a system asks exactly one of them. "How many do I FIRE" and
 * "how many circle me" are the same number only for the shrimp ring, which is
 * both — and that overlap is a fact about the shrimp, not a reason to give the
 * two cards one field and lose the ability to tune them apart.
 */
export function orbiterCount(base, s) {
  if (!(base > 0)) return 0;
  return base + (s?.orbiterBonus ?? 0);
}

// Baseline growth, applied AFTER upgrades so the basic shot keeps pace as you
// level even on a run where you never picked a damage upgrade. Extra pellets
// arrive on a fixed cadence (every `levelsPerExtraShot`) on top of whatever
// Multishot added. Mutates `s` and returns it.
//
// HEALTH IS THE ONE THAT COMPOUNDS, and it is the only shape that works: the
// water's toughness is a per-difficulty MULTIPLIER (see difficultyRamp), so a
// maximum that grew by a flat amount a level would still be losing ground the
// whole run — the same flat-income-against-a-compounding-cost that the xp
// ladder had. See CONFIG.player.hpPerLevel for the rate and why it is small.
//
// A multiplier on the FINISHED block rather than on CONFIG.player.maxHp, which
// is what makes the two halves agree: a +30 card taken at level 4 is worth 30
// of a 100-point bar then and 30 of a 300-point bar at level 30 if this ran
// first, i.e. worth a third as much for having been taken early. Taking it
// with the block already assembled means every flat card keeps the share of
// the bar it bought.
export function applyLevelGrowth(s, level) {
  const lvl = Math.max(1, level ?? 1);
  s.damage += CONFIG.weapon.damagePerLevel * (lvl - 1);
  s.speed += CONFIG.weapon.speedPerLevel * (lvl - 1);
  s.multishot += Math.floor((lvl - 1) / CONFIG.weapon.levelsPerExtraShot);
  s.maxHp *= Math.pow(1 + (CONFIG.player.hpPerLevel ?? 0), lvl - 1);
  return s;
}

// THE BOSS DIVIDEND'S OTHER HALF — a pellet per boss, forever.
//
// A boss already pays in stacks (the hive ceremony, see updateBossDividend in
// main.js), and that payout is a CHOICE: it deepens decisions the player has
// already made. This one is not a choice and is not meant to be. It is the
// same statement applyLevelGrowth above makes about levelling — the gun keeps
// pace with the water on its own — said about the other axis the run escalates
// on. Five levels is a boss, and a run that beat four of them is firing four
// more pellets whether or not it ever saw a Multishot card.
//
// `multishot` and NOT `multishotLevel`, exactly as the level cadence above
// does, and for the reason the note on those two fields gives: the second one
// counts STACKS OF THE CARD and is what multishotLevelStats spends the damage
// and size curve against. Paying a boss into it would hand out a compounding
// bonus for a fight rather than for a pick, and would quietly spend a curve
// that is deliberately exhausted by the tenth stack.
//
// Mutates `s` and returns it. A run that has killed no boss is untouched.
export function applyBossGrowth(s, bossesDefeated) {
  const kills = Math.max(0, Math.floor(bossesDefeated ?? 0));
  if (!kills) return s;
  s.multishot += (CONFIG.weapon.shotsPerBoss ?? 0) * kills;
  return s;
}

// ============================================================================
// THE FIN LASER'S REACH, spent here for the reason Maneater and Iron Lung are
// (see below): it cannot be written as arithmetic inside any one apply().
//
// It is a function of the WHOLE pick list — how many gun cards are held — and
// of a run fact apply() has no business reading, the boss count. An apply()
// that counted its own siblings would also be replayed in PICK ORDER, so the
// same two cards taken the other way round would be a different range.
//
// WHY IT MOVES `life` AND NOT `speed`. Range is life x speed, so either would
// do the arithmetic — and only one of them is honest. A bolt that got FASTER
// as the run went on would change how the weapon is aimed, how much lead a
// moving fish needs and how far into a body it lands, all as a side effect of
// having taken a fifth gun card. Lengthening the flight changes only how far
// it goes, which is the thing the ramp is for.
//
// The multiplier itself lives in systems/finLaser.js — this file imports CONFIG
// and nothing else (see the header), and that is worth keeping, so the caller
// hands the number in rather than this reaching for the module that owns it.
//
// Mutates `s` and returns it. A no-op on every pebble run and on any laser run
// that has not earned a step.
// ============================================================================
export function applyLaserReach(s, reachMul = 1) {
  if (s?.loadout !== 'laser') return s;
  if (!(reachMul > 1)) return s;
  s.life *= reachMul;
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
//   IRON LUNG is paid per point of the air the seal is CURRENTLY holding,
//   which moves every frame of a dive. apply() runs in PICK ORDER as well —
//   the same reason Clone Warz is spent at the point of use (see
//   projectileBonus above) — so an Iron Lung taken before Deep Lungs would be
//   measured against a tank that had not grown yet, and taking the same two
//   cards in the other order would be a different run.
//
// So apply() only COUNTS the stacks and this spends them, once, after every
// upgrade has been replayed and after applyLevelGrowth. Both are pure
// functions of the block plus one number the caller supplies, which keeps the
// whole thing replayable in Node.
//
// IRON LUNG IS THEN RE-SPENT EVERY FRAME, because its number is a live one.
// applyDamageScaling stashes the four stats as they stood BEFORE the lung
// multiplier (`ironLungBase`) and applyIronLung below re-derives them from
// that stash against the current oxygen — four multiplies, once a frame, as
// against replaying every upgrade in the run. Re-deriving from the stash
// rather than multiplying the live value is what keeps it from compounding:
// a multiplier applied to an already-multiplied stat sixty times a second
// reaches the cap in under a second and never comes back down.
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
 * Read off the air the seal is HOLDING, not the size of the tank it came out
 * of. That is the whole shape of the card: a full breath is the top of the
 * bonus and it bleeds away with the bar, so the seal hits hardest on the way
 * down and softest just before it has to surface. Widening the tank — Deep
 * Lungs, or anything later — raises the ceiling this can climb to AND buys
 * more seconds near it, which is why the two cards still belong together.
 *
 * `oxygen` defaults to the full tank, so a caller with no run in hand (the
 * card prober, the hover tips, a Node harness) measures the card at its
 * headline value rather than at whatever the last frame happened to hold.
 * Clamped to the tank at both ends: a refill overshoot must not be worth more
 * than a full breath, and a drowned seal gets nothing rather than a negative.
 */
export function ironLungMul(s, oxygen) {
  const c = CONFIG.ironLung ?? {};
  const level = s.ironLungLevel ?? 0;
  if (!c.enabled || level <= 0) return 1;
  const cap = Math.max(0, s.maxOxygen ?? 0);
  const held = Math.max(0, Math.min(oxygen ?? cap, cap));
  const bonus = (c.damagePerOxygen ?? 0) * level * held;
  return 1 + Math.min(bonus, c.maxBonus ?? Infinity);
}

// The four stats "all damage" reaches. Listed once so applyDamageScaling and
// applyIronLung can never fall out of step about which ones the lung moves —
// a stat scaled by one and restored by the other would drift a little further
// from the truth on every frame of every dive.
const DAMAGE_STATS = ['damage', 'strikeDamage', 'abilityDamageMul', 'companionDamageMul'];

/**
 * WHAT THE BREATH IS WORTH RIGHT NOW — re-derived from the stash, every frame.
 *
 * Safe to call on a block that never went through applyDamageScaling (there is
 * no stash, so there is nothing to restore) and safe to call twice with the
 * same oxygen, which is the property that lets updatePlayer call it
 * unconditionally rather than tracking whether the bar moved.
 */
export function applyIronLung(s, oxygen) {
  const base = s?.ironLungBase;
  if (!base) return s;
  const mul = ironLungMul(s, oxygen);
  for (const k of DAMAGE_STATS) s[k] = base[k] * mul;
  return s;
}

export function applyDamageScaling(s, humansEaten = 0, oxygen) {
  const mul = maneaterMul(s, humansEaten);
  if (mul !== 1) for (const k of DAMAGE_STATS) s[k] *= mul;
  // Everything except the lung is now spent, so this is the block the lung
  // multiplies — kept as an object rather than four numeric fields because a
  // number on the stat block is something the rarity system, the card prober
  // and the playtest ledger all take an interest in, and these four are
  // bookkeeping rather than stats.
  s.ironLungBase = {};
  for (const k of DAMAGE_STATS) s.ironLungBase[k] = s[k];
  applyIronLung(s, oxygen);
  return s;
}
