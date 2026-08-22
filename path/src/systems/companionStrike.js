import { CONFIG } from '../config.js';
import { sealTeamSize, sealTeamDamage } from './sealTeam.js';
import { podStats } from './orca.js';
import { currentHarpStats } from './harp.js';
import { bombDamage } from './bakalar.js';
import { orbiterCount } from '../stats.js';

// ---------------------------------------------------------------------------
// THE COMPANIONS JOIN A PERFECT STRIKE.
//
// A perfect charge — the bar fully banked, CONFIG.strike.charge.perfectAt —
// used to buy exactly two things: a multiplier on a boss weak spot, and the
// flash that announced it. Everything else the meter does, a merely FULL bar
// does just as well. That made the top of the bar a ceiling you held against
// rather than a target you hit, which is the opposite of what a charge with a
// named perfect ought to feel like.
//
// This is the payoff. On a perfect release every companion the run owns hits
// WITH you: their damage is summed and folded into the strike's own release
// burst, so the pop at the seal is the whole entourage landing on one frame
// instead of the seal landing alone while its friends carry on doing their own
// thing on their own timers.
//
// WHY IT LANDS ON THE BURST AND NOT AS SEPARATE HITS. The companions already
// deal their damage where they are — an escort rams the shark it lunged at, an
// orca is halfway across the arena on a boat. Spawning a second hit at each of
// them would be a scatter of numbers in six places on the one frame the player
// is looking at the seal. One number, at the point of release, is the read: you
// hit the beat, and everything you own hit it with you.
//
// WHAT COUNTS AS A COMPANION HERE is "a companion that has a hit of its own to
// lend". The beluga, the dumbo and the octopus grabber are control abilities —
// they hold, charm and grab, and none of them deals a point of damage — so
// they lend nothing, and that is the honest answer rather than an oversight.
// The Dolphin Pod is not here because it is not implemented (see its upgrade
// entry); adding it is one line in COMPANIONS below.
//
// THE CEILING IS A MULTIPLE OF THE STRIKE, not a flat number. A late run with
// six escorts, a maxed pod and Big Rigz sums to several hundred, and a bonus
// that is unbounded relative to the thing it is a bonus TO stops being a
// payoff and becomes the whole weapon. `maxMul` is the cap and it is stated in
// strike-damages so it stays meaningful as the strike line itself is levelled.
// ---------------------------------------------------------------------------

/**
 * Every companion that has a hit to lend, and how many of it there are.
 *
 * One table rather than a chain of ifs, and each entry asks the companion's OWN
 * system for the number instead of re-deriving it from CONFIG. That is the
 * whole reason sealTeamDamage(), podStats() and bombDamage() are exported: a
 * copy of "contactDamage + damagePerLevel * (level - 1)" here would be right
 * on the day it was written and silently wrong the first time either half of
 * it moved.
 *
 * @param stats the run's stat block
 * @returns [{ id, count, damage }] — `damage` is per body, `count` is how many
 *          of them there are, and neither is multiplied by `share` yet.
 */
export function companionStrikeParts(stats) {
  const parts = [];
  const lv = (key) => Math.max(0, Math.floor(stats?.[key] ?? 0));

  // SEAL TEAM — the escorts ram, and every one of them rams.
  const sealLv = lv('sealTeamLevel');
  if (sealLv > 0) {
    parts.push({
      id: 'sealTeam',
      count: sealTeamSize(sealLv, stats?.orbiterBonus ?? 0),
      damage: sealTeamDamage(sealLv),
    });
  }

  // ORCA FAMILY — a fixed pod whose stacks buy damage rather than bodies, so
  // the count comes off CONFIG and only the damage moves with the level.
  const orcaLv = lv('orcaLevel');
  if (orcaLv > 0) {
    parts.push({ id: 'orca', count: CONFIG.orca?.count ?? 0, damage: podStats(orcaLv).damage });
  }

  // HARP SEAL — the note, not the aura. The aura is a lingering field the harp
  // leaves ON a body it charmed; what a harp does in one moment is pluck once,
  // and one moment is what this is summing.
  const harpLv = lv('harpLevel');
  if (harpLv > 0) {
    parts.push({
      id: 'harp',
      // Through orbiterCount, the same way main.js sizes the ring — Entourage
      // buys instruments, and an entourage that is on screen playing should be
      // on screen striking.
      count: orbiterCount(1, stats),
      damage: currentHarpStats(harpLv).damage,
    });
  }

  // BAKALAR'S BOAT — the voicemail bomb. The haul deals no damage at all (it
  // is the one ability in the game that removes without hurting), so the bomb
  // is the only thing the boat has to lend.
  const bakalarLv = lv('bakalarLevel');
  if (bakalarLv > 0 && CONFIG.bakalar?.bomb?.enabled !== false) {
    parts.push({ id: 'bakalar', count: 1, damage: bombDamage(bakalarLv) });
  }

  return parts;
}

/**
 * What the companions add to this release's burst.
 *
 * @param stats       the run's stat block
 * @param perfect     was the dash bought with a PERFECT charge — the caller's
 *                    answer, not read out of strikeState, so a harness can ask
 *                    the question without a meter
 * @param strikeDamage what the burst is worth on its own, for the ceiling. The
 *                    cap is a multiple of the strike rather than a flat number
 *                    so it keeps meaning something as the strike line levels.
 * @returns extra damage to add to the burst, 0 when the release wasn't perfect
 */
export function companionStrikeBonus(stats, perfect, strikeDamage = 0) {
  const c = CONFIG.strike?.companionStack ?? {};
  if (!perfect || c.enabled === false) return 0;
  const share = c.share ?? 0;
  if (!(share > 0)) return 0;

  let total = 0;
  for (const p of companionStrikeParts(stats)) total += p.count * p.damage;
  total *= share;

  // The ceiling. Applied to the BONUS and not to the sum of the two, so the
  // strike's own damage is never capped by a rule about its companions.
  const cap = c.maxMul ?? 0;
  if (cap > 0 && strikeDamage > 0) total = Math.min(total, strikeDamage * cap);
  return total;
}

/**
 * How many companions are lending, for the toast that announces it.
 *
 * Bodies rather than cards: three orcas and six escorts is nine animals hitting
 * with you, and "9" is the number the moment is about. A count of the CARDS
 * taken would say "2".
 */
export function companionStrikeCount(stats) {
  let n = 0;
  for (const p of companionStrikeParts(stats)) n += p.count;
  return n;
}
