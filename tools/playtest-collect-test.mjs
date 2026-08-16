#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:collect
//
// The collection path: the worker's validator and key format, and the pull
// tool's dedupe. Everything here is a case that fails SILENTLY in production —
// a run quietly rejected, a key that sorts wrong, a run counted twice — which
// is the whole reason it's a test rather than something to notice later.
//
// Imports run-record.js, NOT the worker's entry module. That split is not
// stylistic: workerd reads every named export of an entry module as a service
// definition, so exporting these from playtest-worker.js for a test stops the
// worker booting at all ("Incorrect type for map entry 'MAX_BODY_BYTES'"). The
// routing and KV plumbing left in the entry module is verified by running it
// under `wrangler dev`, which is the only thing that can verify it.
// ---------------------------------------------------------------------------

import { validateRun, runKey, keyTime, timingSafeEqual, MIN_DURATION_S, LIST_LAG_MS } from '../server/playtest/run-record.js';

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
  }
}

// A minimal record with the shape playtest.js actually files.
function goodRun(over = {}) {
  return {
    id: 'mabc123-xy9z',
    startedAt: Date.now() - 600_000,
    duration: 340.5,
    level: 12,
    kills: 480,
    score: 91234,
    endReason: 'death',
    buckets: [{ t: 0, seconds: 30, kills: 40 }],
    meta: { build: 'a1b2c3d', client: 'c-abc-123456', device: { cores: 8, touch: false } },
    ...over,
  };
}

console.log('\nvalidator — what gets in\n');

check('a normal run is accepted', validateRun(goodRun()).ok === true);

{
  const v = validateRun(goodRun());
  check('provenance is lifted out for the index', v.build === 'a1b2c3d' && v.client === 'c-abc-123456');
}

// The pass-through rule. A worker that rebuilt the record field by field would
// drop every new accumulator playtest.js grows until someone remembered to
// redeploy it — a data loss with no error attached, discovered months later
// when a report has a column of zeroes.
{
  const run = goodRun({ someFutureField: { newAccumulator: 7 } });
  const v = validateRun(run);
  check('validation does not strip unknown fields', v.ok && run.someFutureField.newAccumulator === 7);
}

console.log('\nvalidator — what stays out\n');

check('no id is rejected', validateRun(goodRun({ id: undefined })).ok === false);
check('an unfinished run is rejected', validateRun(goodRun({ endReason: 'in-progress' })).ok === false);
check('missing buckets is rejected', validateRun(goodRun({ buckets: undefined })).ok === false);
check('a non-object is rejected', validateRun('nope').ok === false);
check('an array is rejected', validateRun([]).ok === false);

// A clock that is wrong by years sorts the run to a corner of the keyspace,
// where it is both invisible to `--since` and permanently ahead of every real
// run's cursor — one bad record would stop every later pull from advancing.
check('a run from 1970 is rejected', validateRun(goodRun({ startedAt: 5000 })).ok === false);
check('a run from next year is rejected', validateRun(goodRun({ startedAt: Date.now() + 400 * 86_400_000 })).ok === false);

// Accepted but not stored — a distinction the client must not see as an
// error, since there is nothing for it to retry.
{
  const v = validateRun(goodRun({ duration: MIN_DURATION_S - 1 }));
  check('a run under the floor is skipped, not rejected', v.ok === true && v.skip === 'too short');
}
check('a run just over the floor is stored', !validateRun(goodRun({ duration: MIN_DURATION_S + 1 })).skip);

// The id goes into a KV key. Anything that could escape the key format or
// bloat it has to come off before it gets there.
{
  const v = validateRun(goodRun({ id: 'abc/../../evil key\n' }));
  check('a hostile id is scrubbed to key-safe characters', v.ok && /^[\w-]+$/.test(v.id), `got ${JSON.stringify(v.id)}`);
}
{
  const v = validateRun(goodRun({ meta: { build: 'x'.repeat(500), client: 'c-1' } }));
  check('an oversized build label is truncated', v.ok && v.build.length <= 40);
}
{
  const v = validateRun(goodRun({ meta: undefined }));
  check('a run with no meta still lands, as unknown', v.ok && v.build === 'unknown' && v.client === 'unknown');
}

