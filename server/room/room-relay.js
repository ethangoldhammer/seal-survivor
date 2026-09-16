// ---------------------------------------------------------------------------
// THE ROOM, as logic: what a code is, who may join one, and where a message
// goes. No sockets, no Durable Object, no workerd — everything here is a pure
// function of a plain room object, so the test can exercise it with a fake
// socket that is `{ send() {} }` and nothing more.
//
// SPLIT OUT OF THE WORKER BECAUSE THE WORKER CANNOT EXPORT IT. workerd reads
// every named export of an entry module as a service definition and refuses to
// start if one isn't a handler:
//
//   Incorrect type for map entry 'MAX_MEMBERS': the provided value is not of
//   type 'function or ExportedHandler'
//
// The same reason server/playtest/run-record.js exists; see the note at the
// top of it. room-worker.js exports `default` and the Room class and nothing
// else, and everything testable lives here.
//
// THE ROOM HOLDS NO GAME STATE. It does not know what a seal is, what a score
// is, or what a snapshot contains — a match is host-authoritative and the
// relay's whole job is to carry bytes between two peers and to remember which
// two they are. That is deliberate: every piece of game knowledge added here
// is a piece that has to be kept in step with a game that changes daily, on
// a server that is deployed separately and can silently fall a version behind.
// ---------------------------------------------------------------------------

// WHAT A CODE IS lives in the protocol leaf that BOTH ENDS already share, not
// here. The join screen has to reject a malformed code without a round trip,
// and a client that re-stated the alphabet as its own regex would be one edit
// away from disagreeing with the server about which letters exist.
// Re-exported so the worker and this file's harness read as they did.
export { ALPHABET, CODE_LENGTH, newCode, normalizeCode } from '../../path/src/systems/online/protocol.js';

// ---------------------------------------------------------------------------
// MEMBERSHIP
// ---------------------------------------------------------------------------

/** Two. One host, one guest. A 1v1 match is two captains and the rest bots. */
export const MAX_MEMBERS = 2;

/**
 * How long a dropped peer's seat is held for them.
 *
 * A guest who drops mid-match hands seat 1 to the bot immediately — that is
 * the sim's own doing, not the room's (see readRemoteInput's stale branch) —
 * but the ROOM keeps their place, so a reconnect inside the window rejoins the
 * same match rather than finding a stranger in it. Thirty seconds is a tab
 * reload, a tunnel, or a wifi handover; past that they were not coming back
 * and the room should be joinable again.
 */
export const REJOIN_GRACE_MS = 30_000;

/** Names are shown to the other player, so they are bounded and stripped. */
export const MAX_NAME_LENGTH = 24;

export function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  // Control characters out first — a name is rendered into the other player's
  // lobby, and a stray newline there is a broken row rather than a rude word.
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LENGTH);
}

/**
 * A fresh room. `members` is an array and not a Map because there are two of
 * them and every operation here is "find the other one" — an index scan over
 * two entries beats a key nobody has.
 */
export function createRoom(code, now = Date.now()) {
  return { code, createdAt: now, build: null, members: [], closedAt: 0 };
}

/** The member holding `socket`, or null. */
export function memberOf(room, socket) {
  return room.members.find((m) => m.socket === socket) ?? null;
}

/** The member in a role, present or merely reserved. */
export function memberIn(room, role) {
  return room.members.find((m) => m.role === role) ?? null;
}

/**
 * Whether a room is finished with. A room whose HOST has gone past the grace
 * window is over — the host is the simulation, and there is nothing to rejoin.
 * A room with nobody in it at all is over too.
 *
 * Not "has no sockets": a host mid-reconnect has no socket and is not gone.
 */
export function roomExpired(room, now = Date.now()) {
  if (!room.members.length) return true;
  const host = memberIn(room, 'host');
  if (!host) return true;
  if (!host.socket && now - host.leftAt > REJOIN_GRACE_MS) return true;
  return false;
}

/**
 * Put a socket in a room.
 *
 * `wanted` is 'host' for a room being created and 'guest' for one being
 * joined; a reconnecting peer asks for the role it had. The build string is
 * checked against whoever got there first — the snapshot layout changes with
 * the game, and two tabs on different builds would not desync loudly, they
 * would desync quietly and look like a netcode bug.
 *
 * @returns {{ok: true, role: string, rejoined: boolean} | {ok: false, error: string}}
 */
