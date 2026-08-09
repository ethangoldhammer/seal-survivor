// Global leaderboard for Seal Survivor — a Cloudflare Worker backed by one KV
// namespace. Deployed separately from the game (see server/README.md); the
// client talks to it over CORS from wherever the build is hosted, so the game
// can move hosts without the board moving with it.
//
// The whole board is a SINGLE KV value rather than a key per score. KV is
// eventually consistent and has no queries, so "top 10 by score" out of
// scattered keys would mean listing and reading every entry on every page
// load. One value that's already sorted makes a read exactly one KV get, and
// the board is capped at 100 entries so it stays small.
//
// The tradeoff is that two submissions landing in the same instant can clobber
// each other (read-modify-write, no compare-and-swap in KV). For a leaderboard
// that loses at most one run's entry under a genuine race, that's acceptable —
// if it ever matters, Durable Objects are the upgrade path.

const BOARD_KEY = 'board:v1';
const MAX_ENTRIES = 100;
const RETURNED_ENTRIES = 10;
const MAX_NAME_LEN = 12;

// Per-IP submit budget. Reads are unmetered — it's writes that cost and that a
// script would hammer.
const RATE_LIMIT_WINDOW_S = 60;
const RATE_LIMIT_MAX = 10;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/scores') {
      return json({ error: 'not found' }, 404, origin);
    }

    try {
      if (request.method === 'GET') return await handleGet(env, origin);
      if (request.method === 'POST') return await handlePost(request, env, origin);
    } catch (err) {
      // A leaderboard failing must never be fatal to the caller, but the cause
      // still needs to reach `wrangler tail` rather than vanishing into a 500.
      console.error('[leaderboard]', err?.stack ?? err);
      return json({ error: 'internal error' }, 500, origin);
    }

    return json({ error: 'method not allowed' }, 405, origin);
  },
};

async function handleGet(env, origin) {
  const board = await readBoard(env);
  return json({ list: board.slice(0, RETURNED_ENTRIES) }, 200, origin);
}

async function handlePost(request, env, origin) {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (await isRateLimited(env, ip)) {
    return json({ error: 'too many submissions, slow down' }, 429, origin);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400, origin);
  }

  const entry = validateEntry(body);
  if (!entry.ok) return json({ error: entry.error }, 400, origin);

  const board = await readBoard(env);
  board.push(entry.value);
  board.sort((a, b) => b.score - a.score);
  const trimmed = board.slice(0, MAX_ENTRIES);

  await env.LEADERBOARD.put(BOARD_KEY, JSON.stringify(trimmed));

  // indexOf on the object identity, not a scan by score — two runs can tie and
  // the rank reported has to be the one this submission actually landed in.
  const idx = trimmed.indexOf(entry.value);
  return json(
    {
      list: trimmed.slice(0, RETURNED_ENTRIES),
      rank: idx >= 0 ? idx + 1 : null,
      madeList: idx >= 0 && idx < RETURNED_ENTRIES,
    },
    200,
    origin,
  );
}

// Sanity checks, not security. Everything here is client-reported and anyone
// with devtools can craft a request, so the goal is only to keep the board
// readable: no absurd numbers, no oversized payloads, no HTML in names. The
// ceilings are deliberately loose — a legitimately great run must never be
// rejected, which matters more than a fake one getting through.
function validateEntry(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'expected an object' };

  const score = toInt(body.score);
  const kills = toInt(body.kills);
  const level = toInt(body.level);
  const time = toNum(body.time);

  if (score === null || score < 0 || score > 100_000_000) {
    return { ok: false, error: 'score out of range' };
  }
  if (kills === null || kills < 0 || kills > 1_000_000) {
    return { ok: false, error: 'kills out of range' };
  }
  if (level === null || level < 1 || level > 1000) {
    return { ok: false, error: 'level out of range' };
  }
  // 24h ceiling: longer than any real session, short enough that "time" can't
  // be inflated to justify an arbitrary score through the checks below.
  if (time === null || time < 0 || time > 86_400) {
    return { ok: false, error: 'time out of range' };
  }

  // Internal consistency. Score comes from kills (with combo multipliers), so
  // it can outpace kills by a lot — but not without bound, and not from a run
  // that killed nothing. Likewise you can't out-kill what the game can spawn
  // in the time elapsed. Both limits sit well above real play.
  if (kills === 0 && score > 1000) {
    return { ok: false, error: 'score inconsistent with kills' };
  }
  if (score > (kills + 1) * 10_000) {
    return { ok: false, error: 'score inconsistent with kills' };
  }
  if (kills > (time + 10) * 100) {
    return { ok: false, error: 'kills inconsistent with time' };
  }

  return {
    ok: true,
    value: {
      name: cleanName(body.name),
      score,
      kills,
      level,
      time: Math.round(time * 10) / 10,
      date: Date.now(), // server clock — a client's is whatever it says it is
    },
  };
}

// Strips anything that could render as markup or blow out the row. The client
// escapes on display too; this keeps the stored data clean regardless of who
// reads it later.
function cleanName(raw) {
  const name = String(raw ?? '')
    .replace(/[<>&"'\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LEN);
  return name || 'ANON';
}

async function isRateLimited(env, ip) {
  const key = `rl:${ip}`;
  const current = Number(await env.LEADERBOARD.get(key)) || 0;
  if (current >= RATE_LIMIT_MAX) return true;
  // expirationTtl makes the window self-clearing — no sweeper, no cleanup job.
  // The window restarts on the first write after expiry rather than sliding,
  // which is coarse but costs one KV write instead of a stored timestamp list.
  await env.LEADERBOARD.put(key, String(current + 1), {
    expirationTtl: RATE_LIMIT_WINDOW_S,
  });
  return false;
}

async function readBoard(env) {
  const raw = await env.LEADERBOARD.get(BOARD_KEY, 'json');
  return Array.isArray(raw) ? raw : [];
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
    },
  });
}
