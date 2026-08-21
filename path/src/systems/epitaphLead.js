// The lead the stone is carved with, drawn from epitaphs.csv.
//
// A module of its own for the same reason systems/randomName.js is one: the
// TABLE knows nothing about files or storage (see path/src/epitaphTable.js for
// what the columns mean), and this is the one place that loads it. Anything
// that carves a stone reaches for this rather than parsing the file again.
//
// Deliberately NOT part of systems/epitaph.js. That module turns three strings
// into a texture and is imported by a look page that has no business pulling a
// CSV in behind it; this is where the words come from.

import epitaphsCsv from '../epitaphs.csv?raw';
import { parseEpitaphCsv, rollLead, leadPool, FALLBACK_LEAD } from '../epitaphTable.js';

// Parsed at module load, like every other table in the game: the file is
// static, and a parse per death would be work done to get the same answer.
// Warnings land in the console at boot, where the rest of the table warnings
// are.
const LEADS = parseEpitaphCsv(epitaphsCsv, console.warn);

/**
 * The connector for one death — "chomped by", "who ran out of", "lost to".
 *
 * `causeId` is a single id from deathCauses.js, which is what primaryCause()
 * hands back. A BOSS DEATH PASSES ITS ARCHETYPE'S CAUSE and not a boss-specific
 * one: the thing that killed you is a shark, and "chomped by / Grimjaw the
 * Famish'd" is the sentence that wants writing. See the header in
 * path/src/epitaphTable.js.
 *
 * Never blank.
 */
export function epitaphLead(causeId = null, random = Math.random) {
  return rollLead(LEADS, causeId, random);
}

/** What a given death can say. For the tuner readout and for tests. */
export function leadsFor(causeId = null) {
  return leadPool(LEADS, causeId).map((r) => r.text);
}

/** The parsed table, for tools and tests that want to count what is in it. */
export function epitaphLeads() {
  return LEADS;
}

export { FALLBACK_LEAD };