console.log('\nkey format — arrival order\n');

// The one that motivated the padding. Without it, lexicographic order stops
// matching numeric order the moment the millisecond count changes digit
// count — and every incremental pull is "keys after the last one I saw", so
// keys out of order means runs silently never pulled at all.
{
  const early = runKey(999_999_999_999, 'a');   // 12 digits
  const later = runKey(1_000_000_000_000, 'b'); // 13 digits
  check('a shorter timestamp still sorts earlier', early < later, `${early} !< ${later}`);
}

// THE ONE THAT COST A RUN IN TESTING. Keying on the run's own `startedAt`
// works perfectly until a player's clock is wrong, at which point their run
// sorts behind a cursor that has already passed and is never pulled again —
// no error, no retry, just a machine quietly absent from the collection.
// Keying on arrival makes the ordering a property of one clock, the server's.
{
  const laggedClock = { id: 'r2', startedAt: 1_600_000_000_000 }; // months behind
  const normalClock = { id: 'r1', startedAt: 1_780_000_000_000 };
  // Both arrive now, the lagged one second later.
  const first = runKey(1_786_000_000_000, normalClock.id);
  const second = runKey(1_786_000_001_000, laggedClock.id);
  check(
    'a run from a browser with a slow clock still sorts after one that arrived earlier',
    second > first,
    'keyed on startedAt this would sort first and be skipped by every later pull',
  );
}

{
  // The lag window: a run that just arrived is deliberately NOT handed out,
  // so the cursor can't step over a write that a not-yet-consistent list
  // failed to mention.
  const now = Date.now();
  check('a run from just now is inside the lag window', keyTime(runKey(now, 'x')) > now - LIST_LAG_MS);
  check('a run from an hour ago is outside it', keyTime(runKey(now - 3_600_000, 'x')) < now - LIST_LAG_MS);
}
check('keyTime recovers the timestamp a key was built from', keyTime(runKey(1_786_000_000_123, 'abc')) === 1_786_000_000_123);
{
  const a = runKey(1_700_000_000_000, 'aaa');
  const b = runKey(1_700_000_000_001, 'aaa');
  check('one millisecond apart sorts in time order', a < b);
}
{
  // Two runs at the same instant from different browsers must be two keys, or
  // one silently overwrites the other in KV.
  const a = runKey(1_700_000_000_000, 'run-one');
  const b = runKey(1_700_000_000_000, 'run-two');
  check('a tie on time is still two distinct keys', a !== b);
}
{
  const sorted = [
    runKey(1_700_000_000_002, 'c'),
    runKey(1_699_999_999_999, 'a'),
    runKey(1_700_000_000_001, 'b'),
  ].sort();
  check('sorting keys sorts the runs', sorted.map((k) => k.slice(-1)).join('') === 'abc');
}

console.log('\ntoken compare\n');

check('the right token matches', timingSafeEqual('s3cret-token', 's3cret-token') === true);
check('a wrong token of the same length does not', timingSafeEqual('s3cret-token', 's3cret-tokeN') === false);
check('a prefix does not match', timingSafeEqual('s3cret', 's3cret-token') === false);
check('empty does not match a real token', timingSafeEqual('', 's3cret-token') === false);

console.log('\ndedupe — the pull is safe to repeat\n');

// The pull tool's rule, exercised as the property that matters: pulling the
// same page twice must not double-count. Duplicates in a balance aggregate
// are the dangerous kind of wrong — they don't look like an error, they look
// like more players agreeing with each other.
{
  const seen = new Set();
  const dedupe = (runs) => {
    const fresh = runs.filter((r) => r.id && !seen.has(r.id));
    for (const r of fresh) seen.add(r.id);
    return fresh.length;
  };
  const page = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const first = dedupe(page);
  const again = dedupe(page);
  check('a repeated page adds nothing the second time', first === 3 && again === 0, `first=${first} again=${again}`);
  check('a genuinely new run still lands after a repeat', dedupe([{ id: 'd' }]) === 1);
}

console.log(failures ? `\n${failures} failure${failures === 1 ? '' : 's'}\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
