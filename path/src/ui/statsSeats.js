// ============================================================================
// WHICH ARTBOARD ROW EACH SEAL GOES IN, on the Blubberball stats page.
//
// The players tab is TWO COLUMNS OF FOUR — `player1`..`player4` down the left
// and `player5`..`player8` down the right — and a match is two equal sides, so
// the left column is one side and the right is the other. That much is the
// artboard's layout and never changes.
//
// WHAT CHANGES IS HOW MANY ROWS EACH COLUMN DRAWS. `seatsPerSide` says so, and
// a one-a-side match draws one row a side: `player1` and `player5`. Not
// `player1` and `player2` — those are both the left column.
//
// WHICH IS THE BUG THIS FILE EXISTS TO HOLD SHUT. The caller hands over a
// DENSE list in column order — the left side's seals, then the right's —
// because that is the only shape it can build without knowing the artboard's
// row count. Reading that list as "index 0..3 is the left column, 4..7 the
// right" is correct for a four-a-side and wrong for every smaller match: a
// 1v1's two seals landed in `player1` and `player2`, so the right-hand column
// drew `player5`, which had been handed nothing, and showed the lorem it was
// authored with. The name of the seal you had just played against read as
// "Lorem ipsum" on the results screen.
//
// A SEPARATE FILE, with no imports at all, because ui/statsCard.js cannot be
// imported outside a browser — it pulls in the Rive runtime and a `?url` of a
// binary — and an off-by-one in a column stride is exactly the thing a test
// should be able to catch without a GPU. See tools/rive-copy-test.mjs.
// ============================================================================

/** The seats the players tab has room for — four a side. */
export const STATS_SEATS = 8;

/** Rows in each of the two columns. */
export const STATS_PER_COLUMN = STATS_SEATS / 2;

/**
 * Where row `i` of the artboard (0-based, so `player${i + 1}`) reads from in a
 * dense column-ordered seat list.
 *
 * @param i            the artboard row, 0..STATS_SEATS-1.
 * @param seatsPerSide how many seals each side has — how many rows of each
 *                     column the artboard is drawing.
 * @returns the index into the seat list, or -1 for a row past the end of its
 *          column. A -1 row is left at its authored lorem and is not drawn.
 */
export function seatIndexForRow(i, seatsPerSide) {
  // Clamped rather than trusted: a roster bigger than the artboard has rows
  // for would otherwise read past the end of one column and into the other.
  const perSide = Math.max(1, Math.min(STATS_PER_COLUMN, Math.round(seatsPerSide ?? STATS_PER_COLUMN)));
  const column = i < STATS_PER_COLUMN ? 0 : 1;
  const nth = i % STATS_PER_COLUMN;
  if (nth >= perSide) return -1;
  return column * perSide + nth;
}
