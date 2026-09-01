// ============================================================================
// WHICH GUN THE SEAL STARTED AS — and the arithmetic that hangs off it.
//
// A leaf module, for the reason flipperSide.js is one: both ends of this need
// the rule and they sit on opposite sides of a dependency edge.
// entities/player.js has to roll the loadout and seed the stat block with it;
// systems/finLaser.js has to draw the bolt and shatter it, and it draws using
// systems/elements.js, which already imports player.js. player.js reaching for
// finLaser.js would close that into player → finLaser → elements → player.
//
// The split is not cosmetic. What is HERE is everything a number: the roll, the
// reach ramp, the lattice's counts. What is in systems/finLaser.js is
// everything that needs a scene — the material, the halo, the actual spawning
// of children. Which means all of this is testable in Node with no GL and no
// stub, and `npm run test:finlaser` is a test of the game rather than of a
// re-implementation of it.
//
// It imports CONFIG and nothing else, the same rule stats.js and
// playtestAnalysis.js follow.
// ============================================================================

import { CONFIG } from './config.js';

/** The loadout every run had before there was more than one. */
export const DEFAULT_LOADOUT = 'pebbles';

function cfg() {
  return CONFIG.finLaser ?? {};
}

// ---------------------------------------------------------------------------
// THE ROLL
// ---------------------------------------------------------------------------

/**
 * The loadout roster as `[{ id, weight }]`, skipping anything weighted 0.
 *
 * Read off CONFIG rather than hardcoded so a third type is a config block and
 * nothing else. A roster that comes out EMPTY (every weight zeroed, a bad
 * merge) falls back to pebbles rather than to undefined — a run with no weapon
 * type at all fires nothing, and that looks exactly like a bug in the gun
 * rather than like a bug in a table.
 */
export function loadoutRoster(types = CONFIG.loadout?.types ?? null) {
  const out = [];
  for (const [id, def] of Object.entries(types ?? {})) {
    const weight = Number(def?.weight ?? 0);
    if (weight > 0) out.push({ id, weight });
  }
  return out.length ? out : [{ id: DEFAULT_LOADOUT, weight: 1 }];
}

/**
 * A loadout named by CONFIG.loadout.force or by `?loadout=` — or null.
 *
 * ONE OVERRIDE, HONOURED BY EVERYTHING, and it is checked in rather than living
 * in a dev-only file because the two instruments that need it are not the game:
 * a Node harness has no URL to read and a look page has no player to ask.
 *
 * VALIDATED AGAINST THE ROSTER rather than trusted. A typo in a URL would
 * otherwise start a run carrying a loadout nothing in the game branches on,
 * which presents as the pebble gun with none of its upgrades working — a much
 * harder thing to recognise than a URL that did nothing.
 */
export function forcedLoadout() {
  const roster = new Set(loadoutRoster().map((r) => r.id));
  const fromConfig = CONFIG.loadout?.force;
  if (fromConfig && roster.has(fromConfig)) return fromConfig;

  let fromUrl = null;
  try {
    if (typeof location !== 'undefined' && location.search) {
      fromUrl = new URLSearchParams(location.search).get('loadout');
    }
  } catch { fromUrl = null; }
  return fromUrl && roster.has(fromUrl) ? fromUrl : null;
}

/**
 * What this run's seal is carrying.
 *
 * @param random injectable, so the distribution is checkable without a run —
 *               the same reason drawUpgrades takes one.
 */
export function rollLoadout(random = Math.random) {
  const forced = forcedLoadout();
  if (forced) return forced;
  if (CONFIG.loadout?.roll === false) return DEFAULT_LOADOUT;

  const roster = loadoutRoster();
  const total = roster.reduce((n, r) => n + r.weight, 0);
  let t = random() * total;
  for (const r of roster) {
    t -= r.weight;
    if (t <= 0) return r.id;
  }
  // Only reachable on a random() of exactly 1, which Math.random never returns
  // and an injected stub certainly can.
  return roster[roster.length - 1].id;
}

