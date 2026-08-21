// ============================================================================
// EPITAPH LEADS — the words between a seal's name and what killed it, kept in
// epitaphs.csv.
//
// A stone says three things:
//
//     FAT TONY          the seal
//     chomped by        <- this file
//     a shark           deathCauses.js, or a boss's own rolled name
//
// It was one string in CONFIG for a while ("lost to") and that was the right
// size for the feature when every cause was a noun phrase and the stone was
// the only place it landed. It is the wrong size now: "chomped by a shark",
// "swallowed by the orca" and "who ran out of air" are three different jokes,
// and a single connector that has to serve all eighteen causes can only be the
// blandest one that fits them all.
//
// A CONNECTOR, NOT A SENTENCE. Every lead here ends where the cause begins —
// "chomped by", "done in by", "outswum by" — and the cause is always the line
// underneath, on its own. That is a real constraint rather than a style note:
// systems/epitaph.js wraps and shrinks the CAUSE line independently because it
// can now be a boss's whole rolled name at forty-nine characters, and a lead
// that swallowed the cause mid-sentence would take that away.
//
// Columns (order doesn't matter, unknown columns are ignored):
//   id       a short handle for the row. Must be unique; never shown.
//   text     the connector itself, lowercase, ending where the cause starts.
//   cause    which death this is for, as one or more ids from deathCauses.js,
//            space or comma separated. BLANK MEANS ANY DEATH, which is the
//            general pool every unwritten cause falls back to.
//   enabled  FALSE takes it out of rotation. Blank means enabled.
//   weight   how likely this line is RELATIVE TO THE OTHERS IT IS POOLED WITH.
//            Blank means 1; 0 is never used. Same rule as quips.csv.
//   notes    free text; nothing reads it.
//
// A LINE WRITTEN FOR A CAUSE BEATS THE GENERAL POOL rather than joining it —
// the same rule quips.csv and greetings.csv follow, and for the same reason. If
// anything is tagged `shark`, a shark death draws from those alone; the general
// rows are what a cause nobody wrote for gets.
//
// A BOSS DEATH USES ITS ARCHETYPE'S LEADS. The boss that killed you is a shark,
// or an orca, or a crab — deathCauses.js already classifies `bossShark` as a
// shark death — so "chomped by / Grimjaw the Famish'd" reads exactly as it
// should without a second vocabulary. The only thing a boss changes is the line
// UNDERNEATH, which becomes its name instead of its species.
//
// THE ROLL IS SPENT ONCE, when the grave is filed. A stone is carved and then
// it is carved; a lead that re-rolled every time the player swam past would be
// the one thing on the seabed that changes its mind.
// ============================================================================

import { parseIdTable, parseBool, parseNumber } from './csvTable.js';
import { DEATH_CAUSE_IDS } from './deathCauses.js';

const LABEL = 'epitaphs';
const FILE = 'epitaphs.csv';

/** What a stone says when the table has nothing at all — a parse that produced
 *  no rows, or a harness with no CSV. Never blank: a stone reading "FAT TONY /
 *  / a shark" has a hole in it where a person would look for the joke. */
export const FALLBACK_LEAD = 'lost to';

export function parseEpitaphCsv(text, warn = console.warn) {
  // (text, label, FILE, warn) and it hands back a MAP keyed by id — the same
  // shape greetingTable.js and quipTable.js consume.
  const rows = parseIdTable(text, LABEL, FILE, warn);
  const out = [];
  for (const [id, row] of rows) {
    if (parseBool(row.enabled, LABEL, id, 'enabled', warn) === false) continue;
    const line = String(row.text ?? '').trim();
    if (!line) {
      warn(`[${LABEL}] "${id}" has no text — skipped.`);
      continue;
    }
    const w = parseNumber(row.weight, LABEL, id, 'weight', warn, { min: 0 });
    out.push({
      id,
      text: line,
      weight: w == null ? 1 : w,
      causes: parseCauses(row.cause, id, warn),
    });
  }

  if (!out.length) {
    warn(`[${LABEL}] ${FILE} produced no usable leads — every stone will read "${FALLBACK_LEAD}".`);
  } else if (!out.some((r) => !r.causes)) {
    // The general pool is what every unwritten cause falls back to, and there
    // are eighteen of them. A file where every row is tagged means most deaths
    // get the hardcoded fallback and the table looks broken from the outside.
    warn(`[${LABEL}] every lead in ${FILE} is tagged to a cause — deaths nothing is `
      + `written for will read "${FALLBACK_LEAD}". Leave the cause column blank on a few.`);
  }
  return out;
}

// The same cell rule greetings.csv follows, for the same reason: space OR
// comma, because the value comes out of a spreadsheet where a comma has to be
// quoted, and an id no cause answers to is dropped WITH A WARNING rather than
// kept as a tag that can never match.
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
 * The lead for one death. NEVER BLANK — see FALLBACK_LEAD.
 *
 * `causeId` is a single id from deathCauses.js, which is what primaryCause()
 * hands back. Deliberately one and not the Set: the stone says one thing, and
 * a megalodon being both a shark death and a boss death is a question for the
 * quip pool rather than for a line of carved stone.
 *
 * `random` is injectable so the distribution can be checked without a browser.
 */
export function rollLead(rows, causeId = null, random = Math.random) {
  const pool = leadPool(rows ?? [], causeId);
  if (!pool.length) return FALLBACK_LEAD;

  let total = 0;
  for (const r of pool) total += r.weight > 0 ? r.weight : 0;
  // Every weight zero is a misconfigured file rather than an instruction to be
  // silent — the same reading pickGreeting and pickQuip take.
  if (total <= 0) return pool[Math.floor(random() * pool.length)].text;

  let roll = random() * total;
  let last = pool[0];
  for (const r of pool) {
    if (r.weight <= 0) continue;
    last = r;
    roll -= r.weight;
    if (roll <= 0) return r.text;
  }
  return last.text;
}

/** Which rows a given death may draw from. Exported for the tuner readout and
 *  for tests — "what can a crab death say" is the question an author asks. */
export function leadPool(rows, causeId = null) {
  const tagged = causeId
    ? rows.filter((r) => r.causes?.includes(causeId))
    : [];
  // A line written for how you died beats the general pool rather than
  // competing with it. See the header.
  return tagged.length ? tagged : rows.filter((r) => !r.causes);
}

/** Which causes have no line of their own. The drift check — exported rather
 *  than left in the test so the same answer is available from a console. */
export function causesWithoutLeads(rows) {
  return DEATH_CAUSE_IDS.filter((id) => !rows.some((r) => r.causes?.includes(id)));
}
