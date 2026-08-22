// ============================================================================
// THE NAME KIT — the game's own name machinery, bundled for a page that has no
// build step.
//
// The Spline scene's HTML content is one sandboxed document: no modules, no
// imports, no CSV loader. So the only way for it to show the REAL names is for
// the real modules to be bundled into it — which is what tools/spline-name-
// kit.mjs does with this file as its entry.
//
// THE POINT IS THAT THERE IS NO SECOND COPY. The scene shipped for a while with
// a hand-typed 30x30 list of adjectives and nouns, none of them from
// sealNames.csv — a fork that looked right and named seals the game has never
// heard of. Everything below is IMPORTED. If a row is added to the table, the
// scene gets it on the next build and not before, and there is nowhere for the
// two to disagree quietly.
//
// WHAT IS NEW HERE, and why it is here rather than in path/src:
//
//   makeSyntheticRecords  invents a plausible graveyard. That is a DESIGN tool
//                         — the game has no use for a fake graveyard and would
//                         be worse for carrying the ability to make one. It is
//                         built entirely out of real parts (the real table, the
//                         real causes, the real epitaph leads) and a seeded
//                         RNG, so what it shows is what the game would show.
//
//   loadRecords           replaces the kit's ledger with a set of names. It
//                         writes to THIS page's storage, which is Spline's
//                         origin and not the game's — the game's ledger is
//                         reachable from here by no means at all, which is
//                         exactly why the export file exists.
// ============================================================================

import { randomPlayerName, sealNameParts } from '../../path/src/systems/randomName.js';
import {
  rollSealName, SEAL_SLOTS, DEFAULT_FULL_CHANCE, FALLBACK_SEAL_NAME,
} from '../../path/src/sealNameTable.js';
import {
  stripName, sanitizeName, MAX_NAME_LEN, DEFAULT_PLAYER_NAME,
} from '../../path/src/systems/playerName.js';
import {
  isNameBuried, buryName, buryMany, buriedNames, buriedCount,
  clearNameLedger, nameKey,
} from '../../path/src/systems/nameLedger.js';
import { DEATH_CAUSES } from '../../path/src/deathCauses.js';
import { epitaphLead } from '../../path/src/systems/epitaphLead.js';
import {
  parseRecords, packRecords, packRecordsJson, RECORDS_VERSION, RECORDS_KIND,
} from '../../path/src/systems/recordsFile.js';

// The same xorshift every seeded harness in tools/ uses. A seed here has to
// mean the same graveyard every time or the panel's seed slider is a reroll
// button with extra steps.
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// Only the causes a seal can actually die OF. `boss` is a catch-all bucket that
// exists so an unclassified boss shell still lands somewhere (see
// deathCauses.js), and rolling it would put "lost to / a boss" on a stone when
// every real death names the animal.
const ROLLABLE = DEATH_CAUSES.filter((c) => c.id !== 'boss');

/**
 * A graveyard that could have happened.
 *
 * `buried` is the permadeath record — every name, oldest first. `graves` is the
 * last `stones` of them with an inscription each, because that is the shape the
 * game stores: the yard is a dozen stones and the ledger is thousands of names,
 * and a tool that draws one stone per buried name is drawing a feature that
 * does not exist.
 *
 * Deterministic in `seed`. Names are drawn from the real table and deduplicated
 * the way the ledger deduplicates — by flattened key — so the count asked for
 * is the count of DISTINCT seals, not of draws.
 */
export function makeSyntheticRecords({ seed = 7, count = 40, stones = 12 } = {}) {
  const r = rng(seed);
  const parts = sealNameParts();
  const buried = [];
  const seen = new Set();
  // Bounded: at a few hundred names the table still finds new ones easily, and
  // a caller asking for more seals than the file can build must terminate
  // rather than spin. 20x is generous past the point of diminishing returns.
  for (let i = 0; i < count * 20 && buried.length < count; i += 1) {
    const name = rollSealName(parts, {}, r);
    const key = nameKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    buried.push(name);
  }
  const graves = buried.slice(-Math.max(0, stones)).map((name) => {
    const cause = ROLLABLE[Math.floor(r() * ROLLABLE.length)];
    return {
      name,
      cause: cause.label,
      lead: epitaphLead(cause.id, r),
      stone: null,
    };
  });
  return { buried, graves, warnings: [] };
}

/**
 * Make `names` the kit's buried list, replacing whatever was there.
 *
 * CLEARS FIRST, deliberately. Loading a file on top of a synthetic yard would
 * give a graveyard that is part invention and part record with no way to tell
 * which stone is which — and the reroll button would then refuse names that
 * were never actually spent. Returns how many are buried afterwards.
 */
export function loadRecords(names) {
  clearNameLedger();
  return buryMany(names ?? []);
}

/** What the table can build, for the panel's readout. Counted rather than
 *  asserted, because the answer changes every time a row is added. */
export function tableStats() {
  const p = sealNameParts();
  const built = (p.adjective?.length ?? 0) * (p.nickname?.length ?? 0);
  return {
    adjectives: p.adjective?.length ?? 0,
    nicknames: p.nickname?.length ?? 0,
    full: p.full?.length ?? 0,
    // The nicknames count twice over: each is a name on its own whenever no
    // adjective fits beside it (the length rule), and every one of them is
    // reachable that way.
    total: built + (p.nickname?.length ?? 0) + (p.full?.length ?? 0),
  };
}

export {
  randomPlayerName, sealNameParts, rollSealName, SEAL_SLOTS, DEFAULT_FULL_CHANCE,
  FALLBACK_SEAL_NAME, stripName, sanitizeName, MAX_NAME_LEN, DEFAULT_PLAYER_NAME,
  isNameBuried, buryName, buryMany, buriedNames, buriedCount, clearNameLedger,
  nameKey, DEATH_CAUSES, epitaphLead,
  parseRecords, packRecords, packRecordsJson, RECORDS_VERSION, RECORDS_KIND,
};
