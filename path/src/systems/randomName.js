// THE RANDOMISE BUTTON'S ONE FUNCTION.
//
// sealNames.csv is parsed once, here, and spent by whatever surface has a name
// field on it — today that is the splash (ui/riveSplash.js, driven by the
// artboard's `tRandomizeName` trigger). The table itself knows nothing about
// files or storage; see path/src/sealNameTable.js for what the columns mean.
//
// A module of its own rather than a function inside riveSplash.js, because the
// splash is not the only place a name gets typed — the game-over card has a
// field too — and the second surface to want a dice button should reach for
// this rather than parse the table again.
//
// Deliberately NOT part of systems/playerName.js. That module is imported by
// callouts.csv, quips.csv and upgrades.csv to spend the {player} token, and
// none of them has any use for a table of names — importing this from there
// would put the whole vocabulary in the text layer's dependency graph to
// answer a question the text layer never asks.

import sealNamesCsv from '../sealNames.csv?raw';
import { parseSealNameCsv, rollSealName } from '../sealNameTable.js';

// Parsed at module load, like every other table in the game: the file is
// static, and a parse per button press would be work done to get the same
// answer. Warnings land in the console at boot, which is where the rest of the
// table warnings are.
const PARTS = parseSealNameCsv(sealNamesCsv, console.warn);

/**
 * A name for the field. `current` is what is already in it — pass it, and a
 * press that would have handed back the same name rolls once more instead.
 *
 * Never blank, never longer than the field holds, and never containing a
 * character the leaderboard would strip. See sealNameTable.js.
 */
export function randomPlayerName(current = '') {
  return rollSealName(PARTS, { avoid: current });
}

/** The parsed table, for tools and tests that want to count what is in it. */
export function sealNameParts() {
  return PARTS;
}
