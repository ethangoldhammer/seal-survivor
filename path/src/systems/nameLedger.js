// ============================================================================
// THE LEDGER OF THE BURIED — every name that has already died.
//
// Death is permanent here. A seal that ends a run is on the seabed with its
// name cut into a stone, and the next run is a DIFFERENT seal — so a name can
// be spent exactly once and never again. This is the record that makes that
// true rather than merely encouraged.
//
// PERSISTENT, unlike the graveyard itself. systems/gravesite.js keeps six
// stones and only for as long as the tab is open, because a graveyard is a
// record of one sitting and four headstones greeting you a week later is the
// game telling you that you used to be worse at it. This is not that: it is a
// RULE, and a rule that forgets itself on reload is not one. Somebody who
// closes the tab and comes back has not un-died.
//
// CASE- AND SPACE-INSENSITIVE, and that is the whole reason a name is
// normalised before it is compared. "Fat Tony", "fat tony" and "FAT  TONY" are
// one seal to everybody except a string comparison, and a rule a player can
// step around by holding shift is not a rule — it is a puzzle about how the
// check was written. What is STORED is the name as it was actually spelled,
// because that is what the stone says and what a list of the dead should read
// like; only the KEY is flattened.
//
// IT IS NOT A LEADERBOARD. Nothing here goes to a server and nothing here is
// anybody else's names — this is one player's own dead, on their own machine.
// Two people sharing a browser share a graveyard, which is the correct and
// slightly funny answer.
// ============================================================================

const KEY = 'seal-survivor-buried';

// How many of the dead are remembered.
//
// A BACKSTOP AGAINST STORAGE, NOT A POLICY, and the number is chosen to make
// sure it never becomes one. It has to sit clear of the whole space
// sealNames.csv can produce: anything at or below that ceiling would mean a
// player's earliest names quietly coming back into circulation while the table
// still had unused ones left — the permadeath rule silently not applying,
// rather than the player being told anything. A player who has met every seal
// there is gets randomPlayerName's lineage ("Fat Tony II"), not eviction.
//
// THE CEILING MOVES WHEN THE TABLE DOES, and this number does not follow it on
// its own. sealNames.csv was 68 adjectives x 84 nicknames when 8,000 was
// chosen; it is 87 x 115 today, which is 10,146 possible seals — so 8,000 had
// become a policy without anyone deciding it was one. 25,000 is roughly 2.5x
// the table as it stands, which is the room the next few hundred rows need.
//
// It is not derived from the table here on purpose: this module is storage and
// nothing else, and importing the CSV would pull a parse into every harness
// that only wanted localStorage. next-seal-test.mjs drains the real table and
// buries all of it, so the day this number stops clearing the ceiling is the
// day `test:nextseal` says so — which is exactly how this was found.
//
// The cost is about 400KB against a 5MB budget. The write path below survives a
// quota failure anyway rather than depending on this to prevent one.
const MAX_REMEMBERED = 25000;

let cached = null;
// The same names as `cached`, flattened to comparison keys, for the lookup.
//
// NOT AN OPTIMISATION LOOKING FOR A PROBLEM. Every roll of the dice checks up
// to ROLL_TRIES candidates (see systems/randomName.js), and a linear scan that
// re-flattens every stored name on every check is 40 x n string operations per
// button press — at a few thousand dead that is millions of them to answer a
// question a Set answers in one. Kept in step with `cached` in exactly two
// places, both below.
let index = null;

/** The comparison key. See the header: flattened for the CHECK only. */
export function nameKey(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function read() {
  if (cached) return cached;
  cached = [];
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : null;
    // Anything that is not a list of strings is treated as no record at all
    // rather than repaired. A player whose storage has been hand-edited or
    // half-written gets a fresh graveyard, which is a much better failure than
    // a rule that half-works on names nobody can predict.
    if (Array.isArray(list)) cached = list.filter((n) => typeof n === 'string' && n.trim());
  } catch {
    // Private window, opaque origin, quota, or a value somebody typed by hand.
    // An empty ledger means every name is available, which is the right way to
    // be wrong: the rule quietly stops applying instead of the game refusing
    // every name the player tries.
    cached = [];
  }
  index = new Set(cached.map(nameKey));
  return cached;
}

function write(list) {
  cached = list;
  index = new Set(list.map(nameKey));
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Out of quota, or storage is not writable. The session still remembers —
    // `cached` is the live copy and every check below reads it — so the rule
    // holds for as long as the tab is open and simply does not survive a
    // reload. Never throws: this is called from the death path, and a run must
    // be able to end.
  }
}

/**
 * Has this name already died?
 *
 * A blank is never buried. Blank is not a name — it is a field nobody has
 * filled in yet — and answering "yes, taken" for it would make an empty box
 * look like a rejection.
 */
export function isNameBuried(name) {
  const key = nameKey(name);
  if (!key) return false;
  read(); // populates `index` alongside `cached`
  return index.has(key);
}

/**
 * This seal is dead. Called once, from the moment the run ends.
 *
 * Idempotent: burying a name twice is a no-op rather than two entries, because
 * the one thing that must never happen here is the list filling with copies of
 * a single name and pushing the real dead out past the cap.
 */
export function buryName(name) {
  const clean = String(name ?? '').trim();
  if (!clean || isNameBuried(clean)) return false;
  const list = [...read(), clean];
  // Oldest first out — see MAX_REMEMBERED.
  write(list.length > MAX_REMEMBERED ? list.slice(list.length - MAX_REMEMBERED) : list);
  return true;
}

/**
 * Bury a whole list at once. One storage write instead of one per name, which
 * is the difference between linear and quadratic when the list is long — every
 * single-name call re-serialises the entire ledger.
 *
 * Here for the harness that has to fill a graveyard to test what happens when
 * the table runs out, and for any future import path. The GAME buries one seal
 * at a time, because that is how seals die.
 */
export function buryMany(names) {
  const list = [...read()];
  const seen = new Set(list.map(nameKey));
  for (const raw of names ?? []) {
    const clean = String(raw ?? '').trim();
    const key = nameKey(clean);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    list.push(clean);
  }
  write(list.length > MAX_REMEMBERED ? list.slice(list.length - MAX_REMEMBERED) : list);
  return list.length;
}

/** Every name that has died, oldest first. A COPY — the caller must not be
 *  able to edit the record by holding the array it came from. */
export function buriedNames() {
  return [...read()];
}

/** How many seals have died. What a "run 47" line would spend. */
export function buriedCount() {
  return read().length;
}

/**
 * Forget every death. The development door, and what a harness calls between
 * simulated players — deliberately not in the game's UI. "Un-bury my seals" is
 * a sentence with no meaning in a game whose whole premise is that it cannot be
 * said, and a reset button beside a permadeath rule is the rule being optional.
 */
export function clearNameLedger() {
  cached = [];
  index = new Set();
  try {
    localStorage.removeItem(KEY);
  } catch { /* nothing to do, and nothing worth taking a run down for */ }
}
