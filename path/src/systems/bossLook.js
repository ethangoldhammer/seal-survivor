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

// What the body was wearing before the perk touched it, so it can be handed
// back unchanged. Held here rather than on the enemy: the enemy object is
// pooled too, and a field left on it is one more thing resetEnemy has to know
// about. One boss at a time, so one slot.
let priorVariant = null;
let paintedRoot = null;

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
  setBiolumSkinVariant(root, merged);
  return merged;
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
}
