import { CONFIG } from '../config.js';

// ---------------------------------------------------------------------------
// VERSUS — the one bit every other system may ask.
//
// A leaf on purpose: the only thing it imports is CONFIG — which arena.js,
// input.js and boats.js all import anyway — so each of them can ask "is this
// a versus run?" without pulling the whole mode (systems/versus.js, which
// imports half the game) into their graph.
//
// WHY A GATE AND NOT A CONFIG OVERRIDE. The obvious way to stage this mode is
// `CONFIG.boss.enabled = false; CONFIG.arena.widthScale = 1; ...` at boot.
// That is a trap here: the tuner snapshots WHOLE CONFIG sections into
// path/src/imported-tuning.json on any slider edit, so a match that touched
// one slider would bake every one of those overrides into the tuning
// the ordinary game plays with. So the mode never writes CONFIG. The handful
// of things it switches off — the boss clock, the spawner's tap, the crabs,
// the whale, the boats' deck guns, the oxygen drain, the arena's extra width
// — each read this flag at the call instead.
//
// Set at the press — Seal sports on the main menu, `enterMode` in main.js —
// before the run is built, and the arena is rebuilt under it when it changes,
// because the walls and the shore read it at build. It used to be a `?versus`
// URL flag read once at boot; the menu route sets the same flag and nothing
// downstream changed.
// ---------------------------------------------------------------------------

export const versusFlag = { enabled: false };

export function enableVersus(on = true) {
  versusFlag.enabled = !!on;
}

export function versusActive() {
  return versusFlag.enabled;
}

// ---------------------------------------------------------------------------
// WHAT A MATCH DOES WITHOUT — the survivor pickups a match refuses.
//
// One question asked at every spawner that pours something into the water, so
// the list of what versus goes without is readable in one place rather than
// as a `!versusActive()` scattered through four files. CONFIG.versus.drop is
// that list and carries the reasoning; this is only the read.
//
// FALSE OUTSIDE A MATCH, always: an ordinary run drops nothing, so a spawner
// can ask this unconditionally and does not need its own mode check first.
//
// @param {string} what one of the keys in CONFIG.versus.drop
// @returns true when a match is on AND that key is switched on
// ---------------------------------------------------------------------------
export function versusDrops(what) {
  if (!versusFlag.enabled) return false;
  // A missing key drops nothing. The list is a deliberate opt-in — a typo at
  // the call site should leave the water as it was, not silently switch off a
  // pickup nobody meant to touch.
  return CONFIG.versus?.drop?.[what] === true;
}

// ---------------------------------------------------------------------------
// THE MATCH SETUP — who is on which side, and in what colour. Written by the
// team select (ui/teamSelect.js) and read at the match's edges: input.js for
// which pad is player 1's, p2Pad in systems/versus.js for player 2's, the bot
// for whether a side is a CPU, and ballLook.teamColor for the goal, the seal
// rings and the HUD strip. Here, in the leaf, for the same reason the flag is.
//
// NOT CONFIG, and that is the whole point of it being here: CONFIG.versus.teams
// carries the DEFAULT colours and the tuner snapshots that whole section into
// imported-tuning.json on any slider edit, so a pick written there would ship
// as the default the next time anybody tuned a goal light. A colour chosen on
// a screen is a fact about tonight's match, not about the game.
//
// A TEAM IS `members`, up to MAX_PER_SIDE of them, and the first is the
// captain — the one who picks the colour, and today the only one who is
// driven: player 1 is `player` and player 2 is versus.js's own second body,
// and neither is a thing there are four of yet. The list is the shape a
// four-a-side match will read; nothing past index 0 is drawn or moved. A
// member is `{ kind, pad }`: kind 'human' or 'cpu', pad a Gamepad index, or
// 'keyboard' — which can only ever be on the LEFT, because input.js is
// player 1's and the keyboard is what it reads.
//
// `color` is a number (0xRRGGBB) or null for the CONFIG default.

export const MAX_PER_SIDE = 4;
export const KEYBOARD = 'keyboard';

export const versusSetup = {
  teams: [
    { color: null, members: [] },
    { color: null, members: [] },
  ],
};

/** Back to the state the team select opens on: nobody on either side. */
export function resetVersusSetup() {
  for (const t of versusSetup.teams) { t.color = null; t.members.length = 0; }
}

/** The captain of side `team`, or null when the side is empty. */
export function captainOf(team) {
  return versusSetup.teams[team]?.members[0] ?? null;
}

/**
 * Which Gamepad index drives side `team`'s captain: a number, null for the
 * keyboard or a CPU, and undefined when nothing has been set up — which is
 * the signal for the old rules (lowest index is player 1, next is player 2).
 */
export function captainPad(team) {
  const c = captainOf(team);
  if (!c) return undefined;
  return typeof c.pad === 'number' ? c.pad : null;
}

/** True when side `team`'s captain is the computer. */
export function captainIsCpu(team) {
  return captainOf(team)?.kind === 'cpu';
}
