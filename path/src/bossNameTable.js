// ============================================================================
// BOSS NAME TABLE — what the giant shark is called, kept in bossNames.csv.
//
// A boss with a health bar and no name is a big enemy. The name is most of
// what makes it an event, and it is also the cheapest thing in the game to
// author: this table is PARTS, not names, so eight prefixes, eight roots and
// ten epithets are 640 sharks rather than 26 rows.
//
// Like quips.csv, this table joins to nothing in code — the `id` is only a
// handle for diffs and warnings, so a part can be reworded without the row
// losing its identity in a pull request.
//
// Columns (order doesn't matter, unknown columns are ignored):
//   id       a short handle for the row. Must be unique; never shown.
//   slot     which PART of the name this is. One of:
//              prefix   the front half of the name  — "Gore"
//              root     the back half of it         — "maw"
//              epithet  what follows the name       — "the Devourer"
//              nickname a WHOLE name, written out   — "Ol' Chompy"
//              solo     a whole name, and the END of it — "The Rusty Maiden"
//            A row with any other slot is ignored, loudly: a typo'd slot is
//            a part that silently never appears.
//
//            NICKNAME IS THE WAY OUT OF THE MACHINE. Parts are wonderful for
//            volume and useless for a joke — "Ol' Chompy" cannot be assembled
//            from halves, and neither can anything else that depends on being
//            exactly the words somebody chose. A nickname replaces the prefix
//            and the root together, so an author can hand-write the names that
//            need to be hand-written and let the machine fill in around them.
//
//            SOLO IS A NICKNAME THAT TAKES NO EPITHET. Nothing is ever added
//            after it — the cell is the entire name, the way a ship's name is
//            complete on its own. The two share a pool and are rolled
//            together; the only difference is what happens at the end.
//
//            It is a POOL, not an override: hand-written names compete with the
//            constructed one at `nicknameChance`, so writing one does not mean
//            every boss is now called that. Everything else about a nickname
//            row behaves like any other part — `bosses` narrows it to an
//            archetype, `perk` ties it to a perk, `weight` sets how often it
//            wins against the other nicknames.
//   text     the part itself. Case is used EXACTLY as typed — prefixes are
//            capitalised, roots are not ("Gore" + "maw" = "Goremaw"), and an
//            epithet carries its own article ("the Devourer") because not
//            all of them want one ("Warden of the Deep").
//   enabled  FALSE takes the part out of rotation. Blank means enabled.
//   weight   how likely this part is RELATIVE TO THE OTHER ROWS IN ITS SLOT.
//            Blank means 1; 0 is never used. Weights do not cross slots —
//            a prefix competes only with other prefixes.
//   bosses   which BOSS ARCHETYPES this part fits, as a space- or
//            comma-separated list of ids from bosses.csv ("bossOrca", or
//            "bossShark bossOrca"). BLANK MEANS ALL, which is the answer that
//            makes an unedited table behave the way it always did: every part
//            was universal before this column existed, and a blank cell in a
//            fifty-row table is the normal state of it rather than an
//            omission. Fill it in to narrow a part — "Sharky" is not a name an
//            orca can carry, and "fluke" is not a word for a shark's tail.
//   perk     which BOSS PERK this part belongs to, an id from bossPerks.csv.
//            Blank is the GENERAL POOL — the parts any boss can be built from.
//            A row with a perk is vocabulary that only exists while that perk
//            is on the boss, and one of them is GUARANTEED to land: see
//            rollBossName. This is the whole reason perks drive names — the
//            electric boss is called something electric, every time, and that
//            is the only warning the player gets.
//
// Epithets are optional in a way the other two slots are not: with no epithet
// rows at all, a boss is simply "Goremaw", which is a name. With no prefixes
// or no roots there is nothing to build from, and the fallback below is used.
// ============================================================================

import { parseIdTable, parseBool, parseNumber } from './csvTable.js';

const LABEL = 'bossNames';
const FILE = 'bossNames.csv';

// The slots a name is BUILT from. Kept to the three composed parts on purpose:
// this is the list an `ownNames` archetype is checked for completeness against,
// and it does not want the hand-written slots in it — an archetype with no
// nickname of its own is the normal case, not a gap to warn about.
export const SLOTS = ['prefix', 'root', 'epithet'];

