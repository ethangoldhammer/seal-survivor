// ============================================================================
// DEATH CAUSES — what killed the seal, as a handful of words a writer can use.
//
// Every point of damage the player takes already arrives with a `source`: a
// creature's own type key ('megalodon', 'walkingCrab'), a boss attack
// ('boss:boatSalvo'), or one of the three things in the water that aren't
// animals at all ('drowning', 'lightning', 'enemy shot'). That is thirty-odd
// strings, which is the right vocabulary for the playtest ledger and exactly
// the wrong one for quips.csv — nobody writing a game-over line thinks "this
// one is for abyssShark, megalodon and mightyMeg".
//
// So this is the translation layer, and it is the only one. A cause is a word
// with a joke attached to it: `shark`, `crab`, `drowning`. Sixteen of them,
// each covering every source that a player would describe the same way.
//
// WHY THE MEMBERSHIP IS WRITTEN OUT rather than derived from a flag on the
// creature: there is no honest flag to derive it from. `spawnGroup` is about
// concurrency caps — it says "apex shark" for the shark family, which is
// tempting, and then says "apex" for the orca, the squid, the boat and a
// dolphin, which is nobody's idea of a cause of death. A taxonomy invented
// for spawn budgets is not a taxonomy of jokes.
//
// The cost of writing it out is drift: a creature added to enemies.csv and
// forgotten here would kill the player under a cause of `null` and quietly
// fall back to the general quip pool — a nothing-happened bug, the worst kind
// to find. So `npm run test:quips` asserts that EVERY id in enemies.csv and
// EVERY id in bosses.csv is classified here, and fails naming the ones that
// are not. Adding a creature is then a two-file change the test insists on,
// instead of a one-file change that silently half-works.
// ============================================================================

/**
 * The causes, in the order the quip editor offers them: the animals first,
 * biggest threat down, then the three deaths that aren't animals.
 *
 * `sources` are the exact strings that reach recordPlayerDamage.
 *
 * `label` is the cause AS A NOUN PHRASE WITH ITS ARTICLE — "a shark", "the
 * orca", "running out of air" — which is what makes it droppable into the
 * middle of a sentence somebody wrote. It heads the quip editor's picker, it
 * names a cause in a warning, and it is what the `{cause}` chip becomes: the
 * hello at the top of a run can comment on the death that ended the last one
 * (greetings.csv, systems/greeting.js), and that line is spoken to a player.
 * So these are written to be READ mid-sentence and lowercase — see the note in
 * greetingTable.js about why nothing capitalises them on the way out.
 *
 * `threat` IS shown to a player: it heads the row on the score screen's
 * Threats tab, which is a list of what took the most health off you. It exists
 * because there is nowhere else to get a creature's name from — enemies.csv is
 * balance columns keyed by id and has never had one — and because a table of
 * ids is not the right answer anyway. A player who lost a run to four species
 * of shark did not lose it to four things. The grouping this file already
 * performs for jokes is the same grouping that reads correctly in a recap,
 * which is why the labels live here rather than in a table of their own that
 * would immediately drift from this one.
 */
