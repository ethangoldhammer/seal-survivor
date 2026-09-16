// ============================================================================
// WHAT EACH SIDE IS CALLED — the team's name, cast once at the whistle.
//
// systems/rosterCast.js does this for a SEAT (what the seal is called, what it
// is wearing). This does it for a SIDE, and it can only run after that one has:
// a team name is built out of the kit colour its captain picked and the seals
// sitting in its seats, so it is the last thing the match knows and the first
// thing it can say about itself.
//
// WHY NOT ON THE TEAM SELECT, where the seal names are shown and re-rollable.
// Because neither half of a team name is settled while that screen is open. A
// captain walks the wheel until Start is pressed — an unpicked side is on
// whatever swatch the music has walked its light onto at the moment of the
// press (see the note on `picks` in ui/teamSelect.js) — and the seats are still
// filling, still re-rolling, still changing sides. A name shown there would be
// a name that changed under the player twice before the kickoff, or worse, one
// that stopped matching the colour it was named after.
//
// So: startVersus, after syncRosterCast and with the colours the match will
// actually play in. Every seat has a name by then and every side has a kit.
//
// THE TWO SIDES ARE CAST IN ORDER, and the second is told what the first got:
// two teams called the same thing is the one outcome this cannot be allowed to
// produce, and it is reachable — both sides can be handed a `full` name, which
// says nothing about either kit.
//
// A LEAF, like rosterCast beside it. It imports the table, the roster's
// arrangement and the cast's names, and nothing that imports it back.
// ============================================================================

import teamNamesCsv from '../teamNames.csv?raw';
import { parseTeamNameCsv, rollTeamName } from '../teamNameTable.js';
import { newNameMemory } from '../namePool.js';
import { seatsOfTeam } from './sealRoster.js';
import { seatName } from './rosterCast.js';
import { splitPlayerName } from './randomName.js';

// Parsed at module load, like every other table in the game: the file is
// static, and a parse per match would be work done to get the same answer.
// Warnings land in the console at boot, with the rest of the table warnings.
const PARTS = parseTeamNameCsv(teamNamesCsv, console.warn);

const NAME_MEMORY = newNameMemory();

// Team index → name. Empty until a match casts them.
const names = ['', ''];

/**
 * NAME BOTH SIDES. Called from startVersus with the colours the match is
 * playing in — the captain's pick, or CONFIG's default when nobody picked.
 *
 * The colours are passed rather than read, so this module never has to know
 * about versusSetup or CONFIG or the goal-colour override that sits between
 * them (ballLook.teamColor is the one place that question is answered).
 *
 * @param colors [team0, team1] as 0xRRGGBB
 * @returns the two names
 */
export function castTeamNames(colors = []) {
  for (let t = 0; t < names.length; t += 1) {
    names[t] = rollTeamName(PARTS, {
      // So the two sides of one match are not both 'the Blobz' -- and so the
      // next match does not reuse what this one just spent.
      memory: NAME_MEMORY,
      color: colors[t] ?? 0xffffff,
      members: seatsOfTeam(t).map((seat) => seatName(seat)),
      // THE OTHER SIDE'S NAME, so the second draw can walk away from it. Empty
      // on the first pass, which is the same as no constraint.
      avoid: names[t === 0 ? 1 : 0],
      // The table-aware split, so "The One and Only Osbourne" lends "Osbourne"
      // rather than every word but the last. See splitLastWord for the default.
      split: splitPlayerName,
    });
  }
  return teamNames();
}

/** What side `t` is called. '' before a match has cast, or when the table can
 *  build nothing — a caller renders the empty string rather than a placeholder,
 *  which is the same screen the game had before this existed. */
export function teamName(t) {
  return names[t] ?? '';
}

/** Both names, team-indexed. */
export function teamNames() {
  return names.slice();
}

/** Forget them — a test that wants a clean cast, or a match that never ran. */
export function resetTeamNames() {
  names[0] = '';
  names[1] = '';
}

/** The parsed table, for the harness and the labs. */
export function teamNameParts() {
  return PARTS;
}
