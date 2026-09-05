// ============================================================================
// DRAFT COPY — the one definition of "this line is a placeholder".
//
// Read by tools/copy-check.mjs (the ship gate) and by tools/csv-editor.mjs
// (the amber flag on the row), so the gate and the flag cannot disagree about
// which rows are waiting. Two copies of this rule is two rules, and the one
// that drifts is always the one you were relying on.
//
// The flag is DERIVED from the copy, never stored in a column of its own. A
// stored flag is a second source of truth that goes stale the moment a line is
// rewritten and the TRUE is left behind — and a row that claims to be a draft
// after you have written it is exactly as bad as one that doesn't. Edit out the
// lorem and the flag is gone, because the flag WAS the lorem.
// ============================================================================

// Two independent tells, because each catches what the other misses.
//
// The wordlist catches lorem pasted in with no marker. The marker catches a
// draft written in real English — a UI label where lorem would make the
// control untestable — which no wordlist could ever tell from finished copy.
export const DRAFT_PATTERN =
  '\\[DRAFT\\]|\\b(lorem|ipsum|dolor sit|consectetur|adipiscing|eiusmod|tempor|incididunt)\\b';

export const DRAFT_RE = new RegExp(DRAFT_PATTERN, 'i');

export const isDraft = (value) => DRAFT_RE.test(String(value ?? ''));

// A SECOND, INDEPENDENT DETECTOR — read off the BRIEF rather than off the copy.
//
// The lorem rule exists because a plausible placeholder is exactly what
// survives a review and ships by accident, and that is not a hypothetical: two
// `shot` leads went in as "Shot Down" and "Sealed with a Kiss", with the brief
// written correctly in `notes` and the word "lorem" nowhere but the row id.
// They read as finished copy, the gate saw nothing, and they were one green
// suite away from shipping in a voice that is not Ethan's.
//
// So a brief that opens with NEEDS YOUR WORDS flags its row on its own. It
// cannot be defeated by writing convincing English in the copy cell, because it
// never looks at the copy cell — and it clears the same way everything else
// here does: when the line is written, the brief goes with it.
// As a PATTERN as well as a regex, because the CSV editor rebuilds it in the
// browser — the same handover `DRAFT_PATTERN` already gets. One definition, so
// the amber stripe in the editor and the suite that blocks the deploy cannot
// come to different conclusions about the same row.
export const BRIEF_PATTERN = '^\\s*NEEDS YOUR WORDS\\b';

export const BRIEF_RE = new RegExp(BRIEF_PATTERN, 'i');

export const hasOpenBrief = (notes) => BRIEF_RE.test(String(notes ?? ''));

// The columns a player actually reads, by bare filename.
//
// `notes` is deliberately absent from every one of these: notes is where the
// BRIEF for a draft line is written, so it is allowed to say "lorem" all day
// long without flagging the row it explains.
export const COPY_COLUMNS = {
  // `weaponName` is prose the same way `name` is — it renames the gun on the
  // HUD and in the score screen's ledger for as long as the card is held, so a
  // player reads it. It was missing here until André 3000 stopped piercing
  // anything and its "Piercing Pebbles" went stale with nothing able to say so.
  // ...and `weaponNameLaser` beside it, which is the same string on the other
  // loadout. Listed the moment the column existed rather than the first time a
  // stale line was noticed in it — which is how `weaponName` got here, one
  // gone-stale name too late.
  'upgrades.csv': ['name', 'desc', 'weaponName', 'weaponNameLaser'],
  'tips.csv': ['label', 'desc'],
  'callouts.csv': ['text', 'textTouch', 'textPad'],
  'epitaphs.csv': ['text'],
  'greetings.csv': ['text'],
  'kickers.csv': ['text'],
  'quips.csv': ['text'],
  'bossNames.csv': ['text'],
  'sealNames.csv': ['text'],
  'rarities.csv': ['name'],
  // Every word {effect} can say. `template` is prose too — it is the shape of
  // the phrase, not a format string the game depends on.
  'statText.csv': ['label', 'plural', 'unlock', 'template'],
  // The screen labels that belong to no other table — a row heading over a
  // measurement, an option name in the pause menu, the word after a kill
  // count. They were string constants in four .js files, which meant the one
  // place they could be written was a source file and the editor's "needs your
  // words" chip could not see them. See path/src/uiTextTable.js.
  'uiText.csv': ['text'],
  // The requirement line on a locked card or accessory — what the player has
  // to do to earn it. Prose, read on a tile or a toast.
  'unlocks.csv': ['label'],
};

// Is this column one a player reads? Accepts a bare name or a repo path.
export function isCopyColumn(file, column) {
  return (COPY_COLUMNS[file.split('/').pop()] || []).includes(column);
}

// ---------------------------------------------------------------------------
// REVIEW — the other half of the rule, for copy that is ALREADY SHIPPING.
//
// The lorem flag above is derived, because a placeholder announces itself. This
// one cannot be: "has Ethan read this line and kept it?" is a fact about a
// person, not about the text, and there is nothing in the words to derive it
// from. So it is a stored column, and the one case where a stored flag is the
// honest answer rather than a stale one.
//
// `review` is TRUE while a line is waiting on him and blank once it is his.
// Blank is the DEFAULT for a good reason: a row added later with no value is a
// row he typed himself, which is confirmed by definition. A line staged by
// Claude arrives as lorem and is caught by the gate above instead.
//
// It does not block a ship. These lines already ship and are already fine —
// what they lack is a record of whose they are. A gate over 637 rows would
// only teach the habit of passing --no-verify, which would disable the lorem
// gate that does matter.
export const REVIEW_COLUMN = 'review';

export const needsReview = (row) =>
  String(row?.[REVIEW_COLUMN] ?? '').trim().toLowerCase() === 'true';