/**
 * What an un-upgraded gun is CALLED on this loadout.
 *
 * The base name the polaroid and the run summary fall back to before any card
 * has renamed the weapon — see weaponName.js, which owns the renaming and asks
 * this for its starting point.
 *
 * IT LIVES IN CONFIG rather than being written here for the reason the note
 * beside CONFIG.loadout.types gives: a loadout's name in two files is two
 * spellings of one idea waiting to drift. Null when the loadout has no label,
 * so the caller keeps whatever it already had rather than captioning a run with
 * an empty string.
 */
export function loadoutLabel(loadout) {
  const written = CONFIG.loadout?.types?.[loadout]?.label;
  return typeof written === 'string' && written.trim() ? written.trim() : null;
}

/** Whether `loadout` fires light rather than stones. */
export function isLaser(loadout) {
  return loadout === 'laser';
}

// ---------------------------------------------------------------------------
// THE REACH RAMP
// ---------------------------------------------------------------------------

/**
 * How many steps of reach a run has earned — the COUNT, not the multiplier, so
 * a readout can say "3 of 5" without re-deriving anything.
 *
 * GATED, NOT SCALED, ON THE BOSS. A run holding twenty gun stacks with no boss
 * down is on step 0, and the moment the first boss dies every step it already
 * qualified for lands at once. That is the intended shape rather than a
 * rounding of it: the ramp is paid for surviving the fight, and handing it over
 * in advance would make the fight the part that stopped mattering.
 *
 * "Gun stacks" is `family: 'gun'` read off CONFIG.upgrades rather than a list
 * written here, so a gun card added later counts without anybody remembering to
 * add it — and a pick whose id matches no upgrade contributes nothing rather
 * than counting as one.
 */
export function laserReachSteps(picks = [], bossesDefeated = 0, upgrades = CONFIG.upgrades ?? []) {
  const c = cfg();
  if ((c.reachNeedsBoss ?? true) && (bossesDefeated ?? 0) < 1) return 0;

  const gun = new Set((upgrades ?? []).filter((u) => u?.family === 'gun').map((u) => u.id));
  const stacks = (picks ?? []).filter((p) => gun.has(p?.id)).length;
  const per = Math.max(1, c.reachPerGunStacks ?? 5);
  return Math.min(c.reachStepsMax ?? 0, Math.floor(stacks / per));
}

/** The reach multiplier those steps are worth — 1 for a run that has earned none. */
export function laserReachMul(picks = [], bossesDefeated = 0, upgrades = CONFIG.upgrades ?? []) {
  return 1 + laserReachSteps(picks, bossesDefeated, upgrades) * (cfg().reachStepMul ?? 0);
}

// ---------------------------------------------------------------------------
// LATTICE SEALANT — the counts. The spawning is systems/finLaser.js.
// ---------------------------------------------------------------------------

/**
 * How many children a split at `generation` throws — 0 is the first split.
 *
 * THE THINNING IS THE FIRST OF THE THREE GUARDS against the shatter going
 * exponential (see the header of systems/finLaser.js). Without it the count is
 * children^generations, which at 4 and 3 is 64 bolts off one pellet, several
 * times a second.
 *
 * Floored at 1 rather than at 0, because a "split" that produced nothing would
 * still fire the sound and the flash and then delete the shot — which reads as
 * the bolt having been eaten rather than as it having shattered.
 */
export function childrenAt(generation, amount = 0) {
  const l = cfg().lattice ?? {};
  // CLAMPED HERE AS WELL AS AT THE CARD, and that is not belt-and-braces — it
  // is where the bound is actually guaranteed. The card is one of several ways
  // `latticeAmount` can move (a rarity payout, a level orb handing a stack to a
  // held upgrade, whatever is added next), and a ceiling enforced only at one
  // of them is a ceiling that leaks at the others.
  const amt = Math.min(Math.max(0, amount), l.amountMax ?? Infinity);
  const base = (l.children ?? 2) + amt;
  return Math.max(1, Math.round(base - generation * (l.childrenDecay ?? 1)));
}

