// ============================================================================
// GREETING TABLE — the line the game opens a run with, kept in greetings.csv.
//
// The coach's first sentence used to be an instruction ("Left stick to swim"),
// which is the right thing to say to somebody who has never played and a
// strange thing to be the first thing anybody hears on their fortieth run,
// when the coach has been finished for a month and the water simply opens in
// silence. So a run now opens by SAYING HELLO, every run, forever — one short
// line on the band with the player's name in it.
//
// IT IS NOT A TIP, and that is why it is its own table rather than three more
// `coach` rows in callouts.csv. A coach row fires ONCE EVER per browser and is
// joined to a step in code by its id (see calloutTable.js); a greeting fires on
// every run and is joined to nothing — it is a POOL, drawn from, exactly like
// quips.csv. The two files are siblings in every way that matters: an id that
// means nothing to code, a `weight`, a `causes` column, and the same rule about
// what a written-for line does to the general pool.
//
// AND IT KNOWS WHETHER THIS IS THE FIRST RUN OR THE FORTIETH. "Welcome to the
// deep" is a lie on the fortieth and "Back again?" is nonsense on the first, so
// a row says which of the two it is for — the `when` column — and a run that
// follows another one is greeted differently from a run that follows nothing.
//
// A RUN THAT FOLLOWS A DEATH CAN NAME IT. `{cause}` is the second chip after
// `{player}`, and it becomes what killed the player LAST time: "a shark", "a
// crab", "running out of air" — the `label` from deathCauses.js, which is
// where the wording of a cause has always lived. A row may also be TAGGED for
// a cause in the `causes` column, which is the same mechanism quips.csv uses
// and follows the same rule: a line written for how you died beats the general
// pool rather than joining it.
//
// ...AND IT CAN NAME WHO IT HAPPENED TO. `{departed}` is the third chip: the
// seal that died last run, by name. It exists because death is permanent here
// (systems/nameLedger.js) — the player who was "Fat Tony" last run is somebody
// else now and can never be Fat Tony again, so the two names in a hello are
// two different characters rather than one string used twice:
//
//     "{departed} is on the seabed. Try not to join them, {player}."
//
// THE THREE CHIPS ARE SPENT IN TWO DIFFERENT PLACES and it matters which.
// `{cause}` and `{departed}` are facts about a run that is already over, so
// they are spent ONCE when the line is rolled. `{player}` is spent on the way
// to the screen on every frame, so a player who renames themselves mid-run is
// called by the new name immediately. Read the note in systems/greeting.js
// before moving any of them.
//
// Columns (order doesn't matter, unknown columns are ignored):
//   id       a short handle for the row. Must be unique; never shown.
//   text     the line itself. May spend `{player}`, `{cause}` and `{departed}`.
//   enabled  FALSE takes it out of rotation. Blank means enabled.
//   weight   how likely this line is RELATIVE TO THE OTHERS IT IS POOLED WITH.
//            Blank means 1; 0 is never shown. Same rule as quips.csv.
//   when     `first` for a player who has never finished a run, `again` for one
//            who has. BLANK MEANS EITHER, which is right for a line that says
//            nothing about history ("Dive in, {player}") and wrong for almost
//            everything else — see the two failures at the top of this file.
//   causes   what has to have killed them LAST RUN for this line to fire, as
//            one or more ids from deathCauses.js. Blank means any death, and
//            also means a run that ended without one.
//
// `{cause}` IS LOWERCASE AND BELONGS MID-SENTENCE. The labels read "a shark",
// "the trawler or the yacht", "running out of air" — noun phrases with their
// article attached, because that is what makes them droppable into a sentence
// somebody wrote. A row that opens with the chip gets a lowercase first letter
// on screen, so write "Last time it was {cause}." rather than "{cause} was
// last time." — there is no capitalisation pass here on purpose, since one
// would have to guess at "the kraken" versus "The kraken" and would be wrong
// in a sentence that carries on afterwards.
//
// A ROW THAT NAMES `{cause}` CANNOT BE SAID WHEN THERE IS NO CAUSE — a first
// run, or a run the player abandoned rather than died in. Those rows are held
// out of the pool automatically (see needsCause), which is why the chip is not
// something an author has to remember to guard: writing it is the guard.
//
// `{departed}` IS GUARDED THE SAME WAY AND SEPARATELY, because the two facts
// are not the same fact. A death always has a cause; it only has a NAME if the
// run that ended was played after this was built, or in a browser that stored
// it. So a row naming the seal is held back on its own condition rather than
// on the cause's — sharing one guard would put "{departed} is on the seabed"
// on screen as "is on the seabed" for anybody whose last death predates the
// field, which is the sort of thing that ships because it works on the machine
// it was written on.
//
// `{departed}` IS A PROPER NOUN and the opposite of `{cause}` in every way
// that matters to a writer: it is capitalised as the player typed it, it is
// safe at the start of a sentence, and it is somebody rather than something.
// Write "{departed} didn't make it." and not "Last time it was {departed}." 
// ============================================================================

