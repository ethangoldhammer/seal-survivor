// ============================================================================
// UI TEXT TABLE — the screen labels that belong to no other table, in
// uiText.csv.
//
// Ten tables already hold the game's writing: the boss's name, the line you
// read when you die, what a card is called, every word {effect} can say. What
// had no table was the CHROME — the row heading over a measurement, the word
// after a kill count, the name of an option in the pause menu. Those lived as
// string constants in ui.js, settings.js, upgradeTip.js and config.js, which
// meant the one place they could be written was a .js file, and the CSV
// editor's "needs your words" chip — the whole point of which is that it
// gathers every outstanding line onto one screen — could not see them. A line
// waiting in a file the writer never opens is a line that ships as staged.
//
// So they are a spreadsheet now, on exactly the terms the other ten are:
// `tools/draft-copy.mjs` lists this file's `text` column as copy, so the amber
// stripe in the editor, `npm run test:copy` and `npm run copy:review` all pick
// it up with no further wiring.
//
// WHAT BELONGS HERE. A string a player reads that is not already owned by a
// table beside the thing it describes. An upgrade's name is upgrades.csv's; a
// warning is callouts.csv's; the heading over the fin split on the score
// screen was nobody's, and is this file's. When in doubt the test below is
// "would Ethan go looking for it in a table?" — not "is it a string?".
//
// WHAT DOES NOT. Anything the game reads as a VALUE: an id, a css class, a
// key name. This table is read for display and nothing joins on its contents.
//
// Columns:
//   id      what the code asks for. The join, never shown to anyone.
//   text    the line. This is the column a player reads.
//   review  whether the wording still wants Ethan's eye (see CLAUDE.md).
//   group   which surface the line is on. Cosmetic — it orders the editor's
//           rows and keeps the file readable.
//   notes   the brief: what the line has to convey, how long it can be, when
//           the player sees it. Nothing reads it.
// ============================================================================

import { parseIdTable } from './csvTable.js';
import uiTextCsv from './uiText.csv?raw';

const LABEL = 'uiText';
const FILE = 'uiText.csv';

export function parseUiTextCsv(text, warn = console.warn) {
  const rows = parseIdTable(text, LABEL, FILE, warn);
  const out = {};
  for (const [id, row] of rows) {
    const line = (row.text ?? '').trim();
    // A row with an id and no words is the one case worth refusing. Keeping it
    // would put an empty string on screen — a heading that renders as nothing
    // reads as a layout bug, and would be chased as one.
    if (!line) {
      warn(`[${LABEL}] "${id}" has no text — the label would render blank. Row ignored.`);
      continue;
    }
    out[id] = line;
  }
  return out;
}

export const UI_TEXT = parseUiTextCsv(uiTextCsv);

// Ask for a line by id.
//
// A MISSING ROW RETURNS THE ID, which is deliberate and is the same argument
// the lorem rule makes: an unmistakable placeholder is safe and a tasteful one
// is not. Returning '' would put a blank where a heading goes and read as a
// layout bug; returning some fallback English would be a label nobody wrote
// quietly shipping. `finPanelTitle` on the score screen is neither, and it
// names the row to add.
//
// The warning fires once per id rather than once per read — these are called
// from render paths, and a hover that logs sixty lines a second buries
// whatever else the console was trying to say.
const warned = new Set();

export function uiText(id) {
  const line = UI_TEXT[id];
  if (line) return line;
  if (!warned.has(id)) {
    warned.add(id);
    console.warn(`[${LABEL}] no row for "${id}" in ${FILE} — showing the id. Add the row.`);
  }
  return id;
}