// ...and every slot a ROW may legally declare. The parser and the CSV editor's
// dropdown read this one; nothing else should. (The editor reads it by pulling
// the quoted strings out of this literal, so keep the extras spelled out here
// rather than spread in from another array.)
export const NAME_SLOTS = [...SLOTS, 'nickname', 'solo'];

// The hand-written half of that list. `solo` USED TO BE A COLUMN — a boolean
// that meant something on nickname rows and nothing on the other three — and
// it is a slot instead because that is the same fact in a form where the
// mistake cannot be written down: `slot` already answers "what part of a name
// is this", and "a whole name that stands alone" is an answer to that question.
// Six lines of parsing and a runtime warning policing a meaningless cell went
// away with it.
//
// Both slots are ONE POOL as far as rolling goes — see poolFor. They are two
// rows in the table and one kind of thing in the game.
const NICKNAME_SLOTS = NAME_SLOTS.filter((s) => !SLOTS.includes(s));

// The pools a name can be rolled FROM: the three composed parts, plus the
// hand-written names as a single pool. `solo` is deliberately not here — it is
// not a fifth thing a perk could speak through, it is nicknames that happen to
// end the name, and poolFor hands both slots back under 'nickname'.
const ROLL_SLOTS = [...SLOTS, 'nickname'];

// How often a boss with a nickname available wears it instead of a built name,
// when nothing else has already decided. The default rather than the rule —
// systems/boss.js passes CONFIG.boss.names.nicknameChance — and deliberately
// well under half: the hand-written names are the seasoning, and a table where
// they turned up most of the time would waste the vocabulary that makes every
// other boss feel different from the last one.
const DEFAULT_NICKNAME_CHANCE = 0.25;

// The one thing this module must never do is return nothing. A nameless boss
// is a visibly broken health bar, and it would be caused by a file the player
// can edit — so every failure path below ends at this name instead.
export const FALLBACK_BOSS_NAME = 'The Old Shadow';

// A `bosses` cell into a list of ids. Space OR comma, for the same reason
// `spawnGroup` accepts both: the value comes out of a spreadsheet cell, where
// a comma has to be quoted, and a hand-edit that forgets the quotes would
// otherwise silently produce one archetype id named "bossShark,bossOrca" that
// matches nothing at all.
function parseBossList(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null; // null, not [] — "any boss", which is not "no boss"
  const ids = s.split(/[\s,]+/).filter(Boolean);
  return ids.length ? ids : null;
}

/**
 * Parse the table into { prefix: [...], root: [...], epithet: [...] }.
 * Every slot is always present, possibly empty.
 *
 * `known` is optional: pass { bosses, perks } (arrays of legal ids) and every
 * `bosses`/`perk` cell is checked against them. `known.exclusive` (ids whose
 * `ownNames` is set) additionally checks that each of those archetypes has
 * written vocabulary in every slot — an exclusive archetype missing a slot
 * silently borrows the shared pool for it, which is precisely the thing it was
 * marked exclusive to avoid. Worth doing, because both
 * columns fail SILENTLY when wrong — a part tagged for a boss archetype that
 * no longer exists is simply a part that never appears again, and nothing
 * about the game looks broken while it happens.
 */
