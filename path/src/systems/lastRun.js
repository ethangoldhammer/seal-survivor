// ============================================================================
// THE RUN BEFORE THIS ONE — how many there have been, and what ended the last
// one.
//
// Three facts, one key, and they exist for exactly one reader: the greeting on
// the band at the top of a run (systems/greeting.js). "Back again?" needs to
// know there was a run before, and "a shark got you last time" needs to know
// what killed it.
//
// WHY THIS IS NOT THE PLAYTEST LEDGER. systems/playtest.js already records
// every run in far more detail than this does — and it is an AUTHORING
// surface: it is written for the balance report, it is trimmed and uploaded,
// and it can be turned off. A sentence the player reads at the start of every
// run cannot be built on something that may not be there, so this is three
// fields of its own that nothing else writes.
//
// A RUN IS COUNTED WHEN IT STARTS, NOT WHEN IT ENDS. The question the greeting
// asks is "has this person played before", and a player who starts a run,
// hates it, and reloads the page HAS — they should be greeted as a returning
// player on the next one even though nothing ever killed them. That is also
// why the two facts are written at two different moments: the count at the
// start of a run, the cause at the moment of death.
//
// ...AND THE CAUSE IS CLEARED BY THE NEXT START. Otherwise a player who
// abandons a run mid-fight is told about a death that happened two runs ago,
// which reads as the game misremembering — the exact impression the whole
// feature is trying to make the opposite of. No death last run means no line
// about one, and there are plenty of greetings that never mention it.
//
// EVERY STORAGE PATH IS WRAPPED. localStorage throws outright in a private
// window and on an opaque origin, and this is a hello — the failure mode of a
// throw swallowed here is that everybody is greeted as a first-timer, which is
// the right way to be wrong about a sentence. The cache below is what keeps
// the SESSION honest even then: a player with no storage at all is still
// greeted correctly on their second run of the same page load.
// ============================================================================

const KEY = 'sealSurvivor.lastRun.v1';

// The live record, so the greeting costs nothing to roll and so the whole
// thing keeps working in a browser that will not store anything. `undefined`
// means "not read yet", which is distinct from the empty record below.
let cached;

/** What a player we have never seen looks like. */
function empty() {
  return { runs: 0, source: null, name: null, greeting: null };
}

function read() {
  if (cached !== undefined) return cached;
  cached = empty();
  try {
    const raw = localStorage.getItem(KEY);
    const rec = raw ? JSON.parse(raw) : null;
    if (rec && typeof rec === 'object') {
      // Field by field rather than by spreading whatever was in storage: this
      // is a hand-editable key on a machine we do not own, and `runs: "lots"`
      // must not become a comparison that is false in both directions.
      const runs = Number(rec.runs);
      cached = {
        runs: Number.isFinite(runs) && runs > 0 ? Math.floor(runs) : 0,
        source: typeof rec.source === 'string' && rec.source ? rec.source : null,
        // WHO died, alongside what killed them. Under permadeath that seal is
        // gone for good (systems/nameLedger.js), which is what makes it worth
        // storing: the name is not a stale copy of the player's current one, it
        // is the only remaining record of somebody the game will never call
        // them again. greetings.csv spends it as `{departed}`.
        //
        // Read defensively like every other field here — this is a
        // hand-editable key on a machine we do not own, and a `name: 42` must
        // not reach a sentence.
        name: typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : null,
        greeting: typeof rec.greeting === 'string' && rec.greeting ? rec.greeting : null,
      };
    }
  } catch {
    // Private window, opaque origin, or a value somebody typed by hand. Either
    // way this player is new to us, which is a greeting rather than an error.
    cached = empty();
  }
  return cached;
}

function write(rec) {
  cached = rec;
  try {
    localStorage.setItem(KEY, JSON.stringify(rec));
  } catch { /* the session still remembers — see the header */ }
}

/**
 * The record as it stands. A COPY: the greeting reads this at the top of a run
 * and then immediately overwrites it, and handing out the live object would
 * make those two the same object.
 */
export function lastRun() {
  return { ...read() };
}

/**
 * A run is starting. Returns what the record said BEFORE this call — which is
 * the whole reason it is one function rather than a read and a write the
 * caller has to remember to do in that order.
 *
 * `greetingId` is the line about to be spoken, kept only so the next run can
 * avoid repeating it. Null is fine and means "nothing was said".
 */
export function noteRunStart(greetingId = null) {
  const before = lastRun();
  write({
    runs: before.runs + 1,
    // Cleared, not carried. See the header: a death belongs to the run it
    // happened in, and this one has not happened yet.
    source: null,
    // And so does the seal it happened to. Carried forward instead, a hello
    // three runs later would mourn somebody who died on a different afternoon
    // — and `{departed}` is gated on this being present, so leaving it set is
    // how a line about a death fires on a run that had none.
    name: null,
    greeting: greetingId ?? null,
  });
  return before;
}

/**
 * The seal died, and this is the raw damage source that finished it —
 * 'greatWhite', 'drowning', 'boss:boatSalvo'. Stored raw rather than as a
 * cause id: deathCauses.js turns one source into a cause for the label and a
 * SET of them for the tagging, and banking either answer here would be
 * choosing one of the two before knowing which the greeting needs.
 *
 * `name` is the seal it happened to — the one thing about a dead seal that the
 * ledger of the buried does not answer, because that record says only that a
 * name is spent and not which death spent it. Optional so the harnesses that
 * call this with one argument keep working; the game always passes it, and a
 * death filed without a name is one the next hello cannot mourn by name.
 */
export function noteDeath(source, name = null) {
  const s = String(source ?? '').trim();
  const who = String(name ?? '').trim();
  const rec = read();
  write({ ...rec, source: s || null, name: who || null });
}

/**
 * Forget everything — the development door, and what a harness calls between
 * simulated players. Not in the game's UI: there is no player-facing meaning
 * to "the game should stop remembering that you died to a crab".
 */
export function clearRunHistory() {
  write(empty());
  try {
    localStorage.removeItem(KEY);
  } catch { /* nothing to do, and nothing worth taking a run down for */ }
}
