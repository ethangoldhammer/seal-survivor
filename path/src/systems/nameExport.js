// ============================================================================
// THE RECORDS, OUT OF THE BROWSER — the game end of systems/recordsFile.js.
//
// One job: read the two places the dead are kept and hand back the file. The
// SHAPE of that file, and the reader for it, are in recordsFile.js and not
// here, because the reader runs somewhere this module cannot go — reading
// storage means importing graveyardStore, which reaches arena.js and from there
// config.js and three.js, and a page that only wants to parse some JSON should
// not be paying for the renderer to do it.
//
// Imported for its SIDE EFFECT from main.js: the door at the bottom is the only
// thing in the game that calls any of this.
// ============================================================================

import { buriedNames } from './nameLedger.js';
import { loadGraveyard } from './graveyardStore.js';
import { packRecords, packRecordsJson } from './recordsFile.js';

/**
 * Everything the game remembers about its dead.
 *
 * Never throws. Both sources swallow their own storage failures and return
 * empty, so a private window exports an honest empty record rather than
 * refusing — which is also what a player who has never died should get.
 */
export function exportRecords() {
  return packRecords({ buried: buriedNames(), graves: loadGraveyard() });
}

/** The same thing as text, ready to paste. */
export function exportRecordsJson() {
  return packRecordsJson({ buried: buriedNames(), graves: loadGraveyard() });
}

// ============================================================================
// THE DOOR. Same shape as window.__tips and window.__night — a development
// handle rather than a control, and for the same reason: this is not something
// a player ever needs, and a button for it in the shipping UI is a button every
// player has to be shown past. What it is for is carrying the record to a tool
// that cannot reach this origin's localStorage, which today means the Spline
// design scene.
//
//   __dead.count()  what is in it, without printing five thousand names.
//   __dead.json()   the file, as text.
//   __dead.copy()   the same, on the clipboard, ready to paste.
//
// `copy` needs a secure origin and, in some browsers, a user gesture — so it
// hands the text back when it cannot copy rather than reporting a failure and
// keeping it. A silent failure here looks exactly like an empty graveyard on
// the far side.
// ============================================================================
if (typeof window !== 'undefined') {
  window.__dead = {
    count: () => {
      const r = exportRecords();
      return `${r.buried.length} buried · ${r.graves.length} stones standing`;
    },
    json: () => exportRecordsJson(),
    copy: async () => {
      const text = exportRecordsJson();
      try {
        await navigator.clipboard.writeText(text);
        const r = JSON.parse(text);
        return `copied — ${r.buried.length} buried, ${r.graves.length} stones`;
      } catch {
        return text;
      }
    },
  };
}
