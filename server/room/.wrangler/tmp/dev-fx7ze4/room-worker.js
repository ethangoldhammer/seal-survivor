var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../../path/src/systems/online/protocol.js
var ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ";
var CODE_LENGTH = 5;
function newCode(random = Math.random) {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += ALPHABET[Math.floor(random() * ALPHABET.length)];
  }
  return out;
}
__name(newCode, "newCode");
function normalizeCode(raw) {
  if (typeof raw !== "string") return "";
  const s = raw.toUpperCase().replace(/[\s\-_.]/g, "");
  if (s.length !== CODE_LENGTH) return "";
  for (const c of s) if (!ALPHABET.includes(c)) return "";
  return s;
}
__name(normalizeCode, "normalizeCode");
var ANGLE_SCALE = 32767 / Math.PI;
var IN_AIM_LIVE = 1 << 0;
var IN_AIM_MOVED = 1 << 1;
var IN_STRIKE_HELD = 1 << 2;
var IN_CONNECTED = 1 << 3;
var SEAL_VISIBLE = 1 << 0;
var SEAL_DEAD = 1 << 1;
var METER_CHARGING = 1 << 0;
var MATCH_WINNER_SIDE = 1 << 0;
var MATCH_HAS_WINNER = 1 << 1;
var MATCH_DRAW = 1 << 2;

// room-relay.js
var MAX_MEMBERS = 2;
var REJOIN_GRACE_MS = 3e4;
var MAX_NAME_LENGTH = 24;
function cleanName(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME_LENGTH);
}
__name(cleanName, "cleanName");
function createRoom(code, now = Date.now()) {
  return { code, createdAt: now, build: null, members: [], closedAt: 0 };
}
__name(createRoom, "createRoom");
function memberOf(room, socket) {
  return room.members.find((m) => m.socket === socket) ?? null;
}
__name(memberOf, "memberOf");
function memberIn(room, role) {
  return room.members.find((m) => m.role === role) ?? null;
}
__name(memberIn, "memberIn");
function joinRoom(room, { role = "guest", name = "", build = "" } = {}, socket, now = Date.now()) {
  if (room.closedAt) return { ok: false, error: "no_room" };
  if (room.build == null) room.build = build;
  else if (build && room.build && build !== room.build) return { ok: false, error: "build_mismatch" };
  const held = memberIn(room, role);
  if (held && !held.socket && now - held.leftAt <= REJOIN_GRACE_MS) {
    held.socket = socket;
    held.leftAt = 0;
    if (name) held.name = cleanName(name);
    return { ok: true, role, rejoined: true };
  }
  if (held && !held.socket) room.members.splice(room.members.indexOf(held), 1);
  else if (held) return { ok: false, error: "full" };
  if (room.members.length >= MAX_MEMBERS) return { ok: false, error: "full" };
  room.members.push({
    role,
    name: cleanName(name),
    build,
    ready: false,
    socket,
    joinedAt: now,
    leftAt: 0
  });
  return { ok: true, role, rejoined: false };
}
__name(joinRoom, "joinRoom");
function leaveRoom(room, socket, now = Date.now()) {
  const m = memberOf(room, socket);
  if (!m) return { role: null, hostGone: false };
  m.socket = null;
  m.leftAt = now;
  m.ready = false;
  return { role: m.role, hostGone: m.role === "host" };
}
__name(leaveRoom, "leaveRoom");
function removeMember(room, socket) {
  const i = room.members.findIndex((m2) => m2.socket === socket);
  if (i < 0) return null;
  const [m] = room.members.splice(i, 1);
  return m.role;
}
__name(removeMember, "removeMember");
function setReady(room, socket, ready) {
  const m = memberOf(room, socket);
  if (!m) return false;
  m.ready = !!ready;
  return true;
}
__name(setReady, "setReady");
function routeTo(room, fromSocket) {
  const from = memberOf(room, fromSocket);
  if (!from) return null;
  const other = room.members.find((m) => m !== from && m.socket);
  return other ? other.socket : null;
}
__name(routeTo, "routeTo");
function roomView(room) {
  return {
    code: room.code,
    members: room.members.map((m) => ({
      role: m.role,
      name: m.name,
      ready: m.ready,
      present: !!m.socket
    }))
  };
}
__name(roomView, "roomView");
var RELAY_TYPES = /* @__PURE__ */ new Set(["start", "fx", "matchEnd", "rematch", "lobbyPreview"]);
function relayable(type) {
  return RELAY_TYPES.has(type);
}
__name(relayable, "relayable");
function parseControl(raw) {
  if (typeof raw !== "string" || raw.length > 64e3) return null;
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;
  if (typeof msg.t !== "string") return null;
  return msg;
}
__name(parseControl, "parseControl");

