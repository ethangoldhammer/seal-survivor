// ---------------------------------------------------------------------------
// THE SOCKET — one WebSocket to one room, and the state of it.
//
// Knows nothing about the game. It carries frames, remembers whether it is
// connected, and measures the round trip; what the frames MEAN is netSession's
// and netSnapshot's problem. Kept that way so this file can be reasoned about
// on its own, and so a reconnect bug is never also a gameplay bug.
//
// OFFLINE IS THE DEFAULT, not a failure. `VITE_ROOM_URL` is inlined by Vite at
// BUILD time and is deliberately absent from `.env` — so `npm run dev` has no
// room server, `roomsAvailable()` is false, and the online buttons are simply
// not drawn. The same shape as systems/leaderboard.js's local board: the
// feature layers on when a backend is configured rather than the game breaking
// when one isn't. To develop against a local server, run `npx wrangler dev` in
// server/room/ and put its URL in `.env.local`.
//
// The optional chaining on `import.meta.env` is NOT optional: the Node
// harnesses import this module with no Vite, and `import.meta.env` is
// undefined there.
// ---------------------------------------------------------------------------

let ROOM_URL = (import.meta.env?.VITE_ROOM_URL ?? '').replace(/\/+$/, '');

/** Whether online play exists in this build at all. */
export function roomsAvailable() {
  return ROOM_URL.length > 0;
}

/**
 * Point the client somewhere else.
 *
 * The URL is inlined at build time and that is right for a shipped build, but
 * two things need to say it at runtime: a harness, which has no Vite and so no
 * `import.meta.env` at all, and a developer running `npx wrangler dev` who
 * wants this build to talk to localhost without a rebuild. Both are the same
 * need, so both get the same door rather than one of them getting a back one.
 *
 * Pass '' to turn online play off again.
 */
export function setRoomUrl(url) {
  ROOM_URL = (url ?? '').replace(/\/+$/, '');
  return ROOM_URL;
}

/**
 * The build both peers are measured against at the join.
 *
 * A stale tab and a fresh one do not desync loudly — the snapshot layout moves
 * with the game, and a mismatched pair would look like a netcode bug rather
 * than like one of them needing to reload. `__BUILD_ID__` is the Vite define
 * (see vite.config.js); the `typeof` guard is for the harnesses, where it does
 * not exist and a bare reference is a ReferenceError at module load.
 */
function buildId() {
  return typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev';
}

// How often the client asks the server for the time, and how many answers the
// round trip is averaged over. The ping is answered by the SERVER rather than
// bounced off the peer: this is our own liveness and half-trip to the edge, and
// a peer mid-reconnect would measure the wrong thing.
const PING_INTERVAL_MS = 2000;
const RTT_SAMPLES = 8;

// Reconnect backoff. Starts fast because the commonest disconnect is a blip,
// and gives up climbing at a few seconds because a room only lives as long as
// the grace window anyway (REJOIN_GRACE_MS in server/room/room-relay.js).
const RETRY_MIN_MS = 400;
const RETRY_MAX_MS = 4000;

/**
 * Everything a screen needs to render the connection, in one object that is
 * mutated rather than replaced — the lobby reads it every frame.
 *
 * `status` is the honest one: 'off' before anything, 'opening' while the
 * socket is coming up, 'live' once the server has answered, 'retrying' between
 * attempts, and 'lost' when it is over and nothing will be retried.
 */
export const roomState = {
  status: 'off',
  code: '',
  role: null,        // 'host' | 'guest' | null
  members: [],       // [{ role, name, ready, present }]
  error: '',         // the last error code the server gave, for the screen
  rtt: 0,            // milliseconds, averaged
  retries: 0,
};

let socket = null;
let wantOpen = false;
let retryTimer = 0;
let pingTimer = 0;
let pingId = 0;
const pingsOut = new Map();
const rttSamples = [];

const listeners = new Set();

/**
 * Every frame that arrives, as `(message, isBinary)`. Text frames are handed
 * over parsed; binary ones as the raw ArrayBuffer, because this module has no
 * business decoding a snapshot.
 *
 * @returns an unsubscribe function.
 */
