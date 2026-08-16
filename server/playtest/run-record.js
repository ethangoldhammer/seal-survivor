// ---------------------------------------------------------------------------
// The parts of the collection worker that are just logic: what a valid run
// record is, what key it gets, and how the pull token is compared.
//
// SPLIT OUT OF THE WORKER BECAUSE THE WORKER CANNOT EXPORT THEM. workerd
// treats every named export of the entry module as a service definition, so a
// `export { validateRun, MAX_BODY_BYTES }` added for a test does not merely
// look untidy — the runtime refuses to start:
//
//   Incorrect type for map entry 'MAX_BODY_BYTES': the provided value is not
//   of type 'function or ExportedHandler'
//
// which is a deploy-time failure, on a worker whose whole job is to be
// running when someone happens to play. The entry module exports `default`
// and nothing else; everything testable lives here.
// ---------------------------------------------------------------------------

export const KEY_PREFIX = 'run:';

// Runs are kept for six months. This is a BUFFER, not the archive: the pull
// tool copies runs into the repo, where the report reads them. The TTL exists
// so a season of playtesting nobody pulled doesn't sit in KV forever, and so
// the free tier's storage is never the thing that breaks.
export const RETENTION_S = 180 * 24 * 60 * 60;

// A run record is a few tens of KB — 40 buckets of accumulator maps plus a
// frame-time histogram summary. 256KB is far above any real run and small
// enough that the endpoint can't be used to park data.
export const MAX_BODY_BYTES = 262_144;

// Runs shorter than this are not filed. A quit from the menu, a mis-click, a
// reload mid-load: they carry no balance signal, the report's own floor is
// higher still (`--min 60`), and each one would spend a write out of a daily
// budget that real runs need. Not a validation rule — a budget rule.
export const MIN_DURATION_S = 15;

// Per-IP write budget. A real player produces a run every few minutes at
// best, so this sits an order of magnitude above genuine play and still stops
// a script from spending the day's writes in a minute.
export const RATE_LIMIT_WINDOW_S = 3600;
export const RATE_LIMIT_MAX = 40;

/**
 * Shape and sanity checks on an incoming run.
 *
 * PASSES THE RECORD THROUGH RATHER THAN REBUILDING IT. The leaderboard
 * validator constructs its entry field by field, which is right for a board
 * with four columns that never change. A run record is a growing schema —
 * every new accumulator in playtest.js adds a field — and a worker that
 * rebuilt the record would silently drop each new one until someone
 * remembered to redeploy it. Instead: check what the analysis actually
 * depends on, bound the size, and keep the rest verbatim.
 */
export function validateRun(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'expected an object' };
  }

  const id = typeof body.id === 'string' ? body.id.replace(/[^\w-]/g, '').slice(0, 40) : '';
  if (!id) return { ok: false, error: 'missing run id' };

  const startedAt = toInt(body.startedAt);
  // A clock that's wrong by years would sort the run to a corner of the
  // keyspace, where it is both invisible to `--since` and permanently ahead
  // of every real run's cursor — one such record would stop every later pull
  // from advancing. 2020 to a day from now.
  if (startedAt === null || startedAt < 1_577_836_800_000 || startedAt > Date.now() + 86_400_000) {
    return { ok: false, error: 'startedAt out of range' };
  }

  const duration = toNum(body.duration);
  if (duration === null || duration < 0 || duration > 86_400) {
    return { ok: false, error: 'duration out of range' };
  }

  if (!Array.isArray(body.buckets)) return { ok: false, error: 'missing buckets' };
  // 30s buckets, so this is a 12-hour run. The byte cap already makes a huge
  // payload impossible; this is here so a crafted record with thousands of
  // empty buckets can't make the analysis chew through them.
  if (body.buckets.length > 1440) return { ok: false, error: 'too many buckets' };

  // An unfinished run is a bug in the caller, not data — nothing downstream
  // can read a run whose last bucket never closed.
  if (body.endReason === 'in-progress') return { ok: false, error: 'run not finished' };

  // Below the floor: accepted, not stored. A 200 rather than a 4xx because
  // the client did nothing wrong and there is nothing for it to retry.
  if (duration < MIN_DURATION_S) return { ok: true, skip: 'too short' };

  return {
    ok: true,
    id,
    startedAt,
    duration,
    level: toInt(body.level) ?? 0,
    kills: toInt(body.kills) ?? 0,
    endReason: typeof body.endReason === 'string' ? body.endReason.slice(0, 16) : 'unknown',
    build: typeof body.meta?.build === 'string' ? body.meta.build.slice(0, 40) : 'unknown',
    client: typeof body.meta?.client === 'string'
      ? body.meta.client.replace(/[^\w-]/g, '').slice(0, 24)
      : 'unknown',
  };
}

/**
 * The KV key for a run. `receivedAt` is the SERVER's clock — deliberately,
 * and this is the single most load-bearing decision in the collection.
 *
 * The obvious key is the run's own `startedAt`. It is wrong, and wrong in the
 * way that costs data with no error anywhere. An incremental pull is "every
 * key after the last one I saw", so key order has to be ARRIVAL order. A
 * player whose system clock runs ten minutes slow — or a year slow, which is
 * ordinary on a device that lost its battery — files a run that sorts BEFORE
 * a cursor that has already moved past it, and that run is then invisible to
 * every pull that will ever run. Nothing fails. The run is simply never seen
 * again, and the collection quietly under-represents exactly the machines
 * least like the developer's.
 *
 * The server's clock has neither problem: it is one clock, and it only ever
 * moves forward across requests. `startedAt` is still kept in the record —
 * it's what orders a session and what `--since` reads — it just isn't what
 * the collection is indexed by.
 *
 * Fixed width, or lexicographic order stops matching numeric order the moment
 * the millisecond count changes digits. 13 digits holds until 2286.
 */
export function runKey(receivedAt, id) {
  return `${KEY_PREFIX}${String(receivedAt).padStart(13, '0')}:${id}`;
}

/** The millisecond timestamp back out of a key, for the lag window below. */
export function keyTime(key) {
  const n = Number(key.slice(KEY_PREFIX.length, KEY_PREFIX.length + 13));
  return Number.isFinite(n) ? n : 0;
}

// How far back from "now" a pull stops.
//
// KV list is eventually consistent: a run written a second ago may not appear
// in a list yet. With a cursor that advances to the newest key it saw, a run
// that was invisible for that one call would be stepped over permanently —
// the same silent loss as the clock problem above, from a different cause.
//
// So a pull refuses to advance its cursor into the last few minutes, and the
// next pull re-lists that window. Re-listing is free of consequences because
// the pull tool dedupes by run id, so the only cost is that a run is readable
// a few minutes after it was played rather than instantly. For a balance
// report read once a day, that is not a cost at all.
export const LIST_LAG_MS = 5 * 60 * 1000;

// Constant-time compare, so the token can't be recovered a character at a
// time from how long a rejection takes. Length is allowed to leak — it tells
// an attacker nothing they couldn't guess.
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