/**
 * The generation limit this run has bought, from its pierce.
 *
 * PIERCE IS THE CURRENCY because on a laser it has almost nothing else to buy:
 * a bolt is consumed by its own split, so the stat only ever pays out on the
 * bolts that DON'T shatter. Reading it as depth as well gives the alternating
 * card a second thing to mean without a second stat to explain.
 */
export function latticeGenerations(pierce = 0) {
  const l = cfg().lattice ?? {};
  const per = Math.max(1, l.pierceStacksPerGeneration ?? 2);
  return Math.min(l.generationsMax ?? 1,
    (l.generationsBase ?? 1) + Math.floor(Math.max(0, pierce) / per));
}

/**
 * The payload a fresh bolt carries — or NULL when the run cannot split at all,
 * which is what keeps a lattice-less bolt byte-for-byte an ordinary projectile
 * rather than one carrying a payload that never fires.
 */
export function latticePayload(s = {}) {
  const chance = cfg().lattice?.chance ?? 0;
  if (!(chance > 0)) return null;
  return {
    chance,
    amount: Math.max(0, s.latticeAmount ?? 0),
    generation: 0,
    generations: latticeGenerations(s.pierce ?? 0),
  };
}

/**
 * THE WORST CASE, in bolts: how many shards one landed bolt can put in the water
 * if every roll succeeds all the way down.
 *
 * Exported because it is the thing the guards exist to bound, and a bound that
 * is only asserted inside a test is a bound nobody can ask about from a console
 * while they are retuning the block. `npm run test:finlaser` asserts it against
 * CONFIG.finLaser.lattice.budget.
 */
export function latticeWorstCase(amount = 0, generations = 1) {
  let total = 0;
  let live = 1;
  for (let g = 0; g < generations; g++) {
    live *= childrenAt(g, amount);
    total += live;
  }
  return total;
}

// ---------------------------------------------------------------------------
// THE LIVE BUDGET — guard (3).
// ---------------------------------------------------------------------------
//
// The counter is HERE rather than beside trySplit, and that is a dependency
// decision rather than a filing one. Two files have to touch it: the splitter
// (systems/finLaser.js) increments, and entities/projectiles.js decrements from
// its despawn, because a bolt can leave the water in four different ways — it
// hit, it pierced out, it flew past the arena, the run reset — and a count
// maintained at each of those separately is a count that leaks at whichever one
// somebody adds next. projectiles.js importing finLaser.js would close the
// cycle projectiles → finLaser → elements → projectiles; importing this leaf
// costs nothing.
//
// A LIVE count and not a per-frame one, deliberately: what costs a frame is not
// how many shards were made this tick, it is how many are being drawn.

let liveChildren = 0;

/** Bolts in the water right now that were born of a split. */
export function latticeLiveChildren() {
  return liveChildren;
}

/**
 * Whether `n` more children fit under the budget.
 *
 * Asked BEFORE any of them are spawned so a split is refused WHOLE. Trimming to
 * whatever fits would be worse than refusing: a bolt that quietly threw two
 * children when it normally throws four reads as the effect being broken, and
 * the player has no way to know a budget exists.
 */
export function latticeHasRoom(n) {
  return liveChildren + n <= (cfg().lattice?.budget ?? Infinity);
}

/** One child has been spawned. */
export function acquireLatticeChild() {
  liveChildren++;
}

/** One split-born bolt has left the water. A no-op for every other projectile. */
export function releaseLatticeChild(p) {
  if (p?.latticeChild) liveChildren = Math.max(0, liveChildren - 1);
}

/** Back to zero, with the rest of the run's teardown. */
export function resetLattice() {
  liveChildren = 0;
}
