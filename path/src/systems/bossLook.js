import { CONFIG } from '../config.js';
import bossLooksCsv from '../bossLooks.csv?raw';
import { parseBossLookCsv, buildBossLooks } from '../bossLookTable.js';
import { PERK_IDS } from '../bossPerkTable.js';
import { BIOLUM_PATTERNS, setBiolumSkinVariant, biolumSkinPresetOf } from './biolumSkin.js';
import { threatColor } from './organicRing.js';

// ============================================================================
// THE BOSS WEARS ITS PERK.
//
// One rendering of one fact, in three places that cannot disagree:
//
//   the NAME     rollBossName hands one slot to the perk's vocabulary, so the
//                boss is CALLED something electric
//   the RING     the aura is drawn in the perk's `attack` colour, out of the
//                one palette in systems/organicRing.js
//   the BODY     this module, which paints the animal from the same row
//
// The join is the PERK, not the name — see the header of bossLookTable.js for
// why adapting the name generator itself was the wrong shape for it.
//
// WHAT THIS IS NOT. It is not a second skin system. `setBiolumSkinVariant`
// already does the whole job of "override the look of ONE individual on top of
// its species preset", and it is what the crabs use to arrive in a heap of
// different shells. All this module owns is WHICH variant a boss gets, when it
// is stamped, and — the half that is genuinely new — putting it back.
//
// PUTTING IT BACK IS THE PART THAT BITES. Bodies are pooled. A recycled body
// arrives still wearing whatever it wore when it died, and the usual defence
// (entities/enemies.js re-rolls the skin on every spawn) does not cover this
// case: rollBiolumSkinVariant only calls setBiolumSkinVariant WHEN THE ROLL
// RETURNS SOMETHING, and a preset with no rows in skins.csv rolls nothing at
// all. Every boss body is such a preset today. So a boss's perk look would
// survive its death, ride the pool, and turn up on the next ordinary shark of
// that asset — a wave animal glowing with a perk nothing in the water has.
// Hence clearBossLook, called from releaseBoss in systems/bossPerks.js, which
// is where the rest of "undo what the perk did to the creature" already lives.
// ============================================================================

const LOOKS = buildBossLooks(parseBossLookCsv(bossLooksCsv), {
  patterns: BIOLUM_PATTERNS,
  perks: PERK_IDS,
});

/** The parsed table, for the contact sheet and the tests. */
export function bossLookRoster() {
  return LOOKS;
}

/** The look for a perk id, or null for a perk with no row (or a blank one). */
export function bossLookFor(perkId) {
  if (!perkId) return null;
  if (CONFIG.boss?.looks?.enabled === false) return null;
  return LOOKS[perkId] ?? null;
}

/**
 * What the perk's arcs are drawn in.
 *
 * THE DEFAULT IS THE RING, and that is the whole design: `sparkColor` blank in
 * bossLooks.csv falls through to the perk's `attack` type, which is the same
 * number the aura ring is built from. Sparks that match the boundary they
 * cross is not a thing an author maintains here, it is a thing that cannot be
 * false. A hex in the cell opts out, deliberately.
 */
export function bossSparkColor(perk) {
  const row = bossLookFor(perk?.id);
  if (row?.sparkColor != null) return row.sparkColor;
  return threatColor(perk?.attack ?? 'kinetic');
}