import { parseIdTable, parseBool, parseNumber } from './csvTable.js';
import { DEATH_CAUSE_IDS } from './deathCauses.js';

const LABEL = 'greetings';
const FILE = 'greetings.csv';

/** Which run a row is for. Blank — neither of these — means either. */
export const GREETING_WHENS = ['first', 'again'];

/** The chip that becomes the name of the seal that died last run. A proper
 *  noun, unlike {cause} — see the header. */
export const DEPARTED_TOKEN = /\{departed\}/g;

/** The chip that becomes the last run's cause of death. See the header. */
const CAUSE_TOKEN = /\{cause\}/g;

export function parseGreetingCsv(text, warn = console.warn) {
  const rows = parseIdTable(text, LABEL, FILE, warn);
  const out = [];

  for (const [id, row] of rows) {
    const line = String(row.text ?? '').trim();
    if (!line) {
      warn(`[${LABEL}] "${id}" has no text — the row is being ignored.`);
      continue;
    }
    if (!parseBool(row.enabled, LABEL, id, 'enabled', warn)) continue;

    const w = parseNumber(row.weight, LABEL, id, 'weight', warn, { min: 0 });
    const when = parseWhen(row.when, id, warn);
    const causes = parseCauses(row.causes, id, warn);
    // Derived from the words rather than declared in a column, because it IS
    // the words: a line with the chip in it has nothing to say about a run
    // that had no death in it, and a `needsCause` cell would be a second
    // answer to that question able to disagree with the first.
    const needsCause = CAUSE_TOKEN.test(line);
    CAUSE_TOKEN.lastIndex = 0;
    // Its own flag and not folded into needsCause: a death always has a cause
    // and does not always have a name on record. See the header.
    const needsDeparted = DEPARTED_TOKEN.test(line);
    DEPARTED_TOKEN.lastIndex = 0;

    // A LINE THAT CAN NEVER BE SAID, warned about at parse where it is
    // visible. Both shapes are the same mistake — a row about the last run
    // filed as a first-run line — and both are invisible in the game, which is
    // the failure this whole file is written to avoid: the row simply never
    // comes up, and never coming up looks exactly like never being rolled.
    if (when === 'first' && (needsCause || needsDeparted || causes)) {
      const what = needsCause ? 'names {cause}'
        : needsDeparted ? 'names {departed}'
        : 'is tagged for a cause';
      warn(`[${LABEL}] "${id}" is a first-run line but ${what} `
        + '— a first run has no last run, so this line can never appear. Set when=again.');
    }

    out.push({ id, text: line, weight: w == null ? 1 : w, when, causes, needsCause, needsDeparted });
  }

  if (!out.length) {
    warn(`[${LABEL}] ${FILE} produced no usable lines — a run will open in silence.`);
  }
  return out;
}

