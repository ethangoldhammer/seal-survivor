// ============================================================================
// WHO IS IN EACH SEAT — the roster's other column: what the seal is called and
// what it is wearing.
//
// systems/sealRoster.js owns the ARRANGEMENT (how many seats, whose side each
// is on, who is driving it). This owns the one thing about a seat that is not
// arithmetic: what to call the seal sitting in it.
//
// SEAT 0 IS THE PLAYER'S OWN NAME, and that is the whole reason this module
// exists. The name on the splash — rolled off sealNames.csv or typed into the
// field, saved by systems/playerName.js — is the name this person has already
// chosen for themselves once tonight, and a match that then called them
// something else on the goal card was throwing that away and asking the
// question again in silence. versus.js used to roll every seat at kickoff,
// including that one.
//
// EVERY OTHER SEAT IS ROLLED, and is RE-ROLLABLE: the team select gives each
// of them a dice, because the seal beside you and the three the computer is
// bringing are cast members, and a cast you cannot re-cast is a cast you are
// stuck with. Seat 0 has no dice here on purpose — that name is changed on
// the splash, where it is saved, and a second place to change it would be two
// sources of truth for one string.
//
// THE NAMES ARE PICKED BEFORE THE MATCH, not at kickoff, because the team
// select SHOWS them: a name that appeared for the first time on the goal card
// is a name nobody chose. startVersus asks for whatever the screen settled on
// (syncRosterCast fills any seat the roster grew into since).
//
// WHAT IT WEARS is the second column, and seat 0's is a POINTER rather than a
// value. The player's accessory is one slot — CONFIG.accessories.equipped —
// written by the drawer on the main menu and remembered between sessions, and a
// second copy of it here would be a second answer to "what is the player
// wearing" that goes stale the moment either screen is used. So seat 0 reads
// and writes that slot, and every other seat has one of its own, kept here,
// meaning nothing outside a match.
//
// EVERY SEAT OPENS BARE. Not rolled: an accessory is a choice, and a CPU that
// turned up in a different hat every match would read as the game shuffling
// something rather than as a cast you dressed.
//
// A LEAF ON THE NAME TABLE, not on the match: ui/teamSelect.js and
// systems/versus.js both read it and neither imports the other.
// ============================================================================

import { rosterSize } from './sealRoster.js';
import { playerName } from './playerName.js';
import { randomPlayerName } from './randomName.js';
import { accessoryRoster, cycleAccessory, wornAccessory, accessoryUnlocked } from './accessories.js';

// Seat index → name. Sparse only at the end: syncRosterCast fills it up to
// the roster's size and leaves anything past that alone, so shrinking the
// roster and growing it back gets the same cast rather than a fresh one.
const names = [];

// Seat index → accessory key, '' for bare. Seat 0's entry is never used — see
// the header: that seat is the player's own slot, wherever it is.
const kit = [];

// Enough draws that a four-a-side roster off a few hundred combinations
// practically never collides out, and cheap enough to run on a button press.
const TRIES = 24;

/**
 * A name no other seat is already using. randomPlayerName's `avoid` takes one
 * string — the right contract for "not the same name twice in a row" and the
 * wrong one for "not any of these seven" — so the set is checked here, with a
 * bounded loop for the same reason the buried check inside it has one.
 */
function freshName(taken) {
  let last = '';
  for (let i = 0; i < TRIES; i += 1) {
    const name = randomPlayerName(last);
    if (!taken.has(name)) return name;
    last = name;
  }
  // Every draw collided. Handed back anyway: two seals with one name is a
  // cosmetic problem and an empty slot is a broken screen.
  return randomPlayerName(last);
}

/**
 * Fill every seat the roster currently has. Seat 0 is re-read from
 * playerName() each time — the splash may have been visited since — and the
 * rest keep whatever they were given.
 *
 * @returns the names, seat-indexed
 */
export function syncRosterCast() {
  const n = rosterSize();
  names[0] = playerName();
  const taken = new Set([names[0]]);
  for (let i = 1; i < n; i += 1) {
    if (names[i] && !taken.has(names[i])) { taken.add(names[i]); continue; }
    names[i] = freshName(taken);
    taken.add(names[i]);
  }
  return rosterNames();
}

/** What seat `i` is called. '' for a seat the roster does not have. */
export function seatName(i) {
  return names[i] ?? '';
}

/**
 * Re-roll seat `i`. Refused for seat 0, which is the player's own name and
 * belongs to the splash — see the header. Returns the name the seat ends up
 * with either way, so a caller can render the answer rather than assume it.
 */
export function rollSeatName(i) {
  if (!(i > 0)) return seatName(i);
  const taken = new Set(names.filter((n, k) => k !== i && n));
  names[i] = freshName(taken);
  return names[i];
}

/** Every seat's name, seat-indexed, clipped to the roster. */
export function rosterNames() {
  return names.slice(0, rosterSize());
}

/** Forget the cast — a new session, or a test that wants a clean roll. */
export function resetRosterCast() {
  names.length = 0;
  kit.length = 0;
}

// ---------------------------------------------------------------------------
// WHAT EACH SEAT WEARS
// ---------------------------------------------------------------------------

/**
 * The accessory key seat `i` has on, or '' for bare.
 *
 * Seat 0 is the PLAYER'S SLOT, read through wornAccessory() so it answers the
 * same as the seal in every other part of the game — including the guard there
 * that hands back bare when the slot holds something not yet unlocked.
 *
 * Every other seat is checked against the same lock on the way out rather than
 * only on the way in: an accessory can become locked between matches (the gate
 * switch, a cleared ledger), and a seat holding a key it may no longer wear
 * should turn up bare rather than wearing it anyway.
 */
export function seatAccessory(i) {
  if (!(i > 0)) return wornAccessory();
  const key = kit[i] ?? '';
  return key && accessoryUnlocked(key) ? key : '';
}

/**
 * Step seat `i` through the ring — bare, then everything unlocked, in config
 * order. `dir` is +1 or -1.
 *
 * SEAT 0 GOES THROUGH cycleAccessory, which is the same function the main
 * menu's drawer spends, so cycling the player here writes the one slot and is
 * remembered. The others turn their own entry, and the ring is built the same
 * way so the two controls step through the same list in the same order.
 *
 * @returns the key that seat is now wearing.
 */
export function cycleSeatAccessory(i, dir = 1) {
  if (!(i > 0)) return cycleAccessory(dir);
  const ring = ['', ...accessoryRoster(true)];
  const at = ring.indexOf(seatAccessory(i));
  const step = dir >= 0 ? 1 : -1;
  kit[i] = ring[(((at < 0 ? 0 : at) + step) % ring.length + ring.length) % ring.length];
  return kit[i];
}

/** Every seat's accessory, seat-indexed, clipped to the roster. For the harness. */
export function rosterKit() {
  const out = [];
  for (let i = 0; i < rosterSize(); i++) out.push(seatAccessory(i));
  return out;
}