// ---------------------------------------------------------------------------
// AND THE PAINT MOVES WITH THE FIGHT.
// ---------------------------------------------------------------------------
// The row is the RESTING look. What updateBossLook adds is a single drive,
// 0..1, that rises while the perk is doing something and ebbs when it stops,
// and multiplies the two channels that read as "this animal is charged":
// `strength` (the marking) and `shellGlow` (the light behind it).
//
// WHY THIS IS NOT FOUR MORE COLUMNS IN bossLooks.csv. What the drive is worth
// is one statement about every perk — a boss winding up is brighter than a
// boss on cooldown — and a per-row copy of it would be eleven places for the
// same idea to drift. The row says what a perk LOOKS like; this says what any
// perk does while it is happening.
//
// IT IS DRIVEN BY THE STAGE AND NOT BY A TIMER. activeBossPerk publishes which
// stage the machine is in, and every perk in the file independently calls its
// tell 'windup' — but it does not publish how long that stage was, and a
// module that guessed would be wrong on the one perk that retuned. So the
// drive is an exponential approach with its own rise and fall (see
// CONFIG.boss.looks.charge): it climbs while the perk is off cooldown and
// falls back when it returns, and the shape is right for a 0.4s tell and a 6s
// field alike without either number appearing here.
//
// THE STORM PERKS GET THE BREATH. A field that is OPEN is the one stage that
// lasts long enough for a static level to read as a still frame — everything
// else is over in under a second. See STORM_STAGES.
//
// RESTAMPED ON A BUCKET, not per frame: setBiolumSkinVariant walks the body
// and re-resolves every material it finds, which is the same cost
// updateChargeSkin and updateElementSkin bucket themselves against.
// ---------------------------------------------------------------------------

// The stages that mean "the field is open", across the perks that have one.
// A Set of stage names rather than a per-perk flag, the same shape
// INTERRUPTIBLE takes in systems/bossPerks.js and for the same reason: it is
// what the state machines actually share, and a perk written tomorrow inherits
// the behaviour by naming its stage what everyone else names theirs.
const STORM_STAGES = new Set(['storm']);

// The live drive and what it was last stamped at. Held beside the paint rather
// than on the enemy: one boss at a time, and a field left on a pooled creature
// is one more thing resetEnemy would have to know about.
let drive = 0;
let stampedBucket = -1;
let breathCycle = 0;

// What the body was wearing before the perk touched it, so it can be handed
// back unchanged. Held here rather than on the enemy: the enemy object is
// pooled too, and a field left on it is one more thing resetEnemy has to know
// about. One boss at a time, so one slot.
let priorVariant = null;
let paintedRoot = null;
// The look as authored, before the drive multiplies anything into it.
let restingVariant = null;

// The variant currently stamped on an already-built body, or null. Read off
// the first instanced biolum material found — they are all stamped together by
// setBiolumSkinVariant, so the first one is the answer for all of them.
function variantOf(root) {
  let found = null;
  root?.traverse?.((o) => {
    if (found || !o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (m?.userData?.__bioSkin && m.userData.__bioSkinInstance) {
        found = m.userData.__bioSkinVariant ?? null;
        return;
      }
    }
  });
  return found;
}

/**
 * Paint this boss with its perk's look. Called from attachBossPerk, which runs
 * AFTER the spawn — so the species skin has already been rolled and stamped,
 * and this lands on top of it.
 *
 * MERGED OVER what the body already wears rather than replacing it, which is
 * what makes "blank means inherit" true all the way down: a look that sets
 * only `strength` lights the markings the individual happened to roll instead
 * of resetting it to the species pattern. setBiolumSkinVariant replaces the
 * variant wholesale, so the merge has to happen here.
 *
 * Silently does nothing on a body with no procedural skin — which is the
 * correct behaviour and also the thing to check first when a perk look does
 * not appear: see assets.csv, `surface` column.
 */
export function applyBossLook(enemy, perk) {
  clearBossLook();
  const root = enemy?.visual;
  const row = bossLookFor(perk?.id);
  if (!root || !row) return null;
  // Not merely "does it have materials" — a body with no preset has nothing
  // for the stamp to land on, and reporting that is worth more than a no-op.
  if (!biolumSkinPresetOf(root)) {
    if (CONFIG.boss?.looks?.warnUnskinned !== false) {
      console.warn(`[bossLook] perk "${perk.id}" has a look, but this boss's body wears no `
        + 'biolumSkin preset — nothing to paint. Give the asset a `surface` in assets.csv.');
    }
    return null;
  }

  priorVariant = variantOf(root);
  paintedRoot = root;
  const merged = { ...(priorVariant ?? {}), ...row.look, __bossLook: row.id };
  // The RESTING look, kept so the drive has something to multiply. Held as the
  // merged object rather than as the row: what the drive lifts is whatever the
  // body ended up wearing, which on a creature that rolled a skin is the row
  // over the roll and not the row alone.
  restingVariant = merged;
  drive = 0;
  stampedBucket = 0;
  breathCycle = 0;
  setBiolumSkinVariant(root, merged);
  return merged;
}

