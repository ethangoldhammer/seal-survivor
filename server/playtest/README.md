# Playtest collection

Runs played on the deployed site, collected where you can read them.

Every run has always been recorded — damage by ability, damage taken by
creature, enemy hp arriving per second, how much of the run was spent under
30% health, the build order, and the frame-time distribution. What was missing
was a way off the player's machine: `playtest/runs.jsonl` is written by a Vite
middleware, so it only ever caught runs played against `npm run dev`. A run on
`seal-survivor.pages.dev` went to that browser's `localStorage` and stayed
there.

This is one Cloudflare Worker plus one KV namespace that catches those runs, and
`npm run playtest:pull`, which brings them down for the same report that reads
the local ones.

Deployed independently of both the game and the leaderboard. Free tier covers
it: a run is one write, and the daily budget is 1000.

## Deploy

Run from `server/playtest/`.

**1. Log in** (skip if you already did this for the leaderboard).

```bash
npx wrangler login
```

**2. Create the KV namespace.**

```bash
npx wrangler kv namespace create PLAYTEST
```

It prints an `id`. Paste it into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

**3. Set the pull token.** This is the password for reading the collection
back. Make it long and random — anything you'd accept as an API key.

```bash
npx wrangler secret put PULL_TOKEN
```

Until this is set the worker refuses every read. That's deliberate: a
forgotten secret should fail closed, not publish the collection.

**4. Deploy.**

```bash
npx wrangler deploy
```

It prints a URL like `https://seal-survivor-playtest.you.workers.dev`.

**5. Point the game and the pull tool at it.** In the repo root, copy
`.env.example` to `.env` if you haven't, then set:

```
VITE_PLAYTEST_URL=https://seal-survivor-playtest.you.workers.dev
PLAYTEST_TOKEN=<the same value you gave wrangler secret put>
```

`VITE_PLAYTEST_URL` is inlined into the bundle at build time and is public —
that's fine, it only lets a browser POST a run. `PLAYTEST_TOKEN` is the read
password and must never become a `VITE_` variable, or it ships to every player
inside the bundle.

**6. Rebuild and deploy the game.** Vite inlines the URL at build time, so an
existing `dist/` will not pick it up.

```bash
npm run ship
```

## Using it

```bash
npm run playtest:pull            # bring down what's new
npm run playtest -- --remote     # the balance read on collected runs
```

Before trusting any aggregate, look at what's actually in it:

```bash
npm run playtest -- --remote --who
```

That prints the build and browser breakdown. It is there because the two ways
a collection lies are both invisible in an average: **one player** producing
most of the runs, and **several builds** averaged together as though they were
one game. `--who` names both, and warns when either is true.

Then read one game at a time:

```bash
npm run playtest -- --remote --build a1b2c3d
npm run playtest -- --remote --client c-abc-123456
npm run playtest -- --all              # local dev runs and collected ones together
```

`npm run playtest:pull -- --index` lists what the collection holds without
downloading anything — useful for "is there enough yet".

## What lands in a record

The run record, unchanged, plus a `meta` block:

- `build` — the short git sha the build came from, `-dirty` if it was built
  with uncommitted changes. **The field that makes the rest usable.** Runs from
  before and after a balance change describe different games; averaging them
  produces a number that was never true of either.
- `client` — a random per-browser id, minted on first run. Groups runs so that
  forty runs read as one player learning rather than forty players agreeing.
- `device` — core count, device memory, DPR, screen size, and whether the input
  is touch. Coarse buckets, for reading the frame-time record against: a p99 of
  40ms is a disaster on a desktop and unremarkable on an old phone.

And `received`, the server's timestamp, added on arrival.

**Not collected:** no name, no IP (the worker never stores one), no user-agent
string, no URL or referrer, nothing the player typed. The device fields are
buckets that thousands of machines share.

Runs played on `npm run dev` are **never** posted here — they go straight to
`playtest/runs.jsonl` as they always did. Dev runs are played against
half-saved tuning, and letting them into the shared collection is the one thing
that would make the aggregate untrustworthy.

## Retention, and where the data actually lives

The worker keeps a run for **180 days**, then KV expires it. The pulled file
(`playtest/remote.jsonl`) has no expiry, but `playtest/` is gitignored, so it
is not backed up by anything.

That's recoverable in one direction only:

```bash
npm run playtest:pull -- --all   # rebuild the local file from the collection
```

which works for anything the worker still has. Past 180 days it does not, so a
body of runs you care about long-term wants an occasional copy of
`playtest/remote.jsonl` kept somewhere outside the repo.

A pull holds back the last five minutes of arrivals. KV list is eventually
consistent, and a cursor that advanced past a write the list hadn't caught up
to would skip that run permanently — so the window is re-listed next time
instead. The pull dedupes by run id, so re-listing costs nothing.

## Budget

Free tier is 1000 KV writes/day, 100k reads/day, 1GB. A run costs two writes
(the record, and the rate-limit counter) and about 20–60KB. So roughly 500 runs
a day before anything is at risk, and around 20,000 stored runs before storage
is.

Guards, all in `run-record.js`:

- runs under 15s are accepted but not stored — a menu poke is not data, and it
  would spend a write
- 40 posts per hour per IP
- 256KB per record

## What the checks do and don't do

Same as the leaderboard's: sanity, not security. The payload is written by a
browser, so anyone with devtools can post a fabricated run. The validator keeps
the collection *readable* — no absurd timestamps, no unfinished runs, no
oversized payloads — and passes everything else through untouched so that new
fields in `playtest.js` don't need a redeploy here to survive.

The exposure is worth stating plainly: **the POST endpoint is open, and the
collection is data from strangers.** It is anonymous and it is a game's
difficulty curve, so the stakes are low, but a report drawn from it is a report
drawn from unverified input. `--who` and `--build` exist so you can see what
you're averaging before you tune against it.

## Operating it

Live logs:

```bash
npx wrangler tail
```

Wipe everything (no admin endpoint, for the same reason the leaderboard has
none — an endpoint that can erase the collection is a bigger liability than an
occasional CLI call):

```bash
npx wrangler kv bulk delete --binding=PLAYTEST --prefix=run: --remote
```
