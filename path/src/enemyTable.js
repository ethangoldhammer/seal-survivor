// ============================================================================
// ENEMY TABLE — the balance half of every creature, kept in enemies.csv.
//
// The roster was already a table; it was just stored as twenty object
// literals, so you could not see whether the megalodon's xp 40 was fair
// against the orca's 45 without scrolling between them. Every number below is
// one you set by COMPARING ROWS, which is what a spreadsheet is for and what
// a slider — one number, alone, with nothing beside it — is not.
//
// What stays in config.js, and why:
//
//   the nested blocks   `swarm`, `hunt`, `crawl`, `porpoise`, `glide`,
//                       `drift`, `trap`, `group`, `beatSync`, `deathBlast`.
//                       They don't flatten into a row, and they're the
//                       flocking/pursuit FEEL you want on a live slider while
//                       the game moves. The tuner still owns those.
//   `asset`,`behavior`  each one selects a thing that lives next to it — a
//                       model, and the nested block above. Splitting a
//                       creature's `behavior: 'hunt'` from its `hunt: {}`
//                       across two files is how you end up with a creature
//                       whose behaviour has no block to read. `behavior` also
//                       falls back to `chase` silently on an unknown value
//                       (see BEHAVIORS in entities/enemies.js) and `asset`
//                       falls back to an EMPTY Object3D — an invisible
//                       creature still dealing contact damage. Neither is a
//                       typo you want a spreadsheet to be able to make.
//   the flags           `prey`, `separates`, `collides`, `faceMotion`,
//                       `faceCamera`, `canBreach`, `floorSpawn`, `gaitTravel`.
//                       These pair a creature with its model and its code
//                       path — facts about the asset, not balance.
//
// Columns (order doesn't matter, unknown columns are ignored):
//   id            must match a key in CONFIG.enemies. The join key.
//
//   REQUIRED — the game reads these with no fallback of its own, so a blank
//   cell would spawn a creature with NaN hp or an undefined radius. Blank or
//   unreadable keeps the config.js built-in and warns:
//     radius, hp, hpPerDifficulty, speed, contactDamage, xp, weight
//
//   OPTIONAL — the game already has a default for each (shown), so a blank
//   cell REMOVES the field and that default applies. This is how you turn a
//   per-creature ramp off: clear the cell.
//     speedVariance              0     per-individual speed jitter
//     speedPerDifficulty         0     linear speed gain per difficulty point
//     turnRate                   none  rad/s; blank = pivots on the spot
//     contactDamagePerDifficulty 0
//     scalePerDifficulty         0     visual+hitbox growth over a run
//     maxGrowth                  ∞     cap for the above
//     scaleVariance              0     per-individual size jitter, +/- this
//                                      fraction. The hitbox follows the visual
//                                      (see spawnOne), so it is a real spread
//                                      of body sizes, not a paint job — and
//                                      for a creature with a rigid body it is
//                                      a spread of MASSES too.
//     weightPerDifficulty        0     spawn weight gained per difficulty
//     maxWeight                  ∞     cap for the above
//     maxConcurrent              ∞     per-species headcount
//     minDifficulty              0     difficulty before it can appear at all
//     minPlayerLevel             0     hard level gate, independent of time
//     spawnRateMul               1     0 disables the creature outright
//     spawnGroup                 none  family-wide cap, see spawn.groupMaxAlive.
//                                      More than one group per creature is
//                                      legal — separate them with spaces
//                                      ("apex shark") and EVERY cap named
//                                      binds. See spawnGroupsOf below.
//     bioluminescent             no    only spawns once the sun is down
//
// One difficulty point is 20 seconds at the default spawn.difficultyPerSecond.
//
// `npm run csv` opens all of this as a grid with the columns typed — the
// minimums below become validation, the optional defaults become placeholder
// text, and spawnGroup becomes a dropdown you can still type into. It reads
// REQUIRED/OPTIONAL/FLAGS straight out of this file, so a column added here
// shows up there without a second edit.
// ============================================================================

import { parseBool, parseIdTable, parseNumber } from './csvTable.js';

const LABEL = 'enemies';
const FILE = 'enemies.csv';

