// ============================================================================
// THE ONE JOIN BETWEEN uiText.csv AND THE BLUBBERBALL ARTBOARD.
//
// A Rive artboard is the one place in this game where a player-facing string
// can exist OUTSIDE the CSVs and outside the .js — it is a value typed into a
// file the copy gate does not read, in a tool where writing a word is the most
// natural thing to do. Left alone that is a second home for copy, and the one
// that goes stale is always the one nobody is watching.
//
// So: THE CSV OWNS THE WORDS, AND THE ARTBOARD OWNS NOTHING. Every string a
// player reads on the stats page is written here from a uiText.csv row, over
// whatever the artboard was authored with. The authored strings are lorem and
// must STAY lorem — they are what shows for the few frames before the bind
// lands, and a plausible word there is a word that can ship without anyone
// choosing it.
//
// WHY THIS SHAPE. The left-hand column is a view model property in
// rive/blubberball/data.rml; the right-hand is a uiText.csv id. Both halves are
// literals, which is the entire point:
//
//   - `uiText('statsGoals')` is matchable by tools/ui-text-test.mjs, which
//     fails on a row nothing reads and a read with no row. A loop over a table
//     of ids would pass the id in as a VARIABLE, which that test cannot match
//     to a row by anything static — and it fails the file for exactly that.
//   - the property names are matchable by tools/rive-copy-test.mjs, which fails
//     when one of them stops existing in data.rml. Rename a property in the
//     editor and the write becomes a silent no-op; that test is what turns it
//     into a red suite instead.
//
// One function, thirteen lines, and both halves of every join checkable
// without running the game.
// ============================================================================

import { uiText } from '../uiTextTable.js';

/**
 * Every label on the stats page, keyed by the view model property it is
 * written into. `mountStatsCard` spreads this over the artboard.
 *
 * Called per mount rather than held as a constant: uiText reads the table,
 * and the table can be re-imported by the CSV editor while the game is up.
 */
export function statsLabels() {
  return {
    // The four rows of the team tab, in the order they are drawn.
    goalsLabel: uiText('statsGoals'),
    assistsLabel: uiText('statsAssists'),
    savesLabel: uiText('statsSaves'),
    possessionLabel: uiText('statsPossession'),

    // The word between the two final scores.
    versusLabel: uiText('statsVersus'),

    // THE WINNER'S STAMP, beside the column that won. Only ever seen when
    // `hasWinner` is set — a draw has no stamp and therefore no line, which is
    // why this is the only row the result has left.
    //
    // THE ROW IS THE ONE THE RESULT ALWAYS HAD. `versusWinner` was the DOM
    // box's line, then the champion block's, and it is this badge's now —
    // moved twice and reminted neither time, because a new id would leave a
    // line Ethan has already written read by nothing.
    winnerLabel: uiText('versusWinner'),

    // Only ever seen when `isRecord` is set.
    recordLabel: uiText('statsRecord'),

    tabTeamLabel: uiText('statsTabTeam'),
    tabPlayersLabel: uiText('statsTabPlayers'),

    // The four column heads over the seats on the players tab.
    colName: uiText('statsColName'),
    colGoals: uiText('statsColGoals'),
    colAssists: uiText('statsColAssists'),
    colSaves: uiText('statsColSaves'),

    // THE PLAY-AGAIN PROMPT, which lives on this page now rather than in a DOM
    // panel underneath it. The three rows are the ONES IT ALREADY HAD — the
    // prompt moved, the words did not, and minting new ids for lines Ethan has
    // already written would have left the old rows read by nothing and the new
    // ones waiting on him for copy that exists.
    overTitle: uiText('versusOverTitle'),
    rematchLabel: uiText('versusRematch'),
    menuLabel: uiText('mainMenuButton'),
  };
}