export const DEATH_CAUSES = [
  { id: 'shark', label: 'a shark', threat: 'Sharks', sources: ['shark', 'greatWhite', 'hammerhead', 'abyssShark', 'megalodon', 'mightyMeg', 'bossShark', 'bossHammerhead'] },
  { id: 'orca', label: 'the orca', threat: 'The orca', sources: ['bossOrca'] },
  { id: 'mosasaur', label: 'the mosasaur', threat: 'The mosasaur', sources: ['bossMosasaur'] },
  { id: 'squid', label: 'a squid or the kraken', threat: 'Squid', sources: ['squid', 'bossSquid'] },
  { id: 'crab', label: 'a crab', threat: 'Crabs', sources: ['walkingCrab', 'emberCrab', 'bossCrab'] },
  // The only boss whose ATTACKS get their own cause, because they are the only
  // ones a player would name: 'boss:boatSalvo' and its two siblings are shells
  // off the trawler, and being shelled by the trawler is being killed by the
  // trawler. A perk fired by the orca arrives as 'boss:electricAura', which is
  // a boss death and nothing more specific — nobody writes a line about an aura.
  // The yacht rides here rather than in a cause of its own: bosses.csv calls it
  // a SUBTYPE of the trawler, it is steered by the same systems/bossBoat.js and
  // it fires the same three patterns, so its shells already arrived under this
  // cause through the prefix. Only a death against the HULL carried the bare
  // `bossYacht` key, which is the one that was landing nowhere.
  { id: 'boat', label: 'the trawler or the yacht', threat: 'Boats', prefix: 'boss:boat', sources: ['bossBoat', 'bossYacht'] },
  { id: 'barracuda', label: 'a barracuda', threat: 'Barracuda', sources: ['barracuda'] },
  // Its own cause rather than riding with the barracuda it shares a role with.
  // The two are interchangeable on the spawn table and not at all
  // interchangeable in the sentence afterwards: one is a pack of small fast
  // teeth, the other is a three-unit billfish that ran you through. A player
  // naming what killed them says "sailfish", so there is a cause for it to
  // land in — empty for now, and that is a supported state (see the "a cause
  // nobody wrote for falls back to the general lines" check in
  // tools/quip-test.mjs), not a gap that breaks anything.
  { id: 'sailfish', label: 'a sailfish', threat: 'Sailfish', sources: ['sailfish'] },
  { id: 'ray', label: 'a ray', threat: 'Rays', sources: ['stingray', 'lanternRay'] },
  // NOT filed under the small fry, even though it is a fish and a slow one.
  // That cause is specifically the joke about being nibbled to death by your
  // own food; the puffer is solitary mid-tier traffic in the ray's tier, and
  // the ray gets its own cause for exactly the same reason.
  { id: 'puffer', label: 'a pufferfish', threat: 'Pufferfish', sources: ['puffer'] },
  // Kept although the dolphin no longer spawns as wildlife (CONFIG.enemies
  // .dolphin is weight 0 — see the note there): the body is still in the game
  // as the companion stub, and a cause that exists costs nothing while a
  // missing one is a death with no name.
  { id: 'dolphin', label: 'a dolphin', threat: 'Dolphins', sources: ['dolphin'] },
  { id: 'turtle', label: 'the turtle', threat: 'The turtle', sources: ['seaTurtle'] },
  { id: 'oyster', label: 'an oyster', threat: 'Oysters', sources: ['oyster'] },
  // The small fry. Being nibbled to death by the things you were supposed to
  // be eating is one cause however many species are in the school.
  { id: 'fish', label: 'the small fry', threat: 'Small fry', sources: ['fish', 'trout', 'tang', 'reeffish', 'fishPackA', 'fishPackB', 'fishPackC', 'fishesA', 'fishesB', 'fishesC', 'brownfish', 'clownfish', 'surgeonfish', 'tuna', 'lanternfish', 'glowTang', 'glowDarter'] },
  // Cross-cutting on purpose: dying to the megalodon boss is a shark death AND
  // a boss death, and a line written for either one should be allowed to fire.
  // `boss:` covers the attacks that come off a boss rather than out of its
  // body — the trawler's salvo, every perk — which carry no creature key at
  // all and would otherwise land in no cause.
  { id: 'boss', label: 'a boss', threat: 'Boss attacks', prefix: 'boss:', sources: ['bossShark', 'bossOrca', 'bossSquid', 'bossCrab', 'bossMosasaur', 'bossHammerhead', 'bossBoat', 'bossYacht'] },
  { id: 'drowning', label: 'running out of air', threat: 'Drowning', sources: ['drowning'] },
  { id: 'lightning', label: 'a lightning strike', threat: 'Lightning', sources: ['lightning'] },
  { id: 'shot', label: 'something that shoots', threat: 'Enemy fire', sources: ['enemy shot'] },
];

export const DEATH_CAUSE_IDS = DEATH_CAUSES.map((c) => c.id);

const BY_SOURCE = new Map();
for (const c of DEATH_CAUSES) {
  for (const s of c.sources) {
    if (!BY_SOURCE.has(s)) BY_SOURCE.set(s, []);
    BY_SOURCE.get(s).push(c.id);
  }
}

/**
 * Every cause that describes this death, as a Set — usually one, two when a
 * boss killed you with its body.
 *
 * An unrecognised source returns an EMPTY set rather than a guess. A quip
 * tagged for a cause then cannot match it, which sends the pick to the general
 * pool: an unclassified creature costs you the joke, never the headline.
 */
export function causesOfDeath(source) {
  const s = String(source ?? '').trim();
  const out = new Set(BY_SOURCE.get(s) ?? []);
  if (!s) return out;
  for (const c of DEATH_CAUSES) {
    if (c.prefix && s.startsWith(c.prefix)) out.add(c.id);
  }
  return out;
}

/**
 * The ONE cause a source is filed under, for a table that must not count the
 * same damage twice. `causesOfDeath` deliberately returns several — a quip
 * written for either "shark" or "boss" should be allowed to fire on the
 * megalodon — and adding up a per-cause table built that way would total more
 * damage than the player ever took.
 *
 * FIRST MATCH IN TABLE ORDER WINS, which is not an arbitrary tie-break: the
 * table is ordered animals-first, biggest-threat-down, with the three
 * non-animal deaths last and the cross-cutting `boss` cause below every
 * creature it overlaps. So the megalodon boss files under sharks (specific)
 * rather than under bosses (cross-cutting), and only the attacks that come off
 * a boss rather than out of its body — the aura, the salvo — reach `boss`,
 * which is exactly what that row is for. Reordering the table therefore
 * changes this function's answers, and that is the intended way to change
 * them.
 *
 * Prefix matches are considered in the same pass rather than after it, so a
 * `boss:boat` shell lands on the boat row and not on the generic boss one.
 *
 * Returns null for a source no cause claims, which the caller shows under its
 * raw key rather than hiding — an unclassified creature should be visible.
 */
export function primaryCause(source) {
  const s = String(source ?? '').trim();
  if (!s) return null;
  for (const c of DEATH_CAUSES) {
    if (c.sources.includes(s)) return c;
    if (c.prefix && s.startsWith(c.prefix)) return c;
  }
  return null;
}

/**
 * What to call `source` on screen — the group's name, or the raw key when
 * nothing claims it. Never empty: a row with no heading is worse than a row
 * headed 'seaTurtle'.
 */
export function threatLabel(source) {
  return primaryCause(source)?.threat ?? String(source ?? '').trim() ?? '';
}

/**
 * Which of `ids` no cause claims. The drift check, exported rather than left
 * in the test so the same answer is available from a console at 2am.
 */
export function unclassifiedSources(ids) {
  return ids.filter((id) => !BY_SOURCE.has(id));
}