// room-worker.js
var CLAIM_ATTEMPTS = 5;
var EMPTY_ROOM_MS = 15 * 60 * 1e3;
var room_worker_default = {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") ?? "*";
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    const url = new URL(request.url);
    if (url.pathname === "/new" && request.method === "POST") {
      for (let i = 0; i < CLAIM_ATTEMPTS; i += 1) {
        const code = newCode();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const res = await stub.fetch(new Request(`https://room/claim?code=${code}`, { method: "POST" }));
        if (res.ok) return json({ code }, 200, origin);
      }
      return json({ error: "no_code" }, 503, origin);
    }
    const m = url.pathname.match(/^\/room\/([^/]+)$/);
    if (m) {
      const code = normalizeCode(decodeURIComponent(m[1]));
      if (!code) return json({ error: "bad_code" }, 400, origin);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      const inner = new URL(request.url);
      inner.pathname = "/ws";
      inner.searchParams.set("code", code);
      return stub.fetch(new Request(inner, request));
    }
    return json({ error: "not found" }, 404, origin);
  }
};
var Room = class {
  static {
    __name(this, "Room");
  }
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/claim") {
      const claimed = await this.state.storage.get("createdAt");
      const live = this.state.getWebSockets().length > 0;
      if (claimed && (live || Date.now() - claimed < EMPTY_ROOM_MS)) {
        return new Response("taken", { status: 409 });
      }
      await this.state.storage.deleteAll();
      await this.state.storage.put("createdAt", Date.now());
      await this.state.storage.put("code", url.searchParams.get("code") ?? "");
      return new Response("ok");
    }
    if (url.pathname !== "/ws") return new Response("not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const code = url.searchParams.get("code") ?? "";
    const wanted = url.searchParams.get("role") === "host" ? "host" : "guest";
    const name = cleanName(url.searchParams.get("name") ?? "");
    const build = url.searchParams.get("build") ?? "";
    const room = await this.load(code);
    if (wanted === "guest" && !room.members.some((x) => x.role === "host")) {
      return new Response(JSON.stringify({ t: "error", code: "no_room" }), { status: 404 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const joined = joinRoom(room, { role: wanted, name, build }, server, Date.now());
    if (!joined.ok) {
      return new Response(JSON.stringify({ t: "error", code: joined.error }), { status: 409 });
    }
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ role: joined.role, name, build, ready: false });
    await this.save(room);
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
    if (typeof message !== "string") {
      const to = routeTo(room, ws);
      if (to) trySend(to, message);
      return;
    }
    const msg = parseControl(message);
    if (!msg) return;
    switch (msg.t) {
      case "ping":
        trySend(ws, JSON.stringify({ t: "pong", id: msg.id, serverAt: Date.now() }));
        return;
      case "ready":
        setReady(room, ws, msg.ready);
        syncAttachment(ws, { ready: !!msg.ready });
        this.broadcast(room);
        return;
      case "leave": {
        removeMember(room, ws);
        await this.save(room);
        this.broadcast(room);
        try {
          ws.close(1e3, "left");
        } catch {
        }
        return;
      }
      default: {
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
    for (const other of this.state.getWebSockets()) {
      if (other === ws) continue;
      trySend(other, JSON.stringify({ t: "peerGone", role, graceMs: hostGone ? 0 : REJOIN_GRACE_MS }));
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
    const room = createRoom(code ?? await this.state.storage.get("code") ?? "");
    const reserved = await this.state.storage.get("reserved") ?? {};
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() ?? {};
      room.members.push({
        role: a.role ?? "guest",
        name: a.name ?? "",
        build: a.build ?? "",
        ready: !!a.ready,
        socket: ws,
        joinedAt: a.joinedAt ?? 0,
        leftAt: 0
      });
      if (room.build == null) room.build = a.build ?? "";
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
    await this.state.storage.put("reserved", reserved);
  }
  /** The lobby, whole, to everyone in it. */
  broadcast(room) {
    const view = roomView(room);
    for (const ws of this.state.getWebSockets()) {
      const m = memberOf(room, ws);
      trySend(ws, JSON.stringify({ t: "room", ...view, you: m ? m.role : null }));
    }
  }
};
function trySend(ws, data) {
  try {
    ws.send(data);
  } catch {
  }
}
__name(trySend, "trySend");
function syncAttachment(ws, patch) {
  try {
    ws.serializeAttachment({ ...ws.deserializeAttachment() ?? {}, ...patch });
  } catch {
  }
}
__name(syncAttachment, "syncAttachment");
function corsHeaders(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400"
  };
}
__name(corsHeaders, "corsHeaders");
function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) }
  });
}
__name(json, "json");

// ../../node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-fXi6z6/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = room_worker_default;

// ../../node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-fXi6z6/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  Room,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=room-worker.js.map
