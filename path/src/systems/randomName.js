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
import { MAX_NAME_LEN } from './playerName.js';
import { isNameBuried } from './nameLedger.js';

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
  // THE DEAD ARE NOT OFFERED. Death is permanent (systems/nameLedger.js), so a
  // button that hands back a name the player has already buried is offering
  // them something the game will then refuse — the worst kind of control,
  // because it looks like it worked.
  //
  // A BOUNDED LOOP AND NOT rollSealName's `avoid`, which takes one string and
  // rerolls once. That is the right contract for "don't hand me the same name
  // twice in a row" and the wrong one for "don't hand me any of four hundred".
  for (let i = 0; i < ROLL_TRIES; i += 1) {
    const name = rollSealName(PARTS, { avoid: current });
    if (!isNameBuried(name)) return name;
  }

  // THE TABLE IS EXHAUSTED — every name it can build is already on a stone.
  // Reachable, and by a real player rather than a theoretical one: two dozen
  // adjectives against two dozen nicknames is a few hundred seals, and this
  // record never forgets.
  //
  // A LINEAGE RATHER THAN A FAILURE. Refusing to roll would leave the button
  // dead and the player stuck on the one screen that has to get them back into
  // a game, and a random suffix would be a serial number. "Fat Tony II" is what
  // a graveyard full of one family actually looks like, and it is the only
  // answer here that gets funnier the deeper into it you are.
  const base = rollSealName(PARTS, { avoid: current });
  for (const numeral of NUMERALS) {
    const candidate = `${base} ${numeral}`;
    if (candidate.length <= MAX_NAME_LEN && !isNameBuried(candidate)) return candidate;
  }
  // Past the end of the line. Handed back anyway rather than looping forever:
  // the caller's own check is what stops it being used, and a button that
  // returns nothing is a button that appears broken.
  return base;
}

// How many draws before the table is called exhausted. High enough that a
// nearly-full table still finds its last few names — at 400 combinations with
// 390 buried, forty draws finds one about two thirds of the time — and low
// enough to be free on the frame a player presses the button.
const ROLL_TRIES = 40;

// II to XX. Not 2-20: this is a headstone, and a headstone that says "Fat Tony
// 4" is a spreadsheet row. Stops at twenty because a name is capped at
// MAX_NAME_LEN anyway and "Fat Tony XVIII" is already most of it.
const NUMERALS = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
  'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'];

/** The parsed table, for tools and tests that want to count what is in it. */
export function sealNameParts() {
  return PARTS;
}