// `first`, `again`, or null for "either". An unrecognised value lands on null
// rather than dropping the row: a greeting shown in the wrong place is a bad
// line, and a greeting nobody can ever see is a bug — and this is a column
// people will type `returning` into.
function parseWhen(raw, id, warn) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return null;
  if (GREETING_WHENS.includes(v)) return v;
  warn(`[${LABEL}] "${id}" has when="${raw}", which is not ${GREETING_WHENS.join(' or ')} `
    + '— treating it as either.');
  return null;
}

// The same cell rule quips.csv follows, for the same reason: space OR comma,
// because the value comes out of a spreadsheet where a comma has to be quoted,
// and an id no cause answers to is dropped WITH A WARNING rather than kept as
// a tag that can never match.
function parseCauses(raw, id, warn) {
  const s = String(raw ?? '').trim();
  if (!s) return null; // null, not [] — "any death", which is not "no death"
  const ids = s.split(/[\s,]+/).filter(Boolean);
  const known = ids.filter((c) => {
    if (DEATH_CAUSE_IDS.includes(c)) return true;
    warn(`[${LABEL}] "${id}" is tagged for cause "${c}", which is not a death cause — `
      + `that tag is being ignored. Known: ${DEATH_CAUSE_IDS.join(', ')}.`);
    return false;
  });
  return known.length ? known : null;
}

/**
 * `{cause}` -> what killed them last run, as deathCauses.js words it.
 *
 * A missing label leaves the text ALONE rather than blanking the chip, and the
 * caller is expected never to get here: pickGreeting cannot return a
 * `needsCause` row without a cause to spend. Left visible for the one way that
 * could stop being true — somebody calling this by hand — because a brace on
 * the band is a bug report and a sentence with a hole in it reads as ordinary
 * bad writing.
 */
export function expandCause(text, label) {
  if (!text || !text.includes('{')) return text ?? '';
  if (!label) return String(text);
  return String(text).replace(CAUSE_TOKEN, label);
}

/**
 * `{departed}` -> the seal that died last run, by name.
 *
 * Same contract as expandCause and for the same reason: a missing name leaves
 * the chip ALONE rather than blanking it, because a brace on the band is a bug
 * report and a sentence with a hole where a person should be is just bad
 * writing that nobody will trace back to here. pickGreeting cannot return a
 * `needsDeparted` row without a name to spend, so this is the guard for the
 * one way that could stop being true.
 */
export function expandDeparted(text, name) {
  if (!text || !text.includes('{')) return text ?? '';
  const who = String(name ?? '').trim();
  if (!who) return String(text);
  return String(text).replace(DEPARTED_TOKEN, who);
}

/**
 * Both facts about the run that just ended, spent together.
 *
 * One call rather than two nested ones at the call site, because they are one
 * question — "what may this line say about last time" — and a caller that
 * remembers to expand the cause and forgets the name produces a hello with a
 * literal {departed} in it, on the band, as the first thing a returning player
 * reads. `{player}` is deliberately NOT here; see the header for why it is
 * spent somewhere else entirely.
 */
export function expandLastRun(text, { cause = null, departed = null } = {}) {
  return expandDeparted(expandCause(text, cause), departed);
}

/**
 * One greeting, weighted, or null when the table has nothing to say — silence
 * is a perfectly good way to open a run, which is why this does not have
 * quips.csv's never-empty promise. A blank score-screen headline is a broken
 * menu; a run that opens with no line is the game the player had last week.
 *
 * `random` is injectable so the distribution can be checked without a browser.
 *
 * Options:
 *   returning  has this player played a run before?
 *   causes     the Set from causesOfDeath() for the run BEFORE this one, or
 *              null/empty when that run had no death in it (they quit, or
 *              nothing classified what killed them).
 *   avoid      the id rolled at the start of the LAST run, which is dropped
 *              from the pool if anything else is left. Two identical hellos in
 *              a row is the one repeat a player is guaranteed to notice, since
 *              the two are minutes apart and both are the first thing on the
 *              screen.
 */