export function parseBossNameCsv(text, warn = console.warn, known = null) {
  const rows = parseIdTable(text, LABEL, FILE, warn);
  const out = {};
  for (const slot of NAME_SLOTS) out[slot] = [];

  for (const [id, row] of rows) {
    const slot = String(row.slot ?? '').trim().toLowerCase();
    if (!NAME_SLOTS.includes(slot)) {
      warn(`[${LABEL}] "${id}" has slot "${row.slot ?? ''}", which is not one of ${NAME_SLOTS.join(', ')} — the row is being ignored.`);
      continue;
    }
    // Not trimmed to nothing and not trimmed at the edges either: the space
    // between the name and its epithet is added when the name is assembled,
    // so a row with a trailing space would double it.
    const partText = String(row.text ?? '').trim();
    if (!partText) {
      warn(`[${LABEL}] "${id}" has no text — the row is being ignored.`);
      continue;
    }
    if (!parseBool(row.enabled, LABEL, id, 'enabled', warn)) continue;

    const w = parseNumber(row.weight, LABEL, id, 'weight', warn, { min: 0 });

    const bosses = parseBossList(row.bosses);
    if (bosses && known?.bosses) {
      for (const b of bosses) {
        if (!known.bosses.includes(b)) {
          warn(`[${LABEL}] "${id}" is tagged for boss "${b}", which is not in bosses.csv — `
            + `the part will never appear. Known: ${known.bosses.join(', ')}.`);
        }
      }
    }

    const perk = String(row.perk ?? '').trim() || null;
    if (perk && known?.perks && !known.perks.includes(perk)) {
      warn(`[${LABEL}] "${id}" is tagged for perk "${perk}", which is not in bossPerks.csv — `
        + `the part will never appear. Known: ${known.perks.join(', ')}.`);
    }

    // Carried on the row as well as in the slot, because the roll asks the
    // question of a part it has already drawn ("does anything follow this
    // name?") rather than of the pool it came from.
    const solo = slot === 'solo';

    out[slot].push({ id, text: partText, weight: w == null ? 1 : w, bosses, perk, solo });
  }

  // The GENERAL pool is what a boss is built from — perk vocabulary is extra,
  // and a table that was all perk rows would have nothing to hang them on. So
  // the check below counts only parts with no perk, which is what makes the
  // warning fire on the file that is actually broken.
  const general = (slot) => out[slot].filter((p) => !p.perk).length;
  // ...and nicknames are a complete answer on their own. A table of nothing but
  // hand-written names is a legitimate way to run this feature — every boss is
  // called something somebody chose — so it must not be reported as the file
  // being broken. Counted across BOTH hand-written slots: a file of nothing but
  // solo names is exactly as complete as a file of nothing but nicknames.
  // The warning is for the case that really does end at the fallback: nothing
  // to build from AND nothing written out.
  const written = NICKNAME_SLOTS.reduce((n, slot) => n + general(slot), 0);
  if ((!general('prefix') || !general('root')) && !written) {
    warn(`[${LABEL}] ${FILE} has no usable general (perk-less) ${!general('prefix') ? 'prefix' : 'root'} rows `
      + `and no nicknames to fall back on — every boss will be called "${FALLBACK_BOSS_NAME}".`);
  }

  // Every archetype that asked for its own vocabulary, checked slot by slot.
  // Reported per missing slot rather than per archetype: "the boat has no
  // roots" is a thing to go and write, while "the boat is misconfigured" is a
  // thing to go and investigate.
  for (const id of known?.exclusive ?? []) {
    for (const slot of SLOTS) {
      const mine = out[slot].filter((p) => !p.perk && p.bosses?.includes(id));
      if (mine.length) continue;
      warn(`[${LABEL}] "${id}" is marked ownNames in bosses.csv but has no ${slot} rows of its own — `
        + `it will borrow the shared pool for that slot, which is what ownNames exists to prevent.`);
    }
  }
  return out;
}

// One part from one slot, weighted. Same contract as pickQuip: a slot whose
// every weight is 0 picks uniformly rather than returning nothing, because
// the file is misconfigured and no name is worse than an unwanted one.
function pickPart(parts, random) {
  if (!parts?.length) return null;

  let total = 0;
  for (const p of parts) total += p.weight > 0 ? p.weight : 0;
  if (total <= 0) return parts[Math.floor(random() * parts.length)];

  let roll = random() * total;
  let last = parts[0];
  for (const p of parts) {
    if (p.weight <= 0) continue; // skipped, not merely worth nothing
    last = p;
    roll -= p.weight;
    if (roll <= 0) return p;
  }
  return last; // float drift ate the total
}

// "Grimtide the Tidebreaker" reads as a bug rather than as a name, and with
// parts drawn independently it comes up about as often as any other pairing.
// One reroll, not a loop: this is a nudge away from the obvious echo, not a
// guarantee, and a table where every epithet echoes every root must still
// terminate.
function echoes(root, epithet) {
  return epithet.toLowerCase().includes(root.toLowerCase());
}

