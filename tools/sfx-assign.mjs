#!/usr/bin/env node
// ---------------------------------------------------------------------------
// One-shot: wire the August 2026 voice session into the bank.
//
// The 74 files under public/sfx named EG_*, EliArf_* and EliDadSeal_* are a
// recording session, and this is the mapping from those names to the events
// they belong to. Kept as a script rather than done by hand because the target
// is imported-tuning.json — 222KB of the tuner's saved state, where a hand
// edit is a merge conflict waiting to happen and a typo is a silent revert to
// the synth.
//
// WHY THE TUNING FILE AND NOT config.js. Sample assignment already lives here
// for all seventy of the existing ones: config.js says `src: null` for every
// voice in the game, and imported-tuning.json is what actually points them at
// files. A saved value beats a config default, so an assignment written into
// config.js while the tuning file still holds a `srcs` for that voice would be
// shadowed and appear to do nothing. See the note in tools/sfx-atlas.mjs.
//
// ADD, NOT REPLACE. Every voice below keeps the takes it already had — this
// appends. `playerHit` ends up with eleven.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TUNING = join(ROOT, 'path', 'src', 'imported-tuning.json');
const SFX_DIR = join(ROOT, 'public', 'sfx');

// voice -> files, in the order they should sit in the take list.
const ASSIGN = {
  // --- named on the tin -----------------------------------------------------
  playerHit:      ['EliArf_TakeDamage_01', 'EliArf_TakeDamage_02'],
  bigKill:        ['EliArf_BigKill_01', 'EliArf_BigKill_02'],
  bite:           ['EliArf_Chomp_01', 'EliArf_Chomp_02'],
  strike:         ['EliArf_Boost_01', 'EliArf_Boost_02'],
  chumEaten:      ['EliArf_EatChum_01', 'EliArf_EatChum_02', 'EliArf_EatChum_03', 'EliArf_EatChum_04',
                   'EliArf_EatChum_05', 'EliArf_EatChum_06', 'EliArf_EatChum_07', 'EliArf_EatChum_08'],
  foodChain:      ['EliArf_FoodChain_01'],
  breathIn:       ['EG_Inhale_01', 'EG_Inhale_02', 'EG_Inhale_03', 'EG_Inhale_04', 'EG_Inhale_05'],

  // --- named by their sound rather than their moment ------------------------
  // The blast the mussel makes landing. `bigKill` already took the two files
  // labelled for it, so these go to the other explosion in the game.
  missileImpact:  ['EliArf_Explode1', 'EliArf_Explode_01'],
  // A bloop is a bubble. Joins pickup2.mp3 on the burst.
  bubblePop:      ['EliArf_Bloop_01', 'EliArf_Bloop_02', 'EliArf_Bloop_03'],
  // Swallowing a chunk, as distinct from hoovering an orb — which is why
  // these are not on `chumEaten` with the EatChum takes.
  chumChunkEaten: ['EliArf_Gulp_01', 'EliArf_Gulp_02', 'EliArf_Gulp_03', 'EliArf_Gulp_04'],
  // Teeth on carapace: the sound of your damage landing on a shell boss, which
  // has been synth since it was written.
  bossHitShell:   ['EliArf_clack_01', 'EliArf_clack_02'],
  // Sixteen short plops for the sound that fires most often in the game.
  pickup:         ['EG_FlickPlop_01', 'EG_FlickPlop_02', 'EG_FlickPlop_03', 'EG_FlickPlop_04',
                   'EG_FlickPlop_05', 'EG_FlickPlop_06', 'EG_FlickPlop_07', 'EG_FlickPlop_08',
                   'EG_FlickPlop_09', 'EG_FlickPlop_10', 'EG_FlickPlop_11', 'EG_FlickPlop_12',
                   'EG_FlickPlop_13', 'EG_FlickPlop_14', 'EG_FlickPlop_15', 'EG_FlickPlop_16'],
  // A grumble when the boost meter is dry — the same length as the Seal_07
  // take already there, and a great deal more disappointed.
  boostEmpty:     ['EG_Grumbler_01', 'EG_Grumbler_02'],
  // A small squeak, on the small impact.
  bounce:         ['EG_Eep'],

  // --- the escort seals -----------------------------------------------------
  // EliArf_01-07 and Art_08 are unlabelled barks, and all three escort voices
  // were still pure synth. Split by character rather than by number: the ram
  // is an impact, the lunge is travel, and the shot fires most often so it
  // gets the shortest takes.
  sealRam:        ['EliArf_01', 'EliArf_03'],
  sealLunge:      ['EliArf_05', 'EliArf_06', 'EliArf_07', 'EliArf_wishh_01', 'EliArf_wishh_02'],
  sealShot:       ['EliArf_Art_08', 'EliArf_02', 'EliArf_04'],

  // --- the player's own voice -----------------------------------------------
  // The bigger performer. Breaching is the seal's signature bark; the longest
  // of the five goes on the level-up instead.
  breach:         ['EliDadSeal_48', 'EliDadSeal_49', 'EliDadSeal_50', 'EliDadSeal_52'],
  levelUp:        ['EliDadSeal_51'],

  // --- the two new voices ---------------------------------------------------
  breathOut:      ['EG_Exhale_01', 'EG_Exhale_02', 'EG_Exhale_03', 'EG_Exhale_04', 'EG_Exhale_05'],
  // "Mouth windfall" — the chum meter crossing to full, which fired silently
  // until this session gave it something to say.
  chumFull:       ['EG_Mouthwindfall', 'EG_MouthWindfall_02'],
};

const tuning = JSON.parse(readFileSync(TUNING, 'utf8'));
tuning.sfx ??= {};

const problems = [];
let added = 0;
for (const [voice, files] of Object.entries(ASSIGN)) {
  const def = (tuning.sfx[voice] ??= {});
  const srcs = Array.isArray(def.srcs) ? [...def.srcs] : (def.src ? [def.src] : []);
  for (const name of files) {
    const src = `/sfx/${name}.mp3`;
    if (!existsSync(join(SFX_DIR, `${name}.mp3`))) { problems.push(`missing file: ${src}`); continue; }
    if (srcs.includes(src)) continue;   // idempotent: a second run adds nothing
    srcs.push(src);
    added++;
  }
  def.srcs = srcs;
  // `src` is the one-file shorthand and loses to `srcs` in playSfx, but the
  // workbench clears it whenever it edits a take list. Matched here so a voice
  // this script touched looks exactly like a voice the F menu touched.
  def.src = null;
}

// The event was declared with `sfx: null` and that null is SAVED, so it beats
// the config default this change added. Set here too or the voice above is
// unreachable — the event stays silent and nothing says why.
if (tuning.feedback?.chumFull) tuning.feedback.chumFull.sfx = 'chumFull';

if (problems.length) {
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

copyFileSync(TUNING, `${TUNING}.pre-assign`);
writeFileSync(TUNING, `${JSON.stringify(tuning, null, 2)}\n`);
console.log(`  ${added} take(s) added across ${Object.keys(ASSIGN).length} voices`);
console.log(`  backup: ${TUNING}.pre-assign`);
