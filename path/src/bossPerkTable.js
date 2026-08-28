// ============================================================================
// BOSS PERKS — the one special thing a boss can do, kept in bossPerks.csv.
//
// A boss with more health than a megalodon is a longer megalodon. The perk is
// what makes each arrival a different FIGHT rather than a different number:
// one boss closes distance in a way you have to read, one punishes standing
// next to it, one refuses to be kited, one refuses to be tracked.
//
// EXACTLY ONE PER BOSS, and the first boss of a run has none. The first one is
// the game teaching you what a boss is — a wall with a health bar and nothing
// else to parse — and every one after it carries a perk. See rollBossPerk.
//
// THE PERK IS IN THE NAME. This table joins to bossNames.csv through its `id`:
// a name row whose `perk` column says `electric` only ever appears on a boss
// that has the electric perk, and the naming rule (see bossNameTable.js) makes
// sure one of them lands. "Stormmaw the Everhungry" is the fight telling you
// what it is before it reaches you, which is the only warning the player gets
// and the reason the perk had to drive the name rather than sit next to it.
//
// Columns (order doesn't matter, unknown columns are ignored):
//   id        which perk. Code joins to this — see PERK_IDS below — so a typo
//             is a row the game has no behaviour for, and it is warned about.
//   enabled   FALSE takes the perk out of rotation.
//   weight    how likely RELATIVE TO THE OTHER PERKS. Blank means 1.
//
// The rest are that perk's numbers. Every perk uses some of them and leaves
// the others blank; what each one MEANS is per perk, and is spelled out in the
// row's own `notes` as well as here:
//   cooldown  seconds between activations              (every perk that fires)
//   windup    seconds of telegraph before it fires     (lunge, teleport, phase,
//             and every shooter — the tell before a volley)
//   duration  seconds the effect itself lasts          (lunge, teleport, phase;
//             barrels — the fuse; turtles — how long an escort stays)
//   speed     world units per second                   (lunge — the dash;
//             the shooters — how fast the thing they fire travels)
//   radius    world units                              (electric — the aura's
//             reach; teleport — how far from the player it reappears;
//             barrels — the blast; turtles — how far off the boss they hold)
//   range     world units. How close the player has to be for a shooter to
//             open fire at all. A boss that shoots across the whole arena is
//             not a fight with a distance in it.
//   count     how many of them per activation          (the shooters — shots
//             per volley; turtles — how many escorts it keeps up)
//   mul       a plain multiplier, and what it multiplies is the perk's own
//             business: giant scales SIZE, swift scales SPEED. Kept apart from
//             `speed` deliberately — that column is an absolute rate in world
//             units, and a cell that meant "34 units a second" on one row and
//             "1.4 times faster" on the next is the kind of column that gets
//             mis-set once and is never noticed.
//   damage    lunge: a multiplier on contact damage while dashing.
//             electric: damage per second inside the aura.
//             the shooters: damage per projectile.
//   damagePerDifficulty
//             linear growth on `damage` per difficulty point, resolved ONCE
//             when the perk is attached — the same shape enemies.csv's
//             `hpPerDifficulty` and `contactDamagePerDifficulty` have, and for
//             the same reason. Blank is the default and means a flat perk,
//             which is what all of these were.
//
//             A flat number is not neutral here, it is a curve of its own:
//             everything else the boss does — its contact, its bite, its
//             health — rides CONFIG.spawn.ramp, so a perk whose damage never
//             moves is at its most punishing on the EARLIEST boss that can
//             roll it and its least on the last. That is backwards, and it is
//             what this column exists to fix. It does nothing to `lunge`,
//             whose `damage` is a multiplier on a contact number that already
//             rides the ramp — doubling the ramp is not the same statement.
//
// And one column that is not a number:
//   attack    WHAT KIND OF HARM this is — see ATTACK_IDS below. It decides what
//             the perk's telegraph ring LOOKS like: its colour and its edge
//             dialect both come from the shared threat palette
//             (CONFIG.fx.attackTypes), so an `electric` row gets a ring the
//             exact cyan of the player's Voltaic element with jagged spline
//             displacement crackling round it, and a `blast` row gets a hot
//             roiling one.
//
//             It is a LOOK column in a gameplay table, and that is deliberate.
//             The alternative — deriving the type from the perk id in code —
//             was what the game did before, and it meant a boss's colour was
//             not a thing anyone could see or change without reading
//             systems/bossPerks.js. What it must never do is affect damage:
//             nothing downstream reads `attack` except the ring.
//
//             A BLANK CELL is legal and means "keep the colour this perk has
//             always had in CONFIG.boss.perkFx, with the plain edge". That is
//             the escape hatch for a tell whose colour was tuned away from its
//             type on purpose.
//
// These are GAMEPLAY numbers, so they live here and not on a slider. Nothing
// about a boss's threat should be adjustable from a panel that ships with the
// game — the same rule weapons.csv follows.
// ============================================================================

import { parseIdTable, parseBool, parseNumber } from './csvTable.js';

// The threat types the palette knows. DUPLICATED from CONFIG.fx.attackTypes on
// purpose: this module is imported by Node harnesses that parse the table
// without a config, and pulling CONFIG in here would drag three.js and the
// tuning JSON behind it. tools/boss-perk-test.mjs asserts the two lists agree,
// so the duplication cannot rot silently.
export const ATTACK_IDS = [
  'kinetic', 'electric', 'blast', 'beam', 'void', 'venom', 'chill', 'infection',
];