// Everything in a slot this boss is allowed to wear. `perk` null asks for the
// general pool; a perk id asks for that perk's vocabulary and nothing else.
//
// `exclusive` is the archetype's `ownNames` column (see bosses.csv). Off, the
// boss wears its own tagged parts PLUS everything untagged, which is what makes
// the shark and the orca share most of a vocabulary and read as the same kind
// of thing. On, it wears only what names it.
//
// THE FLAG IS ON THE ARCHETYPE AND NOT ON THE ROWS, and that is the whole
// design. The alternative — tagging all seventy shared parts with "not the
// boat" — is the same fact written seventy times, and it fails open: the next
// generic prefix somebody adds is one nobody remembered to exclude, so the boat
// quietly starts rolling "Chompy" again months later. This way exclusivity is
// one cell, and a new shared part can never leak into an exclusive archetype.
function poolFor(parts, slot, boss, perk, exclusive = false) {
  // ASKING FOR 'nickname' ASKS FOR BOTH HAND-WRITTEN SLOTS. They are one pool
  // and they must be filtered as one: an exclusive archetype whose only
  // hand-written name is a solo one should wear it, and it would not if the two
  // slots were narrowed separately and the solo pool came back empty.
  const rows = slot === 'nickname'
    ? NICKNAME_SLOTS.flatMap((s) => parts?.[s] ?? [])
    : parts?.[slot];
  if (!rows?.length) return [];
  const mine = rows.filter((p) => {
    if ((p.perk ?? null) !== perk) return false;
    if (!p.bosses) return false;
    return boss != null && p.bosses.includes(boss);
  });
  if (exclusive && mine.length) return mine;
  // FALLING BACK RATHER THAN RETURNING NOTHING. An exclusive archetype with no
  // rows in a slot would otherwise roll an empty pool, and an empty prefix or
  // root is the fallback name — every boat in the game called "The Old Shadow".
  // A boat wearing one shared root is a wobble; a boat with no name at all is
  // the feature visibly broken, so the shared pool is what an unwritten slot
  // gets. parseBossNameCsv warns at boot when this is the case, naming the
  // archetype and the slot, so it is loud without being fatal.
  return rows.filter((p) => {
    if ((p.perk ?? null) !== perk) return false;
    // Blank `bosses` is every boss. A row that names archetypes only fits the
    // ones it names — and with no boss id supplied at all (the harness, or a
    // caller that predates the roster) a narrowed row is skipped rather than
    // matched, so a shark-only name can't turn up on something that isn't one.
    if (!p.bosses) return true;
    return boss != null && p.bosses.includes(boss);
  });
}

/**
 * Roll a boss name.
 *
 * `opts.boss` is the archetype id from bosses.csv and `opts.perk` the perk id
 * from bossPerks.csv, either of which may be null. `opts.nicknameChance` is how
 * often a hand-written whole name is preferred to a built one when nothing else
 * has already decided (see the nickname block below). `random` is injectable so
 * the distribution can be checked without running the game.
 *
 * THE PERK ALWAYS SHOWS. If the perk has vocabulary, exactly one slot is
 * handed over to it and the others roll normally — so an electric boss is
 * "Stormmaw the Everhungry" or "Goremaw the Live Wire", never "Goremaw". That
 * guarantee is the feature: the name is the telegraph, and a name that only
 * SOMETIMES carried the perk would be a telegraph the player learns not to
 * trust, which is worse than none.
 *
 * WHICH slot it takes is rolled, weighted by how much vocabulary the perk has
 * in each — a perk with four prefixes and two epithets front-loads more often,
 * which is what an author writing four prefixes was asking for.
 */