/**
 * Advance the drive and repaint if it has moved far enough to see.
 *
 * @param rawDt UNSCALED seconds. Raw, not the hitstop-scaled dt: a boss's own
 *              light does not hold its breath because the game froze for 60ms
 *              on a hit. Same argument as updateElementSkin.
 * @param perk  activeBossPerk(), handed in rather than imported — this module
 *              is imported BY systems/bossPerks.js, and reaching back into it
 *              would make the pair a cycle for the sake of one field.
 */
export function updateBossLook(rawDt = 0, perk = null) {
  const c = CONFIG.boss?.looks?.charge ?? {};
  if (!paintedRoot || !restingVariant || c.enabled === false) return;

  // A perk that is idle, absent, or belongs to some other body pulls the drive
  // back down rather than snapping it: the ebb after a tell is half of what
  // makes the tell read as one.
  const busy = !!perk && !!perk.stage && perk.stage !== 'ready';
  const tau = Math.max(0.01, busy ? (c.rise ?? 0.18) : (c.fall ?? 0.55));
  // Frame-rate independent approach, the same shape every smoothed value in
  // the project uses — 1 - e^(-dt/tau) rather than a fixed fraction per frame,
  // which would make the ramp faster on a fast machine.
  drive += ((busy ? 1 : 0) - drive) * (1 - Math.exp(-Math.max(0, rawDt) / tau));

  // The breath, and only while a field is actually open — see STORM_STAGES.
  let breath = 1;
  if (busy && STORM_STAGES.has(perk.stage)) {
    breathCycle += Math.max(0, rawDt) * (c.pulseSpeed ?? 1.4);
    breath = 1 + (c.pulseAmp ?? 0.18) * drive * Math.sin(breathCycle * Math.PI * 2);
  } else {
    breathCycle = 0;
  }

  const buckets = Math.max(1, c.buckets ?? 24);
  const bucket = Math.round(drive * breath * buckets);
  if (bucket === stampedBucket) return;
  stampedBucket = bucket;

  const lift = bucket / buckets;
  const scaled = { ...restingVariant };
  // Only the two channels that mean "charged". Colour is deliberately left
  // alone: the row's palette is what says WHICH perk this is, and a look that
  // shifted hue as it climbed would be two different bosses over one fight.
  if (restingVariant.strength != null) {
    scaled.strength = restingVariant.strength * (1 + lift * ((c.gain ?? 1.85) - 1));
  }
  if (restingVariant.shellGlow != null) {
    scaled.shellGlow = restingVariant.shellGlow * (1 + lift * ((c.glowGain ?? 2.4) - 1));
  }
  setBiolumSkinVariant(paintedRoot, scaled);
}

/** The live drive, for the harness. 0 at rest, 1 with a perk mid-attack. */
export function bossLookDrive() {
  return drive;
}

/**
 * Hand the body back exactly as it was found. See the note at the top of this
 * file for why this is not optional.
 *
 * Stamps an EMPTY variant rather than null when there was nothing before:
 * setBiolumSkinVariant early-outs on a falsy variant, so passing null would
 * leave the perk look in place — the precise bug this function exists for.
 * `{}` is truthy and resolves to the species preset with no overrides.
 */
export function clearBossLook() {
  if (paintedRoot) setBiolumSkinVariant(paintedRoot, priorVariant ?? {});
  paintedRoot = null;
  priorVariant = null;
  restingVariant = null;
  drive = 0;
  stampedBucket = -1;
  breathCycle = 0;
}