export function onRoomMessage(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(msg, binary) {
  for (const fn of listeners) {
    // One bad listener must not stop the others — on the guest, a throw here
    // is a dropped frame in the middle of a match.
    try { fn(msg, binary); } catch (err) { console.warn('[room] listener failed', err); }
  }
}

/**
 * Ask the server for a code nobody is holding.
 *
 * Generated server-side rather than in the browser so the retry on a collision
 * happens once, on the side that can actually check whether a code is taken.
 *
 * @returns the code, or '' if there is no backend or it refused.
 */
export async function requestCode() {
  if (!roomsAvailable()) return '';
  try {
    const res = await fetch(`${ROOM_URL}/new`, { method: 'POST' });
    if (!res.ok) return '';
    const body = await res.json();
    return typeof body?.code === 'string' ? body.code : '';
  } catch {
    return '';
  }
}

/**
 * Open (or re-open) the socket for `code` in `role`.
 *
 * Idempotent for the same code and role, so a screen may call it freely. A
 * different code closes the old socket first — two rooms at once is not a
 * state this client has.
 */
export function joinRoom({ code, role, name = '' }) {
  if (!roomsAvailable() || !code) return false;
  if (socket && roomState.code === code && roomState.role === role) return true;
  leaveRoom();
  wantOpen = true;
  roomState.code = code;
  roomState.role = role;
  roomState.error = '';
  roomState.retries = 0;
  roomState.members = [];
  open(name);
  return true;
}

function open(name) {
  const ws = ROOM_URL.replace(/^http/, 'ws');
  const url = `${ws}/room/${encodeURIComponent(roomState.code)}`
    + `?role=${encodeURIComponent(roomState.role)}`
    + `&name=${encodeURIComponent(name)}`
    + `&build=${encodeURIComponent(buildId())}`;

  roomState.status = 'opening';
  let sock;
  try { sock = new WebSocket(url); } catch { schedule(name); return; }
  sock.binaryType = 'arraybuffer';
  socket = sock;

  sock.onopen = () => {
    if (socket !== sock) return;
    roomState.status = 'live';
    roomState.retries = 0;
    startPings();
  };

  sock.onmessage = (ev) => {
    if (socket !== sock) return;
    if (typeof ev.data !== 'string') { emit(ev.data, true); return; }
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    handle(msg);
    emit(msg, false);
  };

  sock.onclose = () => {
    if (socket !== sock) return;
    socket = null;
    stopPings();
    // A REFUSAL IS NOT A BLIP. The server closes with an error before the
    // socket ever goes live when a code is wrong, a room is full or a build is
    // stale — retrying those just asks the same question again, more slowly.
    if (!wantOpen || roomState.error) { roomState.status = roomState.error ? 'lost' : 'off'; return; }
    schedule(name);
  };

  sock.onerror = () => { /* onclose follows; nothing useful to add here */ };
}

function schedule(name) {
  if (!wantOpen) return;
  roomState.status = 'retrying';
  roomState.retries += 1;
  const wait = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (roomState.retries - 1));
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { if (wantOpen) open(name); }, wait);
}

/** What this module itself acts on. Everything is passed to listeners too. */
function handle(msg) {
  switch (msg.t) {
    case 'room':
      roomState.members = Array.isArray(msg.members) ? msg.members : [];
      if (msg.you) roomState.role = msg.you;
      roomState.error = '';
      break;
    case 'error':
      // Held so `onclose` can tell a refusal from a dropped wire.
      roomState.error = typeof msg.code === 'string' ? msg.code : 'unknown';
      break;
    case 'pong': {
      const at = pingsOut.get(msg.id);
      pingsOut.delete(msg.id);
      if (at == null) break;
      rttSamples.push(now() - at);
      while (rttSamples.length > RTT_SAMPLES) rttSamples.shift();
      roomState.rtt = Math.round(rttSamples.reduce((a, b) => a + b, 0) / rttSamples.length);
      break;
    }
    default:
      break;
  }
}

function startPings() {
  stopPings();
  pingTimer = setInterval(() => {
    if (!socket || socket.readyState !== 1) return;
    const id = (pingId = (pingId + 1) & 0xffff);
    pingsOut.set(id, now());
    // An answer that never comes must not accumulate: anything older than a
    // few intervals is a lost ping, not a slow one.
    if (pingsOut.size > RTT_SAMPLES * 2) pingsOut.clear();
    send({ t: 'ping', id });
  }, PING_INTERVAL_MS);
}

function stopPings() {
  clearInterval(pingTimer);
  pingTimer = 0;
  pingsOut.clear();
}

/** A JSON control frame. Silently dropped when there is no live socket. */
export function send(msg) {
  if (!socket || socket.readyState !== 1) return false;
  try { socket.send(JSON.stringify(msg)); return true; } catch { return false; }
}

/**
 * A binary frame — input or a snapshot.
 *
 * DROPPED RATHER THAN QUEUED when the socket is not live. These are the two
 * per-frame message types, and a queue of them is a queue of stale positions:
 * on reconnect the guest wants the NEXT snapshot, never the one from before
 * the wire went away.
 */
export function sendBinary(buf) {
  if (!socket || socket.readyState !== 1) return false;
  try { socket.send(buf); return true; } catch { return false; }
}

/** Tell the room we are ready, and remember it locally for the screen. */
export function setReady(ready) {
  return send({ t: 'ready', ready: !!ready });
}

/** Leave for good. Not a drop — the seat is given up rather than reserved. */
export function leaveRoom() {
  wantOpen = false;
  clearTimeout(retryTimer);
  stopPings();
  if (socket) {
    send({ t: 'leave' });
    try { socket.close(1000, 'left'); } catch { /* already gone */ }
  }
  socket = null;
  roomState.status = 'off';
  roomState.code = '';
  roomState.role = null;
  roomState.members = [];
  roomState.rtt = 0;
  roomState.retries = 0;
  rttSamples.length = 0;
}

/** Whether the socket is up right now. */
export function roomLive() {
  return !!socket && socket.readyState === 1;
}

/** The other person in the room, or null. */
export function peer() {
  return roomState.members.find((m) => m.role !== roomState.role) ?? null;
}

function now() {
  return (globalThis.performance?.now?.() ?? Date.now());
}