export function joinRoom(room, { role = 'guest', name = '', build = '' } = {}, socket, now = Date.now()) {
  if (room.closedAt) return { ok: false, error: 'no_room' };

  // The first arrival sets the build every later one is measured against. An
  // empty build is only ever a harness or a hand-rolled client, and is let
  // through rather than being a third failure mode nobody will hit in play.
  if (room.build == null) room.build = build;
  else if (build && room.build && build !== room.build) return { ok: false, error: 'build_mismatch' };

  const held = memberIn(room, role);

  // A REJOIN. The seat is theirs, still within the grace window, and nobody is
  // sitting in it — take it back and keep whatever the lobby knew about them.
  if (held && !held.socket && now - held.leftAt <= REJOIN_GRACE_MS) {
    held.socket = socket;
    held.leftAt = 0;
    if (name) held.name = cleanName(name);
    return { ok: true, role, rejoined: true };
  }

  // A SEAT HELD FOR SOMEBODY WHO DID NOT COME BACK. Past the grace window the
  // reservation is over, and the room has to let the next person sit down —
  // treating an expired hold as `full` would make one dropped guest close the
  // room to everyone for as long as the object lived.
  if (held && !held.socket) room.members.splice(room.members.indexOf(held), 1);
  else if (held) return { ok: false, error: 'full' };

  if (room.members.length >= MAX_MEMBERS) return { ok: false, error: 'full' };

  room.members.push({
    role,
    name: cleanName(name),
    build,
    ready: false,
    socket,
    joinedAt: now,
    leftAt: 0,
  });
  return { ok: true, role, rejoined: false };
}

/**
 * A socket went away. The member is KEPT, with its seat reserved, so a
 * reconnect inside the window lands back in the same match; `roomExpired`
 * decides when that stops being true.
 *
 * @returns {{role: string|null, hostGone: boolean}}
 */
export function leaveRoom(room, socket, now = Date.now()) {
  const m = memberOf(room, socket);
  if (!m) return { role: null, hostGone: false };
  m.socket = null;
  m.leftAt = now;
  m.ready = false;
  return { role: m.role, hostGone: m.role === 'host' };
}

/** Drop a member's seat outright — a deliberate `leave`, not a dropped wire. */
export function removeMember(room, socket) {
  const i = room.members.findIndex((m) => m.socket === socket);
  if (i < 0) return null;
  const [m] = room.members.splice(i, 1);
  return m.role;
}

export function setReady(room, socket, ready) {
  const m = memberOf(room, socket);
  if (!m) return false;
  m.ready = !!ready;
  return true;
}

/**
 * WHERE A MESSAGE GOES: the other peer's socket, or null.
 *
 * Every relayed message is addressed this way rather than broadcast, and the
 * sender is never in the result. A relay that echoed would hand the host its
 * own snapshot back as if it were authority, which is the kind of bug that
 * looks like jitter for a week.
 */
export function routeTo(room, fromSocket) {
  const from = memberOf(room, fromSocket);
  if (!from) return null;
  const other = room.members.find((m) => m !== from && m.socket);
  return other ? other.socket : null;
}

/**
 * The lobby, as both peers see it. Sent WHOLE on every change rather than as a
 * delta: it is four fields about two people, and a full state message cannot
 * drift out of step with itself the way a stream of patches can.
 */
export function roomView(room) {
  return {
    code: room.code,
    members: room.members.map((m) => ({
      role: m.role,
      name: m.name,
      ready: m.ready,
      present: !!m.socket,
    })),
  };
}

// ---------------------------------------------------------------------------
// WHAT THE RELAY WILL CARRY
//
// The room does not parse game messages, but it does decide which ones it is
// willing to pass on, so a bug or a hand-rolled client cannot use a match as a
// general-purpose message bus between two browsers. Unknown types are dropped
// silently rather than answered — an error per frame would be worse than the
// thing it reports.
// ---------------------------------------------------------------------------

export const RELAY_TYPES = new Set(['start', 'fx', 'matchEnd', 'rematch', 'lobbyPreview']);

/** Whether a decoded control message may be passed to the other peer. */
export function relayable(type) {
  return RELAY_TYPES.has(type);
}

/**
 * Parse an incoming text frame. Anything that is not an object with a string
 * `t` is not a message — returns null, and the caller ignores it. Deliberately
 * total: a relay that throws on a malformed frame is a relay a single bad
 * client can take down for the other player.
 */
export function parseControl(raw) {
  if (typeof raw !== 'string' || raw.length > 64_000) return null;
  let msg;
  try { msg = JSON.parse(raw); } catch { return null; }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  if (typeof msg.t !== 'string') return null;
  return msg;
}