export function pickGreeting(rows, random = Math.random, opts = {}) {
  const pool = poolFor(rows ?? [], opts);
  if (!pool.length) return null;

  let total = 0;
  for (const g of pool) total += g.weight > 0 ? g.weight : 0;
  // Every weight zero is a misconfigured file rather than an instruction to be
  // silent — same reading pickQuip and drawUpgrades take.
  if (total <= 0) return pool[Math.floor(random() * pool.length)];

  let roll = random() * total;
  let last = pool[0];
  for (const g of pool) {
    if (g.weight <= 0) continue; // skipped, not merely worth nothing
    last = g;
    roll -= g.weight;
    if (roll <= 0) return g;
  }
  return last; // float drift ate the total
}

// The narrowing, step by step, because every step is a fallback and the order
// is the whole behaviour.
function poolFor(rows, { returning = false, causes = null, departed = null, avoid = null } = {}) {
  // 1. THE RIGHT HALF OF THE FILE. A row with no `when` is in both halves.
  const want = returning ? 'again' : 'first';
  let pool = rows.filter((g) => !g.when || g.when === want);

  // 2. WHAT THIS RUN IS ALLOWED TO REFER TO. A first run has no last run, and
  // a run somebody quit out of has no death — in both cases every line about
  // one is out, whether it says so with a tag or with the chip.
  const has = (c) => (causes?.has ? causes.has(c) : !!causes?.includes?.(c));
  const known = returning && !!(causes?.size ?? causes?.length);
  // ITS OWN GATE, APPLIED FIRST AND UNCONDITIONALLY. A run can have a known
  // cause and no name on record — a death filed before the name was stored, or
  // in a browser that stored nothing — so this cannot ride on `known`. Applied
  // before the cause narrowing below rather than after, so a cause-tagged pool
  // that would otherwise be all `{departed}` lines falls back to the general
  // pool instead of coming back empty and opening the run in silence.
  if (!(returning && String(departed ?? '').trim())) {
    pool = pool.filter((g) => !g.needsDeparted);
  }
  if (!known) {
    pool = pool.filter((g) => !g.needsCause && !g.causes);
  } else {
    // 3. A LINE WRITTEN FOR HOW YOU DIED BEATS THE GENERAL POOL rather than
    // competing with it — the rule quips.csv documents at length. Die to a
    // crab and the draw happens among the crab lines only.
    const matched = pool.filter((g) => g.causes?.some(has));
    // Untagged lines survive the fallback WITH their `{cause}` chips intact:
    // "Last time it was a pufferfish" is written for no cause in particular
    // and is exactly what a cause nobody wrote a line for should get.
    pool = matched.length ? matched : pool.filter((g) => !g.causes);
  }

  // 4. NEVER EMPTY. The last resort, and it exists because the file keeps
  // arriving at this state honestly rather than by mistake.
  //
  // `{departed}` turned out to be the chip everybody wants to use, and once
  // every returning line names the dead seal there is nothing left to say to a
  // player who RESTARTED rather than died — no death means no name to spend,
  // and the pool empties. Requiring a couple of plain rows to be kept back for
  // that case is a rule nobody can see in a spreadsheet, and it was broken
  // twice within an hour of the chip existing.
  //
  // So the fallback is the lines that need nothing at all — in practice the
  // first-run pool. "Hello {player}!" to somebody who restarted mid-run is not
  // even wrong: they never died, they are still the same seal, and being
  // greeted from the top is exactly what happened. Silence, which is what this
  // replaces, is indistinguishable from the feature being switched off.
  if (!pool.length) {
    pool = rows.filter((g) => !g.needsCause && !g.needsDeparted && !g.causes);
  }

  // 5. NOT THE SAME HELLO TWICE. Last, so it can never empty a pool that had
  // something in it — if the only line left is the one we said last time, it
  // is better to repeat than to open in silence.
  if (avoid && pool.length > 1) {
    const fresh = pool.filter((g) => g.id !== avoid);
    if (fresh.length) pool = fresh;
  }
  return pool;
}
