// ---------------------------------------------------------------------------
// PLAYTEST COLLECTION — a Cloudflare Worker that catches the run records the
// deployed game files, so runs played on the live site can be read from a
// terminal instead of being trapped in one player's localStorage.
//
// Deployed SEPARATELY from the leaderboard worker, deliberately:
//
//   * Different exposure. The board is a public read; this is private data
//     that only the developer pulls, behind a token. Sharing a worker would
//     mean one deploy carries both a public GET and a secret one.
//   * Different blast radius. Wiping collected runs must never be able to
//     touch the board, and a bad deploy here must not take the board down
//     with it — the board is on screen for every player, this is not.
//   * Different budget. The board writes once per run END; this writes once
//     per run and stores 100x the bytes, so the two want their own quotas and
//     their own retention.
//
// STORAGE IS ONE KEY PER RUN, unlike the leaderboard's single sorted value.
// A collection is append-only and never needs to be read as a whole by the
// game, so the read-modify-write that keeps the board sorted would be pure
// cost here — and worse, it would lose runs to the same race the board
// tolerates. One key per run means two runs landing in the same instant both
// survive, which for data you intend to draw conclusions from is the whole
// point.
//
// Keys are `run:<startedAt padded to 13 digits>:<run id>`, so KV's
// lexicographic list order IS chronological order and an incremental pull is
// "everything after the last key I saw".
//
// THIS MODULE EXPORTS `default` AND NOTHING ELSE. workerd reads every named
// export of the entry module as a service definition and refuses to start if
// one isn't a handler, so the record logic — which the test does need to
// import — lives in run-record.js instead. See the note at the top of it.
// ---------------------------------------------------------------------------

import {
  KEY_PREFIX,
  RETENTION_S,
  MAX_BODY_BYTES,
  RATE_LIMIT_WINDOW_S,
  RATE_LIMIT_MAX,
  LIST_LAG_MS,
  validateRun,
  runKey,
  keyTime,
  timingSafeEqual,
} from './run-record.js';

// How many run BODIES one pull response carries. Each is a separate KV read
// and the whole response is built in memory, so this trades round trips
// against the worker's time and memory limits. The pull tool loops until the
// worker says it's done, so this number is invisible except as pace.
const PULL_PAGE = 50;
// Index rows come from list metadata and cost no reads at all, so this page
// can be much larger.
const INDEX_PAGE = 1000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/runs') {
      return json({ error: 'not found' }, 404, origin);
    }

    try {
      // POST is open — it's the game, on whatever host, from whoever is
      // playing. GET is the developer reading the collection back, and is
      // token-gated below.
      if (request.method === 'POST') return await handlePost(request, env, origin);
      if (request.method === 'GET') return await handleGet(request, env, url, origin);
    } catch (err) {
      // A collection endpoint failing must never be visible to the player —
      // the client treats every non-2xx the same way, by shrugging — but the
      // cause still has to reach `wrangler tail`.
      console.error('[playtest]', err?.stack ?? err);
      return json({ error: 'internal error' }, 500, origin);
    }

    return json({ error: 'method not allowed' }, 405, origin);
  },
};

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

async function handlePost(request, env, origin) {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (await isRateLimited(env, ip)) {
    return json({ error: 'too many submissions' }, 429, origin);
  }

  // Length first, so an oversized body is refused before it's read into
  // memory rather than after.
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json({ error: 'run too large' }, 413, origin);
  }

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return json({ error: 'run too large' }, 413, origin);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'invalid JSON' }, 400, origin);
  }

  const check = validateRun(body);
  if (!check.ok) return json({ error: check.error }, 400, origin);
  if (check.skip) return json({ stored: false, reason: check.skip }, 200, origin);

  // One `now` for the key and the record, so the key's timestamp and the
  // stored `received` can never disagree — the pull's lag window reads the
  // first and the report reads the second.
  const receivedAt = Date.now();
  const key = runKey(receivedAt, check.id);

  // The metadata rides alongside the key so an INDEX costs no reads at all:
  // KV returns it from `list()`. That's what makes "what have I collected,
  // from which builds" a single cheap call instead of downloading everything
  // to count it. Capped at 1024 bytes by KV, which this is nowhere near.
  const metadata = {
    at: check.startedAt,
    dur: Math.round(check.duration),
    lvl: check.level,
    kills: check.kills,
    end: check.endReason,
    build: check.build,
    client: check.client,
    bytes: text.length,
  };

  // `received` is the SERVER's clock. The record keeps the client's
  // `startedAt` because that's what orders a session, but a device with a
  // wrong clock must not be able to claim it played next year — anything that
  // needs a trustworthy timestamp reads this one.
  const stored = { ...body, received: receivedAt };

  await env.PLAYTEST.put(key, JSON.stringify(stored), {
    expirationTtl: RETENTION_S,
    metadata,
  });

  return json({ stored: true, key }, 200, origin);
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

