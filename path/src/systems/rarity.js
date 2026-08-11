import { CONFIG } from '../config.js';
import { INTEGER_STATS } from '../stats.js';

// ============================================================================
// RARITY — the tier a card was dealt at, and what that tier is worth.
//
// TWO PROBLEMS, AND THE SECOND IS THE INTERESTING ONE.
//
// 1. Which tier a card gets. A weighted roll whose weights slide from
//    `weightEarly` to `weightLate` across the run, so the opening is grey with
//    the odd green and the late game has a real chance at the top. See
//    rollRarity.
//
// 2. What a tier DOES to an upgrade. This is the hard half, because an upgrade
//    is not a number — it is an arbitrary apply(s) function, and there is no
//    parameter to multiply. `s.fireRate *= 0.75` and `s.maxHp += 30` and
//    `s.shrimpCount = s.shrimpCount ? s.shrimpCount + 1 : baseCount` have no
//    shape in common.
//
//    So rarity does not touch the upgrade at all. It runs apply() against a
//    COPY, diffs the stat block, and amplifies whatever moved:
//
//        after = before + (after - before) * statMul
//
//    That scales all 38 upgrades with no per-card edits and no new declarations
//    on the ones that are already just arithmetic. It also gets the direction
//    right for free on the ones that improve by going DOWN — `fireRate *= 0.75`
//    is a delta of -25% of base, and amplifying a negative delta makes the gun
//    faster, not slower. A naive `result * statMul` would have made a rare
//    Rapid Fire worse than a common one.
//
// WHAT DELIBERATELY DOES NOT SCALE. Counts and level indices (INTEGER_STATS in
// stats.js). +1.25 shrimp is one shrimp, so amplifying those either does
// nothing or, rounded, doubles the card. Instead an upgrade whose apply() moved
// ONLY integers is paid out through its family's continuous multiplier — a
// rare Sea Garlic is a wider aura, a rare Orca Family is a harder-hitting pod.
// That is what `family` on each upgrade is for, and why every upgrade needs
// one even though most never use it.
// ============================================================================

// Where each family's rarity payout lands. The value is the stat an
// integer-only upgrade of that family amplifies instead of its count.
//
// Every one of these is a multiplier that already exists and is already read by
// the systems in question — `aoe()`, `companionDamage()` and `abilityDamage()`
// in systems/scaling.js. Rarity did not get to invent a new damage channel; it
// pays into the ones the cross-cutting upgrade cards already established, which
// is also why a rare Sea Garlic and a stack of Splash Zone compound rather than
// being two unrelated bonuses that happen to both make the aura bigger.
const FAMILY_PAYOUT = {
  gun: 'damage',               // the basic shot
  aoe: 'aoeMul',               // auras, waves, blasts
  projectile: 'abilityDamageMul', // thrown and launched things
  companion: 'companionDamageMul',
  strike: 'strikeDamage',
  // Utility upgrades (health, magnet, oxygen, regen) are continuous already, so
  // they are never paid out this way. Mapped to null rather than omitted, so
  // "this family has no payout" is a statement in the table rather than a
  // lookup that happens to miss.
  utility: null,
};

export function rarities() {
  return CONFIG.rarities ?? [];
}

export function rarityById(id) {
  return rarities().find((r) => r.id === id) ?? null;
}

/** The floor tier — what a card is when nothing rolled it up. */
export function baseRarity() {
  return rarities()[0]?.id ?? null;
}

export function rarityRank(id) {
  const i = rarities().findIndex((r) => r.id === id);
  return i < 0 ? 0 : i;
}

export function rarityMul(id) {
  return rarityById(id)?.statMul ?? 1;
}

/**
 * Roll a tier.
 *
 * `progress` is 0..1 across the run — main.js passes the difficulty curve,
 * normalised. The weights lerp from the early column to the late one, so the
 * shape of the ramp is two numbers per row in rarities.csv and no code.
 *
 * `random` is injectable for the same reason drawUpgrades takes one: a
 * distribution you cannot sample ten thousand times in a terminal is a
 * distribution nobody has actually checked.
 */
export function rollRarity(progress = 0, random = Math.random) {
  const list = rarities();
  if (!list.length) return null;

  const t = Math.min(1, Math.max(0, progress));
  let total = 0;
  const weights = list.map((r) => {
    const w = Math.max(0, (r.weightEarly ?? 1) + ((r.weightLate ?? 1) - (r.weightEarly ?? 1)) * t);
    total += w;
    return w;
  });

  // Every row at zero is a misconfigured file, not an intention — the same
  // reading drawUpgrades takes. Falling back to the floor tier keeps the game
  // dealing cards instead of dealing nulls.
  if (total <= 0) return list[0].id;

  let roll = random() * total;
  for (let i = 0; i < list.length; i++) {
    if (weights[i] <= 0) continue; // skipped, not merely improbable — see drawUpgrades
    roll -= weights[i];
    if (roll <= 0) return list[i].id;
  }
  // Float drift only. The last row with any weight is the honest answer.
  for (let i = list.length - 1; i >= 0; i--) if (weights[i] > 0) return list[i].id;
  return list[0].id;
}

/**
 * Run one upgrade's apply() at a given tier.
 *
 * Mutates `s`, exactly as a bare apply() would, so recomputeStats' loop is
 * unchanged apart from which function it calls.
 */
export function applyWithRarity(upgrade, s, rarityId) {
  if (!upgrade?.apply) return;
  const mul = rarityMul(rarityId);

  // The overwhelmingly common path: the floor tier, or rarity switched off.
  // Taking the snapshot for every pick on every recompute — which happens on
  // every level-up AND every tuner nudge — would be a copy of the whole stat
  // block per upgrade held, for nothing.
  if (!(mul > 1)) { upgrade.apply(s); return; }

  const before = {};
  for (const k in s) if (typeof s[k] === 'number') before[k] = s[k];

  upgrade.apply(s);

  let scaledAnything = false;
  for (const k in before) {
    const delta = s[k] - before[k];
    if (delta === 0) continue;
    if (INTEGER_STATS.has(k)) continue; // see the header — counts never scale
    s[k] = before[k] + delta * mul;
    scaledAnything = true;
  }

  // An upgrade that only moved counts got nothing from the amplification, so
  // its tier is paid out through its family instead. Without this, a Legendary
  // Shrimp Ring would be a gold ring around a card that is identical to the
  // grey one — which is worse than not having rarity, because the card lies.
  if (!scaledAnything) payFamily(upgrade, s, mul);
}

function payFamily(upgrade, s, mul) {
  const stat = FAMILY_PAYOUT[upgrade.family ?? 'utility'];
  if (!stat || typeof s[stat] !== 'number') return;
  // Scaled well below the tier's own multiplier. `mul` is calibrated against
  // "how much more did this card's own numbers move", and a count upgrade's
  // payout is a substitute for that, not a second helping — a Legendary paying
  // its full 1.7x onto aoeMul would be worth more than four stacks of Splash
  // Zone from a single card.
  const payout = CONFIG.rarityPayout ?? 0.35;
  s[stat] *= 1 + (mul - 1) * payout;
}

/**
 * The best tier on the table, for the one sting a level-up plays.
 *
 * Three overlapping stings would smear, and the two quieter ones would be
 * inaudible under the loudest anyway — so the menu announces the best card and
 * says nothing about the rest.
 */
export function bestRarity(picks) {
  let best = null;
  let bestRank = -1;
  for (const p of picks) {
    const rank = rarityRank(p?.rarity);
    if (p?.rarity && rank > bestRank) { bestRank = rank; best = p.rarity; }
  }
  return best;
}
