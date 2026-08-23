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

// The columns a player actually reads, by bare filename.
//
// `notes` is deliberately absent from every one of these: notes is where the
// BRIEF for a draft line is written, so it is allowed to say "lorem" all day
// long without flagging the row it explains.
export const COPY_COLUMNS = {
  'upgrades.csv': ['name', 'desc'],
  'tips.csv': ['label', 'desc'],
  'callouts.csv': ['text', 'textTouch', 'textPad'],
  'epitaphs.csv': ['text'],
  'greetings.csv': ['text'],
  'kickers.csv': ['text'],
  'quips.csv': ['text'],
  'bossNames.csv': ['text'],
  'sealNames.csv': ['text'],
  'rarities.csv': ['name'],
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
