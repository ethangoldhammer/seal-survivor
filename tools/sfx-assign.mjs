#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Wire a recording session into the bank: the mapping from delivered file
// names to the events they belong to.
//
// Two sessions so far — the EG_/EliArf_/EliDadSeal_ voice recordings, and a
// batch of commercial library effects. Kept as a script rather than done by
// hand because the target
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
//
// IT REFUSES TO RUN WHILE THE GAME IS UP, and that guard is the whole lesson
// of the run that made it necessary. This is not idempotent against a HUMAN:
// re-running it is a no-op only if nothing has moved since, and the F menu is
// where things move. Somebody spent an hour reassigning takes — pulling all
// eight EatChum files off `chumEaten`, putting two of them on `strikeChain`,
// swapping `chumFull` for a different sound — and a second run of this script
// put every one of those back, because "the file is already in the list" is
// the only question it knows how to ask. It cannot tell a take it has never
// added from a take somebody deliberately removed.
//
// A live dev server also means the tuning file has a second writer: the game
// rewrites the whole snapshot from its own state whenever it saves, so a write
// from here can be flattened a second later, or can flatten a save that was
// about to happen. Both directions lose work.
//
// So: close the game, run this, then start the game. --force is there because
// a rule with no override gets worked around, not because it is ever a good
// idea.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { survey } from './servers.mjs';

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

  // =========================================================================
  // THE LIBRARY BATCH — commercial effects, August 2026.
  //
  // Ten of the delivered files were byte-identical renames of others in the
  // same drop (Razor_01 IS the kitchen-knife file, Whale_01 IS the spooky
  // beast call, and so on). Only the short game-domain name of each pair is in
  // public/sfx: the same bytes twice would ship twice, decode twice, and give
  // one take double the odds in pickSample.
  //
  // Not here on purpose:
  //   FF_AS_fish_splash_*   four tiers of one sound, held back until they can
  //                         be auditioned against a fight. They ship and are
  //                         in the F menu library, wired to nothing.
  //   Electricity_01        61s of unbroken hum, never quieter than -7 dBFS in
  //                         any half second of it. There is no one-shot inside
  //                         a drone, so it is a library file and not a voice.
  // =========================================================================

  // --- everything electric --------------------------------------------------
  // Three systems, none of which had a sample. Electricity_02 was a 64s bed
  // cut down by tools/sfx-excerpt.mjs; the rest arrived short.
  eelBolt:        ['Electricity_02'],
  eelChain:       ['Electricity_03'],
  elementArc:     ['Electricity_03'],
  // The shock element lands on every hit a shock weapon makes, so it takes the
  // shortest file in the batch — a 0.57s tick, not a 1.5s crackle.
  elementHit:     ['shs_cyber_button_ui_spark_electric_1'],
  // A 9.8s explosion with a smooth decay all the way to -67 dBFS. Long for a
  // voice slot, and affordable only because the ice club is rare.
  clubShock:      ['FF_ES_fx_explosion_lightning'],

  // --- beams and blades -----------------------------------------------------
  bakalarHaul:    ['Laser_01'],
  pearlShot:      ['JAFUNK_fx_lazer_mid_tide'],
  razorClamLaunch: ['Razor_01'],
  // The razor's hit has no event of its own; `hit` is where a bullet and a
  // beam both land, which is where the clam's damage lands too.
  hit:            ['Razor_Hit_01'],
  strikeChain:    ['Chain_01'],

  // --- big animals ----------------------------------------------------------
  whaleCall:      ['Whale_01'],
  // Boss voices are per MATERIAL, not per creature (see bossVoice in
  // systems/feedback.js) — the mosasaur is voiceDefault, which is flesh.
  bossDieFlesh:   ['Mosasaurus_01'],
  bossHitFlesh:   ['BRS_Flesh_Splat_Beefy_Hit'],
  bite:           ['ESM_PG_cinematic_fx_creature_sea_monsters_shark_predator_attack_thump_03'],
  kill:           ['ESM_MG3_fx_foley_slime_smash_squish_splat_01c',
                   'ESM_MG3_fx_foley_slime_smash_squish_splat_03c'],

  // --- water and reward -----------------------------------------------------
  bubblePop:      ['DS_SCB_foley_one_shot_water_droplet_echo', 'DS_SCB_foley_one_shot_water_droplet_high'],
  levelUp:        ['ESM_PG_cinematic_fx_magic_collect_kick_thump_shimmer_glisten_05',
                   'ESM_PG_cinematic_fx_magic_item_award_hit_chime_ding_positive_shimmer_04'],

  // --- the ships ------------------------------------------------------------
  // boatExplosion and debrisBreak are voices of their own as of this batch —
  // they used to borrow `bigKill` and `kill`, which was fine while both were
  // synth and is not once a cannon is involved. See CONFIG.sfx.
  boatExplosion:  ['ESM_PG_cinematic_fx_weapons_warefare_cannon_ship_impact_explosion_wood_03'],
  debrisBreak:    ['ESM_PG_cinematic_fx_foley_ship_shipwrecking_moving_stone_impact_debris_creak_02'],
  // No cannon event exists to fire a shot of its own, and the mussel volley is
  // the nearest thing the game has to artillery.
  missileLaunch:  ['ESM_PG_cinematic_fx_weapons_warefare_cannon_shot_ship_clanking_metal_03'],
  missileImpact:  ['ESM_PG_fx_water_splash_weapon_cannon_impact_near_air_projectile_whoosh_02'],

  // =========================================================================
  // THE WEDDELL / PAPS BATCH, August 2026.
  //
  // Seal_Paps_takeDamage_01 is NOT here: 1253 bytes, three frames of audio,
  // and it decodes to 0.008s of digital silence. It is a broken export, not a
  // quiet take, and a silent take in a nine-deep voice is one hit in nine
  // where the seal says nothing.
  // =========================================================================
  playerHit:      ['Seal_Paps_takeDamage_02', 'Seal_Paps_takeDamage_03'],
  // The new `celebrate` voice, fired once as the victory lap starts.
  celebrate:      ['Seal_Weddell_01', 'Seal_Weddell_02', 'Seal_Weddell_03', 'Seal_Weddell_04',
                   'Seal_Weddell_05', 'Seal_Weddell_06', 'Seal_Weddell_07'],

  // =========================================================================
  // THE MOOG SUB 37 BATCH, August 2026. Eighteen synth one-shots out of a
  // 128-file pack, and the only ones wired to anything are the three lasers.
  // The other fifteen ship as library files in the F menu, auditionable
  // against a fight before any of them takes an event — the same holding
  // pattern the fish_splash tiers are in above.
  //
  // ALL EIGHTEEN ARE 16kHz MONO. That is a preview-grade rate for this bank
  // (everything else is 22.05kHz or better) and it is audible as a ceiling
  // around 8kHz — on a laser, which is mostly a downward sweep with no air in
  // it, that costs nothing. It would cost something on a splash.
  //
  // APPLIED BY HAND, NOT BY THIS SCRIPT, and that is worth recording: a run
  // of the whole file on 2026-08-28 added 38 takes, of which only these three
  // were new. The other 35 were takes pulled off `chumEaten`, `pickup`,
  // `kill`, `hit` and six more voices in the F menu — exactly the failure the
  // header at the top describes, now with a number on it. The tuning was
  // restored from the .pre-assign backup and only shootLaser written. Treat a
  // full run as destructive until the mapping is reconciled with what is
  // actually on those voices today.
  //
  // THE FIN LASER'S SHOT. shootLaser was staged with `srcs: []` and a
  // sawtooth blip waiting for exactly this; three takes is what the row asked
  // for, because the bolt fires several times a second and pickSample never
  // repeats a take back to back, so a burst is three sweeps rather than one
  // stutter. 0.29s / 0.43s / 0.32s — all shorter than the gap between shots,
  // so no take is cut off by the next.
  // =========================================================================
  shootLaser:     ['HGUI_s37_Laser_03_lo', 'HGUI_s37_Laser_05_lo', 'HGUI_s37_Laser_06_lo'],
};

if (!process.argv.includes('--force')) {
  const live = (await survey()).filter((p) => p.role === 'dev');
  if (live.length) {
    console.error('\n  REFUSING — the game is running:\n');
    for (const p of live) console.error(`    pid ${p.pid} on port ${p.ports.join(', ')} (up ${Math.round(p.age / 60)}m)`);
    console.error('\n  A dev server rewrites imported-tuning.json from its own state, and this'
      + '\n  script cannot tell a take you removed in the F menu from one it has never'
      + '\n  added — so a run now can both lose your edits and undo them.'
      + '\n\n  Stop the game (npm run servers), run this, then start it again.'
      + '\n  --force overrides, and you will want a copy of the tuning file first.\n');
    process.exit(1);
  }
}

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

// Kept, not cleaned up. It is the only route back if this run turns out to
// have re-added something that was removed on purpose.
copyFileSync(TUNING, `${TUNING}.pre-assign`);
writeFileSync(TUNING, `${JSON.stringify(tuning, null, 2)}\n`);
console.log(`  ${added} take(s) added across ${Object.keys(ASSIGN).length} voices`);
console.log(`  backup: ${TUNING}.pre-assign`);
