// ---------------------------------------------------------------------------
// BLUBBERBALL ROOMS — a Cloudflare Worker plus one Durable Object per room
// code, so two people on two machines can play the same match.
//
// WHAT IT IS NOT: a game server. It never simulates anything. A match is
// HOST-AUTHORITATIVE — one player's browser runs the real sim, the other sends
// input and poses from the snapshots it gets back — and this carries the bytes
// between them and remembers which two browsers are in the room. That is the
// whole job, and keeping it the whole job is what lets the game change every
// day without the server falling a version behind it.
//
// WHY A DURABLE OBJECT AND NOT KV, unlike the two workers next door. A room is
// a rendezvous: two sockets have to end up in the same place, and KV has no
// place for them to be. `idFromName(code)` is the whole mechanism — the code
// IS the object's identity, so there is no lookup table to keep, no race
// between two joiners, and nothing to clean up when a room is over. The
// leaderboard worker's header already called this out as the upgrade path.
//
// THE ROOM IS DERIVED FROM ITS SOCKETS, not stored beside them. Membership is
// rebuilt on every wake from `getWebSockets()` and each socket's attachment,
// so hibernation costs nothing to support and there is no second copy of the
// truth to fall out of step. The only thing in storage is a seat RESERVATION —
// see `reserve` below — because a socket that has gone is exactly the case
// where the sockets can no longer tell you who was there.
//
// HIBERNATION IS NOT OPTIONAL. `state.acceptWebSocket` plus the
// `webSocketMessage`/`webSocketClose` handlers below, rather than
// `ws.addEventListener('message')`, is what lets the object sleep between
// messages — and a lobby sitting open while two people pick colours is most of
// a room's lifetime. Retrofitting it later means rewriting this file.
//
// THIS MODULE EXPORTS `default` AND THE `Room` CLASS AND NOTHING ELSE. workerd
// reads every named export of an entry module as a service definition and
// refuses to boot if one is not a handler, so everything testable lives in
// room-relay.js. See the note at the top of that file.
// ---------------------------------------------------------------------------

import {
  REJOIN_GRACE_MS,
  cleanName,
  createRoom,
  joinRoom,
  leaveRoom,
  memberOf,
  newCode,
  normalizeCode,
  parseControl,
  relayable,
  removeMember,
  roomView,
  routeTo,
  setReady,
} from './room-relay.js';

// How many codes `/new` will try before giving up. Collisions are vanishingly
// rare at 6.4M codes and a handful of live rooms; this exists so a bug that
// somehow made every code taken fails fast instead of spinning.
const CLAIM_ATTEMPTS = 5;