// Blank is not a legal value for these: nothing downstream guards them, so an
// empty cell reaches spawnOne as `undefined` and comes out the other side as
// NaN hp, an undefined radius, or an xp orb worth nothing.
const REQUIRED = {
  radius: { min: 0 },
  hp: { min: 0 },
  hpPerDifficulty: { min: 0 },
  speed: { min: 0 },
  contactDamage: { min: 0 },
  xp: { min: 0 },
  weight: { min: 0 },
};

// Blank here means "this creature doesn't have this", and the game's own `??`
// default takes over. Listed with the same minimums the values can sanely hold.
const OPTIONAL = {
  speedVariance: { min: 0 },
  speedPerDifficulty: { min: 0 },
  turnRate: { min: 0 },
  contactDamagePerDifficulty: { min: 0 },
  scalePerDifficulty: { min: 0 },
  maxGrowth: { min: 0 },
  scaleVariance: { min: 0 },
  weightPerDifficulty: { min: 0 },
  maxWeight: { min: 0 },
  maxConcurrent: { min: 1, integer: true },
  minDifficulty: { min: 0 },
  minPlayerLevel: { min: 0, integer: true },
  spawnRateMul: { min: 0 },
};

// Yes/no columns. These are the exception to the "flags stay in config.js"
// rule at the top, and the test for the exception is whether the flag decides
// WHEN a creature spawns or WHAT it is: `prey` and `canBreach` pair a creature
// with its model and its code path, but `bioluminescent` sits next to
// minDifficulty and minPlayerLevel as a third answer to "has this one's moment
// arrived yet", and those all want to be read down a column together.
//
// Blank means no, unlike parseBool's own "blank is true" default — an empty
// cell in a twenty-row table is the normal state of this column, not an
// omission, and treating it as yes would make every creature nocturnal the
// moment the column was added.
// `bossMinion` passes the same test. It decides WHEN a creature spawns — it is
// the only thing allowed in the water while a boss is alive, and everything
// without it is sent away when one arrives — so it belongs down the column
// next to minDifficulty and minPlayerLevel rather than in config.js.
//
// Blank means no, which is the answer that makes an unedited table behave the
// way the feature was asked for: a boss fight clears the ocean. Fill in the
// column to keep a species around as an escort.
const FLAGS = ['bioluminescent', 'bossMinion'];

// Every field this file owns, in one place — config.js needs the same list to
// strip these out of saved tuning, so that a snapshot can't quietly become a
// second opinion on numbers the CSV is meant to decide.
export const ENEMY_TABLE_FIELDS = [...Object.keys(REQUIRED), ...Object.keys(OPTIONAL), ...FLAGS, 'spawnGroup'];

export function parseEnemyCsv(text, warn = console.warn) {
  return parseIdTable(text, LABEL, FILE, warn);
}

// ---------------------------------------------------------------------------
// Which families a creature belongs to
// ---------------------------------------------------------------------------
// `spawnGroup` started as one string and one cap. It is now a LIST, because a
// shark is two things at once: one of the big rigged bodies competing for
// screen (the `apex` allowance, which also holds the orca and the dolphin) and
// one of the SHARKS, which want a much tighter ceiling of their own — six
// sharks is legal under an apex cap of eight and reads as a shiver rather than
// as a threat.
//
// Kept as a space-separated string rather than a real array because the value
// comes out of a spreadsheet cell: a comma would have to be quoted (and a
// hand-edit that forgets the quotes silently splits the row), and the csv
// editor's dropdown still offers the single-group values it always did.
//
// Every cap named binds — a creature is blocked if ANY of its families is
// full. Parsed on every call and deliberately not cached: applyEnemyTable
// rewrites `def.spawnGroup` in place whenever the CSV is re-applied, and a
// cache keyed on the def would then be answering for the previous file.
const NO_GROUPS = [];

export function spawnGroupsOf(def) {
  const raw = def?.spawnGroup;
  if (!raw) return NO_GROUPS;
  // Commas as well as spaces: a `spawnGroup` written "apex,shark" in a quoted
  // cell is the obvious other way to type this, and silently treating that as
  // one group named "apex,shark" would cap nothing at all.
  return String(raw).split(/[\s,]+/).filter(Boolean);
}

