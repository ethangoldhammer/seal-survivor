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
 * `sources` are the exact strings that reach recordPlayerDamage. `label` is
 * for the picker and for warnings — never shown to a player, who reads the
 * quip itself.
 */
export const DEATH_CAUSES = [
  { id: 'shark', label: 'a shark', sources: ['shark', 'greatWhite', 'hammerhead', 'abyssShark', 'megalodon', 'mightyMeg', 'bossShark', 'bossHammerhead'] },
  { id: 'orca', label: 'the orca', sources: ['bossOrca'] },
  { id: 'mosasaur', label: 'the mosasaur', sources: ['bossMosasaur'] },
  { id: 'squid', label: 'a squid or the kraken', sources: ['squid', 'bossSquid'] },
  { id: 'crab', label: 'a crab', sources: ['walkingCrab', 'emberCrab', 'bossCrab'] },
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
  { id: 'boat', label: 'the trawler or the yacht', prefix: 'boss:boat', sources: ['bossBoat', 'bossYacht'] },
  { id: 'barracuda', label: 'a barracuda', sources: ['barracuda'] },
  // Its own cause rather than riding with the barracuda it shares a role with.
  // The two are interchangeable on the spawn table and not at all
  // interchangeable in the sentence afterwards: one is a pack of small fast
  // teeth, the other is a three-unit billfish that ran you through. A player
  // naming what killed them says "sailfish", so there is a cause for it to
  // land in — empty for now, and that is a supported state (see the "a cause
  // nobody wrote for falls back to the general lines" check in
  // tools/quip-test.mjs), not a gap that breaks anything.
  { id: 'sailfish', label: 'a sailfish', sources: ['sailfish'] },
  { id: 'ray', label: 'a ray', sources: ['stingray', 'lanternRay'] },
  // NOT filed under the small fry, even though it is a fish and a slow one.
  // That cause is specifically the joke about being nibbled to death by your
  // own food; the puffer is solitary mid-tier traffic in the ray's tier, and
  // the ray gets its own cause for exactly the same reason.
  { id: 'puffer', label: 'a pufferfish', sources: ['puffer'] },
  { id: 'dolphin', label: 'a dolphin', sources: ['dolphin'] },
  { id: 'otter', label: 'an otter', sources: ['otter'] },
  { id: 'turtle', label: 'the turtle', sources: ['seaTurtle'] },
  { id: 'oyster', label: 'an oyster', sources: ['oyster'] },
  // The small fry. Being nibbled to death by the things you were supposed to
  // be eating is one cause however many species are in the school.
  { id: 'fish', label: 'the small fry', sources: ['fish', 'trout', 'tang', 'reeffish', 'fishPackA', 'fishPackB', 'fishPackC', 'fishesA', 'fishesB', 'fishesC', 'brownfish', 'clownfish', 'surgeonfish', 'tuna', 'lanternfish', 'glowTang', 'glowDarter'] },
  // Cross-cutting on purpose: dying to the megalodon boss is a shark death AND
  // a boss death, and a line written for either one should be allowed to fire.
  // `boss:` covers the attacks that come off a boss rather than out of its
  // body — the trawler's salvo, every perk — which carry no creature key at
  // all and would otherwise land in no cause.
  { id: 'boss', label: 'a boss', prefix: 'boss:', sources: ['bossShark', 'bossOrca', 'bossSquid', 'bossCrab', 'bossMosasaur', 'bossHammerhead', 'bossBoat', 'bossYacht'] },
  { id: 'drowning', label: 'running out of air', sources: ['drowning'] },
  { id: 'lightning', label: 'a lightning strike', sources: ['lightning'] },
  { id: 'shot', label: 'something that shoots', sources: ['enemy shot'] },
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
 * Which of `ids` no cause claims. The drift check, exported rather than left
 * in the test so the same answer is available from a console at 2am.
 */
export function unclassifiedSources(ids) {
  return ids.filter((id) => !BY_SOURCE.has(id));
}
