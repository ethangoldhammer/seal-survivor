// ---------------------------------------------------------------------------
// AM I ONLINE, AND WHICH END AM I — the one question every other system asks.
//
// A LEAF, on purpose, for the same reason systems/versusFlag.js is one: the
// gates this answers end up scattered across main.js, versus.js and the seat
// loop, and each of those needs to ask without pulling the socket, the codec
// and the lobby screen into its import graph. Nothing here imports anything.
//
// WHY THE ANSWER LIVES IN ONE PLACE. A host-authoritative match is a pile of
// "not on the guest" branches — the guest does not step a seal, does not run
// the phase machine, does not decide a goal, does not spawn chum. Written as
// `roomState.role === 'guest'` at each of those, the rule would be a string
// comparison repeated thirty times, and the thirty-first would be the one
// somebody wrote as `!== 'host'` and got wrong for a lobby that had not
// connected yet. So: `netIsGuest()` and nothing else, everywhere.
//
// THE RULE THOSE GATES FOLLOW, written once so the next person adding a system
// knows which side of the line it goes on:
//
//   A function that AUTHORS authoritative match state gets its guest gate AT
//   THE FUNCTION, never at its call sites.
//
// One writer, one guard. A gate at three call sites is a gate somebody adds a
// fourth call site past, and the symptom is a guest quietly scoring its own
// goals a frame before the host's arrive.
// ---------------------------------------------------------------------------

/**
 * Where the session is. Deliberately not a boolean — "in a lobby" and "in a
 * match" are different answers, and a match that has ENDED is different again
 * from one whose wire went away, because only one of those offers a rematch.
 *
 *   off       no room; local play, exactly as it always was
 *   lobby     in a room, nobody has started anything
 *   starting  a match start has been sent or received, the world is building
 *   playing   a match is live
 *   ended     the match finished normally; a rematch is possible
 *   lost      the connection or the host went; nothing further is possible
 */
export const session = {
  phase: 'off',
  role: null,      // 'host' | 'guest' | null
  seat: -1,        // which seat THIS machine drives; -1 when offline
};

/** Seat 1. The guest is always the right-hand captain, on both machines. */
export const GUEST_SEAT = 1;

/**
 * `pad` on a remote captain's member record, beside KEYBOARD in versusFlag.js.
 *
 * A sentinel rather than a number so `seatPad()` can never hand a real pad
 * index to a seat that is being driven from another browser — two people on
 * one seal, with the local pad silently winning every frame.
 */
export const REMOTE = 'remote';

export function beginLobby(role) {
  session.role = role === 'host' ? 'host' : 'guest';
  session.seat = session.role === 'host' ? 0 : GUEST_SEAT;
  session.phase = 'lobby';
}

export function beginStarting() {
  if (session.phase === 'off') return;
  session.phase = 'starting';
}

export function beginPlaying() {
  if (session.phase === 'off') return;
  session.phase = 'playing';
}

export function endMatch() {
  if (session.phase === 'off') return;
  session.phase = 'ended';
}

/** The wire went away, or the host did. Nothing further is possible. */
export function loseSession() {
  if (session.phase === 'off') return;
  session.phase = 'lost';
}

/** Back to a local game. Called on the way out of every online path. */
export function endSession() {
  session.phase = 'off';
  session.role = null;
  session.seat = -1;
}

/** In a room at all — lobby, match, or the wreckage of one. */
export function onlineActive() {
  return session.phase !== 'off';
}

/**
 * Running the simulation. TRUE OFFLINE TOO: an ordinary local match has no
 * session and its one browser is the authority, so every "only the host does
 * this" gate reads correctly without a second `|| !onlineActive()` beside it.
 */
export function netIsHost() {
  return session.role !== 'guest';
}

/**
 * Posing somebody else's simulation. The gate that matters — see the rule in
 * the header. False offline, so a local match is untouched by any of it.
 */
export function netIsGuest() {
  return session.role === 'guest';
}

/**
 * Whether seat `seat` is driven from another browser.
 *
 * Asked by the seat loop in versus.js BEFORE the bot gate, because `botWanted`
 * reads `input.connected` and would take a remote seat back on the first frame
 * otherwise. Only ever true on the HOST: on the guest nothing is stepped at
 * all, so there is no seat for a remote input to fill.
 */
export function remoteSeat(seat) {
  return netIsHost() && onlineActive() && seat === GUEST_SEAT;
}

/** Which seat the person at this keyboard is driving. -1 when offline. */
export function localSeat() {
  return session.seat;
}