export function rollBossName(parts, opts = {}, random = Math.random) {
  // Called as rollBossName(parts, random) before the roster existed, and the
  // shape of the second argument is what tells the two apart. Not a nicety: a
  // function passed where an options object is expected would silently name
  // every boss with no perk and no archetype, which is exactly the bug this
  // whole file is trying not to have.
  if (typeof opts === 'function') { random = opts; opts = {}; }

  const boss = opts.boss ?? null;
  const perk = opts.perk ?? null;
  // The archetype's `ownNames`. Resolved by the caller, which is the only place
  // that has the roster row — see systems/boss.js.
  const exclusive = !!opts.exclusive;

  // Which slot, if any, the perk speaks for this time.
  //
  // NICKNAME IS IN THIS ROLL, which is what keeps the perk guarantee intact
  // once hand-written names exist. A perk-tagged nickname ("Sparky") is a
  // complete name that already says what the fight does, so it is allowed to
  // be the slot the perk speaks through — and because the choice is made HERE,
  // before anything else, the decision below about whether to wear a nickname
  // at all can simply obey it.
  //
  // Rolled across ROLL_SLOTS and not NAME_SLOTS, which is the difference
  // between four pools and five: the nickname pool already contains the solo
  // rows, so weighting `solo` as a slot of its own would count every one of
  // them twice and hand the perk to hand-written names more often than the
  // vocabulary asked for.
  let perkSlot = null;
  if (perk) {
    const weights = ROLL_SLOTS.map((slot) => {
      let total = 0;
      for (const p of poolFor(parts, slot, boss, perk, exclusive)) total += p.weight > 0 ? p.weight : 1;
      return total;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    if (total > 0) {
      let roll = random() * total;
      for (let i = 0; i < ROLL_SLOTS.length; i++) {
        if (weights[i] <= 0) continue;
        perkSlot = ROLL_SLOTS[i];
        roll -= weights[i];
        if (roll <= 0) break;
      }
    }
  }

  const draw = (slot, filter = null) => {
    let pool = poolFor(parts, slot, boss, slot === perkSlot ? perk : null, exclusive);
    if (filter) pool = pool.filter(filter);
    return pickPart(pool, random);
  };

  // --- the nickname decision ------------------------------------------------
  //
  // Three cases, and only the last one is a dice roll:
  //
  //   the perk speaks through the nickname   -> a nickname, necessarily
  //   the perk speaks through prefix or root -> no nickname, necessarily,
  //       because a nickname REPLACES both of those and would take the
  //       telegraph with it
  //   anything else (no perk, or the perk is in the epithet) -> the roll
  //
  // A solo name is refused when the epithet is carrying the perk, for the same
  // reason: solo means nothing is appended, and what would be dropped is the
  // one word the player needed. Filtered out of the drawn pool rather than
  // asked for by slot, because `nickname` and `solo` are drawn together and the
  // question here is about the part, not about where it came from.
  const soloAllowed = perkSlot !== 'epithet';
  const nickFilter = soloAllowed ? null : (p) => !p.solo;

  let nickname = null;
  if (perkSlot === 'nickname') {
    nickname = draw('nickname');
  } else if (perkSlot !== 'prefix' && perkSlot !== 'root') {
    const chance = opts.nicknameChance ?? DEFAULT_NICKNAME_CHANCE;
    if (chance > 0 && random() < chance) nickname = draw('nickname', nickFilter);
  }

  // The built name, needed either as the answer or as the fallback for a
  // nickname pool that turned out to be empty for this boss.
  let name = null;
  // What the echo check below measures against, which is NOT the finished
  // name. For a built name it is the ROOT alone — "the Tidebreaker" echoes
  // "tide", and comparing it against the whole of "Grimtide" finds nothing.
  let echoAgainst = '';
  if (!nickname) {
    const prefix = draw('prefix');
    const root = draw('root');
    // A LAST LOOK AT THE NICKNAMES before giving up. A table that is all
    // hand-written names has no prefixes to build from, and answering that
    // with the fallback would mean the feature working perfectly and every
    // boss still called "The Old Shadow".
    if (!prefix || !root) nickname = draw('nickname', nickFilter);
    else { name = `${prefix.text}${root.text}`; echoAgainst = root.text; }
  }
  if (!name && !nickname) return FALLBACK_BOSS_NAME;

  // A nickname has no halves to pick from, so the whole of it is what an
  // epithet must not echo.
  if (nickname) { name = nickname.text; echoAgainst = nickname.text; }

  // SOLO IS THE END OF THE NAME. Checked before the epithet is drawn rather
  // than after, so a solo nickname cannot be knocked back into a reroll by the
  // echo logic below.
  if (nickname?.solo) return name;

  let epithet = draw('epithet');
  if (epithet && echoes(echoAgainst, epithet.text)) {
    epithet = draw('epithet');
    // Dropped only when it is a GENERAL epithet. Dropping a perk's would trade
    // the echo for a boss whose name no longer says what it does, and the echo
    // is a cosmetic wobble while the missing telegraph is the feature failing.
    if (epithet && echoes(echoAgainst, epithet.text) && perkSlot !== 'epithet') return name;
  }

  return epithet ? `${name} ${epithet.text}` : name;
}