const LABEL = 'bossPerks';
const FILE = 'bossPerks.csv';

// The perks systems/bossPerks.js actually implements. A row naming anything
// else parses fine and would roll onto a boss that then does nothing special
// while wearing a name that promises it does — so it is refused here, loudly.
// Grouped by what they take away from the player, which is also the order they
// were designed in — see the header of systems/bossPerks.js.
export const PERK_IDS = [
  // Distance
  'lunge', 'electric', 'teleport', 'phase',
  // The body itself
  'giant', 'swift',
  // Reach — the boss answering back across the gap the player is keeping
  'eyebeam', 'barrels', 'spitfish', 'finfish',
  // Company
  'turtles',
  // THE FIELD — the boss opens a chaotic flow around itself and the water
  // between you fills with something you have to read rather than dodge.
  //
  // These four ARE attractorStorms.csv rows, sharing their ids on purpose: one
  // name for one thing, so the join cannot be got wrong and the study's own
  // `notes` cell is the perk's documentation. What the row here adds is
  // everything that makes it a fight rather than a demonstration — the
  // cooldown, the tell, how long it stays open, how close you have to be, and
  // damage that rides the difficulty ramp like every other perk's.
  //
  // The other two studies are Thomas and are deliberately NOT here: one is a
  // whole arena and one is a body, and both are a boss rather than a thing a
  // boss does.
  'saddle', 'ring', 'echo', 'release',
];

// Every numeric column, and the floor each one is allowed to reach. Kept as
// data so the parser can't drift from the doc comment above.
const NUMBERS = {
  cooldown: { min: 0 },
  windup: { min: 0 },
  duration: { min: 0 },
  speed: { min: 0 },
  radius: { min: 0 },
  range: { min: 0 },
  // Integer: half a projectile is not a thing a volley can contain, and a
  // fractional count would silently floor somewhere downstream instead of
  // being reported here where the row can be fixed.
  count: { min: 0, integer: true },
  // Floored at 0 rather than 1: a `mul` under 1 is legal and useful (a boss
  // perk that makes it SMALLER and harder to hit is a fair design), and this
  // table's job is to refuse nonsense, not to have opinions.
  mul: { min: 0 },
  damage: { min: 0 },
  damagePerDifficulty: { min: 0 },
};

/** Parse the table into an array of perks, in file order. */
export function parseBossPerkCsv(text, warn = console.warn) {
  const rows = parseIdTable(text, LABEL, FILE, warn);
  const out = [];

  for (const [id, row] of rows) {
    if (!PERK_IDS.includes(id)) {
      warn(`[${LABEL}] "${id}" is not a perk the game implements (${PERK_IDS.join(', ')}) — `
        + `the row is being ignored, because a boss cannot be given a power that has no code behind it.`);
      continue;
    }
    if (!parseBool(row.enabled, LABEL, id, 'enabled', warn)) continue;

    const w = parseNumber(row.weight, LABEL, id, 'weight', warn, { min: 0 });
    const perk = { id, weight: w == null ? 1 : w };

    // A typo here is a boss whose tell is quietly the wrong colour — the ring
    // still draws, it just lies about what is coming — so it is warned about
    // and dropped rather than passed through to be silently unmatched by the
    // palette lookup.
    const attack = (row.attack ?? '').trim().toLowerCase();
    if (attack) {
      if (ATTACK_IDS.includes(attack)) perk.attack = attack;
      else {
        warn(`[${LABEL}] "${id}" names attack type "${attack}", which is not one of `
          + `${ATTACK_IDS.join(', ')} — the tell will keep its old colour instead.`);
      }
    }
    for (const [field, opts] of Object.entries(NUMBERS)) {
      const v = parseNumber(row[field], LABEL, id, field, warn, opts);
      // Left as undefined rather than defaulted to 0 — a blank cell means
      // "this perk doesn't use this number", and 0 is a real value for some of
      // them (a cooldown of 0 is a perk that never stops firing). Each perk's
      // implementation supplies its own fallback for what it actually reads.
      if (v != null) perk[field] = v;
    }
    out.push(perk);
  }

  if (!out.length) {
    warn(`[${LABEL}] ${FILE} has no usable rows — bosses will arrive with no perk at all.`);
  }
  return out;
}

/**
 * Which perk this boss gets, or null for none.
 *
 * `defeatedPlusAlive` is how many bosses this run has already accounted for —
 * so it is 0 for the first one. The first boss of a run is deliberately plain:
 * a health bar, a name and a body the size of a bus is already a lot to read
 * the first time, and a perk on top of it is the difference between a fight
 * you learn and one you lose without knowing why. Every boss after it has one.
 */
export function rollBossPerk(perks, bossNumber, random = Math.random) {
  if (!perks?.length) return null;
  if ((bossNumber ?? 0) < 1) return null; // the first boss of the run

  let total = 0;
  for (const p of perks) total += p.weight > 0 ? p.weight : 0;
  // Same contract as every other weighted pick in the project: a table whose
  // weights are all 0 picks uniformly rather than returning nothing.
  if (total <= 0) return perks[Math.floor(random() * perks.length)];

  let roll = random() * total;
  let last = perks[0];
  for (const p of perks) {
    if (p.weight <= 0) continue;
    last = p;
    roll -= p.weight;
    if (roll <= 0) return p;
  }
  return last; // float drift ate the total
}