async function handleGet(request, env, url, origin) {
  // FAILS CLOSED. If the secret was never set, every read is refused rather
  // than every read being allowed — the failure mode of a forgotten
  // `wrangler secret put` must not be a public dump of the collection.
  const expected = env.PULL_TOKEN;
  if (!expected) {
    return json({ error: 'collection is not readable: PULL_TOKEN is unset' }, 503, origin);
  }
  const offered = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!offered || !timingSafeEqual(offered, expected)) {
    return json({ error: 'unauthorized' }, 401, origin);
  }

  const after = url.searchParams.get('after') ?? '';
  if (url.searchParams.has('index')) return await handleIndex(env, after, origin);

  // KV has no "list from key", only its own opaque cursor, which is no good
  // for an incremental pull days apart. Since the keys sort by arrival,
  // paging through and skipping what's already seen gets the same result —
  // list pages are 1000 keys and cost no reads, so the skipping is nearly
  // free even once the collection is large.
  //
  // `ceiling` is the lag window: nothing from the last few minutes is handed
  // out, because the cursor must not advance past a run that a
  // not-yet-consistent list simply didn't mention. See LIST_LAG_MS.
  const ceiling = Date.now() - LIST_LAG_MS;
  const page = [];
  let cursor;
  let done = false;
  while (page.length < PULL_PAGE) {
    const res = await env.PLAYTEST.list({ prefix: KEY_PREFIX, cursor, limit: 1000 });
    for (const k of res.keys) {
      if (k.name <= after) continue;
      // Keys are ordered, so the first one inside the window ends the pull —
      // everything after it is newer still.
      if (keyTime(k.name) > ceiling) { done = true; break; }
      page.push(k.name);
      if (page.length >= PULL_PAGE) break;
    }
    if (done || page.length >= PULL_PAGE) break;
    if (res.list_complete) { done = true; break; }
    cursor = res.cursor;
  }

  const runs = [];
  for (const name of page) {
    const value = await env.PLAYTEST.get(name, 'json');
    // A key that listed but read back empty is a run that expired between the
    // two calls. Skipped rather than failing the page — the cursor still
    // advances past it, so the pull can't get stuck on a dead key forever.
    if (value) runs.push(value);
  }

  return json(
    {
      runs,
      // The cursor for next time is the last KEY, not the last run — a run
      // that vanished mid-page must still advance it.
      after: page.length ? page[page.length - 1] : after,
      done: done || page.length < PULL_PAGE,
    },
    200,
    origin,
  );
}

/** Everything that's here, from list metadata alone — no run bodies read. */
async function handleIndex(env, after, origin) {
  const rows = [];
  let cursor;
  let list_complete = false;
  while (rows.length < INDEX_PAGE) {
    const res = await env.PLAYTEST.list({ prefix: KEY_PREFIX, cursor, limit: 1000 });
    for (const k of res.keys) {
      if (k.name <= after) continue;
      rows.push({ key: k.name, ...(k.metadata ?? {}) });
      if (rows.length >= INDEX_PAGE) break;
    }
    if (rows.length >= INDEX_PAGE) break;
    if (res.list_complete) { list_complete = true; break; }
    cursor = res.cursor;
  }
  return json(
    {
      index: rows,
      after: rows.length ? rows[rows.length - 1].key : after,
      done: list_complete || rows.length < INDEX_PAGE,
    },
    200,
    origin,
  );
}

// ---------------------------------------------------------------------------

async function isRateLimited(env, ip) {
  const key = `rl:${ip}`;
  const current = Number(await env.PLAYTEST.get(key)) || 0;
  if (current >= RATE_LIMIT_MAX) return true;
  await env.PLAYTEST.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_WINDOW_S });
  return false;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