// A room with nothing in it is swept after this. Long enough that a host who
// opened a code and went to find their phone still has it; short enough that
// an abandoned room is not an object sitting in the account overnight.
const EMPTY_ROOM_MS = 15 * 60 * 1000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);

    // A FREE CODE. Generated here rather than in the browser so the retry on a
    // collision happens once, on the side that can actually check.
    if (url.pathname === '/new' && request.method === 'POST') {
      for (let i = 0; i < CLAIM_ATTEMPTS; i += 1) {
        const code = newCode();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const res = await stub.fetch(new Request(`https://room/claim?code=${code}`, { method: 'POST' }));
        if (res.ok) return json({ code }, 200, origin);
      }
      return json({ error: 'no_code' }, 503, origin);
    }

    // THE SOCKET. `/room/<code>` upgrades and hands the whole connection to
    // that code's object; everything after this point is the Room class.
    const m = url.pathname.match(/^\/room\/([^/]+)$/);
    if (m) {
      const code = normalizeCode(decodeURIComponent(m[1]));
      if (!code) return json({ error: 'bad_code' }, 400, origin);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      const inner = new URL(request.url);
      inner.pathname = '/ws';
      inner.searchParams.set('code', code);
      return stub.fetch(new Request(inner, request));
    }

    return json({ error: 'not found' }, 404, origin);
  },
};

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/claim') {
      const claimed = await this.state.storage.get('createdAt');
      const live = this.state.getWebSockets().length > 0;
      // A code is free if nobody is holding it and nothing reserved it
      // recently. `claimed` alone is not enough — the object outlives the
      // match, and a code that could never be reused would leak the space.
      if (claimed && (live || Date.now() - claimed < EMPTY_ROOM_MS)) {
        return new Response('taken', { status: 409 });
      }
      await this.state.storage.deleteAll();
      await this.state.storage.put('createdAt', Date.now());
      await this.state.storage.put('code', url.searchParams.get('code') ?? '');
      return new Response('ok');
    }

    if (url.pathname !== '/ws') return new Response('not found', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const code = url.searchParams.get('code') ?? '';
    const wanted = url.searchParams.get('role') === 'host' ? 'host' : 'guest';
    const name = cleanName(url.searchParams.get('name') ?? '');
    const build = url.searchParams.get('build') ?? '';

    const room = await this.load(code);

    // A GUEST CANNOT OPEN A ROOM. Joining a code nobody is hosting is the
    // commonest failure there is — a typo, or a match that already ended — and
    // it has to read as "no such room", not as an empty lobby that never fills.
    if (wanted === 'guest' && !room.members.some((x) => x.role === 'host')) {
      return new Response(JSON.stringify({ t: 'error', code: 'no_room' }), { status: 404 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const joined = joinRoom(room, { role: wanted, name, build }, server, Date.now());
    if (!joined.ok) {
      return new Response(JSON.stringify({ t: 'error', code: joined.error }), { status: 409 });
    }

    // Hibernation-style accept. The attachment is how this socket's identity
    // survives the object going to sleep: `load()` below rebuilds the whole
    // room out of these on the next wake.
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ role: joined.role, name, build, ready: false });

    await this.save(room);
    // Told after the socket is live, on the next tick, so the client's own
    // open handler has run before the first message lands.
    this.state.waitUntil?.(Promise.resolve());
    queueMicrotask(() => this.broadcast(room));

    return new Response(null, { status: 101, webSocket: client });
  }

  // -------------------------------------------------------------------------
  // Hibernation handlers. These replace addEventListener and are what let the
  // object sleep between frames.
  // -------------------------------------------------------------------------

  async webSocketMessage(ws, message) {
    const room = await this.load();

    // BINARY IS NEVER INSPECTED. Input and snapshots are the two per-frame
    // message types and the relay has no business decoding either — it does
    // not know what a seal is, and a server that parsed the snapshot would
    // have to be redeployed every time the layout moved. Straight across.
    if (typeof message !== 'string') {
      const to = routeTo(room, ws);
      if (to) trySend(to, message);
      return;
    }

    const msg = parseControl(message);
    if (!msg) return;

    switch (msg.t) {
      case 'ping':
        // Answered by the SERVER rather than relayed to the peer: this is the
        // client's own liveness and half-RTT to the edge, and bouncing it off
        // a peer that might be mid-reconnect measures the wrong thing.
        trySend(ws, JSON.stringify({ t: 'pong', id: msg.id, serverAt: Date.now() }));
        return;

      case 'ready':
        setReady(room, ws, msg.ready);
        syncAttachment(ws, { ready: !!msg.ready });
        this.broadcast(room);
        return;

      case 'leave': {
        removeMember(room, ws);
        await this.save(room);
        this.broadcast(room);
        try { ws.close(1000, 'left'); } catch { /* already gone */ }
        return;
      }

      default: {
        // Everything else is the game's own control plane — the match start,
        // the event track, the result. Passed to the other peer if it is on
        // the list, dropped in silence if it is not, so a bug or a hand-rolled
        // client cannot use a match as a general message bus. Silence and not
        // an error: an error per frame would be worse than what it reports.
        if (!relayable(msg.t)) return;
        const to = routeTo(room, ws);
        if (to) trySend(to, message);
      }
    }
  }

  async webSocketClose(ws) {
    await this.dropped(ws);
  }

  async webSocketError(ws) {
    await this.dropped(ws);
  }

  async dropped(ws) {
    const room = await this.load();
    const { role, hostGone } = leaveRoom(room, ws, Date.now());
    if (!role) return;
    await this.save(room);

    // THE HOST GOING IS THE MATCH ENDING. The host is the simulation; there is
    // nothing to fail over to, and a guest left staring at a frozen pitch
    // deserves to be told rather than to work it out. The guest merely going
    // is survivable — the bot takes seat 1 on the host's next frame, and the
    // seat stays reserved for a reconnect.
    for (const other of this.state.getWebSockets()) {
      if (other === ws) continue;
      trySend(other, JSON.stringify({ t: 'peerGone', role, graceMs: hostGone ? 0 : REJOIN_GRACE_MS }));
    }
    this.broadcast(room);
  }

  // -------------------------------------------------------------------------

  /**
   * The room, rebuilt from the live sockets plus any reserved seat.
   *
   * The sockets are the truth about who is HERE; storage is the truth about
   * who has a seat held for them and is not here. Keeping those two facts in
   * the two places that can actually answer them is what makes hibernation a
   * non-event.
   */
  async load(code = null) {
    const room = createRoom(code ?? (await this.state.storage.get('code')) ?? '');
    const reserved = (await this.state.storage.get('reserved')) ?? {};

    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() ?? {};
      room.members.push({
        role: a.role ?? 'guest',
        name: a.name ?? '',
        build: a.build ?? '',
        ready: !!a.ready,
        socket: ws,
        joinedAt: a.joinedAt ?? 0,
        leftAt: 0,
      });
      if (room.build == null) room.build = a.build ?? '';
    }

    const now = Date.now();
    for (const [role, seat] of Object.entries(reserved)) {
      if (room.members.some((x) => x.role === role)) continue;
      if (now - seat.leftAt > REJOIN_GRACE_MS) continue;
      room.members.push({ ...seat, role, socket: null, ready: false });
    }
    return room;
  }

  /** Persist only the seats nobody is currently sitting in. */
  async save(room) {
    const reserved = {};
    for (const m of room.members) {
      if (m.socket) continue;
      reserved[m.role] = { name: m.name, build: m.build, joinedAt: m.joinedAt, leftAt: m.leftAt };
    }
    await this.state.storage.put('reserved', reserved);
  }

  /** The lobby, whole, to everyone in it. */
  broadcast(room) {
    const view = roomView(room);
    for (const ws of this.state.getWebSockets()) {
      const m = memberOf(room, ws);
      trySend(ws, JSON.stringify({ t: 'room', ...view, you: m ? m.role : null }));
    }
  }
}

/**
 * A send that cannot take the object down. A socket the runtime has already
 * torn down throws on send, and one peer's dead wire must never be the other
 * peer's dropped frame.
 */
function trySend(ws, data) {
  try { ws.send(data); } catch { /* gone; webSocketClose will follow */ }
}

/** Merge fields into a socket's attachment without losing the rest of it. */
function syncAttachment(ws, patch) {
  try { ws.serializeAttachment({ ...(ws.deserializeAttachment() ?? {}), ...patch }); } catch { /* gone */ }
}

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
  });
}
