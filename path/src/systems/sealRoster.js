// ============================================================================
// THE ROSTER — how many seals are on the pitch, whose side each is on, and
// which of them a person is driving.
//
// Blubberball was two seals: `player` and versus.js's own second body, and
// every rule in the match was written as a pair. "Player 2" appeared as an
// index, as a team, as a colour and as the other end of a collision, and those
// are four different things that happened to be the same number while there
// were only two of them. This is where they stop being the same number.
//
// A SEAT, NOT A SEAL. Everything here is about the SEAT — index 0 is the seal
// holding the frame and is always a person, the rest are seats a person or the
// computer sits in. versus.js owns the bodies; this owns the arrangement, and
// it is a leaf like versusFlag.js so the team select, the bot and the harness
// can all ask about the arrangement without pulling the match in.
//
// SIDES ALTERNATE, and that is not arbitrary. Seat 0 is team 0, seat 1 is team
// 1, seat 2 is team 0 again — so the FIRST TWO SEATS of any roster are the two
// captains, which is exactly the match Blubberball already was. Growing the
// roster adds seats on the end and cannot move the two that were already
// there: a 1v1 is a 4-a-side match with six empty seats, not a different mode.
//
// WHY THE SIZE IS LIVE. Whether eight seals on a pitch tuned for two is a
// scramble or a mess is not a question anybody can answer by reading the
// code — the kickoff spots, the arena's width and the ball's own contest were
// all tuned against one seal a side. So `setRosterSize` is a runtime control
// (the team select's roster row, and CONFIG.versus.roster.perSide as the
// default it opens on) rather than a constant somebody has to rebuild to try.
// ============================================================================

import { CONFIG } from '../config.js';
import { versusSetup, MAX_PER_SIDE, KEYBOARD } from './versusFlag.js';

export const TEAMS = 2;

// How many seats each side has RIGHT NOW. Clamped to MAX_PER_SIDE, which is
// what versusSetup's member lists are sized for.
let perSide = 1;

// True once anything has actually PICKED a roster this session. Without it
// resetRoster cannot tell "nobody has chosen, open on the config default" from
// "the team select chose one a side" — and it would quietly undo the second on
// its way into the match, which is exactly what it did.
let chosen = false;

/** Seats per side, 1..MAX_PER_SIDE. */
export function rosterPerSide() {
  return perSide;
}

/** Every seat in the match, in seat order. */
export function rosterSize() {
  return perSide * TEAMS;
}

/**
 * Set the roster and hand back what it actually became — clamped, and never
 * below one a side, because a match with an empty team is not a match. The
 * caller re-reads rather than assuming, so a request for six a side on a build
 * that allows four is visibly four and not silently ignored.
 */
export function setRosterSize(n) {
  perSide = Math.max(1, Math.min(MAX_PER_SIDE, Math.round(n) || 1));
  chosen = true;
  return perSide;
}

/**
 * The size a match should open on: whatever was PICKED this session, and
 * CONFIG's default only while nothing has been. A match must not undo the
 * roster row on its way in, which is what a plain "back to the default" did.
 */
export function resetRoster() {
  if (chosen) return perSide;
  perSide = Math.max(1, Math.min(MAX_PER_SIDE, Math.round(CONFIG.versus?.roster?.perSide ?? 1) || 1));
  return perSide;
}

/** Forget the pick — a new session, or a test that wants CONFIG's answer. */
export function forgetRoster() {
  chosen = false;
  return resetRoster();
}

/** Has anything picked a roster this session? For the harness. */
export function rosterChosen() {
  return chosen;
}

/**
 * WHOSE SIDE SEAT `i` IS ON. Alternating, so the first two seats are the two
 * captains — see the note above. This is the one place the mapping lives; a
 * `who % 2` written out at a call site is the bug this function exists to stop
 * (it is right today and wrong the moment seats stop alternating).
 */
export function teamOfSeat(i) {
  return i % TEAMS;
}

/** Every seat on side `team`, in seat order. Seat 0 of a side is its captain. */
export function seatsOfTeam(team) {
  const out = [];
  for (let i = 0; i < rosterSize(); i++) if (teamOfSeat(i) === team) out.push(i);
  return out;
}

/** True when these two seats are on the same side. */
export function sameTeam(a, b) {
  return teamOfSeat(a) === teamOfSeat(b);
}

/**
 * The team select's answer for seat `i`, or null when it never said. `members`
 * is per SIDE, so seat 2 is that side's second member — the arithmetic is here
 * rather than at the three call sites that used to do it by hand.
 */
export function memberOfSeat(i) {
  const team = teamOfSeat(i);
  const nth = Math.floor(i / TEAMS);
  return versusSetup.teams[team]?.members[nth] ?? null;
}

/**
 * IS THIS SEAT THE COMPUTER'S? Seat 0 never is — it is the seal the frame
 * belongs to and the one input.js drives. Any other seat is the computer's
 * unless the team select put a person in it, which is the honest default: a
 * roster grown past the people in the room is a roster of bots, and the
 * alternative is a seal standing still in the water.
 */
export function seatIsCpu(i) {
  if (i === 0) return false;
  const m = memberOfSeat(i);
  return !m || m.kind !== 'human';
}

/**
 * The Gamepad index driving seat `i`: a number, KEYBOARD, or null for a seat
 * nobody is on. Seat 0 is input.js's and is not asked about here.
 */
export function seatPad(i) {
  const m = memberOfSeat(i);
  if (!m || m.kind !== 'human') return null;
  return m.pad ?? null;
}

/**
 * WHERE SEAT `i` STARTS, as a share of the pitch: how far in from its own
 * goal, and how far off the middle of the water. Seat 0 of a side takes the
 * spot the captain always had; the rest fan out behind it, alternating above
 * and below so a side is a formation rather than a queue.
 *
 * Returned as SHARES rather than world units on purpose — the arena is
 * rebuilt at a different width for a match, and the caller is the one holding
 * the bounds. See kickoffSpot in systems/versus.js.
 */
export function seatFormation(i) {
  const nth = Math.floor(i / TEAMS);
  const r = CONFIG.versus?.roster ?? {};
  const back = (r.rowStep ?? 0.16) * nth;
  // 0, +1, -1, +2, -2… so the captain is on the line and the rest bracket it.
  const rank = Math.ceil(nth / 2) * (nth % 2 === 1 ? 1 : -1);
  return { back, lane: rank * (r.laneStep ?? 0.34) };
}

/** For the team select and the harness: every seat, with who is in it. */
export function rosterSeats() {
  const out = [];
  for (let i = 0; i < rosterSize(); i++) {
    out.push({
      seat: i,
      team: teamOfSeat(i),
      cpu: seatIsCpu(i),
      pad: seatPad(i),
      captain: i < TEAMS,
    });
  }
  return out;
}

export { MAX_PER_SIDE, KEYBOARD };