// The membership test every caller wants. Reads as the `=== 'apex'` it
// replaced, and is the only thing that should be asking.
export function inSpawnGroup(def, group) {
  const raw = def?.spawnGroup;
  if (!raw) return false;
  // Fast path: the overwhelmingly common case is a single group, and this runs
  // per creature per frame in the apex crowd walk.
  if (raw === group) return true;
  return spawnGroupsOf(def).includes(group);
}

// Capture what config.js itself declares for the fields this table owns, so a
// creature whose row is deleted goes back to its built-in rather than keeping
// whichever edit was applied last. Same contract as UPGRADE_BASE.
export function captureEnemyBase(enemies) {
  const base = new Map();
  for (const [id, def] of Object.entries(enemies)) {
    const rec = {};
    for (const f of ENEMY_TABLE_FIELDS) if (f in def) rec[f] = def[f];
    base.set(id, rec);
  }
  return base;
}

// Write the table onto the live CONFIG.enemies, in place.
//
// Order matters and is the same as the upgrade table's: reset to `base`
// first, then lay the row over it. Everything the CSV does not own — the
// nested blocks, the flags, `asset`, `behavior` — is never touched, so a
// creature keeps its swarm weights and its model whatever this file says.
export function applyEnemyTable(enemies, base, rows, warn = console.warn) {
  const seen = new Set();

  for (const [id, def] of Object.entries(enemies)) {
    const b = base.get(id);
    if (b) {
      for (const f of ENEMY_TABLE_FIELDS) {
        if (f in b) def[f] = b[f];
        else delete def[f];
      }
    }

    const row = rows.get(id);
    if (!row) continue;
    seen.add(id);

    for (const [field, opts] of Object.entries(REQUIRED)) {
      if (!(field in row)) continue;
      const n = parseNumber(row[field], LABEL, id, field, warn, opts);
      if (n === undefined) {
        warn(`[${LABEL}] "${id}" has no ${field} — that field has no default in the game, so the config.js value (${b?.[field]}) is being kept. Fill the cell or delete the row.`);
        continue;
      }
      if (n === null) continue; // unreadable; parseNumber has already warned
      def[field] = n;
    }

    for (const [field, opts] of Object.entries(OPTIONAL)) {
      if (!(field in row)) continue;
      const n = parseNumber(row[field], LABEL, id, field, warn, opts);
      if (n === null) continue; // unreadable; keep the built-in, warning sent
      if (n === undefined) delete def[field]; // blank: the game's default wins
      else def[field] = n;
    }

    for (const field of FLAGS) {
      if (!(field in row)) continue;
      const raw = String(row[field] ?? '').trim();
      if (raw === '') delete def[field];
      else def[field] = parseBool(raw, LABEL, id, field, warn);
    }

    if ('spawnGroup' in row) {
      const g = String(row.spawnGroup ?? '').trim();
      if (g) def.spawnGroup = g;
      else delete def.spawnGroup;
    }
  }

  // A row nobody claimed is a typo'd id or a creature deleted from config.js,
  // and it does nothing at all — so it has to be loud, for the same reason the
  // upgrade table's orphan check is.
  for (const id of rows.keys()) {
    if (!seen.has(id)) {
      warn(`[${LABEL}] ${FILE} has a row for "${id}", but no creature with that id exists in CONFIG.enemies — the row is being ignored.`);
    }
  }
}

// Strip the fields this table owns out of a saved tuning snapshot, leaving the
// nested blocks (which the tuner still edits and still saves) alone.
//
// Both directions need this. On the way IN, a snapshot written before the CSV
// existed carries a full copy of every stat, and a deep merge would put them
// back — the CSV is applied afterwards so they'd lose, but they'd also be
// re-saved on the next write and sit in the file forever looking live. On the
// way OUT, writing them at all is what creates that second opinion in the
// first place. This is the same problem `upgradeOverrides` had, one level
// deeper into the object.
//
// Returns a new object; the input is never mutated, because on the way out it
// IS the live CONFIG.enemies.
export function withoutEnemyTableFields(enemies) {
  if (!enemies || typeof enemies !== 'object') return enemies;
  const out = {};
  for (const [id, def] of Object.entries(enemies)) {
    if (!def || typeof def !== 'object') { out[id] = def; continue; }
    const rec = {};
    for (const [k, v] of Object.entries(def)) {
      if (!ENEMY_TABLE_FIELDS.includes(k)) rec[k] = v;
    }
    out[id] = rec;
  }
  return out;
}
