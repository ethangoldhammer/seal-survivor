// ============================================================================
// THE RECORDS FILE — the shape the dead travel in, and both ends of it.
//
// The game's two records of the dead live in localStorage and are therefore
// stuck to ONE ORIGIN. systems/nameLedger.js is every seal that has ever died;
// systems/graveyardStore.js is the last dozen with their inscriptions. Neither
// can be read by anything that is not the game itself — a problem the moment a
// second surface wants to look at them, and the design scene in Spline is that
// second surface: it runs on Spline's origin, so it can see neither.
//
// So the bridge is a DOCUMENT rather than a connection. A pasted file cannot be
// half-written, cannot need a server, and cannot quietly diverge from what the
// game stored — it IS what the game stored, at the moment it was asked.
//
// BOTH ENDS IN ONE FILE, and that is the whole reason this module exists apart
// from the one that reads storage. `packRecords` writes the shape and
// `parseRecords` reads it; if the shape changes, both change in the same edit.
// A hand-written reader on the far side is precisely the failure this avoids —
// see the 30x30 word list the Spline scene carried before any of this.
//
// NOTHING HERE TOUCHES STORAGE OR THE ARENA, and that is load-bearing rather
// than tidy. systems/nameExport.js reads localStorage and pulls in
// graveyardStore -> arena -> config.js -> three.js; bundling that for a page
// that only wants to READ a file was 602KB to parse some JSON. This module has
// no imports at all, so the far end costs nothing.
//
// NOTHING HERE WRITES INTO A GAME EITHER. Importing a ledger back into a
// running game would be un-burying seals that another copy of the game killed,
// and permadeath stops meaning anything the moment that is possible. See
// clearNameLedger's note: "un-bury my seals" is a sentence with no meaning here.
// ============================================================================

/**
 * Bumped when the shape changes in a way an old file cannot satisfy. A reader
 * that does not recognise the version says so rather than guessing — see
 * parseRecords. Independent of graveyardStore's own VERSION, which describes
 * what is on DISK; this describes what is in the FILE.
 */
export const RECORDS_VERSION = 1;

/** The marker that says this file is ours and not some other JSON. */
export const RECORDS_KIND = 'seal-survivor-records';

/**
 * Build the file from records already in hand.
 *
 * `buried` is oldest-first and is the RULE — every name that can never be used
 * again. `graves` is the last dozen with their inscriptions, and is a SUBSET:
 * every grave's name is also in `buried`, but the great majority of the buried
 * have no stone left standing. A reader that treats the two as one list will
 * draw a graveyard a fiftieth of its real size.
 *
 * Takes its data rather than fetching it, so this module never has to know
 * where a record is kept — which is what lets it run on a page that has no
 * access to where the records are kept.
 */
export function packRecords({ buried = [], graves = [] } = {}) {
  return {
    kind: RECORDS_KIND,
    version: RECORDS_VERSION,
    // Stamped so a file found later can be placed. Not read by anything —
    // deliberately, because a timestamp a reader depends on is a clock two
    // machines have to agree about.
    exportedAt: new Date().toISOString(),
    buried: [...buried],
    graves: graves.map((g) => ({
      name: g.name,
      cause: g.cause ?? '',
      lead: g.lead ?? '',
      stone: g.stone ?? null,
    })),
  };
}

/** The same thing as text, ready to paste. Indented because a human is going
 *  to look at it at least once, and a dozen graves of pretty-printing costs
 *  nothing against a ledger that is mostly one name per line anyway. */
export function packRecordsJson(records) {
  return JSON.stringify(packRecords(records), null, 2);
}

/**
 * Read a file back. Returns `{ buried, graves, warnings }` — never throws, and
 * never returns null, because every caller of this is a paste box, and a paste
 * box that explodes on a stray character is worse than one that says what it
 * could not use.
 *
 * PERMISSIVE ABOUT SHAPE, STRICT ABOUT TYPE. Anything that is not a string name
 * is dropped with a warning rather than carried through as `undefined` to be
 * rendered as the word "undefined" on a headstone. A wrong version is a warning
 * and not a refusal: these fields have only ever been added to, so an older
 * file is readable and saying otherwise would strand it.
 */
export function parseRecords(text) {
  const warnings = [];
  let rec = null;
  try {
    rec = JSON.parse(String(text ?? ''));
  } catch {
    return { buried: [], graves: [], warnings: ['That is not JSON — paste the whole file, outer { } included.'] };
  }
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    return { buried: [], graves: [], warnings: ['That JSON is not a records file — expected an object with `buried` and `graves`.'] };
  }
  if (rec.kind && rec.kind !== RECORDS_KIND) {
    warnings.push(`This file says it is "${rec.kind}", not "${RECORDS_KIND}" — reading it anyway.`);
  }
  if (rec.version != null && Number(rec.version) !== RECORDS_VERSION) {
    warnings.push(`This file is version ${rec.version} and this reader is version ${RECORDS_VERSION} — reading what it recognises.`);
  }

  const buried = [];
  const rawBuried = Array.isArray(rec.buried) ? rec.buried : [];
  if (!Array.isArray(rec.buried)) warnings.push('No `buried` list — the permadeath record is empty.');
  for (const n of rawBuried) {
    const clean = typeof n === 'string' ? n.trim() : '';
    if (clean) buried.push(clean);
  }
  const lostNames = rawBuried.length - buried.length;
  if (lostNames > 0) {
    warnings.push(`${lostNames} buried entr${lostNames === 1 ? 'y was' : 'ies were'} not a name and had to be dropped.`);
  }

  const graves = [];
  const rawGraves = Array.isArray(rec.graves) ? rec.graves : [];
  for (const g of rawGraves) {
    if (!g || typeof g !== 'object') continue;
    const name = typeof g.name === 'string' ? g.name.trim() : '';
    if (!name) continue;
    graves.push({
      name,
      cause: typeof g.cause === 'string' ? g.cause : '',
      lead: typeof g.lead === 'string' ? g.lead : '',
      stone: typeof g.stone === 'string' ? g.stone : null,
    });
  }
  const lostGraves = rawGraves.length - graves.length;
  if (lostGraves > 0) {
    warnings.push(`${lostGraves} grave${lostGraves === 1 ? '' : 's'} had no name and had to be dropped.`);
  }

  return { buried, graves, warnings };
}
